/**
 * Whether a playing video really shows a picture. A file can play (the clock runs, the sound is heard) while the decoder produces no frames;
 * the window is then black with nothing to say why. The player watches the element's own counters and, when the picture is missing,
 * says so and offers what can help (a play copy). All numbers come from the media element; nothing here reads the file.
 */

export type HealthSample = {
  /** Milliseconds on the page's clock when the sample was taken. */
  at: number;
  /** The element's time, in milliseconds. */
  mediaMs: number;
  /** Frames the element has presented since its source was set (`getVideoPlaybackQuality().totalVideoFrames`, and the frame callback's count). */
  frames: number;
  playing: boolean;
};

export type VideoHealth =
  | { state: "ok" }
  /** The source has been set for a while and not one frame was presented. */
  | { state: "no-first-frame"; waitedMs: number }
  /** The clock runs but the frame count does not. */
  | { state: "no-frames"; mediaMs: number; frames: number };

/** A picture should be on screen this long after the source is set. */
export const FIRST_FRAME_MS = 2000;
/** A stall is judged over this much page time … */
export const STALL_WINDOW_MS = 2000;
/** … in which the clock must have moved at least this much (so a pause or a wait for data is not a stall) … */
export const STALL_MIN_MEDIA_MS = 1000;
/** … while fewer than this many frames were presented. Even a slow video presents several in a second of its time. */
export const STALL_MAX_FRAMES = 2;

/**
 * The verdict from what the element has reported. `sourceAgeMs` is how long ago the source was set; `samples` are the latest readings, oldest first.
 * A stall needs a full window of samples, so a start-up or a seek (where frames lag the clock for a moment) is not mistaken for one.
 */
export function judgeHealth(input: { sourceAgeMs: number; samples: readonly HealthSample[] }): VideoHealth {
  const { samples } = input;
  const last = samples[samples.length - 1];
  if (!last) return { state: "ok" };
  const anyFrame = samples.some((sample) => sample.frames > 0);
  if (!anyFrame) {
    return input.sourceAgeMs >= FIRST_FRAME_MS ? { state: "no-first-frame", waitedMs: Math.round(input.sourceAgeMs) } : { state: "ok" };
  }
  if (!last.playing) return { state: "ok" };
  const from = samples.find((sample) => last.at - sample.at <= STALL_WINDOW_MS);
  if (!from || last.at - from.at < STALL_WINDOW_MS - 500) return { state: "ok" };
  // Only the stretch in which the video was playing counts.
  const window = samples.filter((sample) => sample.at >= from.at);
  if (!window.every((sample) => sample.playing)) return { state: "ok" };
  const moved = last.mediaMs - from.mediaMs;
  const presented = last.frames - from.frames;
  if (moved >= STALL_MIN_MEDIA_MS && presented < STALL_MAX_FRAMES) return { state: "no-frames", mediaMs: Math.round(last.mediaMs), frames: last.frames };
  return { state: "ok" };
}

/** What the debug panel shows about the picture: the element's own facts, as numbers. */
export type VideoFacts = {
  /** How the file plays: the original, or a play copy; and the plan's decision with its reasons. */
  playing: "original" | "play_copy" | "none";
  decision: string;
  reasons: string[];
  readyState: number;
  networkState: number;
  decodedFrames: number;
  droppedFrames: number;
  width: number;
  height: number;
  health: VideoHealth["state"];
  /** The ASS renderer or the text layer, with the state of the subtitle track. */
  subtitleRenderer: "jassub" | "text" | "none";
  subtitleStatus: string;
  /** Where the default font of the ASS renderer comes from, and its family. */
  defaultFont: string;
  /** Fonts the subtitle styles ask for that neither the video nor the machine has. */
  missingFonts: string[];
};
