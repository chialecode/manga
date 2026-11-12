import { MangaError } from "@manga/contracts";

/** The presentation time of every frame of a video, and its keyframes; built on demand by reading every packet. */
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

/**
 * Which frame is on screen at a time, or at a frame number, or `delta` frames from either, from the stored presentation times (never an
 * average frame rate). Shared by the library's videos and light open.
 */
export function answerFrame(index: FrameIndex, durationMs: number, query: { timeMs?: number; frame?: number; delta?: number }): FrameAnswer {
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
    frame, ptsMs: pts[frame]!, totalFrames: pts.length, durationMs, variableFrameRate: index.variableFrameRate,
    previousMs: frame > 0 ? pts[frame - 1]! : null, nextMs: frame + 1 < pts.length ? pts[frame + 1]! : null,
  };
}
