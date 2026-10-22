import { afterEach, describe, expect, it } from "vitest";
import { NORMALIZATION_V1 } from "@manga/contracts";
import { startApp } from "../helpers/app.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";

/**
 * Progress is kept per context (A-96, Q-33 items 3 and 4, plan 4.7): the position a person left in a project is not the position in 最近, and every
 * place that reads progress is one of three kinds: the current context's own, the latest in any context, or the furthest in any context.
 */
type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
let counter = 0;
const apps: App[] = [];
afterEach(() => { while (apps.length) apps.pop()!.app.close(); });

async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  return ctx;
}
async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `pc-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
const project = async (ctx: App, name: string) => ok<{ id: string }>(await run(ctx, "project.create", { name })).id;
const setPage = async (ctx: App, contextId: string | null, comic: ReturnType<typeof seedComic>, index: number, consumed = true) =>
  ok(await run(ctx, "progress.setPage", { contextId, resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[index], consumed }));
const get = async (ctx: App, contextId: string | null, resourceId: string) => ok<Record<string, any>>(await run(ctx, "progress.get", { contextId, resourceId }));
/** The clock of the row, so which position is later does not depend on how fast the test runs. */
const stamp = (ctx: App, contextId: string | null, resourceId: string, at: string) =>
  ctx.app.store.sqlite.prepare("UPDATE progress SET last_interaction_at = ? WHERE context_id = ? AND resource_id = ?").run(at, contextId ?? "", resourceId);

describe("a position is the position in one context (A-96)", () => {
  it("keeps one position per context for the same revision, and each context restores its own", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "两处读的漫画", pageCount: 8 });
    const a = await project(ctx, "项目甲");
    await setPage(ctx, null, comic, 2);
    await setPage(ctx, a, comic, 6);
    const recent = await get(ctx, null, comic.resourceId);
    const inA = await get(ctx, a, comic.resourceId);
    expect(recent.locator).toMatchObject({ kind: "image", pageId: comic.pageIds[2] });
    expect(inA.locator).toMatchObject({ kind: "image", pageId: comic.pageIds[6] });
    expect(recent.contextId).toBeNull();
    expect(inA.contextId).toBe(a);
    expect(inA.percent).toBeGreaterThan(recent.percent);
    // Reading on in one context does not move the other.
    await setPage(ctx, null, comic, 3);
    expect((await get(ctx, a, comic.resourceId)).locator).toMatchObject({ pageId: comic.pageIds[6] });
    expect((await get(ctx, null, comic.resourceId)).locator).toMatchObject({ pageId: comic.pageIds[3] });
    expect(ctx.app.store.sqlite.prepare("SELECT context_id FROM progress WHERE resource_id = ? ORDER BY context_id").all(comic.resourceId)).toEqual([{ context_id: "" }, { context_id: a }]);
    // The read ranges are the context's own too; the furthest of all of them is reported beside.
    expect((recent.consumed as unknown[]).length).toBeGreaterThan(0);
    expect(inA.farthest.percent).toBe(inA.percent);
  });

  it("does not make a context the latest one by saying again the position it already has", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "切回来的漫画", pageCount: 8 });
    const a = await project(ctx, "项目甲");
    await setPage(ctx, null, comic, 1);
    await setPage(ctx, a, comic, 4);
    stamp(ctx, null, comic.resourceId, "2026-10-01T00:00:00.000Z");
    stamp(ctx, a, comic.resourceId, "2026-10-02T00:00:00.000Z");
    const latest = () => ctx.app.store.sqlite.prepare("SELECT context_id AS contextId FROM progress_latest WHERE resource_id = ?").get(comic.resourceId);
    expect(latest()).toEqual({ contextId: a });
    // A reader that is shown again reports the page it is on: the latest position stays where it was.
    await setPage(ctx, null, comic, 1);
    expect(latest()).toEqual({ contextId: a });
    expect(ctx.app.store.sqlite.prepare("SELECT last_interaction_at AS at FROM progress WHERE context_id = '' AND resource_id = ?").get(comic.resourceId)).toEqual({ at: "2026-10-01T00:00:00.000Z" });
    // Turning a page is a newer position.
    await setPage(ctx, null, comic, 2);
    expect(latest()).toEqual({ contextId: "" });
  });

  it("offers the latest position of another context to a context that has none, and nothing to one that has its own", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "在别处读到的漫画", pageCount: 8 });
    const a = await project(ctx, "项目甲");
    const b = await project(ctx, "项目乙");
    await setPage(ctx, null, comic, 1);
    await setPage(ctx, a, comic, 5);
    stamp(ctx, null, comic.resourceId, "2026-10-01T00:00:00.000Z");
    stamp(ctx, a, comic.resourceId, "2026-10-02T00:00:00.000Z");
    // A context that never opened the book restores nothing of its own and is told where the latest reading was.
    const inB = await get(ctx, b, comic.resourceId);
    expect(inB.locator).toBeNull();
    expect(inB.completion).toBe("new");
    expect(inB.elsewhere).toMatchObject({ contextId: a, contextName: "项目甲", locator: { kind: "image", pageId: comic.pageIds[5] } });
    // Contexts that have their own position are not offered another.
    expect((await get(ctx, a, comic.resourceId)).elsewhere).toBeNull();
    expect((await get(ctx, null, comic.resourceId)).elsewhere).toBeNull();
    // "最近" is named as such when it is the place the latest reading was.
    stamp(ctx, null, comic.resourceId, "2026-10-03T00:00:00.000Z");
    expect((await get(ctx, b, comic.resourceId)).elsewhere).toMatchObject({ contextId: null, contextName: "最近", locator: { pageId: comic.pageIds[1] } });
    // Opening in the context makes the position its own; the reader no longer offers to jump.
    await setPage(ctx, b, comic, 0);
    expect((await get(ctx, b, comic.resourceId)).elsewhere).toBeNull();
  });

  it("restores a position through library.read for the context it is asked in, and for 最近 when none is named", async () => {
    const ctx = await boot();
    const book = ok<{ resourceId: string; revisionId: string }>(await run(ctx, "library.importText", { title: "文本书", bytes: [...Buffer.from("第一段。".repeat(40) + "第二段。".repeat(40))] }));
    const a = await project(ctx, "读书项目");
    const locator = (start: number) => ({ kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: NORMALIZATION_V1, range: { start, end: start + 4 }, quote: { exact: "第一段。" } });
    ok(await run(ctx, "progress.set", { contextId: null, resourceId: book.resourceId, resourceRevisionId: book.revisionId, locator: locator(8), consumed: true }));
    ok(await run(ctx, "progress.set", { contextId: a, resourceId: book.resourceId, resourceRevisionId: book.revisionId, locator: locator(80), consumed: true }));
    const read = async (input: Record<string, unknown>) => ok<{ progress: { restoredFrom: string; locator?: { range: { start: number } } } }>(await run(ctx, "library.read", { resourceId: book.resourceId, ...input })).progress;
    expect((await read({})).locator?.range.start).toBe(8);
    expect((await read({ contextId: null })).locator?.range.start).toBe(8);
    expect(await read({ contextId: a })).toMatchObject({ restoredFrom: "progress", locator: { range: { start: 80 } } });
    const b = await project(ctx, "没读过的项目");
    expect((await read({ contextId: b })).restoredFrom).toBe("start");
  });
});

describe("the three readings of progress (plan 4.7)", () => {
  it("shows the latest position in any context on the work card, and says which context it is from", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "卡片上的漫画", pageCount: 10 });
    const a = await project(ctx, "项目甲");
    await setPage(ctx, null, comic, 8);
    await setPage(ctx, a, comic, 2);
    stamp(ctx, null, comic.resourceId, "2026-10-01T00:00:00.000Z");
    stamp(ctx, a, comic.resourceId, "2026-10-02T00:00:00.000Z");
    const listed = async () => (ok<{ items: Array<{ id: string; progress: number }> }>(await run(ctx, "works.list", {}))).items.find((item) => item.id === comic.workId)!;
    // The latest reading is the project's, which is nearer the start.
    expect((await listed()).progress).toBeCloseTo(0.3, 5);
    stamp(ctx, null, comic.resourceId, "2026-10-05T00:00:00.000Z");
    expect((await listed()).progress).toBeCloseTo(0.9, 5);
    expect(ctx.app.store.sqlite.prepare("SELECT context_id AS contextId FROM progress_latest WHERE resource_id = ?").get(comic.resourceId)).toEqual({ contextId: "" });
  });

  it("lets what has been read in any context through the spoiler guard, and shows the agent the same union", async () => {
    const ctx = await boot();
    const body = `${"甲甲甲甲甲。".repeat(30)}\n\n${"乙乙乙乙乙。".repeat(30)}`;
    const book = ok<{ resourceId: string; revisionId: string }>(await run(ctx, "library.importText", { title: "两处读的书", bytes: [...Buffer.from(body)] }));
    const a = await project(ctx, "项目甲");
    const mark = (start: number, end: number) => ({ kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: NORMALIZATION_V1, range: { start, end }, quote: { exact: body.slice(start, end) } });
    const find = async (text: string) => ok<unknown[]>(await run(ctx, "library.find", { text, resourceId: book.resourceId, withinProgress: true })).length;
    expect(await find("乙乙乙乙乙")).toBe(0);
    // Each context has read part of the text and neither all of it; together they have, and the guard lets it through because it has been read.
    ok(await run(ctx, "progress.set", { contextId: null, resourceId: book.resourceId, resourceRevisionId: book.revisionId, locator: mark(0, 200), consumed: true }));
    expect(await find("乙乙乙乙乙")).toBe(0);
    ok(await run(ctx, "progress.set", { contextId: a, resourceId: book.resourceId, resourceRevisionId: book.revisionId, locator: mark(150, 362), consumed: true }));
    expect(await find("乙乙乙乙乙")).toBeGreaterThan(0);
    // What each context restores is still its own, and what is farthest is the union.
    const recent = await get(ctx, null, book.resourceId);
    expect(recent.consumed).toEqual([{ partId: "body", start: 0, end: 200 }]);
    expect(recent.farthest.consumed).toEqual([{ partId: "body", start: 0, end: 362 }]);
    // The furthest position is the one the highest percent was reached at; it does not move the other contexts' positions.
    expect(recent.farthest.percent).toBeGreaterThan(recent.percent);
    expect(recent.locator).toMatchObject({ range: { start: 0, end: 200 } });
  });

  it("keeps the subtitle window of a video behind the furthest watched point of any context", async () => {
    const ctx = await boot();
    const video = seedVideo(ctx.app, { title: "两处看的视频", durationMs: 120_000 });
    const a = await project(ctx, "项目甲");
    const time = (contextId: string | null, timeMs: number) => run(ctx, "progress.setTime", { contextId, resourceId: video.resourceId, resourceRevisionId: video.revisionId, timeMs, played: [{ startMs: 0, endMs: timeMs }] });
    ok(await time(null, 20_000));
    ok(await time(a, 60_000));
    const recent = await get(ctx, null, video.resourceId);
    const inA = await get(ctx, a, video.resourceId);
    expect(recent.locator).toMatchObject({ kind: "temporal", startMs: 20_000 });
    expect(inA.locator).toMatchObject({ kind: "temporal", startMs: 60_000 });
    // Both see the same furthest point: the guard is about what the person has seen, not where they are now.
    expect(recent.farthest.locator).toMatchObject({ startMs: 60_000 });
    expect(recent.farthest.consumed).toEqual(inA.farthest.consumed);
    expect(recent.farthest.consumed).toEqual([{ partId: "$time", start: 0, end: 60_000 }]);
  });

  it("deletes a project's positions with the project, and leaves 最近 and the other projects as they were", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "项目删除前后", pageCount: 6 });
    const a = await project(ctx, "要删除的项目");
    const b = await project(ctx, "留下的项目");
    await setPage(ctx, null, comic, 1);
    await setPage(ctx, a, comic, 2);
    await setPage(ctx, b, comic, 3);
    ok(await run(ctx, "project.delete", { projectId: a }));
    expect(ctx.app.store.sqlite.prepare("SELECT context_id FROM progress WHERE resource_id = ? ORDER BY context_id").all(comic.resourceId)).toEqual([{ context_id: "" }, { context_id: b }]);
    expect((await get(ctx, null, comic.resourceId)).locator).toMatchObject({ pageId: comic.pageIds[1] });
    expect((await get(ctx, b, comic.resourceId)).locator).toMatchObject({ pageId: comic.pageIds[3] });
  });
});
