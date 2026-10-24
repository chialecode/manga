import { Activity, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type MutableRefObject, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, PanelLeft, PanelRight, Shrink, Square } from "lucide-react";
import { chordOf } from "@manga/contracts/keys";
import type { HideableRailView, RailView } from "@manga/contracts";
import type { ShellPreference } from "@manga/contracts/reading";
import { SIDE_WIDTH, TOP_ROW_HEIGHT, cardOf, clampSide, deriveShell, dragLimit, initialHover, reduceHover, viewOfCard, type HoverTarget } from "../../../../packages/app-core/src/domain/shell-layout.ts";
import { Menu, type MenuItem } from "./components/menu.tsx";
import { WindowControls, type WindowControlLabels } from "./components/window-controls.tsx";
import { useWindowState } from "./hooks/use-window-state.ts";
import { Rail, type RailEntry, type RailHow, type RailLabels } from "./rail.tsx";

export type TopMenu = { id: string; label: string; items: MenuItem[] };

/** What the icon rail shows and does (A-99): the views, the ones taken out, the one the sidebar is on, and the settings at the bottom. */
export type ShellRail = {
  entries: RailEntry[];
  hidden: readonly RailView[];
  /** The view the sidebar shows (kept while the settings are on). */
  current: RailView;
  settings: { active: boolean; onSelect: () => void } | null;
  labels: RailLabels;
  /** An icon was chosen: the sidebar's view changes and the settings, if they were on, are left. */
  onSelect: (view: RailView) => void;
  onHide: (view: RailView) => void;
  onPin: (view: RailView) => void;
  onMove?: (view: HideableRailView, visible: readonly HideableRailView[], to: number) => void;
};

/** What goes in the sidebar's place: a view of the rail, or the settings directory. */
export type SidebarContent = (view: RailView | "settings", options: { variant: "dock" | "card"; onDone?: () => void }) => ReactNode;

type Side = "sidebar" | "dock";

const HOVER_MS = 180;
/** Below this many pixels from the window's top the floating top stays out once the pointer has been over it (the top, its hot zone and the margin). */
const REVEAL_KEEP = TOP_ROW_HEIGHT + 6;
/** A pointer that leaves the page this near its top edge brings the floating top down. */
const REVEAL_REACH = 24;

/** What a drag of a divider shows while it goes on: the width under the pointer, or (past half the least width) the column folded away. */
export type DividerDrag = { width: number; hidden: boolean };

/**
 * The divider between a column and the main area (A-104, 计划 4.4). Dragged, it sets the width between the least and the most; dragged on past half the
 * least width it folds the column away while the pointer is there (a line in the accent says that letting go folds it), and letting go there hides the
 * column with its saved width as it was before the drag. With the sidebar folded away the same divider is the strip at the rail's right edge that pulls
 * it out (`pull`): past half the least width the sidebar comes, follows the pointer, and stays when let go. A cancelled pointer or a window that loses
 * the focus puts everything back. Keys (the APG window splitter): the arrows change the width and stop at the least; Enter folds the column away.
 */
function Divider(props: {
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
    props.onDrag(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.onDrag]);
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
    props.onDrag(next);
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

export type ShellLabels = {
  /** The floating top's button that ends window full screen. */
  exitImmersive: string;
  showSidebar: string;
  hideSidebar: string;
  showDock: string;
  hideDock: string;
  stop: string;
  back: string;
  forward: string;
  menubar: string;
  rail: string;
  sidebar: string;
  dock: string;
  resizeSidebar: string;
  resizeDock: string;
  /** The names of the window's own buttons; without them the page draws none. */
  window?: WindowControlLabels;
};

/**
 * The window (UI-01, A-94, A-99): one row across the top (the sidebar's switch, back and forward for the tab in front, the menus, then the debugging switch,
 * the stop button, the dock's switch and the window's own buttons), and under it the icon rail, the sidebar, the tabbed main area and the dock. A sidebar
 * that is folded away (by the person, or by a window too narrow for it) comes out of the rail as the card of a view when the pointer rests on an icon, and
 * the dock folds into an overlay in a narrow window. While the settings are on, the settings directory takes the sidebar's place and the dock is out of
 * the way; the main area and the dock stay mounted.
 */
export function ShellFrame(props: {
  viewport: { width: number; height: number };
  preference: ShellPreference;
  /** The dock has something to show: false while a conversation tab is in front, since the same conversation is not shown twice. */
  hasDock: boolean;
  /** The settings are on (A-101): the settings directory is the sidebar, the dock is folded away and stays mounted. */
  settings: boolean;
  /** The page fills the whole window (window full screen): everything but the page is out of the way, and the top floats over it as glass. */
  immersive: boolean;
  onExitImmersive: () => void;
  running: boolean;
  labels: ShellLabels;
  menus: TopMenu[];
  rail: ShellRail;
  history: { canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void };
  /** How wide the main area must be to keep its columns apart (the split's own minimum); the side columns fold into overlays before it is crossed. */
  mainFloor?: number;
  /** The keys that open and close the two columns; they do what the buttons do (a folded column opens as an overlay). */
  keys?: { sidebar: readonly string[]; dock: readonly string[] };
  /** Filled with what the menus and keys of the window use to open and close a column the way its button does. */
  controlRef?: MutableRefObject<{ toggle: (side: Side) => void } | null>;
  onHide: (side: Side) => void;
  onShow: (side: Side) => void;
  /** A column's new width, once the divider is let go or a key moved it. */
  onResize: (side: Side, width: number) => void;
  onStop: () => void;
  sidebar: SidebarContent;
  dock: ReactNode;
  /** Buttons before the dock's switch: the debugging switch, recording state, scan progress. */
  titleActions?: ReactNode;
  /** Shown at the bottom right of the main area while the dock is folded away. */
  capsule?: ReactNode;
  /** A panel under the main area (the context debug panel). */
  bottom?: ReactNode;
  children: ReactNode;
}) {
  const [hover, setHover] = useState(initialHover);
  const [dragging, setDragging] = useState<({ side: Side } & DividerDrag) | null>(null);
  const sidebarButton = useRef<HTMLButtonElement>(null);
  const dockButton = useRef<HTMLButtonElement>(null);
  const sidebarPanel = useRef<HTMLElement>(null);
  const dockPanel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  /** The icons of the rail, to give the focus back to the one a card came out of. */
  const railButtons = useRef(new Map<string, HTMLButtonElement>());
  /** A card was opened from the keyboard: the focus goes into it once it is there. */
  const wantFocus = useRef(false);
  const windowState = useWindowState();
  /** In the window-fullscreen state: the floating top has come down because the pointer reached the top edge or is on it. */
  const [revealed, setRevealed] = useState(false);
  const { immersive } = props;
  const settingsOn = props.settings;
  const dockActive = props.hasDock && !settingsOn;

  // A column being dragged shows the width under the pointer; the saved width follows when it is let go. The settings directory shows whatever the sidebar's switch says.
  const preference = (() => {
    let shown = props.preference;
    if (dragging) {
      shown = structuredClone(shown);
      shown[dragging.side].width = dragging.width;
      // Past half the least width the column is already folded away under the pointer (A-104).
      shown[dragging.side].visible = !dragging.hidden;
    }
    if (settingsOn && !shown.sidebar.visible) {
      shown = structuredClone(shown);
      shown.sidebar.visible = true;
    }
    return shown;
  })();
  const overlaySide = hover.overlay === "dock" ? "dock" : hover.overlay ? "sidebar" : null;
  const chrome = deriveShell({ viewport: props.viewport, preference, hasDock: dockActive, overlay: overlaySide, mainFloor: props.mainFloor });
  /** What the sidebar shows when it is docked or opened by its switch. */
  const ownView: RailView | "settings" = settingsOn ? "settings" : props.rail.current;

  useEffect(() => {
    const timer = window.setInterval(() => {
      // A card or an overlay with the focus in it stays. The focus in a docked column holds nothing back: a card can still come out of the rail.
      const holds = (panel: HTMLElement | null) => panel?.getAttribute("data-shell-state") === "overlay" && panel.contains(document.activeElement);
      if (holds(sidebarPanel.current) || holds(dockPanel.current)) return;
      setHover((state) => reduceHover(state, { type: "tick", now: Date.now() }, HOVER_MS));
    }, 40);
    return () => window.clearInterval(timer);
  }, []);

  const buttonOf = (side: Side) => (side === "sidebar" ? sidebarButton : dockButton);
  const panelOf = (side: Side) => (side === "sidebar" ? sidebarPanel : dockPanel);

  /** The sidebar is out of the layout: a card can come out. */
  const cardsAllowed = chrome.sidebar !== "dock" && !immersive;

  /** The pointer is on an icon: its card comes out after a short stay; `immediate` is for the sidebar's own switch, which says what it is for. */
  function enterCard(view: string, element: HTMLElement | null, immediate = false) {
    if (!cardsAllowed) return;
    trigger.current = element;
    setHover((state) => reduceHover(state, { type: "enter", view, now: Date.now() }, HOVER_MS, immediate ? 0 : undefined));
  }

  function enterSide(side: Side) {
    if (side === "sidebar") { enterCard(ownView, sidebarButton.current, true); return; }
    const shown = structuredClone(preference);
    shown[side].visible = true;
    if (deriveShell({ viewport: props.viewport, preference: shown, hasDock: dockActive, overlay: null, mainFloor: props.mainFloor })[side] === "dock") return;
    trigger.current = buttonOf(side).current;
    setHover((state) => reduceHover(state, { type: "enter", side, now: Date.now() }, HOVER_MS));
  }

  /** The pointer is on the card that is out (or on the dock's overlay): it stays. */
  function enterPanel(target: HoverTarget | null) {
    if (!target) return;
    const view = viewOfCard(target);
    setHover((state) => reduceHover(state, view !== null ? { type: "enter", view, now: Date.now() } : { type: "enter", side: "dock", now: Date.now() }, HOVER_MS));
  }

  function leave(target: HoverTarget, event: MouseEvent) {
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    // From an icon (or the switch) onto its card, or from one place of the card to another: the card stays.
    if (next && (target === "dock" ? dockPanel.current : sidebarPanel.current)?.contains(next)) return;
    const view = viewOfCard(target);
    setHover((state) => reduceHover(state, view !== null ? { type: "leave", view, now: Date.now() } : { type: "leave", side: "dock", now: Date.now() }, HOVER_MS));
  }

  function closeOverlay() {
    setHover(initialHover());
  }

  function pin(side: Side) {
    // The settings directory stays while the settings are on: the switch has nothing to fold.
    if (side === "sidebar" && settingsOn && chrome.sidebar === "dock") return;
    if (chrome[side] === "dock") {
      props.onHide(side);
      setHover(initialHover());
      return;
    }
    const shown = structuredClone(preference);
    shown[side].visible = true;
    const expanded = deriveShell({ viewport: props.viewport, preference: shown, hasDock: dockActive, overlay: null, mainFloor: props.mainFloor });
    if (expanded[side] === "dock") {
      props.onShow(side);
      setHover(initialHover());
      return;
    }
    trigger.current = buttonOf(side).current;
    wantFocus.current = true;
    setHover((state) => reduceHover(state, side === "sidebar" ? { type: "pin", view: ownView, now: Date.now() } : { type: "pin", side, now: Date.now() }, HOVER_MS));
  }

  /** An icon of the rail was chosen: the view changes; with the sidebar folded away its card stays with the pointer (A-99), and from the keyboard it opens and takes the focus. */
  function selectView(view: RailView, how: RailHow) {
    props.rail.onSelect(view);
    const after = deriveShell({ viewport: props.viewport, preference: props.preference, hasDock: props.hasDock, overlay: null, mainFloor: props.mainFloor }).sidebar;
    if (after === "dock") { setHover(initialHover()); return; }
    trigger.current = railButtons.current.get(view) ?? null;
    if (how === "key") {
      wantFocus.current = true;
      setHover({ inside: true, overlay: cardOf(view), pinned: cardOf(view), closeAt: null, pending: null, openAt: null });
      return;
    }
    setHover((state) => (state.overlay === cardOf(view) && !state.pinned ? state : reduceHover(initialHover(), { type: "enter", view, now: Date.now() }, HOVER_MS)));
  }

  useEffect(() => {
    if (!hover.pinned || !wantFocus.current) return;
    wantFocus.current = false;
    sidebarPanel.current?.focus();
  }, [hover.pinned, hover.overlay]);

  const pinRef = useRef(pin);
  pinRef.current = pin;
  const keysRef = useRef({ keys: props.keys, hasDock: dockActive, immersive });
  keysRef.current = { keys: props.keys, hasDock: dockActive, immersive };
  useEffect(() => {
    const control = props.controlRef;
    if (!control) return;
    control.current = { toggle: (side) => { if (side === "dock" && !keysRef.current.hasDock) return; pinRef.current(side); } };
    return () => { control.current = null; };
  }, [props.controlRef]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { keys, hasDock, immersive: hidden } = keysRef.current;
      if (!keys || hidden || event.defaultPrevented || event.isComposing || event.repeat) return;
      const chord = chordOf(event);
      if (chord === null) return;
      if (keys.sidebar.includes(chord)) { event.preventDefault(); pinRef.current("sidebar"); }
      else if (hasDock && keys.dock.includes(chord)) { event.preventDefault(); pinRef.current("dock"); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || !hover.overlay) return;
      // Something inside the card (a rename, a menu) or a dialog over it takes the Escape first.
      if (event.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      setHover((state) => reduceHover(state, { type: "escape", now: Date.now() }, HOVER_MS));
      trigger.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hover.overlay]);

  // A card or an overlay that was opened by a key or a button goes when the page outside it is pressed.
  useEffect(() => {
    if (!hover.pinned) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!target) return;
      if (sidebarPanel.current?.contains(target) || dockPanel.current?.contains(target)) return;
      if (target instanceof Element && target.closest(".shell-rail, [data-testid='shell-sidebar-toggle'], [data-testid='shell-dock-toggle'], [data-testid='sidebar-menu'], [role='menu'], [role='dialog']")) return;
      setHover(initialHover());
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [hover.pinned]);

  // A top that is a drag area gets no pointer events while the pointer is on it, so it cannot hide itself by being left. It goes away when the pointer
  // is next seen below it, or when the window-fullscreen state ends. A pointer that is flicked past the strip under the drag strip lands on the drag
  // strip without having been seen over it; the page is told that the pointer left it, and where, and a leave through the top brings the top down.
  useEffect(() => {
    if (!immersive) { setRevealed(false); return; }
    const move = (event: PointerEvent | globalThis.MouseEvent) => { if (event.clientY > REVEAL_KEEP) setRevealed(false); };
    const out = (event: globalThis.MouseEvent) => { if (event.clientY <= REVEAL_REACH) setRevealed(true); };
    window.addEventListener("pointermove", move);
    document.documentElement.addEventListener("mouseleave", out);
    return () => { window.removeEventListener("pointermove", move); document.documentElement.removeEventListener("mouseleave", out); };
  }, [immersive]);

  const sidebarOpen = chrome.sidebar !== "hidden" && !immersive;
  const dockOpen = chrome.dock !== "hidden" && dockActive && !immersive;
  const sidebarDocked = chrome.sidebar === "dock" && !immersive;
  const dockDocked = chrome.dock === "dock" && dockOpen;
  const sidebarLimit = dragLimit("sidebar", props.viewport.width, dockDocked ? chrome.dockWidth : 0, props.mainFloor);
  const dockLimit = dragLimit("dock", props.viewport.width, sidebarDocked ? chrome.sidebarWidth : 0, props.mainFloor);
  const commitWidth = (side: Side, width: number) => props.onResize(side, clampSide(side, width));
  const labels = props.labels;

  const cardTarget = viewOfCard(hover.overlay);
  const cardView: RailView | "settings" = cardTarget === "settings" ? (settingsOn ? "settings" : props.rail.current) : cardTarget !== null ? (cardTarget as RailView) : ownView;
  // The sidebar's content is made again only when what it shows changes: a drag of the divider changes its width, not its lists (计划 4.4).
  const sidebarBody = useMemo(() => (chrome.sidebar === "dock"
    ? props.sidebar(ownView, { variant: "dock" })
    : chrome.sidebar === "overlay"
      ? props.sidebar(cardView, { variant: "card", onDone: closeOverlay })
      : null),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [chrome.sidebar, ownView, cardView, props.sidebar]);
  /** A column folded away from its divider (drag or Enter): the focus goes to the column's switch, where it comes back from (APG window splitter). */
  const collapse = (side: Side) => {
    props.onHide(side);
    setHover(initialHover());
    window.requestAnimationFrame(() => buttonOf(side).current?.focus());
  };
  /** The sidebar can be pulled out from the rail's edge: it is folded away by the person, and the window has room to dock it. */
  const pullable = !immersive && !settingsOn && chrome.sidebar !== "dock" && !props.preference.sidebar.visible
    && deriveShell({ viewport: props.viewport, preference: { ...props.preference, sidebar: { ...props.preference.sidebar, visible: true } }, hasDock: dockActive, overlay: null, mainFloor: props.mainFloor }).sidebar === "dock";
  const onDragOf = (side: Side) => (drag: DividerDrag | null) => setDragging(drag === null ? null : { side, ...drag });

  const stop = props.running ? (
    <button type="button" className="shell-no-drag shell-icon" aria-label={labels.stop} title={labels.stop} data-testid="shell-task-stop" onClick={props.onStop}><Square size={16} /></button>
  ) : null;

  const sidebarToggleLocked = settingsOn && chrome.sidebar === "dock";

  return (
    <div
      className="manga-shell h-full flex flex-col min-h-0"
      data-testid="shell-root"
      data-compact={chrome.compact ? "true" : "false"}
      data-immersive={immersive ? "true" : "false"}
      data-settings={settingsOn ? "true" : "false"}
      data-window-controls={windowState ? (windowState.controls ? "page" : "system") : "none"}
    >
      {/* The window is full of the page: its top edge is still where the window is taken hold of. The strip is a drag area and takes no pointer events, so the hot
          zone under it brings the top down; once down, the top is the drag area (its buttons are not) and the strip and the zone stand aside. */}
      {immersive && !revealed ? <div className="immersive-drag shell-drag" aria-hidden="true" data-testid="immersive-drag" /> : null}
      {immersive && !revealed ? <div className="immersive-hotzone shell-no-drag" data-testid="immersive-hotzone" onPointerEnter={() => setRevealed(true)} onMouseEnter={() => setRevealed(true)} /> : null}
      <header className="shell-top shell-drag" data-testid="shell-top" data-immersive={immersive ? "true" : "false"} data-revealed={immersive && revealed ? "true" : "false"} onPointerEnter={immersive ? () => setRevealed(true) : undefined}>
        <div className="top-left">
          {immersive ? null : (
            <button ref={sidebarButton} type="button" className="shell-no-drag shell-icon" aria-label={sidebarOpen ? labels.hideSidebar : labels.showSidebar} title={sidebarOpen ? labels.hideSidebar : labels.showSidebar} aria-expanded={sidebarOpen} aria-disabled={sidebarToggleLocked || undefined} data-testid="shell-sidebar-toggle" onMouseEnter={() => enterSide("sidebar")} onMouseLeave={(event) => leave(cardOf(ownView), event)} onClick={() => pin("sidebar")}><PanelLeft size={18} /></button>
          )}
          <button type="button" className="shell-no-drag shell-icon" aria-label={labels.back} title={labels.back} disabled={!props.history.canBack} data-testid="nav-back" onClick={props.history.onBack}><ChevronLeft size={18} /></button>
          <button type="button" className="shell-no-drag shell-icon" aria-label={labels.forward} title={labels.forward} disabled={!props.history.canForward} data-testid="nav-forward" onClick={props.history.onForward}><ChevronRight size={18} /></button>
          <nav className="menubar shell-no-drag" aria-label={labels.menubar} data-testid="menubar">
            {props.menus.map((menu) => (
              <Menu key={menu.id} label={menu.label} items={menu.items} testId={`menu-${menu.id}`} className="titlebar-menu" trigger={<span className="menubar-label">{menu.label}</span>} />
            ))}
          </nav>
        </div>
        <span className="top-fill" />
        <div className="top-right">
          {props.titleActions ? <div className="shell-no-drag flex items-center gap-2" data-testid="shell-title-actions">{props.titleActions}</div> : null}
          {stop}
          {immersive ? <button type="button" className="shell-no-drag shell-icon" aria-label={labels.exitImmersive} title={labels.exitImmersive} data-testid="immersive-exit" onClick={props.onExitImmersive}><Shrink size={17} /></button> : null}
          {dockActive && !immersive ? (
            <button ref={dockButton} type="button" className="shell-no-drag shell-icon" aria-label={dockOpen ? labels.hideDock : labels.showDock} title={dockOpen ? labels.hideDock : labels.showDock} aria-expanded={dockOpen} data-testid="shell-dock-toggle" onMouseEnter={() => enterSide("dock")} onMouseLeave={(event) => leave("dock", event)} onClick={() => pin("dock")}><PanelRight size={18} /></button>
          ) : null}
          {labels.window ? <WindowControls labels={labels.window} state={windowState} /> : null}
        </div>
      </header>
      <div className={`shell-body flex-1 min-h-0 flex relative ${chrome.compact ? "shell-compact" : ""}`}>
        {immersive ? null : (
          <nav className="shell-rail" aria-label={labels.rail} data-testid="shell-rail" style={{ width: chrome.railWidth }}>
            <Rail
              height={props.viewport.height}
              entries={props.rail.entries}
              hidden={props.rail.hidden}
              current={settingsOn ? null : props.rail.current}
              settings={props.rail.settings}
              labels={props.rail.labels}
              onSelect={selectView}
              onHide={props.rail.onHide}
              onPin={props.rail.onPin}
              {...(props.rail.onMove ? { onMove: props.rail.onMove } : {})}
              onHover={{ enter: (view, element) => enterCard(view, element), leave: (view, event) => leave(cardOf(view), event) }}
              buttonRef={(view, element) => { if (element) railButtons.current.set(view, element); else railButtons.current.delete(view); }}
            />
          </nav>
        )}
        {sidebarOpen ? (
          <aside
            ref={sidebarPanel}
            tabIndex={-1}
            data-testid="shell-sidebar"
            data-shell-state={chrome.sidebar}
            data-view={chrome.sidebar === "overlay" ? cardView : ownView}
            aria-label={labels.sidebar}
            className={`shell-sidebar ${chrome.sidebar === "overlay" ? "shell-card absolute z-20" : "shrink-0"}`}
            style={{ width: chrome.sidebarWidth, ...(chrome.sidebar === "overlay" ? { top: 0, left: chrome.railWidth } : {}) }}
            onMouseEnter={chrome.sidebar === "overlay" ? () => enterPanel(hover.overlay) : undefined}
            onMouseLeave={chrome.sidebar === "overlay" ? (event) => leave(hover.overlay ?? cardOf(ownView), event) : undefined}
          >
            {sidebarBody}
          </aside>
        ) : null}
        {/* One divider all along a drag, so the pointer it holds is not lost when the sidebar folds away or comes out under it. */}
        {sidebarDocked || pullable || dragging?.side === "sidebar" ? (
          <Divider
            side="sidebar"
            width={chrome.sidebarWidth}
            limit={sidebarLimit}
            label={labels.resizeSidebar}
            pull={!sidebarDocked}
            onDrag={onDragOf("sidebar")}
            onCommit={(width) => commitWidth("sidebar", width)}
            onCollapse={() => collapse("sidebar")}
            onPull={(width) => { props.onShow("sidebar"); commitWidth("sidebar", width); setHover(initialHover()); }}
          />
        ) : null}
        <main data-testid="shell-main" data-measure={chrome.measurePx} className="shell-main flex-1 min-w-0 min-h-0 relative">
          {props.children}
          {props.bottom}
          {dockActive && !dockOpen && !immersive ? props.capsule : null}
        </main>
        {dockDocked || dragging?.side === "dock" ? <Divider side="dock" width={chrome.dockWidth} limit={dockLimit} label={labels.resizeDock} onDrag={onDragOf("dock")} onCommit={(width) => commitWidth("dock", width)} onCollapse={() => collapse("dock")} /> : null}
        {props.hasDock || immersive ? (
          <Activity mode={dockOpen ? "visible" : "hidden"}>
            <aside
              ref={dockPanel}
              tabIndex={-1}
              data-testid="shell-dock"
              data-shell-state={chrome.dock}
              aria-label={labels.dock}
              className={`shell-dock ${chrome.dock === "overlay" ? "absolute bottom-0 right-0 z-20 shadow-md" : "shrink-0"}`}
              style={{ width: chrome.dockWidth || SIDE_WIDTH.dock.initial, ...(chrome.dock === "overlay" ? { top: 0 } : {}) }}
              onMouseEnter={() => enterSide("dock")}
              onMouseLeave={(event) => leave("dock", event)}
            >
              {chrome.dock === "overlay" ? <button type="button" className="m-2 text-sm border px-2 py-1 rounded" data-testid="shell-dock-hide" onClick={() => { setHover(initialHover()); dockButton.current?.focus(); }}>{labels.hideDock}</button> : null}
              <div className="shell-dock-body">{props.dock}</div>
            </aside>
          </Activity>
        ) : null}
      </div>
    </div>
  );
}
