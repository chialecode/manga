import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";
import { EnergyVad, FakeAsr, FakeLlm, join, quiet, samplesFor, seedResource, textLocator, tone, toBase64 } from "../helpers/voice.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
let counter = 0;
const apps: App[] = [];

async function boot() {
  const asr = new FakeAsr();
  const llm = new FakeLlm();
  const ctx = await startApp({ options: { vad: new EnergyVad(), asr, llm, voiceRetryBaseMs: 0 } });
  apps.push(ctx);
  return { ...ctx, asr, llm };
}
afterEach(() => {
  while (apps.length) apps.pop()!.app.close();
});

async function run(ctx: App, commandId: string, input: Record<string, unknown>, key?: string): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: key ?? `voice-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}

async function settle(ctx: App, sessionId: string, stage: string | string[]): Promise<Record<string, any>> {
  const wanted = Array.isArray(stage) ? stage : [stage];
  for (let i = 0; i < 400; i += 1) {
    await ctx.app.media.jobs.idle();
    const status = ok(await run(ctx, "capture.status", { sessionId })).session;
    if (wanted.includes(status.stage) && !ctx.app.voice.pipeline.busy(sessionId)) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`recording never reached ${wanted.join("/")}`);
}

/** Speech at 1-3 s and 6-8 s of a 10 s recording. */
const audio = () => join(quiet(1000), tone(2000), quiet(3000), tone(2000), quiet(2000));

async function record(ctx: App, input: Record<string, unknown>, events: Array<Record<string, unknown>> = [], pcm = audio()) {
  const started = ok(await run(ctx, "capture.start", { mode: "toggle", retention: "discard", ...input }));
  const sessionId = started.sessionId as string;
  const size = samplesFor(500);
  let seq = 0;
  for (let at = 0; at < pcm.length; at += size) {
    ok(await run(ctx, "capture.append", { sessionId, seq, data: toBase64(pcm.subarray(at, Math.min(pcm.length, at + size))) }, `cap:${sessionId}:a:${seq}`));
    seq += 1;
  }
  for (const [index, event] of events.entries()) ok(await run(ctx, "capture.event", { sessionId, ...event }, `cap:${sessionId}:e:${index}`));
  const stopped = ok(await run(ctx, "capture.stop", { sessionId, durationMs: pcm.length / 16 }));
  return { sessionId, started, stopped };
}

describe("recording commands", () => {
  it("records, transcribes, shows each block's source, organizes and makes one note", async () => {
    const ctx = await boot();
    const r = seedResource(ctx.app.store, { title: "试读" });
    const { sessionId } = await record(
      ctx,
      { resourceId: r.resourceId, resourceRevisionId: r.revisionId, locator: textLocator(0) },
      [{ offsetMs: 6000, reason: "page", locator: textLocator(800) }],
    );
    await settle(ctx, sessionId, "done");
    const review = ok(await run(ctx, "capture.review", { sessionId }));
    expect(review.segments).toHaveLength(2);
    expect(review.segments[0].anchors[0].locator.range.start).toBe(0);
    expect(review.segments[1].anchors.at(-1).locator.range.start).toBe(800);
    expect(review.audio).toEqual({ state: "cleaned", playable: false });
    // Per-chunk request records do not pile up after the recording ends.
    const leftover = ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM command_requests WHERE command_id IN ('capture.append','capture.event')").get() as { n: number };
    expect(leftover.n).toBe(0);

    const organized = ok(await run(ctx, "capture.organize", { sessionId }));
    expect(organized.drafts).toHaveLength(1);
    await ctx.app.media.jobs.idle();
    const draft = ok(await run(ctx, "capture.review", { sessionId })).drafts[0];
    expect(draft.state).toBe("ready");
    ok(await run(ctx, "capture.editDraft", { draftId: draft.id, editedText: "我的整理稿\n第二段" }));
    const accepted = ok(await run(ctx, "capture.acceptDraft", { draftId: draft.id, title: "口述：试读" }));
    expect(accepted.objectId).toMatch(/^obj/);
    expect(accepted.anchors).toBe(2);
    // Accepting again points at the same note; nothing is created twice.
    const again = ok(await run(ctx, "capture.acceptDraft", { draftId: draft.id }));
    expect(again).toMatchObject({ objectId: accepted.objectId, duplicate: true });
    const notes = ok(await run(ctx, "notes.list", {}));
    expect(JSON.stringify(notes)).toContain(accepted.objectId);
    const note = ok(await run(ctx, "notes.get", { objectId: accepted.objectId }));
    expect(JSON.stringify(note)).toContain("我的整理稿");
    expect((ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM content_objects WHERE type = 'notes.document'").get() as { n: number }).n).toBe(1);
    expect((ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM refs WHERE from_object_id = ?").get(accepted.objectId) as { n: number }).n).toBe(2);
  });

  it("records against a comic page and a video time, and maps blocks to them", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "漫画", pageCount: 5 });
    const video = seedVideo(ctx.app, { title: "动画", durationMs: 600_000 });
    const { sessionId } = await record(
      ctx,
      { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, locator: { kind: "image", pageId: comic.pageIds[0] } },
      [
        { offsetMs: 5000, reason: "resource_change", resourceId: video.resourceId, resourceRevisionId: video.revisionId, locator: { kind: "temporal", startMs: 60_000 }, playing: true, playbackRate: 2 },
        { offsetMs: 7000, reason: "pause" },
      ],
    );
    await settle(ctx, sessionId, "done");
    const [first, second] = ok(await run(ctx, "capture.review", { sessionId })).segments;
    expect(first.anchors.map((a: any) => a.locator.pageId)).toEqual([comic.pageIds[0]]);
    // The second block starts before 5 s... it begins at about 5.7 s: video time runs at 2x until the pause at 7 s.
    expect(second.anchors.every((a: any) => a.resourceId === video.resourceId)).toBe(true);
    const times = second.anchors.map((a: any) => [a.locator.startMs, a.locator.endMs]);
    expect(times).toHaveLength(1);
    expect(times[0]![0]).toBeGreaterThanOrEqual(60_000);
    // 2x for two seconds covers four seconds of video, then the clock keeps running while the video stands still.
    expect(times[0]![1] - times[0]![0]).toBeGreaterThan(2500);
  });

  it("refuses to record against a resource that does not exist, or events out of a recording", async () => {
    const ctx = await boot();
    expect((await run(ctx, "capture.start", { mode: "hold", resourceId: "missing" })).status).toBe("error");
    expect((await run(ctx, "capture.append", { sessionId: "nope", seq: 0, data: "AAAA" })).status).toBe("error");
    const started = ok(await run(ctx, "capture.start", { mode: "hold" }));
    const busy = await run(ctx, "capture.start", { mode: "toggle" });
    expect(busy.status).toBe("error");
    expect(JSON.stringify(busy)).toContain("already in progress");
    ok(await run(ctx, "capture.stop", { sessionId: started.sessionId }));
  });

  it("keeps recording settings, rejects two commands on one key, and keeps media preferences", async () => {
    const ctx = await boot();
    expect(ok(await run(ctx, "settings.getRecording", {}))).toMatchObject({ holdKey: "F9", toggleKey: "F8", retention: "keep", duckPlayback: "lower", boundaryMarginMs: 300 });
    ok(await run(ctx, "settings.setRecording", { holdKey: "F7", retention: "discard", overlay: { width: 320 } }));
    expect(ok(await run(ctx, "settings.getRecording", {}))).toMatchObject({ holdKey: "F7", retention: "discard", overlay: { width: 320, height: 84 } });
    expect((await run(ctx, "settings.setRecording", { holdKey: "F8" })).status).toBe("error");
    // The next recording follows the setting when the command names none.
    const started = ok(await run(ctx, "capture.start", { mode: "hold" }));
    expect(started.retention).toBe("discard");
    ok(await run(ctx, "capture.stop", { sessionId: started.sessionId }));
    ok(await run(ctx, "settings.setMedia", { comic: { direction: "ltr", autoFlipSeconds: 5 }, video: { holdRate: 3 } }));
    expect(ok(await run(ctx, "settings.getMedia", {}))).toMatchObject({ comic: { direction: "ltr", layout: "single", autoFlipSeconds: 5 }, video: { holdRate: 3, seekStepSeconds: 5 } });
  });

  it("does not let an agent record or read recordings", async () => {
    const ctx = await boot();
    const r = seedResource(ctx.app.store);
    const agent = { kind: "agent" as const, id: "agent:voice" };
    const grant = ctx.app.issueAgentGrant(ctx.grant, agent, { sessionId: "sess-voice", runId: "run-voice", readResourceIds: [r.resourceId] });
    for (const commandId of ["capture.start", "capture.list", "capture.review", "settings.getRecording"]) {
      const result = await ctx.app.call(agent, { commandId, idempotencyKey: `agent-${commandId}`, input: commandId === "capture.start" ? { mode: "hold" } : commandId === "capture.review" ? { sessionId: "x" } : {} }, grant.handle);
      expect(result.status, commandId).toBe("error");
    }
  });
});

describe("turning the voice module off and on", () => {
  it("saves a recording in progress, refuses recording while off, and finishes it when switched back on", async () => {
    const ctx = await boot();
    const r = seedResource(ctx.app.store);
    const started = ok(await run(ctx, "capture.start", { mode: "toggle", retention: "discard", resourceId: r.resourceId, resourceRevisionId: r.revisionId, locator: textLocator(0) }));
    const sessionId = started.sessionId as string;
    const pcm = audio();
    ok(await run(ctx, "capture.append", { sessionId, seq: 0, data: toBase64(pcm.subarray(0, samplesFor(5000))) }));
    const profile = ctx.app.runtime.snapshot().lastValidProfile!;
    await ctx.app.runtime.applyProfile({ ...profile, revision: profile.revision + 1, enabledFeatures: profile.enabledFeatures.filter((id) => id !== "voice"), disabledFeatures: [...profile.disabledFeatures, "voice"] });
    // What was recorded is saved; no more audio is accepted and the commands are gone.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const row = ctx.app.voice.row(sessionId);
    expect(row.stage).toBe("recorded");
    expect(row.duration_ms).toBe(5000);
    expect(fs.existsSync(path.join(ctx.app.store.attachmentsDir, row.staging_name!))).toBe(true);
    expect((await run(ctx, "capture.start", { mode: "toggle" })).status).toBe("error");
    expect(ctx.app.runtime.gateway.has("capture.start")).toBe(false);
    expect(ctx.asr.calls).toHaveLength(0);
    // Switched back on, the recording is picked up and processed.
    const latest = ctx.app.runtime.snapshot().lastValidProfile!;
    await ctx.app.runtime.applyProfile({ ...latest, revision: latest.revision + 1, enabledFeatures: [...latest.enabledFeatures, "voice"], disabledFeatures: latest.disabledFeatures.filter((id) => id !== "voice") });
    const status = await settle(ctx, sessionId, ["done", "pending", "no_speech"]);
    expect(status.stage).toBe("done");
    expect(ctx.asr.calls.length).toBeGreaterThan(0);
  });

  it("survives repeated starts and stops without leaking jobs or files", async () => {
    const ctx = await boot();
    for (let i = 0; i < 20; i += 1) {
      const started = ok(await run(ctx, "capture.start", { mode: i % 2 ? "hold" : "toggle", retention: "discard" }));
      ok(await run(ctx, "capture.append", { sessionId: started.sessionId, seq: 0, data: toBase64(i % 2 ? tone(300) : quiet(300)) }));
      ok(await run(ctx, "capture.stop", { sessionId: started.sessionId }));
    }
    await ctx.app.media.jobs.idle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ctx.app.media.jobs.idle();
    expect(ctx.app.voice.activeId).toBeNull();
    const stages = (ctx.app.store.sqlite.prepare("SELECT stage, COUNT(*) AS n FROM capture_sessions GROUP BY stage").all() as Array<{ stage: string; n: number }>);
    expect(stages.reduce((sum, item) => sum + item.n, 0)).toBe(20);
    expect(stages.every((item) => ["done", "no_speech", "pending"].includes(item.stage))).toBe(true);
    const leftovers = fs.readdirSync(ctx.app.store.attachmentsDir).filter((name) => name.startsWith("capture-"));
    expect(leftovers).toEqual([]);
    expect(ctx.app.media.jobs.list({ active: true })).toEqual([]);
  });
});
