import Danmaku from "danmaku/dist/esm/danmaku.canvas.js";
import { engineSpeed, type Prepared } from "./danmaku-model.ts";

/** The family the comments are drawn in; a canvas takes real family names, not the page's CSS variables. */
const FONT_FAMILY = "\"Microsoft YaHei\", \"PingFang SC\", \"Noto Sans CJK SC\", system-ui, sans-serif";

export type EngineInput = {
  container: HTMLElement;
  media: HTMLMediaElement;
  comments: readonly Prepared[];
  fontPx: number;
  speedPxPerS: number;
  /** Whether the comments' speed on the screen follows the video's playback rate; off keeps it at `speedPxPerS` whatever the rate. */
  followRate: boolean;
};

/** What the layer needs from the engine, so a test can stand in for it where there is no canvas. */
export interface DanmakuEngine {
  /** Called when the container's size has changed. */
  resize(): void;
  /** The canvas the comments are drawn on, for a screenshot that keeps them. */
  canvas(): HTMLCanvasElement | null;
  destroy(): void;
}
export type EngineFactory = (input: EngineInput) => DanmakuEngine;

/** The part of the engine's state that the rate change needs to carry across: the comments on the screen and the moment each one set out (seconds on the wall clock). */
type Running = { _utc: number };
const runningOf = (danmaku: unknown): Running[] => {
  const list = (danmaku as { _?: { runningList?: unknown } })._?.runningList;
  return Array.isArray(list) ? (list as Running[]) : [];
};
const wallSeconds = () => (typeof performance !== "undefined" ? performance.now() : Date.now()) / 1000;

/**
 * The `danmaku` package's canvas engine, bound to the video element: it follows play, pause and seek by itself. A comment's place is the time since it set
 * out times the rate times the engine's speed, so a change of the rate (or of the speed that goes with it) would make every comment on the screen jump;
 * `ratechange` here sets the speed for the new rate (see `engineSpeed`) and moves each comment's start so that it stays where it is.
 */
export const createEngine: EngineFactory = ({ container, media, comments, fontPx, speedPxPerS, followRate }) => {
  // One style object per colour is shared by all its comments; the engine only reads it.
  const styles = new Map<string, Record<string, unknown>>();
  const styleOf = (color: string) => {
    let style = styles.get(color);
    if (!style) {
      style = { font: `${fontPx}px ${FONT_FAMILY}`, fillStyle: color, strokeStyle: "#000000", lineWidth: Math.max(1, Math.round(fontPx / 14)), textBaseline: "bottom" };
      styles.set(color, style);
    }
    return style;
  };
  let rate = media.playbackRate;
  const danmaku = new Danmaku({
    container,
    media,
    engine: "canvas",
    speed: engineSpeed(speedPxPerS, rate, followRate),
    comments: comments.map((item) => ({ text: item.text, time: item.time, mode: item.mode, style: styleOf(item.color) as never })),
  });
  const onRate = () => {
    const next = media.playbackRate;
    if (!(next > 0) || next === rate) return;
    const before = rate * danmaku.speed;
    danmaku.speed = engineSpeed(speedPxPerS, next, followRate);
    const after = next * danmaku.speed;
    rate = next;
    // The place of a comment is (now - start) x rate x speed; keep that product where it was while the factor changes.
    if (after !== before && before > 0 && after > 0) {
      const now = wallSeconds();
      for (const running of runningOf(danmaku)) running._utc = now - ((now - running._utc) * before) / after;
    }
  };
  media.addEventListener("ratechange", onRate);
  return {
    resize: () => { danmaku.resize(); },
    canvas: () => container.querySelector("canvas"),
    destroy: () => {
      media.removeEventListener("ratechange", onRate);
      danmaku.destroy();
    },
  };
};
