import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SHELL_PREFERENCE, ShellPreferenceSchema, type FindGroup, type ObjectRow, type SidebarItem, type SidebarView } from "@manga/contracts";
import { EMPTY_WORKSPACE_STATE, type WorkspaceState } from "@manga/contracts/workspace-state";
import { readShell } from "@manga/app-core";
import { startApp } from "../helpers/app.ts";
import { ok, run } from "../helpers/creative-project.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";

/**
 * What the sidebar lists for each view of the icon rail (A-99, 交互设计 2.10): the projects and "最近" with the things of one kind, counted for all
 * of them at once and listed a page at a time, the management lists of the projects' objects, the instant name search, and what the shell keeps of
 * the rail. Synthetic rows only.
 */
type App = Awaited<ReturnType<typeof startApp>>;
const apps: App[] = [];
afterEach(() => { while (apps.length) apps.pop()!.app.close(); });
async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  return ctx;
}

const sidebar = async (ctx: App, view: string, extra: Record<string, unknown> = {}) => ok<SidebarView>(await run(ctx, "workspace.sidebar", { view, ...extra }));
const group = (view: SidebarView, contextId: string | null) => view.groups.find((item) => item.contextId === contextId)!;
const titles = (items: SidebarItem[]) => items.map((item) => item.title);
const project = async (ctx: App, name: string) => ok<{ id: string }>(await run(ctx, "project.create", { name })).id;
const note = async (ctx: App, title: string) => ok<{ objectId: string }>(await run(ctx, "notes.create", { title, text: `${title}的正文，一段合成文字。` })).objectId;
const material = async (ctx: App, projectId: string, kind: string, targetId: string) => ok<{ id: string }>(await run(ctx, "project.addMaterial", { projectId, kind, targetId })).id;
const sql = (ctx: App) => ctx.app.store.sqlite;
/** A session of a conversation about a resource, with or without a task having run in it. */
async function openResourceSession(ctx: App, resourceId: string, contextId: string | null, options: { ran?: boolean } = {}) {
  const opened = ok<{ id: string }>(await run(ctx, "session.open", { kind: "resource", targetId: resourceId, contextId }));
  if (options.ran) {
    sql(ctx).prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(`run-${opened.id}`, opened.id, "completed", ctx.grant.handle, "{}", "问", "2026-10-02T00:00:00.000Z", "2026-10-02T00:00:00.000Z");
  }
  return opened.id;
}
/** The file of a resource is under no library path: it cannot be opened (A-86). */
function leaveLibrary(ctx: App, revisionId: string) {
  sql(ctx).prepare("INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, fingerprint, available, hosted, legacy_path) VALUES (?,?,NULL,?,?,0,0,?)")
    .run(`loc-${revisionId}`, revisionId, "x.cbz", "f".repeat(64), "/gone/x.cbz");
}

describe("the home: every project and what it holds, by kind", () => {
  it("lists 最近 and each project with the kinds that have something in them, five to a kind, and the count of the rest", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    const b = await project(ctx, "项目乙");
    const novel = ok<{ workId: string; resourceId: string }>(await run(ctx, "library.importText", { title: "雨夜行人", bytes: [...Buffer.from("雨夜里，一个行人撑着伞走过石桥。")] }));
    await material(ctx, a, "work", novel.workId);
    for (let index = 1; index <= 7; index += 1) await material(ctx, a, "note", await note(ctx, `甲的笔记${index}`));
    const comic = seedComic(ctx.app, { title: "某漫画", pageCount: 3 });
    await material(ctx, a, "work", comic.workId);
    ok(await run(ctx, "whiteboard.create", { projectId: a, title: "素材墙" }));
    ok(await run(ctx, "conversation.new", { contextId: a }));
    ok(await run(ctx, "conversation.new", { contextId: null }));
    const loose = await note(ctx, "不属于任何项目的笔记");

    const view = await sidebar(ctx, "home");
    expect(view.downloads).toBeNull();
    expect(view.groups.map((item) => [item.contextId, item.kind])).toEqual([[null, "recent"], [expect.any(String), "project"], [expect.any(String), "project"]]);
    const mine = group(view, a);
    expect(mine.name).toBe("项目甲");
    expect(mine.sections.map((section) => [section.type, section.total])).toEqual([["conversation", 1], ["novel", 1], ["comic", 1], ["note", 7], ["whiteboard", 1]]);
    const notes = mine.sections.find((section) => section.type === "note")!;
    expect(notes.items).toHaveLength(5);
    expect(notes.nextCursor).toBe("5");
    expect(notes.loaded).toBe(true);
    // A project with nothing in it lists no kind on the home, and is still listed.
    expect(group(view, b).sections).toEqual([]);
    // 最近 holds what belongs to no project: the conversation outside them and the note that is in no project's materials.
    expect(group(view, null).sections.map((section) => [section.type, section.total])).toEqual([["conversation", 1], ["note", 1]]);
    expect(group(view, null).sections.find((section) => section.type === "note")!.items[0]).toMatchObject({ title: "不属于任何项目的笔记", contextId: null, open: { kind: "note", id: loose } });
  });

  it("answers a group that was not asked for with its counts only, and every group in full when none is named", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    const b = await project(ctx, "项目乙");
    await material(ctx, a, "note", await note(ctx, "甲的笔记"));
    await material(ctx, b, "note", await note(ctx, "乙的笔记"));
    const narrow = await sidebar(ctx, "note", { open: [a] });
    const [recent, ma, mb] = [group(narrow, null), group(narrow, a), group(narrow, b)];
    expect(ma.sections[0]).toMatchObject({ type: "note", total: 1, loaded: true });
    expect(titles(ma.sections[0]!.items)).toEqual(["甲的笔记"]);
    expect(mb.sections[0]).toMatchObject({ type: "note", total: 1, loaded: false, items: [] });
    expect(recent.sections[0]).toMatchObject({ total: 0, loaded: true });
    const wide = await sidebar(ctx, "note");
    expect(titles(group(wide, b).sections[0]!.items)).toEqual(["乙的笔记"]);
  });
});

describe("a view of one kind", () => {
  it("conversations: every project is listed, even without one; a conversation about a book is listed once something was asked in it and its file can be opened", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    await project(ctx, "空项目");
    const chat = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { contextId: a })).sessionId;
    const comic = seedComic(ctx.app, { title: "对话的漫画", pageCount: 2 });
    const quiet = seedComic(ctx.app, { title: "没问过的漫画", pageCount: 2 });
    const gone = seedComic(ctx.app, { title: "文件不在的漫画", pageCount: 2 });
    const asked = await openResourceSession(ctx, comic.resourceId, a, { ran: true });
    await openResourceSession(ctx, quiet.resourceId, a);
    await openResourceSession(ctx, gone.resourceId, a, { ran: true });
    leaveLibrary(ctx, gone.revisionId);
    // A task is running in the conversation about the first comic.
    sql(ctx).prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run("run-live", asked, "running", ctx.grant.handle, "{}", "再问", "2026-10-03T00:00:00.000Z", "2026-10-03T00:00:00.000Z");

    const view = await sidebar(ctx, "conversation");
    expect(view.groups.map((item) => item.name)).toEqual(["最近", expect.any(String), expect.any(String)]);
    expect(view.groups.map((item) => item.sections.map((section) => section.type))).toEqual([["conversation"], ["conversation"], ["conversation"]]);
    const mine = group(view, a).sections[0]!;
    expect(mine.items.map((item) => item.open.id)).toEqual(expect.arrayContaining([chat, asked]));
    expect(mine.items).toHaveLength(2);
    expect(mine.items.find((item) => item.open.id === asked)).toMatchObject({ title: "对话的漫画", running: true, open: { kind: "conversation", general: false }, contextId: a, contextName: "项目甲" });
    expect(mine.items.find((item) => item.open.id === chat)).toMatchObject({ running: false, open: { kind: "conversation", general: true } });
    // The list counts what is listed; a file that cannot be opened is passed over when the page is made, not counted away.
    expect(mine.total).toBe(3);
    expect(mine.nextCursor).toBeNull();
    const empty = view.groups.find((item) => item.name === "空项目")!;
    expect(empty.sections[0]).toMatchObject({ type: "conversation", total: 0, items: [], loaded: true });
  });

  it("novels, comics and videos: the works and resources a project holds, and in 最近 the resources opened there, newest first", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    const first = seedComic(ctx.app, { title: "第一部", pageCount: 2, createdAt: "2026-10-01T00:00:00.000Z" });
    const second = seedComic(ctx.app, { title: "第二部", pageCount: 2, createdAt: "2026-10-02T00:00:00.000Z" });
    const clip = seedVideo(ctx.app, { title: "某番第1话" });
    const lost = seedComic(ctx.app, { title: "找不到的一话", pageCount: 2 });
    leaveLibrary(ctx, lost.revisionId);
    await material(ctx, a, "work", first.workId);
    sql(ctx).prepare("UPDATE project_materials SET added_at = '2026-10-04T00:00:00.000Z' WHERE project_id = ? AND target_id = ?").run(a, first.workId);
    await material(ctx, a, "resource", second.resourceId);
    sql(ctx).prepare("UPDATE project_materials SET added_at = '2026-10-05T00:00:00.000Z' WHERE project_id = ? AND target_id = ?").run(a, second.resourceId);
    await material(ctx, a, "resource", lost.resourceId);
    await material(ctx, a, "work", clip.workId);

    const comics = group(await sidebar(ctx, "comic"), a).sections[0]!;
    // Newest first; the work opens its page, the resource opens its reader; the one whose file is gone is not offered.
    expect(comics.items.map((item) => [item.title, item.open.kind])).toEqual([["第二部", "resource"], ["第一部", "work"]]);
    expect(comics.items[0]).toMatchObject({ open: { kind: "resource", id: second.resourceId, workId: second.workId, mediaKind: "comic" }, materialId: expect.any(String) });
    expect(comics.items[1]).toMatchObject({ open: { kind: "work", id: first.workId, mediaKind: "comic" } });
    expect(group(await sidebar(ctx, "video"), a).sections[0]!.items.map((item) => item.title)).toEqual(["某番第1话"]);
    expect(group(await sidebar(ctx, "novel"), a).sections[0]).toMatchObject({ total: 0, items: [] });

    // In 最近: the resources opened there, by the latest time.
    ok(await run(ctx, "progress.setPage", { contextId: null, resourceId: first.resourceId, resourceRevisionId: first.revisionId, pageId: first.pageIds[0] }));
    ok(await run(ctx, "progress.setPage", { contextId: a, resourceId: second.resourceId, resourceRevisionId: second.revisionId, pageId: second.pageIds[0] }));
    ok(await run(ctx, "progress.setPage", { contextId: null, resourceId: second.resourceId, resourceRevisionId: second.revisionId, pageId: second.pageIds[1] }));
    sql(ctx).prepare("UPDATE progress SET last_interaction_at = ? WHERE context_id = '' AND resource_id = ?").run("2026-10-06T00:00:00.000Z", first.resourceId);
    sql(ctx).prepare("UPDATE progress SET last_interaction_at = ? WHERE context_id = '' AND resource_id = ?").run("2026-10-07T00:00:00.000Z", second.resourceId);
    const recent = group(await sidebar(ctx, "comic"), null).sections[0]!;
    expect(recent.items.map((item) => item.title)).toEqual(["第二部", "第一部"]);
    expect(recent.items.every((item) => item.open.kind === "resource" && item.contextId === null)).toBe(true);
    // The position kept in the project is not "最近".
    expect(recent.total).toBe(2);
  });

  it("notes: the notes in a project's materials, and in 最近 the ones that are in no project, newest first", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    const b = await project(ctx, "项目乙");
    const inA = await note(ctx, "在甲里");
    const inBoth = await note(ctx, "两个项目里");
    const loose = await note(ctx, "游离的");
    const removed = await note(ctx, "删除的");
    const materialA = await material(ctx, a, "note", inA);
    await material(ctx, a, "note", inBoth);
    await material(ctx, b, "note", inBoth);
    ok(await run(ctx, "notes.delete", { objectId: removed }));
    sql(ctx).prepare("UPDATE content_objects SET updated_at = ? WHERE id = ?").run("2026-10-02T00:00:00.000Z", inA);
    sql(ctx).prepare("UPDATE content_objects SET updated_at = ? WHERE id = ?").run("2026-10-03T00:00:00.000Z", inBoth);
    const view = await sidebar(ctx, "note");
    expect(titles(group(view, a).sections[0]!.items)).toEqual(["两个项目里", "在甲里"]);
    expect(group(view, a).sections[0]!.items[1]!.materialId).toBe(materialA);
    // The same note stands under each project that holds it.
    expect(titles(group(view, b).sections[0]!.items)).toEqual(["两个项目里"]);
    expect(group(view, null).sections[0]!.items.map((item) => item.open.id)).toEqual([loose]);
    // Taking it out of the project (the sidebar's "从这个项目移除") moves it to 最近 the moment it is in no project.
    ok(await run(ctx, "project.removeMaterial", { projectId: a, materialId: materialA }));
    const after = await sidebar(ctx, "note");
    expect(titles(group(after, a).sections[0]!.items)).toEqual(["两个项目里"]);
    expect(new Set(group(after, null).sections[0]!.items.map((item) => item.open.id))).toEqual(new Set([loose, inA]));
  });

  it("whiteboards, maps, drafts and cuts: the objects of each project, and nothing under 最近, which has none", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    const b = await project(ctx, "项目乙");
    const board = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId: a, title: "素材墙" })).board.id;
    ok(await run(ctx, "whiteboard.create", { projectId: b, title: "乙的白板" }));
    ok(await run(ctx, "mindmap.create", { projectId: a, title: "结构导图" }));
    ok(await run(ctx, "draft.create", { projectId: a, title: "解说词", text: "第一稿" }));
    ok(await run(ctx, "roughcut.create", { projectId: b, title: "第一版粗剪" }));
    const boards = await sidebar(ctx, "whiteboard");
    expect(boards.groups.map((item) => item.contextId)).toEqual([expect.any(String), expect.any(String)]);
    expect(boards.groups.some((item) => item.kind === "recent")).toBe(false);
    expect(group(boards, a).sections[0]!.items[0]).toMatchObject({ title: "素材墙", open: { kind: "whiteboard", id: board }, contextId: a, contextName: "项目甲", materialId: null });
    expect(titles(group(boards, b).sections[0]!.items)).toEqual(["乙的白板"]);
    expect(titles(group(await sidebar(ctx, "mindmap"), a).sections[0]!.items)).toEqual(["结构导图"]);
    expect(titles(group(await sidebar(ctx, "draft"), a).sections[0]!.items)).toEqual(["解说词"]);
    expect(titles(group(await sidebar(ctx, "roughcut"), b).sections[0]!.items)).toEqual(["第一版粗剪"]);
    // The home lists them under their project only.
    const home = await sidebar(ctx, "home");
    expect(group(home, null).sections.some((section) => ["whiteboard", "mindmap", "draft", "roughcut"].includes(section.type))).toBe(false);
  });

  it("downloads are not kept in a project: running tasks first, then the finished, and the cancelled are not listed", async () => {
    const ctx = await boot();
    const now = "2026-10-03T00:00:00.000Z";
    const job = (id: string, name: string, state: string, at: string) => sql(ctx).prepare(
      "INSERT INTO acquisition_jobs(id, engine, resume_format, source_kind, source_ref, name, state, path_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(id, "test", "v1", "magnet", "", name, state, "p1", now, at);
    job("j1", "已完成的任务", "done", "2026-10-05T00:00:00.000Z");
    job("j2", "下载中的任务", "downloading", "2026-10-01T00:00:00.000Z");
    job("j3", "取消的任务", "cancelled", "2026-10-06T00:00:00.000Z");
    job("j4", "失败的任务", "failed", "2026-10-04T00:00:00.000Z");
    const view = await sidebar(ctx, "downloads");
    expect(view.groups).toEqual([]);
    expect(view.downloads).toMatchObject({ type: "download", total: 3, loaded: true, nextCursor: null });
    expect(view.downloads!.items.map((item) => [item.title, item.detail, item.running, item.open.kind])).toEqual([
      ["下载中的任务", "downloading", true, "download"], ["已完成的任务", "done", false, "download"], ["失败的任务", "failed", false, "download"],
    ]);
  });
});

describe("the lists follow the data", () => {
  it("drops what was removed, deleted or archived at once, and does not fail for a project with nothing in it", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    const b = await project(ctx, "项目乙");
    const comic = seedComic(ctx.app, { title: "一部漫画", pageCount: 2 });
    const added = await material(ctx, a, "work", comic.workId);
    await material(ctx, b, "work", comic.workId);
    expect(titles(group(await sidebar(ctx, "comic"), a).sections[0]!.items)).toEqual(["一部漫画"]);
    ok(await run(ctx, "project.removeMaterial", { projectId: a, materialId: added }));
    expect(group(await sidebar(ctx, "comic"), a).sections[0]!.items).toEqual([]);
    expect(titles(group(await sidebar(ctx, "comic"), b).sections[0]!.items)).toEqual(["一部漫画"]);
    // A work that is deleted from the library leaves the project's list.
    sql(ctx).prepare("DELETE FROM works WHERE id = ?").run(comic.workId);
    expect(group(await sidebar(ctx, "comic"), b).sections[0]).toMatchObject({ total: 0, items: [] });
    // An archived project is not in the sidebar; a deleted one is gone.
    ok(await run(ctx, "project.update", { projectId: a, status: "archived" }));
    ok(await run(ctx, "project.delete", { projectId: b }));
    const view = await sidebar(ctx, "home");
    expect(view.groups.map((item) => item.contextId)).toEqual([null]);
  });

  it("pages a long list by a cursor, in order and without a gap or a repeat, and asks for the kind on the home", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    for (let index = 1; index <= 23; index += 1) {
      const id = await note(ctx, `笔记${String(index).padStart(2, "0")}`);
      sql(ctx).prepare("UPDATE content_objects SET updated_at = ? WHERE id = ?").run(`2026-10-01T00:${String(index).padStart(2, "0")}:00.000Z`, id);
      await material(ctx, a, "note", id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = ok<{ type: string; total: number; items: SidebarItem[]; nextCursor: string | null }>(await run(ctx, "workspace.items", { view: "note", contextId: a, limit: 10, ...(cursor ? { cursor } : {}) }));
      expect(page).toMatchObject({ type: "note", total: 23 });
      seen.push(...titles(page.items));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 23 }, (_, index) => `笔记${String(23 - index).padStart(2, "0")}`));
    // On the home the kind says which list of the project is meant.
    expect(ok<{ type: string; total: number }>(await run(ctx, "workspace.items", { view: "home", contextId: a, type: "note", limit: 5 }))).toMatchObject({ type: "note", total: 23 });
    expect((await run(ctx, "workspace.items", { view: "home", contextId: a, limit: 5 })).status).toBe("error");
    expect((await run(ctx, "workspace.items", { view: "note", contextId: a, type: "comic", limit: 5 })).status).toBe("error");
    expect((await run(ctx, "workspace.items", { view: "note", contextId: a, limit: 101 })).status).toBe("error");
    // A project that is gone since the list was drawn answers with an empty list instead of failing.
    expect(ok<{ total: number; items: unknown[] }>(await run(ctx, "workspace.items", { view: "note", contextId: "prj_none", limit: 5 }))).toMatchObject({ total: 0, items: [] });
  });

  it("passes over the rows of a page that are not offered, so a page is full and the next one starts after them", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    const kept: string[] = [];
    for (let index = 1; index <= 8; index += 1) {
      const comic = seedComic(ctx.app, { title: `第${index}册`, pageCount: 2 });
      await material(ctx, a, "resource", comic.resourceId);
      sql(ctx).prepare("UPDATE project_materials SET added_at = ? WHERE project_id = ? AND target_id = ?").run(`2026-10-01T00:00:0${index}.000Z`, a, comic.resourceId);
      if (index % 2 === 0) leaveLibrary(ctx, comic.revisionId); else kept.push(`第${index}册`);
    }
    const first = ok<{ items: SidebarItem[]; nextCursor: string | null }>(await run(ctx, "workspace.items", { view: "comic", contextId: a, limit: 2 }));
    expect(titles(first.items)).toEqual(["第7册", "第5册"]);
    const second = ok<{ items: SidebarItem[]; nextCursor: string | null }>(await run(ctx, "workspace.items", { view: "comic", contextId: a, limit: 2, cursor: first.nextCursor! }));
    expect(titles(second.items)).toEqual(["第3册", "第1册"]);
    expect(second.nextCursor).toBeNull();
  });
});

describe("the objects of every project in a list of their own", () => {
  it("lists them newest first with their project, narrows by name, pages, and says which projects are archived", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    const b = await project(ctx, "项目乙");
    const names = ["雨夜", "雨天", "晴空", "海边"];
    const ids: string[] = [];
    for (const [index, title] of names.entries()) {
      const made = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId: index % 2 ? b : a, title })).board.id;
      sql(ctx).prepare("UPDATE whiteboards SET updated_at = ? WHERE id = ?").run(`2026-10-0${index + 1}T00:00:00.000Z`, made);
      ids.push(made);
    }
    ok(await run(ctx, "project.update", { projectId: b, status: "archived" }));
    const all = ok<{ items: ObjectRow[]; total: number; nextOffset: number | null }>(await run(ctx, "workspace.objects", { kind: "whiteboard", limit: 3 }));
    expect(all.total).toBe(4);
    expect(all.items.map((item) => [item.title, item.projectName, item.projectArchived])).toEqual([["海边", "项目乙", true], ["晴空", "项目甲", false], ["雨天", "项目乙", true]]);
    expect(all.nextOffset).toBe(3);
    const rest = ok<{ items: ObjectRow[]; nextOffset: number | null }>(await run(ctx, "workspace.objects", { kind: "whiteboard", limit: 3, offset: 3 }));
    expect(rest.items.map((item) => item.title)).toEqual(["雨夜"]);
    expect(rest.nextOffset).toBeNull();
    const rain = ok<{ items: ObjectRow[]; total: number }>(await run(ctx, "workspace.objects", { kind: "whiteboard", q: "雨" }));
    expect(rain.total).toBe(2);
    expect(rain.items.map((item) => item.title)).toEqual(["雨天", "雨夜"]);
    expect(ok<{ total: number }>(await run(ctx, "workspace.objects", { kind: "draft" })).total).toBe(0);
    expect((await run(ctx, "workspace.objects", { kind: "note" })).status).toBe("error");
  });
});

describe("finding things by name", () => {
  it("lists the things whose name has the text, by kind, a few of each, and where each one opens", async () => {
    const ctx = await boot();
    const a = await project(ctx, "雨夜项目");
    const b = await project(ctx, "晴天项目");
    ok(await run(ctx, "whiteboard.create", { projectId: b, title: "雨的素材墙" }));
    ok(await run(ctx, "draft.create", { projectId: a, title: "雨夜解说", text: "x" }));
    await note(ctx, "雨夜笔记");
    await note(ctx, "无关笔记");
    const comic = seedComic(ctx.app, { title: "雨夜漫画", pageCount: 2 });
    const chat = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { contextId: b })).sessionId;
    sql(ctx).prepare("UPDATE agent_sessions SET title = ? WHERE id = ?").run("聊聊雨夜", chat);

    const found = ok<{ groups: FindGroup[] }>(await run(ctx, "workspace.find", { q: "雨夜" })).groups;
    expect(found.map((item) => item.type)).toEqual(["project", "conversation", "comic", "note", "draft"]);
    expect(found[0]!.items[0]).toMatchObject({ title: "雨夜项目", contextId: a, open: { kind: "project", id: a } });
    expect(found[1]!.items[0]).toMatchObject({ title: "聊聊雨夜", contextId: b, contextName: "晴天项目", open: { kind: "conversation", id: chat, general: true } });
    // A work and a note are not in a context of their own: they open where the person is.
    expect(found[2]!.items[0]).toMatchObject({ title: "雨夜漫画", open: { kind: "work", id: comic.workId } });
    expect("contextId" in found[2]!.items[0]!).toBe(false);
    expect(found[3]!.items.map((item) => item.title)).toEqual(["雨夜笔记"]);
    expect(found[4]!.items[0]).toMatchObject({ title: "雨夜解说", contextId: a, contextName: "雨夜项目" });
    // Narrowed to the kind of one view, and a view that lists none finds none.
    expect(ok<{ groups: FindGroup[] }>(await run(ctx, "workspace.find", { q: "雨", view: "whiteboard" })).groups.map((item) => item.type)).toEqual(["whiteboard"]);
    expect(ok<{ groups: FindGroup[] }>(await run(ctx, "workspace.find", { q: "雨", view: "comic" })).groups.map((item) => item.type)).toEqual(["comic"]);
    expect(ok<{ groups: FindGroup[] }>(await run(ctx, "workspace.find", { q: "雨", view: "downloads" })).groups).toEqual([]);
    expect(ok<{ groups: FindGroup[] }>(await run(ctx, "workspace.find", { q: "不存在的名字" })).groups).toEqual([]);
    // A percent sign or an underscore in the text is the character itself.
    expect(ok<{ groups: FindGroup[] }>(await run(ctx, "workspace.find", { q: "%" })).groups).toEqual([]);
    // At most `perType` of a kind.
    for (let index = 0; index < 6; index += 1) await note(ctx, `雨夜记录${index}`);
    expect(ok<{ groups: FindGroup[] }>(await run(ctx, "workspace.find", { q: "雨夜记录", perType: 3 })).groups[0]!.items).toHaveLength(3);
    expect((await run(ctx, "workspace.find", { q: "雨夜", perType: 11 })).status).toBe("error");
    expect((await run(ctx, "workspace.find", { q: "" })).status).toBe("error");
  });

  it("does not offer a conversation, work or resource that cannot be opened", async () => {
    const ctx = await boot();
    const lost = seedComic(ctx.app, { title: "找不到的雨夜", pageCount: 2 });
    leaveLibrary(ctx, lost.revisionId);
    const sessionId = await openResourceSession(ctx, lost.resourceId, null, { ran: true });
    const found = ok<{ groups: FindGroup[] }>(await run(ctx, "workspace.find", { q: "雨夜" })).groups;
    expect(found.some((group) => group.type === "conversation")).toBe(false);
    // The work still is: it opens its own page, which says what is wrong with the file.
    expect(found.find((group) => group.type === "comic")!.items.map((item) => item.open.kind)).toEqual(["work"]);
    void sessionId;
  });
});

describe("only the person's own interface asks", () => {
  it("is refused to an agent, whichever of the four it asks", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    let counter = 0;
    for (const [commandId, input] of [
      ["workspace.sidebar", { view: "home" }], ["workspace.items", { view: "note", contextId: a, limit: 5 }], ["workspace.objects", { kind: "draft" }], ["workspace.find", { q: "甲" }],
    ] as const) {
      counter += 1;
      const asAgent = await ctx.app.call({ kind: "agent", id: "agent-sidebar" }, { commandId, idempotencyKey: `sidebar-agent-${counter}`, input }, ctx.grant.handle);
      expect(asAgent.status, commandId).toBe("error");
      expect(ok(await run(ctx, commandId, input as Record<string, unknown>)), commandId).toBeTruthy();
    }
  });
});

describe("what the shell keeps of the rail", () => {
  it("starts from the home with every icon shown, and keeps what the person changed, a part at a time", async () => {
    const ctx = await boot();
    expect(readShell(ctx.app.store).rail).toEqual({ hidden: [], view: "home", open: {}, settingsPage: null });
    ok(await run(ctx, "settings.setShell", { rail: { hidden: ["whiteboard", "mindmap"], view: "comic" } }));
    ok(await run(ctx, "settings.setShell", { rail: { open: { comic: ["", "prj_a"] } } }));
    ok(await run(ctx, "settings.setShell", { rail: { open: { note: ["prj_b"] }, settingsPage: "storage" } }));
    expect(readShell(ctx.app.store).rail).toEqual({ hidden: ["whiteboard", "mindmap"], view: "comic", open: { comic: ["", "prj_a"], note: ["prj_b"] }, settingsPage: "storage" });
    // A part that is named again replaces it; the rest is as it was; the widths and the reading style are not touched.
    ok(await run(ctx, "settings.setShell", { rail: { hidden: [], settingsPage: null } }));
    expect(readShell(ctx.app.store)).toMatchObject({ rail: { hidden: [], view: "comic", open: { comic: ["", "prj_a"], note: ["prj_b"] }, settingsPage: null }, sidebar: { visible: true, width: 260 }, reading: DEFAULT_SHELL_PREFERENCE.reading });
    expect((await run(ctx, "settings.setShell", { rail: { hidden: ["home"] } })).status).toBe("error");
    expect((await run(ctx, "settings.setShell", { rail: { view: "settings" } })).status).toBe("error");
    expect((await run(ctx, "settings.setShell", { rail: { surprise: 1 } })).status).toBe("error");
  });

  it("reads a version 2 record saved before the rail was kept, with the defaults, and writes it back whole", async () => {
    const ctx = await boot();
    const { rail: _rail, ...older } = DEFAULT_SHELL_PREFERENCE;
    sql(ctx).prepare("INSERT INTO config(key, revision, value_json) VALUES ('shell.layout', 1, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(JSON.stringify({ ...older, spoilerGuard: true }));
    expect(ShellPreferenceSchema.safeParse(older).success).toBe(true);
    expect(readShell(ctx.app.store)).toMatchObject({ spoilerGuard: true, rail: { hidden: [], view: "home" } });
    ok(await run(ctx, "settings.setShell", { rail: { view: "note" } }));
    expect(JSON.parse((sql(ctx).prepare("SELECT value_json FROM config WHERE key = 'shell.layout'").get() as { value_json: string }).value_json).rail).toEqual({ hidden: [], view: "note", open: {}, settingsPage: null });
  });
});

describe("tabs of the kinds that are gone", () => {
  const tab = (id: string, kind: string, target: Record<string, unknown> = {}) => ({ id, kind, target, title: id, view: {} });
  const state = (patch: Partial<WorkspaceState>): WorkspaceState => ({ ...EMPTY_WORKSPACE_STATE, ...patch });

  it("are not given back when a context is loaded, and nothing else about the state changes", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    const saved = state({
      preset: "two", layout: { grid: { root: { type: "branch" } } }, focusedTab: "t-search",
      tabs: [tab("t-lib", "library", { page: "overview" }), tab("t-search", "search"), tab("t-set", "settings", { page: "general" }), tab("t-note", "note", { objectId: "n1" }), tab("t-plug", "plugins"), tab("t-keys", "keys"), tab("t-future", "hologram")],
      closed: [tab("c-set", "settings"), tab("c-rec", "records", { section: "records" })],
    });
    ok(await run(ctx, "workspace.saveContext", { contextId: a, state: saved }));
    const back = ok<{ state: WorkspaceState }>(await run(ctx, "workspace.loadContext", { contextId: a })).state;
    expect(back.tabs.map((item) => item.id)).toEqual(["t-lib", "t-note", "t-future"]);
    expect(back.closed.map((item) => item.id)).toEqual(["c-rec"]);
    // The tab that had the focus is gone: the first one left takes it. The layout and the preset are as they were saved.
    expect(back.focusedTab).toBe("t-lib");
    expect(back).toMatchObject({ preset: "two", layout: { grid: { root: { type: "branch" } } } });
    expect(back.tabs[2]).toMatchObject({ kind: "hologram" });
    // The row is not rewritten by reading, and is replaced by the next save.
    expect(JSON.parse((sql(ctx).prepare("SELECT state_json FROM workspace_contexts WHERE context_id = ?").get(a) as { state_json: string }).state_json).tabs).toHaveLength(7);
    ok(await run(ctx, "workspace.saveContext", { contextId: a, state: back }));
    expect(JSON.parse((sql(ctx).prepare("SELECT state_json FROM workspace_contexts WHERE context_id = ?").get(a) as { state_json: string }).state_json).tabs).toHaveLength(3);
  });
});
