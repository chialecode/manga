import { createHash } from "node:crypto";
import { MangaError } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { imageInfo } from "../media/thumbnails.ts";

/** Pictures the database keeps (A-51): covers and avatars pulled from a source or chosen by the user. Keyed by content hash, so one picture is one row. */
const TYPE_FOR_FORMAT: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", avif: "image/avif" };
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export type ImageSummary = { hash: string; mediaType: string; width: number | null; height: number | null; bytes: number };

export class ImageStore {
  private readonly store: DrizzleStore;

  constructor(store: DrizzleStore) {
    this.store = store;
  }

  /** Validate and describe a picture without keeping it. */
  async inspect(bytes: Buffer): Promise<ImageSummary> {
    if (!bytes.length) throw new MangaError("UNSUPPORTED_FORMAT", "the picture is empty");
    if (bytes.length > MAX_IMAGE_BYTES) throw new MangaError("UNSUPPORTED_FORMAT", "the picture is larger than a stored picture may be");
    const info = await imageInfo(bytes);
    const mediaType = TYPE_FOR_FORMAT[info.format];
    if (!mediaType) throw new MangaError("UNSUPPORTED_FORMAT", `${info.format} pictures cannot be stored`);
    return { hash: createHash("sha256").update(bytes).digest("hex"), mediaType, width: info.width, height: info.height, bytes: bytes.length };
  }

  has(hash: string): boolean {
    return Boolean(this.store.sqlite.prepare("SELECT 1 FROM images WHERE hash = ?").get(hash));
  }

  /** The SQL that stores a picture, for a caller that commits it together with the rows that reference it. */
  insertSql(summary: ImageSummary, bytes: Buffer, source?: { url?: string; fetchedAt?: string }): { sql: string; params: Array<string | number | null | Buffer> } {
    return {
      sql: "INSERT OR IGNORE INTO images(hash, media_type, width, height, bytes, payload, source_url, fetched_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      params: [summary.hash, summary.mediaType, summary.width, summary.height, summary.bytes, bytes, source?.url ?? null, source?.fetchedAt ?? null, new Date().toISOString()],
    };
  }

  read(hash: string): { bytes: Buffer; mediaType: string } {
    const row = this.store.sqlite.prepare("SELECT payload, media_type FROM images WHERE hash = ?").get(hash) as { payload: Buffer; media_type: string } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the picture is not in the library");
    return { bytes: row.payload, mediaType: row.media_type };
  }

  /** Bytes the image table holds, for the inventory and the growth measurement. */
  usage(): { count: number; bytes: number } {
    const row = this.store.sqlite.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM images").get() as { n: number; bytes: number };
    return { count: row.n, bytes: row.bytes };
  }
}
