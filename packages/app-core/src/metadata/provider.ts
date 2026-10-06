import type { WorkMediaKind } from "@manga/contracts";
import { BangumiClient, SUBJECT_TYPE, normalizeSubject, type BangumiCharacter, type BangumiPerson, type BangumiSubject, type NormalizedSubject } from "./bangumi.ts";
import type { LocalFields } from "./local-file.ts";

export type SearchHit = {
  providerId: string;
  externalId: string;
  title: string;
  titleOriginal?: string;
  summary?: string;
  date?: string;
  platform?: string;
  subjectType: number;
  kindGuess: WorkMediaKind | null;
  imageUrl?: string;
  sourceUrl: string;
};

export type RelatedItem = { relation: string; externalId: string; title: string; titleOriginal?: string; subjectType: number; imageUrl?: string };
export type EpisodeItem = { ep: number | null; sort: number; type: number; title: string; titleOriginal?: string; airdate?: string };

export type CharacterItem = {
  externalId: string;
  name: string;
  relation: string;
  summary?: string;
  /** Small picture address (`grid`, else `small`); larger sizes are never taken. */
  imageUrl?: string;
  actors: Array<{ externalId: string; name: string }>;
};
export type PersonItem = {
  externalId: string;
  name: string;
  relation: string;
  career: string[];
  /** Episodes or tracks the person took part in, as the source writes them. */
  episodes?: string;
  imageUrl?: string;
};
/** A part that could not be fetched is `null`, so what was saved before stays; an empty list means the source has none. */
export type Credits = { characters: CharacterItem[] | null; persons: PersonItem[] | null; warnings: string[] };

export type SubjectDetail = {
  providerId: string;
  externalId: string;
  namespace: string;
  subjectType: number;
  fields: LocalFields;
  rating: NormalizedSubject["rating"];
  images: NormalizedSubject["images"];
  sourceUrl: string;
  related: RelatedItem[];
  episodes: EpisodeItem[];
  apiVersion: string;
  /** Parts of the answer that could not be fetched (relations, episodes); the rest is still good. */
  warnings: string[];
  /** The medium the entry looks like, to warn when it does not fit the work. */
  kindGuess?: WorkMediaKind | null;
};

/** An online source of work metadata. Bangumi is the first; tests plug in a second one to prove a source can be swapped. */
export interface OnlineProvider {
  readonly id: string;
  readonly displayName: string;
  /** Identity space of the external ids, e.g. `bangumi:subject`. */
  readonly namespace: string;
  search(input: { query: string; kind?: WorkMediaKind; limit: number }, signal?: AbortSignal): Promise<SearchHit[]>;
  detail(externalId: string, signal?: AbortSignal): Promise<SubjectDetail>;
  image(url: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mediaType: string }>;
  pageUrl(externalId: string): string;
  /** One entry by its number, without relations or episodes; used to confirm a pasted number or link. */
  lookup?(externalId: string, signal?: AbortSignal): Promise<SearchHit>;
  /** Characters (with voice actors) and staff of an entry. A source without them leaves this out. */
  credits?(externalId: string, signal?: AbortSignal): Promise<Credits>;
}

export const BANGUMI_PROVIDER_ID = "bangumi";
export const BANGUMI_NAMESPACE = "bangumi:subject";
export const BANGUMI_API_VERSION = "v0";

function kindOf(subject: Pick<BangumiSubject, "type" | "platform">): WorkMediaKind | null {
  if (subject.type === SUBJECT_TYPE.anime) return "video";
  if (subject.type === SUBJECT_TYPE.book) {
    if (/漫画|comic|manga/i.test(subject.platform)) return "comic";
    if (/小说|novel/i.test(subject.platform)) return "novel";
  }
  return null;
}

export class BangumiProvider implements OnlineProvider {
  readonly id = BANGUMI_PROVIDER_ID;
  readonly displayName = "Bangumi 番组计划";
  readonly namespace = BANGUMI_NAMESPACE;

  private readonly client: BangumiClient;
  private readonly pageOrigin: string;

  constructor(client: BangumiClient, pageOrigin = "https://bgm.tv") {
    this.client = client;
    this.pageOrigin = pageOrigin;
  }

  pageUrl(externalId: string): string {
    return `${this.pageOrigin}/subject/${encodeURIComponent(externalId)}`;
  }

  private hitOf(subject: BangumiSubject): SearchHit {
    const normalized = normalizeSubject(subject, this.pageOrigin);
    return {
      providerId: this.id,
      externalId: normalized.externalId,
      title: String(normalized.fields.title ?? subject.name),
      ...(normalized.fields.titleOriginal ? { titleOriginal: String(normalized.fields.titleOriginal) } : {}),
      ...(normalized.fields.summary ? { summary: String(normalized.fields.summary).slice(0, 200) } : {}),
      ...(subject.date ? { date: subject.date } : {}),
      ...(subject.platform ? { platform: subject.platform } : {}),
      subjectType: subject.type,
      kindGuess: kindOf(subject),
      ...(normalized.images.common || normalized.images.medium || normalized.images.small ? { imageUrl: normalized.images.common || normalized.images.medium || normalized.images.small } : {}),
      sourceUrl: normalized.sourceUrl,
    };
  }

  async lookup(externalId: string, signal?: AbortSignal): Promise<SearchHit> {
    return this.hitOf(await this.client.subject(externalId, signal));
  }

  async credits(externalId: string, signal?: AbortSignal): Promise<Credits> {
    const warnings: string[] = [];
    const quiet = async <T>(work: Promise<T>, what: string): Promise<T | null> => {
      try { return await work; } catch (error) {
        if (signal?.aborted) throw error;
        warnings.push(`${what} could not be fetched`);
        return null;
      }
    };
    const [characters, persons] = await Promise.all([quiet(this.client.characters(externalId, signal), "characters"), quiet(this.client.persons(externalId, signal), "staff")]);
    const avatar = (images: { grid?: string; small?: string } | null | undefined) => images?.grid || images?.small || undefined;
    return {
      characters: characters?.map((item: BangumiCharacter): CharacterItem => ({
        externalId: String(item.id), name: item.name, relation: item.relation, ...(item.summary.trim() ? { summary: item.summary.trim().slice(0, 600) } : {}),
        ...(avatar(item.images) ? { imageUrl: avatar(item.images) } : {}),
        actors: item.actors.map((actor) => ({ externalId: String(actor.id), name: actor.name })).slice(0, 8),
      })) ?? null,
      persons: persons?.map((item: BangumiPerson): PersonItem => ({
        externalId: String(item.id), name: item.name, relation: item.relation, career: item.career.slice(0, 8), ...(item.eps.trim() ? { episodes: item.eps.trim().slice(0, 200) } : {}),
        ...(avatar(item.images) ? { imageUrl: avatar(item.images) } : {}),
      })) ?? null,
      warnings,
    };
  }

  async search(input: { query: string; kind?: WorkMediaKind; limit: number }, signal?: AbortSignal): Promise<SearchHit[]> {
    const types = input.kind === "video" ? [SUBJECT_TYPE.anime] : input.kind === "novel" || input.kind === "comic" ? [SUBJECT_TYPE.book] : [SUBJECT_TYPE.anime, SUBJECT_TYPE.book];
    const { subjects } = await this.client.search({ keyword: input.query, types, limit: input.limit }, signal);
    const hits = subjects.map((subject) => this.hitOf(subject));
    // Books come back as one pool; the ones whose platform matches the kind the user is looking for go first.
    if (input.kind === "novel" || input.kind === "comic") return [...hits].sort((a, b) => Number(b.kindGuess === input.kind) - Number(a.kindGuess === input.kind));
    return hits;
  }

  async detail(externalId: string, signal?: AbortSignal): Promise<SubjectDetail> {
    const subject = await this.client.subject(externalId, signal);
    const normalized = normalizeSubject(subject, this.pageOrigin);
    const warnings: string[] = [];
    const [related, episodes] = await Promise.all([
      this.client.related(externalId, signal).catch((error) => { if (signal?.aborted) throw error; warnings.push("related works could not be fetched"); return []; }),
      subject.type === SUBJECT_TYPE.anime
        ? this.client.episodes(externalId, 300, signal).catch((error) => { if (signal?.aborted) throw error; warnings.push("episode titles could not be fetched"); return []; })
        : Promise.resolve([]),
    ]);
    return {
      providerId: this.id,
      externalId: normalized.externalId,
      namespace: this.namespace,
      subjectType: subject.type,
      fields: normalized.fields,
      rating: normalized.rating,
      images: normalized.images,
      sourceUrl: normalized.sourceUrl,
      related: related.map((item) => ({
        relation: item.relation, externalId: String(item.id), title: item.name_cn.trim() || item.name, ...(item.name_cn.trim() && item.name !== item.name_cn ? { titleOriginal: item.name } : {}),
        subjectType: item.type, ...(item.images?.common || item.images?.small ? { imageUrl: item.images.common || item.images.small } : {}),
      })).slice(0, 60),
      episodes: episodes.map((item) => ({
        ep: item.ep ?? null, sort: item.sort, type: item.type, title: item.name_cn.trim() || item.name, ...(item.name_cn.trim() && item.name && item.name !== item.name_cn ? { titleOriginal: item.name } : {}),
        ...(item.airdate ? { airdate: item.airdate } : {}),
      })),
      apiVersion: BANGUMI_API_VERSION,
      warnings,
      kindGuess: kindOf(subject),
    };
  }

  image(url: string, signal?: AbortSignal) {
    return this.client.image(url, signal);
  }
}
