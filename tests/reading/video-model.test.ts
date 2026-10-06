import { describe, expect, it } from "vitest";
import {
  clampRate, closePlayed, displayFrame, drainPlayed, emptyPlayed, formatClock, formatClockPrecise, frameLanded, intervalOf, parseClock, parseFrameInput, parseRate,
  parseVtt, percentOf, pickSubtitleTrack, samplePlayed, seekTargetForFrame, stepRate, subtitleRenderer, videoKeyAction, type SubtitleTrack,
} from "../../apps/desktop/src/renderer/readers/video-model.ts";

describe("M2 video time", () => {
  it("writes clocks the way a player does and survives bad numbers", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65_900)).toBe("1:05");
    expect(formatClock(3_725_000)).toBe("1:02:05");
    expect(formatClock(-5)).toBe("0:00");
    expect(formatClock(Number.NaN)).toBe("0:00");
    expect(formatClockPrecise(3_725_042)).toBe("1:02:05.042");
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

describe("M2 video rate", () => {
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
  });
});

describe("M2 video frames", () => {
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

  it("numbers frames from 1 and rejects a frame outside the video", () => {
    expect(displayFrame(0)).toBe(1);
    expect(parseFrameInput("1", 100)).toBe(0);
    expect(parseFrameInput(" 100 ", 100)).toBe(99);
    expect(parseFrameInput("101", 100)).toBeNull();
    expect(parseFrameInput("0", 100)).toBeNull();
    expect(parseFrameInput("1.5", 100)).toBeNull();
    expect(parseFrameInput("abc", 100)).toBeNull();
    expect(parseFrameInput("500", 0)).toBe(499);
  });
});

describe("M2 video watched ranges", () => {
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

describe("M2 video marks and keys", () => {
  it("orders the A and B marks and refuses a missing or empty interval", () => {
    expect(intervalOf(5000, 2000)).toEqual({ startMs: 2000, endMs: 5000 });
    expect(intervalOf(null, 2000)).toBeNull();
    expect(intervalOf(2000, 2050)).toBeNull();
    expect(percentOf(2500, 10_000)).toBe(25);
    expect(percentOf(20_000, 10_000)).toBe(100);
    expect(percentOf(5, 0)).toBe(0);
  });

  it("maps the default keys and leaves system shortcuts alone", () => {
    expect(videoKeyAction({ key: " " }, 5)).toEqual({ type: "toggle" });
    expect(videoKeyAction({ key: "ArrowLeft" }, 5)).toEqual({ type: "seek", deltaMs: -5000 });
    expect(videoKeyAction({ key: "ArrowRight" }, 10)).toEqual({ type: "seek", deltaMs: 10_000 });
    expect(videoKeyAction({ key: "ArrowUp" }, 5)).toEqual({ type: "volume", delta: 0.05 });
    expect(videoKeyAction({ key: "," }, 5)).toEqual({ type: "frame", delta: -1 });
    expect(videoKeyAction({ key: "." }, 5)).toEqual({ type: "frame", delta: 1 });
    expect(videoKeyAction({ key: "i" }, 5)).toEqual({ type: "markA" });
    expect(videoKeyAction({ key: "o" }, 5)).toEqual({ type: "markB" });
    expect(videoKeyAction({ key: "f", ctrlKey: true }, 5)).toBeNull();
    expect(videoKeyAction({ key: "ArrowLeft", altKey: true }, 5)).toBeNull();
    expect(videoKeyAction({ key: "q" }, 5)).toBeNull();
  });
});

describe("M2 video subtitle tracks", () => {
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

  it("draws ASS with the ASS renderer, text formats natively, and picture subtitles not at all", () => {
    expect(subtitleRenderer({ format: "ass" })).toBe("ass");
    expect(subtitleRenderer({ format: "srt" })).toBe("native");
    expect(subtitleRenderer({ format: "vtt" })).toBe("native");
    expect(subtitleRenderer({ format: null })).toBeNull();
  });
});

describe("M2 video WebVTT cues", () => {
  it("reads cues with or without hours, identifiers, settings and a byte-order mark", () => {
    const text = ["﻿WEBVTT", "", "1", "00:00:01.000 --> 00:00:02.500 align:start", "Hello", "there", "", "02:03.250 --> 02:04.000", "Short", "", "1:00:00.000 --> 1:00:01.000", "Late", ""].join("\n");
    expect(parseVtt(text)).toEqual([
      { startMs: 1000, endMs: 2500, text: "Hello\nthere" },
      { startMs: 123_250, endMs: 124_000, text: "Short" },
      { startMs: 3_600_000, endMs: 3_601_000, text: "Late" },
    ]);
  });

  it("skips what has no times, no text or an end before the start", () => {
    const text = ["WEBVTT", "", "NOTE nothing here", "", "00:00:03.000 --> 00:00:02.000", "Backwards", "", "00:00:05.000 --> 00:00:06.000", "", "bad --> worse", "Text"].join("\n");
    expect(parseVtt(text)).toEqual([]);
    expect(parseVtt("")).toEqual([]);
  });
});
