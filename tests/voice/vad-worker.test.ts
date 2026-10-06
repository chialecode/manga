import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VadWorkerClient, locateVadAssets } from "../../packages/app-core/src/voice/vad-client.ts";
import { VAD_FRAME_SAMPLES, segmentRecording } from "../../packages/app-core/src/voice/vad-segmenter.ts";
import { requireSamples, samplePath } from "../helpers/samples.ts";

requireSamples(["voice-recording-30min", "voice-no-speech"]);
const assets = locateVadAssets();

type Truth = { events: Array<{ start: number; end: number; kind: string }> };

function pcmFromWav(wav: string, target: string): number {
  const bytes = fs.readFileSync(wav);
  fs.writeFileSync(target, bytes.subarray(44));
  return bytes.length - 44;
}

describe("Silero VAD worker on the synthetic recordings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-vad-"));
  const client = new VadWorkerClient({ assets });
  const long = path.join(dir, "long.pcm");
  const silent = path.join(dir, "silent.pcm");
  let longBytes = 0;
  let longProbs: Float32Array;
  let analysisMs = 0;

  beforeAll(async () => {
    expect(assets, "model and runtime must be installed: node scripts/tools/fetch-silero-vad.mjs").not.toBeNull();
    expect(client.available).toBe(true);
    longBytes = pcmFromWav(samplePath("voice-recording-30min", "recording.wav"), long);
    pcmFromWav(samplePath("voice-no-speech", "recording.wav"), silent);
    const started = Date.now();
    longProbs = await client.analyzeFile(long);
    analysisMs = Date.now() - started;
  }, 180_000);

  afterAll(() => {
    client.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("gives one probability per frame for the whole recording, faster than real time", () => {
    expect(longProbs.length).toBe(Math.floor(longBytes / 2 / VAD_FRAME_SAMPLES));
    const seconds = longBytes / 2 / 16_000;
    expect(seconds).toBeCloseTo(1800, 0);
    expect(seconds / (analysisMs / 1000)).toBeGreaterThan(5);
  });

  it("finds the spoken sentences between silence, music and noise and keeps non-speech out", () => {
    const truth = JSON.parse(fs.readFileSync(samplePath("voice-recording-30min", "truth.json"), "utf8")) as Truth;
    const speech = truth.events.filter((event) => event.kind === "speech");
    const totalMs = Math.round((longBytes / 2 / 16_000) * 1000);
    const segments = segmentRecording(longProbs, totalMs);
    let found = 0;
    for (const event of speech) {
      const overlap = segments.reduce((sum, segment) => sum + Math.max(0, Math.min(segment.endMs, event.end * 1000) - Math.max(segment.startMs, event.start * 1000)), 0);
      if (overlap / ((event.end - event.start) * 1000) >= 0.9) found += 1;
    }
    expect(speech.length).toBe(111);
    expect(found).toBeGreaterThanOrEqual(110);
    // Time the filter kept that is not speech, margins aside: noise or music let through.
    const anySpeech = truth.events.filter((event) => event.kind === "speech" || event.kind === "speech-over-music");
    let wrongMs = 0;
    for (const segment of segments) {
      const covered = anySpeech.reduce((sum, event) => sum + Math.max(0, Math.min(segment.speechEndMs, event.end * 1000) - Math.max(segment.speechStartMs, event.start * 1000)), 0);
      wrongMs += Math.max(0, segment.speechEndMs - segment.speechStartMs - covered);
    }
    expect(wrongMs).toBeLessThan(30_000);
    expect(segments.length).toBeGreaterThan(100);
  });

  it("finds no speech in a recording of silence and noise", async () => {
    const probs = await client.analyzeFile(silent);
    expect(segmentRecording(probs, 300_000)).toEqual([]);
  }, 60_000);

  it("filters incrementally to the same numbers as a pass over the file", async () => {
    const stream = client.open();
    const bytes = fs.readFileSync(long).subarray(0, 16_000 * 2 * 60);
    const all: number[] = [];
    const block = 1600;
    for (let at = 0; at < bytes.length; at += block * 2) {
      const piece = bytes.subarray(at, Math.min(bytes.length, at + block * 2));
      const samples = new Int16Array(piece.length / 2);
      for (let i = 0; i < samples.length; i += 1) samples[i] = piece.readInt16LE(i * 2);
      all.push(...await stream.push(samples));
    }
    stream.close();
    expect(all.length).toBe(Math.floor(bytes.length / 2 / VAD_FRAME_SAMPLES));
    for (let i = 0; i < all.length; i += 1) expect(Math.abs(all[i]! - longProbs[i]!)).toBeLessThan(1e-4);
  }, 60_000);

  it("tells a stream that its worker was replaced, so the caller can run a full pass", async () => {
    const stream = client.open();
    await stream.push(new Int16Array(1024));
    const other = new VadWorkerClient({ assets });
    other.dispose();
    client.dispose();
    await expect(stream.push(new Int16Array(1024))).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    // The next use starts a fresh worker.
    const fresh = client.open();
    const probs = await fresh.push(new Int16Array(2048));
    expect(probs.length).toBe(4);
    fresh.close();
  }, 60_000);

  it("stops a pass when asked", async () => {
    const controller = new AbortController();
    const run = client.analyzeFile(long, { signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    await expect(run).rejects.toMatchObject({ code: "CANCELLED" });
  }, 60_000);

  it("reports a missing model instead of throwing at construction", () => {
    const none = new VadWorkerClient({ assets: null });
    expect(none.available).toBe(false);
    expect(none.unavailableReason).toMatch(/model/);
    expect(() => none.open()).not.toThrow();
  });
});
