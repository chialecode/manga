import fs from "node:fs";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { absoluteIn, libraryRoots, moveLocation, type PlacedPath } from "../library-locations.ts";

export type RelinkedFile = { resourceId: string; workId: string; revisionId: string; title: string; ordinalLabel: string | null };

/**
 * A file that shows up at a new place in a library path with the content of a resource whose own file is gone is that resource's file, moved or
 * put back (A-67): the resource, its notes, bookmarks, recordings and conversation keep working, and nothing new is created. A file whose old
 * copy still exists is a second copy, not a move, and is left to import as a resource of its own. A resource that was outside every library
 * path counts as gone: its file cannot be opened from there (A-80), so the same file inside a library path is its file again.
 *
 * `fingerprint` is the content fingerprint the importer computed for the new file. Only the newest revision of a resource can be re-linked,
 * and a copy the application keeps itself (`hosted`) never counts: it cannot have gone missing.
 */
export function relinkByFingerprint(store: DrizzleStore, input: { fingerprint: string; placed: Pick<PlacedPath, "libraryPathId" | "relativePath" | "managed"> }): RelinkedFile | undefined {
  const rows = store.sqlite.prepare(`SELECT fl.id AS locationId, fl.library_path_id AS libraryPathId, fl.relative_path AS relativePath, fl.available AS available, fl.resource_revision_id AS revisionId,
      r.id AS resourceId, r.work_id AS workId, r.title AS title, r.ordinal_label AS ordinalLabel
    FROM resource_revisions v
    JOIN file_locations fl ON fl.resource_revision_id = v.id
    JOIN resources r ON r.id = v.resource_id
    WHERE v.fingerprint = ? AND fl.hosted = 0
      AND v.id = (SELECT nv.id FROM resource_revisions nv WHERE nv.resource_id = r.id ORDER BY nv.created_at DESC, nv.rowid DESC LIMIT 1)
    ORDER BY r.created_at, r.id`).all(input.fingerprint) as Array<{ locationId: string; libraryPathId: string | null; relativePath: string; available: number; revisionId: string; resourceId: string; workId: string; title: string; ordinalLabel: string | null }>;
  const roots = new Map(libraryRoots(store).map((item) => [item.id, item.root]));
  const here = (row: { libraryPathId: string | null; relativePath: string }) => row.libraryPathId === input.placed.libraryPathId && row.relativePath === input.placed.relativePath;
  const missing = (row: { libraryPathId: string | null; relativePath: string; available: number }) => {
    if (row.available === 0 || row.libraryPathId === null) return true;
    const root = roots.get(row.libraryPathId);
    return !root || !fs.existsSync(absoluteIn(root, row.relativePath));
  };
  const gone = rows.find((row) => !here(row) && missing(row));
  if (!gone) return undefined;
  moveLocation(store, { revisionId: gone.revisionId, placed: input.placed });
  return { resourceId: gone.resourceId, workId: gone.workId, revisionId: gone.revisionId, title: gone.title, ordinalLabel: gone.ordinalLabel };
}
