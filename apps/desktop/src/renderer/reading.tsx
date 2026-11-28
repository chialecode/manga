import { NORMALIZATION_V1 } from "@manga/contracts/location";
import { actionOf, chordLabel } from "@manga/contracts/keys";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { READER_PANEL_WIDTH } from "@manga/contracts/reading";
import { Bookmark, BookmarkPlus, ChevronLeft, ChevronRight, Copy, Fullscreen, List, Maximize2, Minimize2, NotebookPen, Pause, Play, Search, Shrink, Sparkles, Square, Type, Volume2 } from "lucide-react";
import { createTranslator, type MessageKey, type Translator } from "@manga/i18n";
import { SelectionBubble } from "./components/capture/selection-bubble.tsx";
import { Input } from "./components/ui/input.tsx";
import { PdfPageView } from "./pdf-page.tsx";
import { fontStack, THEME_BACKGROUND, THEME_FOREGROUND } from "./reader/fonts.ts";
import { layoutParagraphs } from "./reader/paragraphs.ts";
import { ReadingSettings } from "./reader/settings-panel.tsx";
import { ReaderSidePanel, type ReaderPanel } from "./reader/side-panel.tsx";
import { bookPercent, TURN_MS } from "./reader/pages.ts";
import { usePager } from "./reader/use-pager.ts";
import { useAutoHide } from "./reader/use-auto-hide.ts";
import { EditableNumber } from "./readers/editable-number.tsx";
import { useWindowFullscreen } from "./readers/window-fullscreen.tsx";
import { captureBridge, useCaptureActions, useQuickNoteSession } from "./lib/capture-bridge.ts";
import { isImeEvent, isTypingTarget } from "./lib/ime.ts";
import { useKeyTable } from "./lib/key-table.tsx";
import type { QuoteTag } from "./lib/quote-tags.ts";
import { useTab } from "./workspace/tab-context.tsx";
import { MatchLink } from "./readers/match-link.tsx";
import { SourceBanner } from "./readers/source-banner.tsx";
import { useReadNovel } from "./reader/use-read-novel.ts";
import { readAloudProblem } from "./voice/read-aloud.ts";
import { Modal } from "./components/modal.tsx";
import { PageCanvas, ReadingImage } from "./page-canvas.tsx";
import {
  highlightQuote,
  highlightSlices,
  pageNumberOf,
  pageSelectionRange,
  readingSegments,
  readingSelection,
  sliceSegmentHighlight,
  type ReadingAsset,
  type ReadingDocument,
  type ReadingLabels,
  type ReadingStyle,
} from "./reading-helpers.ts";

export {
  PageCanvas,
  highlightSlices,
  pageSelectionRange,
  readingSegments,
  readingSelection,
  type ReadingAsset,
  type ReadingDocument,
  type ReadingStyle,
};

const DEFAULT_T = createTranslator("zh-CN").t;

/** A reader narrower than this has its left panel float over the text (A-116). */
const NARROW_READER_PX = 640;
/** A wheel gesture turns one page; a pause this long starts the next gesture (the comic reader's rule). */
const WHEEL_GESTURE_GAP_MS = 220;
/** In the scrolling view the next window is appended once the end of the loaded text is this close. */
const SCROLL_PREFETCH_PX = 1200;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => setReduced(query.matches);
    query.addEventListener?.("change", changed);
    return () => query.removeEventListener?.("change", changed);
  }, []);
  return reduced;
}

/** Whether the reader is narrow, from its own width (unknown counts as wide). */
function useNarrow(root: RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const measure = () => setNarrow(node.clientWidth > 0 && node.clientWidth < NARROW_READER_PX);
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [root]);
  return narrow;
}

export function ReadingPane(props: {
  document: ReadingDocument | null;
  style: ReadingStyle;
  labels: ReadingLabels;
  /** Strings of the reader chrome; the default is the app's Chinese catalog. */
  t?: Translator["t"];
  onSearch: (text: string) => void;
  hits: Array<{ text: string; fragmentId?: string; locator?: { partId: string; range: { start: number; end: number } } }>;
  searched?: boolean;
  onJump: (partId: string, start: number, end: number) => void;
  onProgress: () => void;
  /** Explicit selection handoff when the user picks "问 Agent" from the selection bubble or context menu. */
  onSelect?: (quote: string, start: number, end: number, partId: string) => void;
  /** Open a chapter at an offset; it becomes the reading position. */
  onPart: (partId: string, start: number) => void;
  /** Load a window of a chapter without moving the saved position (the pages place themselves). */
  onWindow?: (partId: string, from: number) => void;
  /** Append the next window of the chapter. */
  onExtend?: () => void;
  /** The range of the page (or the window, when scrolling) on screen. */
  onPosition?: (partId: string, start: number, end: number) => void;
  /** The tab is in front. Behind another tab or in a view not shown, the pages are not placed and no position is reported. */
  shown?: boolean;
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
  /** "Match with Bangumi" in the title area; given only while the work is known and not linked. */
  onMatch?: () => void;
  labelsExtra: { sourceNeedsReview: string; sourceMissing: string; sourceRepair: string };
  /** Reading the novel aloud (计划 4.8): given while a speech connection is there. */
  readAloud?: { available: boolean; costHint: boolean; voice?: string; connectionId?: string; onCostHintOff: () => void };
}) {
  const t = props.t ?? DEFAULT_T;
  const slice = props.document?.slice;
  const root = useRef<HTMLElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ quote: string; start: number; end: number } | null>(null);
  const [selectionAnchor, setSelectionAnchor] = useState<{ x: number; y: number } | null>(null);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const captureActions = useCaptureActions();
  const quickNoteState = useQuickNoteSession();
  const showOnTopLayer = useCallback((node: HTMLDivElement | null) => {
    try { if (node && typeof node.showPopover === "function" && !node.matches(":popover-open")) node.showPopover(); } catch { /* shown in place */ }
  }, []);
  const [partIndex, setPartIndex] = useState(0);
  const [view, setView] = useState<"page" | "text">("page");
  const [panel, setPanel] = useState<ReaderPanel | null>(null);
  const panelButtons = useRef<Partial<Record<ReaderPanel, HTMLButtonElement | null>>>({});
  const [fullscreen, setFullscreen] = useState(false);
  const windowFull = useWindowFullscreen();
  const tab = useTab();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const settingsPanel = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(root);
  const reduced = useReducedMotion();
  const parts = props.document?.parts ?? [];
  const render = props.document?.format === "pdf" ? null : slice?.render ?? null;
  const pdf = props.document?.format === "pdf";
  const pdfBytes = pdf ? props.originalBytes ?? null : null;
  const pageView = pdf ? Boolean(pdfBytes) && view === "page" : Boolean(render) && view === "page";
  // The shell only forwards the book's author style while the reader keeps the built-in defaults.
  const authorStyle = props.style.theme === "white" ? props.document?.authorStyle ?? null : null;
  // A reflowable text is read page by page unless the reader chose scrolling; a PDF and a stored page layout keep their own pages (A-115).
  const paged = (props.style.flow ?? "paged") === "paged" && !pdf && !pageView && Boolean(slice) && slice!.textLayer !== false && slice!.kind !== "image";
  const double = paged && (props.style.pageMode ?? "single") === "double";

  const readSelectionAnchor = useCallback((): { x: number; y: number } | null => {
    const current = window.getSelection();
    if (current && current.rangeCount > 0 && !current.isCollapsed) {
      const range = current.getRangeAt(0);
      const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
      if (rect && (rect.width > 0 || rect.height > 0)) {
        return { x: rect.left + rect.width / 2, y: Math.max(56, rect.top - 8) };
      }
    }
    const bodyRect = body.current?.getBoundingClientRect();
    if (bodyRect && bodyRect.width > 0) return { x: bodyRect.left + bodyRect.width / 2, y: Math.max(80, bodyRect.top + 48) };
    return { x: (window.innerWidth || 1280) / 2, y: 120 };
  }, []);

  useEffect(() => {
    const changed = () => {
      if (pdf && pdfBytes && pageView) return;
      if (!body.current || !slice) { setSelection(null); setSelectionAnchor(null); return; }
      const current = window.getSelection();
      if (pageView && current && current.rangeCount === 1 && !current.isCollapsed) {
        const mapped = pageSelectionRange(current.getRangeAt(0));
        setSelection(mapped ? { quote: mapped.quote, start: mapped.start, end: mapped.end } : null);
        setSelectionAnchor(mapped ? readSelectionAnchor() : null);
        return;
      }
      const next = readingSelection(body.current, slice.start, current);
      setSelection(next);
      setSelectionAnchor(next ? readSelectionAnchor() : null);
    };
    changed();
    document.addEventListener("selectionchange", changed);
    return () => document.removeEventListener("selectionchange", changed);
  }, [slice, pageView, pdf, pdfBytes, readSelectionAnchor]);

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

  // Reading aloud marks the paragraph being heard; the pages follow the mark as they follow a jump.
  const atRef = useRef(0);
  const novelRead = useReadNovel({
    resourceId: props.document?.resourceId ?? null,
    slice: slice ?? null,
    parts,
    at: () => atRef.current,
    available: Boolean(props.readAloud?.available) && !pdf && !render,
    costHint: props.readAloud?.costHint ?? false,
    ...(props.readAloud?.voice ? { voice: props.readAloud.voice } : {}),
    ...(props.readAloud?.connectionId ? { connectionId: props.readAloud.connectionId } : {}),
    onCostHintOff: () => props.readAloud?.onCostHintOff(),
    onWindow: (partId, from) => (props.onWindow ?? props.onPart)(partId, from),
    onMove: (partId, start) => props.onPart(partId, start),
  });
  const readMark = novelRead.mark && novelRead.mark.partId === slice?.partId ? { start: novelRead.mark.start, end: novelRead.mark.end } : null;
  const shownHighlight = props.highlight ?? readMark;
  const currentPart = parts[partIndex];
  const immersive = fullscreen || windowFull.active;
  // The controls get out of the way while the book is read; an open panel keeps them, and in full screen any pointer move across the window brings them back.
  const controls = useAutoHide(root, { enabled: Boolean(props.document), hold: panel !== null || settingsOpen || menuAt !== null, wakeOnAnyPointerMove: immersive });
  const measure = Math.max(0, props.style.measurePx - props.style.marginPx * 2);
  const marked = slice ? highlightSlices(slice.text, shownHighlight, slice.start, slice.end) : null;
  const spacing = props.style.paragraphSpacingPx ?? 0;

  const progress = props.document?.progress;
  const pager = usePager({
    active: paged,
    scroll,
    body,
    slice: slice ?? null,
    parts,
    style: props.style,
    highlight: shownHighlight,
    restored: progress?.restoredRange && progress.restoredPartId ? { partId: progress.restoredPartId, offset: progress.restoredRange.start } : null,
    shown: props.shown !== false,
    callbacks: {
      onPart: props.onPart,
      onWindow: (partId, from) => (props.onWindow ?? props.onPart)(partId, from),
      onExtend: () => props.onExtend?.(),
      onPosition: props.onPosition,
    },
  });

  // A stored page layout (a fixed-layout EPUB) turns its pages the same way: one page is one part.
  const turnPart = (direction: 1 | -1) => {
    const target = parts[partIndex + direction];
    if (target) props.onPart(target.id, 0);
  };
  const turnPage = (direction: 1 | -1) => (paged ? pager.go(direction) : turnPart(direction));

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.current?.requestFullscreen?.().catch(() => setFullscreen(false));
  }, []);

  const keys = useKeyTable();
  const keysRef = useRef(keys);
  keysRef.current = keys;
  const turnRef = useRef(turnPage);
  turnRef.current = turnPage;
  const fullscreenRef = useRef(toggleFullscreen);
  fullscreenRef.current = toggleFullscreen;
  const menuOpenRef = useRef(menuAt !== null);
  menuOpenRef.current = menuAt !== null;
  const canTurnKeys = tab.focused && (paged || (pageView && Boolean(render)));
  const canNovelKeys = tab.focused && Boolean(props.document);
  // Put on in the commit that makes the tab the focused one, so that a key pressed at once is not lost.
  useLayoutEffect(() => {
    if (!canNovelKeys) return;
    const onKey = (event: KeyboardEvent) => {
      if (isImeEvent(event) || event.defaultPrevented || isTypingTarget(event.target)) return;
      if (event.key === "Escape" && menuOpenRef.current) {
        event.preventDefault();
        setMenuAt(null);
        return;
      }
      if (document.querySelector('[role="dialog"]')) return;
      const action = actionOf(event, keysRef.current, "novel");
      if (action === "novel.fullscreen") { event.preventDefault(); fullscreenRef.current(); }
      else if (canTurnKeys && action === "novel.next") { event.preventDefault(); turnRef.current(1); }
      else if (canTurnKeys && action === "novel.prev") { event.preventDefault(); turnRef.current(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [canNovelKeys, canTurnKeys]);

  useEffect(() => {
    if (!menuAt) return;
    const close = () => setMenuAt(null);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [menuAt]);

  // The wheel turns one page per gesture over the pages.
  const pagesBox = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = pagesBox.current;
    if (!paged || !node) return;
    const state = { lastAt: 0, fired: false };
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) < 1 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      const now = Date.now();
      if (now - state.lastAt > WHEEL_GESTURE_GAP_MS) state.fired = false;
      state.lastAt = now;
      if (state.fired) return;
      state.fired = true;
      turnRef.current(event.deltaY > 0 ? 1 : -1);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [paged]);

  // Scrolling: the next window is appended near the end, and a wheel turned again at the end of a chapter goes on into the next one.
  const scrollWheel = useRef({ lastAt: 0, atEnd: false });
  const scrollCtxRef = useRef({ slice, currentPart, parts, partIndex, onPart: props.onPart });
  scrollCtxRef.current = { slice, currentPart, parts, partIndex, onPart: props.onPart };
  const nearEnd = () => {
    const node = scroll.current;
    if (paged || !node || !slice) return;
    if (node.scrollTop + node.clientHeight >= node.scrollHeight - SCROLL_PREFETCH_PX && slice.end < (currentPart?.length ?? 0)) props.onExtend?.();
  };
  useEffect(() => {
    const node = scroll.current;
    if (paged || pageView || !node) return;
    const onWheel = (event: WheelEvent) => {
      const ctx = scrollCtxRef.current;
      if (event.ctrlKey || event.deltaY <= 0 || !ctx.slice) return;
      const now = Date.now();
      const state = scrollWheel.current;
      const fresh = now - state.lastAt > WHEEL_GESTURE_GAP_MS;
      state.lastAt = now;
      const bottom = node.scrollTop + node.clientHeight >= node.scrollHeight - 2;
      if (fresh && bottom && state.atEnd && ctx.slice.end >= (ctx.currentPart?.length ?? 0)) {
        const next = ctx.parts[ctx.partIndex + 1];
        if (next) ctx.onPart(next.id, 0);
      }
      if (fresh) state.atEnd = bottom;
    };
    node.addEventListener("wheel", onWheel, { passive: true });
    return () => node.removeEventListener("wheel", onWheel);
  }, [paged, pageView]);

  // A new chapter in the scrolling view starts at its top, and its window is the position.
  const onPositionRef = useRef(props.onPosition);
  onPositionRef.current = props.onPosition;
  const highlightActiveRef = useRef(Boolean(props.highlight));
  highlightActiveRef.current = Boolean(props.highlight);
  const shown = props.shown !== false;
  useEffect(() => {
    if (paged || !slice) return;
    if (!highlightActiveRef.current && scroll.current) scroll.current.scrollTop = 0;
    if (shown) onPositionRef.current?.(slice.partId, slice.start, slice.end);
  }, [paged, slice?.partId, slice?.start, slice?.end, shown]);

  // Plan D: casual text selections show a floating action bubble instead of silently stuffing the right-dock composer.
  const buildSelectionTag = (): QuoteTag | null => {
    if (!selection || !slice || !props.document) return null;
    return {
      id: `selection:${props.document.resourceId}`,
      kind: "selection",
      resourceId: props.document.resourceId,
      revisionId: props.document.revisionId,
      partId: slice.partId,
      start: selection.start,
      end: Math.max(selection.end, selection.start),
      quote: selection.quote,
      label: t("chat.tag.selection", { count: Math.max(1, [...selection.quote].length) }),
    };
  };

  // Expose active novel selection to QuickNote shortcut (`N`) / EdgeHandle without silently pushing into the right dock.
  useEffect(() => {
    const tag = selection && slice && props.document ? {
      id: `selection:${props.document.resourceId}`,
      kind: "selection" as const,
      resourceId: props.document.resourceId,
      revisionId: props.document.revisionId,
      partId: slice.partId,
      start: selection.start,
      end: Math.max(selection.end, selection.start),
      quote: selection.quote,
      label: t("chat.tag.selection", { count: Math.max(1, [...selection.quote].length) }),
    } : null;
    captureBridge.setPendingTag(tag, tab.tabId);
    return () => captureBridge.setPendingTag(null, tab.tabId);
  }, [selection, slice?.partId, props.document?.resourceId, props.document?.revisionId, t, tab.tabId]);

  const clearSelection = () => {
    try { window.getSelection()?.removeAllRanges(); } catch { /* ignore */ }
    setSelection(null);
    setSelectionAnchor(null);
  };

  const noteSelection = () => {
    const tag = buildSelectionTag();
    if (!tag) { captureActions?.openQuickNote(); return; }
    captureActions?.openQuickNote({ tag });
    clearSelection();
  };

  const askSelection = () => {
    if (!selection || !slice) return;
    const tag = buildSelectionTag();
    props.onSelect?.(selection.quote, selection.start, selection.end, slice.partId);
    if (tag) captureActions?.askAgentWithTag(tag);
    clearSelection();
  };

  const copySelection = () => {
    if (!selection) return;
    void navigator.clipboard?.writeText?.(selection.quote)?.catch(() => undefined);
    captureActions?.notify(t("capture.copied"));
    clearSelection();
  };

  const quickNoteKey = keys["global.quickNote"]?.[0] ? chordLabel(keys["global.quickNote"]![0]!) : "N";
  const openContextMenu = (clientX: number, clientY: number) => {
    const menuWidth = 196;
    const menuHeight = selection ? 190 : 110;
    const maxX = Math.max(8, (window.innerWidth || 1280) - menuWidth - 8);
    const maxY = Math.max(8, (window.innerHeight || 720) - menuHeight - 8);
    setMenuAt({ x: Math.max(8, Math.min(clientX, maxX)), y: Math.max(8, Math.min(clientY, maxY)) });
  };

  const openPanel = (next: ReaderPanel) => setPanel((current) => (current === next ? null : next));
  const closePanel = () => {
    const open = panel;
    setPanel(null);
    if (open) panelButtons.current[open]?.focus();
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
    const activeHighlight = marked ? shownHighlight : null;
    const renderImage = (assetId: string, offset: number, keySuffix: string | number) => (
      <ReadingImage key={`img-${offset}-${assetId}-${keySuffix}`} asset={slice.images?.find((item) => item.id === assetId)} src={props.assets[assetId]} measure={measure} offset={offset} pending={props.labels.images} failed={props.labels.imageFailed} />
    );
    if (spacing > 0) {
      const pieces = layoutParagraphs(slice.text, slice.start, activeHighlight, placements);
      let firstMark = true;
      return pieces.map((piece, index) => {
        if (piece.kind === "separator") return <span key={`sep-${index}`} hidden>{piece.text}</span>;
        if (piece.kind === "image") return renderImage(piece.assetId, piece.offset, index);
        return (
          <p key={`p-${piece.start}`} className="reader-paragraph" style={{ margin: `0 0 ${spacing}px`, whiteSpace: "pre-wrap" }}>
            {piece.parts.map((part, at) => {
              if (part.kind === "image") return renderImage(part.assetId, part.offset, at);
              if (!part.marked) return <span key={at}>{part.text}</span>;
              const first = firstMark;
              firstMark = false;
              return <mark key={at} data-testid={first ? "reading-quote-hit" : "reading-quote-hit-more"}>{part.text}</mark>;
            })}
          </p>
        );
      });
    }
    if (placements.length > 0) {
      let firstMark = true;
      return readingSegments(slice.text, slice.start, placements).map((segment, index) => {
        if (segment.kind === "image") return renderImage(segment.assetId, segment.offset, index);
        const split = sliceSegmentHighlight(segment.text, segment.start, segment.end, activeHighlight);
        if (!split) return <span key={`text-${index}`}>{segment.text}</span>;
        const first = firstMark;
        firstMark = false;
        return (
          <Fragment key={`text-${index}`}>
            {split[0]}
            <mark data-testid={first ? "reading-quote-hit" : "reading-quote-hit-more"}>{split[1]}</mark>
            {split[2]}
          </Fragment>
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
    return slice.text;
  })();

  // Bring the jump target into view in the scrolling view without changing the stored read range; the pages place it themselves.
  useEffect(() => {
    if (paged || !shownHighlight || !body.current) return;
    body.current.querySelector<HTMLElement>("[data-testid='reading-quote-hit']")?.scrollIntoView({ block: "center" });
  }, [shownHighlight?.start, shownHighlight?.end, paged]);

  // A click on the left or right third of a page turns it; a click on the text closes a floating panel first.
  const onPagesClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (panel && narrow) { setPanel(null); return; }
    if (!paged) return;
    const picked = window.getSelection();
    if (picked && !picked.isCollapsed) return;
    if ((event.target as HTMLElement).closest("a, button, img")) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const x = (event.clientX - box.left) / box.width;
    if (x < 1 / 3) pager.go(-1);
    else if (x > 2 / 3) pager.go(1);
  };

  const frame = pager.frame;
  atRef.current = paged ? pager.at : slice?.start ?? 0;
  const bodyAttrs = {
    ref: body,
    "data-testid": "reading-body",
    "data-normalization": NORMALIZATION_V1,
    "data-part-id": slice?.partId,
    "data-reading-aloud": readMark ? "true" : undefined,
  };
  const position = paged && pager.position
    ? t(pager.position.approx ? "reader.pagePositionApprox" : "reader.pagePosition", { page: pager.position.page, total: pager.position.total })
    : null;
  const toc = props.document?.toc ?? [];

  return (
    <section ref={root} className="reader reader-novel" data-testid="reading-page" data-theme={props.style.theme} data-fullscreen={fullscreen || undefined} data-immersive={fullscreen || windowFull.active || undefined} data-controls={controls.hidden ? "hidden" : "shown"}>
      <div className="reader-main" data-panel={panel ? (narrow ? "float" : "left") : undefined}>
        {props.document && panel ? (
          <ReaderSidePanel
            panel={panel}
            width={props.style.panelPx ?? READER_PANEL_WIDTH.initial}
            floating={narrow}
            label={panel === "toc" ? props.labels.toc : panel === "search" ? props.labels.search : props.labels.bookmark}
            resizeLabel={t("reader.panelResize")}
            onWidth={(panelPx) => props.onStyle({ panelPx })}
            onClose={closePanel}
          >
            {panel === "toc" ? (
              <nav className="reader-toc" aria-label={props.labels.toc}>
                {toc.length === 0 ? <p className="detail-muted">{props.labels.empty}</p> : null}
                {toc.map((item) => (
                  <button key={`${item.partId}-${item.label}`} type="button" className="reader-toc-item" aria-current={item.partId === slice?.partId ? "true" : undefined} data-testid={`toc-${item.partId}`} onClick={() => { props.onPart(item.partId, 0); if (narrow) setPanel(null); }}>{item.label}</button>
                ))}
              </nav>
            ) : null}
            {panel === "search" ? (
              <div>
                <form onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); props.onSearch(String(data.get("q") ?? "")); }}>
                  <Input name="q" className="w-full" aria-label={props.labels.search} placeholder={props.labels.search} data-testid="reading-search" autoFocus />
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
          </ReaderSidePanel>
        ) : null}
        {novelRead.stoppedAt ? (
          <div className="reader-read-ask" role="status" data-testid="reading-read-position">
            <span>{t("readAloud.novel.moveAsk")}</span>
            <button type="button" className="secondary-button" data-testid="reading-read-move" onClick={novelRead.moveHere}>{t("readAloud.novel.move")}</button>
            <button type="button" className="link-button" data-testid="reading-read-keep" onClick={novelRead.keepPlace}>{t("readAloud.novel.keep")}</button>
          </div>
        ) : null}
        {novelRead.error ? (
          <div className="reader-read-ask" role="alert" data-testid="reading-read-error">
            <span>{t((readAloudProblem(novelRead.error)?.key ?? "readAloud.error.other") as MessageKey)}</span>
          </div>
        ) : null}
        {novelRead.asking ? <NovelCostAsk t={t} chars={novelRead.asking.chars} onGo={novelRead.confirm} onCancel={novelRead.cancelAsk} /> : null}
        <div
          ref={scroll}
          className="reader-scroll"
          data-testid="reading-scroll"
          data-flow={paged ? "paged" : "scroll"}
          style={{ background, color }}
          onScroll={nearEnd}
          onClick={paged ? undefined : onPagesClick}
          onContextMenu={(event) => {
            if (!props.document) return;
            event.preventDefault();
            openContextMenu(event.clientX, event.clientY);
          }}
        >
          {!props.document ? <p>{props.labels.empty}</p> : (
            <article>
              {props.sourceCard ? <SourceBanner t={t} card={props.sourceCard} testPrefix="reading" onBackToNote={props.onBackToNote} onRepair={props.onRepair} /> : null}
              {props.document.source.available === false ? <p role="status" data-testid="reading-missing">{props.labels.missing}</p> : null}

              {slice && !slice.textLayer && !pageView ? <p data-testid="reading-scan">{slice.kind === "image" ? props.labels.image : props.labels.scan}</p> : null}
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
                  zoomLabels={{ out: t("reading.zoomOut"), in: t("reading.zoomIn"), fit: t("reading.zoomFit") }}
                  onSelection={(next) => { setSelection(next); setSelectionAnchor(next ? readSelectionAnchor() : null); }}
                />
              ) : null}
              {pageView && render ? <PageCanvas render={render} assets={props.assets} truncatedLabel={t("reading.pageTruncated")} /> : null}

              {paged ? (
                <div ref={pagesBox} className="reader-pages" data-testid="reading-pages" data-columns={frame.columns} style={{ width: frame.width + frame.margin * 2, padding: `0 ${frame.margin}px`, background, color, ["--page-height" as string]: `${frame.height}px` }} onClick={onPagesClick}>
                  <div className="reader-pages-clip" style={{ width: frame.width, height: frame.height }}>
                    <div
                      {...bodyAttrs}
                      data-view="text"
                      data-layout={double ? "double" : "single"}
                      data-page-start={pager.range?.start}
                      data-page-end={pager.range?.end}
                      className="reader-paged whitespace-pre-wrap"
                      style={{
                        ...textStyle,
                        width: frame.width,
                        height: frame.height,
                        columnCount: frame.columns,
                        columnWidth: frame.textWidth,
                        columnGap: frame.gap,
                        columnFill: "auto",
                        transform: pager.offset ? `translateX(${-pager.offset}px)` : undefined,
                        transition: reduced ? "none" : `transform ${TURN_MS}ms ease`,
                      }}
                    >{bodyContent}</div>
                  </div>
                </div>
              ) : (
                <div
                  {...bodyAttrs}
                  hidden={pageView || undefined}
                  data-view={pageView ? "page" : "text"}
                  data-layout="scroll"
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
            </article>
          )}
        </div>
        {selection && slice && !quickNoteState.open && !menuAt ? (
          <SelectionBubble
            kind="novel"
            label={t("capture.bubble")}
            anchor={selectionAnchor ?? { x: (window.innerWidth || 1280) / 2, y: 120 }}
            actions={[
              {
                id: "note",
                testId: "selection-bubble-note",
                label: t("capture.note"),
                icon: <NotebookPen size={14} aria-hidden="true" />,
                accent: true,
                onClick: noteSelection,
              },
              {
                id: "ask",
                testId: "selection-bubble-ask",
                label: t("capture.askAgent"),
                icon: <Sparkles size={14} aria-hidden="true" />,
                onClick: askSelection,
              },
              {
                id: "copy",
                testId: "selection-bubble-copy",
                label: t("capture.copy"),
                icon: <Copy size={14} aria-hidden="true" />,
                onClick: copySelection,
              },
            ]}
          />
        ) : null}
        {menuAt ? (
          <div ref={showOnTopLayer} popover="manual" className="reader-context-menu" role="menu" aria-label={t("reading.menu")} data-testid="novel-context" style={{ left: menuAt.x, top: menuAt.y, right: "auto", bottom: "auto" }} onMouseDown={(event) => event.stopPropagation()} onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); }}>
            {selection ? (
              <>
                <button type="button" role="menuitem" data-testid="novel-context-copy" onClick={() => { setMenuAt(null); copySelection(); }}>{t("capture.copy")}</button>
                <button type="button" role="menuitem" data-testid="novel-context-note" onClick={() => { setMenuAt(null); noteSelection(); }}>{t("capture.noteKey", { key: quickNoteKey })}</button>
                <button type="button" role="menuitem" data-testid="novel-context-ask" onClick={() => { setMenuAt(null); askSelection(); }}>{t("capture.askAgent")}</button>
                {captureActions?.voiceEnabled ? <div className="context-menu-separator" role="separator" /> : null}
              </>
            ) : (
              <button type="button" role="menuitem" data-testid="novel-context-note" onClick={() => { setMenuAt(null); captureActions?.openQuickNote(); }}>{t("capture.noteKey", { key: quickNoteKey })}</button>
            )}
            {captureActions?.voiceEnabled ? (
              <button type="button" role="menuitem" data-testid="novel-context-record" onClick={() => { setMenuAt(null); captureActions.toggleRecording(); }}>
                {captureActions.recordingActive
                  ? t("capture.recordStopKey", { key: captureActions.recordingToggleKey })
                  : t("capture.recordStartKey", { key: captureActions.recordingToggleKey })}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {props.document ? (
        <footer className="reader-foot" data-testid="reading-footer" {...controls.bind}>
          {settingsOpen ? (
            <ReadingSettings t={t} style={props.style} onStyle={props.onStyle} canDouble={!pageView} onClose={() => setSettingsOpen(false)} anchor={settingsButton} panel={settingsPanel} extra={<MatchLink label={t("match.fromReader")} onMatch={props.onMatch} />} />
          ) : null}
          <div className="reader-foot-row">
            {paged ? (
              <>
                <button type="button" className="icon-button" data-testid="reading-page-prev" aria-label={t("reader.pagePrev")} title={t("reader.pagePrev")} disabled={pager.atStart} onClick={() => pager.go(-1)}><ChevronLeft size={18} /></button>
                <button type="button" className="icon-button" data-testid="reading-page-next" aria-label={t("reader.pageNext")} title={t("reader.pageNext")} disabled={pager.atEnd} onClick={() => pager.go(1)}><ChevronRight size={18} /></button>
                <span className="reader-position" data-testid="reading-page-position">{position}</span>
              </>
            ) : null}
            <EditableNumber
              testId="reading-part-position"
              inputTestId="reading-part-input"
              className="reader-position"
              display={props.labels.part.replace("{index}", String(partIndex + 1)).replace("{total}", String(parts.length))}
              value={partIndex + 1}
              max={Math.max(1, parts.length)}
              disabled={parts.length <= 1}
              label={t("reading.partEdit", { position: props.labels.part.replace("{index}", String(partIndex + 1)).replace("{total}", String(parts.length)) })}
              inputLabel={t("reading.partInput")}
              onGo={(number) => { const part = parts[number - 1]; if (part) props.onPart(part.id, 0); }}
            />
            {paged && slice ? <span className="reader-position" data-testid="reading-book-percent">{t("reader.bookPercent", { percent: bookPercent(parts, slice.partId, pager.at) })}</span> : null}
            {currentPart?.title ? <span className="reader-chapter" data-testid="reading-chapter" title={currentPart.title}>{currentPart.title}</span> : null}
            <div className="reader-group" role="toolbar" aria-label={t("reading.tools")}>
              <button ref={(node) => { panelButtons.current.toc = node; }} type="button" className="icon-button" data-testid="reading-panel-toc" aria-pressed={panel === "toc"} aria-label={t("reading.toc")} title={t("reading.toc")} onClick={() => openPanel("toc")}><List size={18} /></button>
              <button ref={(node) => { panelButtons.current.search = node; }} type="button" className="icon-button" data-testid="reading-panel-search" aria-pressed={panel === "search"} aria-label={props.labels.search} title={props.labels.search} onClick={() => openPanel("search")}><Search size={18} /></button>
              <button ref={(node) => { panelButtons.current.bookmarks = node; }} type="button" className="icon-button" data-testid="reading-panel-bookmarks" aria-pressed={panel === "bookmarks"} aria-label={props.labels.bookmark} title={props.labels.bookmark} onClick={() => openPanel("bookmarks")}><Bookmark size={18} /></button>
              {novelRead.readable ? (novelRead.status === "idle" || novelRead.status === "error" ? (
                <button type="button" className="icon-button" data-testid="reading-read-aloud" aria-label={t("readAloud.read")} title={t("readAloud.read")} onClick={novelRead.start}><Volume2 size={18} /></button>
              ) : (
                <>
                  {novelRead.status === "paused"
                    ? <button type="button" className="icon-button" data-testid="reading-read-resume" aria-label={t("readAloud.resume")} title={t("readAloud.resume")} onClick={novelRead.resume}><Play size={18} /></button>
                    : <button type="button" className="icon-button" data-testid="reading-read-pause" data-status={novelRead.status} aria-label={t("readAloud.pause")} title={novelRead.status === "loading" ? t("readAloud.loading") : t("readAloud.pause")} onClick={novelRead.pause}><Pause size={18} /></button>}
                  <button type="button" className="icon-button" data-testid="reading-read-stop" aria-label={t("readAloud.stop")} title={t("readAloud.stop")} onClick={novelRead.stop}><Square size={16} /></button>
                </>
              )) : null}
              <button type="button" className="icon-button" data-testid="reading-bookmark-add" aria-label={props.labels.bookmarkAdd} title={props.labels.bookmarkAdd} onClick={props.onBookmark} disabled={!slice}><BookmarkPlus size={18} /></button>
            </div>
            {render || pdfBytes ? (
              <button type="button" className="secondary-button" data-testid="reading-view-toggle" onClick={() => setView(pageView ? "text" : "page")}>
                {pageView ? props.labels.viewText : props.labels.viewPage}
              </button>
            ) : null}
            <span className="flex-1" />
            <button type="button" className="secondary-button" data-testid="reading-progress" onClick={props.onProgress}>{props.labels.progress}</button>
            <button type="button" className="icon-button" data-testid="reading-window-fullscreen" aria-pressed={windowFull.active} aria-label={windowFull.active ? t("window.fullscreen.exit") : t("window.fullscreen")} title={windowFull.active ? t("window.fullscreen.exit") : t("window.fullscreen")} onClick={windowFull.toggle}>{windowFull.active ? <Shrink size={16} /> : <Fullscreen size={16} />}</button>
            <button type="button" className="icon-button" data-testid="reading-fullscreen" aria-pressed={fullscreen} aria-label={t("reader.fullscreen")} title={t("reader.fullscreen")} onClick={toggleFullscreen}>{fullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}</button>
            <button ref={settingsButton} type="button" className="icon-button" data-testid="reading-settings" aria-expanded={settingsOpen} aria-label={t("reader.settings")} title={t("reader.settings")} onClick={() => setSettingsOpen((open) => !open)}><Type size={18} /></button>
          </div>
        </footer>
      ) : null}
    </section>
  );
}

/** Before a novel is read aloud (计划 4.8, Q-41): what it is billed by, how much of the chapter is left, and “不再提示”. */
function NovelCostAsk(props: { t: Translator["t"]; chars: number; onGo: (never: boolean) => void; onCancel: () => void }) {
  const { t } = props;
  const [never, setNever] = useState(false);
  return (
    <Modal
      title={t("readAloud.novel.costTitle")}
      description={t("readAloud.novel.costBody", { chars: props.chars })}
      closeLabel={t("readAloud.novel.cancel")}
      onClose={props.onCancel}
      testId="reading-read-cost"
      footer={(
        <>
          <button type="button" className="secondary-button" data-testid="reading-read-cost-cancel" onClick={props.onCancel}>{t("readAloud.novel.cancel")}</button>
          <button type="button" className="primary-button" data-testid="reading-read-cost-go" onClick={() => props.onGo(never)}>{t("readAloud.novel.go")}</button>
        </>
      )}
    >
      <label className="flex gap-2 items-center"><input type="checkbox" data-testid="reading-read-cost-never" checked={never} onChange={(event) => setNever(event.target.checked)} />{t("readAloud.novel.never")}</label>
    </Modal>
  );
}
