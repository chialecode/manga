import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveMedia } from "../../packages/app-core/src/media/index.ts";
import type { OnlineProvider, SearchHit, SubjectDetail } from "../../packages/app-core/src/metadata/provider.ts";
import { MangaError } from "@manga/contracts";
import { startApp } from "../helpers/app.ts";
import { startFakeBangumi, picture, type FakeBangumi } from "../helpers/fake-bangumi.ts";
import { requireSamples, samplePath } from "../helpers/samples.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>, grantHandle = ctx.grant.handle, actor: { kind: "user" | "agent"; id: string } = ctx.actor): Promise<Call> {
  counter += 1;
  return ctx.app.call(actor, { commandId, idempotencyKey: `meta-${counter}`, input }, grantHandle);
}

function ok<T = Record<string, unknown>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}

const USER_AGENT = "chialecode/manga/9.9.9 (https://github.com/chialecode/manga)";
const pick = (ctx: App, target: string) => ctx.app.registerPath("file", target);
const request = (url: string, headers: Record<string, string> = {}) => ({ url, method: "GET", headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } });
const serve = (ctx: App, url: string) => serveMedia({ handles: ctx.app.media.handles, zips: ctx.app.media.zips }, request(url));

type Candidate = { id: string; providerId: string; externalId: string; title: string; kindGuess: string | null; image: { url: string } | null; linkedElsewhere: string | null; sourceUrl: string };
type Outcome = { searchId: string; results: Candidate[]; failures: Array<{ providerId: string; code: string; retryable: boolean }>; partial: boolean };
type Field = { value: unknown; source: string | null; providerId?: string; policy: string; candidates: Array<{ source: string; value: unknown; selected: boolean }> };
type Work = {
  title: string;
  coverCount: number;
  coverState: string;
  fields: Record<string, Field>;
  links: Array<{ providerId: string; externalId: string; linkState: string; matchBasis: string; namespace: string }>;
  snapshots: Array<{ providerId: string; detached: boolean; fetchedAt: string | null; sourceUrl: string | null }>;
  suggestedQuery?: string;
  linkedSource?: { providerId: string; rating: { score: number } | null; episodeCount: number; relatedCount: number; detached: boolean; sourceUrl: string } | null;
};

let fake: FakeBangumi;

beforeAll(async () => {
  requireSamples(["cbz-comicinfo", "video-episodes", "comic-pdf-images", "cbz-basic"]);
  fake = await startFakeBangumi();
});
afterAll(async () => { await fake.stop(); });

async function seedFake(): Promise<void> {
  fake.reset();
  const [red, green, blue] = await Promise.all([fake.addImage("a.png", "red"), fake.addImage("b.png", "green"), fake.addImage("c.png", "blue")]);
  void red; void green; void blue;
  const tags = [{ name: "synthetic", count: 30 }, { name: "demo", count: 20 }, { name: "sample", count: 10 }];
  fake.subject(101, { type: 1, platform: "漫画", name: "Synthetic Series", name_cn: "合成系列", imageName: "a.png", volumes: 3, eps: 0, total_episodes: 0, infobox: [{ key: "作者", value: "A. Writer" }, { key: "出版社", value: "Synthetic Press" }], tags });
  fake.subject(102, { type: 1, platform: "小说", name: "Synthetic Novel", name_cn: "合成小说", imageName: "b.png", volumes: 2, eps: 0, total_episodes: 0, infobox: [{ key: "作者", value: "B. Author" }], tags });
  fake.subject(201, { type: 2, name: "Sample Anime", name_cn: "样例动画", imageName: "c.png", tags });
  fake.relations.set(101, [{ id: 102, type: 1, name: "Synthetic Novel", name_cn: "合成小说", images: null, relation: "原作" }]);
  fake.episodes.set(201, [1, 2, 3].map((n) => ({ id: 9000 + n, type: 0, name: `Episode ${n}`, name_cn: `第${n}话`, sort: n, ep: n, airdate: `2020-04-0${n}`, duration: "00:24:00" })));
}

async function boot(options: Parameters<typeof startApp>[0] = {}): Promise<App> {
  await seedFake();
  const ctx = await startApp({ ...options, options: { appVersion: "9.9.9", bangumi: fake.clientOptions, ...options?.options } });
  return ctx;
}

async function comicWork(ctx: App, title = "文件里的漫画"): Promise<{ workId: string; resourceId: string }> {
  const imported = ok<{ workId: string; resourceId: string }>(await run(ctx, "library.importDocument", { title, kind: "comic", pathHandle: pick(ctx, samplePath("cbz-comicinfo")) }));
  await ctx.app.media.jobs.idle();
  return imported;
}

const work = async (ctx: App, workId: string) => ok<Work>(await run(ctx, "works.get", { workId }));
const search = async (ctx: App, input: Record<string, unknown>) => ok<Outcome>(await run(ctx, "metadata.search", input));
const isSearch = (item: { method: string; path: string }) => item.method === "POST" && item.path.startsWith("/v0/search/subjects");

describe("searching, picking and linking an entry", () => {
  it("asks Bangumi politely, keeps the candidates, and lets the user choose one", async () => {
    const ctx = await boot();
    try {
      const imported = await comicWork(ctx);
      const outcome = await search(ctx, { workId: imported.workId, query: "Synthetic", kind: "comic" });
      expect(outcome.failures).toEqual([]);
      expect(outcome.results.map((item) => item.externalId)).toEqual(["101", "102"]);
      // A book whose platform says comic comes before one that says novel when a comic is wanted.
      expect(outcome.results.map((item) => item.kindGuess)).toEqual(["comic", "novel"]);
      expect(outcome.results[0]!.sourceUrl).toContain("/subject/101");

      const sent = fake.requests.filter(isSearch);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.headers["user-agent"]).toBe(USER_AGENT);
      expect(sent[0]!.headers.authorization).toBeUndefined();
      expect(JSON.parse(sent[0]!.body)).toEqual({ keyword: "Synthetic", filter: { type: [1] } });

      // Candidate pictures come through the main process and are served by handle; the renderer never sees a remote address.
      const picture0 = outcome.results[0]!.image!;
      expect(picture0.url).toMatch(/^manga-media:\/\//);
      expect(JSON.stringify(outcome)).not.toContain("/img/");
      expect(outcome.results[0]).not.toHaveProperty("imageUrl");
      const served = await serve(ctx, picture0.url);
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe("image/png");

      const kept = ok<{ candidates: Candidate[] }>(await run(ctx, "metadata.candidates", { workId: imported.workId }));
      expect(kept.candidates.map((item) => item.externalId)).toEqual(["101", "102"]);

      const linked = ok<{ cover: { selected: boolean; coverId: string }; episodes: number; related: number; warnings: string[]; namespace: string }>(await run(ctx, "metadata.link", {
        workId: imported.workId, providerId: "bangumi", externalId: "101", candidateId: outcome.results[0]!.id,
      }));
      expect(linked).toMatchObject({ namespace: "bangumi:subject", episodes: 0, related: 1, warnings: [] });
      // A better picture replaces the one taken from the file while the cover is still automatic.
      expect(linked.cover.selected).toBe(true);

      const detail = await work(ctx, imported.workId);
      expect(detail.coverCount).toBe(2);
      expect(detail.coverState).toBe("auto");
      expect(detail.links[0]).toMatchObject({ providerId: "bangumi", externalId: "101", linkState: "linked", matchBasis: "user_selected_candidate" });
      expect(detail.fields.title).toMatchObject({ value: "合成系列", source: "online", providerId: "bangumi" });
      expect(detail.fields.author).toMatchObject({ value: "A. Writer", source: "online" });
      expect(detail.fields.studio?.value).toBe("Synthetic Press");
      expect(detail.linkedSource).toMatchObject({ providerId: "bangumi", relatedCount: 1, episodeCount: 0, detached: false });
      expect(detail.linkedSource?.rating).toMatchObject({ score: 7.5 });
      expect(detail.linkedSource?.sourceUrl).toContain("/subject/101");
      expect(detail.snapshots.map((item) => item.providerId).sort()).toEqual(["bangumi", "local-file"]);
      // The candidates of the finished choice are closed.
      expect(ok<{ candidates: unknown[] }>(await run(ctx, "metadata.candidates", { workId: imported.workId })).candidates).toHaveLength(0);
      const covers = ok<{ covers: Array<{ source: string; selected: boolean }> }>(await run(ctx, "covers.list", { workId: imported.workId }));
      expect(covers.covers.filter((item) => item.selected).map((item) => item.source)).toEqual(["bangumi"]);
      // Pictures from Bangumi are the user's data (backed up with the library, stored in the images table since the M2 rework); pictures from files are cache.
      const areas = ctx.app.store.sqlite.prepare("SELECT source, area FROM covers WHERE work_id = ? ORDER BY source").all(imported.workId) as Array<{ source: string; area: string }>;
      expect(areas).toEqual([{ source: "bangumi", area: "images" }, { source: "file", area: "cache" }]);
      const stored = ctx.app.store.sqlite.prepare("SELECT c.image_hash AS hash, i.bytes AS bytes FROM covers c JOIN images i ON i.hash = c.image_hash WHERE c.work_id = ? AND c.area = 'images'").all(imported.workId) as Array<{ hash: string; bytes: number }>;
      expect(stored).toHaveLength(1);
      expect(stored[0]!.bytes).toBeGreaterThan(0);
    } finally { ctx.app.close(); }
  });

  it("searches videos as anime, with episode titles kept for later, and suggests a clean query from the file name", async () => {
    const ctx = await boot();
    try {
      const dir = samplePath("video-episodes");
      const imported = ok<{ workId: string }>(await run(ctx, "works.importDirectory", { pathHandle: ctx.app.registerPath("directory", dir), kind: "video" }));
      await ctx.app.media.jobs.idle();
      const detail = await work(ctx, imported.workId);
      expect(detail.suggestedQuery).toBe("Sample Anime");
      const outcome = await search(ctx, { workId: imported.workId, query: detail.suggestedQuery!, kind: "video" });
      expect(outcome.results.map((item) => item.externalId)).toEqual(["201"]);
      expect(JSON.parse(fake.requests.filter(isSearch).at(-1)!.body).filter).toEqual({ type: [2] });
      const linked = ok<{ episodes: number }>(await run(ctx, "metadata.link", { workId: imported.workId, providerId: "bangumi", externalId: "201" }));
      expect(linked.episodes).toBe(3);
      const after = await work(ctx, imported.workId);
      expect(after.links[0]!.matchBasis).toBe("user_entered_id");
      expect(after.linkedSource?.episodeCount).toBe(3);
      // Episode lists are fetched in pages of 100 at most, and only for anime.
      expect(fake.requests.filter((item) => item.path.startsWith("/v0/episodes"))).toHaveLength(1);
    } finally { ctx.app.close(); }
  });

  it("refuses an unknown entry and a broken answer without writing anything", async () => {
    const ctx = await boot();
    try {
      const imported = await comicWork(ctx);
      const missing = await run(ctx, "metadata.link", { workId: imported.workId, providerId: "bangumi", externalId: "999999" });
      expect(missing.status).toBe("error");
      expect(missing.error?.code).toBe("NOT_FOUND");
      // An answer without the fields MANGA relies on is a source failure, not data.
      fake.script((item) => item.path === "/v0/subjects/101", { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "unexpected" }) });
      const drift = await run(ctx, "metadata.link", { workId: imported.workId, providerId: "bangumi", externalId: "101" });
      expect(drift.error?.code).toBe("PROVIDER_UNAVAILABLE");
      expect(drift.error?.details?.reason).toBe("schema");
      const notJson = fake.script((item) => item.path === "/v0/subjects/101", { status: 200, body: "<html>maintenance</html>" });
      void notJson;
      const html = await run(ctx, "metadata.link", { workId: imported.workId, providerId: "bangumi", externalId: "101" });
      expect(html.error?.code).toBe("PROVIDER_UNAVAILABLE");
      const detail = await work(ctx, imported.workId);
      expect(detail.links).toHaveLength(0);
      expect(detail.snapshots.map((item) => item.providerId)).toEqual(["local-file"]);
      expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM covers WHERE source = 'bangumi'").get()).toEqual({ n: 0 });
    } finally { ctx.app.close(); }
  });

  it("marks an entry already linked to another work, and links more than one work to it only on purpose", async () => {
    const ctx = await boot();
    try {
      const first = await comicWork(ctx, "第一部");
      ok(await run(ctx, "metadata.link", { workId: first.workId, providerId: "bangumi", externalId: "101" }));
      const second = ok<{ workId: string }>(await run(ctx, "library.importDocument", { title: "第二部", kind: "comic", pathHandle: pick(ctx, samplePath("cbz-basic")) }));
      const outcome = await search(ctx, { workId: second.workId, query: "Synthetic", kind: "comic" });
      expect(outcome.results.find((item) => item.externalId === "101")?.linkedElsewhere).toBe(first.workId);
      expect(outcome.results.find((item) => item.externalId === "102")?.linkedElsewhere).toBeNull();
    } finally { ctx.app.close(); }
  });
});

describe("what the user decided survives refreshing, unlinking and going offline", () => {
  it("keeps overrides and locks across a refresh that changes the entry", async () => {
    const ctx = await boot();
    try {
      const imported = await comicWork(ctx);
      ok(await run(ctx, "metadata.link", { workId: imported.workId, providerId: "bangumi", externalId: "101" }));
      ok(await run(ctx, "works.setOverride", { workId: imported.workId, fields: { title: "我的标题" }, locked: ["title"], cleared: [] }));
      fake.subjects.get(101)!.name_cn = "合成系列（新版）";
      fake.subjects.get(101)!.summary = "A rewritten summary.";
      const refreshed = ok<{ refreshed: Array<{ changed: boolean }>; stale: unknown[] }>(await run(ctx, "metadata.refresh", { workId: imported.workId }));
      expect(refreshed.refreshed).toHaveLength(1);
      expect(refreshed.refreshed[0]!.changed).toBe(true);
      expect(refreshed.stale).toEqual([]);
      const detail = await work(ctx, imported.workId);
      expect(detail.fields.title).toMatchObject({ value: "我的标题", source: "user", policy: "locked" });
      expect(detail.fields.title!.candidates.find((item) => item.source === "online")?.value).toBe("合成系列（新版）");
      expect(detail.fields.summary).toMatchObject({ value: "A rewritten summary.", source: "online" });
      // Refreshing again with nothing new changes nothing.
      const same = ok<{ refreshed: Array<{ changed: boolean }> }>(await run(ctx, "metadata.refresh", { workId: imported.workId }));
      expect(same.refreshed[0]!.changed).toBe(false);
    } finally { ctx.app.close(); }
  });

  it("reports a source that cannot be reached as stale, keeps the saved snapshot, and recovers", async () => {
    const ctx = await boot();
    try {
      const imported = await comicWork(ctx);
      ok(await run(ctx, "metadata.link", { workId: imported.workId, providerId: "bangumi", externalId: "101" }));
      const before = (await work(ctx, imported.workId)).snapshots.find((item) => item.providerId === "bangumi")!;
      const subjectRequests = () => fake.count((item) => item.path === "/v0/subjects/101");
      const seen = subjectRequests();
      fake.script((item) => item.path === "/v0/subjects/101", { status: 500 }, { status: 502 }, { status: 503 });
      const stale = ok<{ refreshed: unknown[]; stale: Array<{ providerId: string; fetchedAt: string; error: { code: string; retryable: boolean } }> }>(await run(ctx, "metadata.refresh", { workId: imported.workId }));
      expect(stale.refreshed).toEqual([]);
      expect(stale.stale).toHaveLength(1);
      expect(stale.stale[0]).toMatchObject({ providerId: "bangumi", fetchedAt: before.fetchedAt, error: { code: "PROVIDER_UNAVAILABLE", retryable: true } });
      // Two retries after the first try, then it gives up: three requests, not a storm.
      expect(subjectRequests() - seen).toBe(3);
      const after = await work(ctx, imported.workId);
      expect(after.snapshots.find((item) => item.providerId === "bangumi")!.fetchedAt).toBe(before.fetchedAt);
      expect(after.fields.title?.value).toBe("合成系列");
      const recovered = ok<{ refreshed: unknown[]; stale: unknown[] }>(await run(ctx, "metadata.refresh", { workId: imported.workId }));
      expect(recovered.refreshed).toHaveLength(1);
      expect(recovered.stale).toEqual([]);
    } finally { ctx.app.close(); }
  });

  it("works offline: the library, the linked details and the covers stay, and a search reports the failure instead of throwing", async () => {
    const ctx = await boot();
    try {
      const imported = await comicWork(ctx);
      ok(await run(ctx, "metadata.link", { workId: imported.workId, providerId: "bangumi", externalId: "101" }));
      fake.offline = true;
      const outcome = await search(ctx, { query: "Synthetic" });
      expect(outcome.results).toEqual([]);
      expect(outcome.failures).toEqual([{ providerId: "bangumi", code: "PROVIDER_UNAVAILABLE", message: expect.any(String), retryable: true }]);
      expect(outcome.partial).toBe(false);
      const detail = await work(ctx, imported.workId);
      expect(detail.fields.title?.value).toBe("合成系列");
      expect(detail.linkedSource).toMatchObject({ providerId: "bangumi", relatedCount: 1 });
      const related = ok<{ source: { providerId: string }; relations: Array<{ title: string; sourceUrl: string }> }>(await run(ctx, "metadata.related", { workId: imported.workId }));
      expect(related.source.providerId).toBe("bangumi");
      expect(related.relations[0]).toMatchObject({ title: "合成小说" });
      const covers = ok<{ coverId: string }>(await run(ctx, "covers.list", { workId: imported.workId }));
      const handles = ok<{ covers: Array<{ available: boolean }> }>(await run(ctx, "covers.handles", { coverIds: [covers.coverId], size: "detail" }));
      expect(handles.covers[0]!.available).toBe(true);
      const refresh = ok<{ stale: Array<{ error: { code: string } }> }>(await run(ctx, "metadata.refresh", { workId: imported.workId }));
      expect(refresh.stale[0]!.error.code).toBe("PROVIDER_UNAVAILABLE");
      fake.offline = false;
      expect((await search(ctx, { query: "Synthetic" })).results.length).toBeGreaterThan(0);
    } finally { ctx.app.close(); }
  });

  it("keeps the saved details as a detached snapshot when unlinking, and lets the user link again", async () => {
    const ctx = await boot();
    try {
      const imported = await comicWork(ctx);
      ok(await run(ctx, "metadata.link", { workId: imported.workId, providerId: "bangumi", externalId: "101" }));
      const unlinked = ok<{ kept: boolean }>(await run(ctx, "metadata.unlink", { workId: imported.workId, providerId: "bangumi" }));
      expect(unlinked.kept).toBe(true);
      let detail = await work(ctx, imported.workId);
      expect(detail.links[0]!.linkState).toBe("unlinked");
      expect(detail.snapshots.find((item) => item.providerId === "bangumi")?.detached).toBe(true);
      // A detached snapshot ranks below the file's own data.
      expect(detail.fields.title).toMatchObject({ value: "Synthetic Series", source: "file" });
      expect(detail.fields.title!.candidates.map((item) => item.source)).toContain("detached");
      expect(detail.linkedSource?.detached).toBe(true);
      const again = await run(ctx, "metadata.unlink", { workId: imported.workId, providerId: "bangumi" });
      expect(again.error?.code).toBe("NOT_FOUND");
      const refresh = await run(ctx, "metadata.refresh", { workId: imported.workId });
      expect(refresh.error?.code).toBe("NOT_FOUND");
      ok(await run(ctx, "metadata.link", { workId: imported.workId, providerId: "bangumi", externalId: "102" }));
      detail = await work(ctx, imported.workId);
      expect(detail.links.filter((item) => item.linkState === "linked").map((item) => item.externalId)).toEqual(["102"]);
      expect(detail.fields.title).toMatchObject({ value: "合成小说", source: "online" });
    } finally { ctx.app.close(); }
  });
});

describe("a source that misbehaves", () => {
  const searchOnce = (ctx: App) => search(ctx, { query: "Synthetic" });

  it("waits and retries when asked to slow down, and says so when it keeps being refused", async () => {
    const ctx = await boot();
    try {
      fake.script(isSearch, { status: 429, headers: { "retry-after": "2" } });
      const retried = await searchOnce(ctx);
      expect(retried.failures).toEqual([]);
      expect(retried.results.length).toBeGreaterThan(0);
      expect(fake.count(isSearch)).toBe(2);
      fake.requests.length = 0;
      fake.script(isSearch, { status: 429 }, { status: 429 }, { status: 429 });
      const refused = await searchOnce(ctx);
      expect(refused.results).toEqual([]);
      expect(refused.failures[0]).toMatchObject({ providerId: "bangumi", code: "RATE_LIMITED", retryable: true });
      expect(fake.count(isSearch)).toBe(3);
    } finally { ctx.app.close(); }
  });

  it("does not follow a redirect to a host that is not on the list", async () => {
    const ctx = await boot();
    try {
      fake.script(isSearch, { status: 302, headers: { location: "http://127.0.0.1:9/steal" } });
      const outcome = await searchOnce(ctx);
      expect(outcome.failures[0]).toMatchObject({ code: "FORBIDDEN", retryable: false });
      expect(outcome.results).toEqual([]);
    } finally { ctx.app.close(); }
  });

  it("reports refused credentials as an authentication failure that is not worth retrying", async () => {
    const ctx = await boot();
    try {
      fake.script(isSearch, { status: 401, body: "{}" }, { status: 403, body: "{}" });
      const first = await searchOnce(ctx);
      expect(first.failures[0]).toMatchObject({ code: "AUTHENTICATION_FAILED", retryable: false });
      const second = await searchOnce(ctx);
      expect(second.failures[0]).toMatchObject({ code: "AUTHENTICATION_FAILED" });
      expect(fake.count(isSearch)).toBe(2);
    } finally { ctx.app.close(); }
  });

  it("drops a candidate picture that is not a picture or is too large, and still lists the candidate", async () => {
    const ctx = await boot();
    try {
      fake.images.set("a.png", { bytes: Buffer.from("<html>not a picture</html>"), mediaType: "text/html" });
      const outcome = await searchOnce(ctx);
      expect(outcome.results.find((item) => item.externalId === "101")).toMatchObject({ image: null });
      expect(outcome.results.find((item) => item.externalId === "102")?.image).not.toBeNull();
    } finally { ctx.app.close(); }
  });
});

describe("covers", () => {
  it("lets the user pick, add and lock a cover, and a locked cover never moves", async () => {
    const ctx = await boot();
    try {
      const imported = await comicWork(ctx);
      const own = path.join(ctx.profileRoot, "my-cover.png");
      fs.writeFileSync(own, await picture("gold", [400, 600]));
      const added = ok<{ coverId: string; added: boolean; selected: boolean }>(await run(ctx, "covers.fromImage", { workId: imported.workId, pathHandle: pick(ctx, own) }));
      expect(added).toMatchObject({ added: true, selected: true });
      let detail = await work(ctx, imported.workId);
      expect(detail.coverState).toBe("user");
      expect(detail.coverCount).toBe(2);
      // A user's picture beats a better remote one: linking adds the Bangumi picture but does not move the cover.
      const linked = ok<{ cover: { selected: boolean } }>(await run(ctx, "metadata.link", { workId: imported.workId, providerId: "bangumi", externalId: "101" }));
      expect(linked.cover.selected).toBe(false);
      let covers = ok<{ coverId: string; covers: Array<{ id: string; source: string; selected: boolean }> }>(await run(ctx, "covers.list", { workId: imported.workId }));
      expect(covers.coverId).toBe(added.coverId);
      expect(covers.covers.map((item) => item.source).sort()).toEqual(["bangumi", "file", "user"]);
      // Choosing another one is allowed until the cover is locked.
      const remote = covers.covers.find((item) => item.source === "bangumi")!;
      ok(await run(ctx, "covers.select", { workId: imported.workId, coverId: remote.id }));
      ok(await run(ctx, "covers.lock", { workId: imported.workId, locked: true }));
      expect((await work(ctx, imported.workId)).coverState).toBe("locked");
      // Adding a picture while locked keeps it as an option but leaves the cover where it is.
      const other = path.join(ctx.profileRoot, "other.png");
      fs.writeFileSync(other, await picture("blue", [200, 300]));
      expect(ok<{ selected: boolean }>(await run(ctx, "covers.fromImage", { workId: imported.workId, pathHandle: pick(ctx, other) })).selected).toBe(false);
      fake.subjects.get(101)!.name_cn = "合成系列二";
      ok(await run(ctx, "metadata.refresh", { workId: imported.workId }));
      covers = ok(await run(ctx, "covers.list", { workId: imported.workId }));
      expect(covers.coverId).toBe(remote.id);
      ok(await run(ctx, "covers.lock", { workId: imported.workId, locked: false }));
      detail = await work(ctx, imported.workId);
      expect(detail.coverState).toBe("user");
      const wrongWork = await run(ctx, "covers.select", { workId: imported.workId, coverId: "cov_nope" });
      expect(wrongWork.error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  });

  it("refuses a cover that is not a picture or is not a path the user picked", async () => {
    const ctx = await boot();
    try {
      const imported = await comicWork(ctx);
      const text = path.join(ctx.profileRoot, "note.txt");
      fs.writeFileSync(text, "not a picture");
      expect((await run(ctx, "covers.fromImage", { workId: imported.workId, pathHandle: pick(ctx, text) })).status).toBe("error");
      expect((await run(ctx, "covers.fromImage", { workId: imported.workId, pathHandle: "path_unknown" })).error?.code).toBe("FORBIDDEN");
      const directory = ctx.app.registerPath("directory", ctx.profileRoot);
      expect((await run(ctx, "covers.fromImage", { workId: imported.workId, pathHandle: directory })).error?.code).toBe("FORBIDDEN");
      expect((await work(ctx, imported.workId)).coverCount).toBe(1);
      expect((await run(ctx, "covers.lock", { workId: "work_none", locked: true })).error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  });
});

describe("related works and the batch of unknown works", () => {
  it("lists related works with their source, marks the ones in the library, and offers works that share tags", async () => {
    const ctx = await boot();
    try {
      const first = await comicWork(ctx, "第一部");
      const second = ok<{ workId: string }>(await run(ctx, "library.importDocument", { title: "第二部", kind: "comic", pathHandle: pick(ctx, samplePath("cbz-basic")) }));
      ok(await run(ctx, "metadata.link", { workId: first.workId, providerId: "bangumi", externalId: "101" }));
      ok(await run(ctx, "metadata.link", { workId: second.workId, providerId: "bangumi", externalId: "102" }));
      const related = ok<{
        source: { providerId: string; fetchedAt: string; detached: boolean };
        relations: Array<{ externalId: string; relation: string; inLibraryWorkId: string | null; providerId: string; sourceUrl: string }>;
        similar: Array<{ workId: string; sharedTags: string[]; score: number }>;
      }>(await run(ctx, "metadata.related", { workId: first.workId }));
      expect(related.source).toMatchObject({ providerId: "bangumi", detached: false });
      expect(related.relations).toEqual([expect.objectContaining({ externalId: "102", relation: "原作", inLibraryWorkId: second.workId, providerId: "bangumi" })]);
      expect(related.relations[0]!.sourceUrl).toContain("/subject/102");
      expect(related.similar.map((item) => item.workId)).toEqual([second.workId]);
      expect(related.similar[0]!.sharedTags).toEqual(expect.arrayContaining(["synthetic", "demo"]));
      // Without a model: nothing in this answer came from one, and no network request was needed for it.
      const before = fake.requests.length;
      ok(await run(ctx, "metadata.related", { workId: first.workId }));
      expect(fake.requests.length).toBe(before);
    } finally { ctx.app.close(); }
  });

  it("searches for every unlinked work in the background, offers the results as candidates and never links by itself", async () => {
    const ctx = await boot();
    try {
      const comic = await comicWork(ctx);
      const linked = ok<{ workId: string }>(await run(ctx, "library.importDocument", { title: "Synthetic Series", kind: "comic", pathHandle: pick(ctx, samplePath("cbz-basic")) }));
      ok(await run(ctx, "metadata.link", { workId: linked.workId, providerId: "bangumi", externalId: "101" }));
      fake.requests.length = 0;
      const queued = ok<{ queued: number; workIds: string[]; jobId: string | null }>(await run(ctx, "metadata.findMissing", { kind: "comic" }));
      expect(queued.workIds).toEqual([comic.workId]);
      expect(queued.jobId).toEqual(expect.any(String));
      await ctx.app.media.jobs.idle();
      const candidates = ok<{ candidates: Candidate[] }>(await run(ctx, "metadata.candidates", { workId: comic.workId }));
      expect(candidates.candidates.length).toBeGreaterThan(0);
      expect((await work(ctx, comic.workId)).links).toEqual([]);
      // Works that already wait for a decision are not searched again.
      expect(ok<{ queued: number }>(await run(ctx, "metadata.findMissing", { kind: "comic" })).queued).toBe(0);
      // Searching stops for the batch when the source cannot be reached, instead of repeating the failure for every work.
      const another = ok<{ workId: string }>(await run(ctx, "library.importDocument", { title: "第三部", kind: "comic", pathHandle: pick(ctx, samplePath("comic-pdf-images")) }));
      void another;
      fake.offline = true;
      fake.requests.length = 0;
      ok(await run(ctx, "metadata.findMissing", { kind: "comic" }));
      await ctx.app.media.jobs.idle();
      expect(fake.count(isSearch)).toBeLessThanOrEqual(1);
    } finally { ctx.app.close(); }
  });
});

describe("a second source, and turning the module off", () => {
  class OtherSource implements OnlineProvider {
    readonly id = "other-source";
    readonly displayName = "合成的另一来源";
    readonly namespace = "other:item";
    down = false;
    async search(input: { query: string }): Promise<SearchHit[]> {
      if (this.down) throw new MangaError("PROVIDER_UNAVAILABLE", "the other source is down", { retryable: true });
      return [{ providerId: this.id, externalId: "x-1", title: `${input.query} (other)`, subjectType: 0, kindGuess: "comic", sourceUrl: "https://example.invalid/x-1" }];
    }
    async detail(externalId: string): Promise<SubjectDetail> {
      return {
        providerId: this.id, externalId, namespace: this.namespace, subjectType: 0, fields: { title: "另一来源的标题", author: "C. Other" }, rating: null,
        images: { large: "", common: "", medium: "", small: "", grid: "" }, sourceUrl: `https://example.invalid/${externalId}`, related: [], episodes: [], apiVersion: "other-1", warnings: [],
      };
    }
    async image(): Promise<{ bytes: Buffer; mediaType: string }> { throw new MangaError("NOT_FOUND", "no pictures"); }
    pageUrl(externalId: string): string { return `https://example.invalid/${externalId}`; }
  }

  it("lets another source take Bangumi's place without touching the library", async () => {
    const other = new OtherSource();
    const ctx = await boot({ options: { extraMetadataProviders: [other] } });
    try {
      expect(ok<{ providers: Array<{ id: string; kind: string; enabled: boolean }> }>(await run(ctx, "metadata.providers", {})).providers.map((item) => [item.id, item.kind])).toEqual([["bangumi", "online"], ["other-source", "online"], ["local-file", "local"]]);
      const imported = await comicWork(ctx);
      const both = await search(ctx, { workId: imported.workId, query: "Synthetic" });
      expect(new Set(both.results.map((item) => item.providerId))).toEqual(new Set(["bangumi", "other-source"]));
      // Fallback asks the next source only when the first fails or finds nothing.
      fake.offline = true;
      const fallback = await search(ctx, { query: "Synthetic", mode: "fallback" });
      expect(fallback.results.map((item) => item.providerId)).toEqual(["other-source"]);
      expect(fallback.failures.map((item) => item.providerId)).toEqual(["bangumi"]);
      expect(fallback.partial).toBe(true);
      fake.offline = false;
      ok(await run(ctx, "metadata.link", { workId: imported.workId, providerId: "other-source", externalId: "x-1" }));
      let detail = await work(ctx, imported.workId);
      expect(detail.fields.title).toMatchObject({ value: "另一来源的标题", providerId: "other-source" });
      expect(detail.links.map((item) => item.providerId)).toEqual(["other-source"]);
      // Turning Bangumi off keeps the work, its links and covers; searching only asks the sources that are on.
      ok(await run(ctx, "metadata.setProvider", { providerId: "bangumi", enabled: false }));
      const only = await search(ctx, { query: "Synthetic" });
      expect(new Set(only.results.map((item) => item.providerId))).toEqual(new Set(["other-source"]));
      const refused = await run(ctx, "metadata.search", { query: "Synthetic", providerIds: ["bangumi"] });
      expect(refused.error?.code).toBe("CAPABILITY_UNAVAILABLE");
      detail = await work(ctx, imported.workId);
      expect(detail.coverCount).toBe(1);
      expect(detail.fields.title?.value).toBe("另一来源的标题");
      ok(await run(ctx, "metadata.setProvider", { providerId: "other-source", enabled: false }));
      expect((await run(ctx, "metadata.search", { query: "Synthetic" })).error?.code).toBe("CAPABILITY_UNAVAILABLE");
      expect((await run(ctx, "metadata.findMissing", {})).error?.code).toBe("CAPABILITY_UNAVAILABLE");
      expect((await run(ctx, "metadata.setProvider", { providerId: "no-such", enabled: true })).error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  });

  it("stops network work and revokes candidate pictures when the module is turned off, and works again when it is turned on", async () => {
    const ctx = await boot();
    try {
      const imported = await comicWork(ctx);
      const outcome = await search(ctx, { workId: imported.workId, query: "Synthetic" });
      const url = outcome.results[0]!.image!.url;
      expect((await serve(ctx, url)).status).toBe(200);
      const profile = ctx.app.runtime.snapshot().lastValidProfile!;
      await ctx.app.runtime.applyProfile({ ...profile, revision: profile.revision + 1, disabledFeatures: [...profile.disabledFeatures, "metadata"] });
      expect((await serve(ctx, url)).status).toBe(404);
      const requestsBefore = fake.requests.length;
      for (const [commandId, input] of Object.entries({
        "metadata.search": { query: "Synthetic" }, "metadata.providers": {}, "metadata.link": { workId: imported.workId, providerId: "bangumi", externalId: "101" },
        "metadata.refresh": { workId: imported.workId }, "metadata.related": { workId: imported.workId }, "metadata.findMissing": {},
      })) {
        expect((await run(ctx, commandId, input)).status, commandId).toBe("error");
      }
      expect(fake.requests.length).toBe(requestsBefore);
      // The library, its covers and its details stay while the module is off.
      const detail = await work(ctx, imported.workId);
      expect(detail.coverCount).toBe(1);
      expect(detail.fields.title?.value).toBe("Synthetic Series");
      ok(await run(ctx, "covers.list", { workId: imported.workId }));
      await ctx.app.runtime.applyProfile({ ...profile, revision: profile.revision + 2 });
      expect((await search(ctx, { query: "Synthetic" })).results.length).toBeGreaterThan(0);
    } finally { ctx.app.close(); }
  });

  it("cancels a batch search that is running when the module is turned off", async () => {
    const ctx = await boot();
    try {
      await comicWork(ctx);
      const states: string[] = [];
      ctx.app.media.jobs.onChange((job) => { if (job.kind === "metadata-find-missing") states.push(job.state); });
      fake.script(isSearch, { status: 200, delayMs: 3000, body: "{}" });
      ok(await run(ctx, "metadata.findMissing", {}));
      const started = Date.now();
      while (!states.includes("running") && Date.now() - started < 3000) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(states).toContain("running");
      const profile = ctx.app.runtime.snapshot().lastValidProfile!;
      await ctx.app.runtime.applyProfile({ ...profile, revision: profile.revision + 1, disabledFeatures: [...profile.disabledFeatures, "metadata"] });
      await ctx.app.media.jobs.idle();
      expect(Date.now() - started).toBeLessThan(2500);
      expect(states.at(-1)).toBe("cancelled");
    } finally { ctx.app.close(); }
  });
});

describe("the access token", () => {
  it("is stored only protected, sent only to the API, never to a picture host, and never leaves the app", async () => {
    const ctx = await boot();
    try {
      const secret = "synthetic-token-0123456789abcdef";
      const notices: string[] = [];
      ctx.app.onNotice((notice) => notices.push(JSON.stringify(notice)));
      const handle = ctx.app.stashSecret(secret);
      const state = ok<{ enabled: boolean; credentialConfigured: boolean }>(await run(ctx, "metadata.setProvider", { providerId: "bangumi", enabled: true, credentialHandle: handle }));
      expect(state.credentialConfigured).toBe(true);
      expect(JSON.stringify(state)).not.toContain(secret);
      // The handle is spent: it cannot be replayed to read or reuse the secret.
      expect((await run(ctx, "metadata.setProvider", { providerId: "bangumi", enabled: true, credentialHandle: handle })).error?.code).toBe("FORBIDDEN");
      const imported = await comicWork(ctx);
      await search(ctx, { workId: imported.workId, query: "Synthetic" });
      ok(await run(ctx, "metadata.link", { workId: imported.workId, providerId: "bangumi", externalId: "101" }));
      const api = fake.requests.filter((item) => item.path.startsWith("/v0/"));
      expect(api.length).toBeGreaterThan(2);
      for (const item of api) expect(item.headers.authorization, item.path).toBe(`Bearer ${secret}`);
      const images = fake.requests.filter((item) => item.path.startsWith("/img/"));
      expect(images.length).toBeGreaterThan(0);
      for (const item of images) expect(item.headers.authorization, item.path).toBeUndefined();

      expect(JSON.stringify(ok(await run(ctx, "metadata.providers", {})))).not.toContain(secret);
      expect(JSON.stringify(await work(ctx, imported.workId))).not.toContain(secret);
      expect(notices.join("\n")).not.toContain(secret);
      ctx.app.store.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      for (const name of fs.readdirSync(ctx.app.layout.partitions.data)) {
        const file = path.join(ctx.app.layout.partitions.data, name);
        if (fs.statSync(file).isFile()) expect(fs.readFileSync(file).includes(Buffer.from(secret)), name).toBe(false);
      }

      const before = fake.requests.length;
      ok(await run(ctx, "metadata.setProvider", { providerId: "bangumi", enabled: true, clearCredential: true }));
      expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM credentials").get()).toEqual({ n: 0 });
      await search(ctx, { query: "Synthetic" });
      expect(fake.requests.slice(before).every((item) => item.headers.authorization === undefined)).toBe(true);
    } finally { ctx.app.close(); }
  });
});

describe("grants", () => {
  it("keeps covers and metadata away from an agent", async () => {
    const ctx = await boot();
    try {
      const imported = await comicWork(ctx);
      const agent = { kind: "agent" as const, id: "agent-m" };
      const grant = ctx.app.issueAgentGrant(ctx.grant, agent, { sessionId: "sess-m", runId: "run-m", readResourceIds: [imported.resourceId] });
      const inputs: Record<string, Record<string, unknown>> = {
        "metadata.providers": {}, "metadata.setProvider": { providerId: "bangumi", enabled: false }, "metadata.search": { query: "x" }, "metadata.candidates": { workId: imported.workId },
        "metadata.link": { workId: imported.workId, providerId: "bangumi", externalId: "1" }, "metadata.unlink": { workId: imported.workId, providerId: "bangumi" },
        "metadata.refresh": { workId: imported.workId }, "metadata.related": { workId: imported.workId }, "metadata.findMissing": {},
        "covers.list": { workId: imported.workId }, "covers.select": { workId: imported.workId, coverId: "c" }, "covers.lock": { workId: imported.workId, locked: true },
        "covers.fromImage": { workId: imported.workId, pathHandle: "p" }, "covers.handles": { coverIds: ["c"], size: "grid" },
      };
      for (const [commandId, input] of Object.entries(inputs)) {
        expect((await run(ctx, commandId, input, grant.handle, agent)).error?.code, commandId).toBe("FORBIDDEN");
      }
      expect(fake.requests).toHaveLength(0);
      // The agent's view of a work does not carry the linked source's details.
      const view = ok<Record<string, unknown>>(await run(ctx, "works.get", { workId: imported.workId }, grant.handle, agent));
      expect(view.linkedSource).toBeUndefined();
      expect(view.suggestedQuery).toBeUndefined();
    } finally { ctx.app.close(); }
  });
});
