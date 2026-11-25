import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { writeBuildInfo } from "@manga/app-core";
import {
  WINDOW_POLL_MS,
  WINDOW_WAIT_MS,
  findDefaultDevInstaller,
  isExplorerExecutable,
  launchArgsAfterInstall,
  launchOutsideJob,
  quoteWindowsArg,
  resolveDesktopShellLaunch,
  runInstallDev,
} from "../../scripts/stage/install-dev.mjs";
import { packagedFingerprintKeys } from "../../scripts/stage/lib.mjs";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function devFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-install-dev-recovery-"));
  scratch.push(root);
  const places = { programs: path.join(root, "Programs"), local: path.join(root, "local"), documents: path.join(root, "documents"), downloads: path.join(root, "downloads") };
  const installDir = path.join(places.programs, "manga-dev-test");
  const resources = path.join(installDir, "resources");
  const runtime = path.join(places.local, "manga-dev-test/runtime");
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  const executable = path.join(installDir, "manga-dev-test.exe");
  fs.writeFileSync(executable, "synthetic development executable");
  const oldVersion = "0.1.2-dev.202611081000";
  const version = "0.1.2-dev.202611081100";
  writeBuildInfo(resources, { version: oldVersion, channel: "development", commit: "1111111", builtAt: "2026-11-08T10:00:00.000Z", schemaVersion: 14 });
  const installer = path.join(root, `manga-dev-test-setup-${version}.exe`);
  fs.writeFileSync(installer, "synthetic installer");
  fs.writeFileSync(path.join(runtime, "running-instance.json"), JSON.stringify({ pid: 770077, channel: "development", testIdentity: true, execPath: executable, version: oldVersion, state: "ready" }));
  let alive = true;
  let installerCalls = 0;
  let relaunchCalls = 0;
  const options = {
    testIdentity: true, places, installDir, installerPath: installer, newVersion: version, evidenceDir: null,
    registryEntries: [], runningProcessesFn: () => [], isWindowOpenFn: () => false,
    env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "1", CI: "", GITHUB_ACTIONS: "" },
    snapshotOptions: { registryEntries: [], localAppDataDir: path.join(root, "real-local"), roamingAppDataDir: path.join(root, "real-roaming"), desktopDir: path.join(root, "real-desktop"), registry: () => null },
    isProcessAliveFn: (pid: number) => pid === 770077 && alive,
    requestQuitFn: async () => { alive = false; },
    spawnInstallerFn: async () => { installerCalls += 1; return { status: 1 }; },
    relaunchFn: async () => { relaunchCalls += 1; return { relaunched: true, pid: 770078 }; },
  };
  return { root, places, resources, runtime, installer, executable, oldVersion, version, options,
    counts: () => ({ installerCalls, relaunchCalls }), keepRunning: () => { alive = true; } };
}

describe("Development installer recovery review (AT-158)", () => {
  it("reopens the saved development app after a failed installer or a checksum change after graceful quit (AT-158)", async () => {
    for (const changed of [false, true]) {
      const fixture = devFixture();
      const result = await runInstallDev({ ...fixture.options, expectedSha256: sha256(fixture.installer),
        requestQuitFn: async () => { await fixture.options.requestQuitFn(); if (changed) fs.appendFileSync(fixture.installer, "changed"); },
      });
      expect(result.status).toBe("failed");
      expect(result.installed).toBe(false);
      expect(result.relaunched).toBe(true);
      expect(result.recoveryVersion).toBe(fixture.oldVersion);
      expect(fixture.counts()).toEqual({ installerCalls: changed ? 0 : 1, relaunchCalls: 1 });
      for (const name of ["quit-for-update.json", "quit-for-update-ack.json", "install-dev.lock"]) expect(fs.existsSync(path.join(fixture.runtime, name))).toBe(false);
    }
  });

  it("leaves the running development app alone when the installed build is already this one, and installs a same-version build that differs (AT-158)", async () => {
    for (const same of [true, false]) {
      const fixture = devFixture();
      writeBuildInfo(fixture.resources, { version: fixture.version, channel: "development", commit: "2222222", builtAt: "2026-11-08T11:00:00.000Z", schemaVersion: 14 });
      const packaged = path.join(fixture.root, "packaged");
      fs.mkdirSync(path.join(packaged, "resources"), { recursive: true });
      fs.writeFileSync(path.join(fixture.resources, "app.asar"), "synthetic application archive");
      fs.writeFileSync(path.join(packaged, "resources", "app.asar"), same ? "synthetic application archive" : "another synthetic application archive");
      let quitRequests = 0;
      const result = await runInstallDev({ ...fixture.options, packagedAppDir: packaged,
        requestQuitFn: async () => { quitRequests += 1; await fixture.options.requestQuitFn(); },
      });
      if (same) {
        expect(result.status).toBe("skipped");
        expect(result.reason).toBe("already_installed");
        expect({ quitRequests, ...fixture.counts() }).toEqual({ quitRequests: 0, installerCalls: 0, relaunchCalls: 0 });
      } else {
        expect(quitRequests).toBe(1);
        expect(fixture.counts().installerCalls).toBe(1);
      }
    }
  });

  it("withdraws a failed helper or timed-out request without installing or reopening an app that is still running (AT-158)", async () => {
    for (const helperFails of [false, true]) {
      const fixture = devFixture();
      const result = await runInstallDev({ ...fixture.options, quitTimeoutMs: 10,
        requestQuitFn: async () => { fixture.keepRunning(); if (helperFails) throw new Error("synthetic helper failure"); },
      });
      expect(result.status).toBe(helperFails ? "failed" : "aborted");
      expect(fixture.counts()).toEqual({ installerCalls: 0, relaunchCalls: 0 });
      expect(fs.existsSync(path.join(fixture.runtime, "quit-for-update.json"))).toBe(false);
      expect(fs.existsSync(path.join(fixture.runtime, "install-dev.lock"))).toBe(false);
    }
  });

  it("asks light open to leave first and installs nothing, asking nothing of the full app, when it does not (4.6)", async () => {
    const fixture = devFixture();
    const asked: string[] = [];
    let quitRequests = 0;
    const result = await runInstallDev({ ...fixture.options,
      askLightToQuitFn: async (runtimeDir: string) => { asked.push(runtimeDir); return { ok: false, reason: "light-open-running", waitedMs: 10_000, pid: 880088 }; },
      requestQuitFn: async () => { quitRequests += 1; },
    });
    expect(asked).toEqual([path.join(fixture.places.local, "manga-dev-test", "light", "runtime")]);
    expect(result.status).toBe("aborted");
    expect(result.reason).toBe("light_open");
    expect(result.error).toContain("请先关闭轻量播放窗口");
    expect(quitRequests).toBe(0);
    expect(fixture.counts()).toEqual({ installerCalls: 0, relaunchCalls: 0 });

    const next = devFixture();
    let lightAsked = 0;
    await runInstallDev({ ...next.options, askLightToQuitFn: async () => { lightAsked += 1; return { ok: true, running: true, waitedMs: 120 }; } });
    expect(lightAsked).toBe(1);
    expect(next.counts().installerCalls).toBe(1);
  });

  it("refuses a live competing lock, the wrong process identity and missing installed build metadata (AT-158)", async () => {
    for (const problem of ["lock", "identity", "metadata"]) {
      const fixture = devFixture();
      const lock = path.join(fixture.runtime, "install-dev.lock");
      if (problem === "lock") fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, requestId: "another-installation" }));
      if (problem === "identity") fs.writeFileSync(path.join(fixture.runtime, "running-instance.json"), JSON.stringify({ pid: 770077, channel: "release", execPath: fixture.executable, testIdentity: true }));
      if (problem === "metadata") fs.rmSync(path.join(fixture.resources, "build.json"));
      const result = await runInstallDev(fixture.options);
      expect(result.status).toBe(problem === "metadata" ? "failed" : "aborted");
      expect(fixture.counts()).toEqual({ installerCalls: 0, relaunchCalls: 0 });
      expect(fs.existsSync(path.join(fixture.runtime, "quit-for-update.json"))).toBe(false);
      if (problem === "lock") expect(JSON.parse(fs.readFileSync(lock, "utf8")).requestId).toBe("another-installation");
    }
  });

  it("selects the exact fingerprint-current packaged installer instead of the oldest directory entry and rejects stale or escaped metadata (AT-158)", async () => {
    const fixture = devFixture();
    const desktopRoot = path.join(fixture.root, "desktop");
    const out = path.join(desktopRoot, "installer/out-development");
    fs.mkdirSync(out, { recursive: true });
    const older = path.join(out, `manga-dev-setup-${fixture.oldVersion}.exe`);
    const selected = path.join(out, `manga-dev-setup-${fixture.version}.exe`);
    fs.writeFileSync(older, "older synthetic installer");
    fs.copyFileSync(fixture.installer, selected);
    const fingerprints = Object.fromEntries(packagedFingerprintKeys().map((key, index) => [key, "abcdef1"[index % 7]!.repeat(64)]));
    const latest = { ...fingerprints, installer: { channel: "development", version: fixture.version,
      output: path.relative(fixture.root, selected), sha256: sha256(selected), bytes: fs.statSync(selected).size } };
    const latestFile = path.join(fixture.root, "latest-package.json");
    const write = (value: unknown) => fs.writeFileSync(latestFile, JSON.stringify(value));
    const devFile = path.join(fixture.root, "dev-build.json");
    const find = () => findDefaultDevInstaller({ fingerprints, latestFile, devFile, desktopRoot, workspaceRoot: fixture.root });
    write(latest);
    expect(find()).toEqual({ file: selected, sha256: latest.installer.sha256, recordFile: latestFile });
    write({ ...latest, sourceFingerprint: "d".repeat(64) });
    expect(find()).toBeNull();
    // With the full package run's installer stale, the one install-dev built for itself from the current source is used; a stale one of those is not.
    fs.writeFileSync(devFile, JSON.stringify(latest));
    expect(find()).toEqual({ file: selected, sha256: latest.installer.sha256, recordFile: devFile });
    fs.writeFileSync(devFile, JSON.stringify({ ...latest, sourceFingerprint: "e".repeat(64) }));
    expect(find()).toBeNull();
    fs.rmSync(devFile);
    // The window walks are bundled into the package too: a package built before a walk changed is not this one.
    write({ ...latest, smokeWalkScriptFingerprint: "0".repeat(64) });
    expect(find()).toBeNull();
    write({ ...latest, installer: { ...latest.installer, output: fixture.installer } });
    expect(find()).toBeNull();
    write({ installer: latest.installer });
    expect(find()).toBeNull();
    write(latest);
    fs.writeFileSync(selected, "changed same bytes!");
    const result = await runInstallDev({ ...fixture.options, installerPath: selected, expectedSha256: latest.installer.sha256 });
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("installer_changed");
    expect(result.error).toContain("changed after packaging");
    expect(fixture.counts()).toEqual({ installerCalls: 0, relaunchCalls: 0 });
  });

  it("starts the installed development app in the tray after every install, running before or not, and reports a launch kept inside the job (A-135)", async () => {
    for (const [wasRunning, inJob, viaShell] of [[true, false, true], [false, true, false]] as const) {
      const fixture = devFixture();
      if (!wasRunning) fs.rmSync(path.join(fixture.runtime, "running-instance.json"));
      const launches: Array<{ exe: string; args: string[] }> = [];
      const launchOptions: unknown[] = [];
      const result = await runInstallDev({ ...fixture.options, background: true, relaunchFn: undefined, relaunchReadyTimeoutMs: 2_000,
        isProcessAliveFn: (pid: number) => (pid === 770077 ? wasRunning && fixture.options.isProcessAliveFn(pid) : pid === 770079),
        spawnInstallerFn: async () => {
          writeBuildInfo(fixture.resources, { version: fixture.version, channel: "development", commit: "2222222", builtAt: "2026-11-08T11:00:00.000Z", schemaVersion: 14 });
          return { status: 0 };
        },
        launchOutsideJobFn: (exe: string, args: string[], _env: unknown, optionsForLaunch: unknown) => {
          launches.push({ exe, args });
          launchOptions.push(optionsForLaunch);
          fs.writeFileSync(path.join(fixture.runtime, "running-instance.json"), JSON.stringify({ pid: 770079, channel: "development", testIdentity: true, execPath: fixture.executable, version: fixture.version, state: "ready" }));
          return { pid: 770079, inJob, viaShell };
        },
      });
      expect(result).toMatchObject({ status: "passed", installed: true, wasRunning, relaunched: true, background: true, inJob, viaShell, newVersion: fixture.version });
      expect(launches).toEqual([{ exe: fixture.executable, args: ["--background"] }]);
      // The fixture redirects the app's folders through its environment, which a desktop-shell launch would drop.
      expect(launchOptions).toEqual([{ viaDesktopShell: false }]);
    }
  });

  it("verifies explorer.exe parent so Windows PCA/shell jobs do not false-positive inJob on desktop-shell launches (A-135)", () => {
    const winRoot = ["W", "Windows"].join(":\\");
    const explorerExe = path.win32.join(winRoot, "Explorer.EXE");
    const fakeExplorer = path.win32.join(["W", "Temp"].join(":\\"), "explorer.exe");
    const cmdExe = path.win32.join(winRoot, "System32", "cmd.exe");

    expect(isExplorerExecutable(explorerExe, winRoot)).toBe(true);
    expect(isExplorerExecutable(path.win32.join(winRoot, "explorer.exe"), `${winRoot}\\`)).toBe(true);
    expect(isExplorerExecutable(fakeExplorer, winRoot)).toBe(false);
    expect(isExplorerExecutable(cmdExe, winRoot)).toBe(false);
    expect(isExplorerExecutable("", winRoot)).toBe(false);
    expect(isExplorerExecutable(explorerExe, "")).toBe(false);

    // Explorer child with raw IsProcessInJob=true (Windows PCA/shell or app-owned job) -> inJob: false.
    expect(resolveDesktopShellLaunch({
      pid: 35436,
      ppid: 8668,
      livePpid: 8668,
      selfPid: 100,
      parentExecutablePath: explorerExe,
      systemRoot: winRoot,
      rawInJob: true,
    })).toEqual({ pid: 35436, inJob: false, viaShell: true, parentIsExplorer: true });

    // Short-lived child already exited (livePpid: null) with live explorer.exe ppid -> inJob: false.
    expect(resolveDesktopShellLaunch({
      pid: 35436,
      ppid: 8668,
      livePpid: null,
      selfPid: 100,
      parentExecutablePath: explorerExe,
      systemRoot: winRoot,
      rawInJob: true,
    })).toEqual({ pid: 35436, inJob: false, viaShell: true, parentIsExplorer: true });

    // Live parent mismatch, self parent, or non-explorer parent fails closed to conservative rawInJob.
    expect(resolveDesktopShellLaunch({
      pid: 35436,
      ppid: 8668,
      livePpid: 9999,
      selfPid: 100,
      parentExecutablePath: explorerExe,
      systemRoot: winRoot,
      rawInJob: true,
    })).toEqual({ pid: 35436, inJob: true, viaShell: true, parentIsExplorer: false });

    expect(resolveDesktopShellLaunch({
      pid: 35436,
      ppid: 100,
      livePpid: 100,
      selfPid: 100,
      parentExecutablePath: explorerExe,
      systemRoot: winRoot,
      rawInJob: true,
    })).toEqual({ pid: 35436, inJob: true, viaShell: true, parentIsExplorer: false });

    expect(resolveDesktopShellLaunch({
      pid: 35436,
      ppid: 4242,
      livePpid: 4242,
      selfPid: 100,
      parentExecutablePath: cmdExe,
      systemRoot: winRoot,
      rawInJob: true,
    })).toEqual({ pid: 35436, inJob: true, viaShell: true, parentIsExplorer: false });
  });

  it("uses viaDesktopShell: true for real development installs when environment folders are not overridden (A-135)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-install-dev-shell-"));
    scratch.push(root);
    const localAppData = path.join(root, "local");
    const installDir = path.join(root, "Programs", "manga-dev");
    const resources = path.join(installDir, "resources");
    const runtime = path.join(localAppData, "manga-dev", "runtime");
    fs.mkdirSync(resources, { recursive: true });
    fs.mkdirSync(runtime, { recursive: true });
    const executable = path.join(installDir, "manga-dev.exe");
    fs.writeFileSync(executable, "synthetic development executable");
    const oldVersion = "0.1.2-dev.202611081000";
    const version = "0.1.2-dev.202611081100";
    writeBuildInfo(resources, { version: oldVersion, channel: "development", commit: "1111111", builtAt: "2026-11-08T10:00:00.000Z", schemaVersion: 14 });
    const installer = path.join(root, `manga-dev-setup-${version}.exe`);
    fs.writeFileSync(installer, "synthetic installer");

    const launchOptions: unknown[] = [];
    const result = await runInstallDev({
      testIdentity: false,
      installDir,
      installerPath: installer,
      newVersion: version,
      evidenceDir: null,
      registryEntries: [{ Key: "io.github.chialecode.manga-dev", DisplayName: "MANGA Dev", DisplayVersion: oldVersion, InstallLocation: installDir }],
      runningProcessesFn: () => [],
      isWindowOpenFn: () => false,
      env: { ...process.env, LOCALAPPDATA: localAppData, MANGA_DEV_AUTO_INSTALL: "1", CI: "", GITHUB_ACTIONS: "" },
      snapshotOptions: { registryEntries: [], localAppDataDir: path.join(root, "real-local"), roamingAppDataDir: path.join(root, "real-roaming"), desktopDir: path.join(root, "real-desktop"), registry: () => null },
      isProcessAliveFn: (pid: number) => pid === 770080,
      spawnInstallerFn: async () => {
        writeBuildInfo(resources, { version, channel: "development", commit: "2222222", builtAt: "2026-11-08T11:00:00.000Z", schemaVersion: 14 });
        return { status: 0 };
      },
      launchOutsideJobFn: (_exe: string, args: string[], _env: unknown, opts: unknown) => {
        launchOptions.push({ args, opts });
        fs.writeFileSync(path.join(runtime, "running-instance.json"), JSON.stringify({ pid: 770080, channel: "development", testIdentity: false, execPath: executable, version, state: "ready" }));
        return { pid: 770080, inJob: false, viaShell: true };
      },
      relaunchReadyTimeoutMs: 2_000,
    });
    expect(result).toMatchObject({ status: "passed", installed: true, relaunched: true, background: true, inJob: false, viaShell: true, newVersion: version,
      identity: "manga-dev", firstInstall: false, oldVersion, installLocation: "...\\manga-dev" });
    expect(launchOptions).toEqual([{ args: ["--background"], opts: { viaDesktopShell: true } }]);
  });

  it("waits while the development app shows a window, then installs; skips this build when the window stays open past the limit (A-139)", async () => {
    expect([WINDOW_POLL_MS, WINDOW_WAIT_MS]).toEqual([2_000, 600_000]);
    // The window closes (or goes to the tray) after three checks: then the app is asked to quit and the build is installed.
    const fixture = devFixture();
    let checks = 0;
    let quitRequests = 0;
    const checked: string[] = [];
    const result = await runInstallDev({ ...fixture.options, windowPollMs: 5,
      isWindowOpenFn: (exe: string) => { checked.push(exe); checks += 1; return checks <= 3; },
      requestQuitFn: async () => { quitRequests += 1; await fixture.options.requestQuitFn(); },
      spawnInstallerFn: async () => {
        writeBuildInfo(fixture.resources, { version: fixture.version, channel: "development", commit: "2222222", builtAt: "2026-11-08T11:00:00.000Z", schemaVersion: 14 });
        return { status: 0 };
      },
    });
    expect(result).toMatchObject({ status: "passed", installed: true, windowOpen: true, deferred: true, wasRunning: true, relaunched: true });
    expect(result.deferMs).toBeGreaterThanOrEqual(10);
    expect(checks).toBe(4);
    expect(new Set(checked)).toEqual(new Set([fixture.executable]));
    expect(quitRequests).toBe(1);

    // The window stays open: nothing is asked of the app, nothing is installed, and the skip is not a failure.
    const open = devFixture();
    let openQuitRequests = 0;
    const skipped = await runInstallDev({ ...open.options, windowPollMs: 5, windowWaitMs: 40, isWindowOpenFn: () => true,
      requestQuitFn: async () => { openQuitRequests += 1; },
    });
    expect(skipped).toMatchObject({ status: "skipped", skipped: true, reason: "window_open", installed: false, windowOpen: true, deferred: true });
    expect(skipped.deferMs).toBeGreaterThanOrEqual(40);
    expect(skipped.guidance).toContain("install-dev");
    expect(openQuitRequests).toBe(0);
    expect(open.counts()).toEqual({ installerCalls: 0, relaunchCalls: 0 });

    // A window check that fails is not taken for "no window".
    const broken = devFixture();
    const failed = await runInstallDev({ ...broken.options, isWindowOpenFn: () => { throw new Error("synthetic"); } });
    expect(failed).toMatchObject({ status: "failed", reason: "window_check_failed", installed: false });
    expect(broken.counts()).toEqual({ installerCalls: 0, relaunchCalls: 0 });
  });

  it("does not take an unreadable registry, or a development build installed without its identity's entry, for a first installation (A-139)", async () => {
    // The registry cannot be read: nothing is asked of the app and nothing is installed.
    const unreadable = devFixture();
    let checks = 0;
    const failed = await runInstallDev({ ...unreadable.options, registryEntries: undefined,
      readUninstallEntriesFn: () => { throw new Error("synthetic registry timeout"); }, isWindowOpenFn: () => { checks += 1; return false; } });
    expect(failed).toMatchObject({ status: "failed", reason: "registry_unreadable", installed: false });
    expect([checks, unreadable.counts()]).toEqual([0, { installerCalls: 0, relaunchCalls: 0 }]);

    // MANGA Dev (the real identity, in a synthetic LOCALAPPDATA) under an older installer's GUID entry, or a folder with no entry at all.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-install-dev-legacy-"));
    scratch.push(root);
    const local = path.join(root, "local");
    const folder = path.join(local, "Programs", "manga-dev");
    fs.mkdirSync(folder, { recursive: true });
    const guidEntry = { Key: "1ed31a6e-8dd9-52be-8f90-5052ea376f6f", DisplayName: "MANGA Dev", DisplayVersion: "0.1.2-dev.202611081000", InstallLocation: folder,
      UninstallString: `"${path.join(folder, "Uninstall manga-dev.exe")}" /currentuser` };
    const installer = path.join(root, "manga-dev-setup-0.1.2-dev.202611081100.exe");
    fs.writeFileSync(installer, "synthetic installer");
    for (const [registryEntries, exe] of [[[guidEntry], false], [[guidEntry], true], [[], true]] as const) {
      fs.rmSync(path.join(folder, "manga-dev.exe"), { force: true });
      if (exe) fs.writeFileSync(path.join(folder, "manga-dev.exe"), "synthetic development executable");
      let asked = 0;
      const legacy = await runInstallDev({
        env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "1", CI: "", GITHUB_ACTIONS: "", LOCALAPPDATA: local },
        installerPath: installer, newVersion: "0.1.2-dev.202611081100", evidenceDir: null, registryEntries: [...registryEntries],
        snapshotOptions: { registryEntries: [], localAppDataDir: path.join(root, "real-local"), roamingAppDataDir: path.join(root, "real-roaming"), desktopDir: path.join(root, "real-desktop"), registry: () => null },
        runningProcessesFn: () => { asked += 1; return []; }, isWindowOpenFn: () => { asked += 1; return true; },
        requestQuitFn: async () => { asked += 1; }, spawnInstallerFn: async () => { asked += 1; return { status: 0 }; },
      });
      expect(legacy).toMatchObject({ status: "failed", reason: "legacy_install", installed: false, firstInstall: false, installLocation: "%LOCALAPPDATA%\\Programs\\manga-dev" });
      expect(legacy.error).toContain("io.github.chialecode.manga-dev");
      expect(legacy.guidance).toContain("install-dev");
      expect(asked).toBe(0);
    }
  });

  it("keeps the gate's rehearsal rule for the test identity by default: reopen only an app that was running, with the caller's arguments (A-135)", async () => {
    const fixture = devFixture();
    fs.rmSync(path.join(fixture.runtime, "running-instance.json"));
    const result = await runInstallDev({ ...fixture.options, spawnInstallerFn: async () => {
      writeBuildInfo(fixture.resources, { version: fixture.version, channel: "development", commit: "2222222", builtAt: "2026-11-08T11:00:00.000Z", schemaVersion: 14 });
      return { status: 0 };
    } });
    expect(result).toMatchObject({ status: "passed", installed: true, wasRunning: false, relaunched: false, background: false });
    expect(fixture.counts().relaunchCalls).toBe(0);
    expect(launchArgsAfterInstall(["--manga-smoke"], false)).toEqual(["--manga-smoke"]);
    expect(launchArgsAfterInstall(["--background"], true)).toEqual(["--background"]);
  });

  it("quotes Windows command-line arguments and starts a process outside the job, or inside it when the job forbids leaving (A-135)", () => {
    expect(quoteWindowsArg("--background")).toBe("--background");
    expect(quoteWindowsArg(String.raw`Programs\MANGA Dev\manga.exe`)).toBe(String.raw`"Programs\MANGA Dev\manga.exe"`);
    expect(quoteWindowsArg('a"b')).toBe(String.raw`"a\"b"`);
    expect(quoteWindowsArg(String.raw`dir\ x\\`)).toBe(String.raw`"dir\ x\\\\"`);
    expect(quoteWindowsArg("")).toBe("\"\"");
    const systemRoot = process.env.SystemRoot;
    if (process.platform !== "win32" || !systemRoot) return;
    // A console program started detached opens no window and exits at once.
    const cmd = path.join(systemRoot, "System32", "cmd.exe");
    const started = launchOutsideJob(cmd, ["/d", "/c", "exit", "0"], process.env);
    expect(Number.isInteger(started.pid)).toBe(true);
    expect(typeof started.inJob).toBe("boolean");
    expect(started.viaShell).toBe(false);
    // Empty argument list must also succeed cleanly without failing on missing env var removal.
    const hostname = path.join(systemRoot, "System32", "hostname.exe");
    if (fs.existsSync(hostname)) {
      const noArgs = launchOutsideJob(hostname, [], process.env);
      expect(Number.isInteger(noArgs.pid)).toBe(true);
      expect(noArgs.viaShell).toBe(false);
    }
  }, 60_000);
});
