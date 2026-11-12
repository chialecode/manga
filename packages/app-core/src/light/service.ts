import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { MangaError } from "@manga/contracts";
import type { ComicManifest, VideoProbe } from "@manga/contracts";
import { comparePaths, naturalCompare } from "../domain/natural-sort.ts";
import { decodeTextBuffer } from "../domain/text.ts";
import { parseComicInfo } from "../comic/comicinfo.ts";
import { FfmpegService, locateFfmpeg, type FfmpegTools } from "../media/ffmpeg.ts";
import { MediaHandleTable } from "../media/handles.ts";
import { JobQueue } from "../media/job-queue.ts";
import { BROWSER_IMAGE_TYPES, VIDEO_EXTENSIONS, isIgnoredName, isImageName, mediaTypeForName } from "../media/kinds.ts";
import { locateSubtitleFont, type SubtitleFont } from "../media/subtitle-font.ts";
import { ZipPool } from "../media/zip-pool.ts";
import { fontFamilies } from "../video/font-names.ts";
import { answerFrame, type FrameIndex } from "../video/frames.ts";
import { PlayCopies } from "../video/play-copy.ts";
import { JsonPlayCopyStore } from "../video/play-copy-store.ts";
import { decidePlayback, listTracks, mediaTypeFor } from "../video/playback.ts";
import { discoverSidecars } from "../video/sidecars.ts";
import { IMAGE_HEADER_BYTES, imageSizeOf } from "./image-size.ts";

/** The module id light handles and jobs are bound to. */
export const LIGHT_MODULE = "manga.light";
/** Play copies light open keeps, at most (A-128); the least recently used go first. */
export const LIGHT_COPY_BUDGET_BYTES = 2 * 1024 * 1024 * 1024;
const HANDLE_TTL_MS = 6 * 60 * 60_000;
const MAX_PAGES = 5000;
const HEADER_CONCURRENCY = 8;

/** The types the installer offers MANGA for in "Open with" (Q-39 item 2): every video type, CBZ, and the common image types. */
export const LIGHT_VIDEO_EXTENSIONS = [...VIDEO_EXTENSIONS].sort();
export const LIGHT_COMIC_EXTENSIONS = [".cbz"];
export const LIGHT_IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".bmp"];
/** What light open also takes when dragged in or chosen with "Open file…", but is not registered for (`.zip` is too general). */
export const LIGHT_EXTRA_EXTENSIONS = [".zip"];

/** The commands light open answers: the same names, inputs and results as the full app's, so the player's and reader's hooks work unchanged. */
export const LIGHT_COMMANDS = [
  "video.playbackPlan", "video.playCopy", "video.handle", "video.subtitles", "video.subtitleHandle", "video.fonts", "video.frameIndex", "video.cancelFrameIndex",
  "comic.pages", "comic.pageHandles",
] as const;
export type LightCommand = typeof LIGHT_COMMANDS[number];

export type LightKind = "video" | "comic-archive" | "comic-folder" | "comic-image";

/** What a path is to light open, or null when light open does not take it. */
export function lightKindOf(file: string): LightKind | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return null; }
  if (stat.isDirectory()) return "comic-folder";
  if (!stat.isFile()) return null;
  const ext = path.extname(file).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (ext === ".cbz" || ext === ".zip") return "comic-archive";
  if (LIGHT_IMAGE_EXTENSIONS.includes(ext)) return "comic-image";
  return null;
}

/**
 * The key a file is remembered by (A-128): the SHA-256 of its lower-cased full path, its size and its modification time. Neither the name nor the
 * path is stored; a file that changed is a new file.
 */
export function lightFileKey(file: string, stat?: fs.Stats): string {
  const info = stat ?? fs.statSync(file);
  return createHash("sha256").update(`${path.resolve(file).toLowerCase()}\n${info.size}\n${Math.round(info.mtimeMs)}`).digest("hex");
}

type LightPage = { id: string; index: number; name: string; width: number; height: number; spread: boolean; ok: boolean; error?: string; mediaType: string; ref: { kind: "file"; path: string } | { kind: "zip"; entry: string; size: number } };

type VideoSession = { id: string; kind: "video"; path: string; key: string; size: number; mtimeMs: number; name: string; probe: VideoProbe };
type ComicSession = {
  id: string; kind: "comic"; path: string; key: string; size: number; mtimeMs: number; name: string; source: "cbz" | "dir";
  pages: LightPage[]; startIndex: number; direction: "ltr" | "rtl" | null; info: ComicManifest["info"] | null; warnings: string[];
};
type Session = VideoSession | ComicSession;

/** What the window is told about a file it opened; no path. */
export type LightOpened =
  | { sessionId: string; kind: "video"; name: string; key: string; resourceId: string; revisionId: string; durationMs: number; audio: ReturnType<typeof listTracks>["audio"]; siblings: { previous: boolean; next: boolean } }
  | { sessionId: string; kind: "comic"; name: string; key: string; resourceId: string; revisionId: string; startPageId: string | null; pageCount: number; siblings: { previous: boolean; next: boolean } };

export type LightMediaOptions = {
  /** `<app data root>\light\cache`: play copies, subtitle and font extracts. Nothing else is written by the service. */
  cacheDir: string;
  resourcesPath?: string;
  tools?: FfmpegTools | null;
  subtitleFont?: SubtitleFont | null;
  copyBudgetBytes?: number;
};

const SUBTITLE_MEDIA_TYPES = { ass: "text/x-ssa; charset=utf-8", srt: "application/x-subrip; charset=utf-8", vtt: "text/vtt; charset=utf-8" } as const;
const FONT_TYPES: Record<string, string> = { ".ttf": "font/ttf", ".otf": "font/otf", ".ttc": "font/collection", ".woff": "font/woff", ".woff2": "font/woff2" };
const UNSHOWN = "轻量打开不显示这种图片格式";

async function inBatches<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  }));
}

function readHead(file: string): Buffer {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(IMAGE_HEADER_BYTES);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The media of light open (READ-05, A-128): one file per session, opened by path, read without the library. It probes and plans a video like the
 * full app, makes a play copy only when asked (indexed in a JSON file next to the copies, within 2 GB), lists the pages of a CBZ, ZIP or image
 * folder, and serves everything through the same opaque `manga-media` handles. It writes nothing but its cache folder.
 */
export class LightMediaService {
  readonly handles = new MediaHandleTable();
  readonly zips = new ZipPool();
  readonly ffmpeg: FfmpegService;
  readonly jobs = new JobQueue({ ffmpeg: 1, "frame-index": 1, default: 2 });
  readonly copies: PlayCopies;
  private readonly sessions = new Map<string, Session>();
  private readonly frameIndexes = new Map<string, FrameIndex>();
  private readonly familyCache = new Map<string, string[]>();
  private readonly subtitleFont: SubtitleFont | null;
  private readonly cacheDir: string;

  constructor(options: LightMediaOptions) {
    this.cacheDir = options.cacheDir;
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.ffmpeg = new FfmpegService(options.tools === undefined ? locateFfmpeg({ resourcesPath: options.resourcesPath }) : options.tools, { concurrency: 2 });
    this.subtitleFont = options.subtitleFont === undefined ? locateSubtitleFont({ resourcesPath: options.resourcesPath }) : options.subtitleFont;
    const media = { dir: (...parts: string[]) => this.dir(...parts), ffmpeg: this.ffmpeg, jobs: this.jobs, handles: this.handles };
    this.copies = new PlayCopies(new JsonPlayCopyStore(path.join(this.cacheDir, "play-copies", "index.json")), media, (key) => {
      const session = [...this.sessions.values()].find((item): item is VideoSession => item.kind === "video" && item.key === key);
      if (!session) throw new MangaError("NOT_FOUND", "the video is not open");
      return { revisionId: key, resourceId: session.id, probe: session.probe, path: session.path, available: this.unchanged(session) };
    }, options.copyBudgetBytes ?? LIGHT_COPY_BUDGET_BYTES);
    // Extracts of a session (subtitles, fonts) are scratch: what an earlier run left is removed. Copies stay; unfinished ones are cleaned up.
    fs.rmSync(path.join(this.cacheDir, "work"), { recursive: true, force: true });
    this.copies.recover();
    this.copies.removeStrays();
  }

  private dir(...parts: string[]): string {
    const target = path.join(this.cacheDir, ...parts);
    fs.mkdirSync(target, { recursive: true });
    return target;
  }

  private unchanged(session: Session): boolean {
    try {
      const stat = fs.statSync(session.path);
      return stat.size === session.size && Math.round(stat.mtimeMs) === Math.round(session.mtimeMs);
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------------ sessions

  /** Open a file (or folder) for one window. The answer carries no path; the session id stands for the file in every later command. */
  async open(target: string, signal?: AbortSignal): Promise<LightOpened> {
    const file = path.resolve(target);
    const kind = lightKindOf(file);
    if (!fs.existsSync(file)) throw new MangaError("NOT_FOUND", "the file is not there");
    if (!kind) throw new MangaError("UNSUPPORTED_FORMAT", "light open does not take this kind of file");
    if (kind === "video") return this.openVideo(file, signal);
    return this.openComic(file, kind, signal);
  }

  private async openVideo(file: string, signal?: AbortSignal): Promise<LightOpened> {
    if (!this.ffmpeg.available) throw new MangaError("CAPABILITY_UNAVAILABLE", "the media tool is not installed");
    const stat = fs.statSync(file);
    const base = await this.ffmpeg.probe(file, { signal });
    if (!base.streams.some((stream) => stream.type === "video")) throw new MangaError("UNSUPPORTED_FORMAT", "the file has no video stream");
    const sidecars = discoverSidecars(file).map(({ id, fileName, format, language }) => ({ id, fileName, format, ...(language ? { language } : {}) }));
    const probe: VideoProbe = { ...base, keyframesMs: [], keyframesTruncated: true, variableFrameRate: false, externalSubtitles: sidecars };
    const session: VideoSession = { id: `ls_${randomUUID()}`, kind: "video", path: file, key: lightFileKey(file, stat), size: stat.size, mtimeMs: stat.mtimeMs, name: path.basename(file), probe };
    this.sessions.set(session.id, session);
    return {
      sessionId: session.id, kind: "video", name: session.name, key: session.key, resourceId: session.id, revisionId: session.key, durationMs: probe.durationMs,
      audio: listTracks(probe).audio, siblings: this.siblingFlags(session),
    };
  }

  private async openComic(file: string, kind: Exclude<LightKind, "video">, signal?: AbortSignal): Promise<LightOpened> {
    const folder = kind === "comic-image" ? path.dirname(file) : file;
    const stat = fs.statSync(folder);
    let pages: LightPage[];
    let direction: ComicSession["direction"] = null;
    let info: ComicSession["info"] = null;
    const warnings: string[] = [];
    if (kind === "comic-archive") {
      const index = await this.zips.index(folder, signal);
      const unsafe = index.entries.filter((entry) => entry.unsafe);
      if (unsafe.length) warnings.push(`${unsafe.length} archive entries with unsafe names were skipped`);
      const images = index.entries.filter((entry) => !entry.directory && !entry.unsafe && isImageName(entry.name) && !isIgnoredName(entry.name));
      if (images.some((entry) => entry.encrypted)) throw new MangaError("UNSUPPORTED_FORMAT", "the archive is encrypted and cannot be read");
      images.sort((a, b) => comparePaths(a.name, b.name));
      pages = images.map((entry, at) => ({
        id: entry.name, index: at, name: entry.name.split("/").pop() ?? entry.name, width: 0, height: 0, spread: false, ok: true, mediaType: mediaTypeForName(entry.name),
        ref: { kind: "zip" as const, entry: entry.name, size: entry.uncompressedSize },
      }));
      const infoEntry = index.entries.find((entry) => !entry.unsafe && !entry.directory && /(^|\/)comicinfo\.xml$/i.test(entry.name) && !entry.encrypted && entry.uncompressedSize < 1024 * 1024);
      if (infoEntry) {
        try {
          const parsed = parseComicInfo(await this.zips.read(folder, infoEntry.name, { maxBytes: 1024 * 1024, signal }));
          if (!parsed) throw new Error("no ComicInfo");
          direction = parsed.direction ?? null;
          const { pages: marks, direction: _direction, language: _language, genre: _genre, ...rest } = parsed;
          info = Object.keys(rest).length ? rest : null;
          for (const mark of marks) if (pages[mark.image] && mark.doublePage !== undefined) pages[mark.image]!.spread = mark.doublePage;
        } catch { /* a broken ComicInfo.xml is ignored, as in the library */ }
      }
    } else {
      const names = fs.readdirSync(folder, { withFileTypes: true })
        .filter((entry) => entry.isFile() && isImageName(entry.name) && !isIgnoredName(entry.name)).map((entry) => entry.name).sort(naturalCompare);
      pages = names.map((name, at) => ({ id: name, index: at, name, width: 0, height: 0, spread: false, ok: true, mediaType: mediaTypeForName(name), ref: { kind: "file" as const, path: path.join(folder, name) } }));
    }
    if (!pages.length) throw new MangaError("UNSUPPORTED_FORMAT", "no readable pages were found");
    if (pages.length > MAX_PAGES) throw new MangaError("UNSUPPORTED_FORMAT", `the source has ${pages.length} pages, more than the ${MAX_PAGES} allowed`);
    for (const page of pages) if (!BROWSER_IMAGE_TYPES.has(page.mediaType)) { page.ok = false; page.error = UNSHOWN; }
    await this.measure(folder, pages, signal);
    const startIndex = kind === "comic-image" ? Math.max(0, pages.findIndex((page) => page.id === path.basename(file))) : 0;
    const session: ComicSession = {
      id: `ls_${randomUUID()}`, kind: "comic", path: folder, key: lightFileKey(folder, stat), size: kind === "comic-archive" ? stat.size : 0, mtimeMs: kind === "comic-archive" ? stat.mtimeMs : 0,
      name: path.basename(folder), source: kind === "comic-archive" ? "cbz" : "dir", pages, startIndex, direction, info, warnings,
    };
    // A folder's own time changes when a page is added; a page added later is not a different comic, so a folder is keyed by its path alone.
    if (kind !== "comic-archive") session.key = createHash("sha256").update(`${path.resolve(folder).toLowerCase()}\ndir`).digest("hex");
    this.sessions.set(session.id, session);
    return {
      sessionId: session.id, kind: "comic", name: session.name, key: session.key, resourceId: session.id, revisionId: session.key,
      startPageId: kind === "comic-image" ? pages[startIndex]!.id : null, pageCount: pages.length, siblings: this.siblingFlags(session),
    };
  }

  /** Each page's size from its first bytes, several at a time; a page whose header cannot be read keeps 0×0 and is laid out as 2:3. */
  private async measure(container: string, pages: LightPage[], signal?: AbortSignal): Promise<void> {
    await inBatches(pages.filter((page) => page.ok), HEADER_CONCURRENCY, async (page) => {
      signal?.throwIfAborted();
      try {
        let head: Buffer;
        if (page.ref.kind === "file") head = readHead(page.ref.path);
        else {
          const { stream } = await this.zips.openStream(container, page.ref.entry, signal);
          const chunks: Buffer[] = [];
          let total = 0;
          for await (const chunk of stream) {
            chunks.push(chunk as Buffer);
            total += (chunk as Buffer).length;
            if (total >= IMAGE_HEADER_BYTES) break;
          }
          stream.destroy();
          head = Buffer.concat(chunks, total);
        }
        if (head.length === 0) { page.ok = false; page.error = "page file is empty"; return; }
        const size = imageSizeOf(head);
        if (size) { page.width = size.width; page.height = size.height; page.spread ||= size.width > size.height * 1.2; }
      } catch (error) {
        if (signal?.aborted) throw new MangaError("CANCELLED", "opening was cancelled");
        page.ok = false;
        page.error = (error instanceof Error ? error.message : String(error)).slice(0, 200);
      }
    });
  }

  /** Close a session: its handles stop answering, its frame table and extracts go, a copy being made goes on (it is kept for next time). */
  close(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.handles.closeSession(sessionId);
    if (session.kind === "video" && ![...this.sessions.values()].some((item) => item.key === session.key)) {
      this.jobs.cancelWhere((job) => job.key === `frame-index:${session.key}`);
      this.frameIndexes.delete(session.key);
    }
    fs.rmSync(path.join(this.cacheDir, "work", sessionId), { recursive: true, force: true });
  }

  /** The file a session opened, for the window's own uses (the title, "Show in Explorer", the siblings); never sent to the page. */
  pathOf(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.path ?? null;
  }

  /** The ids of a comic's pages in reading order (empty for a video), to find a remembered page again. */
  pageIdsOf(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    return session?.kind === "comic" ? session.pages.map((page) => page.id) : [];
  }

  /** The file before or after this one in its folder: videos among videos; comics among CBZ/ZIP files and sub-folders. */
  sibling(sessionId: string, direction: -1 | 1): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const list = this.siblingList(session);
    const at = list.findIndex((item) => path.resolve(item).toLowerCase() === path.resolve(session.path).toLowerCase());
    return at < 0 ? null : list[at + direction] ?? null;
  }

  private siblingList(session: Session): string[] {
    const parent = path.dirname(session.path);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(parent, { withFileTypes: true }); } catch { return []; }
    const names = entries.filter((entry) => {
      if (isIgnoredName(entry.name)) return false;
      const ext = path.extname(entry.name).toLowerCase();
      if (session.kind === "video") return entry.isFile() && VIDEO_EXTENSIONS.has(ext);
      return (entry.isFile() && (ext === ".cbz" || ext === ".zip")) || entry.isDirectory();
    }).map((entry) => entry.name).sort(naturalCompare);
    return names.map((name) => path.join(parent, name));
  }

  private siblingFlags(session: Session): { previous: boolean; next: boolean } {
    const list = this.siblingList(session);
    const at = list.findIndex((item) => path.resolve(item).toLowerCase() === path.resolve(session.path).toLowerCase());
    return { previous: at > 0, next: at >= 0 && at < list.length - 1 };
  }

  get openSessions(): number {
    return this.sessions.size;
  }

  dispose(): void {
    this.jobs.cancelWhere(() => true);
    this.zips.close();
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  // ------------------------------------------------------------------ commands

  /** Answer one command from a light window. Anything not in `LIGHT_COMMANDS` is refused. */
  async call(commandId: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!(LIGHT_COMMANDS as readonly string[]).includes(commandId)) throw new MangaError("FORBIDDEN", `light open does not answer ${commandId}`);
    const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
    const session = this.sessions.get(String(body.resourceId ?? ""));
    if (!session) throw new MangaError("NOT_FOUND", "the file is not open");
    if (body.revisionId !== undefined && body.revisionId !== session.key) throw new MangaError("NOT_FOUND", "revision missing");
    if (commandId.startsWith("comic.")) {
      if (session.kind !== "comic") throw new MangaError("UNSUPPORTED_FORMAT", "this resource is not a comic");
      return commandId === "comic.pages" ? this.pages(session) : { pages: this.pageHandles(session, Array.isArray(body.pageIds) ? body.pageIds.map(String) : []) };
    }
    if (session.kind !== "video") throw new MangaError("UNSUPPORTED_FORMAT", "this resource is not a video");
    switch (commandId as LightCommand) {
      case "video.playbackPlan": {
        const plan = decidePlayback(session.probe, { hardwareHevc: body.hardwareHevc === true }, typeof body.audioStreamIndex === "number" ? { audioStreamIndex: body.audioStreamIndex } : {});
        const copy = plan.copy ? this.copies.find(session.key, plan.copy.reason, plan.audioStreamIndex) : null;
        return { resourceId: session.id, revisionId: session.key, available: this.unchanged(session), plan, copy };
      }
      case "video.playCopy": {
        const action = body.action;
        if (action === "status") return { revisionId: session.key, copies: this.copies.list(session.key), budgetBytes: this.copies.budget(), usedBytes: this.copies.totalBytes() };
        if (action === "cancel") return { cancelled: this.copies.cancel(session.key) };
        if (action === "remove") return { removed: this.copies.remove(session.key) };
        if (action !== "create") throw new MangaError("VALIDATION_ERROR", "unknown play copy action");
        if (!this.unchanged(session)) throw new MangaError("NOT_FOUND", "the video file is not available");
        const caps = { hardwareHevc: body.hardwareHevc === true };
        const audio = typeof body.audioStreamIndex === "number" ? { audioStreamIndex: body.audioStreamIndex } : {};
        let plan = decidePlayback(session.probe, caps, audio);
        if (!plan.copy && body.reason !== undefined) plan = decidePlayback(session.probe, { ...caps, forcePlayCopy: true }, audio);
        return { copy: await this.copies.create({ revisionId: session.key, plan }) };
      }
      case "video.handle": return this.videoHandle(session, body);
      case "video.subtitles": return { resourceId: session.id, revisionId: session.key, available: this.unchanged(session), ...listTracks(session.probe) };
      case "video.subtitleHandle": {
        const file = await this.subtitleFile(session, String(body.trackId ?? ""), signal);
        const mediaType = SUBTITLE_MEDIA_TYPES[file.format];
        const issued = this.handles.issue({ kind: "file", path: file.path, mediaType }, this.binding(session), { ttlMs: HANDLE_TTL_MS });
        return { trackId: body.trackId, format: file.format, language: file.language, title: file.title, url: issued.url, handle: issued.handle, mediaType };
      }
      case "video.fonts": return this.fonts(session, signal);
      case "video.frameIndex": return this.frame(session, body, signal);
      case "video.cancelFrameIndex": return { revisionId: session.key, cancelled: this.jobs.cancelWhere((job) => job.key === `frame-index:${session.key}`) > 0 };
      default: throw new MangaError("FORBIDDEN", `light open does not answer ${commandId}`);
    }
  }

  private binding(session: Session, subject?: string) {
    return { moduleId: LIGHT_MODULE, resourceId: session.id, revisionId: session.key, sessionId: session.id, ...(subject ? { subject } : {}) };
  }

  private videoHandle(session: VideoSession, body: Record<string, unknown>) {
    if (body.source === "play_copy") {
      const copy = this.copies.ready(session.key, typeof body.copyId === "string" ? body.copyId : undefined);
      const issued = this.handles.issue({ kind: "file", path: copy.path, mediaType: "video/mp4" }, this.binding(session, `play-copy:${copy.id}`), { ttlMs: HANDLE_TTL_MS });
      return { source: "play_copy" as const, url: issued.url, handle: issued.handle, mediaType: "video/mp4", bytes: copy.bytes, startMs: 0, copyId: copy.id };
    }
    // A file that was replaced or removed after it was opened is not served: the window says it is gone.
    if (!this.unchanged(session)) throw new MangaError("NOT_FOUND", "the video file is not available");
    const mediaType = mediaTypeFor(session.probe);
    const issued = this.handles.issue({ kind: "file", path: session.path, mediaType }, this.binding(session), { ttlMs: HANDLE_TTL_MS });
    return { source: "original" as const, url: issued.url, handle: issued.handle, mediaType, bytes: session.size, startMs: session.probe.startMs };
  }

  private async subtitleFile(session: VideoSession, trackId: string, signal?: AbortSignal): Promise<{ path: string; format: "ass" | "srt" | "vtt"; language: string | null; title: string | null }> {
    if (!this.unchanged(session)) throw new MangaError("NOT_FOUND", "the video file is not available");
    const dir = this.dir("work", session.id, "subtitles");
    if (trackId.startsWith("x")) {
      const sidecar = discoverSidecars(session.path).find((item) => item.id === trackId);
      if (!sidecar) throw new MangaError("NOT_FOUND", "subtitle file is not next to the video any more");
      const target = path.join(dir, `${trackId}.${sidecar.format}`);
      if (!fs.existsSync(target)) fs.writeFileSync(target, decodeTextBuffer(new Uint8Array(fs.readFileSync(sidecar.absolutePath))).text.replace(/^\uFEFF/, ""), "utf8");
      return { path: target, format: sidecar.format, language: sidecar.language ?? null, title: sidecar.fileName };
    }
    const match = /^s(\d+)$/.exec(trackId);
    const stream = match ? session.probe.streams.find((item) => item.type === "subtitle" && item.index === Number(match[1])) : undefined;
    if (!stream) throw new MangaError("NOT_FOUND", "subtitle track does not exist");
    if (!stream.textual) throw new MangaError("UNSUPPORTED_FORMAT", "image subtitles cannot be shown as text");
    const format = stream.codec === "ass" || stream.codec === "ssa" ? "ass" : "srt";
    const target = path.join(dir, `${trackId}.${format}`);
    if (!fs.existsSync(target)) {
      const text = await this.ffmpeg.subtitleText(session.path, stream.index, format, { signal });
      const staging = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(staging, text, "utf8");
      fs.renameSync(staging, target);
    }
    return { path: target, format, language: stream.language ?? null, title: stream.title ?? null };
  }

  private async fonts(session: VideoSession, signal?: AbortSignal) {
    const binding = this.binding(session);
    const fallback = this.subtitleFont
      ? { family: this.subtitleFont.family, mediaType: this.subtitleFont.mediaType, url: this.handles.issue({ kind: "file", path: this.subtitleFont.path, mediaType: this.subtitleFont.mediaType }, binding, { ttlMs: HANDLE_TTL_MS }).url }
      : null;
    const attachments = session.probe.streams.filter((stream) => stream.type === "attachment" && FONT_TYPES[path.extname(stream.fileName ?? "").toLowerCase()]);
    if (!attachments.length) return { fonts: [] as Array<{ id: string; fileName: string; mediaType: string; url: string; families: string[] }>, fallback };
    const dir = this.dir("work", session.id, "fonts");
    const items = attachments.map((stream) => ({ stream, outName: `f${stream.index}${path.extname(stream.fileName!).toLowerCase()}` }));
    const missing = items.filter((item) => !fs.existsSync(path.join(dir, item.outName)));
    if (missing.length) await this.ffmpeg.dumpAttachments(session.path, missing.map((item) => ({ streamIndex: item.stream.index, outName: item.outName })), dir, { signal });
    return {
      fonts: items.map(({ stream, outName }) => {
        const file = path.join(dir, outName);
        const mediaType = FONT_TYPES[path.extname(outName)]!;
        const issued = this.handles.issue({ kind: "file", path: file, mediaType }, binding, { ttlMs: HANDLE_TTL_MS });
        return { id: `f${stream.index}`, fileName: stream.fileName!, mediaType, url: issued.url, families: this.familiesOf(file) };
      }),
      fallback,
    };
  }

  private familiesOf(file: string): string[] {
    try {
      const key = `${file}:${fs.statSync(file).size}`;
      const known = this.familyCache.get(key);
      if (known) return known;
      const names = fontFamilies(fs.readFileSync(file));
      this.familyCache.set(key, names);
      while (this.familyCache.size > 50) this.familyCache.delete(this.familyCache.keys().next().value as string);
      return names;
    } catch {
      return [];
    }
  }

  /** As the library's `video.frameIndex`: the table lives in memory only, is built when a frame step asks for it, and one at a time. */
  private async frame(session: VideoSession, query: Record<string, unknown>, signal?: AbortSignal) {
    const known = this.frameIndexes.get(session.key);
    if (!known && query.build === false) {
      const building = this.jobs.list({ kind: "frame-index", active: true }).some((job) => job.key === `frame-index:${session.key}`);
      return { revisionId: session.key, ready: false as const, state: building ? "building" as const : "absent" as const };
    }
    let index = known;
    if (!index) {
      if (!this.ffmpeg.available) throw new MangaError("CAPABILITY_UNAVAILABLE", "the media tool is not installed");
      if (!this.unchanged(session)) throw new MangaError("NOT_FOUND", "the video file is not available");
      const job = this.jobs.submit<FrameIndex>({
        lane: "frame-index", kind: "frame-index", key: `frame-index:${session.key}`, owner: LIGHT_MODULE,
        run: async (context) => {
          const video = session.probe.streams.find((stream) => stream.type === "video" && stream.fps !== undefined) ?? session.probe.streams.find((stream) => stream.type === "video");
          if (!video) throw new MangaError("UNSUPPORTED_FORMAT", "the file has no video stream");
          const timeline = await this.ffmpeg.packetTimeline(session.path, video.index, session.probe.startMs, { signal: context.signal });
          if (!timeline.ptsMs.length) throw new MangaError("UNSUPPORTED_FORMAT", "no frame times could be read from the file");
          return { version: 1, streamIndex: video.index, startMs: session.probe.startMs, ptsMs: timeline.ptsMs, keyframesMs: timeline.keyframesMs, variableFrameRate: timeline.variableFrameRate };
        },
      });
      const onAbort = () => job.cancel();
      signal?.addEventListener("abort", onAbort, { once: true });
      try { index = await job.promise; } finally { signal?.removeEventListener("abort", onAbort); }
      this.frameIndexes.set(session.key, index);
      while (this.frameIndexes.size > 4) this.frameIndexes.delete(this.frameIndexes.keys().next().value as string);
    }
    const toNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
    return { revisionId: session.key, ready: true as const, ...answerFrame(index, session.probe.durationMs, { timeMs: toNumber(query.timeMs), frame: toNumber(query.frame), delta: toNumber(query.delta) }) };
  }

  private pages(session: ComicSession) {
    return {
      resourceId: session.id, revisionId: session.key, title: session.name, source: session.source, direction: session.direction, info: session.info,
      available: session.source === "dir" ? fs.existsSync(session.path) : this.unchanged(session), warnings: session.warnings,
      pages: session.pages.map((page) => ({ id: page.id, index: page.index, name: page.name, width: page.width, height: page.height, spread: page.spread, ok: page.ok, ...(page.error ? { error: page.error } : {}) })),
    };
  }

  private pageHandles(session: ComicSession, pageIds: string[]) {
    const intact = session.source === "dir" || this.unchanged(session);
    return pageIds.map((pageId) => {
      const page = session.pages.find((item) => item.id === pageId);
      if (!page) return { pageId, available: false as const, reason: "page is not in this revision" };
      if (!intact) return { pageId, available: false as const, reason: "original is not available" };
      if (!page.ok) return { pageId, available: false as const, reason: page.error ?? "page could not be read" };
      const binding = this.binding(session);
      const issued = page.ref.kind === "file"
        ? this.handles.issue({ kind: "file", path: page.ref.path, mediaType: page.mediaType }, binding, { ttlMs: HANDLE_TTL_MS })
        : this.handles.issue({ kind: "zip-entry", archive: session.path, entry: page.ref.entry, size: page.ref.size, mediaType: page.mediaType }, binding, { ttlMs: HANDLE_TTL_MS });
      return {
        pageId, available: true as const, kind: "image" as const, url: issued.url, handle: issued.handle, mediaType: page.mediaType, width: page.width, height: page.height, scaled: false,
        original: { width: page.width, height: page.height },
      };
    });
  }
}
