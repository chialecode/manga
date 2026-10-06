import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MangaError, createId, type CommandEnvelope, type CoverSource, type CoverState } from "@manga/contracts";
import type { DrizzleStore, Mutation } from "@manga/storage-drizzle";
import { makeThumbnail } from "../media/thumbnails.ts";
import { ImageStore } from "./images.ts";
import type { MediaServices } from "../media/services.ts";

export const COVER_MODULE = "manga.library";
const MAX_COVER_BYTES = 32 * 1024 * 1024;
const COVER_TTL_MS = 6 * 60 * 60_000;
const SIZES = { grid: 360, detail: 1000 } as const;
/** When the work's cover is still automatic, a better source replaces a poorer one. */
const SOURCE_RANK: Record<CoverSource, number> = { file: 1, bangumi: 3, user: 5 };
const EXT_FOR_TYPE: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

export type CoverRow = {
  id: string;
  work_id: string;
  source: CoverSource;
  provider_id: string | null;
  external_id: string | null;
  content_hash: string;
  media_type: string;
  width: number | null;
  height: number | null;
  bytes: number;
  /** `images` keeps the picture in the image table (from v8); `attachments` is a v7 file that could not be imported; `cache` is extracted from a file. */
  area: "images" | "attachments" | "cache";
  file_name: string;
  image_hash: string | null;
  created_at: string;
};

export type CoverSummary = { id: string; workId: string; source: CoverSource; providerId: string | null; externalId: string | null; mediaType: string; width: number | null; height: number | null; bytes: number; selected: boolean; createdAt: string };

type WorkCoverRow = { id: string; cover_id: string | null; cover_state: CoverState };

/**
 * Covers of works. Pictures from Bangumi or chosen by the user are authoritative data and live in the image table (A-51), so
 * a backup is one file; the cover row references the image by hash and list queries never read the bytes. Pictures pulled out of
 * a file are cache and can be extracted again. A v7 file that could not be imported at migration keeps its file reference.
 */
export class CoverService {
  private readonly store: DrizzleStore;
  private readonly media: MediaServices;
  readonly images: ImageStore;

  constructor(store: DrizzleStore, media: MediaServices) {
    this.store = store;
    this.media = media;
    this.images = new ImageStore(store);
  }

  private fileOf(row: Pick<CoverRow, "area" | "file_name">): string {
    return row.area === "cache" ? path.join(this.media.dir("covers"), row.file_name) : path.join(this.store.attachmentsDir, row.file_name);
  }

  private available(row: CoverRow): boolean {
    return row.area === "images" ? this.images.has(row.image_hash ?? row.content_hash) : fs.existsSync(this.fileOf(row));
  }

  /** The picture's bytes; read lazily so a cached thumbnail never touches them. */
  private bytesOf(row: CoverRow): Buffer {
    return row.area === "images" ? this.images.read(row.image_hash ?? row.content_hash).bytes : fs.readFileSync(this.fileOf(row));
  }

  private work(workId: string): WorkCoverRow {
    const row = this.store.sqlite.prepare("SELECT id, cover_id, cover_state FROM works WHERE id = ?").get(workId) as WorkCoverRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "work missing");
    return row;
  }

  private row(coverId: string): CoverRow {
    const row = this.store.sqlite.prepare("SELECT * FROM covers WHERE id = ?").get(coverId) as CoverRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "cover missing");
    return row;
  }

  /**
   * Keep a picture as one of the work's covers. A picture the work already has (same bytes) is not added twice. The picture
   * becomes the cover when the work has none, when its source ranks above the current one while the cover is still automatic,
   * or when `select` says the user asked for it.
   */
  async add(workId: string, input: { bytes: Buffer; source: CoverSource; providerId?: string; externalId?: string; select?: "auto" | "user" | "never"; signal?: AbortSignal }): Promise<{ cover: CoverSummary; added: boolean; selected: boolean }> {
    const work = this.work(workId);
    const summary = await this.images.inspect(input.bytes);
    input.signal?.throwIfAborted();
    const hash = summary.hash;
    const area: CoverRow["area"] = input.source === "file" ? "cache" : "images";
    const existing = this.store.sqlite.prepare("SELECT * FROM covers WHERE work_id = ? AND content_hash = ?").get(workId, hash) as CoverRow | undefined;
    let row = existing;
    const mutations: Mutation[] = [];
    if (!row) {
      let fileName = "";
      if (area === "cache") {
        fileName = `cover-${hash.slice(0, 40)}.${EXT_FOR_TYPE[summary.mediaType] ?? "img"}`;
        const target = this.fileOf({ area, file_name: fileName });
        if (!fs.existsSync(target)) {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const staging = `${target}.${process.pid}.tmp`;
          fs.writeFileSync(staging, input.bytes);
          fs.renameSync(staging, target);
        }
      } else {
        mutations.push(this.images.insertSql(summary, input.bytes, { fetchedAt: new Date().toISOString() }));
      }
      row = {
        id: createId("cov"), work_id: workId, source: input.source, provider_id: input.providerId ?? null, external_id: input.externalId ?? null,
        content_hash: hash, media_type: summary.mediaType, width: summary.width, height: summary.height, bytes: summary.bytes, area, file_name: fileName,
        image_hash: area === "images" ? hash : null, created_at: new Date().toISOString(),
      };
    }
    const current = work.cover_id ? (this.store.sqlite.prepare("SELECT source FROM covers WHERE id = ?").get(work.cover_id) as { source: CoverSource } | undefined) : undefined;
    const wantsUser = input.select === "user";
    const better = work.cover_state === "auto" && (!current || SOURCE_RANK[input.source] > SOURCE_RANK[current.source]);
    // Locked covers never move: not even for an explicit pick (the user unlocks first).
    // `never` keeps the picture as one of the work's covers without moving the cover (the user kept the current one in the preview).
    const selected = work.cover_state !== "locked" && input.select !== "never" && (wantsUser || better);
    const now = new Date().toISOString();
    if (!existing) {
      mutations.push({
        sql: "INSERT INTO covers(id, work_id, source, provider_id, external_id, content_hash, media_type, width, height, bytes, area, file_name, image_hash, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params: [row.id, row.work_id, row.source, row.provider_id, row.external_id, row.content_hash, row.media_type, row.width, row.height, row.bytes, row.area, row.file_name, row.image_hash, row.created_at],
      });
    }
    if (selected) {
      mutations.push({ sql: "UPDATE works SET cover_id = ?, cover_state = ?, updated_at = ? WHERE id = ?", params: [row.id, wantsUser ? "user" : work.cover_state, now, workId] });
    }
    if (mutations.length) this.store.commit({ mutations, events: [{ type: existing ? "cover.selected" : "cover.added", payload: { workId, coverId: row.id, source: row.source } }] });
    return { cover: this.summary(row, selected || work.cover_id === row.id), added: !existing, selected: selected || work.cover_id === row.id };
  }

  private summary(row: CoverRow, selected: boolean): CoverSummary {
    return { id: row.id, workId: row.work_id, source: row.source, providerId: row.provider_id, externalId: row.external_id, mediaType: row.media_type, width: row.width, height: row.height, bytes: row.bytes, selected, createdAt: row.created_at };
  }

  list(workId: string): { workId: string; state: CoverState; coverId: string | null; covers: CoverSummary[] } {
    const work = this.work(workId);
    const rows = this.store.sqlite.prepare("SELECT * FROM covers WHERE work_id = ? ORDER BY created_at DESC, rowid DESC").all(workId) as CoverRow[];
    return { workId, state: work.cover_state, coverId: work.cover_id, covers: rows.map((row) => this.summary(row, row.id === work.cover_id)) };
  }

  select(envelope: CommandEnvelope, input: { workId: string; coverId: string }): Record<string, unknown> {
    const work = this.work(input.workId);
    const cover = this.row(input.coverId);
    if (cover.work_id !== input.workId) throw new MangaError("NOT_FOUND", "that cover belongs to another work");
    if (!this.available(cover)) throw new MangaError("NOT_FOUND", "the cover file is missing; extract or download it again");
    const state: CoverState = work.cover_state === "locked" ? "locked" : "user";
    this.store.commit({
      mutations: [{ sql: "UPDATE works SET cover_id = ?, cover_state = ?, updated_at = ? WHERE id = ?", params: [cover.id, state, new Date().toISOString(), input.workId] }],
      events: [{ type: "cover.selected", payload: { workId: input.workId, coverId: cover.id } }],
      idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId, result: { workId: input.workId, coverId: cover.id, state },
    });
    return { workId: input.workId, coverId: cover.id, state };
  }

  lock(envelope: CommandEnvelope, input: { workId: string; locked: boolean }): Record<string, unknown> {
    const work = this.work(input.workId);
    if (input.locked && !work.cover_id) throw new MangaError("VALIDATION_ERROR", "there is no cover to lock");
    const state: CoverState = input.locked ? "locked" : work.cover_state === "locked" ? "user" : work.cover_state;
    this.store.commit({
      mutations: [{ sql: "UPDATE works SET cover_state = ?, updated_at = ? WHERE id = ?", params: [state, new Date().toISOString(), input.workId] }],
      events: [{ type: "cover.lockChanged", payload: { workId: input.workId, locked: input.locked } }],
      idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId, result: { workId: input.workId, state },
    });
    return { workId: input.workId, state };
  }

  /** Handles for thumbnails the library shows. Missing or unreadable covers are reported per id and never fail the batch. */
  async handles(coverIds: string[], size: keyof typeof SIZES, signal?: AbortSignal): Promise<Array<{ coverId: string } & ({ available: true; url: string; mediaType: string; width: number; height: number } | { available: false; reason: string })>> {
    const out: Array<{ coverId: string } & ({ available: true; url: string; mediaType: string; width: number; height: number } | { available: false; reason: string })> = [];
    for (const coverId of coverIds) {
      signal?.throwIfAborted();
      const row = this.store.sqlite.prepare("SELECT * FROM covers WHERE id = ?").get(coverId) as CoverRow | undefined;
      if (!row) { out.push({ coverId, available: false, reason: "cover missing" }); continue; }
      if (!this.available(row)) { out.push({ coverId, available: false, reason: "the cover file is missing" }); continue; }
      try {
        const key = this.media.thumbs.keyFor("cover", row.content_hash, SIZES[size]);
        const made = await this.media.thumbs.ensure(key, () => makeThumbnail(this.bytesOf(row), { maxEdge: SIZES[size], format: "webp", signal }), signal);
        const issued = this.media.handles.issue({ kind: "file", path: made.path, mediaType: made.mediaType }, { moduleId: COVER_MODULE, subject: `cover:${coverId}` }, { ttlMs: COVER_TTL_MS });
        out.push({ coverId, available: true, url: issued.url, mediaType: made.mediaType, width: made.width ?? 0, height: made.height ?? 0 });
      } catch (error) {
        if (signal?.aborted) throw new MangaError("CANCELLED", "cover request was cancelled");
        out.push({ coverId, available: false, reason: error instanceof MangaError ? error.message : "the cover could not be read" });
      }
    }
    return out;
  }

  /** Small pictures kept in the image table (avatars), as handles for the interface. A missing one is left out. */
  async imageHandles(hashes: string[], maxEdge = 160, signal?: AbortSignal): Promise<Map<string, { url: string; mediaType: string }>> {
    const out = new Map<string, { url: string; mediaType: string }>();
    for (const hash of new Set(hashes)) {
      signal?.throwIfAborted();
      if (!this.images.has(hash)) continue;
      try {
        const key = this.media.thumbs.keyFor("avatar", hash, maxEdge);
        const made = await this.media.thumbs.ensure(key, () => makeThumbnail(this.images.read(hash).bytes, { maxEdge, format: "webp", signal }), signal);
        const issued = this.media.handles.issue({ kind: "file", path: made.path, mediaType: made.mediaType }, { moduleId: COVER_MODULE, subject: `image:${hash}` }, { ttlMs: COVER_TTL_MS });
        out.set(hash, { url: issued.url, mediaType: made.mediaType });
      } catch {
        if (signal?.aborted) throw new MangaError("CANCELLED", "the request was cancelled");
      }
    }
    return out;
  }

  /** Cover bytes by id, for a caller that needs the picture itself (an export, or an Agent's image material). */
  read(coverId: string): { bytes: Buffer; mediaType: string } {
    const row = this.row(coverId);
    if (!this.available(row)) throw new MangaError("NOT_FOUND", "the cover file is missing");
    return { bytes: this.bytesOf(row), mediaType: row.media_type };
  }

  /** Covers whose files have gone missing from the cache are forgotten, so the next extraction can add them again. */
  forgetMissingCacheCovers(workId: string): number {
    const rows = this.store.sqlite.prepare("SELECT * FROM covers WHERE work_id = ? AND area = 'cache'").all(workId) as CoverRow[];
    let removed = 0;
    for (const row of rows) {
      if (fs.existsSync(this.fileOf(row))) continue;
      this.store.sqlite.prepare("UPDATE works SET cover_id = NULL WHERE id = ? AND cover_id = ?").run(workId, row.id);
      this.store.sqlite.prepare("DELETE FROM covers WHERE id = ?").run(row.id);
      removed += 1;
    }
    return removed;
  }

  /** Total bytes the covers use, per area, for the inventory. */
  usage(): { attachments: number; cache: number; count: number } {
    const rows = this.store.sqlite.prepare("SELECT area, COALESCE(SUM(bytes), 0) AS bytes, COUNT(*) AS n FROM covers GROUP BY area").all() as Array<{ area: string; bytes: number; n: number }>;
    return { attachments: rows.filter((row) => row.area !== "cache").reduce((sum, row) => sum + row.bytes, 0), cache: rows.find((row) => row.area === "cache")?.bytes ?? 0, count: rows.reduce((sum, row) => sum + row.n, 0) };
  }
}
