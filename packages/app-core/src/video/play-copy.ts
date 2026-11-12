import fs from "node:fs";
import path from "node:path";
import { MangaError, createId } from "@manga/contracts";
import type { VideoProbe } from "@manga/contracts";
import { FfmpegService } from "../media/ffmpeg.ts";
import type { MediaServices } from "../media/services.ts";
import type { PlayCopyRow, PlayCopyStore } from "./play-copy-store.ts";
import type { PlaybackPlan, PlayCopyReason } from "./playback.ts";

export const PLAY_COPY_BUDGET_BYTES = 20 * 1024 * 1024 * 1024;
const OWNER = "manga.video";

export type CopyState = "queued" | "running" | "ready" | "failed";
export type PlayCopySummary = {
  id: string;
  revisionId: string;
  reason: string;
  state: CopyState;
  audioStreamIndex: number | null;
  progress: number;
  bytes: number | null;
  encoder: string | null;
  error: { code: string; message: string } | null;
  timestampCheck: TimestampCheck | null;
  createdAt: string;
};

export type TimestampCheck = { originalFrames: number; copyFrames: number; maxDriftMs: number; ok: boolean };

type SourceRow = { revisionId: string; resourceId: string; probe: VideoProbe; path: string; available: boolean };
/** What a play copy needs of the media plumbing: its cache folder, FFmpeg, the job queue and the handle table. */
export type PlayCopyMedia = Pick<MediaServices, "dir" | "ffmpeg" | "jobs" | "handles">;
const byIdIn = (store: PlayCopyStore, id: string, revisionId: string): PlayCopyRow[] => [store.get(id)].filter((row): row is PlayCopyRow => row !== undefined && row.revisionId === revisionId);

/** Frame-by-frame comparison of two presentation-time lists. Counts differing is a failure; otherwise the largest gap decides. */
export function compareTimelines(original: number[], copy: number[]): TimestampCheck {
  const frames = Math.min(original.length, copy.length);
  let maxDrift = 0;
  // Both lists are relative to their own first frame, so a copy that starts at zero lines up with an original that does not.
  const a0 = original[0] ?? 0;
  const b0 = copy[0] ?? 0;
  for (let i = 0; i < frames; i += 1) maxDrift = Math.max(maxDrift, Math.abs((original[i]! - a0) - (copy[i]! - b0)));
  return { originalFrames: original.length, copyFrames: copy.length, maxDriftMs: Math.round(maxDrift * 1000) / 1000, ok: original.length === copy.length && maxDrift <= 1 };
}

export type EncoderChoice = { name: string; codec: "h264" | "av1"; args: string[]; hardware: boolean };

const ENCODERS: EncoderChoice[] = [
  { name: "h264_nvenc", codec: "h264", hardware: true, args: ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "23", "-b:v", "0", "-pix_fmt", "yuv420p"] },
  { name: "h264_amf", codec: "h264", hardware: true, args: ["-c:v", "h264_amf", "-quality", "balanced", "-rc", "cqp", "-qp_i", "22", "-qp_p", "24", "-pix_fmt", "yuv420p"] },
  { name: "h264_qsv", codec: "h264", hardware: true, args: ["-c:v", "h264_qsv", "-global_quality", "23", "-pix_fmt", "nv12"] },
  { name: "libsvtav1", codec: "av1", hardware: false, args: ["-c:v", "libsvtav1", "-preset", "10", "-crf", "35", "-g", "240", "-pix_fmt", "yuv420p10le"] },
];

export class PlayCopies {
  private encoder: Promise<EncoderChoice> | undefined;

  private readonly store: PlayCopyStore;
  private readonly media: PlayCopyMedia;
  private readonly source: (revisionId: string) => SourceRow;
  private readonly budgetBytes: number;

  constructor(
    store: PlayCopyStore,
    media: PlayCopyMedia,
    source: (revisionId: string) => SourceRow,
    budgetBytes = Number(process.env.MANGA_PLAYCOPY_BUDGET_BYTES) || PLAY_COPY_BUDGET_BYTES,
  ) {
    this.store = store;
    this.media = media;
    this.source = source;
    this.budgetBytes = budgetBytes;
  }

  private dir(): string {
    return this.media.dir("play-copies");
  }

  private summary(row: PlayCopyRow): PlayCopySummary {
    return {
      id: row.id, revisionId: row.revisionId, reason: row.reason, state: row.state, audioStreamIndex: row.audioStreamIndex, progress: row.progress,
      bytes: row.bytes, encoder: row.encoder, error: row.error, timestampCheck: row.timestampCheck, createdAt: row.createdAt,
    };
  }

  list(revisionId: string): PlayCopySummary[] {
    return this.store.byRevision(revisionId).map((row) => this.summary(row));
  }

  find(revisionId: string, reason: string, audioStreamIndex: number | null): PlayCopySummary | null {
    const match = this.store.byRevision(revisionId).find((row) => row.reason === reason && (row.state === "queued" || row.state === "running" || row.state === "ready")
      && (row.audioStreamIndex ?? null) === (audioStreamIndex ?? null));
    return match ? this.summary(match) : null;
  }

  /** A copy that can be played now. A row whose file vanished is removed, so the caller sees "not there" rather than a dead URL. */
  ready(revisionId: string, copyId?: string): { id: string; path: string; bytes: number } {
    const rows = copyId ? byIdIn(this.store, copyId, revisionId) : this.store.byRevision(revisionId).filter((row) => row.state === "ready");
    for (const row of rows) {
      if (row.state !== "ready" || !row.fileName) continue;
      const file = path.join(this.dir(), row.fileName);
      if (fs.existsSync(file)) {
        this.store.update(row.id, { updatedAt: new Date().toISOString() });
        return { id: row.id, path: file, bytes: fs.statSync(file).size };
      }
      this.store.delete(row.id);
    }
    throw new MangaError("NOT_FOUND", "no play copy is ready for this video");
  }

  budget(): number {
    return this.budgetBytes;
  }

  totalBytes(): number {
    return this.store.all().filter((row) => row.state === "ready").reduce((sum, row) => sum + (row.bytes ?? 0), 0);
  }

  /** After a restart nothing is running: unfinished work is marked failed and its half-written files are removed. */
  recover(): number {
    const stale = this.store.all().filter((row) => row.state === "queued" || row.state === "running");
    for (const row of stale) {
      if (row.fileName) fs.rmSync(path.join(this.dir(), `${row.fileName}.part`), { force: true });
      this.store.update(row.id, { state: "failed", error: { code: "INTERRUPTED", message: "the app closed before the copy was finished" }, updatedAt: new Date().toISOString() });
    }
    if (fs.existsSync(this.dir())) for (const name of fs.readdirSync(this.dir())) if (name.endsWith(".part")) fs.rmSync(path.join(this.dir(), name), { force: true });
    return stale.length;
  }

  /** Copy files that no row names (a light store that was lost or unreadable): removed, so the folder holds only what is counted. */
  removeStrays(): number {
    if (!fs.existsSync(this.dir())) return 0;
    const named = new Set(this.store.all().flatMap((row) => (row.fileName ? [row.fileName] : [])));
    let removed = 0;
    for (const name of fs.readdirSync(this.dir())) {
      if (name.endsWith(".mp4") && !named.has(name)) { fs.rmSync(path.join(this.dir(), name), { force: true }); removed += 1; }
    }
    return removed;
  }

  private async chooseEncoder(): Promise<EncoderChoice> {
    this.encoder ??= (async () => {
      const forced = process.env.MANGA_PLAYCOPY_ENCODER;
      if (forced) {
        const found = ENCODERS.find((item) => item.name === forced);
        if (found) return found;
      }
      const listing = (await this.media.ffmpeg.run("ffmpeg", ["-hide_banner", "-encoders"], { timeoutMs: 20_000 })).stdout.toString("utf8");
      for (const candidate of ENCODERS) {
        if (!listing.includes(` ${candidate.name} `)) continue;
        // A listed hardware encoder may have no device behind it; a 0.3 s trial settles that.
        const trial = await this.media.ffmpeg.run("ffmpeg", ["-v", "error", "-nostdin", "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=24:duration=0.3", ...candidate.args, "-f", "null", "-"], { timeoutMs: 30_000, allowFailure: true });
        if (trial.code === 0) return candidate;
      }
      throw new MangaError("CAPABILITY_UNAVAILABLE", "this machine has no video encoder the player can use");
    })();
    try {
      return await this.encoder;
    } catch (error) {
      this.encoder = undefined;
      throw error;
    }
  }

  private evictFor(neededBytes: number, keepRevision: string): void {
    let total = this.totalBytes();
    if (total + neededBytes <= this.budgetBytes) return;
    const candidates = this.store.all().filter((row) => row.state === "ready" && row.revisionId !== keepRevision).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const row of candidates) {
      if (total + neededBytes <= this.budgetBytes) break;
      if (row.fileName) fs.rmSync(path.join(this.dir(), row.fileName), { force: true });
      this.media.handles.revokeSubject(`play-copy:${row.id}`);
      this.store.delete(row.id);
      total -= row.bytes ?? 0;
    }
    if (total + neededBytes > this.budgetBytes) throw new MangaError("QUOTA_EXCEEDED", "play copies would exceed the disk budget; remove some copies first");
  }

  /** Start (or join) the job that makes a play copy. The caller gets the row at once and follows progress through the job queue. */
  async create(input: { revisionId: string; plan: PlaybackPlan; sessionNote?: string }): Promise<PlayCopySummary> {
    const { plan } = input;
    if (!plan.copy) throw new MangaError("VALIDATION_ERROR", "this video plays directly; no copy is needed");
    const reason = plan.copy.reason as PlayCopyReason | "unsupported_container";
    const existing = this.find(input.revisionId, reason, plan.audioStreamIndex);
    if (existing) return existing;
    if (!this.media.ffmpeg.available) throw new MangaError("CAPABILITY_UNAVAILABLE", "the media tool is not installed");
    const source = this.source(input.revisionId);
    if (!source.available) throw new MangaError("NOT_FOUND", "the video file is not available");
    const encoder = plan.copy.video === "encode" ? await this.chooseEncoder() : null;
    const estimate = fs.statSync(source.path).size;
    this.evictFor(estimate, input.revisionId);
    const id = createId("pcopy");
    const now = new Date().toISOString();
    const fileName = `${id}.mp4`;
    this.store.insert({
      id, revisionId: input.revisionId, reason, state: "queued", audioStreamIndex: plan.audioStreamIndex, fileName, bytes: null, encoder: encoder?.name ?? "copy",
      toolVersion: `${source.probe.tool.name} ${source.probe.tool.version}`, progress: 0, timestampCheck: null, error: null, createdAt: now, updatedAt: now,
    });
    const job = this.media.jobs.submit<void>({
      lane: "ffmpeg", kind: "play-copy", key: `play-copy:${id}`, owner: OWNER,
      run: async (context) => this.run(id, source, plan, encoder, context),
    });
    void job.promise.catch(() => undefined);
    return this.summary(this.store.get(id)!);
  }

  private async run(id: string, source: SourceRow, plan: PlaybackPlan, encoder: EncoderChoice | null, context: { signal: AbortSignal; progress(fraction: number): void }): Promise<void> {
    const out = path.join(this.dir(), `${id}.mp4`);
    const part = `${out}.part`;
    const touch = (state: CopyState, progress: number, at: string) => this.store.update(id, { state, progress, updatedAt: at });
    const fail = (error: unknown) => {
      fs.rmSync(part, { force: true });
      fs.rmSync(out, { force: true });
      const cancelled = context.signal.aborted || (error instanceof MangaError && error.code === "CANCELLED");
      if (cancelled) {
        // A cancelled copy leaves nothing behind: no file, no row.
        this.store.delete(id);
      } else {
        const known = error instanceof MangaError ? { code: error.code, message: error.message } : { code: "UNSUPPORTED_FORMAT", message: error instanceof Error ? error.message : String(error) };
        this.store.update(id, { state: "failed", error: known, updatedAt: new Date().toISOString() });
      }
    };
    try {
      touch("running", 0, new Date().toISOString());
      const copy = plan.copy!;
      const args = ["-v", "error", "-nostdin", "-y", "-progress", "pipe:1", "-i", source.path, "-map", `0:${plan.videoStreamIndex}`];
      if (plan.audioStreamIndex !== null && copy.audio !== "none") args.push("-map", `0:${plan.audioStreamIndex}`);
      if (copy.video === "copy") {
        const hevc = source.probe.streams.find((stream) => stream.index === plan.videoStreamIndex)?.codec === "hevc";
        args.push("-c:v", "copy", ...(hevc ? ["-tag:v", "hvc1"] : []));
      } else args.push(...(encoder?.args ?? []));
      if (copy.audio === "copy") args.push("-c:a", "copy");
      else if (copy.audio === "aac") args.push("-c:a", "aac", "-b:a", "192k");
      // Times stay as they are: no frame is duplicated or dropped, and the track starts at zero like the original does.
      args.push("-sn", "-dn", "-map_metadata", "-1", "-fps_mode", "passthrough", "-video_track_timescale", "90000", "-movflags", "+faststart", "-f", "mp4", part);
      let lastWrite = 0;
      await this.media.ffmpeg.run("ffmpeg", args, {
        signal: context.signal, timeoutMs: 6 * 60 * 60_000, redactPaths: [source.path, path.dirname(source.path), this.dir()],
        onStdoutLine: FfmpegService.progressReader(source.probe.durationMs, (fraction) => {
          context.progress(fraction);
          const now = Date.now();
          if (now - lastWrite > 1000) { lastWrite = now; touch("running", fraction, new Date(now).toISOString()); }
        }),
      });
      context.signal.throwIfAborted();
      if (!fs.existsSync(part) || fs.statSync(part).size === 0) throw new MangaError("UNSUPPORTED_FORMAT", "the copy came out empty");
      fs.renameSync(part, out);
      const check = await this.verify(source, out, context.signal);
      this.store.update(id, { state: "ready", progress: 1, bytes: fs.statSync(out).size, timestampCheck: check, updatedAt: new Date().toISOString() });
    } catch (error) {
      fail(error);
      throw error;
    }
  }

  /** Frame times of the copy against the original's, so a copy that shifted or dropped frames is visible rather than silently trusted. */
  private async verify(source: SourceRow, copyFile: string, signal: AbortSignal): Promise<TimestampCheck> {
    const video = source.probe.streams.find((stream) => stream.type === "video" && stream.fps !== undefined) ?? source.probe.streams.find((stream) => stream.type === "video")!;
    const original = await this.media.ffmpeg.packetTimeline(source.path, video.index, source.probe.startMs, { signal });
    const probe = await this.media.ffmpeg.probe(copyFile, { signal });
    const copyVideo = probe.streams.find((stream) => stream.type === "video")!;
    const copy = await this.media.ffmpeg.packetTimeline(copyFile, copyVideo.index, probe.startMs, { signal });
    return compareTimelines(original.ptsMs, copy.ptsMs);
  }

  cancel(revisionId: string, copyId?: string): number {
    const rows = (copyId ? byIdIn(this.store, copyId, revisionId) : this.store.byRevision(revisionId)).filter((row) => row.state === "queued" || row.state === "running");
    let count = 0;
    for (const row of rows) if (this.media.jobs.cancelWhere((job) => job.key === `play-copy:${row.id}`) > 0) count += 1;
    return count;
  }

  remove(revisionId: string, copyId?: string): number {
    const rows = copyId ? byIdIn(this.store, copyId, revisionId) : this.store.byRevision(revisionId);
    for (const row of rows) {
      if (row.state === "queued" || row.state === "running") this.media.jobs.cancelWhere((job) => job.key === `play-copy:${row.id}`);
      this.media.handles.revokeSubject(`play-copy:${row.id}`);
      if (row.fileName) {
        fs.rmSync(path.join(this.dir(), row.fileName), { force: true });
        fs.rmSync(path.join(this.dir(), `${row.fileName}.part`), { force: true });
      }
      this.store.delete(row.id);
    }
    return rows.length;
  }
}
