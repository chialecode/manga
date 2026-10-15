/** @vitest-environment jsdom */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { engineSpeed } from "../../apps/desktop/src/renderer/readers/danmaku-model.ts";
import type { DanmakuEngine, EngineFactory } from "../../apps/desktop/src/renderer/readers/danmaku-engine.ts";

/**
 * The real `danmaku` canvas engine, driven by a clock the test owns: jsdom has no canvas, so a context that only records what was drawn stands in for it,
 * and the frames are run by hand. What is checked is what a person would see: where a comment is, and how long it stays.
 */
let createEngine: EngineFactory;
let frames: Array<(timestamp: number) => void> = [];
let now = 0;
let drawn: Array<{ text: string; x: number }> = [];

class FakeMedia extends EventTarget {
  currentTime = 0;
  playbackRate = 1;
  paused = false;
}

beforeAll(async () => {
  // The engine takes the frame functions when its module is loaded, so they are in place before it is.
  window.requestAnimationFrame = ((callback: (timestamp: number) => void) => { frames.push(callback); return frames.length; }) as typeof window.requestAnimationFrame;
  window.cancelAnimationFrame = (() => { frames = []; }) as typeof window.cancelAnimationFrame;
  HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement) {
    const canvas = this as HTMLCanvasElement & { __text?: string };
    return {
      clearRect: () => { drawn = []; },
      drawImage: (source: HTMLCanvasElement & { __text?: string }, x: number) => { drawn.push({ text: source.__text ?? "", x }); },
      measureText: () => ({ width: 100 }),
      scale: () => {},
      fillText: (text: string) => { canvas.__text = text; },
      strokeText: () => {},
    };
  } as never;
  document.documentElement.style.fontSize = "16px";
  ({ createEngine } = await import("../../apps/desktop/src/renderer/readers/danmaku-engine.ts"));
});

beforeEach(() => {
  frames = [];
  drawn = [];
  now = 1000;
  vi.spyOn(window.performance, "now").mockImplementation(() => now);
  vi.spyOn(globalThis.performance, "now").mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); });

const STAGE_W = 1000;
const SPEED = 250; // px per second: crosses the 1000 px stage in four seconds

function rig(options: { followRate: boolean; rate?: number; comments: Array<{ time: number; mode: "rtl" | "top" | "bottom" }> }) {
  const container = document.createElement("div");
  container.style.fontSize = "16px";
  Object.defineProperty(container, "offsetWidth", { value: STAGE_W });
  Object.defineProperty(container, "offsetHeight", { value: 400 });
  document.body.append(container);
  const media = new FakeMedia();
  media.currentTime = 10;
  media.playbackRate = options.rate ?? 1;
  const engine: DanmakuEngine = createEngine({
    container,
    media: media as unknown as HTMLVideoElement,
    comments: options.comments.map((item, index) => ({ ...item, text: `c${index}`, color: "#ffffff" })),
    fontPx: 20,
    speedPxPerS: SPEED,
    followRate: options.followRate,
  });
  /** Wall-clock milliseconds go by; the film goes on at the rate. One frame per 16 ms. */
  const run = (ms: number) => {
    for (let spent = 0; spent < ms; spent += 16) {
      now += 16;
      media.currentTime += (16 / 1000) * media.playbackRate;
      const due = frames;
      frames = [];
      for (const callback of due) callback(now);
    }
  };
  const setRate = (rate: number) => { media.playbackRate = rate; media.dispatchEvent(new Event("ratechange")); };
  const xOf = (text: string) => drawn.find((item) => item.text === text)?.x ?? null;
  const present = (text: string) => drawn.some((item) => item.text === text);
  return { engine, media, container, run, setRate, xOf, present };
}

/** Pixels the comment moves in one wall-clock second, measured over ten frames somewhere in the middle of its way. */
function speedOnScreen(r: ReturnType<typeof rig>, text: string) {
  const before = r.xOf(text)!;
  r.run(160);
  return ((before - r.xOf(text)!) / 160) * 1000;
}

describe("engineSpeed (AT-106)", () => {
  it("divides the speed by the rate when the comments are not to follow it, and leaves it alone otherwise", () => {
    expect(engineSpeed(200, 2, true)).toBe(200);
    expect(engineSpeed(200, 2, false)).toBe(100);
    expect(engineSpeed(200, 0.5, false)).toBe(400);
    expect(engineSpeed(200, 1, false)).toBe(200);
  });

  it("does not divide by a rate that is not a number or not above zero", () => {
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(engineSpeed(200, rate, false)).toBe(200);
  });
});

describe("the speed of scrolling comments on the screen (AT-106)", () => {
  it("at 1x the engine moves a comment across the stage and its width in the time the speed says, whether or not it follows the rate", () => {
    for (const followRate of [true, false]) {
      const r = rig({ followRate, comments: [{ time: 10.2, mode: "rtl" }] });
      r.run(500);
      const perSecond = speedOnScreen(r, "c0");
      // (stage + comment) / duration, and the duration is the stage width over the speed: a little over 250 px per second.
      expect(perSecond, `followRate ${followRate}`).toBeGreaterThan(SPEED);
      expect(perSecond).toBeLessThan(SPEED * 1.2);
      r.engine.destroy();
    }
  });

  it("following the rate: twice as fast on the screen at 2x", () => {
    const slow = rig({ followRate: true, rate: 1, comments: [{ time: 10.2, mode: "rtl" }] });
    slow.run(400);
    const atOne = speedOnScreen(slow, "c0");
    const fast = rig({ followRate: true, rate: 2, comments: [{ time: 10.4, mode: "rtl" }] });
    fast.run(400);
    const atTwo = speedOnScreen(fast, "c0");
    expect(atTwo / atOne).toBeCloseTo(2, 1);
  });

  it("not following the rate: the same on the screen at 0.5x, 1x, 2x and 4x", () => {
    const speeds = [0.5, 1, 2, 4].map((rate) => {
      const r = rig({ followRate: false, rate, comments: [{ time: 10.1, mode: "rtl" }] });
      r.run(500);
      const perSecond = speedOnScreen(r, "c0");
      r.engine.destroy();
      return perSecond;
    });
    for (const perSecond of speeds) expect(perSecond / speeds[1]!).toBeCloseTo(1, 1);
  });

  it("not following the rate: changing the rate while a comment is flying changes neither its place nor its speed", () => {
    const r = rig({ followRate: false, comments: [{ time: 10.2, mode: "rtl" }] });
    r.run(1000);
    const first = speedOnScreen(r, "c0");
    const before = r.xOf("c0")!;
    r.setRate(2);
    r.run(16);
    const after = r.xOf("c0")!;
    // One frame at the old speed would move it by about 4 px; a jump would be tens or hundreds.
    expect(Math.abs(before - after)).toBeLessThan(first * 0.016 * 2);
    const second = speedOnScreen(r, "c0");
    expect(second / first).toBeCloseTo(1, 1);
    r.setRate(0.5);
    r.run(16);
    expect(r.xOf("c0")! - after).toBeLessThan(0);
    expect(speedOnScreen(r, "c0") / first).toBeCloseTo(1, 1);
  });

  it("following the rate: changing the rate while a comment is flying does not make it jump either, and it goes at the new rate from then on", () => {
    const r = rig({ followRate: true, comments: [{ time: 10.2, mode: "rtl" }] });
    r.run(1000);
    const first = speedOnScreen(r, "c0");
    const before = r.xOf("c0")!;
    r.setRate(2);
    r.run(16);
    const after = r.xOf("c0")!;
    // one frame at the old speed is about 4 px, at the new one 8 px; a jump would be the whole distance travelled so far
    expect(before - after).toBeGreaterThan(0);
    expect(before - after).toBeLessThan(first * 0.016 * 3);
    expect(speedOnScreen(r, "c0") / first).toBeCloseTo(2, 1);
  });
});

describe("how long top and bottom comments stay (AT-106)", () => {
  /** Wall-clock seconds from the comment showing up to its going away. */
  function stay(followRate: boolean, rate: number, mode: "top" | "bottom") {
    const r = rig({ followRate, rate, comments: [{ time: 10.1, mode }] });
    let first: number | null = null;
    let last: number | null = null;
    for (let at = 0; at < 12000; at += 16) {
      r.run(16);
      if (r.present("c0")) { first ??= at; last = at; }
    }
    r.engine.destroy();
    return { first, last, seconds: first === null || last === null ? 0 : (last - first) / 1000 };
  }

  it("stay the same number of seconds at 0.5x, 1x, 2x and 4x when the comments do not follow the rate", () => {
    for (const mode of ["top", "bottom"] as const) {
      const times = [0.5, 1, 2, 4].map((rate) => stay(false, rate, mode).seconds);
      for (const seconds of times) {
        expect(seconds, mode).toBeGreaterThan(3.7);
        expect(seconds).toBeLessThan(4.3);
      }
    }
  });

  it("stay half as long at 2x when they follow it", () => {
    const one = stay(true, 1, "top").seconds;
    const two = stay(true, 2, "top").seconds;
    expect(one).toBeGreaterThan(3.7);
    expect(two / one).toBeCloseTo(0.5, 1);
  });
});

describe("the engine's listeners", () => {
  it("takes its rate listener off when it is destroyed", () => {
    const r = rig({ followRate: false, comments: [] });
    const remove = vi.spyOn(r.media, "removeEventListener");
    r.engine.destroy();
    expect(remove.mock.calls.map((call) => call[0])).toContain("ratechange");
    expect(() => r.setRate(3)).not.toThrow();
  });
});
