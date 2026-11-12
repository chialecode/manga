import { contextBridge, ipcRenderer, webUtils } from "electron";

/**
 * Light open's bridge (A-128). `window.manga` carries only what the player's and reader's hooks use (commands, notices, the window's own
 * buttons), so they work unchanged; `window.mangaLight` is the window's own: what it shows, opening another file, the folder's next file and
 * where the person is. Nothing else of the full application's bridge is here.
 */
const saveListeners = new Set<() => unknown>();
ipcRenderer.on("light:save-now", () => {
  const tasks = [...saveListeners].map((fn) => Promise.resolve().then(() => fn()));
  void Promise.allSettled(tasks).then(() => ipcRenderer.send("light:saved"));
});

contextBridge.exposeInMainWorld("manga", {
  command: (payload: unknown) => ipcRenderer.invoke("manga:command", payload),
  onNotice: () => () => undefined,
  windowState: () => ipcRenderer.invoke("manga:window-state"),
  windowAction: (action: "minimize" | "toggle-maximize" | "close") => ipcRenderer.invoke("manga:window-action", action),
  onWindowState: (listener: (state: { controls: boolean; maximized: boolean }) => void) => {
    const handler = (_event: unknown, state: { controls: boolean; maximized: boolean }) => listener(state);
    ipcRenderer.on("manga:window-state", handler);
    return () => { ipcRenderer.removeListener("manga:window-state", handler); };
  },
});

contextBridge.exposeInMainWorld("mangaLight", {
  state: () => ipcRenderer.invoke("light:state"),
  openDialog: () => ipcRenderer.invoke("light:open-dialog"),
  // A dropped file is turned into its path here; the page never sees paths otherwise.
  openDropped: (file: File) => ipcRenderer.invoke("light:open-path", webUtils.getPathForFile(file)),
  sibling: (direction: 1 | -1) => ipcRenderer.invoke("light:sibling", direction),
  reveal: () => ipcRenderer.invoke("light:reveal"),
  position: (update: unknown) => ipcRenderer.invoke("light:position", update),
  onChanged: (listener: () => void) => {
    const handler = () => listener();
    ipcRenderer.on("light:changed", handler);
    return () => { ipcRenderer.removeListener("light:changed", handler); };
  },
  onSaveNow: (listener: () => unknown) => {
    saveListeners.add(listener);
    return () => { saveListeners.delete(listener); };
  },
});
