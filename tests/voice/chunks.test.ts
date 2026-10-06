import { describe, expect, it } from "vitest";
import { MAX_CHUNK_MS, maxChunkMsForBytes, planChunks } from "../../packages/app-core/src/voice/chunks.ts";
import type { SpeechSegment } from "../../packages/app-core/src/voice/vad-segmenter.ts";

const segment = (startMs: number, endMs: number, pauses: Array<[number, number]> = []): SpeechSegment => ({
  id: `vs-${startMs}-${endMs}`,
  startMs,
  endMs,
  speechStartMs: startMs + 300,
  speechEndMs: endMs - 300,
  pauses: pauses.map(([from, to]) => ({ startMs: from, endMs: to })),
});

describe("chunk planner", () => {
  it("sends each short segment on its own and keeps the capture offsets in the key", () => {
    const chunks = planChunks([segment(1000, 5000), segment(20_000, 26_000)]);
    expect(chunks.map((chunk) => chunk.key)).toEqual(["c1000-5000", "c20000-26000"]);
  });

  it("merges segments that sit within the merge gap and keeps the quiet between them", () => {
    const chunks = planChunks([segment(0, 5000), segment(6000, 9000)]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ startMs: 0, endMs: 9000, segmentIds: ["vs-0-5000", "vs-6000-9000"] });
  });

  it("does not merge across a wide gap or past the block limit", () => {
    expect(planChunks([segment(0, 5000), segment(7000, 9000)])).toHaveLength(2);
    expect(planChunks([segment(0, 20_000), segment(21_000, 40_000)])).toHaveLength(2);
  });

  it("splits a long segment at the latest pause that still fits the limit", () => {
    const long = segment(0, 70_000, [[20_000, 20_400], [28_000, 28_300], [55_000, 55_200]]);
    const chunks = planChunks([long]);
    expect(chunks.map((chunk) => [chunk.startMs, chunk.endMs])).toEqual([[0, 28_150], [28_150, 55_100], [55_100, 70_000]]);
    for (const chunk of chunks) expect(chunk.endMs - chunk.startMs).toBeLessThanOrEqual(MAX_CHUNK_MS);
  });

  it("cuts a long segment that never pauses at the limit", () => {
    const chunks = planChunks([segment(0, 65_000)]);
    expect(chunks.map((chunk) => [chunk.startMs, chunk.endMs])).toEqual([[0, 30_000], [30_000, 60_000], [60_000, 65_000]]);
  });

  it("never loses or repeats audio: pieces of one segment are contiguous", () => {
    const chunks = planChunks([segment(5_000, 123_000, [[40_000, 40_300], [90_000, 90_500]])]);
    expect(chunks[0]!.startMs).toBe(5_000);
    expect(chunks[chunks.length - 1]!.endMs).toBe(123_000);
    for (let i = 1; i < chunks.length; i += 1) expect(chunks[i]!.startMs).toBe(chunks[i - 1]!.endMs);
  });

  it("is deterministic, so a re-run submits the same keys", () => {
    const input = [segment(0, 70_000, [[25_000, 25_300]]), segment(80_000, 83_000)];
    expect(planChunks(input)).toEqual(planChunks(input));
  });

  it("derives the block length from the upload size limit", () => {
    expect(maxChunkMsForBytes(undefined)).toBe(30_000);
    expect(maxChunkMsForBytes(1024 * 1024)).toBe(30_000);
    expect(maxChunkMsForBytes(500_000)).toBe(15_000);
    expect(maxChunkMsForBytes(10_000)).toBe(1_000);
  });
});
