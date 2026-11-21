import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopOutput, devBuildRecord, latestDesktopPackage } from "../desktop-paths.ts";
import {
  CHANNEL_INSTALL,
  TEST_CHANNEL_INSTALL,
  compareRealInstallations,
  installMeta,
  snapshotRealInstallations,
} from "./installer-lib.mjs";
import { currentStage, loadGate, packagedFingerprintKeys, repoRoot, runDir, stageFingerprints } from "./lib.mjs";
import { readBuildInfoIfPresent } from "./version-lib.mjs";
import { isProcessAlive, readUninstallRegistryEntries } from "./win-process.mjs";
import { askLightToQuit, LIGHT_QUIT_WAIT_MS } from "../../apps/desktop/src/main/light-runtime.ts";

export { isProcessAlive };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The flag that starts the full app straight into the tray, with no window shown (A-135). */
export const BACKGROUND_FLAG = "--background";

/** Arguments for the app started after an install: the caller's, plus `--background` once when starting in the tray. */
export function launchArgsAfterInstall(args, background) {
  const list = [...(args ?? [])];
  if (background && !list.includes(BACKGROUND_FLAG)) list.push(BACKGROUND_FLAG);
  return list;
}

/** Quotes one argument for a Windows command line (CommandLineToArgvW rules). */
export function quoteWindowsArg(arg) {
  const text = String(arg);
  if (text !== "" && !/[\s"]/.test(text)) return text;
  let out = "\"";
  let slashes = 0;
  for (const ch of text) {
    if (ch === "\\") { slashes += 1; continue; }
    if (ch === "\"") { out += "\\".repeat(slashes * 2 + 1) + "\""; slashes = 0; continue; }
    out += "\\".repeat(slashes) + ch;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

// Node cannot ask for CREATE_BREAKAWAY_FROM_JOB, so a short PowerShell helper calls CreateProcessW. Inside an agent's command sandbox (a job
// object that ends its processes when the command returns) the started app leaves the job when the job allows it; a job that forbids breaking
// away gets the app started inside it, reported as `inJob` (A-135). The environment is inherited from this helper, which inherits `env`.
const LAUNCH_OUTSIDE_JOB_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$exe = $env:MANGA_LAUNCH_EXE; $line = $env:MANGA_LAUNCH_LINE; $dir = $env:MANGA_LAUNCH_DIR",
  "Remove-Item Env:MANGA_LAUNCH_EXE, Env:MANGA_LAUNCH_LINE, Env:MANGA_LAUNCH_DIR",
  "Add-Type -TypeDefinition @'",
  "using System; using System.Runtime.InteropServices; using System.Text;",
  "public static class MangaLaunchOutsideJob {",
  "  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo { public int cb; public string reserved, desktop, title;",
  "    public int x, y, xSize, ySize, xChars, yChars, fill, flags; public short show, reserved2Size; public IntPtr reserved2, stdIn, stdOut, stdErr; }",
  "  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr process, thread; public int processId, threadId; }",
  "  [DllImport(\"kernel32.dll\", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder line,",
  "    IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string dir, ref StartupInfo info, out ProcessInformation pi);",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);",
  "  [DllImport(\"kernel32.dll\")] static extern bool CloseHandle(IntPtr handle);",
  "  static bool Create(string exe, string line, string dir, uint flags, out ProcessInformation pi) {",
  "    var info = new StartupInfo(); info.cb = Marshal.SizeOf(typeof(StartupInfo));",
  "    return CreateProcessW(exe, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, dir, ref info, out pi); }",
  "  public static string Start(string exe, string line, string dir) {",
  "    const uint Detached = 0x8, NewGroup = 0x200, Breakaway = 0x01000000; ProcessInformation pi;",
  "    if (!Create(exe, line, dir, Detached | NewGroup | Breakaway, out pi)) {",
  "      int error = Marshal.GetLastWin32Error(); if (error != 5) throw new System.ComponentModel.Win32Exception(error);",
  "      if (!Create(exe, line, dir, Detached | NewGroup, out pi)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }",
  "    bool inJob; if (!IsProcessInJob(pi.process, IntPtr.Zero, out inJob)) inJob = false;",
  "    CloseHandle(pi.thread); CloseHandle(pi.process);",
  "    return \"{\\\"pid\\\":\" + pi.processId + \",\\\"inJob\\\":\" + (inJob ? \"true\" : \"false\") + \"}\"; } }",
  "'@",
  "[Console]::Out.Write([MangaLaunchOutsideJob]::Start($exe, $line, $dir))",
].join("\n");

/**
 * Starts `exe args` detached and, when allowed, outside the job object this command runs in, so the app keeps running after the command ends.
 * Returns `{ pid, inJob }`; `inJob: true` means the job forbade breaking away and the app may end with the command (A-135).
 */
export function launchOutsideJob(exe, args, env) {
  if (process.platform !== "win32") throw new Error("launching outside the job is Windows only");
  const line = [exe, ...args].map(quoteWindowsArg).join(" ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", LAUNCH_OUTSIDE_JOB_SCRIPT], {
    env: { ...env, MANGA_LAUNCH_EXE: exe, MANGA_LAUNCH_LINE: line, MANGA_LAUNCH_DIR: path.dirname(exe) },
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  const parsed = (() => { try { return JSON.parse(String(result.stdout ?? "").trim()); } catch { return null; } })();
  if (result.status !== 0 || !Number.isInteger(parsed?.pid)) {
    throw new Error(`could not start the development app (${String(result.stderr ?? "").trim().split("\n")[0] || `exit ${String(result.status)}`})`);
  }
  return { pid: parsed.pid, inJob: parsed.inJob === true };
}

export function readRunningInstance(runtimeDir) {
  const file = path.join(runtimeDir, "running-instance.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readUninstallEntries() {
  return readUninstallRegistryEntries({ timeoutMs: 20_000 });
}

/** The packaged directory the latest `stage package` made (`latest-package.json` `target`), or null. */
function defaultPackagedAppDir(recordFile = latestDesktopPackage) {
  try {
    const target = JSON.parse(fs.readFileSync(recordFile, "utf8")).target;
    const dir = typeof target === "string" ? path.resolve(repoRoot, target) : "";
    return dir && fs.existsSync(path.join(dir, "resources")) ? dir : null;
  } catch { return null; }
}

/** Whether two `resources` folders hold the same application archive (`app.asar`, compared by content). */
export function sameApplicationArchive(installedResources, packagedResources) {
  const digest = (file) => (fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : null);
  const installed = digest(path.join(installedResources, "app.asar"));
  return Boolean(installed) && installed === digest(path.join(packagedResources, "app.asar"));
}

/**
 * The development installer made from the current inputs: the one the last full package run made (`latest-package.json`), or else the one
 * `install-dev` built for itself (`dev-build.json`, see `buildDevInstaller`). Answers the file, its hash and the record it was found in.
 */
export function findDefaultDevInstaller({ testIdentity = false, fingerprints, latestFile = latestDesktopPackage, devFile = devBuildRecord, desktopRoot = desktopOutput, workspaceRoot = repoRoot } = {}) {
  for (const recordFile of [latestFile, devFile]) {
    if (!recordFile) continue;
    const found = devInstallerIn(recordFile, { testIdentity, fingerprints, desktopRoot, workspaceRoot });
    if (found) return { ...found, recordFile };
  }
  return null;
}

function devInstallerIn(latestFile, { testIdentity, fingerprints, desktopRoot, workspaceRoot }) {
  const suffix = testIdentity ? "development-test" : "development";
  const outDir = path.join(desktopRoot, "installer", `out-${suffix}`);
  try {
    const latest = JSON.parse(fs.readFileSync(latestFile, "utf8"));
    const installer = latest.installer;
    if (installer?.channel !== "development" || packagedFingerprintKeys().some((key) => !/^[0-9a-f]{64}$/.test(latest[key] ?? "") || latest[key] !== fingerprints?.[key])) return null;
    const file = path.resolve(workspaceRoot, installer.output);
    if (path.dirname(file).toLowerCase() !== path.resolve(outDir).toLowerCase() || !/^[0-9a-f]{64}$/.test(installer.sha256)
      || installer.version !== inferInstallerVersion(file) || !fs.lstatSync(file).isFile() || fs.statSync(file).size !== installer.bytes || installer.bytes <= 0) return null;
    return { file, sha256: installer.sha256 };
  } catch { return null; }
}

function runningDevProcesses(executable) {
  if (process.platform !== "win32") return [];
  const script = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $target = [IO.Path]::GetFullPath($env:MANGA_DEV_EXECUTABLE); @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -eq $target -and $_.CommandLine -notmatch '(?:^|\\s)--type=' } | ForEach-Object { [int]$_.ProcessId }) | ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, MANGA_DEV_EXECUTABLE: executable }, encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (result.status !== 0) throw new Error("unable to inspect the installed development process");
  const text = result.stdout.trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function inferInstallerVersion(installerPath) {
  if (!installerPath) return null;
  const base = path.basename(installerPath);
  const match = /^manga(?:-dev)?(?:-test)?-setup-(.+)\.exe$/i.exec(base);
  return match ? match[1] : null;
}

function snapshotIsolatedRelease(places) {
  if (!places) return null;
  const meta = TEST_CHANNEL_INSTALL.release;
  const installDir = path.join(places.programs, meta.dirName);
  const exePath = path.join(installDir, `${meta.executableName}.exe`);
  const exeStat = fs.existsSync(exePath) ? fs.statSync(exePath) : null;
  const buildInfo = readBuildInfoIfPresent(path.join(installDir, "resources"));
  const dataSqlite = path.join(places.local, meta.dirName, "data", "manga.sqlite");
  const sqliteStat = fs.existsSync(dataSqlite) ? fs.statSync(dataSqlite) : null;
  const running = readRunningInstance(path.join(places.local, meta.dirName, "runtime"));
  const runningPid = Number.isInteger(running?.pid) ? running.pid : null;
  return {
    exePresent: Boolean(exeStat),
    exeBytes: exeStat ? exeStat.size : null,
    exeMtimeMs: exeStat ? Math.trunc(exeStat.mtimeMs) : null,
    version: buildInfo?.version ?? null,
    sqlitePresent: Boolean(sqliteStat),
    sqliteBytes: sqliteStat ? sqliteStat.size : null,
    runningPid,
    runningAlive: runningPid ? isProcessAlive(runningPid) : false,
  };
}

function compareIsolatedRelease(before, after) {
  if (!before && !after) return { ok: true, changes: [] };
  const changes = [];
  for (const key of ["exePresent", "exeBytes", "exeMtimeMs", "version", "sqlitePresent", "sqliteBytes", "runningPid", "runningAlive"]) {
    if (before?.[key] !== after?.[key]) {
      changes.push(`isolated release ${key}: ${JSON.stringify(before?.[key])} -> ${JSON.stringify(after?.[key])}`);
    }
  }
  return { ok: changes.length === 0, changes };
}

/**
 * Automatic local update of the `development` channel (`node scripts/stage.mjs install-dev`, 计划 4.2, AT-158).
 *
 * Rules:
 * - Skips when `MANGA_DEV_AUTO_INSTALL=0` or on CI (`CI=true` / `GITHUB_ACTIONS=true`).
 * - Only touches the `development` channel (`MANGA Dev`, or `MANGA Dev Test` when `testIdentity: true`).
 * - Never installs, closes, or modifies the `release` channel (`MANGA` / `MANGA Test`).
 * - If the development channel is not installed, skips and records the reason in `install-dev.json`.
 * - If the development channel is running, requests graceful save-and-exit via `--quit-for-update` and waits up to `quitTimeoutMs` (default 30s).
 *   If it does not exit within `quitTimeoutMs`, aborts without force-killing (`taskkill` is never used).
 * - Silently installs the new development installer (`/S`) into the existing installation directory, verifies the installed version,
 *   and then starts the development app in the tray (`--background`) whether it was running or not, outside this command's job object when
 *   the job allows it (A-135: the person keeps the development build running). `background: false` (the default for the test identity the
 *   gate's rehearsals use) keeps the older rule: reopen it only if it was running, with the caller's arguments.
 */
export async function runInstallDev(options = {}) {
  const startedMs = Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const env = options.env ?? process.env;
  const testIdentity = options.testIdentity === true;
  const meta = installMeta("development", { testIdentity });
  const places = options.places ?? null;
  const quitTimeoutMs = options.quitTimeoutMs ?? 30_000;
  const relaunchReadyTimeoutMs = options.relaunchReadyTimeoutMs ?? 30_000;
  const background = options.background ?? !testIdentity;

  let stage = "unknown";
  let fingerprints = {};
  try {
    stage = currentStage();
    fingerprints = stageFingerprints(repoRoot, loadGate());
  } catch {
    // allow running in isolated unit tests
  }

  const realBefore = snapshotRealInstallations({
    channels: ["release"],
    ...(options.snapshotOptions ?? {}),
  });
  const isolatedReleaseBefore = snapshotIsolatedRelease(places);

  const defaultInstaller = options.installerPath ? null : findDefaultDevInstaller({ testIdentity, fingerprints });
  const installerPath = options.installerPath ?? defaultInstaller?.file;
  const expectedSha256 = options.expectedSha256 ?? defaultInstaller?.sha256;
  const expectedNewVersion = options.newVersion ?? inferInstallerVersion(installerPath) ?? null;

  const finalize = (payload, extraMemory = {}) => {
    const realAfter = snapshotRealInstallations({
      channels: ["release"],
      ...(options.snapshotOptions ?? {}),
    });
    const isolatedReleaseAfter = snapshotIsolatedRelease(places);
    const realDiff = compareRealInstallations(realBefore, realAfter, { channels: ["release"] });
    const isolatedDiff = compareIsolatedRelease(isolatedReleaseBefore, isolatedReleaseAfter);
    const releaseUntouched = realDiff.ok && isolatedDiff.ok;
    const releaseChanges = [...realDiff.changes, ...isolatedDiff.changes];

    const record = {
      status: releaseUntouched ? payload.status : "failed",
      stage,
      ...fingerprints,
      at: startedAt,
      channel: "development",
      productName: meta.productName,
      testIdentity,
      installed: Boolean(payload.installed),
      wasRunning: Boolean(payload.wasRunning),
      relaunched: Boolean(payload.relaunched),
      background,
      ...(payload.inJob !== undefined ? { inJob: Boolean(payload.inJob) } : {}),
      previousVersion: payload.previousVersion ?? null,
      newVersion: payload.newVersion ?? expectedNewVersion ?? null,
      seconds: Number(((Date.now() - startedMs) / 1000).toFixed(2)),
      releaseUntouched,
      ...(payload.skipReason ? { skipReason: payload.skipReason } : {}),
      ...(payload.reason ? { reason: payload.reason } : {}),
      ...(releaseChanges.length > 0 ? { releaseChanges } : {}),
      ...(payload.draftPreserved !== undefined ? { draftPreserved: payload.draftPreserved } : {}),
      ...(payload.recoveryVersion ? { recoveryVersion: payload.recoveryVersion } : {}),
    };

    const outPath = options.outputFile
      ?? (options.evidenceDir === null ? null : path.join(options.evidenceDir ?? runDir(), "install-dev.json"));
    if (outPath) {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    }
    return { ...record, ...extraMemory };
  };

  if (options.autoInstall === false || env.MANGA_DEV_AUTO_INSTALL === "0") {
    return finalize({
      status: "skipped",
      installed: false,
      wasRunning: false,
      relaunched: false,
      previousVersion: null,
      newVersion: expectedNewVersion,
      skipReason: "MANGA_DEV_AUTO_INSTALL=0",
    });
  }

  if (options.ci === true || env.CI === "true" || env.GITHUB_ACTIONS === "true") {
    return finalize({
      status: "skipped",
      installed: false,
      wasRunning: false,
      relaunched: false,
      previousVersion: null,
      newVersion: expectedNewVersion,
      skipReason: "CI environment",
    });
  }

  const entries = options.registryEntries ?? readUninstallEntries();
  const entry = entries.find((item) => item.DisplayName === meta.productName) ?? null;
  const candidateInstallDir = options.installDir
    ?? entry?.InstallLocation
    ?? (places?.programs ? path.join(places.programs, meta.dirName) : "");
  const installedDevExe = candidateInstallDir ? path.join(candidateInstallDir, `${meta.executableName}.exe`) : "";
  const isInstalled = testIdentity
    ? Boolean(candidateInstallDir && fs.existsSync(installedDevExe) && (entry || options.installDir || places?.programs))
    : Boolean(entry && candidateInstallDir && fs.existsSync(installedDevExe));

  if (!isInstalled) {
    return finalize({
      status: "skipped",
      installed: false,
      wasRunning: false,
      relaunched: false,
      previousVersion: null,
      newVersion: expectedNewVersion,
      skipReason: "development channel is not installed",
    });
  }

  const beforeBuild = readBuildInfoIfPresent(path.join(candidateInstallDir, "resources"));
  const previousVersion = beforeBuild?.version ?? (entry?.DisplayVersion || null);
  if (beforeBuild?.channel !== "development") return finalize({ status: "failed", previousVersion, reason: "installed development build metadata is missing or belongs to another channel" });
  if (!installerPath || !fs.existsSync(installerPath)) {
    return finalize({
      status: "failed",
      installed: false,
      wasRunning: false,
      relaunched: false,
      previousVersion,
      newVersion: expectedNewVersion,
      reason: "current development installer is missing or stale and could not be built",
    });
  }
  const devPattern = /^0\.1\.(\d+)-dev\.(\d{12})$/;
  const previousParts = devPattern.exec(previousVersion ?? "");
  const nextParts = devPattern.exec(expectedNewVersion ?? "");
  if (!nextParts || (previousParts && (Number(nextParts[1]) < Number(previousParts[1]) || (nextParts[1] === previousParts[1] && nextParts[2] < previousParts[2])))) {
    return finalize({ status: "failed", previousVersion, reason: "development installer version is invalid or older than the installed version" });
  }
  // The installed build is already this one (same version and the same application archive as the packaged directory the installer was made
  // from): nothing to install, and the running development app is not asked to quit for nothing. The packaged directory is known for the installer
  // install-dev finds itself (the latest package); a caller that names another installer names its directory too, or nothing is skipped.
  const packagedAppDir = options.packagedAppDir !== undefined ? options.packagedAppDir : options.installerPath ? null : defaultPackagedAppDir(defaultInstaller?.recordFile);
  if (previousVersion === expectedNewVersion && packagedAppDir && sameApplicationArchive(path.join(candidateInstallDir, "resources"), path.join(packagedAppDir, "resources"))) {
    return finalize({ status: "skipped", previousVersion, newVersion: expectedNewVersion, skipReason: "this build is already installed" });
  }
  const installerHash = () => createHash("sha256").update(fs.readFileSync(installerPath)).digest("hex");
  if (expectedSha256 && installerHash() !== expectedSha256) return finalize({ status: "failed", previousVersion, reason: "development installer changed after packaging" });

  const localAppData = places?.local ?? env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const devRuntimeDir = path.join(localAppData, meta.dirName, "runtime");
  const targetEnv = {
    ...env,
    ...(places?.local ? { LOCALAPPDATA: places.local } : {}),
    ...(places?.documents ? { MANGA_DOCUMENTS_DIR: places.documents } : {}),
    ...(places?.downloads ? { MANGA_DOWNLOADS_DIR: places.downloads } : {}),
    ...(options.relaunchEnv ?? {}),
  };
  for (const key of ["MANGA_PROFILE_ROOT", "MANGA_POINTER_FILE", "MANGA_CHANNEL", "NODE_ENV", "ELECTRON_RUN_AS_NODE"]) {
    if (!(options.relaunchEnv && key in options.relaunchEnv)) {
      delete targetEnv[key];
    }
  }

  // Light open runs the same executable: it keeps its positions and leaves first (4.6, within 10 seconds), or nothing is installed.
  const lightRuntimeDir = path.join(localAppData, meta.dirName, "light", "runtime");
  const light = await (options.askLightToQuitFn ?? askLightToQuit)(lightRuntimeDir, { timeoutMs: options.lightQuitTimeoutMs ?? LIGHT_QUIT_WAIT_MS });
  if (!light.ok) {
    return finalize({ status: "aborted", wasRunning: false, previousVersion, newVersion: expectedNewVersion, reason: "请先关闭轻量播放窗口 (light open did not leave within 10s; nothing was installed)" });
  }

  const runningInstance = readRunningInstance(devRuntimeDir);
  const runningPid = options.runningPid ?? (Number.isInteger(runningInstance?.pid) ? runningInstance.pid : null);
  const checkAlive = options.isProcessAliveFn ?? isProcessAlive;
  const wasRunning = Boolean(runningPid && checkAlive(runningPid));

  if (!options.runningPid && wasRunning && (!runningInstance?.execPath || runningInstance.channel !== "development" || Boolean(runningInstance.testIdentity) !== testIdentity || path.resolve(runningInstance.execPath).toLowerCase() !== path.resolve(installedDevExe).toLowerCase())) {
    return finalize({ status: "aborted", wasRunning: true, previousVersion, reason: "running instance does not belong to the installed development executable" });
  }
  if (!options.runningPid && !wasRunning && (options.runningProcessesFn ?? runningDevProcesses)(installedDevExe).length > 0) {
    return finalize({ status: "aborted", wasRunning: true, previousVersion, reason: "running development build has no graceful-update handshake; close it before running install-dev" });
  }

  const requestId = randomUUID();
  const lockFile = path.join(devRuntimeDir, "install-dev.lock");
  const quitFile = path.join(devRuntimeDir, "quit-for-update.json");
  const withdrawRequest = () => {
    try {
      if (JSON.parse(fs.readFileSync(quitFile, "utf8")).requestId === requestId) fs.rmSync(quitFile, { force: true });
    } catch { /* already removed by the desktop */ }
    try { fs.rmSync(path.join(devRuntimeDir, "quit-for-update-ack.json"), { force: true }); } catch { /* ignore */ }
  };
  try {
    fs.mkdirSync(devRuntimeDir, { recursive: true });
    if (fs.existsSync(lockFile)) {
      let prior = null;
      try {
        prior = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      } catch {
        // Corrupt or truncated lock file from an aborted run: treat as stale and replace it.
      }
      if (isProcessAlive(prior?.pid)) return finalize({ status: "aborted", wasRunning, previousVersion, reason: "another development installation is already in progress" });
      fs.rmSync(lockFile, { force: true });
    }
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, requestId }), { flag: "wx" });
  } catch {
    return finalize({ status: "failed", wasRunning, previousVersion, reason: "could not acquire the development installation lock" });
  }

  const relaunchDevelopment = async (expectedVersion) => {
    let relaunched = false;
    let relaunchedPid = null;
    let draftPreserved;
    let inJob;
    const launchArgs = launchArgsAfterInstall(options.relaunchArgs, background);
    for (const signalFile of ["quit-for-update.json", "quit-for-update-ack.json", "running-instance.json"]) {
      try { fs.rmSync(path.join(devRuntimeDir, signalFile), { force: true }); } catch { /* ignore */ }
    }
    const relaunchEnv = { ...targetEnv };
    delete relaunchEnv.MANGA_HOLD_WRITE_MS;

    if (options.relaunchFn) {
      const custom = await options.relaunchFn({
        exePath: installedDevExe,
        args: launchArgs,
        env: relaunchEnv,
        runtimeDir: devRuntimeDir,
        background,
      });
      relaunched = custom?.relaunched === true;
      relaunchedPid = custom?.pid ?? null;
      draftPreserved = custom?.draftPreserved;
      if (background) inJob = custom?.inJob === true;
    } else if (background) {
      let launched;
      try {
        launched = (options.launchOutsideJobFn ?? launchOutsideJob)(installedDevExe, launchArgs, relaunchEnv);
      } catch {
        return { relaunched: false, relaunchedPid: null };
      }
      relaunchedPid = launched.pid;
      inJob = launched.inJob;
    } else {
      const child = spawn(installedDevExe, launchArgs, {
        env: relaunchEnv,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      const started = await new Promise((resolve) => {
        child.once("spawn", () => resolve(true));
        child.once("error", () => resolve(false));
      });
      child.unref();
      if (!started) return { relaunched: false, relaunchedPid: null };
      relaunchedPid = child.pid ?? null;
    }
    if (!options.relaunchFn) {
      // Ready means the new build wrote its running-instance record; in the tray it has no window to show.
      const relaunchDeadline = Date.now() + relaunchReadyTimeoutMs;
      while (Date.now() < relaunchDeadline) {
        const info = readRunningInstance(devRuntimeDir);
        if (info && info.state === "ready" && info.pid && checkAlive(info.pid) && info.version === expectedVersion && info.channel === "development" && Boolean(info.testIdentity) === testIdentity && info.execPath && path.resolve(info.execPath).toLowerCase() === path.resolve(installedDevExe).toLowerCase()) {
          relaunched = true;
          relaunchedPid = info.pid;
          if (info.noteDrafts && typeof info.noteDrafts === "object") {
            const drafts = Object.values(info.noteDrafts);
            if (drafts.length > 0) {
              draftPreserved = drafts.some((d) => d && typeof d === "object" && Array.isArray(d.blocks) && d.blocks.length > 0);
            }
          }
          break;
        }
        await sleep(150);
      }
    }
    return { relaunched, relaunchedPid, draftPreserved, inJob };
  };
  const failAndRecover = async (payload) => {
    withdrawRequest();
    const current = readBuildInfoIfPresent(path.join(candidateInstallDir, "resources"));
    const active = readRunningInstance(devRuntimeDir);
    if (wasRunning && runningPid && !checkAlive(runningPid) && !(active?.pid && checkAlive(active.pid))
      && current?.channel === "development" && fs.existsSync(installedDevExe)) {
      try {
        const recovered = await relaunchDevelopment(current.version);
        return finalize({ ...payload, relaunched: recovered.relaunched, recoveryVersion: current.version }, { relaunchedPid: recovered.relaunchedPid });
      } catch { /* retain the original installation failure in the evidence */ }
    }
    return finalize(payload);
  };

  try {

    if (wasRunning && runningPid) {
      const waitDeadline = Date.now() + quitTimeoutMs;
      try {
        fs.mkdirSync(devRuntimeDir, { recursive: true });
        const requestPart = `${quitFile}.${requestId}.part`;
        fs.writeFileSync(
          requestPart,
          `${JSON.stringify({
            requestedAt: new Date().toISOString(),
            pid: process.pid,
            channel: "development",
            testIdentity,
            requestId,
            expiresAt: waitDeadline,
          })}\n`,
        );
        fs.renameSync(requestPart, quitFile);
      } catch {
        return finalize({ status: "failed", wasRunning, previousVersion, reason: "could not write the graceful quit request" });
      }

      if (options.requestQuitFn) {
        await options.requestQuitFn({
          exePath: installedDevExe,
          pid: runningPid,
          runtimeDir: devRuntimeDir,
          env: { ...targetEnv, MANGA_DEV_QUIT_REQUEST_ID: requestId },
        });
      } else {
        const requested = spawnSync(installedDevExe, ["--quit-for-update"], {
          env: { ...targetEnv, MANGA_DEV_QUIT_REQUEST_ID: requestId },
          windowsHide: true,
          timeout: 15_000,
        });
        if (requested.status !== 0) {
          withdrawRequest();
          return await failAndRecover({ status: "failed", wasRunning, previousVersion, reason: "development quit helper failed; installation was cancelled" });
        }
      }

      let exited = !checkAlive(runningPid);
      while (!exited && Date.now() < waitDeadline) {
        await sleep(100);
        exited = !checkAlive(runningPid);
      }

      if (!exited) {
        // Withdraw the request. The main process observes this and must not close after its write barrier releases.
        withdrawRequest();
        // Never force-kill: leave the running development instance alive and abort this update (计划 4.2, AT-158).
        return finalize(
          {
            status: "aborted",
            installed: false,
            wasRunning: true,
            relaunched: false,
            previousVersion,
            newVersion: expectedNewVersion,
            reason: `running development instance did not exit within ${Math.round(quitTimeoutMs / 1000)}s timeout; aborted without force-killing`,
          },
          { abortedPidStillAlive: checkAlive(runningPid) },
        );
      }
    }

    // Silent install into the existing installation directory (`/S /D=<installDir>`).
    if (expectedSha256 && installerHash() !== expectedSha256) return await failAndRecover({ status: "failed", wasRunning, previousVersion, reason: "development installer changed before execution" });
    const arrived = readRunningInstance(devRuntimeDir);
    if (!options.runningPid && arrived?.pid && checkAlive(arrived.pid)) return finalize({ status: "aborted", wasRunning: true, previousVersion, reason: "a development instance opened before installation; installation was cancelled" });
    const installArgs = ["/S", `/D=${candidateInstallDir}`];
    const installResult = options.spawnInstallerFn
      ? await options.spawnInstallerFn(installerPath, installArgs, candidateInstallDir)
      : spawnSync(installerPath, installArgs, { windowsHide: true, timeout: 300_000 });

    if ((installResult?.status ?? 1) !== 0) {
      return await failAndRecover({
        status: "failed",
        installed: false,
        wasRunning,
        relaunched: false,
        previousVersion,
        newVersion: expectedNewVersion,
        reason: `silent installer exited with status ${String(installResult?.status ?? 1)}`,
      });
    }

    const afterBuild = readBuildInfoIfPresent(path.join(candidateInstallDir, "resources"));
    const installedVersion = afterBuild?.version ?? null;
    if (!installedVersion || afterBuild.channel !== "development" || !fs.existsSync(installedDevExe) || (expectedNewVersion && installedVersion !== expectedNewVersion)) {
      return await failAndRecover({
        status: "failed",
        installed: false,
        wasRunning,
        relaunched: false,
        previousVersion,
        newVersion: installedVersion,
        reason: `installed version (${String(installedVersion)}) does not match expected version (${expectedNewVersion})`,
      });
    }

    const startAfter = wasRunning || background;
    const { relaunched, relaunchedPid, draftPreserved, inJob } = startAfter
      ? await relaunchDevelopment(installedVersion) : { relaunched: false, relaunchedPid: null };

    return finalize(
      {
        status: startAfter && !relaunched ? "failed" : "passed",
        installed: true,
        wasRunning,
        relaunched,
        inJob,
        previousVersion,
        newVersion: installedVersion,
        ...(startAfter && !relaunched ? { reason: "updated development instance did not become ready" } : {}),
        ...(draftPreserved !== undefined ? { draftPreserved } : {}),
      },
      { relaunchedPid },
    );
  } catch {
    withdrawRequest();
    return await failAndRecover({ status: "failed", wasRunning, previousVersion, reason: "development installation or relaunch failed" });
  } finally {
    withdrawRequest();
    try { fs.rmSync(`${quitFile}.${requestId}.part`, { force: true }); } catch { /* ignore */ }
    try {
      if (JSON.parse(fs.readFileSync(lockFile, "utf8")).requestId === requestId) fs.rmSync(lockFile, { force: true });
    } catch { /* ignore */ }
  }
}

/**
 * Builds the development installer from the current source when there is none yet (`stage package` with `MANGA_PACKAGE_BUILD_ONLY=1`): the package
 * (reused when its inputs are unchanged) and the installer, with no walks and no gate. Installing for the person's manual check does not wait for a gate
 * (development-workflow); the gate checks the same source on its own. Answers whether a build ran and whether it worked.
 */
export function buildDevInstaller({ env = process.env } = {}) {
  if (env.MANGA_DEV_AUTO_INSTALL === "0" || env.CI === "true" || env.GITHUB_ACTIONS === "true") return { built: false, ok: true };
  let fingerprints = {};
  try { fingerprints = stageFingerprints(repoRoot, loadGate()); } catch { return { built: false, ok: true }; }
  if (findDefaultDevInstaller({ fingerprints })) return { built: false, ok: true };
  console.log("[install-dev] no development installer for the current source yet: building the package and the installer (no walks)");
  const result = spawnSync(process.execPath, ["scripts/stage/package.mjs"], { cwd: repoRoot, stdio: "inherit", env: { ...env, MANGA_PACKAGE_BUILD_ONLY: "1", MANGA_PACKAGE_PHASES: "" } });
  return { built: true, ok: result.status === 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const build = buildDevInstaller();
  if (!build.ok) console.log("[install-dev] building the development installer failed; see the output above");
  const result = await runInstallDev();
  const { relaunchedPid: _pid, abortedPidStillAlive: _alive, ...publicSummary } = result;
  console.log(JSON.stringify({ check: "stage-install-dev", ...publicSummary }));
  if (result.inJob) {
    console.log(`[install-dev] ${result.productName} ${String(result.newVersion)} started inside this command's job object and may end with the command; open it once from the Start menu`);
  }
  if (result.status === "failed" || result.status === "aborted") {
    process.exitCode = 1;
  }
}
