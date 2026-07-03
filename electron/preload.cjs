/* eslint-disable */
// Preload — exposes a minimal, typed bridge to the renderer.
// The frontend uses `window.localApi.query(...)` from src/lib/localClient.ts.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('localApi', {
  isDesktop: true,
  query: (payload) => ipcRenderer.invoke('localApi:query', payload),
  runner: {
    start: () => ipcRenderer.invoke('runner:start'),
    stop: () => ipcRenderer.invoke('runner:stop'),
    restart: () => ipcRenderer.invoke('runner:restart'),
    status: () => ipcRenderer.invoke('runner:status'),
    onLog: (cb) => {
      const listener = (_e, line) => cb(line);
      ipcRenderer.on('runner:log', listener);
      return () => ipcRenderer.removeListener('runner:log', listener);
    },
    onStatus: (cb) => {
      const listener = (_e, s) => cb(s);
      ipcRenderer.on('runner:status', listener);
      return () => ipcRenderer.removeListener('runner:status', listener);
    },
  },
  updater: {
    check: () => ipcRenderer.invoke('update:check'),
    install: () => ipcRenderer.invoke('update:install'),
    onStatus: (cb) => {
      const l = (_e, s) => cb(s);
      ipcRenderer.on('update:status', l);
      return () => ipcRenderer.removeListener('update:status', l);
    },
    onProgress: (cb) => {
      const l = (_e, p) => cb(p);
      ipcRenderer.on('update:progress', l);
      return () => ipcRenderer.removeListener('update:progress', l);
    },
  },
});
