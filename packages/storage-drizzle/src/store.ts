import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { createId, MangaError, type CommandResult, type SearchHit, type SearchQuery } from "@manga/contracts";
import { BASE_SCHEMA_SQL, PRODUCT_SCHEMA_VERSION, V2_SCHEMA_SQL, V3_SCHEMA_SQL, V4_SCHEMA_SQL, V5_SCHEMA_SQL, V6_SCHEMA_SQL } from "./sql.ts";
import { ngramsFor, matchQuery } from "./ngrams.ts";
import * as schema from "./schema.ts";

export type DrizzleStoreOptions = {
  profileDir: string;
  hostId: string;
  crashAt?: string;
  attachmentsDir?: string;
  nativeBinding?: string;
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
    this.sqlite = new Database(this.dbPath, { nativeBinding: options.nativeBinding });
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
    if (existingVersion > 0 && existingVersion < PRODUCT_SCHEMA_VERSION) {
      this.sqlite.pragma("wal_checkpoint(FULL)");
      const backupPath = `${this.dbPath}.premigrate-v${existingVersion}`;
      if (!fs.existsSync(backupPath)) fs.copyFileSync(this.dbPath, backupPath);
    }
    // DDL and version publication must recover together after process interruption.
    this.sqlite.transaction(() => {
      this.sqlite.exec(BASE_SCHEMA_SQL);
      if (existingVersion < 2) this.sqlite.exec(V2_SCHEMA_SQL);
      if (existingVersion < 3) this.sqlite.exec(V3_SCHEMA_SQL);
      if (existingVersion < 4) this.sqlite.exec(V4_SCHEMA_SQL);
      if (existingVersion < 5) this.sqlite.exec(V5_SCHEMA_SQL);
      if (existingVersion < 6) this.sqlite.exec(V6_SCHEMA_SQL);
      this.maybeCrash("migration-before-version");
      this.sqlite.prepare("INSERT OR IGNORE INTO schema_meta(key, value) VALUES (?, ?)").run("schemaVersion", String(PRODUCT_SCHEMA_VERSION));
      this.sqlite.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schemaVersion'").run(String(PRODUCT_SCHEMA_VERSION));
    })();
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
    const filters = ["s.ngrams MATCH ?"];
    const params: Array<string | number> = [match];
    for (const [column, values] of [["resource_id", query.readAllowlist], ["resource_id", query.resourceIds], ["kind", query.kinds]] as const) {
      if (values === undefined) continue;
      if (!values.length) return [];
      filters.push(`s.${column} IN (${values.map(() => "?").join(",")})`);
      params.push(...values);
    }
    const rows = this.sqlite.prepare(`SELECT s.fragment_id AS fragment_id, s.kind AS kind, s.resource_id AS resource_id, s.text AS text, f.object_id AS object_id, f.resource_revision_id AS resource_revision_id, f.locator_json AS locator_json
      FROM search_idx s LEFT JOIN text_fragments f ON f.id = s.fragment_id WHERE ${filters.join(" AND ")} LIMIT ?`).all(...params, limit) as Array<{
      fragment_id: string;
      kind: SearchHit["kind"];
      resource_id?: string;
      text: string;
      object_id?: string | null;
      resource_revision_id?: string | null;
      locator_json?: string | null;
    }>;
    return rows.slice(0, limit).map((row) => {
      const locator = row.locator_json ? JSON.parse(row.locator_json) as SearchHit["locator"] : null;
      return {
        fragmentId: row.fragment_id,
        resourceId: row.resource_id || undefined,
        objectId: row.object_id || undefined,
        revisionId: row.resource_revision_id || undefined,
        kind: row.kind,
        text: row.text,
        score: 1,
        locator,
      };
    });
  }

  indexFragment(input: {
    id: string;
    resourceId?: string;
    objectId?: string;
    kind: SearchHit["kind"];
    text: string;
    locator?: unknown;
    resourceRevisionId?: string;
    partId?: string;
    start?: number;
    end?: number;
  }): Mutation[] {
    const ngrams = ngramsFor(input.text);
    return [
      {
        sql: `INSERT OR REPLACE INTO text_fragments(id, resource_id, object_id, kind, text, ngrams, locator_json, resource_revision_id, part_id, start_offset, end_offset) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          input.id,
          input.resourceId ?? null,
          input.objectId ?? null,
          input.kind,
          input.text,
          ngrams,
          JSON.stringify(input.locator ?? null),
          input.resourceRevisionId ?? null,
          input.partId ?? null,
          input.start ?? null,
          input.end ?? null,
        ],
      },
      {
        sql: `INSERT INTO search_idx(fragment_id, kind, resource_id, text, ngrams) VALUES (?, ?, ?, ?, ?)`,
        params: [input.id, input.kind, input.resourceId ?? "", input.text, ngrams],
      },
    ];
  }

  /** Index every code-point window so a tail past the first chunk remains searchable. */
  indexTextChunks(input: {
    resourceId?: string;
    objectId?: string;
    resourceRevisionId?: string;
    partId?: string;
    representationId?: string;
    kind: SearchHit["kind"];
    text: string;
    size?: number;
    /** Code-point offset of `text` inside the part, so a later batch keeps locators aligned. */
    startOffset?: number;
  }): Mutation[] {
    const size = input.size ?? 4000;
    const mutations: Mutation[] = [];
    let index = 0;
    let start = input.startOffset ?? 0;
    while (index < input.text.length) {
      let count = 0;
      let cursor = index;
      while (cursor < input.text.length && count < size) {
        const code = input.text.codePointAt(cursor) ?? 0;
        cursor += code > 0xffff ? 2 : 1;
        count += 1;
      }
      const slice = input.text.slice(index, cursor);
      if (slice.length) {
        const end = start + count;
        mutations.push(...this.indexFragment({
          id: createId("frag"),
          resourceId: input.resourceId,
          objectId: input.objectId,
          resourceRevisionId: input.resourceRevisionId,
          partId: input.partId,
          start,
          end,
          kind: input.kind,
          text: slice,
          locator: input.partId && input.representationId ? {
            kind: "text",
            partId: input.partId,
            representationId: input.representationId,
            range: { start, end },
          } : undefined,
        }));
      }
      if (cursor === index) break;
      index = cursor;
      start += count;
    }
    return mutations;
  }

  rebuildSearchIndex(): { fragments: number } {
    const revisions = this.sqlite.prepare("SELECT id, resource_id, payload_json FROM resource_revisions").all() as Array<{ id: string; resource_id: string; payload_json: string }>;
    const resources = this.sqlite.prepare("SELECT id, title, aliases_json FROM resources").all() as Array<{ id: string; title: string; aliases_json: string }>;
    const notes = this.sqlite.prepare("SELECT id, payload_json FROM content_objects WHERE type = 'notes.document' AND deleted_at IS NULL").all() as Array<{ id: string; payload_json: string }>;
    const noteResources = this.sqlite.prepare(`SELECT r.from_object_id AS objectId, a.resource_id AS resourceId
      FROM refs r JOIN anchors a ON a.id = r.to_id WHERE r.to_kind = 'anchor'`).all() as Array<{ objectId: string; resourceId: string }>;
    const noteResource = new Map(noteResources.map((row) => [row.objectId, row.resourceId]));
    const mutations: Mutation[] = [];
    for (const row of resources) {
      mutations.push(...this.indexFragment({ id: createId("frag"), resourceId: row.id, kind: "title", text: row.title }));
      const aliases = JSON.parse(row.aliases_json) as string[];
      for (const alias of aliases) {
        if (alias && alias !== row.title) mutations.push(...this.indexFragment({ id: createId("frag"), resourceId: row.id, kind: "alias", text: alias }));
      }
    }
    for (const revision of revisions) {
      const payload = JSON.parse(revision.payload_json) as { normalized?: string; parts?: Array<{ id?: string; normalized?: string }> };
      const parts = payload.parts?.length ? payload.parts : [{ id: "body", normalized: payload.normalized ?? "" }];
      for (const part of parts) {
        mutations.push(...this.indexTextChunks({
          resourceId: revision.resource_id,
          resourceRevisionId: revision.id,
          partId: part.id || "body",
          representationId: revision.id,
          kind: "body",
          text: part.normalized ?? "",
        }));
      }
    }
    for (const note of notes) {
      const payload = JSON.parse(note.payload_json) as { blocks?: Array<{ id?: string; text?: string }> };
      for (const block of payload.blocks ?? []) {
        mutations.push(...this.indexTextChunks({
          objectId: note.id,
          resourceId: noteResource.get(note.id),
          partId: block.id || "block",
          representationId: note.id,
          kind: "note",
          text: block.text ?? "",
        }));
      }
    }
    this.sqlite.exec("BEGIN IMMEDIATE");
    try {
      this.sqlite.exec("DELETE FROM search_idx; DELETE FROM text_fragments;");
      for (const mutation of mutations) this.sqlite.prepare(mutation.sql).run(...(mutation.params ?? []));
      this.sqlite.exec("COMMIT");
    } catch (error) {
      try { this.sqlite.exec("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    }
    return { fragments: mutations.length / 2 };
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
