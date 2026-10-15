import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_ROUGHCUT_OPTIONS, MangaError, createId, type RoughcutActionInput, type RoughcutClipPlan, type RoughcutExportOptions, type RoughcutExportView, type RoughcutPlan, type RoughcutProblem, type RoughcutStreams,
} from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import type { FfmpegService } from "../media/ffmpeg.ts";
import type { VideoService } from "../video/service.ts";
import type { WorkFolders } from "../work-folders.ts";
import { applyOps, diffRows, OpLog, type OpState, type RowOp } from "./ops.ts";
import { RoughcutExports, type ExportDestination } from "./roughcut-export.ts";
import { compareStreams, outputExtension, planClipCut, streamsFromProbe, trackProblems } from "./roughcut-plan.ts";
import { KEY_LIMIT, evenKeys, keyBetween } from "./sort-key.ts";

type CutRow = { id: string; project_id: string | null; title: string; created_at: string; updated_at: string };
type ClipRow = { id: string; cut_id: string; resource_id: string; resource_revision_id: string; in_ms: number; out_ms: number; sort_key: string; label: string; created_at: string };

export type CutSummary = { id: string; projectId: string | null; title: string; clips: number; totalMs: number; createdAt: string; updatedAt: string };
export type ClipView = { id: string; resourceId: string; revisionId: string; title: string; label: string; inMs: number; outMs: number; sortKey: string; available: boolean; durationMs: number | null };
export type CutDoc = { cut: { id: string; projectId: string | null; title: string; createdAt: string; updatedAt: string }; clips: ClipView[]; totalMs: number; ops: OpState; exporting: boolean };

const CLIP_COLUMNS = ["id", "cut_id", "resource_id", "resource_revision_id", "in_ms", "out_ms", "sort_key", "label", "created_at"] as const;
const TABLES = { rough_cut_clips: CLIP_COLUMNS, rough_cuts: ["title", "updated_at"] } as const;
const MAX_CLIPS = 200;
const MAX_CUTS_PER_PROJECT = 100;
/** A mark made at the very end of a video may sit a little past the last frame's time. */
const END_SLACK_MS = 1000;
const bad = (message: string, reason: string) => new MangaError("VALIDATION_ERROR", message, { details: { reason } });

export type RoughcutOptions = {
  store: DrizzleStore;
  ops: OpLog;
  videos: VideoService;
  ffmpeg: FfmpegService;
  /** The folders of the works: an export that is not told where to go is put in the folder of the work of its first clip. */
  folders: WorkFolders;
  stagingRoot: string;
  notify: (topic: string, payload: Record<string, unknown>) => void;
};

/** The working copy of a cut while one edit runs. */
class Draft {
  readonly clips = new Map<string, ClipRow>();
  readonly now = new Date().toISOString();
  readonly cutId: string;

  constructor(cutId: string, rows: ClipRow[]) {
    this.cutId = cutId;
    for (const row of rows) this.clips.set(row.id, { ...row });
  }

  clip(id: string): ClipRow {
    const found = this.clips.get(id);
    if (!found) throw new MangaError("NOT_FOUND", "a clip of the sequence does not exist");
    return found;
  }

  ordered(except?: string): ClipRow[] {
    return [...this.clips.values()].filter((row) => row.id !== except).sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : a.id < b.id ? -1 : 1));
  }

  /** A key that puts a clip at `index` (the clip being moved is not counted), renumbering the others when the keys have grown long. */
  keyAt(index: number | undefined, except?: string): string {
    const siblings = this.ordered(except);
    const at = index === undefined ? siblings.length : Math.min(index, siblings.length);
    const key = keyBetween(siblings[at - 1]?.sort_key ?? null, siblings[at]?.sort_key ?? null);
    if (key.length <= KEY_LIMIT) return key;
    const fresh = evenKeys(siblings.length + 1);
    siblings.forEach((row, i) => { row.sort_key = fresh[i < at ? i : i + 1]!; });
    return fresh[at]!;
  }
}

/**
 * Rough cuts (CLIP-01/02): a sequence of clips, each the stretch of one video a person marked. The sequence is edited like a map or a board (one
 * change is a list of steps with its inverse, so undo and redo survive a restart), and a clip keeps the revision of the video it was marked on.
 * Before anything is exported the plan says whether the clips can be joined without re-encoding and what each copy will actually hold.
 */
export class RoughcutService {
  private readonly o: RoughcutOptions;
  readonly exports: RoughcutExports;
  private readonly streamCache = new Map<string, RoughcutStreams | null>();

  constructor(options: RoughcutOptions) {
    this.o = options;
    this.exports = new RoughcutExports({ store: options.store, ffmpeg: options.ffmpeg, stagingRoot: options.stagingRoot, notify: options.notify });
  }

  private get sqlite() { return this.o.store.sqlite; }

  exists(cutId: string): boolean {
    return Boolean(this.sqlite.prepare("SELECT 1 FROM rough_cuts WHERE id = ?").get(cutId));
  }

  private cut(cutId: string): CutRow {
    const row = this.sqlite.prepare("SELECT * FROM rough_cuts WHERE id = ?").get(cutId) as CutRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the sequence does not exist");
    return row;
  }

  private rows(cutId: string): ClipRow[] {
    return this.sqlite.prepare("SELECT * FROM rough_cut_clips WHERE cut_id = ? ORDER BY sort_key, id").all(cutId) as ClipRow[];
  }

  private summary(row: CutRow): CutSummary {
    const total = this.sqlite.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(out_ms - in_ms), 0) AS ms FROM rough_cut_clips WHERE cut_id = ?").get(row.id) as { n: number; ms: number };
    return { id: row.id, projectId: row.project_id, title: row.title, clips: total.n, totalMs: total.ms, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  list(projectId?: string): { cuts: CutSummary[] } {
    const rows = (projectId
      ? this.sqlite.prepare("SELECT * FROM rough_cuts WHERE project_id = ? ORDER BY updated_at DESC, id").all(projectId)
      : this.sqlite.prepare("SELECT * FROM rough_cuts ORDER BY updated_at DESC, id").all()) as CutRow[];
    return { cuts: rows.map((row) => this.summary(row)) };
  }

  create(input: { projectId: string; title: string }): CutSummary {
    if (!this.sqlite.prepare("SELECT 1 FROM projects WHERE id = ?").get(input.projectId)) throw new MangaError("NOT_FOUND", "the project does not exist");
    const have = (this.sqlite.prepare("SELECT COUNT(*) AS n FROM rough_cuts WHERE project_id = ?").get(input.projectId) as { n: number }).n;
    if (have >= MAX_CUTS_PER_PROJECT) throw bad("this project already has too many sequences", "limit");
    const id = createId("rcs");
    const now = new Date().toISOString();
    this.sqlite.transaction(() => {
      this.sqlite.prepare("INSERT INTO rough_cuts(id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)").run(id, input.projectId, input.title, now, now);
      this.sqlite.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, input.projectId);
    })();
    return this.summary(this.cut(id));
  }

  rename(cutId: string, title: string): CutSummary {
    this.cut(cutId);
    this.sqlite.prepare("UPDATE rough_cuts SET title = ?, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), cutId);
    return this.summary(this.cut(cutId));
  }

  delete(cutId: string): { cutId: string; removedClips: number } {
    this.cut(cutId);
    if (this.exports.busy(cutId)) throw new MangaError("VALIDATION_ERROR", "this sequence is being exported", { details: { reason: "busy" } });
    return this.sqlite.transaction(() => {
      const removed = Number(this.sqlite.prepare("DELETE FROM rough_cut_clips WHERE cut_id = ?").run(cutId).changes);
      this.o.ops.clear("roughcut", cutId);
      this.exports.deleteFor(cutId);
      this.sqlite.prepare("DELETE FROM rough_cuts WHERE id = ?").run(cutId);
      return { cutId, removedClips: removed };
    })();
  }

  private clipView(row: ClipRow): ClipView {
    let title = "";
    let available = false;
    let durationMs: number | null = null;
    try {
      const video = this.o.videos.load(row.resource_id, row.resource_revision_id);
      title = video.title;
      available = video.available;
      durationMs = video.probe?.durationMs ?? null;
    } catch {
      // The video is gone from the library: the clip stays, marked as missing, so the sequence is not silently shortened.
      title = (this.sqlite.prepare("SELECT title FROM resources WHERE id = ?").get(row.resource_id) as { title: string } | undefined)?.title ?? "";
    }
    return { id: row.id, resourceId: row.resource_id, revisionId: row.resource_revision_id, title, label: row.label, inMs: row.in_ms, outMs: row.out_ms, sortKey: row.sort_key, available, durationMs };
  }

  get(cutId: string): CutDoc {
    const row = this.cut(cutId);
    const clips = this.rows(cutId).map((clip) => this.clipView(clip));
    return {
      cut: { id: row.id, projectId: row.project_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at },
      clips, totalMs: clips.reduce((sum, clip) => sum + (clip.outMs - clip.inMs), 0), ops: this.o.ops.state("roughcut", cutId), exporting: this.exports.busy(cutId),
    };
  }

  // ------------------------------------------------------------------ editing

  edit(input: { cutId: string; label?: string; actions: RoughcutActionInput[] }): { doc: CutDoc; created: string[] } {
    const row = this.cut(input.cutId);
    if (this.exports.busy(row.id)) throw new MangaError("VALIDATION_ERROR", "this sequence is being exported", { details: { reason: "busy" } });
    return this.sqlite.transaction(() => {
      const before = this.rows(row.id);
      const draft = new Draft(row.id, before);
      const created: string[] = [];
      for (const action of input.actions) this.apply(draft, action, created);
      if (draft.clips.size > MAX_CLIPS) throw bad("the sequence has too many clips", "limit");
      const b = new Map<string, Record<string, unknown> | null>(before.map((clip) => [clip.id, clip as unknown as Record<string, unknown>]));
      const a = new Map<string, Record<string, unknown> | null>([...draft.clips].map(([id, clip]) => [id, clip as unknown as Record<string, unknown>]));
      for (const clip of before) if (!draft.clips.has(clip.id)) a.set(clip.id, null);
      const { forward, inverse } = diffRows("rough_cut_clips", b, a);
      if (!forward.length) return { doc: this.get(row.id), created };
      applyOps(this.o.store, forward, TABLES);
      this.sqlite.prepare("UPDATE rough_cuts SET updated_at = ? WHERE id = ?").run(draft.now, row.id);
      this.o.ops.record("roughcut", row.id, input.label ?? input.actions[0]!.type, forward, inverse);
      return { doc: this.get(row.id), created };
    })();
  }

  undo(cutId: string): { doc: CutDoc; label: string } { return this.step(cutId, "undo"); }
  redo(cutId: string): { doc: CutDoc; label: string } { return this.step(cutId, "redo"); }

  private step(cutId: string, direction: "undo" | "redo"): { doc: CutDoc; label: string } {
    this.cut(cutId);
    if (this.exports.busy(cutId)) throw new MangaError("VALIDATION_ERROR", "this sequence is being exported", { details: { reason: "busy" } });
    return this.sqlite.transaction(() => {
      const label = this.o.ops[direction]("roughcut", cutId, (ops: RowOp[]) => applyOps(this.o.store, ops, TABLES));
      if (label === null) throw new MangaError("NOT_FOUND", direction === "undo" ? "there is nothing to undo" : "there is nothing to redo");
      this.sqlite.prepare("UPDATE rough_cuts SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), cutId);
      return { doc: this.get(cutId), label };
    })();
  }

  /** A video, and the stretch of it, checked as something a clip can point at. */
  private checkRange(resourceId: string, revisionId: string | undefined, inMs: number, outMs: number): { revisionId: string } {
    let video;
    try { video = this.o.videos.load(resourceId, revisionId); } catch (error) {
      if (error instanceof MangaError && error.code === "UNSUPPORTED_FORMAT") throw bad("that is not a video", "not-video");
      throw new MangaError("NOT_FOUND", "the video does not exist");
    }
    if (!video.probe?.streams?.some((stream) => stream.type === "video")) throw bad("that is not a video", "not-video");
    if (!(outMs > inMs)) throw bad("a clip must end after it starts", "range");
    if (outMs > video.probe.durationMs + END_SLACK_MS) throw bad("the clip ends after the video does", "range");
    return { revisionId: video.revisionId };
  }

  private apply(draft: Draft, action: RoughcutActionInput, created: string[]): void {
    switch (action.type) {
      case "add": {
        const id = action.id ?? createId("rcc");
        if (draft.clips.has(id)) throw bad("a clip with that id is already in the sequence", "duplicate");
        const { revisionId } = this.checkRange(action.resourceId, action.resourceRevisionId, action.inMs, action.outMs);
        draft.clips.set(id, { id, cut_id: draft.cutId, resource_id: action.resourceId, resource_revision_id: revisionId, in_ms: action.inMs, out_ms: action.outMs, sort_key: draft.keyAt(action.index), label: action.label ?? "", created_at: draft.now });
        created.push(id);
        return;
      }
      case "update": {
        const clip = draft.clip(action.clipId);
        const inMs = action.inMs ?? clip.in_ms;
        const outMs = action.outMs ?? clip.out_ms;
        this.checkRange(clip.resource_id, clip.resource_revision_id, inMs, outMs);
        clip.in_ms = inMs; clip.out_ms = outMs;
        if (action.label !== undefined) clip.label = action.label;
        return;
      }
      case "move": {
        const clip = draft.clip(action.clipId);
        clip.sort_key = draft.keyAt(action.index, clip.id);
        return;
      }
      case "remove": {
        draft.clip(action.clipId);
        draft.clips.delete(action.clipId);
        return;
      }
    }
  }

  // ------------------------------------------------------------------ plan

  /** The streams of a source as a copy cares about them, kept per file until the file changes. */
  private async streamsOf(file: string): Promise<RoughcutStreams | null> {
    const stat = fs.statSync(file);
    const key = `${file}|${stat.size}|${stat.mtimeMs}`;
    if (this.streamCache.has(key)) return this.streamCache.get(key)!;
    const run = await this.o.ffmpeg.run("ffprobe", ["-v", "error", "-hide_banner", "-print_format", "json", "-show_format", "-show_streams", "-show_data_hash", "SHA256", "-i", file], {
      timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024, redactPaths: [file, path.dirname(file)],
    });
    const streams = streamsFromProbe(JSON.parse(run.stdout.toString("utf8")));
    if (this.streamCache.size > 200) this.streamCache.delete(this.streamCache.keys().next().value!);
    this.streamCache.set(key, streams);
    return streams;
  }

  /**
   * Checks the sequence and says what an export would do: for every clip, where the copy really starts and ends, and whether the clips can be joined
   * (same container and codecs, picture size and rate, time base and audio). Changes nothing. A sequence that cannot be joined says why, clip by clip.
   */
  async plan(cutId: string, asked: RoughcutExportOptions = DEFAULT_ROUGHCUT_OPTIONS, signal?: AbortSignal): Promise<{ plan: RoughcutPlan; sources: Map<string, string>; streams: Map<string, RoughcutStreams> }> {
    const row = this.cut(cutId);
    const rows = this.rows(cutId);
    const merge = asked.mode === "merge";
    // Chapters belong to a merged file of more than one clip; elsewhere they are left out of the plan, not refused.
    const options: RoughcutExportOptions = {
      mode: asked.mode,
      ...(asked.audioTracks ? { audioTracks: [...new Set(asked.audioTracks)].sort((a, b) => a - b) } : {}),
      ...(asked.subtitleTracks ? { subtitleTracks: [...new Set(asked.subtitleTracks)].sort((a, b) => a - b) } : {}),
      ...(merge && asked.chapters === true && rows.length > 1 ? { chapters: true } : {}),
    };
    const problems: RoughcutProblem[] = [];
    const clips: RoughcutClipPlan[] = [];
    const sources = new Map<string, string>();
    const streamsOfClip = new Map<string, RoughcutStreams>();
    /** What stops a clip from being exported at all, and what stops it from being joined to the first one. */
    const own = new Map<string, RoughcutProblem[]>();
    const join = new Map<string, RoughcutProblem[]>();
    if (!rows.length) problems.push({ code: "empty" });
    let first: { streams: RoughcutStreams; name: string } | null = null;
    for (const clip of rows) {
      const view = this.clipView(clip);
      const entry: RoughcutClipPlan = {
        clipId: clip.id, resourceId: clip.resource_id, revisionId: clip.resource_revision_id, title: view.title, requestedInMs: clip.in_ms, requestedOutMs: clip.out_ms,
        actualInMs: clip.in_ms, actualOutMs: clip.out_ms, startShiftMs: 0, endShiftMs: 0, onKeyframe: false, frames: 0, extension: null, toEnd: false, frameGapMs: 0, problems: [],
      };
      clips.push(entry);
      const mine: RoughcutProblem[] = [];
      const joined: RoughcutProblem[] = [];
      own.set(clip.id, mine);
      join.set(clip.id, joined);
      if (!view.available) { mine.push({ code: "source-missing", clipId: clip.id }); continue; }
      const video = this.o.videos.load(clip.resource_id, clip.resource_revision_id);
      sources.set(clip.id, video.path);
      try {
        const { index } = await this.o.videos.index(clip.resource_id, clip.resource_revision_id, signal);
        const cut = planClipCut({ inMs: clip.in_ms, outMs: clip.out_ms }, index, video.probe.durationMs);
        for (const code of cut.problems) mine.push({ code, clipId: clip.id });
        if (!cut.problems.length) {
          Object.assign(entry, {
            actualInMs: cut.actualInMs, actualOutMs: cut.actualOutMs, startShiftMs: Math.round(clip.in_ms - cut.actualInMs), endShiftMs: Math.round(cut.actualOutMs - clip.out_ms),
            onKeyframe: cut.onKeyframe, frames: cut.frames, toEnd: cut.toEnd, frameGapMs: cut.frameGapMs,
          });
        }
        const streams = await this.streamsOf(video.path);
        if (!streams) { mine.push({ code: "no-video", clipId: clip.id }); continue; }
        streamsOfClip.set(clip.id, streams);
        // The file this clip alone would be written as. A merged export uses the first clip's.
        entry.extension = outputExtension(streams.container, path.basename(video.path));
        if (!entry.extension) mine.push({ code: "container", clipId: clip.id, detail: { first: streams.container, other: "-" } });
        if (!first) first = { streams, name: path.basename(video.path) };
        else joined.push(...compareStreams(first.streams, streams, clip.id, options));
      } catch (error) {
        if (error instanceof MangaError && (error.code === "CANCELLED" || error.code === "CAPABILITY_UNAVAILABLE")) throw error;
        mine.push({ code: "no-video", clipId: clip.id });
      }
    }
    const extension = first ? outputExtension(first.streams.container, first.name) : null;
    // The tracks that were chosen have to be in the clip's source and fit the container they are written to.
    for (const clip of clips) {
      const streams = streamsOfClip.get(clip.clipId);
      if (streams) own.get(clip.clipId)!.push(...trackProblems(streams, merge ? extension : clip.extension, options, clip.clipId));
    }
    const separable = clips.length > 0 && clips.every((clip) => own.get(clip.clipId)!.length === 0);
    const joinable = [...join.values()].every((list) => list.length === 0);
    for (const clip of clips) clip.problems = merge ? [...own.get(clip.clipId)!, ...join.get(clip.clipId)!] : [...own.get(clip.clipId)!];
    for (const clip of clips) problems.push(...clip.problems);
    if (merge && first && !extension) problems.push({ code: "container", detail: { first: first.streams.container, other: "-" } });
    const tool = this.o.ffmpeg.available ? await this.o.ffmpeg.version() : "";
    const plan: RoughcutPlan = {
      cutId, title: row.title, options, compatible: separable && joinable && extension !== null, separable, problems, clips,
      tracks: {
        audio: (first?.streams.audio ?? []).map((track) => ({ codec: track.codec, channels: track.channels, language: track.language, title: track.title })),
        subtitle: (first?.streams.subtitle ?? []).map((track) => ({ codec: track.codec, language: track.language, title: track.title })),
      },
      requestedMs: clips.reduce((sum, clip) => sum + (clip.requestedOutMs - clip.requestedInMs), 0),
      actualMs: Math.round(clips.reduce((sum, clip) => sum + (clip.actualOutMs - clip.actualInMs), 0)),
      container: first?.streams.container ?? null, extension, streams: first?.streams ?? null, tool,
    };
    return { plan, sources, streams: streamsOfClip };
  }

  /**
   * Plans, and when the plan holds, starts the export. With `dir` the files go there; without it, into the folder of the work of the first clip
   * (the sub-folder for rough cuts), and each is written down as a file of that work.
   */
  async startExport(input: { cutId: string; dir?: string; fileName?: string; options?: RoughcutExportOptions }, signal?: AbortSignal): Promise<RoughcutExportView> {
    if (!this.o.ffmpeg.available) throw new MangaError("CAPABILITY_UNAVAILABLE", "the media tool is not installed");
    const { plan, sources, streams } = await this.plan(input.cutId, input.options, signal);
    const chapterTitles = new Map<string, string>();
    for (const clip of this.rows(input.cutId)) {
      const view = this.clipView(clip);
      chapterTitles.set(clip.id, view.label || view.title);
    }
    let destination: ExportDestination;
    if (input.dir) {
      const dir = input.dir;
      destination = { kind: "folder", label: null, at: () => ({ dir }) };
    } else {
      const firstClip = plan.clips[0];
      if (!firstClip) throw new MangaError("VALIDATION_ERROR", "the cut has no clip, so there is no folder for it; choose a folder", { details: { reason: "no-clip" } });
      // The folder of the first clip's video (A-88): the entry's folder when its work is linked to one, else 未分类/<file name>. Works for a video that is in no work.
      const target = { resourceId: firstClip.resourceId };
      const where = this.o.folders.dirFor(target, "roughcut");
      destination = {
        kind: "work", label: where.label,
        at: () => ({
          dir: where.dir,
          done: (file) => { this.o.folders.record(target, { kind: "roughcut", fileName: file.fileName, resourceId: firstClip.resourceId, refKind: "roughcut", refId: input.cutId }); },
        }),
      };
    }
    return this.exports.start({ plan, sources, streams, chapterTitles, destination, fileName: input.fileName });
  }

  /** The keyframes of a clip's video as the frame table has them, for a timeline to show and for marks to land on. */
  keyframes(resourceId: string, revisionId?: string, options: { build?: boolean } = {}, signal?: AbortSignal) {
    return this.o.videos.keyframes(resourceId, revisionId, options, signal);
  }

  exportsOf(cutId: string): { exports: RoughcutExportView[] } {
    this.cut(cutId);
    return { exports: this.exports.list(cutId) };
  }

  cancelExport(exportId: string): RoughcutExportView {
    return this.exports.cancel(exportId);
  }

  recover(): void {
    this.exports.recover();
  }

  suspend(): void {
    this.exports.abortAll();
  }

  async dispose(): Promise<void> {
    this.exports.abortAll();
    await this.exports.whenIdle();
  }
}
