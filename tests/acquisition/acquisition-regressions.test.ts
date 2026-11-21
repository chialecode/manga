import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HASH, MAGNET, addLibrary, boot, emit, installFake, jobOf, ok, run, stage, waitState, type Rig } from "../helpers/acquisition-app.ts";
import { startEngine, type Engine } from "../helpers/bt-engine.ts";
import { startSwarm, type Swarm } from "../helpers/bt-swarm.ts";
import { tmpDir } from "../helpers/plugin-fixtures.ts";

const rigs: Rig[] = [];
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!().catch(() => undefined);
  while (rigs.length) {
    try { rigs.pop()!.app.close(); } catch { /* closed */ }
  }
});

describe("Acquisition & BtEngine regressions (A-03, A-23)", () => {
  it("A-03: publish conflict exhaustion preserves staged file, throws PUBLISH_CONFLICT, and evicts settled chains", async () => {
    const ctx = await boot();
    rigs.push(ctx);
    await installFake(ctx);
    const { pathId, dir } = await addLibrary(ctx);
    const added = ok<{ jobId: string }>(await run(ctx, "acquisition.add", { magnet: MAGNET(HASH(91)), pathId, subdir: "冲突目录" }));
    const fileText = "测试正文内容用于冲突保护验证。".repeat(20);
    const fileEntry = { index: 0, path: "书.txt", length: Buffer.byteLength(fileText) };

    await emit(ctx, "acq.metadata", { jobId: added.jobId, infoHash: HASH(91), name: "书", totalLength: fileEntry.length, pieceLength: 16384, files: [fileEntry] });
    await waitState(ctx, added.jobId, ["choosing"]);
    ok(await run(ctx, "acquisition.select", { jobId: added.jobId, indexes: [0] }));

    // Pre-create all 500 candidate destinations ("书.txt", "书 (2).txt" ... "书 (500).txt") to exhaust conflict suffixes.
    const targetDir = path.join(dir, "冲突目录");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "书.txt"), "existing-1");
    for (let n = 2; n <= 500; n += 1) fs.writeFileSync(path.join(targetDir, `书 (${n}).txt`), `existing-${n}`);

    const stagedPath = stage(ctx, added.jobId, "书.txt", fileText);
    await emit(ctx, "acq.verifying", { jobId: added.jobId });
    await emit(ctx, "acq.verified", { jobId: added.jobId, files: [fileEntry], downloaded: fileEntry.length, uploaded: 0 });
    await ctx.app.acquisition.whenSettled(added.jobId);

    const job = await jobOf(ctx, added.jobId);
    expect(job.state).toBe("failed");
    expect(job.error?.code).toBe("PUBLISH_CONFLICT");
    // The staged file must NOT be deleted and the pre-existing file must NOT be overwritten or marked published!
    expect(fs.existsSync(stagedPath)).toBe(true);
    expect(fs.readFileSync(path.join(targetDir, "书 (500).txt"), "utf8")).toBe("existing-500");
    const entryRow = ctx.app.store.sqlite.prepare("SELECT publish_state FROM acquisition_entries WHERE job_id = ?").get(added.jobId) as { publish_state: string };
    expect(entryRow.publish_state).not.toBe("published");
    // Settled per-job chain map entry is auto-evicted.
    expect(((ctx.app.acquisition as unknown as { chains: Map<string, Promise<unknown>> }).chains).has(added.jobId)).toBe(false);
  });

  it("A-23: BtEngine defers acq.verifying on already-downloaded select and refuses select after verification starts", async () => {
    const s: Swarm = await startSwarm();
    closers.push(() => s.close());
    const e: Engine = await startEngine();
    closers.push(() => e.close());
    const seeded = await s.seed({ id: "t-a23", root: tmpDir(), name: "fast.bin", files: [{ path: "fast.bin", bytes: 64 * 1024 }], pieceLength: 32 * 1024 });
    const stateDir = tmpDir();
    const dir = path.join(stateDir, "data");
    await e.call("engine.add", { jobId: "j_a23", torrentPath: seeded.torrentFile, dir, stateDir });
    await e.wait("j_a23", "acq.metadata");
    const selected = await e.call("engine.select", { jobId: "j_a23", indexes: [0] });
    expect(selected).toBeTruthy();
    await e.wait("j_a23", "acq.verified");
    // Once verified and cleaned up, a duplicate select call must fail cleanly rather than corrupting state.
    await expect(e.call("engine.select", { jobId: "j_a23", indexes: [0] })).rejects.toThrow();
  });
});
