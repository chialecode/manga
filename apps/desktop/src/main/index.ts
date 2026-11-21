import { app, BrowserWindow, dialog, ipcMain, Menu, net, safeStorage, Tray } from "electron";
import fs from "node:fs";
import path from "node:path";
import { MangaProductApp, ElectronSafeStorageVault, FIRST_PARTY_KEYS, resolveLaunchLayout, persistPointer, readBuildInfo, readBuildInfoIfPresent } from "@manga/app-core";
import { createId, MangaError } from "@manga/contracts";
import { parseWindowAction, productWindow, windowControlsDrawn, type WindowState } from "./window-options.ts";
import { resolveAppIconPath, resolveRendererUrl } from "./window-assets.ts";
import { createWindowTray, routeSecondInstance, type WindowTrayController } from "./tray.ts";
import { handleMediaProtocol, registerMediaScheme } from "./media-protocol.ts";
import { isAppPage, permissionAllowed } from "./permissions.ts";
import { RecordingOverlay } from "./overlay.ts";
import { PACKAGED_PLUGIN_ASSETS, REQUIRED_ASSETS, verifyBundledAssets } from "./bundled-assets.ts";
import { createNetFetch } from "./net-fetch.ts";
import { builtInDanmakuCredentials, SMOKE_DANMAKU_CREDENTIALS } from "./danmaku-credentials.ts";
import { attachNsisUpdater } from "./updater.ts";
import { utilitySpawner } from "./plugin-process.ts";
import { AsrService } from "./asr-service.ts";
import { launchSucceeded } from "./launch-guard.ts";
import { appRootOf, channelInfoOf, lightDirsOf } from "./launch-paths.ts";
import { askLightToQuit, LIGHT_QUIT_WAIT_MS } from "./light-runtime.ts";
import { startUpdateInstaller } from "./detached-installer.ts";
import { createQuitForUpdateController, signalQuitForUpdateAndExit } from "./quit-for-update.ts";
import { registerMainIpcHandlers } from "./ipc-handlers.ts";

/** How long a closing window waits for the page to save what waits for its save. */
const SAVE_BEFORE_CLOSE_MS = 1500;
const smoke = process.argv.includes("--manga-smoke");
const updateFixtureSmoke = smoke && process.env.MANGA_SMOKE_PHASE === "update";

// A smoke window sits on the developer's own desktop. Keep it rendering and muted even when covered.
if (smoke) {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("mute-audio");
}
// The recording and dictation smoke/bench phases use Chromium's fake capture device for a synthetic speech clip.
if (smoke && process.env.MANGA_SMOKE_AUDIO && (process.env.MANGA_SMOKE_PHASE === "voice" || process.env.MANGA_SMOKE_PHASE === "dictation" || process.env.MANGA_SMOKE_PHASE === "bench-dictation" || process.env.MANGA_SMOKE_PHASE === "deepseek")) {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
  const captureArg = process.env.MANGA_SMOKE_PHASE === "voice"
    ? `${process.env.MANGA_SMOKE_AUDIO}%noloop`
    : process.env.MANGA_SMOKE_AUDIO;
  app.commandLine.appendSwitch("use-file-for-fake-audio-capture", captureArg);
}

function pinPdfjsDir(): void {
  const packaged = path.join(process.resourcesPath, "app.asar.unpacked", "pdfjs");
  if (fs.existsSync(path.join(packaged, "legacy", "build", "pdf.mjs"))) process.env.MANGA_PDFJS_DIR = packaged;
}
pinPdfjsDir();
// Must run before the app is ready.
registerMediaScheme();

function systemFolder(name: "documents" | "downloads", variable: string): string | undefined {
  if (process.env[variable]) return process.env[variable];
  try { return app.getPath(name); } catch { return undefined; }
}

const channelInfo = channelInfoOf({ resourcesPath: process.resourcesPath, packaged: app.isPackaged });
const layout = resolveLaunchLayout({
  packaged: app.isPackaged,
  profileRoot: process.env.MANGA_PROFILE_ROOT,
  channel: channelInfo.channel,
  testIdentity: channelInfo.testIdentity,
  documentsDir: systemFolder("documents", "MANGA_DOCUMENTS_DIR"),
  downloadsDir: systemFolder("downloads", "MANGA_DOWNLOADS_DIR"),
  crashAt: process.env.MANGA_UPGRADE_CRASH_AT,
});
const packagedBuildInfo = readBuildInfoIfPresent(process.resourcesPath);
const buildInfo = readBuildInfo(process.resourcesPath, {
  version: packagedBuildInfo?.version ?? process.env.MANGA_BUILD_VERSION?.trim() ?? app.getVersion(),
  channel: layout.channel,
});
if (buildInfo.version) {
  app.getVersion = () => buildInfo.version;
}

app.setPath("userData", layout.partitions.runtime);
app.setPath("sessionData", layout.partitions.runtime);
// Crash dumps belong with the logs, not in a folder of their own under the roaming profile.
app.setPath("crashDumps", path.join(layout.partitions.logs, "crashes"));

const quitForUpdateFlag = process.argv.includes("--quit-for-update");
const cliHoldWriteMs = (() => {
  const match = process.argv.find((arg) => arg.startsWith("--manga-hold-write-ms="));
  return match ? Number.parseInt(match.slice("--manga-hold-write-ms=".length), 10) || 0 : 0;
})();

if (quitForUpdateFlag) {
  signalQuitForUpdateAndExit({ runtimeDir: layout.partitions.runtime, channel: layout.channel, testIdentity: channelInfo.testIdentity });
}
if (layout.writable) {
  persistPointer(layout);
}

let appService: MangaProductApp | undefined;
const asrService = new AsrService({ resourcesPath: process.resourcesPath });
let ownerGrant: string | undefined;
const actor = { kind: "user" as const, id: "desktop-user" };
const hideWindow = smoke || process.env.MANGA_WINDOW_HIDDEN === "1";
// `--background` (A-135): `stage install-dev` starts the development build in the tray without showing a window.
const startInTray = !hideWindow && process.argv.includes("--background");
let window: BrowserWindow | undefined;
let windowTray: WindowTrayController | undefined;
let saved = false;
/** The application is on its way out (a quit, the system ending the session): closing the window then closes it, never into the tray (A-136). */
let quitting = false;
let preparingUpdate = false;

function destroyWindowTray(): void {
  windowTray?.dispose();
  windowTray = undefined;
}

function flushWindowSaves(options: { strict?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  options.signal?.throwIfAborted();
  if (saved) return Promise.resolve();
  if (!window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed()) {
    return options.strict ? Promise.reject(new Error("界面未能确认保存，已保留当前版本")) : Promise.resolve();
  }
  const closing = window;
  const token = createId("save");
  return new Promise<void>((resolve, reject) => {
    const done = (ok: boolean) => {
      clearTimeout(timer);
      ipcMain.removeListener("manga:saved", onSaved);
      options.signal?.removeEventListener("abort", aborted);
      saved = ok || !options.strict;
      if (options.strict && !ok) reject(new Error("update save did not complete"));
      else resolve();
    };
    const aborted = () => done(false);
    const onSaved = (reply: Electron.IpcMainEvent, answered: unknown, result?: { ok?: boolean }) => {
      if (reply.sender === closing.webContents && answered === token) done(options.strict ? result?.ok === true : result?.ok !== false);
    };
    const timer = setTimeout(() => done(false), options.strict ? 20_000 : SAVE_BEFORE_CLOSE_MS);
    options.signal?.addEventListener("abort", aborted, { once: true });
    ipcMain.on("manga:saved", onSaved);
    closing.webContents.send("manga:save-now", token);
  });
}

const instanceControl = createQuitForUpdateController({
  runtimeDir: layout.partitions.runtime,
  writable: layout.writable,
  quitForUpdateFlag,
  channel: layout.channel,
  testIdentity: channelInfo.testIdentity,
  version: buildInfo.version,
  getAppService: () => appService,
  clearAppService: () => { appService = undefined; },
  getWindow: () => window,
  flushWindowSaves,
  setPreparingUpdate: (value) => { preparingUpdate = value; },
  resetSaved: () => { saved = false; },
  destroyWindowTray,
  disposeAsr: () => asrService.dispose(),
});

if (layout.writable) {
  try {
    if (!app.requestSingleInstanceLock({ channel: layout.channel, testIdentity: channelInfo.testIdentity })) {
      // A second start that hands over to the running one is not a failed start.
      if (process.env.MANGA_LAUNCH_ATTEMPT_FILE) launchSucceeded(process.env.MANGA_LAUNCH_ATTEMPT_FILE);
      app.exit(0);
    }
  } catch {
    // ignore
  }
  instanceControl.clearStaleSignalFiles();
  instanceControl.writeRunningInstance("starting");
  app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
    routeSecondInstance({
      argv,
      additionalData,
      hasQuitSignal: () => fs.existsSync(instanceControl.quitSignalFile),
      onQuitForUpdate: () => { void instanceControl.handleQuitForUpdate(); },
      tray: windowTray,
      window,
      hideWindow,
    });
  });
  instanceControl.startPolling(() => smoke && process.env.MANGA_SMOKE_PHASE === "update-driver");
}

function lightRuntimeDir(): string {
  return lightDirsOf(appRootOf(channelInfo)).runtime;
}

function lightOpenRunning(error: unknown): boolean {
  return error instanceof MangaError && (error.details as { reason?: unknown } | undefined)?.reason === "light-open-running";
}

async function runDetachedWindowsInstaller(input: { installerPath: string; mode: "restart" | "quit"; expectedSha512: string }): Promise<boolean> {
  let relaunchArgs: string[] = [];
  if (process.env.MANGA_UPDATE_RELAUNCH_ARGS) {
    try {
      const parsed = JSON.parse(process.env.MANGA_UPDATE_RELAUNCH_ARGS);
      if (Array.isArray(parsed)) relaunchArgs = parsed.map(String);
    } catch {
      // ignore
    }
  }
  const handle = await startUpdateInstaller({
    updaterDir: path.join(layout.partitions.cache, "updater"),
    attemptId: createId("update-install"),
    installerPath: input.installerPath,
    mode: input.mode,
    expectedSha512Base64: input.expectedSha512,
    targetVersion: appService?.update.status().availableVersion ?? null,
    relaunchArgs,
  });
  if (!handle.ok) return false;
  if (input.mode === "restart") {
    setTimeout(() => {
      destroyWindowTray();
      instanceControl.cleanupInstanceFiles();
      asrService.dispose();
      appService?.close();
      appService = undefined;
      app.exit(0);
    }, 60).unref?.();
  }
  return true;
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const rendererUrl = () => resolveRendererUrl({
  devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
  viteName: MAIN_WINDOW_VITE_NAME,
  baseDir: __dirname,
});

function assertCaller(event: Electron.IpcMainInvokeEvent): void {
  if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error("拒绝非应用主界面的调用");
  }
}

async function bootService(): Promise<void> {
  if (!layout.writable) return;
  appService = new MangaProductApp({
    layout,
    channel: layout.channel,
    pointerPath: layout.pointerPath,
    documentsDir: layout.documentsRoot,
    packaged: app.isPackaged,
    hostId: "desktop",
    vault: new ElectronSafeStorageVault(safeStorage),
    appVersion: buildInfo.version,
    buildInfo,
    resourcesPath: process.resourcesPath,
    localAsr: asrService,
    ...(smoke && process.env.MANGA_SMOKE_ALLOW_LOOPBACK_MODEL === "1" ? { asrModels: { allowLoopbackHttp: true } } : {}),
    netFetch: createNetFetch(net),
    plugins: {
      spawn: utilitySpawner,
      bundledDir: app.isPackaged ? path.join(process.resourcesPath, "plugins") : process.env.MANGA_PLUGINS_DIR || path.join(process.resourcesPath, "plugins"),
      ...(smoke && process.env.MANGA_SMOKE_PLUGIN_PUBLIC_KEY?.trim()
        ? { firstPartyKeys: [...FIRST_PARTY_KEYS, { publicKey: process.env.MANGA_SMOKE_PLUGIN_PUBLIC_KEY.trim(), label: "MANGA Smoke Ephemeral" }] }
        : {}),
    },
    ...(smoke ? { network: { allowPrivate: (host: string) => host === "127.0.0.1" } } : {}),
    ...(smoke && process.env.MANGA_SMOKE_BANGUMI_ORIGIN ? { bangumi: { apiOrigin: process.env.MANGA_SMOKE_BANGUMI_ORIGIN, allowedHosts: [new URL(process.env.MANGA_SMOKE_BANGUMI_ORIGIN).host], allowHttp: true, allowPrivate: true, maxRetries: 0, timeoutMs: 4000 } } : {}),
    ...(smoke && process.env.MANGA_SMOKE_PROVIDER_ORIGIN ? { providers: { testOrigin: process.env.MANGA_SMOKE_PROVIDER_ORIGIN } } : {}),
    danmaku: smoke ? { credentials: SMOKE_DANMAKU_CREDENTIALS, origin: process.env.MANGA_SMOKE_DANDAN_ORIGIN || "http://127.0.0.1:9", client: { allowHttp: true } } : { credentials: builtInDanmakuCredentials() },
    ...(smoke && process.env.MANGA_SMOKE_BT_LOOPBACK === "1" ? { acquisition: { network: { dht: false, lsd: false, natUpnp: false, natPmp: false } } } : {}),
    ...(cliHoldWriteMs > 0 ? { holdWriteMs: cliHoldWriteMs } : {}),
    update: {
      installDirectory: app.isPackaged ? path.dirname(process.execPath) : undefined,
      onInstallFailed: () => {
        saved = false;
        preparingUpdate = false;
        if (window && !window.isDestroyed()) window.setEnabled(true);
      },
      onBeforeInstall: async () => {
        const light = await askLightToQuit(lightRuntimeDir(), { timeoutMs: LIGHT_QUIT_WAIT_MS });
        if (!light.ok) throw new MangaError("UPDATE_UNAVAILABLE", "请先关闭轻量播放窗口", { details: { reason: "light-open-running" } });
        try {
          if (!updateFixtureSmoke) {
            preparingUpdate = true;
            window?.setEnabled(false);
          }
          await flushWindowSaves({ strict: true });
          await appService?.prepareQuitForUpdate({ signal: AbortSignal.timeout(28_000) });
        } catch (error) {
          saved = false;
          preparingUpdate = false;
          if (window && !window.isDestroyed()) window.setEnabled(true);
          throw error;
        }
      },
      ...((app.isPackaged && process.platform === "win32") || process.env.MANGA_FORCE_DETACHED_UPDATER === "1"
        ? { runInstaller: (installerPath, _args, mode, receipt) => runDetachedWindowsInstaller({ installerPath, mode, expectedSha512: receipt.sha512 }) }
        : {}),
      ...(smoke ? { allowLoopbackHttp: true } : {}),
      ...(smoke && process.env.MANGA_SMOKE_UPDATE_PUBLIC_KEY ? { publicKeys: [{ publicKey: process.env.MANGA_SMOKE_UPDATE_PUBLIC_KEY, label: "MANGA Smoke Update" }] } : {}),
    },
    useParseWorker: true,
    parseWorkerPath: [
      path.join(process.resourcesPath, "parse-worker.cjs"),
      path.join(__dirname, "parse-worker.cjs").replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`),
      path.join(__dirname, "parse-worker.cjs"),
    ].find((file) => fs.existsSync(file)),
  });
  await appService.start();
  if (smoke && process.env.MANGA_ASR_IDLE_MS) {
    const smokeIdleMs = Number(process.env.MANGA_ASR_IDLE_MS);
    if (Number.isFinite(smokeIdleMs) && smokeIdleMs > 0) asrService.setIdleTimeoutMs(smokeIdleMs);
  }
  if (layout.channel === "release" && app.isPackaged && !updateFixtureSmoke) {
    attachNsisUpdater({
      updateService: appService.update,
      version: buildInfo.version,
      appUpdateConfigPath: path.join(process.resourcesPath, "app-update.yml"),
      userDataPath: layout.partitions.runtime,
      baseCachePath: layout.partitions.cache,
      installDirectory: app.isPackaged ? path.dirname(process.execPath) : undefined,
      isPackaged: app.isPackaged,
      runtime: true,
      allowLoopbackHttp: smoke,
    });
  }
  ownerGrant = appService.issueOwnerGrant(actor).handle;
  appService.onNotice((notice) => {
    if (window && !window.isDestroyed()) window.webContents.send("manga:notice", notice);
  });
  appService.startScheduler();
}

function assetProblems(): string[] {
  if (!app.isPackaged) return [];
  return verifyBundledAssets(process.resourcesPath, { required: [...REQUIRED_ASSETS, ...PACKAGED_PLUGIN_ASSETS] }).problems;
}

if (!quitForUpdateFlag) void app.whenReady().then(async () => {
  const missing = assetProblems();
  if (missing.length) {
    const message = `安装包不完整：${missing.join("；")}。请重新安装。`;
    if (smoke) {
      fs.mkdirSync(layout.partitions.logs, { recursive: true });
      fs.writeFileSync(path.join(layout.partitions.logs, `smoke-${process.env.MANGA_SMOKE_PHASE ?? "initial"}.json`), `${JSON.stringify({ status: "failed", error: message, missingAssets: missing }, null, 2)}\n`);
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
  const windowIcon = resolveAppIconPath({
    channel: layout.channel,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    baseDir: __dirname,
  });
  window = new BrowserWindow({
    width: productWindow.width,
    height: productWindow.height,
    minWidth: productWindow.minWidth,
    minHeight: productWindow.minHeight,
    ...(windowIcon ? { icon: windowIcon } : {}),
    show: !hideWindow && !startInTray,
    skipTaskbar: hideWindow || startInTray,
    backgroundColor: productWindow.backgroundColor,
    titleBarStyle: productWindow.titleBarStyle,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      enableBlinkFeatures: "AudioVideoTracks",
      ...(smoke ? { backgroundThrottling: false } : {}),
    },
  });
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    window.removeMenu();
  }
  window.setMenuBarVisibility(false);
  if (hideWindow) {
    window.webContents.setAudioMuted(true);
    const yieldFocus = () => { if (window && !window.isDestroyed()) window.blur(); };
    window.on("show", yieldFocus);
    window.on("leave-full-screen", yieldFocus);
  }
  windowTray = createWindowTray({
    window,
    channel: layout.channel,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    baseDir: __dirname,
    hideWindow,
    createTray: (iconPath) => new Tray(iconPath),
    buildMenu: (template) => Menu.buildFromTemplate(template),
    onQuit: () => app.quit(),
  });
  if (startInTray && !windowTray.parkInTray()) {
    window.setSkipTaskbar(false);
    window.show();
  }
  if (smoke) window.setIgnoreMouseEvents(true);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const appUrl = rendererUrl();
  window.webContents.on("will-navigate", (event, target) => { if (!isAppPage(target, appUrl)) event.preventDefault(); });
  const isMainWindow = (contents: Electron.WebContents | null) => Boolean(contents && window && !window.isDestroyed() && contents === window.webContents);
  const permissions = window.webContents.session;
  permissions.setPermissionRequestHandler((contents, permission, callback, details) => {
    const media = (details as { mediaTypes?: string[] }).mediaTypes;
    callback(permissionAllowed({ permission, requestingUrl: details.requestingUrl ?? contents.getURL(), mediaTypes: media, appUrl, fromAppWindow: isMainWindow(contents) }));
  });
  permissions.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
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
      return saved?.overlay ?? {};
    },
    saveRect: (pos) => { void callOwner("settings.setRecording", { overlay: { x: pos.x, y: pos.y } }); },
    onStopRequest: () => { if (window && !window.isDestroyed()) window.webContents.send("manga:overlay-stop"); },
  });

  const ipc = registerMainIpcHandlers({
    getWindow: () => window,
    getAppService: () => appService,
    getOwnerGrant: () => ownerGrant,
    getWindowTray: () => windowTray,
    destroyWindowTray,
    overlay,
    layout,
    buildInfo,
    actor,
    smoke,
    assertCaller,
    onUpdateRestartFailed: () => {
      saved = false;
      preparingUpdate = false;
      if (window && !window.isDestroyed()) window.setEnabled(true);
    },
  });

  window.webContents.on("did-start-navigation", () => { ipc.abortAllSpeech(); });
  window.on("closed", () => {
    ipc.abortAllSpeech();
    destroyWindowTray();
    overlay.close();
  });

  let closeInFlight = false;
  let closingAfterUpdate = false;
  let closeChosen = false;
  window.on("session-end", () => { quitting = true; });
  window.on("close", (event) => {
    if (closeInFlight || (preparingUpdate && !closingAfterUpdate)) { event.preventDefault(); return; }
    if (!quitting && !closeChosen && windowTray?.isActive() && window && !window.isDestroyed()) {
      event.preventDefault();
      const closing = window;
      void callOwner("settings.getShell", {}).then(
        (result) => ((result as { value?: { window?: { closeToTray?: boolean } } } | undefined)?.value?.window?.closeToTray ?? true),
        () => true,
      ).then((toTray) => {
        if (closing.isDestroyed()) return;
        if (toTray && !quitting && windowTray?.hideToTray()) return;
        closeChosen = true;
        closing.close();
      });
      return;
    }
    if (saved || !window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed()) return;
    event.preventDefault();
    const closing = window;
    closeInFlight = true;
    void (async () => {
      try {
        if (appService?.update.status().state === "ready" && !updateFixtureSmoke) {
          let installed = false;
          try {
            installed = await appService.update.installOnQuit();
          } catch (error) {
            if (!lightOpenRunning(error)) throw error;
          }
          if (!installed) await flushWindowSaves();
        } else {
          await flushWindowSaves();
        }
        closeInFlight = false;
        closingAfterUpdate = true;
        if (!closing.isDestroyed()) closing.close();
      } catch (error) {
        closeInFlight = false;
        preparingUpdate = false;
        saved = false;
        closeChosen = false;
        quitting = false;
        windowTray?.ensureActive();
        if (!closing.isDestroyed()) {
          if (!hideWindow) closing.setSkipTaskbar(false);
          closing.setEnabled(true);
          await dialog.showMessageBox(closing, { type: "error", title: "无法准备更新", message: error instanceof Error ? error.message : "更新前保存或备份失败，已保留当前版本" });
        }
      }
    })();
  });

  const windowState = (): WindowState => ({ controls: windowControlsDrawn(process.platform), maximized: Boolean(window && !window.isDestroyed() && window.isMaximized()) });
  const pushWindowState = () => { if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send("manga:window-state", windowState()); };
  window.on("maximize", pushWindowState);
  window.on("unmaximize", pushWindowState);
  window.on("restore", pushWindowState);
  ipcMain.handle("manga:window-state", (event) => { assertCaller(event); return windowState(); });
  ipcMain.handle("manga:window-action", (event, requested: unknown) => {
    assertCaller(event);
    const action = parseWindowAction(requested);
    if (!action || !window || window.isDestroyed()) return windowState();
    if (action === "minimize") window.minimize();
    else if (action === "close") window.close();
    else if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return windowState();
  });

  instanceControl.writeRunningInstance("ready", smoke ? { justUpdated: appService?.update.status().justUpdated ?? null } : {});
  if (smoke && process.env.MANGA_SMOKE_PHASE === "update-driver") return;
  if (smoke) {
    try {
      const { runSmoke } = await import("./smoke/index.ts");
      await runSmoke({ appService, ownerGrant, window, layout, asrService });
    } catch (error) {
      console.error(error);
      destroyWindowTray();
      asrService.dispose();
      appService?.close();
      app.exit(1);
    }
  }
});

app.on("before-quit", () => {
  quitting = true;
});

app.on("will-quit", () => {
  destroyWindowTray();
  asrService.dispose();
});

app.on("window-all-closed", () => {
  destroyWindowTray();
  void (async () => {
    try {
      asrService.dispose();
      appService?.close();
    } finally {
      instanceControl.cleanupInstanceFiles();
      app.quit();
    }
  })();
});
