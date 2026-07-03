/* eslint-disable */
// Electron dev launcher — starts Vite dev server, waits for it, then
// launches Electron pointed at http://localhost:8080 with hot reload.
// Edit any src/ file → the Electron window refreshes instantly.
// No `vite build`, no re-packaging. Ctrl+C stops everything.

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const DEV_URL = process.env.ELECTRON_DEV_URL || 'http://localhost:8080';
const parsed = new URL(DEV_URL);

function ping() {
  return new Promise((resolve) => {
    const req = http.get(
      { host: parsed.hostname, port: parsed.port || 80, path: '/', timeout: 1000 },
      (res) => { res.destroy(); resolve(true); }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitForVite(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const isWin = process.platform === 'win32';
const npmCmd = isWin ? 'npm.cmd' : 'npm';

console.log('[dev] starting vite dev server...');
const vite = spawn(npmCmd, ['run', 'dev'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  shell: isWin,
});

let electron = null;

async function launchElectron() {
  const ok = await waitForVite();
  if (!ok) {
    console.error('[dev] vite dev server did not start in time');
    vite.kill();
    process.exit(1);
  }
  console.log('[dev] vite is up. launching electron...');

  // Resolve the electron binary from node_modules.
  const electronPath = require('electron');
  electron = spawn(electronPath, [path.join(__dirname, '..')], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_DEV_URL: DEV_URL },
    shell: false,
  });

  electron.on('exit', (code) => {
    console.log('[dev] electron exited, stopping vite...');
    vite.kill();
    process.exit(code || 0);
  });
}

launchElectron();

function shutdown() {
  if (electron) try { electron.kill(); } catch (_) {}
  if (vite) try { vite.kill(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
