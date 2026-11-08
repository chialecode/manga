import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { _electron, chromium } from "playwright-core";
import { isProcessAlive, readRunningInstance, runInstallDev } from "./install-dev.mjs";
import { TEST_CHANNEL_INSTALL, buildInstaller, buildInstallerBlockMap, compareRealInstallations, removeTestInstallations, snapshotRealInstallations } from "./installer-lib.mjs";
import { repoRoot } from "./lib.mjs";
import { BUILD_SCHEMA_VERSION, formatLatestYaml, rawPublicKey, sha512BytesBase64, signReleaseInstaller } from "./version-lib.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (file, algorithm = "sha256", encoding = "hex") => createHash(algorithm).update(fs.readFileSync(file)).digest(encoding);
const requireTrue = (ok, message) => { if (!ok) throw new Error(`upgrade rehearsal failed: ${message}`); };

async function waitFor(read, message, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await delay(100);
  }
  throw new Error(`upgrade rehearsal failed: timed out waiting for ${message}`);
}

function runNative(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("test installer did not finish within five minutes"));
    }, 300_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`test installer exited with ${String(code)}`)); });
  });
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startFeed() {
  const files = new Map();
  const requests = [];
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+/, "");
    const value = files.get(name);
    if (value === undefined) { res.writeHead(404); res.end(); return; }
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
    let start = 0; let end = bytes.length - 1;
    if (match) {
      start = Number(match[1]); end = match[2] ? Number(match[2]) : end;
      if (start > end || end >= bytes.length) { res.writeHead(416); res.end(); return; }
      res.setHeader("Content-Range", `bytes ${start}-${end}/${bytes.length}`);
    }
    const body = bytes.subarray(start, end + 1);
    requests.push({ name, bytes: body.length, range: match ? req.headers.range : null, headers: req.headers });
    res.writeHead(match ? 206 : 200, { "Content-Length": body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    files, requests, baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}

async function call(page, commandId, input = {}) {
  const reply = await page.evaluate(({ commandId, input }) => window.manga.command({ commandId, input, idempotencyKey: crypto.randomUUID() }), { commandId, input });
  requireTrue(reply.status === "ok", `${commandId} returned ${reply.error?.code ?? reply.status}`);
  return reply.value;
}

function databaseHasText(file, text) {
  const database = new Database(file, { readonly: true });
  try {
    requireTrue(database.pragma("integrity_check", { simple: true }) === "ok", "backup integrity check");
    return database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().some(({ name }) => {
      const quoted = `"${name.replaceAll('"', '""')}"`;
      return database.prepare(`SELECT * FROM ${quoted}`).all().some((row) => JSON.stringify(row).includes(text));
    });
  } finally { database.close(); }
}

/**
 * Drive the packaged desktop, upstream updater, actual NSIS processes and post-install relaunch.
 * Only installation identity and smoke trust differ. Every HTTP-served test installer is the exact
 * verified file the detached helper executes; the installed app.asar must match the packaged code.
 * The previous release may be repackaged under a test identity after its original signature is verified.
 */
export async function runPackagedUpdateRehearsal({
  appDir, previousAppDir = appDir, version, previousVersion = "0.1.0",
  previousRelease = { kind: "current-source-seed" }, includeDevelopment = false,
  preparedInstallers = {}, snapshotOptions = {}, tamperMainInstaller = false,
} = {}) {
  if (process.platform !== "win32") throw new Error("packaged update rehearsal requires Windows x64");
  const started = Date.now();
  const realBefore = snapshotRealInstallations(snapshotOptions);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-update-rehearsal-"));
  const programs = path.join(root, "Programs with spaces");
  const installDir = (channel) => path.join(programs, TEST_CHANNEL_INSTALL[channel].dirName);
  const exeOf = (channel) => path.join(installDir(channel), `${TEST_CHANNEL_INSTALL[channel].executableName}.exe`);
  const appAsarSha256 = hash(path.join(appDir, "resources/app.asar"));
  const previousAsarSha256 = hash(path.join(previousAppDir, "resources/app.asar"));
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyBase64 = rawPublicKey(publicKey).toString("base64");
  const live = new Set();
  let feed;
  let cleanupSafe = true;
  let succeeded = false;
  let failure = null;
  const environments = new Map();
  const placesFor = (name) => {
    const places = { programs, local: path.join(root, name, "local data"), documents: path.join(root, name, "用户 文档"), downloads: path.join(root, name, "downloads") };
    for (const dir of Object.values(places)) fs.mkdirSync(dir, { recursive: true });
    return places;
  };
  const environment = (places, extra = {}) => {
    const env = { ...process.env, LOCALAPPDATA: places.local, MANGA_DOCUMENTS_DIR: places.documents, MANGA_DOWNLOADS_DIR: places.downloads,
      MANGA_WINDOW_HIDDEN: "1", MANGA_SMOKE_PHASE: "update-driver", MANGA_SMOKE_UPDATE_PUBLIC_KEY: publicKeyBase64,
      MANGA_UPDATE_INITIAL_DELAY_MS: "86400000", MANGA_UPDATE_INTERVAL_MS: "86400000", ...extra };
    for (const key of ["MANGA_PROFILE_ROOT", "MANGA_POINTER_FILE", "MANGA_CHANNEL", "MANGA_BUILD_JSON", "MANGA_BUILD_VERSION", "ELECTRON_RUN_AS_NODE", "MANGA_HOLD_WRITE_MS", "NODE_ENV"]) delete env[key];
    return env;
  };
  const runtimeFor = (places, channel) => path.join(places.local, TEST_CHANNEL_INSTALL[channel].dirName, "runtime");

  async function launch(places, channel, extra = {}, args = []) {
    const env = environment(places, { MANGA_UPDATE_FEED_URL: feed.baseUrl, ...extra });
    environments.set(runtimeFor(places, channel), env);
    const handle = await _electron.launch({ executablePath: exeOf(channel), args: ["--manga-smoke", ...args], env, cwd: repoRoot, timeout: 60_000 });
    const instance = { handle, page: null, pid: handle.process().pid, runtime: runtimeFor(places, channel), exe: exeOf(channel), env };
    live.add(instance);
    const page = await handle.firstWindow();
    await page.waitForFunction(() => Boolean(window.manga && document.querySelector('[data-testid="context-host"][data-active="true"]')), undefined, { timeout: 30_000 });
    const running = await waitFor(() => { const value = readRunningInstance(runtimeFor(places, channel)); return value?.state === "ready" && isProcessAlive(value.pid) && value; }, "desktop readiness");
    instance.page = page;
    instance.pid = running.pid;
    return instance;
  }

  async function connect(places, channel, port, oldPid) {
    const runtime = runtimeFor(places, channel);
    const running = await waitFor(() => { const value = readRunningInstance(runtime); return value?.state === "ready" && value.pid !== oldPid && value.version && isProcessAlive(value.pid) && value; }, "new desktop process");
    const instance = { handle: null, page: null, pid: running.pid, runtime, exe: exeOf(channel), env: environments.get(runtime), port };
    live.add(instance);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 30_000 });
    instance.handle = browser;
    const page = browser.contexts()[0].pages()[0];
    instance.page = page;
    await page.waitForFunction(() => Boolean(window.manga && document.querySelector('[data-testid="context-host"][data-active="true"]')), undefined, { timeout: 30_000 });
    return instance;
  }

  async function stop(instance) {
    if (isProcessAlive(instance.pid)) {
      fs.writeFileSync(path.join(instance.runtime, "release-blocking-write.json"), "release");
      // Cleanup cancels only this isolated profile's pending update. It must not
      // start another installation or relaunch while removing the test identity.
      const updaterDir = path.join(path.dirname(instance.runtime), "cache/updater");
      if (fs.existsSync(updaterDir)) {
        for (const name of fs.readdirSync(updaterDir).filter((name) => /^update-install_.*\.json$/.test(name))) {
          const plan = JSON.parse(fs.readFileSync(path.join(updaterDir, name), "utf8"));
          if (plan.pid === instance.pid && path.dirname(path.resolve(plan.cancelFile)) === path.resolve(updaterDir)) fs.writeFileSync(plan.cancelFile, "test cleanup");
        }
        const pending = path.join(updaterDir, "pending");
        if (fs.existsSync(pending)) for (const name of fs.readdirSync(pending).filter((name) => name.endsWith(".exe.sig"))) fs.rmSync(path.join(pending, name), { force: true });
      }
      if (!instance.handle && instance.port) {
        instance.handle = await chromium.connectOverCDP(`http://127.0.0.1:${instance.port}`, { timeout: 10_000 });
        instance.page = instance.handle.contexts()[0].pages()[0];
      }
      try {
        if (instance.page) await instance.page.evaluate(() => window.manga.quit());
        else if (instance.handle?.evaluate) await instance.handle.evaluate(({ app }) => app.quit());
        else throw new Error("no connection to the test desktop during cleanup");
      } catch {
        if (instance.handle?.evaluate) await instance.handle.evaluate(({ app }) => app.quit()).catch(() => {});
      }
      await waitFor(() => !isProcessAlive(instance.pid), "desktop exit", 40_000);
    }
    live.delete(instance);
    try { await instance.handle?.close(); } catch { /* process already exited */ }
  }

  async function openDraft(instance, title, text) {
    const note = await call(instance.page, "notes.create", { title, text: "升级前已保存的内容" });
    // Use the normal search to open the note; no controller or fake draft is injected.
    await instance.page.keyboard.press("Control+k");
    const search = instance.page.getByTestId("search-input");
    await search.fill(title);
    await instance.page.getByTestId("search-result-note").filter({ hasText: title }).first().click();
    const editor = instance.page.locator('[data-testid="note-editor"] [contenteditable="true"]').first();
    await editor.waitFor();
    await editor.fill(text);
    const before = await call(instance.page, "notes.get", { objectId: note.objectId });
    requireTrue(!JSON.stringify(before).includes(text), "note was already saved before the quit request");
    return { objectId: note.objectId, title, text };
  }

  async function verifyData(instance, note, expectedVersion, previous, backup) {
    const status = await call(instance.page, "update.status");
    requireTrue(status.version === expectedVersion, "running version after install");
    if (previous) requireTrue(status.justUpdated?.version === expectedVersion && status.justUpdated?.previousVersion === previous, "first launch update notice");
    const value = await call(instance.page, "notes.get", { objectId: note.objectId });
    requireTrue(JSON.stringify(value).includes(note.text), "unsaved note did not survive update");
    await waitFor(async () => {
      const selected = await instance.page.locator('[data-testid="context-host"][data-active="true"] [role="tab"][aria-selected="true"]').allTextContents();
      return selected.some((text) => text.includes(note.title));
    }, "saved note tab focus");
    // These isolated profiles have no works. Their normal first-boot library settings
    // cover the restored workspace; return through the real Home button, without opening a note.
    await instance.page.getByTestId("shell-rail").getByRole("button", { name: "主页", exact: true }).click();
    await instance.page.getByTestId("note-title").filter({ hasText: note.title }).waitFor();
    requireTrue(hash(path.join(path.dirname(instance.exe), "resources/app.asar")) === appAsarSha256, "installed code differs from the packaged application");
    if (backup) requireTrue(fs.existsSync(backup) && databaseHasText(backup, note.text), "pre-update backup omitted the saved note");
    return status;
  }

  async function install(installer, channel) {
    await runNative(installer, ["/S", `/D=${installDir(channel)}`]);
    requireTrue(fs.existsSync(exeOf(channel)), "installer did not create its test executable");
  }

  try {
    await removeTestInstallations();
    const previous = preparedInstallers.releasePrevious ?? await buildInstaller({ appDir: previousAppDir, channel: "release", version: previousVersion, testIdentity: true, workDir: path.join(root, "build/previous") });
    const next = preparedInstallers.releaseNext ?? await buildInstaller({ appDir, channel: "release", version, testIdentity: true, workDir: path.join(root, "build/next") });
    await buildInstallerBlockMap(previous.installer);
    await buildInstallerBlockMap(next.installer);
    const servedName = `manga-setup-${version}.exe`;
    const bytes = fs.readFileSync(next.installer);
    const signature = signReleaseInstaller({ installerPath: next.installer, version, fileName: servedName, privateKeyPem, outputSigPath: null });
    feed = await startFeed();
    feed.files.set("latest.yml", formatLatestYaml({ version, fileName: servedName, sha512: sha512BytesBase64(bytes), size: bytes.length, schemaVersion: BUILD_SCHEMA_VERSION, releaseNotes: "真实桌面升级演练" }));
    const servedBytes = Buffer.from(bytes);
    if (tamperMainInstaller) servedBytes[Math.floor(servedBytes.length / 2)] ^= 0xff;
    feed.files.set(servedName, servedBytes);
    feed.files.set(`${servedName}.sig`, signature.sigText);
    feed.files.set(`${servedName}.blockmap`, fs.readFileSync(`${next.installer}.blockmap`));
    feed.files.set(`manga-setup-${previousVersion}.exe.blockmap`, fs.readFileSync(`${previous.installer}.blockmap`));

    const cases = [];
    let releaseInstance;
    let releasePlaces;
    for (const mode of ["restart", "quit"]) {
      const places = placesFor(mode);
      const runtime = runtimeFor(places, "release");
      await install(previous.installer, "release");
      requireTrue(hash(path.join(installDir("release"), "resources/app.asar")) === previousAsarSha256, "previous version code was replaced");
      if (mode === "quit") {
        const cache = path.join(places.local, "manga-test/cache/updater");
        fs.mkdirSync(cache, { recursive: true });
        fs.copyFileSync(previous.installer, path.join(cache, "installer.exe"));
        fs.copyFileSync(`${previous.installer}.blockmap`, path.join(cache, "current.blockmap"));
      }
      const port = await unusedPort();
      const old = await launch(places, "release", { MANGA_UPDATE_RELAUNCH_ARGS: JSON.stringify(["--manga-smoke", `--remote-debugging-port=${port}`]) });
      old.port = port;
      feed.requests.length = 0;
      const check = await call(old.page, "update.check");
      requireTrue(check.state === "ready", `actual updater did not become ready (${check.errorCode ?? check.state})`);
      const downloadBytes = feed.requests.filter((request) => request.name === servedName).reduce((total, request) => total + request.bytes, 0);
      requireTrue(downloadBytes === check.downloadedBytes, "download byte count differs from the HTTP server");
      requireTrue(mode === "restart" ? downloadBytes === bytes.length && !check.usedDifferential : downloadBytes < bytes.length && check.usedDifferential, "full/differential download did not use the expected upstream path");
      requireTrue(feed.requests.every((request) => !request.headers["x-user-staging-id"] && request.headers["user-agent"]?.startsWith(`MANGA/${previousVersion} (`)), "update request carried an unexpected identifier");
      await old.page.getByTestId("update-banner").waitFor();
      const note = await openDraft(old, `${mode} 升级演练笔记`, `${mode} 退出请求前尚未保存的合成内容`);
      const restartStarted = Date.now();
      if (mode === "restart") await old.page.getByTestId("update-restart-button").click();
      else await old.page.evaluate(() => window.manga.quit());
      await waitFor(async () => {
        if (!isProcessAlive(old.pid)) return true;
        let status;
        try { status = await call(old.page, "update.status"); } catch { /* window closes before its process exits */ }
        if (status) requireTrue(!status.errorCode, `installation preparation failed (${status.errorCode})`);
        return !isProcessAlive(old.pid);
      }, "old process exit");
      // Retain the runtime and port until the replacement is connected, so cleanup can
      // close a relaunched process even if installer acknowledgement or CDP fails.
      const doneFile = path.join(places.local, "manga-test/cache/updater/last-installed.json");
      const updaterDir = path.dirname(doneFile);
      const plan = fs.readdirSync(updaterDir).filter((name) => /^update-install_[\da-f-]+\.json$/.test(name))
        .map((name) => JSON.parse(fs.readFileSync(path.join(updaterDir, name), "utf8"))).find((value) => value.mode === mode && value.version === version);
      requireTrue(plan && path.dirname(path.resolve(plan.readyFile)) === path.resolve(updaterDir), "installation plan is missing or escaped its test profile");
      const prepared = JSON.parse(fs.readFileSync(plan.readyFile, "utf8"));
      requireTrue(prepared.attemptId === plan.attemptId && Number.isSafeInteger(prepared.helperPid), "installer helper readiness is invalid");
      const done = await waitFor(() => {
        let result;
        try { result = JSON.parse(fs.readFileSync(doneFile, "utf8").replace(/^\uFEFF/, "")); } catch { /* completion is pending */ }
        if (!result) requireTrue(isProcessAlive(prepared.helperPid), "installer helper exited without a completion record");
        return result;
      }, "NSIS completion", 180_000);
      requireTrue(done.status === "installed" && done.actualVersion === version && done.installerSha512Hex === hash(next.installer, "sha512"), `downloaded and executed installers differ or installation failed (${done.failureStage ?? done.status})`);
      const updated = mode === "restart" ? await connect(places, "release", port, old.pid) : await launch(places, "release");
      live.delete(old);
      try { await old.handle.close(); } catch { /* old process exited */ }
      const readyMs = Date.now() - restartStarted;
      const backup = path.join(places.local, "manga-test/backups", `manga.sqlite.preupdate-v${previousVersion}.sqlite`);
      await verifyData(updated, note, version, previousVersion, backup);
      await call(updated.page, "update.status", { dismissJustUpdated: true });
      cases.push({ mode, previousVersion, version, downloader: "electron-updater", downloadBytes, fullBytes: bytes.length, usedDifferential: check.usedDifferential,
        oldProcessExited: true, newProcessStarted: updated.pid !== old.pid, verifiedInstallerExecuted: true, draftWasUnsaved: true, draftPreserved: true, backupContainsSavedDraft: true, workspaceRestored: true, savedTabSelectedBeforeNavigation: true, emptyLibraryOnboarding: true, readyMs });
      await stop(updated);
      if (mode === "quit") {
        // A second boot of the same installed version must not announce the update again.
        releaseInstance = await launch(places, "release");
        releasePlaces = places;
        const status = await call(releaseInstance.page, "update.status");
        requireTrue(status.justUpdated === null, "update notice repeated on second boot");
        await verifyData(releaseInstance, note, version);
      }
    }

    // Keep the checksum valid for the tampered bytes so this exercises the actual Ed25519 hook,
    // rather than stopping at the updater's ordinary SHA-512 check.
    const badVersion = `0.1.${Number(version.split(".")[2]) + 1}`;
    const badName = `manga-setup-${badVersion}.exe`;
    const tampered = Buffer.from(bytes); tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    const badSignature = signReleaseInstaller({ installerPath: next.installer, version: badVersion, fileName: badName, privateKeyPem, outputSigPath: null });
    feed.files.set("latest.yml", formatLatestYaml({ version: badVersion, fileName: badName, sha512: sha512BytesBase64(tampered), size: tampered.length, schemaVersion: BUILD_SCHEMA_VERSION }));
    feed.files.set(badName, tampered); feed.files.set(`${badName}.sig`, badSignature.sigText);
    const rejected = await call(releaseInstance.page, "update.check");
    requireTrue(rejected.state === "error" && rejected.errorCode === "UPDATE_VERIFY_FAILED", "actual publisher hook accepted tampered data");
    requireTrue(!fs.existsSync(path.join(releasePlaces.local, "manga-test/cache/updater/pending", badName)), "rejected installer was retained");

    let development = null;
    if (includeDevelopment) {
      const oldDevVersion = preparedInstallers.developmentPrevious?.version ?? "0.1.1-dev.202611010000";
      const newDevVersion = preparedInstallers.developmentNext?.version ?? "0.1.1-dev.202611080000";
      const devPrevious = preparedInstallers.developmentPrevious ?? await buildInstaller({ appDir, channel: "development", version: oldDevVersion, testIdentity: true, workDir: path.join(root, "build/dev-previous") });
      const devNext = preparedInstallers.developmentNext ?? await buildInstaller({ appDir, channel: "development", version: newDevVersion, testIdentity: true, workDir: path.join(root, "build/dev-next") });
      await install(devPrevious.installer, "development");
      const dev = await launch(releasePlaces, "development");
      const draft = await openDraft(dev, "开发版升级演练笔记", "开发版收到退出请求前尚未保存的合成内容");
      const releasePid = releaseInstance.pid;
      const releaseExeBefore = hash(exeOf("release"));
      const port = await unusedPort();
      dev.port = port;
      const installStarted = Date.now();
      const installed = await runInstallDev({ testIdentity: true, places: releasePlaces, installDir: installDir("development"), installerPath: devNext.installer,
        newVersion: devNext.version, evidenceDir: null, env: { ...dev.env, CI: "", GITHUB_ACTIONS: "", MANGA_DEV_AUTO_INSTALL: "1" },
        relaunchEnv: { MANGA_SMOKE_PHASE: "update-driver", MANGA_WINDOW_HIDDEN: "1" }, relaunchArgs: ["--manga-smoke", `--remote-debugging-port=${port}`] });
      requireTrue(installed.status === "passed" && installed.installed && installed.relaunched, "real install-dev did not install and relaunch");
      const nextDev = await connect(releasePlaces, "development", port, dev.pid);
      live.delete(dev);
      try { await dev.handle.close(); } catch { /* old process exited */ }
      const installDevMs = Date.now() - installStarted;
      await verifyData(nextDev, draft, devNext.version);
      requireTrue(isProcessAlive(releasePid) && hash(exeOf("release")) === releaseExeBefore && (await call(releaseInstance.page, "update.status")).version === version, "running release channel was changed by install-dev");
      await stop(nextDev);

      // A real process waits on a synthetic 60-second write. The actual 30-second installer
      // timeout must withdraw its request; releasing the write afterwards must not exit it.
      const held = await launch(releasePlaces, "development", {}, ["--manga-hold-write-ms=60000"]);
      await waitFor(() => readRunningInstance(held.runtime)?.blockingWrites === true, "blocking write barrier");
      const aborted = await runInstallDev({ testIdentity: true, places: releasePlaces, installDir: installDir("development"), installerPath: devNext.installer,
        newVersion: devNext.version, evidenceDir: null, env: { ...held.env, CI: "", GITHUB_ACTIONS: "", MANGA_DEV_AUTO_INSTALL: "1" } });
      requireTrue(aborted.status === "aborted" && !aborted.installed && isProcessAlive(held.pid), "long write was force-killed or installer ran");
      fs.writeFileSync(path.join(held.runtime, "release-blocking-write.json"), "release");
      await waitFor(() => readRunningInstance(held.runtime)?.blockingWrites === false && isProcessAlive(held.pid), "write completed without exiting after withdrawn request");
      requireTrue(!fs.existsSync(path.join(held.runtime, "quit-for-update.json")), "abandoned quit request was retained");
      await call(held.page, "workspace.get");
      await stop(held);
      development = { kind: "electron-nsis", oldVersion: devPrevious.version, newVersion: devNext.version, draftWasUnsaved: true, draftPreserved: true,
        installed: true, relaunched: true, releaseProcessKeptRunning: true, releaseExecutableUntouched: true, timeoutMs: 30_000,
        timedOutWithoutForceKill: true, stayedAliveAfterWriteCompleted: true, installDevMs };
    }
    await stop(releaseInstance);
    await removeTestInstallations();
    const realAfter = snapshotRealInstallations(snapshotOptions);
    requireTrue(compareRealInstallations(realBefore, realAfter).ok, "real installation snapshot changed");
    succeeded = true;
    return { ok: true, kind: "electron-nsis", artifactKind: "test-identity-repackage", previousRelease, previousVersion, upgradedVersion: version,
      appAsarSha256, previousAsarSha256, verifiedInstallerExecuted: true, dataIntact: true, backupCreated: true, tamperedRejected: true,
      justUpdatedOnce: true, realInstallationsUntouched: true, cases, development,
      records: { downloadBytes: { fullBytes: cases[0].downloadBytes, differentialBytes: cases[1].downloadBytes, savedRatio: 1 - cases[1].downloadBytes / cases[0].downloadBytes },
        restartToReadyMs: cases[0].readyMs, installDevMs: development?.installDevMs ?? null }, seconds: Number(((Date.now() - started) / 1000).toFixed(2)) };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    const probes = [...live];
    const pendingHelpers = [];
    // A failure can occur after the old window closes but before its helper installs
    // or relaunches. Cancel and settle those helpers before uninstalling the identity.
    for (const runtime of environments.keys()) {
      const updaterDir = path.join(path.dirname(runtime), "cache/updater");
      if (!fs.existsSync(updaterDir)) continue;
      try {
        for (const name of fs.readdirSync(updaterDir).filter((name) => /^update-install_[\da-f-]+\.json$/.test(name))) {
          const plan = JSON.parse(fs.readFileSync(path.join(updaterDir, name), "utf8"));
          requireTrue(path.dirname(path.resolve(plan.cancelFile)) === path.resolve(updaterDir), "helper cancellation escaped its test profile");
          fs.writeFileSync(plan.cancelFile, "test cleanup");
          if (fs.existsSync(plan.readyFile)) {
            const ready = JSON.parse(fs.readFileSync(plan.readyFile, "utf8"));
            pendingHelpers.push({ ...plan, helperPid: ready.helperPid });
          }
        }
      } catch { cleanupSafe = false; }
    }
    for (const instance of probes) {
      const running = readRunningInstance(instance.runtime);
      if (running?.pid !== instance.pid && isProcessAlive(running?.pid) && ![...live].some((other) => other.pid === running.pid)) {
        live.add({ ...instance, pid: running.pid, handle: null, page: null });
      }
    }
    for (const instance of [...live]) {
      try { await stop(instance); } catch { cleanupSafe = false; }
    }
    for (const plan of pendingHelpers) {
      try {
        await waitFor(() => {
          let done;
          try { done = JSON.parse(fs.readFileSync(plan.doneFile, "utf8").replace(/^\uFEFF/, "")); } catch { /* completion is pending */ }
          if (done?.attemptId === plan.attemptId) return true;
          requireTrue(isProcessAlive(plan.helperPid), "installer helper stopped without confirming completion");
          return false;
        }, "cancelled installer helper completion", 180_000);
      } catch { cleanupSafe = false; }
    }
    for (const instance of probes) {
      const running = readRunningInstance(instance.runtime);
      if (isProcessAlive(running?.pid) && ![...live].some((other) => other.pid === running.pid)) {
        const replacement = { ...instance, pid: running.pid, handle: null, page: null };
        live.add(replacement);
        try { await stop(replacement); } catch { cleanupSafe = false; }
      }
    }
    try { await feed?.close(); } catch { cleanupSafe = false; }
    if (cleanupSafe) {
      try { await removeTestInstallations(); } catch { cleanupSafe = false; }
    }
    let cleanupOk = false;
    try { cleanupOk = cleanupSafe && compareRealInstallations(realBefore, snapshotRealInstallations(snapshotOptions)).ok; } catch { /* retain the scene for inspection */ }
    if (succeeded && cleanupOk) {
      try {
        const resolved = path.resolve(root);
        requireTrue(path.dirname(resolved).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase() && path.basename(resolved).startsWith("manga-update-rehearsal-"), "temporary cleanup target escaped its task root");
        fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch { cleanupOk = false; }
    }
    if (!succeeded || !cleanupOk) console.error(`Update rehearsal diagnostics retained at ${root}`);
    if (failure && !cleanupOk) console.error("Update rehearsal cleanup incomplete; diagnostic scene retained");
    else requireTrue(cleanupOk, "cleanup failed or real installation snapshot changed");
  }
}
