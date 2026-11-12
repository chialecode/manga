import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { DrizzleStore, PRODUCT_SCHEMA_VERSION } from "@manga/storage-drizzle";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `manga-${prefix}-`));
  dirs.push(dir);
  return dir;
}

function crashChild(dir: string, crashAt: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `import { DrizzleStore } from '@manga/storage-drizzle'; new DrizzleStore({profileDir:process.env.MANGA_MIGRATION_TEST_DIR,hostId:'crash-v15',crashAt:'${crashAt}'});`], {
    env: { ...process.env, MANGA_MIGRATION_TEST_DIR: dir }, encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/**
 * Build a schema-v14 library containing works, standalone resources, multi-context progress rows (including completed and partial rows),
 * projects, notes, and proposals, then strip v15 objects (`recent_dismissals`, triggers, `progress_furthest`) and set `schemaVersion = 14`.
 */
function seedV14(dir: string): void {
  const store = new DrizzleStore({ profileDir: dir });
  try {
    const now = "2026-07-01T00:00:00.000Z";
    store.sqlite.prepare("INSERT INTO projects(id, name, goal, status, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("proj_a", "项目 A", "", "active", now, now);
    store.sqlite.prepare("INSERT INTO works(id, title, media_kind, shelf_state, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("work_comic", "合成漫画", "comic", "reading", now, now);
    store.sqlite.prepare("INSERT INTO resources(id, work_id, kind, title, created_at) VALUES (?,?,?,?,?)").run("res_comic", "work_comic", "comic", "第 1 话", now);
    store.sqlite.prepare("INSERT INTO resources(id, work_id, kind, title, created_at) VALUES (?,?,?,?,?)").run("res_video", null, "video", "独立短片", now);
    store.sqlite.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)")
      .run("rev_comic", "res_comic", "fp_comic", "1", "{}", now);
    store.sqlite.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)")
      .run("rev_video", "res_video", "fp_video", "1", "{}", now);
    // Comic: 80% in "最近" (earlier), 10% in Project A (later).
    store.sqlite.prepare("INSERT INTO progress(context_id, resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at, percent) VALUES (?,?,?,?,?,?,?,?)")
      .run("", "res_comic", "rev_comic", '{"kind":"image","pageId":"p008.png"}', "[]", "reading", "2026-07-01T01:00:00.000Z", 0.8);
    store.sqlite.prepare("INSERT INTO progress(context_id, resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at, percent) VALUES (?,?,?,?,?,?,?,?)")
      .run("proj_a", "res_comic", "rev_comic", '{"kind":"image","pageId":"p001.png"}', "[]", "reading", "2026-07-01T02:00:00.000Z", 0.1);
    // Standalone video: completed at 96% in Project A, reading at 98% in "最近" -> completed anywhere wins in progress_furthest.
    store.sqlite.prepare("INSERT INTO progress(context_id, resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at, percent) VALUES (?,?,?,?,?,?,?,?)")
      .run("", "res_video", "rev_video", '{"kind":"temporal","startMs":58800}', "[]", "reading", "2026-07-01T03:00:00.000Z", 0.98);
    store.sqlite.prepare("INSERT INTO progress(context_id, resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at, percent) VALUES (?,?,?,?,?,?,?,?)")
      .run("proj_a", "res_video", "rev_video", '{"kind":"temporal","startMs":57600}', "[]", "completed", "2026-07-01T02:30:00.000Z", 0.96);
    store.sqlite.prepare("INSERT INTO agent_proposals(id, session_id, run_id, project_id, kind, command_id, input_json, preview_json, target_json, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run("prop_1", "ses_1", "run_1", "proj_a", "note_create", "notes.create", "{}", "{}", "{}", "pending", now);
    store.sqlite.exec(`
      DROP VIEW IF EXISTS progress_furthest;
      DROP TRIGGER IF EXISTS recent_dismissals_work_gone;
      DROP TRIGGER IF EXISTS recent_dismissals_resource_gone;
      DROP TABLE IF EXISTS recent_dismissals;
      UPDATE schema_meta SET value = '14' WHERE key = 'schemaVersion';
    `);
    store.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    store.close();
  }
  for (const name of fs.readdirSync(dir)) {
    if (name.includes(".premigrate-")) fs.rmSync(path.join(dir, name), { force: true });
  }
}

describe("schema v15 migration (recent_dismissals, cascade triggers, progress_furthest, A-129, AT-173)", () => {
  it("backs up v14, creates recent_dismissals, cascade triggers and progress_furthest, preserves existing data, and is idempotent", () => {
    expect(PRODUCT_SCHEMA_VERSION).toBe(15);
    const dir = tempDir("v15-migrate");
    seedV14(dir);

    const store = new DrizzleStore({ profileDir: dir });
    expect(store.migration).toMatchObject({ from: 14, to: 15 });
    expect(store.getMeta("schemaVersion")).toBe("15");
    expect(fs.existsSync(path.join(dir, "manga.sqlite.premigrate-v14"))).toBe(true);

    const backup = new Database(path.join(dir, "manga.sqlite.premigrate-v14"), { readonly: true });
    expect((backup.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("14");
    expect(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recent_dismissals'").get()).toBeUndefined();
    expect(backup.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'progress_furthest'").get()).toBeUndefined();
    backup.close();

    expect(store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recent_dismissals'").get()).toEqual({ name: "recent_dismissals" });
    expect(store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'recent_dismissals_work_gone'").get()).toEqual({ name: "recent_dismissals_work_gone" });
    expect(store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'recent_dismissals_resource_gone'").get()).toEqual({ name: "recent_dismissals_resource_gone" });
    expect(store.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'progress_furthest'").get()).toEqual({ name: "progress_furthest" });

    // Existing v14 data is intact; progress_furthest chooses furthest/completed while progress_latest still chooses newest.
    expect(store.sqlite.prepare("SELECT id FROM agent_proposals").all()).toEqual([{ id: "prop_1" }]);
    expect(store.sqlite.prepare("SELECT context_id AS contextId, percent FROM progress_furthest WHERE resource_id = 'res_comic'").get()).toEqual({ contextId: "", percent: 0.8 });
    expect(store.sqlite.prepare("SELECT context_id AS contextId, percent FROM progress_latest WHERE resource_id = 'res_comic'").get()).toEqual({ contextId: "proj_a", percent: 0.1 });
    expect(store.sqlite.prepare("SELECT context_id AS contextId, completion_state AS completion, percent FROM progress_furthest WHERE resource_id = 'res_video'").get())
      .toEqual({ contextId: "proj_a", completion: "completed", percent: 0.96 });

    // Cascade triggers clean up dismissals when a work or resource is deleted.
    store.sqlite.prepare("INSERT INTO recent_dismissals(key, dismissed_at) VALUES (?, ?), (?, ?)")
      .run("work:work_comic", "2026-07-02T00:00:00.000Z", "resource:res_video", "2026-07-02T00:00:00.000Z");
    store.sqlite.prepare("DELETE FROM works WHERE id = 'work_comic'").run();
    expect(store.sqlite.prepare("SELECT key FROM recent_dismissals ORDER BY key").all()).toEqual([{ key: "resource:res_video" }]);
    store.sqlite.prepare("DELETE FROM progress WHERE resource_id = 'res_video'").run();
    store.sqlite.prepare("DELETE FROM resource_revisions WHERE resource_id = 'res_video'").run();
    store.sqlite.prepare("DELETE FROM resources WHERE id = 'res_video'").run();
    expect(store.sqlite.prepare("SELECT key FROM recent_dismissals").all()).toEqual([]);

    expect(store.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(store.sqlite.pragma("foreign_key_check")).toEqual([]);
    store.close();

    // Opening a second time is a no-op migration.
    const again = new DrizzleStore({ profileDir: dir });
    expect(again.migration).toBeNull();
    expect(again.getMeta("schemaVersion")).toBe("15");
    again.close();
  });

  it("rolls back when interrupted before publishing the version, leaving v14 intact, and completes on retry", () => {
    const dir = tempDir("v15-crash");
    seedV14(dir);

    const crashed = crashChild(dir, "migration-before-version");
    expect(crashed.status).toBe(99);
    expect(fs.existsSync(path.join(dir, "manga.sqlite.premigrate-v14"))).toBe(true);

    const raw = new Database(path.join(dir, "manga.sqlite"), { readonly: true });
    expect((raw.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("14");
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recent_dismissals'").get()).toBeUndefined();
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'progress_furthest'").get()).toBeUndefined();
    raw.close();

    const recovered = new DrizzleStore({ profileDir: dir });
    expect(recovered.migration).toMatchObject({ from: 14, to: 15 });
    expect(recovered.getMeta("schemaVersion")).toBe("15");
    expect(recovered.sqlite.prepare("SELECT context_id AS contextId, percent FROM progress_furthest WHERE resource_id = 'res_comic'").get()).toEqual({ contextId: "", percent: 0.8 });
    expect(recovered.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    recovered.close();
  });

  it("rolls back cleanly when a write error occurs inside the migration transaction", () => {
    const dir = tempDir("v15-write-fail");
    seedV14(dir);

    const blocker = new Database(path.join(dir, "manga.sqlite"));
    blocker.exec(`
      CREATE TRIGGER fail_v15_version BEFORE UPDATE ON schema_meta
      WHEN NEW.key = 'schemaVersion' AND NEW.value = '15'
      BEGIN
        SELECT RAISE(ABORT, 'disk write failure during v15 migration');
      END;
    `);
    blocker.close();

    expect(() => new DrizzleStore({ profileDir: dir })).toThrow(/disk write failure during v15 migration/);
    expect(fs.existsSync(path.join(dir, "manga.sqlite.premigrate-v14"))).toBe(true);

    const check = new Database(path.join(dir, "manga.sqlite"));
    expect((check.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get() as { value: string }).value).toBe("14");
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recent_dismissals'").get()).toBeUndefined();
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'progress_furthest'").get()).toBeUndefined();
    check.exec("DROP TRIGGER fail_v15_version");
    check.close();

    const fixed = new DrizzleStore({ profileDir: dir });
    expect(fixed.migration).toMatchObject({ from: 14, to: 15 });
    expect(fixed.getMeta("schemaVersion")).toBe("15");
    fixed.close();
  });

  it("restores from premigrate-v14 cleanly, starts fresh DBs at v15, and refuses newer schemas", () => {
    const dir = tempDir("v15-restore");
    seedV14(dir);
    const first = new DrizzleStore({ profileDir: dir });
    first.close();

    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(dir, `manga.sqlite${suffix}`), { force: true });
    fs.copyFileSync(path.join(dir, "manga.sqlite.premigrate-v14"), path.join(dir, "manga.sqlite"));
    const remigrated = new DrizzleStore({ profileDir: dir });
    expect(remigrated.migration).toMatchObject({ from: 14, to: 15 });
    expect(remigrated.getMeta("schemaVersion")).toBe("15");
    remigrated.close();

    // Fresh database opens directly at v15 with recent_dismissals and progress_furthest ready.
    const freshDir = tempDir("v15-fresh");
    const fresh = new DrizzleStore({ profileDir: freshDir });
    expect(fresh.migration).toBeNull();
    expect(fresh.getMeta("schemaVersion")).toBe("15");
    expect(fresh.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'recent_dismissals'").get()).toEqual({ name: "recent_dismissals" });
    expect(fresh.sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'progress_furthest'").get()).toEqual({ name: "progress_furthest" });
    fresh.close();

    // Older app builds reject schemas newer than their own PRODUCT_SCHEMA_VERSION.
    const future = new Database(path.join(dir, "manga.sqlite"));
    future.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schemaVersion'").run(String(PRODUCT_SCHEMA_VERSION + 1));
    future.close();
    expect(() => new DrizzleStore({ profileDir: dir })).toThrow(/newer than this application/);
  });
});
