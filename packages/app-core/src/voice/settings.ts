import { MangaError } from "@manga/contracts";
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
};

export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = {
  deviceId: null,
  holdKey: "F9",
  toggleKey: "F8",
  retention: "keep",
  duckPlayback: "lower",
  boundaryMarginMs: 300,
  overlay: { width: 280, height: 84 },
};

export type MediaSettings = {
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
    /** Rate while the right button is held. */
    holdRate: number;
    volume: number;
    muted: boolean;
    seekStepSeconds: number;
    /** Start the next episode when one ends. Off unless the user turns it on. */
    autoNext: boolean;
  };
};

export const DEFAULT_MEDIA_SETTINGS: MediaSettings = {
  comic: { direction: "rtl", layout: "single", coverAlone: true, fit: "page", zoom: 1, autoFlipSeconds: 0, animation: "fade" },
  video: { rate: 1, holdRate: 2, volume: 1, muted: false, seekStepSeconds: 5, autoNext: false },
};

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

export function writeRecordingSettings(store: DrizzleStore, patch: Partial<Omit<RecordingSettings, "overlay">> & { overlay?: Partial<Overlay> }): RecordingSettings {
  const current = readRecordingSettings(store);
  const next: RecordingSettings = { ...current, ...patch, overlay: { ...current.overlay, ...(patch.overlay ?? {}) } };
  if (next.deviceId === undefined) next.deviceId = null;
  for (const key of [next.holdKey, next.toggleKey]) {
    if (!KEY_NAME.test(key)) throw new MangaError("VALIDATION_ERROR", "a recording key must be a key name such as F9");
  }
  // Two commands on one key would make one of them unreachable, and the user would not learn which until recording.
  if (next.holdKey === next.toggleKey) throw new MangaError("VALIDATION_ERROR", "hold and toggle recording need different keys");
  store.setMeta(RECORDING_KEY, JSON.stringify(next));
  return next;
}

export function readMediaSettings(store: DrizzleStore): MediaSettings {
  return read(store, MEDIA_KEY, DEFAULT_MEDIA_SETTINGS);
}

export function writeMediaSettings(store: DrizzleStore, patch: { comic?: Partial<MediaSettings["comic"]>; video?: Partial<MediaSettings["video"]> }): MediaSettings {
  const current = readMediaSettings(store);
  const next: MediaSettings = { comic: { ...current.comic, ...(patch.comic ?? {}) }, video: { ...current.video, ...(patch.video ?? {}) } };
  store.setMeta(MEDIA_KEY, JSON.stringify(next));
  return next;
}
