import { WORKSPACE_CLOSED_LIMIT, WORKSPACE_HISTORY_LIMIT, WORKSPACE_TAB_KINDS, type WorkspaceTab, type WorkspaceTabKind } from "@manga/contracts";

/**
 * The tabs of a context as plain data (A-94, A-95). Nothing here knows about the screen: a tab is a kind, a target (what it shows), a view (where it is
 * in it) and its own back/forward history. The controller turns these into panels; the saved state of a context is these tabs and the layout.
 */

export type Target = Record<string, unknown>;

/** What to open: a tab of `kind` showing `target`. */
export type OpenRequest = {
  kind: string;
  target?: Target;
  title?: string;
  /** "reuse" (the default) switches to the tab that already shows the same thing; "new" always makes a tab (the "+" button, Ctrl + click). */
  mode?: "reuse" | "new";
  /** Open behind the tab in front: the focus stays where it is (middle click, Ctrl + click). */
  background?: boolean;
  /** Something for the tab's content to do once, not saved: a place to jump to, a block to show, a source card. */
  launch?: Record<string, unknown>;
};

export const KNOWN_KINDS: ReadonlySet<string> = new Set(WORKSPACE_TAB_KINDS);
export const isKnownKind = (kind: string): kind is WorkspaceTabKind => KNOWN_KINDS.has(kind);

/** The kinds that read a resource: their content is heavy, so only some of the ones out of sight stay loaded. */
export const READER_KIND = "reader";
/** The kinds of the objects of a project that stand as tabs of their own. */
export const PROJECT_OBJECT_KINDS = ["whiteboard", "mindmap", "draft", "roughcut"] as const;

export const str = (value: unknown): string => (typeof value === "string" ? value : "");

/**
 * What makes two tabs the same tab: opening something a context already shows switches to it. A library tab has no key (there can be several);
 * a kind this version does not know has none either.
 */
export function tabKey(kind: string, target: Target): string | null {
  switch (kind) {
    case "reader": return `reader:${str(target.resourceId)}`;
    case "note": return `note:${str(target.objectId)}`;
    case "project": return `project:${str(target.projectId)}`;
    case "whiteboard": case "mindmap": case "draft": case "roughcut": return `${kind}:${str(target.projectId)}:${str(target.objectId)}`;
    case "conversation": return `conversation:${str(target.sessionId)}`;
    // The management tabs: one of each kind of thing (the conversations, the notes, the whiteboards …).
    case "records": return `records:${str(target.type)}`;
    case "objects": return `objects:${str(target.kind)}`;
    case "downloads": return kind;
    default: return null;
  }
}

let counter = 0;
/** A tab id: unique in a context, short enough for the saved state. */
export function newTabId(now = Date.now()): string {
  counter += 1;
  return `t${now.toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`.slice(0, 64);
}

export function makeTab(request: Pick<OpenRequest, "kind" | "target" | "title">, id: string = newTabId()): WorkspaceTab {
  const target = request.target ?? {};
  const title = (request.title ?? "").slice(0, 200);
  return { id, kind: request.kind, target, title, view: {}, history: { entries: [{ target, title }], index: 0 } };
}

export const findByKey = (tabs: readonly WorkspaceTab[], kind: string, target: Target): WorkspaceTab | undefined => {
  const key = tabKey(kind, target);
  return key === null ? undefined : tabs.find((tab) => tabKey(tab.kind, tab.target) === key);
};

// ------------------------------------------------------------------------------------------------------------ a tab's own history

/** The tab went somewhere else: the places ahead of it are dropped, and the oldest places beyond the limit. */
export function navigateTab(tab: WorkspaceTab, target: Target, title: string): WorkspaceTab {
  const entries = tab.history?.entries ?? [{ target: tab.target, title: tab.title }];
  const index = tab.history?.index ?? 0;
  const kept = [...entries.slice(0, index + 1), { target, title: title.slice(0, 200) }];
  const cut = kept.length > WORKSPACE_HISTORY_LIMIT ? kept.slice(kept.length - WORKSPACE_HISTORY_LIMIT) : kept;
  return { ...tab, target, title: title.slice(0, 200), view: {}, history: { entries: cut, index: cut.length - 1 } };
}

export const canStep = (tab: WorkspaceTab | undefined, delta: -1 | 1): boolean => {
  if (!tab?.history) return false;
  const next = tab.history.index + delta;
  return next >= 0 && next < tab.history.entries.length;
};

/** The tab at the place before (-1) or after (+1) this one; null at the end of the history. */
export function stepTab(tab: WorkspaceTab, delta: -1 | 1): WorkspaceTab | null {
  if (!canStep(tab, delta) || !tab.history) return null;
  const index = tab.history.index + delta;
  const entry = tab.history.entries[index]!;
  return { ...tab, target: entry.target, title: entry.title, view: {}, history: { ...tab.history, index } };
}

/** The same tab with a better name for where it is now (the title of the book once it has loaded) — the history keeps it too. */
export function retitleTab(tab: WorkspaceTab, title: string): WorkspaceTab {
  const name = title.slice(0, 200);
  if (tab.title === name) return tab;
  const history = tab.history
    ? { ...tab.history, entries: tab.history.entries.map((entry, at) => (at === tab.history!.index ? { ...entry, title: name } : entry)) }
    : undefined;
  return { ...tab, title: name, ...(history ? { history } : {}) };
}

/** The target of the tab changed in place (a reader's work id became known): the history's current place follows, no new place is made. */
export function retargetTab(tab: WorkspaceTab, patch: Target): WorkspaceTab {
  const target = { ...tab.target, ...patch };
  const history = tab.history
    ? { ...tab.history, entries: tab.history.entries.map((entry, at) => (at === tab.history!.index ? { ...entry, target: { ...entry.target, ...patch } } : entry)) }
    : undefined;
  return { ...tab, target, ...(history ? { history } : {}) };
}

// ------------------------------------------------------------------------------------------------------------------ closed tabs

/** A closed tab goes to the front of the list that "reopen" takes from; the list keeps the last ten. */
export function pushClosed(closed: readonly WorkspaceTab[], tab: WorkspaceTab): WorkspaceTab[] {
  return [tab, ...closed.filter((item) => item.id !== tab.id)].slice(0, WORKSPACE_CLOSED_LIMIT);
}

// ---------------------------------------------------------------------------------------------------------------------- layouts

/**
 * Splits a sequence of tabs over `columns` columns in order: the first columns take the remainder, so four tabs over three columns are 2, 1, 1.
 * Fewer tabs than columns leaves the last columns empty.
 */
export function distribute<T>(items: readonly T[], columns: number): T[][] {
  const count = Math.max(1, columns);
  const base = Math.floor(items.length / count);
  const extra = items.length % count;
  const result: T[][] = [];
  let at = 0;
  for (let column = 0; column < count; column++) {
    const size = base + (column < extra ? 1 : 0);
    result.push(items.slice(at, at + size));
    at += size;
  }
  return result;
}

type GridNode = { type?: string; data?: unknown };
/**
 * The groups of a dock layout in reading order — left to right, top to bottom — read from its serialisation. A column's number (Ctrl+1 … Ctrl+4) is its
 * place in this order.
 */
export function gridOrder(layout: unknown): string[] {
  const root = ((layout as { grid?: { root?: GridNode } } | null)?.grid?.root) ?? null;
  const out: string[] = [];
  const walk = (node: GridNode | null | undefined) => {
    if (!node) return;
    if (node.type === "leaf") {
      const id = (node.data as { id?: unknown } | undefined)?.id;
      if (typeof id === "string") out.push(id);
      return;
    }
    if (Array.isArray(node.data)) for (const child of node.data) walk(child as GridNode);
  };
  walk(root);
  return out;
}

/** The panels of each group of a layout, in the order the layout lists them. */
export function groupPanels(layout: unknown): Array<{ id: string; panels: string[] }> {
  const root = ((layout as { grid?: { root?: GridNode } } | null)?.grid?.root) ?? null;
  const out: Array<{ id: string; panels: string[] }> = [];
  const walk = (node: GridNode | null | undefined) => {
    if (!node) return;
    if (node.type === "leaf") {
      const data = node.data as { id?: unknown; views?: unknown } | undefined;
      if (typeof data?.id === "string") out.push({ id: data.id, panels: Array.isArray(data.views) ? data.views.filter((item): item is string => typeof item === "string") : [] });
      return;
    }
    if (Array.isArray(node.data)) for (const child of node.data) walk(child as GridNode);
  };
  walk(root);
  return out;
}
