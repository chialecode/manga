import type { PlaybackDecision, VideoProbe, VideoStreamInfo } from "@manga/contracts";

/** What the renderer found out about this machine, plus what the owner forced. Everything else is decided from the file. */
export type PlaybackCaps = {
  /** True when `mediaCapabilities` says HEVC decodes in hardware here. Chromium on Windows has no software HEVC decoder. */
  hardwareHevc: boolean;
  /** The owner asked for a play copy even where direct playback would work (a testing and troubleshooting switch). */
  forcePlayCopy?: boolean;
  /** Audio codecs the renderer reported as playable, replacing the built-in list when present. */
  audioCodecs?: string[];
};

export type PlayCopyReason = "no_hardware_hevc" | "unsupported_audio" | "audio_track" | "unsupported_video";

export type PlaybackPlan = {
  decision: PlaybackDecision;
  /** Why the plan is not "direct"; empty for direct playback. */
  reasons: Array<PlayCopyReason | "unsupported_container" | "forced">;
  videoStreamIndex: number | null;
  audioStreamIndex: number | null;
  mediaType: string;
  /** For `play_copy` and `remux`: how each stream gets into the copy. */
  copy?: { reason: PlayCopyReason | "unsupported_container"; video: "copy" | "encode"; audio: "copy" | "aac" | "none" };
  /** Short sentence for the player, in plain words; the UI localises around it. */
  detail: string;
};

const DIRECT_CONTAINERS = new Set(["mov", "mp4", "m4a", "matroska", "webm"]);
/** Chromium decodes these with its own or the platform's decoders. */
const DIRECT_VIDEO = new Set(["h264", "vp8", "vp9", "av1", "theora"]);
const DIRECT_AUDIO = new Set(["aac", "mp3", "opus", "vorbis", "flac", "pcm_s16le", "pcm_s24le", "pcm_f32le", "alac"]);

export function mediaTypeFor(probe: Pick<VideoProbe, "formatNames">): string {
  if (probe.formatNames.includes("webm")) return "video/webm";
  if (probe.formatNames.includes("matroska")) return "video/x-matroska";
  return "video/mp4";
}

export function containerPlayable(probe: Pick<VideoProbe, "formatNames">): boolean {
  return probe.formatNames.some((name) => DIRECT_CONTAINERS.has(name));
}

function videoPlayable(stream: VideoStreamInfo, caps: PlaybackCaps): { ok: boolean; reason?: PlayCopyReason } {
  const codec = stream.codec.toLowerCase();
  if (codec === "hevc") return caps.hardwareHevc && (stream.bitDepth ?? 8) <= 10 ? { ok: true } : { ok: false, reason: "no_hardware_hevc" };
  // Chromium has no software path for 10-bit H.264.
  if (codec === "h264") return (stream.bitDepth ?? 8) <= 8 ? { ok: true } : { ok: false, reason: "unsupported_video" };
  return DIRECT_VIDEO.has(codec) ? { ok: true } : { ok: false, reason: "unsupported_video" };
}

function audioPlayable(stream: VideoStreamInfo, caps: PlaybackCaps): boolean {
  const codec = stream.codec.toLowerCase();
  const known = caps.audioCodecs ? new Set(caps.audioCodecs.map((item) => item.toLowerCase())) : DIRECT_AUDIO;
  return known.has(codec);
}

/**
 * Decide how a file is played on this machine: straight from the original, with the container rewritten, or from a play
 * copy. Copies never change what the user's notes point at: all times stay on the original timeline.
 */
export function decidePlayback(probe: VideoProbe, caps: PlaybackCaps, options: { audioStreamIndex?: number } = {}): PlaybackPlan {
  const videos = probe.streams.filter((stream) => stream.type === "video");
  // Cover art and still images ride along as "video" streams in some files; the film is the one with a frame rate or the most pixels.
  const video = [...videos].sort((a, b) => (b.fps ? 1 : 0) - (a.fps ? 1 : 0) || (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0))[0];
  const audios = probe.streams.filter((stream) => stream.type === "audio");
  const mediaType = mediaTypeFor(probe);
  if (!video) return { decision: "unsupported", reasons: ["unsupported_video"], videoStreamIndex: null, audioStreamIndex: null, mediaType, detail: "the file has no video stream" };
  const defaultAudio = audios.find((stream) => stream.default) ?? audios[0];
  const selected = options.audioStreamIndex !== undefined ? audios.find((stream) => stream.index === options.audioStreamIndex) : defaultAudio;
  const base = { videoStreamIndex: video.index, audioStreamIndex: selected?.index ?? null, mediaType };
  if (options.audioStreamIndex !== undefined && !selected) return { decision: "unsupported", reasons: [], ...base, audioStreamIndex: null, detail: "that audio track does not exist" };

  const reasons: PlaybackPlan["reasons"] = [];
  const v = videoPlayable(video, caps);
  const audioOk = !selected || audioPlayable(selected, caps);
  const containerOk = containerPlayable(probe);
  // The browser plays the file's default audio stream; any other track has to be put first in a copy.
  const alternateAudio = options.audioStreamIndex !== undefined && selected !== undefined && selected !== defaultAudio;
  if (caps.forcePlayCopy) reasons.push("forced");
  if (!v.ok) reasons.push(v.reason!);
  if (!audioOk) reasons.push("unsupported_audio");
  if (!containerOk) reasons.push("unsupported_container");
  if (alternateAudio) reasons.push("audio_track");

  if (!reasons.length) return { decision: "direct", reasons, ...base, detail: "plays directly from the original" };

  if (v.ok && audioOk && !caps.forcePlayCopy) {
    const reason = !containerOk ? "unsupported_container" : "audio_track";
    return {
      decision: "remux", reasons, ...base,
      copy: { reason, video: "copy", audio: selected ? "copy" : "none" },
      detail: reason === "audio_track" ? "the selected audio track is put first in a copy; the picture is copied unchanged" : "the container is rewritten without re-encoding",
    };
  }
  const videoMode = v.ok ? "copy" : "encode";
  const audioMode = !selected ? "none" : audioOk ? "copy" : "aac";
  const reason: PlayCopyReason = !v.ok ? v.reason! : "unsupported_audio";
  return {
    decision: "play_copy",
    reasons,
    ...base,
    copy: { reason: caps.forcePlayCopy && v.ok && audioOk ? (video.codec === "hevc" ? "no_hardware_hevc" : "unsupported_video") : reason, video: videoMode, audio: audioMode },
    detail: videoMode === "encode" ? "a play copy is made; the original is not changed" : "the audio is converted; the picture is copied unchanged",
  };
}

/** Streams of a probe the player lists. Subtitle and audio entries carry what a menu needs and nothing about files. */
export function listTracks(probe: VideoProbe) {
  const audio = probe.streams.filter((stream) => stream.type === "audio").map((stream) => ({
    index: stream.index, codec: stream.codec, language: stream.language ?? null, title: stream.title ?? null, channels: stream.channels ?? null, default: stream.default === true,
  }));
  const embedded = probe.streams.filter((stream) => stream.type === "subtitle").map((stream) => ({
    id: `s${stream.index}`, source: "embedded" as const, streamIndex: stream.index, codec: stream.codec,
    format: stream.codec === "ass" || stream.codec === "ssa" ? "ass" as const : stream.textual ? "srt" as const : null,
    language: stream.language ?? null, title: stream.title ?? null, default: stream.default === true,
  }));
  const external = probe.externalSubtitles.map((item) => ({
    id: item.id, source: "external" as const, streamIndex: null, codec: item.format, format: item.format === "vtt" ? "srt" as const : item.format, language: item.language ?? null, title: item.fileName, default: false,
  }));
  return { audio, subtitles: [...embedded, ...external], attachments: probe.streams.filter((stream) => stream.type === "attachment").map((stream) => ({ index: stream.index, fileName: stream.fileName ?? null, mimeType: stream.mimeType ?? null })) };
}
