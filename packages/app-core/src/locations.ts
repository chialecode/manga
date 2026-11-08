import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkLibraryIntegrity, checkpointClosedLibrary, peekSchemaMeta, pokeSchemaMeta } from "@manga/storage-drizzle";
import { comparablePath, copyOwnedFile, fingerprintTree, listCopyFiles, pathsOverlap } from "./domain/file-ownership.ts";
export { ownedFileFingerprint, pathsOverlap, copyOwnedFile, listCopyFiles, fingerprintTree } from "./domain/file-ownership.ts";
import {
  CHANNELS,
  LOCATION_PARTITIONS,
  MangaError,
  type Channel,
  type LocationLayout,
  type LocationPartition,
} from "@manga/contracts";

export type PointerBody = {
  profileRoot?: string;
  channel?: Channel;
  revision?: number;
  partitions?: Partial<Record<LocationPartition, string>>;
  relocatedRoot?: string;
  redirectedTo?: string;
};

export const RELOCATION_MARKER = "RELOCATED.json";

export type LaunchRequest = {
  channel?: Channel;
  /** Whether the process is running as the isolated test installation identity (`MANGA Test` / `MANGA Dev Test`, 计划 4.8). */
  testIdentity?: boolean;
  profileRoot?: string;
  pointerPath?: string;
  /** The system's registered Documents folder (the main process asks Electron before it starts); else `MANGA_DOCUMENTS_DIR`, else `~/Documents`. */
  documentsDir?: string;
  /** The system's registered Downloads folder; else `MANGA_DOWNLOADS_DIR`, else `~/Downloads`. */
  downloadsDir?: string;
  /** `%LOCALAPPDATA%`; else the `LOCALAPPDATA` variable, else `~/AppData/Local`. */
  localAppDataDir?: string;
  packaged?: boolean;
};

/** What the application keeps for itself (the database, settings and sealed credentials, caches, logs, the browser runtime, backups): `%LOCALAPPDATA%`. */
export const APP_PARTITIONS = ["data", "cache", "logs", "backups", "runtime"] as const satisfies readonly LocationPartition[];
/** What the person makes and looks for in the file manager: the Documents folder. Downloads go to the Downloads folder. */
export const USER_PARTITIONS = ["works", "projects", "attachments", "resources", "exports"] as const satisfies readonly LocationPartition[];

/** The folder names of each channel (A-118, 计划 4.9): all lowercase `manga`, with the release and the development build side by side. A test always names its own root. */
const APP_FOLDER: Record<Channel, string> = { release: "manga", development: "manga-dev", test: "manga-test" };
const FILES_FOLDER: Record<Channel, string> = { release: "manga", development: "manga-dev", test: "manga-test" };

export function channelFolderName(channel: Channel, testIdentity = false): string {
  const base = APP_FOLDER[channel];
  return testIdentity && channel !== "test" ? `${base}-test` : base;
}

/** If a channel folder in Documents or Downloads still has an uppercase `MANGA` directory entry on disk, rename it in place to lowercase. */
function lowercaseOnDisk(dir: string): void {
  const parent = path.dirname(dir);
  const wanted = path.basename(dir).toLowerCase();
  if (!fs.existsSync(parent)) return;
  try {
    const actual = fs.readdirSync(parent).find((entry) => entry.toLowerCase() === wanted);
    if (actual && actual !== wanted) fs.renameSync(path.join(parent, actual), path.join(parent, wanted));
  } catch {
    // Best effort: an open handle in Explorer keeps the directory entry until the next start.
  }
}

/** Rewrite an uppercase `MANGA` / `MANGA-dev` / `MANGA-test` folder segment under Documents or Downloads to lowercase `manga`. */
export function lowercaseMangaPath(target: string, bases: readonly string[]): string {
  const resolved = path.resolve(target);
  for (const base of bases) {
    const root = path.resolve(base);
    const prefix = `${comparablePath(root)}${path.sep}`;
    if (!comparablePath(resolved).startsWith(prefix)) continue;
    const rest = resolved.slice(root.length + 1).split(path.sep);
    if (rest[0] && /^MANGA(-dev(-test)?|-test)?$/.test(rest[0])) {
      rest[0] = rest[0].toLowerCase();
      lowercaseOnDisk(path.join(root, rest[0]));
      return path.join(root, ...rest);
    }
  }
  return resolved;
}

export function resolveDocumentsDir(override?: string): string {
  if (override) return path.resolve(override);
  if (process.env.MANGA_DOCUMENTS_DIR) return path.resolve(process.env.MANGA_DOCUMENTS_DIR);
  return path.join(os.homedir(), "Documents");
}

export function resolveDownloadsDir(override?: string): string {
  if (override) return path.resolve(override);
  if (process.env.MANGA_DOWNLOADS_DIR) return path.resolve(process.env.MANGA_DOWNLOADS_DIR);
  return path.join(os.homedir(), "Downloads");
}

export function resolveLocalAppData(override?: string): string {
  if (override) return path.resolve(override);
  if (process.env.LOCALAPPDATA) return path.resolve(process.env.LOCALAPPDATA);
  return path.join(os.homedir(), "AppData", "Local");
}

export function defaultChannel(packaged = false): Channel {
  const env = process.env.MANGA_CHANNEL;
  if (env && (CHANNELS as readonly string[]).includes(env)) return env as Channel;
  if (process.env.NODE_ENV === "test" || process.env.MANGA_CHANNEL === "test") return "test";
  return packaged ? "release" : "development";
}

export const defaultAppRoot = (localAppData: string, channel: Channel, testIdentity = false): string =>
  path.join(localAppData, channelFolderName(channel, testIdentity));
export const defaultFilesRoot = (documentsDir: string, channel: Channel, testIdentity = false): string =>
  path.join(documentsDir, testIdentity && channel !== "test" ? `${FILES_FOLDER[channel]}-test` : FILES_FOLDER[channel]);
export const defaultDownloadsDir = (downloadsDir: string, channel: Channel, testIdentity = false): string =>
  path.join(downloadsDir, testIdentity && channel !== "test" ? `${FILES_FOLDER[channel]}-test` : FILES_FOLDER[channel]);

/** The launcher pointer: beside the application's own data. */
export function defaultPointerPath(localAppData: string, channel: Channel, testIdentity = false): string {
  return path.join(defaultAppRoot(localAppData, channel, testIdentity), "launcher", "pointer.json");
}

/** Where versions before the split kept everything, and their pointer (A-16, replaced by A-118). */
export const legacyProfileRoot = (documentsDir: string, channel: Channel): string => path.join(documentsDir, "manga", channel);
export const legacyPointerPath = (documentsDir: string, channel: Channel): string => path.join(legacyProfileRoot(documentsDir, channel), "launcher", "pointer.json");

export function inspectDirectory(dir: string): { writable: boolean; offline: boolean } {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const probe = path.join(dir, `.manga-write-${process.pid}`);
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    return { writable: true, offline: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { writable: false, offline: code === "ENOENT" || code === "ENOTDIR" || code === "EIO" };
  }
}

export function readPointer(file: string): PointerBody | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as PointerBody;
  } catch {
    return undefined;
  }
}

export function readRelocationMarker(root: string): string | undefined {
  const file = path.join(root, RELOCATION_MARKER);
  if (!fs.existsSync(file)) return undefined;
  try {
    const body = JSON.parse(fs.readFileSync(file, "utf8")) as { relocatedRoot?: string };
    return body.relocatedRoot ? path.resolve(body.relocatedRoot) : undefined;
  } catch {
    return undefined;
  }
}

export function writeRelocationMarker(oldRoot: string, newRoot: string): void {
  fs.mkdirSync(oldRoot, { recursive: true });
  const body = `${JSON.stringify({ relocatedRoot: path.resolve(newRoot), at: new Date().toISOString() }, null, 2)}\n`;
  fs.writeFileSync(path.join(oldRoot, RELOCATION_MARKER), body);
}

function libraryExists(root: string): boolean {
  return fs.existsSync(path.join(root, "data", "manga.sqlite"));
}

/** Follow relocatedRoot from a marker file or the library database before any pointer publish. */
export function authoritativeRoot(requestedRoot: string): { root: string; relocated: boolean } {
  const requested = path.resolve(requestedRoot);
  const marked = readRelocationMarker(requested);
  const fromDb = peekSchemaMeta(path.join(requested, "data"), "relocatedRoot");
  const relocated = marked ?? (fromDb ? path.resolve(fromDb) : undefined);
  if (!relocated || comparablePath(relocated) === comparablePath(requested)) {
    return { root: requested, relocated: false };
  }
  if (libraryExists(relocated)) return { root: relocated, relocated: true };
  throw new MangaError("LOCATION_UNAVAILABLE", "profile was relocated but the authoritative library is missing", {
    details: { requested, relocated, recovery: "choose-directory" },
  });
}

/** Written in the new application root while an old profile is being moved; found at the next start, it means the copy was cut short. */
export const UPGRADE_MARKER = "UPGRADE-IN-PROGRESS.json";

export type LocationUpgradeResult = NonNullable<LocationLayout["upgrade"]>;

function followPointer(file: string): PointerBody | undefined {
  const pointer = readPointer(file);
  if (pointer?.redirectedTo && fs.existsSync(pointer.redirectedTo)) return readPointer(pointer.redirectedTo) ?? pointer;
  return pointer;
}

function nearestExisting(dir: string): string {
  let current = path.resolve(dir);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function freeBytes(dir: string): number | null {
  try {
    const stat = fs.statfsSync(nearestExisting(dir));
    return Number(stat.bavail) * Number(stat.bsize);
  } catch {
    return null;
  }
}

/**
 * The move of a profile from where earlier versions kept it (`<Documents>\manga\<channel>`, or the root their pointer named) to the new places (A-118,
 * 计划 4.9), before the database is opened. Only the application's own partitions are copied (`cache` is rebuilt); the person's files stay where they
 * are and the new pointer names them as overrides. Every file is compared with its source and the database checked before the new pointer is written;
 * then the old root is marked so an older version follows. Nothing old is deleted. Any failure removes what was copied and leaves the old place working.
 */
export function upgradeLegacyLocation(options: { channel: Channel; documentsRoot: string; downloadsRoot?: string; appRoot: string; pointerPath: string; crashAt?: string }): LocationUpgradeResult | undefined {
  const { channel, documentsRoot, appRoot } = options;
  const bases = [documentsRoot, ...(options.downloadsRoot ? [options.downloadsRoot] : [])];
  lowercaseOnDisk(path.join(documentsRoot, "manga"));
  const legacyPointer = followPointer(legacyPointerPath(documentsRoot, channel));
  let from = legacyPointer?.profileRoot ? lowercaseMangaPath(legacyPointer.profileRoot, bases) : legacyProfileRoot(documentsRoot, channel);
  try { from = lowercaseMangaPath(authoritativeRoot(from).root, bases); } catch { return undefined; }
  if (!libraryExists(from) || pathsOverlap(from, appRoot)) return undefined;
  const legacyOverrides = legacyPointer?.partitions ?? {};
  const base = { from, to: appRoot, legacyPointerPath: legacyPointerPath(documentsRoot, channel) };
  const progressFile = path.join(appRoot, UPGRADE_MARKER);
  // A copy cut short last time is cleared first; a library already in the new place that no pointer names is not ours to overwrite.
  if (fs.existsSync(progressFile)) {
    try {
      const earlier = JSON.parse(fs.readFileSync(progressFile, "utf8")) as { partitions?: string[] };
      for (const name of earlier.partitions ?? []) if ((APP_PARTITIONS as readonly string[]).includes(name)) fs.rmSync(path.join(appRoot, name), { recursive: true, force: true });
      fs.rmSync(progressFile, { force: true });
    } catch {
      return { ...base, state: "failed", reason: "cleanup-failed", files: 0, bytes: 0, carried: [] };
    }
  } else if (libraryExists(appRoot)) {
    return { ...base, state: "failed", reason: "target-occupied", files: 0, bytes: 0, carried: [] };
  }
  const overrides: Partial<Record<LocationPartition, string>> = {};
  const copies: Array<{ name: LocationPartition; source: string; target: string }> = [];
  for (const name of APP_PARTITIONS) {
    // A partition the person moved themselves stays where they put it.
    if (legacyOverrides[name]) { overrides[name] = lowercaseMangaPath(legacyOverrides[name]!, bases); continue; }
    if (name === "cache") continue;
    const source = path.join(from, name);
    if (fs.existsSync(source)) copies.push({ name, source, target: path.join(appRoot, name) });
  }
  for (const name of [...USER_PARTITIONS, "downloads"] as LocationPartition[]) {
    const source = legacyOverrides[name] ? lowercaseMangaPath(legacyOverrides[name]!, bases) : path.join(from, name);
    if (legacyOverrides[name] || fs.existsSync(source)) overrides[name] = source;
  }
  const carried = Object.keys(overrides) as LocationPartition[];
  const dataMoves = copies.some((copy) => copy.name === "data");
  // The log of a library closed uncleanly is folded in first; one that cannot be written to travels with its log.
  if (dataMoves && !checkpointClosedLibrary(path.join(from, "data"))) {
    const wal = path.join(from, "data", "manga.sqlite-wal");
    if (fs.existsSync(wal) && fs.statSync(wal).size > 0) return { ...base, state: "failed", reason: "source-busy", files: 0, bytes: 0, carried };
  }
  const bytes = copies.reduce((sum, copy) => sum + directoryStats(copy.source).bytes, 0);
  const free = freeBytes(appRoot);
  if (free !== null && free < bytes + 64 * 1024 * 1024) return { ...base, state: "failed", reason: "no-space", files: 0, bytes, carried };
  let files = 0;
  try {
    fs.mkdirSync(appRoot, { recursive: true });
    fs.writeFileSync(progressFile, `${JSON.stringify({ from, partitions: copies.map((copy) => copy.name), at: new Date().toISOString() }, null, 2)}\n`);
    for (const copy of copies) {
      for (const file of listCopyFiles(copy.source)) {
        copyOwnedFile(file.absolutePath, path.join(copy.target, file.relativePath));
        files += 1;
      }
      if (fingerprintTree(copy.source).hash !== fingerprintTree(copy.target).hash) throw new MangaError("VALIDATION_ERROR", `the copy of ${copy.name} does not match its source`, { details: { reason: "mismatch", partition: copy.name } });
      if (options.crashAt === "upgrade-copy") process.exit(99);
    }
    if (dataMoves) {
      const integrity = checkLibraryIntegrity(path.join(appRoot, "data"));
      if (integrity !== "ok") throw new MangaError("VALIDATION_ERROR", "the copied library failed its integrity check", { details: { reason: "integrity" } });
    }
    if (options.crashAt === "upgrade-pointer") process.exit(99);
    persistPointer({
      revision: legacyPointer?.revision ?? 1, channel, documentsRoot, defaultRoot: appRoot, appRoot, filesRoot: appRoot, pointerPath: options.pointerPath,
      partitions: {} as LocationLayout["partitions"], overrides, writable: true, offline: false, recovery: "none",
    });
  } catch (error) {
    for (const copy of copies) fs.rmSync(copy.target, { recursive: true, force: true });
    fs.rmSync(progressFile, { force: true });
    const reason = error instanceof MangaError ? String((error.details as { reason?: string } | undefined)?.reason ?? error.code) : String((error as NodeJS.ErrnoException).code ?? "copy-failed");
    return { ...base, state: "failed", reason, files, bytes, carried };
  }
  fs.rmSync(progressFile, { force: true });
  // An older version opening the old place follows these to the new one. When the database itself stayed (its partition was moved by the person),
  // both places are the same library and nothing is marked. Best effort: a read-only old place is still read by the new pointer's owner only.
  let marked = false;
  if (dataMoves) {
    try {
      writeRelocationMarker(from, appRoot);
      marked = pokeSchemaMeta(path.join(from, "data"), "relocatedRoot", appRoot);
    } catch {
      marked = false;
    }
  }
  return { ...base, state: "migrated", files, bytes, carried, marked };
}

export function resolveLaunchLayout(request: LaunchRequest & { crashAt?: string } = {}): LocationLayout {
  const channel = request.channel ?? defaultChannel(request.packaged);
  const testIdentity = request.testIdentity ?? (process.env.MANGA_TEST_IDENTITY === "1");
  if (channel === "test" && !request.profileRoot && !process.env.MANGA_PROFILE_ROOT) {
    throw new MangaError("LOCATION_UNAVAILABLE", "test channel requires an isolated profile root");
  }
  const documentsRoot = resolveDocumentsDir(request.documentsDir);
  const downloadsRoot = resolveDownloadsDir(request.downloadsDir);
  const localAppData = resolveLocalAppData(request.localAppDataDir);
  const bases = [documentsRoot, downloadsRoot];
  if (channel !== "test") {
    if (!testIdentity) lowercaseOnDisk(path.join(documentsRoot, "manga"));
    lowercaseOnDisk(defaultFilesRoot(documentsRoot, channel, testIdentity));
    lowercaseOnDisk(defaultDownloadsDir(downloadsRoot, channel, testIdentity));
  }
  const appRoot = defaultAppRoot(localAppData, channel, testIdentity);
  const explicitRoot = request.profileRoot ?? process.env.MANGA_PROFILE_ROOT;
  const explicitPointer = request.pointerPath ?? process.env.MANGA_POINTER_FILE;
  let pointerPath = explicitPointer ?? defaultPointerPath(localAppData, channel, testIdentity);
  // The first start after the split: an old profile and no new pointer (计划 4.9). Test identities (计划 4.8) never touch the user's real legacy location.
  let upgrade: LocationUpgradeResult | undefined;
  if (!explicitRoot && !explicitPointer && channel !== "test" && !testIdentity && !fs.existsSync(pointerPath)) {
    upgrade = upgradeLegacyLocation({ channel, documentsRoot, downloadsRoot, appRoot, pointerPath, crashAt: request.crashAt });
    // A failed move keeps the old place working for this start, through its own pointer; the next start tries again.
    if (upgrade?.state === "failed") pointerPath = upgrade.legacyPointerPath;
  }
  const pointer = readPointer(pointerPath);
  if (pointer?.redirectedTo && fs.existsSync(pointer.redirectedTo)) {
    pointerPath = path.resolve(pointer.redirectedTo);
  }
  const resolvedPointer = readPointer(pointerPath);
  let defaultRoot = explicitRoot
    ?? (resolvedPointer?.profileRoot ? lowercaseMangaPath(resolvedPointer.profileRoot, bases) : upgrade?.state === "failed" ? upgrade.from : appRoot);
  const admitted = authoritativeRoot(defaultRoot);
  defaultRoot = admitted.root;
  // The default application root splits the profile: the person's files go to the Documents folder and downloads to the Downloads folder. A root the
  // person chose (or a test's isolated root) keeps every partition under it, as before.
  const split = !explicitRoot && comparablePath(defaultRoot) === comparablePath(appRoot);
  const filesRoot = split ? defaultFilesRoot(documentsRoot, channel, testIdentity) : defaultRoot;
  const downloads = split ? defaultDownloadsDir(downloadsRoot, channel, testIdentity) : path.join(defaultRoot, "downloads");
  const overrides: Partial<Record<LocationPartition, string>> = {};
  const partitions = Object.fromEntries(LOCATION_PARTITIONS.map((name) => [
    name,
    name === "downloads" ? downloads : (USER_PARTITIONS as readonly string[]).includes(name) ? path.join(filesRoot, name) : path.join(defaultRoot, name),
  ])) as Record<LocationPartition, string>;
  for (const [name, value] of Object.entries(resolvedPointer?.partitions ?? {})) {
    if (value && (LOCATION_PARTITIONS as readonly string[]).includes(name)) {
      partitions[name as LocationPartition] = lowercaseMangaPath(value, bases);
      overrides[name as LocationPartition] = partitions[name as LocationPartition];
    }
  }
  for (const name of LOCATION_PARTITIONS) {
    const envName = `MANGA_DIR_${name.toUpperCase()}`;
    if (process.env[envName]) {
      partitions[name] = path.resolve(process.env[envName]!);
      overrides[name] = partitions[name];
    }
  }
  const probe = inspectDirectory(partitions.data);
  return {
    revision: resolvedPointer?.revision ?? 1,
    channel,
    documentsRoot,
    defaultRoot,
    appRoot: defaultRoot,
    filesRoot,
    pointerPath,
    partitions,
    overrides,
    writable: probe.writable,
    offline: probe.offline,
    recovery: probe.writable ? "none" : probe.offline ? "retry" : "choose-directory",
    ...(upgrade ? { upgrade } : {}),
  };
}

export function persistPointer(layout: LocationLayout, crash?: () => void): void {
  fs.mkdirSync(path.dirname(layout.pointerPath), { recursive: true });
  const body = `${JSON.stringify({
    profileRoot: layout.defaultRoot,
    channel: layout.channel,
    revision: layout.revision,
    partitions: Object.keys(layout.overrides).length ? layout.overrides : undefined,
  } satisfies PointerBody, null, 2)}\n`;
  const temp = `${layout.pointerPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, body);
  const fd = fs.openSync(temp, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  crash?.();
  fs.renameSync(temp, layout.pointerPath);
}

export function persistPointerAt(layout: LocationLayout, pointerPath: string): void {
  persistPointer({ ...layout, pointerPath });
}

export function isReparsePath(target: string): boolean {
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) return false;
  if (fs.lstatSync(resolved).isSymbolicLink()) return true;
  try {
    return path.resolve(fs.realpathSync.native?.(resolved) ?? fs.realpathSync(resolved)) !== resolved;
  } catch {
    return true;
  }
}

export function assertSafeMigrationTarget(sourceRoot: string, targetRoot: string): void {
  const source = path.resolve(sourceRoot);
  const target = path.resolve(targetRoot);
  if (pathsOverlap(source, target)) {
    throw new MangaError("PUBLISH_CONFLICT", "migration target overlaps the current profile");
  }
  if (isReparsePath(target) || isReparsePath(source)) {
    throw new MangaError("VALIDATION_ERROR", "migration paths cannot be reparse points or links");
  }
}

export function directoryStats(dir: string): { bytes: number; fileCount: number } {
  let bytes = 0;
  let fileCount = 0;
  const visit = (file: string) => {
    if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) visit(path.join(file, name));
    } else {
      bytes += stat.size;
      fileCount += 1;
    }
  };
  visit(dir);
  return { bytes, fileCount };
}

const SCAN_BATCH = 64;

export async function scanDirectoryBatched(
  dir: string,
  signal: AbortSignal,
  batch = SCAN_BATCH,
): Promise<{ bytes: number; fileCount: number; missing: boolean; cancelled: boolean }> {
  if (!fs.existsSync(dir)) return { bytes: 0, fileCount: 0, missing: true, cancelled: false };
  const stack = [dir];
  let bytes = 0;
  let fileCount = 0;
  let seen = 0;
  const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  while (stack.length) {
    if (signal.aborted) return { bytes, fileCount, missing: false, cancelled: true };
    const current = stack.pop()!;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      let names: string[] = [];
      try { names = fs.readdirSync(current); } catch { continue; }
      for (const name of names) stack.push(path.join(current, name));
    } else {
      bytes += stat.size;
      fileCount += 1;
    }
    seen += 1;
    if (seen % batch === 0) await yieldTurn();
  }
  return { bytes, fileCount, missing: false, cancelled: false };
}