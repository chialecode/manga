/**
 * The video player's rules without React or a media element: time text and input, rates, the frame a seek should land on,
 * which stretches count as watched, what a key does and which subtitle track to start with.
 */

import { actionOf, chordOf, resolveKeys } from "@manga/contracts/keys";

export type TimeRange = { startMs: number; endMs: number };

const DEFAULT_KEYS = resolveKeys(null);

// ---- time ------------------------------------------------------------------

const pad = (value: number, size = 2) => String(value).padStart(size, "0");

/** `m:ss`, or `h:mm:ss` from an hour on. Negative and non-finite values read as zero. */
export function formatClock(ms: number): string {
  const total = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** `m:ss.mmm`, or `h:mm:ss.mmm` from an hour on: the time shown and edited in the player, down to the millisecond. */
export function formatClockMs(ms: number): string {
  const whole = Math.floor(Math.max(0, Number.isFinite(ms) ? ms : 0));
  const hours = Math.floor(whole / 3_600_000);
  const minutes = Math.floor((whole % 3_600_000) / 60_000);
  const seconds = Math.floor((whole % 60_000) / 1000);
  const fraction = pad(whole % 1000, 3);
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}.${fraction}` : `${minutes}:${pad(seconds)}.${fraction}`;
}

/**
 * A time typed by the user: seconds (`754`, `75.5`), `m:ss`, `m:ss.mmm`, `h:mm:ss`, with optional fractions on the seconds.
 * Anything else is null, so a typo never seeks.
 */
export function parseClock(text: string): number | null {
  const value = text.trim();
  if (!value) return null;
  const parts = value.split(":");
  if (parts.length > 3) return null;
  const numbers: number[] = [];
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    if (!(last ? /^\d+(\.\d+)?$/ : /^\d+$/).test(part)) return null;
    numbers.push(Number(part));
  }
  if (parts.length > 1) {
    // Minutes and seconds past 59 are a mistake in a clock, not a long duration.
    if (numbers.slice(1).some((part) => part >= 60)) return null;
  }
  const seconds = numbers.reduce((sum, part) => sum * 60 + part, 0);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

// ---- rate ------------------------------------------------------------------

/** The rates offered until the person edits the list in the settings. */
export const RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
export const DEFAULT_CUSTOM_RATE = 1.5;
export const RATE_MIN = 0.25;
export const RATE_MAX = 4;
/** Share of the volume that stays while a recording lowers the picture's sound (Q-05 default: 30%). */
export const DUCK_FACTOR = 0.3;
/** How long → or ← must be down before it is a hold (the temporary rate, the rewind) and not a step. */
export const HOLD_MS = 300;
/** A held ← goes back this much every tick: about four seconds of the video for each second held. A video cannot play backward. */
export const REWIND_TICK_MS = 100;
export const REWIND_STEP_MS = 400;

export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(rate * 100) / 100));
}

/** A rate typed by the user, `1.75` or `1.75x`; null when it is not a number or lies outside 0.25–4. */
export function parseRate(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*[x×]?\s*$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return value >= RATE_MIN && value <= RATE_MAX ? Math.round(value * 100) / 100 : null;
}

/** The most rates the list holds. */
export const RATE_LIST_MAX = 16;

/** A rate typed into the list of the settings: 0.25–4 with at most two decimals, as written (`1.3`, `1.3x`); null otherwise. Unlike `parseRate` it does not round. */
export function parseListRate(text: string): number | null {
  const match = /^\s*(\d+(?:\.\d{1,2})?)\s*[x×]?\s*$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return value >= RATE_MIN && value <= RATE_MAX ? value : null;
}

/** The next rate of the list above or below `rate`, for the step keys; it stops at the ends. */
export function stepRate(rate: number, direction: 1 | -1, rates: readonly number[] = RATE_PRESETS): number {
  const presets = [...rates].sort((a, b) => a - b);
  if (direction > 0) return presets.find((preset) => preset > rate + 1e-9) ?? RATE_MAX;
  return [...presets].reverse().find((preset) => preset < rate - 1e-9) ?? RATE_MIN;
}

// ---- frames ----------------------------------------------------------------

export type FrameAnswer = { frame: number; ptsMs: number; totalFrames: number; durationMs: number; previousMs: number | null; nextMs: number | null };

/**
 * The time to seek to so the player shows this frame. The middle of the frame's own interval is inside it whatever
 * rounding the player applies; seeking to its exact start can land on the frame before.
 */
export function seekTargetForFrame(answer: Pick<FrameAnswer, "ptsMs" | "nextMs" | "previousMs" | "durationMs">): number {
  if (answer.nextMs !== null && answer.nextMs > answer.ptsMs) return (answer.ptsMs + answer.nextMs) / 2;
  // The last frame: borrow the length of the one before it, and stay inside the duration.
  const length = answer.previousMs !== null && answer.ptsMs > answer.previousMs ? answer.ptsMs - answer.previousMs : 40;
  const end = answer.durationMs > answer.ptsMs ? answer.durationMs : answer.ptsMs + length;
  return answer.ptsMs + Math.min(length, end - answer.ptsMs) / 2;
}

/** Whether the frame the player presented is the one that was asked for. `mediaTime` is in seconds. */
export function frameLanded(mediaTimeSec: number, expectedPtsMs: number, toleranceMs = 1): boolean {
  return Math.abs(mediaTimeSec * 1000 - expectedPtsMs) <= toleranceMs;
}

/** Frame numbers are shown from 1; the index counts from 0. They are information only: a jump is by time. */
export const displayFrame = (frame: number) => frame + 1;

// ---- what counts as watched --------------------------------------------------

export type PlayedState = { current: TimeRange | null; ranges: TimeRange[] };
export const emptyPlayed = (): PlayedState => ({ current: null, ranges: [] });

/**
 * One position sample from the playing video. A sample that follows the last one within a normal step of playback
 * extends the stretch that is being watched; one that jumps (a seek, in either direction) starts a new stretch, so
 * skipped parts are never counted. A paused video adds nothing.
 */
export function samplePlayed(state: PlayedState, timeMs: number, options: { playing: boolean; rate: number }): PlayedState {
  if (!options.playing) return closePlayed(state);
  const allowed = Math.max(1500, 1000 * Math.max(1, options.rate) * 1.5);
  const current = state.current;
  if (current && timeMs >= current.endMs && timeMs - current.endMs <= allowed) return { ...state, current: { startMs: current.startMs, endMs: timeMs } };
  const closed = closePlayed(state);
  return { ...closed, current: { startMs: timeMs, endMs: timeMs } };
}

/** A seek ends the stretch being watched without adding to it. */
export function closePlayed(state: PlayedState): PlayedState {
  if (!state.current) return state;
  const ranges = state.current.endMs > state.current.startMs ? [...state.ranges, state.current] : state.ranges;
  return { current: null, ranges };
}

/** The stretches to send now, merged, and the state to carry on with. The running stretch continues from where it is. */
export function drainPlayed(state: PlayedState): { ranges: TimeRange[]; state: PlayedState } {
  const all = state.current && state.current.endMs > state.current.startMs ? [...state.ranges, state.current] : [...state.ranges];
  const ordered = all.sort((a, b) => a.startMs - b.startMs);
  const merged: TimeRange[] = [];
  for (const range of ordered) {
    const last = merged[merged.length - 1];
    if (last && range.startMs <= last.endMs) last.endMs = Math.max(last.endMs, range.endMs);
    else merged.push({ ...range });
  }
  const carry = state.current ? { startMs: state.current.endMs, endMs: state.current.endMs } : null;
  return { ranges: merged.slice(0, 64).map((range) => ({ startMs: Math.round(range.startMs), endMs: Math.round(range.endMs) })), state: { current: carry, ranges: [] } };
}

// ---- A–B interval ------------------------------------------------------------

/** The interval between two marks, in order, or null when one is missing or they are less than 100 ms apart. */
export function intervalOf(a: number | null, b: number | null): TimeRange | null {
  if (a === null || b === null) return null;
  const startMs = Math.min(a, b);
  const endMs = Math.max(a, b);
  return endMs - startMs >= 100 ? { startMs, endMs } : null;
}

export const percentOf = (ms: number, durationMs: number): number => (durationMs > 0 ? Math.min(100, Math.max(0, (ms / durationMs) * 100)) : 0);

// ---- keys ------------------------------------------------------------------

export type VideoKeyAction =
  | { type: "toggle" }
  | { type: "arrow"; side: -1 | 1 }
  | { type: "volume"; delta: number }
  | { type: "frame"; delta: 1 | -1 }
  | { type: "mute" }
  | { type: "fullscreen" }
  | { type: "markA" }
  | { type: "markB" }
  | { type: "escape" }
  | { type: "rate"; direction: 1 | -1 }
  | { type: "customRate" }
  | { type: "start" }
  | { type: "time" }
  | { type: "screenshot" }
  | { type: "danmaku" };

const VIDEO_ACTIONS: Record<string, VideoKeyAction> = {
  "video.toggle": { type: "toggle" },
  "video.seekBack": { type: "arrow", side: -1 },
  "video.seekForward": { type: "arrow", side: 1 },
  "video.volumeUp": { type: "volume", delta: 0.05 },
  "video.volumeDown": { type: "volume", delta: -0.05 },
  "video.framePrev": { type: "frame", delta: -1 },
  "video.frameNext": { type: "frame", delta: 1 },
  "video.mute": { type: "mute" },
  "video.fullscreen": { type: "fullscreen" },
  "video.markA": { type: "markA" },
  "video.markB": { type: "markB" },
  "video.rateDown": { type: "rate", direction: -1 },
  "video.rateUp": { type: "rate", direction: 1 },
  "video.customRate": { type: "customRate" },
  "video.start": { type: "start" },
  "video.time": { type: "time" },
  "video.screenshot": { type: "screenshot" },
  "video.danmaku": { type: "danmaku" },
};

/**
 * What a key does, by the key table (`@manga/contracts/keys`): the defaults are Q-13's and Q-26's, and the person's own keys replace them.
 * ← and → step by the seek step when tapped, → held plays at the temporary rate and ← held rewinds (see `createArrowKeys`). A chord with
 * Ctrl or Alt means something only where it is in the table, so the system's own shortcuts are left alone.
 */
export function videoKeyAction(event: Parameters<typeof actionOf>[0], keys: Record<string, readonly string[]> = DEFAULT_KEYS): VideoKeyAction | null {
  if (chordOf(event) === "Esc") return { type: "escape" };
  const id = actionOf(event, keys, "video");
  return id ? VIDEO_ACTIONS[id] ?? null : null;
}

// ---- subtitle tracks ---------------------------------------------------------

export type SubtitleTrack = {
  id: string;
  source: "embedded" | "external";
  streamIndex: number | null;
  codec: string;
  /** `ass` is drawn by the ASS renderer; `srt` and `vtt` are read into cues and laid out by the player's own subtitle layer; null cannot be drawn (picture subtitles). */
  format: "ass" | "srt" | "vtt" | null;
  language: string | null;
  title: string | null;
  default: boolean;
};

const CHINESE = /^(zh|chi|zho|chs|cht|sc|tc)/i;

/** The track to start with: one the user chose before, else Chinese, else the file's default, else the first that can be drawn. */
export function pickSubtitleTrack(tracks: readonly SubtitleTrack[], preferredId?: string | null): SubtitleTrack | null {
  const drawable = tracks.filter((track) => track.format !== null);
  if (preferredId) {
    const chosen = drawable.find((track) => track.id === preferredId);
    if (chosen) return chosen;
  }
  return drawable.find((track) => track.language !== null && CHINESE.test(track.language))
    ?? drawable.find((track) => track.default)
    ?? drawable[0]
    ?? null;
}

export function subtitleRenderer(track: Pick<SubtitleTrack, "format">): "ass" | "text" | null {
  if (track.format === "ass") return "ass";
  return track.format === null ? null : "text";
}
