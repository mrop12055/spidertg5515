/* eslint-disable */
// Electron main process — TelegramCRM desktop app.
// Loads the built React app from dist/, initializes local SQLite, and
// exposes the localApi bridge over IPC. Python runner spawning is added
// in Phase 3.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const { initDb, closeDb } = require('./db.cjs');
const { handleApiCall, setChangeEmitter } = require('./api.cjs');
const { registerRunnerIpc, stopRunner, setRunnerEndpoint } = require('./runner.cjs');
const { registerUpdaterIpc } = require('./updater.cjs');
const localServer = require('./localServer.cjs');

let mainWindow = null;

// Everything the app writes lives here so it survives updates.
const userDataDir = app.getPath('userData');
for (const sub of ['files', 'sessions', 'logs']) {
  const p = path.join(userDataDir, sub);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  const indexHtml = path.join(__dirname, '..', 'dist', 'index.html');
  mainWindow.loadFile(indexHtml).catch((err) => {
    console.error('[main] failed to load index.html:', err);
  });

  // Open external links in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  try {
    initDb(userDataDir);
    console.log('[main] db ready at', path.join(userDataDir, 'data.db'));
  } catch (err) {
    console.error('[main] db init failed:', err);
  }

  // Generic API bridge — frontend calls window.localApi.query(payload).
  ipcMain.handle('localApi:query', async (_event, payload) => {
    try {
      return await handleApiCall(payload, { userDataDir });
    } catch (err) {
      return { data: null, error: { message: err && err.message ? err.message : String(err) } };
    }
  });

  // Broadcast SQLite change events to renderers as postgres_changes-shaped payloads.
  setChangeEmitter((change) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('localApi:change', change); } catch (_) {}
    }
  });

  registerRunnerIpc(ipcMain, { userDataDir, getWindow: () => mainWindow });
  registerUpdaterIpc(ipcMain, { getWindow: () => mainWindow });

  // Start local HTTP server for the Python runner, then hand endpoint to runner.cjs.
  Promise.resolve(localServer.start({ userDataDir })).then(({ port, token }) => {
    if (typeof setRunnerEndpoint === 'function') setRunnerEndpoint({ port, token });
    console.log(`[main] local API ready on 127.0.0.1:${port}`);
  }).catch((e) => console.error('[main] localServer start failed:', e));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopRunner();
  closeDb();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopRunner();
  closeDb();
});
