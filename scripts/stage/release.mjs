import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MangaProductApp, TestVault } from "../../packages/app-core/src/index.ts";
import { inspectPublication } from "../check-publication.mjs";
import { desktopPackageDir, latestDesktopPackage, updateSigningKeyFile } from "../desktop-paths.ts";
import {
  TEST_CHANNEL_INSTALL,
  appUpdateYaml,
  buildInstaller,
  buildInstallerBlockMap,
  compareRealInstallations,
  snapshotRealInstallations,
} from "./installer-lib.mjs";
import { currentStage, fingerprintKeysOf, loadGate, packagedFingerprintKeys, readJson, repoRoot, runDir, stageFingerprints } from "./lib.mjs";
import { decideWeeklyRelease, formatReleaseNotesMarkdown, readGitWeeklyReleaseInputs } from "./release-decide.mjs";
import { publishVerifiedRelease, verifyReleasePublishArtifacts } from "./release-publish-verify.mjs";
import { loadPreviousRelease } from "./release-previous.mjs";
import { runPackagedUpdateRehearsal } from "./update-rehearsal.mjs";
import { evaluateStageEvidence } from "./report.mjs";
import {
  BUILD_SCHEMA_VERSION,
  RELEASE_UPDATE_PUBLIC_KEYS,
  buildBlockMap,
  computeNextReleaseVersion,
  formatLatestYaml,
  readBuildInfoIfPresent,
  readGitShortCommit,
  readGitTags,
  serializeBlockMapGzip,
  sha512BytesBase64,
  signReleaseInstaller,
} from "./version-lib.mjs";

function sha256HexFile(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function defaultGitStatusPorcelain(cwd) {
  const res = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", windowsHide: true });
  if (res.status !== 0) throw new Error("failed to read git status");
  return (res.stdout ?? "").trim();
}

function defaultCheckBranchSync(cwd, expectedBranch = "main", checkRemoteSync = true) {
  const branchRes = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", windowsHide: true });
  const branch = (branchRes.stdout ?? "").trim();
  if (expectedBranch && branch !== expectedBranch) {
    return {
      ok: false,
      reason: `current branch is "${branch}", expected "${expectedBranch}"`,
    };
  }
  if (checkRemoteSync && expectedBranch === "main") {
    const headRes = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", windowsHide: true });
    const originRes = spawnSync("git", ["rev-parse", "origin/main"], { cwd, encoding: "utf8", windowsHide: true });
    if (headRes.status !== 0 || originRes.status !== 0) return { ok: false, reason: "could not verify HEAD against origin/main" };
    if (headRes.status === 0 && originRes.status === 0) {
      const headSha = (headRes.stdout ?? "").trim();
      const originSha = (originRes.stdout ?? "").trim();
      if (headSha && originSha && headSha !== originSha) {
        return {
          ok: false,
          reason: `HEAD (${headSha.slice(0, 7)}) does not match origin/main (${originSha.slice(0, 7)})`,
        };
      }
    }
  }
  return { ok: true };
}

async function startLoopbackReleaseServer(initialFiles) {
  const files = new Map(Object.entries(initialFiles));
  const server = http.createServer((req, res) => {
    const cleanPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/").replace(/^\/+/, "");
    const item = files.get(cleanPath);
    if (item === undefined) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    const buf = typeof item === "string" ? Buffer.from(item, "utf8") : Buffer.from(item);
    const rangeHeader = req.headers.range;
    if (typeof rangeHeader === "string" && rangeHeader.startsWith("bytes=")) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
      if (m) {
        const start = Number.parseInt(m[1], 10);
        const end = m[2] ? Number.parseInt(m[2], 10) : buf.length - 1;
        if (start >= 0 && start < buf.length && end >= start && end < buf.length) {
          const slice = buf.subarray(start, end + 1);
          res.statusCode = 206;
          res.setHeader("Content-Range", `bytes ${start}-${end}/${buf.length}`);
          res.setHeader("Content-Length", String(slice.length));
          res.end(slice);
          return;
        }
      }
    }
    res.statusCode = 200;
    res.setHeader("Content-Length", String(buf.length));
    res.end(buf);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    files,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * Run a real packaged rehearsal, or the explicitly labelled service fixture used by script unit tests.
 * 1. Snapshot real installations (`MANGA` and `MANGA Dev`).
 * 2. In a temporary directory with `testIdentity: true` (`MANGA Test`), install/prepare previous version `0.1.0` and create sample user data.
 * 3. Serve the new `version` release from a loopback fake release server; run `check` -> download -> Ed25519 verify -> `restartToUpdate` -> restart into `version`.
 * 4. Verify the upgraded version is `version`, `justUpdated` is populated, sample user data is intact, and pre-update backup exists.
 * 5. Serve a 1-byte tampered installer for the next patch version and confirm it is rejected with `UPDATE_VERIFY_FAILED`.
 * 6. Clean up the temporary directory and test-identity installation, and verify real installations are 100% untouched.
 */
export async function runReleaseUpgradeRehearsal({
  version,
  previousVersion = "0.1.0",
  outDir,
  appDir,
  publicKeys = RELEASE_UPDATE_PUBLIC_KEYS,
  tamperMainInstaller = false,
  useNsisInstallers = false,
  snapshotOptions = {},
  previousAppDir = appDir,
  previousRelease,
} = {}) {
  if (useNsisInstallers) {
    return runPackagedUpdateRehearsal({ appDir, previousAppDir, version, previousVersion, previousRelease, snapshotOptions, tamperMainInstaller });
  }
  const startedMs = Date.now();
  const realBefore = snapshotRealInstallations(snapshotOptions);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "manga-release-rehearsal-"));
  const places = {
    programs: path.join(tempRoot, "Programs"),
    installDir: path.join(tempRoot, "Programs", TEST_CHANNEL_INSTALL.release.dirName),
    resourcesDir: path.join(tempRoot, "Programs", TEST_CHANNEL_INSTALL.release.dirName, "resources"),
    profileRoot: path.join(tempRoot, "local", TEST_CHANNEL_INSTALL.release.dirName),
    documentsDir: path.join(tempRoot, "documents", TEST_CHANNEL_INSTALL.release.dirName),
    downloadsDir: path.join(tempRoot, "downloads", TEST_CHANNEL_INSTALL.release.dirName),
    buildWorkDir: path.join(tempRoot, "build"),
  };
  for (const dir of Object.values(places)) fs.mkdirSync(dir, { recursive: true });

  const installerFileName = `manga-setup-${version}.exe`;
  const installerDiskBytes = fs.readFileSync(path.join(outDir, installerFileName));
  const blockMapBytes = fs.readFileSync(path.join(outDir, `${installerFileName}.blockmap`));
  const sigText = fs.readFileSync(path.join(outDir, `${installerFileName}.sig`), "utf8");
  const latestYaml = fs.readFileSync(path.join(outDir, "latest.yml"), "utf8");

  const servedInstallerBytes = Buffer.from(installerDiskBytes);
  if (tamperMainInstaller && servedInstallerBytes.length > 0) {
    servedInstallerBytes[Math.floor(servedInstallerBytes.length / 2)] ^= 0xff;
  }

  const server = await startLoopbackReleaseServer({
    "latest.yml": latestYaml,
    [installerFileName]: servedInstallerBytes,
    [`${installerFileName}.blockmap`]: blockMapBytes,
    [`${installerFileName}.sig`]: sigText,
  });

  let appOld = null;
  let appNew = null;
  try {
    fs.writeFileSync(path.join(places.resourcesDir, "app-update.yml"), appUpdateYaml(), "utf8");
    fs.writeFileSync(path.join(places.resourcesDir, "build.json"), `${JSON.stringify({
      version: previousVersion, channel: "release", commit: "0000000",
      builtAt: "2026-11-01T00:00:00.000Z", schemaVersion: BUILD_SCHEMA_VERSION,
    })}\n`);

    let executedUpgrade = false;
    appOld = new MangaProductApp({
      profileRoot: places.profileRoot,
      // The launcher pointer goes under the rehearsal's own LOCALAPPDATA, never the real one's test-identity folder.
      localAppDataDir: path.dirname(places.profileRoot),
      documentsDir: places.documentsDir,
      downloadsDir: places.downloadsDir,
      channel: "release",
      testIdentity: true,
      packaged: true,
      resourcesPath: places.resourcesDir,
      vault: new TestVault(),
      ffmpegTools: null,
      buildInfo: {
        version: previousVersion,
        channel: "release",
        commit: "0000000",
        builtAt: "2026-11-01T00:00:00.000Z",
        schemaVersion: BUILD_SCHEMA_VERSION,
      },
      update: {
        feedUrl: server.baseUrl,
        allowLoopbackHttp: true,
        publicKeys,
        appUpdateConfigPath: path.join(places.resourcesDir, "app-update.yml"),
        installDirectory: places.installDir,
        runInstaller: (_verifiedPath, _args, _mode) => {
          executedUpgrade = true;
          fs.writeFileSync(path.join(places.resourcesDir, "build.json"), `${JSON.stringify({
            version, channel: "release", commit: "1111111",
            builtAt: new Date().toISOString(), schemaVersion: BUILD_SCHEMA_VERSION,
          })}\n`);
          return true;
        },
      },
    });
    await appOld.start();
    const actor = { kind: "user", id: "rehearsal-user" };
    const grantOld = appOld.issueOwnerGrant(actor).handle;

    // Seed sample user data in 0.1.0 before upgrading.
    const noteRes = await appOld.call(
      actor,
      {
        commandId: "notes.create",
        idempotencyKey: "rehearsal-note-1",
        input: { title: "升级演练笔记", text: "升级前保存的数据" },
      },
      grantOld,
    );
    if (noteRes.status !== "ok") {
      throw new Error("rehearsal failed to create sample note before upgrade");
    }

    const checkRes = await appOld.call(
      actor,
      { commandId: "update.check", idempotencyKey: "rehearsal-check-1", input: {} },
      grantOld,
    );
    if (checkRes.status !== "ok") {
      throw new Error(`rehearsal update.check failed: ${checkRes.error?.message ?? "unknown"}`);
    }
    const checkStatus = checkRes.value;
    if (checkStatus.state !== "ready") {
      throw new Error(`upgrade rehearsal failed: update did not reach ready state (state=${String(checkStatus.state)}, errorCode=${String(checkStatus.errorCode)}, error=${String(checkStatus.error)})`);
    }

    const restartRes = await appOld.call(
      actor,
      { commandId: "update.restartToUpdate", idempotencyKey: "rehearsal-restart-1", input: { force: true } },
      grantOld,
    );
    if (restartRes.status !== "ok" || restartRes.value?.status !== "restarting" || !executedUpgrade) {
      throw new Error("upgrade rehearsal failed to execute restartToUpdate");
    }

    appOld.close();
    appOld = null;

    const afterBuild = readBuildInfoIfPresent(places.resourcesDir);
    if (afterBuild?.version !== version) {
      throw new Error(`upgrade rehearsal version mismatch after install: expected ${version}, got ${String(afterBuild?.version)}`);
    }

    // Boot upgraded version (`version`) on the same profile and verify data, backup, and 1-byte tampered rejection.
    appNew = new MangaProductApp({
      profileRoot: places.profileRoot,
      // The launcher pointer goes under the rehearsal's own LOCALAPPDATA, never the real one's test-identity folder.
      localAppDataDir: path.dirname(places.profileRoot),
      documentsDir: places.documentsDir,
      downloadsDir: places.downloadsDir,
      channel: "release",
      testIdentity: true,
      packaged: true,
      resourcesPath: places.resourcesDir,
      vault: new TestVault(),
      ffmpegTools: null,
      buildInfo: {
        version,
        channel: "release",
        commit: afterBuild?.commit ?? "1111111",
        builtAt: afterBuild?.builtAt ?? new Date().toISOString(),
        schemaVersion: BUILD_SCHEMA_VERSION,
      },
      update: {
        feedUrl: server.baseUrl,
        allowLoopbackHttp: true,
        publicKeys,
        appUpdateConfigPath: path.join(places.resourcesDir, "app-update.yml"),
        installDirectory: places.installDir,
      },
    });
    await appNew.start();
    const grantNew = appNew.issueOwnerGrant(actor).handle;

    const statusNewRes = await appNew.call(
      actor,
      { commandId: "update.status", idempotencyKey: "rehearsal-status-new", input: {} },
      grantNew,
    );
    const statusNew = statusNewRes.value;
    const justUpdatedOk = statusNew?.justUpdated?.version === version && statusNew?.justUpdated?.previousVersion === previousVersion;
    if (!justUpdatedOk) {
      throw new Error("upgrade rehearsal did not record justUpdated on first launch after upgrade");
    }

    const wsRes = await appNew.call(
      actor,
      { commandId: "workspace.get", idempotencyKey: "rehearsal-ws-new", input: {} },
      grantNew,
    );
    const notes = wsRes.value?.notes ?? [];
    const dataIntact = Array.isArray(notes) && notes.some((n) => n.title === "升级演练笔记");
    if (!dataIntact) {
      throw new Error("upgrade rehearsal lost sample note data across upgrade");
    }

    const preupdateBackup = path.join(places.profileRoot, "backups", `manga.sqlite.preupdate-v${previousVersion}.sqlite`);
    const backupCreated = fs.existsSync(preupdateBackup) && fs.statSync(preupdateBackup).size > 0;
    if (!backupCreated) {
      throw new Error("upgrade rehearsal did not create pre-update SQLite backup");
    }

    // Confirm a 1-byte tampered installer for the next patch version is rejected with UPDATE_VERIFY_FAILED (计划 4.5 第 3 步, AT-161).
    const nextPatch = Number.parseInt(version.split(".")[2] ?? "1", 10) + 1;
    const tamperedVersion = `0.1.${nextPatch}`;
    const tamperedFileName = `manga-setup-${tamperedVersion}.exe`;
    const tamperedBytes = Buffer.from(installerDiskBytes);
    tamperedBytes[0] ^= 0xff;
    server.files.set(
      "latest.yml",
      formatLatestYaml({
        version: tamperedVersion,
        fileName: tamperedFileName,
        sha512: sha512BytesBase64(installerDiskBytes),
        size: tamperedBytes.length,
        schemaVersion: BUILD_SCHEMA_VERSION,
        releaseNotes: "Tampered test release",
      }),
    );
    server.files.set(tamperedFileName, tamperedBytes);
    server.files.set(`${tamperedFileName}.sig`, sigText);

    const tamperedCheckRes = await appNew.call(
      actor,
      { commandId: "update.check", idempotencyKey: "rehearsal-tampered-check", input: {} },
      grantNew,
    );
    const tamperedStatus = tamperedCheckRes.value;
    const tamperedRejected = tamperedStatus?.state === "error" && tamperedStatus?.errorCode === "UPDATE_VERIFY_FAILED";
    if (!tamperedRejected) {
      throw new Error("upgrade rehearsal failed to reject 1-byte tampered installer with UPDATE_VERIFY_FAILED");
    }

    appNew.close();
    appNew = null;


    const realAfter = snapshotRealInstallations(snapshotOptions);
    const realComparison = compareRealInstallations(realBefore, realAfter);
    if (!realComparison.ok) {
      throw new Error(`upgrade rehearsal modified real installation: ${realComparison.changes.join("; ")}`);
    }

    return {
      ok: true,
      kind: "service-fixtures",
      previousVersion,
      upgradedVersion: version,
      dataIntact: true,
      backupCreated: true,
      tamperedRejected: true,
      realInstallationsUntouched: true,
      seconds: Number(((Date.now() - startedMs) / 1000).toFixed(2)),
    };
  } finally {
    try { appOld?.close(); } catch { /* ignore */ }
    try { appNew?.close(); } catch { /* ignore */ }
    await server.close();
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // ignore
    }
  }
}

/**
 * One-command release pipeline (`node scripts/stage.mjs release [--ci] [--version <0.1.x>] [--publish]`, 计划 4.5, 4.9, AT-161, AT-163).
 */
export async function runStageRelease(options = {}) {
  const startedMs = Date.now();
  const cwd = options.cwd ?? repoRoot;
  const ci = options.ci ?? process.argv.includes("--ci");
  const publish = options.publish ?? (process.env.MANGA_RELEASE_PUBLISH === "1" && process.argv.includes("--publish"));
  const evidenceDir = options.evidenceDir ?? runDir();
  const releaseRootDir = options.releaseRootDir ?? path.join(cwd, "dist/release");
  const signingKeyPath = options.signingKeyPath
    ?? (process.env.MANGA_UPDATE_SIGNING_KEY?.trim() || updateSigningKeyFile);

  // ---- Step 1: Prerequisites (前提) ----
  const gitStatus = options.gitStatusFn ? options.gitStatusFn(cwd) : defaultGitStatusPorcelain(cwd);
  if (gitStatus.length > 0) {
    throw new Error("working tree is not clean; commit or stash all changes before running stage release");
  }

  const stage = options.stage ?? currentStage();
  const config = options.gateConfig ?? loadGate();
  const fingerprints = { ...stageFingerprints(cwd, config), ...options.fingerprints };

  if (!ci) {
    const branchCheck = options.branchCheckFn
      ? options.branchCheckFn(cwd)
      : defaultCheckBranchSync(cwd, options.expectedBranch ?? "main", options.checkRemoteSync ?? true);
    if (!branchCheck.ok) {
      throw new Error(`release branch check failed: ${branchCheck.reason}`);
    }

    const gateEvaluation = options.gateEvaluateFn
      ? options.gateEvaluateFn(evidenceDir, fingerprints, config)
      : evaluateStageEvidence(evidenceDir, fingerprints, config);
    if (gateEvaluation.automationStatus !== "self-check-passed" || (gateEvaluation.errors ?? []).length > 0) {
      throw new Error(`stage gate evidence is missing or stale: ${(gateEvaluation.errors ?? ["not passed"]).join("; ")}`);
    }
  }

  const gitInputs = options.gitInputs ?? readGitWeeklyReleaseInputs(cwd);
  const decision = decideWeeklyRelease({
    ...gitInputs,
    ciMode: ci,
    schemaVersion: BUILD_SCHEMA_VERSION,
  });
  const version = (options.version ?? decision.version ?? computeNextReleaseVersion(readGitTags(cwd))).trim().replace(/^v/, "");
  if (!/^0\.1\.\d+$/.test(version) || version === "0.1.0") {
    throw new Error(`invalid release version: ${version}`);
  }
  const tag = `v${version}`;
  if ((gitInputs.tags ?? []).includes(tag)) throw new Error(`git tag ${tag} already exists; refusing to replace release output`);
  const outDir = path.join(releaseRootDir, tag);
  if (path.dirname(path.resolve(outDir)) !== path.resolve(releaseRootDir)) throw new Error("release output escaped its named directory");

  // Clean any prior output for this version before checking keys or building, so a failure never leaves unsigned artifacts behind.
  fs.rmSync(outDir, { recursive: true, force: true });

  if (!signingKeyPath || !fs.existsSync(signingKeyPath) || fs.statSync(signingKeyPath).size === 0) {
    throw new Error("update signing private key is missing; refusing to generate key or produce unsigned release package");
  }

  const appDir = options.appDir ?? (() => {
    if (!fs.existsSync(desktopPackageDir)) return "";
    const found = fs.readdirSync(desktopPackageDir).find((name) => name.startsWith("manga"));
    return found ? path.join(desktopPackageDir, found) : "";
  })();

  if (!options.buildReleaseInstallerFn) {
    if (!appDir || !fs.existsSync(path.join(appDir, "manga.exe"))) {
      throw new Error("no packaged desktop application found; run node scripts/stage.mjs package first");
    }
    const provenanceFile = path.join(appDir, "resources/build-provenance.json");
    const provenance = fs.existsSync(provenanceFile) ? JSON.parse(fs.readFileSync(provenanceFile, "utf8")) : null;
    if (packagedFingerprintKeys(config).some((key) => provenance?.[key] !== fingerprints[key])) {
      throw new Error("packaged application has missing or stale build provenance; run node scripts/stage.mjs package first");
    }
    if (!ci && fs.existsSync(latestDesktopPackage)) {
      const latestPkg = JSON.parse(fs.readFileSync(latestDesktopPackage, "utf8"));
      const stale = packagedFingerprintKeys(config).filter((k) => latestPkg[k] && fingerprints[k] && latestPkg[k] !== fingerprints[k]);
      if (stale.length > 0) {
        throw new Error(`packaged application does not match current ${stale.join(", ")}; run node scripts/stage.mjs package first`);
      }
    }
  }

  let tempBuildDir = null;
  let stagePublished = false;
  try {
    // ---- Step 2: Packaging, Blockmap, Release Notes, latest.yml, Ed25519 Signature & SHA256SUMS ----
    fs.mkdirSync(outDir, { recursive: true });
    tempBuildDir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-release-build-"));
    const previous = decision.previousTag && !options.buildReleaseInstallerFn
      ? await loadPreviousRelease({ tag: decision.previousTag, destination: path.join(tempBuildDir, "previous"), publicKeyBase64: options.publicKeys?.[0]?.publicKey,
        ...(options.previousReleaseOptions ?? {}) })
      : null;
    if (previous && Number(version.split(".")[2]) <= Number(previous.version.split(".")[2])) throw new Error("release version must increase over the verified previous release");

    const installerFileName = `manga-setup-${version}.exe`;
    const installerOutPath = path.join(outDir, installerFileName);

    if (options.buildReleaseInstallerFn) {
      await options.buildReleaseInstallerFn({ appDir, version, installerOutPath, workDir: tempBuildDir });
    } else {
      const built = await buildInstaller({
        appDir,
        channel: "release",
        workDir: tempBuildDir,
        version,
        commit: gitInputs.headSha?.slice(0, 7),
        testIdentity: false,
      });
      fs.copyFileSync(built.installer, installerOutPath);
    }

    const installerBytes = fs.readFileSync(installerOutPath);
    await buildInstallerBlockMap(installerOutPath);

    const bench = readJson(evidenceDir, "bench.json");
    const benchFingerprint = bench?.sourceFingerprint ?? null;
    const benchMatchesSource = Boolean(benchFingerprint && benchFingerprint === fingerprints.sourceFingerprint);

    const releaseNotesText = formatReleaseNotesMarkdown({
      version,
      previousTag: decision.previousTag,
      commits: decision.commits,
      schemaVersion: BUILD_SCHEMA_VERSION,
      previousSchemaVersion: previous?.schemaVersion ?? options.previousSchemaVersion ?? null,
      willUpgradeSchema: previous ? BUILD_SCHEMA_VERSION > previous.schemaVersion : Boolean(options.willUpgradeSchema),
      ciMode: ci,
      benchFingerprint,
      benchMatchesSource,
    });
    fs.writeFileSync(path.join(outDir, "RELEASE-NOTES.md"), releaseNotesText, "utf8");

    const sha512 = sha512BytesBase64(installerBytes);
    const builtAt = new Date().toISOString();
    const latestYaml = formatLatestYaml({
      version,
      fileName: installerFileName,
      sha512,
      size: installerBytes.length,
      releaseDate: builtAt,
      schemaVersion: BUILD_SCHEMA_VERSION,
      releaseNotes: releaseNotesText,
    });
    fs.writeFileSync(path.join(outDir, "latest.yml"), latestYaml, "utf8");

    const privateKeyPem = fs.readFileSync(signingKeyPath, "utf8");
    signReleaseInstaller({
      installerPath: installerOutPath,
      version,
      fileName: installerFileName,
      privateKeyPem,
      outputSigPath: `${installerOutPath}.sig`,
      signedAt: builtAt,
    });

    const hashedNames = [
      installerFileName,
      `${installerFileName}.blockmap`,
      `${installerFileName}.sig`,
      "latest.yml",
      "RELEASE-NOTES.md",
    ];
    const sumLines = hashedNames.map((name) => `${sha256HexFile(path.join(outDir, name))}  ${name}`);
    fs.writeFileSync(path.join(outDir, "SHA256SUMS"), `${sumLines.join("\n")}\n`, "utf8");

    const publicKeyBase64 = options.publicKeys?.[0]?.publicKey ?? RELEASE_UPDATE_PUBLIC_KEYS[0].publicKey;

    // ---- Step 3: Upgrade Rehearsal (演练) ----
    const tamperMainInstaller = Boolean(options.tamperRehearsal ?? (process.env.MANGA_RELEASE_TAMPER_REHEARSAL === "1"));
    const rehearsal = await (options.runRehearsalFn ?? runReleaseUpgradeRehearsal)({
      version,
      previousVersion: previous?.version ?? options.previousVersion ?? (decision.previousTag?.slice(1) || "0.1.0"),
      outDir,
      appDir,
      previousAppDir: previous?.appDir ?? appDir,
      previousRelease: previous?.evidence ?? { kind: decision.previousTag ? "service-fixtures" : "first-release-current-source-seed" },
      publicKeys: options.publicKeys ?? RELEASE_UPDATE_PUBLIC_KEYS,
      tamperMainInstaller,
      useNsisInstallers: options.useNsisInstallers ?? !options.buildReleaseInstallerFn,
      snapshotOptions: options.snapshotOptions ?? {},
    });

    // ---- Step 4 & 5: Publish Guard & Evidence (`release.json`) ----
    let published = false;
    let releaseUrl = null;
    const authCommand = `node scripts/stage/release-publish-verify.mjs --version ${version} --dir dist/release/${tag} --target ${gitInputs.headSha} --publish`;

    const allFiles = [...hashedNames, "SHA256SUMS"].map((fileName) => {
      const full = path.join(outDir, fileName);
      return {
        fileName,
        bytes: fs.statSync(full).size,
        sha256: sha256HexFile(full),
      };
    });

    const releaseRecord = {
      status: "passed",
      stage,
      version,
      tag,
      commit: gitInputs.headSha?.slice(0, 7) ?? readGitShortCommit(cwd),
      targetSha: gitInputs.headSha,
      schemaVersion: BUILD_SCHEMA_VERSION,
      ...fingerprints,
      benchFingerprint,
      benchMatchesSource,
      at: builtAt,
      ci,
      files: allFiles,
      rehearsal,
      previousRelease: previous?.evidence ?? { kind: decision.previousTag ? "service-fixtures" : "first-release-current-source-seed" },
      totalMs: Date.now() - startedMs,
      published,
      releaseUrl,
      requiresAuthorization: published ? null : authCommand,
    };

    const releaseJsonText = `${JSON.stringify(releaseRecord, null, 2)}\n`;
    const pubCheck = inspectPublication("release.json", Buffer.from(releaseJsonText, "utf8"));
    if (pubCheck.findings.length > 0) {
      throw new Error(`release.json failed publication sanitization check: ${JSON.stringify(pubCheck.findings)}`);
    }

    fs.writeFileSync(path.join(outDir, "release.json"), releaseJsonText, "utf8");

    // Final verification of the complete `dist/release/v<version>/` directory.
    verifyReleasePublishArtifacts({
      dir: outDir,
      version,
      publicKeyBase64,
      targetSha: gitInputs.headSha,
    });

    // The complete, verified release.json must exist before the publication verifier runs.
    if (publish) {
      const pubRes = publishVerifiedRelease({ dir: outDir, version, targetSha: gitInputs.headSha, publicKeyBase64, cwd, execFn: options.execFn });
      published = pubRes.published;
      stagePublished = published;
      releaseUrl = pubRes.releaseUrl;
      Object.assign(releaseRecord, { published, releaseUrl, requiresAuthorization: null });
      fs.writeFileSync(path.join(outDir, "release.json"), `${JSON.stringify(releaseRecord, null, 2)}\n`);
    }
    if (options.writeEvidenceReleaseJson !== false && evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.writeFileSync(path.join(evidenceDir, "release.json"), `${JSON.stringify(releaseRecord, null, 2)}\n`);
    }
    // Measurement-only timing is composed from this actual pipeline, never from a fake installer.
    const currentBench = readJson(evidenceDir, "bench.json");
    if (rehearsal.kind === "electron-nsis" && currentBench?.status === "passed" && fingerprintKeysOf(config, "bench.json").every((key) => currentBench[key] === fingerprints[key]) && currentBench.records?.update?.kind === "electron-nsis") {
      currentBench.records.update.stageReleaseMs = releaseRecord.totalMs;
      currentBench.records.update.stageRelease = { status: "measured", sourceEvidence: "release.json", kind: "electron-nsis" };
      fs.writeFileSync(path.join(evidenceDir, "bench.json"), `${JSON.stringify(currentBench, null, 2)}\n`);
    }

    return releaseRecord;
  } catch (error) {
    // Never leave an unsigned, tampered, or failed release directory behind (计划 4.5, 4.9, AT-161, AT-163).
    if (!stagePublished) { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ } }
    throw error;
  } finally {
    if (tempBuildDir) {
      try { fs.rmSync(tempBuildDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

function parseCliArg(args, flag) {
  const idx = args.indexOf(flag);
  if (idx >= 0 && idx + 1 < args.length) return args[idx + 1];
  const eq = args.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ci = args.includes("--ci");
  const publish = process.env.MANGA_RELEASE_PUBLISH === "1" && args.includes("--publish");
  const version = parseCliArg(args, "--version");
  try {
    const result = await runStageRelease({ ci, publish, version });
    console.log(JSON.stringify({
      check: "stage-release",
      status: result.status,
      version: result.version,
      tag: result.tag,
      published: result.published,
      requiresAuthorization: result.requiresAuthorization,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      check: "stage-release",
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }));
    process.exitCode = 1;
  }
}
