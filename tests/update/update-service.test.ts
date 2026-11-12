import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MangaProductApp,
  RELEASE_UPDATE_PUBLIC_KEYS,
  TestVault,
  buildBlockMap,
  checkAppUpdateConfig,
  rawPublicKey,
  serializeBlockMapGzip,
  sha512BytesBase64,
  signReleaseInstaller,
  formatLatestYaml,
  parseLatestYaml,
} from "@manga/app-core";
import { appUpdateYaml } from "../../scripts/stage/installer-lib.mjs";
import { attachNsisUpdater, createConfiguredNsisUpdater, invokeNsisVerifySignature } from "../../apps/desktop/src/main/updater.ts";
import { guardPaths, verifiedPrevious } from "../../apps/desktop/src/main/launch-guard.ts";
import { MangaError } from "@manga/contracts";

function makeTestKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyBase64 = rawPublicKey(publicKey).toString("base64");
  return {
    privateKeyPem,
    publicKeyBase64,
    publicKeys: [{ publicKey: publicKeyBase64, label: "Test Release Key" }],
  };
}

type FakeReleaseServer = {
  baseUrl: string;
  files: Map<string, Buffer | string>;
  requests: Array<{ method: string; url: string; range?: string; userAgent?: string }>;
  interruptFirstDownloadBytes: number | null;
  redirects: Map<string, string>;
  close: () => Promise<void>;
};

async function startFakeReleaseServer(): Promise<FakeReleaseServer> {
  const files = new Map<string, Buffer | string>();
  const redirects = new Map<string, string>();
  const requests: Array<{ method: string; url: string; range?: string; userAgent?: string }> = [];
  let interruptedOnce = false;
  const state: { interruptFirstDownloadBytes: number | null } = {
    interruptFirstDownloadBytes: null,
  };

  const server = http.createServer((req, res) => {
    const reqUrl = req.url ?? "/";
    requests.push({
      method: req.method ?? "GET",
      url: reqUrl,
      range: typeof req.headers.range === "string" ? req.headers.range : undefined,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    });
    const cleanPath = decodeURIComponent(reqUrl.split("?")[0] ?? "/").replace(/^\/+/, "");
    if (redirects.has(cleanPath)) { res.writeHead(302, { location: redirects.get(cleanPath)! }); res.end(); return; }
    const entry = files.get(cleanPath);
    if (entry === undefined) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }
    const buf = typeof entry === "string" ? Buffer.from(entry, "utf8") : entry;

    if (
      state.interruptFirstDownloadBytes !== null
      && !interruptedOnce
      && cleanPath.endsWith(".exe")
      && !req.headers.range
    ) {
      interruptedOnce = true;
      const partial = buf.subarray(0, state.interruptFirstDownloadBytes);
      res.statusCode = 200;
      res.setHeader("Content-Length", String(partial.length));
      res.end(partial);
      return;
    }

    const rangeHeader = req.headers.range;
    if (typeof rangeHeader === "string" && rangeHeader.startsWith("bytes=")) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
      if (match) {
        const start = Number.parseInt(match[1]!, 10);
        const end = match[2] ? Number.parseInt(match[2], 10) : buf.length - 1;
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

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind loopback server");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    files,
    redirects,
    requests,
    get interruptFirstDownloadBytes() {
      return state.interruptFirstDownloadBytes;
    },
    set interruptFirstDownloadBytes(val: number | null) {
      state.interruptFirstDownloadBytes = val;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

type FixtureUpdateOptions = NonNullable<ConstructorParameters<typeof MangaProductApp>[0]["update"]>;

async function updateFixture(options: FixtureUpdateOptions = {}, upstream = false) {
  const env = createTempEnv();
  const keys = makeTestKeyPair();
  const server = await startFakeReleaseServer();
  cleanups.push(() => server.close());
  const fileName = "manga-setup-0.1.2.exe";
  const blockSize = 32 * 1024;
  const shared = randomBytes(blockSize * 7);
  const oldBytes = Buffer.concat([shared, randomBytes(blockSize)]);
  const bytes = Buffer.concat([shared, randomBytes(blockSize)]);
  const installer = path.join(env.root, fileName);
  fs.writeFileSync(installer, bytes);
  const signed = signReleaseInstaller({ installerPath: installer, version: "0.1.2", privateKeyPem: keys.privateKeyPem });
  const manifest = formatLatestYaml({ version: "0.1.2", fileName, sha512: signed.signature.sha512, size: bytes.length, schemaVersion: 14, releaseNotes: "受控更新样本" });
  server.files.set("latest.yml", manifest);
  server.files.set(fileName, bytes);
  server.files.set(`${fileName}.sig`, signed.sigText);
  server.files.set(`${fileName}.blockmap`, serializeBlockMapGzip(buildBlockMap(bytes, blockSize)));
  server.files.set("manga-setup-0.1.1.exe.blockmap", serializeBlockMapGzip(buildBlockMap(oldBytes, blockSize)));
  const app = new MangaProductApp({
    profileRoot: env.profileRoot, documentsDir: env.documentsDir, downloadsDir: env.downloadsDir,
    channel: "release", packaged: true, resourcesPath: env.resourcesDir, vault: new TestVault(), ffmpegTools: null,
    buildInfo: { version: "0.1.1", channel: "release", commit: "1111111", builtAt: "2026-11-01T00:00:00.000Z", schemaVersion: 14 },
    update: { feedUrl: server.baseUrl, allowLoopbackHttp: true, publicKeys: keys.publicKeys, appUpdateConfigPath: env.appUpdatePath,
      installDirectory: env.installDir, runInstaller: () => true, ...options },
  });
  cleanups.push(() => app.close());
  await app.start();
  let updater: ReturnType<typeof createConfiguredNsisUpdater> | undefined;
  let publisherCalls = 0;
  if (upstream) {
    const require = createRequire(import.meta.url);
    const builderRequire = createRequire(require.resolve("electron-builder"));
    const { NodeHttpExecutor } = builderRequire("builder-util/out/nodeHttpExecutor");
    const { ElectronHttpExecutor } = require("electron-updater/out/electronHttpExecutor");
    // Only the transport changes: these tests run the upstream check, download,
    // differential, cache and publisher paths with its real HttpExecutor pipeline.
    const executor = new NodeHttpExecutor();
    executor.download = ElectronHttpExecutor.prototype.download;
    updater = createConfiguredNsisUpdater({ updateService: app.update, version: "0.1.1", appUpdateConfigPath: env.appUpdatePath,
      userDataPath: app.layout.partitions.runtime, baseCachePath: app.layout.partitions.cache });
    (updater as unknown as { httpExecutor: unknown }).httpExecutor = executor;
    const verify = updater.verifyUpdateCodeSignature;
    updater.verifyUpdateCodeSignature = async (names, file) => { publisherCalls += 1; return verify(names, file); };
    attachNsisUpdater({ updater, updateService: app.update, version: "0.1.1", appUpdateConfigPath: env.appUpdatePath,
      userDataPath: app.layout.partitions.runtime, baseCachePath: app.layout.partitions.cache, allowLoopbackHttp: true });
  }
  return { app, env, keys, server, fileName, bytes, oldBytes, blockSize, signed, manifest, updater, publisherCalls: () => publisherCalls };
}

// The upstream NsisUpdater asks for the manifest of the platform it runs on (latest-linux.yml on Linux, latest.yml only on Windows), so its real
// check, download and differential paths run where NSIS updates run: the Windows development machine's stage gate and the weekly release
// workflow's check on windows-2025. The pull-request CI on Linux runs the rest of the update tests.
const nsisPlatform = process.platform === "win32";

describe("Update review: actual electron-updater paths and recovery (AT-159, AT-160)", () => {
  it.skipIf(!nsisPlatform)("uses upstream full, differential and cached downloads and always invokes the publisher gate", async () => {
    for (const differential of [false, true]) {
      const fixture = await updateFixture({}, true);
      const { app, bytes, oldBytes, blockSize, server, fileName, updater } = fixture;
      expect(updater!.autoInstallOnAppQuit).toBe(false);
      if (differential) app.update.seedCurrentInstallerCache(oldBytes, serializeBlockMapGzip(buildBlockMap(oldBytes, blockSize)));
      const result = await app.update.check();
      expect(result.state).toBe("ready");
      expect(result.usedDifferential).toBe(differential);
      expect(result.downloadedBytes).toBe(differential ? blockSize : bytes.length);
      expect(fixture.publisherCalls()).toBeGreaterThanOrEqual(2);
      const count = server.requests.filter((request) => request.url.split("?")[0] === `/${fileName}`).length;
      app.update.configure({ resetState: true });
      expect((await app.update.check()).state).toBe("ready");
      expect(server.requests.filter((request) => request.url.split("?")[0] === `/${fileName}`)).toHaveLength(count);
      expect(fixture.publisherCalls()).toBeGreaterThanOrEqual(3);
      const pending = path.join(app.layout.partitions.cache, "updater/pending", fileName);
      const changed = Buffer.from(bytes); changed[0] ^= 0xff;
      fs.writeFileSync(pending, changed);
      app.update.configure({ resetState: true });
      expect((await app.update.check()).errorCode).toBe("UPDATE_VERIFY_FAILED");
      expect(fs.existsSync(pending)).toBe(false);
    }
  });

  it.skipIf(!nsisPlatform)("resumes an upstream interrupted download at a complete block boundary and verifies the assembled bytes", async () => {
    const { app, server, blockSize, bytes, fileName } = await updateFixture({}, true);
    const resumeDir = path.join(app.layout.partitions.cache, "updater/resume");
    fs.mkdirSync(resumeDir, { recursive: true });
    fs.writeFileSync(path.join(resumeDir, "manga-setup-0.1.0.exe.part"), "obsolete interruption");
    fs.writeFileSync(path.join(resumeDir, "manga-setup-0.1.0.exe.part.json"), "{}");
    fs.writeFileSync(path.join(resumeDir, "unrelated-cache.txt"), "preserved");
    server.interruptFirstDownloadBytes = blockSize * 2 + 100;
    expect((await app.update.check()).state).toBe("error");
    expect(fs.existsSync(path.join(resumeDir, "manga-setup-0.1.0.exe.part"))).toBe(false);
    expect(fs.existsSync(path.join(resumeDir, "manga-setup-0.1.0.exe.part.json"))).toBe(false);
    expect(fs.readFileSync(path.join(resumeDir, "unrelated-cache.txt"), "utf8")).toBe("preserved");
    expect(fs.existsSync(path.join(app.layout.partitions.cache, "updater/resume", `${fileName}.part`))).toBe(true);
    const ready = await app.update.check();
    expect(ready.state).toBe("ready");
    expect(ready.downloadedBytes).toBe(bytes.length - blockSize * 2);
    expect(server.requests.some((request) => request.range === `bytes=${blockSize * 2}-${bytes.length - 1}`)).toBe(true);
    expect(fs.existsSync(path.join(app.layout.partitions.cache, "updater/resume", `${fileName}.part`))).toBe(false);
  });

  it.skipIf(!nsisPlatform)("rejects unsafe redirects in both the manifest fetch and the upstream installer request without contacting the target", async () => {
    const first = await updateFixture({ netFetch: async () => new Response(null, { status: 302, headers: { location: "http://192.0.2.1/unsafe" } }) });
    expect((await first.app.update.check()).errorCode).toBe("UPDATE_VERIFY_FAILED");
    const second = await updateFixture({}, true);
    second.server.redirects.set(second.fileName, "http://192.0.2.1/unsafe.exe");
    expect((await second.app.update.check()).errorCode).toBe("UPDATE_VERIFY_FAILED");
  });

  it("keeps a ready release bound to its receipt and rejects a signature removed during the save barrier", async () => {
    let removeSignature = false;
    let installerRuns = 0;
    const { app, server, fileName } = await updateFixture({
      onBeforeInstall: () => { if (removeSignature) fs.rmSync(path.join(app.layout.partitions.cache, "updater/pending", `${fileName}.sig`)); },
      runInstaller: () => { installerRuns += 1; return true; },
    });
    expect((await app.update.check()).state).toBe("ready");
    const requests = server.requests.length;
    server.files.set("latest.yml", String(server.files.get("latest.yml")).replaceAll("0.1.2", "0.1.3"));
    expect((await app.update.check()).availableVersion).toBe("0.1.2");
    expect(server.requests).toHaveLength(requests);
    removeSignature = true;
    await expect(app.update.restartToUpdate()).rejects.toMatchObject({ code: "UPDATE_VERIFY_FAILED" });
    expect(installerRuns).toBe(0);
    expect(app.store.getMeta("update.pendingFrom") || "").toBe("");
  });

  it("propagates save, SQLite backup and installer failures, restores pending metadata and allows retry", async () => {
    for (const failure of ["save", "backup", "installer"]) {
      let fail = true;
      let installerRuns = 0;
      let restoreCalls = 0;
      const { app } = await updateFixture({
        onBeforeInstall: () => { if (fail && failure === "save") throw new Error("save failed"); },
        onInstallFailed: () => { restoreCalls += 1; },
        runInstaller: () => { installerRuns += 1; return !(fail && failure === "installer"); },
      });
      expect((await app.update.check()).state).toBe("ready");
      const backup = vi.spyOn(app.store, "copyForBackup");
      if (failure === "backup") backup.mockImplementation(() => { throw new Error("backup failed"); });
      await expect(app.update.restartToUpdate()).rejects.toMatchObject({ code: "UPDATE_UNAVAILABLE" });
      expect(installerRuns).toBe(failure === "installer" ? 1 : 0);
      expect(restoreCalls).toBe(1);
      expect(app.store.getMeta("update.pendingFrom") || "").toBe("");
      expect(app.store.getMeta("update.pendingNotes") || "").toBe("");
      backup.mockRestore();
      fail = false;
      expect((await app.update.restartToUpdate()).restarted).toBe(true);
      expect(restoreCalls).toBe(1);
      expect(await app.update.installOnQuit()).toBe(false);
    }
  });

  it("keeps the running version's installer as the way back, one at a time, only when it is still the recorded one (AT-165, 4.2, LOOP-32)", async () => {
    const { app, oldBytes, bytes, blockSize } = await updateFixture();
    const cache = path.join(app.layout.partitions.cache, "updater");
    app.update.seedCurrentInstallerCache(oldBytes, serializeBlockMapGzip(buildBlockMap(oldBytes, blockSize)));
    expect(JSON.parse(fs.readFileSync(path.join(cache, "installer.json"), "utf8"))).toEqual({ version: "0.1.1", sha512Hex: createHash("sha512").update(oldBytes).digest("hex") });
    fs.mkdirSync(path.join(cache, "previous"), { recursive: true });
    fs.writeFileSync(path.join(cache, "previous", "installer-0.1.0.exe"), "an older way back");
    expect((await app.update.check()).state).toBe("ready");
    expect((await app.update.restartToUpdate()).restarted).toBe(true);
    const record = JSON.parse(fs.readFileSync(path.join(cache, "previous", "previous.json"), "utf8"));
    expect(record).toMatchObject({ version: "0.1.1", file: "installer-0.1.1.exe", schemaVersion: 14, targetVersion: "0.1.2", targetSchemaVersion: 14 });
    expect(record.sha512Hex).toBe(createHash("sha512").update(oldBytes).digest("hex"));
    expect(path.basename(record.backup)).toBe("manga.sqlite.preupdate-v0.1.1.sqlite");
    expect(path.resolve(record.database)).toBe(path.resolve(app.layout.partitions.data, "manga.sqlite"));
    expect(fs.readdirSync(path.join(cache, "previous")).sort()).toEqual(["installer-0.1.1.exe", "previous.json"]);
    const kept = verifiedPrevious(guardPaths(app.layout.appRoot));
    expect(kept?.version).toBe("0.1.1");
    // The installer now in the cache is the new version's, recorded as such for the update after it.
    expect(JSON.parse(fs.readFileSync(path.join(cache, "installer.json"), "utf8"))).toEqual({ version: "0.1.2", sha512Hex: createHash("sha512").update(bytes).digest("hex") });
    // A kept installer whose bytes changed is not offered.
    fs.appendFileSync(path.join(cache, "previous", "installer-0.1.1.exe"), "x");
    expect(verifiedPrevious(guardPaths(app.layout.appRoot))).toBeNull();
  });

  it("updates without a way back when the cached installer is not this version's", async () => {
    const { app, oldBytes, blockSize } = await updateFixture();
    const cache = path.join(app.layout.partitions.cache, "updater");
    app.update.seedCurrentInstallerCache(oldBytes, serializeBlockMapGzip(buildBlockMap(oldBytes, blockSize)));
    fs.writeFileSync(path.join(cache, "installer.json"), JSON.stringify({ version: "0.1.0", sha512Hex: "00" }));
    expect((await app.update.check()).state).toBe("ready");
    expect((await app.update.restartToUpdate()).restarted).toBe(true);
    expect(fs.existsSync(path.join(cache, "previous"))).toBe(false);
  });

  it("skips the version it went back from until the person cancels the skip, and logs the rollback once (AT-165, 4.2)", async () => {
    const { app } = await updateFixture();
    const data = app.layout.partitions.data;
    fs.writeFileSync(path.join(data, "update-skip.json"), JSON.stringify({ version: "0.1.2", at: "2026-11-09T00:00:00.000Z" }));
    const skipped = await app.update.check();
    expect(skipped).toMatchObject({ state: "idle", availableVersion: null, skippedVersion: "0.1.2" });
    const grant = app.issueOwnerGrant({ kind: "user", id: "u1" }).handle;
    const actor = { kind: "user" as const, id: "u1" };
    const unskipped = await app.call(actor, { commandId: "update.unskip", idempotencyKey: "unskip-1", input: {} }, grant);
    expect(unskipped).toMatchObject({ status: "ok", value: { skippedVersion: null } });
    expect(app.update.status().skippedVersion).toBeNull();
    expect(fs.existsSync(path.join(data, "update-skip.json"))).toBe(false);
    expect((await app.update.check()).state).toBe("ready");
    const logged = app.store.sqlite.prepare("SELECT action, summary_key, summary_params_json FROM operation_log WHERE action LIKE 'update.%' ORDER BY id").all() as Array<{ action: string; summary_key: string; summary_params_json: string }>;
    expect(logged.some((row) => row.action === "update.unskip")).toBe(true);

    fs.writeFileSync(path.join(data, "rollback-record.json"), JSON.stringify({ from: "0.1.2", to: "0.1.1", at: "2026-11-09T00:00:00.000Z", databaseRestored: true, keptAs: "manga.sqlite.rolledback-x" }));
    app.update.configure({ resetState: true, detectFirstLaunch: true });
    app.update.configure({ resetState: true, detectFirstLaunch: true });
    const rolled = (app.store.sqlite.prepare("SELECT summary_key, summary_params_json FROM operation_log WHERE action = 'update.rolledBack'").all() as Array<{ summary_key: string; summary_params_json: string }>);
    expect(rolled).toHaveLength(1);
    expect(rolled[0]!.summary_key).toBe("log.update.rolledBackRestored");
    expect(JSON.parse(rolled[0]!.summary_params_json)).toEqual({ from: "0.1.2", to: "0.1.1", keptAs: "manga.sqlite.rolledback-x" });
    expect(fs.existsSync(path.join(data, "rollback-record.json"))).toBe(false);
  });

  it("does not install while light open will not leave, and says so (AT-169, 4.6)", async () => {
    let installerRuns = 0;
    const { app } = await updateFixture({
      onBeforeInstall: () => { throw new MangaError("UPDATE_UNAVAILABLE", "请先关闭轻量播放窗口", { details: { reason: "light-open-running" } }); },
      runInstaller: () => { installerRuns += 1; return true; },
    });
    expect((await app.update.check()).state).toBe("ready");
    await expect(app.update.restartToUpdate()).rejects.toMatchObject({ code: "UPDATE_UNAVAILABLE", message: "请先关闭轻量播放窗口", details: { reason: "light-open-running" } });
    expect(installerRuns).toBe(0);
    expect(app.update.status()).toMatchObject({ state: "ready", error: "请先关闭轻量播放窗口" });
  });

  it("includes committed WAL data in the pre-update backup even when the main SQLite file lacks it", async () => {
    const { app, env } = await updateFixture();
    app.store.sqlite.exec("CREATE TABLE update_review_wal (value TEXT NOT NULL)");
    app.store.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    app.store.sqlite.pragma("wal_autocheckpoint=0");
    app.store.sqlite.prepare("INSERT INTO update_review_wal VALUES (?)").run("committed but still in WAL");
    const mainOnly = path.join(env.root, "main-only.sqlite");
    fs.copyFileSync(path.join(app.layout.partitions.data, "manga.sqlite"), mainOnly);
    const stale = new Database(mainOnly, { readonly: true });
    expect(stale.prepare("SELECT * FROM update_review_wal").all()).toEqual([]);
    stale.close();
    expect((await app.update.check()).state).toBe("ready");
    await app.update.restartToUpdate();
    const backup = new Database(path.join(app.layout.partitions.backups, "manga.sqlite.preupdate-v0.1.1.sqlite"), { readonly: true });
    expect(backup.prepare("SELECT value FROM update_review_wal").pluck().get()).toBe("committed but still in WAL");
    expect(backup.pragma("integrity_check", { simple: true })).toBe("ok");
    backup.close();
  });

  it("does not publish a late network result or write to the closed store after disposal", async () => {
    let release: (response: Response) => void = () => {};
    const response = new Promise<Response>((resolve) => { release = resolve; });
    const { app, manifest } = await updateFixture({ netFetch: () => response });
    const check = app.update.check();
    app.close();
    release(new Response(manifest));
    await expect(check).resolves.toMatchObject({ state: "checking", availableVersion: null });
  });

  it("clears an obsolete available release and never marks a download ready after an intermediate publisher callback (AT-159, AT-160)", async () => {
    const first = await updateFixture();
    first.app.update.setSettings({ autoDownload: false });
    expect((await first.app.update.check()).availableVersion).toBe("0.1.2");
    first.server.files.set("latest.yml", first.manifest.replaceAll("0.1.2", "0.1.1"));
    expect((await first.app.update.check()).availableVersion).toBeNull();
    const second = await updateFixture();
    second.app.update.configure({ downloadInstaller: async (input) => {
      const file = path.join(second.env.root, second.fileName);
      const verify = second.app.update.createNsisCodeSignatureVerifier({ expectedVersion: () => input.manifest.version,
        expectedFileName: () => input.manifest.fileName, sigText: () => input.signature });
      expect(await verify(["chialecode"], file)).toBeNull();
      throw new Error("download cache failed after publisher verification");
    } });
    expect((await second.app.update.check({ manual: false })).state).toBe("idle");
    expect(await second.app.update.installOnQuit()).toBe(false);
  });

  it("rejects duplicate or conflicting manifest fields while preserving examples in release notes", async () => {
    const { manifest } = await updateFixture();
    for (const invalid of [
      `${manifest}version: 0.1.9\n`, manifest.replace("path: manga-setup-0.1.2.exe", "path: other.exe"),
      manifest.replace("schemaVersion: 14", "schemaVersion: 0"),
      manifest.replace("files:\n", "files:\n  - url: other.exe\n"),
    ]) expect(() => parseLatestYaml(invalid)).toThrow();
    const withExample = `${manifest}  files:\n    - url: sample.exe\n      sha512: example\n      size: 1\n`;
    expect(parseLatestYaml(withExample).fileName).toBe("manga-setup-0.1.2.exe");
  });
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

function createTempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-update-test-"));
  const resourcesDir = path.join(root, "resources");
  const installDir = path.join(root, "install");
  fs.mkdirSync(resourcesDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(resourcesDir, "app-update.yml"), appUpdateYaml(), "utf8");
  cleanups.push(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });
  return {
    root,
    profileRoot: path.join(root, "profile"),
    documentsDir: path.join(root, "documents"),
    downloadsDir: path.join(root, "downloads"),
    resourcesDir,
    appUpdatePath: path.join(resourcesDir, "app-update.yml"),
    installDir,
  };
}

describe("W3 & W4: Release UpdateService, Ed25519 signature verification & publisherName enforcement (AT-159, AT-160)", () => {
  it("embeds the dedicated release update Ed25519 public key in app-core", () => {
    expect(RELEASE_UPDATE_PUBLIC_KEYS).toEqual([
      {
        publicKey: "/QcvJ88lzHM5/JLVgAfn12mVRJrWBwR0vJVXwkyQY1Y=",
        label: "MANGA Release Update",
      },
    ]);
  });

  it("disables online update checks in the development channel and returns UPDATE_UNAVAILABLE (AT-159)", async () => {
    const env = createTempEnv();
    const server = await startFakeReleaseServer();
    cleanups.push(() => server.close());

    const app = new MangaProductApp({
      profileRoot: env.profileRoot,
      documentsDir: env.documentsDir,
      downloadsDir: env.downloadsDir,
      channel: "development",
      vault: new TestVault(),
      ffmpegTools: null,
      buildInfo: {
        version: "0.1.2-dev.202611081200",
        channel: "development",
        commit: "c79f49a",
        builtAt: "2026-11-08T12:00:00.000Z",
        schemaVersion: 14,
      },
      update: {
        feedUrl: server.baseUrl,
        allowLoopbackHttp: true,
        initialDelayMs: 10,
      },
    });
    cleanups.push(() => app.close());
    await app.start();
    const grant = app.issueOwnerGrant({ kind: "user", id: "u1" }).handle;
    const actor = { kind: "user" as const, id: "u1" };

    app.startScheduler();
    await new Promise((r) => setTimeout(r, 40));
    expect(server.requests).toHaveLength(0);

    const statusRes = await app.call(actor, { commandId: "update.status", idempotencyKey: "k1", input: {} }, grant);
    expect(statusRes.status).toBe("ok");
    expect((statusRes.value as { state: string }).state).toBe("unavailable");

    const checkRes = await app.call(actor, { commandId: "update.check", idempotencyKey: "k2", input: {} }, grant);
    expect(checkRes.status).toBe("error");
    expect(checkRes.error?.code).toBe("UPDATE_UNAVAILABLE");
    expect(checkRes.error?.message).toContain("开发版由本机构建自动更新");

    const restartRes = await app.call(actor, { commandId: "update.restartToUpdate", idempotencyKey: "k3", input: {} }, grant);
    expect(restartRes.status).toBe("error");
    expect(restartRes.error?.code).toBe("UPDATE_UNAVAILABLE");
  });

  it("performs differential blockmap download, verifies Ed25519 signature, checks busy tasks, backs up DB before restart, and shows justUpdated once on first launch (AT-159)", async () => {
    const env = createTempEnv();
    const keys = makeTestKeyPair();
    const server = await startFakeReleaseServer();
    cleanups.push(() => server.close());

    // Build synthetic 0.1.1 installer (8 blocks of 4096 bytes = 32768 bytes) and 0.1.2 installer (6 shared blocks + 2 changed blocks).
    const blockSize = 4096;
    const sharedBlocks = Array.from({ length: 6 }, (_, i) => Buffer.alloc(blockSize, i + 1));
    const v1Blocks = [...sharedBlocks, randomBytes(blockSize), randomBytes(blockSize)];
    const v2ChangedBlocks = [randomBytes(blockSize), randomBytes(blockSize)];
    const v1Bytes = Buffer.concat(v1Blocks);
    const v2Bytes = Buffer.concat([...sharedBlocks, ...v2ChangedBlocks]);

    const v1BlockMapGzip = serializeBlockMapGzip(buildBlockMap(v1Bytes, blockSize));
    const v2BlockMapGzip = serializeBlockMapGzip(buildBlockMap(v2Bytes, blockSize));

    const v2FileName = "manga-setup-0.1.2.exe";
    const v2TempInstaller = path.join(env.root, v2FileName);
    fs.writeFileSync(v2TempInstaller, v2Bytes);
    const signedV2 = signReleaseInstaller({
      installerPath: v2TempInstaller,
      version: "0.1.2",
      fileName: v2FileName,
      privateKeyPem: keys.privateKeyPem,
    });

    server.files.set(
      "latest.yml",
      formatLatestYaml({
        version: "0.1.2",
        fileName: v2FileName,
        sha512: sha512BytesBase64(v2Bytes),
        size: v2Bytes.length,
        schemaVersion: 15,
        releaseNotes: "1. 支持每周自动发布\n2. 升级资料库到 v15",
      }),
    );
    server.files.set(v2FileName, v2Bytes);
    server.files.set(`${v2FileName}.blockmap`, v2BlockMapGzip);
    server.files.set(`${v2FileName}.sig`, signedV2.sigText);

    const installerRuns: Array<{ installerPath: string; args: string[]; mode: string }> = [];
    let flushedBeforeInstall = false;

    const notices: Array<{ topic: string; payload: Record<string, unknown> }> = [];
    const app1 = new MangaProductApp({
      profileRoot: env.profileRoot,
      documentsDir: env.documentsDir,
      downloadsDir: env.downloadsDir,
      channel: "release",
      packaged: true,
      resourcesPath: env.resourcesDir,
      vault: new TestVault(),
      ffmpegTools: null,
      buildInfo: {
        version: "0.1.1",
        channel: "release",
        commit: "aaaa111",
        builtAt: "2026-11-01T00:00:00.000Z",
        schemaVersion: 14,
      },
      update: {
        feedUrl: server.baseUrl,
        allowLoopbackHttp: true,
        publicKeys: keys.publicKeys,
        appUpdateConfigPath: env.appUpdatePath,
        installDirectory: env.installDir,
        onBeforeInstall: () => {
          flushedBeforeInstall = true;
        },
        runInstaller: (installerPath, args, mode) => {
          installerRuns.push({ installerPath, args, mode });
          return true;
        },
      },
    });
    cleanups.push(() => app1.close());
    await app1.start();
    app1.onNotice((n) => notices.push(n));

    // Seed v0.1.1 installer & blockmap in updater cache so differential download is exercised.
    app1.update.seedCurrentInstallerCache(v1Bytes, v1BlockMapGzip);

    const actor = { kind: "user" as const, id: "u1" };
    const grant = app1.issueOwnerGrant(actor).handle;

    const checkRes = await app1.call(actor, { commandId: "update.check", idempotencyKey: "chk-1", input: {} }, grant);
    expect(checkRes.status).toBe("ok");
    const statusAfterCheck = checkRes.value as {
      state: string;
      availableVersion: string;
      willUpgradeSchema: boolean;
      targetSchemaVersion: number;
      usedDifferential: boolean;
      downloadedBytes: number;
      totalBytes: number;
      releaseNotes: string;
    };
    expect(statusAfterCheck.state).toBe("ready");
    expect(statusAfterCheck.availableVersion).toBe("0.1.2");
    expect(statusAfterCheck.willUpgradeSchema).toBe(true);
    expect(statusAfterCheck.targetSchemaVersion).toBe(15);
    expect(statusAfterCheck.usedDifferential).toBe(true);
    // Only the 2 changed blocks (8192 bytes) were downloaded over HTTP Range instead of all 32768 bytes!
    expect(statusAfterCheck.downloadedBytes).toBe(2 * blockSize);
    expect(statusAfterCheck.totalBytes).toBe(8 * blockSize);
    expect(statusAfterCheck.releaseNotes).toContain("支持每周自动发布");
    expect(notices.some((n) => n.topic === "update.changed" && n.payload.state === "ready")).toBe(true);

    // Privacy check: User-Agent has only version and platform, no user IDs or paths.
    for (const req of server.requests) {
      expect(req.userAgent).toMatch(/^MANGA\/0\.1\.1 \(/);
    }
    expect(server.requests.some((req) => req.range?.startsWith("bytes="))).toBe(true);

    // Busy check when recording is active: restartToUpdate without force returns busy reasons without running installer.
    const busyRes = await app1.call(
      actor,
      { commandId: "update.restartToUpdate", idempotencyKey: "rst-busy", input: { busyReasons: ["recording"] } },
      grant,
    );
    expect(busyRes.status).toBe("ok");
    expect(busyRes.value).toEqual({
      status: "busy",
      restarted: false,
      busyReasons: ["recording"],
      version: "0.1.2",
    });
    expect(installerRuns).toHaveLength(0);

    // Confirming restart (force: true) flushes saves, writes pre-update backup, and spawns the verified installer.
    const restartRes = await app1.call(
      actor,
      { commandId: "update.restartToUpdate", idempotencyKey: "rst-force", input: { force: true, busyReasons: ["recording"] } },
      grant,
    );
    expect(restartRes.status).toBe("ok");
    expect(restartRes.value).toMatchObject({
      status: "restarting",
      restarted: true,
      version: "0.1.2",
    });
    expect(flushedBeforeInstall).toBe(true);
    expect(installerRuns).toHaveLength(1);
    expect(installerRuns[0]!.mode).toBe("restart");
    expect(installerRuns[0]!.args).toEqual(["--updated", "/S", "--force-run", `/D=${env.installDir}`]);

    const preupdateBackup = path.join(app1.layout.partitions.backups, "manga.sqlite.preupdate-v0.1.1.sqlite");
    expect(fs.existsSync(preupdateBackup)).toBe(true);

    app1.close();

    // First launch after update as v0.1.2: shows justUpdated once, then clears it.
    const app2 = new MangaProductApp({
      profileRoot: env.profileRoot,
      documentsDir: env.documentsDir,
      downloadsDir: env.downloadsDir,
      channel: "release",
      packaged: true,
      resourcesPath: env.resourcesDir,
      vault: new TestVault(),
      ffmpegTools: null,
      buildInfo: {
        version: "0.1.2",
        channel: "release",
        commit: "bbbb222",
        builtAt: "2026-11-08T15:00:00.000Z",
        schemaVersion: 15,
      },
      update: {
        feedUrl: server.baseUrl,
        allowLoopbackHttp: true,
        publicKeys: keys.publicKeys,
        appUpdateConfigPath: env.appUpdatePath,
      },
    });
    cleanups.push(() => app2.close());
    await app2.start();
    const grant2 = app2.issueOwnerGrant(actor).handle;

    const firstLaunchStatus = (await app2.call(actor, { commandId: "update.status", idempotencyKey: "st-2", input: {} }, grant2)).value as {
      version: string;
      justUpdated: { version: string; previousVersion: string; releaseNotes: string } | null;
    };
    expect(firstLaunchStatus.version).toBe("0.1.2");
    expect(firstLaunchStatus.justUpdated).toEqual({
      version: "0.1.2",
      previousVersion: "0.1.1",
      releaseNotes: "1. 支持每周自动发布\n2. 升级资料库到 v15",
    });

    // Dismissing justUpdated clears it immediately.
    const dismissedStatus = (
      await app2.call(actor, { commandId: "update.status", idempotencyKey: "st-3", input: { dismissJustUpdated: true } }, grant2)
    ).value as { justUpdated: unknown };
    expect(dismissedStatus.justUpdated).toBeNull();
  });

  it("resumes an interrupted download via HTTP Range and installs silently on app quit (autoInstallOnAppQuit, AT-159)", async () => {
    const env = createTempEnv();
    const keys = makeTestKeyPair();
    const server = await startFakeReleaseServer();
    cleanups.push(() => server.close());

    const v2FileName = "manga-setup-0.1.2.exe";
    const v2Bytes = randomBytes(20_000);
    const v2Temp = path.join(env.root, v2FileName);
    fs.writeFileSync(v2Temp, v2Bytes);
    const signed = signReleaseInstaller({
      installerPath: v2Temp,
      version: "0.1.2",
      fileName: v2FileName,
      privateKeyPem: keys.privateKeyPem,
    });

    server.files.set(
      "latest.yml",
      formatLatestYaml({
        version: "0.1.2",
        fileName: v2FileName,
        sha512: sha512BytesBase64(v2Bytes),
        size: v2Bytes.length,
        releaseNotes: "退出时自动安装更新",
      }),
    );
    server.files.set(v2FileName, v2Bytes);
    server.files.set(`${v2FileName}.sig`, signed.sigText);
    // Cut the first download off after 8000 bytes.
    server.interruptFirstDownloadBytes = 8000;

    const quitInstallRuns: Array<{ installerPath: string; args: string[]; mode: string }> = [];
    const app = new MangaProductApp({
      profileRoot: env.profileRoot,
      documentsDir: env.documentsDir,
      downloadsDir: env.downloadsDir,
      channel: "release",
      packaged: true,
      resourcesPath: env.resourcesDir,
      vault: new TestVault(),
      ffmpegTools: null,
      buildInfo: {
        version: "0.1.1",
        channel: "release",
        commit: "aaaa111",
        builtAt: "2026-11-01T00:00:00.000Z",
        schemaVersion: 14,
      },
      update: {
        feedUrl: server.baseUrl,
        allowLoopbackHttp: true,
        publicKeys: keys.publicKeys,
        appUpdateConfigPath: env.appUpdatePath,
        installDirectory: env.installDir,
        runInstaller: (installerPath, args, mode) => {
          quitInstallRuns.push({ installerPath, args, mode });
          return true;
        },
      },
    });
    cleanups.push(() => app.close());
    await app.start();

    // First automatic check gets interrupted at 8000 bytes (stays silent in UI, keeps .part file).
    const firstAttempt = await app.update.check({ manual: false });
    expect(firstAttempt.state).toBe("idle");

    // Second check resumes from byte 8000 via HTTP Range (bytes=8000-) and completes verification!
    const secondAttempt = await app.update.check({ manual: false });
    expect(secondAttempt.state).toBe("ready");
    expect(server.requests.some((r) => r.range === "bytes=8000-")).toBe(true);

    // User quits without clicking "重启以更新": installOnQuit runs silently without --force-run.
    const installedOnQuit = await app.update.installOnQuit();
    expect(installedOnQuit).toBe(true);
    expect(quitInstallRuns).toHaveLength(1);
    expect(quitInstallRuns[0]!.mode).toBe("quit");
    expect(quitInstallRuns[0]!.args).toEqual(["--updated", "/S", `/D=${env.installDir}`]);
  });

  it("rejects tampered 1-byte installer, wrong-version signature, missing .sig, downgrade, and non-HTTPS URL, deleting files and logging each (AT-160)", async () => {
    const env = createTempEnv();
    const keys = makeTestKeyPair();
    const server = await startFakeReleaseServer();
    cleanups.push(() => server.close());

    const v2FileName = "manga-setup-0.1.2.exe";
    const v2Bytes = randomBytes(16_384);
    const v2Temp = path.join(env.root, v2FileName);
    fs.writeFileSync(v2Temp, v2Bytes);
    const validSig = signReleaseInstaller({
      installerPath: v2Temp,
      version: "0.1.2",
      fileName: v2FileName,
      privateKeyPem: keys.privateKeyPem,
    });

    const app = new MangaProductApp({
      profileRoot: env.profileRoot,
      documentsDir: env.documentsDir,
      downloadsDir: env.downloadsDir,
      channel: "release",
      packaged: true,
      resourcesPath: env.resourcesDir,
      vault: new TestVault(),
      ffmpegTools: null,
      buildInfo: {
        version: "0.1.1",
        channel: "release",
        commit: "aaaa111",
        builtAt: "2026-11-01T00:00:00.000Z",
        schemaVersion: 14,
      },
      update: {
        feedUrl: server.baseUrl,
        allowLoopbackHttp: true,
        publicKeys: keys.publicKeys,
        appUpdateConfigPath: env.appUpdatePath,
      },
    });
    cleanups.push(() => app.close());
    await app.start();

    const pendingExe = path.join(app.layout.partitions.cache, "updater", "pending", v2FileName);

    // Case 1: Tampered 1-byte installer (after signing)
    const tamperedBytes = Buffer.from(v2Bytes);
    tamperedBytes[100] = tamperedBytes[100]! ^ 0xff;
    server.files.set(
      "latest.yml",
      formatLatestYaml({
        version: "0.1.2",
        fileName: v2FileName,
        sha512: sha512BytesBase64(tamperedBytes),
        size: tamperedBytes.length,
      }),
    );
    server.files.set(v2FileName, tamperedBytes);
    server.files.set(`${v2FileName}.sig`, validSig.sigText);

    const resTampered = await app.update.check({ manual: true });
    expect(resTampered.state).toBe("error");
    expect(resTampered.errorCode).toBe("UPDATE_VERIFY_FAILED");
    expect(resTampered.error).toContain("更新包校验失败，已保留当前版本");
    expect(fs.existsSync(pendingExe)).toBe(false);

    // Case 2: Valid signature from another version (0.1.1 signature placed next to 0.1.2 installer)
    const wrongVerSig = signReleaseInstaller({
      installerPath: v2Temp,
      version: "0.1.1",
      fileName: "manga-setup-0.1.1.exe",
      privateKeyPem: keys.privateKeyPem,
      outputSigPath: null,
    });
    server.files.set(
      "latest.yml",
      formatLatestYaml({
        version: "0.1.2",
        fileName: v2FileName,
        sha512: sha512BytesBase64(v2Bytes),
        size: v2Bytes.length,
      }),
    );
    server.files.set(v2FileName, v2Bytes);
    server.files.set(`${v2FileName}.sig`, wrongVerSig.sigText);

    const resWrongVer = await app.update.check({ manual: true });
    expect(resWrongVer.state).toBe("error");
    expect(resWrongVer.errorCode).toBe("UPDATE_VERIFY_FAILED");
    expect(fs.existsSync(pendingExe)).toBe(false);

    // Case 3: Missing .sig file on release server
    server.files.delete(`${v2FileName}.sig`);
    const resNoSig = await app.update.check({ manual: true });
    expect(resNoSig.state).toBe("error");
    expect(resNoSig.errorCode).toBe("UPDATE_VERIFY_FAILED");
    expect(fs.existsSync(pendingExe)).toBe(false);

    // Case 4: Downgrade (server offers 0.1.0 while current is 0.1.1)
    server.files.set(
      "latest.yml",
      formatLatestYaml({
        version: "0.1.0",
        fileName: "manga-setup-0.1.0.exe",
        sha512: sha512BytesBase64(v2Bytes),
        size: v2Bytes.length,
      }),
    );
    const resDowngrade = await app.update.check({ manual: true });
    expect(resDowngrade.state).toBe("error");
    expect(resDowngrade.errorCode).toBe("UPDATE_VERIFY_FAILED");
    expect(resDowngrade.error).toContain("拒绝安装旧版本更新包");

    // Case 5: Non-HTTPS feed URL (http:// rejected when requireHttps is true or non-loopback)
    app.update.configure({ requireHttps: true });
    const resHttp = await app.update.check({ manual: true });
    expect(resHttp.state).toBe("error");
    expect(resHttp.errorCode).toBe("UPDATE_VERIFY_FAILED");
    expect(resHttp.error).toContain("HTTPS");
    app.update.configure({ requireHttps: false });

    // Verify all 5 rejections were recorded in the operation log
    const logs = app.log.query({ category: "settings" });
    const rejectedLogs = logs.entries.filter((e) => e.action === "update.rejected" && e.outcome === "error");
    expect(rejectedLogs.length).toBeGreaterThanOrEqual(5);
  });

  it("stays silent on automatic check when offline, shows error on manual check, and respects autoCheck toggle (AT-159, AT-160)", async () => {
    const env = createTempEnv();
    const app = new MangaProductApp({
      profileRoot: env.profileRoot,
      documentsDir: env.documentsDir,
      downloadsDir: env.downloadsDir,
      channel: "release",
      packaged: true,
      resourcesPath: env.resourcesDir,
      vault: new TestVault(),
      ffmpegTools: null,
      buildInfo: {
        version: "0.1.1",
        channel: "release",
        commit: "aaaa111",
        builtAt: "2026-11-01T00:00:00.000Z",
        schemaVersion: 14,
      },
      update: {
        // Unreachable loopback port
        feedUrl: "http://127.0.0.1:9",
        allowLoopbackHttp: true,
        appUpdateConfigPath: env.appUpdatePath,
      },
    });
    cleanups.push(() => app.close());
    await app.start();

    // Automatic check when offline: stays in "idle" with no UI error, but records in operation_log
    const autoOffline = await app.update.check({ manual: false });
    expect(autoOffline.state).toBe("idle");
    expect(autoOffline.error).toBeNull();
    expect(autoOffline.lastCheckedAt).toBeTruthy();

    // Manual check when offline: transitions to "error" with UPDATE_UNAVAILABLE so user sees why it failed
    const manualOffline = await app.update.check({ manual: true });
    expect(manualOffline.state).toBe("error");
    expect(manualOffline.errorCode).toBe("UPDATE_UNAVAILABLE");
    expect(manualOffline.error).toContain("无法连接更新源");

    const offlineLogs = app.log.query({ category: "settings" }).entries.filter((e) => e.action === "update.offline");
    expect(offlineLogs.length).toBeGreaterThanOrEqual(2);

    // Turning off autoCheck persists in settings
    const updatedSettings = app.update.setSettings({ autoCheck: false });
    expect(updatedSettings.autoCheck).toBe(false);
    expect(app.update.getSettings().autoCheck).toBe(false);
  });

  it("proves NsisUpdater skips verification without publisherName and UpdateService refuses unverified packages when publisherName is removed (计划 3.1, AT-160)", async () => {
    const env = createTempEnv();
    const keys = makeTestKeyPair();
    const server = await startFakeReleaseServer();
    cleanups.push(() => server.close());

    const v2FileName = "manga-setup-0.1.2.exe";
    const v2Bytes = randomBytes(12_288);
    const v2Temp = path.join(env.root, v2FileName);
    fs.writeFileSync(v2Temp, v2Bytes);
    const validSig = signReleaseInstaller({
      installerPath: v2Temp,
      version: "0.1.2",
      fileName: v2FileName,
      privateKeyPem: keys.privateKeyPem,
    });

    // Tamper 1 byte in the installer file
    const tamperedPath = path.join(env.root, "tampered-manga-setup-0.1.2.exe");
    const tamperedBytes = Buffer.from(v2Bytes);
    tamperedBytes[42] = tamperedBytes[42]! ^ 0xff;
    fs.writeFileSync(tamperedPath, tamperedBytes);

    const app = new MangaProductApp({
      profileRoot: env.profileRoot,
      documentsDir: env.documentsDir,
      downloadsDir: env.downloadsDir,
      channel: "release",
      packaged: true,
      resourcesPath: env.resourcesDir,
      vault: new TestVault(),
      ffmpegTools: null,
      buildInfo: {
        version: "0.1.1",
        channel: "release",
        commit: "aaaa111",
        builtAt: "2026-11-01T00:00:00.000Z",
        schemaVersion: 15,
      },
      update: {
        feedUrl: server.baseUrl,
        allowLoopbackHttp: true,
        publicKeys: keys.publicKeys,
        appUpdateConfigPath: env.appUpdatePath,
      },
    });
    cleanups.push(() => app.close());
    await app.start();

    // 1. With publisherName present in app-update.yml: NsisUpdater.verifySignature invokes our Ed25519 verifier and rejects the tampered file!
    const updaterWithPublisher = createConfiguredNsisUpdater({
      updateService: app.update,
      version: "0.1.1",
      appUpdateConfigPath: env.appUpdatePath,
      userDataPath: app.layout.partitions.runtime,
      baseCachePath: app.layout.partitions.cache,
      expectedVersion: () => "0.1.2",
      expectedFileName: () => v2FileName,
      sigText: () => validSig.sigText,
    });
    const verifyResultWithPublisher = await invokeNsisVerifySignature(updaterWithPublisher, tamperedPath);
    expect(verifyResultWithPublisher).toContain("更新包校验失败");
    expect(fs.existsSync(tamperedPath)).toBe(false);

    // 2. Remove publisherName from app-update.yml:
    const yamlWithoutPublisher = appUpdateYaml({ publisherName: [] });
    expect(checkAppUpdateConfig(yamlWithoutPublisher)).toContain("missing publisherName chialecode");
    fs.writeFileSync(env.appUpdatePath, yamlWithoutPublisher, "utf8");
    fs.writeFileSync(tamperedPath, tamperedBytes);

    // NsisUpdater.verifySignature alone returns null (skips verification!) when publisherName is missing in app-update.yml:
    const updaterWithoutPublisher = createConfiguredNsisUpdater({
      updateService: app.update,
      version: "0.1.1",
      appUpdateConfigPath: env.appUpdatePath,
      userDataPath: app.layout.partitions.runtime,
      baseCachePath: app.layout.partitions.cache,
      expectedVersion: () => "0.1.2",
      expectedFileName: () => v2FileName,
      sigText: () => validSig.sigText,
    });
    const rawNsisResult = await invokeNsisVerifySignature(updaterWithoutPublisher, tamperedPath);
    expect(rawNsisResult).toBeNull();

    // 3. Defense-in-depth in UpdateService: even if the installer on the server has a valid signature,
    // when publisherName is missing from app-update.yml, UpdateService refuses to mark it ready, deletes the file, and sets UPDATE_VERIFY_FAILED!
    server.files.set(
      "latest.yml",
      formatLatestYaml({
        version: "0.1.2",
        fileName: v2FileName,
        sha512: sha512BytesBase64(v2Bytes),
        size: v2Bytes.length,
      }),
    );
    server.files.set(v2FileName, v2Bytes);
    server.files.set(`${v2FileName}.sig`, validSig.sigText);

    const statusWithoutPublisher = await app.update.check({ manual: true });
    expect(statusWithoutPublisher.state).toBe("error");
    expect(statusWithoutPublisher.errorCode).toBe("UPDATE_VERIFY_FAILED");
    const pendingExe = path.join(app.layout.partitions.cache, "updater", "pending", v2FileName);
    expect(fs.existsSync(pendingExe)).toBe(false);
  });
});
