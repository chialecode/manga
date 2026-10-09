import fs from "node:fs";
import zlib from "node:zlib";
import { MangaError, createId, type PageRegion } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import type { WorkFolders } from "./work-folders.ts";
import { safeName } from "./work-folders.ts";

/**
 * Screenshots (NOTE-05). The page draws the picture at the size of the source (a `video` element's own frame, a comic page's original), and
 * hands over a PNG; the service gives it a place in the folder of its work, writes what is known about where it came from into the database
 * and into the file itself, and makes it an object that notes, boards and maps can point at. The database is the record; the text inside the
 * PNG exists so a file that travels alone still says where it is from.
 */

export type VideoShot = {
  positionMs: number;
  /** Frame number when the file has a frame table. */
  frame?: number;
  playbackRate?: number;
  audioTrack?: string;
  subtitleTrack?: string;
  /** The subtitle text on screen at that moment. */
  subtitleText?: string;
  /** The secondary track under the main one, and the lines it showed at that moment. */
  subtitleSecondaryTrack?: string;
  subtitleSecondaryText?: string;
  /** What was drawn onto the picture besides the video: the subtitles on screen and/or the flying comments. The text above is kept either way. */
  composited?: "none" | "subtitles" | "danmaku" | "both";
};

export type ComicShot = {
  pageId: string;
  pageLabel?: string;
  /** Position of the page in the book, from 0. */
  pageIndex?: number;
  /** The pages of a spread that was captured whole, in reading order. */
  spreadPageIds?: string[];
  direction?: "ltr" | "rtl" | "vertical";
  /** Fractions of the original page. */
  region?: PageRegion;
};

export type ScreenshotInput = {
  resourceId: string;
  resourceRevisionId?: string;
  /** PNG, base64. */
  data: string;
  video?: VideoShot;
  comic?: ComicShot;
};

export type ScreenshotView = {
  id: string;
  title: string;
  fileId: string;
  resourceId: string;
  resourceRevisionId: string;
  workId: string | null;
  mediaKind: "video" | "comic";
  positionMs: number | null;
  frame: number | null;
  pageId: string | null;
  pageLabel: string | null;
  spread: boolean;
  region: PageRegion | null;
  width: number;
  height: number;
  format: string;
  subtitleText: string | null;
  meta: Record<string, unknown>;
  capturedAt: string;
  /** False when the file is gone from the folder (the person deleted it there). */
  available: boolean;
};

type Row = {
  id: string; title: string; file_id: string; resource_id: string; resource_revision_id: string; work_id: string | null; media_kind: "video" | "comic";
  position_ms: number | null; frame: number | null; page_id: string | null; page_label: string | null; spread: number | null; region_json: string | null;
  width: number; height: number; format: string; subtitle_text: string | null; meta_json: string; captured_at: string;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_BYTES = 60 * 1024 * 1024;
const TEXT_KEY = "manga.screenshot";

/** Width and height from the header of a PNG; refuses anything that is not one. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") {
    throw new MangaError("VALIDATION_ERROR", "the screenshot is not a PNG picture", { details: { reason: "not-png" } });
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > 32768 || height > 32768) throw new MangaError("VALIDATION_ERROR", "the screenshot has an impossible size", { details: { reason: "size" } });
  return { width, height };
}

const chunk = (type: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
};

/** The PNG with one more `iTXt` chunk, written before the last chunk. The picture itself is not touched. */
export function embedPngText(png: Buffer, keyword: string, text: string): Buffer {
  pngSize(png);
  const body = Buffer.concat([Buffer.from(keyword, "latin1"), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(text, "utf8")]);
  const end = png.length - 12;
  if (png.toString("latin1", end + 4, end + 8) !== "IEND") throw new MangaError("VALIDATION_ERROR", "the screenshot is cut short", { details: { reason: "truncated" } });
  return Buffer.concat([png.subarray(0, end), chunk("iTXt", body), png.subarray(end)]);
}

/** The `iTXt` and `tEXt` chunks of a PNG by keyword; a chunk with a wrong checksum is ignored. */
export function readPngText(png: Buffer): Record<string, string> {
  pngSize(png);
  const out: Record<string, string> = {};
  let at = 8;
  while (at + 12 <= png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("latin1", at + 4, at + 8);
    const body = png.subarray(at + 8, at + 8 + length);
    const crc = png.readUInt32BE(at + 8 + length);
    if (at + 12 + length > png.length) break;
    if ((type === "iTXt" || type === "tEXt") && zlib.crc32(png.subarray(at + 4, at + 8 + length)) >>> 0 === crc) {
      const split = body.indexOf(0);
      if (split > 0) {
        const keyword = body.toString("latin1", 0, split);
        out[keyword] = type === "iTXt" ? body.toString("utf8", split + 5) : body.toString("latin1", split + 1);
      }
    }
    if (type === "IEND") break;
    at += 12 + length;
  }
  return out;
}

const clock = (ms: number): string => {
  const total = Math.max(0, Math.floor(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const rest = total % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(rest).padStart(3, "0")}`;
};

const viewOf = (row: Row, available: boolean): ScreenshotView => ({
  id: row.id, title: row.title, fileId: row.file_id, resourceId: row.resource_id, resourceRevisionId: row.resource_revision_id, workId: row.work_id,
  mediaKind: row.media_kind, positionMs: row.position_ms, frame: row.frame, pageId: row.page_id, pageLabel: row.page_label, spread: row.spread === 1,
  region: row.region_json ? JSON.parse(row.region_json) as PageRegion : null, width: row.width, height: row.height, format: row.format,
  subtitleText: row.subtitle_text, meta: JSON.parse(row.meta_json) as Record<string, unknown>, capturedAt: row.captured_at, available,
});

export class ScreenshotService {
  private readonly store: DrizzleStore;
  private readonly files: WorkFolders;
  private readonly notify: (topic: string, payload: Record<string, unknown>) => void;

  constructor(store: DrizzleStore, files: WorkFolders, notify: (topic: string, payload: Record<string, unknown>) => void = () => undefined) {
    this.store = store;
    this.files = files;
    this.notify = notify;
  }

  save(input: ScreenshotInput): ScreenshotView {
    const resource = this.store.sqlite.prepare("SELECT r.id AS id, r.kind AS kind, r.title AS title, r.work_id AS workId, r.ordinal_label AS ordinal FROM resources r WHERE r.id = ?").get(input.resourceId) as
      { id: string; kind: string; title: string; workId: string | null; ordinal: string | null } | undefined;
    if (!resource) throw new MangaError("NOT_FOUND", "resource missing");
    if (resource.kind !== "video" && resource.kind !== "comic") throw new MangaError("VALIDATION_ERROR", "only a video or a comic can be captured", { details: { reason: "kind" } });
    if ((resource.kind === "video") !== Boolean(input.video) || (resource.kind === "comic") !== Boolean(input.comic)) {
      throw new MangaError("VALIDATION_ERROR", "the position does not fit the kind of resource", { details: { reason: "position" } });
    }
    const revision = (input.resourceRevisionId
      ? this.store.sqlite.prepare("SELECT id FROM resource_revisions WHERE id = ? AND resource_id = ?").get(input.resourceRevisionId, input.resourceId)
      : this.store.sqlite.prepare("SELECT id FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(input.resourceId)) as { id: string } | undefined;
    if (!revision) throw new MangaError("NOT_FOUND", "resource revision missing");
    const png = Buffer.from(input.data, "base64");
    if (!png.length || png.length > MAX_BYTES) throw new MangaError("VALIDATION_ERROR", "the screenshot is empty or too large", { details: { reason: "bytes" } });
    const { width, height } = pngSize(png);
    // A resource that belongs to no work (an entry was deleted, or none was ever linked) is captured all the same: its pictures go to its own folder (A-88).
    const work = (resource.workId ? this.store.sqlite.prepare("SELECT title FROM works WHERE id = ?").get(resource.workId) as { title: string } | undefined : undefined) ?? { title: resource.title };
    const id = createId("shot");
    const capturedAt = new Date().toISOString();
    const video = input.video;
    const comic = input.comic;
    const label = video ? clock(video.positionMs) : (comic?.pageLabel || `P${(comic?.pageIndex ?? 0) + 1}`);
    const spread = Boolean(comic?.spreadPageIds && comic.spreadPageIds.length > 1);
    const title = `${resource.title} · ${video ? label.replace(/^00:/, "").replace(/\.\d+$/, "") : label}${comic?.region ? " · 区域" : spread ? " · 跨页" : ""}`;
    const meta: Record<string, unknown> = {
      work: work.title, resource: resource.title, ordinal: resource.ordinal,
      ...(video ? { timestamp: label, playbackRate: video.playbackRate ?? 1, audioTrack: video.audioTrack ?? null, subtitleTrack: video.subtitleTrack ?? null, subtitleSecondaryTrack: video.subtitleSecondaryTrack ?? null, subtitleSecondaryText: video.subtitleSecondaryText?.slice(0, 2000) ?? null, composited: video.composited ?? "none" } : {}),
      ...(comic ? { direction: comic.direction ?? null, spreadPageIds: comic.spreadPageIds ?? null, pageIndex: comic.pageIndex ?? null } : {}),
    };
    const embedded = embedPngText(png, TEXT_KEY, JSON.stringify({ id, version: 1, ...meta, resourceId: resource.id, resourceRevisionId: revision.id, positionMs: video?.positionMs ?? null, frame: video?.frame ?? null, pageId: comic?.pageId ?? null, region: comic?.region ?? null, subtitle: video?.subtitleText ?? null, width, height, capturedAt }));
    const fileName = `${safeName(`${work.title} ${resource.ordinal ?? resource.title}`)} ${safeName(label.replace(/:/g, "-"))}${comic?.region ? " 区域" : spread ? " 跨页" : ""}.png`;
    const put = this.files.put({ resourceId: resource.id }, { kind: "screenshot", fileName, bytes: embedded, resourceId: resource.id, refKind: "screenshot", refId: id });
    try {
      this.store.commit({
        mutations: [{
          sql: "INSERT INTO screenshots(id, title, file_id, resource_id, resource_revision_id, work_id, media_kind, position_ms, frame, page_id, page_label, spread, region_json, width, height, format, subtitle_text, meta_json, captured_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          params: [id, title, put.fileId, resource.id, revision.id, resource.workId, resource.kind, video?.positionMs ?? null, video?.frame ?? null, comic?.pageId ?? null, comic?.pageLabel ?? null, spread ? 1 : 0, comic?.region ? JSON.stringify(comic.region) : null, width, height, "png", video?.subtitleText?.slice(0, 2000) ?? null, JSON.stringify(meta), capturedAt],
        }],
        events: [{ type: "screenshot.saved", payload: { screenshotId: id, resourceId: resource.id, workId: resource.workId } }],
      });
    } catch (error) {
      this.files.remove(put.fileId);
      throw error;
    }
    this.notify("screenshot.saved", { screenshotId: id, resourceId: resource.id, workId: resource.workId });
    return this.get(id)!;
  }

  get(id: string): ScreenshotView | null {
    const row = this.store.sqlite.prepare("SELECT * FROM screenshots WHERE id = ?").get(id) as Row | undefined;
    return row ? viewOf(row, Boolean(this.files.pathOf(row.file_id))) : null;
  }

  list(input: { resourceId?: string; workId?: string; limit?: number } = {}): { items: ScreenshotView[]; total: number } {
    const where = [input.resourceId ? "resource_id = ?" : "", input.workId ? "work_id = ?" : ""].filter(Boolean);
    const params = [input.resourceId, input.workId].filter((value): value is string => Boolean(value));
    const clause = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const total = (this.store.sqlite.prepare(`SELECT COUNT(*) AS n FROM screenshots${clause}`).get(...params) as { n: number }).n;
    const rows = this.store.sqlite.prepare(`SELECT * FROM screenshots${clause} ORDER BY captured_at DESC, id DESC LIMIT ?`).all(...params, Math.min(input.limit ?? 50, 200)) as Row[];
    return { items: rows.map((row) => viewOf(row, Boolean(this.files.pathOf(row.file_id)))), total };
  }

  /** The file on disk, for the picture handle and for opening the folder. */
  pathOf(id: string): string {
    const row = this.store.sqlite.prepare("SELECT file_id AS fileId FROM screenshots WHERE id = ?").get(id) as { fileId: string } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "screenshot missing");
    const file = this.files.pathOf(row.fileId);
    if (!file) throw new MangaError("NOT_FOUND", "the screenshot file is no longer in the folder", { details: { reason: "file-missing" } });
    return file;
  }

  /** Remove the record, and the file unless the person keeps it. */
  delete(id: string, options: { deleteFile: boolean }): { deleted: boolean } {
    const row = this.store.sqlite.prepare("SELECT file_id AS fileId FROM screenshots WHERE id = ?").get(id) as { fileId: string } | undefined;
    if (!row) return { deleted: false };
    this.store.commit({ mutations: [{ sql: "DELETE FROM screenshots WHERE id = ?", params: [id] }], events: [{ type: "screenshot.deleted", payload: { screenshotId: id } }] });
    this.files.remove(row.fileId, { deleteFile: options.deleteFile });
    this.notify("screenshot.deleted", { screenshotId: id });
    return { deleted: true };
  }

  /** The picture's own text, for a file that travels alone. */
  readEmbedded(id: string): Record<string, unknown> | null {
    const text = readPngText(fs.readFileSync(this.pathOf(id)))[TEXT_KEY];
    return text ? JSON.parse(text) as Record<string, unknown> : null;
  }
}
