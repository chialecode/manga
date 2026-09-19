import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

/** Read one schema_meta value without taking the write lock or running migrations. */
export function peekSchemaMeta(profileDir: string, key: string): string | undefined {
  const dbPath = path.join(profileDir, "manga.sqlite");
  if (!fs.existsSync(dbPath)) return undefined;
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = sqlite.prepare("SELECT value FROM schema_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value;
  } catch {
    return undefined;
  } finally {
    sqlite?.close();
  }
}
