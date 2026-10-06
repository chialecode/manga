import { NORMALIZATION_V1 } from "@manga/contracts/location";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, Bookmark, BookmarkPlus, List, Search } from "lucide-react";
import { createTranslator, type Translator } from "@manga/i18n";
import { Input } from "./components/ui/input.tsx";
import { PdfPageView } from "./pdf-page.tsx";
import { fontStack, THEME_BACKGROUND, THEME_FOREGROUND } from "./reader/fonts.ts";
import { layoutParagraphs } from "./reader/paragraphs.ts";
import { ReaderToolbar, type ReaderStyle } from "./reader/toolbar.tsx";

/** Code-point range of the actual DOM selection inside the reading body, plus the selected text. */
export function readingSelection(body: HTMLElement, start: number, selection: Selection | null) {
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!body.contains(range.startContainer) || !body.contains(range.endContainer)) return null;
  const prefix = range.cloneRange();
  prefix.selectNodeContents(body);
  prefix.setEnd(range.startContainer, range.startOffset);
  const quote = range.toString();
  if (!quote.trim()) return null;
  const offset = start + [...prefix.toString()].length;
  return { quote, start: offset, end: offset + [...quote].length };
}

/** Stored ranges are code points, so a highlight has to be translated before slicing UTF-16 text. */
function utf16Offset(text: string, codePointOffset: number): number {
  let count = 0;
  let index = 0;
  for (const char of text) {
    if (count >= codePointOffset) break;
    count += 1;
    index += char.length;
  }
  return index;
}

type ReadingSegment = { kind: "text"; text: string } | { kind: "image"; assetId: string; offset: number };

/** Split a text window so an illustration stays at its recorded code-point offset. */
export function readingSegments(text: string, sliceStart: number, placements: Array<{ assetId: string; offset: number }>): ReadingSegment[] {
  const ordered = [...placements].filter((item) => item.offset >= sliceStart && item.offset <= sliceStart + [...text].length).sort((left, right) => left.offset - right.offset);
  const segments: ReadingSegment[] = [];
  let cursor = 0;
  for (const placement of ordered) {
    const at = utf16Offset(text, placement.offset - sliceStart);
    if (at > cursor) segments.push({ kind: "text", text: text.slice(cursor, at) });
    segments.push({ kind: "image", assetId: placement.assetId, offset: placement.offset });
    cursor = at;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor) });
  if (!segments.length) segments.push({ kind: "text", text });
  return segments;
}

function ReadingImage(props: { asset?: ReadingAsset; src?: string; measure: number; offset?: number; pending: string; failed: string }) {
  if (!props.asset) return <span className="text-sm text-[var(--color-subtle)]" data-testid="reading-image-failed">{props.failed}</span>;
  if (!props.asset.mediaType.startsWith("image/")) {
    return <span className="text-sm text-[var(--color-subtle)]" data-testid={`reading-image-failed-${props.asset.id}`}>{props.failed}</span>;
  }
  if (!props.src) return <span className="text-sm text-[var(--color-subtle)]" data-testid={`reading-image-pending-${props.asset.id}`}>{props.pending.replace("{count}", "1")}</span>;
  return <img src={props.src} alt="" style={{ maxWidth: props.measure }} data-testid={`reading-image-${props.asset.id}`} data-offset={props.offset ?? undefined} />;
}

export function highlightSlices(text: string, highlight: { start: number; end: number } | null, sliceStart: number, sliceEnd: number): [string, string, string] | null {
  if (!highlight || highlight.start < sliceStart || highlight.end > sliceEnd) return null;
  const from = utf16Offset(text, highlight.start - sliceStart);
  const to = utf16Offset(text, highlight.end - sliceStart);
  if (from >= to) return null;
  return [text.slice(0, from), text.slice(from, to), text.slice(to)];
}

export type ReadingAsset = { id: string; partId: string; name: string; mediaType: string; bytes: number };

/** Positioned page model (PDF vector pages, EPUB fixed pages): user-space box, y up, baseline runs. */
export type PageRenderItem =
  | { k: "t"; x: number; y: number; s: number; f: string; t: string; c?: string; o?: number; w?: number; gx?: number[] }
  | { k: "r"; x: number; y: number; w: number; h: number; c: string }
  | { k: "e"; x: number; y: number; w: number; h: number; c: string }
  | { k: "l"; p: number[]; c: string; w: number }
  | { k: "i"; x: number; y: number; w: number; h: number; a?: string };
export type PageRender = { w: number; h: number; items: PageRenderItem[]; truncated?: boolean };

/** The one code-point offset a text run covers, so a selection inside the page view maps to the text layer. */
function pageBoundaryOffset(node: Node, offset: number): number | null {
  const anchor = (node instanceof Element ? node : node.parentElement)?.closest("[data-cp]") ?? null;
  if (!anchor) return null;
  const start = Number(anchor.getAttribute("data-cp"));
  if (!Number.isFinite(start)) return null;
  let within = 0;
  const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode();
  while (current && current !== node) {
    within += [...(current.textContent ?? "")].length;
    current = walker.nextNode();
  }
  if (node instanceof Text) within += [...(node.textContent ?? "").slice(0, offset)].length;
  else for (let index = 0; index < offset; index += 1) within += [...(node.childNodes[index]?.textContent ?? "")].length;
  return start + within;
}

/** Code-point offsets of a DOM range inside the page view, using each run's data-cp anchor. */
export function pageSelectionRange(range: Range): { start: number; end: number; quote: string } | null {
  const start = pageBoundaryOffset(range.startContainer, range.startOffset);
  const end = pageBoundaryOffset(range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) return null;
  return { start, end, quote: range.toString() };
}

export type ReadingDocument = {
  resourceId: string;
  revisionId: string;
  title: string;
  format: string;
  warnings: string[];
  toc: Array<{ label: string; partId: string }>;
  parts: Array<{ id: string; title?: string; kind: string; length: number; textLayer: boolean; imageCount?: number; index?: number; sourceHref?: string }>;
  slice: { partId: string; text: string; start: number; end: number; kind: string; textLayer: boolean; images?: ReadingAsset[]; placements?: Array<{ assetId: string; offset: number; width?: number; height?: number }>; render?: PageRender | null } | null;
  progress?: { locator: unknown; consumed: Array<{ partId?: string; start: number; end: number }>; completion: string; restoredPartId?: string | null; restoredFrom?: string; restoredRange?: { start: number; end: number } | null } | null;
  readRanges?: Array<{ partId?: string; start: number; end: number }>;
  assets?: ReadingAsset[];
  source: { available?: boolean; hosted?: boolean; path?: string };
  /** Reader-applied subset of the book's author CSS; the shell only passes it while the user keeps defaults. */
  authorStyle?: { fontFamily?: string; color?: string; background?: string; lineHeight?: number; textAlign?: string } | null;
};

export type ReadingStyle = ReaderStyle;

const PAGE_FONTS: Record<string, string> = {
  sans: '"Microsoft YaHei", system-ui, sans-serif',
  serif: 'SimSun, "Noto Serif CJK SC", serif',
  mono: 'Consolas, "Microsoft YaHei", monospace',
};

/** Render the stored positional model of one page: an SVG page box with positioned runs, boxes and images. */
export function PageCanvas(props: { render: PageRender; assets: Record<string, string> }) {
  const { w, h, items } = props.render;
  return (
    <div className="relative mx-auto mb-2" data-testid="reading-page-render" data-truncated={props.render.truncated ? "1" : undefined} style={{ maxWidth: "100%", background: "#ffffff", border: "1px solid var(--color-border)" }}>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ display: "block", width: "100%", height: "auto" }} role="img" aria-label="page">
        {items.map((item, index) => {
          if (item.k === "r") {
            if (item.c === "none") return null;
            return <rect key={index} x={item.x} y={h - item.y - item.h} width={item.w} height={item.h} fill={item.c} />;
          }
          if (item.k === "e") {
            if (item.c === "none") return null;
            return <ellipse key={index} cx={item.x + item.w / 2} cy={h - item.y - item.h / 2} rx={item.w / 2} ry={item.h / 2} fill={item.c} />;
          }
          if (item.k === "l") {
            const points = item.p.map((value, index2) => index2 % 2 === 0 ? value : h - value).join(",");
            return <polyline key={index} points={points} fill="none" stroke={item.c} strokeWidth={Math.max(item.w, 0.5)} />;
          }
          if (item.k === "i") {
            const url = item.a ? props.assets[item.a] : undefined;
            if (!url) return null;
            return <image key={index} href={url} x={item.x} y={h - item.y - item.h} width={item.w} height={item.h} preserveAspectRatio="none" />;
          }
          const perGlyph = item.gx && item.gx.length === item.t.length ? item.gx : undefined;
          return (
            <text
              key={index}
              // The model supplies every glyph's origin, so joined and split Tj sequences of the same
              // content draw identically regardless of the browser font's own metrics. The run's total
              // advance (from the same model) still scales the glyph inks to the laid-out width, which
              // keeps a horizontally squeezed run from spilling over the next run's origin.
              x={perGlyph ? perGlyph.join(" ") : item.x}
              y={h - item.y}
              fontSize={item.s}
              fontFamily={PAGE_FONTS[item.f] ?? PAGE_FONTS.sans}
              fill={item.c ?? "#111111"}
              textLength={item.w && item.w > 0 ? item.w : undefined}
              lengthAdjust={item.w && item.w > 0 ? "spacingAndGlyphs" : undefined}
              data-cp={item.o ?? undefined}
              data-testid={`page-run-${index}`}
            >{item.t}</text>
          );
        })}
      </svg>
      {props.render.truncated ? <p className="text-xs text-[var(--color-subtle)] p-1" data-testid="reading-page-truncated">页面元素过多，仅显示部分</p> : null}
    </div>
  );
}

function highlightQuote(text: string, sliceStart: number, highlight: { start: number; end: number } | null): string | null {
  if (!highlight || highlight.start < sliceStart) return null;
  const chars = [...text];
  const from = highlight.start - sliceStart;
  const to = highlight.end - sliceStart;
  if (from >= to || to > chars.length) return null;
  return chars.slice(from, to).join("");
}

function pageNumberOf(partId: string): number {
  const match = /^page-(\d+)$/.exec(partId);
  return match ? Number(match[1]) : 1;
}

type ReadingLabels = {
  empty: string;
  search: string;
  progress: string;
  note: string;
  missing: string;
  scan: string;
  more: string;
  image: string;
  imageFailed: string;
  restored: string;
  restoredStart: string;
  restoredOffset: string;
  rangeRead: string;
  rangeNone: string;
  bookmark: string;
  bookmarkAdd: string;
  bookmarkNone: string;
  bookmarkRemove: string;
  prev: string;
  next: string;
  part: string;
  hits: string;
  hitNone: string;
  jump: string;
  toc: string;
  source: string;
  sourceOpen: string;
  quote: string;
  images: string;
  selectForAgent: string;
  partSource: string;
  viewPage?: string;
  viewText?: string;
  [key: string]: string | undefined;
};

const SPREAD_GAP = 48;

/** True when a key press belongs to a text field, so reader shortcuts must not take it. */
function typingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function useViewportHeight(): number {
  const [height, setHeight] = useState(() => window.innerHeight || 800);
  useEffect(() => {
    const onResize = () => setHeight(window.innerHeight || 800);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return height;
}

export function ReadingPane(props: {
  document: ReadingDocument | null;
  style: ReadingStyle;
  labels: ReadingLabels;
  /** Strings of the reader chrome; the default is the app's Chinese catalog. */
  t?: Translator["t"];
  onBack?: () => void;
  onSearch: (text: string) => void;
  hits: Array<{ text: string; fragmentId?: string; locator?: { partId: string; range: { start: number; end: number } } }>;
  searched?: boolean;
  onJump: (partId: string, start: number, end: number) => void;
  onProgress: () => void;
  /** A picked passage. A reading page only reads: the shell turns the passage into a quote tag in the right pane's input. */
  onSelect: (quote: string, start: number, end: number, partId: string) => void;
  onMore: (partId: string, start: number) => void;
  onPart: (partId: string, start: number) => void;
  onStyle: (patch: Partial<ReadingStyle>) => void;
  bookmarks: Array<{ id: string; label: string; locator: { kind?: string; partId?: string; range?: { start: number; end: number } }; createdAt?: string }>;
  onBookmark: () => void;
  onRemoveBookmark: (bookmarkId: string) => void;
  onOpenBookmark: (bookmark: { locator: { kind?: string; partId?: string; range?: { start: number; end: number } } }) => void;
  assets: Record<string, string>;
  /** Authorized original of the current PDF revision. Absent bytes keep the stored text and a repair entry. */
  originalBytes?: Uint8Array | null;
  highlight: { start: number; end: number } | null;
  sourceCard: { status: string; title?: string; quote?: string; partTitle?: string; available?: boolean } | null;
  onBackToNote: () => void;
  onRepair: () => void;
  labelsExtra: { backToNote: string; sourceResolved: string; sourceNeedsReview: string; sourceMissing: string; sourceRepair: string; sourceCard: string };
}) {
  const t = props.t ?? createTranslator("zh-CN").t;
  const slice = props.document?.slice;
  const root = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ quote: string; start: number; end: number } | null>(null);
  const [partIndex, setPartIndex] = useState(0);
  const [view, setView] = useState<"page" | "text">("page");
  const [panel, setPanel] = useState<"toc" | "search" | "bookmarks" | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [spread, setSpread] = useState(0);
  const [spreads, setSpreads] = useState(1);
  const viewportHeight = useViewportHeight();
  const parts = props.document?.parts ?? [];
  const render = props.document?.format === "pdf" ? null : slice?.render ?? null;
  const pdf = props.document?.format === "pdf";
  const pdfBytes = pdf ? props.originalBytes ?? null : null;
  const pageView = pdf ? Boolean(pdfBytes) && view === "page" : Boolean(render) && view === "page";
  // The shell only forwards the book's author style while the reader keeps the built-in defaults.
  const authorStyle = props.style.theme === "white" ? props.document?.authorStyle ?? null : null;
  const double = (props.style.pageMode ?? "single") === "double" && !pageView;

  useEffect(() => {
    const changed = () => {
      if (pdf && pdfBytes && pageView) return;
      if (!body.current || !slice) { setSelection(null); return; }
      const current = window.getSelection();
      if (pageView && current && current.rangeCount === 1 && !current.isCollapsed) {
        const mapped = pageSelectionRange(current.getRangeAt(0));
        setSelection(mapped ? { quote: mapped.quote, start: mapped.start, end: mapped.end } : null);
        return;
      }
      setSelection(readingSelection(body.current, slice.start, current));
    };
    changed();
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, [slice, pageView, pdf, pdfBytes]);

  useEffect(() => {
    const index = parts.findIndex((part) => part.id === slice?.partId);
    if (index >= 0) setPartIndex(index);
  }, [slice?.partId, parts]);

  // A new part starts in the page view again. A PDF without its original stays on the stored text.
  useEffect(() => { setView(pdf && !pdfBytes ? "text" : "page"); }, [slice?.partId, pdf, pdfBytes]);
  useEffect(() => { if (props.highlight && !pdfBytes) setView("text"); }, [props.highlight, pdfBytes]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === root.current && root.current !== null);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const consumed = props.document?.readRanges ?? [];
  const restoredFrom = props.document?.progress?.restoredFrom;
  const restoredRange = props.document?.progress?.restoredRange ?? null;
  const currentPart = parts[partIndex];
  const measure = Math.max(0, props.style.measurePx - props.style.marginPx * 2);
  const marked = slice ? highlightSlices(slice.text, props.highlight, slice.start, slice.end) : null;
  const spacing = props.style.paragraphSpacingPx ?? 0;

  // A double page lays the window out in two fixed-height columns; a spread is one step of the column strip.
  const columnWidth = Math.max(120, Math.floor((measure - SPREAD_GAP) / 2));
  const pageHeight = (props.style.pageRatio ?? "book") === "book" ? Math.round(columnWidth * 4 / 3) : Math.max(360, viewportHeight - 360);
  const spreadKey = `${slice?.partId ?? ""}:${slice?.start ?? 0}`;
  useEffect(() => { setSpread(0); }, [spreadKey, double]);
  useLayoutEffect(() => {
    const node = body.current;
    if (!double || !node) { setSpreads(1); return; }
    const step = node.clientWidth + SPREAD_GAP;
    const count = step > 0 ? Math.max(1, Math.round((node.scrollWidth + SPREAD_GAP) / step)) : 1;
    setSpreads(count);
    node.scrollLeft = Math.min(spread, count - 1) * step;
  }, [double, spread, slice?.text, props.style.fontSizePx, props.style.lineHeight, props.style.measurePx, props.style.marginPx, spacing, pageHeight, props.style.fontFamily]);

  const partLength = currentPart?.length ?? 0;
  const atWindowEnd = !slice || slice.end >= partLength;
  const spreadForward = () => {
    if (!slice) return;
    if (spread < spreads - 1) { setSpread(spread + 1); return; }
    if (!atWindowEnd) { props.onMore(slice.partId, slice.end); return; }
    const next = parts[partIndex + 1];
    if (next) props.onPart(next.id, 0);
  };
  const spreadBack = () => {
    if (spread > 0) { setSpread(spread - 1); return; }
    const previous = parts[partIndex - 1];
    if (previous && (slice?.start ?? 0) === 0) props.onPart(previous.id, 0);
  };

  useEffect(() => {
    if (!double) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey || typingTarget(event.target)) return;
      if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") { event.preventDefault(); spreadForward(); }
      else if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); spreadBack(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // A passage the reader has picked and held for a moment becomes a tag; clearing the page selection (clicking into the input) keeps it.
  const onSelectRef = useRef(props.onSelect);
  onSelectRef.current = props.onSelect;
  const picked = selection && slice ? { ...selection, partId: slice.partId } : null;
  useEffect(() => {
    if (!picked) return;
    const timer = window.setTimeout(() => onSelectRef.current(picked.quote, picked.start, picked.end, picked.partId), 220);
    return () => window.clearTimeout(timer);
  }, [picked?.quote, picked?.start, picked?.end, picked?.partId]);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen?.().catch(() => setFullscreen(false));
  };

  const background = authorStyle?.background ?? THEME_BACKGROUND[props.style.theme] ?? THEME_BACKGROUND.white;
  const color = authorStyle?.color ?? THEME_FOREGROUND[props.style.theme] ?? THEME_FOREGROUND.white;
  const family = authorStyle?.fontFamily ?? fontStack(props.style.fontFamily);
  const textStyle: CSSProperties = {
    fontSize: props.style.fontSizePx,
    fontFamily: family,
    lineHeight: authorStyle?.lineHeight ?? props.style.lineHeight,
    textAlign: (authorStyle?.textAlign ?? "start") as CSSProperties["textAlign"],
  };

  const bodyContent = (() => {
    if (!slice) return "";
    const placements = slice.placements ?? [];
    if (spacing > 0) {
      const pieces = layoutParagraphs(slice.text, slice.start, marked ? props.highlight : null, placements);
      let firstMark = true;
      const image = (assetId: string, offset: number) => (
        <ReadingImage key={`img-${offset}-${assetId}`} asset={slice.images?.find((item) => item.id === assetId)} src={props.assets[assetId]} measure={measure} offset={offset} pending={props.labels.images} failed={props.labels.imageFailed} />
      );
      return pieces.map((piece, index) => {
        if (piece.kind === "separator") return <span key={`sep-${index}`} hidden>{piece.text}</span>;
        if (piece.kind === "image") return image(piece.assetId, piece.offset);
        return (
          <p key={`p-${piece.start}`} className="reader-paragraph" style={{ margin: `0 0 ${spacing}px`, whiteSpace: "pre-wrap" }}>
            {piece.parts.map((part, at) => {
              if (part.kind === "image") return image(part.assetId, part.offset);
              if (!part.marked) return <span key={at}>{part.text}</span>;
              const first = firstMark;
              firstMark = false;
              return <mark key={at} data-testid={first ? "reading-quote-hit" : "reading-quote-hit-more"}>{part.text}</mark>;
            })}
          </p>
        );
      });
    }
    if (marked) {
      return (
        <>
          {marked[0]}
          <mark data-testid="reading-quote-hit">{marked[1]}</mark>
          {marked[2]}
        </>
      );
    }
    if (placements.length > 0) {
      return readingSegments(slice.text, slice.start, placements).map((segment, index) => segment.kind === "text" ? (
        <span key={`text-${index}`}>{segment.text}</span>
      ) : (
        <ReadingImage key={segment.assetId} asset={slice.images?.find((item) => item.id === segment.assetId)} src={segment.assetId ? props.assets[segment.assetId] : undefined} measure={measure} offset={segment.offset} pending={props.labels.images} failed={props.labels.imageFailed} />
      ));
    }
    return slice.text;
  })();

  // Bring the jump target into view without changing the stored read range. In a double page the strip moves to its column.
  useEffect(() => {
    if (!props.highlight || !body.current) return;
    const node = body.current;
    const target = node.querySelector<HTMLElement>("[data-testid='reading-quote-hit']");
    if (!target) return;
    if (double) {
      const step = node.clientWidth + SPREAD_GAP;
      if (step > 0) setSpread(Math.max(0, Math.floor((target.offsetLeft - node.offsetLeft) / step)));
    } else target.scrollIntoView({ block: "center" });
  }, [props.highlight, double]);

  return (
    <section ref={root} className="reader" data-testid="reading-page" data-theme={props.style.theme} data-fullscreen={fullscreen || undefined}>
      <header className="reader-top">
        {props.onBack ? <button type="button" className="icon-button" data-testid="reading-back" aria-label={t("common.back")} title={t("common.back")} onClick={props.onBack}><ArrowLeft size={18} /></button> : null}
        {props.document ? (
          <div className="reader-heading">
            <h1 className="truncate" data-testid="reading-title">{props.document.title}</h1>
            <span className="chip">{t("shelf.kind.novel")}</span>
            {currentPart?.title ? <span className="reader-chapter truncate">{currentPart.title}</span> : null}
          </div>
        ) : null}
        <span className="flex-1" />
        <div className="reader-tools">
          <button type="button" className="icon-button" data-testid="reading-panel-toc" aria-pressed={panel === "toc"} aria-label={t("reading.toc")} title={t("reading.toc")} onClick={() => setPanel(panel === "toc" ? null : "toc")}><List size={18} /></button>
          <button type="button" className="icon-button" data-testid="reading-panel-search" aria-pressed={panel === "search"} aria-label={props.labels.search} title={props.labels.search} onClick={() => setPanel(panel === "search" ? null : "search")}><Search size={18} /></button>
          <button type="button" className="icon-button" data-testid="reading-panel-bookmarks" aria-pressed={panel === "bookmarks"} aria-label={props.labels.bookmark} title={props.labels.bookmark} onClick={() => setPanel(panel === "bookmarks" ? null : "bookmarks")}><Bookmark size={18} /></button>
          <button type="button" className="icon-button" data-testid="reading-bookmark-add" aria-label={props.labels.bookmarkAdd} title={props.labels.bookmarkAdd} onClick={props.onBookmark} disabled={!slice}><BookmarkPlus size={18} /></button>
        </div>
      </header>
      <ReaderToolbar t={t} style={props.style} onStyle={props.onStyle} canDouble={!pageView} fullscreen={fullscreen} onFullscreen={toggleFullscreen} />

      {panel ? (
        <aside className="reader-panel" data-testid="reading-panel">
          {panel === "toc" ? (
            <nav className="reader-toc" aria-label={props.labels.toc}>
              {(props.document?.toc ?? []).length === 0 ? <p className="detail-muted">{props.labels.empty}</p> : null}
              {(props.document?.toc ?? []).map((item) => <button key={`${item.partId}-${item.label}`} type="button" className="link-button" data-testid={`toc-${item.partId}`} onClick={() => props.onMore(item.partId, 0)}>{item.label}</button>)}
            </nav>
          ) : null}
          {panel === "search" ? (
            <div>
              <form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); props.onSearch(String(data.get("q") ?? "")); }}>
                <Input name="q" className="w-full" aria-label={props.labels.search} placeholder={props.labels.search} data-testid="reading-search" />
              </form>
              {(props.hits?.length ?? 0) > 0 ? (
                <section className="text-sm mt-2" data-testid="reading-hits">
                  <h2 className="font-medium">{props.labels.hits}</h2>
                  <ul>
                    {props.hits.map((hit, index) => (
                      <li key={hit.fragmentId ?? `${index}-${hit.text.slice(0, 12)}`} className="flex gap-2 items-center">
                        <span className="truncate">{hit.text.slice(0, 60)}</span>
                        {hit.locator ? <button type="button" className="link-button" data-testid={`reading-hit-${index}`} onClick={() => props.onJump(hit.locator!.partId, hit.locator!.range.start, hit.locator!.range.end)}>{props.labels.jump}</button> : null}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : props.searched ? <p className="text-sm mt-2" data-testid="reading-hit-none">{props.labels.hitNone}</p> : null}
            </div>
          ) : null}
          {panel === "bookmarks" ? (
            <section className="text-sm" data-testid="reading-bookmarks">
              {props.bookmarks.length === 0 ? <p className="detail-muted">{props.labels.bookmarkNone}</p> : null}
              <ul className="flex flex-col gap-1">
                {props.bookmarks.map((bookmark) => (
                  <li key={bookmark.id} className="flex gap-2 items-center">
                    <button type="button" className="link-button" data-testid={`reading-bookmark-${bookmark.id}`} onClick={() => props.onOpenBookmark(bookmark)}>{bookmark.label}</button>
                    <button type="button" className="link-button" data-testid={`reading-bookmark-remove-${bookmark.id}`} onClick={() => props.onRemoveBookmark(bookmark.id)}>{props.labels.bookmarkRemove}</button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </aside>
      ) : null}

      <div className="reader-scroll">
        {!props.document ? <p>{props.labels.empty}</p> : (
          <article>
            {props.sourceCard ? (
              <section className="border border-[var(--color-border)] rounded p-2 mb-3 text-sm" data-testid="reading-source-card" data-source-status={props.sourceCard.status}>
                <h2 className="font-medium">{props.labelsExtra.sourceCard}</h2>
                <p data-testid="reading-source-status">
                  {props.sourceCard.status === "resolved" ? props.labelsExtra.sourceResolved
                    : props.sourceCard.status === "needs_review" ? props.labelsExtra.sourceNeedsReview
                      : props.sourceCard.status === "missing_capability" ? props.labels.scan
                        : props.labelsExtra.sourceMissing}
                </p>
                {props.sourceCard.title ? <p>{props.sourceCard.title}{props.sourceCard.partTitle ? ` · ${props.sourceCard.partTitle}` : ""}</p> : null}
                {props.sourceCard.quote ? <blockquote className="border-l-2 pl-2 my-1" data-testid="reading-source-quote">{props.sourceCard.quote}</blockquote> : null}
                <div className="flex gap-2 mt-1">
                  <button type="button" className="border px-2 py-0.5 rounded" data-testid="reading-source-back" onClick={props.onBackToNote}>{props.labelsExtra.backToNote}</button>
                  {props.sourceCard.available === false || props.sourceCard.status !== "resolved" ? (
                    <button type="button" className="border px-2 py-0.5 rounded" data-testid="reading-source-repair" onClick={props.onRepair}>{props.labelsExtra.sourceRepair}</button>
                  ) : null}
                </div>
              </section>
            ) : null}
            {props.document.source.available === false ? <p role="status" data-testid="reading-missing">{props.labels.missing}</p> : null}
            {(props.document.warnings ?? []).map((warning) => <p key={warning} className="text-sm text-[var(--color-subtle)]">{warning}</p>)}
            <p className="text-sm text-[var(--color-subtle)] mb-2" data-testid="reading-restore-status" data-restored={restoredFrom ?? "start"} data-offset={String(restoredRange?.start ?? 0)}>
              {restoredFrom === "progress" ? props.labels.restored : props.labels.restoredStart}
              {restoredFrom === "progress" && restoredRange ? ` · ${props.labels.restoredOffset.replace("{offset}", String(restoredRange.start))}` : ""}
              {" · "}{consumed.length ? props.labels.rangeRead.replace("{count}", String(consumed.length)) : props.labels.rangeNone}
            </p>
            {currentPart?.sourceHref ? <p className="text-sm text-[var(--color-subtle)] mb-2" data-testid="reading-part-source">{props.labels.partSource.replace("{href}", currentPart.sourceHref)}</p> : null}

            {slice && !slice.textLayer && !pageView ? <p data-testid="reading-scan">{slice.kind === "image" ? props.labels.image : props.labels.scan}</p> : null}
            <div className="flex gap-2 items-center mb-1 text-sm">
              <button type="button" className="border px-2 py-1 rounded" data-testid="reading-prev" disabled={double ? partIndex <= 0 && spread <= 0 : partIndex <= 0} onClick={() => { if (double) { spreadBack(); return; } const previous = parts[partIndex - 1]; if (previous) props.onPart(previous.id, 0); }}>{props.labels.prev}</button>
              <span data-testid="reading-part-position">{props.labels.part.replace("{index}", String(partIndex + 1)).replace("{total}", String(parts.length))}</span>
              <button type="button" className="border px-2 py-1 rounded" data-testid="reading-next" disabled={double ? partIndex >= parts.length - 1 && atWindowEnd && spread >= spreads - 1 : partIndex >= parts.length - 1} onClick={() => { if (double) { spreadForward(); return; } const next = parts[partIndex + 1]; if (next) props.onPart(next.id, 0); }}>{props.labels.next}</button>
              {render || pdfBytes ? (
                <button type="button" className="border px-2 py-1 rounded" data-testid="reading-view-toggle" onClick={() => setView(pageView ? "text" : "page")}>
                  {pageView ? props.labels.viewText ?? "文本视图" : props.labels.viewPage ?? "页面视图"}
                </button>
              ) : null}
            </div>
            {pdf && !pdfBytes ? <p role="status" data-testid="reading-original-missing">{props.labelsExtra.sourceMissing} <button type="button" className="underline" data-testid="reading-original-repair" onClick={props.onRepair}>{props.labelsExtra.sourceRepair}</button></p> : null}
            {pageView && pdfBytes && slice ? (
              <PdfPageView
                bytes={pdfBytes}
                pageNumber={pageNumberOf(slice.partId)}
                storedText={slice.text}
                sliceStart={slice.start}
                highlight={props.highlight}
                highlightQuote={highlightQuote(slice.text, slice.start, props.highlight)}
                scanLabel={props.labels.scan}
                missingLabel={props.labelsExtra.sourceNeedsReview}
                onSelection={(next) => setSelection(next)}
              />
            ) : null}
            {pageView && render ? <PageCanvas render={render} assets={props.assets} /> : null}

            {double ? (
              <div className="reader-spread" data-testid="reading-spread" style={{ maxWidth: props.style.measurePx, padding: `12px ${props.style.marginPx}px`, background, color }} hidden={pageView || undefined}>
                <div className="reader-spread-head">{props.document.title}{currentPart?.title ? ` · ${currentPart.title}` : ""}</div>
                <div
                  ref={body}
                  data-testid="reading-body"
                  data-normalization={NORMALIZATION_V1}
                  data-part-id={slice?.partId}
                  data-view="text"
                  data-layout="double"
                  className="reader-columns whitespace-pre-wrap"
                  style={{ ...textStyle, columnCount: 2, columnGap: SPREAD_GAP, height: pageHeight, overflow: "hidden" }}
                >{bodyContent}</div>
                <div className="reader-spread-foot" data-testid="reading-spread-position">{t("reader.spreadPosition", { from: spread * 2 + 1, to: spread * 2 + 2, spreads })}</div>
              </div>
            ) : (
              <div
                ref={body}
                hidden={pageView || undefined}
                data-testid="reading-body"
                data-normalization={NORMALIZATION_V1}
                data-part-id={slice?.partId}
                data-view={pageView ? "page" : "text"}
                className="mx-auto whitespace-pre-wrap reader-text"
                style={{ ...textStyle, maxWidth: props.style.measurePx, padding: `0 ${props.style.marginPx}px`, background, color }}
              >{bodyContent}</div>
            )}
            {!pageView && slice && slice.kind === "image" && (slice.images?.length ?? 0) === 0 ? <p role="status" data-testid="reading-image-failed">{props.labels.imageFailed}</p> : null}
            {(slice?.images?.length ?? 0) > 0 && (slice?.placements?.length ?? 0) === 0 ? (
              <ul className="mt-2 flex flex-wrap gap-2" data-testid="reading-images">
                {slice!.images!.map((asset) => (
                  <li key={asset.id}>
                    <ReadingImage asset={asset} src={props.assets[asset.id]} measure={measure} pending={props.labels.images} failed={props.labels.imageFailed} />
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex gap-2 mt-3 flex-wrap">
              <button type="button" className="border px-2 py-1 rounded" data-testid="reading-more" onClick={() => slice && props.onMore(slice.partId, slice.end)}>{props.labels.more}</button>
              <button type="button" className="border px-2 py-1 rounded" data-testid="reading-progress" onClick={props.onProgress}>{props.labels.progress}</button>
              {selection ? <span className="text-sm text-[var(--color-subtle)]" data-testid="reading-selected">{props.labels.quote}：{selection.quote.slice(0, 40)}</span> : null}
            </div>
          </article>
        )}
      </div>
    </section>
  );
}
