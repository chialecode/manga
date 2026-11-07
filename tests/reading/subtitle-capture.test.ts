/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureVideoFrame, type SubtitleDraw } from "../../apps/desktop/src/renderer/readers/screenshot-capture.ts";
import { snapshotAss, type AssSurface } from "../../apps/desktop/src/renderer/readers/subtitle-ass-shot.ts";
import { DEFAULT_SUBTITLE_STYLE, type SubtitleCue } from "../../apps/desktop/src/renderer/readers/subtitle-model.ts";
import { installCapture } from "../helpers/dom.ts";

/**
 * The ASS subtitle of a screenshot and the order a screenshot is put together in (AT-109). The renderer is a stand-in that answers `resize` the way
 * JASSUB does: the canvas it draws on takes the new size a moment later, with the subtitle painted on it.
 */
let capture: ReturnType<typeof installCapture>;
beforeEach(() => { capture = installCapture({ video: { w: 1920, h: 1080 } }); });
afterEach(() => { capture.restore(); vi.useRealTimers(); });

type Painted = HTMLCanvasElement & { __ink?: boolean };

function surface(options: { live?: { w: number; h: number }; ink?: boolean; follows?: boolean; hangs?: boolean } = {}) {
  const live = document.createElement("canvas") as Painted;
  const size = options.live ?? { w: 1280, h: 720 };
  live.width = size.w;
  live.height = size.h;
  live.__ink = options.ink ?? true;
  const calls: Array<{ force?: boolean; w?: number; h?: number }> = [];
  const renderer: AssSurface = {
    _canvas: live,
    resize(force, w, h) {
      calls.push({ force, w, h });
      if (options.hangs) return new Promise<void>(() => undefined);
      // The size the picture has on screen when none is asked for; the worker's frame reaches the page a little later.
      const [nextW, nextH] = w && h ? [w, h] : [size.w, size.h];
      if (options.follows !== false) setTimeout(() => { live.width = nextW; live.height = nextH; live.__ink = options.ink ?? true; }, 25);
      return Promise.resolve();
    },
  };
  return { renderer, live, calls };
}

describe("an ASS subtitle at the size of the file (AT-109)", () => {
  it("asks the renderer to draw again at the size of the file, reads what it drew, and puts the renderer back to the size on screen", async () => {
    const { renderer, calls } = surface();
    const picture = await snapshotAss(renderer, { w: 1920, h: 1080 });
    expect(picture).not.toBeNull();
    expect(picture!.width).toBe(1920);
    expect(picture!.height).toBe(1080);
    expect(calls[0]).toEqual({ force: true, w: 1920, h: 1080 });
    expect(calls.at(-1)).toEqual({ force: true, w: undefined, h: undefined });
  });

  it("asks for nothing when the renderer is already drawing at the size of the file or more", async () => {
    const { renderer, calls } = surface({ live: { w: 2560, h: 1440 } });
    const picture = await snapshotAss(renderer, { w: 1920, h: 1080 });
    expect(picture!.width).toBe(2560);
    expect(calls).toHaveLength(0);
  });

  it("falls back to what was on screen, at the size it had, when the renderer does not answer in time", async () => {
    const { renderer, calls } = surface({ hangs: true });
    const picture = await snapshotAss(renderer, { w: 1920, h: 1080 }, { timeoutMs: 60, settleMs: 5 });
    expect(picture!.width).toBe(1280);
    expect(picture!.height).toBe(720);
    // It is put back whatever happened.
    expect(calls).toHaveLength(2);
  });

  it("falls back the same way when the canvas never takes the new size", async () => {
    const { renderer } = surface({ follows: false });
    const picture = await snapshotAss(renderer, { w: 1920, h: 1080 }, { timeoutMs: 60, settleMs: 5 });
    expect(picture!.width).toBe(1280);
  });

  it("keeps what was on screen when the redrawn canvas came back empty and the screen had a subtitle", async () => {
    const { renderer, live } = surface();
    const resize = renderer.resize.bind(renderer);
    renderer.resize = (force, w, h) => {
      const done = resize(force, w, h);
      if (w) setTimeout(() => { live.__ink = false; }, 30);
      return done;
    };
    const picture = await snapshotAss(renderer, { w: 1920, h: 1080 }, { settleMs: 60 });
    expect((picture as Painted).__ink).toBe(true);
    expect(picture!.width).toBe(1280);
  });

  it("gives nothing when the canvas has never been drawn on", async () => {
    const { renderer } = surface({ live: { w: 0, h: 0 }, follows: false });
    const picture = await snapshotAss(renderer, { w: 1920, h: 1080 }, { timeoutMs: 40, settleMs: 5 });
    expect(picture).toBeNull();
  });
});

describe("putting a screenshot together (AT-109)", () => {
  const video = () => {
    const element = document.createElement("video");
    return element;
  };
  const cue: SubtitleCue = { startMs: 0, endMs: 5000, lines: ["字幕"], top: false };
  const text = { main: [cue], second: [], timeMs: 1000, style: DEFAULT_SUBTITLE_STYLE };

  it("takes the frame first and asks for the subtitles afterwards, then draws them over it", async () => {
    const order: string[] = [];
    const ass = document.createElement("canvas") as Painted;
    ass.width = 1920; ass.height = 1080; ass.__ink = true;
    const shot = await captureVideoFrame(video(), {
      subtitles: async () => {
        order.push(`asked after ${capture.draws.length} draw(s)`);
        return { ass, text } satisfies SubtitleDraw;
      },
    });
    expect("failure" in shot).toBe(false);
    if ("failure" in shot) return;
    expect(order).toEqual(["asked after 1 draw(s)"]);
    expect(shot.subtitlesDrawn).toBe(true);
    expect(shot.danmakuDrawn).toBe(false);
    expect(shot.width).toBe(1920);
    // frame, the ASS picture stretched over the whole frame; the text is fillText
    expect(capture.draws).toHaveLength(2);
    expect(capture.draws[1]!.args.slice(1)).toEqual([0, 0, 1920, 1080, 0, 0, 1920, 1080]);
    expect(capture.texts.some((item) => item.op === "fill" && item.text === "字幕")).toBe(true);
  });

  it("says no subtitles were drawn when an ASS track shows nothing at that moment and no text track does either", async () => {
    const ass = document.createElement("canvas") as Painted;
    ass.width = 1920; ass.height = 1080; ass.__ink = false;
    const shot = await captureVideoFrame(video(), { subtitles: { ass, text: { ...text, main: [] } } });
    expect("failure" in shot ? null : shot.subtitlesDrawn).toBe(false);
    expect(capture.texts).toHaveLength(0);
  });

  it("draws nothing and says so when it was not asked for subtitles", async () => {
    const shot = await captureVideoFrame(video(), { subtitles: null });
    expect("failure" in shot ? null : shot.subtitlesDrawn).toBe(false);
    expect(capture.texts).toHaveLength(0);
    expect(capture.draws).toHaveLength(1);
  });

  it("still gives the picture when the subtitles could not be made", async () => {
    const shot = await captureVideoFrame(video(), { subtitles: () => Promise.reject(new Error("renderer gone")) });
    expect("failure" in shot).toBe(false);
    if (!("failure" in shot)) expect(shot.subtitlesDrawn).toBe(false);
  });

  it("puts the comments under the subtitles and tells which of them it drew", async () => {
    const comments = document.createElement("canvas");
    comments.width = 800; comments.height = 200;
    const shot = await captureVideoFrame(video(), { subtitles: { text }, danmaku: { canvas: comments, area: 0.5, opacity: 1 } });
    expect("failure" in shot).toBe(false);
    if ("failure" in shot) return;
    expect(shot.danmakuDrawn).toBe(true);
    expect(shot.subtitlesDrawn).toBe(true);
    // frame, then the comments; the subtitles are text, drawn last
    expect(capture.draws[1]!.args[0]).toBe(comments);
    expect(capture.texts.length).toBeGreaterThan(0);
  });
});
