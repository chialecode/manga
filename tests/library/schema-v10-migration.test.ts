import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DrizzleStore, PRODUCT_SCHEMA_VERSION } from "@manga/storage-drizzle";
import { makeLegacyProfile } from "../helpers/legacy-db.ts";

const columnsOf = (db: Database.Database, table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name);
const tablesOf = (db: Database.Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
const V10_TABLES = ["file_moves", "work_folders", "work_files", "screenshots", "danmaku_matches", "danmaku_cache", "danmaku_consent", "agent_requests"];

type Seeded = { dir: string; ids: Record<string, string>; library: string; outside: string; attachments: string; hostedA: string; hostedB: string };

/** A v9 library with one file of each kind a location can be: inside a library path, kept by the application, and under no library path. */
function seedV9(): Seeded {
  const { dir, ids } = makeLegacyProfile(9);
  const library = fs.mkdtempSync(path.join(os.tmpdir(), "manga-v10-library-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "manga-v10-outside-"));
  fs.mkdirSync(path.join(library, "系列"), { recursive: true });
  fs.writeFileSync(path.join(library, "系列", "第1话.mkv"), "episode");
  const attachments = path.join(dir, "attachments");
  fs.mkdirSync(attachments, { recursive: true });
  const hostedA = path.join(attachments, "rev-hosted-a.bin");
  const hostedB = path.join(attachments, "rev-hosted-b.bin");
  fs.writeFileSync(hostedA, Buffer.alloc(3000, 1));
  fs.writeFileSync(hostedB, Buffer.alloc(5000, 2));
  const db = new Database(path.join(dir, "manga.sqlite"));
  const now = "2026-09-20T00:00:00.000Z";
  db.prepare("INSERT INTO library_paths(id, path, media_kind, auto_scan, created_at) VALUES (?,?,?,?,?)").run("lp-main", library, "video", 0, now);
  const revision = (resource: string, rev: string, kind: string) => {
    db.prepare("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?,?,?,?,?,?)").run(resource, ids.work, kind, resource, "[]", now);
    db.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(rev, resource, rev.padEnd(64, "0"), "p", "{}", now);
  };
  revision("res-in", "rev-in", "video");
  revision("res-host-a", "rev-host-a", "comic");
  revision("res-host-b", "rev-host-b", "comic");
  revision("res-out", "rev-out", "video");
  const location = db.prepare("INSERT INTO file_locations(id, resource_revision_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,?)");
  location.run("loc-in", "rev-in", path.join(library, "系列", "第1话.mkv"), "fp-in", 1, 0);
  location.run("loc-host-a", "rev-host-a", hostedA, "fp-a", 1, 1);
  location.run("loc-host-b", "rev-host-b", hostedB, "fp-b", 1, 1);
  location.run("loc-out", "rev-out", path.join(outside, "孤立的.mkv"), "fp-out", 1, 0);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  return { dir, ids, library, outside, attachments, hostedA, hostedB };
}

const rowsOf = (store: DrizzleStore) => store.sqlite.prepare("SELECT id, library_path_id AS lib, relative_path AS rel, legacy_path AS legacy, hosted, available FROM file_locations ORDER BY id").all() as Array<{ id: string; lib: string | null; rel: string; legacy: string | null; hosted: number; available: number }>;

function crashChild(dir: string, crashAt: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `import { DrizzleStore } from '@manga/storage-drizzle'; new DrizzleStore({profileDir:process.env.MANGA_MIGRATION_TEST_DIR,hostId:'crash-v10',crashAt:'${crashAt}'});`], {
    env: { ...process.env, MANGA_MIGRATION_TEST_DIR: dir }, encoding: "utf8", windowsHide: true, timeout: 30_000,
  });
}

describe("schema v10 migration (a file location is a library path and a path inside it, A-80)", () => {
  it("turns every location into a library path plus a relative path, keeps the application's own copies, and leaves files outside the library as text", () => {
    const seeded = seedV9();
    const store = new DrizzleStore({ profileDir: seeded.dir, hostId: "migrate-v10" });
    try {
      expect(PRODUCT_SCHEMA_VERSION).toBe(11);
      expect(store.getMeta("schemaVersion")).toBe("11");
      expect(store.migration).toMatchObject({ from: 9, to: 11, locations: { inLibrary: 1, managed: 2, outside: 1 } });
      expect(fs.readdirSync(seeded.dir).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v9"]);

      // The backup is the v9 library, untouched: no managed flag, locations still hold paths.
      const backup = new Database(path.join(seeded.dir, "manga.sqlite.premigrate-v9"), { readonly: true });
      expect(columnsOf(backup, "library_paths")).not.toContain("managed");
      expect(columnsOf(backup, "file_locations")).not.toContain("library_path_id");
      expect(tablesOf(backup).filter((name) => V10_TABLES.includes(name))).toEqual([]);
      expect((backup.prepare("SELECT relative_path FROM file_locations WHERE id = 'loc-in'").get() as { relative_path: string }).relative_path).toBe(path.join(seeded.library, "系列", "第1话.mkv"));
      backup.close();

      const managed = store.sqlite.prepare("SELECT id, path, media_kind, auto_scan FROM library_paths WHERE managed = 1").get() as { id: string; path: string; auto_scan: number };
      expect(managed.path).toBe(store.managedLibraryDir);
      expect(managed.auto_scan).toBe(0);
      expect(rowsOf(store)).toEqual([
        { id: "loc-host-a", lib: managed.id, rel: "rev-hosted-a.bin", legacy: seeded.hostedA, hosted: 1, available: 1 },
        { id: "loc-host-b", lib: managed.id, rel: "rev-hosted-b.bin", legacy: seeded.hostedB, hosted: 1, available: 1 },
        { id: "loc-in", lib: "lp-main", rel: "系列/第1话.mkv", legacy: null, hosted: 0, available: 1 },
        { id: "loc-out", lib: null, rel: "孤立的.mkv", legacy: path.join(seeded.outside, "孤立的.mkv"), hosted: 0, available: 1 },
      ]);
      // The copies in the application's own library path are made and checked; the originals stay where the backup expects them.
      expect(fs.readFileSync(path.join(store.managedLibraryDir, "rev-hosted-a.bin")).equals(Buffer.alloc(3000, 1))).toBe(true);
      expect(fs.readFileSync(path.join(store.managedLibraryDir, "rev-hosted-b.bin")).equals(Buffer.alloc(5000, 2))).toBe(true);
      expect(fs.existsSync(seeded.hostedA) && fs.existsSync(seeded.hostedB)).toBe(true);
      expect(store.sqlite.prepare("SELECT state, COUNT(*) AS n FROM file_moves GROUP BY state").all()).toEqual([{ state: "done", n: 2 }]);
      // Every table the change brings is there, and nothing that was there is lost.
      for (const table of V10_TABLES) expect(store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toBeTruthy();
      expect(columnsOf(store.sqlite, "provider_connections")).toEqual(expect.arrayContaining(["profile_json", "last_test_json"]));
      expect(columnsOf(store.sqlite, "capture_sessions")).toContain("audio_file_id");
      expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get()).toEqual({ n: 6 });
      expect(store.sqlite.prepare("SELECT title FROM works WHERE id = ?").get(seeded.ids.work)).toEqual({ title: "旧库作品" });
      expect(store.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      store.close();
    }
  });

  it("is a no-op the second time: no second backup, no second copy, the same rows", () => {
    const seeded = seedV9();
    const first = new DrizzleStore({ profileDir: seeded.dir, hostId: "first-v10" });
    const before = rowsOf(first);
    const stamp = fs.statSync(path.join(first.managedLibraryDir, "rev-hosted-a.bin")).mtimeMs;
    first.close();
    const again = new DrizzleStore({ profileDir: seeded.dir, hostId: "again-v10" });
    try {
      expect(again.migration).toBeNull();
      expect(rowsOf(again)).toEqual(before);
      expect(fs.statSync(path.join(again.managedLibraryDir, "rev-hosted-a.bin")).mtimeMs).toBe(stamp);
      expect(again.sqlite.prepare("SELECT COUNT(*) AS n FROM library_paths WHERE managed = 1").get()).toEqual({ n: 1 });
      expect(fs.readdirSync(seeded.dir).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v9"]);
    } finally {
      again.close();
    }
  });

  it("stops before the version is published: the library is still v9 with its old rows, and the retry finishes with one backup", () => {
    const seeded = seedV9();
    const child = crashChild(seeded.dir, "migration-before-version");
    expect(child.status, child.stderr).toBe(99);
    const half = new Database(path.join(seeded.dir, "manga.sqlite"));
    expect(half.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "9" });
    expect(columnsOf(half, "file_locations")).not.toContain("library_path_id");
    expect((half.prepare("SELECT relative_path FROM file_locations WHERE id = 'loc-in'").get() as { relative_path: string }).relative_path).toBe(path.join(seeded.library, "系列", "第1话.mkv"));
    expect(tablesOf(half).filter((name) => V10_TABLES.includes(name))).toEqual([]);
    half.close();
    // No file was copied: the copies are made only after the new schema is committed.
    const kept = path.join(seeded.dir, "resources", "library");
    expect(fs.existsSync(kept) ? fs.readdirSync(kept) : []).toEqual([]);

    const retried = new DrizzleStore({ profileDir: seeded.dir, hostId: "retry-v10" });
    try {
      expect(retried.getMeta("schemaVersion")).toBe("11");
      expect(rowsOf(retried).map((row) => row.lib === null ? "outside" : row.hosted === 1 ? "managed" : "library").sort()).toEqual(["library", "managed", "managed", "outside"]);
      expect(retried.sqlite.prepare("SELECT COUNT(*) AS n FROM library_paths WHERE managed = 1").get()).toEqual({ n: 1 });
    } finally {
      retried.close();
    }
    expect(fs.readdirSync(seeded.dir).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v9"]);
  });

  it("finishes a copy that was interrupted between two files, replaces a half-written copy, and never touches the originals", () => {
    const seeded = seedV9();
    // The process dies after the first copy: the library is already migrated and the journal says one file is still to be done.
    const child = crashChild(seeded.dir, "after-file-copy");
    expect(child.status, child.stderr).toBe(99);
    const half = new Database(path.join(seeded.dir, "manga.sqlite"));
    expect(half.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "11" });
    expect(half.prepare("SELECT state, COUNT(*) AS n FROM file_moves GROUP BY state ORDER BY state").all()).toEqual([{ state: "done", n: 1 }, { state: "pending", n: 1 }]);
    const pending = half.prepare("SELECT to_path FROM file_moves WHERE state = 'pending'").get() as { to_path: string };
    half.close();
    expect(fs.existsSync(pending.to_path)).toBe(false);
    // A leftover from a copy that never finished is not mistaken for the file.
    fs.mkdirSync(path.dirname(pending.to_path), { recursive: true });
    fs.writeFileSync(`${pending.to_path}.part`, "half");
    fs.writeFileSync(pending.to_path, "short");

    const store = new DrizzleStore({ profileDir: seeded.dir, hostId: "resume-v10" });
    try {
      expect(store.sqlite.prepare("SELECT state, COUNT(*) AS n FROM file_moves GROUP BY state").all()).toEqual([{ state: "done", n: 2 }]);
      expect(fs.readFileSync(path.join(store.managedLibraryDir, "rev-hosted-a.bin")).equals(Buffer.alloc(3000, 1))).toBe(true);
      expect(fs.readFileSync(path.join(store.managedLibraryDir, "rev-hosted-b.bin")).equals(Buffer.alloc(5000, 2))).toBe(true);
      expect(fs.readdirSync(store.managedLibraryDir).filter((name) => name.endsWith(".part"))).toEqual([]);
      expect(fs.existsSync(seeded.hostedA) && fs.existsSync(seeded.hostedB)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("keeps a copy it cannot make pending with the reason, finishes the others, and tries again at the next start", () => {
    const seeded = seedV9();
    fs.rmSync(seeded.hostedB);
    const store = new DrizzleStore({ profileDir: seeded.dir, hostId: "gone-v10" });
    try {
      expect(store.sqlite.prepare("SELECT state, error FROM file_moves ORDER BY to_path").all()).toEqual([
        { state: "done", error: null },
        { state: "pending", error: expect.stringContaining("missing") },
      ]);
      // The location itself stays: the file is simply not there, which the inventory reports as missing like any other lost file.
      expect(rowsOf(store).find((row) => row.id === "loc-host-b")).toMatchObject({ rel: "rev-hosted-b.bin", hosted: 1 });
    } finally {
      store.close();
    }
    fs.writeFileSync(seeded.hostedB, Buffer.alloc(5000, 2));
    const later = new DrizzleStore({ profileDir: seeded.dir, hostId: "later-v10" });
    try {
      expect(later.sqlite.prepare("SELECT state FROM file_moves").all()).toEqual([{ state: "done" }, { state: "done" }]);
      expect(fs.statSync(path.join(later.managedLibraryDir, "rev-hosted-b.bin")).size).toBe(5000);
    } finally {
      later.close();
    }
  });

  it("goes back by restoring the backup, and the same migration can run again from there with the same result", () => {
    const seeded = seedV9();
    const first = new DrizzleStore({ profileDir: seeded.dir, hostId: "forward-v10" });
    const forward = rowsOf(first).map((row) => ({ ...row, lib: row.lib === "lp-main" ? row.lib : row.lib === null ? null : "managed" }));
    first.close();
    // Rolling back is putting the file taken before the migration in place of the database.
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(seeded.dir, `manga.sqlite${suffix}`), { force: true });
    fs.copyFileSync(path.join(seeded.dir, "manga.sqlite.premigrate-v9"), path.join(seeded.dir, "manga.sqlite"));
    const old = new Database(path.join(seeded.dir, "manga.sqlite"), { readonly: true });
    expect(old.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "9" });
    // The files the old version used are all still where it expects them.
    expect(fs.existsSync(seeded.hostedA) && fs.existsSync(seeded.hostedB)).toBe(true);
    old.close();
    const again = new DrizzleStore({ profileDir: seeded.dir, hostId: "again-forward-v10" });
    try {
      expect(again.migration).toMatchObject({ from: 9, to: 11 });
      expect(rowsOf(again).map((row) => ({ ...row, lib: row.lib === "lp-main" ? row.lib : row.lib === null ? null : "managed" }))).toEqual(forward);
      expect(again.sqlite.prepare("SELECT COUNT(*) AS n FROM library_paths WHERE managed = 1").get()).toEqual({ n: 1 });
    } finally {
      again.close();
    }
  });

  it("refuses a library from a newer version instead of reading it", () => {
    const seeded = seedV9();
    const db = new Database(path.join(seeded.dir, "manga.sqlite"));
    db.prepare("UPDATE schema_meta SET value = '99' WHERE key = 'schemaVersion'").run();
    db.close();
    expect(() => new DrizzleStore({ profileDir: seeded.dir, hostId: "newer-v10" })).toThrow(/newer/);
  });

  it("starts a new library at the current version with no managed path until something is kept in it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-v10-fresh-"));
    const store = new DrizzleStore({ profileDir: dir, hostId: "fresh-v10" });
    try {
      expect(store.getMeta("schemaVersion")).toBe("11");
      expect(store.migration).toBeNull();
      expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM library_paths").get()).toEqual({ n: 0 });
      const managed = store.ensureManagedLibraryPath();
      expect(managed.path).toBe(store.managedLibraryDir);
      expect(store.ensureManagedLibraryPath().id).toBe(managed.id);
      expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM library_paths").get()).toEqual({ n: 1 });
    } finally {
      store.close();
    }
  });
});
