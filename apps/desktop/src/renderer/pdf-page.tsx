import { useEffect, useRef, useState } from "react";
import { alignPdfSelection, mapCanonicalPieces, pdfHighlightRange, selectionOffsets, type CanonicalPiece, type PiecePoint } from "@manga/app-core/pdf-text-map";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";

// Electron's Chromium may not ship Uint8Array.prototype.toHex yet. PDF.js 6 calls it while building the text layer.
const bytesPrototype = Uint8Array.prototype as Uint8Array & { toHex?: () => string };
if (typeof bytesPrototype.toHex !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    value(this: Uint8Array) {
      let hex = "";
      for (const byte of this) hex += byte.toString(16).padStart(2, "0");
      return hex;
    },
  });
}

type Viewport = { width: number; height: number; scale: number };
type PdfPage = {
  userUnit?: number;
  getViewport: (params: { scale: number }) => Viewport;
  render: (params: { canvas: HTMLCanvasElement; viewport: Viewport }) => { promise: Promise<void>; cancel: () => void };
  getTextContent: () => Promise<{ items: unknown[] }>;
  cleanup: () => void;
};
type PdfTask = { promise: Promise<{ numPages: number; getPage: (index: number) => Promise<PdfPage> }>; destroy: () => Promise<void> };
/** How long the page width has to hold still before the page is painted again at the new width. */
const WIDTH_SETTLE_MS = 150;

type TextLayerBuilder = { div: HTMLDivElement; render: (options: { viewport: Viewport; textContentParams: Record<string, unknown> }) => Promise<void>; cancel: () => void };

export type PdfSelection = { quote: string; start: number; end: number };

type DomPiece = CanonicalPiece & { span: HTMLElement | null; br: HTMLElement | null };

function assetBase(): string {
  const dev = (import.meta as { env?: { DEV?: boolean } }).env?.DEV;
  if (dev) return `${window.location.origin}/pdfjs/`;
  return new URL("./pdfjs/", window.location.href).href;
}

/** Walk the official text layer in content order. A following `<br>` is the item's EOL, not extra innerText breaks. */
function collectTextPieces(layer: HTMLElement): DomPiece[] {
  const pieces: DomPiece[] = [];
  const visit = (node: Node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      const last = pieces[pieces.length - 1];
      if (last && !last.eol) {
        last.eol = true;
        last.br = node;
      } else pieces.push({ text: "", eol: true, span: null, br: node });
      return;
    }
    if (node.classList.contains("markedContent")) {
      for (const child of node.childNodes) visit(child);
      return;
    }
    if (node.tagName === "SPAN") pieces.push({ text: node.textContent ?? "", eol: false, span: node, br: null });
  };
  for (const child of layer.childNodes) visit(child);
  return pieces;
}

function utf16Within(span: HTMLElement, node: Node, offset: number): number {
  if (node === span) {
    let utf16 = 0;
    for (let index = 0; index < offset && index < span.childNodes.length; index += 1) utf16 += span.childNodes[index]?.textContent?.length ?? 0;
    return utf16;
  }
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let utf16 = 0;
  let current = walker.nextNode();
  while (current) {
    if (current === node) return utf16 + offset;
    utf16 += current.textContent?.length ?? 0;
    current = walker.nextNode();
  }
  return utf16;
}

/**
 * Place a selection boundary among the pieces. A drag past a line end or from a line start often leaves the boundary
 * on the layer, a `<br>` or PDF.js's endOfContent rather than in a span, so those resolve by document order.
 */
function piecePoint(pieces: DomPiece[], container: Node, offset: number): PiecePoint | null {
  const inside = pieces.findIndex((piece) => piece.span?.contains(container));
  const span = pieces[inside]?.span;
  if (span) return { piece: inside, utf16: utf16Within(span, container, offset) };
  const boundary = document.createRange();
  boundary.setStart(container, offset);
  for (const [index, piece] of pieces.entries()) {
    if (piece.span && boundary.comparePoint(piece.span, 0) >= 0) return { piece: index, utf16: 0 };
    if (piece.br && boundary.comparePoint(piece.br, 0) >= 0) return { piece: index, utf16: piece.text.length };
  }
  return pieces.length ? { piece: pieces.length - 1, afterEol: true } : null;
}

function textEdge(span: HTMLElement, end: boolean): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  if (!node || !end) return node ? { node, offset: 0 } : null;
  for (let next = walker.nextNode(); next; next = walker.nextNode()) node = next;
  return { node, offset: node.textContent?.length ?? 0 };
}

/**
 * Caret for a point on the page. Over a line's glyphs this is the browser's own caret; anywhere else it is the start or
 * end of the nearest line. Off the glyphs Chromium may return a caret in some other line, so that hit is not trusted.
 */
export function caretNear(root: HTMLElement, x: number, y: number): { node: Node; offset: number } | null {
  const spans = [...root.querySelectorAll<HTMLElement>("span")].filter((span) => !span.classList.contains("markedContent") && span.textContent);
  const boxes = spans.map((span) => ({ span, box: span.getBoundingClientRect() }));
  const hit = document.caretPositionFromPoint?.(x, y);
  const under = hit && boxes.find(({ span }) => span.contains(hit.offsetNode));
  if (hit && under && x >= under.box.left && x <= under.box.right && y >= under.box.top && y <= under.box.bottom) {
    return { node: hit.offsetNode, offset: hit.offset };
  }
  const away = ({ box }: { box: DOMRect }) => (y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0);
  const nearest = Math.min(...boxes.map(away));
  const line = boxes.filter((item) => away(item) === nearest);
  let best: { span: HTMLElement; end: boolean; gap: number } | null = null;
  for (const { span, box } of line) {
    for (const [end, gap] of [[false, Math.abs(x - box.left)], [true, Math.abs(x - box.right)]] as const) {
      if (!best || gap < best.gap) best = { span, end, gap };
    }
  }
  return best ? textEdge(best.span, best.end) : null;
}

function scrollParent(node: HTMLElement): HTMLElement {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) return parent;
  }
  return document.documentElement;
}

/**
 * A plain mouse drag on the page selects from caretNear to caretNear. Chromium below 148 drags a native selection over
 * blank text-layer area to arbitrary DOM points, and PDF.js's endOfContent workaround keys off the previous selection,
 * so the same drag could select the line, nothing, or the line above. Double and triple clicks, shift-click and the
 * keyboard keep native selection. Near the top or bottom edge the drag scrolls the reader, as a native drag would.
 */
function bindTextDrag(wrapper: HTMLElement, signal: AbortSignal): void {
  wrapper.addEventListener("mousedown", (event) => {
    const root = wrapper.querySelector<HTMLElement>(":scope > .textLayer");
    if (event.button !== 0 || event.detail > 1 || event.shiftKey || !root) return;
    const anchor = caretNear(root, event.clientX, event.clientY);
    if (!anchor) return;
    event.preventDefault();
    window.getSelection()?.collapse(anchor.node, anchor.offset);
    const scroller = scrollParent(wrapper);
    const drag = new AbortController();
    const options = { signal: AbortSignal.any([signal, drag.signal]) };
    document.addEventListener("mousemove", (move) => {
      const view = scroller === document.documentElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
      const edge = 24;
      if (move.clientY < view.top + edge) scroller.scrollTop -= edge;
      else if (move.clientY > view.bottom - edge) scroller.scrollTop += edge;
      const focus = caretNear(root, move.clientX, move.clientY);
      if (focus) window.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset);
    }, options);
    document.addEventListener("mouseup", () => drag.abort(), options);
  }, { signal });
}

/** The page selection as stored code points; null when nothing usable is selected, review when it cannot be placed. */
export function layerSelection(root: HTMLElement, range: Range, storedText: string, sliceStart: number): PdfSelection | { review: true } | null {
  const pieces = collectTextPieces(root);
  const canonical = pieces.map((piece) => ({ text: piece.text, eol: piece.eol }));
  const map = mapCanonicalPieces(canonical);
  if (map.stable) {
    const start = piecePoint(pieces, range.startContainer, range.startOffset);
    const end = piecePoint(pieces, range.endContainer, range.endOffset);
    const selected = start && end ? selectionOffsets(canonical, start, end) : null;
    if (!selected) return null;
    return alignPdfSelection({ pageText: map.normalized, stable: true, storedText, sliceStart, start: selected.start, end: selected.end });
  }
  const text = range.toString().normalize("NFC").trim();
  if (!text) return null;
  return alignPdfSelection({ pageText: text, stable: false, storedText, sliceStart, start: 0, end: [...text].length });
}

function applyPieceMap(layer: HTMLElement): { pieces: DomPiece[]; normalized: string; stable: boolean } {
  const pieces = collectTextPieces(layer);
  const mapped = mapCanonicalPieces(pieces.map((piece) => ({ text: piece.text, eol: piece.eol })));
  pieces.forEach((piece, index) => {
    const span = piece.span;
    const range = mapped.spans[index];
    if (!span || !range) return;
    if (mapped.stable) {
      span.dataset.cpStart = String(range.start);
      span.dataset.cpEnd = String(range.end);
    } else {
      delete span.dataset.cpStart;
      delete span.dataset.cpEnd;
    }
  });
  return { pieces, normalized: mapped.normalized, stable: mapped.stable };
}

function markSpans(pieces: DomPiece[], range: { start: number; end: number } | null): void {
  let marked = false;
  for (const piece of pieces) {
    const span = piece.span;
    if (!span) continue;
    const from = Number(span.dataset.cpStart);
    const to = Number(span.dataset.cpEnd);
    const hit = Boolean(range && Number.isFinite(from) && Number.isFinite(to) && to > range.start && from < range.end);
    span.classList.toggle("reading-quote-hit", hit);
    if (hit && !marked) {
      span.setAttribute("data-testid", "reading-quote-hit");
      marked = true;
    } else span.removeAttribute("data-testid");
  }
}

/** One PDF.js page: canvas paint plus the official text layer. Callers own which page and which bytes. */
export function PdfPageView(props: {
  bytes: Uint8Array;
  pageNumber: number;
  storedText: string;
  sliceStart: number;
  highlight: { start: number; end: number } | null;
  highlightQuote?: string | null;
  scanLabel: string;
  missingLabel: string;
  onSelection: (selection: PdfSelection | null, review: boolean) => void;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const pageBox = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The stored highlight and the live selection are reviewed separately, so clearing a selection keeps a highlight notice.
  const [highlightReview, setHighlightReview] = useState(false);
  const [selectionReview, setSelectionReview] = useState(false);
  const [emptyText, setEmptyText] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const onSelection = useRef(props.onSelection);
  onSelection.current = props.onSelection;
  const highlightReviewRef = useRef(false);
  highlightReviewRef.current = highlightReview;

  useEffect(() => {
    const node = frame.current;
    if (!node) return;
    let timer: number | undefined;
    let first = true;
    // The page is painted once at the width it opens with. A later change (a scrollbar appearing beside the painted page, the side panes
    // settling) is taken only once the width has held still, so one open is one paint and the text layer a person is selecting in is not
    // thrown away by a repaint a moment after it was made (LOOP-06). A real resize still repaints, after the pause.
    const measure = () => {
      const next = node.clientWidth;
      window.clearTimeout(timer);
      if (first) { first = false; setWidth(next); return; }
      timer = window.setTimeout(() => setWidth((current) => (current === next ? current : next)), WIDTH_SETTLE_MS);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => { window.clearTimeout(timer); observer.disconnect(); };
  }, []);

  useEffect(() => {
    const canvasNode = canvas.current;
    const layerNode = layer.current;
    const box = pageBox.current;
    if (!canvasNode || !layerNode || !box || width <= 0) return;
    let dead = false;
    let task: PdfTask | undefined;
    let renderTask: { promise: Promise<void>; cancel: () => void } | undefined;
    let textLayer: TextLayerBuilder | undefined;
    const listeners = new AbortController();
    setError(null);
    setHighlightReview(false);
    (async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs") as unknown as {
        version: string;
        GlobalWorkerOptions: { workerSrc: string };
        getDocument: (src: Record<string, unknown>) => PdfTask;
      };
      if (dead) return;
      if (pdfjs.version !== "6.3.289") throw new Error(`pdf.js ${pdfjs.version} does not match 6.3.289`);
      // The viewer module reads globalThis.pdfjsLib, which the build module above has just defined.
      const viewer = await import("pdfjs-dist/legacy/web/pdf_viewer.mjs") as unknown as {
        TextLayerBuilder: new (options: { pdfPage: PdfPage; onAppend: (div: HTMLDivElement) => void; abortSignal: AbortSignal }) => TextLayerBuilder;
      };
      if (dead) return;
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(workerUrl, window.location.href).toString();
      const base = assetBase();
      task = pdfjs.getDocument({
        data: props.bytes.slice(),
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        useWorkerFetch: false,
        cMapUrl: `${base}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${base}standard_fonts/`,
        wasmUrl: `${base}wasm/`,
      });
      const doc = await task.promise;
      if (dead) return;
      const page = await doc.getPage(Math.min(Math.max(props.pageNumber, 1), doc.numPages));
      if (dead) return;
      const unscaled = page.getViewport({ scale: 1 });
      const scale = Math.max(0.2, (width / unscaled.width) * zoom);
      const viewport = page.getViewport({ scale });
      // PDF.js 6.3.289 sizes the text layer from these variables. The span font-size and scaleX consume them.
      box.style.setProperty("--scale-factor", String(viewport.scale));
      box.style.setProperty("--user-unit", String(page.userUnit || 1));
      box.style.setProperty("--total-scale-factor", "calc(var(--scale-factor) * var(--user-unit))");
      box.style.setProperty("--scale-round-x", "1px");
      box.style.setProperty("--scale-round-y", "1px");
      canvasNode.width = Math.ceil(viewport.width);
      canvasNode.height = Math.ceil(viewport.height);
      renderTask = page.render({ canvas: canvasNode, viewport });
      await renderTask.promise;
      if (dead) return;
      // The official viewer builder keeps a drag over blank page area on the text (its endOfContent handling).
      // Empty text-content params match the parser's getTextContent() defaults, so stored offsets still line up.
      textLayer = new viewer.TextLayerBuilder({
        pdfPage: page,
        abortSignal: listeners.signal,
        onAppend: (div) => { if (!dead) layerNode.replaceChildren(div); },
      });
      await textLayer.render({ viewport, textContentParams: {} });
      if (dead) return;
      const mapped = applyPieceMap(textLayer.div);
      setEmptyText(!mapped.normalized.trim());
      const highlighted = pdfHighlightRange({
        pageText: mapped.normalized,
        stable: mapped.stable,
        storedText: props.storedText,
        sliceStart: props.sliceStart,
        highlight: props.highlight,
        quote: props.highlightQuote ?? null,
      });
      setHighlightReview(highlighted === "review");
      markSpans(mapped.pieces, highlighted && highlighted !== "review" ? highlighted : null);
      setEpoch((value) => value + 1);
      page.cleanup();
    })().catch((caught: unknown) => {
      if (dead) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => {
      dead = true;
      renderTask?.cancel();
      textLayer?.cancel();
      listeners.abort();
      void task?.destroy().catch(() => undefined);
      layerNode.replaceChildren();
    };
  }, [props.bytes, props.pageNumber, props.storedText, props.sliceStart, props.highlight, props.highlightQuote, width, zoom]);

  useEffect(() => {
    const node = layer.current;
    if (!node) return;
    const changed = () => {
      const current = window.getSelection();
      const root = node.querySelector<HTMLElement>(":scope > .textLayer");
      const placed = root && current && current.rangeCount === 1 && !current.isCollapsed && node.contains(current.anchorNode)
        ? layerSelection(root, current.getRangeAt(0), props.storedText, props.sliceStart)
        : null;
      const review = Boolean(placed && "review" in placed);
      setSelectionReview(review);
      onSelection.current(placed && !("review" in placed) ? placed : null, review || highlightReviewRef.current);
    };
    const listeners = new AbortController();
    document.addEventListener("selectionchange", changed, { signal: listeners.signal });
    bindTextDrag(node, listeners.signal);
    return () => listeners.abort();
  }, [props.storedText, props.sliceStart]);

  return (
    <div className="mx-auto mb-2" data-testid="reading-page-render" data-pdf-epoch={epoch} data-pdf-width={width} ref={frame}>
      <div className="flex gap-2 items-center mb-1 text-sm">
        <button type="button" className="border px-2 py-0.5 rounded" data-testid="reading-zoom-out" onClick={() => setZoom((value) => Math.max(0.5, Math.round((value - 0.25) * 100) / 100))}>缩小</button>
        <button type="button" className="border px-2 py-0.5 rounded" data-testid="reading-zoom-in" onClick={() => setZoom((value) => Math.min(4, Math.round((value + 0.25) * 100) / 100))}>放大</button>
        <button type="button" className="border px-2 py-0.5 rounded" data-testid="reading-zoom-fit" onClick={() => setZoom(1)}>适宽</button>
        {/* Inline in the toolbar: a notice that appears mid-drag must not push the page under the pointer. */}
        {highlightReview || selectionReview ? <span role="status" data-testid="reading-pdf-needs-review">{props.missingLabel}</span> : null}
      </div>
      {error ? <p role="alert" data-testid="reading-pdf-error">{error}</p> : null}
      {emptyText ? <p data-testid="reading-scan">{props.scanLabel}</p> : null}
      <div ref={pageBox} className="pdf-page relative" style={{ background: "#ffffff", border: "1px solid var(--color-border)" }}>
        <canvas ref={canvas} data-testid="reading-pdf-canvas" />
        {/* PDF.js's TextLayerBuilder appends its own .textLayer here. */}
        <div ref={layer} data-testid="reading-pdf-text" />
      </div>
      <style>{TEXT_LAYER_CSS}</style>
    </div>
  );
}

// Official PDF.js 6.3.289 text-layer rules (pdf_viewer.css). Span size comes from --font-height, --scale-x and --total-scale-factor.
const TEXT_LAYER_CSS = `
.pdf-page { --user-unit: 1; --scale-round-x: 1px; --scale-round-y: 1px; --total-scale-factor: calc(var(--scale-factor) * var(--user-unit)); }
.textLayer {
  position: absolute; inset: 0; overflow: clip; line-height: 1; text-size-adjust: none;
  transform-origin: 0 0; z-index: 2; --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
}
.textLayer :is(span, br) { color: transparent; position: absolute; white-space: pre; cursor: text; transform-origin: 0% 0%; user-select: text; }
.textLayer > :not(.markedContent),
.textLayer .markedContent span:not(.markedContent) {
  z-index: 1; --font-height: 0; font-size: calc(var(--text-scale-factor) * var(--font-height));
  --scale-x: 1; --rotate: 0deg;
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}
.textLayer .markedContent { display: contents; }
.textLayer ::selection { background: rgb(0 0 255 / 0.25); }
.textLayer br::selection { background: transparent; }
.textLayer .endOfContent { display: block; position: absolute; inset: 100% 0 0; z-index: 0; cursor: default; user-select: none; }
.textLayer.selecting .endOfContent { top: 0; }
.textLayer .reading-quote-hit { background: rgb(255 220 0 / 0.45); }
`;
