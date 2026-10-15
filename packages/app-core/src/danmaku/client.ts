import { z } from "zod";
import { MangaError } from "@manga/contracts";
import { dandanHeaders, type DandanCredentials } from "./sign.ts";

export const DANDAN_API_ORIGIN = "https://api.dandanplay.net";
/** Domains a redirect may lead to. Anything else, and any plain-http address, is refused. */
export const DANDAN_REDIRECT_DOMAINS = ["dandanplay.net", "dandanplay.com", "dandanplay.cn"];

export type DandanFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: "follow" | "manual" | "error" }) => Promise<Response>;

export type DandanClientOptions = {
  fetch: DandanFetch;
  /** Read for every request, so a change of credentials in the settings applies at once. `null` means there are none: no request is sent. */
  credentials: () => DandanCredentials | null;
  userAgent: string;
  origin?: string;
  timeoutMs?: number;
  maxBytes?: number;
  now?: () => number;
  /** Hosts a redirect may reach besides the DanDanPlay domains; tests name their local server here. */
  extraRedirectHosts?: string[];
  /** Plain http for a local fake server in tests. Never set in the app. */
  allowHttp?: boolean;
};

const MatchSchema = z.object({
  success: z.boolean().default(true),
  errorCode: z.number().default(0),
  errorMessage: z.string().nullish(),
  isMatched: z.boolean().default(false),
  matches: z.array(z.object({
    episodeId: z.number().int(),
    animeId: z.number().int().default(0),
    animeTitle: z.string().default(""),
    episodeTitle: z.string().default(""),
    type: z.string().optional(),
    typeDescription: z.string().optional(),
    shift: z.number().optional(),
  })).default([]),
});
export type DandanMatch = z.infer<typeof MatchSchema>;

const SearchSchema = z.object({
  success: z.boolean().default(true),
  errorCode: z.number().default(0),
  errorMessage: z.string().nullish(),
  hasMore: z.boolean().default(false),
  animes: z.array(z.object({
    animeId: z.number().int().default(0),
    animeTitle: z.string().default(""),
    type: z.string().optional(),
    typeDescription: z.string().optional(),
    episodes: z.array(z.object({ episodeId: z.number().int(), episodeTitle: z.string().default("") })).default([]),
  })).default([]),
});
export type DandanSearch = z.infer<typeof SearchSchema>;

const BangumiSchema = z.object({
  success: z.boolean().default(true),
  errorCode: z.number().default(0),
  errorMessage: z.string().nullish(),
  bangumi: z.object({
    animeId: z.number().int().default(0),
    animeTitle: z.string().default(""),
    episodes: z.array(z.object({
      episodeId: z.number().int(),
      episodeTitle: z.string().default(""),
      episodeNumber: z.union([z.string(), z.number()]).nullish(),
    })).default([]),
  }).nullish(),
});
export type DandanBangumi = z.infer<typeof BangumiSchema>;

const CommentsSchema = z.object({
  count: z.number().default(0),
  comments: z.array(z.object({ cid: z.number().optional(), p: z.string(), m: z.string() })).default([]),
});
export type DandanComments = z.infer<typeof CommentsSchema>;

const DEFAULT_RETRY_AFTER_MS = 60_000;
const MAX_RETRY_AFTER_MS = 15 * 60_000;

function retryAfterMs(header: string | null, now: number): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, seconds * 1000));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, date - now)) : DEFAULT_RETRY_AFTER_MS;
}

/** A host name that equals one of the domains or is a sub-domain of it. */
const underDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/**
 * The DanDanPlay open API (v2), read side only: match a file, search episodes, map a Bangumi entry, fetch the comments of an episode.
 * Every call is signed here (the credentials never leave the main process), goes out only when there are credentials, and is never repeated by
 * the client: a 429 starts a pause during which later calls fail at once without reaching the network.
 */
export class DandanClient {
  private readonly options: DandanClientOptions;
  private readonly origin: URL;
  private blockedUntil = 0;
  /** Requests actually sent, for tests and for the budget of the real-contract check. */
  requests = 0;

  constructor(options: DandanClientOptions) {
    this.options = options;
    this.origin = new URL(options.origin ?? DANDAN_API_ORIGIN);
  }

  private now(): number { return (this.options.now ?? Date.now)(); }

  /** Milliseconds until a paused client may send again; 0 when it may. */
  pausedForMs(): number { return Math.max(0, this.blockedUntil - this.now()); }

  private redirectAllowed(url: URL): boolean {
    if (url.protocol !== "https:" && !(this.options.allowHttp && url.protocol === "http:")) return false;
    const host = url.hostname.toLowerCase();
    if (DANDAN_REDIRECT_DOMAINS.some((domain) => underDomain(host, domain))) return true;
    return (this.options.extraRedirectHosts ?? []).some((allowed) => allowed.toLowerCase() === url.host.toLowerCase());
  }

  private async call<T>(method: "GET" | "POST", path: string, query: Record<string, string | number | boolean | undefined>, body: unknown, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const credentials = this.options.credentials();
    if (!credentials) throw new MangaError("CREDENTIAL_UNAVAILABLE", "danmaku needs the application credentials of the DanDanPlay open platform", { details: { reason: "no_credentials" } });
    const paused = this.pausedForMs();
    if (paused > 0) throw new MangaError("RATE_LIMITED", "the danmaku service asked for a pause", { retryable: false, details: { reason: "backoff", retryAfterMs: paused } });
    if (this.origin.protocol !== "https:" && !this.options.allowHttp) throw new MangaError("FORBIDDEN", "only https addresses are allowed", { details: { reason: "scheme" } });

    const url = new URL(path, this.origin);
    for (const [name, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(name, String(value));
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let target = url;
    let response: Response | undefined;
    for (let hop = 0; hop < 4; hop += 1) {
      combined.throwIfAborted();
      // Only the first request carries the signature; a redirect target is another server and learns nothing about the application.
      const headers: Record<string, string> = {
        "user-agent": this.options.userAgent,
        accept: "application/json",
        ...(hop === 0 ? dandanHeaders(credentials, Math.floor(this.now() / 1000), path) : {}),
        ...(hop === 0 && body !== undefined ? { "content-type": "application/json" } : {}),
      };
      this.requests += 1;
      try {
        response = await this.options.fetch(target.toString(), { method: hop === 0 ? method : "GET", headers, ...(hop === 0 && body !== undefined ? { body: JSON.stringify(body) } : {}), signal: combined, redirect: "manual" });
      } catch (error) {
        if (signal?.aborted) throw new MangaError("CANCELLED", "the request was cancelled");
        const timedOut = timeout.aborted;
        throw new MangaError("PROVIDER_UNAVAILABLE", timedOut ? "the danmaku service did not answer in time" : "the danmaku service could not be reached", { retryable: true, details: { reason: "network" }, cause: error });
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      void response.body?.cancel().catch(() => undefined);
      if (method !== "GET") throw new MangaError("FORBIDDEN", "the service redirected a request that carries data", { details: { reason: "redirect_refused" } });
      const location = response.headers.get("location");
      let next: URL | null = null;
      try { next = location ? new URL(location, target) : null; } catch { next = null; }
      if (!next || !this.redirectAllowed(next)) throw new MangaError("FORBIDDEN", "the service redirected to an address that is not a DanDanPlay domain", { details: { reason: "redirect_refused" } });
      target = next;
      response = undefined;
    }
    if (!response) throw new MangaError("PROVIDER_UNAVAILABLE", "the service redirected too many times", { details: { reason: "bad_response" } });

    if (response.status === 403) {
      const reason = (response.headers.get("x-error-message") ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 200);
      void response.body?.cancel().catch(() => undefined);
      throw new MangaError("AUTHENTICATION_FAILED", reason || "the danmaku service refused the request", { details: { reason: "forbidden", serverMessage: reason || null } });
    }
    if (response.status === 429) {
      const wait = retryAfterMs(response.headers.get("retry-after"), this.now());
      this.blockedUntil = this.now() + wait;
      void response.body?.cancel().catch(() => undefined);
      throw new MangaError("RATE_LIMITED", "the danmaku service is busy; try again later", { retryable: false, details: { reason: "rate_limited", retryAfterMs: wait } });
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new MangaError("PROVIDER_UNAVAILABLE", `the danmaku service answered ${response.status}`, { retryable: response.status >= 500, details: { reason: "bad_response", status: response.status } });
    }
    const limit = this.options.maxBytes ?? 32 * 1024 * 1024;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new MangaError("PROVIDER_UNAVAILABLE", "the danmaku service sent too much", { details: { reason: "bad_response" } });
    let json: unknown;
    try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new MangaError("PROVIDER_UNAVAILABLE", "the danmaku service sent something that is not JSON", { details: { reason: "bad_response" } }); }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new MangaError("PROVIDER_UNAVAILABLE", "the danmaku service sent an answer in an unknown shape", { details: { reason: "bad_response" } });
    const answer = parsed.data as { success?: boolean; errorMessage?: string | null };
    if (answer.success === false) throw new MangaError("PROVIDER_UNAVAILABLE", answer.errorMessage?.trim().slice(0, 200) || "the danmaku service could not answer", { details: { reason: "rejected" } });
    return parsed.data;
  }

  /** Match a file by its name and fingerprint: `fileHash` is the MD5 of the first 16 MiB, `videoDuration` is in seconds. */
  match(input: { fileName: string; fileHash: string; fileSize: number; videoDurationSec: number; mode?: "hashAndFileName" | "fileNameOnly" | "hashOnly" }, signal?: AbortSignal): Promise<DandanMatch> {
    return this.call("POST", "/api/v2/match", {}, {
      fileName: input.fileName,
      fileHash: input.fileHash,
      fileSize: input.fileSize,
      videoDuration: input.videoDurationSec,
      matchMode: input.mode ?? "hashAndFileName",
    }, MatchSchema, signal);
  }

  searchEpisodes(anime: string, episode: number | undefined, signal?: AbortSignal): Promise<DandanSearch> {
    return this.call("GET", "/api/v2/search/episodes", { anime, episode }, undefined, SearchSchema, signal);
  }

  /** The DanDanPlay show that a Bangumi subject maps to, with its episodes. */
  bangumiSubject(subjectId: number, signal?: AbortSignal): Promise<DandanBangumi> {
    return this.call("GET", `/api/v2/bangumi/bgmtv/${subjectId}`, {}, undefined, BangumiSchema, signal);
  }

  /** The comments of one episode. `convert` is the network's own conversion: 0 none, 1 simplified, 2 traditional. */
  comments(episodeId: number, convert: 0 | 1 | 2, signal?: AbortSignal): Promise<DandanComments> {
    return this.call("GET", `/api/v2/comment/${episodeId}`, { withRelated: true, chConvert: convert }, undefined, CommentsSchema, signal);
  }
}
