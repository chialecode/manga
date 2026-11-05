import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { startMockProvider } from "@manga/model-protocol";
import { resolveLocation } from "../../packages/app-core/src/library-locations.ts";
import { clipRange, decideClip, decidePdfs } from "../../packages/app-core/src/agent-native-input.ts";
import { DEFAULT_MODEL_PROFILE } from "@manga/contracts/models";
import { startApp, waitForRun } from "../helpers/app.ts";
import { inLibrary, requireSamples, samplePath } from "../helpers/samples.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";

// AT-145 / AT-146 / 计划 4.5: a whole PDF and a clip of the video go to a model only when its profile takes them, the protocol and runtime carry them,
// the material is whole and inside the spoiler range, and the size and length fit. Otherwise text and frames go as before and the call record says why.

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
type Seen = { url: string; body: Record<string, any> };
type Note = { kind: string; reason?: string; bytes?: number; pages?: number; seconds?: number };
let counter = 0;
const apps: App[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (apps.length) apps.pop()!.app.close();
  while (closers.length) await closers.pop()!();
});

const run = (ctx: App, commandId: string, input: Record<string, unknown>) => ctx.app.call(ctx.actor, { commandId, idempotencyKey: `native-${counter += 1}`, input }, ctx.grant.handle);
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
const DAY = 86_400_000;
const asked = (seen: Seen[]) => seen.filter((request) => !JSON.stringify(request.body).includes("Reply with one word"));
const pdfParts = (request: Seen) => JSON.stringify(request.body).match(/"input_file"|"type":"file"/g)?.length ?? 0;
const videoBase64 = (request: Seen) => /data:video\/mp4;base64,([A-Za-z0-9+/=]+)/.exec(JSON.stringify(request.body))?.[1];

/** What a clip holds: the time from its first shown frame to the start of its last (no frame begins after the asked end; the frame at the end is the one on screen there), its codec and container. */
function ffprobe(ctx: App, bytes: Buffer): { frameSpan: number; codec: string; format: string } {
  const file = `${process.env.TEMP ?? "."}/manga-clip-probe-${process.pid}-${counter += 1}.mp4`;
  fs.writeFileSync(file, bytes);
  try {
    const tool = ctx.app.media.ffmpeg.tools!.ffprobe;
    const probe = spawnSync(tool, ["-v", "error", "-show_entries", "format=format_name:stream=codec_name,codec_type", "-of", "json", file], { encoding: "utf8", windowsHide: true });
    const parsed = JSON.parse(probe.stdout) as { format: { format_name: string }; streams: Array<{ codec_name: string; codec_type: string }> };
    const frames = spawnSync(tool, ["-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time", "-of", "csv=p=0", file], { encoding: "utf8", windowsHide: true }).stdout
      .trim().split(/\r?\n/).map((line) => line.split(",").map(Number) as [number, number]);
    const first = Math.min(...frames.map(([pts]) => pts));
    const end = Math.max(...frames.map(([pts]) => pts));
    return { frameSpan: end - first, codec: parsed.streams.find((stream) => stream.codec_type === "video")!.codec_name, format: parsed.format.format_name };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

async function rig(options: { protocol?: "openai-responses" | "openai-chat-completions"; inputTypes?: string[]; limits?: Record<string, number>; runtime?: "native" | "pi"; contextWindow?: number; maxOutput?: number } = {}) {
  const ctx = await startApp();
  apps.push(ctx);
  const seen: Seen[] = [];
  const server = await startMockProvider({ onRequest: (request) => { seen.push(request as Seen); } });
  closers.push(server.close);
  const created = ok<{ id: string }>(await run(ctx, "connections.upsert", { label: "whole", protocol: options.protocol ?? "openai-chat-completions", baseUrl: server.url, modelId: "m", purpose: "text", credentialHandle: ctx.app.stashSecret("k") }));
  ok(await run(ctx, "connections.test", { connectionId: created.id, capability: "text" }));
  ok(await run(ctx, "connections.setProfile", { connectionId: created.id, profile: { inputTypes: options.inputTypes ?? ["text", "pdf", "video"], ...(options.limits ? { limits: options.limits } : {}), ...(options.contextWindow ? { contextWindow: options.contextWindow } : {}), ...(options.maxOutput ? { maxOutput: options.maxOutput } : {}) } }));
  ok(await run(ctx, "settings.setRuntime", { runtime: options.runtime ?? "native" }));
  ok(await run(ctx, "settings.setShell", { spoilerGuard: false }));
  const sessionId = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "t" })).id;
  const ask = async (input: Record<string, unknown>) => {
    const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId, text: "这里讲了什么？", ...input }));
    const done = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
    return { runId: sent.runId, status: String(done.value?.status ?? done.value?.run?.status) };
  };
  const delivered = async (runId: string): Promise<Note[]> => {
    const entries = ok<{ entries: Array<{ kind: string; delivery: Note[] | null }> }>(await run(ctx, "agent.trace.list", { runId })).entries;
    return entries.filter((entry) => entry.kind === "model").at(-1)?.delivery ?? [];
  };
  const importAs = async (id: string, kind: "comic" | "video", title: string) =>
    ok<{ resourceId: string; revisionId: string }>(await run(ctx, "library.importDocument", { title, kind, pathHandle: ctx.app.registerPath("file", inLibrary(ctx.app, samplePath(id))) }));
  return { ctx, seen, ask, delivered, importAs, connectionId: created.id };
}

describe("the stretch a clip covers (AT-146)", () => {
  it("is the interval, else the ten seconds before the position, and never passes the position or the watched limit", () => {
    expect(clipRange({ positionMs: 8000, interval: { startMs: 3500, endMs: 7500 } }, [], false)).toEqual({ startMs: 3500, endMs: 7500 });
    expect(clipRange({ positionMs: 30_000 }, [], false)).toEqual({ startMs: 20_000, endMs: 30_000 });
    expect(clipRange({ positionMs: 4000 }, [], false)).toEqual({ startMs: 0, endMs: 4000 });
    // An interval reaching past the position stops at it.
    expect(clipRange({ positionMs: 6000, interval: { startMs: 2000, endMs: 9000 } }, [], false)).toEqual({ startMs: 2000, endMs: 6000 });
    // With the guard on, what was not watched is not sent, however far the player sits.
    expect(clipRange({ positionMs: 9000 }, [{ start: 0, end: 5000 }], true)).toEqual({ startMs: 0, endMs: 5000 });
    expect(clipRange({ positionMs: 9000, interval: { startMs: 6000, endMs: 8000 } }, [{ start: 0, end: 5000 }], true)).toEqual({ startMs: 5000, endMs: 5000 });
  });
});

describe.skipIf(mediaPrerequisitesAbsent)("whole PDFs for a model that reads them (AT-145)", () => {
  requireSamples(["comic-pdf-images", "video-mp4-h264-aac"]);

  it("sends the PDF the person chose as the file, on both protocols, and records only its size and pages", async () => {
    for (const protocol of ["openai-responses", "openai-chat-completions"] as const) {
      const { seen, ask, delivered, importAs } = await rig({ protocol });
      const book = await importAs("comic-pdf-images", "comic", "整本的漫画");
      const before = seen.length;
      const done = await ask({ readResourceIds: [book.resourceId] });
      expect(done.status).toBe("succeeded");
      const requests = asked(seen.slice(before));
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) expect(pdfParts(request)).toBe(1);
      expect(JSON.stringify(requests[0]!.body)).toContain("data:application/pdf;base64,");
      const notes = await delivered(done.runId);
      expect(notes).toEqual([expect.objectContaining({ kind: "file", pages: 5 })]);
      expect(notes[0]!.reason).toBeUndefined();
    }
  });

  it("falls back to text with the reason when any one condition fails", async () => {
    const cases: Array<{ name: string; options: Parameters<typeof rig>[0]; setup?: (ctx: App) => Promise<void>; input?: (book: { resourceId: string; revisionId: string }) => Record<string, unknown>; reason: string }> = [
      { name: "the model does not take PDFs", options: { inputTypes: ["text"] }, reason: "model-no-pdf" },
      { name: "the pi runtime", options: { runtime: "pi" }, reason: "runtime-unsupported" },
      { name: "a page of it is open", options: {}, input: (book) => ({ mediaContext: { comic: { resourceId: book.resourceId, resourceRevisionId: book.revisionId, pageId: "p0001" } } }), reason: "partial-material" },
      { name: "not read to the end with the guard on", options: {}, setup: async (ctx) => { ok(await run(ctx, "settings.setShell", { spoilerGuard: true })); }, reason: "spoiler-range" },
      { name: "a window too small to hold it", options: { contextWindow: 8_000, maxOutput: 1_000 }, reason: "over-budget" },
    ];
    for (const item of cases) {
      const { ctx, seen, ask, delivered, importAs } = await rig(item.options);
      const book = await importAs("comic-pdf-images", "comic", "整本的漫画");
      await item.setup?.(ctx);
      const before = seen.length;
      const input = item.input?.(book) ?? {};
      if (input.mediaContext) {
        const pages = ok<{ pages: Array<{ id: string }> }>(await run(ctx, "comic.pages", { resourceId: book.resourceId }));
        (input.mediaContext as { comic: { pageId: string } }).comic.pageId = pages.pages[0]!.id;
      }
      const done = await ask({ readResourceIds: [book.resourceId], ...input });
      expect(done.status, item.name).toBe("succeeded");
      for (const request of asked(seen.slice(before))) expect(pdfParts(request), item.name).toBe(0);
      expect(await delivered(done.runId), item.name).toEqual([expect.objectContaining({ kind: "text", reason: item.reason })]);
    }
  });

  it("keeps a file or a clip over the profile's size limit out, and says so with the size", async () => {
    // The schema's floor (1 MiB) is above the synthetic samples, so the rule is checked where it is made, with a profile below their size.
    const { ctx, importAs } = await rig();
    const book = await importAs("comic-pdf-images", "comic", "整本的漫画");
    const size = fs.statSync(resolveLocation(ctx.app.store, book.revisionId)!.path!).size;
    const native = (limits: Partial<typeof DEFAULT_MODEL_PROFILE.limits>) => ({
      store: ctx.app.store, videos: ctx.app.videos, runtime: "native" as const, protocol: "openai-chat-completions" as const, contextTokens: 100_000, spoilerGuard: false,
      profile: { ...DEFAULT_MODEL_PROFILE, inputTypes: ["text", "pdf", "video"] as typeof DEFAULT_MODEL_PROFILE.inputTypes, limits: { ...DEFAULT_MODEL_PROFILE.limits, ...limits } },
    });
    const chosen = [{ resourceId: book.resourceId, revisionId: book.revisionId, title: "整本的漫画" }];
    expect((await decidePdfs(native({ fileBytes: size - 1 }), chosen, new Set(), { tokens: 0 })).delivery).toEqual([{ kind: "text", bytes: size, reason: "over-size-limit" }]);
    expect((await decidePdfs(native({ fileBytes: size }), chosen, new Set(), { tokens: 0 })).files).toHaveLength(1);
    const video = await importAs("video-mp4-h264-aac", "video", "片段");
    const frozen = { resourceId: video.resourceId, revisionId: video.revisionId, positionMs: 4000, interval: { startMs: 1000, endMs: 4000 } } as Parameters<typeof decideClip>[1];
    const fits = await decideClip(native({}), frozen, { tokens: 0 });
    expect(fits.clipBytes!.length).toBeGreaterThan(0);
    const over = await decideClip(native({ videoBytes: fits.clipBytes!.length - 1 }), frozen, { tokens: 0 });
    expect(over.clip).toBeUndefined();
    expect(over.delivery).toEqual([{ kind: "frames", seconds: 3, bytes: fits.clipBytes!.length, reason: "over-size-limit" }]);
  });

  it("stops a retry when the PDF was replaced after the task was sent, and sends no other file", async () => {
    const { ctx, seen, ask } = await rig();
    // A copy of its own, so replacing it leaves the shared sample alone.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-native-pdf-"));
    const copy = path.join(dir, "整本.pdf");
    fs.copyFileSync(samplePath("comic-pdf-images"), copy);
    closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const book = ok<{ resourceId: string; revisionId: string }>(await run(ctx, "library.importDocument", { title: "整本的漫画", kind: "comic", pathHandle: ctx.app.registerPath("file", inLibrary(ctx.app, copy, "comic")) }));
    const done = await ask({ readResourceIds: [book.resourceId] });
    expect(done.status).toBe("succeeded");
    ctx.app.store.sqlite.prepare("UPDATE agent_runs SET status = 'failed' WHERE id = ?").run(done.runId);
    expect(resolveLocation(ctx.app.store, book.revisionId)!.path).toBe(copy);
    fs.appendFileSync(copy, "\n% replaced\n");
    const before = seen.length;
    ok(await run(ctx, "agent.retry", { runId: done.runId }));
    const again = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, done.runId);
    expect(String(again.value?.status ?? again.value?.run?.status)).toBe("failed");
    const error = JSON.parse((ctx.app.store.sqlite.prepare("SELECT error_json FROM agent_runs WHERE id = ?").get(done.runId) as { error_json: string }).error_json);
    expect(error).toMatchObject({ code: "REVISION_CONFLICT", details: { reason: "media-source-changed" } });
    expect(error.message).toContain("重新发起任务");
    expect(asked(seen.slice(before))).toEqual([]);
  });
});

describe.skipIf(mediaPrerequisitesAbsent)("clips of the video for a model that watches them (AT-146)", () => {
  requireSamples(["video-mkv-ass-fonts", "video-mkv-hevc-8bit", "video-vfr", "video-mp4-h264-aac"]);

  it("cuts the interval without re-encoding from MKV, HEVC and variable-frame-rate sources, never ending past it", async () => {
    for (const id of ["video-mkv-ass-fonts", "video-mkv-hevc-8bit", "video-vfr", "video-mp4-h264-aac"]) {
      const { ctx, seen, ask, delivered, importAs } = await rig();
      const video = await importAs(id, "video", `片段 ${id}`);
      const before = seen.length;
      const done = await ask({ mediaContext: { video: { resourceId: video.resourceId, resourceRevisionId: video.revisionId, positionMs: 4000, interval: { startMs: 1000, endMs: 4000 } } } });
      expect(done.status, id).toBe("succeeded");
      const requests = asked(seen.slice(before));
      const base64 = videoBase64(requests[0]!);
      expect(base64, id).toBeTruthy();
      const bytes = Buffer.from(base64!, "base64");
      expect(bytes.subarray(4, 8).toString("latin1"), id).toBe("ftyp");
      const probe = ffprobe(ctx, bytes);
      expect(probe.format, id).toContain("mp4");
      // The cut starts on a keyframe at or before the start and stops at the end: no frame shown after it (the samples have keyframes at most 2.7 s apart).
      expect(probe.frameSpan, id).toBeGreaterThan(1.5);
      expect(probe.frameSpan, id).toBeLessThanOrEqual(4.001);
      if (id === "video-mkv-hevc-8bit") expect(probe.codec).toBe("hevc");
      const notes = await delivered(done.runId);
      expect(notes, id).toEqual([expect.objectContaining({ kind: "video", seconds: 3, bytes: bytes.length })]);
      // The snapshot names the clip by hash and keeps its bytes once, like a still.
      const kept = ctx.app.store.sqlite.prepare("SELECT m.mime, m.size FROM agent_run_media r JOIN agent_media m ON m.hash = r.hash WHERE r.run_id = ?").all(done.runId);
      expect(kept, id).toEqual([{ mime: "video/mp4", size: bytes.length }]);
      const receipt = ok<Record<string, any>>(await run(ctx, "agent.getRun", { runId: done.runId }));
      expect(receipt.media.clip).toMatchObject({ startMs: 1000, endMs: 4000, seconds: 3 });
      expect(receipt.media.clip.stamp).toBeUndefined();
    }
  });

  it("sends frames with the reason when a condition fails, and keeps the clip inside what was watched", async () => {
    const position = { positionMs: 4000, interval: { startMs: 1000, endMs: 4000 } };
    const cases: Array<{ name: string; options: Parameters<typeof rig>[0]; video?: Record<string, unknown>; guard?: number; reason: string }> = [
      { name: "the model does not take video", options: { inputTypes: ["text"] }, reason: "model-no-video" },
      { name: "the pi runtime", options: { runtime: "pi" }, reason: "runtime-unsupported" },
      { name: "the Responses protocol", options: { protocol: "openai-responses" }, reason: "protocol-no-video" },
      { name: "longer than the model takes", options: { limits: { videoSeconds: 5 } }, video: { positionMs: 9000, interval: { startMs: 0, endMs: 9000 } }, reason: "over-length-limit" },
      { name: "nothing watched before the position", options: {}, guard: 0, reason: "clip-empty" },
    ];
    for (const item of cases) {
      const { ctx, seen, ask, delivered, importAs } = await rig(item.options);
      const video = await importAs("video-mkv-hevc-8bit", "video", "片段");
      if (item.guard !== undefined) ok(await run(ctx, "settings.setShell", { spoilerGuard: true }));
      const before = seen.length;
      const done = await ask({ mediaContext: { video: { resourceId: video.resourceId, resourceRevisionId: video.revisionId, ...position, ...item.video } } });
      expect(done.status, item.name).toBe("succeeded");
      for (const request of asked(seen.slice(before))) expect(videoBase64(request), item.name).toBeUndefined();
      const notes = await delivered(done.runId);
      expect(notes, item.name).toEqual([expect.objectContaining({ kind: "frames", reason: item.reason })]);
    }
    // With the guard on and five seconds watched, a clip asked at nine seconds ends at five.
    const { ctx, seen, ask, importAs } = await rig();
    const video = await importAs("video-mkv-hevc-8bit", "video", "片段");
    ok(await run(ctx, "settings.setShell", { spoilerGuard: true }));
    ok(await run(ctx, "progress.setTime", { contextId: null, resourceId: video.resourceId, resourceRevisionId: video.revisionId, timeMs: 9000, played: [{ startMs: 0, endMs: 5000 }] }));
    const before = seen.length;
    const done = await ask({ mediaContext: { video: { resourceId: video.resourceId, resourceRevisionId: video.revisionId, positionMs: 9000 } } });
    const bytes = Buffer.from(videoBase64(asked(seen.slice(before))[0]!)!, "base64");
    expect(ffprobe(ctx, bytes).frameSpan).toBeLessThanOrEqual(5.001);
    expect(ok<Record<string, any>>(await run(ctx, "agent.getRun", { runId: done.runId })).media.clip).toMatchObject({ startMs: 0, endMs: 5000 });
  });

  it("after the retention period cuts the same clip again from the unchanged file, and stops when the file changed", async () => {
    const { ctx, seen, ask, delivered, importAs } = await rig();
    const video = await importAs("video-mp4-h264-aac", "video", "片段");
    const done = await ask({ mediaContext: { video: { resourceId: video.resourceId, resourceRevisionId: video.revisionId, positionMs: 4000, interval: { startMs: 1000, endMs: 4000 } } } });
    const endedAgo = (days: number) => ctx.app.store.sqlite.prepare("UPDATE agent_runs SET status = 'failed', updated_at = ? WHERE id = ?").run(new Date(Date.now() - days * DAY).toISOString(), done.runId);
    endedAgo(40);
    expect(ctx.app.sweepAgentMedia()).toEqual({ runs: 1, removed: 1 });
    expect(ok<Record<string, any>>(await run(ctx, "agent.getRun", { runId: done.runId })).media.clip.expired).toBe(true);
    const before = seen.length;
    ok(await run(ctx, "agent.retry", { runId: done.runId }));
    const again = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, done.runId);
    expect(String(again.value?.status ?? again.value?.run?.status)).toBe("succeeded");
    expect(videoBase64(asked(seen.slice(before))[0]!)).toBeTruthy();
    expect(await delivered(done.runId)).toEqual([expect.objectContaining({ kind: "video", reason: "expired-reextracted" })]);
    endedAgo(40);
    ctx.app.sweepAgentMedia();
    const file = resolveLocation(ctx.app.store, video.revisionId)!.path!;
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
    const beforeChanged = seen.length;
    ok(await run(ctx, "agent.retry", { runId: done.runId }));
    const stopped = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, done.runId);
    expect(String(stopped.value?.status ?? stopped.value?.run?.status)).toBe("failed");
    const error = JSON.parse((ctx.app.store.sqlite.prepare("SELECT error_json FROM agent_runs WHERE id = ?").get(done.runId) as { error_json: string }).error_json);
    expect(error).toMatchObject({ code: "REVISION_CONFLICT", details: { reason: "media-source-changed" } });
    expect(asked(seen.slice(beforeChanged))).toEqual([]);
  });
});
