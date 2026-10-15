import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { startFakeBangumi, type FakeBangumi } from "../helpers/fake-bangumi.ts";
import { seedVideo } from "../helpers/media-seed.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>) {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `nf-${counter}`, input }, ctx.grant.handle);
}
const ok = <T = Record<string, any>>(result: Awaited<ReturnType<typeof run>>): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};

let fake: FakeBangumi;
beforeAll(async () => { fake = await startFakeBangumi(); });
afterAll(async () => { await fake.stop(); });

const library = fs.mkdtempSync(path.join(os.tmpdir(), "manga-nf-lib-"));
afterAll(() => { fs.rmSync(library, { recursive: true, force: true }); });

async function boot(): Promise<App> {
  fake.reset();
  await fake.addImage("a.png", "red");
  fake.subject(201, { type: 2, platform: "TV", name: "Sample Anime", name_cn: "样例动画", imageName: "a.png", eps: 3, total_episodes: 3 });
  return startApp({ options: { appVersion: "9.9.9", bangumi: fake.clientOptions } });
}

const video = (ctx: App) => {
  const v = seedVideo(ctx.app, { title: "甲 01", ordinal: { number: 1, type: "episode", label: "第 1 话" }, file: path.join(library, "甲", "[甲] 样例动画 - 01.mkv") });
  ctx.app.store.sqlite.prepare("UPDATE works SET title = ? WHERE id = ?").run("[甲] 样例动画", v.workId);
  return v;
};
const create = async (ctx: App, input: Record<string, unknown>) => ok<{ objectId: string; revision: number }>(await run(ctx, "notes.create", input));
const files = (ctx: App, objectId: string) => ctx.app.store.sqlite.prepare("SELECT id, folder_id AS folderId, file_name AS fileName, bytes, resource_id AS resourceId, work_id AS workId FROM work_files WHERE kind = 'note' AND ref_id = ?").all(objectId) as
  Array<{ id: string; folderId: string; fileName: string; bytes: number; resourceId: string | null; workId: string | null }>;
const pathOfNote = (ctx: App, objectId: string) => ctx.app.workFolders.pathOf(files(ctx, objectId)[0]!.id)!;

describe("notes are written as Markdown files next to what they were written for (AT-102)", () => {
  it("writes a note of a resource into 笔记 of its folder, with its source and the line that says the file is not read back", async () => {
    const ctx = await boot();
    try {
      const v = video(ctx);
      const note = await create(ctx, { title: "第一话的想法", text: "片头很好看。", resourceId: v.resourceId });
      // Nothing is written the moment the note is saved: saves that follow each other become one write.
      expect(files(ctx, note.objectId)).toHaveLength(0);
      ctx.app.noteFiles.flush();
      const rows = files(ctx, note.objectId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ fileName: "第一话的想法.md", resourceId: v.resourceId });
      const file = pathOfNote(ctx, note.objectId);
      expect(path.relative(ctx.app.store.worksDir, file).split(path.sep)).toEqual(["未分类", "[甲] 样例动画 - 01", "笔记", "第一话的想法.md"]);
      const text = fs.readFileSync(file, "utf8");
      expect(text.startsWith("# 第一话的想法\n")).toBe(true);
      expect(text).toContain("> 由 MANGA 生成，在这里修改不会写回应用。");
      expect(text).toContain("> 作品：\\[甲] 样例动画\n");
      expect(text).toContain("> 资源：甲 01\n");
      expect(text).toContain("片头很好看。");
      expect(text.endsWith("\n")).toBe(true);
      expect(text.includes("\r")).toBe(false);
    } finally { ctx.app.close(); }
  });

  it("writes headings, lists, quotes and code as Markdown and escapes what would be read as markup", async () => {
    const ctx = await boot();
    try {
      const v = video(ctx);
      const note = await create(ctx, { title: "结构", text: "开头", resourceId: v.resourceId });
      ok(await run(ctx, "notes.replace", {
        objectId: note.objectId, expectedRevision: note.revision,
        blocks: [
          { id: "h", type: "heading", level: 1, text: "章节" },
          { id: "p", type: "paragraph", text: "*不是强调* 与 # 不是标题\n第二行" },
          { id: "l1", type: "list", text: "第一项" },
          { id: "l2", type: "list", text: "第二项" },
          { id: "o1", type: "list", ordered: true, text: "步骤一" },
          { id: "q", type: "quote", text: "引文" },
          { id: "c", type: "code", text: "const a = 1;\nconsole.log(a);" },
        ],
      }));
      ctx.app.noteFiles.flush();
      const text = fs.readFileSync(pathOfNote(ctx, note.objectId), "utf8");
      expect(text).toContain("\n## 章节\n");
      expect(text).toContain("\\*不是强调\\* 与 # 不是标题");
      expect(text).toMatch(/第二行/);
      expect(text).toContain("- 第一项\n- 第二项\n");
      expect(text).toContain("1. 步骤一\n");
      expect(text).toContain("> 引文\n");
      expect(text).toContain("```\nconst a = 1;\nconsole.log(a);\n```");
    } finally { ctx.app.close(); }
  });

  it("makes one write of saves that follow each other, renames the file with the title, and removes it with the note and writes it back when restored", async () => {
    const ctx = await boot();
    try {
      const v = video(ctx);
      const note = await create(ctx, { title: "旧标题", text: "a", resourceId: v.resourceId });
      ctx.app.noteFiles.flush();
      const first = files(ctx, note.objectId)[0]!;
      const before = ctx.app.noteFiles.writes;
      let revision = note.revision;
      for (const text of ["b", "bc", "bcd"]) {
        const updated = ok<{ revision: number }>(await run(ctx, "notes.update", { objectId: note.objectId, expectedRevision: revision, blockId: "b1", text }));
        revision = updated.revision;
      }
      ctx.app.noteFiles.flush();
      expect(ctx.app.noteFiles.writes - before).toBe(1);
      expect(fs.readFileSync(pathOfNote(ctx, note.objectId), "utf8")).toContain("bcd");

      // A new title is a new name; the old file is gone, the record is the same.
      ok(await run(ctx, "notes.rename", { objectId: note.objectId, expectedRevision: revision, title: "新标题" }));
      ctx.app.noteFiles.flush();
      const renamed = files(ctx, note.objectId);
      expect(renamed).toHaveLength(1);
      expect(renamed[0]).toMatchObject({ id: first.id, fileName: "新标题.md" });
      const dir = path.dirname(pathOfNote(ctx, note.objectId));
      expect(fs.readdirSync(dir)).toEqual(["新标题.md"]);
      expect(fs.readFileSync(path.join(dir, "新标题.md"), "utf8").startsWith("# 新标题\n")).toBe(true);

      // Deleting the note deletes the file and the folder that held only it; restoring writes it again.
      ok(await run(ctx, "notes.delete", { objectId: note.objectId }));
      ctx.app.noteFiles.flush();
      expect(files(ctx, note.objectId)).toHaveLength(0);
      expect(fs.existsSync(dir)).toBe(false);
      ok(await run(ctx, "notes.undelete", { objectId: note.objectId }));
      ctx.app.noteFiles.flush();
      expect(fs.readFileSync(pathOfNote(ctx, note.objectId), "utf8")).toContain("bcd");
    } finally { ctx.app.close(); }
  });

  it("gives two notes of one title two files, and writes no file for a note that belongs to neither a resource nor a work", async () => {
    const ctx = await boot();
    try {
      const v = video(ctx);
      const one = await create(ctx, { title: "同名", text: "一", resourceId: v.resourceId });
      const two = await create(ctx, { title: "同名", text: "二", resourceId: v.resourceId });
      const global = await create(ctx, { title: "全局", text: "没有地方放" });
      ctx.app.noteFiles.flush();
      expect(files(ctx, one.objectId)[0]!.fileName).toBe("同名.md");
      expect(files(ctx, two.objectId)[0]!.fileName).toBe("同名 (2).md");
      expect(fs.readFileSync(pathOfNote(ctx, one.objectId), "utf8")).toContain("一");
      expect(fs.readFileSync(pathOfNote(ctx, two.objectId), "utf8")).toContain("二");
      expect(files(ctx, global.objectId)).toHaveLength(0);
      // A note on a work page, with no resource, goes in the work's folder.
      const onWork = await create(ctx, { title: "作品页", text: "总评", workId: v.workId });
      ctx.app.noteFiles.flush();
      expect(path.relative(ctx.app.store.worksDir, pathOfNote(ctx, onWork.objectId)).split(path.sep)).toEqual(["未分类", "[甲] 样例动画", "笔记", "作品页.md"]);
    } finally { ctx.app.close(); }
  });

  it("moves the file with the note when its work is linked to an entry, and writes the new source", async () => {
    const ctx = await boot();
    try {
      const v = video(ctx);
      const note = await create(ctx, { title: "会搬家", text: "内容", resourceId: v.resourceId });
      ctx.app.noteFiles.flush();
      const before = pathOfNote(ctx, note.objectId);
      ok(await run(ctx, "metadata.link", { workId: v.workId, providerId: "bangumi", externalId: "201" }));
      ctx.app.noteFiles.flush();
      const after = pathOfNote(ctx, note.objectId);
      expect(after).not.toBe(before);
      expect(path.relative(ctx.app.store.worksDir, after).split(path.sep)).toEqual(["动漫", "样例动画", "笔记", "会搬家.md"]);
      expect(fs.existsSync(before)).toBe(false);
      expect(files(ctx, note.objectId)).toHaveLength(1);
    } finally { ctx.app.close(); }
  });

  it("links an embedded screenshot of the same folder by a relative path and describes one that is elsewhere", async () => {
    const ctx = await boot();
    try {
      const v = video(ctx);
      const wf = ctx.app.workFolders;
      const put = wf.put({ resourceId: v.resourceId }, { kind: "screenshot", fileName: "第 1 话 00-01.png", bytes: Buffer.from("png"), resourceId: v.resourceId, refKind: "screenshot", refId: "shot-here" });
      const now = new Date().toISOString();
      const insert = ctx.app.store.sqlite.prepare("INSERT INTO screenshots(id, title, file_id, resource_id, resource_revision_id, work_id, media_kind, position_ms, width, height, format, captured_at) VALUES (?,?,?,?,?,?,'video',1000,10,10,'png',?)");
      insert.run("shot-here", "这一张", put.fileId, v.resourceId, v.revisionId, v.workId, now);
      const other = video(ctx);
      const away = wf.put({ resourceId: other.resourceId }, { kind: "screenshot", fileName: "别处.png", bytes: Buffer.from("png"), resourceId: other.resourceId, refKind: "screenshot", refId: "shot-away" });
      insert.run("shot-away", "别处的一张", away.fileId, other.resourceId, other.revisionId, other.workId, now);
      const note = await create(ctx, { title: "带图", text: "占位", resourceId: v.resourceId });
      ok(await run(ctx, "notes.replace", { objectId: note.objectId, expectedRevision: note.revision, blocks: [
        { id: "a", type: "screenshot", text: "", attrs: { screenshotId: "shot-here" } },
        { id: "b", type: "screenshot", text: "", attrs: { screenshotId: "shot-away" } },
      ] }));
      ctx.app.noteFiles.flush();
      const text = fs.readFileSync(pathOfNote(ctx, note.objectId), "utf8");
      expect(text).toContain("![这一张](../%E6%88%AA%E5%9B%BE/%E7%AC%AC%201%20%E8%AF%9D%2000-01.png)");
      expect(text).toContain("截图：别处的一张");
      expect(text).not.toContain("别处.png");
    } finally { ctx.app.close(); }
  });

  it("writes every note again and removes the files of notes that are gone, and changing the file does not change the note", async () => {
    const ctx = await boot();
    try {
      const v = video(ctx);
      const kept = await create(ctx, { title: "保留", text: "原文", resourceId: v.resourceId });
      const gone = await create(ctx, { title: "要删", text: "删掉", resourceId: v.resourceId });
      ctx.app.noteFiles.flush();
      // The file is edited by hand: the note does not follow, and the next write puts the note's text back.
      const file = pathOfNote(ctx, kept.objectId);
      fs.writeFileSync(file, "# 被改过\n");
      const row = ctx.app.store.sqlite.prepare("SELECT payload_json AS payload FROM content_objects WHERE id = ?").get(kept.objectId) as { payload: string };
      expect(row.payload).toContain("原文");
      // A note removed from the database leaves a file behind; the sweep takes it away and rewrites the one that was edited.
      ctx.app.store.sqlite.prepare("DELETE FROM content_objects WHERE id = ?").run(gone.objectId);
      const done = await ctx.app.noteFiles.syncAll();
      expect(done).toMatchObject({ finished: true, removed: 1 });
      expect(fs.readFileSync(file, "utf8")).toContain("原文");
      expect(files(ctx, gone.objectId)).toHaveLength(0);
      // Running it again changes nothing.
      expect(await ctx.app.noteFiles.syncAll()).toMatchObject({ written: 0, removed: 0 });
    } finally { ctx.app.close(); }
  });
});
