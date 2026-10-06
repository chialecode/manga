import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MangaError } from "@manga/contracts";
import type { ComicManifest, ComicPage, ComicSource } from "@manga/contracts";
import { htmlImageSources, htmlSvgImageHrefs, palmdocDecompress, resolveArchiveReference } from "../domain/formats.ts";
import { naturalCompare } from "../domain/ordinal.ts";
import { Lane } from "../media/process-runner.ts";
import { verifyDecodes } from "../media/thumbnails.ts";
import type { ZipPool } from "../media/zip-pool.ts";
import { parseComicInfo, type ComicInfo } from "./comicinfo.ts";

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".jpe", ".jfif", ".webp", ".gif", ".avif", ".bmp", ".tif", ".tiff"]);
/** Formats a Chromium `<img>` shows as is. Everything else is converted when displayed. */
export const BROWSER_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif", "image/bmp"]);
export const VIDEO_EXTENSIONS = new Set([".mkv", ".mp4", ".m4v", ".mov", ".avi", ".webm", ".ts", ".m2ts", ".flv", ".wmv", ".ogv", ".mpg", ".mpeg"]);
const ARCHIVE_EXTENSIONS = new Set([".cbz", ".zip"]);
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".epub", ".mobi", ".azw3"]);
export const NOVEL_EXTENSIONS = new Set([".txt", ".epub", ".mobi", ".azw3", ".pdf"]);
const MAX_PAGES = 5000;
const MAX_PAGE_BYTES = 256 * 1024 * 1024;
const DECODE_CONCURRENCY = 4;

const MEDIA_TYPES: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jpe": "image/jpeg", ".jfif": "image/jpeg", ".webp": "image/webp",
  ".gif": "image/gif", ".avif": "image/avif", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
};

export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

export function mediaTypeForName(name: string): string {
  return MEDIA_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

/** Names the operating system and archive tools leave behind; they are never pages. */
export function isIgnoredName(name: string): boolean {
  const base = name.split("/").pop() ?? name;
  return /^(thumbs\.db|desktop\.ini|\.ds_store)$/i.test(base) || base.startsWith("._") || (base.startsWith(".") && base !== ".") || name.split("/").some((segment) => segment === "__MACOSX");
}

export function comparePaths(left: string, right: string): number {
  const a = left.split("/");
  const b = right.split("/");
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    // A directory sorts with its siblings by name, so "vol 2/…" comes before "vol 10/…".
    const diff = naturalCompare(a[i]!, b[i]!);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

export type ScanOptions = {
  signal?: AbortSignal;
  zips: ZipPool;
  progress?: (done: number, total: number) => void;
  maxPages?: number;
};

export type ScanResult = {
  source: ComicSource;
  manifest: ComicManifest;
  title: string;
  /** Identity of the content: the same pages in the same order give the same value, wherever the files live. */
  fingerprint: string;
};

type Candidate = {
  id: string;
  name: string;
  ref: ComicPage["ref"];
  /** A path to read from disk, or a loader that returns the bytes. */
  load: { path: string } | { bytes: () => Promise<Buffer> };
  bytes?: number;
};

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) {
    signal?.throwIfAborted();
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

export async function fingerprintFile(file: string, signal?: AbortSignal): Promise<string> {
  return hashFile(file, signal);
}

/** Decode each candidate once: hash, dimensions and a whole-image decode check. A page that fails stays in the list marked unreadable. */
async function describePages(candidates: Candidate[], options: ScanOptions): Promise<ComicPage[]> {
  const lane = new Lane(DECODE_CONCURRENCY);
  const pages: ComicPage[] = new Array(candidates.length);
  let done = 0;
  await Promise.all(candidates.map((candidate, index) => lane.run(async () => {
    options.signal?.throwIfAborted();
    const base = { id: candidate.id, index, name: candidate.name, ref: candidate.ref };
    try {
      const input = "path" in candidate.load ? candidate.load.path : await candidate.load.bytes();
      if (Buffer.isBuffer(input) && input.length === 0) throw new MangaError("UNSUPPORTED_FORMAT", "page file is empty");
      const bytes = Buffer.isBuffer(input) ? input.length : fs.statSync(input).size;
      if (bytes === 0) throw new MangaError("UNSUPPORTED_FORMAT", "page file is empty");
      if (bytes > MAX_PAGE_BYTES) throw new MangaError("UNSUPPORTED_FORMAT", "page file is larger than the read budget");
      const info = await verifyDecodes(input);
      const hash = Buffer.isBuffer(input) ? sha(input) : await hashFile(input, options.signal);
      pages[index] = { ...base, width: info.width, height: info.height, hash, bytes, spread: info.width > info.height * 1.2, ok: true };
    } catch (error) {
      if (options.signal?.aborted) throw new MangaError("CANCELLED", "comic scan was cancelled");
      const message = error instanceof Error ? error.message : String(error);
      pages[index] = { ...base, width: 0, height: 0, hash: sha(`${candidate.id}:unreadable`), ok: false, error: message.slice(0, 200) };
    } finally {
      done += 1;
      options.progress?.(done, candidates.length);
    }
  }, options.signal)));
  return pages;
}

function fingerprintOf(pages: ComicPage[]): string {
  return sha(JSON.stringify(pages.map((page) => [page.id, page.hash])));
}

function applyComicInfo(pages: ComicPage[], info: ComicInfo | null): void {
  if (!info) return;
  for (const entry of info.pages) {
    const page = pages[entry.image];
    if (!page) continue;
    if (entry.doublePage !== undefined) page.spread = entry.doublePage;
  }
}

function cleanInfo(info: ComicInfo | null): ComicManifest["info"] | undefined {
  if (!info) return undefined;
  const { pages: _pages, direction: _direction, language: _language, genre: _genre, ...rest } = info;
  return Object.keys(rest).length ? rest : undefined;
}

function assertPageCount(count: number, max: number): void {
  if (count === 0) throw new MangaError("UNSUPPORTED_FORMAT", "no readable pages were found");
  if (count > max) throw new MangaError("UNSUPPORTED_FORMAT", `the source has ${count} pages, more than the ${max} allowed`);
}

/** Pages are the images directly inside `dir`. Sub-folders are separate chapters and are planned by `planDirectory`. */
export async function scanComicDirectory(dir: string, options: ScanOptions): Promise<ScanResult> {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new MangaError("NOT_FOUND", "comic folder is not available");
  const names = fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isImageName(entry.name) && !isIgnoredName(entry.name))
    .map((entry) => entry.name)
    .sort(naturalCompare);
  assertPageCount(names.length, options.maxPages ?? MAX_PAGES);
  const candidates: Candidate[] = names.map((name) => ({ id: name, name, ref: { kind: "file", relativePath: name }, load: { path: path.join(dir, name) } }));
  const pages = await describePages(candidates, options);
  let info: ComicInfo | null = null;
  const infoFile = fs.readdirSync(dir).find((name) => name.toLowerCase() === "comicinfo.xml");
  if (infoFile) {
    try { info = parseComicInfo(fs.readFileSync(path.join(dir, infoFile)).subarray(0, 1024 * 1024)); } catch { info = null; }
  }
  applyComicInfo(pages, info);
  const warnings = pages.filter((page) => !page.ok).map((page) => `page ${page.name} could not be read`);
  return {
    source: "dir",
    title: info?.series ?? info?.title ?? path.basename(dir),
    fingerprint: fingerprintOf(pages),
    manifest: { source: "dir", pages, ...(info?.direction ? { direction: info.direction } : {}), ...(cleanInfo(info) ? { info: cleanInfo(info) } : {}), warnings },
  };
}

export async function scanCbz(file: string, options: ScanOptions): Promise<ScanResult> {
  const index = await options.zips.index(file, options.signal);
  const warnings: string[] = [];
  const unsafe = index.entries.filter((entry) => entry.unsafe);
  if (unsafe.length) warnings.push(`${unsafe.length} archive entries with unsafe names were skipped`);
  const imageEntries = index.entries.filter((entry) => !entry.directory && !entry.unsafe && isImageName(entry.name) && !isIgnoredName(entry.name));
  if (imageEntries.some((entry) => entry.encrypted)) throw new MangaError("UNSUPPORTED_FORMAT", "the archive is encrypted and cannot be read");
  imageEntries.sort((a, b) => comparePaths(a.name, b.name));
  assertPageCount(imageEntries.length, options.maxPages ?? MAX_PAGES);
  const candidates: Candidate[] = imageEntries.map((entry) => ({
    id: entry.name, name: entry.name.split("/").pop() ?? entry.name, ref: { kind: "zip", entry: entry.name },
    load: { bytes: () => options.zips.read(file, entry.name, { signal: options.signal }) }, bytes: entry.uncompressedSize,
  }));
  const pages = await describePages(candidates, options);
  let info: ComicInfo | null = null;
  const infoEntry = index.entries.find((entry) => !entry.unsafe && !entry.directory && /(^|\/)comicinfo\.xml$/i.test(entry.name) && !entry.encrypted);
  if (infoEntry && infoEntry.uncompressedSize < 1024 * 1024) {
    try { info = parseComicInfo(await options.zips.read(file, infoEntry.name, { maxBytes: 1024 * 1024, signal: options.signal })); } catch { info = null; }
  }
  applyComicInfo(pages, info);
  warnings.push(...pages.filter((page) => !page.ok).map((page) => `page ${page.name} could not be read`));
  return {
    source: "cbz",
    title: info?.series ?? info?.title ?? path.basename(file).replace(/\.[^.]+$/, ""),
    fingerprint: fingerprintOf(pages),
    manifest: { source: "cbz", pages, ...(info?.direction ? { direction: info.direction } : {}), ...(cleanInfo(info) ? { info: cleanInfo(info) } : {}), warnings },
  };
}

type Attrs = Record<string, string>;
function tagsOf(xml: string, name: string): Attrs[] {
  const out: Attrs[] = [];
  for (const match of xml.matchAll(new RegExp(`<(?:[\\w-]+:)?${name}\\b([^>]*?)/?>`, "gi"))) {
    const attrs: Attrs = {};
    for (const attr of match[1]!.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[attr[1]!.toLowerCase()] = attr[2] ?? attr[3] ?? "";
    out.push(attrs);
  }
  return out;
}

/** An EPUB whose spine is a sequence of pages, each of which is (or only shows) one image. */
export async function scanComicEpub(file: string, options: ScanOptions): Promise<ScanResult> {
  const index = await options.zips.index(file, options.signal);
  if (index.entries.some((entry) => entry.name.toLowerCase() === "meta-inf/encryption.xml")) throw new MangaError("UNSUPPORTED_FORMAT", "encrypted epub rejected");
  const read = async (name: string) => (await options.zips.read(file, name, { maxBytes: 8 * 1024 * 1024, signal: options.signal })).toString("utf8");
  if (!index.byName.has("META-INF/container.xml")) throw new MangaError("UNSUPPORTED_FORMAT", "missing container.xml");
  const opfPath = tagsOf(await read("META-INF/container.xml"), "rootfile")[0]?.["full-path"];
  if (!opfPath || !index.byName.has(opfPath)) throw new MangaError("UNSUPPORTED_FORMAT", "missing opf");
  const opf = await read(opfPath);
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const items = new Map(tagsOf(opf, "item").map((item) => [item.id ?? "", item]));
  const spine = tagsOf(opf, "itemref").map((item) => item.idref ?? "").filter(Boolean);
  const direction = /page-progression-direction\s*=\s*["']rtl["']/i.test(opf) ? "rtl" as const : undefined;
  const title = /<dc:title[^>]*>([^<]*)<\/dc:title>/i.exec(opf)?.[1]?.trim() || path.basename(file).replace(/\.[^.]+$/, "");
  const seen = new Set<string>();
  const ordered: string[] = [];
  const addImage = (name: string | undefined) => {
    if (!name || seen.has(name)) return;
    const info = index.byName.get(name);
    if (!info || info.directory || info.unsafe || !isImageName(name)) return;
    if (info.encrypted) throw new MangaError("UNSUPPORTED_FORMAT", "the archive is encrypted and cannot be read");
    seen.add(name);
    ordered.push(name);
  };
  for (const idref of spine) {
    const item = items.get(idref);
    if (!item?.href) continue;
    const href = resolveArchiveReference(base, item.href);
    if (!href) continue;
    if ((item["media-type"] ?? "").startsWith("image/")) { addImage(href); continue; }
    if (!index.byName.has(href)) continue;
    const dir = href.includes("/") ? href.slice(0, href.lastIndexOf("/") + 1) : "";
    const html = await read(href);
    const refs = [...htmlImageSources(html), ...htmlSvgImageHrefs(html)];
    for (const reference of refs) addImage(resolveArchiveReference(dir, reference) ?? undefined);
  }
  assertPageCount(ordered.length, options.maxPages ?? MAX_PAGES);
  const candidates: Candidate[] = ordered.map((name) => ({
    id: name, name: name.split("/").pop() ?? name, ref: { kind: "epub", entry: name },
    load: { bytes: () => options.zips.read(file, name, { signal: options.signal }) },
  }));
  const pages = await describePages(candidates, options);
  return {
    source: "epub",
    title,
    fingerprint: fingerprintOf(pages),
    manifest: { source: "epub", pages, ...(direction ? { direction } : {}), warnings: pages.filter((page) => !page.ok).map((page) => `page ${page.name} could not be read`) },
  };
}

function magicType(data: Uint8Array): string | null {
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "image/gif";
  if (data.length >= 12 && String.fromCharCode(...data.subarray(0, 4)) === "RIFF" && String.fromCharCode(...data.subarray(8, 12)) === "WEBP") return "image/webp";
  return null;
}

export type MobiImageRecord = { recordIndex: number; offset: number; length: number; mediaType: string };

/** Random access to the bytes of a MOBI: the whole file is never held, only the records that are asked for. */
export type MobiReader = { size: number; read(offset: number, length: number): Buffer };

export function bufferReader(bytes: Buffer): MobiReader {
  return { size: bytes.length, read: (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)) };
}

export function fileReader(file: string): { reader: MobiReader; close(): void } {
  const fd = fs.openSync(file, "r");
  const size = fs.fstatSync(fd).size;
  return {
    reader: {
      size,
      read(offset, length) {
        const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
        let done = 0;
        while (done < buffer.length) {
          const got = fs.readSync(fd, buffer, done, buffer.length - done, offset + done);
          if (got === 0) break;
          done += got;
        }
        return done === buffer.length ? buffer : buffer.subarray(0, done);
      },
    },
    close: () => fs.closeSync(fd),
  };
}

const MOBI_TEXT_BUDGET = 64 * 1024 * 1024;

export type MobiTable = { title: string; textLength: number; records: MobiImageRecord[] };

/** Image records of a MOBI in the order the book's own markup shows them, then any left over in record order. */
export function mobiRecordTable(reader: MobiReader): MobiTable {
  const head = reader.read(0, 78);
  if (reader.size < 86 || head.length < 78 || head.toString("latin1", 60, 68) !== "BOOKMOBI") throw new MangaError("UNSUPPORTED_FORMAT", "not a mobi palm database");
  const count = head.readUInt16BE(76);
  if (count < 2 || 78 + count * 8 > reader.size) throw new MangaError("UNSUPPORTED_FORMAT", "mobi records are truncated");
  const table = reader.read(78, count * 8);
  const offsets: number[] = [];
  for (let i = 0; i < count; i += 1) offsets.push(table.readUInt32BE(i * 8));
  offsets.push(reader.size);
  if (offsets.some((offset, i) => i > 0 && offset < offsets[i - 1]!) || offsets[count - 1]! > reader.size) throw new MangaError("UNSUPPORTED_FORMAT", "mobi records are out of order");
  const r0 = reader.read(offsets[0]!, Math.min(offsets[1]! - offsets[0]!, 1024 * 1024));
  if (r0.length < 16) throw new MangaError("UNSUPPORTED_FORMAT", "mobi header is truncated");
  const compression = r0.readUInt16BE(0);
  const textLength = r0.readUInt32BE(4);
  const textRecords = r0.readUInt16BE(8);
  if (r0.readUInt16BE(12) !== 0) throw new MangaError("UNSUPPORTED_FORMAT", "encrypted mobi rejected");
  let title = "";
  let firstImage = textRecords + 1;
  if (r0.length >= 16 + 0x70 && r0.toString("latin1", 16, 20) === "MOBI") {
    const nameOffset = r0.readUInt32BE(16 + 84);
    const nameLength = r0.readUInt32BE(16 + 88);
    if (nameLength > 0 && nameLength < 1024 && nameOffset + nameLength <= r0.length) title = r0.toString("utf8", nameOffset, nameOffset + nameLength).replaceAll("\u0000", "");
    const candidate = r0.readUInt32BE(16 + 0x6c);
    if (candidate > textRecords && candidate < count) firstImage = candidate;
  }
  const all: MobiImageRecord[] = [];
  for (let i = firstImage; i < count; i += 1) {
    const start = offsets[i]!;
    const end = offsets[i + 1]!;
    if (end <= start) continue;
    const type = magicType(reader.read(start, Math.min(end - start, 16)));
    if (type) all.push({ recordIndex: i, offset: start, length: end - start, mediaType: type });
  }
  // The markup names images by their position among the image records (`recindex`, 1-based).
  const order: number[] = [];
  try {
    const chunks: Buffer[] = [];
    let budget = MOBI_TEXT_BUDGET;
    for (let i = 1; i <= textRecords && i < count; i += 1) {
      const record = reader.read(offsets[i]!, offsets[i + 1]! - offsets[i]!);
      budget -= record.length;
      if (budget < 0) break;
      chunks.push(compression === 2 ? Buffer.from(palmdocDecompress(record)) : record);
    }
    const markup = Buffer.concat(chunks).toString("latin1");
    for (const match of markup.matchAll(/recindex\s*=\s*["']?(\d+)/gi)) {
      const record = firstImage + Number(match[1]) - 1;
      if (!order.includes(record)) order.push(record);
    }
  } catch { /* record order is the fallback */ }
  const byRecord = new Map(all.map((item) => [item.recordIndex, item]));
  const ordered: MobiImageRecord[] = [];
  for (const record of order) { const item = byRecord.get(record); if (item) { ordered.push(item); byRecord.delete(record); } }
  ordered.push(...byRecord.values());
  return { title, textLength, records: ordered };
}

export function mobiImageRecords(bytes: Buffer): { title: string; records: MobiImageRecord[] } {
  const { title, records } = mobiRecordTable(bufferReader(bytes));
  return { title, records };
}

/** The record table of a MOBI on disk, read without loading the file. */
export function mobiTableOfFile(file: string): MobiTable {
  const { reader, close } = fileReader(file);
  try { return mobiRecordTable(reader); } finally { close(); }
}

/** Read one record of a MOBI file. */
export function readMobiRecord(file: string, offset: number, length: number): Buffer {
  const { reader, close } = fileReader(file);
  try { return Buffer.from(reader.read(offset, length)); } finally { close(); }
}

export async function scanComicMobi(file: string, options: ScanOptions): Promise<ScanResult> {
  const stat = fs.statSync(file);
  if (stat.size > 2 * 1024 * 1024 * 1024) throw new MangaError("UNSUPPORTED_FORMAT", "the file is larger than the read budget");
  const { title, records } = mobiTableOfFile(file);
  assertPageCount(records.length, options.maxPages ?? MAX_PAGES);
  const candidates: Candidate[] = records.map((record, index) => ({
    id: `rec${record.recordIndex}`, name: `${String(index + 1).padStart(4, "0")}`, ref: { kind: "mobi", recordIndex: record.recordIndex },
    load: { bytes: async () => readMobiRecord(file, record.offset, record.length) },
  }));
  const pages = await describePages(candidates, options);
  return {
    source: "mobi",
    title: title || path.basename(file).replace(/\.[^.]+$/, ""),
    fingerprint: fingerprintOf(pages),
    manifest: { source: "mobi", pages, warnings: pages.filter((page) => !page.ok).map((page) => `page ${page.name} could not be read`) },
  };
}

/** Page sizes of a PDF whose pages are the pictures. Rendering stays with PDF.js in the reader. */
export async function scanComicPdf(file: string, options: ScanOptions & { pdfPages: (source: { file: string }, signal?: AbortSignal) => Promise<Array<{ width: number; height: number }>> }): Promise<ScanResult> {
  const stat = fs.statSync(file);
  if (stat.size > 4 * 1024 * 1024 * 1024) throw new MangaError("UNSUPPORTED_FORMAT", "the file is larger than the read budget");
  // PDF.js reads the page tree in ranges; the file is streamed once for its fingerprint and never held whole.
  const sizes = await options.pdfPages({ file }, options.signal);
  assertPageCount(sizes.length, options.maxPages ?? MAX_PAGES);
  const fingerprint = await hashFile(file, options.signal);
  const pages: ComicPage[] = sizes.map((size, index) => ({
    id: `page-${index + 1}`, index, name: String(index + 1).padStart(4, "0"),
    width: Math.round(size.width), height: Math.round(size.height), hash: sha(`${fingerprint}:${index + 1}`), ok: true,
    spread: size.width > size.height * 1.2, ref: { kind: "pdf", pageNumber: index + 1 },
  }));
  return {
    source: "pdf",
    title: path.basename(file).replace(/\.[^.]+$/, ""),
    fingerprint,
    manifest: { source: "pdf", pages, warnings: [] },
  };
}

export type DirectoryItem = {
  /** Absolute path of the folder, archive, document or video. */
  path: string;
  type: "image-dir" | "archive" | "document" | "video";
  /** Path below the chosen root, with forward slashes. */
  relative: string;
  name: string;
  imageCount?: number;
};

/**
 * What a chosen folder contains: every folder that directly holds images is one chapter, every archive or document is one
 * volume, every video file is one episode. Order is natural order of the relative path.
 */
export function planDirectory(root: string, kind: "comic" | "video" | "novel", limits = { maxItems: 2000, maxDepth: 8 }): { items: DirectoryItem[]; truncated: boolean } {
  const items: DirectoryItem[] = [];
  let truncated = false;
  const walk = (dir: string, relative: string, depth: number) => {
    if (truncated) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => naturalCompare(a.name, b.name));
    let images = 0;
    for (const entry of entries) {
      if (isIgnoredName(entry.name)) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        const found = classifyFile(kind, entry.name, full, rel);
        if (found === "image") images += 1;
        else if (found) items.push(found);
      } else if (entry.isDirectory() && depth < limits.maxDepth) {
        walk(full, rel, depth + 1);
      }
      if (items.length >= limits.maxItems) { truncated = true; return; }
    }
    if (kind === "comic" && images > 0) items.push({ path: dir, type: "image-dir", relative: relative || ".", name: path.basename(dir), imageCount: images });
  };
  walk(root, "", 0);
  items.sort((a, b) => comparePaths(a.relative, b.relative));
  return { items, truncated };
}

/** What one file is to a folder import of this kind: a page of the folder's chapter, one volume or episode of its own, or nothing. */
function classifyFile(kind: "comic" | "video" | "novel", name: string, full: string, rel: string): "image" | DirectoryItem | null {
  const ext = path.extname(name).toLowerCase();
  if (kind === "comic" && isImageName(name)) return "image";
  if (kind === "comic" && ARCHIVE_EXTENSIONS.has(ext)) return { path: full, type: "archive", relative: rel, name };
  if (kind === "comic" && DOCUMENT_EXTENSIONS.has(ext)) return { path: full, type: "document", relative: rel, name };
  if (kind === "novel" && NOVEL_EXTENSIONS.has(ext)) return { path: full, type: "document", relative: rel, name };
  if (kind === "video" && VIDEO_EXTENSIONS.has(ext)) return { path: full, type: "video", relative: rel, name };
  return null;
}

/**
 * The same plan as `planDirectory`, read without holding the main thread: each folder is read asynchronously, so a large or slow
 * drive does not stop the interface. `kinds` plans several kinds in one walk (the import dialog asks for all three); `progress` is told
 * how many folders have been read.
 */
export async function planDirectoryAsync<K extends "comic" | "video" | "novel">(root: string, kinds: readonly K[], options: { limits?: { maxItems: number; maxDepth: number }; signal?: AbortSignal; progress?: (folders: number, items: number) => void } = {}): Promise<Record<K, { items: DirectoryItem[]; truncated: boolean }>> {
  const limits = options.limits ?? { maxItems: 2000, maxDepth: 8 };
  const state = Object.fromEntries(kinds.map((kind) => [kind, { items: [] as DirectoryItem[], truncated: false }])) as Record<K, { items: DirectoryItem[]; truncated: boolean }>;
  let folders = 0;
  let lastReport = 0;
  const walk = async (dir: string, relative: string, depth: number): Promise<void> => {
    if (kinds.every((kind) => state[kind].truncated)) return;
    options.signal?.throwIfAborted();
    let entries: fs.Dirent[];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    folders += 1;
    const now = Date.now();
    if (options.progress && now - lastReport >= 200) { lastReport = now; options.progress(folders, Math.max(...kinds.map((kind) => state[kind].items.length))); }
    entries.sort((a, b) => naturalCompare(a.name, b.name));
    const images = Object.fromEntries(kinds.map((kind) => [kind, 0])) as Record<K, number>;
    for (const entry of entries) {
      if (isIgnoredName(entry.name)) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        for (const kind of kinds) {
          if (state[kind].truncated) continue;
          const found = classifyFile(kind, entry.name, full, rel);
          if (found === "image") images[kind] += 1;
          else if (found) state[kind].items.push(found);
        }
      } else if (entry.isDirectory() && depth < limits.maxDepth) {
        await walk(full, rel, depth + 1);
      }
      for (const kind of kinds) if (state[kind].items.length >= limits.maxItems) state[kind].truncated = true;
      if (kinds.every((kind) => state[kind].truncated)) return;
    }
    for (const kind of kinds) if (kind === "comic" && images[kind] > 0 && !state[kind].truncated) state[kind].items.push({ path: dir, type: "image-dir", relative: relative || ".", name: path.basename(dir), imageCount: images[kind] });
  };
  await walk(root, "", 0);
  for (const kind of kinds) state[kind].items.sort((a, b) => comparePaths(a.relative, b.relative));
  return state;
}
