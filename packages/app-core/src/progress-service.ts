import { MangaError, type CommandEnvelope, type ScopeGrant, type SourceLocator } from "@manga/contracts";
import type { DrizzleStore, Mutation } from "@manga/storage-drizzle";
import type { GrantRegistry } from "./grants.ts";
import { readLayout, type RevisionLayout } from "./domain/revision-layout.ts";

export type ConsumedRange = { partId?: string; start: number; end: number };

/** Pseudo part ids for consumed ranges that are not text: comic pages (by index) and video time (milliseconds). */
export const PAGES_RANGE = "$pages";
export const TIME_RANGE = "$time";

/** Overlapping or adjacent ranges of the same part collapse into one, so the read range stays a true union. */
export function mergeConsumedRanges(ranges: ConsumedRange[]): ConsumedRange[] {
  const byPart = new Map<string, Array<{ start: number; end: number }>>();
  for (const range of ranges) {
    const key = range.partId ?? "";
    const list = byPart.get(key) ?? [];
    list.push({ start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) });
    byPart.set(key, list);
  }
  const merged: ConsumedRange[] = [];
  for (const [key, list] of byPart) {
    list.sort((left, right) => left.start - right.start);
    const out: Array<{ start: number; end: number }> = [];
    for (const range of list) {
      const last = out[out.length - 1];
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
      else out.push({ ...range });
    }
    for (const range of out) merged.push(key ? { partId: key, ...range } : { ...range });
  }
  return merged;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

function textPercent(layout: RevisionLayout, partId: string, offset: number): number {
  const parts = layout.parts ?? [];
  const index = parts.findIndex((part) => part.id === partId);
  if (index < 0) return 0;
  if (layout.total > 0) {
    const before = parts.slice(0, index).reduce((sum, part) => sum + part.length, 0);
    return clamp01((before + Math.min(offset, parts[index]!.length)) / layout.total);
  }
  return parts.length > 1 ? clamp01(index / (parts.length - 1)) : 0;
}

function consumedMs(ranges: ConsumedRange[]): number {
  return ranges.filter((range) => range.partId === TIME_RANGE).reduce((sum, range) => sum + (range.end - range.start), 0);
}

export type ProgressSnapshot = { percent: number; completion: "new" | "reading" | "completed" };

/** Where a locator sits in its revision, as a fraction, and whether that counts as having finished the resource. */
export function measureProgress(layout: RevisionLayout, locator: SourceLocator, merged: ConsumedRange[], previous: string | undefined): ProgressSnapshot {
  let percent = 0;
  let finished = false;
  if (locator.kind === "text") {
    percent = textPercent(layout, locator.partId, locator.range.end);
    finished = percent >= 0.98 && layout.total > 0;
  } else if (locator.kind === "image") {
    const index = layout.pages?.indexOf(locator.pageId) ?? -1;
    if (index < 0) throw new MangaError("NOT_FOUND", "page does not belong to this revision");
    const total = layout.pages?.length ?? 0;
    percent = total ? clamp01((index + 1) / total) : 0;
    finished = total > 0 && index === total - 1;
  } else {
    if (layout.unit !== "ms") throw new MangaError("VALIDATION_ERROR", "this revision is not a video");
    if (locator.startMs > layout.total + 1000) throw new MangaError("VALIDATION_ERROR", "time is past the end of the video");
    percent = layout.total ? clamp01(locator.startMs / layout.total) : 0;
    // Opening and ending credits are often skipped on purpose, so finishing needs the end plus a real share watched.
    const tail = Math.max(90_000, layout.total * 0.03);
    finished = layout.total > 0 && locator.startMs >= layout.total - tail && consumedMs(merged) >= layout.total * 0.5;
  }
  return { percent, completion: previous === "completed" || finished ? "completed" : "reading" };
}

export type ProgressWrite = {
  resourceId: string;
  revisionId: string;
  locator: SourceLocator;
  /** Ranges to union into the consumed set. */
  consume?: ConsumedRange[];
  now?: string;
};

/** The work a resource belongs to learns it was touched; the first touch moves a wishlist or unshelved work to "reading". */
export function touchWorkMutation(resourceId: string, now: string): Mutation {
  return {
    sql: `UPDATE works SET last_resource_id = ?,
      shelf_state = CASE WHEN last_opened_at IS NULL AND shelf_state IN ('none','wishlist') THEN 'reading' ELSE shelf_state END,
      last_opened_at = ?, updated_at = ? WHERE id = (SELECT work_id FROM resources WHERE id = ?)`,
    params: [resourceId, now, now, resourceId],
  };
}

export function progressMutations(store: DrizzleStore, input: ProgressWrite): { mutations: Mutation[]; consumed: ConsumedRange[]; snapshot: ProgressSnapshot } {
  const revision = store.sqlite.prepare("SELECT id FROM resource_revisions WHERE id = ? AND resource_id = ?").get(input.revisionId, input.resourceId);
  if (!revision) throw new MangaError("NOT_FOUND", "resource revision does not belong to this resource");
  const existing = store.sqlite.prepare("SELECT consumed_ranges_json, completion_state FROM progress WHERE resource_id = ? AND resource_revision_id = ?").get(input.resourceId, input.revisionId) as { consumed_ranges_json: string; completion_state: string } | undefined;
  const merged = mergeConsumedRanges([...(existing ? JSON.parse(existing.consumed_ranges_json) as ConsumedRange[] : []), ...(input.consume ?? [])]);
  const layout = readLayout(store, input.revisionId);
  const snapshot = layout ? measureProgress(layout, input.locator, merged, existing?.completion_state) : { percent: 0, completion: "reading" as const };
  const now = input.now ?? new Date().toISOString();
  return {
    consumed: merged,
    snapshot,
    mutations: [
      {
        sql: `INSERT INTO progress(resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at, percent)
          VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(resource_id, resource_revision_id) DO UPDATE SET last_locator_json = excluded.last_locator_json, consumed_ranges_json = excluded.consumed_ranges_json,
            completion_state = excluded.completion_state, last_interaction_at = excluded.last_interaction_at, percent = excluded.percent`,
        params: [input.resourceId, input.revisionId, JSON.stringify(input.locator), JSON.stringify(merged), snapshot.completion, now, snapshot.percent],
      },
      touchWorkMutation(input.resourceId, now),
    ],
  };
}

function commitProgress(store: DrizzleStore, envelope: CommandEnvelope, input: ProgressWrite): Record<string, unknown> {
  const built = progressMutations(store, input);
  const result = { resourceId: input.resourceId, resourceRevisionId: input.revisionId, percent: built.snapshot.percent, completion: built.snapshot.completion };
  store.commit({
    mutations: built.mutations,
    events: [{ type: "progress.updated", payload: { resourceId: input.resourceId, resourceRevisionId: input.revisionId } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result,
  });
  return { ...result, consumed: built.consumed };
}

function assertReadable(grants: GrantRegistry, grant: ScopeGrant, resourceId: string): void {
  if (!grants.canRead(grant, resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
}

/** `progress.set`: any locator kind. Text keeps its "mark read here" semantics; page and time have their own commands. */
export function setProgress(store: DrizzleStore, envelope: CommandEnvelope, grant: ScopeGrant, grants: GrantRegistry): Record<string, unknown> {
  const input = envelope.input as { resourceId: string; resourceRevisionId: string; locator: SourceLocator; consumed?: boolean };
  assertReadable(grants, grant, input.resourceId);
  const consume: ConsumedRange[] = [];
  if (input.consumed) {
    if (input.locator.kind === "text") consume.push({ partId: input.locator.partId, start: input.locator.range.start, end: input.locator.range.end });
    else if (input.locator.kind === "image") {
      const pages = readLayout(store, input.resourceRevisionId)?.pages ?? [];
      const index = pages.indexOf(input.locator.pageId);
      if (index >= 0) consume.push({ partId: PAGES_RANGE, start: index, end: index + 1 });
    }
  }
  return commitProgress(store, envelope, { resourceId: input.resourceId, revisionId: input.resourceRevisionId, locator: input.locator, consume });
}

/** `progress.setPage`: the reader is on this page. A page counts as read only when the reader says so. */
export function setPageProgress(store: DrizzleStore, envelope: CommandEnvelope, grant: ScopeGrant, grants: GrantRegistry): Record<string, unknown> {
  const input = envelope.input as { resourceId: string; resourceRevisionId: string; pageId: string; consumed?: boolean };
  assertReadable(grants, grant, input.resourceId);
  const pages = readLayout(store, input.resourceRevisionId)?.pages;
  if (!pages) throw new MangaError("VALIDATION_ERROR", "this revision has no pages");
  const index = pages.indexOf(input.pageId);
  if (index < 0) throw new MangaError("NOT_FOUND", "page does not belong to this revision");
  const consume = input.consumed === false ? [] : [{ partId: PAGES_RANGE, start: index, end: index + 1 }];
  return commitProgress(store, envelope, { resourceId: input.resourceId, revisionId: input.resourceRevisionId, locator: { kind: "image", pageId: input.pageId }, consume });
}

/**
 * `progress.setTime`: the playhead is here, and `played` lists stretches actually played since the last write.
 * Seeking over a part of the video never adds it to the consumed set.
 */
export function setTimeProgress(store: DrizzleStore, envelope: CommandEnvelope, grant: ScopeGrant, grants: GrantRegistry): Record<string, unknown> {
  const input = envelope.input as { resourceId: string; resourceRevisionId: string; timeMs: number; played?: Array<{ startMs: number; endMs: number }> };
  assertReadable(grants, grant, input.resourceId);
  const layout = readLayout(store, input.resourceRevisionId);
  if (!layout || layout.unit !== "ms") throw new MangaError("VALIDATION_ERROR", "this revision is not a video");
  const consume = (input.played ?? []).filter((range) => range.endMs > range.startMs).map((range) => ({ partId: TIME_RANGE, start: Math.min(range.startMs, layout.total), end: Math.min(range.endMs, layout.total) }));
  return commitProgress(store, envelope, { resourceId: input.resourceId, revisionId: input.resourceRevisionId, locator: { kind: "temporal", startMs: input.timeMs }, consume });
}

export function getProgress(store: DrizzleStore, input: { resourceId: string; resourceRevisionId?: string }): Record<string, unknown> {
  const revisionId = input.resourceRevisionId
    ?? (store.sqlite.prepare("SELECT id FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(input.resourceId) as { id: string } | undefined)?.id;
  if (!revisionId) throw new MangaError("NOT_FOUND", "resource has no revision");
  const row = store.sqlite.prepare("SELECT last_locator_json, consumed_ranges_json, completion_state, percent, last_interaction_at FROM progress WHERE resource_id = ? AND resource_revision_id = ?").get(input.resourceId, revisionId) as {
    last_locator_json: string | null;
    consumed_ranges_json: string;
    completion_state: string;
    percent: number;
    last_interaction_at: string;
  } | undefined;
  const layout = readLayout(store, revisionId);
  return {
    resourceId: input.resourceId,
    resourceRevisionId: revisionId,
    locator: row?.last_locator_json ? JSON.parse(row.last_locator_json) : null,
    consumed: row ? JSON.parse(row.consumed_ranges_json) : [],
    completion: row?.completion_state ?? "new",
    percent: row?.percent ?? 0,
    lastInteractionAt: row?.last_interaction_at ?? null,
    unit: layout?.unit ?? null,
    total: layout?.total ?? 0,
  };
}
