import fs from "node:fs";
import path from "node:path";
import { MangaError } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { listBookmarks, listNotes } from "./reading-service.ts";
import { outsideSql } from "./works-versions.ts";
import { libraryRoots, resolveLocation } from "./library-locations.ts";

export type ResourceContent = {
  resource: {
    id: string;
    title: string;
    kind: string;
    ordinalLabel: string | null;
    workId: string | null;
    workTitle: string | null;
    /** The file can be opened now. */
    available: boolean;
    /** Imported on its own: its file is under no library path (A-69). */
    outside: boolean;
    /** Where the file was last seen on this machine; null for a copy the application keeps itself. */
    path: string | null;
    /** The library path folder the file belongs to (null for a file outside the library and for the application's own copies). */
    libraryRoot: string | null;
    /** For a file outside the library: the folder to add as a library path to bring it back (A-80). */
    folderToAdd: string | null;
  };
  progress: { percent: number; completion: string; locator: unknown | null };
  notes: Array<{ objectId: string; title: string; preview: string; updatedAt: string }>;
  bookmarks: Array<{ id: string; label: string; locator: unknown; createdAt: string }>;
  recordings: unknown[];
  /** The conversation bound to the resource, when one has been opened; its messages stay whether or not the file does. */
  conversation: { sessionId: string; runs: number; updatedAt: string } | null;
};

/**
 * Everything the user made on one resource, and whether its file can be opened. The "resource unavailable" view is made from this
 * (A-67): a file that is gone, moved or off a removed library path takes none of it away, and it stays reachable from the work's page.
 * `recordings` come from the voice module when it is on, so this module does not depend on it.
 */
export function resourceContent(store: DrizzleStore, resourceId: string, recordings: () => unknown[] = () => []): ResourceContent {
  const row = store.sqlite.prepare(`SELECT r.id AS id, r.title AS title, r.kind AS kind, r.ordinal_label AS ordinalLabel, r.work_id AS workId, w.title AS workTitle, ${outsideSql("r")} AS outside
    FROM resources r LEFT JOIN works w ON w.id = r.work_id WHERE r.id = ?`).get(resourceId) as
    { id: string; title: string; kind: string; ordinalLabel: string | null; workId: string | null; workTitle: string | null; outside: number } | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "resource missing");
  const revision = store.sqlite.prepare("SELECT id FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(resourceId) as { id: string } | undefined;
  const location = revision ? resolveLocation(store, revision.id) ?? undefined : undefined;
  const root = location?.libraryPathId ? libraryRoots(store).find((item) => item.id === location.libraryPathId) : undefined;
  const progress = revision ? store.sqlite.prepare("SELECT percent, completion_state AS completion, last_locator_json AS locator FROM progress WHERE resource_id = ? AND resource_revision_id = ?").get(resourceId, revision.id) as { percent: number; completion: string; locator: string | null } | undefined : undefined;
  const conversation = store.sqlite.prepare(`SELECT s.id AS sessionId, s.updated_at AS updatedAt, (SELECT COUNT(*) FROM agent_runs run WHERE run.session_id = s.id) AS runs
    FROM agent_sessions s WHERE s.kind = 'resource' AND s.target_id = ? ORDER BY s.updated_at DESC LIMIT 1`).get(resourceId) as { sessionId: string; updatedAt: string; runs: number } | undefined;
  return {
    resource: {
      id: row.id, title: row.title, kind: row.kind, ordinalLabel: row.ordinalLabel, workId: row.workId, workTitle: row.workTitle,
      available: location ? location.available && location.path !== null && fs.existsSync(location.path) : true,
      outside: row.outside === 1,
      // Where the file is (or was, for one outside every library path), so the page can say where to look; the application's own copies have no place to show.
      path: location && !location.managed ? (location.path ?? location.legacyPath) : null,
      // The library path it belongs to: the relink dialog opens there, and a file picked outside it is refused.
      libraryRoot: root && !root.managed ? root.root : null,
      folderToAdd: location?.outside && location.legacyPath ? path.dirname(location.legacyPath) : null,
    },
    progress: { percent: progress?.percent ?? 0, completion: progress?.completion ?? "new", locator: progress?.locator ? JSON.parse(progress.locator) : null },
    notes: listNotes(store, { resourceId, limit: 100 }).map((note) => ({ objectId: String(note.objectId), title: String(note.title ?? ""), preview: String(note.preview ?? ""), updatedAt: String(note.updatedAt) })),
    bookmarks: listBookmarks(store, resourceId).map((mark) => ({ id: String(mark.id), label: String(mark.label ?? ""), locator: mark.locator, createdAt: String(mark.createdAt) })),
    recordings: recordings(),
    conversation: conversation ?? null,
  };
}
