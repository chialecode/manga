import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { requireSamples, samplePath } from "../helpers/samples.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Result = Awaited<ReturnType<App["app"]["call"]>>;
let counter = 0;
const run = (ctx: App, commandId: string, input: Record<string, unknown>) => ctx.app.call(ctx.actor, { commandId, idempotencyKey: `ur-${counter += 1}`, input }, ctx.grant.handle);
const ok = <T = Record<string, any>>(result: Result): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};

const scratch: string[] = [];
afterAll(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });
const tmp = (name: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `manga-ur-${name}-`)); scratch.push(dir); return dir; };
const text = (title: string) => `${title}\n\n${"这是用于未归入作品测试的一段合成文字。".repeat(20)}\n`;

/** One library path per medium, two works in each, scanned as a person would. */
async function library(ctx: App) {
  const roots = { novel: tmp("novel"), comic: tmp("comic"), video: tmp("video") };
  for (const series of ["甲", "乙"]) {
    const novel = path.join(roots.novel, `${series}系列`);
    fs.mkdirSync(novel, { recursive: true });
    fs.writeFileSync(path.join(novel, "第1章.txt"), text(`${series}一`));
    fs.writeFileSync(path.join(novel, "第2章.txt"), text(`${series}二`));
    const comic = path.join(roots.comic, `${series}漫画`);
    fs.mkdirSync(comic, { recursive: true });
    fs.copyFileSync(samplePath("cbz-basic"), path.join(comic, `${series}漫画 01.cbz`));
    const video = path.join(roots.video, `${series}动画`);
    fs.mkdirSync(video, { recursive: true });
    fs.copyFileSync(samplePath("video-mp4-h264-aac"), path.join(video, `${series}动画 - 01.mp4`));
  }
  for (const kind of ["novel", "comic", "video"] as const) ok(await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", roots[kind]), mediaKind: kind }));
  await ctx.app.scan.whenIdle();
  return roots;
}

const worksOf = (ctx: App, kind: string) => ctx.app.store.sqlite.prepare("SELECT id, title FROM works WHERE media_kind = ? ORDER BY title").all(kind) as Array<{ id: string; title: string }>;
const resourcesOf = (ctx: App, workId: string) => (ctx.app.store.sqlite.prepare("SELECT id FROM resources WHERE work_id = ? ORDER BY title").all(workId) as Array<{ id: string }>).map((row) => row.id);
const OPEN: Record<string, (resourceId: string) => [string, Record<string, unknown>]> = {
  novel: (resourceId) => ["library.read", { resourceId }],
  comic: (resourceId) => ["comic.pages", { resourceId }],
  video: (resourceId) => ["video.playbackPlan", { resourceId }],
};

describe.skipIf(mediaPrerequisitesAbsent)("AT-137 the resources in no work can all be opened, put in a work and matched", () => {
  requireSamples(["cbz-basic", "video-mp4-h264-aac"]);

  it("opens, assigns and matches, for each medium, a resource whose entry was deleted", async () => {
    const ctx = await startApp();
    try {
      await library(ctx);
      for (const kind of ["novel", "comic", "video"] as const) {
        const [gone, kept] = worksOf(ctx, kind);
        expect(gone && kept, kind).toBeTruthy();
        const loose = resourcesOf(ctx, gone!.id);
        ok(await run(ctx, "works.delete", { workId: gone!.id }));
        const listed = ok<{ items: Array<{ resourceId: string; outside: boolean }> }>(await run(ctx, "works.unassigned", { kind }));
        expect(listed.items.map((item) => item.resourceId).sort(), kind).toEqual([...loose].sort());
        expect(listed.items.every((item) => !item.outside), kind).toBe(true);
        for (const resourceId of loose) {
          expect(ok(await run(ctx, "library.openable", { resourceId })), `${kind} openable`).toMatchObject({ state: "open" });
          const [commandId, input] = OPEN[kind]!(resourceId);
          ok(await run(ctx, commandId, input));
        }
        // Into the other work of the medium, and a work of its own for the match.
        ok(await run(ctx, "works.moveResource", { resourceId: loose[0]!, toWorkId: kept!.id }));
        if (loose[1]) ok(await run(ctx, "works.moveResource", { resourceId: loose[1], newWorkTitle: `${gone!.title}（重建）` }));
      }
    } finally { ctx.app.close(); }
  }, 120_000);

  it("lists only the loose resources in a library path: one whose path is gone cannot be opened and is in the outside section", async () => {
    // The path that failed for the person: an entry deleted, then its library path taken away; the group listed resources that only answered "outside".
    const ctx = await startApp();
    try {
      await library(ctx);
      const [gone] = worksOf(ctx, "novel");
      const loose = resourcesOf(ctx, gone!.id);
      ok(await run(ctx, "works.delete", { workId: gone!.id }));
      const pathId = (ctx.app.store.sqlite.prepare("SELECT id FROM library_paths WHERE media_kind = 'novel'").get() as { id: string }).id;
      ok(await run(ctx, "library.paths.remove", { pathId }));
      expect(ok<{ state: string }>(await run(ctx, "library.openable", { resourceId: loose[0]! })).state).toBe("outside");
      expect(ok<{ total: number }>(await run(ctx, "works.unassigned", {})).total).toBe(0);
      const outside = ok<{ groups: Array<{ items: Array<{ resourceId: string }> }> }>(await run(ctx, "library.outside", {}));
      // The whole path went: the other work of the medium is outside too.
      expect(outside.groups.flatMap((group) => group.items.map((item) => item.resourceId))).toEqual(expect.arrayContaining(loose));
      // Re-identifying asks for a file in a library path.
      expect((await run(ctx, "works.reidentify", { resourceIds: [loose[0]!] })).status).toBe("error");
    } finally { ctx.app.close(); }
  }, 120_000);

  it("re-identifies loose resources the way a scan groups them: a new work for a folder whose work was deleted, the folder's work when it has one", async () => {
    const ctx = await startApp();
    try {
      await library(ctx);
      const [gone, other] = worksOf(ctx, "comic");
      const loose = resourcesOf(ctx, gone!.id);
      ok(await run(ctx, "works.delete", { workId: gone!.id }));
      const done = ok<{ results: Array<{ resourceId: string; workId: string; created: boolean }> }>(await run(ctx, "works.reidentify", { resourceIds: loose }));
      expect(done.results).toHaveLength(loose.length);
      expect(done.results[0]!.created).toBe(true);
      // Not merged into the other work of the medium, and named after its folder.
      expect(done.results[0]!.workId).not.toBe(other!.id);
      const made = ctx.app.store.sqlite.prepare("SELECT title, media_kind AS kind FROM works WHERE id = ?").get(done.results[0]!.workId) as { title: string; kind: string };
      expect(made).toEqual({ title: gone!.title, kind: "comic" });
      expect(ok<{ total: number }>(await run(ctx, "works.unassigned", { kind: "comic" })).total).toBe(0);

      // A resource taken out of a work whose folder still has it goes back into that work.
      const [novel] = worksOf(ctx, "novel");
      const chapters = resourcesOf(ctx, novel!.id);
      const out = ok<{ workId: string }>(await run(ctx, "works.moveResource", { resourceId: chapters[0]!, newWorkTitle: "临时" }));
      ok(await run(ctx, "works.delete", { workId: out.workId }));
      const back = ok<{ results: Array<{ workId: string; created: boolean }> }>(await run(ctx, "works.reidentify", { resourceIds: [chapters[0]!] }));
      expect(back.results[0]).toEqual({ resourceId: chapters[0], workId: novel!.id, created: false });
      // A resource in a work is not re-identified.
      expect((await run(ctx, "works.reidentify", { resourceIds: [chapters[1]!] })).status).toBe("error");
      // An agent cannot.
      const agent = { kind: "agent" as const, id: "agent-ri" };
      const grant = ctx.app.issueAgentGrant(ctx.grant, agent, { sessionId: "s", runId: "r", readResourceIds: chapters });
      for (const [commandId, input] of [["works.reidentify", { resourceIds: [chapters[0]!] }], ["library.outside", {}], ["library.outsidePreview", {}], ["library.removeOutside", { expectedCount: 0 }]] as const) {
        expect((await ctx.app.call(agent, { commandId, idempotencyKey: `ri-${commandId}`, input: input as Record<string, unknown> }, grant.handle)).status, commandId).toBe("error");
      }
    } finally { ctx.app.close(); }
  }, 120_000);
});
