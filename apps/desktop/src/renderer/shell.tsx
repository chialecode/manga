import { Activity, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { BookOpen, Briefcase, ChevronDown, ChevronLeft, ChevronRight, Download, Film, FolderKanban, GalleryVertical, Home, Menu as MenuIcon, MessageCircle, MessageSquare, NotebookPen, PanelLeft, PanelRight, Popcorn, Settings, Shrink, Square, X } from "lucide-react";
import { MangaMark } from "./brand.tsx";
import { DEFAULT_SHELL_PREFERENCE, type ShellPreference, type WorkMode } from "@manga/contracts/reading";
import { SIDE_WIDTH, clampSide, deriveShell, dragLimit, initialHover, reduceHover } from "../../../../packages/app-core/src/domain/shell-layout.ts";
import { Menu, type MenuItem } from "./components/menu.tsx";
import { WindowControls, type WindowControlLabels } from "./components/window-controls.tsx";
import { useWindowState } from "./hooks/use-window-state.ts";
import { useCovers } from "./lib/covers.ts";
import type { SessionProgress } from "./lib/shell-model.ts";

export type ShellPage = { id: string; label: string; testId: string };
export type ShellSession = {
  sessionId: string;
  title: string;
  kind: string;
  targetId: string | null;
  /** Medium of the work a resource session belongs to; the rail groups on it. */
  mediaKind?: string | null;
  workId?: string | null;
  workTitle?: string | null;
  ordinalLabel?: string | null;
  coverId?: string | null;
  progress?: SessionProgress | null;
  mode: string | null;
  runCount: number;
  activeRunId: string | null;
  activeRunStatus: string | null;
  updatedAt?: string;
  /** Whether a resource session's file can be opened now; one that cannot is not listed under 已打开, and keeps its conversation and progress (A-86). */
  openState?: "open" | "outside" | "missing";
};

const HOVER_MS = 180;
/** The height of every column's top: the window's own buttons are this high, and the three tops line up with them. */
const COLUMN_TOP = 36;
/** Below this many pixels from the window's top the floating top stays out once the pointer has been over it (the top, its hot zone and the margin). */
const REVEAL_KEEP = COLUMN_TOP + 6;
/** A pointer that leaves the page this near its top edge brings the floating top down. */
const REVEAL_REACH = 24;

/**
 * Rail groups: the work mode's project sessions first, then one group per medium for the resources that have been opened, then the
 * work mode's general conversations that belong to no project. The entertainment mode's one global conversation is not listed here: it
 * is the conversation page, with its own history. Work pages are not listed either.
 */
const SESSION_GROUPS = ["project", "novel", "comic", "video", "unattached"] as const;
type SessionGroup = (typeof SESSION_GROUPS)[number];
function sessionGroup(session: ShellSession): SessionGroup | null {
  if (session.kind === "project") return "project";
  if (session.kind === "shared") return session.mode === "creator" ? "unattached" : null;
  if (session.kind !== "resource") return null;
  if (session.openState && session.openState !== "open") return null;
  return session.mediaKind === "comic" || session.mediaKind === "video" ? session.mediaKind : "novel";
}

const NAV_ICON = { library: Home, agent: MessageCircle, projects: FolderKanban, reading: BookOpen, comic: GalleryVertical, video: Film, notes: NotebookPen, downloads: Download } as const;

const COLLAPSED_KEY = "manga.rail.collapsed";
function readCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : []);
  } catch { return new Set(); }
}
function writeCollapsed(value: Set<string>): void {
  try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...value])); } catch { /* the state just is not remembered */ }
}

function SessionRow(props: {
  session: ShellSession;
  current: boolean;
  position: string;
  coverUrl?: string;
  closeLabel: string;
  onOpen: () => void;
  onClose?: () => void;
  onMenu?: (event: MouseEvent) => void;
}) {
  const { session } = props;
  const Icon = session.kind === "project" ? FolderKanban : session.kind === "shared" ? MessageSquare : session.mediaKind === "comic" ? GalleryVertical : session.mediaKind === "video" ? Film : BookOpen;
  return (
    <div className={`shell-session-row ${props.current ? "is-current" : ""}`} onContextMenu={props.onMenu}>
      <button
        type="button"
        className="shell-session w-full text-left"
        data-testid={`session-open-${session.sessionId}`}
        data-active={Boolean(session.activeRunId)}
        data-current={props.current ? "true" : "false"}
        data-kind={session.kind}
        onClick={props.onOpen}
      >
        <span className="session-cover" aria-hidden="true">{props.coverUrl ? <img src={props.coverUrl} alt="" loading="lazy" draggable={false} /> : <Icon size={18} />}</span>
        <span className="block truncate session-title" title={session.title}>{session.title}</span>
        <span className="block truncate session-position text-[var(--color-subtle)]" data-testid={`session-position-${session.sessionId}`}>{props.position}</span>
      </button>
      {props.onClose ? (
        <button type="button" className="session-close" data-testid={`session-close-${session.sessionId}`} aria-label={`${props.closeLabel}：${session.title}`} title={props.closeLabel} onClick={(event) => { event.stopPropagation(); props.onClose?.(); }}><X size={13} aria-hidden="true" /></button>
      ) : null}
    </div>
  );
}

/** The divider between two columns: dragged with the pointer, moved with the arrow keys, put back to the default by a double click. */
function Divider(props: {
  side: "left" | "right";
  width: number;
  limit: number;
  label: string;
  onDrag: (width: number | null) => void;
  onCommit: (width: number) => void;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const bounds = SIDE_WIDTH[props.side];
  const direction = props.side === "left" ? 1 : -1;
  const move = (event: ReactPointerEvent) => {
    if (!start.current || !Number.isFinite(event.clientX)) return;
    const next = start.current.width + direction * (event.clientX - start.current.x);
    props.onDrag(Math.max(bounds.min, Math.min(props.limit, Math.round(next))));
  };
  const finish = (event: ReactPointerEvent, commit: boolean) => {
    if (!start.current) return;
    if (!Number.isFinite(event.clientX)) { start.current = null; props.onDrag(null); return; }
    const next = Math.max(bounds.min, Math.min(props.limit, Math.round(start.current.width + direction * (event.clientX - start.current.x))));
    start.current = null;
    props.onDrag(null);
    if (commit) props.onCommit(next);
  };
  const onKey = (event: ReactKeyboardEvent) => {
    const step = event.shiftKey ? 48 : 16;
    const grow = props.side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = props.side === "left" ? "ArrowLeft" : "ArrowRight";
    let next: number | null = null;
    if (event.key === grow) next = props.width + step;
    else if (event.key === shrink) next = props.width - step;
    else if (event.key === "Home") next = bounds.min;
    else if (event.key === "End") next = props.limit;
    else if (event.key === "Enter") next = bounds.initial;
    if (next === null) return;
    event.preventDefault();
    props.onCommit(Math.max(bounds.min, Math.min(props.limit, next)));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={props.width}
      aria-valuemin={bounds.min}
      aria-valuemax={props.limit}
      tabIndex={0}
      className={`shell-divider shell-divider-${props.side}`}
      data-testid={`shell-resize-${props.side}`}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture?.(event.pointerId); start.current = { x: event.clientX, width: props.width }; }}
      onPointerMove={move}
      onPointerUp={(event) => finish(event, true)}
      onPointerCancel={(event) => finish(event, false)}
      onDoubleClick={() => props.onCommit(bounds.initial)}
      onKeyDown={onKey}
    />
  );
}

export function ShellFrame(props: {
  viewport: { width: number; height: number };
  preference?: ShellPreference;
  page: string;
  pages: ShellPage[];
  onPage: (id: string) => void;
  hasRight: boolean;
  /** The right pane has no place on this page (settings) but is still alive behind it: it is kept in the background and comes back as it was. */
  retainRight?: boolean;
  /**
   * The page fills the whole window (window full screen): the columns and their tops are out of the way, and the main top floats over the
   * page as glass, shown when the pointer is at the top edge.
   */
  immersive?: boolean;
  /** Leaves the window-full state; the floating top offers it, since a reader's own bar may be out of sight. */
  onExitImmersive?: () => void;
  running: boolean;
  title: string;
  modeLabel: string;
  /** Each mode's name and the one line that says what it is for; the title bar's switch shows them as the tooltip. */
  modeNames: Record<WorkMode, string>;
  modeHints: Record<WorkMode, string>;
  labels: {
    /** The floating top's button that ends window full screen. */
    exitImmersive?: string;
    showLeft: string;
    showRight: string;
    hideLeft: string;
    hideRight: string;
    stop: string;
    modeGroup: string;
    menu: string;
    back: string;
    forward: string;
    rightTitle: string;
    /** The name of the navigation in the left column, for assistive technology. */
    mainNav?: string;
    resizeLeft: string;
    resizeRight: string;
    /** The names of the window's own buttons; without them the page draws none. */
    window?: WindowControlLabels;
  };
  /** The title bar's menu (settings, scan the library, the debug panel, about, quit). */
  menuItems: MenuItem[];
  /** The window's page history: back and forward walk through the places the person has been. */
  history: { canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void };
  onMode: (mode: WorkMode) => void;
  onHide: (side: "left" | "right") => void;
  onShow: (side: "left" | "right") => void;
  /** A column's new width, once the divider is let go or a key moved it; `null` width puts the default back. */
  onResize?: (side: "left" | "right", width: number) => void;
  onStop: () => void;
  sessions?: ShellSession[];
  sessionLabels?: { empty: string; active: string; close: string; groups?: Record<string, string>; position: (session: ShellSession) => string };
  /** Takes an opened resource, project or conversation off the rail; the thing itself is kept. */
  onCloseSession?: (session: ShellSession) => void;
  /** Replaces the navigation and the session list (the settings navigation). */
  leftSlot?: ReactNode;
  /** Buttons at the right end of the main panel's title segment: debugging, recording state, scan progress. */
  titleActions?: ReactNode;
  currentSession?: string;
  onSession?: (session: ShellSession) => void;
  right?: ReactNode;
  /** Shown at the bottom right of the main panel while the right pane is folded away. */
  capsule?: ReactNode;
  /** A panel under the page (the context debug panel). */
  bottom?: ReactNode;
  /** The page fills the panel and scrolls inside itself (a reader): the panel keeps no scrollbar room of its own. */
  fill?: boolean;
  children: ReactNode;
}) {
  const stored = props.preference ?? DEFAULT_SHELL_PREFERENCE;
  const [hover, setHover] = useState(initialHover);
  const [dragging, setDragging] = useState<{ side: "left" | "right"; width: number } | null>(null);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [railMenu, setRailMenu] = useState<{ session: ShellSession; x: number; y: number } | null>(null);
  const leftButton = useRef<HTMLButtonElement>(null);
  const rightButton = useRef<HTMLButtonElement>(null);
  const leftPanel = useRef<HTMLElement>(null);
  const rightPanel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const modes: WorkMode[] = ["enthusiast", "creator"];
  const windowState = useWindowState();
  /** In the window-fullscreen state: the floating top has come down because the pointer reached the top edge or is on it. */
  const [revealed, setRevealed] = useState(false);
  // A column being dragged shows the width under the pointer; the saved width follows when it is let go.
  const preference = (() => {
    if (!dragging) return stored;
    const shown = structuredClone(stored);
    shown.layouts[shown.mode][dragging.side].width = dragging.width;
    return shown;
  })();
  const chrome = deriveShell({
    viewport: props.viewport,
    preference,
    hasRight: props.hasRight,
    overlay: hover.overlay,
  });
  const listed = props.sessions ?? [];
  const cover = useCovers(listed.map((session) => session.coverId), "grid");

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (leftPanel.current?.contains(document.activeElement) || rightPanel.current?.contains(document.activeElement)) return;
      setHover((state) => reduceHover(state, { type: "tick", now: Date.now() }, HOVER_MS));
    }, 40);
    return () => window.clearInterval(timer);
  }, []);

  function enter(side: "left" | "right") {
    const shown = structuredClone(preference);
    shown.layouts[shown.mode][side].visible = true;
    if (deriveShell({ viewport: props.viewport, preference: shown, hasRight: props.hasRight, overlay: null })[side] === "dock") return;
    trigger.current = side === "left" ? leftButton.current : rightButton.current;
    setHover((state) => reduceHover(state, { type: "enter", side, now: Date.now() }, HOVER_MS));
  }

  function leave(side: "left" | "right", event: MouseEvent) {
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    const panel = side === "left" ? leftPanel.current : rightPanel.current;
    const button = side === "left" ? leftButton.current : rightButton.current;
    if (next && (panel?.contains(next) || button?.contains(next))) return;
    setHover((state) => reduceHover(state, { type: "leave", side, now: Date.now() }, HOVER_MS));
  }

  function pin(side: "left" | "right") {
    if (chrome[side] === "dock") {
      props.onHide(side);
      setHover(initialHover());
      return;
    }
    const shown = structuredClone(preference);
    shown.layouts[shown.mode][side].visible = true;
    const expanded = deriveShell({ viewport: props.viewport, preference: shown, hasRight: props.hasRight, overlay: null });
    if (expanded[side] === "dock") {
      props.onShow(side);
      setHover(initialHover());
      return;
    }
    trigger.current = side === "left" ? leftButton.current : rightButton.current;
    setHover((state) => reduceHover(state, { type: "pin", side, now: Date.now() }, HOVER_MS));
    queueMicrotask(() => (side === "left" ? leftPanel : rightPanel).current?.focus());
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (railMenu) { event.preventDefault(); setRailMenu(null); return; }
      if (hover.overlay) {
        event.preventDefault();
        setHover((state) => reduceHover(state, { type: "escape", now: Date.now() }, HOVER_MS));
        trigger.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [hover.overlay, hover.pinned, railMenu]);

  // A top that is a drag area gets no pointer events while the pointer is on it, so it cannot hide itself by being left. It goes away when the pointer
  // is next seen below it, or when the window-fullscreen state ends. A pointer that is flicked past the strip under the drag strip lands on the drag
  // strip without having been seen over it; the page is told that the pointer left it, and where, and a leave through the top brings the top down.
  useEffect(() => {
    if (!props.immersive) { setRevealed(false); return; }
    const move = (event: PointerEvent | MouseEvent) => { if (event.clientY > REVEAL_KEEP) setRevealed(false); };
    const leave = (event: globalThis.MouseEvent) => { if (event.clientY <= REVEAL_REACH) setRevealed(true); };
    window.addEventListener("pointermove", move);
    document.documentElement.addEventListener("mouseleave", leave);
    return () => { window.removeEventListener("pointermove", move); document.documentElement.removeEventListener("mouseleave", leave); };
  }, [props.immersive]);

  useEffect(() => {
    if (!railMenu) return;
    const close = () => setRailMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("blur", close); };
  }, [railMenu]);

  /** The two modes are one choice: a click picks one, and the arrow keys move the choice (and the focus) between them. */
  function onModeKey(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const next = modes[(modes.indexOf(preference.mode) + 1) % modes.length]!;
    props.onMode(next);
    // The synthetic event is cleared once the handler returns, so the group is taken now.
    const group = event.currentTarget;
    queueMicrotask(() => group.querySelector<HTMLButtonElement>(`[data-testid="mode-${next}"]`)?.focus());
  }

  function toggleGroup(group: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(group)) next.delete(group); else next.add(group);
      writeCollapsed(next);
      return next;
    });
  }

  const immersive = props.immersive === true;
  const leftOpen = chrome.left !== "hidden" && !immersive;
  const rightOpen = chrome.right !== "hidden" && Boolean(props.right) && !immersive;
  const leftDocked = chrome.left === "dock" && !immersive;
  const rightDocked = chrome.right === "dock" && rightOpen;
  const labels = props.sessionLabels;
  const positionOf = labels?.position ?? (() => "");
  const modeLayout = preference.layouts[preference.mode];
  // The widest a column may be dragged to while the main panel keeps its room beside the other column.
  const leftLimit = dragLimit("left", props.viewport.width, rightDocked ? chrome.rightWidth : 0);
  const rightLimit = dragLimit("right", props.viewport.width, leftDocked ? chrome.leftWidth : 0);
  const commitWidth = (side: "left" | "right", width: number) => props.onResize?.(side, clampSide(side, width));

  const defaultLeft = (
    <>
      <div className="shell-brand"><span><MangaMark /></span><strong>MANGA</strong></div>
      <nav className="shell-nav" aria-label={props.labels.mainNav}>
        {props.pages.filter((item) => item.id !== "settings").map((item) => {
          const Icon = NAV_ICON[item.id as keyof typeof NAV_ICON] ?? BookOpen;
          // The page you are on is marked; so is a work page under the shelf it was opened from, which the host reports as the page.
          return <button key={item.id} type="button" data-testid={item.testId} aria-current={props.page === item.id ? "page" : undefined} onClick={() => props.onPage(item.id)}><Icon size={19} /><span>{item.label}</span></button>;
        })}
      </nav>
      <section className="shell-sessions" data-testid="shell-sessions">
        {listed.filter((session) => sessionGroup(session) !== null).length === 0
          ? <p className="text-sm text-[var(--color-subtle)]">{labels?.empty ?? ""}</p>
          : SESSION_GROUPS.map((group) => {
            const rows = listed.filter((session) => sessionGroup(session) === group);
            if (!rows.length) return null;
            const folded = collapsed.has(group);
            const GroupChevron = folded ? ChevronRight : ChevronDown;
            return (
              <div key={group} className="session-group" data-testid={`session-group-${group}`} data-collapsed={folded ? "true" : "false"}>
                <h3 className="session-group-title">
                  <button type="button" className="session-group-toggle" data-testid={`session-fold-${group}`} aria-expanded={!folded} onClick={() => toggleGroup(group)}>
                    <GroupChevron size={14} aria-hidden="true" />
                    <span>{labels?.groups?.[group] ?? group}</span>
                    {folded ? <span className="session-group-count" data-testid={`session-count-${group}`}>{rows.length}</span> : null}
                  </button>
                </h3>
                {folded ? null : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {rows.map((session) => (
                      <li key={session.sessionId}>
                        <SessionRow
                          session={session}
                          current={session.sessionId === props.currentSession}
                          position={positionOf(session)}
                          coverUrl={cover(session.coverId)}
                          closeLabel={labels?.close ?? ""}
                          onOpen={() => props.onSession?.(session)}
                          onClose={props.onCloseSession ? () => props.onCloseSession?.(session) : undefined}
                          onMenu={props.onCloseSession ? (event) => { event.preventDefault(); setRailMenu({ session, x: event.clientX, y: event.clientY }); } : undefined}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
      </section>
      <div className="shell-nav shell-settings">
        {props.pages.filter((item) => item.id === "settings").map((item) => <button key={item.id} type="button" data-testid={item.testId} aria-current={props.page === item.id ? "page" : undefined} onClick={() => props.onPage(item.id)}><Settings size={17} /><span>{item.label}</span></button>)}
      </div>
    </>
  );

  // The mode switch lives in the left column's top. Where that column is not docked there is no room for it, and it moves into the menu.
  const modeItems: MenuItem[] = leftDocked ? [] : modes.map((mode) => ({ id: `mode-${mode}`, label: props.modeNames[mode], checked: preference.mode === mode, onSelect: () => props.onMode(mode) }));

  /** Menu, sidebar, back, forward and (docked) the mode switch: at the left end of the window, in the left column's top or, where that column is not docked, in the main one. */
  const leftControls = (
    <div className="titlebar-seg titlebar-left" data-testid="titlebar-left" data-docked={leftDocked ? "true" : "false"}>
      <Menu label={props.labels.menu} items={[...modeItems, ...props.menuItems]} testId="shell-menu" className="shell-no-drag titlebar-menu" trigger={<MenuIcon size={17} aria-hidden="true" />} />
      {immersive ? null : <button ref={leftButton} type="button" className="shell-no-drag shell-icon" aria-label={leftOpen ? props.labels.hideLeft : props.labels.showLeft} title={leftOpen ? props.labels.hideLeft : props.labels.showLeft} aria-expanded={leftOpen} data-testid="shell-left-toggle" onMouseEnter={() => enter("left")} onMouseLeave={(event) => leave("left", event)} onClick={() => pin("left")}><PanelLeft size={18} /></button>}
      <button type="button" className="shell-no-drag shell-icon" aria-label={props.labels.back} title={props.labels.back} disabled={!props.history.canBack} data-testid="nav-back" onClick={props.history.onBack}><ChevronLeft size={18} /></button>
      <button type="button" className="shell-no-drag shell-icon" aria-label={props.labels.forward} title={props.labels.forward} disabled={!props.history.canForward} data-testid="nav-forward" onClick={props.history.onForward}><ChevronRight size={18} /></button>
      {leftDocked ? (
        <div className="shell-no-drag mode-segment" role="group" aria-label={props.labels.modeGroup} data-testid="mode-switch" onKeyDown={onModeKey}>
          {modes.map((mode) => {
            const Icon = mode === "enthusiast" ? Popcorn : Briefcase;
            const hint = `${props.modeNames[mode]}：${props.modeHints[mode]}`;
            return (
              <button key={mode} type="button" className="mode-segment-button" aria-pressed={preference.mode === mode} aria-label={props.modeNames[mode]} title={hint} data-testid={`mode-${mode}`} data-hint={hint} onClick={() => props.onMode(mode)}>
                <Icon size={16} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );

  /** The assistant's title (docked), the stop button and the toggle of the right column, at the right end of the window. */
  const rightControls = (
    <div className="titlebar-seg titlebar-right" data-testid="titlebar-right" data-docked={rightDocked ? "true" : "false"}>
      {rightDocked ? <div className="titlebar-right-title" data-testid="titlebar-right-title"><span className="brand-accent"><MangaMark size={18} /></span><strong className="truncate">{props.labels.rightTitle}</strong></div> : null}
      <span className="flex-1" />
      {props.running ? <button type="button" className="shell-no-drag shell-icon" aria-label={props.labels.stop} title={props.labels.stop} data-testid="shell-task-stop" onClick={props.onStop}><Square size={16} /></button> : null}
      {props.hasRight && !immersive ? (
        <button ref={rightButton} type="button" className="shell-no-drag shell-icon" aria-label={rightOpen ? props.labels.hideRight : props.labels.showRight} title={rightOpen ? props.labels.hideRight : props.labels.showRight} aria-expanded={rightOpen} data-testid="shell-right-toggle" onMouseEnter={() => enter("right")} onMouseLeave={(event) => leave("right", event)} onClick={() => pin("right")}><PanelRight size={18} /></button>
      ) : null}
    </div>
  );
  /** The window's own buttons at the right end of the last top: the right column's, or the main one's where there is no right column. */
  const windowButtons = props.labels.window ? <WindowControls labels={props.labels.window} state={windowState} /> : null;

  return (
    <div className="manga-shell h-full flex flex-col min-h-0" data-testid="shell-root" data-compact={chrome.compact ? "true" : "false"} data-mode={preference.mode} data-page={props.page} data-immersive={immersive ? "true" : "false"} data-window-controls={windowState ? (windowState.controls ? "page" : "system") : "none"}>
      <div className={`shell-workspace flex-1 min-h-0 flex relative ${chrome.compact ? "shell-compact" : ""}`}>
        {leftOpen ? (
          <aside
            ref={leftPanel}
            tabIndex={-1}
            data-testid="shell-left"
            data-shell-state={chrome.left}
            className={`shell-navigation ${chrome.left === "overlay" ? "absolute bottom-0 left-0 z-20 shadow-md" : "shrink-0"}`}
            style={{ width: chrome.leftWidth, ...(chrome.left === "overlay" ? { top: COLUMN_TOP } : {}) }}
            onMouseEnter={() => enter("left")}
            onMouseLeave={(event) => leave("left", event)}
          >
            {leftDocked ? <div className="column-top shell-drag" data-testid="column-top-left">{leftControls}</div> : null}
            <div className="shell-left-body">
              {props.leftSlot ? <div className="shell-left-scroll">{props.leftSlot}</div> : defaultLeft}
              {chrome.left === "overlay" ? <button type="button" className="m-2 text-sm border px-2 py-1 rounded" data-testid="shell-left-hide" onClick={() => { setHover(initialHover()); leftButton.current?.focus(); }}>{props.labels.hideLeft}</button> : null}
            </div>
          </aside>
        ) : null}
        {leftDocked ? <Divider side="left" width={chrome.leftWidth} limit={leftLimit} label={props.labels.resizeLeft} onDrag={(width) => setDragging(width === null ? null : { side: "left", width })} onCommit={(width) => commitWidth("left", width)} /> : null}
        <div className="shell-main-column flex-1 min-w-0 flex flex-col min-h-0" data-testid="shell-main-column" data-immersive={immersive ? "true" : "false"} data-revealed={immersive && revealed ? "true" : "false"}>
          {/* The window is full of the page: its top edge is still where the window is taken hold of. The strip is a drag area and takes no pointer events, so the hot
              zone under it brings the top down; once down, the top is the drag area (its buttons are not) and the strip and the zone stand aside. */}
          {immersive && !revealed ? <div className="immersive-drag shell-drag" aria-hidden="true" data-testid="immersive-drag" /> : null}
          {immersive && !revealed ? <div className="immersive-hotzone shell-no-drag" data-testid="immersive-hotzone" onPointerEnter={() => setRevealed(true)} onMouseEnter={() => setRevealed(true)} /> : null}
          <div className="column-top shell-drag" data-testid="column-top-main" onPointerEnter={immersive ? () => setRevealed(true) : undefined}>
            <div className="titlebar-seg titlebar-main" data-testid="titlebar-main">
              {leftDocked ? null : leftControls}
              <strong className="truncate min-w-0 text-sm" data-testid="shell-title">{props.title}</strong>
              <span className="flex-1" />
              {props.titleActions ? <div className="shell-no-drag flex items-center gap-2" data-testid="shell-title-actions">{props.titleActions}</div> : null}
              {immersive && props.onExitImmersive ? <button type="button" className="shell-no-drag shell-icon" aria-label={props.labels.exitImmersive} title={props.labels.exitImmersive} data-testid="immersive-exit" onClick={props.onExitImmersive}><Shrink size={17} /></button> : null}
              {rightDocked ? null : rightControls}
            </div>
            {rightDocked ? null : windowButtons}
          </div>
          <main data-testid="shell-main" data-measure={chrome.measurePx} data-fill={props.fill ? "true" : "false"} className="shell-content flex-1 min-w-0" style={{ minWidth: 0 }}>
            {props.children}
            {props.bottom}
            {props.hasRight && !rightOpen && !immersive ? props.capsule : null}
          </main>
        </div>
        {rightDocked ? <Divider side="right" width={chrome.rightWidth} limit={rightLimit} label={props.labels.resizeRight} onDrag={(width) => setDragging(width === null ? null : { side: "right", width })} onCommit={(width) => commitWidth("right", width)} /> : null}
        {rightOpen || (props.retainRight && props.right) || (immersive && props.right) ? (
          <Activity mode={rightOpen ? "visible" : "hidden"}>
            <aside
              ref={rightPanel}
              tabIndex={-1}
              data-testid="shell-right"
              data-shell-state={chrome.right}
              aria-label={`${props.labels.rightTitle} ${props.modeLabel}`}
              className={`shell-assistant ${chrome.right === "overlay" ? "absolute bottom-0 right-0 z-20 shadow-md" : "shrink-0"}`}
              style={{ width: chrome.rightWidth, ...(chrome.right === "overlay" ? { top: COLUMN_TOP } : {}) }}
              onMouseEnter={() => enter("right")}
              onMouseLeave={(event) => leave("right", event)}
            >
              {rightDocked ? <div className="column-top shell-drag" data-testid="column-top-right">{rightControls}{windowButtons}</div> : null}
              {chrome.right === "overlay" ? (
                <>
                  <div className="assistant-heading"><span className="brand-accent"><MangaMark size={20} /></span><strong>{props.labels.rightTitle}</strong><span className="mode-badge">{props.modeLabel}</span></div>
                  <button type="button" className="m-2 text-sm border px-2 py-1 rounded" data-testid="shell-right-hide" onClick={() => { setHover(initialHover()); rightButton.current?.focus(); }}>{props.labels.hideRight}</button>
                </>
              ) : null}
              <div className="shell-right-body">{props.right}</div>
            </aside>
          </Activity>
        ) : null}
      </div>
      {railMenu && props.onCloseSession ? (
        <div className="rail-menu" role="menu" data-testid="session-menu" style={{ left: railMenu.x, top: railMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" data-testid="session-menu-close" onClick={() => { const target = railMenu.session; setRailMenu(null); props.onCloseSession?.(target); }}>{labels?.close ?? ""}</button>
        </div>
      ) : null}
      <span hidden data-left-width={modeLayout.left.width} data-right-width={modeLayout.right.width} />
    </div>
  );
}
