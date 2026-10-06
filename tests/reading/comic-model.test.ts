import { describe, expect, it } from "vitest";
import {
  buildSpreads, comicKeyAction, effectiveAnimation, evictFarthest, fitScale, isWide, pageBoxes, prefetchPages, regionFromPoints, regionStyle, spreadIndexOf, spreadSize,
  stepSpread, stripLayout, tapAction, topPageOfStrip, visibleStripRange, visualOrder, type ComicPageInfo,
} from "../../apps/desktop/src/renderer/readers/comic-model.ts";

const page = (index: number, extra: Partial<ComicPageInfo> = {}): ComicPageInfo => ({ id: `p${index}`, index, name: `${index}.png`, width: 800, height: 1200, spread: false, ok: true, ...extra });
const pages = (count: number, wide: number[] = []) => Array.from({ length: count }, (_, index) => page(index, wide.includes(index) ? { width: 1600, height: 1200 } : {}));

describe("M2 comic spreads", () => {
  it("shows one page at a time in single and strip layouts", () => {
    expect(buildSpreads(pages(3), "single", true).map((spread) => spread.pages)).toEqual([[0], [1], [2]]);
    expect(buildSpreads(pages(3), "strip", true).map((spread) => spread.pages)).toEqual([[0], [1], [2]]);
    expect(buildSpreads([], "double", true)).toEqual([]);
  });

  it("pairs pages in reading order and keeps the cover alone when asked", () => {
    expect(buildSpreads(pages(6), "double", true).map((spread) => spread.pages)).toEqual([[0], [1, 2], [3, 4], [5]]);
    expect(buildSpreads(pages(6), "double", false).map((spread) => spread.pages)).toEqual([[0, 1], [2, 3], [4, 5]]);
  });

  it("never pushes a wide page or a page-spread picture into half a spread", () => {
    expect(buildSpreads(pages(6, [2]), "double", true).map((spread) => spread.pages)).toEqual([[0], [1], [2], [3, 4], [5]]);
    const marked = [page(0), page(1, { spread: true }), page(2), page(3)];
    expect(isWide(marked[1])).toBe(true);
    expect(buildSpreads(marked, "double", false).map((spread) => spread.pages)).toEqual([[0], [1], [2, 3]]);
  });

  it("knows which spread a page is on and does not step past either end", () => {
    const spreads = buildSpreads(pages(6), "double", true);
    expect(spreadIndexOf(spreads, 2)).toBe(1);
    expect(spreadIndexOf(spreads, 99)).toBe(-1);
    expect(stepSpread(spreads, 0, -1)).toBe(0);
    expect(stepSpread(spreads, 3, 1)).toBe(3);
    expect(stepSpread(spreads, 1, 1)).toBe(2);
    expect(stepSpread([], 0, 1)).toBe(0);
  });

  it("puts the first page of a pair on the right in a right-to-left book", () => {
    expect(visualOrder({ pages: [3, 4] }, "rtl")).toEqual([4, 3]);
    expect(visualOrder({ pages: [3, 4] }, "ltr")).toEqual([3, 4]);
    expect(visualOrder({ pages: [3] }, "rtl")).toEqual([3]);
  });
});

describe("M2 comic fit", () => {
  const viewport = { width: 1000, height: 600 };
  it("scales a page by width, height, whole page or not at all, and multiplies by zoom", () => {
    const size = { width: 800, height: 1200 };
    expect(fitScale("width", size, viewport)).toBeCloseTo(1.25);
    expect(fitScale("height", size, viewport)).toBeCloseTo(0.5);
    expect(fitScale("page", size, viewport)).toBeCloseTo(0.5);
    expect(fitScale("original", size, viewport)).toBe(1);
    expect(fitScale("page", size, viewport, 2)).toBeCloseTo(1);
  });

  it("survives a page with no known size", () => {
    expect(spreadSize([page(0, { width: 0, height: 0 })])).toEqual({ width: 2, height: 3 });
    const boxes = pageBoxes("page", [page(0, { width: 0, height: 0 })], viewport);
    expect(boxes[0]!.width).toBeGreaterThan(0);
    expect(boxes[0]!.height).toBeGreaterThan(0);
    expect(fitScale("page", { width: 0, height: 0 }, viewport)).toBeGreaterThan(0);
  });

  it("sets the two pages of a spread to one height so the pair lines up", () => {
    const boxes = pageBoxes("height", [page(0), page(1, { width: 600, height: 900 })], viewport);
    expect(boxes[0]!.height).toBe(boxes[1]!.height);
    expect(boxes[0]!.height).toBe(600);
    expect(boxes[0]!.width / boxes[0]!.height).toBeCloseTo(800 / 1200, 2);
  });
});

describe("M2 comic loading and keys", () => {
  it("prefetches the next pages first, then one behind, within the limit", () => {
    const spreads = buildSpreads(pages(20), "single", false);
    expect(prefetchPages(spreads, 5)).toEqual([6, 7, 4]);
    expect(prefetchPages(spreads, 0)).toEqual([1, 2]);
    expect(prefetchPages(spreads, 19)).toEqual([18]);
    expect(prefetchPages(spreads, 5, { ahead: 5, behind: 5, limit: 4 })).toEqual([6, 7, 8, 9]);
  });

  it("drops the cached pages farthest from the reader when over capacity, and never the ones in use", () => {
    expect(evictFarthest([1, 2, 3], [2], 5)).toEqual([]);
    expect(evictFarthest([0, 1, 2, 3, 4, 5], [4], 3)).toEqual([0, 1, 2]);
    expect(evictFarthest([0, 1, 2, 3], [0], 2)).toEqual([3, 2]);
  });

  it("maps arrows to the direction of reading and leaves a strip to its own scrolling", () => {
    expect(comicKeyAction({ key: "ArrowLeft" }, "rtl", "single")).toBe("next");
    expect(comicKeyAction({ key: "ArrowRight" }, "rtl", "single")).toBe("prev");
    expect(comicKeyAction({ key: "ArrowLeft" }, "ltr", "single")).toBe("prev");
    expect(comicKeyAction({ key: "ArrowRight" }, "ltr", "double")).toBe("next");
    expect(comicKeyAction({ key: " " }, "rtl", "single")).toBe("next");
    expect(comicKeyAction({ key: " ", shiftKey: true }, "rtl", "single")).toBe("prev");
    expect(comicKeyAction({ key: "Home" }, "ltr", "single")).toBe("first");
    expect(comicKeyAction({ key: "End" }, "ltr", "single")).toBe("last");
    expect(comicKeyAction({ key: "ArrowRight" }, "ltr", "strip")).toBeNull();
    expect(comicKeyAction({ key: "PageDown" }, "ltr", "strip")).toBeNull();
    expect(comicKeyAction({ key: "f" }, "ltr", "strip")).toBe("fullscreen");
    expect(comicKeyAction({ key: "=", ctrlKey: true }, "ltr", "single")).toBe("zoomIn");
    expect(comicKeyAction({ key: "-", metaKey: true }, "ltr", "single")).toBe("zoomOut");
    expect(comicKeyAction({ key: "0", ctrlKey: true }, "ltr", "single")).toBe("zoomReset");
    expect(comicKeyAction({ key: "x" }, "ltr", "single")).toBeNull();
  });

  it("turns the page from the outer thirds of the stage and leaves the middle alone", () => {
    expect(tapAction(10, 900, "ltr")).toBe("prev");
    expect(tapAction(890, 900, "ltr")).toBe("next");
    expect(tapAction(10, 900, "rtl")).toBe("next");
    expect(tapAction(890, 900, "rtl")).toBe("prev");
    expect(tapAction(450, 900, "rtl")).toBeNull();
    expect(tapAction(10, 0, "rtl")).toBeNull();
  });

  it("drops the page animation when the user asks for reduced motion", () => {
    expect(effectiveAnimation("slide", true)).toBe("none");
    expect(effectiveAnimation("slide", false)).toBe("slide");
  });
});

describe("M2 comic regions", () => {
  const box = { width: 400, height: 600 };
  it("turns a drag into a fraction of the page whichever way it was dragged", () => {
    expect(regionFromPoints({ x: 40, y: 60 }, { x: 240, y: 360 }, box)).toEqual({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 });
    expect(regionFromPoints({ x: 240, y: 360 }, { x: 40, y: 60 }, box)).toEqual({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 });
  });

  it("keeps the region inside the page when the drag leaves it", () => {
    const region = regionFromPoints({ x: 300, y: 500 }, { x: 900, y: 900 }, box)!;
    expect(region.x + region.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(region.y + region.height).toBeLessThanOrEqual(1 + 1e-9);
    expect(region.x).toBe(0.75);
    const negative = regionFromPoints({ x: -50, y: -50 }, { x: 100, y: 100 }, box)!;
    expect(negative.x).toBe(0);
    expect(negative.y).toBe(0);
  });

  it("does not count a click or a sliver as a selection", () => {
    expect(regionFromPoints({ x: 10, y: 10 }, { x: 12, y: 12 }, box)).toBeNull();
    expect(regionFromPoints({ x: 10, y: 10 }, { x: 300, y: 12 }, box)).toBeNull();
    expect(regionFromPoints({ x: 0, y: 0 }, { x: 100, y: 100 }, { width: 0, height: 0 })).toBeNull();
  });

  it("describes a region as percentages of its page", () => {
    expect(regionStyle({ x: 0.1, y: 0.25, width: 0.5, height: 0.2 })).toEqual({ left: "10.0000%", top: "25.0000%", width: "50.0000%", height: "20.0000%" });
  });
});

describe("M2 comic strip", () => {
  it("lays pages out at the strip width with a gap and finds the page at the top of the view", () => {
    const strip = stripLayout([page(0), page(1, { width: 400, height: 400 }), page(2)], 400, 10);
    expect(strip.heights).toEqual([600, 400, 600]);
    expect(strip.tops).toEqual([0, 610, 1020]);
    expect(strip.total).toBe(1620);
    expect(topPageOfStrip(strip.tops, strip.heights, 0)).toBe(0);
    expect(topPageOfStrip(strip.tops, strip.heights, 605)).toBe(1);
    expect(topPageOfStrip(strip.tops, strip.heights, 5000)).toBe(2);
  });

  it("renders only the pages near the view, however long the strip is", () => {
    const strip = stripLayout(pages(2000), 800, 8);
    const range = visibleStripRange(strip.tops, strip.heights, 600_000, 800, 800);
    expect(range.last - range.first).toBeLessThan(6);
    expect(range.first).toBeGreaterThan(300);
    expect(visibleStripRange([], [], 0, 800, 800)).toEqual({ first: 0, last: -1 });
    expect(visibleStripRange(strip.tops, strip.heights, 0, 800, 800).first).toBe(0);
  });
});

describe("M2 comic zoom and page size boundaries (A-47 W1)", () => {
  const sizes = [{ width: 1000, height: 700 }, { width: 400, height: 300 }, { width: 1920, height: 1080 }];
  const zooms = [0.25, 0.5, 0.75, 1, 1.25, 2, 4];

  it("makes every page box the fit base times the zoom, within a pixel, at every viewport and zoom", () => {
    for (const viewport of sizes) {
      for (const zoom of zooms) {
        const [box] = pageBoxes("height", [page(0)], viewport, zoom);
        expect(Math.abs(box!.height - viewport.height * zoom)).toBeLessThanOrEqual(1);
        const [whole] = pageBoxes("page", [page(0)], viewport, zoom);
        const base = Math.min(viewport.width / 800, viewport.height / 1200);
        expect(Math.abs(whole!.height - 1200 * base * zoom)).toBeLessThanOrEqual(1);
        const [wide] = pageBoxes("width", [page(0)], viewport, zoom);
        expect(Math.abs(wide!.width - viewport.width * zoom)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("shows the whole page at zoom 1 with the whole-page fit, for any shape of page and window", () => {
    for (const viewport of sizes) {
      for (const shape of [{ width: 800, height: 1200 }, { width: 1600, height: 1200 }, { width: 100, height: 3000 }, { width: 3000, height: 100 }]) {
        const [box] = pageBoxes("page", [page(0, shape)], viewport);
        expect(box!.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(box!.height).toBeLessThanOrEqual(viewport.height + 1);
      }
    }
  });

  it("gives the same boxes for the same inputs, whatever was asked before", () => {
    const first = pageBoxes("page", [page(0), page(1)], sizes[0]!, 1.25);
    pageBoxes("page", [page(0)], sizes[1]!, 4);
    expect(pageBoxes("page", [page(0), page(1)], sizes[0]!, 1.25)).toEqual(first);
  });

  it("stays positive and finite at a window of one pixel, a zoom of zero and a page of no size", () => {
    for (const viewport of [{ width: 1, height: 1 }, { width: 0, height: 0 }, { width: -5, height: 10 }]) {
      for (const zoom of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        for (const box of pageBoxes("page", [page(0, { width: 0, height: 0 }), page(1)], viewport, zoom)) {
          expect(Number.isFinite(box.width) && box.width >= 1).toBe(true);
          expect(Number.isFinite(box.height) && box.height >= 1).toBe(true);
        }
      }
    }
  });

  it("gives the original fit the pixel size of the picture, times the zoom, whatever the window", () => {
    expect(pageBoxes("original", [page(0)], { width: 100, height: 100 }, 1)[0]).toEqual({ width: 800, height: 1200 });
    expect(pageBoxes("original", [page(0)], { width: 5000, height: 5000 }, 0.5)[0]).toEqual({ width: 400, height: 600 });
  });
});
