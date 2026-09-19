import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("manga", {
  command: (payload: unknown) => ipcRenderer.invoke("manga:command", payload),
  state: () => ipcRenderer.invoke("manga:state"),
  chooseDirectory: () => ipcRenderer.invoke("manga:choose-directory"),
  chooseFile: () => ipcRenderer.invoke("manga:choose-file"),
  chooseAudio: () => ipcRenderer.invoke("manga:choose-audio"),
  stashSecret: (value: string) => ipcRenderer.invoke("manga:secret", value),
  reveal: (id: string) => ipcRenderer.invoke("manga:reveal", id),
});
