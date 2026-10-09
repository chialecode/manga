import fs from "node:fs";
import path from "node:path";
import { MangaError, createId } from "@manga/contracts";
import type { DrizzleStore, Mutation } from "@manga/storage-drizzle";

/**
 * Where a resource's file is (A-80). A file location is a library path plus a path inside it, and this module is the only place that turns the
 * pair into a path on disk or a path on disk into the pair. Nothing else joins a library root with a stored path, so a library path that
 * changes its folder, or a resource that is not under any library path, behaves the same way everywhere.
 */

export type LibraryRoot = { id: string; root: string; managed: boolean; mediaKind: string };

export type PlacedPath = { libraryPathId: string; relativePath: string; root: string; managed: boolean };

export type ResolvedLocation = {
  id: string;
  revisionId: string;
  libraryPathId: string | null;
  /** Relative to the library path, `/` separated; `.` is the library path itself. */
  relativePath: string;
  legacyPath: string | null;
  fingerprint: string;
  /** The availability flag the database holds; the file itself may have changed since. */
  available: boolean;
  /** Kept by the application in its own library path (pasted text, restored media). */
  managed: boolean;
  /** Not under any library path: the resource cannot be opened until its folder is added as a library path (A-80). */
  outside: boolean;
  /** Absolute path of the file, or null for a location outside the library. */
  path: string | null;
};

type LocationRow = {
  id: string; resource_revision_id: string; library_path_id: string | null; relative_path: string; legacy_path: string | null; fingerprint: string;
  available: number; hosted: number; root_path: string | null; managed: number | null;
};

/** Every library path with the folder it is at now; the application-managed one always follows the resources partition. */
export function libraryRoots(store: DrizzleStore): LibraryRoot[] {
  const rows = store.sqlite.prepare("SELECT id, path, managed, media_kind FROM library_paths").all() as Array<{ id: string; path: string; managed: number; media_kind: string }>;
  return rows.map((row) => ({ id: row.id, root: row.managed === 1 ? store.managedLibraryDir : path.resolve(row.path), managed: row.managed === 1, mediaKind: row.media_kind }));
}

/** `abs` relative to `root` with `/` separators, `.` for the root itself, or null when it is not inside. */
export function relativeWithin(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (rel === "") return ".";
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** The path on disk of a stored relative path. Refuses a stored value that would leave the library path. */
export function absoluteIn(root: string, relativePath: string): string {
  if (relativePath === "." || relativePath === "") return root;
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === ".." || segment === "" || segment.includes("\\") || /^[a-z]:/i.test(segment))) {
    throw new MangaError("PATH_ESCAPE", "a stored file location leaves its library path");
  }
  return path.join(root, ...segments);
}

/** The library path that holds `abs`, or null. Library paths never overlap, so at most one holds a path; the application-managed one is last. */
export function placeInLibrary(store: DrizzleStore, abs: string): PlacedPath | null {
  const target = path.resolve(abs);
  for (const item of libraryRoots(store).sort((a, b) => Number(a.managed) - Number(b.managed) || b.root.length - a.root.length)) {
    const rel = relativeWithin(item.root, target);
    if (rel !== null) return { libraryPathId: item.id, relativePath: rel, root: item.root, managed: item.managed };
  }
  return null;
}

/**
 * Like `placeInLibrary`, but a file outside every library path is refused with what the interface needs to offer adding its folder.
 * `isFolder` says that `abs` is itself the folder, so the folder to add is `abs` and not the one above it.
 */
export function requireInLibrary(store: DrizzleStore, abs: string, options: { isFolder?: boolean } = {}): PlacedPath {
  const placed = placeInLibrary(store, abs);
  if (placed) return placed;
  throw new MangaError("VALIDATION_ERROR", options.isFolder ? "the folder is not inside a library path; add it as a library path first" : "the file is not inside a library path; add its folder as a library path first", {
    details: { reason: "outside-library", folder: options.isFolder ? path.resolve(abs) : path.dirname(path.resolve(abs)) },
  });
}

/** Keep `bytes` in the application-managed library path as `<name>`, and say where. */
export function keepInManagedLibrary(store: DrizzleStore, name: string, bytes: Uint8Array): PlacedPath & { absolute: string } {
  const managed = store.ensureManagedLibraryPath();
  const absolute = path.join(managed.path, name);
  fs.mkdirSync(managed.path, { recursive: true });
  fs.writeFileSync(absolute, bytes);
  return { libraryPathId: managed.id, relativePath: name, root: managed.path, managed: true, absolute };
}

export function resolveLocation(store: DrizzleStore, revisionId: string): ResolvedLocation | null {
  const row = store.sqlite.prepare(`SELECT fl.id, fl.resource_revision_id, fl.library_path_id, fl.relative_path, fl.legacy_path, fl.fingerprint, fl.available, fl.hosted,
      lp.path AS root_path, lp.managed AS managed
    FROM file_locations fl LEFT JOIN library_paths lp ON lp.id = fl.library_path_id
    WHERE fl.resource_revision_id = ? ORDER BY fl.rowid DESC LIMIT 1`).get(revisionId) as LocationRow | undefined;
  return row ? describe(store, row) : null;
}

/** Every location of a resource's revisions, newest first. */
export function resolveResourceLocations(store: DrizzleStore, resourceId: string): ResolvedLocation[] {
  const rows = store.sqlite.prepare(`SELECT fl.id, fl.resource_revision_id, fl.library_path_id, fl.relative_path, fl.legacy_path, fl.fingerprint, fl.available, fl.hosted,
      lp.path AS root_path, lp.managed AS managed
    FROM file_locations fl JOIN resource_revisions v ON v.id = fl.resource_revision_id LEFT JOIN library_paths lp ON lp.id = fl.library_path_id
    WHERE v.resource_id = ? ORDER BY v.created_at DESC, v.rowid DESC, fl.rowid DESC`).all(resourceId) as LocationRow[];
  return rows.map((row) => describe(store, row));
}

function describe(store: DrizzleStore, row: LocationRow): ResolvedLocation {
  const managed = row.managed === 1;
  const inLibrary = row.library_path_id !== null && row.root_path !== null;
  let absolute: string | null = null;
  if (inLibrary) {
    const root = managed ? store.managedLibraryDir : path.resolve(row.root_path!);
    absolute = absoluteIn(root, row.relative_path);
  }
  return {
    id: row.id, revisionId: row.resource_revision_id, libraryPathId: row.library_path_id, relativePath: row.relative_path, legacyPath: row.legacy_path,
    fingerprint: row.fingerprint, available: row.available === 1, managed, outside: !inLibrary, path: absolute,
  };
}

/** A new file location row for a revision. */
export function insertLocation(input: { revisionId: string; placed: Pick<PlacedPath, "libraryPathId" | "relativePath" | "managed">; fingerprint: string; id?: string }): Mutation {
  return {
    sql: "INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,1,?)",
    params: [input.id ?? createId("loc"), input.revisionId, input.placed.libraryPathId, input.placed.relativePath, input.fingerprint, input.placed.managed ? 1 : 0],
  };
}

/** Point a revision's existing location at a place inside a library path and mark it available; false when the revision had none. */
export function moveLocation(store: DrizzleStore, input: { revisionId: string; placed: Pick<PlacedPath, "libraryPathId" | "relativePath" | "managed">; fingerprint?: string }): boolean {
  const result = store.sqlite.prepare(`UPDATE file_locations SET library_path_id = ?, relative_path = ?, legacy_path = NULL, available = 1, hosted = ?${input.fingerprint ? ", fingerprint = ?" : ""} WHERE resource_revision_id = ?`)
    .run(...[input.placed.libraryPathId, input.placed.relativePath, input.placed.managed ? 1 : 0, ...(input.fingerprint ? [input.fingerprint] : []), input.revisionId]);
  return result.changes > 0;
}

/** What opening a resource would meet, read from its newest file location without opening anything (A-86). */
export type OpenCheck =
  /** `path` is null for a resource with no file at all (text that was pasted in). */
  | { state: "open"; path: string | null }
  /** The file is under no library path; `folder` is what to add as one, when it is known. */
  | { state: "outside"; folder: string | null }
  /** The file is under a library path and is not there: `libraryPath` is the folder of that path, `relativePath` where the file was in it. */
  | { state: "missing"; libraryPathId: string; libraryPath: string; relativePath: string; rootReachable: boolean };

export type OpenFailure = Exclude<OpenCheck, { state: "open" }>;

/**
 * The one check every way of opening a resource goes through (A-86): the commands that open or fetch its content, the services behind them, the
 * play copy and page cache, and the question the interface asks before it opens anything. It looks at the newest revision's location only.
 */
export function checkOpenable(store: DrizzleStore, resourceId: string): OpenCheck {
  const newest = resolveResourceLocations(store, resourceId)[0];
  if (!newest) return { state: "open", path: null };
  if (newest.outside) return { state: "outside", folder: newest.legacyPath ? path.dirname(newest.legacyPath) : null };
  if (newest.path !== null && fs.existsSync(newest.path)) return { state: "open", path: newest.path };
  const root = libraryRoots(store).find((item) => item.id === newest.libraryPathId);
  return { state: "missing", libraryPathId: newest.libraryPathId!, libraryPath: root?.root ?? "", relativePath: newest.relativePath, rootReachable: Boolean(root && fs.existsSync(root.root)) };
}

/** The error details a refusal carries, which the interface turns into its question (see `checkOpenable`). */
export function openFailureDetails(check: OpenFailure): Record<string, unknown> {
  return check.state === "outside"
    ? { reason: "outside-library", folder: check.folder }
    : { reason: "file-missing", libraryPathId: check.libraryPathId, libraryPath: check.libraryPath, relativePath: check.relativePath, rootReachable: check.rootReachable };
}

/**
 * A resource whose file is under no library path, or is not there, cannot be opened (A-80, A-86): it keeps what the person made on it, and the answer
 * says which of the two it is. A resource with no file at all (text that was pasted in) has nothing to be outside of.
 */
export function assertOpenable(store: DrizzleStore, resourceId: string): void {
  const check = checkOpenable(store, resourceId);
  if (check.state === "open") return;
  throw new MangaError("LOCATION_UNAVAILABLE", check.state === "outside"
    ? "the file of this resource is outside every library path; add its folder as a library path to open it"
    : "the file of this resource is not in its library path any more; locate it again to open it", { details: openFailureDetails(check) });
}

/** True when the resource's newest revision has its file under a library path (the application-managed one counts). */
export const insideLibrarySql = (resourceAlias: string) => `EXISTS (SELECT 1 FROM resource_revisions lv JOIN file_locations ll ON ll.resource_revision_id = lv.id WHERE lv.resource_id = ${resourceAlias}.id AND ll.library_path_id IS NOT NULL)`;
