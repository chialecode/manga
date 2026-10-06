import fs from "node:fs";
import path from "node:path";
import { MangaError, createId } from "@manga/contracts";
import type { CaptureAudioState, CaptureEventReason, CaptureStage, CaptureStopReason, SegmentAnchor, SourceLocator } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import type { MediaServices } from "../media/services.ts";
import { PCM_BYTES_PER_MS, PCM_SAMPLE_RATE, RETAINED_MEDIA_TYPE, pcmDurationMs, retainedName, stagingName } from "./audio-files.ts";
import { VOICE_MODULE } from "./ids.ts";
import { Organizer } from "./organize.ts";
import { NO_ASR, NO_LLM, type AsrPort, type LlmPort } from "./ports.ts";
import { mapInterval, type PositionEvent } from "./position-map.ts";
import { VoicePipeline } from "./transcribe.ts";
import { VadSegmenter, type SpeechSegment, type VadConfig } from "./vad-segmenter.ts";
import type { VadEngine, VadStream } from "./vad-client.ts";
import { readRecordingSettings } from "./settings.ts";

export { VOICE_MODULE };

const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 50_000;
const SAMPLE_THIN_MS = 900;
/** The most recorded audio that may be waiting for the live filter; past it the filter gives up and a full pass runs after the recording. */
const MAX_FILTER_LAG_BYTES = 120 * 1000 * PCM_BYTES_PER_MS;
const MAX_PAD_MS = 10_000;
const EVENT_AHEAD_MS = 5_000;
const HANDLE_TTL_MS = 6 * 60 * 60_000;

export type CaptureDeps = {
  store: DrizzleStore;
  media: MediaServices;
  vad: VadEngine;
  asr?: AsrPort;
  llm?: LlmPort;
  notify: (topic: string, payload: Record<string, unknown>) => void;
  /** Checks that a locator names a place its revision has. */
  validateLocator?: (revisionId: string, locator: SourceLocator) => void;
  /** Base delay of the transcription retry backoff; tests set it to 0. */
  retryBaseMs?: number;
};

export type SessionRow = {
  id: string;
  clock_json: string;
  status: string;
  created_at: string;
  mode: string | null;
  retention: string;
  audio_state: string;
  stage: string;
  duration_ms: number;
  stopped_at: string | null;
  staging_name: string | null;
  opus_name: string | null;
  device_label: string | null;
  work_id: string | null;
  vad_json: string | null;
  error_json: string | null;
  updated_at: string | null;
};

export type VadSummary = {
  version: 1;
  totalMs: number;
  /** True when the segments came from a pass over the finished file rather than from the live filter. */
  analyzedFull: boolean;
  config: Partial<VadConfig>;
  segments: SpeechSegment[];
  speechMs: number;
  gaps: Array<{ atMs: number; ms: number }>;
};

type Active = {
  id: string;
  file: string;
  fd: number;
  bytes: number;
  nextSeq: number;
  lastChunkBytes: number;
  stream: VadStream | null;
  segmenter: VadSegmenter;
  closedSegments: SpeechSegment[];
  feed: Promise<void>;
  fedBytes: number;
  filterBroken: boolean;
  events: number;
  lastSampleAt: number;
  gaps: Array<{ atMs: number; ms: number }>;
  stopping: boolean;
};

export type SessionView = {
  id: string;
  mode: string | null;
  retention: string;
  stage: CaptureStage;
  audioState: CaptureAudioState;
  /** Whether the recording can be played back right now. */
  playable: boolean;
  durationMs: number;
  createdAt: string;
  stoppedAt: string | null;
  workId: string | null;
  deviceLabel: string | null;
  resourceId: string | null;
  error: { code: string; message: string } | null;
  segments: { total: number; done: number; failed: number; pending: number; noSpeech: number };
  speechMs: number | null;
};

const parseJson = <T>(raw: string | null | undefined): T | null => {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; } catch { return null; }
};

export class CaptureService {
  readonly deps: CaptureDeps;
  readonly pipeline: VoicePipeline;
  readonly organizer: Organizer;
  private active: Active | null = null;
  private current: () => boolean = () => true;

  constructor(deps: CaptureDeps) {
    this.deps = { ...deps, asr: deps.asr ?? NO_ASR, llm: deps.llm ?? NO_LLM };
    this.pipeline = new VoicePipeline(this);
    this.organizer = new Organizer(this);
  }

  get asr(): AsrPort { return this.deps.asr!; }
  get llm(): LlmPort { return this.deps.llm!; }
  get db() { return this.deps.store.sqlite; }
  get activeId(): string | null { return this.active?.id ?? null; }

  /** Tie the service to one activation of its module: work finishing after the module is turned off is dropped. */
  bind(isCurrent: () => boolean): void {
    this.current = isCurrent;
  }

  isCurrent(): boolean {
    return this.current();
  }

  assertCurrent(): void {
    if (!this.current()) throw new MangaError("CANCELLED", "voice recording was turned off");
  }

  // ------------------------------------------------------------------ rows

  row(id: string): SessionRow {
    const row = this.db.prepare("SELECT * FROM capture_sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "recording not found");
    return row;
  }

  patch(id: string, fields: Partial<Record<keyof SessionRow, string | number | null>>): void {
    const entries = Object.entries({ ...fields, updated_at: new Date().toISOString() });
    this.db.prepare(`UPDATE capture_sessions SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...entries.map(([, value]) => value), id);
  }

  setStage(id: string, stage: CaptureStage, error?: { code: string; message: string } | null): void {
    this.patch(id, { stage, ...(error === undefined ? {} : { error_json: error ? JSON.stringify(error) : null }) });
    this.deps.notify("capture.changed", { sessionId: id, stage });
  }

  stagingPath(row: SessionRow): string | null {
    return row.staging_name ? path.join(this.deps.store.attachmentsDir, row.staging_name) : null;
  }

  retainedPath(row: SessionRow): string | null {
    return row.opus_name ? path.join(this.deps.store.attachmentsDir, row.opus_name) : null;
  }

  events(id: string): PositionEvent[] {
    const rows = this.db.prepare("SELECT id, offset_ms, reason, resource_id, resource_revision_id, payload_json FROM capture_events WHERE session_id = ? ORDER BY offset_ms, id").all(id) as Array<{ id: number; offset_ms: number; reason: string; resource_id: string | null; resource_revision_id: string | null; payload_json: string }>;
    return rows.map((row) => {
      const payload = parseJson<{ locator?: SourceLocator; playing?: boolean; playbackRate?: number }>(row.payload_json) ?? {};
      return {
        offsetMs: row.offset_ms,
        reason: row.reason as CaptureEventReason,
        seq: row.id,
        ...(row.resource_id ? { resourceId: row.resource_id } : {}),
        ...(row.resource_revision_id ? { resourceRevisionId: row.resource_revision_id } : {}),
        ...(payload.locator ? { locator: payload.locator } : {}),
        ...(payload.playing !== undefined ? { playing: payload.playing } : {}),
        ...(payload.playbackRate !== undefined ? { playbackRate: payload.playbackRate } : {}),
      };
    });
  }

  anchorsFor(id: string, startMs: number, endMs: number, events?: PositionEvent[]): SegmentAnchor[] {
    return mapInterval(events ?? this.events(id), startMs, endMs);
  }

  vad(id: string): VadSummary | null {
    return parseJson<VadSummary>(this.row(id).vad_json);
  }

  // ------------------------------------------------------------------ views

  view(row: SessionRow): SessionView {
    const counts = this.db.prepare("SELECT state, COUNT(*) AS n FROM transcript_segments WHERE session_id = ? GROUP BY state").all(row.id) as Array<{ state: string; n: number }>;
    const by = (state: string) => counts.find((item) => item.state === state)?.n ?? 0;
    const total = counts.reduce((sum, item) => sum + item.n, 0);
    const first = this.db.prepare("SELECT resource_id FROM capture_events WHERE session_id = ? AND resource_id IS NOT NULL ORDER BY offset_ms, id LIMIT 1").get(row.id) as { resource_id: string } | undefined;
    const vad = parseJson<VadSummary>(row.vad_json);
    const retained = this.retainedPath(row);
    const playable = row.audio_state === "retained" && Boolean(retained) && fs.existsSync(retained!);
    const live = this.active?.id === row.id;
    return {
      id: row.id,
      mode: row.mode,
      retention: row.retention,
      stage: row.stage as CaptureStage,
      audioState: row.audio_state as CaptureAudioState,
      playable,
      durationMs: live ? pcmDurationMs(this.active!.bytes) : row.duration_ms,
      createdAt: row.created_at,
      stoppedAt: row.stopped_at,
      workId: row.work_id,
      deviceLabel: row.device_label,
      resourceId: first?.resource_id ?? null,
      error: parseJson<{ code: string; message: string }>(row.error_json),
      segments: { total, done: by("done"), failed: by("failed"), pending: by("pending") + by("uploaded"), noSpeech: by("no_speech") },
      speechMs: vad ? vad.speechMs : null,
    };
  }

  status(sessionId?: string): { active: SessionView | null; session: SessionView | null } {
    const active = this.active ? this.view(this.row(this.active.id)) : null;
    if (!sessionId) return { active, session: active };
    return { active, session: this.view(this.row(sessionId)) };
  }

  list(input: { resourceId?: string; workId?: string; limit?: number }): { sessions: SessionView[] } {
    const limit = input.limit ?? 50;
    const rows = input.resourceId
      ? this.db.prepare("SELECT s.* FROM capture_sessions s WHERE s.id IN (SELECT DISTINCT session_id FROM capture_events WHERE resource_id = ?) ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?").all(input.resourceId, limit)
      : input.workId
        ? this.db.prepare("SELECT * FROM capture_sessions WHERE work_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(input.workId, limit)
        : this.db.prepare("SELECT * FROM capture_sessions ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit);
    return { sessions: (rows as SessionRow[]).map((row) => this.view(row)) };
  }

  // ------------------------------------------------------------------ recording

  start(input: { mode: "hold" | "toggle"; resourceId?: string; resourceRevisionId?: string; locator?: SourceLocator; retention?: "keep" | "discard"; deviceLabel?: string }): { sessionId: string; retention: "keep" | "discard"; mode: string; sampleRate: number; startedAt: string } {
    this.assertCurrent();
    if (this.active) throw new MangaError("VALIDATION_ERROR", "a recording is already in progress", { details: { reason: "already_recording", sessionId: this.active.id } });
    let workId: string | null = null;
    if (input.resourceId) {
      const resource = this.db.prepare("SELECT work_id FROM resources WHERE id = ?").get(input.resourceId) as { work_id: string | null } | undefined;
      if (!resource) throw new MangaError("NOT_FOUND", "the resource to record against does not exist");
      workId = resource.work_id;
      if (input.resourceRevisionId) {
        const revision = this.db.prepare("SELECT id FROM resource_revisions WHERE id = ? AND resource_id = ?").get(input.resourceRevisionId, input.resourceId);
        if (!revision) throw new MangaError("NOT_FOUND", "resource revision does not belong to this resource");
      }
    }
    if (input.locator && input.locator.kind !== "text" && input.resourceRevisionId) this.deps.validateLocator?.(input.resourceRevisionId, input.locator);
    const retention = input.retention ?? readRecordingSettings(this.deps.store).retention;
    const id = createId("cap");
    const now = new Date().toISOString();
    const name = stagingName(id);
    const file = path.join(this.deps.store.attachmentsDir, name);
    const fd = fs.openSync(file, "a");
    try {
      this.db.prepare("INSERT INTO capture_sessions(id, clock_json, status, attachment_id, created_at, mode, retention, audio_state, stage, duration_ms, staging_name, device_label, work_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        id, JSON.stringify({ domainId: createId("clk"), startedAtMs: Date.now(), sampleRate: PCM_SAMPLE_RATE }), "recording", null, now, input.mode, retention, "staged", "recording", 0, name, input.deviceLabel ?? null, workId, now,
      );
    } catch (error) {
      fs.closeSync(fd);
      fs.rmSync(file, { force: true });
      throw error;
    }
    const stream = this.deps.vad.available ? this.deps.vad.open() : null;
    this.active = {
      id, file, fd, bytes: 0, nextSeq: 0, lastChunkBytes: 0, stream, segmenter: new VadSegmenter({ marginMs: readRecordingSettings(this.deps.store).boundaryMarginMs }),
      closedSegments: [], feed: Promise.resolve(), fedBytes: 0, filterBroken: stream === null, events: 0, lastSampleAt: -Infinity, gaps: [], stopping: false,
    };
    // The starting place is recorded at once, so even a recording with no recognized speech knows where it began.
    this.insertEvent(id, { offsetMs: 0, reason: "start", resourceId: input.resourceId, resourceRevisionId: input.resourceRevisionId, locator: input.locator });
    this.deps.notify("capture.changed", { sessionId: id, stage: "recording" });
    return { sessionId: id, retention, mode: input.mode, sampleRate: PCM_SAMPLE_RATE, startedAt: now };
  }

  private requireActive(sessionId: string): Active {
    this.assertCurrent();
    if (!this.active || this.active.id !== sessionId || this.active.stopping) throw new MangaError("VALIDATION_ERROR", "this recording is not in progress", { details: { reason: "not_recording" } });
    return this.active;
  }

  append(sessionId: string, seq: number, data: string): { offsetMs: number; duplicate: boolean } {
    const active = this.requireActive(sessionId);
    if (seq < active.nextSeq) return { offsetMs: pcmDurationMs(active.bytes), duplicate: true };
    const buffer = Buffer.from(data, "base64");
    if (!buffer.length || buffer.length % 2 || buffer.length > MAX_CHUNK_BYTES) throw new MangaError("VALIDATION_ERROR", "an audio chunk must be whole 16-bit samples");
    if (seq > active.nextSeq) {
      // Chunks went missing between the renderer and here. Silence keeps every later offset true; the hole is remembered.
      const missing = Math.min(seq - active.nextSeq, 600);
      const fill = Buffer.alloc((active.lastChunkBytes || 3200) * missing);
      active.gaps.push({ atMs: pcmDurationMs(active.bytes), ms: pcmDurationMs(fill.length) });
      this.write(active, fill);
    }
    this.write(active, buffer);
    active.nextSeq = seq + 1;
    active.lastChunkBytes = buffer.length;
    return { offsetMs: pcmDurationMs(active.bytes), duplicate: false };
  }

  /** Wait until the live filter has caught up with what was appended; used by callers that feed audio faster than real time. */
  async drainFilter(sessionId: string): Promise<void> {
    if (this.active?.id === sessionId) await this.active.feed;
  }

  private write(active: Active, buffer: Buffer): void {
    fs.writeSync(active.fd, buffer);
    active.bytes += buffer.length;
    if (active.filterBroken || !active.stream) return;
    if (active.bytes - active.fedBytes > MAX_FILTER_LAG_BYTES) {
      // The live filter is not keeping up; the full pass after the recording replaces it.
      active.filterBroken = true;
      return;
    }
    const samples = new Int16Array(buffer.length / 2);
    for (let i = 0; i < samples.length; i += 1) samples[i] = buffer.readInt16LE(i * 2);
    const stream = active.stream;
    active.feed = active.feed.then(async () => {
      if (active.filterBroken) return;
      try {
        const probabilities = await stream.push(samples);
        active.closedSegments.push(...active.segmenter.push(probabilities));
        active.fedBytes += samples.length * 2;
      } catch {
        active.filterBroken = true;
      }
    });
  }

  private insertEvent(sessionId: string, event: { offsetMs: number; reason: CaptureEventReason; resourceId?: string; resourceRevisionId?: string; locator?: SourceLocator; playing?: boolean; playbackRate?: number }): void {
    const payload = { clockDomainId: "capture", ...(event.locator ? { locator: event.locator } : {}), ...(event.playing !== undefined ? { playing: event.playing } : {}), ...(event.playbackRate !== undefined ? { playbackRate: event.playbackRate } : {}) };
    this.db.prepare("INSERT INTO capture_events(session_id, payload_json, offset_ms, reason, resource_id, resource_revision_id) VALUES (?,?,?,?,?,?)").run(
      sessionId, JSON.stringify(payload), Math.max(0, Math.round(event.offsetMs)), event.reason, event.resourceId ?? null, event.resourceRevisionId ?? null,
    );
  }

  event(input: { sessionId: string; offsetMs: number; reason: CaptureEventReason; resourceId?: string; resourceRevisionId?: string; locator?: SourceLocator; playing?: boolean; playbackRate?: number }): { stored: boolean } {
    const active = this.requireActive(input.sessionId);
    if (input.reason === "sample") {
      if (input.offsetMs - active.lastSampleAt < SAMPLE_THIN_MS) return { stored: false };
      active.lastSampleAt = input.offsetMs;
    }
    if (active.events >= MAX_EVENTS) throw new MangaError("QUOTA_EXCEEDED", "this recording has reached its limit of position events");
    if (input.resourceId && input.resourceRevisionId) {
      const revision = this.db.prepare("SELECT id FROM resource_revisions WHERE id = ? AND resource_id = ?").get(input.resourceRevisionId, input.resourceId);
      if (!revision) throw new MangaError("NOT_FOUND", "resource revision does not belong to this resource");
    }
    // An event is a fact about the reader; it is kept even if audio for that moment has not arrived yet, but never placed past the end by much.
    const offsetMs = Math.min(input.offsetMs, pcmDurationMs(active.bytes) + EVENT_AHEAD_MS);
    this.insertEvent(input.sessionId, { ...input, offsetMs });
    active.events += 1;
    return { stored: true };
  }

  /** End a recording: finish the file, keep what was captured, and hand it on to filtering. Never throws away audio. */
  async stop(input: { sessionId: string; reason?: CaptureStopReason; durationMs?: number }): Promise<SessionView> {
    const active = this.active && this.active.id === input.sessionId && !this.active.stopping ? this.active : null;
    if (!active) {
      // A second stop (a repeated key event, a late stop from the renderer) is harmless once the recording has ended.
      const row = this.row(input.sessionId);
      if (row.stage !== "recording") return this.view(row);
      throw new MangaError("VALIDATION_ERROR", "this recording is not in progress", { details: { reason: "not_recording" } });
    }
    active.stopping = true;
    if (input.durationMs !== undefined) {
      const claimed = Math.round(input.durationMs);
      const have = pcmDurationMs(active.bytes);
      // The renderer's own count says audio went missing at the tail: silence restores the length the events were measured on.
      if (claimed > have + 400 && claimed - have <= MAX_PAD_MS) {
        const fill = Buffer.alloc(Math.round((claimed - have) * PCM_BYTES_PER_MS) & ~1);
        active.gaps.push({ atMs: have, ms: pcmDurationMs(fill.length) });
        fs.writeSync(active.fd, fill);
        active.bytes += fill.length;
        active.filterBroken = true;
      }
    }
    await Promise.race([active.feed, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
    fs.closeSync(active.fd);
    active.stream?.close();
    const totalMs = pcmDurationMs(active.bytes);
    this.insertEvent(active.id, { offsetMs: totalMs, reason: "stop" });
    let summary: VadSummary | null = null;
    const wholeFrames = Math.floor(active.bytes / 2 / 512) * 512 * 2;
    if (!active.filterBroken && active.fedBytes >= wholeFrames) {
      const segments = [...active.closedSegments, ...active.segmenter.flush(totalMs)];
      summary = this.summarize(segments, totalMs, false, active.gaps);
    }
    this.active = null;
    const stopReason = input.reason ?? "user";
    this.patch(active.id, {
      status: "stopped", stage: "recorded", duration_ms: totalMs, stopped_at: new Date().toISOString(),
      vad_json: summary ? JSON.stringify(summary) : null,
      error_json: stopReason === "user" || stopReason === "shutdown" ? null : JSON.stringify({ code: "INTERRUPTED", message: `recording ended: ${stopReason}` }),
    });
    this.deps.notify("capture.changed", { sessionId: active.id, stage: "recorded", reason: stopReason });
    // A recording that holds no audio (stopped at once, or the device never delivered) has nothing to filter.
    if (active.bytes === 0) {
      this.finishEmpty(active.id);
      return this.view(this.row(active.id));
    }
    this.pipeline.schedule(active.id);
    return this.view(this.row(active.id));
  }

  summarize(segments: SpeechSegment[], totalMs: number, analyzedFull: boolean, gaps: Array<{ atMs: number; ms: number }> = []): VadSummary {
    return {
      version: 1, totalMs, analyzedFull, config: { marginMs: readRecordingSettings(this.deps.store).boundaryMarginMs },
      segments, speechMs: segments.reduce((sum, segment) => sum + (segment.speechEndMs - segment.speechStartMs), 0), gaps,
    };
  }

  private finishEmpty(id: string): void {
    this.patch(id, { stage: "no_speech", audio_state: "cleaned", vad_json: JSON.stringify(this.summarize([], 0, true)) });
    const row = this.row(id);
    const staged = this.stagingPath(row);
    if (staged) fs.rmSync(staged, { force: true });
    this.patch(id, { staging_name: null });
    this.deps.notify("capture.changed", { sessionId: id, stage: "no_speech" });
  }

  /** Stop recording because the module is turned off or the app is closing; what was captured is kept and filtered later. */
  async shutdown(reason: CaptureStopReason): Promise<void> {
    this.pipeline.abortAll();
    if (this.active && !this.active.stopping) await this.stop({ sessionId: this.active.id, reason });
  }

  /** After a crash or restart: a recording that was in progress becomes a stopped one holding what reached the disk. */
  recover(): { recovered: string[] } {
    this.assertCurrent();
    const recovered: string[] = [];
    const rows = this.db.prepare("SELECT * FROM capture_sessions WHERE stage IN ('recording','recorded','filtering','transcribing')").all() as SessionRow[];
    for (const row of rows) {
      if (this.active?.id === row.id) continue;
      if (row.stage === "recording") {
        const file = this.stagingPath(row);
        const bytes = file && fs.existsSync(file) ? fs.statSync(file).size & ~1 : 0;
        if (!bytes) {
          this.patch(row.id, { status: "stopped", stage: "failed", audio_state: "none", error_json: JSON.stringify({ code: "INTERRUPTED", message: "the app stopped before any audio was saved" }), stopped_at: new Date().toISOString() });
          if (file) fs.rmSync(file, { force: true });
          recovered.push(row.id);
          continue;
        }
        const totalMs = pcmDurationMs(bytes);
        const last = this.db.prepare("SELECT MAX(offset_ms) AS m FROM capture_events WHERE session_id = ?").get(row.id) as { m: number | null };
        this.insertEvent(row.id, { offsetMs: Math.max(totalMs, last.m ?? 0), reason: "stop" });
        this.patch(row.id, { status: "stopped", stage: "recorded", duration_ms: totalMs, stopped_at: new Date().toISOString(), error_json: JSON.stringify({ code: "INTERRUPTED", message: "the app stopped while recording; the saved part was recovered" }) });
        this.pipeline.schedule(row.id);
      } else if (row.stage === "filtering" || row.stage === "recorded") {
        // Stopped but not yet filtered (the app closed, or the module was off): pick it up again.
        if (row.stage === "filtering") this.patch(row.id, { stage: "recorded" });
        this.pipeline.schedule(row.id);
      } else {
        // Uploads in flight were lost with the process: what is done stays done, the rest waits for a retry.
        this.db.prepare("UPDATE transcript_segments SET state = 'pending' WHERE session_id = ? AND state = 'uploaded'").run(row.id);
        this.patch(row.id, { stage: "pending" });
      }
      recovered.push(row.id);
    }
    return { recovered };
  }

  // ------------------------------------------------------------------ review

  review(sessionId: string) {
    const row = this.row(sessionId);
    const segments = this.db.prepare("SELECT id, seq, chunk_key, start_ms, end_ms, text, revised_text, state, precision, calibrated, anchors_json, attempts, error_json FROM transcript_segments WHERE session_id = ? ORDER BY start_ms, seq, id").all(sessionId) as Array<Record<string, unknown>>;
    const vad = parseJson<VadSummary>(row.vad_json);
    const total = this.active?.id === row.id ? pcmDurationMs(this.active.bytes) : row.duration_ms;
    // Every stretch of the recording that no block covers was filtered out: the quiet between sentences, music, noise.
    const covered = segments.map((item) => [item.start_ms as number, item.end_ms as number] as const).sort((a, b) => a[0] - b[0]);
    const filtered: Array<{ startMs: number; endMs: number }> = [];
    let cursor = 0;
    for (const [from, to] of covered) {
      if (from > cursor) filtered.push({ startMs: cursor, endMs: from });
      cursor = Math.max(cursor, to);
    }
    if (total > cursor && (segments.length || vad)) filtered.push({ startMs: cursor, endMs: total });
    return {
      session: this.view(row),
      segments: segments.map((item) => ({
        id: item.id as string,
        seq: item.seq as number,
        startMs: item.start_ms as number,
        endMs: item.end_ms as number,
        text: (item.revised_text as string | null) ?? (item.text as string),
        originalText: item.text as string,
        revised: item.revised_text !== null,
        state: item.state as string,
        precision: item.precision as string,
        calibrated: item.calibrated === 1,
        anchors: parseJson<SegmentAnchor[]>(item.anchors_json as string) ?? [],
        attempts: item.attempts as number,
        error: parseJson<{ code: string; message: string }>(item.error_json as string | null),
      })),
      filtered: filtered.filter((gap) => gap.endMs - gap.startMs >= 200),
      drafts: this.organizer.list(sessionId),
      audio: { state: row.audio_state, playable: this.view(row).playable },
    };
  }

  reviseSegment(segmentId: string, text: string): { segmentId: string; text: string } {
    this.assertCurrent();
    const row = this.db.prepare("SELECT id, session_id, state FROM transcript_segments WHERE id = ?").get(segmentId) as { id: string; session_id: string; state: string } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "transcript segment not found");
    // A revision is the user's own text: it never changes the original, and a retry of the recognition never replaces it.
    this.db.prepare("UPDATE transcript_segments SET revised_text = ?, updated_at = ? WHERE id = ?").run(text, new Date().toISOString(), segmentId);
    return { segmentId, text };
  }

  calibrate(input: { segmentId: string; resourceId: string; resourceRevisionId: string; locator: SourceLocator }): { segmentId: string; anchors: SegmentAnchor[] } {
    this.assertCurrent();
    const row = this.db.prepare("SELECT id, start_ms, end_ms FROM transcript_segments WHERE id = ?").get(input.segmentId) as { id: string; start_ms: number; end_ms: number } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "transcript segment not found");
    const revision = this.db.prepare("SELECT id FROM resource_revisions WHERE id = ? AND resource_id = ?").get(input.resourceRevisionId, input.resourceId);
    if (!revision) throw new MangaError("NOT_FOUND", "resource revision does not belong to this resource");
    if (input.locator.kind !== "text") this.deps.validateLocator?.(input.resourceRevisionId, input.locator);
    const anchors: SegmentAnchor[] = [{ startMs: row.start_ms, endMs: row.end_ms, resourceId: input.resourceId, resourceRevisionId: input.resourceRevisionId, locator: input.locator }];
    this.db.prepare("UPDATE transcript_segments SET anchors_json = ?, calibrated = 1, precision = 'manual', updated_at = ? WHERE id = ?").run(JSON.stringify(anchors), new Date().toISOString(), input.segmentId);
    return { segmentId: input.segmentId, anchors };
  }

  // ------------------------------------------------------------------ terms

  terms(workId: string): { terms: Array<{ term: string; heard: string | null }> } {
    const rows = this.db.prepare("SELECT term, heard FROM work_terms WHERE work_id = ? ORDER BY created_at, rowid").all(workId) as Array<{ term: string; heard: string | null }>;
    return { terms: rows };
  }

  addTerm(workId: string, term: string, heard?: string): { term: string; heard: string | null } {
    if (!this.db.prepare("SELECT id FROM works WHERE id = ?").get(workId)) throw new MangaError("NOT_FOUND", "work not found");
    const clean = term.trim();
    if (!clean) throw new MangaError("VALIDATION_ERROR", "a term cannot be empty");
    this.db.prepare("INSERT INTO work_terms(id, work_id, term, heard, created_at) VALUES (?,?,?,?,?) ON CONFLICT(work_id, term) DO UPDATE SET heard = excluded.heard").run(createId("trm"), workId, clean, heard?.trim() || null, new Date().toISOString());
    return { term: clean, heard: heard?.trim() || null };
  }

  removeTerm(workId: string, term: string): { removed: boolean } {
    return { removed: this.db.prepare("DELETE FROM work_terms WHERE work_id = ? AND term = ?").run(workId, term.trim()).changes > 0 };
  }

  // ------------------------------------------------------------------ audio

  /** A playable URL for a retained recording. A recording that is not retained has no playback to offer, and says why. */
  audioHandle(sessionId: string): { url: string; mediaType: string; durationMs: number } {
    this.assertCurrent();
    const row = this.row(sessionId);
    const file = this.retainedPath(row);
    if (row.audio_state !== "retained" || !file || !fs.existsSync(file)) {
      throw new MangaError("NOT_FOUND", row.audio_state === "cleaned" ? "the audio was not kept" : "the audio is not available for playback", { details: { audioState: row.audio_state } });
    }
    const issued = this.deps.media.handles.issue({ kind: "file", path: file, mediaType: RETAINED_MEDIA_TYPE }, { moduleId: VOICE_MODULE, subject: sessionId }, { ttlMs: HANDLE_TTL_MS });
    return { url: issued.url, mediaType: RETAINED_MEDIA_TYPE, durationMs: row.duration_ms };
  }

  /** Keep or discard the audio of a finished recording on request. Discarding is the user's decision and removes every copy. */
  async retain(sessionId: string, action: "keep" | "discard"): Promise<SessionView> {
    this.assertCurrent();
    const row = this.row(sessionId);
    if (row.stage === "recording" || this.pipeline.busy(sessionId)) throw new MangaError("VALIDATION_ERROR", "wait until the recording has been processed", { details: { reason: "busy" } });
    if (action === "keep") {
      this.patch(sessionId, { retention: "keep" });
      await this.pipeline.retainAudio(sessionId, new AbortController().signal);
    } else {
      this.deps.media.handles.revokeSubject(sessionId);
      this.patch(sessionId, { retention: "discard" });
      this.pipeline.removeAudio(sessionId, { everything: true });
    }
    return this.view(this.row(sessionId));
  }

  cancel(sessionId: string): { cancelled: boolean } {
    this.assertCurrent();
    const row = this.row(sessionId);
    if (this.active?.id === sessionId) {
      // A recording being cancelled keeps what it captured: stopping is the only way a recording ends.
      void this.stop({ sessionId, reason: "user" }).then(() => this.pipeline.cancel(sessionId), () => undefined);
      return { cancelled: true };
    }
    if (["done", "no_speech", "cancelled"].includes(row.stage)) return { cancelled: false };
    this.pipeline.cancel(sessionId);
    return { cancelled: true };
  }
}
