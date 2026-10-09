import fs from "node:fs";
import path from "node:path";
import {
  MangaError, createId, type RoughcutClipPlan, type RoughcutExportCommand, type RoughcutExportFile, type RoughcutExportStep, type RoughcutExportView, type RoughcutOutputCheck, type RoughcutPlan, type RoughcutStreams,
} from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { TargetTaken, placeNoReplace } from "../acquisition/files.ts";
import type { FfmpegService } from "../media/ffmpeg.ts";
import { safeFileName } from "./export-file.ts";
import { chapterMetadata, keptAudio, keptSubtitles, muxerFor, streamsFromProbe } from "./roughcut-plan.ts";

type Row = { id: string; cut_id: string; state: string; plan_json: string; result_json: string | null; tmp_name: string | null; final_name: string | null; error_json: string | null; created_at: string; updated_at: string };
type Progress = {
  step: RoughcutExportStep | null; done: number; bytes: number | null; check: RoughcutOutputCheck | null; timing: { totalMs: number; toolMs: number; overheadMs: number } | null;
  destination?: "work" | "folder"; folder?: string | null; files?: RoughcutExportFile[]; commands?: RoughcutExportCommand[];
};

export type ExportOptions = {
  store: DrizzleStore;
  ffmpeg: FfmpegService;
  /** Where each export keeps its working files while it runs; removed when it ends. */
  stagingRoot: string;
  notify: (topic: string, payload: Record<string, unknown>) => void;
};

/** Where an export puts its files. The service chooses: the work's own folder, or a folder the person picked. */
export type ExportDestination = {
  kind: "work" | "folder";
  /** For the work's folder, its place inside the works folder, as the work page shows it. */
  label: string | null;
  /** The folder for the file of a clip (`null` for the merged file), and what to do once the file is in it. */
  at(clipId: string | null): { dir: string; done?: (file: { fileName: string; bytes: number }) => void };
};

export type ExportRequest = {
  plan: RoughcutPlan;
  /** The file of each clip's video, by clip id. */
  sources: Map<string, string>;
  /** What each clip's source says about its streams, by clip id. */
  streams: Map<string, RoughcutStreams>;
  /** What a chapter is called, by clip id. */
  chapterTitles: Map<string, string>;
  destination: ExportDestination;
  fileName?: string;
};

const toSeconds = (ms: number) => (ms / 1000).toFixed(4);

/** The length of the output may differ from the plan by the part of one audio frame each clip carries past its last picture, and a little more. */
const BASE_TOLERANCE_MS = 100;
const PER_CLIP_TOLERANCE_MS = 80;

type Expectation = { frames: number; lengthMs: number; clips: number; streams: RoughcutStreams; audio: number[]; subtitles: number[]; chapters: number | null };
type Tool = (tool: "ffmpeg" | "ffprobe", args: string[], options: { cwd?: string; redact: string[]; step: RoughcutExportCommand["step"]; clip?: number }) => Promise<{ stdout: Buffer }>;

/**
 * Exports of rough cuts (CLIP-02). Each clip is copied out of its source without re-encoding, with the audio and subtitle tracks the person chose. A merged
 * export joins the parts (and may write a chapter for each clip); a separate export keeps one file for each clip. Every file is written under a temporary name
 * in its folder, checked against the plan, and only then renamed into place, never over another file. An export can be cancelled; a cancelled or failed one leaves
 * its record, and the files it had already finished (separate files are each whole); nothing half-written is left.
 */
export class RoughcutExports {
  private readonly o: ExportOptions;
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(options: ExportOptions) {
    this.o = options;
    fs.mkdirSync(options.stagingRoot, { recursive: true });
  }

  private row(exportId: string): Row {
    const row = this.o.store.sqlite.prepare("SELECT * FROM rough_cut_exports WHERE id = ?").get(exportId) as Row | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the export does not exist");
    return row;
  }

  private view(row: Row): RoughcutExportView {
    const result = (row.result_json ? JSON.parse(row.result_json) : {}) as Partial<Progress>;
    const plan = JSON.parse(row.plan_json) as RoughcutPlan;
    const files = result.files ?? [];
    return {
      id: row.id, cutId: row.cut_id, state: row.state as RoughcutExportView["state"], step: result.step ?? null, done: result.done ?? 0, total: plan.clips.length, plan,
      mode: plan.options?.mode ?? "merge", destination: result.destination ?? "folder", folder: result.folder ?? null,
      fileName: row.final_name ?? files[0]?.fileName ?? null, files, bytes: result.bytes ?? null, check: result.check ?? null, commands: result.commands ?? [], timing: result.timing ?? null,
      error: row.error_json ? (JSON.parse(row.error_json) as { code: string; message: string }) : null, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  get(exportId: string): RoughcutExportView {
    return this.view(this.row(exportId));
  }

  list(cutId: string): RoughcutExportView[] {
    return (this.o.store.sqlite.prepare("SELECT * FROM rough_cut_exports WHERE cut_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50").all(cutId) as Row[]).map((row) => this.view(row));
  }

  /** Whether this cut has an export in progress. */
  busy(cutId: string): boolean {
    return (this.o.store.sqlite.prepare("SELECT 1 FROM rough_cut_exports WHERE cut_id = ? AND state IN ('planned','running') LIMIT 1").get(cutId) as unknown) !== undefined;
  }

  private save(exportId: string, patch: { state?: string; progress?: Partial<Progress>; finalName?: string | null; error?: { code: string; message: string } | null; tmp?: string | null }): RoughcutExportView {
    const row = this.row(exportId);
    const result = { ...(row.result_json ? JSON.parse(row.result_json) : {}), ...(patch.progress ?? {}) };
    this.o.store.sqlite.prepare("UPDATE rough_cut_exports SET state = ?, result_json = ?, tmp_name = ?, final_name = ?, error_json = ?, updated_at = ? WHERE id = ?").run(
      patch.state ?? row.state, JSON.stringify(result), patch.tmp === undefined ? row.tmp_name : patch.tmp, patch.finalName === undefined ? row.final_name : patch.finalName,
      patch.error === undefined ? row.error_json : patch.error ? JSON.stringify(patch.error) : null, new Date().toISOString(), exportId,
    );
    const view = this.get(exportId);
    this.o.notify("roughcut.export", view as unknown as Record<string, unknown>);
    return view;
  }

  /**
   * Starts an export of a plan that has been checked. Returns at once; the work goes on in the background and each step is a notice.
   */
  start(request: ExportRequest): RoughcutExportView {
    const { plan } = request;
    const mode = plan.options.mode;
    if (!plan.clips.length || (mode === "merge" ? !plan.compatible || !plan.extension : !plan.separable)) {
      throw new MangaError("UNSUPPORTED_FORMAT", "this sequence cannot be exported as it is", { details: { reason: "incompatible", mode, problems: plan.problems.map((problem) => problem.code) } });
    }
    if (this.busy(plan.cutId)) throw new MangaError("VALIDATION_ERROR", "this sequence is already being exported", { details: { reason: "busy" } });
    // Every folder an export writes to is looked at before it begins, so a missing one is said at once and not after the first clip was cut.
    for (const clip of mode === "merge" ? [null] : plan.clips) {
      const dir = request.destination.at(clip ? clip.clipId : null).dir;
      let stat: fs.Stats;
      try { stat = fs.statSync(dir); } catch { throw new MangaError("NOT_FOUND", "the folder for the export is not there", { details: { reason: "missing-dir" } }); }
      if (!stat.isDirectory()) throw new MangaError("VALIDATION_ERROR", "the export needs a folder", { details: { reason: "dir" } });
    }
    const id = createId("rce");
    const now = new Date().toISOString();
    const base = safeFileName((request.fileName ?? plan.title).replace(/\.(mp4|m4v|mov|mkv|webm)$/i, ""), "roughcut");
    const progress: Progress = { step: null, done: 0, bytes: null, check: null, timing: null, destination: request.destination.kind, folder: request.destination.label, files: [], commands: [] };
    this.o.store.sqlite.prepare("INSERT INTO rough_cut_exports(id, cut_id, state, plan_json, result_json, tmp_name, final_name, error_json, created_at, updated_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,?,?)")
      .run(id, plan.cutId, "planned", JSON.stringify(plan), JSON.stringify(progress), now, now);
    const controller = new AbortController();
    const done = this.run(id, request, base, controller.signal).catch(() => undefined).finally(() => { this.running.delete(id); });
    this.running.set(id, { controller, done });
    return this.get(id);
  }

  cancel(exportId: string): RoughcutExportView {
    const row = this.row(exportId);
    const live = this.running.get(exportId);
    if (!live || (row.state !== "planned" && row.state !== "running")) throw new MangaError("VALIDATION_ERROR", "this export is not running", { details: { reason: "state" } });
    live.controller.abort();
    return this.view(row);
  }

  /** Resolves when every export that is running has ended; tests and the shutdown wait on it. */
  async whenIdle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running.values()].map((job) => job.done));
  }

  /** Stops every export that is running; the app is closing, or the module was turned off. */
  abortAll(): void {
    for (const live of this.running.values()) live.controller.abort();
  }

  /** At start: an export that was running when the app stopped did not finish; its working files are removed and it is recorded as interrupted. */
  recover(): void {
    const rows = this.o.store.sqlite.prepare("SELECT * FROM rough_cut_exports WHERE state IN ('planned','running')").all() as Row[];
    for (const row of rows) {
      if (row.tmp_name) fs.rmSync(row.tmp_name, { force: true });
      fs.rmSync(path.join(this.o.stagingRoot, row.id), { recursive: true, force: true });
      this.save(row.id, { state: "failed", error: { code: "INTERRUPTED", message: "the application stopped before the export finished" }, tmp: null });
    }
    for (const name of fs.existsSync(this.o.stagingRoot) ? fs.readdirSync(this.o.stagingRoot) : []) {
      const known = this.o.store.sqlite.prepare("SELECT state FROM rough_cut_exports WHERE id = ?").get(name) as { state: string } | undefined;
      if (!known) fs.rmSync(path.join(this.o.stagingRoot, name), { recursive: true, force: true });
    }
  }

  deleteFor(cutId: string): void {
    this.o.store.sqlite.prepare("DELETE FROM rough_cut_exports WHERE cut_id = ?").run(cutId);
  }

  /** The arguments of a cut of one clip: from the keyframe the plan chose, for the length the plan gives, the chosen tracks copied as they are. */
  private cutArgs(request: ExportRequest, clip: RoughcutClipPlan, source: string, out: string, ext: string): string[] {
    const { options } = request.plan;
    const streams = request.streams.get(clip.clipId)!;
    // The demuxer lands on the last keyframe at or before the time it is given, relative to the start of the file like the frame index. The index
    // rounds times to a thousandth, so half a millisecond past the keyframe is at or after its true time and before the next frame: this keyframe, never the one before.
    const seek = clip.actualInMs + 0.5;
    const args = ["-v", "error", "-nostdin", "-y", "-ss", toSeconds(seek), "-i", source];
    if (!clip.toEnd) args.push("-t", toSeconds(clip.actualOutMs - clip.frameGapMs / 2 - seek));
    args.push("-map", "0:v:0");
    if (options.audioTracks) for (const index of keptAudio(streams, options)) args.push("-map", `0:a:${index}`);
    else args.push("-map", "0:a?");
    const subtitles = keptSubtitles(options);
    for (const index of subtitles) args.push("-map", `0:s:${index}`);
    if (!subtitles.length) args.push("-sn");
    // Fonts attached to a Matroska file go with its subtitles, so styled text keeps its look. The join cannot carry them, so a merged file of several clips leaves them out.
    else if (ext === "mkv" && (options.mode === "separate" || request.plan.clips.length === 1)) args.push("-map", "0:t?");
    // Only the global metadata and the chapters of the source are left out: the language and title of each track go with it.
    args.push("-dn", "-map_chapters", "-1", "-map_metadata:g", "-1", "-c", "copy", "-avoid_negative_ts", "make_zero");
    if (ext === "mp4" || ext === "mov" || ext === "m4v") args.push("-movflags", "+faststart");
    args.push("-f", muxerFor(ext), out);
    return args;
  }

  private async run(exportId: string, request: ExportRequest, base: string, signal: AbortSignal): Promise<void> {
    const started = Date.now();
    const { plan } = request;
    const { options } = plan;
    let toolMs = 0;
    const stage = path.join(this.o.stagingRoot, exportId);
    const files: RoughcutExportFile[] = [];
    const commands: RoughcutExportCommand[] = [];
    // Places on this machine are told by what they are, in the commands the export shows.
    const names = new Map<string, string>();
    for (const [i, clip] of plan.clips.entries()) {
      const source = request.sources.get(clip.clipId);
      // A video used by several clips has the name of the first.
      if (source && !names.has(source)) { names.set(source, `<source-${i + 1}>`); names.set(path.dirname(source), `<source-${i + 1}-folder>`); }
    }
    names.set(stage, "<staging>");
    const shown = (args: string[]): string[] => {
      const known = [...names.entries()].sort((a, b) => b[0].length - a[0].length);
      return args.map((arg) => known.reduce((text, [place, name]) => (place && text.includes(place) ? text.split(place).join(name) : text), arg));
    };
    const tool: Tool = async (which, args, runOptions) => {
      const run = await this.o.ffmpeg.run(which, args, { signal, timeoutMs: 30 * 60_000, maxStdoutBytes: 64 * 1024 * 1024, cwd: runOptions.cwd, redactPaths: runOptions.redact });
      toolMs += run.durationMs;
      commands.push({ step: runOptions.step, ...(runOptions.clip ? { clip: runOptions.clip } : {}), tool: which, args: shown(args) });
      this.save(exportId, { progress: { commands } });
      return run;
    };
    let temp = "";
    try {
      fs.mkdirSync(stage, { recursive: true });
      this.save(exportId, { state: "running", progress: { step: "cutting", done: 0 } });
      const merged = options.mode === "merge";
      const chapters = merged && options.chapters === true && plan.clips.length > 1;

      if (merged) {
        const ext = plan.extension!;
        const target = request.destination.at(null);
        temp = path.join(target.dir, `.${base}.${exportId}.part`);
        names.set(temp, "<output>");
        names.set(target.dir, "<folder>");
        this.save(exportId, { tmp: temp });
        const single = plan.clips.length === 1;
        const parts: string[] = [];
        for (const [i, clip] of plan.clips.entries()) {
          const source = request.sources.get(clip.clipId);
          if (!source || !fs.existsSync(source)) throw new MangaError("NOT_FOUND", "a clip's video is not there any more", { details: { reason: "source-missing" } });
          const out = single ? temp : path.join(stage, `part-${String(i + 1).padStart(4, "0")}.${ext}`);
          names.set(out, single ? "<output>" : `<part-${i + 1}>`);
          await tool("ffmpeg", this.cutArgs(request, clip, source, out, ext), { redact: [source, path.dirname(source), out, target.dir, stage], step: "cut", clip: i + 1 });
          parts.push(out);
          this.save(exportId, { progress: { step: "cutting", done: i + 1 } });
        }
        if (parts.length > 1) {
          this.save(exportId, { progress: { step: "joining" } });
          const list = path.join(stage, "list.txt");
          // A part is as long as its picture and sound. The length a file reports also counts its subtitles, and the last event of a copied
          // text track may run past the picture: left to itself, the join would place the next clip after that and leave a gap. So when
          // subtitles are kept each part's length is said here.
          const lengths: number[] = [];
          if (keptSubtitles(options).length) for (const [i, part] of parts.entries()) lengths.push(await this.mediaEnd(part, tool, i + 1));
          // The parts have names of our own making, so nothing a person called a file reaches this list.
          fs.writeFileSync(list, parts.map((part, i) => `file '${path.basename(part)}'${lengths.length ? `\nduration ${(lengths[i]! / 1000).toFixed(6)}` : ""}`).join("\n") + "\n");
          const args = ["-v", "error", "-nostdin", "-y", "-f", "concat", "-safe", "0", "-i", "list.txt"];
          if (chapters) {
            fs.writeFileSync(path.join(stage, "chapters.txt"), chapterMetadata(plan.clips.map((clip) => ({ title: request.chapterTitles.get(clip.clipId) ?? "", lengthMs: clip.actualOutMs - clip.actualInMs }))));
            args.push("-i", "chapters.txt", "-map", "0", "-map_chapters", "1");
          } else args.push("-map", "0");
          args.push("-c", "copy");
          if (ext === "mp4" || ext === "mov" || ext === "m4v") args.push("-movflags", "+faststart");
          args.push("-f", muxerFor(ext), temp);
          await tool("ffmpeg", args, { cwd: stage, redact: [target.dir, stage, temp], step: "join" });
        }
        if (signal.aborted) throw new MangaError("CANCELLED", "the export was cancelled");
        this.save(exportId, { progress: { step: "checking" } });
        const first = request.streams.get(plan.clips[0]!.clipId)!;
        const check = await this.check(temp, {
          frames: plan.clips.reduce((sum, clip) => sum + clip.frames, 0), lengthMs: Math.round(plan.clips.reduce((sum, clip) => sum + (clip.actualOutMs - clip.actualInMs), 0)), clips: plan.clips.length,
          streams: first, audio: keptAudio(first, options), subtitles: keptSubtitles(options), chapters: chapters ? plan.clips.length : null,
        }, tool);
        if (!check.ok) this.save(exportId, { progress: { check } });
        if (!check.ok) throw this.mismatch(check);
        this.save(exportId, { progress: { step: "placing", check } });
        const fileName = this.place(temp, target.dir, base, ext);
        const bytes = fs.statSync(path.join(target.dir, fileName)).size;
        target.done?.({ fileName, bytes });
        files.push({ clipId: null, fileName, bytes, check });
        const totalMs = Date.now() - started;
        this.save(exportId, { state: "done", finalName: fileName, tmp: null, progress: { step: null, bytes, check, files, timing: { totalMs, toolMs, overheadMs: Math.max(0, totalMs - toolMs) } } });
        return;
      }

      // Separate: each clip is a file of its own, cut, checked and named before the next one is started.
      for (const [i, clip] of plan.clips.entries()) {
        const source = request.sources.get(clip.clipId);
        if (!source || !fs.existsSync(source)) throw new MangaError("NOT_FOUND", "a clip's video is not there any more", { details: { reason: "source-missing" } });
        const own = request.streams.get(clip.clipId)!;
        const ext = clip.extension!;
        const target = request.destination.at(clip.clipId);
        temp = path.join(target.dir, `.${base}.${exportId}.${i + 1}.part`);
        names.set(temp, "<output>");
        names.set(target.dir, "<folder>");
        this.save(exportId, { tmp: temp, progress: { step: "cutting", done: i } });
        await tool("ffmpeg", this.cutArgs(request, clip, source, temp, ext), { redact: [source, path.dirname(source), temp, target.dir, stage], step: "cut", clip: i + 1 });
        if (signal.aborted) throw new MangaError("CANCELLED", "the export was cancelled");
        this.save(exportId, { progress: { step: "checking" } });
        const check = await this.check(temp, {
          frames: clip.frames, lengthMs: Math.round(clip.actualOutMs - clip.actualInMs), clips: 1, streams: own, audio: keptAudio(own, options), subtitles: keptSubtitles(options), chapters: null,
        }, tool, i + 1);
        if (!check.ok) this.save(exportId, { progress: { check } });
        if (!check.ok) throw this.mismatch(check);
        this.save(exportId, { progress: { step: "placing", check } });
        const label = request.chapterTitles.get(clip.clipId) ?? "";
        const fileName = this.place(temp, target.dir, `${base} ${String(i + 1).padStart(2, "0")}${label ? ` ${safeFileName(label, "")}`.trimEnd() : ""}`, ext);
        const bytes = fs.statSync(path.join(target.dir, fileName)).size;
        target.done?.({ fileName, bytes });
        files.push({ clipId: clip.clipId, fileName, bytes, check });
        temp = "";
        this.save(exportId, { tmp: null, progress: { step: null, done: i + 1, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0), check } });
      }
      const totalMs = Date.now() - started;
      this.save(exportId, { state: "done", tmp: null, progress: { step: null, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0), check: files.at(-1)?.check ?? null, timing: { totalMs, toolMs, overheadMs: Math.max(0, totalMs - toolMs) } } });
    } catch (error) {
      if (temp) fs.rmSync(temp, { force: true });
      const cancelled = signal.aborted || (error instanceof MangaError && error.code === "CANCELLED");
      const code = error instanceof MangaError ? error.code : "FAILED";
      this.save(exportId, {
        state: cancelled ? "cancelled" : "failed", tmp: null, progress: { step: null, files },
        error: cancelled ? null : { code, message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) },
      });
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }

  private mismatch(check: RoughcutOutputCheck): MangaError {
    return new MangaError("UNSUPPORTED_FORMAT", "the exported file does not match the plan, so it was not kept", {
      details: { reason: "check", expectedFrames: check.expectedFrames, actualFrames: check.actualFrames, expectedMs: check.expectedMs, actualMs: check.actualMs },
    });
  }

  /**
   * A finished file against what was asked: the same video frames, about the same length, and the streams the choice of tracks gives (the first clip's
   * video, the audio and subtitle tracks that were kept, none of the others), and for a merged file with chapters, one chapter for each clip.
   */
  private async check(file: string, expect: Expectation, tool: Tool, clip?: number): Promise<RoughcutOutputCheck> {
    const expectedFrames = expect.frames;
    const expectedMs = expect.lengthMs;
    const info = await tool("ffprobe", ["-v", "error", "-hide_banner", "-print_format", "json", "-show_format", "-show_streams", "-show_chapters", "-show_data_hash", "SHA256", "-i", file], { redact: [file, path.dirname(file)], step: "check", clip });
    const json = JSON.parse(info.stdout.toString("utf8")) as { format?: { duration?: string }; streams?: Array<Record<string, unknown>>; chapters?: unknown[] };
    const streams = streamsFromProbe(json as never);
    const frames = await tool("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", "-i", file], { redact: [file, path.dirname(file)], step: "check", clip });
    const actualFrames = Number.parseInt(frames.stdout.toString("utf8").trim(), 10) || 0;
    // A file with subtitles reports a length that includes them; the length that is checked is that of the picture and sound.
    const actualMs = expect.subtitles.length ? await this.mediaEnd(file, tool, clip) : Math.round((Number(json.format?.duration) || 0) * 1000);
    const tolerance = BASE_TOLERANCE_MS + PER_CLIP_TOLERANCE_MS * expect.clips;
    // The streams must still be the source's: nothing was re-encoded, and exactly the chosen tracks are there.
    const want = expect.streams;
    const videoMatch = Boolean(streams) && streams!.video.codec === want.video.codec && streams!.video.width === want.video.width && streams!.video.height === want.video.height;
    const audioMatch = Boolean(streams) && streams!.audio.length === expect.audio.length
      && expect.audio.every((index, j) => { const wanted = want.audio[index]; const got = streams!.audio[j]; return Boolean(wanted && got) && got!.codec === wanted!.codec && got!.sampleRate === wanted!.sampleRate && got!.channels === wanted!.channels; });
    const subtitleMatch = Boolean(streams) && streams!.subtitle.length === expect.subtitles.length
      && expect.subtitles.every((index, j) => Boolean(want.subtitle[index]) && streams!.subtitle[j]!.codec === want.subtitle[index]!.codec);
    const streamsMatch = videoMatch && audioMatch && subtitleMatch;
    const chapters = expect.chapters === null ? undefined : { expected: expect.chapters, actual: json.chapters?.length ?? 0 };
    return {
      ok: actualFrames === expectedFrames && Math.abs(actualMs - expectedMs) <= tolerance && streamsMatch && (!chapters || chapters.expected === chapters.actual),
      expectedMs, actualMs, expectedFrames, actualFrames, streamsMatch, ...(chapters ? { chapters } : {}),
    };
  }

  /** When the picture and sound of a file end, in milliseconds, from the packets of its video and audio streams; its subtitles are not counted. */
  private async mediaEnd(file: string, tool: Tool, clip?: number): Promise<number> {
    const result = await tool("ffprobe", ["-v", "error", "-show_entries", "packet=stream_index,pts_time,duration_time:stream=index,codec_type", "-of", "compact", "-i", file], { redact: [file, path.dirname(file)], step: "check", clip });
    const timed = new Set<number>();
    const packets: Array<{ stream: number; end: number }> = [];
    for (const line of result.stdout.toString("utf8").split(/\r?\n/)) {
      const fields = Object.fromEntries(line.split("|").slice(1).map((part) => { const at = part.indexOf("="); return [part.slice(0, at), part.slice(at + 1)]; }));
      if (line.startsWith("stream|")) { if (fields.codec_type === "video" || fields.codec_type === "audio") timed.add(Number(fields.index)); }
      else if (line.startsWith("packet|")) packets.push({ stream: Number(fields.stream_index), end: (Number(fields.pts_time) || 0) + (Number(fields.duration_time) || 0) });
    }
    let end = 0;
    for (const packet of packets) if (timed.has(packet.stream) && packet.end > end) end = packet.end;
    return Math.round(end * 1000);
  }

  /** Gives the finished file its name without replacing anything: `name.mp4`, then `name (2).mp4` and on. */
  private place(temp: string, dir: string, base: string, ext: string): string {
    for (let n = 1; n <= 999; n += 1) {
      const candidate = n === 1 ? `${base}.${ext}` : `${base} (${n}).${ext}`;
      try {
        placeNoReplace(temp, path.join(dir, candidate));
        return candidate;
      } catch (error) {
        if (error instanceof TargetTaken) continue;
        throw new MangaError("LOCATION_UNAVAILABLE", `the export could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new MangaError("VALIDATION_ERROR", "there are too many files with this name");
  }
}
