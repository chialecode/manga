import { describe, expect, it } from "vitest";
import { resolveKeys } from "@manga/contracts/keys";
import {
  clampRate, closePlayed, displayFrame, drainPlayed, emptyPlayed, formatClock, formatClockMs, frameLanded, intervalOf, parseClock, parseRate,
  parseListRate, percentOf, pickSubtitleTrack, samplePlayed, seekTargetForFrame, stepRate, subtitleRenderer, videoKeyAction, type SubtitleTrack,
} from "../../apps/desktop/src/renderer/readers/video-model.ts";

describe("video time", () => {
  it("writes clocks the way a player does and survives bad numbers", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65_900)).toBe("1:05");
    expect(formatClock(3_725_000)).toBe("1:02:05");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
  });

  it("writes the shown time as minutes, seconds and milliseconds, with hours only from an hour on", () => {
    expect(formatClockMs(0)).toBe("0:00.000");
    expect(formatClockMs(65_250)).toBe("1:05.250");
    expect(formatClockMs(754_005)).toBe("12:34.005");
    expect(formatClockMs(3_599_999)).toBe("59:59.999");
    expect(formatClockMs(3_725_042)).toBe("1:02:05.042");
    expect(formatClockMs(-5)).toBe("0:00.000");
    expect(formatClockMs(Number.NaN)).toBe("0:00.000");
    expect(formatClockMs(1234.9)).toBe("0:01.234");
  });

  it("reads back whatever the clock writes", () => {
    for (const ms of [0, 1, 999, 65_250, 754_005, 3_599_999, 3_725_042, 7_322_001]) expect(parseClock(formatClockMs(ms))).toBe(ms);
  });

  it("reads typed times and rejects what is not a time", () => {
    expect(parseClock("754")).toBe(754_000);
    expect(parseClock("75.5")).toBe(75_500);
    expect(parseClock("12:34")).toBe(754_000);
    expect(parseClock("1:02:03")).toBe(3_723_000);
    expect(parseClock(" 0:05.250 ")).toBe(5_250);
    for (const bad of ["", "abc", "1:99", "1:60:00", "1:2:3:4", "-5", "1:", ":30", "1.5:30"]) expect(parseClock(bad)).toBeNull();
  });
});

describe("video rate", () => {
  it("keeps typed rates in 0.25 to 4 and steps through the presets", () => {
    expect(parseRate("1.75")).toBe(1.75);
    expect(parseRate("2x")).toBe(2);
    expect(parseRate("0.25")).toBe(0.25);
    expect(parseRate("4")).toBe(4);
    for (const bad of ["0.2", "4.1", "", "fast", "-1"]) expect(parseRate(bad)).toBeNull();
    expect(clampRate(9)).toBe(4);
    expect(clampRate(0)).toBe(0.25);
    expect(clampRate(Number.NaN)).toBe(1);
    expect(stepRate(1, 1)).toBe(1.25);
    expect(stepRate(1, -1)).toBe(0.75);
    expect(stepRate(3, 1)).toBe(4);
    expect(stepRate(0.5, -1)).toBe(0.25);
    expect(stepRate(1.1, 1)).toBe(1.25);
    // The steps follow the list the person edited (AT-90): 1.25 became 1.3 and 3 was taken out.
    const list = [0.5, 1, 1.3, 2];
    expect(stepRate(1, 1, list)).toBe(1.3);
    expect(stepRate(1.3, -1, list)).toBe(1);
    expect(stepRate(2, 1, list)).toBe(4);
    expect(stepRate(1.1, -1, list)).toBe(1);
  });
});

describe("video frames", () => {
  it("seeks to the middle of a frame's own interval, and handles the last frame", () => {
    expect(seekTargetForFrame({ ptsMs: 1000, nextMs: 1041.7, previousMs: 958.3, durationMs: 10_000 })).toBeCloseTo(1020.85, 2);
    const last = seekTargetForFrame({ ptsMs: 9958, nextMs: null, previousMs: 9916, durationMs: 10_000 });
    expect(last).toBeGreaterThan(9958);
    expect(last).toBeLessThanOrEqual(10_000);
    // A single-frame video still gets a time inside the frame.
    expect(seekTargetForFrame({ ptsMs: 0, nextMs: null, previousMs: null, durationMs: 0 })).toBeGreaterThan(0);
  });

  it("checks the presented frame against the index within a millisecond", () => {
    expect(frameLanded(1.0417, 1041.7)).toBe(true);
    expect(frameLanded(1.0, 1041.7)).toBe(false);
    expect(frameLanded(1.0427, 1041.7, 2)).toBe(true);
  });

  it("numbers frames from 1 for display only", () => {
    expect(displayFrame(0)).toBe(1);
    expect(displayFrame(99)).toBe(100);
  });
});

describe("video watched ranges", () => {
  const play = (times: number[], options = { playing: true, rate: 1 }) => times.reduce((state, time) => samplePlayed(state, time, options), emptyPlayed());

  it("extends the stretch while time moves on by normal steps", () => {
    const state = play([0, 250, 500, 750, 1000]);
    expect(drainPlayed(state).ranges).toEqual([{ startMs: 0, endMs: 1000 }]);
  });

  it("does not count a stretch that was skipped over, forward or back", () => {
    const state = play([0, 500, 1000, 600_000, 600_500]);
    expect(drainPlayed(state).ranges).toEqual([{ startMs: 0, endMs: 1000 }, { startMs: 600_000, endMs: 600_500 }]);
    // Going back and watching part of it again changes nothing, and the stretch after the jump back is its own.
    const back = play([0, 500, 1000, 600_000, 600_500, 2000, 2500]);
    expect(drainPlayed(back).ranges).toEqual([{ startMs: 0, endMs: 1000 }, { startMs: 2000, endMs: 2500 }, { startMs: 600_000, endMs: 600_500 }]);
  });

  it("counts nothing while paused, and a seek ends the running stretch", () => {
    let state = play([0, 500, 1000]);
    state = samplePlayed(state, 1000, { playing: false, rate: 1 });
    state = samplePlayed(state, 5000, { playing: false, rate: 1 });
    expect(drainPlayed(state).ranges).toEqual([{ startMs: 0, endMs: 1000 }]);
    const seeked = closePlayed(play([0, 500]));
    expect(seeked.current).toBeNull();
    expect(drainPlayed(seeked).ranges).toEqual([{ startMs: 0, endMs: 500 }]);
  });

  it("allows bigger steps at a higher rate", () => {
    expect(drainPlayed(play([0, 3000, 6000], { playing: true, rate: 3 })).ranges).toEqual([{ startMs: 0, endMs: 6000 }]);
    // The same samples at normal speed are jumps, and a jump adds nothing.
    expect(drainPlayed(play([0, 3000, 6000], { playing: true, rate: 1 })).ranges).toEqual([]);
  });

  it("carries the running stretch over a drain without double counting", () => {
    const first = drainPlayed(play([0, 500, 1000]));
    expect(first.ranges).toEqual([{ startMs: 0, endMs: 1000 }]);
    const next = samplePlayed(first.state, 1500, { playing: true, rate: 1 });
    expect(drainPlayed(next).ranges).toEqual([{ startMs: 1000, endMs: 1500 }]);
    expect(drainPlayed(emptyPlayed()).ranges).toEqual([]);
  });
});

describe("video marks and keys", () => {
  it("orders the A and B marks and refuses a missing or empty interval", () => {
    expect(intervalOf(5000, 2000)).toEqual({ startMs: 2000, endMs: 5000 });
    expect(intervalOf(null, 2000)).toBeNull();
    expect(intervalOf(2000, 2050)).toBeNull();
    expect(percentOf(2500, 10_000)).toBe(25);
    expect(percentOf(20_000, 10_000)).toBe(100);
    expect(percentOf(5, 0)).toBe(0);
  });

  it("maps the default keys and leaves system shortcuts alone", () => {
    expect(videoKeyAction({ key: " " })).toEqual({ type: "toggle" });
    // The arrows are one action each: a step or a hold is decided by how long the key is down, not by the map.
    expect(videoKeyAction({ key: "ArrowLeft" })).toEqual({ type: "arrow", side: -1 });
    expect(videoKeyAction({ key: "ArrowRight" })).toEqual({ type: "arrow", side: 1 });
    expect(videoKeyAction({ key: "ArrowUp" })).toEqual({ type: "volume", delta: 0.05 });
    expect(videoKeyAction({ key: "," })).toEqual({ type: "frame", delta: -1 });
    expect(videoKeyAction({ key: "." })).toEqual({ type: "frame", delta: 1 });
    expect(videoKeyAction({ key: "i" })).toEqual({ type: "markA" });
    expect(videoKeyAction({ key: "o" })).toEqual({ type: "markB" });
    expect(videoKeyAction({ key: "t" })).toEqual({ type: "time" });
    expect(videoKeyAction({ key: "t", ctrlKey: true })).toBeNull();
    expect(videoKeyAction({ key: "f", ctrlKey: true })).toBeNull();
    expect(videoKeyAction({ key: "ArrowLeft", altKey: true })).toBeNull();
    expect(videoKeyAction({ key: "q" })).toBeNull();
  });
});

describe("video subtitle tracks", () => {
  const track = (id: string, extra: Partial<SubtitleTrack> = {}): SubtitleTrack => ({ id, source: "embedded", streamIndex: 2, codec: "ass", format: "ass", language: null, title: null, default: false, ...extra });

  it("starts with the track the user chose, else Chinese, else the default, else the first that can be drawn", () => {
    const tracks = [track("s1", { language: "eng", default: true }), track("s2", { language: "chi" }), track("s3", { format: null, codec: "hdmv_pgs_subtitle" })];
    expect(pickSubtitleTrack(tracks)?.id).toBe("s2");
    expect(pickSubtitleTrack(tracks, "s1")?.id).toBe("s1");
    expect(pickSubtitleTrack(tracks, "s3")?.id).toBe("s2");
    expect(pickSubtitleTrack(tracks.slice(0, 1).concat(tracks.slice(2)))?.id).toBe("s1");
    expect(pickSubtitleTrack([track("p", { format: null })])).toBeNull();
    expect(pickSubtitleTrack([])).toBeNull();
  });

  it("draws ASS with the ASS renderer, text formats with the text layer, and picture subtitles not at all", () => {
    expect(subtitleRenderer({ format: "ass" })).toBe("ass");
    expect(subtitleRenderer({ format: "srt" })).toBe("text");
    expect(subtitleRenderer({ format: "vtt" })).toBe("text");
    expect(subtitleRenderer({ format: null })).toBeNull();
  });
});

describe("the rate list and the custom-rate key (AT-90)", () => {
  it("reads a rate typed into the list as written, with at most two decimals, between 0.25 and 4", () => {
    expect(parseListRate("1.3")).toBe(1.3);
    expect(parseListRate(" 1.75x ")).toBe(1.75);
    expect(parseListRate("4")).toBe(4);
    expect(parseListRate("0.25")).toBe(0.25);
    for (const bad of ["", "abc", "0.2", "4.01", "1.255", "-1", "1,3", "1.", ".5"]) expect(parseListRate(bad), JSON.stringify(bad)).toBeNull();
  });

  it("maps R to the custom-rate switch, and the person's own key replaces it", () => {
    expect(videoKeyAction({ key: "r" })).toEqual({ type: "customRate" });
    expect(videoKeyAction({ key: "s" })).toEqual({ type: "screenshot" });
    const own = resolveKeys({ "video.customRate": ["Y"] });
    expect(videoKeyAction({ key: "y" }, own)).toEqual({ type: "customRate" });
    expect(videoKeyAction({ key: "r" }, own)).toBeNull();
    expect(videoKeyAction({ key: "Escape" }, own)).toEqual({ type: "escape" });
  });
});
