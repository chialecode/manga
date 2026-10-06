import { describe, expect, it } from "vitest";
import type { SourceLocator } from "@manga/contracts";
import { mapInterval, type PositionEvent } from "../../packages/app-core/src/voice/position-map.ts";

const text = (start: number, end: number): SourceLocator => ({ kind: "text", partId: "p1", representationId: "r1", normalizationVersion: "text-nfc-lf-v1", range: { start, end } });
const page = (id: string): SourceLocator => ({ kind: "image", pageId: id });
const time = (startMs: number): SourceLocator => ({ kind: "temporal", startMs });

describe("position mapper", () => {
  it("gives nothing when no position was ever reported", () => {
    expect(mapInterval([], 1000, 5000)).toEqual([]);
    expect(mapInterval([{ offsetMs: 0, reason: "start" }], 0, 1000)).toEqual([]);
  });

  it("follows a reader through the text: one anchor per place, with the recorded clock kept", () => {
    const events: PositionEvent[] = [
      { offsetMs: 0, reason: "start", resourceId: "novel-1", resourceRevisionId: "rev-1", locator: text(0, 40) },
      { offsetMs: 10_000, reason: "selection", locator: text(100, 140) },
      { offsetMs: 25_000, reason: "page", locator: text(500, 540) },
    ];
    const anchors = mapInterval(events, 8_000, 30_000);
    expect(anchors).toHaveLength(3);
    expect(anchors.map((anchor) => [anchor.startMs, anchor.endMs])).toEqual([[8_000, 10_000], [10_000, 25_000], [25_000, 30_000]]);
    expect(anchors.map((anchor) => (anchor.locator as any).range.start)).toEqual([0, 100, 500]);
    expect(anchors.every((anchor) => anchor.resourceId === "novel-1" && anchor.resourceRevisionId === "rev-1")).toBe(true);
  });

  it("keeps one anchor while the reader stays on the same page", () => {
    const events: PositionEvent[] = [
      { offsetMs: 0, reason: "start", resourceId: "comic-1", resourceRevisionId: "rev-1", locator: page("page-4") },
      { offsetMs: 6_000, reason: "position", locator: page("page-4") },
    ];
    expect(mapInterval(events, 1_000, 20_000)).toEqual([{ startMs: 1_000, endMs: 20_000, resourceId: "comic-1", resourceRevisionId: "rev-1", locator: page("page-4") }]);
  });

  it("starts a new anchor when the reader switches to another resource", () => {
    const events: PositionEvent[] = [
      { offsetMs: 0, reason: "start", resourceId: "a", resourceRevisionId: "ra", locator: page("p1") },
      { offsetMs: 5_000, reason: "resource_change", resourceId: "b", resourceRevisionId: "rb", locator: page("p9") },
    ];
    const anchors = mapInterval(events, 2_000, 9_000);
    expect(anchors.map((anchor) => [anchor.resourceId, anchor.startMs, anchor.endMs])).toEqual([["a", 2_000, 5_000], ["b", 5_000, 9_000]]);
  });

  it("maps a video that plays at 1x: source time advances with the recording clock", () => {
    const events: PositionEvent[] = [{ offsetMs: 0, reason: "start", resourceId: "v", resourceRevisionId: "rv", locator: time(60_000), playing: true, playbackRate: 1 }];
    const [anchor] = mapInterval(events, 4_000, 10_000);
    expect(anchor!.locator).toEqual({ kind: "temporal", startMs: 64_000, endMs: 70_000 });
  });

  it("maps a video at 2x: six seconds of recording cover twelve of video", () => {
    const events: PositionEvent[] = [
      { offsetMs: 0, reason: "start", resourceId: "v", resourceRevisionId: "rv", locator: time(0), playing: true, playbackRate: 1 },
      { offsetMs: 10_000, reason: "rate_change", playbackRate: 2 },
    ];
    const anchors = mapInterval(events, 4_000, 16_000);
    expect(anchors).toHaveLength(1);
    expect(anchors[0]!.locator).toEqual({ kind: "temporal", startMs: 4_000, endMs: 22_000 });
  });

  it("holds the source time still while paused, then resumes where it stopped", () => {
    const events: PositionEvent[] = [
      { offsetMs: 0, reason: "start", resourceId: "v", resourceRevisionId: "rv", locator: time(30_000), playing: true, playbackRate: 1 },
      { offsetMs: 5_000, reason: "pause" },
      { offsetMs: 15_000, reason: "resume" },
    ];
    const inPause = mapInterval(events, 7_000, 12_000);
    expect(inPause).toHaveLength(1);
    expect(inPause[0]!.locator).toEqual({ kind: "temporal", startMs: 35_000, endMs: 35_000 });
    const across = mapInterval(events, 3_000, 20_000);
    expect(across).toHaveLength(1);
    expect(across[0]!.locator).toEqual({ kind: "temporal", startMs: 33_000, endMs: 40_000 });
    expect(across[0]!.startMs).toBe(3_000);
    expect(across[0]!.endMs).toBe(20_000);
  });

  it("splits at a seek, and a reported position corrects what the clock predicted", () => {
    const events: PositionEvent[] = [
      { offsetMs: 0, reason: "start", resourceId: "v", resourceRevisionId: "rv", locator: time(0), playing: true, playbackRate: 1 },
      { offsetMs: 10_000, reason: "seek", locator: time(300_000) },
      { offsetMs: 20_000, reason: "sample", locator: time(311_000) },
    ];
    const anchors = mapInterval(events, 5_000, 25_000);
    expect(anchors.map((anchor) => anchor.locator)).toEqual([
      { kind: "temporal", startMs: 5_000, endMs: 10_000 },
      { kind: "temporal", startMs: 300_000, endMs: 310_000 },
      { kind: "temporal", startMs: 311_000, endMs: 316_000 },
    ]);
  });

  it("does not carry source time over an episode change", () => {
    const events: PositionEvent[] = [
      { offsetMs: 0, reason: "start", resourceId: "ep1", resourceRevisionId: "r1", locator: time(1_200_000), playing: true, playbackRate: 1 },
      { offsetMs: 8_000, reason: "episode_change", resourceId: "ep2", resourceRevisionId: "r2", locator: time(0), playing: true },
    ];
    const anchors = mapInterval(events, 4_000, 12_000);
    expect(anchors.map((anchor) => [anchor.resourceId, (anchor.locator as any).startMs, (anchor.locator as any).endMs])).toEqual([
      ["ep1", 1_204_000, 1_208_000],
      ["ep2", 0, 4_000],
    ]);
  });

  it("orders events with the same offset by arrival", () => {
    const events: PositionEvent[] = [
      { offsetMs: 0, reason: "start", resourceId: "n", resourceRevisionId: "r", locator: text(0, 10), seq: 0 },
      { offsetMs: 5_000, reason: "page", locator: text(900, 910), seq: 2 },
      { offsetMs: 5_000, reason: "page", locator: text(500, 510), seq: 1 },
    ];
    const anchors = mapInterval(events, 6_000, 7_000);
    expect((anchors[0]!.locator as any).range.start).toBe(900);
  });

  it("answers for a single instant", () => {
    const events: PositionEvent[] = [
      { offsetMs: 0, reason: "start", resourceId: "n", resourceRevisionId: "r", locator: text(0, 10) },
      { offsetMs: 5_000, reason: "page", locator: text(500, 510) },
    ];
    expect(mapInterval(events, 5_000, 5_000)).toHaveLength(1);
    expect((mapInterval(events, 4_000, 4_000)[0]!.locator as any).range.start).toBe(0);
  });
});
