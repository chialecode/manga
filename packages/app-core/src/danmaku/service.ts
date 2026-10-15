import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  DANMAKU_ATTRIBUTION, DEFAULT_DANMAKU_SETTINGS, DanmakuSettingsSchema, MangaError,
  type DanmakuCandidate, type DanmakuItem, type DanmakuMatchInfo, type DanmakuSettings, type DanmakuSettingsPatch,
} from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import type { VideoService } from "../video/service.ts";
import type { DandanClient } from "./client.ts";
import { parseComments } from "./parse.ts";

export const DANMAKU_MODULE = "manga.danmaku";
export const DANMAKU_SOURCE = "dandanplay";
const SETTINGS_KEY = "danmaku.settings";
/** The bytes of a file that go into its fingerprint: the first 16 MiB, as the network defines it. */
const HASH_BYTES = 16 * 1024 * 1024;
/** How long an episode's comments are kept (Q-28): an airing show changes hourly, a finished one barely. */
export const CACHE_TTL = { airingMs: 60 * 60_000, ordinaryMs: 6 * 60 * 60_000, finishedMs: 3 * 24 * 60 * 60_000 } as const;
/** A manual refresh of an episode is allowed once a minute. */
export const REFRESH_MIN_MS = 60_000;
const AIRING_WITHIN_DAYS = 100;
const FINISHED_AFTER_DAYS = 365;
const SEARCH_LIMIT = 60;

/** How long to keep an episode, from the date it aired (or, failing that, the date its show began). A date that cannot be read counts as ordinary. */
export function cacheTtlMs(airdate: string | null | undefined, nowMs: number): number {
  const at = airdate ? Date.parse(airdate) : Number.NaN;
  if (!Number.isFinite(at)) return CACHE_TTL.ordinaryMs;
  const days = (nowMs - at) / 86_400_000;
  if (days < AIRING_WITHIN_DAYS) return CACHE_TTL.airingMs;
  if (days > FINISHED_AFTER_DAYS) return CACHE_TTL.finishedMs;
  return CACHE_TTL.ordinaryMs;
}

export type CredentialSource = "custom" | "built-in" | "none";
export type ConsentState = "unasked" | "allowed" | "denied";

export type DanmakuDeps = {
  store: DrizzleStore;
  videos: Pick<VideoService, "load">;
  client: DandanClient;
  credentialSource: () => CredentialSource;
  /** What a work is searched for, from its title or file name. */
  suggestedQuery: (workId: string) => string;
  now?: () => number;
};

export type MatchOutcome =
  | { state: "matched"; match: DanmakuMatchInfo }
  | { state: "no_credentials" }
  | { state: "needs_consent" }
  | { state: "needs_choice"; candidates: DanmakuCandidate[]; reason: "denied" | "uncertain" | "none" | "no_episode"; suggestedQuery: string; episodeNumber: number | null };

export type LoadWarning = { code: string; message: string; retryAfterMs?: number };
export type LoadOutcome =
  | { state: "ok"; items: DanmakuItem[]; count: number; fetchedAt: string; expiresAt: string; fromCache: boolean; stale: boolean; warning: LoadWarning | null; match: DanmakuMatchInfo; attribution: string }
  | { state: "no_match" }
  | { state: "no_credentials" };

type Target = { resourceId: string; revisionId: string; workId: string | null; title: string; file: string; available: boolean; durationMs: number; ordinal: number | null };
type MatchRow = { resource_revision_id: string; source: string; anime_id: number | null; episode_id: number; anime_title: string; episode_title: string; offset_ms: number; method: DanmakuMatchInfo["method"]; confirmed: number; matched_at: string };
type CacheRow = { source: string; episode_id: number; fetched_at: string; expires_at: string; count: number; payload: Buffer };

const matchInfo = (row: MatchRow): DanmakuMatchInfo => ({
  source: row.source, animeId: row.anime_id, episodeId: row.episode_id, animeTitle: row.anime_title, episodeTitle: row.episode_title,
  offsetMs: row.offset_ms, method: row.method, confirmed: row.confirmed === 1, matchedAt: row.matched_at,
});

/** The service ends a name at its last dot; a file without one keeps it whole. */
const stem = (file: string) => path.basename(file, path.extname(file));

export class DanmakuService {
  private readonly deps: DanmakuDeps;
  private readonly store: DrizzleStore;

  constructor(deps: DanmakuDeps) {
    this.deps = deps;
    this.store = deps.store;
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }

  // ------------------------------------------------------------------ settings

  settings(): DanmakuSettings {
    const raw = this.store.getMeta(SETTINGS_KEY);
    if (!raw) return structuredClone(DEFAULT_DANMAKU_SETTINGS);
    try {
      const parsed = DanmakuSettingsSchema.safeParse({ ...DEFAULT_DANMAKU_SETTINGS, ...(JSON.parse(raw) as object) });
      return parsed.success ? parsed.data : structuredClone(DEFAULT_DANMAKU_SETTINGS);
    } catch {
      return structuredClone(DEFAULT_DANMAKU_SETTINGS);
    }
  }

  setSettings(patch: DanmakuSettingsPatch): DanmakuSettings {
    const next = DanmakuSettingsSchema.parse({ ...this.settings(), ...patch });
    this.store.setMeta(SETTINGS_KEY, JSON.stringify(next));
    return next;
  }

  // ------------------------------------------------------------------ the file being watched

  private target(resourceId: string, revisionId?: string): Target {
    const row = this.deps.videos.load(resourceId, revisionId);
    const resource = this.store.sqlite.prepare("SELECT work_id, ordinal_number FROM resources WHERE id = ?").get(resourceId) as { work_id: string | null; ordinal_number: number | null } | undefined;
    return {
      resourceId, revisionId: row.revisionId, workId: resource?.work_id ?? null, title: row.title, file: row.path, available: row.available,
      durationMs: row.probe.durationMs, ordinal: resource?.ordinal_number ?? null,
    };
  }

  private savedMatch(revisionId: string): MatchRow | undefined {
    return this.store.sqlite.prepare("SELECT * FROM danmaku_matches WHERE resource_revision_id = ?").get(revisionId) as MatchRow | undefined;
  }

  /** The Bangumi subject a work is linked to, if it is. */
  private bangumiSubject(workId: string | null): number | null {
    if (!workId) return null;
    const link = this.store.sqlite.prepare("SELECT external_id FROM work_links WHERE work_id = ? AND provider_id = 'bangumi' AND link_state = 'linked' ORDER BY confirmed_at DESC LIMIT 1").get(workId) as { external_id: string } | undefined;
    const id = link ? Number(link.external_id) : Number.NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  }

  private consentOf(workId: string | null): ConsentState {
    if (!workId) return "unasked";
    const row = this.store.sqlite.prepare("SELECT allowed FROM danmaku_consent WHERE work_id = ?").get(workId) as { allowed: number } | undefined;
    return !row ? "unasked" : row.allowed === 1 ? "allowed" : "denied";
  }

  private decideConsent(workId: string, allowed: boolean): void {
    this.store.commit({
      mutations: [{ sql: "INSERT INTO danmaku_consent(work_id, allowed, decided_at) VALUES (?,?,?) ON CONFLICT(work_id) DO UPDATE SET allowed = excluded.allowed, decided_at = excluded.decided_at", params: [workId, allowed ? 1 : 0, new Date(this.now()).toISOString()] }],
      events: [{ type: "danmaku.consent", payload: { workId, allowed } }],
    });
  }

  /** The date that decides how long the comments are kept: the episode's own airing date from the entry the work is linked to, else the show's. */
  private airdateOf(target: Target): string | null {
    if (!target.workId) return null;
    const row = this.store.sqlite.prepare("SELECT snapshot_json FROM work_links WHERE work_id = ? AND link_state = 'linked' AND provider_id = 'bangumi' ORDER BY confirmed_at DESC LIMIT 1").get(target.workId) as { snapshot_json: string } | undefined;
    if (!row) return null;
    try {
      const snapshot = JSON.parse(row.snapshot_json) as { episodes?: Array<{ ep: number | null; sort: number; airdate?: string }>; fields?: { releaseDate?: unknown } };
      const episode = target.ordinal === null ? undefined : snapshot.episodes?.find((item) => item.ep === target.ordinal || (item.ep === null && item.sort === target.ordinal));
      if (episode?.airdate) return episode.airdate;
      return typeof snapshot.fields?.releaseDate === "string" ? snapshot.fields.releaseDate : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ cache

  private cacheKey(): string {
    const { convert } = this.settings();
    return `${DANMAKU_SOURCE}:${convert === "simplified" ? 1 : convert === "traditional" ? 2 : 0}`;
  }

  private cacheRow(episodeId: number): CacheRow | undefined {
    return this.store.sqlite.prepare("SELECT * FROM danmaku_cache WHERE source = ? AND episode_id = ?").get(this.cacheKey(), episodeId) as CacheRow | undefined;
  }

  private readCache(row: CacheRow): DanmakuItem[] {
    try { return JSON.parse(gunzipSync(row.payload).toString("utf8")) as DanmakuItem[]; } catch { return []; }
  }

  private writeCache(episodeId: number, items: DanmakuItem[], ttlMs: number): { fetchedAt: string; expiresAt: string } {
    const fetched = this.now();
    const fetchedAt = new Date(fetched).toISOString();
    const expiresAt = new Date(fetched + ttlMs).toISOString();
    this.store.sqlite.prepare(`INSERT INTO danmaku_cache(source, episode_id, fetched_at, expires_at, count, payload) VALUES (?,?,?,?,?,?)
      ON CONFLICT(source, episode_id) DO UPDATE SET fetched_at = excluded.fetched_at, expires_at = excluded.expires_at, count = excluded.count, payload = excluded.payload`)
      .run(this.cacheKey(), episodeId, fetchedAt, expiresAt, items.length, gzipSync(Buffer.from(JSON.stringify(items), "utf8")));
    return { fetchedAt, expiresAt };
  }

  clearCache(): { removed: number } {
    const removed = this.store.sqlite.prepare("DELETE FROM danmaku_cache").run().changes;
    return { removed: Number(removed) };
  }

  /** The cached comments of an episode in any convert setting (the freshest one), without the network. For a task, which must not cause a request. */
  cachedItems(revisionId: string): { items: DanmakuItem[]; match: DanmakuMatchInfo; fetchedAt: string } | null {
    const match = this.savedMatch(revisionId);
    if (!match) return null;
    const row = this.store.sqlite.prepare("SELECT * FROM danmaku_cache WHERE episode_id = ? AND source LIKE ? ORDER BY fetched_at DESC LIMIT 1").get(match.episode_id, `${DANMAKU_SOURCE}:%`) as CacheRow | undefined;
    if (!row) return null;
    return { items: this.readCache(row), match: matchInfo(match), fetchedAt: row.fetched_at };
  }

  // ------------------------------------------------------------------ status

  status(resourceId: string, revisionId?: string) {
    const target = this.target(resourceId, revisionId);
    const saved = this.savedMatch(target.revisionId);
    const cache = saved ? this.cacheRow(saved.episode_id) : undefined;
    const subject = this.bangumiSubject(target.workId);
    return {
      resourceId, resourceRevisionId: target.revisionId,
      credentials: this.deps.credentialSource(),
      settings: this.settings(),
      attribution: DANMAKU_ATTRIBUTION,
      match: saved ? matchInfo(saved) : null,
      cache: cache ? { count: cache.count, fetchedAt: cache.fetched_at, expiresAt: cache.expires_at, fresh: Date.parse(cache.expires_at) > this.now() } : null,
      linked: subject !== null,
      consent: this.consentOf(target.workId),
      pausedForMs: this.deps.client.pausedForMs(),
      suggestedQuery: target.workId ? this.deps.suggestedQuery(target.workId) : target.title,
      episodeNumber: target.ordinal,
    };
  }

  // ------------------------------------------------------------------ matching

  private save(target: Target, found: { animeId: number | null; episodeId: number; animeTitle: string; episodeTitle: string }, method: DanmakuMatchInfo["method"], confirmed: boolean): DanmakuMatchInfo {
    const previous = this.savedMatch(target.revisionId);
    // The person's offset belongs to the episode; choosing another episode starts again from zero.
    const offset = previous && previous.episode_id === found.episodeId ? previous.offset_ms : 0;
    const matchedAt = new Date(this.now()).toISOString();
    this.store.commit({
      mutations: [{
        sql: `INSERT INTO danmaku_matches(resource_revision_id, source, anime_id, episode_id, anime_title, episode_title, offset_ms, method, confirmed, matched_at) VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(resource_revision_id) DO UPDATE SET source = excluded.source, anime_id = excluded.anime_id, episode_id = excluded.episode_id, anime_title = excluded.anime_title,
            episode_title = excluded.episode_title, offset_ms = excluded.offset_ms, method = excluded.method, confirmed = excluded.confirmed, matched_at = excluded.matched_at`,
        params: [target.revisionId, DANMAKU_SOURCE, found.animeId, found.episodeId, found.animeTitle, found.episodeTitle, offset, method, confirmed ? 1 : 0, matchedAt],
      }],
      events: [{ type: "danmaku.matched", payload: { resourceId: target.resourceId, resourceRevisionId: target.revisionId, episodeId: found.episodeId, method } }],
    });
    return matchInfo(this.savedMatch(target.revisionId)!);
  }

  /** The MD5 of the first 16 MiB, which is how the network tells files apart. */
  private async fingerprint(file: string, signal?: AbortSignal): Promise<{ hash: string; size: number }> {
    const handle = await fs.promises.open(file, "r");
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, HASH_BYTES);
      const buffer = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, filled, length - filled, filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      return { hash: createHash("md5").update(buffer.subarray(0, filled)).digest("hex"), size };
    } finally {
      await handle.close();
    }
  }

  async match(input: { resourceId: string; resourceRevisionId?: string; consent?: boolean; refresh?: boolean }, signal?: AbortSignal): Promise<MatchOutcome> {
    const target = this.target(input.resourceId, input.resourceRevisionId);
    const saved = this.savedMatch(target.revisionId);
    if (saved && !input.refresh) return { state: "matched", match: matchInfo(saved) };
    if (this.deps.credentialSource() === "none") return { state: "no_credentials" };
    const query = target.workId ? this.deps.suggestedQuery(target.workId) : target.title;
    const choice = (reason: "denied" | "uncertain" | "none" | "no_episode", candidates: DanmakuCandidate[] = []): MatchOutcome => ({ state: "needs_choice", candidates, reason, suggestedQuery: query, episodeNumber: target.ordinal });

    // A work linked to a Bangumi entry is mapped through the entry: nothing about the file leaves the machine.
    const subject = this.bangumiSubject(target.workId);
    if (subject !== null && target.ordinal !== null) {
      const mapped = await this.deps.client.bangumiSubject(subject, signal);
      const show = mapped.bangumi;
      const episode = show?.episodes.find((item) => Number(item.episodeNumber) === target.ordinal);
      if (show && episode) {
        return { state: "matched", match: this.save(target, { animeId: show.animeId || null, episodeId: episode.episodeId, animeTitle: show.animeTitle, episodeTitle: episode.episodeTitle }, "bangumi", false) };
      }
    }

    // Anything else sends the file's name, fingerprint, size and length, which the person is asked about once per work.
    if (input.consent !== undefined && target.workId) this.decideConsent(target.workId, input.consent);
    const consent = target.workId ? this.consentOf(target.workId) : "unasked";
    if (consent === "unasked") return { state: "needs_consent" };
    if (consent === "denied") return choice("denied");

    let hashed: { hash: string; size: number } | null = null;
    try { hashed = target.available ? await this.fingerprint(target.file, signal) : null; } catch (error) {
      if (signal?.aborted) throw new MangaError("CANCELLED", "the match was cancelled");
      hashed = null;
    }
    const answer = await this.deps.client.match({
      fileName: stem(target.file) || target.title,
      fileHash: hashed?.hash ?? "00000000000000000000000000000000",
      fileSize: hashed?.size ?? 0,
      videoDurationSec: Math.round(target.durationMs / 1000),
      mode: hashed ? "hashAndFileName" : "fileNameOnly",
    }, signal);
    const candidates: DanmakuCandidate[] = answer.matches.map((item) => ({ animeId: item.animeId || null, animeTitle: item.animeTitle, episodeId: item.episodeId, episodeTitle: item.episodeTitle, ...(item.typeDescription ? { typeDescription: item.typeDescription } : {}) }));
    if (answer.isMatched && candidates.length === 1) {
      const only = candidates[0]!;
      return { state: "matched", match: this.save(target, only, hashed ? "hash" : "name", false) };
    }
    return choice(candidates.length ? "uncertain" : "none", candidates);
  }

  /** A search the person typed: only the words typed leave the machine. */
  async search(input: { query: string; episode?: number }, signal?: AbortSignal): Promise<{ candidates: DanmakuCandidate[]; hasMore: boolean }> {
    if (this.deps.credentialSource() === "none") throw new MangaError("CREDENTIAL_UNAVAILABLE", "danmaku needs the application credentials of the DanDanPlay open platform", { details: { reason: "no_credentials" } });
    const found = await this.deps.client.searchEpisodes(input.query, input.episode, signal);
    const candidates: DanmakuCandidate[] = [];
    for (const anime of found.animes) {
      for (const episode of anime.episodes) {
        if (candidates.length >= SEARCH_LIMIT) break;
        candidates.push({ animeId: anime.animeId || null, animeTitle: anime.animeTitle, episodeId: episode.episodeId, episodeTitle: episode.episodeTitle, ...(anime.typeDescription ? { typeDescription: anime.typeDescription } : {}) });
      }
    }
    return { candidates, hasMore: found.hasMore || candidates.length >= SEARCH_LIMIT };
  }

  choose(input: { resourceId: string; resourceRevisionId?: string; episodeId: number; animeId?: number | null; animeTitle: string; episodeTitle: string }): { match: DanmakuMatchInfo } {
    const target = this.target(input.resourceId, input.resourceRevisionId);
    return { match: this.save(target, { animeId: input.animeId ?? null, episodeId: input.episodeId, animeTitle: input.animeTitle, episodeTitle: input.episodeTitle }, "manual", true) };
  }

  setOffset(input: { resourceId: string; resourceRevisionId?: string; offsetMs: number }): { match: DanmakuMatchInfo } {
    const target = this.target(input.resourceId, input.resourceRevisionId);
    if (!this.savedMatch(target.revisionId)) throw new MangaError("NOT_FOUND", "this episode has no danmaku match yet");
    this.store.commit({
      mutations: [{ sql: "UPDATE danmaku_matches SET offset_ms = ? WHERE resource_revision_id = ?", params: [input.offsetMs, target.revisionId] }],
      events: [{ type: "danmaku.offset", payload: { resourceId: input.resourceId, resourceRevisionId: target.revisionId, offsetMs: input.offsetMs } }],
    });
    return { match: matchInfo(this.savedMatch(target.revisionId)!) };
  }

  // ------------------------------------------------------------------ the comments

  async load(input: { resourceId: string; resourceRevisionId?: string; refresh?: boolean }, signal?: AbortSignal): Promise<LoadOutcome> {
    const target = this.target(input.resourceId, input.resourceRevisionId);
    const saved = this.savedMatch(target.revisionId);
    if (!saved) return { state: "no_match" };
    const match = matchInfo(saved);
    const cached = this.cacheRow(saved.episode_id);
    const fresh = cached !== undefined && Date.parse(cached.expires_at) > this.now();
    const view = (row: CacheRow, flags: { fromCache: boolean; stale: boolean; warning: LoadWarning | null }): LoadOutcome => ({
      state: "ok", items: this.readCache(row), count: row.count, fetchedAt: row.fetched_at, expiresAt: row.expires_at, match, attribution: DANMAKU_ATTRIBUTION, ...flags,
    });
    if (cached && fresh && !input.refresh) return view(cached, { fromCache: true, stale: false, warning: null });
    if (cached && input.refresh) {
      const wait = REFRESH_MIN_MS - (this.now() - Date.parse(cached.fetched_at));
      if (wait > 0) throw new MangaError("RATE_LIMITED", "this episode was refreshed a moment ago", { details: { reason: "refresh_too_soon", retryAfterMs: wait } });
    }
    if (this.deps.credentialSource() === "none") {
      // What is already kept can still be shown without credentials; with nothing kept, the reason is the credentials.
      return cached ? view(cached, { fromCache: true, stale: !fresh, warning: { code: "CREDENTIAL_UNAVAILABLE", message: "no application credentials" } }) : { state: "no_credentials" };
    }
    try {
      const { convert } = this.settings();
      const raw = await this.deps.client.comments(saved.episode_id, convert === "simplified" ? 1 : convert === "traditional" ? 2 : 0, signal);
      const items = parseComments(raw);
      const ttl = cacheTtlMs(this.airdateOf(target), this.now());
      const written = this.writeCache(saved.episode_id, items, ttl);
      return { state: "ok", items, count: items.length, fetchedAt: written.fetchedAt, expiresAt: written.expiresAt, fromCache: false, stale: false, warning: null, match, attribution: DANMAKU_ATTRIBUTION };
    } catch (error) {
      // An expired copy is better than nothing when the network or the service lets us down; the reason is handed over beside it.
      if (error instanceof MangaError && error.code !== "CANCELLED" && cached) {
        const retry = error.details.retryAfterMs;
        return view(cached, { fromCache: true, stale: !fresh, warning: { code: error.code, message: error.message, ...(typeof retry === "number" ? { retryAfterMs: retry } : {}) } });
      }
      throw error;
    }
  }
}
