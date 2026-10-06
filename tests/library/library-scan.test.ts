import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ScanService, type ScanHost, type ScanJob } from "../../packages/app-core/src/library-scan/service.ts";
import { planScan, type WalkEntry } from "../../packages/app-core/src/library-scan/plan.ts";
import { startApp } from "../helpers/app.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>, grantHandle = ctx.grant.handle, actor: { kind: "user" | "agent"; id: string } = ctx.actor) {
  counter += 1;
  return ctx.app.call(actor, { commandId, idempotencyKey: `scan-${counter}`, input }, grantHandle);
}
const ok = <T = Record<string, any>>(result: Awaited<ReturnType<typeof run>>): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `manga-scan-${prefix}-`));
}
function write(root: string, rel: string, body: string): string {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}
const chapter = (title: string) => `${title}\n\n${"这是用于扫描测试的一段合成文字。".repeat(20)}\n`;

async function addPath(ctx: App, dir: string, mediaKind: "novel" | "comic" | "video") {
  const added = ok<{ path: { id: string }; job: ScanJob }>(await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", dir), mediaKind }));
  await ctx.app.scan.whenIdle();
  return added;
}
const lastJob = (ctx: App) => ctx.app.scan.status().recent[0]!;
const count = (ctx: App, sql: string, ...params: unknown[]) => (ctx.app.store.sqlite.prepare(sql).get(...params as never[]) as { n: number }).n;

describe("library paths and the background scan", () => {
  it("reads a path into works by folder, skips what did not change, and picks up what did", async () => {
    const ctx = await startApp();
    const dir = scratch("novel");
    try {
      write(dir, "单卷.txt", chapter("单卷"));
      write(dir, "长篇/第1卷.txt", chapter("第一卷"));
      write(dir, "长篇/第2卷.txt", chapter("第二卷"));
      write(dir, "长篇/readme.docx", "not a book");
      const { path: added } = await addPath(ctx, dir, "novel");
      const first = lastJob(ctx);
      expect(first).toMatchObject({ status: "done", added: 3, failed: 0, unavailable: 0 });
      // One work per folder, and a file directly in the path is a work of its own.
      const works = ctx.app.store.sqlite.prepare("SELECT w.title, COUNT(r.id) AS n FROM works w JOIN resources r ON r.work_id = w.id GROUP BY w.id ORDER BY w.title").all() as Array<{ title: string; n: number }>;
      expect(works.map((work) => [work.title, work.n])).toEqual([["单卷", 1], ["长篇", 2]]);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM library_files WHERE path_id = ? AND state = 'present'", added.id)).toBe(3);

      // Nothing changed: nothing is read again.
      ok(await run(ctx, "library.scan.start", { pathId: added.id }));
      await ctx.app.scan.whenIdle();
      expect(lastJob(ctx)).toMatchObject({ status: "done", added: 0, changed: 0, skipped: 3 });
      expect(count(ctx, "SELECT COUNT(*) AS n FROM resources")).toBe(3);

      // A new file in a known folder joins that folder's work; a rewritten file becomes a new revision of the same resource.
      write(dir, "长篇/第3卷.txt", chapter("第三卷"));
      write(dir, "单卷.txt", chapter("单卷（修订）"));
      ok(await run(ctx, "library.scan.start", {}));
      await ctx.app.scan.whenIdle();
      expect(lastJob(ctx)).toMatchObject({ status: "done", added: 1, changed: 1 });
      expect(count(ctx, "SELECT COUNT(*) AS n FROM works")).toBe(2);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM resources")).toBe(4);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM resource_revisions")).toBe(5);
    } finally { ctx.app.close(); }
  });

  it("marks a file that vanished as unavailable instead of deleting it, and recovers it when it returns", async () => {
    const ctx = await startApp();
    const dir = scratch("gone");
    try {
      write(dir, "系列/一.txt", chapter("一"));
      write(dir, "系列/二.txt", chapter("二"));
      const { path: added } = await addPath(ctx, dir, "novel");
      const resourceId = (ctx.app.store.sqlite.prepare("SELECT resource_id AS id FROM library_files WHERE relative_path = '系列/二.txt'").get() as { id: string }).id;
      // The user has read it: progress and notes must outlive the file.
      ctx.app.store.sqlite.prepare("INSERT INTO bookmarks(id, resource_id, resource_revision_id, label, locator_json, created_at) SELECT 'bm-keep', r.id, v.id, 'keep', '{}', ? FROM resources r JOIN resource_revisions v ON v.resource_id = r.id WHERE r.id = ?").run(new Date().toISOString(), resourceId);
      fs.rmSync(path.join(dir, "系列", "二.txt"));
      ok(await run(ctx, "library.scan.start", { pathId: added.id }));
      await ctx.app.scan.whenIdle();
      expect(lastJob(ctx)).toMatchObject({ status: "done", unavailable: 1, added: 0 });
      expect(count(ctx, "SELECT COUNT(*) AS n FROM resources")).toBe(2);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM bookmarks WHERE id = 'bm-keep'")).toBe(1);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM library_files WHERE state = 'unavailable'")).toBe(1);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM file_locations fl JOIN resource_revisions v ON v.id = fl.resource_revision_id WHERE v.resource_id = ? AND fl.available = 0", resourceId)).toBe(1);
      const listed = ok<{ paths: Array<{ files: { present: number; unavailable: number } }> }>(await run(ctx, "library.paths.list", {}));
      expect(listed.paths[0]!.files).toMatchObject({ present: 1, unavailable: 1 });

      // The same file comes back at the same place: it is simply available again, with no second resource.
      write(dir, "系列/二.txt", chapter("二"));
      ok(await run(ctx, "library.scan.start", {}));
      await ctx.app.scan.whenIdle();
      expect(count(ctx, "SELECT COUNT(*) AS n FROM resources")).toBe(2);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM library_files WHERE state = 'unavailable'")).toBe(0);
    } finally { ctx.app.close(); }
  });

  it("names a text book after its file, not after its first line, whether scanned or imported", async () => {
    const ctx = await startApp();
    const dir = scratch("title");
    try {
      // The first line of a text file is usually a chapter heading, the same in every volume.
      write(dir, "迷雾.txt", chapter("第一章"));
      write(dir, "长篇/上卷.txt", chapter("第一章 开端"));
      write(dir, "长篇/下卷.txt", chapter("第一章 开端"));
      await addPath(ctx, dir, "novel");
      const rows = ctx.app.store.sqlite.prepare("SELECT w.title AS work, r.title FROM resources r JOIN works w ON w.id = r.work_id ORDER BY w.title, r.title").all() as Array<{ work: string; title: string }>;
      expect(rows).toEqual([{ work: "迷雾", title: "迷雾" }, { work: "长篇", title: "上卷" }, { work: "长篇", title: "下卷" }]);
      const imported = ok<{ resourceId: string }>(await run(ctx, "library.importDocument", { title: "单本导入", format: "txt", bytes: [...new TextEncoder().encode(chapter("序章"))] }));
      const single = ctx.app.store.sqlite.prepare("SELECT w.title AS work, r.title FROM resources r JOIN works w ON w.id = r.work_id WHERE r.id = ?").get(imported.resourceId);
      expect(single).toEqual({ work: "单本导入", title: "单本导入" });
    } finally { ctx.app.close(); }
  });

  it("follows a file that moved to another folder instead of importing it a second time", async () => {
    const ctx = await startApp();
    const dir = scratch("move");
    try {
      write(dir, "旧目录/故事.txt", chapter("故事"));
      const { path: added } = await addPath(ctx, dir, "novel");
      const before = ctx.app.store.sqlite.prepare("SELECT resource_id AS id, resource_revision_id AS revisionId FROM library_files WHERE path_id = ?").get(added.id) as { id: string; revisionId: string };
      fs.mkdirSync(path.join(dir, "新目录"));
      fs.renameSync(path.join(dir, "旧目录", "故事.txt"), path.join(dir, "新目录", "故事.txt"));
      fs.rmdirSync(path.join(dir, "旧目录"));
      ok(await run(ctx, "library.scan.start", {}));
      await ctx.app.scan.whenIdle();
      expect(lastJob(ctx)).toMatchObject({ status: "done", added: 0, unavailable: 0 });
      expect(count(ctx, "SELECT COUNT(*) AS n FROM resources")).toBe(1);
      const after = ctx.app.store.sqlite.prepare("SELECT relative_path AS rel, resource_id AS id, state FROM library_files WHERE path_id = ?").all(added.id) as Array<{ rel: string; id: string; state: string }>;
      expect(after).toEqual([{ rel: "新目录/故事.txt", id: before.id, state: "present" }]);
      const location = ctx.app.store.sqlite.prepare("SELECT relative_path AS file, available FROM file_locations WHERE resource_revision_id = ?").get(before.revisionId) as { file: string; available: number };
      expect(location.available).toBe(1);
      expect(location.file.replaceAll("\\", "/").endsWith("新目录/故事.txt")).toBe(true);
    } finally { ctx.app.close(); }
  });

  it("reads comic folders into chapters of one work with their natural order, and a CBZ-free path of images too", async () => {
    const ctx = await startApp();
    const dir = scratch("comic");
    try {
      const png = await sharp({ create: { width: 40, height: 60, channels: 3, background: "#789" } }).png().toBuffer();
      for (const chapterName of ["第10话", "第2话", "第1话"]) for (const page of ["1.png", "2.png"]) {
        const file = path.join(dir, "某漫画", chapterName, page);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, png);
      }
      await addPath(ctx, dir, "comic");
      expect(lastJob(ctx)).toMatchObject({ status: "done", added: 3, failed: 0 });
      const rows = ctx.app.store.sqlite.prepare("SELECT w.title AS work, w.media_kind AS kind, r.title FROM resources r JOIN works w ON w.id = r.work_id ORDER BY r.sort_key").all() as Array<{ work: string; kind: string; title: string }>;
      expect(rows.map((row) => row.work)).toEqual(["某漫画", "某漫画", "某漫画"]);
      expect(new Set(rows.map((row) => row.kind))).toEqual(new Set(["comic"]));
      expect(rows.map((row) => row.title.replaceAll("/", "/").split("/").pop())).toEqual(["第1话", "第2话", "第10话"]);
    } finally { ctx.app.close(); }
  });

  it("stops on request, keeps what was already read, and finishes the rest on the next scan", async () => {
    const ctx = await startApp();
    const dir = scratch("cancel");
    try {
      for (let i = 1; i <= 60; i += 1) write(dir, `大系列/${String(i).padStart(3, "0")}.txt`, chapter(`第${i}回`));
      const { path: added } = ok<{ path: { id: string } }>(await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", dir), mediaKind: "novel", autoScan: false }));
      ctx.app.scan.cancel({ pathId: added.id });
      await ctx.app.scan.whenIdle();
      ctx.app.store.sqlite.prepare("DELETE FROM library_files").run();
      ctx.app.store.sqlite.prepare("DELETE FROM resources").run();
      ctx.app.store.sqlite.prepare("DELETE FROM works").run();
      // Cancel once some files have been read. The job object is updated as the scan goes, so polling it sees the count rise.
      let cancelled = false;
      const watcher = (async () => {
        for (;;) {
          const running = ctx.app.scan.status().running;
          if (running && running.stage === "import" && running.processed >= 5) { cancelled = true; ctx.app.scan.cancel({ jobId: running.id }); return; }
          if (!running && cancelled) return;
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();
      ctx.app.scan.start({ pathId: added.id });
      await ctx.app.scan.whenIdle();
      await watcher;
      expect(cancelled).toBe(true);
      const stopped = lastJob(ctx);
      expect(stopped.status).toBe("cancelled");
      const kept = count(ctx, "SELECT COUNT(*) AS n FROM resources");
      expect(kept).toBeGreaterThanOrEqual(5);
      expect(kept).toBeLessThan(60);
      ctx.app.scan.start({});
      await ctx.app.scan.whenIdle();
      expect(lastJob(ctx)).toMatchObject({ status: "done", added: 60 - kept, skipped: kept });
      expect(count(ctx, "SELECT COUNT(*) AS n FROM resources")).toBe(60);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM works")).toBe(1);
    } finally { ctx.app.close(); }
  });

  it("does not follow a folder link back into the library path", async () => {
    const ctx = await startApp();
    const dir = scratch("loop");
    try {
      write(dir, "环/一.txt", chapter("一"));
      try { fs.symlinkSync(dir, path.join(dir, "环", "回到根"), "junction"); } catch { return; }
      await addPath(ctx, dir, "novel");
      expect(lastJob(ctx).status).toBe("done");
      expect(count(ctx, "SELECT COUNT(*) AS n FROM resources")).toBe(1);
    } finally { ctx.app.close(); }
  });

  it("refuses paths that are missing, not folders, repeated or overlapping, and keeps adding and removing for the owner only", async () => {
    const ctx = await startApp();
    const dir = scratch("rules");
    try {
      write(dir, "a/一.txt", chapter("一"));
      const file = write(dir, "单个.txt", chapter("单个"));
      const reason = async (target: string, kind: "novel" | "comic" | "video" = "novel") => {
        const result = await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", target), mediaKind: kind });
        expect(result.status).toBe("error");
        return (result.error?.details as { reason?: string }).reason;
      };
      expect(await reason(path.join(dir, "不存在"))).toBe("missing");
      expect(await reason(file)).toBe("not-a-folder");
      ok(await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", path.join(dir, "a")), mediaKind: "novel", autoScan: false }));
      await ctx.app.scan.whenIdle();
      expect(await reason(path.join(dir, "a"))).toBe("duplicate");
      expect(await reason(dir)).toBe("overlap");
      expect(await reason(path.join(dir, "a", "深"), "novel")).toBe("missing");
      // A model cannot name a path, so the commands are not in its grant at all.
      const agent = ctx.app.issueAgentGrant(ctx.grant, { kind: "agent", id: "agent:scan" }, { readResourceIds: [] });
      for (const commandId of ["library.paths.add", "library.paths.remove", "library.paths.update", "library.scan.start", "library.scan.cancel", "library.scan.setSchedule", "library.paths.list"]) {
        const sample: Record<string, Record<string, unknown>> = {
          "library.paths.add": { pathHandle: "x", mediaKind: "novel" }, "library.paths.remove": { pathId: "x" }, "library.paths.update": { pathId: "x" },
          "library.scan.setSchedule": { onStartup: true, intervalMinutes: 60 },
        };
        const denied = await run(ctx, commandId, sample[commandId] ?? {}, agent.handle, { kind: "agent", id: "agent:scan" });
        expect(denied.status, commandId).toBe("error");
        expect(denied.error?.code, commandId).toBe("FORBIDDEN");
      }
      const status = ok<{ running: unknown; recent: Array<{ path: string }> }>(await run(ctx, "library.scan.status", {}, agent.handle, { kind: "agent", id: "agent:scan" }));
      // The status a task may read names the folder, not where it is.
      expect(status.recent.every((job) => !job.path.includes(path.sep) && !job.path.includes("/"))).toBe(true);
      const pathId = (ctx.app.store.sqlite.prepare("SELECT id FROM library_paths").get() as { id: string }).id;
      const removed = ok<{ pathId: string }>(await run(ctx, "library.paths.remove", { pathId }));
      expect(removed.pathId).toBe(pathId);
      // Removing a path forgets what it held; the works and everything the user did to them stay.
      expect(count(ctx, "SELECT COUNT(*) AS n FROM library_files")).toBe(0);
      expect(count(ctx, "SELECT COUNT(*) AS n FROM resources")).toBe(1);
    } finally { ctx.app.close(); }
  });

  it("fails a scan of a kind whose module is off without touching the files, and records every scan in the log", async () => {
    const ctx = await startApp();
    const dir = scratch("off");
    try {
      const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123" } }).png().toBuffer();
      fs.mkdirSync(path.join(dir, "漫画", "第1话"), { recursive: true });
      fs.writeFileSync(path.join(dir, "漫画", "第1话", "1.png"), png);
      const { path: added } = await addPath(ctx, dir, "comic");
      expect(lastJob(ctx).status).toBe("done");
      ok(await run(ctx, "settings.setModule", { featureId: "comic", enabled: false }));
      ok(await run(ctx, "library.scan.start", { pathId: added.id }));
      await ctx.app.scan.whenIdle();
      expect(lastJob(ctx)).toMatchObject({ status: "failed", error: { code: "CAPABILITY_UNAVAILABLE" } });
      const entries = ctx.app.log.query({ category: "scan" }).entries;
      expect(entries.some((entry) => entry.action === "library.scan.run" && entry.actorKind === "system" && entry.outcome === "error" && entry.errorCode === "CAPABILITY_UNAVAILABLE")).toBe(true);
      expect(entries.some((entry) => entry.action === "library.paths.add" && entry.actorKind === "user")).toBe(true);
      // The log names the folder, not where it is.
      expect(JSON.stringify(entries)).not.toContain(dir);
    } finally { ctx.app.close(); }
  });
});

describe("scan schedule", () => {
  const stubHost = (events: string[]): ScanHost => ({
    importUnit: async () => { throw new Error("not used"); },
    afterImport: () => undefined,
    moduleEnabled: () => true,
    assertWritable: () => undefined,
    notify: (topic) => { events.push(topic); },
  });

  it("starts a scan when the interval has passed, once, even after a long sleep", async () => {
    const ctx = await startApp();
    const dir = scratch("sched");
    try {
      write(dir, "x.txt", chapter("x"));
      ctx.app.store.sqlite.prepare("INSERT INTO library_paths(id, path, media_kind, auto_scan, created_at) VALUES ('lp1', ?, 'novel', 1, ?)").run(dir, new Date().toISOString());
      ctx.app.store.sqlite.prepare("INSERT INTO library_paths(id, path, media_kind, auto_scan, created_at) VALUES ('lp2', ?, 'novel', 0, ?)").run(scratch("sched2"), new Date().toISOString());
      let clock = 1_000_000;
      const events: string[] = [];
      const service = new ScanService({ store: ctx.app.store, host: stubHost(events), now: () => clock });
      service.setSchedule({ onStartup: false, intervalMinutes: 30 });
      service.tick();
      expect(events).toEqual([]);
      clock += 29 * 60_000;
      service.tick();
      expect(events).toEqual([]);
      // Waking after a day: one scan for the path that wants it, not a burst of them.
      clock += 24 * 3600_000;
      service.tick();
      await service.whenIdle();
      const runs = () => ctx.app.store.sqlite.prepare("SELECT path_id AS id, trigger_kind AS trigger FROM scan_jobs ORDER BY started_at").all();
      expect(runs()).toEqual([{ id: "lp1", trigger: "schedule" }]);
      service.tick();
      await service.whenIdle();
      expect(runs()).toHaveLength(1);
      // Interval 0 switches the timer off.
      service.setSchedule({ onStartup: false, intervalMinutes: 0 });
      clock += 7 * 24 * 3600_000;
      service.tick();
      await service.whenIdle();
      expect(runs()).toHaveLength(1);
      expect(() => service.setSchedule({ onStartup: true, intervalMinutes: 7 as never })).toThrow();
      service.dispose();
    } finally { ctx.app.close(); }
  });

  it("keeps the schedule in the profile, with a daily-or-hourly default of on-launch plus hourly", async () => {
    const ctx = await startApp();
    try {
      expect(ok<{ schedule: unknown }>(await run(ctx, "library.paths.list", {})).schedule).toEqual({ onStartup: true, intervalMinutes: 60 });
      ok(await run(ctx, "library.scan.setSchedule", { onStartup: false, intervalMinutes: 360 }));
      expect(ok<{ schedule: unknown }>(await run(ctx, "library.paths.list", {})).schedule).toEqual({ onStartup: false, intervalMinutes: 360 });
      const bad = await run(ctx, "library.scan.setSchedule", { onStartup: true, intervalMinutes: 45 });
      expect(bad.status).toBe("error");
    } finally { ctx.app.close(); }
  });
});

describe("what a scan makes of a listing", () => {
  const files = (...paths: string[]): WalkEntry[] => paths.map((p) => ({ p, t: "f", s: 10, m: 1000 }));

  it("splits works by the first folder, keeps volumes in natural order and treats a loose file as its own work", () => {
    const plan = planScan("comic", files("alpha/vol10.cbz", "alpha/vol2.cbz", "alpha/vol1.cbz", "beta.cbz", "gamma/1话/1.png", "gamma/1话/2.png", "gamma/2话/1.png", "notes.txt"), "根");
    expect(plan.groups.map((group) => [group.key, group.title, group.folder])).toEqual([["alpha", "alpha", true], ["beta.cbz", "beta", false], ["gamma", "gamma", true]]);
    expect(plan.groups.find((group) => group.key === "alpha")!.units.map((unit) => unit.inGroup)).toEqual(["vol1.cbz", "vol2.cbz", "vol10.cbz"]);
    expect(plan.groups.find((group) => group.key === "gamma")!.units.map((unit) => [unit.inGroup, unit.imageCount])).toEqual([["1话", 2], ["2话", 1]]);
  });

  it("limits the number of units and says so", () => {
    const plan = planScan("novel", files(...Array.from({ length: 30 }, (_, i) => `s/${String(i).padStart(3, "0")}.txt`)), "根", { maxUnits: 10 });
    expect(plan.truncated).toBe(true);
    expect(plan.groups[0]!.units).toHaveLength(10);
  });
});
