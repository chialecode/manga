/**
 * Pages of a reflowable book (A-115). A chapter is laid out in a multi-column box of a fixed height whose column width is the text width of a
 * page: one column is one page, a screen shows one or two of them, and turning is moving the strip by a screen. Everything here is arithmetic
 * on sizes the reader measures; the DOM side (which character is where) is in `page-offsets.ts`.
 */

/** About this many characters are laid out at once; the next window is fetched and appended as the reader nears the end of the loaded one. */
export const WINDOW_CHARS = 60_000;
/** The reader asks for the next window this many screens before the end of the loaded text. */
export const PREFETCH_SCREENS = 2;
/** Space above and below the page inside the reading area. */
export const PAGE_ROOM_Y = 16;
/** Narrowest room between two pages: the two margins meet there, but never closer than this. */
export const MIN_PAGE_GAP = 16;
/** A screen moves by sliding a page width over this long (no movement when the system asks for reduced motion). */
export const TURN_MS = 160;

export type PageStyle = { measurePx: number; marginPx: number; pageMode?: "single" | "double"; pageRatio?: "book" | "free" };

/** The frame of the pages: the text width of one page, the room between two, how many on a screen and the height. */
export type PageFrame = { columns: 1 | 2; textWidth: number; gap: number; height: number; margin: number; width: number };

/**
 * The page frame for a reading area. A page is the line width (`measurePx`, margins included) or narrower when the area is; two pages when
 * double. The height is the area's, or the book proportion (4:3) of the page when that is lower.
 */
export function pageFrame(area: { width: number; height: number }, style: PageStyle): PageFrame {
  const columns: 1 | 2 = (style.pageMode ?? "single") === "double" ? 2 : 1;
  const margin = Math.max(0, style.marginPx);
  const gap = Math.max(MIN_PAGE_GAP, margin * 2);
  // The outer margins are padding of the frame; between two pages the gap holds both margins.
  const room = Math.max(0, area.width - margin * 2 - gap * (columns - 1));
  const textWidth = Math.max(120, Math.min(style.measurePx - margin * 2, Math.floor(room / columns)));
  const free = Math.max(160, Math.floor(area.height - PAGE_ROOM_Y * 2));
  const book = Math.round((textWidth + margin * 2) * 4 / 3);
  const height = (style.pageRatio ?? "book") === "book" ? Math.min(free, book) : free;
  return { columns, textWidth, gap, height, margin, width: textWidth * columns + gap * (columns - 1) };
}

/** How far the strip moves for one screen. */
export const screenStep = (frame: PageFrame): number => (frame.textWidth + frame.gap) * frame.columns;

/** Pages in a laid-out strip, from its scroll width. */
export function columnCount(scrollWidth: number, frame: PageFrame): number {
  if (scrollWidth <= 0) return 1;
  return Math.max(1, Math.round((scrollWidth + frame.gap) / (frame.textWidth + frame.gap)));
}

export const screenCount = (columns: number, frame: PageFrame): number => Math.max(1, Math.ceil(columns / frame.columns));

/** The screen showing the page a point of the strip is on (the point is measured from the strip's left edge). */
export function screenAt(x: number, frame: PageFrame): number {
  const column = Math.max(0, Math.floor((x + 1) / (frame.textWidth + frame.gap)));
  return Math.floor(column / frame.columns);
}

/**
 * The page position of the chapter for the bottom bar. A window that starts inside the chapter, or a chapter longer than what is loaded, has
 * its pages before and after estimated from the characters per page of what is laid out, and the total is "about".
 */
export function chapterPages(input: { screen: number; columns: number; frame: PageFrame; sliceStart: number; sliceEnd: number; partLength: number }) {
  const { screen, columns, frame, sliceStart, sliceEnd, partLength } = input;
  const loaded = Math.max(1, sliceEnd - sliceStart);
  const perPage = loaded / Math.max(1, columns);
  const before = sliceStart > 0 ? Math.round(sliceStart / perPage) : 0;
  const after = sliceEnd < partLength ? Math.ceil((partLength - sliceEnd) / perPage) : 0;
  const page = before + screen * frame.columns + 1;
  return { page, total: Math.max(page, before + columns + after), approx: before > 0 || after > 0 };
}

/** The share of the whole book before a character of a part, in whole percent. */
export function bookPercent(parts: Array<{ id: string; length: number }>, partId: string, offset: number): number {
  const total = parts.reduce((sum, part) => sum + Math.max(0, part.length), 0);
  if (total <= 0) return 0;
  let before = 0;
  for (const part of parts) {
    if (part.id === partId) { before += Math.min(Math.max(0, offset), part.length); break; }
    before += Math.max(0, part.length);
  }
  return Math.min(100, Math.floor(before * 100 / total));
}

/** What one turn does: another screen of this window, the next window, the neighbouring chapter, or nothing. */
export type Turn =
  | { kind: "screen"; screen: number }
  | { kind: "extend" }
  | { kind: "window"; from: number; anchor: number }
  | { kind: "part"; partId: string; at: "start" | "end" }
  | { kind: "none" };

export function turn(direction: 1 | -1, state: {
  screen: number; screens: number; sliceStart: number; sliceEnd: number; partLength: number; loading: boolean;
  previous: { id: string; length: number } | null; next: { id: string } | null;
}): Turn {
  const { screen, screens, sliceStart, sliceEnd, partLength } = state;
  if (direction > 0) {
    if (screen < screens - 1) return { kind: "screen", screen: screen + 1 };
    if (sliceEnd < partLength) return state.loading ? { kind: "none" } : { kind: "extend" };
    return state.next ? { kind: "part", partId: state.next.id, at: "start" } : { kind: "none" };
  }
  if (screen > 0) return { kind: "screen", screen: screen - 1 };
  // The window starts inside the chapter: the text before it is loaded, and the page before the first character shown becomes current.
  if (sliceStart > 0) return state.loading ? { kind: "none" } : { kind: "window", from: windowFrom(sliceStart - 1), anchor: sliceStart - 1 };
  return state.previous ? { kind: "part", partId: state.previous.id, at: "end" } : { kind: "none" };
}

/** Where a window that shows a character starts: the chapter's start when it is near, else far enough back that the pages before it read on. */
export function windowFrom(anchor: number): number {
  return anchor < WINDOW_CHARS / 2 ? 0 : Math.max(0, anchor - Math.floor(WINDOW_CHARS / 2));
}

/** The window that ends a chapter, for its last page. */
export const lastWindowFrom = (partLength: number): number => Math.max(0, partLength - WINDOW_CHARS);
