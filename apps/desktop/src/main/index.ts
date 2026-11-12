import { app, BrowserWindow, dialog, ipcMain, Menu, net, session, shell } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { MangaProductApp, ElectronSafeStorageVault, FIRST_PARTY_KEYS, resolveLaunchLayout, persistPointer, readBuildInfo, readBuildInfoIfPresent } from "@manga/app-core";
import { parseWindowAction, productWindow, windowControlsDrawn, type WindowState } from "./window-options.ts";
import { testHooks } from "./test-hooks.ts";
import { handleMediaProtocol, registerMediaScheme } from "./media-protocol.ts";
import { externalUrlAllowed, isAppPage, permissionAllowed } from "./permissions.ts";
import { RecordingOverlay } from "./overlay.ts";
import { PACKAGED_PLUGIN_ASSETS, REQUIRED_ASSETS, verifyBundledAssets } from "./bundled-assets.ts";
import { createNetFetch } from "./net-fetch.ts";
import { builtInDanmakuCredentials, SMOKE_DANMAKU_CREDENTIALS } from "./danmaku-credentials.ts";
import { attachNsisUpdater } from "./updater.ts";
import { CHANNELS, createId, LOCATION_PARTITIONS, MangaError, type Channel } from "@manga/contracts";
import { safeStorage } from "electron";
import { utilitySpawner } from "./plugin-process.ts";
import { AsrService } from "./asr-service.ts";
import { launchSucceeded } from "./launch-guard.ts";
import { appRootOf, channelInfoOf, lightDirsOf } from "./launch-paths.ts";
import { askLightToQuit, LIGHT_QUIT_WAIT_MS } from "./light-runtime.ts";

/** How long a closing window waits for the page to save what waits for its save. */
const SAVE_BEFORE_CLOSE_MS = 1500;
const smoke = process.argv.includes("--manga-smoke");
const updateFixtureSmoke = smoke && process.env.MANGA_SMOKE_PHASE === "update";
// A smoke window sits on the developer's own desktop. When other windows cover it, Chromium treats it as occluded: frames stop and the renderer is
// throttled, so transitions never finish and timings stretch. Smoke runs keep the window rendering whatever else is on screen.
if (smoke) {
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
  app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
  app.commandLine.appendSwitch("disable-renderer-backgrounding");
  app.commandLine.appendSwitch("disable-background-timer-throttling");
  app.commandLine.appendSwitch("mute-audio");
}
// The recording and dictation smoke/bench phases use Chromium's fake capture device, which plays a synthetic speech clip instead of a microphone.
if (smoke && process.env.MANGA_SMOKE_AUDIO && (process.env.MANGA_SMOKE_PHASE === "voice" || process.env.MANGA_SMOKE_PHASE === "dictation" || process.env.MANGA_SMOKE_PHASE === "bench-dictation")) {
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
/** The system's registered folder (Documents or Downloads, which may be redirected to another drive); an explicit variable wins, a failure falls back to the home folder. */
function systemFolder(name: "documents" | "downloads", variable: string): string | undefined {
  if (process.env[variable]) return process.env[variable];
  try { return app.getPath(name); } catch { return undefined; }
}

/** The channel (and optional test identity, 计划 4.8) a package was built for is written into it (计划 4.9), not guessed: a development build installed beside a release keeps its own places. */
function builtChannelInfo(): { channel: Channel | undefined; testIdentity: boolean } {
  const envTest = process.env.MANGA_TEST_IDENTITY === "1";
  const named = process.env.MANGA_CHANNEL as Channel | undefined;
  let fileChannel: Channel | undefined;
  let fileTest = false;
  if (app.isPackaged || fs.existsSync(path.join(process.resourcesPath, "channel.json"))) {
    try {
      const body = JSON.parse(fs.readFileSync(path.join(process.resourcesPath, "channel.json"), "utf8")) as { channel?: string; testIdentity?: boolean };
      if (body.channel === "release" || body.channel === "development") fileChannel = body.channel;
      if (body.testIdentity === true) fileTest = true;
    } catch { /* a package made before the channel was written in is a release */ }
  }
  const channel = named && (CHANNELS as readonly string[]).includes(named)
    ? named
    : !app.isPackaged
      ? (fileChannel ?? "development")
      : (fileChannel ?? "release");
  return { channel, testIdentity: envTest || fileTest };
}

const channelInfo = builtChannelInfo();
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

function windowIconPath(): string | undefined {
  // An installed copy carries its channel's icon in resources/ (the development installer puts the "DEV" one there); a source run picks by channel.
  const source = layout.channel === "development" ? "icon-dev" : "icon";
  const candidates = [
    path.join(process.resourcesPath, "icon.ico"),
    path.join(process.resourcesPath, "icon.png"),
    path.resolve(__dirname, `../../assets/${source}.ico`),
    path.resolve(__dirname, `../../assets/${source}.png`),
  ];
  return candidates.find((file) => fs.existsSync(file));
}
app.setPath("userData", layout.partitions.runtime);
app.setPath("sessionData", layout.partitions.runtime);
// Crash dumps belong with the logs, not in a folder of their own under the roaming profile.
app.setPath("crashDumps", path.join(layout.partitions.logs, "crashes"));

const runtimeDir = layout.partitions.runtime;
const runningInstanceFile = path.join(runtimeDir, "running-instance.json");
const quitSignalFile = path.join(runtimeDir, "quit-for-update.json");
const quitAckFile = path.join(runtimeDir, "quit-for-update-ack.json");
const releaseBlockingFile = path.join(runtimeDir, "release-blocking-write.json");
const quitForUpdateFlag = process.argv.includes("--quit-for-update");
const cliHoldWriteMs = (() => {
  const match = process.argv.find((arg) => arg.startsWith("--manga-hold-write-ms="));
  return match ? Number.parseInt(match.slice("--manga-hold-write-ms=".length), 10) || 0 : 0;
})();

if (quitForUpdateFlag) {
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    if (!fs.existsSync(quitSignalFile) && !process.env.MANGA_DEV_QUIT_REQUEST_ID) {
      fs.writeFileSync(
        quitSignalFile,
        `${JSON.stringify({ requestedAt: new Date().toISOString(), pid: process.pid, channel: layout.channel, testIdentity: channelInfo.testIdentity })}\n`,
      );
    }
  } catch {
    // ignore if runtime directory is not writable
  }
  try {
    app.requestSingleInstanceLock({ quitForUpdate: true, channel: layout.channel, testIdentity: channelInfo.testIdentity });
  } catch {
    // ignore
  }
  app.exit(0);
}

if (!quitForUpdateFlag && layout.writable) {
  persistPointer(layout);
}

let appService: MangaProductApp | undefined;
const asrService = new AsrService({ resourcesPath: process.resourcesPath });
let ownerGrant: string | undefined;
const actor = { kind: "user" as const, id: "desktop-user" };
let window: BrowserWindow | undefined;
let saved = false;
let preparingUpdate = false;
let quittingForUpdate: Promise<void> | null = null;
let quitPollTimer: ReturnType<typeof setInterval> | null = null;
const instanceStartedAt = new Date().toISOString();
let instanceReady = false;

function writeRunningInstance(state: "starting" | "ready", extras: Record<string, unknown> = {}): void {
  if (quitForUpdateFlag || !layout.writable) return;
  instanceReady = state === "ready";
  // The bootstrap watches the first starts of a version that came by an update (4.2): a window that is ready makes this start a good one.
  if (instanceReady && process.env.MANGA_LAUNCH_ATTEMPT_FILE) launchSucceeded(process.env.MANGA_LAUNCH_ATTEMPT_FILE);
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(
      runningInstanceFile,
      `${JSON.stringify({
        pid: process.pid,
        state,
        version: buildInfo.version,
        channel: layout.channel,
        testIdentity: channelInfo.testIdentity,
        execPath: process.execPath,
        startedAt: instanceStartedAt,
        updatedAt: new Date().toISOString(),
        ...extras,
      }, null, 2)}\n`,
    );
  } catch {
    // ignore
  }
}

function cleanupInstanceFiles(): void {
  if (quitPollTimer) {
    clearInterval(quitPollTimer);
    quitPollTimer = null;
  }
  try {
    if (fs.existsSync(runningInstanceFile)) {
      const current = JSON.parse(fs.readFileSync(runningInstanceFile, "utf8")) as { pid?: number };
      if (current.pid === process.pid) fs.rmSync(runningInstanceFile, { force: true });
    }
  } catch {
    // ignore
  }
  try { fs.rmSync(quitSignalFile, { force: true }); } catch { /* ignore */ }
}

function handleQuitForUpdate(): Promise<void> {
  if (quittingForUpdate) return quittingForUpdate;
  quittingForUpdate = (async () => {
    let requestText: string;
    let expiresAt: number;
    try {
      requestText = fs.readFileSync(quitSignalFile, "utf8");
      const request = JSON.parse(requestText) as { channel?: string; testIdentity?: boolean; expiresAt?: number };
      if (request.channel !== layout.channel || Boolean(request.testIdentity) !== channelInfo.testIdentity) return;
      expiresAt = Math.min(request.expiresAt ?? Date.now() + 28_000, Date.now() + 28_000);
      if (!(expiresAt > Date.now())) { fs.rmSync(quitSignalFile, { force: true }); return; }
    } catch { return; }
    const cancelled = new AbortController();
    const timeout = setTimeout(() => cancelled.abort(new Error("update quit timed out")), expiresAt - Date.now());
    const requestStillCurrent = () => {
      try { return fs.readFileSync(quitSignalFile, "utf8") === requestText; } catch { return false; }
    };
    const poll = setInterval(() => { if (!requestStillCurrent()) cancelled.abort(new Error("update quit cancelled")); }, 100);
    try {
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.writeFileSync(
        quitAckFile,
        `${JSON.stringify({
          pid: process.pid,
          receivedAt: new Date().toISOString(),
          blockingWrites: appService?.hasBlockingWrites() ?? false,
        }, null, 2)}\n`,
      );
    } catch {
      // ignore
    }
    try {
      preparingUpdate = true;
      window?.setEnabled(false);
      await flushWindowSaves({ strict: true, signal: cancelled.signal });
      await appService?.prepareQuitForUpdate({ signal: cancelled.signal });
      cancelled.signal.throwIfAborted();
      if (!requestStillCurrent()) throw new Error("update quit request withdrawn");
      cleanupInstanceFiles();
      asrService.dispose();
      appService?.close();
      appService = undefined;
      app.exit(0);
    } catch {
      // An abandoned install request must never close the instance later when a blocked write completes.
      saved = false;
      preparingUpdate = false;
      if (window && !window.isDestroyed()) window.setEnabled(true);
      try { fs.writeFileSync(quitAckFile, JSON.stringify({ pid: process.pid, status: "busy" })); } catch { /* ignore */ }
      if (requestStillCurrent()) { try { fs.rmSync(quitSignalFile, { force: true }); } catch { /* ignore */ } }
    } finally {
      clearTimeout(timeout);
      clearInterval(poll);
    }
  })().finally(() => { quittingForUpdate = null; });
  return quittingForUpdate;
}

if (!quitForUpdateFlag && layout.writable) {
  try {
    if (!app.requestSingleInstanceLock({ channel: layout.channel, testIdentity: channelInfo.testIdentity })) {
      // A second start that hands over to the running one is not a failed start.
      if (process.env.MANGA_LAUNCH_ATTEMPT_FILE) launchSucceeded(process.env.MANGA_LAUNCH_ATTEMPT_FILE);
      app.exit(0);
    }
  } catch {
    // ignore
  }
  for (const stale of [quitSignalFile, quitAckFile, releaseBlockingFile]) {
    try { fs.rmSync(stale, { force: true }); } catch { /* ignore */ }
  }
  writeRunningInstance("starting");
  app.on("second-instance", (_event, argv, _workingDirectory, additionalData) => {
    const extra = additionalData as { quitForUpdate?: boolean } | undefined;
    if (argv.includes("--quit-for-update") || extra?.quitForUpdate === true || fs.existsSync(quitSignalFile)) {
      void handleQuitForUpdate();
    }
  });
  let lastBlockingState: boolean | undefined;
  quitPollTimer = setInterval(() => {
    if (instanceReady && smoke && process.env.MANGA_SMOKE_PHASE === "update-driver" && appService) {
      const blockingWrites = appService.hasBlockingWrites();
      if (blockingWrites !== lastBlockingState) {
        lastBlockingState = blockingWrites;
        writeRunningInstance("ready", { blockingWrites, justUpdated: appService.update.status().justUpdated });
      }
    }
    if (fs.existsSync(quitSignalFile)) {
      void handleQuitForUpdate();
    }
  }, 120);
  quitPollTimer.unref?.();
}

/** Light open's runtime folder for this channel (where its running marker and the quit request are). */
function lightRuntimeDir(): string {
  return lightDirsOf(appRootOf(channelInfoOf({ resourcesPath: process.resourcesPath, packaged: app.isPackaged }))).runtime;
}

function lightOpenRunning(error: unknown): boolean {
  return error instanceof MangaError && (error.details as { reason?: unknown } | undefined)?.reason === "light-open-running";
}

async function runDetachedWindowsInstaller(input: { installerPath: string; mode: "restart" | "quit"; expectedSha512: string }): Promise<boolean> {
  try {
    const installDir = path.dirname(process.execPath);
    const exePath = process.execPath;
    const updaterDir = path.join(layout.partitions.cache, "updater");
    fs.mkdirSync(updaterDir, { recursive: true });
    const attemptId = createId("update-install");
    const planFile = path.join(updaterDir, `${attemptId}.json`);
    const readyFile = path.join(updaterDir, `${attemptId}.ready`);
    const cancelFile = path.join(updaterDir, `${attemptId}.cancel`);
    const doneFile = path.join(updaterDir, "last-installed.json");
    try { fs.rmSync(doneFile, { force: true }); } catch { /* ignore */ }
    const targetVersion = appService?.update.status().availableVersion ?? null;
    let relaunchArgs: string[] = [];
    if (process.env.MANGA_UPDATE_RELAUNCH_ARGS) {
      try {
        const parsed = JSON.parse(process.env.MANGA_UPDATE_RELAUNCH_ARGS);
        if (Array.isArray(parsed)) relaunchArgs = parsed.map(String);
      } catch {
        // ignore
      }
    }
    fs.writeFileSync(
      planFile,
      `${JSON.stringify({
        pid: process.pid,
        installerPath: input.installerPath,
        installDir,
        exePath,
        mode: input.mode,
        attemptId,
        version: targetVersion,
        sha512Hex: Buffer.from(input.expectedSha512, "base64").toString("hex"),
        doneFile,
        readyFile,
        cancelFile,
        relaunchArgs,
      }, null, 2)}\n`,
    );
    const psScript = [
      "$ErrorActionPreference = 'Stop'",
      "$plan = Get-Content -LiteralPath $env:MANGA_INSTALL_PLAN -Raw -Encoding UTF8 | ConvertFrom-Json",
      "$code = 1; $actualVersion = $null; $installed = $false; $failureStage = 'prepare'; $errorType = $null",
      "try {",
      // The caller may be PowerShell 7, whose inherited module path omits Windows
      // PowerShell's Get-FileHash function. Load the helper's own system module.
      "  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop",
      "  if ((Get-FileHash -LiteralPath $plan.installerPath -Algorithm SHA512).Hash.ToLowerInvariant() -ne $plan.sha512Hex) { throw 'installer changed' }",
      "  $ready = @{ attemptId = $plan.attemptId; helperPid = $PID } | ConvertTo-Json -Compress",
      "  [System.IO.File]::WriteAllText([string]$plan.readyFile, [string]$ready, (New-Object System.Text.UTF8Encoding($false)))",
      "  $failureStage = 'wait-for-exit'",
      "  for ($i = 0; $i -lt 400; $i++) {",
      "    if (Test-Path -LiteralPath $plan.cancelFile) { throw 'installation cancelled' }",
      "    if (-not (Get-Process -Id $plan.pid -ErrorAction SilentlyContinue)) { break }",
      "    Start-Sleep -Milliseconds 100",
      "  }",
      "  if (Get-Process -Id $plan.pid -ErrorAction SilentlyContinue) { throw 'old application still running' }",
      "  if (Test-Path -LiteralPath $plan.cancelFile) { throw 'installation cancelled' }",
      "  $failureStage = 'verify-installer'",
      "  if ((Get-FileHash -LiteralPath $plan.installerPath -Algorithm SHA512).Hash.ToLowerInvariant() -ne $plan.sha512Hex) { throw 'installer changed' }",
      "  if (Test-Path -LiteralPath $plan.cancelFile) { throw 'installation cancelled' }",
      "  $failureStage = 'install'",
      "  $p = Start-Process -FilePath $plan.installerPath -ArgumentList @('--updated', '/S', ('/D=' + $plan.installDir)) -Wait -PassThru -WindowStyle Hidden",
      "  $code = $p.ExitCode",
      "  $failureStage = 'inspect-installed-version'",
      "  $actualVersion = (Get-Content -LiteralPath (Join-Path $plan.installDir 'resources/build.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version",
      "  $installed = $code -eq 0 -and $actualVersion -eq $plan.version -and (Test-Path -LiteralPath $plan.exePath)",
      "} catch { $code = 1; $errorType = $_.Exception.GetType().FullName }",
      "$done = @{ attemptId = $plan.attemptId; status = if ($installed) { 'installed' } else { 'failed' }; exitCode = $code; version = $plan.version; actualVersion = $actualVersion; mode = $plan.mode; installerSha512Hex = $plan.sha512Hex; failureStage = if ($installed) { $null } else { $failureStage }; errorType = $errorType; completedAt = (Get-Date).ToString('o') } | ConvertTo-Json -Compress",
      "[System.IO.File]::WriteAllText([string]$plan.doneFile, [string]$done, (New-Object System.Text.UTF8Encoding($false)))",
      "if ($plan.mode -eq 'restart' -and -not (Test-Path -LiteralPath $plan.cancelFile) -and -not (Get-Process -Id $plan.pid -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath $plan.exePath)) {",
      "  if ($plan.relaunchArgs -and $plan.relaunchArgs.Count -gt 0) {",
      "    Start-Process -FilePath $plan.exePath -ArgumentList $plan.relaunchArgs -WindowStyle Hidden",
      "  } else {",
      "    Start-Process -FilePath $plan.exePath -WindowStyle Hidden",
      "  }",
      "}",
    ].join("; ");
    // PowerShell cannot run with DETACHED_PROCESS here; a directly attached child is
    // killed by Node's Windows job when the app exits. Start-Process launches the
    // hidden installer helper independently, while this short bootstrap can finish.
    const bootstrap = "Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @('-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',$env:MANGA_INSTALL_SCRIPT) -WindowStyle Hidden";
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", bootstrap], {
      detached: false,
      stdio: "ignore",
      windowsHide: true,
      env: { ...process.env, MANGA_INSTALL_PLAN: planFile, MANGA_INSTALL_SCRIPT: Buffer.from(psScript, "utf16le").toString("base64") },
    });
    let bootstrapFailed = false;
    child.once("exit", (code) => { bootstrapFailed = code !== 0; });
    const started = await new Promise<boolean>((resolve) => {
      child.once("error", () => resolve(false));
      child.once("spawn", () => resolve(true));
    });
    if (!started) return false;
    const deadline = Date.now() + 8_000;
    let prepared = false;
    while (!bootstrapFailed && Date.now() < deadline) {
      try {
        const ready = JSON.parse(fs.readFileSync(readyFile, "utf8"));
        if (ready.attemptId === attemptId && Number.isSafeInteger(ready.helperPid) && ready.helperPid > 0) {
          process.kill(ready.helperPid, 0);
          prepared = true;
          break;
        }
      } catch { /* preparation is still in progress */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (bootstrapFailed || !prepared) {
      fs.writeFileSync(cancelFile, "cancelled");
      child.unref();
      return false;
    }
    child.unref();
    if (input.mode === "restart") {
      setTimeout(() => {
        cleanupInstanceFiles();
        asrService.dispose();
        appService?.close();
        appService = undefined;
        app.exit(0);
      }, 60).unref?.();
    }
    return true;
  } catch {
    return false;
  }
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
    layout,
    channel: layout.channel,
    pointerPath: layout.pointerPath,
    documentsDir: layout.documentsRoot,
    packaged: app.isPackaged,
    hostId: "desktop",
    vault: new ElectronSafeStorageVault(safeStorage),
    appVersion: buildInfo.version,
    buildInfo,
    // Packaged builds carry FFmpeg and the voice-filter model next to the app; development builds look at the local tool cache.
    resourcesPath: process.resourcesPath,
    localAsr: asrService,
    ...(smoke && process.env.MANGA_SMOKE_ALLOW_LOOPBACK_MODEL === "1" ? { asrModels: { allowLoopbackHttp: true } } : {}),
    // Metadata requests go through Chromium's network stack, so the system proxy and certificates apply.
    netFetch: createNetFetch(net),
    // Plugins run in utility processes; the packages that come with the application sit next to it and are offered for installation, never installed by themselves.
    plugins: {
      spawn: utilitySpawner,
      bundledDir: app.isPackaged ? path.join(process.resourcesPath, "plugins") : process.env.MANGA_PLUGINS_DIR || path.join(process.resourcesPath, "plugins"),
      ...(smoke && process.env.MANGA_SMOKE_PLUGIN_PUBLIC_KEY?.trim()
        ? { firstPartyKeys: [...FIRST_PARTY_KEYS, { publicKey: process.env.MANGA_SMOKE_PLUGIN_PUBLIC_KEY.trim(), label: "MANGA Smoke Ephemeral" }] }
        : {}),
    },
    // A packaged-window smoke that downloads keeps to the loopback address: no public DHT, no LAN discovery, no port mapping.
    // Danmaku: a release signs with the credentials built in; a smoke run never does, and talks only to the local fake server named by the harness (or to nothing).
    // The legacy-credentials phases open a Profile an earlier build saved its own DanDanPlay credentials into, and ask a Bangumi stand-in on the loopback address.
    ...(smoke ? { network: { allowPrivate: (host: string) => host === "127.0.0.1" } } : {}),
    ...(smoke && process.env.MANGA_SMOKE_BANGUMI_ORIGIN ? { bangumi: { apiOrigin: process.env.MANGA_SMOKE_BANGUMI_ORIGIN, allowedHosts: [new URL(process.env.MANGA_SMOKE_BANGUMI_ORIGIN).host], allowHttp: true, allowPrivate: true, maxRetries: 0, timeoutMs: 4000 } } : {}),
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
        // Light open runs the same executable the installer replaces: it is asked to keep its positions and leave first (4.6), and when it does not
        // within 10 seconds nothing is installed.
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
  // The library paths the user set up are scanned shortly after launch and then on the chosen interval (A-50); with none, nothing starts.
  appService.startScheduler();
}

/** A package that is missing a bundled tool stops here, saying which, instead of failing later in a recording or a video. */
function assetProblems(): string[] {
  if (!app.isPackaged) return [];
  return verifyBundledAssets(process.resourcesPath, { required: [...REQUIRED_ASSETS, ...PACKAGED_PLUGIN_ASSETS] }).problems;
}

if (!quitForUpdateFlag) app.whenReady().then(async () => {
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
  const hideWindow = smoke || process.env.MANGA_WINDOW_HIDDEN === "1";
  const windowIcon = windowIconPath();
  window = new BrowserWindow({
    width: productWindow.width,
    height: productWindow.height,
    minWidth: productWindow.minWidth,
    minHeight: productWindow.minHeight,
    ...(windowIcon ? { icon: windowIcon } : {}),
    show: !hideWindow,
    skipTaskbar: hideWindow,
    backgroundColor: productWindow.backgroundColor,
    titleBarStyle: productWindow.titleBarStyle,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Lets <video> expose its audio tracks so the player can switch them without re-muxing.
      enableBlinkFeatures: "AudioVideoTracks",
      // A hidden smoke window is throttled to about one frame per second; smoke runs keep real frames without needing to bring the window up.
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
  // A smoke run drives the page with its own input events (webContents.sendInputEvent). Once a walk shows the window, the person's real mouse moving
  // over it would mix real moves into a drag or a click and break it at random, so a smoke window lets the system's mouse pass through.
  if (smoke) window.setIgnoreMouseEvents(true);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const appUrl = rendererUrl();
  // The window stays on the app's own page; links open only through `manga:open-external`.
  window.webContents.on("will-navigate", (event, target) => { if (!isAppPage(target, appUrl)) event.preventDefault(); });
  // Only the microphone (audio), the font list and full screen are ever granted, and only to this window's own page.
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
      return saved?.overlay ?? {};
    },
    saveRect: (pos) => { void callOwner("settings.setRecording", { overlay: { x: pos.x, y: pos.y } }); },
    onStopRequest: () => { if (window && !window.isDestroyed()) window.webContents.send("manga:overlay-stop"); },
  });
  window.on("closed", () => overlay.close());
  // Before the window goes the page saves what waits for its save (LOOP-23, 计划 4.8): the close is held, the page is asked, and the window goes when it
  // answers or after SAVE_BEFORE_CLOSE_MS, whichever comes first, so a page that hangs cannot keep the window open. In Electron 44 the page is still
  // fully alive during `close` (it is unloaded only after the event is let through), so it can take and answer IPC. A quit closes the window the same way.
  let closeInFlight = false;
  let closingAfterUpdate = false;
  window.on("close", (event) => {
    if (closeInFlight || (preparingUpdate && !closingAfterUpdate)) { event.preventDefault(); return; }
    if (saved || !window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.isCrashed()) return;
    event.preventDefault();
    const closing = window;
    closeInFlight = true;
    void (async () => {
      try {
        // A ready update is prepared while the page can still acknowledge its saves.
        if (appService?.update.status().state === "ready" && !updateFixtureSmoke) {
          let installed = false;
          try {
            installed = await appService.update.installOnQuit();
          } catch (error) {
            // A light window that would not leave keeps the update for next time; quitting is not held up by it.
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
        if (!closing.isDestroyed()) {
          closing.setEnabled(true);
          await dialog.showMessageBox(closing, { type: "error", title: "无法准备更新", message: error instanceof Error ? error.message : "更新前保存或备份失败，已保留当前版本" });
        }
      }
    })();
  });
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
    const result = await appService.call(actor, payload, ownerGrant, createId("ui"));
    if (payload.commandId === "update.restartToUpdate" && result.status !== "ok") {
      saved = false;
      preparingUpdate = false;
      if (window && !window.isDestroyed()) window.setEnabled(true);
    }
    return result;
  });
  ipcMain.handle("manga:state", async (event) => {
    assertCaller(event);
    return {
      layout: appService ? appService.layout : layout,
      writable: layout.writable,
      vaultAvailable: await safeStorage.isAsyncEncryptionAvailable(),
      packaged: app.isPackaged,
      appVersion: appService ? appService.appVersion : app.getVersion(),
      buildInfo: appService ? appService.buildInfo : buildInfo,
    };
  });
  // The window's own buttons are drawn by the page (A-91): it asks for one of three actions, and is told when the window is maximized or restored,
  // whoever did it (the button, a double click on the top, Win+Up, dragging to the screen's edge).
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
  ipcMain.handle("manga:quit", (event) => {
    assertCaller(event);
    app.quit();
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
  ipcMain.handle("manga:pick", async (event, request: { mode: "file" | "directory"; filter?: "book" | "comic" | "video" | "subtitle" | "image" | "audio" | "package" | "plugin" | "torrent" | "any"; defaultPath?: string }) => {
    assertCaller(event);
    if (!window || !appService) return null;
    const filters: Record<string, Electron.FileFilter[]> = {
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
    let chosen: string | null | undefined;
    if (testHooks.pick) {
      chosen = testHooks.pick({ mode: request.mode });
      if (chosen === null) return null;
    }
    if (!chosen) {
      // The dialog opens where the page says (a library path, a folder to add); an absolute folder that exists, nothing else.
      const start = typeof request.defaultPath === "string" && path.isAbsolute(request.defaultPath) && fs.existsSync(request.defaultPath) ? request.defaultPath : undefined;
      const result = await dialog.showOpenDialog(window, request.mode === "directory"
        ? { properties: ["openDirectory"], defaultPath: start }
        : { properties: ["openFile"], filters: request.filter ? filters[request.filter] : undefined, defaultPath: start });
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
  writeRunningInstance("ready", smoke ? { justUpdated: appService?.update.status().justUpdated ?? null } : {});
  if (smoke && process.env.MANGA_SMOKE_PHASE === "update-driver") return;
  if (smoke) {
    try {
      const { runSmoke } = await import("./smoke/index.ts");
      await runSmoke({ appService, ownerGrant, window, layout, asrService });
    } catch (error) {
      console.error(error);
      app.exit(1);
    }
  }
});

app.on("before-quit", () => {
  asrService.dispose();
});

app.on("window-all-closed", () => {
  void (async () => {
    try {
      asrService.dispose();
      appService?.close();
    } finally {
      cleanupInstanceFiles();
      app.quit();
    }
  })();
});

