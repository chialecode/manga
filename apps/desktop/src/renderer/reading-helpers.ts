import type { ReaderStyle } from "./reader/settings-panel.tsx";

export type ReadingAsset = { id: string; partId: string; name: string; mediaType: string; bytes: number };

export type ReadingSegment =
  | { kind: "text"; text: string; start: number; end: number }
  | { kind: "image"; assetId: string; offset: number };

/** Positioned page model (PDF vector pages, EPUB fixed pages): user-space box, y up, baseline runs. */
export type PageRenderItem =
  | { k: "t"; x: number; y: number; s: number; f: string; t: string; c?: string; o?: number; w?: number; gx?: number[] }
  | { k: "r"; x: number; y: number; w: number; h: number; c: string }
  | { k: "e"; x: number; y: number; w: number; h: number; c: string }
  | { k: "l"; p: number[]; c: string; w: number }
  | { k: "i"; x: number; y: number; w: number; h: number; a?: string };
export type PageRender = { w: number; h: number; items: PageRenderItem[]; truncated?: boolean };

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

export type ReadingLabels = {
  empty: string;
  search: string;
  progress: string;
  note: string;
  missing: string;
  scan: string;
  more: string;
  image: string;
  imageFailed: string;
  bookmark: string;
  bookmarkAdd: string;
  bookmarkNone: string;
  bookmarkRemove: string;
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
  viewPage?: string;
  viewText?: string;
  [key: string]: string | undefined;
};

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
export function utf16Offset(text: string, codePointOffset: number): number {
  let count = 0;
  let index = 0;
  for (const char of text) {
    if (count >= codePointOffset) break;
    count += 1;
    index += char.length;
  }
  return index;
}

/** Split a text window so an illustration stays at its recorded code-point offset. */
export function readingSegments(text: string, sliceStart: number, placements: Array<{ assetId: string; offset: number }>): ReadingSegment[] {
  const totalCp = [...text].length;
  const ordered = [...placements].filter((item) => item.offset >= sliceStart && item.offset <= sliceStart + totalCp).sort((left, right) => left.offset - right.offset);
  const segments: ReadingSegment[] = [];
  let cursor = 0;
  let cpCursor = sliceStart;
  for (const placement of ordered) {
    const at = utf16Offset(text, placement.offset - sliceStart);
    if (at > cursor) segments.push({ kind: "text", text: text.slice(cursor, at), start: cpCursor, end: placement.offset });
    segments.push({ kind: "image", assetId: placement.assetId, offset: placement.offset });
    cursor = at;
    cpCursor = placement.offset;
  }
  if (cursor < text.length) segments.push({ kind: "text", text: text.slice(cursor), start: cpCursor, end: sliceStart + totalCp });
  if (!segments.length) segments.push({ kind: "text", text, start: sliceStart, end: sliceStart + totalCp });
  return segments;
}

export function highlightSlices(text: string, highlight: { start: number; end: number } | null, sliceStart: number, sliceEnd: number): [string, string, string] | null {
  if (!highlight || highlight.start < sliceStart || highlight.end > sliceEnd) return null;
  const from = utf16Offset(text, highlight.start - sliceStart);
  const to = utf16Offset(text, highlight.end - sliceStart);
  if (from >= to) return null;
  return [text.slice(0, from), text.slice(from, to), text.slice(to)];
}

/** Split a text segment into up to three parts when an active highlight overlaps it. */
export function sliceSegmentHighlight(
  text: string,
  segStart: number,
  segEnd: number,
  highlight: { start: number; end: number } | null,
): [string, string, string] | null {
  if (!highlight || highlight.end <= segStart || highlight.start >= segEnd) return null;
  const fromCp = Math.max(highlight.start, segStart) - segStart;
  const toCp = Math.min(highlight.end, segEnd) - segStart;
  if (fromCp >= toCp) return null;
  const from = utf16Offset(text, fromCp);
  const to = utf16Offset(text, toCp);
  if (from >= to) return null;
  return [text.slice(0, from), text.slice(from, to), text.slice(to)];
}

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

export function highlightQuote(text: string, sliceStart: number, highlight: { start: number; end: number } | null): string | null {
  if (!highlight || highlight.start < sliceStart) return null;
  const chars = [...text];
  const from = highlight.start - sliceStart;
  const to = highlight.end - sliceStart;
  if (from >= to || to > chars.length) return null;
  return chars.slice(from, to).join("");
}

export function pageNumberOf(partId: string): number {
  const match = /^page-(\d+)$/.exec(partId);
  return match ? Number(match[1]) : 1;
}
