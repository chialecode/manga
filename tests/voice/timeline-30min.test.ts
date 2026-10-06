import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SegmentAnchor, SourceLocator } from "@manga/contracts";
import { VadWorkerClient, locateVadAssets } from "../../packages/app-core/src/voice/vad-client.ts";
import { requireSamples, samplePath } from "../helpers/samples.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";
import { seedResource, voiceHarness, type Harness } from "../helpers/voice.ts";

requireSamples(["voice-recording-30min"]);

const SEC = 1000;
type Truth = { events: Array<{ start: number; end: number; kind: string }> };

/**
 * A scripted 30-minute reading session laid over the synthetic recording: a novel with page turns and selections, two
 * comic chapters, two episodes of an anime with a pause, a speed change and a seek, and a return to the novel. The script
 * is the single source of truth: events are generated from it, and the expected anchors of every transcribed block are
 * computed from it directly, not through the product's mapper.
 */
type Resource = { resourceId: string; revisionId: string };
type Place =
  | { from: number; to: number; resource: Resource; locator: SourceLocator }
  | { from: number; to: number; resource: Resource; video: Array<{ from: number; to: number; rate: number; playing: boolean }>; sourceAtStart: number };

function srcAt(place: Extract<Place, { video: unknown }>, t: number): number {
  let src = place.sourceAtStart;
  for (const phase of place.video) {
    const upto = Math.min(t, phase.to);
    if (upto > phase.from && phase.playing) src += (upto - phase.from) * phase.rate;
    if (t <= phase.to) break;
  }
  return src;
}

const text = (start: number): SourceLocator => ({ kind: "text", partId: "p1", representationId: "r1", normalizationVersion: "text-nfc-lf-v1", range: { start, end: start + 12 } });
const image = (id: string): SourceLocator => ({ kind: "image", pageId: id });

describe.skipIf(mediaPrerequisitesAbsent)("a 30-minute reading session mapped to its sources", () => {
  let h: Harness;
  let vad: VadWorkerClient;
  let sessionId = "";
  let places: Place[] = [];
  let truth: Truth;
  const assets = locateVadAssets();
  const durationMs = 1800 * SEC;

  beforeAll(async () => {
    expect(assets, "voice filter assets are installed: node scripts/tools/fetch-silero-vad.mjs").not.toBeNull();
    vad = new VadWorkerClient({ assets });
    h = voiceHarness({ vad });
    const novel = seedResource(h.store, { kind: "novel", title: "长篇小说" });
    const comic1 = seedResource(h.store, { kind: "comic", title: "漫画第一话", workId: undefined });
    const comic2 = seedResource(h.store, { kind: "comic", title: "漫画第二话" });
    const video1 = seedResource(h.store, { kind: "video", title: "动画第一集" });
    const video2 = seedResource(h.store, { kind: "video", title: "动画第二集" });
    const R = (item: { resourceId: string; revisionId: string }): Resource => ({ resourceId: item.resourceId, revisionId: item.revisionId });
    places = [];
    const events: Array<{ at: number; reason: string; resource?: Resource; locator?: SourceLocator; playing?: boolean; rate?: number }> = [];
    const place = (p: Place) => places.push(p);

    // Novel, 0-300 s: a page turn every 60 s and a selection every 25 s, as two interleaved streams of position changes.
    const novelMoves = new Map<number, SourceLocator>();
    for (let t = 0; t < 300; t += 60) novelMoves.set(t, text(t * 10));
    for (let t = 25; t < 300; t += 25) novelMoves.set(t, text(5000 + t));
    const novelTimes = [...novelMoves.keys()].sort((a, b) => a - b);
    novelTimes.forEach((t, index) => {
      const to = (novelTimes[index + 1] ?? 300) * SEC;
      place({ from: t * SEC, to, resource: R(novel), locator: novelMoves.get(t)! });
      events.push({ at: t * SEC, reason: t === 0 ? "start" : "selection", resource: t === 0 ? R(novel) : undefined, locator: novelMoves.get(t)! });
    });

    // Comic chapter 1, 300-450 s: a page every 20 s. Chapter 2 from 450 s: a page every 25 s to 600 s.
    for (let t = 300, k = 1; t < 450; t += 20, k += 1) {
      const to = Math.min(450, t + 20) * SEC;
      place({ from: t * SEC, to, resource: R(comic1), locator: image(`c1-p${k}`) });
      events.push({ at: t * SEC, reason: t === 300 ? "resource_change" : "page", resource: t === 300 ? R(comic1) : undefined, locator: image(`c1-p${k}`) });
    }
    for (let t = 450, k = 1; t < 600; t += 25, k += 1) {
      place({ from: t * SEC, to: Math.min(600, t + 25) * SEC, resource: R(comic2), locator: image(`c2-p${k}`) });
      events.push({ at: t * SEC, reason: t === 450 ? "resource_change" : "page", resource: t === 450 ? R(comic2) : undefined, locator: image(`c2-p${k}`) });
    }

    // Episode 1, 600-1300 s: 1x from 1000 s of the file, paused 700-740 s, 2x from 900 s, a seek back to 200 s at 1000 s.
    const stretchA: Place = { from: 600 * SEC, to: 1000 * SEC, resource: R(video1), sourceAtStart: 1_000_000, video: [
      { from: 600 * SEC, to: 700 * SEC, rate: 1, playing: true },
      { from: 700 * SEC, to: 740 * SEC, rate: 1, playing: false },
      { from: 740 * SEC, to: 900 * SEC, rate: 1, playing: true },
      { from: 900 * SEC, to: 1000 * SEC, rate: 2, playing: true },
    ] };
    const stretchB: Place = { from: 1000 * SEC, to: 1300 * SEC, resource: R(video1), sourceAtStart: 200_000, video: [{ from: 1000 * SEC, to: 1300 * SEC, rate: 2, playing: true }] };
    const stretchC: Place = { from: 1300 * SEC, to: 1500 * SEC, resource: R(video2), sourceAtStart: 0, video: [{ from: 1300 * SEC, to: 1500 * SEC, rate: 2, playing: true }] };
    place(stretchA); place(stretchB); place(stretchC);
    const temporal = (ms: number): SourceLocator => ({ kind: "temporal", startMs: ms });
    events.push({ at: 600 * SEC, reason: "resource_change", resource: R(video1), locator: temporal(1_000_000), playing: true, rate: 1 });
    events.push({ at: 700 * SEC, reason: "pause" });
    events.push({ at: 740 * SEC, reason: "resume" });
    events.push({ at: 900 * SEC, reason: "rate_change", rate: 2 });
    events.push({ at: 1000 * SEC, reason: "seek", locator: temporal(200_000), playing: true });
    events.push({ at: 1300 * SEC, reason: "resource_change", resource: R(video2), locator: temporal(0), playing: true, rate: 2 });
    // The player reports where it is every 5 s; with a correct prediction these must not split anything.
    for (let t = 605; t < 1500; t += 5) {
      const stretch = [stretchA, stretchB, stretchC].find((item) => t * SEC >= item.from && t * SEC < item.to)! as Extract<Place, { video: unknown }>;
      if (t * SEC === 700 * SEC || t * SEC === 740 * SEC || t * SEC === 900 * SEC || t * SEC === 1000 * SEC || t * SEC === 1300 * SEC) continue;
      events.push({ at: t * SEC, reason: "sample", locator: temporal(srcAt(stretch, t * SEC)), playing: stretch.video.find((phase) => t * SEC >= phase.from && t * SEC < phase.to)!.playing });
    }

    // Back to the novel, 1500-1800 s, on a place it has not been.
    place({ from: 1500 * SEC, to: 1650 * SEC, resource: R(novel), locator: text(40_000) });
    place({ from: 1650 * SEC, to: durationMs, resource: R(novel), locator: text(40_900) });
    events.push({ at: 1500 * SEC, reason: "resource_change", resource: R(novel), locator: text(40_000) });
    events.push({ at: 1650 * SEC, reason: "selection", locator: text(40_900) });

    const started = h.service.start({ mode: "toggle", resourceId: novel.resourceId, resourceRevisionId: novel.revisionId, locator: text(0), retention: "discard" });
    sessionId = started.sessionId;
    // Play the recording into the service as the renderer would, with the script's events at their offsets.
    const wav = fs.readFileSync(samplePath("voice-recording-30min", "recording.wav"));
    const pcm = wav.subarray(44);
    expect(pcm.length / 32).toBe(durationMs);
    const ordered = events.filter((event) => event.reason !== "start").sort((a, b) => a.at - b.at);
    let next = 0;
    let seq = 0;
    const chunk = 3200;
    for (let at = 0; at < pcm.length; at += chunk) {
      const ms = Math.round(at / 32);
      while (next < ordered.length && ordered[next]!.at <= ms) {
        const event = ordered[next]!;
        h.service.event({ sessionId, offsetMs: event.at, reason: event.reason as never, resourceId: event.resource?.resourceId, resourceRevisionId: event.resource?.revisionId, locator: event.locator, playing: event.playing, playbackRate: event.rate });
        next += 1;
      }
      h.service.append(sessionId, seq, pcm.subarray(at, Math.min(pcm.length, at + chunk)).toString("base64"));
      seq += 1;
      // The live filter keeps up with real time; the test feeds faster, so it waits every minute of audio.
      if (seq % 600 === 0) await h.service.drainFilter(sessionId);
    }
    h.asr.delayMs = 2;
    await h.service.stop({ sessionId, durationMs });
    await h.settle(sessionId);
    truth = JSON.parse(fs.readFileSync(samplePath("voice-recording-30min", "truth.json"), "utf8")) as Truth;
  }, 300_000);

  afterAll(() => {
    vad?.dispose();
    h?.close();
  });

  const placeAt = (t: number) => places.find((item) => t >= item.from && t < item.to)!;

  it("filtered the recording live and uploaded only blocks of speech, each within the block limit", () => {
    const view = h.service.view(h.service.row(sessionId));
    expect(view.stage).toBe("done");
    expect(h.service.vad(sessionId)!.analyzedFull).toBe(false);
    const blocks = h.service.review(sessionId).segments;
    expect(blocks.length).toBeGreaterThan(60);
    expect(blocks.every((block) => block.endMs - block.startMs <= 30_000)).toBe(true);
    // Nothing was sent twice, and what was sent is a small part of the recording.
    expect(new Set(h.asr.keys()).size).toBe(h.asr.keys().length);
    const sent = blocks.reduce((sum, block) => sum + (block.endMs - block.startMs), 0);
    expect(sent).toBeLessThan(durationMs * 0.6);
  });

  it("covers every spoken sentence, so no silence filtered before it moves its position", () => {
    const blocks = h.service.review(sessionId).segments;
    const sentences = truth.events.filter((event) => event.kind === "speech");
    let uncovered = 0;
    for (const sentence of sentences) {
      const from = sentence.start * SEC;
      const to = sentence.end * SEC;
      const covered = blocks.reduce((sum, block) => sum + Math.max(0, Math.min(block.endMs, to) - Math.max(block.startMs, from)), 0);
      if (covered / (to - from) < 0.9) uncovered += 1;
    }
    expect(sentences).toHaveLength(111);
    expect(uncovered).toBeLessThanOrEqual(1);
  });

  it("gives every block anchors that cover it exactly and match the script's place for every moment", () => {
    const blocks = h.service.review(sessionId).segments.filter((block) => block.state === "done");
    let checked = 0;
    let maxVideoErrorMs = 0;
    let splits = 0;
    for (const block of blocks) {
      // Expected pieces: the script's continuous places inside this block.
      const expected: Array<{ from: number; to: number; place: Place }> = [];
      for (const item of places) {
        const from = Math.max(block.startMs, item.from);
        const to = Math.min(block.endMs, item.to);
        if (to > from) expected.push({ from, to, place: item });
      }
      // Neighbouring places that are one continuous stretch (two novel selections are not) stay separate; a place equals an anchor.
      expect(block.anchors.length).toBe(expected.length);
      block.anchors.forEach((anchor: SegmentAnchor, index: number) => {
        const piece = expected[index]!;
        expect([anchor.startMs, anchor.endMs]).toEqual([piece.from, piece.to]);
        expect(anchor.resourceId).toBe(piece.place.resource.resourceId);
        expect(anchor.resourceRevisionId).toBe(piece.place.resource.revisionId);
        if ("video" in piece.place) {
          const locator = anchor.locator as Extract<SourceLocator, { kind: "temporal" }>;
          expect(locator.kind).toBe("temporal");
          const wantStart = srcAt(piece.place, piece.from);
          const wantEnd = srcAt(piece.place, piece.to);
          maxVideoErrorMs = Math.max(maxVideoErrorMs, Math.abs(locator.startMs - wantStart), Math.abs((locator.endMs ?? locator.startMs) - wantEnd));
        } else {
          expect(anchor.locator).toEqual(piece.place.locator);
        }
        checked += 1;
      });
      splits += Math.max(0, expected.length - 1);
    }
    expect(checked).toBeGreaterThan(blocks.length);
    expect(splits).toBeGreaterThan(5);
    // Rounding to whole milliseconds is the only error allowed in the mapping itself.
    expect(maxVideoErrorMs).toBeLessThanOrEqual(1);
    writeReport({ blocks: blocks.length, anchors: checked, blocksSpanningSeveralPlaces: blocks.filter((block) => block.anchors.length > 1).length, maxVideoErrorMs });
  });

  it("keeps a block that spans a pause as one anchor over the video time it actually covered, and splits at a seek", () => {
    const blocks = h.service.review(sessionId).segments;
    const duringPause = blocks.filter((block) => block.startMs >= 700 * SEC && block.endMs <= 740 * SEC);
    for (const block of duringPause) {
      expect(block.anchors).toHaveLength(1);
      const locator = block.anchors[0]!.locator as Extract<SourceLocator, { kind: "temporal" }>;
      expect(locator.startMs).toBe(locator.endMs);
      expect(locator.startMs).toBe(1_100_000);
    }
    const atSeek = blocks.find((block) => block.startMs < 1000 * SEC && block.endMs > 1000 * SEC);
    if (atSeek) {
      expect(atSeek.anchors.length).toBe(2);
      expect((atSeek.anchors[1]!.locator as { startMs: number }).startMs).toBe(200_000);
    }
  });

  it("cleaned the working audio only after every block and its anchors were stored", () => {
    const row = h.service.row(sessionId);
    expect(row).toMatchObject({ stage: "done", audio_state: "cleaned", staging_name: null });
    const rows = h.service.db.prepare("SELECT state, anchors_json FROM transcript_segments WHERE session_id = ?").all(sessionId) as Array<{ state: string; anchors_json: string }>;
    expect(rows.every((item) => item.state === "done" && JSON.parse(item.anchors_json).length > 0)).toBe(true);
    expect(fs.readdirSync(h.store.attachmentsDir).filter((name) => name.startsWith("capture-"))).toEqual([]);
    expect(placeAt(10 * SEC)).toBeDefined();
  });
});

function writeReport(report: Record<string, unknown>): void {
  const dir = process.env.MANGA_EVIDENCE_DIR;
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "voice-mapping.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), scope: "script-driven 30-minute timeline; capture-clock mapping only, device capture latency excluded", ...report }, null, 2)}\n`);
}
