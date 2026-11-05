import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { desktopPackageDir, latestDesktopPackage } from "../desktop-paths.ts";
import { currentStage, loadGate, repoRoot as root, runDir, stageFingerprints } from "./lib.mjs";
import { CHANNEL_INSTALL, buildInstaller } from "./installer-lib.mjs";

/**
 * A real installation and removal of both channels on this machine (计划 4.10), run on its own (`node scripts/stage.mjs installer`), never as part of
 * `stage package`. Everything the installers write that is not Windows' own bookkeeping goes under one temporary folder: the program folders (`/D=`), and
 * the application's data, Documents and Downloads of the smoke start (LOCALAPPDATA, MANGA_DOCUMENTS_DIR, MANGA_DOWNLOADS_DIR). Windows' own entries
 * (the Start menu, the desktop shortcut, the uninstall entry) are checked absent before, present while installed, and gone after. It stops before
 * touching anything if either channel is already installed for real.
 */
if (process.platform !== "win32") throw new Error("the installer targets Windows x64");
const stage = currentStage();
const config = loadGate();
const fingerprints = stageFingerprints(root, config);
// The package must be the one built from the inputs as they are now; installing an older build would prove nothing about this one.
const built = (() => { try { return JSON.parse(fs.readFileSync(latestDesktopPackage, "utf8")); } catch { return null; } })();
const stalePackage = ["sourceFingerprint", "lockFingerprint", "buildScriptFingerprint"].filter((key) => built?.[key] !== fingerprints[key]);
if (stalePackage.length) throw new Error(`the packaged application was not built from the current ${stalePackage.join(", ")}; run node scripts/stage.mjs package first`);
const appDir = path.join(desktopPackageDir, fs.readdirSync(desktopPackageDir).find((name) => name.startsWith("MANGA")) ?? "");
if (!fs.existsSync(path.join(appDir, "MANGA.exe"))) throw new Error("no packaged application; run node scripts/stage.mjs package first");
const version = JSON.parse(fs.readFileSync(path.join(root, "apps/desktop/package.json"), "utf8")).version;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "manga-installer-"));
const places = { programs: path.join(temp, "Programs"), local: path.join(temp, "local"), documents: path.join(temp, "documents"), downloads: path.join(temp, "downloads"), work: path.join(temp, "build") };
for (const dir of Object.values(places)) fs.mkdirSync(dir, { recursive: true });
const steps = [];
const step = (name, ok, detail = {}) => {
  steps.push({ name, ok, ...detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) throw new Error(`installer check failed: ${name}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function powershell(command) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true });
  return result.stdout.trim();
}
const UNINSTALL_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
/** The uninstall entries of the two products in the current user's registry; the folder is the uninstaller's (the entry has no InstallLocation). */
function uninstallEntries() {
  const text = powershell(`Get-ChildItem '${UNINSTALL_KEY}' | ForEach-Object { $p = Get-ItemProperty $_.PSPath; if ($p.DisplayName -eq 'MANGA' -or $p.DisplayName -eq 'MANGA Dev') { [pscustomobject]@{ Key = $_.PSChildName; DisplayName = $p.DisplayName; UninstallString = $p.UninstallString } } } | ConvertTo-Json -Compress`);
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => {
    const command = String(entry.UninstallString).replace(/^"([^"]+)".*$/, "$1");
    return { ...entry, command, InstallLocation: path.dirname(command) };
  });
}
const under = (file, dir) => path.resolve(file).toLowerCase().startsWith(`${path.resolve(dir).toLowerCase()}${path.sep}`);
/** What a failed removal of this run left: its entries, the per-user key beside them, and shortcuts into the temporary folder. Never anything else. */
function removeLeftovers() {
  for (const entry of uninstallEntries().filter((item) => under(item.InstallLocation, places.programs))) {
    powershell(`Remove-Item '${UNINSTALL_KEY}\\${entry.Key}' -Recurse -ErrorAction SilentlyContinue; Remove-Item 'HKCU:\\Software\\${entry.Key}' -Recurse -ErrorAction SilentlyContinue`);
  }
  for (const file of ["release", "development"].flatMap((channel) => shortcuts(channel)).filter((item) => fs.existsSync(item))) {
    const target = powershell(`(New-Object -ComObject WScript.Shell).CreateShortcut('${file.replaceAll("'", "''")}').TargetPath`);
    if (target && under(target, places.programs)) fs.rmSync(file, { force: true });
  }
}
const startMenu = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs");
const desktop = powershell("[Environment]::GetFolderPath('Desktop')");
const shortcuts = (channel) => [path.join(startMenu, `${CHANNEL_INSTALL[channel].shortcutName}.lnk`), path.join(desktop, `${CHANNEL_INSTALL[channel].shortcutName}.lnk`)];
const roamingNames = () => fs.readdirSync(process.env.APPDATA ?? "").filter((name) => /^manga/i.test(name)).sort();
const installDir = (channel) => path.join(places.programs, CHANNEL_INSTALL[channel].dirName);
const exeOf = (channel) => path.join(installDir(channel), `${CHANNEL_INSTALL[channel].executableName}.exe`);
const isolatedEnv = () => {
  const env = { ...process.env, LOCALAPPDATA: places.local, MANGA_DOCUMENTS_DIR: places.documents, MANGA_DOWNLOADS_DIR: places.downloads };
  for (const name of ["MANGA_PROFILE_ROOT", "MANGA_POINTER_FILE", "MANGA_CHANNEL", "NODE_ENV", "ELECTRON_RUN_AS_NODE"]) delete env[name];
  return env;
};

function install(installer, channel, chooseFolder = true) {
  const args = ["/S", ...(chooseFolder ? [`/D=${installDir(channel)}`] : [])];
  const started = Date.now();
  const result = spawnSync(installer, args, { windowsHide: true, timeout: 300_000 });
  return { status: result.status, ms: Date.now() - started };
}
async function uninstall(channel) {
  const entry = uninstallEntries().find((item) => item.DisplayName === CHANNEL_INSTALL[channel].productName);
  if (!entry) return { status: "no-entry" };
  // The uninstaller copies itself away and returns at once; wait for its entry and folder to go.
  spawnSync(entry.command, ["/S"], { windowsHide: true, timeout: 120_000 });
  for (let waited = 0; waited < 120_000; waited += 1000) {
    if (!uninstallEntries().some((item) => item.DisplayName === CHANNEL_INSTALL[channel].productName) && !fs.existsSync(exeOf(channel))) return { status: "removed", ms: waited };
    await sleep(1000);
  }
  return { status: "timeout" };
}

const evidence = runDir();
const startedAt = new Date().toISOString();
const roamingBefore = roamingNames();
let failure = null;
try {
  // Nothing of a real installation may be touched.
  step("no real installation of either channel", uninstallEntries().length === 0 && ["release", "development"].every((channel) => shortcuts(channel).every((file) => !fs.existsSync(file))));
  const installers = {};
  const keys = {};
  for (const channel of ["release", "development"]) {
    const made = await buildInstaller({ appDir, channel, workDir: places.work, version });
    installers[channel] = made.installer;
    step(`${channel}: installer built and configured`, true, { megabytes: Math.round(made.bytes / 1024 / 1024), seconds: Math.round(made.ms / 1000) });
  }
  // Both channels side by side.
  for (const channel of ["release", "development"]) {
    const result = install(installers[channel], channel);
    const entry = uninstallEntries().find((item) => item.DisplayName === CHANNEL_INSTALL[channel].productName);
    step(`${channel}: installed per user without elevation into the chosen folder`, result.status === 0 && fs.existsSync(exeOf(channel)) && Boolean(entry) && path.resolve(String(entry.InstallLocation)) === path.resolve(installDir(channel)), { seconds: Math.round(result.ms / 1000) });
    step(`${channel}: Start menu and desktop shortcuts`, shortcuts(channel).every((file) => fs.existsSync(file)));
    keys[channel] = entry?.Key;
  }
  step("both channels installed at once", uninstallEntries().length === 2);
  // A first start of each puts its data where 4.9 says, in the folders this run stands in for.
  for (const channel of ["release", "development"]) {
    const result = spawnSync(exeOf(channel), ["--manga-smoke"], { env: { ...isolatedEnv(), MANGA_SMOKE_PHASE: "initial" }, timeout: 120_000, windowsHide: true });
    const appRoot = path.join(places.local, CHANNEL_INSTALL[channel].dirName);
    const files = path.join(places.documents, channel === "release" ? "MANGA" : "MANGA-dev");
    const report = path.join(appRoot, "logs", "smoke-initial.json");
    const ok = result.status === 0 && fs.existsSync(report) && JSON.parse(fs.readFileSync(report, "utf8")).status !== "failed";
    step(`${channel}: first start`, ok, { status: result.status });
    step(`${channel}: data under LOCALAPPDATA, files under Documents, downloads under Downloads`, fs.existsSync(path.join(appRoot, "data", "manga.sqlite")) && fs.existsSync(path.join(appRoot, "launcher", "pointer.json")) && fs.existsSync(path.join(files, "works")) && fs.existsSync(path.join(places.downloads, channel === "release" ? "MANGA" : "MANGA-dev")) && !fs.existsSync(path.join(appRoot, "works")));
  }
  step("nothing written to the roaming profile", JSON.stringify(roamingNames()) === JSON.stringify(roamingBefore), { before: roamingBefore.length, after: roamingNames().length });
  // Installing again over a running copy, without naming a folder: the installer closes it and keeps the folder of the first installation.
  const running = spawn(exeOf("release"), [], { env: isolatedEnv(), detached: false, windowsHide: true, stdio: "ignore" });
  await sleep(6000);
  const exited = new Promise((resolve) => running.once("exit", () => resolve(true)));
  const again = install(installers.release, "release", false);
  const closed = await Promise.race([exited, sleep(15_000).then(() => false)]);
  if (!closed) running.kill();
  const entry = uninstallEntries().find((item) => item.DisplayName === "MANGA");
  step("release: installed again over a running copy, which was closed, into the same folder", again.status === 0 && closed === true && path.resolve(String(entry?.InstallLocation)) === path.resolve(installDir("release")));
  // Removing each leaves the data and the person's files, and nothing of the installation.
  for (const channel of ["development", "release"]) {
    const removed = await uninstall(channel);
    const appRoot = path.join(places.local, CHANNEL_INSTALL[channel].dirName);
    step(`${channel}: uninstalled`, removed.status === "removed", removed);
    step(`${channel}: Start menu, desktop shortcut, uninstall entry and the per-user key gone`, shortcuts(channel).every((file) => !fs.existsSync(file)) && !uninstallEntries().some((item) => item.DisplayName === CHANNEL_INSTALL[channel].productName) && powershell(`Test-Path 'HKCU:\\Software\\${keys[channel]}'`) === "False");
    step(`${channel}: data and files kept`, fs.existsSync(path.join(appRoot, "data", "manga.sqlite")) && fs.existsSync(path.join(places.documents, channel === "release" ? "MANGA" : "MANGA-dev")));
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  // Whatever happened, nothing of this run stays installed.
  for (const channel of ["release", "development"]) {
    if (uninstallEntries().some((item) => item.DisplayName === CHANNEL_INSTALL[channel].productName && under(item.InstallLocation, places.programs))) await uninstall(channel);
  }
  removeLeftovers();
  const leftovers = { entries: uninstallEntries().length, shortcuts: ["release", "development"].flatMap(shortcuts).filter((file) => fs.existsSync(file)).length };
  steps.push({ name: "clean afterwards", ok: leftovers.entries === 0 && leftovers.shortcuts === 0, ...leftovers });
  fs.rmSync(temp, { recursive: true, force: true });
}
const passed = !failure && steps.every((item) => item.ok);
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(evidence, "installer.json"), `${JSON.stringify({
  status: passed ? "passed" : "failed", stage, ...fingerprints, at: startedAt, format: "unsigned per-user NSIS installer (electron-builder, --prepackaged)", electronBuilder: "26.18.0",
  ...(failure ? { failure } : {}), steps,
}, null, 2)}\n`);
console.log(JSON.stringify({ status: passed ? "passed" : "failed", check: "stage-installer", steps: steps.length }));
if (!passed) process.exitCode = 1;
