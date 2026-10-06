import fs from "node:fs";
import path from "node:path";
import { MangaError, createId } from "@manga/contracts";
import type { VideoProbe } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { FfmpegService } from "../media/ffmpeg.ts";
import type { MediaServices } from "../media/services.ts";
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
type DbRow = {
  id: string; resource_revision_id: string; reason: string; state: CopyState; audio_stream_index: number | null; file_name: string | null; bytes: number | null;
  encoder: string | null; progress: number; timestamp_check_json: string | null; error_json: string | null; created_at: string; updated_at: string;
};

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

  private readonly store: DrizzleStore;
  private readonly media: MediaServices;
  private readonly source: (revisionId: string) => SourceRow;
  private readonly budgetBytes: number;

  constructor(
    store: DrizzleStore,
    media: MediaServices,
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

  private summary(row: DbRow): PlayCopySummary {
    return {
      id: row.id, revisionId: row.resource_revision_id, reason: row.reason, state: row.state, audioStreamIndex: row.audio_stream_index, progress: row.progress,
      bytes: row.bytes, encoder: row.encoder, error: row.error_json ? JSON.parse(row.error_json) as { code: string; message: string } : null,
      timestampCheck: row.timestamp_check_json ? JSON.parse(row.timestamp_check_json) as TimestampCheck : null, createdAt: row.created_at,
    };
  }

  list(revisionId: string): PlayCopySummary[] {
    return (this.store.sqlite.prepare("SELECT * FROM play_copies WHERE resource_revision_id = ? ORDER BY created_at DESC, rowid DESC").all(revisionId) as DbRow[]).map((row) => this.summary(row));
  }

  find(revisionId: string, reason: string, audioStreamIndex: number | null): PlayCopySummary | null {
    const rows = this.store.sqlite.prepare("SELECT * FROM play_copies WHERE resource_revision_id = ? AND reason = ? AND state IN ('queued','running','ready') ORDER BY created_at DESC, rowid DESC").all(revisionId, reason) as DbRow[];
    const match = rows.find((row) => (row.audio_stream_index ?? null) === (audioStreamIndex ?? null));
    return match ? this.summary(match) : null;
  }

  /** A copy that can be played now. A row whose file vanished is removed, so the caller sees "not there" rather than a dead URL. */
  ready(revisionId: string, copyId?: string): { id: string; path: string; bytes: number } {
    const rows = (copyId
      ? this.store.sqlite.prepare("SELECT * FROM play_copies WHERE id = ? AND resource_revision_id = ?").all(copyId, revisionId)
      : this.store.sqlite.prepare("SELECT * FROM play_copies WHERE resource_revision_id = ? AND state = 'ready' ORDER BY created_at DESC, rowid DESC").all(revisionId)) as DbRow[];
    for (const row of rows) {
      if (row.state !== "ready" || !row.file_name) continue;
      const file = path.join(this.dir(), row.file_name);
      if (fs.existsSync(file)) {
        this.store.sqlite.prepare("UPDATE play_copies SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
        return { id: row.id, path: file, bytes: fs.statSync(file).size };
      }
      this.store.sqlite.prepare("DELETE FROM play_copies WHERE id = ?").run(row.id);
    }
    throw new MangaError("NOT_FOUND", "no play copy is ready for this video");
  }

  budget(): number {
    return this.budgetBytes;
  }

  totalBytes(): number {
    return (this.store.sqlite.prepare("SELECT COALESCE(SUM(bytes), 0) AS n FROM play_copies WHERE state = 'ready'").get() as { n: number }).n;
  }

  /** After a restart nothing is running: unfinished work is marked failed and its half-written files are removed. */
  recover(): number {
    const stale = this.store.sqlite.prepare("SELECT * FROM play_copies WHERE state IN ('queued','running')").all() as DbRow[];
    for (const row of stale) {
      if (row.file_name) fs.rmSync(path.join(this.dir(), `${row.file_name}.part`), { force: true });
      this.store.sqlite.prepare("UPDATE play_copies SET state = 'failed', error_json = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify({ code: "INTERRUPTED", message: "the app closed before the copy was finished" }), new Date().toISOString(), row.id,
      );
    }
    if (fs.existsSync(this.dir())) for (const name of fs.readdirSync(this.dir())) if (name.endsWith(".part")) fs.rmSync(path.join(this.dir(), name), { force: true });
    return stale.length;
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
    const candidates = this.store.sqlite.prepare("SELECT * FROM play_copies WHERE state = 'ready' AND resource_revision_id <> ? ORDER BY updated_at ASC").all(keepRevision) as DbRow[];
    for (const row of candidates) {
      if (total + neededBytes <= this.budgetBytes) break;
      if (row.file_name) fs.rmSync(path.join(this.dir(), row.file_name), { force: true });
      this.store.sqlite.prepare("DELETE FROM play_copies WHERE id = ?").run(row.id);
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
    this.store.sqlite.prepare("INSERT INTO play_copies(id, resource_revision_id, reason, state, audio_stream_index, file_name, bytes, encoder, tool_version, progress, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
      id, input.revisionId, reason, "queued", plan.audioStreamIndex, fileName, null, encoder?.name ?? "copy", `${source.probe.tool.name} ${source.probe.tool.version}`, 0, now, now,
    );
    const job = this.media.jobs.submit<void>({
      lane: "ffmpeg", kind: "play-copy", key: `play-copy:${id}`, owner: OWNER,
      run: async (context) => this.run(id, source, plan, encoder, context),
    });
    void job.promise.catch(() => undefined);
    return this.summary(this.store.sqlite.prepare("SELECT * FROM play_copies WHERE id = ?").get(id) as DbRow);
  }

  private async run(id: string, source: SourceRow, plan: PlaybackPlan, encoder: EncoderChoice | null, context: { signal: AbortSignal; progress(fraction: number): void }): Promise<void> {
    const out = path.join(this.dir(), `${id}.mp4`);
    const part = `${out}.part`;
    const touch = this.store.sqlite.prepare("UPDATE play_copies SET state = ?, progress = ?, updated_at = ? WHERE id = ?");
    const fail = (error: unknown) => {
      fs.rmSync(part, { force: true });
      fs.rmSync(out, { force: true });
      const cancelled = context.signal.aborted || (error instanceof MangaError && error.code === "CANCELLED");
      if (cancelled) {
        // A cancelled copy leaves nothing behind: no file, no row.
        this.store.sqlite.prepare("DELETE FROM play_copies WHERE id = ?").run(id);
      } else {
        const known = error instanceof MangaError ? { code: error.code, message: error.message } : { code: "UNSUPPORTED_FORMAT", message: error instanceof Error ? error.message : String(error) };
        this.store.sqlite.prepare("UPDATE play_copies SET state = 'failed', error_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(known), new Date().toISOString(), id);
      }
    };
    try {
      touch.run("running", 0, new Date().toISOString(), id);
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
          if (now - lastWrite > 1000) { lastWrite = now; touch.run("running", fraction, new Date(now).toISOString(), id); }
        }),
      });
      context.signal.throwIfAborted();
      if (!fs.existsSync(part) || fs.statSync(part).size === 0) throw new MangaError("UNSUPPORTED_FORMAT", "the copy came out empty");
      fs.renameSync(part, out);
      const check = await this.verify(source, out, context.signal);
      this.store.sqlite.prepare("UPDATE play_copies SET state = 'ready', progress = 1, bytes = ?, timestamp_check_json = ?, updated_at = ? WHERE id = ?").run(fs.statSync(out).size, JSON.stringify(check), new Date().toISOString(), id);
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
    const rows = (copyId
      ? this.store.sqlite.prepare("SELECT * FROM play_copies WHERE id = ? AND resource_revision_id = ? AND state IN ('queued','running')").all(copyId, revisionId)
      : this.store.sqlite.prepare("SELECT * FROM play_copies WHERE resource_revision_id = ? AND state IN ('queued','running')").all(revisionId)) as DbRow[];
    let count = 0;
    for (const row of rows) if (this.media.jobs.cancelWhere((job) => job.key === `play-copy:${row.id}`) > 0) count += 1;
    return count;
  }

  remove(revisionId: string, copyId?: string): number {
    const rows = (copyId
      ? this.store.sqlite.prepare("SELECT * FROM play_copies WHERE id = ? AND resource_revision_id = ?").all(copyId, revisionId)
      : this.store.sqlite.prepare("SELECT * FROM play_copies WHERE resource_revision_id = ?").all(revisionId)) as DbRow[];
    for (const row of rows) {
      if (row.state === "queued" || row.state === "running") this.media.jobs.cancelWhere((job) => job.key === `play-copy:${row.id}`);
      this.media.handles.revokeSubject(`play-copy:${row.id}`);
      if (row.file_name) {
        fs.rmSync(path.join(this.dir(), row.file_name), { force: true });
        fs.rmSync(path.join(this.dir(), `${row.file_name}.part`), { force: true });
      }
      this.store.sqlite.prepare("DELETE FROM play_copies WHERE id = ?").run(row.id);
    }
    return rows.length;
  }
}
