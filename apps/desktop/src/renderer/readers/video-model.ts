/**
 * The video player's rules without React or a media element: time text and input, rates, the frame a seek should land on,
 * which stretches count as watched, what a key does and which subtitle track to start with.
 */

export type TimeRange = { startMs: number; endMs: number };

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

/** `h:mm:ss.mmm`, for the place where a frame boundary matters. */
export function formatClockPrecise(ms: number): string {
  const safe = Math.max(0, Number.isFinite(ms) ? ms : 0);
  const whole = Math.floor(safe);
  const hours = Math.floor(whole / 3_600_000);
  const minutes = Math.floor((whole % 3_600_000) / 60_000);
  const seconds = Math.floor((whole % 60_000) / 1000);
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(whole % 1000, 3)}`;
}

/**
 * A time typed by the user: seconds (`754`, `75.5`), `m:ss`, `h:mm:ss`, with optional fractions on the seconds.
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

export const RATE_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;
export const RATE_MIN = 0.25;
export const RATE_MAX = 4;
/** Share of the volume that stays while a recording lowers the picture's sound (Q-05 default: 30%). */
export const DUCK_FACTOR = 0.3;
/** How long the right button must be held before the temporary rate starts. A shorter press is the menu. */
export const HOLD_MS = 300;

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

/** The next preset above or below `rate`, for the step keys; it stops at the ends. */
export function stepRate(rate: number, direction: 1 | -1): number {
  const presets = [...RATE_PRESETS] as number[];
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

/** Frame numbers are shown from 1 and typed from 1; the index counts from 0. */
export const displayFrame = (frame: number) => frame + 1;
export function parseFrameInput(text: string, totalFrames: number): number | null {
  const value = text.trim();
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  if (number < 1 || (totalFrames > 0 && number > totalFrames)) return null;
  return number - 1;
}

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
  | { type: "seek"; deltaMs: number }
  | { type: "volume"; delta: number }
  | { type: "frame"; delta: 1 | -1 }
  | { type: "mute" }
  | { type: "fullscreen" }
  | { type: "markA" }
  | { type: "markB" }
  | { type: "escape" }
  | { type: "rate"; direction: 1 | -1 }
  | { type: "start" };

/** Default keys (Q-13): arrows seek and set volume, `,` and `.` step a frame. Anything with Ctrl, Alt or Meta is left to the system. */
export function videoKeyAction(event: { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean }, seekStepSeconds: number): VideoKeyAction | null {
  if (event.ctrlKey || event.altKey || event.metaKey) return null;
  switch (event.key) {
    case " ":
    case "k":
    case "K": return { type: "toggle" };
    case "ArrowLeft": return { type: "seek", deltaMs: -seekStepSeconds * 1000 };
    case "ArrowRight": return { type: "seek", deltaMs: seekStepSeconds * 1000 };
    case "ArrowUp": return { type: "volume", delta: 0.05 };
    case "ArrowDown": return { type: "volume", delta: -0.05 };
    case ",": return { type: "frame", delta: -1 };
    case ".": return { type: "frame", delta: 1 };
    case "m":
    case "M": return { type: "mute" };
    case "f":
    case "F": return { type: "fullscreen" };
    case "i":
    case "I": return { type: "markA" };
    case "o":
    case "O": return { type: "markB" };
    case "[": return { type: "rate", direction: -1 };
    case "]": return { type: "rate", direction: 1 };
    case "Home": return { type: "start" };
    case "Escape": return { type: "escape" };
    default: return null;
  }
}

/** The keys the help list shows, in the order it shows them. */
export const SHORTCUTS: Array<{ keys: string; label: string }> = [
  { keys: "Space / K", label: "video.keyToggle" },
  { keys: "← / →", label: "video.keySeek" },
  { keys: "↑ / ↓", label: "video.keyVolume" },
  { keys: ", / .", label: "video.keyFrame" },
  { keys: "[ / ]", label: "video.keyRate" },
  { keys: "I / O", label: "video.keyMark" },
  { keys: "M", label: "video.keyMute" },
  { keys: "F", label: "video.keyFullscreen" },
  { keys: "Esc", label: "video.keyEscape" },
];

// ---- subtitle tracks ---------------------------------------------------------

export type SubtitleTrack = {
  id: string;
  source: "embedded" | "external";
  streamIndex: number | null;
  codec: string;
  /** `ass` is drawn by the ASS renderer; `srt` and `vtt` become native text tracks; null cannot be drawn (picture subtitles). */
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

export function subtitleRenderer(track: Pick<SubtitleTrack, "format">): "ass" | "native" | null {
  if (track.format === "ass") return "ass";
  return track.format === null ? null : "native";
}

// ---- WebVTT ------------------------------------------------------------------

export type VttCue = { startMs: number; endMs: number; text: string };

function vttTime(text: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(text.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  return (Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 + Number(fraction!.padEnd(3, "0"));
}

/**
 * The cues of a WebVTT file. The player adds them to a text track itself, so no URL has to be loaded by the page.
 * A cue with no readable times is skipped rather than failing the whole file.
 */
export function parseVtt(source: string): VttCue[] {
  const cues: VttCue[] = [];
  const blocks = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) continue;
    const [from, rest] = lines[at]!.split("-->");
    const start = vttTime(from ?? "");
    const end = vttTime((rest ?? "").trim().split(/\s+/)[0] ?? "");
    const text = lines.slice(at + 1).join("\n").trim();
    if (start === null || end === null || end <= start || !text) continue;
    cues.push({ startMs: start, endMs: end, text });
  }
  return cues;
}
