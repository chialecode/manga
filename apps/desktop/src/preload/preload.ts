import { contextBridge, ipcRenderer } from "electron";
import type { AgentStreamEvent, SpeechStreamPushRequest, SpeechStreamStartRequest } from "@manga/contracts";

ipcRenderer.setMaxListeners(50);

const saveListeners = new Set<() => unknown>();
ipcRenderer.on("manga:save-now", (_event: unknown, token: string) => {
  const tasks = [...saveListeners].map((fn) => Promise.resolve().then(() => fn()));
  void Promise.allSettled(tasks).then((results) => {
    ipcRenderer.send("manga:saved", token, { ok: results.every((result) => result.status === "fulfilled") });
  });
});

const CHANNEL_ARG = "--manga-channel=";
const VALID_CHANNELS = new Set(["release", "development", "test"]);
function readPreloadChannel(): "release" | "development" | "test" | undefined {
  if (typeof process === "undefined" || !Array.isArray(process.argv)) return undefined;
  const raw = process.argv.find((arg) => arg.startsWith(CHANNEL_ARG))?.slice(CHANNEL_ARG.length);
  return raw && VALID_CHANNELS.has(raw) ? (raw as "release" | "development" | "test") : undefined;
}
const preloadChannel = readPreloadChannel();

contextBridge.exposeInMainWorld("manga", {
  ...(preloadChannel ? { channel: preloadChannel } : {}),
  command: (payload: unknown) => ipcRenderer.invoke("manga:command", payload),
  state: () => ipcRenderer.invoke("manga:state"),
  chooseDirectory: () => ipcRenderer.invoke("manga:choose-directory"),
  chooseAudio: () => ipcRenderer.invoke("manga:choose-audio"),
  // A chosen file handed back as a path handle, so the renderer can repair a stale source.
  choosePath: () => ipcRenderer.invoke("manga:choose-path"),
  pick: (request: { mode: "file" | "directory"; filter?: string; defaultPath?: string }) => ipcRenderer.invoke("manga:pick", request),
  // Stashes a drag-dropped or pasted attachment in cache staging and returns a registered path handle.
  stashAttachment: (input: { name: string; mimeType?: string; bytes: Uint8Array }) => ipcRenderer.invoke("manga:stash-attachment", input),
  // Main-process notices (import progress, background job changes). Returns an unsubscribe function.
  onNotice: (listener: (notice: { topic: string; payload: Record<string, unknown> }) => void) => {
    const handler = (_event: unknown, notice: { topic: string; payload: Record<string, unknown> }) => listener(notice);
    ipcRenderer.on("manga:notice", handler);
    return () => { ipcRenderer.removeListener("manga:notice", handler); };
  },
  // Real-time Agent stream events pushed from the main process (`AGENT_STREAM_CHANNEL`). Returns an unsubscribe function.
  onAgentStream: (listener: (event: AgentStreamEvent) => void) => {
    const handler = (_event: unknown, event: AgentStreamEvent) => listener(event);
    ipcRenderer.on("manga:agent-stream", handler);
    return () => { ipcRenderer.removeListener("manga:agent-stream", handler); };
  },
  stashSecret: (value: string) => ipcRenderer.invoke("manga:secret", value),
  reveal: (id: string) => ipcRenderer.invoke("manga:reveal", id),
  // The window's own buttons are drawn by the page: it asks for minimize, maximize or restore, and close, and is told when the window is maximized.
  windowState: () => ipcRenderer.invoke("manga:window-state"),
  windowAction: (action: "minimize" | "toggle-maximize" | "close") => ipcRenderer.invoke("manga:window-action", action),
  onWindowState: (listener: (state: { controls: boolean; maximized: boolean }) => void) => {
    const handler = (_event: unknown, state: { controls: boolean; maximized: boolean }) => listener(state);
    ipcRenderer.on("manga:window-state", handler);
    return () => { ipcRenderer.removeListener("manga:window-state", handler); };
  },
  // Before the window closes the main process asks the page to save what waits for its save now (LOOP-23); the page answers when it is done.
  onSaveNow: (listener: () => Promise<unknown>) => {
    saveListeners.add(listener);
    return () => { saveListeners.delete(listener); };
  },
  // The title bar's menu: leaves the application (the main process decides how it closes down).
  quit: () => ipcRenderer.invoke("manga:quit"),
  // Only the metadata source's own pages open, in the system browser; the main process decides.
  openExternal: (url: string) => ipcRenderer.invoke("manga:open-external", url),
  // Reading aloud: the PCM (24 kHz, 16-bit, mono) of a request comes back in pieces, then its end or failure.
  speak: (id: string, request: { text: string; voice?: string; connectionId?: string; task?: "read-aloud" | "novel" | "test"; streaming?: boolean }) => ipcRenderer.send("manga:speak", id, request),
  stopSpeaking: (id: string) => ipcRenderer.send("manga:speak-stop", id),
  speechStreamStart: (id: string, request?: SpeechStreamStartRequest) => ipcRenderer.send("manga:speech-stream-start", id, request ?? {}),
  speechStreamPush: (id: string, request: SpeechStreamPushRequest) => ipcRenderer.send("manga:speech-stream-push", id, request),
  speechStreamFinish: (id: string) => ipcRenderer.send("manga:speech-stream-finish", id),
  speechStreamStop: (id: string) => ipcRenderer.send("manga:speech-stream-stop", id),
  onSpeech: (listener: (message: { id: string; kind: "chunk" | "end" | "error"; pcm?: Uint8Array; result?: unknown; error?: { code: string; message: string; retryable?: boolean; details?: Record<string, unknown> } }) => void) => {
    const handler = (_event: unknown, message: { id: string; kind: "chunk" | "end" | "error" }) => listener(message);
    ipcRenderer.on("manga:speech", handler);
    return () => { ipcRenderer.removeListener("manga:speech", handler); };
  },
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
    const handler = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on("manga:overlay-state", handler);
    return () => { ipcRenderer.off("manga:overlay-state", handler); };
  },
  stop: () => ipcRenderer.send("manga:overlay-stop-request"),
});
