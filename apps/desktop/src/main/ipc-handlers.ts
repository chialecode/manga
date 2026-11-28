import { app, dialog, ipcMain, safeStorage, shell, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { createAgentStreamCoalescer, persistPointer, type BuildInfo, type MangaProductApp, type resolveLaunchLayout, type SpeechStreamSession } from "@manga/app-core";
import { AGENT_STREAM_CHANNEL, createId, LOCATION_PARTITIONS, SPEECH_IPC_CHANNELS } from "@manga/contracts";
import { externalUrlAllowed } from "./permissions.ts";
import { testHooks } from "./test-hooks.ts";
import type { RecordingOverlay } from "./overlay.ts";
import type { WindowTrayController } from "./tray.ts";

type LaunchLayout = ReturnType<typeof resolveLaunchLayout>;

const PICK_FILTERS: Record<string, Electron.FileFilter[]> = {
  book: [{ name: "Book", extensions: ["txt", "epub", "mobi", "azw3", "pdf"] }],
  comic: [{ name: "Comic", extensions: ["cbz", "zip", "pdf", "epub", "mobi", "azw3"] }],
  video: [{ name: "Video", extensions: ["mkv", "mp4", "m4v", "mov", "webm", "avi", "ts", "m2ts"] }],
  subtitle: [{ name: "Subtitle", extensions: ["ass", "ssa", "srt", "vtt"] }],
  image: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif"] }],
  audio: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "ogg", "webm"] }],
  package: [{ name: "MANGA project package", extensions: ["zip"] }],
  plugin: [{ name: "MANGA plugin package", extensions: ["manga-plugin", "zip"] }],
  torrent: [{ name: "Torrent", extensions: ["torrent"] }],
};

const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
const MAX_STASHED_ATTACHMENTS = 100;
const BLOCKED_ATTACHMENT_EXTS = new Set([
  ".exe", ".bat", ".cmd", ".com", ".msi", ".ps1", ".vbs", ".scr", ".dll", ".sh", ".app", ".jar", ".hta", ".lnk", ".pif", ".reg",
]);
const SAFE_MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;

export type ParsedPickRequest = {
  mode: "file" | "directory";
  filters: Electron.FileFilter[] | undefined;
  defaultPath: string | undefined;
};

/** Validates untrusted renderer IPC input for `manga:pick` (rejects non-objects, invalid modes, and prototype keys). */
export function parsePickRequest(raw: unknown): ParsedPickRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const req = raw as { mode?: unknown; filter?: unknown; defaultPath?: unknown };
  if (req.mode !== "file" && req.mode !== "directory") return null;
  const filters = typeof req.filter === "string" && Object.hasOwn(PICK_FILTERS, req.filter)
    ? PICK_FILTERS[req.filter]
    : undefined;
  const defaultPath = typeof req.defaultPath === "string" ? req.defaultPath : undefined;
  return { mode: req.mode, filters, defaultPath };
}

export type StashedAttachmentResult = {
  pathHandle: string;
  name: string;
  mimeType?: string;
};

/**
 * Validates and stages an ad-hoc composer attachment (drag-drop / clipboard paste) inside the profile's
 * ephemeral cache partition with strict size and extension bounds, returning a registered path handle.
 */
export function stashComposerAttachment(
  raw: unknown,
  cacheDir: string,
  registerPath: (purpose: "file", resolvedPath: string) => string,
  trackedFiles?: Set<string>,
): StashedAttachmentResult | null {
  if (!raw || typeof raw !== "object") return null;
  const req = raw as { name?: unknown; mimeType?: unknown; bytes?: unknown };
  if (typeof req.name !== "string" || !req.name.trim()) return null;
  let data: Buffer | null = null;
  if (req.bytes instanceof Uint8Array) {
    data = Buffer.from(req.bytes.buffer, req.bytes.byteOffset, req.bytes.byteLength);
  } else if (req.bytes instanceof ArrayBuffer) {
    data = Buffer.from(req.bytes);
  } else if (ArrayBuffer.isView(req.bytes)) {
    data = Buffer.from(req.bytes.buffer, req.bytes.byteOffset, req.bytes.byteLength);
  }
  if (!data || data.byteLength === 0 || data.byteLength > MAX_ATTACHMENT_BYTES) return null;
  if (trackedFiles && trackedFiles.size >= MAX_STASHED_ATTACHMENTS) return null;

  // Strip trailing dots/spaces (Windows NTFS silently trims them, which would otherwise bypass extension checks) and reject dot segments.
  const rawBase = path.basename(req.name).replace(/[\0<>:"/\\|?*\x00-\x1f]/g, "_").trim().replace(/[. ]+$/g, "");
  if (!rawBase || rawBase === "." || rawBase === "..") return null;
  if (BLOCKED_ATTACHMENT_EXTS.has(path.extname(rawBase).toLowerCase())) return null;

  const safeName = rawBase.slice(0, 200).replace(/[. ]+$/g, "");
  if (!safeName || safeName === "." || safeName === "..") return null;
  const ext = path.extname(safeName).toLowerCase();
  if (BLOCKED_ATTACHMENT_EXTS.has(ext)) return null;

  const mimeType = typeof req.mimeType === "string" && req.mimeType.length <= 128 && SAFE_MIME_RE.test(req.mimeType.trim())
    ? req.mimeType.trim()
    : undefined;

  const stagingDir = path.resolve(cacheDir, "composer-attachments");
  fs.mkdirSync(stagingDir, { recursive: true });
  const targetPath = path.resolve(stagingDir, `${createId("att")}-${safeName}`);
  const stagingPrefix = stagingDir.endsWith(path.sep) ? stagingDir : `${stagingDir}${path.sep}`;
  if (!targetPath.startsWith(stagingPrefix)) return null;
  fs.writeFileSync(targetPath, data);
  trackedFiles?.add(targetPath);
  const pathHandle = registerPath("file", targetPath);
  return { pathHandle, name: safeName, ...(mimeType ? { mimeType } : {}) };
}

/**
 * Reveals an inventory target in the OS file manager without executing files:
 * opens directories via `shell.openPath` and highlights files via `shell.showItemInFolder`.
 */
export async function revealResolvedPath(
  targetPath: string,
  ops: {
    statSync?: (file: string) => { isDirectory(): boolean };
    openPath?: (file: string) => Promise<string>;
    showItemInFolder?: (file: string) => void;
  } = {},
): Promise<"directory" | "file" | "missing"> {
  const statSync = ops.statSync ?? fs.statSync;
  const openPath = ops.openPath ?? ((file: string) => shell.openPath(file));
  const showItemInFolder = ops.showItemInFolder ?? ((file: string) => shell.showItemInFolder(file));
  let isDirectory = false;
  try {
    isDirectory = statSync(targetPath).isDirectory();
  } catch {
    return "missing";
  }
  if (isDirectory) {
    await openPath(targetPath);
    return "directory";
  }
  showItemInFolder(targetPath);
  return "file";
}

function serializeSpeechError(error: unknown) {
  const failure = error as { code?: unknown; message?: unknown; details?: unknown; retryable?: unknown };
  return {
    code: typeof failure.code === "string" ? failure.code : "UNKNOWN",
    message: typeof failure.message === "string" ? failure.message : "",
    retryable: failure.retryable === true,
    details: failure.details && typeof failure.details === "object" ? failure.details as Record<string, unknown> : undefined,
  };
}

export function registerMainIpcHandlers(input: {
  getWindow: () => BrowserWindow | undefined;
  getAppService: () => MangaProductApp | undefined;
  getOwnerGrant: () => string | undefined;
  getWindowTray: () => WindowTrayController | undefined;
  destroyWindowTray: () => void;
  overlay: RecordingOverlay;
  layout: LaunchLayout;
  buildInfo: BuildInfo;
  actor: { kind: "user"; id: string };
  smoke: boolean;
  assertCaller: (event: Electron.IpcMainInvokeEvent) => void;
  onUpdateRestartFailed: () => void;
}): { abortAllSpeech(): void; dispose(): void } {
  const fromMainWindow = (event: Electron.IpcMainEvent) => {
    const win = input.getWindow();
    return Boolean(win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame);
  };

  // Real-time Agent streaming push (~33ms coalesced deltas, immediate structural events) on `manga:agent-stream`.
  const streamCoalescer = createAgentStreamCoalescer((event) => {
    const win = input.getWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send(AGENT_STREAM_CHANNEL, event);
    }
  }, 33);
  const detachAgentStream = input.getAppService()?.onAgentStream((event) => {
    streamCoalescer.push(event);
  });

  ipcMain.on("manga:overlay-publish", (event, state) => {
    if (fromMainWindow(event)) void input.overlay.publish(state);
  });
  ipcMain.on("manga:overlay-stop-request", (event) => {
    if (input.overlay.owns(event.sender)) input.overlay.requestStop();
  });

  // Reading aloud (HTTP + incremental WS streaming): in-memory PCM only (VOICE-19).
  const speaking = new Map<string, AbortController>();
  type ActiveSpeechStream = {
    controller: AbortController;
    session: SpeechStreamSession | null;
    pendingChunks: string[];
    pendingFinish: boolean;
    aborted: boolean;
    finishing: boolean;
    send: (message: Record<string, unknown>) => void;
  };
  const speechStreams = new Map<string, ActiveSpeechStream>();
  const stashedAttachments = new Set<string>();
  // Prune any orphaned composer attachment files left behind by an abrupt crash in an earlier session.
  try {
    const staleDir = path.resolve(input.layout.partitions.cache, "composer-attachments");
    if (fs.existsSync(staleDir)) fs.rmSync(staleDir, { recursive: true, force: true });
  } catch { /* best-effort startup cleanup */ }

  const stopStreamById = (id: string) => {
    const entry = speechStreams.get(id);
    if (!entry) return;
    entry.aborted = true;
    entry.pendingChunks.length = 0;
    entry.session?.abort();
    entry.controller.abort();
    speechStreams.delete(id);
  };

  const abortAllSpeech = () => {
    for (const controller of speaking.values()) controller.abort();
    speaking.clear();
    for (const id of [...speechStreams.keys()]) stopStreamById(id);
  };

  const cleanupAttachments = () => {
    for (const filePath of [...stashedAttachments]) {
      stashedAttachments.delete(filePath);
      try { fs.rmSync(filePath, { force: true }); } catch { /* already gone */ }
    }
  };

  const finalizeStream = (id: string, entry: ActiveSpeechStream) => {
    if (entry.aborted || entry.finishing || !entry.session) return;
    entry.finishing = true;
    void entry.session.finish()
      .then((result) => {
        if (!entry.aborted) entry.send({ kind: "end", result });
      })
      .catch((error: unknown) => {
        if (!entry.aborted) entry.send({ kind: "error", error: serializeSpeechError(error) });
      })
      .finally(() => {
        if (speechStreams.get(id) === entry) speechStreams.delete(id);
      });
  };

  ipcMain.on(SPEECH_IPC_CHANNELS.speak, (event, id: unknown, request: unknown) => {
    if (!fromMainWindow(event) || typeof id !== "string" || id.length > 64 || !request || typeof request !== "object") return;
    const sender = event.sender;
    const send = (message: Record<string, unknown>) => { if (!sender.isDestroyed()) sender.send(SPEECH_IPC_CHANNELS.speechEvent, { id, ...message }); };
    const ask = request as { text?: unknown; voice?: unknown; connectionId?: unknown; task?: unknown; streaming?: unknown };
    const appService = input.getAppService();
    if (!appService || typeof ask.text !== "string" || ask.text.length > 200_000) {
      send({ kind: "error", error: { code: "VALIDATION_ERROR", message: "nothing to read aloud" } });
      return;
    }
    speaking.get(id)?.abort();
    stopStreamById(id);
    const controller = new AbortController();
    speaking.set(id, controller);
    const task = ask.task === "novel" || ask.task === "test" ? ask.task : "read-aloud";
    void appService.speech.speak(
      {
        text: ask.text,
        voice: typeof ask.voice === "string" ? ask.voice : null,
        connectionId: typeof ask.connectionId === "string" ? ask.connectionId : null,
        task,
        streaming: ask.streaming === true,
      },
      (pcm) => send({ kind: "chunk", pcm }),
      controller.signal,
    )
      .then((result) => send({ kind: "end", result }))
      .catch((error: unknown) => send({ kind: "error", error: serializeSpeechError(error) }))
      .finally(() => { if (speaking.get(id) === controller) speaking.delete(id); });
  });

  ipcMain.on(SPEECH_IPC_CHANNELS.speakStop, (event, id: unknown) => {
    if (!fromMainWindow(event) || typeof id !== "string") return;
    speaking.get(id)?.abort();
    speaking.delete(id);
    stopStreamById(id);
  });

  ipcMain.on(SPEECH_IPC_CHANNELS.streamStart, (event, id: unknown, request: unknown) => {
    if (!fromMainWindow(event) || typeof id !== "string" || id.length > 64) return;
    const sender = event.sender;
    const send = (message: Record<string, unknown>) => { if (!sender.isDestroyed()) sender.send(SPEECH_IPC_CHANNELS.speechEvent, { id, ...message }); };
    const appService = input.getAppService();
    if (!appService) {
      send({ kind: "error", error: { code: "LOCATION_UNAVAILABLE", message: "speech service unavailable" } });
      return;
    }
    const ask = (request && typeof request === "object" ? request : {}) as { voice?: unknown; connectionId?: unknown; task?: unknown };
    const task = ask.task === "novel" || ask.task === "test" ? ask.task : "read-aloud";
    // Enforce single-active-reading across both HTTP and streaming WS sessions.
    abortAllSpeech();
    const controller = new AbortController();
    const entry: ActiveSpeechStream = {
      controller,
      session: null,
      pendingChunks: [],
      pendingFinish: false,
      aborted: false,
      finishing: false,
      send,
    };
    speechStreams.set(id, entry);
    void appService.speech.startStream(
      {
        voice: typeof ask.voice === "string" ? ask.voice : null,
        connectionId: typeof ask.connectionId === "string" ? ask.connectionId : null,
        task,
      },
      (pcm) => { if (!entry.aborted) send({ kind: "chunk", pcm }); },
      controller.signal,
    ).then((session) => {
      if (entry.aborted || speechStreams.get(id) !== entry) {
        session.abort();
        return;
      }
      entry.session = session;
      for (const chunk of entry.pendingChunks.splice(0)) session.push(chunk);
      if (entry.pendingFinish) finalizeStream(id, entry);
    }).catch((error: unknown) => {
      if (!entry.aborted) send({ kind: "error", error: serializeSpeechError(error) });
      if (speechStreams.get(id) === entry) speechStreams.delete(id);
    });
  });

  ipcMain.on(SPEECH_IPC_CHANNELS.streamPush, (event, id: unknown, request: unknown) => {
    if (!fromMainWindow(event) || typeof id !== "string" || !request || typeof request !== "object") return;
    const entry = speechStreams.get(id);
    if (!entry || entry.aborted || entry.finishing) return;
    const text = (request as { text?: unknown }).text;
    if (typeof text !== "string" || !text || text.length > 200_000) return;
    if (entry.session) entry.session.push(text);
    else entry.pendingChunks.push(text);
  });

  ipcMain.on(SPEECH_IPC_CHANNELS.streamFinish, (event, id: unknown) => {
    if (!fromMainWindow(event) || typeof id !== "string") return;
    const entry = speechStreams.get(id);
    if (!entry || entry.aborted) return;
    entry.pendingFinish = true;
    if (entry.session) finalizeStream(id, entry);
  });

  ipcMain.on(SPEECH_IPC_CHANNELS.streamStop, (event, id: unknown) => {
    if (!fromMainWindow(event) || typeof id !== "string") return;
    stopStreamById(id);
  });

  ipcMain.handle("manga:stash-attachment", (event, raw: unknown) => {
    input.assertCaller(event);
    const appService = input.getAppService();
    if (!appService) return null;
    return stashComposerAttachment(
      raw,
      appService.layout.partitions.cache,
      (purpose, resolvedPath) => appService.registerPath(purpose, resolvedPath),
      stashedAttachments,
    );
  });

  ipcMain.handle("manga:open-external", async (event, target: unknown) => {
    input.assertCaller(event);
    if (!externalUrlAllowed(target)) return false;
    await shell.openExternal(target as string);
    return true;
  });

  ipcMain.handle("manga:command", async (event, payload) => {
    input.assertCaller(event);
    const appService = input.getAppService();
    const ownerGrant = input.getOwnerGrant();
    if (!appService || !ownerGrant) {
      return { status: "error", error: { code: "LOCATION_UNAVAILABLE", message: "目录不可写或尚未完成配置", retryable: false, details: { recovery: input.layout.recovery } } };
    }
    if (!payload || typeof payload.commandId !== "string") throw new Error("invalid command");
    const result = await appService.call(input.actor, payload, ownerGrant, createId("ui"));
    if (payload.commandId === "update.restartToUpdate" && result.status !== "ok") {
      input.onUpdateRestartFailed();
    }
    return result;
  });

  ipcMain.handle("manga:state", async (event) => {
    input.assertCaller(event);
    const appService = input.getAppService();
    return {
      layout: appService ? appService.layout : input.layout,
      writable: input.layout.writable,
      vaultAvailable: await safeStorage.isAsyncEncryptionAvailable(),
      packaged: app.isPackaged,
      appVersion: appService ? appService.appVersion : app.getVersion(),
      buildInfo: appService ? appService.buildInfo : input.buildInfo,
      tray: input.getWindowTray()?.isActive() ?? false,
    };
  });

  ipcMain.handle("manga:quit", (event) => {
    input.assertCaller(event);
    app.quit();
  });

  ipcMain.handle("manga:choose-directory", async (event) => {
    input.assertCaller(event);
    const win = input.getWindow();
    if (!win) return null;
    const appService = input.getAppService();
    const hooked = appService ? testHooks.pick?.({ mode: "directory" }) : undefined;
    if (hooked === null) return null;
    if (hooked && appService) return appService.registerPath("directory", hooked);
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const chosen = result.filePaths[0];
    if (!appService) {
      persistPointer({
        ...input.layout,
        defaultRoot: chosen,
        partitions: Object.fromEntries(LOCATION_PARTITIONS.map((name) => [name, path.join(chosen, name)])) as typeof input.layout.partitions,
      });
      if (!input.smoke) {
        input.destroyWindowTray();
        app.relaunch();
        app.exit(0);
      }
      return chosen;
    }
    return appService.registerPath("directory", chosen);
  });

  ipcMain.handle("manga:choose-audio", async (event) => {
    input.assertCaller(event);
    const win = input.getWindow();
    const appService = input.getAppService();
    if (!win || !appService) return null;
    const result = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "ogg", "webm"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return appService.registerPath("file", result.filePaths[0]);
  });

  ipcMain.handle("manga:choose-path", async (event) => {
    input.assertCaller(event);
    const win = input.getWindow();
    const appService = input.getAppService();
    if (!win || !appService) return null;
    const result = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "Book", extensions: ["txt", "epub", "mobi", "pdf"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return appService.registerPath("file", result.filePaths[0]);
  });

  ipcMain.handle("manga:pick", async (event, rawRequest: unknown) => {
    input.assertCaller(event);
    const win = input.getWindow();
    const appService = input.getAppService();
    if (!win || !appService) return null;
    const request = parsePickRequest(rawRequest);
    if (!request) return null;
    let chosen: string | null | undefined;
    if (testHooks.pick) {
      chosen = testHooks.pick({ mode: request.mode });
      if (chosen === null) return null;
    }
    if (!chosen) {
      const start = request.defaultPath && path.isAbsolute(request.defaultPath) && fs.existsSync(request.defaultPath) ? request.defaultPath : undefined;
      const result = await dialog.showOpenDialog(win, request.mode === "directory"
        ? { properties: ["openDirectory"], defaultPath: start }
        : { properties: ["openFile"], filters: request.filters, defaultPath: start });
      if (result.canceled || !result.filePaths[0]) return null;
      chosen = result.filePaths[0];
    }
    return { pathHandle: appService.registerPath(request.mode === "directory" ? "directory" : "file", chosen), name: path.basename(chosen), mode: request.mode };
  });

  ipcMain.handle("manga:reveal", async (event, itemId: string) => {
    input.assertCaller(event);
    const appService = input.getAppService();
    const ownerGrant = input.getOwnerGrant();
    if (!appService || !ownerGrant) {
      return { status: "error", error: { code: "LOCATION_UNAVAILABLE", message: "目录不可写或尚未完成配置", retryable: false, details: {} } };
    }
    const result = await appService.call(input.actor, { commandId: "inventory.reveal", idempotencyKey: createId("reveal"), input: { id: itemId } }, ownerGrant);
    const revealed = result.value as { path?: string } | undefined;
    if (result.status === "ok" && typeof revealed?.path === "string") {
      await revealResolvedPath(revealed.path);
    }
    return result;
  });

  ipcMain.handle("manga:secret", async (event, value: string) => {
    input.assertCaller(event);
    const appService = input.getAppService();
    if (!appService) return null;
    if (typeof value !== "string" || value.length < 1 || value.length > 4096) throw new Error("invalid secret");
    return appService.stashSecret(value);
  });

  const dispose = () => {
    abortAllSpeech();
    detachAgentStream?.();
    streamCoalescer.dispose();
    cleanupAttachments();
  };

  return { abortAllSpeech, dispose };
}
