import type { ShelfState, WorkMediaKind, WorkResourceRow, WorkSummary } from "@manga/contracts/media";

export type { ShelfState, WorkMediaKind, WorkResourceRow, WorkSummary };

export const SHELF_ORDER: ShelfState[] = ["reading", "wishlist", "finished", "on_hold"];
export const MEDIA_KINDS: WorkMediaKind[] = ["novel", "comic", "video"];

export type WorkPage = { items: WorkSummary[]; total: number; nextCursor: string | null };

export type ProjectedField = {
  value: string | number | string[] | null;
  source: "user" | "online" | "file" | "filename" | "detached" | null;
  providerId?: string;
  fetchedAt?: string;
  policy: "provider" | "user" | "locked" | "empty" | "none";
  candidates: Array<{ source: string; providerId?: string; value: string | number | string[]; fetchedAt?: string; selected: boolean }>;
};

export type WorkDetail = WorkSummary & {
  originalTitle: string;
  fields: Partial<Record<string, ProjectedField>>;
  override: { fields: Record<string, unknown>; locked: string[]; cleared: string[] };
  links: Array<{ providerId: string; externalId: string; namespace: string; subjectType: number | null; linkState: string; matchBasis: string | null; confirmedAt: string }>;
  snapshots: Array<{ providerId: string; externalId: string; fetchedAt: string | null; sourceUrl: string | null; apiVersion: string | null; detached: boolean }>;
  coverState: string;
  coverCount: number;
  resources: WorkResourceRow[];
  suggestedQuery?: string;
  linkedSource?: { providerId: string; externalId: string; namespace: string; fetchedAt: string | null; detached: boolean; sourceUrl: string | null; rating: { score?: number; total?: number } | null; episodeCount: number; relatedCount: number } | null;
};

export type RelatedProvider = { relation: string; externalId: string; title: string; titleOriginal?: string; subjectType: number; providerId: string; inLibraryWorkId: string | null; sourceUrl: string | null };
export type RelatedSimilar = { workId: string; title: string; mediaKind: string; sharedTags: string[]; score: number };
export type RelatedWorks = { workId: string; source: { providerId: string; fetchedAt: string | null; detached: boolean } | null; relations: RelatedProvider[]; similar: RelatedSimilar[] };

export type Facets = Set<string>;

/** The shell page that reads each kind. The novel reader keeps its earlier page id. */
export const PAGE_FOR_KIND: Record<WorkMediaKind, string> = { novel: "reading", comic: "comic", video: "video" };

/** The resource after `currentId` in a work's order that can be opened, or null at the end. */
export function nextResource<T extends { id: string; available?: boolean }>(rows: readonly T[], currentId: string): T | null {
  const at = rows.findIndex((row) => row.id === currentId);
  if (at < 0) return null;
  return rows.slice(at + 1).find((row) => row.available !== false) ?? null;
}

/** "第 3 话 标题" for an episode row; the ordinal label is left out when it has none. */
export function resourceLabel(row: { title: string; ordinalLabel?: string | null }): string {
  return row.ordinalLabel ? `${row.ordinalLabel} ${row.title}`.trim() : row.title;
}

/** Percent with no more precision than a card can show. */
export const percentOf = (fraction: number): number => Math.max(0, Math.min(100, Math.round(fraction * 100)));
