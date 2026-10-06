import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MangaError, createId } from "@manga/contracts";
import type { ComicManifest, ComicPage, MediaHandleInfo, Ordinal } from "@manga/contracts";
import { suggestKind, type KindSuggestion } from "./suggest.ts";
import type { DrizzleStore, Mutation } from "@manga/storage-drizzle";
import { layoutFromPayload } from "../domain/revision-layout.ts";
import { ordinalFromParsed, ordinalLabel, parseOrdinalName, sortKeyFor } from "../domain/ordinal.ts";
import { readPdfPageSizes, renderPdfPage } from "../domain/pdfjs-document.ts";
import { makeThumbnail, type ThumbnailResult } from "../media/thumbnails.ts";
import type { MediaServices } from "../media/services.ts";
import {
  BROWSER_IMAGE_TYPES, fingerprintFile, mediaTypeForName, mobiTableOfFile, planDirectoryAsync, type MobiTable,
  scanCbz, scanComicDirectory, scanComicEpub, scanComicMobi, scanComicPdf, type DirectoryItem, type ScanOptions, type ScanResult,
} from "./scan.ts";

export const COMIC_PARSER_ID = "comic-scan-v1";
const PAGE_TTL_MS = 30 * 60_000;
const DISPLAY_EDGE = 4096;
const DISPLAY_PIXELS = 24_000_000;
const STRIP_RATIO = 3;
const COMIC_MODULE = "manga.comic";

export type InspectResult =
  | { entry: "file"; name: string; bytes: number; suggestion: KindSuggestion }
  | { entry: "directory"; name: string; suggestion: KindSuggestion; counts: { comic: number; video: number; novel: number }; truncated: boolean; items: Array<{ relative: string; type: string; imageCount?: number }> };

export type ComicImportResult = {
  resourceId: string;
  workId: string;
  revisionId: string;
  title: string;
  ordinalLabel: string | null;
  pages: number;
  source: ComicManifest["source"];
  duplicate: boolean;
  replaced: boolean;
  unreadablePages: number;
  warnings: string[];
};

type Location = { path: string; hosted: boolean; available: boolean };

export function detectComicSource(file: string): "dir" | "cbz" | "pdf" | "epub" | "mobi" {
  const stat = fs.statSync(file);
  if (stat.isDirectory()) return "dir";
  const ext = path.extname(file).toLowerCase();
  if (ext === ".cbz" || ext === ".zip") return "cbz";
  if (ext === ".pdf") return "pdf";
  if (ext === ".epub") return "epub";
  if (ext === ".mobi" || ext === ".azw3") return "mobi";
  const head = Buffer.alloc(68);
  const fd = fs.openSync(file, "r");
  try { fs.readSync(fd, head, 0, 68, 0); } finally { fs.closeSync(fd); }
  if (head.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  if (head.toString("latin1", 60, 68) === "BOOKMOBI") return "mobi";
  if (head[0] === 0x50 && head[1] === 0x4b) return "cbz";
  throw new MangaError("UNSUPPORTED_FORMAT", "this file cannot be opened as a comic");
}

export class ComicService {
  private readonly store: DrizzleStore;
  private readonly media: MediaServices;

  constructor(store: DrizzleStore, media: MediaServices) {
    this.store = store;
    this.media = media;
  }

  async scan(sourcePath: string, options: Omit<ScanOptions, "zips"> = {}): Promise<ScanResult> {
    if (!fs.existsSync(sourcePath)) throw new MangaError("NOT_FOUND", "the comic is not available");
    const opts: ScanOptions = { ...options, zips: this.media.zips };
    switch (detectComicSource(sourcePath)) {
      case "dir": return scanComicDirectory(sourcePath, opts);
      case "cbz": return scanCbz(sourcePath, opts);
      case "epub": return scanComicEpub(sourcePath, opts);
      case "mobi": return scanComicMobi(sourcePath, opts);
      case "pdf": return scanComicPdf(sourcePath, { ...opts, pdfPages: readPdfPageSizes });
    }
  }

  /**
   * Write one comic as a new resource (or a new revision of the resource that already lives at this path). Returns
   * `duplicate` when the same content is already imported from the same place.
   */
  async persist(input: {
    scan: ScanResult;
    title?: string;
    /** Name of the work when this call creates it; defaults to the resource title. */
    workTitle?: string;
    sourcePath: string;
    hosted?: boolean;
    workId?: string;
    ordinal?: Ordinal;
    /** Explicit position inside the work, for nested folder layouts where the numbers repeat. */
    sortKey?: string;
    receipt?: { idempotencyKey: string; commandId: string };
    now?: string;
  }): Promise<ComicImportResult> {
    const { scan, sourcePath } = input;
    const now = input.now ?? new Date().toISOString();
    const findExisting = () => this.store.sqlite.prepare(`SELECT r.id AS resourceId, r.work_id AS workId, r.title AS title, r.ordinal_label AS ordinalLabel, v.id AS revisionId, v.fingerprint AS fingerprint
      FROM file_locations fl JOIN resource_revisions v ON v.id = fl.resource_revision_id JOIN resources r ON r.id = v.resource_id
      WHERE fl.relative_path = ? ORDER BY v.created_at DESC LIMIT 1`).get(sourcePath) as { resourceId: string; workId: string; title: string; ordinalLabel: string | null; revisionId: string; fingerprint: string } | undefined;
    let existing = findExisting();
    const summary = (extra: Partial<ComicImportResult>): ComicImportResult => ({
      resourceId: "", workId: "", revisionId: "", title: "", ordinalLabel: null, pages: scan.manifest.pages.length, source: scan.source,
      duplicate: false, replaced: false, unreadablePages: scan.manifest.pages.filter((page) => !page.ok).length, warnings: scan.manifest.warnings, ...extra,
    });
    if (existing && existing.fingerprint === scan.fingerprint) {
      const result = summary({ resourceId: existing.resourceId, workId: existing.workId, revisionId: existing.revisionId, title: existing.title, ordinalLabel: existing.ordinalLabel, duplicate: true });
      if (input.receipt) this.store.commit({ mutations: [], events: [], idempotencyKey: input.receipt.idempotencyKey, commandId: input.receipt.commandId, result });
      return result;
    }
    if (input.hosted && scan.source === "dir") throw new MangaError("VALIDATION_ERROR", "a folder cannot be copied into the library; import it in place");
    const revisionId = createId("rev");
    const title = (input.title ?? scan.title).trim() || scan.title;
    const mutations: Mutation[] = [];
    let resourceId = existing?.resourceId;
    let workId = existing?.workId ?? input.workId;
    let ordinal = input.ordinal ? { ...input.ordinal, label: ordinalLabel(input.ordinal) } : undefined;
    if (!resourceId) {
      resourceId = createId("res");
      if (!workId) {
        workId = createId("work");
        mutations.push({ sql: "INSERT INTO works(id,title,created_at,media_kind,updated_at) VALUES (?,?,?,?,?)", params: [workId, (input.workTitle ?? title).trim() || title, now, "comic", now] });
      } else if (!this.store.sqlite.prepare("SELECT id FROM works WHERE id = ?").get(workId)) {
        throw new MangaError("NOT_FOUND", "work missing");
      }
      mutations.push({
        sql: "INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at, ordinal_label, ordinal_number, ordinal_type, sort_key) VALUES (?,?,?,?,?,?,?,?,?,?)",
        params: [resourceId, workId, "comic", title, JSON.stringify([title]), now, ordinal?.label ?? null, ordinal?.number ?? null, ordinal?.type ?? null, input.sortKey ?? sortKeyFor(ordinal, title)],
      });
      mutations.push({
        sql: "UPDATE works SET updated_at = ?, media_kind = COALESCE((SELECT r.kind FROM resources r WHERE r.work_id = works.id ORDER BY r.sort_key, r.created_at, r.id LIMIT 1), media_kind) WHERE id = ?",
        params: [now, workId],
      });
      mutations.push(...this.store.indexFragment({ id: createId("frag"), resourceId, kind: "title", text: title }));
    } else {
      ordinal = undefined;
    }
    const payload = {
      id: revisionId,
      format: `comic-${scan.source}`,
      parserId: COMIC_PARSER_ID,
      parts: [] as Array<{ id?: string }>,
      toc: [] as unknown[],
      traits: { pages: scan.manifest.pages.length, source: scan.source, unreadable: scan.manifest.pages.filter((page) => !page.ok).length },
      warnings: scan.manifest.warnings,
      comic: scan.manifest,
    };
    let locationPath = sourcePath;
    let staged: string | undefined;
    if (input.hosted) {
      locationPath = path.join(this.store.attachmentsDir, `${revisionId}.bin`);
      await fsp.mkdir(this.store.attachmentsDir, { recursive: true });
      staged = `${locationPath}.part`;
      // A large archive is copied without holding the main thread; nothing below waits again until the rows are committed.
      await fsp.copyFile(sourcePath, staged);
      const raced = findExisting();
      if (raced && raced.fingerprint === scan.fingerprint && raced.resourceId !== existing?.resourceId) {
        fs.rmSync(staged, { force: true });
        return summary({ resourceId: raced.resourceId, workId: raced.workId, revisionId: raced.revisionId, title: raced.title, ordinalLabel: raced.ordinalLabel, duplicate: true });
      }
      existing = raced;
    }
    mutations.push({
      sql: "INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at, layout_json) VALUES (?,?,?,?,?,?,?)",
      params: [revisionId, resourceId, scan.fingerprint, COMIC_PARSER_ID, JSON.stringify(payload), now, JSON.stringify(layoutFromPayload(payload))],
    });
    mutations.push({
      sql: "INSERT INTO file_locations(id, resource_revision_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,1,?)",
      params: [createId("loc"), revisionId, locationPath, scan.fingerprint, input.hosted ? 1 : 0],
    });
    const result = summary({ resourceId, workId: workId!, revisionId, title, ordinalLabel: ordinal?.label ?? null, replaced: Boolean(existing) });
    try {
      if (staged) fs.renameSync(staged, locationPath);
      this.store.commit({
        mutations,
        events: [{ type: "resource.imported", payload: { resourceId, revisionId, format: payload.format } }],
        ...(input.receipt ? { idempotencyKey: input.receipt.idempotencyKey, commandId: input.receipt.commandId, result } : {}),
      });
    } catch (error) {
      if (staged) fs.rmSync(staged, { force: true });
      if (input.hosted) fs.rmSync(locationPath, { force: true });
      throw error;
    }
    return result;
  }

  async importOne(input: { sourcePath: string; title?: string; hosted?: boolean; workId?: string; ordinal?: Ordinal; signal?: AbortSignal; progress?: ScanOptions["progress"]; receipt?: { idempotencyKey: string; commandId: string } }): Promise<ComicImportResult> {
    const scan = await this.scan(input.sourcePath, { signal: input.signal, progress: input.progress });
    input.signal?.throwIfAborted();
    const name = path.basename(input.sourcePath);
    const parsed = input.ordinal ? undefined : ordinalFromParsed(parseOrdinalName(name, "comic"));
    return await this.persist({ scan, title: input.title, sourcePath: input.sourcePath, hosted: input.hosted, workId: input.workId, ordinal: input.ordinal ?? parsed, receipt: input.receipt });
  }

  /** Import every chapter folder, archive and document below `root` as the resources of one work, in natural order. */
  async importDirectory(input: {
    root: string;
    title?: string;
    workId?: string;
    hosted?: boolean;
    signal?: AbortSignal;
    progress?: (done: number, total: number, label: string) => void;
    receipt?: { idempotencyKey: string; commandId: string };
  }): Promise<{ workId: string; resources: Array<ComicImportResult | { relative: string; error: { code: string; message: string } }>; truncated: boolean }> {
    if (!(await fsp.stat(input.root).catch(() => null))?.isDirectory()) throw new MangaError("NOT_FOUND", "the folder is not available");
    const plan = (await planDirectoryAsync(input.root, ["comic"], { signal: input.signal })).comic;
    if (!plan.items.length) throw new MangaError("UNSUPPORTED_FORMAT", "the folder holds no images, archives or documents to read as comics");
    const results: Array<ComicImportResult | { relative: string; error: { code: string; message: string } }> = [];
    let workId = input.workId;
    // A folder that is itself a single chapter becomes one resource named after the folder.
    const single = plan.items.length === 1 && plan.items[0]!.type === "image-dir" && plan.items[0]!.relative === ".";
    // Folders inside folders (volume/chapter) repeat their numbers, so their order comes from the walk, not from the numbers.
    const nested = plan.items.some((item) => item.relative.includes("/"));
    let done = 0;
    for (const item of plan.items) {
      input.signal?.throwIfAborted();
      input.progress?.(done, plan.items.length, item.relative);
      try {
        const result = await this.importItem(item, { workId, workTitle: input.title ?? path.basename(input.root), single, nested, index: done, hosted: input.hosted && item.type !== "image-dir", signal: input.signal, root: input.root });
        workId ??= result.workId;
        results.push(result);
      } catch (error) {
        if (error instanceof MangaError && error.code === "CANCELLED") throw error;
        if (input.signal?.aborted) throw new MangaError("CANCELLED", "import was cancelled");
        const known = error instanceof MangaError ? { code: error.code, message: error.message } : { code: "UNSUPPORTED_FORMAT", message: error instanceof Error ? error.message : String(error) };
        results.push({ relative: item.relative, error: known });
      }
      done += 1;
    }
    input.progress?.(done, plan.items.length, "");
    if (!workId) throw new MangaError("UNSUPPORTED_FORMAT", "none of the items in the folder could be read as a comic", { details: { failures: results.length } });
    const value = { workId, resources: results, truncated: plan.truncated };
    if (input.receipt) this.store.commit({ mutations: [], events: [], idempotencyKey: input.receipt.idempotencyKey, commandId: input.receipt.commandId, result: value });
    return value;
  }

  /** One planned chapter, archive or document, named and ordered by where it sits below `context.root`; the folder import and the library scan share this. */
  async importItem(item: DirectoryItem, context: { workId?: string; workTitle: string; single: boolean; nested: boolean; index: number; hosted?: boolean; signal?: AbortSignal; root: string }): Promise<ComicImportResult> {
    const scan = await this.scan(item.path, { signal: context.signal });
    const segments = (item.relative === "." ? [path.basename(context.root)] : item.relative.split("/")).map((segment, at, all) => (at === all.length - 1 && item.type !== "image-dir" ? segment.replace(/\.[^.]+$/, "") : segment));
    const parsed = segments.map((segment) => ordinalFromParsed(parseOrdinalName(segment, "comic")));
    const innermost = parsed.at(-1);
    let ordinal: Ordinal | undefined = innermost;
    if (context.nested && innermost) {
      // "第 1 卷 · 第 2 话": every level that names itself contributes to the label; the innermost gives type and number.
      const labels = parsed.map((entry) => entry?.label).filter((label): label is string => Boolean(label));
      ordinal = { ...innermost, label: labels.join(" · ").slice(0, 64) };
    }
    const title = context.single
      ? context.workTitle
      : item.type === "image-dir"
        ? (item.relative === "." ? context.workTitle : item.relative.replaceAll("/", " / "))
        : item.relative.replace(/\.[^./]+$/, "").replaceAll("/", " / ");
    const sortKey = context.nested ? `1|${String(context.index).padStart(12, "0")}|${title.toLowerCase()}` : undefined;
    // The first imported resource creates the work and names it after the folder; later ones join it.
    return await this.persist({ scan, title, workTitle: context.workTitle, sourcePath: item.path, hosted: context.hosted, workId: context.workId, ordinal, sortKey });
  }

  // ------------------------------------------------------------------ reading

  private location(revisionId: string): Location | null {
    const row = this.store.sqlite.prepare("SELECT relative_path, available, hosted FROM file_locations WHERE resource_revision_id = ? ORDER BY rowid DESC LIMIT 1").get(revisionId) as { relative_path: string; available: number; hosted: number } | undefined;
    if (!row) return null;
    const exists = fs.existsSync(row.relative_path);
    if (!exists && row.available === 1) this.store.sqlite.prepare("UPDATE file_locations SET available = 0 WHERE resource_revision_id = ?").run(revisionId);
    if (exists && row.available === 0) this.store.sqlite.prepare("UPDATE file_locations SET available = 1 WHERE resource_revision_id = ?").run(revisionId);
    return { path: row.relative_path, hosted: row.hosted === 1, available: exists };
  }

  loadManifest(resourceId: string, revisionId?: string): { revisionId: string; manifest: ComicManifest; title: string } {
    const row = (revisionId
      ? this.store.sqlite.prepare("SELECT r.title AS title, v.id AS revisionId, v.payload_json AS payload FROM resources r JOIN resource_revisions v ON v.id = ? AND v.resource_id = r.id WHERE r.id = ?").get(revisionId, resourceId)
      : this.store.sqlite.prepare("SELECT r.title AS title, v.id AS revisionId, v.payload_json AS payload FROM resources r JOIN resource_revisions v ON v.resource_id = r.id WHERE r.id = ? ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1").get(resourceId)) as { title: string; revisionId: string; payload: string } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "resource missing");
    const payload = JSON.parse(row.payload) as { comic?: ComicManifest };
    if (!payload.comic) throw new MangaError("UNSUPPORTED_FORMAT", "this resource is not a comic");
    return { revisionId: row.revisionId, manifest: payload.comic, title: row.title };
  }

  /**
   * A page as an image for covers and for image materials, optionally cropped to a region given as fractions of the original
   * page. Image pages are scaled by sharp; PDF pages are painted by PDF.js. The result is a copy: nothing is written.
   */
  async pageImage(input: { resourceId: string; revisionId?: string; pageId?: string; maxEdge: number; region?: { x: number; y: number; width: number; height: number }; format?: "webp" | "jpeg" | "png"; signal?: AbortSignal }): Promise<ThumbnailResult & { pageId: string }> {
    const { revisionId, manifest } = this.loadManifest(input.resourceId, input.revisionId);
    const page = input.pageId ? manifest.pages.find((item) => item.id === input.pageId) : manifest.pages.find((item) => item.ok);
    if (!page) throw new MangaError("NOT_FOUND", input.pageId ? "page is not in this revision" : "the comic has no readable page");
    if (!page.ok) throw new MangaError("UNSUPPORTED_FORMAT", page.error ?? "page could not be read");
    const location = this.location(revisionId);
    if (!location?.available) throw new MangaError("NOT_FOUND", "the original file is not available");
    const source = this.pageFile(location, manifest, page);
    const format = input.format ?? "webp";
    if (source.kind === "pdf") {
      const painted = await renderPdfPage({ file: source.path }, source.pageNumber, { maxEdge: input.maxEdge, region: input.region, signal: input.signal });
      if (format === "png") return { bytes: painted.png, width: painted.width, height: painted.height, mediaType: "image/png", sourceWidth: page.width, sourceHeight: page.height, pageId: page.id };
      const result = await makeThumbnail(painted.png, { maxEdge: input.maxEdge, format, signal: input.signal });
      return { ...result, sourceWidth: page.width, sourceHeight: page.height, pageId: page.id };
    }
    const bytes: Buffer | string = source.kind === "file"
      ? source.path
      : source.kind === "zip"
        ? await this.media.zips.read(source.archive, source.entry, { signal: input.signal, maxBytes: 64 * 1024 * 1024 })
        : fs.readFileSync(source.path).subarray(source.offset, source.offset + source.length);
    const result = await makeThumbnail(bytes, { maxEdge: input.maxEdge, region: input.region, format, signal: input.signal });
    return { ...result, pageId: page.id };
  }

  /** The page list without byte locations: what the reader needs to lay pages out and keep ids stable. */
  pages(resourceId: string, revisionId?: string) {
    const { revisionId: id, manifest, title } = this.loadManifest(resourceId, revisionId);
    const location = this.location(id);
    return {
      resourceId,
      revisionId: id,
      title,
      source: manifest.source,
      direction: manifest.direction ?? null,
      info: manifest.info ?? null,
      available: location?.available ?? false,
      warnings: manifest.warnings,
      pages: manifest.pages.map((page) => ({ id: page.id, index: page.index, name: page.name, width: page.width, height: page.height, spread: page.spread ?? false, ok: page.ok, ...(page.error ? { error: page.error } : {}) })),
    };
  }

  /** The record table of a MOBI, kept while the file stays as it was so a page request never re-reads the book. */
  private readonly mobiTables = new Map<string, { mtimeMs: number; size: number; table: MobiTable }>();

  private mobiTable(file: string): MobiTable {
    const stat = fs.statSync(file);
    const cached = this.mobiTables.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      this.mobiTables.delete(file);
      this.mobiTables.set(file, cached);
      return cached.table;
    }
    const table = mobiTableOfFile(file);
    this.mobiTables.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, table });
    while (this.mobiTables.size > 8) this.mobiTables.delete(this.mobiTables.keys().next().value as string);
    return table;
  }

  private pageFile(location: Location, manifest: ComicManifest, page: ComicPage): { kind: "file"; path: string } | { kind: "zip"; archive: string; entry: string } | { kind: "slice"; path: string; offset: number; length: number; mediaType: string } | { kind: "pdf"; path: string; pageNumber: number } {
    const ref = page.ref;
    switch (ref.kind) {
      case "file": {
        const base = path.resolve(location.path);
        const target = path.resolve(base, ref.relativePath);
        const relative = path.relative(base, target);
        if (relative.startsWith("..") || path.isAbsolute(relative)) throw new MangaError("PATH_ESCAPE", "page path leaves the comic folder");
        return { kind: "file", path: target };
      }
      case "zip":
      case "epub": return { kind: "zip", archive: location.path, entry: ref.entry };
      case "pdf": return { kind: "pdf", path: location.path, pageNumber: ref.pageNumber };
      case "mobi": {
        const record = this.mobiTable(location.path).records.find((item) => item.recordIndex === ref.recordIndex);
        if (!record) throw new MangaError("NOT_FOUND", "page record is missing");
        return { kind: "slice", path: location.path, offset: record.offset, length: record.length, mediaType: record.mediaType };
      }
      case "asset": throw new MangaError("UNSUPPORTED_FORMAT", "stored page assets are not used for comics");
    }
    void manifest;
  }

  /**
   * A handle the reader can put in `<img src>`. Browser formats are streamed from the original; anything else, or an image
   * beyond the display budget, is converted once into the cache. A damaged page answers with `available: false` so the
   * reader shows a placeholder and goes on.
   */
  async pageHandle(input: { resourceId: string; revisionId: string; pageId: string; variant?: "display" | "original" | "thumb"; maxEdge?: number; signal?: AbortSignal; sessionId?: string }): Promise<
    | { available: false; reason: string }
    | { available: true; kind: "image"; url: string; handle: string; mediaType: string; width: number; height: number; scaled: boolean; original: { width: number; height: number } }
    | { available: true; kind: "pdf"; url: string; handle: string; mediaType: string; pageNumber: number; width: number; height: number }
  > {
    const { manifest } = this.loadManifest(input.resourceId, input.revisionId);
    const page = manifest.pages.find((item) => item.id === input.pageId);
    if (!page) throw new MangaError("NOT_FOUND", "page is not in this revision");
    const location = this.location(input.revisionId);
    if (!location?.available) return { available: false, reason: "original is not available" };
    if (!page.ok) return { available: false, reason: page.error ?? "page could not be read" };
    const binding = { moduleId: COMIC_MODULE, resourceId: input.resourceId, revisionId: input.revisionId, sessionId: input.sessionId };
    const source = this.pageFile(location, manifest, page);
    if (source.kind === "pdf") {
      const issued = this.media.handles.issue({ kind: "file", path: source.path, mediaType: "application/pdf" }, binding, { ttlMs: PAGE_TTL_MS });
      return { available: true, kind: "pdf", url: issued.url, handle: issued.handle, mediaType: "application/pdf", pageNumber: source.pageNumber, width: page.width, height: page.height };
    }
    const variant = input.variant ?? "display";
    const mediaType = source.kind === "slice" ? source.mediaType : mediaTypeForName(source.kind === "file" ? source.path : source.entry);
    const strip = page.height / Math.max(1, page.width) > STRIP_RATIO;
    const oversize = page.width * page.height > DISPLAY_PIXELS || Math.max(page.width, page.height) > (strip ? 100_000 : DISPLAY_EDGE * 2);
    const needsConversion = !BROWSER_IMAGE_TYPES.has(mediaType);
    const wantsScale = variant === "thumb" || input.maxEdge !== undefined || oversize;
    if (variant === "original" || (!needsConversion && !wantsScale)) {
      if (needsConversion) return this.derived(page, source, binding, { width: strip ? Math.min(page.width, DISPLAY_EDGE) : undefined, maxEdge: strip ? undefined : DISPLAY_EDGE }, input.signal);
      const issued = source.kind === "file"
        ? this.media.handles.issue({ kind: "file", path: source.path, mediaType }, binding, { ttlMs: PAGE_TTL_MS })
        : source.kind === "slice"
          ? this.media.handles.issue({ kind: "slice", path: source.path, offset: source.offset, length: source.length, mediaType }, binding, { ttlMs: PAGE_TTL_MS })
          : this.media.handles.issue({ kind: "zip-entry", archive: source.archive, entry: source.entry, size: page.bytes ?? 0, mediaType }, binding, { ttlMs: PAGE_TTL_MS });
      return { available: true, kind: "image", url: issued.url, handle: issued.handle, mediaType, width: page.width, height: page.height, scaled: false, original: { width: page.width, height: page.height } };
    }
    const edge = Math.max(64, Math.min(input.maxEdge ?? (variant === "thumb" ? 240 : DISPLAY_EDGE), DISPLAY_EDGE));
    return this.derived(page, source, binding, strip && variant !== "thumb" ? { width: Math.min(edge, page.width) } : { maxEdge: edge }, input.signal, variant === "thumb" ? "webp" : "webp");
  }

  private async derived(
    page: ComicPage,
    source: ReturnType<ComicService["pageFile"]> & { kind: "file" | "zip" | "slice" },
    binding: { moduleId: string; resourceId: string; revisionId: string; sessionId?: string },
    scale: { maxEdge?: number; width?: number },
    signal?: AbortSignal,
    format: "webp" | "jpeg" = "webp",
  ) {
    const key = this.media.thumbs.keyFor("page", page.hash, scale.maxEdge, scale.width, format);
    const made = await this.media.thumbs.ensure(key, async () => {
      const input = source.kind === "file"
        ? source.path
        : source.kind === "zip"
          ? await this.media.zips.read(source.archive, source.entry, { signal })
          : fs.readFileSync(source.path).subarray(source.offset, source.offset + source.length);
      return makeThumbnail(input, { ...scale, format, signal });
    }, signal);
    let width = made.width;
    let height = made.height;
    if (width === undefined || height === undefined) {
      const sharp = (await import("sharp")).default;
      const meta = await sharp(made.path).metadata();
      width = meta.width ?? page.width;
      height = meta.height ?? page.height;
    }
    const issued = this.media.handles.issue({ kind: "file", path: made.path, mediaType: made.mediaType }, binding, { ttlMs: PAGE_TTL_MS });
    return { available: true as const, kind: "image" as const, url: issued.url, handle: issued.handle, mediaType: made.mediaType, width, height, scaled: true, original: { width: page.width, height: page.height } };
  }

  /** The pages' own text in the manifest is identity only; handles for several pages at once keep a reader's preload to one call. */
  async pageHandles(input: { resourceId: string; revisionId: string; pageIds: string[]; variant?: "display" | "thumb"; maxEdge?: number; signal?: AbortSignal; sessionId?: string }) {
    const out: Array<{ pageId: string } & Awaited<ReturnType<ComicService["pageHandle"]>>> = [];
    for (const pageId of input.pageIds) {
      try {
        out.push({ pageId, ...(await this.pageHandle({ ...input, pageId })) });
      } catch (error) {
        if (input.signal?.aborted) throw new MangaError("CANCELLED", "page request was cancelled");
        out.push({ pageId, available: false, reason: error instanceof MangaError ? error.message : "page could not be read" });
      }
    }
    return out;
  }

  /** What the chosen file or folder looks like, for the import dialog: a pre-selected kind and what would be imported. */
  async inspect(source: string, signal?: AbortSignal, progress?: (folders: number, items: number) => void): Promise<InspectResult> {
    const stat = await fsp.stat(source).catch(() => null);
    if (!stat) throw new MangaError("NOT_FOUND", "the file or folder is not available");
    const name = path.basename(source);
    if (!stat.isDirectory()) {
      return { entry: "file", name, bytes: stat.size, suggestion: await suggestKind(source, { zips: this.media.zips, signal }) };
    }
    // One walk of the folder serves all three kinds, and it reads asynchronously: a large drive does not stop the interface.
    const { comic, video, novel } = await planDirectoryAsync(source, ["comic", "video", "novel"], { signal, progress });
    const counts = { comic: comic.items.length, video: video.items.length, novel: novel.items.length };
    let suggestion: KindSuggestion;
    if (counts.video > 0 && counts.video >= counts.comic) suggestion = { kind: "video", basis: "extension", confidence: "high" };
    else if (comic.items.some((item) => item.type === "image-dir" || item.type === "archive")) suggestion = { kind: "comic", basis: "images_only", confidence: "high" };
    else if (comic.items.length) {
      // Only documents: look at the first one; a folder of one kind of book is rarely mixed.
      const first = comic.items.find((item) => item.type === "document")!;
      suggestion = await suggestKind(first.path, { zips: this.media.zips, signal });
    } else if (counts.novel > 0) suggestion = { kind: "novel", basis: "text", confidence: "high" };
    else suggestion = { kind: "novel", basis: "unknown", confidence: "low" };
    const chosen = suggestion.kind === "video" ? video : suggestion.kind === "comic" ? comic : novel;
    return {
      entry: "directory",
      name,
      suggestion,
      counts,
      truncated: chosen.truncated,
      items: chosen.items.slice(0, 50).map((item) => ({ relative: item.relative, type: item.type, ...(item.imageCount !== undefined ? { imageCount: item.imageCount } : {}) })),
    };
  }

  async fileFingerprint(file: string): Promise<string> {
    return fingerprintFile(file);
  }

  static handleInfo(url: string, mediaType: string, bytes?: number): MediaHandleInfo {
    return { url, mediaType, ...(bytes !== undefined ? { bytes } : {}) };
  }
}
