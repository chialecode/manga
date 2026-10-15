import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { startFakeBangumi, type FakeBangumi } from "../helpers/fake-bangumi.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>) {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `wf-${counter}`, input }, ctx.grant.handle);
}
const ok = <T = Record<string, any>>(result: Awaited<ReturnType<typeof run>>): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};

let fake: FakeBangumi;
beforeAll(async () => { fake = await startFakeBangumi(); });
afterAll(async () => { await fake.stop(); });

async function boot(): Promise<App> {
  fake.reset();
  await fake.addImage("a.png", "red");
  fake.subject(201, { type: 2, platform: "TV", name: "Sample Anime", name_cn: "样例动画", imageName: "a.png", eps: 3, total_episodes: 3 });
  fake.subject(301, { type: 1, platform: "漫画", name: "Sample Manga", name_cn: "样例漫画", imageName: "a.png", volumes: 3 });
  return startApp({ options: { appVersion: "9.9.9", bangumi: fake.clientOptions } });
}

const link = async (ctx: App, workId: string, externalId: string) => ok(await run(ctx, "metadata.link", { workId, providerId: "bangumi", externalId }));
const unlink = async (ctx: App, workId: string) => ok(await run(ctx, "metadata.unlink", { workId, providerId: "bangumi" }));
const names = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

const library = fs.mkdtempSync(path.join(os.tmpdir(), "manga-wf-lib-"));
afterAll(() => { fs.rmSync(library, { recursive: true, force: true }); });

/** Two releases of one show, each with a work of its own and a file whose name is not the show's. */
function twoReleases(ctx: App) {
  const a = seedVideo(ctx.app, { title: "甲 01", ordinal: { number: 1, type: "episode", label: "第 1 话" }, file: path.join(library, "甲", "[甲] 样例动画 - 01.mkv") });
  ctx.app.store.sqlite.prepare("UPDATE works SET title = ? WHERE id = ?").run("[甲] 样例动画", a.workId);
  const b = seedVideo(ctx.app, { title: "乙 01", ordinal: { number: 1, type: "episode", label: "第 1 话" }, file: path.join(library, "乙", "[乙] 样例动画 - 01.mkv") });
  ctx.app.store.sqlite.prepare("UPDATE works SET title = ? WHERE id = ?").run("[乙] 样例动画", b.workId);
  return { a, b };
}

const folderOf = (ctx: App, resourceId: string) => ctx.app.workFolders.folderFor({ resourceId }, { create: false });

describe("what the person makes goes by entry, and to 未分类 by file (AT-102)", () => {
  it("makes <medium>/<entry>/ for a linked resource, 未分类/<file name>/ for any other, with 截图 录音 粗剪 导出 笔记 inside, and records what is put there", async () => {
    const ctx = await boot();
    try {
      const { a } = twoReleases(ctx);
      const wf = ctx.app.workFolders;
      expect(wf.root).toBe(ctx.app.store.worksDir);
      expect(folderOf(ctx, a.resourceId)).toBeNull();
      const put = (kind: "screenshot" | "recording" | "roughcut" | "export" | "note", fileName: string, body: string) =>
        wf.put({ resourceId: a.resourceId }, { kind, fileName, bytes: Buffer.from(body), resourceId: a.resourceId });
      const shot = put("screenshot", "第一张.png", "png");
      const rec = put("recording", "录音.webm", "opus");
      const cut = put("roughcut", "粗剪.mp4", "mp4");
      const out = put("export", "导出.md", "# 导出");
      const note = put("note", "笔记.md", "# 笔记");
      const folder = folderOf(ctx, a.resourceId)!;
      expect(folder.relDir).toBe("未分类/[甲] 样例动画 - 01");
      expect(folder.ownerKind).toBe("resource");
      const dir = wf.absolute(folder);
      expect(path.relative(wf.root, dir).split(path.sep)).toEqual(["未分类", "[甲] 样例动画 - 01"]);
      expect(names(dir)).toEqual(["导出", "截图", "粗剪", "笔记", "录音"].sort());
      expect(fs.readFileSync(shot.path, "utf8")).toBe("png");
      expect(path.basename(path.dirname(rec.path))).toBe("录音");
      expect(path.basename(path.dirname(cut.path))).toBe("粗剪");
      expect(path.basename(path.dirname(out.path))).toBe("导出");
      expect(path.basename(path.dirname(note.path))).toBe("笔记");
      expect(wf.filesOfResource(a.resourceId).map((file) => file.kind).sort()).toEqual(["export", "note", "recording", "roughcut", "screenshot"]);
      expect(wf.files(a.workId)).toHaveLength(5);
      // The folder is a record the person can see in the overview and open from there.
      const overview = ok<{ items: Array<Record<string, any>> }>(await run(ctx, "inventory.overview", {}));
      const item = overview.items.find((entry) => entry.id === `workfolder:${folder.id}`)!;
      expect(item).toMatchObject({ kind: "work-folder", fileCount: 5, revealable: true });
      expect(overview.items.find((entry) => entry.id === "works")).toMatchObject({ kind: "partition", location: wf.root });
      const revealed = ok<{ path: string }>(await run(ctx, "inventory.reveal", { id: item.id }));
      expect(revealed.path).toBe(dir);
    } finally { ctx.app.close(); }
  });

  it("puts a file of a resource that belongs to no work in its own folder, and a work-only file in the entry's folder or 未分类/<title>", async () => {
    const ctx = await boot();
    try {
      const { a } = twoReleases(ctx);
      const wf = ctx.app.workFolders;
      const keptWork = a.workId;
      const workOnly = wf.put(keptWork, { kind: "audio-import", fileName: "语音.mp3", bytes: Buffer.from("m") });
      expect(wf.folder(workOnly.folder.id)!.relDir).toBe("未分类/[甲] 样例动画");
      ctx.app.store.sqlite.prepare("UPDATE resources SET work_id = NULL WHERE id = ?").run(a.resourceId);
      const loose = wf.put({ resourceId: a.resourceId }, { kind: "screenshot", fileName: "x.png", bytes: Buffer.from("x"), resourceId: a.resourceId });
      expect(wf.folder(loose.folder.id)!.relDir).toBe("未分类/[甲] 样例动画 - 01");
      expect(wf.file(loose.fileId)).toMatchObject({ workId: null, resourceId: a.resourceId });
      await link(ctx, keptWork, "201");
      const linked = wf.put(keptWork, { kind: "audio-import", fileName: "语音.mp3", bytes: Buffer.from("n") });
      expect(wf.folder(linked.folder.id)!.relDir).toBe("动漫/样例动画");
    } finally { ctx.app.close(); }
  });

  it("never overwrites a file that has the name of a new one, and keeps names safe on every system", async () => {
    const ctx = await boot();
    try {
      const { a } = twoReleases(ctx);
      const wf = ctx.app.workFolders;
      const put = (body: string) => wf.put({ resourceId: a.resourceId }, { kind: "screenshot", fileName: "同名.png", bytes: Buffer.from(body), resourceId: a.resourceId });
      const one = put("一");
      const two = put("二");
      expect(path.basename(one.path)).toBe("同名.png");
      expect(path.basename(two.path)).toBe("同名 (2).png");
      expect(fs.readFileSync(one.path, "utf8")).toBe("一");
      expect(fs.readFileSync(two.path, "utf8")).toBe("二");
      // A file whose name has characters a system refuses, and a reserved device name, are not folder names as they are.
      const odd = seedVideo(ctx.app, { title: "奇怪", file: path.join(library, "奇", "带:非法*字符?的名字. .mkv") });
      expect(wf.folderFor({ resourceId: odd.resourceId })!.relDir).toBe("未分类/带_非法_字符_的名字");
      const device = seedVideo(ctx.app, { title: "设备", file: path.join(library, "设", "CON.mkv") });
      expect(wf.folderFor({ resourceId: device.resourceId })!.relDir).toBe("未分类/_CON");
      for (const folder of wf.list()) expect(/[<>:"\\|?*]/.test(path.basename(wf.absolute(folder)))).toBe(false);
    } finally { ctx.app.close(); }
  });

  it("tells files of one name apart: the folder above the file first, then a number; the name is fixed when the folder is made", async () => {
    const ctx = await boot();
    try {
      const wf = ctx.app.workFolders;
      const x = seedVideo(ctx.app, { title: "x", file: path.join(library, "一季", "ep01.mkv") });
      const y = seedVideo(ctx.app, { title: "y", file: path.join(library, "二季", "ep01.mkv") });
      const z = seedVideo(ctx.app, { title: "z", file: path.join(library, "别处", "二季", "ep01.mkv") });
      expect(wf.folderFor({ resourceId: x.resourceId })!.relDir).toBe("未分类/ep01");
      expect(wf.folderFor({ resourceId: y.resourceId })!.relDir).toBe("未分类/二季 - ep01");
      expect(wf.folderFor({ resourceId: z.resourceId })!.relDir).toBe("未分类/二季 - ep01 (2)");
      // A folder that is already there keeps its name when the file is renamed.
      const before = wf.folderFor({ resourceId: x.resourceId })!;
      ctx.app.store.sqlite.prepare("UPDATE file_locations SET relative_path = ? WHERE resource_revision_id = ?").run("一季/改名后.mkv", x.revisionId);
      expect(wf.folderFor({ resourceId: x.resourceId })!.relDir).toBe(before.relDir);
      // A directory that is not recorded but lies in the way is not used either.
      fs.mkdirSync(path.join(wf.root, "未分类", "新的"), { recursive: true });
      const n = seedVideo(ctx.app, { title: "n", file: path.join(library, "新", "新的.mkv") });
      expect(wf.folderFor({ resourceId: n.resourceId })!.relDir).toBe("未分类/新 - 新的");
    } finally { ctx.app.close(); }
  });

  it("shares one folder between the resources of one entry and one medium, and gives every other resource its own", async () => {
    const ctx = await boot();
    try {
      const { a, b } = twoReleases(ctx);
      const comic = seedComic(ctx.app, { title: "样例漫画 01", ordinal: { number: 1, type: "volume", label: "第 1 卷" } });
      ctx.app.store.sqlite.prepare("UPDATE works SET title = ? WHERE id = ?").run("样例动画", comic.workId);
      const wf = ctx.app.workFolders;
      // Before they are linked, the two releases have a folder each.
      expect(wf.folderFor({ resourceId: a.resourceId })!.id).not.toBe(wf.folderFor({ resourceId: b.resourceId })!.id);
      await link(ctx, a.workId, "201");
      await link(ctx, b.workId, "201");
      await link(ctx, comic.workId, "301");
      const fa = wf.folderFor({ resourceId: a.resourceId })!;
      const fb = wf.folderFor({ resourceId: b.resourceId })!;
      const fc = wf.folderFor({ resourceId: comic.resourceId })!;
      expect(fa.relDir).toBe("动漫/样例动画");
      expect(fb.id).toBe(fa.id);
      expect(fc.id).not.toBe(fa.id);
      expect(fc.relDir).toBe("漫画/样例漫画");
      // A resource of a work that is not linked has a folder that is its own.
      const loose = seedVideo(ctx.app, { title: "没关联 01", file: path.join(library, "杂", "没关联 01.mkv") });
      expect(wf.folderFor({ resourceId: loose.resourceId })!.id).not.toBe(fa.id);
      expect(wf.folderFor({ resourceId: loose.resourceId })!.relDir).toBe("未分类/没关联 01");
    } finally { ctx.app.close(); }
  });

  it("moves the files of a resource into the entry's folder when its work is linked, and back to 未分类/<file> when it is unlinked, without overwriting", async () => {
    const ctx = await boot();
    try {
      const { a, b } = twoReleases(ctx);
      const wf = ctx.app.workFolders;
      const putShot = (resourceId: string, body: string) => wf.put({ resourceId }, { kind: "screenshot", fileName: "a.png", bytes: Buffer.from(body), resourceId });
      const own = putShot(a.resourceId, "a");
      const ownFolder = folderOf(ctx, a.resourceId)!;
      const other = putShot(b.resourceId, "b");
      const otherFolder = folderOf(ctx, b.resourceId)!;
      expect(ownFolder.id).not.toBe(otherFolder.id);

      // 乙 is linked first: its files go to the entry's folder.
      await link(ctx, b.workId, "201");
      const entryFolder = wf.folderFor({ resourceId: b.resourceId })!;
      expect(entryFolder.relDir).toBe("动漫/样例动画");
      expect(wf.filesOfResource(b.resourceId)[0]!.folderId).toBe(entryFolder.id);
      expect(fs.readFileSync(wf.pathOf(other.fileId)!, "utf8")).toBe("b");
      expect(wf.folder(otherFolder.id)).toBeNull();

      // 甲 joins the entry: its file comes over under a new name, and the file already there stays.
      await link(ctx, a.workId, "201");
      const joined = wf.filesOfResource(a.resourceId);
      expect(joined).toHaveLength(1);
      expect(joined[0]!.folderId).toBe(entryFolder.id);
      expect(joined[0]!.fileName).toBe("a (2).png");
      expect(fs.readFileSync(path.join(wf.absolute(entryFolder), "截图", "a.png"), "utf8")).toBe("b");
      expect(fs.readFileSync(wf.pathOf(joined[0]!.id)!, "utf8")).toBe("a");
      expect(fs.existsSync(own.path)).toBe(false);
      expect(wf.folder(ownFolder.id)).toBeNull();
      expect(fs.existsSync(wf.absolute(ownFolder))).toBe(false);

      // 甲 leaves the entry: what is its comes back to a folder of its own, and 乙's files stay.
      await unlink(ctx, a.workId);
      const left = wf.filesOfResource(a.resourceId);
      expect(left).toHaveLength(1);
      const back = wf.folder(left[0]!.folderId)!;
      expect(back.id).not.toBe(entryFolder.id);
      expect(back.ownerKind).toBe("resource");
      expect(back.relDir).toBe("未分类/[甲] 样例动画 - 01");
      expect(fs.readFileSync(wf.pathOf(left[0]!.id)!, "utf8")).toBe("a");
      expect(names(path.join(wf.absolute(entryFolder), "截图"))).toEqual(["a.png"]);
      expect(wf.filesOfResource(b.resourceId)).toHaveLength(1);
      // Every move is written down and finished.
      const moves = ctx.app.store.sqlite.prepare("SELECT state FROM file_moves WHERE kind = 'work-move'").all() as Array<{ state: string }>;
      expect(moves.length).toBeGreaterThanOrEqual(3);
      expect(moves.every((move) => move.state === "done")).toBe(true);
      // Running the rule again moves nothing.
      expect(wf.settle()).toMatchObject({ moved: 0 });
    } finally { ctx.app.close(); }
  });

  it("finishes a move that a stop left half done, and keeps a file it cannot place where it is", async () => {
    const ctx = await boot();
    try {
      const { a } = twoReleases(ctx);
      const wf = ctx.app.workFolders;
      const put = wf.put({ resourceId: a.resourceId }, { kind: "screenshot", fileName: "x.png", bytes: Buffer.from("x"), resourceId: a.resourceId });
      const target = wf.folderFor({ resourceId: a.resourceId })!;
      // The state a stop leaves: the record points at the new place, the journal still says pending, the file has not moved.
      const newDir = path.join(wf.absolute(target), "截图");
      const to = path.join(newDir, "moved.png");
      ctx.app.store.sqlite.prepare("UPDATE work_files SET file_name = 'moved.png' WHERE id = ?").run(put.fileId);
      ctx.app.store.sqlite.prepare("INSERT INTO file_moves(id, kind, from_path, to_path, state, created_at) VALUES ('mv-x','work-move',?,?,'pending',?)").run(put.path, to, new Date().toISOString());
      // Until it is finished the file is found where it still is.
      expect(wf.pathOf(put.fileId)).toBe(put.path);
      expect(wf.resumeMoves()).toEqual({ done: 1, pending: 0 });
      expect(fs.existsSync(put.path)).toBe(false);
      expect(wf.pathOf(put.fileId)).toBe(to);
      expect(fs.readFileSync(to, "utf8")).toBe("x");
      // Running it again changes nothing.
      expect(wf.resumeMoves()).toEqual({ done: 0, pending: 0 });

      // A file that is at neither place is reported, not guessed.
      ctx.app.store.sqlite.prepare("INSERT INTO file_moves(id, kind, from_path, to_path, state, created_at) VALUES ('mv-y','work-move',?,?,'pending',?)").run(path.join(newDir, "nowhere.png"), path.join(newDir, "else.png"), new Date().toISOString());
      expect(wf.resumeMoves()).toEqual({ done: 0, pending: 1 });
      const stuck = ctx.app.store.sqlite.prepare("SELECT state, error FROM file_moves WHERE id = 'mv-y'").get() as { state: string; error: string };
      expect(stuck.state).toBe("pending");
      expect(stuck.error).toMatch(/neither|either/);
    } finally { ctx.app.close(); }
  });

  it("keeps the name of an entry's folder when the entry is renamed, and renames it only when asked, without overwriting a folder with that name", async () => {
    const ctx = await boot();
    try {
      const { a, b } = twoReleases(ctx);
      const wf = ctx.app.workFolders;
      await link(ctx, a.workId, "201");
      wf.put({ resourceId: a.resourceId }, { kind: "screenshot", fileName: "1.png", bytes: Buffer.from("1"), resourceId: a.resourceId });
      const folder = wf.folderFor({ resourceId: a.resourceId })!;
      expect(folder.relDir).toBe("动漫/样例动画");
      // The entry is edited on the work: the folder keeps its name.
      ok(await run(ctx, "works.setOverride", { workId: a.workId, fields: { title: "新的标题" }, locked: ["title"], cleared: [] }));
      expect(wf.folderFor({ resourceId: a.resourceId })!.relDir).toBe(folder.relDir);

      // Another folder already has the name the title would give.
      fs.mkdirSync(path.join(wf.root, "动漫", "新的标题"), { recursive: true });
      const renamed = ok<{ folder: { relDir: string } }>(await run(ctx, "workFolders.rename", { folderId: folder.id })).folder;
      expect(renamed.relDir).toBe("动漫/新的标题 (2)");
      expect(fs.readFileSync(path.join(wf.root, "动漫", "新的标题 (2)", "截图", "1.png"), "utf8")).toBe("1");
      expect(fs.existsSync(path.join(wf.root, ...folder.relDir.split("/")))).toBe(false);
      // Nothing changes when asked again.
      expect(ok<{ folder: { relDir: string } }>(await run(ctx, "workFolders.rename", { folderId: folder.id })).folder.relDir).toBe("动漫/新的标题 (2)");
      // A folder of a file keeps the file's name: there is nothing to follow.
      wf.put({ resourceId: b.resourceId }, { kind: "screenshot", fileName: "2.png", bytes: Buffer.from("2"), resourceId: b.resourceId });
      const own = wf.folderFor({ resourceId: b.resourceId })!;
      expect(ok<{ folder: { relDir: string } }>(await run(ctx, "workFolders.rename", { folderId: own.id })).folder.relDir).toBe(own.relDir);
    } finally { ctx.app.close(); }
  });

  it("follows a resource to the work it is moved to", async () => {
    const ctx = await boot();
    try {
      const { a, b } = twoReleases(ctx);
      const wf = ctx.app.workFolders;
      await link(ctx, b.workId, "201");
      ctx.app.store.sqlite.prepare("INSERT INTO screenshots(id, title, file_id, resource_id, resource_revision_id, work_id, media_kind, position_ms, width, height, format, captured_at) VALUES ('shot-1','t','f',?,?,?,'video',1000,10,10,'png',?)")
        .run(a.resourceId, a.revisionId, a.workId, new Date().toISOString());
      const put = wf.put({ resourceId: a.resourceId }, { kind: "screenshot", fileName: "m.png", bytes: Buffer.from("m"), resourceId: a.resourceId });
      ctx.app.store.sqlite.prepare("UPDATE screenshots SET file_id = ? WHERE id = 'shot-1'").run(put.fileId);
      expect(wf.folder(put.folder.id)!.relDir).toBe("未分类/[甲] 样例动画 - 01");
      ok(await run(ctx, "works.moveResource", { resourceId: a.resourceId, toWorkId: b.workId }));
      const files = wf.files(b.workId);
      expect(files).toHaveLength(1);
      expect(files[0]!.id).toBe(put.fileId);
      // The work it joined is linked, so its files are the entry's.
      expect(wf.folder(files[0]!.folderId)!.relDir).toBe("动漫/样例动画");
      expect(fs.readFileSync(wf.pathOf(put.fileId)!, "utf8")).toBe("m");
      expect(ctx.app.store.sqlite.prepare("SELECT work_id AS w FROM screenshots WHERE id = 'shot-1'").get()).toEqual({ w: b.workId });
      // What was made from the resource went with it, so the work that lost its last resource holds nothing of its own and goes (A-67).
      expect(ctx.app.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(a.workId)).toBeUndefined();
    } finally { ctx.app.close(); }
  });

  it("refuses a library path that holds the works folder or lies in it", async () => {
    const ctx = await boot();
    try {
      const wf = ctx.app.workFolders;
      fs.mkdirSync(wf.root, { recursive: true });
      const inside = path.join(wf.root, "动漫");
      fs.mkdirSync(inside, { recursive: true });
      const handle = (target: string) => ctx.app.registerPath("directory", target);
      for (const target of [wf.root, inside, path.dirname(wf.root)]) {
        const result = await run(ctx, "library.paths.add", { pathHandle: handle(target), mediaKind: "video" });
        expect(result.status, target).toBe("error");
        expect(result.error?.details).toMatchObject({ reason: "works-folder" });
      }
      // The folder of a file cannot be made where a library path already is.
      const other = fs.mkdtempSync(path.join(os.tmpdir(), "manga-lib-"));
      try {
        ok(await run(ctx, "library.paths.add", { pathHandle: handle(other), mediaKind: "video" }));
        expect(wf.folderFor({ resourceId: twoReleases(ctx).a.resourceId })).toBeTruthy();
      } finally { fs.rmSync(other, { recursive: true, force: true }); }
    } finally { ctx.app.close(); }
  });
});

describe("recordings kept before the folders are brought into them (AT-92)", () => {
  const legacy = (ctx: App, workId: string, resourceId: string | null, name: string, body: string, at: string) => {
    const id = `cap-${name}`;
    const file = path.join(ctx.app.store.attachmentsDir, `capture-${name}.webm`);
    fs.writeFileSync(file, body);
    ctx.app.store.sqlite.prepare("INSERT INTO capture_sessions(id, clock_json, status, created_at, mode, retention, audio_state, stage, duration_ms, opus_name, work_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, "{}", "done", at, "toggle", "keep", "retained", "done", 1000, path.basename(file), workId, at);
    if (resourceId) ctx.app.store.sqlite.prepare("INSERT INTO capture_events(session_id, payload_json, offset_ms, reason, resource_id) VALUES (?,?,?,?,?)").run(id, "{}", 0, "start", resourceId);
    return { id, file };
  };

  it("copies each recording into the folder it belongs in, journals it, keeps the original, and does not do it twice", async () => {
    const ctx = await boot();
    try {
      const { a } = twoReleases(ctx);
      const one = legacy(ctx, a.workId, a.resourceId, "one", "第一段", "2026-10-01T10:00:00.000Z");
      const two = legacy(ctx, a.workId, null, "two", "第二段", "2026-10-02T10:00:00.000Z");
      const nowhere = legacy(ctx, "", null, "nowhere", "无主", "2026-10-03T10:00:00.000Z");
      ctx.app.store.sqlite.prepare("UPDATE capture_sessions SET work_id = NULL WHERE id = ?").run(nowhere.id);
      const wf = ctx.app.workFolders;
      const outcome = wf.migrateRecordings(ctx.app.store.attachmentsDir);
      expect(outcome).toEqual({ copied: 2, kept: 1, pending: 0 });
      const rows = ctx.app.store.sqlite.prepare("SELECT id, audio_file_id AS fileId, opus_name AS opus FROM capture_sessions ORDER BY id").all() as Array<{ id: string; fileId: string | null; opus: string | null }>;
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(one.id)!.opus).toBeNull();
      expect(fs.readFileSync(wf.pathOf(byId.get(one.id)!.fileId!)!, "utf8")).toBe("第一段");
      expect(fs.readFileSync(wf.pathOf(byId.get(two.id)!.fileId!)!, "utf8")).toBe("第二段");
      expect(path.basename(path.dirname(wf.pathOf(byId.get(one.id)!.fileId!)!))).toBe("录音");
      // One started on a resource is kept with the resource; one that is only the work's is kept with the work.
      expect(wf.file(byId.get(one.id)!.fileId!)).toMatchObject({ resourceId: a.resourceId });
      expect(wf.folder(wf.file(byId.get(one.id)!.fileId!)!.folderId)!.relDir).toBe("未分类/[甲] 样例动画 - 01");
      expect(wf.folder(wf.file(byId.get(two.id)!.fileId!)!.folderId)!.relDir).toBe("未分类/[甲] 样例动画");
      // The recording with no work stays where it was, and so do the originals (the backup before the migration still works).
      expect(byId.get(nowhere.id)).toMatchObject({ fileId: null, opus: path.basename(nowhere.file) });
      expect(fs.existsSync(one.file) && fs.existsSync(two.file) && fs.existsSync(nowhere.file)).toBe(true);
      expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM file_moves WHERE kind = 'recording-copy' AND state = 'done'").get()).toEqual({ n: 2 });
      expect(wf.migrateRecordings(ctx.app.store.attachmentsDir)).toEqual({ copied: 0, kept: 1, pending: 0 });
      expect(wf.files(a.workId)).toHaveLength(2);
    } finally { ctx.app.close(); }
  });

  it("takes over a copy that a stop left behind instead of making a second one, and replaces a copy that is not whole", async () => {
    const ctx = await boot();
    try {
      const { a } = twoReleases(ctx);
      const whole = legacy(ctx, a.workId, null, "whole", "完整内容", "2026-10-01T10:00:00.000Z");
      const cut = legacy(ctx, a.workId, null, "cut", "完整的第二段", "2026-10-02T10:00:00.000Z");
      const wf = ctx.app.workFolders;
      // The copy was made and recorded, the session row was not switched yet.
      wf.put(a.workId, { kind: "recording", fileName: "留下的.webm", sourcePath: whole.file, copy: true, refKind: "capture", refId: whole.id });
      // A copy that stopped part way.
      wf.put(a.workId, { kind: "recording", fileName: "半截.webm", bytes: Buffer.from("完"), refKind: "capture", refId: cut.id });
      expect(wf.files(a.workId)).toHaveLength(2);
      expect(wf.migrateRecordings(ctx.app.store.attachmentsDir)).toEqual({ copied: 2, kept: 0, pending: 0 });
      const files = wf.files(a.workId);
      expect(files).toHaveLength(2);
      const rows = ctx.app.store.sqlite.prepare("SELECT id, audio_file_id AS fileId FROM capture_sessions").all() as Array<{ id: string; fileId: string }>;
      expect(Object.fromEntries(rows.map((row) => [row.id, fs.readFileSync(wf.pathOf(row.fileId)!, "utf8")]))).toEqual({ [whole.id]: "完整内容", [cut.id]: "完整的第二段" });
      expect(files.some((file) => file.fileName === "留下的.webm")).toBe(true);
    } finally { ctx.app.close(); }
  });

  it("reports a recording whose file is gone and goes on with the others", async () => {
    const ctx = await boot();
    try {
      const { a } = twoReleases(ctx);
      const gone = legacy(ctx, a.workId, null, "gone", "没了", "2026-10-01T10:00:00.000Z");
      legacy(ctx, a.workId, null, "here", "还在", "2026-10-02T10:00:00.000Z");
      fs.rmSync(gone.file);
      expect(ctx.app.workFolders.migrateRecordings(ctx.app.store.attachmentsDir)).toEqual({ copied: 1, kept: 0, pending: 1 });
      const failed = ctx.app.store.sqlite.prepare("SELECT state, error FROM file_moves WHERE kind = 'recording-copy' AND state = 'failed'").get() as { state: string; error: string };
      expect(failed.error).toMatch(/not in the attachments/);
      expect(ctx.app.store.sqlite.prepare("SELECT opus_name AS opus FROM capture_sessions WHERE id = ?").get(gone.id)).toEqual({ opus: path.basename(gone.file) });
    } finally { ctx.app.close(); }
  });
});

describe("recordings in a package (AT-92)", () => {
  it("travel as attachments and come out in the folder they belong in on the other side, with nothing left in the attachments", async () => {
    const source = await boot();
    const target = await startApp();
    try {
      const { a } = twoReleases(source);
      const wf = source.app.workFolders;
      const put = wf.put(a.workId, { kind: "recording", fileName: "录音.webm", bytes: Buffer.from("opus bytes"), refKind: "capture", refId: "cap-pkg" });
      const now = new Date().toISOString();
      source.app.store.sqlite.prepare("INSERT INTO capture_sessions(id, clock_json, status, created_at, mode, retention, audio_state, stage, duration_ms, audio_file_id, work_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run("cap-pkg", "{}", "done", now, "toggle", "keep", "retained", "done", 1000, put.fileId, a.workId, now);
      const dir = path.join(os.tmpdir(), `manga-pkg-${Date.now()}`);
      try {
        ok(await run(source, "library.exportPackage", { pathHandle: source.app.registerPath("export", dir) }));
        // The package carries the audio like any attachment and names no file of the work folder.
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as { captures: Array<{ id: string; opus_name: string | null; audio_file_id?: string | null }>; attachments: Array<{ id: string }> };
        const capture = manifest.captures.find((row) => row.id === "cap-pkg")!;
        expect(capture.audio_file_id ?? null).toBeNull();
        expect(manifest.attachments.map((item) => item.id)).toContain(capture.opus_name);
        ok(await run(target, "library.importPackage", { pathHandle: target.app.registerPath("directory", dir) }));
        const row = target.app.store.sqlite.prepare("SELECT audio_file_id AS fileId, opus_name AS opus, work_id AS workId FROM capture_sessions WHERE id = 'cap-pkg'").get() as { fileId: string | null; opus: string | null; workId: string };
        expect(row.opus).toBeNull();
        const file = target.app.workFolders.pathOf(row.fileId!)!;
        expect(path.relative(target.app.store.worksDir, file).split(path.sep).slice(0, 3)).toEqual(["未分类", "[甲] 样例动画", "录音"]);
        expect(fs.readFileSync(file, "utf8")).toBe("opus bytes");
        expect(fs.readdirSync(target.app.store.attachmentsDir).filter((name) => name.endsWith(".webm"))).toEqual([]);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    } finally { source.app.close(); target.app.close(); }
  });
});
