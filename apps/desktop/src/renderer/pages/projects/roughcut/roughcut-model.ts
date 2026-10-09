import type { Translator } from "@manga/i18n";
import type { RoughcutExportOptions, RoughcutExportView, RoughcutMode, RoughcutPlan, RoughcutProblem } from "@manga/contracts/roughcut";
import { formatClockMs } from "../../../readers/video-model.ts";

type T = Translator["t"];

export type { RoughcutExportView as ExportView, RoughcutPlan as PlanView, RoughcutProblem as PlanProblem };

export type ClipView = { id: string; resourceId: string; revisionId: string; title: string; label: string; inMs: number; outMs: number; sortKey: string; available: boolean; durationMs: number | null };
export type OpsState = { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null };
export type CutDoc = { cut: { id: string; projectId: string | null; title: string; createdAt: string; updatedAt: string }; clips: ClipView[]; totalMs: number; ops: OpsState; exporting: boolean };
export type CutSummary = { id: string; projectId: string | null; title: string; clips: number; totalMs: number; updatedAt: string };

/** A length as `m:ss`, with the milliseconds only when there are some, so a round length reads round. */
export function lengthText(ms: number): string {
  const text = formatClockMs(ms);
  return text.endsWith(".000") ? text.slice(0, -4) : text;
}

/** Seconds to the millisecond, for how far a cut moved from what was asked: `0.500`. */
export const secondsText = (ms: number): string => (Math.abs(ms) / 1000).toFixed(3);

/** What a problem of the check says, in words that name the clip and what differs. The detail the tool gave is shown as it is: names of codecs, sizes, rates. */
export function problemText(t: T, problem: RoughcutProblem, titleOf: (clipId?: string) => string): string {
  return t(`roughcut.problem.${problem.code}` as "roughcut.problem.empty", {
    clip: titleOf(problem.clipId),
    first: String(problem.detail?.first ?? ""),
    other: String(problem.detail?.other ?? ""),
  });
}

/** What a running export is doing, in one line. */
export function stepText(t: T, view: Pick<RoughcutExportView, "step" | "done" | "total">): string {
  if (!view.step) return t("roughcut.export.starting");
  return t(`roughcut.export.step.${view.step}` as "roughcut.export.step.cutting", { done: view.done, total: view.total });
}

/** How many file names a report lists before it says "and so many". */
const NAMES_SHOWN = 4;

/** How a finished export is reported: the file by name, what was checked, where it went and where the time went. */
export function exportSummary(t: T, view: RoughcutExportView): string[] {
  const files = view.files ?? [];
  if (view.state === "done") {
    const lines: string[] = [];
    if (view.mode === "separate" && files.length) {
      lines.push(t("roughcut.export.doneMany", { count: files.length, frames: files.reduce((sum, file) => sum + file.check.actualFrames, 0), length: lengthText(files.reduce((sum, file) => sum + file.check.actualMs, 0)) }));
      const names = files.slice(0, NAMES_SHOWN).map((file) => `“${file.fileName}”`).join("、");
      lines.push(t("roughcut.export.files", { names: files.length > NAMES_SHOWN ? t("roughcut.export.filesMore", { names, count: files.length }) : names }));
      if (files.every((file) => file.check.ok)) lines.push(t("roughcut.export.checkMany", { count: files.length }));
    } else {
      lines.push(t("roughcut.export.done", { name: view.fileName ?? "", frames: view.check?.actualFrames ?? 0, length: lengthText(view.check?.actualMs ?? 0) }));
      if (view.check) lines.push(t("roughcut.export.check", { actual: view.check.actualFrames, expected: view.check.expectedFrames, drift: Math.abs(view.check.actualMs - view.check.expectedMs) }));
      if (view.check?.chapters) lines.push(t("roughcut.export.chapters", { count: view.check.chapters.actual }));
    }
    if (view.destination === "work" && view.folder) lines.push(t("roughcut.export.where.work", { folder: view.folder }));
    if (view.timing) lines.push(t("roughcut.export.timing", { total: lengthText(view.timing.totalMs), tool: lengthText(view.timing.toolMs), overhead: lengthText(view.timing.overheadMs) }));
    return lines;
  }
  if (view.state === "cancelled") return [t("roughcut.export.cancelled"), ...(files.length ? [t("roughcut.export.files", { names: files.map((file) => `“${file.fileName}”`).join("、") })] : [])];
  if (view.state === "failed") {
    if (view.error?.code === "INTERRUPTED") return [t("roughcut.export.interrupted")];
    if (view.check && !view.check.ok) return [t("roughcut.export.mismatch", { actual: view.check.actualFrames, expected: view.check.expectedFrames })];
    if (files.length) return [t("roughcut.export.partial", { count: files.length, reason: view.error?.message ?? "" })];
    return [t("roughcut.export.failed", { reason: view.error?.message ?? "" })];
  }
  return [stepText(t, view)];
}

// ---------------------------------------------------------------- what an export is asked to be

/** What is chosen in the page: one file or one for each clip, which tracks, chapters. `audio: "all"` is every audio track of the first clip's source. */
export type ExportChoice = { mode: RoughcutMode; audio: number[] | "all"; subtitle: number[]; chapters: boolean };
export const DEFAULT_CHOICE: ExportChoice = { mode: "merge", audio: "all", subtitle: [], chapters: false };

/** The options a command takes for a choice; what is left as it is by default is not sent. */
export function optionsOf(choice: ExportChoice): RoughcutExportOptions {
  return {
    mode: choice.mode,
    ...(choice.audio === "all" ? {} : { audioTracks: choice.audio }),
    ...(choice.subtitle.length ? { subtitleTracks: choice.subtitle } : {}),
    ...(choice.chapters ? { chapters: true } : {}),
  };
}

const toggled = (list: number[], index: number): number[] => (list.includes(index) ? list.filter((item) => item !== index) : [...list, index].sort((a, b) => a - b));

/** Ticks one audio track on or off. `count` is how many the first clip's source has, so that ticking every one again is "all". */
export function toggleAudio(choice: ExportChoice, index: number, count: number): ExportChoice {
  const current = choice.audio === "all" ? Array.from({ length: count }, (_, i) => i) : choice.audio;
  const next = toggled(current, index);
  return { ...choice, audio: next.length === count ? "all" : next };
}

export const toggleSubtitle = (choice: ExportChoice, index: number): ExportChoice => ({ ...choice, subtitle: toggled(choice.subtitle, index) });

/** One track in a list to choose from: its number, codec, channels, language and title, the way the file states them. */
export function trackLabel(t: T, track: { codec: string; channels?: number; language: string; title: string }, index: number): string {
  const extra = [track.channels ? t("roughcut.opt.channels", { count: track.channels }) : "", track.language, track.title].filter(Boolean);
  return t("roughcut.opt.track", { n: index + 1, codec: track.codec, extra: extra.length ? ` · ${extra.join(" · ")}` : "" });
}

/** The choice in one line, for the export dialog. */
export function choiceSummary(t: T, choice: ExportChoice, plan: Pick<RoughcutPlan, "tracks"> | null): string {
  const list = (picked: number[] | "all", count: number) => (picked === "all" ? (count ? t("roughcut.opt.all") : t("roughcut.opt.none")) : picked.length ? picked.map((i) => i + 1).join("、") : t("roughcut.opt.none"));
  return t("roughcut.opt.summary", {
    mode: t(choice.mode === "merge" ? "roughcut.opt.mode.merge" : "roughcut.opt.mode.separate"),
    audio: list(choice.audio, plan?.tracks.audio.length ?? 0),
    subtitle: list(choice.subtitle.length ? choice.subtitle : [], 0),
    chapters: choice.chapters && choice.mode === "merge" ? t("roughcut.opt.chaptersOn") : "",
  });
}

// ---------------------------------------------------------------- keyframes

/** The last keyframe at or before a time (half a millisecond of slack for a time that was rounded); the time itself when there is none before it. */
export function snapToKeyframe(keyframes: readonly number[], ms: number): number {
  let low = 0;
  let high = keyframes.length - 1;
  if (high < 0 || keyframes[0]! > ms + 0.5) return ms;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (keyframes[mid]! <= ms + 0.5) low = mid; else high = mid - 1;
  }
  return keyframes[low]!;
}

/** The keyframe before a time, for jumping back; null when there is none. */
export function prevKeyframe(keyframes: readonly number[], ms: number): number | null {
  let found: number | null = null;
  let low = 0;
  let high = keyframes.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (keyframes[mid]! < ms - 0.5) { found = keyframes[mid]!; low = mid + 1; } else high = mid - 1;
  }
  return found;
}

/** The keyframe after a time, for jumping forward; null when there is none. */
export function nextKeyframe(keyframes: readonly number[], ms: number): number | null {
  let found: number | null = null;
  let low = 0;
  let high = keyframes.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (keyframes[mid]! > ms + 0.5) { found = keyframes[mid]!; high = mid - 1; } else low = mid + 1;
  }
  return found;
}

/** The ticks of a timeline as one path of vertical strokes `width` units wide; keyframes that fall on the same unit are drawn once. */
export function tickPath(keyframes: readonly number[], durationMs: number, width = 1000, height = 24): string {
  if (!(durationMs > 0)) return "";
  const seen = new Set<number>();
  const parts: string[] = [];
  for (const keyframe of keyframes) {
    const x = Math.min(width, Math.max(0, Math.round((keyframe / durationMs) * width)));
    if (seen.has(x)) continue;
    seen.add(x);
    parts.push(`M${x} 0V${height}`);
  }
  return parts.join("");
}

/** `in` and `out` as typed, checked against each other and the length of the video: the two times, or the reason there are not. */
export function readRange(inText: string, outText: string, parse: (text: string) => number | null, durationMs: number | null): { inMs: number; outMs: number } | "time" | "range" {
  const inMs = parse(inText);
  const outMs = parse(outText);
  if (inMs === null || outMs === null) return "time";
  if (!(outMs > inMs) || (durationMs !== null && outMs > durationMs + 1000)) return "range";
  return { inMs, outMs };
}

/** Steps a clip takes in the list, as the positions the service wants (`move` takes the place among the others). */
export function moveTarget(index: number, direction: "up" | "down", count: number): number | null {
  const to = direction === "up" ? index - 1 : index + 1;
  return to < 0 || to >= count ? null : to;
}
