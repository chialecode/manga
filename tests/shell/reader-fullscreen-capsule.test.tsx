/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { resolveKeys } from "@manga/contracts/keys";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { Capsule } from "../../apps/desktop/src/renderer/components/chat/capsule.tsx";
import { AUTO_HIDE_MS } from "../../apps/desktop/src/renderer/reader/use-auto-hide.ts";
import { ComicReader, type ComicDoc, type ComicSettings } from "../../apps/desktop/src/renderer/readers/comic-reader.tsx";
import { VideoPlayer, type VideoDoc, type VideoSettings } from "../../apps/desktop/src/renderer/readers/video-player.tsx";
import { WindowFullscreenProvider } from "../../apps/desktop/src/renderer/readers/window-fullscreen.tsx";
import { resetVideoSupport } from "../../apps/desktop/src/renderer/readers/video-support.ts";
import { ReadingPane, type ReadingDocument } from "../../apps/desktop/src/renderer/reading.tsx";
import { KeyTableProvider } from "../../apps/desktop/src/renderer/lib/key-table.tsx";
import { readingLabels } from "../../apps/desktop/src/renderer/lib/labels.ts";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { installMatchMedia, installMediaElement, installPicture, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";
import { installHost } from "../helpers/app-host.ts";
import { openShelf, openWorkPage } from "../helpers/workspace-ui.ts";

Element.prototype.scrollIntoView = () => {};

const i18n = createTranslator("zh-CN");
const readCss = (name: string) => readFileSync(join(process.cwd(), "apps/desktop/src/renderer", name), "utf8").replace(/\r\n/g, "\n");

let media: ReturnType<typeof installMediaElement>;
let picture: ReturnType<typeof installPicture>;

beforeEach(() => {
  window.innerWidth = 1280;
  window.innerHeight = 840;
  media = installMediaElement();
  picture = installPicture({ frame: { w: 1280, h: 720 }, video: { w: 1920, h: 1080 } });
  installPointerEvent();
  installMatchMedia({ reducedMotion: true });
  resetVideoSupport();
  resetCovers();
  shelfMemory.reset();
  quoteTags.reset();
  readerContext.reset();
  try { window.localStorage.clear(); } catch { /* none */ }
});

afterEach(() => {
  cleanup();
  picture.restore();
  media.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
  removeMatchMedia();
  quoteTags.reset();
  readerContext.reset();
  delete (window as unknown as Record<string, unknown>).manga;
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
});

describe("window-fullscreen bottom function bar: mouse/drag reveal and hidden non-clickability", () => {
  const comicSettings: ComicSettings = {
    direction: "rtl",
    layout: "single",
    coverAlone: true,
    fit: "page",
    zoom: 1,
    autoFlipSeconds: 0,
    animation: "fade",
  };
  const comicDoc: ComicDoc = {
    resourceId: "res_c",
    revisionId: "rev_c",
    title: "合成漫画",
    direction: null,
    available: true,
    warnings: [],
    pages: Array.from({ length: 4 }, (_, index) => ({
      id: `page-${index}`,
      index,
      name: `${index}.png`,
      width: 800,
      height: 1200,
      spread: false,
      ok: true,
    })),
  };

  const novelDoc: ReadingDocument = {
    resourceId: "res_n",
    revisionId: "rev_n",
    title: "合成小说",
    format: "txt",
    warnings: [],
    toc: [{ label: "第一章", partId: "p1" }, { label: "第二章", partId: "p2" }],
    parts: [
      { id: "p1", title: "第一章", kind: "text", length: 500, textLayer: true },
      { id: "p2", title: "第二章", kind: "text", length: 500, textLayer: true },
    ],
    slice: { partId: "p1", text: "甲乙丙丁戊己庚辛壬癸".repeat(20), start: 0, end: 200, kind: "text", textLayer: true, images: [] },
    source: { available: true },
  };

  const videoSettings: VideoSettings = {
    rate: 1,
    rates: [0.5, 1, 2],
    customRate: 1.5,
    holdRate: 2,
    volume: 0.5,
    muted: false,
    seekStepSeconds: 5,
    autoNext: false,
    subtitlePlacement: "auto",
    subtitleSizePct: 5,
    subtitleFont: "sans",
    subtitleOutline: true,
    assStyle: "keep",
    shotSubtitles: true,
  };
  const videoDoc: VideoDoc = {
    resourceId: "res_v",
    revisionId: "rev_v",
    title: "合成动画",
    episodeLabel: "第 1 话",
    durationMs: 120_000,
    available: true,
    audio: [],
    episodes: [],
  };

  it("enforces pointer-events: none !important on hidden bottom bars and all descendants across reader stylesheets", () => {
    const readerCss = readCss("styles-reader.css");
    const videoCss = readCss("styles-video.css");

    expect(readerCss).toMatch(/\.reader-novel\[data-controls="hidden"\] \.reader-foot \* \{ pointer-events: none !important; \}/);
    expect(readerCss).toMatch(/\.reader\[data-immersive\]\[data-controls="hidden"\] \.comic-footer \{ opacity: 0; pointer-events: none; \}/);
    expect(readerCss).toMatch(/\.reader\[data-immersive\]\[data-controls="hidden"\] \.comic-footer \* \{ pointer-events: none !important; \}/);
    expect(readerCss).not.toMatch(/\.reader\[data-immersive\] \.comic-footer:hover/);

    // Seek jump markers set pointer-events: auto, so the idle descendant rule must override them with !important.
    expect(videoCss).toMatch(/\.video-shell\[data-idle\] \.video-controls \{ opacity: 0; pointer-events: none; \}/);
    expect(videoCss).toMatch(/\.video-shell\[data-idle\] \.video-controls \* \{ pointer-events: none !important; \}/);
  });

  it("comic reader in window fullscreen: hides after idle, blocks clicks while hidden, and reveals on mouse move or drag anywhere in the window", () => {
    vi.useFakeTimers();
    (window as unknown as { manga: unknown }).manga = { async command() { return { status: "ok", value: { pages: [] } }; } };
    const onSettings = vi.fn();
    const toggleWindowFull = vi.fn();

    render(
      <WindowFullscreenProvider value={{ active: true, toggle: toggleWindowFull, exit: () => undefined }}>
        <ComicReader
          t={i18n.t}
          doc={comicDoc}
          settings={comicSettings}
          onSettings={onSettings}
          onBack={vi.fn()}
          onPage={vi.fn()}
          onBackToNote={vi.fn()}
          onRepair={vi.fn()}
        />
      </WindowFullscreenProvider>,
    );

    const reader = screen.getByTestId("comic-reader");
    expect(reader.getAttribute("data-immersive")).toBe("true");
    expect(reader.getAttribute("data-controls")).toBe("shown");

    act(() => { vi.advanceTimersByTime(AUTO_HIDE_MS + 50); });
    expect(reader.getAttribute("data-controls")).toBe("hidden");

    // Clicking any button in the hidden bottom bar must be completely ignored.
    fireEvent.pointerDown(screen.getByTestId("comic-zoom-in"));
    fireEvent.click(screen.getByTestId("comic-zoom-in"));
    fireEvent.click(screen.getByTestId("comic-window-fullscreen"));
    fireEvent.click(screen.getByTestId("comic-more-settings"));
    fireEvent.click(screen.getByTestId("comic-position"));
    expect(onSettings).not.toHaveBeenCalled();
    expect(toggleWindowFull).not.toHaveBeenCalled();
    expect(screen.queryByTestId("comic-more-panel")).toBeNull();
    expect(screen.queryByTestId("comic-page-input")).toBeNull();

    // Moving the mouse across the interior of the window (even if stage stops propagation) reveals the bar.
    const stage = screen.getByTestId("comic-stage");
    stage.addEventListener("mousemove", (event) => event.stopPropagation(), { once: true });
    fireEvent.mouseMove(stage, { clientX: 640, clientY: 420, buttons: 1 });
    expect(reader.getAttribute("data-controls")).toBe("shown");

    // Once shown, controls respond normally, and an open "more" panel holds the bar open.
    fireEvent.click(screen.getByTestId("comic-zoom-in"));
    expect(onSettings).toHaveBeenCalledWith({ zoom: 1.25 });
    fireEvent.click(screen.getByTestId("comic-more-settings"));
    expect(screen.getByTestId("comic-more-panel")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(AUTO_HIDE_MS * 3); });
    expect(reader.getAttribute("data-controls")).toBe("shown");

    // Closing the panel lets it hide again, and a native dragover across the window wakes it too.
    fireEvent.click(screen.getByTestId("comic-more-settings"));
    act(() => { vi.advanceTimersByTime(AUTO_HIDE_MS + 50); });
    expect(reader.getAttribute("data-controls")).toBe("hidden");
    fireEvent.dragOver(stage, { clientX: 500, clientY: 360 });
    expect(reader.getAttribute("data-controls")).toBe("shown");

    // EditableNumber regression: editing comic-position holds the bar past AUTO_HIDE_MS, and closing via Enter or Escape lets it hide again.
    fireEvent.click(screen.getByTestId("comic-position"));
    const pageInput = screen.getByTestId("comic-page-input") as HTMLInputElement;
    act(() => { vi.advanceTimersByTime(AUTO_HIDE_MS * 2); });
    expect(reader.getAttribute("data-controls")).toBe("shown");
    fireEvent.change(pageInput, { target: { value: "2" } });
    fireEvent.keyDown(pageInput, { key: "Enter" });
    expect(screen.queryByTestId("comic-page-input")).toBeNull();
    act(() => { vi.advanceTimersByTime(AUTO_HIDE_MS + 50); });
    expect(reader.getAttribute("data-controls")).toBe("hidden");

    fireEvent.mouseMove(stage, { clientX: 520, clientY: 360 });
    expect(reader.getAttribute("data-controls")).toBe("shown");
    fireEvent.click(screen.getByTestId("comic-position"));
    const pageInputEsc = screen.getByTestId("comic-page-input");
    act(() => { vi.advanceTimersByTime(AUTO_HIDE_MS * 2); });
    expect(reader.getAttribute("data-controls")).toBe("shown");
    fireEvent.keyDown(pageInputEsc, { key: "Escape" });
    expect(screen.queryByTestId("comic-page-input")).toBeNull();
    act(() => { vi.advanceTimersByTime(AUTO_HIDE_MS + 50); });
    expect(reader.getAttribute("data-controls")).toBe("hidden");
  });

  it("novel reader in window fullscreen: reveals the bottom bar on mouse move/drag in the middle of the window and blocks clicks while hidden", () => {
    vi.useFakeTimers();
    const onProgress = vi.fn();
    const onPart = vi.fn();
    const toggleWindowFull = vi.fn();

    render(
      <WindowFullscreenProvider value={{ active: true, toggle: toggleWindowFull, exit: () => undefined }}>
        <ReadingPane
          document={novelDoc}
          style={{ measurePx: 680, fontSizePx: 18, fontFamily: "sans", lineHeight: 1.7, marginPx: 24, theme: "white", flow: "scroll" }}
          labels={readingLabels(i18n)}
          t={i18n.t}
          labelsExtra={{ sourceNeedsReview: "", sourceMissing: "", sourceRepair: "" }}
          hits={[]}
          bookmarks={[]}
          assets={{}}
          highlight={null}
          sourceCard={null}
          onSearch={() => undefined}
          onJump={() => undefined}
          onProgress={onProgress}
          onSelect={() => undefined}
          onPart={onPart}
          onStyle={() => undefined}
          onBookmark={() => undefined}
          onRemoveBookmark={() => undefined}
          onOpenBookmark={() => undefined}
          onBackToNote={() => undefined}
          onRepair={() => undefined}
        />
      </WindowFullscreenProvider>,
    );

    const page = screen.getByTestId("reading-page");
    page.getBoundingClientRect = () => ({ top: 0, bottom: 840, left: 0, right: 1280, width: 1280, height: 840, x: 0, y: 0, toJSON: () => ({}) });
    expect(page.getAttribute("data-immersive")).toBe("true");
    expect(page.getAttribute("data-controls")).toBe("shown");

    act(() => { vi.advanceTimersByTime(AUTO_HIDE_MS + 50); });
    expect(page.getAttribute("data-controls")).toBe("hidden");

    // Hidden controls cannot be clicked.
    fireEvent.pointerDown(screen.getByTestId("reading-progress"));
    fireEvent.click(screen.getByTestId("reading-progress"));
    fireEvent.click(screen.getByTestId("reading-settings"));
    fireEvent.click(screen.getByTestId("reading-window-fullscreen"));
    expect(onProgress).not.toHaveBeenCalled();
    expect(toggleWindowFull).not.toHaveBeenCalled();
    expect(screen.queryByTestId("reading-settings-panel")).toBeNull();

    // Dragging/moving the mouse across the center of the window (clientY = 420, far from top/bottom edges) wakes the bar in window fullscreen.
    fireEvent.mouseMove(screen.getByTestId("reading-scroll"), { clientX: 600, clientY: 420, buttons: 1 });
    expect(page.getAttribute("data-controls")).toBe("shown");

    fireEvent.click(screen.getByTestId("reading-progress"));
    expect(onProgress).toHaveBeenCalledTimes(1);

    // EditableNumber regression: editing reading-part-position holds the bar past AUTO_HIDE_MS, and Enter / Escape unmounts cleanly so it hides again.
    fireEvent.click(screen.getByTestId("reading-part-position"));
    const partInput = screen.getByTestId("reading-part-input") as HTMLInputElement;
    act(() => { vi.advanceTimersByTime(AUTO_HIDE_MS * 2); });
    expect(page.getAttribute("data-controls")).toBe("shown");
    fireEvent.change(partInput, { target: { value: "2" } });
    fireEvent.keyDown(partInput, { key: "Enter" });
    expect(onPart).toHaveBeenCalledWith("p2", 0);
    expect(screen.queryByTestId("reading-part-input")).toBeNull();
    act(() => { vi.advanceTimersByTime(AUTO_HIDE_MS + 50); });
    expect(page.getAttribute("data-controls")).toBe("hidden");

    fireEvent.mouseMove(screen.getByTestId("reading-scroll"), { clientX: 610, clientY: 420 });
    expect(page.getAttribute("data-controls")).toBe("shown");
    fireEvent.click(screen.getByTestId("reading-part-position"));
    const partInputEsc = screen.getByTestId("reading-part-input");
    act(() => { vi.advanceTimersByTime(AUTO_HIDE_MS * 2); });
    expect(page.getAttribute("data-controls")).toBe("shown");
    fireEvent.keyDown(partInputEsc, { key: "Escape" });
    expect(screen.queryByTestId("reading-part-input")).toBeNull();
    act(() => { vi.advanceTimersByTime(AUTO_HIDE_MS + 50); });
    expect(page.getAttribute("data-controls")).toBe("hidden");
  });

  it("video player in window fullscreen: blocks clicks on hidden controls & seek markers, wakes on drag/move, and holds open panels", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    (window as unknown as { manga: unknown }).manga = {
      async command(payload: { commandId: string; input: Record<string, unknown> }) {
        switch (payload.commandId) {
          case "video.playbackPlan":
            return { status: "ok", value: { resourceId: "res_v", revisionId: "rev_v", available: true, plan: { decision: "direct", reasons: [], videoStreamIndex: 0, audioStreamIndex: 1, mediaType: "video/mp4", detail: "synthetic" }, copy: null } };
          case "video.handle":
            return { status: "ok", value: { source: payload.input.source, url: "manga-media://h/original", handle: "h", mediaType: "video/mp4", bytes: 10, startMs: 0 } };
          case "video.subtitles":
            return { status: "ok", value: { subtitles: [] } };
          case "video.fonts":
            return { status: "ok", value: { fonts: [] } };
          default:
            return { status: "ok", value: {} };
        }
      },
      onNotice: () => () => undefined,
    };
    const toggleWindowFull = vi.fn();
    const keys = resolveKeys(undefined);

    render(
      <WindowFullscreenProvider value={{ active: true, toggle: toggleWindowFull, exit: () => undefined }}>
        <KeyTableProvider value={keys}>
          <VideoPlayer
            t={i18n.t}
            doc={videoDoc}
            settings={videoSettings}
            markers={[{ id: "rec-1", startMs: 30_000, endMs: 35_000, label: "笔记锚点" }]}
            onSettings={vi.fn()}
            onBack={vi.fn()}
            onNext={vi.fn()}
            onEpisode={vi.fn()}
            onProgress={vi.fn()}
            onBackToNote={vi.fn()}
            onRepair={vi.fn()}
          />
        </KeyTableProvider>
      </WindowFullscreenProvider>,
    );

    const video = () => screen.getByTestId("video-element") as HTMLVideoElement;
    await waitFor(() => expect(video().getAttribute("src")).toBeTruthy(), { timeout: 20_000 });
    act(() => media.loaded(video(), 120));
    await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"), { timeout: 20_000 });

    const shell = screen.getByTestId("video-shell");
    await act(async () => { await video().play(); });
    act(() => { vi.advanceTimersByTime(3000); });
    await waitFor(() => expect(shell.hasAttribute("data-idle")).toBe(true));

    // Clicking controls or timeline jump markers while idle must be blocked (must not pause, seek, open more, or exit fullscreen).
    const beforeTime = video().currentTime;
    fireEvent.pointerDown(screen.getByTestId("video-toggle"));
    fireEvent.click(screen.getByTestId("video-toggle"));
    fireEvent.click(screen.getByTestId("video-window-fullscreen"));
    fireEvent.click(screen.getByTestId("video-more"));
    fireEvent.click(screen.getByTestId("video-marker-rec-1"));
    expect(video().paused).toBe(false);
    expect(video().currentTime).toBe(beforeTime);
    expect(toggleWindowFull).not.toHaveBeenCalled();
    expect(screen.queryByTestId("video-more-panel")).toBeNull();

    // A-112 in window fullscreen: holding ArrowRight shows only the speed hint while keeping the bottom bar idle/hidden.
    fireEvent.keyDown(window, { key: "ArrowRight" });
    act(() => { vi.advanceTimersByTime(350); });
    expect(screen.getByTestId("video-holding")).toBeTruthy();
    expect(shell.hasAttribute("data-idle")).toBe(true);
    fireEvent.keyUp(window, { key: "ArrowRight" });
    expect(shell.hasAttribute("data-idle")).toBe(true);

    // Dragging/moving the mouse across the stage wakes the bottom bar even if stage stops propagation.
    const stage = screen.getByTestId("video-stage");
    stage.addEventListener("mousemove", (event) => event.stopPropagation(), { once: true });
    fireEvent.mouseMove(stage, { clientX: 500, clientY: 360, buttons: 1 });
    expect(shell.hasAttribute("data-idle")).toBe(false);

    // Opening the "more" panel holds the bar visible past the idle timeout.
    fireEvent.click(screen.getByTestId("video-more"));
    expect(screen.getByTestId("video-more-panel")).toBeTruthy();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(shell.hasAttribute("data-idle")).toBe(false);
  });
});

describe("header-docked capsule: recording & note controls never obstruct the picture or content", () => {
  it("places .chat-capsule in the 36 px tab-strip chrome outside .tab-panel, left of the title bar's end, and reserves horizontal space for both", () => {
    const frameCss = readCss("styles-frame.css");
    const workspaceCss = readCss("styles-workspace.css");

    // Capsule sits at top: 4px; height: 28px (y = 4..32 px inside the 36 px tab-strip header, which is the title bar there), left of the window's buttons,
    // never bottom: 18px or top: 44px over content.
    expect(workspaceCss).toMatch(/\.chat-capsule \{ position: absolute; top: 4px; right: calc\(6px \+ var\(--title-end-w, 0px\)\); left: 6px; bottom: auto;[^}]*flex-direction: column-reverse;[^}]*pointer-events: none; \}/);
    expect(workspaceCss).toMatch(/\.capsule-bar \{[^}]*height: 28px;/);
    expect(frameCss).not.toMatch(/top:\s*44px/);
    expect(frameCss).toMatch(/--dv-tabs-and-actions-container-height:\s*var\(--column-top-h\)/);
    // The strip of the top-right column leaves room for the title bar's end and, when there, the capsule (A-136).
    expect(frameCss).toMatch(/\.shell-main \{ --main-top-end: calc\(var\(--title-end-w, 0px\) \+ var\(--capsule-room, 0px\)\); \}/);
    expect(frameCss).toMatch(/\.shell-main:has\(> \.chat-capsule\) \{ --capsule-room: var\(--capsule-bar-w, 72px\); \}/);
    expect(frameCss).toMatch(/\.dv-tabs-and-actions-container:has\(\.tab-actions\[data-top-right="true"\]\) \{ padding-right: var\(--main-top-end\); \}/);
    expect(frameCss).toMatch(/> \.column-switcher \{ padding-right: calc\(8px \+ var\(--main-top-end\)\); \}/);
  });

  it("reserves --capsule-bar-w on its host, clears top reader strips when opening quick note, closes note box when onNote disappears, and renders nothing when empty", async () => {
    const idleMic = {
      t: i18n.t,
      state: { phase: "idle" as const, elapsedMs: 0 },
      enabled: true,
      toggleKey: "F8",
      onToggle: vi.fn(),
      onHoldStart: vi.fn(),
      onHoldEnd: vi.fn(),
      onStop: vi.fn(),
    };
    const notes: string[] = [];
    const Harness = (props: { mode: "empty" | "full" | "mic-only" }) => (
      <main data-testid="capsule-host">
        <div data-hidden-layer="">
          <p className="reader-notice" data-testid="hidden-notice" />
        </div>
        <div data-visible="false">
          <p className="reader-notice" data-testid="inactive-notice" />
        </div>
        <p className="reader-notice comic-region-bar" data-testid="active-notice" />
        {props.mode === "full" ? (
          <Capsule
            t={i18n.t}
            mic={idleMic as never}
            tagLabel="第 1 页"
            onNote={async (text) => { notes.push(text); return true; }}
          />
        ) : props.mode === "mic-only" ? (
          <Capsule t={i18n.t} mic={idleMic as never} />
        ) : (
          <Capsule t={i18n.t} mic={null} />
        )}
      </main>
    );

    const view = render(<Harness mode="empty" />);
    const host = screen.getByTestId("capsule-host");
    screen.getByTestId("hidden-notice").getBoundingClientRect = () => ({ top: 34, bottom: 260, left: 0, right: 400, width: 400, height: 226, x: 0, y: 34, toJSON: () => ({}) });
    screen.getByTestId("inactive-notice").getBoundingClientRect = () => ({ top: 34, bottom: 220, left: 0, right: 400, width: 400, height: 186, x: 0, y: 34, toJSON: () => ({}) });
    screen.getByTestId("active-notice").getBoundingClientRect = () => ({ top: 40, bottom: 72, left: 0, right: 400, width: 400, height: 32, x: 0, y: 40, toJSON: () => ({}) });

    expect(screen.queryByTestId("chat-capsule")).toBeNull();
    expect(host.style.getPropertyValue("--capsule-bar-w")).toBe("");

    view.rerender(<Harness mode="full" />);
    const bar = host.querySelector(".capsule-bar") as HTMLElement;
    bar.getBoundingClientRect = () => ({ top: 3, bottom: 31, left: 1200, right: 1258, width: 58, height: 28, x: 1200, y: 3, toJSON: () => ({}) });
    expect(host.style.getPropertyValue("--capsule-bar-w")).toBeTruthy();

    // Opening quick note drops below the active comic-region-bar (72 + 4 - 31 = 45 px) and ignores hidden/inactive layers (260 px / 220 px).
    fireEvent.click(screen.getByTestId("capsule-note"));
    const box = screen.getByTestId("capsule-note-box");
    expect(box.style.marginTop).toBe("45px");
    expect(screen.getByTestId("capsule-tag").textContent).toContain("第 1 页");

    // Switching to a non-noteable tab (onNote = undefined while mic stays enabled) immediately closes capsule-note-box and resets open state.
    view.rerender(<Harness mode="mic-only" />);
    expect(screen.getByTestId("chat-capsule")).toBeTruthy();
    expect(screen.queryByTestId("capsule-note")).toBeNull();
    expect(screen.queryByTestId("capsule-note-box")).toBeNull();

    // Returning to a noteable tab brings back capsule-note in its closed state until opened again.
    view.rerender(<Harness mode="full" />);
    const barAgain = host.querySelector(".capsule-bar") as HTMLElement;
    barAgain.getBoundingClientRect = () => ({ top: 3, bottom: 31, left: 1200, right: 1258, width: 58, height: 28, x: 1200, y: 3, toJSON: () => ({}) });
    expect(screen.getByTestId("capsule-note")).toBeTruthy();
    expect(screen.queryByTestId("capsule-note-box")).toBeNull();

    fireEvent.click(screen.getByTestId("capsule-note"));
    fireEvent.change(screen.getByTestId("capsule-note-input"), { target: { value: "不挡画面的速记" } });
    fireEvent.click(screen.getByTestId("capsule-note-send"));
    await waitFor(() => expect(notes).toEqual(["不挡画面的速记"]));
    await waitFor(() => expect(screen.queryByTestId("capsule-note-box")).toBeNull());

    view.unmount();
    expect(host.style.getPropertyValue("--capsule-bar-w")).toBe("");
  });

  it("mounts the capsule in the workspace tab-strip chrome when the right dock is folded over a video reader, and cleans up in window fullscreen", async () => {
    installHost();
    render(<App />);
    await openShelf("video");
    await openWorkPage("open-res_v1");
    fireEvent.click(screen.getByTestId("work-read"));

    const video = () => screen.getByTestId("video-element") as HTMLVideoElement;
    await waitFor(() => expect(video().getAttribute("src")).toBeTruthy());
    act(() => media.loaded(video(), 120));
    await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"));

    const shellMain = screen.getByTestId("shell-main");
    expect(screen.queryByTestId("chat-capsule")).toBeNull();

    // Fold the right dock: capsule appears in shell-main's top-right tab-strip chrome, reserving --capsule-bar-w.
    fireEvent.click(screen.getByTestId("shell-dock-toggle"));
    const capsule = await screen.findByTestId("chat-capsule");
    expect(shellMain.contains(capsule)).toBe(true);
    const panels = shellMain.querySelectorAll('[data-testid="tab-panel"]');
    expect(panels.length).toBeGreaterThan(0);
    for (const panel of panels) expect(panel.contains(capsule)).toBe(false);
    expect(shellMain.style.getPropertyValue("--capsule-bar-w")).toMatch(/^\d+px$/);
    expect(shellMain.querySelector('.tab-actions[data-top-right="true"]')).toBeTruthy();
    expect(screen.getByTestId("capsule-note")).toBeTruthy();

    // Entering window fullscreen hides the capsule and removes --capsule-bar-w; leaving restores both.
    fireEvent.click(screen.getByTestId("video-window-fullscreen"));
    expect(screen.queryByTestId("chat-capsule")).toBeNull();
    expect(shellMain.style.getPropertyValue("--capsule-bar-w")).toBe("");

    fireEvent.click(screen.getByTestId("immersive-exit"));
    expect(await screen.findByTestId("chat-capsule")).toBeTruthy();
    expect(shellMain.style.getPropertyValue("--capsule-bar-w")).toMatch(/^\d+px$/);
  });
});
