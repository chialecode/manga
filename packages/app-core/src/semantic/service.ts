import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MangaError, type SemanticKind } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { rangeConsumed } from "../reading-service.ts";
import { DEFAULT_SEGMENTATION, SEGMENTATIONS, chunkText, estimateChunks, isSegmentation, type SegmentationId } from "./chunk.ts";
import type { EmbeddingConnection, EmbeddingPort } from "./ports.ts";

export { SEGMENTATIONS } from "./chunk.ts";

type VersionRow = {
  id: number; connection_id: string; model: string; dim: number | null; segmentation: string; engine: "vec0" | "blob";
  status: "building" | "active" | "failed" | "cancelled"; total: number; done: number; error_json: string | null; created_at: string; updated_at: string; activated_at: string | null;
};
type Config = { enabled: boolean; connectionId: string | null; segmentation: SegmentationId };
type Source = { kind: "fragment" | "recording" | "excerpt"; id: string; text: string; hash: string };

export type SemanticVersion = { id: number; model: string; dim: number | null; segmentation: string; engine: "vec0" | "blob"; chunks: number; createdAt: string; activatedAt: string | null };
export type SemanticBuild = { id: number; model: string; segmentation: string; status: string; done: number; total: number; kind: "build" | "update" };
export type SemanticStatus = {
  enabled: boolean; connectionId: string | null; segmentation: SegmentationId;
  connections: Array<{ id: string; label: string; model: string }>;
  active: SemanticVersion | null;
  building: SemanticBuild | null;
  failed: { id: number; model: string; error: { code: string; message: string } } | null;
  /** The index in use was made with a model, connection or way of cutting that is no longer the one set. */
  stale: boolean;
  /** Passages written or imported since the index was made. */
  pending: number;
  engine: "vec0" | "blob";
  estimate: { chars: number; chunks: number };
};
export type SemanticHit = {
  kind: SemanticKind; score: number; text: string; title: string;
  resourceId?: string; workId?: string; mediaKind?: string; revisionId?: string;
  locator?: { kind: "text"; partId: string; representationId: string; range: { start: number; end: number } };
  objectId?: string; blockId?: string; sessionId?: string; startMs?: number; excerptId?: string;
};
export type SemanticSearch = {
  /** `ok`: answered from the index in use. `off`/`building`: no index to answer from yet. `needsRebuild`: the settings no longer match the index. `unavailable`: the connection is gone. */
  state: "ok" | "off" | "building" | "needsRebuild" | "unavailable";
  results: SemanticHit[];
  version: { id: number; model: string; segmentation: string; dim: number | null } | null;
};

export type SemanticHooks = {
  embedding: () => EmbeddingPort;
  notify: (topic: string, payload: Record<string, unknown>) => void;
  featureOn?: (featureId: string) => boolean;
  projectScope: (projectId: string) => { resourceIds: string[]; noteIds: string[]; recordingIds: string[]; excerptIds: string[] };
  /** Test switch: behave as if the vector extension could not be loaded. */
  vec?: boolean;
  /** Wait before a transient embedding failure is tried again, in milliseconds (tests use 0). */
  retryBaseMs?: number;
};

const BATCH = 32;
const PAGE = 200;
const SNIPPET = 260;
const MAX_K = 4096;
const hashOf = (text: string) => createHash("sha1").update(text).digest("hex");
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function normalize(vector: number[]): Float32Array {
  const out = new Float32Array(vector.length);
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) { out[i] = vector[i]!; sum += out[i]! * out[i]!; }
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < out.length; i += 1) out[i] = out[i]! / norm;
  return out;
}

/**
 * Loads the sqlite-vec extension into a connection. A packaged app keeps the extension outside the archive, so a path inside it is mapped to
 * the unpacked copy. Returns false when it cannot be loaded; the index then keeps its vectors in a plain column and searches them in JavaScript.
 */
export function loadVecExtension(db: { loadExtension(path: string): unknown }, why?: (reason: string) => void): boolean {
  try {
    // The desktop bundle is CommonJS, where import.meta.url is not provided; __filename is.
    const require = createRequire(typeof __filename === "string" ? __filename : fileURLToPath(import.meta.url));
    const { getLoadablePath } = require("sqlite-vec") as { getLoadablePath: () => string };
    const found = getLoadablePath();
    for (const candidate of [found, found.replace(/app\.asar([\\/])/, "app.asar.unpacked$1")]) {
      if (!fs.existsSync(candidate)) { why?.(`not on disk: ${candidate.split(/[\\/]/).slice(-3).join("/")}`); continue; }
      try { db.loadExtension(candidate); return true; } catch (error) { why?.(`not loaded: ${error instanceof Error ? error.message : String(error)}`); }
    }
    return false;
  } catch (error) {
    why?.(`not found: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * The optional semantic index (SEARCH-02). It is off until the person turns it on and picks an embedding connection. Text is cut into pieces,
 * each piece gets a vector, and a search finds the pieces closest in meaning to a question. An index is one version: one model, one vector length,
 * one way of cutting. Changing any of them builds a new version in the background while the version in use keeps answering, and the switch
 * happens only when the new one is complete, so vectors of two models are never compared. The index only reads the person's text; it changes none of it.
 */
export class SemanticService {
  private readonly store: DrizzleStore;
  private readonly hooks: SemanticHooks;
  private vecLoaded: boolean | undefined;
  private job: { versionId: number; kind: "build" | "update"; abort: AbortController; done: Promise<void> } | null = null;
  private closed = false;

  constructor(store: DrizzleStore, hooks: SemanticHooks) {
    this.store = store;
    this.hooks = hooks;
  }

  // ------------------------------------------------------------------ settings and state

  private config(): Config {
    try {
      const saved = JSON.parse(this.store.getMeta("semanticConfig") ?? "{}") as Partial<Config>;
      return { enabled: saved.enabled === true, connectionId: saved.connectionId ?? null, segmentation: saved.segmentation && isSegmentation(saved.segmentation) ? saved.segmentation : DEFAULT_SEGMENTATION };
    } catch {
      return { enabled: false, connectionId: null, segmentation: DEFAULT_SEGMENTATION };
    }
  }

  private saveConfig(config: Config): void {
    this.store.setMeta("semanticConfig", JSON.stringify(config));
  }

  private vec(): boolean {
    if (this.vecLoaded === undefined) this.vecLoaded = this.hooks.vec === false ? false : loadVecExtension(this.store.sqlite);
    return this.vecLoaded;
  }

  private versions(status?: string): VersionRow[] {
    return (status
      ? this.store.sqlite.prepare("SELECT * FROM index_versions WHERE status = ? ORDER BY id DESC").all(status)
      : this.store.sqlite.prepare("SELECT * FROM index_versions ORDER BY id DESC").all()) as VersionRow[];
  }

  private version(id: number): VersionRow {
    const row = this.store.sqlite.prepare("SELECT * FROM index_versions WHERE id = ?").get(id) as VersionRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the index version does not exist");
    return row;
  }

  private chunkCount(versionId: number): number {
    return (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM semantic_chunks WHERE version_id = ?").get(versionId) as { n: number }).n;
  }

  private table(versionId: number): string {
    return `semantic_vec_${Math.trunc(versionId)}`;
  }

  /** The connection the settings name, or the first embedding connection when none is named. */
  private connection(config: Config): EmbeddingConnection | null {
    return this.hooks.embedding().resolve(config.connectionId);
  }

  status(): SemanticStatus {
    const config = this.config();
    const active = this.versions("active")[0];
    const building = this.versions("building")[0];
    const failed = this.versions("failed")[0];
    const connection = this.connection(config);
    const size = SEGMENTATIONS[config.segmentation];
    const chars = (this.store.sqlite.prepare("SELECT COALESCE(SUM(length(text)), 0) AS n FROM text_fragments WHERE kind IN ('body', 'note')").get() as { n: number }).n
      + (this.store.sqlite.prepare("SELECT COALESCE(SUM(length(COALESCE(NULLIF(revised_text, ''), text))), 0) AS n FROM transcript_segments").get() as { n: number }).n
      + (this.store.sqlite.prepare("SELECT COALESCE(SUM(length(text)), 0) AS n FROM excerpts").get() as { n: number }).n;
    return {
      enabled: config.enabled, connectionId: config.connectionId, segmentation: config.segmentation,
      connections: this.hooks.embedding().list().map((item) => ({ id: item.id, label: item.label ?? item.id, model: item.model })),
      active: active ? { id: active.id, model: active.model, dim: active.dim, segmentation: active.segmentation, engine: active.engine, chunks: this.chunkCount(active.id), createdAt: active.created_at, activatedAt: active.activated_at } : null,
      building: building ? { id: building.id, model: building.model, segmentation: building.segmentation, status: building.status, done: building.done, total: building.total, kind: "build" } : this.job?.kind === "update" ? this.progressOf(this.job.versionId, "update") : null,
      failed: failed ? { id: failed.id, model: failed.model, error: failed.error_json ? JSON.parse(failed.error_json) as { code: string; message: string } : { code: "UNKNOWN", message: "" } } : null,
      stale: Boolean(active && (!connection || connection.id !== active.connection_id || connection.model !== active.model || config.segmentation !== active.segmentation)),
      pending: active ? this.pendingCount(active) : 0,
      engine: this.vec() ? "vec0" : "blob",
      estimate: { chars, chunks: estimateChunks(chars, size) },
    };
  }

  private progressOf(versionId: number, kind: "build" | "update"): SemanticBuild {
    const row = this.version(versionId);
    return { id: row.id, model: row.model, segmentation: row.segmentation, status: kind === "update" ? "building" : row.status, done: row.done, total: row.total, kind };
  }

  /** How many passages have no vectors in the index in use (written or imported after it was made). */
  private pendingCount(version: VersionRow): number {
    const sqlite = this.store.sqlite;
    const fragments = (sqlite.prepare(`SELECT COUNT(*) AS n FROM text_fragments f WHERE f.kind IN ('body', 'note') AND length(trim(f.text)) > 0
      AND NOT EXISTS (SELECT 1 FROM semantic_chunks c WHERE c.version_id = ? AND c.source_kind = 'fragment' AND c.source_id = f.id)`).get(version.id) as { n: number }).n;
    const recordings = (sqlite.prepare(`SELECT COUNT(*) AS n FROM transcript_segments s WHERE length(trim(COALESCE(NULLIF(s.revised_text, ''), s.text))) > 0
      AND NOT EXISTS (SELECT 1 FROM semantic_chunks c WHERE c.version_id = ? AND c.source_kind = 'recording' AND c.source_id = s.id)`).get(version.id) as { n: number }).n;
    const excerpts = (sqlite.prepare(`SELECT COUNT(*) AS n FROM excerpts e WHERE NOT EXISTS (SELECT 1 FROM semantic_chunks c WHERE c.version_id = ? AND c.source_kind = 'excerpt' AND c.source_id = e.id)`).get(version.id) as { n: number }).n;
    return fragments + recordings + excerpts;
  }

  // ------------------------------------------------------------------ commands

  /** Saves the settings. Turning the index on, or changing what it is made with, starts building the version those settings need. */
  async configure(input: { enabled: boolean; connectionId?: string; segmentation?: SegmentationId }): Promise<SemanticStatus> {
    const before = this.config();
    const next: Config = {
      enabled: input.enabled,
      connectionId: input.connectionId ?? before.connectionId,
      segmentation: input.segmentation ?? before.segmentation,
    };
    if (input.enabled && !this.connection(next)) throw new MangaError("MODEL_CAPABILITY_MISSING", "choose an embedding connection first", { details: { reason: "noConnection" } });
    this.saveConfig(next);
    if (!next.enabled) {
      await this.cancel();
      return this.status();
    }
    const connection = this.connection(next)!;
    const active = this.versions("active")[0];
    const building = this.versions("building")[0];
    const fits = (row: VersionRow | undefined) => Boolean(row && row.connection_id === connection.id && row.model === connection.model && row.segmentation === next.segmentation);
    if (!fits(active) && !fits(building)) await this.startBuild(next, connection);
    else if (building && fits(building) && !this.job) this.resume(building.id);
    return this.status();
  }

  /** Builds a new version from the settings as they are now. */
  async rebuild(): Promise<SemanticStatus> {
    const config = this.config();
    if (!config.enabled) throw new MangaError("VALIDATION_ERROR", "semantic search is off", { details: { reason: "off" } });
    const connection = this.connection(config);
    if (!connection) throw new MangaError("MODEL_CAPABILITY_MISSING", "choose an embedding connection first", { details: { reason: "noConnection" } });
    await this.startBuild(config, connection);
    return this.status();
  }

  async cancel(): Promise<SemanticStatus> {
    const job = this.job;
    if (job) { job.abort.abort(); await job.done.catch(() => undefined); }
    for (const row of this.versions("building")) this.drop(row.id);
    return this.status();
  }

  /** Adds the passages written since the index was made and drops the ones that are gone. */
  async update(): Promise<SemanticStatus> {
    const active = this.versions("active")[0];
    const config = this.config();
    if (!active || !config.enabled) throw new MangaError("VALIDATION_ERROR", "there is no index to update", { details: { reason: "noIndex" } });
    if (this.job) throw new MangaError("VALIDATION_ERROR", "an index is already being built", { details: { reason: "busy" } });
    this.run(active.id, "update");
    return this.status();
  }

  /** Deletes every version and its vectors; what they were made from is not touched. */
  async clear(): Promise<SemanticStatus> {
    const job = this.job;
    if (job) { job.abort.abort(); await job.done.catch(() => undefined); }
    for (const row of this.versions()) this.drop(row.id);
    return this.status();
  }

  /** Starts a new version, replacing a build that is under way. The version in use is left alone until the new one is complete. */
  private async startBuild(config: Config, connection: EmbeddingConnection): Promise<void> {
    if (this.job) { this.job.abort.abort(); await this.job.done.catch(() => undefined); }
    for (const row of this.versions("building")) this.drop(row.id);
    for (const row of this.versions("failed")) this.drop(row.id);
    const now = new Date().toISOString();
    const id = Number(this.store.sqlite.prepare("INSERT INTO index_versions(connection_id, model, dim, segmentation, engine, status, total, done, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(connection.id, connection.model, null, config.segmentation, this.vec() ? "vec0" : "blob", "building", this.estimateTotal(config.segmentation), 0, now, now).lastInsertRowid);
    this.run(id, "build");
  }

  private estimateTotal(segmentation: SegmentationId): number {
    const size = SEGMENTATIONS[segmentation];
    const sqlite = this.store.sqlite;
    const fragments = (sqlite.prepare("SELECT COALESCE(SUM((length(text) + ? - 1) / ?), 0) AS n FROM text_fragments WHERE kind IN ('body', 'note')").get(size, size) as { n: number }).n;
    const recordings = (sqlite.prepare("SELECT COUNT(*) AS n FROM transcript_segments WHERE length(trim(COALESCE(NULLIF(revised_text, ''), text))) > 0").get() as { n: number }).n;
    const excerpts = (sqlite.prepare("SELECT COALESCE(SUM((length(text) + ? - 1) / ?), 0) AS n FROM excerpts").get(size, size) as { n: number }).n;
    return fragments + recordings + excerpts;
  }

  /** Picks a build interrupted by a restart back up. Called when the application starts. */
  recover(): void {
    const config = this.config();
    for (const row of this.versions("building")) {
      if (config.enabled && !this.job) this.resume(row.id);
      else this.drop(row.id);
    }
  }

  private resume(versionId: number): void {
    this.run(versionId, "build");
  }

  /** Waits for a build or update that is under way (for tests, and for a clean shutdown). */
  async settled(): Promise<void> {
    while (this.job) await this.job.done.catch(() => undefined);
  }

  close(): void {
    this.closed = true;
    this.job?.abort.abort();
  }

  // ------------------------------------------------------------------ building

  private run(versionId: number, kind: "build" | "update"): void {
    const abort = new AbortController();
    const done = this.work(versionId, kind, abort.signal).catch((error) => this.fail(versionId, kind, error)).finally(() => { if (this.job?.versionId === versionId) this.job = null; });
    this.job = { versionId, kind, abort, done };
  }

  private fail(versionId: number, kind: "build" | "update", error: unknown): void {
    // After a shutdown the build stays as it was; it is picked up again at the next start.
    if (this.closed) return;
    const row = this.store.sqlite.prepare("SELECT * FROM index_versions WHERE id = ?").get(versionId) as VersionRow | undefined;
    if (!row) return;
    const cancelled = error instanceof MangaError && error.code === "CANCELLED";
    if (cancelled) {
      if (kind === "build") this.drop(versionId);
      this.hooks.notify("semantic.progress", { versionId, status: "cancelled", kind });
      return;
    }
    const detail = error instanceof MangaError ? { code: error.code, message: error.message } : { code: "UNKNOWN", message: error instanceof Error ? error.message : String(error) };
    if (kind === "build") {
      // A build that failed leaves what it made for a look at the reason; the version in use is unaffected.
      this.store.sqlite.prepare("UPDATE index_versions SET status = 'failed', error_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(detail), new Date().toISOString(), versionId);
    }
    this.hooks.notify("semantic.progress", { versionId, status: "failed", kind, error: detail });
  }

  private async work(versionId: number, kind: "build" | "update", signal: AbortSignal): Promise<void> {
    let version = this.version(versionId);
    this.requireEngine(version);
    const port = this.hooks.embedding();
    const connection = port.resolve(version.connection_id);
    if (!connection || connection.id !== version.connection_id) throw new MangaError("MODEL_CAPABILITY_MISSING", "the embedding connection is gone", { details: { reason: "noConnection" } });
    if (connection.model !== version.model) throw new MangaError("MODEL_CAPABILITY_MISSING", "the connection's model changed; rebuild the index", { details: { reason: "modelChanged" } });
    const size = SEGMENTATIONS[version.segmentation as SegmentationId] ?? SEGMENTATIONS[DEFAULT_SEGMENTATION];
    if (kind === "update") this.store.sqlite.prepare("UPDATE index_versions SET total = ?, done = 0, updated_at = ? WHERE id = ?").run(this.pendingCount(version), new Date().toISOString(), versionId);
    const progress = () => {
      version = this.version(versionId);
      this.hooks.notify("semantic.progress", { versionId, status: kind === "update" ? "building" : version.status, kind, done: version.done, total: version.total });
    };
    progress();

    let batch: Array<{ source: Source; seq: number; start: number; end: number; text: string }> = [];
    const flush = async () => {
      if (!batch.length) return;
      const items = batch;
      batch = [];
      const vectors = await this.embedWithRetry(port, connection, items.map((item) => item.text), signal);
      if (signal.aborted) throw new MangaError("CANCELLED", "cancelled");
      if (vectors.length !== items.length) throw new MangaError("PROVIDER_UNAVAILABLE", "the model returned a different number of vectors than it was given", { details: { reason: "count" } });
      const normalized = vectors.map(normalize);
      const dim = normalized[0]!.length;
      if (!dim || normalized.some((vector) => vector.length !== dim || vector.some((value) => !Number.isFinite(value)))) throw new MangaError("MODEL_CAPABILITY_MISSING", "the model returned vectors that cannot be used", { details: { reason: "vector" } });
      this.store.sqlite.transaction(() => {
        const row = this.version(versionId);
        if (row.dim === null) {
          this.store.sqlite.prepare("UPDATE index_versions SET dim = ? WHERE id = ?").run(dim, versionId);
          if (row.engine === "vec0") this.store.sqlite.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${this.table(versionId)} USING vec0(embedding float[${dim}])`);
        } else if (row.dim !== dim) {
          throw new MangaError("MODEL_CAPABILITY_MISSING", "the model's vectors changed length; rebuild the index", { details: { reason: "dimension", expected: row.dim, got: dim } });
        }
        // A passage whose text changed is cut again from scratch: its old pieces go in the same step that adds the new ones.
        const replaced = new Set<string>();
        for (const item of items) {
          const key = `${item.source.kind}:${item.source.id}`;
          if (replaced.has(key)) continue;
          replaced.add(key);
          this.removeSource(versionId, item.source.kind, item.source.id);
        }
        const insert = this.store.sqlite.prepare("INSERT INTO semantic_chunks(version_id, source_kind, source_id, seq, source_hash, start_cp, end_cp, vector) VALUES (?,?,?,?,?,?,?,?)");
        const insertVec = row.engine === "vec0" ? this.store.sqlite.prepare(`INSERT INTO ${this.table(versionId)}(rowid, embedding) VALUES (?, ?)`) : null;
        items.forEach((item, index) => {
          const vector = normalized[index]!;
          const info = insert.run(versionId, item.source.kind, item.source.id, item.seq, item.source.hash, item.start, item.end, insertVec ? null : Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength));
          if (insertVec) insertVec.run(BigInt(info.lastInsertRowid), vector);
        });
        this.store.sqlite.prepare("UPDATE index_versions SET done = done + ?, updated_at = ? WHERE id = ?").run(items.length, new Date().toISOString(), versionId);
      })();
      progress();
    };

    for (const source of this.sources(versionId, kind)) {
      if (signal.aborted) throw new MangaError("CANCELLED", "cancelled");
      const chunks = chunkText(source.text, size);
      // A passage goes into one batch whole, so an interruption never leaves half of it indexed (it would then count as done).
      if (batch.length && batch.length + chunks.length > BATCH) await flush();
      chunks.forEach((chunk, seq) => batch.push({ source, seq, start: chunk.start, end: chunk.end, text: chunk.text }));
      if (batch.length >= BATCH) await flush();
    }
    await flush();
    this.removeVanished(versionId);
    if (signal.aborted) throw new MangaError("CANCELLED", "cancelled");
    this.store.sqlite.transaction(() => {
      const done = this.chunkCount(versionId);
      this.store.sqlite.prepare("UPDATE index_versions SET total = ?, done = ?, updated_at = ? WHERE id = ?").run(done, done, new Date().toISOString(), versionId);
      if (kind === "build") this.activate(versionId);
    })();
    this.hooks.notify("semantic.progress", { versionId, status: kind === "build" ? "active" : "updated", kind, done: this.chunkCount(versionId), total: this.chunkCount(versionId) });
  }

  private async embedWithRetry(port: EmbeddingPort, connection: EmbeddingConnection, inputs: string[], signal: AbortSignal): Promise<number[][]> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await port.embed(connection, { inputs, signal });
      } catch (error) {
        if (signal.aborted) throw new MangaError("CANCELLED", "cancelled");
        const retryable = error instanceof MangaError && error.retryable === true;
        if (!retryable || attempt >= 3) throw error;
        await sleep((this.hooks.retryBaseMs ?? 500) * attempt);
      }
    }
  }

  /** The new version takes over; the one before it, with its vectors, is removed. */
  private activate(versionId: number): void {
    for (const row of this.versions("active")) if (row.id !== versionId) this.drop(row.id);
    this.store.sqlite.prepare("UPDATE index_versions SET status = 'active', activated_at = ?, error_json = NULL WHERE id = ?").run(new Date().toISOString(), versionId);
  }

  /** A version made with the vector extension can only be read or written once the extension is loaded in this connection. */
  private requireEngine(version: VersionRow): void {
    if (version.engine === "vec0" && !this.vec()) throw new MangaError("MODEL_CAPABILITY_MISSING", "the vector extension could not be loaded; rebuild the index", { details: { reason: "extension" } });
  }

  /** Removes a version, its pieces and its vector table. */
  private drop(versionId: number): void {
    const known = this.store.sqlite.prepare("SELECT engine FROM index_versions WHERE id = ?").get(versionId) as { engine: string } | undefined;
    if (known?.engine === "vec0") this.vec();
    this.store.sqlite.transaction(() => {
      try { this.store.sqlite.exec(`DROP TABLE IF EXISTS ${this.table(versionId)}`); } catch { /* the extension may be missing; the table is unreachable then */ }
      this.store.sqlite.prepare("DELETE FROM semantic_chunks WHERE version_id = ?").run(versionId);
      this.store.sqlite.prepare("DELETE FROM index_versions WHERE id = ?").run(versionId);
    })();
  }

  private removeChunks(version: VersionRow, ids: number[]): void {
    if (!ids.length) return;
    this.requireEngine(version);
    for (let at = 0; at < ids.length; at += 500) {
      const part = ids.slice(at, at + 500);
      const marks = part.map(() => "?").join(",");
      if (version.engine === "vec0" && version.dim !== null) this.store.sqlite.prepare(`DELETE FROM ${this.table(version.id)} WHERE rowid IN (${marks})`).run(...part.map((id) => BigInt(id)));
      this.store.sqlite.prepare(`DELETE FROM semantic_chunks WHERE id IN (${marks})`).run(...part);
    }
  }

  private removeSource(versionId: number, kind: string, id: string): void {
    const version = this.version(versionId);
    const ids = (this.store.sqlite.prepare("SELECT id FROM semantic_chunks WHERE version_id = ? AND source_kind = ? AND source_id = ?").all(versionId, kind, id) as Array<{ id: number }>).map((row) => row.id);
    this.store.sqlite.transaction(() => this.removeChunks(version, ids))();
  }

  /** Drops the pieces of passages that no longer exist, so a search never points at something that is gone. */
  private removeVanished(versionId: number): void {
    const version = this.version(versionId);
    const gone = (this.store.sqlite.prepare(`SELECT c.id FROM semantic_chunks c WHERE c.version_id = ? AND (
      (c.source_kind = 'fragment' AND NOT EXISTS (SELECT 1 FROM text_fragments f WHERE f.id = c.source_id))
      OR (c.source_kind = 'recording' AND NOT EXISTS (SELECT 1 FROM transcript_segments s WHERE s.id = c.source_id))
      OR (c.source_kind = 'excerpt' AND NOT EXISTS (SELECT 1 FROM excerpts e WHERE e.id = c.source_id)))`).all(versionId) as Array<{ id: number }>).map((row) => row.id);
    this.store.sqlite.transaction(() => this.removeChunks(version, gone))();
  }

  /**
   * The passages to index, a page at a time: the library's text pieces of books and notes, the transcript of recordings (the corrected wording
   * first) and excerpts. A passage that already has pieces in this version with the same content is skipped, so an update, or a build picked up
   * after an interruption, only does what is missing.
   */
  private *sources(versionId: number, kind: "build" | "update"): Generator<Source> {
    const sqlite = this.store.sqlite;
    const has = sqlite.prepare("SELECT source_hash AS hash FROM semantic_chunks WHERE version_id = ? AND source_kind = ? AND source_id = ? LIMIT 1");
    const fresh = (type: Source["kind"], id: string, hash: string, compareHash: boolean): boolean => {
      const found = has.get(versionId, type, id) as { hash: string } | undefined;
      return !found || (compareHash && found.hash !== hash);
    };
    void kind;
    let cursor = 0;
    for (;;) {
      const rows = sqlite.prepare("SELECT rowid AS r, id, text FROM text_fragments WHERE kind IN ('body', 'note') AND rowid > ? ORDER BY rowid LIMIT ?").all(cursor, PAGE) as Array<{ r: number; id: string; text: string }>;
      if (!rows.length) break;
      cursor = rows[rows.length - 1]!.r;
      for (const row of rows) {
        if (!row.text.trim()) continue;
        if (fresh("fragment", row.id, "", false)) yield { kind: "fragment", id: row.id, text: row.text, hash: hashOf(row.text) };
      }
    }
    cursor = 0;
    for (;;) {
      const rows = sqlite.prepare("SELECT rowid AS r, id, COALESCE(NULLIF(revised_text, ''), text) AS text FROM transcript_segments WHERE rowid > ? ORDER BY rowid LIMIT ?").all(cursor, PAGE) as Array<{ r: number; id: string; text: string }>;
      if (!rows.length) break;
      cursor = rows[rows.length - 1]!.r;
      for (const row of rows) {
        if (!row.text.trim()) continue;
        const hash = hashOf(row.text);
        if (fresh("recording", row.id, hash, true)) yield { kind: "recording", id: row.id, text: row.text, hash };
      }
    }
    cursor = 0;
    for (;;) {
      const rows = sqlite.prepare("SELECT rowid AS r, id, title, text, note FROM excerpts WHERE rowid > ? ORDER BY rowid LIMIT ?").all(cursor, PAGE) as Array<{ r: number; id: string; title: string; text: string; note: string }>;
      if (!rows.length) break;
      cursor = rows[rows.length - 1]!.r;
      for (const row of rows) {
        const text = excerptText(row);
        if (!text.trim()) continue;
        const hash = hashOf(text);
        if (fresh("excerpt", row.id, hash, true)) yield { kind: "excerpt", id: row.id, text, hash };
      }
    }
  }

  // ------------------------------------------------------------------ searching

  async search(input: { text: string; limit?: number; kinds?: SemanticKind[]; projectId?: string; resourceId?: string; withinProgress?: boolean }, signal?: AbortSignal): Promise<SemanticSearch> {
    const config = this.config();
    const empty = (state: SemanticSearch["state"], version: VersionRow | undefined = undefined): SemanticSearch => ({ state, results: [], version: version ? { id: version.id, model: version.model, segmentation: version.segmentation, dim: version.dim } : null });
    if (!config.enabled) return empty("off");
    const active = this.versions("active")[0];
    if (!active) return empty(this.versions("building").length ? "building" : "off");
    const connection = this.hooks.embedding().resolve(active.connection_id);
    if (!connection || connection.id !== active.connection_id) return empty("unavailable", active);
    // The question is turned into a vector by the model the index was made with, and never by another one.
    if (connection.model !== active.model) return empty("needsRebuild", active);
    const limit = input.limit ?? 10;
    const [raw] = await this.hooks.embedding().embed(connection, { inputs: [input.text], signal: signal ?? new AbortController().signal });
    if (!raw) return empty("unavailable", active);
    const query = normalize(raw);
    if (active.dim !== null && query.length !== active.dim) return empty("needsRebuild", active);
    const scope = input.projectId ? this.hooks.projectScope(input.projectId) : null;
    const hits: SemanticHit[] = [];
    const seen = new Set<number>();
    const total = this.chunkCount(active.id);
    for (let k = Math.min(MAX_K, Math.max(limit * 6, 48)); ; k = Math.min(MAX_K, k * 4)) {
      for (const candidate of this.nearest(active, query, k)) {
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        const hit = this.locate(candidate, input, scope);
        if (hit) hits.push(hit);
      }
      hits.sort((a, b) => b.score - a.score);
      if (hits.length >= limit || k >= MAX_K || k >= total) break;
    }
    return { state: "ok", results: hits.slice(0, limit), version: { id: active.id, model: active.model, segmentation: active.segmentation, dim: active.dim } };
  }

  /** The closest pieces of a version, nearest first, with their cosine similarity. */
  private nearest(version: VersionRow, query: Float32Array, k: number): Array<{ id: number; score: number; kind: string; sourceId: string; start: number; end: number; hash: string }> {
    const sqlite = this.store.sqlite;
    if (version.engine === "vec0") {
      if (!this.vec()) throw new MangaError("MODEL_CAPABILITY_MISSING", "the vector extension could not be loaded; rebuild the index", { details: { reason: "extension" } });
      const rows = sqlite.prepare(`SELECT c.id AS id, v.distance AS distance, c.source_kind AS kind, c.source_id AS sourceId, c.start_cp AS start, c.end_cp AS end, c.source_hash AS hash
        FROM (SELECT rowid, distance FROM ${this.table(version.id)} WHERE embedding MATCH ? AND k = ?) v JOIN semantic_chunks c ON c.id = v.rowid ORDER BY v.distance`).all(query, k) as Array<{ id: number; distance: number; kind: string; sourceId: string; start: number; end: number; hash: string }>;
      return rows.map((row) => ({ id: row.id, score: 1 - (row.distance * row.distance) / 2, kind: row.kind, sourceId: row.sourceId, start: row.start, end: row.end, hash: row.hash }));
    }
    const best: Array<{ id: number; score: number; kind: string; sourceId: string; start: number; end: number; hash: string }> = [];
    let worst = -Infinity;
    for (const row of sqlite.prepare("SELECT id, source_kind AS kind, source_id AS sourceId, start_cp AS start, end_cp AS end, source_hash AS hash, vector FROM semantic_chunks WHERE version_id = ?").iterate(version.id) as Iterable<{ id: number; kind: string; sourceId: string; start: number; end: number; hash: string; vector: Buffer }>) {
      const bytes = row.vector;
      const copy = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      let score = 0;
      for (let i = 0; i < copy.length; i += 1) score += copy[i]! * query[i]!;
      if (best.length < k || score > worst) {
        best.push({ id: row.id, score, kind: row.kind, sourceId: row.sourceId, start: row.start, end: row.end, hash: row.hash });
        best.sort((a, b) => b.score - a.score);
        if (best.length > k) best.pop();
        worst = best[best.length - 1]!.score;
      }
    }
    return best;
  }

  /**
   * Turns a piece into a result that says what it is and where, if it is within what the search may see: the person's project, the book asked
   * about, and (when asked) what has been read. A piece whose source is gone or changed since is left out.
   */
  private locate(candidate: { id: number; score: number; kind: string; sourceId: string; start: number; end: number; hash: string }, input: { kinds?: SemanticKind[]; resourceId?: string; withinProgress?: boolean }, scope: { resourceIds: string[]; noteIds: string[]; recordingIds: string[]; excerptIds: string[] } | null): SemanticHit | null {
    const sqlite = this.store.sqlite;
    const on = (featureId: string) => !this.hooks.featureOn || this.hooks.featureOn(featureId);
    const snippet = (text: string, start: number, end: number): string | null => {
      const chars = Array.from(text);
      if (end > chars.length) return null;
      const piece = chars.slice(start, end).join("").replace(/\s+/g, " ");
      return [...piece].length > SNIPPET ? `${[...piece].slice(0, SNIPPET).join("")}…` : piece;
    };
    if (candidate.kind === "fragment") {
      const fragment = sqlite.prepare("SELECT kind, text, resource_id AS resourceId, object_id AS objectId, resource_revision_id AS revisionId, locator_json AS locator FROM text_fragments WHERE id = ?").get(candidate.sourceId) as { kind: "body" | "note"; text: string; resourceId: string | null; objectId: string | null; revisionId: string | null; locator: string | null } | undefined;
      if (!fragment) return null;
      const kind: SemanticKind = fragment.kind === "note" ? "note" : "body";
      if (input.kinds && !input.kinds.includes(kind)) return null;
      if (input.resourceId && fragment.resourceId !== input.resourceId) return null;
      if (kind === "body" ? !on("library") : !on("notes")) return null;
      if (scope) {
        const inScope = kind === "body"
          ? Boolean(fragment.resourceId && scope.resourceIds.includes(fragment.resourceId))
          : Boolean((fragment.objectId && scope.noteIds.includes(fragment.objectId)) || (fragment.resourceId && scope.resourceIds.includes(fragment.resourceId)));
        if (!inScope) return null;
      }
      const text = snippet(fragment.text, candidate.start, candidate.end);
      if (text === null) return null;
      const locator = fragment.locator ? JSON.parse(fragment.locator) as { kind?: string; partId?: string; representationId?: string; range?: { start: number; end: number } } | null : null;
      const base = locator?.range?.start ?? 0;
      const place = locator?.kind === "text" && locator.partId && locator.representationId
        ? { kind: "text" as const, partId: locator.partId, representationId: locator.representationId, range: { start: base + candidate.start, end: base + candidate.end } }
        : undefined;
      if (input.withinProgress && kind === "body") {
        if (!place || !fragment.resourceId || !fragment.revisionId) return null;
        if (!rangeConsumed(this.store, fragment.resourceId, fragment.revisionId, place.partId, place.range.start, place.range.end)) return null;
      }
      if (kind === "note") {
        const note = fragment.objectId ? sqlite.prepare("SELECT title FROM content_objects WHERE id = ? AND type = 'notes.document' AND deleted_at IS NULL").get(fragment.objectId) as { title: string } | undefined : undefined;
        if (!note) return null;
        return { kind, score: candidate.score, text, title: note.title, objectId: fragment.objectId!, ...(place ? { blockId: place.partId } : {}), ...(fragment.resourceId ? { resourceId: fragment.resourceId } : {}) };
      }
      const resource = fragment.resourceId ? sqlite.prepare("SELECT r.title AS title, r.kind AS mediaKind, r.work_id AS workId, w.title AS workTitle FROM resources r LEFT JOIN works w ON w.id = r.work_id WHERE r.id = ?").get(fragment.resourceId) as { title: string; mediaKind: string; workId: string | null; workTitle: string | null } | undefined : undefined;
      if (!resource) return null;
      return {
        kind, score: candidate.score, text, title: resource.workTitle ?? resource.title, resourceId: fragment.resourceId!, mediaKind: resource.mediaKind,
        ...(resource.workId ? { workId: resource.workId } : {}), ...(fragment.revisionId ? { revisionId: fragment.revisionId } : {}), ...(place ? { locator: place } : {}),
      };
    }
    if (candidate.kind === "recording") {
      if (input.kinds && !input.kinds.includes("recording")) return null;
      if (!on("voice")) return null;
      const row = sqlite.prepare("SELECT COALESCE(NULLIF(s.revised_text, ''), s.text) AS text, s.start_ms AS startMs, s.session_id AS sessionId, c.created_at AS at, c.work_id AS workId FROM transcript_segments s JOIN capture_sessions c ON c.id = s.session_id WHERE s.id = ?").get(candidate.sourceId) as { text: string; startMs: number; sessionId: string; at: string; workId: string | null } | undefined;
      if (!row || hashOf(row.text) !== candidate.hash) return null;
      if (scope && !scope.recordingIds.includes(row.sessionId)) return null;
      if (input.resourceId) {
        const linked = sqlite.prepare("SELECT 1 FROM capture_events WHERE session_id = ? AND resource_id = ? LIMIT 1").get(row.sessionId, input.resourceId);
        if (!linked) return null;
      }
      const text = snippet(row.text, candidate.start, candidate.end);
      if (text === null) return null;
      return { kind: "recording", score: candidate.score, text, title: `录音 ${row.at.slice(0, 16).replace("T", " ")}`, sessionId: row.sessionId, startMs: row.startMs, ...(row.workId ? { workId: row.workId } : {}) };
    }
    if (input.kinds && !input.kinds.includes("excerpt")) return null;
    if (!on("research") || input.resourceId) return null;
    const row = sqlite.prepare("SELECT id, title, text, note, project_id AS projectId FROM excerpts WHERE id = ?").get(candidate.sourceId) as { id: string; title: string; text: string; note: string; projectId: string | null } | undefined;
    if (!row) return null;
    const full = excerptText(row);
    if (hashOf(full) !== candidate.hash) return null;
    if (scope && !scope.excerptIds.includes(row.id)) return null;
    const text = snippet(full, candidate.start, candidate.end);
    if (text === null) return null;
    return { kind: "excerpt", score: candidate.score, text, title: row.title, excerptId: row.id };
  }
}

/** What of an excerpt is indexed: its title, the words taken and the person's note. */
function excerptText(row: { title: string; text: string; note: string }): string {
  return [row.title, row.text, row.note].filter((part) => part.trim()).join("\n");
}
