import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScanService, type ScanJob } from "../../packages/app-core/src/library-scan/service.ts";
import { scanHost } from "../../packages/app-core/src/commands/library-io.ts";
import { insertLocation, keepInManagedLibrary } from "../../packages/app-core/src/library-locations.ts";
import { startApp } from "../helpers/app.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>) {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `manual-rescan-${counter}`, input }, ctx.grant.handle);
}

const ok = <T = Record<string, unknown>>(result: Awaited<ReturnType<typeof run>>): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `manga-manual-scan-${prefix}-`));
}

function write(root: string, rel: string, body: string): string {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

const chapter = (title: string) => `${title}\n\n${"这是用于手动重新扫描清理测试的合成段落。".repeat(16)}\n`;

describe("manual rescan cleans up deleted resources and clears total overview content", () => {
  it("purges deleted works and unassigned resources without user content, while keeping surviving multi-chapter works accurate", async () => {
    const ctx = await startApp();
    const dir = scratch("purge");
    try {
      const fGoneWork = write(dir, "已删单行本.txt", chapter("单行本"));
      const fLoose = write(dir, "待拆散.txt", chapter("散落章节"));
      const fPartialGone = write(dir, "连载长篇/第1章.txt", chapter("第一章"));
      write(dir, "连载长篇/第2章.txt", chapter("第二章"));

      const added = ok<{ path: { id: string }; job: ScanJob }>(await run(ctx, "library.paths.add", {
        pathHandle: ctx.app.registerPath("directory", dir),
        mediaKind: "novel",
      }));
      await ctx.app.scan.whenIdle();

      const initialWorks = ok<{ items: Array<{ id: string; title: string; lastResource: { id: string; title: string } | null }> }>(await run(ctx, "works.list", {}));
      const goneWork = initialWorks.items.find((w) => w.title === "已删单行本")!;
      const looseWork = initialWorks.items.find((w) => w.title === "待拆散")!;
      const partialWork = initialWorks.items.find((w) => w.title === "连载长篇")!;
      expect(goneWork).toBeTruthy();
      expect(looseWork).toBeTruthy();
      expect(partialWork).toBeTruthy();

      // Turn 待拆散 into an unassigned resource and record recent progress on 已删单行本 (neither holds user-authored content).
      const deletedEntry = ok<{ resourceIds: string[] }>(await run(ctx, "works.delete", { workId: looseWork.id }));
      const looseResId = deletedEntry.resourceIds[0]!;
      expect(ok<{ total: number }>(await run(ctx, "works.unassigned", {})).total).toBe(1);

      const goneRevId = (ctx.app.store.sqlite.prepare("SELECT id FROM resource_revisions WHERE resource_id = ?").get(goneWork.lastResource!.id) as { id: string }).id;
      ctx.app.store.sqlite.prepare(
        "INSERT INTO progress(resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at, percent) VALUES (?,?,?,?,?,?,?)",
      ).run(goneWork.lastResource!.id, goneRevId, null, "[]", "reading", new Date().toISOString(), 0.5);

      // Make 第1章 the last opened resource of 连载长篇 before deleting 第1章 on disk.
      const ch1 = ctx.app.store.sqlite.prepare("SELECT id FROM resources WHERE work_id = ? AND title = '第1章'").get(partialWork.id) as { id: string };
      const ch2 = ctx.app.store.sqlite.prepare("SELECT id FROM resources WHERE work_id = ? AND title = '第2章'").get(partialWork.id) as { id: string };
      ok(await run(ctx, "works.open", { resourceId: ch1.id }));

      // Delete files on disk: all of 已删单行本, all of 待拆散 (unassigned), and chapter 1 of 连载长篇.
      fs.rmSync(fGoneWork);
      fs.rmSync(fLoose);
      fs.rmSync(fPartialGone);

      ok(await run(ctx, "library.scan.start", { pathId: added.path.id }));
      await ctx.app.scan.whenIdle();

      // Deleted single-file work and deleted unassigned resource are completely cleared.
      const afterWorks = ok<{ items: Array<{ id: string; title: string; missingCount: number; lastResource: { id: string; title: string } | null }>; total: number }>(await run(ctx, "works.list", {}));
      expect(afterWorks.items.map((w) => w.title)).toEqual(["连载长篇"]);
      expect(afterWorks.total).toBe(1);
      // Surviving multi-chapter work keeps missingCount = 1 and moves lastResource to the available chapter (第2章).
      expect(afterWorks.items[0]!.missingCount).toBe(1);
      expect(afterWorks.items[0]!.lastResource?.id).toBe(ch2.id);

      const afterUnassigned = ok<{ items: unknown[]; total: number }>(await run(ctx, "works.unassigned", {}));
      expect(afterUnassigned).toEqual({ items: [], total: 0 });

      const sidebar = ok<{ groups: Array<{ kind: string; sections: Array<{ items: Array<{ key: string }> }> }> }>(await run(ctx, "workspace.sidebar", {
        view: "home",
        open: [null],
      }));
      const allKeys = sidebar.groups.flatMap((g) => g.sections.flatMap((s) => s.items.map((i) => i.key)));
      expect(allKeys).not.toContain(`work:${goneWork.id}`);
      expect(allKeys).not.toContain(`resource:${looseResId}`);

      const found = ok<{ groups: Array<{ items: Array<{ key: string }> }> }>(await run(ctx, "workspace.find", { q: "已删单行本", perType: 10 }));
      expect(found.groups).toEqual([]);

      expect(ctx.app.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(goneWork.id)).toBeUndefined();
      expect(ctx.app.store.sqlite.prepare("SELECT 1 FROM resources WHERE id = ?").get(looseResId)).toBeUndefined();
    } finally {
      ctx.app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans up deleted works on manual rescan even when an earlier scheduled scan already marked them unavailable", async () => {
    const ctx = await startApp();
    const dir = scratch("after-auto");
    try {
      const file = write(dir, "旧番文件夹/第1话.txt", chapter("第一话"));
      const added = ok<{ path: { id: string } }>(await run(ctx, "library.paths.add", {
        pathHandle: ctx.app.registerPath("directory", dir),
        mediaKind: "novel",
      }));
      await ctx.app.scan.whenIdle();

      fs.rmSync(file);
      fs.rmdirSync(path.dirname(file));

      // Run an automatic scheduled scan first: marks unavailable, does not purge.
      let clock = 1_000_000;
      const events: string[] = [];
      const host = scanHost(ctx.app);
      const sched = new ScanService({
        store: ctx.app.store,
        host: { ...host, notify: (topic, payload) => { events.push(topic); host.notify(topic, payload); } },
        now: () => clock,
      });
      sched.setSchedule({ onStartup: false, intervalMinutes: 30 });
      clock += 31 * 60_000;
      sched.tick();
      await sched.whenIdle();

      expect(ok<{ total: number }>(await run(ctx, "works.list", {})).total).toBe(1);

      // Now trigger manual rescan: purges the previously-unavailable work and emits work.updated.
      events.length = 0;
      sched.start({ pathId: added.path.id, trigger: "manual" });
      await sched.whenIdle();

      expect(sched.status().recent[0]?.status, JSON.stringify(sched.status().recent[0])).toBe("done");
      expect(events).toContain("work.updated");
      expect(ok<{ total: number }>(await run(ctx, "works.list", {})).total).toBe(0);
      sched.dispose();
    } finally {
      ctx.app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves user-authored content (AT-77) while removing deleted items from unassigned, sidebar, and search", async () => {
    const ctx = await startApp();
    const dir = scratch("user-kept");
    try {
      const fKeptWork = write(dir, "有笔记作品.txt", chapter("带笔记正文"));
      const fKeptLoose = write(dir, "有书签散章.txt", chapter("带书签散章"));

      const added = ok<{ path: { id: string } }>(await run(ctx, "library.paths.add", {
        pathHandle: ctx.app.registerPath("directory", dir),
        mediaKind: "novel",
      }));
      await ctx.app.scan.whenIdle();

      const listed = ok<{ items: Array<{ id: string; title: string; lastResource: { id: string } | null }> }>(await run(ctx, "works.list", {}));
      const keptWork = listed.items.find((w) => w.title === "有笔记作品")!;
      const looseWork = listed.items.find((w) => w.title === "有书签散章")!;

      ok(await run(ctx, "works.setOverride", { workId: keptWork.id, fields: { author: "用户手写作者" }, locked: ["author"], cleared: [] }));

      const deletedLoose = ok<{ resourceIds: string[] }>(await run(ctx, "works.delete", { workId: looseWork.id }));
      const looseResId = deletedLoose.resourceIds[0]!;
      const looseRevId = (ctx.app.store.sqlite.prepare("SELECT id FROM resource_revisions WHERE resource_id = ?").get(looseResId) as { id: string }).id;
      ctx.app.store.sqlite.prepare(
        "INSERT INTO bookmarks(id, resource_id, resource_revision_id, label, locator_json, created_at) VALUES ('bm-loose', ?, ?, '重要书签', '{}', ?)",
      ).run(looseResId, looseRevId, new Date().toISOString());

      const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "研究项目" }));
      ok(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: keptWork.id }));

      fs.rmSync(fKeptWork);
      fs.rmSync(fKeptLoose);

      ok(await run(ctx, "library.scan.start", { pathId: added.path.id }));
      await ctx.app.scan.whenIdle();

      // User overrides & bookmarks survive in DB and detail endpoints (AT-77).
      const detail = ok<{ fields: { author: { value: string } } }>(await run(ctx, "works.get", { workId: keptWork.id }));
      expect(detail.fields.author.value).toBe("用户手写作者");
      const content = ok<{ bookmarks: Array<{ id: string }> }>(await run(ctx, "library.resourceContent", { resourceId: looseResId }));
      expect(content.bookmarks.map((b) => b.id)).toEqual(["bm-loose"]);

      // Unassigned list, sidebar, and find all exclude the deleted-file items; summary has missingCount === resourceCount and lastResource === null.
      expect(ok<{ items: unknown[]; total: number }>(await run(ctx, "works.unassigned", {}))).toEqual({ items: [], total: 0 });
      const summary = ok<{ items: Array<{ id: string; resourceCount: number; missingCount: number; lastResource: unknown }> }>(await run(ctx, "works.list", {})).items[0]!;
      expect(summary).toMatchObject({ id: keptWork.id, resourceCount: 1, missingCount: 1, lastResource: null });

      const sidebar = ok<{ groups: Array<{ sections: Array<{ items: Array<{ key: string }> }> }> }>(await run(ctx, "workspace.sidebar", {
        view: "home",
        open: [null, project.id],
      }));
      expect(sidebar.groups.flatMap((g) => g.sections.flatMap((s) => s.items))).toEqual([]);
      expect(ok<{ groups: unknown[] }>(await run(ctx, "workspace.find", { q: "有笔记作品", perType: 10 })).groups).toEqual([]);
    } finally {
      ctx.app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("promotes an active or queued startup/schedule scan to manual so deleted works are cleaned up", async () => {
    const ctx = await startApp();
    const dir = scratch("promote-trigger");
    try {
      const file = write(dir, "启动即删.txt", chapter("启动即删正文"));
      const added = ok<{ path: { id: string } }>(await run(ctx, "library.paths.add", {
        pathHandle: ctx.app.registerPath("directory", dir),
        mediaKind: "novel",
      }));
      await ctx.app.scan.whenIdle();
      expect(ok<{ total: number }>(await run(ctx, "works.list", {})).total).toBe(1);

      fs.rmSync(file);

      // Start an automatic startup scan, and immediately request manual rescan while it is active.
      const startupJob = ctx.app.scan.enqueue(added.path.id, "startup");
      const promotedJobs = ctx.app.scan.start({ pathId: added.path.id, trigger: "manual" });
      expect(promotedJobs[0]?.id).toBe(startupJob.id);
      expect(promotedJobs[0]?.trigger).toBe("manual");
      const dbTrigger = ctx.app.store.sqlite.prepare("SELECT trigger_kind FROM scan_jobs WHERE id = ?").get(startupJob.id) as { trigger_kind: string };
      expect(dbTrigger.trigger_kind).toBe("manual");

      await ctx.app.scan.whenIdle();
      expect(ok<{ total: number }>(await run(ctx, "works.list", {})).total).toBe(0);
    } finally {
      ctx.app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reconciles managed = 1 paths on manual full rescan (no pathId) without creating managed scan jobs", async () => {
    const ctx = await startApp();
    try {
      const placed = keepInManagedLibrary(ctx.app.store, "managed-deleted.txt", Buffer.from(chapter("托管目录作品")));
      const now = new Date().toISOString();
      ctx.app.store.commit({
        mutations: [
          { sql: "INSERT INTO works(id, title, created_at, media_kind, updated_at) VALUES ('w_managed', '托管目录作品', ?, 'novel', ?)", params: [now, now] },
          { sql: "INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES ('r_managed', 'w_managed', 'novel', '托管目录作品', '[]', ?)", params: [now] },
          { sql: "INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES ('rev_managed', 'r_managed', 'fp_m', '1', '{}', ?)", params: [now] },
          insertLocation({ revisionId: "rev_managed", placed, fingerprint: "fp_m" }),
        ],
        events: [],
      });

      expect(ok<{ total: number }>(await run(ctx, "works.list", {})).total).toBe(1);
      expect(() => ctx.app.scan.enqueue(placed.libraryPathId, "manual")).toThrow();

      const notifications: string[] = [];
      const origNotify = ctx.app.notify.bind(ctx.app);
      ctx.app.notify = ((topic: string, payload: unknown) => {
        notifications.push(topic);
        origNotify(topic, payload);
      }) as typeof ctx.app.notify;

      fs.rmSync(placed.absolute);

      const scanRes = ok<{ jobs: ScanJob[] }>(await run(ctx, "library.scan.start", {}));
      expect(scanRes.jobs).toEqual([]);
      expect(ctx.app.store.sqlite.prepare("SELECT 1 FROM scan_jobs WHERE path_id = ?").get(placed.libraryPathId)).toBeUndefined();
      expect(notifications).toContain("work.updated");
      expect(ok<{ total: number }>(await run(ctx, "works.list", {})).total).toBe(0);
      expect(ctx.app.store.sqlite.prepare("SELECT 1 FROM works WHERE id = 'w_managed'").get()).toBeUndefined();
    } finally {
      ctx.app.close();
    }
  });

  it("guards works spanning an unreachable drive and preserves resources referenced by rough_cut_clips", async () => {
    const ctx = await startApp();
    const dirA = scratch("drive-a");
    const dirB = scratch("drive-b");
    try {
      const fCrossA = write(dirA, "跨盘连载/第1章.txt", chapter("跨盘一"));
      const fCrossB = write(dirB, "跨盘连载_B/第2章.txt", chapter("跨盘二"));
      const fRoughCut = write(dirA, "粗剪素材.txt", chapter("粗剪引用"));

      const addedA = ok<{ path: { id: string } }>(await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", dirA), mediaKind: "novel" }));
      const addedB = ok<{ path: { id: string } }>(await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", dirB), mediaKind: "novel" }));
      await ctx.app.scan.whenIdle();

      const works = ok<{ items: Array<{ id: string; title: string; lastResource: { id: string } | null }> }>(await run(ctx, "works.list", {})).items;
      const crossWorkA = works.find((w) => w.title === "跨盘连载")!;
      const crossWorkB = works.find((w) => w.title === "跨盘连载_B")!;
      const roughWork = works.find((w) => w.title === "粗剪素材")!;

      // Move 第2章 (in dirB) into crossWorkA so crossWorkA spans dirA + dirB.
      const resInB = crossWorkB.lastResource!.id;
      ok(await run(ctx, "works.moveResource", { resourceId: resInB, toWorkId: crossWorkA.id }));

      // Reference roughWork's resource in rough_cut_clips.
      const roughResId = roughWork.lastResource!.id;
      const roughRevId = (ctx.app.store.sqlite.prepare("SELECT id FROM resource_revisions WHERE resource_id = ?").get(roughResId) as { id: string }).id;
      const now = new Date().toISOString();
      ctx.app.store.sqlite.prepare("INSERT INTO rough_cuts(id, project_id, title, created_at, updated_at) VALUES ('cut_1', NULL, '测试粗剪', ?, ?)").run(now, now);
      ctx.app.store.sqlite.prepare(
        "INSERT INTO rough_cut_clips(id, cut_id, resource_id, resource_revision_id, in_ms, out_ms, sort_key, label, created_at) VALUES ('clip_1', 'cut_1', ?, ?, 0, 1000, 'a', '', ?)",
      ).run(roughResId, roughRevId, now);

      // Mark resInB unavailable, then unmount/remove dirB entirely; also delete fCrossA and fRoughCut in dirA.
      fs.rmSync(fCrossB);
      let clock = 1_000_000;
      const sched = new ScanService({ store: ctx.app.store, host: scanHost(ctx.app), now: () => clock });
      sched.setSchedule({ onStartup: false, intervalMinutes: 30 });
      clock += 31 * 60_000;
      sched.tick();
      await sched.whenIdle();
      sched.dispose();

      fs.rmSync(dirB, { recursive: true, force: true });
      fs.rmSync(fCrossA);
      fs.rmSync(fRoughCut);

      // Manual rescan on dirA while dirB is unreachable: neither crossWorkA nor roughWork is purged!
      ok(await run(ctx, "library.scan.start", { pathId: addedA.path.id }));
      await ctx.app.scan.whenIdle();

      expect(ctx.app.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(crossWorkA.id)).toBeTruthy();
      expect(ctx.app.store.sqlite.prepare("SELECT 1 FROM resources WHERE id = ?").get(resInB)).toBeTruthy();
      expect(ctx.app.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(roughWork.id)).toBeTruthy();
      expect(ctx.app.store.sqlite.prepare("SELECT 1 FROM resources WHERE id = ?").get(roughResId)).toBeTruthy();

      // Once dirB is mounted again as an empty folder (both chapters genuinely deleted on reachable disks), manual rescan purges crossWorkA while keeping roughWork!
      fs.mkdirSync(dirB, { recursive: true });
      ok(await run(ctx, "library.scan.start", { pathId: addedB.path.id }));
      ok(await run(ctx, "library.scan.start", { pathId: addedA.path.id }));
      await ctx.app.scan.whenIdle();

      expect(ctx.app.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(crossWorkA.id)).toBeUndefined();
      expect(ctx.app.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(roughWork.id)).toBeTruthy();
    } finally {
      ctx.app.close();
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  it("preserves works and resources curated in project_materials or holding user/locked covers", async () => {
    const ctx = await startApp();
    const dir = scratch("user-guard");
    try {
      const fProjWork = write(dir, "项目作品.txt", chapter("项目内作品"));
      const fProjLoose = write(dir, "项目散章.txt", chapter("项目内散章"));
      const fUserCover = write(dir, "自定义封面作品.txt", chapter("自定义封面正文"));
      const added = ok<{ path: { id: string } }>(await run(ctx, "library.paths.add", {
        pathHandle: ctx.app.registerPath("directory", dir),
        mediaKind: "novel",
      }));
      await ctx.app.scan.whenIdle();

      const works = ok<{ items: Array<{ id: string; title: string }> }>(await run(ctx, "works.list", {})).items;
      const projWork = works.find((w) => w.title === "项目作品")!;
      const projLooseWork = works.find((w) => w.title === "项目散章")!;
      const coverWork = works.find((w) => w.title === "自定义封面作品")!;

      const looseResId = ok<{ resourceIds: string[] }>(await run(ctx, "works.delete", { workId: projLooseWork.id })).resourceIds[0]!;
      const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "精选项目" }));
      ok(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: projWork.id }));
      ok(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "resource", targetId: looseResId }));
      ctx.app.store.sqlite.prepare("UPDATE works SET cover_state = 'user' WHERE id = ?").run(coverWork.id);

      fs.rmSync(fProjWork);
      fs.rmSync(fProjLoose);
      fs.rmSync(fUserCover);

      ok(await run(ctx, "library.scan.start", { pathId: added.path.id }));
      await ctx.app.scan.whenIdle();

      expect(ctx.app.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(projWork.id)).toBeTruthy();
      expect(ctx.app.store.sqlite.prepare("SELECT 1 FROM resources WHERE id = ?").get(looseResId)).toBeTruthy();
      expect(ctx.app.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(coverWork.id)).toBeTruthy();
      expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM project_materials WHERE project_id = ?").get(project.id)).toEqual({ n: 2 });
    } finally {
      ctx.app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
