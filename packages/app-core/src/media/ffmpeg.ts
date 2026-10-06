import fs from "node:fs";
import path from "node:path";
import { MangaError } from "@manga/contracts";
import type { VideoProbe, VideoStreamInfo } from "@manga/contracts";
import { Lane, runTool, type ToolRun, type ToolRunOptions } from "./process-runner.ts";

export type FfmpegTools = { binDir: string; ffmpeg: string; ffprobe: string };

const EXE = process.platform === "win32" ? ".exe" : "";

function toolsAt(binDir: string): FfmpegTools | null {
  const ffmpeg = path.join(binDir, `ffmpeg${EXE}`);
  const ffprobe = path.join(binDir, `ffprobe${EXE}`);
  return fs.existsSync(ffmpeg) && fs.existsSync(ffprobe) ? { binDir, ffmpeg, ffprobe } : null;
}

/** Walk up from a start directory until the workspace root, which is where the development copy of FFmpeg lives. */
function workspaceRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Where FFmpeg is looked for, in order: an explicit directory (`MANGA_FFMPEG_DIR`), the copy shipped with a packaged
 * build, and the development copy under `dist/tools/ffmpeg`. A missing tool is a capability the caller reports; it is
 * never searched for on PATH, because the support matrix is stated against one pinned build.
 */
export function locateFfmpeg(options: { env?: NodeJS.ProcessEnv; resourcesPath?: string; cwd?: string } = {}): FfmpegTools | null {
  const env = options.env ?? process.env;
  const candidates: string[] = [];
  if (env.MANGA_FFMPEG_DIR) candidates.push(env.MANGA_FFMPEG_DIR, path.join(env.MANGA_FFMPEG_DIR, "bin"));
  const resources = options.resourcesPath ?? (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resources) candidates.push(path.join(resources, "ffmpeg", "bin"), path.join(resources, "ffmpeg"));
  const root = workspaceRoot(options.cwd ?? process.cwd()) ?? workspaceRoot(import.meta.dirname ?? ".");
  if (root) {
    const base = path.join(root, "dist", "tools", "ffmpeg");
    if (fs.existsSync(base)) {
      for (const name of fs.readdirSync(base).sort().reverse()) candidates.push(path.join(base, name, "bin"));
    }
  }
  for (const dir of candidates) {
    const found = toolsAt(dir);
    if (found) return found;
  }
  return null;
}

const TEXT_SUBTITLE_CODECS = new Set(["ass", "ssa", "subrip", "srt", "webvtt", "mov_text", "text"]);

function parseRate(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const [num, den] = value.split("/").map(Number);
  if (!num || !den) return undefined;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 && fps < 1000 ? Math.round(fps * 1000) / 1000 : undefined;
}

function bitDepthOf(stream: Record<string, unknown>): number | undefined {
  const raw = Number(stream.bits_per_raw_sample);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const match = /(\d{2})(?:le|be)$/.exec(String(stream.pix_fmt ?? ""));
  if (match) return Number(match[1]);
  return stream.pix_fmt ? 8 : undefined;
}

const seconds = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

type FfprobeJson = {
  format?: Record<string, any>;
  streams?: Array<Record<string, any>>;
  chapters?: Array<Record<string, any>>;
};

/** Translate ffprobe's JSON into the stored probe. Everything optional stays optional: a stream with no language has none. */
export function probeFromJson(json: FfprobeJson, tool: { name: string; version: string }): Omit<VideoProbe, "keyframesMs" | "keyframesTruncated" | "variableFrameRate" | "externalSubtitles"> {
  const format = json.format ?? {};
  const streams: VideoStreamInfo[] = (json.streams ?? []).map((raw) => {
    const type = (["video", "audio", "subtitle", "attachment", "data"].includes(raw.codec_type) ? raw.codec_type : "data") as VideoStreamInfo["type"];
    const tags = (raw.tags ?? {}) as Record<string, string>;
    const lower = Object.fromEntries(Object.entries(tags).map(([key, value]) => [key.toLowerCase(), value]));
    const stream: VideoStreamInfo = {
      index: Number(raw.index),
      type,
      codec: String(raw.codec_name ?? "unknown"),
      ...(raw.profile ? { profile: String(raw.profile) } : {}),
      ...(lower.language && lower.language !== "und" ? { language: lower.language } : {}),
      ...(lower.title ? { title: lower.title } : {}),
      ...(raw.disposition?.default === 1 ? { default: true } : {}),
    };
    if (type === "video") {
      Object.assign(stream, {
        width: Number(raw.width) || undefined,
        height: Number(raw.height) || undefined,
        pixelFormat: raw.pix_fmt ? String(raw.pix_fmt) : undefined,
        bitDepth: bitDepthOf(raw),
        fps: parseRate(raw.avg_frame_rate) ?? parseRate(raw.r_frame_rate),
      });
    } else if (type === "audio") {
      Object.assign(stream, { channels: Number(raw.channels) || undefined, sampleRate: Number(raw.sample_rate) || undefined });
    } else if (type === "subtitle") {
      stream.textual = TEXT_SUBTITLE_CODECS.has(stream.codec);
    } else if (type === "attachment") {
      if (lower.mimetype) stream.mimeType = lower.mimetype;
      if (lower.filename) stream.fileName = lower.filename;
    }
    return Object.fromEntries(Object.entries(stream).filter(([, value]) => value !== undefined)) as VideoStreamInfo;
  });
  const names = String(format.format_name ?? "").split(",").filter(Boolean);
  // Container tags (title, artist, date...): a few short ones, lower-cased, for the local-file metadata source.
  const rawTags = (format.tags ?? {}) as Record<string, unknown>;
  const tagEntries = Object.entries(rawTags).filter(([, value]) => typeof value === "string" && value.trim() !== "").slice(0, 24).map(([key, value]) => [key.toLowerCase().slice(0, 48), String(value).slice(0, 512)] as const);
  const statedMs = Math.round((seconds(format.duration) ?? 0) * 1000);
  const startMs = Math.round((seconds(format.start_time) ?? 0) * 1000);
  return {
    container: names[0] ?? "unknown",
    formatNames: names,
    // Matroska states its length as the last timestamp, so a file that starts late is longer on paper than it plays; the
    // length counted from the start of the file is what the frame index, progress and the player use.
    durationMs: names.includes("matroska") && startMs > 0 ? Math.max(0, statedMs - startMs) : statedMs,
    startMs,
    ...(seconds(format.bit_rate) ? { bitRate: Number(format.bit_rate) } : {}),
    ...(tagEntries.length ? { tags: Object.fromEntries(tagEntries) } : {}),
    streams,
    chapters: (json.chapters ?? []).map((chapter) => ({
      startMs: Math.round((seconds(chapter.start_time) ?? 0) * 1000),
      endMs: Math.round((seconds(chapter.end_time) ?? 0) * 1000),
      ...(chapter.tags?.title ? { title: String(chapter.tags.title) } : {}),
    })),
    tool,
  };
}

export type PacketTimeline = {
  /** Presentation times of the video packets in display order, in milliseconds from the container start. */
  ptsMs: number[];
  keyframesMs: number[];
  variableFrameRate: boolean;
};

/** Frame times from packet timestamps (no decoding): sort the presentation times, which undoes decode-order reordering. */
export function timelineFromPackets(lines: string[], startMs: number): PacketTimeline {
  const pts: number[] = [];
  const keys: number[] = [];
  for (const line of lines) {
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const text = line.slice(0, comma).trim();
    const time = text === "" ? Number.NaN : Number(text);
    if (!Number.isFinite(time)) continue;
    const ms = Math.round(time * 1000 * 1000) / 1000 - startMs;
    pts.push(ms);
    if (line.slice(comma + 1).includes("K")) keys.push(ms);
  }
  pts.sort((a, b) => a - b);
  keys.sort((a, b) => a - b);
  let variable = false;
  if (pts.length > 8) {
    const deltas: number[] = [];
    for (let i = 1; i < pts.length; i += 1) deltas.push(pts[i]! - pts[i - 1]!);
    const sorted = [...deltas].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    const p5 = sorted[Math.floor(sorted.length * 0.05)]!;
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    variable = median > 0 && (p95 - p5) / median > 0.1;
  }
  return { ptsMs: pts, keyframesMs: keys, variableFrameRate: variable };
}

export type FfmpegRunOptions = Omit<ToolRunOptions, "redact"> & { redactPaths?: string[] };

/**
 * FFmpeg as a subprocess behind a concurrency cap. A missing build is reported as a capability gap; a tool that fails
 * returns its (path-redacted) complaint in the error and leaves nothing running.
 */
export class FfmpegService {
  private readonly lane: Lane;
  private versionText: string | undefined;

  readonly tools: FfmpegTools | null;

  constructor(tools: FfmpegTools | null, options: { concurrency?: number } = {}) {
    this.tools = tools;
    this.lane = new Lane(options.concurrency ?? 2);
  }

  get available(): boolean { return this.tools !== null; }

  private require(): FfmpegTools {
    if (!this.tools) throw new MangaError("CAPABILITY_UNAVAILABLE", "the media tool is not installed");
    return this.tools;
  }

  stats(): { running: number; queued: number; limit: number } {
    return { running: this.lane.running, queued: this.lane.queued, limit: this.lane.limit };
  }

  async version(): Promise<string> {
    if (this.versionText) return this.versionText;
    const tools = this.require();
    const run = await runTool(tools.ffmpeg, ["-version"], { timeoutMs: 15_000 });
    const first = run.stdout.toString("utf8").split(/\r?\n/)[0] ?? "";
    this.versionText = /version\s+(\S+)/.exec(first)?.[1] ?? first.trim();
    return this.versionText;
  }

  /** Raw run of ffmpeg or ffprobe under the lane cap. A non-zero exit throws unless `allowFailure` is set. */
  async run(tool: "ffmpeg" | "ffprobe", args: string[], options: FfmpegRunOptions & { allowFailure?: boolean } = {}): Promise<ToolRun> {
    const tools = this.require();
    const { allowFailure, redactPaths, ...rest } = options;
    return this.lane.run(async () => {
      const run = await runTool(tools[tool], args, { ...rest, redact: redactPaths });
      if (run.killed === "cancelled") throw new MangaError("CANCELLED", "media task was cancelled");
      if (run.killed === "timeout") throw new MangaError("PROVIDER_UNAVAILABLE", "media task timed out", { retryable: true });
      if (run.killed === "output-limit") throw new MangaError("UNSUPPORTED_FORMAT", "media tool produced more output than allowed");
      if (!allowFailure && run.code !== 0) {
        throw new MangaError("UNSUPPORTED_FORMAT", `media tool failed (exit ${run.code ?? run.signal}): ${run.stderr.trim().split(/\r?\n/).slice(-3).join(" | ")}`);
      }
      return run;
    }, options.signal);
  }

  async probe(file: string, options: { signal?: AbortSignal } = {}): Promise<ReturnType<typeof probeFromJson>> {
    const redactPaths = [file, path.dirname(file)];
    const run = await this.run("ffprobe", ["-v", "error", "-hide_banner", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", "-i", file], { signal: options.signal, timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024, redactPaths });
    let json: FfprobeJson;
    try { json = JSON.parse(run.stdout.toString("utf8")) as FfprobeJson; } catch { throw new MangaError("UNSUPPORTED_FORMAT", "the media file could not be probed"); }
    if (!json.format || !(json.streams ?? []).length) throw new MangaError("UNSUPPORTED_FORMAT", "the media file has no readable streams");
    return probeFromJson(json, { name: "ffprobe", version: await this.version() });
  }

  async packetTimeline(file: string, streamIndex: number, startMs: number, options: { signal?: AbortSignal } = {}): Promise<PacketTimeline> {
    const run = await this.run("ffprobe", ["-v", "error", "-select_streams", String(streamIndex), "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", "-i", file], {
      signal: options.signal, timeoutMs: 5 * 60_000, maxStdoutBytes: 128 * 1024 * 1024, redactPaths: [file, path.dirname(file)],
    });
    return timelineFromPackets(run.stdout.toString("utf8").split(/\r?\n/), startMs);
  }

  /** One decoded frame near `timeMs` (container timeline), scaled so its long edge fits `maxEdge`. */
  async frameJpeg(file: string, containerTimeSec: number, maxEdge: number, options: { signal?: AbortSignal } = {}): Promise<Buffer> {
    const scale = `scale='if(gt(iw,ih),min(${maxEdge},iw),-2)':'if(gt(iw,ih),-2,min(${maxEdge},ih))'`;
    const run = await this.run("ffmpeg", ["-v", "error", "-nostdin", "-ss", containerTimeSec.toFixed(3), "-i", file, "-frames:v", "1", "-vf", scale, "-q:v", "3", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], {
      signal: options.signal, timeoutMs: 60_000, maxStdoutBytes: 32 * 1024 * 1024, redactPaths: [file, path.dirname(file)], allowFailure: true,
    });
    // A time past the end decodes nothing; that is an absent frame, not a broken file.
    if (!run.stdout.length) throw new MangaError("NOT_FOUND", "no frame at that time");
    return run.stdout;
  }

  /** A textual subtitle stream as text in the requested format. */
  async subtitleText(file: string, streamIndex: number, format: "ass" | "srt" | "webvtt", options: { signal?: AbortSignal } = {}): Promise<string> {
    const run = await this.run("ffmpeg", ["-v", "error", "-nostdin", "-i", file, "-map", `0:${streamIndex}`, "-f", format, "pipe:1"], {
      signal: options.signal, timeoutMs: 120_000, maxStdoutBytes: 64 * 1024 * 1024, redactPaths: [file, path.dirname(file)],
    });
    return run.stdout.toString("utf8");
  }

  /** Write attachment streams (fonts) under names the caller chose; names inside the file are never used as paths. */
  async dumpAttachments(file: string, items: Array<{ streamIndex: number; outName: string }>, directory: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (!items.length) return;
    fs.mkdirSync(directory, { recursive: true });
    const args = ["-v", "error", "-nostdin", "-y"];
    for (const item of items) args.push(`-dump_attachment:${item.streamIndex}`, item.outName);
    args.push("-i", file);
    // ffmpeg has no output here; it dumps and then complains about the missing output, which is expected.
    await this.run("ffmpeg", args, { signal: options.signal, timeoutMs: 120_000, cwd: directory, allowFailure: true, redactPaths: [file, path.dirname(file), directory] });
    for (const item of items) {
      if (!fs.existsSync(path.join(directory, item.outName))) throw new MangaError("NOT_FOUND", "an attachment could not be extracted");
    }
  }

  /** Progress as a fraction of `durationMs`, from `-progress pipe:1` lines. */
  static progressReader(durationMs: number, report: (fraction: number) => void): (line: string) => void {
    return (line) => {
      const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (match && durationMs > 0) {
        // Both keys carry microseconds in current builds.
        report(Math.min(1, Number(match[1]) / 1000 / durationMs));
      } else if (line === "progress=end") report(1);
    };
  }
}
