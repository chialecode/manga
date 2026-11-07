import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startEngine, type Engine } from "../helpers/bt-engine.ts";
import { startSwarm, type Swarm } from "../helpers/bt-swarm.ts";
import { tmpDir } from "../helpers/plugin-fixtures.ts";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!().catch(() => undefined); });
const swarm = async (): Promise<Swarm> => { const s = await startSwarm(); closers.push(() => s.close()); return s; };
const engine = async (): Promise<Engine> => { const e = await startEngine(); closers.push(() => e.close()); return e; };
const sha = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const KIB = 1024;

function jobDirs() {
  const stateDir = tmpDir();
  return { stateDir, dir: path.join(stateDir, "data") };
}

describe("the BitTorrent engine on a loopback swarm", () => {
  it("fetches a magnet link's file list first, downloads only the files chosen, and checks them against the torrent's hashes", async () => {
    const s = await swarm();
    const e = await engine();
    const seeded = await s.seed({ id: "t1", root: tmpDir(), name: "季卷", files: [{ path: "第1话.bin", bytes: 700 * KIB }, { path: "第2话.bin", bytes: 500 * KIB }, { path: "说明.txt", bytes: 3 * KIB }], pieceLength: 64 * KIB });
    const { stateDir, dir } = jobDirs();
    const added = await e.call("engine.add", { jobId: "j1", magnet: seeded.magnet, dir, stateDir });
    expect(added.infoHash).toBe(seeded.infoHash);
    const meta = await e.wait("j1", "acq.metadata");
    expect(meta.name).toBe("季卷");
    expect(meta.files.map((file: { path: string }) => file.path)).toEqual(["季卷/第1话.bin", "季卷/第2话.bin", "季卷/说明.txt"]);
    // Nothing is downloaded until files are chosen.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(e.of("j1").some((event) => event.name === "acq.fileDone")).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "engine", "torrent.torrent"))).toBe(true);
    await e.call("engine.select", { jobId: "j1", indexes: [1] });
    const verified = await e.wait("j1", "acq.verified");
    expect(verified.files).toEqual([{ index: 1, path: "季卷/第2话.bin", length: 500 * KIB }]);
    expect(sha(path.join(dir, "季卷", "第2话.bin"))).toBe(seeded.files[1]!.sha256);
    expect(e.of("j1").map((event) => event.name)).toContain("acq.verifying");
    // The engine let go of the files before it said so: they can be moved at once.
    fs.renameSync(path.join(dir, "季卷", "第2话.bin"), path.join(stateDir, "moved.bin"));
    expect(sha(path.join(stateDir, "moved.bin"))).toBe(seeded.files[1]!.sha256);
    expect((await e.call("engine.status")).jobs).toEqual([]);
  });

  it("downloads a single-file torrent from a torrent file, with the selection given up front", async () => {
    const s = await swarm();
    const e = await engine();
    const seeded = await s.seed({ id: "t2", root: tmpDir(), name: "movie.bin", files: [{ path: "movie.bin", bytes: 300 * KIB }], pieceLength: 32 * KIB });
    const { stateDir, dir } = jobDirs();
    await e.call("engine.add", { jobId: "j2", torrentPath: seeded.torrentFile, dir, stateDir, selected: [0] });
    const verified = await e.wait("j2", "acq.verified");
    expect(verified.files).toEqual([{ index: 0, path: "movie.bin", length: 300 * KIB }]);
    expect(sha(path.join(dir, "movie.bin"))).toBe(seeded.files[0]!.sha256);
  });

  it("fails a job whose only seed serves a piece that does not match its hash, and leaves nothing running", async () => {
    const s = await swarm();
    const e = await engine();
    const seeded = await s.seed({ id: "t3", root: tmpDir(), name: "bad.bin", files: [{ path: "bad.bin", bytes: 256 * KIB }], pieceLength: 32 * KIB, corrupt: { file: "bad.bin", offset: 100 * KIB } });
    const { stateDir, dir } = jobDirs();
    await e.call("engine.add", { jobId: "j3", torrentPath: seeded.torrentFile, dir, stateDir, selected: [0] });
    const failure = await e.wait("j3", "acq.error", 30_000);
    expect(failure.code).toBe("PIECE_VERIFY");
    expect(e.of("j3").some((event) => event.name === "acq.pieceFailed")).toBe(true);
    expect(e.of("j3").some((event) => event.name === "acq.verified")).toBe(false);
    expect((await e.call("engine.status")).jobs).toEqual([]);
  });

  it("continues from the data on disk when a job is stopped and added again", async () => {
    const s = await swarm();
    const e = await engine();
    const seeded = await s.seed({ id: "t5", root: tmpDir(), name: "big.bin", files: [{ path: "big.bin", bytes: 3 * 1024 * KIB }], pieceLength: 64 * KIB });
    const { stateDir, dir } = jobDirs();
    await s.throttle(300);
    await e.call("engine.add", { jobId: "j5", torrentPath: seeded.torrentFile, dir, stateDir, selected: [0] });
    await e.wait("j5", "acq.metadata");
    for (let i = 0; i < 200; i += 1) {
      const p = e.of("j5").filter((event) => event.name === "acq.progress").at(-1)?.payload;
      if (p && p.downloaded > 300 * KIB) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await e.call("engine.remove", { jobId: "j5" });
    const partial = fs.existsSync(path.join(dir, "big.bin")) ? fs.statSync(path.join(dir, "big.bin")).size : 0;
    expect(partial).toBeGreaterThan(0);
    await s.throttle(0);
    await e.call("engine.add", { jobId: "j5", torrentPath: path.join(stateDir, "engine", "torrent.torrent"), dir, stateDir, selected: [0] });
    const verified = await e.wait("j5", "acq.verified", 30_000);
    expect(verified.files).toHaveLength(1);
    expect(sha(path.join(dir, "big.bin"))).toBe(seeded.files[0]!.sha256);
  });

  it("refuses sources that are not torrents, the same torrent twice, a job twice, and folders that are not absolute", async () => {
    const s = await swarm();
    const e = await engine();
    const { stateDir, dir } = jobDirs();
    await expect(e.call("engine.add", { jobId: "x1", magnet: "not a magnet", dir, stateDir })).rejects.toMatchObject({ message: expect.stringContaining("magnet") });
    const junk = path.join(tmpDir(), "junk.torrent");
    fs.writeFileSync(junk, "junk");
    await expect(e.call("engine.add", { jobId: "x2", torrentPath: junk, dir, stateDir })).rejects.toMatchObject({ message: expect.stringContaining("torrent file") });
    const seeded = await s.seed({ id: "t6", root: tmpDir(), name: "one.bin", files: [{ path: "one.bin", bytes: 40 * KIB }], pieceLength: 16 * KIB });
    await e.call("engine.add", { jobId: "x3", magnet: seeded.magnet, dir, stateDir });
    await expect(e.call("engine.add", { jobId: "x3", magnet: seeded.magnet, dir, stateDir })).rejects.toMatchObject({ message: expect.stringContaining("already") });
    await expect(e.call("engine.add", { jobId: "x4", magnet: seeded.magnet, dir: tmpDir(), stateDir: tmpDir() })).rejects.toMatchObject({ message: expect.stringContaining("already") });
    await expect(e.call("engine.add", { jobId: "x5", magnet: seeded.magnet, dir: "relative", stateDir })).rejects.toMatchObject({ message: expect.stringContaining("absolute") });
    await expect(e.call("engine.select", { jobId: "nobody", indexes: [0] })).rejects.toMatchObject({ message: expect.stringContaining("no such job") });
  });

  it("drops web seeds and trackers that need WebRTC from what it is given", async () => {
    const e = await engine();
    const { stateDir, dir } = jobDirs();
    const hash = "a".repeat(40);
    const magnet = `magnet:?xt=urn:btih:${hash}&tr=wss%3A%2F%2Ftracker.example.invalid%2Fannounce&ws=http%3A%2F%2F10.0.0.1%2Fseed&xs=http%3A%2F%2F10.0.0.2%2Fx.torrent`;
    await e.call("engine.add", { jobId: "w1", magnet, dir, stateDir });
    expect((await e.call("engine.status")).jobs).toMatchObject([{ jobId: "w1", infoHash: hash, state: "metadata" }]);
    await e.call("engine.remove", { jobId: "w1" });
  });

  it("releases its sockets and files when it is stopped", async () => {
    const s = await swarm();
    const e = await engine();
    const seeded = await s.seed({ id: "t7", root: tmpDir(), name: "stop.bin", files: [{ path: "stop.bin", bytes: 2 * 1024 * KIB }], pieceLength: 64 * KIB });
    const { stateDir } = jobDirs();
    await s.throttle(100);
    await e.call("engine.add", { jobId: "j7", torrentPath: seeded.torrentFile, dir: path.join(stateDir, "data"), stateDir, selected: [0] });
    await e.wait("j7", "acq.metadata");
    const pid = e.runtime.info("manga.acquisition-bt").pid!;
    await e.runtime.stop("manga.acquisition-bt");
    expect(() => process.kill(pid, 0)).toThrow();
    // What was written can be removed: nothing holds it open.
    fs.rmSync(stateDir, { recursive: true, force: true });
    expect(fs.existsSync(stateDir)).toBe(false);
  });
});
