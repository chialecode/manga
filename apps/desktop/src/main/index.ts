import { app, BrowserWindow, dialog, ipcMain, net, session, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MangaProductApp, ElectronSafeStorageVault, resolveLaunchLayout, persistPointer } from "@manga/app-core";
import { productWindow } from "./window-options.ts";
import { testHooks } from "./test-hooks.ts";
import { handleMediaProtocol, registerMediaScheme } from "./media-protocol.ts";
import { externalUrlAllowed, isAppPage, permissionAllowed } from "./permissions.ts";
import { RecordingOverlay } from "./overlay.ts";
import { verifyBundledAssets } from "./bundled-assets.ts";
import { createNetFetch } from "./net-fetch.ts";
import { createId, LOCATION_PARTITIONS } from "@manga/contracts";
import { safeStorage } from "electron";

const smoke = process.argv.includes("--manga-smoke");
// The recording smoke uses Chromium's fake capture device, which plays a synthetic speech clip instead of a microphone.
if (smoke && process.env.MANGA_SMOKE_PHASE === "voice" && process.env.MANGA_SMOKE_AUDIO) {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  app.commandLine.appendSwitch("use-file-for-fake-audio-capture", `${process.env.MANGA_SMOKE_AUDIO}%noloop`);
}
function pinPdfjsDir(): void {
  const packaged = path.join(process.resourcesPath, "app.asar.unpacked", "pdfjs");
  if (fs.existsSync(path.join(packaged, "legacy", "build", "pdf.mjs"))) process.env.MANGA_PDFJS_DIR = packaged;
}
pinPdfjsDir();
// Must run before the app is ready.
registerMediaScheme();
if (process.env.MANGA_DOCUMENTS_DIR === undefined) {
  try {
    process.env.MANGA_DOCUMENTS_DIR = app.getPath("documents");
  } catch {
    // keep homedir fallback inside resolveLaunchLayout
  }
}

const layout = resolveLaunchLayout({
  packaged: app.isPackaged,
  profileRoot: process.env.MANGA_PROFILE_ROOT,
  channel: process.env.MANGA_CHANNEL as "release" | "development" | "test" | undefined,
});
app.setPath("userData", layout.partitions.runtime);
app.setPath("sessionData", layout.partitions.runtime);
if (layout.writable) persistPointer(layout);

let appService: MangaProductApp | undefined;
let ownerGrant: string | undefined;
const actor = { kind: "user" as const, id: "desktop-user" };
let window: BrowserWindow | undefined;
const rendererUrl = () => MAIN_WINDOW_VITE_DEV_SERVER_URL ?? pathToFileURL(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`)).href;

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

function assertCaller(event: Electron.IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error("拒绝非应用主界面的调用");
  }
}

async function bootService(): Promise<void> {
  if (!layout.writable) return;
  appService = new MangaProductApp({
    profileRoot: layout.defaultRoot,
    channel: layout.channel,
    pointerPath: layout.pointerPath,
    documentsDir: layout.documentsRoot,
    packaged: app.isPackaged,
    hostId: "desktop",
    vault: new ElectronSafeStorageVault(safeStorage),
    appVersion: app.getVersion(),
    // Packaged builds carry FFmpeg and the voice-filter model next to the app; development builds look at the local tool cache.
    resourcesPath: process.resourcesPath,
    // Metadata requests go through Chromium's network stack, so the system proxy and certificates apply.
    netFetch: createNetFetch(net),
    useParseWorker: true,
    parseWorkerPath: [
      path.join(process.resourcesPath, "parse-worker.cjs"),
      path.join(__dirname, "parse-worker.cjs").replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`),
      path.join(__dirname, "parse-worker.cjs"),
    ].find((file) => fs.existsSync(file)),
  });
  await appService.start();
  ownerGrant = appService.issueOwnerGrant(actor).handle;
  appService.onNotice((notice) => {
    if (window && !window.isDestroyed()) window.webContents.send("manga:notice", notice);
  });
  // The library paths the user set up are scanned shortly after launch and then on the chosen interval (A-50); with none, nothing starts.
  appService.startScheduler();
}

/** A package that is missing a bundled tool stops here, saying which, instead of failing later in a recording or a video. */
function assetProblems(): string[] {
  if (!app.isPackaged) return [];
  return verifyBundledAssets(process.resourcesPath).problems;
}

app.whenReady().then(async () => {
  const missing = assetProblems();
  if (missing.length) {
    const message = `安装包不完整：${missing.join("；")}。请重新安装。`;
    if (smoke) {
      fs.mkdirSync(layout.partitions.logs, { recursive: true });
      fs.writeFileSync(path.join(layout.partitions.logs, `smoke-${process.env.MANGA_SMOKE_PHASE ?? "initial"}.json`), `${JSON.stringify({ status: "failed", error: message, missingAssets: missing }, null, 2)}
`);
    } else dialog.showErrorBox("MANGA", message);
    app.exit(1);
    return;
  }
  try {
    await bootService();
  } catch (error) {
    if (smoke) {
      fs.mkdirSync(layout.partitions.logs, { recursive: true });
      fs.writeFileSync(path.join(layout.partitions.logs, `smoke-${process.env.MANGA_SMOKE_PHASE ?? "initial"}.json`), `${JSON.stringify({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        writable: layout.writable,
        channel: layout.channel,
      }, null, 2)}\n`);
      app.exit(1);
      return;
    }
    throw error;
  }
  handleMediaProtocol(() => appService);
  window = new BrowserWindow({
    width: productWindow.width,
    height: productWindow.height,
    minWidth: productWindow.minWidth,
    minHeight: productWindow.minHeight,
    show: !smoke,
    backgroundColor: productWindow.backgroundColor,
    titleBarStyle: productWindow.titleBarStyle,
    ...(process.platform === "win32" ? { titleBarOverlay: productWindow.titleBarOverlay } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Lets <video> expose its audio tracks so the player can switch them without re-muxing.
      enableBlinkFeatures: "AudioVideoTracks",
      // A hidden smoke window is throttled to about one frame per second; timing phases must see real frames.
      ...(smoke && (process.env.MANGA_SMOKE_PHASE?.startsWith("bench") || (process.env.MANGA_SMOKE_PHASE === "media" || process.env.MANGA_SMOKE_PHASE === "voice")) ? { backgroundThrottling: false } : {}),
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const appUrl = rendererUrl();
  // The window stays on the app's own page; links open only through `manga:open-external`.
  window.webContents.on("will-navigate", (event, target) => { if (!isAppPage(target, appUrl)) event.preventDefault(); });
  // Only the microphone (audio) and the font list are ever granted, and only to this window's own page.
  const isMainWindow = (contents: Electron.WebContents | null) => Boolean(contents && window && !window.isDestroyed() && contents === window.webContents);
  const permissions = window.webContents.session;
  permissions.setPermissionRequestHandler((contents, permission, callback, details) => {
    const media = (details as { mediaTypes?: string[] }).mediaTypes;
    callback(permissionAllowed({ permission, requestingUrl: details.requestingUrl ?? contents.getURL(), mediaTypes: media, appUrl, fromAppWindow: isMainWindow(contents) }));
  });
  permissions.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    // A check can only reveal device names, never open a device; `unknown` is the device list, which is asked as audio.
    const kind = (details as { mediaType?: string }).mediaType;
    return permissionAllowed({
      permission, requestingUrl: details.requestingUrl ?? requestingOrigin, mediaTypes: kind === "audio" || kind === "unknown" ? ["audio"] : kind ? [kind] : [], appUrl, fromAppWindow: isMainWindow(contents),
    });
  });
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  else await window.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));

  const callOwner = (commandId: string, input: unknown) => (appService && ownerGrant
    ? appService.call(actor, { commandId, idempotencyKey: createId("ovl"), input }, ownerGrant)
    : Promise.resolve(undefined));
  const overlay = new RecordingOverlay({
    preload: path.join(__dirname, "preload.cjs"),
    readRect: async () => {
      const saved = (await callOwner("settings.getRecording", {}))?.value as { overlay?: { x?: number; y?: number; width?: number; height?: number } } | undefined;
      return { width: 280, height: 84, ...(saved?.overlay ?? {}) };
    },
    saveRect: (rect) => { void callOwner("settings.setRecording", { overlay: rect }); },
    onStopRequest: () => { if (window && !window.isDestroyed()) window.webContents.send("manga:overlay-stop"); },
  });
  window.on("closed", () => overlay.close());
  const fromMainWindow = (event: Electron.IpcMainEvent) => Boolean(window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
  ipcMain.on("manga:overlay-publish", (event, state) => { if (fromMainWindow(event)) void overlay.publish(state); });
  ipcMain.on("manga:overlay-stop-request", (event) => { if (overlay.owns(event.sender)) overlay.requestStop(); });
  ipcMain.handle("manga:open-external", async (event, target: unknown) => {
    assertCaller(event);
    if (!externalUrlAllowed(target)) return false;
    await shell.openExternal(target as string);
    return true;
  });
  ipcMain.handle("manga:command", async (event, payload) => {
    assertCaller(event);
    if (!appService || !ownerGrant) return { status: "error", error: { code: "LOCATION_UNAVAILABLE", message: "目录不可写或尚未完成配置", retryable: false, details: { recovery: layout.recovery } } };
    if (!payload || typeof payload.commandId !== "string") throw new Error("invalid command");
    return appService.call(actor, payload, ownerGrant, createId("ui"));
  });
  ipcMain.handle("manga:state", (event) => {
    assertCaller(event);
    return {
      layout,
      writable: layout.writable,
      vaultAvailable: safeStorage.isEncryptionAvailable(),
      packaged: app.isPackaged,
    };
  });
  ipcMain.handle("manga:choose-directory", async (event) => {
    assertCaller(event);
    if (!window) return null;
    // A packaged-window smoke chooses the folder itself; a normal start never sets the hook.
    const hooked = appService ? testHooks.pick?.({ mode: "directory" }) : undefined;
    if (hooked && appService) return appService.registerPath("directory", hooked);
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || !result.filePaths[0]) return null;
    const chosen = result.filePaths[0];
    if (!appService) {
      persistPointer({
        ...layout,
        defaultRoot: chosen,
        partitions: Object.fromEntries(LOCATION_PARTITIONS.map((name) => [name, path.join(chosen, name)])) as typeof layout.partitions,
      });
      if (!smoke) {
        app.relaunch();
        app.exit(0);
      }
      return chosen;
    }
    return appService.registerPath("directory", chosen);
  });
  ipcMain.handle("manga:choose-file", async (event) => {
    assertCaller(event);
    if (!window || !appService || !ownerGrant) return null;
    const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Text", extensions: ["txt"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const file = result.filePaths[0];
    const bytes = [...fs.readFileSync(file)];
    return appService.call(actor, {
      commandId: "library.importText",
      idempotencyKey: createId("import"),
      input: { title: path.basename(file), bytes },
    }, ownerGrant);
  });
  ipcMain.handle("manga:choose-book", async (event) => {
    assertCaller(event);
    if (!window || !appService || !ownerGrant) return null;
    let file = testHooks.chooseBook?.();
    if (!file) {
      const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Book", extensions: ["txt", "epub", "mobi", "pdf"] }] });
      if (result.canceled || !result.filePaths[0]) return null;
      file = result.filePaths[0];
    }
    const handle = appService.registerPath("file", file);
    return appService.call(actor, {
      commandId: "library.importDocument",
      idempotencyKey: createId("book"),
      input: { title: path.basename(file), pathHandle: handle, format: "auto" },
    }, ownerGrant);
  });
  ipcMain.handle("manga:choose-audio", async (event) => {
    assertCaller(event);
    if (!window || !appService) return null;
    const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "ogg", "webm"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return appService.registerPath("file", result.filePaths[0]);
  });
  /** A chosen file the renderer passes back as a path handle, without importing it. */
  ipcMain.handle("manga:choose-path", async (event) => {
    assertCaller(event);
    if (!window || !appService) return null;
    const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "Book", extensions: ["txt", "epub", "mobi", "pdf"] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    return appService.registerPath("file", result.filePaths[0]);
  });
  /** A file or folder the user picked in the host dialog, returned as a path handle and a display name. */
  ipcMain.handle("manga:pick", async (event, request: { mode: "file" | "directory"; filter?: "book" | "comic" | "video" | "subtitle" | "image" | "audio" | "package" | "any" }) => {
    assertCaller(event);
    if (!window || !appService) return null;
    const filters: Record<string, Electron.FileFilter[]> = {
      book: [{ name: "Book", extensions: ["txt", "epub", "mobi", "azw3", "pdf"] }],
      comic: [{ name: "Comic", extensions: ["cbz", "zip", "pdf", "epub", "mobi", "azw3"] }],
      video: [{ name: "Video", extensions: ["mkv", "mp4", "m4v", "mov", "webm", "avi", "ts", "m2ts"] }],
      subtitle: [{ name: "Subtitle", extensions: ["ass", "ssa", "srt", "vtt"] }],
      image: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif"] }],
      audio: [{ name: "Audio", extensions: ["wav", "mp3", "m4a", "ogg", "webm"] }],
    };
    let chosen = testHooks.pick?.({ mode: request.mode });
    if (!chosen) {
      const result = await dialog.showOpenDialog(window, request.mode === "directory"
        ? { properties: ["openDirectory"] }
        : { properties: ["openFile"], filters: request.filter ? filters[request.filter] : undefined });
      if (result.canceled || !result.filePaths[0]) return null;
      chosen = result.filePaths[0];
    }
    return { pathHandle: appService.registerPath(request.mode === "directory" ? "directory" : "file", chosen), name: path.basename(chosen), mode: request.mode };
  });
  ipcMain.handle("manga:reveal", async (event, itemId: string) => {
    assertCaller(event);
    if (!appService || !ownerGrant) return { status: "error", error: { code: "LOCATION_UNAVAILABLE", message: "目录不可写或尚未完成配置", retryable: false, details: {} } };
    const result = await appService.call(actor, { commandId: "inventory.reveal", idempotencyKey: createId("reveal"), input: { id: itemId } }, ownerGrant);
    const revealed = result.value as { path?: string } | undefined;
    if (result.status === "ok" && typeof revealed?.path === "string") {
      await shell.openPath(revealed.path);
    }
    return result;
  });
  ipcMain.handle("manga:secret", async (event, value: string) => {
    assertCaller(event);
    if (!appService) return null;
    if (typeof value !== "string" || value.length < 1 || value.length > 4096) throw new Error("invalid secret");
    return appService.stashSecret(value);
  });
  if (smoke) {
    const { runSmoke } = await import("./smoke/index.ts");
    await runSmoke({ appService, ownerGrant, window, layout });
  }
});

app.on("window-all-closed", () => {
  appService?.close();
  app.quit();
});

