/* global require */
/* eslint-disable @typescript-eslint/no-require-imports */
// VN85: the FFGL capture window reuses inference.html; only the main-process channel differs.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('loomNativeSurface', { frameReady: () => ipcRenderer.invoke('loom-ffgl-frame') });
