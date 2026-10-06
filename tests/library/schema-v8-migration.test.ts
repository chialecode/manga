import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DrizzleStore, PRODUCT_SCHEMA_VERSION } from "@manga/storage-drizzle";
import { makeLegacyProfile, TINY_PNG } from "../helpers/legacy-db.ts";

const columnsOf = (db: Database.Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
const NEW_TABLES = ["library_paths", "library_files", "scan_jobs", "images", "subject_characters", "subject_persons", "quick_tasks", "operation_log"];

describe("schema v8 migration (A-50, A-51, A-52)", () => {
  it("adds only: a synthetic v7 library keeps every row, imports whole cover files into the image table and leaves the rest as references", () => {
    const { dir, ids } = makeLegacyProfile(7);
    const store = new DrizzleStore({ profileDir: dir, hostId: "migrate-v8" });
    try {
      expect(PRODUCT_SCHEMA_VERSION).toBe(8);
      expect(store.getMeta("schemaVersion")).toBe("8");
      expect(fs.existsSync(path.join(dir, "manga.sqlite.premigrate-v7"))).toBe(true);
      // The backup is the v7 schema, untouched.
      const backup = new Database(path.join(dir, "manga.sqlite.premigrate-v7"), { readonly: true });
      expect((backup.prepare("SELECT name FROM sqlite_master WHERE name = 'images'").all() as unknown[]).length).toBe(0);
      expect(columnsOf(backup, "covers")).not.toContain("image_hash");
      backup.close();

      for (const table of NEW_TABLES) expect(store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toBeTruthy();
      expect(store.sqlite.prepare("SELECT title, cover_id, cover_state FROM works WHERE id = ?").get(ids.work)).toEqual({ title: "旧库作品", cover_id: "cov-whole", cover_state: "user" });
      expect(store.sqlite.prepare("SELECT locator_json FROM anchors WHERE id = ?").get(ids.anchor)).toBeTruthy();

      const hash = createHash("sha256").update(TINY_PNG).digest("hex");
      const covers = Object.fromEntries((store.sqlite.prepare("SELECT id, area, image_hash, file_name FROM covers ORDER BY id").all() as Array<{ id: string; area: string; image_hash: string | null; file_name: string }>).map((row) => [row.id, row]));
      // The whole file was imported and checked against the hash recorded when it was saved.
      expect(covers["cov-whole"]).toMatchObject({ area: "images", image_hash: hash });
      const image = store.sqlite.prepare("SELECT hash, media_type, bytes, payload FROM images WHERE hash = ?").get(hash) as { hash: string; media_type: string; bytes: number; payload: Buffer };
      expect(image.media_type).toBe("image/png");
      expect(image.bytes).toBe(TINY_PNG.length);
      expect(Buffer.compare(image.payload, TINY_PNG)).toBe(0);
      // A file that went missing, or whose bytes no longer match, is not imported wrongly: the row still points at its file.
      expect(covers["cov-missing"]).toMatchObject({ area: "attachments", image_hash: null });
      expect(covers["cov-changed"]).toMatchObject({ area: "attachments", image_hash: null });
      // A cache cover is rebuilt from the book, so it is never imported.
      expect(covers["cov-cache"]).toMatchObject({ area: "cache", image_hash: null });
      expect((store.sqlite.prepare("SELECT COUNT(*) AS n FROM images").get() as { n: number }).n).toBe(1);
      // The original attachment file is left where it was.
      expect(fs.existsSync(path.join(dir, "attachments", `cover-${hash.slice(0, 40)}.png`))).toBe(true);

      expect(columnsOf(store.sqlite, "agent_runs")).toEqual(expect.arrayContaining(["model_id", "input_tokens", "output_tokens", "duration_ms"]));
      expect(columnsOf(store.sqlite, "content_objects")).toContain("work_id");
      expect(store.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      store.close();
    }
  });

  it("goes from v6 to v8 in one run with one backup, and a v6 note is tied to its work", () => {
    const { dir, ids } = makeLegacyProfile(6);
    const db = new Database(path.join(dir, "manga.sqlite"));
    db.prepare("INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, tags_json, attachment_ids_json, preview_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("note-legacy", "notes.document", "manga.notes", JSON.stringify({ kind: "library", resourceId: ids.resource }), 1, 1, "旧笔记", '{"blocks":[]}', "[]", "[]", "{}", "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    db.close();
    const store = new DrizzleStore({ profileDir: dir, hostId: "migrate-v6-v8" });
    try {
      expect(store.getMeta("schemaVersion")).toBe("8");
      const backups = fs.readdirSync(dir).filter((name) => name.includes("premigrate"));
      expect(backups).toEqual(["manga.sqlite.premigrate-v6"]);
      expect(store.sqlite.prepare("SELECT work_id FROM content_objects WHERE id = 'note-legacy'").get()).toEqual({ work_id: ids.work });
      expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM images").get()).toEqual({ n: 0 });
    } finally {
      store.close();
    }
  });

  it("creates the same schema on a fresh profile as on a migrated v7 profile", () => {
    const fresh = new DrizzleStore({ profileDir: path.join(makeLegacyProfile(7).dir, "fresh"), hostId: "fresh-v8" });
    const migrated = new DrizzleStore({ profileDir: makeLegacyProfile(7).dir, hostId: "migrated-v8" });
    try {
      const shape = (store: DrizzleStore) => {
        const tables = (store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search_idx%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
        return Object.fromEntries(tables.map((table) => [table, columnsOf(store.sqlite, table).sort()]));
      };
      expect(shape(fresh)).toEqual(shape(migrated));
      for (const table of NEW_TABLES) expect(Object.keys(shape(fresh))).toContain(table);
    } finally {
      fresh.close();
      migrated.close();
    }
  });

  it("indexes the lookups a large scan repeats for every file, on a fresh profile and on a migrated v7 one", () => {
    const fresh = new DrizzleStore({ profileDir: path.join(makeLegacyProfile(7).dir, "fresh-index"), hostId: "fresh-v8-index" });
    const migrated = new DrizzleStore({ profileDir: makeLegacyProfile(7).dir, hostId: "migrated-v8-index" });
    try {
      for (const store of [fresh, migrated]) {
        const names = (store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((row) => row.name);
        expect(names).toEqual(expect.arrayContaining(["resource_revisions_resource", "file_locations_revision"]));
        // The latest revision of a resource and the file of a revision are answered from the index, not by reading the table.
        const plan = (sql: string) => (store.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all("x") as Array<{ detail: string }>).map((row) => row.detail).join(" | ");
        expect(plan("SELECT id FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC LIMIT 1")).toContain("resource_revisions_resource");
        expect(plan("SELECT relative_path FROM file_locations WHERE resource_revision_id = ?")).toContain("file_locations_revision");
      }
    } finally {
      fresh.close();
      migrated.close();
    }
  });

  it("retries a v7 migration that stopped before the version was published, and does not take a second backup", () => {
    const { dir } = makeLegacyProfile(7);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", "import { DrizzleStore } from '@manga/storage-drizzle'; new DrizzleStore({profileDir:process.env.MANGA_MIGRATION_TEST_DIR,hostId:'crash-test-v8',crashAt:'migration-before-version'});"], {
      env: { ...process.env, MANGA_MIGRATION_TEST_DIR: dir }, encoding: "utf8", windowsHide: true, timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(99);
    const half = new Database(path.join(dir, "manga.sqlite"));
    expect(half.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "7" });
    expect((half.prepare("SELECT name FROM sqlite_master WHERE name = 'images'").all() as unknown[]).length).toBe(0);
    expect(half.prepare("SELECT area FROM covers WHERE id = 'cov-whole'").get()).toEqual({ area: "attachments" });
    half.close();
    const retried = new DrizzleStore({ profileDir: dir, hostId: "retry-v8" });
    try {
      expect(retried.getMeta("schemaVersion")).toBe("8");
      expect(retried.sqlite.prepare("SELECT area FROM covers WHERE id = 'cov-whole'").get()).toEqual({ area: "images" });
    } finally {
      retried.close();
    }
    expect(fs.readdirSync(dir).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v7"]);
  });
});
