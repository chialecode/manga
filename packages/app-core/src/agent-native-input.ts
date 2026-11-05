import fs from "node:fs";
import { createHash } from "node:crypto";
import { MangaError } from "@manga/contracts";
import type { ModelProfile } from "@manga/contracts/models";
import type { DrizzleStore } from "@manga/storage-drizzle";
import type { AiRuntimeId } from "@manga/model-protocol";
import { resolveLocation } from "./library-locations.ts";
import { samplePdfContent } from "./domain/pdfjs-document.ts";
import { PDF_PAGE_TOKENS, VIDEO_SECOND_TOKENS } from "./agent-context.ts";
import { latestRevision, sha256, sourceStamp, type SourceStamp } from "./agent-media.ts";
import { subtitleLimit, type FrozenVideo } from "./agent-materials.ts";
import { frontierConsumed } from "./progress-service.ts";
import type { DeliveryNote } from "./agent-trace.ts";
import type { VideoService } from "./video/service.ts";

/**
 * Whole PDFs and video clips for a model that takes them (LOOP-17, 计划 4.5). Decided once, when the task is sent: a PDF the person put into the task goes
 * as the file, and the stretch of video asked about as a clip, only when all four conditions hold (the model's profile, the protocol and runtime, the
 * material and the spoiler range, the size and length); otherwise the text and frame pictures go as before, and the call record says why.
 */

/** Why a richer form was not sent, or why a picture was taken again. Codes, so the record carries no words from the material. */
export const DELIVERY_REASONS = {
  modelNoPdf: "model-no-pdf",
  modelNoVideo: "model-no-video",
  runtime: "runtime-unsupported",
  protocol: "protocol-no-video",
  partial: "partial-material",
  spoiler: "spoiler-range",
  tooLarge: "over-size-limit",
  tooLong: "over-length-limit",
  budget: "over-budget",
  clipFailed: "clip-failed",
  clipEmpty: "clip-empty",
  unreadable: "file-unreadable",
  expired: "expired-reextracted",
} as const;

/** How much of the window a file and a clip together may take: the rest is for the conversation, the material and the answer. */
const NATIVE_SHARE = 0.5;
/** Seconds before the position a clip covers when only a position was given (Q-36). */
export const CLIP_BEFORE_MS = 10_000;

/** A whole PDF a run sends. The bytes are not copied: the file is read when the request is made and its hash must still match. */
export type FrozenFile = { resourceId: string; revisionId: string; filename: string; bytes: number; pages: number; sha256: string };

/** A video clip a run sends; its bytes are kept with the run like a still (计划 4.4), under the same retention period. */
export type FrozenClip = { resourceId: string; revisionId: string; startMs: number; endMs: number; seconds: number; bytes: number; hash: string; stamp: SourceStamp | null; expired?: true };

type NativeDecision = { files: FrozenFile[]; clip?: FrozenClip; clipBytes?: Buffer; delivery: DeliveryNote[] };

type Context = {
  store: DrizzleStore;
  videos: VideoService;
  profile: ModelProfile;
  runtime: AiRuntimeId;
  protocol: "openai-responses" | "openai-chat-completions";
  /** Tokens the model can take in one request. */
  contextTokens: number;
  spoilerGuard: boolean;
  signal?: AbortSignal;
};

function pdfFile(store: DrizzleStore, revisionId: string): string | null {
  const file = resolveLocation(store, revisionId)?.path;
  return file && /\.pdf$/i.test(file) && fs.existsSync(file) ? file : null;
}

/** Whether the person has read the whole book: with the spoiler guard on, a PDF goes whole only then (otherwise it would show pages not yet reached). */
function readToTheEnd(store: DrizzleStore, resourceId: string, revisionId: string): boolean {
  const row = store.sqlite.prepare("SELECT completion_state, percent FROM progress_latest WHERE resource_id = ? AND resource_revision_id = ?").get(resourceId, revisionId) as { completion_state: string; percent: number } | undefined;
  return Boolean(row && (row.completion_state === "completed" || row.percent >= 100));
}

/**
 * The PDFs among the materials the person chose for this task (`chosen`: the resources named in the request, not those a project or a tool reaches), each
 * either as the file or, with the reason, as text.
 */
export async function decidePdfs(ctx: Context, chosen: Array<{ resourceId: string; revisionId: string; title: string }>, partial: Set<string>, used: { tokens: number }): Promise<{ files: FrozenFile[]; delivery: DeliveryNote[] }> {
  const files: FrozenFile[] = [];
  const delivery: DeliveryNote[] = [];
  for (const material of chosen) {
    const file = pdfFile(ctx.store, material.revisionId);
    if (!file) continue;
    const size = fs.statSync(file).size;
    const reason = !ctx.profile.inputTypes.includes("pdf") ? DELIVERY_REASONS.modelNoPdf
      : ctx.runtime !== "native" ? DELIVERY_REASONS.runtime
      : partial.has(material.resourceId) ? DELIVERY_REASONS.partial
      : ctx.spoilerGuard && !readToTheEnd(ctx.store, material.resourceId, material.revisionId) ? DELIVERY_REASONS.spoiler
      : size > ctx.profile.limits.fileBytes ? DELIVERY_REASONS.tooLarge
      : undefined;
    if (reason) { delivery.push({ kind: "text", bytes: size, reason }); continue; }
    let pages: number;
    try {
      pages = (await samplePdfContent({ file }, { signal: ctx.signal, samples: 1 })).pages;
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      delivery.push({ kind: "text", bytes: size, reason: DELIVERY_REASONS.unreadable });
      continue;
    }
    const tokens = pages * PDF_PAGE_TOKENS;
    if (used.tokens + tokens > ctx.contextTokens * NATIVE_SHARE) { delivery.push({ kind: "text", bytes: size, pages, reason: DELIVERY_REASONS.budget }); continue; }
    used.tokens += tokens;
    const bytes = fs.readFileSync(file);
    files.push({ resourceId: material.resourceId, revisionId: material.revisionId, filename: `${material.title.replace(/[\\/:*?"<>|\r\n]+/g, "_").slice(0, 120) || "document"}.pdf`, bytes: size, pages, sha256: sha256(bytes) });
    delivery.push({ kind: "file", bytes: size, pages });
  }
  return { files, delivery };
}

/** The stretch a clip covers: the interval when there is one, else the ten seconds before the position; never past the position or the spoiler limit. */
export function clipRange(video: Pick<FrozenVideo, "positionMs" | "interval">, consumed: Array<{ start: number; end: number }>, guard: boolean): { startMs: number; endMs: number } {
  const position = Math.max(0, video.positionMs);
  const wanted = video.interval ? { startMs: Math.max(0, video.interval.startMs), endMs: video.interval.endMs } : { startMs: Math.max(0, position - CLIP_BEFORE_MS), endMs: position };
  // The limit is the subtitles' own (what was watched, with the guard on); a widening the person allowed for the subtitles does not reach the clip.
  const limit = subtitleLimit({ positionMs: position, consumed, guard }).limitMs;
  const endMs = Math.min(wanted.endMs, position, limit);
  return { startMs: Math.min(wanted.startMs, endMs), endMs };
}

/** Cut a clip without re-encoding (keyframe-aligned start, so it may begin a little earlier; it never ends later than asked). */
export async function cutClip(videos: VideoService, resourceId: string, revisionId: string, range: { startMs: number; endMs: number }, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const bytes = await videos.clipBytes(resourceId, revisionId, range.startMs, range.endMs - range.startMs, signal);
  if (bytes.length > maxBytes) throw new MangaError("BUDGET_EXCEEDED", "the clip is larger than the model takes", { details: { reason: DELIVERY_REASONS.tooLarge, bytes: bytes.length } });
  return bytes;
}

/** The video the task is about, as a clip or, with the reason, as frames. */
export async function decideClip(ctx: Context, video: FrozenVideo, used: { tokens: number }): Promise<{ clip?: FrozenClip; clipBytes?: Buffer; delivery: DeliveryNote[] }> {
  const consumed = (() => { try { return frontierConsumed(ctx.store, video.resourceId, video.revisionId); } catch { return []; } })();
  const range = clipRange(video, consumed, ctx.spoilerGuard);
  const seconds = Math.round((range.endMs - range.startMs) / 100) / 10;
  const frames = (reason: string, extra: Partial<DeliveryNote> = {}): { delivery: DeliveryNote[] } => ({ delivery: [{ kind: "frames", seconds, ...extra, reason }] });
  if (!ctx.profile.inputTypes.includes("video")) return frames(DELIVERY_REASONS.modelNoVideo);
  if (ctx.runtime !== "native") return frames(DELIVERY_REASONS.runtime);
  if (ctx.protocol !== "openai-chat-completions") return frames(DELIVERY_REASONS.protocol);
  if (range.endMs - range.startMs < 1000) return frames(DELIVERY_REASONS.clipEmpty);
  if (seconds > ctx.profile.limits.videoSeconds) return frames(DELIVERY_REASONS.tooLong);
  const tokens = Math.ceil(seconds) * VIDEO_SECOND_TOKENS;
  if (used.tokens + tokens > ctx.contextTokens * NATIVE_SHARE) return frames(DELIVERY_REASONS.budget);
  let bytes: Buffer;
  try {
    bytes = await cutClip(ctx.videos, video.resourceId, video.revisionId, range, ctx.profile.limits.videoBytes, ctx.signal);
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    const tooLarge = error instanceof MangaError && (error.details as { reason?: string } | undefined)?.reason === DELIVERY_REASONS.tooLarge;
    return frames(tooLarge ? DELIVERY_REASONS.tooLarge : DELIVERY_REASONS.clipFailed, tooLarge ? { bytes: (error as MangaError & { details: { bytes: number } }).details.bytes } : {});
  }
  used.tokens += tokens;
  const clip: FrozenClip = { resourceId: video.resourceId, revisionId: video.revisionId, ...range, seconds, bytes: bytes.length, hash: sha256(bytes), stamp: sourceStamp(ctx.store, video.revisionId) };
  return { clip, clipBytes: bytes, delivery: [{ kind: "video", bytes: bytes.length, seconds }] };
}

/** A PDF as the run sends it, read now; a file that changed since the task was sent stops the run (CTX-02), as a changed picture source does. */
export function readFrozenFile(store: DrizzleStore, file: FrozenFile): Buffer {
  const changed = () => new MangaError("REVISION_CONFLICT", "这次任务附上的 PDF 在任务发出后被替换或移走了，无法再发送同一份文件。请重新发起任务。", { details: { reason: "media-source-changed", resourceId: file.resourceId } });
  if (latestRevision(store, file.resourceId) !== file.revisionId) throw changed();
  const where = pdfFile(store, file.revisionId);
  if (!where) throw changed();
  const bytes = fs.readFileSync(where);
  if (bytes.length !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw changed();
  return bytes;
}
