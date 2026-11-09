import fs from "node:fs";
import path from "node:path";

/** One play copy as the store keeps it. The full app keeps these in the `play_copies` table; light open keeps them in a JSON file. */
export type PlayCopyRow = {
  id: string;
  revisionId: string;
  reason: string;
  state: "queued" | "running" | "ready" | "failed";
  audioStreamIndex: number | null;
  fileName: string | null;
  bytes: number | null;
  encoder: string | null;
  toolVersion: string | null;
  progress: number;
  timestampCheck: { originalFrames: number; copyFrames: number; maxDriftMs: number; ok: boolean } | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Where the rows of play copies are kept. The rules (what is reused, what is evicted, what a restart cleans up) live in `PlayCopies`; a store only
 * reads and writes rows. Lists come newest first (by creation, then by insertion).
 */
export interface PlayCopyStore {
  byRevision(revisionId: string): PlayCopyRow[];
  get(id: string): PlayCopyRow | undefined;
  all(): PlayCopyRow[];
  insert(row: PlayCopyRow): void;
  update(id: string, patch: Partial<Omit<PlayCopyRow, "id">>): void;
  delete(id: string): void;
}

type SqliteLike = { prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown } };
type DbRow = {
  id: string; resource_revision_id: string; reason: string; state: PlayCopyRow["state"]; audio_stream_index: number | null; file_name: string | null; bytes: number | null;
  encoder: string | null; tool_version: string | null; progress: number; timestamp_check_json: string | null; error_json: string | null; created_at: string; updated_at: string;
};
const COLUMNS: Record<keyof Omit<PlayCopyRow, "id">, string> = {
  revisionId: "resource_revision_id", reason: "reason", state: "state", audioStreamIndex: "audio_stream_index", fileName: "file_name", bytes: "bytes", encoder: "encoder",
  toolVersion: "tool_version", progress: "progress", timestampCheck: "timestamp_check_json", error: "error_json", createdAt: "created_at", updatedAt: "updated_at",
};
const toColumn = (key: keyof Omit<PlayCopyRow, "id">, value: unknown): unknown => (key === "timestampCheck" || key === "error" ? (value ? JSON.stringify(value) : null) : value);

function fromDb(row: DbRow): PlayCopyRow {
  return {
    id: row.id, revisionId: row.resource_revision_id, reason: row.reason, state: row.state, audioStreamIndex: row.audio_stream_index, fileName: row.file_name, bytes: row.bytes,
    encoder: row.encoder, toolVersion: row.tool_version, progress: row.progress,
    timestampCheck: row.timestamp_check_json ? JSON.parse(row.timestamp_check_json) as PlayCopyRow["timestampCheck"] : null,
    error: row.error_json ? JSON.parse(row.error_json) as PlayCopyRow["error"] : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** The full app's store: the `play_copies` table of the library database. */
export class SqlitePlayCopyStore implements PlayCopyStore {
  private readonly db: SqliteLike;
  constructor(db: SqliteLike) {
    this.db = db;
  }

  byRevision(revisionId: string): PlayCopyRow[] {
    return (this.db.prepare("SELECT * FROM play_copies WHERE resource_revision_id = ? ORDER BY created_at DESC, rowid DESC").all(revisionId) as DbRow[]).map(fromDb);
  }

  get(id: string): PlayCopyRow | undefined {
    const row = this.db.prepare("SELECT * FROM play_copies WHERE id = ?").get(id) as DbRow | undefined;
    return row ? fromDb(row) : undefined;
  }

  all(): PlayCopyRow[] {
    return (this.db.prepare("SELECT * FROM play_copies ORDER BY rowid").all() as DbRow[]).map(fromDb);
  }

  insert(row: PlayCopyRow): void {
    const keys = Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>;
    this.db.prepare(`INSERT INTO play_copies(id, ${keys.map((key) => COLUMNS[key]).join(", ")}) VALUES (?${",?".repeat(keys.length)})`).run(row.id, ...keys.map((key) => toColumn(key, row[key])));
  }

  update(id: string, patch: Partial<Omit<PlayCopyRow, "id">>): void {
    const keys = (Object.keys(patch) as Array<keyof typeof COLUMNS>).filter((key) => key in COLUMNS);
    if (!keys.length) return;
    this.db.prepare(`UPDATE play_copies SET ${keys.map((key) => `${COLUMNS[key]} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((key) => toColumn(key, patch[key])), id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM play_copies WHERE id = ?").run(id);
  }
}

/**
 * Light open's store: one JSON file next to the copies (A-128). It is written whole after every change through a temporary file, so a crash leaves
 * the old list or the new one; a file that cannot be read is treated as empty, and the copies it named are then removed as strays by `recover`.
 */
export class JsonPlayCopyStore implements PlayCopyStore {
  private rows: PlayCopyRow[];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.rows = JsonPlayCopyStore.read(file);
  }

  private static read(file: string): PlayCopyRow[] {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: number; copies?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.copies)) return [];
      return parsed.copies.filter((row): row is PlayCopyRow => Boolean(row) && typeof (row as PlayCopyRow).id === "string" && typeof (row as PlayCopyRow).revisionId === "string");
    } catch {
      return [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const staging = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(staging, `${JSON.stringify({ version: 1, copies: this.rows })}\n`);
    fs.renameSync(staging, this.file);
  }

  byRevision(revisionId: string): PlayCopyRow[] {
    // Insertion order is the rowid order; newest first, as the table answers.
    return this.rows.map((row, order) => ({ row, order })).filter(({ row }) => row.revisionId === revisionId)
      .sort((a, b) => b.row.createdAt.localeCompare(a.row.createdAt) || b.order - a.order).map(({ row }) => ({ ...row }));
  }

  get(id: string): PlayCopyRow | undefined {
    const row = this.rows.find((item) => item.id === id);
    return row ? { ...row } : undefined;
  }

  all(): PlayCopyRow[] {
    return this.rows.map((row) => ({ ...row }));
  }

  insert(row: PlayCopyRow): void {
    this.rows.push({ ...row });
    this.save();
  }

  update(id: string, patch: Partial<Omit<PlayCopyRow, "id">>): void {
    const index = this.rows.findIndex((row) => row.id === id);
    if (index < 0) return;
    this.rows[index] = { ...this.rows[index]!, ...patch };
    this.save();
  }

  delete(id: string): void {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.id !== id);
    if (this.rows.length !== before) this.save();
  }
}
