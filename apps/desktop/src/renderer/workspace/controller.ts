import type { DockviewApi, IDockviewPanel } from "dockview-react";
import {
  EMPTY_WORKSPACE_STATE, WORKSPACE_TAB_LIMIT, contextKey, type ContextId, type WorkspacePreset, type WorkspaceState, type WorkspaceTab,
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
  focusedTab: string | null;
  preset: WorkspacePreset;
  layout: Record<string, unknown> | null;
  api: DockviewApi | null;
  syncing: boolean;
  columns: number;
  activeColumn: number;
  saveTimer: ReturnType<typeof setTimeout> | null;
  saving: Promise<unknown>;
  /** Saves of this context that have been sent and not answered; a save with none before it is sent at once, so it reaches the host that was there. */
  inflight: number;
  launches: Map<string, Launch>;
  /** Fields of the saved state this version does not know, written back unchanged. */
  extra: Record<string, unknown>;
  dispose: Array<() => void>;
};

const SAVE_DELAY_MS = 500;
/** Readers out of sight that stay loaded (A-95): the ones used last. */
export const HIDDEN_READERS = 2;
/** Contexts whose arrangement stays on screen (hidden) so that going back to one is immediate. */
export const MOUNTED_CONTEXTS = 3;

const emptyCtx = (contextId: ContextId): Ctx => ({
  key: contextKey(contextId), contextId, loaded: false, missing: false, loading: null, tabs: [], closed: [], focusedTab: null, preset: "single", layout: null, api: null, syncing: false,
  columns: 1, activeColumn: 0, saveTimer: null, saving: Promise.resolve(), inflight: 0, launches: new Map(), extra: {}, dispose: [],
});

/**
 * The tabs and the split layout of every context (A-94, A-95). The model — tabs, closed tabs, focus, history — lives here as plain data; the layout
 * lives in the dock of the context's host, and this class keeps the two in step: opening a tab adds a panel, closing a panel closes the tab, and
 * every change is saved a moment later. Components read it through `useSyncExternalStore` on `version()`.
 */
export class WorkspaceController {
  readonly env: WorkspaceEnv;
  private readonly contexts = new Map<string, Ctx>();
  private readonly listeners = new Set<() => void>();
  private counter = 0;
  private active = "";
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

  get activeKey(): string { return this.active; }
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
   * Reads a context's saved state (once) and makes it the one on screen. A project that is gone (deleted elsewhere, or a last context that no longer
   * exists) cannot be made the context: nothing changes and the answer is false.
   */
  async activate(contextId: ContextId): Promise<boolean> {
    const ctx = this.ctx(contextId);
    if (!ctx.loaded) await this.load(ctx);
    if (ctx.missing) { this.contexts.delete(ctx.key); return false; }
    this.active = ctx.key;
    this.mountedOrder = [ctx.key, ...this.mountedOrder.filter((key) => key !== ctx.key)];
    // A context pushed out of the list keeps its tabs and layout, saved, and its readers are let go.
    for (const key of this.mountedOrder.slice(MOUNTED_CONTEXTS)) {
      const left = this.contexts.get(key);
      if (left) void this.flush(left);
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
      const { version: _version, preset, layout, tabs, focusedTab, closed, ...extra } = { ...EMPTY_WORKSPACE_STATE, ...state };
      ctx.tabs = Array.isArray(tabs) ? [...tabs] : [];
      ctx.closed = Array.isArray(closed) ? [...closed] : [];
      ctx.preset = preset ?? "single";
      ctx.layout = layout ?? null;
      ctx.focusedTab = focusedTab && ctx.tabs.some((tab) => tab.id === focusedTab) ? focusedTab : ctx.tabs[0]?.id ?? null;
      ctx.extra = extra;
      if (ctx.tabs.length === 0) {
        ctx.tabs = (this.env.seed?.(ctx.contextId) ?? []).map((request) => makeTab({ kind: request.kind, target: request.target ?? {}, title: request.title ?? this.env.titleFor({ kind: request.kind, target: request.target ?? {} }) }));
        ctx.focusedTab = ctx.tabs[0]?.id ?? null;
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
  tab(key: string, tabId: string): WorkspaceTab | undefined { return this.contexts.get(key)?.tabs.find((item) => item.id === tabId); }
  focusedTabId(key = this.active): string | null { return this.contexts.get(key)?.focusedTab ?? null; }
  focusedTab(key = this.active): WorkspaceTab | undefined {
    const ctx = this.contexts.get(key);
    return ctx?.tabs.find((item) => item.id === ctx.focusedTab);
  }
  closedCount(key = this.active): number { return this.contexts.get(key)?.closed.length ?? 0; }
  columns(key = this.active): number { return this.contexts.get(key)?.columns ?? 1; }
  /** The number (from 0) of the column holding the focus, in reading order. */
  activeColumn(key = this.active): number { return this.contexts.get(key)?.activeColumn ?? 0; }
  preset(key = this.active): WorkspacePreset { const ctx = this.contexts.get(key); return ctx ? presetOfCount(ctx.columns) : "single"; }
  canBack(key = this.active): boolean { return canStep(this.focusedTab(key), -1); }
  canForward(key = this.active): boolean { return canStep(this.focusedTab(key), 1); }
  /** Whether the tab's content is loaded: it is on screen or among the last readers used. */
  isMounted(key: string, tabId: string): boolean { return this.mounted.has(`${key}/${tabId}`); }
  /** Where the saved state of a context stands: for the sidebar's count and for tests. */
  stateOf(key = this.active): WorkspaceState | null {
    const ctx = this.contexts.get(key);
    return ctx ? this.serialize(ctx) : null;
  }
  groupOf(tabId: string, key = this.active): number {
    const ctx = this.contexts.get(key);
    const panel = ctx?.api?.getPanel(tabId);
    if (!ctx?.api || !panel) return -1;
    return columnsOf(ctx.api).findIndex((group) => group.id === panel.group.id);
  }

  // ------------------------------------------------------------------------------------------------------------------ the dock

  /**
   * The dock of a context is ready. The first time a dock is attached its saved layout comes back, the tabs without a panel get one and the panels without a
   * tab are dropped; attaching the same dock again (the host's effects ran again, and the dock keeps its instance) only takes its events up again.
   */
  attach(contextId: ContextId, api: DockviewApi): void {
    const ctx = this.ctx(contextId);
    for (const dispose of ctx.dispose) dispose();
    ctx.dispose = [];
    ctx.api = api;
    ctx.syncing = true;
    try {
      if (!this.restored.has(api)) {
        this.restored.add(api);
        if (ctx.layout) {
          try { api.fromJSON(ctx.layout as never); } catch { api.clear(); ctx.layout = null; }
        }
        const known = new Set(ctx.tabs.map((tab) => tab.id));
        for (const panel of [...api.panels]) if (!known.has(panel.id)) panel.api.close();
        for (const tab of ctx.tabs) if (!api.getPanel(tab.id)) this.addPanel(ctx, tab, false);
        if (!ctx.layout && api.groups.length <= 1 && ctx.preset !== "single") applyPreset(api, ctx.preset);
      } else {
        for (const tab of ctx.tabs) if (!api.getPanel(tab.id)) this.addPanel(ctx, tab, tab.id !== ctx.focusedTab);
      }
      const focus = ctx.focusedTab && api.getPanel(ctx.focusedTab);
      if (focus) focus.api.setActive();
    } finally {
      ctx.syncing = false;
    }
    this.sync(ctx);
    const watch = [
      api.onDidActivePanelChange((event) => { if (!ctx.syncing) this.setFocused(ctx, event.panel?.id ?? null); }),
      api.onDidRemovePanel((panel) => this.panelRemoved(ctx, panel)),
      api.onDidAddGroup(() => this.sync(ctx)),
      api.onDidRemoveGroup(() => this.sync(ctx)),
      api.onDidMovePanel(() => this.sync(ctx)),
      api.onDidLayoutChange(() => this.sync(ctx)),
    ];
    ctx.dispose = watch.map((item) => () => item.dispose());
  }

  /** The dock is gone (its host unmounted). The layout last seen is kept in the model. */
  detach(contextId: ContextId, api: DockviewApi): void {
    const ctx = this.contexts.get(contextKey(contextId));
    if (!ctx || ctx.api !== api) return;
    for (const dispose of ctx.dispose) dispose();
    ctx.dispose = [];
    ctx.api = null;
  }

  private addPanel(ctx: Ctx, tab: WorkspaceTab, background: boolean): void {
    const api = ctx.api;
    if (!api) return;
    const group = api.activeGroup ?? columnsOf(api)[0];
    api.addPanel({
      id: tab.id,
      component: "tab",
      title: tab.title,
      params: { tabId: tab.id, contextKey: ctx.key },
      renderer: "always",
      minimumWidth: MIN_COLUMN_WIDTH,
      inactive: background,
      ...(group ? { position: { referenceGroup: group } } : {}),
    });
  }

  /** The dock changed: what the model keeps of it (layout, column count, the column in front) is read again, and a save is planned. */
  private sync(ctx: Ctx): void {
    const api = ctx.api;
    if (!api || ctx.syncing) return;
    // A column shown alone (the window is too narrow, or full screen) is a way of looking at the layout, not a change of it: the layout saved stays.
    if (!api.hasMaximizedGroup()) {
      try { ctx.layout = api.toJSON() as unknown as Record<string, unknown>; } catch { /* the last layout stays */ }
    }
    const columns = Math.max(1, api.groups.length);
    const order = columnsOf(api);
    const activeColumn = Math.max(0, order.findIndex((group) => group === api.activeGroup));
    const changed = columns !== ctx.columns || activeColumn !== ctx.activeColumn;
    ctx.columns = columns;
    ctx.activeColumn = activeColumn;
    ctx.preset = presetOfCount(columns);
    this.schedule(ctx);
    if (changed) this.emit();
  }

  private panelRemoved(ctx: Ctx, panel: IDockviewPanel): void {
    if (ctx.syncing) return;
    const tab = ctx.tabs.find((item) => item.id === panel.id);
    if (!tab) return;
    ctx.tabs = ctx.tabs.filter((item) => item.id !== tab.id);
    ctx.closed = pushClosed(ctx.closed, tab);
    ctx.launches.delete(tab.id);
    tabMarks.clear(tab.id);
    this.mounted.delete(`${ctx.key}/${tab.id}`);
    this.hidden = this.hidden.filter((id) => id !== `${ctx.key}/${tab.id}`);
    if (ctx.focusedTab === tab.id) ctx.focusedTab = ctx.api?.activePanel?.id ?? null;
    this.sync(ctx);
    this.schedule(ctx);
    this.emit();
  }

  private setFocused(ctx: Ctx, tabId: string | null): void {
    if (ctx.focusedTab === tabId) { this.sync(ctx); return; }
    ctx.focusedTab = tabId;
    this.sync(ctx);
    this.schedule(ctx);
    this.emit();
  }

  // ---------------------------------------------------------------------------------------------------------------- operations

  /** Opens a tab in the column in front, or switches to the one that already shows the same thing. Answers the tab's id. */
  open(request: OpenRequest): string | null {
    const ctx = this.current();
    if (!ctx) { this.waiting.push(request); return null; }
    const target: Target = request.target ?? {};
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
    if (!request.background || !ctx.focusedTab) ctx.focusedTab = tab.id;
    if (ctx.api) {
      ctx.syncing = true;
      try { this.addPanel(ctx, tab, request.background === true); } finally { ctx.syncing = false; }
      this.sync(ctx);
    }
    this.schedule(ctx);
    this.emit();
    return tab.id;
  }

  focusTab(tabId: string): void {
    const ctx = this.current();
    if (!ctx) return;
    const panel = ctx.api?.getPanel(tabId);
    if (panel) panel.api.setActive();
    else if (ctx.tabs.some((tab) => tab.id === tabId)) { ctx.focusedTab = tabId; this.emit(); }
    if (ctx.focusedTab !== tabId && ctx.tabs.some((tab) => tab.id === tabId)) { ctx.focusedTab = tabId; this.schedule(ctx); this.emit(); }
  }

  closeTab(tabId: string): void {
    const ctx = this.current();
    if (!ctx) return;
    const panel = ctx.api?.getPanel(tabId);
    if (panel) { panel.api.close(); return; }
    const tab = ctx.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    ctx.tabs = ctx.tabs.filter((item) => item.id !== tabId);
    ctx.closed = pushClosed(ctx.closed, tab);
    tabMarks.clear(tabId);
    if (ctx.focusedTab === tabId) ctx.focusedTab = ctx.tabs[ctx.tabs.length - 1]?.id ?? null;
    this.schedule(ctx);
    this.emit();
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
        const panel = ctx.api?.getPanel(tab.id);
        if (panel) {
          panel.api.close();
          ctx.closed = ctx.closed.filter((item) => item.id !== tab.id);
          continue;
        }
        ctx.tabs = ctx.tabs.filter((item) => item.id !== tab.id);
        tabMarks.clear(tab.id);
        if (ctx.focusedTab === tab.id) ctx.focusedTab = ctx.tabs[ctx.tabs.length - 1]?.id ?? null;
        this.schedule(ctx);
      }
    }
    if (done.length) this.emit();
    return done;
  }

  closeFocused(): void {
    const id = this.focusedTabId();
    if (id) this.closeTab(id);
  }

  /** Brings back the tab closed last, where it was in its history. */
  reopen(): string | null {
    const ctx = this.current();
    const tab = ctx?.closed[0];
    if (!ctx || !tab) return null;
    if (ctx.tabs.length >= WORKSPACE_TAB_LIMIT) { this.env.onLimit?.(); return null; }
    ctx.closed = ctx.closed.slice(1);
    ctx.tabs = [...ctx.tabs, tab];
    ctx.focusedTab = tab.id;
    if (ctx.api) {
      ctx.syncing = true;
      try { this.addPanel(ctx, tab, false); } finally { ctx.syncing = false; }
      this.sync(ctx);
    }
    this.schedule(ctx);
    this.emit();
    return tab.id;
  }

  /** The tab after (+1) or before (-1) the one in front, in the order of the tab strips, column by column. */
  step(delta: -1 | 1): void {
    const ctx = this.current();
    if (!ctx?.api) return;
    const order = columnsOf(ctx.api).flatMap((group) => group.panels.map((panel) => panel.id));
    if (order.length < 2) return;
    const at = Math.max(0, order.indexOf(ctx.focusedTab ?? ""));
    const next = order[(at + delta + order.length) % order.length]!;
    this.focusTab(next);
  }

  /** Puts the focus in the n-th column (from 1), on the tab it shows. */
  focusColumn(n: number): boolean {
    const ctx = this.current();
    if (!ctx?.api) return false;
    const group = columnsOf(ctx.api)[n - 1];
    if (!group) return false;
    const panel = group.activePanel ?? group.panels[0];
    if (panel) panel.api.setActive();
    else group.api.setActive();
    return true;
  }

  setPreset(preset: WorkspacePreset): void {
    const ctx = this.current();
    if (!ctx?.api) { if (ctx) { ctx.preset = preset; this.schedule(ctx); this.emit(); } return; }
    ctx.syncing = true;
    try { applyPreset(ctx.api, preset); } finally { ctx.syncing = false; }
    ctx.focusedTab = ctx.api.activePanel?.id ?? ctx.focusedTab;
    ctx.layout = null;
    this.sync(ctx);
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
    if (next.title !== tab.title) ctx.api?.getPanel(tabId)?.api.setTitle(next.title);
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
    return {
      ...ctx.extra,
      version: 1,
      preset: presetOfCount(ctx.columns),
      layout: ctx.layout,
      tabs: ctx.tabs,
      focusedTab: ctx.focusedTab,
      closed: ctx.closed,
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

  dispose(): void {
    for (const ctx of this.contexts.values()) {
      if (ctx.saveTimer) clearTimeout(ctx.saveTimer);
      for (const dispose of ctx.dispose) dispose();
    }
    this.listeners.clear();
  }
}
