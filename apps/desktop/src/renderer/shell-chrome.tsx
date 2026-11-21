import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { SIDE_WIDTH } from "../../../../packages/app-core/src/domain/shell-layout.ts";

export type Side = "sidebar" | "dock";

/** What a drag of a divider shows while it goes on: the width under the pointer, or (past half the least width) the column folded away. */
export type DividerDrag = { width: number; hidden: boolean };

/**
 * The divider between a column and the main area (A-104, 计划 4.4). Dragged, it sets the width between the least and the most; dragged on past half the
 * least width it folds the column away while the pointer is there (a line in the accent says that letting go folds it), and letting go there hides the
 * column with its saved width as it was before the drag. With the sidebar folded away the same divider is the strip at the rail's right edge that pulls
 * it out (`pull`): past half the least width the sidebar comes, follows the pointer, and stays when let go. A cancelled pointer or a window that loses
 * the focus puts everything back. Keys (the APG window splitter): the arrows change the width and stop at the least; Enter folds the column away.
 */
export function Divider(props: {
  side: Side;
  width: number;
  limit: number;
  label: string;
  /** The sidebar is folded away: the divider is the strip that pulls it out. */
  pull?: boolean;
  onDrag: (drag: DividerDrag | null) => void;
  onCommit: (width: number) => void;
  /** Let go past the threshold, or Enter: the column goes. */
  onCollapse: () => void;
  /** Pulled out past the threshold and let go: the column comes, this wide. */
  onPull?: (width: number) => void;
}) {
  const start = useRef<{ x: number; width: number; pull: boolean; pointerId: number } | null>(null);
  const [state, setState] = useState<DividerDrag | null>(null);
  const onDragRef = useRef(props.onDrag);
  onDragRef.current = props.onDrag;
  const bounds = SIDE_WIDTH[props.side];
  const direction = props.side === "sidebar" ? 1 : -1;
  const clampTo = (value: number) => Math.max(bounds.min, Math.min(props.limit, Math.round(value)));
  const measure = (clientX: number): DividerDrag => {
    const from = start.current!;
    const raw = from.width + direction * (clientX - from.x);
    return raw < bounds.min / 2 ? { width: from.pull ? bounds.min : clampTo(from.width), hidden: true } : { width: clampTo(raw), hidden: false };
  };
  const stop = useCallback(() => {
    start.current = null;
    setState(null);
    onDragRef.current(null);
  }, []);
  // A window that loses the focus in the middle of a drag, or Esc, gets back what it had.
  const dragging = state !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); stop(); } };
    window.addEventListener("blur", stop);
    window.addEventListener("keydown", onKey, true);
    return () => { window.removeEventListener("blur", stop); window.removeEventListener("keydown", onKey, true); };
  }, [dragging, stop]);

  const move = (event: ReactPointerEvent) => {
    if (!start.current || start.current.pointerId !== event.pointerId || !Number.isFinite(event.clientX)) return;
    const next = measure(event.clientX);
    setState(next);
    onDragRef.current(next);
  };
  const finish = (event: ReactPointerEvent, commit: boolean) => {
    const from = start.current;
    if (!from || from.pointerId !== event.pointerId) return;
    if (!commit || !Number.isFinite(event.clientX)) { stop(); return; }
    const next = measure(event.clientX);
    stop();
    if (from.pull) { if (!next.hidden) props.onPull?.(next.width); return; }
    if (next.hidden) props.onCollapse(); else props.onCommit(next.width);
  };
  const onKey = (event: ReactKeyboardEvent) => {
    if (props.pull) return;
    const step = event.shiftKey ? 48 : 16;
    const grow = props.side === "sidebar" ? "ArrowRight" : "ArrowLeft";
    const shrink = props.side === "sidebar" ? "ArrowLeft" : "ArrowRight";
    if (event.key === "Enter") { event.preventDefault(); props.onCollapse(); return; }
    let next: number | null = null;
    if (event.key === grow) next = props.width + step;
    else if (event.key === shrink) next = props.width - step;
    else if (event.key === "Home") next = bounds.min;
    else if (event.key === "End") next = props.limit;
    if (next === null) return;
    event.preventDefault();
    props.onCommit(clampTo(next));
  };
  const hidden = state ? state.hidden : Boolean(props.pull);
  // A docked column dragged past the threshold is still this divider, with its line, until it is let go.
  const strip = Boolean(props.pull) && !(start.current && !start.current.pull);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={hidden ? 0 : (state?.width ?? props.width)}
      aria-valuemin={0}
      aria-valuemax={props.limit}
      tabIndex={props.pull ? -1 : 0}
      className={`shell-divider shell-divider-${props.side}${strip ? " shell-pullout" : ""}`}
      data-testid={strip ? "shell-pullout" : `shell-resize-${props.side}`}
      data-collapsing={state && state.hidden && !start.current?.pull ? "true" : undefined}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture?.(event.pointerId);
        start.current = { x: event.clientX, width: props.pull ? 0 : props.width, pull: Boolean(props.pull), pointerId: event.pointerId };
      }}
      // Text selected across the page must not turn this press into a drag of the selection, which would cancel the pointer.
      onDragStart={(event) => event.preventDefault()}
      onPointerMove={move}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onLostPointerCapture={(event) => { if (start.current?.pointerId === event.pointerId) stop(); }}
      onDoubleClick={() => { if (!props.pull) props.onCommit(bounds.initial); }}
      onKeyDown={onKey}
    />
  );
}

/** Below this much room beside the end of the title bar, the main area's tabs go to a row of their own under it. */
const TAB_ROOM_MIN = 200;

/**
 * The buttons at the right end of the title bar. Where they stand over the main area's tab strip, their width is put on the main area
 * (`--title-end-w`), so the strip of the top-right column and the capsule leave them room. A main area too narrow for tabs beside them (a phone-shaped
 * window) gives the title bar a row of its own and the tabs go under it (`data-title-row="own"`, A-136).
 */
export function TitleEnd(props: { measure: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = root.current;
    const host = node?.closest<HTMLElement>(".shell-main");
    if (!props.measure || !node || !host) return;
    const update = () => {
      const width = Math.ceil(node.getBoundingClientRect().width || node.offsetWidth);
      host.style.setProperty("--title-end-w", `${width}px`);
      const room = host.getBoundingClientRect().width - width;
      if (host.clientWidth > 0 && room < TAB_ROOM_MIN) host.setAttribute("data-title-row", "own");
      else host.removeAttribute("data-title-row");
    };
    update();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(update) : null;
    observer?.observe(node);
    observer?.observe(host);
    return () => { observer?.disconnect(); host.style.removeProperty("--title-end-w"); host.removeAttribute("data-title-row"); };
  }, [props.measure]);
  return <div ref={root} className="title-end" data-testid="title-end">{props.children}</div>;
}
