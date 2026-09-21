import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { MangaError } from "@manga/contracts";

export type MediaProbe = {
  container: string;
  durationMs: number;
  video?: { codec: string; fps?: number; width?: number; height?: number; startMs?: number };
  audio?: { codec: string; channels?: number; startMs?: number };
  subtitle?: string[];
  keyframeInterval?: number;
  keyframesMs?: number[];
};

export function runFfprobe(file: string): Record<string, unknown> {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    file,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new MangaError("UNSUPPORTED_FORMAT", result.stderr || "ffprobe failed", { details: { file } });
  }
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

export function probeMedia(file: string): MediaProbe {
  const json = runFfprobe(file);
  const format = json.format as { duration?: string; format_name?: string };
  const streams = json.streams as Array<Record<string, unknown>>;
  const video = streams.find((item) => item.codec_type === "video");
  const audio = streams.find((item) => item.codec_type === "audio");
  const subs = streams.filter((item) => item.codec_type === "subtitle").map((item) => String(item.codec_name));
  const frames=spawnSync("ffprobe",["-v","error","-select_streams","v:0","-skip_frame","nokey","-show_frames","-show_entries","frame=best_effort_timestamp_time","-of","json",file],{encoding:"utf8",maxBuffer:8*1024*1024});
  if(frames.status !== 0) throw new MangaError("UNSUPPORTED_FORMAT", "keyframe probe failed");
  const keyframesMs=(JSON.parse(frames.stdout).frames ?? []).map((frame:{best_effort_timestamp_time?:string})=>Number(frame.best_effort_timestamp_time)*1000).filter(Number.isFinite);
  const [numerator,denominator]=String(video?.avg_frame_rate ?? "0/1").split("/").map(Number);
  return {
    container: String(format.format_name ?? path.extname(file).slice(1)),
    durationMs: Math.round(Number(format.duration ?? 0) * 1000),
    video: video ? {
      codec: String(video.codec_name),
      fps: denominator ? numerator! / denominator : undefined,
      width: Number(video.width),
      height: Number(video.height),
      startMs: Math.round(Number(video.start_time ?? 0) * 1000),
    } : undefined,
    audio: audio ? {
      codec: String(audio.codec_name),
      channels: Number(audio.channels),
      startMs: Math.round(Number(audio.start_time ?? 0) * 1000),
    } : undefined,
    subtitle: subs,
    keyframesMs,
  };
}

export type CutPlan = {
  requestedStartMs: number;
  requestedEndMs: number;
  keyframeAligned: boolean;
  compatible: boolean;
  reason?: string;
};

export function planLosslessCut(probe: MediaProbe, startMs: number, endMs: number): CutPlan {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs || endMs > probe.durationMs) return {requestedStartMs:startMs,requestedEndMs:endMs,keyframeAligned:false,compatible:false,reason:"invalid time range"};
  if (!probe.video || probe.video.codec !== "h264" || probe.audio && probe.audio.codec !== "aac") {
    return {
      requestedStartMs: startMs,
      requestedEndMs: endMs,
      keyframeAligned: false,
      compatible: false,
      reason: "incompatible codecs for copy cut",
    };
  }
  if ((probe.container.includes("mp4") || probe.container.includes("mov") || probe.container.includes("matroska")) === false) {
    return {
      requestedStartMs: startMs,
      requestedEndMs: endMs,
      keyframeAligned: false,
      compatible: false,
      reason: "container not in copy allowlist",
    };
  }
  return {
    requestedStartMs: startMs,
    requestedEndMs: endMs,
    keyframeAligned: probe.keyframesMs?.some(time => Math.abs(time - startMs) <= 1) ?? false,
    compatible: true,
  };
}

export function cutCopy(input: string, output: string, startMs: number, durationMs: number): void {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync("ffmpeg", [
    "-y",
    "-ss", (startMs / 1000).toFixed(3),
    "-i", input,
    "-t", (durationMs / 1000).toFixed(3),
    "-c", "copy",
    "-avoid_negative_ts", "make_zero",
    output,
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new MangaError("UNSUPPORTED_FORMAT", result.stderr || "ffmpeg cut failed");
  }
}

export function concatCompatibility(left: MediaProbe, right: MediaProbe): { compatible: boolean; reason?: string } {
  if (!left.video || !right.video || left.video.codec !== right.video.codec) {
    return { compatible: false, reason: "video codec mismatch" };
  }
  if ((left.audio?.codec ?? null) !== (right.audio?.codec ?? null)) {
    return { compatible: false, reason: "audio codec mismatch" };
  }
  const leftContainer = left.container.includes("mp4") || left.container.includes("mov");
  const rightContainer = right.container.includes("mp4") || right.container.includes("mov");
  if (!leftContainer || !rightContainer) return { compatible: false, reason: "container not concat-copy allowlisted" };
  return { compatible: true };
}

export function concatCopy(inputs: string[], output: string): void {
  if (inputs.length < 2) throw new MangaError("VALIDATION_ERROR", "concat requires at least two inputs");
  const probes = inputs.map((file) => probeMedia(file));
  for (let i = 1; i < probes.length; i += 1) {
    const check = concatCompatibility(probes[0]!, probes[i]!);
    if (!check.compatible) throw new MangaError("UNSUPPORTED_FORMAT", check.reason ?? "incompatible concat");
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const list = path.join(path.dirname(output), `concat-${process.pid}.txt`);
  fs.writeFileSync(list, inputs.map((file) => `file '${file.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`).join("\n"));
  const result = spawnSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", output], { encoding: "utf8" });
  fs.rmSync(list, { force: true });
  if (result.status !== 0) throw new MangaError("UNSUPPORTED_FORMAT", result.stderr || "ffmpeg concat failed");
}

export function generateMedia(output: string, options: {
  durationSec?: number;
  gop?: number;
  audioHz?: number;
  size?: string;
  itsoffset?: number;
}): void {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const duration = options.durationSec ?? 4;
  const args = [
    "-y",
    "-f", "lavfi", "-i", `testsrc=duration=${duration}:size=${options.size ?? "320x240"}:rate=24`,
  ];
  if (options.itsoffset) args.push("-itsoffset", String(options.itsoffset));
  args.push(
    "-f", "lavfi", "-i", `sine=frequency=${options.audioHz ?? 1000}:duration=${duration}`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", String(options.gop ?? 48),
    "-c:a", "aac", "-shortest",
    output,
  );
  const result = spawnSync("ffmpeg", args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new MangaError("UNSUPPORTED_FORMAT", result.stderr || "ffmpeg generate failed");
  }
}
