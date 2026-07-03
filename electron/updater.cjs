/* eslint-disable */
// Auto-updater — pulls new versions from GitHub Releases via electron-updater.
// The `publish` block in package.json (added later, before release) tells it
// which repo/owner to poll. On first run, silent check + notify UI.

const { autoUpdater } = require('electron-updater');

let ctxRef = null;
let checking = false;

function emit(channel, payload) {
  const win = ctxRef && ctxRef.getWindow && ctxRef.getWindow();
  if (win && !win.isDestroyed()) {
    try { win.webContents.send(channel, payload); } catch (_) {}
  }
}

function wireEvents() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => emit('update:status', { state: 'checking' }));
  autoUpdater.on('update-available', (info) => emit('update:status', { state: 'available', info }));
  autoUpdater.on('update-not-available', (info) => emit('update:status', { state: 'none', info }));
  autoUpdater.on('download-progress', (p) => emit('update:progress', p));
  autoUpdater.on('update-downloaded', (info) => emit('update:status', { state: 'downloaded', info }));
  autoUpdater.on('error', (err) => emit('update:status', { state: 'error', message: err && err.message }));
}

async function checkForUpdates() {
  if (checking) return { checking: true };
  checking = true;
  try {
    const r = await autoUpdater.checkForUpdates();
    return { ok: true, version: r && r.updateInfo && r.updateInfo.version };
  } catch (err) {
    return { ok: false, message: err && err.message };
  } finally {
    checking = false;
  }
}

function registerUpdaterIpc(ipcMain, ctx) {
  ctxRef = ctx;
  wireEvents();

  ipcMain.handle('update:check', async () => checkForUpdates());
  ipcMain.handle('update:install', async () => { autoUpdater.quitAndInstall(); return { ok: true }; });

  // Silent check 5s after launch, then every 6h.
  setTimeout(() => { checkForUpdates().catch(() => {}); }, 5000);
  setInterval(() => { checkForUpdates().catch(() => {}); }, 6 * 60 * 60 * 1000);
}

module.exports = { registerUpdaterIpc };
