import { Component, createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewHeaderActionsProps, type IDockviewPanelHeaderProps, type IDockviewPanelProps, type IWatermarkPanelProps } from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import { Columns2, Columns3, LayoutGrid, Plus, Square, X } from "lucide-react";
import { contextFromKey, type WorkspacePreset, type WorkspaceView } from "@manga/contracts";
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
import { hostOf, placeTabs, releaseHost, setParking, setSlot } from "./placement.ts";
import { EmptyView } from "./empty-view.tsx";

type PanelParams = { tabId: string; contextKey: string; view?: WorkspaceView };

/** The view a dock shows, for the parts the dock draws itself (titles, buttons, the empty column). */
const DockViewContext = createContext<{ key: string; view: WorkspaceView }>({ key: "", view: "home" });
/** Whether the dock around is the one on screen: a dock of a view out of sight keeps its parts but does not offer them to tests and walks. */
function useDockOnScreen(): boolean {
  const { key, view } = useContext(DockViewContext);
  return useWorkspaceValue((c) => c.activeKey === key && c.view === view);
}

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
 * The content of one tab. It is drawn once per tab into a node of its own (`placement.ts`), and that node is put into the panel of the tab in the
 * dock of the view on screen, or parked out of sight when the view on screen does not hold the tab (A-107): going from one view to another moves the
 * node, it does not make the content again, so a reader keeps its place and a video its time. Whether the tab is in front is told to its content and to
 * the controller after one frame (see `TabSlot`): moving a tab between columns hides and shows it within the same turn, and the content must not see that
 * as leaving.
 */
function TabContent(props: { contextKey: string; tabId: string }) {
  const { tabId, contextKey: key } = props;
  const s = useServices();
  const controller = useWorkspace();
  const global = useWindowFullscreen();
  const focusedId = useWorkspaceValue((c) => c.focusedTabId(key));
  const contextOn = useWorkspaceValue((c) => c.activeKey === key);
  const shown = useWorkspaceValue((c) => c.isShown(key, tabId));
  // The settings are on screen (A-101): the tab stays where it is and keeps what it has loaded, and its content is told it is out of sight.
  const suspended = useWorkspaceValue((c) => c.suspended);

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

/**
 * A tab's place in the dock of one view: an empty slot that the tab's content is moved into while this view is on screen. The dock hides a panel that
 * is not in front by `visibility`; the slot marks itself hidden at once (`data-hidden-layer`, so parts that make themselves visible stay hidden too, 计划
 * 4.8) and tells the controller a frame later.
 */
function TabSlot(props: IDockviewPanelProps<PanelParams>) {
  const { tabId, contextKey: key, view = "home" } = props.params;
  const controller = useWorkspace();
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = slot.current;
    if (!node) return;
    setSlot(key, view, tabId, node);
    return () => setSlot(key, view, tabId, null);
  }, [key, view, tabId]);
  useEffect(() => {
    let frame = 0;
    const mark = (visible: boolean) => {
      if (visible) slot.current?.removeAttribute("data-hidden-layer");
      else slot.current?.setAttribute("data-hidden-layer", "");
    };
    mark(props.api.isVisible);
    controller.setShown(key, view, tabId, props.api.isVisible);
    const watch = props.api.onDidVisibilityChange((event) => {
      mark(event.isVisible);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => controller.setShown(key, view, tabId, event.isVisible));
    });
    return () => { cancelAnimationFrame(frame); watch.dispose(); controller.setShown(key, view, tabId, false); };
  }, [props.api, controller, key, view, tabId]);
  return <div ref={slot} className="tab-slot" data-slot={tabId} />;
}

const COMPONENTS = { tab: TabSlot };

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

  const { view } = useContext(DockViewContext);
  const onScreen = useDockOnScreen();
  const columns = useWorkspaceValue((c) => c.columns(key, view));
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
      data-testid={onScreen ? "tab" : undefined}
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
  const { key, view } = useContext(DockViewContext);
  const onScreen = useDockOnScreen();
  const columns = useWorkspaceValue((c) => c.columns(key, view));
  const preset = useWorkspaceValue((c) => c.preset(key, view));
  const order = columnsOf(props.containerApi);
  const layoutHere = order[columns >= 4 ? 1 : Math.max(0, columns - 1)]?.id === props.group.id || (order.length === 0);
  const Icon = PRESET_ICON[preset];
  return (
    <div className="tab-actions" data-testid={onScreen ? "tab-actions" : undefined}>
      <button type="button" className="tab-action" data-testid="tab-new" aria-label={s.t("tab.new")} title={s.t("tab.new")} onClick={() => { props.group.api.setActive(); s.open.newTab(); }}><Plus size={15} aria-hidden="true" /></button>
      {layoutHere ? (
        <Menu
          label={s.t("layout.menu")}
          testId={onScreen ? "layout-menu" : "layout-menu-hidden"}
          className="tab-action"
          trigger={<Icon size={15} aria-hidden="true" />}
          align="end"
          items={(["single", "two", "three", "quad"] as const).map((item) => ({ id: item, label: s.t(`layout.${item}` as MessageKey), checked: preset === item, testId: `layout-${item}`, onSelect: () => controller.setPreset(item) }))}
        />
      ) : null}
    </div>
  );
}

/** What an empty column shows: a way to put something in it. A feature view with no tab at all says so (A-107, `EmptyView`). */
function Watermark(props: IWatermarkPanelProps) {
  const s = useServices();
  const { key, view } = useContext(DockViewContext);
  const onScreen = useDockOnScreen();
  const none = useWorkspaceValue((c) => c.tabsIn(view, key).length === 0);
  if (view !== "home" && none) return <EmptyView view={view} onScreen={onScreen} />;
  return (
    <div className="workspace-empty" data-testid={onScreen ? "workspace-empty" : undefined}>
      <p>{s.t("workspace.empty")}</p>
      <button type="button" className="secondary-button" data-testid={onScreen ? "workspace-open-library" : undefined} onClick={() => { props.group?.api.setActive(); s.open.newTab(); }}>{s.t("workspace.openLibrary")}</button>
    </div>
  );
}

/** The columns of a window too narrow for them: one is shown, and these buttons choose which (the saved layout does not change). */
function ColumnSwitcher(props: { contextKey: string; view: WorkspaceView }) {
  const s = useServices();
  const controller = useWorkspace();
  const columns = useWorkspaceValue((c) => c.columns(props.contextKey, props.view));
  const active = useWorkspaceValue((c) => c.activeColumn(props.contextKey, props.view));
  return (
    <div className="column-switcher" role="group" aria-label={s.t("columns.switch")} data-testid="column-switcher">
      {Array.from({ length: columns }, (_, index) => (
        <button key={index} type="button" className="column-switch" aria-pressed={index === active} data-testid={`column-switch-${index + 1}`} onClick={() => controller.focusColumn(index + 1)}>{s.t("columns.n", { n: index + 1 })}</button>
      ))}
    </div>
  );
}

/**
 * The dock of one view of a context. The dock of the view on screen is shown; the others stay laid out under it, hidden as a layer (计划 4.8), so going
 * back to a view is immediate and its columns keep their sizes. The dock's own layout is the controller's to save and restore (`WorkspaceController.attach`).
 */
function ViewDock(props: { contextKey: string; view: WorkspaceView; width: number }) {
  const { contextKey: key, view, width } = props;
  const contextId = contextFromKey(key);
  const controller = useWorkspace();
  const fullscreen = useWindowFullscreen();
  const active = useWorkspaceValue((c) => c.activeKey === key && c.view === view);
  const columns = useWorkspaceValue((c) => c.columns(key, view));
  const focusedId = useWorkspaceValue((c) => (c.view === view ? c.focusedTabId(key) : null));
  const [api, setApi] = useState<DockviewApi | null>(null);
  const scope = useMemo(() => ({ key, view }), [key, view]);

  // The dock keeps its instance when the host's effects run again (React's checks, a hidden host) and does not say it is ready a second time, so the host
  // attaches it from here, and lets go of it when the host goes.
  useEffect(() => {
    if (!api) return;
    controller.attach(contextId, api, view);
    return () => controller.detach(contextId, api, view);
  }, [api, controller, contextId, view]);

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
    const apply = () => { for (const group of api.groups) group.api.setConstraints({ minimumWidth }); };
    apply();
    // A dock's first group comes with its first tab, and a layout read back makes new groups, with the number of columns the same as before.
    const added = api.onDidAddGroup(apply);
    const restored = api.onDidLayoutFromJSON(apply);
    return () => { added.dispose(); restored.dispose(); };
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
    <div className="view-dock" data-testid={active ? "view-dock" : undefined} data-view={view} data-columns={columns} data-single={single ? "true" : "false"} {...(active ? {} : { "data-hidden-layer": "", inert: true })}>
      {active && squeezed && !fullscreen.active ? <ColumnSwitcher contextKey={key} view={view} /> : null}
      <DockViewContext.Provider value={scope}>
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
      </DockViewContext.Provider>
    </div>
  );
}

const SEP = String.fromCharCode(10);

/** The content of every tab of a context, each drawn once into its own node (see `TabContent`); the nodes are then put where the view on screen wants them. */
function TabContents(props: { contextKey: string }) {
  const { contextKey: key } = props;
  const ids = useWorkspaceValue((c) => c.tabsOf(key).map((tab) => tab.id).join(SEP));
  const list = useMemo(() => (ids ? ids.split(SEP) : []), [ids]);
  const kept = useRef(new Set<string>());
  useEffect(() => {
    // The node of a tab that was closed goes with it.
    const now = new Set(list);
    for (const tabId of kept.current) if (!now.has(tabId)) releaseHost(key, tabId);
    kept.current = now;
  }, [key, list]);
  useEffect(() => () => { for (const tabId of kept.current) releaseHost(key, tabId); }, [key]);
  return <>{list.map((tabId) => createPortal(<TabContent contextKey={key} tabId={tabId} />, hostOf(key, tabId), tabId))}</>;
}

/**
 * Delete and Backspace on a tab do not close it (LOOP-24 3, 计划 4.8): dockview has no option for it, so the two keys are stopped on the way down when
 * the tab itself has the focus. Every other key (the arrows, Home, End, Enter, Space) still reaches dockview, Ctrl+W still closes, and a text box
 * inside a tab is not a tab, so Backspace deletes there as always. A change of dockview's keys is caught by `tests/shell/workspace-keys.test.tsx`.
 */
function keepTabsFromKeys(event: ReactKeyboardEvent<HTMLDivElement>) {
  if (event.key !== "Delete" && event.key !== "Backspace") return;
  const target = event.target as HTMLElement | null;
  if (!target || target.isContentEditable || target.closest("input, textarea, select")) return;
  if (!target.classList.contains("dv-tab")) return;
  event.stopPropagation();
  event.preventDefault();
}

/**
 * Everything of one context on the page: the docks of the views seen in it, the content of its tabs, and a hidden layer where the content of the tabs
 * that the view on screen does not hold waits. Every context that is kept on screen has one; the ones not in front are hidden, not unmade, so going back
 * to a context is immediate and a video in it keeps its place.
 */
export function ContextHost(props: { contextKey: string }) {
  const { contextKey: key } = props;
  const controller = useWorkspace();
  const active = useWorkspaceValue((c) => c.activeKey === key);
  const views = useWorkspaceValue((c) => c.dockViews(key).join(","));
  const view = useWorkspaceValue((c) => c.view);
  const columns = useWorkspaceValue((c) => c.columns(key));
  const version = useWorkspaceValue((c) => c.version());
  const root = useRef<HTMLDivElement>(null);
  const parking = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = root.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => setWidth(Math.round(entries[0]?.contentRect.width ?? 0)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    setParking(key, parking.current);
    return () => setParking(key, null);
  }, [key]);
  // After every change of the workspace the content of each tab is where the view on screen wants it.
  useLayoutEffect(() => { placeTabs(key, view, controller.tabsOf(key).map((tab) => tab.id)); }, [key, controller, version, views, view]);

  return (
    <div ref={root} className="context-host" hidden={!active} data-testid="context-host" data-context={key} data-active={active ? "true" : "false"} data-view={view} data-columns={columns} onKeyDownCapture={keepTabsFromKeys}>
      {(views ? (views.split(",") as WorkspaceView[]) : []).map((item) => <ViewDock key={item} contextKey={key} view={item} width={width} />)}
      <div ref={parking} className="tab-parking" data-hidden-layer="" aria-hidden="true" />
      <TabContents contextKey={key} />
    </div>
  );
}

/** The docks of the contexts kept on screen. */
export function WorkspaceHosts() {
  const keys = useWorkspaceValue((c) => JSON.stringify(c.mountedContexts.map((item) => item.key)));
  const list = useMemo(() => JSON.parse(keys) as string[], [keys]);
  return <>{list.map((key) => <ContextHost key={key} contextKey={key} />)}</>;
}
