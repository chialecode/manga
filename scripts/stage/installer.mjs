import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { desktopPackageDir, latestDesktopPackage } from "../desktop-paths.ts";
import { currentStage, loadGate, packagedFingerprintKeys, repoRoot as root, runDir, stageFingerprints } from "./lib.mjs";
import {
  TEST_CHANNEL_INSTALL,
  buildInstaller,
  compareRealInstallations,
  readOpenWithState,
  removeTestInstallations,
  snapshotRealInstallations,
} from "./installer-lib.mjs";
import { readBuildInfoIfPresent, resolveBuildVersion } from "./version-lib.mjs";
import { runPackagedUpdateRehearsal } from "./update-rehearsal.mjs";
import { rehearseRollback } from "./rollback-rehearsal.mjs";

/**
 * A real installation, upgrade rehearsal (`0.1.1` -> `0.1.2`), and removal of both channels on this machine using isolated test installation identities
 * (`MANGA Test` / `app.manga.desktop.test` / `manga-test` and `MANGA Dev Test` / `app.manga.desktop.dev.test` / `manga-dev-test`, 计划 4.8, 5.3 W7,
 * AT-150, AT-162), run on its own (`node scripts/stage.mjs installer`).
 *
 * Real installations (`MANGA` and `MANGA Dev`) are never refused or touched: a snapshot is taken before and after, and `compareRealInstallations`
 * must report zero changes.
 */
if (process.platform !== "win32") throw new Error("the installer targets Windows x64");
const stage = currentStage();
const config = loadGate();
const fingerprints = stageFingerprints(root, config);
// The package must be the one built from the inputs as they are now; installing an older build would prove nothing about this one.
const built = (() => { try { return JSON.parse(fs.readFileSync(latestDesktopPackage, "utf8")); } catch { return null; } })();
const stalePackage = packagedFingerprintKeys(config).filter((key) => built?.[key] !== fingerprints[key]);
if (stalePackage.length) throw new Error(`the packaged application was not built from the current ${stalePackage.join(", ")}; run node scripts/stage.mjs package first`);
const appDir = path.join(desktopPackageDir, fs.readdirSync(desktopPackageDir).find((name) => name.startsWith("manga")) ?? "");
if (!fs.existsSync(path.join(appDir, "manga.exe"))) throw new Error("no packaged application; run node scripts/stage.mjs package first");

const releaseVersionA = "0.1.1";
const releaseVersionB = "0.1.2";
const devVersion = resolveBuildVersion("development", { tags: [], date: new Date() });
const versions = { release: releaseVersionA, development: devVersion };

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "manga-installer-"));
const places = {
  programs: path.join(temp, "Programs"),
  local: path.join(temp, "local"),
  documents: path.join(temp, "documents"),
  downloads: path.join(temp, "downloads"),
  work: path.join(temp, "build"),
};
for (const dir of Object.values(places)) fs.mkdirSync(dir, { recursive: true });
const steps = [];
const step = (name, ok, detail = {}) => {
  steps.push({ name, ok, ...detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
  if (!ok) throw new Error(`installer check failed: ${name}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function powershell(command) {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${command}`], { encoding: "utf8", windowsHide: true, timeout: 20_000 });
  if (result.status !== 0) throw new Error("could not inspect the test installation state");
  return (result.stdout ?? "").trim();
}
const UNINSTALL_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
/** The uninstall entries of the two test-identity products (`MANGA Test` and `MANGA Dev Test`) in the current user's registry. */
function uninstallEntries() {
  const text = powershell(
    `Get-ChildItem '${UNINSTALL_KEY}' -ErrorAction SilentlyContinue | ForEach-Object { $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($p -and ($p.DisplayName -eq 'MANGA Test' -or $p.DisplayName -eq 'MANGA Dev Test')) { [pscustomobject]@{ Key = $_.PSChildName; DisplayName = [string]$p.DisplayName; DisplayVersion = [string]$p.DisplayVersion; Publisher = [string]$p.Publisher; DisplayIcon = [string]$p.DisplayIcon; InstallLocation = [string]$p.InstallLocation; UninstallString = [string]$p.UninstallString } } } | ConvertTo-Json -Compress`,
  );
  if (!text) return [];
  const parsed = JSON.parse(text);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => {
    const command = String(entry.UninstallString ?? "").replace(/^"([^"]+)".*$/, "$1");
    return {
      ...entry,
      command,
      InstallLocation: entry.InstallLocation ? String(entry.InstallLocation) : path.dirname(command),
    };
  });
}
/** Remove any leftover test-identity (`MANGA Test`, `MANGA Dev Test`) registry entries and shortcuts from an interrupted run. Never touches real installations. */
async function removeTestLeftovers() {
  await removeTestInstallations();
}
const startMenu = path.join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs");
const desktop = powershell("[Environment]::GetFolderPath('Desktop')");
const shortcuts = (channel) => [
  path.join(startMenu, `${TEST_CHANNEL_INSTALL[channel].shortcutName}.lnk`),
  path.join(desktop, `${TEST_CHANNEL_INSTALL[channel].shortcutName}.lnk`),
];
const roamingNames = () => fs.readdirSync(process.env.APPDATA ?? "").filter((name) => /^manga/i.test(name)).sort();
const installDir = (channel) => path.join(places.programs, TEST_CHANNEL_INSTALL[channel].dirName);
const exeOf = (channel) => path.join(installDir(channel), `${TEST_CHANNEL_INSTALL[channel].executableName}.exe`);
const isolatedEnv = () => {
  const env = { ...process.env, LOCALAPPDATA: places.local, MANGA_DOCUMENTS_DIR: places.documents, MANGA_DOWNLOADS_DIR: places.downloads, MANGA_WINDOW_HIDDEN: "1" };
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
  const entry = uninstallEntries().find((item) => item.DisplayName === TEST_CHANNEL_INSTALL[channel].productName);
  if (!entry) return { status: "no-entry" };
  if (path.resolve(entry.InstallLocation).toLowerCase() !== path.resolve(installDir(channel)).toLowerCase()
    || path.dirname(path.resolve(entry.command)).toLowerCase() !== path.resolve(installDir(channel)).toLowerCase()) throw new Error("test uninstaller escaped its installation directory");
  // The uninstaller copies itself away and returns at once; wait for its entry and folder to go.
  spawnSync(entry.command, ["/S"], { windowsHide: true, timeout: 120_000 });
  for (let waited = 0; waited < 120_000; waited += 1000) {
    if (!uninstallEntries().some((item) => item.DisplayName === TEST_CHANNEL_INSTALL[channel].productName) && !fs.existsSync(exeOf(channel))) return { status: "removed", ms: waited };
    await sleep(1000);
  }
  return { status: "timeout" };
}

const evidence = runDir();
const startedAt = new Date().toISOString();
fs.rmSync(path.join(evidence, "installer.json"), { force: true });
const realBefore = snapshotRealInstallations();
const extensionDefaultsBefore = readOpenWithState("release", { testIdentity: true }).extensionDefaults;
const roamingBefore = roamingNames();
let failure = null;
let updateRehearsal = null;
try {
  // Clean up any test-identity leftovers from a prior interrupted run, leaving real installations completely untouched (计划 4.8).
  await removeTestLeftovers();
  step(
    "test identities clean before run",
    uninstallEntries().length === 0 && ["release", "development"].every((channel) => shortcuts(channel).every((file) => !fs.existsSync(file))),
  );
  const installers = {};
  const preparedInstallers = {};
  const keys = {};
  for (const channel of ["release", "development"]) {
    const made = await buildInstaller({
      appDir,
      channel,
      workDir: path.join(places.work, channel),
      version: versions[channel],
      testIdentity: true,
    });
    installers[channel] = made.installer;
    preparedInstallers[channel === "release" ? "releasePrevious" : "developmentPrevious"] = made;
    step(`${channel}: installer built and configured`, true, {
      version: made.version,
      megabytes: Math.round(made.bytes / 1024 / 1024),
      seconds: Math.round(made.ms / 1000),
    });
  }
  // Both channels side by side in places.programs using test identities.
  for (const channel of ["release", "development"]) {
    const result = install(installers[channel], channel);
    const entry = uninstallEntries().find((item) => item.DisplayName === TEST_CHANNEL_INSTALL[channel].productName);
    step(
      `${channel}: installed per user without elevation into the chosen folder`,
      result.status === 0
        && fs.existsSync(exeOf(channel))
        && Boolean(entry)
        && path.resolve(String(entry.InstallLocation)) === path.resolve(installDir(channel))
        && entry.DisplayVersion === versions[channel]
        && entry.Publisher === "chialecode",
      { version: entry?.DisplayVersion ?? null, publisher: entry?.Publisher ?? null, seconds: Math.round(result.ms / 1000) },
    );
    step(`${channel}: Start menu and desktop shortcuts`, shortcuts(channel).every((file) => fs.existsSync(file)));
    // "Open with" (4.5, AT-166): every ProgID, OpenWithProgids value, Applications entry and Capabilities value is there with this folder's
    // executable, and no extension's own default value changed.
    const openWith = readOpenWithState(channel, { testIdentity: true, exePath: exeOf(channel) });
    const wrong = openWith.values.filter((value) => value.actual !== value.expected);
    step(`${channel}: "Open with" registered for ${openWith.values.filter((value) => value.key.endsWith("OpenWithProgids")).length} types, extension defaults untouched`,
      wrong.length === 0 && openWith.extensionDefaults === extensionDefaultsBefore,
      { values: openWith.values.length, wrong: wrong.slice(0, 3).map((value) => `${value.key}|${value.name}`) });
    keys[channel] = entry?.Key;
  }
  step("both channels installed at once", uninstallEntries().length === 2);
  // A first start of each puts its data under LOCALAPPDATA\<dirName> and files under Documents\<dirName>, and makes nothing in the Downloads folder
  // (Downloads\<dirName> appears when something is first saved there; download staging is in the application's cache).
  for (const channel of ["release", "development"]) {
    const dirName = TEST_CHANNEL_INSTALL[channel].dirName;
    const result = spawnSync(exeOf(channel), ["--manga-smoke"], { env: { ...isolatedEnv(), MANGA_SMOKE_PHASE: "initial" }, timeout: 120_000, windowsHide: true });
    const appRoot = path.join(places.local, dirName);
    const files = path.join(places.documents, dirName);
    const downloads = path.join(places.downloads, dirName);
    const report = path.join(appRoot, "logs", "smoke-initial.json");
    const ok = result.status === 0 && fs.existsSync(report) && JSON.parse(fs.readFileSync(report, "utf8")).status !== "failed";
    step(`${channel}: first start`, ok, { status: result.status });
    step(
      `${channel}: data under LOCALAPPDATA, files under Documents, nothing in Downloads`,
      fs.existsSync(path.join(appRoot, "data", "manga.sqlite"))
        && fs.existsSync(path.join(appRoot, "launcher", "pointer.json"))
        && fs.existsSync(path.join(files, "works"))
        && !fs.existsSync(downloads)
        && !fs.existsSync(path.join(appRoot, "works")),
    );
  }
  // The registered command opens a file in light open: run exactly what Explorer would, on a file light open does not take, and read its answer.
  {
    const command = readOpenWithState("release", { testIdentity: true, exePath: exeOf("release") }).values.find((value) => value.key.endsWith("\\MANGA.Test.Video\\shell\\open\\command"))?.actual ?? "";
    const parts = [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]);
    const sample = path.join(temp, "notes.txt");
    fs.writeFileSync(sample, "not a comic\n");
    const report = path.join(temp, "open-with-report.json");
    const result = spawnSync(parts[0], [...parts.slice(1).map((part) => (part === "%1" ? sample : part)), "--manga-smoke"], {
      env: { ...isolatedEnv(), MANGA_SMOKE_PHASE: "light-unsupported", MANGA_SMOKE_REPORT: report }, timeout: 120_000, windowsHide: true,
    });
    const body = (() => { try { return JSON.parse(fs.readFileSync(report, "utf8")); } catch { return null; } })();
    step("release: the registered \"Open with\" command starts light open on the file",
      path.resolve(parts[0] ?? "").toLowerCase() === path.resolve(exeOf("release")).toLowerCase() && parts[1] === "--manga-light" && parts[2] === "%1"
        && result.status === 0 && body?.ok === true && fs.existsSync(path.join(places.local, TEST_CHANNEL_INSTALL.release.dirName, "light")),
      { status: result.status, phase: body?.phase ?? null });
  }
  step("nothing written to the roaming profile", JSON.stringify(roamingNames()) === JSON.stringify(roamingBefore), { before: roamingBefore.length, after: roamingNames().length });

  // Upgrade rehearsal over a running copy (`0.1.1` -> `0.1.2`, 计划 4.6, 5.3 W7, AT-162):
  // build a `0.1.2` test-identity release installer, install it over the running `0.1.1` copy without naming a folder,
  // and verify the running copy closes, the folder and existing data are preserved, and the installed version is `0.1.2`.
  const upgradeInstaller = await buildInstaller({
    appDir,
    channel: "release",
    workDir: path.join(places.work, "release-upgrade"),
    version: releaseVersionB,
    testIdentity: true,
  });
  preparedInstallers.releaseNext = upgradeInstaller;
  const running = spawn(exeOf("release"), [], { env: isolatedEnv(), detached: false, windowsHide: true, stdio: "ignore" });
  const runtimeFile = path.join(places.local, TEST_CHANNEL_INSTALL.release.dirName, "runtime", "running-instance.json");
  for (let waited = 0; waited < 8000; waited += 200) {
    if (fs.existsSync(runtimeFile)) break;
    await sleep(200);
  }
  await sleep(1000);
  const exited = new Promise((resolve) => running.once("exit", () => resolve(true)));
  const again = install(upgradeInstaller.installer, "release", false);
  const closed = await Promise.race([exited, sleep(15_000).then(() => false)]);
  if (!closed) running.kill();
  const upgradedEntry = uninstallEntries().find((item) => item.DisplayName === TEST_CHANNEL_INSTALL.release.productName);
  const upgradedBuild = readBuildInfoIfPresent(path.join(installDir("release"), "resources"));
  const releaseAppRoot = path.join(places.local, TEST_CHANNEL_INSTALL.release.dirName);
  step(
    "release: upgraded from 0.1.1 to 0.1.2 over a running copy, which was closed, into the same folder with data preserved",
    again.status === 0
      && closed === true
      && path.resolve(String(upgradedEntry?.InstallLocation)) === path.resolve(installDir("release"))
      && upgradedEntry?.DisplayVersion === releaseVersionB
      && upgradedBuild?.version === releaseVersionB
      && fs.existsSync(path.join(releaseAppRoot, "data", "manga.sqlite"))
      && fs.existsSync(path.join(releaseAppRoot, "logs", "smoke-initial.json")),
    { previousVersion: releaseVersionA, upgradedVersion: upgradedBuild?.version ?? null, registryVersion: upgradedEntry?.DisplayVersion ?? null },
  );
  {
    const openWithAfterUpgrade = readOpenWithState("release", { testIdentity: true, exePath: exeOf("release") });
    const wrongAfterUpgrade = openWithAfterUpgrade.values.filter((value) => value.actual !== value.expected);
    step(
      "release: \"Open with\" registration preserved after 0.1.1 -> 0.1.2 over-install, extension defaults untouched",
      wrongAfterUpgrade.length === 0
        && Object.values(openWithAfterUpgrade.keys).every(Boolean)
        && openWithAfterUpgrade.extensionDefaults === extensionDefaultsBefore,
      { values: openWithAfterUpgrade.values.length, wrong: wrongAfterUpgrade.slice(0, 3).map((value) => `${value.key}|${value.name}`) },
    );
  }

  // The way back after an update that does not start (4.2, update-rollback): 0.1.2 fails on purpose, the third start asks, "再试一次" stays and
  // "回到 0.1.1" reinstalls 0.1.1 with the library from before the update.
  const rollback = await rehearseRollback({
    exe: exeOf("release"), installDir: installDir("release"), appRoot: releaseAppRoot, previousInstaller: installers.release,
    previousVersion: releaseVersionA, nextVersion: releaseVersionB, env: isolatedEnv(), schemaVersion: upgradedBuild?.schemaVersion ?? 15,
    evidenceDir: evidence,
  });
  for (const item of rollback.steps) step(item.name, item.ok, Object.fromEntries(Object.entries(item).filter(([key]) => key !== "name" && key !== "ok")));
  step("update-rollback", rollback.ok);

  // Removing each leaves the data and the person's files, and nothing of the installation.
  for (const channel of ["development", "release"]) {
    const dirName = TEST_CHANNEL_INSTALL[channel].dirName;
    const removed = await uninstall(channel);
    const appRoot = path.join(places.local, dirName);
    step(`${channel}: uninstalled`, removed.status === "removed", removed);
    step(
      `${channel}: Start menu, desktop shortcut, uninstall entry and the per-user key gone`,
      shortcuts(channel).every((file) => !fs.existsSync(file))
        && !uninstallEntries().some((item) => item.DisplayName === TEST_CHANNEL_INSTALL[channel].productName)
        && powershell(`Test-Path 'HKCU:\\Software\\${keys[channel]}'`) === "False",
    );
    const openWith = readOpenWithState(channel, { testIdentity: true, exePath: exeOf(channel) });
    step(`${channel}: "Open with" registration removed, extension defaults untouched`,
      openWith.values.every((value) => value.actual === null) && Object.values(openWith.keys).every((present) => !present) && openWith.extensionDefaults === extensionDefaultsBefore,
      { left: openWith.values.filter((value) => value.actual !== null).length, keys: Object.values(openWith.keys).filter(Boolean).length });
    if (channel === "development") {
      const releaseOpenWith = readOpenWithState("release", { testIdentity: true, exePath: exeOf("release") });
      const releaseWrong = releaseOpenWith.values.filter((value) => value.actual !== value.expected);
      step(
        "release: \"Open with\" registration unaffected by development uninstall, extension defaults untouched",
        releaseWrong.length === 0
          && Object.values(releaseOpenWith.keys).every(Boolean)
          && releaseOpenWith.extensionDefaults === extensionDefaultsBefore,
        { values: releaseOpenWith.values.length, wrong: releaseWrong.slice(0, 3).map((value) => `${value.key}|${value.name}`) },
      );
    }
    step(`${channel}: data and files kept`, fs.existsSync(path.join(appRoot, "data", "manga.sqlite")) && fs.existsSync(path.join(places.documents, dirName)));
  }
  preparedInstallers.developmentNext = await buildInstaller({
    appDir, channel: "development", workDir: path.join(places.work, "development-upgrade"),
    version: resolveBuildVersion("development", { tags: [], date: new Date(Date.parse(startedAt) + 60_000) }), testIdentity: true,
  });
  updateRehearsal = await runPackagedUpdateRehearsal({
    appDir, version: releaseVersionB, previousVersion: releaseVersionA,
    includeDevelopment: true, preparedInstallers,
  });
  step("packaged electron-updater: full restart, differential quit, signature rejection and saved drafts", updateRehearsal.ok, { kind: updateRehearsal.kind, seconds: updateRehearsal.seconds });
  step("real install-dev: saved draft, relaunch, release isolation and abandoned quit", updateRehearsal.development?.stayedAliveAfterWriteCompleted === true);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  // Whatever happened, nothing of this test-identity run stays installed.
  try { await removeTestLeftovers(); } catch (error) { failure ??= String(error); }
  const leftovers = { entries: uninstallEntries().length, shortcuts: ["release", "development"].flatMap(shortcuts).filter((file) => fs.existsSync(file)).length };
  steps.push({ name: "clean afterwards", ok: leftovers.entries === 0 && leftovers.shortcuts === 0, ...leftovers });
  const realAfter = snapshotRealInstallations();
  const realDiff = compareRealInstallations(realBefore, realAfter);
  steps.push({
    name: "real installations untouched before and after",
    ok: realDiff.ok,
    ...(realDiff.ok ? {} : { changes: realDiff.changes }),
  });
  if (!failure && steps.every((item) => item.ok)) {
    const resolved = path.resolve(temp);
    if (path.dirname(resolved).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase() || !path.basename(resolved).startsWith("manga-installer-")) throw new Error("installer cleanup escaped its temporary directory");
    fs.rmSync(resolved, { recursive: true, force: true });
  } else console.error(`Installer diagnostics retained at ${temp}`);
}
const passed = !failure && steps.every((item) => item.ok);
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(path.join(evidence, "installer.json"), `${JSON.stringify({
  status: passed ? "passed" : "failed",
  stage,
  ...fingerprints,
  at: startedAt,
  seconds: Number(((Date.now() - Date.parse(startedAt)) / 1000).toFixed(2)),
  format: "unsigned per-user NSIS installer (electron-builder, --prepackaged, testIdentity)",
  electronBuilder: "26.18.0",
  ...(failure ? { failure } : {}),
  steps,
  updateRehearsal,
}, null, 2)}\n`);
console.log(JSON.stringify({ status: passed ? "passed" : "failed", check: "stage-installer", steps: steps.length }));
// Exit with the result explicitly: something still pending after the last line (a builder or browser hook) once ended a failed run with code 0,
// and the gate took the failure for a pass (A-08).
process.exit(passed ? 0 : 1);
