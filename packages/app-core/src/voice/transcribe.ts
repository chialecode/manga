import fs from "node:fs";
import path from "node:path";
import { MangaError, createId } from "@manga/contracts";
import type { SegmentAnchor } from "@manga/contracts";
import type { TranscriptionResult } from "@manga/model-protocol";
import { decodeRetainedRange, encodeRetained, readPcmRange, retainedName, wavFromPcm } from "./audio-files.ts";
import { planChunks, maxChunkMsForBytes, type PlannedChunk } from "./chunks.ts";
import type { AsrConnection } from "./ports.ts";
import { segmentRecording } from "./vad-segmenter.ts";
import type { CaptureService, SessionRow } from "./capture.ts";
import { VOICE_MODULE } from "./ids.ts";
import { readRecordingSettings, promptLimitFor } from "./settings.ts";
import { isPromptEcho } from "./dictionary.ts";

const MAX_ATTEMPTS = 3;
const MAX_CONSECUTIVE_FAILURES = 2;
const NO_TIMESTAMP_STATUS = new Set([400, 415, 422]);

type Run = { id: string; controller: AbortController; promise: Promise<void> };

const baseKey = (key: string) => key.split("#")[0]!;

const asMangaError = (error: unknown): MangaError =>
  error instanceof MangaError ? error : new MangaError("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "transcription failed", { retryable: true });

const publicError = (error: MangaError) => ({ code: error.code, message: error.message, ...(typeof error.details.reason === "string" ? { reason: error.details.reason } : {}) });
/** A block whose last answer only repeated the dictionary hint is sent again without it: the same hint would bring the same echo. */
export const PROMPT_ECHO = "prompt-echo";
/** A retry clears the failure, but not the note that the block must go out without the hint. */
const KEEP_ECHO_MARK = `CASE WHEN json_extract(error_json, '$.reason') = '${PROMPT_ECHO}' THEN error_json ELSE NULL END`;

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new MangaError("CANCELLED", "cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new MangaError("CANCELLED", "cancelled")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

type ChunkRow = { id: string; seq: number; chunk_key: string; start_ms: number; end_ms: number; state: string; attempts: number; error_json?: string | null };

/**
 * Takes a stopped recording through filtering, block planning, transcription and clean-up, one step at a time and one
 * block at a time. Every step persists before the next begins, so an interruption leaves a state the next run continues
 * from: blocks already transcribed are never sent again, and a result that arrives after its recording was cancelled or
 * its module was turned off is dropped without being written.
 */
export class VoicePipeline {
  private readonly host: CaptureService;
  private readonly runs = new Map<string, Run>();
  /** Connections whose provider refused timestamped output; they get plain text from then on. */
  private readonly plainText = new Set<string>();

  constructor(host: CaptureService) {
    this.host = host;
  }

  busy(id: string): boolean {
    return this.runs.has(id);
  }

  private guard(run: Run): void {
    if (run.controller.signal.aborted || !this.host.isCurrent() || this.runs.get(run.id) !== run) {
      throw new MangaError("CANCELLED", "the recording was cancelled or its module was turned off");
    }
  }

  abortAll(): void {
    for (const run of this.runs.values()) run.controller.abort();
  }

  /** Start (or join) the processing run of a stopped recording. */
  schedule(id: string, options: { connectionId?: string; retryFailed?: boolean } = {}): Promise<void> {
    const existing = this.runs.get(id);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const run: Run = { id, controller, promise: Promise.resolve() };
    this.runs.set(id, run);
    run.promise = this.execute(run, options).finally(() => {
      if (this.runs.get(id) === run) this.runs.delete(id);
    });
    run.promise.catch(() => undefined);
    return run.promise;
  }

  private async execute(run: Run, options: { connectionId?: string; retryFailed?: boolean }): Promise<void> {
    const { id } = run;
    const jobs = this.host.deps.media.jobs;
    try {
      const filter = jobs.submit({ lane: "vad", kind: "capture-filter", key: `capture:${id}:filter`, owner: VOICE_MODULE, run: ({ signal, progress }) => this.filterStage(run, AbortSignal.any([signal, run.controller.signal]), progress) });
      await filter.promise;
      this.guard(run);
      const planned = this.plan(id, options.connectionId);
      if (planned === 0) {
        this.host.setStage(id, "no_speech", null);
        await this.finalizeAudio(id, run.controller.signal);
        return;
      }
      if (options.retryFailed) this.host.db.prepare("UPDATE transcript_segments SET state = 'pending', error_json = NULL WHERE session_id = ? AND state = 'failed'").run(id);
      const asr = jobs.submit({ lane: "net", kind: "capture-asr", key: `capture:${id}:asr`, owner: VOICE_MODULE, run: ({ signal, progress }) => this.asrStage(run, AbortSignal.any([signal, run.controller.signal]), options.connectionId, progress) });
      await asr.promise;
    } catch (error) {
      const failure = asMangaError(error);
      if (failure.code === "CANCELLED") return;
      if (!this.host.isCurrent()) return;
      try {
        // A step that failed leaves the audio in place; the stage says what happened and the user can retry.
        this.host.setStage(id, "failed", publicError(failure));
      } catch { /* the session may be gone */ }
    }
  }

  // ------------------------------------------------------------------ filtering

  private async filterStage(run: Run, signal: AbortSignal, progress: (fraction: number) => void): Promise<void> {
    const { id } = run;
    const row = this.host.row(id);
    if (row.vad_json) return;
    const file = this.host.stagingPath(row);
    if (!file || !fs.existsSync(file)) throw new MangaError("NOT_FOUND", "the recorded audio is not available");
    const vad = this.host.deps.vad;
    if (!vad.available) throw new MangaError("CAPABILITY_UNAVAILABLE", vad.unavailableReason ?? "the voice filter is not available");
    this.host.setStage(id, "filtering", null);
    const probabilities = await vad.analyzeFile(file, {
      signal,
      onProgress: (fraction) => {
        progress(fraction);
        this.host.deps.notify("capture.progress", { sessionId: id, stage: "filtering", fraction });
      },
    });
    this.guard(run);
    const margin = readRecordingSettings(this.host.deps.store).boundaryMarginMs;
    const segments = segmentRecording(probabilities, row.duration_ms, { marginMs: margin });
    this.host.patch(id, { vad_json: JSON.stringify(this.host.summarize(segments, row.duration_ms, true)) });
  }

  /** Turn the filtered speech into numbered blocks and make sure each has its row. Returns how many blocks the recording has. */
  private plan(id: string, connectionId?: string): number {
    const vad = this.host.vad(id);
    if (!vad) return 0;
    const connection = this.host.asr.resolve(connectionId);
    const chunks = planChunks(vad.segments, { maxChunkMs: maxChunkMsForBytes(connection?.maxUploadBytes) });
    const db = this.host.db;
    const known = new Set((db.prepare("SELECT chunk_key FROM transcript_segments WHERE session_id = ?").all(id) as Array<{ chunk_key: string }>).map((row) => baseKey(row.chunk_key)));
    const now = new Date().toISOString();
    const insert = db.prepare("INSERT OR IGNORE INTO transcript_segments(id, session_id, seq, chunk_key, start_ms, end_ms, text, state, precision, calibrated, anchors_json, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    db.transaction(() => {
      chunks.forEach((chunk, index) => {
        if (known.has(chunk.key)) return;
        insert.run(createId("seg"), id, index * 1000, chunk.key, chunk.startMs, chunk.endMs, "", "pending", "chunk", 0, "[]", 0, now, now);
      });
    })();
    return (db.prepare("SELECT COUNT(*) AS n FROM transcript_segments WHERE session_id = ?").get(id) as { n: number }).n;
  }

  // ------------------------------------------------------------------ transcription

  /** The hint for a block of audio: the dictionary, cut to the length this connection takes. */
  private hintFor(workId: string | null, connectionId: string): { text: string; included: string[] } | undefined {
    const limit = promptLimitFor(readRecordingSettings(this.host.deps.store), connectionId);
    const built = this.host.dictionary.prompt(workId, limit);
    return built.text ? { text: built.text, included: built.included } : undefined;
  }

  private async blockBytes(row: SessionRow, chunk: ChunkRow, signal: AbortSignal): Promise<Buffer> {
    const staged = this.host.stagingPath(row);
    if (staged && fs.existsSync(staged)) return wavFromPcm(readPcmRange(staged, chunk.start_ms, chunk.end_ms));
    const retained = this.host.retainedPath(row);
    if (retained && fs.existsSync(retained)) return wavFromPcm(await decodeRetainedRange(this.host.deps.media.ffmpeg, retained, chunk.start_ms, chunk.end_ms, signal));
    throw new MangaError("NOT_FOUND", "the recorded audio is no longer available, so it cannot be transcribed again");
  }

  private async request(connection: AsrConnection, row: SessionRow, chunk: ChunkRow, wav: Buffer, signal: AbortSignal): Promise<TranscriptionResult> {
    const settings = readRecordingSettings(this.host.deps.store);
    // A block that came back as nothing but the hint is asked again without it.
    const echoedBefore = chunk.error_json ? (() => { try { return (JSON.parse(chunk.error_json) as { reason?: string }).reason === PROMPT_ECHO; } catch { return false; } })() : false;
    const hint = echoedBefore ? undefined : this.hintFor(row.work_id, connection.id);
    const send = (timestamps: boolean) => this.host.asr.transcribe(connection, { fileName: `${chunk.chunk_key}.wav`, bytes: wav, mimeType: "audio/wav", prompt: hint?.text, language: settings.language ?? undefined, timestamps, signal });
    let result: TranscriptionResult;
    if (this.plainText.has(connection.id)) result = await send(false);
    else {
      try {
        result = await send(true);
      } catch (error) {
        const failure = asMangaError(error);
        if (failure.code !== "CANCELLED" && NO_TIMESTAMP_STATUS.has(Number(failure.details.status))) {
          // The provider does not know segment timestamps; plain text still locates the block.
          this.plainText.add(connection.id);
          result = await send(false);
        } else throw failure;
      }
    }
    // A dictionary raises the chance that a model with little to hear gives the hint back; that is not a transcript and is not written.
    if (hint && isPromptEcho(result.text, hint.included)) throw new MangaError("PROVIDER_UNAVAILABLE", "the transcript only repeats the dictionary hint", { retryable: true, details: { reason: PROMPT_ECHO } });
    return result;
  }

  private async asrStage(run: Run, signal: AbortSignal, connectionId: string | undefined, progress: (fraction: number) => void): Promise<void> {
    const { id } = run;
    const pending = () => this.host.db.prepare("SELECT id, seq, chunk_key, start_ms, end_ms, state, attempts, error_json FROM transcript_segments WHERE session_id = ? AND state IN ('pending','uploaded') ORDER BY start_ms, seq").all(id) as ChunkRow[];
    const chunks = pending();
    if (!chunks.length) {
      this.settle(id);
      await this.finalizeAudio(id, signal);
      return;
    }
    const connection = this.host.asr.resolve(connectionId);
    if (!connection) {
      // Nothing to send to yet: the recording waits, and a kept recording is stored for good in the meantime.
      this.host.setStage(id, "awaiting_asr", null);
      if (this.host.row(id).retention === "keep") await this.retainAudio(id, signal).catch(() => undefined);
      return;
    }
    this.host.setStage(id, "transcribing", null);
    const events = this.host.events(id);
    const total = chunks.length;
    let done = 0;
    let consecutiveFailures = 0;
    let fatal: MangaError | null = null;
    const base = this.host.deps.retryBaseMs ?? 800;
    for (const chunk of chunks) {
      this.guard(run);
      const row = this.host.row(id);
      this.host.db.prepare("UPDATE transcript_segments SET state = 'uploaded', attempts = attempts + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), chunk.id);
      let result: TranscriptionResult | null = null;
      let failure: MangaError | null = null;
      for (let attempt = 0; attempt < MAX_ATTEMPTS && !result; attempt += 1) {
        try {
          const wav = await this.blockBytes(row, chunk, signal);
          result = await this.request(connection, row, chunk, wav, signal);
        } catch (error) {
          failure = asMangaError(error);
          if (failure.code === "CANCELLED" || !failure.retryable) break;
          // The same hint would bring the same echo; the block is marked failed and goes out again without it when it is retried.
          if (failure.details.reason === PROMPT_ECHO) break;
          if (attempt < MAX_ATTEMPTS - 1) {
            const asked = Number(failure.details.retryAfterMs);
            await delay(Number.isFinite(asked) && asked > 0 ? asked : base * 2 ** attempt, signal);
          }
        }
      }
      // The answer may come back after the recording was cancelled or the module turned off: it is dropped, not written.
      this.guard(run);
      if (result) {
        this.persist(id, chunk, result, events);
        consecutiveFailures = 0;
      } else {
        const error = failure ?? new MangaError("PROVIDER_UNAVAILABLE", "transcription failed", { retryable: true });
        this.host.db.prepare("UPDATE transcript_segments SET state = 'failed', error_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(publicError(error)), new Date().toISOString(), chunk.id);
        // An echo says something about the audio, not about the provider, so it does not count towards stopping the run.
        if (error.details.reason !== PROMPT_ECHO) consecutiveFailures += 1;
        if (!error.retryable) { fatal = error; break; }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) break;
      }
      done += 1;
      progress(done / total);
      this.host.deps.notify("capture.progress", { sessionId: id, stage: "transcribing", done, total });
    }
    // Blocks never reached stay pending for the next run.
    this.host.db.prepare("UPDATE transcript_segments SET state = 'pending' WHERE session_id = ? AND state = 'uploaded'").run(id);
    const stage = this.settle(id, fatal);
    if (stage === "done" || stage === "no_speech") await this.finalizeAudio(id, signal);
  }

  /** Decide the recording's stage from its blocks. Returns the stage it set. */
  private settle(id: string, fatal: MangaError | null = null): "done" | "no_speech" | "pending" | "failed" {
    const rows = this.host.db.prepare("SELECT state, COUNT(*) AS n FROM transcript_segments WHERE session_id = ? GROUP BY state").all(id) as Array<{ state: string; n: number }>;
    const count = (state: string) => rows.find((item) => item.state === state)?.n ?? 0;
    const open = count("pending") + count("failed") + count("uploaded");
    if (!open) {
      const stage = count("done") === 0 ? "no_speech" : "done";
      this.host.setStage(id, stage, null);
      return stage;
    }
    const stage = count("done") + count("no_speech") === 0 && fatal ? "failed" : "pending";
    const stored = (this.host.db.prepare("SELECT error_json FROM transcript_segments WHERE session_id = ? AND state = 'failed' ORDER BY updated_at DESC LIMIT 1").get(id) as { error_json: string | null } | undefined)?.error_json;
    this.host.setStage(id, stage, fatal ? publicError(fatal) : stored ? JSON.parse(stored) as { code: string; message: string } : null);
    return stage;
  }

  /** Write one block's answer: its text, and its anchors computed from where the reader was on the capture clock. */
  private persist(id: string, chunk: ChunkRow, result: TranscriptionResult, events: ReturnType<CaptureService["events"]>): void {
    const db = this.host.db;
    const now = new Date().toISOString();
    const length = chunk.end_ms - chunk.start_ms;
    const sub = this.subSegments(chunk, result, length);
    db.transaction(() => {
      if (!sub) {
        const text = result.text.trim();
        if (!text) {
          db.prepare("UPDATE transcript_segments SET text = '', state = 'no_speech', error_json = NULL, updated_at = ? WHERE id = ?").run(now, chunk.id);
          return;
        }
        const anchors = this.host.anchorsFor(id, chunk.start_ms, chunk.end_ms, events);
        db.prepare("UPDATE transcript_segments SET text = ?, state = 'done', precision = 'chunk', anchors_json = ?, error_json = NULL, updated_at = ? WHERE id = ?").run(text, JSON.stringify(anchors), now, chunk.id);
        return;
      }
      sub.forEach((piece, index) => {
        const anchors: SegmentAnchor[] = this.host.anchorsFor(id, piece.startMs, piece.endMs, events);
        if (index === 0) {
          db.prepare("UPDATE transcript_segments SET chunk_key = ?, start_ms = ?, end_ms = ?, text = ?, state = 'done', precision = 'segment', anchors_json = ?, error_json = NULL, updated_at = ? WHERE id = ?").run(`${chunk.chunk_key}#0`, piece.startMs, piece.endMs, piece.text, JSON.stringify(anchors), now, chunk.id);
        } else {
          db.prepare("INSERT INTO transcript_segments(id, session_id, seq, chunk_key, start_ms, end_ms, text, state, precision, calibrated, anchors_json, attempts, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(createId("seg"), id, chunk.seq + index, `${chunk.chunk_key}#${index}`, piece.startMs, piece.endMs, piece.text, "done", "segment", 0, JSON.stringify(anchors), chunk.attempts + 1, now, now);
        }
      });
    })();
  }

  /** Per-sentence pieces from the provider's timestamps, or null when there are none or they do not hold together. */
  private subSegments(chunk: ChunkRow, result: TranscriptionResult, length: number): Array<{ startMs: number; endMs: number; text: string }> | null {
    const pieces = result.segments;
    if (!pieces || pieces.length < 2) return null;
    const out: Array<{ startMs: number; endMs: number; text: string }> = [];
    let previousStart = -Infinity;
    let spread = false;
    for (const piece of pieces) {
      const from = Math.round(piece.start * 1000);
      const to = Math.round(piece.end * 1000);
      // Times are seconds into the block, so they must stay inside it and move forward; anything else is not a timestamp worth trusting.
      if (from < 0 || to < from || from > length + 500 || to > length + 1500 || from < previousStart - 50) return null;
      previousStart = from;
      if (to > from) spread = true;
      const text = piece.text.trim();
      if (text) out.push({ startMs: chunk.start_ms + Math.min(from, length), endMs: chunk.start_ms + Math.min(to, length), text });
    }
    return spread && out.length >= 2 ? out : null;
  }

  // ------------------------------------------------------------------ retry and cancel

  /** Send again only what is not done: failed and never-sent blocks, or one block by id. Done blocks are not touched. */
  retry(id: string, segmentId?: string, connectionId?: string): Promise<void> {
    const db = this.host.db;
    if (segmentId) {
      const row = db.prepare("SELECT chunk_key, session_id, state FROM transcript_segments WHERE id = ?").get(segmentId) as { chunk_key: string; session_id: string; state: string } | undefined;
      if (!row || row.session_id !== id) throw new MangaError("NOT_FOUND", "transcript segment not found");
      if (row.state !== "failed" && row.state !== "pending") throw new MangaError("VALIDATION_ERROR", "only a block that failed can be sent again", { details: { state: row.state } });
      db.prepare(`UPDATE transcript_segments SET state = 'pending', error_json = ${KEEP_ECHO_MARK} WHERE id = ?`).run(segmentId);
    } else {
      db.prepare(`UPDATE transcript_segments SET state = 'pending', error_json = ${KEEP_ECHO_MARK} WHERE session_id = ? AND state = 'failed'`).run(id);
    }
    return this.schedule(id, { connectionId });
  }

  cancel(id: string): void {
    const run = this.runs.get(id);
    run?.controller.abort();
    this.host.deps.media.jobs.cancelWhere((job) => job.key !== null && job.key.startsWith(`capture:${id}:`));
    this.host.db.prepare("UPDATE transcript_segments SET state = 'pending' WHERE session_id = ? AND state = 'uploaded'").run(id);
    const row = this.host.row(id);
    if (!["done", "no_speech"].includes(row.stage)) this.host.setStage(id, "cancelled", null);
  }

  // ------------------------------------------------------------------ audio

  /** Store the recording for good: Opus in attachments. The staged copy stays until processing has finished. */
  async retainAudio(id: string, signal: AbortSignal): Promise<void> {
    const row = this.host.row(id);
    const existing = this.host.retainedPath(row);
    if (existing && fs.existsSync(existing)) {
      if (row.audio_state !== "retained") this.host.patch(id, { audio_state: "retained" });
      return;
    }
    const staged = this.host.stagingPath(row);
    if (!staged || !fs.existsSync(staged)) throw new MangaError("NOT_FOUND", "the recorded audio is not available");
    const name = retainedName(id);
    const target = path.join(this.host.deps.store.attachmentsDir, name);
    try {
      await encodeRetained(this.host.deps.media.ffmpeg, staged, target, signal);
      const place = this.host.fileTarget(row);
      if (place) {
        // A recording is kept in the folder of what it was made for, named for the title and the time it began (A-88).
        const stamp = row.created_at.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
        const put = this.host.files.put({ workId: place.workId, resourceId: place.resourceId }, { kind: "recording", fileName: `${place.label} 录音 ${stamp}.webm`, sourcePath: target, resourceId: place.resourceId, refKind: "capture", refId: id });
        this.host.patch(id, { audio_file_id: put.fileId, audio_state: "retained" });
      } else {
        this.host.patch(id, { opus_name: name, audio_state: "retained" });
      }
      this.host.deps.notify("capture.changed", { sessionId: id, audioState: "retained" });
    } catch (error) {
      if (asMangaError(error).code === "CANCELLED") throw error;
      // The recording is still staged and intact; say that it was not stored for good rather than pretend.
      this.host.patch(id, { error_json: JSON.stringify({ code: "AUDIO_RETAIN_FAILED", message: "the audio could not be stored; it is kept as a working copy" }) });
      throw error;
    }
  }

  /** Remove staged audio, and with `everything` also the stored copy. A file that cannot be removed leaves the state as it was. */
  removeAudio(id: string, options: { everything: boolean }): { ok: boolean } {
    const row = this.host.row(id);
    const targets = [this.host.stagingPath(row), options.everything ? this.host.retainedPath(row) : null].filter((file): file is string => Boolean(file));
    let ok = true;
    for (const file of targets) {
      try {
        fs.rmSync(file, { force: true });
        if (fs.existsSync(file)) ok = false;
      } catch {
        ok = false;
      }
    }
    if (!ok) {
      this.host.patch(id, { error_json: JSON.stringify({ code: "CLEANUP_PENDING", message: "the working audio could not be removed yet; it will be tried again" }) });
      return { ok: false };
    }
    if (options.everything && row.audio_file_id) this.host.files.remove(row.audio_file_id, { deleteFile: false });
    const keepsStored = !options.everything && (row.opus_name || row.audio_file_id);
    this.host.patch(id, { staging_name: null, ...(options.everything ? { opus_name: null, audio_file_id: null } : {}), audio_state: keepsStored ? "retained" : "cleaned" });
    this.host.deps.notify("capture.changed", { sessionId: id, audioState: keepsStored ? "retained" : "cleaned" });
    return { ok: true };
  }

  /** The recording has been fully processed: apply what was chosen when it started. */
  private async finalizeAudio(id: string, signal: AbortSignal): Promise<void> {
    const row = this.host.row(id);
    // Only after the text, the original intervals and the mapping are stored may anything be cleaned up.
    const open = (this.host.db.prepare("SELECT COUNT(*) AS n FROM transcript_segments WHERE session_id = ? AND state NOT IN ('done','no_speech')").get(id) as { n: number }).n;
    if (open) return;
    if (row.retention === "keep") {
      try {
        await this.retainAudio(id, signal);
      } catch {
        return;
      }
      this.removeAudio(id, { everything: false });
    } else {
      this.removeAudio(id, { everything: false });
    }
  }
}
