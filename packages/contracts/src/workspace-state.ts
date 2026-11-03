import { z } from "zod";

/**
 * Where the person is working (A-94): a project, or "最近". The id of a context is the id of its project; "最近" is `null` in interfaces and the
 * empty string in the database. Tabs, layouts, conversations and progress are kept per context; resources, works, notes, recordings and the
 * objects of a project are not.
 */
export const ContextIdSchema = z.string().min(1).max(256).nullable();
export type ContextId = z.infer<typeof ContextIdSchema>;

/** The database form of a context id. */
export const contextKey = (contextId: ContextId | undefined): string => contextId ?? "";
/** The interface form of a database context id. */
export const contextFromKey = (key: string | null | undefined): ContextId => (key ? key : null);

export const WORKSPACE_PRESETS = ["single", "two", "three", "quad"] as const;
export type WorkspacePreset = (typeof WORKSPACE_PRESETS)[number];
/** The number of columns of each preset. */
export const PRESET_COLUMNS: Readonly<Record<WorkspacePreset, number>> = { single: 1, two: 2, three: 3, quad: 4 };

/**
 * The tab kinds this version can open. A saved tab of another kind is kept as it is and shown as unavailable, except the kinds of `LEGACY_TAB_KINDS`.
 * "records" is the management of conversations and notes, "objects" the management of the whiteboards, maps, drafts or cuts of every project.
 */
export const WORKSPACE_TAB_KINDS = [
  "library", "reader", "note", "project", "whiteboard", "mindmap", "draft", "roughcut", "conversation", "records", "objects", "downloads",
] as const;
export type WorkspaceTabKind = (typeof WORKSPACE_TAB_KINDS)[number];

/**
 * The kinds that were tabs once and are not any more: search is a floating box (A-100), settings, the plugins and the shortcuts are the settings view
 * outside the workspace (A-101). A saved layout that still holds one loses it, and nothing else.
 */
export const LEGACY_TAB_KINDS = ["search", "settings", "plugins", "keys"] as const;
const LEGACY = new Set<string>(LEGACY_TAB_KINDS);

/** The same state without the tabs of the kinds that are gone, in the open tabs and in the closed ones; the focus moves to a tab that is left. */
export function dropLegacyTabs(state: WorkspaceState): { state: WorkspaceState; dropped: number } {
  const tabs = state.tabs.filter((tab) => !LEGACY.has(tab.kind));
  const closed = state.closed.filter((tab) => !LEGACY.has(tab.kind));
  const dropped = state.tabs.length - tabs.length + state.closed.length - closed.length;
  if (dropped === 0) return { state, dropped: 0 };
  const focusedTab = state.focusedTab && tabs.some((tab) => tab.id === state.focusedTab) ? state.focusedTab : tabs[0]?.id ?? null;
  return { state: { ...state, tabs, closed, focusedTab }, dropped };
}

/** How many tabs a context keeps, how many closed tabs can be reopened, and the largest saved state of one context (A-94). */
export const WORKSPACE_TAB_LIMIT = 100;
export const WORKSPACE_CLOSED_LIMIT = 10;
export const WORKSPACE_STATE_BYTES = 256 * 1024;
export const WORKSPACE_HISTORY_LIMIT = 50;

const object = z.record(z.string(), z.unknown());

/** One step of a tab's own history (back and forward): where the tab was, and what it was called there. */
export const WorkspaceHistoryEntrySchema = z.object({ target: object, title: z.string().max(200) }).strict();

/**
 * One tab. The kind is an open set: a tab saved by a newer version keeps its kind, target, view and any field this version does not know, and is
 * written back unchanged. `target` says what the tab shows, `view` where it is in it (position, zoom, scroll, filters).
 */
export const WorkspaceTabSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.string().min(1).max(64),
  target: object,
  title: z.string().max(200),
  view: object,
  history: z.object({ entries: z.array(WorkspaceHistoryEntrySchema).max(WORKSPACE_HISTORY_LIMIT), index: z.number().int().nonnegative() }).strict().optional(),
}).catchall(z.unknown());
export type WorkspaceTab = z.infer<typeof WorkspaceTabSchema>;

/**
 * The feature views of the rail (A-107) that have a main area of their own. The home is the other one: its layout is the state's own `preset`, `layout`
 * and `focusedTab`, and it holds every tab of the context. The same list as the rail's hideable views (`HIDEABLE_RAIL_VIEWS`).
 */
export const WORKSPACE_FEATURE_VIEWS = ["conversation", "novel", "comic", "video", "note", "whiteboard", "mindmap", "draft", "roughcut", "downloads"] as const;
export type WorkspaceFeatureView = (typeof WORKSPACE_FEATURE_VIEWS)[number];
export type WorkspaceView = "home" | WorkspaceFeatureView;
const FEATURE_VIEWS = new Set<string>(WORKSPACE_FEATURE_VIEWS);
export const isFeatureView = (view: string): view is WorkspaceFeatureView => FEATURE_VIEWS.has(view);

const MEDIA_VIEWS = new Set<string>(["novel", "comic", "video"]);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * The feature view a tab belongs to (A-107, 计划 4.1), or null when it is shown in the home only (the library overview, a project's page, the records of
 * every kind, a kind this version does not know). Every tab is in the home as well.
 */
export function viewOfTab(tab: Pick<WorkspaceTab, "kind" | "target">): WorkspaceFeatureView | null {
  const target = tab.target ?? {};
  switch (tab.kind) {
    case "reader": { const media = str(target.mediaKind) || "novel"; return MEDIA_VIEWS.has(media) ? (media as WorkspaceFeatureView) : null; }
    case "library": {
      const page = str(target.page);
      if (MEDIA_VIEWS.has(page)) return page as WorkspaceFeatureView;
      if (page === "work" && MEDIA_VIEWS.has(str(target.kind))) return str(target.kind) as WorkspaceFeatureView;
      return null;
    }
    case "note": return "note";
    case "whiteboard": case "mindmap": case "draft": case "roughcut": return tab.kind;
    case "conversation": return "conversation";
    case "records": return target.type === "note" ? "note" : target.type === "conversation" ? "conversation" : null;
    case "objects": { const kind = str(target.kind); return FEATURE_VIEWS.has(kind) ? (kind as WorkspaceFeatureView) : null; }
    case "downloads": return "downloads";
    default: return null;
  }
}

/** The arrangement of one feature view: its split layout (null until one was made: the tabs are then placed by `preset`) and the tab it had in front. */
export const WorkspaceViewLayoutSchema = z.object({
  preset: z.enum(WORKSPACE_PRESETS),
  layout: object.nullable(),
  focusedTab: z.string().min(1).max(64).nullable(),
}).catchall(z.unknown());
export type WorkspaceViewLayout = z.infer<typeof WorkspaceViewLayoutSchema>;

/** Where a closed tab was (计划 4.8): the view, the column (in reading order, from 0) and its place in that column's strip. Kept on the closed tab. */
export const ClosedPlaceSchema = z.object({ view: z.string().min(1).max(32), column: z.number().int().nonnegative(), index: z.number().int().nonnegative() }).strict();
export type ClosedPlace = z.infer<typeof ClosedPlaceSchema>;

const WorkspaceStateV2Schema = z.object({
  version: z.literal(2),
  preset: z.enum(WORKSPACE_PRESETS),
  layout: object.nullable(),
  tabs: z.array(WorkspaceTabSchema).max(WORKSPACE_TAB_LIMIT),
  focusedTab: z.string().min(1).max(64).nullable(),
  closed: z.array(WorkspaceTabSchema).max(WORKSPACE_CLOSED_LIMIT),
  views: z.record(z.string().min(1).max(32), WorkspaceViewLayoutSchema),
}).catchall(z.unknown());

/**
 * The feature views of a state saved before them (version 1): the layout it had becomes the home's, and each feature view gets its kind of tab in the
 * order they had, in one column, the first of them in front (or the one that had the focus, when it is of that kind).
 */
export function featureViewsOf(tabs: readonly Pick<WorkspaceTab, "id" | "kind" | "target">[], focusedTab: string | null): Record<string, WorkspaceViewLayout> {
  const views: Record<string, WorkspaceViewLayout> = {};
  for (const tab of tabs) {
    const view = viewOfTab(tab);
    if (!view) continue;
    const entry = views[view] ?? (views[view] = { preset: "single", layout: null, focusedTab: tab.id });
    if (tab.id === focusedTab) entry.focusedTab = tab.id;
  }
  return views;
}

/** A version 1 state read as version 2 (计划 4.1); anything else is left for the schema to judge. */
export function upgradeWorkspaceState(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || (raw as { version?: unknown }).version !== 1) return raw;
  const old = raw as { tabs?: unknown; focusedTab?: unknown };
  const tabs = Array.isArray(old.tabs) ? old.tabs.filter((tab): tab is WorkspaceTab => Boolean(tab) && typeof tab === "object" && typeof (tab as WorkspaceTab).kind === "string" && typeof (tab as WorkspaceTab).id === "string") : [];
  return { ...raw, version: 2, views: featureViewsOf(tabs, typeof old.focusedTab === "string" ? old.focusedTab : null) };
}

/**
 * The saved state of one context (version 2, A-107): the tabs, the tabs that were closed last, the home's split layout (the docking library's own
 * serialisation, or null before any arrangement was made, in which case the tabs are placed by `preset`) and the tab in front there, and the same for
 * each feature view in `views`. A version 1 state is read as version 2 (`upgradeWorkspaceState`).
 */
export const WorkspaceStateSchema = z.preprocess(upgradeWorkspaceState, WorkspaceStateV2Schema);
export type WorkspaceState = z.infer<typeof WorkspaceStateV2Schema>;

export const EMPTY_WORKSPACE_STATE: WorkspaceState = { version: 2, preset: "single", layout: null, tabs: [], focusedTab: null, closed: [], views: {} };

/** One entry of the sidebar: a project, or "最近". */
export const WorkspaceContextSchema = z.object({
  contextId: ContextIdSchema,
  kind: z.enum(["recent", "project"]),
  name: z.string(),
  status: z.enum(["active", "archived"]),
  conversationCount: z.number().int().nonnegative(),
  tabCount: z.number().int().nonnegative(),
  lastActivityAt: z.string().nullable(),
}).strict();
export type WorkspaceContext = z.infer<typeof WorkspaceContextSchema>;

/** The origin of a project material: put there by the person, or added because the thing was opened or made inside the project (Q-33). */
export const MATERIAL_ORIGINS = ["manual", "auto"] as const;
export type MaterialOrigin = (typeof MATERIAL_ORIGINS)[number];

/**
 * Cuts a state to the size the profile keeps (A-94): the oldest closed tabs go first, then the view state of the tabs that are not the focused one
 * (the light pages first), then the layouts of the feature views, the home's last. The shape stays valid at every step; what cannot be cut is reported to the caller by the size it still has.
 */
export function trimWorkspaceState(state: WorkspaceState, limit = WORKSPACE_STATE_BYTES): { state: WorkspaceState; trimmed: boolean; bytes: number } {
  const size = (value: WorkspaceState) => new TextEncoder().encode(JSON.stringify(value)).length;
  let current = state;
  let bytes = size(current);
  if (bytes <= limit) return { state: current, trimmed: false, bytes };
  let closed = [...current.closed];
  while (bytes > limit && closed.length) {
    closed = closed.slice(0, -1);
    current = { ...current, closed };
    bytes = size(current);
  }
  const light = new Set<string>(["library", "records", "objects", "downloads", "project", "conversation"]);
  const order = [...current.tabs].sort((a, b) => Number(light.has(b.kind)) - Number(light.has(a.kind)));
  for (const tab of order) {
    if (bytes <= limit) break;
    if (tab.id === current.focusedTab) continue;
    current = { ...current, tabs: current.tabs.map((item) => (item.id === tab.id ? { ...item, view: {} } : item)) };
    bytes = size(current);
  }
  // The feature views' layouts go before the home's: a view without one places its tabs by its preset.
  for (const view of Object.keys(current.views ?? {})) {
    if (bytes <= limit) break;
    if (!current.views[view]?.layout) continue;
    current = { ...current, views: { ...current.views, [view]: { ...current.views[view]!, layout: null } } };
    bytes = size(current);
  }
  if (bytes > limit && current.layout) {
    current = { ...current, layout: null };
    bytes = size(current);
  }
  return { state: current, trimmed: true, bytes };
}
