import { describe, expect, it } from "vitest";
import { FIRST_FRAME_MS, judgeHealth, type HealthSample } from "../../apps/desktop/src/renderer/readers/video-health.ts";

const sample = (at: number, mediaMs: number, frames: number, playing = true): HealthSample => ({ at, mediaMs, frames, playing });

/** One reading every half second, the clock moving as fast as the page's. */
const run = (frames: (index: number) => number, count = 6, playing = true) => Array.from({ length: count }, (_, index) => sample(index * 500, 10_000 + index * 500, frames(index), playing));

describe("AT-84 black screen: what the player says when the picture is missing", () => {
  it("is fine while the first frame is still awaited, and says so once it has been waited for too long", () => {
    const none = [sample(0, 0, 0, false), sample(500, 0, 0, false)];
    expect(judgeHealth({ sourceAgeMs: 800, samples: none })).toEqual({ state: "ok" });
    expect(judgeHealth({ sourceAgeMs: FIRST_FRAME_MS - 1, samples: none })).toEqual({ state: "ok" });
    expect(judgeHealth({ sourceAgeMs: FIRST_FRAME_MS, samples: none })).toEqual({ state: "no-first-frame", waitedMs: FIRST_FRAME_MS });
  });

  it("is fine once a frame has been presented, playing or not", () => {
    expect(judgeHealth({ sourceAgeMs: 5000, samples: [sample(0, 0, 1, false), sample(500, 0, 1, false)] })).toEqual({ state: "ok" });
    expect(judgeHealth({ sourceAgeMs: 5000, samples: run((index) => 1 + index * 12) })).toEqual({ state: "ok" });
  });

  it("finds a video whose clock runs and whose frame count does not", () => {
    const verdict = judgeHealth({ sourceAgeMs: 9000, samples: run(() => 1) });
    expect(verdict).toMatchObject({ state: "no-frames", frames: 1 });
    // A decoder that gives one frame in a second and a half is still a stall of a 24 fps video.
    expect(judgeHealth({ sourceAgeMs: 9000, samples: run((index) => 1 + Math.floor(index / 4)) }).state).toBe("no-frames");
  });

  it("does not take a pause, a seek or a short window for a stall", () => {
    // Paused: the clock and the frames both stand still.
    expect(judgeHealth({ sourceAgeMs: 9000, samples: run(() => 1, 6, false) })).toEqual({ state: "ok" });
    // Not playing for part of the window (a seek, a wait for data).
    const mixed = run(() => 1);
    mixed[3] = { ...mixed[3]!, playing: false };
    expect(judgeHealth({ sourceAgeMs: 9000, samples: mixed })).toEqual({ state: "ok" });
    // Too few readings to cover the window.
    expect(judgeHealth({ sourceAgeMs: 9000, samples: run(() => 1, 3) })).toEqual({ state: "ok" });
    // The clock hardly moved: a video waiting for data is not a video without a picture.
    const slow = Array.from({ length: 6 }, (_, index) => sample(index * 500, 10_000 + index * 50, 1));
    expect(judgeHealth({ sourceAgeMs: 9000, samples: slow })).toEqual({ state: "ok" });
  });

  it("has nothing to say without readings", () => {
    expect(judgeHealth({ sourceAgeMs: 99_000, samples: [] })).toEqual({ state: "ok" });
  });
});
