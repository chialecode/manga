import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps, type IDockviewPanelProps, type IWatermarkPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { Columns2, Columns3, LayoutGrid, Plus, Square, X } from "lucide-react";
import { contextFromKey, type WorkspacePreset } from "@manga/contracts";
import type { MessageKey } from "@manga/i18n";
import { Menu } from "../components/menu.tsx";
import { readerContext } from "../lib/reader-context.ts";
import { WindowFullscreenProvider, useWindowFullscreen, type WindowFullscreen } from "../readers/window-fullscreen.tsx";
import { captureBus } from "../voice/capture-bus.ts";
import { ContextMenu, type ContextItem } from "./context-menu.tsx";
import { useTabModel, useWorkspace, useWorkspaceValue } from "./context.tsx";
import { MAX_COLUMNS, MIN_COLUMN_WIDTH, columnsOf, dropMakesColumn } from "./layout.ts";
import { useTabMarks, type TabMark } from "./marks.ts";
import { useServices } from "./services.tsx";
import { TabIcon } from "./tab-icon.tsx";
import { TabProvider, type TabInfo } from "./tab-context.tsx";
import { TabView } from "./views/tab-view.tsx";

type PanelParams = { tabId: string; contextKey: string };

/** A tab's content that fails to draw does not take the window down: the tab says so and can be tried again or closed. */
class TabBoundary extends Component<{ retryLabel: string; closeLabel: string; message: string; onClose: () => void; children: ReactNode }, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("tab content failed", error.message, info.componentStack?.split("\n")[1]?.trim()); }
  render() {
    if (!this.state.failed) return <div key={this.state.attempt} className="tab-boundary-body">{this.props.children}</div>;
    return (
      <section className="page-pad tab-crashed" role="alert" data-testid="tab-crashed">
        <p>{this.props.message}</p>
        <div className="flex gap-2">
          <button type="button" className="secondary-button" onClick={() => this.setState((state) => ({ failed: false, attempt: state.attempt + 1 }))}>{this.props.retryLabel}</button>
          <button type="button" className="secondary-button" onClick={this.props.onClose}>{this.props.closeLabel}</button>
        </div>
      </section>
    );
  }
}

/**
 * One tab's place in the dock. The content of every tab stays in the page while the tab is out of sight (the dock draws panels `always`), which is
 * what keeps a playing video playing when it is moved to another column. Whether the tab is in front is told to its content and to the controller after
 * one frame: moving a tab between columns hides and shows it within the same turn, and the content must not see that as leaving.
 */
function TabPanel(props: IDockviewPanelProps<PanelParams>) {
  const { tabId, contextKey: key } = props.params;
  const s = useServices();
  const controller = useWorkspace();
  const global = useWindowFullscreen();
  const focusedId = useWorkspaceValue((c) => c.focusedTabId(key));
  const contextOn = useWorkspaceValue((c) => c.activeKey === key);
  // The settings are on screen (A-101): the tab stays where it is and keeps what it has loaded, and its content is told it is out of sight.
  const suspended = useWorkspaceValue((c) => c.suspended);
  const [shown, setShown] = useState(() => props.api.isVisible);
  useEffect(() => {
    let frame = 0;
    setShown(props.api.isVisible);
    const watch = props.api.onDidVisibilityChange((event) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setShown(event.isVisible));
    });
    return () => { cancelAnimationFrame(frame); watch.dispose(); };
  }, [props.api]);

  const focused = contextOn && focusedId === tabId;
  const visible = contextOn && shown && !suspended;
  // Going out of sight behind the settings is not leaving: the reader the dock would let go of stays loaded, so coming back reloads nothing.
  const placed = contextOn && shown;
  useEffect(() => { if (!suspended) controller.setVisible(key, tabId, placed); }, [controller, key, tabId, placed, suspended]);
  useEffect(() => {
    if (!focused) return;
    // The Agent follows the reader of the tab in front, and a recording starts from it.
    readerContext.focus(tabId);
    captureBus.focus(tabId);
  }, [focused, tabId]);

  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focused) return;
    // The keys of a reader reach it through the page. A title that was pressed or chosen holds the focus (the strip answers Space and Enter itself), so the content takes it.
    const at = document.activeElement;
    if (at instanceof HTMLElement && at.closest(".dv-tab")) root.current?.focus({ preventScroll: true });
  }, [focused, tabId]);

  const info = useMemo<TabInfo>(() => ({ tabId, contextId: contextFromKey(key), focused, visible }), [tabId, key, focused, visible]);
  // Window full screen shows the tab in front only; the others are not full screen.
  const scoped = useMemo<WindowFullscreen>(() => ({ active: global.active && focused, toggle: global.toggle, exit: global.exit }), [global.active, global.toggle, global.exit, focused]);

  return (
    <div
      ref={root}
      tabIndex={-1}
      className="tab-panel"
      data-testid="tab-panel"
      data-tab={tabId}
      data-focused={focused ? "true" : "false"}
      data-visible={visible ? "true" : "false"}
      onPointerDownCapture={() => { if (!focused && contextOn) controller.focusTab(tabId); }}
    >
      <TabProvider value={info}>
        <WindowFullscreenProvider value={scoped}>
          <TabBoundary message={s.t("tab.crashed")} retryLabel={s.t("tab.retry")} closeLabel={s.t("tab.close")} onClose={() => controller.closeTab(tabId)}>
            <TabView />
          </TabBoundary>
        </WindowFullscreenProvider>
      </TabProvider>
    </div>
  );
}

const COMPONENTS = { tab: TabPanel };

/** The content of a tab takes the keyboard focus once its title has been pressed: the keys of a reader are heard on the page, not on the strip. */
function focusContentOf(tabId: string): void {
  const panel = document.querySelector<HTMLElement>(`[data-testid="tab-panel"][data-tab="${tabId}"][data-focused="true"]`);
  if (panel && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
}

const MARK_KEY: Record<TabMark, string> = { playing: "tab.mark.playing", recording: "tab.mark.recording", running: "tab.mark.running" };

/** The title of a tab: its kind's picture, its name, what is going on in it, and a button that closes it. It is not itself a tab stop; the strip is (see the dock's keyboard rules). */
function TabHeader(props: IDockviewPanelHeaderProps<PanelParams>) {
  const { tabId, contextKey: key } = props.params;
  const s = useServices();
  const controller = useWorkspace();
  const model = useTabModel(key, tabId);
  const marks = useTabMarks(tabId);
  const [title, setTitle] = useState(() => props.api.title ?? model?.title ?? "");
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [active, setActive] = useState(() => props.api.isActive);
  useEffect(() => {
    setTitle(props.api.title ?? "");
    setActive(props.api.isActive);
    const watch = props.api.onDidTitleChange((event) => setTitle(event.title));
    const front = props.api.onDidActiveChange((event) => setActive(event.isActive));
    return () => { watch.dispose(); front.dispose(); };
  }, [props.api]);

  const columns = useWorkspaceValue((c) => c.columns(key));
  const focused = useWorkspaceValue((c) => c.focusedTabId(key) === tabId);
  const closeMenu = useCallback(() => setMenu(null), []);

  function menuItems(): ContextItem[] {
    const group = props.api.group;
    const panels = group.panels;
    const at = panels.findIndex((panel) => panel.id === tabId);
    const items: ContextItem[] = [
      { id: "close", label: s.t("tab.close"), onSelect: () => props.api.close() },
      { id: "close-others", label: s.t("tab.closeOthers"), disabled: panels.length < 2, onSelect: () => panels.filter((panel) => panel.id !== tabId).forEach((panel) => panel.api.close()) },
      { id: "close-right", label: s.t("tab.closeRight"), disabled: at < 0 || at >= panels.length - 1, onSelect: () => panels.slice(at + 1).forEach((panel) => panel.api.close()) },
    ];
    const order = columnsOf(props.containerApi);
    order.forEach((target, index) => {
      if (target.id === group.id) return;
      items.push({ id: `move-${index + 1}`, label: s.t("tab.moveToColumn", { n: index + 1 }), separatorBefore: items.length === 3, onSelect: () => props.api.moveTo({ group: target }) });
    });
    if (columns < MAX_COLUMNS && panels.length > 1) {
      items.push({
        id: "move-new",
        label: s.t("tab.moveToNewColumn"),
        separatorBefore: items.length === 3,
        onSelect: () => {
          const created = props.containerApi.addGroup({ referenceGroup: group, direction: "right" });
          props.api.moveTo({ group: created });
        },
      });
    }
    return items;
  }

  return (
    <div
      className="tab-chip"
      data-testid="tab"
      data-tab={tabId}
      data-kind={model?.kind ?? ""}
      data-active={active ? "true" : "false"}
      data-focused={focused ? "true" : "false"}
      title={title}
      onClick={() => requestAnimationFrame(() => focusContentOf(tabId))}
      onContextMenu={(event) => { event.preventDefault(); controller.focusTab(tabId); setMenu({ x: event.clientX, y: event.clientY }); }}
      onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
      onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); props.api.close(); } }}
    >
      <TabIcon kind={model?.kind ?? ""} mediaKind={typeof model?.target.mediaKind === "string" ? model.target.mediaKind : undefined} />
      <span className="tab-title">{title}</span>
      {marks.map((mark) => <span key={mark} className="tab-mark" data-mark={mark} data-testid={`tab-mark-${mark}`} role="img" aria-label={s.t(MARK_KEY[mark] as never)} title={s.t(MARK_KEY[mark] as never)} />)}
      <button
        type="button"
        className="tab-close"
        data-testid="tab-close"
        tabIndex={-1}
        aria-label={`${s.t("tab.close")}：${title}`}
        title={s.t("tab.close")}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); props.api.close(); }}
      ><X size={13} aria-hidden="true" /></button>
      {menu ? <ContextMenu x={menu.x} y={menu.y} label={title} items={menuItems()} onClose={closeMenu} testId="tab-menu" /> : null}
    </div>
  );
}

const PRESET_ICON: Record<WorkspacePreset, typeof Square> = { single: Square, two: Columns2, three: Columns3, quad: LayoutGrid };

/** The buttons at the right end of a column's tab strip: a new tab in this column, and — in the top-right column — the layout. */
function HeaderActions(props: IDockviewHeaderActionsProps) {
  const s = useServices();
  const controller = useWorkspace();
  useWorkspaceValue((c) => c.version());
  const columns = controller.columns();
  const preset = controller.preset();
  const order = columnsOf(props.containerApi);
  const layoutHere = order[columns >= 4 ? 1 : Math.max(0, columns - 1)]?.id === props.group.id || (order.length === 0);
  const Icon = PRESET_ICON[preset];
  return (
    <div className="tab-actions" data-testid="tab-actions">
      <button type="button" className="tab-action" data-testid="tab-new" aria-label={s.t("tab.new")} title={s.t("tab.new")} onClick={() => { props.group.api.setActive(); s.open.newTab(); }}><Plus size={15} aria-hidden="true" /></button>
      {layoutHere ? (
        <Menu
          label={s.t("layout.menu")}
          testId="layout-menu"
          className="tab-action"
          trigger={<Icon size={15} aria-hidden="true" />}
          align="end"
          items={(["single", "two", "three", "quad"] as const).map((item) => ({ id: item, label: s.t(`layout.${item}` as MessageKey), checked: preset === item, testId: `layout-${item}`, onSelect: () => controller.setPreset(item) }))}
        />
      ) : null}
    </div>
  );
}

/** What an empty column shows: a way to put something in it. */
function Watermark(props: IWatermarkPanelProps) {
  const s = useServices();
  return (
    <div className="workspace-empty" data-testid="workspace-empty">
      <p>{s.t("workspace.empty")}</p>
      <button type="button" className="secondary-button" data-testid="workspace-open-library" onClick={() => { props.group?.api.setActive(); s.open.newTab(); }}>{s.t("workspace.openLibrary")}</button>
    </div>
  );
}

/** The columns of a window too narrow for them: one is shown, and these buttons choose which (the saved layout does not change). */
function ColumnSwitcher(props: { contextKey: string }) {
  const s = useServices();
  const controller = useWorkspace();
  const columns = useWorkspaceValue((c) => c.columns(props.contextKey));
  const active = useWorkspaceValue((c) => c.activeColumn(props.contextKey));
  return (
    <div className="column-switcher" role="group" aria-label={s.t("columns.switch")} data-testid="column-switcher">
      {Array.from({ length: columns }, (_, index) => (
        <button key={index} type="button" className="column-switch" aria-pressed={index === active} data-testid={`column-switch-${index + 1}`} onClick={() => controller.focusColumn(index + 1)}>{s.t("columns.n", { n: index + 1 })}</button>
      ))}
    </div>
  );
}

/**
 * The dock of one context. Every context that is kept on screen has one; the ones not in front are hidden, not unmade, so going back to a context is
 * immediate and a video in it keeps its place. The dock's own layout is the controller's to save and restore (see `WorkspaceController.attach`).
 */
export function ContextHost(props: { contextKey: string }) {
  const { contextKey: key } = props;
  const contextId = contextFromKey(key);
  const controller = useWorkspace();
  const fullscreen = useWindowFullscreen();
  const active = useWorkspaceValue((c) => c.activeKey === key);
  const columns = useWorkspaceValue((c) => c.columns(key));
  const focusedId = useWorkspaceValue((c) => c.focusedTabId(key));
  const [api, setApi] = useState<DockviewApi | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // The dock keeps its instance when the host's effects run again (React's checks, a hidden host) and does not say it is ready a second time, so the host
  // attaches it from here, and lets go of it when the host goes.
  useEffect(() => {
    if (!api) return;
    controller.attach(contextId, api);
    return () => controller.detach(contextId, api);
  }, [api, controller, contextId]);

  useEffect(() => {
    const node = root.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => setWidth(Math.round(entries[0]?.contentRect.width ?? 0)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    const dock = event.api;
    // A fifth column is never made: the drop places that would make one are not offered (A-95). A tab alone in its column moving beside another does not add one.
    dock.onWillShowOverlay((overlay) => {
      if (dock.groups.length < MAX_COLUMNS || !dropMakesColumn(overlay.kind, overlay.position)) return;
      if (overlay.panel && overlay.panel.group.panels.length === 1) return;
      overlay.preventDefault();
    });
    setApi(dock);
  }, []);

  // A window too narrow for the columns, or the window full screen, shows one column: the one with the focus. The layout that is saved stays what it was.
  const across = columns >= 4 ? 2 : columns;
  const squeezed = columns > 1 && width > 0 && width < across * MIN_COLUMN_WIDTH;
  const single = active && (squeezed || fullscreen.active);
  // The least width of a column applies where there are columns to be squeezed against each other. A lone column fills the room there is, however narrow
  // the window: the panels' own minimum would otherwise push it past the window's edge.
  useEffect(() => {
    if (!api) return;
    const minimumWidth = columns > 1 && !single ? MIN_COLUMN_WIDTH : 0;
    for (const group of api.groups) group.api.setConstraints({ minimumWidth });
  }, [api, columns, single]);
  useEffect(() => {
    if (!api) return;
    const panel = focusedId ? api.getPanel(focusedId) : undefined;
    if (single && panel) {
      if (api.hasMaximizedGroup() && !panel.group.api.isMaximized()) api.exitMaximizedGroup();
      if (!panel.group.api.isMaximized()) api.maximizeGroup(panel);
    } else if (api.hasMaximizedGroup()) {
      api.exitMaximizedGroup();
    }
  }, [api, single, focusedId, columns]);

  return (
    <div ref={root} className="context-host" hidden={!active} data-testid="context-host" data-context={key} data-active={active ? "true" : "false"} data-columns={columns} data-single={single ? "true" : "false"}>
      {active && squeezed && !fullscreen.active ? <ColumnSwitcher contextKey={key} /> : null}
      <DockviewReact
        className="dockview-theme-manga"
        components={COMPONENTS}
        defaultTabComponent={TabHeader}
        watermarkComponent={Watermark}
        rightHeaderActionsComponent={HeaderActions}
        onReady={onReady}
        defaultRenderer="always"
        disableFloatingGroups
        noPanelsOverlay="emptyGroup"
      />
    </div>
  );
}

/** The docks of the contexts kept on screen. */
export function WorkspaceHosts() {
  const keys = useWorkspaceValue((c) => JSON.stringify(c.mountedContexts.map((item) => item.key)));
  const list = useMemo(() => JSON.parse(keys) as string[], [keys]);
  return <>{list.map((key) => <ContextHost key={key} contextKey={key} />)}</>;
}

