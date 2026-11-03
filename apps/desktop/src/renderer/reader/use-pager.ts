import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { firstOffsetOnScreen, outOfLayout, screenOfOffset } from "./page-offsets.ts";
import { chapterPages, columnCount, lastWindowFrom, pageFrame, PREFETCH_SCREENS, screenCount, screenStep, turn, windowFrom, type PageStyle } from "./pages.ts";

type Slice = { partId: string; text: string; start: number; end: number };
type Part = { id: string; length: number };

export type PagerCallbacks = {
  /** Open a chapter at an offset (it becomes the reading position). */
  onPart: (partId: string, start: number) => void;
  /** Load a window of a chapter from an offset without moving the saved position: the pager places the page itself. */
  onWindow: (partId: string, from: number) => void;
  /** Append the next window of the chapter. */
  onExtend: () => void;
  /** The range of the page on screen, for the progress, a bookmark and the conversation. */
  onPosition?: (partId: string, start: number, end: number) => void;
};

/** The space the pages have: the reading area less its padding. Unknown (no layout engine) reads as a common window. */
function useArea(node: RefObject<HTMLElement | null>, active: boolean) {
  const [area, setArea] = useState({ width: 800, height: 600 });
  /** The reading area is in the layout. A tab behind another is not; when it comes back the pages are placed again. */
  const [laidOut, setLaidOut] = useState(true);
  useLayoutEffect(() => {
    const element = node.current;
    if (!active || !element) return;
    const measure = () => {
      setLaidOut(!outOfLayout(element));
      const style = getComputedStyle(element);
      const width = element.clientWidth - parseFloat(style.paddingLeft || "0") - parseFloat(style.paddingRight || "0");
      const height = element.clientHeight - parseFloat(style.paddingTop || "0") - parseFloat(style.paddingBottom || "0");
      if (width > 0 && height > 0) setArea((old) => (old.width === width && old.height === height ? old : { width, height }));
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [node, active]);
  return { area, laidOut };
}

/**
 * Page by page through a chapter (A-115). The body is a strip of fixed-height columns, one per page; this keeps which screen is shown, keeps the
 * page across a new layout (its first character stays on screen), asks for the next window before the loaded text runs out, and goes on into
 * the neighbouring chapter at either end.
 */
export function usePager(input: {
  active: boolean;
  scroll: RefObject<HTMLElement | null>;
  body: RefObject<HTMLDivElement | null>;
  slice: Slice | null;
  parts: Part[];
  style: PageStyle & { fontSizePx: number; lineHeight: number; fontFamily?: string; paragraphSpacingPx?: number };
  highlight: { start: number; end: number } | null;
  /** Where the book was left, for its first window: placed on screen instead of the window's first character. */
  restored: { partId: string; offset: number } | null;
  /** The tab is in front (a tab behind another, or in a view not shown, is hidden by `visibility` and still has boxes). */
  shown?: boolean;
  callbacks: PagerCallbacks;
}) {
  const { active, slice, parts, style, highlight } = input;
  const { area, laidOut: inLayout } = useArea(input.scroll, active);
  const laidOut = inLayout && input.shown !== false;
  const frame = pageFrame(area, style);
  const [screen, setScreen] = useState(0);
  const [columns, setColumns] = useState(1);
  /** The range on screen, for the share of the book in the bottom bar and for the body's attributes. */
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const screens = screenCount(columns, frame);
  const calls = useRef(input.callbacks);
  calls.current = input.callbacks;

  /** What the next layout shows: a character, or the chapter's last page. Set by a turn or a window the pager asked for. */
  const pending = useRef<{ partId: string; anchor?: number; last?: boolean } | null>(null);
  /**
   * The character the reader is at, kept across layouts: the first one of the page a turn brought, or the one the book was opened or marked at. A new
   * layout (a font, a column that folds) shows the page that holds it and keeps it, so that laying out again and again does not walk back a page each time.
   */
  const anchor = useRef<{ partId: string; offset: number } | null>(null);
  /** The windows the pager asked for: any other slice came from outside (a chapter, a bookmark, a search hit) and is placed by its own start. */
  const asked = useRef<string | null>(null);
  const loading = useRef(false);
  const restoredUsed = useRef<string | null>(null);
  /** The chapter and start of the slice laid out last: the same ones with more text are an appended window. */
  const shown = useRef<string | null>(null);
  const placedMark = useRef<string | null>(null);

  const sliceKey = slice ? `${slice.partId}:${slice.start}:${slice.end}` : "";
  const partIndex = slice ? parts.findIndex((part) => part.id === slice.partId) : -1;
  const partLength = partIndex >= 0 ? parts[partIndex]!.length : slice?.end ?? 0;

  // A slice from outside that starts inside its chapter is replaced by the window around the place it shows, so pages read on before it.
  useLayoutEffect(() => {
    loading.current = false;
    if (!active || !slice) return;
    const key = `${slice.partId}:${slice.start}`;
    const appended = shown.current === key;
    shown.current = key;
    if (appended) return;
    if (asked.current === key) { asked.current = null; return; }
    if (pending.current?.partId === slice.partId) return;
    const restored = input.restored && input.restored.partId === slice.partId && restoredUsed.current !== key ? input.restored.offset : null;
    if (restored !== null) restoredUsed.current = key;
    const place = highlight && highlight.start >= slice.start && highlight.start <= slice.end ? highlight.start : restored ?? slice.start;
    const from = windowFrom(place);
    pending.current = { partId: slice.partId, anchor: place };
    if (slice.start > 0 && from !== slice.start) {
      asked.current = `${slice.partId}:${from}`;
      loading.current = true;
      calls.current.onWindow(slice.partId, from);
    }
  }, [active, sliceKey]);

  // Lay out: count the pages, then put on screen what is pending, else the page that had the first character, else the first page.
  useLayoutEffect(() => {
    const node = input.body.current;
    // Out of the layout nothing can be placed: what is pending waits for the tab to come back.
    if (!active || !node || !slice || !laidOut || outOfLayout(node)) return;
    const counted = columnCount(node.scrollWidth, frame);
    setColumns(counted);
    const last = screenCount(counted, frame) - 1;
    // A new mark (a bookmark or a search hit inside the text already laid out) is brought on screen once.
    const marked = highlight && highlight.start >= slice.start && highlight.start <= slice.end && placedMark.current !== `${highlight.start}:${highlight.end}` ? highlight.start : null;
    if (highlight) placedMark.current = `${highlight.start}:${highlight.end}`;
    const want = pending.current?.partId === slice.partId ? pending.current
      : marked !== null ? { partId: slice.partId, anchor: marked }
      : anchor.current?.partId === slice.partId ? { partId: slice.partId, anchor: anchor.current.offset } : null;
    let target = 0;
    if (want?.last) target = last;
    else if (want?.anchor !== undefined) {
      target = screenOfOffset(node, frame, slice.start, want.anchor) ?? 0;
      anchor.current = { partId: slice.partId, offset: want.anchor };
    }
    if (pending.current && !loading.current) pending.current = null;
    setScreen(Math.max(0, Math.min(last, target)));
  }, [active, sliceKey, slice?.text, frame.textWidth, frame.height, frame.columns, frame.gap, style.fontSizePx, style.lineHeight, style.fontFamily, style.paragraphSpacingPx, highlight?.start, laidOut]);

  // The page on screen: its range is the position; near the end of the loaded text the next window is asked for.
  useEffect(() => {
    const node = input.body.current;
    // Out of the layout no page is shown, and the start of the text must not pass for the place the book was left.
    if (!active || !node || !slice || loading.current || !laidOut || outOfLayout(node)) return;
    const first = firstOffsetOnScreen(node, frame, screen, slice.start, slice.start);
    const next = screen < screens - 1 ? firstOffsetOnScreen(node, frame, screen + 1, slice.start, slice.end) : slice.end;
    // A page that still holds the character keeps it (a new layout, or a report from before the screen was set); another page is a move.
    const held = anchor.current?.partId === slice.partId && anchor.current.offset >= first && anchor.current.offset < Math.max(first + 1, next);
    if (!held) anchor.current = { partId: slice.partId, offset: first };
    setRange({ start: first, end: Math.max(first, next) });
    calls.current.onPosition?.(slice.partId, first, Math.max(first, next));
    if (screen >= screens - 1 - PREFETCH_SCREENS && slice.end < partLength) {
      loading.current = true;
      calls.current.onExtend();
    }
  }, [active, sliceKey, screen, screens, laidOut]);

  const go = (direction: 1 | -1) => {
    if (!slice) return;
    const previous = partIndex > 0 ? parts[partIndex - 1]! : null;
    const next = partIndex >= 0 && partIndex < parts.length - 1 ? parts[partIndex + 1]! : null;
    const step = turn(direction, { screen, screens, sliceStart: slice.start, sliceEnd: slice.end, partLength, loading: loading.current, previous, next });
    if (step.kind === "screen") setScreen(step.screen);
    else if (step.kind === "extend") {
      // The page after the last one loaded is the first one of the appended text.
      pending.current = { partId: slice.partId, anchor: slice.end };
      loading.current = true;
      calls.current.onExtend();
    } else if (step.kind === "window") {
      pending.current = { partId: slice.partId, anchor: step.anchor };
      asked.current = `${slice.partId}:${step.from}`;
      loading.current = true;
      calls.current.onWindow(slice.partId, step.from);
    } else if (step.kind === "part" && step.at === "start") {
      pending.current = { partId: step.partId, anchor: 0 };
      calls.current.onPart(step.partId, 0);
    } else if (step.kind === "part") {
      const from = lastWindowFrom(previous?.length ?? 0);
      pending.current = { partId: step.partId, last: true };
      asked.current = `${step.partId}:${from}`;
      loading.current = true;
      calls.current.onWindow(step.partId, from);
    }
  };

  const atStart = !slice || (screen <= 0 && slice.start <= 0 && partIndex <= 0);
  const atEnd = !slice || (screen >= screens - 1 && slice.end >= partLength && partIndex >= parts.length - 1);
  const position = slice ? chapterPages({ screen, columns, frame, sliceStart: slice.start, sliceEnd: slice.end, partLength }) : null;
  return { frame, screen, screens, go, atStart, atEnd, position, offset: screen * screenStep(frame), at: range?.start ?? slice?.start ?? 0, range };
}
