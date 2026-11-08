import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { writeBuildInfo } from "@manga/app-core";
import { findDefaultDevInstaller, runInstallDev } from "../../scripts/stage/install-dev.mjs";
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
    registryEntries: [], runningProcessesFn: () => [],
    env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "1", CI: "", GITHUB_ACTIONS: "" },
    snapshotOptions: { registryEntries: [], localAppDataDir: path.join(root, "real-local"), roamingAppDataDir: path.join(root, "real-roaming"), desktopDir: path.join(root, "real-desktop") },
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
        expect(result.skipReason).toBe("this build is already installed");
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
    const find = () => findDefaultDevInstaller({ fingerprints, latestFile, desktopRoot, workspaceRoot: fixture.root });
    write(latest);
    expect(find()).toEqual({ file: selected, sha256: latest.installer.sha256 });
    write({ ...latest, sourceFingerprint: "d".repeat(64) });
    expect(find()).toBeNull();
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
    expect(result.reason).toContain("changed after packaging");
    expect(fixture.counts()).toEqual({ installerCalls: 0, relaunchCalls: 0 });
  });
});
