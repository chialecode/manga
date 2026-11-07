/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createRef, type MutableRefObject } from "react";
import { DEFAULT_DANMAKU_SETTINGS, type DanmakuItem, type DanmakuSettings } from "@manga/contracts/danmaku";
import { DanmakuLayer } from "../../apps/desktop/src/renderer/readers/danmaku-layer.tsx";
import type { EngineFactory, EngineInput } from "../../apps/desktop/src/renderer/readers/danmaku-engine.ts";

/** jsdom lays nothing out; the stage gets a size of its own, as a real window would give it. */
const stage = { w: 1280, h: 720 };
const wide = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
const high = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.classList.contains("test-stage") ? stage.w : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get(this: HTMLElement) { return this.classList.contains("test-stage") ? stage.h : 0; } });
  stage.w = 1280;
  stage.h = 720;
});
afterEach(() => {
  cleanup();
  if (wide) Object.defineProperty(HTMLElement.prototype, "clientWidth", wide);
  if (high) Object.defineProperty(HTMLElement.prototype, "clientHeight", high);
  vi.useRealTimers();
});

const settings = (patch: Partial<DanmakuSettings> = {}): DanmakuSettings => ({ ...DEFAULT_DANMAKU_SETTINGS, enabled: true, ...patch });
const item = (at: number, text: string, patch: Partial<DanmakuItem> = {}): DanmakuItem => ({ at, mode: "scroll", color: 0xffffff, source: "", text, ...patch });

function video(size: { w: number; h: number }): HTMLVideoElement {
  const element = document.createElement("video");
  Object.defineProperty(element, "videoWidth", { configurable: true, get: () => size.w });
  Object.defineProperty(element, "videoHeight", { configurable: true, get: () => size.h });
  return element;
}

function engines() {
  const made: EngineInput[] = [];
  const destroyed: number[] = [];
  const factory: EngineFactory = (input) => {
    made.push(input);
    const index = made.length;
    return { resize() {}, canvas: () => document.createElement("canvas"), destroy: () => { destroyed.push(index); } };
  };
  return { made, destroyed, factory };
}

const ONE = [item(1000, "你好")];

function mount(props: Partial<Parameters<typeof DanmakuLayer>[0]> & { factory: EngineFactory }, media = video({ w: 1920, h: 1080 })) {
  const element = (p: Partial<Parameters<typeof DanmakuLayer>[0]>) => (
    <div className="test-stage">
      <DanmakuLayer media={media} items={ONE} settings={settings()} offsetMs={0} originMs={0} visible {...p} />
    </div>
  );
  const view = render(element(props));
  return { ...view, media, update: (next: Partial<Parameters<typeof DanmakuLayer>[0]>) => view.rerender(element({ ...props, ...next })) };
}

const layer = () => screen.getByTestId("danmaku-layer");

describe("danmaku layer", () => {
  it("covers the top part of the picture and not the bars around it", () => {
    // A 4:3 picture in a 16:9 stage has bars at the sides; the comments stay on the picture.
    const run = engines();
    mount({ factory: run.factory, settings: settings({ area: 0.5 }) }, video({ w: 1440, h: 1080 }));
    expect(layer().style.left).toBe("160px");
    expect(layer().style.width).toBe("960px");
    expect(layer().style.height).toBe("360px");
    expect(layer().style.top).toBe("0px");
    expect(layer().getAttribute("aria-hidden")).toBe("true");
  });

  it("gives the engine the shown comments, the text size and the speed for this picture", () => {
    const run = engines();
    mount({ factory: run.factory, items: [item(1000, "你好"), item(2000, "好吧", { mode: "top" })], settings: settings({ top: false }) });
    expect(run.made).toHaveLength(1);
    expect(run.made[0]!.comments.map((comment) => comment.text)).toEqual(["你好"]);
    // 1280 x 720 picture: 720 / 1080 * 25 and 192 * 1280 / 1920.
    expect(run.made[0]!.fontPx).toBe(17);
    expect(run.made[0]!.speedPxPerS).toBeCloseTo(128, 5);
    expect(layer().getAttribute("data-count")).toBe("1");
  });

  it("puts the episode's offset and the file's start on the comments", () => {
    const run = engines();
    mount({ factory: run.factory, items: [item(10_000, "x")], offsetMs: 2000, originMs: 500 });
    expect(run.made[0]!.comments[0]!.time).toBeCloseTo(12.5, 5);
  });

  it("builds nothing while the comments are not shown and builds when they are", () => {
    const run = engines();
    const view = mount({ factory: run.factory, visible: false });
    expect(run.made).toHaveLength(0);
    expect(layer().getAttribute("data-visible")).toBeNull();
    view.update({ visible: true });
    expect(run.made).toHaveLength(1);
    view.update({ visible: false });
    expect(run.destroyed).toEqual([1]);
  });

  it("builds again when the shown comments change, and not for opacity", () => {
    const run = engines();
    const view = mount({ factory: run.factory });
    view.update({ settings: settings({ opacity: 0.4 }) });
    expect(run.made).toHaveLength(1);
    expect(layer().style.opacity).toBe("0.4");
    view.update({ settings: settings({ opacity: 0.4, blockWords: ["你"] }) });
    expect(run.made).toHaveLength(2);
    expect(run.destroyed).toEqual([1]);
    expect(run.made[1]!.comments).toHaveLength(0);
  });

  it("tells the engine whether the speed follows the playback rate, and builds again when that is switched (AT-106)", () => {
    const run = engines();
    const view = mount({ factory: run.factory });
    expect(run.made[0]!.followRate).toBe(true);
    view.update({ settings: settings({ followRate: false }) });
    expect(run.made).toHaveLength(2);
    expect(run.made[1]!.followRate).toBe(false);
    expect(run.destroyed).toEqual([1]);
    // the speed the engine is given is the setting's own; the division by the rate is the engine's, where the rate is read
    expect(run.made[1]!.speedPxPerS).toBeCloseTo(run.made[0]!.speedPxPerS, 5);
  });

  it("changes the height of its box with the area", () => {
    const run = engines();
    const view = mount({ factory: run.factory, settings: settings({ area: 0.25 }) });
    expect(layer().style.height).toBe("180px");
    view.update({ settings: settings({ area: 1 }) });
    expect(layer().style.height).toBe("720px");
  });

  it("follows the picture when the window changes size, once it settles", () => {
    vi.useFakeTimers();
    const resizes: Array<() => void> = [];
    class FakeObserver { constructor(callback: () => void) { resizes.push(callback); } observe() {} disconnect() {} }
    vi.stubGlobal("ResizeObserver", FakeObserver);
    try {
      const run = engines();
      mount({ factory: run.factory });
      expect(layer().style.width).toBe("1280px");
      stage.w = 1920;
      stage.h = 1080;
      act(() => { resizes.forEach((callback) => callback()); resizes.forEach((callback) => callback()); });
      // Nothing changes while the size is still changing.
      expect(layer().style.width).toBe("1280px");
      act(() => { vi.advanceTimersByTime(130); });
      expect(layer().style.width).toBe("1920px");
      expect(run.made.at(-1)!.speedPxPerS).toBeCloseTo(192, 5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("builds nothing on a picture too small to draw on and gives the screenshot code the canvas while it exists", () => {
    const run = engines();
    const capture: MutableRefObject<(() => HTMLCanvasElement | null) | null> = createRef() as MutableRefObject<(() => HTMLCanvasElement | null) | null>;
    capture.current = null;
    stage.w = 8;
    stage.h = 8;
    const small = mount({ factory: run.factory, captureRef: capture });
    expect(run.made).toHaveLength(0);
    small.unmount();
    stage.w = 1280;
    stage.h = 720;
    const view = mount({ factory: run.factory, captureRef: capture });
    expect(capture.current?.()).toBeInstanceOf(HTMLCanvasElement);
    view.unmount();
    expect(capture.current).toBeNull();
  });
});
