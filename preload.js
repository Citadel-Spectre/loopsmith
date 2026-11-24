const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);

contextBridge.exposeInMainWorld('api', {
  openMedia: invoke('open-media'),
  probe: invoke('probe'),
  importVideo: invoke('import-video'),
  importImages: invoke('import-images'),
  readFile: invoke('read-file'),
  saveFrame: invoke('save-frame'),
  saveRecording: invoke('save-recording'),
  screenSources: invoke('screen-sources'),
  setRecordingMode: invoke('set-recording-mode'),
  export: invoke('export'),
  exportTo: invoke('export-to'),
  showInFolder: invoke('show-in-folder'),
  pathForFile: (f) => webUtils.getPathForFile(f),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),
  isTest: ipcRenderer.sendSync('is-test'),
});
