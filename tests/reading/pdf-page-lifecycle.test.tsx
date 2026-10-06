/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { PdfPageView, caretNear, layerSelection } from "../../apps/desktop/src/renderer/pdf-page.tsx";

const fake = vi.hoisted(() => ({
  first: Promise.withResolvers<{ items: Array<{ str: string }> }>(),
  requested: vi.fn(),
  destroy: vi.fn(async () => undefined),
}));

vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({
  version: "6.3.289",
  GlobalWorkerOptions: {},
  getDocument: () => ({
    destroy: fake.destroy,
    promise: Promise.resolve({
      numPages: 2,
      getPage: async (index: number) => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 400 * scale, height: 400 * scale, scale }),
        render: () => ({ promise: Promise.resolve(), cancel: () => undefined }),
        getTextContent: () => {
          fake.requested(index);
          return index === 1 ? fake.first.promise : Promise.resolve({ items: [{ str: "PAGE TWO" }] });
        },
        cleanup: () => undefined,
      }),
    }),
  }),
}));

// Like PDF.js's TextLayerBuilder, the text arrives asynchronously and the layer is handed over through onAppend.
// cancel() here never stops a late result, so the view itself must discard it.
vi.mock("pdfjs-dist/legacy/web/pdf_viewer.mjs", () => ({
  TextLayerBuilder: class {
    div = document.createElement("div");
    constructor(private options: { pdfPage: { getTextContent: () => Promise<{ items: Array<{ str: string }> }> }; onAppend: (div: HTMLDivElement) => void }) {
      this.div.className = "textLayer";
    }
    async render() {
      const content = await this.options.pdfPage.getTextContent();
      const span = document.createElement("span");
      span.textContent = content.items[0]!.str;
      this.div.append(span);
      this.options.onAppend(this.div);
    }
    cancel() {}
  },
}));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("discards late pdf text content after moving to another page", async () => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const shared = { bytes: new Uint8Array([1]), sliceStart: 0, highlight: null, scanLabel: "scan", missingLabel: "review", onSelection: vi.fn() };
  const view = render(<PdfPageView {...shared} pageNumber={1} storedText="FIRST LINE" />);
  await waitFor(() => expect(fake.requested).toHaveBeenCalledWith(1));
  view.rerender(<PdfPageView {...shared} pageNumber={2} storedText="PAGE TWO" />);
  await waitFor(() => expect(screen.getByTestId("reading-pdf-text").textContent).toBe("PAGE TWO"));
  expect(fake.destroy).toHaveBeenCalled();
  await act(async () => { fake.first.resolve({ items: [{ str: "FIRST LINE" }] }); await fake.first.promise; });
  expect(screen.getByTestId("reading-pdf-text").textContent).toBe("PAGE TWO");
});

it("paints a page once at its opening width and again only after the width has held still (LOOP-06)", async () => {
  let width = 600;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  let changed: () => void = () => undefined;
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { changed = callback; } observe() {} disconnect() {} });
  const shared = { bytes: new Uint8Array([1]), sliceStart: 0, highlight: null, scanLabel: "scan", missingLabel: "review", onSelection: vi.fn() };
  render(<PdfPageView {...shared} pageNumber={2} storedText="PAGE TWO" />);
  const epoch = () => Number(screen.getByTestId("reading-page-render").getAttribute("data-pdf-epoch"));
  await waitFor(() => expect(epoch()).toBe(1));
  // A burst of width changes (a scrollbar appearing, the panes settling) is one repaint, not one each, and not before the pause.
  for (const next of [585, 590, 588]) { width = next; act(() => changed()); }
  await new Promise((resolve) => setTimeout(resolve, 60));
  expect(epoch()).toBe(1);
  await waitFor(() => expect(epoch()).toBe(2), { timeout: 2000 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(epoch()).toBe(2);
  // The same width again paints nothing.
  act(() => changed());
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(epoch()).toBe(2);
});

/** Two "REPEAT" lines as PDF.js lays them out, with the viewer's endOfContent after the text. */
function repeatedLayer() {
  const root = document.createElement("div");
  root.className = "textLayer";
  root.innerHTML = "<span>REPEAT</span><br><span>REPEAT</span><div class=\"endOfContent\"></div>";
  document.body.append(root);
  const [first, second] = [...root.querySelectorAll("span")].map((span) => span.firstChild!);
  return { root, first: first!, second: second!, end: root.querySelector(".endOfContent")! };
}

function between(start: [Node, number], end: [Node, number]): Range {
  const range = document.createRange();
  range.setStart(...start);
  range.setEnd(...end);
  return range;
}

it("places a drag that ends past the line end or starts at a line start on the dragged line", () => {
  const { root, first, second, end } = repeatedLayer();
  const stored = "REPEAT\nREPEAT";
  const secondLine = { quote: "REPEAT", start: 7, end: 13 };
  // Past the end of the second line: Chromium reports the layer or endOfContent, not the span.
  expect(layerSelection(root, between([second, 0], [root, 3]), stored, 0)).toEqual(secondLine);
  expect(layerSelection(root, between([second, 0], [end, 0]), stored, 0)).toEqual(secondLine);
  // From the start of the second line: the boundary lands before or after the first line's <br>.
  expect(layerSelection(root, between([root, 1], [second, 6]), stored, 0)).toEqual(secondLine);
  expect(layerSelection(root, between([root, 2], [second, 6]), stored, 0)).toEqual(secondLine);
  // The first line including its end-of-line keeps only the visible text.
  expect(layerSelection(root, between([first, 0], [root, 2]), stored, 0)).toEqual({ quote: "REPEAT", start: 0, end: 6 });
  // Across lines the inner end-of-line stays in the quote.
  expect(layerSelection(root, between([root, 0], [end, 0]), stored, 0)).toEqual({ quote: "REPEAT\nREPEAT", start: 0, end: 13 });
  root.remove();
});

it("treats a whitespace-only drag as no selection and still reviews an unplaceable old representation", () => {
  const { root, first, second } = repeatedLayer();
  expect(layerSelection(root, between([root, 1], [root, 2]), "REPEAT\nREPEAT", 0)).toBeNull();
  expect(layerSelection(root, between([first, 6], [second, 0]), "REPEAT\nREPEAT", 0)).toBeNull();
  // The stored text no longer matches the page and still repeats the quote, so the occurrence cannot be chosen.
  expect(layerSelection(root, between([second, 0], [second, 6]), "OLD REPEAT REPEAT", 0)).toEqual({ review: true });
  root.remove();
});

it("starts a drag from blank page area at the nearest line edge", () => {
  const { root, first, second } = repeatedLayer();
  // jsdom has no layout: line one spans x 100-200 at y 10-30, line two the same at y 40-60.
  const [one, two] = [...root.querySelectorAll("span")];
  const box = (top: number) => ({ left: 100, right: 200, top, bottom: top + 20, width: 100, height: 20, x: 100, y: top, toJSON: () => ({}) }) as DOMRect;
  vi.spyOn(one!, "getBoundingClientRect").mockReturnValue(box(10));
  vi.spyOn(two!, "getBoundingClientRect").mockReturnValue(box(40));
  expect(caretNear(root, 80, 50)).toEqual({ node: second, offset: 0 });
  expect(caretNear(root, 260, 50)).toEqual({ node: second, offset: 6 });
  expect(caretNear(root, 260, 20)).toEqual({ node: first, offset: 6 });
  // Between the lines the closer line wins; below the text the last line does.
  expect(caretNear(root, 80, 37)).toEqual({ node: second, offset: 0 });
  expect(caretNear(root, 80, 90)).toEqual({ node: second, offset: 0 });
  // Off the glyphs Chromium can report a caret in another line; only a caret under the point is trusted.
  const caret = vi.fn((x: number) => ({ offsetNode: x < 200 ? second : first, offset: x < 200 ? 3 : 6 }));
  Object.defineProperty(document, "caretPositionFromPoint", { value: caret, configurable: true });
  expect(caretNear(root, 150, 50)).toEqual({ node: second, offset: 3 });
  expect(caretNear(root, 260, 50)).toEqual({ node: second, offset: 6 });
  delete (document as { caretPositionFromPoint?: unknown }).caretPositionFromPoint;
  root.remove();
});
