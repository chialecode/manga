import fs from "node:fs";
import {
  MangaError,
  METADATA_FIELD_KEYS,
  createId,
  type CommandEnvelope,
  type MetadataFieldKey,
  type MetadataFieldValue,
  type Ordinal,
  type ScopeGrant,
  type ShelfState,
  type WorkListPage,
  type WorkMediaKind,
  type WorkResourceRow,
  type WorkSummary,
} from "@manga/contracts";
import type { DrizzleStore, Mutation } from "@manga/storage-drizzle";
import type { GrantRegistry } from "./grants.ts";
import { ordinalLabel, sortKeyFor } from "./domain/ordinal.ts";
import { parseOverride, projectWork, projectedValue, type FieldOverride, type ProjectionSource, type WorkProjection } from "./domain/metadata-projection.ts";
import { readLayout } from "./domain/revision-layout.ts";
import { touchWorkMutation } from "./progress-service.ts";
import { workKindMutation } from "./reading-service.ts";

type WorkRow = {
  id: string;
  title: string;
  created_at: string;
  media_kind: string;
  shelf_state: string;
  author: string | null;
  cover_id: string | null;
  cover_state: string;
  last_resource_id: string | null;
  last_opened_at: string | null;
  projection_json: string;
  updated_at: string | null;
};

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(cursor: string): { k: Array<string | number>; id: string } | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { k?: unknown; id?: unknown };
    if (!Array.isArray(parsed.k) || typeof parsed.id !== "string" || parsed.k.some((item) => typeof item !== "string" && typeof item !== "number")) return undefined;
    return { k: parsed.k as Array<string | number>, id: parsed.id };
  } catch {
    return undefined;
  }
}

const escapeLike = (text: string) => `%${text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;

export function parseProjection(json: string): WorkProjection {
  try {
    return JSON.parse(json) as WorkProjection;
  } catch {
    return {};
  }
}

export function displayTitle(row: Pick<WorkRow, "title" | "projection_json">): string {
  const value = projectedValue(parseProjection(row.projection_json), "title");
  return typeof value === "string" && value.trim() ? value : row.title;
}

/** A change to one provider's snapshot that is about to be committed, so the projection can be computed in the same transaction. */
export type SnapshotPatch = { fields?: ProjectionSource["fields"]; fetchedAt?: string; detached?: boolean; linkState?: string };

/** Sources of a work's fields, in the shape the projection engine takes. `patch` shows the state after a pending write. */
export function projectionSources(store: DrizzleStore, workId: string, patch: Record<string, SnapshotPatch> = {}): ProjectionSource[] {
  const work = store.sqlite.prepare("SELECT title FROM works WHERE id = ?").get(workId) as { title: string } | undefined;
  const sources: ProjectionSource[] = [];
  if (work) sources.push({ id: "filename", fields: { title: work.title } });
  const rows = store.sqlite.prepare(`SELECT s.provider_id AS providerId, s.snapshot_json AS snapshot, s.fetched_at AS fetchedAt, s.detached AS detached,
      (SELECT l.link_state FROM work_links l WHERE l.work_id = s.work_id AND l.provider_id = s.provider_id ORDER BY l.confirmed_at DESC LIMIT 1) AS linkState
    FROM metadata_snapshots s WHERE s.work_id = ?`).all(workId) as Array<{ providerId: string; snapshot: string; fetchedAt: string | null; detached: number; linkState: string | null }>;
  const seen = new Set<string>();
  const resolved: Array<{ providerId: string; fields: ProjectionSource["fields"]; fetchedAt?: string; detached: boolean; linkState: string | null }> = [];
  for (const row of rows) {
    seen.add(row.providerId);
    const changed = patch[row.providerId];
    let fields: ProjectionSource["fields"] = {};
    try {
      fields = (JSON.parse(row.snapshot) as { fields?: ProjectionSource["fields"] }).fields ?? {};
    } catch {
      if (!changed?.fields) continue;
    }
    resolved.push({
      providerId: row.providerId,
      fields: changed?.fields ?? fields,
      fetchedAt: changed?.fetchedAt ?? row.fetchedAt ?? undefined,
      detached: changed?.detached ?? row.detached === 1,
      linkState: changed?.linkState ?? row.linkState,
    });
  }
  for (const [providerId, changed] of Object.entries(patch)) {
    if (!seen.has(providerId) && changed.fields) resolved.push({ providerId, fields: changed.fields, fetchedAt: changed.fetchedAt, detached: changed.detached ?? false, linkState: changed.linkState ?? null });
  }
  for (const row of resolved) {
    if (row.providerId === "local-file") sources.push({ id: "file", providerId: row.providerId, fetchedAt: row.fetchedAt, fields: row.fields });
    else if (row.detached || row.linkState === "unlinked") sources.push({ id: "detached", providerId: row.providerId, fetchedAt: row.fetchedAt, fields: row.fields });
    else sources.push({ id: "online", providerId: row.providerId, fetchedAt: row.fetchedAt, fields: row.fields });
  }
  return sources;
}

export function readOverride(store: DrizzleStore, workId: string): FieldOverride {
  return parseOverride(store.sqlite.prepare("SELECT fields_json, locked_json, cleared_json FROM metadata_overrides WHERE work_id = ?").get(workId) as { fields_json: string; locked_json: string; cleared_json: string } | undefined);
}

/** Recompute the stored projection (and the author column used for search) after anything that feeds it changed. */
export function projectionMutation(store: DrizzleStore, workId: string, now: string, patch: Record<string, SnapshotPatch> = {}, pendingOverride?: FieldOverride): Mutation {
  const projection = projectWork(projectionSources(store, workId, patch), pendingOverride ?? readOverride(store, workId));
  const author = projectedValue(projection, "author");
  return {
    sql: "UPDATE works SET projection_json = ?, author = ?, updated_at = ? WHERE id = ?",
    params: [JSON.stringify(projection), typeof author === "string" ? author : null, now, workId],
  };
}

function workOf(store: DrizzleStore, workId: string): WorkRow {
  const row = store.sqlite.prepare("SELECT * FROM works WHERE id = ?").get(workId) as WorkRow | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "work missing");
  return row;
}

function readableResourceIds(store: DrizzleStore, workId: string, grant: ScopeGrant, grants: GrantRegistry): string[] {
  const rows = store.sqlite.prepare("SELECT id FROM resources WHERE work_id = ?").all(workId) as Array<{ id: string }>;
  return rows.map((row) => row.id).filter((id) => grants.canRead(grant, id));
}

export function listWorks(store: DrizzleStore, grant: ScopeGrant, input: { limit?: number; cursor?: string; query?: string; kind?: WorkMediaKind; shelf?: ShelfState; linked?: boolean; format?: string; hasNotes?: boolean; sort?: "recent" | "added" | "title" | "progress" }): WorkListPage {
  const limit = Math.min(Math.max(input.limit ?? 60, 1), 200);
  const sort = input.sort ?? "recent";
  const where: string[] = ["EXISTS (SELECT 1 FROM resources rr WHERE rr.work_id = w.id)"];
  const params: Array<string | number> = [];
  if (grant.access !== "owner") {
    const ids = grant.readResourceIds;
    if (!ids.length) return { items: [], total: 0, nextCursor: null };
    where.push(`EXISTS (SELECT 1 FROM resources rr WHERE rr.work_id = w.id AND rr.id IN (${ids.map(() => "?").join(",")}))`);
    params.push(...ids);
  }
  if (input.kind) {
    where.push("w.media_kind = ?");
    params.push(input.kind);
  }
  if (input.shelf) {
    where.push("w.shelf_state = ?");
    params.push(input.shelf);
  }
  if (input.linked !== undefined) {
    where.push(`${input.linked ? "" : "NOT "}EXISTS (SELECT 1 FROM work_links l WHERE l.work_id = w.id AND l.link_state = 'linked')`);
  }
  if (input.format) {
    // The format a file is listed under: a comic's container, else the book format, else the video container; plain text books carry none.
    where.push(`EXISTS (SELECT 1 FROM resources rf JOIN resource_revisions vf ON vf.resource_id = rf.id WHERE rf.work_id = w.id
      AND LOWER(COALESCE(json_extract(vf.payload_json, '$.comic.source'), json_extract(vf.payload_json, '$.format'), json_extract(vf.payload_json, '$.video.container'), 'txt')) = ?)`);
    params.push(input.format.toLowerCase());
  }
  if (input.hasNotes !== undefined) {
    where.push(`${input.hasNotes ? "" : "NOT "}EXISTS (SELECT 1 FROM refs nr JOIN anchors na ON na.id = nr.to_id JOIN resources nrr ON nrr.id = na.resource_id WHERE nr.to_kind = 'anchor' AND nrr.work_id = w.id)`);
  }
  const text = input.query?.trim();
  if (text) {
    const like = escapeLike(text);
    where.push(`(w.title LIKE ? ESCAPE '\\' OR w.author LIKE ? ESCAPE '\\' OR json_extract(w.projection_json, '$.title.value') LIKE ? ESCAPE '\\' OR json_extract(w.projection_json, '$.titleOriginal.value') LIKE ? ESCAPE '\\')`);
    params.push(like, like, like, like);
  }
  // The total describes the complete filtered library; the cursor only narrows the returned page.
  const total = (store.sqlite.prepare(`SELECT COUNT(*) AS n FROM works w WHERE ${where.join(" AND ")}`).get(...params) as { n: number }).n;
  // Progress of the resource the card shows (the last opened one, else the first), on its newest revision.
  const shown = "COALESCE(w.last_resource_id, (SELECT sr.id FROM resources sr WHERE sr.work_id = w.id ORDER BY sr.sort_key, sr.created_at, sr.id LIMIT 1))";
  const progressExpr = `COALESCE((SELECT sp.percent FROM progress sp WHERE sp.resource_id = ${shown} AND sp.resource_revision_id = (SELECT sv.id FROM resource_revisions sv WHERE sv.resource_id = ${shown} ORDER BY sv.created_at DESC, sv.rowid DESC LIMIT 1)), 0)`;
  const keyExpr = sort === "recent" ? "COALESCE(w.last_opened_at, '')" : sort === "added" ? "w.created_at" : sort === "progress" ? progressExpr : "LOWER(w.title)";
  const secondExpr = sort === "recent" ? "w.created_at" : undefined;
  const direction = sort === "title" ? "ASC" : "DESC";
  const comparator = sort === "title" ? ">" : "<";
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (!decoded || decoded.k.length !== (secondExpr ? 2 : 1)) throw new MangaError("VALIDATION_ERROR", "work page cursor is invalid");
    if (secondExpr) {
      where.push(`(${keyExpr} ${comparator} ? OR (${keyExpr} = ? AND (${secondExpr} ${comparator} ? OR (${secondExpr} = ? AND w.id ${comparator} ?))))`);
      params.push(decoded.k[0]!, decoded.k[0]!, decoded.k[1]!, decoded.k[1]!, decoded.id);
    } else {
      where.push(`(${keyExpr} ${comparator} ? OR (${keyExpr} = ? AND w.id ${comparator} ?))`);
      params.push(decoded.k[0]!, decoded.k[0]!, decoded.id);
    }
  }
  const order = secondExpr ? `${keyExpr} ${direction}, ${secondExpr} ${direction}, w.id ${direction}` : `${keyExpr} ${direction}, w.id ${direction}`;
  const rows = store.sqlite.prepare(`SELECT w.*, ${keyExpr} AS k1${secondExpr ? `, ${secondExpr} AS k2` : ""} FROM works w WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`).all(...params, limit + 1) as Array<WorkRow & { k1: string; k2?: string }>;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => summarize(store, row)),
    total,
    nextCursor: rows.length > limit && last ? encodeCursor({ k: secondExpr ? [last.k1, last.k2] : [last.k1], id: last.id }) : null,
  };
}

function summarize(store: DrizzleStore, row: WorkRow): WorkSummary {
  const resourceCount = (store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources WHERE work_id = ?").get(row.id) as { n: number }).n;
  const finished = (store.sqlite.prepare(`SELECT COUNT(*) AS n FROM resources r WHERE r.work_id = ? AND EXISTS (
      SELECT 1 FROM progress p WHERE p.resource_id = r.id AND p.completion_state = 'completed')`).get(row.id) as { n: number }).n;
  const lastId = row.last_resource_id
    ?? (store.sqlite.prepare("SELECT id FROM resources WHERE work_id = ? ORDER BY sort_key, created_at, id LIMIT 1").get(row.id) as { id: string } | undefined)?.id;
  const last = lastId
    ? store.sqlite.prepare(`SELECT r.id, r.title, r.ordinal_label AS ordinalLabel, (SELECT v.id FROM resource_revisions v WHERE v.resource_id = r.id ORDER BY v.created_at DESC, v.rowid DESC LIMIT 1) AS revisionId FROM resources r WHERE r.id = ?`).get(lastId) as { id: string; title: string; ordinalLabel: string | null; revisionId: string | null } | undefined
    : undefined;
  const progress = last?.revisionId
    ? (store.sqlite.prepare("SELECT percent FROM progress WHERE resource_id = ? AND resource_revision_id = ?").get(last.id, last.revisionId) as { percent: number } | undefined)?.percent ?? 0
    : 0;
  const linked = Boolean(store.sqlite.prepare("SELECT 1 FROM work_links WHERE work_id = ? AND link_state = 'linked'").get(row.id));
  const projection = parseProjection(row.projection_json);
  const author = projectedValue(projection, "author");
  return {
    id: row.id,
    title: displayTitle(row),
    author: typeof author === "string" ? author : row.author,
    mediaKind: row.media_kind as WorkSummary["mediaKind"],
    shelf: row.shelf_state as ShelfState,
    coverId: row.cover_id,
    lastResource: last ? { id: last.id, title: last.title, ordinalLabel: last.ordinalLabel, revisionId: last.revisionId } : null,
    progress,
    finishedCount: finished,
    resourceCount,
    linked,
    createdAt: row.created_at,
    lastOpenedAt: row.last_opened_at,
  };
}

export function getWork(store: DrizzleStore, grant: ScopeGrant, grants: GrantRegistry, workId: string): Record<string, unknown> {
  const row = workOf(store, workId);
  const readable = new Set(readableResourceIds(store, workId, grant, grants));
  if (grant.access !== "owner" && !readable.size) throw new MangaError("SCOPE_DENIED", "work is outside the authorized set");
  const resourceRows = store.sqlite.prepare("SELECT id, title, kind, ordinal_label, ordinal_number, ordinal_type, sort_key FROM resources WHERE work_id = ? ORDER BY sort_key, created_at, id").all(workId) as Array<{
    id: string; title: string; kind: string; ordinal_label: string | null; ordinal_number: number | null; ordinal_type: string | null;
  }>;
  const resources: WorkResourceRow[] = resourceRows.filter((item) => readable.has(item.id)).map((item) => {
    const revision = store.sqlite.prepare("SELECT id FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(item.id) as { id: string } | undefined;
    const progress = revision ? store.sqlite.prepare("SELECT percent, completion_state, last_locator_json, last_interaction_at FROM progress WHERE resource_id = ? AND resource_revision_id = ?").get(item.id, revision.id) as { percent: number; completion_state: string; last_locator_json: string | null; last_interaction_at: string } | undefined : undefined;
    const layout = revision ? readLayout(store, revision.id) : undefined;
    const location = revision ? store.sqlite.prepare("SELECT relative_path, available FROM file_locations WHERE resource_revision_id = ? ORDER BY rowid DESC LIMIT 1").get(revision.id) as { relative_path: string; available: number } | undefined : undefined;
    return {
      id: item.id,
      title: item.title,
      kind: item.kind,
      ordinalLabel: item.ordinal_label,
      ordinalNumber: item.ordinal_number,
      ordinalType: item.ordinal_type,
      revisionId: revision?.id ?? null,
      progress: {
        percent: progress?.percent ?? 0,
        completion: progress?.completion_state ?? "new",
        locator: progress?.last_locator_json ? JSON.parse(progress.last_locator_json) : null,
        lastInteractionAt: progress?.last_interaction_at ?? null,
      },
      unit: layout?.unit ?? null,
      total: layout?.total ?? 0,
      available: location ? location.available === 1 && fs.existsSync(location.relative_path) : true,
    };
  });
  const projection = parseProjection(row.projection_json);
  const links = store.sqlite.prepare("SELECT provider_id AS providerId, external_id AS externalId, namespace, subject_type AS subjectType, link_state AS linkState, match_basis AS matchBasis, confirmed_at AS confirmedAt FROM work_links WHERE work_id = ? ORDER BY confirmed_at DESC").all(workId);
  const snapshots = store.sqlite.prepare("SELECT provider_id AS providerId, external_id AS externalId, fetched_at AS fetchedAt, source_url AS sourceUrl, api_version AS apiVersion, detached FROM metadata_snapshots WHERE work_id = ?").all(workId) as Array<{ providerId: string; externalId: string; fetchedAt: string | null; sourceUrl: string | null; apiVersion: string | null; detached: number }>;
  const override = readOverride(store, workId);
  return {
    ...summarize(store, row),
    originalTitle: row.title,
    fields: projection,
    override,
    links,
    snapshots: snapshots.map((snapshot) => ({ ...snapshot, detached: snapshot.detached === 1 })),
    coverState: row.cover_state,
    coverCount: (store.sqlite.prepare("SELECT COUNT(*) AS n FROM covers WHERE work_id = ?").get(workId) as { n: number }).n,
    resources,
  };
}

/** Which kinds a stored file can be opened as. A kind the content cannot back is refused instead of producing an empty reader. */
export function supportedKinds(store: DrizzleStore, resourceId: string): WorkMediaKind[] {
  const revision = store.sqlite.prepare("SELECT id, payload_json FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(resourceId) as { id: string; payload_json: string } | undefined;
  if (!revision) return [];
  const payload = JSON.parse(revision.payload_json) as { format?: string; video?: unknown; comic?: unknown; parts?: Array<{ kind?: string; images?: string[] }> };
  if (payload.video) return ["video"];
  if (payload.comic) return ["comic"];
  const format = payload.format ?? "txt";
  if (format === "txt") return ["novel"];
  if (format === "pdf") return ["novel", "comic"];
  const hasImages = Boolean(store.sqlite.prepare("SELECT 1 FROM resource_assets WHERE resource_revision_id = ? AND media_type LIKE 'image/%' LIMIT 1").get(revision.id))
    || (payload.parts ?? []).some((part) => part.kind === "image" || (part.images?.length ?? 0) > 0);
  return hasImages ? ["novel", "comic"] : ["novel"];
}

/** Change what a resource is opened as. The revision, its anchors and its progress stay exactly where they are. */
export function setResourceKind(store: DrizzleStore, envelope: CommandEnvelope, input: { resourceId: string; kind: WorkMediaKind }): Record<string, unknown> {
  const row = store.sqlite.prepare("SELECT work_id, kind FROM resources WHERE id = ?").get(input.resourceId) as { work_id: string | null; kind: string } | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "resource missing");
  if (!supportedKinds(store, input.resourceId).includes(input.kind)) throw new MangaError("UNSUPPORTED_FORMAT", `this file cannot be opened as ${input.kind}`);
  const now = new Date().toISOString();
  const mutations: Mutation[] = [{ sql: "UPDATE resources SET kind = ? WHERE id = ?", params: [input.kind, input.resourceId] }];
  if (row.work_id) mutations.push(workKindMutation(row.work_id, now));
  store.commit({
    mutations,
    events: [{ type: "resource.kindChanged", payload: { resourceId: input.resourceId, kind: input.kind, previous: row.kind } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: { resourceId: input.resourceId, kind: input.kind, previous: row.kind },
  });
  return { resourceId: input.resourceId, kind: input.kind, previous: row.kind, workId: row.work_id };
}

function deleteWorkMutations(workId: string): Mutation[] {
  return [
    { sql: "DELETE FROM metadata_overrides WHERE work_id = ?", params: [workId] },
    { sql: "DELETE FROM metadata_snapshots WHERE work_id = ?", params: [workId] },
    { sql: "DELETE FROM metadata_candidates WHERE work_id = ?", params: [workId] },
    { sql: "DELETE FROM work_links WHERE work_id = ?", params: [workId] },
    { sql: "DELETE FROM work_terms WHERE work_id = ?", params: [workId] },
    { sql: "DELETE FROM covers WHERE work_id = ?", params: [workId] },
    { sql: "DELETE FROM subject_characters WHERE work_id = ?", params: [workId] },
    { sql: "DELETE FROM subject_persons WHERE work_id = ?", params: [workId] },
    { sql: "DELETE FROM works WHERE id = ?", params: [workId] },
  ];
}

export function moveResource(store: DrizzleStore, envelope: CommandEnvelope, input: { resourceId: string; toWorkId?: string; newWorkTitle?: string }): Record<string, unknown> {
  const row = store.sqlite.prepare("SELECT work_id FROM resources WHERE id = ?").get(input.resourceId) as { work_id: string | null } | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "resource missing");
  const from = row.work_id;
  const now = new Date().toISOString();
  let target = input.toWorkId;
  const mutations: Mutation[] = [];
  if (target) {
    const targetRow = store.sqlite.prepare("SELECT id, media_kind FROM works WHERE id = ?").get(target);
    if (!targetRow) throw new MangaError("NOT_FOUND", "target work missing");
  } else {
    target = createId("work");
    const kind = (store.sqlite.prepare("SELECT kind FROM resources WHERE id = ?").get(input.resourceId) as { kind: string }).kind;
    mutations.push({ sql: "INSERT INTO works(id,title,created_at,media_kind,updated_at) VALUES (?,?,?,?,?)", params: [target, input.newWorkTitle!, now, kind, now] });
  }
  if (target === from) return { resourceId: input.resourceId, workId: target, moved: false };
  mutations.push({ sql: "UPDATE resources SET work_id = ? WHERE id = ?", params: [target, input.resourceId] });
  mutations.push(workKindMutation(target, now));
  // The source work keeps its covers, links and overrides while it still has resources; an empty work disappears with them.
  let removedWorkId: string | undefined;
  if (from) {
    const remaining = (store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources WHERE work_id = ? AND id <> ?").get(from, input.resourceId) as { n: number }).n;
    if (remaining === 0) {
      mutations.push(...deleteWorkMutations(from));
      removedWorkId = from;
    } else {
      mutations.push({ sql: "UPDATE works SET last_resource_id = NULL, updated_at = ? WHERE id = ? AND last_resource_id = ?", params: [now, from, input.resourceId] });
      mutations.push(workKindMutation(from, now));
    }
  }
  store.commit({
    mutations,
    events: [{ type: "resource.moved", payload: { resourceId: input.resourceId, from, to: target } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: { resourceId: input.resourceId, workId: target, removedWorkId },
  });
  return { resourceId: input.resourceId, workId: target, fromWorkId: from, removedWorkId, moved: true };
}

export function setOrdinal(store: DrizzleStore, envelope: CommandEnvelope, input: { resourceId: string; ordinal: Ordinal | null }): Record<string, unknown> {
  const row = store.sqlite.prepare("SELECT work_id, title FROM resources WHERE id = ?").get(input.resourceId) as { work_id: string | null; title: string } | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "resource missing");
  const ordinal = input.ordinal ? { ...input.ordinal, label: input.ordinal.label ?? ordinalLabel(input.ordinal) } : undefined;
  const now = new Date().toISOString();
  const mutations: Mutation[] = [{
    sql: "UPDATE resources SET ordinal_label = ?, ordinal_number = ?, ordinal_type = ?, sort_key = ? WHERE id = ?",
    params: [ordinal?.label ?? null, ordinal?.number ?? null, ordinal?.type ?? null, sortKeyFor(ordinal, row.title), input.resourceId],
  }];
  if (row.work_id) mutations.push(workKindMutation(row.work_id, now));
  store.commit({
    mutations,
    events: [{ type: "resource.ordinalChanged", payload: { resourceId: input.resourceId } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: { resourceId: input.resourceId, label: ordinal?.label ?? null },
  });
  return { resourceId: input.resourceId, label: ordinal?.label ?? null, number: ordinal?.number ?? null, type: ordinal?.type ?? null };
}

export function setShelf(store: DrizzleStore, envelope: CommandEnvelope, input: { workId: string; state: ShelfState }): Record<string, unknown> {
  const row = workOf(store, input.workId);
  const now = new Date().toISOString();
  store.commit({
    mutations: [{ sql: "UPDATE works SET shelf_state = ?, updated_at = ? WHERE id = ?", params: [input.state, now, input.workId] }],
    events: [{ type: "work.shelfChanged", payload: { workId: input.workId, state: input.state, previous: row.shelf_state } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: { workId: input.workId, state: input.state },
  });
  return { workId: input.workId, state: input.state, previous: row.shelf_state };
}

/**
 * User override of projected fields. A locked field without a typed value is pinned to whatever it shows now,
 * so a later refresh cannot move it; a cleared field stays empty on purpose.
 */
export function setOverride(store: DrizzleStore, envelope: CommandEnvelope, input: { workId: string; fields: Partial<Record<MetadataFieldKey, MetadataFieldValue>>; locked: MetadataFieldKey[]; cleared: MetadataFieldKey[] }): Record<string, unknown> {
  const row = workOf(store, input.workId);
  const valid = new Set<string>(METADATA_FIELD_KEYS);
  const fields: Partial<Record<MetadataFieldKey, MetadataFieldValue>> = {};
  for (const [key, value] of Object.entries(input.fields)) {
    if (!valid.has(key)) throw new MangaError("VALIDATION_ERROR", `unknown field ${key}`);
    fields[key as MetadataFieldKey] = value as MetadataFieldValue;
  }
  const projection = parseProjection(row.projection_json);
  for (const key of input.locked) {
    if (fields[key] === undefined) {
      const current = projectedValue(projection, key);
      if (current !== null) fields[key] = current;
    }
  }
  const cleared = input.cleared.filter((key) => fields[key] === undefined);
  const locked = input.locked.filter((key) => fields[key] !== undefined);
  const now = new Date().toISOString();
  // Write the override first so the projection read below sees it, then commit both together.
  const merged: FieldOverride = { fields, locked, cleared };
  const sources = projectionSources(store, input.workId);
  const next = projectWork(sources, merged);
  const author = projectedValue(next, "author");
  store.commit({
    mutations: [
      {
        sql: "INSERT INTO metadata_overrides(work_id, fields_json, locked_json, cleared_json) VALUES (?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET fields_json = excluded.fields_json, locked_json = excluded.locked_json, cleared_json = excluded.cleared_json",
        params: [input.workId, JSON.stringify(fields), JSON.stringify(locked), JSON.stringify(cleared)],
      },
      { sql: "UPDATE works SET projection_json = ?, author = ?, updated_at = ? WHERE id = ?", params: [JSON.stringify(next), typeof author === "string" ? author : null, now, input.workId] },
    ],
    events: [{ type: "work.overridden", payload: { workId: input.workId } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: { workId: input.workId, fields: Object.keys(fields), locked, cleared },
  });
  return { workId: input.workId, fields: next, override: merged };
}

/** The user opened this resource: it becomes the work's latest, and the first open moves a wishlist work to "reading". */
export function openResource(store: DrizzleStore, envelope: CommandEnvelope, input: { resourceId: string }): Record<string, unknown> {
  const row = store.sqlite.prepare("SELECT r.work_id AS workId, w.shelf_state AS shelf, w.last_opened_at AS openedAt FROM resources r LEFT JOIN works w ON w.id = r.work_id WHERE r.id = ?").get(input.resourceId) as { workId: string | null; shelf: string | null; openedAt: string | null } | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "resource missing");
  const now = new Date().toISOString();
  const promoted = row.openedAt === null && (row.shelf === "none" || row.shelf === "wishlist");
  store.commit({
    mutations: [touchWorkMutation(input.resourceId, now)],
    events: [{ type: "work.opened", payload: { workId: row.workId, resourceId: input.resourceId } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: { workId: row.workId, resourceId: input.resourceId, shelf: promoted ? "reading" : row.shelf },
  });
  return { workId: row.workId, resourceId: input.resourceId, shelf: promoted ? "reading" : row.shelf, promoted };
}
