/* eslint-disable */
// Runner control — Phase 3 will spawn the bundled Python here. For now this
// is a stub that keeps the IPC surface stable so the UI can render.

let status = 'stopped';

function registerRunnerIpc(ipcMain, ctx) {
  ipcMain.handle('runner:start', async () => { status = 'running'; return { status }; });
  ipcMain.handle('runner:stop', async () => { status = 'stopped'; return { status }; });
  ipcMain.handle('runner:restart', async () => { status = 'running'; return { status }; });
  ipcMain.handle('runner:status', async () => ({ status }));
}

function stopRunner() {
  status = 'stopped';
}

module.exports = { registerRunnerIpc, stopRunner };
