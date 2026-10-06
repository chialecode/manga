/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { ComicReader, type ComicDoc, type ComicSettings } from "../../apps/desktop/src/renderer/readers/comic-reader.tsx";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { installMatchMedia, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";

const i18n = createTranslator("zh-CN");

const settings: ComicSettings = { direction: "rtl", layout: "single", coverAlone: true, fit: "page", zoom: 1, autoFlipSeconds: 0, animation: "fade" };

function makeDoc(count: number, extra: Partial<ComicDoc> = {}): ComicDoc {
  return {
    resourceId: "res_c", revisionId: "rev_c", title: "合成漫画", direction: null, available: true, warnings: [],
    pages: Array.from({ length: count }, (_, index) => ({ id: `page-${index}`, index, name: `${index}.png`, width: 800, height: 1200, spread: false, ok: true })),
    ...extra,
  };
}

type Call = { commandId: string; input: Record<string, unknown> };

function installHost(options: { missing?: string[] } = {}) {
  const calls: Call[] = [];
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input: Record<string, unknown> }) {
      calls.push({ commandId: payload.commandId, input: payload.input });
      if (payload.commandId === "comic.pageHandles") {
        const ids = payload.input.pageIds as string[];
        return { status: "ok", value: { pages: ids.map((pageId) => options.missing?.includes(pageId)
          ? { pageId, available: false, reason: "合成损坏" }
          : { pageId, available: true, kind: "image", url: `manga-media://h/${pageId}`, handle: pageId, mediaType: "image/png", width: 800, height: 1200, scaled: false }) } };
      }
      return { status: "ok", value: {} };
    },
  };
  return calls;
}

type Props = Partial<Parameters<typeof ComicReader>[0]>;

function mount(doc: ComicDoc, props: Props = {}) {
  const handlers = { onSettings: vi.fn(), onBack: vi.fn(), onNext: vi.fn(), onPage: vi.fn(), onBackToNote: vi.fn(), onRepair: vi.fn() };
  const result = render(<ComicReader t={i18n.t} doc={doc} settings={settings} {...handlers} {...props} />);
  return { ...result, handlers, rerenderWith: (next: Props) => result.rerender(<ComicReader t={i18n.t} doc={doc} settings={settings} {...handlers} {...props} {...next} />) };
}

const shownPages = () => screen.getAllByTestId(/^comic-page-\d+$/).map((node) => node.getAttribute("data-page-id"));

beforeEach(() => { installHost(); installPointerEvent(); quoteTags.reset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); removeMatchMedia(); quoteTags.reset(); });

const openMore = () => fireEvent.click(screen.getByTestId("comic-more-settings"));

describe("M2 comic reader", () => {
  it("shows the book, the position and a way back, and loads the shown page then the ones ahead", async () => {
    const calls = installHost();
    const { handlers } = mount(makeDoc(10));
    expect(screen.getByTestId("comic-title").textContent).toBe("合成漫画");
    expect(screen.getByTestId("comic-position").textContent).toContain("1 / 10");
    expect(screen.getByTestId("comic-reader").getAttribute("data-direction")).toBe("rtl");
    await waitFor(() => expect(screen.getByTestId("comic-page-0").getAttribute("data-state")).toBe("ready"));
    // The shown page is asked for before the prefetch, and only a few pages are prefetched.
    const asked = calls.filter((call) => call.commandId === "comic.pageHandles").map((call) => call.input.pageIds as string[]);
    expect(asked[0]).toEqual(["page-0"]);
    expect(asked.flat().length).toBeLessThanOrEqual(4);
    fireEvent.click(screen.getByTestId("comic-back"));
    expect(handlers.onBack).toHaveBeenCalled();
  });

  it("turns pages with the arrow that points the way the book reads, in both directions", async () => {
    const { rerenderWith } = mount(makeDoc(5));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByTestId("comic-position").textContent).toContain("2 / 5");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByTestId("comic-position").textContent).toContain("1 / 5");
    cleanup();
    mount(makeDoc(5), { settings: { ...settings, direction: "ltr" } });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByTestId("comic-position").textContent).toContain("2 / 5");
    void rerenderWith;
  });

  it("uses the direction the book declares over the saved default", () => {
    mount(makeDoc(3, { direction: "ltr" }));
    expect(screen.getByTestId("comic-reader").getAttribute("data-direction")).toBe("ltr");
  });

  it("starts on the page the host asks for", () => {
    mount(makeDoc(10), { startPageId: "page-6" });
    expect(screen.getByTestId("comic-position").textContent).toContain("7 / 10");
    expect(shownPages()).toEqual(["page-6"]);
  });

  it("jumps with the slider and with a typed page number, and a typed key does not turn the page", () => {
    mount(makeDoc(30));
    fireEvent.change(screen.getByTestId("comic-slider"), { target: { value: "12" } });
    expect(screen.getByTestId("comic-position").textContent).toContain("12 / 30");
    const input = screen.getByTestId("comic-page-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(screen.getByTestId("comic-position").textContent).toContain("12 / 30");
    fireEvent.click(screen.getByTestId("comic-page-go"));
    expect(screen.getByTestId("comic-position").textContent).toContain("25 / 30");
  });

  it("goes to the first and the last page with Home and End", () => {
    mount(makeDoc(8), { startPageId: "page-3" });
    fireEvent.keyDown(window, { key: "End" });
    expect(screen.getByTestId("comic-position").textContent).toContain("8 / 8");
    fireEvent.keyDown(window, { key: "Home" });
    expect(screen.getByTestId("comic-position").textContent).toContain("1 / 8");
  });

  it("pairs the pages in a double layout, with the cover alone, and puts the first page of a pair on the right when reading right to left", () => {
    mount(makeDoc(6), { settings: { ...settings, layout: "double" } });
    expect(shownPages()).toEqual(["page-0"]);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByTestId("comic-position").textContent).toContain("2–3 / 6");
    // Right to left: page 3 is on the left of page 2 on screen, so it comes first in the DOM.
    expect(shownPages()).toEqual(["page-2", "page-1"]);
    cleanup();
    mount(makeDoc(6), { settings: { ...settings, layout: "double", direction: "ltr" }, startPageId: "page-1" });
    expect(shownPages()).toEqual(["page-1", "page-2"]);
  });

  it("only changes the cover rule in a double layout", () => {
    const { handlers } = mount(makeDoc(6), { settings: { ...settings, layout: "double" } });
    fireEvent.click(screen.getByTestId("comic-more-settings"));
    fireEvent.click(screen.getByTestId("comic-cover-alone"));
    expect(handlers.onSettings).toHaveBeenCalledWith({ coverAlone: false });
    cleanup();
    mount(makeDoc(6));
    fireEvent.click(screen.getByTestId("comic-more-settings"));
    expect((screen.getByTestId("comic-cover-alone") as HTMLInputElement).disabled).toBe(true);
  });

  it("sends layout, fit, zoom and direction changes to the host and flips the direction at once", () => {
    const { handlers } = mount(makeDoc(4));
    // Fit and zoom are in the footer; layout and direction moved into the "…" panel (A-47).
    openMore();
    fireEvent.click(screen.getByTestId("comic-layout-double"));
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ layout: "double" });
    fireEvent.click(screen.getByTestId("comic-layout-strip"));
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ layout: "strip" });
    fireEvent.change(screen.getByTestId("comic-fit"), { target: { value: "width" } });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ fit: "width" });
    fireEvent.click(screen.getByTestId("comic-zoom-in"));
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ zoom: 1.25 });
    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ zoom: 0.75 });
    fireEvent.click(screen.getByTestId("comic-direction"));
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ direction: "ltr" });
    expect(screen.getByTestId("comic-reader").getAttribute("data-direction")).toBe("ltr");
  });

  it("holds the zoom inside its range", () => {
    mount(makeDoc(2), { settings: { ...settings, zoom: 4 } });
    expect((screen.getByTestId("comic-zoom-in") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    mount(makeDoc(2), { settings: { ...settings, zoom: 0.25 } });
    expect((screen.getByTestId("comic-zoom-out") as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports the pages on screen only after the reader has stayed, and only the last page of a quick flip", async () => {
    const { handlers } = mount(makeDoc(10));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(handlers.onPage).not.toHaveBeenCalled();
    await waitFor(() => expect(handlers.onPage).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(handlers.onPage).toHaveBeenCalledWith(["page-3"]);
  });

  it("keeps the place, without counting the pages as read, when the reader closes before the pages have counted", () => {
    const { handlers, unmount } = mount(makeDoc(10));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(handlers.onPage).not.toHaveBeenCalled();
    unmount();
    expect(handlers.onPage).toHaveBeenCalledTimes(1);
    expect(handlers.onPage).toHaveBeenCalledWith(["page-2"], false, { resourceId: expect.any(String), revisionId: expect.any(String) });
  });

  it("does not repeat a place that was already recorded when the reader closes", async () => {
    const { handlers, unmount } = mount(makeDoc(10));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(handlers.onPage).toHaveBeenCalledTimes(1), { timeout: 2000 });
    unmount();
    expect(handlers.onPage).toHaveBeenCalledTimes(1);
  });

  it("shows the end of the book, offers the next chapter, and goes there on the next key", () => {
    const { handlers } = mount(makeDoc(2), { next: { resourceId: "res_next", title: "第 2 话" } });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByTestId("comic-end")).toBeTruthy();
    expect(screen.getByTestId("comic-end-next").textContent).toContain("第 2 话");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("comic-end-next"));
    expect(handlers.onNext).toHaveBeenCalledTimes(2);
  });

  it("says the book ended when there is no next chapter, and a key back leaves the end card", () => {
    mount(makeDoc(2));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByTestId("comic-end")).toBeTruthy();
    expect(screen.queryByTestId("comic-end-next")).toBeNull();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.queryByTestId("comic-end")).toBeNull();
  });

  it("shows a placeholder with the reason for a page that cannot be read, and retries it on request", async () => {
    const calls = installHost({ missing: ["page-0"] });
    mount(makeDoc(3));
    await waitFor(() => expect(screen.getByTestId("comic-page-missing-0")).toBeTruthy());
    expect(screen.getByTestId("comic-page-missing-0").textContent).toContain("合成损坏");
    const before = calls.filter((call) => call.commandId === "comic.pageHandles").length;
    fireEvent.click(screen.getByTestId("comic-page-retry-0"));
    await waitFor(() => expect(calls.filter((call) => call.commandId === "comic.pageHandles").length).toBeGreaterThan(before));
  });

  it("marks a page the file could not decode, and warns once for the whole book", () => {
    const doc = makeDoc(3);
    doc.pages[1] = { ...doc.pages[1]!, ok: false, error: "页面损坏" };
    mount(doc, { startPageId: "page-1" });
    expect(screen.getByTestId("comic-warning").textContent).toContain("1");
    expect(screen.getByTestId("comic-page-missing-1").textContent).toContain("页面损坏");
    // A page that never decoded has nothing to retry.
    expect(screen.queryByTestId("comic-page-retry-1")).toBeNull();
  });

  it("says when the original file is gone and lets the user point at it again", () => {
    const { handlers } = mount(makeDoc(2, { available: false }));
    expect(screen.getByTestId("comic-original-missing")).toBeTruthy();
    fireEvent.click(screen.getByTestId("comic-original-repair"));
    expect(handlers.onRepair).toHaveBeenCalled();
  });

  it("says so when a book has no pages", () => {
    mount(makeDoc(0));
    expect(screen.getByTestId("comic-empty")).toBeTruthy();
    expect((screen.getByTestId("comic-slider") as HTMLInputElement).disabled).toBe(true);
  });

  it("opens at a note's source, draws the region it framed, and removes it when the reader turns away", () => {
    const { handlers } = mount(makeDoc(6), { focus: { pageId: "page-4", region: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, nonce: 1 }, startPageId: "page-4", sourceCard: { status: "resolved", title: "合成漫画" } });
    expect(screen.getByTestId("comic-position").textContent).toContain("5 / 6");
    const mark = screen.getByTestId("comic-source-highlight");
    expect(mark.getAttribute("style")).toContain("left: 10%");
    expect(mark.getAttribute("style")).toContain("height: 40%");
    expect(screen.getByTestId("comic-source-status").textContent).toBeTruthy();
    fireEvent.click(screen.getByTestId("comic-source-back"));
    expect(handlers.onBackToNote).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.queryByTestId("comic-source-highlight")).toBeNull();
  });

  it("goes to a source page without a region and shows no frame", () => {
    mount(makeDoc(6), { focus: { pageId: "page-3", nonce: 1 } });
    expect(screen.getByTestId("comic-position").textContent).toContain("4 / 6");
    expect(screen.queryByTestId("comic-source-highlight")).toBeNull();
  });

  it("does not take over keys while a dialog is open", () => {
    mount(makeDoc(5));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByTestId("comic-position").textContent).toContain("1 / 5");
    dialog.remove();
  });

  it("drops the page animation when the system asks for reduced motion", () => {
    installMatchMedia({ reducedMotion: true });
    mount(makeDoc(3), { settings: { ...settings, animation: "slide" } });
    expect(screen.getByTestId("comic-spread").getAttribute("data-anim")).toBe("none");
    cleanup();
    installMatchMedia({ reducedMotion: false });
    mount(makeDoc(3), { settings: { ...settings, animation: "slide" } });
    expect(screen.getByTestId("comic-spread").getAttribute("data-anim")).toBe("slide");
  });

  it("turns pages by itself on a timer, stops at the end, and pauses while a region is being chosen", () => {
    vi.useFakeTimers();
    mount(makeDoc(3), { settings: { ...settings, autoFlipSeconds: 2 } });
    openMore();
    fireEvent.click(screen.getByTestId("comic-autoflip"));
    act(() => { vi.advanceTimersByTime(2100); });
    expect(screen.getByTestId("comic-position").textContent).toContain("2 / 3");
    fireEvent.click(screen.getByTestId("comic-region-tool"));
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByTestId("comic-position").textContent).toContain("2 / 3");
    fireEvent.click(screen.getByTestId("comic-region-tool"));
    act(() => { vi.advanceTimersByTime(2100); });
    expect(screen.getByTestId("comic-position").textContent).toContain("3 / 3");
    act(() => { vi.advanceTimersByTime(2100); });
    expect(screen.getByTestId("comic-end")).toBeTruthy();
    expect(screen.getByTestId("comic-autoflip").getAttribute("aria-pressed")).toBe("false");
  });
});

describe("M2 comic strip layout", () => {
  it("renders only the pages near the view of a long strip and follows the scroll", () => {
    mount(makeDoc(300), { settings: { ...settings, layout: "strip" } });
    const strip = screen.getByTestId("comic-strip");
    expect(within(strip).getAllByTestId(/^comic-page-\d+$/).length).toBeLessThan(12);
    const stage = screen.getByTestId("comic-stage");
    // 800 px wide pages are 1200 tall at 800; the fallback viewport makes the strip 960 wide at most, so use the real heights.
    const slot = strip.firstElementChild as HTMLElement;
    const pageHeight = parseFloat(slot.style.height);
    expect(pageHeight).toBeGreaterThan(0);
    stage.scrollTop = (pageHeight + 8) * 100 + 4;
    fireEvent.scroll(stage);
    expect(screen.getByTestId("comic-position").textContent).toContain("101 / 300");
    expect(screen.queryByTestId("comic-page-0")).toBeNull();
    expect(screen.getByTestId("comic-page-100")).toBeTruthy();
  });

  it("leaves the arrow keys to the browser's scrolling in a strip", () => {
    mount(makeDoc(10), { settings: { ...settings, layout: "strip" } });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "PageDown" });
    expect(screen.getByTestId("comic-position").textContent).toContain("1 / 10");
  });
});

describe("M2 comic region note", () => {
  function selectLayerBox(width: number, height: number) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid?.startsWith("comic-select-layer") ? ({ left: 100, top: 50, width, height, right: 100 + width, bottom: 50 + height, x: 100, y: 50, toJSON: () => ({}) } as DOMRect) : ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    });
  }

  it("turns a drag on the page into a quote tag for that region, with the page it is on, and leaves the frame drawn until the user is done", () => {
    selectLayerBox(400, 600);
    mount(makeDoc(3), { startPageId: "page-1" });
    expect(screen.queryByTestId("comic-select-layer-1")).toBeNull();
    fireEvent.click(screen.getByTestId("comic-region-tool"));
    expect(screen.getByTestId("comic-region-hint")).toBeTruthy();
    const layer = screen.getByTestId("comic-select-layer-1");
    fireEvent.pointerDown(layer, { clientX: 140, clientY: 110, button: 0, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 340, clientY: 410, button: 0, pointerId: 1 });
    expect(screen.getByTestId("comic-region-rect")).toBeTruthy();
    // The reader only reads: there is no note button, the region is a tag for the right pane.
    expect(screen.queryByTestId("comic-region-note")).toBeNull();
    expect(quoteTags.all()).toEqual([expect.objectContaining({ kind: "region", resourceId: "res_c", revisionId: "rev_c", pageId: "page-1", pageNumber: 2, region: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 } })]);
    // Done ends the tool and the frame, and the tag waits for the right pane until it is sent or removed.
    fireEvent.click(screen.getByTestId("comic-region-cancel"));
    expect(screen.queryByTestId("comic-select-layer-1")).toBeNull();
    expect(screen.queryByTestId("comic-region-rect")).toBeNull();
    expect(quoteTags.all()).toHaveLength(1);
  });

  it("ignores a click without a drag, and Escape or the cancel button drops a framed region", () => {
    selectLayerBox(400, 600);
    mount(makeDoc(3));
    fireEvent.click(screen.getByTestId("comic-region-tool"));
    const layer = screen.getByTestId("comic-select-layer-0");
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 151, clientY: 101, button: 0, pointerId: 1 });
    expect(screen.queryByTestId("comic-region-rect")).toBeNull();
    expect(quoteTags.all()).toHaveLength(0);
    fireEvent.pointerDown(layer, { clientX: 150, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 300, clientY: 300, button: 0, pointerId: 1 });
    expect(screen.getByTestId("comic-region-rect")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("comic-region-rect")).toBeNull();
    expect(screen.queryByTestId("comic-select-layer-0")).toBeNull();
  });

  it("does not turn the page by a tap on the stage while choosing a region", () => {
    mount(makeDoc(3));
    fireEvent.click(screen.getByTestId("comic-region-tool"));
    fireEvent.click(screen.getByTestId("comic-stage"), { clientX: 5, clientY: 5 });
    expect(screen.getByTestId("comic-position").textContent).toContain("1 / 3");
  });
});

describe("M2 comic page size follows the frame, not its own content (A-47 W1, AT-68 model)", () => {
  // jsdom has no layout: the frame's measured size is set here, and a resize is a call to the observer the reader registered.
  const frameSize = { width: 1016, height: 716 };
  // The room a classic scrollbar takes from the stage (kept whether or not one is shown): the stage's offset width less its client width.
  const gutter = { px: 0 };
  let resize: (() => void) | null = null;
  let observed = 0;

  beforeEach(() => {
    frameSize.width = 1016; frameSize.height = 716; gutter.px = 0; resize = null; observed = 0;
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.dataset.testid === "comic-frame" ? frameSize.width : this.dataset.testid === "comic-stage" ? frameSize.width - gutter.px : 0; } });
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get(this: HTMLElement) { return this.dataset.testid === "comic-stage" ? frameSize.width : 0; } });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get(this: HTMLElement) { return this.dataset.testid === "comic-frame" ? frameSize.height : 0; } });
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() { observed += 1; } disconnect() { /* nothing */ } });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
    Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
    vi.unstubAllGlobals();
  });

  const boxOf = (testId: string) => {
    const node = screen.getByTestId(testId);
    return { width: parseFloat(node.style.width), height: parseFloat(node.style.height) };
  };

  it("makes the page size the fit base times the zoom, for every fit and every zoom, within a pixel", () => {
    // The stage is 1000 x 700 once its padding is taken off; an 800 x 1200 page.
    const base = { page: 700 / 1200, width: 1000 / 800, height: 700 / 1200 };
    for (const fit of ["page", "width", "height"] as const) {
      for (const zoom of [0.25, 0.5, 0.75, 1, 1.25, 2, 4]) {
        cleanup();
        mount(makeDoc(3), { settings: { ...settings, fit, zoom } });
        const box = boxOf("comic-page-0");
        expect(Math.abs(box.height - 1200 * base[fit] * zoom)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.width - 800 * base[fit] * zoom)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("shows the whole page when it fits the whole page, and only then adds scrolling by zooming in", () => {
    mount(makeDoc(3));
    const fitted = boxOf("comic-page-0");
    expect(fitted.height).toBeLessThanOrEqual(700);
    expect(fitted.width).toBeLessThanOrEqual(1000);
    cleanup();
    mount(makeDoc(3), { settings: { ...settings, zoom: 2 } });
    expect(boxOf("comic-page-0").height).toBeGreaterThan(700);
    cleanup();
    mount(makeDoc(3), { settings: { ...settings, zoom: 0.5 } });
    expect(boxOf("comic-page-0").height).toBeLessThan(700);
  });

  it("does not move the frame it measures when the zoom changes, so the next page is fitted to the same stage", () => {
    const { rerenderWith } = mount(makeDoc(3));
    const before = boxOf("comic-page-0");
    rerenderWith({ settings: { ...settings, zoom: 2 } });
    expect(observed).toBe(1);
    const zoomed = boxOf("comic-page-0");
    expect(Math.abs(zoomed.height - before.height * 2)).toBeLessThanOrEqual(1);
    rerenderWith({ settings: { ...settings, zoom: 1 } });
    expect(boxOf("comic-page-0")).toEqual(before);
    // Turning the page at a high zoom is still fitted to the stage, not to the zoomed page.
    rerenderWith({ settings: { ...settings, zoom: 4 } });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(Math.abs(boxOf("comic-page-1").height - before.height * 4)).toBeLessThanOrEqual(1);
  });

  it("follows the window and the side pane: a smaller or larger frame refits the page without a change of settings", () => {
    mount(makeDoc(3));
    const wide = boxOf("comic-page-0");
    frameSize.width = 516; frameSize.height = 1016;
    act(() => resize?.());
    const narrow = boxOf("comic-page-0");
    // 500 wide, 1000 tall: the width is now the limit, so the page is smaller than before.
    expect(narrow.width).toBeLessThanOrEqual(500);
    expect(narrow.height).toBeGreaterThan(wide.height);
    frameSize.width = 1016; frameSize.height = 716;
    act(() => resize?.());
    expect(boxOf("comic-page-0")).toEqual(wide);
  });

  it("fits a page to the width the stage has left once its scrollbar's room is taken, so a tall page never scrolls the stage sideways", () => {
    gutter.px = 16;
    mount(makeDoc(3), { settings: { ...settings, fit: "width", zoom: 1 } });
    // 1016 frame, 16 of padding, 16 of scrollbar: 984 wide.
    expect(Math.abs(boxOf("comic-page-0").width - 984)).toBeLessThanOrEqual(1);
    cleanup();
    gutter.px = 0;
    mount(makeDoc(3), { settings: { ...settings, fit: "width", zoom: 1 } });
    expect(Math.abs(boxOf("comic-page-0").width - 1000)).toBeLessThanOrEqual(1);
  });

  it("falls back to a plain window before the frame has a size, and never produces an empty page", () => {
    frameSize.width = 0; frameSize.height = 0;
    mount(makeDoc(2));
    const box = boxOf("comic-page-0");
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });

  it("sets a strip width from the stage and the zoom alone", () => {
    mount(makeDoc(5), { settings: { ...settings, layout: "strip", fit: "page", zoom: 0.5 } });
    const half = parseFloat(screen.getByTestId("comic-strip").style.width);
    cleanup();
    mount(makeDoc(5), { settings: { ...settings, layout: "strip", fit: "page", zoom: 1 } });
    const full = parseFloat(screen.getByTestId("comic-strip").style.width);
    expect(full).toBe(960);
    expect(half).toBe(480);
  });
});
