import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { MangaError } from "@manga/contracts";
import { sha256File } from "../shared/utils.ts";

const HASH_CHUNK_BYTES = 1024 * 1024;
const COPY_BUFFER = Buffer.allocUnsafe(HASH_CHUNK_BYTES);

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
  return JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs), hash: sha256File(file) });
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
  const hash = createHash("sha256");
  const readFd = fs.openSync(sourceFile, "r");
  let writeFd = -1;
  try {
    writeFd = fs.openSync(targetFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
    for (;;) {
      const read = fs.readSync(readFd, COPY_BUFFER, 0, COPY_BUFFER.length, null);
      if (read === 0) break;
      hash.update(COPY_BUFFER.subarray(0, read));
      let offset = 0;
      while (offset < read) offset += fs.writeSync(writeFd, COPY_BUFFER, offset, read - offset);
    }
    fs.fsyncSync(writeFd);
    const stat = fs.fstatSync(writeFd, { bigint: true });
    return JSON.stringify({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs), hash: hash.digest("hex") });
  } catch (error) {
    if (writeFd >= 0) {
      try { fs.closeSync(writeFd); } catch { /* ignore */ }
      writeFd = -1;
      try { fs.unlinkSync(targetFile); } catch { /* ignore */ }
    }
    throw error;
  } finally {
    if (writeFd >= 0) fs.closeSync(writeFd);
    fs.closeSync(readFd);
  }
}

export function fingerprintTree(dir: string): { bytes: number; hash: string } {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
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
      const fd = fs.openSync(file, "r");
      try {
        for (;;) {
          const read = fs.readSync(fd, buffer, 0, buffer.length, null);
          if (read === 0) break;
          hash.update(buffer.subarray(0, read));
        }
      } finally {
        fs.closeSync(fd);
      }
      bytes += stat.size;
    }
  };
  if (fs.existsSync(dir)) visit(".");
  return { bytes, hash: hash.digest("hex") };
}
