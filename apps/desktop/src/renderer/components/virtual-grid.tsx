import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { observeElementRect, useVirtualizer } from "@tanstack/react-virtual";

export type GridLayout =
  | { kind: "grid"; minCard: number; gap: number; coverRatio: number; textHeight: number }
  | { kind: "list"; rowHeight: number };

/** How many cards fit one row at this width, and how wide each is. */
export function gridMetrics(width: number, layout: GridLayout): { columns: number; cardWidth: number; rowHeight: number; gap: number } {
  if (layout.kind === "list") return { columns: 1, cardWidth: width, rowHeight: layout.rowHeight, gap: 0 };
  const usable = Math.max(layout.minCard, width);
  const columns = Math.max(1, Math.floor((usable + layout.gap) / (layout.minCard + layout.gap)));
  const cardWidth = (usable - layout.gap * (columns - 1)) / columns;
  return { columns, cardWidth, rowHeight: Math.round(cardWidth * layout.coverRatio + layout.textHeight + layout.gap), gap: layout.gap };
}

/**
 * A scrolling grid (or list) that only mounts the rows in view, so ten thousand works cost the same as fifty. Focus moves with
 * the arrow keys, Home and End; one card is in the tab order. Rows past the loaded ones are requested as the end comes near.
 */
export function VirtualGrid<T>(props: {
  items: T[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  layout: GridLayout;
  label: string;
  testId: string;
  getKey: (item: T) => string;
  renderItem: (item: T, index: number, tabbable: boolean, cardWidth: number) => ReactNode;
  /** Shown below the last row while more pages are coming. */
  footer?: ReactNode;
  /** Where the list was scrolled the last time it was shown; it is put back once enough rows are loaded, and every scroll is reported. */
  scrollMemory?: { top: number; save: (top: number) => void };
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const pendingFocus = useRef<number | null>(null);
  const restore = useRef<number | null>(props.scrollMemory && props.scrollMemory.top > 0 ? props.scrollMemory.top : null);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => setWidth(Math.floor(node.clientWidth || node.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const metrics = useMemo(() => gridMetrics(width || 800, props.layout), [width, props.layout]);
  const rows = Math.ceil(props.items.length / metrics.columns);
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scroller.current,
    estimateSize: () => metrics.rowHeight,
    overscan: 3,
    // Without layout (tests, first paint) a window of rows is still drawn.
    initialRect: { width: width || 800, height: 640 },
    observeElementRect: (instance, callback) => observeElementRect(instance, (rect) => callback(rect.height > 0 ? rect : { width: rect.width || 800, height: 640 })),
  });

  useEffect(() => { virtualizer.measure(); }, [metrics.rowHeight, virtualizer]);
  useEffect(() => { if (focusIndex >= props.items.length) setFocusIndex(Math.max(0, props.items.length - 1)); }, [props.items.length, focusIndex]);

  const virtualRows = virtualizer.getVirtualItems();
  const lastVisible = virtualRows[virtualRows.length - 1]?.index ?? -1;
  useEffect(() => {
    if (props.hasMore && !props.loading && lastVisible >= rows - 2) props.onLoadMore();
  }, [lastVisible, rows, props.hasMore, props.loading, props.onLoadMore]);

  // Coming back to a list: wait until the rows that were scrolled past are loaded, then put the view where it was.
  useEffect(() => {
    const node = scroller.current;
    const wanted = restore.current;
    if (!node || wanted === null) return;
    if (node.scrollHeight - node.clientHeight >= wanted || (!props.hasMore && !props.loading && props.items.length > 0)) {
      node.scrollTop = wanted;
      restore.current = null;
    } else if (props.hasMore && !props.loading) props.onLoadMore();
  });

  useEffect(() => {
    if (pendingFocus.current === null) return;
    const target = scroller.current?.querySelector<HTMLElement>(`[data-index="${pendingFocus.current}"].work-open, [data-index="${pendingFocus.current}"][data-grid-item]`);
    if (target) { target.focus(); pendingFocus.current = null; }
  });

  function move(next: number) {
    const clamped = Math.max(0, Math.min(props.items.length - 1, next));
    setFocusIndex(clamped);
    pendingFocus.current = clamped;
    virtualizer.scrollToIndex(Math.floor(clamped / metrics.columns), { align: "auto" });
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
    const target = event.target as HTMLElement;
    if (!target.matches?.("[data-index]")) return;
    const at = Number(target.getAttribute("data-index"));
    const cols = metrics.columns;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = at + 1;
    else if (event.key === "ArrowLeft") next = at - 1;
    else if (event.key === "ArrowDown") next = props.layout.kind === "list" ? at + 1 : at + cols;
    else if (event.key === "ArrowUp") next = props.layout.kind === "list" ? at - 1 : at - cols;
    else if (event.key === "Home") next = event.shiftKey ? at : 0;
    else if (event.key === "End") next = props.items.length - 1;
    else if (event.key === "PageDown") next = at + cols * 3;
    else if (event.key === "PageUp") next = at - cols * 3;
    if (next === null) return;
    event.preventDefault();
    if (next >= props.items.length && props.hasMore) props.onLoadMore();
    move(next);
  }

  return (
    <div
      ref={scroller}
      className="virtual-scroll"
      data-testid={props.testId}
      data-columns={metrics.columns}
      data-total={props.total}
      data-loaded={props.items.length}
      role="list"
      aria-label={props.label}
      aria-rowcount={rows}
      onKeyDown={onKeyDown}
      onScroll={(event) => { if (restore.current === null) props.scrollMemory?.save(event.currentTarget.scrollTop); }}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualRows.map((row) => {
          const start = row.index * metrics.columns;
          const slice = props.items.slice(start, start + metrics.columns);
          return (
            <div
              key={row.key}
              role="presentation"
              className="virtual-row"
              style={{ position: "absolute", top: 0, left: 0, width: "100%", height: row.size, transform: `translateY(${row.start}px)`, display: "grid", gridTemplateColumns: `repeat(${metrics.columns}, minmax(0, 1fr))`, columnGap: metrics.gap, alignContent: "start" }}
            >
              {slice.map((item, offset) => (
                <div role="listitem" key={props.getKey(item)} className="virtual-cell">{props.renderItem(item, start + offset, start + offset === focusIndex, metrics.cardWidth)}</div>
              ))}
            </div>
          );
        })}
      </div>
      {props.footer}
    </div>
  );
}
