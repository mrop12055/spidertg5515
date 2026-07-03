/* eslint-disable */
// Runner supervisor — spawns the bundled Python runner, restarts on crash
// with exponential backoff, and forwards stdout/stderr to the Logs page and
// a rotating log file under `<userData>/logs/runner.log`.
//
// Layout expected in the packaged app:
//   resources/python/python.exe        (python-build-standalone, Windows)
//   resources/runner/unified_runner.py
//
// In dev (before Python is bundled) we fall back to `python` on PATH so the
// UI can still exercise Start/Stop/Restart without a real interpreter.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');

let child = null;
let status = 'stopped';      // 'stopped' | 'starting' | 'running' | 'crashed'
let lastError = null;
let restartTimer = null;
let backoffMs = 1000;
let manualStop = false;
let logStream = null;
let ctxRef = null;
let apiPort = 0;

function emit(channel, payload) {
  const win = ctxRef && ctxRef.getWindow && ctxRef.getWindow();
  if (win && !win.isDestroyed()) {
    try { win.webContents.send(channel, payload); } catch (_) {}
  }
}

function setStatus(next, err) {
  status = next;
  lastError = err || null;
  emit('runner:status', { status, error: lastError, pid: child && child.pid });
}

function writeLog(stream, line) {
  const stamped = `[${new Date().toISOString()}] [${stream}] ${line}`;
  if (logStream) { try { logStream.write(stamped + '\n'); } catch (_) {} }
  emit('runner:log', { stream, line, ts: Date.now() });
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function resolveRunnerPaths() {
  // process.resourcesPath is the packaged `resources/` dir; in dev it points
  // into Electron's own resources, so we also probe the project root.
  const candidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'python'),
    path.join(__dirname, '..', 'resources', 'python'),
  ].filter(Boolean);

  let pythonBin = null;
  for (const dir of candidates) {
    const exe = process.platform === 'win32'
      ? path.join(dir, 'python.exe')
      : path.join(dir, 'bin', 'python3');
    if (fs.existsSync(exe)) { pythonBin = exe; break; }
  }
  if (!pythonBin) {
    // Dev fallback — rely on system Python. Packaged builds always ship one.
    pythonBin = process.platform === 'win32' ? 'python' : 'python3';
  }

  const scriptCandidates = [
    process.resourcesPath && path.join(process.resourcesPath, 'runner', 'unified_runner.py'),
    path.join(__dirname, '..', 'resources', 'runner', 'unified_runner.py'),
  ].filter(Boolean);
  const script = scriptCandidates.find((p) => fs.existsSync(p)) || scriptCandidates[scriptCandidates.length - 1];

  return { pythonBin, script };
}

async function startChild() {
  if (child) return;
  manualStop = false;
  setStatus('starting');

  if (!apiPort) {
    try { apiPort = await findFreePort(); } catch (_) { apiPort = 0; }
  }

  const { pythonBin, script } = resolveRunnerPaths();

  if (!fs.existsSync(script)) {
    setStatus('crashed', `runner script not found at ${script}`);
    writeLog('sys', `runner script missing: ${script}`);
    scheduleRestart();
    return;
  }

  const userDataDir = ctxRef && ctxRef.userDataDir;
  const sessionsDir = path.join(userDataDir, 'sessions');
  const filesDir = path.join(userDataDir, 'files');

  try {
    child = spawn(pythonBin, ['-u', script], {
      env: {
        ...process.env,
        TCRM_API_URL: `http://127.0.0.1:${apiPort}`,
        TCRM_SESSIONS_DIR: sessionsDir,
        TCRM_FILES_DIR: filesDir,
        TCRM_USER_DATA: userDataDir,
        PYTHONIOENCODING: 'utf-8',
      },
      windowsHide: true,
    });
  } catch (err) {
    setStatus('crashed', err.message);
    writeLog('sys', `spawn failed: ${err.message}`);
    scheduleRestart();
    return;
  }

  writeLog('sys', `runner started pid=${child.pid} python=${pythonBin}`);
  setStatus('running');
  backoffMs = 1000;

  child.stdout.on('data', (buf) => {
    buf.toString('utf8').split(/\r?\n/).forEach((l) => l && writeLog('out', l));
  });
  child.stderr.on('data', (buf) => {
    buf.toString('utf8').split(/\r?\n/).forEach((l) => l && writeLog('err', l));
  });
  child.on('exit', (code, signal) => {
    writeLog('sys', `runner exited code=${code} signal=${signal}`);
    child = null;
    if (manualStop) {
      setStatus('stopped');
    } else {
      setStatus('crashed', `exit ${code}`);
      scheduleRestart();
    }
  });
}

function scheduleRestart() {
  if (manualStop) return;
  if (restartTimer) return;
  const delay = Math.min(backoffMs, 30_000);
  writeLog('sys', `restarting in ${delay}ms`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    backoffMs = Math.min(backoffMs * 2, 30_000);
    startChild().catch((e) => writeLog('sys', `restart error: ${e.message}`));
  }, delay);
}

function stopChild() {
  manualStop = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (child) {
    try { child.kill(); } catch (_) {}
  } else {
    setStatus('stopped');
  }
}

function registerRunnerIpc(ipcMain, ctx) {
  ctxRef = ctx;
  const logsDir = path.join(ctx.userDataDir, 'logs');
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  logStream = fs.createWriteStream(path.join(logsDir, 'runner.log'), { flags: 'a' });

  ipcMain.handle('runner:start', async () => { await startChild(); return { status, pid: child && child.pid }; });
  ipcMain.handle('runner:stop', async () => { stopChild(); return { status }; });
  ipcMain.handle('runner:restart', async () => { stopChild(); setTimeout(() => startChild(), 500); return { status: 'starting' }; });
  ipcMain.handle('runner:status', async () => ({ status, error: lastError, pid: child && child.pid, port: apiPort }));

  // Auto-start once the UI has mounted.
  setTimeout(() => { startChild().catch(() => {}); }, 1500);
}

function stopRunner() {
  stopChild();
  if (logStream) { try { logStream.end(); } catch (_) {} logStream = null; }
}

module.exports = { registerRunnerIpc, stopRunner };
