import {
  OBJECT_KINDS, SIDEBAR_ITEM_TYPES, contextKey, itemTypeOfView,
  type ContextId, type FindGroup, type FindItem, type FindType, type ObjectListKind, type ObjectRow, type RailView, type SidebarGroup, type SidebarItem, type SidebarItemType,
  type SidebarSection, type SidebarView,
} from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { checkOpenable } from "./library-locations.ts";
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

type Candidates = { fetch: (offset: number, count: number) => Row[]; map: (row: Row) => SidebarItem | null };

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

  // ------------------------------------------------------------------------------------------------------------------------ counts

  /** How many things of each kind each place holds, from one query a kind. Files that cannot be opened are not looked for here, so a count may be a little high. */
  private counts(types: readonly SidebarItemType[], scan: Scan): Map<string, Map<SidebarItemType, number>> {
    const found = new Map<string, Map<SidebarItemType, number>>();
    const add = (key: string, type: SidebarItemType, n: number) => {
      if (n <= 0) return;
      const inner = found.get(key) ?? new Map<SidebarItemType, number>();
      inner.set(type, n);
      found.set(key, inner);
    };
    for (const type of types) {
      if (type === "conversation") {
        const per = new Map<string, number>();
        for (const row of this.all<{ id: string; kind: string; key: string }>("SELECT id, kind, COALESCE(project_id, '') AS key FROM agent_sessions")) {
          if (scan.listedSession(row)) per.set(row.key, (per.get(row.key) ?? 0) + 1);
        }
        for (const [key, n] of per) add(key, type, n);
      } else if (isMedia(type)) {
        for (const row of this.all<{ k: string; n: number }>(
          `SELECT pm.project_id AS k, COUNT(*) AS n FROM project_materials pm
           LEFT JOIN works w ON pm.kind = 'work' AND w.id = pm.target_id
           LEFT JOIN resources r ON pm.kind = 'resource' AND r.id = pm.target_id
           LEFT JOIN works rw ON rw.id = r.work_id
           WHERE (pm.kind = 'work' AND w.media_kind = ?) OR (pm.kind = 'resource' AND COALESCE(rw.media_kind, r.kind) = ?)
           GROUP BY pm.project_id`, type, type)) add(row.k, type, row.n);
        const recent = this.one<{ n: number }>(
          `SELECT COUNT(DISTINCT r.id) AS n FROM progress p JOIN resources r ON r.id = p.resource_id LEFT JOIN works w ON w.id = r.work_id
           WHERE p.context_id = '' AND COALESCE(w.media_kind, r.kind) = ?`, type);
        add("", type, recent?.n ?? 0);
      } else if (type === "note") {
        for (const row of this.all<{ k: string; n: number }>(
          `SELECT pm.project_id AS k, COUNT(*) AS n FROM project_materials pm JOIN content_objects o ON o.id = pm.target_id
           WHERE pm.kind = 'note' AND o.type = 'notes.document' AND o.deleted_at IS NULL GROUP BY pm.project_id`)) add(row.k, type, row.n);
        const loose = this.one<{ n: number }>(
          `SELECT COUNT(*) AS n FROM content_objects o WHERE o.type = 'notes.document' AND o.deleted_at IS NULL
             AND o.id NOT IN (SELECT target_id FROM project_materials WHERE kind = 'note')`);
        add("", type, loose?.n ?? 0);
      } else if (isObjectType(type)) {
        for (const row of this.all<{ k: string; n: number }>(`SELECT project_id AS k, COUNT(*) AS n FROM ${OBJECT_TABLE[type]} WHERE project_id IS NOT NULL GROUP BY project_id`)) add(row.k, type, row.n);
      }
    }
    return found;
  }

  // ----------------------------------------------------------------------------------------------------------------------- listing

  private item(place: Place, fields: Pick<SidebarItem, "key" | "type" | "title" | "open"> & Partial<SidebarItem>): SidebarItem {
    return { detail: null, updatedAt: null, running: false, materialId: null, contextId: place.id, contextName: place.name, ...fields };
  }

  /** The rows of one kind in one place, in the order they are listed, and how a row becomes an item (null: it is not offered, e.g. its file is gone). */
  private candidates(type: SidebarItemType, place: Place, scan: Scan): Candidates {
    const rows = (sql: string, params: unknown[] = []) => (offset: number, count: number) => this.all(`${sql} LIMIT ? OFFSET ?`, ...params, count, offset);
    if (type === "conversation") {
      const list = this.all<Row>(
        `SELECT s.id AS id, s.title AS title, s.kind AS kind, s.target_id AS targetId, s.updated_at AS updatedAt,
           (SELECT r.title FROM resources r WHERE r.id = s.target_id AND s.kind = 'resource') AS resourceTitle,
           (SELECT w.title FROM works w WHERE w.id = s.target_id AND s.kind = 'work') AS workTitle,
           (SELECT w.projection_json FROM works w WHERE w.id = s.target_id AND s.kind = 'work') AS workProjection
         FROM agent_sessions s WHERE ${place.id ? "s.project_id = ?" : "s.project_id IS NULL"} ORDER BY s.updated_at DESC, s.id`, ...(place.id ? [place.id] : []))
        .filter((row) => scan.listedSession({ id: String(row.id), kind: String(row.kind) }));
      return {
        fetch: (offset, count) => list.slice(offset, offset + count),
        map: (row) => {
          const id = String(row.id);
          const kind = String(row.kind);
          if (kind === "resource" && row.targetId && !scan.openable(String(row.targetId))) return null;
          const title = row.resourceTitle ? String(row.resourceTitle) : row.workTitle ? workTitle(row.workTitle, row.workProjection) : String(row.title);
          return this.item(place, { key: `conversation:${id}`, type, title, open: { kind: "conversation", id, general: kind === "shared" || kind === "project" }, updatedAt: String(row.updatedAt), running: scan.active().has(id) });
        },
      };
    }
    if (isMedia(type)) {
      if (!place.id) {
        return {
          fetch: rows(
            `SELECT r.id AS id, r.title AS title, r.ordinal_label AS ordinal, r.work_id AS workId, w.title AS wTitle, w.projection_json AS wProjection, MAX(p.last_interaction_at) AS at
             FROM progress p JOIN resources r ON r.id = p.resource_id LEFT JOIN works w ON w.id = r.work_id
             WHERE p.context_id = '' AND COALESCE(w.media_kind, r.kind) = ? GROUP BY r.id ORDER BY at DESC, r.id`, [type]),
          map: (row) => {
            const id = String(row.id);
            if (!scan.openable(id)) return null;
            const parent = row.workId && row.wTitle ? workTitle(row.wTitle, row.wProjection) : null;
            return this.item(place, { key: `resource:${id}`, type, title: String(row.title), detail: parent && parent !== row.title ? parent : null, open: { kind: "resource", id, workId: row.workId ? String(row.workId) : null, mediaKind: type }, updatedAt: String(row.at) });
          },
        };
      }
      return {
        fetch: rows(
          `SELECT pm.id AS materialId, pm.kind AS materialKind, pm.target_id AS targetId, pm.added_at AS addedAt,
             w.title AS wTitle, w.projection_json AS wProjection,
             r.title AS rTitle, r.work_id AS rWork, rw.title AS rwTitle, rw.projection_json AS rwProjection
           FROM project_materials pm
           LEFT JOIN works w ON pm.kind = 'work' AND w.id = pm.target_id
           LEFT JOIN resources r ON pm.kind = 'resource' AND r.id = pm.target_id
           LEFT JOIN works rw ON rw.id = r.work_id
           WHERE pm.project_id = ? AND ((pm.kind = 'work' AND w.media_kind = ?) OR (pm.kind = 'resource' AND COALESCE(rw.media_kind, r.kind) = ?))
           ORDER BY pm.added_at DESC, pm.id`, [place.id, type, type]),
        map: (row) => {
          const targetId = String(row.targetId);
          if (row.materialKind === "work") {
            return this.item(place, { key: `work:${targetId}`, type, title: workTitle(row.wTitle, row.wProjection), open: { kind: "work", id: targetId, mediaKind: type }, updatedAt: String(row.addedAt), materialId: String(row.materialId) });
          }
          if (!scan.openable(targetId)) return null;
          const parent = row.rWork && row.rwTitle ? workTitle(row.rwTitle, row.rwProjection) : null;
          return this.item(place, { key: `resource:${targetId}`, type, title: String(row.rTitle), detail: parent && parent !== row.rTitle ? parent : null, open: { kind: "resource", id: targetId, workId: row.rWork ? String(row.rWork) : null, mediaKind: type }, updatedAt: String(row.addedAt), materialId: String(row.materialId) });
        },
      };
    }
    if (type === "note") {
      const fetch = place.id
        ? rows(
          `SELECT o.id AS id, o.title AS title, o.updated_at AS updatedAt, pm.id AS materialId FROM project_materials pm JOIN content_objects o ON o.id = pm.target_id
           WHERE pm.project_id = ? AND pm.kind = 'note' AND o.type = 'notes.document' AND o.deleted_at IS NULL ORDER BY o.updated_at DESC, o.id`, [place.id])
        : rows(
          `SELECT o.id AS id, o.title AS title, o.updated_at AS updatedAt, NULL AS materialId FROM content_objects o
           WHERE o.type = 'notes.document' AND o.deleted_at IS NULL AND o.id NOT IN (SELECT target_id FROM project_materials WHERE kind = 'note') ORDER BY o.updated_at DESC, o.id`);
      return { fetch, map: (row) => this.item(place, { key: `note:${row.id}`, type, title: String(row.title), open: { kind: "note", id: String(row.id) }, updatedAt: String(row.updatedAt), materialId: row.materialId ? String(row.materialId) : null }) };
    }
    if (isObjectType(type)) {
      return {
        fetch: rows(`SELECT id, title, updated_at AS updatedAt FROM ${OBJECT_TABLE[type]} WHERE project_id = ? ORDER BY updated_at DESC, id`, [place.id ?? ""]),
        map: (row) => this.item(place, { key: `${type}:${row.id}`, type, title: String(row.title), open: { kind: type, id: String(row.id) }, updatedAt: String(row.updatedAt) }),
      };
    }
    return { fetch: () => [], map: () => null };
  }

  /** One page of a list: rows are taken in order, the ones that are not offered are passed over, and the answer says where the next page starts. */
  private page(candidates: Candidates, offset: number, limit: number): { items: SidebarItem[]; next: number | null } {
    const items: SidebarItem[] = [];
    const chunk = limit * 2 + 10;
    let consumed = offset;
    for (;;) {
      const rows = candidates.fetch(consumed, chunk);
      if (rows.length === 0) return { items, next: null };
      for (const row of rows) {
        if (items.length >= limit) return { items, next: consumed };
        consumed += 1;
        const made = candidates.map(row);
        if (made) items.push(made);
      }
      if (rows.length < chunk) return { items, next: null };
    }
  }

  private downloads(offset: number, limit: number): SidebarSection {
    const place: Place = { key: "", id: null, kind: "recent", name: null };
    const total = this.one<{ n: number }>("SELECT COUNT(*) AS n FROM acquisition_jobs WHERE state <> 'cancelled'")?.n ?? 0;
    const candidates: Candidates = {
      fetch: (at, count) => this.all(`SELECT id, name, source_ref AS sourceRef, state, updated_at AS updatedAt FROM acquisition_jobs WHERE state <> 'cancelled'
        ORDER BY (state IN (${FINISHED.map(() => "?").join(",")})) ASC, updated_at DESC, id LIMIT ? OFFSET ?`, ...FINISHED, count, at),
      map: (row) => ({
        key: `download:${row.id}`, type: "download", title: String(row.name || row.sourceRef || ""), detail: String(row.state), open: { kind: "download", id: String(row.id) },
        contextId: place.id, contextName: null, updatedAt: String(row.updatedAt), running: TRANSFERRING.has(String(row.state)), materialId: null,
      }),
    };
    const { items, next } = this.page(candidates, offset, limit);
    return { type: "download", total, items, loaded: true, nextCursor: next === null ? null : String(next) };
  }

  private offsetOf(cursor: string | undefined): number {
    return cursor && /^\d{1,7}$/.test(cursor) ? Number(cursor) : 0;
  }

  /** The sidebar of one view (`workspace.sidebar`). */
  sidebar(input: { view: RailView; perGroup: number; open?: ContextId[] }): SidebarView {
    const scan = new Scan(this.store);
    if (input.view === "downloads") return { view: input.view, groups: [], downloads: this.downloads(0, input.perGroup) };
    const own = itemTypeOfView(input.view);
    const types: readonly SidebarItemType[] = own ? [own] : SIDEBAR_ITEM_TYPES;
    const counts = this.counts(types, scan);
    const wanted = input.open ? new Set(input.open.map(contextKey)) : null;
    const groups: SidebarGroup[] = [];
    for (const place of this.places()) {
      const sections: SidebarSection[] = [];
      for (const type of types) {
        // The objects of a project belong to the project: "最近" has none.
        if (place.kind === "recent" && isObjectType(type)) continue;
        const total = counts.get(place.key)?.get(type) ?? 0;
        // The home lists the kinds a place has something of; a view of one kind lists the place even when it is empty, so it can say so.
        if (!own && total === 0) continue;
        const open = wanted === null || wanted.has(place.key);
        const { items, next } = open && total > 0 ? this.page(this.candidates(type, place, scan), 0, input.perGroup) : { items: [], next: null };
        sections.push({ type, total, items, loaded: open || total === 0, nextCursor: next === null ? null : String(next) });
      }
      if (place.kind === "recent" && sections.length === 0 && own) continue;
      groups.push({ contextId: place.id, kind: place.kind, name: place.name ?? RECENT_NAME, sections });
    }
    return { view: input.view, groups, downloads: null };
  }

  /** More of one list (`workspace.items`). A project that is gone answers with an empty list: what was asked for may have been deleted a moment ago. */
  items(input: { view: RailView; contextId: ContextId; type?: SidebarItemType; limit: number; cursor?: string }): { type: SidebarItemType | "download"; contextId: ContextId; total: number; items: SidebarItem[]; nextCursor: string | null } {
    const offset = this.offsetOf(input.cursor);
    if (input.view === "downloads") {
      const section = this.downloads(offset, input.limit);
      return { type: "download", contextId: null, total: section.total, items: section.items, nextCursor: section.nextCursor };
    }
    const type = itemTypeOfView(input.view) ?? input.type!;
    const place = this.place(input.contextId);
    if (!place || (place.kind === "recent" && isObjectType(type))) return { type, contextId: input.contextId, total: 0, items: [], nextCursor: null };
    const scan = new Scan(this.store);
    const total = this.counts([type], scan).get(place.key)?.get(type) ?? 0;
    if (total === 0) return { type, contextId: input.contextId, total, items: [], nextCursor: null };
    const { items, next } = this.page(this.candidates(type, place, scan), offset, input.limit);
    return { type, contextId: input.contextId, total, items, nextCursor: next === null ? null : String(next) };
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
        .map((row): FindItem => ({ key: `project:${row.id}`, type: "project", title: row.name, detail: null, open: { kind: "project", id: row.id }, ...named(row.id, row.name), updatedAt: row.updatedAt, running: false, materialId: null })));
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
        made.push({ key: `conversation:${row.id}`, type: "conversation", title: String(row.resourceTitle ?? row.title), detail: null, open: { kind: "conversation", id: String(row.id), general }, ...named(row.projectId ? String(row.projectId) : null, row.projectName ? String(row.projectName) : null), updatedAt: String(row.updatedAt), running: scan.active().has(String(row.id)), materialId: null });
      }
      push("conversation", made);
    }
    for (const type of MEDIA) {
      if (!wants(type)) continue;
      const works = this.all<Row>(
        `SELECT id, title, projection_json AS projection, created_at AS createdAt FROM works w
         WHERE media_kind = ? AND EXISTS (SELECT 1 FROM resources rr WHERE rr.work_id = w.id)
           AND (title LIKE ? ESCAPE '\\' OR author LIKE ? ESCAPE '\\' OR json_extract(projection_json, '$.title.value') LIKE ? ESCAPE '\\' OR json_extract(projection_json, '$.titleOriginal.value') LIKE ? ESCAPE '\\')
         ORDER BY COALESCE(last_opened_at, '') DESC, created_at DESC, id LIMIT ?`, type, like, like, like, like, limit);
      const items: FindItem[] = works.map((row) => ({ key: `work:${row.id}`, type, title: workTitle(row.title, row.projection), detail: null, open: { kind: "work", id: String(row.id), mediaKind: type }, contextName: null, updatedAt: String(row.createdAt), running: false, materialId: null }));
      if (items.length < limit) {
        const resources = this.all<Row>(
          `SELECT r.id AS id, r.title AS title, r.work_id AS workId, r.created_at AS createdAt, w.title AS wTitle, w.projection_json AS wProjection
           FROM resources r LEFT JOIN works w ON w.id = r.work_id
           WHERE COALESCE(w.media_kind, r.kind) = ? AND r.title LIKE ? ESCAPE '\\' ORDER BY r.created_at DESC, r.id LIMIT ?`, type, like, (limit - items.length) * 3 + 6);
        for (const row of resources) {
          if (items.length >= limit) break;
          if (!scan.openable(String(row.id))) continue;
          const parent = row.workId && row.wTitle ? workTitle(row.wTitle, row.wProjection) : null;
          items.push({ key: `resource:${row.id}`, type, title: String(row.title), detail: parent && parent !== row.title ? parent : null, open: { kind: "resource", id: String(row.id), workId: row.workId ? String(row.workId) : null, mediaKind: type }, contextName: null, updatedAt: String(row.createdAt), running: false, materialId: null });
        }
      }
      push(type, items);
    }
    if (wants("note")) {
      push("note", this.all<Row>("SELECT id, title, updated_at AS updatedAt FROM content_objects WHERE type = 'notes.document' AND deleted_at IS NULL AND title LIKE ? ESCAPE '\\' ORDER BY updated_at DESC, id LIMIT ?", like, limit)
        .map((row): FindItem => ({ key: `note:${row.id}`, type: "note", title: String(row.title), detail: null, open: { kind: "note", id: String(row.id) }, contextName: null, updatedAt: String(row.updatedAt), running: false, materialId: null })));
    }
    for (const type of OBJECT_KINDS) {
      if (!wants(type)) continue;
      push(type, this.all<Row>(`SELECT o.id AS id, o.title AS title, o.updated_at AS updatedAt, o.project_id AS projectId, p.name AS projectName FROM ${OBJECT_TABLE[type]} o JOIN projects p ON p.id = o.project_id
        WHERE o.title LIKE ? ESCAPE '\\' ORDER BY o.updated_at DESC, o.id LIMIT ?`, like, limit)
        .map((row): FindItem => ({ key: `${type}:${row.id}`, type, title: String(row.title), detail: null, open: { kind: type, id: String(row.id) }, ...named(String(row.projectId), String(row.projectName)), updatedAt: String(row.updatedAt), running: false, materialId: null })));
    }
    return { groups };
  }
}
