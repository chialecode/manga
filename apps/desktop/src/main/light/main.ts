import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, screen, shell, type IpcMainInvokeEvent } from "electron";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  LIGHT_COMIC_EXTENSIONS, LIGHT_EXTRA_EXTENSIONS, LIGHT_IMAGE_EXTENSIONS, LIGHT_VIDEO_EXTENSIONS, LightMediaService, LightPositions, MEDIA_SCHEME, serveMedia,
  type LightOpened, type LightPosition,
} from "@manga/app-core/light";
import { appRootOf, channelInfoOf, lightDirsOf, packagedVersion } from "../launch-paths.ts";
import { answerQuitRequest, clearLightInstance, readQuitRequest, writeLightInstance } from "../light-runtime.ts";
import { isAppPage, permissionAllowed } from "../permissions.ts";
import { parseWindowAction, productWindow, windowControlsDrawn } from "../window-options.ts";
import { DEFAULT_LIGHT_BOUNDS, fileArgument, placeWindow, readWindowState, writeWindowState, type LightWindowState } from "./window-state.ts";

/**
 * Light open's main process (`light-main.cjs`, READ-05, A-128): plays one video or shows one comic per window, read straight from the file. It
 * imports `@manga/app-core/light` and Electron and nothing else of the application: no library database, no plugins, no Agent, no updates. It
 * writes only under `<app data root>\light\` and never goes on the network.
 */
declare const LIGHT_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const LIGHT_WINDOW_VITE_NAME: string;

const smoke = process.argv.includes("--manga-smoke");
if (smoke) {
  // The same as the full application's smoke windows: a covered window keeps painting, and nothing is heard.
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("mute-audio");
}

const channel = channelInfoOf({ resourcesPath: process.resourcesPath, packaged: app.isPackaged });
const appRoot = appRootOf(channel);
const dirs = lightDirsOf(appRoot);
const version = packagedVersion(process.resourcesPath) ?? app.getVersion();

// Its own Chromium profile, and so its own single-instance lock, before the lock is taken (4.6): the full application's lock is in `runtime`.
fs.mkdirSync(dirs.runtime, { recursive: true });
app.setPath("userData", dirs.runtime);
app.setPath("sessionData", dirs.runtime);
app.setPath("crashDumps", path.join(dirs.logs, "crashes"));
app.setAppLogsPath(dirs.logs);

protocol.registerSchemesAsPrivileged([{ scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true } }]);

if (!app.requestSingleInstanceLock({ light: true, channel: channel.channel, testIdentity: channel.testIdentity })) {
  app.exit(0);
}

/** A window and what it shows; the session is the light service's, and stands for the file in every command the page sends. */
type LightWindow = {
  window: BrowserWindow;
  opened: LightOpened | null;
  error: { kind: "missing" | "unsupported" | "broken"; detail: string } | null;
  resume: unknown;
  flushed: boolean;
  closing: boolean;
};
const windows = new Map<number, LightWindow>();
let service: LightMediaService | null = null;
let positions: LightPositions | null = null;
let quitting = false;

const rendererUrl = (): string => LIGHT_WINDOW_VITE_DEV_SERVER_URL
  ? `${LIGHT_WINDOW_VITE_DEV_SERVER_URL}/index.html`
  : pathToFileURL(path.join(__dirname, `../renderer/${LIGHT_WINDOW_VITE_NAME}/index.html`)).href;

function windowIconPath(): string | undefined {
  // As the full application's windows (index.ts): the installed copy's own icon, or the channel's in a source run.
  const source = channel.channel === "development" ? "icon-dev" : "icon";
  return [path.join(process.resourcesPath, "icon.ico"), path.resolve(__dirname, `../../assets/${source}.ico`), path.resolve(__dirname, `../../assets/${source}.png`)].find((file) => fs.existsSync(file));
}

function errorKind(error: unknown): "missing" | "unsupported" | "broken" {
  const code = (error as { code?: string } | null)?.code;
  if (code === "NOT_FOUND") return "missing";
  if (code === "UNSUPPORTED_FORMAT") return "unsupported";
  return "broken";
}

/** Ask one window to hand over where it is now and wait until its IPC position write has completed (`light:saved`). */
function flushWindowPosition(entry: LightWindow, timeoutMs = 1000): Promise<void> {
  if (
    !entry.opened
    || entry.window.isDestroyed()
    || entry.window.webContents.isDestroyed()
    || entry.window.webContents.isCrashed()
    || entry.window.webContents.isLoadingMainFrame()
  ) {
    return Promise.resolve();
  }
  const contentsId = entry.window.webContents.id;
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ipcMain.removeListener("light:saved", onSaved);
      resolve();
    };
    const onSaved = (event: Electron.IpcMainEvent) => {
      if (event.sender.id === contentsId) done();
    };
    const timer = setTimeout(done, timeoutMs);
    ipcMain.on("light:saved", onSaved);
    entry.window.webContents.once("destroyed", done);
    entry.window.webContents.send("light:save-now");
  });
}

async function openIn(entry: LightWindow, file: string | null): Promise<void> {
  if (!service || !positions) return;
  if (entry.opened) {
    await flushWindowPosition(entry, 500);
    if (entry.opened) service.close(entry.opened.sessionId);
  }
  entry.opened = null;
  entry.error = null;
  entry.resume = null;
  entry.flushed = false;
  entry.closing = false;
  if (file) {
    try {
      entry.opened = await service.open(file);
      // An image opened from Explorer starts at that image (4.3); otherwise the file goes on where it was left.
      const startsAtImage = entry.opened.kind === "comic" && entry.opened.startPageId !== null;
      entry.resume = startsAtImage ? null : positions.resume(entry.opened.key, service.pageIdsOf(entry.opened.sessionId));
    } catch (error) {
      entry.error = { kind: errorKind(error), detail: error instanceof Error ? error.message : String(error) };
    }
  }
  if (entry.window.isDestroyed()) {
    if (entry.opened) service.close(entry.opened.sessionId);
    return;
  }
  entry.window.setTitle(entry.opened ? `${entry.opened.name} - MANGA` : "MANGA");
  entry.window.webContents.send("light:changed");
}

function stateOf(entry: LightWindow) {
  return {
    opened: entry.opened,
    error: entry.error,
    resume: entry.resume,
    version,
    types: { video: LIGHT_VIDEO_EXTENSIONS, comic: [...LIGHT_COMIC_EXTENSIONS, ...LIGHT_EXTRA_EXTENSIONS], image: LIGHT_IMAGE_EXTENSIONS },
  };
}

const saved = readWindowState(dirs.windowState);
let lastBounds: LightWindowState = saved ?? DEFAULT_LIGHT_BOUNDS;

function createWindow(file: string | null): LightWindow {
  const displays = screen.getAllDisplays().map((display) => display.workArea);
  // A second window steps down and right of the one before it, so it does not sit exactly on top.
  const bounds = placeWindow(lastBounds, displays, windows.size);
  const icon = windowIconPath();
  const window = new BrowserWindow({
    ...bounds,
    minWidth: productWindow.minWidth,
    minHeight: productWindow.minHeight,
    ...(icon ? { icon } : {}),
    show: false,
    title: "MANGA",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#17181C" : productWindow.backgroundColor,
    titleBarStyle: productWindow.titleBarStyle,
    webPreferences: {
      preload: path.join(__dirname, "preload-light.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      enableBlinkFeatures: "AudioVideoTracks",
      ...(smoke ? { backgroundThrottling: false } : {}),
    },
  });
  window.setMenuBarVisibility(false);
  // As the full application's smoke windows: the walk's own input events only, the system's mouse passes through (index.ts).
  if (smoke) window.setIgnoreMouseEvents(true);
  if (saved?.maximized && windows.size === 0) window.maximize();
  const entry: LightWindow = { window, opened: null, error: null, resume: null, flushed: false, closing: false };
  const contentsId = window.webContents.id;
  windows.set(contentsId, entry);
  const appUrl = rendererUrl();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => { if (!isAppPage(target, appUrl)) event.preventDefault(); });
  const own = (contents: Electron.WebContents | null) => Boolean(contents && windows.has(contents.id));
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    // Full screen and the font list (subtitle styles) only; light open never asks for the microphone.
    callback(permission !== "media" && permissionAllowed({ permission, requestingUrl: details.requestingUrl ?? contents.getURL(), appUrl, fromAppWindow: own(contents) }));
  });
  window.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    permission !== "media" && permissionAllowed({ permission, requestingUrl: details.requestingUrl ?? requestingOrigin, appUrl, fromAppWindow: own(contents) }));
  const pushState = () => { if (!window.isDestroyed()) window.webContents.send("manga:window-state", { controls: windowControlsDrawn(process.platform), maximized: window.isMaximized() }); };
  window.on("maximize", pushState);
  window.on("unmaximize", pushState);
  const remember = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const normal = window.getNormalBounds();
    lastBounds = { ...normal, maximized: window.isMaximized() };
    writeWindowState(dirs.windowState, lastBounds);
  };
  window.on("resized", remember);
  window.on("moved", remember);
  window.on("maximize", remember);
  window.on("unmaximize", remember);
  window.once("ready-to-show", () => { if (!smoke || process.env.MANGA_LIGHT_SHOW === "1") window.show(); else window.showInactive(); });
  // Hold normal window close briefly so any pending <500ms page-turn/seek position is flushed to positions.json before app.quit().
  window.on("close", (event) => {
    if (
      quitting
      || entry.flushed
      || !entry.opened
      || window.isDestroyed()
      || window.webContents.isDestroyed()
      || window.webContents.isCrashed()
      || window.webContents.isLoadingMainFrame()
    ) {
      return;
    }
    event.preventDefault();
    if (entry.closing) return;
    entry.closing = true;
    void flushWindowPosition(entry, 1000).finally(() => {
      entry.flushed = true;
      entry.closing = false;
      if (!window.isDestroyed()) window.close();
    });
  });
  window.on("closed", () => {
    windows.delete(contentsId);
    if (entry.opened) service?.close(entry.opened.sessionId);
  });
  void openIn(entry, file);
  if (LIGHT_WINDOW_VITE_DEV_SERVER_URL) void window.loadURL(appUrl);
  else void window.loadFile(path.join(__dirname, `../renderer/${LIGHT_WINDOW_VITE_NAME}/index.html`));
  return entry;
}

function entryOf(event: IpcMainInvokeEvent | Electron.IpcMainEvent): LightWindow {
  const entry = windows.get(event.sender.id);
  if (!entry || !isAppPage(event.senderFrame?.url ?? "", rendererUrl())) throw new Error("unexpected caller");
  return entry;
}

/** Ask every window to hand over where it is now, and wait a little for the answers. */
async function flushPositions(timeoutMs = 2000): Promise<void> {
  await Promise.all([...windows.values()].map((entry) => flushWindowPosition(entry, timeoutMs)));
}

function registerIpc(): void {
  ipcMain.handle("manga:command", async (event, payload: unknown) => {
    const entry = entryOf(event);
    const body = (payload && typeof payload === "object" ? payload : {}) as { commandId?: unknown; input?: unknown };
    const input = (body.input && typeof body.input === "object" ? body.input : {}) as Record<string, unknown>;
    try {
      // A page names only the file its own window opened.
      if (!entry.opened || input.resourceId !== entry.opened.sessionId) throw Object.assign(new Error("the file is not open"), { code: "NOT_FOUND" });
      const value = await service!.call(String(body.commandId ?? ""), input);
      return { status: "ok", value };
    } catch (error) {
      const code = (error as { code?: string }).code ?? "INTERNAL";
      return { status: "error", error: { code, message: error instanceof Error ? error.message : String(error) } };
    }
  });
  ipcMain.handle("light:state", (event) => stateOf(entryOf(event)));
  ipcMain.handle("light:open-dialog", async (event) => {
    const entry = entryOf(event);
    const all = [...LIGHT_VIDEO_EXTENSIONS, ...LIGHT_COMIC_EXTENSIONS, ...LIGHT_EXTRA_EXTENSIONS, ...LIGHT_IMAGE_EXTENSIONS].map((ext) => ext.slice(1));
    const result = await dialog.showOpenDialog(entry.window, { properties: ["openFile"], filters: [{ name: "视频、漫画与图片", extensions: all }] });
    if (!result.canceled && result.filePaths[0]) await openIn(entry, result.filePaths[0]);
    return stateOf(entry);
  });
  ipcMain.handle("light:open-path", async (event, file: unknown) => {
    const entry = entryOf(event);
    if (typeof file === "string" && file && path.isAbsolute(file)) await openIn(entry, file);
    return stateOf(entry);
  });
  ipcMain.handle("light:sibling", async (event, direction: unknown) => {
    const entry = entryOf(event);
    if (!entry.opened || (direction !== 1 && direction !== -1)) return { moved: false };
    const next = service!.sibling(entry.opened.sessionId, direction);
    if (!next) return { moved: false };
    await openIn(entry, next);
    return { moved: true };
  });
  ipcMain.handle("light:reveal", (event) => {
    const entry = entryOf(event);
    const file = entry.opened ? service!.pathOf(entry.opened.sessionId) : null;
    if (file) shell.showItemInFolder(file);
  });
  ipcMain.handle("light:position", (event, update: unknown) => {
    const entry = entryOf(event);
    const value = update as (LightPosition & { sessionId?: unknown }) | null;
    if (!entry.opened || !value || (value.kind !== "video" && value.kind !== "comic") || value.kind !== entry.opened.kind) return;
    if (typeof value.sessionId === "string" && value.sessionId !== entry.opened.sessionId) return;
    // The positions keep only the known fields, and a comic page by the hash of its id (no name, no path).
    positions!.set(entry.opened.key, { ...value, at: new Date().toISOString() } as LightPosition);
  });
  ipcMain.handle("manga:window-state", (event) => {
    const entry = entryOf(event);
    return { controls: windowControlsDrawn(process.platform), maximized: entry.window.isMaximized() };
  });
  ipcMain.handle("manga:window-action", (event, requested: unknown) => {
    const entry = entryOf(event);
    const action = parseWindowAction(requested);
    if (action === "minimize") entry.window.minimize();
    else if (action === "toggle-maximize") { if (entry.window.isMaximized()) entry.window.unmaximize(); else entry.window.maximize(); }
    else if (action === "close") entry.window.close();
  });
}

/** Leave for an installer (4.6): every window hands over its place, then the process exits. A test identity can be told to refuse. */
async function leaveForUpdate(): Promise<void> {
  const request = readQuitRequest(dirs.runtime);
  if (!request || quitting) return;
  if (channel.testIdentity && process.env.MANGA_TEST_LIGHT_REFUSE_QUIT === "1") {
    answerQuitRequest(dirs.runtime, request, "refused");
    return;
  }
  quitting = true;
  await flushPositions();
  answerQuitRequest(dirs.runtime, request, "leaving");
  clearLightInstance(dirs.runtime);
  service?.dispose();
  app.exit(0);
}

/** When each window's file was asked for (the benchmark's second open), by the window. */
const askedAt = new WeakMap<BrowserWindow, number>();

app.on("second-instance", (_event, argv) => {
  if (quitting) return;
  const created = createWindow(fileArgument(argv));
  // The benchmark names the moment it started the second process, to time the open from there to the first frame.
  const spawned = smoke ? Number(argv.find((arg) => arg.startsWith("--manga-smoke-spawned-at="))?.split("=")[1]) : Number.NaN;
  if (Number.isFinite(spawned)) askedAt.set(created.window, spawned);
});

app.on("window-all-closed", () => {
  // The last window closed: the process goes too.
  clearLightInstance(dirs.runtime);
  service?.dispose();
  app.quit();
});

void app.whenReady().then(async () => {
  service = new LightMediaService({ cacheDir: dirs.cache, resourcesPath: process.resourcesPath });
  positions = new LightPositions(dirs.positions);
  protocol.handle(MEDIA_SCHEME, (request) => serveMedia({ handles: service!.handles, zips: service!.zips }, { url: request.url, method: request.method, headers: request.headers, signal: request.signal }));
  registerIpc();
  writeLightInstance(dirs.runtime, { pid: process.pid, execPath: process.execPath, channel: channel.channel, testIdentity: channel.testIdentity, startedAt: new Date().toISOString() });
  setInterval(() => { void leaveForUpdate(); }, 150).unref();
  const first = createWindow(fileArgument(process.argv));
  if (smoke) {
    const { runLightSmoke } = await import("./smoke.ts");
    await runLightSmoke({ first: first.window, dirs, windows: () => [...windows.values()].map((entry) => entry.window), service: service!, positions: positions!, askedAt: (window) => askedAt.get(window) ?? null });
  }
});
