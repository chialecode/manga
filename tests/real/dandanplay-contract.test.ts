import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MangaError } from "@manga/contracts";
import { DandanClient } from "../../packages/app-core/src/danmaku/client.ts";
import { parseComments } from "../../packages/app-core/src/danmaku/parse.ts";
import { evidenceRunDir } from "../../scripts/desktop-paths.ts";
import { readLocalEnv } from "../helpers/local-env.ts";

/**
 * Contract check of the DanDanPlay open API (v2) through the app's own client. It runs only when MANGA_LIVE_DANDANPLAY=1 and never in CI.
 *
 * - what is sent is public: the title of a well-known show, a public Bangumi subject number, one episode number, and a file description that is
 *   made up here (a name, size and hash that belong to no file), never anything from a library;
 * - at most BUDGET requests per run (what is left of the ten the developer allowed, ACT-10), counted where the request leaves the process; the first
 *   refusal ends the run, so an application that is not yet approved costs one request;
 * - the application credentials come from the ignored local file (MANGA_DANDANPLAY_APP_ID / _SECRET) and are never printed or written; the evidence
 *   carries outcomes, statuses and counts only.
 */
const enabled = process.env.MANGA_LIVE_DANDANPLAY === "1" && !process.env.CI;
const BUDGET = Number(process.env.MANGA_LIVE_DANDANPLAY_BUDGET ?? 7);
// A show everyone can look up, and its public Bangumi subject.
const SHOW = "葬送的芙莉莲";
const BANGUMI_SUBJECT = 400602;

type Step = { step: string; outcome: "ok" | "failed"; detail?: Record<string, unknown> };

describe.skipIf(!enabled)("DanDanPlay open API contract (live, public queries only)", () => {
  it("searches a show, maps a Bangumi subject, reads one episode's comments and does not match a made-up file, inside the budget", async (context) => {
    const out = path.join(evidenceRunDir("live-dandanplay"), "summary.json");
    const steps: Step[] = [];
    let requests = 0;
    const write = (status: "passed" | "blocked" | "failed" | "not-run", extra: Record<string, unknown> = {}) => {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), status, requests, budget: BUDGET, steps, ...extra }, null, 2));
    };

    const config = readLocalEnv(["MANGA_DANDANPLAY_APP_ID", "MANGA_DANDANPLAY_APP_SECRET"]);
    const appId = config.MANGA_DANDANPLAY_APP_ID;
    const secret = config.MANGA_DANDANPLAY_APP_SECRET;
    if (!appId || !secret) {
      write("not-run", { reason: "MANGA_DANDANPLAY_APP_ID / MANGA_DANDANPLAY_APP_SECRET are not configured in the ignored local environment" });
      context.skip();
      return;
    }

    const client = new DandanClient({
      // The count is taken where the request leaves the process, redirects included.
      fetch: (url, init) => {
        if (requests >= BUDGET) throw new Error("request budget exhausted");
        requests += 1;
        return fetch(url, init as RequestInit);
      },
      credentials: () => ({ appId, secret }),
      userAgent: "MANGA/0.0.0 (local reader)",
      timeoutMs: 20_000,
    });
    const attempt = async <T>(step: string, run: () => Promise<T>, summarize: (value: T) => Record<string, unknown>): Promise<T> => {
      try {
        const value = await run();
        steps.push({ step, outcome: "ok", detail: summarize(value) });
        return value;
      } catch (error) {
        const failure = error instanceof MangaError ? { code: error.code, reason: error.details.reason ?? null, serverMessage: error.details.serverMessage ?? null, status: error.details.status ?? null } : { code: "UNKNOWN" };
        steps.push({ step, outcome: "failed", detail: failure });
        throw error;
      }
    };

    try {
      const search = await attempt("GET /api/v2/search/episodes", () => client.searchEpisodes(SHOW, 1), (value) => ({
        animes: value.animes.length,
        episodes: value.animes.reduce((sum, anime) => sum + anime.episodes.length, 0),
      }));
      const anime = search.animes.find((item) => item.episodes.length > 0);
      expect(anime, "the search finds the show with its first episode").toBeDefined();
      const episodeId = anime!.episodes[0]!.episodeId;

      const mapped = await attempt("GET /api/v2/bangumi/bgmtv/{subject}", () => client.bangumiSubject(BANGUMI_SUBJECT), (value) => ({
        mapped: Boolean(value.bangumi),
        episodes: value.bangumi?.episodes.length ?? 0,
        sameShowAsSearch: value.bangumi ? value.bangumi.animeId === anime!.animeId : false,
      }));
      expect(mapped.bangumi?.episodes.length ?? 0).toBeGreaterThan(0);

      const comments = await attempt("GET /api/v2/comment/{episode}", () => client.comments(episodeId, 1), (value) => {
        const items = parseComments(value);
        const modes = items.reduce<Record<string, number>>((sum, item) => ({ ...sum, [item.mode]: (sum[item.mode] ?? 0) + 1 }), {});
        return { count: value.count, parsed: items.length, modes, sources: new Set(items.map((item) => item.source || "dandanplay")).size, lastAtMinutes: items.length ? Math.round(items.at(-1)!.at / 60_000) : 0 };
      });
      expect(comments.count).toBeGreaterThan(0);
      expect(parseComments(comments).length).toBeGreaterThan(0);

      // A file that does not exist: a made-up name and size, and the hash of a few bytes that belong to nothing.
      const synthetic = { fileName: "manga-contract-synthetic-0001.mkv", fileHash: crypto.createHash("md5").update("manga-contract-synthetic-0001").digest("hex"), fileSize: 123_456_789, videoDurationSec: 1440 };
      const match = await attempt("POST /api/v2/match (made-up file)", () => client.match(synthetic), (value) => ({ isMatched: value.isMatched, candidates: value.matches.length }));
      expect(match.isMatched).toBe(false);

      expect(requests).toBeLessThanOrEqual(BUDGET);
      write("passed");
    } catch (error) {
      const refused = error instanceof MangaError && error.code === "AUTHENTICATION_FAILED";
      write(refused ? "blocked" : "failed", refused ? { reason: "the service refused the application credentials; no further request was sent" } : {});
      if (refused) {
        context.skip();
        return;
      }
      throw error;
    }
  }, 120_000);
});
