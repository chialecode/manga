import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { join, quiet, textLocator, tone, toBase64, samplesFor } from "../helpers/voice.ts";
import { seedComic } from "../helpers/media-seed.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>) {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `content-${counter}`, input }, ctx.grant.handle);
}
const ok = <T = Record<string, any>>(result: Awaited<ReturnType<typeof run>>): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};

const scratch = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), `manga-content-${prefix}-`));
function write(root: string, rel: string, body: string): string {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}
const chapter = (title: string) => `${title}\n\n${"这是用于用户内容测试的一段合成文字。".repeat(20)}\n`;

type WorkDetail = { id: string; title: string; resourceCount: number; resources: Array<{ id: string; title: string; available: boolean; outside: boolean; revisionId: string }>; override: { fields: Record<string, unknown> } };
type Content = {
  resource: { id: string; workId: string | null; available: boolean; outside: boolean; path: string | null };
  notes: Array<{ objectId: string }>;
  bookmarks: Array<{ id: string }>;
  recordings: Array<{ id: string }>;
  conversation: { sessionId: string; runs: number } | null;
};

async function scan(ctx: App, pathId?: string) {
  ok(await run(ctx, "library.scan.start", pathId ? { pathId } : {}));
  await ctx.app.scan.whenIdle();
  return ctx.app.scan.status().recent[0]!;
}

/** A library of one work of two chapters, with a note, a bookmark, a recording and a conversation on the first, and a dictionary and edited fields on the work. */
async function furnished(ctx: App) {
  const dir = scratch("lib");
  const first = write(dir, "作品甲/第1话.txt", chapter("第一话"));
  const second = write(dir, "作品甲/第2话.txt", chapter("第二话"));
  const added = ok<{ path: { id: string } }>(await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", dir), mediaKind: "novel", autoScan: false }));
  await ctx.app.scan.whenIdle();
  const listed = ok<{ items: Array<{ id: string }> }>(await run(ctx, "works.list", {}));
  expect(listed.items).toHaveLength(1);
  const work = ok<WorkDetail>(await run(ctx, "works.get", { workId: listed.items[0]!.id }));
  const [one, two] = work.resources;
  expect(work.resources).toHaveLength(2);
  const note = ok<{ objectId: string }>(await run(ctx, "notes.create", {
    title: "第一话的笔记", text: "这一段值得记下来。", resourceId: one!.id, resourceRevisionId: one!.revisionId,
    locator: { kind: "text", partId: "p1", representationId: one!.revisionId, normalizationVersion: "text-nfc-lf-v1", range: { start: 0, end: 4 }, quote: { exact: "第一话" } },
  }));
  ok(await run(ctx, "reading.setBookmark", { resourceId: one!.id, resourceRevisionId: one!.revisionId, label: "回来读这里", locator: { ...textLocator(0), representationId: one!.revisionId } }));
  // A recording made while reading the first chapter.
  const started = ok<{ sessionId: string }>(await run(ctx, "capture.start", { mode: "toggle", retention: "discard", resourceId: one!.id, resourceRevisionId: one!.revisionId, locator: { ...textLocator(0), representationId: one!.revisionId } }));
  const pcm = join(quiet(500), tone(1000), quiet(500));
  const step = samplesFor(500);
  let seq = 0;
  for (let at = 0; at < pcm.length; at += step) ok(await run(ctx, "capture.append", { sessionId: started.sessionId, seq: seq++, data: toBase64(pcm.subarray(at, Math.min(pcm.length, at + step))) }));
  ok(await run(ctx, "capture.stop", { sessionId: started.sessionId, durationMs: pcm.length / 16 }));
  // A conversation about the chapter. Talking needs a model; a stored run stands in for one that was had.
  const session = ok<{ id: string }>(await run(ctx, "session.open", { kind: "resource", targetId: one!.id, contextId: null }));
  const db = ctx.app.store.sqlite;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run("run-user-content", session.id, "completed", ctx.grant.handle, "{}", "这一话讲了什么？", now, now);
  db.prepare("INSERT INTO agent_messages(id, run_id, role, text, created_at) VALUES (?,?,?,?,?)").run("msg-user-content", "run-user-content", "assistant", "讲了一个合成的故事。", now);
  // What belongs to the work itself.
  ok(await run(ctx, "dictionary.add", { scope: "work", workId: work.id, term: "合成人名", heard: "合成人民" }));
  ok(await run(ctx, "works.setOverride", { workId: work.id, fields: { author: "手写的作者" }, locked: [], cleared: [] }));
  return { dir, pathId: added.path.id, workId: work.id, one: one!, two: two!, files: { first, second }, noteId: note.objectId, sessionId: session.id };
}

/** Everything the user made, as the commands report it. */
async function held(ctx: App, workId: string, resourceId: string) {
  const content = ok<Content>(await run(ctx, "library.resourceContent", { resourceId }));
  const terms = ok<{ terms: Array<{ term: string }> }>(await run(ctx, "dictionary.list", { scope: "work", workId }));
  const work = ok<WorkDetail>(await run(ctx, "works.get", { workId }));
  return {
    notes: content.notes.map((item) => item.objectId).sort(),
    bookmarks: content.bookmarks.map((item) => item.id).sort(),
    recordings: content.recordings.map((item) => item.id).sort(),
    conversation: content.conversation,
    terms: terms.terms.map((item) => item.term).sort(),
    author: work.override.fields.author,
  };
}

describe("what the user made outlives the file (AT-77)", () => {
  it("keeps notes, bookmarks, a recording, a conversation, a dictionary and edited fields when the file is deleted, moved away, its library path removed and its work emptied", async () => {
    const ctx = await startApp();
    try {
      const lib = await furnished(ctx);
      const baseline = await held(ctx, lib.workId, lib.one.id);
      expect(baseline.notes).toHaveLength(1);
      expect(baseline.bookmarks).toHaveLength(1);
      expect(baseline.recordings).toHaveLength(1);
      expect(baseline.conversation).toMatchObject({ sessionId: lib.sessionId, runs: 1 });
      expect(baseline.terms).toEqual(["合成人名"]);
      expect(baseline.author).toBe("手写的作者");

      // The file is deleted: the scan marks it, and everything made on it is still there and reachable.
      fs.rmSync(lib.files.first);
      expect(await scan(ctx, lib.pathId)).toMatchObject({ status: "done", unavailable: 1 });
      const afterDelete = ok<Content>(await run(ctx, "library.resourceContent", { resourceId: lib.one.id }));
      expect(afterDelete.resource).toMatchObject({ id: lib.one.id, workId: lib.workId, available: false, outside: false });
      expect(await held(ctx, lib.workId, lib.one.id)).toEqual(baseline);

      // The second file is moved out of every library path.
      const elsewhere = scratch("elsewhere");
      fs.renameSync(lib.files.second, path.join(elsewhere, "第2话.txt"));
      expect(await scan(ctx, lib.pathId)).toMatchObject({ status: "done", unavailable: 1 });
      const afterMove = ok<WorkDetail>(await run(ctx, "works.get", { workId: lib.workId }));
      expect(afterMove.resources.map((item) => item.available)).toEqual([false, false]);
      expect(await held(ctx, lib.workId, lib.one.id)).toEqual(baseline);

      // The library path is removed: nothing the scan registered is kept, and nothing the user made goes with it.
      ok(await run(ctx, "library.paths.remove", { pathId: lib.pathId }));
      expect((ok<WorkDetail>(await run(ctx, "works.get", { workId: lib.workId }))).resourceCount).toBe(2);
      expect(await held(ctx, lib.workId, lib.one.id)).toEqual(baseline);

      // Both resources leave the work: it stays, with no resource, because it holds a dictionary and edited fields.
      const target = ok<{ workId: string }>(await run(ctx, "works.moveResource", { resourceId: lib.one.id, newWorkTitle: "整理后的作品" }));
      const emptied = ok<Record<string, unknown>>(await run(ctx, "works.moveResource", { resourceId: lib.two.id, toWorkId: target.workId }));
      expect(emptied).toMatchObject({ keptEmptyWorkId: lib.workId });
      expect(emptied.removedWorkId).toBeUndefined();
      const kept = ok<WorkDetail>(await run(ctx, "works.get", { workId: lib.workId }));
      expect(kept).toMatchObject({ id: lib.workId, resourceCount: 0 });
      const listed = ok<{ items: Array<{ id: string; resourceCount: number }> }>(await run(ctx, "works.list", {}));
      expect(listed.items.find((item) => item.id === lib.workId)).toMatchObject({ resourceCount: 0 });
      // What was made on the resource went with the resource; what belongs to the work stayed with the work.
      const content = ok<Content>(await run(ctx, "library.resourceContent", { resourceId: lib.one.id }));
      expect(content.resource.workId).toBe(target.workId);
      expect(content.notes.map((item) => item.objectId)).toEqual(baseline.notes);
      expect(content.bookmarks.map((item) => item.id)).toEqual(baseline.bookmarks);
      expect(content.conversation).toMatchObject({ sessionId: lib.sessionId, runs: 1 });
      expect(await held(ctx, lib.workId, lib.one.id)).toEqual(baseline);
    } finally { ctx.app.close(); }
  }, 60_000);

  it("takes the same file back as the same resource when it returns to a library path, wherever in it", async () => {
    const ctx = await startApp();
    try {
      const lib = await furnished(ctx);
      const baseline = await held(ctx, lib.workId, lib.one.id);
      const body = fs.readFileSync(lib.files.first);
      fs.rmSync(lib.files.first);
      await scan(ctx, lib.pathId);
      // The library path is removed and added again with the file put back under another name: a scan that has never seen it.
      ok(await run(ctx, "library.paths.remove", { pathId: lib.pathId }));
      const resourcesBefore = (ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number }).n;
      write(lib.dir, "整理过/第一话（重命名）.txt", body.toString("utf8"));
      const finished: Array<{ pathId: string; moved: number; status: string }> = [];
      ctx.app.onNotice((notice) => { if (notice.topic === "scan.finished") finished.push((notice.payload as { job: { pathId: string; moved: number; status: string } }).job); });
      const again = ok<{ path: { id: string } }>(await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", lib.dir), mediaKind: "novel", autoScan: false }));
      await ctx.app.scan.whenIdle();
      // Two resources come back: the renamed one, and the one whose file never left (while no library path held it, its location was outside; A-80).
      expect(finished.find((job) => job.pathId === again.path.id)).toMatchObject({ status: "done", moved: 2 });
      // No new resource: the old one follows the file, and its place in the library is registered again.
      expect((ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number }).n).toBe(resourcesBefore);
      const content = ok<Content>(await run(ctx, "library.resourceContent", { resourceId: lib.one.id }));
      expect(content.resource).toMatchObject({ id: lib.one.id, available: true, outside: false });
      expect(content.resource.path).toContain("第一话（重命名）.txt");
      expect(await held(ctx, lib.workId, lib.one.id)).toEqual(baseline);
      const detail = ok<WorkDetail>(await run(ctx, "works.get", { workId: lib.workId }));
      expect(detail.resources.find((item) => item.id === lib.one.id)).toMatchObject({ available: true, outside: false });
      expect(detail.resources.find((item) => item.id === lib.two.id)).toMatchObject({ available: true, outside: false });
    } finally { ctx.app.close(); }
  }, 60_000);

  it("does not take a second copy of a file that is still there for the lost one", async () => {
    const ctx = await startApp();
    try {
      const lib = await furnished(ctx);
      // The original stays; an identical copy appears next to it. It is a new resource, not the original moved.
      write(lib.dir, "作品甲/第1话 副本.txt", fs.readFileSync(lib.files.first, "utf8"));
      const before = (ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number }).n;
      expect(await scan(ctx, lib.pathId)).toMatchObject({ status: "done", added: 1, moved: 0 });
      expect((ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number }).n).toBe(before + 1);
      expect(ok<Content>(await run(ctx, "library.resourceContent", { resourceId: lib.one.id })).resource.available).toBe(true);
    } finally { ctx.app.close(); }
  }, 60_000);

  it("drops a work that is emptied only when it holds nothing the user wrote", async () => {
    const ctx = await startApp();
    try {
      const plain = seedComic(ctx.app, { title: "只有文件" });
      const written = seedComic(ctx.app, { title: "有手写内容" });
      const home = seedComic(ctx.app, { title: "收纳处" });
      ok(await run(ctx, "dictionary.add", { scope: "work", workId: written.workId, term: "术语" }));
      expect(ok<Record<string, unknown>>(await run(ctx, "works.moveResource", { resourceId: plain.resourceId, toWorkId: home.workId }))).toMatchObject({ removedWorkId: plain.workId });
      expect((await run(ctx, "works.get", { workId: plain.workId })).error?.code).toBe("NOT_FOUND");
      expect(ok<Record<string, unknown>>(await run(ctx, "works.moveResource", { resourceId: written.resourceId, toWorkId: home.workId }))).toMatchObject({ keptEmptyWorkId: written.workId });
      expect(ok<WorkDetail>(await run(ctx, "works.get", { workId: written.workId })).resourceCount).toBe(0);
      // A work with no resource and nothing written is never listed; one with something written is.
      const listed = ok<{ items: Array<{ id: string }> }>(await run(ctx, "works.list", {})).items.map((item) => item.id);
      expect(listed).toContain(written.workId);
      expect(listed).not.toContain(plain.workId);
    } finally { ctx.app.close(); }
  });
});
