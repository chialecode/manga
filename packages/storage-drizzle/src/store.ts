import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { createId, MangaError, type CommandResult, type SearchHit, type SearchQuery } from "@manga/contracts";
import { BASE_SCHEMA_SQL, PRODUCT_SCHEMA_VERSION, V2_SCHEMA_SQL, V3_SCHEMA_SQL, V4_SCHEMA_SQL } from "./sql.ts";
import { ngramsFor, matchQuery } from "./ngrams.ts";
import * as schema from "./schema.ts";

export type DrizzleStoreOptions = {
  profileDir: string;
  hostId: string;
  crashAt?: string;
  attachmentsDir?: string;
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

type SqliteDb = InstanceType<typeof Database>;

export class DrizzleStore {
  readonly sqlite: SqliteDb;
  readonly db: BetterSQLite3Database<typeof schema>;
  readonly dbPath: string;
  readonly attachmentsDir: string;
  readonly crashAt?: string;
  readonly options: DrizzleStoreOptions;
  private closed = false;
  private listeners: Array<(event: { type: string; payload: Record<string, unknown>; seq: number }) => void> = [];

  constructor(options: DrizzleStoreOptions) {
    this.options = options;
    fs.mkdirSync(options.profileDir, { recursive: true });
    this.attachmentsDir = options.attachmentsDir ?? path.join(options.profileDir, "attachments");
    fs.mkdirSync(this.attachmentsDir, { recursive: true });
    this.dbPath = path.join(options.profileDir, "manga.sqlite");
    this.crashAt = options.crashAt;
    this.sqlite = new Database(this.dbPath);
    this.sqlite.pragma("journal_mode = WAL");
    this.migrate();
    this.db = drizzle(this.sqlite, { schema });
  }

  private migrate(): void {
    const hasMeta = this.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'").get() as { name: string } | undefined;
    const existingVersion = hasMeta
      ? Number((this.sqlite.prepare("SELECT value FROM schema_meta WHERE key='schemaVersion'").get() as { value?: string } | undefined)?.value ?? 0)
      : 0;
    if (existingVersion > PRODUCT_SCHEMA_VERSION) {
      this.sqlite.close();
      throw new MangaError("API_INCOMPATIBLE", "data schema is newer than this application; restore a compatible backup");
    }
    this.sqlite.exec(BASE_SCHEMA_SQL);
    if (existingVersion < 2) this.sqlite.exec(V2_SCHEMA_SQL);
    if (existingVersion < 3) this.sqlite.exec(V3_SCHEMA_SQL);
    if (existingVersion < 4) this.sqlite.exec(V4_SCHEMA_SQL);
    this.sqlite.prepare("INSERT OR IGNORE INTO schema_meta(key, value) VALUES (?, ?)").run("schemaVersion", String(PRODUCT_SCHEMA_VERSION));
    this.sqlite.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schemaVersion'").run(String(PRODUCT_SCHEMA_VERSION));
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
    this.sqlite.close();
  }

  loadIdempotent(key: string): CommandResult | undefined {
    const row = this.sqlite.prepare("SELECT result_json FROM operations WHERE idempotency_key = ?").get(key) as { result_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.result_json) as CommandResult;
  }

  unpublishedEvents(): Array<{ seq: number; type: string; payload: Record<string, unknown> }> {
    const rows = this.sqlite.prepare("SELECT seq, type, payload_json FROM domain_events WHERE published_at IS NULL ORDER BY seq").all() as Array<{
      seq: number;
      type: string;
      payload_json: string;
    }>;
    return rows.map((row) => ({ seq: row.seq, type: row.type, payload: JSON.parse(row.payload_json) as Record<string, unknown> }));
  }

  replayUnpublished(): void {
    for (const event of this.unpublishedEvents()) {
      for (const listener of this.listeners) listener(event);
      this.sqlite.prepare("UPDATE domain_events SET published_at = ? WHERE seq = ?").run(new Date().toISOString(), event.seq);
    }
  }

  maybeCrash(stage: string): void {
    if (this.crashAt && this.crashAt === stage) process.exit(99);
  }

  commit(input: CommitInput): { seqs: number[] } {
    this.maybeCrash("after-validate-before-tx");
    if (input.idempotencyKey) {
      const existing = this.loadIdempotent(input.idempotencyKey);
      if (existing) return { seqs: [] };
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.maybeCrash("in-tx-before-commit");
      for (const mutation of input.mutations) {
        this.sqlite.prepare(mutation.sql).run(...(mutation.params ?? []));
      }
      const seqs: number[] = [];
      const now = new Date().toISOString();
      for (const event of input.events) {
        const eventId = createId("evt");
        this.sqlite.prepare("INSERT INTO domain_events(event_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)").run(eventId, event.type, JSON.stringify(event.payload), now);
        const row = this.sqlite.prepare("SELECT seq FROM domain_events WHERE event_id = ?").get(eventId) as { seq: number };
        seqs.push(row.seq);
      }
      if (input.idempotencyKey) {
        const result: CommandResult = { status: "ok", value: input.result ?? { ok: true } };
        this.sqlite.prepare("INSERT INTO operations(idempotency_key, command_id, result_json, committed_at) VALUES (?, ?, ?, ?)").run(
          input.idempotencyKey,
          input.commandId ?? "unknown",
          JSON.stringify(result),
          now,
        );
      }
      this.sqlite.exec("COMMIT");
      this.maybeCrash("after-commit-before-events");
      for (const seq of seqs) {
        const row = this.sqlite.prepare("SELECT type, payload_json FROM domain_events WHERE seq = ?").get(seq) as { type: string; payload_json: string };
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        for (const listener of this.listeners) listener({ type: row.type, payload, seq });
        this.sqlite.prepare("UPDATE domain_events SET published_at = ? WHERE seq = ?").run(now, seq);
      }
      this.maybeCrash("after-events");
      return { seqs };
    } catch (error) {
      try {
        this.sqlite.exec("ROLLBACK");
      } catch {
        // ignore
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
    const rows = this.sqlite.prepare(`SELECT fragment_id, kind, resource_id, text FROM search_idx WHERE ${filters.join(" AND ")} LIMIT ?`).all(...params, limit) as Array<{
      fragment_id: string;
      kind: SearchHit["kind"];
      resource_id?: string;
      text: string;
    }>;
    return rows.slice(0, limit).map((row) => ({
      fragmentId: row.fragment_id,
      resourceId: row.resource_id,
      kind: row.kind,
      text: row.text,
      score: 1,
    }));
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
    this.sqlite.exec("DELETE FROM search_idx;");
  }

  counts(): Record<string, number> {
    const tables = ["resources", "content_objects", "anchors", "refs", "capture_sessions"];
    const result: Record<string, number> = {};
    for (const table of tables) {
      result[table] = Number((this.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    }
    return result;
  }

  getMeta(key: string): string | undefined {
    return (this.sqlite.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.sqlite.prepare("INSERT INTO schema_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
}
