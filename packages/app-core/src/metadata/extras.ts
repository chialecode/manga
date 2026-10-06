import fs from "node:fs";
import path from "node:path";
import { MangaError } from "@manga/contracts";
import type { ComicManifest, MetadataFieldValue, VideoProbe } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { mobiTableOfFile, readMobiRecord } from "../comic/scan.ts";
import type { ComicService } from "../comic/service.ts";
import { readPdfInfo, renderPdfPage } from "../domain/pdfjs-document.ts";
import { makeThumbnail } from "../media/thumbnails.ts";
import type { MediaServices } from "../media/services.ts";
import type { VideoService } from "../video/service.ts";
import type { CoverService } from "./covers.ts";
import { cleanPdfInfo, comicInfoFields, isEmptyFields, readEpub, readMobiExth, videoTagFields, type LocalFields } from "./local-file.ts";

const COVER_EDGE = 1200;
export const LOCAL_PROVIDER = "local-file";

type Kind = "comic" | "video" | "epub" | "mobi" | "pdf" | "txt";

/**
 * What a stored resource can tell about its work without any network: a cover picture and the metadata its own file carries.
 * Both are read from the original on demand; the results are written as cache (cover) and as the `local-file` snapshot.
 */
export class ResourceExtras {
  private readonly store: DrizzleStore;
  private readonly media: MediaServices;
  private readonly comics: ComicService;
  private readonly videos: VideoService;
  private readonly covers: CoverService;

  constructor(store: DrizzleStore, media: MediaServices, comics: ComicService, videos: VideoService, covers: CoverService) {
    this.store = store;
    this.media = media;
    this.comics = comics;
    this.videos = videos;
    this.covers = covers;
  }

  private describe(resourceId: string): { workId: string | null; revisionId: string; kind: Kind; file: string | null; available: boolean; payload: { comic?: ComicManifest; format?: string; video?: unknown }; title: string } {
    const row = this.store.sqlite.prepare(`SELECT r.work_id AS workId, r.title AS title, v.id AS revisionId, v.payload_json AS payload
      FROM resources r JOIN resource_revisions v ON v.resource_id = r.id WHERE r.id = ? ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1`).get(resourceId) as { workId: string | null; title: string; revisionId: string; payload: string } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "resource missing");
    const payload = JSON.parse(row.payload) as { comic?: ComicManifest; format?: string; video?: unknown };
    const location = this.store.sqlite.prepare("SELECT relative_path, available FROM file_locations WHERE resource_revision_id = ? ORDER BY rowid DESC LIMIT 1").get(row.revisionId) as { relative_path: string; available: number } | undefined;
    const file = location?.relative_path ?? null;
    const kind: Kind = payload.video ? "video" : payload.comic ? "comic" : (["epub", "mobi", "pdf"].includes(payload.format ?? "") ? payload.format as Kind : "txt");
    return { workId: row.workId, revisionId: row.revisionId, kind, file, available: file !== null && fs.existsSync(file), payload, title: row.title };
  }

  private async normalized(bytes: Buffer, signal?: AbortSignal): Promise<Buffer> {
    const made = await makeThumbnail(bytes, { maxEdge: COVER_EDGE, format: "webp", quality: 85, signal });
    return made.bytes;
  }

  /** The picture of the resource's own cover, or null when the file has none. */
  private async coverBytes(resourceId: string, signal?: AbortSignal): Promise<Buffer | null> {
    const info = this.describe(resourceId);
    if (!info.available || !info.file) return null;
    switch (info.kind) {
      case "video": {
        return this.videos.coverFrame(resourceId, info.revisionId, signal);
      }
      case "comic": {
        const first = await this.comics.pageImage({ resourceId, revisionId: info.revisionId, maxEdge: COVER_EDGE, format: "webp", signal });
        return first.bytes;
      }
      case "epub": {
        const epub = await readEpub(this.media.zips, info.file, signal);
        return epub.cover();
      }
      case "mobi": {
        const exth = readMobiExth(info.file);
        const table = mobiTableOfFile(info.file);
        const record = (exth.coverRecord !== undefined ? table.records.find((item) => item.recordIndex === exth.coverRecord) : undefined) ?? table.records[0];
        return record ? readMobiRecord(info.file, record.offset, record.length) : null;
      }
      case "pdf": {
        const painted = await renderPdfPage({ file: info.file }, 1, { maxEdge: COVER_EDGE, signal });
        return painted.png;
      }
      case "txt":
        return null;
    }
  }

  /** Extract the resource's own picture as a cover of its work. A work that already has a better or chosen cover keeps it. */
  async extractCover(resourceId: string, options: { signal?: AbortSignal; ifMissing?: boolean } = {}): Promise<{ workId: string | null; added: boolean; coverId?: string; reason?: string }> {
    const { signal } = options;
    const info = this.describe(resourceId);
    if (!info.workId) return { workId: null, added: false, reason: "the resource belongs to no work" };
    this.covers.forgetMissingCacheCovers(info.workId);
    // Later volumes of a work do not pile up covers: the first one that has a picture decides.
    if (options.ifMissing && this.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ? AND cover_id IS NOT NULL").get(info.workId)) return { workId: info.workId, added: false, reason: "the work already has a cover" };
    if (!info.available) return { workId: info.workId, added: false, reason: "the original file is not available" };
    let bytes: Buffer | null;
    try {
      bytes = await this.coverBytes(resourceId, signal);
    } catch (error) {
      if (signal?.aborted) throw new MangaError("CANCELLED", "cover extraction was cancelled");
      return { workId: info.workId, added: false, reason: error instanceof MangaError ? error.message : "no cover could be read from the file" };
    }
    if (!bytes?.length) return { workId: info.workId, added: false, reason: "the file has no cover picture" };
    try {
      const prepared = await this.normalized(bytes, signal);
      const result = await this.covers.add(info.workId, { bytes: prepared, source: "file", providerId: LOCAL_PROVIDER, externalId: resourceId, signal });
      return { workId: info.workId, added: result.added, coverId: result.cover.id };
    } catch (error) {
      if (signal?.aborted) throw new MangaError("CANCELLED", "cover extraction was cancelled");
      return { workId: info.workId, added: false, reason: error instanceof MangaError ? error.message : "the cover picture could not be used" };
    }
  }

  /** The metadata the file itself carries. Missing, damaged or oddly encoded data gives fewer fields, never an error. */
  async readLocal(resourceId: string, signal?: AbortSignal): Promise<{ workId: string | null; fields: LocalFields }> {
    const info = this.describe(resourceId);
    let fields: LocalFields = {};
    try {
      if (info.kind === "comic") {
        fields = comicInfoFields(info.payload.comic?.info);
        const source = info.payload.comic?.source;
        if (info.available && info.file && !Object.keys(fields).length) {
          if (source === "epub") fields = (await readEpub(this.media.zips, info.file, signal)).fields;
          else if (source === "mobi") fields = readMobiExth(info.file).fields;
          else if (source === "pdf") fields = cleanPdfInfo(await readPdfInfo({ file: info.file }, signal));
        }
      } else if (info.kind === "video") {
        const row = this.store.sqlite.prepare("SELECT probe_json FROM media_probes WHERE resource_revision_id = ?").get(info.revisionId) as { probe_json: string } | undefined;
        if (row && info.file) fields = videoTagFields(JSON.parse(row.probe_json) as VideoProbe, path.basename(info.file, path.extname(info.file)));
      } else if (info.available && info.file) {
        if (info.kind === "epub") fields = (await readEpub(this.media.zips, info.file, signal)).fields;
        else if (info.kind === "mobi") fields = readMobiExth(info.file).fields;
        else if (info.kind === "pdf") fields = cleanPdfInfo(await readPdfInfo({ file: info.file }, signal));
      }
    } catch (error) {
      if (signal?.aborted) throw new MangaError("CANCELLED", "metadata reading was cancelled");
      fields = {};
    }
    return { workId: info.workId, fields };
  }

  /** Store (or refresh) the work's `local-file` snapshot from its first resource that has something to say. */
  saveLocalSnapshot(workId: string, fields: LocalFields, now = new Date().toISOString()): boolean {
    if (isEmptyFields(fields)) return false;
    const existing = this.store.sqlite.prepare("SELECT snapshot_json FROM metadata_snapshots WHERE work_id = ? AND provider_id = ?").get(workId, LOCAL_PROVIDER) as { snapshot_json: string } | undefined;
    const merged: Record<string, MetadataFieldValue> = existing ? { ...((JSON.parse(existing.snapshot_json) as { fields?: Record<string, MetadataFieldValue> }).fields ?? {}) } : {};
    // The first resource that states a field decides it; later volumes do not rewrite what the work already says.
    for (const [key, value] of Object.entries(fields)) if (merged[key] === undefined) merged[key] = value as MetadataFieldValue;
    const json = JSON.stringify({ version: 1, fields: merged });
    if (existing?.snapshot_json === json) return false;
    this.store.sqlite.prepare(`INSERT INTO metadata_snapshots(work_id, provider_id, external_id, snapshot_json, fetched_at, source_url, api_version, detached) VALUES (?,?,?,?,?,?,?,0)
      ON CONFLICT(work_id, provider_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, fetched_at = excluded.fetched_at`).run(workId, LOCAL_PROVIDER, workId, json, now, null, "local-file-v1");
    return true;
  }
}
