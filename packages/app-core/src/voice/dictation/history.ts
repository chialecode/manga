import fs from "node:fs";
import path from "node:path";
import {
  type AsrEngineSelection,
  type DictationHistoryItem,
  type DictationReplacement,
  type DictationTimings,
  MangaError,
  type PolishMode,
  createId,
} from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { decodePcm16MonoWav, encodePcm16MonoWav } from "./wav.ts";

export const DICTATION_HISTORY_RETENTION_DAYS = 30;
export const DICTATION_HISTORY_RETENTION_MS = DICTATION_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const DICTATION_AUDIO_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DICTATION_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

type HistoryRow = {
  id: string;
  work_id: string | null;
  engine_kind: string;
  engine_id: string;
  model_id: string;
  polish_mode: PolishMode;
  raw_text: string;
  corrected_text: string;
  final_text: string;
  fallback_reason: string | null;
  timings_json: string;
  replacements_json: string;
  audio_rel_path: string | null;
  audio_expires_at: string | null;
  created_at: string;
};

export type RetranscribePipelineOutput = {
  engineKind: string;
  engineId: string;
  modelId: string;
  rawText: string;
  correctedText: string;
  finalText: string;
  fallbackReason: string | null;
  timings: DictationTimings;
  replacements: DictationReplacement[];
};

export type RetranscribePipeline = (input: {
  pcm16le: Buffer;
  wavBytes: Buffer;
  workId: string | null;
  polishMode: PolishMode;
  engine: AsrEngineSelection;
}) => Promise<RetranscribePipelineOutput>;

function parseJsonOr<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export class DictationHistoryService {
  private readonly store: DrizzleStore;
  readonly audioDir: string;
  private readonly now: () => Date;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: {
    store: DrizzleStore;
    appRoot: string;
    now?: () => Date;
    startPruneTimer?: boolean;
  }) {
    this.store = options.store;
    this.audioDir = path.join(options.appRoot, "dictation-audio");
    this.now = options.now ?? (() => new Date());

    // Prune >30d history records and >24h WAV files on startup.
    this.pruneExpired();

    if (options.startPruneTimer !== false) {
      this.pruneTimer = setInterval(() => {
        try {
          this.pruneExpired();
        } catch {
          /* ignore background prune errors when DB is closing */
        }
      }, DICTATION_PRUNE_INTERVAL_MS);
      if (typeof this.pruneTimer === "object" && this.pruneTimer !== null && "unref" in this.pruneTimer) {
        this.pruneTimer.unref();
      }
    }
  }

  close(): void {
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
  }

  private resolveSafeAudioPath(relPath: string): string | null {
    if (!relPath || path.isAbsolute(relPath)) return null;
    const resolvedDir = path.resolve(this.audioDir);
    const full = path.resolve(resolvedDir, relPath);
    const rel = path.relative(resolvedDir, full);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return full;
  }

  private unlinkAudioSafe(relPath: string | null | undefined): boolean {
    if (!relPath) return false;
    const full = this.resolveSafeAudioPath(relPath);
    if (!full || !fs.existsSync(full)) return false;
    try {
      fs.rmSync(full, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  private toItem(row: HistoryRow, nowIso: string): DictationHistoryItem {
    let audioAvailable = false;
    let audioExpiresAt: string | null = null;
    if (row.audio_rel_path && row.audio_expires_at && row.audio_expires_at > nowIso) {
      const full = this.resolveSafeAudioPath(row.audio_rel_path);
      if (full && fs.existsSync(full)) {
        audioAvailable = true;
        audioExpiresAt = row.audio_expires_at;
      }
    }
    return {
      id: row.id,
      workId: row.work_id ?? null,
      engineKind: row.engine_kind,
      engineId: row.engine_id,
      modelId: row.model_id,
      polishMode: row.polish_mode,
      rawText: row.raw_text,
      correctedText: row.corrected_text,
      finalText: row.final_text,
      fallbackReason: row.fallback_reason ?? null,
      timings: parseJsonOr<DictationTimings>(row.timings_json, {}),
      replacements: parseJsonOr<DictationReplacement[]>(row.replacements_json, []),
      audioAvailable,
      audioExpiresAt,
      createdAt: row.created_at,
    };
  }

  /**
   * Prunes dictation history rows older than 30 days and retained WAV audio files older than 24 hours.
   */
  pruneExpired(referenceDate: Date = this.now()): { deletedRecords: number; deletedAudioFiles: number } {
    const nowMs = referenceDate.getTime();
    const nowIso = new Date(nowMs).toISOString();
    const cutoff30dIso = new Date(nowMs - DICTATION_HISTORY_RETENTION_MS).toISOString();

    let deletedRecords = 0;
    let deletedAudioFiles = 0;

    // 1. Delete rows older than 30 days (and their audio files, if any).
    const oldRows = this.store.sqlite
      .prepare("SELECT id, audio_rel_path FROM dictation_history WHERE created_at <= ?")
      .all(cutoff30dIso) as Array<{ id: string; audio_rel_path: string | null }>;
    for (const row of oldRows) {
      if (this.unlinkAudioSafe(row.audio_rel_path)) deletedAudioFiles += 1;
    }
    if (oldRows.length > 0) {
      deletedRecords = this.store.sqlite.prepare("DELETE FROM dictation_history WHERE created_at <= ?").run(cutoff30dIso).changes;
    }

    // 2. Delete expired 24-hour audio files while keeping <=30d text history intact.
    const expiredAudioRows = this.store.sqlite
      .prepare("SELECT id, audio_rel_path FROM dictation_history WHERE audio_rel_path IS NOT NULL AND (audio_expires_at IS NULL OR audio_expires_at <= ?)")
      .all(nowIso) as Array<{ id: string; audio_rel_path: string | null }>;
    for (const row of expiredAudioRows) {
      if (this.unlinkAudioSafe(row.audio_rel_path)) deletedAudioFiles += 1;
    }
    if (expiredAudioRows.length > 0) {
      this.store.sqlite
        .prepare("UPDATE dictation_history SET audio_rel_path = NULL, audio_expires_at = NULL WHERE audio_rel_path IS NOT NULL AND (audio_expires_at IS NULL OR audio_expires_at <= ?)")
        .run(nowIso);
    }

    // 3. Sweep orphaned `.wav` / `.tmp` files under `<appRoot>/dictation-audio/`.
    if (fs.existsSync(this.audioDir)) {
      const referenced = new Set(
        (
          this.store.sqlite
            .prepare("SELECT audio_rel_path FROM dictation_history WHERE audio_rel_path IS NOT NULL")
            .all() as Array<{ audio_rel_path: string }>
        ).map((r) => r.audio_rel_path),
      );
      for (const entry of fs.readdirSync(this.audioDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!referenced.has(entry.name)) {
          if (this.unlinkAudioSafe(entry.name)) deletedAudioFiles += 1;
        }
      }
    }

    return { deletedRecords, deletedAudioFiles };
  }

  record(input: {
    id?: string;
    workId?: string | null;
    engineKind: string;
    engineId: string;
    modelId: string;
    polishMode: PolishMode;
    rawText: string;
    correctedText: string;
    finalText: string;
    fallbackReason?: string | null;
    timings?: DictationTimings;
    replacements?: ReadonlyArray<DictationReplacement>;
    pcm16le?: Buffer | null;
    retainAudio24h?: boolean;
    createdAt?: Date;
  }): DictationHistoryItem {
    const id = input.id ?? createId("dhist");
    const createdDate = input.createdAt ?? this.now();
    const createdIso = createdDate.toISOString();

    // Ensure `work_id` FK references an existing row in `works`, otherwise store NULL.
    const validWorkId =
      input.workId && this.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(input.workId)
        ? input.workId
        : null;

    let audioRelPath: string | null = null;
    let audioExpiresAt: string | null = null;

    if (input.retainAudio24h && input.pcm16le && input.pcm16le.byteLength >= 2) {
      fs.mkdirSync(this.audioDir, { recursive: true });
      const fileName = `${id}.wav`;
      const targetPath = path.join(this.audioDir, fileName);
      const tmpPath = `${targetPath}.tmp`;
      const wavBytes = encodePcm16MonoWav(input.pcm16le);
      fs.writeFileSync(tmpPath, wavBytes);
      fs.renameSync(tmpPath, targetPath);
      audioRelPath = fileName;
      audioExpiresAt = new Date(createdDate.getTime() + DICTATION_AUDIO_RETENTION_MS).toISOString();
    }

    this.store.sqlite
      .prepare(
        `INSERT INTO dictation_history (
          id, work_id, engine_kind, engine_id, model_id, polish_mode,
          raw_text, corrected_text, final_text, fallback_reason,
          timings_json, replacements_json, audio_rel_path, audio_expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        validWorkId,
        input.engineKind,
        input.engineId,
        input.modelId,
        input.polishMode,
        input.rawText,
        input.correctedText,
        input.finalText,
        input.fallbackReason ?? null,
        JSON.stringify(input.timings ?? {}),
        JSON.stringify(input.replacements ?? []),
        audioRelPath,
        audioExpiresAt,
        createdIso,
      );

    return this.get(id);
  }

  get(historyId: string): DictationHistoryItem {
    const row = this.store.sqlite.prepare("SELECT * FROM dictation_history WHERE id = ?").get(historyId) as HistoryRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "听写记录不存在");
    return this.toItem(row, this.now().toISOString());
  }

  list(filter: { workId?: string; limit?: number } = {}): { items: DictationHistoryItem[] } {
    this.pruneExpired();
    const nowIso = this.now().toISOString();
    const limit = Math.min(200, Math.max(1, filter.limit ?? 100));
    const rows = filter.workId
      ? (this.store.sqlite
          .prepare("SELECT * FROM dictation_history WHERE work_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
          .all(filter.workId, limit) as HistoryRow[])
      : (this.store.sqlite
          .prepare("SELECT * FROM dictation_history ORDER BY created_at DESC, rowid DESC LIMIT ?")
          .all(limit) as HistoryRow[]);
    return { items: rows.map((row) => this.toItem(row, nowIso)) };
  }

  delete(historyId: string): { historyId: string; deleted: boolean } {
    const row = this.store.sqlite
      .prepare("SELECT id, audio_rel_path FROM dictation_history WHERE id = ?")
      .get(historyId) as { id: string; audio_rel_path: string | null } | undefined;
    if (!row) return { historyId, deleted: false };
    this.unlinkAudioSafe(row.audio_rel_path);
    const deleted = this.store.sqlite.prepare("DELETE FROM dictation_history WHERE id = ?").run(historyId).changes > 0;
    return { historyId, deleted };
  }

  clear(): { deleted: number } {
    const rows = this.store.sqlite
      .prepare("SELECT audio_rel_path FROM dictation_history WHERE audio_rel_path IS NOT NULL")
      .all() as Array<{ audio_rel_path: string }>;
    for (const row of rows) this.unlinkAudioSafe(row.audio_rel_path);
    const deleted = this.store.sqlite.prepare("DELETE FROM dictation_history").run().changes;
    if (fs.existsSync(this.audioDir)) {
      for (const entry of fs.readdirSync(this.audioDir, { withFileTypes: true })) {
        if (entry.isFile()) this.unlinkAudioSafe(entry.name);
      }
    }
    return { deleted };
  }

  readRetainedAudio(historyId: string): { item: DictationHistoryItem; wavBytes: Buffer; pcm16le: Buffer } {
    const row = this.store.sqlite.prepare("SELECT * FROM dictation_history WHERE id = ?").get(historyId) as HistoryRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "听写记录不存在");
    const nowIso = this.now().toISOString();
    if (!row.audio_rel_path || !row.audio_expires_at || row.audio_expires_at <= nowIso) {
      if (row.audio_rel_path) {
        this.unlinkAudioSafe(row.audio_rel_path);
        this.store.sqlite
          .prepare("UPDATE dictation_history SET audio_rel_path = NULL, audio_expires_at = NULL WHERE id = ?")
          .run(historyId);
      }
      throw new MangaError("NOT_FOUND", "该听写记录未保留音频，或音频已超过 24 小时过期", {
        details: { reason: "audio_expired" },
      });
    }
    const full = this.resolveSafeAudioPath(row.audio_rel_path);
    if (!full || !fs.existsSync(full)) {
      this.store.sqlite
        .prepare("UPDATE dictation_history SET audio_rel_path = NULL, audio_expires_at = NULL WHERE id = ?")
        .run(historyId);
      throw new MangaError("NOT_FOUND", "听写音频文件已不存在", { details: { reason: "audio_missing" } });
    }
    const wavBytes = fs.readFileSync(full);
    const { pcm16le } = decodePcm16MonoWav(wavBytes);
    return { item: this.toItem(row, nowIso), wavBytes, pcm16le };
  }

  /**
   * Re-runs speech recognition, phonetic correction, and polish on a retained 24-hour WAV recording using `engine`.
   */
  async retranscribe(
    historyId: string,
    engine: AsrEngineSelection,
    pipeline: RetranscribePipeline,
  ): Promise<DictationHistoryItem> {
    const { item, wavBytes, pcm16le } = this.readRetainedAudio(historyId);
    const result = await pipeline({
      pcm16le,
      wavBytes,
      workId: item.workId,
      polishMode: item.polishMode,
      engine,
    });

    this.store.sqlite
      .prepare(
        `UPDATE dictation_history
         SET engine_kind = ?, engine_id = ?, model_id = ?,
             raw_text = ?, corrected_text = ?, final_text = ?, fallback_reason = ?,
             timings_json = ?, replacements_json = ?
         WHERE id = ?`,
      )
      .run(
        result.engineKind,
        result.engineId,
        result.modelId,
        result.rawText,
        result.correctedText,
        result.finalText,
        result.fallbackReason ?? null,
        JSON.stringify(result.timings ?? {}),
        JSON.stringify(result.replacements ?? []),
        historyId,
      );

    return this.get(historyId);
  }
}
