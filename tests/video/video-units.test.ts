import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { VideoProbe } from "@manga/contracts";
import { cueWindow, parseAssCues, parseCues, parseSrtCues } from "../../packages/app-core/src/video/cues.ts";
import { decidePlayback, listTracks, mediaTypeFor } from "../../packages/app-core/src/video/playback.ts";
import { compareTimelines } from "../../packages/app-core/src/video/play-copy.ts";
import { discoverSidecars, sampledFingerprint } from "../../packages/app-core/src/video/sidecars.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-video-units-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

type Stream = VideoProbe["streams"][number];
const video = (extra: Partial<Stream> = {}): Stream => ({ index: 0, type: "video", codec: "h264", width: 1920, height: 1080, fps: 24, bitDepth: 8, pixelFormat: "yuv420p", ...extra }) as Stream;
const audio = (index: number, codec = "aac", extra: Partial<Stream> = {}): Stream => ({ index, type: "audio", codec, channels: 2, ...extra }) as Stream;
function probe(streams: Stream[], formatNames = ["matroska", "webm"], extra: Partial<VideoProbe> = {}): VideoProbe {
  return { container: formatNames[0]!, formatNames, durationMs: 60_000, startMs: 0, bitRate: 1, size: 1, streams, chapters: [], tool: { name: "ffprobe", version: "test" }, keyframesMs: [], keyframesTruncated: true, variableFrameRate: false, externalSubtitles: [], ...extra } as VideoProbe;
}

describe("decidePlayback", () => {
  it("plays 8-bit H.264 with AAC straight from MP4 or MKV", () => {
    expect(decidePlayback(probe([video(), audio(1)], ["mov", "mp4"]), { hardwareHevc: false }).decision).toBe("direct");
    expect(decidePlayback(probe([video(), audio(1)]), { hardwareHevc: false }).decision).toBe("direct");
  });

  it("needs a play copy for HEVC unless this machine decodes it in hardware, and never for 10-bit H.264 directly", () => {
    const hevc = probe([video({ codec: "hevc", bitDepth: 10 }), audio(1)]);
    expect(decidePlayback(hevc, { hardwareHevc: false })).toMatchObject({ decision: "play_copy", copy: { reason: "no_hardware_hevc", video: "encode", audio: "copy" } });
    expect(decidePlayback(hevc, { hardwareHevc: true }).decision).toBe("direct");
    expect(decidePlayback(probe([video({ codec: "hevc", bitDepth: 12 }), audio(1)]), { hardwareHevc: true }).decision).toBe("play_copy");
    expect(decidePlayback(probe([video({ bitDepth: 10 }), audio(1)]), { hardwareHevc: true })).toMatchObject({ decision: "play_copy", copy: { reason: "unsupported_video", video: "encode" } });
  });

  it("converts only the audio when the picture is fine, and rewrites only the container when everything else is", () => {
    expect(decidePlayback(probe([video(), audio(1, "ac3")]), { hardwareHevc: false })).toMatchObject({ decision: "play_copy", copy: { reason: "unsupported_audio", video: "copy", audio: "aac" } });
    expect(decidePlayback(probe([video(), audio(1)], ["avi"]), { hardwareHevc: false })).toMatchObject({ decision: "remux", copy: { reason: "unsupported_container", video: "copy", audio: "copy" } });
    expect(decidePlayback(probe([video({ codec: "mpeg4" }), audio(1)], ["avi"]), { hardwareHevc: false })).toMatchObject({ decision: "play_copy", copy: { video: "encode" } });
  });

  it("follows the selected audio track, refuses one that does not exist, and honours an owner-forced copy", () => {
    const two = probe([video(), audio(1, "aac", { default: true }), audio(2, "dts")]);
    expect(decidePlayback(two, { hardwareHevc: false }).decision).toBe("direct");
    expect(decidePlayback(two, { hardwareHevc: false }, { audioStreamIndex: 2 })).toMatchObject({ decision: "play_copy", audioStreamIndex: 2, copy: { audio: "aac" } });
    expect(decidePlayback(two, { hardwareHevc: false }, { audioStreamIndex: 9 }).decision).toBe("unsupported");
    // A playable track that is not the default one still needs a copy with that track first.
    const playable = probe([video(), audio(1, "aac", { default: true }), audio(2, "opus")]);
    expect(decidePlayback(playable, { hardwareHevc: false }, { audioStreamIndex: 1 }).decision).toBe("direct");
    expect(decidePlayback(playable, { hardwareHevc: false }, { audioStreamIndex: 2 })).toMatchObject({ decision: "remux", audioStreamIndex: 2, reasons: ["audio_track"], copy: { reason: "audio_track", video: "copy", audio: "copy" } });
    expect(decidePlayback(two, { hardwareHevc: false, forcePlayCopy: true })).toMatchObject({ decision: "play_copy", reasons: ["forced"] });
  });

  it("picks the film, not the cover art, when a file carries several video streams", () => {
    const withCover = probe([video({ index: 0, codec: "mjpeg", width: 600, height: 600, fps: undefined }), video({ index: 1 }), audio(2)]);
    expect(decidePlayback(withCover, { hardwareHevc: false })).toMatchObject({ videoStreamIndex: 1, decision: "direct" });
    expect(decidePlayback(probe([audio(0)]), { hardwareHevc: false }).decision).toBe("unsupported");
  });

  it("names the media type from the container and lists tracks without file paths", () => {
    expect(mediaTypeFor({ formatNames: ["matroska", "webm"] })).toBe("video/webm");
    expect(mediaTypeFor({ formatNames: ["matroska"] })).toBe("video/x-matroska");
    expect(mediaTypeFor({ formatNames: ["mov", "mp4"] })).toBe("video/mp4");
    const tracks = listTracks(probe([video(), audio(1, "aac", { language: "jpn", default: true }), { index: 2, type: "subtitle", codec: "ass", textual: true } as Stream, { index: 3, type: "subtitle", codec: "hdmv_pgs_subtitle", textual: false } as Stream], undefined, { externalSubtitles: [{ id: "xabc", fileName: "a.srt", format: "srt" }] }));
    expect(tracks.audio).toEqual([{ index: 1, codec: "aac", language: "jpn", title: null, channels: 2, default: true }]);
    expect(tracks.subtitles.map((track) => [track.id, track.source, track.format])).toEqual([["s2", "embedded", "ass"], ["s3", "embedded", null], ["xabc", "external", "srt"]]);
  });
});

describe("subtitle cues", () => {
  const ass = [
    "[Script Info]", "Title: t", "", "[V4+ Styles]", "Format: Name, Fontname", "Style: Default,Arial", "",
    "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,{\\an8}第一句, 带逗号\\N第二行",
    "Dialogue: 0,0:01:00.00,0:01:02.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}",
    "Dialogue: 0,1:00:00.00,1:00:01.50,Default,,0,0,0,,很晚的一句",
    "Comment: 0,0:00:10.00,0:00:11.00,Default,,0,0,0,,注释不是台词",
  ].join("\r\n");

  it("reads ASS dialogue as plain text, keeps commas in the text, and skips drawings and comments", () => {
    const cues = parseAssCues(`﻿${ass}`);
    expect(cues).toEqual([
      { startMs: 1000, endMs: 3500, text: "第一句, 带逗号\n第二行" },
      { startMs: 3_600_000, endMs: 3_601_500, text: "很晚的一句" },
    ]);
  });

  it("reads SRT and WebVTT, with or without hours, stripping markup", () => {
    const srt = "1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>你好</i>\r\n\r\n2\r\n00:01:00,250 --> 00:01:01,000 align:start\r\n{\\an8}再见\r\n";
    expect(parseSrtCues(srt)).toEqual([{ startMs: 1000, endMs: 2500, text: "你好" }, { startMs: 60_250, endMs: 61_000, text: "再见" }]);
    expect(parseCues("WEBVTT\n\n00:01.000 --> 00:02.000\nhi\n", "vtt")).toEqual([{ startMs: 1000, endMs: 2000, text: "hi" }]);
  });

  it("limits a window to what has been seen, so a reader is not spoiled by later lines", () => {
    const cues = parseAssCues(ass);
    expect(cueWindow(cues, 0, 5000)).toHaveLength(1);
    expect(cueWindow(cues, 0, 4_000_000)).toHaveLength(2);
    expect(cueWindow(cues, 0, 4_000_000, 10_000)).toHaveLength(1);
  });
});

describe("sidecars and fingerprints", () => {
  it("matches subtitle files by the video's name, in the folder or a Subs folder, and skips other episodes", () => {
    const dir = fs.mkdtempSync(path.join(root, "side-"));
    fs.mkdirSync(path.join(dir, "Subs"));
    for (const name of ["Ep 01.mkv", "Ep 01.ass", "Ep 01.zh-CN.srt", "Ep 01.forced.srt", "Ep 010.srt", "Ep 02.srt", "Ep 01 notes.txt", "Subs/Ep 01.chs.vtt", "Subs/Ep 02.chs.vtt"]) fs.writeFileSync(path.join(dir, name), "x");
    const found = discoverSidecars(path.join(dir, "Ep 01.mkv"));
    expect(found.map((item) => item.fileName)).toEqual(["Ep 01.ass", "Ep 01.chs.vtt", "Ep 01.forced.srt", "Ep 01.zh-CN.srt"]);
    expect(found.find((item) => item.fileName === "Ep 01.zh-CN.srt")?.language).toBe("zh-CN");
    expect(found.find((item) => item.fileName === "Ep 01.chs.vtt")?.language).toBe("chs");
    expect(found.find((item) => item.fileName === "Ep 01.forced.srt")?.language).toBeUndefined();
    expect(new Set(found.map((item) => item.id)).size).toBe(found.length);
  });

  it("fingerprints a large file by size and three windows, and notices a change in any window", async () => {
    const file = path.join(root, "big.bin");
    const size = 20 * 1024 * 1024;
    const body = Buffer.alloc(size, 7);
    fs.writeFileSync(file, body);
    const before = await sampledFingerprint(file);
    expect(before).toMatch(/^sv1:[0-9a-f]{64}$/);
    expect(await sampledFingerprint(file)).toBe(before);
    for (const offset of [10, Math.floor(size / 2), size - 10]) {
      const copy = Buffer.from(body);
      copy[offset] = 9;
      fs.writeFileSync(file, copy);
      expect(await sampledFingerprint(file), `change at ${offset}`).not.toBe(before);
    }
    // A change outside the windows is not seen: that is the price of not reading the whole file.
    const quiet = Buffer.from(body);
    quiet[5 * 1024 * 1024] = 9;
    fs.writeFileSync(file, quiet);
    expect(await sampledFingerprint(file)).toBe(before);
    fs.writeFileSync(file, body.subarray(0, size - 1));
    expect(await sampledFingerprint(file)).not.toBe(before);
  });
});

describe("compareTimelines", () => {
  it("lines two timelines up from their own first frame and reports the largest drift", () => {
    const original = Array.from({ length: 100 }, (_, i) => 2500 + i * (1000 / 24));
    const copy = original.map((time) => time - 2500);
    expect(compareTimelines(original, copy)).toMatchObject({ ok: true, originalFrames: 100, copyFrames: 100, maxDriftMs: 0 });
    const shifted = copy.map((time, i) => (i === 50 ? time + 5 : time));
    expect(compareTimelines(original, shifted)).toMatchObject({ ok: false, maxDriftMs: 5 });
    expect(compareTimelines(original, copy.slice(1)).ok).toBe(false);
  });
});
