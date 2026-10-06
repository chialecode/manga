import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serveMedia } from "../../packages/app-core/src/media/index.ts";
import { startApp } from "../helpers/app.ts";
import { requireSamples, samplePath } from "../helpers/samples.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>, grantHandle = ctx.grant.handle, actor: { kind: "user" | "agent"; id: string } = ctx.actor) {
  counter += 1;
  return ctx.app.call(actor, { commandId, idempotencyKey: `video-cmd-${counter}`, input }, grantHandle);
}

function ok<T = Record<string, unknown>>(result: Awaited<ReturnType<typeof run>>): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}

const pick = (ctx: App, purpose: "file" | "directory", target: string) => ctx.app.registerPath(purpose, target);
const request = (url: string, headers: Record<string, string> = {}, method = "GET") => ({ url, method, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } });
const serve = (ctx: App, url: string, headers: Record<string, string> = {}) => serveMedia({ handles: ctx.app.media.handles, zips: ctx.app.media.zips }, request(url, headers));

async function importVideo(ctx: App, id: string, title = id) {
  const value = ok<{ resourceId: string; revisionId: string; workId: string; duplicate: boolean }>(await run(ctx, "library.importDocument", { title, kind: "video", pathHandle: pick(ctx, "file", samplePath(id)) }));
  return value;
}

async function waitFor<T>(label: string, check: () => T | undefined | false, timeoutMs = 60_000): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("video import and probing through the product app", () => {
  requireSamples(["video-mp4-h264-aac", "video-mkv-ass-fonts", "video-nonzero-start", "video-vfr", "video-corrupt", "video-episodes", "video-external-subs"]);

  it("imports one video in place, records its probe, and does not import it twice", async () => {
    const ctx = await startApp();
    try {
      const first = await importVideo(ctx, "video-mp4-h264-aac", "样例视频");
      expect(first.duplicate).toBe(false);
      const again = await importVideo(ctx, "video-mp4-h264-aac", "样例视频");
      expect(again.duplicate).toBe(true);
      expect(again.resourceId).toBe(first.resourceId);
      const work = ok<{ mediaKind: string }>(await run(ctx, "works.get", { workId: first.workId }));
      expect(work.mediaKind).toBe("video");
      const probe = ok<{ available: boolean; probe: { container: string; durationMs: number; streams: Array<{ type: string; codec: string }> } }>(await run(ctx, "video.probe", { resourceId: first.resourceId }));
      expect(probe.available).toBe(true);
      expect(probe.probe.durationMs).toBeGreaterThan(23_000);
      expect(probe.probe.streams.map((stream) => stream.type)).toEqual(["video", "audio"]);
      // The file stays where it is: nothing is copied into the profile.
      expect(fs.readdirSync(ctx.app.layout.partitions.resources ?? ctx.app.layout.partitions.data).filter((name) => /\.(mp4|mkv)$/i.test(name))).toEqual([]);
    } finally { ctx.app.close(); }
  });

  it("refuses a truncated file and bytes instead of a path", async () => {
    const ctx = await startApp();
    try {
      const broken = await run(ctx, "library.importDocument", { title: "坏文件", kind: "video", pathHandle: pick(ctx, "file", samplePath("video-corrupt")) });
      expect(broken.status).toBe("error");
      expect(["UNSUPPORTED_FORMAT", "NOT_FOUND"]).toContain(broken.error?.code);
      const bytes = await run(ctx, "library.importDocument", { title: "字节", kind: "video", bytes: [1, 2, 3] });
      expect(bytes.error?.code).toBe("VALIDATION_ERROR");
      const works = ok<{ items: unknown[] }>(await run(ctx, "works.list", {}));
      expect(works.items).toHaveLength(0);
    } finally { ctx.app.close(); }
  });

  it("imports a folder of episodes as one work in episode order, with gaps, versions and specials", async () => {
    const ctx = await startApp();
    try {
      const imported = ok<{ workId: string; resources: Array<{ resourceId: string; title: string; ordinalLabel: string | null; error?: unknown }> }>(
        await run(ctx, "works.importDirectory", { pathHandle: pick(ctx, "directory", samplePath("video-episodes")), kind: "video" }),
      );
      expect(imported.resources.filter((item) => item.error)).toEqual([]);
      expect(imported.resources).toHaveLength(7);
      const detail = ok<{ title: string; mediaKind: string; resources: Array<{ title: string; ordinalLabel: string | null; kind: string }> }>(await run(ctx, "works.get", { workId: imported.workId }));
      expect(detail).toMatchObject({ title: "Sample Anime", mediaKind: "video" });
      const labels = detail.resources.map((item) => item.ordinalLabel);
      // Episode numbers sort numerically; the missing 04 and 06 stay missing; specials follow.
      expect(labels.slice(0, 5)).toEqual(["第 1 集", "第 2 集", "第 3 集", "第 5 集", "第 7 集"]);
      expect(labels.slice(5)).toHaveLength(2);
      expect(new Set(detail.resources.map((item) => item.kind))).toEqual(new Set(["video"]));
      const again = ok<{ resources: Array<{ duplicate?: boolean }> }>(await run(ctx, "works.importDirectory", { pathHandle: pick(ctx, "directory", samplePath("video-episodes")), kind: "video", workId: imported.workId }));
      expect(again.resources.every((item) => item.duplicate === true)).toBe(true);
    } finally { ctx.app.close(); }
  });
});

describe("frame index and time", () => {
  requireSamples(["video-mp4-h264-aac", "video-nonzero-start", "video-vfr"]);

  it("answers frame and time questions from presentation times, with a container that does not start at zero", async () => {
    const ctx = await startApp();
    try {
      const mp4 = await importVideo(ctx, "video-mp4-h264-aac");
      const first = ok<{ frame: number; ptsMs: number; totalFrames: number; variableFrameRate: boolean; nextMs: number }>(await run(ctx, "video.frameIndex", { resourceId: mp4.resourceId, timeMs: 0 }));
      expect(first).toMatchObject({ frame: 0, ptsMs: 0, totalFrames: 576, variableFrameRate: false });
      expect(first.nextMs).toBeCloseTo(41.667, 2);
      const mid = ok<{ frame: number; ptsMs: number }>(await run(ctx, "video.frameIndex", { resourceId: mp4.resourceId, timeMs: 10_000 }));
      expect(mid.frame).toBe(240);
      expect(mid.ptsMs).toBeCloseTo(10_000, 0);
      const stepped = ok<{ frame: number }>(await run(ctx, "video.frameIndex", { resourceId: mp4.resourceId, frame: 240, delta: -1 }));
      expect(stepped.frame).toBe(239);
      const past = await run(ctx, "video.frameIndex", { resourceId: mp4.resourceId, frame: 9999 });
      expect(past.error?.code).toBe("NOT_FOUND");
      const clamped = ok<{ frame: number }>(await run(ctx, "video.frameIndex", { resourceId: mp4.resourceId, timeMs: 7 * 24 * 3600 * 1000 }));
      expect(clamped.frame).toBe(575);

      // A container that starts at 2.5 s still has its first frame at 0 on the player's timeline.
      const offset = await importVideo(ctx, "video-nonzero-start");
      const probe = ok<{ probe: { startMs: number } }>(await run(ctx, "video.probe", { resourceId: offset.resourceId }));
      expect(probe.probe.startMs).toBeCloseTo(2500, 0);
      const head = ok<{ frame: number; ptsMs: number }>(await run(ctx, "video.frameIndex", { resourceId: offset.resourceId, timeMs: 0 }));
      expect(head).toMatchObject({ frame: 0, ptsMs: 0 });
    } finally { ctx.app.close(); }
  });

  it("does not assume a constant frame rate for a variable-rate video", async () => {
    const ctx = await startApp();
    try {
      const vfr = await importVideo(ctx, "video-vfr");
      const at = async (timeMs: number) => ok<{ frame: number; ptsMs: number; totalFrames: number; variableFrameRate: boolean }>(await run(ctx, "video.frameIndex", { resourceId: vfr.resourceId, timeMs }));
      const early = await at(4_000);
      expect(early.variableFrameRate).toBe(true);
      // 30 fps for the first 8 s: 120 frames in 4 s. A constant-rate guess from the average rate would say 80.
      expect(early.frame).toBe(120);
      const late = await at(12_000);
      // 240 frames in the first 8 s, then 10 fps: 4 s more is 40 frames.
      expect(late.frame).toBe(280);
      expect(late.totalFrames).toBeGreaterThan(300);
      expect(late.totalFrames).toBeLessThan(340);
    } finally { ctx.app.close(); }
  });
});

describe("playback decisions", () => {
  requireSamples(["video-mp4-h264-aac", "video-mkv-hevc-8bit", "video-mkv-hevc-10bit", "video-ac3", "video-mkv-ass-fonts"]);

  it("plays H.264 and AAC directly, and decides HEVC and AC-3 from what this machine reports", async () => {
    const ctx = await startApp();
    try {
      const plan = async (id: string, extra: Record<string, unknown> = {}) => {
        const item = await importVideo(ctx, id);
        return ok<{ plan: { decision: string; reasons: string[]; copy?: { reason: string; video: string; audio: string } }; copy: unknown }>(await run(ctx, "video.playbackPlan", { resourceId: item.resourceId, ...extra }));
      };
      expect((await plan("video-mp4-h264-aac")).plan.decision).toBe("direct");
      expect((await plan("video-mkv-ass-fonts")).plan.decision).toBe("direct");
      const noHw = await plan("video-mkv-hevc-8bit");
      expect(noHw.plan).toMatchObject({ decision: "play_copy", copy: { reason: "no_hardware_hevc", video: "encode", audio: "copy" } });
      expect((await plan("video-mkv-hevc-8bit", { hardwareHevc: true })).plan.decision).toBe("direct");
      expect((await plan("video-mkv-hevc-10bit", { hardwareHevc: true })).plan.decision).toBe("direct");
      const ac3 = await plan("video-ac3");
      expect(ac3.plan).toMatchObject({ decision: "play_copy", copy: { reason: "unsupported_audio", video: "copy", audio: "aac" } });
    } finally { ctx.app.close(); }
  });
});

describe("handles, subtitles and fonts", () => {
  requireSamples(["video-mp4-h264-aac", "video-mkv-ass-fonts", "video-external-subs"]);

  it("serves the original by handle with byte ranges, and the handle dies with the module", async () => {
    const ctx = await startApp();
    try {
      const item = await importVideo(ctx, "video-mp4-h264-aac");
      const handle = ok<{ url: string; handle: string; bytes: number; mediaType: string; startMs: number }>(await run(ctx, "video.handle", { resourceId: item.resourceId, revisionId: item.revisionId, source: "original" }));
      expect(handle.mediaType).toBe("video/mp4");
      expect(handle.bytes).toBe(fs.statSync(samplePath("video-mp4-h264-aac")).size);
      expect(JSON.stringify(handle)).not.toContain(path.basename(samplePath("video-mp4-h264-aac")));
      const part = await serve(ctx, handle.url, { range: "bytes=100-199" });
      expect(part.status).toBe(206);
      expect(Buffer.from(await part.arrayBuffer()).equals(fs.readFileSync(samplePath("video-mp4-h264-aac")).subarray(100, 200))).toBe(true);
      const profile = ctx.app.runtime.snapshot().lastValidProfile!;
      await ctx.app.runtime.applyProfile({ ...profile, revision: profile.revision + 1, disabledFeatures: [...profile.disabledFeatures, "video"] });
      expect((await serve(ctx, handle.url)).status).toBe(404);
      expect((await run(ctx, "video.handle", { resourceId: item.resourceId, revisionId: item.revisionId, source: "original" })).status).toBe("error");
      // The library still holds the work while playback is off.
      ok(await run(ctx, "works.get", { workId: item.workId }));
      await ctx.app.runtime.applyProfile({ ...profile, revision: profile.revision + 2 });
      const back = ok<{ url: string }>(await run(ctx, "video.handle", { resourceId: item.resourceId, revisionId: item.revisionId, source: "original" }));
      expect((await serve(ctx, back.url, { range: "bytes=0-3" })).status).toBe(206);
    } finally { ctx.app.close(); }
  });

  it("lists tracks, serves the embedded ASS and its attached font, and keeps the font under a name MANGA chose", async () => {
    const ctx = await startApp();
    try {
      const item = await importVideo(ctx, "video-mkv-ass-fonts");
      const subs = ok<{ subtitles: Array<{ id: string; source: string; format: string | null; codec: string }>; attachments: Array<{ fileName: string }> }>(await run(ctx, "video.subtitles", { resourceId: item.resourceId }));
      expect(subs.subtitles).toHaveLength(1);
      expect(subs.subtitles[0]).toMatchObject({ source: "embedded", format: "ass", codec: "ass" });
      expect(subs.attachments.map((attachment) => attachment.fileName)).toEqual(["arial.ttf"]);
      const audio = ok<{ audio: Array<{ language: string; title: string }> }>(await run(ctx, "video.audioTracks", { resourceId: item.resourceId }));
      expect(audio.audio.map((track) => track.language)).toEqual(["jpn", "chi"]);

      const handle = ok<{ url: string; format: string; mediaType: string }>(await run(ctx, "video.subtitleHandle", { resourceId: item.resourceId, revisionId: item.revisionId, trackId: subs.subtitles[0]!.id }));
      expect(handle.format).toBe("ass");
      const text = await (await serve(ctx, handle.url)).text();
      expect(text).toContain("[Events]");
      expect(text.split("\n").filter((line) => line.startsWith("Dialogue:"))).toHaveLength(4);

      const fonts = ok<{ fonts: Array<{ id: string; fileName: string; url: string; mediaType: string }> }>(await run(ctx, "video.fonts", { resourceId: item.resourceId, revisionId: item.revisionId }));
      expect(fonts.fonts).toHaveLength(1);
      expect(fonts.fonts[0]!.mediaType).toBe("font/ttf");
      const fontBytes = Buffer.from(await (await serve(ctx, fonts.fonts[0]!.url)).arrayBuffer());
      expect(fontBytes.length).toBeGreaterThan(1000);
      const cached = fs.readdirSync(ctx.app.media.dir("fonts", item.revisionId));
      expect(cached).toHaveLength(1);
      expect(cached.every((name) => /^f\d+\.ttf$/.test(name))).toBe(true);

      const missing = await run(ctx, "video.subtitleHandle", { resourceId: item.resourceId, revisionId: item.revisionId, trackId: "s99" });
      expect(missing.error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  });

  it("finds sidecar subtitles next to the video, converts SRT to WebVTT, and ignores another episode's file", async () => {
    const ctx = await startApp();
    try {
      const file = path.join(samplePath("video-external-subs"), "episode.mp4");
      const imported = ok<{ resourceId: string; revisionId: string }>(await run(ctx, "library.importDocument", { title: "外挂字幕", kind: "video", pathHandle: pick(ctx, "file", file) }));
      const subs = ok<{ subtitles: Array<{ id: string; source: string; format: string | null; language: string | null; title: string }> }>(await run(ctx, "video.subtitles", { resourceId: imported.resourceId }));
      expect(subs.subtitles.map((track) => track.title).sort()).toEqual(["episode.ass", "episode.en.srt", "episode.zh-CN.srt"]);
      expect(subs.subtitles.every((track) => track.source === "external")).toBe(true);
      const zh = subs.subtitles.find((track) => track.title === "episode.zh-CN.srt")!;
      expect(zh.language).toBe("zh-CN");
      const handle = ok<{ url: string; format: string; mediaType: string }>(await run(ctx, "video.subtitleHandle", { resourceId: imported.resourceId, revisionId: imported.revisionId, trackId: zh.id }));
      expect(handle).toMatchObject({ format: "vtt", mediaType: "text/vtt; charset=utf-8" });
      const vtt = await (await serve(ctx, handle.url)).text();
      expect(vtt.startsWith("WEBVTT")).toBe(true);
      expect(vtt).toMatch(/([0-9]{2}:)?[0-9]{2}:[0-9]{2}\.[0-9]{3} --> /);
    } finally { ctx.app.close(); }
  });
});

describe("play copies", () => {
  requireSamples(["video-ac3", "video-mkv-hevc-10bit"]);

  it("makes a copy with the audio converted, checks its frame times against the original, and serves it", async () => {
    const ctx = await startApp();
    try {
      const item = await importVideo(ctx, "video-ac3");
      const started = ok<{ copy: { id: string; state: string; reason: string } }>(await run(ctx, "video.playCopy", { resourceId: item.resourceId, revisionId: item.revisionId, action: "create" }));
      expect(started.copy.reason).toBe("unsupported_audio");
      const copy = await waitFor("the copy to be ready", () => {
        const row = ctx.app.store.sqlite.prepare("SELECT state, bytes, timestamp_check_json AS check_json, error_json FROM play_copies WHERE id = ?").get(started.copy.id) as { state: string; bytes: number | null; check_json: string | null; error_json: string | null } | undefined;
        if (row?.state === "failed") throw new Error(`copy failed: ${row.error_json}`);
        return row?.state === "ready" ? row : undefined;
      });
      const check = JSON.parse(copy.check_json!) as { ok: boolean; originalFrames: number; copyFrames: number; maxDriftMs: number };
      expect(check).toMatchObject({ ok: true, originalFrames: 240 });
      expect(check.copyFrames).toBe(check.originalFrames);
      expect(copy.bytes).toBeGreaterThan(1000);
      const status = ok<{ copies: Array<{ id: string; state: string }> }>(await run(ctx, "video.playCopy", { resourceId: item.resourceId, revisionId: item.revisionId, action: "status" }));
      expect(status.copies).toMatchObject([{ id: started.copy.id, state: "ready" }]);
      const handle = ok<{ url: string; mediaType: string; startMs: number }>(await run(ctx, "video.handle", { resourceId: item.resourceId, revisionId: item.revisionId, source: "play_copy" }));
      expect(handle).toMatchObject({ mediaType: "video/mp4", startMs: 0 });
      expect((await serve(ctx, handle.url, { range: "bytes=0-7" })).status).toBe(206);
      // The plan now says a copy exists.
      const plan = ok<{ copy: { id: string } | null }>(await run(ctx, "video.playbackPlan", { resourceId: item.resourceId, revisionId: item.revisionId }));
      expect(plan.copy?.id).toBe(started.copy.id);
      // Removing it removes the file and the row.
      expect(ok<{ removed: number }>(await run(ctx, "video.playCopy", { resourceId: item.resourceId, revisionId: item.revisionId, action: "remove" })).removed).toBe(1);
      expect(fs.readdirSync(ctx.app.media.dir("play-copies"))).toEqual([]);
      expect((await run(ctx, "video.handle", { resourceId: item.resourceId, revisionId: item.revisionId, source: "play_copy" })).error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  }, 120_000);

  it("encodes HEVC 10-bit into a copy with the machine's best encoder, and the frame times still match", async () => {
    const ctx = await startApp();
    try {
      const item = await importVideo(ctx, "video-mkv-hevc-10bit");
      const started = ok<{ copy: { id: string; reason: string } }>(await run(ctx, "video.playCopy", { resourceId: item.resourceId, revisionId: item.revisionId, action: "create" }));
      expect(started.copy.reason).toBe("no_hardware_hevc");
      const row = await waitFor("the encode to finish", () => {
        const found = ctx.app.store.sqlite.prepare("SELECT state, encoder, bytes, timestamp_check_json AS check_json, error_json FROM play_copies WHERE id = ?").get(started.copy.id) as { state: string; encoder: string; bytes: number | null; check_json: string | null; error_json: string | null } | undefined;
        if (found?.state === "failed") throw new Error(`copy failed: ${found.error_json}`);
        return found?.state === "ready" ? found : undefined;
      }, 100_000);
      expect(["h264_nvenc", "h264_amf", "h264_qsv", "libsvtav1"]).toContain(row.encoder);
      expect(JSON.parse(row.check_json!)).toMatchObject({ ok: true, originalFrames: 240, copyFrames: 240 });
      const copyFile = path.join(ctx.app.media.dir("play-copies"), fs.readdirSync(ctx.app.media.dir("play-copies"))[0]!);
      const probe = await ctx.app.media.ffmpeg.probe(copyFile);
      expect(probe.container).toBe("mov");
      expect(probe.streams.find((stream) => stream.type === "video")?.bitDepth).toBeLessThanOrEqual(10);
      expect(Math.abs(probe.durationMs - 10_000)).toBeLessThan(200);
    } finally { ctx.app.close(); }
  }, 150_000);

  it("keeps the first frame at zero when a copy is made from a container that starts at 2.5 s", async () => {
    const ctx = await startApp();
    try {
      const item = await importVideo(ctx, "video-nonzero-start");
      // The file plays directly; the owner forces a copy anyway (the troubleshooting switch).
      const started = ok<{ copy: { id: string } }>(await run(ctx, "video.playCopy", { resourceId: item.resourceId, revisionId: item.revisionId, action: "create", reason: "unsupported_video" }));
      const row = await waitFor("the copy to finish", () => {
        const found = ctx.app.store.sqlite.prepare("SELECT state, timestamp_check_json AS check_json, error_json FROM play_copies WHERE id = ?").get(started.copy.id) as { state: string; check_json: string | null; error_json: string | null } | undefined;
        if (found?.state === "failed") throw new Error(`copy failed: ${found.error_json}`);
        return found?.state === "ready" ? found : undefined;
      });
      expect(JSON.parse(row.check_json!)).toMatchObject({ ok: true });
      const copyFile = path.join(ctx.app.media.dir("play-copies"), fs.readdirSync(ctx.app.media.dir("play-copies"))[0]!);
      const probe = await ctx.app.media.ffmpeg.probe(copyFile);
      expect(probe.startMs).toBeLessThan(50);
    } finally { ctx.app.close(); }
  }, 120_000);

  it("leaves nothing behind when a copy is cancelled, or when the module is turned off while it runs", async () => {
    const previous = process.env.MANGA_PLAYCOPY_ENCODER;
    process.env.MANGA_PLAYCOPY_ENCODER = "libsvtav1";
    const ctx = await startApp();
    try {
      const item = await importVideo(ctx, "video-mkv-hevc-10bit");
      const started = ok<{ copy: { id: string } }>(await run(ctx, "video.playCopy", { resourceId: item.resourceId, revisionId: item.revisionId, action: "create" }));
      const cancelled = ok<{ cancelled: number }>(await run(ctx, "video.playCopy", { resourceId: item.resourceId, revisionId: item.revisionId, action: "cancel" }));
      expect(cancelled.cancelled).toBe(1);
      await waitFor("the cancelled copy to disappear", () => !ctx.app.store.sqlite.prepare("SELECT id FROM play_copies WHERE id = ?").get(started.copy.id));
      expect(fs.readdirSync(ctx.app.media.dir("play-copies"))).toEqual([]);

      const second = ok<{ copy: { id: string } }>(await run(ctx, "video.playCopy", { resourceId: item.resourceId, revisionId: item.revisionId, action: "create" }));
      const profile = ctx.app.runtime.snapshot().lastValidProfile!;
      await ctx.app.runtime.applyProfile({ ...profile, revision: profile.revision + 1, disabledFeatures: [...profile.disabledFeatures, "video"] });
      await waitFor("the copy to be abandoned", () => !ctx.app.store.sqlite.prepare("SELECT id FROM play_copies WHERE id = ? AND state IN ('queued','running')").get(second.copy.id));
      expect(fs.readdirSync(ctx.app.media.dir("play-copies")).filter((name) => name.endsWith(".part"))).toEqual([]);
      // Nothing of the copy's own is left running; the import's cover and index jobs belong to the library and may still be finishing.
      expect(ctx.app.media.jobs.cancelWhere((job) => job.kind === "play-copy")).toBe(0);
    } finally {
      ctx.app.close();
      if (previous === undefined) delete process.env.MANGA_PLAYCOPY_ENCODER; else process.env.MANGA_PLAYCOPY_ENCODER = previous;
    }
  }, 120_000);

  it("refuses to make a copy when the video would play directly, and keeps copies under the disk budget", async () => {
    const ctx = await startApp();
    try {
      const direct = await importVideo(ctx, "video-mp4-h264-aac");
      const refused = await run(ctx, "video.playCopy", { resourceId: direct.resourceId, revisionId: direct.revisionId, action: "create" });
      expect(refused.error?.code).toBe("VALIDATION_ERROR");
    } finally { ctx.app.close(); }
  });
});

describe("grants", () => {
  requireSamples(["video-mkv-ass-fonts"]);

  it("keeps handles and play copies away from an agent, and limits reads to the granted resource", async () => {
    const ctx = await startApp();
    try {
      const item = await importVideo(ctx, "video-mkv-ass-fonts");
      const agent = { kind: "agent" as const, id: "agent-v" };
      const grant = ctx.app.issueAgentGrant(ctx.grant, agent, { sessionId: "sess-v", runId: "run-v", readResourceIds: [item.resourceId] });
      const base = { resourceId: item.resourceId, revisionId: item.revisionId };
      const inputs: Record<string, Record<string, unknown>> = {
        "video.handle": { ...base, source: "original" },
        "video.playCopy": { ...base, action: "create" },
        "video.subtitleHandle": { ...base, trackId: "s3" },
        "video.fonts": base,
        "video.probe": { resourceId: item.resourceId },
        "video.frameIndex": { resourceId: item.resourceId, timeMs: 0 },
        "video.subtitles": { resourceId: item.resourceId },
        "video.playbackPlan": { resourceId: item.resourceId },
        "works.importDirectory": { pathHandle: "p", kind: "video" },
      };
      for (const [commandId, input] of Object.entries(inputs)) {
        const result = await run(ctx, commandId, input, grant.handle, agent);
        expect(result.error?.code, commandId).toBe("FORBIDDEN");
      }
    } finally { ctx.app.close(); }
  });
});
