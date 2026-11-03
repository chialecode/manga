/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { ReadingPane, type ReadingDocument } from "../../apps/desktop/src/renderer/reading.tsx";
import { readingLabels } from "../../apps/desktop/src/renderer/lib/labels.ts";
import { pageHolds } from "../../apps/desktop/src/renderer/reader/page-offsets.ts";
import { bookPercent, chapterPages, columnCount, pageFrame, screenAt, turn, windowFrom, WINDOW_CHARS } from "../../apps/desktop/src/renderer/reader/pages.ts";

const i18n = createTranslator("zh-CN");

describe("A-115 page arithmetic", () => {
  const style = { measurePx: 680, marginPx: 24 };

  it("makes a page the line width, or narrower in a narrow area, and the book proportion or the area's height", () => {
    const wide = pageFrame({ width: 1600, height: 1200 }, style);
    expect(wide).toMatchObject({ columns: 1, textWidth: 632, gap: 48, margin: 24 });
    expect(wide.height).toBe(Math.round(680 * 4 / 3));
    expect(pageFrame({ width: 1600, height: 500 }, style).height).toBe(500 - 32);
    expect(pageFrame({ width: 1600, height: 1200 }, { ...style, pageRatio: "free" }).height).toBe(1200 - 32);
    const narrow = pageFrame({ width: 400, height: 800 }, style);
    expect(narrow.textWidth).toBe(400 - 48);
    const double = pageFrame({ width: 1000, height: 800 }, { ...style, pageMode: "double" });
    expect(double.columns).toBe(2);
    expect(double.width).toBe(double.textWidth * 2 + double.gap);
    expect(double.width + double.margin * 2).toBeLessThanOrEqual(1000);
  });

  it("counts pages from the strip's width and finds the screen of a point", () => {
    const frame = pageFrame({ width: 1600, height: 1200 }, style);
    const step = frame.textWidth + frame.gap;
    expect(columnCount(0, frame)).toBe(1);
    expect(columnCount(step * 5 - frame.gap, frame)).toBe(5);
    expect(screenAt(0, frame)).toBe(0);
    expect(screenAt(step * 3 + 10, frame)).toBe(3);
    const double = { ...frame, columns: 2 as const };
    expect(screenAt(step * 3 + 10, double)).toBe(1);
  });

  it("estimates the pages of a chapter longer than what is laid out, and says it is about", () => {
    const frame = pageFrame({ width: 1600, height: 1200 }, style);
    expect(chapterPages({ screen: 2, columns: 10, frame, sliceStart: 0, sliceEnd: 5000, partLength: 5000 })).toEqual({ page: 3, total: 10, approx: false });
    const long = chapterPages({ screen: 0, columns: 100, frame, sliceStart: 0, sliceEnd: WINDOW_CHARS, partLength: WINDOW_CHARS * 5 });
    expect(long).toMatchObject({ page: 1, total: 500, approx: true });
    const inside = chapterPages({ screen: 0, columns: 100, frame, sliceStart: 30_000, sliceEnd: 90_000, partLength: 90_000 });
    expect(inside).toMatchObject({ page: 51, approx: true });
  });

  it("turns into the next window, the next chapter's first page and the previous chapter's last page", () => {
    const base = { screen: 0, screens: 3, sliceStart: 0, sliceEnd: 100, partLength: 100, loading: false, previous: { id: "p", length: 500 }, next: { id: "n" } };
    expect(turn(1, base)).toEqual({ kind: "screen", screen: 1 });
    expect(turn(1, { ...base, screen: 2 })).toEqual({ kind: "part", partId: "n", at: "start" });
    expect(turn(1, { ...base, screen: 2, partLength: 300 })).toEqual({ kind: "extend" });
    expect(turn(1, { ...base, screen: 2, partLength: 300, loading: true })).toEqual({ kind: "none" });
    expect(turn(-1, base)).toEqual({ kind: "part", partId: "p", at: "end" });
    expect(turn(-1, { ...base, sliceStart: 80_000 })).toEqual({ kind: "window", from: windowFrom(79_999), anchor: 79_999 });
    expect(turn(-1, { ...base, previous: null })).toEqual({ kind: "none" });
    expect(windowFrom(100)).toBe(0);
    expect(windowFrom(100_000)).toBe(100_000 - WINDOW_CHARS / 2);
  });

  it("gives the share of the book before a character", () => {
    const parts = [{ id: "a", length: 100 }, { id: "b", length: 300 }];
    expect(bookPercent(parts, "a", 0)).toBe(0);
    expect(bookPercent(parts, "b", 100)).toBe(50);
    expect(bookPercent(parts, "b", 300)).toBe(100);
  });
});

/**
 * jsdom lays nothing out. This gives the body a layout like Chromium's columns: `perPage` characters fill a page, the pages are side by side,
 * and a character's box is at the left of its page. `perPage` follows the font size, so a larger font gives more pages.
 */
function fakeLayout() {
  const perPage = (body: HTMLElement) => Math.round(4000 / parseFloat(body.style.fontSize || "18"));
  const step = (body: HTMLElement) => parseFloat(body.style.columnWidth) + parseFloat(body.style.columnGap);
  const bodyOf = (node: Node | null): HTMLElement | null => (node instanceof HTMLElement ? node : node?.parentElement ?? null)?.closest("[data-testid='reading-body']") ?? null;
  const indexIn = (body: HTMLElement, node: Node, offset: number) => {
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let before = 0;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (current === node) return before + [...(current.textContent ?? "").slice(0, offset)].length;
      before += [...(current.textContent ?? "")].length;
    }
    return before;
  };
  const scrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollWidth");
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.getAttribute("data-testid") !== "reading-body" || !this.style.columnWidth) return 0;
      const pages = Math.max(1, Math.ceil([...(this.textContent ?? "")].length / perPage(this)));
      return pages * step(this) - parseFloat(this.style.columnGap);
    },
  });
  // An element has a box unless it lies in a tab that is behind another (`display: none`).
  const elementRects = vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(function (this: HTMLElement) {
    return (this.closest('[data-behind="true"]') ? [] : [{ left: 0, right: 10, top: 0, bottom: 20, width: 10, height: 20, x: 0, y: 0, toJSON: () => ({}) }]) as unknown as DOMRectList;
  });
  const rects = (Range.prototype as { getClientRects?: unknown }).getClientRects;
  (Range.prototype as unknown as { getClientRects: () => DOMRect[] }).getClientRects = function (this: Range) {
    const body = bodyOf(this.startContainer);
    if (!body || !body.style.columnWidth || body.closest('[data-behind="true"]')) return [];
    const page = Math.floor(indexIn(body, this.startContainer, this.startOffset) / perPage(body));
    const left = page * step(body);
    return [{ left, right: left + 10, top: 0, bottom: 20, width: 10, height: 20, x: left, y: 0, toJSON: () => ({}) } as DOMRect];
  };
  return () => {
    if (scrollWidth) Object.defineProperty(HTMLElement.prototype, "scrollWidth", scrollWidth);
    (Range.prototype as { getClientRects?: unknown }).getClientRects = rects;
    elementRects.mockRestore();
  };
}

const TEXT = Array.from({ length: 2000 }, (_, index) => "甲乙丙丁戊己庚辛壬癸"[index % 10]).join("");

function doc(partial: Partial<ReadingDocument> = {}): ReadingDocument {
  return {
    resourceId: "res_1", revisionId: "rev_1", title: "合成书", format: "txt", warnings: ["Parser warning: synthetic diagnostics text"],
    toc: [{ label: "第一章", partId: "a" }, { label: "第二章", partId: "b" }],
    parts: [{ id: "a", title: "第一章", kind: "text", length: 2000, textLayer: true }, { id: "b", title: "第二章", kind: "text", length: 2000, textLayer: true }],
    slice: { partId: "a", text: TEXT, start: 0, end: 2000, kind: "text", textLayer: true, images: [] },
    source: { available: true },
    ...partial,
  };
}

const baseStyle = { measurePx: 680, fontSizePx: 18, fontFamily: "sans", lineHeight: 1.7, marginPx: 24, theme: "white" };

function props(extra: Record<string, unknown> = {}) {
  return {
    document: doc(), style: baseStyle, labels: readingLabels(i18n), t: i18n.t,
    labelsExtra: { sourceNeedsReview: "", sourceMissing: "", sourceRepair: "" },
    hits: [], bookmarks: [], assets: {}, highlight: null, sourceCard: null,
    onSearch: () => {}, onJump: () => {}, onProgress: () => {}, onPart: () => {}, onSelect: () => {},
    onStyle: () => {}, onBookmark: () => {}, onRemoveBookmark: () => {}, onOpenBookmark: () => {}, onBackToNote: () => {}, onRepair: () => {},
    ...extra,
  } as Parameters<typeof ReadingPane>[0];
}

const pagePosition = () => screen.getByTestId("reading-page-position").textContent;

describe("AT-139 a novel is read page by page", () => {
  let restore: () => void;
  let resized: Array<() => void>;
  const realObserver = globalThis.ResizeObserver;
  beforeEach(() => {
    restore = fakeLayout();
    resized = [];
    globalThis.ResizeObserver = class { constructor(run: () => void) { resized.push(run); } observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  });
  afterEach(() => { cleanup(); restore(); vi.restoreAllMocks(); globalThis.ResizeObserver = realObserver; });

  it("reports no position from a tab behind another, and places the page when the tab comes back", () => {
    const positions: Array<[string, number, number]> = [];
    const onPosition = (partId: string, start: number, end: number) => positions.push([partId, start, end]);
    const document_ = doc({ progress: { locator: null, consumed: [], completion: "in_progress", restoredPartId: "a", restoredRange: { start: 1500, end: 1510 } } as never });
    const view = render(<div data-behind="true"><ReadingPane {...props({ onPosition, document: document_ })} /></div>);
    expect(positions).toEqual([]);
    // Back in front: the page of the place the book was left, not the start of the text.
    view.container.firstElementChild!.removeAttribute("data-behind");
    act(() => { for (const run of resized) run(); });
    expect(pagePosition()).toBe("本章 第 7 / 10 页");
    expect(positions.at(-1)![1]).toBeLessThanOrEqual(1500);
    expect(positions.at(-1)![2]).toBeGreaterThan(1500);
  });

  it("places no page and reports no position while the tab is not in front, though it still has boxes", () => {
    const positions: Array<[string, number, number]> = [];
    const onPosition = (partId: string, start: number, end: number) => positions.push([partId, start, end]);
    const document_ = doc({ progress: { locator: null, consumed: [], completion: "in_progress", restoredPartId: "a", restoredRange: { start: 1500, end: 1510 } } as never });
    const view = render(<ReadingPane {...props({ onPosition, document: document_, shown: false })} />);
    // A layout of another size while it is hidden (the column it is in was resized) moves nothing.
    view.rerender(<ReadingPane {...props({ onPosition, document: document_, shown: false, style: { ...baseStyle, fontSizePx: 24 } })} />);
    expect(positions).toEqual([]);
    view.rerender(<ReadingPane {...props({ onPosition, document: document_, shown: true, style: { ...baseStyle, fontSizePx: 24 } })} />);
    const [, start, end] = positions.at(-1)!;
    expect(start).toBeLessThanOrEqual(1500);
    expect(end).toBeGreaterThan(1500);
  });

  it("comes back to the same page after laying out again and again (a column folding and coming back), not a page earlier each time", () => {
    const positions: Array<[string, number, number]> = [];
    const onPosition = (partId: string, start: number, end: number) => positions.push([partId, start, end]);
    const view = render(<ReadingPane {...props({ onPosition })} />);
    for (let turn = 0; turn < 3; turn += 1) fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(pagePosition()).toBe("本章 第 4 / 10 页");
    for (let round = 0; round < 4; round += 1) {
      view.rerender(<ReadingPane {...props({ onPosition, style: { ...baseStyle, fontSizePx: 24 } })} />);
      const [, start, end] = positions.at(-1)!;
      expect(start).toBeLessThanOrEqual(666);
      expect(end).toBeGreaterThan(666);
      view.rerender(<ReadingPane {...props({ onPosition, style: baseStyle })} />);
    }
    expect(pagePosition()).toBe("本章 第 4 / 10 页");
    expect(positions.at(-1)).toEqual(["a", 666, 888]);
  });

  it("does not take the start of a page for a new position while the saved character is on that page", () => {
    expect(pageHolds({ partId: "a", start: 1500 }, { partId: "a", start: 1332, end: 1554 })).toBe(true);
    expect(pageHolds({ partId: "a", start: 1332 }, { partId: "a", start: 1332, end: 1332 })).toBe(true);
    // The next page, an earlier one, or another chapter is a move.
    expect(pageHolds({ partId: "a", start: 1554 }, { partId: "a", start: 1332, end: 1554 })).toBe(false);
    expect(pageHolds({ partId: "a", start: 1000 }, { partId: "a", start: 1332, end: 1554 })).toBe(false);
    expect(pageHolds({ partId: "b", start: 1500 }, { partId: "a", start: 1332, end: 1554 })).toBe(false);
    expect(pageHolds(null, { partId: "a", start: 1332, end: 1554 })).toBe(false);
  });

  it("pages a chapter in a fixed frame, keeps the first character of the page after a larger font, and opens a bookmark at its page", () => {
    const positions: Array<[string, number, number]> = [];
    const onPosition = (partId: string, start: number, end: number) => positions.push([partId, start, end]);
    const view = render(<ReadingPane {...props({ onPosition })} />);
    // 2000 characters at 222 a page.
    expect(pagePosition()).toBe("本章 第 1 / 10 页");
    expect(screen.getByTestId("reading-book-percent").textContent).toBe("全书 0%");
    for (let turn = 0; turn < 3; turn += 1) fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(pagePosition()).toBe("本章 第 4 / 10 页");
    expect(positions.at(-1)).toEqual(["a", 666, 888]);
    expect(screen.getByTestId("reading-body").style.transform).toContain("translateX(-");

    // A larger font: more pages, and the page shown still has the character the page started with.
    view.rerender(<ReadingPane {...props({ onPosition, style: { ...baseStyle, fontSizePx: 24 } })} />);
    expect(pagePosition()).toBe("本章 第 4 / 12 页");
    const [, start, end] = positions.at(-1)!;
    expect(start).toBeLessThanOrEqual(666);
    expect(end).toBeGreaterThan(666);

    // A bookmark inside the laid-out text: its page, with the mark.
    view.rerender(<ReadingPane {...props({ onPosition, style: { ...baseStyle, fontSizePx: 24 }, highlight: { start: 1500, end: 1510 } })} />);
    expect(screen.getByTestId("reading-quote-hit")).toBeTruthy();
    expect(pagePosition()).toBe("本章 第 9 / 12 页");
  });

  it("shows two pages a screen when double, turns one page per wheel gesture and on the page's outer thirds", () => {
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    render(<ReadingPane {...props({ style: { ...baseStyle, pageMode: "double" } })} />);
    expect(pagePosition()).toBe("本章 第 1 / 10 页");
    const pages = screen.getByTestId("reading-pages");
    fireEvent.wheel(pages, { deltaY: 120 });
    now += 50;
    fireEvent.wheel(pages, { deltaY: 120 });
    expect(pagePosition()).toBe("本章 第 3 / 10 页");
    now += 400;
    fireEvent.wheel(pages, { deltaY: -120 });
    expect(pagePosition()).toBe("本章 第 1 / 10 页");

    pages.getBoundingClientRect = () => ({ left: 0, right: 900, width: 900, top: 0, bottom: 600, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.click(pages, { clientX: 850 });
    expect(pagePosition()).toBe("本章 第 3 / 10 页");
    fireEvent.click(pages, { clientX: 450 });
    expect(pagePosition()).toBe("本章 第 3 / 10 页");
    fireEvent.click(pages, { clientX: 40 });
    expect(pagePosition()).toBe("本章 第 1 / 10 页");
  });

  it("goes from a chapter's last page to the next chapter, and from its first page to the last page of the one before", () => {
    const part = vi.fn();
    const window_ = vi.fn();
    const view = render(<ReadingPane {...props({ onPart: part, onWindow: window_ })} />);
    fireEvent.keyDown(window, { key: "End" });
    for (let turn = 0; turn < 10; turn += 1) fireEvent.keyDown(window, { key: "PageDown" });
    expect(part).toHaveBeenCalledWith("b", 0);
    // The next chapter arrives at its first page.
    view.rerender(<ReadingPane {...props({ onPart: part, onWindow: window_, document: doc({ slice: { partId: "b", text: TEXT, start: 0, end: 2000, kind: "text", textLayer: true, images: [] } }) })} />);
    expect(pagePosition()).toBe("本章 第 1 / 10 页");
    fireEvent.keyDown(window, { key: " ", code: "Space", shiftKey: true });
    expect(window_).toHaveBeenCalledWith("a", 0);
    // The chapter before arrives at its last page.
    view.rerender(<ReadingPane {...props({ onPart: part, onWindow: window_, document: doc() })} />);
    expect(pagePosition()).toBe("本章 第 10 / 10 页");
  });

  it("opens where the book was left: a window around the saved place, without moving the saved position", () => {
    const window_ = vi.fn();
    // A long chapter whose saved place is far inside it: the opened slice starts just before the place.
    const long = doc({
      parts: [{ id: "a", title: "第一章", kind: "text", length: 200_000, textLayer: true }],
      slice: { partId: "a", text: TEXT, start: 99_800, end: 101_800, kind: "text", textLayer: true, images: [] },
      progress: { locator: null, consumed: [], completion: "reading", restoredPartId: "a", restoredRange: { start: 100_000, end: 100_100 } },
    });
    render(<ReadingPane {...props({ document: long, onWindow: window_ })} />);
    expect(window_).toHaveBeenCalledWith("a", windowFrom(100_000));
  });

  it("has no continue-reading button and no import diagnostics in the text, paged or scrolling", () => {
    for (const flow of ["paged", "scroll"] as const) {
      render(<ReadingPane {...props({ style: { ...baseStyle, flow } })} />);
      expect(screen.queryByTestId("reading-more")).toBeNull();
      expect(screen.getByTestId("reading-page").textContent).not.toContain("synthetic diagnostics");
      cleanup();
    }
  });

  it("does not slide when the system asks for less motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), addEventListener: () => {}, removeEventListener: () => {} }));
    try {
      render(<ReadingPane {...props()} />);
      expect(screen.getByTestId("reading-body").style.transition).toBe("none");
    } finally { vi.unstubAllGlobals(); }
  });

  it("appends the next window while scrolling near the end of the loaded text", () => {
    const extend = vi.fn();
    const short = doc({ parts: [{ id: "a", title: "第一章", kind: "text", length: 9000, textLayer: true }] });
    render(<ReadingPane {...props({ document: short, style: { ...baseStyle, flow: "scroll" }, onExtend: extend })} />);
    fireEvent.scroll(screen.getByTestId("reading-scroll"));
    expect(extend).toHaveBeenCalled();
  });

  it("offers paged and scrolling in the reader's settings, and double pages only when paged", () => {
    const styled = vi.fn();
    const view = render(<ReadingPane {...props({ onStyle: styled })} />);
    fireEvent.click(screen.getByTestId("reading-settings"));
    expect(screen.getByTestId("reading-flow-paged").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("reading-flow-scroll"));
    expect(styled).toHaveBeenLastCalledWith({ flow: "scroll" });
    view.rerender(<ReadingPane {...props({ onStyle: styled, style: { ...baseStyle, flow: "scroll" } })} />);
    expect(screen.getByTestId("reading-mode-double")).toHaveProperty("disabled", true);
  });
});

describe("AT-140 contents, search and bookmarks at the reader's left", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("opens one panel at a time, marks the current chapter, and closes with Esc giving the focus back to its button", () => {
    render(<ReadingPane {...props()} />);
    const tocButton = screen.getByTestId("reading-panel-toc");
    fireEvent.click(tocButton);
    expect(screen.getByTestId("toc-a").getAttribute("aria-current")).toBe("true");
    expect(screen.getByTestId("toc-b").getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByTestId("reading-panel-bookmarks"));
    expect(screen.getAllByTestId("reading-panel")).toHaveLength(1);
    expect(screen.getByTestId("reading-panel").getAttribute("data-panel")).toBe("bookmarks");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("reading-panel")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("reading-panel-bookmarks"));
  });

  it("is dragged or stepped wider, and the width is saved", () => {
    const styled = vi.fn();
    render(<ReadingPane {...props({ onStyle: styled })} />);
    fireEvent.click(screen.getByTestId("reading-panel-search"));
    expect(screen.getByTestId("reading-panel").style.width).toBe("280px");
    fireEvent.keyDown(screen.getByTestId("reading-panel-grip"), { key: "ArrowRight" });
    expect(styled).toHaveBeenLastCalledWith({ panelPx: 296 });
    const grip = screen.getByTestId("reading-panel-grip");
    fireEvent.pointerDown(grip, { clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(grip, { clientX: 360, pointerId: 1 });
    fireEvent.pointerUp(grip, { clientX: 360, pointerId: 1 });
    expect(styled).toHaveBeenLastCalledWith({ panelPx: 356 });
  });

  it("floats over the text in a narrow reader, and a click on the text closes it", () => {
    const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.getAttribute("data-testid") === "reading-page" ? 520 : 0; } });
    try {
      render(<ReadingPane {...props()} />);
      fireEvent.click(screen.getByTestId("reading-panel-toc"));
      expect(screen.getByTestId("reading-panel").getAttribute("data-placement")).toBe("float");
      fireEvent.click(screen.getByTestId("reading-pages"));
      expect(screen.queryByTestId("reading-panel")).toBeNull();
    } finally {
      if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
    }
  });
});
