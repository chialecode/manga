import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_SCHEMA_VERSION, MangaError } from "@manga/contracts";
import { DrizzleStore, PRODUCT_SCHEMA_VERSION } from "@manga/storage-drizzle";
import { testTempRoot } from "../helpers/global-temp.ts";

/** Schema v17 (计划 4.2/4.8): provider accounts, the account and provider model of a connection, and the usage of the provider's services. */

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(testTempRoot(), `v17-${prefix}-`));
  dirs.push(dir);
  return dir;
}
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const columnsOf = (db: Database.Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
const tablesOf = (db: Database.Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);

/** A v16 profile: two connections added by hand (one with an empty adapter, as very old rows have), their credential, and nothing of v17. */
function seedV16(dir: string): void {
  new DrizzleStore({ profileDir: dir, hostId: "seed-v17-bootstrap" }).close();
  for (const name of fs.readdirSync(dir)) if (name.includes(".premigrate-")) fs.rmSync(path.join(dir, name), { force: true });
  const db = new Database(path.join(dir, "manga.sqlite"));
  try {
    db.exec(`
      DROP INDEX IF EXISTS provider_connections_account;
      DROP INDEX IF EXISTS service_usage_created;
      DROP TABLE IF EXISTS provider_accounts;
      DROP TABLE IF EXISTS service_usage;
      ALTER TABLE provider_connections DROP COLUMN account_id;
      ALTER TABLE provider_connections DROP COLUMN provider_model;
    `);
    const now = "2026-11-01T08:00:00.000Z";
    db.prepare("INSERT INTO credentials(ref, ciphertext, created_at) VALUES (?,?,?)").run("cred_hand", Buffer.from("synthetic-ciphertext"), now);
    const insert = db.prepare("INSERT INTO provider_connections(id,label,adapter_id,protocol,runtime,base_url,credential_ref,timeout_ms,purpose,model_id,verified_capabilities_json,profile_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insert.run("conn_text", "手动文本", "openai-http", "openai-chat-completions", "native", "https://api.example.invalid/v1", "cred_hand", 120000, "text", "m-text", "[]", "{}", now);
    insert.run("conn_old", "早期连接", "", "openai-responses", "native", "https://api.example.invalid/v1", "cred_hand", 60000, "embedding", "m-embed", "[]", null, now);
    db.prepare("UPDATE schema_meta SET value = '16' WHERE key = 'schemaVersion'").run();
  } finally {
    db.close();
  }
}

describe("schema v17 migration", () => {
  it("keeps PRODUCT_SCHEMA_VERSION and BUILD_SCHEMA_VERSION at 17", () => {
    expect(PRODUCT_SCHEMA_VERSION).toBe(17);
    expect(BUILD_SCHEMA_VERSION).toBe(17);
  });

  it("backs up v16, adds the account columns and tables without losing a connection or its key, and does nothing the second time", () => {
    const dir = tempDir("migrate");
    seedV16(dir);
    const store = new DrizzleStore({ profileDir: dir, hostId: "open-v17" });
    try {
      expect(store.migration).toMatchObject({ from: 16, to: 17 });
      const backup = new Database(path.join(dir, "manga.sqlite.premigrate-v16"), { readonly: true });
      try {
        expect((backup.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("16");
        expect(columnsOf(backup, "provider_connections")).not.toContain("account_id");
        expect(backup.prepare("SELECT COUNT(*) AS n FROM provider_connections").get()).toEqual({ n: 2 });
      } finally {
        backup.close();
      }
      expect(tablesOf(store.sqlite)).toEqual(expect.arrayContaining(["provider_accounts", "service_usage"]));
      expect(columnsOf(store.sqlite, "provider_connections")).toEqual(expect.arrayContaining(["account_id", "provider_model"]));
      const rows = store.sqlite.prepare("SELECT id, adapter_id, credential_ref, account_id, provider_model, model_id FROM provider_connections ORDER BY id").all();
      expect(rows).toEqual([
        { id: "conn_old", adapter_id: "openai-http", credential_ref: "cred_hand", account_id: null, provider_model: null, model_id: "m-embed" },
        { id: "conn_text", adapter_id: "openai-http", credential_ref: "cred_hand", account_id: null, provider_model: null, model_id: "m-text" },
      ]);
      expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM credentials").get()).toEqual({ n: 1 });
      expect(store.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      store.close();
    }
    const again = new DrizzleStore({ profileDir: dir, hostId: "reopen-v17" });
    try {
      expect(again.migration).toBeNull();
      expect(again.getMeta("schemaVersion")).toBe("17");
    } finally {
      again.close();
    }
  });

  it("is left at v16 when interrupted before the version is published, and completes on the next start", () => {
    const dir = tempDir("crash");
    seedV16(dir);
    const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", "import { DrizzleStore } from '@manga/storage-drizzle'; new DrizzleStore({ profileDir: process.env.MANGA_MIGRATION_TEST_DIR, hostId: 'crash-v17', crashAt: 'migration-before-version' });"], {
      env: { ...process.env, MANGA_MIGRATION_TEST_DIR: dir }, encoding: "utf8", windowsHide: true, timeout: 60_000,
    });
    expect(crashed.status, crashed.stderr).toBe(99);
    const raw = new Database(path.join(dir, "manga.sqlite"), { readonly: true });
    try {
      expect((raw.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("16");
      expect(columnsOf(raw, "provider_connections")).not.toContain("account_id");
      expect(tablesOf(raw)).not.toContain("provider_accounts");
    } finally {
      raw.close();
    }
    const recovered = new DrizzleStore({ profileDir: dir, hostId: "recover-v17" });
    try {
      expect(recovered.getMeta("schemaVersion")).toBe("17");
      expect(recovered.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_connections").get()).toEqual({ n: 2 });
    } finally {
      recovered.close();
    }
  });

  it("matches a fresh profile's shape, and is refused by an application that knows only v16", () => {
    const dir = tempDir("shape");
    seedV16(dir);
    const migrated = new DrizzleStore({ profileDir: dir, hostId: "migrated-v17" });
    const fresh = new DrizzleStore({ profileDir: tempDir("fresh"), hostId: "fresh-v17" });
    try {
      expect(tablesOf(fresh.sqlite)).toEqual(tablesOf(migrated.sqlite));
      expect([...columnsOf(fresh.sqlite, "provider_connections")].sort()).toEqual([...columnsOf(migrated.sqlite, "provider_connections")].sort());
    } finally {
      migrated.close();
      fresh.close();
    }
    // The application of the previous stage refuses a newer schema in the same way this one refuses v18.
    const future = new Database(path.join(dir, "manga.sqlite"));
    future.prepare("UPDATE schema_meta SET value = '18' WHERE key = 'schemaVersion'").run();
    future.close();
    try {
      new DrizzleStore({ profileDir: dir, hostId: "future-v18" });
      expect.unreachable("a newer schema must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(MangaError);
      expect((error as MangaError).code).toBe("API_INCOMPATIBLE");
    }
  });
});
