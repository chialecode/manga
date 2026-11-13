import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MangaError } from "@manga/contracts";
import {
  BangumiClient,
  bangumiUserAgent,
  parseBangumiInfoboxNames,
} from "../../packages/app-core/src/metadata/bangumi.ts";
import {
  BANGUMI_DETAIL_REQUEST_BUDGET,
  MAX_HOTWORDS,
  cleanHotwordForSherpa,
} from "../../packages/app-core/src/voice/dictionary.ts";
import { startApp } from "../helpers/app.ts";
import { startFakeBangumi, type FakeBangumi } from "../helpers/fake-bangumi.ts";
import { seedComic } from "../helpers/media-seed.ts";
import { EnergyVad, FakeAsr, FakeLlm } from "../helpers/voice.ts";

describe("Bangumi infobox parsing, detail enrichment, batch import and hotword ranking (X1)", () => {
  type App = Awaited<ReturnType<typeof startApp>>;
  let fake: FakeBangumi;
  const apps: App[] = [];
  let seq = 0;

  beforeAll(async () => {
    fake = await startFakeBangumi();
  });

  afterAll(async () => {
    await fake.stop();
  });

  afterEach(() => {
    while (apps.length) apps.pop()!.app.close();
  });

  async function boot() {
    fake.reset();
    await fake.addImage("cover.png", "blue");
    const ctx = await startApp({
      options: {
        vad: new EnergyVad(),
        asr: new FakeAsr(),
        llm: new FakeLlm(),
        voiceRetryBaseMs: 0,
        bangumi: fake.clientOptions,
      },
    });
    apps.push(ctx);
    return ctx;
  }

  function makeClient(over: Partial<ConstructorParameters<typeof BangumiClient>[0]> = {}) {
    return new BangumiClient({
      fetch: globalThis.fetch,
      userAgent: bangumiUserAgent("0.1.0-test"),
      ...fake.clientOptions,
      ...over,
    });
  }

  async function callCmd(ctx: App, commandId: string, input: Record<string, unknown>) {
    seq += 1;
    const res = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: `x1-${seq}`, input }, ctx.grant.handle);
    expect(res.status, JSON.stringify(res)).toBe("ok");
    return res.value as Record<string, unknown>;
  }

  it("handles null infobox, duplicate 简体中文名 / 别名 keys, and keyless { v } items", () => {
    expect(parseBangumiInfoboxNames("桐谷レン", null)).toEqual({
      term: "桐谷レン",
      aliases: [],
    });

    const parsed = parseBangumiInfoboxNames("神代はるか", [
      { key: "简体中文名", value: "神代遥香" },
      { key: "简体中文名", value: "神代遥" },
      {
        key: "别名",
        value: [
          { v: "小遥" },
          { k: null, v: "遥酱" },
          { k: "纯假名", v: "かみしろ はるか" },
          { k: "罗马字", v: "Kamishiro Haruka" },
        ],
      },
      {
        key: "别名",
        value: [
          { k: "英文名", v: "Haruka Kamishiro" },
          { k: "昵称", v: "星海魔女" },
        ],
      },
    ]);

    expect(parsed.term).toBe("神代遥香");
    expect(parsed.aliases).toEqual([
      { alias: "神代はるか", kind: "alias" },
      { alias: "神代遥", kind: "alias" },
      { alias: "小遥", kind: "alias" },
      { alias: "遥酱", kind: "alias" },
      { alias: "かみしろ はるか", kind: "kana" },
      { alias: "Kamishiro Haruka", kind: "romaji" },
      { alias: "Haruka Kamishiro", kind: "english" },
      { alias: "星海魔女", kind: "alias" },
    ]);
  });

  it("enriches main -> supporting -> actors sequentially, caches details, demotes Japanese name to alias, and preserves manual terms", async () => {
    const ctx = await boot();
    fake.subject(201, {
      type: 2,
      name: "Hoshizora Kiko",
      name_cn: "星空纪行",
      imageName: "cover.png",
      infobox: [{ key: "别名", value: [{ v: "星纪" }] }],
    });
    // Position 0 is supporting, Position 1 is main: enrich must still query main character BEFORE supporting character, then actors!
    fake.character(201, 12, {
      name: "霧島アオイ",
      relation: "配角",
      actors: [{ id: 6012, name: "早見あかり", images: null }],
    });
    fake.character(201, 11, {
      name: "神代はるか",
      relation: "主角",
      actors: [{ id: 6011, name: "水瀬いのりん", images: null }],
    });
    fake.character(201, 13, {
      name: "橘カイ",
      relation: "客串",
      actors: [],
    });
    await fake.addAvatars();

    fake.characterDetail(11, {
      name: "神代はるか",
      infobox: [
        { key: "简体中文名", value: "神代遥香" },
        { key: "别名", value: [{ k: "纯假名", v: "かみしろ はるか" }, { v: "小遥" }] },
      ],
    });
    fake.characterDetail(12, {
      name: "霧島アオイ",
      infobox: [
        { key: "简体中文名", value: "雾岛葵" },
        { key: "简体中文名", value: "雾岛青衣" },
        { key: "别名", value: [{ k: "罗马字", v: "Kirishima Aoi" }] },
      ],
    });
    // Character 13 has `infobox: null` -> falls back to top-level `name` ("橘カイ").
    fake.characterDetail(13, { name: "橘カイ", infobox: null });
    fake.personDetail(6011, {
      name: "水瀬いのりん",
      infobox: [{ key: "简体中文名", value: "水濑祈音" }],
    });
    fake.personDetail(6012, {
      name: "早見あかり",
      infobox: [{ key: "简体中文名", value: "早见明里" }],
    });

    const target = seedComic(ctx.app, { title: "星空纪行本地卷", pageCount: 2 });
    await callCmd(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "201" });

    // Pre-add a manual term with custom heard alias for "雾岛葵" — automatic enrich must NOT overwrite it.
    ctx.app.voice.dictionary.add({
      scope: "work",
      workId: target.workId,
      term: "雾岛葵",
      heard: "务岛葵",
      category: "character",
    });

    // Track concurrency on the server side to guarantee sequential 1-by-1 execution.
    let inFlight = 0;
    let maxInFlight = 0;
    const detailPaths: string[] = [];
    const client = makeClient({
      fetch: async (url, init) => {
        const pathname = new URL(url).pathname;
        if (pathname.startsWith("/v0/characters/") || pathname.startsWith("/v0/persons/")) {
          inFlight += 1;
          if (inFlight > maxInFlight) maxInFlight = inFlight;
          detailPaths.push(pathname);
        }
        try {
          return await globalThis.fetch(url, init);
        } finally {
          if (pathname.startsWith("/v0/characters/") || pathname.startsWith("/v0/persons/")) {
            inFlight -= 1;
          }
        }
      },
    });

    const progressUpdates: number[] = [];
    const result = await ctx.app.voice.dictionary.enrichFromBangumi({
      workId: target.workId,
      client,
      onProgress: (p) => progressUpdates.push(p.completed),
    });

    expect(maxInFlight).toBe(1);
    expect(detailPaths).toEqual([
      "/v0/characters/11", // 主角 first
      "/v0/characters/12", // 配角 second
      "/v0/characters/13", // 客串 third
      "/v0/persons/6011", // 主角's actor fourth
      "/v0/persons/6012", // 配角's actor fifth
    ]);
    expect(result).toMatchObject({
      linked: true,
      requestsSent: 5,
      cachedHits: 0,
      budgetReached: false,
      totalTargets: 5,
      manualWins: 1,
    });
    expect(progressUpdates).toEqual([1, 2, 3, 4, 5]);

    const listed = ctx.app.voice.dictionary.list({ scope: "work", workId: target.workId }).terms;
    const byTerm = new Map(listed.map((t) => [t.term, t]));

    // "神代遥香" became canonical term; Japanese "神代はるか" was demoted to alias alongside kana & keyless alias!
    const haruka = byTerm.get("神代遥香")!;
    expect(haruka).toBeDefined();
    expect(haruka.category).toBe("character");
    expect(haruka.auto).toBe(true);
    expect(haruka.aliases.map((a) => ({ alias: a.alias, kind: a.kind }))).toEqual([
      { alias: "神代はるか", kind: "alias" },
      { alias: "かみしろ はるか", kind: "kana" },
      { alias: "小遥", kind: "alias" },
    ]);
    expect(byTerm.has("神代はるか")).toBe(false);

    // Manual "雾岛葵" won and kept its manual heard alias!
    const aoi = byTerm.get("雾岛葵")!;
    expect(aoi).toMatchObject({ auto: false, source: "manual", heard: "务岛葵" });

    // Null-infobox character fell back to top-level name.
    expect(byTerm.get("橘カイ")).toMatchObject({ category: "character", auto: true });
    expect(byTerm.get("水濑祈音")?.aliases.map((a) => a.alias)).toContain("水瀬いのりん");

    // Second enrich without refresh hits `bangumi_details` cache with 0 network requests!
    detailPaths.length = 0;
    const cachedResult = await ctx.app.voice.dictionary.enrichFromBangumi({ workId: target.workId, client });
    expect(detailPaths).toHaveLength(0);
    expect(cachedResult).toMatchObject({ requestsSent: 0, cachedHits: 5, budgetReached: false });

    // Explicit `refresh: true` re-fetches from Bangumi and updates cache.
    fake.characterDetail(13, {
      name: "橘カイ",
      infobox: [{ key: "简体中文名", value: "橘凯" }],
    });
    const refreshed = await ctx.app.voice.dictionary.enrichFromBangumi({
      workId: target.workId,
      client,
      refresh: true,
    });
    expect(refreshed.requestsSent).toBe(5);
    expect(ctx.app.voice.dictionary.list({ scope: "work", workId: target.workId }).terms.some((t) => t.term === "橘凯")).toBe(
      true,
    );
  });

  it("strictly caps detail requests at 60 per work and supports mid-flight cancellation, 403 and 429 handling", async () => {
    const ctx = await boot();
    fake.subject(202, {
      type: 2,
      name: "Large Cast Chronicle",
      name_cn: "群星编年史",
      imageName: "cover.png",
    });
    // 45 characters, each with a distinct actor = 90 detail targets (> 60 cap).
    for (let i = 1; i <= 45; i += 1) {
      fake.character(202, 1000 + i, {
        name: `角色原名${i}`,
        relation: i <= 5 ? "主角" : "配角",
        actors: [{ id: 8000 + i, name: `声优原名${i}`, images: null }],
      });
    }
    await fake.addAvatars();

    const target = seedComic(ctx.app, { title: "群星编年史卷一", pageCount: 2 });
    await callCmd(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "202" });

    const beforeCount = fake.count((r) => r.path.startsWith("/v0/characters/") || r.path.startsWith("/v0/persons/"));
    const client = makeClient();
    const capped = await ctx.app.voice.dictionary.enrichFromBangumi({ workId: target.workId, client });
    const afterCount = fake.count((r) => r.path.startsWith("/v0/characters/") || r.path.startsWith("/v0/persons/"));

    expect(capped.totalTargets).toBe(90);
    expect(capped.budgetReached).toBe(true);
    expect(capped.requestsSent).toBe(BANGUMI_DETAIL_REQUEST_BUDGET);
    expect(afterCount - beforeCount).toBe(60);

    // Mid-flight cancellation via `cancelEnrich(workId)`.
    fake.script(
      (r) => r.path === "/v0/characters/1002",
      { status: 200, delayMs: 80, headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1002, name: "角色原名2", infobox: null }) },
    );
    const cancelPromise = ctx.app.voice.dictionary.enrichFromBangumi({
      workId: target.workId,
      client,
      refresh: true,
      onProgress: (p) => {
        if (p.completed === 1) {
          expect(ctx.app.voice.dictionary.cancelEnrich(target.workId)).toBe(true);
        }
      },
    });
    await expect(cancelPromise).rejects.toMatchObject({ code: "CANCELLED" });

    // 403 AUTHENTICATION_FAILED surfaces cleanly.
    fake.script((r) => r.path === "/v0/characters/1001", { status: 403 });
    await expect(
      ctx.app.voice.dictionary.enrichFromBangumi({ workId: target.workId, client, refresh: true }),
    ).rejects.toBeInstanceOf(MangaError);

    // 429 RATE_LIMITED surfaces cleanly when retries are exhausted.
    const noRetryClient = makeClient({ maxRetries: 0 });
    fake.script((r) => r.path === "/v0/characters/1001", { status: 429, headers: { "retry-after": "1" } });
    await expect(
      ctx.app.voice.dictionary.enrichFromBangumi({ workId: target.workId, client: noRetryClient, refresh: true }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("supports batch import, hotword ordering/sanitization/cap, disabled toggle, and incremental phonetic index updates", async () => {
    const ctx = await boot();
    fake.subject(203, {
      type: 2,
      name: "Hotword Order Saga",
      name_cn: "热词物语",
      imageName: "cover.png",
    });
    fake.character(203, 301, {
      name: "雾原莲",
      relation: "配角",
      actors: [{ id: 9301, name: "竹达彩奈绪", images: null }],
    });
    fake.character(203, 302, {
      name: "星野美咲",
      relation: "主角",
      actors: [],
    });
    await fake.addAvatars();

    const target = seedComic(ctx.app, { title: "热词物语一卷", pageCount: 2 });
    await callCmd(ctx, "metadata.link", { workId: target.workId, providerId: "bangumi", externalId: "203" });
    ctx.app.voice.dictionary.syncFromMetadata(target.workId);

    // Batch import with newline, comma, `、`, `词条 | 别名1, 别名2`, blank lines and duplicates.
    const batch = ctx.app.voice.dictionary.importBatch({
      scope: "work",
      workId: target.workId,
      text: [
        "苍穹骑士团 | 苍骑, 蓝天骑士团、AozoraOrder",
        "",
        "白银圣殿, 绯红之塔、白银圣殿",
        "   ",
        "星野美咲", // already exists from metadata -> skipped!
      ].join("\n"),
    });
    expect(batch.added).toBe(3);
    expect(batch.skipped).toBe(2); // second "白银圣殿" + existing "星野美咲"
    expect(batch.terms.find((t) => t.term === "苍穹骑士团")?.aliases.map((a) => a.alias)).toEqual([
      "苍骑",
      "蓝天骑士团",
      "AozoraOrder",
    ]);

    // Global manual term + colon-bearing term to verify sherpa-onnx sanitization.
    ctx.app.voice.dictionary.add({ scope: "global", term: "全局手写词:2.5" });
    expect(cleanHotwordForSherpa("全局手写词:2.5")).toBe("全局手写词");
    expect(cleanHotwordForSherpa("Re:星海幻想")).toBe("Re 星海幻想");

    // Disable "白银圣殿" and verify it disappears from hotwords, prompt, glossary, and phonetic correction!
    const silver = batch.terms.find((t) => t.term === "白银圣殿")!;
    ctx.app.voice.dictionary.update({ termId: silver.id, disabled: true });

    const hotwords = ctx.app.voice.dictionary.hotwordsFor(target.workId);
    expect(hotwords).not.toContain("白银圣殿");
    // Order: work manual ("苍穹骑士团", "绯红之塔") -> global manual ("全局手写词") -> main character ("星野美咲") -> supporting character ("雾原莲") -> actor ("竹达彩奈绪") -> work ("热词物语", "Hotword Order Saga")
    const idxOrder = [
      "苍穹骑士团",
      "绯红之塔",
      "全局手写词",
      "星野美咲",
      "雾原莲",
      "竹达彩奈绪",
      "热词物语",
    ].map((name) => hotwords.indexOf(name));
    expect(idxOrder.every((idx) => idx >= 0)).toBe(true);
    for (let i = 1; i < idxOrder.length; i += 1) {
      expect(idxOrder[i]!).toBeGreaterThan(idxOrder[i - 1]!);
    }

    // When `workId === null`, only global terms are returned.
    expect(ctx.app.voice.dictionary.hotwordsFor(null)).toEqual(["全局手写词"]);

    // Cap at MAX_HOTWORDS (50).
    const manyNames = Array.from({ length: 65 }, (_, idx) => `虚构专名${idx + 1}`).join(", ");
    ctx.app.voice.dictionary.importBatch({ scope: "global", text: manyNames });
    expect(ctx.app.voice.dictionary.hotwordsFor(target.workId)).toHaveLength(MAX_HOTWORDS);

    // In-memory phonetics & incremental corrector updates (`add`, `blocked`, `remove`).
    expect(ctx.app.voice.dictionary.phoneticsOf("星野美咲").phonemes.length).toBeGreaterThan(6);
    const addedHero = ctx.app.voice.dictionary.add({
      scope: "work",
      workId: target.workId,
      term: "神代遥香",
      aliases: [{ alias: "かみしろはるか", kind: "kana" }],
      blocked: ["神代瑶香"],
    });
    expect(ctx.app.voice.dictionary.correct("这里登场的是陈代遥香", target.workId).correctedText).toBe(
      "这里登场的是神代遥香",
    );
    expect(ctx.app.voice.dictionary.correct("这里登场的是新代遥香", target.workId).candidates.map((c) => c.term)).toContain(
      "神代遥香",
    );
    // Blocked surface form is NOT replaced and NOT recalled.
    const blockedRes = ctx.app.voice.dictionary.correct("这里登场的是神代瑶香", target.workId);
    expect(blockedRes.correctedText).toBe("这里登场的是神代瑶香");
    expect(blockedRes.candidates).toHaveLength(0);
    // Removing the term incrementally updates the corrector immediately.
    ctx.app.voice.dictionary.remove(addedHero.id);
    expect(ctx.app.voice.dictionary.correct("这里登场的是陈代遥香", target.workId).correctedText).toBe(
      "这里登场的是陈代遥香",
    );
  });
});
