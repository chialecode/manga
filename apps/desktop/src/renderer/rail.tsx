import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  BookOpen, BookText, Clapperboard, Download, Ellipsis, FileText, House, LayoutDashboard, MessageCircle, Network, NotebookPen, Pin, Scissors, Settings,
  type LucideIcon,
} from "lucide-react";
import { HIDEABLE_RAIL_VIEWS, type RailView } from "@manga/contracts";
import { railLayout } from "../../../../packages/app-core/src/domain/shell-layout.ts";
import { Popup } from "./components/popup.tsx";
import { ContextMenu } from "./workspace/context-menu.tsx";

/** The picture of each view of the rail, and of the two things below it. */
export const RAIL_ICON: Record<RailView, LucideIcon> = {
  home: House,
  conversation: MessageCircle,
  novel: BookText,
  comic: BookOpen,
  video: Clapperboard,
  note: NotebookPen,
  whiteboard: LayoutDashboard,
  mindmap: Network,
  draft: FileText,
  roughcut: Scissors,
  downloads: Download,
};

export type RailEntry = { view: RailView; label: string };

export type RailLabels = {
  more: string;
  moreEmpty: string;
  hide: string;
  pin: string;
  /** "固定“{name}”到图标栏". */
  pinOf: (name: string) => string;
  settings: string;
};

/** How a view was chosen: by the pointer (the sidebar or its card follows the hover), or by the keyboard (the card opens and takes the focus). */
export type RailHow = "pointer" | "key";

/**
 * The icon rail (A-99, 交互设计 2.1): the home first, then one icon for each kind of thing the sidebar lists, then "…", and the settings at the bottom. An icon
 * the person took out (right click, "从图标栏隐藏") and one that does not fit the window's height are behind "…", where a click goes straight to the view and the
 * pin puts a hidden one back. Which icons stay is worked out from the window's height, not measured, so a window made taller gives them back at once.
 */
export function Rail(props: {
  height: number;
  entries: RailEntry[];
  hidden: readonly RailView[];
  /** The view the sidebar shows; null while the settings are on. */
  current: RailView | null;
  settings: { active: boolean; onSelect: () => void } | null;
  labels: RailLabels;
  onSelect: (view: RailView, how: RailHow) => void;
  onHide: (view: RailView) => void;
  onPin: (view: RailView) => void;
  /** The pointer came onto an icon or left it (the card of the view comes out or goes). */
  onHover?: { enter: (view: RailView, element: HTMLElement) => void; leave: (view: RailView, event: ReactMouseEvent) => void };
  /** Gives the shell the icon of a view, to return the focus to it. */
  buttonRef?: (view: RailView | "more" | "settings", element: HTMLButtonElement | null) => void;
}) {
  const { labels } = props;
  const byView = useMemo(() => new Map(props.entries.map((entry) => [entry.view, entry])), [props.entries]);
  const layout = railLayout({ height: props.height, views: props.entries.map((entry) => entry.view), hidden: props.hidden, settings: Boolean(props.settings) });
  const [menu, setMenu] = useState<{ x: number; y: number; view: RailView } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const iconOf = (view: RailView) => {
    const Icon = RAIL_ICON[view];
    return <Icon size={20} aria-hidden="true" />;
  };

  const button = (view: RailView) => {
    const entry = byView.get(view)!;
    return (
      <button
        key={view}
        ref={(element) => props.buttonRef?.(view, element)}
        type="button"
        className="rail-button"
        data-testid={`nav-${view}`}
        data-rail-view={view}
        aria-label={entry.label}
        title={entry.label}
        aria-current={props.current === view ? "page" : undefined}
        onClick={(event) => props.onSelect(view, event.detail === 0 ? "key" : "pointer")}
        onMouseEnter={(event) => props.onHover?.enter(view, event.currentTarget)}
        onMouseLeave={(event) => props.onHover?.leave(view, event)}
        onContextMenu={(event) => {
          event.preventDefault();
          if (view !== "home") setMenu({ x: event.clientX, y: event.clientY, view });
        }}
      >{iconOf(view)}</button>
    );
  };

  return (
    <>
      <div className="rail-group" data-testid="rail-views">
        {layout.shown.map((view) => button(view as RailView))}
        {layout.more.length ? (
          <RailMore
            items={layout.more.map((item) => ({ view: item.view as RailView, label: byView.get(item.view as RailView)!.label, hidden: item.why === "hidden" }))}
            current={props.current}
            labels={labels}
            buttonRef={(element) => props.buttonRef?.("more", element)}
            onSelect={props.onSelect}
            onPin={props.onPin}
          />
        ) : null}
      </div>
      <div className="rail-group rail-bottom">
        {props.settings ? (
          <button
            ref={(element) => props.buttonRef?.("settings", element)}
            type="button"
            className="rail-button"
            data-testid="nav-settings"
            aria-label={labels.settings}
            title={labels.settings}
            aria-current={props.settings.active ? "page" : undefined}
            onClick={props.settings.onSelect}
          ><Settings size={20} aria-hidden="true" /></button>
        ) : null}
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={byView.get(menu.view)?.label ?? ""}
          items={[{ id: "hide", label: labels.hide, onSelect: () => props.onHide(menu.view) }]}
          onClose={closeMenu}
          testId="rail-menu"
        />
      ) : null}
    </>
  );
}

/** "…": the views that are not in the rail, each with a pin for the ones the person took out. */
function RailMore(props: {
  items: Array<{ view: RailView; label: string; hidden: boolean }>;
  current: RailView | null;
  labels: RailLabels;
  buttonRef: (element: HTMLButtonElement | null) => void;
  onSelect: (view: RailView, how: RailHow) => void;
  onPin: (view: RailView) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [at, setAt] = useState(0);
  const away = useCallback(() => setOpen(false), []);
  const here = props.current !== null && props.items.some((item) => item.view === props.current);

  // The menu closes when nothing is left in it (the last hidden icon was pinned back).
  useEffect(() => { if (open && props.items.length === 0) setOpen(false); }, [open, props.items.length]);
  useEffect(() => {
    if (!open) return;
    list.current?.querySelectorAll<HTMLButtonElement>("[data-rail-more-item]")[Math.min(at, props.items.length - 1)]?.focus();
  }, [open, at, props.items.length]);

  function close(focusBack: boolean) {
    setOpen(false);
    if (focusBack) button.current?.focus();
  }

  function onKey(event: React.KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>("[data-rail-more-row]");
    const rows = [...(list.current?.querySelectorAll<HTMLElement>("[data-rail-more-row]") ?? [])];
    const index = row ? rows.indexOf(row) : 0;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? (index + 1) % rows.length : event.key === "ArrowUp" ? (index - 1 + rows.length) % rows.length : event.key === "Home" ? 0 : rows.length - 1;
      setAt(next);
      rows[next]?.querySelector<HTMLButtonElement>("[data-rail-more-item]")?.focus();
    } else if (event.key === "ArrowRight" && row) {
      const pin = row.querySelector<HTMLButtonElement>("[data-rail-more-pin]");
      if (pin) { event.preventDefault(); pin.focus(); }
    } else if (event.key === "ArrowLeft" && row && target.hasAttribute("data-rail-more-pin")) {
      event.preventDefault();
      row.querySelector<HTMLButtonElement>("[data-rail-more-item]")?.focus();
    }
  }

  const Icon = Ellipsis;
  return (
    <>
      <button
        ref={(element) => { button.current = element; props.buttonRef(element); }}
        type="button"
        className="rail-button"
        data-testid="rail-more"
        data-rail-view="more"
        aria-label={props.labels.more}
        title={props.labels.more}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-current={here ? "page" : undefined}
        onClick={() => { setAt(0); setOpen((value) => !value); }}
        onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setAt(0); setOpen(true); } }}
      ><Icon size={20} aria-hidden="true" /></button>
      {open ? (
        <Popup anchor={button} boxRef={list} onClose={away} id={listId} role="menu" label={props.labels.more} className="menu-list rail-more-list" testId="rail-more-list" placement="right" onKeyDown={onKey}>
          {props.items.map((item) => {
            const ViewIcon = RAIL_ICON[item.view];
            return (
              <div key={item.view} className="rail-more-row" data-rail-more-row role="none" data-current={props.current === item.view ? "true" : undefined}>
                <button
                  type="button"
                  role="menuitem"
                  data-rail-more-item
                  data-testid={`rail-more-${item.view}`}
                  aria-current={props.current === item.view ? "page" : undefined}
                  onClick={(event) => { close(false); props.onSelect(item.view, event.detail === 0 ? "key" : "pointer"); }}
                ><ViewIcon size={16} aria-hidden="true" /><span>{item.label}</span></button>
                {item.hidden ? (
                  <button
                    type="button"
                    role="menuitem"
                    data-rail-more-pin
                    className="rail-pin"
                    data-testid={`rail-pin-${item.view}`}
                    aria-label={props.labels.pinOf(item.label)}
                    title={props.labels.pin}
                    onClick={(event) => { event.stopPropagation(); props.onPin(item.view); }}
                  ><Pin size={14} aria-hidden="true" /></button>
                ) : null}
              </div>
            );
          })}
        </Popup>
      ) : null}
    </>
  );
}

/** Whether a view can be taken out of the rail (the home cannot). */
export const isHideable = (view: string): view is (typeof HIDEABLE_RAIL_VIEWS)[number] => (HIDEABLE_RAIL_VIEWS as readonly string[]).includes(view);
