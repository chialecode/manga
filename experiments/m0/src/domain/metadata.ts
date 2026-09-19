import { MangaError } from "@manga/contracts";
import type { MetadataSnapshot, ProviderQueryMode } from "@manga/contracts";

export type FakeWork = {
  externalId: string;
  title: string;
  language: string;
  medium: "novel" | "anime" | "comic";
  season?: number;
  special?: boolean;
  fields: Record<string, unknown>;
  delayMs?: number;
  fail?: "timeout" | "rate" | "empty";
};

export const PROVIDER_A: FakeWork[] = [
  {
    externalId: "a-aurora",
    title: "极光旅人",
    language: "zh",
    medium: "novel",
    fields: { title: "极光旅人", score: 8.2, episodes: null, year: 2021 },
  },
  {
    externalId: "a-aurora-anime",
    title: "极光旅人",
    language: "zh",
    medium: "anime",
    season: 1,
    fields: { title: "Aurora Traveler", score: 7.1, episodes: 12, year: 2022 },
  },
  {
    externalId: "a-aurora-s2",
    title: "极光旅人",
    language: "zh",
    medium: "anime",
    season: 2,
    fields: { title: "极光旅人 第二季", score: 7.4, episodes: 13, year: 2023 },
  },
  {
    externalId: "a-special",
    title: "极光旅人",
    language: "ja",
    medium: "anime",
    special: true,
    fields: { title: "極光旅人 OVA", score: 6.8, episodes: 1, year: 2023 },
    fail: "empty",
  },
];

export const PROVIDER_B: FakeWork[] = [
  {
    externalId: "b-aurora",
    title: "极光旅人",
    language: "zh",
    medium: "novel",
    fields: { title: "极光旅人（小说）", score: 9.9, episodes: null, year: 2021, studio: "Kite" },
    delayMs: 5,
  },
  {
    externalId: "b-aurora-anime",
    title: "极光旅人",
    language: "en",
    medium: "anime",
    season: 1,
    fields: { title: "Aurora Traveler", score: 4.0, episodes: 12, year: 2022 },
    fail: "rate",
  },
  {
    externalId: "b-timeout",
    title: "静海",
    language: "zh",
    medium: "novel",
    fields: {},
    fail: "timeout",
  },
];

export async function queryProvider(
  providerId: "alpha" | "beta",
  title: string,
  options: { signal?: AbortSignal } = {},
): Promise<MetadataSnapshot[]> {
  const catalog = providerId === "alpha" ? PROVIDER_A : PROVIDER_B;
  const hits = catalog.filter((item) => item.title === title);
  const out: MetadataSnapshot[] = [];
  for (const hit of hits) {
    if (options.signal?.aborted) throw new MangaError("CANCELLED", "metadata cancelled");
    if (hit.delayMs) await new Promise((resolve) => setTimeout(resolve, hit.delayMs));
    if (hit.fail === "timeout") throw new MangaError("PROVIDER_UNAVAILABLE", `${providerId} timeout`, { retryable: true });
    if (hit.fail === "rate") throw new MangaError("RATE_LIMITED", `${providerId} rate limited`, { retryable: true });
    if (hit.fail === "empty") {
      out.push({
        providerId,
        externalId: hit.externalId,
        fetchedAt: new Date().toISOString(),
        fields: {},
        partial: true,
      });
      continue;
    }
    out.push({
      providerId,
      externalId: hit.externalId,
      fetchedAt: new Date().toISOString(),
      fields: hit.fields,
      partial: false,
    });
  }
  return out;
}

export function mergeFields(
  snapshots: MetadataSnapshot[],
  overrides: Record<string, unknown>,
  locked: string[],
  cleared: string[],
  mode: ProviderQueryMode,
): Record<string, { value: unknown; source: string; policy: string }> {
  const result: Record<string, { value: unknown; source: string; policy: string }> = {};
  const order = mode === "fallback" ? snapshots.slice(0, 1) : snapshots;
  for (const snapshot of order) {
    for (const [key, value] of Object.entries(snapshot.fields)) {
      if (value === null || value === undefined || value === "") continue;
      if (key === "score") {
        if (!result[key]) result[key] = { value, source: snapshot.providerId, policy: "provider" };
        continue;
      }
      if (!result[key]) result[key] = { value, source: snapshot.providerId, policy: "provider" };
    }
  }
  for (const key of cleared) {
    result[key] = { value: null, source: "user", policy: "empty" };
  }
  for (const [key, value] of Object.entries(overrides)) {
    result[key] = { value, source: "user", policy: locked.includes(key) ? "locked" : "user" };
  }
  return result;
}

export function disambiguate(snapshots: MetadataSnapshot[]): { status: "matched" | "needs_review"; candidates: MetadataSnapshot[] } {
  if (snapshots.length <= 1) return { status: "matched", candidates: snapshots };
  return { status: "needs_review", candidates: snapshots };
}

export type ConfirmedLink = {
  workId: string;
  providerId: string;
  externalId: string;
  snapshot: MetadataSnapshot;
  confirmedAt: string;
};

export function confirmCandidate(candidates: MetadataSnapshot[], providerId: string, externalId: string): MetadataSnapshot {
  const hit = candidates.find((item) => item.providerId === providerId && item.externalId === externalId);
  if (!hit) throw new MangaError("NOT_FOUND", "metadata candidate is not in the current review set");
  return hit;
}
