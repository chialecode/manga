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
import { readBuildInfoIfPresent, readGitShortCommit } from "./version-lib.mjs";
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
// With `viaDesktopShell`, a helper that runs inside a job first asks the desktop shell (explorer.exe, Shell.Application of the desktop window)
// to start the app: it is then explorer's child, in no job of this command even when the job forbids breaking away, and it has the shell's
// environment instead of `env`. The helper waits up to 15 s for the new process of that executable (preferring a child of %SystemRoot%\explorer.exe
// whose parent is not the same executable).
const LAUNCH_OUTSIDE_JOB_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$exe = $env:MANGA_LAUNCH_EXE; $line = $env:MANGA_LAUNCH_LINE; $dir = $env:MANGA_LAUNCH_DIR; $params = [string]$env:MANGA_LAUNCH_PARAMS; $viaShell = $env:MANGA_LAUNCH_VIA_SHELL -eq '1'",
  "Remove-Item Env:MANGA_LAUNCH_EXE, Env:MANGA_LAUNCH_LINE, Env:MANGA_LAUNCH_DIR, Env:MANGA_LAUNCH_PARAMS, Env:MANGA_LAUNCH_VIA_SHELL -ErrorAction SilentlyContinue",
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
  "  [DllImport(\"kernel32.dll\")] static extern IntPtr GetCurrentProcess();",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int processId);",
  "  public static bool SelfInJob() { bool inJob; return IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out inJob) && inJob; }",
  "  public static bool InJob(int processId) { IntPtr handle = OpenProcess(0x1000, false, processId); if (handle == IntPtr.Zero) return false;",
  "    bool inJob; bool ok = IsProcessInJob(handle, IntPtr.Zero, out inJob); CloseHandle(handle); return ok && inJob; }",
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
  "if ($viaShell -and (Test-Path -LiteralPath $exe -PathType Leaf) -and [MangaLaunchOutsideJob]::SelfInJob()) {",
  "  $started = $null",
  "  $sysRoot = if ($env:SystemRoot) { $env:SystemRoot } elseif ($env:WINDIR) { $env:WINDIR } else { [Environment]::GetFolderPath('Windows') }",
  "  $explorerExe = if ($sysRoot) { [IO.Path]::GetFullPath((Join-Path $sysRoot 'explorer.exe')) } else { '' }",
  "  function Get-Explorers { $map = @{}; if ($explorerExe) { foreach ($p in @(Get-CimInstance Win32_Process -Filter \"Name='explorer.exe'\")) { if ($p.ExecutablePath -and [string]::Equals([IO.Path]::GetFullPath($p.ExecutablePath), $explorerExe, [StringComparison]::OrdinalIgnoreCase)) { $map[[int]$p.ProcessId] = $p.ExecutablePath } } }; return $map }",
  "  try {",
  "    $name = [IO.Path]::GetFileName($exe).Replace(\"'\", \"''\")",
  "    function Get-Same { @(Get-CimInstance Win32_Process -Filter \"Name='$name'\" | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $exe, [StringComparison]::OrdinalIgnoreCase) }) }",
  "    $before = @{}; foreach ($p in Get-Same) { $before[[int]$p.ProcessId] = $true }",
  "    $exp = Get-Explorers",
  "    $f = [Reflection.BindingFlags]; $m = [Reflection.Missing]::Value",
  "    $t = [Type]::GetTypeFromCLSID([Guid]'9BA05972-F6A8-11CF-A442-00A0C90A8F39'); $sw = [Activator]::CreateInstance($t)",
  "    $d = $t.InvokeMember('FindWindowSW', $f::InvokeMethod, $null, $sw, @($m, $m, 8, 0, 1))",
  "    if ($null -ne $d) {",
  "      $doc = $d.GetType().InvokeMember('Document', $f::GetProperty, $null, $d, $null)",
  "      $app = $doc.GetType().InvokeMember('Application', $f::GetProperty, $null, $doc, $null)",
  "      [void]$app.GetType().InvokeMember('ShellExecute', $f::InvokeMethod, $null, $app, @($exe, $params, $dir, 'open', 1))",
  "      $deadline = (Get-Date).AddSeconds(15)",
  "      while ($null -eq $started -and (Get-Date) -lt $deadline) {",
  "        $now = Get-Same; $ids = @{}; foreach ($p in $now) { $ids[[int]$p.ProcessId] = $true }",
  "        $cand = @($now | Where-Object { -not $before.ContainsKey([int]$_.ProcessId) -and -not $ids.ContainsKey([int]$_.ParentProcessId) })",
  "        $started = @($cand | Where-Object { $exp.ContainsKey([int]$_.ParentProcessId) }) | Select-Object -First 1",
  "        if ($null -eq $started) { $started = $cand | Select-Object -First 1 }",
  "        if ($null -eq $started) { Start-Sleep -Milliseconds 200 }",
  "      }",
  "    }",
  "  } catch { $started = $null }",
  "  if ($null -ne $started) {",
  "    $startedId = [int]$started.ProcessId; $parentId = [int]$started.ParentProcessId",
  "    $live = @(Get-CimInstance Win32_Process -Filter \"ProcessId=$startedId\" | Select-Object -First 1)",
  "    $liveParent = if ($live.Count -gt 0) { [int]$live[0].ParentProcessId } else { $null }",
  "    $expAfter = Get-Explorers",
  "    $parentPath = if ($expAfter.ContainsKey($parentId)) { $expAfter[$parentId] } else { '' }",
  "    $rawInJob = [MangaLaunchOutsideJob]::InJob($startedId)",
  "    function Esc([string]$s) { if ($null -eq $s) { return '' }; return $s.Replace('\\', '\\\\').Replace('\"', '\\\"') }",
  "    $liveJson = if ($null -eq $liveParent) { 'null' } else { [string]$liveParent }",
  "    $rawJson = if ($rawInJob) { 'true' } else { 'false' }",
  "    [Console]::Out.Write('{\"pid\":' + $startedId + ',\"ppid\":' + $parentId + ',\"livePpid\":' + $liveJson + ',\"selfPid\":' + $PID + ',\"parentExecutablePath\":\"' + (Esc $parentPath) + '\",\"systemRoot\":\"' + (Esc $sysRoot) + '\",\"rawInJob\":' + $rawJson + ',\"viaShell\":true}'); exit 0",
  "  }",
  "}",
  "[Console]::Out.Write([MangaLaunchOutsideJob]::Start($exe, $line, $dir))",
].join("\n");

/** Whether `executablePath` is `%SystemRoot%\explorer.exe` (case-insensitive). */
export function isExplorerExecutable(executablePath, systemRoot = process.env.SystemRoot || process.env.WINDIR || "") {
  const candidate = String(executablePath ?? "").trim();
  const root = String(systemRoot ?? "").trim();
  if (!candidate || !root) return false;
  return path.win32.normalize(candidate).toLowerCase() === path.win32.normalize(path.win32.join(root, "explorer.exe")).toLowerCase();
}

/**
 * Resolves `{ pid, inJob, viaShell, parentIsExplorer }` for a desktop-shell launch.
 * On Windows 10/11, `explorer.exe` / PCA routinely assigns GUI apps started via ShellExecute to a system
 * shell job object, causing raw `IsProcessInJob(handle, NULL)` to false-positive even though the process
 * is explorer's child and not in this command's job. Confirming `%SystemRoot%\explorer.exe` as the parent
 * reports `inJob: false`; otherwise falls back conservatively to `rawInJob` without launching a second copy.
 */
export function resolveDesktopShellLaunch(input) {
  const pid = Number(input.pid);
  const ppid = Number(input.ppid ?? 0);
  const selfPid = Number(input.selfPid ?? 0);
  const livePpid = input.livePpid === undefined || input.livePpid === null ? ppid : Number(input.livePpid);
  const parentIsExplorer = Number.isInteger(pid)
    && pid > 0
    && Number.isInteger(ppid)
    && ppid > 0
    && livePpid === ppid
    && ppid !== selfPid
    && ppid !== pid
    && isExplorerExecutable(input.parentExecutablePath, input.systemRoot);
  return {
    pid,
    inJob: parentIsExplorer ? false : input.rawInJob === true,
    viaShell: true,
    parentIsExplorer,
  };
}

/**
 * Starts `exe args` detached and, when allowed, outside the job object this command runs in, so the app keeps running after the command ends.
 * With `viaDesktopShell` and this command inside a job, the desktop shell starts it first (it then has the shell's environment, not `env`).
 * Returns `{ pid, inJob, viaShell }`; `inJob: true` means the app could not leave the job and may end with the command (A-135).
 */
export function launchOutsideJob(exe, args, env, { viaDesktopShell = false } = {}) {
  if (process.platform !== "win32") throw new Error("launching outside the job is Windows only");
  const line = [exe, ...args].map(quoteWindowsArg).join(" ");
  const params = args.map(quoteWindowsArg).join(" ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Sta", "-ExecutionPolicy", "Bypass", "-Command", LAUNCH_OUTSIDE_JOB_SCRIPT], {
    env: { ...env, MANGA_LAUNCH_EXE: exe, MANGA_LAUNCH_LINE: line, MANGA_LAUNCH_DIR: path.dirname(exe), MANGA_LAUNCH_PARAMS: params, MANGA_LAUNCH_VIA_SHELL: viaDesktopShell ? "1" : "0" },
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
  const parsed = (() => { try { return JSON.parse(String(result.stdout ?? "").trim()); } catch { return null; } })();
  if (result.status !== 0 || !Number.isInteger(parsed?.pid)) {
    throw new Error(`could not start the development app (${String(result.stderr ?? "").trim().split("\n")[0] || `exit ${String(result.status)}`})`);
  }
  if (parsed.viaShell === true) {
    const resolved = resolveDesktopShellLaunch(parsed);
    return { pid: resolved.pid, inJob: resolved.inJob, viaShell: true };
  }
  return { pid: parsed.pid, inJob: parsed.inJob === true, viaShell: false };
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
  return readUninstallRegistryEntries({ throwOnError: true, timeoutMs: 20_000 });
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
 * The installation folder as `install-dev.json` records it. The receipt is published evidence, so it never holds a machine path: a folder under
 * the Programs folder is written from there (`%LOCALAPPDATA%\Programs\manga-dev`, or `<programs>\...` for the gate's own folders), any
 * other folder by its name only.
 */
export function receiptLocation(dir, programsRoot, programsLabel) {
  const relative = path.relative(programsRoot, dir);
  if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) return `${programsLabel}\\${relative}`;
  return `...\\${path.basename(dir)}`;
}

/** How `install-dev` waits while MANGA Dev shows a window (A-139): a check every 2 seconds, up to 10 minutes, then this build is skipped. */
export const WINDOW_POLL_MS = 2_000;
export const WINDOW_WAIT_MS = 10 * 60_000;

/**
 * Whether a process of `executable` (full path) shows a window the person can see: the process's main window as .NET finds it, the first
 * visible top-level window without an owner. A minimized window counts; a window hidden to the tray is not visible and does not.
 */
export function devWindowOpen(executable) {
  if (process.platform !== "win32") return false;
  const script = "$target = [IO.Path]::GetFullPath($env:MANGA_DEV_EXECUTABLE); $name = [IO.Path]::GetFileNameWithoutExtension($target); $open = @(Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.Path -and [string]::Equals([IO.Path]::GetFullPath($_.Path), $target, [StringComparison]::OrdinalIgnoreCase) -and $_.MainWindowHandle -ne [IntPtr]::Zero }).Count; [Console]::Out.Write($open)";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, MANGA_DEV_EXECUTABLE: executable }, encoding: "utf8", windowsHide: true, timeout: 20_000 });
  const count = Number(String(result.stdout ?? "").trim());
  if (result.status !== 0 || String(result.stdout ?? "").trim() === "" || !Number.isInteger(count)) throw new Error("unable to inspect the development app's windows");
  return count > 0;
}

/** Read the current Git branch name in `cwd`, or null when unavailable or on a detached HEAD. */
export function readGitBranch(cwd = repoRoot) {
  try {
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10_000,
    });
    const branch = typeof result.stdout === "string" ? result.stdout.trim() : "";
    return result.status === 0 && branch.length > 0 && branch !== "HEAD" ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Automatic local update of the `development` channel (`node scripts/stage.mjs install-dev`, 计划 4.2, AT-158, A-139, A-140).
 *
 * Rules:
 * - Works on both PR branches (before asking the user to review/merge a PR) and `main` (to keep `main` synced after merge).
 * - Skips when `MANGA_DEV_AUTO_INSTALL=0` or on CI (`CI=true` / `GITHUB_ACTIONS=true`).
 * - Only touches the `development` channel (`MANGA Dev`, or `MANGA Dev Test` when `testIdentity: true`), found by its uninstall entry
 *   `io.github.chialecode.<identity>`; never installs, closes, or modifies the `release` channel (`MANGA` / `MANGA Test`).
 * - Not installed yet: installs it the first time too, silently into the default folder (`%LOCALAPPDATA%\Programs\manga-dev`).
 * - A window of the installed development app the person can see (minimized included, hidden to the tray not): waits for it, checking every
 *   2 seconds for up to 10 minutes, then skips this build (`reason: "window_open"`, not a failure).
 * - Running (in the tray, or after its window closed): requests graceful save-and-exit via `--quit-for-update` and waits up to `quitTimeoutMs`
 *   (default 30s). If it does not exit within `quitTimeoutMs`, aborts without force-killing (`taskkill` is never used).
 * - Silently installs the new development installer (`/S`) into the installation directory, verifies the installed version, and then starts
 *   the development app in the tray (`--background`) whether it was running or not, outside this command's job object when the job allows it
 *   (A-135: the person keeps the development build running). `background: false` (the default for the test identity the gate's rehearsals use)
 *   keeps the older rule: reopen it only if it was running, with the caller's arguments.
 * - Writes `install-dev.json` with the camelCase fields the author's desktop apps share (`identity`, `installed`, `skipped`, `reason`, `error`,
 *   `guidance`, `firstInstall`, `oldVersion`, `newVersion`, `installLocation`, `wasRunning`, `windowOpen`, `deferred`, `deferMs`, `quitMs`,
 *   `relaunched`, `background`, `inJob`, `elapsedMs`, `at`) and MANGA's own (`status`, the stage and its fingerprints, `channel`,
 *   `productName`, `testIdentity`, `branch`, `commit`, `viaShell`, `releaseUntouched`, `releaseChanges`, `draftPreserved`, `recoveryVersion`). `reason` is a code.
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
  const windowWaitMs = options.windowWaitMs ?? WINDOW_WAIT_MS;
  const windowPollMs = options.windowPollMs ?? WINDOW_POLL_MS;
  const background = options.background ?? !testIdentity;

  let stage = "unknown";
  let fingerprints = {};
  try {
    stage = currentStage();
    fingerprints = stageFingerprints(repoRoot, loadGate());
  } catch {
    // allow running in isolated unit tests
  }
  const gitMeta = (() => {
    if (options.gitMeta !== undefined) return options.gitMeta;
    const branch = (options.readGitBranchFn ?? readGitBranch)(repoRoot);
    const rawCommit = (options.readGitCommitFn ?? readGitShortCommit)(repoRoot);
    const commit = typeof rawCommit === "string" && rawCommit.trim() && rawCommit !== "unknown" ? rawCommit.trim() : null;
    return { branch: branch || null, commit };
  })();

  const realBefore = snapshotRealInstallations({
    channels: ["release"],
    ...(options.snapshotOptions ?? {}),
  });
  const isolatedReleaseBefore = snapshotIsolatedRelease(places);

  const defaultInstaller = options.installerPath ? null : findDefaultDevInstaller({ testIdentity, fingerprints });
  const installerPath = options.installerPath ?? defaultInstaller?.file;
  const expectedSha256 = options.expectedSha256 ?? defaultInstaller?.sha256;
  const expectedNewVersion = options.newVersion ?? inferInstallerVersion(installerPath) ?? null;

  // What this run has found so far, for the receipt's shared fields.
  const facts = { firstInstall: false, oldVersion: null, installLocation: null, wasRunning: false, windowOpen: false, deferred: false, deferMs: 0, quitMs: 0 };

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
    const status = releaseUntouched ? payload.status : "failed";

    const record = {
      identity: meta.dirName,
      installed: Boolean(payload.installed),
      skipped: status === "skipped",
      reason: releaseUntouched ? payload.reason ?? null : "release_changed",
      error: releaseUntouched ? payload.error ?? null : [payload.error, `the release channel changed: ${releaseChanges.join("; ")}`].filter(Boolean).join("; "),
      guidance: payload.guidance ?? null,
      firstInstall: facts.firstInstall,
      oldVersion: facts.oldVersion,
      newVersion: payload.newVersion ?? expectedNewVersion ?? null,
      installLocation: facts.installLocation,
      wasRunning: Boolean(payload.wasRunning ?? facts.wasRunning),
      windowOpen: facts.windowOpen,
      deferred: facts.deferred,
      deferMs: facts.deferMs,
      quitMs: facts.quitMs,
      relaunched: Boolean(payload.relaunched),
      background,
      inJob: Boolean(payload.inJob),
      elapsedMs: Date.now() - startedMs,
      at: startedAt,
      // MANGA's own fields.
      status,
      stage,
      ...fingerprints,
      channel: "development",
      productName: meta.productName,
      testIdentity,
      ...(gitMeta?.branch ? { branch: gitMeta.branch } : {}),
      ...(gitMeta?.commit ? { commit: gitMeta.commit } : {}),
      ...(payload.viaShell !== undefined ? { viaShell: Boolean(payload.viaShell) } : {}),
      releaseUntouched,
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
    return finalize({ status: "skipped", reason: "disabled", guidance: "MANGA_DEV_AUTO_INSTALL=0: the development build is not installed automatically" });
  }

  if (options.ci === true || env.CI === "true" || env.GITHUB_ACTIONS === "true") {
    return finalize({ status: "skipped", reason: "ci", guidance: "CI environment: nothing is installed on this machine" });
  }

  // The development channel's own uninstall entry, keyed by the app's identity (A-139); without one (or without its executable) this is the
  // first installation, into the default folder.
  let entries;
  try {
    entries = options.registryEntries ?? (options.readUninstallEntriesFn ?? readUninstallEntries)();
  } catch {
    return finalize({ status: "failed", reason: "registry_unreadable", error: "could not read the installed apps from the registry; nothing was installed" });
  }
  const entry = entries.find((item) => item.Key === meta.uninstallKey) ?? null;
  const localAppData = places?.local ?? env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const defaultInstallDir = path.join(places?.programs ?? path.join(localAppData, "Programs"), meta.dirName);
  const candidateInstallDir = options.installDir || entry?.InstallLocation || defaultInstallDir;
  const installedDevExe = path.join(candidateInstallDir, `${meta.executableName}.exe`);
  facts.installLocation = receiptLocation(candidateInstallDir, path.dirname(defaultInstallDir), places?.programs ? "<programs>" : "%LOCALAPPDATA%\\Programs");
  // A development build installed without its identity's entry (an older installer's GUID entry, or a folder without one) is not a first
  // installation: installing over it would leave two entries in Apps & Features. It is reported; A-139 keeps no compatibility code for it.
  if (!testIdentity && !entry && (fs.existsSync(installedDevExe) || entries.some((item) => item.DisplayName === meta.productName))) {
    return finalize({
      status: "failed",
      reason: "legacy_install",
      error: `${meta.productName} is installed without the uninstall entry ${meta.uninstallKey}; nothing was installed`,
      guidance: `uninstall ${meta.productName} in Settings > Apps (its data is kept), then run \`node scripts/stage.mjs install-dev\` again`,
    });
  }
  const isInstalled = fs.existsSync(installedDevExe) && (testIdentity ? Boolean(entry || options.installDir || places?.programs) : Boolean(entry));
  facts.firstInstall = !isInstalled;

  const beforeBuild = isInstalled ? readBuildInfoIfPresent(path.join(candidateInstallDir, "resources")) : null;
  const previousVersion = isInstalled ? beforeBuild?.version ?? (entry?.DisplayVersion || null) : null;
  facts.oldVersion = previousVersion;
  if (isInstalled && beforeBuild?.channel !== "development") {
    return finalize({ status: "failed", reason: "metadata_invalid", error: "installed development build metadata is missing or belongs to another channel" });
  }
  if (!installerPath || !fs.existsSync(installerPath)) {
    return finalize({ status: "failed", reason: "installer_missing", error: "current development installer is missing or stale and could not be built" });
  }
  const devPattern = /^0\.1\.(\d+)-dev\.(\d{12})$/;
  const previousParts = devPattern.exec(previousVersion ?? "");
  const nextParts = devPattern.exec(expectedNewVersion ?? "");
  if (!nextParts || (previousParts && (Number(nextParts[1]) < Number(previousParts[1]) || (nextParts[1] === previousParts[1] && nextParts[2] < previousParts[2])))) {
    return finalize({ status: "failed", reason: "version_invalid", error: "development installer version is invalid or older than the installed version" });
  }
  // The installed build is already this one (same version and the same application archive as the packaged directory the installer was made
  // from): nothing to install, and the running development app is not asked to quit for nothing. The packaged directory is known for the installer
  // install-dev finds itself (the latest package); a caller that names another installer names its directory too, or nothing is skipped.
  const packagedAppDir = options.packagedAppDir !== undefined ? options.packagedAppDir : options.installerPath ? null : defaultPackagedAppDir(defaultInstaller?.recordFile);
  if (isInstalled && previousVersion === expectedNewVersion && packagedAppDir && sameApplicationArchive(path.join(candidateInstallDir, "resources"), path.join(packagedAppDir, "resources"))) {
    return finalize({ status: "skipped", reason: "already_installed", guidance: "this build is already installed" });
  }
  const installerHash = () => createHash("sha256").update(fs.readFileSync(installerPath)).digest("hex");
  if (expectedSha256 && installerHash() !== expectedSha256) {
    return finalize({ status: "failed", reason: "installer_changed", error: "development installer changed after packaging" });
  }

  // A window the person can see means they are using MANGA Dev: wait for it to close or go to the tray, then go on (A-139).
  if (isInstalled) {
    const isWindowOpen = options.isWindowOpenFn ?? devWindowOpen;
    const deferStart = Date.now();
    for (;;) {
      let open;
      try {
        open = isWindowOpen(installedDevExe);
      } catch {
        return finalize({ status: "failed", reason: "window_check_failed", error: `could not check whether ${meta.productName} shows a window; nothing was installed` });
      }
      if (!open) break;
      facts.windowOpen = true;
      facts.deferred = true;
      const waited = Date.now() - deferStart;
      if (waited >= windowWaitMs) {
        facts.deferMs = waited;
        return finalize({
          status: "skipped",
          reason: "window_open",
          guidance: `${meta.productName} kept a window open for ${Math.round(windowWaitMs / 1000)} s, so this build was not installed; close the window (or hide it to the tray) and run \`node scripts/stage.mjs install-dev\` again`,
        });
      }
      await sleep(Math.min(windowPollMs, windowWaitMs - waited));
    }
    if (facts.deferred) facts.deferMs = Date.now() - deferStart;
  }

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
    return finalize({ status: "aborted", reason: "light_open", error: "请先关闭轻量播放窗口 (light open did not leave within 10s; nothing was installed)" });
  }

  const runningInstance = readRunningInstance(devRuntimeDir);
  const runningPid = options.runningPid ?? (Number.isInteger(runningInstance?.pid) ? runningInstance.pid : null);
  const checkAlive = options.isProcessAliveFn ?? isProcessAlive;
  const wasRunning = Boolean(runningPid && checkAlive(runningPid));
  facts.wasRunning = wasRunning;

  if (!options.runningPid && wasRunning && (!runningInstance?.execPath || runningInstance.channel !== "development" || Boolean(runningInstance.testIdentity) !== testIdentity || path.resolve(runningInstance.execPath).toLowerCase() !== path.resolve(installedDevExe).toLowerCase())) {
    return finalize({ status: "aborted", reason: "foreign_instance", error: "running instance does not belong to the installed development executable" });
  }
  if (!options.runningPid && !wasRunning && (options.runningProcessesFn ?? runningDevProcesses)(installedDevExe).length > 0) {
    return finalize({ status: "aborted", wasRunning: true, reason: "no_handshake", error: "running development build has no graceful-update handshake; close it before running install-dev" });
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
      if (isProcessAlive(prior?.pid)) return finalize({ status: "aborted", reason: "install_in_progress", error: "another development installation is already in progress" });
      fs.rmSync(lockFile, { force: true });
    }
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, requestId }), { flag: "wx" });
  } catch {
    return finalize({ status: "failed", reason: "lock_failed", error: "could not acquire the development installation lock" });
  }

  const relaunchDevelopment = async (expectedVersion) => {
    let relaunched = false;
    let relaunchedPid = null;
    let draftPreserved;
    let inJob;
    let viaShell;
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
      if (background) {
        inJob = custom?.inJob === true;
        if (custom?.viaShell !== undefined) viaShell = custom.viaShell === true;
      }
    } else if (background) {
      let launched;
      try {
        // The desktop shell gives the app its own environment, so it is used only when nothing here overrides the app's environment.
        const viaDesktopShell = !places && !options.relaunchEnv;
        launched = (options.launchOutsideJobFn ?? launchOutsideJob)(installedDevExe, launchArgs, relaunchEnv, { viaDesktopShell });
      } catch {
        return { relaunched: false, relaunchedPid: null };
      }
      relaunchedPid = launched.pid;
      inJob = launched.inJob;
      viaShell = launched.viaShell === true;
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
    return { relaunched, relaunchedPid, draftPreserved, inJob, viaShell };
  };
  const failAndRecover = async (payload) => {
    withdrawRequest();
    const current = readBuildInfoIfPresent(path.join(candidateInstallDir, "resources"));
    const active = readRunningInstance(devRuntimeDir);
    if (wasRunning && runningPid && !checkAlive(runningPid) && !(active?.pid && checkAlive(active.pid))
      && current?.channel === "development" && fs.existsSync(installedDevExe)) {
      try {
        const recovered = await relaunchDevelopment(current.version);
        return finalize({ ...payload, relaunched: recovered.relaunched, inJob: recovered.inJob, viaShell: recovered.viaShell, recoveryVersion: current.version }, { relaunchedPid: recovered.relaunchedPid });
      } catch { /* retain the original installation failure in the evidence */ }
    }
    return finalize(payload);
  };

  try {

    if (wasRunning && runningPid) {
      const quitStart = Date.now();
      const waitDeadline = quitStart + quitTimeoutMs;
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
        return finalize({ status: "failed", reason: "quit_request_failed", error: "could not write the graceful quit request" });
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
          facts.quitMs = Date.now() - quitStart;
          return await failAndRecover({ status: "failed", reason: "quit_failed", error: "development quit helper failed; installation was cancelled" });
        }
      }

      let exited = !checkAlive(runningPid);
      while (!exited && Date.now() < waitDeadline) {
        await sleep(100);
        exited = !checkAlive(runningPid);
      }
      facts.quitMs = Date.now() - quitStart;

      if (!exited) {
        // Withdraw the request. The main process observes this and must not close after its write barrier releases.
        withdrawRequest();
        // Never force-kill: leave the running development instance alive and abort this update (计划 4.2, AT-158).
        return finalize(
          {
            status: "aborted",
            reason: "quit_timeout",
            error: `running development instance did not exit within ${Math.round(quitTimeoutMs / 1000)}s timeout; aborted without force-killing`,
          },
          { abortedPidStillAlive: checkAlive(runningPid) },
        );
      }
    }

    // Silent install into the installation directory (`/S /D=<installDir>`; the default folder on a first installation).
    if (expectedSha256 && installerHash() !== expectedSha256) return await failAndRecover({ status: "failed", reason: "installer_changed", error: "development installer changed before execution" });
    const arrived = readRunningInstance(devRuntimeDir);
    if (!options.runningPid && arrived?.pid && checkAlive(arrived.pid)) return finalize({ status: "aborted", wasRunning: true, reason: "instance_reopened", error: "a development instance opened before installation; installation was cancelled" });
    const installArgs = ["/S", `/D=${candidateInstallDir}`];
    const installResult = options.spawnInstallerFn
      ? await options.spawnInstallerFn(installerPath, installArgs, candidateInstallDir)
      : spawnSync(installerPath, installArgs, { windowsHide: true, timeout: 300_000 });

    if ((installResult?.status ?? 1) !== 0) {
      return await failAndRecover({ status: "failed", reason: "installer_failed", error: `silent installer exited with status ${String(installResult?.status ?? 1)}` });
    }

    const afterBuild = readBuildInfoIfPresent(path.join(candidateInstallDir, "resources"));
    const installedVersion = afterBuild?.version ?? null;
    if (!installedVersion || afterBuild.channel !== "development" || !fs.existsSync(installedDevExe) || (expectedNewVersion && installedVersion !== expectedNewVersion)) {
      return await failAndRecover({
        status: "failed",
        newVersion: installedVersion,
        reason: "version_mismatch",
        error: `installed version (${String(installedVersion)}) does not match expected version (${expectedNewVersion})`,
      });
    }

    const startAfter = wasRunning || background;
    const { relaunched, relaunchedPid, draftPreserved, inJob, viaShell } = startAfter
      ? await relaunchDevelopment(installedVersion) : { relaunched: false, relaunchedPid: null };

    return finalize(
      {
        status: startAfter && !relaunched ? "failed" : "passed",
        installed: true,
        relaunched,
        inJob,
        viaShell,
        newVersion: installedVersion,
        ...(startAfter && !relaunched ? { reason: "launch_failed", error: "updated development instance did not become ready" } : {}),
        ...(draftPreserved !== undefined ? { draftPreserved } : {}),
      },
      { relaunchedPid },
    );
  } catch {
    withdrawRequest();
    return await failAndRecover({ status: "failed", reason: "install_error", error: "development installation or relaunch failed" });
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
  if (result.guidance) console.log(`[install-dev] ${result.guidance}`);
  if (result.inJob) {
    console.log(`[install-dev] ${result.productName} ${String(result.newVersion)} started inside this command's job object and may end with the command; open it once from the Start menu`);
  }
  if (result.status === "failed" || result.status === "aborted") {
    process.exitCode = 1;
  }
}
