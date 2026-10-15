import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcquisitionCrash, type AcquisitionFault } from "../../packages/app-core/src/acquisition/service.ts";
import { FAKE_ENGINE_ID } from "../helpers/fake-engine.ts";
import { HASH, MAGNET, addLibrary, boot, emit, engineLog, fails, installFake, jobOf, ok, run, stage, until, waitState, type Rig } from "../helpers/acquisition-app.ts";
import { DRIVE } from "../helpers/hostile-input.ts";

const rigs: Rig[] = [];
afterEach(() => { while (rigs.length) { try { rigs.pop()!.app.close(); } catch { /* closed already */ } } });
const start = async (options: Parameters<typeof boot>[0] = {}) => { const rig = await boot(options); rigs.push(rig); return rig; };

const chapter = (title: string) => `${title}\n\n${"这是用于下载测试的一段合成文字。".repeat(20)}\n`;
type File = { path: string; text: string };
const FILES: File[] = [{ path: "季卷/第1话.txt", text: chapter("第一话") }, { path: "季卷/第2话.txt", text: chapter("第二话") }, { path: "季卷/说明.nfo", text: "not a book" }];
const entryOf = (files: File[]) => files.map((file, index) => ({ index, path: file.path, length: Buffer.byteLength(file.text) }));

/** A job whose files are known and waiting to be chosen. */
async function begin(ctx: Rig, pathId: string, n: number, files: File[] = FILES, extra: Record<string, unknown> = {}): Promise<string> {
  const added = ok<{ jobId: string }>(await run(ctx, "acquisition.add", { magnet: MAGNET(HASH(n)), pathId, subdir: "下载", ...extra }));
  await emit(ctx, "acq.metadata", { jobId: added.jobId, infoHash: HASH(n), name: "季卷", totalLength: files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0), pieceLength: 16384, files: entryOf(files) });
  await waitState(ctx, added.jobId, ["choosing"]);
  return added.jobId;
}
/** The engine's side of a finished transfer: the files are staged and verified. */
async function finishTransfer(ctx: Rig, jobId: string, files: File[], indexes: number[]) {
  for (const index of indexes) stage(ctx, jobId, files[index]!.path, files[index]!.text);
  await emit(ctx, "acq.verifying", { jobId });
  await emit(ctx, "acq.verified", { jobId, files: indexes.map((index) => ({ ...entryOf(files)[index]! })), downloaded: 1000, uploaded: 0 });
}
const choose = async (ctx: Rig, jobId: string, indexes: number[]) => ok(await run(ctx, "acquisition.select", { jobId, indexes }));
const finish = async (ctx: Rig, jobId: string) => { await ctx.app.acquisition.whenSettled(jobId); return jobOf(ctx, jobId); };
const lib = (dir: string, rel: string) => path.join(dir, ...rel.split("/"));
const resourceCount = (rig: Rig) => (rig.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number }).n;
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)).map((rel) => `${entry.name}/${rel}`) : [entry.name]));

describe("what a download needs from the engine, and what it refuses", () => {
  it("has no page and takes no job until an engine is installed", async () => {
    const ctx = await start();
    const { pathId } = await addLibrary(ctx);
    expect(ok<{ engine: { available: boolean; reason: string } }>(await run(ctx, "acquisition.list", {})).engine).toMatchObject({ available: false, reason: "no-plugin" });
    expect(fails(await run(ctx, "acquisition.add", { magnet: MAGNET(HASH(1)), pathId })).details?.reason).toBe("no-plugin");
    expect((ctx.app.workspace() as { uiFacets: string[] }).uiFacets).not.toContain("acquisition");
  });

  it("offers the downloads page once an engine is installed, and not while the feature is off", async () => {
    const ctx = await start();
    await installFake(ctx);
    expect((ctx.app.workspace() as { uiFacets: string[] }).uiFacets).toContain("acquisition");
    ok(await run(ctx, "settings.setModule", { featureId: "acquisition", enabled: false }));
    expect((ctx.app.workspace() as { uiFacets: string[] }).uiFacets).not.toContain("acquisition");
    ok(await run(ctx, "settings.setModule", { featureId: "acquisition", enabled: true }));
    expect((ctx.app.workspace() as { uiFacets: string[] }).uiFacets).toContain("acquisition");
  });

  it("refuses a source that is not a torrent, an unknown library path, a folder that leaves the library, and the same torrent twice", async () => {
    const ctx = await start();
    await installFake(ctx);
    const { pathId } = await addLibrary(ctx);
    expect(fails(await run(ctx, "acquisition.add", { magnet: "https://example.invalid/file.zip", pathId })).details?.reason).toBe("source");
    expect(fails(await run(ctx, "acquisition.add", { magnet: "magnet:?dn=nothing", pathId })).details?.reason).toBe("source");
    expect(fails(await run(ctx, "acquisition.add", { magnet: MAGNET(HASH(1)), pathId: "nope" })).code).toBe("NOT_FOUND");
    expect(fails(await run(ctx, "acquisition.add", { magnet: MAGNET(HASH(1)), pathId, subdir: "../outside" })).details?.reason).toBe("subdir");
    expect(fails(await run(ctx, "acquisition.add", { magnet: MAGNET(HASH(1)), pathId, subdir: `${DRIVE}:/Windows` })).details?.reason).toBe("subdir");
    ok(await run(ctx, "acquisition.add", { magnet: MAGNET(HASH(1)), pathId }));
    const again = fails(await run(ctx, "acquisition.add", { magnet: MAGNET(HASH(1).toUpperCase()), pathId }));
    expect(again.details?.reason).toBe("duplicate");
    expect(ok<{ jobs: unknown[] }>(await run(ctx, "acquisition.list", {})).jobs).toHaveLength(1);
    // The engine's own refusal leaves no job behind.
    expect(fails(await run(ctx, "acquisition.add", { magnet: MAGNET("bad".padEnd(40, "0")), pathId })).details?.reason).toBe("source");
    expect(ok<{ jobs: unknown[] }>(await run(ctx, "acquisition.list", {})).jobs).toHaveLength(1);
  });

  it("does not trust the engine's file names: a path that leaves the download folder fails the job and writes nothing", async () => {
    const ctx = await start();
    await installFake(ctx);
    const { dir, pathId } = await addLibrary(ctx);
    const added = ok<{ jobId: string }>(await run(ctx, "acquisition.add", { magnet: MAGNET(HASH(2)), pathId }));
    await emit(ctx, "acq.metadata", { jobId: added.jobId, infoHash: HASH(2), name: "x", totalLength: 3, pieceLength: 16384, files: [{ index: 0, path: "../evil.txt", length: 3 }] });
    const job = await waitState(ctx, added.jobId, ["failed"]);
    expect(job).toMatchObject({ stage: "transfer", error: { code: "PATH_ESCAPE" } });
    expect(fs.existsSync(path.join(path.dirname(ctx.app.acquisition.stagingOf(added.jobId)), "evil.txt"))).toBe(false);
    expect(walk(dir)).toEqual([]);
    expect((await engineLog(ctx)).some((call) => call.method === "engine.remove" && call.params.jobId === added.jobId)).toBe(true);
  });

  it("keeps the source out of what the person sees, the notices and the operation log", async () => {
    const ctx = await start();
    await installFake(ctx);
    const { pathId } = await addLibrary(ctx);
    const notices: string[] = [];
    ctx.app.onNotice((notice) => notices.push(JSON.stringify(notice)));
    const jobId = await begin(ctx, pathId, 3);
    await choose(ctx, jobId, [0]);
    const seen = [JSON.stringify(ok(await run(ctx, "acquisition.list", {}))), JSON.stringify(ok(await run(ctx, "acquisition.get", { jobId }))), ...notices, JSON.stringify(ctx.app.store.sqlite.prepare("SELECT * FROM operation_log").all())].join("\n");
    expect(seen).not.toContain("SECRETKEY123");
    expect(seen).not.toContain("magnet:?");
    expect(seen).not.toContain("tracker.example.invalid");
    const logged = ctx.app.store.sqlite.prepare("SELECT category, action, object_kind AS kind FROM operation_log WHERE action LIKE 'acquisition.%'").all();
    expect(logged).toEqual(expect.arrayContaining([{ category: "acquisition", action: "acquisition.add", kind: "download" }, { category: "acquisition", action: "acquisition.select", kind: "download" }]));
  });
});

describe("choosing files, the limit set for a download, and the room it needs", () => {
  it("checks the chosen files against the limit and the free space before anything is downloaded", async () => {
    let room: number | null = null;
    const ctx = await start({ acquisition: { freeBytes: () => room } });
    await installFake(ctx);
    const { pathId } = await addLibrary(ctx);
    const jobId = await begin(ctx, pathId, 4, FILES, { budget: { maxBytes: 300 } });
    expect(fails(await run(ctx, "acquisition.select", { jobId, indexes: [0, 1] })).code).toBe("QUOTA_EXCEEDED");
    expect((await jobOf(ctx, jobId)).state).toBe("choosing");
    expect((await engineLog(ctx)).some((call) => call.method === "engine.select")).toBe(false);
    ok(await run(ctx, "acquisition.select", { jobId, indexes: [0], budget: { maxBytes: 100_000_000 } }));
    room = 1000;
    const second = await begin(ctx, pathId, 5);
    expect(fails(await run(ctx, "acquisition.select", { jobId: second, indexes: [0] })).code).toBe("DISK_FULL");
    room = null;
    expect(fails(await run(ctx, "acquisition.select", { jobId: second, indexes: [9] })).details?.reason).toBe("index");
    const picked = ok<{ job: { state: string; selectedBytes: number } }>(await run(ctx, "acquisition.select", { jobId: second, indexes: [0, 1] }));
    expect(picked.job).toMatchObject({ state: "downloading", selectedBytes: entryOf(FILES).slice(0, 2).reduce((sum, file) => sum + file.length, 0) });
    expect((await engineLog(ctx)).filter((call) => call.method === "engine.select").map((call) => call.params.indexes)).toEqual([[0], [0, 1]]);
  });

  it("applies the strictest speed limit of the jobs that are running to the engine", async () => {
    const ctx = await start();
    await installFake(ctx);
    const { pathId } = await addLibrary(ctx);
    const a = await begin(ctx, pathId, 6, FILES, { budget: { downKbps: 500, upKbps: 100 } });
    const b = await begin(ctx, pathId, 7, FILES, { budget: { downKbps: 200 } });
    const limits = async () => (await engineLog(ctx)).filter((call) => call.method === "engine.limits").map((call) => call.params).at(-1);
    expect(await limits()).toEqual({ downKbps: 200, upKbps: 100 });
    ok(await run(ctx, "acquisition.cancel", { jobId: b }));
    expect(await limits()).toEqual({ downKbps: 500, upKbps: 100 });
    ok(await run(ctx, "acquisition.cancel", { jobId: a }));
    expect(await limits()).toEqual({ downKbps: 0, upKbps: 0 });
  });
});

describe.each([["with a hard link (one volume)", false], ["with a copy (as across volumes)", true]])("publishing into the library, %s", (_label, forceCopy) => {
  it("moves the chosen files in under the folder asked for, imports what the library can read, and leaves nothing behind", async () => {
    const ctx = await start({ acquisition: { forceCopy } });
    await installFake(ctx);
    const { dir, pathId } = await addLibrary(ctx);
    const jobId = await begin(ctx, pathId, 10);
    await choose(ctx, jobId, [0, 1, 2]);
    await finishTransfer(ctx, jobId, FILES, [0, 1, 2]);
    const job = await finish(ctx, jobId);
    expect(job).toMatchObject({ state: "done", error: null, counts: { selected: 3, published: 3, imported: 2, skipped: 1, failed: 0 }, seeding: { enabled: false } });
    expect(walk(dir).sort()).toEqual(["下载/季卷/第1话.txt", "下载/季卷/第2话.txt", "下载/季卷/说明.nfo"]);
    expect(fs.readFileSync(lib(dir, "下载/季卷/第1话.txt"), "utf8")).toBe(FILES[0]!.text);
    expect(job.entries!.map((entry) => [entry.index, entry.publishState, entry.importState, entry.note])).toEqual([[0, "published", "imported", null], [1, "published", "imported", null], [2, "published", "skipped", "not-recognized"]]);
    const resource = ctx.app.store.sqlite.prepare("SELECT r.title FROM resources r WHERE r.id = ?").get(job.entries![0]!.resourceId) as { title: string } | undefined;
    expect(resource).toBeTruthy();
    // The staged data is gone; no temporary file is left in the library.
    expect(fs.existsSync(path.join(ctx.app.acquisition.stagingOf(jobId), "data"))).toBe(false);
    expect(walk(dir).some((name) => name.includes(".publish"))).toBe(false);
    // Sharing is off unless asked for (Q-15).
    expect((await engineLog(ctx)).some((call) => call.method === "engine.seed")).toBe(false);
  });

  it("downloads only the files chosen", async () => {
    const ctx = await start({ acquisition: { forceCopy } });
    await installFake(ctx);
    const { dir, pathId } = await addLibrary(ctx);
    const jobId = await begin(ctx, pathId, 11);
    await choose(ctx, jobId, [1]);
    await finishTransfer(ctx, jobId, FILES, [1]);
    const job = await finish(ctx, jobId);
    expect(job.state).toBe("done");
    expect(walk(dir)).toEqual(["下载/季卷/第2话.txt"]);
    expect(job.counts).toMatchObject({ files: 3, selected: 1, published: 1, imported: 1 });
  });

  it("never replaces a file that is there: a different one makes a numbered name, the same one is adopted, and both are told apart by content", async () => {
    const ctx = await start({ acquisition: { forceCopy } });
    await installFake(ctx);
    const { dir, pathId } = await addLibrary(ctx);
    fs.mkdirSync(lib(dir, "下载/季卷"), { recursive: true });
    fs.writeFileSync(lib(dir, "下载/季卷/第1话.txt"), "someone else's file with the same name");
    fs.writeFileSync(lib(dir, "下载/季卷/第2话.txt"), FILES[1]!.text);
    const jobId = await begin(ctx, pathId, 12);
    await choose(ctx, jobId, [0, 1]);
    await finishTransfer(ctx, jobId, FILES, [0, 1]);
    const job = await finish(ctx, jobId);
    expect(job.state).toBe("done");
    expect(fs.readFileSync(lib(dir, "下载/季卷/第1话.txt"), "utf8")).toBe("someone else's file with the same name");
    expect(fs.readFileSync(lib(dir, "下载/季卷/第1话 (2).txt"), "utf8")).toBe(FILES[0]!.text);
    expect(walk(dir).sort()).toEqual(["下载/季卷/第1话 (2).txt", "下载/季卷/第1话.txt", "下载/季卷/第2话.txt"]);
    expect(job.entries!.map((entry) => entry.targetPath)).toEqual(["下载/季卷/第1话 (2).txt", "下载/季卷/第2话.txt", null]);
    // A numbered name is not the name the torrent expects, so it cannot be shared back.
    expect(job.seeding.possible).toBe(false);
  });

  it("repeats a publish that stopped between its steps, without a duplicate or a lost file (a crash at each point)", async () => {
    const points: AcquisitionFault[] = ["after-verify", "after-publish", "before-import", "after-scan"];
    for (const point of points) {
      let crashAt: AcquisitionFault | null = point;
      const first = await boot({ acquisition: { forceCopy, fault: (at) => { if (at === crashAt) { crashAt = null; throw new AcquisitionCrash(); } } } });
      rigs.push(first);
      await installFake(first);
      const { dir, pathId } = await addLibrary(first);
      const jobId = await begin(first, pathId, 20);
      await choose(first, jobId, [0, 1]);
      await finishTransfer(first, jobId, FILES, [0, 1]);
      await first.app.acquisition.whenSettled(jobId);
      // The process "died" here: the job still says it is being published or imported.
      expect(["publishing", "importing"], point).toContain((await jobOf(first, jobId)).state);
      first.app.close();
      const second = await start({ profileRoot: first.profileRoot, acquisition: { forceCopy } });
      const job = await waitState(second, jobId, ["done"], 20_000);
      expect(job.counts, point).toMatchObject({ selected: 2, published: 2, imported: 2 });
      expect(walk(dir).sort(), point).toEqual(["下载/季卷/第1话.txt", "下载/季卷/第2话.txt"]);
      expect(fs.readFileSync(lib(dir, "下载/季卷/第1话.txt"), "utf8"), point).toBe(FILES[0]!.text);
      expect(resourceCount(second), point).toBe(2);
      second.app.close();
    }
  });

  it("stops a job at the stage that failed and finishes it when that stage is retried", async () => {
    let room: number | null = null;
    let breakScan = true;
    const ctx = await start({ acquisition: { forceCopy: true, freeBytes: () => room, fault: (at) => { if (at === "after-scan" && breakScan) throw new Error("the scan could not be completed"); } } });
    await installFake(ctx);
    const { dir, pathId } = await addLibrary(ctx);
    const jobId = await begin(ctx, pathId, 30);
    await choose(ctx, jobId, [0, 1]);
    room = 10;
    await finishTransfer(ctx, jobId, FILES, [0, 1]);
    let job = await finish(ctx, jobId);
    expect(job).toMatchObject({ state: "failed", stage: "publish", error: { code: "DISK_FULL" } });
    expect(walk(dir)).toEqual([]);
    expect(fails(await run(ctx, "acquisition.retryImport", { jobId })).details?.reason).toBe("state");
    room = null;
    ok(await run(ctx, "acquisition.retryPublish", { jobId }));
    job = await finish(ctx, jobId);
    expect(job).toMatchObject({ state: "failed", stage: "import", error: { code: "SCAN_FAILED" } });
    expect(job.counts.published).toBe(2);
    breakScan = false;
    ok(await run(ctx, "acquisition.retryImport", { jobId }));
    job = await finish(ctx, jobId);
    expect(job).toMatchObject({ state: "done", counts: { published: 2, imported: 2 } });
    expect(walk(dir).sort()).toEqual(["下载/季卷/第1话.txt", "下载/季卷/第2话.txt"]);
  });

  it("reports files the library could not read, and asks again only when the person does", async () => {
    const ctx = await start({ acquisition: { forceCopy } });
    await installFake(ctx);
    const { dir, pathId } = await addLibrary(ctx);
    const files: File[] = [{ path: "坏书.epub", text: `PK${"x".repeat(100)}` }, { path: "好书.txt", text: chapter("好书") }];
    const jobId = await begin(ctx, pathId, 31, files);
    await choose(ctx, jobId, [0, 1]);
    await finishTransfer(ctx, jobId, files, [0, 1]);
    const job = await finish(ctx, jobId);
    expect(job).toMatchObject({ state: "failed", stage: "import", error: { code: "IMPORT_FAILED" } });
    expect(job.entries!.map((entry) => entry.importState)).toEqual(["failed", "imported"]);
    expect(walk(dir).sort()).toEqual(["下载/坏书.epub", "下载/好书.txt"]);
    // The good file is in the library; asking again does not add it twice.
    ok(await run(ctx, "acquisition.retryImport", { jobId }));
    const again = await finish(ctx, jobId);
    expect(again.state).toBe("failed");
    expect(resourceCount(ctx)).toBe(1);
  });
});


/** A second volume to publish onto: a folder under the repository when it is on another drive than the system's temporary folder (the profile and the staged files are under that). */
const otherVolume = (() => {
  const here = path.resolve(import.meta.dirname, "../../dist");
  try { fs.mkdirSync(here, { recursive: true }); return fs.statSync(here).dev !== fs.statSync(os.tmpdir()).dev ? here : null; } catch { return null; }
})();

describe("a process that dies in the middle of publishing", () => {
  it.each([["after-verify", false], ["after-publish", false], ["after-publish", true], ["before-import", false], ["after-scan", true]] as const)("is picked up by the next start at %s (copy: %s) and finishes without a duplicate or a lost file", async (point, copy) => {
    const profile = path.join(os.tmpdir(), `manga-crash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const library = fs.mkdtempSync(path.join(os.tmpdir(), "manga-crash-lib-"));
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../helpers/acquisition-crash-child.ts")], {
      env: { ...process.env, MANGA_CHILD_PROFILE: profile, MANGA_CHILD_LIBRARY: library, MANGA_CHILD_CRASH_AT: point, MANGA_CHILD_COPY: copy ? "1" : "0" }, stdio: ["ignore", "pipe", "inherit"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += String(chunk); });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect(code, `the child should have ended at ${point}`).toBe(137);
    const jobId = out.trim().split("\n")[0]!;
    expect(jobId).toMatch(/^acq_/);
    const ctx = await start({ profileRoot: profile, acquisition: { forceCopy: copy } });
    const job = await waitState(ctx, jobId, ["done"], 30_000);
    expect(job.counts, point).toMatchObject({ selected: 2, published: 2, imported: 2 });
    expect(walk(library).sort(), point).toEqual(["下载/季卷/第1话.txt", "下载/季卷/第2话.txt"]);
    expect(resourceCount(ctx), point).toBe(2);
    expect(walk(library).some((name) => name.includes(".publish")), point).toBe(false);
    expect(fs.existsSync(path.join(ctx.app.acquisition.stagingOf(jobId), "data")), point).toBe(false);
    ctx.app.close();
    fs.rmSync(library, { recursive: true, force: true });
  }, 90_000);
});

describe("publishing across two real volumes", () => {
  it.skipIf(!otherVolume)("copies the file to the other volume, checks the copy, and leaves no temporary file (not run on a machine with one volume)", async () => {
    const ctx = await start();
    await installFake(ctx);
    const target = fs.mkdtempSync(path.join(otherVolume!, "acq-volume-"));
    try {
      const { pathId } = await addLibrary(ctx, "novel", target);
      fs.mkdirSync(lib(target, "下载/季卷"), { recursive: true });
      fs.writeFileSync(lib(target, "下载/季卷/第1话.txt"), "someone else's file");
      const jobId = await begin(ctx, pathId, 15);
      await choose(ctx, jobId, [0, 1]);
      await finishTransfer(ctx, jobId, FILES, [0, 1]);
      const job = await finish(ctx, jobId);
      expect(job).toMatchObject({ state: "done", counts: { published: 2, imported: 2 } });
      expect(fs.statSync(ctx.app.acquisition.stagingOf(jobId)).dev).not.toBe(fs.statSync(target).dev);
      expect(walk(target).sort()).toEqual(["下载/季卷/第1话 (2).txt", "下载/季卷/第1话.txt", "下载/季卷/第2话.txt"]);
      expect(fs.readFileSync(lib(target, "下载/季卷/第2话.txt"), "utf8")).toBe(FILES[1]!.text);
      expect(walk(target).some((name) => name.includes(".publish"))).toBe(false);
    } finally { fs.rmSync(target, { recursive: true, force: true }); }
  });

  it.skipIf(!otherVolume)("does the same the other way round: staged on the other volume, library on the system's (not run on a machine with one volume)", async () => {
    const profile = fs.mkdtempSync(path.join(otherVolume!, "acq-profile-"));
    try {
      const ctx = await start({ profileRoot: profile });
      await installFake(ctx);
      const { dir, pathId } = await addLibrary(ctx);
      const jobId = await begin(ctx, pathId, 16);
      await choose(ctx, jobId, [0, 1]);
      await finishTransfer(ctx, jobId, FILES, [0, 1]);
      const job = await finish(ctx, jobId);
      expect(job).toMatchObject({ state: "done", counts: { published: 2, imported: 2 } });
      expect(fs.statSync(ctx.app.acquisition.stagingOf(jobId)).dev).not.toBe(fs.statSync(dir).dev);
      expect(walk(dir).sort()).toEqual(["下载/季卷/第1话.txt", "下载/季卷/第2话.txt"]);
      expect(walk(dir).some((name) => name.includes(".publish"))).toBe(false);
      ctx.app.close();
    } finally { fs.rmSync(profile, { recursive: true, force: true }); }
  });
});

describe("pausing, stopping and the engine going away", () => {
  it("pauses and continues a transfer, and a stop deletes what was staged but keeps what was already published", async () => {
    const ctx = await start();
    await installFake(ctx);
    const { dir, pathId } = await addLibrary(ctx);
    const done = await begin(ctx, pathId, 40);
    await choose(ctx, done, [0]);
    await finishTransfer(ctx, done, FILES, [0]);
    await finish(ctx, done);
    const jobId = await begin(ctx, pathId, 41, FILES);
    await choose(ctx, jobId, [0, 1]);
    stage(ctx, jobId, FILES[0]!.path, "half of the first file");
    expect(ok<{ job: { state: string; pausedReason: string } }>(await run(ctx, "acquisition.pause", { jobId })).job).toMatchObject({ state: "paused", pausedReason: "user" });
    expect(fails(await run(ctx, "acquisition.pause", { jobId })).details?.reason).toBe("state");
    ok(await run(ctx, "acquisition.resume", { jobId }));
    expect(await waitState(ctx, jobId, ["downloading"])).toMatchObject({ pausedReason: null });
    const adds = (await engineLog(ctx)).filter((call) => call.method === "engine.add" && call.params.jobId === jobId);
    expect(adds.at(-1)!.params.selected).toEqual([0, 1]);
    ok(await run(ctx, "acquisition.cancel", { jobId }));
    expect((await jobOf(ctx, jobId)).state).toBe("cancelled");
    expect(fs.existsSync(ctx.app.acquisition.stagingOf(jobId))).toBe(false);
    expect(walk(dir)).toEqual(["下载/季卷/第1话.txt"]);
    ok(await run(ctx, "acquisition.remove", { jobId }));
    expect(ok<{ jobs: Array<{ id: string }> }>(await run(ctx, "acquisition.list", {})).jobs.map((job) => job.id)).toEqual([done]);
  });

  it("holds the jobs when the engine is turned off and carries on by itself when it is on again", async () => {
    const ctx = await start();
    await installFake(ctx);
    const { pathId } = await addLibrary(ctx);
    const jobId = await begin(ctx, pathId, 50);
    await choose(ctx, jobId, [0]);
    ok(await run(ctx, "plugin.disable", { pluginId: FAKE_ENGINE_ID }));
    expect(await waitState(ctx, jobId, ["paused"])).toMatchObject({ pausedReason: "engine" });
    expect(ok<{ engine: { running: boolean; reason: string } }>(await run(ctx, "acquisition.list", {})).engine).toMatchObject({ running: false });
    expect(fails(await run(ctx, "acquisition.resume", { jobId })).code).toBe("PROVIDER_UNAVAILABLE");
    ok(await run(ctx, "plugin.enable", { pluginId: FAKE_ENGINE_ID }));
    expect(await waitState(ctx, jobId, ["downloading"])).toMatchObject({ pausedReason: null });
    expect((await engineLog(ctx)).filter((call) => call.method === "engine.add").at(-1)!.params).toMatchObject({ jobId, selected: [0] });
  });

  it("keeps what was imported when the engine is removed, and carries on when an engine is installed again (AT-42)", async () => {
    const ctx = await start();
    await installFake(ctx);
    const { dir, pathId } = await addLibrary(ctx);
    const done = await begin(ctx, pathId, 60);
    await choose(ctx, done, [0, 1]);
    await finishTransfer(ctx, done, FILES, [0, 1]);
    const finished = await finish(ctx, done);
    const waiting = await begin(ctx, pathId, 61);
    await choose(ctx, waiting, [0]);
    ok(await run(ctx, "plugin.uninstall", { pluginId: FAKE_ENGINE_ID, deleteData: true }));
    expect(await waitState(ctx, waiting, ["paused"])).toMatchObject({ pausedReason: "engine" });
    // What the download made stays: the files, the resources, and the job's record of them.
    expect(walk(dir).sort()).toEqual(["下载/季卷/第1话.txt", "下载/季卷/第2话.txt"]);
    for (const entry of finished.entries!.filter((item) => item.resourceId)) expect(ctx.app.store.sqlite.prepare("SELECT id FROM resources WHERE id = ?").get(entry.resourceId)).toBeTruthy();
    expect((await jobOf(ctx, done)).state).toBe("done");
    expect(ok<{ engine: { available: boolean } }>(await run(ctx, "acquisition.list", {})).engine.available).toBe(false);
    await installFake(ctx);
    expect(await waitState(ctx, waiting, ["downloading"])).toMatchObject({ pausedReason: null });
  });

  it("refuses to continue what an engine with another resume format left, and starts the job over on request", async () => {
    const ctx = await start();
    await installFake(ctx, "1.0.0");
    const { dir, pathId } = await addLibrary(ctx);
    const jobId = await begin(ctx, pathId, 70);
    await choose(ctx, jobId, [0]);
    stage(ctx, jobId, "半成品.bin", "partial");
    await installFake(ctx, "2.0.0");
    const job = await waitState(ctx, jobId, ["failed"]);
    expect(job).toMatchObject({ stage: "transfer", error: { code: "RESUME_INCOMPATIBLE" } });
    ok(await run(ctx, "acquisition.restart", { jobId }));
    expect(await waitState(ctx, jobId, ["metadata"])).toMatchObject({ error: null });
    expect(fs.existsSync(path.join(ctx.app.acquisition.stagingOf(jobId), "data", "半成品.bin"))).toBe(false);
    expect(walk(dir)).toEqual([]);
    await emit(ctx, "acq.metadata", { jobId, infoHash: HASH(70), name: "季卷", totalLength: 10, pieceLength: 16384, files: entryOf(FILES) });
    expect((await waitState(ctx, jobId, ["choosing"])).counts.selected).toBe(0);
  });

  it("puts a transfer that was running when the application ended on hold, and continues it at the next start", async () => {
    const first = await start();
    await installFake(first);
    const { pathId } = await addLibrary(first);
    const jobId = await begin(first, pathId, 80);
    await choose(first, jobId, [0, 1]);
    first.app.close();
    const second = await start({ profileRoot: first.profileRoot });
    const job = await waitState(second, jobId, ["downloading"], 20_000);
    expect(job.counts.selected).toBe(2);
    expect((await engineLog(second)).filter((call) => call.method === "engine.add").at(-1)!.params).toMatchObject({ jobId, selected: [0, 1] });
  });

  it("puts everything on hold when the feature is switched off, and continues when it is switched on", async () => {
    const ctx = await start();
    await installFake(ctx);
    const { pathId } = await addLibrary(ctx);
    const jobId = await begin(ctx, pathId, 90);
    await choose(ctx, jobId, [0]);
    ok(await run(ctx, "settings.setModule", { featureId: "acquisition", enabled: false }));
    await until(() => ctx.app.store.sqlite.prepare("SELECT state, paused_reason AS reason FROM acquisition_jobs WHERE id = ?").get(jobId) as { state: string; reason: string }, (row) => row.state === "paused", 10_000, "the job to be held");
    ok(await run(ctx, "settings.setModule", { featureId: "acquisition", enabled: true }));
    expect(await waitState(ctx, jobId, ["downloading"], 20_000)).toMatchObject({ pausedReason: null });
  });
});

describe("sharing a finished download", () => {
  it("is off when a download finishes, can be turned on for a download whose files are where the torrent expects them, and stops when told to", async () => {
    const ctx = await start();
    await installFake(ctx);
    const { dir, pathId } = await addLibrary(ctx);
    const jobId = await begin(ctx, pathId, 100);
    await choose(ctx, jobId, [0, 1]);
    // The engine keeps the torrent file of the job under the job's folder.
    fs.mkdirSync(path.join(ctx.app.acquisition.stagingOf(jobId), "engine"), { recursive: true });
    fs.writeFileSync(path.join(ctx.app.acquisition.stagingOf(jobId), "engine", "torrent.torrent"), "torrent");
    await finishTransfer(ctx, jobId, FILES, [0, 1]);
    const job = await finish(ctx, jobId);
    expect(job).toMatchObject({ state: "done", seeding: { enabled: false, possible: true } });
    const shared = ok<{ job: { seeding: { enabled: boolean; active: boolean; ratio: number } } }>(await run(ctx, "acquisition.setSeeding", { jobId, enabled: true, ratio: 1.5, upKbps: 80 }));
    expect(shared.job.seeding).toMatchObject({ enabled: true, active: true, ratio: 1.5 });
    const seedCall = (await engineLog(ctx)).find((call) => call.method === "engine.seed")!;
    expect(seedCall.params).toMatchObject({ jobId, ratio: 1.5, dir: path.join(dir, "下载") });
    expect((await engineLog(ctx)).filter((call) => call.method === "engine.limits").at(-1)!.params).toMatchObject({ upKbps: 80 });
    // The ratio is reached: the engine stops sharing and says so, and the job stays done.
    await emit(ctx, "acq.seedStopped", { jobId, reason: "ratio", uploaded: 3000, ratio: 1.6 });
    const stopped = await until(() => jobOf(ctx, jobId), (item) => !item.seeding.enabled, 10_000, "sharing to stop");
    expect(stopped).toMatchObject({ state: "done", uploadedBytes: 3000 });
    ok(await run(ctx, "acquisition.setSeeding", { jobId, enabled: true }));
    ok(await run(ctx, "acquisition.setSeeding", { jobId, enabled: false }));
    expect((await jobOf(ctx, jobId)).seeding).toMatchObject({ enabled: false, active: false });
    expect(fails(await run(ctx, "acquisition.setSeeding", { jobId: await begin(ctx, pathId, 101), enabled: true })).details?.reason).toBe("state");
  });

  it("is refused when a file was published under another name or the torrent file is gone", async () => {
    const ctx = await start();
    await installFake(ctx);
    const { dir, pathId } = await addLibrary(ctx);
    fs.mkdirSync(lib(dir, "下载/季卷"), { recursive: true });
    fs.writeFileSync(lib(dir, "下载/季卷/第1话.txt"), "taken");
    const jobId = await begin(ctx, pathId, 110);
    await choose(ctx, jobId, [0]);
    fs.mkdirSync(path.join(ctx.app.acquisition.stagingOf(jobId), "engine"), { recursive: true });
    fs.writeFileSync(path.join(ctx.app.acquisition.stagingOf(jobId), "engine", "torrent.torrent"), "torrent");
    await finishTransfer(ctx, jobId, FILES, [0]);
    await finish(ctx, jobId);
    expect(fails(await run(ctx, "acquisition.setSeeding", { jobId, enabled: true })).details?.reason).toBe("seed-impossible");
  });
});
