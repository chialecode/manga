import { EXCERPT_TEXT_LIMIT, RESEARCH_SCOPES, type ResearchScope } from "@manga/contracts/research";

export { EXCERPT_TEXT_LIMIT, RESEARCH_SCOPES };
export type { ResearchScope };

export type PageSummary = {
  id: string; url: string; title: string; fetchedAt: string; contentHash: string; version: number; previousId: string | null; chars: number; excerpts: number; latest: boolean;
};
export type PageVersion = { id: string; version: number; fetchedAt: string; contentHash: string; chars: number; current: boolean };
export type ExcerptItem = {
  id: string; projectId: string | null; pageId: string; url: string; pageTitle: string; title: string; text: string; start: number; end: number; note: string;
  createdAt: string; fetchedAt: string; version: number; newerVersion: { id: string; version: number; fetchedAt: string } | null;
};
export type PageDoc = { page: PageSummary; text: string; versions: PageVersion[]; excerpts: ExcerptItem[] };
export type FetchOutcome = { page: PageSummary; created: boolean; changed: boolean; previousId: string | null };
export type ResultItem = {
  kind: ResearchScope; id: string; title: string; snippet: string; at: string | null; inProject: boolean;
  workId?: string; resourceId?: string; mediaKind?: string; startMs?: number; url?: string; start?: number;
};

export type Range = { start: number; end: number };
export type Mark = { id: string; start: number; end: number; title: string };
export type Segment = { start: number; end: number; text: string; marks: Mark[] };

/** The address a person reads: the host, without `www.`. */
export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

/**
 * The page text cut at the start and end of every excerpt, so each piece can be drawn on its own and a piece knows which excerpts cover it.
 * Excerpts may overlap; the cuts are the union of their edges.
 */
export function segmentsOf(text: string, marks: Mark[]): Segment[] {
  const cuts = new Set<number>([0, text.length]);
  for (const mark of marks) { cuts.add(Math.max(0, Math.min(text.length, mark.start))); cuts.add(Math.max(0, Math.min(text.length, mark.end))); }
  const points = [...cuts].sort((a, b) => a - b);
  const segments: Segment[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const start = points[i]!;
    const end = points[i + 1]!;
    if (end <= start) continue;
    segments.push({ start, end, text: text.slice(start, end), marks: marks.filter((mark) => mark.start <= start && mark.end >= end) });
  }
  return segments;
}

/** The text offset of one point of a selection, given the body that holds the pieces (each text node sits directly in an element that says where it starts). */
function pointOffset(root: HTMLElement, node: Node, offset: number): number | null {
  if (node !== root && !root.contains(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) {
    const holder = node.parentElement;
    const start = holder?.dataset.start;
    return start === undefined ? null : Number(start) + offset;
  }
  const pieces = [...root.querySelectorAll<HTMLElement>("[data-start]")].filter((piece) => node === piece || node.contains(piece));
  if (!pieces.length) return node === root ? 0 : null;
  const child = node.childNodes[offset];
  if (child) {
    const first = child instanceof HTMLElement && child.dataset.start !== undefined ? child : child.nodeType === Node.ELEMENT_NODE ? (child as HTMLElement).querySelector<HTMLElement>("[data-start]") : null;
    if (first) return Number(first.dataset.start);
    // A text node between pieces (a line break the page drew itself) belongs to the next piece.
    const next = pieces.find((piece) => (child.compareDocumentPosition(piece) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
    return next ? Number(next.dataset.start) : null;
  }
  const last = pieces[pieces.length - 1]!;
  return Number(last.dataset.start) + (last.textContent?.length ?? 0);
}

/** The part of the page the selection covers, or null when nothing inside the body is selected. */
export function selectedRange(root: HTMLElement, selection: Selection | null): Range | null {
  if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return null;
  const a = pointOffset(root, selection.anchorNode, selection.anchorOffset);
  const b = pointOffset(root, selection.focusNode, selection.focusOffset);
  if (a === null || b === null) return null;
  const start = Math.min(a, b);
  const end = Math.max(a, b);
  return end > start ? { start, end } : null;
}

/** Whether the selection started or ended inside the body (so a click into a form field, which moves the selection away, can be told from a click in the text). */
export function selectionTouches(root: HTMLElement, selection: Selection | null): boolean {
  if (!selection || !selection.anchorNode) return false;
  return root.contains(selection.anchorNode) || (selection.focusNode ? root.contains(selection.focusNode) : false);
}

/** The words of an error that says why a page could not be fetched, from the reason the broker gave. */
export function fetchReason(error: { details?: unknown; message: string }): { key: string; params: Record<string, string | number> } | null {
  const details = (error.details ?? {}) as { reason?: string; status?: number };
  if (!details.reason) return null;
  return { key: `research.fetch.reason.${details.reason}`, params: { status: details.status ?? 0 } };
}
