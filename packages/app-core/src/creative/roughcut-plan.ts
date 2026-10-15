import type { RoughcutExportOptions, RoughcutProblem, RoughcutStreams } from "@manga/contracts";

/**
 * What a copy of one stretch of a video can be, worked out from the frame times and keyframe times of the source alone (nothing is decoded).
 * A copy starts on a keyframe, so the start moves back to the one at or before the request; it ends at a frame boundary, so the end moves on
 * to the first frame at or after the request. The cut always holds at least what was asked for.
 */
export type ClipCut = {
  actualInMs: number;
  actualOutMs: number;
  /** The copy runs to the end of the file, so no length is given to the tool. */
  toEnd: boolean;
  onKeyframe: boolean;
  /** Video frames the copy holds: those from the start keyframe up to, not including, the end. */
  frames: number;
  /** The shortest gap between two frames around the end, in ms: half of it is how early the tool is told to stop so a frame on the boundary stays out. */
  frameGapMs: number;
  problems: Array<"range" | "no-keyframe">;
};

/** Times from the frame index are rounded to a thousandth of a second; two times closer than this are the same instant. */
const SAME = 0.5;

/** First index whose value is at or above `value` (the array is sorted). */
function lowerBound(values: number[], value: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid]! < value) low = mid + 1; else high = mid;
  }
  return low;
}

export function planClipCut(request: { inMs: number; outMs: number }, index: { ptsMs: number[]; keyframesMs: number[] }, durationMs: number): ClipCut {
  const { ptsMs, keyframesMs } = index;
  const base: ClipCut = { actualInMs: request.inMs, actualOutMs: request.outMs, toEnd: false, onKeyframe: false, frames: 0, frameGapMs: 0, problems: [] };
  if (!(request.inMs >= 0 && request.outMs > request.inMs && request.inMs < durationMs) || !ptsMs.length) return { ...base, problems: ["range"] };
  // The keyframe at or before the requested start.
  const after = lowerBound(keyframesMs, request.inMs + SAME + 1e-9);
  const keyframe = after > 0 ? keyframesMs[after - 1]! : null;
  if (keyframe === null) return { ...base, problems: ["no-keyframe"] };
  // The first frame at or after the requested end; none means the copy runs to the end of the file.
  const next = lowerBound(ptsMs, request.outMs - SAME);
  const toEnd = next >= ptsMs.length;
  const end = toEnd ? Math.max(durationMs, ptsMs[ptsMs.length - 1]!) : ptsMs[next]!;
  const first = lowerBound(ptsMs, keyframe - SAME);
  const last = toEnd ? ptsMs.length : next;
  const before = ptsMs[Math.max(0, last - 1)]!;
  const gap = toEnd ? 0 : Math.max(1, end - before);
  return {
    actualInMs: keyframe, actualOutMs: end, toEnd, onKeyframe: Math.abs(keyframe - request.inMs) <= SAME,
    frames: Math.max(0, last - first), frameGapMs: gap, problems: [],
  };
}

type FfprobeStream = Record<string, unknown> & { codec_type?: string; tags?: Record<string, unknown> };
type FfprobeJson = { format?: { format_name?: string }; streams?: FfprobeStream[] };

const text = (value: unknown, fallback = ""): string => (value === undefined || value === null ? fallback : String(value));
const hashOf = (stream: FfprobeStream): string => text(stream.extradata_hash, text(stream.extradata_size, "0"));
/** A tag of a stream by name, whatever the case the container wrote it in. */
const tagOf = (stream: FfprobeStream, name: string): string => {
  const tags = stream.tags ?? {};
  const key = Object.keys(tags).find((candidate) => candidate.toLowerCase() === name);
  return key ? text(tags[key]).slice(0, 120) : "";
};

/**
 * The parts of a source's streams a copy depends on, from `ffprobe -show_streams -show_data_hash`. Two clips are joined without re-encoding only if
 * these agree: the first video stream and every audio stream, with the container they are in.
 */
export function streamsFromProbe(json: FfprobeJson): RoughcutStreams | null {
  const streams = json.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video" && !(stream.disposition as { attached_pic?: number } | undefined)?.attached_pic);
  if (!video) return null;
  const formats = text(json.format?.format_name).split(",").filter(Boolean);
  return {
    container: formats.includes("matroska") ? "matroska" : formats.includes("mov") ? "mov" : formats[0] ?? "unknown",
    video: {
      codec: text(video.codec_name, "unknown"), profile: text(video.profile, "-"), width: Number(video.width) || 0, height: Number(video.height) || 0,
      pixelFormat: text(video.pix_fmt, "-"), frameRate: text(video.r_frame_rate, "-"), timeBase: text(video.time_base, "-"), parameters: hashOf(video),
    },
    audio: streams.filter((stream) => stream.codec_type === "audio").map((stream) => ({
      codec: text(stream.codec_name, "unknown"), sampleRate: Number(stream.sample_rate) || 0, channels: Number(stream.channels) || 0, timeBase: text(stream.time_base, "-"), parameters: hashOf(stream),
      language: tagOf(stream, "language"), title: tagOf(stream, "title"),
    })),
    subtitle: streams.filter((stream) => stream.codec_type === "subtitle").map((stream) => ({ codec: text(stream.codec_name, "unknown"), language: tagOf(stream, "language"), title: tagOf(stream, "title") })),
  };
}

/** The audio tracks an export keeps, by place: all of them unless the options name some. */
export function keptAudio(streams: RoughcutStreams, options: RoughcutExportOptions): number[] {
  return options.audioTracks ? [...new Set(options.audioTracks)].sort((a, b) => a - b) : streams.audio.map((_, index) => index);
}

export function keptSubtitles(options: RoughcutExportOptions): number[] {
  return options.subtitleTracks ? [...new Set(options.subtitleTracks)].sort((a, b) => a - b) : [];
}

/**
 * Whether a subtitle track can be written to a file of this extension without changing it. MP4 and MOV take text in their own form only, WebM takes WebVTT,
 * and Matroska takes anything. A picture-based track (PGS, DVD) cannot go into the first two.
 */
export function subtitleFits(codec: string, extension: string): boolean {
  if (extension === "mkv") return true;
  if (extension === "webm") return codec === "webvtt";
  return codec === "mov_text" || codec === "tx3g";
}

/** The first difference that stops `other` from being joined after `first` by copying, or nothing when they agree. Everything is compared, but only the first problem of each kind is reported. */
export function compareStreams(first: RoughcutStreams, other: RoughcutStreams, clipId: string, options: RoughcutExportOptions = { mode: "merge" }): RoughcutProblem[] {
  const problems: RoughcutProblem[] = [];
  const add = (code: RoughcutProblem["code"], a: string | number, b: string | number) => problems.push({ code, clipId, detail: { first: a, other: b } });
  if (first.container !== other.container) add("container", first.container, other.container);
  if (first.video.codec !== other.video.codec) add("video-codec", first.video.codec, other.video.codec);
  else if (first.video.profile !== other.video.profile || first.video.parameters !== other.video.parameters) add("video-profile", first.video.profile, other.video.profile);
  if (first.video.width !== other.video.width || first.video.height !== other.video.height) add("resolution", `${first.video.width}x${first.video.height}`, `${other.video.width}x${other.video.height}`);
  if (first.video.pixelFormat !== other.video.pixelFormat) add("pixel-format", first.video.pixelFormat, other.video.pixelFormat);
  if (first.video.frameRate !== other.video.frameRate) add("frame-rate", first.video.frameRate, other.video.frameRate);
  if (first.video.timeBase !== other.video.timeBase) add("time-base", first.video.timeBase, other.video.timeBase);
  // Only the audio tracks that are kept have to agree; the others are not in the finished file.
  const kept = keptAudio(first, options);
  if (!options.audioTracks && first.audio.length !== other.audio.length) add("audio-tracks", first.audio.length, other.audio.length);
  else {
    for (const i of kept) {
      const a = first.audio[i];
      const b = other.audio[i];
      // A kept track a clip lacks is that clip's own problem (`trackProblems`), not a difference between two clips.
      if (!a || !b) continue;
      if (a.codec !== b.codec) { add("audio-codec", a.codec, b.codec); break; }
      if (a.sampleRate !== b.sampleRate || a.channels !== b.channels || a.timeBase !== b.timeBase || a.parameters !== b.parameters) { add("audio-format", `${a.sampleRate} Hz ${a.channels} ch`, `${b.sampleRate} Hz ${b.channels} ch`); break; }
    }
  }
  for (const i of keptSubtitles(options)) {
    const a = first.subtitle[i];
    const b = other.subtitle[i];
    if (a && b && a.codec !== b.codec) { add("subtitle-codec", a.codec, b.codec); break; }
  }
  return problems;
}

/** The chosen tracks that a clip's own source does not have, or that its container cannot hold, as problems of that clip. */
export function trackProblems(streams: RoughcutStreams, extension: string | null, options: RoughcutExportOptions, clipId: string): RoughcutProblem[] {
  const problems: RoughcutProblem[] = [];
  for (const i of keptAudio(streams, options)) {
    if (!streams.audio[i]) { problems.push({ code: "track-missing", clipId, detail: { first: `audio ${i + 1}`, other: streams.audio.length } }); break; }
  }
  for (const i of keptSubtitles(options)) {
    const track = streams.subtitle[i];
    if (!track) { problems.push({ code: "track-missing", clipId, detail: { first: `subtitle ${i + 1}`, other: streams.subtitle.length } }); break; }
    if (extension && !subtitleFits(track.codec, extension)) { problems.push({ code: "subtitle-container", clipId, detail: { first: track.codec, other: extension } }); break; }
  }
  return problems;
}


/** A value in a metadata file for the media tool: `=`, `;`, `#` and `\` are written with a backslash, and a title stays on one line. */
const metadataText = (value: string): string => value.replace(/\r\n|\r|\n/g, " ").replace(/[\\=;#]/g, (char) => `\\${char}`);

/**
 * The chapters of a merged file as a metadata file for the media tool: one for each clip, in milliseconds, starting where the clip's copy starts in the
 * finished file and ending where it ends. The first clip starts at zero, and each clip begins where the one before it ended.
 */
export function chapterMetadata(chapters: Array<{ title: string; lengthMs: number }>): string {
  const lines = [";FFMETADATA1"];
  let at = 0;
  for (const chapter of chapters) {
    const start = Math.round(at);
    at += chapter.lengthMs;
    lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${start}`, `END=${Math.max(start + 1, Math.round(at))}`, `title=${metadataText(chapter.title)}`);
  }
  return `${lines.join("\n")}\n`;
}


/** The extension of the finished file: the first clip's own when it is one a copy can write, else the usual one for its container. */
export function outputExtension(container: string, sourceName: string): string | null {
  const own = /\.([a-z0-9]+)$/i.exec(sourceName)?.[1]?.toLowerCase() ?? "";
  if (container === "matroska") return own === "webm" ? "webm" : "mkv";
  if (container === "mov") return own === "mov" || own === "m4v" ? own : "mp4";
  return null;
}

/** The muxer the tool is told to write, since the temporary name does not say. */
export function muxerFor(extension: string): string {
  return extension === "mkv" ? "matroska" : extension === "webm" ? "webm" : extension === "mov" ? "mov" : "mp4";
}
