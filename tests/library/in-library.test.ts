import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NORMALIZATION_V1 } from "@manga/contracts";
import { startApp } from "../helpers/app.ts";

const ROOT = path.resolve(import.meta.dirname, "../..");

/**
 * Every query that lists resources for a person to open, by the function it is in (A-113, 计划 4.13). Each uses the one condition `inLibrarySql`;
 * a new list of resources is added here.
 */
const LISTS: Array<{ file: string; fn: string }> = [
  { file: "packages/app-core/src/works-service.ts", fn: "listWorks" },
  { file: "packages/app-core/src/works-service.ts", fn: "summarize" },
  { file: "packages/app-core/src/works-delete.ts", fn: "listUnassigned" },
  { file: "packages/app-core/src/sidebar-service.ts", fn: "entries" },
  { file: "packages/app-core/src/sidebar-service.ts", fn: "find" },
  { file: "packages/app-core/src/library-locations.ts", fn: "resourcesListed" },
  { file: "packages/app-core/src/commands/library-io.ts", fn: "libraryList" },
  { file: "packages/app-core/src/product-app.ts", fn: "workspace" },
];

/** The text of a function or method: from its name to the closing brace at its own indentation. */
function body(source: string, fn: string): string {
  const head = new RegExp(`^(\\s*)(?:export )?(?:async )?(?:function |private |public )?(?:async )?${fn}\\(`, "m").exec(source);
  if (!head) throw new Error(`${fn} not found`);
  const indent = head[1]!.replace(/\n/g, "");
  const end = source.indexOf(`\n${indent}}\n`, head.index);
  return source.slice(head.index, end < 0 ? undefined : end);
}

describe("AT-137 every list of resources shows only the ones in a library path", () => {
  it("uses the one condition in each query that lists resources", () => {
    for (const { file, fn } of LISTS) {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      expect(body(source, fn), `${file} ${fn}`).toContain("inLibrarySql(");
    }
  });

  const scratch: string[] = [];
  afterAll(() => { for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true }); });
  const tmp = (name: string) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `manga-inlib-${name}-`)); scratch.push(dir); return dir; };
  const text = (title: string) => `${title}\n\n${"这是用于资源库位置测试的一段合成文字。".repeat(20)}\n`;

  it("moves the resources of a removed path out of every list and into the outside section, back on adding it, and removes their records keeping what was made", async () => {
    const ctx = await startApp();
    let n = 0;
    const run = (commandId: string, input: Record<string, unknown>) => ctx.app.call(ctx.actor, { commandId, idempotencyKey: `inlib-${n += 1}`, input }, ctx.grant.handle);
    const ok = async <T = Record<string, any>>(commandId: string, input: Record<string, unknown>): Promise<T> => {
      const result = await run(commandId, input);
      expect(result.status, `${commandId} ${JSON.stringify(result)}`).toBe("ok");
      return result.value as T;
    };
    try {
      const kept = tmp("kept");
      const leaving = tmp("leaving");
      for (const [root, series] of [[kept, "甲系列"], [leaving, "乙系列"]] as const) {
        fs.mkdirSync(path.join(root, series), { recursive: true });
        fs.writeFileSync(path.join(root, series, "第1章.txt"), text(`${series}一`));
        fs.writeFileSync(path.join(root, series, "第2章.txt"), text(`${series}二`));
      }
      await ok("library.paths.add", { pathHandle: ctx.app.registerPath("directory", kept), mediaKind: "novel" });
      const added = await ok<{ path: { id: string } }>("library.paths.add", { pathHandle: ctx.app.registerPath("directory", leaving), mediaKind: "novel" });
      await ctx.app.scan.whenIdle();
      const db = ctx.app.store.sqlite;
      const work = (db.prepare("SELECT id FROM works WHERE title = '乙系列'").get() as { id: string }).id;
      const resources = (db.prepare("SELECT id FROM resources WHERE work_id = ? ORDER BY title").all(work) as Array<{ id: string }>).map((row) => row.id);
      // Something the person made on it: progress (the sidebar's recent list) and a note.
      const revision = (db.prepare("SELECT id FROM resource_revisions WHERE resource_id = ?").get(resources[0]) as { id: string }).id;
      await ok("progress.set", { contextId: null, resourceId: resources[0], resourceRevisionId: revision, locator: { kind: "text", partId: "body", representationId: revision, normalizationVersion: NORMALIZATION_V1, range: { start: 0, end: 4 } }, consumed: true });
      const note = await ok<{ objectId: string }>("notes.create", { title: "乙的笔记", text: "记下的话" });

      const listed = async () => ({
        works: (await ok<{ items: Array<{ id: string }> }>("works.list", { kind: "novel" })).items.map((item) => item.id),
        library: (await ok<{ items: Array<{ id: string }> }>("library.list", {})).items.map((item) => item.id),
        recent: (await ok<{ groups: Array<{ sections: Array<{ items: Array<{ key: string }> }> }> }>("workspace.sidebar", { view: "novel" })).groups.flatMap((group) => group.sections.flatMap((section) => section.items.map((item) => item.key))),
      });
      const before = await listed();
      expect(before.works).toContain(work);
      // A file that is gone from its place in a library path keeps its work listed, marked as not available.
      const keptWork = (db.prepare("SELECT id FROM works WHERE title = '甲系列'").get() as { id: string }).id;
      fs.rmSync(path.join(kept, "甲系列", "第2章.txt"));
      await ok("library.scan.start", {});
      await ctx.app.scan.whenIdle();
      const keptCard = (await ok<{ items: Array<{ id: string; missingCount: number; outsideCount: number }> }>("works.list", { kind: "novel" })).items.find((item) => item.id === keptWork);
      expect(keptCard).toMatchObject({ missingCount: 1, outsideCount: 0 });
      expect(before.library).toEqual(expect.arrayContaining(resources));
      expect(before.recent.join(" ")).toContain(work);

      await ok("library.paths.remove", { pathId: added.path.id });
      const after = await listed();
      expect(after.works).not.toContain(work);
      for (const id of resources) expect(after.library).not.toContain(id);
      expect(after.recent.join(" ")).not.toContain(work);
      const outside = await ok<{ total: number; groups: Array<{ folder: string | null; items: Array<{ resourceId: string }> }> }>("library.outside", {});
      expect(outside.total).toBe(2);
      expect(outside.groups.flatMap((group) => group.items.map((item) => item.resourceId)).sort()).toEqual([...resources].sort());
      expect(outside.groups[0]!.folder).toBe(path.join(leaving, "乙系列"));

      // Added again: the files are found where they were, in the work they were in.
      await ok("library.paths.add", { pathHandle: ctx.app.registerPath("directory", leaving), mediaKind: "novel" });
      await ctx.app.scan.whenIdle();
      expect((await listed()).works).toContain(work);
      expect((await ok<{ total: number }>("library.outside", {})).total).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM resources WHERE work_id = ?").get(work) as { n: number }).n).toBe(2);

      // Removed for good: the preview counts, a stale count is refused, and the records go while the note stays.
      const again = (db.prepare("SELECT id FROM library_paths WHERE path = ?").get(leaving) as { id: string }).id;
      // A note written on one of the resources keeps the work it is in until the records go.
      const onResource = await ok<{ objectId: string }>("notes.create", { title: "写在乙上的笔记", text: "资源上的话", resourceId: resources[1] });
      await ok("library.paths.remove", { pathId: again });
      const preview = await ok<{ resources: number; keep: { progress: number } }>("library.outsidePreview", {});
      expect(preview.resources).toBe(2);
      expect(preview.keep.progress).toBe(1);
      expect((await run("library.removeOutside", { expectedCount: 3 })).status).toBe("error");
      expect(await ok("library.removeOutside", { expectedCount: 2 })).toMatchObject({ removed: 2 });
      expect((db.prepare("SELECT COUNT(*) AS n FROM resources WHERE id IN (?, ?)").get(...resources) as { n: number }).n).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS n FROM progress WHERE resource_id = ?").get(resources[0]) as { n: number }).n).toBeGreaterThan(0);
      expect(await ok("notes.get", { objectId: note.objectId })).toMatchObject({ title: "乙的笔记" });
      // The note made on a removed resource stays, out of the work; the work, left with nothing of its own, is not listed again.
      expect(await ok("notes.get", { objectId: onResource.objectId })).toMatchObject({ title: "写在乙上的笔记" });
      expect((db.prepare("SELECT work_id AS workId FROM content_objects WHERE id = ?").get(onResource.objectId) as { workId: string | null }).workId).toBeNull();
      expect((await listed()).works).not.toContain(work);
      expect((await ok<{ total: number }>("library.outside", {})).total).toBe(0);
      const logged = db.prepare("SELECT COUNT(*) AS n FROM operation_log WHERE action = 'library.removeOutside'").get() as { n: number } | undefined;
      expect(logged?.n ?? 0).toBeGreaterThan(0);
    } finally { ctx.app.close(); }
  }, 120_000);
});
