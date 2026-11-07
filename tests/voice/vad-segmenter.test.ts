import { describe, expect, it } from "vitest";
import { DEFAULT_VAD_CONFIG, VAD_FRAME_MS, VadSegmenter, segmentRecording } from "../../packages/app-core/src/voice/vad-segmenter.ts";

const run = (parts: Array<[number, number]>): number[] => parts.flatMap(([count, probability]) => Array.from({ length: count }, () => probability));
const total = (probabilities: number[]) => Math.round(probabilities.length * VAD_FRAME_MS);

describe("VAD segmenter", () => {
  it("wraps one burst of speech in a margin on both sides", () => {
    const probabilities = run([[63, 0.02], [31, 0.95], [40, 0.02]]);
    const segments = segmentRecording(probabilities, total(probabilities));
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ speechStartMs: 2016, speechEndMs: 3008, startMs: 1716, endMs: 3308, id: "vs-1716-3308" });
  });

  it("ignores a blip shorter than the minimum speech length", () => {
    const probabilities = run([[40, 0.01], [5, 0.9], [60, 0.01]]);
    expect(segmentRecording(probabilities, total(probabilities))).toEqual([]);
  });

  it("returns nothing for silence and for noise below the threshold", () => {
    const probabilities = run([[500, 0.01], [500, 0.3]]);
    expect(segmentRecording(probabilities, total(probabilities))).toEqual([]);
  });

  it("clamps the margins to the recording on both ends", () => {
    const probabilities = run([[3, 0.01], [40, 0.9]]);
    const [segment] = segmentRecording(probabilities, total(probabilities));
    expect(segment!.startMs).toBe(0);
    expect(segment!.endMs).toBe(total(probabilities));
  });

  it("keeps the speech open through scores between the release and start thresholds", () => {
    const probabilities = run([[10, 0.01], [10, 0.9], [20, 0.4], [10, 0.9], [40, 0.01]]);
    const segments = segmentRecording(probabilities, total(probabilities));
    expect(segments).toHaveLength(1);
    expect(segments[0]!.pauses).toEqual([]);
  });

  it("remembers a short pause inside one segment as a place to split", () => {
    // 12 quiet frames (384 ms) are shorter than the silence that closes speech, longer than a pause worth noting.
    const probabilities = run([[10, 0.01], [31, 0.9], [12, 0.02], [31, 0.9], [40, 0.01]]);
    const segments = segmentRecording(probabilities, total(probabilities));
    expect(segments).toHaveLength(1);
    expect(segments[0]!.pauses).toEqual([{ startMs: 1312, endMs: 1696 }]);
  });

  it("merges two speeches whose margins touch and remembers the gap as a pause", () => {
    const probabilities = run([[10, 0.01], [31, 0.9], [18, 0.02], [31, 0.9], [40, 0.01]]);
    const segments = segmentRecording(probabilities, total(probabilities));
    expect(segments).toHaveLength(1);
    expect(segments[0]!.pauses).toContainEqual({ startMs: 1312, endMs: 1888 });
    expect(segments[0]!.speechStartMs).toBe(320);
  });

  it("keeps speeches apart when their margins do not touch", () => {
    const probabilities = run([[10, 0.01], [31, 0.9], [30, 0.02], [31, 0.9], [40, 0.01]]);
    const segments = segmentRecording(probabilities, total(probabilities));
    expect(segments).toHaveLength(2);
    expect(segments[0]!.endMs).toBeLessThan(segments[1]!.startMs);
  });

  it("gives the same segments whether the probabilities arrive at once or in pieces", () => {
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const probabilities: number[] = [];
    while (probabilities.length < 6000) {
      const speech = random() < 0.5;
      const length = 5 + Math.floor(random() * 90);
      for (let i = 0; i < length; i += 1) probabilities.push(speech ? 0.55 + random() * 0.45 : random() * 0.3);
    }
    const length = total(probabilities);
    const once = segmentRecording(probabilities, length);
    expect(once.length).toBeGreaterThan(5);

    const segmenter = new VadSegmenter();
    const pieces: typeof once = [];
    for (let at = 0, size = 1; at < probabilities.length; at += size, size = (size % 37) + 1) {
      pieces.push(...segmenter.push(probabilities.slice(at, at + size)));
    }
    pieces.push(...segmenter.flush(length));
    expect(pieces).toEqual(once);
    expect(new Set(pieces.map((segment) => segment.id)).size).toBe(pieces.length);
    expect(DEFAULT_VAD_CONFIG.marginMs).toBe(300);
  });

  it("hands over a segment as soon as nothing later can merge into it", () => {
    const segmenter = new VadSegmenter();
    // The silence has closed the speech (16 frames) but the margin of a later speech could still touch it.
    expect(segmenter.push(run([[10, 0.01], [31, 0.9], [17, 0.01]]))).toEqual([]);
    const settled = segmenter.push(run([[40, 0.01]]));
    expect(settled).toHaveLength(1);
    expect(segmenter.flush(8000)).toEqual([]);
  });
});
