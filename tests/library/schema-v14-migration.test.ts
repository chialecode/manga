import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DrizzleStore, PRODUCT_SCHEMA_VERSION } from "@manga/storage-drizzle";
import { seedV12 } from "../helpers/legacy-v12.ts";

// AT-156 / 计划 4.1: v13 → v14 adds `agent_proposals` and its session-status index. Backup first, one transaction, every work, project,
// session, creative object and run preserved; interrupted or failed migrations leave the library at v13 and finish on retry; a newer schema is refused.

const tablesOf = (db: Database.Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
const indexesOf = (db: Database.Database, table: string) => (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
const columnsOf = (db: Database.Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);

function seedV13() {
  const base = seedV12({ runs: 6 });
  // Upgrade v12 to current, then strip v14 artifacts back to a clean v13 baseline with creative objects and project conversations.
  const prep = new DrizzleStore({ profileDir: base.data, hostId: "seed-v13" });
  const now = "2026-10-20T00:00:00.000Z";
  prep.sqlite.prepare("INSERT INTO projects(id, name, goal, status, created_at, updated_at) VALUES (?,?,?,?,?,?)").run("proj-v13", "项目十三", "验证迁移", "active", now, now);
  prep.sqlite.prepare("INSERT INTO agent_sessions(id, title, grant_handle, kind, target_id, mode, project_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("ses-proj-v13", "项目对话", "g", "project", "proj-v13", "creator", "proj-v13", now, now);
  prep.sqlite.prepare("INSERT INTO whiteboards(id, project_id, title, viewport_json, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run("wb-v13", "proj-v13", "旧白板", '{"x":0,"y":0,"zoom":1}', now, now);
  prep.sqlite.prepare("INSERT INTO mindmaps(id, project_id, title, theme, created_at, updated_at) VALUES (?,?,?,?,?,?)")
    .run("mm-v13", "proj-v13", "旧导图", "clean", now, now);
  prep.sqlite.prepare("INSERT INTO drafts(id, project_id, title, text, version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("dr-v13", "proj-v13", "旧文稿", "正文", 2, now, now);
  prep.sqlite.prepare("INSERT INTO rough_cuts(id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)")
    .run("rc-v13", "proj-v13", "旧粗剪", now, now);
  prep.sqlite.exec("DROP TABLE IF EXISTS agent_proposals");
  prep.sqlite.prepare("UPDATE schema_meta SET value = '13' WHERE key = 'schemaVersion'").run();
  prep.sqlite.pragma("wal_checkpoint(TRUNCATE)");
  prep.close();
  fs.rmSync(path.join(base.data, "manga.sqlite.premigrate-v12"), { force: true });
  return base;
}

const dumpV13 = (db: Database.Database) => ({
  works: db.prepare("SELECT id, title FROM works ORDER BY id").all(),
  projects: db.prepare("SELECT id, name, status FROM projects ORDER BY id").all(),
  sessions: db.prepare("SELECT id, title, kind, project_id FROM agent_sessions ORDER BY id").all(),
  boards: db.prepare("SELECT id, project_id, title FROM whiteboards ORDER BY id").all(),
  maps: db.prepare("SELECT id, project_id, title FROM mindmaps ORDER BY id").all(),
  drafts: db.prepare("SELECT id, project_id, title, version FROM drafts ORDER BY id").all(),
  cuts: db.prepare("SELECT id, project_id, title FROM rough_cuts ORDER BY id").all(),
  runs: db.prepare("SELECT COUNT(*) AS n FROM agent_runs").get(),
  media: db.prepare("SELECT COUNT(*) AS n FROM agent_media").get(),
});

function crashChild(dir: string, crashAt: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `import { DrizzleStore } from '@manga/storage-drizzle'; new DrizzleStore({profileDir:process.env.MANGA_MIGRATION_TEST_DIR,hostId:'crash-v14',crashAt:'${crashAt}'});`], {
    env: { ...process.env, MANGA_MIGRATION_TEST_DIR: dir }, encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
}

describe("schema v14 migration (agent_proposals table and index, AT-156, A-121)", () => {
  it("backs up a v13 library to premigrate-v13, creates agent_proposals and its index, preserves every row and is a no-op on second open", () => {
    const seeded = seedV13();
    const beforeDb = new Database(path.join(seeded.data, "manga.sqlite"), { readonly: true });
    const beforeDump = dumpV13(beforeDb);
    beforeDb.close();

    const store = new DrizzleStore({ profileDir: seeded.data, hostId: "migrate-v14" });
    try {
      expect(PRODUCT_SCHEMA_VERSION).toBe(15);
      expect(store.getMeta("schemaVersion")).toBe("15");
      expect(store.migration).toMatchObject({ from: 13, to: 15 });
      expect(tablesOf(store.sqlite)).toContain("agent_proposals");
      expect(columnsOf(store.sqlite, "agent_proposals")).toEqual([
        "id", "session_id", "run_id", "project_id", "kind", "command_id",
        "input_json", "preview_json", "target_json", "reason",
        "status", "result_json", "created_at", "decided_at",
      ]);
      expect(indexesOf(store.sqlite, "agent_proposals")).toContain("agent_proposals_session_status");
      expect(dumpV13(store.sqlite)).toEqual(beforeDump);
      expect(store.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(store.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      store.close();
    }

    const backup = path.join(seeded.data, "manga.sqlite.premigrate-v13");
    expect(fs.existsSync(backup)).toBe(true);
    const old = new Database(backup, { readonly: true });
    expect(old.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "13" });
    expect(tablesOf(old)).not.toContain("agent_proposals");
    expect(dumpV13(old)).toEqual(beforeDump);
    old.close();

    const again = new DrizzleStore({ profileDir: seeded.data, hostId: "again-v14" });
    try {
      expect(again.migration).toBeNull();
      expect(dumpV13(again.sqlite)).toEqual(beforeDump);
    } finally {
      again.close();
    }
    expect(fs.readdirSync(seeded.data).filter((name) => name.includes("premigrate") && !/-(wal|shm)$/.test(name))).toEqual(["manga.sqlite.premigrate-v13"]);
  });

  it("rolls back when interrupted before publishing the version, leaving v13 intact, and completes on retry", () => {
    const seeded = seedV13();
    const child = crashChild(seeded.data, "migration-before-version");
    expect(child.status, child.stderr).toBe(99);

    const half = new Database(path.join(seeded.data, "manga.sqlite"));
    expect(half.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "13" });
    expect(tablesOf(half)).not.toContain("agent_proposals");
    half.close();

    const retried = new DrizzleStore({ profileDir: seeded.data, hostId: "retry-v14" });
    try {
      expect(retried.getMeta("schemaVersion")).toBe("15");
      expect(tablesOf(retried.sqlite)).toContain("agent_proposals");
      expect(indexesOf(retried.sqlite, "agent_proposals")).toContain("agent_proposals_session_status");
    } finally {
      retried.close();
    }
  });

  it("rolls back when a write fails during migration, and completes once the failure cause is removed", () => {
    const seeded = seedV13();
    const db = new Database(path.join(seeded.data, "manga.sqlite"));
    const beforeDump = dumpV13(db);
    db.exec("CREATE TRIGGER refuse_v14 BEFORE UPDATE OF value ON schema_meta WHEN NEW.key = 'schemaVersion' AND NEW.value = '15' BEGIN SELECT RAISE(ABORT, 'v14 write refused'); END;");
    db.close();

    expect(() => new DrizzleStore({ profileDir: seeded.data, hostId: "fail-v14" })).toThrow(/v14 write refused/);

    const after = new Database(path.join(seeded.data, "manga.sqlite"));
    expect(after.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "13" });
    expect(tablesOf(after)).not.toContain("agent_proposals");
    expect(dumpV13(after)).toEqual(beforeDump);
    after.exec("DROP TRIGGER refuse_v14");
    after.close();

    const fixed = new DrizzleStore({ profileDir: seeded.data, hostId: "fixed-v14" });
    try {
      expect(fixed.getMeta("schemaVersion")).toBe("15");
      expect(tablesOf(fixed.sqlite)).toContain("agent_proposals");
      expect(dumpV13(fixed.sqlite)).toEqual(beforeDump);
    } finally {
      fixed.close();
    }
  });

  it("goes back by restoring premigrate-v13 and migrates again cleanly, and refuses a library newer than v14", () => {
    const seeded = seedV13();
    const first = new DrizzleStore({ profileDir: seeded.data, hostId: "first-v14" });
    const once = dumpV13(first.sqlite);
    first.close();

    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(seeded.data, `manga.sqlite${suffix}`), { force: true });
    fs.copyFileSync(path.join(seeded.data, "manga.sqlite.premigrate-v13"), path.join(seeded.data, "manga.sqlite"));
    fs.rmSync(path.join(seeded.data, "manga.sqlite.premigrate-v13"));

    const restored = new DrizzleStore({ profileDir: seeded.data, hostId: "restored-v14" });
    try {
      expect(restored.migration).toMatchObject({ from: 13, to: 15 });
      expect(dumpV13(restored.sqlite)).toEqual(once);
    } finally {
      restored.close();
    }

    const db = new Database(path.join(seeded.data, "manga.sqlite"));
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schemaVersion'").run(String(PRODUCT_SCHEMA_VERSION + 1));
    db.close();
    expect(() => new DrizzleStore({ profileDir: seeded.data, hostId: "newer-than-v14" })).toThrow(/newer than this application/);

    const freshDir = fs.mkdtempSync(path.join(process.env.MANGA_TEST_TMP_ROOT ?? os.tmpdir(), "manga-v14-fresh-"));
    const fresh = new DrizzleStore({ profileDir: freshDir, hostId: "fresh-v14" });
    try {
      expect(fresh.getMeta("schemaVersion")).toBe("15");
      expect(tablesOf(fresh.sqlite)).toContain("agent_proposals");
    } finally {
      fresh.close();
      fs.rmSync(freshDir, { recursive: true, force: true });
    }
  });
});
