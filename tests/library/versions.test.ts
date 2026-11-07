import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { startFakeBangumi, type FakeBangumi } from "../helpers/fake-bangumi.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>) {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `versions-${counter}`, input }, ctx.grant.handle);
}
const ok = <T = Record<string, any>>(result: Awaited<ReturnType<typeof run>>): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};

let fake: FakeBangumi;
beforeAll(async () => { fake = await startFakeBangumi(); });
afterAll(async () => { await fake.stop(); });

async function boot(): Promise<App> {
  fake.reset();
  await fake.addImage("a.png", "red");
  fake.subject(201, { type: 2, platform: "TV", name: "Sample Anime", name_cn: "样例动画", imageName: "a.png", eps: 3, total_episodes: 3 });
  fake.subject(202, { type: 2, platform: "TV", name: "Other Anime", name_cn: "另一部动画", imageName: "a.png", eps: 3, total_episodes: 3 });
  fake.subject(301, { type: 1, platform: "漫画", name: "Sample Manga", name_cn: "样例漫画", imageName: "a.png", volumes: 3 });
  return startApp({ options: { appVersion: "9.9.9", bangumi: fake.clientOptions } });
}

type Item = { id: string; title: string; versionCount: number; resourceCount: number; lastOpenedAt: string | null };
type Page = { items: Item[]; total: number; nextCursor: string | null };
type Version = { workId: string; label: string; resourceCount: number; current: boolean };
type Detail = { id: string; versions: Version[]; resources: Array<{ id: string; ordinalLabel: string | null }> };

/** A release of a show: `episodes` files in a folder named after the release group, with the length each one has in that release. */
function release(ctx: App, label: string, durations: number[]) {
  const first = seedVideo(ctx.app, { title: `${label} 01`, durationMs: durations[0], ordinal: { number: 1, type: "episode", label: "第 1 话" }, createdAt: new Date(Date.UTC(2026, 9, 1)).toISOString() });
  ctx.app.store.sqlite.prepare("UPDATE works SET title = ? WHERE id = ?").run(label, first.workId);
  const rest = durations.slice(1).map((durationMs, index) => seedVideo(ctx.app, { title: `${label} ${String(index + 2).padStart(2, "0")}`, durationMs, workId: first.workId, ordinal: { number: index + 2, type: "episode", label: `第 ${index + 2} 话` } }));
  return { workId: first.workId, resources: [first, ...rest] };
}
const link = async (ctx: App, workId: string, externalId: string) => ok(await run(ctx, "metadata.link", { workId, providerId: "bangumi", externalId }));
const list = async (ctx: App, input: Record<string, unknown> = {}) => ok<Page>(await run(ctx, "works.list", { group: true, ...input }));

describe("two releases of one title are one entry with versions (AT-78)", () => {
  it("lists works linked to the same Bangumi entry and medium once, and the rest each on their own", async () => {
    const ctx = await boot();
    try {
      const a = release(ctx, "[字幕组甲] 样例动画 [1080p]", [24_000, 24_000, 24_000]);
      const b = release(ctx, "[字幕组乙] 样例动画", [23_000, 23_000, 23_000]);
      const other = release(ctx, "[字幕组甲] 另一部动画", [20_000, 20_000]);
      const loose = release(ctx, "没有关联的动画", [20_000]);
      await link(ctx, a.workId, "201");
      await link(ctx, b.workId, "201");
      await link(ctx, other.workId, "202");

      const grouped = await list(ctx, { kind: "video" });
      // Four works, three entries: the two releases of 样例动画 are one.
      expect(grouped.total).toBe(3);
      expect(grouped.items).toHaveLength(3);
      const group = grouped.items.filter((item) => item.id === a.workId || item.id === b.workId);
      expect(group.map((item) => item.versionCount)).toEqual([2]);
      expect(grouped.items.map((item) => item.id)).toEqual(expect.arrayContaining([other.workId, loose.workId]));
      // Nothing is merged: every work is still there, and the plain list shows all four.
      const plain = ok<Page>(await run(ctx, "works.list", { kind: "video" }));
      expect(plain.total).toBe(4);
      expect(plain.items.every((item) => item.versionCount === (item.id === a.workId || item.id === b.workId ? 2 : 1))).toBe(true);

      const detail = ok<Detail>(await run(ctx, "works.get", { workId: a.workId }));
      expect(detail.versions.map((item) => [item.label, item.resourceCount, item.current]).sort()).toEqual([["[字幕组乙] 样例动画", 3, false], ["[字幕组甲] 样例动画 [1080p]", 3, true]]);
      expect(ok<Detail>(await run(ctx, "works.get", { workId: loose.workId })).versions).toHaveLength(1);
    } finally { ctx.app.close(); }
  });

  it("lists the version opened last, and a work of another medium linked to the same number stays apart", async () => {
    const ctx = await boot();
    try {
      const a = release(ctx, "[字幕组甲] 样例动画", [24_000, 24_000]);
      const b = release(ctx, "[字幕组乙] 样例动画", [23_000, 23_000]);
      // A comic that happens to carry the same entry number is another medium: it is not a version of the show.
      const comic = seedComic(ctx.app, { title: "同号的漫画" });
      await link(ctx, a.workId, "201");
      await link(ctx, b.workId, "201");
      ctx.app.store.sqlite.prepare("INSERT INTO work_links(work_id, provider_id, external_id, snapshot_json, confirmed_at, namespace, link_state) VALUES (?,?,?,?,?,?,?)").run(comic.workId, "bangumi", "201", "{}", new Date().toISOString(), "bangumi:subject", "linked");
      expect((await list(ctx)).total).toBe(2);
      expect((await list(ctx, { kind: "comic" })).items.map((item) => item.versionCount)).toEqual([1]);

      const shown = async () => (await list(ctx, { kind: "video" })).items.map((item) => item.id);
      ok(await run(ctx, "works.open", { resourceId: b.resources[0]!.resourceId }));
      expect(await shown()).toEqual([b.workId]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      ok(await run(ctx, "works.open", { resourceId: a.resources[1]!.resourceId }));
      expect(await shown()).toEqual([a.workId]);
    } finally { ctx.app.close(); }
  });

  it("counts a filter against the versions: a shelf holds the entry when any version is on it, and pages stay whole", async () => {
    const ctx = await boot();
    try {
      const a = release(ctx, "[字幕组甲] 样例动画", [24_000]);
      const b = release(ctx, "[字幕组乙] 样例动画", [23_000]);
      await link(ctx, a.workId, "201");
      await link(ctx, b.workId, "201");
      ok(await run(ctx, "works.setShelf", { workId: b.workId, state: "wishlist" }));
      const onShelf = await list(ctx, { shelf: "wishlist" });
      expect(onShelf).toMatchObject({ total: 1 });
      expect(onShelf.items.map((item) => item.id)).toEqual([b.workId]);
      expect((await list(ctx, { shelf: "reading" })).total).toBe(0);

      // Seven titles of two versions each, walked three to a page: every entry once, and the total never moves.
      for (let index = 0; index < 7; index += 1) {
        const x = release(ctx, `[甲] 作品${index}`, [10_000]);
        const y = release(ctx, `[乙] 作品${index}`, [10_000]);
        fake.subject(400 + index, { type: 2, platform: "TV", name: `Title ${index}`, name_cn: `作品${index}`, imageName: "a.png" });
        await link(ctx, x.workId, String(400 + index));
        await link(ctx, y.workId, String(400 + index));
      }
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await list(ctx, { limit: 3, sort: "title", ...(cursor ? { cursor } : {}) });
        expect(page.total).toBe(8);
        seen.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(8);
    } finally { ctx.app.close(); }
  }, 60_000);

  it("finds the same episode in another version and carries the place over as a fraction of it", async () => {
    const ctx = await boot();
    try {
      const a = release(ctx, "[字幕组甲] 样例动画", [24_000, 24_000, 24_000]);
      const b = release(ctx, "[字幕组乙] 样例动画", [20_000, 20_000]);
      const ep2 = a.resources[1]!;
      ok(await run(ctx, "progress.setTime", { contextId: null, resourceId: ep2.resourceId, resourceRevisionId: ep2.revisionId, timeMs: 12_000 }));
      // Saved progress says halfway through episode 2: the other release's episode 2 opens halfway through its own length.
      const same = ok<Record<string, any>>(await run(ctx, "works.counterpart", { resourceId: ep2.resourceId, toWorkId: b.workId }));
      expect(same).toMatchObject({ resourceId: b.resources[1]!.resourceId, workId: b.workId, ordinalLabel: "第 2 话", position: { kind: "temporal", startMs: 10_000 } });
      // The place the reader is at now wins over the saved one.
      const live = ok<Record<string, any>>(await run(ctx, "works.counterpart", { resourceId: ep2.resourceId, toWorkId: b.workId, fraction: 0.25 }));
      expect(live.position).toEqual({ kind: "temporal", startMs: 5_000 });
      // An episode the other release does not have has no counterpart, and says so.
      const third = a.resources[2]!;
      expect(ok<Record<string, any>>(await run(ctx, "works.counterpart", { resourceId: third.resourceId, toWorkId: b.workId }))).toMatchObject({ resourceId: null, position: null });
      // Not yet watched: the other version opens at its beginning.
      expect(ok<Record<string, any>>(await run(ctx, "works.counterpart", { resourceId: a.resources[0]!.resourceId, toWorkId: b.workId }))).toMatchObject({ resourceId: b.resources[0]!.resourceId, position: null });
      expect((await run(ctx, "works.counterpart", { resourceId: "res-none", toWorkId: b.workId })).error?.code).toBe("NOT_FOUND");
      expect((await run(ctx, "works.counterpart", { resourceId: ep2.resourceId, toWorkId: "work-none" })).error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  });

  it("carries a page of a comic over by its place in the book", async () => {
    const ctx = await boot();
    try {
      const a = seedComic(ctx.app, { title: "[汉化组甲] 样例漫画 01", pageCount: 10, ordinal: { number: 1, type: "volume", label: "第 1 卷" } });
      const b = seedComic(ctx.app, { title: "[汉化组乙] 样例漫画 01", pageCount: 20, ordinal: { number: 1, type: "volume", label: "第 1 卷" } });
      ok(await run(ctx, "progress.setPage", { contextId: null, resourceId: a.resourceId, resourceRevisionId: a.revisionId, pageId: a.pageIds[4] }));
      const at = ok<Record<string, any>>(await run(ctx, "works.counterpart", { resourceId: a.resourceId, toWorkId: b.workId }));
      // Page 5 of 10 is half way: page 10 of 20.
      expect(at).toMatchObject({ resourceId: b.resourceId, position: { kind: "image", pageId: b.pageIds[9] } });
    } finally { ctx.app.close(); }
  });

  it("separates the versions again when a link is taken away, and loses no data", async () => {
    const ctx = await boot();
    try {
      const a = release(ctx, "[字幕组甲] 样例动画", [24_000, 24_000]);
      const b = release(ctx, "[字幕组乙] 样例动画", [23_000, 23_000]);
      await link(ctx, a.workId, "201");
      await link(ctx, b.workId, "201");
      ok(await run(ctx, "progress.setTime", { contextId: null, resourceId: b.resources[0]!.resourceId, resourceRevisionId: b.resources[0]!.revisionId, timeMs: 5_000 }));
      expect((await list(ctx)).total).toBe(1);
      ok(await run(ctx, "metadata.unlink", { workId: b.workId, providerId: "bangumi" }));
      const after = await list(ctx);
      expect(after.total).toBe(2);
      expect(after.items.every((item) => item.versionCount === 1 && item.resourceCount === 2)).toBe(true);
      expect(ok<Detail>(await run(ctx, "works.get", { workId: a.workId })).versions).toHaveLength(1);
      const kept = ok<{ percent: number }>(await run(ctx, "progress.get", { contextId: null, resourceId: b.resources[0]!.resourceId }));
      expect(kept.percent).toBeGreaterThan(0);
    } finally { ctx.app.close(); }
  });

  it("does not count a work with no resource as a version", async () => {
    const ctx = await boot();
    try {
      const a = release(ctx, "[字幕组甲] 样例动画", [24_000]);
      const empty = release(ctx, "[字幕组乙] 样例动画", [24_000]);
      await link(ctx, a.workId, "201");
      await link(ctx, empty.workId, "201");
      ok(await run(ctx, "dictionary.add", { scope: "work", workId: empty.workId, term: "术语" }));
      const target = release(ctx, "[字幕组丙] 别处", [24_000]);
      ok(await run(ctx, "works.moveResource", { resourceId: empty.resources[0]!.resourceId, toWorkId: target.workId }));
      const entries = await list(ctx, { kind: "video" });
      const ownEntry = entries.items.find((item) => item.id === empty.workId);
      // The emptied work is listed on its own, as a work with nothing in it, and is not a version of the other release.
      expect(ownEntry).toMatchObject({ versionCount: 1, resourceCount: 0 });
      expect(entries.items.find((item) => item.id === a.workId)).toMatchObject({ versionCount: 1 });
    } finally { ctx.app.close(); }
  });
});
