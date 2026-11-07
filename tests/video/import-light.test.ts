import { describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { inLibrary, requireSamples, samplePath } from "../helpers/samples.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>) {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `import-light-${counter}`, input }, ctx.grant.handle);
}

function ok<T = Record<string, unknown>>(result: Awaited<ReturnType<typeof run>>): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}

/** Every tool run the media service makes, in order, with its arguments; the real tool still runs. */
function recordTools(ctx: App) {
  const calls: Array<{ tool: string; args: string[]; background: boolean }> = [];
  const ffmpeg = ctx.app.media.ffmpeg;
  const original = ffmpeg.run.bind(ffmpeg);
  ffmpeg.run = ((tool: "ffmpeg" | "ffprobe", args: string[], options: { lowPriority?: boolean } = {}) => {
    calls.push({ tool, args, background: options.lowPriority === true });
    return original(tool, args, options as never);
  }) as typeof ffmpeg.run;
  return {
    calls,
    /** The runs that read every packet of a file: the frame table. */
    packetReads: () => calls.filter((call) => call.args.some((arg) => arg.startsWith("packet="))),
  };
}

describe.skipIf(mediaPrerequisitesAbsent)("an import only identifies a video (AT-80)", () => {
  requireSamples(["video-episodes", "video-mp4-h264-aac", "video-vfr"]);

  async function importEpisodes(ctx: App) {
    const handle = ctx.app.registerPath("directory", inLibrary(ctx.app, samplePath("video-episodes")));
    return ok<{ workId: string; resources: Array<{ resourceId: string; revisionId: string; error?: unknown }> }>(await run(ctx, "works.importDirectory", { pathHandle: handle, kind: "video" }));
  }

  it("reads no frame table while a folder of episodes is imported, and probes at low priority", async () => {
    const ctx = await startApp();
    try {
      const tools = recordTools(ctx);
      const imported = await importEpisodes(ctx);
      expect(imported.resources.filter((item) => item.error)).toEqual([]);
      expect(imported.resources.length).toBeGreaterThan(3);
      await ctx.app.media.jobs.idle();
      expect(tools.packetReads(), "no import may read every packet of a file").toEqual([]);
      const probes = tools.calls.filter((call) => call.tool === "ffprobe");
      expect(probes.length).toBeGreaterThanOrEqual(imported.resources.length);
      // What an import runs is a container probe, below normal priority, and nothing that decodes the whole file.
      expect(probes.every((call) => call.args.includes("-show_format") && call.background)).toBe(true);
      expect(ctx.app.media.jobs.list({ kind: "frame-index" })).toEqual([]);
    } finally { ctx.app.close(); }
  });

  it("takes one cover for a work, not one per episode", async () => {
    const ctx = await startApp();
    try {
      const tools = recordTools(ctx);
      const imported = await importEpisodes(ctx);
      await ctx.app.media.jobs.idle();
      const covers = tools.calls.filter((call) => call.tool === "ffmpeg" && call.args.includes("image2pipe"));
      expect(imported.resources.length).toBeGreaterThan(3);
      expect(covers).toHaveLength(1);
      expect(covers[0]!.background).toBe(true);
    } finally { ctx.app.close(); }
  });

  it("builds the frame table at the first frame-by-frame step, once, and never to show a frame number", async () => {
    const ctx = await startApp();
    try {
      const handle = ctx.app.registerPath("file", inLibrary(ctx.app, samplePath("video-mp4-h264-aac")));
      const imported = ok<{ resourceId: string; revisionId: string }>(await run(ctx, "library.importDocument", { title: "样例", kind: "video", pathHandle: handle }));
      const tools = recordTools(ctx);
      // Asking whether a frame number exists is free: it answers "not built" and reads nothing.
      const peek = ok<{ ready: boolean; state: string }>(await run(ctx, "video.frameIndex", { resourceId: imported.resourceId, timeMs: 1000, build: false }));
      expect(peek).toMatchObject({ ready: false, state: "absent" });
      expect(tools.packetReads()).toHaveLength(0);
      // The first step builds it, once, below normal priority.
      const first = ok<{ ready: boolean; frame: number }>(await run(ctx, "video.frameIndex", { resourceId: imported.resourceId, timeMs: 1000, delta: 1 }));
      expect(first.ready).toBe(true);
      const second = ok<{ ready: boolean }>(await run(ctx, "video.frameIndex", { resourceId: imported.resourceId, timeMs: 2000, delta: 1 }));
      expect(second.ready).toBe(true);
      expect(tools.packetReads()).toHaveLength(1);
      expect(tools.packetReads()[0]!.background).toBe(true);
      // Once it exists, the cheap question is answered from it.
      const again = ok<{ ready: boolean; frame: number }>(await run(ctx, "video.frameIndex", { resourceId: imported.resourceId, timeMs: 1000, build: false }));
      expect(again.ready).toBe(true);
      expect(tools.packetReads()).toHaveLength(1);
    } finally { ctx.app.close(); }
  });

  it("builds one frame table at a time and can cancel one that is waiting", async () => {
    const ctx = await startApp();
    try {
      const imported = await importEpisodes(ctx);
      const [a, b, c] = imported.resources;
      // A tool that never finishes by itself, so the order of the queue can be seen.
      let running = 0;
      let peak = 0;
      const started: string[] = [];
      const ffmpeg = ctx.app.media.ffmpeg;
      ffmpeg.packetTimeline = ((file: string, _stream: number, _start: number, options: { signal?: AbortSignal } = {}) => {
        running += 1;
        peak = Math.max(peak, running);
        started.push(file);
        return new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => { running -= 1; reject(Object.assign(new Error("cancelled"), { code: "CANCELLED" })); }, { once: true });
        });
      }) as typeof ffmpeg.packetTimeline;
      const asks = [a, b, c].map((item) => run(ctx, "video.frameIndex", { resourceId: item!.resourceId, timeMs: 0 }));
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(started).toHaveLength(1);
      expect(peak).toBe(1);
      const state = (item: typeof a) => ctx.app.videos.frameIndexState(item!.revisionId);
      expect([state(a), state(b), state(c)]).toEqual(["building", "building", "building"]);
      // Cancelling the one that waits leaves the running one alone.
      expect(ok<{ cancelled: boolean }>(await run(ctx, "video.cancelFrameIndex", { resourceId: c!.resourceId })).cancelled).toBe(true);
      expect(started).toHaveLength(1);
      expect(state(c)).toBe("absent");
      // Cancelling the running one lets the next one start.
      expect(ok<{ cancelled: boolean }>(await run(ctx, "video.cancelFrameIndex", { resourceId: a!.resourceId })).cancelled).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(started).toHaveLength(2);
      expect(peak).toBe(1);
      ok(await run(ctx, "video.cancelFrameIndex", { resourceId: b!.resourceId }));
      const answers = await Promise.all(asks);
      expect(answers.every((answer) => answer.status === "error")).toBe(true);
      expect(state(a)).toBe("absent");
      expect(ok<{ cancelled: boolean }>(await run(ctx, "video.cancelFrameIndex", { resourceId: a!.resourceId })).cancelled).toBe(false);
    } finally { ctx.app.close(); }
  });
});

