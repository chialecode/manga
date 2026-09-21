const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("mangaM0", {
  command: payload => ipcRenderer.invoke("m0:command", payload),
  status: () => ipcRenderer.invoke("m0:status"),
  openFile: () => ipcRenderer.invoke("m0:open-file"),
  armRecording: () => ipcRenderer.invoke("m0:arm-recording"),
  readCapture: (attachmentId, purpose) => ipcRenderer.invoke("m0:read-capture", { attachmentId, purpose: purpose || "play" }),
  exportCapture: attachmentId => ipcRenderer.invoke("m0:export-capture", attachmentId),
  importPackage: () => ipcRenderer.invoke("m0:import-package"),
  exportPackage: () => ipcRenderer.invoke("m0:export-package"),
  readMediaSample: kind => ipcRenderer.invoke("m0:read-media-sample", kind),
});
