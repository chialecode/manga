import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Reads only the named keys: from the process environment first, then from the ignored `.env.local`. Every other line of
 * that file is skipped without being kept, so a test can never see (or print) a value it did not ask for.
 */
export function readLocalEnv(keys: readonly string[]): Record<string, string> {
  const wanted = new Set(keys);
  const values: Record<string, string> = {};
  const file = path.join(root, ".env.local");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf("=");
      if (!trimmed || trimmed.startsWith("#") || eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (wanted.has(key)) values[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  }
  for (const key of keys) if (process.env[key]) values[key] = process.env[key]!;
  return values;
}
