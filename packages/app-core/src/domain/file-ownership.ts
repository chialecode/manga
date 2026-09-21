import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { MangaError } from "@manga/contracts";

export function comparablePath(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function pathsOverlap(left: string, right: string): boolean {
  const a = comparablePath(left);
  const b = comparablePath(right);
  if (a === b) return true;
  const prefix = (parent: string, child: string) => child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  return prefix(a, b) || prefix(b, a);
}

/** An equal body alone is not ownership: a user may have replaced the file after a crash. */
export function ownedFileFingerprint(file: string): string {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) throw new MangaError("VALIDATION_ERROR", "owned output is no longer a regular file");
  return JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs), hash: createHash("sha256").update(fs.readFileSync(file)).digest("hex") });
}

/** Host-local files that must never travel with a partition copy. */
export function isTransientPartitionFile(name: string): boolean {
  return name === "WRITE_LOCK.json" || name === ".WRITE_LOCK.guard" || name.startsWith(".manga-write-")
    || name.endsWith(".sqlite-wal") || name.endsWith(".sqlite-shm");
}

export function listCopyFiles(source: string): Array<{ relativePath: string; absolutePath: string }> {
  const files: Array<{ relativePath: string; absolutePath: string }> = [];
  const visit = (relative: string) => {
    const file = path.join(source, relative);
    if (!fs.existsSync(file)) return;
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new MangaError("VALIDATION_ERROR", "partition copy cannot follow links");
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) {
        if (!isTransientPartitionFile(name)) visit(path.join(relative, name));
      }
    } else {
      files.push({ relativePath: relative.replaceAll("\\", "/"), absolutePath: file });
    }
  };
  visit(".");
  return files.filter((item) => item.relativePath !== ".");
}

export function copyOwnedFile(sourceFile: string, targetFile: string): string {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.copyFileSync(sourceFile, targetFile, fs.constants.COPYFILE_EXCL);
  const fd = fs.openSync(targetFile, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return ownedFileFingerprint(targetFile);
}

export function fingerprintTree(dir: string): { bytes: number; hash: string } {
  const hash = createHash("sha256");
  let bytes = 0;
  const visit = (relative: string) => {
    const file = path.join(dir, relative);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) {
        if (!isTransientPartitionFile(name)) visit(path.join(relative, name));
      }
    } else {
      hash.update(relative.replaceAll("\\", "/"));
      hash.update(fs.readFileSync(file));
      bytes += stat.size;
    }
  };
  if (fs.existsSync(dir)) visit(".");
  return { bytes, hash: hash.digest("hex") };
}
