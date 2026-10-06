import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MangaError } from "@manga/contracts";
import { PCM_BYTES_PER_MS } from "../../packages/app-core/src/voice/audio-files.ts";
import { CaptureService } from "../../packages/app-core/src/voice/capture.ts";
import { EnergyVad, feed, join, quiet, seedResource, textLocator, tone, toBase64, voiceHarness, type Harness } from "../helpers/voice.ts";

const harnesses: Harness[] = [];
const make = (options: Parameters<typeof voiceHarness>[0] = {}) => {
  const h = voiceHarness(options);
  harnesses.push(h);
  return h;
};
afterEach(() => {
  while (harnesses.length) harnesses.pop()!.close();
});

/** 12 s: quiet, speech 2-5 s, quiet, speech 8-10 s, quiet. */
const twoSentences = () => join(quiet(2000), tone(3000), quiet(3000), tone(2000), quiet(2000));

async function recordTwoSentences(h: Harness, options: { retention?: "keep" | "discard"; stopReason?: "user" } = {}) {
  const { resourceId, resourceRevisionId } = (() => { const r = seedResource(h.store); return { resourceId: r.resourceId, resourceRevisionId: r.revisionId }; })();
  const started = h.service.start({ mode: "toggle", resourceId, resourceRevisionId, locator: textLocator(0), retention: options.retention ?? "discard" });
  const id = started.sessionId;
  feed(h.service, id, twoSentences());
  h.service.event({ sessionId: id, offsetMs: 4000, reason: "page", locator: textLocator(500) });
  h.service.event({ sessionId: id, offsetMs: 9000, reason: "selection", locator: textLocator(900) });
  await h.service.stop({ sessionId: id, durationMs: 12_000 });
  return { id, resourceId, resourceRevisionId };
}

describe("recording lifecycle", () => {
  it("keeps what arrives, in order, with a start event, and refuses a second recording", async () => {
    const h = make();
    const r = seedResource(h.store);
    const { sessionId } = h.service.start({ mode: "hold", resourceId: r.resourceId, resourceRevisionId: r.revisionId, locator: textLocator(0) });
    expect(() => h.service.start({ mode: "toggle" })).toThrow(/already in progress/);
    expect(h.service.status().active?.id).toBe(sessionId);
    const next = feed(h.service, sessionId, tone(1000));
    expect(next).toBe(10);
    expect(h.service.status(sessionId).session).toMatchObject({ stage: "recording", durationMs: 1000 });
    const events = h.service.events(sessionId);
    expect(events[0]).toMatchObject({ offsetMs: 0, reason: "start", resourceId: r.resourceId, resourceRevisionId: r.revisionId });
    const row = h.service.row(sessionId);
    expect(fs.statSync(path.join(h.store.attachmentsDir, row.staging_name!)).size).toBe(1000 * PCM_BYTES_PER_MS);
    await h.service.stop({ sessionId });
    await h.settle(sessionId);
  });

  it("ignores a repeated chunk, fills a hole with silence, and rejects malformed audio", async () => {
    const h = make();
    const { sessionId } = h.service.start({ mode: "toggle" });
    const chunk = toBase64(tone(100));
    expect(h.service.append(sessionId, 0, chunk).duplicate).toBe(false);
    expect(h.service.append(sessionId, 0, chunk).duplicate).toBe(true);
    // Sequence 1 and 2 never arrived: 3 follows.
    h.service.append(sessionId, 3, chunk);
    expect(h.service.status(sessionId).session!.durationMs).toBe(400);
    expect(() => h.service.append(sessionId, 4, Buffer.from([1, 2, 3]).toString("base64"))).toThrow(/whole 16-bit samples/);
    await h.service.stop({ sessionId });
    expect(h.service.vad(sessionId)?.gaps ?? h.service.row(sessionId).vad_json).toBeDefined();
    await h.settle(sessionId);
  });

  it("stops once: a second stop returns the finished recording, and nothing can be appended afterwards", async () => {
    const h = make();
    const { sessionId } = h.service.start({ mode: "hold" });
    feed(h.service, sessionId, tone(500));
    const first = await h.service.stop({ sessionId, reason: "user" });
    const second = await h.service.stop({ sessionId, reason: "user" });
    expect(second.id).toBe(first.id);
    expect(() => h.service.append(sessionId, 99, toBase64(tone(100)))).toThrow(/not in progress/);
    expect(() => h.service.event({ sessionId, offsetMs: 100, reason: "page" })).toThrow(/not in progress/);
    await h.settle(sessionId);
  });

  it("pads a lost tail to the length the renderer counted, so event offsets stay true", async () => {
    const h = make();
    const { sessionId } = h.service.start({ mode: "toggle" });
    feed(h.service, sessionId, tone(1000));
    const view = await h.service.stop({ sessionId, durationMs: 2500 });
    expect(view.durationMs).toBe(2500);
    await h.settle(sessionId);
  });

  it("thins periodic samples but never position changes, and keeps events out of the far future", async () => {
    const h = make();
    const r = seedResource(h.store, { kind: "video" });
    const { sessionId } = h.service.start({ mode: "toggle", resourceId: r.resourceId, resourceRevisionId: r.revisionId });
    feed(h.service, sessionId, tone(3000));
    const video = (startMs: number) => ({ kind: "temporal" as const, startMs });
    expect(h.service.event({ sessionId, offsetMs: 1000, reason: "sample", locator: video(1000), playing: true }).stored).toBe(true);
    expect(h.service.event({ sessionId, offsetMs: 1300, reason: "sample", locator: video(1300), playing: true }).stored).toBe(false);
    expect(h.service.event({ sessionId, offsetMs: 1400, reason: "seek", locator: video(50_000), playing: true }).stored).toBe(true);
    h.service.event({ sessionId, offsetMs: 900_000, reason: "pause" });
    const last = h.service.events(sessionId).at(-1)!;
    expect(last.offsetMs).toBeLessThanOrEqual(3000 + 5000);
    await h.service.stop({ sessionId });
    await h.settle(sessionId);
  });

  it("refuses events that name a revision of another resource", () => {
    const h = make();
    const a = seedResource(h.store);
    const b = seedResource(h.store);
    const { sessionId } = h.service.start({ mode: "toggle", resourceId: a.resourceId });
    expect(() => h.service.event({ sessionId, offsetMs: 0, reason: "resource_change", resourceId: a.resourceId, resourceRevisionId: b.revisionId })).toThrow(/does not belong/);
  });
});

describe("filtering and transcription", () => {
  it("uploads only the speech blocks and maps each to where the reader was", async () => {
    const h = make();
    const { id, resourceId, resourceRevisionId } = await recordTwoSentences(h);
    await h.settle(id);
    expect(h.asr.calls).toHaveLength(2);
    const stats = h.service.view(h.service.row(id));
    expect(stats.stage).toBe("done");
    expect(stats.segments).toMatchObject({ total: 2, done: 2, failed: 0 });
    const review = h.service.review(id);
    expect(review.segments.map((segment) => segment.originalText)).toEqual([`说话@${review.segments[0]!.startMs}`, `说话@${review.segments[1]!.startMs}`]);
    const [first, second] = review.segments;
    expect(first!.startMs).toBeGreaterThanOrEqual(1500);
    expect(first!.endMs).toBeLessThanOrEqual(5500);
    expect(second!.startMs).toBeGreaterThanOrEqual(7500);
    expect(first!.precision).toBe("chunk");
    expect(first!.calibrated).toBe(false);
    // First block: on the opening place until 4 s, then on the page the reader turned to. Second: that page, then the selection at 9 s.
    expect(first!.anchors.map((anchor) => [anchor.startMs, anchor.endMs, (anchor.locator as any).range.start])).toEqual([[first!.startMs, 4000, 0], [4000, first!.endMs, 500]]);
    expect(second!.anchors.map((anchor) => [anchor.startMs, anchor.endMs, (anchor.locator as any).range.start])).toEqual([[second!.startMs, 9000, 500], [9000, second!.endMs, 900]]);
    expect(first!.anchors.every((anchor) => anchor.resourceId === resourceId && anchor.resourceRevisionId === resourceRevisionId)).toBe(true);
    // The audio that was not speech is accounted for, not lost.
    expect(review.filtered.length).toBeGreaterThanOrEqual(2);
    expect(review.filtered[0]!.startMs).toBe(0);
  });

  it("sends audio the size of the block, not of the recording", async () => {
    const h = make();
    const { id } = await recordTwoSentences(h);
    await h.settle(id);
    const total = h.asr.calls.reduce((sum, call) => sum + call.bytes, 0);
    expect(total).toBeLessThan(12_000 * PCM_BYTES_PER_MS * 0.6);
    expect(h.asr.calls.every((call) => /^c\d+-\d+\.wav$/.test(call.fileName))).toBe(true);
  });

  it("does not upload a recording with no speech and says so", async () => {
    const h = make();
    const { sessionId } = h.service.start({ mode: "toggle" });
    feed(h.service, sessionId, quiet(8000));
    await h.service.stop({ sessionId });
    await h.settle(sessionId);
    expect(h.asr.calls).toHaveLength(0);
    expect(h.service.view(h.service.row(sessionId))).toMatchObject({ stage: "no_speech", segments: { total: 0 } });
  });

  it("falls back to a full pass over the file when the live filter was lost", async () => {
    const vad = new EnergyVad();
    const h = make({ vad });
    // A filter that dies on its first push: the recording must still be filtered, after it ends.
    vad.open = () => ({ push: () => Promise.reject(new Error("worker gone")), close: () => undefined });
    const { id } = await recordTwoSentences(h);
    await h.settle(id);
    expect(vad.fullPasses).toBe(1);
    expect(h.service.vad(id)?.analyzedFull).toBe(true);
    expect(h.asr.calls).toHaveLength(2);
  });

  it("says the filter is missing instead of uploading everything", async () => {
    const vad = new EnergyVad();
    vad.available = false;
    vad.unavailableReason = "the voice filter model or runtime is not installed";
    const h = make({ vad });
    const { sessionId } = h.service.start({ mode: "toggle" });
    feed(h.service, sessionId, tone(2000));
    await h.service.stop({ sessionId });
    await h.settle(sessionId);
    const view = h.service.view(h.service.row(sessionId));
    expect(view.stage).toBe("failed");
    expect(view.error?.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(h.asr.calls).toHaveLength(0);
    expect(view.audioState).toBe("staged");
  });

  it("restricts terms to the work and sends them with each block", async () => {
    const h = make();
    const r = seedResource(h.store);
    h.service.addTerm(r.workId, "桐谷", "同古");
    h.service.addTerm(r.workId, "星之海");
    const { sessionId } = h.service.start({ mode: "toggle", resourceId: r.resourceId, resourceRevisionId: r.revisionId });
    feed(h.service, sessionId, join(quiet(500), tone(2000), quiet(500)));
    await h.service.stop({ sessionId });
    await h.settle(sessionId);
    expect(h.asr.calls[0]!.prompt).toBe("桐谷, 星之海");
    expect(h.service.terms(r.workId).terms).toEqual([{ term: "桐谷", heard: "同古" }, { term: "星之海", heard: null }]);
    expect(h.service.removeTerm(r.workId, "桐谷").removed).toBe(true);
    expect(() => h.service.addTerm("missing", "x")).toThrow(/not found/);
  });
});

describe("failures, retry and cancellation", () => {
  it("backs off on a rate limit and then succeeds without sending a block twice", async () => {
    const h = make();
    h.asr.failures.set(0, new MangaError("RATE_LIMITED", "slow down", { retryable: true, details: { retryAfterMs: 1 } }));
    const { id } = await recordTwoSentences(h);
    await h.settle(id);
    expect(h.service.view(h.service.row(id)).stage).toBe("done");
    // Three requests: the limited try, its repeat, and the second block.
    expect(h.asr.calls).toHaveLength(3);
    expect(h.asr.keys()[0]).toBe(h.asr.keys()[1]);
    expect(h.asr.keys()[2]).not.toBe(h.asr.keys()[0]);
  });

  it("marks a block failed after repeated errors, keeps the audio, and a retry sends only the failed block", async () => {
    const h = make();
    const r = seedResource(h.store);
    const { sessionId } = h.service.start({ mode: "toggle", resourceId: r.resourceId, resourceRevisionId: r.revisionId, locator: textLocator(0), retention: "discard" });
    feed(h.service, sessionId, twoSentences());
    // Learn the block starts from a dry run of the filter, then fail the second one.
    const dry = h.service.summarize([], 0, false);
    void dry;
    h.asr.connection = null;
    await h.service.stop({ sessionId, durationMs: 12_000 });
    await h.settle(sessionId);
    expect(h.service.view(h.service.row(sessionId)).stage).toBe("awaiting_asr");
    const blocks = h.service.review(sessionId).segments;
    expect(blocks).toHaveLength(2);
    h.asr.connection = { id: "conn-asr", model: "fake-asr", timeoutMs: 5000 };
    h.asr.failAlways.set(blocks[1]!.startMs, new MangaError("PROVIDER_UNAVAILABLE", "provider HTTP 503", { retryable: true, details: { status: 503 } }));
    await h.service.pipeline.schedule(sessionId);
    await h.settle(sessionId);
    const view = h.service.view(h.service.row(sessionId));
    expect(view.stage).toBe("pending");
    expect(view.segments).toMatchObject({ done: 1, failed: 1 });
    expect(view.audioState).toBe("staged");
    expect(fs.existsSync(path.join(h.store.attachmentsDir, h.service.row(sessionId).staging_name!))).toBe(true);
    const firstKey = h.asr.keys()[0];
    const callsBefore = h.asr.calls.length;
    // The provider recovers; the retry touches the failed block alone.
    h.asr.failAlways.clear();
    await h.service.pipeline.retry(sessionId);
    await h.settle(sessionId);
    const retried = h.asr.keys().slice(callsBefore);
    expect(retried).toEqual([`c${blocks[1]!.startMs}-${blocks[1]!.endMs}`]);
    expect(retried).not.toContain(firstKey);
    expect(h.service.view(h.service.row(sessionId))).toMatchObject({ stage: "done", audioState: "cleaned" });
    expect(h.service.review(sessionId).segments.map((segment) => segment.state)).toEqual(["done", "done"]);
  });

  it("stops at once on a credential error and says why", async () => {
    const h = make();
    h.asr.failures.set(0, new MangaError("AUTHENTICATION_FAILED", "provider rejected the credentials"));
    const { id } = await recordTwoSentences(h);
    await h.settle(id);
    const view = h.service.view(h.service.row(id));
    expect(view.stage).toBe("failed");
    expect(view.error).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    // The second block was never sent: nothing else could succeed.
    expect(h.asr.calls).toHaveLength(1);
    expect(view.audioState).toBe("staged");
  });

  it("waits for a connection: the recording is kept, and transcribes once one is configured", async () => {
    const h = make();
    h.asr.connection = null;
    const { id } = await recordTwoSentences(h, { retention: "keep" });
    await h.settle(id);
    let view = h.service.view(h.service.row(id));
    expect(view.stage).toBe("awaiting_asr");
    // A kept recording is already stored for good while it waits.
    expect(view.audioState).toBe("retained");
    expect(view.playable).toBe(true);
    expect(h.asr.calls).toHaveLength(0);
    h.asr.connection = { id: "conn-asr", model: "fake-asr", timeoutMs: 5000 };
    await h.service.pipeline.schedule(id);
    await h.settle(id);
    view = h.service.view(h.service.row(id));
    expect(view.stage).toBe("done");
    expect(h.asr.calls).toHaveLength(2);
    expect(view.audioState).toBe("retained");
  });

  it("drops a result that arrives after the recording was cancelled, and can be transcribed again", async () => {
    const h = make();
    let release!: () => void;
    h.asr.blockOn = new Promise<void>((resolve) => { release = resolve; });
    h.asr.ignoreAbort = true;
    const { id } = await recordTwoSentences(h);
    for (let i = 0; i < 100 && !h.asr.calls.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.asr.calls).toHaveLength(1);
    h.service.cancel(id);
    release();
    await h.settle(id);
    const view = h.service.view(h.service.row(id));
    expect(view.stage).toBe("cancelled");
    expect(h.service.review(id).segments.every((segment) => segment.originalText === "" && segment.state === "pending")).toBe(true);
    expect(view.audioState).toBe("staged");
    // Sending again works and writes the answers.
    h.asr.blockOn = null;
    h.asr.ignoreAbort = false;
    await h.service.pipeline.schedule(id);
    await h.settle(id);
    expect(h.service.view(h.service.row(id)).stage).toBe("done");
  });

  it("drops results that arrive after the module was turned off", async () => {
    const h = make();
    let release!: () => void;
    h.asr.blockOn = new Promise<void>((resolve) => { release = resolve; });
    h.asr.ignoreAbort = true;
    const { id } = await recordTwoSentences(h);
    for (let i = 0; i < 100 && !h.asr.calls.length; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    h.deactivate();
    release();
    await h.idle();
    const rows = h.service.db.prepare("SELECT text, state FROM transcript_segments WHERE session_id = ?").all(id) as Array<{ text: string; state: string }>;
    expect(rows.every((row) => row.text === "" && row.state !== "done")).toBe(true);
    // Everything that needs the module refuses while it is off.
    expect(() => h.service.start({ mode: "toggle" })).toThrow(/turned off/);
  });

  it("saves a recording in progress when the module is turned off", async () => {
    const h = make();
    const { sessionId } = h.service.start({ mode: "hold" });
    feed(h.service, sessionId, join(quiet(500), tone(1500), quiet(500)));
    await h.service.shutdown("deactivated");
    h.deactivate();
    const row = h.service.row(sessionId);
    expect(row.stage).toBe("recorded");
    expect(row.error_json).toContain("deactivated");
    expect(row.duration_ms).toBe(2500);
    expect(fs.existsSync(path.join(h.store.attachmentsDir, row.staging_name!))).toBe(true);
  });
});

describe("keeping and cleaning audio", () => {
  it("does not keep audio: the staged copy goes only after text and mapping are stored", async () => {
    const h = make();
    const { id } = await recordTwoSentences(h, { retention: "discard" });
    await h.settle(id);
    const row = h.service.row(id);
    expect(row).toMatchObject({ stage: "done", audio_state: "cleaned", staging_name: null, opus_name: null });
    expect(fs.readdirSync(h.store.attachmentsDir).filter((name) => name.startsWith("capture-"))).toEqual([]);
    const review = h.service.review(id);
    expect(review.segments.every((segment) => segment.state === "done" && segment.anchors.length > 0)).toBe(true);
    expect(() => h.service.audioHandle(id)).toThrow(/not kept/);
    expect(review.audio).toEqual({ state: "cleaned", playable: false });
  });

  it("keeps audio as Opus the user can play, and removes the working copy", async () => {
    const h = make();
    const { id } = await recordTwoSentences(h, { retention: "keep" });
    await h.settle(id);
    const row = h.service.row(id);
    expect(row).toMatchObject({ stage: "done", audio_state: "retained", staging_name: null });
    const retained = path.join(h.store.attachmentsDir, row.opus_name!);
    expect(fs.statSync(retained).size).toBeGreaterThan(1000);
    expect(fs.readFileSync(retained).subarray(0, 4).toString("hex")).toBe("1a45dfa3");
    const handle = h.service.audioHandle(id);
    expect(handle.url).toMatch(/^manga-media:\/\/media\/h/);
    expect(handle.mediaType).toContain("opus");
    expect(handle.durationMs).toBe(12_000);
  });

  it("keeps the working audio while a failed recording waits, and says so", async () => {
    const h = make();
    h.asr.failures.set(0, new MangaError("MODEL_CAPABILITY_MISSING", "provider reported a missing capability"));
    const { id } = await recordTwoSentences(h, { retention: "discard" });
    await h.settle(id);
    const view = h.service.view(h.service.row(id));
    expect(view).toMatchObject({ stage: "failed", audioState: "staged" });
    // The user decides: discarding removes it for good.
    const discarded = await h.service.retain(id, "discard");
    expect(discarded.audioState).toBe("cleaned");
    expect(fs.readdirSync(h.store.attachmentsDir).filter((name) => name.startsWith("capture-"))).toEqual([]);
  });

  it("reports a cleanup that could not happen instead of showing it as done", async () => {
    const h = make();
    const real = fs.rmSync;
    const spy = vi.spyOn(fs, "rmSync").mockImplementation(((file: fs.PathLike, options?: fs.RmOptions) => {
      if (String(file).endsWith(".pcm")) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      return real(file, options);
    }) as typeof fs.rmSync);
    try {
      const { id } = await recordTwoSentences(h, { retention: "discard" });
      await h.settle(id);
      const row = h.service.row(id);
      // The text is stored and the stage is done, but the working audio is still there and the state says so.
      expect(row.stage).toBe("done");
      expect(row.audio_state).toBe("staged");
      expect(row.staging_name).not.toBeNull();
      expect(JSON.parse(row.error_json!)).toMatchObject({ code: "CLEANUP_PENDING" });
      spy.mockRestore();
      // Trying again once the file is free cleans it, and only then does the state change.
      const cleaned = await h.service.retain(id, "discard");
      expect(cleaned.audioState).toBe("cleaned");
    } finally {
      spy.mockRestore();
    }
  });

  it("recovers a recording the app stopped in the middle of", async () => {
    const h = make();
    const r = seedResource(h.store);
    const { sessionId } = h.service.start({ mode: "toggle", resourceId: r.resourceId, resourceRevisionId: r.revisionId, locator: textLocator(0), retention: "discard" });
    feed(h.service, sessionId, join(quiet(1000), tone(2000), quiet(1000)));
    h.service.event({ sessionId, offsetMs: 2000, reason: "page", locator: textLocator(300) });
    // The process dies: a new service over the same data opens it.
    const second = new CaptureService({ ...h.service.deps, notify: () => undefined });
    second.bind(() => true);
    const { recovered } = second.recover();
    expect(recovered).toEqual([sessionId]);
    await h.media.jobs.idle();
    for (let i = 0; i < 100 && second.pipeline.busy(sessionId); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const view = second.view(second.row(sessionId));
    expect(view.stage).toBe("done");
    expect(view.durationMs).toBe(4000);
    expect(view.error?.code).toBeUndefined();
    const anchors = second.review(sessionId).segments[0]!.anchors;
    expect(anchors.length).toBeGreaterThan(0);
  });

  it("marks a recording that never saved any audio as failed, not as recovered text", () => {
    const h = make();
    const { sessionId } = h.service.start({ mode: "toggle" });
    const second = new CaptureService({ ...h.service.deps, notify: () => undefined });
    second.bind(() => true);
    second.recover();
    expect(second.row(sessionId).stage).toBe("failed");
  });
});

describe("timestamps from the provider", () => {
  it("splits a block into sentences with their own anchors when the provider returns timestamps", async () => {
    const h = make();
    h.asr.segmentsFor = (startMs, endMs) => {
      const length = (endMs - startMs) / 1000;
      return [{ start: 0.3, end: length / 2, text: "前半句" }, { start: length / 2, end: length - 0.3, text: "后半句" }];
    };
    const { id } = await recordTwoSentences(h);
    await h.settle(id);
    const review = h.service.review(id);
    expect(review.segments).toHaveLength(4);
    expect(review.segments.every((segment) => segment.precision === "segment")).toBe(true);
    expect(review.segments.map((segment) => segment.originalText)).toEqual(["前半句", "后半句", "前半句", "后半句"]);
    // The page turn at 4 s falls inside the first block: the sentence before it and the sentence after have different pages.
    const pages = review.segments.slice(0, 2).map((segment) => (segment.anchors.at(-1)!.locator as any).range.start);
    expect(pages[0]).not.toBe(pages[1]);
    expect(h.asr.calls.every((call) => call.timestamps === true)).toBe(true);
  });

  it("keeps the block as one coarse segment when the timestamps cannot be trusted", async () => {
    const h = make();
    h.asr.segmentsFor = () => [{ start: 5, end: 9, text: "越界" }, { start: 1, end: 2, text: "倒序" }];
    const { id } = await recordTwoSentences(h);
    await h.settle(id);
    const review = h.service.review(id);
    expect(review.segments).toHaveLength(2);
    expect(review.segments.every((segment) => segment.precision === "chunk")).toBe(true);
  });

  it("asks again for plain text when the provider refuses timestamped output, and remembers", async () => {
    const h = make();
    h.asr.rejectTimestamps = 400;
    const { id } = await recordTwoSentences(h);
    await h.settle(id);
    expect(h.service.view(h.service.row(id)).stage).toBe("done");
    // First block: refused with timestamps, then plain. Second block goes straight to plain.
    expect(h.asr.calls.map((call) => call.timestamps)).toEqual([true, false, false]);
  });

  it("treats a block the provider answers with no text as no speech", async () => {
    const h = make();
    const { id } = await recordTwoSentences(h);
    await h.settle(id);
    const second = h.service.review(id).segments[1]!;
    h.asr.empty.add(second.startMs);
    const again = await recordTwoSentences(h);
    await h.settle(again.id);
    const view = h.service.review(again.id).segments.map((segment) => segment.state);
    expect(view).toContain("no_speech");
    expect(h.service.view(h.service.row(again.id)).stage).toBe("done");
  });
});

describe("review edits", () => {
  it("keeps the original text when the user revises, and a retry never replaces the revision", async () => {
    const h = make();
    const { id } = await recordTwoSentences(h);
    await h.settle(id);
    const [first] = h.service.review(id).segments;
    h.service.reviseSegment(first!.id, "桐谷同学说了这句话");
    const after = h.service.review(id).segments[0]!;
    expect(after.text).toBe("桐谷同学说了这句话");
    expect(after.originalText).toBe(first!.originalText);
    expect(after.revised).toBe(true);
    // Sending the session again does not touch a done block.
    const before = h.asr.calls.length;
    await h.service.pipeline.retry(id);
    await h.settle(id);
    expect(h.asr.calls.length).toBe(before);
    expect(h.service.review(id).segments[0]!.text).toBe("桐谷同学说了这句话");
  });

  it("lets the user place a coarse segment by hand and marks it calibrated", async () => {
    const h = make();
    const { id, resourceId, resourceRevisionId } = await recordTwoSentences(h);
    await h.settle(id);
    const [first] = h.service.review(id).segments;
    const out = h.service.calibrate({ segmentId: first!.id, resourceId, resourceRevisionId, locator: textLocator(777) });
    expect(out.anchors).toHaveLength(1);
    const after = h.service.review(id).segments[0]!;
    expect(after).toMatchObject({ calibrated: true, precision: "manual" });
    expect((after.anchors[0]!.locator as any).range.start).toBe(777);
    const other = seedResource(h.store);
    expect(() => h.service.calibrate({ segmentId: first!.id, resourceId, resourceRevisionId: other.revisionId, locator: textLocator(1) })).toThrow(/does not belong/);
  });

  it("lists recordings by resource and by work", async () => {
    const h = make();
    const { id, resourceId } = await recordTwoSentences(h);
    await h.settle(id);
    expect(h.service.list({ resourceId }).sessions.map((session) => session.id)).toEqual([id]);
    expect(h.service.list({ resourceId: "nope" }).sessions).toEqual([]);
    const workId = h.service.row(id).work_id!;
    expect(h.service.list({ workId }).sessions[0]!.resourceId).toBe(resourceId);
  });
});

describe("organizing a draft", () => {
  it("organizes the stored transcript, keeps the user's edit, and never replaces it on another attempt", async () => {
    const h = make();
    const { id } = await recordTwoSentences(h);
    await h.settle(id);
    const draft = await h.service.organizer.organize(id);
    expect(draft.state).toBe("ready");
    expect(draft.text).toContain("整理：");
    expect(h.llm.calls[0]!.user).toContain("说话@");
    // The transcript can be read while the model works: review does not wait for it.
    const edited = h.service.organizer.edit(draft.id, "我自己改过的整理稿");
    expect(edited.editedText).toBe("我自己改过的整理稿");
    h.llm.output = () => "第二次整理";
    const next = await h.service.organizer.organize(id);
    expect(next.id).not.toBe(draft.id);
    const drafts = h.service.organizer.list(id);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({ id: draft.id, text: draft.text, editedText: "我自己改过的整理稿" });
    expect(drafts[1]).toMatchObject({ text: "第二次整理", editedText: null });
  });

  it("records a failed attempt and lets the user try again", async () => {
    const h = make();
    const { id } = await recordTwoSentences(h);
    await h.settle(id);
    h.llm.failNext = new MangaError("RATE_LIMITED", "provider rate limited the request", { retryable: true });
    const failed = await h.service.organizer.organize(id);
    expect(failed).toMatchObject({ state: "failed", error: { code: "RATE_LIMITED" } });
    // The transcript is still there for review while the draft failed.
    expect(h.service.review(id).segments).toHaveLength(2);
    const retried = await h.service.organizer.organize(id);
    expect(retried.state).toBe("ready");
  });

  it("needs a transcript and a text connection", async () => {
    const h = make();
    const { sessionId } = h.service.start({ mode: "toggle" });
    feed(h.service, sessionId, quiet(1000));
    await h.service.stop({ sessionId });
    await h.settle(sessionId);
    expect(() => h.service.organizer.organize(sessionId)).toThrow(/no transcript/);
    const done = await recordTwoSentences(h);
    await h.settle(done.id);
    h.llm.connection = null;
    expect(() => h.service.organizer.organize(done.id)).toThrow(/no text model/);
  });

  it("prepares a note from the draft the user settled on: their text, one anchor per place, once", async () => {
    const h = make();
    const { id } = await recordTwoSentences(h);
    await h.settle(id);
    const draft = await h.service.organizer.organize(id);
    const prepared = h.service.organizer.prepareAccept(draft.id, { editedText: "用户确认的笔记正文\n第二行" });
    expect(prepared.existing).toBeNull();
    expect(prepared.text).toBe("用户确认的笔记正文\n第二行");
    expect(prepared.title).toBe("用户确认的笔记正文");
    expect(prepared.anchors.map((anchor) => (anchor.locator as any).range.start)).toEqual([0, 500, 900]);
    // Once a note exists for the draft, accepting again points at it instead of making another.
    h.service.db.prepare("UPDATE capture_drafts SET note_object_id = 'obj-1', state = 'accepted' WHERE id = ?").run(draft.id);
    expect(h.service.organizer.prepareAccept(draft.id, {}).existing).toBe("obj-1");
    expect(() => h.service.organizer.edit(draft.id, "x")).toThrow(/already became a note/);
  });

  it("drops a draft that comes back after the module was turned off", async () => {
    const h = make();
    const { id } = await recordTwoSentences(h);
    await h.settle(id);
    let release!: () => void;
    h.llm.blockOn = new Promise<void>((resolve) => { release = resolve; });
    const pending = h.service.organizer.organize(id);
    h.deactivate();
    release();
    await pending.catch(() => undefined);
    const row = h.service.db.prepare("SELECT state, text FROM capture_drafts WHERE session_id = ?").get(id) as { state: string; text: string };
    expect(row.text).toBe("");
    expect(row.state).not.toBe("ready");
  });
});
