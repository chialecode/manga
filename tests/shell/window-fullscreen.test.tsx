/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { ComicReader, type ComicDoc, type ComicSettings } from "../../apps/desktop/src/renderer/readers/comic-reader.tsx";
import { ReadingPane, type ReadingDocument } from "../../apps/desktop/src/renderer/reading.tsx";
import { WindowFullscreenProvider, ESC_AFTER_SCREEN_EXIT_MS } from "../../apps/desktop/src/renderer/readers/window-fullscreen.tsx";
import { readingLabels } from "../../apps/desktop/src/renderer/lib/labels.ts";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { resetVideoSupport } from "../../apps/desktop/src/renderer/readers/video-support.ts";
import { createTranslator } from "@manga/i18n";
import { installMatchMedia, installMediaElement, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";
import { installHost } from "../helpers/app-host.ts";
import { openShelf, openWorkPage, showTab } from "../helpers/workspace-ui.ts";

Element.prototype.scrollIntoView = () => {};

const i18n = createTranslator("zh-CN");
let media: ReturnType<typeof installMediaElement>;
const element = () => screen.getByTestId("video-element") as HTMLVideoElement;
const root = () => screen.getByTestId("shell-root");

async function openVideo() {
  render(<App />);
  await openShelf("video");
  await openWorkPage("open-res_v1");
  fireEvent.click(screen.getByTestId("work-read"));
  await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
  act(() => media.loaded(element(), 120));
  await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"));
}

/** What the browser reports while an element is in screen full screen. */
function screenFullscreen(target: Element | null) {
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => target });
  document.dispatchEvent(new Event("fullscreenchange"));
}

beforeEach(() => {
  window.innerWidth = 1600;
  media = installMediaElement();
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
  media.restore();
  vi.restoreAllMocks();
  vi.useRealTimers();
  removeMatchMedia();
  quoteTags.reset();
  readerContext.reset();
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
});

describe("AT-89 window full screen: the reader fills the application window", () => {
  it("hides the columns and the tops' room, keeps the same player playing in place, and brings everything back", async () => {
    installHost();
    await openVideo();
    const player = element();
    act(() => media.advance(player, 42));
    expect(root().getAttribute("data-immersive")).toBe("false");
    expect(screen.getByTestId("shell-sidebar")).toBeTruthy();

    fireEvent.click(screen.getByTestId("video-window-fullscreen"));
    expect(root().getAttribute("data-immersive")).toBe("true");
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
    expect(screen.queryByTestId("shell-rail")).toBeNull();
    expect(screen.queryByTestId("shell-resize-sidebar")).toBeNull();
    expect(screen.queryByTestId("shell-resize-dock")).toBeNull();
    expect(screen.getByTestId("immersive-hotzone")).toBeTruthy();
    // Nothing was loaded again: the same element at the same place.
    expect(element()).toBe(player);
    expect(media.state(player).time).toBe(42);
    expect(screen.getByTestId("video-window-fullscreen").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("video-shell").getAttribute("data-full")).toBe("true");

    fireEvent.click(screen.getByTestId("video-window-fullscreen"));
    expect(root().getAttribute("data-immersive")).toBe("false");
    expect(screen.getByTestId("shell-sidebar")).toBeTruthy();
    expect(screen.getByTestId("video-shell").getAttribute("data-full")).toBeNull();
    expect(element()).toBe(player);

    // The floating top has no sidebar buttons (there is no sidebar to show), and offers the way out itself.
    fireEvent.click(screen.getByTestId("video-window-fullscreen"));
    expect(screen.queryByTestId("shell-sidebar-toggle")).toBeNull();
    expect(screen.queryByTestId("shell-dock-toggle")).toBeNull();
    expect(screen.getByTestId("shell-top").contains(screen.getByTestId("menubar"))).toBe(true);
    // The tab bar is out of the way too: the reader is the only thing on the window.
    expect(readFileSync("apps/desktop/src/renderer/styles-frame.css", "utf8")).toMatch(/data-immersive="true"\] \.dv-tabs-and-actions-container \{ display: none; \}/);
    fireEvent.click(screen.getByTestId("immersive-exit"));
    expect(root().getAttribute("data-immersive")).toBe("false");
    expect(screen.queryByTestId("immersive-exit")).toBeNull();
    expect(screen.getByTestId("shell-sidebar-toggle")).toBeTruthy();
  });

  it("is toggled by W where a reader is in front, and never by a W typed into a field", async () => {
    installHost();
    await openVideo();
    const composer = screen.getByTestId("agent-composer");
    composer.focus();
    fireEvent.keyDown(composer, { key: "w" });
    expect(root().getAttribute("data-immersive")).toBe("false");
    // Ctrl + W is the key that closes the tab in front, so a modified W that must not toggle is Alt + W.
    fireEvent.keyDown(window, { key: "w", altKey: true });
    expect(root().getAttribute("data-immersive")).toBe("false");
    fireEvent.keyDown(window, { key: "w" });
    expect(root().getAttribute("data-immersive")).toBe("true");
    fireEvent.keyDown(window, { key: "W" });
    expect(root().getAttribute("data-immersive")).toBe("false");
  });

  it("leaves with Esc only after screen full screen, and not with the Esc that left screen full screen", async () => {
    installHost();
    await openVideo();
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    fireEvent.click(screen.getByTestId("video-window-fullscreen"));
    expect(root().getAttribute("data-immersive")).toBe("true");

    // Screen full screen on top of window full screen: Esc belongs to the browser's, the window stays full.
    screenFullscreen(screen.getByTestId("video-shell"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(root().getAttribute("data-immersive")).toBe("true");

    // The browser leaves screen full screen; an Esc arriving at once is that one and is ignored.
    screenFullscreen(null);
    now += ESC_AFTER_SCREEN_EXIT_MS - 100;
    fireEvent.keyDown(window, { key: "Escape" });
    expect(root().getAttribute("data-immersive")).toBe("true");

    // The next Esc leaves window full screen.
    now += ESC_AFTER_SCREEN_EXIT_MS;
    fireEvent.keyDown(window, { key: "Escape" });
    expect(root().getAttribute("data-immersive")).toBe("false");
  });

  it("lets an open menu take the Esc first, and ends when the reader is left", async () => {
    installHost();
    await openVideo();
    fireEvent.click(screen.getByTestId("video-window-fullscreen"));
    // The top floats; one of its menus is open: Esc closes the menu and the window stays full.
    fireEvent.click(screen.getByTestId("menu-view"));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(root().getAttribute("data-immersive")).toBe("true");
    // Settings is not a reader page: the window is ordinary there and stays ordinary on the way back to the reader tab.
    fireEvent.click(screen.getByTestId("menu-help"));
    fireEvent.click(screen.getByRole("menuitem", { name: "日志与资料位置" }));
    await waitFor(() => expect(screen.getByTestId("settings-nav")).toBeTruthy());
    expect(root().getAttribute("data-immersive")).toBe("false");
    await showTab("合成动画");
    await waitFor(() => expect(screen.getByTestId("video-reader")).toBeTruthy());
    expect(root().getAttribute("data-immersive")).toBe("false");
    expect(screen.getByTestId("shell-sidebar")).toBeTruthy();
  });
});

describe("AT-89 the other two readers have the button too", () => {
  const settings: ComicSettings = { direction: "rtl", layout: "single", coverAlone: true, fit: "page", zoom: 1, autoFlipSeconds: 0, animation: "fade" };
  const doc: ComicDoc = {
    resourceId: "res_c", revisionId: "rev_c", title: "合成漫画", direction: null, available: true, warnings: [],
    pages: Array.from({ length: 3 }, (_, index) => ({ id: `page-${index}`, index, name: `${index}.png`, width: 800, height: 1200, spread: false, ok: true })),
  };
  const readingDoc: ReadingDocument = {
    resourceId: "res_1", revisionId: "rev_1", title: "合成书", format: "txt", warnings: [],
    toc: [{ label: "正文", partId: "body" }],
    parts: [{ id: "body", title: "第一章", kind: "text", length: 2000, textLayer: true }],
    slice: { partId: "body", text: "甲乙丙", start: 0, end: 3, kind: "text", textLayer: true, images: [] },
    source: { available: true },
  };

  it("the comic reader and the novel reader show the state in the button, and float their bars when the window is full", () => {
    (window as unknown as { manga: unknown }).manga = { async command() { return { status: "ok", value: { pages: [] } }; } };
    const toggle = vi.fn();
    const comic = (active: boolean) => (
      <WindowFullscreenProvider value={{ active, toggle, exit: () => undefined }}>
        <ComicReader t={i18n.t} doc={doc} settings={settings} onSettings={() => undefined} onBack={() => undefined} onPage={() => undefined} onBackToNote={() => undefined} onRepair={() => undefined} />
      </WindowFullscreenProvider>
    );
    const { rerender } = render(comic(false));
    expect(screen.getByTestId("comic-reader").getAttribute("data-immersive")).toBeNull();
    fireEvent.click(screen.getByTestId("comic-window-fullscreen"));
    expect(toggle).toHaveBeenCalledTimes(1);
    rerender(comic(true));
    expect(screen.getByTestId("comic-reader").getAttribute("data-immersive")).toBe("true");
    expect(screen.getByTestId("comic-window-fullscreen").getAttribute("aria-pressed")).toBe("true");
    cleanup();

    const novel = (active: boolean) => (
      <WindowFullscreenProvider value={{ active, toggle, exit: () => undefined }}>
        <ReadingPane
          document={readingDoc} style={{ measurePx: 680, fontSizePx: 18, fontFamily: "sans", lineHeight: 1.7, marginPx: 24, theme: "white" }} labels={readingLabels(i18n)} t={i18n.t}
          labelsExtra={{ sourceNeedsReview: "", sourceMissing: "", sourceRepair: "" }}
          hits={[]} bookmarks={[]} assets={{}} highlight={null} sourceCard={null}
          onSearch={() => {}} onJump={() => {}} onProgress={() => {}} onNote={() => {}} onMore={() => {}} onPart={() => {}}
          onStyle={() => {}} onBookmark={() => {}} onRemoveBookmark={() => {}} onOpenBookmark={() => {}} onBackToNote={() => {}} onRepair={() => {}}
        />
      </WindowFullscreenProvider>
    );
    const view = render(novel(false));
    expect(screen.getByTestId("reading-page").getAttribute("data-immersive")).toBeNull();
    fireEvent.click(screen.getByTestId("reading-window-fullscreen"));
    expect(toggle).toHaveBeenCalledTimes(2);
    view.rerender(novel(true));
    expect(screen.getByTestId("reading-page").getAttribute("data-immersive")).toBe("true");
  });
});

describe("AT-105 window full screen: the top edge of the window is still a place to take hold of it", () => {
  afterEach(() => { delete (window as unknown as { manga?: unknown }).manga; });
  const css = () => readFileSync("apps/desktop/src/renderer/styles-frame.css", "utf8");

  async function immersive() {
    installHost();
    await openVideo();
    fireEvent.click(screen.getByTestId("video-window-fullscreen"));
    expect(root().getAttribute("data-immersive")).toBe("true");
  }

  it("leaves an invisible drag strip along the top edge, and a hot zone under it that brings the top down", async () => {
    await immersive();
    const strip = screen.getByTestId("immersive-drag");
    const zone = screen.getByTestId("immersive-hotzone");
    expect(strip.classList.contains("shell-drag")).toBe(true);
    expect(zone.classList.contains("shell-no-drag")).toBe(true);
    // The strip is in front of the zone in the page, so a no-drag area never cuts the strip, and neither takes room from the page.
    expect(strip.compareDocumentPosition(zone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(strip.getAttribute("aria-hidden")).toBe("true");
    const sheet = css();
    expect(sheet).toMatch(/\.immersive-drag \{[^}]*position: absolute; top: 0; left: 0; right: 0; height: 8px/);
    expect(sheet).toMatch(/\.immersive-hotzone \{[^}]*position: absolute; top: 8px;[^}]*height: 16px/);
    expect(screen.getByTestId("shell-top").getAttribute("data-revealed")).toBe("false");
    fireEvent.pointerEnter(zone);
    expect(screen.getByTestId("shell-top").getAttribute("data-revealed")).toBe("true");
  });

  it("brings the top down for a pointer that was flicked past the zone onto the strip, which shows as the page being left at the top", async () => {
    await immersive();
    const column = screen.getByTestId("shell-top");
    // Leaving the page lower down (the side or the bottom of the window) is not a reach for the top.
    fireEvent(document.documentElement, new MouseEvent("mouseleave", { clientX: 300, clientY: 400 }));
    expect(column.getAttribute("data-revealed")).toBe("false");
    fireEvent(document.documentElement, new MouseEvent("mouseleave", { clientX: 300, clientY: 3 }));
    expect(column.getAttribute("data-revealed")).toBe("true");
    // The pointer seen below the top again puts it back, as it does for one that came down over the zone.
    fireEvent(window, new MouseEvent("pointermove", { clientX: 300, clientY: 200 }));
    expect(column.getAttribute("data-revealed")).toBe("false");
  });

  it("makes the top that came down a drag area apart from its buttons, and takes the strip and the zone out of its way", async () => {
    await immersive();
    fireEvent.pointerEnter(screen.getByTestId("immersive-hotzone"));
    // Once down, the strip and the zone would sit over the top's buttons, so they stand aside.
    expect(screen.queryByTestId("immersive-drag")).toBeNull();
    expect(screen.queryByTestId("immersive-hotzone")).toBeNull();
    const top = screen.getByTestId("shell-top");
    expect(top.classList.contains("shell-drag")).toBe(true);
    for (const id of ["menubar", "immersive-exit"]) {
      const target = screen.getByTestId(id);
      expect(target.classList.contains("shell-no-drag") || target.closest(".shell-no-drag") !== null, id).toBe(true);
    }
    // The old rule that made the whole floating top a no-drag area is gone.
    expect(css()).not.toMatch(/\.shell-top\[data-immersive="true"\] \{[^}]*app-region: no-drag/);
    expect(css()).toMatch(/\.shell-top\[data-immersive="true"\]\[data-revealed="true"\]/);
  });

  it("puts the strip and the zone back when the pointer is next seen below the top, not before", async () => {
    await immersive();
    fireEvent.pointerEnter(screen.getByTestId("immersive-hotzone"));
    // A pointer over the top sends nothing while it is on a drag area; one still within the top and its margin keeps it down.
    fireEvent(window, new MouseEvent("pointermove", { clientX: 300, clientY: 20 }));
    expect(screen.getByTestId("shell-top").getAttribute("data-revealed")).toBe("true");
    fireEvent(window, new MouseEvent("pointermove", { clientX: 300, clientY: 41 }));
    expect(screen.getByTestId("shell-top").getAttribute("data-revealed")).toBe("true");
    fireEvent(window, new MouseEvent("pointermove", { clientX: 300, clientY: 43 }));
    expect(screen.getByTestId("shell-top").getAttribute("data-revealed")).toBe("false");
    expect(screen.getByTestId("immersive-drag")).toBeTruthy();
    expect(screen.getByTestId("immersive-hotzone")).toBeTruthy();
  });

  it("has neither strip nor zone once the window is ordinary again, and the top does not stay down for the next time", async () => {
    await immersive();
    fireEvent.pointerEnter(screen.getByTestId("immersive-hotzone"));
    fireEvent.click(screen.getByTestId("immersive-exit"));
    expect(root().getAttribute("data-immersive")).toBe("false");
    expect(screen.queryByTestId("immersive-drag")).toBeNull();
    expect(screen.queryByTestId("immersive-hotzone")).toBeNull();
    expect(screen.getByTestId("shell-top").getAttribute("data-revealed")).toBe("false");
    fireEvent.click(screen.getByTestId("video-window-fullscreen"));
    expect(screen.getByTestId("shell-top").getAttribute("data-revealed")).toBe("false");
    expect(screen.getByTestId("immersive-hotzone")).toBeTruthy();
  });

  it("shows the window's own buttons only with the top: they are inside it, and it is off the page until it comes down", async () => {
    let listener: ((state: { controls: boolean; maximized: boolean }) => void) | null = null;
    installHost();
    const host = (window as unknown as { manga: Record<string, unknown> }).manga;
    host.windowState = async () => ({ controls: true, maximized: false });
    host.windowAction = vi.fn(async () => ({ controls: true, maximized: false }));
    host.onWindowState = (next: typeof listener) => { listener = next; return () => undefined; };
    await openVideo();
    await waitFor(() => expect(screen.getByTestId("window-controls")).toBeTruthy());
    fireEvent.click(screen.getByTestId("video-window-fullscreen"));
    const top = screen.getByTestId("shell-top");
    expect(top.contains(screen.getByTestId("window-controls"))).toBe(true);
    const sheet = css();
    // Out of the page above the window's edge until it comes down, with the buttons moving with it.
    expect(sheet).toMatch(/\.shell-top\[data-immersive="true"\] \{[^}]*transform: translateY\(-100%\)/);
    expect(sheet).toMatch(/\.shell-top\[data-immersive="true"\]\[data-revealed="true"\][^{]*\{ transform: none; \}/);
    expect(listener).not.toBeNull();
  });
});
