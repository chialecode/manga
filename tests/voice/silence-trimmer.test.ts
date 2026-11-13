import { describe, expect, it } from "vitest";
import type { VadEngine } from "../../packages/app-core/src/voice/vad-client.ts";
import { VAD_FRAME_MS, VAD_FRAME_SAMPLES, VAD_SAMPLE_RATE } from "../../packages/app-core/src/voice/vad-segmenter.ts";
import {
  GTCRN_DRY_MIX,
  GTCRN_WET_MIX,
  TRIM_COMPRESSED_PAUSE_MS,
  TRIM_PAD_MS,
  mixGtcrnAudio,
  trimSilence,
} from "../../packages/app-core/src/voice/silence-trimmer.ts";

function makeSineSpeechAndProbs(
  totalMs: number,
  voicedRangesMs: ReadonlyArray<{ startMs: number; endMs: number; amplitude?: number; clipRatio?: number }>,
): { samples: Float32Array; probabilities: Float32Array } {
  const totalSamples = Math.round((totalMs * VAD_SAMPLE_RATE) / 1000);
  const samples = new Float32Array(totalSamples);
  const totalFrames = Math.ceil(totalSamples / VAD_FRAME_SAMPLES);
  const probabilities = new Float32Array(totalFrames);

  for (const range of voicedRangesMs) {
    const amp = range.amplitude ?? 0.25;
    const fromSample = Math.max(0, Math.round((range.startMs * VAD_SAMPLE_RATE) / 1000));
    const toSample = Math.min(totalSamples, Math.round((range.endMs * VAD_SAMPLE_RATE) / 1000));
    const len = Math.max(0, toSample - fromSample);
    const clipCount = range.clipRatio ? Math.ceil(len * range.clipRatio) : 0;

    for (let i = 0; i < len; i += 1) {
      if (i < clipCount) {
        samples[fromSample + i] = i % 2 === 0 ? 1.0 : -1.0;
      } else {
        samples[fromSample + i] = amp * Math.sin((2 * Math.PI * 220 * i) / VAD_SAMPLE_RATE);
      }
    }

    const fromFrame = Math.floor(range.startMs / VAD_FRAME_MS);
    const toFrame = Math.ceil(range.endMs / VAD_FRAME_MS);
    for (let f = Math.max(0, fromFrame); f < Math.min(totalFrames, toFrame); f += 1) {
      probabilities[f] = 0.92;
    }
  }

  return { samples, probabilities };
}

describe("voice silence trimmer, audio diagnostics, and GTCRN wet/dry mix", () => {
  it("returns status: no_speech on empty audio, pure silence, and transient noise clicks (< 250 ms)", async () => {
    const emptyRes = await trimSilence(new Float32Array(0), { probabilities: [] });
    expect(emptyRes.status).toBe("no_speech");
    expect(emptyRes.samples.length).toBe(0);
    expect(emptyRes.wavBuffer.byteLength).toBe(0);

    const silent = makeSineSpeechAndProbs(4_000, []);
    const silentRes = await trimSilence(silent.samples, { probabilities: silent.probabilities });
    expect(silentRes.status).toBe("no_speech");
    expect(silentRes.outputDurationMs).toBe(0);
    expect(silentRes.warnings).toEqual([]);

    // 128 ms transient keyboard click (< 250 ms minSpeechMs) is rejected as non-speech
    const click = makeSineSpeechAndProbs(2_000, [{ startMs: 500, endMs: 628, amplitude: 0.8 }]);
    const clickRes = await trimSilence(click.samples, { probabilities: click.probabilities });
    expect(clickRes.status).toBe("no_speech");
    expect(clickRes.samples.length).toBe(0);
  });

  it("pads 300 ms around outer speech boundaries and clamps cleanly to [0, totalMs]", async () => {
    // 960 ms .. 1920 ms (aligned to 32 ms VAD frames: frame 30..60 = 960 ms speech) inside 4000 ms recording
    const mid = makeSineSpeechAndProbs(4_000, [{ startMs: 960, endMs: 1_920 }]);
    const midRes = await trimSilence(mid.samples, { probabilities: mid.probabilities });
    expect(midRes.status).toBe("speech");
    expect(midRes.speechDurationMs).toBe(960);
    expect(midRes.outputDurationMs).toBe(960 + 2 * TRIM_PAD_MS);
    expect(midRes.wavBuffer.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(midRes.wavBuffer.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(midRes.wavBuffer.byteLength).toBe(44 + midRes.samples.length * 2);

    // Speech starting at 0 ms and ending at recording end (960 ms) clamps without out-of-bounds padding
    const edge = makeSineSpeechAndProbs(960, [{ startMs: 0, endMs: 960 }]);
    const edgeRes = await trimSilence(edge.samples, { probabilities: edge.probabilities });
    expect(edgeRes.status).toBe("speech");
    expect(edgeRes.outputDurationMs).toBe(960);
  });

  it("keeps pauses <= 1000 ms intact and compresses pauses > 1000 ms down to 400 ms", async () => {
    // Short pause: 960..1920 ms and 2720..3680 ms -> pause = 800 ms (<= 1000 ms)
    const shortPause = makeSineSpeechAndProbs(5_000, [
      { startMs: 960, endMs: 1_920 },
      { startMs: 2_720, endMs: 3_680 },
    ]);
    const shortRes = await trimSilence(shortPause.samples, { probabilities: shortPause.probabilities });
    expect(shortRes.status).toBe("speech");
    // 300 (left pad) + 960 (speech 1) + 800 (untouched pause) + 960 (speech 2) + 300 (right pad) = 3320 ms
    expect(shortRes.outputDurationMs).toBe(3_320);

    // Long pause: 960..1920 ms and 5120..6080 ms -> pause = 3200 ms (> 1000 ms) -> compressed to 400 ms
    const longPause = makeSineSpeechAndProbs(8_000, [
      { startMs: 960, endMs: 1_920 },
      { startMs: 5_120, endMs: 6_080 },
    ]);
    const longRes = await trimSilence(longPause.samples, { probabilities: longPause.probabilities });
    expect(longRes.status).toBe("speech");
    // 300 (left pad) + 960 (speech 1) + 400 (compressed pause) + 960 (speech 2) + 300 (right pad) = 2920 ms
    expect(longRes.outputDurationMs).toBe(
      TRIM_PAD_MS + 960 + TRIM_COMPRESSED_PAUSE_MS + 960 + TRIM_PAD_MS,
    );
  });

  it("computes low_volume (< -30 dBFS) and clipping (>= 1% full scale) warnings on speech frames without blocking", async () => {
    // Amplitude 0.01 = -40 dBFS (< -30 dBFS) -> low_volume
    const quiet = makeSineSpeechAndProbs(3_000, [{ startMs: 640, endMs: 1_600, amplitude: 0.01 }]);
    const quietRes = await trimSilence(quiet.samples, { probabilities: quiet.probabilities });
    expect(quietRes.status).toBe("speech");
    expect(quietRes.warnings).toEqual(["low_volume"]);
    expect(quietRes.diagnostics.peakDbfs).toBeLessThan(-30);
    expect(quietRes.samples.length).toBeGreaterThan(0);

    // 1.5% clipped samples inside speech inside a 10-second recording (where overall buffer ratio would be < 0.2%)
    const clipped = makeSineSpeechAndProbs(10_000, [
      { startMs: 960, endMs: 1_920, amplitude: 0.5, clipRatio: 0.015 },
    ]);
    const clippedRes = await trimSilence(clipped.samples, { probabilities: clipped.probabilities });
    expect(clippedRes.status).toBe("speech");
    expect(clippedRes.warnings).toEqual(["clipping"]);
    expect(clippedRes.diagnostics.clippedRatio).toBeGreaterThanOrEqual(0.01);

    // Healthy speech (-12 dBFS, 0% clipped) -> zero warnings
    const healthy = makeSineSpeechAndProbs(3_000, [{ startMs: 640, endMs: 1_600, amplitude: 0.25 }]);
    const healthyRes = await trimSilence(healthy.samples, { probabilities: healthy.probabilities });
    expect(healthyRes.status).toBe("speech");
    expect(healthyRes.warnings).toEqual([]);
  });

  it("streams Int16/WAV inputs through a VadEngine instance and closes the stream cleanly", async () => {
    const audio = makeSineSpeechAndProbs(2_100, [{ startMs: 640, endMs: 1_600, amplitude: 0.3 }]);
    let closed = false;
    const fakeVad: VadEngine = {
      available: true,
      open() {
        const buffer: number[] = [];
        return {
          async push(pcm) {
            for (let i = 0; i < pcm.length; i += 1) buffer.push(pcm[i]!);
            const out: number[] = [];
            while (buffer.length >= VAD_FRAME_SAMPLES) {
              const frame = buffer.splice(0, VAD_FRAME_SAMPLES);
              let energy = 0;
              for (const v of frame) energy += Math.abs(v);
              out.push(energy / frame.length > 500 ? 0.9 : 0.05);
            }
            return Float32Array.from(out);
          },
          close() {
            closed = true;
          },
        };
      },
      analyzeFile: async () => new Float32Array(0),
      dispose() {},
    };

    const res = await trimSilence(audio.samples, { vad: fakeVad });
    expect(closed).toBe(true);
    expect(res.status).toBe("speech");
    expect(res.outputDurationMs).toBeGreaterThan(900);
  });

  it("exports GTCRN_WET_MIX = 0.75 and blends 0.75 * denoised + 0.25 * raw accurately", () => {
    expect(GTCRN_WET_MIX).toBe(0.75);
    expect(GTCRN_DRY_MIX).toBe(0.25);

    const raw = new Float32Array([0.8, -0.4, 0.2, 1.5]);
    const denoised = new Float32Array([0.4, -0.8, 0.2, 1.0]);
    const mixed = mixGtcrnAudio(raw, denoised);

    expect(mixed).toHaveLength(4);
    expect(mixed[0]).toBeCloseTo(0.75 * 0.4 + 0.25 * 0.8, 6);
    expect(mixed[1]).toBeCloseTo(0.75 * -0.8 + 0.25 * -0.4, 6);
    expect(mixed[2]).toBeCloseTo(0.2, 6);
    expect(mixed[3]).toBe(1.0); // clamped to [-1, 1]
  });
});
