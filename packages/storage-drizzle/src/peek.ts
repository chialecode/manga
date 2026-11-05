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

/**
 * Before a library's files are copied while it is closed (the move of an old profile, 计划 4.9): fold its write-ahead log into the database so the copy
 * is whole. A library that cannot be written to (read-only media) is left as it is; the caller copies its log with it.
 */
export function checkpointClosedLibrary(profileDir: string): boolean {
  const dbPath = path.join(profileDir, "manga.sqlite");
  if (!fs.existsSync(dbPath)) return false;
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(dbPath, { fileMustExist: true });
    const result = sqlite.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
    return !result[0]?.busy;
  } catch {
    return false;
  } finally {
    sqlite?.close();
  }
}

/** SQLite's own check of a library copied while closed: "ok" or the first problem it found. */
export function checkLibraryIntegrity(profileDir: string): string {
  const dbPath = path.join(profileDir, "manga.sqlite");
  if (!fs.existsSync(dbPath)) return "missing";
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = sqlite.pragma("integrity_check") as Array<{ integrity_check: string }>;
    return rows[0]?.integrity_check ?? "unknown";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    sqlite?.close();
  }
}

/** Write one schema_meta value of a closed library (the marker an old version follows to the new place). False when it cannot be written. */
export function pokeSchemaMeta(profileDir: string, key: string, value: string): boolean {
  const dbPath = path.join(profileDir, "manga.sqlite");
  if (!fs.existsSync(dbPath)) return false;
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(dbPath, { fileMustExist: true });
    sqlite.prepare("INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    sqlite.pragma("wal_checkpoint(TRUNCATE)");
    return true;
  } catch {
    return false;
  } finally {
    sqlite?.close();
  }
}
