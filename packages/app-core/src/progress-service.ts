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

/** The key of a context in the progress table: a project id, or the empty string for "最近". */
export const contextKeyOf = (contextId: string | null | undefined): string => contextId ?? "";

export type ProgressWrite = {
  /** The context the person is reading in (A-96): the position in a project is not the position in "最近". */
  contextId: string;
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
  const existing = store.sqlite.prepare("SELECT last_locator_json, consumed_ranges_json, completion_state, last_interaction_at FROM progress WHERE context_id = ? AND resource_id = ? AND resource_revision_id = ?").get(input.contextId, input.resourceId, input.revisionId) as { last_locator_json: string | null; consumed_ranges_json: string; completion_state: string; last_interaction_at: string } | undefined;
  const merged = mergeConsumedRanges([...(existing ? JSON.parse(existing.consumed_ranges_json) as ConsumedRange[] : []), ...(input.consume ?? [])]);
  const layout = readLayout(store, input.revisionId);
  const snapshot = layout ? measureProgress(layout, input.locator, merged, existing?.completion_state) : { percent: 0, completion: "reading" as const };
  const now = input.now ?? new Date().toISOString();
  const locatorJson = JSON.stringify(input.locator);
  const mergedJson = JSON.stringify(merged);
  // A reader that comes back to the screen says the position it already has; that is not a newer position, so the context does not become the latest one for it.
  const unchanged = existing !== undefined && existing.last_locator_json === locatorJson && existing.consumed_ranges_json === mergedJson && existing.completion_state === snapshot.completion;
  return {
    consumed: merged,
    snapshot,
    mutations: [
      {
        sql: `INSERT INTO progress(context_id, resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at, percent)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(context_id, resource_id, resource_revision_id) DO UPDATE SET last_locator_json = excluded.last_locator_json, consumed_ranges_json = excluded.consumed_ranges_json,
            completion_state = excluded.completion_state, last_interaction_at = excluded.last_interaction_at, percent = excluded.percent`,
        params: [input.contextId, input.resourceId, input.revisionId, locatorJson, mergedJson, snapshot.completion, unchanged ? existing.last_interaction_at : now, snapshot.percent],
      },
      touchWorkMutation(input.resourceId, now),
    ],
  };
}

function commitProgress(store: DrizzleStore, envelope: CommandEnvelope, input: ProgressWrite): Record<string, unknown> {
  const built = progressMutations(store, input);
  const result = { contextId: input.contextId || null, resourceId: input.resourceId, resourceRevisionId: input.revisionId, percent: built.snapshot.percent, completion: built.snapshot.completion };
  store.commit({
    mutations: built.mutations,
    events: [{ type: "progress.updated", payload: { contextId: input.contextId || null, resourceId: input.resourceId, resourceRevisionId: input.revisionId } }],
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
  const input = envelope.input as { contextId: string | null; resourceId: string; resourceRevisionId: string; locator: SourceLocator; consumed?: boolean };
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
  return commitProgress(store, envelope, { contextId: contextKeyOf(input.contextId), resourceId: input.resourceId, revisionId: input.resourceRevisionId, locator: input.locator, consume });
}

/** `progress.setPage`: the reader is on this page. A page counts as read only when the reader says so. */
export function setPageProgress(store: DrizzleStore, envelope: CommandEnvelope, grant: ScopeGrant, grants: GrantRegistry): Record<string, unknown> {
  const input = envelope.input as { contextId: string | null; resourceId: string; resourceRevisionId: string; pageId: string; consumed?: boolean };
  assertReadable(grants, grant, input.resourceId);
  const pages = readLayout(store, input.resourceRevisionId)?.pages;
  if (!pages) throw new MangaError("VALIDATION_ERROR", "this revision has no pages");
  const index = pages.indexOf(input.pageId);
  if (index < 0) throw new MangaError("NOT_FOUND", "page does not belong to this revision");
  const consume = input.consumed === false ? [] : [{ partId: PAGES_RANGE, start: index, end: index + 1 }];
  return commitProgress(store, envelope, { contextId: contextKeyOf(input.contextId), resourceId: input.resourceId, revisionId: input.resourceRevisionId, locator: { kind: "image", pageId: input.pageId }, consume });
}

/**
 * `progress.setTime`: the playhead is here, and `played` lists stretches actually played since the last write.
 * Seeking over a part of the video never adds it to the consumed set.
 */
export function setTimeProgress(store: DrizzleStore, envelope: CommandEnvelope, grant: ScopeGrant, grants: GrantRegistry): Record<string, unknown> {
  const input = envelope.input as { contextId: string | null; resourceId: string; resourceRevisionId: string; timeMs: number; played?: Array<{ startMs: number; endMs: number }> };
  assertReadable(grants, grant, input.resourceId);
  const layout = readLayout(store, input.resourceRevisionId);
  if (!layout || layout.unit !== "ms") throw new MangaError("VALIDATION_ERROR", "this revision is not a video");
  const consume = (input.played ?? []).filter((range) => range.endMs > range.startMs).map((range) => ({ partId: TIME_RANGE, start: Math.min(range.startMs, layout.total), end: Math.min(range.endMs, layout.total) }));
  return commitProgress(store, envelope, { contextId: contextKeyOf(input.contextId), resourceId: input.resourceId, revisionId: input.resourceRevisionId, locator: { kind: "temporal", startMs: input.timeMs }, consume });
}

type ProgressRow = {
  context_id: string;
  last_locator_json: string | null;
  consumed_ranges_json: string;
  completion_state: string;
  percent: number;
  last_interaction_at: string;
};

const PROGRESS_COLUMNS = "context_id, last_locator_json, consumed_ranges_json, completion_state, percent, last_interaction_at";

function latestRevisionId(store: DrizzleStore, resourceId: string): string | undefined {
  return (store.sqlite.prepare("SELECT id FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(resourceId) as { id: string } | undefined)?.id;
}

/** The name of a context for a sentence such as "在「<名字>」看到 …": the project's name, or "最近". */
export function contextName(store: DrizzleStore, contextKey: string): string {
  if (!contextKey) return "最近";
  return (store.sqlite.prepare("SELECT name FROM projects WHERE id = ?").get(contextKey) as { name: string } | undefined)?.name ?? "最近";
}

/** The latest position of a resource's revision in a context other than this one, for "在「…」看到 …，跳过去"; null when there is none or when this context has its own. */
export function elsewhereProgress(store: DrizzleStore, contextId: string, resourceId: string, revisionId: string): { contextId: string | null; contextName: string; locator: unknown; percent: number; completion: string; lastInteractionAt: string } | null {
  if (store.sqlite.prepare("SELECT 1 FROM progress WHERE context_id = ? AND resource_id = ? AND resource_revision_id = ?").get(contextId, resourceId, revisionId)) return null;
  const other = store.sqlite.prepare(`SELECT ${PROGRESS_COLUMNS} FROM progress WHERE context_id <> ? AND resource_id = ? AND resource_revision_id = ? AND last_locator_json IS NOT NULL
    ORDER BY last_interaction_at DESC, context_id LIMIT 1`).get(contextId, resourceId, revisionId) as ProgressRow | undefined;
  return other
    ? { contextId: other.context_id || null, contextName: contextName(store, other.context_id), locator: JSON.parse(other.last_locator_json!), percent: other.percent, completion: other.completion_state, lastInteractionAt: other.last_interaction_at }
    : null;
}

/**
 * Where the resource has been taken furthest in any context (A-96, Q-33 item 4): the consumed ranges of all contexts joined, and the position of the
 * row with the highest percent. The spoiler guard, the agent's "seen" range and the subtitle window use this and nothing else; what the reader
 * restores is the current context's own position.
 */
export function frontierProgress(store: DrizzleStore, resourceId: string, revisionId: string): { locator: unknown; percent: number; consumed: ConsumedRange[]; contextId: string | null } | null {
  const rows = store.sqlite.prepare(`SELECT ${PROGRESS_COLUMNS} FROM progress WHERE resource_id = ? AND resource_revision_id = ?`).all(resourceId, revisionId) as ProgressRow[];
  if (!rows.length) return null;
  const far = [...rows].sort((a, b) => b.percent - a.percent || b.last_interaction_at.localeCompare(a.last_interaction_at))[0]!;
  return {
    locator: far.last_locator_json ? JSON.parse(far.last_locator_json) : null,
    percent: far.percent,
    consumed: mergeConsumedRanges(rows.flatMap((row) => JSON.parse(row.consumed_ranges_json) as ConsumedRange[])),
    contextId: far.context_id || null,
  };
}

/** The consumed ranges of all contexts joined; empty when nothing was read anywhere. */
export function frontierConsumed(store: DrizzleStore, resourceId: string, revisionId: string): ConsumedRange[] {
  return frontierProgress(store, resourceId, revisionId)?.consumed ?? [];
}

/**
 * `progress.get`: the position in the context asked for, with where the resource has been taken furthest anywhere (for the spoiler guard) and, when
 * this context has no position yet, the latest position in another context so the reader can offer to jump there (Q-33 item 3).
 */
export function getProgress(store: DrizzleStore, input: { contextId: string | null; resourceId: string; resourceRevisionId?: string }): Record<string, unknown> {
  const contextId = contextKeyOf(input.contextId);
  const revisionId = input.resourceRevisionId ?? latestRevisionId(store, input.resourceId);
  if (!revisionId) throw new MangaError("NOT_FOUND", "resource has no revision");
  const row = store.sqlite.prepare(`SELECT ${PROGRESS_COLUMNS} FROM progress WHERE context_id = ? AND resource_id = ? AND resource_revision_id = ?`).get(contextId, input.resourceId, revisionId) as ProgressRow | undefined;
  const frontier = frontierProgress(store, input.resourceId, revisionId);
  const layout = readLayout(store, revisionId);
  return {
    contextId: input.contextId ?? null,
    resourceId: input.resourceId,
    resourceRevisionId: revisionId,
    locator: row?.last_locator_json ? JSON.parse(row.last_locator_json) : null,
    consumed: row ? JSON.parse(row.consumed_ranges_json) : [],
    completion: row?.completion_state ?? "new",
    percent: row?.percent ?? 0,
    lastInteractionAt: row?.last_interaction_at ?? null,
    unit: layout?.unit ?? null,
    total: layout?.total ?? 0,
    farthest: frontier ? { locator: frontier.locator, percent: frontier.percent, consumed: frontier.consumed } : null,
    elsewhere: elsewhereProgress(store, contextId, input.resourceId, revisionId),
  };
}
