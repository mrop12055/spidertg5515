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
const { shell, app } = require('electron');
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
let apiToken = '';
function setRunnerEndpoint({ port, token }) { apiPort = port; apiToken = token; }

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
        TCRM_API_TOKEN: apiToken,
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

  // Export the runner Python script to a folder next to the app executable so
  // the user can run `python unified_runner.py` MANUALLY. No auto-spawn.
  ipcMain.handle('runner:export', async () => {
    try {
      if (!apiPort) { try { apiPort = await findFreePort(); } catch (_) {} }
      const { script } = resolveRunnerPaths();
      if (!fs.existsSync(script)) {
        return { ok: false, error: `runner script not found: ${script}` };
      }
      // Folder next to the portable exe (or project root in dev).
      const baseDir = app.isPackaged
        ? path.dirname(process.execPath)
        : path.join(__dirname, '..');
      const outDir = path.join(baseDir, 'runner');
      fs.mkdirSync(outDir, { recursive: true });
      const dstPy = path.join(outDir, 'unified_runner.py');
      fs.copyFileSync(script, dstPy);

      const envContent =
`TCRM_API_URL=http://127.0.0.1:${apiPort}
TCRM_API_TOKEN=${apiToken}
TCRM_SESSIONS_DIR=${path.join(ctx.userDataDir, 'sessions')}
TCRM_FILES_DIR=${path.join(ctx.userDataDir, 'files')}
TCRM_USER_DATA=${ctx.userDataDir}
`;
      fs.writeFileSync(path.join(outDir, '.env'), envContent);

      const runBat =
`@echo off
cd /d "%~dp0"

for /f "usebackq tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"

set "PYEXE="
where py >nul 2>nul && set "PYEXE=py -3"
if not defined PYEXE where python3 >nul 2>nul && set "PYEXE=python3"
if not defined PYEXE where python  >nul 2>nul && set "PYEXE=python"

if not defined PYEXE (
  echo.
  echo [ERROR] Python 3.10+ is not installed or not on PATH.
  echo Download from https://www.python.org/downloads/windows/
  echo During install, TICK "Add python.exe to PATH".
  echo.
  pause
  exit /b 1
)

echo Using Python: %PYEXE%
%PYEXE% -m pip install --quiet --disable-pip-version-check telethon httpx pysocks
%PYEXE% -u unified_runner.py
pause
`;
      // Windows cmd.exe requires CRLF line endings — LF-only files get
      // parsed one character short per line ("setlocal" -> "tlocal").
      fs.writeFileSync(path.join(outDir, 'run.bat'), runBat.replace(/\r?\n/g, '\r\n'));

      const runSh =
`#!/usr/bin/env bash
cd "$(dirname "$0")"
set -a; source .env; set +a
PYEXE="$(command -v python3 || command -v python)"
if [ -z "$PYEXE" ]; then
  echo "[ERROR] Python 3.10+ not installed. Get it from https://www.python.org/downloads/"
  exit 1
fi
"$PYEXE" -m pip install --quiet --disable-pip-version-check telethon httpx pysocks
"$PYEXE" -u unified_runner.py
`;
      fs.writeFileSync(path.join(outDir, 'run.sh'), runSh, { mode: 0o755 });


      const readme =
`Telegram CRM — Local Runner
===========================
1) Install Python 3.10+ from https://www.python.org/downloads/
   Windows: TICK "Add python.exe to PATH" during install.
   Do NOT use the Microsoft Store "python" shortcut — it is not real Python.
2) Keep the desktop app OPEN (it hosts the local API).
3) Run the runner MANUALLY:
     Windows: double-click run.bat
     macOS/Linux: ./run.sh
   Dependencies (telethon, httpx, pysocks) auto-install on first run.

Proxies are OPTIONAL — accounts without a proxy connect directly.
`;
      fs.writeFileSync(path.join(outDir, 'README.txt'), readme);

      try { await shell.openPath(outDir); } catch (_) {}
      return { ok: true, path: outDir };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Do NOT auto-start. Users run the exported runner manually.
  setStatus('stopped');
}


function stopRunner() {
  stopChild();
  if (logStream) { try { logStream.end(); } catch (_) {} logStream = null; }
}

module.exports = { registerRunnerIpc, stopRunner, setRunnerEndpoint };
