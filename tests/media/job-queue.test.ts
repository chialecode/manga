import { describe, expect, it } from "vitest";
import { MangaError } from "@manga/contracts";
import { JobQueue, type JobSnapshot } from "../../packages/app-core/src/media/index.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("JobQueue", () => {
  it("runs at most the lane limit at once and keeps each lane independent", async () => {
    const queue = new JobQueue({ ffmpeg: 1, thumbs: 3, default: 2 });
    let active = 0;
    const peaks: Record<string, number> = {};
    const track = (lane: string) => async () => {
      active += 1;
      peaks[lane] = Math.max(peaks[lane] ?? 0, active);
      await sleep(15);
      active -= 1;
    };
    const ffmpegJobs = Array.from({ length: 4 }, () => queue.submit({ lane: "ffmpeg", kind: "transcode", run: track("ffmpeg") }));
    await Promise.all(ffmpegJobs.map((job) => job.promise));
    expect(peaks.ffmpeg).toBe(1);
    active = 0;
    const thumbs = Array.from({ length: 9 }, () => queue.submit({ lane: "thumbs", kind: "thumb", run: track("thumbs") }));
    await Promise.all(thumbs.map((job) => job.promise));
    expect(peaks.thumbs).toBeLessThanOrEqual(3);
    expect(peaks.thumbs).toBeGreaterThan(1);
  });

  it("does not let a slow lane block a fast one", async () => {
    const queue = new JobQueue({ slow: 1, fast: 1 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = queue.submit({ lane: "slow", kind: "x", run: async () => { await gate; return "slow"; } });
    const fast = queue.submit({ lane: "fast", kind: "y", run: async () => "fast" });
    expect(await fast.promise).toBe("fast");
    expect(queue.get(slow.id)?.state).toBe("running");
    release();
    expect(await slow.promise).toBe("slow");
  });

  it("joins a second submit with the same key while the first is active, and starts a new job afterwards", async () => {
    const queue = new JobQueue({ default: 1 });
    let runs = 0;
    const run = async () => { runs += 1; await sleep(20); return runs; };
    const first = queue.submit({ lane: "default", kind: "k", key: "same", run });
    const second = queue.submit({ lane: "default", kind: "k", key: "same", run });
    expect(second.id).toBe(first.id);
    expect(await first.promise).toBe(1);
    expect(await second.promise).toBe(1);
    const third = queue.submit({ lane: "default", kind: "k", key: "same", run });
    expect(third.id).not.toBe(first.id);
    expect(await third.promise).toBe(2);
  });

  it("cancels a running job through its signal and a queued job before it starts", async () => {
    const queue = new JobQueue({ default: 1 });
    let startedSecond = false;
    const first = queue.submit({
      lane: "default", kind: "long", owner: "res-1",
      run: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new MangaError("CANCELLED", "stopped")))),
    });
    const second = queue.submit({ lane: "default", kind: "queued", owner: "res-1", run: async () => { startedSecond = true; } });
    await sleep(10);
    expect(queue.get(first.id)?.state).toBe("running");
    expect(queue.get(second.id)?.state).toBe("queued");
    expect(queue.cancelWhere((job) => job.owner === "res-1")).toBe(2);
    await expect(first.promise).rejects.toMatchObject({ code: "CANCELLED" });
    await expect(second.promise).rejects.toMatchObject({ code: "CANCELLED" });
    expect(startedSecond).toBe(false);
    expect(queue.get(first.id)?.state).toBe("cancelled");
    expect(queue.get(second.id)?.state).toBe("cancelled");
    expect(queue.cancel(first.id)).toBe(false);
  });

  it("records failure with the error code and does not leave an unhandled rejection", async () => {
    const queue = new JobQueue({ default: 1 });
    const job = queue.submit({ lane: "default", kind: "boom", run: async () => { throw new MangaError("UNSUPPORTED_FORMAT", "bad file"); } });
    await sleep(20);
    expect(queue.get(job.id)).toMatchObject({ state: "failed", error: { code: "UNSUPPORTED_FORMAT", message: "bad file" } });
    await expect(job.promise).rejects.toThrow("bad file");
    const plain = queue.submit({ lane: "default", kind: "boom", run: async () => { throw new Error("oops"); } });
    await expect(plain.promise).rejects.toThrow("oops");
    expect(queue.get(plain.id)?.error?.code).toBe("INTERNAL");
  });

  it("publishes throttled progress and a final snapshot to subscribers, and survives a throwing subscriber", async () => {
    let now = 0;
    const queue = new JobQueue({ default: 1 }, 200, () => now);
    const seen: JobSnapshot[] = [];
    queue.onChange(() => { throw new Error("subscriber bug"); });
    const off = queue.onChange((job) => seen.push(job));
    const job = queue.submit({
      lane: "default", kind: "transcode",
      run: async ({ progress }) => { for (let i = 1; i <= 10; i += 1) { now += 10; progress(i / 10); } },
    });
    await job.promise;
    off();
    const states = seen.map((item) => item.state);
    expect(states[0]).toBe("running");
    expect(states.at(-1)).toBe("done");
    expect(seen.at(-1)?.progress).toBe(1);
    // 10 reports 10 ms apart collapse to about one per 100 ms, plus the final one.
    expect(seen.filter((item) => item.state === "running").length).toBeLessThan(6);
  });

  it("lets the event loop turn between jobs that never wait, so thousands of quick background jobs do not hold the main process", async () => {
    const queue = new JobQueue({ thumbs: 3 });
    let finished = 0;
    for (let i = 0; i < 400; i += 1) queue.submit({ lane: "thumbs", kind: "import-extras", run: async () => { finished += 1; } });
    // A timer set now fires between the jobs, not after the last one; with every job finishing inside one turn it could not.
    const doneWhenTimerFired = await new Promise<number>((resolve) => { setTimeout(() => resolve(finished), 0); });
    expect(doneWhenTimerFired).toBeLessThan(400);
    await queue.idle();
    expect(finished).toBe(400);
  });

  it("still starts a job that was cancelled before its turn, so it sees the aborted signal and cleans up what it owns", async () => {
    const queue = new JobQueue({ default: 1 });
    let sawAborted: boolean | null = null;
    let cleaned = false;
    const job = queue.submit({
      lane: "default", kind: "k",
      run: async ({ signal }) => {
        sawAborted = signal.aborted;
        // A job that created something before it was submitted removes it when it is told to stop.
        if (signal.aborted) { cleaned = true; throw new MangaError("CANCELLED", "stopped"); }
      },
    });
    job.cancel();
    await job.promise.catch(() => undefined);
    expect(sawAborted).toBe(true);
    expect(cleaned).toBe(true);
    expect(queue.get(job.id)?.state).toBe("cancelled");
  });

  it("idle() waits for active work and the table stays bounded", async () => {
    const queue = new JobQueue({ default: 2 }, 5);
    for (let i = 0; i < 20; i += 1) queue.submit({ lane: "default", kind: "k", run: async () => { await sleep(2); } });
    await queue.idle();
    expect(queue.list({ active: true })).toEqual([]);
    expect(queue.list().length).toBeLessThanOrEqual(5);
    expect(queue.laneStats().default).toMatchObject({ running: 0, queued: 0, limit: 2 });
  });
});
