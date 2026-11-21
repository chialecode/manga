import { MangaError } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { readLayout } from "./domain/revision-layout.ts";
import { outsideSql } from "./library-locations.ts";

/**
 * Versions of one title and the facts a work holds that its files do not (A-67, A-68, A-69). Everything here is derived from rows that
 * already exist, so nothing is migrated and nothing is merged: a version is a work, and taking the Bangumi link away separates it again.
 */

/** The Bangumi entry a work is linked to, newest confirmation first; null when it has none. */
export const bangumiEntrySql = (alias: string) => `(SELECT gl.external_id FROM work_links gl WHERE gl.work_id = ${alias}.id AND gl.provider_id = 'bangumi' AND gl.link_state = 'linked' ORDER BY gl.confirmed_at DESC, gl.rowid DESC LIMIT 1)`;

/**
 * The group a work is listed in: works of one medium linked to one Bangumi entry share a group, and every other work is its own.
 * A work with no resource never joins a group; it has nothing to show as a version.
 */
export const groupKeySql = (alias: string) => `(CASE WHEN EXISTS (SELECT 1 FROM resources gr WHERE gr.work_id = ${alias}.id)
  THEN COALESCE(${alias}.media_kind || ':bgm:' || ${bangumiEntrySql(alias)}, ${alias}.id) ELSE ${alias}.id END)`;

export type WorkVersion = {
  workId: string;
  /** What tells the versions apart: the name the files were found under (folder, release group, format). */
  label: string;
  resourceCount: number;
  lastOpenedAt: string | null;
  current: boolean;
};

/** The versions of a work's title, the work itself among them. A work with no link, or no resource, is the only one of its kind. */
export function versionsOf(store: DrizzleStore, workId: string): WorkVersion[] {
  const self = store.sqlite.prepare(`SELECT w.id AS id, w.title AS title, w.media_kind AS kind, w.last_opened_at AS lastOpenedAt,
      (SELECT COUNT(*) FROM resources r WHERE r.work_id = w.id) AS n, ${bangumiEntrySql("w")} AS entry FROM works w WHERE w.id = ?`).get(workId) as
    { id: string; title: string; kind: string; lastOpenedAt: string | null; n: number; entry: string | null } | undefined;
  if (!self) return [];
  const alone: WorkVersion[] = [{ workId: self.id, label: self.title, resourceCount: self.n, lastOpenedAt: self.lastOpenedAt, current: true }];
  if (!self.entry || self.n === 0) return alone;
  const rows = store.sqlite.prepare(`SELECT w.id AS id, w.title AS title, w.last_opened_at AS lastOpenedAt, (SELECT COUNT(*) FROM resources r WHERE r.work_id = w.id) AS n
    FROM work_links l JOIN works w ON w.id = l.work_id
    WHERE l.provider_id = 'bangumi' AND l.link_state = 'linked' AND l.external_id = ? AND w.media_kind = ?
      AND l.rowid = (SELECT gl.rowid FROM work_links gl WHERE gl.work_id = w.id AND gl.provider_id = 'bangumi' AND gl.link_state = 'linked' ORDER BY gl.confirmed_at DESC, gl.rowid DESC LIMIT 1)
      AND EXISTS (SELECT 1 FROM resources r2 WHERE r2.work_id = w.id)
    ORDER BY COALESCE(w.last_opened_at, '') DESC, w.created_at, w.id`).all(self.entry, self.kind) as Array<{ id: string; title: string; lastOpenedAt: string | null; n: number }>;
  return rows.length ? rows.map((row) => ({ workId: row.id, label: row.title, resourceCount: row.n, lastOpenedAt: row.lastOpenedAt, current: row.id === workId })) : alone;
}

/** How many versions each work's title has (1 when it stands alone), computed in a single batched pass. */
export function versionCounts(store: DrizzleStore, workIds: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  if (!workIds.length) return counts;
  const marks = workIds.map(() => "?").join(",");
  const entries = store.sqlite.prepare(`SELECT w.id AS id, w.media_kind AS kind, ${bangumiEntrySql("w")} AS entry,
      EXISTS (SELECT 1 FROM resources r WHERE r.work_id = w.id) AS has
    FROM works w WHERE w.id IN (${marks})`).all(...workIds) as Array<{ id: string; kind: string; entry: string | null; has: number }>;
  const keys = new Map<string, { kind: string; entry: string }>();
  const workKey = new Map<string, string>();
  for (const row of entries) {
    if (!row.entry || !row.has) { counts.set(row.id, 1); continue; }
    const k = `${row.kind}:${row.entry}`;
    workKey.set(row.id, k);
    if (!keys.has(k)) keys.set(k, { kind: row.kind, entry: row.entry });
  }
  if (!keys.size) return counts;
  const entryIds = [...new Set([...keys.values()].map((item) => item.entry))];
  const entryMarks = entryIds.map(() => "?").join(",");
  const grouped = store.sqlite.prepare(`SELECT w.media_kind AS kind, l.external_id AS entry, COUNT(*) AS n
    FROM work_links l JOIN works w ON w.id = l.work_id
    WHERE l.provider_id = 'bangumi' AND l.link_state = 'linked' AND l.external_id IN (${entryMarks})
      AND l.rowid = (SELECT gl.rowid FROM work_links gl WHERE gl.work_id = w.id AND gl.provider_id = 'bangumi' AND gl.link_state = 'linked' ORDER BY gl.confirmed_at DESC, gl.rowid DESC LIMIT 1)
      AND EXISTS (SELECT 1 FROM resources r2 WHERE r2.work_id = w.id)
    GROUP BY w.media_kind, l.external_id`).all(...entryIds) as Array<{ kind: string; entry: string; n: number }>;
  const totals = new Map(grouped.map((row) => [`${row.kind}:${row.entry}`, row.n]));
  for (const [id, k] of workKey) counts.set(id, totals.get(k) || 1);
  return counts;
}

/**
 * Whether a resource still has an available file in a library path, or has no file location at all (hosted/pasted content).
 * Resources whose library-path files are all marked `available = 0` do not match.
 */
export const availableResourceSql = (alias: string) => `(NOT EXISTS (
  SELECT 1 FROM resource_revisions arv JOIN file_locations arl ON arl.resource_revision_id = arv.id
  WHERE arv.resource_id = ${alias}.id AND arl.library_path_id IS NOT NULL
) OR EXISTS (
  SELECT 1 FROM resource_revisions arv2 JOIN file_locations arl2 ON arl2.resource_revision_id = arv2.id
  WHERE arv2.resource_id = ${alias}.id AND arl2.library_path_id IS NOT NULL AND arl2.available = 1
))`;

/**
 * Whether anything the user wrote belongs to the work itself: terms and dictionary entries, edited or locked fields, a note or a recording
 * kept on the work, a conversation that has begun. Such a work is kept when its last resource leaves; one that holds only what the files and
 * the online entry said is not, because nothing is lost by dropping it and it could be fetched again.
 */
export const userContentSql = (alias: string, leaving = "NULL") => `(EXISTS (SELECT 1 FROM dictionary_terms uw WHERE uw.scope = 'work' AND uw.work_id = ${alias}.id)
  OR EXISTS (SELECT 1 FROM work_terms ut WHERE ut.work_id = ${alias}.id)
  OR EXISTS (SELECT 1 FROM metadata_overrides uo WHERE uo.work_id = ${alias}.id AND (uo.fields_json <> '{}' OR uo.locked_json <> '[]' OR uo.cleared_json <> '[]'))
  OR EXISTS (SELECT 1 FROM content_objects un WHERE un.work_id = ${alias}.id AND un.deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM capture_sessions uc WHERE uc.work_id = ${alias}.id)
  OR EXISTS (SELECT 1 FROM work_files uf WHERE uf.work_id = ${alias}.id AND (uf.resource_id IS NULL OR uf.resource_id IS NOT ${leaving}))
  OR EXISTS (SELECT 1 FROM agent_sessions us WHERE us.kind = 'work' AND us.target_id = ${alias}.id AND EXISTS (SELECT 1 FROM agent_runs ur WHERE ur.session_id = us.id))
  OR ${alias}.cover_state IN ('user', 'locked')
  OR EXISTS (SELECT 1 FROM covers ucv WHERE ucv.work_id = ${alias}.id AND ucv.source = 'user')
  OR EXISTS (SELECT 1 FROM project_materials upm WHERE upm.kind = 'work' AND upm.target_id = ${alias}.id))`;

export function workHoldsUserContent(store: DrizzleStore, workId: string, leavingResourceId?: string): boolean {
  // What was made from a resource that is leaving goes with it, so it does not keep the work it leaves.
  const row = store.sqlite.prepare(`SELECT ${userContentSql("w", "?")} AS held FROM works w WHERE w.id = ?`).get(leavingResourceId ?? null, workId) as { held: number } | undefined;
  return row?.held === 1;
}

/** Whether anything the user made belongs to a resource itself (bookmarks, notes, recordings, screenshots, files, conversations, confirmed danmaku, project materials). */
export const resourceUserContentSql = (alias: string) => `(EXISTS (SELECT 1 FROM bookmarks ub WHERE ub.resource_id = ${alias}.id)
  OR EXISTS (SELECT 1 FROM content_objects uco WHERE uco.deleted_at IS NULL AND json_extract(uco.scope_json, '$.resourceId') = ${alias}.id)
  OR EXISTS (SELECT 1 FROM refs urf JOIN anchors ua ON ua.id = urf.to_id JOIN content_objects uco2 ON uco2.id = urf.from_object_id WHERE urf.to_kind = 'anchor' AND ua.resource_id = ${alias}.id AND uco2.deleted_at IS NULL)
  OR EXISTS (SELECT 1 FROM capture_events uce JOIN capture_sessions ucs ON ucs.id = uce.session_id WHERE uce.resource_id = ${alias}.id AND ucs.stage NOT IN ('cancelled', 'no_speech'))
  OR EXISTS (SELECT 1 FROM screenshots ush WHERE ush.resource_id = ${alias}.id)
  OR EXISTS (SELECT 1 FROM rough_cut_clips urcc WHERE urcc.resource_id = ${alias}.id)
  OR EXISTS (SELECT 1 FROM work_files uwf WHERE uwf.resource_id = ${alias}.id)
  OR EXISTS (SELECT 1 FROM agent_sessions uas WHERE uas.kind = 'resource' AND uas.target_id = ${alias}.id AND EXISTS (SELECT 1 FROM agent_runs uar WHERE uar.session_id = uas.id))
  OR EXISTS (SELECT 1 FROM danmaku_matches udm JOIN resource_revisions udv ON udv.id = udm.resource_revision_id WHERE udv.resource_id = ${alias}.id AND NOT (udm.confirmed = 0 AND udm.method = 'bangumi'))
  OR EXISTS (SELECT 1 FROM project_materials upm WHERE upm.kind = 'resource' AND upm.target_id = ${alias}.id))`;

export function resourceHoldsUserContent(store: DrizzleStore, resourceId: string): boolean {
  const row = store.sqlite.prepare(`SELECT ${resourceUserContentSql("r")} AS held FROM resources r WHERE r.id = ?`).get(resourceId) as { held: number } | undefined;
  return row?.held === 1;
}

export type VersionCounterpart = {
  /** The same episode or volume in the other version; null when the other version has none with that number. */
  resourceId: string | null;
  workId: string;
  revisionId: string | null;
  kind: string | null;
  ordinalLabel: string | null;
  /** Where to open it so the place carries over, in the terms of the other file; null opens it where it was left. */
  position: { kind: "temporal"; startMs: number } | { kind: "image"; pageId: string } | null;
};

/**
 * The same episode or volume in another version of the title, and the place in it that matches where the reader is now. Releases of an
 * episode differ in length and in pages, so the place is carried over as a fraction of the whole; a novel has no such place and opens where
 * it was left. `fraction` is where the reader is now; without it the saved progress of the resource says.
 */
export function counterpart(store: DrizzleStore, input: { resourceId: string; toWorkId: string; fraction?: number }): VersionCounterpart {
  const from = store.sqlite.prepare("SELECT id, ordinal_type AS ordinalType, ordinal_number AS ordinalNumber, ordinal_label AS ordinalLabel, kind FROM resources WHERE id = ?").get(input.resourceId) as
    { id: string; ordinalType: string | null; ordinalNumber: number | null; ordinalLabel: string | null; kind: string } | undefined;
  if (!from) throw new MangaError("NOT_FOUND", "resource missing");
  if (!store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(input.toWorkId)) throw new MangaError("NOT_FOUND", "target work missing");
  const none: VersionCounterpart = { resourceId: null, workId: input.toWorkId, revisionId: null, kind: null, ordinalLabel: null, position: null };
  const same = from.ordinalNumber !== null
    ? store.sqlite.prepare("SELECT id, kind, ordinal_label AS ordinalLabel FROM resources WHERE work_id = ? AND ordinal_number = ? AND COALESCE(ordinal_type, '') = ? ORDER BY sort_key, created_at, id LIMIT 1").get(input.toWorkId, from.ordinalNumber, from.ordinalType ?? "")
    : from.ordinalLabel
      ? store.sqlite.prepare("SELECT id, kind, ordinal_label AS ordinalLabel FROM resources WHERE work_id = ? AND ordinal_label = ? ORDER BY sort_key, created_at, id LIMIT 1").get(input.toWorkId, from.ordinalLabel)
      : undefined;
  const target = same as { id: string; kind: string; ordinalLabel: string | null } | undefined;
  if (!target) return none;
  const revision = store.sqlite.prepare("SELECT id, payload_json AS payload FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(target.id) as { id: string; payload: string } | undefined;
  const result: VersionCounterpart = { resourceId: target.id, workId: input.toWorkId, revisionId: revision?.id ?? null, kind: target.kind, ordinalLabel: target.ordinalLabel, position: null };
  if (!revision) return result;
  let fraction = input.fraction;
  if (fraction === undefined) {
    const fromRevision = store.sqlite.prepare("SELECT id FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(from.id) as { id: string } | undefined;
    const saved = fromRevision ? store.sqlite.prepare("SELECT percent, completion_state AS completion FROM progress_latest WHERE resource_id = ? AND resource_revision_id = ?").get(from.id, fromRevision.id) as { percent: number; completion: string } | undefined : undefined;
    // A finished episode is not carried over: the other version starts at its beginning, as any finished one does.
    fraction = saved && saved.completion !== "completed" ? saved.percent : 0;
  }
  fraction = Math.min(Math.max(fraction, 0), 1);
  if (fraction <= 0) return result;
  if (target.kind === "video") {
    const layout = readLayout(store, revision.id);
    if (layout?.unit === "ms" && layout.total > 0) result.position = { kind: "temporal", startMs: Math.round(fraction * layout.total) };
  } else if (target.kind === "comic") {
    const pages = (JSON.parse(revision.payload) as { comic?: { pages?: Array<{ id: string }> } }).comic?.pages ?? [];
    if (pages.length) result.position = { kind: "image", pageId: pages[Math.min(pages.length - 1, Math.max(0, Math.round(fraction * pages.length) - 1))]!.id };
  }
  return result;
}
