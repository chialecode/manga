import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CACHE_TTL, cacheTtlMs, type DandanCredentials } from "@manga/app-core";
import { DEFAULT_DANMAKU_SETTINGS, type DanmakuItem, type DanmakuMatchInfo, type DanmakuSettings } from "@manga/contracts";
import { startApp } from "../helpers/app.ts";
import { FAKE_CREDENTIALS, FakeDandan, OTHER_CREDENTIALS } from "../helpers/fake-dandan.ts";
import { seedVideo } from "../helpers/media-seed.ts";

type Rig = Awaited<ReturnType<typeof rig>>;
const rigs: Rig[] = [];
const folders: string[] = [];
let counter = 0;

async function rig(options: { credentials?: DandanCredentials | null } = {}) {
  const server = await new FakeDandan().start();
  const clock = { t: Date.parse("2026-10-09T08:00:00Z") };
  const credentials = "credentials" in options ? options.credentials : FAKE_CREDENTIALS;
  const ctx = await startApp({ options: { danmaku: { credentials, origin: server.origin, client: { allowHttp: true, now: () => clock.t }, now: () => clock.t } } });
  const result = { ...ctx, server, clock };
  rigs.push(result);
  return result;
}
afterEach(async () => {
  for (const item of rigs.splice(0)) { item.app.close(); await item.server.stop(); }
  for (const dir of folders.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function call(ctx: Rig, commandId: string, input: Record<string, unknown>, as?: { grant: string; actor: { kind: "user" | "agent"; id: string } }) {
  counter += 1;
  return ctx.app.call(as?.actor ?? ctx.actor, { commandId, idempotencyKey: `dm-${counter}`, input }, as?.grant ?? ctx.grant.handle);
}
async function ok<T = Record<string, any>>(ctx: Rig, commandId: string, input: Record<string, unknown> = {}): Promise<T> {
  const result = await call(ctx, commandId, input);
  expect(result.status, `${commandId}: ${JSON.stringify(result)}`).toBe("ok");
  return result.value as T;
}

/** A video whose file has known content, so the fingerprint the service sends can be checked. */
function video(ctx: Rig, name: string, options: { ordinal?: number; workId?: string; bytes?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-danmaku-"));
  folders.push(dir);
  const file = path.join(dir, `${name}.mkv`);
  const content = Buffer.alloc(options.bytes ?? 4096, name.length + 7);
  fs.writeFileSync(file, content);
  const seeded = seedVideo(ctx.app, { title: name, durationMs: 1_420_000, file, ...(options.ordinal !== undefined ? { ordinal: { number: options.ordinal, type: "episode", label: `第 ${options.ordinal} 话` } } : {}), ...(options.workId ? { workId: options.workId } : {}) });
  return { ...seeded, file, content };
}

/** Link a work to a Bangumi entry the way a confirmed link is stored, with the episode dates the cache lifetime reads. */
function link(ctx: Rig, workId: string, subjectId: number, snapshot: Record<string, unknown> = {}) {
  ctx.app.store.sqlite.prepare("INSERT INTO work_links(work_id, provider_id, external_id, snapshot_json, confirmed_at, namespace, subject_type, link_state, match_basis) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(workId, "bangumi", String(subjectId), JSON.stringify({ version: 1, fields: {}, episodes: [], ...snapshot }), new Date().toISOString(), "bangumi:subject", 2, "linked", "manual");
}

type Match = { state: string; match?: DanmakuMatchInfo; candidates?: Array<{ episodeId: number; animeTitle: string; episodeTitle: string }>; reason?: string; suggestedQuery?: string; episodeNumber?: number | null };
type Loaded = { state: string; items: DanmakuItem[]; count: number; fetchedAt: string; expiresAt: string; fromCache: boolean; stale: boolean; warning: { code: string; message: string; retryAfterMs?: number } | null; match: DanmakuMatchInfo; attribution: string };

describe("without credentials danmaku says why and sends nothing (AT-94)", () => {
  it("reports no credentials for status, match, load and search, and never reaches the network", async () => {
    const ctx = await rig({ credentials: null });
    const v = video(ctx, "样例动画 第02话", { ordinal: 2 });
    const status = await ok<{ credentials: string; attribution: string; match: unknown }>(ctx, "danmaku.status", { resourceId: v.resourceId });
    expect(status).toMatchObject({ credentials: "none", match: null, attribution: "弹幕来自弹弹play开放弹幕网络" });
    expect((await ok<Match>(ctx, "danmaku.match", { resourceId: v.resourceId })).state).toBe("no_credentials");
    expect((await ok<{ state: string }>(ctx, "danmaku.load", { resourceId: v.resourceId })).state).toBe("no_match");
    const search = await call(ctx, "danmaku.search", { query: "样例" });
    expect(search.error).toMatchObject({ code: "CREDENTIAL_UNAVAILABLE" });
    expect(ctx.server.requests).toHaveLength(0);
  });

  it("uses the credentials built into the release, lets the person's own replace them, and goes back to the built-in ones when they are cleared", async () => {
    const ctx = await rig();
    const v = video(ctx, "样例动画 第02话", { ordinal: 2 });
    link(ctx, v.workId, 100);
    expect((await ok<{ credentials: string }>(ctx, "danmaku.getSettings")).credentials).toBe("built-in");
    await ok(ctx, "danmaku.match", { resourceId: v.resourceId });
    expect(ctx.server.requests.at(-1)!.headers["x-appid"]).toBe(FAKE_CREDENTIALS.appId);

    // The service now only accepts the other pair: the built-in one is refused with the service's own reason, and nothing was retried.
    ctx.server.accepts = OTHER_CREDENTIALS;
    const refused = await call(ctx, "danmaku.load", { resourceId: v.resourceId });
    expect(refused.error).toMatchObject({ code: "AUTHENTICATION_FAILED", message: "Invalid AppId" });
    const before = ctx.server.requests.length;

    const handle = ctx.app.stashSecret(JSON.stringify(OTHER_CREDENTIALS));
    expect((await ok<{ credentials: string }>(ctx, "danmaku.setCredentials", { credentialHandle: handle })).credentials).toBe("custom");
    expect((await ok<Loaded>(ctx, "danmaku.load", { resourceId: v.resourceId })).count).toBe(7);
    expect(ctx.server.requests.length).toBe(before + 1);
    expect(ctx.server.requests.at(-1)!.headers["x-appid"]).toBe(OTHER_CREDENTIALS.appId);
    expect(ctx.server.requests.at(-1)!.signed).toBe(true);

    expect((await ok<{ credentials: string }>(ctx, "danmaku.setCredentials", { clear: true })).credentials).toBe("built-in");
    // The old pair is no longer in the vault table.
    expect((ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM credentials").get() as { n: number }).n).toBe(0);
  });

  it("refuses credentials of the wrong shape without echoing them, and a handle that was never issued", async () => {
    const ctx = await rig({ credentials: null });
    const bad = ctx.app.stashSecret(JSON.stringify({ appId: "has space", secret: "s3cr3t-value-to-hide" }));
    const refused = await call(ctx, "danmaku.setCredentials", { credentialHandle: bad });
    expect(refused.error?.code).toBe("VALIDATION_ERROR");
    expect(JSON.stringify(refused)).not.toContain("s3cr3t-value-to-hide");
    expect((await call(ctx, "danmaku.setCredentials", { credentialHandle: "sec_nothing" })).error?.code).toBe("FORBIDDEN");
    const notJson = ctx.app.stashSecret("just-text");
    expect((await call(ctx, "danmaku.setCredentials", { credentialHandle: notJson })).error?.code).toBe("VALIDATION_ERROR");
    expect((await ok<{ credentials: string }>(ctx, "danmaku.getSettings")).credentials).toBe("none");
  });
});

describe("finding the episode of a file (AT-94)", () => {
  it("maps a work linked to a Bangumi entry through the entry and picks the episode by its number, sending nothing about the file", async () => {
    const ctx = await rig();
    const v = video(ctx, "样例动画 第02话", { ordinal: 2 });
    link(ctx, v.workId, 100);
    const matched = await ok<Match>(ctx, "danmaku.match", { resourceId: v.resourceId });
    expect(matched).toMatchObject({ state: "matched", match: { episodeId: 900102, animeId: 9001, animeTitle: "样例动画", episodeTitle: "第2话", method: "bangumi", confirmed: false, offsetMs: 0 } });
    expect(ctx.server.requests.map((request) => `${request.method} ${request.path}`)).toEqual(["GET /api/v2/bangumi/bgmtv/100"]);
    // The match is kept for the revision: asking again does not ask the network again.
    expect((await ok<Match>(ctx, "danmaku.match", { resourceId: v.resourceId })).match).toEqual(matched.match);
    expect(ctx.server.requests).toHaveLength(1);
    const status = await ok<{ match: DanmakuMatchInfo; linked: boolean; consent: string; episodeNumber: number }>(ctx, "danmaku.status", { resourceId: v.resourceId });
    expect(status).toMatchObject({ linked: true, consent: "unasked", episodeNumber: 2, match: { episodeId: 900102 } });
  });

  it("asks once per work before it sends a file's details, and matches by name and fingerprint after a yes", async () => {
    const ctx = await rig();
    const v = video(ctx, "样例动画 第03话", { ordinal: 3, bytes: 20 * 1024 * 1024 });
    const first = await ok<Match>(ctx, "danmaku.match", { resourceId: v.resourceId });
    expect(first.state).toBe("needs_consent");
    expect(ctx.server.requests).toHaveLength(0);

    const matched = await ok<Match>(ctx, "danmaku.match", { resourceId: v.resourceId, consent: true });
    expect(matched).toMatchObject({ state: "matched", match: { episodeId: 900103, method: "hash", confirmed: false } });
    const sent = ctx.server.requests.filter((request) => request.path === "/api/v2/match");
    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    // The name without the extension, the MD5 of the first 16 MiB, the size and the length in seconds: nothing else, in particular no path.
    expect(body).toEqual({ fileName: "样例动画 第03话", fileHash: createHash("md5").update(v.content.subarray(0, 16 * 1024 * 1024)).digest("hex"), fileSize: 20 * 1024 * 1024, videoDuration: 1420, matchMode: "hashAndFileName" });
    expect(sent[0]!.body).not.toContain(path.dirname(v.file).replace(/\\/g, "\\\\"));
    // The answer was remembered for the work: a second file of it is not asked about again.
    const status = await ok<{ consent: string }>(ctx, "danmaku.status", { resourceId: v.resourceId });
    expect(status.consent).toBe("allowed");
  });

  it("does not send the file when the person says no, and lets them search for the episode and choose it", async () => {
    const ctx = await rig();
    const v = video(ctx, "一个不在服务里的文件 01", { ordinal: 1 });
    const denied = await ok<Match>(ctx, "danmaku.match", { resourceId: v.resourceId, consent: false });
    expect(denied).toMatchObject({ state: "needs_choice", reason: "denied", candidates: [], episodeNumber: 1 });
    expect(ctx.server.requests).toHaveLength(0);
    expect((await ok<{ consent: string }>(ctx, "danmaku.status", { resourceId: v.resourceId })).consent).toBe("denied");

    const found = await ok<{ candidates: Array<{ episodeId: number; animeTitle: string; episodeTitle: string; typeDescription?: string }>; hasMore: boolean }>(ctx, "danmaku.search", { query: "样例动画", episode: 1 });
    expect(ctx.server.requests.map((request) => request.path)).toEqual(["/api/v2/search/episodes"]);
    expect(ctx.server.requests[0]!.query.get("anime")).toBe("样例动画");
    expect(ctx.server.requests[0]!.query.get("episode")).toBe("1");
    expect(found.candidates.length).toBeGreaterThan(0);
    const pick = found.candidates[0]!;
    const chosen = await ok<{ match: DanmakuMatchInfo }>(ctx, "danmaku.choose", { resourceId: v.resourceId, episodeId: pick.episodeId, animeId: 9001, animeTitle: pick.animeTitle, episodeTitle: pick.episodeTitle });
    expect(chosen.match).toMatchObject({ episodeId: pick.episodeId, method: "manual", confirmed: true });
    // The search was typed by the person: nothing about the file went with it.
    expect(ctx.server.requests).toHaveLength(1);
  });

  it("lists the candidates when the match is not certain, and lets the person correct a match that was wrong", async () => {
    const ctx = await rig();
    const v = video(ctx, "模糊 05", { ordinal: 5 });
    const uncertain = await ok<Match>(ctx, "danmaku.match", { resourceId: v.resourceId, consent: true });
    expect(uncertain).toMatchObject({ state: "needs_choice", reason: "uncertain", suggestedQuery: "模糊" });
    expect(uncertain.candidates?.map((item) => item.episodeId)).toEqual([800105, 810105]);
    // Nothing is saved until the person picks.
    expect((await ok<{ match: unknown }>(ctx, "danmaku.status", { resourceId: v.resourceId })).match).toBeNull();
    await ok(ctx, "danmaku.choose", { resourceId: v.resourceId, episodeId: 800105, animeId: 8001, animeTitle: "模糊动画", episodeTitle: "第5话" });
    // A wrong pick is changed by choosing again; the saved row is one per revision.
    const again = await ok<{ match: DanmakuMatchInfo }>(ctx, "danmaku.choose", { resourceId: v.resourceId, episodeId: 810105, animeId: 8101, animeTitle: "模糊动画 第二季", episodeTitle: "第5话" });
    expect(again.match.episodeId).toBe(810105);
    expect((ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM danmaku_matches").get() as { n: number }).n).toBe(1);
    // Re-matching on request looks again even though one is saved.
    const refreshed = await ok<Match>(ctx, "danmaku.match", { resourceId: v.resourceId, refresh: true });
    expect(refreshed.state).toBe("needs_choice");
    const matchCalls = ctx.server.requests.filter((request) => request.path === "/api/v2/match");
    expect(matchCalls).toHaveLength(2);
  });

  it("asks for a choice when a file has no match at all, with the title it would search for", async () => {
    const ctx = await rig();
    const v = video(ctx, "完全没有的名字", { ordinal: 9 });
    const none = await ok<Match>(ctx, "danmaku.match", { resourceId: v.resourceId, consent: true });
    expect(none).toMatchObject({ state: "needs_choice", reason: "none", candidates: [], episodeNumber: 9 });
  });
});

describe("requests are for the episode being watched and are kept for a while (AT-94)", () => {
  it("fetches one episode, parses it, and serves the next opening from the cache", async () => {
    const ctx = await rig();
    const v = video(ctx, "样例动画 第02话", { ordinal: 2 });
    link(ctx, v.workId, 100);
    await ok(ctx, "danmaku.match", { resourceId: v.resourceId });
    const loaded = await ok<Loaded>(ctx, "danmaku.load", { resourceId: v.resourceId });
    expect(loaded).toMatchObject({ state: "ok", count: 7, fromCache: false, stale: false, warning: null, attribution: "弹幕来自弹弹play开放弹幕网络" });
    expect(loaded.items.map((item) => [item.at, item.mode, item.color, item.source, item.text])).toEqual([
      [1500, "scroll", 0xffffff, "", "前方高能"],
      [3000, "scroll", 0xff0000, "BiliBili", "哈哈哈"],
      [3200, "scroll", 0xff0000, "BiliBili", "哈哈哈"],
      [5000, "top", 0x0000ff, "", "顶部的一条"],
      [8000, "bottom", 0x00ff00, "", "底部的一条"],
      [12_500, "scroll", 0xffffff, "Gamer", "後面才會看到"],
      [30_000, "scroll", 0xffffff, "", "很后面的剧透"],
    ]);
    // Only the comments of this episode were asked for, once, with the person's conversion setting; no related or third-party calls.
    expect(ctx.server.requests.filter((request) => request.path.startsWith("/api/v2/comment/")).map((request) => request.path)).toEqual(["/api/v2/comment/900102"]);
    expect(ctx.server.requests.every((request) => !/related|extcomment/.test(request.path))).toBe(true);
    expect(ctx.server.requests.find((request) => request.path.startsWith("/api/v2/comment/"))!.query.get("chConvert")).toBe("1");

    const second = await ok<Loaded>(ctx, "danmaku.load", { resourceId: v.resourceId });
    expect(second).toMatchObject({ fromCache: true, stale: false, count: 7, fetchedAt: loaded.fetchedAt });
    expect(second.items).toEqual(loaded.items);
    expect(ctx.server.requests.filter((request) => request.path.startsWith("/api/v2/comment/"))).toHaveLength(1);
    // The cache row is compressed text, not a pile of rows.
    const row = ctx.app.store.sqlite.prepare("SELECT source, episode_id AS episodeId, count, length(payload) AS bytes FROM danmaku_cache").get() as { source: string; episodeId: number; count: number; bytes: number };
    expect(row).toMatchObject({ source: "dandanplay:1", episodeId: 900102, count: 7 });
  });

  it("loads nothing for a revision with no match, and opening one episode does not touch the others of the show", async () => {
    const ctx = await rig();
    const v = video(ctx, "样例动画 第02话", { ordinal: 2 });
    link(ctx, v.workId, 100);
    expect((await ok<{ state: string }>(ctx, "danmaku.load", { resourceId: v.resourceId })).state).toBe("no_match");
    expect(ctx.server.requests).toHaveLength(0);
    await ok(ctx, "danmaku.match", { resourceId: v.resourceId });
    await ok(ctx, "danmaku.load", { resourceId: v.resourceId });
    expect(ctx.server.hits(/\/api\/v2\/comment\//).map((request) => request.path)).toEqual(["/api/v2/comment/900102"]);
  });

  it("keeps an episode for an hour while it is airing, six hours otherwise, and three days once it is a year old", async () => {
    // The rule on its own, at the edges.
    const now = Date.parse("2026-10-09T08:00:00Z");
    const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString().slice(0, 10);
    expect(cacheTtlMs(daysAgo(10), now)).toBe(CACHE_TTL.airingMs);
    expect(cacheTtlMs("2026-11-01", now)).toBe(CACHE_TTL.airingMs);
    expect(cacheTtlMs(daysAgo(200), now)).toBe(CACHE_TTL.ordinaryMs);
    expect(cacheTtlMs(daysAgo(400), now)).toBe(CACHE_TTL.finishedMs);
    expect(cacheTtlMs(null, now)).toBe(CACHE_TTL.ordinaryMs);
    expect(cacheTtlMs("not a date", now)).toBe(CACHE_TTL.ordinaryMs);
    expect([CACHE_TTL.airingMs, CACHE_TTL.ordinaryMs, CACHE_TTL.finishedMs]).toEqual([3_600_000, 21_600_000, 259_200_000]);

    // And through the service: the episode's own air date decides, the entry's release date is the fallback.
    const ctx = await rig();
    const airing = video(ctx, "连载中 02", { ordinal: 2 });
    link(ctx, airing.workId, 100, { episodes: [{ ep: 2, sort: 2, type: 0, title: "", airdate: daysAgo(3) }], fields: { releaseDate: daysAgo(900) } });
    const old = video(ctx, "完结很久 02", { ordinal: 2 });
    link(ctx, old.workId, 100, { fields: { releaseDate: daysAgo(900) } });
    const middle = video(ctx, "不新不旧 02", { ordinal: 2 });
    link(ctx, middle.workId, 100, { fields: { releaseDate: daysAgo(200) } });
    const lifetimes: number[] = [];
    for (const item of [airing, old, middle]) {
      await ok(ctx, "danmaku.match", { resourceId: item.resourceId });
      const loaded = await ok<Loaded>(ctx, "danmaku.load", { resourceId: item.resourceId, refresh: true });
      lifetimes.push(Date.parse(loaded.expiresAt) - Date.parse(loaded.fetchedAt));
      ctx.clock.t += 2 * 60_000;
    }
    expect(lifetimes).toEqual([CACHE_TTL.airingMs, CACHE_TTL.finishedMs, CACHE_TTL.ordinaryMs]);
  });

  it("asks again after the lifetime ends and not before", async () => {
    const ctx = await rig();
    const v = video(ctx, "连载中 02", { ordinal: 2 });
    link(ctx, v.workId, 100, { fields: { releaseDate: "2026-09-20" } });
    await ok(ctx, "danmaku.match", { resourceId: v.resourceId });
    await ok(ctx, "danmaku.load", { resourceId: v.resourceId });
    const comments = () => ctx.server.hits(/\/api\/v2\/comment\//).length;
    ctx.clock.t += 59 * 60_000;
    expect((await ok<Loaded>(ctx, "danmaku.load", { resourceId: v.resourceId })).fromCache).toBe(true);
    expect(comments()).toBe(1);
    ctx.clock.t += 2 * 60_000;
    expect((await ok<Loaded>(ctx, "danmaku.load", { resourceId: v.resourceId })).fromCache).toBe(false);
    expect(comments()).toBe(2);
  });

  it("refreshes by hand at most once a minute for an episode", async () => {
    const ctx = await rig();
    const v = video(ctx, "样例动画 第02话", { ordinal: 2 });
    link(ctx, v.workId, 100);
    await ok(ctx, "danmaku.match", { resourceId: v.resourceId });
    await ok(ctx, "danmaku.load", { resourceId: v.resourceId });
    ctx.clock.t += 20_000;
    const early = await call(ctx, "danmaku.load", { resourceId: v.resourceId, refresh: true });
    expect(early.error).toMatchObject({ code: "RATE_LIMITED", details: { reason: "refresh_too_soon", retryAfterMs: 40_000 } });
    expect(ctx.server.hits(/\/api\/v2\/comment\//)).toHaveLength(1);
    ctx.clock.t += 41_000;
    expect((await ok<Loaded>(ctx, "danmaku.load", { resourceId: v.resourceId, refresh: true })).fromCache).toBe(false);
    expect(ctx.server.hits(/\/api\/v2\/comment\//)).toHaveLength(2);
  });
});

describe("when the service lets the request down (AT-94)", () => {
  async function loadedEpisode() {
    const ctx = await rig();
    const v = video(ctx, "样例动画 第02话", { ordinal: 2 });
    link(ctx, v.workId, 100, { fields: { releaseDate: "2026-09-20" } });
    await ok(ctx, "danmaku.match", { resourceId: v.resourceId });
    await ok(ctx, "danmaku.load", { resourceId: v.resourceId });
    return { ctx, v };
  }

  it("shows the last copy with the service's reason after a 403, and does not ask again for it", async () => {
    const { ctx, v } = await loadedEpisode();
    ctx.clock.t += 3 * 3_600_000;
    ctx.server.accepts = OTHER_CREDENTIALS;
    const shown = await ok<Loaded>(ctx, "danmaku.load", { resourceId: v.resourceId });
    expect(shown).toMatchObject({ fromCache: true, stale: true, count: 7, warning: { code: "AUTHENTICATION_FAILED", message: "Invalid AppId" } });
  });

  it("backs off after a 429 for as long as the service asked, shows the copy it has, and never retries by itself", async () => {
    const { ctx, v } = await loadedEpisode();
    ctx.clock.t += 3 * 3_600_000;
    ctx.server.script((request) => request.path.startsWith("/api/v2/comment/"), { status: 429, headers: { "retry-after": "120" } });
    const first = await ok<Loaded>(ctx, "danmaku.load", { resourceId: v.resourceId });
    expect(first).toMatchObject({ stale: true, warning: { code: "RATE_LIMITED", retryAfterMs: 120_000 } });
    const sent = ctx.server.requests.length;
    ctx.clock.t += 30_000;
    const second = await ok<Loaded>(ctx, "danmaku.load", { resourceId: v.resourceId });
    expect(second.warning).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 90_000 });
    expect(ctx.server.requests.length).toBe(sent);
    const status = await ok<{ pausedForMs: number }>(ctx, "danmaku.status", { resourceId: v.resourceId });
    expect(status.pausedForMs).toBe(90_000);
    ctx.clock.t += 91_000;
    expect((await ok<Loaded>(ctx, "danmaku.load", { resourceId: v.resourceId })).stale).toBe(false);
  });

  it("is an error with the service's reason when there is no copy to show", async () => {
    const ctx = await rig();
    const v = video(ctx, "样例动画 第02话", { ordinal: 2 });
    link(ctx, v.workId, 100);
    await ok(ctx, "danmaku.match", { resourceId: v.resourceId });
    ctx.server.script((request) => request.path.startsWith("/api/v2/comment/"), { status: 403, headers: { "x-error-message": "AppId disabled" } });
    const refused = await call(ctx, "danmaku.load", { resourceId: v.resourceId });
    expect(refused.error).toMatchObject({ code: "AUTHENTICATION_FAILED", message: "AppId disabled" });
    ctx.server.script((request) => request.path.startsWith("/api/v2/comment/"), { status: 429, headers: { "retry-after": "45" } });
    const limited = await call(ctx, "danmaku.load", { resourceId: v.resourceId });
    expect(limited.error).toMatchObject({ code: "RATE_LIMITED", details: { retryAfterMs: 45_000 } });
    const sent = ctx.server.requests.length;
    expect((await call(ctx, "danmaku.load", { resourceId: v.resourceId })).error?.code).toBe("RATE_LIMITED");
    expect(ctx.server.requests.length).toBe(sent);
  });
});

describe("settings, offset and the module switch (AT-94)", () => {
  it("starts with the defaults of Q-28 and takes changes that are valid, refusing the rest", async () => {
    const ctx = await rig();
    const first = await ok<{ settings: DanmakuSettings }>(ctx, "danmaku.getSettings");
    expect(first.settings).toEqual(DEFAULT_DANMAKU_SETTINGS);
    expect(first.settings).toMatchObject({ enabled: false, scroll: true, top: true, bottom: false, area: 0.5, opacity: 0.8, color: true, merge: true, convert: "simplified", followRate: true });
    const changed = await ok<{ settings: DanmakuSettings }>(ctx, "danmaku.setSettings", { enabled: true, opacity: 0.5, blockWords: ["剧透"], blockPatterns: ["^[a-z]+$"], sourcesOff: ["BiliBili"], area: 1, bottom: true, followRate: false });
    expect(changed.settings).toMatchObject({ enabled: true, opacity: 0.5, blockWords: ["剧透"], blockPatterns: ["^[a-z]+$"], sourcesOff: ["BiliBili"], area: 1, bottom: true, followRate: false });
    expect((await ok<{ settings: DanmakuSettings }>(ctx, "danmaku.getSettings")).settings).toEqual(changed.settings);
    for (const bad of [{ blockPatterns: ["(unclosed"] }, { blockPatterns: ["(a+)+"] }, { blockPatterns: ["(x*)*y"] }, { opacity: 3 }, { area: 0.3 }, { size: 10 }, { convert: "pinyin" }, { colour: true }, { blockWords: [""] }, { followRate: "yes" }]) {
      expect((await call(ctx, "danmaku.setSettings", bad)).error?.code, JSON.stringify(bad)).toBe("VALIDATION_ERROR");
    }
    expect((await ok<{ settings: DanmakuSettings }>(ctx, "danmaku.getSettings")).settings).toEqual(changed.settings);
  });

  it("keeps the time offset for the episode, and starts again from zero when another episode is chosen", async () => {
    const ctx = await rig();
    const v = video(ctx, "样例动画 第02话", { ordinal: 2 });
    link(ctx, v.workId, 100);
    expect((await call(ctx, "danmaku.setOffset", { resourceId: v.resourceId, offsetMs: 500 })).error?.code).toBe("NOT_FOUND");
    await ok(ctx, "danmaku.match", { resourceId: v.resourceId });
    expect((await ok<{ match: DanmakuMatchInfo }>(ctx, "danmaku.setOffset", { resourceId: v.resourceId, offsetMs: -2500 })).match.offsetMs).toBe(-2500);
    expect((await ok<Loaded>(ctx, "danmaku.load", { resourceId: v.resourceId })).match.offsetMs).toBe(-2500);
    // Confirming the same episode keeps the offset; another episode does not.
    const same = await ok<{ match: DanmakuMatchInfo }>(ctx, "danmaku.choose", { resourceId: v.resourceId, episodeId: 900102, animeId: 9001, animeTitle: "样例动画", episodeTitle: "第2话" });
    expect(same.match).toMatchObject({ offsetMs: -2500, confirmed: true, method: "manual" });
    const other = await ok<{ match: DanmakuMatchInfo }>(ctx, "danmaku.choose", { resourceId: v.resourceId, episodeId: 900103, animeId: 9001, animeTitle: "样例动画", episodeTitle: "第3话" });
    expect(other.match.offsetMs).toBe(0);
    expect((await call(ctx, "danmaku.setOffset", { resourceId: v.resourceId, offsetMs: 9_000_000 })).error?.code).toBe("VALIDATION_ERROR");
  });

  it("asks the service for the other conversion when the setting changes, and keeps both copies", async () => {
    const ctx = await rig();
    const v = video(ctx, "样例动画 第02话", { ordinal: 2 });
    link(ctx, v.workId, 100);
    await ok(ctx, "danmaku.match", { resourceId: v.resourceId });
    await ok(ctx, "danmaku.load", { resourceId: v.resourceId });
    await ok(ctx, "danmaku.setSettings", { convert: "traditional" });
    const traditional = await ok<Loaded>(ctx, "danmaku.load", { resourceId: v.resourceId });
    expect(traditional.fromCache).toBe(false);
    expect(ctx.server.hits(/\/api\/v2\/comment\//).map((request) => request.query.get("chConvert"))).toEqual(["1", "2"]);
    await ok(ctx, "danmaku.setSettings", { convert: "simplified" });
    expect((await ok<Loaded>(ctx, "danmaku.load", { resourceId: v.resourceId })).fromCache).toBe(true);
    expect((await ok<{ removed: number }>(ctx, "danmaku.clearCache")).removed).toBe(2);
    expect((ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM danmaku_cache").get() as { n: number }).n).toBe(0);
  });

  it("keeps the cache, the match and the settings when the module is turned off, and has no commands and no screen while it is off", async () => {
    const ctx = await rig();
    const v = video(ctx, "样例动画 第02话", { ordinal: 2 });
    link(ctx, v.workId, 100);
    await ok(ctx, "danmaku.setSettings", { enabled: true, blockWords: ["剧透"] });
    await ok(ctx, "danmaku.match", { resourceId: v.resourceId });
    await ok(ctx, "danmaku.setOffset", { resourceId: v.resourceId, offsetMs: 1000 });
    await ok(ctx, "danmaku.load", { resourceId: v.resourceId });
    expect(ctx.app.uiFacets.has("danmaku")).toBe(true);
    const sent = ctx.server.requests.length;

    await ok(ctx, "settings.setModule", { featureId: "danmaku", enabled: false });
    expect(ctx.app.uiFacets.has("danmaku")).toBe(false);
    for (const commandId of ["danmaku.status", "danmaku.load", "danmaku.getSettings", "danmaku.around", "danmaku.match"]) {
      expect((await call(ctx, commandId, { resourceId: v.resourceId, resourceRevisionId: v.revisionId, centerMs: 1000 })).status, commandId).toBe("error");
    }
    const count = (table: string) => (ctx.app.store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    expect([count("danmaku_cache"), count("danmaku_matches")]).toEqual([1, 1]);
    expect(ctx.server.requests.length).toBe(sent);
    const modules = await ok<{ modules: Array<{ featureId: string; wanted: boolean }> }>(ctx, "settings.getModules");
    expect(modules.modules.find((item) => item.featureId === "danmaku")).toMatchObject({ wanted: false });

    await ok(ctx, "settings.setModule", { featureId: "danmaku", enabled: true });
    expect((await ok<{ settings: DanmakuSettings }>(ctx, "danmaku.getSettings")).settings).toMatchObject({ enabled: true, blockWords: ["剧透"] });
    const back = await ok<Loaded>(ctx, "danmaku.load", { resourceId: v.resourceId });
    expect(back).toMatchObject({ fromCache: true, count: 7, match: { offsetMs: 1000 } });
    expect(ctx.server.requests.length).toBe(sent);
  });
});

describe("a task reads only what is kept, and only what has been watched (AT-94)", () => {
  async function watched() {
    const ctx = await rig();
    const v = video(ctx, "样例动画 第02话", { ordinal: 2 });
    link(ctx, v.workId, 100);
    await ok(ctx, "danmaku.match", { resourceId: v.resourceId });
    const agent = { kind: "agent" as const, id: "agent-danmaku" };
    const grant = ctx.app.issueAgentGrant(ctx.grant, agent, { sessionId: "s-d", runId: "r-d", readResourceIds: [v.resourceId] });
    return { ctx, v, as: { grant: grant.handle, actor: agent } };
  }
  type Around = { status: string; count: number; items: Array<{ atMs: number; text: string }>; fromMs: number; toMs: number; limitMs: number; guard: string; attribution: string };

  it("returns nothing and does not go to the network when no danmaku is kept", async () => {
    const { ctx, v, as } = await watched();
    const sent = ctx.server.requests.length;
    const answer = await call(ctx, "danmaku.around", { resourceId: v.resourceId, resourceRevisionId: v.revisionId, centerMs: 4000 }, as);
    expect(answer.status).toBe("ok");
    expect(answer.value).toMatchObject({ status: "none", count: 0, items: [] });
    expect(ctx.server.requests.length).toBe(sent);
  });

  it("gives the count and some lines near a moment from the cache, never later than the position watched, and never causes a request", async () => {
    const { ctx, v, as } = await watched();
    await ok(ctx, "danmaku.load", { resourceId: v.resourceId });
    await ok(ctx, "settings.setShell", { spoilerGuard: true });
    await ok(ctx, "progress.setTime", { resourceId: v.resourceId, resourceRevisionId: v.revisionId, timeMs: 6000, played: [{ startMs: 0, endMs: 6000 }] });
    const sent = ctx.server.requests.length;

    const near = (await call(ctx, "danmaku.around", { resourceId: v.resourceId, resourceRevisionId: v.revisionId, centerMs: 5000, windowMs: 20_000 }, as)).value as Around;
    expect(near).toMatchObject({ status: "ok", guard: "progress", attribution: "弹幕来自弹弹play开放弹幕网络" });
    expect(near.limitMs).toBeLessThanOrEqual(5000);
    expect(near.items.every((item) => item.atMs <= near.limitMs)).toBe(true);
    expect(near.items.map((item) => item.text)).toEqual(["前方高能", "哈哈哈", "哈哈哈", "顶部的一条"]);
    expect(near.count).toBe(4);

    // Asking about a moment far ahead does not move the limit: the later comments stay hidden.
    const ahead = (await call(ctx, "danmaku.around", { resourceId: v.resourceId, resourceRevisionId: v.revisionId, centerMs: 29_000, windowMs: 120_000 }, as)).value as Around;
    expect(ahead.limitMs).toBe(6000);
    expect(ahead.items.map((item) => item.text)).not.toContain("很后面的剧透");
    expect(ahead.items.map((item) => item.text)).not.toContain("底部的一条");
    expect(JSON.stringify(ahead)).not.toContain("剧透");

    // The few lines are a sample, and the count says how many there are in the window.
    const sample = (await call(ctx, "danmaku.around", { resourceId: v.resourceId, resourceRevisionId: v.revisionId, centerMs: 5000, windowMs: 20_000, limit: 2 }, as)).value as Around;
    expect(sample.items).toHaveLength(2);
    expect(sample.count).toBe(4);
    expect(ctx.server.requests.length).toBe(sent);
  });

  it("applies the offset of the episode to the times it reports, and honours a resource outside the grant", async () => {
    const { ctx, v, as } = await watched();
    await ok(ctx, "danmaku.load", { resourceId: v.resourceId });
    await ok(ctx, "settings.setShell", { spoilerGuard: false });
    await ok(ctx, "danmaku.setOffset", { resourceId: v.resourceId, offsetMs: 1000 });
    const shifted = (await call(ctx, "danmaku.around", { resourceId: v.resourceId, resourceRevisionId: v.revisionId, centerMs: 3000, windowMs: 4000 }, as)).value as Around;
    expect(shifted.items.map((item) => item.atMs)).toEqual([2500]);
    const other = video(ctx, "别的作品 01", { ordinal: 1 });
    const outside = await call(ctx, "danmaku.around", { resourceId: other.resourceId, resourceRevisionId: other.revisionId, centerMs: 2000 }, as);
    expect(outside.error?.code).toBe("SCOPE_DENIED");
    // The comments are kept by revision: the granted resource with the revision of the other one does not read the other one's comments.
    link(ctx, other.workId, 100);
    await ok(ctx, "danmaku.match", { resourceId: other.resourceId });
    await ok(ctx, "danmaku.load", { resourceId: other.resourceId });
    const borrowed = await call(ctx, "danmaku.around", { resourceId: v.resourceId, resourceRevisionId: other.revisionId, centerMs: 3000, windowMs: 4000 }, as);
    expect(borrowed.error?.code).toBe("SCOPE_DENIED");
    expect(borrowed.value).toBeUndefined();
  });

  it("is the only danmaku command a task has: matching, loading, searching, settings and credentials stay with the person", async () => {
    const { ctx, v, as } = await watched();
    const sent = ctx.server.requests.length;
    const inputs: Record<string, Record<string, unknown>> = {
      "danmaku.status": { resourceId: v.resourceId },
      "danmaku.match": { resourceId: v.resourceId, refresh: true },
      "danmaku.search": { query: "样例" },
      "danmaku.choose": { resourceId: v.resourceId, episodeId: 1, animeTitle: "a", episodeTitle: "b" },
      "danmaku.setOffset": { resourceId: v.resourceId, offsetMs: 1 },
      "danmaku.load": { resourceId: v.resourceId, refresh: true },
      "danmaku.getSettings": {},
      "danmaku.setSettings": { enabled: true },
      "danmaku.setCredentials": { clear: true },
      "danmaku.clearCache": {},
    };
    for (const [commandId, input] of Object.entries(inputs)) {
      const refused = await call(ctx, commandId, input, as);
      expect(refused.status, commandId).toBe("error");
      expect(["FORBIDDEN", "SCOPE_DENIED"], commandId).toContain(refused.error?.code);
    }
    expect(ctx.server.requests.length).toBe(sent);
  });
});

describe("credentials stay in the main process (AT-94)", () => {
  it("never appear in what the screen can ask for: status, settings, the log, error messages or the stored rows' plain text", async () => {
    const ctx = await rig({ credentials: null });
    const v = video(ctx, "样例动画 第02话", { ordinal: 2 });
    link(ctx, v.workId, 100);
    const handle = ctx.app.stashSecret(JSON.stringify(OTHER_CREDENTIALS));
    const saved = await ok(ctx, "danmaku.setCredentials", { credentialHandle: handle });
    ctx.server.accepts = FAKE_CREDENTIALS;
    const refused = await call(ctx, "danmaku.match", { resourceId: v.resourceId });
    const answers = [
      saved,
      refused,
      await ok(ctx, "danmaku.status", { resourceId: v.resourceId }),
      await ok(ctx, "danmaku.getSettings"),
      await ok(ctx, "log.query", {}),
      await ok(ctx, "settings.getMedia"),
    ];
    const text = JSON.stringify(answers);
    for (const secret of [OTHER_CREDENTIALS.appId, OTHER_CREDENTIALS.secret, FAKE_CREDENTIALS.appId, FAKE_CREDENTIALS.secret]) expect(text).not.toContain(secret);
    expect(refused.error?.code).toBe("AUTHENTICATION_FAILED");
    // The stored value is not the plain pair either.
    const rows = ctx.app.store.sqlite.prepare("SELECT ciphertext FROM credentials").all() as Array<{ ciphertext: Buffer }>;
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.ciphertext).includes(Buffer.from(OTHER_CREDENTIALS.secret))).toBe(false);
  });
});
