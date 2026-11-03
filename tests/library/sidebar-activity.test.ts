import { afterEach, describe, expect, it } from "vitest";
import { SidebarItemSchema, SidebarViewSchema, type SidebarItem, type SidebarView } from "@manga/contracts";
import { startApp } from "../helpers/app.ts";
import { ok, run } from "../helpers/creative-project.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";

/**
 * The sidebar's lists after A-103 and A-105 (计划 4.2—4.5): the home's one list by latest activity, a count that is what the list holds, "最近" with a
 * work once, and the cover and progress a cover grid shows. Synthetic rows only.
 */
type App = Awaited<ReturnType<typeof startApp>>;
const apps: App[] = [];
afterEach(() => { while (apps.length) apps.pop()!.app.close(); });
async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  return ctx;
}
const sql = (ctx: App) => ctx.app.store.sqlite;
const sidebar = async (ctx: App, view: string, extra: Record<string, unknown> = {}) => SidebarViewSchema.parse(ok<SidebarView>(await run(ctx, "workspace.sidebar", { view, ...extra })));
const group = (view: SidebarView, contextId: string | null) => view.groups.find((item) => item.contextId === contextId)!;
const project = async (ctx: App, name: string) => ok<{ id: string }>(await run(ctx, "project.create", { name })).id;
const material = async (ctx: App, projectId: string, kind: string, targetId: string) => ok<{ id: string }>(await run(ctx, "project.addMaterial", { projectId, kind, targetId })).id;
function seen(ctx: App, contextId: string, resource: { resourceId: string; revisionId: string }, at: string, percent = 0.5) {
  sql(ctx).prepare(`INSERT INTO progress(context_id, resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at, percent)
    VALUES (?,?,?,NULL,'[]','reading',?,?)`).run(contextId, resource.resourceId, resource.revisionId, at, percent);
}
/** The file of a resource is under no library path (A-86, A-113). */
function leaveLibrary(ctx: App, revisionId: string) {
  sql(ctx).prepare("INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, fingerprint, available, hosted, legacy_path) VALUES (?,?,NULL,?,?,0,0,?)")
    .run(`loc-${revisionId}`, revisionId, "x.cbz", "f".repeat(64), "/gone/x.cbz");
}
async function allOf(ctx: App, view: string, contextId: string | null, limit: number): Promise<{ items: SidebarItem[]; total: number; pages: number }> {
  const items: SidebarItem[] = [];
  let cursor: string | undefined;
  let total = 0;
  let pages = 0;
  do {
    const page = ok<{ total: number; items: SidebarItem[]; nextCursor: string | null }>(await run(ctx, "workspace.items", { view, contextId, limit, ...(cursor ? { cursor } : {}) }));
    expect(page.items.length, "a page is never empty").toBeGreaterThan(0);
    items.push(...page.items);
    total = page.total;
    cursor = page.nextCursor ?? undefined;
    pages += 1;
  } while (cursor);
  return { items, total, pages };
}

describe("the count is what the list holds (计划 4.3, AT-124)", () => {
  it("neither lists nor counts a comic seen in 最近 or a project's material that cannot be opened, and 更多 pages exactly the rest", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    const gone = seedComic(ctx.app, { title: "打不开的漫画", pageCount: 2 });
    leaveLibrary(ctx, gone.revisionId);
    seen(ctx, "", gone, "2026-10-09T00:00:00.000Z");
    const goneMaterial = seedComic(ctx.app, { title: "打不开的材料", pageCount: 2 });
    leaveLibrary(ctx, goneMaterial.revisionId);
    await material(ctx, a, "resource", goneMaterial.resourceId);
    for (let index = 1; index <= 9; index += 1) {
      const comic = seedComic(ctx.app, { title: `第${index}部`, pageCount: 2 });
      seen(ctx, "", comic, `2026-10-0${index}T00:00:00.000Z`);
      await material(ctx, a, "work", comic.workId);
    }

    const home = await sidebar(ctx, "home");
    const recent = group(home, null).sections[0]!;
    expect(recent.total).toBe(9);
    expect(recent.items).toHaveLength(8);
    expect(recent.items.some((item) => item.title.startsWith("打不开"))).toBe(false);
    const mine = group(home, a).sections[0]!;
    expect(mine.total).toBe(9);
    const paged = await allOf(ctx, "home", a, 4);
    expect(paged.items).toHaveLength(paged.total);
    expect(paged.pages).toBe(3);
    expect(paged.items.some((item) => item.title.startsWith("打不开"))).toBe(false);
    // The comic view counts the same way.
    const comics = await sidebar(ctx, "comic");
    expect(group(comics, null).sections[0]!.total).toBe(9);
    expect(group(comics, a).sections[0]!.total).toBe(9);
    // A place whose things all cannot be opened is empty.
    const b = await project(ctx, "项目乙");
    await material(ctx, b, "resource", goneMaterial.resourceId);
    expect(group(await sidebar(ctx, "home"), b).sections[0]).toMatchObject({ total: 0, items: [] });
  });

  it("pages a list whose things share a time by their key, without a repeat or a gap", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    for (let index = 0; index < 13; index += 1) {
      const id = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: `同时的笔记${index}`, text: "一段合成文字。" })).objectId;
      sql(ctx).prepare("UPDATE content_objects SET updated_at = ? WHERE id = ?").run("2026-10-01T00:00:00.000Z", id);
      await material(ctx, a, "note", id);
    }
    const paged = await allOf(ctx, "home", a, 5);
    expect(paged.total).toBe(13);
    expect(new Set(paged.items.map((item) => item.key)).size).toBe(13);
    const keys = paged.items.map((item) => item.key);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("the home's one list (A-103, AT-123)", () => {
  it("orders a project's things by what happened last: a conversation's update, a work's last reading there or its adding, a note's edit", async () => {
    const ctx = await boot();
    const a = await project(ctx, "项目甲");
    const read = seedComic(ctx.app, { title: "读过的", pageCount: 2 });
    const unread = seedComic(ctx.app, { title: "没读过的", pageCount: 2 });
    await material(ctx, a, "work", read.workId);
    await material(ctx, a, "work", unread.workId);
    sql(ctx).prepare("UPDATE project_materials SET added_at = ? WHERE project_id = ?").run("2026-10-01T00:00:00.000Z", a);
    seen(ctx, a, read, "2026-10-05T00:00:00.000Z", 0.42);
    // Reading it in 最近 does not count for the project.
    seen(ctx, "", unread, "2026-10-09T00:00:00.000Z");
    const note = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "改过的笔记", text: "一段合成文字。" })).objectId;
    await material(ctx, a, "note", note);
    sql(ctx).prepare("UPDATE content_objects SET updated_at = ? WHERE id = ?").run("2026-10-03T00:00:00.000Z", note);
    const chat = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { contextId: a })).sessionId;
    sql(ctx).prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run("2026-10-07T00:00:00.000Z", chat);

    const list = group(await sidebar(ctx, "home"), a).sections[0]!;
    expect(list.items.map((item) => [item.type, item.title])).toEqual([["conversation", expect.any(String)], ["comic", "读过的"], ["note", "改过的笔记"], ["comic", "没读过的"]]);
    expect(list.items[1]).toMatchObject({ coverId: null, progress: { percent: 42, episode: null } });
    expect(list.items[3]!.progress).toBeNull();
    for (const item of list.items) expect(() => SidebarItemSchema.parse(item)).not.toThrow();
  });
});

describe("最近 lists a work once (A-105, AT-124)", () => {
  it("one entry per work with the episode last watched, the resources of no work each on their own under their name without the extension", async () => {
    const ctx = await boot();
    const show = seedVideo(ctx.app, { title: "某番", ordinal: { label: "第 1 集", number: 1, type: "episode" } });
    seen(ctx, "", show, "2026-10-01T00:00:00.000Z");
    let last = show as { resourceId: string; revisionId: string };
    for (let index = 2; index <= 6; index += 1) {
      last = seedVideo(ctx.app, { title: `某番 ${index}`, workId: show.workId, ordinal: { label: `第 ${index} 集`, number: index, type: "episode" } });
      seen(ctx, "", last, `2026-10-0${index}T00:00:00.000Z`, 0.2);
    }
    const other = seedVideo(ctx.app, { title: "另一部" });
    seen(ctx, "", other, "2026-10-07T00:00:00.000Z");
    const third = seedVideo(ctx.app, { title: "第三部" });
    seen(ctx, "", third, "2026-10-08T00:00:00.000Z");
    const loose = seedVideo(ctx.app, { title: "单独的片段.mkv" });
    sql(ctx).prepare("UPDATE resources SET work_id = NULL WHERE id = ?").run(loose.resourceId);
    seen(ctx, "", loose, "2026-10-09T00:00:00.000Z");
    sql(ctx).prepare("UPDATE works SET cover_id = 'cov-1' WHERE id = ?").run(show.workId);

    const recent = group(await sidebar(ctx, "video"), null).sections[0]!;
    expect(recent.total).toBe(4);
    expect(recent.items.map((item) => [item.key.split(":")[0], item.title])).toEqual([["resource", "单独的片段"], ["work", "第三部"], ["work", "另一部"], ["work", "某番"]]);
    expect(recent.items[3]).toMatchObject({ key: `work:${show.workId}`, coverId: "cov-1", progress: { percent: 20, episode: "第 6 集" }, open: { kind: "resource", id: last.resourceId, workId: show.workId, mediaKind: "video" } });
    // The home's 最近 merges the same way.
    expect(group(await sidebar(ctx, "home"), null).sections[0]!.total).toBe(4);
    // A work that is deleted leaves its resources each on their own.
    sql(ctx).prepare("UPDATE resources SET work_id = NULL WHERE work_id = ?").run(show.workId);
    sql(ctx).prepare("DELETE FROM works WHERE id = ?").run(show.workId);
    expect(group(await sidebar(ctx, "video"), null).sections[0]!.total).toBe(9);
  });
});
