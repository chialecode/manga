import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { measureElement as measureRow, observeElementRect, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ArrowDown } from "lucide-react";
import type { Translator } from "@manga/i18n";
import type { StreamItem } from "../../hooks/use-session-stream.ts";
import { Bubble, type BubbleActions } from "./bubbles.tsx";

/*
 * The structure of this list (a log region that sticks to the bottom while an answer streams, a scroll-down button, bubbles by
 * kind) follows the conversation and message components of Vercel ai-elements (Apache-2.0, https://github.com/vercel/ai-elements).
 * The code is written for MANGA's own message kinds and styles; nothing is imported from the `ai` package. The scroll behaviour
 * is `use-stick-to-bottom` (MIT, https://github.com/stackblitz-labs/use-stick-to-bottom); only the rows near the viewport are rendered,
 * by `@tanstack/react-virtual` (MIT, https://github.com/TanStack/virtual) over the same scroll container (LOOP-07).
 */

type T = Translator["t"];

export type { BubbleActions };

function ScrollButton(props: { label: string }) {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return <button type="button" className="chat-scroll-bottom" data-testid="chat-scroll-bottom" aria-label={props.label} title={props.label} onClick={() => { void scrollToBottom(); }}><ArrowDown size={16} /></button>;
}

/** Where each conversation was scrolled to, kept while another one is shown (the other mode's, a settings round trip) and put back when it returns. */
const scrollMemory = new Map<string, { top: number; atBottom: boolean }>();
const NEAR_BOTTOM_PX = 8;
export const resetScrollMemory = (): void => scrollMemory.clear();

/**
 * Remembers where the conversation was scrolled to and puts it back when it is shown again. A conversation read from its newest message
 * stays at the newest; one that was scrolled up to an old message comes back to that message and is not pulled to the bottom.
 */
function ScrollMemory(props: { memoryKey: string | undefined; ready: boolean }) {
  const { scrollRef } = useStickToBottomContext();
  const { memoryKey, ready } = props;
  const readyNow = useRef(ready);
  readyNow.current = ready;
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !memoryKey) return;
    const onScroll = () => {
      // The messages of another conversation sliding in or out are not this one's place; nor is the 0 a hidden pane reports.
      if (!readyNow.current || (node.clientHeight === 0 && node.scrollHeight === 0)) return;
      scrollMemory.set(memoryKey, { top: node.scrollTop, atBottom: node.scrollHeight - node.scrollTop - node.clientHeight <= NEAR_BOTTOM_PX });
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [memoryKey, scrollRef]);
  const restoredFor = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    // The messages of another conversation (or none yet) are not the place the saved position belongs to.
    if (!memoryKey || !ready) { restoredFor.current = undefined; return; }
    if (restoredFor.current === memoryKey) return;
    restoredFor.current = memoryKey;
    const saved = scrollMemory.get(memoryKey);
    const node = scrollRef.current;
    if (saved && !saved.atBottom && node) node.scrollTop = saved.top;
  }, [memoryKey, ready, scrollRef]);
  return null;
}

/**
 * Open a bound resource and the pane is at the newest message; an old message is read by scrolling up and is not pulled away from.
 * Growth at the bottom (a reply being written, rows measured after their estimate) is followed at once, not by an animation that trails it.
 */
export function MessageList(props: ListProps) {
  const { t } = props;
  return (
    <StickToBottom className="chat-log" initial="instant" resize="instant" role="log" aria-label={t("chat.log")} data-testid="chat-log">
      <StickToBottom.Content className={`chat-log-content ${props.limited ? "chat-log-wide" : ""}`}>
        {props.hasMore ? <button type="button" className="link-button chat-older" data-testid="chat-older" disabled={props.loadingOlder} onClick={() => { void props.onOlder(); }}>{t("chat.older")}</button> : null}
        {props.items.length === 0 ? <div className="chat-empty" data-testid="chat-empty">{props.empty}</div> : null}
        <VirtualRows {...props} />
      </StickToBottom.Content>
      <ScrollButton label={t("chat.toBottom")} />
      <ScrollMemory memoryKey={props.memoryKey} ready={props.ready ?? props.items.length > 0} />
    </StickToBottom>
  );
}

/** A message to bring into view (from a note or a quote): found by its id, the older pages loaded first when it is not among the loaded ones. */
export type RevealRequest = { id: string; token: number };

type ListProps = {
  t: T; items: StreamItem[]; hasMore: boolean; onOlder: () => void | Promise<unknown>; actions: BubbleActions; empty: ReactNode; formatDate: (value: string) => string;
  limited?: boolean; memoryKey?: string; ready?: boolean;
  /** An older page is being read: the top of the list does not ask again. */
  loadingOlder?: boolean;
  reveal?: RevealRequest | null;
  /** The message was shown (true) or is not in the conversation (false). */
  onRevealed?: (found: boolean) => void;
};

/** A row's height before it is measured; also what a row counts as while the pane is hidden (it measures 0 then). */
export const ROW_ESTIMATE = 96;
/** The height the list assumes while its pane is hidden or not laid out, so a few screens of rows are ready when it is shown. */
const UNLAID_HEIGHT = 2400;
const OVERSCAN = 6;
/** Within this distance of the top the next older page is read on its own. */
const OLDER_PX = 240;
const HIGHLIGHT_MS = 2000;

type Anchor = { id: string; offset: number; neighbours: string[] };

function VirtualRows(props: ListProps) {
  const { items } = props;
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const { scrollRef, isAtBottom, stopScroll, state } = useStickToBottomContext();
  const rows = useRef<HTMLDivElement>(null);
  // Whether the last scroll left the list at its very bottom: a row measured after its estimate, or a reply growing, keeps it there.
  const pinned = useRef(true);
  const leftAt = useRef<{ top: number; height: number } | null>(null);
  // Another conversation in the same list starts at its newest message (or where the scroll memory puts it back, which is a scroll of its own).
  const shownKey = useRef(props.memoryKey);
  if (shownKey.current !== props.memoryKey) { shownKey.current = props.memoryKey; pinned.current = true; leftAt.current = null; }
  const atBottom = useRef(isAtBottom);
  atBottom.current = isAtBottom;
  const [margin, setMargin] = useState(0);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    getItemKey: (index) => items[index]?.id ?? index,
    overscan: OVERSCAN,
    scrollMargin: margin,
    // React 19 warns if flushSync runs synchronously during a lifecycle/effect scroll (e.g. scrollToIndex inside useEffect).
    useFlushSync: false,
    initialRect: { width: 0, height: UNLAID_HEIGHT },
    // A hidden pane (or one not laid out yet) has no height and its rows none either: assume a few screens instead of none or all.
    observeElementRect: (instance, cb) => observeElementRect(instance, (rect) => cb(rect.height > 0 ? rect : { width: rect.width, height: UNLAID_HEIGHT })),
    measureElement: (element, entry, instance) => { const size = measureRow(element, entry, instance); return size > 0 ? size : ROW_ESTIMATE; },
  });
  // A row that grows (an answer being written, a recording being transcribed): at the bottom the list follows it (use-stick-to-bottom);
  // scrolled up, only a row above the viewport moves the position, so what is being read stays put.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance: Virtualizer<HTMLElement, Element>) => !atBottom.current && item.start < (instance.scrollOffset ?? 0);

  // The rows start below the "older messages" button and the padding; the virtualizer counts from the top of the scroll container.
  const isEmpty = items.length === 0;
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const box = rows.current;
    if (!node || !box) return;
    const outer = node.getBoundingClientRect();
    // A hidden pane (or one not laid out) has no box to measure from: the last margin stays.
    if (outer.height === 0) return;
    const next = Math.round(box.getBoundingClientRect().top - outer.top + node.scrollTop);
    if (next !== margin) setMargin(next);
  }, [scrollRef, props.hasMore, isEmpty, margin]);

  // The message at the top of the viewport, and the ones after it in case it is deleted before the next refresh.
  const anchor = useRef<Anchor | null>(null);
  const keepAnchor = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const top = node.scrollTop;
    const row = virtualizer.getVirtualItemForOffset(top);
    if (!row) { anchor.current = null; return; }
    anchor.current = { id: String(row.key), offset: top - row.start, neighbours: itemsRef.current.slice(row.index + 1, row.index + 8).map((item) => item.id) };
  }, [scrollRef, virtualizer]);

  // A page loaded above, or a refresh, leaves the message at the top of the viewport where it was; at the bottom the list stays at the bottom.
  const shown = useRef(items);
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = items;
    const node = scrollRef.current;
    const kept = anchor.current;
    if (!node || before === items || before.length === 0 || atBottom.current || !kept) return;
    // Only appended or changed in place: nothing above the viewport moved.
    if (before.length <= items.length && before.every((item, index) => items[index]?.id === item.id)) return;
    const index = new Map(items.map((item, at) => [item.id, at]));
    const target = [kept.id, ...kept.neighbours].find((id) => index.has(id));
    if (target === undefined) return;
    // The layout position of the row (getOffsetForIndex answers where a scroll would go, which counts a correction still pending).
    virtualizer.getTotalSize();
    const start = virtualizer.measurementsCache[index.get(target)!]?.start;
    if (start === undefined) return;
    const next = Math.max(0, start + (target === kept.id ? kept.offset : 0));
    if (Math.abs(node.scrollTop - next) > 0.5) node.scrollTop = next;
    keepAnchor();
  }, [items, scrollRef, virtualizer, keepAnchor]);

  // use-stick-to-bottom follows growth a frame later (its resize observer sits on an ancestor of the measured rows and waits a frame):
  // a list that was at the bottom is put back there before this commit is painted, so it never shows a frame off the bottom.
  // A scroll position above where the last commit left it is the person scrolling up (the scroll event may not have reached this list yet:
  // the virtualizer re-renders inside it), never something to undo; the browser lowering it by no more than the content got shorter is not.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node || node.clientHeight === 0) return;
    const was = leftAt.current;
    if (was !== null && was.top - node.scrollTop > Math.max(0, was.height - node.scrollHeight) + 1) pinned.current = false;
    if (pinned.current && !state.escapedFromLock && state.isAtBottom) {
      const bottom = node.scrollHeight - node.clientHeight;
      if (bottom - node.scrollTop > 1) node.scrollTop = bottom;
    }
    leftAt.current = { top: node.scrollTop, height: node.scrollHeight };
  }, [items, props.memoryKey, margin, scrollRef, state]);

  // Near the top the next older page is read on its own; the button stays for the keyboard.
  const older = useRef({ hasMore: props.hasMore, loading: props.loadingOlder, onOlder: props.onOlder });
  older.current = { hasMore: props.hasMore, loading: props.loadingOlder, onOlder: props.onOlder };
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const onScroll = () => {
      pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 1;
      keepAnchor();
      const now = older.current;
      if (now.hasMore && !now.loading && node.clientHeight > 0 && node.scrollTop < OLDER_PX && node.scrollHeight > node.clientHeight) void now.onOlder();
    };
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, [scrollRef, keepAnchor]);

  // Bring a message into view: by its index once it is loaded, the older pages read until it is or there are none.
  const [highlight, setHighlight] = useState<string | null>(null);
  const handled = useRef<number | null>(null);
  const { reveal, onRevealed, hasMore, loadingOlder, onOlder } = props;
  useEffect(() => {
    if (!reveal || handled.current === reveal.token) return;
    const index = items.findIndex((item) => item.id === reveal.id);
    if (index < 0) {
      if (loadingOlder) return;
      if (hasMore) { void onOlder(); return; }
      handled.current = reveal.token;
      onRevealed?.(false);
      return;
    }
    handled.current = reveal.token;
    stopScroll();
    virtualizer.scrollToIndex(index, { align: "center" });
    setHighlight(reveal.id);
    onRevealed?.(true);
  }, [reveal, items, hasMore, loadingOlder, onOlder, onRevealed, stopScroll, virtualizer]);
  useEffect(() => {
    if (!highlight) return;
    const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlight]);

  return (
    <div ref={rows} className="chat-rows" data-testid="chat-rows" data-count={items.length} style={{ height: Math.max(0, virtualizer.getTotalSize() - margin) }}>
      {virtualizer.getVirtualItems().map((row) => {
        const item = items[row.index];
        if (!item) return null;
        return (
          <div key={row.key} ref={virtualizer.measureElement} data-index={row.index} className="chat-row" data-highlight={highlight === item.id ? "true" : undefined} style={{ transform: `translateY(${row.start - margin}px)` }}>
            <Bubble t={props.t} item={item} actions={props.actions} formatDate={props.formatDate} />
          </div>
        );
      })}
    </div>
  );
}
