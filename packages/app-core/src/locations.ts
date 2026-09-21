import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { peekSchemaMeta } from "@manga/storage-drizzle";
import { comparablePath, pathsOverlap, isTransientPartitionFile } from "./domain/file-ownership.ts";
export { ownedFileFingerprint, pathsOverlap, copyOwnedFile, listCopyFiles, fingerprintTree, isTransientPartitionFile } from "./domain/file-ownership.ts";
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
  profileRoot?: string;
  pointerPath?: string;
  documentsDir?: string;
  packaged?: boolean;
};

export function resolveDocumentsDir(override?: string): string {
  if (override) return path.resolve(override);
  if (process.env.MANGA_DOCUMENTS_DIR) return path.resolve(process.env.MANGA_DOCUMENTS_DIR);
  return path.join(os.homedir(), "Documents");
}

export function defaultChannel(packaged = false): Channel {
  const env = process.env.MANGA_CHANNEL;
  if (env && (CHANNELS as readonly string[]).includes(env)) return env as Channel;
  if (process.env.NODE_ENV === "test" || process.env.MANGA_CHANNEL === "test") return "test";
  return packaged ? "release" : "development";
}

export function defaultPointerPath(documentsDir: string, channel: Channel): string {
  return path.join(documentsDir, "MANGA", channel, "launcher", "pointer.json");
}

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

export function resolveLaunchLayout(request: LaunchRequest = {}): LocationLayout {
  const channel = request.channel ?? defaultChannel(request.packaged);
  if (channel === "test" && !request.profileRoot && !process.env.MANGA_PROFILE_ROOT) {
    throw new MangaError("LOCATION_UNAVAILABLE", "test channel requires an isolated profile root");
  }
  const documentsRoot = resolveDocumentsDir(request.documentsDir);
  let pointerPath = request.pointerPath
    ?? process.env.MANGA_POINTER_FILE
    ?? defaultPointerPath(documentsRoot, channel);
  const pointer = readPointer(pointerPath);
  if (pointer?.redirectedTo && fs.existsSync(pointer.redirectedTo)) {
    pointerPath = path.resolve(pointer.redirectedTo);
  }
  const resolvedPointer = readPointer(pointerPath);
  let defaultRoot = request.profileRoot
    ?? process.env.MANGA_PROFILE_ROOT
    ?? (resolvedPointer?.profileRoot ? path.resolve(resolvedPointer.profileRoot) : path.join(documentsRoot, "MANGA", channel));
  const admitted = authoritativeRoot(defaultRoot);
  defaultRoot = admitted.root;
  const overrides: Partial<Record<LocationPartition, string>> = {};
  const partitions = Object.fromEntries(LOCATION_PARTITIONS.map((name) => [name, path.join(defaultRoot, name)])) as Record<LocationPartition, string>;
  for (const [name, value] of Object.entries(resolvedPointer?.partitions ?? {})) {
    if (value && (LOCATION_PARTITIONS as readonly string[]).includes(name)) {
      partitions[name as LocationPartition] = path.resolve(value);
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
    pointerPath,
    partitions,
    overrides,
    writable: probe.writable,
    offline: probe.offline,
    recovery: probe.writable ? "none" : probe.offline ? "retry" : "choose-directory",
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

export function resolvedEqual(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
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

export type OwnedCopy = {
  partition: LocationPartition;
  relativePath: string;
  absolutePath: string;
  fingerprint: string;
  state: "planned" | "copying" | "committed";
};

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

export function copyPartition(source: string, target: string): void {
  fs.mkdirSync(target, { recursive: true });
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, target, {
    recursive: true,
    errorOnExist: false,
    filter: (file) => !isTransientPartitionFile(path.basename(file)),
  });
}
