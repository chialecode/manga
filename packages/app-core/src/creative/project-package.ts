import { createHash } from "node:crypto";
import fs from "node:fs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { MangaError } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { applyBundle, bundleConflicts, checkBundle, collectBundle, type BundleHooks, type BundleOutcome, type ProjectBundle, type Row, type Snapshot } from "./bundle.ts";
import { describeObject, isObjectKind } from "./objects.ts";
import { writeExportFile } from "./export-file.ts";

/**
 * The project package (CRE-01, AT-25, AT-28): one zip that holds a project. Its manifest names the format and its version, and lists every file
 * with its size and SHA-256, so a package that was changed, cut short or padded is refused before anything is read into the profile. The files are
 * the project, its tables as JSON, and a readable snapshot of each piece of personal material the project points at; the library itself never travels.
 */
export const PROJECT_PACKAGE_FORMAT = "manga-project-package-v1";
export const PROJECT_PACKAGE_VERSION = 1;
/** The version of the rows a package carries; a package from a newer data version is not read. */
export const PROJECT_PACKAGE_DATA_VERSION = 9;
export const PROJECT_PACKAGE_EXTENSION = "manga-project.zip";

export const PACKAGE_LIMITS = { fileBytes: 128 * 1024 * 1024, entryBytes: 32 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, entries: 5000 } as const;

type EntryKind = "project" | "table" | "snapshot";
type Entry = { path: string; kind: EntryKind; sha256: string; bytes: number };
export type PackageManifest = {
  format: typeof PROJECT_PACKAGE_FORMAT; formatVersion: number; dataVersion: number; createdAt: string;
  projectId: string; projectName: string; counts: Record<string, number>; entries: Entry[];
};

const bad = (message: string, reason: string, extra: Record<string, unknown> = {}) => new MangaError("VALIDATION_ERROR", message, { details: { reason, ...extra } });
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
const ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** A file name for a snapshot: the kind and a name made only of safe characters (ids from other profiles are never trusted as file names). */
const snapshotFile = (snap: Pick<Snapshot, "kind" | "id">) => `snapshots/${snap.kind}-${sha256(strToU8(`${snap.kind}:${snap.id}`)).slice(0, 24)}.json`;

// ---------------------------------------------------------------------------------------------------------- writing

/** Builds the package for a project as bytes. What it holds is read back before it is returned, so a package that cannot be read is never written. */
export function buildProjectPackage(store: DrizzleStore, projectId: string, now = new Date().toISOString()): { data: Buffer; manifest: PackageManifest; bundle: ProjectBundle } {
  const bundle = collectBundle(store, projectId, now);
  const files: Record<string, Uint8Array> = {};
  const entries: Entry[] = [];
  const add = (path: string, kind: EntryKind, value: unknown) => {
    const bytes = strToU8(JSON.stringify(value));
    files[path] = bytes;
    entries.push({ path, kind, sha256: sha256(bytes), bytes: bytes.length });
  };
  add("project.json", "project", bundle.project);
  const counts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(bundle.tables)) {
    counts[table] = rows.length;
    if (rows.length) add(`tables/${table}.json`, "table", rows);
  }
  counts.snapshots = bundle.snapshots.length;
  for (const snap of bundle.snapshots) add(snapshotFile(snap), "snapshot", snap);
  const manifest: PackageManifest = {
    format: PROJECT_PACKAGE_FORMAT, formatVersion: PROJECT_PACKAGE_VERSION, dataVersion: PROJECT_PACKAGE_DATA_VERSION, createdAt: now,
    projectId: String(bundle.project.id), projectName: String(bundle.project.name), counts, entries,
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  const data = Buffer.from(zipSync(files, { level: 6, mtime: new Date(now) }));
  readProjectPackageBytes(data);
  return { data, manifest, bundle };
}

/** Writes a project's package into a folder the user picked, under a name that does not overwrite anything. Only the file name comes back. */
export function writeProjectPackage(store: DrizzleStore, projectId: string, dir: string, now?: string): { fileName: string; bytes: number; counts: Record<string, number> } {
  const { data, manifest } = buildProjectPackage(store, projectId, now);
  return { ...writeExportFile(dir, manifest.projectName, PROJECT_PACKAGE_EXTENSION, data, "project"), counts: manifest.counts };
}

// ---------------------------------------------------------------------------------------------------------- reading

function parseJson(path: string, bytes: Uint8Array): unknown {
  try { return JSON.parse(strFromU8(bytes)); } catch { throw bad(`${path} is not JSON`, "schema", { path }); }
}

function checkManifest(value: unknown): PackageManifest {
  const manifest = value as Partial<PackageManifest> | null;
  if (!manifest || typeof manifest !== "object" || manifest.format !== PROJECT_PACKAGE_FORMAT) throw bad("this is not a MANGA project package", "format");
  if (!Number.isInteger(manifest.formatVersion) || (manifest.formatVersion as number) < 1) throw bad("the package has no usable format version", "format");
  if ((manifest.formatVersion as number) > PROJECT_PACKAGE_VERSION) throw bad("this package was made by a newer version of the application", "newer", { formatVersion: manifest.formatVersion });
  if (!Number.isInteger(manifest.dataVersion) || (manifest.dataVersion as number) < 1) throw bad("the package has no usable data version", "format");
  if ((manifest.dataVersion as number) > PROJECT_PACKAGE_DATA_VERSION) throw bad("this package holds data from a newer version of the application", "newer", { dataVersion: manifest.dataVersion });
  if (typeof manifest.createdAt !== "string" || typeof manifest.projectId !== "string" || typeof manifest.projectName !== "string") throw bad("the manifest is incomplete", "format");
  if (!Array.isArray(manifest.entries) || manifest.entries.length > PACKAGE_LIMITS.entries) throw bad("the manifest lists too many files", "size");
  const seen = new Set<string>();
  for (const entry of manifest.entries as unknown[]) {
    const item = entry as Partial<Entry> | null;
    if (!item || typeof item.path !== "string" || !ENTRY_NAME.test(item.path) || item.path.length > 200 || item.path === "manifest.json") throw bad("the manifest names a file that is not allowed", "unsafe");
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isInteger(item.bytes) || (item.bytes as number) < 0 || (item.bytes as number) > PACKAGE_LIMITS.entryBytes) throw bad("the manifest lists a file with a size or hash that is not usable", "format");
    if (item.kind !== "project" && item.kind !== "table" && item.kind !== "snapshot") throw bad("the manifest lists a file of an unknown kind", "format");
    if (seen.has(item.path)) throw bad("the manifest lists a file twice", "format");
    seen.add(item.path);
  }
  return { ...(manifest as PackageManifest), counts: typeof manifest.counts === "object" && manifest.counts ? manifest.counts : {} };
}

/** Reads a package from bytes: refuses unsafe or oversized zips, then checks every file against the manifest, then checks the rows. Nothing is written. */
export function readProjectPackageBytes(data: Uint8Array): { manifest: PackageManifest; bundle: ProjectBundle } {
  if (data.length > PACKAGE_LIMITS.fileBytes) throw bad("the package is too large", "size");
  let total = 0;
  let count = 0;
  const names = new Set<string>();
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (file) => {
        count += 1;
        if (count > PACKAGE_LIMITS.entries + 1) throw bad("the package holds too many files", "size");
        if (file.name !== "manifest.json" && (!ENTRY_NAME.test(file.name) || file.name.length > 200)) throw bad("the package holds a file with a name that is not allowed", "unsafe");
        if (names.has(file.name)) throw bad("the package holds a file twice", "unsafe");
        names.add(file.name);
        if (file.originalSize > PACKAGE_LIMITS.entryBytes) throw bad("a file in the package is too large", "size");
        total += file.originalSize;
        if (total > PACKAGE_LIMITS.totalBytes) throw bad("the package is too large once unpacked", "size");
        return true;
      },
    });
  } catch (error) {
    if (error instanceof MangaError) throw error;
    throw bad("this is not a readable zip file", "format");
  }
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw bad("the package has no manifest", "format");
  const manifest = checkManifest(parseJson("manifest.json", manifestBytes));
  const listed = new Set(manifest.entries.map((entry) => entry.path));
  for (const name of Object.keys(files)) if (name !== "manifest.json" && !listed.has(name)) throw bad("the package holds a file the manifest does not list", "extra", { path: name });
  for (const entry of manifest.entries) {
    const bytes = files[entry.path];
    if (!bytes) throw bad("a file the manifest lists is not in the package", "missing", { path: entry.path });
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw bad("a file in the package does not match the manifest; the package was changed or cut short", "hash", { path: entry.path });
  }
  const byKind = (kind: EntryKind) => manifest.entries.filter((entry) => entry.kind === kind);
  const projectEntries = byKind("project");
  if (projectEntries.length !== 1 || projectEntries[0]!.path !== "project.json") throw bad("the package must hold exactly one project", "schema");
  const tables: Record<string, unknown> = {};
  for (const entry of byKind("table")) {
    const match = /^tables\/([a-z_]+)\.json$/.exec(entry.path);
    if (!match) throw bad("a table file has a name that is not allowed", "unsafe");
    tables[match[1]!] = parseJson(entry.path, files[entry.path]!);
  }
  const snapshots = byKind("snapshot").map((entry) => parseJson(entry.path, files[entry.path]!));
  const bundle = checkBundle({ project: parseJson("project.json", files["project.json"]!), tables, snapshots });
  if (String(bundle.project.id) !== manifest.projectId) throw bad("the manifest and the project do not agree", "schema");
  return { manifest, bundle };
}

export function readProjectPackage(file: string): { manifest: PackageManifest; bundle: ProjectBundle } {
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { throw new MangaError("NOT_FOUND", "the package file is not there", { details: { reason: "missing-file" } }); }
  if (!stat.isFile()) throw bad("that is not a package file", "format");
  if (stat.size > PACKAGE_LIMITS.fileBytes) throw bad("the package is too large", "size");
  return readProjectPackageBytes(fs.readFileSync(file));
}

// ---------------------------------------------------------------------------------------------------------- preview and import

export type PackagePreview = {
  format: string; formatVersion: number; createdAt: string;
  projectId: string; name: string; goal: string;
  counts: Record<string, number>;
  /** Whether this profile already has the project (or something in it), so importing makes a copy under new ids. */
  copy: boolean;
  /** The references the project holds, and whether what each points at is in this profile. */
  materials: Array<{ kind: string; targetId: string; label: string; present: boolean }>;
  missing: number;
};

export function previewProjectPackage(store: DrizzleStore, file: string): PackagePreview {
  const { manifest, bundle } = readProjectPackage(file);
  const snaps = new Map(bundle.snapshots.map((snap) => [`${snap.kind}:${snap.id}`, snap]));
  const owned = new Set([...bundle.tables.whiteboards, ...bundle.tables.mindmaps, ...bundle.tables.drafts, ...bundle.tables.excerpts, ...bundle.tables.rough_cuts].map((row: Row) => String(row.id)));
  const materials = bundle.tables.project_materials.map((row) => {
    const kind = String(row.kind);
    const targetId = String(row.target_id);
    const inside = owned.has(targetId);
    const present = inside || (isObjectKind(kind) && describeObject(store, kind, targetId).exists);
    return { kind, targetId, label: String(row.label) || snaps.get(`${kind}:${targetId}`)?.label || "", present };
  });
  return {
    format: manifest.format, formatVersion: manifest.formatVersion, createdAt: manifest.createdAt,
    projectId: manifest.projectId, name: String(bundle.project.name), goal: String(bundle.project.goal),
    counts: { ...manifest.counts }, copy: bundleConflicts(store, bundle), materials, missing: materials.filter((item) => !item.present).length,
  };
}

export function importProjectPackage(store: DrizzleStore, file: string, hooks: BundleHooks): BundleOutcome {
  const { bundle } = readProjectPackage(file);
  return applyBundle(store, bundle, hooks);
}
