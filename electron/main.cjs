/* eslint-disable */
// Electron main process — TelegramCRM desktop app.
// Loads the built React app from dist/, initializes local SQLite, and
// exposes the localApi bridge over IPC. Python runner spawning is added
// in Phase 3.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let closeDb = () => {};
let stopRunner = () => {};
let localApiHandler = async () => ({
  data: null,
  error: { message: 'Desktop database is still starting. Please try again.' },
});

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
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[main] renderer failed to load:', errorCode, errorDescription, validatedURL);
    showStartupError('Renderer failed to load', `${errorDescription}\n${validatedURL || ''}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] renderer process gone:', details);
    showStartupError('Renderer crashed', JSON.stringify(details, null, 2));
  });

  if (!fs.existsSync(indexHtml)) {
    showStartupError(
      'Build files are missing',
      `Could not find ${indexHtml}\n\nRun npm run build first, then package the app again.`
    );
  } else {
    mainWindow.loadFile(indexHtml).catch((err) => {
      console.error('[main] failed to load index.html:', err);
      showStartupError('Failed to load app', err && err.stack ? err.stack : String(err));
    });
  }

  // Open external links in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showStartupError(title, details) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const html = `<!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(title)}</title>
        <style>
          body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0a0f; color: #f8fafc; font-family: Segoe UI, Arial, sans-serif; }
          main { width: min(760px, calc(100vw - 48px)); border: 1px solid rgba(148,163,184,.28); background: rgba(15,23,42,.92); padding: 28px; border-radius: 14px; box-shadow: 0 24px 80px rgba(0,0,0,.45); }
          h1 { margin: 0 0 12px; font-size: 24px; }
          p { margin: 0 0 18px; color: #cbd5e1; line-height: 1.5; }
          pre { white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(2,6,23,.72); color: #bfdbfe; border: 1px solid rgba(148,163,184,.2); padding: 16px; border-radius: 10px; max-height: 45vh; overflow: auto; }
        </style>
      </head>
      <body>
        <main>
          <h1>${escapeHtml(title)}</h1>
          <p>The desktop app started, but the packaged renderer could not open. Rebuild the app after applying the latest changes.</p>
          <pre>${escapeHtml(details)}</pre>
        </main>
      </body>
    </html>`;

  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
}

app.whenReady().then(() => {
  let startupError = null;

  // Register the bridge before the renderer starts. That prevents a blank screen
  // if React asks for data immediately during app boot.
  ipcMain.handle('localApi:query', async (_event, payload) => {
    try {
      return await localApiHandler(payload, { userDataDir });
    } catch (err) {
      return { data: null, error: { message: err && err.message ? err.message : String(err) } };
    }
  });

  try {
    const dbApi = require('./db.cjs');
    const api = require('./api.cjs');
    closeDb = dbApi.closeDb;
    localApiHandler = api.handleApiCall;
    dbApi.initDb(userDataDir);
    console.log('[main] db ready at', path.join(userDataDir, 'data.db'));
  } catch (err) {
    startupError = err;
    console.error('[main] db init failed:', err);
  }

  try {
    const runner = require('./runner.cjs');
    stopRunner = runner.stopRunner;
    runner.registerRunnerIpc(ipcMain, { userDataDir, getWindow: () => mainWindow });
  } catch (err) {
    console.error('[main] runner init failed:', err);
  }

  try {
    const updater = require('./updater.cjs');
    updater.registerUpdaterIpc(ipcMain, { getWindow: () => mainWindow });
  } catch (err) {
    console.error('[main] updater init failed:', err);
  }

  createWindow();

  if (startupError) {
    showStartupError('Desktop database failed to start', startupError && startupError.stack ? startupError.stack : String(startupError));
  }

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
