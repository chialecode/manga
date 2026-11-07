import { describe, expect, it } from "vitest";
import type { RoughcutStreams } from "@manga/contracts";
import { chapterMetadata, compareStreams, keptAudio, keptSubtitles, muxerFor, outputExtension, planClipCut, streamsFromProbe, subtitleFits, trackProblems } from "../../packages/app-core/src/creative/roughcut-plan.ts";

/** A 12-second video at 24 frames per second with a keyframe every second, the way the frame index states it: times in milliseconds. */
const pts = Array.from({ length: 288 }, (_, i) => Math.round((i * 1000) / 24));
const keyframes = Array.from({ length: 12 }, (_, i) => i * 1000);
const index = { ptsMs: pts, keyframesMs: keyframes };
const DURATION = 12_000;

describe("where a copy of a stretch of video starts and ends (CLIP-02)", () => {
  it("starts on the keyframe at or before the start and ends on the first frame at or after the end", () => {
    const cut = planClipCut({ inMs: 2500, outMs: 5500 }, index, DURATION);
    expect(cut).toMatchObject({ actualInMs: 2000, actualOutMs: 5500, toEnd: false, onKeyframe: false, frames: 84, problems: [] });
    // The tool is told to stop half the gap before the frame the copy ends on, so that frame stays out.
    expect(cut.frameGapMs).toBe(pts[132]! - pts[131]!);
  });

  it("keeps a start that is a keyframe, and rounds an end between two frames up to the next one", () => {
    const cut = planClipCut({ inMs: 3000, outMs: 5520 }, index, DURATION);
    expect(cut).toMatchObject({ actualInMs: 3000, onKeyframe: true, actualOutMs: pts[133], frames: 133 - 72, problems: [] });
  });

  it("treats times within half a millisecond as the same instant, so a rounded time still lands on its frame", () => {
    expect(planClipCut({ inMs: 2999.6, outMs: 5499.7 }, index, DURATION)).toMatchObject({ actualInMs: 3000, onKeyframe: true, actualOutMs: 5500, frames: 132 - 72 });
  });

  it("always holds at least what was asked for", () => {
    for (let inMs = 0; inMs < 11_000; inMs += 317) {
      for (const length of [1, 40, 999, 2500]) {
        const outMs = Math.min(inMs + length, DURATION - 1);
        if (outMs <= inMs) continue;
        const cut = planClipCut({ inMs, outMs }, index, DURATION);
        expect(cut.problems).toEqual([]);
        expect(cut.actualInMs).toBeLessThanOrEqual(inMs + 0.5);
        expect(cut.actualOutMs).toBeGreaterThanOrEqual(outMs - 0.5);
        expect(keyframes).toContain(cut.actualInMs);
      }
    }
  });

  it("runs to the end of the file when the end is after the last frame", () => {
    for (const outMs of [11_990, 12_000, 12_400]) {
      const cut = planClipCut({ inMs: 11_000, outMs }, index, DURATION);
      expect(cut).toMatchObject({ toEnd: true, actualInMs: 11_000, frames: 24, frameGapMs: 0, problems: [] });
      expect(cut.actualOutMs).toBe(Math.max(DURATION, pts.at(-1)!));
    }
  });

  it("says why a clip cannot be cut instead of guessing", () => {
    expect(planClipCut({ inMs: 3000, outMs: 3000 }, index, DURATION).problems).toEqual(["range"]);
    expect(planClipCut({ inMs: 4000, outMs: 3000 }, index, DURATION).problems).toEqual(["range"]);
    expect(planClipCut({ inMs: 12_000, outMs: 12_500 }, index, DURATION).problems).toEqual(["range"]);
    expect(planClipCut({ inMs: 0, outMs: 1000 }, { ptsMs: [], keyframesMs: [] }, DURATION).problems).toEqual(["range"]);
    // No keyframe at or before the start: there is nothing to start a copy from.
    expect(planClipCut({ inMs: 100, outMs: 1000 }, { ptsMs: pts, keyframesMs: [500, 1500] }, DURATION).problems).toEqual(["no-keyframe"]);
  });
});

const streams = (change: (value: RoughcutStreams) => void = () => undefined): RoughcutStreams => {
  const value: RoughcutStreams = {
    container: "mov",
    video: { codec: "h264", profile: "Constrained Baseline", width: 640, height: 360, pixelFormat: "yuv420p", frameRate: "24/1", timeBase: "1/12288", parameters: "sps-1" },
    audio: [{ codec: "aac", sampleRate: 48_000, channels: 1, timeBase: "1/48000", parameters: "asc-1", language: "", title: "" }],
    subtitle: [],
  };
  change(value);
  return value;
};

describe("whether clips can be joined without re-encoding", () => {
  it("joins clips whose streams agree in everything a copy depends on", () => {
    expect(compareStreams(streams(), streams(), "c2")).toEqual([]);
  });

  it("names the first difference of each kind, clip by clip", () => {
    const code = (change: (value: RoughcutStreams) => void) => compareStreams(streams(), streams(change), "c2").map((problem) => problem.code);
    expect(code((value) => { value.container = "matroska"; })).toEqual(["container"]);
    expect(code((value) => { value.video.codec = "hevc"; })).toEqual(["video-codec"]);
    expect(code((value) => { value.video.parameters = "sps-2"; })).toEqual(["video-profile"]);
    expect(code((value) => { value.video.profile = "High"; })).toEqual(["video-profile"]);
    expect(code((value) => { value.video.width = 480; value.video.height = 270; })).toEqual(["resolution"]);
    expect(code((value) => { value.video.pixelFormat = "yuv422p"; })).toEqual(["pixel-format"]);
    expect(code((value) => { value.video.frameRate = "30/1"; })).toEqual(["frame-rate"]);
    expect(code((value) => { value.video.timeBase = "1/90000"; })).toEqual(["time-base"]);
    expect(code((value) => { value.audio = []; })).toEqual(["audio-tracks"]);
    expect(code((value) => { value.audio.push({ ...value.audio[0]! }); })).toEqual(["audio-tracks"]);
    expect(code((value) => { value.audio[0]!.codec = "opus"; })).toEqual(["audio-codec"]);
    expect(code((value) => { value.audio[0]!.sampleRate = 44_100; value.audio[0]!.channels = 2; })).toEqual(["audio-format"]);
    expect(code((value) => { value.audio[0]!.parameters = "asc-2"; })).toEqual(["audio-format"]);
    const several = compareStreams(streams(), streams((value) => { value.video.codec = "hevc"; value.video.width = 1; }), "c9");
    expect(several.map((problem) => problem.code)).toEqual(["video-codec", "resolution"]);
    expect(several.every((problem) => problem.clipId === "c9")).toBe(true);
    expect(several[0]!.detail).toEqual({ first: "h264", other: "hevc" });
  });

  it("reads the streams from the media tool's own answer, skipping cover pictures, and takes the container from the format names", () => {
    const json = {
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
      streams: [
        { codec_type: "video", codec_name: "mjpeg", width: 10, height: 10, disposition: { attached_pic: 1 } },
        { codec_type: "video", codec_name: "h264", profile: "High", width: 1920, height: 1080, pix_fmt: "yuv420p", r_frame_rate: "24000/1001", time_base: "1/24000", extradata_hash: "SHA256=abc" },
        { codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, time_base: "1/48000", extradata_size: 2, tags: { LANGUAGE: "jpn", Title: "原声" } },
        { codec_type: "subtitle", codec_name: "mov_text", tags: { language: "chi" } },
      ],
    };
    expect(streamsFromProbe(json)).toEqual({
      container: "mov",
      video: { codec: "h264", profile: "High", width: 1920, height: 1080, pixelFormat: "yuv420p", frameRate: "24000/1001", timeBase: "1/24000", parameters: "SHA256=abc" },
      audio: [{ codec: "aac", sampleRate: 48_000, channels: 2, timeBase: "1/48000", parameters: "2", language: "jpn", title: "原声" }],
      subtitle: [{ codec: "mov_text", language: "chi", title: "" }],
    });
    expect(streamsFromProbe({ format: { format_name: "matroska,webm" }, streams: [{ codec_type: "video", codec_name: "vp9" }] })?.container).toBe("matroska");
    expect(streamsFromProbe({ format: { format_name: "mov,mp4" }, streams: [{ codec_type: "audio", codec_name: "aac" }] })).toBeNull();
    expect(streamsFromProbe({})).toBeNull();
  });

  it("writes the container of the first clip, with its own extension when a copy can write it, and says when it cannot", () => {
    expect(outputExtension("mov", "clip.mp4")).toBe("mp4");
    expect(outputExtension("mov", "clip.MOV")).toBe("mov");
    expect(outputExtension("mov", "clip.m4v")).toBe("m4v");
    expect(outputExtension("mov", "clip.3gp")).toBe("mp4");
    expect(outputExtension("matroska", "clip.mkv")).toBe("mkv");
    expect(outputExtension("matroska", "clip.webm")).toBe("webm");
    expect(outputExtension("avi", "clip.avi")).toBeNull();
    expect(["mp4", "m4v", "mov", "mkv", "webm"].map(muxerFor)).toEqual(["mp4", "mp4", "mov", "matroska", "webm"]);
  });
});

describe("the audio and subtitle tracks an export keeps (CLIP-02)", () => {
  const two = (change: (value: RoughcutStreams) => void = () => undefined) => streams((value) => {
    value.audio.push({ codec: "aac", sampleRate: 48_000, channels: 2, timeBase: "1/48000", parameters: "asc-2", language: "eng", title: "" });
    value.subtitle = [{ codec: "ass", language: "chi", title: "" }, { codec: "subrip", language: "eng", title: "" }];
    change(value);
  });

  it("keeps every audio track and no subtitle track unless told otherwise, and an empty list keeps none", () => {
    expect(keptAudio(two(), { mode: "merge" })).toEqual([0, 1]);
    expect(keptAudio(two(), { mode: "merge", audioTracks: [1, 0, 1] })).toEqual([0, 1]);
    expect(keptAudio(two(), { mode: "merge", audioTracks: [] })).toEqual([]);
    expect(keptSubtitles({ mode: "merge" })).toEqual([]);
    expect(keptSubtitles({ mode: "merge", subtitleTracks: [1, 0] })).toEqual([0, 1]);
  });

  it("asks of the clips only the tracks that are kept", () => {
    const other = two((value) => { value.audio[1]!.codec = "opus"; });
    expect(compareStreams(two(), other, "c2").map((problem) => problem.code)).toEqual(["audio-codec"]);
    // The second audio track is not in the finished file, so how it differs does not matter.
    expect(compareStreams(two(), other, "c2", { mode: "merge", audioTracks: [0] })).toEqual([]);
    const fewer = two((value) => { value.audio.pop(); });
    expect(compareStreams(two(), fewer, "c2").map((problem) => problem.code)).toEqual(["audio-tracks"]);
    expect(compareStreams(two(), fewer, "c2", { mode: "merge", audioTracks: [0] })).toEqual([]);
    // A kept track the other clip lacks is that clip's own problem (below), not a difference between the two.
    expect(compareStreams(two(), fewer, "c2", { mode: "merge", audioTracks: [1] })).toEqual([]);
    const text = two((value) => { value.subtitle[1]!.codec = "ass"; });
    expect(compareStreams(two(), text, "c2", { mode: "merge", subtitleTracks: [0] })).toEqual([]);
    expect(compareStreams(two(), text, "c2", { mode: "merge", subtitleTracks: [1] }).map((problem) => problem.code)).toEqual(["subtitle-codec"]);
    expect(compareStreams(two(), streams(), "c2", { mode: "merge", subtitleTracks: [0], audioTracks: [0] })).toEqual([]);
  });

  it("says which container takes which subtitle track as it is", () => {
    expect(["ass", "subrip", "hdmv_pgs_subtitle", "dvd_subtitle"].map((codec) => subtitleFits(codec, "mkv"))).toEqual([true, true, true, true]);
    expect(["ass", "subrip", "mov_text", "tx3g"].map((codec) => subtitleFits(codec, "mp4"))).toEqual([false, false, true, true]);
    expect(["mov_text", "subrip"].map((codec) => subtitleFits(codec, "mov"))).toEqual([true, false]);
    expect(["webvtt", "ass"].map((codec) => subtitleFits(codec, "webm"))).toEqual([true, false]);
  });

  it("names a chosen track a clip's source lacks or its container cannot hold", () => {
    expect(trackProblems(two(), "mkv", { mode: "separate", audioTracks: [1], subtitleTracks: [0, 1] }, "c1")).toEqual([]);
    expect(trackProblems(two(), "mp4", { mode: "separate", subtitleTracks: [0] }, "c1")).toEqual([{ code: "subtitle-container", clipId: "c1", detail: { first: "ass", other: "mp4" } }]);
    expect(trackProblems(two(), "mp4", { mode: "separate" }, "c1")).toEqual([]);
    expect(trackProblems(two(), "mkv", { mode: "separate", audioTracks: [2] }, "c1")).toEqual([{ code: "track-missing", clipId: "c1", detail: { first: "audio 3", other: 2 } }]);
    expect(trackProblems(two(), "mkv", { mode: "separate", subtitleTracks: [5] }, "c1")[0]).toMatchObject({ code: "track-missing" });
  });
});


describe("the chapters of a merged export (CLIP-02)", () => {
  it("writes one chapter for each clip, in milliseconds, each beginning where the one before ended", () => {
    expect(chapterMetadata([{ title: "开场", lengthMs: 3000 }, { title: "第二段", lengthMs: 1500.4 }, { title: "尾声", lengthMs: 2000 }])).toBe([
      ";FFMETADATA1",
      "[CHAPTER]", "TIMEBASE=1/1000", "START=0", "END=3000", "title=开场",
      "[CHAPTER]", "TIMEBASE=1/1000", "START=3000", "END=4500", "title=第二段",
      "[CHAPTER]", "TIMEBASE=1/1000", "START=4500", "END=6500", "title=尾声", "",
    ].join("\n"));
  });

  it("keeps a title on one line and escapes what the metadata file reads as syntax", () => {
    const text = chapterMetadata([{ title: "a=b;c#d\\e\nf\r\ng", lengthMs: 10 }]);
    expect(text).toContain("title=a\\=b\\;c\\#d\\\\e f g\n");
    expect(text.split("\n").filter((line) => line.startsWith("title="))).toHaveLength(1);
  });

  it("gives a chapter at least a millisecond, so a very short clip is still one", () => {
    expect(chapterMetadata([{ title: "x", lengthMs: 0.2 }])).toContain("START=0\nEND=1\n");
  });
});
