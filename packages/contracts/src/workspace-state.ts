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
 * The saved state of one context: the split layout (the docking library's own serialisation, or null before any arrangement was made, in which case
 * the tabs are placed by `preset`), the tabs, the focused tab and the tabs that were closed last.
 */
export const WorkspaceStateSchema = z.object({
  version: z.literal(1),
  preset: z.enum(WORKSPACE_PRESETS),
  layout: object.nullable(),
  tabs: z.array(WorkspaceTabSchema).max(WORKSPACE_TAB_LIMIT),
  focusedTab: z.string().min(1).max(64).nullable(),
  closed: z.array(WorkspaceTabSchema).max(WORKSPACE_CLOSED_LIMIT),
}).catchall(z.unknown());
export type WorkspaceState = z.infer<typeof WorkspaceStateSchema>;

export const EMPTY_WORKSPACE_STATE: WorkspaceState = { version: 1, preset: "single", layout: null, tabs: [], focusedTab: null, closed: [] };

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
 * (the light pages first). The shape stays valid at every step; what cannot be cut is reported to the caller by the size it still has.
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
  if (bytes > limit && current.layout) {
    current = { ...current, layout: null };
    bytes = size(current);
  }
  return { state: current, trimmed: true, bytes };
}
