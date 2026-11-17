'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const channels = ['log', 'status', 'settings', 'session-start', 'session-end', 'video-config', 'video-frame',
  'video-pause', 'video-resume', 'audio', 'volume', 'approval', 'approval-close', 'fullscreen', 'fatal', 'update', 'update-installing'];

contextBridge.exposeInMainWorld('mirrorly', {
  init: () => ipcRenderer.invoke('init'),
  on: (ch, fn) => { if (channels.includes(ch)) ipcRenderer.on(ch, (_e, data) => fn(data)); },
  set: (key, value) => ipcRenderer.send('set', { key, value }),
  answer: (id, ok, remember) => ipcRenderer.send('approval-answer', { id, ok, remember }),
  disconnect: () => ipcRenderer.send('disconnect'),
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  exitFullscreen: () => ipcRenderer.send('exit-fullscreen'),
  fitVideo: (width, height) => ipcRenderer.send('fit-video', { width, height }),
  minimize: () => ipcRenderer.send('minimize'),
  close: () => ipcRenderer.send('close'),
  openLog: () => ipcRenderer.send('open-log'),
  checkUpdate: () => ipcRenderer.send('update-check'),
  installUpdate: () => ipcRenderer.send('update-install'),
  saveScreenshot: data => ipcRenderer.invoke('save-screenshot', data),
  showFile: file => ipcRenderer.send('show-file', file),
});
