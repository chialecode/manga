import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { BookOpen, ChevronDown, Eye, Home, MessageCircle, NotebookPen, PanelLeft, PanelRight, PlayCircle, Settings, Sparkles, Square, WandSparkles } from "lucide-react";
import { MangaMark } from "./brand.tsx";
import { DEFAULT_SHELL_PREFERENCE, type ShellPreference, type WorkMode } from "@manga/contracts/reading";
import { deriveShell, initialHover, reduceHover, type OverlaySide } from "../../../../packages/app-core/src/domain/shell-layout.ts";

export type ShellPage = { id: string; label: string; testId: string };
export type ShellSession = {
  sessionId: string;
  title: string;
  kind: string;
  targetId: string | null;
  mode: string | null;
  runCount: number;
  activeRunId: string | null;
  activeRunStatus: string | null;
};

const HOVER_MS = 180;

export function ShellFrame(props: {
  viewport: { width: number; height: number };
  preference?: ShellPreference;
  page: string;
  pages: ShellPage[];
  onPage: (id: string) => void;
  hasRight: boolean;
  running: boolean;
  title: string;
  channel: string;
  modeLabel: string;
  modeHints: Record<WorkMode, string>;
  labels: {
    showLeft: string;
    showRight: string;
    hideLeft: string;
    hideRight: string;
    stop: string;
    modeMenu: string;
  };
  onMode: (mode: WorkMode) => void;
  onHide: (side: "left" | "right") => void;
  onShow: (side: "left" | "right") => void;
  onStop: () => void;
  sessions?: ShellSession[];
  sessionLabels?: { heading: string; empty: string; active: string; kinds?: Record<string, string> };
  currentSession?: string;
  onSession?: (session: ShellSession) => void;
  right?: ReactNode;
  children: ReactNode;
}) {
  const preference = props.preference ?? DEFAULT_SHELL_PREFERENCE;
  const [hover, setHover] = useState(initialHover);
  const [menu, setMenu] = useState(false);
  const [menuIndex, setMenuIndex] = useState(0);
  const modeButton = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const leftButton = useRef<HTMLButtonElement>(null);
  const rightButton = useRef<HTMLButtonElement>(null);
  const leftPanel = useRef<HTMLElement>(null);
  const rightPanel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const modes: WorkMode[] = ["enthusiast", "creator"];
  const chrome = deriveShell({
    viewport: props.viewport,
    preference,
    hasRight: props.hasRight,
    overlay: hover.overlay,
  });

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
      if (menu) {
        event.preventDefault();
        setMenu(false);
        modeButton.current?.focus();
        return;
      }
      if (hover.overlay) {
        event.preventDefault();
        setHover((state) => reduceHover(state, { type: "escape", now: Date.now() }, HOVER_MS));
        trigger.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, hover.overlay, hover.pinned]);

  function onModeKey(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setMenu(true);
      setMenuIndex(modes.indexOf(preference.mode));
      queueMicrotask(() => menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']")[Math.max(0, modes.indexOf(preference.mode))]?.focus());
    }
  }

  function onMenuKey(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? (menuIndex + 1) % modes.length : (menuIndex - 1 + modes.length) % modes.length;
      setMenuIndex(next);
      menuRef.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']")[next]?.focus();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      props.onMode(modes[menuIndex] ?? "enthusiast");
      setMenu(false);
      modeButton.current?.focus();
    }
  }

  const leftOpen = chrome.left !== "hidden";
  const rightOpen = chrome.right !== "hidden" && Boolean(props.right);

  return (
    <div className="manga-shell h-full flex flex-col min-h-0" data-testid="shell-root" data-compact={chrome.compact ? "true" : "false"} data-mode={preference.mode}>
      <header className="shell-drag shell-titlebar h-9 shrink-0 flex items-center gap-2 px-3" style={{ paddingRight: 138 }}>
        <button ref={leftButton} type="button" className="shell-no-drag shell-icon" aria-label={leftOpen ? props.labels.hideLeft : props.labels.showLeft} title={leftOpen ? props.labels.hideLeft : props.labels.showLeft} aria-expanded={leftOpen} data-testid="shell-left-toggle" onMouseEnter={() => enter("left")} onMouseLeave={(event) => leave("left", event)} onClick={() => pin("left")}><PanelLeft size={18} /></button>
        <strong className="truncate min-w-0 text-sm" data-testid="shell-title">{props.title}</strong>
        <span className="shell-channel shell-no-drag text-xs text-[var(--color-subtle)] truncate">{props.channel}</span>
        <span className="flex-1" />
        {props.running ? <button type="button" className="shell-no-drag shell-icon" aria-label={props.labels.stop} title={props.labels.stop} data-testid="shell-task-stop" onClick={props.onStop}><Square size={16} /></button> : null}
        {props.hasRight ? (
          <button ref={rightButton} type="button" className="shell-no-drag shell-icon" aria-label={rightOpen ? props.labels.hideRight : props.labels.showRight} title={rightOpen ? props.labels.hideRight : props.labels.showRight} aria-expanded={rightOpen} data-testid="shell-right-toggle" onMouseEnter={() => enter("right")} onMouseLeave={(event) => leave("right", event)} onClick={() => pin("right")}><PanelRight size={18} /></button>
        ) : null}
      </header>
      <div className={`shell-workspace flex-1 min-h-0 flex relative ${chrome.compact ? "shell-compact" : ""}`}>
        {leftOpen ? (
          <aside
            ref={leftPanel}
            tabIndex={-1}
            data-testid="shell-left"
            data-shell-state={chrome.left}
            className={`shell-navigation ${chrome.left === "overlay" ? "absolute inset-y-0 left-0 z-20 shadow-md" : "shrink-0"} overflow-auto`}
            style={{ width: chrome.leftWidth }}
            onMouseEnter={() => enter("left")}
            onMouseLeave={(event) => leave("left", event)}
          >
            <div className="shell-brand"><span><MangaMark /></span><strong>MANGA</strong></div>
            <div className="relative mode-area">
              <div className="mode-switch" aria-label={props.labels.modeMenu}>
                {modes.map((mode) => <button key={mode} type="button" aria-pressed={preference.mode === mode} data-testid={`mode-quick-${mode}`} onClick={() => props.onMode(mode)}>
                  {mode === "enthusiast" ? <Eye size={16} /> : <WandSparkles size={16} />}
                  {props.modeHints[mode].split("：")[0]}
                </button>)}
              <button
                ref={modeButton}
                type="button"
                className="shell-no-drag mode-more"
                data-testid="mode-menu"
                aria-haspopup="menu"
                aria-expanded={menu}
                aria-label={`${props.labels.modeMenu}：${props.modeLabel}`}
                onClick={() => setMenu((open) => !open)}
                onKeyDown={onModeKey}
              >
                <span className="sr-only">{props.modeLabel}</span><ChevronDown size={14} />
              </button>
              </div>
              {menu ? (
                <div ref={menuRef} role="menu" data-testid="mode-menu-list" className="shell-no-drag absolute left-2 top-12 z-30 bg-[var(--color-surface)] border border-[var(--color-border)] rounded shadow-sm p-1" onKeyDown={onMenuKey}>
                  {modes.map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      role="menuitem"
                      data-testid={`mode-${mode}`}
                      className="block w-full text-left px-3 py-1 rounded data-[current=true]:bg-[var(--color-accent-soft)]"
                      data-current={preference.mode === mode}
                      onClick={() => { props.onMode(mode); setMenu(false); modeButton.current?.focus(); }}
                    >
                      <span>{mode === "enthusiast" ? props.modeHints.enthusiast : props.modeHints.creator}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <nav className="shell-nav" aria-label="主导航">
              {props.pages.filter((item) => item.id !== "settings").map((item) => {
                const Icon = { library: Home, agent: MessageCircle, reading: BookOpen, notes: NotebookPen, animation: PlayCircle, copilot: Sparkles }[item.id] ?? BookOpen;
                return <button key={item.id} type="button" data-testid={item.testId} aria-current={props.page === item.id ? "page" : undefined} onClick={() => props.onPage(item.id)}><Icon size={19} /><span>{item.label}</span></button>;
              })}
            </nav>
            <section className="shell-sessions" data-testid="shell-sessions">
              <h2 className="text-sm mb-1">{props.sessionLabels?.heading ?? "会话"}</h2>
              {(props.sessions?.length ?? 0) === 0
                ? <p className="text-sm text-[var(--color-subtle)]">{props.sessionLabels?.empty ?? ""}</p>
                : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {props.sessions!.map((session) => (
                      <li key={session.sessionId}>
                        <button
                          type="button"
                          className={`shell-session w-full text-left ${session.sessionId === props.currentSession ? "bg-[var(--color-accent-soft)]" : ""}`}
                          data-testid={`session-open-${session.sessionId}`}
                          data-active={Boolean(session.activeRunId)}
                          data-current={session.sessionId === props.currentSession ? "true" : "false"}
                          data-kind={session.kind}
                          onClick={() => props.onSession?.(session)}
                        >
                          <span className="session-cover" aria-hidden="true">{session.kind === "note" ? <NotebookPen size={19} /> : <BookOpen size={19} />}</span>
                          <span className="block truncate" title={session.title}>{session.title}</span>
                          <span className="text-[var(--color-subtle)]"> · {props.sessionLabels?.kinds?.[session.kind] ?? session.kind} · {session.runCount}</span>
                          {session.activeRunId ? <span className="text-[var(--color-accent)]"> · {props.sessionLabels?.active ?? ""}</span> : null}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            </section>
            <div className="shell-nav shell-settings">
              {props.pages.filter((item) => item.id === "settings").map((item) => <button key={item.id} type="button" data-testid={item.testId} aria-current={props.page === item.id ? "page" : undefined} onClick={() => props.onPage(item.id)}><Settings size={19} /><span>{item.label}</span></button>)}
            </div>
            {chrome.left === "overlay" ? <button type="button" className="m-2 text-sm border px-2 py-1 rounded" data-testid="shell-left-hide" onClick={() => { setHover(initialHover()); leftButton.current?.focus(); }}>{props.labels.hideLeft}</button> : null}
          </aside>
        ) : null}
        <main data-testid="shell-main" data-measure={chrome.measurePx} className="shell-content flex-1 min-w-0 overflow-auto" style={{ minWidth: 0 }}>
          {props.children}
        </main>
        {rightOpen ? (
          <aside
            ref={rightPanel}
            tabIndex={-1}
            data-testid="shell-right"
            data-shell-state={chrome.right}
            className={`shell-assistant ${chrome.right === "overlay" ? "absolute inset-y-0 right-0 z-20 shadow-md" : "shrink-0"} bg-[var(--color-surface)] overflow-auto`}
            style={{ width: chrome.rightWidth }}
            onMouseEnter={() => enter("right")}
            onMouseLeave={(event) => leave("right", event)}
          >
            <div className="assistant-heading"><span className="brand-accent"><MangaMark size={23} /></span><strong>MANGA Agent</strong><span className="mode-badge">{props.modeLabel}</span></div>
            {chrome.right === "overlay" ? <button type="button" className="m-2 text-sm border px-2 py-1 rounded" data-testid="shell-right-hide" onClick={() => { setHover(initialHover()); rightButton.current?.focus(); }}>{props.labels.hideRight}</button> : null}
            {props.right}
          </aside>
        ) : null}
      </div>
    </div>
  );
}
