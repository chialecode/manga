import { NORMALIZATION_V1 } from "@manga/contracts/location";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Button } from "./components/ui/button.tsx";
import { Input } from "./components/ui/input.tsx";
import { PdfPageView } from "./pdf-page.tsx";

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

export type ReadingStyle = { measurePx: number; fontSizePx: number; fontFamily?: "sans" | "serif" | "mono"; lineHeight: number; marginPx: number; theme: string };

const READER_FONTS = {
  sans: '"Microsoft YaHei", system-ui, sans-serif',
  serif: 'SimSun, "Noto Serif CJK SC", serif',
  mono: 'Consolas, "Microsoft YaHei", monospace',
};

const THEME_BACKGROUND: Record<string, string> = {
  white: "#ffffff",
  green: "#e6f0e0",
  paper: "#f6edd2",
  night: "#1c1f24",
};
const THEME_FOREGROUND: Record<string, string> = {
  white: "#1a1a1a",
  green: "#1f2a1c",
  paper: "#33291a",
  night: "#e6e6e6",
};

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

export function ReadingPane(props: {
  resources: Array<{ id: string; title: string }>;
  document: ReadingDocument | null;
  style: ReadingStyle;
  /** Whole-library totals from the server, so rows past the first page stay reachable. */
  resourceTotal?: number | null;
  resourceNextCursor?: string | null;
  resourceQuery?: string;
  onMoreResources?: () => void;
  onSearchResources?: (query: string) => void;
  labels: {
    importBook: string;
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
    style: string;
    fontSize: string;
    fontFamily: string;
    fontSans: string;
    fontSerif: string;
    fontMono: string;
    lineHeight: string;
    margin: string;
    measure: string;
    themeWhite: string;
    themeGreen: string;
    themePaper: string;
    themeNight: string;
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
    resourceTotal?: string;
    resourceLoadMore?: string;
    resourceSearch?: string;
    resourceSearchAction?: string;
    viewPage?: string;
    viewText?: string;
  };
  onImportBook: () => void;
  onOpen: (resourceId: string) => void;
  onSearch: (text: string) => void;
  hits: Array<{ text: string; fragmentId?: string; locator?: { partId: string; range: { start: number; end: number } } }>;
  searched?: boolean;
  onJump: (partId: string, start: number, end: number) => void;
  onProgress: () => void;
  onNote: (quote: string, start: number, end: number, partId: string) => void;
  onSelectForAgent?: (quote: string, start: number, end: number, partId: string) => void;
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
  const slice = props.document?.slice;
  const body = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ quote: string; start: number; end: number } | null>(null);
  const [partIndex, setPartIndex] = useState(0);
  const [view, setView] = useState<"page" | "text">("page");
  const parts = props.document?.parts ?? [];
  const render = props.document?.format === "pdf" ? null : slice?.render ?? null;
  const pdf = props.document?.format === "pdf";
  const pdfBytes = pdf ? props.originalBytes ?? null : null;
  const pageView = pdf ? Boolean(pdfBytes) && view === "page" : Boolean(render) && view === "page";
  // The shell only forwards the book's author style while the reader keeps the built-in defaults.
  const authorStyle = props.style.theme === "white" ? props.document?.authorStyle ?? null : null;

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

  // Bring the jump target into view without changing the stored read range.
  useEffect(() => {
    if (!props.highlight || !body.current) return;
    const node = body.current;
    const target = node.querySelector("[data-testid='reading-quote-hit']");
    target?.scrollIntoView({ block: "center" });
  }, [props.highlight]);

  const consumed = props.document?.readRanges ?? [];
  const restoredFrom = props.document?.progress?.restoredFrom;
  const restoredRange = props.document?.progress?.restoredRange ?? null;
  const currentPart = parts[partIndex];
  const measure = Math.max(0, props.style.measurePx - props.style.marginPx * 2);
  const marked = slice ? highlightSlices(slice.text, props.highlight, slice.start, slice.end) : null;
  const hasSelection = Boolean(selection);

  const selectedNow = () => {
    if (pdfBytes && pageView) return selection;
    return body.current && slice ? readingSelection(body.current, slice.start, window.getSelection()) ?? selection : selection;
  };

  return (
    <section className="p-4 h-full overflow-auto" data-testid="reading-page">
      <div className="flex gap-2 mb-3 flex-wrap">
        <Button type="button" className="bg-[var(--color-accent)] text-white px-3 py-1 rounded" data-testid="import-book" onClick={props.onImportBook}>{props.labels.importBook}</Button>
      </div>
      <ul className="flex flex-wrap gap-2 mb-1 text-sm">
        {props.resources.map((resource) => (
          <li key={resource.id}><button type="button" className="border px-2 py-1 rounded" data-testid={`open-${resource.id}`} onClick={() => props.onOpen(resource.id)}>{resource.title}</button></li>
        ))}
      </ul>
      <div className="flex gap-2 items-center mb-3 flex-wrap text-sm">
        {typeof props.resourceTotal === "number" ? <span className="text-[var(--color-subtle)]" data-testid="reading-resource-total">{(props.labels.resourceTotal ?? "全库共 {count} 本").replace("{count}", String(props.resourceTotal))}</span> : null}
        {props.onSearchResources ? (
          <form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); props.onSearchResources?.(String(data.get("rq") ?? "")); }}>
            <Input key={props.resourceQuery ?? ""} defaultValue={props.resourceQuery ?? ""} name="rq" className="w-44" aria-label={props.labels.resourceSearch ?? "全库搜索书名"} data-testid="reading-resource-filter" />
            <button type="submit" className="border px-2 py-1 rounded ml-1" data-testid="reading-resource-filter-run">{props.labels.resourceSearchAction ?? "搜索"}</button>
          </form>
        ) : null}
        {props.resourceNextCursor && props.onMoreResources ? (
          <button type="button" className="border px-2 py-1 rounded" data-testid="reading-resources-more" onClick={props.onMoreResources}>{props.labels.resourceLoadMore ?? "加载更早的书"}</button>
        ) : null}
      </div>
      {!props.document ? <p>{props.labels.empty}</p> : (
        <article>
          <h1 className="text-lg mb-2 truncate" data-testid="reading-title">{props.document.title}</h1>
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
          <nav className="text-sm mb-2 flex flex-wrap gap-2" aria-label={props.labels.toc}>
            {props.document.toc.map((item) => <button key={`${item.partId}-${item.label}`} type="button" className="underline" data-testid={`toc-${item.partId}`} onClick={() => props.onMore(item.partId, 0)}>{item.label}</button>)}
          </nav>

          <section className="border border-[var(--color-border)] rounded p-2 mb-2 text-sm" data-testid="reading-style">
            <h2 className="font-medium mb-1">{props.labels.style}</h2>
            <div className="flex flex-wrap gap-3 items-center">
              <label className="flex items-center gap-1">{props.labels.fontFamily}
                <select data-testid="reading-font-family" value={props.style.fontFamily ?? "sans"} onChange={(event) => props.onStyle({ fontFamily: event.target.value as "sans" | "serif" | "mono" })}>
                  <option value="sans">{props.labels.fontSans}</option>
                  <option value="serif">{props.labels.fontSerif}</option>
                  <option value="mono">{props.labels.fontMono}</option>
                </select>
              </label>
              <label className="flex items-center gap-1">{props.labels.fontSize}
                <input type="range" min={14} max={32} value={props.style.fontSizePx} data-testid="reading-font-size" onChange={(event) => props.onStyle({ fontSizePx: Number(event.target.value) })} />
                <span data-testid="reading-font-size-value">{props.style.fontSizePx}</span>
              </label>
              <label className="flex items-center gap-1">{props.labels.lineHeight}
                <input type="range" min={120} max={240} value={Math.round(props.style.lineHeight * 100)} data-testid="reading-line-height" onChange={(event) => props.onStyle({ lineHeight: Number(event.target.value) / 100 })} />
                <span data-testid="reading-line-height-value">{props.style.lineHeight.toFixed(2)}</span>
              </label>
              <label className="flex items-center gap-1">{props.labels.margin}
                <input type="range" min={0} max={96} value={props.style.marginPx} data-testid="reading-margin" onChange={(event) => props.onStyle({ marginPx: Number(event.target.value) })} />
                <span data-testid="reading-margin-value">{props.style.marginPx}</span>
              </label>
              <label className="flex items-center gap-1">{props.labels.measure}
                <input type="range" min={320} max={960} value={props.style.measurePx} data-testid="reading-measure" onChange={(event) => props.onStyle({ measurePx: Number(event.target.value) })} />
                <span data-testid="reading-measure-value">{props.style.measurePx}</span>
              </label>
              <div className="flex gap-1" role="group" aria-label={props.labels.style}>
                {(["white", "green", "paper", "night"] as const).map((theme) => (
                  <button
                    key={theme}
                    type="button"
                    className="border px-2 py-0.5 rounded"
                    data-testid={`reading-theme-${theme}`}
                    data-current={props.style.theme === theme}
                    onClick={() => props.onStyle({ theme })}
                  >
                    {theme === "white" ? props.labels.themeWhite : theme === "green" ? props.labels.themeGreen : theme === "paper" ? props.labels.themePaper : props.labels.themeNight}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <form className="mb-2" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); props.onSearch(String(data.get("q") ?? "")); }}>
            <Input name="q" className="w-44" aria-label={props.labels.search} data-testid="reading-search" />
          </form>
          {(props.hits?.length ?? 0) > 0 ? (
            <section className="text-sm mb-2" data-testid="reading-hits">
              <h2 className="font-medium">{props.labels.hits}</h2>
              <ul>
                {props.hits.map((hit, index) => (
                  <li key={hit.fragmentId ?? `${index}-${hit.text.slice(0, 12)}`} className="flex gap-2 items-center">
                    <span className="truncate">{hit.text.slice(0, 60)}</span>
                    {hit.locator ? <button type="button" className="border px-2 py-0.5 rounded" data-testid={`reading-hit-${index}`} onClick={() => props.onJump(hit.locator!.partId, hit.locator!.range.start, hit.locator!.range.end)}>{props.labels.jump}</button> : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : props.searched ? <p className="text-sm mb-2" data-testid="reading-hit-none">{props.labels.hitNone}</p> : null}

          <section className="text-sm mb-2" data-testid="reading-bookmarks">
            <h2 className="font-medium">{props.labels.bookmark}</h2>
            <div className="flex gap-2 items-center flex-wrap">
              <button type="button" className="border px-2 py-0.5 rounded" data-testid="reading-bookmark-add" onClick={props.onBookmark} disabled={!slice}>{props.labels.bookmarkAdd}</button>
              {props.bookmarks.length === 0 ? <span className="text-[var(--color-subtle)]">{props.labels.bookmarkNone}</span> : null}
            </div>
            <ul className="flex flex-wrap gap-2">
              {props.bookmarks.map((bookmark) => (
                <li key={bookmark.id} className="flex gap-1 items-center">
                  <button type="button" className="underline" data-testid={`reading-bookmark-${bookmark.id}`} onClick={() => props.onOpenBookmark(bookmark)}>{bookmark.label}</button>
                  <button type="button" className="border px-1 rounded" data-testid={`reading-bookmark-remove-${bookmark.id}`} onClick={() => props.onRemoveBookmark(bookmark.id)}>{props.labels.bookmarkRemove}</button>
                </li>
              ))}
            </ul>
          </section>

          {slice && !slice.textLayer && !pageView ? <p data-testid="reading-scan">{slice.kind === "image" ? props.labels.image : props.labels.scan}</p> : null}
          <div className="flex gap-2 items-center mb-1 text-sm">
            <button type="button" className="border px-2 py-1 rounded" data-testid="reading-prev" disabled={partIndex <= 0} onClick={() => { const previous = parts[partIndex - 1]; if (previous) props.onPart(previous.id, 0); }}>{props.labels.prev}</button>
            <span data-testid="reading-part-position">{props.labels.part.replace("{index}", String(partIndex + 1)).replace("{total}", String(parts.length))}</span>
            <button type="button" className="border px-2 py-1 rounded" data-testid="reading-next" disabled={partIndex >= parts.length - 1} onClick={() => { const next = parts[partIndex + 1]; if (next) props.onPart(next.id, 0); }}>{props.labels.next}</button>
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
          <div
            ref={body}
            hidden={pageView || undefined}
            data-testid="reading-body"
            data-normalization={NORMALIZATION_V1}
            data-part-id={slice?.partId}
            data-view={pageView ? "page" : "text"}
            className="mx-auto whitespace-pre-wrap"
            style={{
              maxWidth: props.style.measurePx,
              fontSize: props.style.fontSizePx,
              fontFamily: authorStyle?.fontFamily ?? READER_FONTS[props.style.fontFamily ?? "sans"],
              lineHeight: authorStyle?.lineHeight ?? props.style.lineHeight,
              textAlign: (authorStyle?.textAlign ?? "start") as CSSProperties["textAlign"],
              padding: `0 ${props.style.marginPx}px`,
              background: authorStyle?.background ?? THEME_BACKGROUND[props.style.theme] ?? THEME_BACKGROUND.white,
              color: authorStyle?.color ?? THEME_FOREGROUND[props.style.theme] ?? THEME_FOREGROUND.white,
            }}
          >
            {marked ? (
              <>
                {marked[0]}
                <mark data-testid="reading-quote-hit">{marked[1]}</mark>
                {marked[2]}
              </>
            ) : slice && (slice.placements?.length ?? 0) > 0 ? (
              readingSegments(slice.text, slice.start, slice.placements ?? []).map((segment, index) => segment.kind === "text" ? (
                <span key={`text-${index}`}>{segment.text}</span>
              ) : (
                <ReadingImage key={segment.assetId} asset={slice.images?.find((item) => item.id === segment.assetId)} src={segment.assetId ? props.assets[segment.assetId] : undefined} measure={measure} offset={segment.offset} pending={props.labels.images} failed={props.labels.imageFailed} />
              ))
            ) : slice?.text ?? ""}
          </div>
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
            <button
              type="button"
              className="border px-2 py-1 rounded"
              data-testid="reading-note"
              disabled={!hasSelection}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                const selected = selectedNow();
                if (selected && slice) props.onNote(selected.quote, selected.start, selected.end, slice.partId);
              }}
            >{props.labels.note}</button>
            {props.onSelectForAgent ? (
              <button
                type="button"
                className="border px-2 py-1 rounded"
                data-testid="reading-select-agent"
                disabled={!hasSelection}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  const selected = selectedNow();
                  if (selected && slice) props.onSelectForAgent?.(selected.quote, selected.start, selected.end, slice.partId);
                }}
              >{props.labels.selectForAgent}</button>
            ) : null}
            {selection ? <span className="text-sm text-[var(--color-subtle)]" data-testid="reading-selected">{props.labels.quote}：{selection.quote.slice(0, 40)}</span> : null}
          </div>        </article>
      )}
    </section>
  );
}
