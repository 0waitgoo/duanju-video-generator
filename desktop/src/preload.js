'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const allowed = new Set(['state','import','remove','settings','test','key-link','queue','resume',
  'retry','edit','undo','reassemble','music','export','preflight','redo','select-clip','mix','sample','edit-shot',
  'refresh-models','cleanup-versions']);
contextBridge.exposeInMainWorld('studio', {
  invoke(name, ...args) {
    if (!allowed.has(name)) throw Error('未知操作。');
    return ipcRenderer.invoke(name, ...args);
  },
  onHdProgress(fn) {
    const listener = (_event, pct) => fn(pct);
    ipcRenderer.on('hd-progress', listener);
    return () => ipcRenderer.removeListener('hd-progress', listener);
  },
  droppedFile: file => webUtils.getPathForFile(file),
});

