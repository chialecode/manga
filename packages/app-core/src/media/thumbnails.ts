import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp, { type Sharp } from "sharp";
import { MangaError } from "@manga/contracts";
import { Lane } from "./process-runner.ts";

/** Pixels a single decode may produce. A 20000 x 10000 scan passes; a decompression-bomb image is refused before decoding. */
export const MAX_INPUT_PIXELS = 268_000_000;

export type ImageInfo = { width: number; height: number; format: string };
export type ThumbnailRequest = {
  /** Long edge limit. Ignored for the edge that `width` bounds. */
  maxEdge?: number;
  /** Fit to this width and let the height follow (long strips). */
  width?: number;
  format?: "webp" | "jpeg" | "png";
  quality?: number;
  /** Crop to this region, given as fractions of the source, before scaling. */
  region?: { x: number; y: number; width: number; height: number };
  signal?: AbortSignal;
};
export type ThumbnailResult = { bytes: Buffer; width: number; height: number; mediaType: string; sourceWidth: number; sourceHeight: number };

sharp.concurrency(2);
// Decoded pixels are not kept between requests; the cache below holds the small results instead.
sharp.cache(false);

const MEDIA_TYPES = { webp: "image/webp", jpeg: "image/jpeg", png: "image/png" } as const;

function open(input: Buffer | string): Sharp {
  return sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "warning", sequentialRead: true });
}

function translate(error: unknown): MangaError {
  if (error instanceof MangaError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/pixel limit|exceeds pixel/i.test(message)) return new MangaError("UNSUPPORTED_FORMAT", "image is larger than the pixel budget");
  return new MangaError("UNSUPPORTED_FORMAT", `image cannot be decoded: ${message.split(/\r?\n/)[0]}`);
}

export async function imageInfo(input: Buffer | string): Promise<ImageInfo> {
  try {
    const meta = await open(input).metadata();
    if (!meta.width || !meta.height) throw new Error("no dimensions");
    // Orientation 5-8 swaps width and height when displayed.
    const rotated = (meta.orientation ?? 1) >= 5;
    return { width: rotated ? meta.height : meta.width, height: rotated ? meta.width : meta.height, format: meta.format ?? "unknown" };
  } catch (error) {
    throw translate(error);
  }
}

/** Fully decode once to prove the image is whole; cheap enough for the first page of a book, not for every page. */
export async function verifyDecodes(input: Buffer | string): Promise<ImageInfo> {
  try {
    const info = await imageInfo(input);
    await open(input).resize({ width: 8, height: 8, fit: "inside" }).raw().toBuffer();
    return info;
  } catch (error) {
    throw translate(error);
  }
}

export async function makeThumbnail(input: Buffer | string, request: ThumbnailRequest = {}): Promise<ThumbnailResult> {
  if (request.signal?.aborted) throw new MangaError("CANCELLED", "thumbnail was cancelled");
  const format = request.format ?? "webp";
  try {
    const source = await imageInfo(input);
    let pipeline = open(input).rotate();
    if (request.region) {
      const r = request.region;
      const left = Math.max(0, Math.min(source.width - 1, Math.round(r.x * source.width)));
      const top = Math.max(0, Math.min(source.height - 1, Math.round(r.y * source.height)));
      const width = Math.max(1, Math.min(source.width - left, Math.round(r.width * source.width)));
      const height = Math.max(1, Math.min(source.height - top, Math.round(r.height * source.height)));
      pipeline = pipeline.extract({ left, top, width, height });
    }
    if (request.width) pipeline = pipeline.resize({ width: request.width, withoutEnlargement: true });
    else if (request.maxEdge) pipeline = pipeline.resize({ width: request.maxEdge, height: request.maxEdge, fit: "inside", withoutEnlargement: true });
    const quality = request.quality ?? (format === "png" ? undefined : 82);
    pipeline = format === "webp" ? pipeline.webp({ quality }) : format === "jpeg" ? pipeline.jpeg({ quality, mozjpeg: false }) : pipeline.png({ compressionLevel: 6 });
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
    if (request.signal?.aborted) throw new MangaError("CANCELLED", "thumbnail was cancelled");
    return { bytes: data, width: info.width, height: info.height, mediaType: MEDIA_TYPES[format], sourceWidth: source.width, sourceHeight: source.height };
  } catch (error) {
    throw translate(error);
  }
}

/** Content-addressed cache of derived images. Everything in it can be rebuilt from the originals. */
export class ThumbnailCache {
  private readonly lane = new Lane(3);

  readonly directory: string;
  private readonly budgetBytes: number;

  constructor(directory: string, budgetBytes = 512 * 1024 * 1024) {
    this.directory = directory;
    this.budgetBytes = budgetBytes;
  }

  keyFor(...parts: Array<string | number | undefined>): string {
    return createHash("sha256").update(parts.map((part) => String(part ?? "")).join("\u0000")).digest("hex");
  }

  fileFor(key: string, mediaType: string): string {
    const ext = mediaType === "image/jpeg" ? "jpg" : mediaType === "image/png" ? "png" : "webp";
    return path.join(this.directory, key.slice(0, 2), `${key}.${ext}`);
  }

  find(key: string): { path: string; mediaType: string } | null {
    for (const mediaType of ["image/webp", "image/jpeg", "image/png"]) {
      const file = this.fileFor(key, mediaType);
      if (fs.existsSync(file)) {
        const now = new Date();
        try { fs.utimesSync(file, now, now); } catch { /* usage time is advisory */ }
        return { path: file, mediaType };
      }
    }
    return null;
  }

  /** Make (or find) the derived image for `key`. Concurrency is capped so a page of thumbnails does not saturate the machine. */
  async ensure(key: string, make: () => Promise<ThumbnailResult>, signal?: AbortSignal): Promise<{ path: string; mediaType: string; width: number; height: number } | { path: string; mediaType: string; width?: undefined; height?: undefined }> {
    const hit = this.find(key);
    if (hit) return hit;
    return this.lane.run(async () => {
      const again = this.find(key);
      if (again) return again;
      const result = await make();
      const file = this.fileFor(key, result.mediaType);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const staging = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(staging, result.bytes);
      fs.renameSync(staging, file);
      return { path: file, mediaType: result.mediaType, width: result.width, height: result.height };
    }, signal);
  }

  totalBytes(): number {
    let total = 0;
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else total += fs.statSync(full).size;
      }
    };
    walk(this.directory);
    return total;
  }

  /** Drop the least recently used files until the cache fits its budget. Returns how many files were removed. */
  trim(): number {
    const files: Array<{ file: string; size: number; at: number }> = [];
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (!entry.name.endsWith(".tmp")) {
          const stat = fs.statSync(full);
          files.push({ file: full, size: stat.size, at: stat.mtimeMs });
        }
      }
    };
    walk(this.directory);
    let total = files.reduce((sum, item) => sum + item.size, 0);
    let removed = 0;
    for (const item of files.sort((a, b) => a.at - b.at)) {
      if (total <= this.budgetBytes) break;
      fs.rmSync(item.file, { force: true });
      total -= item.size;
      removed += 1;
    }
    return removed;
  }
}
