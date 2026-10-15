import { MangaError, type CommandEnvelope } from "@manga/contracts";
import type { DrizzleStore, Mutation } from "@manga/storage-drizzle";
import { displayTitle } from "./works-service.ts";
import { groupKeySql, outsideSql } from "./works-versions.ts";

/**
 * Deleting an entry (LIB-02, A-87). An entry on the shelf is a work, or the works that are versions of one title (A-68). Deleting it removes the
 * work record and what came from the online entry; the files stay in their library paths and everything the person made stays, now with no
 * work: the resources are listed as not yet in a work, and what was made only for the work keeps the title it had.
 */

export type DeleteEntryPreview = {
  workId: string;
  /** The works the deletion covers: all versions of the entry. */
  workIds: string[];
  title: string;
  mediaKind: string;
  /** What is removed. */
  removes: { works: number; onlineLinks: number; snapshots: number; candidates: number; overrides: number; covers: number; characters: number; persons: number; derivedDanmaku: number };
  /** What stays, as numbers a person can check. */
  keeps: { resources: number; progress: number; bookmarks: number; notes: number; recordings: number; screenshots: number; conversations: number; confirmedDanmaku: number; terms: number; files: number };
};

type WorkRow = { id: string; title: string; media_kind: string; projection_json: string };

/** The works that share the entry of `workId`: its versions, itself among them. */
export function entryGroup(store: DrizzleStore, workId: string): WorkRow[] {
  const own = store.sqlite.prepare(`SELECT w.id AS id, ${groupKeySql("w")} AS key FROM works w WHERE w.id = ?`).get(workId) as { id: string; key: string } | undefined;
  if (!own) throw new MangaError("NOT_FOUND", "work missing");
  return store.sqlite.prepare(`SELECT w.id AS id, w.title AS title, w.media_kind AS media_kind, w.projection_json AS projection_json FROM works w
    WHERE ${groupKeySql("w")} = ? ORDER BY w.created_at, w.id`).all(own.key) as WorkRow[];
}

const marks = (count: number) => Array.from({ length: count }, () => "?").join(",");
const count = (store: DrizzleStore, sql: string, params: unknown[]): number => (store.sqlite.prepare(sql).get(...params) as { n: number }).n;

export function previewDeleteEntry(store: DrizzleStore, workId: string): DeleteEntryPreview {
  const group = entryGroup(store, workId);
  const ids = group.map((row) => row.id);
  const inWorks = marks(ids.length);
  const resourceIds = (store.sqlite.prepare(`SELECT id FROM resources WHERE work_id IN (${inWorks})`).all(...ids) as Array<{ id: string }>).map((row) => row.id);
  const inResources = marks(resourceIds.length || 1);
  const resourceParams = resourceIds.length ? resourceIds : [""];
  const head = group.find((row) => row.id === workId) ?? group[0]!;
  return {
    workId,
    workIds: ids,
    title: displayTitle(head),
    mediaKind: head.media_kind,
    removes: {
      works: ids.length,
      onlineLinks: count(store, `SELECT COUNT(*) AS n FROM work_links WHERE work_id IN (${inWorks})`, ids),
      snapshots: count(store, `SELECT COUNT(*) AS n FROM metadata_snapshots WHERE work_id IN (${inWorks})`, ids),
      candidates: count(store, `SELECT COUNT(*) AS n FROM metadata_candidates WHERE work_id IN (${inWorks})`, ids),
      overrides: count(store, `SELECT COUNT(*) AS n FROM metadata_overrides WHERE work_id IN (${inWorks}) AND (fields_json <> '{}' OR locked_json <> '[]' OR cleared_json <> '[]')`, ids),
      covers: count(store, `SELECT COUNT(*) AS n FROM covers WHERE work_id IN (${inWorks})`, ids),
      characters: count(store, `SELECT COUNT(*) AS n FROM subject_characters WHERE work_id IN (${inWorks})`, ids),
      persons: count(store, `SELECT COUNT(*) AS n FROM subject_persons WHERE work_id IN (${inWorks})`, ids),
      derivedDanmaku: count(store, `SELECT COUNT(*) AS n FROM danmaku_matches WHERE confirmed = 0 AND method = 'bangumi' AND resource_revision_id IN (SELECT v.id FROM resource_revisions v WHERE v.resource_id IN (${inResources}))`, resourceParams),
    },
    keeps: {
      resources: resourceIds.length,
      progress: count(store, `SELECT COUNT(*) AS n FROM progress WHERE resource_id IN (${inResources})`, resourceParams),
      bookmarks: count(store, `SELECT COUNT(*) AS n FROM bookmarks WHERE resource_id IN (${inResources})`, resourceParams),
      notes: count(store, `SELECT COUNT(*) AS n FROM content_objects WHERE type = 'notes.document' AND deleted_at IS NULL AND (work_id IN (${inWorks}) OR json_extract(scope_json, '$.resourceId') IN (${inResources}))`, [...ids, ...resourceParams]),
      recordings: count(store, `SELECT COUNT(*) AS n FROM capture_sessions c WHERE c.work_id IN (${inWorks}) OR EXISTS (SELECT 1 FROM capture_events e WHERE e.session_id = c.id AND e.resource_id IN (${inResources}))`, [...ids, ...resourceParams]),
      screenshots: count(store, `SELECT COUNT(*) AS n FROM screenshots WHERE work_id IN (${inWorks}) OR resource_id IN (${inResources})`, [...ids, ...resourceParams]),
      conversations: count(store, `SELECT COUNT(*) AS n FROM agent_sessions WHERE (kind = 'work' AND target_id IN (${inWorks})) OR (kind = 'resource' AND target_id IN (${inResources}))`, [...ids, ...resourceParams]),
      confirmedDanmaku: count(store, `SELECT COUNT(*) AS n FROM danmaku_matches WHERE NOT (confirmed = 0 AND method = 'bangumi') AND resource_revision_id IN (SELECT v.id FROM resource_revisions v WHERE v.resource_id IN (${inResources}))`, resourceParams),
      terms: count(store, `SELECT (SELECT COUNT(*) FROM dictionary_terms WHERE scope = 'work' AND work_id IN (${inWorks})) + (SELECT COUNT(*) FROM work_terms WHERE work_id IN (${inWorks})) AS n`, [...ids, ...ids]),
      files: count(store, `SELECT COUNT(*) AS n FROM work_files WHERE work_id IN (${inWorks}) OR resource_id IN (${inResources})`, [...ids, ...resourceParams]),
    },
  };
}

/**
 * Delete the entry of `workId` with all its versions. Everything is one commit: either the entry is gone and its resources are loose, or nothing
 * changed. Returns the resources that are loose now, so the caller can move their files and notes to where the rule puts them.
 */
export function deleteEntry(store: DrizzleStore, envelope: CommandEnvelope, input: { workId: string }): { workIds: string[]; resourceIds: string[]; title: string } {
  const group = entryGroup(store, input.workId);
  const ids = group.map((row) => row.id);
  const inWorks = marks(ids.length);
  const resourceIds = (store.sqlite.prepare(`SELECT id FROM resources WHERE work_id IN (${inWorks})`).all(...ids) as Array<{ id: string }>).map((row) => row.id);
  const inResources = marks(resourceIds.length || 1);
  const resourceParams = resourceIds.length ? resourceIds : [""];
  const now = new Date().toISOString();
  const imageHashes = (store.sqlite.prepare(`SELECT image_hash AS hash FROM covers WHERE work_id IN (${inWorks}) AND image_hash IS NOT NULL
    UNION SELECT image_hash FROM subject_characters WHERE work_id IN (${inWorks}) AND image_hash IS NOT NULL
    UNION SELECT image_hash FROM subject_persons WHERE work_id IN (${inWorks}) AND image_hash IS NOT NULL`).all(...ids, ...ids, ...ids) as Array<{ hash: string }>).map((row) => row.hash);
  const mutations: Mutation[] = [];
  for (const row of group) mutations.push({ sql: "INSERT OR REPLACE INTO removed_works(id, title, media_kind, removed_at) VALUES (?,?,?,?)", params: [row.id, displayTitle(row), row.media_kind, now] });
  // Matches that only the online entry produced go; the ones the person chose or confirmed stay with their files.
  mutations.push({ sql: `DELETE FROM danmaku_matches WHERE confirmed = 0 AND method = 'bangumi' AND resource_revision_id IN (SELECT v.id FROM resource_revisions v WHERE v.resource_id IN (${inResources}))`, params: resourceParams });
  for (const table of ["danmaku_consent", "metadata_overrides", "metadata_snapshots", "metadata_candidates", "work_links", "covers", "subject_characters", "subject_persons"]) {
    mutations.push({ sql: `DELETE FROM ${table} WHERE work_id IN (${inWorks})`, params: ids });
  }
  // The resources, their files and everything made from them stay and leave the work; what is only the work's keeps the work's id and title.
  mutations.push({ sql: `UPDATE resources SET work_id = NULL, left_work_at = ? WHERE work_id IN (${inWorks})`, params: [now, ...ids] });
  mutations.push({ sql: `UPDATE work_files SET work_id = NULL WHERE resource_id IS NOT NULL AND work_id IN (${inWorks})`, params: ids });
  mutations.push({ sql: `UPDATE screenshots SET work_id = NULL WHERE work_id IN (${inWorks})`, params: ids });
  mutations.push({ sql: `UPDATE content_objects SET work_id = NULL WHERE work_id IN (${inWorks}) AND json_extract(scope_json, '$.resourceId') IN (SELECT id FROM resources)`, params: ids });
  mutations.push({ sql: `UPDATE capture_sessions SET work_id = NULL WHERE work_id IN (${inWorks}) AND EXISTS (SELECT 1 FROM capture_events e WHERE e.session_id = capture_sessions.id AND e.resource_id IS NOT NULL)`, params: ids });
  mutations.push({ sql: `DELETE FROM works WHERE id IN (${inWorks})`, params: ids });
  for (const hash of imageHashes) {
    mutations.push({ sql: `DELETE FROM images WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM covers WHERE image_hash = images.hash)
      AND NOT EXISTS (SELECT 1 FROM subject_characters WHERE image_hash = images.hash) AND NOT EXISTS (SELECT 1 FROM subject_persons WHERE image_hash = images.hash)`, params: [hash] });
  }
  store.commit({
    mutations,
    events: [{ type: "work.deleted", payload: { workIds: ids, resourceIds } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: { workIds: ids, resourceIds },
  });
  return { workIds: ids, resourceIds, title: displayTitle(group.find((row) => row.id === input.workId) ?? group[0]!) };
}

export type UnassignedItem = {
  resourceId: string;
  kind: string;
  title: string;
  ordinalLabel: string | null;
  /** When it left its work; null for a resource that never had one. */
  leftWorkAt: string | null;
  lastOpenedAt: string | null;
  /** Whether its file is under no library path any more. */
  outside: boolean;
};

/** The resources that are in no work, newest first: the ones whose entry was deleted, and the ones that were taken out of a work. */
export function listUnassigned(store: DrizzleStore, input: { kind?: string; limit?: number; query?: string } = {}): { items: UnassignedItem[]; total: number } {
  const where = ["r.work_id IS NULL"];
  const params: unknown[] = [];
  if (input.kind) { where.push("r.kind = ?"); params.push(input.kind); }
  if (input.query) { where.push("r.title LIKE ? ESCAPE '\\'"); params.push(`%${input.query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`); }
  const clause = where.join(" AND ");
  const total = count(store, `SELECT COUNT(*) AS n FROM resources r WHERE ${clause}`, params);
  const rows = store.sqlite.prepare(`SELECT r.id AS resourceId, r.kind AS kind, r.title AS title, r.ordinal_label AS ordinalLabel, r.left_work_at AS leftWorkAt,
      (SELECT MAX(p.last_interaction_at) FROM progress p WHERE p.resource_id = r.id) AS lastOpenedAt,
      ${outsideSql("r")} AS outside
    FROM resources r WHERE ${clause} ORDER BY COALESCE(r.left_work_at, r.created_at) DESC, r.id LIMIT ?`).all(...params, Math.min(input.limit ?? 200, 500)) as Array<Omit<UnassignedItem, "outside"> & { outside: number }>;
  return { items: rows.map((row) => ({ ...row, outside: row.outside === 1 })), total };
}
