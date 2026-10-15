import { MangaError, PROMPT_LIMIT_DEFAULT, PROMPT_LIMIT_MAX, PROMPT_LIMIT_MIN } from "@manga/contracts";
import { checkOverrides, type KeyOverrides } from "@manga/contracts/keys";
import type { DrizzleStore } from "@manga/storage-drizzle";

export type Overlay = { x?: number; y?: number; width: number; height: number };

export type RecordingSettings = {
  /** `null` is the system default microphone. */
  deviceId: string | null;
  /** In-app hold-to-record key (a `KeyboardEvent.code`, for example `F9`). Hold is never a global shortcut. */
  holdKey: string;
  toggleKey: string;
  retention: "keep" | "discard";
  duckPlayback: "none" | "lower" | "pause";
  /** Kept on each side of detected speech, so the first and last syllables are not cut. */
  boundaryMarginMs: number;
  overlay: Overlay;
  /** The language the recording is spoken in, as the provider names it ("zh", "ja", "en"); `null` lets the provider decide. */
  language: string | null;
  /** The longest dictionary hint sent with a block of audio, in characters. A model may take less than this, so a connection can have its own limit. */
  promptChars: number;
  promptCharsByConnection: Record<string, number>;
};

export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = {
  deviceId: null,
  holdKey: "F9",
  toggleKey: "F8",
  retention: "keep",
  duckPlayback: "lower",
  boundaryMarginMs: 300,
  overlay: { width: 280, height: 84 },
  language: null,
  promptChars: PROMPT_LIMIT_DEFAULT,
  promptCharsByConnection: {},
};

export type MediaSettings = {
  /** The keys of the readers and the window the person changed (the others keep the defaults of `@manga/contracts/keys`). */
  keys: KeyOverrides;
  comic: {
    direction: "ltr" | "rtl";
    layout: "single" | "double" | "strip";
    coverAlone: boolean;
    fit: "width" | "height" | "page" | "original";
    zoom: number;
    /** 0 is off; the reader turns it on with 5. */
    autoFlipSeconds: number;
    animation: "none" | "slide" | "fade";
  };
  video: {
    rate: number;
    /** The rates the bottom bar and the context menu offer; 1× is always in it. */
    rates: number[];
    /** The rate the R key switches to from 1× (and back from). */
    customRate: number;
    /** Rate while the right button is held. */
    holdRate: number;
    volume: number;
    muted: boolean;
    seekStepSeconds: number;
    /** Start the next episode when one ends. Off unless the user turns it on. */
    autoNext: boolean;
    /** Text subtitles by the standard (A-59): below a widescreen picture when the black bar is tall enough, or always on the picture. */
    subtitlePlacement: "auto" | "inside";
    /** Type height as a share of the picture height, in percent; the standard asks for 5. */
    subtitleSizePct: number;
    subtitleFont: "sans" | "serif" | "kai";
    subtitleOutline: boolean;
    /** An ASS file keeps its own styles, or is restyled by the standard (font, size, outline and place only). */
    assStyle: "keep" | "standard";
    /** A screenshot has the subtitles that are on screen drawn into it (A-92); the text is kept in its record either way. */
    shotSubtitles: boolean;
  };
};

export const DEFAULT_MEDIA_SETTINGS: MediaSettings = {
  keys: {},
  comic: { direction: "rtl", layout: "single", coverAlone: true, fit: "page", zoom: 1, autoFlipSeconds: 0, animation: "fade" },
  video: { rate: 1, rates: [0.5, 0.75, 1, 1.25, 1.5, 2, 3], customRate: 1.5, holdRate: 2, volume: 1, muted: false, seekStepSeconds: 5, autoNext: false, subtitlePlacement: "auto", subtitleSizePct: 5, subtitleFont: "sans", subtitleOutline: true, assStyle: "keep", shotSubtitles: true },
};

/** The least and the most a playback rate may be. */
const RATE_MIN = 0.25;
const RATE_MAX = 4;

const RECORDING_KEY = "settings.recording";
const MEDIA_KEY = "settings.media";
const KEY_NAME = /^[A-Za-z0-9_+-]{1,32}$/;

function read<T extends object>(store: DrizzleStore, key: string, fallback: T): T {
  const raw = store.getMeta(key);
  if (!raw) return structuredClone(fallback);
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const merged: Record<string, unknown> = structuredClone(fallback) as Record<string, unknown>;
    for (const [name, item] of Object.entries(value)) {
      const base = merged[name];
      merged[name] = base && typeof base === "object" && !Array.isArray(base) && item && typeof item === "object" ? { ...base, ...item } : item;
    }
    return merged as T;
  } catch {
    return structuredClone(fallback);
  }
}

export function readRecordingSettings(store: DrizzleStore): RecordingSettings {
  return read(store, RECORDING_KEY, DEFAULT_RECORDING_SETTINGS);
}

export function writeRecordingSettings(store: DrizzleStore, patch: Partial<Omit<RecordingSettings, "overlay" | "promptCharsByConnection">> & { overlay?: Partial<Overlay>; promptCharsByConnection?: Record<string, number | null> }): RecordingSettings {
  const current = readRecordingSettings(store);
  const byConnection = { ...current.promptCharsByConnection };
  for (const [connectionId, value] of Object.entries(patch.promptCharsByConnection ?? {})) {
    if (value === null) delete byConnection[connectionId];
    else byConnection[connectionId] = value;
  }
  const next: RecordingSettings = { ...current, ...patch, promptCharsByConnection: byConnection, overlay: { ...current.overlay, ...(patch.overlay ?? {}) } };
  if (next.deviceId === undefined) next.deviceId = null;
  for (const key of [next.holdKey, next.toggleKey]) {
    if (!KEY_NAME.test(key)) throw new MangaError("VALIDATION_ERROR", "a recording key must be a key name such as F9");
  }
  // Two commands on one key would make one of them unreachable, and the user would not learn which until recording.
  if (next.holdKey === next.toggleKey) throw new MangaError("VALIDATION_ERROR", "hold and toggle recording need different keys");
  const limit = (value: number) => Number.isInteger(value) && value >= PROMPT_LIMIT_MIN && value <= PROMPT_LIMIT_MAX;
  if (!limit(next.promptChars) || Object.values(next.promptCharsByConnection).some((value) => !limit(value))) throw new MangaError("VALIDATION_ERROR", `the hint length must be between ${PROMPT_LIMIT_MIN} and ${PROMPT_LIMIT_MAX} characters`);
  store.setMeta(RECORDING_KEY, JSON.stringify(next));
  return next;
}

/** The hint length for a connection: its own limit when the user set one, else the general one. */
export function promptLimitFor(settings: RecordingSettings, connectionId: string | null | undefined): number {
  return (connectionId ? settings.promptCharsByConnection[connectionId] : undefined) ?? settings.promptChars;
}

export function readMediaSettings(store: DrizzleStore): MediaSettings {
  return read(store, MEDIA_KEY, DEFAULT_MEDIA_SETTINGS);
}

/** The rate list as it is kept: each between 0.25 and 4 with at most two decimals, no repeats, in order, and 1× always in it. */
export function normalizeRates(rates: readonly number[]): number[] {
  for (const rate of rates) {
    if (!Number.isFinite(rate) || rate < RATE_MIN || rate > RATE_MAX || Math.abs(rate * 100 - Math.round(rate * 100)) > 1e-6) {
      throw new MangaError("VALIDATION_ERROR", `a rate must be between ${RATE_MIN} and ${RATE_MAX} with at most two decimals`);
    }
  }
  return [...new Set([...rates.map((rate) => Math.round(rate * 100) / 100), 1])].sort((a, b) => a - b);
}

export function writeMediaSettings(
  store: DrizzleStore,
  patch: {
    comic?: Partial<MediaSettings["comic"]>;
    video?: Partial<Omit<MediaSettings["video"], "rates">> & { rates?: number[] };
    /** An action's chords, or `null` to put its default back. */
    keys?: Record<string, string[] | null>;
  },
): MediaSettings {
  const current = readMediaSettings(store);
  const keys: KeyOverrides = { ...current.keys };
  for (const [id, chords] of Object.entries(patch.keys ?? {})) {
    if (chords === null) delete keys[id];
    else keys[id] = chords;
  }
  const problem = checkOverrides(keys);
  if (problem) throw new MangaError("VALIDATION_ERROR", problem);
  const video = { ...current.video, ...(patch.video ?? {}), rates: patch.video?.rates ? normalizeRates(patch.video.rates) : current.video.rates };
  const next: MediaSettings = { keys, comic: { ...current.comic, ...(patch.comic ?? {}) }, video };
  store.setMeta(MEDIA_KEY, JSON.stringify(next));
  return next;
}
