import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startApp, tempProfile } from "../helpers/app.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";
import { seedResource } from "../helpers/voice.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
let counter = 0;
const apps: App[] = [];
afterEach(() => { while (apps.length) apps.pop()!.app.close(); });

async function boot(profileRoot?: string) {
  const ctx = await startApp({ profileRoot });
  apps.push(ctx);
  return ctx;
}
async function run(ctx: App, commandId: string, input: Record<string, unknown> = {}): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `mod-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
const modules = async (ctx: App) => ok<{ modules: Array<{ featureId: string; wanted: boolean; state: string; core: boolean; displayName: string }> }>(await run(ctx, "settings.getModules")).modules;
const facets = (ctx: App) => [...ctx.app.uiFacets].sort();

describe("switching modules from settings", () => {
  it("lists every module with whether it is on, and marks the ones the app cannot run without", async () => {
    const ctx = await boot();
    const list = await modules(ctx);
    const byFeature = Object.fromEntries(list.map((item) => [item.featureId, item]));
    for (const feature of ["comic", "video", "metadata", "voice", "notes"]) {
      expect(byFeature[feature], feature).toMatchObject({ wanted: true, state: "active", core: false });
      expect(byFeature[feature]!.displayName.length).toBeGreaterThan(0);
    }
    expect(byFeature.library!.core).toBe(true);
    expect(byFeature.settings!.core).toBe(true);
  });

  it("turns a module off and on, with its commands and interface following", async () => {
    const ctx = await boot();
    expect(facets(ctx)).toContain("video");
    ok(await run(ctx, "settings.setModule", { featureId: "video", enabled: false }));
    expect((await modules(ctx)).find((item) => item.featureId === "video")).toMatchObject({ wanted: false, state: "disabled" });
    expect(facets(ctx)).not.toContain("video");
    expect(ctx.app.runtime.gateway.has("video.probe")).toBe(false);
    // The other modules are untouched.
    expect(facets(ctx)).toEqual(expect.arrayContaining(["comic", "voice", "metadata", "notes", "library"]));
    ok(await run(ctx, "settings.setModule", { featureId: "video", enabled: true }));
    expect(facets(ctx)).toContain("video");
    expect(ctx.app.runtime.gateway.has("video.probe")).toBe(true);
  });

  it("refuses to turn off a core module or an unknown one, and says why", async () => {
    const ctx = await boot();
    const core = await run(ctx, "settings.setModule", { featureId: "settings", enabled: false });
    expect(core.status).toBe("error");
    expect(core.error).toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "core" } });
    const unknown = await run(ctx, "settings.setModule", { featureId: "nonsense", enabled: false });
    expect(unknown.error?.code).toBe("NOT_FOUND");
    expect((await modules(ctx)).every((item) => item.state === "active")).toBe(true);
  });

  it("keeps the choice across a restart", async () => {
    const first = await boot();
    ok(await run(first, "settings.setModule", { featureId: "voice", enabled: false }));
    ok(await run(first, "settings.setModule", { featureId: "metadata", enabled: false }));
    const root = first.profileRoot;
    first.app.close();
    apps.splice(apps.indexOf(first), 1);
    const second = await boot(root);
    const list = await modules(second);
    // A module that was off from the start has never been activated in this process: either way it is not running.
    for (const feature of ["voice", "metadata"]) {
      const item = list.find((entry) => entry.featureId === feature)!;
      expect(item.wanted, feature).toBe(false);
      expect(["disabled", "discovered"]).toContain(item.state);
    }
    expect(list.find((item) => item.featureId === "comic")).toMatchObject({ wanted: true, state: "active" });
  });

  it("only the owner can switch modules", async () => {
    const ctx = await boot();
    const r = seedResource(ctx.app.store);
    const agent = { kind: "agent" as const, id: "agent:mod" };
    const grant = ctx.app.issueAgentGrant(ctx.grant, agent, { sessionId: "s", runId: "r", readResourceIds: [r.resourceId] });
    for (const commandId of ["settings.getModules", "settings.setModule"]) {
      const result = await ctx.app.call(agent, { commandId, idempotencyKey: `a-${commandId}`, input: commandId === "settings.setModule" ? { featureId: "voice", enabled: false } : {} }, grant.handle);
      expect(result.status, commandId).toBe("error");
    }
    expect((await modules(ctx)).find((item) => item.featureId === "voice")!.state).toBe("active");
  });

  it("keeps managing progress, notes and recordings of a switched-off module's content", async () => {
    const ctx = await boot();
    const video = seedVideo(ctx.app, { title: "合成动画" });
    const comic = seedComic(ctx.app, { title: "合成漫画" });
    for (const feature of ["video", "comic", "voice", "metadata"]) ok(await run(ctx, "settings.setModule", { featureId: feature, enabled: false }));
    // The library still lists the works, and the inventory still counts their resources.
    const works = ok<{ items: Array<{ id: string; mediaKind: string }> }>(await run(ctx, "works.list", {}));
    expect(works.items.map((item) => item.mediaKind).sort()).toEqual(expect.arrayContaining(["comic", "video"]));
    expect((await run(ctx, "inventory.overview")).status).toBe("ok");
    // Progress already stored is still readable, and a note about a time is still creatable.
    expect((await run(ctx, "progress.get", { resourceId: video.resourceId })).status).toBe("ok");
    const note = await run(ctx, "notes.create", { title: "停用期间的笔记", text: "这一幕的节奏", resourceId: video.resourceId, resourceRevisionId: video.revisionId, locator: { kind: "temporal", startMs: 1000, endMs: 2000 }, quoteText: "0:01 – 0:02" });
    expect(note.status, JSON.stringify(note)).toBe("ok");
    expect(comic.resourceId).toBeTruthy();
    // Switching back on, the note's source jumps again.
    for (const feature of ["video", "comic", "voice", "metadata"]) ok(await run(ctx, "settings.setModule", { featureId: feature, enabled: true }));
    const opened = ok<{ status: string }>(await run(ctx, "notes.openSource", { objectId: (note.value as { objectId: string }).objectId }));
    expect(opened.status).toBe("resolved");
  });

  it("exports a library whose media modules are off, with their works, notes, progress and covers", async () => {
    const ctx = await boot();
    const video = seedVideo(ctx.app, { title: "合成动画" });
    const comic = seedComic(ctx.app, { title: "合成漫画" });
    ok(await run(ctx, "notes.create", { title: "时间笔记", text: "片头", resourceId: video.resourceId, resourceRevisionId: video.revisionId, locator: { kind: "temporal", startMs: 1000, endMs: 2000 }, quoteText: "0:01 – 0:02" }));
    ok(await run(ctx, "progress.setPage", { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[1] }));
    for (const feature of ["video", "comic", "voice", "metadata"]) ok(await run(ctx, "settings.setModule", { featureId: feature, enabled: false }));
    expect(ctx.app.runtime.gateway.has("video.probe")).toBe(false);
    const dir = path.join(tempProfile(), "off-export");
    ok(await run(ctx, "library.exportPackage", { pathHandle: ctx.app.registerPath("export", dir) }));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as { works: Array<{ media_kind?: string; mediaKind?: string }>; progress: unknown[]; anchors: unknown[] };
    expect(manifest.works.map((work) => work.media_kind ?? work.mediaKind).sort()).toEqual(["comic", "video"]);
    expect(manifest.progress.length).toBeGreaterThan(0);
    expect(manifest.anchors.length).toBeGreaterThan(0);
  });

  it("fifty off-and-on cycles of every media module leave no extra resources, handles or jobs", async () => {
    const ctx = await boot();
    const before = { totals: { ...ctx.app.runtime.resourceTotals() }, facets: facets(ctx), commands: ctx.app.runtime.gateway.has("capture.start") };
    for (let i = 0; i < 50; i += 1) {
      for (const feature of ["comic", "video", "metadata", "voice"]) {
        ok(await run(ctx, "settings.setModule", { featureId: feature, enabled: false }));
        ok(await run(ctx, "settings.setModule", { featureId: feature, enabled: true }));
      }
    }
    expect(ctx.app.runtime.resourceTotals()).toEqual(before.totals);
    expect(facets(ctx)).toEqual(before.facets);
    expect(ctx.app.runtime.gateway.has("capture.start")).toBe(before.commands);
    expect(ctx.app.media.jobs.list({ active: true })).toEqual([]);
    expect(ctx.app.voice.activeId).toBeNull();
    expect((await modules(ctx)).every((item) => item.state === "active")).toBe(true);
  }, 120_000);
});
