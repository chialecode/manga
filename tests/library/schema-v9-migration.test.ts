import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DrizzleStore, PRODUCT_SCHEMA_VERSION } from "@manga/storage-drizzle";
import { makeLegacyProfile } from "../helpers/legacy-db.ts";

const columnsOf = (db: Database.Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
const CREATIVE_TABLES = [
  "projects", "project_materials", "project_terms", "dictionary_terms", "whiteboards", "whiteboard_nodes", "whiteboard_edges", "mindmaps", "mindmap_nodes",
  "creative_ops", "embeds", "drafts", "draft_versions", "draft_suggestions", "excerpt_pages", "excerpts", "rough_cuts", "rough_cut_clips", "rough_cut_exports",
];

function seedV8(dir: string, ids: Record<string, string>) {
  const db = new Database(path.join(dir, "manga.sqlite"));
  const now = "2026-09-10T00:00:00.000Z";
  db.prepare("INSERT INTO work_terms(id, work_id, term, heard, created_at) VALUES (?,?,?,?,?)").run("term-1", ids.work, "綾波レイ", "あやなみ", now);
  db.prepare("INSERT INTO work_terms(id, work_id, term, heard, created_at) VALUES (?,?,?,?,?)").run("term-2", ids.work, "碇シンジ", null, now);
  db.prepare("INSERT INTO agent_sessions(id, title, grant_handle, kind, target_id, mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run("ses-old-1", "旧对话一", "g", "shared", null, "enthusiast", now, "2026-09-11T00:00:00.000Z");
  db.prepare("INSERT INTO agent_sessions(id, title, grant_handle, kind, target_id, mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run("ses-old-2", "旧对话二", "g", "shared", null, "enthusiast", now, "2026-09-12T00:00:00.000Z");
  db.close();
}

describe("schema v9 migration (the creative workspace, the dictionary, projects)", () => {
  it("adds only: a synthetic v8 library keeps every row, work terms become manual dictionary terms, and older conversations stay as they are", () => {
    const { dir, ids } = makeLegacyProfile(8);
    seedV8(dir, ids);
    const store = new DrizzleStore({ profileDir: dir, hostId: "migrate-v9" });
    try {
      expect(PRODUCT_SCHEMA_VERSION).toBe(11);
      expect(store.getMeta("schemaVersion")).toBe("11");
      expect(fs.readdirSync(dir).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v8"]);
      // The backup is the v8 schema, untouched.
      const backup = new Database(path.join(dir, "manga.sqlite.premigrate-v8"), { readonly: true });
      expect((backup.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").all() as unknown[]).length).toBe(0);
      expect(columnsOf(backup, "agent_sessions")).not.toContain("project_id");
      backup.close();

      for (const table of CREATIVE_TABLES) expect(store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toBeTruthy();
      expect(columnsOf(store.sqlite, "agent_sessions")).toContain("project_id");
      // Nothing that was there is lost.
      expect(store.sqlite.prepare("SELECT title FROM works WHERE id = ?").get(ids.work)).toEqual({ title: "旧库作品" });
      expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM work_terms").get()).toEqual({ n: 2 });
      expect(store.sqlite.prepare("SELECT id, project_id FROM agent_sessions ORDER BY id").all()).toEqual([{ id: "ses-old-1", project_id: null }, { id: "ses-old-2", project_id: null }]);
      // The terms are now the work's manual dictionary terms, with their wording and their heard form.
      expect(store.sqlite.prepare("SELECT id, scope, work_id, term, heard, source FROM dictionary_terms ORDER BY id").all()).toEqual([
        { id: "term-1", scope: "work", work_id: ids.work, term: "綾波レイ", heard: "あやなみ", source: "manual" },
        { id: "term-2", scope: "work", work_id: ids.work, term: "碇シンジ", heard: null, source: "manual" },
      ]);
      expect(store.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      store.close();
    }
  });

  it("goes from v7 to the current schema in one run with one backup, and covers still end up in the image table", () => {
    const { dir } = makeLegacyProfile(7);
    const store = new DrizzleStore({ profileDir: dir, hostId: "migrate-v7-v9" });
    try {
      expect(store.getMeta("schemaVersion")).toBe(String(PRODUCT_SCHEMA_VERSION));
      expect(fs.readdirSync(dir).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v7"]);
      expect((store.sqlite.prepare("SELECT COUNT(*) AS n FROM images").get() as { n: number }).n).toBe(1);
      for (const table of CREATIVE_TABLES) expect(store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it("creates the same schema on a fresh profile as on a migrated v8 profile", () => {
    const fresh = new DrizzleStore({ profileDir: path.join(makeLegacyProfile(8).dir, "fresh"), hostId: "fresh-v9" });
    const migrated = new DrizzleStore({ profileDir: makeLegacyProfile(8).dir, hostId: "migrated-v9" });
    try {
      const shape = (store: DrizzleStore) => {
        const tables = (store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search_idx%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
        return Object.fromEntries(tables.map((table) => [table, columnsOf(store.sqlite, table).sort()]));
      };
      expect(shape(fresh)).toEqual(shape(migrated));
      for (const table of CREATIVE_TABLES) expect(Object.keys(shape(fresh))).toContain(table);
    } finally {
      fresh.close();
      migrated.close();
    }
  });

  it("retries a v8 migration that stopped before the version was published, and does not take a second backup", () => {
    const { dir } = makeLegacyProfile(8);
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", "import { DrizzleStore } from '@manga/storage-drizzle'; new DrizzleStore({profileDir:process.env.MANGA_MIGRATION_TEST_DIR,hostId:'crash-test-v9',crashAt:'migration-before-version'});"], {
      env: { ...process.env, MANGA_MIGRATION_TEST_DIR: dir }, encoding: "utf8", windowsHide: true, timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(99);
    const half = new Database(path.join(dir, "manga.sqlite"));
    expect(half.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "8" });
    expect((half.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").all() as unknown[]).length).toBe(0);
    half.close();
    const retried = new DrizzleStore({ profileDir: dir, hostId: "retry-v9" });
    try {
      expect(retried.getMeta("schemaVersion")).toBe(String(PRODUCT_SCHEMA_VERSION));
      expect((retried.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'projects'").all() as unknown[]).length).toBe(1);
    } finally {
      retried.close();
    }
    expect(fs.readdirSync(dir).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v8"]);
  });
});
