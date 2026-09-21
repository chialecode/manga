import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createId, MangaError, type CommandResult, type SearchHit, type SearchQuery } from "@manga/contracts";
import { SCHEMA_SQL, STORAGE_SCHEMA_VERSION } from "./schema.ts";
import { ngramsFor, matchQuery } from "./ngrams.ts";

export type SqliteStoreOptions = {
  profileDir: string;
  hostId: string;
  crashAt?: string;
};

export type Mutation = {
  sql: string;
  params?: Array<string | number | bigint | null | Uint8Array | Buffer>;
};

export type CommitInput = {
  mutations: Mutation[];
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  idempotencyKey?: string;
  commandId?: string;
  result?: unknown;
};

export class SqliteStore {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly attachmentsDir: string;
  private closed = false;
  readonly crashAt?: string;
  readonly options: SqliteStoreOptions;
  private listeners: Array<(event: { type: string; payload: Record<string, unknown>; seq: number }) => void> = [];

  constructor(options: SqliteStoreOptions) {
    this.options = options;
    fs.mkdirSync(options.profileDir, { recursive: true });
    this.attachmentsDir = path.join(options.profileDir, "attachments");
    fs.mkdirSync(this.attachmentsDir, { recursive: true });
    this.dbPath = path.join(options.profileDir, "manga.sqlite");
    this.crashAt = options.crashAt;
    this.db = new DatabaseSync(this.dbPath);
    const hasMeta=this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'").get();
    const existingVersion=hasMeta ? Number(this.db.prepare("SELECT value FROM schema_meta WHERE key='schemaVersion'").get()?.value) : 0;
    if (existingVersion > STORAGE_SCHEMA_VERSION) {
      this.db.close();
      throw new MangaError("API_INCOMPATIBLE","data schema is newer than this prototype; open with a compatible version or restore a compatible backup");
    }
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA_SQL);
    this.db.prepare("INSERT OR IGNORE INTO schema_meta(key, value) VALUES (?, ?)").run("schemaVersion", String(STORAGE_SCHEMA_VERSION));
  }

  onEvent(listener: (event: { type: string; payload: Record<string, unknown>; seq: number }) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  loadIdempotent(key: string): CommandResult | undefined {
    const row = this.db.prepare("SELECT result_json FROM operations WHERE idempotency_key = ?").get(key) as
      | { result_json: string }
      | undefined;
    if (!row) return undefined;
    return JSON.parse(row.result_json) as CommandResult;
  }

  unpublishedEvents(): Array<{ seq: number; type: string; payload: Record<string, unknown> }> {
    const rows = this.db.prepare("SELECT seq, type, payload_json FROM domain_events WHERE published_at IS NULL ORDER BY seq").all() as Array<{
      seq: number;
      type: string;
      payload_json: string;
    }>;
    return rows.map((row) => ({ seq: row.seq, type: row.type, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
  }

  replayUnpublished(): void {
    for (const event of this.unpublishedEvents()) {
      for (const listener of this.listeners) listener(event);
      this.db.prepare("UPDATE domain_events SET published_at = ? WHERE seq = ?").run(new Date().toISOString(), event.seq);
    }
  }

  maybeCrash(stage: string): void {
    if (this.crashAt && this.crashAt === stage) {
      process.exit(99);
    }
  }

  commit(input: CommitInput): { seqs: number[] } {
    this.maybeCrash("after-validate-before-tx");
    if (input.idempotencyKey) {
      const existing = this.loadIdempotent(input.idempotencyKey);
      if (existing) return { seqs: [] };
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.maybeCrash("in-tx-before-commit");
      for (const mutation of input.mutations) {
        this.db.prepare(mutation.sql).run(...(mutation.params ?? []));
      }
      const seqs: number[] = [];
      const now = new Date().toISOString();
      for (const event of input.events) {
        const eventId = createId("evt");
        this.db.prepare(
          "INSERT INTO domain_events(event_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)",
        ).run(eventId, event.type, JSON.stringify(event.payload), now);
        const row = this.db.prepare("SELECT seq FROM domain_events WHERE event_id = ?").get(eventId) as { seq: number };
        seqs.push(row.seq);
      }
      if (input.idempotencyKey) {
        const result: CommandResult = { status: "ok", value: input.result ?? { ok: true } };
        this.db.prepare(
          "INSERT INTO operations(idempotency_key, command_id, result_json, committed_at) VALUES (?, ?, ?, ?)",
        ).run(input.idempotencyKey, input.commandId ?? "unknown", JSON.stringify(result), now);
      }
      this.db.exec("COMMIT");
      this.maybeCrash("after-commit-before-events");
      for (const seq of seqs) {
        const row = this.db.prepare("SELECT type, payload_json FROM domain_events WHERE seq = ?").get(seq) as {
          type: string;
          payload_json: string;
        };
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        for (const listener of this.listeners) listener({ type: row.type, payload, seq });
        this.db.prepare("UPDATE domain_events SET published_at = ? WHERE seq = ?").run(now, seq);
      }
      this.maybeCrash("after-events");
      return { seqs };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback of a closed/crashed connection
      }
      throw error;
    }
  }

  search(query: SearchQuery): SearchHit[] {
    const limit = query.limit ?? 20;
    const match = matchQuery(query.text);
    if (!match) return [];
    const filters = ["ngrams MATCH ?"];
    const params: Array<string | number> = [match];
    for (const [column, values] of [["resource_id", query.readAllowlist], ["resource_id", query.resourceIds], ["kind", query.kinds]] as const) {
      if (values === undefined) continue;
      if (!values.length) return [];
      filters.push(`${column} IN (${values.map(() => "?").join(",")})`);
      params.push(...values);
    }
    const rows = this.db.prepare(
      `SELECT fragment_id, kind, resource_id, text FROM search_idx WHERE ${filters.join(" AND ")} LIMIT ?`,
    ).all(...params, limit) as Array<{ fragment_id: string; kind: SearchHit["kind"]; resource_id?: string; text: string }>;
    const hits: SearchHit[] = [];
    for (const row of rows) {
      hits.push({
        fragmentId: row.fragment_id,
        resourceId: row.resource_id,
        kind: row.kind,
        text: row.text,
        score: 1,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  indexFragment(input: {
    id: string;
    resourceId?: string;
    objectId?: string;
    kind: SearchHit["kind"];
    text: string;
    locator?: unknown;
  }): Mutation[] {
    const ngrams = ngramsFor(input.text);
    return [
      {
        sql: `INSERT OR REPLACE INTO text_fragments(id, resource_id, object_id, kind, text, ngrams, locator_json) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [input.id, input.resourceId ?? null, input.objectId ?? null, input.kind, input.text, ngrams, JSON.stringify(input.locator ?? null)],
      },
      {
        sql: `INSERT INTO search_idx(fragment_id, kind, resource_id, text, ngrams) VALUES (?, ?, ?, ?, ?)`,
        params: [input.id, input.kind, input.resourceId ?? "", input.text, ngrams],
      },
    ];
  }

  rebuildSearchIndex(): void {
    this.db.exec("DELETE FROM search_idx;");
    const rows = this.db.prepare("SELECT id, kind, resource_id, text, ngrams FROM text_fragments").all() as Array<{
      id: string;
      kind: string;
      resource_id?: string;
      text: string;
      ngrams: string;
    }>;
    const insert = this.db.prepare("INSERT INTO search_idx(fragment_id, kind, resource_id, text, ngrams) VALUES (?, ?, ?, ?, ?)");
    this.db.exec("BEGIN");
    for (const row of rows) insert.run(row.id, row.kind, row.resource_id ?? "", row.text, row.ngrams);
    this.db.exec("COMMIT");
  }

  migrate(toVersion: number, statements: string[], fail = false): void {
    this.db.exec("BEGIN");
    try {
      for (const sql of statements) this.db.exec(sql);
      if (fail) throw new MangaError("VALIDATION_ERROR", "forced migration failure");
      this.db.prepare("UPDATE schema_meta SET value = ? WHERE key = ?").run(String(toVersion), "schemaVersion");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  backupTo(targetDir: string): { files: string[] } {
    fs.mkdirSync(targetDir, { recursive: true });
    const destDb = path.join(targetDir, "manga.sqlite");
    this.db.exec(`VACUUM INTO '${destDb.replaceAll("'", "''")}'`);
    const files = ["manga.sqlite"];
    const manifest: string[] = [];
    const copyDir = (from: string, to: string, prefix: string) => {
      if (!fs.existsSync(from)) return;
      fs.mkdirSync(to, { recursive: true });
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const source = path.join(from, entry.name);
        const dest = path.join(to, entry.name);
        const rel = path.posix.join(prefix, entry.name);
        if (entry.isDirectory()) copyDir(source, dest, rel);
        else {
          fs.copyFileSync(source, dest);
          files.push(rel);
          manifest.push(rel);
        }
      }
    };
    copyDir(this.attachmentsDir, path.join(targetDir, "attachments"), "attachments");
    const unknown = this.db.prepare("SELECT id, type, owner_module_id, payload_json, attachment_ids_json FROM content_objects").all();
    fs.writeFileSync(path.join(targetDir, "objects.json"), `${JSON.stringify(unknown, null, 2)}\n`);
    fs.writeFileSync(path.join(targetDir, "attachments.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    files.push("objects.json", "attachments.json");
    return { files };
  }

  restoreFrom(sourceDir: string, targetDir: string): void {
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length) throw new MangaError("PUBLISH_CONFLICT", "restore requires an empty target directory");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(path.join(sourceDir, "manga.sqlite"), path.join(targetDir, "manga.sqlite"), fs.constants.COPYFILE_EXCL);
    const attachments = path.join(sourceDir, "attachments");
    if (fs.existsSync(attachments)) {
      fs.cpSync(attachments, path.join(targetDir, "attachments"), { recursive: true });
    }
  }

  counts(): Record<string, number> {
    const tables = ["resources", "resource_revisions", "content_objects", "anchors", "refs", "text_fragments", "operations"];
    const out: Record<string, number> = {};
    for (const table of tables) {
      out[table] = (this.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
    }
    return out;
  }
}

export { ngramsFor, matchQuery } from "./ngrams.ts";
export { acquireHostLock, releaseHostLock } from "./lock.ts";
export { STORAGE_SCHEMA_VERSION } from "./schema.ts";
