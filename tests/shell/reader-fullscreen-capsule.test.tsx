/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { resolveKeys } from "@manga/contracts/keys";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { EdgeHandle } from "../../apps/desktop/src/renderer/components/capture/edge-handle.tsx";
import { QuickNoteModal } from "../../apps/desktop/src/renderer/components/capture/quick-note-modal.tsx";
import { captureBridge, quickNoteSession } from "../../apps/desktop/src/renderer/lib/capture-bridge.ts";
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
  captureBridge.reset();
  quickNoteSession.reset();
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
  captureBridge.reset();
  quickNoteSession.reset();
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
    pauseOnQuickNote: false,
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

    // Top header-docked capsule is completely removed; replaced by unified right-edge magnetic handle and centered quick-note modal.
    expect(workspaceCss).not.toMatch(/\.chat-capsule\b/);
    expect(frameCss).not.toMatch(/--capsule-room|--capsule-bar-w|\.chat-capsule/);
    expect(workspaceCss).toMatch(/\.edge-handle-zone \{[^}]*top: 25%; height: 50%; width: 12px;/);
    expect(workspaceCss).toMatch(/\.quick-note-modal \{[^}]*position: fixed;/);
    expect(frameCss).toMatch(/--dv-tabs-and-actions-container-height:\s*var\(--column-top-h\)/);
    expect(frameCss).toMatch(/\.shell-main \{ --main-top-end: var\(--title-end-w, 0px\); \}/);
    expect(frameCss).toMatch(/\.dv-tabs-and-actions-container:has\(\.tab-actions\[data-top-right="true"\]\) \{ padding-right: var\(--main-top-end\); \}/);
    expect(frameCss).toMatch(/> \.column-switcher \{ padding-right: calc\(8px \+ var\(--main-top-end\)\); \}/);
  });

  it("renders EdgeHandle only when actions exist, expands on click/focus, opens QuickNoteModal cleanly, and hides note when not noteable", async () => {
    const idleMic = {
      state: { phase: "idle" as const, elapsedMs: 0, level: 0 },
      enabled: true,
      toggleKey: "F8",
      onToggle: vi.fn(),
      onStop: vi.fn(),
    };
    const notes: string[] = [];
    const Harness = (props: { mode: "empty" | "full" | "mic-only"; open?: boolean; onOpen?: () => void; onClose?: () => void }) => (
      <main data-testid="capsule-host">
        {props.mode === "full" ? (
          <EdgeHandle
            t={i18n.t}
            mic={idleMic}
            noteable={true}
            quickNoteKey="N"
            onOpenQuickNote={props.onOpen}
          />
        ) : props.mode === "mic-only" ? (
          <EdgeHandle t={i18n.t} mic={idleMic} noteable={false} />
        ) : (
          <EdgeHandle t={i18n.t} mic={null} noteable={false} />
        )}
        <QuickNoteModal
          t={i18n.t}
          open={Boolean(props.open)}
          openNonce={1}
          targetKey="t1"
          initialItems={[{ id: "pos:1", kind: "position", label: "第 1 页" }]}
          initialDraft=""
          onDraftChange={() => undefined}
          onSave={async (text) => { notes.push(text); return true; }}
          onClose={() => props.onClose?.()}
        />
      </main>
    );

    let modalOpen = false;
    const view = render(<Harness mode="empty" open={false} />);
    expect(screen.queryByTestId("edge-handle-zone")).toBeNull();

    const rerenderFull = () => view.rerender(
      <Harness
        mode="full"
        open={modalOpen}
        onOpen={() => { modalOpen = true; rerenderFull(); }}
        onClose={() => { modalOpen = false; rerenderFull(); }}
      />,
    );
    rerenderFull();
    expect(screen.getByTestId("edge-handle").getAttribute("data-expanded")).toBe("false");
    fireEvent.click(screen.getByTestId("edge-handle-hotzone"));
    expect(screen.getByTestId("edge-handle").getAttribute("data-expanded")).toBe("true");
    fireEvent.click(screen.getByTestId("edge-note"));
    expect(screen.getByTestId("quick-note-modal")).toBeTruthy();
    expect(screen.getByTestId("quick-note-tag-position").textContent).toContain("第 1 页");

    fireEvent.change(screen.getByTestId("quick-note-input"), { target: { value: "不挡画面的速记" } });
    fireEvent.click(screen.getByTestId("quick-note-send"));
    await waitFor(() => expect(notes).toEqual(["不挡画面的速记"]));
    await waitFor(() => expect(screen.queryByTestId("quick-note-modal")).toBeNull());

    view.rerender(<Harness mode="mic-only" open={false} />);
    expect(screen.getByTestId("edge-handle-zone")).toBeTruthy();
    expect(screen.queryByTestId("edge-note")).toBeNull();
  });

  it("mounts EdgeHandle when right dock is folded, in window fullscreen (W), and portaled into screen fullscreen (F), hiding it when docked", async () => {
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
    expect(screen.queryByTestId("edge-handle-zone")).toBeNull();

    // Fold the right dock: EdgeHandle mounts on the right edge of shell-main.
    fireEvent.click(screen.getByTestId("shell-dock-toggle"));
    const handle = await screen.findByTestId("edge-handle-zone");
    expect(shellMain.contains(handle)).toBe(true);
    expect(screen.getByTestId("edge-note")).toBeTruthy();
    expect(screen.getByTestId("edge-screenshot")).toBeTruthy();
    expect(screen.getByTestId("edge-dock")).toBeTruthy();

    // Entering window fullscreen (W) keeps EdgeHandle active with temporary dock drawer support.
    fireEvent.click(screen.getByTestId("video-window-fullscreen"));
    expect(screen.getByTestId("edge-handle-zone")).toBeTruthy();
    expect(screen.getByTestId("edge-dock")).toBeTruthy();

    // Entering screen fullscreen (F) portals EdgeHandle directly into document.fullscreenElement and omits dock drawer button.
    const videoShell = screen.getByTestId("video-shell");
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => videoShell });
    act(() => { document.dispatchEvent(new Event("fullscreenchange")); });
    await waitFor(() => expect(videoShell.contains(screen.getByTestId("edge-handle-zone"))).toBe(true));
    expect(screen.queryByTestId("edge-dock")).toBeNull();
    expect(screen.getByTestId("edge-note")).toBeTruthy();
    expect(screen.getByTestId("edge-screenshot")).toBeTruthy();

    // Leaving screen fullscreen and window fullscreen returns to folded dock state with EdgeHandle back in shell-main.
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => null });
    act(() => { document.dispatchEvent(new Event("fullscreenchange")); });
    fireEvent.click(screen.getByTestId("immersive-exit"));
    await waitFor(() => expect(shellMain.contains(screen.getByTestId("edge-handle-zone"))).toBe(true));
  });
});
