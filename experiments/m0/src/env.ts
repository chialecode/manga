import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const M0_DATA_ROOT = process.env.MANGA_M0_DIR
  ?? path.join(os.tmpdir(), "manga-m0");

export function isolateDir(name: string): string {
  const dir = path.join(M0_DATA_ROOT, name, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
}

export function evidenceDir(): string {
  return path.join(repoRoot(), "docs/evidence/m0");
}

export function fixturesDir(): string {
  return path.join(M0_DATA_ROOT, "fixtures");
}
