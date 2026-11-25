'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const allowed = new Set(['state','import','remove','settings','test','key-link','queue','resume',
  'retry','edit','undo','reassemble','music','export','preflight','redo','select-clip','mix','sample','edit-shot']);
contextBridge.exposeInMainWorld('studio', {
  invoke(name, ...args) {
    if (!allowed.has(name)) throw Error('未知操作。');
    return ipcRenderer.invoke(name, ...args);
  },
  droppedFile: file => webUtils.getPathForFile(file),
});

