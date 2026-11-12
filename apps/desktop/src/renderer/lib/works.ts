import type { ShelfState, WorkContextPosition, WorkMediaKind, WorkResourceRow, WorkSummary } from "@manga/contracts/media";
import type { Translator } from "@manga/i18n";

export type { ShelfState, WorkContextPosition, WorkMediaKind, WorkResourceRow, WorkSummary };

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

export type WorkVersion = { workId: string; label: string; resourceCount: number; lastOpenedAt: string | null; current: boolean };

export type WorkDetail = WorkSummary & {
  /** The versions of the title, this work among them (A-68); only the owner is given them. */
  versions?: WorkVersion[];
  originalTitle: string;
  fields: Partial<Record<string, ProjectedField>>;
  override: { fields: Record<string, unknown>; locked: string[]; cleared: string[] };
  links: Array<{ providerId: string; externalId: string; namespace: string; subjectType: number | null; linkState: string; matchBasis: string | null; confirmedAt: string }>;
  snapshots: Array<{ providerId: string; externalId: string; fetchedAt: string | null; sourceUrl: string | null; apiVersion: string | null; detached: boolean }>;
  coverState: string;
  coverCount: number;
  resources: WorkResourceRow[];
  contextPositions?: WorkContextPosition[];
  suggestedQuery?: string;
  linkedSource?: { providerId: string; externalId: string; namespace: string; fetchedAt: string | null; detached: boolean; sourceUrl: string | null; rating: { score?: number; total?: number } | null; episodeCount: number; relatedCount: number } | null;
};

export type RelatedProvider = { relation: string; externalId: string; title: string; titleOriginal?: string; subjectType: number; providerId: string; inLibraryWorkId: string | null; sourceUrl: string | null };
export type RelatedSimilar = { workId: string; title: string; mediaKind: string; sharedTags: string[]; score: number };
export type RelatedWorks = { workId: string; source: { providerId: string; fetchedAt: string | null; detached: boolean } | null; relations: RelatedProvider[]; similar: RelatedSimilar[] };

export type Facets = ReadonlySet<string>;

/** The shell page that reads each kind. The novel reader keeps its earlier page id. */
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

export function formatClockMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** "最近：第 3 话 12:30" or "项目 A：第 8 页": one context's position on a work's homepage (A-129). */
export function formatContextPosition(
  t: Translator["t"],
  entry: WorkContextPosition,
  mediaKind: string,
  manyResources: boolean,
): string {
  const part = entry.ordinalLabel ?? (manyResources ? entry.resourceTitle : "");
  const locator = entry.locator as { kind?: string; startMs?: number } | null;
  let pos = "";
  if (locator?.kind === "temporal" && typeof locator.startMs === "number") {
    pos = formatClockMs(locator.startMs);
  } else if (entry.pageNumber !== null) {
    pos = t("work.contextPos.page", { page: entry.pageNumber });
  } else if (entry.completion === "completed") {
    pos = t(mediaKind === "video" ? "shelf.state.finished.video" : "shelf.state.finished");
  } else {
    pos = `${percentOf(entry.percent)}%`;
  }
  const position = [part, pos].filter(Boolean).join(" ");
  return t("work.contextPos.entry", { context: entry.contextName, position });
}
