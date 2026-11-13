import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HASH_CHUNK_BYTES = 1024 * 1024;

/** Human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Escapes `%`, `_`, and `\` for SQLite `LIKE ... ESCAPE '\'` clauses. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Atomically writes text or binary data to `filePath` via a unique sibling `.tmp` file and rename.
 * Removes the temporary file if writing or renaming fails.
 */
export function writeFileAtomic(filePath: string, data: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const staging = `${filePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(staging, data);
    fs.renameSync(staging, filePath);
  } catch (error) {
    try { fs.rmSync(staging, { force: true }); } catch { /* ignore cleanup error */ }
    throw error;
  }
}

function hashFileChunked(filePath: string, algorithm: "sha256" | "sha512", encoding: "hex" | "base64"): string {
  const hash = createHash(algorithm);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest(encoding);
}

/** Computes a file's lowercase hex SHA-256 in fixed 1 MiB chunks (safe for files > 2 GiB). */
export function sha256File(filePath: string): string {
  return hashFileChunked(filePath, "sha256", "hex");
}

/** Computes a file's SHA-512 digest in fixed 1 MiB chunks (hex or base64). */
export function sha512File(filePath: string, encoding: "hex" | "base64" = "hex"): string {
  return hashFileChunked(filePath, "sha512", encoding);
}

/**
 * Walks up from a directory, file path, or `file://` URL to locate the workspace root containing `pnpm-workspace.yaml`.
 */
export function findWorkspaceRoot(fromUrlOrDir: string): string | null {
  let start = fromUrlOrDir;
  if (start.startsWith("file://")) {
    try { start = fileURLToPath(start); } catch { return null; }
  }
  let dir = path.resolve(start);
  try {
    if (fs.existsSync(dir) && fs.statSync(dir).isFile()) dir = path.dirname(dir);
  } catch {
    // keep dir as resolved
  }
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
