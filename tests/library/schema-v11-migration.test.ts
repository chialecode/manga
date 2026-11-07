import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { DrizzleStore, PRODUCT_SCHEMA_VERSION } from "@manga/storage-drizzle";
import { startApp } from "../helpers/app.ts";
import { makeLegacyProfile } from "../helpers/legacy-db.ts";

const columnsOf = (db: Database.Database, table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number }>;
const names = (db: Database.Database, table: string) => columnsOf(db, table).map((column) => column.name);
const notNull = (db: Database.Database, table: string, column: string) => columnsOf(db, table).find((item) => item.name === column)!.notnull === 1;
const tablesOf = (db: Database.Database) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name);
const now = "2026-10-01T00:00:00.000Z";

type Seeded = { root: string; data: string; works: string; library: string; ids: Record<string, string>; files: Record<string, string> };

const folder = (db: Database.Database, id: string, ownerKind: string, ownerId: string, mediaKind: string, relDir: string, title: string) =>
  db.prepare("INSERT INTO work_folders(id, owner_kind, owner_id, media_kind, rel_dir, title, created_at) VALUES (?,?,?,?,?,?,?)").run(id, ownerKind, ownerId, mediaKind, relDir, title, now);

/**
 * A v10 library laid out the way the stage before wrote it: the folder of a work is `<medium>/<title>/`, the linked work shares the folder of its
 * entry, the other one has its own, and notes are only in the database. Everything is synthetic.
 */
function seedV10(): Seeded {
  const { dir, ids } = makeLegacyProfile(10);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-v11-profile-"));
  const data = path.join(root, "data");
  const works = path.join(root, "works");
  const library = fs.mkdtempSync(path.join(os.tmpdir(), "manga-v11-library-"));
  fs.mkdirSync(data, { recursive: true });
  for (const name of fs.readdirSync(dir)) fs.copyFileSync(path.join(dir, name), path.join(data, name));
  fs.rmSync(dir, { recursive: true, force: true });
  const files: Record<string, string> = {};
  const put = (key: string, rel: string, body: string) => {
    const file = path.join(works, ...rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    files[key] = file;
  };
  put("shotA", "小说/旧库作品/截图/甲.png", "甲的截图");
  put("shotB", "漫画/旧库作品二/截图/乙.png", "乙的截图");
  put("audio", "漫画/旧库作品二/录音/语音.mp3", "作品的语音");
  const db = new Database(path.join(data, "manga.sqlite"));
  db.prepare("UPDATE works SET media_kind = 'comic' WHERE id = ?").run(ids.secondWork);
  db.prepare("INSERT INTO library_paths(id, path, media_kind, auto_scan, created_at, managed) VALUES (?,?,?,?,?,0)").run("lp-main", library, "comic", 0, now);
  db.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)").run("rev-second", ids.second, "s".repeat(64), "p", "{}", now);
  db.prepare("INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,1,0)").run("loc-second", "rev-second", "lp-main", "漫画甲/第一卷.cbz", "fp", );
  folder(db, "wfold-subject", "subject", "novel:bgm:12345", "novel", "小说/旧库作品", "旧库作品");
  folder(db, "wfold-work", "work", ids.secondWork, "comic", "漫画/旧库作品二", "旧库作品二");
  const file = db.prepare("INSERT INTO work_files(id, folder_id, work_id, resource_id, kind, sub_dir, file_name, ref_kind, ref_id, bytes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
  file.run("wf-a", "wfold-subject", ids.work, ids.resource, "screenshot", "截图", "甲.png", "screenshot", "shot-a", 12, now);
  file.run("wf-b", "wfold-work", ids.secondWork, ids.second, "screenshot", "截图", "乙.png", "screenshot", "shot-b", 12, now);
  file.run("wf-audio", "wfold-work", ids.secondWork, null, "audio-import", "录音", "语音.mp3", null, null, 15, now);
  const shot = db.prepare("INSERT INTO screenshots(id, title, file_id, resource_id, resource_revision_id, work_id, media_kind, position_ms, width, height, format, captured_at) VALUES (?,?,?,?,?,?,?,1000,10,10,'png',?)");
  shot.run("shot-a", "甲", "wf-a", ids.resource, ids.revision, ids.work, "comic", now);
  shot.run("shot-b", "乙", "wf-b", ids.second, "rev-second", ids.secondWork, "comic", now);
  const note = db.prepare("INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, tags_json, attachment_ids_json, preview_json, created_at, updated_at, work_id) VALUES (?,'notes.document','manga.notes',?,2,1,?,?,'[]','[]','{}',?,?,?)");
  const body = (text: string) => JSON.stringify({ schemaVersion: 2, blocks: [{ id: "b1", type: "paragraph", text }] });
  note.run("note-a", JSON.stringify({ kind: "library", resourceId: ids.resource }), "甲的笔记", body("关于甲"), now, now, ids.work);
  note.run("note-b", JSON.stringify({ kind: "library", resourceId: ids.second }), "乙的笔记", body("关于乙"), now, now, ids.secondWork);
  note.run("note-g", JSON.stringify({ kind: "library", resourceId: null }), "全局的笔记", body("不属于任何资源"), now, now, null);
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  return { root, data, works, library, ids, files };
}

const dump = (db: Database.Database) => ({
  files: db.prepare("SELECT id, folder_id, work_id, resource_id, kind, sub_dir, file_name, ref_kind, ref_id, bytes FROM work_files ORDER BY id").all(),
  shots: db.prepare("SELECT id, file_id, resource_id, work_id, media_kind, position_ms FROM screenshots ORDER BY id").all(),
  folders: db.prepare("SELECT id, owner_kind, owner_id, rel_dir FROM work_folders ORDER BY id").all(),
  resources: db.prepare("SELECT id, work_id, kind, title FROM resources ORDER BY id").all(),
  notes: db.prepare("SELECT id, title, payload_json, work_id FROM content_objects ORDER BY id").all(),
  works: db.prepare("SELECT id, title FROM works ORDER BY id").all(),
});

function crashChild(data: string, works: string, crashAt: string) {
  const script = `import { DrizzleStore } from '@manga/storage-drizzle'; import { WorkFolders } from '@manga/app-core';
    const store = new DrizzleStore({ profileDir: process.env.MANGA_V11_DATA, worksDir: process.env.MANGA_V11_WORKS, hostId: 'crash-v11', crashAt: '${crashAt}' });
    await new WorkFolders(store).settleAll(); store.close();`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, MANGA_V11_DATA: data, MANGA_V11_WORKS: works }, encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
}

describe("schema v11 migration (a resource may be in no work; files are kept by entry and by file, A-87, A-88)", () => {
  it("changes only the tables: every row is the same afterwards, the columns that had to be allowed to be empty are, and a backup of v10 is taken", () => {
    const seeded = seedV10();
    const before = new Database(path.join(seeded.data, "manga.sqlite"), { readonly: true });
    const was = dump(before);
    before.close();
    const store = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "migrate-v11" });
    try {
      expect(PRODUCT_SCHEMA_VERSION).toBe(12);
      expect(store.getMeta("schemaVersion")).toBe("12");
      expect(store.migration).toMatchObject({ from: 10, to: 12 });
      expect(fs.readdirSync(seeded.data).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v10"]);

      // The backup is v10, untouched.
      const backup = new Database(path.join(seeded.data, "manga.sqlite.premigrate-v10"), { readonly: true });
      expect(names(backup, "resources")).not.toContain("left_work_at");
      expect(tablesOf(backup)).not.toContain("removed_works");
      expect(notNull(backup, "work_files", "work_id")).toBe(true);
      expect(notNull(backup, "screenshots", "work_id")).toBe(true);
      expect(backup.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "10" });
      expect(dump(backup)).toEqual(was);
      backup.close();

      // The new shape: allowed to be empty, one more column, one more table; the rest of the columns are as they were.
      expect(names(store.sqlite, "resources")).toContain("left_work_at");
      expect(notNull(store.sqlite, "work_files", "work_id")).toBe(false);
      expect(notNull(store.sqlite, "screenshots", "work_id")).toBe(false);
      expect(names(store.sqlite, "work_files")).toEqual(names(store.sqlite, "work_files").filter(Boolean));
      expect(tablesOf(store.sqlite)).toContain("removed_works");
      expect(store.sqlite.prepare("PRAGMA index_list(work_files)").all().length).toBeGreaterThanOrEqual(3);
      expect(store.sqlite.prepare("PRAGMA index_list(screenshots)").all().length).toBeGreaterThanOrEqual(1);
      expect(dump(store.sqlite)).toEqual(was);
      expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources WHERE left_work_at IS NOT NULL").get()).toEqual({ n: 0 });
      // The tables only: no file moved and no note was written. That is the job after the start.
      expect(store.getMeta("workLayout")).toBe("pending");
      for (const key of ["shotA", "shotB", "audio"]) expect(fs.existsSync(seeded.files[key]!), key).toBe(true);
      expect(store.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(store.sqlite.pragma("foreign_key_check")).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("is a no-op the second time: no second backup, the same rows", () => {
    const seeded = seedV10();
    const first = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "first-v11" });
    const once = dump(first.sqlite);
    first.close();
    const again = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "again-v11" });
    try {
      expect(again.migration).toBeNull();
      expect(dump(again.sqlite)).toEqual(once);
      expect(again.getMeta("workLayout")).toBe("pending");
      expect(fs.readdirSync(seeded.data).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v10"]);
    } finally {
      again.close();
    }
  });

  it("goes v9 → v10 → v11 in one start, with both sets of changes and one backup of what was there", () => {
    const { dir } = makeLegacyProfile(9);
    const store = new DrizzleStore({ profileDir: dir, hostId: "chain-v11" });
    try {
      expect(store.migration).toMatchObject({ from: 9, to: 12 });
      expect(fs.readdirSync(dir).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v9"]);
      expect(names(store.sqlite, "file_locations")).toContain("library_path_id");
      expect(names(store.sqlite, "resources")).toContain("left_work_at");
      expect(notNull(store.sqlite, "work_files", "work_id")).toBe(false);
      expect(store.getMeta("workLayout")).toBe("pending");
      expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get()).toEqual({ n: 2 });
    } finally {
      store.close();
    }
  });

  it("starts a new library at v11 with nothing to settle", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-v11-fresh-"));
    const store = new DrizzleStore({ profileDir: dir, hostId: "fresh-v11" });
    try {
      expect(store.getMeta("schemaVersion")).toBe("12");
      expect(store.getMeta("workLayout")).toBe("settled");
      expect(store.migration).toBeNull();
      expect(tablesOf(store.sqlite)).toContain("removed_works");
    } finally {
      store.close();
    }
  });

  it("stops before the version is published: the library is still v10 with its rows, and the retry finishes with one backup", () => {
    const seeded = seedV10();
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      `import { DrizzleStore } from '@manga/storage-drizzle'; new DrizzleStore({ profileDir: process.env.MANGA_V11_DATA, hostId: 'crash-before-v11', crashAt: 'migration-before-version' });`], {
      env: { ...process.env, MANGA_V11_DATA: seeded.data }, encoding: "utf8", windowsHide: true, timeout: 60_000,
    });
    expect(child.status, child.stderr).toBe(99);
    const half = new Database(path.join(seeded.data, "manga.sqlite"));
    expect(half.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "10" });
    expect(names(half, "resources")).not.toContain("left_work_at");
    expect(notNull(half, "work_files", "work_id")).toBe(true);
    expect(tablesOf(half)).not.toContain("removed_works");
    expect(half.prepare("SELECT COUNT(*) AS n FROM work_files").get()).toEqual({ n: 3 });
    half.close();
    const retried = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "retry-v11" });
    try {
      expect(retried.getMeta("schemaVersion")).toBe("12");
      expect(retried.sqlite.prepare("SELECT COUNT(*) AS n FROM work_files").get()).toEqual({ n: 3 });
      expect(fs.readdirSync(seeded.data).filter((name) => name.includes("premigrate"))).toEqual(["manga.sqlite.premigrate-v10"]);
    } finally {
      retried.close();
    }
  });

  it("goes back by restoring the backup, and the same migration can run again from there with the same result", () => {
    const seeded = seedV10();
    const first = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "forward-v11" });
    const forward = dump(first.sqlite);
    first.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(seeded.data, `manga.sqlite${suffix}`), { force: true });
    fs.copyFileSync(path.join(seeded.data, "manga.sqlite.premigrate-v10"), path.join(seeded.data, "manga.sqlite"));
    const old = new Database(path.join(seeded.data, "manga.sqlite"), { readonly: true });
    expect(old.prepare("SELECT value FROM schema_meta WHERE key = 'schemaVersion'").get()).toEqual({ value: "10" });
    expect(notNull(old, "work_files", "work_id")).toBe(true);
    // The files the v10 data names are all still where it expects them: the migration moved none.
    expect((old.prepare("SELECT COUNT(*) AS n FROM work_files").get() as { n: number }).n).toBe(3);
    old.close();
    for (const key of ["shotA", "shotB", "audio"]) expect(fs.existsSync(seeded.files[key]!), key).toBe(true);
    const again = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "again-forward-v11" });
    try {
      expect(again.migration).toMatchObject({ from: 10, to: 12 });
      expect(dump(again.sqlite)).toEqual(forward);
    } finally {
      again.close();
    }
  });

  it("refuses a library from a newer version instead of reading it", () => {
    const seeded = seedV10();
    const db = new Database(path.join(seeded.data, "manga.sqlite"));
    db.prepare("UPDATE schema_meta SET value = '99' WHERE key = 'schemaVersion'").run();
    db.close();
    expect(() => new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "newer-v11" })).toThrow(/newer/);
  });
});

describe("the files and notes are put where the rules say after the start, in the background and without doing anything twice (AT-102)", () => {
  const filesOf = (db: Database.Database) => db.prepare(`SELECT x.id AS id, f.rel_dir AS dir, x.sub_dir AS sub, x.file_name AS name, x.kind AS kind FROM work_files x JOIN work_folders f ON f.id = x.folder_id ORDER BY x.kind, x.id`).all() as
    Array<{ id: string; dir: string; sub: string; name: string; kind: string }>;

  it("moves each file to the folder of its entry or of its file, writes the notes that have a place, and leaves the entry folder where it was", async () => {
    const seeded = seedV10();
    const ctx = await startApp({ profileRoot: seeded.root });
    try {
      await ctx.app.whenLayoutSettled();
      expect(ctx.app.store.getMeta("workLayout")).toBe("settled");
      expect(ctx.app.store.getMeta("schemaVersion")).toBe("12");
      const wf = ctx.app.workFolders;
      const placed = filesOf(ctx.app.store.sqlite);
      // The linked work's screenshot stays in the folder of the entry; the other one goes to the folder of its file.
      expect(placed.find((row) => row.id === "wf-a")).toMatchObject({ dir: "小说/旧库作品", sub: "截图", name: "甲.png" });
      expect(placed.find((row) => row.id === "wf-b")).toMatchObject({ dir: "未分类/第一卷", sub: "截图", name: "乙.png" });
      // What belongs to the work only goes to 未分类/<title of the work>.
      expect(placed.find((row) => row.id === "wf-audio")).toMatchObject({ dir: "未分类/旧库作品二", sub: "录音", name: "语音.mp3" });
      expect(fs.readFileSync(wf.pathOf("wf-a")!, "utf8")).toBe("甲的截图");
      expect(fs.readFileSync(wf.pathOf("wf-b")!, "utf8")).toBe("乙的截图");
      expect(fs.readFileSync(wf.pathOf("wf-audio")!, "utf8")).toBe("作品的语音");
      expect(fs.existsSync(seeded.files.shotB!)).toBe(false);
      expect(fs.existsSync(path.join(seeded.works, "漫画"))).toBe(false);
      // The screenshots still find their files.
      expect(ctx.app.screenshots.pathOf("shot-b")).toBe(wf.pathOf("wf-b"));
      // Two notes have a place and are written there; the one that belongs to no resource and no work is not.
      expect(placed.filter((row) => row.kind === "note").map((row) => `${row.dir}/${row.sub}/${row.name}`).sort()).toEqual(["小说/旧库作品/笔记/甲的笔记.md", "未分类/第一卷/笔记/乙的笔记.md"]);
      expect(fs.readFileSync(path.join(seeded.works, "未分类", "第一卷", "笔记", "乙的笔记.md"), "utf8")).toContain("关于乙");
      expect(fs.readdirSync(path.join(seeded.works, "未分类")).sort()).toEqual(["旧库作品二", "第一卷"]);
      // Every move is in the journal and finished; nothing is left pending.
      expect(ctx.app.store.sqlite.prepare("SELECT state, COUNT(*) AS n FROM file_moves WHERE kind = 'work-move' GROUP BY state").all()).toEqual([{ state: "done", n: expect.any(Number) }]);
      expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM file_moves WHERE state = 'pending'").get()).toEqual({ n: 0 });
    } finally { ctx.app.close(); }

    // A second start has nothing to do.
    const again = await startApp({ profileRoot: seeded.root });
    try {
      await again.app.whenLayoutSettled();
      expect(again.app.noteFiles.writes).toBe(0);
      expect(again.app.workFolders.settle()).toMatchObject({ moved: 0 });
      expect(filesOf(again.app.store.sqlite)).toHaveLength(5);
    } finally { again.app.close(); }
  });

  it("is finished after a stop in the middle of a move: the next start completes it and ends with the same layout as an uninterrupted run", async () => {
    const reference = seedV10();
    const clean = await startApp({ profileRoot: reference.root });
    await clean.app.whenLayoutSettled();
    const expected = filesOf(clean.app.store.sqlite).map((row) => `${row.kind}:${row.dir}/${row.sub}/${row.name}`).sort();
    clean.app.close();

    const seeded = seedV10();
    // The first start migrates the tables; the second one is cut off in the middle of the first move, after the records changed and before the file did.
    new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "prep-v11" }).close();
    const child = crashChild(seeded.data, seeded.works, "before-work-move");
    expect(child.status, child.stderr).toBe(99);
    const half = new Database(path.join(seeded.data, "manga.sqlite"));
    expect(half.prepare("SELECT value FROM schema_meta WHERE key = 'workLayout'").get()).toEqual({ value: "pending" });
    expect(half.prepare("SELECT COUNT(*) AS n FROM file_moves WHERE state = 'pending'").get()).toEqual({ n: 1 });
    half.close();
    const ctx = await startApp({ profileRoot: seeded.root });
    try {
      await ctx.app.whenLayoutSettled();
      expect(ctx.app.store.getMeta("workLayout")).toBe("settled");
      expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM file_moves WHERE state = 'pending'").get()).toEqual({ n: 0 });
      expect(filesOf(ctx.app.store.sqlite).map((row) => `${row.kind}:${row.dir}/${row.sub}/${row.name}`).sort()).toEqual(expected);
      for (const row of filesOf(ctx.app.store.sqlite).filter((item) => item.kind !== "note")) expect(ctx.app.workFolders.pathOf(row.id), row.id).toBeTruthy();
    } finally { ctx.app.close(); }
  });

  it("can be stopped between two batches and goes on from there", async () => {
    const seeded = seedV10();
    const store = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "batches-v11" });
    try {
      const { WorkFolders } = await import("../../packages/app-core/src/work-folders.ts");
      const wf = new WorkFolders(store);
      let calls = 0;
      const partial = await wf.settleAll({ batch: 1, stop: () => (calls += 1) > 2 });
      expect(partial.finished).toBe(false);
      // Two of the three files were looked at; the third (the screenshot of the file) is still in the folder the work had.
      expect(partial.looked).toBe(2);
      const stillOld = store.sqlite.prepare("SELECT f.rel_dir AS dir FROM work_files x JOIN work_folders f ON f.id = x.folder_id WHERE x.id = 'wf-b'").get() as { dir: string };
      expect(stillOld.dir).toBe("未分类/旧库作品二");
      const rest = await wf.settleAll({ batch: 1 });
      expect(rest.finished).toBe(true);
      expect(rest.moved).toBe(1);
      expect(wf.settle()).toMatchObject({ moved: 0 });
      expect(wf.pathOf("wf-b")).toBeTruthy();
    } finally { store.close(); }
  });

  it("does not move again, or rename, a file that a command moved while the background run was between two batches", async () => {
    const seeded = seedV10();
    const store = new DrizzleStore({ profileDir: seeded.data, worksDir: seeded.works, hostId: "race-v11" });
    try {
      const { WorkFolders } = await import("../../packages/app-core/src/work-folders.ts");
      const wf = new WorkFolders(store);
      // The background run reads its list, does the first batch and gives the event loop back; a link, an unlink or a deleted entry moves a later file then.
      const running = wf.settleAll({ batch: 1 });
      expect(wf.settle({ resourceIds: [seeded.ids.second!] })).toMatchObject({ moved: 1 });
      const placed = store.sqlite.prepare("SELECT f.rel_dir AS dir, x.file_name AS name FROM work_files x JOIN work_folders f ON f.id = x.folder_id WHERE x.id = 'wf-b'").get();
      expect(placed).toEqual({ dir: "未分类/第一卷", name: "乙.png" });
      const done = await running;
      expect(done.finished).toBe(true);
      // The file is where the command put it, under its own name, and no second copy or "(2)" was made.
      expect(store.sqlite.prepare("SELECT f.rel_dir AS dir, x.file_name AS name FROM work_files x JOIN work_folders f ON f.id = x.folder_id WHERE x.id = 'wf-b'").get()).toEqual(placed);
      expect(fs.readdirSync(path.join(seeded.works, "未分类", "第一卷", "截图"))).toEqual(["乙.png"]);
      expect(fs.readFileSync(wf.pathOf("wf-b")!, "utf8")).toBe("乙的截图");
      expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM file_moves WHERE state = 'pending' OR error IS NOT NULL").get()).toEqual({ n: 0 });
    } finally { store.close(); }
  });
});
