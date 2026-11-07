import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseBangumiRef } from "../../packages/app-core/src/metadata/ref.ts";
import { MAX_AVATARS } from "../../packages/app-core/src/metadata/service.ts";
import { startApp } from "../helpers/app.ts";
import { startFakeBangumi, type FakeBangumi } from "../helpers/fake-bangumi.ts";
import { seedComic } from "../helpers/media-seed.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>, grantHandle = ctx.grant.handle, actor: { kind: "user" | "agent"; id: string } = ctx.actor): Promise<Call> {
  counter += 1;
  return ctx.app.call(actor, { commandId, idempotencyKey: `meta2-${counter}`, input }, grantHandle);
}
const ok = <T = Record<string, any>>(result: Call): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};

let fake: FakeBangumi;
beforeAll(async () => { fake = await startFakeBangumi(); });
afterAll(async () => { await fake.stop(); });

async function boot(): Promise<App> {
  fake.reset();
  await Promise.all([fake.addImage("a.png", "red"), fake.addImage("b.png", "green")]);
  fake.subject(101, { type: 1, platform: "漫画", name: "Synthetic Series", name_cn: "合成系列", imageName: "a.png", volumes: 3, eps: 0, total_episodes: 0, infobox: [{ key: "作者", value: "A. Writer" }, { key: "出版社", value: "Synthetic Press" }], tags: [{ name: "synthetic", count: 30 }, { name: "demo", count: 20 }] });
  fake.subject(102, { type: 1, platform: "小说", name: "Synthetic Novel", name_cn: "合成小说", imageName: "b.png", volumes: 2, eps: 0, total_episodes: 0 });
  fake.subject(201, { type: 2, name: "Sample Anime", name_cn: "样例动画", imageName: "b.png" });
  return startApp({ options: { appVersion: "9.9.9", bangumi: fake.clientOptions } });
}

/** A comic work whose only field so far is the title taken from its name. */
function comic(ctx: App, title = "文件名里的漫画") {
  const seeded = seedComic(ctx.app, { title, pageCount: 2 });
  ctx.app.metadata.reproject(seeded.workId);
  return seeded;
}

const isCredits = (item: { path: string }) => /\/v0\/subjects\/\d+\/(characters|persons)$/.test(item.path);

describe("a pasted number or link", () => {
  it("takes the entry number out of the forms the interface accepts, with www, a slash, a query or a fragment", () => {
    const accepted: Array<[string, string, string]> = [
      ["12345", "12345", "id"],
      ["  12345  ", "12345", "id"],
      ["00123", "123", "id"],
      ["subject/12345", "12345", "path"],
      ["/subject/12345/", "12345", "path"],
      ["Subject/12345?x=1#top", "12345", "path"],
      ["https://bgm.tv/subject/12345", "12345", "url"],
      ["https://bangumi.tv/subject/12345", "12345", "url"],
      ["https://chii.in/subject/12345", "12345", "url"],
      ["https://www.bgm.tv/subject/12345/", "12345", "url"],
      ["https://bgm.tv/subject/12345?from=list", "12345", "url"],
      ["https://bgm.tv/subject/12345#comments", "12345", "url"],
      ["http://bangumi.tv/subject/9", "9", "url"],
      ["https://BGM.TV/subject/12345", "12345", "url"],
      ["bgm.tv/subject/12345", "12345", "url"],
    ];
    for (const [text, id, form] of accepted) expect(parseBangumiRef(text), text).toEqual({ ok: true, externalId: id, form });
  });

  it("refuses what is not an entry page and says why", () => {
    const refused: Array<[string, string]> = [
      ["", "empty"],
      ["   ", "empty"],
      ["abc", "not-a-subject"],
      ["12ab", "not-a-subject"],
      ["0", "bad-id"],
      ["123456789012", "bad-id"],
      ["subject/abc", "bad-id"],
      ["subject/", "bad-id"],
      ["subject/12345/comments", "extra-path"],
      ["https://bgm.tv/subject/12345/comments", "extra-path"],
      ["https://bgm.tv/character/77", "character-page"],
      ["character/77", "character-page"],
      ["https://bgm.tv/person/88", "person-page"],
      ["https://bangumi.tv/anime/browser", "other-page"],
      ["https://bgm.tv/", "not-a-subject"],
      ["https://example.test/subject/12345", "foreign-host"],
      ["https://bgm.tv.example.test/subject/12345", "foreign-host"],
      ["https://evil.test/bgm.tv/subject/12345", "foreign-host"],
      ["https://bgm.tv@evil.test/subject/12345", "foreign-host"],
      ["https://" + "user:pw" + "@bgm.tv/subject/12345", "foreign-host"],
      ["https://bgm.tv:8443/subject/12345", "foreign-host"],
      ["https://api.bgm.tv/v0/subjects/12345", "foreign-host"],
      ["ftp://bgm.tv/subject/12345", "not-a-subject"],
      ["javascript:alert(1)", "not-a-subject"],
    ];
    for (const [text, reason] of refused) expect(parseBangumiRef(text), text).toEqual({ ok: false, reason });
  });

  it("checks the entry with the source, once, and reports a missing entry, a mismatch and an entry used elsewhere", async () => {
    const ctx = await boot();
    try {
      const target = comic(ctx);
      const resolved = ok<{ externalId: string; form: string; entry: { title: string; kindGuess: string | null }; image: { url: string } | null; kindMismatch: unknown; linkedElsewhere: string | null; alreadyLinked: boolean }>(await run(ctx, "metadata.resolveRef", { ref: "https://bgm.tv/subject/101", workId: target.workId }));
      expect(resolved).toMatchObject({ externalId: "101", form: "url", entry: { title: "合成系列", kindGuess: "comic" }, kindMismatch: null, linkedElsewhere: null, alreadyLinked: false });
      expect(resolved.image?.url).toMatch(/^manga-media:\/\//);
      expect(JSON.stringify(resolved)).not.toContain("/img/");
      // The lookup is one request for the entry and one for its picture: not the relations and episodes a link fetches.
      const lookups = fake.requests.filter((item) => item.path.startsWith("/v0/"));
      expect(lookups.map((item) => item.path)).toEqual(["/v0/subjects/101"]);

      // An anime entry offered for a comic work: a notice, and the answer is still usable.
      const mismatch = ok<{ kindMismatch: { expected: string; actual: string | null; subjectType: number } | null }>(await run(ctx, "metadata.resolveRef", { ref: "subject/201", workId: target.workId }));
      expect(mismatch.kindMismatch).toEqual({ expected: "comic", actual: "video", subjectType: 2 });
      const novel = ok<{ kindMismatch: unknown }>(await run(ctx, "metadata.resolveRef", { ref: "102", workId: target.workId }));
      expect(novel.kindMismatch).toMatchObject({ expected: "comic", actual: "novel" });

      // An entry that does not exist is the source's answer, not a malfunction.
      const missing = await run(ctx, "metadata.resolveRef", { ref: "999999", workId: target.workId });
      expect(missing.status).toBe("error");
      expect(missing.error?.code).toBe("NOT_FOUND");

      // A refused form is refused before anything is asked of the network.
      const before = fake.requests.length;
      const refused = await run(ctx, "metadata.resolveRef", { ref: "https://bgm.tv/character/77", workId: target.workId });
      expect(refused.status).toBe("error");
      expect(refused.error?.code).toBe("VALIDATION_ERROR");
      expect((refused.error?.details as { reason?: string }).reason).toBe("character-page");
      expect(fake.requests.length).toBe(before);

      // Once the work is linked, the same entry is reported as already linked here and as taken when another work asks.
      ok(await run(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "101" }));
      const again = ok<{ alreadyLinked: boolean }>(await run(ctx, "metadata.resolveRef", { ref: "101", workId: target.workId }));
      expect(again.alreadyLinked).toBe(true);
      const other = comic(ctx, "另一部漫画");
      const taken = ok<{ linkedElsewhere: string | null; alreadyLinked: boolean }>(await run(ctx, "metadata.resolveRef", { ref: "101", workId: other.workId }));
      expect(taken.linkedElsewhere).toBe(target.workId);
      expect(taken.alreadyLinked).toBe(false);
    } finally { ctx.app.close(); }
  });

  it("is for the owner: a task cannot look entries up or attach them", async () => {
    const ctx = await boot();
    try {
      const target = comic(ctx);
      const agent = ctx.app.issueAgentGrant(ctx.grant, { kind: "agent", id: "agent:meta" }, { readResourceIds: [target.resourceId] });
      for (const [commandId, input] of [["metadata.resolveRef", { ref: "101" }], ["metadata.preview", { workId: target.workId, externalId: "101" }], ["metadata.characters", { workId: target.workId }]] as const) {
        const denied = await run(ctx, commandId, { ...input }, agent.handle, { kind: "agent", id: "agent:meta" });
        expect(denied.status, commandId).toBe("error");
        expect(denied.error?.code, commandId).toBe("FORBIDDEN");
      }
    } finally { ctx.app.close(); }
  });
});

describe("the preview before a link or a refresh", () => {
  type Diff = { key: string; current: { value: unknown; source: string | null; policy: string } | null; incoming: unknown; status: string; protected: boolean; keepByDefault: boolean };
  type Preview = { mode: string; externalId: string; fields: Diff[]; cover: { current: { source: string } | null; incoming: { url: string } | null; state: string; protected: boolean; willReplace: boolean }; kindMismatch: unknown; replacesLink: string | null; warnings: string[] };
  const field = (preview: Preview, key: string) => preview.fields.find((item) => item.key === key)!;
  const projected = async (ctx: App, workId: string, key: string) => ok<{ fields: Record<string, { value: unknown; policy: string; source: string | null }> }>(await run(ctx, "works.get", { workId })).fields[key]!;

  it("shows what would change field by field and writes nothing", async () => {
    const ctx = await boot();
    try {
      const target = comic(ctx);
      const before = ctx.app.store.sqlite.prepare("SELECT projection_json, updated_at FROM works WHERE id = ?").get(target.workId);
      const preview = ok<Preview>(await run(ctx, "metadata.preview", { workId: target.workId, externalId: "101" }));
      expect(preview).toMatchObject({ mode: "link", externalId: "101", kindMismatch: null, replacesLink: null });
      expect(field(preview, "title")).toMatchObject({ status: "differs", incoming: "合成系列", protected: false, keepByDefault: false, current: { value: "文件名里的漫画", source: "filename" } });
      expect(field(preview, "author")).toMatchObject({ status: "new", incoming: "A. Writer", current: null });
      expect(field(preview, "studio")).toMatchObject({ status: "new", incoming: "Synthetic Press" });
      expect(preview.cover).toMatchObject({ current: null, state: "auto", protected: false, willReplace: true });
      expect(preview.cover.incoming?.url).toMatch(/^manga-media:\/\//);
      // Nothing was saved: not a link, not a snapshot, not a changed projection.
      expect(ctx.app.store.sqlite.prepare("SELECT projection_json, updated_at FROM works WHERE id = ?").get(target.workId)).toEqual(before);
      expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM work_links WHERE work_id = ?").get(target.workId)).toEqual({ n: 0 });
      expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM metadata_snapshots WHERE work_id = ?").get(target.workId)).toEqual({ n: 0 });
      expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM subject_characters").get()).toEqual({ n: 0 });
    } finally { ctx.app.close(); }
  });

  it("marks what the user typed or locked as theirs, and a link keeps it", async () => {
    const ctx = await boot();
    try {
      const target = comic(ctx);
      ok(await run(ctx, "works.setOverride", { workId: target.workId, fields: { title: "我自己起的标题", summary: "我写的简介" }, locked: ["summary"], cleared: ["studio"] }));
      const preview = ok<Preview>(await run(ctx, "metadata.preview", { workId: target.workId, externalId: "101" }));
      expect(field(preview, "title")).toMatchObject({ protected: true, keepByDefault: true, current: { value: "我自己起的标题", policy: "user" } });
      expect(field(preview, "summary")).toMatchObject({ protected: true, current: { policy: "locked" } });
      expect(field(preview, "studio")).toMatchObject({ protected: true, current: null, status: "new" });
      ok(await run(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "101" }));
      expect(await projected(ctx, target.workId, "title")).toMatchObject({ value: "我自己起的标题", policy: "user" });
      expect(await projected(ctx, target.workId, "summary")).toMatchObject({ value: "我写的简介", policy: "locked" });
      expect(await projected(ctx, target.workId, "studio")).toMatchObject({ value: null, policy: "empty" });
      expect(await projected(ctx, target.workId, "author")).toMatchObject({ value: "A. Writer", source: "online" });
    } finally { ctx.app.close(); }
  });

  it("applies exactly what the user looked at: keeps the chosen fields as they are and takes the rest", async () => {
    const ctx = await boot();
    try {
      const target = comic(ctx);
      ok(await run(ctx, "metadata.preview", { workId: target.workId, externalId: "101" }));
      const asked = fake.requests.filter((item) => item.path.startsWith("/v0/subjects/101") && !isCredits(item)).length;
      const linked = ok<{ warnings: string[] }>(await run(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "101", keepFields: ["title"] }));
      // The entry the user previewed is used as it was: the source is not asked for it a second time.
      expect(fake.requests.filter((item) => item.path.startsWith("/v0/subjects/101") && !isCredits(item)).length).toBe(asked);
      expect(linked.warnings).toEqual([]);
      // The kept title stays the file's own and now belongs to the user; the source's other values are used.
      expect(await projected(ctx, target.workId, "title")).toMatchObject({ value: "文件名里的漫画", policy: "user" });
      expect(await projected(ctx, target.workId, "author")).toMatchObject({ value: "A. Writer", policy: "provider" });
      const snapshot = ctx.app.store.sqlite.prepare("SELECT snapshot_json FROM metadata_snapshots WHERE work_id = ? AND provider_id = 'bangumi'").get(target.workId) as { snapshot_json: string };
      expect(JSON.parse(snapshot.snapshot_json).fields.title).toBe("合成系列");
      // Keeping a field that was empty keeps it empty.
      const second = comic(ctx, "第二部漫画");
      ok(await run(ctx, "metadata.link", { workId: second.workId, providerId: "bangumi", externalId: "101", keepFields: ["author", "title", "nonexistent"].filter((key) => key !== "nonexistent") }));
      expect(await projected(ctx, second.workId, "author")).toMatchObject({ value: null, policy: "empty" });
    } finally { ctx.app.close(); }
  });

  it("asks again when the preview has gone stale, and again for a refresh", async () => {
    const ctx = await boot();
    try {
      const target = comic(ctx);
      ok(await run(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "101" }));
      // Nothing was previewed for this link-less call: it asked.
      expect(fake.requests.filter((item) => item.path === "/v0/subjects/101").length).toBe(1);
      fake.subjects.get(101)!.name_cn = "合成系列 新版";
      fake.subjects.get(101)!.infobox = [{ key: "作者", value: "A. Writer" }];
      const refresh = ok<Preview>(await run(ctx, "metadata.preview", { workId: target.workId }));
      expect(refresh.mode).toBe("refresh");
      expect(field(refresh, "title")).toMatchObject({ status: "differs", incoming: "合成系列 新版", current: { value: "合成系列", source: "online" } });
      // The source dropped the publisher: the work keeps what it has, and the preview says so instead of clearing it.
      expect(field(refresh, "studio")).toMatchObject({ status: "remote-missing", incoming: null, keepByDefault: true });
      expect(field(refresh, "author")).toMatchObject({ status: "same" });
      ok(await run(ctx, "metadata.refresh", { workId: target.workId }));
      expect(await projected(ctx, target.workId, "title")).toMatchObject({ value: "合成系列 新版", source: "online" });
      expect(await projected(ctx, target.workId, "studio")).toMatchObject({ value: null });
    } finally { ctx.app.close(); }
  });

  it("leaves a cover the user chose or locked alone, and keeps the current cover when asked", async () => {
    const ctx = await boot();
    try {
      const target = comic(ctx);
      const chosen = await picture(ctx, target.workId, "gold");
      const current = ok<{ coverId: string }>(await run(ctx, "covers.select", { workId: target.workId, coverId: chosen }));
      expect(current.coverId).toBe(chosen);
      const preview = ok<Preview>(await run(ctx, "metadata.preview", { workId: target.workId, externalId: "101" }));
      expect(preview.cover).toMatchObject({ state: "user", protected: true, willReplace: false });
      ok(await run(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "101" }));
      expect(ok<{ coverId: string; covers: unknown[] }>(await run(ctx, "covers.list", { workId: target.workId })).coverId).toBe(chosen);

      // An automatic cover that the user keeps in the preview stays; the source's picture is saved as another cover.
      const other = comic(ctx, "另一部漫画");
      const first = await picture(ctx, other.workId, "gold");
      ok(await run(ctx, "covers.select", { workId: other.workId, coverId: first }));
      ok(await run(ctx, "covers.lock", { workId: other.workId, locked: false }));
      ctx.app.store.sqlite.prepare("UPDATE works SET cover_state = 'auto' WHERE id = ?").run(other.workId);
      ctx.app.store.sqlite.prepare("UPDATE covers SET source = 'file' WHERE id = ?").run(first);
      const kept = ok<Preview>(await run(ctx, "metadata.preview", { workId: other.workId, externalId: "101" }));
      expect(kept.cover.willReplace).toBe(true);
      ok(await run(ctx, "metadata.link", { workId: other.workId, providerId: "bangumi", externalId: "101", keepCover: true }));
      const covers = ok<{ coverId: string; covers: Array<{ source: string }> }>(await run(ctx, "covers.list", { workId: other.workId }));
      expect(covers.coverId).toBe(first);
      expect(covers.covers.map((item) => item.source).sort()).toEqual(["bangumi", "file"]);
    } finally { ctx.app.close(); }
  });

  it("notes an entry that does not look like the work, and a missing entry, and carries on", async () => {
    const ctx = await boot();
    try {
      const target = comic(ctx);
      const preview = ok<Preview>(await run(ctx, "metadata.preview", { workId: target.workId, externalId: "201" }));
      expect(preview.kindMismatch).toMatchObject({ expected: "comic", actual: "video" });
      const missing = await run(ctx, "metadata.preview", { workId: target.workId, externalId: "999999" });
      expect(missing.status).toBe("error");
      expect(missing.error?.code).toBe("NOT_FOUND");
      const unlinked = await run(ctx, "metadata.preview", { workId: target.workId });
      expect(unlinked.error?.code).toBe("NOT_FOUND");
      // Linking a second entry says what it replaces.
      ok(await run(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "101" }));
      const replacing = ok<Preview>(await run(ctx, "metadata.preview", { workId: target.workId, externalId: "102" }));
      expect(replacing).toMatchObject({ mode: "link", replacesLink: "101" });
    } finally { ctx.app.close(); }
  });

  async function picture(ctx: App, workId: string, color: "gold"): Promise<string> {
    const { picture: make } = await import("../helpers/fake-bangumi.ts");
    const added = await ctx.app.covers.add(workId, { bytes: await make(color, [200, 300]), source: "user", select: "user" });
    return added.cover.id;
  }
});

describe("characters, voice actors and staff", () => {
  type Credits = { source: { providerId: string; externalId: string; detached: boolean } | null; characters: Array<{ id: string; name: string; relation: string; actors: Array<{ id: string; name: string }>; avatar: { url: string } | null }>; persons: Array<{ id: string; name: string; relation: string; career: string[]; episodes: string; avatar: { url: string } | null }>; avatarLimit: number };
  const credits = async (ctx: App, workId: string) => ok<Credits>(await run(ctx, "metadata.characters", { workId }));

  it("saves them with the link, with the small pictures only, and shows them from the saved rows", async () => {
    const ctx = await boot();
    try {
      fake.character(101, 1, { relation: "主角" });
      fake.character(101, 2, { relation: "配角", actors: [] });
      fake.character(101, 3, { images: null });
      fake.person(101, 11, { relation: "导演", career: ["mangaka", "writer"], eps: "ep1-3" });
      await fake.addAvatars();
      const target = comic(ctx);
      const linked = ok<{ credits: { characters: number; persons: number; avatars: { saved: number; failed: number; limit: number } }; warnings: string[] }>(await run(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "101" }));
      expect(linked.credits).toMatchObject({ characters: 3, persons: 1, avatars: { saved: 3, failed: 0, limit: MAX_AVATARS } });
      expect(linked.warnings).toEqual([]);
      // Only `grid` pictures are asked for; the larger sizes are never requested.
      const pictures = fake.requests.filter((item) => item.path.startsWith("/img/")).map((item) => item.path.split("/img/")[1]!);
      expect(pictures.filter((name) => /^(large|medium)-/.test(name))).toEqual([]);
      expect(pictures.filter((name) => name.startsWith("grid-")).sort()).toEqual(["grid-c1", "grid-c2", "grid-p11"]);

      const shown = await credits(ctx, target.workId);
      expect(shown.source).toMatchObject({ providerId: "bangumi", externalId: "101", detached: false });
      expect(shown.characters.map((item) => [item.id, item.name, item.relation])).toEqual([["1", "Synthetic Character 1", "主角"], ["2", "Synthetic Character 2", "配角"], ["3", "Synthetic Character 3", "主角"]]);
      expect(shown.characters[0]!.actors).toEqual([{ id: "5001", name: "Synthetic Actor 1" }]);
      expect(shown.characters[1]!.actors).toEqual([]);
      expect(shown.characters.map((item) => item.avatar !== null)).toEqual([true, true, false]);
      expect(shown.persons).toEqual([expect.objectContaining({ id: "11", name: "Synthetic Staff 11", relation: "导演", career: ["mangaka", "writer"], episodes: "ep1-3" })]);
      expect(shown.persons[0]!.avatar?.url).toMatch(/^manga-media:\/\//);
      // The page gets handles, never picture bytes or remote addresses.
      expect(JSON.stringify(shown)).not.toContain("/img/");
      // The synthetic pictures are identical, so the table keeps one row: pictures are stored by content.
      expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM images WHERE source_url LIKE '%/img/grid-%'").get()).toEqual({ n: 1 });
      expect(ctx.app.store.sqlite.prepare("SELECT COUNT(DISTINCT image_hash) AS n FROM subject_characters WHERE image_hash IS NOT NULL").get()).toEqual({ n: 1 });
    } finally { ctx.app.close(); }
  });

  it("takes at most twenty pictures per entry, characters first, and still saves every row", async () => {
    const ctx = await boot();
    try {
      for (let id = 1; id <= 30; id += 1) fake.character(101, id);
      for (let id = 1; id <= 5; id += 1) fake.person(101, 100 + id);
      await fake.addAvatars();
      const target = comic(ctx);
      const linked = ok<{ credits: { characters: number; persons: number; avatars: { saved: number } } }>(await run(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "101" }));
      expect(linked.credits).toMatchObject({ characters: 30, persons: 5, avatars: { saved: 20 } });
      expect(fake.requests.filter((item) => item.path.startsWith("/img/grid-")).length).toBe(20);
      const shown = await credits(ctx, target.workId);
      expect(shown.characters).toHaveLength(30);
      expect(shown.characters.filter((item) => item.avatar).length).toBe(20);
      expect(shown.persons.filter((item) => item.avatar).length).toBe(0);
      expect(shown.avatarLimit).toBe(20);
    } finally { ctx.app.close(); }
  });

  it("does not fail the link when pictures or lists cannot be fetched, and keeps what was saved before", async () => {
    const ctx = await boot();
    try {
      fake.character(101, 1);
      fake.character(101, 2);
      fake.person(101, 11);
      await fake.addAvatars();
      fake.images.delete("grid-c2");
      const target = comic(ctx);
      const linked = ok<{ credits: { characters: number; avatars: { saved: number; failed: number } }; warnings: string[] }>(await run(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "101" }));
      expect(linked.credits).toMatchObject({ characters: 2, persons: 1, avatars: { saved: 2, failed: 1 } });
      expect((await credits(ctx, target.workId)).characters.map((item) => item.avatar !== null)).toEqual([true, false]);

      // The next refresh cannot reach the lists: what is saved stays, and the warning says what is missing.
      fake.script((request) => isCredits(request), { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 }, { status: 503 });
      const refreshed = ok<{ refreshed: Array<{ credits: { characters: number; warnings: string[] }; warnings: string[] }>; stale: unknown[] }>(await run(ctx, "metadata.refresh", { workId: target.workId }));
      expect(refreshed.stale).toEqual([]);
      expect(refreshed.refreshed[0]!.credits.warnings.join(" ")).toMatch(/characters/);
      const kept = await credits(ctx, target.workId);
      expect(kept.characters).toHaveLength(2);
      expect(kept.persons).toHaveLength(1);

      // A source that sends an empty list replaces the rows with nothing: the list was fetched, and it is empty.
      fake.characters.set(101, []);
      fake.persons.set(101, []);
      ok(await run(ctx, "metadata.refresh", { workId: target.workId }));
      const emptied = await credits(ctx, target.workId);
      expect(emptied.characters).toEqual([]);
      expect(emptied.persons).toEqual([]);
    } finally { ctx.app.close(); }
  });

  it("reuses pictures it already has when it refreshes, and reads the rows of the linked entry after the link changes", async () => {
    const ctx = await boot();
    try {
      fake.character(101, 1);
      fake.character(102, 7);
      await fake.addAvatars();
      const target = comic(ctx);
      ok(await run(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "101" }));
      const first = fake.requests.filter((item) => item.path.startsWith("/img/grid-")).length;
      ok(await run(ctx, "metadata.refresh", { workId: target.workId }));
      expect(fake.requests.filter((item) => item.path.startsWith("/img/grid-")).length).toBe(first);
      ok(await run(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "102" }));
      expect((await credits(ctx, target.workId)).characters.map((item) => item.id)).toEqual(["7"]);
      // Unlinking keeps the saved rows and says the entry is detached.
      ok(await run(ctx, "metadata.unlink", { workId: target.workId, providerId: "bangumi" }));
      const detached = await credits(ctx, target.workId);
      expect(detached.source).toMatchObject({ externalId: "102", detached: true });
      expect(detached.characters.map((item) => item.id)).toEqual(["7"]);
      expect((await run(ctx, "metadata.characters", { workId: "work-none" })).error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  });

  it("does not keep picture bytes in the lists the page loads", async () => {
    const ctx = await boot();
    try {
      fake.character(101, 1);
      await fake.addAvatars();
      const target = comic(ctx);
      ok(await run(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "101" }));
      for (const [commandId, input] of [["works.get", { workId: target.workId }], ["works.list", {}], ["metadata.characters", { workId: target.workId }], ["covers.list", { workId: target.workId }]] as const) {
        const text = JSON.stringify(ok(await run(ctx, commandId, { ...input })));
        expect(text.length, commandId).toBeLessThan(60_000);
        expect(text, commandId).not.toMatch(/"payload"|"bytes":\s*\[/);
      }
    } finally { ctx.app.close(); }
  });
});
