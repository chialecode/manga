import {
  MangaError, OBJECT_KINDS, SIDEBAR_ITEM_TYPES, contextKey, itemTypeOfView, sidebarShown,
  type CommandEnvelope, type ContextId, type FindGroup, type FindItem, type FindType, type ObjectListKind, type ObjectRow, type RailView, type SidebarGroup, type SidebarItem, type SidebarItemType,
  type SidebarProgress, type SidebarSection, type SidebarView,
} from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { checkOpenable, inLibrarySql } from "./library-locations.ts";
import { displayTitle } from "./works-service.ts";

type Row = Record<string, unknown>;
/** A place the sidebar lists things of: "最近" (key "") or one project. */
type Place = { key: string; id: ContextId; kind: "recent" | "project"; name: string | null };

const RECENT_NAME = "最近";
const MEDIA = ["novel", "comic", "video"] as const;
const isMedia = (type: SidebarItemType): type is (typeof MEDIA)[number] => (MEDIA as readonly string[]).includes(type);
const isObjectType = (type: string): type is ObjectListKind => (OBJECT_KINDS as readonly string[]).includes(type);
/** The table each kind of project object is kept in. */
const OBJECT_TABLE: Record<ObjectListKind, string> = { whiteboard: "whiteboards", mindmap: "mindmaps", draft: "drafts", roughcut: "rough_cuts" };
const TRANSFERRING = new Set(["metadata", "choosing", "downloading", "verifying", "publishing", "importing"]);
const FINISHED = ["done", "failed"];

const escapeLike = (text: string) => `%${text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
/** The title the library shows for a work: the one the metadata chose, else the file's. */
const workTitle = (title: unknown, projection: unknown): string => displayTitle({ title: String(title ?? ""), projection_json: String(projection ?? "{}") });

/** What one command works out once and shares between its lists: which conversations hold a task, which files can be opened. */
class Scan {
  private readonly store: DrizzleStore;
  private runSessions: Set<string> | null = null;
  private activeSessions: Set<string> | null = null;
  private readonly openMemo = new Map<string, boolean>();

  constructor(store: DrizzleStore) {
    this.store = store;
  }

  /** The sessions that have had a task: a conversation about a book or a work is listed once something was asked in it. */
  runs(): Set<string> {
    this.runSessions ??= new Set((this.store.sqlite.prepare("SELECT DISTINCT session_id AS id FROM agent_runs").all() as Array<{ id: string }>).map((row) => row.id));
    return this.runSessions;
  }

  active(): Set<string> {
    this.activeSessions ??= new Set((this.store.sqlite.prepare("SELECT DISTINCT session_id AS id FROM agent_runs WHERE status IN ('queued','running','waiting_input')").all() as Array<{ id: string }>).map((row) => row.id));
    return this.activeSessions;
  }

  /** The same question the conversation list has always asked: a resource whose file is outside every library path or gone is not offered for opening (A-86). */
  openable(resourceId: string): boolean {
    let known = this.openMemo.get(resourceId);
    if (known === undefined) {
      known = checkOpenable(this.store, resourceId).state === "open";
      this.openMemo.set(resourceId, known);
    }
    return known;
  }

  /** The conversations that are listed: the general ones, and the others once something was asked in them. */
  listedSession(row: { id: string; kind: string }): boolean {
    return row.kind === "shared" || row.kind === "project" || this.runs().has(row.id);
  }
}

/** A thing a list offers and the time of its latest activity, which orders the list (计划 4.2). */
type Entry = { at: string; item: SidebarItem };
/** Newest activity first; the same time is ordered by the stable key, so paging neither repeats nor skips (计划 5.3 W2). */
const byActivity = (a: Entry, b: Entry) => (a.at === b.at ? (a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0) : a.at < b.at ? 1 : -1);

/** Where a page ends: the activity time and key of its last entry, so the next page starts right after it however the list moved meanwhile. */
const cursorOf = (entry: Entry) => Buffer.from(JSON.stringify([entry.at, entry.item.key])).toString("base64url");
function afterCursor(cursor: string | undefined): ((entry: Entry) => boolean) | null {
  if (!cursor) return null;
  try {
    const [at, key] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [unknown, unknown];
    if (typeof at !== "string" || typeof key !== "string") return null;
    return (entry) => entry.at < at || (entry.at === at && entry.item.key > key);
  } catch {
    return null;
  }
}
function cut(list: Entry[], cursor: string | undefined, limit: number): { items: SidebarItem[]; next: string | null } {
  const after = afterCursor(cursor);
  const start = after ? list.findIndex(after) : 0;
  if (start < 0) return { items: [], next: null };
  const page = list.slice(start, start + limit);
  const last = page.at(-1);
  return { items: page.map((entry) => entry.item), next: last && start + limit < list.length ? cursorOf(last) : null };
}

/** The name a resource of no work is shown under: its title without the file's extension, as the shelf shows it (A-105). */
const shownName = (title: string) => title.replace(/\.[a-z0-9]{1,5}$/i, "") || title;

/**
 * What the sidebar lists (A-99, 交互设计 2.10): for each view of the icon rail, the projects and "最近" with the things of one kind (the home: of every
 * kind), counted in a few queries however many projects there are, and listed a page at a time. Nothing here changes anything; it reads what the
 * other services keep, and what the person's own opening of a thing does stays with the openers of the interface.
 */
export class SidebarService {
  private readonly store: DrizzleStore;

  constructor(store: DrizzleStore) {
    this.store = store;
  }

  private all<T = Row>(sql: string, ...params: unknown[]): T[] {
    return this.store.sqlite.prepare(sql).all(...params) as T[];
  }
  private one<T = Row>(sql: string, ...params: unknown[]): T | undefined {
    return this.store.sqlite.prepare(sql).get(...params) as T | undefined;
  }

  /** "最近" and the projects that are not archived, in the order the sidebar shows them. */
  private places(): Place[] {
    const projects = this.all<{ id: string; name: string }>("SELECT id, name FROM projects WHERE status = 'active' ORDER BY updated_at DESC, id");
    return [{ key: "", id: null, kind: "recent", name: null }, ...projects.map((row): Place => ({ key: row.id, id: row.id, kind: "project", name: row.name }))];
  }

  private place(contextId: ContextId): Place | null {
    if (!contextId) return { key: "", id: null, kind: "recent", name: null };
    const row = this.one<{ id: string; name: string }>("SELECT id, name FROM projects WHERE id = ?", contextId);
    return row ? { key: row.id, id: row.id, kind: "project", name: row.name } : null;
  }

  // ----------------------------------------------------------------------------------------------------------------------- entries

  private item(place: Place, fields: Pick<SidebarItem, "key" | "type" | "title" | "open"> & Partial<SidebarItem>): SidebarItem {
    return { detail: null, updatedAt: null, running: false, materialId: null, coverId: null, progress: null, contextId: place.id, contextName: place.name, ...fields };
  }

  /** How far the person got with a resource, or with the resources of a work, in one context: the latest of them (A-105). */
  private progressOf(contextKey: string, resourceId: string | null, workId: string | null): SidebarProgress | null {
    const row = this.one<{ percent: number | null; label: string | null; kind: string }>(
      `SELECT p.percent AS percent, rr.ordinal_label AS label, COALESCE(pw.media_kind, rr.kind) AS kind FROM progress p JOIN resources rr ON rr.id = p.resource_id
       LEFT JOIN works pw ON pw.id = rr.work_id
       WHERE p.context_id = ? AND (rr.id = ? OR rr.work_id = ?) ORDER BY p.last_interaction_at DESC LIMIT 1`, contextKey, resourceId ?? "", workId ?? "");
    if (!row) return null;
    const percent = row.percent === null ? null : Math.round(Math.max(0, Math.min(1, row.percent)) * 100);
    return { percent, episode: row.kind === "video" && row.label ? row.label : null };
  }

  /**
   * Every thing of one kind each place offers (`only`: one place), newest activity first, as the entries the lists are cut from. What cannot be opened
   * (a file outside every library path or gone, A-86, 计划 4.3) is not offered, so a count is the number of rows the list holds.
   */
  private entries(type: SidebarItemType, places: Map<string, Place>, scan: Scan, only?: string): Map<string, Entry[]> {
    const found = new Map<string, Entry[]>();
    const add = (key: string, item: SidebarItem, at: string) => {
      const list = found.get(key) ?? [];
      list.push({ at, item });
      found.set(key, list);
    };
    const one = only !== undefined;
    if (type === "conversation") {
      for (const row of this.all<Row>(
        `SELECT s.id AS id, s.title AS title, s.kind AS kind, s.target_id AS targetId, s.updated_at AS updatedAt, COALESCE(s.project_id, '') AS k,
           (SELECT r.title FROM resources r WHERE r.id = s.target_id AND s.kind = 'resource') AS resourceTitle,
           (SELECT w.title FROM works w WHERE w.id = s.target_id AND s.kind = 'work') AS workTitle,
           (SELECT w.projection_json FROM works w WHERE w.id = s.target_id AND s.kind = 'work') AS workProjection
         FROM agent_sessions s ${one ? "WHERE COALESCE(s.project_id, '') = ?" : ""}`, ...(one ? [only] : []))) {
        const place = places.get(String(row.k));
        const id = String(row.id);
        const kind = String(row.kind);
        if (!place || !scan.listedSession({ id, kind })) continue;
        if (kind === "resource" && row.targetId && !scan.openable(String(row.targetId))) continue;
        const title = row.resourceTitle ? String(row.resourceTitle) : row.workTitle ? workTitle(row.workTitle, row.workProjection) : String(row.title);
        add(place.key, this.item(place, { key: `conversation:${id}`, type, title, open: { kind: "conversation", id, general: kind === "shared" || kind === "project" }, updatedAt: String(row.updatedAt), running: scan.active().has(id) }), String(row.updatedAt));
      }
    } else if (isMedia(type)) {
      const recent = places.get("");
      if (recent && (!one || only === "")) {
        // "最近" lists a work once (A-105): the resource of it last read or watched there is what opens. A resource of no work is its own entry.
        // An item dismissed in “最近” stays hidden until a newer action on it happens in “最近” (A-129).
        const dismissals = new Map(this.all<{ key: string; at: string }>("SELECT key, dismissed_at AS at FROM recent_dismissals").map((row) => [row.key, row.at]));
        const seen = new Set<string>();
        for (const row of this.all<Row>(
          `SELECT r.id AS id, r.title AS title, r.work_id AS workId, w.title AS wTitle, w.projection_json AS wProjection, w.cover_id AS coverId, p.last_interaction_at AS at
           FROM progress p JOIN resources r ON r.id = p.resource_id LEFT JOIN works w ON w.id = r.work_id
           WHERE p.context_id = '' AND COALESCE(w.media_kind, r.kind) = ? AND ${inLibrarySql("r")} ORDER BY p.last_interaction_at DESC, r.id`, type)) {
          const id = String(row.id);
          const workId = row.workId && row.wTitle !== null ? String(row.workId) : null;
          const key = workId ? `work:${workId}` : `resource:${id}`;
          if (seen.has(key) || !scan.openable(id)) continue;
          seen.add(key);
          const dismissedAt = dismissals.get(key);
          if (dismissedAt !== undefined && String(row.at) <= dismissedAt) continue;
          const title = workId ? workTitle(row.wTitle, row.wProjection) : shownName(String(row.title));
          add("", this.item(recent, {
            key, type, title, open: { kind: "resource", id, workId, mediaKind: type }, updatedAt: String(row.at),
            coverId: row.coverId ? String(row.coverId) : null, progress: this.progressOf("", id, null),
          }), String(row.at));
        }
      }
      for (const row of this.all<Row>(
        `SELECT pm.id AS materialId, pm.kind AS materialKind, pm.target_id AS targetId, pm.added_at AS addedAt, pm.project_id AS k,
           w.title AS wTitle, w.projection_json AS wProjection, w.cover_id AS wCover,
           r.title AS rTitle, r.work_id AS rWork, rw.title AS rwTitle, rw.projection_json AS rwProjection, rw.cover_id AS rwCover,
           (SELECT MAX(p.last_interaction_at) FROM progress p JOIN resources pr ON pr.id = p.resource_id
             WHERE p.context_id = pm.project_id AND ((pm.kind = 'work' AND pr.work_id = pm.target_id) OR (pm.kind = 'resource' AND pr.id = pm.target_id))) AS seenAt
         FROM project_materials pm
         LEFT JOIN works w ON pm.kind = 'work' AND w.id = pm.target_id
         LEFT JOIN resources r ON pm.kind = 'resource' AND r.id = pm.target_id
         LEFT JOIN works rw ON rw.id = r.work_id
         WHERE ((pm.kind = 'work' AND w.media_kind = ? AND EXISTS (SELECT 1 FROM resources wr WHERE wr.work_id = w.id AND ${inLibrarySql("wr")}))
             OR (pm.kind = 'resource' AND COALESCE(rw.media_kind, r.kind) = ? AND ${inLibrarySql("r")}))
           ${one ? "AND pm.project_id = ?" : ""}`, type, type, ...(one ? [only] : []))) {
        const place = places.get(String(row.k));
        if (!place) continue;
        const targetId = String(row.targetId);
        const at = String(row.seenAt ?? row.addedAt);
        if (row.materialKind === "work") {
          add(place.key, this.item(place, {
            key: `work:${targetId}`, type, title: workTitle(row.wTitle, row.wProjection), open: { kind: "work", id: targetId, mediaKind: type }, updatedAt: at,
            materialId: String(row.materialId), coverId: row.wCover ? String(row.wCover) : null, progress: this.progressOf(place.key, null, targetId),
          }), at);
          continue;
        }
        if (!scan.openable(targetId)) continue;
        const parent = row.rWork && row.rwTitle ? workTitle(row.rwTitle, row.rwProjection) : null;
        add(place.key, this.item(place, {
          key: `resource:${targetId}`, type, title: String(row.rTitle), detail: parent && parent !== row.rTitle ? parent : null,
          open: { kind: "resource", id: targetId, workId: row.rWork ? String(row.rWork) : null, mediaKind: type }, updatedAt: at, materialId: String(row.materialId),
          coverId: row.rwCover ? String(row.rwCover) : null, progress: this.progressOf(place.key, targetId, null),
        }), at);
      }
    } else if (type === "note") {
      for (const row of this.all<Row>(
        `SELECT o.id AS id, o.title AS title, o.updated_at AS updatedAt, pm.id AS materialId, COALESCE(pm.project_id, '') AS k FROM content_objects o
         LEFT JOIN project_materials pm ON pm.kind = 'note' AND pm.target_id = o.id
         WHERE o.type = 'notes.document' AND o.deleted_at IS NULL ${one ? "AND COALESCE(pm.project_id, '') = ?" : ""}`, ...(one ? [only] : []))) {
        const place = places.get(String(row.k));
        if (!place) continue;
        add(place.key, this.item(place, { key: `note:${row.id}`, type, title: String(row.title), open: { kind: "note", id: String(row.id) }, updatedAt: String(row.updatedAt), materialId: row.materialId ? String(row.materialId) : null }), String(row.updatedAt));
      }
    } else if (isObjectType(type)) {
      for (const row of this.all<Row>(`SELECT id, title, updated_at AS updatedAt, project_id AS k FROM ${OBJECT_TABLE[type]} WHERE project_id IS NOT NULL ${one ? "AND project_id = ?" : ""}`, ...(one ? [only] : []))) {
        // The objects of a project belong to the project: "最近" has none.
        const place = places.get(String(row.k));
        if (!place || place.kind === "recent") continue;
        add(place.key, this.item(place, { key: `${type}:${row.id}`, type, title: String(row.title), open: { kind: type, id: String(row.id) }, updatedAt: String(row.updatedAt) }), String(row.updatedAt));
      }
    }
    for (const list of found.values()) list.sort(byActivity);
    return found;
  }

  /** The things each place offers of the kinds asked for: per kind, and (`all`) every kind in one list by latest activity (A-103). */
  private lists(types: readonly SidebarItemType[], places: Map<string, Place>, scan: Scan, only?: string): Map<string, Map<SidebarItemType | "all", Entry[]>> {
    const found = new Map<string, Map<SidebarItemType | "all", Entry[]>>();
    for (const type of types) {
      for (const [key, list] of this.entries(type, places, scan, only)) {
        const inner = found.get(key) ?? new Map<SidebarItemType | "all", Entry[]>();
        inner.set(type, list);
        found.set(key, inner);
      }
    }
    if (types.length > 1) {
      for (const inner of found.values()) inner.set("all", [...inner.values()].flat().sort(byActivity));
    }
    return found;
  }

  private downloads(cursor: string | undefined, limit: number): SidebarSection {
    const rows = this.all<Row>(`SELECT id, name, source_ref AS sourceRef, state, updated_at AS updatedAt FROM acquisition_jobs WHERE state <> 'cancelled'
      ORDER BY (state IN (${FINISHED.map(() => "?").join(",")})) ASC, updated_at DESC, id`, ...FINISHED);
    const items = rows.map((row): SidebarItem => ({
      key: `download:${row.id}`, type: "download", title: String(row.name || row.sourceRef || ""), detail: String(row.state), open: { kind: "download", id: String(row.id) },
      contextId: null, contextName: null, updatedAt: String(row.updatedAt), running: TRANSFERRING.has(String(row.state)), materialId: null, coverId: null, progress: null,
    }));
    const offset = cursor && /^\d{1,7}$/.test(cursor) ? Number(cursor) : 0;
    const next = offset + limit < items.length ? String(offset + limit) : null;
    return { type: "download", total: items.length, items: items.slice(offset, offset + limit), loaded: true, nextCursor: next };
  }

  /** Hide a work (`work:<id>`) or standalone resource (`resource:<id>`) in "最近" until a newer action happens there (A-129). */
  dismissRecent(key: string, envelope?: CommandEnvelope): { key: string; dismissedAt: string; previousDismissedAt: string | null } {
    const colon = key.indexOf(":");
    const kind = colon > 0 ? key.slice(0, colon) : "";
    const targetId = colon > 0 ? key.slice(colon + 1) : "";
    if ((kind !== "work" && kind !== "resource") || !targetId) throw new MangaError("VALIDATION_ERROR", "invalid recent item key");
    const exists = kind === "work"
      ? this.one("SELECT 1 AS ok FROM works WHERE id = ?", targetId)
      : this.one("SELECT 1 AS ok FROM resources WHERE id = ?", targetId);
    if (!exists) throw new MangaError("NOT_FOUND", "the recent item does not exist");
    const previous = this.one<{ at: string }>("SELECT dismissed_at AS at FROM recent_dismissals WHERE key = ?", key)?.at ?? null;
    const latest = kind === "work"
      ? this.one<{ at: string | null }>("SELECT MAX(p.last_interaction_at) AS at FROM progress p JOIN resources r ON r.id = p.resource_id WHERE p.context_id = '' AND r.work_id = ?", targetId)?.at ?? null
      : this.one<{ at: string | null }>("SELECT MAX(last_interaction_at) AS at FROM progress WHERE context_id = '' AND resource_id = ?", targetId)?.at ?? null;
    const now = new Date().toISOString();
    const dismissedAt = latest && latest > now ? latest : now;
    const result = { key, dismissedAt, previousDismissedAt: previous };
    this.store.commit({
      mutations: [{ sql: "INSERT INTO recent_dismissals(key, dismissed_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET dismissed_at = excluded.dismissed_at", params: [key, dismissedAt] }],
      events: [{ type: "recent.dismissed", payload: { key, dismissedAt } }],
      idempotencyKey: envelope?.idempotencyKey,
      commandId: envelope?.commandId,
      result,
    });
    return result;
  }

  /** Restore an item dismissed in “最近” (`workspace.undismissRecent`, A-129). */
  undismissRecent(key: string, previousDismissedAt?: string | null, envelope?: CommandEnvelope): { key: string; restored: boolean } {
    const result = { key, restored: true };
    this.store.commit({
      mutations: [
        previousDismissedAt
          ? { sql: "INSERT INTO recent_dismissals(key, dismissed_at) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET dismissed_at = excluded.dismissed_at", params: [key, previousDismissedAt] }
          : { sql: "DELETE FROM recent_dismissals WHERE key = ?", params: [key] },
      ],
      events: [{ type: "recent.undismissed", payload: { key } }],
      idempotencyKey: envelope?.idempotencyKey,
      commandId: envelope?.commandId,
      result,
    });
    return result;
  }

  /** The sidebar of one view (`workspace.sidebar`). */
  sidebar(input: { view: RailView; perGroup?: number; open?: ContextId[] }): SidebarView {
    const perGroup = input.perGroup ?? sidebarShown(input.view);
    if (input.view === "downloads") return { view: input.view, groups: [], downloads: this.downloads(undefined, perGroup) };
    const scan = new Scan(this.store);
    const own = itemTypeOfView(input.view);
    const places = this.places();
    const lists = this.lists(own ? [own] : SIDEBAR_ITEM_TYPES, new Map(places.map((place) => [place.key, place])), scan);
    const wanted = input.open ? new Set(input.open.map(contextKey)) : null;
    const groups: SidebarGroup[] = [];
    for (const place of places) {
      // The objects of a project belong to the project: a view of them has no "最近".
      if (place.kind === "recent" && own && isObjectType(own)) continue;
      // The home lists every kind in one list (A-103); a view of one kind lists the place even when it is empty, so it can say so.
      const type: SidebarItemType | "all" = own ?? "all";
      const list = lists.get(place.key)?.get(type) ?? [];
      const open = wanted === null || wanted.has(place.key);
      const { items, next } = open ? cut(list, undefined, perGroup) : { items: [], next: null };
      groups.push({ contextId: place.id, kind: place.kind, name: place.name ?? RECENT_NAME, sections: [{ type, total: list.length, items, loaded: open || list.length === 0, nextCursor: next }] });
    }
    return { view: input.view, groups, downloads: null };
  }

  /** More of one list (`workspace.items`). A project that is gone answers with an empty list: what was asked for may have been deleted a moment ago. */
  items(input: { view: RailView; contextId: ContextId; type?: SidebarItemType; limit: number; cursor?: string }): { type: SidebarItemType | "download" | "all"; contextId: ContextId; total: number; items: SidebarItem[]; nextCursor: string | null } {
    if (input.view === "downloads") {
      const section = this.downloads(input.cursor, input.limit);
      return { type: "download", contextId: null, total: section.total, items: section.items, nextCursor: section.nextCursor };
    }
    const own = itemTypeOfView(input.view) ?? input.type ?? null;
    const type: SidebarItemType | "all" = own ?? "all";
    const place = this.place(input.contextId);
    if (!place || (place.kind === "recent" && own && isObjectType(own))) return { type, contextId: input.contextId, total: 0, items: [], nextCursor: null };
    const list = this.lists(own ? [own] : SIDEBAR_ITEM_TYPES, new Map([[place.key, place]]), new Scan(this.store), place.key).get(place.key)?.get(type) ?? [];
    const { items, next } = cut(list, input.cursor, input.limit);
    return { type, contextId: input.contextId, total: list.length, items, nextCursor: next };
  }

  /** The whiteboards, maps, drafts or cuts of every project, newest first (`workspace.objects`). */
  objects(input: { kind: ObjectListKind; q?: string; limit: number; offset: number }): { items: ObjectRow[]; total: number; nextOffset: number | null } {
    const table = OBJECT_TABLE[input.kind];
    const like = input.q ? escapeLike(input.q) : null;
    const where = `FROM ${table} o JOIN projects p ON p.id = o.project_id ${like ? "WHERE o.title LIKE ? ESCAPE '\\'" : ""}`;
    const params = like ? [like] : [];
    const total = this.one<{ n: number }>(`SELECT COUNT(*) AS n ${where}`, ...params)?.n ?? 0;
    const rows = this.all<{ id: string; title: string; updatedAt: string; projectId: string; projectName: string; status: string }>(
      `SELECT o.id AS id, o.title AS title, o.updated_at AS updatedAt, o.project_id AS projectId, p.name AS projectName, p.status AS status ${where} ORDER BY o.updated_at DESC, o.id LIMIT ? OFFSET ?`, ...params, input.limit, input.offset);
    const items: ObjectRow[] = rows.map((row) => ({ kind: input.kind, id: row.id, title: row.title, projectId: row.projectId, projectName: row.projectName, projectArchived: row.status === "archived", updatedAt: row.updatedAt }));
    return { items, total, nextOffset: input.offset + rows.length < total ? input.offset + rows.length : null };
  }

  // -------------------------------------------------------------------------------------------------------------------------- find

  /** The things whose name has the text in it, a few of each kind (`workspace.find`). */
  find(input: { q: string; view?: RailView; perType: number }): { groups: FindGroup[] } {
    const scan = new Scan(this.store);
    const like = escapeLike(input.q.trim());
    const own = input.view ? itemTypeOfView(input.view) : null;
    const wants = (type: FindType) => (input.view === "downloads" ? false : type === "project" ? !own : own ? type === own : true);
    const groups: FindGroup[] = [];
    const push = (type: FindType, items: FindItem[]) => { if (items.length) groups.push({ type, items }); };
    const limit = input.perType;
    const named = (id: string | null, name: string | null) => ({ contextId: id, contextName: name });

    if (wants("project")) {
      push("project", this.all<{ id: string; name: string; updatedAt: string }>("SELECT id, name, updated_at AS updatedAt FROM projects WHERE status = 'active' AND name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, id LIMIT ?", like, limit)
        .map((row): FindItem => ({ key: `project:${row.id}`, type: "project", title: row.name, detail: null, open: { kind: "project", id: row.id }, ...named(row.id, row.name), updatedAt: row.updatedAt, running: false, materialId: null, coverId: null, progress: null })));
    }
    if (wants("conversation")) {
      const rows = this.all<Row>(
        `SELECT s.id AS id, s.title AS title, s.kind AS kind, s.target_id AS targetId, s.updated_at AS updatedAt, s.project_id AS projectId, p.name AS projectName,
           (SELECT r.title FROM resources r WHERE r.id = s.target_id AND s.kind = 'resource') AS resourceTitle
         FROM agent_sessions s LEFT JOIN projects p ON p.id = s.project_id
         WHERE s.title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM resources r WHERE r.id = s.target_id AND s.kind = 'resource' AND r.title LIKE ? ESCAPE '\\')
         ORDER BY s.updated_at DESC, s.id LIMIT 200`, like, like);
      const made: FindItem[] = [];
      for (const row of rows) {
        if (made.length >= limit) break;
        if (!scan.listedSession({ id: String(row.id), kind: String(row.kind) })) continue;
        if (row.kind === "resource" && row.targetId && !scan.openable(String(row.targetId))) continue;
        const general = row.kind === "shared" || row.kind === "project";
        made.push({ key: `conversation:${row.id}`, type: "conversation", title: String(row.resourceTitle ?? row.title), detail: null, open: { kind: "conversation", id: String(row.id), general }, ...named(row.projectId ? String(row.projectId) : null, row.projectName ? String(row.projectName) : null), updatedAt: String(row.updatedAt), running: scan.active().has(String(row.id)), materialId: null, coverId: null, progress: null });
      }
      push("conversation", made);
    }
    for (const type of MEDIA) {
      if (!wants(type)) continue;
      const works = this.all<Row>(
        `SELECT id, title, projection_json AS projection, created_at AS createdAt, cover_id AS coverId FROM works w
         WHERE media_kind = ? AND EXISTS (SELECT 1 FROM resources rr WHERE rr.work_id = w.id AND ${inLibrarySql("rr")})
           AND (title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR json_extract(projection_json, '$.title.value') LIKE ? ESCAPE '\\' OR json_extract(projection_json, '$.titleOriginal.value') LIKE ? ESCAPE '\\')
         ORDER BY COALESCE(last_opened_at, '') DESC, created_at DESC, id LIMIT ?`, type, like, like, like, like, limit);
      const items: FindItem[] = works.map((row) => ({ key: `work:${row.id}`, type, title: workTitle(row.title, row.projection), detail: null, open: { kind: "work", id: String(row.id), mediaKind: type }, contextName: null, updatedAt: String(row.createdAt), running: false, materialId: null, coverId: row.coverId ? String(row.coverId) : null, progress: null }));
      if (items.length < limit) {
        const resources = this.all<Row>(
          `SELECT r.id AS id, r.title AS title, r.work_id AS workId, r.created_at AS createdAt, w.title AS wTitle, w.projection_json AS wProjection, w.cover_id AS coverId
           FROM resources r LEFT JOIN works w ON w.id = r.work_id
           WHERE COALESCE(w.media_kind, r.kind) = ? AND ${inLibrarySql("r")} AND r.title LIKE ? ESCAPE '\\' ORDER BY r.created_at DESC, r.id LIMIT ?`, type, like, (limit - items.length) * 3 + 6);
        for (const row of resources) {
          if (items.length >= limit) break;
          if (!scan.openable(String(row.id))) continue;
          const parent = row.workId && row.wTitle ? workTitle(row.wTitle, row.wProjection) : null;
          items.push({ key: `resource:${row.id}`, type, title: String(row.title), detail: parent && parent !== row.title ? parent : null, open: { kind: "resource", id: String(row.id), workId: row.workId ? String(row.workId) : null, mediaKind: type }, contextName: null, updatedAt: String(row.createdAt), running: false, materialId: null, coverId: row.coverId ? String(row.coverId) : null, progress: null });
        }
      }
      push(type, items);
    }
    if (wants("note")) {
      push("note", this.all<Row>("SELECT id, title, updated_at AS updatedAt FROM content_objects WHERE type = 'notes.document' AND deleted_at IS NULL AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, id LIMIT ?", like, limit)
        .map((row): FindItem => ({ key: `note:${row.id}`, type: "note", title: String(row.title), detail: null, open: { kind: "note", id: String(row.id) }, contextName: null, updatedAt: String(row.updatedAt), running: false, materialId: null, coverId: null, progress: null })));
    }
    for (const type of OBJECT_KINDS) {
      if (!wants(type)) continue;
      push(type, this.all<Row>(`SELECT o.id AS id, o.title AS title, o.updated_at AS updatedAt, o.project_id AS projectId, p.name AS projectName FROM ${OBJECT_TABLE[type]} o JOIN projects p ON p.id = o.project_id
        WHERE o.title LIKE ? ESCAPE '\\' ORDER BY o.updated_at DESC, o.id LIMIT ?`, like, limit)
        .map((row): FindItem => ({ key: `${type}:${row.id}`, type, title: String(row.title), detail: null, open: { kind: type, id: String(row.id) }, ...named(String(row.projectId), String(row.projectName)), updatedAt: String(row.updatedAt), running: false, materialId: null, coverId: null, progress: null })));
    }
    return { groups };
  }
}
