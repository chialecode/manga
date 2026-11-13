import { app, dialog, ipcMain, safeStorage, shell, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { persistPointer, type BuildInfo, type MangaProductApp, type resolveLaunchLayout } from "@manga/app-core";
import { createId, LOCATION_PARTITIONS } from "@manga/contracts";
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
}): { abortAllSpeech(): void } {
  const fromMainWindow = (event: Electron.IpcMainEvent) => {
    const win = input.getWindow();
    return Boolean(win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame);
  };

  ipcMain.on("manga:overlay-publish", (event, state) => {
    if (fromMainWindow(event)) void input.overlay.publish(state);
  });
  ipcMain.on("manga:overlay-stop-request", (event) => {
    if (input.overlay.owns(event.sender)) input.overlay.requestStop();
  });

  // Reading aloud: the page asks with an id, and PCM comes back as it arrives, then end or error. Stopping or unloading cancels the request.
  const speaking = new Map<string, AbortController>();
  const abortAllSpeech = () => {
    for (const controller of speaking.values()) controller.abort();
    speaking.clear();
  };

  ipcMain.on("manga:speak", (event, id: unknown, request: unknown) => {
    if (!fromMainWindow(event) || typeof id !== "string" || id.length > 64 || !request || typeof request !== "object") return;
    const sender = event.sender;
    const send = (message: Record<string, unknown>) => { if (!sender.isDestroyed()) sender.send("manga:speech", { id, ...message }); };
    const ask = request as { text?: unknown; voice?: unknown; connectionId?: unknown; task?: unknown };
    const appService = input.getAppService();
    if (!appService || typeof ask.text !== "string" || ask.text.length > 200_000) {
      send({ kind: "error", error: { code: "VALIDATION_ERROR", message: "nothing to read aloud" } });
      return;
    }
    speaking.get(id)?.abort();
    const controller = new AbortController();
    speaking.set(id, controller);
    const task = ask.task === "novel" || ask.task === "test" ? ask.task : "read-aloud";
    void appService.speech.speak(
      { text: ask.text, voice: typeof ask.voice === "string" ? ask.voice : null, connectionId: typeof ask.connectionId === "string" ? ask.connectionId : null, task },
      (pcm) => send({ kind: "chunk", pcm }),
      controller.signal,
    )
      .then((result) => send({ kind: "end", result }))
      .catch((error: unknown) => {
        const failure = error as { code?: unknown; message?: unknown; details?: unknown; retryable?: unknown };
        send({ kind: "error", error: { code: typeof failure.code === "string" ? failure.code : "UNKNOWN", message: typeof failure.message === "string" ? failure.message : "", retryable: failure.retryable === true, details: failure.details && typeof failure.details === "object" ? failure.details : undefined } });
      })
      .finally(() => { if (speaking.get(id) === controller) speaking.delete(id); });
  });

  ipcMain.on("manga:speak-stop", (event, id: unknown) => {
    if (!fromMainWindow(event) || typeof id !== "string") return;
    speaking.get(id)?.abort();
    speaking.delete(id);
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
    // A packaged-window smoke chooses the folder itself; a normal start never sets the hook.
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

  /** A chosen file the renderer passes back as a path handle, without importing it. */
  ipcMain.handle("manga:choose-path", async (event) => {
    input.assertCaller(event);
    const win = input.getWindow();
    const appService = input.getAppService();
    if (!win || !appService) return null;
    const result = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "Book", extensions: ["txt", "epub", "mobi", "pdf"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return appService.registerPath("file", result.filePaths[0]);
  });

  /** A file or folder the user picked in the host dialog, returned as a path handle and a display name. */
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
      // The dialog opens where the page says (a library path, a folder to add); an absolute folder that exists, nothing else.
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

  return { abortAllSpeech };
}
