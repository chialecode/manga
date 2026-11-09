import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  FAILURES_BEFORE_ASKING,
  LAUNCH_ATTEMPT_FILE,
  LAUNCH_HISTORY_FILE,
  WATCHED_LAUNCHES,
  beginLaunch,
  commitVerifiedRollback,
  evaluateBootstrapStart,
  guardPaths,
  launchSucceeded,
  prepareRollback,
  questionText,
  readSkipped,
  retryLaunch,
  rollbackPlan,
  verifiedPrevious,
  type PreviousInstaller,
} from "../../apps/desktop/src/main/launch-guard.ts";
import { LIGHT_QUIT_ACK_FILE, LIGHT_QUIT_REQUEST_FILE, answerQuitRequest, askLightToQuit, readQuitRequest, writeLightInstance } from "../../apps/desktop/src/main/light-runtime.ts";
import { appRootOf, channelInfoOf, lightDirsOf } from "../../apps/desktop/src/main/launch-paths.ts";

/**
 * The way back after an update that does not start (4.2, LOOP-32) and light open's leaving before an install (4.6). Synthetic folders only.
 */
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const scratch = (prefix = "guard") => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `manga-${prefix}-`)); dirs.push(dir); return dir; };
const writeJson = (file: string, body: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(body)); };

function updatedTo(appRoot: string, version: string) {
  const paths = guardPaths(appRoot);
  writeJson(path.join(paths.updaterCache, "last-installed.json"), { status: "installed", version, actualVersion: version });
  return paths;
}

describe("the starts after an update are watched, and two failures in a row ask (AT-165, 4.2)", () => {
  it("does not watch a start that did not come by an update", () => {
    const paths = guardPaths(scratch());
    expect(beginLaunch(paths, "0.1.3")).toEqual({ kind: "ordinary" });
    expect(fs.existsSync(path.join(paths.runtime, LAUNCH_ATTEMPT_FILE))).toBe(false);
  });

  it("counts only the first three starts, a ready window clears the marker, and a later failure is not counted", () => {
    const paths = updatedTo(scratch(), "0.1.3");
    for (let n = 1; n <= WATCHED_LAUNCHES; n += 1) {
      expect(beginLaunch(paths, "0.1.3")).toEqual({ kind: "watched", attempt: n });
      launchSucceeded(path.join(paths.runtime, LAUNCH_ATTEMPT_FILE));
    }
    expect(beginLaunch(paths, "0.1.3")).toEqual({ kind: "ordinary" });
    expect(beginLaunch(paths, "0.1.3")).toEqual({ kind: "ordinary" });
  });

  it("asks after two failed starts in a row, and 'try again' starts the count again", () => {
    const root = scratch();
    const paths = updatedTo(root, "0.1.3");
    expect(beginLaunch(paths, "0.1.3")).toEqual({ kind: "watched", attempt: 1 });
    // The start never reached its window: the marker stays.
    expect(beginLaunch(paths, "0.1.3")).toEqual({ kind: "watched", attempt: 2 });
    const asked = beginLaunch(paths, "0.1.3");
    expect(asked).toMatchObject({ kind: "ask", version: "0.1.3", failures: FAILURES_BEFORE_ASKING, previous: null });
    retryLaunch(paths, "0.1.3");
    expect(beginLaunch(paths, "0.1.3").kind).toBe("watched");
    // One failure after the retry is not yet a question.
    expect(beginLaunch(paths, "0.1.3").kind).toBe("watched");
  });

  it("words the question with the previous version, or without a one-click way back", () => {
    const previous = { version: "0.1.2", schemaVersion: 14, targetSchemaVersion: 15 } as PreviousInstaller;
    const asked = questionText("0.1.3", previous);
    expect(asked.message).toBe("MANGA 0.1.3 上次没能正常启动。");
    expect(asked.buttons).toEqual(["回到 0.1.2", "再试一次", "打开下载页"]);
    expect(asked.detail).toContain("会恢复更新前自动备份的资料库");
    expect(questionText("0.1.3", { ...previous, targetSchemaVersion: 14 }).detail).toContain("资料库不变");
    expect(questionText("0.1.3", null).buttons).toEqual(["再试一次", "打开下载页"]);
  });
});

describe("going back (AT-165, 4.2)", () => {
  function kept(root: string, overrides: Partial<PreviousInstaller> = {}) {
    const paths = updatedTo(root, "0.1.3");
    const dir = path.join(paths.updaterCache, "previous");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "installer-0.1.2.exe"), "synthetic previous installer");
    const database = path.join(paths.data, "manga.sqlite");
    fs.mkdirSync(paths.data, { recursive: true });
    fs.writeFileSync(database, "library after the update");
    fs.writeFileSync(`${database}-wal`, "wal after the update");
    const backup = path.join(root, "backups", "manga.sqlite.preupdate-v0.1.2.sqlite");
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.writeFileSync(backup, "library before the update");
    const record: PreviousInstaller = {
      version: "0.1.2", sha512Hex: createHash("sha512").update("synthetic previous installer").digest("hex"), file: "installer-0.1.2.exe",
      schemaVersion: 14, targetVersion: "0.1.3", targetSchemaVersion: 15, database, backup, keptAt: "2026-11-09T00:00:00.000Z", ...overrides,
    };
    writeJson(path.join(dir, "previous.json"), record);
    return { paths, database, backup, dir };
  }

  it("runs only a kept installer whose bytes are the recorded ones", () => {
    const root = scratch();
    const { paths, dir } = kept(root);
    expect(verifiedPrevious(paths)?.version).toBe("0.1.2");
    fs.appendFileSync(path.join(dir, "installer-0.1.2.exe"), "!");
    expect(verifiedPrevious(paths)).toBeNull();
  });

  it("keeps the library in use under a new name, puts back the backup, skips the version and leaves a record", () => {
    const root = scratch();
    const { paths, database } = kept(root);
    const previous = verifiedPrevious(paths)!;
    const plan = rollbackPlan(previous, "0.1.3", new Date("2026-11-10T01:02:03.000Z"));
    expect(plan.database?.keptAs).toBe(`${database}.rolledback-2026-11-10T01-02-03-000Z`);
    const done = prepareRollback(paths, plan, new Date("2026-11-10T01:02:03.000Z"));
    expect(done.databaseRestored).toBe(true);
    expect(fs.readFileSync(database, "utf8")).toBe("library before the update");
    expect(fs.readFileSync(plan.database!.keptAs, "utf8")).toBe("library after the update");
    expect(fs.readFileSync(`${plan.database!.keptAs}-wal`, "utf8")).toBe("wal after the update");
    expect(fs.existsSync(`${database}-wal`)).toBe(false);
    expect(readSkipped(paths)).toMatchObject({ version: "0.1.3" });
    expect(JSON.parse(fs.readFileSync(path.join(paths.data, "rollback-record.json"), "utf8"))).toMatchObject({ from: "0.1.3", to: "0.1.2", databaseRestored: true });
    // The previous version did not come by an update: its starts are not watched.
    expect(beginLaunch(paths, "0.1.2")).toEqual({ kind: "ordinary" });
  });

  it("leaves the library alone when the new version did not change its schema", () => {
    const root = scratch();
    const { paths, database } = kept(root, { targetSchemaVersion: 14 });
    const plan = rollbackPlan(verifiedPrevious(paths)!, "0.1.3");
    expect(plan.database).toBeNull();
    expect(prepareRollback(paths, plan).databaseRestored).toBe(false);
    expect(fs.readFileSync(database, "utf8")).toBe("library after the update");
  });

  it("prefers manga.sqlite.premigrate-v<schemaVersion> when present and falls back to previous.backup otherwise", () => {
    const root = scratch();
    const { paths, database, backup } = kept(root);
    const premigrate = `${database}.premigrate-v14`;
    fs.writeFileSync(premigrate, "library from premigrate-v14");
    const previous = verifiedPrevious(paths)!;
    const preferredPlan = rollbackPlan(previous, "0.1.3", new Date("2026-11-10T02:00:00.000Z"));
    expect(preferredPlan.database?.restoreFrom).toBe(premigrate);
    expect(preferredPlan.database?.keptAs).toBe(`${database}.rolledback-2026-11-10T02-00-00-000Z`);
    const committed = commitVerifiedRollback(paths, "0.1.3", new Date("2026-11-10T02:00:00.000Z"));
    expect(committed.kind).toBe("rolled-back");
    expect(fs.readFileSync(database, "utf8")).toBe("library from premigrate-v14");
    expect(fs.readFileSync(`${database}.rolledback-2026-11-10T02-00-00-000Z`, "utf8")).toBe("library after the update");

    // When premigrate-v14 is absent, fallback is previous.backup.
    const fallbackRoot = scratch();
    const fallback = kept(fallbackRoot);
    const fallbackPlan = rollbackPlan(verifiedPrevious(fallback.paths)!, "0.1.3", new Date("2026-11-10T03:00:00.000Z"));
    expect(fallbackPlan.database?.restoreFrom).toBe(fallback.backup);
    expect(backup).toContain("preupdate");
  });

  it("re-verifies the kept installer after the dialog answers 'back' before touching the database", () => {
    const root = scratch();
    const { paths, database, dir } = kept(root);
    // Initial check before showing the dialog succeeds.
    expect(verifiedPrevious(paths)?.version).toBe("0.1.2");
    // While the dialog is open, the kept installer is tampered with.
    fs.appendFileSync(path.join(dir, "installer-0.1.2.exe"), "tampered");
    const result = commitVerifiedRollback(paths, "0.1.3", new Date("2026-11-10T04:00:00.000Z"));
    expect(result).toEqual({ kind: "unverified-fallback-download" });
    expect(fs.readFileSync(database, "utf8")).toBe("library after the update");
    expect(fs.readdirSync(paths.data).some((name) => name.startsWith("manga.sqlite.rolledback-"))).toBe(false);
    expect(readSkipped(paths)).toBeNull();
  });

  it("writes update-skip.json and rollback-record.json to path.dirname(previous.database) when the data dir was relocated", () => {
    const root = scratch();
    const relocatedData = path.join(scratch("relocated"), "custom-data");
    fs.mkdirSync(relocatedData, { recursive: true });
    const relocatedDb = path.join(relocatedData, "manga.sqlite");
    fs.writeFileSync(relocatedDb, "relocated library after update");
    const premigrate = `${relocatedDb}.premigrate-v14`;
    fs.writeFileSync(premigrate, "relocated library before migration");
    const { paths } = kept(root, { database: relocatedDb });
    const committed = commitVerifiedRollback(paths, "0.1.3", new Date("2026-11-10T05:00:00.000Z"));
    expect(committed.kind).toBe("rolled-back");
    expect(fs.readFileSync(relocatedDb, "utf8")).toBe("relocated library before migration");
    expect(fs.existsSync(path.join(relocatedData, "update-skip.json"))).toBe(true);
    expect(fs.existsSync(path.join(relocatedData, "rollback-record.json"))).toBe(true);
    expect(fs.existsSync(path.join(paths.data, "update-skip.json"))).toBe(false);
    expect(fs.existsSync(path.join(paths.data, "rollback-record.json"))).toBe(false);
    expect(readSkipped(paths)).toMatchObject({ version: "0.1.3" });
  });
});

describe("bootstrap start guard rules (AT-165, 4.1, 4.2)", () => {
  function packagedResources(channel: "release" | "development", version = "0.1.3", testIdentity = false) {
    const resourcesPath = scratch("resources");
    writeJson(path.join(resourcesPath, "channel.json"), { channel, testIdentity });
    writeJson(path.join(resourcesPath, "build.json"), { version, channel });
    return resourcesPath;
  }

  it("never counts unpackaged pnpm dev, development builds, --quit-for-update or --manga-light", () => {
    const localAppData = scratch("localappdata");
    const releaseResources = packagedResources("release", "0.1.3", false);
    const devResources = packagedResources("development", "0.1.3-dev.1", false);
    const releaseRoot = appRootOf({ channel: "release", testIdentity: false }, { LOCALAPPDATA: localAppData });
    const devRoot = appRootOf({ channel: "development", testIdentity: false }, { LOCALAPPDATA: localAppData });
    updatedTo(releaseRoot, "0.1.3");
    updatedTo(devRoot, "0.1.3-dev.1");

    // Unpackaged `pnpm dev`
    const unpackaged = evaluateBootstrapStart({ packaged: false, resourcesPath: releaseResources, argv: ["electron", "."], env: { LOCALAPPDATA: localAppData } });
    expect(unpackaged).toEqual({ mode: "full", guarded: null, attemptFile: null, failOnPurpose: false });

    // Packaged `development` channel
    const devStart = evaluateBootstrapStart({ packaged: true, resourcesPath: devResources, argv: ["manga-dev.exe"], env: { LOCALAPPDATA: localAppData } });
    expect(devStart).toEqual({ mode: "full", guarded: null, attemptFile: null, failOnPurpose: false });
    expect(fs.existsSync(path.join(guardPaths(devRoot).runtime, LAUNCH_HISTORY_FILE))).toBe(false);

    // `--quit-for-update` on a release build
    const quitForUpdate = evaluateBootstrapStart({ packaged: true, resourcesPath: releaseResources, argv: ["manga.exe", "--quit-for-update"], env: { LOCALAPPDATA: localAppData } });
    expect(quitForUpdate).toEqual({ mode: "full", guarded: null, attemptFile: null, failOnPurpose: false });
    expect(fs.existsSync(path.join(guardPaths(releaseRoot).runtime, LAUNCH_HISTORY_FILE))).toBe(false);

    // `--manga-light`
    const lightStart = evaluateBootstrapStart({ packaged: true, resourcesPath: releaseResources, argv: ["manga.exe", "--manga-light", "clip.mp4"], env: { LOCALAPPDATA: localAppData } });
    expect(lightStart).toEqual({ mode: "light" });
    expect(fs.existsSync(path.join(guardPaths(releaseRoot).runtime, LAUNCH_HISTORY_FILE))).toBe(false);
  });

  it("ignores MANGA_TEST_FAIL_LAUNCH when testIdentity is false, and honors it only for a test identity", () => {
    const localAppData = scratch("localappdata");
    const realRelease = packagedResources("release", "0.1.3", false);
    const realRoot = appRootOf({ channel: "release", testIdentity: false }, { LOCALAPPDATA: localAppData });
    updatedTo(realRoot, "0.1.3");

    const realWatched = evaluateBootstrapStart({
      packaged: true,
      resourcesPath: realRelease,
      argv: ["manga.exe"],
      env: { LOCALAPPDATA: localAppData, MANGA_TEST_FAIL_LAUNCH: "0.1.3" },
    });
    expect(realWatched.mode).toBe("full");
    if (realWatched.mode === "full") {
      expect(realWatched.guarded?.testIdentity).toBe(false);
      expect(realWatched.guarded?.decision).toEqual({ kind: "watched", attempt: 1 });
      expect(realWatched.failOnPurpose).toBe(false);
    }

    const testRelease = packagedResources("release", "0.1.3", true);
    const testRoot = appRootOf({ channel: "release", testIdentity: true }, { LOCALAPPDATA: localAppData });
    updatedTo(testRoot, "0.1.3");

    const testWatched = evaluateBootstrapStart({
      packaged: true,
      resourcesPath: testRelease,
      argv: ["manga-test.exe"],
      env: { LOCALAPPDATA: localAppData, MANGA_TEST_FAIL_LAUNCH: "0.1.3" },
    });
    expect(testWatched.mode).toBe("full");
    if (testWatched.mode === "full") {
      expect(testWatched.guarded?.testIdentity).toBe(true);
      expect(testWatched.guarded?.decision).toEqual({ kind: "watched", attempt: 1 });
      expect(testWatched.failOnPurpose).toBe(true);
    }
  });
});

describe("light open leaves before an install (AT-169, 4.6)", () => {
  const instance = (pid: number) => ({ pid, execPath: "manga.exe", channel: "release", testIdentity: true, startedAt: new Date().toISOString() });

  it("is a plain yes when nothing is running or the marker is left by a process that is gone", async () => {
    const runtime = scratch("light-rt");
    expect(await askLightToQuit(runtime)).toMatchObject({ ok: true, running: false });
    writeLightInstance(runtime, instance(999_999));
    expect(await askLightToQuit(runtime, { alive: () => false })).toMatchObject({ ok: true, running: false });
    expect(fs.existsSync(path.join(runtime, "light-instance.json"))).toBe(false);
  });

  it("waits for a light open that leaves, and gives up on one that does not, taking its request back", async () => {
    const runtime = scratch("light-rt");
    writeLightInstance(runtime, instance(4242));
    let alive = true;
    const leaving = askLightToQuit(runtime, { alive: () => alive, timeoutMs: 5000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readQuitRequest(runtime)?.reason).toBe("update");
    alive = false;
    expect(await leaving).toMatchObject({ ok: true, running: true });

    const stuck = await askLightToQuit(runtime, { alive: () => true, timeoutMs: 300 });
    expect(stuck).toMatchObject({ ok: false, reason: "light-open-running", pid: 4242 });
    expect(fs.existsSync(path.join(runtime, LIGHT_QUIT_REQUEST_FILE))).toBe(false);
  });

  it("does not wait out the time for a light open that said no", async () => {
    const runtime = scratch("light-rt");
    writeLightInstance(runtime, instance(4243));
    const asking = askLightToQuit(runtime, { alive: () => true, timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    answerQuitRequest(runtime, readQuitRequest(runtime)!, "refused");
    const started = Date.now();
    expect(await asking).toMatchObject({ ok: false, reason: "light-open-running" });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(JSON.parse(fs.readFileSync(path.join(runtime, LIGHT_QUIT_ACK_FILE), "utf8")).status).toBe("refused");
  });

  it("finds light open's folder under the channel's data root, and a test identity's apart from the real one", () => {
    const env = { LOCALAPPDATA: path.join(os.tmpdir(), "local") };
    const release = appRootOf({ channel: "release", testIdentity: false }, env);
    const test = appRootOf({ channel: "release", testIdentity: true }, env);
    expect(path.basename(release)).toBe("manga");
    expect(path.basename(test)).toBe("manga-test");
    expect(path.basename(appRootOf({ channel: "development", testIdentity: true }, env))).toBe("manga-dev-test");
    expect(lightDirsOf(release).runtime).toBe(path.join(release, "light", "runtime"));
    expect(appRootOf({ channel: "release", testIdentity: false }, { ...env, MANGA_PROFILE_ROOT: path.join(os.tmpdir(), "p") })).toBe(path.resolve(os.tmpdir(), "p"));
    expect(channelInfoOf({ resourcesPath: scratch("res"), packaged: false, env: {} })).toEqual({ channel: "development", testIdentity: false });
  });
});
