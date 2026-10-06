import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MangaError, createId } from "@manga/contracts";
import type { Ordinal, VideoProbe, VideoRevisionInfo } from "@manga/contracts";
import type { DrizzleStore, Mutation } from "@manga/storage-drizzle";
import { layoutFromPayload } from "../domain/revision-layout.ts";
import { ordinalFromParsed, ordinalLabel, parseOrdinalName, sortKeyFor } from "../domain/ordinal.ts";
import { decodeTextBuffer } from "../domain/text.ts";
import type { MediaServices } from "../media/services.ts";
import { planDirectoryAsync } from "../comic/scan.ts";
import { cueWindow, parseCues, type Cue } from "./cues.ts";
import { decidePlayback, listTracks, mediaTypeFor, type PlaybackCaps, type PlayCopyReason } from "./playback.ts";
import { discoverSidecars, sampledFingerprint, type Sidecar } from "./sidecars.ts";
import { PlayCopies } from "./play-copy.ts";

export const VIDEO_PARSER_ID = "video-probe-v1";
export const VIDEO_MODULE = "manga.video";
const KEYFRAME_LIMIT = 5000;
const HANDLE_TTL_MS = 6 * 60 * 60_000;

export type VideoImportResult = {
  resourceId: string;
  workId: string;
  revisionId: string;
  title: string;
  ordinalLabel: string | null;
  durationMs: number;
  container: string;
  duplicate: boolean;
  replaced: boolean;
  warnings: string[];
};

export type FrameIndex = {
  version: 1;
  streamIndex: number;
  /** Container start time; `ptsMs` is already relative to it, which is the player's timeline. */
  startMs: number;
  ptsMs: number[];
  keyframesMs: number[];
  variableFrameRate: boolean;
};

export type FrameAnswer = { frame: number; ptsMs: number; totalFrames: number; durationMs: number; variableFrameRate: boolean; previousMs: number | null; nextMs: number | null };

type Row = { revisionId: string; resourceId: string; title: string; probe: VideoProbe; path: string; available: boolean };

const SUBTITLE_MEDIA_TYPES = { ass: "text/x-ssa; charset=utf-8", vtt: "text/vtt; charset=utf-8" } as const;
const FONT_TYPES: Record<string, string> = { ".ttf": "font/ttf", ".otf": "font/otf", ".ttc": "font/collection", ".woff": "font/woff", ".woff2": "font/woff2" };

function titleFromParsed(names: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const name of names) {
    const title = parseOrdinalName(name, "video").title?.trim();
    if (title) counts.set(title, (counts.get(title) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

export class VideoService {
  readonly copies: PlayCopies;
  private readonly memoryIndex = new Map<string, FrameIndex>();
  private readonly cueCache = new Map<string, Cue[]>();

  private readonly store: DrizzleStore;
  private readonly media: MediaServices;

  constructor(store: DrizzleStore, media: MediaServices) {
    this.store = store;
    this.media = media;
    this.copies = new PlayCopies(store, media, (revisionId) => this.rowByRevision(revisionId));
  }

  // ------------------------------------------------------------------ import

  /** Probe a file for import: streams, chapters and the sidecar subtitles next to it. Keyframes arrive later with the frame index. */
  async probeFile(file: string, signal?: AbortSignal): Promise<VideoProbe> {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new MangaError("NOT_FOUND", "the video is not available");
    const base = await this.media.ffmpeg.probe(file, { signal });
    if (!base.streams.some((stream) => stream.type === "video")) throw new MangaError("UNSUPPORTED_FORMAT", "the file has no video stream");
    const sidecars = discoverSidecars(file).map(({ id, fileName, format, language }) => ({ id, fileName, format, ...(language ? { language } : {}) }));
    return { ...base, keyframesMs: [], keyframesTruncated: true, variableFrameRate: false, externalSubtitles: sidecars };
  }

  persist(input: {
    sourcePath: string;
    probe: VideoProbe;
    fingerprint: string;
    title?: string;
    workTitle?: string;
    workId?: string;
    ordinal?: Ordinal;
    sortKey?: string;
    receipt?: { idempotencyKey: string; commandId: string };
    now?: string;
  }): VideoImportResult {
    const { probe, sourcePath } = input;
    const now = input.now ?? new Date().toISOString();
    const stem = path.basename(sourcePath, path.extname(sourcePath));
    const existing = this.store.sqlite.prepare(`SELECT r.id AS resourceId, r.work_id AS workId, r.title AS title, r.ordinal_label AS ordinalLabel, v.id AS revisionId, v.fingerprint AS fingerprint
      FROM file_locations fl JOIN resource_revisions v ON v.id = fl.resource_revision_id JOIN resources r ON r.id = v.resource_id
      WHERE fl.relative_path = ? ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1`).get(sourcePath) as { resourceId: string; workId: string; title: string; ordinalLabel: string | null; revisionId: string; fingerprint: string } | undefined;
    const summary = (extra: Partial<VideoImportResult>): VideoImportResult => ({
      resourceId: "", workId: "", revisionId: "", title: "", ordinalLabel: null, durationMs: probe.durationMs, container: probe.container, duplicate: false, replaced: false, warnings: [], ...extra,
    });
    if (existing && existing.fingerprint === input.fingerprint) {
      const result = summary({ resourceId: existing.resourceId, workId: existing.workId, revisionId: existing.revisionId, title: existing.title, ordinalLabel: existing.ordinalLabel, duplicate: true });
      if (input.receipt) this.store.commit({ mutations: [], events: [], idempotencyKey: input.receipt.idempotencyKey, commandId: input.receipt.commandId, result });
      return result;
    }
    const revisionId = createId("rev");
    const title = (input.title ?? stem).trim() || stem;
    const mutations: Mutation[] = [];
    let resourceId = existing?.resourceId;
    let workId = existing?.workId ?? input.workId;
    let ordinal = input.ordinal ? { ...input.ordinal, label: ordinalLabel(input.ordinal) } : undefined;
    if (!resourceId) {
      resourceId = createId("res");
      if (!workId) {
        workId = createId("work");
        mutations.push({ sql: "INSERT INTO works(id,title,created_at,media_kind,updated_at) VALUES (?,?,?,?,?)", params: [workId, (input.workTitle ?? title).trim() || title, now, "video", now] });
      } else if (!this.store.sqlite.prepare("SELECT id FROM works WHERE id = ?").get(workId)) {
        throw new MangaError("NOT_FOUND", "work missing");
      }
      mutations.push({
        sql: "INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at, ordinal_label, ordinal_number, ordinal_type, sort_key) VALUES (?,?,?,?,?,?,?,?,?,?)",
        params: [resourceId, workId, "video", title, JSON.stringify([title]), now, ordinal?.label ?? null, ordinal?.number ?? null, ordinal?.type ?? null, input.sortKey ?? sortKeyFor(ordinal, title)],
      });
      mutations.push({
        sql: "UPDATE works SET updated_at = ?, media_kind = COALESCE((SELECT r.kind FROM resources r WHERE r.work_id = works.id ORDER BY r.sort_key, r.created_at, r.id LIMIT 1), media_kind) WHERE id = ?",
        params: [now, workId],
      });
      mutations.push(...this.store.indexFragment({ id: createId("frag"), resourceId, kind: "title", text: title }));
    } else {
      ordinal = undefined;
    }
    const info: VideoRevisionInfo = { durationMs: probe.durationMs, container: probe.container, startMs: probe.startMs, hasSubtitles: probe.streams.some((stream) => stream.type === "subtitle") || probe.externalSubtitles.length > 0 };
    const warnings: string[] = [];
    if (!probe.durationMs) warnings.push("the container does not state a duration");
    const payload = {
      id: revisionId,
      format: "video",
      parserId: VIDEO_PARSER_ID,
      parts: [] as Array<{ id?: string }>,
      toc: probe.chapters.map((chapter, index) => ({ label: chapter.title ?? `#${index + 1}`, startMs: chapter.startMs })),
      traits: { container: probe.container, streams: probe.streams.length, chapters: probe.chapters.length },
      warnings,
      video: info,
    };
    mutations.push({
      sql: "INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at, layout_json) VALUES (?,?,?,?,?,?,?)",
      params: [revisionId, resourceId, input.fingerprint, VIDEO_PARSER_ID, JSON.stringify(payload), now, JSON.stringify(layoutFromPayload(payload))],
    });
    mutations.push({
      sql: "INSERT INTO file_locations(id, resource_revision_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,1,0)",
      params: [createId("loc"), revisionId, sourcePath, input.fingerprint],
    });
    mutations.push({
      sql: "INSERT INTO media_probes(resource_revision_id, probe_json, tool_version, created_at) VALUES (?,?,?,?)",
      params: [revisionId, JSON.stringify(probe), `${probe.tool.name} ${probe.tool.version}`, now],
    });
    const result = summary({ resourceId, workId: workId!, revisionId, title, ordinalLabel: ordinal?.label ?? null, replaced: Boolean(existing), warnings });
    this.store.commit({
      mutations,
      events: [{ type: "resource.imported", payload: { resourceId, revisionId, format: "video" } }],
      ...(input.receipt ? { idempotencyKey: input.receipt.idempotencyKey, commandId: input.receipt.commandId, result } : {}),
    });
    return result;
  }

  async importOne(input: { sourcePath: string; title?: string; workTitle?: string; workId?: string; ordinal?: Ordinal; sortKey?: string; signal?: AbortSignal; receipt?: { idempotencyKey: string; commandId: string } }): Promise<VideoImportResult> {
    const probe = await this.probeFile(input.sourcePath, input.signal);
    const fingerprint = await sampledFingerprint(input.sourcePath, input.signal);
    input.signal?.throwIfAborted();
    const stem = path.basename(input.sourcePath, path.extname(input.sourcePath));
    const parsed = parseOrdinalName(stem, "video");
    const result = this.persist({
      sourcePath: input.sourcePath, probe, fingerprint, title: input.title ?? stem,
      workTitle: input.workTitle ?? parsed.title ?? stem, workId: input.workId, ordinal: input.ordinal ?? ordinalFromParsed(parsed), sortKey: input.sortKey, receipt: input.receipt,
    });
    if (!result.duplicate) this.queueFrameIndex(result.revisionId);
    return result;
  }

  /** Every video below the folder becomes one episode of one work, in episode order. */
  async importDirectory(input: {
    root: string;
    title?: string;
    workId?: string;
    signal?: AbortSignal;
    progress?: (done: number, total: number, label: string) => void;
    receipt?: { idempotencyKey: string; commandId: string };
  }): Promise<{ workId: string; resources: Array<VideoImportResult | { relative: string; error: { code: string; message: string } }>; truncated: boolean }> {
    if (!(await fsp.stat(input.root).catch(() => null))?.isDirectory()) throw new MangaError("NOT_FOUND", "the folder is not available");
    const plan = (await planDirectoryAsync(input.root, ["video"], { signal: input.signal })).video;
    if (!plan.items.length) throw new MangaError("UNSUPPORTED_FORMAT", "the folder holds no video files");
    const nested = plan.items.some((item) => item.relative.includes("/"));
    // Season folders repeat episode numbers, so a nested layout keeps the walk order; a flat one orders by episode number.
    const workTitle = input.title ?? titleFromParsed(plan.items.map((item) => item.name.replace(/\.[^.]+$/, ""))) ?? path.basename(input.root);
    const results: Array<VideoImportResult | { relative: string; error: { code: string; message: string } }> = [];
    let workId = input.workId;
    let done = 0;
    for (const item of plan.items) {
      input.signal?.throwIfAborted();
      input.progress?.(done, plan.items.length, item.relative);
      try {
        const stem = item.name.replace(/\.[^.]+$/, "");
        const sortKey = nested ? `1|${String(done).padStart(12, "0")}|${stem.toLowerCase()}` : undefined;
        const result = await this.importOne({ sourcePath: item.path, title: stem, workTitle, workId, sortKey, signal: input.signal });
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
    if (!workId) throw new MangaError("UNSUPPORTED_FORMAT", "none of the videos in the folder could be read", { details: { failures: results.length } });
    const value = { workId, resources: results, truncated: plan.truncated };
    if (input.receipt) this.store.commit({ mutations: [], events: [], idempotencyKey: input.receipt.idempotencyKey, commandId: input.receipt.commandId, result: value });
    return value;
  }

  // ------------------------------------------------------------------ reading

  private rowByRevision(revisionId: string): Row {
    const row = this.store.sqlite.prepare(`SELECT r.id AS resourceId, r.title AS title, v.id AS revisionId, p.probe_json AS probe FROM resource_revisions v
      JOIN resources r ON r.id = v.resource_id LEFT JOIN media_probes p ON p.resource_revision_id = v.id WHERE v.id = ?`).get(revisionId) as { resourceId: string; title: string; revisionId: string; probe: string | null } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "revision missing");
    return this.finishRow(row);
  }

  private finishRow(row: { resourceId: string; title: string; revisionId: string; probe: string | null }): Row {
    if (!row.probe) throw new MangaError("UNSUPPORTED_FORMAT", "this resource is not a video");
    const location = this.store.sqlite.prepare("SELECT relative_path, available FROM file_locations WHERE resource_revision_id = ? ORDER BY rowid DESC LIMIT 1").get(row.revisionId) as { relative_path: string; available: number } | undefined;
    const exists = location ? fs.existsSync(location.relative_path) : false;
    if (location && !exists && location.available === 1) this.store.sqlite.prepare("UPDATE file_locations SET available = 0 WHERE resource_revision_id = ?").run(row.revisionId);
    if (location && exists && location.available === 0) this.store.sqlite.prepare("UPDATE file_locations SET available = 1 WHERE resource_revision_id = ?").run(row.revisionId);
    return { revisionId: row.revisionId, resourceId: row.resourceId, title: row.title, probe: JSON.parse(row.probe) as VideoProbe, path: location?.relative_path ?? "", available: exists };
  }

  load(resourceId: string, revisionId?: string): Row {
    const row = (revisionId
      ? this.store.sqlite.prepare(`SELECT r.id AS resourceId, r.title AS title, v.id AS revisionId, p.probe_json AS probe FROM resources r JOIN resource_revisions v ON v.id = ? AND v.resource_id = r.id LEFT JOIN media_probes p ON p.resource_revision_id = v.id WHERE r.id = ?`).get(revisionId, resourceId)
      : this.store.sqlite.prepare(`SELECT r.id AS resourceId, r.title AS title, v.id AS revisionId, p.probe_json AS probe FROM resources r JOIN resource_revisions v ON v.resource_id = r.id LEFT JOIN media_probes p ON p.resource_revision_id = v.id WHERE r.id = ? ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1`).get(resourceId)) as { resourceId: string; title: string; revisionId: string; probe: string | null } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "resource missing");
    return this.finishRow(row);
  }

  private requireFile(row: Row): string {
    if (!row.available) throw new MangaError("NOT_FOUND", "the video file is not available; point the library at it again");
    return row.path;
  }

  async probe(resourceId: string, revisionId: string | undefined, refresh = false, signal?: AbortSignal) {
    const row = this.load(resourceId, revisionId);
    let probe = row.probe;
    if (refresh) {
      const file = this.requireFile(row);
      const fresh = await this.probeFile(file, signal);
      probe = { ...fresh, keyframesMs: probe.keyframesMs, keyframesTruncated: probe.keyframesTruncated, variableFrameRate: probe.variableFrameRate };
      this.store.sqlite.prepare("UPDATE media_probes SET probe_json = ?, tool_version = ? WHERE resource_revision_id = ?").run(JSON.stringify(probe), `${probe.tool.name} ${probe.tool.version}`, row.revisionId);
    }
    return { resourceId: row.resourceId, revisionId: row.revisionId, available: row.available, probe };
  }

  tracks(resourceId: string, revisionId?: string) {
    const row = this.load(resourceId, revisionId);
    return { resourceId: row.resourceId, revisionId: row.revisionId, available: row.available, ...listTracks(row.probe) };
  }

  // ------------------------------------------------------------------ frame index

  private indexFile(revisionId: string): string {
    return path.join(this.media.dir("frame-index"), `${revisionId}.json`);
  }

  private readIndex(revisionId: string): FrameIndex | null {
    const cached = this.memoryIndex.get(revisionId);
    if (cached) return cached;
    const file = this.indexFile(revisionId);
    if (!fs.existsSync(file)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as FrameIndex;
      if (parsed.version !== 1 || !Array.isArray(parsed.ptsMs)) return null;
      this.remember(revisionId, parsed);
      return parsed;
    } catch {
      fs.rmSync(file, { force: true });
      return null;
    }
  }

  private remember(revisionId: string, index: FrameIndex): void {
    this.memoryIndex.delete(revisionId);
    this.memoryIndex.set(revisionId, index);
    while (this.memoryIndex.size > 4) this.memoryIndex.delete(this.memoryIndex.keys().next().value as string);
  }

  /** Build the frame index in the background; the player waits for it only when someone asks for a frame. */
  queueFrameIndex(revisionId: string): { id: string; promise: Promise<FrameIndex> } | null {
    if (!this.media.ffmpeg.available) return null;
    if (this.readIndex(revisionId)) return null;
    const job = this.media.jobs.submit<FrameIndex>({
      lane: "probe", kind: "frame-index", key: `frame-index:${revisionId}`, owner: VIDEO_MODULE,
      run: async ({ signal }) => this.buildIndex(revisionId, signal),
    });
    return { id: job.id, promise: job.promise };
  }

  private async buildIndex(revisionId: string, signal: AbortSignal): Promise<FrameIndex> {
    const existing = this.readIndex(revisionId);
    if (existing) return existing;
    const row = this.rowByRevision(revisionId);
    const file = this.requireFile(row);
    const video = row.probe.streams.find((stream) => stream.type === "video" && stream.fps !== undefined) ?? row.probe.streams.find((stream) => stream.type === "video");
    if (!video) throw new MangaError("UNSUPPORTED_FORMAT", "the file has no video stream");
    const timeline = await this.media.ffmpeg.packetTimeline(file, video.index, row.probe.startMs, { signal });
    if (!timeline.ptsMs.length) throw new MangaError("UNSUPPORTED_FORMAT", "no frame times could be read from the file");
    const index: FrameIndex = { version: 1, streamIndex: video.index, startMs: row.probe.startMs, ptsMs: timeline.ptsMs, keyframesMs: timeline.keyframesMs, variableFrameRate: timeline.variableFrameRate };
    const target = this.indexFile(revisionId);
    const staging = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(staging, JSON.stringify(index));
    fs.renameSync(staging, target);
    this.remember(revisionId, index);
    const probe: VideoProbe = { ...row.probe, keyframesMs: timeline.keyframesMs.slice(0, KEYFRAME_LIMIT), keyframesTruncated: timeline.keyframesMs.length > KEYFRAME_LIMIT, variableFrameRate: timeline.variableFrameRate };
    this.store.sqlite.prepare("UPDATE media_probes SET probe_json = ? WHERE resource_revision_id = ?").run(JSON.stringify(probe), revisionId);
    return index;
  }

  async index(resourceId: string, revisionId?: string, signal?: AbortSignal): Promise<{ revisionId: string; index: FrameIndex; durationMs: number }> {
    const row = this.load(resourceId, revisionId);
    const cached = this.readIndex(row.revisionId);
    if (cached) return { revisionId: row.revisionId, index: cached, durationMs: row.probe.durationMs };
    if (!this.media.ffmpeg.available) throw new MangaError("CAPABILITY_UNAVAILABLE", "the media tool is not installed");
    const job = this.media.jobs.submit<FrameIndex>({
      lane: "probe", kind: "frame-index", key: `frame-index:${row.revisionId}`, owner: VIDEO_MODULE,
      run: async (context) => this.buildIndex(row.revisionId, context.signal),
    });
    const onAbort = () => job.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return { revisionId: row.revisionId, index: await job.promise, durationMs: row.probe.durationMs };
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Which frame is on screen at a time, or at a frame number, or `delta` frames from either. Uses the stored presentation times, never an average frame rate. */
  async frame(resourceId: string, revisionId: string | undefined, query: { timeMs?: number; frame?: number; delta?: number }, signal?: AbortSignal): Promise<FrameAnswer & { revisionId: string }> {
    const { revisionId: id, index, durationMs } = await this.index(resourceId, revisionId, signal);
    const pts = index.ptsMs;
    let frame: number;
    if (query.frame !== undefined) {
      if (query.frame >= pts.length) throw new MangaError("NOT_FOUND", `the video has ${pts.length} frames`);
      frame = query.frame;
    } else {
      const time = query.timeMs ?? 0;
      let low = 0;
      let high = pts.length - 1;
      // Last frame whose presentation time is not after `time` (a half-millisecond of slack absorbs rounding).
      while (low < high) {
        const mid = (low + high + 1) >> 1;
        if (pts[mid]! <= time + 0.5) low = mid; else high = mid - 1;
      }
      frame = low;
    }
    frame = Math.max(0, Math.min(pts.length - 1, frame + (query.delta ?? 0)));
    return {
      revisionId: id, frame, ptsMs: pts[frame]!, totalFrames: pts.length, durationMs, variableFrameRate: index.variableFrameRate,
      previousMs: frame > 0 ? pts[frame - 1]! : null, nextMs: frame + 1 < pts.length ? pts[frame + 1]! : null,
    };
  }

  // ------------------------------------------------------------------ playback

  playbackPlan(resourceId: string, revisionId: string | undefined, caps: PlaybackCaps, audioStreamIndex?: number) {
    const row = this.load(resourceId, revisionId);
    const plan = decidePlayback(row.probe, caps, audioStreamIndex === undefined ? {} : { audioStreamIndex });
    const copy = plan.copy ? this.copies.find(row.revisionId, plan.copy.reason, plan.audioStreamIndex) : null;
    return { resourceId: row.resourceId, revisionId: row.revisionId, available: row.available, plan, copy };
  }

  handle(resourceId: string, revisionId: string, input: { source: "original" | "play_copy"; copyId?: string; sessionId?: string }) {
    const row = this.load(resourceId, revisionId);
    const binding = { moduleId: VIDEO_MODULE, resourceId, revisionId, sessionId: input.sessionId };
    if (input.source === "original") {
      const file = this.requireFile(row);
      const issued = this.media.handles.issue({ kind: "file", path: file, mediaType: mediaTypeFor(row.probe) }, binding, { ttlMs: HANDLE_TTL_MS });
      return { source: "original" as const, url: issued.url, handle: issued.handle, mediaType: mediaTypeFor(row.probe), bytes: fs.statSync(file).size, startMs: row.probe.startMs };
    }
    const copy = this.copies.ready(revisionId, input.copyId);
    const issued = this.media.handles.issue({ kind: "file", path: copy.path, mediaType: "video/mp4" }, { ...binding, subject: `play-copy:${copy.id}` }, { ttlMs: HANDLE_TTL_MS });
    return { source: "play_copy" as const, url: issued.url, handle: issued.handle, mediaType: "video/mp4", bytes: copy.bytes, startMs: 0, copyId: copy.id };
  }

  // ------------------------------------------------------------------ subtitles and fonts

  private subtitleDir(revisionId: string): string {
    return this.media.dir("subtitles", revisionId);
  }

  private sidecarOf(row: Row, id: string): Sidecar {
    const found = discoverSidecars(this.requireFile(row)).find((item) => item.id === id);
    if (!found) throw new MangaError("NOT_FOUND", "subtitle file is not next to the video any more");
    return found;
  }

  /** Subtitle text in the form the player takes: ASS stays ASS (for JASSUB), everything else becomes WebVTT. UTF-8 whatever the source encoding was. */
  async subtitleFile(resourceId: string, revisionId: string, trackId: string, signal?: AbortSignal): Promise<{ path: string; format: "ass" | "vtt"; language: string | null; title: string | null }> {
    const row = this.load(resourceId, revisionId);
    const dir = this.subtitleDir(revisionId);
    if (trackId.startsWith("x")) {
      const sidecar = this.sidecarOf(row, trackId);
      const format = sidecar.format === "ass" ? "ass" : "vtt";
      const target = path.join(dir, `${trackId}.${format}`);
      if (!fs.existsSync(target)) {
        const text = decodeTextBuffer(new Uint8Array(fs.readFileSync(sidecar.absolutePath))).text;
        if (sidecar.format === "srt") {
          const staged = path.join(dir, `${trackId}.src.srt`);
          fs.writeFileSync(staged, text, "utf8");
          const run = await this.media.ffmpeg.run("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", staged, "-f", "webvtt", target], { signal, timeoutMs: 60_000, redactPaths: [dir] });
          void run;
          fs.rmSync(staged, { force: true });
        } else if (sidecar.format === "vtt") {
          fs.writeFileSync(target, text.replace(/^﻿/, ""), "utf8");
        } else {
          fs.writeFileSync(target, text.replace(/^﻿/, ""), "utf8");
        }
      }
      return { path: target, format, language: sidecar.language ?? null, title: sidecar.fileName };
    }
    const match = /^s(\d+)$/.exec(trackId);
    const stream = match ? row.probe.streams.find((item) => item.type === "subtitle" && item.index === Number(match[1])) : undefined;
    if (!stream) throw new MangaError("NOT_FOUND", "subtitle track does not exist");
    if (!stream.textual) throw new MangaError("UNSUPPORTED_FORMAT", "image subtitles cannot be shown as text");
    const format = stream.codec === "ass" || stream.codec === "ssa" ? "ass" : "vtt";
    const target = path.join(dir, `${trackId}.${format}`);
    if (!fs.existsSync(target)) {
      const text = await this.media.ffmpeg.subtitleText(this.requireFile(row), stream.index, format === "ass" ? "ass" : "webvtt", { signal });
      const staging = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(staging, text, "utf8");
      fs.renameSync(staging, target);
    }
    return { path: target, format, language: stream.language ?? null, title: stream.title ?? null };
  }

  async subtitleHandle(resourceId: string, revisionId: string, trackId: string, sessionId?: string, signal?: AbortSignal) {
    const file = await this.subtitleFile(resourceId, revisionId, trackId, signal);
    const mediaType = SUBTITLE_MEDIA_TYPES[file.format];
    const issued = this.media.handles.issue({ kind: "file", path: file.path, mediaType }, { moduleId: VIDEO_MODULE, resourceId, revisionId, sessionId }, { ttlMs: HANDLE_TTL_MS });
    return { trackId, format: file.format, language: file.language, title: file.title, url: issued.url, handle: issued.handle, mediaType };
  }

  /** Fonts attached to the container, written once to the cache under names this code chose, and served by handle. */
  async fonts(resourceId: string, revisionId: string, sessionId?: string, signal?: AbortSignal) {
    const row = this.load(resourceId, revisionId);
    const attachments = row.probe.streams.filter((stream) => stream.type === "attachment" && FONT_TYPES[path.extname(stream.fileName ?? "").toLowerCase()]);
    if (!attachments.length) return { fonts: [] as Array<{ id: string; fileName: string; mediaType: string; url: string }> };
    const dir = this.media.dir("fonts", revisionId);
    const items = attachments.map((stream) => ({ stream, outName: `f${stream.index}${path.extname(stream.fileName!).toLowerCase()}` }));
    const missing = items.filter((item) => !fs.existsSync(path.join(dir, item.outName)));
    if (missing.length) await this.media.ffmpeg.dumpAttachments(this.requireFile(row), missing.map((item) => ({ streamIndex: item.stream.index, outName: item.outName })), dir, { signal });
    return {
      fonts: items.map(({ stream, outName }) => {
        const mediaType = FONT_TYPES[path.extname(outName)]!;
        const issued = this.media.handles.issue({ kind: "file", path: path.join(dir, outName), mediaType }, { moduleId: VIDEO_MODULE, resourceId, revisionId, sessionId }, { ttlMs: HANDLE_TTL_MS });
        return { id: `f${stream.index}`, fileName: stream.fileName!, mediaType, url: issued.url };
      }),
    };
  }

  /** The text of the best subtitle track as cues, for search and Agent context. */
  async cues(resourceId: string, revisionId: string, trackId?: string, signal?: AbortSignal): Promise<{ trackId: string | null; cues: Cue[] }> {
    const row = this.load(resourceId, revisionId);
    const list = listTracks(row.probe).subtitles.filter((track) => track.format !== null && (track.source === "external" || row.probe.streams.find((s) => s.index === track.streamIndex)?.textual));
    if (!list.length) return { trackId: null, cues: [] };
    const chinese = (language: string | null) => language !== null && /^(zh|chi|zho|chs|cht|sc|tc)/i.test(language);
    const chosen = (trackId ? list.find((track) => track.id === trackId) : undefined)
      ?? list.find((track) => chinese(track.language)) ?? list.find((track) => track.default) ?? list[0]!;
    const key = `${revisionId}:${chosen.id}`;
    const cached = this.cueCache.get(key);
    if (cached) return { trackId: chosen.id, cues: cached };
    const file = await this.subtitleFile(resourceId, revisionId, chosen.id, signal);
    const cues = parseCues(fs.readFileSync(file.path, "utf8"), file.format);
    this.cueCache.set(key, cues);
    while (this.cueCache.size > 6) this.cueCache.delete(this.cueCache.keys().next().value as string);
    return { trackId: chosen.id, cues };
  }

  async subtitleWindow(resourceId: string, revisionId: string, input: { centerMs: number; beforeMs?: number; afterMs?: number; limitMs?: number }, signal?: AbortSignal) {
    const { trackId, cues } = await this.cues(resourceId, revisionId, undefined, signal);
    const before = input.beforeMs ?? 30_000;
    const after = input.afterMs ?? 0;
    return { trackId, cues: cueWindow(cues, input.centerMs - before, input.centerMs + after, input.limitMs) };
  }

  /** A frame of the video as JPEG at a time on the original timeline. */
  async frameImage(resourceId: string, revisionId: string, timeMs: number, maxEdge: number, signal?: AbortSignal): Promise<Buffer> {
    const row = this.load(resourceId, revisionId);
    const file = this.requireFile(row);
    return this.media.ffmpeg.frameJpeg(file, (timeMs + row.probe.startMs) / 1000, maxEdge, { signal });
  }

  /** A still for the library: about a tenth of the way in, where credits and logos are rarely. */
  async coverFrame(resourceId: string, revisionId: string, signal?: AbortSignal): Promise<Buffer> {
    const row = this.load(resourceId, revisionId);
    const at = Math.max(0, Math.min(row.probe.durationMs - 500, Math.round(row.probe.durationMs * 0.1)));
    return this.frameImage(resourceId, revisionId, at, 720, signal);
  }

  static reasonLabel(reason: PlayCopyReason | "unsupported_container"): string {
    return reason;
  }
}
