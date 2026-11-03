import path from "node:path";
import { createId, MangaError, type CommandEnvelope } from "@manga/contracts";
import type { DrizzleStore, Mutation } from "@manga/storage-drizzle";
import { inLibrarySql, outsideSql } from "./library-locations.ts";
import { workKindMutation } from "./reading-service.ts";

/** A resource whose file is under no library path, for the section of "设置 › 资源库" that lists them (A-113). */
export type OutsideItem = { resourceId: string; title: string; kind: string; workTitle: string | null };
export type OutsideGroup = { folder: string | null; items: OutsideItem[] };

const ids = (store: DrizzleStore): string[] =>
  (store.sqlite.prepare(`SELECT r.id AS id FROM resources r WHERE ${outsideSql("r")}`).all() as Array<{ id: string }>).map((row) => row.id);

/** The folder a resource's file was in when it left every library path: what "加为资源库位置" would add. */
function folderOf(store: DrizzleStore, resourceId: string): string | null {
  const row = store.sqlite.prepare(`SELECT fl.legacy_path AS legacy FROM file_locations fl JOIN resource_revisions v ON v.id = fl.resource_revision_id
    WHERE v.resource_id = ? ORDER BY v.created_at DESC, v.rowid DESC, fl.rowid DESC LIMIT 1`).get(resourceId) as { legacy: string | null } | undefined;
  return row?.legacy ? path.dirname(row.legacy) : null;
}

/** The resources outside every library path, by the folder they were in (the ones whose folder is not known last). */
export function listOutside(store: DrizzleStore): { total: number; groups: OutsideGroup[] } {
  const rows = store.sqlite.prepare(`SELECT r.id AS resourceId, r.title AS title, r.kind AS kind, w.title AS workTitle FROM resources r LEFT JOIN works w ON w.id = r.work_id
    WHERE ${outsideSql("r")} ORDER BY r.title, r.id`).all() as OutsideItem[];
  const byFolder = new Map<string | null, OutsideItem[]>();
  for (const row of rows) {
    const folder = folderOf(store, row.resourceId);
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), row]);
  }
  const groups = [...byFolder].map(([folder, items]) => ({ folder, items }))
    .sort((a, b) => (a.folder === null ? 1 : b.folder === null ? -1 : a.folder.localeCompare(b.folder)));
  return { total: rows.length, groups };
}

const count = (store: DrizzleStore, sql: string, list: readonly string[]): number => {
  if (!list.length) return 0;
  return (store.sqlite.prepare(sql.replace("(?)", `(${list.map(() => "?").join(",")})`)).get(...list) as { n: number }).n;
};

/** What removing the records of the outside resources deletes and what it keeps, counted (Q-35 13). */
export function previewRemoveOutside(store: DrizzleStore): { resources: number; remove: Record<string, number>; keep: Record<string, number> } {
  const list = ids(store);
  const revisions = `SELECT id FROM resource_revisions WHERE resource_id IN (?)`;
  return {
    resources: list.length,
    remove: {
      files: count(store, "SELECT COUNT(*) AS n FROM library_files WHERE resource_id IN (?)", list),
      assets: count(store, "SELECT COUNT(*) AS n FROM resource_assets WHERE resource_id IN (?)", list),
      playCopies: count(store, `SELECT COUNT(*) AS n FROM play_copies WHERE resource_revision_id IN (${revisions})`, list),
      danmakuMatches: count(store, `SELECT COUNT(*) AS n FROM danmaku_matches WHERE resource_revision_id IN (${revisions})`, list),
    },
    keep: {
      notes: count(store, "SELECT COUNT(DISTINCT r.from_object_id) AS n FROM refs r JOIN anchors a ON a.id = r.to_id WHERE r.to_kind = 'anchor' AND a.resource_id IN (?)", list),
      bookmarks: count(store, "SELECT COUNT(*) AS n FROM bookmarks WHERE resource_id IN (?)", list),
      recordings: count(store, "SELECT COUNT(DISTINCT session_id) AS n FROM capture_events WHERE resource_id IN (?)", list),
      screenshots: count(store, "SELECT COUNT(*) AS n FROM screenshots WHERE resource_id IN (?)", list),
      conversations: count(store, "SELECT COUNT(*) AS n FROM agent_sessions WHERE kind = 'resource' AND target_id IN (?)", list),
      progress: count(store, "SELECT COUNT(DISTINCT resource_id) AS n FROM progress WHERE resource_id IN (?)", list),
    },
  };
}

/**
 * Removes the records of every resource outside the library paths (Q-35 13): the resource, its revisions and file register, the pictures and text
 * kept for it, and what was made only to play it. What the person made (notes, bookmarks, recordings, screenshots, conversations, progress) stays,
 * with its own title. The files are not touched. `expected` is the number the person saw in the confirmation: a list that changed since is refused.
 * `forget` is given each revision first, so what the video service keeps on disk for it (play copies, frame tables, subtitles) goes too.
 */
export function removeOutside(store: DrizzleStore, envelope: CommandEnvelope, expected: number, forget: (revisionId: string) => void): { removed: number } {
  const list = ids(store);
  if (list.length !== expected) throw new MangaError("REVISION_CONFLICT", "the resources outside the library changed; look at the list again", { details: { expected, actual: list.length } });
  if (!list.length) return { removed: 0 };
  const marks = list.map(() => "?").join(",");
  const revisionIds = (store.sqlite.prepare(`SELECT id FROM resource_revisions WHERE resource_id IN (${marks})`).all(...list) as Array<{ id: string }>).map((row) => row.id);
  for (const revisionId of revisionIds) forget(revisionId);
  const works = (store.sqlite.prepare(`SELECT DISTINCT work_id AS id FROM resources WHERE id IN (${marks}) AND work_id IS NOT NULL`).all(...list) as Array<{ id: string }>).map((row) => row.id);
  const byRevision = `IN (SELECT id FROM resource_revisions WHERE resource_id IN (${marks}))`;
  const now = new Date().toISOString();
  const mutations: Mutation[] = [
    { sql: `DELETE FROM file_locations WHERE resource_revision_id ${byRevision}`, params: list },
    { sql: `DELETE FROM media_probes WHERE resource_revision_id ${byRevision}`, params: list },
    { sql: `DELETE FROM play_copies WHERE resource_revision_id ${byRevision}`, params: list },
    { sql: `DELETE FROM danmaku_matches WHERE resource_revision_id ${byRevision}`, params: list },
    { sql: `DELETE FROM library_files WHERE resource_id IN (${marks})`, params: list },
    { sql: `DELETE FROM resource_assets WHERE resource_id IN (${marks})`, params: list },
    { sql: `DELETE FROM text_fragments WHERE resource_id IN (${marks})`, params: list },
    { sql: `DELETE FROM search_idx WHERE resource_id IN (${marks})`, params: list },
    { sql: `DELETE FROM import_receipts WHERE resource_id IN (${marks})`, params: list },
    { sql: `DELETE FROM resource_revisions WHERE resource_id IN (${marks})`, params: list },
    { sql: `DELETE FROM resources WHERE id IN (${marks})`, params: list },
    // What the person made from these resources stays with its own title but leaves their works, as deleting an entry does (works-delete.ts): it is
    // listed under "未分类", and a work left with nothing of its own is not listed again for it.
    { sql: `UPDATE work_files SET work_id = NULL WHERE resource_id IN (${marks})`, params: list },
    { sql: `UPDATE screenshots SET work_id = NULL WHERE resource_id IN (${marks})`, params: list },
    { sql: `UPDATE content_objects SET work_id = NULL WHERE type = 'notes.document' AND json_extract(scope_json, '$.resourceId') IN (${marks})`, params: list },
    { sql: `UPDATE capture_sessions SET work_id = NULL WHERE EXISTS (SELECT 1 FROM capture_events e WHERE e.session_id = capture_sessions.id AND e.resource_id IN (${marks}))`, params: list },
    // A work keeps its place for what is left in it; its card shows the next resource.
    ...works.flatMap((workId) => [
      { sql: "UPDATE works SET last_resource_id = NULL, updated_at = ? WHERE id = ? AND last_resource_id NOT IN (SELECT id FROM resources)", params: [now, workId] },
      workKindMutation(workId, now),
    ]),
  ];
  store.commit({
    mutations,
    events: [{ type: "library.outsideRemoved", payload: { count: list.length } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: { removed: list.length },
  });
  return { removed: list.length };
}

/** Where a resource's newest file is in its library path: the path and the place below it. */
function placeOf(store: DrizzleStore, resourceId: string): { pathId: string; rel: string; root: string } | null {
  return (store.sqlite.prepare(`SELECT fl.library_path_id AS pathId, fl.relative_path AS rel, lp.path AS root FROM file_locations fl
      JOIN resource_revisions v ON v.id = fl.resource_revision_id JOIN library_paths lp ON lp.id = fl.library_path_id
    WHERE v.resource_id = ? ORDER BY v.created_at DESC, v.rowid DESC, fl.rowid DESC LIMIT 1`).get(resourceId) as { pathId: string; rel: string; root: string } | undefined) ?? null;
}

const likeEscape = (text: string) => text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

/**
 * "重新识别作品" (A-113): the loose resources go where a scan would put them (`library-scan/plan.ts`): the first folder below the library path is the
 * work, and a file directly in the path is a work of its own. A folder that still has a work gets them; otherwise one work is made for the folder,
 * and the resources of one call that share a folder share it. A resource in a work, or outside the library, is refused.
 */
export function reidentifyResources(store: DrizzleStore, envelope: CommandEnvelope, resourceIds: readonly string[]): { results: Array<{ resourceId: string; workId: string; created: boolean }> } {
  const now = new Date().toISOString();
  const mutations: Mutation[] = [];
  const made = new Map<string, string>();
  const results: Array<{ resourceId: string; workId: string; created: boolean }> = [];
  const touched = new Set<string>();
  for (const resourceId of [...new Set(resourceIds)]) {
    const row = store.sqlite.prepare(`SELECT r.kind AS kind, r.title AS title, r.work_id AS workId, ${inLibrarySql("r")} AS inside FROM resources r WHERE r.id = ?`).get(resourceId) as { kind: string; title: string; workId: string | null; inside: number } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "resource missing");
    if (row.workId) throw new MangaError("VALIDATION_ERROR", "the resource is in a work already");
    const place = row.inside ? placeOf(store, resourceId) : null;
    if (!place) throw new MangaError("VALIDATION_ERROR", "the resource is not in a library path; add its folder first");
    const nested = place.rel.includes("/");
    const key = nested ? place.rel.split("/")[0]! : place.rel;
    // An image folder directly in the path is a work of its own named after the folder; a file there is named without its extension.
    const title = nested ? key : row.kind === "comic" && !path.extname(key) ? key : key.replace(/\.[^./]+$/, "") || row.title;
    const groupKey = `${place.pathId}\u0000${key}`;
    let workId = made.get(groupKey);
    let created = false;
    if (!workId) {
      const existing = store.sqlite.prepare(`SELECT r.work_id AS workId, COUNT(*) AS n FROM file_locations fl JOIN resource_revisions v ON v.id = fl.resource_revision_id JOIN resources r ON r.id = v.resource_id
          JOIN works w ON w.id = r.work_id
        WHERE fl.library_path_id = ? AND (fl.relative_path = ? OR fl.relative_path LIKE ? ESCAPE '\\') AND w.media_kind = ?
        GROUP BY r.work_id ORDER BY n DESC LIMIT 1`).get(place.pathId, key, `${likeEscape(key)}/%`, row.kind) as { workId: string } | undefined;
      if (existing) workId = existing.workId;
      else {
        workId = createId("work");
        created = true;
        mutations.push({ sql: "INSERT INTO works(id,title,created_at,media_kind,updated_at) VALUES (?,?,?,?,?)", params: [workId, title === "." ? path.basename(place.root) : title, now, row.kind, now] });
      }
      made.set(groupKey, workId);
    }
    mutations.push({ sql: "UPDATE resources SET work_id = ?, left_work_at = NULL WHERE id = ?", params: [workId, resourceId] });
    mutations.push({ sql: "UPDATE work_files SET work_id = ? WHERE resource_id = ?", params: [workId, resourceId] });
    mutations.push({ sql: "UPDATE screenshots SET work_id = ? WHERE resource_id = ?", params: [workId, resourceId] });
    mutations.push({ sql: "UPDATE content_objects SET work_id = ? WHERE type = 'notes.document' AND json_extract(scope_json, '$.resourceId') = ?", params: [workId, resourceId] });
    touched.add(workId);
    results.push({ resourceId, workId, created });
  }
  for (const workId of touched) mutations.push(workKindMutation(workId, now));
  store.commit({
    mutations,
    events: results.map((item) => ({ type: "resource.moved", payload: { resourceId: item.resourceId, from: null, to: item.workId } })),
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: { results },
  });
  return { results };
}
