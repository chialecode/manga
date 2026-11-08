import { generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MangaProductApp, TestVault, rawPublicKey, writeBuildInfo } from "@manga/app-core";
import { inspectPublication } from "../../scripts/check-publication.mjs";
import { validateWorkflows } from "../../scripts/check-workflows.mjs";
import { runInstallDev } from "../../scripts/stage/install-dev.mjs";
import { decideWeeklyRelease } from "../../scripts/stage/release-decide.mjs";
import { publishVerifiedRelease, verifyReleasePublishArtifacts } from "../../scripts/stage/release-publish-verify.mjs";
import { runStageRelease } from "../../scripts/stage/release.mjs";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return dir;
}

function makeTestSigningKey(dir: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pubBase64 = rawPublicKey(publicKey).toString("base64");
  const keyPath = path.join(dir, "test-update-release.pem");
  fs.writeFileSync(keyPath, pem, "utf8");
  return {
    keyPath,
    pubBase64,
    publicKeys: [{ publicKey: pubBase64, label: "Test Release Key" }],
  };
}

function makeEmptySnapshotOptions(root: string) {
  const localAppDataDir = path.join(root, "fake-real-local");
  const roamingAppDataDir = path.join(root, "fake-real-roaming");
  const startMenuDir = path.join(roamingAppDataDir, "StartMenu");
  const desktopDir = path.join(root, "fake-real-desktop");
  const programsDir = path.join(localAppDataDir, "Programs");
  for (const d of [localAppDataDir, roamingAppDataDir, startMenuDir, desktopDir, programsDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return {
    localAppDataDir,
    roamingAppDataDir,
    startMenuDir,
    desktopDir,
    programsDir,
    registryEntries: [],
  };
}

describe("W2: Local development auto-update `stage install-dev` & `--quit-for-update` (AT-158)", () => {
  it("skips when MANGA_DEV_AUTO_INSTALL=0 or on CI, and when development channel is not installed, always writing install-dev.json (AT-158)", async () => {
    const temp = makeTempDir("manga-install-dev-skip-");
    const snapOpts = makeEmptySnapshotOptions(temp);

    // 1. MANGA_DEV_AUTO_INSTALL=0
    const outDisabled = path.join(temp, "disabled", "install-dev.json");
    const resDisabled = await runInstallDev({
      env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "0", CI: "" },
      outputFile: outDisabled,
      snapshotOptions: snapOpts,
    });
    expect(resDisabled.status).toBe("skipped");
    expect(resDisabled.skipReason).toBe("MANGA_DEV_AUTO_INSTALL=0");
    expect(resDisabled.releaseUntouched).toBe(true);
    expect(fs.existsSync(outDisabled)).toBe(true);

    // 2. CI=true
    const outCi = path.join(temp, "ci", "install-dev.json");
    const resCi = await runInstallDev({
      env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "1", CI: "true" },
      outputFile: outCi,
      snapshotOptions: snapOpts,
    });
    expect(resCi.status).toBe("skipped");
    expect(resCi.skipReason).toBe("CI environment");
    expect(resCi.releaseUntouched).toBe(true);
    expect(fs.existsSync(outCi)).toBe(true);

    // 3. Not installed
    const outNotInstalled = path.join(temp, "not-installed", "install-dev.json");
    const resNotInstalled = await runInstallDev({
      env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "1", CI: "", GITHUB_ACTIONS: "" },
      registryEntries: [],
      outputFile: outNotInstalled,
      snapshotOptions: snapOpts,
    });
    expect(resNotInstalled.status).toBe("skipped");
    expect(resNotInstalled.skipReason).toBe("development channel is not installed");
    expect(resNotInstalled.releaseUntouched).toBe(true);
    expect(fs.existsSync(outNotInstalled)).toBe(true);
  });

  it("saves unsaved draft on --quit-for-update, updates development channel, relaunches it with draft intact, and leaves running release channel completely untouched (AT-158)", async () => {
    const temp = makeTempDir("manga-install-dev-run-");
    const snapOpts = makeEmptySnapshotOptions(temp);
    const places = {
      programs: path.join(temp, "Programs"),
      local: path.join(temp, "local"),
      documents: path.join(temp, "documents"),
      downloads: path.join(temp, "downloads"),
    };
    for (const d of Object.values(places)) fs.mkdirSync(d, { recursive: true });

    // Set up isolated `MANGA Test` (release) installation + running instance + SQLite data.
    const relInstallDir = path.join(places.programs, "manga-test");
    const relResourcesDir = path.join(relInstallDir, "resources");
    fs.mkdirSync(relResourcesDir, { recursive: true });
    fs.writeFileSync(path.join(relInstallDir, "manga-test.exe"), "release-binary-v0.1.1");
    writeBuildInfo(relResourcesDir, {
      version: "0.1.1",
      channel: "release",
      commit: "c79f49a",
      builtAt: "2026-11-08T00:00:00.000Z",
      schemaVersion: 14,
    });
    const relDataDir = path.join(places.local, "manga-test", "data");
    const relRuntimeDir = path.join(places.local, "manga-test", "runtime");
    fs.mkdirSync(relDataDir, { recursive: true });
    fs.mkdirSync(relRuntimeDir, { recursive: true });
    fs.writeFileSync(path.join(relDataDir, "manga.sqlite"), "release-sqlite-bytes");
    fs.writeFileSync(
      path.join(relRuntimeDir, "running-instance.json"),
      JSON.stringify({ pid: process.pid, state: "ready", version: "0.1.1", channel: "release" }),
    );

    // Set up isolated `MANGA Dev Test` (development) installation + running MangaProductApp with unsaved note draft.
    const devInstallDir = path.join(places.programs, "manga-dev-test");
    const devResourcesDir = path.join(devInstallDir, "resources");
    fs.mkdirSync(devResourcesDir, { recursive: true });
    fs.writeFileSync(path.join(devInstallDir, "manga-dev-test.exe"), "dev-binary-old");
    writeBuildInfo(devResourcesDir, {
      version: "0.1.2-dev.202611081000",
      channel: "development",
      commit: "1111111",
      builtAt: "2026-11-08T10:00:00.000Z",
      schemaVersion: 14,
    });

    const devApp = new MangaProductApp({
      profileRoot: path.join(places.local, "manga-dev-test"),
      documentsDir: path.join(places.documents, "manga-dev-test"),
      downloadsDir: path.join(places.downloads, "manga-dev-test"),
      channel: "development",
      testIdentity: true,
      resourcesPath: devResourcesDir,
      vault: new TestVault(),
      ffmpegTools: null,
      buildInfo: {
        version: "0.1.2-dev.202611081000",
        channel: "development",
        commit: "1111111",
        builtAt: "2026-11-08T10:00:00.000Z",
        schemaVersion: 14,
      },
    });
    cleanups.push(() => devApp.close());
    await devApp.start();

    const fakeNewInstaller = path.join(temp, "manga-dev-test-setup-0.1.2-dev.202611081530.exe");
    fs.writeFileSync(fakeNewInstaller, "fake-installer-binary");

    let devAlive = true;
    let draftSavedBeforeExit = false;
    const outputFile = path.join(temp, "evidence", "install-dev.json");

    const result = await runInstallDev({
      env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "1", CI: "", GITHUB_ACTIONS: "" },
      testIdentity: true,
      places,
      installDir: devInstallDir,
      installerPath: fakeNewInstaller,
      newVersion: "0.1.2-dev.202611081530",
      runningPid: 424242,
      isProcessAliveFn: (pid: number) => (pid === 424242 ? devAlive : pid === process.pid),
      requestQuitFn: async () => {
        // Simulate renderer flushing unsaved note draft + main process prepareQuitForUpdate
        draftSavedBeforeExit = true;
        await devApp.prepareQuitForUpdate();
        devApp.close();
        devAlive = false;
      },
      spawnInstallerFn: async (_installer: string, _args: string[], targetDir: string) => {
        writeBuildInfo(path.join(targetDir, "resources"), {
          version: "0.1.2-dev.202611081530",
          channel: "development",
          commit: "2222222",
          builtAt: "2026-11-08T15:30:00.000Z",
          schemaVersion: 14,
        });
        return { status: 0 };
      },
      relaunchFn: async () => ({
        relaunched: true,
        pid: 434343,
        draftPreserved: draftSavedBeforeExit,
      }),
      outputFile,
      snapshotOptions: snapOpts,
    });

    expect(result.status).toBe("passed");
    expect(result.installed).toBe(true);
    expect(result.wasRunning).toBe(true);
    expect(result.relaunched).toBe(true);
    expect(result.previousVersion).toBe("0.1.2-dev.202611081000");
    expect(result.newVersion).toBe("0.1.2-dev.202611081530");
    expect(result.draftPreserved).toBe(true);
    expect(result.releaseUntouched).toBe(true);

    const writtenJson = fs.readFileSync(outputFile, "utf8");
    expect(inspectPublication("install-dev.json", Buffer.from(writtenJson)).findings).toEqual([]);
  });

  it("does not force-kill and aborts the update when a 60-second non-cancellable write prevents exit within timeout (AT-158)", async () => {
    const temp = makeTempDir("manga-install-dev-abort-");
    const snapOpts = makeEmptySnapshotOptions(temp);
    const places = {
      programs: path.join(temp, "Programs"),
      local: path.join(temp, "local"),
      documents: path.join(temp, "documents"),
      downloads: path.join(temp, "downloads"),
    };
    for (const d of Object.values(places)) fs.mkdirSync(d, { recursive: true });

    const devInstallDir = path.join(places.programs, "manga-dev-test");
    const devResourcesDir = path.join(devInstallDir, "resources");
    fs.mkdirSync(devResourcesDir, { recursive: true });
    fs.writeFileSync(path.join(devInstallDir, "manga-dev-test.exe"), "dev-binary-old");
    writeBuildInfo(devResourcesDir, {
      version: "0.1.2-dev.202611081000",
      channel: "development",
      commit: "1111111",
      builtAt: "2026-11-08T10:00:00.000Z",
      schemaVersion: 14,
    });

    const devApp = new MangaProductApp({
      profileRoot: path.join(places.local, "manga-dev-test"),
      documentsDir: path.join(places.documents, "manga-dev-test"),
      downloadsDir: path.join(places.downloads, "manga-dev-test"),
      channel: "development",
      testIdentity: true,
      resourcesPath: devResourcesDir,
      vault: new TestVault(),
      ffmpegTools: null,
      holdWriteMs: 60_000,
      buildInfo: {
        version: "0.1.2-dev.202611081000",
        channel: "development",
        commit: "1111111",
        builtAt: "2026-11-08T10:00:00.000Z",
        schemaVersion: 14,
      },
    });
    cleanups.push(() => devApp.close());
    await devApp.start();
    expect(devApp.hasBlockingWrites()).toBe(true);

    const fakeNewInstaller = path.join(temp, "manga-dev-test-setup-0.1.2-dev.202611081530.exe");
    fs.writeFileSync(fakeNewInstaller, "fake-installer-binary");

    let devExited = false;
    let installerCalled = false;
    const outputFile = path.join(temp, "evidence", "install-dev.json");

    const result = await runInstallDev({
      env: { ...process.env, MANGA_DEV_AUTO_INSTALL: "1", CI: "", GITHUB_ACTIONS: "" },
      testIdentity: true,
      places,
      installDir: devInstallDir,
      installerPath: fakeNewInstaller,
      newVersion: "0.1.2-dev.202611081530",
      quitTimeoutMs: 350,
      runningPid: 515151,
      isProcessAliveFn: () => !devExited,
      requestQuitFn: () => {
        // Start prepareQuitForUpdate in background; it blocks on the 60s write barrier.
        void devApp.prepareQuitForUpdate().then(() => {
          devExited = true;
        });
      },
      spawnInstallerFn: async () => {
        installerCalled = true;
        return { status: 0 };
      },
      outputFile,
      snapshotOptions: snapOpts,
    });

    expect(result.status).toBe("aborted");
    expect(result.installed).toBe(false);
    expect(result.wasRunning).toBe(true);
    expect(result.relaunched).toBe(false);
    expect(result.abortedPidStillAlive).toBe(true);
    expect(installerCalled).toBe(false);
    expect(result.reason).toContain("aborted without force-killing");
    expect(result.releaseUntouched).toBe(true);

    // Release the 60s write barrier and verify `prepareQuitForUpdate` now finishes cleanly.
    devApp.releaseBlockingWrites();
    await devApp.waitForBlockingWrites();
  });
});

describe("W5: One-command release `stage release` & upgrade rehearsal (AT-161)", () => {
  it("refuses when the working tree is dirty or when stage gate evidence is stale (AT-161)", async () => {
    const temp = makeTempDir("manga-release-prereq-");
    const keyInfo = makeTestSigningKey(temp);

    // 1. Dirty working tree
    await expect(
      runStageRelease({
        ci: false,
        gitStatusFn: () => " M apps/desktop/package.json",
        signingKeyPath: keyInfo.keyPath,
        releaseRootDir: path.join(temp, "release"),
      }),
    ).rejects.toThrow(/working tree is not clean/);

    // 2. Stale / failed gate evidence
    await expect(
      runStageRelease({
        ci: false,
        gitStatusFn: () => "",
        branchCheckFn: () => ({ ok: true }),
        gateEvaluateFn: () => ({
          automationStatus: "failed-or-incomplete",
          errors: ["package.json: missing or stale sourceFingerprint"],
        }),
        signingKeyPath: keyInfo.keyPath,
        releaseRootDir: path.join(temp, "release"),
      }),
    ).rejects.toThrow(/stage gate evidence is missing or stale: package\.json: missing or stale sourceFingerprint/);
  });

  it("generates all signed release artifacts, runs upgrade rehearsal, does not publish without authorization, and stops when rehearsal installer is tampered (AT-161)", async () => {
    const temp = makeTempDir("manga-release-run-");
    const snapOpts = makeEmptySnapshotOptions(temp);
    const keyInfo = makeTestSigningKey(temp);
    const releaseRootDir = path.join(temp, "dist-release");
    const evidenceDir = path.join(temp, "evidence");
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDir, "bench.json"),
      JSON.stringify({ status: "passed", sourceFingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    );

    const execCalls: Array<{ cmd: string; args: string[] }> = [];
    const result = await runStageRelease({
      ci: false,
      publish: false,
      version: "0.1.2",
      stage: "m10",
      fingerprints: {
        sourceFingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        lockFingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        buildScriptFingerprint: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        gateScriptFingerprint: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      },
      gitStatusFn: () => "",
      branchCheckFn: () => ({ ok: true }),
      gateEvaluateFn: () => ({ automationStatus: "self-check-passed", errors: [] }),
      gitInputs: {
        tags: ["v0.1.1"],
        commitsSinceTag: ["c79f49a\tfeat: 支持自动更新与每周发布 (#10)"],
        headSha: "c79f49a000000000000000000000000000000000",
      },
      signingKeyPath: keyInfo.keyPath,
      publicKeys: keyInfo.publicKeys,
      releaseRootDir,
      evidenceDir,
      snapshotOptions: snapOpts,
      buildReleaseInstallerFn: async ({ installerOutPath }: { installerOutPath: string }) => {
        fs.writeFileSync(installerOutPath, randomBytes(24 * 1024));
      },
      execFn: (cmd: string, args: string[]) => {
        execCalls.push({ cmd, args });
        return { status: 0, stdout: "", stderr: "" };
      },
    });

    expect(result.status).toBe("passed");
    expect(result.version).toBe("0.1.2");
    expect(result.tag).toBe("v0.1.2");
    expect(result.published).toBe(false);
    expect(result.releaseUrl).toBeNull();
    expect(result.requiresAuthorization).toContain("release-publish-verify.mjs --version 0.1.2");
    expect(result.benchMatchesSource).toBe(true);
    expect(result.rehearsal.ok).toBe(true);
    expect(result.rehearsal.previousVersion).toBe("0.1.1");
    expect(result.rehearsal.kind).toBe("service-fixtures");
    expect(result.rehearsal.upgradedVersion).toBe("0.1.2");
    expect(result.rehearsal.dataIntact).toBe(true);
    expect(result.rehearsal.backupCreated).toBe(true);
    expect(result.rehearsal.tamperedRejected).toBe(true);
    expect(result.rehearsal.realInstallationsUntouched).toBe(true);
    expect(execCalls).toHaveLength(0);

    const vDir = path.join(releaseRootDir, "v0.1.2");
    for (const file of [
      "manga-setup-0.1.2.exe",
      "manga-setup-0.1.2.exe.blockmap",
      "manga-setup-0.1.2.exe.sig",
      "latest.yml",
      "RELEASE-NOTES.md",
      "SHA256SUMS",
      "release.json",
    ]) {
      expect(fs.existsSync(path.join(vDir, file))).toBe(true);
    }

    const releaseJsonBytes = fs.readFileSync(path.join(vDir, "release.json"));
    expect(inspectPublication("release.json", releaseJsonBytes).findings).toEqual([]);

    const verified = verifyReleasePublishArtifacts({
      dir: vDir,
      version: "0.1.2",
      publicKeyBase64: keyInfo.pubBase64,
    });
    expect(verified.ok).toBe(true);

    // Now test rehearsal failure when the main installer is tampered by 1 byte (`tamperRehearsal: true`, AT-161):
    await expect(
      runStageRelease({
        ci: false,
        publish: false,
        version: "0.1.3",
        stage: "m10",
        fingerprints: { sourceFingerprint: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        gitStatusFn: () => "",
        branchCheckFn: () => ({ ok: true }),
        gateEvaluateFn: () => ({ automationStatus: "self-check-passed", errors: [] }),
        gitInputs: {
          tags: ["v0.1.2"],
          commitsSinceTag: ["aaaa111\tfix: 修复更新演练 (#11)"],
          headSha: "aaaa111000000000000000000000000000000000",
        },
        signingKeyPath: keyInfo.keyPath,
        publicKeys: keyInfo.publicKeys,
        releaseRootDir,
        evidenceDir,
        snapshotOptions: snapOpts,
        tamperRehearsal: true,
        buildReleaseInstallerFn: async ({ installerOutPath }: { installerOutPath: string }) => {
          fs.writeFileSync(installerOutPath, randomBytes(24 * 1024));
        },
      }),
    ).rejects.toThrow(/upgrade rehearsal failed/);

    // Failed rehearsal must clean up `dist/release/v0.1.3` so no broken release artifacts remain.
    expect(fs.existsSync(path.join(releaseRootDir, "v0.1.3"))).toBe(false);
  });
});

describe("W9: GitHub Actions weekly release workflow, `decideWeeklyRelease`, and `--ci` missing-key guard (AT-163)", () => {
  it("statically validates `.github/workflows/release.yml` and rejects security boundary violations (AT-163)", () => {
    const valid = validateWorkflows();
    expect(valid.ok).toBe(true);
    expect(valid.errors).toEqual([]);

    const releaseYaml = fs.readFileSync(path.resolve(".github/workflows/release.yml"), "utf8");

    // 1. Adding pull_request trigger must fail
    const withPrTrigger = releaseYaml.replace("on:\n", "on:\n  pull_request:\n");
    expect(validateWorkflows({ releaseYamlText: withPrTrigger }).ok).toBe(false);

    // 2. Referencing a secret in `check` job must fail
    const withCheckSecret = releaseYaml.replace(
      "node scripts/verify.mjs",
      "echo ${{ secrets.MANGA_UPDATE_SIGNING_KEY_PEM }}\n          node scripts/verify.mjs",
    );
    expect(validateWorkflows({ releaseYamlText: withCheckSecret }).ok).toBe(false);

    // 3. Unpinned action tag must fail
    const withUnpinnedAction = releaseYaml.replace(
      "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
      "actions/upload-artifact@v7.0.2",
    );
    expect(validateWorkflows({ releaseYamlText: withUnpinnedAction }).ok).toBe(false);

    // 4. Installing dependencies in `publish` job must fail
    const withPublishInstall = releaseYaml.replace(
      "node scripts/stage/release-publish-verify.mjs",
      "pnpm install --frozen-lockfile\n          node scripts/stage/release-publish-verify.mjs",
    );
    expect(validateWorkflows({ releaseYamlText: withPublishInstall }).ok).toBe(false);

    // A failing native command cannot be hidden by a successful later command in pwsh.
    const withoutExitCheck = releaseYaml.replace(
      /(node scripts\/verify\.mjs[^\n]*\n)\s*if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}\n/,
      "$1",
    );
    expect(withoutExitCheck).not.toBe(releaseYaml);
    expect(validateWorkflows({ releaseYamlText: withoutExitCheck }).ok).toBe(false);
  });

  it("handles all 3 `decideWeeklyRelease` scenarios: no tag, no commits since tag, and 2 merged PRs since tag (AT-163)", () => {
    // Scenario 1: No v0.1.* tag yet -> release 0.1.1
    const first = decideWeeklyRelease({
      tags: [],
      commitsSinceTag: ["c79f49a\tfeat: 待审操作与门禁提速 (#9)"],
      headSha: "c79f49a",
    });
    expect(first.shouldRelease).toBe(true);
    expect(first.version).toBe("0.1.1");
    expect(first.tag).toBe("v0.1.1");
    expect(first.previousTag).toBeNull();
    expect(first.notesMarkdown).toContain("PR #9");

    // Scenario 2: Highest tag v0.1.3 has 0 new commits -> skip
    const skipped = decideWeeklyRelease({
      tags: ["v0.1.1", "v0.1.3", "v0.1.2"],
      commitsSinceTag: [],
      headSha: "c79f49a",
    });
    expect(skipped.shouldRelease).toBe(false);
    expect(skipped.version).toBeNull();
    expect(skipped.previousTag).toBe("v0.1.3");
    expect(skipped.reason).toBe("本周没有新的合并");

    // Scenario 3: Highest tag v0.1.3 has 2 merged PRs -> release 0.1.4 and list both PRs in Chinese release notes
    const next = decideWeeklyRelease({
      tags: ["v0.1.1", "v0.1.3"],
      commitsSinceTag: [
        "1111111\tfeat: 安装与自动更新 (#10)",
        "2222222\tchore(deps): 升级 electron-updater (#11)",
      ],
      headSha: "2222222",
      schemaVersion: 15,
      previousSchemaVersion: 14,
      willUpgradeSchema: true,
    });
    expect(next.shouldRelease).toBe(true);
    expect(next.version).toBe("0.1.4");
    expect(next.tag).toBe("v0.1.4");
    expect(next.previousTag).toBe("v0.1.3");
    expect(next.pullRequests).toHaveLength(2);
    expect(next.notesMarkdown).toContain("重要提示（资料库升级）");
    expect(next.notesMarkdown).toContain("[PR #10](https://github.com/chialecode/manga/pull/10)");
    expect(next.notesMarkdown).toContain("[PR #11](https://github.com/chialecode/manga/pull/11)");
  });

  it("fails immediately when `stage release --ci` runs without a signing key and leaves no unsigned package behind (AT-163)", async () => {
    const temp = makeTempDir("manga-release-nokey-");
    const releaseRootDir = path.join(temp, "dist-release");
    const missingKeyPath = path.join(temp, "non-existent-update-key.pem");

    await expect(
      runStageRelease({
        ci: true,
        version: "0.1.2",
        gitStatusFn: () => "",
        signingKeyPath: missingKeyPath,
        releaseRootDir,
        buildReleaseInstallerFn: async ({ installerOutPath }: { installerOutPath: string }) => {
          fs.writeFileSync(installerOutPath, "should-never-be-called");
        },
      }),
    ).rejects.toThrow(/update signing private key is missing/);

    expect(fs.existsSync(path.join(releaseRootDir, "v0.1.2"))).toBe(false);
  });

  it("refuses to publish in `publishVerifiedRelease` when the tag already exists or when SHA256SUMS is tampered (AT-163)", async () => {
    const temp = makeTempDir("manga-publish-verify-");
    const snapOpts = makeEmptySnapshotOptions(temp);
    const keyInfo = makeTestSigningKey(temp);
    const releaseRootDir = path.join(temp, "dist-release");

    await runStageRelease({
      ci: true,
      publish: false,
      version: "0.1.2",
      gitStatusFn: () => "",
      gitInputs: { tags: ["v0.1.1"], commitsSinceTag: ["c79f49a\tfeat: update (#10)"], headSha: "c79f49a000000000000000000000000000000000" },
      signingKeyPath: keyInfo.keyPath,
      publicKeys: keyInfo.publicKeys,
      releaseRootDir,
      writeEvidenceReleaseJson: false,
      snapshotOptions: snapOpts,
      buildReleaseInstallerFn: async ({ installerOutPath }: { installerOutPath: string }) => {
        fs.writeFileSync(installerOutPath, randomBytes(16 * 1024));
      },
    });

    const vDir = path.join(releaseRootDir, "v0.1.2");

    // Service fixtures cannot authorize publication. An explicit synthetic packaged result
    // below isolates the tag/gh guards; every external command is stubbed.
    expect(() => publishVerifiedRelease({ dir: vDir, version: "0.1.2", publicKeyBase64: keyInfo.pubBase64 })).toThrow(/real Electron\/NSIS/);
    const recordPath = path.join(vDir, "release.json");
    const fixtureRecord = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    fixtureRecord.rehearsal.kind = "electron-nsis";
    fs.writeFileSync(recordPath, JSON.stringify(fixtureRecord));

    // 1. Existing git tag is refused
    expect(() =>
      publishVerifiedRelease({
        dir: vDir,
        version: "0.1.2",
        publicKeyBase64: keyInfo.pubBase64,
        execFn: (cmd: string, args: string[]) => {
          if (cmd === "git" && args[0] === "tag") {
            return { status: 0, stdout: "v0.1.2\n", stderr: "" };
          }
          return { status: 1, stdout: "", stderr: "" };
        },
      }),
    ).toThrow(/git tag v0\.1\.2 already exists/);

    // 2. Tampering 1 byte of installer causes verifyReleasePublishArtifacts to fail on SHA256SUMS
    const installerPath = path.join(vDir, "manga-setup-0.1.2.exe");
    const orig = fs.readFileSync(installerPath);
    const modded = Buffer.from(orig);
    modded[0] ^= 0xff;
    fs.writeFileSync(installerPath, modded);

    expect(() =>
      verifyReleasePublishArtifacts({
        dir: vDir,
        version: "0.1.2",
        publicKeyBase64: keyInfo.pubBase64,
      }),
    ).toThrow(/SHA-256 mismatch/);
  });
});
