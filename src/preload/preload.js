const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = ['overlay:shown', 'overlay:cursor', 'overlay:status'];

contextBridge.exposeInMainWorld('dc', {
  pathFor: (file) => webUtils.getPathForFile(file),
  targetsForMime: (mime) => ipcRenderer.invoke('targets:mime', mime),
  hover: (target) => ipcRenderer.send('overlay:hover', target),
  drop: (paths) => ipcRenderer.send('overlay:drop', paths),
  on: (event, cb) => {
    if (EVENTS.includes(event)) ipcRenderer.on(event, (_e, ...args) => cb(...args));
  },
});
