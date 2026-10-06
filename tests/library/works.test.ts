import { describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>, grantHandle = ctx.grant.handle, actor: { kind: "user" | "agent"; id: string } = ctx.actor) {
  counter += 1;
  return ctx.app.call(actor, { commandId, idempotencyKey: `works-${counter}`, input }, grantHandle);
}

async function importNovel(ctx: App, title: string, body = `${title}的正文。`) {
  const result = await run(ctx, "library.importText", { title, bytes: [...Buffer.from(body)] });
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as { resourceId: string; workId: string; revisionId: string };
}

describe("works: listing, shelf, override, ordering", () => {
  it("pages through every work with a stable cursor and a total that does not shrink", async () => {
    const ctx = await startApp();
    try {
      for (let index = 0; index < 23; index += 1) {
        seedComic(ctx.app, { title: `漫画${String(index).padStart(2, "0")}`, pageCount: 2, createdAt: new Date(Date.UTC(2026, 8, 1, 0, index)).toISOString() });
      }
      for (const sort of ["added", "title", "recent"] as const) {
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const result = await run(ctx, "works.list", { limit: 10, sort, ...(cursor ? { cursor } : {}) });
          expect(result.status, JSON.stringify(result)).toBe("ok");
          const page = result.value as { items: Array<{ id: string; title: string }>; total: number; nextCursor: string | null };
          expect(page.total).toBe(23);
          seen.push(...page.items.map((item) => item.id));
          cursor = page.nextCursor ?? undefined;
          pages += 1;
        } while (cursor && pages < 10);
        expect(pages, sort).toBe(3);
        expect(new Set(seen).size, sort).toBe(23);
      }
      const byTitle = await run(ctx, "works.list", { limit: 3, sort: "title" });
      expect((byTitle.value as { items: Array<{ title: string }> }).items.map((item) => item.title)).toEqual(["漫画00", "漫画01", "漫画02"]);
      const added = await run(ctx, "works.list", { limit: 2, sort: "added" });
      expect((added.value as { items: Array<{ title: string }> }).items.map((item) => item.title)).toEqual(["漫画22", "漫画21"]);
      const bad = await run(ctx, "works.list", { cursor: "not-a-cursor" });
      expect(bad.status).toBe("error");
      expect(bad.error?.code).toBe("VALIDATION_ERROR");
    } finally { ctx.app.close(); }
  });

  it("filters by kind, shelf and text, and escapes search wildcards", async () => {
    const ctx = await startApp();
    try {
      const novel = await importNovel(ctx, "百分之百的小说");
      const comic = seedComic(ctx.app, { title: "勇者漫画" });
      const video = seedVideo(ctx.app, { title: "勇者动画" });
      await importNovel(ctx, "别的书");
      const list = async (input: Record<string, unknown>) => ((await run(ctx, "works.list", input)).value as { items: Array<{ id: string; title: string }>; total: number });
      expect((await list({ kind: "comic" })).items.map((item) => item.id)).toEqual([comic.workId]);
      expect((await list({ kind: "video" })).items.map((item) => item.id)).toEqual([video.workId]);
      expect((await list({ query: "勇者" })).total).toBe(2);
      expect((await list({ query: "100%" })).total).toBe(0);
      expect((await list({ query: "%" })).total).toBe(0);
      expect((await list({ query: "百分之百" })).items[0]?.id).toBe(novel.workId);
      await run(ctx, "works.setShelf", { workId: comic.workId, state: "wishlist" });
      expect((await list({ shelf: "wishlist" })).items.map((item) => item.id)).toEqual([comic.workId]);
      expect((await list({ shelf: "finished" })).total).toBe(0);
      expect((await list({ linked: true })).total).toBe(0);
      expect((await list({ linked: false })).total).toBe(4);
    } finally { ctx.app.close(); }
  });

  it("sorts by progress and filters by file format and by notes", async () => {
    const ctx = await startApp();
    try {
      const low = seedComic(ctx.app, { title: "读了一点", pageCount: 10 });
      const high = seedComic(ctx.app, { title: "读了大半", pageCount: 10 });
      const none = seedVideo(ctx.app, { title: "没看过" });
      const novel = await importNovel(ctx, "有笔记的小说", "第一段文字。".repeat(30));
      await run(ctx, "progress.setPage", { resourceId: low.resourceId, resourceRevisionId: low.revisionId, pageId: low.pageIds[1], consumed: true });
      await run(ctx, "progress.setPage", { resourceId: high.resourceId, resourceRevisionId: high.revisionId, pageId: high.pageIds[7], consumed: true });
      await run(ctx, "works.open", { resourceId: low.resourceId });
      await run(ctx, "works.open", { resourceId: high.resourceId });
      const titles = async (input: Record<string, unknown>) => ((await run(ctx, "works.list", input)).value as { items: Array<{ title: string; progress: number }> }).items;
      const byProgress = await titles({ sort: "progress", kind: "comic" });
      expect(byProgress.map((item) => item.title)).toEqual(["读了大半", "读了一点"]);
      expect(byProgress[0]!.progress).toBeGreaterThan(byProgress[1]!.progress);
      // A cursor on a numeric key walks the same order without repeating or skipping.
      const first = (await run(ctx, "works.list", { sort: "progress", limit: 2 })).value as { items: Array<{ id: string }>; nextCursor: string | null };
      const second = (await run(ctx, "works.list", { sort: "progress", limit: 2, cursor: first.nextCursor! })).value as { items: Array<{ id: string }>; nextCursor: string | null };
      expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(4);
      expect((await titles({ format: "cbz" })).length).toBe(0);
      expect((await titles({ format: "dir" })).map((item) => item.title).sort()).toEqual(["读了一点", "读了大半"]);
      expect((await titles({ format: "TXT" })).map((item) => item.title)).toEqual(["有笔记的小说"]);
      expect((await titles({ hasNotes: true })).length).toBe(0);
      const note = await run(ctx, "notes.create", {
        title: "笔记", text: "第一段文字。", resourceId: novel.resourceId, resourceRevisionId: novel.revisionId,
        locator: { kind: "text", partId: "p1", representationId: novel.revisionId, normalizationVersion: "text-nfc-lf-v1", range: { start: 0, end: 6 }, quote: { exact: "第一段文字。" } },
      });
      expect(note.status, JSON.stringify(note)).toBe("ok");
      expect((await titles({ hasNotes: true })).map((item) => item.title)).toEqual(["有笔记的小说"]);
      expect((await titles({ hasNotes: false })).length).toBe(3);
      void none;
    } finally { ctx.app.close(); }
  });

  it("moves a wishlist or unshelved work to reading on first open only", async () => {
    const ctx = await startApp();
    try {
      const a = seedComic(ctx.app, { title: "未标记" });
      const b = seedComic(ctx.app, { title: "想读" });
      const c = seedComic(ctx.app, { title: "搁置" });
      await run(ctx, "works.setShelf", { workId: b.workId, state: "wishlist" });
      await run(ctx, "works.setShelf", { workId: c.workId, state: "on_hold" });
      const shelfOf = async (workId: string) => ((await run(ctx, "works.get", { workId })).value as { shelf: string }).shelf;
      expect(await shelfOf(a.workId)).toBe("none");
      for (const item of [a, b, c]) await run(ctx, "works.open", { resourceId: item.resourceId });
      expect(await shelfOf(a.workId)).toBe("reading");
      expect(await shelfOf(b.workId)).toBe("reading");
      expect(await shelfOf(c.workId)).toBe("on_hold");
      // A later change of mind sticks: reopening does not undo it, and "finished" is never set automatically.
      await run(ctx, "works.setShelf", { workId: a.workId, state: "wishlist" });
      await run(ctx, "works.open", { resourceId: a.resourceId });
      expect(await shelfOf(a.workId)).toBe("wishlist");
      const last = await run(ctx, "progress.setPage", { resourceId: a.resourceId, resourceRevisionId: a.revisionId, pageId: a.pageIds.at(-1), consumed: true });
      expect(last.value).toMatchObject({ completion: "completed" });
      expect(await shelfOf(a.workId)).toBe("wishlist");
    } finally { ctx.app.close(); }
  });

  it("orders resources of one work by ordinal, keeps specials after the main run and accepts moves between works", async () => {
    const ctx = await startApp();
    try {
      const first = seedComic(ctx.app, { title: "系列", ordinal: { number: 2, type: "chapter", label: "第 2 话" } });
      const second = seedComic(ctx.app, { title: "系列", workId: first.workId, ordinal: { number: 10, type: "chapter", label: "第 10 话" } });
      const third = seedComic(ctx.app, { title: "系列", workId: first.workId, ordinal: { number: 1, type: "chapter", label: "第 1 话" } });
      const detail = async () => (await run(ctx, "works.get", { workId: first.workId })).value as { resources: Array<{ id: string; ordinalLabel: string | null }> };
      expect((await detail()).resources.map((item) => item.ordinalLabel)).toEqual(["第 1 话", "第 2 话", "第 10 话"]);
      const special = await run(ctx, "works.setOrdinal", { resourceId: second.resourceId, ordinal: { type: "special", number: 1 } });
      expect(special.value).toMatchObject({ label: "SP1", type: "special" });
      expect((await detail()).resources.map((item) => item.ordinalLabel)).toEqual(["第 1 话", "第 2 话", "SP1"]);
      const cleared = await run(ctx, "works.setOrdinal", { resourceId: third.resourceId, ordinal: null });
      expect(cleared.status).toBe("ok");
      expect((await detail()).resources.at(-1)?.id).toBe(third.resourceId);

      const moved = await run(ctx, "works.moveResource", { resourceId: third.resourceId, newWorkTitle: "拆出来的作品" });
      expect(moved.status, JSON.stringify(moved)).toBe("ok");
      expect(moved.value).toMatchObject({ moved: true });
      const split = moved.value as { workId: string };
      expect(((await run(ctx, "works.get", { workId: split.workId })).value as { title: string }).title).toBe("拆出来的作品");
      // Moving the only resource of a work leaves no empty shell behind.
      const solo = seedComic(ctx.app, { title: "独立作品" });
      const back = await run(ctx, "works.moveResource", { resourceId: solo.resourceId, toWorkId: first.workId });
      expect(back.value).toMatchObject({ removedWorkId: solo.workId });
      expect((await run(ctx, "works.get", { workId: solo.workId })).error?.code).toBe("NOT_FOUND");
      const missing = await run(ctx, "works.moveResource", { resourceId: solo.resourceId, toWorkId: "work-nope" });
      expect(missing.error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  });

  it("refuses to open a file as a kind its content cannot back, and keeps anchors when the kind changes", async () => {
    const ctx = await startApp();
    try {
      const novel = await importNovel(ctx, "纯文字");
      for (const kind of ["comic", "video"]) {
        const result = await run(ctx, "works.setKind", { resourceId: novel.resourceId, kind });
        expect(result.status, kind).toBe("error");
        expect(result.error?.code, kind).toBe("UNSUPPORTED_FORMAT");
      }
      const comic = seedComic(ctx.app, { title: "只有页" });
      expect((await run(ctx, "works.setKind", { resourceId: comic.resourceId, kind: "novel" })).error?.code).toBe("UNSUPPORTED_FORMAT");
      const note = await run(ctx, "notes.create", { title: "页笔记", text: "这一页很重要", resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, locator: { kind: "image", pageId: comic.pageIds[2], region: { x: 0.1, y: 0.1, width: 0.5, height: 0.4 } } });
      expect(note.status, JSON.stringify(note)).toBe("ok");
      expect((await run(ctx, "works.setKind", { resourceId: comic.resourceId, kind: "comic" })).status).toBe("ok");
      expect((await run(ctx, "works.setKind", { resourceId: "res-none", kind: "comic" })).error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  });

  it("keeps field provenance, locks a value against refresh and clears a field on purpose", async () => {
    const ctx = await startApp();
    try {
      const novel = await importNovel(ctx, "文件名标题");
      const db = ctx.app.store.sqlite;
      const now = new Date().toISOString();
      db.prepare("INSERT INTO metadata_snapshots(work_id, provider_id, external_id, snapshot_json, fetched_at, source_url, api_version) VALUES (?,?,?,?,?,?,?)").run(novel.workId, "bangumi", "7", JSON.stringify({ fields: { title: "在线标题", author: "在线作者", summary: "在线简介" } }), now, "https://bgm.tv/subject/7", "v0");
      db.prepare("INSERT INTO metadata_snapshots(work_id, provider_id, external_id, snapshot_json, fetched_at) VALUES (?,?,?,?,?)").run(novel.workId, "local-file", "file", JSON.stringify({ fields: { title: "文件内标题", author: "文件作者", platform: "EPUB" } }), now);
      db.prepare("INSERT INTO work_links(work_id, provider_id, external_id, snapshot_json, confirmed_at, namespace, link_state) VALUES (?,?,?,?,?,?,?)").run(novel.workId, "bangumi", "7", "{}", now, "bangumi:subject", "linked");
      // Nothing is projected until something asks for it; the override command is that something.
      const first = await run(ctx, "works.setOverride", { workId: novel.workId, fields: {}, locked: [], cleared: [] });
      expect(first.status, JSON.stringify(first)).toBe("ok");
      const fields = (first.value as { fields: Record<string, { value: unknown; source: string; policy: string; candidates: Array<{ source: string; selected: boolean }> }> }).fields;
      expect(fields.title).toMatchObject({ value: "在线标题", source: "online", policy: "provider" });
      expect(fields.title!.candidates.map((candidate) => candidate.source)).toEqual(["online", "file", "filename"]);
      expect(fields.title!.candidates.filter((candidate) => candidate.selected)).toHaveLength(1);
      expect(fields.platform).toMatchObject({ value: "EPUB", source: "file" });
      expect(fields.summary).toMatchObject({ value: "在线简介" });

      const typed = await run(ctx, "works.setOverride", { workId: novel.workId, fields: { title: "我的标题" }, locked: ["author"], cleared: ["summary"] });
      const after = (typed.value as { fields: typeof fields }).fields;
      expect(after.title).toMatchObject({ value: "我的标题", source: "user", policy: "user" });
      // Locking pins what the field showed at that moment.
      expect(after.author).toMatchObject({ value: "在线作者", source: "user", policy: "locked" });
      expect(after.summary).toMatchObject({ value: null, policy: "empty" });
      const summary = (await run(ctx, "works.list", { query: "我的标题" })).value as { items: Array<{ title: string; author: string }> };
      expect(summary.items[0]).toMatchObject({ title: "我的标题", author: "在线作者" });

      // A refreshed online snapshot changes nothing the user decided.
      db.prepare("UPDATE metadata_snapshots SET snapshot_json = ? WHERE work_id = ? AND provider_id = 'bangumi'").run(JSON.stringify({ fields: { title: "更新后的在线标题", author: "别人", summary: "新简介" } }), novel.workId);
      const refreshed = await run(ctx, "works.setOverride", { workId: novel.workId, fields: { title: "我的标题" }, locked: ["author"], cleared: ["summary"] });
      const kept = (refreshed.value as { fields: typeof fields }).fields;
      expect(kept.title!.value).toBe("我的标题");
      expect(kept.author!.value).toBe("在线作者");
      expect(kept.summary!.value).toBeNull();

      const wrong = await run(ctx, "works.setOverride", { workId: novel.workId, fields: { notAField: "x" }, locked: [], cleared: [] });
      expect(wrong.status).toBe("error");
    } finally { ctx.app.close(); }
  });

  it("lets an agent list only what it was granted and never change the shelf", async () => {
    const ctx = await startApp();
    try {
      const allowed = seedComic(ctx.app, { title: "授权作品" });
      seedComic(ctx.app, { title: "未授权作品" });
      const agentActor = { kind: "agent" as const, id: "agent-works" };
      const agent = ctx.app.issueAgentGrant(ctx.grant, agentActor, { readResourceIds: [allowed.resourceId] });
      const listed = await run(ctx, "works.list", {}, agent.handle, agentActor);
      expect((listed.value as { items: Array<{ title: string }>; total: number })).toMatchObject({ total: 1, items: [{ title: "授权作品" }] });
      const denied = await run(ctx, "works.get", { workId: (await run(ctx, "works.list", {})).value.items.find((item: { title: string }) => item.title === "未授权作品").id }, agent.handle, agentActor);
      expect(denied.error?.code).toBe("SCOPE_DENIED");
      const writes: Array<[string, Record<string, unknown>]> = [
        ["works.setShelf", { workId: allowed.workId, state: "finished" }],
        ["works.setOverride", { workId: allowed.workId, fields: { title: "改名" }, locked: [], cleared: [] }],
        ["works.moveResource", { resourceId: allowed.resourceId, newWorkTitle: "拆分" }],
        ["works.setKind", { resourceId: allowed.resourceId, kind: "comic" }],
        ["works.open", { resourceId: allowed.resourceId }],
      ];
      for (const [commandId, input] of writes) {
        const result = await run(ctx, commandId, input, agent.handle, agentActor);
        expect(result.status, commandId).toBe("error");
        expect(result.error?.code, commandId).toBe("FORBIDDEN");
      }
    } finally { ctx.app.close(); }
  });
});

describe("progress by page and by time", () => {
  it("records pages as an index range, stays on the resource and finishes only at the last page", async () => {
    const ctx = await startApp();
    try {
      const comic = seedComic(ctx.app, { title: "翻页", pageCount: 10 });
      const page = (index: number, consumed = true) => run(ctx, "progress.setPage", { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[index], consumed });
      for (const index of [0, 1, 2]) await page(index);
      await page(6);
      const mid = await run(ctx, "progress.get", { resourceId: comic.resourceId });
      expect(mid.value).toMatchObject({ unit: "pages", total: 10, completion: "reading", locator: { kind: "image", pageId: comic.pageIds[6] } });
      expect((mid.value as { consumed: unknown[] }).consumed).toEqual([{ partId: "$pages", start: 0, end: 3 }, { partId: "$pages", start: 6, end: 7 }]);
      expect((mid.value as { percent: number }).percent).toBeCloseTo(0.7);
      // Looking at a page without reading it moves the position but not the read set.
      await page(8, false);
      expect(((await run(ctx, "progress.get", { resourceId: comic.resourceId })).value as { consumed: unknown[] }).consumed).toHaveLength(2);
      const last = await page(9);
      expect(last.value).toMatchObject({ completion: "completed", percent: 1 });
      // Going back never un-finishes.
      await page(0);
      expect(((await run(ctx, "progress.get", { resourceId: comic.resourceId })).value as { completion: string }).completion).toBe("completed");

      const unknown = await run(ctx, "progress.setPage", { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: "nope.png" });
      expect(unknown.error?.code).toBe("NOT_FOUND");
      const novel = await importNovel(ctx, "不是漫画");
      const wrongKind = await run(ctx, "progress.setPage", { resourceId: novel.resourceId, resourceRevisionId: novel.revisionId, pageId: "x" });
      expect(wrongKind.error?.code).toBe("VALIDATION_ERROR");
      const foreign = await run(ctx, "progress.setPage", { resourceId: novel.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[0] });
      expect(foreign.error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  });

  it("counts only stretches that were played; seeking over a part does not consume it", async () => {
    const ctx = await startApp();
    try {
      const video = seedVideo(ctx.app, { title: "看剧", durationMs: 1_440_000 });
      const time = (timeMs: number, played?: Array<{ startMs: number; endMs: number }>) => run(ctx, "progress.setTime", { resourceId: video.resourceId, resourceRevisionId: video.revisionId, timeMs, ...(played ? { played } : {}) });
      await time(60_000, [{ startMs: 0, endMs: 60_000 }]);
      // Drag the playhead to the end without playing: position moves, nothing new is consumed.
      const seeked = await time(1_430_000);
      expect(seeked.value).toMatchObject({ completion: "reading" });
      const state = (await run(ctx, "progress.get", { resourceId: video.resourceId })).value as { consumed: Array<{ partId: string; start: number; end: number }>; percent: number; locator: { startMs: number } };
      expect(state.consumed).toEqual([{ partId: "$time", start: 0, end: 60_000 }]);
      expect(state.locator.startMs).toBe(1_430_000);
      expect(state.percent).toBeGreaterThan(0.99);
      // Playing most of it and ending near the end completes the episode, despite skipping an opening.
      await time(1_430_000, [{ startMs: 120_000, endMs: 1_430_000 }]);
      expect(((await run(ctx, "progress.get", { resourceId: video.resourceId })).value as { completion: string }).completion).toBe("completed");

      const pastEnd = await run(ctx, "progress.setTime", { resourceId: video.resourceId, resourceRevisionId: video.revisionId, timeMs: 5_000_000 });
      expect(pastEnd.error?.code).toBe("VALIDATION_ERROR");
      const comic = seedComic(ctx.app, { title: "不是视频" });
      expect((await run(ctx, "progress.setTime", { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, timeMs: 10 })).error?.code).toBe("VALIDATION_ERROR");
      const finished = (await run(ctx, "works.get", { workId: video.workId })).value as { finishedCount: number; progress: number };
      expect(finished.finishedCount).toBe(1);
    } finally { ctx.app.close(); }
  });
});

describe("page and time sources in notes", () => {
  it("creates notes from a page region and a time range, resolves them and reports a source that is gone", async () => {
    const ctx = await startApp();
    try {
      const comic = seedComic(ctx.app, { title: "有来源" });
      const video = seedVideo(ctx.app, { title: "有来源的视频", durationMs: 90_000 });
      const pageNote = await run(ctx, "notes.create", { title: "格子", text: "这格的构图", resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, locator: { kind: "image", pageId: comic.pageIds[3], region: { x: 0.25, y: 0.5, width: 0.5, height: 0.25 } } });
      const timeNote = await run(ctx, "notes.create", { title: "片段", text: "片头", resourceId: video.resourceId, resourceRevisionId: video.revisionId, locator: { kind: "temporal", startMs: 5_000, endMs: 12_500 } });
      expect(pageNote.status, JSON.stringify(pageNote)).toBe("ok");
      expect(timeNote.status, JSON.stringify(timeNote)).toBe("ok");

      const pageSource = await run(ctx, "notes.openSource", { objectId: (pageNote.value as { objectId: string }).objectId });
      expect(pageSource.value).toMatchObject({ status: "resolved", kind: "image", pageIndex: 3, pageCount: 6, card: { kind: "image", status: "resolved" } });
      const timeSource = await run(ctx, "notes.openSource", { objectId: (timeNote.value as { objectId: string }).objectId });
      expect(timeSource.value).toMatchObject({ status: "resolved", kind: "temporal", startMs: 5_000, endMs: 12_500, durationMs: 90_000 });

      // Counterexamples are refused at creation, not stored as a note that can never open.
      const cases: Array<[string, Record<string, unknown>]> = [
        ["a page the revision does not have", { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, locator: { kind: "image", pageId: "p999.png" } }],
        ["a time past the end", { resourceId: video.resourceId, resourceRevisionId: video.revisionId, locator: { kind: "temporal", startMs: 200_000 } }],
        ["a page on a video", { resourceId: video.resourceId, resourceRevisionId: video.revisionId, locator: { kind: "image", pageId: "p001.png" } }],
        ["a time on a comic", { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, locator: { kind: "temporal", startMs: 1000 } }],
        ["a region outside the page", { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, locator: { kind: "image", pageId: comic.pageIds[0], region: { x: 0.8, y: 0.8, width: 0.5, height: 0.5 } } }],
        ["a range that ends before it starts", { resourceId: video.resourceId, resourceRevisionId: video.revisionId, locator: { kind: "temporal", startMs: 9000, endMs: 1000 } }],
        ["a source without a revision", { resourceId: comic.resourceId, locator: { kind: "image", pageId: comic.pageIds[0] } }],
      ];
      for (const [label, input] of cases) {
        const result = await run(ctx, "notes.create", { title: label, text: "x", ...input });
        expect(result.status, label).toBe("error");
      }

      // The same locator on another revision of the same file does not carry over silently.
      const resolved = await run(ctx, "reader.resolveAnchor", { resourceRevisionId: video.revisionId, locator: { kind: "temporal", startMs: 95_000 } });
      expect(resolved.value).toMatchObject({ status: "unresolved" });
      const wrong = await run(ctx, "reader.resolveAnchor", { resourceRevisionId: comic.revisionId, locator: { kind: "temporal", startMs: 1000 } });
      expect(wrong.value).toMatchObject({ status: "missing_capability" });
      const gone = await run(ctx, "reader.resolveAnchor", { resourceRevisionId: "rev-gone", locator: { kind: "image", pageId: "a" } });
      expect(gone.value).toMatchObject({ status: "missing_revision" });
    } finally { ctx.app.close(); }
  });
});
