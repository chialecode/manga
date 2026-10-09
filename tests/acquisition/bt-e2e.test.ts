import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bencode from "bencode";
import { afterEach, describe, expect, it } from "vitest";
import type { AcquisitionJobView } from "../../packages/app-core/src/acquisition/service.ts";
import { addLibrary, boot, fails, installBt, jobOf, ok, run, until, waitState, type Rig } from "../helpers/acquisition-app.ts";
import { startSwarm, type Seeded, type Swarm } from "../helpers/bt-swarm.ts";
import { tmpDir } from "../helpers/plugin-fixtures.ts";

const BT_ID = "manga.acquisition-bt";
const closers: Array<() => unknown> = [];
afterEach(async () => { while (closers.length) { try { await closers.pop()!(); } catch { /* closed already */ } } });
const swarm = async (): Promise<Swarm> => { const s = await startSwarm(); closers.push(() => s.close()); return s; };
const start = async (options: Parameters<typeof boot>[0] & { reopen?: boolean } = {}) => { const rig = await boot(options); closers.push(() => rig.app.close()); if (!options.reopen) await installBt(rig); return rig; };

const chapter = (title: string) => `${title}\n\n${"这是用于 BitTorrent 下载测试的一段合成文字。".repeat(300)}\n`;
const BOOKS = [{ path: "第1话.txt", text: chapter("第一话") }, { path: "第2话.txt", text: chapter("第二话") }, { path: "第3话.txt", text: chapter("第三话") }];
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)).map((rel) => `${entry.name}/${rel}`) : [entry.name]));
const seedBooks = (s: Swarm, id: string, files = BOOKS, extra: Record<string, unknown> = {}): Promise<Seeded> => s.seed({ id, root: tmpDir(), name: "季卷", files, pieceLength: 16 * 1024, ...extra });
const addMagnet = async (ctx: Rig, pathId: string, seeded: Seeded, extra: Record<string, unknown> = {}) => ok<{ jobId: string }>(await run(ctx, "acquisition.add", { magnet: seeded.magnet, pathId, subdir: "下载", ...extra })).jobId;
const select = async (ctx: Rig, jobId: string, indexes: number[]) => ok<{ job: AcquisitionJobView }>(await run(ctx, "acquisition.select", { jobId, indexes })).job;
const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const downloaded = (job: AcquisitionJobView) => job.state === "downloading" && job.downloadedBytes > 0;

describe("downloads through the BitTorrent plugin, on a swarm that lives on the loopback address", () => {
  it("fetches the file list from a magnet link, downloads only the files chosen, and puts them into the library as resources", async () => {
    const s = await swarm();
    const ctx = await start();
    const { dir, pathId } = await addLibrary(ctx);
    const seeded = await seedBooks(s, "t1");
    const jobId = await addMagnet(ctx, pathId, seeded);
    const choosing = await waitState(ctx, jobId, ["choosing"]);
    expect(choosing).toMatchObject({ name: "季卷", infoHash: seeded.infoHash, totalBytes: seeded.totalLength });
    expect(choosing.entries!.map((entry) => entry.path)).toEqual(["季卷/第1话.txt", "季卷/第2话.txt", "季卷/第3话.txt"]);
    expect(choosing.entries!.every((entry) => !entry.selected)).toBe(true);
    await select(ctx, jobId, [0, 2]);
    const job = await waitState(ctx, jobId, ["done", "failed"], 60_000);
    expect(job, JSON.stringify(job.error)).toMatchObject({ state: "done", counts: { selected: 2, published: 2, imported: 2 } });
    expect(walk(dir).sort()).toEqual(["下载/季卷/第1话.txt", "下载/季卷/第3话.txt"]);
    for (const [at, entry] of [[0, "第1话.txt"], [2, "第3话.txt"]] as const) expect(sha(path.join(dir, "下载", "季卷", entry))).toBe(seeded.files[at]!.sha256);
    expect(fs.existsSync(path.join(ctx.app.acquisition.stagingOf(jobId), "data"))).toBe(false);
    expect((ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number }).n).toBe(2);
    // The job's engine is idle again, and the engine process is the one the plugin runtime started.
    expect(((await ctx.app.pluginRuntime.call(BT_ID, "engine.status", {}, { timeoutMs: 5000 })) as { jobs: unknown[] }).jobs).toEqual([]);
  }, 90_000);

  it("takes a torrent file the person chose, as well as a magnet link", async () => {
    const s = await swarm();
    const ctx = await start();
    const { dir, pathId } = await addLibrary(ctx);
    const seeded = await seedBooks(s, "t2", [BOOKS[0]!]);
    const job = ok<{ jobId: string }>(await run(ctx, "acquisition.add", { pathHandle: ctx.app.registerPath("file", seeded.torrentFile), pathId, subdir: "下载" }));
    await waitState(ctx, job.jobId, ["choosing"]);
    await select(ctx, job.jobId, [0]);
    expect(await waitState(ctx, job.jobId, ["done", "failed"], 60_000)).toMatchObject({ state: "done" });
    expect(walk(dir)).toEqual(["下载/季卷/第1话.txt"]);
    expect(fails(await run(ctx, "acquisition.add", { pathHandle: ctx.app.registerPath("file", seeded.torrentFile), pathId })).details?.reason).toBe("duplicate");
  }, 90_000);

  it("continues a transfer that was cut off by the application ending, from what is on disk", async () => {
    const s = await swarm();
    const first = await start();
    const { dir, pathId } = await addLibrary(first);
    const big = [{ path: "大卷.bin", bytes: 4 * 1024 * 1024 }];
    const seeded = await s.seed({ id: "t3", root: tmpDir(), name: "大卷.bin", files: big, pieceLength: 64 * 1024 });
    await s.throttle(600);
    const jobId = await addMagnet(first, pathId, seeded);
    await waitState(first, jobId, ["choosing"]);
    await select(first, jobId, [0]);
    const partial = await until(() => jobOf(first, jobId), (job) => job.downloadedBytes > 200_000, 40_000, "some of the file to arrive");
    expect(partial.state).toBe("downloading");
    first.app.close();
    await s.throttle(0);
    const second = await start({ profileRoot: first.profileRoot, reopen: true });
    const job = await waitState(second, jobId, ["done", "failed"], 60_000);
    expect(job, JSON.stringify(job.error)).toMatchObject({ state: "done" });
    expect(sha(path.join(dir, "下载", "大卷.bin"))).toBe(seeded.files[0]!.sha256);
  }, 120_000);

  it("holds a transfer while the plugin is off or gone, and carries on when it is back; what was imported stays (AT-42)", async () => {
    const s = await swarm();
    const ctx = await start();
    const { dir, pathId } = await addLibrary(ctx);
    const small = await seedBooks(s, "t4a", [BOOKS[0]!]);
    const one = await addMagnet(ctx, pathId, small);
    await waitState(ctx, one, ["choosing"]);
    await select(ctx, one, [0]);
    await waitState(ctx, one, ["done"], 60_000);
    const big = await s.seed({ id: "t4b", root: tmpDir(), name: "大卷.bin", files: [{ path: "大卷.bin", bytes: 3 * 1024 * 1024 }], pieceLength: 64 * 1024 });
    await s.throttle(500);
    const two = await addMagnet(ctx, pathId, big);
    await waitState(ctx, two, ["choosing"]);
    await select(ctx, two, [0]);
    await until(() => jobOf(ctx, two), downloaded, 40_000, "the transfer to start");
    // Turned off: the job waits and says why.
    ok(await run(ctx, "plugin.disable", { pluginId: BT_ID }));
    expect(await waitState(ctx, two, ["paused"])).toMatchObject({ pausedReason: "engine" });
    await s.throttle(0);
    ok(await run(ctx, "plugin.enable", { pluginId: BT_ID }));
    expect(await waitState(ctx, two, ["done", "failed"], 60_000)).toMatchObject({ state: "done" });
    // Removed altogether: what was published and imported is untouched.
    ok(await run(ctx, "plugin.uninstall", { pluginId: BT_ID, deleteData: true }));
    expect(walk(dir).sort()).toEqual(["下载/大卷.bin", "下载/季卷/第1话.txt"]);
    expect((await jobOf(ctx, one)).entries![0]!.resourceId).toBeTruthy();
    expect(ctx.app.store.sqlite.prepare("SELECT id FROM resources WHERE id = ?").get((await jobOf(ctx, one)).entries![0]!.resourceId)).toBeTruthy();
    expect(ok<{ engine: { available: boolean } }>(await run(ctx, "acquisition.list", {})).engine.available).toBe(false);
  }, 150_000);

  it("fails a job whose source serves a piece that does not match the torrent's hash, and publishes nothing", async () => {
    const s = await swarm();
    const ctx = await start();
    const { dir, pathId } = await addLibrary(ctx);
    const seeded = await s.seed({ id: "t5", root: tmpDir(), name: "坏卷.bin", files: [{ path: "坏卷.bin", bytes: 256 * 1024 }], pieceLength: 32 * 1024, corrupt: { file: "坏卷.bin", offset: 100 * 1024 } });
    const jobId = await addMagnet(ctx, pathId, seeded);
    await waitState(ctx, jobId, ["choosing"]);
    await select(ctx, jobId, [0]);
    const job = await waitState(ctx, jobId, ["failed"], 60_000);
    expect(job).toMatchObject({ stage: "transfer", error: { code: "PIECE_VERIFY" } });
    expect(walk(dir)).toEqual([]);
    expect(job.entries![0]).toMatchObject({ publishState: "none", verified: false });
  }, 90_000);

  it("shares a finished download back to the swarm, and stops when the ratio is reached", async () => {
    const s = await swarm();
    const ctx = await start();
    const { dir, pathId } = await addLibrary(ctx);
    const seeded = await seedBooks(s, "t6");
    const jobId = await addMagnet(ctx, pathId, seeded);
    await waitState(ctx, jobId, ["choosing"]);
    await select(ctx, jobId, [0, 1, 2]);
    const done = await waitState(ctx, jobId, ["done", "failed"], 60_000);
    expect(done).toMatchObject({ state: "done", seeding: { enabled: false, possible: true } });
    // Nothing is uploaded unless the person turns sharing on (Q-15); the original seed goes away, so only this application can serve the files.
    await s.stopSeed("t6");
    ok(await run(ctx, "acquisition.setSeeding", { jobId, enabled: true, ratio: 1, upKbps: 0 }));
    expect((await jobOf(ctx, jobId)).seeding).toMatchObject({ enabled: true, active: true });
    const leech = tmpDir();
    const got = await s.leech(seeded.magnet, leech);
    expect(got.downloaded).toBe(seeded.totalLength);
    for (const [at, name] of ["第1话.txt", "第2话.txt", "第3话.txt"].entries()) expect(sha(path.join(leech, "季卷", name))).toBe(seeded.files[at]!.sha256);
    const stopped = await until(() => jobOf(ctx, jobId), (job) => !job.seeding.enabled, 30_000, "sharing to stop at the ratio");
    expect(stopped).toMatchObject({ state: "done" });
    expect(stopped.uploadedBytes).toBeGreaterThanOrEqual(seeded.totalLength);
    expect(walk(dir).sort()).toEqual(["下载/季卷/第1话.txt", "下载/季卷/第2话.txt", "下载/季卷/第3话.txt"]);
  }, 120_000);

  it("cannot be made to write outside its folder by a torrent that names a file there", async () => {
    const ctx = await start();
    const { dir, pathId } = await addLibrary(ctx);
    const outside = path.join(path.dirname(ctx.app.acquisition.stagingOf("x")), "evil.txt");
    const info = { name: "x", "piece length": 16384, pieces: crypto.createHash("sha1").update("abc").digest(), files: [{ length: 3, path: ["..", "..", "evil.txt"] }] };
    const file = path.join(tmpDir(), "evil.torrent");
    fs.writeFileSync(file, bencode.encode({ info }));
    const added = await run(ctx, "acquisition.add", { pathHandle: ctx.app.registerPath("file", file), pathId });
    if (added.status === "ok") {
      // Either the engine or the host turns the name away, or it is made harmless: what the person is shown never leaves the folder.
      const job = await waitState(ctx, (added.value as { jobId: string }).jobId, ["choosing", "failed"], 20_000);
      if (job.state === "failed") expect(job.error?.code).toMatch(/PATH_ESCAPE|INVALID_SOURCE/);
      else for (const entry of job.entries!) expect(entry.path.split("/")).not.toContain("..");
      ok(await run(ctx, "acquisition.cancel", { jobId: job.id }));
    } else expect(fails(added).details?.reason).toBe("source");
    expect(fs.existsSync(outside)).toBe(false);
    expect(walk(dir)).toEqual([]);
  }, 60_000);
});
