/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import type { ReactNode } from "react";
import { ComicReader, type ComicDoc, type ComicSettings } from "../../apps/desktop/src/renderer/readers/comic-reader.tsx";
import { VideoPlayer, type VideoDoc, type VideoSettings } from "../../apps/desktop/src/renderer/readers/video-player.tsx";
import { WindowFullscreenProvider } from "../../apps/desktop/src/renderer/readers/window-fullscreen.tsx";
import { resetVideoSupport } from "../../apps/desktop/src/renderer/readers/video-support.ts";
import { KeyTableProvider } from "../../apps/desktop/src/renderer/lib/key-table.tsx";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { resolveKeys } from "@manga/contracts/keys";
import { installMatchMedia, installMediaElement, installPicture, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";

/**
 * AT-108: what floats over a reader (the player's bar, the comic's bar, the page's own top in a full window) must not cover what the reader puts over its
 * picture or its page: the prompt at the end, the notices at the top, the tool that frames a region. jsdom lays nothing out, so the layout itself is read
 * from the stylesheets, and what the readers hand to those rules (the height of the bar, whether the window is full) is read from the readers; the real
 * window, where a point is hit-tested, is the packaged walk's (`overlays-hit` in the window walk).
 */
const read = (path: string) => readFileSync(join(process.cwd(), "apps/desktop/src/renderer", path), "utf8").replace(/\r\n/g, "\n");
/** The declarations of the first rule whose selector is exactly `selector`. */
const rule = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!match) throw new Error(`no rule for ${selector}`);
  return match[1]!;
};
const zOf = (declarations: string): number => Number(/z-index:\s*(\d+)/.exec(declarations)?.[1] ?? Number.NaN);

describe("the stylesheets keep what lies over a reader clear of what floats over it (AT-108)", () => {
  const video = read("styles-video.css");
  const reader = read("styles-reader.css");
  const base = read("styles.css");
  const frame = read("styles-frame.css");

  it("puts the player's prompts above the bar, and lifts the one at the bottom by the bar's height", () => {
    const bar = zOf(rule(video, ".video-shell[data-full] .video-controls"));
    expect(bar).toBeGreaterThan(0);
    for (const selector of [".video-end", ".video-health", ".video-big-play"]) expect(zOf(rule(video, selector)), selector).toBeGreaterThan(bar);
    expect(zOf(rule(video, ".video-holding, .video-subtitle-notice"))).toBeGreaterThan(bar);
    expect(rule(video, ".video-end")).toMatch(/inset:\s*auto 0 calc\(24px \+ var\(--player-lift, 0px\)\) 0/);
    // The status of a video that cannot play fills the stage: it keeps its text clear of the bar below and of the top above.
    expect(rule(video, ".video-overlay")).toMatch(/padding:\s*calc\(16px \+ var\(--player-top, 0px\)\) 16px calc\(16px \+ var\(--player-lift, 0px\)\)/);
  });

  it("starts the prompts at the top below the page's own top when that floats over the player in a full window", () => {
    for (const selector of [".video-health", ".video-holding, .video-subtitle-notice"]) expect(rule(video, selector), selector).toMatch(/top:\s*calc\(12px \+ var\(--player-top, 0px\)\)/);
    expect(rule(video, ".video-reader[data-window-full] .video-stage")).toMatch(/--player-top:\s*var\(--column-top-h\)/);
    // The one number: the column's top is that high, and so is the room kept for it.
    expect(base).toMatch(/--column-top-h: *36px/);
    expect(rule(frame, ".shell-top")).toMatch(/height:\s*var\(--column-top-h\)/);
  });

  it("raises the comic's last-page prompt above its bar and floats the region tool's note below the page's top", () => {
    const footer = zOf(rule(reader, ".reader[data-immersive] .comic-footer"));
    expect(footer).toBeGreaterThan(0);
    const end = rule(reader, ".reader[data-immersive] .comic-end");
    expect(zOf(end)).toBeGreaterThan(footer);
    expect(end).toMatch(/inset:\s*auto 0 calc\(24px \+ var\(--comic-footer-h, 0px\)\) 0/);
    const note = rule(reader, ".reader[data-immersive] .comic-region-bar");
    expect(note).toMatch(/position:\s*absolute/);
    expect(zOf(note)).toBeGreaterThan(footer);
    expect(rule(reader, ".reader[data-window-full] .comic-region-bar")).toMatch(/top:\s*calc\(var\(--column-top-h\) \+ 8px\)/);
    // The notices that stay at the top of the reader start below the page's own top; the region tool's note floats and does not count.
    expect(reader).toMatch(/\.reader\[data-window-full\]:has\(> \.reader-source, > \.reader-notice:not\(\.comic-region-bar\)\) \{ padding-top: var\(--column-top-h\); \}/);
  });

  it("keeps the strip that brings the page's top down and the zone under it thinner than the top, so they never cover a prompt that lies below it", () => {
    const strip = Number(/height:\s*(\d+)px/.exec(rule(frame, ".immersive-drag"))?.[1]);
    const zone = rule(frame, ".immersive-hotzone");
    const reach = Number(/top:\s*(\d+)px/.exec(zone)?.[1]) + Number(/height:\s*(\d+)px/.exec(zone)?.[1]);
    expect(strip).toBeGreaterThan(0);
    expect(reach).toBeLessThan(36);
  });
});

// ---- what the readers hand to those rules ----

const i18n = createTranslator("zh-CN");
let media: ReturnType<typeof installMediaElement>;
let picture: ReturnType<typeof installPicture>;

const withHeights = (heights: Record<string, number>) => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: HTMLElement) { return heights[this.dataset.testid ?? ""] ?? 0; } });
  return () => { Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight"); };
};
const windowFull = (active: boolean) => (node: ReactNode) => <WindowFullscreenProvider value={{ active, toggle: () => undefined, exit: () => undefined }}>{node}</WindowFullscreenProvider>;

describe("the comic reader hands its bar's height and whether the window is full to the rules (AT-108)", () => {
  const settings: ComicSettings = { direction: "rtl", layout: "single", coverAlone: true, fit: "page", zoom: 1, autoFlipSeconds: 0, animation: "fade" };
  const doc: ComicDoc = {
    resourceId: "res_c", revisionId: "rev_c", title: "合成漫画", direction: null, available: true, warnings: [],
    pages: Array.from({ length: 2 }, (_, index) => ({ id: `page-${index}`, index, name: `${index}.png`, width: 800, height: 1200, spread: false, ok: true })),
  };
  const mount = (wrap: (node: ReactNode) => ReactNode = (node) => node) => render(<>{wrap(<ComicReader t={i18n.t} doc={doc} settings={settings} onSettings={vi.fn()} onBack={vi.fn()} onPage={vi.fn()} onBackToNote={vi.fn()} onRepair={vi.fn()} />)}</>);
  beforeEach(() => {
    (window as unknown as { manga: unknown }).manga = { async command() { return { status: "ok", value: { pages: [] } }; } };
    installPointerEvent();
    quoteTags.reset();
  });
  afterEach(() => { cleanup(); removeMatchMedia(); quoteTags.reset(); });

  it("says it is the window that is full, and how high the bar is that floats over the page", () => {
    const restore = withHeights({ "comic-footer": 52 });
    try {
      mount(windowFull(true));
      const root = screen.getByTestId("comic-reader");
      expect(root.getAttribute("data-window-full")).toBe("true");
      expect(root.getAttribute("data-immersive")).toBe("true");
      expect(root.style.getPropertyValue("--comic-footer-h")).toBe("52px");
    } finally { restore(); }
  });

  it("is not a full window in the ordinary window", () => {
    const restore = withHeights({ "comic-footer": 52 });
    try {
      mount(windowFull(false));
      const root = screen.getByTestId("comic-reader");
      expect(root.getAttribute("data-window-full")).toBeNull();
      expect(root.getAttribute("data-immersive")).toBeNull();
    } finally { restore(); }
  });

  it("keeps the last-page prompt, the region tool's note and the page field in the reader, where the rules reach them", () => {
    const restore = withHeights({ "comic-footer": 52 });
    try {
      mount(windowFull(true));
      fireEvent.keyDown(window, { key: "ArrowLeft" });
      fireEvent.keyDown(window, { key: "ArrowLeft" });
      const root = screen.getByTestId("comic-reader");
      // The rules name them as children of the reader and of its frame; the prompt must not sit inside the bar, which would take it down with the bar.
      expect(screen.getByTestId("comic-frame").contains(screen.getByTestId("comic-end"))).toBe(true);
      expect(screen.getByTestId("comic-footer").contains(screen.getByTestId("comic-end"))).toBe(false);
      fireEvent.click(screen.getByTestId("comic-region-tool"));
      expect(screen.getByTestId("comic-region-bar").parentElement).toBe(root);
      fireEvent.click(screen.getByTestId("comic-position"));
      expect(screen.getByTestId("comic-footer").contains(screen.getByTestId("comic-page-input"))).toBe(true);
    } finally { restore(); }
  });
});

describe("the player hands its bar's height and whether the window is full to the rules (AT-108)", () => {
  const settings: VideoSettings = {
    rate: 1, rates: [0.5, 1, 2], customRate: 1.5, holdRate: 2, volume: 0.5, muted: false, seekStepSeconds: 5, autoNext: false,
    subtitlePlacement: "auto", subtitleSizePct: 5, subtitleFont: "sans", subtitleOutline: true, assStyle: "keep",
  };
  const doc: VideoDoc = { resourceId: "res_v", revisionId: "rev_v", title: "合成动画", episodeLabel: "第 1 话", durationMs: 120_000, available: true, audio: [], episodes: [] };
  const element = () => screen.getByTestId("video-element") as HTMLVideoElement;
  async function ready(wrap: (node: ReactNode) => ReactNode) {
    (window as unknown as { manga: unknown }).manga = {
      async command(payload: { commandId: string; input: Record<string, unknown> }) {
        switch (payload.commandId) {
          case "video.playbackPlan": return { status: "ok", value: { resourceId: "res_v", revisionId: "rev_v", available: true, plan: { decision: "direct", reasons: [], videoStreamIndex: 0, audioStreamIndex: 1, mediaType: "video/mp4", detail: "synthetic" }, copy: null } };
          case "video.handle": return { status: "ok", value: { source: payload.input.source, url: "manga-media://h/original", handle: "h", mediaType: "video/mp4", bytes: 10, startMs: 0 } };
          case "video.subtitles": return { status: "ok", value: { subtitles: [] } };
          case "video.fonts": return { status: "ok", value: { fonts: [] } };
          default: return { status: "ok", value: {} };
        }
      },
      onNotice: () => () => undefined,
    };
    const handlers = { onSettings: vi.fn(), onBack: vi.fn(), onNext: vi.fn(), onEpisode: vi.fn(), onProgress: vi.fn(), onBackToNote: vi.fn(), onRepair: vi.fn() };
    const keys = resolveKeys(undefined);
    render(<>{wrap(<KeyTableProvider value={keys}><VideoPlayer t={i18n.t} doc={doc} settings={settings} {...handlers} /></KeyTableProvider>)}</>);
    await waitFor(() => expect(element().getAttribute("src")).toBeTruthy(), { timeout: 20_000 });
    act(() => media.loaded(element(), 120));
    await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"), { timeout: 20_000 });
  }
  beforeEach(() => {
    media = installMediaElement();
    picture = installPicture({ frame: { w: 1280, h: 720 }, video: { w: 1920, h: 1080 } });
    installMatchMedia({ "(prefers-reduced-motion: reduce)": false });
    installPointerEvent();
    resetVideoSupport();
  });
  afterEach(() => { cleanup(); picture.restore(); media.restore(); removeMatchMedia(); vi.useRealTimers(); });

  it("in a full window: the bar floats over the picture, so every prompt is told to rise by its height, and the page's top is told to be cleared", async () => {
    const restore = withHeights({ "video-controls": 84 });
    try {
      await ready(windowFull(true));
      expect(screen.getByTestId("video-reader").getAttribute("data-window-full")).toBe("true");
      expect(screen.getByTestId("video-stage").style.getPropertyValue("--player-lift")).toBe("84px");
      act(() => media.finish(element()));
      // The prompt is in the stage, which is where the variable is, and the bar is still there (it does not hide at the end).
      expect(screen.getByTestId("video-stage").contains(screen.getByTestId("video-end"))).toBe(true);
      expect(screen.getByTestId("video-shell").hasAttribute("data-idle")).toBe(false);
      expect(screen.getByTestId("video-stage").style.getPropertyValue("--player-lift")).toBe("84px");
    } finally { restore(); }
  });

  it("in the ordinary window: nothing floats over the picture, so nothing is lifted and the page's top is not cleared", async () => {
    const restore = withHeights({ "video-controls": 84 });
    try {
      await ready(windowFull(false));
      expect(screen.getByTestId("video-reader").getAttribute("data-window-full")).toBeNull();
      expect(screen.getByTestId("video-stage").style.getPropertyValue("--player-lift")).toBe("0px");
    } finally { restore(); }
  });

  it("keeps the bar at the end of the video even after it had faded while playing", async () => {
    const restore = withHeights({ "video-controls": 84 });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await ready(windowFull(true));
      await act(async () => { await element().play(); });
      act(() => { vi.advanceTimersByTime(3000); });
      await waitFor(() => expect(screen.getByTestId("video-shell").hasAttribute("data-idle")).toBe(true));
      // While the bar is hidden nothing is lifted; at the end it is shown, and the prompt is lifted above it.
      expect(screen.getByTestId("video-stage").style.getPropertyValue("--player-lift")).toBe("0px");
      act(() => media.finish(element()));
      await waitFor(() => expect(screen.getByTestId("video-shell").hasAttribute("data-idle")).toBe(false));
      expect(screen.getByTestId("video-end")).toBeTruthy();
      expect(screen.getByTestId("video-stage").style.getPropertyValue("--player-lift")).toBe("84px");
    } finally { restore(); }
  });
});
