import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DrizzleStore, PRODUCT_SCHEMA_VERSION } from "@manga/storage-drizzle";
import { makeLegacyProfile } from "../helpers/legacy-db.ts";

const columnsOf = (db: Database.Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);

describe("schema v7 migration (a v6 library, now carried on to the current version)", () => {
  it("is the version of this stage", () => {
    expect(PRODUCT_SCHEMA_VERSION).toBe(8);
  });

  it("migrates a synthetic v6 library without losing a row or an anchor, and backs it up first", () => {
    const { dir, ids } = makeLegacyProfile();
    const store = new DrizzleStore({ profileDir: dir, hostId: "migrate-v7" });
    try {
      expect(store.getMeta("schemaVersion")).toBe("8");
      expect(fs.existsSync(path.join(dir, "manga.sqlite.premigrate-v6"))).toBe(true);
      // The backup is the old schema, untouched.
      const backup = new Database(path.join(dir, "manga.sqlite.premigrate-v6"), { readonly: true });
      expect(columnsOf(backup, "works")).not.toContain("shelf_state");
      backup.close();

      const work = store.sqlite.prepare("SELECT * FROM works WHERE id = ?").get(ids.work) as Record<string, unknown>;
      expect(work).toMatchObject({ title: "旧库作品", media_kind: "novel", shelf_state: "none", cover_id: null, cover_state: "auto", last_opened_at: null, projection_json: "{}" });
      expect(work.updated_at).toBe(work.created_at);
      // A work whose resource was a comic keeps that kind.
      expect((store.sqlite.prepare("SELECT media_kind FROM works WHERE id = ?").get(ids.secondWork) as { media_kind: string }).media_kind).toBe("comic");

      expect(store.sqlite.prepare("SELECT ordinal_label, sort_key FROM resources WHERE id = ?").get(ids.resource)).toEqual({ ordinal_label: null, sort_key: "" });
      const anchor = store.sqlite.prepare("SELECT locator_json FROM anchors WHERE id = ?").get(ids.anchor) as { locator_json: string };
      expect(JSON.parse(anchor.locator_json).quote.exact).toBe("旧库里的正文，用来");
      expect(store.sqlite.prepare("SELECT percent, completion_state FROM progress WHERE resource_id = ?").get(ids.resource)).toEqual({ percent: 0, completion_state: "reading" });
      expect(store.sqlite.prepare("SELECT layout_json FROM resource_revisions WHERE id = ?").get(ids.revision)).toEqual({ layout_json: null });

      // Rows written before the stage keep their meaning under the new columns.
      expect(store.sqlite.prepare("SELECT status, attachment_id, retention, audio_state, stage FROM capture_sessions WHERE id = ?").get(ids.capture)).toEqual({ status: "saved", attachment_id: "legacy-audio.webm", retention: "discard", audio_state: "staged", stage: "recording" });
      expect(store.sqlite.prepare("SELECT namespace, link_state, subject_type FROM work_links WHERE work_id = ?").get(ids.work)).toEqual({ namespace: "", link_state: "linked", subject_type: null });
      expect(store.sqlite.prepare("SELECT detached, fetched_at FROM metadata_snapshots WHERE work_id = ?").get(ids.work)).toEqual({ detached: 0, fetched_at: null });
      expect(store.sqlite.prepare("SELECT state FROM metadata_candidates WHERE id = 'cand-legacy'").get()).toEqual({ state: "open" });

      for (const table of ["covers", "media_probes", "play_copies", "transcript_segments", "capture_drafts", "work_terms"]) {
        expect(store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
      }
      expect(store.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(store.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("creates the same schema on a fresh profile as a migrated one", () => {
    const fresh = new DrizzleStore({ profileDir: path.join(makeLegacyProfile().dir, "fresh"), hostId: "fresh" });
    const { dir } = makeLegacyProfile();
    const migrated = new DrizzleStore({ profileDir: dir, hostId: "migrated" });
    try {
      const shape = (store: DrizzleStore) => {
        const tables = (store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search_idx%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
        return Object.fromEntries(tables.map((table) => [table, columnsOf(store.sqlite, table).sort()]));
      };
      expect(shape(fresh)).toEqual(shape(migrated));
    } finally {
      fresh.close();
      migrated.close();
    }
  });

  it("retries a migration that stopped after the DDL but before the version was published", () => {
    const { dir, ids } = makeLegacyProfile();
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", "import { DrizzleStore } from '@manga/storage-drizzle'; new DrizzleStore({profileDir:process.env.MANGA_MIGRATION_TEST_DIR,hostId:'crash-test',crashAt:'migration-before-version'});"], {
      env: { ...process.env, MANGA_MIGRATION_TEST_DIR: dir }, encoding: "utf8", windowsHide: true, timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(99);
    const half = new Database(path.join(dir, "manga.sqlite"));
    // DDL and the version are one transaction, so the interrupted run left the old schema behind.
    expect(half.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "6" });
    expect(columnsOf(half, "works")).not.toContain("shelf_state");
    expect((half.prepare("SELECT name FROM sqlite_master WHERE name = 'covers'").all() as unknown[]).length).toBe(0);
    half.close();

    const retried = new DrizzleStore({ profileDir: dir, hostId: "retry" });
    try {
      expect(retried.getMeta("schemaVersion")).toBe("8");
      expect((retried.sqlite.prepare("SELECT title FROM works WHERE id = ?").get(ids.work) as { title: string }).title).toBe("旧库作品");
    } finally {
      retried.close();
    }
    // Opening again is a no-op: nothing is added twice and no second backup replaces the first.
    const again = new DrizzleStore({ profileDir: dir, hostId: "again" });
    expect(again.getMeta("schemaVersion")).toBe("8");
    again.close();
  });

  it("refuses a library from a newer version without touching it", () => {
    const { dir } = makeLegacyProfile();
    const db = new Database(path.join(dir, "manga.sqlite"));
    db.prepare("UPDATE schema_meta SET value = '99' WHERE key = 'schemaVersion'").run();
    db.close();
    expect(() => new DrizzleStore({ profileDir: dir, hostId: "newer" })).toThrow(/newer than this application/);
    const check = new Database(path.join(dir, "manga.sqlite"));
    expect(check.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "99" });
    check.close();
  });
});
