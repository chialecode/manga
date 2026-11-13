import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CACHE_TTL, DandanClient, parseComments } from "@manga/app-core";
import { startApp } from "../helpers/app.ts";
import { FAKE_CREDENTIALS, FakeDandan } from "../helpers/fake-dandan.ts";
import { seedVideo } from "../helpers/media-seed.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe("danmaku regressions", () => {
  it("airdateOf reads metadata_snapshots (when work_links holds only title) and empty episodeNumber never matches episode 0", async () => {
    const server = await new FakeDandan().start();
    const clock = { t: Date.parse("2026-10-09T08:00:00Z") };
    const ctx = await startApp({
      options: {
        danmaku: {
          credentials: FAKE_CREDENTIALS,
          origin: server.origin,
          client: { allowHttp: true, now: () => clock.t },
          now: () => clock.t,
        },
      },
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "manga-dm-airdate-"));
    cleanups.push(async () => {
      ctx.app.close();
      await server.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    const daysAgo = (days: number) => new Date(clock.t - days * 86_400_000).toISOString().slice(0, 10);
    const fileA = path.join(tmp, "airing.mkv");
    const fileB = path.join(tmp, "old.mkv");
    fs.writeFileSync(fileA, Buffer.alloc(1024, 1));
    fs.writeFileSync(fileB, Buffer.alloc(1024, 2));
    const airing = seedVideo(ctx.app, { title: "新番 第02话", durationMs: 1_400_000, file: fileA, ordinal: { number: 2, type: "episode", label: "第 2 话" } });
    const old = seedVideo(ctx.app, { title: "老番 第02话", durationMs: 1_400_000, file: fileB, ordinal: { number: 2, type: "episode", label: "第 2 话" } });
    const now = new Date(clock.t).toISOString();

    // Production layout: work_links.snapshot_json only stores { title }, full snapshot lives in metadata_snapshots.
    const insertLinked = (workId: string, snapshot: Record<string, unknown>) => {
      ctx.app.store.sqlite.prepare(
        "INSERT INTO work_links(work_id, provider_id, external_id, snapshot_json, confirmed_at, namespace, subject_type, link_state, match_basis) VALUES (?,?,?,?,?,?,?,?,?)",
      ).run(workId, "bangumi", "100", JSON.stringify({ title: "样例动画" }), now, "bangumi:subject", 2, "linked", "manual");
      ctx.app.store.sqlite.prepare(
        "INSERT INTO metadata_snapshots(work_id, provider_id, external_id, snapshot_json, fetched_at, source_url, api_version, detached) VALUES (?,?,?,?,?,?,?,0)",
      ).run(workId, "bangumi", "100", JSON.stringify({ version: 1, fields: {}, episodes: [], ...snapshot }), now, "https://bgm.tv/subject/100", "v0");
    };
    insertLinked(airing.workId, { episodes: [{ ep: 2, sort: 2, type: 0, title: "", airdate: daysAgo(2) }], fields: { releaseDate: daysAgo(500) } });
    insertLinked(old.workId, { fields: { releaseDate: daysAgo(600) } });

    const call = async (commandId: string, input: Record<string, unknown>, key: string) => {
      const r = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: key, input }, ctx.grant.handle);
      expect(r.status, JSON.stringify(r)).toBe("ok");
      return r.value as Record<string, unknown>;
    };

    await call("danmaku.match", { resourceId: airing.resourceId }, "match-airing");
    const loadedA = await call("danmaku.load", { resourceId: airing.resourceId }, "load-airing") as { fetchedAt: string; expiresAt: string };
    expect(Date.parse(loadedA.expiresAt) - Date.parse(loadedA.fetchedAt)).toBe(CACHE_TTL.airingMs);

    clock.t += 2 * 60_000;
    await call("danmaku.match", { resourceId: old.resourceId }, "match-old");
    const loadedB = await call("danmaku.load", { resourceId: old.resourceId, refresh: true }, "load-old") as { fetchedAt: string; expiresAt: string };
    expect(Date.parse(loadedB.expiresAt) - Date.parse(loadedB.fetchedAt)).toBe(CACHE_TTL.finishedMs);

    // Empty episodeNumber string must NOT coerce to 0 and accidentally match episode 0.
    const fileZero = path.join(tmp, "zero.mkv");
    fs.writeFileSync(fileZero, Buffer.alloc(1024, 3));
    const epZero = seedVideo(ctx.app, { title: "无集号", durationMs: 1_400_000, file: fileZero, ordinal: { number: 0, type: "episode", label: "第 0 话" } });
    insertLinked(epZero.workId, {});
    server.script((req) => req.path === "/api/v2/bangumi/bgmtv/100", {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        success: true,
        errorCode: 0,
        bangumi: {
          animeId: 9001,
          animeTitle: "样例动画",
          episodes: [{ episodeId: 900100, episodeTitle: "特典", episodeNumber: "" }],
        },
      }),
    });
    const unmatched = await call("danmaku.match", { resourceId: epZero.resourceId }, "match-empty-ep") as { state: string };
    // Empty episodeNumber must NOT match episode 0 on Bangumi; it falls through to hash-matching (needs_consent).
    expect(unmatched.state).toBe("needs_consent");
  });

  it("DandanClient streams responses and cancels body when exceeding maxBytes (both with and without Content-Length)", async () => {
    let cancelled = false;
    const streamClient = new DandanClient({
      credentials: () => FAKE_CREDENTIALS,
      userAgent: "manga-test/1.0",
      maxBytes: 1024,
      fetch: async () => {
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(600).fill(65));
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await expect(streamClient.comments(123, 0)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    expect(cancelled).toBe(true);

    // Declared Content-Length over limit rejects before reading chunks.
    const headerClient = new DandanClient({
      credentials: () => FAKE_CREDENTIALS,
      userAgent: "manga-test/1.0",
      maxBytes: 1024,
      fetch: async () => new Response("{}", { status: 200, headers: { "content-length": "999999" } }),
    });
    await expect(headerClient.comments(123, 0)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
  });

  it("parseComments skips empty time strings and defaults empty color to 0xffffff", () => {
    const parsed = parseComments({
      count: 3,
      comments: [
        { cid: 1, p: ",1,16777215,user", m: "empty time should be skipped" },
        { cid: 2, p: "   ,1,16777215,user", m: "whitespace time should be skipped" },
        { cid: 3, p: "2.5,1,,user", m: "empty color defaults to white" },
      ],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ at: 2500, mode: "scroll", color: 0xffffff, text: "empty color defaults to white" });
  });
});
