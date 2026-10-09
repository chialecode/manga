import { validPattern, type DanmakuItem, type DanmakuMode, type DanmakuSettings } from "@manga/contracts/danmaku";

/** A comment ready for the display: seconds on the video element's own clock, the engine's name for the mode, a CSS colour. */
export type Prepared = { time: number; text: string; mode: "rtl" | "top" | "bottom"; color: string };

/** Comments that say the same thing within this many seconds count as one. */
const MERGE_WINDOW_S = 10;
/** The size of the base text at the height of a 1080-pixel picture. */
const BASE_FONT_PX = 25;
const MIN_FONT_PX = 12;
const MAX_FONT_PX = 72;
/** Scrolling comments cross a picture this wide in `REFERENCE_WIDTH / speed` seconds; at any other width the speed scales with it. */
const REFERENCE_WIDTH = 1920;

const ENGINE_MODE: Record<DanmakuMode, Prepared["mode"]> = { scroll: "rtl", top: "top", bottom: "bottom" };

const hex = (color: number) => `#${(color & 0xffffff).toString(16).padStart(6, "0")}`;

/** Compare texts the way a person does: case, width and runs of spaces do not tell comments apart. */
const same = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** The patterns of the settings that can be used; a line that is not valid (or not safe) is left out and does not stop the others. */
export function compilePatterns(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const pattern of patterns) {
    if (!validPattern(pattern)) continue;
    try { out.push(new RegExp(pattern, "iu")); } catch { /* checked above; kept for a future flag */ }
  }
  return out;
}

export type Filter = (item: DanmakuItem) => boolean;

/** Whether the settings show a comment: its kind, its source, the words and patterns the person blocked. */
export function visibleFilter(settings: Pick<DanmakuSettings, "scroll" | "top" | "bottom" | "sourcesOff" | "blockWords" | "blockPatterns">): Filter {
  const kinds: Record<DanmakuMode, boolean> = { scroll: settings.scroll, top: settings.top, bottom: settings.bottom };
  const off = new Set(settings.sourcesOff);
  const words = settings.blockWords.map((word) => word.toLowerCase());
  const patterns = compilePatterns(settings.blockPatterns);
  return (item) => {
    if (!kinds[item.mode] || off.has(item.source)) return false;
    const lower = item.text.toLowerCase();
    if (words.some((word) => lower.includes(word))) return false;
    return !patterns.some((pattern) => pattern.test(item.text));
  };
}

/**
 * What the display is given: the comments the settings show, with repeats merged into one that says how many there were, on the video element's
 * clock (the episode's offset and the file's own start time added). `offsetMs` makes the comments later when it is positive.
 */
export function prepareDanmaku(items: readonly DanmakuItem[], settings: DanmakuSettings, offsetMs: number, originMs = 0): Prepared[] {
  const show = visibleFilter(settings);
  const kept = items.filter(show);
  const shift = (offsetMs + originMs) / 1000;
  if (!settings.merge) return kept.map((item) => ({ time: item.at / 1000 + shift, text: item.text, mode: ENGINE_MODE[item.mode], color: settings.color ? hex(item.color) : "#ffffff" }));
  // Items arrive in time order. A group is the first of its text and the repeats within the window after it.
  const open = new Map<string, { entry: Prepared; first: number; count: number; base: string }>();
  const out: Array<{ entry: Prepared; count: number; base: string }> = [];
  for (const item of kept) {
    const key = `${item.mode}\u0000${same(item.text)}`;
    const group = open.get(key);
    const seconds = item.at / 1000;
    if (group && seconds - group.first <= MERGE_WINDOW_S) { group.count += 1; continue; }
    const entry: Prepared = { time: seconds + shift, text: item.text, mode: ENGINE_MODE[item.mode], color: settings.color ? hex(item.color) : "#ffffff" };
    const created = { entry, first: seconds, count: 1, base: item.text };
    open.set(key, created);
    out.push(created);
  }
  for (const group of out) if (group.count > 1) group.entry.text = `${group.base} ×${group.count}`;
  return out.map((group) => group.entry);
}

/** How many comments the settings leave out, so the panel can say "shown / all". */
export const shownCount = (items: readonly DanmakuItem[], settings: DanmakuSettings): number => {
  const show = visibleFilter(settings);
  let count = 0;
  for (const item of items) if (show(item)) count += 1;
  return count;
};

/** The sources present in a list of comments, with how many comments each has, the network's own (empty prefix) first. */
export function sourcesOf(items: readonly DanmakuItem[]): Array<{ source: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
  return [...counts.entries()].map(([source, count]) => ({ source, count })).sort((a, b) => (a.source === "" ? -1 : b.source === "" ? 1 : b.count - a.count || a.source.localeCompare(b.source)));
}

/** Text size and scroll speed for a picture of the given size, from the settings' percentage and reference speed. */
export function danmakuMetrics(pictureWidth: number, pictureHeight: number, settings: Pick<DanmakuSettings, "size" | "speed">): { fontPx: number; speedPxPerS: number } {
  const fontPx = Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, Math.round((pictureHeight / 1080) * BASE_FONT_PX * (settings.size / 100))));
  return { fontPx, speedPxPerS: Math.max(1, (settings.speed * pictureWidth) / REFERENCE_WIDTH) };
}

/**
 * The speed to give the engine. The engine counts in the video's own time, so its speed is pixels per second of the film: at 2x, the comments cross
 * twice as fast on the screen, and a top or bottom comment stays half as long. With `followRate` off the speed is divided by the rate, which leaves what the
 * person sees (pixels per second of the clock on the wall, how long a top comment stays) as the settings say whatever the rate is.
 */
export function engineSpeed(speedPxPerS: number, rate: number, followRate: boolean): number {
  if (followRate || !Number.isFinite(rate) || rate <= 0) return speedPxPerS;
  return Math.max(0.01, speedPxPerS / rate);
}

/** How many seconds a scrolling comment takes to cross the picture, for the settings page to say. */
export const crossingSeconds = (speed: number): number => Math.round((REFERENCE_WIDTH / speed) * 10) / 10;

/** The part of a stage the picture really covers: a video is fitted inside its box and the rest is bars. The comments are laid over the picture, not the bars. */
export function pictureRect(stageWidth: number, stageHeight: number, videoWidth: number, videoHeight: number): { left: number; top: number; width: number; height: number } {
  if (stageWidth <= 0 || stageHeight <= 0 || videoWidth <= 0 || videoHeight <= 0) return { left: 0, top: 0, width: Math.max(0, stageWidth), height: Math.max(0, stageHeight) };
  const scale = Math.min(stageWidth / videoWidth, stageHeight / videoHeight);
  const width = Math.round(videoWidth * scale);
  const height = Math.round(videoHeight * scale);
  return { left: Math.round((stageWidth - width) / 2), top: Math.round((stageHeight - height) / 2), width, height };
}

/** Steps for the offset buttons, in milliseconds. */
export const OFFSET_STEPS = { fine: 500, coarse: 5000 } as const;

/** Whole seconds to show for an offset: `-2.5`, `0`, `+1`. */
export const offsetSeconds = (offsetMs: number): string => {
  const value = Math.round(offsetMs / 100) / 10;
  return value > 0 ? `+${value}` : String(value);
};
