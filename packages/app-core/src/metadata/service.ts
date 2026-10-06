import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { METADATA_FIELD_KEYS, MangaError, createId, type CommandEnvelope, type MetadataFieldKey, type MetadataFieldValue, type WorkMediaKind } from "@manga/contracts";
import type { DrizzleStore, Mutation } from "@manga/storage-drizzle";
import { parseProjection, projectionMutation, readOverride, type SnapshotPatch } from "../works-service.ts";
import { projectedValue, type FieldOverride, type ProjectedField, type ProjectionSourceId } from "../domain/metadata-projection.ts";
import type { MediaServices } from "../media/services.ts";
import type { CoverService } from "./covers.ts";
import type { Credits, EpisodeItem, OnlineProvider, RelatedItem, SearchHit, SubjectDetail } from "./provider.ts";
import { REF_FAILURE_MESSAGES, parseBangumiRef } from "./ref.ts";
import { LOCAL_PROVIDER, type ResourceExtras } from "./extras.ts";
import type { LocalFields } from "./local-file.ts";

export const METADATA_MODULE = "manga.metadata";
const SETTINGS_KEY = "metadata.providers";
const IMAGE_TTL_MS = 6 * 60 * 60_000;
const SIMILAR_LIMIT = 8;
/** Pictures taken per entry (characters first, then staff), and rows kept per list, so one link stays a bounded number of requests. */
export const MAX_AVATARS = 20;
const MAX_CREDIT_ROWS = 100;
const MAX_AVATAR_BYTES = 1024 * 1024;
const AVATAR_PARALLEL = 4;
/** An entry fetched for a preview is kept this long, so applying exactly what the user looked at does not ask the source again. */
const PREVIEW_TTL_MS = 2 * 60_000;

export type ProviderSettings = Record<string, { enabled: boolean; credentialRef?: string; updatedAt?: string }>;

export type StoredSnapshot = {
  version: 1;
  fields: LocalFields;
  rating: SubjectDetail["rating"];
  images: SubjectDetail["images"];
  related: RelatedItem[];
  episodes: EpisodeItem[];
  sourceUrl: string;
  apiVersion: string;
  subjectType: number;
};

/** What the renderer sees of a hit: the remote picture address stays in the main process, which fetches the picture itself. */
export type PublicHit = Omit<SearchHit, "imageUrl">;
const publicHit = (hit: SearchHit): PublicHit => {
  const { imageUrl: _imageUrl, ...rest } = hit;
  return rest;
};

export type CandidateView = PublicHit & { id: string; searchId: string | null; state: string; image: { url: string; mediaType: string } | null; linkedElsewhere: string | null };

export type SearchOutcome = {
  searchId: string;
  query: string;
  kind: WorkMediaKind | null;
  mode: "single" | "fallback" | "multi";
  results: CandidateView[];
  failures: Array<{ providerId: string; code: string; message: string; retryable: boolean }>;
  partial: boolean;
  searchedAt: string;
};

type CandidateRow = { id: string; work_id: string | null; provider_id: string; payload_json: string; external_id: string | null; search_id: string | null; state: string; created_at: string | null };
type LinkRow = { work_id: string; provider_id: string; external_id: string; namespace: string; subject_type: number | null; link_state: string; match_basis: string | null; confirmed_at: string };

export type MetadataDeps = {
  store: DrizzleStore;
  media: MediaServices;
  covers: CoverService;
  extras: ResourceExtras;
  providers: () => OnlineProvider[];
  /** Plain credentials are kept by the host; the service only learns whether one exists. */
  credentials: { remove(ref: string): void };
  notify: (topic: string, payload: Record<string, unknown>) => void;
};

const failureOf = (providerId: string, error: unknown) => {
  if (error instanceof MangaError) return { providerId, code: error.code, message: error.message, retryable: error.retryable };
  return { providerId, code: "PROVIDER_UNAVAILABLE", message: error instanceof Error ? error.message : "the source failed", retryable: true };
};

function snapshotOf(detail: SubjectDetail): StoredSnapshot {
  return { version: 1, fields: detail.fields, rating: detail.rating, images: detail.images, related: detail.related, episodes: detail.episodes, sourceUrl: detail.sourceUrl, apiVersion: detail.apiVersion, subjectType: detail.subjectType };
}

export class MetadataService {
  private readonly deps: MetadataDeps;
  private readonly previews = new Map<string, { detail: SubjectDetail; at: number }>();

  constructor(deps: MetadataDeps) {
    this.deps = deps;
  }

  private get store() { return this.deps.store; }

  // ------------------------------------------------------------------ providers

  settings(): ProviderSettings {
    const raw = this.store.getMeta(SETTINGS_KEY);
    if (!raw) return {};
    try { return JSON.parse(raw) as ProviderSettings; } catch { return {}; }
  }

  private writeSettings(next: ProviderSettings): void {
    this.store.setMeta(SETTINGS_KEY, JSON.stringify(next));
  }

  isEnabled(providerId: string): boolean {
    return this.settings()[providerId]?.enabled !== false;
  }

  credentialRef(providerId: string): string | undefined {
    return this.settings()[providerId]?.credentialRef;
  }

  providers() {
    const settings = this.settings();
    const online = this.deps.providers().map((provider) => ({
      id: provider.id, displayName: provider.displayName, kind: "online" as const, namespace: provider.namespace,
      enabled: settings[provider.id]?.enabled !== false, credentialConfigured: Boolean(settings[provider.id]?.credentialRef),
    }));
    return { providers: [...online, { id: LOCAL_PROVIDER, displayName: "文件内置资料", kind: "local" as const, namespace: "local-file", enabled: true, credentialConfigured: false }] };
  }

  setProviderState(input: { providerId: string; enabled: boolean; credentialRef?: string | null }): Record<string, unknown> {
    if (!this.deps.providers().some((provider) => provider.id === input.providerId)) throw new MangaError("NOT_FOUND", "no such provider");
    const settings = this.settings();
    const previous = settings[input.providerId];
    const next = { enabled: input.enabled, ...(previous?.credentialRef ? { credentialRef: previous.credentialRef } : {}), updatedAt: new Date().toISOString() };
    if (input.credentialRef === null) {
      if (previous?.credentialRef) this.deps.credentials.remove(previous.credentialRef);
      delete (next as { credentialRef?: string }).credentialRef;
    } else if (input.credentialRef) {
      if (previous?.credentialRef) this.deps.credentials.remove(previous.credentialRef);
      (next as { credentialRef?: string }).credentialRef = input.credentialRef;
    }
    settings[input.providerId] = next;
    this.writeSettings(settings);
    return { providerId: input.providerId, enabled: next.enabled, credentialConfigured: Boolean(next.credentialRef) };
  }

  private provider(providerId: string): OnlineProvider {
    const provider = this.deps.providers().find((item) => item.id === providerId);
    if (!provider) throw new MangaError("NOT_FOUND", "no such provider");
    if (!this.isEnabled(providerId)) throw new MangaError("CAPABILITY_UNAVAILABLE", `${provider.displayName} is turned off in settings`);
    return provider;
  }

  // ------------------------------------------------------------------ images

  private thumbDir(): string {
    return this.deps.media.dir("metadata", "thumbs");
  }

  /** A candidate's small picture, downloaded by the main process and kept in the cache. The renderer never fetches remote pictures itself. */
  private async candidateImage(provider: OnlineProvider, url: string | undefined, signal?: AbortSignal): Promise<{ name: string; mediaType: string } | null> {
    if (!url) return null;
    const key = createHash("sha1").update(`${provider.id}|${url}`).digest("hex");
    const known = fs.readdirSync(this.thumbDir()).find((name) => name.startsWith(`${key}.`));
    if (known) return { name: known, mediaType: known.endsWith(".png") ? "image/png" : known.endsWith(".webp") ? "image/webp" : known.endsWith(".gif") ? "image/gif" : "image/jpeg" };
    try {
      const image = await provider.image(url, signal);
      const ext = image.mediaType === "image/png" ? "png" : image.mediaType === "image/webp" ? "webp" : image.mediaType === "image/gif" ? "gif" : "jpg";
      const name = `${key}.${ext}`;
      const target = path.join(this.thumbDir(), name);
      fs.writeFileSync(`${target}.tmp`, image.bytes);
      fs.renameSync(`${target}.tmp`, target);
      return { name, mediaType: image.mediaType };
    } catch (error) {
      if (signal?.aborted) throw new MangaError("CANCELLED", "the search was cancelled");
      return null;
    }
  }

  private imageHandle(image: { name: string; mediaType: string } | null, sessionId?: string): { url: string; mediaType: string } | null {
    if (!image) return null;
    const file = path.join(this.thumbDir(), image.name);
    if (!fs.existsSync(file)) return null;
    const issued = this.deps.media.handles.issue({ kind: "file", path: file, mediaType: image.mediaType }, { moduleId: METADATA_MODULE, sessionId }, { ttlMs: IMAGE_TTL_MS });
    return { url: issued.url, mediaType: image.mediaType };
  }

  // ------------------------------------------------------------------ search

  private linkedElsewhere(providerId: string, externalId: string, exceptWorkId?: string): string | null {
    const row = this.store.sqlite.prepare("SELECT work_id FROM work_links WHERE provider_id = ? AND external_id = ? AND link_state = 'linked' AND work_id <> ? LIMIT 1").get(providerId, externalId, exceptWorkId ?? "") as { work_id: string } | undefined;
    return row?.work_id ?? null;
  }

  async search(input: { workId?: string; query: string; kind?: WorkMediaKind; providerIds?: string[]; mode?: "single" | "fallback" | "multi"; limit?: number }, signal?: AbortSignal, sessionId?: string): Promise<SearchOutcome> {
    const query = input.query.trim();
    if (!query) throw new MangaError("VALIDATION_ERROR", "the search text is empty");
    let kind = input.kind ?? null;
    if (input.workId) {
      const work = this.store.sqlite.prepare("SELECT media_kind FROM works WHERE id = ?").get(input.workId) as { media_kind: WorkMediaKind } | undefined;
      if (!work) throw new MangaError("NOT_FOUND", "work missing");
      kind ??= work.media_kind;
    }
    const mode = input.mode ?? "multi";
    const limit = Math.min(25, Math.max(1, input.limit ?? 10));
    const enabled = this.deps.providers().filter((provider) => this.isEnabled(provider.id) && (!input.providerIds?.length || input.providerIds.includes(provider.id)));
    if (!enabled.length) throw new MangaError("CAPABILITY_UNAVAILABLE", "no online metadata source is turned on");
    const searchId = createId("srch");
    const failures: SearchOutcome["failures"] = [];
    const gathered: Array<{ provider: OnlineProvider; hits: SearchHit[] }> = [];
    const attempt = async (provider: OnlineProvider) => {
      try { gathered.push({ provider, hits: await provider.search({ query, kind: kind ?? undefined, limit }, signal) }); return true; } catch (error) {
        if (signal?.aborted) throw new MangaError("CANCELLED", "the search was cancelled");
        failures.push(failureOf(provider.id, error));
        return false;
      }
    };
    if (mode === "multi") await Promise.all(enabled.map(attempt));
    else if (mode === "single") await attempt(enabled[0]!);
    else {
      // Fallback: the next source is asked only when the one before failed or found nothing.
      for (const provider of enabled) {
        const ok = await attempt(provider);
        if (ok && gathered[gathered.length - 1]!.hits.length) break;
      }
    }
    const now = new Date().toISOString();
    const results: CandidateView[] = [];
    const mutations: Mutation[] = [];
    // Candidates of an earlier search for the same work stay open until one is chosen; a new search replaces them.
    if (input.workId) mutations.push({ sql: "DELETE FROM metadata_candidates WHERE work_id = ? AND state = 'open'", params: [input.workId] });
    const ordered = enabled.flatMap((provider) => gathered.filter((entry) => entry.provider.id === provider.id));
    for (const { provider, hits } of ordered) {
      for (const hit of hits) {
        const image = await this.candidateImage(provider, hit.imageUrl, signal);
        const candidateId = createId("cand");
        results.push({ ...publicHit(hit), id: candidateId, searchId, state: "open", image: this.imageHandle(image, sessionId), linkedElsewhere: this.linkedElsewhere(provider.id, hit.externalId, input.workId) });
        if (input.workId) {
          mutations.push({
            sql: "INSERT INTO metadata_candidates(id, work_id, provider_id, payload_json, external_id, search_id, state, created_at) VALUES (?,?,?,?,?,?,?,?)",
            params: [candidateId, input.workId, provider.id, JSON.stringify({ hit, image }), hit.externalId, searchId, "open", now],
          });
        }
      }
    }
    if (mutations.length) this.store.commit({ mutations, events: [] });
    return { searchId, query, kind, mode, results, failures, partial: failures.length > 0 && results.length > 0, searchedAt: now };
  }

  candidates(workId: string, sessionId?: string): { workId: string; candidates: CandidateView[] } {
    const rows = this.store.sqlite.prepare("SELECT * FROM metadata_candidates WHERE work_id = ? AND state = 'open' ORDER BY created_at DESC, rowid ASC").all(workId) as CandidateRow[];
    const out: CandidateView[] = [];
    for (const row of rows) {
      try {
        const payload = JSON.parse(row.payload_json) as { hit: SearchHit; image?: { name: string; mediaType: string } | null };
        out.push({ ...publicHit(payload.hit), id: row.id, searchId: row.search_id, state: row.state, image: this.imageHandle(payload.image ?? null, sessionId), linkedElsewhere: this.linkedElsewhere(row.provider_id, payload.hit.externalId, workId) });
      } catch { /* an unreadable candidate is skipped */ }
    }
    return { workId, candidates: out };
  }

  // ------------------------------------------------------------------ link, unlink, refresh

  private writeSnapshotMutations(workId: string, provider: OnlineProvider, detail: SubjectDetail, now: string, matchBasis: string, keep: KeepOverride | null = null): Mutation[] {
    const snapshot = JSON.stringify(snapshotOf(detail));
    const patch: Record<string, SnapshotPatch> = { [provider.id]: { fields: detail.fields as SnapshotPatch["fields"], fetchedAt: now, detached: false, linkState: "linked" } };
    return [
      { sql: "UPDATE work_links SET link_state = 'unlinked' WHERE work_id = ? AND provider_id = ? AND external_id <> ? AND link_state = 'linked'", params: [workId, provider.id, detail.externalId] },
      {
        sql: `INSERT INTO work_links(work_id, provider_id, external_id, snapshot_json, confirmed_at, namespace, subject_type, link_state, match_basis) VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(work_id, provider_id, external_id) DO UPDATE SET snapshot_json = excluded.snapshot_json, confirmed_at = excluded.confirmed_at, namespace = excluded.namespace, subject_type = excluded.subject_type, link_state = 'linked', match_basis = excluded.match_basis`,
        params: [workId, provider.id, detail.externalId, JSON.stringify({ title: detail.fields.title ?? null }), now, provider.namespace, detail.subjectType, "linked", matchBasis],
      },
      {
        sql: `INSERT INTO metadata_snapshots(work_id, provider_id, external_id, snapshot_json, fetched_at, source_url, api_version, detached) VALUES (?,?,?,?,?,?,?,0)
          ON CONFLICT(work_id, provider_id) DO UPDATE SET external_id = excluded.external_id, snapshot_json = excluded.snapshot_json, fetched_at = excluded.fetched_at, source_url = excluded.source_url, api_version = excluded.api_version, detached = 0`,
        params: [workId, provider.id, detail.externalId, snapshot, now, detail.sourceUrl, detail.apiVersion],
      },
      ...(keep ? [keep.mutation] : []),
      projectionMutation(this.store, workId, now, patch, keep?.override),
    ];
  }

  /**
   * What the user chose to keep in the preview, as an override that leaves those fields as they are now: the source's value is saved
   * with the snapshot but does not replace them. A field the user already owns (typed, locked or cleared) needs nothing.
   */
  private keepOverride(workId: string, keepFields: readonly MetadataFieldKey[] | undefined): KeepOverride | null {
    if (!keepFields?.length) return null;
    const row = this.store.sqlite.prepare("SELECT projection_json FROM works WHERE id = ?").get(workId) as { projection_json: string } | undefined;
    if (!row) return null;
    const projection = parseProjection(row.projection_json);
    const override = readOverride(this.store, workId);
    let changed = false;
    for (const key of new Set(keepFields)) {
      const field = projection[key];
      if (isOwned(field)) continue;
      if (field?.value !== null && field?.value !== undefined) override.fields[key] = field.value;
      else if (!override.cleared.includes(key)) override.cleared.push(key);
      changed = true;
    }
    if (!changed) return null;
    return {
      override,
      mutation: {
        sql: "INSERT INTO metadata_overrides(work_id, fields_json, locked_json, cleared_json) VALUES (?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET fields_json = excluded.fields_json, locked_json = excluded.locked_json, cleared_json = excluded.cleared_json",
        params: [workId, JSON.stringify(override.fields), JSON.stringify(override.locked), JSON.stringify(override.cleared)],
      },
    };
  }

  /** The entry for a link or refresh: the one the user just previewed when it is still fresh, otherwise a new request. */
  private async detailFor(provider: OnlineProvider, externalId: string, signal?: AbortSignal): Promise<SubjectDetail> {
    const key = `${provider.id}:${externalId}`;
    const cached = this.previews.get(key);
    this.previews.delete(key);
    if (cached && Date.now() - cached.at < PREVIEW_TTL_MS) return cached.detail;
    return provider.detail(externalId, signal);
  }

  /** Download the entry's cover and make it the work's cover when the work's own choice allows it. Never fails the link. */
  private async fetchCover(workId: string, provider: OnlineProvider, detail: SubjectDetail, signal?: AbortSignal, keepCover = false): Promise<{ coverId?: string; selected?: boolean; warning?: string }> {
    const url = detail.images.large || detail.images.common || detail.images.medium;
    if (!url) return { warning: "the entry has no cover picture" };
    try {
      const image = await provider.image(url, signal);
      const result = await this.deps.covers.add(workId, { bytes: image.bytes, source: "bangumi", providerId: provider.id, externalId: detail.externalId, select: keepCover ? "never" : "auto", signal });
      return { coverId: result.cover.id, selected: result.selected };
    } catch (error) {
      if (signal?.aborted) throw new MangaError("CANCELLED", "the request was cancelled");
      return { warning: error instanceof MangaError ? `the cover could not be saved: ${error.message}` : "the cover could not be saved" };
    }
  }

  async link(envelope: CommandEnvelope, input: { workId: string; providerId: string; externalId: string; candidateId?: string; keepFields?: MetadataFieldKey[]; keepCover?: boolean }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const work = this.store.sqlite.prepare("SELECT id FROM works WHERE id = ?").get(input.workId);
    if (!work) throw new MangaError("NOT_FOUND", "work missing");
    const provider = this.provider(input.providerId);
    const detail = await this.detailFor(provider, input.externalId, signal);
    signal?.throwIfAborted();
    const now = new Date().toISOString();
    const warnings = [...detail.warnings];
    const mutations = this.writeSnapshotMutations(input.workId, provider, detail, now, input.candidateId ? "user_selected_candidate" : "user_entered_id", this.keepOverride(input.workId, input.keepFields));
    mutations.push({ sql: "UPDATE metadata_candidates SET state = CASE WHEN external_id = ? THEN 'chosen' ELSE 'rejected' END WHERE work_id = ? AND provider_id = ? AND state = 'open'", params: [input.externalId, input.workId, provider.id] });
    this.store.commit({
      mutations,
      events: [{ type: "work.linked", payload: { workId: input.workId, providerId: provider.id, externalId: input.externalId } }],
      idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId,
      result: { workId: input.workId, providerId: provider.id, externalId: input.externalId },
    });
    const cover = await this.fetchCover(input.workId, provider, detail, signal, input.keepCover);
    if (cover.warning) warnings.push(cover.warning);
    const credits = await this.saveCredits(input.workId, provider, detail.externalId, signal);
    warnings.push(...credits.warnings);
    this.deps.notify("work.updated", { workId: input.workId, reason: "linked" });
    return { workId: input.workId, providerId: provider.id, externalId: input.externalId, namespace: provider.namespace, fetchedAt: now, sourceUrl: detail.sourceUrl, episodes: detail.episodes.length, related: detail.related.length, cover, credits, warnings };
  }

  unlink(envelope: CommandEnvelope, input: { workId: string; providerId: string }): Record<string, unknown> {
    const link = this.store.sqlite.prepare("SELECT external_id FROM work_links WHERE work_id = ? AND provider_id = ? AND link_state = 'linked'").get(input.workId, input.providerId) as { external_id: string } | undefined;
    if (!link) throw new MangaError("NOT_FOUND", "the work is not linked to that source");
    const now = new Date().toISOString();
    // The saved resume of the source stays as a detached snapshot: what the user already has is not thrown away.
    this.store.commit({
      mutations: [
        { sql: "UPDATE work_links SET link_state = 'unlinked' WHERE work_id = ? AND provider_id = ?", params: [input.workId, input.providerId] },
        { sql: "UPDATE metadata_snapshots SET detached = 1 WHERE work_id = ? AND provider_id = ?", params: [input.workId, input.providerId] },
        projectionMutation(this.store, input.workId, now, { [input.providerId]: { detached: true, linkState: "unlinked" } }),
      ],
      events: [{ type: "work.unlinked", payload: { workId: input.workId, providerId: input.providerId } }],
      idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId, result: { workId: input.workId, providerId: input.providerId },
    });
    this.deps.notify("work.updated", { workId: input.workId, reason: "unlinked" });
    return { workId: input.workId, providerId: input.providerId, externalId: link.external_id, kept: true };
  }

  /**
   * Fetch the linked entries again. A source that cannot be reached leaves the saved snapshot in place and is reported as
   * stale with the time it was last fetched; the user's overrides and locks survive every refresh.
   */
  async refresh(envelope: CommandEnvelope, input: { workId: string; providerId?: string; keepFields?: MetadataFieldKey[]; keepCover?: boolean }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const links = this.store.sqlite.prepare("SELECT * FROM work_links WHERE work_id = ? AND link_state = 'linked' AND (? IS NULL OR provider_id = ?)").all(input.workId, input.providerId ?? null, input.providerId ?? null) as LinkRow[];
    if (!links.length) throw new MangaError("NOT_FOUND", "the work is not linked to an online source");
    const refreshed: Array<{ providerId: string; externalId: string; fetchedAt: string; changed: boolean; warnings: string[]; credits?: CreditsSummary }> = [];
    const stale: Array<{ providerId: string; externalId: string; fetchedAt: string | null; error: { code: string; message: string; retryable: boolean } }> = [];
    for (const link of links) {
      const stored = this.store.sqlite.prepare("SELECT snapshot_json, fetched_at FROM metadata_snapshots WHERE work_id = ? AND provider_id = ?").get(input.workId, link.provider_id) as { snapshot_json: string; fetched_at: string | null } | undefined;
      try {
        const provider = this.provider(link.provider_id);
        const detail = await this.detailFor(provider, link.external_id, signal);
        signal?.throwIfAborted();
        const now = new Date().toISOString();
        const changed = stored?.snapshot_json !== JSON.stringify(snapshotOf(detail));
        this.store.commit({
          mutations: this.writeSnapshotMutations(input.workId, provider, detail, now, link.match_basis ?? "user_selected_candidate", this.keepOverride(input.workId, input.keepFields)),
          events: [{ type: "work.refreshed", payload: { workId: input.workId, providerId: provider.id } }],
        });
        // A better remote cover may be added; the work's cover only moves while it is still automatic.
        await this.fetchCover(input.workId, provider, detail, signal, input.keepCover);
        const credits = await this.saveCredits(input.workId, provider, detail.externalId, signal);
        refreshed.push({ providerId: provider.id, externalId: link.external_id, fetchedAt: now, changed, warnings: [...detail.warnings, ...credits.warnings], credits });
      } catch (error) {
        if (signal?.aborted) throw new MangaError("CANCELLED", "the refresh was cancelled");
        stale.push({ providerId: link.provider_id, externalId: link.external_id, fetchedAt: stored?.fetched_at ?? null, error: failureOf(link.provider_id, error) });
      }
    }
    void envelope;
    this.deps.notify("work.updated", { workId: input.workId, reason: "refreshed" });
    return { workId: input.workId, refreshed, stale };
  }

  // ------------------------------------------------------------------ pasted number or link, preview

  private onlineProvider(providerId?: string): OnlineProvider {
    const first = this.deps.providers()[0];
    if (!providerId && !first) throw new MangaError("CAPABILITY_UNAVAILABLE", "no online metadata source is available");
    return this.provider(providerId ?? first!.id);
  }

  /**
   * Check a number or link the user pasted (A-51): take the entry number out, ask the source whether the entry exists, and say whether
   * it fits the work. Nothing is saved. Anything that is not a plain entry page is refused with the reason.
   */
  async resolveRef(input: { ref: string; workId?: string; providerId?: string }, signal?: AbortSignal, sessionId?: string): Promise<Record<string, unknown>> {
    const parsed = parseBangumiRef(input.ref);
    if (!parsed.ok) throw new MangaError("VALIDATION_ERROR", REF_FAILURE_MESSAGES[parsed.reason], { details: { reason: parsed.reason } });
    const work = input.workId ? this.store.sqlite.prepare("SELECT media_kind FROM works WHERE id = ?").get(input.workId) as { media_kind: WorkMediaKind } | undefined : undefined;
    if (input.workId && !work) throw new MangaError("NOT_FOUND", "work missing");
    const provider = this.onlineProvider(input.providerId);
    // A missing entry is the source's 404, shown as "no such entry" rather than as a failure of the source.
    const hit = provider.lookup ? await provider.lookup(parsed.externalId, signal) : toHit(provider, await provider.detail(parsed.externalId, signal));
    const image = await this.candidateImage(provider, hit.imageUrl, signal);
    const here = input.workId ? this.store.sqlite.prepare("SELECT 1 FROM work_links WHERE work_id = ? AND provider_id = ? AND external_id = ? AND link_state = 'linked'").get(input.workId, provider.id, hit.externalId) : undefined;
    return {
      ok: true, providerId: provider.id, externalId: hit.externalId, form: parsed.form, entry: publicHit(hit), image: this.imageHandle(image, sessionId),
      kindMismatch: work ? kindMismatch(work.media_kind, hit) : null,
      linkedElsewhere: this.linkedElsewhere(provider.id, hit.externalId, input.workId),
      alreadyLinked: Boolean(here),
    };
  }

  /**
   * What a link or a refresh would change, before anything is written (A-51). Each field shows what the work has now, where it comes from and
   * what the source says; values the user typed or locked are marked as theirs, because link and refresh never replace them. The source's
   * answer is kept briefly so applying it does not ask again.
   */
  async preview(input: { workId: string; providerId?: string; externalId?: string }, signal?: AbortSignal, sessionId?: string): Promise<Record<string, unknown>> {
    const work = this.store.sqlite.prepare("SELECT id, media_kind, cover_id, cover_state, projection_json FROM works WHERE id = ?").get(input.workId) as { id: string; media_kind: WorkMediaKind; cover_id: string | null; cover_state: string; projection_json: string } | undefined;
    if (!work) throw new MangaError("NOT_FOUND", "work missing");
    let provider: OnlineProvider;
    let externalId = input.externalId;
    if (externalId) provider = this.onlineProvider(input.providerId);
    else {
      const link = this.store.sqlite.prepare("SELECT provider_id, external_id FROM work_links WHERE work_id = ? AND link_state = 'linked' AND (? IS NULL OR provider_id = ?) ORDER BY confirmed_at DESC LIMIT 1").get(input.workId, input.providerId ?? null, input.providerId ?? null) as { provider_id: string; external_id: string } | undefined;
      if (!link) throw new MangaError("NOT_FOUND", "the work is not linked to an online source");
      provider = this.provider(link.provider_id);
      externalId = link.external_id;
    }
    const linked = this.store.sqlite.prepare("SELECT external_id FROM work_links WHERE work_id = ? AND provider_id = ? AND link_state = 'linked'").get(input.workId, provider.id) as { external_id: string } | undefined;
    const detail = await provider.detail(externalId, signal);
    signal?.throwIfAborted();
    this.previews.set(`${provider.id}:${detail.externalId}`, { detail, at: Date.now() });
    while (this.previews.size > 8) this.previews.delete(this.previews.keys().next().value as string);

    const projection = parseProjection(work.projection_json);
    const fields: FieldDiff[] = [];
    for (const key of METADATA_FIELD_KEYS) {
      const field = projection[key];
      const current = field && field.value !== null && field.value !== undefined ? { value: field.value, source: field.source, policy: field.policy } : null;
      const incoming = (detail.fields as Partial<Record<MetadataFieldKey, MetadataFieldValue | null>>)[key] ?? null;
      const has = incoming !== null && incoming !== undefined && !(typeof incoming === "string" && !incoming.trim()) && !(Array.isArray(incoming) && !incoming.length);
      if (!current && !has) continue;
      const owned = isOwned(field);
      const status: FieldDiff["status"] = !has ? "remote-missing" : !current ? "new" : sameValue(current.value, incoming) ? "same" : "differs";
      fields.push({ key, current, incoming: has ? incoming : null, status, protected: owned, keepByDefault: owned || status === "remote-missing" });
    }

    const currentCover = work.cover_id ? this.store.sqlite.prepare("SELECT id, source FROM covers WHERE id = ?").get(work.cover_id) as { id: string; source: string } | undefined : undefined;
    const incomingUrl = detail.images.common || detail.images.medium || detail.images.large || detail.images.small;
    const incomingImage = incomingUrl ? await this.candidateImage(provider, incomingUrl, signal) : null;
    // The cover moves only while the work's cover is automatic and the source ranks above the current one; a user's or locked cover stays.
    const ownedCover = work.cover_state === "user" || work.cover_state === "locked";
    const willReplace = Boolean(incomingUrl) && !ownedCover && (!currentCover || currentCover.source === "file");

    return {
      workId: input.workId, mode: linked?.external_id === detail.externalId ? "refresh" : "link", providerId: provider.id, externalId: detail.externalId,
      namespace: provider.namespace, sourceUrl: detail.sourceUrl, fetchedAt: new Date().toISOString(),
      entry: { title: detail.fields.title ?? null, titleOriginal: detail.fields.titleOriginal ?? null, subjectType: detail.subjectType, episodes: detail.episodes.length, related: detail.related.length },
      kindMismatch: kindMismatch(work.media_kind, detail),
      linkedElsewhere: this.linkedElsewhere(provider.id, detail.externalId, input.workId),
      alreadyLinked: linked?.external_id === detail.externalId,
      replacesLink: linked && linked.external_id !== detail.externalId ? linked.external_id : null,
      fields,
      cover: { current: currentCover ? { coverId: currentCover.id, source: currentCover.source } : null, state: work.cover_state, incoming: this.imageHandle(incomingImage, sessionId), protected: ownedCover, willReplace },
      warnings: detail.warnings,
    };
  }

  // ------------------------------------------------------------------ characters and staff

  /**
   * Save the entry's characters (with voice actors) and staff, and a small picture for the first few. The rows are replaced as a whole, so
   * a list the source no longer sends is not left half old; a list that could not be fetched keeps what was saved before. A failure
   * here is reported in the result and never fails the link.
   */
  private async saveCredits(workId: string, provider: OnlineProvider, externalId: string, signal?: AbortSignal): Promise<CreditsSummary> {
    const summary: CreditsSummary = { supported: Boolean(provider.credits), characters: 0, persons: 0, avatars: { saved: 0, reused: 0, failed: 0, limit: MAX_AVATARS }, warnings: [] };
    if (!provider.credits) return summary;
    let credits: Credits;
    try { credits = await provider.credits(externalId, signal); } catch (error) {
      if (signal?.aborted) throw new MangaError("CANCELLED", "the request was cancelled");
      summary.warnings.push("characters and staff could not be fetched");
      return summary;
    }
    summary.warnings.push(...credits.warnings);
    const characters = credits.characters?.slice(0, MAX_CREDIT_ROWS) ?? null;
    const persons = credits.persons?.slice(0, MAX_CREDIT_ROWS) ?? null;
    if (!characters && !persons) return summary;
    const now = new Date().toISOString();
    const images = this.deps.covers.images;
    const known = new Map<string, string>();
    for (const row of this.store.sqlite.prepare("SELECT character_id AS id, image_hash AS hash FROM subject_characters WHERE work_id = ? AND provider_id = ? AND subject_id = ? AND image_hash IS NOT NULL").all(workId, provider.id, externalId) as Array<{ id: string; hash: string }>) known.set(`c:${row.id}`, row.hash);
    for (const row of this.store.sqlite.prepare("SELECT person_id AS id, image_hash AS hash FROM subject_persons WHERE work_id = ? AND provider_id = ? AND subject_id = ? AND image_hash IS NOT NULL").all(workId, provider.id, externalId) as Array<{ id: string; hash: string }>) known.set(`p:${row.id}`, row.hash);

    // The first MAX_AVATARS entries that have a picture get one; a picture saved by an earlier link is reused without asking again.
    const wanted = [...(characters ?? []).map((item) => ({ key: `c:${item.externalId}`, url: item.imageUrl })), ...(persons ?? []).map((item) => ({ key: `p:${item.externalId}`, url: item.imageUrl }))].filter((item) => item.url).slice(0, MAX_AVATARS);
    const hashes = new Map<string, string>();
    const stored: Mutation[] = [];
    let next = 0;
    const worker = async () => {
      for (;;) {
        signal?.throwIfAborted();
        const item = wanted[next++];
        if (!item) return;
        const before = known.get(item.key);
        if (before && images.has(before)) { hashes.set(item.key, before); summary.avatars.reused += 1; continue; }
        try {
          const picture = await provider.image(item.url!, signal);
          if (picture.bytes.length > MAX_AVATAR_BYTES) throw new MangaError("UNSUPPORTED_FORMAT", "the picture is larger than an avatar may be");
          const described = await images.inspect(picture.bytes);
          stored.push(images.insertSql(described, picture.bytes, { url: item.url, fetchedAt: now }));
          hashes.set(item.key, described.hash);
          summary.avatars.saved += 1;
        } catch {
          if (signal?.aborted) throw new MangaError("CANCELLED", "the request was cancelled");
          summary.avatars.failed += 1;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(AVATAR_PARALLEL, wanted.length) }, worker));

    const mutations: Mutation[] = [...stored];
    if (characters) {
      mutations.push({ sql: "DELETE FROM subject_characters WHERE work_id = ? AND provider_id = ?", params: [workId, provider.id] });
      characters.forEach((item, position) => mutations.push({
        sql: "INSERT OR REPLACE INTO subject_characters(work_id, provider_id, subject_id, character_id, position, name, relation, summary, actors_json, image_hash, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        params: [workId, provider.id, externalId, item.externalId, position, item.name, item.relation || null, item.summary ?? null, JSON.stringify(item.actors), hashes.get(`c:${item.externalId}`) ?? null, now],
      }));
      summary.characters = characters.length;
    }
    if (persons) {
      mutations.push({ sql: "DELETE FROM subject_persons WHERE work_id = ? AND provider_id = ?", params: [workId, provider.id] });
      persons.forEach((item, position) => mutations.push({
        sql: "INSERT OR REPLACE INTO subject_persons(work_id, provider_id, subject_id, person_id, position, name, relation, career_json, episodes, image_hash, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        params: [workId, provider.id, externalId, item.externalId, position, item.name, item.relation || null, JSON.stringify(item.career), item.episodes ?? null, hashes.get(`p:${item.externalId}`) ?? null, now],
      }));
      summary.persons = persons.length;
    }
    this.store.commit({ mutations, events: [{ type: "work.creditsSaved", payload: { workId, providerId: provider.id, characters: summary.characters, persons: summary.persons } }] });
    return summary;
  }

  /** The characters (with voice actors) and staff saved for the work's entry, with their small pictures. Pictures stay in the main process; the page gets handles. */
  async characters(workId: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!this.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(workId)) throw new MangaError("NOT_FOUND", "work missing");
    const snapshot = this.snapshotFor(workId);
    const empty = { workId, source: null, characters: [] as unknown[], persons: [] as unknown[], avatarLimit: MAX_AVATARS };
    if (!snapshot) return empty;
    const characterRows = this.store.sqlite.prepare("SELECT character_id AS id, name, relation, summary, actors_json AS actors, image_hash AS hash, fetched_at AS fetchedAt FROM subject_characters WHERE work_id = ? AND provider_id = ? AND subject_id = ? ORDER BY position").all(workId, snapshot.providerId, snapshot.externalId) as Array<{ id: string; name: string; relation: string | null; summary: string | null; actors: string; hash: string | null; fetchedAt: string }>;
    const personRows = this.store.sqlite.prepare("SELECT person_id AS id, name, relation, career_json AS career, episodes, image_hash AS hash, fetched_at AS fetchedAt FROM subject_persons WHERE work_id = ? AND provider_id = ? AND subject_id = ? ORDER BY position").all(workId, snapshot.providerId, snapshot.externalId) as Array<{ id: string; name: string; relation: string | null; career: string; episodes: string | null; hash: string | null; fetchedAt: string }>;
    const handles = await this.deps.covers.imageHandles([...characterRows, ...personRows].map((row) => row.hash).filter((hash): hash is string => Boolean(hash)), 160, signal);
    const avatar = (hash: string | null) => (hash ? handles.get(hash) ?? null : null);
    const parse = <T>(text: string, fallback: T): T => { try { return JSON.parse(text) as T; } catch { return fallback; } };
    return {
      workId,
      source: { providerId: snapshot.providerId, externalId: snapshot.externalId, detached: snapshot.detached, sourceUrl: snapshot.sourceUrl, fetchedAt: characterRows[0]?.fetchedAt ?? personRows[0]?.fetchedAt ?? null },
      characters: characterRows.map((row) => ({ id: row.id, name: row.name, relation: row.relation ?? "", summary: row.summary ?? "", actors: parse<Array<{ externalId: string; name: string }>>(row.actors, []).map((actor) => ({ id: actor.externalId, name: actor.name })), avatar: avatar(row.hash) })),
      persons: personRows.map((row) => ({ id: row.id, name: row.name, relation: row.relation ?? "", career: parse<string[]>(row.career, []), episodes: row.episodes ?? "", avatar: avatar(row.hash) })),
      avatarLimit: MAX_AVATARS,
    };
  }

  // ------------------------------------------------------------------ related works

  snapshotFor(workId: string, providerId?: string): { providerId: string; externalId: string; namespace: string; fetchedAt: string | null; detached: boolean; sourceUrl: string | null; snapshot: StoredSnapshot } | null {
    const row = this.store.sqlite.prepare(`SELECT s.provider_id AS providerId, s.external_id AS externalId, s.snapshot_json AS json, s.fetched_at AS fetchedAt, s.detached AS detached, s.source_url AS sourceUrl,
        COALESCE((SELECT l.namespace FROM work_links l WHERE l.work_id = s.work_id AND l.provider_id = s.provider_id ORDER BY l.confirmed_at DESC LIMIT 1), '') AS namespace
      FROM metadata_snapshots s WHERE s.work_id = ? AND s.provider_id <> ? AND (? IS NULL OR s.provider_id = ?) ORDER BY s.detached ASC, s.fetched_at DESC LIMIT 1`).get(workId, LOCAL_PROVIDER, providerId ?? null, providerId ?? null) as { providerId: string; externalId: string; json: string; fetchedAt: string | null; detached: number; sourceUrl: string | null; namespace: string } | undefined;
    if (!row) return null;
    try {
      return { providerId: row.providerId, externalId: row.externalId, namespace: row.namespace, fetchedAt: row.fetchedAt, detached: row.detached === 1, sourceUrl: row.sourceUrl, snapshot: JSON.parse(row.json) as StoredSnapshot };
    } catch {
      return null;
    }
  }

  /** Related works with a source: the linked entry's relations (marked when the library has them) and library works that share tags. Nothing here calls a model. */
  related(workId: string): Record<string, unknown> {
    const work = this.store.sqlite.prepare("SELECT id, projection_json FROM works WHERE id = ?").get(workId) as { id: string; projection_json: string } | undefined;
    if (!work) throw new MangaError("NOT_FOUND", "work missing");
    const linked = this.snapshotFor(workId);
    const relations = (linked && !linked.detached ? linked.snapshot.related : []).map((item) => {
      const inLibrary = this.store.sqlite.prepare("SELECT work_id FROM work_links WHERE provider_id = ? AND external_id = ? AND link_state = 'linked' LIMIT 1").get(linked!.providerId, item.externalId) as { work_id: string } | undefined;
      return { ...item, providerId: linked!.providerId, inLibraryWorkId: inLibrary?.work_id ?? null, sourceUrl: linked!.sourceUrl ? linked!.sourceUrl.replace(/\/subject\/[^/]+$/, `/subject/${encodeURIComponent(item.externalId)}`) : null };
    });
    const projection = JSON.parse(work.projection_json || "{}") as Parameters<typeof projectedValue>[0];
    const tags = (projectedValue(projection, "tags") as string[] | null) ?? [];
    const similar: Array<{ workId: string; title: string; mediaKind: string; sharedTags: string[]; score: number }> = [];
    if (tags.length) {
      const mine = new Set(tags);
      const rows = this.store.sqlite.prepare("SELECT id, title, media_kind, projection_json FROM works WHERE id <> ? AND projection_json LIKE '%\"tags\"%'").all(workId) as Array<{ id: string; title: string; media_kind: string; projection_json: string }>;
      for (const row of rows) {
        const other = JSON.parse(row.projection_json || "{}") as Parameters<typeof projectedValue>[0];
        const theirs = (projectedValue(other, "tags") as string[] | null) ?? [];
        const shared = theirs.filter((tag) => mine.has(tag));
        if (shared.length < 2) continue;
        const score = shared.length / new Set([...mine, ...theirs]).size;
        if (score < 0.2) continue;
        const title = projectedValue(other, "title");
        similar.push({ workId: row.id, title: typeof title === "string" && title ? title : row.title, mediaKind: row.media_kind, sharedTags: shared.slice(0, 6), score: Math.round(score * 1000) / 1000 });
      }
      similar.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-CN"));
    }
    return {
      workId,
      source: linked ? { providerId: linked.providerId, fetchedAt: linked.fetchedAt, detached: linked.detached } : null,
      relations,
      similar: similar.slice(0, SIMILAR_LIMIT),
    };
  }

  // ------------------------------------------------------------------ batch lookup

  /** Queue a search for every work that has no linked entry. Results become open candidates; nothing is linked by itself. */
  findMissing(input: { limit?: number; kind?: WorkMediaKind }, searchTitle: (workId: string) => string): { queued: number; workIds: string[]; jobId: string | null } {
    const online = this.deps.providers().filter((provider) => this.isEnabled(provider.id));
    if (!online.length) throw new MangaError("CAPABILITY_UNAVAILABLE", "no online metadata source is turned on");
    const rows = this.store.sqlite.prepare(`SELECT w.id, w.media_kind FROM works w WHERE (? IS NULL OR w.media_kind = ?)
      AND NOT EXISTS (SELECT 1 FROM work_links l WHERE l.work_id = w.id AND l.link_state = 'linked')
      AND NOT EXISTS (SELECT 1 FROM metadata_candidates c WHERE c.work_id = w.id AND c.state = 'open')
      AND EXISTS (SELECT 1 FROM resources r WHERE r.work_id = w.id) ORDER BY w.created_at DESC LIMIT ?`).all(input.kind ?? null, input.kind ?? null, Math.min(200, input.limit ?? 50)) as Array<{ id: string; media_kind: WorkMediaKind }>;
    if (!rows.length) return { queued: 0, workIds: [], jobId: null };
    const job = this.deps.media.jobs.submit<number>({
      lane: "net", kind: "metadata-find-missing", key: "metadata-find-missing", owner: METADATA_MODULE,
      run: async ({ signal, progress }) => {
        let found = 0;
        for (const [index, row] of rows.entries()) {
          signal.throwIfAborted();
          progress(index / rows.length);
          try {
            const outcome = await this.search({ workId: row.id, query: searchTitle(row.id), kind: row.media_kind, mode: "fallback", limit: 5 }, signal);
            if (outcome.results.length) found += 1;
            this.deps.notify("metadata.findMissing", { workId: row.id, candidates: outcome.results.length, done: index + 1, total: rows.length });
          } catch (error) {
            if (signal.aborted) throw error;
            // The source being unreachable stops the batch: asking again for every remaining work would only repeat the failure.
            if (error instanceof MangaError && (error.code === "PROVIDER_UNAVAILABLE" || error.code === "RATE_LIMITED")) break;
          }
        }
        return found;
      },
    });
    return { queued: rows.length, workIds: rows.map((row) => row.id), jobId: job.id };
  }

  /** Recompute a work's projection, for repair after a change made outside these commands. */
  reproject(workId: string): void {
    this.store.commit({ mutations: [projectionMutation(this.store, workId, new Date().toISOString())], events: [] });
  }

  /** Record what the work's files say, as the `local-file` source. Returns whether anything changed. */
  async absorbLocal(resourceId: string, signal?: AbortSignal): Promise<boolean> {
    const { workId, fields } = await this.deps.extras.readLocal(resourceId, signal);
    if (!workId) return false;
    if (!this.deps.extras.saveLocalSnapshot(workId, fields)) return false;
    this.reproject(workId);
    return true;
  }
}

/** The override a link applies for the fields the user kept, with the statement that writes it. */
type KeepOverride = { override: FieldOverride; mutation: Mutation };

export type CreditsSummary = { supported: boolean; characters: number; persons: number; avatars: { saved: number; reused: number; failed: number; limit: number }; warnings: string[] };

export type FieldDiff = {
  key: MetadataFieldKey;
  current: { value: MetadataFieldValue; source: ProjectionSourceId | null; policy: ProjectedField["policy"] } | null;
  incoming: MetadataFieldValue | null;
  status: "same" | "new" | "differs" | "remote-missing";
  /** The user's own value, lock or deliberate empty: link and refresh leave it as it is, so there is nothing to choose. */
  protected: boolean;
  keepByDefault: boolean;
};

const isOwned = (field: ProjectedField | undefined): boolean => field?.policy === "user" || field?.policy === "locked" || field?.policy === "empty";

const sameValue = (a: MetadataFieldValue, b: MetadataFieldValue): boolean => (Array.isArray(a) || Array.isArray(b) ? JSON.stringify(a) === JSON.stringify(b) : typeof a === "string" && typeof b === "string" ? a.trim() === b.trim() : a === b);

/** The entry does not look like the kind of work it is being attached to: shown as a notice, and the user may go on. */
function kindMismatch(expected: WorkMediaKind, entry: { subjectType: number; kindGuess?: WorkMediaKind | null }): { expected: WorkMediaKind; actual: WorkMediaKind | null; subjectType: number } | null {
  const guess = entry.kindGuess ?? null;
  const fits = guess ? guess === expected : entry.subjectType === 2 ? expected === "video" : entry.subjectType === 1 ? expected !== "video" : false;
  return fits ? null : { expected, actual: guess, subjectType: entry.subjectType };
}

function toHit(provider: OnlineProvider, detail: SubjectDetail): SearchHit {
  return {
    providerId: provider.id, externalId: detail.externalId, title: String(detail.fields.title ?? detail.externalId),
    ...(detail.fields.titleOriginal ? { titleOriginal: String(detail.fields.titleOriginal) } : {}),
    subjectType: detail.subjectType, kindGuess: detail.kindGuess ?? null, sourceUrl: detail.sourceUrl,
  };
}

export type { MetadataFieldValue };
