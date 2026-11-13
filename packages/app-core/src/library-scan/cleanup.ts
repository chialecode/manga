import fs from "node:fs";
import type { DrizzleStore, Mutation } from "@manga/storage-drizzle";
import { availableResourceSql, resourceHoldsUserContent, workHoldsUserContent } from "../works-versions.ts";

export type CleanupHost = {
  assertWritable: () => void;
  forgetRevision?: (revisionId: string) => void;
  forgetWorkCovers?: (workIds: readonly string[]) => void;
};

const inFailedDir = (rel: string | null, failedDirs: readonly string[]) =>
  Boolean(rel && failedDirs.some((dir) => dir === "." || rel === dir || rel.startsWith(`${dir}/`)));

const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(",");

/**
 * Clean up deleted resources and empty/deleted works when the user triggers a manual rescan (`job.trigger === "manual"`).
 *
 * Domain invariants respected:
 * - Never touches anything if the library root folder itself is missing/unmounted or under an unreadable directory (`failedDirs`).
 * - Never removes a missing resource from a multi-file work that still has at least one available resource (`missingCount` stays accurate).
 * - Never removes a resource or work that holds user-authored data (`workHoldsUserContent` / `resourceHoldsUserContent`, AT-77).
 */
export function cleanupManualScan(
  store: DrizzleStore,
  host: CleanupHost,
  row: { id: string; path: string },
  failedDirs: readonly string[],
): { removedWorks: number; removedResources: number; cleanedFiles: number } {
  if (!fs.statSync(row.path, { throwIfNoEntry: false })?.isDirectory()) {
    return { removedWorks: 0, removedResources: 0, cleanedFiles: 0 };
  }

  const unreachablePathIds = new Set(
    (store.sqlite.prepare("SELECT id, path, managed FROM library_paths WHERE id <> ?").all(row.id) as Array<{ id: string; path: string; managed: number }>)
      .filter((other) => {
        const dir = other.managed === 1 ? store.managedLibraryDir : other.path;
        return !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory();
      })
      .map((other) => other.id),
  );

  const resourceUnderFailedDir = (resourceId: string): boolean => {
    if (!failedDirs.length) return false;
    const rels = store.sqlite.prepare(`
      SELECT relative_path AS rel FROM library_files WHERE path_id = ? AND resource_id = ?
      UNION
      SELECT fl.relative_path AS rel FROM file_locations fl JOIN resource_revisions v ON v.id = fl.resource_revision_id
      WHERE fl.library_path_id = ? AND v.resource_id = ? AND fl.relative_path IS NOT NULL
    `).all(row.id, resourceId, row.id, resourceId) as Array<{ rel: string | null }>;
    return rels.some((item) => inFailedDir(item.rel, failedDirs));
  };

  const resourceInUnreachablePath = (resourceId: string): boolean => {
    if (!unreachablePathIds.size) return false;
    const pathIds = store.sqlite.prepare(`
      SELECT path_id AS pathId FROM library_files WHERE resource_id = ? AND path_id <> ?
      UNION
      SELECT fl.library_path_id AS pathId FROM file_locations fl JOIN resource_revisions v ON v.id = fl.resource_revision_id
      WHERE v.resource_id = ? AND fl.library_path_id IS NOT NULL AND fl.library_path_id <> ?
    `).all(resourceId, row.id, resourceId, row.id) as Array<{ pathId: string }>;
    return pathIds.some((item) => unreachablePathIds.has(item.pathId));
  };

  const candidates = store.sqlite.prepare(`
    SELECT DISTINCT r.id AS id, r.work_id AS workId
    FROM resources r
    WHERE (
      EXISTS (SELECT 1 FROM library_files lf WHERE lf.resource_id = r.id AND lf.path_id = ?)
      OR EXISTS (
        SELECT 1 FROM resource_revisions v JOIN file_locations fl ON fl.resource_revision_id = v.id
        WHERE v.resource_id = r.id AND fl.library_path_id = ?
      )
    )
    AND NOT ${availableResourceSql("r")}
  `).all(row.id, row.id) as Array<{ id: string; workId: string | null }>;

  const purgeResourceSet = new Set<string>();
  const purgeWorkSet = new Set<string>();
  const checkedWorks = new Set<string>();

  for (const item of candidates) {
    if (item.workId === null) {
      if (resourceUnderFailedDir(item.id) || resourceInUnreachablePath(item.id)) continue;
      if (resourceHoldsUserContent(store, item.id)) continue;
      purgeResourceSet.add(item.id);
      continue;
    }
    const workId = item.workId;
    if (checkedWorks.has(workId)) continue;
    checkedWorks.add(workId);

    const stillHasAvailable = store.sqlite.prepare(`SELECT 1 AS ok FROM resources rw WHERE rw.work_id = ? AND ${availableResourceSql("rw")} LIMIT 1`).get(workId);
    if (stillHasAvailable) continue;
    if (workHoldsUserContent(store, workId)) continue;

    const workResources = (store.sqlite.prepare("SELECT id FROM resources WHERE work_id = ?").all(workId) as Array<{ id: string }>).map((r) => r.id);
    if (!workResources.length) continue;
    if (workResources.some((resId) => resourceUnderFailedDir(resId) || resourceInUnreachablePath(resId) || resourceHoldsUserContent(store, resId))) continue;

    purgeWorkSet.add(workId);
    for (const resId of workResources) purgeResourceSet.add(resId);
  }

  const orphanFiles = (store.sqlite.prepare(`
    SELECT relative_path AS rel FROM library_files lf
    WHERE lf.path_id = ? AND lf.state = 'unavailable'
      AND (lf.resource_id IS NULL OR NOT EXISTS (SELECT 1 FROM resources r WHERE r.id = lf.resource_id))
  `).all(row.id) as Array<{ rel: string }>).filter((item) => !inFailedDir(item.rel, failedDirs));

  const purgeResourceIds = [...purgeResourceSet];
  const purgeWorkIds = [...purgeWorkSet];
  if (!purgeResourceIds.length && !purgeWorkIds.length && !orphanFiles.length) {
    return { removedWorks: 0, removedResources: 0, cleanedFiles: 0 };
  }

  host.assertWritable();

  // Collect revision IDs before committing deletions so disk caches/handles are only removed after SQLite commits cleanly.
  const purgeRevisionIds = purgeResourceIds.length && host.forgetRevision
    ? (store.sqlite.prepare(`SELECT id FROM resource_revisions WHERE resource_id IN (${placeholders(purgeResourceIds.length)})`).all(...purgeResourceIds) as Array<{ id: string }>).map((rev) => rev.id)
    : [];

  const mutations: Mutation[] = [];

  if (purgeResourceIds.length) {
    const inRes = placeholders(purgeResourceIds.length);
    const byRevision = `IN (SELECT id FROM resource_revisions WHERE resource_id IN (${inRes}))`;
    mutations.push(
      { sql: `DELETE FROM file_locations WHERE resource_revision_id ${byRevision}`, params: purgeResourceIds },
      { sql: `DELETE FROM media_probes WHERE resource_revision_id ${byRevision}`, params: purgeResourceIds },
      { sql: `DELETE FROM play_copies WHERE resource_revision_id ${byRevision}`, params: purgeResourceIds },
      { sql: `DELETE FROM danmaku_matches WHERE resource_revision_id ${byRevision}`, params: purgeResourceIds },
      { sql: `DELETE FROM library_files WHERE resource_id IN (${inRes})`, params: purgeResourceIds },
      { sql: `DELETE FROM resource_assets WHERE resource_id IN (${inRes})`, params: purgeResourceIds },
      { sql: `DELETE FROM text_fragments WHERE resource_id IN (${inRes})`, params: purgeResourceIds },
      { sql: `DELETE FROM search_idx WHERE resource_id IN (${inRes})`, params: purgeResourceIds },
      { sql: `DELETE FROM import_receipts WHERE resource_id IN (${inRes})`, params: purgeResourceIds },
      { sql: `DELETE FROM progress WHERE resource_id IN (${inRes})`, params: purgeResourceIds },
      { sql: `DELETE FROM recent_dismissals WHERE key IN (${purgeResourceIds.map(() => "'resource:' || ?").join(",")})`, params: purgeResourceIds },
      { sql: `DELETE FROM agent_sessions WHERE kind = 'resource' AND target_id IN (${inRes}) AND NOT EXISTS (SELECT 1 FROM agent_runs ar WHERE ar.session_id = agent_sessions.id)`, params: purgeResourceIds },
      { sql: `DELETE FROM resource_revisions WHERE resource_id IN (${inRes})`, params: purgeResourceIds },
      { sql: `DELETE FROM resources WHERE id IN (${inRes})`, params: purgeResourceIds },
    );
  }

  if (purgeWorkIds.length) {
    const inWorks = placeholders(purgeWorkIds.length);
    const imageHashes = (store.sqlite.prepare(`
      SELECT image_hash AS hash FROM covers WHERE work_id IN (${inWorks}) AND image_hash IS NOT NULL
      UNION SELECT image_hash FROM subject_characters WHERE work_id IN (${inWorks}) AND image_hash IS NOT NULL
      UNION SELECT image_hash FROM subject_persons WHERE work_id IN (${inWorks}) AND image_hash IS NOT NULL
    `).all(...purgeWorkIds, ...purgeWorkIds, ...purgeWorkIds) as Array<{ hash: string }>).map((item) => item.hash);

    for (const table of ["danmaku_consent", "metadata_overrides", "metadata_snapshots", "metadata_candidates", "work_links", "covers", "subject_characters", "subject_persons"]) {
      mutations.push({ sql: `DELETE FROM ${table} WHERE work_id IN (${inWorks})`, params: purgeWorkIds });
    }
    mutations.push(
      { sql: `DELETE FROM recent_dismissals WHERE key IN (${purgeWorkIds.map(() => "'work:' || ?").join(",")})`, params: purgeWorkIds },
      { sql: `DELETE FROM agent_sessions WHERE kind = 'work' AND target_id IN (${inWorks}) AND NOT EXISTS (SELECT 1 FROM agent_runs ar WHERE ar.session_id = agent_sessions.id)`, params: purgeWorkIds },
      { sql: `DELETE FROM works WHERE id IN (${inWorks})`, params: purgeWorkIds },
    );
    for (const hash of imageHashes) {
      mutations.push({
        sql: `DELETE FROM images WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM covers WHERE image_hash = images.hash)
          AND NOT EXISTS (SELECT 1 FROM subject_characters WHERE image_hash = images.hash)
          AND NOT EXISTS (SELECT 1 FROM subject_persons WHERE image_hash = images.hash)`,
        params: [hash],
      });
    }
  }

  for (const file of orphanFiles) {
    mutations.push({ sql: "DELETE FROM library_files WHERE path_id = ? AND relative_path = ? AND state = 'unavailable'", params: [row.id, file.rel] });
  }

  store.commit({
    mutations,
    events: [{ type: "library.manualScanCleaned", payload: { pathId: row.id, workIds: purgeWorkIds, resourceIds: purgeResourceIds } }],
  });

  if (host.forgetRevision) {
    for (const revisionId of purgeRevisionIds) host.forgetRevision(revisionId);
  }
  if (purgeWorkIds.length && host.forgetWorkCovers) {
    host.forgetWorkCovers(purgeWorkIds);
  }

  return { removedWorks: purgeWorkIds.length, removedResources: purgeResourceIds.length, cleanedFiles: orphanFiles.length };
}
