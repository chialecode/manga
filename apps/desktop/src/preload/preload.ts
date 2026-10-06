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
  pick: (request: { mode: "file" | "directory"; filter?: string }) => ipcRenderer.invoke("manga:pick", request),
  // Main-process notices (import progress, background job changes). Returns an unsubscribe function.
  onNotice: (listener: (notice: { topic: string; payload: Record<string, unknown> }) => void) => {
    const handler = (_event: unknown, notice: { topic: string; payload: Record<string, unknown> }) => listener(notice);
    ipcRenderer.on("manga:notice", handler);
    return () => { ipcRenderer.removeListener("manga:notice", handler); };
  },
  stashSecret: (value: string) => ipcRenderer.invoke("manga:secret", value),
  reveal: (id: string) => ipcRenderer.invoke("manga:reveal", id),
  // Only the metadata source's own pages open, in the system browser; the main process decides.
  openExternal: (url: string) => ipcRenderer.invoke("manga:open-external", url),
  // The floating recording box: the app window publishes the recording state, the box can ask to stop.
  overlay: {
    publish: (state: unknown) => ipcRenderer.send("manga:overlay-publish", state),
    onStop: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on("manga:overlay-stop", handler);
      return () => { ipcRenderer.removeListener("manga:overlay-stop", handler); };
    },
  },
});

// What the floating box's own page uses. The main process answers only the box's window.
contextBridge.exposeInMainWorld("mangaOverlay", {
  onState: (listener: (state: unknown) => void) => {
    ipcRenderer.on("manga:overlay-state", (_event, state) => listener(state));
  },
  stop: () => ipcRenderer.send("manga:overlay-stop-request"),
});
