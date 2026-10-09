import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { startFakeBangumi, type FakeBangumi } from "../helpers/fake-bangumi.ts";
import { seedVideo } from "../helpers/media-seed.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>, as?: { grant: string; actor: { kind: "user" | "agent"; id: string } }) {
  counter += 1;
  return ctx.app.call(as?.actor ?? ctx.actor, { commandId, idempotencyKey: `ed-${counter}`, input }, as?.grant ?? ctx.grant.handle);
}
const ok = <T = Record<string, any>>(result: Awaited<ReturnType<typeof run>>): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};

let fake: FakeBangumi;
beforeAll(async () => { fake = await startFakeBangumi(); });
afterAll(async () => { await fake.stop(); });

const library = fs.mkdtempSync(path.join(os.tmpdir(), "manga-ed-lib-"));
afterAll(() => { fs.rmSync(library, { recursive: true, force: true }); });

async function boot(): Promise<App> {
  fake.reset();
  await fake.addImage("a.png", "red");
  fake.subject(201, { type: 2, platform: "TV", name: "Sample Anime", name_cn: "样例动画", imageName: "a.png", eps: 3, total_episodes: 3 });
  fake.subject(202, { type: 2, platform: "TV", name: "Other Anime", name_cn: "另一部动画", imageName: "a.png", eps: 3, total_episodes: 3 });
  return startApp({ options: { appVersion: "9.9.9", bangumi: fake.clientOptions } });
}

/** Two releases of one entry, a third video of another entry, with the things a person makes on each. */
async function setup(ctx: App) {
  const mk = (title: string, name: string, work?: string) => seedVideo(ctx.app, { title, ordinal: { number: 1, type: "episode", label: "第 1 话" }, file: path.join(library, title, name), ...(work ? { workId: work } : {}) });
  const a = mk("甲", "[甲] 样例动画 - 01.mkv");
  const b = mk("乙", "[乙] 样例动画 - 01.mkv");
  const c = mk("丙", "另一部动画 - 01.mkv");
  for (const [v, t] of [[a, "[甲] 样例动画"], [b, "[乙] 样例动画"], [c, "另一部动画"]] as const) ctx.app.store.sqlite.prepare("UPDATE works SET title = ? WHERE id = ?").run(t, v.workId);
  for (const v of [a, b]) ok(await run(ctx, "metadata.link", { workId: v.workId, providerId: "bangumi", externalId: "201" }));
  ok(await run(ctx, "metadata.link", { workId: c.workId, providerId: "bangumi", externalId: "202" }));
  return { a, b, c };
}

const count = (ctx: App, sql: string, ...params: unknown[]) => (ctx.app.store.sqlite.prepare(sql).get(...params) as { n: number }).n;

describe("deleting an entry removes what the online entry said and keeps what the person has (AT-101)", () => {
  it("counts what goes and what stays, and removes the whole group of versions in one step", async () => {
    const ctx = await boot();
    try {
      const { a, b, c } = await setup(ctx);
      const db = ctx.app.store.sqlite;
      const now = new Date().toISOString();
      // What the person has made on the two versions.
      for (const v of [a, b]) {
        db.prepare("INSERT INTO progress(resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at) VALUES (?,?,?,?,?,?)").run(v.resourceId, v.revisionId, null, "[]", "reading", now);
        db.prepare("INSERT INTO bookmarks(id, resource_id, resource_revision_id, label, locator_json, created_at) VALUES (?,?,?,?,?,?)").run(`bm-${v.resourceId}`, v.resourceId, v.revisionId, "书签", JSON.stringify({ kind: "temporal", startMs: 5 }), now);
      }
      const note = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "第一话", text: "好看", resourceId: a.resourceId }));
      const workNote = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "总评", text: "整体不错", workId: b.workId }));
      ok(await run(ctx, "dictionary.add", { scope: "work", workId: a.workId, term: "角色名", heard: "角色" }));
      db.prepare("INSERT INTO danmaku_matches(resource_revision_id, source, anime_id, episode_id, anime_title, episode_title, offset_ms, method, confirmed, matched_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(a.revisionId, "dandanplay", 1, 11, "t", "e", 0, "bangumi", 0, now);
      db.prepare("INSERT INTO danmaku_matches(resource_revision_id, source, anime_id, episode_id, anime_title, episode_title, offset_ms, method, confirmed, matched_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(b.revisionId, "dandanplay", 1, 12, "t", "e", 0, "manual", 1, now);
      const shot = ctx.app.workFolders.put({ resourceId: a.resourceId }, { kind: "screenshot", fileName: "s.png", bytes: Buffer.from("png"), resourceId: a.resourceId });
      db.prepare("INSERT INTO screenshots(id, title, file_id, resource_id, resource_revision_id, work_id, media_kind, position_ms, width, height, format, captured_at) VALUES ('shot-a','t',?,?,?,?,'video',1000,10,10,'png',?)").run(shot.fileId, a.resourceId, a.revisionId, a.workId, now);
      db.prepare("INSERT INTO agent_sessions(id, title, grant_handle, created_at, updated_at, kind, target_id) VALUES ('sess-w','对话','h',?,?,'work',?)").run(now, now, a.workId);
      ctx.app.noteFiles.flush();

      const preview = ok<Record<string, any>>(await run(ctx, "works.deletePreview", { workId: a.workId }));
      expect(preview.workIds.sort()).toEqual([a.workId, b.workId].sort());
      expect(preview.title).toBe("样例动画");
      expect(preview.removes).toMatchObject({ works: 2, onlineLinks: 2, derivedDanmaku: 1 });
      expect(preview.removes.snapshots).toBe(2);
      expect(preview.keeps).toMatchObject({ resources: 2, progress: 2, bookmarks: 2, notes: 2, screenshots: 1, conversations: 1, confirmedDanmaku: 1, terms: 1 });
      expect(preview.keeps.files).toBeGreaterThanOrEqual(2);
      // Looking is not doing.
      expect(count(ctx, "SELECT COUNT(*) AS n FROM works")).toBe(3);

      const deleted = ok<{ deleted: number; workIds: string[]; resourceIds: string[] }>(await run(ctx, "works.delete", { workId: b.workId }));
      expect(deleted.deleted).toBe(2);
      expect(deleted.resourceIds.sort()).toEqual([a.resourceId, b.resourceId].sort());

      // The works and what the online entry said are gone; the other entry is untouched.
      expect(count(ctx, "SELECT COUNT(*) AS n FROM works WHERE id IN (?, ?)", a.workId, b.workId)).toBe(0);
      for (const table of ["work_links", "metadata_snapshots", "metadata_candidates", "metadata_overrides", "covers", "subject_characters", "subject_persons"]) {
        expect(count(ctx, `SELECT COUNT(*) AS n FROM ${table} WHERE work_id IN (?, ?)`, a.workId, b.workId), table).toBe(0);
      }
      expect(count(ctx, "SELECT COUNT(*) AS n FROM work_links WHERE work_id = ?", c.workId)).toBe(1);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM works WHERE id = ?", c.workId)).toBe(1);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM danmaku_matches WHERE method = 'bangumi'")).toBe(0);

      // The resources, their files and everything made from them stay, without a work.
      const resources = db.prepare("SELECT id, work_id AS workId, left_work_at AS left FROM resources WHERE id IN (?, ?)").all(a.resourceId, b.resourceId) as Array<{ id: string; workId: string | null; left: string | null }>;
      expect(resources).toHaveLength(2);
      for (const row of resources) { expect(row.workId).toBeNull(); expect(row.left).not.toBeNull(); }
      expect(count(ctx, "SELECT COUNT(*) AS n FROM resource_revisions WHERE resource_id IN (?, ?)", a.resourceId, b.resourceId)).toBe(2);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM file_locations WHERE resource_revision_id IN (?, ?)", a.revisionId, b.revisionId)).toBe(2);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM progress WHERE resource_id IN (?, ?)", a.resourceId, b.resourceId)).toBe(2);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM bookmarks WHERE resource_id IN (?, ?)", a.resourceId, b.resourceId)).toBe(2);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM danmaku_matches WHERE confirmed = 1")).toBe(1);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM screenshots WHERE id = 'shot-a' AND work_id IS NULL")).toBe(1);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM agent_sessions WHERE id = 'sess-w'")).toBe(1);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM dictionary_terms WHERE scope = 'work' AND work_id = ?", a.workId)).toBe(1);

      // Notes stay and are found: the one on a resource follows the resource, the one on the work keeps the title the work had.
      const records = ok<{ items: Array<Record<string, any>> }>(await run(ctx, "records.list", { type: "note" })).items;
      expect(records.map((item) => item.id).sort()).toEqual([note.objectId, workNote.objectId].sort());
      expect(records.find((item) => item.id === workNote.objectId)).toMatchObject({ workId: b.workId, workTitle: "样例动画" });
      expect(records.find((item) => item.id === note.objectId)).toMatchObject({ workId: null, resourceId: a.resourceId, resourceTitle: "甲" });
      expect(ok<{ works: Array<Record<string, any>> }>(await run(ctx, "dictionary.removedWorks", {})).works).toEqual([expect.objectContaining({ workId: a.workId, title: "样例动画", terms: 1 })]);
      expect(ok<{ terms: Array<{ term: string }> }>(await run(ctx, "dictionary.list", { scope: "work", workId: a.workId })).terms.map((term) => term.term)).toEqual(["角色名"]);

      // The files made for them left the entry's folder for the folder of each file, notes included.
      ctx.app.noteFiles.flush();
      const wf = ctx.app.workFolders;
      expect(wf.folder(wf.file(shot.fileId)!.folderId)!.relDir).toBe("未分类/[甲] 样例动画 - 01");
      const noteRow = ctx.app.store.sqlite.prepare("SELECT folder_id AS folderId FROM work_files WHERE kind = 'note' AND ref_id = ?").get(note.objectId) as { folderId: string };
      expect(wf.folder(noteRow.folderId)!.relDir).toBe("未分类/[甲] 样例动画 - 01");
      const workNoteRow = ctx.app.store.sqlite.prepare("SELECT folder_id AS folderId FROM work_files WHERE kind = 'note' AND ref_id = ?").get(workNote.objectId) as { folderId: string };
      expect(wf.folder(workNoteRow.folderId)!.relDir).toBe("未分类/样例动画");
      expect(wf.list().some((folder) => folder.relDir === "动漫/样例动画")).toBe(false);

      // The resources are listed as not in a work, newest leaving first, and can be put into a work again.
      const loose = ok<{ items: Array<Record<string, any>>; total: number }>(await run(ctx, "works.unassigned", {}));
      expect(loose.total).toBe(2);
      expect(loose.items.map((item) => item.resourceId).sort()).toEqual([a.resourceId, b.resourceId].sort());
      expect(loose.items[0]).toMatchObject({ kind: "video", outside: false });
      expect(ok<{ items: unknown[] }>(await run(ctx, "works.unassigned", { kind: "comic" })).items).toEqual([]);
      const into = ok<{ workId: string }>(await run(ctx, "works.moveResource", { resourceId: a.resourceId, newWorkTitle: "重新归入" }));
      expect(ok<{ total: number }>(await run(ctx, "works.unassigned", {})).total).toBe(1);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM resources WHERE id = ? AND work_id = ?", a.resourceId, into.workId)).toBe(1);

      // The delete is in the operation log.
      const log = ok<{ entries: Array<Record<string, any>> }>(await run(ctx, "log.query", { category: "library" })).entries;
      expect(log.some((entry) => entry.action === "works.delete" && entry.outcome === "ok")).toBe(true);
    } finally { ctx.app.close(); }
  });

  it("is for the owner: an agent cannot delete an entry or list the loose resources", async () => {
    const ctx = await boot();
    try {
      const { a } = await setup(ctx);
      const agent = { kind: "agent" as const, id: "agent-del" };
      const grant = ctx.app.issueAgentGrant(ctx.grant, agent, { sessionId: "s-1", runId: "r-1", readResourceIds: [a.resourceId] });
      const as = { grant: grant.handle, actor: agent };
      for (const [commandId, input] of [["works.delete", { workId: a.workId }], ["works.deletePreview", { workId: a.workId }], ["works.unassigned", {}]] as const) {
        const refused = await run(ctx, commandId, input as Record<string, unknown>, as);
        expect(refused.status, commandId).toBe("error");
      }
      expect(count(ctx, "SELECT COUNT(*) AS n FROM works WHERE id = ?", a.workId)).toBe(1);
    } finally { ctx.app.close(); }
  });

  it("does not regroup a loose resource when the library is scanned again, and a new file does not pull it back", async () => {
    const ctx = await boot();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-ed-scan-"));
    const write = (rel: string, body: string) => { const file = path.join(dir, ...rel.split("/")); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); };
    const text = (title: string) => `${title}

${"这是用于扫描测试的一段合成文字。".repeat(20)}
`;
    try {
      write("系列/一.txt", text("一"));
      write("系列/二.txt", text("二"));
      const added = ok<{ path: { id: string } }>(await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", dir), mediaKind: "novel" }));
      await ctx.app.scan.whenIdle();
      const resources = ctx.app.store.sqlite.prepare("SELECT id, work_id AS workId FROM resources ORDER BY title").all() as Array<{ id: string; workId: string }>;
      expect(resources).toHaveLength(2);
      ok(await run(ctx, "works.delete", { workId: resources[0]!.workId }));
      expect(count(ctx, "SELECT COUNT(*) AS n FROM works")).toBe(0);

      // Nothing changed: the loose resources stay loose and no work is made for them.
      ok(await run(ctx, "library.scan.start", { pathId: added.path.id }));
      await ctx.app.scan.whenIdle();
      expect(count(ctx, "SELECT COUNT(*) AS n FROM works")).toBe(0);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM resources WHERE work_id IS NULL")).toBe(2);

      // A file that changed is a new revision of the same loose resource; a new file in the same folder starts a work of its own.
      write("系列/一.txt", text("一（修订）"));
      write("系列/三.txt", text("三"));
      ok(await run(ctx, "library.scan.start", { pathId: added.path.id }));
      await ctx.app.scan.whenIdle();
      expect(count(ctx, "SELECT COUNT(*) AS n FROM resources WHERE work_id IS NULL")).toBe(2);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM works")).toBe(1);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM resource_revisions WHERE resource_id = ?", resources[0]!.id)).toBe(2);
      const fresh = ctx.app.store.sqlite.prepare("SELECT r.title AS title FROM resources r WHERE r.work_id IS NOT NULL").all() as Array<{ title: string }>;
      expect(fresh.map((row) => row.title)).toEqual(["三"]);
    } finally { ctx.app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
