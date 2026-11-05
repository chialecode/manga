import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DrizzleStore, PRODUCT_SCHEMA_VERSION, frozenImageHashes } from "@manga/storage-drizzle";
import { seedV12 } from "../helpers/legacy-v12.ts";

// AT-144 / 计划 4.4: v12 → v13 moves the pictures frozen inline in run snapshots into one copy per content. Backup first, one transaction, the hashes
// of every picture the same before and after, interrupted or failed migrations leave the library as it was, and a newer library is refused.

const tablesOf = (db: Database.Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
const snapshotsOf = (db: Database.Database) => (db.prepare("SELECT id, snapshot_json FROM agent_runs ORDER BY id").all() as Array<{ id: string; snapshot_json: string }>);

function crashChild(dir: string, crashAt: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `import { DrizzleStore } from '@manga/storage-drizzle'; new DrizzleStore({profileDir:process.env.MANGA_MIGRATION_TEST_DIR,hostId:'crash-v13',crashAt:'${crashAt}'});`], {
    env: { ...process.env, MANGA_MIGRATION_TEST_DIR: dir }, encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
}

describe("schema v13 migration (the frozen pictures of tasks, AT-144, LOOP-05)", () => {
  it("moves every inline picture to one copy per content, keeps the hashes, backs up first and does nothing on the next start", () => {
    const seeded = seedV12({ runs: 300 });
    const before = fs.statSync(path.join(seeded.data, "manga.sqlite")).size;
    const store = new DrizzleStore({ profileDir: seeded.data, hostId: "migrate-v13" });
    try {
      expect(PRODUCT_SCHEMA_VERSION).toBe(13);
      expect(store.getMeta("schemaVersion")).toBe("13");
      expect(store.migration?.from).toBe(12);
      expect(store.migration?.agentMedia).toMatchObject({ runs: 300, images: seeded.images, unique: seeded.unique });
      // The same pictures, byte for byte, as many times as the runs refer to them.
      expect(frozenImageHashes(store.sqlite)).toEqual(seeded.hashes);
      expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_media").get()).toEqual({ n: seeded.unique });
      expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_run_media").get()).toEqual({ n: seeded.images });
      for (const row of snapshotsOf(store.sqlite)) {
        expect(row.snapshot_json).not.toContain("\"base64\"");
        const images = (JSON.parse(row.snapshot_json) as { media: { images: Array<{ hash: string; origin: unknown; width: number }> } }).media.images;
        for (const image of images) { expect(image.hash).toMatch(/^[0-9a-f]{64}$/); expect(image.origin).toBeTruthy(); expect(image.width).toBe(640); }
      }
      // Nothing is let go for age by the migration itself, the running one included.
      expect(store.sqlite.prepare("SELECT COUNT(DISTINCT run_id) AS n FROM agent_run_media").get()).toEqual({ n: 300 });
      // The call record gained its delivery column.
      expect((store.sqlite.prepare("PRAGMA table_info(agent_requests)").all() as Array<{ name: string }>).map((column) => column.name)).toContain("delivery_json");
      store.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      store.close();
    }
    // The backup is the v12 library as it was, with its pictures inline.
    const backup = path.join(seeded.data, "manga.sqlite.premigrate-v12");
    expect(fs.existsSync(backup)).toBe(true);
    const old = new Database(backup, { readonly: true });
    expect(old.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "12" });
    expect(frozenImageHashes(old)).toEqual(seeded.hashes);
    old.close();
    const after = fs.statSync(path.join(seeded.data, "manga.sqlite")).size;
    // Shared pictures are kept once and the base64 text is gone, so the library is smaller (the report records both sizes).
    expect(after).toBeLessThan(before);

    const reopened = new DrizzleStore({ profileDir: seeded.data, hostId: "again-v13" });
    try {
      expect(reopened.migration).toBeNull();
      expect(frozenImageHashes(reopened.sqlite)).toEqual(seeded.hashes);
    } finally {
      reopened.close();
    }
    // (Opening the backup above made its -wal and -shm files; the backups themselves are one file.)
    expect(fs.readdirSync(seeded.data).filter((name) => name.includes("premigrate") && !/-(wal|shm)$/.test(name))).toEqual(["manga.sqlite.premigrate-v12"]);
  });

  it("is interrupted after the first batch: the library is still v12 with its pictures inline, and the next start finishes", () => {
    const seeded = seedV12({ runs: 120 });
    const child = crashChild(seeded.data, "agent-media-batch");
    expect(child.status, child.stderr).toBe(99);
    const half = new Database(path.join(seeded.data, "manga.sqlite"));
    expect(half.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "12" });
    expect(tablesOf(half)).not.toContain("agent_media");
    expect(frozenImageHashes(half)).toEqual(seeded.hashes);
    expect(snapshotsOf(half).every((row) => row.snapshot_json.includes("\"base64\""))).toBe(true);
    half.close();
    const retried = new DrizzleStore({ profileDir: seeded.data, hostId: "retry-v13" });
    try {
      expect(retried.getMeta("schemaVersion")).toBe("13");
      expect(frozenImageHashes(retried.sqlite)).toEqual(seeded.hashes);
    } finally {
      retried.close();
    }
  });

  it("fails without changing anything when a write is refused, and opens normally once the cause is gone", () => {
    const seeded = seedV12({ runs: 30 });
    const db = new Database(path.join(seeded.data, "manga.sqlite"));
    db.exec("CREATE TRIGGER refuse_snapshot BEFORE UPDATE OF snapshot_json ON agent_runs BEGIN SELECT RAISE(ABORT, 'the disk said no'); END;");
    const original = snapshotsOf(db);
    db.close();
    expect(() => new DrizzleStore({ profileDir: seeded.data, hostId: "fail-v13" })).toThrow(/the disk said no/);
    const after = new Database(path.join(seeded.data, "manga.sqlite"));
    expect(after.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "12" });
    expect(tablesOf(after)).not.toContain("agent_media");
    expect(snapshotsOf(after)).toEqual(original);
    after.exec("DROP TRIGGER refuse_snapshot");
    after.close();
    const fixed = new DrizzleStore({ profileDir: seeded.data, hostId: "fixed-v13" });
    try {
      expect(fixed.getMeta("schemaVersion")).toBe("13");
      expect(frozenImageHashes(fixed.sqlite)).toEqual(seeded.hashes);
    } finally {
      fixed.close();
    }
  });

  it("an application older than the library refuses to open it", () => {
    const seeded = seedV12({ runs: 3 });
    new DrizzleStore({ profileDir: seeded.data, hostId: "first" }).close();
    const db = new Database(path.join(seeded.data, "manga.sqlite"));
    // What a v12 build sees: a library newer than it knows (the same rule refuses v14 here).
    db.prepare("UPDATE schema_meta SET value = ? WHERE key = 'schemaVersion'").run(String(PRODUCT_SCHEMA_VERSION + 1));
    db.close();
    expect(() => new DrizzleStore({ profileDir: seeded.data, hostId: "older" })).toThrow(/newer than this application/);
  });
});
