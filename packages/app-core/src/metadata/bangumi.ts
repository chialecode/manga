import net from "node:net";
import { z } from "zod";
import { MangaError } from "@manga/contracts";
import type { components } from "./bangumi-openapi.ts";

/** Bangumi API v0, read only. Types come from the official OpenAPI spec; Zod checks the fields MANGA actually uses at run time. */
export const BANGUMI_API_ORIGIN = "https://api.bgm.tv";
export const BANGUMI_PAGE_ORIGIN = "https://bgm.tv";
/** API and image hosts the client may talk to; anything else, including a redirect target, is refused. */
export const BANGUMI_HOSTS = ["api.bgm.tv", "lain.bgm.tv", "bgm.tv", "bangumi.tv", "api.bangumi.tv", "lain.bangumi.tv"];

export function bangumiUserAgent(version: string): string {
  return `chialecode/manga/${version} (https://github.com/chialecode/manga)`;
}

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; redirect?: "follow" | "manual" | "error" }) => Promise<Response>;

type Subject = components["schemas"]["Subject"];
type Episode = components["schemas"]["Episode"];
type Relation = components["schemas"]["v0_subject_relation"];
type RelatedCharacterSpec = components["schemas"]["RelatedCharacter"];
type RelatedPersonSpec = components["schemas"]["RelatedPerson"];

const ImagesSchema = z.object({
  large: z.string().default(""), common: z.string().default(""), medium: z.string().default(""), small: z.string().default(""), grid: z.string().default(""),
});

const InfoboxSchema = z.array(z.object({
  key: z.string(),
  value: z.union([z.string(), z.array(z.object({ k: z.string().optional(), v: z.string() }))]),
}));

export const BangumiSubjectSchema = z.object({
  id: z.number().int(),
  type: z.number().int(),
  name: z.string(),
  name_cn: z.string().default(""),
  summary: z.string().default(""),
  date: z.string().nullish(),
  platform: z.string().default(""),
  images: ImagesSchema.optional(),
  infobox: InfoboxSchema.nullish(),
  volumes: z.number().default(0),
  eps: z.number().default(0),
  total_episodes: z.number().default(0),
  nsfw: z.boolean().optional(),
  rating: z.object({ score: z.number().default(0), total: z.number().default(0), rank: z.number().default(0) }).partial().optional(),
  tags: z.array(z.object({ name: z.string(), count: z.number().default(0) })).default([]),
});
export type BangumiSubject = z.infer<typeof BangumiSubjectSchema>;

const SearchSchema = z.object({ total: z.number().default(0), limit: z.number().default(0), offset: z.number().default(0), data: z.array(BangumiSubjectSchema) });

const RelationSchema = z.object({
  id: z.number().int(), type: z.number().int(), name: z.string(), name_cn: z.string().default(""),
  images: ImagesSchema.nullish(), relation: z.string(),
});
export type BangumiRelation = z.infer<typeof RelationSchema>;

const EpisodeSchema = z.object({
  id: z.number().int(), type: z.number().int(), name: z.string().default(""), name_cn: z.string().default(""),
  sort: z.number().default(0), ep: z.number().optional(), airdate: z.string().default(""), duration: z.string().default(""),
});
export type BangumiEpisode = z.infer<typeof EpisodeSchema>;
const ActorSchema = z.object({ id: z.number().int(), name: z.string(), images: ImagesSchema.nullish() });
const CharacterSchema = z.object({
  id: z.number().int(), name: z.string(), summary: z.string().default(""), type: z.number().int().default(1),
  images: ImagesSchema.nullish(), relation: z.string().default(""), actors: z.array(ActorSchema).default([]),
});
export type BangumiCharacter = z.infer<typeof CharacterSchema>;
const PersonSchema = z.object({
  id: z.number().int(), name: z.string(), type: z.number().int().default(1), career: z.array(z.string()).default([]),
  images: ImagesSchema.nullish(), relation: z.string().default(""), eps: z.string().default(""),
});
export type BangumiPerson = z.infer<typeof PersonSchema>;

const EpisodesSchema = z.object({ total: z.number().default(0), limit: z.number().default(0), offset: z.number().default(0), data: z.array(EpisodeSchema) });

// The schemas above must accept everything the published spec says the server can send for the fields they name.
type Accepts<Input, Spec extends Input> = Spec;
export type _SubjectCompatible = Accepts<z.input<typeof BangumiSubjectSchema>, Pick<Subject, "id" | "type" | "name" | "name_cn" | "summary" | "platform" | "images" | "volumes" | "eps" | "total_episodes" | "tags">>;
export type _RelationCompatible = Accepts<z.input<typeof RelationSchema>, Pick<Relation, "id" | "type" | "name" | "name_cn" | "relation">>;
export type _CharacterCompatible = Accepts<z.input<typeof CharacterSchema>, Pick<RelatedCharacterSpec, "id" | "name" | "summary" | "type" | "images" | "relation" | "actors">>;
export type _PersonCompatible = Accepts<z.input<typeof PersonSchema>, Pick<RelatedPersonSpec, "id" | "name" | "type" | "career" | "images" | "relation" | "eps">>;
export type _EpisodeCompatible = Accepts<z.input<typeof EpisodeSchema>, Pick<Episode, "id" | "type" | "name" | "name_cn" | "sort" | "airdate" | "duration">>;

export type BangumiOptions = {
  fetch: FetchLike;
  userAgent: string;
  apiOrigin?: string;
  /** Hosts (with port when not 443) the client may reach. Tests add their local fake server here. */
  allowedHosts?: string[];
  /** Access token for restricted content; sent to the API host only, never to image hosts. */
  token?: () => string | undefined;
  maxRetries?: number;
  timeoutMs?: number;
  concurrency?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Largest JSON and image bodies accepted. */
  maxJsonBytes?: number;
  maxImageBytes?: number;
  /** Plain http and private addresses, for a local fake server in tests. Never set in the app. */
  allowHttp?: boolean;
  allowPrivate?: boolean;
};

export const SUBJECT_TYPE = { book: 1, anime: 2, music: 3, game: 4, real: 6 } as const;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MangaError("CANCELLED", "the request was cancelled"));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new MangaError("CANCELLED", "the request was cancelled")); }, { once: true });
  });
}

/** True for loopback, link-local and private-range IP literals and for `localhost`. */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const kind = net.isIP(host);
  if (kind === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (kind === 6) return host === "::1" || host === "::" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("::ffff:");
  return false;
}

function retryAfterMs(header: string | null, attempt: number): number {
  const fallback = 500 * 2 ** attempt;
  if (!header) return fallback;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(30_000, Math.max(0, date - Date.now())) : fallback;
}

export class BangumiClient {
  private readonly origin: string;
  private readonly apiOrigin: string;
  private readonly hosts: Set<string>;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  private readonly concurrency: number;
  /** Requests actually sent, for the real-contract test's own budget. */
  requests = 0;

  private readonly options: BangumiOptions;

  constructor(options: BangumiOptions) {
    this.options = options;
    this.origin = (options.apiOrigin ?? BANGUMI_API_ORIGIN).replace(/\/$/, "");
    this.apiOrigin = new URL(this.origin).origin;
    this.hosts = new Set((options.allowedHosts ?? BANGUMI_HOSTS).map((host) => host.toLowerCase()));
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.concurrency = options.concurrency ?? 2;
  }

  // ------------------------------------------------------------------ transport

  private checkUrl(raw: string): URL {
    let url: URL;
    try { url = new URL(raw); } catch { throw new MangaError("VALIDATION_ERROR", "the address is not a valid URL"); }
    if (url.protocol !== "https:" && !(this.options.allowHttp && url.protocol === "http:")) throw new MangaError("FORBIDDEN", "only https addresses are allowed", { details: { reason: "scheme" } });
    if (!this.hosts.has(url.host.toLowerCase())) throw new MangaError("FORBIDDEN", "that host is not an allowed Bangumi host", { details: { reason: "host_not_allowed", host: url.hostname } });
    if (isPrivateHost(url.hostname) && !this.options.allowPrivate) throw new MangaError("FORBIDDEN", "private addresses are not allowed", { details: { reason: "private_address" } });
    return url;
  }

  private async slot<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => { signal?.removeEventListener("abort", abort); resolve(); };
        const abort = () => { const at = this.waiting.indexOf(wake); if (at >= 0) this.waiting.splice(at, 1); reject(new MangaError("CANCELLED", "the request was cancelled")); };
        this.waiting.push(wake);
        signal?.addEventListener("abort", abort, { once: true });
      });
    }
    this.active += 1;
    try { return await work(); } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }

  private async send(rawUrl: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }, kind: "api" | "image"): Promise<Response> {
    let url = this.checkUrl(rawUrl);
    for (let attempt = 0; ; attempt += 1) {
      init.signal?.throwIfAborted();
      let response: Response | undefined;
      for (let hop = 0; hop < 4; hop += 1) {
        const headers: Record<string, string> = { "user-agent": this.options.userAgent, accept: kind === "api" ? "application/json" : "image/*", ...init.headers };
        const token = this.options.token?.();
        // Only the API origin gets the token, also after a redirect to another allowed host (an image host, say).
        if (kind === "api" && token && url.origin === this.apiOrigin) headers.authorization = `Bearer ${token}`;
        const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
        this.requests += 1;
        try {
          response = await this.options.fetch(url.toString(), { method: init.method ?? "GET", headers, body: init.body, signal, redirect: "manual" });
        } catch (error) {
          if (init.signal?.aborted) throw new MangaError("CANCELLED", "the request was cancelled");
          const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
          throw new MangaError("PROVIDER_UNAVAILABLE", timedOut ? "Bangumi did not answer in time" : "Bangumi cannot be reached from this network", { retryable: true, details: { reason: timedOut ? "timeout" : "network" }, cause: error });
        }
        if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
          const target = new URL(response.headers.get("location")!, url);
          // A redirect may only lead to another allowed host: never to a private address or an unlisted site.
          try { url = this.checkUrl(target.toString()); } catch (error) {
            await response.body?.cancel().catch(() => undefined);
            throw new MangaError("FORBIDDEN", "the server redirected to an address that is not allowed", { details: { reason: "redirect_blocked" }, cause: error });
          }
          await response.body?.cancel().catch(() => undefined);
          response = undefined;
          continue;
        }
        break;
      }
      if (!response) throw new MangaError("PROVIDER_UNAVAILABLE", "too many redirects", { details: { reason: "redirect_loop" } });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => undefined);
        throw new MangaError("AUTHENTICATION_FAILED", "Bangumi refused the request; check the access token or leave it empty", { details: { status: response.status } });
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        throw new MangaError("NOT_FOUND", "Bangumi has no such entry", { details: { status: 404 } });
      }
      if (response.status === 429 || response.status >= 500) {
        const wait = retryAfterMs(response.headers.get("retry-after"), attempt);
        await response.body?.cancel().catch(() => undefined);
        if (attempt >= this.maxRetries) {
          throw new MangaError(response.status === 429 ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE", response.status === 429 ? "Bangumi asks to slow down; try again later" : `Bangumi answered with ${response.status}`, { retryable: true, details: { status: response.status, retryAfterMs: wait } });
        }
        await this.sleep(wait, init.signal);
        url = this.checkUrl(rawUrl);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new MangaError("PROVIDER_UNAVAILABLE", `Bangumi answered with ${response.status}`, { details: { status: response.status, reason: "http" } });
      }
      return response;
    }
  }

  private async readBody(response: Response, limit: number): Promise<Buffer> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel().catch(() => undefined); throw new MangaError("PROVIDER_UNAVAILABLE", "the response is larger than allowed", { details: { reason: "too_large" } }); }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) { await reader.cancel().catch(() => undefined); throw new MangaError("PROVIDER_UNAVAILABLE", "the response is larger than allowed", { details: { reason: "too_large" } }); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  }

  private async json<T>(path: string, schema: z.ZodType<T>, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    return this.slot(async () => {
      const response = await this.send(`${this.origin}${path}`, {
        method: init.method,
        headers: init.body === undefined ? undefined : { "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init.signal,
      }, "api");
      const raw = await this.readBody(response, this.options.maxJsonBytes ?? 4 * 1024 * 1024);
      let parsed: unknown;
      try { parsed = JSON.parse(raw.toString("utf8")); } catch { throw new MangaError("PROVIDER_UNAVAILABLE", "Bangumi sent something that is not JSON", { details: { reason: "schema" } }); }
      const checked = schema.safeParse(parsed);
      if (!checked.success) throw new MangaError("PROVIDER_UNAVAILABLE", "Bangumi's answer does not have the expected shape", { details: { reason: "schema", issues: checked.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) } });
      return checked.data;
    }, init.signal);
  }

  // ------------------------------------------------------------------ API

  /** `POST /v0/search/subjects`, an experimental endpoint: a shape change shows up as a `schema` failure, not as wrong data. */
  async search(input: { keyword: string; types?: number[]; limit?: number; offset?: number }, signal?: AbortSignal): Promise<{ total: number; subjects: BangumiSubject[] }> {
    const query = `?limit=${Math.min(25, Math.max(1, input.limit ?? 10))}&offset=${Math.max(0, input.offset ?? 0)}`;
    const body: { keyword: string; filter?: { type?: number[] } } = { keyword: input.keyword };
    if (input.types?.length) body.filter = { type: input.types };
    const result = await this.json(`/v0/search/subjects${query}`, SearchSchema, { method: "POST", body, signal });
    return { total: result.total, subjects: result.data };
  }

  subject(id: number | string, signal?: AbortSignal): Promise<BangumiSubject> {
    return this.json(`/v0/subjects/${encodeURIComponent(String(id))}`, BangumiSubjectSchema, { signal });
  }

  related(id: number | string, signal?: AbortSignal): Promise<BangumiRelation[]> {
    return this.json(`/v0/subjects/${encodeURIComponent(String(id))}/subjects`, z.array(RelationSchema), { signal });
  }

  /** `GET /v0/subjects/{id}/characters`: the entry's characters with their relation and voice actors. */
  characters(id: number | string, signal?: AbortSignal): Promise<BangumiCharacter[]> {
    return this.json(`/v0/subjects/${encodeURIComponent(String(id))}/characters`, z.array(CharacterSchema), { signal });
  }

  /** `GET /v0/subjects/{id}/persons`: the entry's staff with their relation, careers and the episodes they took part in. */
  persons(id: number | string, signal?: AbortSignal): Promise<BangumiPerson[]> {
    return this.json(`/v0/subjects/${encodeURIComponent(String(id))}/persons`, z.array(PersonSchema), { signal });
  }

  /** Main episodes (type 0) and specials, up to `max`; long series arrive in pages of 100. */
  async episodes(id: number | string, max = 300, signal?: AbortSignal): Promise<BangumiEpisode[]> {
    const all: BangumiEpisode[] = [];
    for (let offset = 0; all.length < max; offset += 100) {
      const page = await this.json(`/v0/episodes?subject_id=${encodeURIComponent(String(id))}&limit=100&offset=${offset}`, EpisodesSchema, { signal });
      all.push(...page.data);
      if (offset + page.data.length >= page.total || !page.data.length) break;
    }
    return all.slice(0, max);
  }

  /** An image from an allowed image host. The token is never sent here. */
  image(url: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mediaType: string }> {
    return this.slot(async () => {
      const response = await this.send(url, { signal }, "image");
      const mediaType = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(mediaType)) {
        await response.body?.cancel().catch(() => undefined);
        throw new MangaError("UNSUPPORTED_FORMAT", "the address did not return a picture", { details: { reason: "not_image" } });
      }
      return { bytes: await this.readBody(response, this.options.maxImageBytes ?? 12 * 1024 * 1024), mediaType };
    }, signal);
  }
}

// ------------------------------------------------------------------ normalisation

export type NormalizedSubject = {
  externalId: string;
  type: number;
  fields: Partial<Record<"title" | "titleOriginal" | "author" | "studio" | "summary" | "releaseDate" | "platform" | "episodeCount" | "volumeCount" | "tags", string | number | string[]>>;
  rating: { score: number; total: number; rank: number | null; scale: "bangumi-10" } | null;
  images: { large: string; common: string; medium: string; small: string; grid: string };
  sourceUrl: string;
};

function infoboxValues(box: BangumiSubject["infobox"], keys: string[]): string[] {
  if (!box) return [];
  const found: string[] = [];
  for (const key of keys) {
    for (const item of box) {
      if (item.key !== key) continue;
      if (typeof item.value === "string") found.push(item.value.trim());
      else for (const entry of item.value) found.push(entry.v.trim());
    }
    if (found.length) break;
  }
  return found.filter(Boolean);
}

export function normalizeSubject(subject: BangumiSubject, pageOrigin = BANGUMI_PAGE_ORIGIN): NormalizedSubject {
  const fields: NormalizedSubject["fields"] = {};
  const cn = subject.name_cn.trim();
  const original = subject.name.trim();
  fields.title = cn || original;
  if (original && original !== fields.title) fields.titleOriginal = original;
  const authors = infoboxValues(subject.infobox, subject.type === 1 ? ["作者", "作画", "原作"] : ["原作", "导演", "监督"]);
  if (authors.length) fields.author = authors.slice(0, 4).join(" / ").slice(0, 256);
  const studios = infoboxValues(subject.infobox, subject.type === 1 ? ["出版社", "连载杂志"] : ["动画制作", "制作"]);
  if (studios.length) fields.studio = studios.slice(0, 3).join(" / ").slice(0, 256);
  if (subject.summary.trim()) fields.summary = subject.summary.replace(/\r\n/g, "\n").trim().slice(0, 4000);
  if (subject.date) fields.releaseDate = subject.date;
  if (subject.platform) fields.platform = subject.platform;
  const episodes = subject.eps || subject.total_episodes;
  if (episodes > 0) fields.episodeCount = episodes;
  if (subject.volumes > 0) fields.volumeCount = subject.volumes;
  const tags = [...subject.tags].sort((a, b) => b.count - a.count).slice(0, 12).map((tag) => tag.name).filter(Boolean);
  if (tags.length) fields.tags = tags;
  const images = subject.images ?? { large: "", common: "", medium: "", small: "", grid: "" };
  const score = subject.rating?.score ?? 0;
  const total = subject.rating?.total ?? 0;
  return {
    externalId: String(subject.id),
    type: subject.type,
    fields,
    rating: total > 0 || score > 0 ? { score, total, rank: subject.rating?.rank ? subject.rating.rank : null, scale: "bangumi-10" } : null,
    images,
    sourceUrl: `${pageOrigin}/subject/${subject.id}`,
  };
}
