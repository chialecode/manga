import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { seedComic } from "../helpers/media-seed.ts";

/**
 * What opening something inside a project adds to it (A-95, Q-33 item 2): a reference with the origin "auto" that the person can take out, and that
 * opening again does not bring back. Adding by hand always works and lifts the mark.
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
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `pmo-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
type Material = { id: string; kind: string; targetId: string; origin: "manual" | "auto" };
const materials = async (ctx: App, projectId: string) => ok<{ materials: Material[] }>(await run(ctx, "project.get", { projectId })).materials;
const exclusions = (ctx: App, projectId: string) => ctx.app.store.sqlite.prepare("SELECT kind, target_id FROM project_material_exclusions WHERE project_id = ?").all(projectId);

describe("references that opening something adds to a project (Q-33)", () => {
  it("adds a reference with origin auto, once, and leaves a reference that is already there as it is", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "打开后加入", pageCount: 3 });
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "自动加入" }));
    const first = ok<Material>(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: comic.workId, origin: "auto" }));
    expect(first).toMatchObject({ kind: "work", targetId: comic.workId, origin: "auto" });
    // Opening it again, or adding it by hand, finds it there and changes nothing.
    const again = ok<Material>(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: comic.workId, origin: "auto" }));
    const byHand = ok<Material>(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: comic.workId }));
    expect([again.id, byHand.id]).toEqual([first.id, first.id]);
    expect(byHand.origin).toBe("auto");
    expect(await materials(ctx, project.id)).toHaveLength(1);
    // What the person adds on their own is a manual reference.
    const note = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "手动笔记", text: "正文" }));
    expect(ok<Material>(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "note", targetId: note.objectId })).origin).toBe("manual");
  });

  it("does not bring back what the person took out, until they add it by hand", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "被移出的材料", pageCount: 3 });
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "移出之后" }));
    const added = ok<Material>(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: comic.workId, origin: "auto" }));
    ok(await run(ctx, "project.removeMaterial", { projectId: project.id, materialId: added.id }));
    expect(await materials(ctx, project.id)).toEqual([]);
    expect(exclusions(ctx, project.id)).toEqual([{ kind: "work", target_id: comic.workId }]);

    // Opening it in the project again adds nothing and says why.
    expect(ok(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: comic.workId, origin: "auto" }))).toEqual({ skipped: "excluded" });
    expect(await materials(ctx, project.id)).toEqual([]);
    // Another project is not affected by what was taken out of this one.
    const other = ok<{ id: string }>(await run(ctx, "project.create", { name: "另一个项目" }));
    expect(ok<Material>(await run(ctx, "project.addMaterial", { projectId: other.id, kind: "work", targetId: comic.workId, origin: "auto" })).origin).toBe("auto");

    // Adding it by hand works and lifts the mark; after that, opening it finds it there.
    const back = ok<Material>(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: comic.workId }));
    expect(back.origin).toBe("manual");
    expect(exclusions(ctx, project.id)).toEqual([]);
    expect(ok<Material>(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: comic.workId, origin: "auto" })).id).toBe(back.id);
  });

  it("forgets the marks with the project, and refuses what does not exist", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "随项目删除", pageCount: 2 });
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "要删除的" }));
    const added = ok<Material>(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: comic.workId, origin: "auto" }));
    ok(await run(ctx, "project.removeMaterial", { projectId: project.id, materialId: added.id }));
    expect(exclusions(ctx, project.id)).toHaveLength(1);
    expect((await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: "work-none", origin: "auto" })).error?.code).toBe("NOT_FOUND");
    expect((await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: comic.workId, origin: "other" })).error?.code).toBe("VALIDATION_ERROR");
    ok(await run(ctx, "project.delete", { projectId: project.id }));
    expect(exclusions(ctx, project.id)).toEqual([]);
  });
});
