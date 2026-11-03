import type { DockviewApi, IDockviewPanel } from "dockview-react";
import {
  EMPTY_WORKSPACE_STATE, WORKSPACE_TAB_LIMIT, contextKey, isFeatureView, viewOfTab,
  type ClosedPlace, type ContextId, type WorkspacePreset, type WorkspaceState, type WorkspaceTab, type WorkspaceView, type WorkspaceViewLayout,
} from "@manga/contracts";
import { MIN_COLUMN_WIDTH, applyPreset, columnsOf, presetOfCount } from "./layout.ts";
import { tabMarks } from "./marks.ts";
import {
  READER_KIND, canStep, findByKey, makeTab, navigateTab, pushClosed, retargetTab, retitleTab, stepTab, type OpenRequest, type Target,
} from "./model.ts";

/** Something a tab's content is asked to do once, in addition to what the tab shows (a place to jump to, a block to show). `n` tells one request from the next. */
export type Launch = { n: number } & Record<string, unknown>;

/** What the controller needs from the application. */
export type WorkspaceEnv = {
  /** Runs a command and answers `{ ok, value }` (the renderer's `attempt`). */
  call: (commandId: string, input?: unknown) => Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: { message: string } }>;
  /** The title a tab has before its content has named it. */
  titleFor: (request: Pick<OpenRequest, "kind" | "target">) => string;
  /** The tabs a context that has none yet (a project just made, the first start) opens with. */
  seed?: (contextId: ContextId) => OpenRequest[];
  /** More tabs than a context keeps. */
  onLimit?: () => void;
  onError?: (message: string) => void;
  /**
   * The controller moved to another view (A-107): something of another kind was opened in a feature view, or a tab closed in another view came back.
   * The shell keeps the view on screen (its rail and sidebar follow); without it the controller only changes its own.
   */
  onView?: (view: WorkspaceView) => void;
};

/** The arrangement of one view of a context: the layout of its dock, the tab in front, and the dock itself while it is on the page. */
type Dock = {
  view: WorkspaceView;
  preset: WorkspacePreset;
  layout: Record<string, unknown> | null;
  focusedTab: string | null;
  /** The view has been on screen in this context: its dock is made, and stays (hidden) when another view is on. */
  visited: boolean;
  api: DockviewApi | null;
  syncing: boolean;
  columns: number;
  activeColumn: number;
  /** Where each panel is (column, place in the strip), read at each change: what a closed tab comes back to. */
  places: Map<string, { column: number; index: number }>;
  /** The panels this dock shows (in front in their column), as the dock last said. */
  shown: Set<string>;
  dispose: Array<() => void>;
};

type Ctx = {
  key: string;
  contextId: ContextId;
  loaded: boolean;
  /** The project this context belongs to does not exist. */
  missing: boolean;
  loading: Promise<void> | null;
  tabs: WorkspaceTab[];
  closed: WorkspaceTab[];
  docks: Map<WorkspaceView, Dock>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  saving: Promise<unknown>;
  /** Saves of this context that have been sent and not answered; a save with none before it is sent at once, so it reaches the host that was there. */
  inflight: number;
  launches: Map<string, Launch>;
  /** Fields of the saved state this version does not know, written back unchanged. */
  extra: Record<string, unknown>;
};

const SAVE_DELAY_MS = 500;
/** Readers out of sight that stay loaded (A-95): the ones used last. */
export const HIDDEN_READERS = 2;
/** Contexts whose arrangement stays on screen (hidden) so that going back to one is immediate. */
export const MOUNTED_CONTEXTS = 3;

const emptyDock = (view: WorkspaceView, saved?: Partial<WorkspaceViewLayout>): Dock => ({
  view, preset: saved?.preset ?? "single", layout: saved?.layout ?? null, focusedTab: saved?.focusedTab ?? null, visited: false, api: null, syncing: false,
  columns: 1, activeColumn: 0, places: new Map(), shown: new Set(), dispose: [],
});

const emptyCtx = (contextId: ContextId): Ctx => ({
  key: contextKey(contextId), contextId, loaded: false, missing: false, loading: null, tabs: [], closed: [], docks: new Map([["home", emptyDock("home")]]),
  saveTimer: null, saving: Promise.resolve(), inflight: 0, launches: new Map(), extra: {},
});

/** Whether a tab is in a view: the home holds every tab, a feature view the tabs of its kind (计划 4.1). */
export const inView = (tab: Pick<WorkspaceTab, "kind" | "target">, view: WorkspaceView): boolean => view === "home" || viewOfTab(tab) === view;

/**
 * The tabs and the split layouts of every context (A-94, A-95, A-107). The model — tabs, closed tabs, the tab in front of each view, history — lives
 * here as plain data. Each view of a context (the home, and each feature view) has a layout of its own: the home holds every tab, a feature view the
 * tabs of its kind, and the same tab in two views is one tab with one content. Each view that has been on screen has a dock of its own; this class keeps
 * the model and the docks in step: opening a tab adds its panel to the docks of its views, closing a panel closes the tab everywhere, and every change is
 * saved a moment later. Components read it through `useSyncExternalStore` on `version()`.
 */
export class WorkspaceController {
  readonly env: WorkspaceEnv;
  private readonly contexts = new Map<string, Ctx>();
  private readonly listeners = new Set<() => void>();
  private counter = 0;
  private active = "";
  private viewNow: WorkspaceView = "home";
  private mountedOrder: string[] = [];
  /** `<context>/<tab>` of the tabs whose content is loaded; a reader out of sight leaves it when it is not among the last used. */
  private readonly mounted = new Set<string>();
  /** The docks whose saved layout has been put back; a dock is restored once, however often its host attaches it. */
  private readonly restored = new WeakSet<DockviewApi>();
  private hidden: string[] = [];
  private launchCounter = 0;
  /** The settings are on screen (A-101): the tabs stay as they are but are told they are out of sight, and none is let go. */
  private suspendedNow = false;
  /** What was asked to open before the first context was on screen (a click while the window is still coming up); it opens once there is one. */
  private waiting: OpenRequest[] = [];

  constructor(env: WorkspaceEnv) {
    this.env = env;
  }

  // ------------------------------------------------------------------------------------------------------------------ store

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  version = (): number => this.counter;
  private emit(): void {
    this.counter += 1;
    for (const listener of [...this.listeners]) listener();
  }

  // ---------------------------------------------------------------------------------------------------------------- contexts

  private ctx(contextId: ContextId): Ctx {
    const key = contextKey(contextId);
    let found = this.contexts.get(key);
    if (!found) { found = emptyCtx(contextId); this.contexts.set(key, found); }
    return found;
  }
  private current(): Ctx | null {
    return this.contexts.get(this.active) ?? null;
  }
  /** The arrangement of a view of a context, made (empty) the first time it is asked for. */
  private dockOf(ctx: Ctx, view: WorkspaceView = this.viewNow): Dock {
    let dock = ctx.docks.get(view);
    if (!dock) {
      dock = emptyDock(view);
      // A view not seen yet starts with the newest of its tabs in front.
      dock.focusedTab = [...ctx.tabs].reverse().find((tab) => inView(tab, view))?.id ?? null;
      ctx.docks.set(view, dock);
    }
    return dock;
  }
  private dockAt(key: string): Dock | null {
    const ctx = this.contexts.get(key);
    return ctx ? this.dockOf(ctx) : null;
  }

  get activeKey(): string { return this.active; }
  /** The view on screen (A-107): the home or a feature view. It is the same for every context. */
  get view(): WorkspaceView { return this.viewNow; }
  /** The workspace is behind the settings view: mounted, not shown. */
  get suspended(): boolean { return this.suspendedNow; }
  setSuspended(value: boolean): void {
    if (this.suspendedNow === value) return;
    this.suspendedNow = value;
    this.emit();
  }
  get activeContextId(): ContextId { return this.current()?.contextId ?? null; }
  /** The contexts whose host is on screen, the active one among them, most recently used first. */
  get mountedContexts(): Array<{ key: string; contextId: ContextId }> {
    return this.mountedOrder.map((key) => this.contexts.get(key)).filter((item): item is Ctx => Boolean(item)).map((item) => ({ key: item.key, contextId: item.contextId }));
  }

  /**
   * Shows another view (A-107): its layout comes on screen with the tab it had in front, and the tabs of the view that is left are out of sight. Nothing
   * is opened or closed. A view seen for the first time in this context gets its dock now.
   */
  showView(view: WorkspaceView): void {
    if (view !== "home" && !isFeatureView(view)) return;
    if (this.viewNow === view) return;
    this.viewNow = view;
    const ctx = this.current();
    if (ctx) this.dockOf(ctx, view).visited = true;
    this.emit();
  }
  /** Shows another view and tells the shell, which keeps it. */
  private moveTo(view: WorkspaceView): void {
    if (this.viewNow === view) return;
    this.showView(view);
    this.env.onView?.(view);
  }

  /**
   * Reads a context's saved state (once) and makes it the one on screen. A project that is gone (deleted elsewhere, or a last context that no longer
   * exists) cannot be made the context: nothing changes and the answer is false.
   */
  async activate(contextId: ContextId): Promise<boolean> {
    const ctx = this.ctx(contextId);
    if (!ctx.loaded) await this.load(ctx);
    if (ctx.missing) { this.contexts.delete(ctx.key); return false; }
    this.active = ctx.key;
    this.dockOf(ctx).visited = true;
    this.mountedOrder = [ctx.key, ...this.mountedOrder.filter((key) => key !== ctx.key)];
    // A context pushed out of the list keeps its tabs and layout, saved, and its readers are let go.
    for (const key of this.mountedOrder.slice(MOUNTED_CONTEXTS)) {
      const left = this.contexts.get(key);
      if (left) {
        void this.flush(left);
        for (const dock of left.docks.values()) dock.visited = false;
      }
      this.release(key);
    }
    this.mountedOrder = this.mountedOrder.slice(0, MOUNTED_CONTEXTS);
    this.emit();
    for (const request of this.waiting.splice(0)) this.open(request);
    return true;
  }

  private release(key: string): void {
    for (const id of [...this.mounted]) if (id.startsWith(`${key}/`)) this.mounted.delete(id);
    this.hidden = this.hidden.filter((id) => !id.startsWith(`${key}/`));
  }

  private load(ctx: Ctx): Promise<void> {
    if (ctx.loading) return ctx.loading;
    ctx.loading = (async () => {
      const result = await this.env.call("workspace.loadContext", { contextId: ctx.contextId });
      if (!result.ok && ctx.contextId !== null && /does not exist|NOT_FOUND/i.test(result.error.message)) {
        ctx.missing = true;
        ctx.loaded = true;
        ctx.loading = null;
        return;
      }
      const state = result.ok ? ((result.value.state as WorkspaceState | undefined) ?? EMPTY_WORKSPACE_STATE) : EMPTY_WORKSPACE_STATE;
      const { version: _version, preset, layout, tabs, focusedTab, closed, views, ...extra } = { ...EMPTY_WORKSPACE_STATE, ...state };
      ctx.tabs = Array.isArray(tabs) ? [...tabs] : [];
      ctx.closed = Array.isArray(closed) ? [...closed] : [];
      const has = (id: string | null | undefined) => Boolean(id) && ctx.tabs.some((tab) => tab.id === id);
      ctx.docks = new Map([["home", emptyDock("home", { preset: preset ?? "single", layout: layout ?? null, focusedTab: has(focusedTab) ? focusedTab : ctx.tabs[0]?.id ?? null })]]);
      for (const [view, saved] of Object.entries(views ?? {})) {
        if (!isFeatureView(view)) continue;
        const members = ctx.tabs.filter((tab) => inView(tab, view));
        ctx.docks.set(view, emptyDock(view, { ...saved, focusedTab: has(saved.focusedTab) && members.some((tab) => tab.id === saved.focusedTab) ? saved.focusedTab : members[0]?.id ?? null }));
      }
      ctx.extra = extra;
      // Only a context that was never saved gets the seeded tabs (the service answers an empty state with `updatedAt: null` then); one saved with
      // every tab closed stays empty (LOOP-24).
      const neverSaved = !result.ok || result.value.state == null || result.value.updatedAt == null;
      if (ctx.tabs.length === 0 && neverSaved) {
        ctx.tabs = (this.env.seed?.(ctx.contextId) ?? []).map((request) => makeTab({ kind: request.kind, target: request.target ?? {}, title: request.title ?? this.env.titleFor({ kind: request.kind, target: request.target ?? {} }) }));
        ctx.docks.get("home")!.focusedTab = ctx.tabs[0]?.id ?? null;
      }
      ctx.loaded = true;
      ctx.loading = null;
    })();
    return ctx.loading;
  }

  /** A project was deleted: its arrangement goes with it. */
  forget(contextId: ContextId): void {
    const ctx = this.contexts.get(contextKey(contextId));
    if (!ctx) return;
    if (ctx.saveTimer) clearTimeout(ctx.saveTimer);
    this.release(ctx.key);
    this.contexts.delete(ctx.key);
    this.mountedOrder = this.mountedOrder.filter((key) => key !== ctx.key);
    this.emit();
  }

  // ------------------------------------------------------------------------------------------------------------------- reads

  tabsOf(key = this.active): readonly WorkspaceTab[] { return this.contexts.get(key)?.tabs ?? []; }
  /** The tabs of a view of a context, in the order they were opened. */
  tabsIn(view: WorkspaceView = this.viewNow, key = this.active): WorkspaceTab[] { return this.tabsOf(key).filter((tab) => inView(tab, view)); }
  tab(key: string, tabId: string): WorkspaceTab | undefined { return this.contexts.get(key)?.tabs.find((item) => item.id === tabId); }
  /** The tab in front of the view on screen. */
  focusedTabId(key = this.active): string | null { return this.contexts.get(key)?.docks.get(this.viewNow)?.focusedTab ?? null; }
  focusedTab(key = this.active): WorkspaceTab | undefined {
    const id = this.focusedTabId(key);
    return id ? this.tab(key, id) : undefined;
  }
  closedCount(key = this.active): number { return this.contexts.get(key)?.closed.length ?? 0; }
  columns(key = this.active, view: WorkspaceView = this.viewNow): number { return this.contexts.get(key)?.docks.get(view)?.columns ?? 1; }
  /** The number (from 0) of the column holding the focus, in reading order. */
  activeColumn(key = this.active, view: WorkspaceView = this.viewNow): number { return this.contexts.get(key)?.docks.get(view)?.activeColumn ?? 0; }
  preset(key = this.active, view: WorkspaceView = this.viewNow): WorkspacePreset { const dock = this.contexts.get(key)?.docks.get(view); return dock ? presetOfCount(dock.columns) : "single"; }
  canBack(key = this.active): boolean { return canStep(this.focusedTab(key), -1); }
  canForward(key = this.active): boolean { return canStep(this.focusedTab(key), 1); }
  /** Whether the tab's content is loaded: it is on screen or among the last readers used. */
  isMounted(key: string, tabId: string): boolean { return this.mounted.has(`${key}/${tabId}`); }
  /** The views of a context whose dock is on the page (the one on screen among them). */
  dockViews(key: string): WorkspaceView[] {
    const ctx = this.contexts.get(key);
    if (!ctx) return [];
    return [...ctx.docks.values()].filter((dock) => dock.visited || (key === this.active && dock.view === this.viewNow)).map((dock) => dock.view);
  }
  /** Whether a tab is in front of its column in the view on screen (what its content needs to know to be in sight). */
  isShown(key: string, tabId: string): boolean { return this.contexts.get(key)?.docks.get(this.viewNow)?.shown.has(tabId) ?? false; }
  /** Where the saved state of a context stands: for the sidebar's count and for tests. */
  stateOf(key = this.active): WorkspaceState | null {
    const ctx = this.contexts.get(key);
    return ctx ? this.serialize(ctx) : null;
  }
  groupOf(tabId: string, key = this.active): number {
    const api = this.dockAt(key)?.api;
    const panel = api?.getPanel(tabId);
    if (!api || !panel) return -1;
    return columnsOf(api).findIndex((group) => group.id === panel.group.id);
  }

  // ------------------------------------------------------------------------------------------------------------------ the docks

  /**
   * The dock of a view of a context is ready. The first time a dock is attached its saved layout comes back, the tabs of the view without a panel get
   * one and the panels of other tabs are dropped; attaching the same dock again (the host's effects ran again, and the dock keeps its instance) only
   * takes its events up again.
   */
  attach(contextId: ContextId, api: DockviewApi, view: WorkspaceView = "home"): void {
    const ctx = this.ctx(contextId);
    const dock = this.dockOf(ctx, view);
    for (const dispose of dock.dispose) dispose();
    dock.dispose = [];
    dock.api = api;
    dock.syncing = true;
    const members = ctx.tabs.filter((tab) => inView(tab, view));
    try {
      if (!this.restored.has(api)) {
        this.restored.add(api);
        if (dock.layout) {
          try { api.fromJSON(dock.layout as never); } catch { api.clear(); dock.layout = null; }
        }
        const known = new Set(members.map((tab) => tab.id));
        for (const panel of [...api.panels]) if (!known.has(panel.id)) panel.api.close();
        for (const tab of members) if (!api.getPanel(tab.id)) this.addPanel(dock, ctx, tab, false);
        if (!dock.layout && api.groups.length <= 1 && dock.preset !== "single") applyPreset(api, dock.preset);
      } else {
        for (const tab of members) if (!api.getPanel(tab.id)) this.addPanel(dock, ctx, tab, tab.id !== dock.focusedTab);
      }
      const focus = dock.focusedTab && api.getPanel(dock.focusedTab);
      if (focus) focus.api.setActive();
    } finally {
      dock.syncing = false;
    }
    this.sync(ctx, dock);
    const watch = [
      api.onDidActivePanelChange((event) => { if (!dock.syncing) this.setFocused(ctx, dock, event.panel?.id ?? null); }),
      api.onDidRemovePanel((panel) => this.panelRemoved(ctx, dock, panel)),
      api.onDidAddGroup(() => this.sync(ctx, dock)),
      api.onDidRemoveGroup(() => this.sync(ctx, dock)),
      api.onDidMovePanel(() => this.sync(ctx, dock)),
      api.onDidLayoutChange(() => this.sync(ctx, dock)),
    ];
    dock.dispose = watch.map((item) => () => item.dispose());
  }

  /** The dock is gone (its host unmounted). The layout last seen is kept in the model. */
  detach(contextId: ContextId, api: DockviewApi, view: WorkspaceView = "home"): void {
    const dock = this.contexts.get(contextKey(contextId))?.docks.get(view);
    if (!dock || dock.api !== api) return;
    for (const dispose of dock.dispose) dispose();
    dock.dispose = [];
    dock.api = null;
    dock.shown.clear();
  }

  /** A panel of a dock came in front of its column or went behind another (the dock's own visibility, read a frame later). */
  setShown(key: string, view: WorkspaceView, tabId: string, shown: boolean): void {
    const dock = this.contexts.get(key)?.docks.get(view);
    if (!dock || dock.shown.has(tabId) === shown) return;
    if (shown) dock.shown.add(tabId); else dock.shown.delete(tabId);
    this.emit();
  }

  private addPanel(dock: Dock, ctx: Ctx, tab: WorkspaceTab, background: boolean, place?: { column: number; index: number }): void {
    const api = dock.api;
    if (!api) return;
    const at = place ? columnsOf(api)[place.column] : undefined;
    const group = at ?? api.activeGroup ?? columnsOf(api)[0];
    api.addPanel({
      id: tab.id,
      component: "tab",
      title: tab.title,
      params: { tabId: tab.id, contextKey: ctx.key, view: dock.view },
      renderer: "always",
      minimumWidth: MIN_COLUMN_WIDTH,
      inactive: background,
      ...(group ? { position: { referenceGroup: group, ...(at && place ? { index: Math.min(place.index, at.panels.length) } : {}) } } : {}),
    });
  }

  /** The dock changed: what the model keeps of it (layout, column count, the column in front, where each panel is) is read again, and a save is planned. */
  private sync(ctx: Ctx, dock: Dock): void {
    const api = dock.api;
    if (!api || dock.syncing) return;
    // A column shown alone (the window is too narrow, or full screen) is a way of looking at the layout, not a change of it: the layout saved stays.
    if (!api.hasMaximizedGroup()) {
      try { dock.layout = api.toJSON() as unknown as Record<string, unknown>; } catch { /* the last layout stays */ }
    }
    const order = columnsOf(api);
    dock.places = new Map(order.flatMap((group, column) => group.panels.map((panel, index) => [panel.id, { column, index }] as const)));
    const columns = Math.max(1, api.groups.length);
    const activeColumn = Math.max(0, order.findIndex((group) => group === api.activeGroup));
    const changed = columns !== dock.columns || activeColumn !== dock.activeColumn;
    dock.columns = columns;
    dock.activeColumn = activeColumn;
    dock.preset = presetOfCount(columns);
    this.schedule(ctx);
    if (changed) this.emit();
  }

  /** A panel was closed in one dock: the tab is closed, so its panel in the other view goes too, and "reopen" remembers where it was. */
  private panelRemoved(ctx: Ctx, dock: Dock, panel: IDockviewPanel): void {
    if (dock.syncing) return;
    const tab = ctx.tabs.find((item) => item.id === panel.id);
    if (!tab) return;
    const at = dock.places.get(tab.id);
    this.dropTab(ctx, tab, at ? { view: dock.view, ...at } : null, dock);
    this.sync(ctx, dock);
  }

  /** Takes a tab out of the context and out of every dock; it goes to the closed tabs when it can come back (`place` is where). */
  private dropTab(ctx: Ctx, tab: WorkspaceTab, place: ClosedPlace | null, from: Dock | null, keep = true): void {
    ctx.tabs = ctx.tabs.filter((item) => item.id !== tab.id);
    if (keep) ctx.closed = pushClosed(ctx.closed, place ? { ...tab, place } : tab);
    ctx.launches.delete(tab.id);
    tabMarks.clear(tab.id);
    this.mounted.delete(`${ctx.key}/${tab.id}`);
    this.hidden = this.hidden.filter((id) => id !== `${ctx.key}/${tab.id}`);
    for (const dock of ctx.docks.values()) {
      dock.shown.delete(tab.id);
      if (dock !== from) {
        const other = dock.api?.getPanel(tab.id);
        if (other) {
          dock.syncing = true;
          try { other.api.close(); } finally { dock.syncing = false; }
          this.sync(ctx, dock);
        }
      }
      if (dock.focusedTab === tab.id) {
        const left = ctx.tabs.filter((item) => inView(item, dock.view));
        dock.focusedTab = dock.api?.activePanel?.id ?? left[left.length - 1]?.id ?? null;
      }
    }
    this.schedule(ctx);
    this.emit();
  }

  private setFocused(ctx: Ctx, dock: Dock, tabId: string | null): void {
    if (dock.focusedTab === tabId) { this.sync(ctx, dock); return; }
    dock.focusedTab = tabId;
    this.sync(ctx, dock);
    this.schedule(ctx);
    this.emit();
  }

  /** The views a tab is shown in: the home, and its feature view when it has one. */
  private viewsOf(tab: Pick<WorkspaceTab, "kind" | "target">): WorkspaceView[] {
    const own = viewOfTab(tab);
    return own ? ["home", own] : ["home"];
  }

  /** Puts a tab into the docks of its views (the model already has it). `front` is the view whose dock brings it in front; `place` is where it goes there. */
  private placeTab(ctx: Ctx, tab: WorkspaceTab, front: WorkspaceView | null, place?: { column: number; index: number }): void {
    for (const view of this.viewsOf(tab)) {
      const dock = this.dockOf(ctx, view);
      const inFront = view === front;
      // The view of its kind takes the newest tab as the one it had in front; a view on screen only when it was asked to.
      if (inFront || (view !== this.viewNow && view !== "home") || !dock.focusedTab) dock.focusedTab = tab.id;
      if (!dock.api) continue;
      dock.syncing = true;
      try {
        if (!dock.api.getPanel(tab.id)) this.addPanel(dock, ctx, tab, !inFront && dock.focusedTab !== tab.id, view === front ? place : undefined);
      } finally { dock.syncing = false; }
      if (inFront || dock.focusedTab === tab.id) {
        dock.syncing = true;
        try { dock.api.getPanel(tab.id)?.api.setActive(); } finally { dock.syncing = false; }
      }
      this.sync(ctx, dock);
    }
  }

  // ---------------------------------------------------------------------------------------------------------------- operations

  /**
   * Opens a tab, or switches to the one that already shows the same thing (A-94), and answers the tab's id. Where (A-107, 计划 4.1): in the home it opens
   * there and in its own view as well; in a feature view, a thing of that kind opens there and in the home; a thing of another kind first moves to the
   * view of its kind (the home for the things shown only there).
   */
  open(request: OpenRequest): string | null {
    const ctx = this.current();
    if (!ctx) { this.waiting.push(request); return null; }
    const target: Target = request.target ?? {};
    const own = viewOfTab({ kind: request.kind, target });
    if (!request.background && this.viewNow !== "home" && own !== this.viewNow) this.moveTo(own ?? "home");
    if (request.mode !== "new") {
      const existing = findByKey(ctx.tabs, request.kind, target);
      if (existing) {
        if (request.launch) this.launch(existing.id, request.launch);
        if (!request.background) this.focusTab(existing.id);
        return existing.id;
      }
    }
    if (ctx.tabs.length >= WORKSPACE_TAB_LIMIT) { this.env.onLimit?.(); return null; }
    const tab = makeTab({ kind: request.kind, target, title: request.title ?? this.env.titleFor({ kind: request.kind, target }) });
    ctx.tabs = [...ctx.tabs, tab];
    if (request.launch) ctx.launches.set(tab.id, { ...request.launch, n: ++this.launchCounter });
    this.placeTab(ctx, tab, request.background ? null : this.viewNow);
    this.schedule(ctx);
    this.emit();
    return tab.id;
  }

  /** Brings a tab in front in the view on screen; a tab that is not in it moves the screen to its own view first. */
  focusTab(tabId: string): void {
    const ctx = this.current();
    const tab = ctx?.tabs.find((item) => item.id === tabId);
    if (!ctx || !tab) return;
    if (!inView(tab, this.viewNow)) this.moveTo(viewOfTab(tab) ?? "home");
    const dock = this.dockOf(ctx);
    const panel = dock.api?.getPanel(tabId);
    if (panel) panel.api.setActive();
    if (dock.focusedTab !== tabId) { dock.focusedTab = tabId; this.schedule(ctx); this.emit(); }
  }

  closeTab(tabId: string): void {
    const ctx = this.current();
    if (!ctx) return;
    const dock = this.dockOf(ctx);
    const panel = dock.api?.getPanel(tabId);
    if (panel) { panel.api.close(); return; }
    const tab = ctx.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    // Without a dock on the page the place is the tab's order among the view's tabs, in its one column.
    const at = dock.places.get(tabId) ?? { column: 0, index: Math.max(0, ctx.tabs.filter((item) => inView(item, dock.view)).findIndex((item) => item.id === tabId)) };
    this.dropTab(ctx, tab, inView(tab, dock.view) ? { view: dock.view, ...at } : null, null);
  }

  /**
   * Closes every tab (in every context kept in memory) that something says is gone: a library path removed under a reader, a conversation deleted. The
   * tabs are not kept for "reopen", since what they showed cannot be shown again. Answers the tabs that were closed.
   */
  closeMatching(match: (tab: WorkspaceTab) => boolean): WorkspaceTab[] {
    const done: WorkspaceTab[] = [];
    for (const ctx of this.contexts.values()) {
      for (const tab of ctx.tabs.filter(match)) {
        done.push(tab);
        this.dropTab(ctx, tab, null, null, false);
      }
    }
    if (done.length) this.emit();
    return done;
  }

  closeFocused(): void {
    const id = this.focusedTabId();
    if (id) this.closeTab(id);
  }

  /** Brings back the tab closed last: in the view, the column and the place it was closed from when they are still there (计划 4.8), else at the end of the column in front. */
  reopen(): string | null {
    const ctx = this.current();
    const closed = ctx?.closed[0];
    if (!ctx || !closed) return null;
    if (ctx.tabs.length >= WORKSPACE_TAB_LIMIT) { this.env.onLimit?.(); return null; }
    const { place, ...tab } = closed as WorkspaceTab & { place?: ClosedPlace };
    ctx.closed = ctx.closed.slice(1);
    ctx.tabs = [...ctx.tabs, tab];
    const view = place && (place.view === "home" || (isFeatureView(place.view) && inView(tab, place.view))) ? (place.view as WorkspaceView) : this.viewNow;
    if (!inView(tab, view)) this.moveTo(viewOfTab(tab) ?? "home");
    else this.moveTo(view);
    const dock = this.dockOf(ctx);
    const fits = place && place.view === this.viewNow && dock.api && columnsOf(dock.api)[place.column] ? { column: place.column, index: place.index } : undefined;
    this.placeTab(ctx, tab, this.viewNow, fits);
    this.schedule(ctx);
    this.emit();
    return tab.id;
  }

  /** The tab after (+1) or before (-1) the one in front, in the order of the tab strips, column by column. */
  step(delta: -1 | 1): void {
    const ctx = this.current();
    const api = ctx ? this.dockOf(ctx).api : null;
    if (!ctx || !api) return;
    const order = columnsOf(api).flatMap((group) => group.panels.map((panel) => panel.id));
    if (order.length < 2) return;
    const at = Math.max(0, order.indexOf(this.focusedTabId() ?? ""));
    const next = order[(at + delta + order.length) % order.length]!;
    this.focusTab(next);
  }

  /** Puts the focus in the n-th column (from 1), on the tab it shows. */
  focusColumn(n: number): boolean {
    const ctx = this.current();
    const api = ctx ? this.dockOf(ctx).api : null;
    if (!api) return false;
    const group = columnsOf(api)[n - 1];
    if (!group) return false;
    const panel = group.activePanel ?? group.panels[0];
    if (panel) panel.api.setActive();
    else group.api.setActive();
    return true;
  }

  /** The layout of the view on screen (the others keep theirs). */
  setPreset(preset: WorkspacePreset): void {
    const ctx = this.current();
    if (!ctx) return;
    const dock = this.dockOf(ctx);
    if (!dock.api) { dock.preset = preset; this.schedule(ctx); this.emit(); return; }
    dock.syncing = true;
    try { applyPreset(dock.api, preset); } finally { dock.syncing = false; }
    dock.focusedTab = dock.api.activePanel?.id ?? dock.focusedTab;
    dock.layout = null;
    this.sync(ctx, dock);
    this.emit();
  }

  /** Single column and two columns, back and forth (`Ctrl+\`). */
  toggleSplit(): void {
    this.setPreset(this.columns() > 1 ? "single" : "two");
  }

  /** A tab goes somewhere else in the same tab; back and forth walks through the places. */
  navigate(tabId: string, target: Target, title: string): void {
    this.replace(tabId, (tab) => navigateTab(tab, target, title));
  }
  back(tabId = this.focusedTabId() ?? ""): boolean { return this.stepHistory(tabId, -1); }
  forward(tabId = this.focusedTabId() ?? ""): boolean { return this.stepHistory(tabId, 1); }
  private stepHistory(tabId: string, delta: -1 | 1): boolean {
    const ctx = this.current();
    const tab = ctx?.tabs.find((item) => item.id === tabId);
    const next = tab ? stepTab(tab, delta) : null;
    if (!ctx || !next) return false;
    this.replace(tabId, () => next);
    return true;
  }

  /** The tab's name for where it is now (the title of the book once it has loaded). */
  retitle(tabId: string, title: string): void { this.replace(tabId, (tab) => retitleTab(tab, title)); }
  /** Facts about what the tab shows that were not known when it opened (a reader's work); no new place is made. */
  retarget(tabId: string, patch: Target): void {
    const tab = this.current()?.tabs.find((item) => item.id === tabId);
    if (!tab || Object.entries(patch).every(([name, value]) => tab.target[name] === value)) return;
    this.replace(tabId, (item) => retargetTab(item, patch));
  }
  /** Where the tab is in what it shows (position, zoom, scroll, filters), kept with the layout. */
  setView(tabId: string, patch: Record<string, unknown>): void {
    const ctx = this.current();
    const tab = ctx?.tabs.find((item) => item.id === tabId);
    if (!ctx || !tab) return;
    const same = Object.entries(patch).every(([name, value]) => JSON.stringify(tab.view[name]) === JSON.stringify(value));
    if (same) return;
    ctx.tabs = ctx.tabs.map((item) => (item.id === tabId ? { ...item, view: { ...item.view, ...patch } } : item));
    this.schedule(ctx);
  }

  private replace(tabId: string, change: (tab: WorkspaceTab) => WorkspaceTab): void {
    const ctx = this.current();
    const tab = ctx?.tabs.find((item) => item.id === tabId);
    if (!ctx || !tab) return;
    const next = change(tab);
    if (next === tab) return;
    ctx.tabs = ctx.tabs.map((item) => (item.id === tabId ? next : item));
    if (next.title !== tab.title) for (const dock of ctx.docks.values()) dock.api?.getPanel(tabId)?.api.setTitle(next.title);
    // A tab that went to a thing of another kind (a library page from the novels to the overview) leaves the view of its old kind for its new one.
    const before = viewOfTab(tab);
    const after = viewOfTab(next);
    if (before !== after) {
      if (before) {
        const dock = this.dockOf(ctx, before);
        const panel = dock.api?.getPanel(tabId);
        if (panel) {
          dock.syncing = true;
          try { panel.api.close(); } finally { dock.syncing = false; }
          this.sync(ctx, dock);
        }
        dock.shown.delete(tabId);
        if (dock.focusedTab === tabId) dock.focusedTab = dock.api?.activePanel?.id ?? null;
      }
      if (after) this.placeTab(ctx, next, after === this.viewNow ? after : null);
    }
    this.schedule(ctx);
    this.emit();
  }

  // ----------------------------------------------------------------------------------------------------------------- launches

  /** Asks a tab's content to do something once more (jump to a place); the request is not saved. */
  launch(tabId: string, request: Record<string, unknown>): void {
    const ctx = this.current();
    if (!ctx) return;
    ctx.launches.set(tabId, { ...request, n: ++this.launchCounter });
    this.emit();
  }
  launchOf(key: string, tabId: string): Launch | undefined { return this.contexts.get(key)?.launches.get(tabId); }
  /** The request waiting for a tab's content, taken: it is done once, not again when the content is made anew. */
  takeLaunch(key: string, tabId: string): Launch | undefined {
    const ctx = this.contexts.get(key);
    const launch = ctx?.launches.get(tabId);
    if (launch) ctx!.launches.delete(tabId);
    return launch;
  }

  // ------------------------------------------------------------------------------------------------------ what is loaded (A-95)

  /** A tab came into view or went out of it. A reader out of sight stays loaded only among the last ones used; the others are let go. */
  setVisible(key: string, tabId: string, visible: boolean): void {
    const id = `${key}/${tabId}`;
    const tab = this.tab(key, tabId);
    let changed = false;
    if (visible) {
      if (!this.mounted.has(id)) { this.mounted.add(id); changed = true; }
      const before = this.hidden.length;
      this.hidden = this.hidden.filter((item) => item !== id);
      changed ||= before !== this.hidden.length;
    } else if (tab?.kind === READER_KIND && this.mounted.has(id)) {
      this.hidden = [id, ...this.hidden.filter((item) => item !== id)];
      for (const old of this.hidden.slice(HIDDEN_READERS)) { this.mounted.delete(old); changed = true; }
      this.hidden = this.hidden.slice(0, HIDDEN_READERS);
    }
    if (changed) this.emit();
  }
  /** How many reader tabs are loaded now, for the benchmark and the tests. */
  loadedReaders(): number {
    let count = 0;
    for (const id of this.mounted) {
      const [key, tabId] = id.split("/");
      if (this.tab(key!, tabId!)?.kind === READER_KIND) count += 1;
    }
    return count;
  }

  // ------------------------------------------------------------------------------------------------------------- persistence

  private serialize(ctx: Ctx): WorkspaceState {
    const home = ctx.docks.get("home") ?? emptyDock("home");
    const views: Record<string, WorkspaceViewLayout> = {};
    for (const dock of ctx.docks.values()) {
      if (dock.view === "home") continue;
      views[dock.view] = { preset: dock.api ? presetOfCount(dock.columns) : dock.preset, layout: dock.layout, focusedTab: dock.focusedTab };
    }
    return {
      ...ctx.extra,
      version: 2,
      preset: home.api ? presetOfCount(home.columns) : home.preset,
      layout: home.layout,
      tabs: ctx.tabs,
      focusedTab: home.focusedTab,
      closed: ctx.closed,
      views,
    };
  }

  private schedule(ctx: Ctx): void {
    if (!ctx.loaded) return;
    if (ctx.saveTimer) clearTimeout(ctx.saveTimer);
    ctx.saveTimer = setTimeout(() => { ctx.saveTimer = null; void this.flush(ctx); }, SAVE_DELAY_MS);
  }

  /** Saves now what has changed since the last save; saves of one context go one after the other. */
  flush(ctx?: Ctx | null): Promise<unknown> {
    const targets = ctx ? [ctx] : [...this.contexts.values()];
    return Promise.all(targets.map((item) => {
      if (!item.loaded) return Promise.resolve();
      if (item.saveTimer) { clearTimeout(item.saveTimer); item.saveTimer = null; }
      const state = this.serialize(item);
      const send = () => this.env.call("workspace.saveContext", { contextId: item.contextId, state });
      const sent = item.inflight > 0 ? item.saving.then(send) : send();
      item.inflight += 1;
      item.saving = sent.then((result) => {
        item.inflight -= 1;
        if (result && !result.ok) this.env.onError?.(result.error.message);
      });
      return item.saving;
    }));
  }
  flushAll = (): Promise<unknown> => this.flush(null);
  /** Whether a save is planned or on its way (the window waits for these before it closes, 计划 4.8). */
  pendingSaves(): boolean {
    return [...this.contexts.values()].some((ctx) => ctx.saveTimer !== null || ctx.inflight > 0);
  }

  dispose(): void {
    for (const ctx of this.contexts.values()) {
      if (ctx.saveTimer) clearTimeout(ctx.saveTimer);
      for (const dock of ctx.docks.values()) for (const dispose of dock.dispose) dispose();
    }
    this.listeners.clear();
  }
}
