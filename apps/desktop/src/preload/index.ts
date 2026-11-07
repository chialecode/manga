import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("manga", {
  command: (payload: unknown) => ipcRenderer.invoke("manga:command", payload),
  state: () => ipcRenderer.invoke("manga:state"),
  chooseDirectory: () => ipcRenderer.invoke("manga:choose-directory"),
  chooseFile: () => ipcRenderer.invoke("manga:choose-file"),
  chooseBook: () => ipcRenderer.invoke("manga:choose-book"),
  chooseAudio: () => ipcRenderer.invoke("manga:choose-audio"),
  // A chosen file handed back as a path handle, so the renderer can repair a stale source.
  choosePath: () => ipcRenderer.invoke("manga:choose-path"),
  stashSecret: (value: string) => ipcRenderer.invoke("manga:secret", value),
  reveal: (id: string) => ipcRenderer.invoke("manga:reveal", id),
});
