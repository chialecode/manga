import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MangaError } from "@manga/contracts";
import { JobQueue } from "../../packages/app-core/src/media/job-queue.ts";
import {
  ASR_CATALOG_QUERY_DATE,
  ASR_MODEL_CATALOG,
  AsrModelService,
  MISSING_TAR_MESSAGE,
  resolveModelRuntimeFiles,
  stagingPartPath,
  stagingStatePath,
  validateModelDownloadUrl,
  type AsrCatalogModel,
} from "../../packages/app-core/src/voice/models/index.ts";
import {
  buildHostileTarBz2,
  createSyntheticModelFixture,
  startFakeModelServer,
  type FakeModelServer,
} from "../helpers/fake-model-server.ts";
import { testTempRoot } from "../helpers/global-temp.ts";

const BANNED_COPY_PATTERNS = [/导入(?:本地)?文件(?!夹)/, /标题栏/, /托管/];

// The archive checks run Windows' own tar.exe (bsdtar, from System32 in the product). GNU tar on the Linux CI lists entries in
// another format and cannot make the test archives (`@archive`), so these run on Windows only: the full stage gate there covers them.
const onWindows = process.platform === "win32";

describe("voice local model catalog, downloader, and tar verifier", () => {
  const tempDirs: string[] = [];
  const servers: FakeModelServer[] = [];

  const makeTempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(testTempRoot(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    while (servers.length > 0) {
      const srv = servers.pop()!;
      await srv.close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("populates all 3 verified production models with exact SHA-256 digests and GitHub-only release URLs", () => {
    expect(ASR_CATALOG_QUERY_DATE).toBe("2026-11-13");
    expect(ASR_MODEL_CATALOG.map((item) => item.modelId)).toEqual([
      "qwen3-asr-0.6B-int8",
      "sense-voice-funasr-nano-int8",
      "funasr-nano-int8",
    ]);

    const qwen = ASR_MODEL_CATALOG[0]!;
    expect(qwen.recommended).toBe(true);
    expect(qwen.hotwords).toBe(50);
    expect(qwen.archiveBytes).toBe(878_702_423);
    expect(qwen.archiveSha256).toBe("393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96");
    expect(qwen.requiredFiles).toHaveLength(6);

    const sense = ASR_MODEL_CATALOG[1]!;
    expect(sense.hotwords).toBe(0);
    expect(sense.archiveBytes).toBe(187_693_225);
    expect(sense.archiveSha256).toBe("257936ea9a64cbe33200274e6367fc26d373ff6ca58b996b15108ffd6b9f6148");
    expect(sense.requiredFiles).toHaveLength(2);

    const funasr = ASR_MODEL_CATALOG[2]!;
    expect(funasr.hotwords).toBe(50);
    expect(funasr.archiveBytes).toBe(841_730_611);
    expect(funasr.archiveSha256).toBe("eb43d7ccc2e86b243f6a03b7df361033dda66db9523d1a92bf6aca2b50c9476b");
    expect(funasr.requiredFiles).toHaveLength(6);

    for (const model of ASR_MODEL_CATALOG) {
      expect(model.sources.length).toBeGreaterThanOrEqual(1);
      for (const source of model.sources) {
        const parsed = validateModelDownloadUrl(source.url);
        expect(parsed.protocol).toBe("https:");
        expect(parsed.hostname).toBe("github.com");
      }
      for (const reqFile of model.requiredFiles) {
        expect(reqFile.byteSize).toBeGreaterThan(0);
        expect(reqFile.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }

    const qwenBase = path.join("models", "asr", "qwen3-asr-0.6B-int8");
    const qwenRuntime = resolveModelRuntimeFiles(qwen, qwenBase);
    expect(qwenRuntime).toEqual({
      convFrontend: path.join(qwenBase, "conv_frontend.onnx"),
      encoder: path.join(qwenBase, "encoder.int8.onnx"),
      decoder: path.join(qwenBase, "decoder.int8.onnx"),
      tokenizer: path.join(qwenBase, "tokenizer"),
    });

    const funasrBase = path.join("models", "asr", "funasr-nano-int8");
    const funasrRuntime = resolveModelRuntimeFiles(funasr, funasrBase);
    expect(funasrRuntime).toEqual({
      encoderAdaptor: path.join(funasrBase, "encoder_adaptor.int8.onnx"),
      llm: path.join(funasrBase, "llm.int8.onnx"),
      embedding: path.join(funasrBase, "embedding.int8.onnx"),
      tokenizer: path.join(funasrBase, "Qwen3-0.6B"),
    });
  });

  it.runIf(onWindows)("requires confirmed: true before issuing any network request and enforces HTTPS + host allowlist on redirects", async () => {
    const workDir = makeTempDir("voice-dl-gate-");
    const fixture = createSyntheticModelFixture(workDir);
    const srv = await startFakeModelServer({
      "/archive.tar.bz2": { payload: fixture.archiveBuffer },
      "/redirect-ok": { redirectTo: "/archive.tar.bz2" },
      "/redirect-evil": { redirectTo: "https://evil.example.com/archive.tar.bz2" },
      "/redirect-loop": { redirectTo: "/redirect-loop" },
    });
    servers.push(srv);

    expect(() => validateModelDownloadUrl("http://github.com/k2-fsa/model.tar.bz2")).toThrowError(MangaError);
    expect(() => validateModelDownloadUrl("https://evil.example.com/model.tar.bz2")).toThrowError(MangaError);
    expect(() => validateModelDownloadUrl("https://127.0.0.1/model.tar.bz2")).toThrowError(MangaError);
    const credentialUrl = ["https://token", "secret@github.com/model.tar.bz2"].join(":");
    expect(() => validateModelDownloadUrl(credentialUrl)).toThrowError(MangaError);

    const modelOkRedirect: AsrCatalogModel = {
      ...fixture.catalogModel,
      sources: [{ id: "github", label: "GitHub", url: `${srv.baseUrl}/redirect-ok` }],
    };

    const appRoot = path.join(workDir, "app-data");
    const service = new AsrModelService({
      appRoot,
      catalog: [modelOkRedirect],
      allowLoopbackHttp: true,
    });

    await expect(
      service.download({ modelId: fixture.modelId, confirmed: false }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(srv.requests).toHaveLength(0);

    const installed = await service.download({ modelId: fixture.modelId, confirmed: true });
    expect(installed.state).toBe("installed");
    expect(srv.requests.map((r) => r.url)).toEqual(["/redirect-ok", "/archive.tar.bz2"]);

    // Evil redirect hop is blocked immediately
    const evilModel: AsrCatalogModel = {
      ...fixture.catalogModel,
      modelId: "evil-redirect-model",
      id: "evil-redirect-model",
      sources: [{ id: "github", label: "GitHub", url: `${srv.baseUrl}/redirect-evil` }],
    };
    const evilService = new AsrModelService({
      appRoot: path.join(workDir, "evil-app"),
      catalog: [evilModel],
      allowLoopbackHttp: true,
    });
    await expect(
      evilService.download({ modelId: "evil-redirect-model", confirmed: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Redirect loop (> 5 hops) is blocked
    const loopModel: AsrCatalogModel = {
      ...fixture.catalogModel,
      modelId: "loop-redirect-model",
      id: "loop-redirect-model",
      sources: [{ id: "github", label: "GitHub", url: `${srv.baseUrl}/redirect-loop` }],
    };
    const loopService = new AsrModelService({
      appRoot: path.join(workDir, "loop-app"),
      catalog: [loopModel],
      allowLoopbackHttp: true,
    });
    await expect(
      loopService.download({ modelId: "loop-redirect-model", confirmed: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it.runIf(onWindows)("resumes with HTTP Range 206 after mid-stream drop, and restarts from byte 0 on .part tamper, ETag change, or 200 response", async () => {
    const workDir = makeTempDir("voice-dl-range-");
    const fixture = createSyntheticModelFixture(workDir, { weightsByteLength: 64 * 1024 });
    const cutBytes = 16 * 1024;
    const srv = await startFakeModelServer({
      "/model.tar.bz2": {
        payload: fixture.archiveBuffer,
        etag: '"etag-initial"',
        disconnectAfterBytes: cutBytes,
        disconnectTimes: 1,
        chunkBytes: 4 * 1024,
      },
    });
    servers.push(srv);

    const model: AsrCatalogModel = {
      ...fixture.catalogModel,
      sources: [{ id: "github", label: "GitHub", url: `${srv.baseUrl}/model.tar.bz2` }],
    };

    const appRoot = path.join(workDir, "range-app");
    const jobs = new JobQueue({ "model-download": 1 });
    const progresses: number[] = [];
    const service = new AsrModelService({
      appRoot,
      catalog: [model],
      jobs,
      allowLoopbackHttp: true,
      onProgress: (p) => progresses.push(p.downloadedBytes),
    });

    // 1. Mid-stream disconnect leaves `.part` + `.state.json`
    await expect(
      service.download({ modelId: model.modelId, confirmed: true }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });

    const partFile = stagingPartPath(service.stagingDir, model.modelId);
    const stateFile = stagingStatePath(service.stagingDir, model.modelId);
    expect(fs.existsSync(partFile)).toBe(true);
    expect(fs.statSync(partFile).size).toBe(cutBytes);
    expect(fs.existsSync(stateFile)).toBe(true);

    // 2. Resume succeeds via Range 206
    const completed = await service.download({ modelId: model.modelId, confirmed: true });
    expect(completed.state).toBe("installed");
    expect(srv.requests[1]?.range).toBe(`bytes=${cutBytes}-`);
    expect(fs.existsSync(partFile)).toBe(false);
    expect(fs.existsSync(stateFile)).toBe(false);
    expect(progresses.length).toBeGreaterThan(2);

    // 3. Corrupting 1 byte in `.part` before resuming discards `.part` and restarts from byte 0
    srv.clearRequests();
    srv.setRoute("/model.tar.bz2", {
      payload: fixture.archiveBuffer,
      etag: '"etag-v1"',
      disconnectAfterBytes: cutBytes,
      disconnectTimes: 1,
      chunkBytes: 4 * 1024,
    });
    const appRootTamperPart = path.join(workDir, "tamper-part-app");
    const tamperPartService = new AsrModelService({
      appRoot: appRootTamperPart,
      catalog: [model],
      allowLoopbackHttp: true,
    });
    await expect(
      tamperPartService.download({ modelId: model.modelId, confirmed: true }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });

    const tamperPartFile = stagingPartPath(tamperPartService.stagingDir, model.modelId);
    const corrupted = fs.readFileSync(tamperPartFile);
    corrupted[10] = corrupted[10]! ^ 0xff;
    fs.writeFileSync(tamperPartFile, corrupted);

    const recoveredFromTamper = await tamperPartService.download({ modelId: model.modelId, confirmed: true });
    expect(recoveredFromTamper.state).toBe("installed");
    expect(srv.requests[1]?.range).toBeNull();

    // 4. ETag change on 206 restarts cleanly from byte 0
    srv.clearRequests();
    srv.setRoute("/model.tar.bz2", {
      payload: fixture.archiveBuffer,
      etag: '"etag-before"',
      disconnectAfterBytes: cutBytes,
      disconnectTimes: 1,
      chunkBytes: 4 * 1024,
    });
    const appRootEtag = path.join(workDir, "etag-app");
    const etagService = new AsrModelService({
      appRoot: appRootEtag,
      catalog: [model],
      allowLoopbackHttp: true,
    });
    await expect(
      etagService.download({ modelId: model.modelId, confirmed: true }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });

    srv.setRoute("/model.tar.bz2", {
      payload: fixture.archiveBuffer,
      etag: '"etag-rotated"',
      chunkBytes: 8 * 1024,
    });
    const recoveredFromEtag = await etagService.download({ modelId: model.modelId, confirmed: true });
    expect(recoveredFromEtag.state).toBe("installed");
    expect(srv.requests[1]?.range).toBe(`bytes=${cutBytes}-`);
    expect(srv.requests[2]?.range).toBeNull();

    // 5. Server ignoring Range and returning 200 restarts from byte 0 without corrupting archive
    srv.clearRequests();
    srv.setRoute("/model.tar.bz2", {
      payload: fixture.archiveBuffer,
      etag: '"etag-200"',
      disconnectAfterBytes: cutBytes,
      disconnectTimes: 1,
      chunkBytes: 4 * 1024,
    });
    const appRoot200 = path.join(workDir, "fallback200-app");
    const fallback200Service = new AsrModelService({
      appRoot: appRoot200,
      catalog: [model],
      allowLoopbackHttp: true,
    });
    await expect(
      fallback200Service.download({ modelId: model.modelId, confirmed: true }),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });

    srv.setRoute("/model.tar.bz2", {
      payload: fixture.archiveBuffer,
      etag: '"etag-200"',
      ignoreRange: true,
    });
    const installedVia200 = await fallback200Service.download({ modelId: model.modelId, confirmed: true });
    expect(installedVia200.state).toBe("installed");
  });

  it.runIf(onWindows)("supports pause, resume, cancel, disk-full rejection, multi-source fallback, and manual sourceId selection", async () => {
    const workDir = makeTempDir("voice-dl-ctrl-");
    const fixture = createSyntheticModelFixture(workDir, { weightsByteLength: 64 * 1024 });
    const srv = await startFakeModelServer({
      "/slow.tar.bz2": {
        payload: fixture.archiveBuffer,
        chunkBytes: 4 * 1024,
        chunkDelayMs: 35,
      },
      "/mirror-broken.tar.bz2": {
        statusCode: 404,
      },
      "/github-good.tar.bz2": {
        payload: fixture.archiveBuffer,
      },
    });
    servers.push(srv);

    const slowModel: AsrCatalogModel = {
      ...fixture.catalogModel,
      sources: [{ id: "github", label: "GitHub", url: `${srv.baseUrl}/slow.tar.bz2` }],
    };

    const appRoot = path.join(workDir, "pause-app");
    let pauseTriggered = false;
    const pauseService = new AsrModelService({
      appRoot,
      catalog: [slowModel],
      allowLoopbackHttp: true,
    });

    const dlPromise = pauseService.download({
      modelId: slowModel.modelId,
      confirmed: true,
      onProgress: (p) => {
        if (!pauseTriggered && p.downloadedBytes >= 8 * 1024) {
          pauseTriggered = true;
          void pauseService.pause(slowModel.modelId);
        }
      },
    });
    await expect(dlPromise).rejects.toMatchObject({ code: "CANCELLED" });

    const pausedItem = pauseService.getItem(slowModel.modelId);
    expect(pausedItem.state).toBe("paused");
    expect(pausedItem.downloadedBytes).toBeGreaterThanOrEqual(8 * 1024);

    // Speed up remaining transfer and resume
    srv.setRoute("/slow.tar.bz2", { payload: fixture.archiveBuffer, chunkBytes: 16 * 1024 });
    const resumedItem = await pauseService.download({ modelId: slowModel.modelId, confirmed: true });
    expect(resumedItem.state).toBe("installed");

    // Cancel wipes `.staging` completely
    srv.setRoute("/slow.tar.bz2", {
      payload: fixture.archiveBuffer,
      chunkBytes: 4 * 1024,
      chunkDelayMs: 35,
    });
    const cancelRoot = path.join(workDir, "cancel-app");
    const cancelService = new AsrModelService({
      appRoot: cancelRoot,
      catalog: [slowModel],
      allowLoopbackHttp: true,
    });
    let cancelTriggered = false;
    const cancelPromise = cancelService.download({
      modelId: slowModel.modelId,
      confirmed: true,
      onProgress: (p) => {
        if (!cancelTriggered && p.downloadedBytes >= 4 * 1024) {
          cancelTriggered = true;
          void cancelService.cancel(slowModel.modelId);
        }
      },
    });
    await expect(cancelPromise).rejects.toMatchObject({ code: "CANCELLED" });
    expect(cancelService.getItem(slowModel.modelId).state).toBe("not_installed");
    expect(fs.readdirSync(cancelService.stagingDir)).toHaveLength(0);

    // Disk space error surfaces `DISK_FULL`
    const diskFullService = new AsrModelService({
      appRoot: path.join(workDir, "disk-full-app"),
      catalog: [slowModel],
      allowLoopbackHttp: true,
      getAvailableDiskBytes: () => 1024,
    });
    await expect(
      diskFullService.download({ modelId: slowModel.modelId, confirmed: true }),
    ).rejects.toMatchObject({ code: "DISK_FULL" });

    // Multi-source fallback & manual sourceId selection
    const multiSourceModel: AsrCatalogModel = {
      ...fixture.catalogModel,
      modelId: "multi-src-model",
      id: "multi-src-model",
      sources: [
        { id: "mirror", label: "Mirror", url: `${srv.baseUrl}/mirror-broken.tar.bz2` },
        { id: "github", label: "GitHub", url: `${srv.baseUrl}/github-good.tar.bz2` },
      ],
    };
    srv.clearRequests();
    const multiService = new AsrModelService({
      appRoot: path.join(workDir, "multi-app"),
      catalog: [multiSourceModel],
      allowLoopbackHttp: true,
    });
    const fallbackRes = await multiService.download({ modelId: "multi-src-model", confirmed: true });
    expect(fallbackRes.state).toBe("installed");
    expect(srv.requests.map((r) => r.url)).toEqual(["/mirror-broken.tar.bz2", "/github-good.tar.bz2"]);

    srv.clearRequests();
    const manualService = new AsrModelService({
      appRoot: path.join(workDir, "manual-src-app"),
      catalog: [multiSourceModel],
      allowLoopbackHttp: true,
    });
    const manualRes = await manualService.download({
      modelId: "multi-src-model",
      confirmed: true,
      sourceId: "github",
    });
    expect(manualRes.state).toBe("installed");
    expect(srv.requests.map((r) => r.url)).toEqual(["/github-good.tar.bz2"]);
  });

  it.runIf(onWindows)("rejects 1-byte tampered archives, traversal/drive/symlink/hardlink/tar-bomb archives, missing tar.exe, and cleans .staging", async () => {
    const workDir = makeTempDir("voice-dl-sec-");
    const fixture = createSyntheticModelFixture(workDir);

    const traversalArchive = buildHostileTarBz2(workDir, "traversal.tar.bz2", [
      { name: "../escaped.onnx", body: "boom" },
    ]);
    const driveArchive = buildHostileTarBz2(workDir, "drive.tar.bz2", [
      { name: ["C:", "Windows/Temp/evil.onnx"].join("/"), body: "boom" },
    ]);
    const symlinkArchive = buildHostileTarBz2(workDir, "symlink.tar.bz2", [
      { name: "pkg/link.onnx", typeflag: "2", linkname: "../../secret.txt" },
    ]);
    const hardlinkArchive = buildHostileTarBz2(workDir, "hardlink.tar.bz2", [
      { name: "pkg/hard.onnx", typeflag: "1", linkname: "/etc/passwd" },
    ]);
    const reservedArchive = buildHostileTarBz2(workDir, "reserved.tar.bz2", [
      { name: "pkg/CON.txt", body: "reserved" },
    ]);
    const bombArchive = buildHostileTarBz2(workDir, "bomb.tar.bz2", [
      { name: "pkg/giant.onnx", body: Buffer.alloc(2 * 1024 * 1024, 0) },
    ]);

    const srv = await startFakeModelServer({
      "/tampered.tar.bz2": {
        payload: fixture.archiveBuffer,
        tamperOffset: Math.floor(fixture.archiveBuffer.length / 2),
      },
      "/traversal.tar.bz2": { payload: traversalArchive.archiveBuffer },
      "/drive.tar.bz2": { payload: driveArchive.archiveBuffer },
      "/symlink.tar.bz2": { payload: symlinkArchive.archiveBuffer },
      "/hardlink.tar.bz2": { payload: hardlinkArchive.archiveBuffer },
      "/reserved.tar.bz2": { payload: reservedArchive.archiveBuffer },
      "/bomb.tar.bz2": { payload: bombArchive.archiveBuffer },
    });
    servers.push(srv);

    const cases: Array<{
      id: string;
      urlPath: string;
      bytes: number;
      sha256: string;
      expectedCode: string;
      maxUncompressedBytes?: number;
    }> = [
      {
        id: "tamper-case",
        urlPath: "/tampered.tar.bz2",
        bytes: fixture.catalogModel.archiveBytes,
        sha256: fixture.catalogModel.archiveSha256,
        expectedCode: "VALIDATION_ERROR",
      },
      {
        id: "traversal-case",
        urlPath: "/traversal.tar.bz2",
        bytes: traversalArchive.archiveBytes,
        sha256: traversalArchive.archiveSha256,
        expectedCode: "PATH_ESCAPE",
      },
      {
        id: "drive-case",
        urlPath: "/drive.tar.bz2",
        bytes: driveArchive.archiveBytes,
        sha256: driveArchive.archiveSha256,
        expectedCode: "PATH_ESCAPE",
      },
      {
        id: "symlink-case",
        urlPath: "/symlink.tar.bz2",
        bytes: symlinkArchive.archiveBytes,
        sha256: symlinkArchive.archiveSha256,
        expectedCode: "PATH_ESCAPE",
      },
      {
        id: "hardlink-case",
        urlPath: "/hardlink.tar.bz2",
        bytes: hardlinkArchive.archiveBytes,
        sha256: hardlinkArchive.archiveSha256,
        expectedCode: "PATH_ESCAPE",
      },
      {
        id: "reserved-case",
        urlPath: "/reserved.tar.bz2",
        bytes: reservedArchive.archiveBytes,
        sha256: reservedArchive.archiveSha256,
        expectedCode: "PATH_ESCAPE",
      },
      {
        id: "bomb-case",
        urlPath: "/bomb.tar.bz2",
        bytes: bombArchive.archiveBytes,
        sha256: bombArchive.archiveSha256,
        expectedCode: "VALIDATION_ERROR",
        maxUncompressedBytes: 512 * 1024,
      },
    ];

    for (const testCase of cases) {
      const caseRoot = path.join(workDir, `app-${testCase.id}`);
      const catalogEntry: AsrCatalogModel = {
        ...fixture.catalogModel,
        id: testCase.id,
        modelId: testCase.id,
        archiveBytes: testCase.bytes,
        archiveSha256: testCase.sha256,
        sources: [{ id: "github", label: "GitHub", url: `${srv.baseUrl}${testCase.urlPath}` }],
      };
      const svc = new AsrModelService({
        appRoot: caseRoot,
        catalog: [catalogEntry],
        allowLoopbackHttp: true,
        maxUncompressedBytes: testCase.maxUncompressedBytes,
      });

      await expect(
        svc.download({ modelId: testCase.id, confirmed: true }),
      ).rejects.toMatchObject({ code: testCase.expectedCode });

      if (fs.existsSync(svc.stagingDir)) {
        expect(fs.readdirSync(svc.stagingDir)).toEqual([]);
      }
      expect(svc.isInstalled(testCase.id)).toBe(false);
    }

    // Missing `tar.exe` gives actionable Chinese guidance advising folder import without banned copy terms
    for (const pattern of BANNED_COPY_PATTERNS) {
      expect(MISSING_TAR_MESSAGE).not.toMatch(pattern);
    }
    expect(MISSING_TAR_MESSAGE).toContain("导入文件夹");

    const missingTarSvc = new AsrModelService({
      appRoot: path.join(workDir, "no-tar-app"),
      catalog: [fixture.catalogModel],
      tarExe: path.join(workDir, "missing-system-tar.exe"),
    });
    await expect(
      missingTarSvc.importModel({
        modelId: fixture.modelId,
        sourcePath: fixture.archivePath,
        kind: "archive",
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      message: MISSING_TAR_MESSAGE,
    });
  });

  it.runIf(onWindows)("verifies archive & folder imports, calls unloadModel before delete, and returns freedBytes", async () => {
    const workDir = makeTempDir("voice-dl-import-");
    const fixture = createSyntheticModelFixture(workDir);
    const events: string[] = [];

    const service = new AsrModelService({
      appRoot: path.join(workDir, "import-app"),
      catalog: [fixture.catalogModel],
      unloadModel: async (modelId) => {
        // Verify model files STILL exist on disk when `unloadModel` is invoked!
        const installDir = path.join(workDir, "import-app", "models", "asr", modelId);
        events.push(`unload:${modelId}:exists=${fs.existsSync(installDir)}`);
      },
    });

    // 1. Valid archive import
    const importedArchive = await service.importModel({
      modelId: fixture.modelId,
      sourcePath: fixture.archivePath,
      kind: "archive",
    });
    expect(importedArchive.state).toBe("installed");
    expect(importedArchive.installedBytes).toBe(
      fixture.modelWeightsBytes.length + fixture.tokensBytes.length,
    );

    // 2. Delete unloads first, deletes files, updates installed.json, returns freedBytes
    const deleted = await service.delete(fixture.modelId);
    expect(events).toEqual([`unload:${fixture.modelId}:exists=true`]);
    expect(deleted.deleted).toBe(true);
    expect(deleted.freedBytes).toBeGreaterThanOrEqual(
      fixture.modelWeightsBytes.length + fixture.tokensBytes.length,
    );
    expect(service.isInstalled(fixture.modelId)).toBe(false);
    expect(service.getItem(fixture.modelId).state).toBe("not_installed");

    // 3. Valid directory import
    const importedFolder = await service.importModel({
      modelId: fixture.modelId,
      sourcePath: fixture.extractedDir,
      kind: "directory",
    });
    expect(importedFolder.state).toBe("installed");
    expect(service.getRuntimeFiles(fixture.modelId).files.model).toContain("model.int8.onnx");

    // 4. Folder import with missing or 1-byte tampered required file fails and leaves `.staging` clean
    const badFolder = path.join(workDir, "bad-folder");
    fs.mkdirSync(badFolder, { recursive: true });
    const badWeights = Buffer.from(fixture.modelWeightsBytes);
    badWeights[0] = badWeights[0]! ^ 0xff;
    fs.writeFileSync(path.join(badFolder, "model.int8.onnx"), badWeights);
    fs.writeFileSync(path.join(badFolder, "tokens.txt"), fixture.tokensBytes);

    const freshSvc = new AsrModelService({
      appRoot: path.join(workDir, "bad-folder-app"),
      catalog: [fixture.catalogModel],
    });
    await expect(
      freshSvc.importModel({
        modelId: fixture.modelId,
        sourcePath: badFolder,
        kind: "directory",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    if (fs.existsSync(freshSvc.stagingDir)) {
      expect(fs.readdirSync(freshSvc.stagingDir)).toEqual([]);
    }
  });
});
