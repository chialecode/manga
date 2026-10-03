import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_SHELL_PREFERENCE,
  MangaError,
  NOTE_TAG_MAX,
  ShellPreferenceSchema,
  createId,
  type CommandEnvelope,
  type NoteDocument,
  type ScopeGrant,
  type SearchHit,
  type ShellPreference,
  type SourceLocator,
  type TextLocator,
} from "@manga/contracts";
import type { DrizzleStore, Mutation } from "@manga/storage-drizzle";
import { findQuoteMatches, resolveTextLocator } from "./domain/anchors.ts";
import type { ParsedAsset, ParsedDocument, PdfTextRun } from "./domain/formats.ts";
import { documentLength, slicePart } from "./domain/formats.ts";
import { applyNoteOp, coerceNoteDocument, notePlainText, type NoteOp } from "./domain/note-document.ts";
import { codePointLength, createTextLocator, sliceCodePoints } from "./domain/text.ts";
import type { GrantRegistry } from "./grants.ts";

const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;

export function readShell(store: DrizzleStore): ShellPreference {
  const row = store.sqlite.prepare("SELECT value_json FROM config WHERE key = 'shell.layout'").get() as { value_json: string } | undefined;
  if (!row) return structuredClone(DEFAULT_SHELL_PREFERENCE);
  const parsed = ShellPreferenceSchema.safeParse(JSON.parse(row.value_json));
  return parsed.success ? parsed.data : structuredClone(DEFAULT_SHELL_PREFERENCE);
}

export function writeShell(store: DrizzleStore, current: ShellPreference, patch: {
  mode?: ShellPreference["mode"];
  spoilerGuard?: boolean;
  focus?: boolean;
  left?: { visible?: boolean; width?: number };
  right?: { visible?: boolean; width?: number };
  reading?: Partial<ShellPreference["reading"]>;
}, envelope: CommandEnvelope): ShellPreference {
  const mode = patch.mode ?? current.mode;
  const layout = current.layouts[mode];
  const next = ShellPreferenceSchema.parse({
    ...current,
    mode,
    spoilerGuard: patch.spoilerGuard ?? current.spoilerGuard,
    reading: { ...current.reading, ...patch.reading },
    layouts: {
      ...current.layouts,
      [mode]: {
        focus: patch.focus ?? layout.focus,
        left: { ...layout.left, ...patch.left },
        right: { ...layout.right, ...patch.right },
      },
    },
  });
  const row = store.sqlite.prepare("SELECT revision FROM config WHERE key = 'shell.layout'").get() as { revision: number } | undefined;
  store.commit({
    mutations: [{
      sql: "INSERT INTO config(key, revision, value_json) VALUES ('shell.layout', 1, ?) ON CONFLICT(key) DO UPDATE SET revision = revision + 1, value_json = excluded.value_json",
      params: [JSON.stringify(next)],
    }],
    events: [{ type: "shell.updated", payload: { mode: next.mode, revision: (row?.revision ?? 0) + 1 } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: next,
  });
  return next;
}

type StoredPlacement = { assetId: string; offset: number; width?: number; height?: number };
type StoredPart = { id: string; title?: string; normalized: string; kind?: "text" | "scan" | "image"; parserVersion?: string; images?: string[]; placements?: StoredPlacement[]; index?: number; sourceHref?: string; render?: { w: number; h: number; items: unknown[]; truncated?: boolean }; textRuns?: PdfTextRun[] };
type StoredPayload = {
  id?: string;
  format?: string;
  parserId?: string;
  normalized?: string;
  parserVersion?: string;
  parts?: StoredPart[];
  toc?: Array<{ label: string; partId: string }>;
  traits?: Record<string, unknown>;
  warnings?: string[];
  stylesheets?: Array<{ href: string; text: string }>;
  authorStyle?: Record<string, unknown>;
};

export function payloadParts(payload: StoredPayload): StoredPart[] {
  if (payload.parts?.length) return payload.parts.map((part) => ({ ...part, kind: part.kind ?? "text", normalized: part.normalized ?? "" }));
  return [{ id: "body", normalized: payload.normalized ?? "", kind: "text", parserVersion: payload.parserVersion }];
}

/** Assets are stored as rows so a fixed-layout page or illustration survives a restart without the original file. */
function assetMutations(store: DrizzleStore, input: {
  resourceId: string;
  revisionId: string;
  now: string;
  assets: ParsedAsset[];
}): Mutation[] {
  return input.assets.map((asset) => ({
    sql: "INSERT OR REPLACE INTO resource_assets(id, resource_id, resource_revision_id, part_id, name, media_type, hash, bytes, payload, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    params: [
      `${input.revisionId}:${asset.id}`,
      input.resourceId,
      input.revisionId,
      asset.partId,
      asset.name,
      asset.mediaType,
      createHash("sha256").update(asset.bytes).digest("hex"),
      asset.bytes.byteLength,
      Buffer.from(asset.bytes),
      input.now,
    ],
  }));
}

export function readAsset(store: DrizzleStore, revisionId: string, assetId: string): { mediaType: string; name: string; bytes: Buffer } | undefined {
  const row = store.sqlite.prepare("SELECT media_type AS mediaType, name, payload FROM resource_assets WHERE id = ?").get(`${revisionId}:${assetId}`) as { mediaType: string; name: string; payload: Buffer } | undefined;
  return row ? { mediaType: row.mediaType, name: row.name, bytes: row.payload } : undefined;
}

export function listAssets(store: DrizzleStore, revisionId: string, partId?: string): Array<{ id: string; partId: string; name: string; mediaType: string; bytes: number }> {
  const rows = store.sqlite.prepare("SELECT id, part_id AS partId, name, media_type AS mediaType, bytes FROM resource_assets WHERE resource_revision_id = ? ORDER BY rowid").all(revisionId);
  return (rows as Array<{ id: string; partId: string; name: string; mediaType: string; bytes: number }>)
    // An asset shared by several parts carries a comma-separated key, so a plain equality would hide it in the reader.
    .filter((row) => !partId || row.partId.split(",").includes(partId))
    .map((row) => ({
      ...row,
      id: row.id.startsWith(`${revisionId}:`) ? row.id.slice(revisionId.length + 1) : row.id,
    }));
}

/** Code points indexed in one turn so a large book does not hold the process for the whole file. */
const INDEX_TURN_CODE_POINTS = 4000 * 16;

function textChunkCount(text: string, size = 4000): number {
  let count = 0;
  let index = 0;
  while (index < text.length) {
    let taken = 0;
    let cursor = index;
    while (cursor < text.length && taken < size) {
      const code = text.codePointAt(cursor) ?? 0;
      cursor += code > 0xffff ? 2 : 1;
      taken += 1;
    }
    if (cursor === index) break;
    count += 1;
    index = cursor;
  }
  return count;
}

function takeCodePoints(text: string, start: number, count: number): { slice: string; next: number; taken: number } {
  let taken = 0;
  let cursor = start;
  while (cursor < text.length && taken < count) {
    const code = text.codePointAt(cursor) ?? 0;
    cursor += code > 0xffff ? 2 : 1;
    taken += 1;
  }
  return { slice: text.slice(start, cursor), next: cursor, taken };
}

const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Write the body index in short commits so a save or a click can run between them. */
async function writeBodyIndex(store: DrizzleStore, input: { resourceId: string; revisionId: string; parts: Array<{ id?: string; normalized?: string; kind?: string }> }): Promise<void> {
  for (const part of input.parts) {
    if (part.kind !== "text") continue;
    const text = part.normalized ?? "";
    let utf16 = 0;
    let codePoints = 0;
    while (utf16 < text.length) {
      const window = takeCodePoints(text, utf16, INDEX_TURN_CODE_POINTS);
      const mutations = store.indexTextChunks({
        resourceId: input.resourceId,
        resourceRevisionId: input.revisionId,
        partId: part.id || "body",
        representationId: input.revisionId,
        kind: "body",
        text: window.slice,
        startOffset: codePoints,
      });
      if (mutations.length) store.commit({ mutations, events: [] });
      codePoints += window.taken;
      utf16 = window.next;
      if (utf16 < text.length) await yieldTurn();
    }
  }
}

/** A crash between the revision row and the last index batch must be able to finish the same text. */
async function ensureBodyIndex(store: DrizzleStore, input: { resourceId: string; revisionId: string; parts: Array<{ id?: string; normalized?: string; kind?: string }> }): Promise<void> {
  const expected = input.parts.filter((part) => part.kind === "text").reduce((sum, part) => sum + textChunkCount(part.normalized ?? ""), 0);
  const actual = (store.sqlite.prepare("SELECT COUNT(*) AS n FROM text_fragments WHERE resource_revision_id = ? AND object_id IS NULL AND kind = 'body'").get(input.revisionId) as { n: number }).n;
  if (actual === expected) return;
  store.commit({
    mutations: [
      { sql: "DELETE FROM search_idx WHERE fragment_id IN (SELECT id FROM text_fragments WHERE resource_revision_id = ? AND object_id IS NULL AND kind = 'body')", params: [input.revisionId] },
      { sql: "DELETE FROM text_fragments WHERE resource_revision_id = ? AND object_id IS NULL AND kind = 'body'", params: [input.revisionId] },
    ],
    events: [],
  });
  await writeBodyIndex(store, input);
}

export async function persistParsedDocument(store: DrizzleStore, input: {
  title: string;
  bytes: Uint8Array;
  parsed: ParsedDocument;
  sourcePath?: string;
  hosted: boolean;
  resourceId?: string;
  idempotencyKey: string;
  commandId: string;
}): Promise<Record<string, unknown>> {
  if (!input.sourcePath && input.parsed.format === "pdf") input.hosted = true;
  if (input.bytes.byteLength > MAX_DOCUMENT_BYTES) throw new MangaError("UNSUPPORTED_FORMAT", "document is larger than the current read budget");
  const fingerprint = createHash("sha256").update(input.bytes).digest("hex");
  const now = new Date().toISOString();
  if (input.resourceId) {
    const existing = store.sqlite.prepare("SELECT id, fingerprint FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC LIMIT 1").get(input.resourceId) as { id: string; fingerprint: string } | undefined;
    // A resource whose revision row is gone can still be repaired by re-reading the file the user picks.
    if (!existing) {
      const resource = store.sqlite.prepare("SELECT id FROM resources WHERE id = ?").get(input.resourceId);
      if (!resource) throw new MangaError("NOT_FOUND", "resource missing");
      return insertRevision(store, { ...input, fingerprint, now, resourceId: input.resourceId });
    }
    if (existing.fingerprint === fingerprint) {
      if (input.sourcePath) {
        const updated = store.sqlite.prepare("UPDATE file_locations SET relative_path = ?, available = 1, fingerprint = ? WHERE resource_revision_id = ?").run(input.sourcePath, fingerprint, existing.id);
        if (updated.changes === 0) {
          store.sqlite.prepare("INSERT INTO file_locations(id, resource_revision_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,1,?)").run(createId("loc"), existing.id, input.sourcePath, fingerprint, input.hosted ? 1 : 0);
        }
      }
      await ensureBodyIndex(store, { resourceId: input.resourceId, revisionId: existing.id, parts: input.parsed.parts });
      const result = { resourceId: input.resourceId, revisionId: existing.id, replaced: false, duplicate: true };
      store.commit({ mutations: [], events: [], idempotencyKey: input.idempotencyKey, commandId: input.commandId, result });
      return result;
    }
    return insertRevision(store, { ...input, fingerprint, now, resourceId: input.resourceId });
  }
  if (input.sourcePath) {
    const existing = store.sqlite.prepare(`SELECT r.id AS resourceId, v.id AS revisionId, v.fingerprint AS fingerprint
      FROM file_locations fl
      JOIN resource_revisions v ON v.id = fl.resource_revision_id
      JOIN resources r ON r.id = v.resource_id
      WHERE fl.relative_path = ?
      ORDER BY v.created_at DESC LIMIT 1`).get(input.sourcePath) as { resourceId: string; revisionId: string; fingerprint: string } | undefined;
    if (existing && existing.fingerprint === fingerprint) {
      await ensureBodyIndex(store, { resourceId: existing.resourceId, revisionId: existing.revisionId, parts: input.parsed.parts });
      const result = { resourceId: existing.resourceId, revisionId: existing.revisionId, replaced: false, duplicate: true, format: input.parsed.format };
      store.commit({ mutations: [], events: [], idempotencyKey: input.idempotencyKey, commandId: input.commandId, result });
      return result;
    }
    if (existing) return insertRevision(store, { ...input, fingerprint, now, resourceId: existing.resourceId });
  }
  return insertRevision(store, { ...input, fingerprint, now, resourceId: createId("res"), createWork: true });
}

/**
 * A resource can be re-read onto a new revision while the old revision row is gone. Every stored pointer
 * of that resource then names a revision nothing can resolve, so the re-read moves it onto the new text.
 * A pointer only moves when its recorded quote has exactly one home in the new text; anything else stays
 * where it is, which keeps the note in the "source needs repair" state instead of jumping to a different
 * sentence and presenting the guess as fact.
 */
function relocationMutations(store: DrizzleStore, input: { resourceId: string; revisionId: string; parts: StoredPart[] }): { mutations: Mutation[]; moved: number; kept: number } {
  const pointers = store.sqlite.prepare(`SELECT resource_revision_id AS revisionId FROM anchors WHERE resource_id = ?
    UNION SELECT resource_revision_id FROM bookmarks WHERE resource_id = ?
    UNION SELECT resource_revision_id FROM progress WHERE resource_id = ?`).all(input.resourceId, input.resourceId, input.resourceId) as Array<{ revisionId: string }>;
  const orphans = [...new Set(pointers.map((row) => row.revisionId))]
    .filter((id) => id !== input.revisionId && !store.sqlite.prepare("SELECT id FROM resource_revisions WHERE id = ?").get(id));
  if (!orphans.length) return { mutations: [], moved: 0, kept: 0 };
  const placeholders = orphans.map(() => "?").join(",");
  const move = (locator: SourceLocator): SourceLocator | null => {
    // A page locator keeps its page id: the page tree is the only identity evidence available, and the
    // row's revision column is what the source card reads.
    if (locator.kind === "image") return locator;
    // Playback locators belong to a later milestone, so they are left untouched rather than guessed.
    if (locator.kind !== "text") return null;
    const part = input.parts.find((item) => item.id === locator.partId && item.kind === "text")
      ?? (input.parts.length === 1 && input.parts[0]?.kind === "text" ? input.parts[0] : undefined);
    // Nothing to point at in the new revision (a different format or a scan), so the pointer keeps its
    // old revision and the note keeps asking for a file that carries the text.
    if (!part) return null;
    const exact = locator.quote?.exact;
    const matches = exact ? findQuoteMatches(part.normalized, exact) : [];
    if (matches.length === 1) return { ...locator, representationId: input.revisionId, partId: part.id, range: matches[0]! };
    // The quote moved ambiguously or is gone. The pointer follows the new revision with its old range,
    // and the resolver reports needs_review/unresolved instead of a link nobody verified.
    return { ...locator, representationId: input.revisionId, partId: part.id };
  };
  const mutations: Mutation[] = [];
  let moved = 0;
  let kept = 0;
  for (const table of ["anchors", "bookmarks"] as const) {
    const rows = store.sqlite.prepare(`SELECT id, locator_json AS locator FROM ${table} WHERE resource_id = ? AND resource_revision_id IN (${placeholders})`).all(input.resourceId, ...orphans) as Array<{ id: string; locator: string }>;
    for (const row of rows) {
      const next = move(JSON.parse(row.locator) as SourceLocator);
      if (!next) { kept += 1; continue; }
      moved += 1;
      mutations.push({ sql: `UPDATE ${table} SET resource_revision_id = ?, locator_json = ? WHERE id = ?`, params: [input.revisionId, JSON.stringify(next), row.id] });
    }
  }
  const progress = store.sqlite.prepare(`SELECT resource_revision_id AS revisionId, last_locator_json AS locator FROM progress WHERE resource_id = ? AND resource_revision_id IN (${placeholders})`).all(input.resourceId, ...orphans) as Array<{ revisionId: string; locator: string | null }>;
  for (const row of progress) {
    const next = row.locator ? move(JSON.parse(row.locator) as SourceLocator) : null;
    if (row.locator && !next) { kept += 1; continue; }
    moved += 1;
    mutations.push({
      sql: "UPDATE progress SET resource_revision_id = ?, last_locator_json = ? WHERE resource_id = ? AND resource_revision_id = ?",
      params: [input.revisionId, next ? JSON.stringify(next) : null, input.resourceId, row.revisionId],
    });
  }
  return { mutations, moved, kept };
}

async function insertRevision(store: DrizzleStore, input: {
  title: string;
  bytes: Uint8Array;
  parsed: ParsedDocument;
  sourcePath?: string;
  hosted: boolean;
  idempotencyKey: string;
  commandId: string;
  fingerprint: string;
  now: string;
  resourceId: string;
  createWork?: boolean;
}): Promise<Record<string, unknown>> {
  const workId = createId("work");
  const revisionId = createId("rev");
  const locationId = createId("loc");
  let locationPath = input.sourcePath ?? "";
  if (input.hosted) {
    locationPath = path.join(store.attachmentsDir, `${revisionId}.bin`);
    fs.writeFileSync(locationPath, input.bytes);
  }
  const payload = {
    id: revisionId,
    format: input.parsed.format,
    parserId: input.parsed.parserId,
    parts: input.parsed.parts,
    toc: input.parsed.toc,
    traits: input.parsed.traits,
    warnings: input.parsed.warnings,
    stylesheets: input.parsed.stylesheets ?? [],
    authorStyle: input.parsed.authorStyle ?? undefined,
    normalized: input.parsed.parts.length === 1 ? input.parsed.parts[0]?.normalized ?? "" : undefined,
    parserVersion: input.parsed.parts[0]?.parserVersion,
  };
  const mutations: Mutation[] = [];
  if (input.createWork) {
    mutations.push(
      { sql: "INSERT INTO works(id,title,created_at) VALUES (?,?,?)", params: [workId, input.parsed.title || input.title, input.now] },
      { sql: "INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?,?,?,?,?,?)", params: [input.resourceId, workId, "novel", input.parsed.title || input.title, JSON.stringify([input.parsed.title || input.title]), input.now] },
    );
  }
  mutations.push({
    sql: "INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)",
    params: [revisionId, input.resourceId, input.fingerprint, input.parsed.parserId, JSON.stringify(payload), input.now],
  });
  if (locationPath) {
    mutations.push({
      sql: "INSERT INTO file_locations(id, resource_revision_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,1,?)",
      params: [locationId, revisionId, locationPath, input.fingerprint, input.hosted ? 1 : 0],
    });
  }
  if (input.createWork) mutations.push(...store.indexFragment({ id: createId("frag"), resourceId: input.resourceId, kind: "title", text: input.parsed.title || input.title }));
  mutations.push(...assetMutations(store, { resourceId: input.resourceId, revisionId, now: input.now, assets: input.parsed.assets ?? [] }));
  // Reader pointers and notes left over from a revision nothing can resolve follow the new text.
  const relocation = input.createWork ? { mutations: [], moved: 0, kept: 0 } : relocationMutations(store, { resourceId: input.resourceId, revisionId, parts: payloadParts(payload) });
  mutations.push(...relocation.mutations);
  // The revision is readable before its index finishes. The command receipt is written only after the
  // index, so a crash in between resumes indexing instead of replaying a book that cannot be searched.
  store.commit({ mutations, events: [] });
  await writeBodyIndex(store, { resourceId: input.resourceId, revisionId, parts: input.parsed.parts });
  const result = { resourceId: input.resourceId, revisionId, format: input.parsed.format, parts: input.parsed.parts.length, relocated: relocation.moved, pointersKept: relocation.kept };
  store.commit({
    mutations: [],
    events: [{ type: "resource.imported", payload: { resourceId: input.resourceId, revisionId, format: input.parsed.format } }],
    idempotencyKey: input.idempotencyKey,
    commandId: input.commandId,
    result,
  });
  return {
    resourceId: input.resourceId,
    workId: input.createWork ? workId : undefined,
    revisionId,
    format: input.parsed.format,
    parserId: input.parsed.parserId,
    traits: input.parsed.traits,
    parts: input.parsed.parts.length,
    relocated: relocation.moved,
    pointersKept: relocation.kept,
    hosted: input.hosted,
    indexedOriginal: Boolean(input.sourcePath) && !input.hosted,
    replaced: !input.createWork,
  };
}

function loadRevision(store: DrizzleStore, resourceId: string, revisionId?: string): { revisionId: string; payload: StoredPayload; title: string } {
  const row = revisionId
    ? store.sqlite.prepare("SELECT r.title, v.id AS revisionId, v.payload_json FROM resources r JOIN resource_revisions v ON v.id = ? AND v.resource_id = r.id WHERE r.id = ?").get(revisionId, resourceId) as { title: string; revisionId: string; payload_json: string } | undefined
    : store.sqlite.prepare("SELECT r.title, v.id AS revisionId, v.payload_json FROM resources r JOIN resource_revisions v ON v.resource_id = r.id WHERE r.id = ? ORDER BY v.created_at DESC LIMIT 1").get(resourceId) as { title: string; revisionId: string; payload_json: string } | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "resource missing");
  return { revisionId: row.revisionId, title: row.title, payload: JSON.parse(row.payload_json) as StoredPayload };
}

/**
 * Owner-only bytes of the revision's original file. A missing or changed file returns no bytes,
 * so a later revision cannot be shown in its place.
 */
export function readOriginal(store: DrizzleStore, resourceId: string, revisionId?: string): { available: false; reason: string } | { available: true; bytes: Uint8Array; fingerprint: string; revisionId: string } {
  const loaded = loadRevision(store, resourceId, revisionId);
  const revision = store.sqlite.prepare("SELECT fingerprint FROM resource_revisions WHERE id = ?").get(loaded.revisionId) as { fingerprint: string } | undefined;
  const location = store.sqlite.prepare("SELECT relative_path, fingerprint, available FROM file_locations WHERE resource_revision_id = ? ORDER BY rowid DESC LIMIT 1").get(loaded.revisionId) as { relative_path: string; fingerprint: string; available: number } | undefined;
  if (!revision || !location || location.available !== 1 || !location.relative_path || !fs.existsSync(location.relative_path)) {
    return { available: false, reason: "original is not available" };
  }
  const bytes = new Uint8Array(fs.readFileSync(location.relative_path));
  const fingerprint = createHash("sha256").update(bytes).digest("hex");
  if (fingerprint !== revision.fingerprint || fingerprint !== location.fingerprint) {
    return { available: false, reason: "original no longer matches this revision" };
  }
  return { available: true, bytes, fingerprint, revisionId: loaded.revisionId };
}

/**
 * Whether the resource still has a usable original file outside one revision. A superseded revision keeps
 * its stored text, so once the user re-picks the file for the resource the reader must stop asking for it.
 */
function resourceFileElsewhere(store: DrizzleStore, resourceId: string, exceptRevisionId: string): boolean {
  const rows = store.sqlite.prepare(`SELECT fl.relative_path AS path FROM file_locations fl
    JOIN resource_revisions v ON v.id = fl.resource_revision_id
    WHERE v.resource_id = ? AND v.id <> ? AND fl.available = 1`).all(resourceId, exceptRevisionId) as Array<{ path: string }>;
  return rows.some((row) => row.path && fs.existsSync(row.path));
}

export function readDocument(store: DrizzleStore, resourceId: string, revisionId?: string): Record<string, unknown> {
  const loaded = loadRevision(store, resourceId, revisionId);
  const parts = payloadParts(loaded.payload);
  const location = store.sqlite.prepare("SELECT relative_path, available, hosted FROM file_locations WHERE resource_revision_id = ? ORDER BY rowid DESC LIMIT 1").get(loaded.revisionId) as { relative_path: string; available: number; hosted: number } | undefined;
  let available = location ? location.available === 1 : true;
  if (location && !fs.existsSync(location.relative_path)) {
    available = false;
    store.sqlite.prepare("UPDATE file_locations SET available = 0 WHERE resource_revision_id = ?").run(loaded.revisionId);
  }
  // This revision keeps its text even when its own file is gone, so the resource counts as readable when
  // another revision holds a file the user already picked.
  const revisionFileMissing = !available && location !== undefined;
  const supersededFile = revisionFileMissing && resourceFileElsewhere(store, resourceId, loaded.revisionId);
  const progressRow = store.sqlite.prepare("SELECT last_locator_json, consumed_ranges_json, completion_state FROM progress WHERE resource_id = ? AND resource_revision_id = ?").get(resourceId, loaded.revisionId) as { last_locator_json: string | null; consumed_ranges_json: string; completion_state: string } | undefined;
  const progress = progressRow
    ? { locator: progressRow.last_locator_json ? JSON.parse(progressRow.last_locator_json) as Record<string, unknown> : null, consumed: JSON.parse(progressRow.consumed_ranges_json), completion: progressRow.completion_state }
    : null;
  const assets = listAssets(store, loaded.revisionId);
  // Restore the stored reading position when it still resolves inside this revision. The window starts
  // just before the stored offset so reopening lands where the reader stopped instead of at the top.
  const storedLocator = progress?.locator as { kind?: string; partId?: string; range?: { start: number; end: number } } | null;
  const restoredPart = storedLocator?.kind === "text" && storedLocator.partId
    ? parts.find((part) => part.id === storedLocator.partId)
    : undefined;
  const first = restoredPart ?? parts[0];
  const storedRange = restoredPart && storedLocator?.range ? storedLocator.range : undefined;
  const sliceStart = storedRange ? Math.max(0, storedRange.start - 200) : 0;
  const sliceLimit = storedRange ? Math.min(4000, Math.max(1200, storedRange.end - sliceStart)) : 1200;
  const slice = first
    ? first.kind === "image"
      ? { text: "", start: 0, end: 0 }
      : slicePart(first, sliceStart, sliceLimit)
    : { text: "", start: 0, end: 0 };
  return {
    resourceId,
    revisionId: loaded.revisionId,
    title: loaded.title,
    format: loaded.payload.format ?? "txt",
    parserId: loaded.payload.parserId ?? loaded.payload.parserVersion,
    traits: loaded.payload.traits ?? {},
    warnings: loaded.payload.warnings ?? [],
    stylesheets: loaded.payload.stylesheets ?? [],
    authorStyle: loaded.payload.authorStyle ?? null,
    toc: loaded.payload.toc ?? parts.map((part) => ({ label: part.title || part.id, partId: part.id })),
    parts: parts.map((part) => ({
      id: part.id,
      title: part.title,
      kind: part.kind ?? "text",
      length: documentLength(part),
      textLayer: part.kind === "text",
      imageCount: part.images?.length ?? 0,
      index: part.index,
      hasRender: Boolean(part.render) || Boolean(part.textRuns?.length),
    })),
    slice: first
      ? {
        partId: first.id,
        ...slice,
        kind: first.kind ?? "text",
        textLayer: first.kind === "text",
        images: assets.filter((asset) => assetMatchesPart(asset.partId, first.id) && asset.mediaType.startsWith("image/")),
        placements: placementsInWindow(first, slice.start, slice.end),
        ...(first.render ? { render: first.render } : {}),
      }
      : null,
    progress: progress
      ? {
        ...progress,
        restoredPartId: first?.id ?? null,
        // Only a locator that resolved inside this revision counts as restored; otherwise the reader starts at the top.
        restoredFrom: restoredPart ? "progress" : "start",
        restoredRange: storedRange ?? null,
      }
      : { locator: null, consumed: [], completion: "new", restoredPartId: first?.id ?? null, restoredFrom: "start", restoredRange: null },
    // The read range the reader may show without widening consumed progress.
    readRanges: progress?.consumed ?? [],
    assets,
    source: location
      ? { path: location.relative_path, available: available || supersededFile, hosted: location.hosted === 1, revisionFileMissing, supersededFile }
      : { available: true, hosted: false, revisionFileMissing: false, supersededFile: false },
  };
}

/** One asset row may be shared by several parts, which are stored as a comma-separated key. */
function assetMatchesPart(assetPartId: string, partId: string): boolean {
  return assetPartId.split(",").includes(partId);
}

export function readSlice(store: DrizzleStore, input: { resourceId: string; revisionId?: string; partId: string; start?: number; limit?: number }): Record<string, unknown> {
  const loaded = loadRevision(store, input.resourceId, input.revisionId);
  const part = payloadParts(loaded.payload).find((item) => item.id === input.partId);
  if (!part) throw new MangaError("NOT_FOUND", "resource part missing");
  const assets = listAssets(store, loaded.revisionId, part.id);
  if (part.kind === "image") {
    return { resourceId: input.resourceId, revisionId: loaded.revisionId, partId: part.id, kind: "image", textLayer: false, ocr: false, text: "", start: 0, end: 0, images: assets.filter((asset) => asset.mediaType.startsWith("image/")), placements: part.placements ?? [], ...(part.render ? { render: part.render } : {}) };
  }
  const slice = slicePart(part, input.start ?? 0, input.limit ?? 1200);
  return { resourceId: input.resourceId, revisionId: loaded.revisionId, partId: part.id, kind: "text", textLayer: true, ...slice, images: assets.filter((asset) => asset.mediaType.startsWith("image/")), placements: placementsInWindow(part, slice.start, slice.end), ...(part.render ? { render: part.render } : {}) };
}

function placementsInWindow(part: StoredPart, start: number, end: number): StoredPlacement[] {
  return (part.placements ?? []).filter((item) => item.offset >= start && item.offset <= end);
}

/** Follow a bookmark or search hit back into its page; opening a bookmark never marks it read. */
export function readRangeRaw(store: DrizzleStore, input: { resourceId: string; resourceRevisionId: string; partId: string; start: number; end: number }): Record<string, unknown> {
  const row = store.sqlite.prepare("SELECT payload_json FROM resource_revisions WHERE id = ? AND resource_id = ?").get(input.resourceRevisionId, input.resourceId) as { payload_json: string } | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "resource revision missing");
  const part = payloadParts(JSON.parse(row.payload_json) as StoredPayload).find((item) => item.id === input.partId);
  if (!part) throw new MangaError("NOT_FOUND", "resource part missing");
  return { resourceId: input.resourceId, resourceRevisionId: input.resourceRevisionId, ...slicePart(part, input.start, Math.max(1, input.end - input.start)), textLayer: part.kind === "text" };
}

export function setProgress(store: DrizzleStore, envelope: CommandEnvelope, grant: ScopeGrant, grants: GrantRegistry): Record<string, unknown> {
  const input = envelope.input as { resourceId: string; resourceRevisionId: string; locator: SourceLocator; consumed?: boolean };
  if (!grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
  const row = store.sqlite.prepare("SELECT id FROM resource_revisions WHERE id = ? AND resource_id = ?").get(input.resourceRevisionId, input.resourceId);
  if (!row) throw new MangaError("NOT_FOUND", "resource revision does not belong to this resource");
  const existing = store.sqlite.prepare("SELECT consumed_ranges_json FROM progress WHERE resource_id = ? AND resource_revision_id = ?").get(input.resourceId, input.resourceRevisionId) as { consumed_ranges_json: string } | undefined;
  const consumed = existing ? JSON.parse(existing.consumed_ranges_json) as Array<{ partId?: string; start: number; end: number }> : [];
  if (input.consumed && input.locator.kind === "text") consumed.push({ partId: input.locator.partId, start: input.locator.range.start, end: input.locator.range.end });
  // Repeated "mark read here" must not inflate the visible range count, so ranges are merged on write.
  const merged = mergeConsumedRanges(consumed);
  const now = new Date().toISOString();
  store.commit({
    mutations: [{
      sql: `INSERT INTO progress(resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(resource_id, resource_revision_id) DO UPDATE SET last_locator_json = excluded.last_locator_json, consumed_ranges_json = excluded.consumed_ranges_json, last_interaction_at = excluded.last_interaction_at`,
      params: [input.resourceId, input.resourceRevisionId, JSON.stringify(input.locator), JSON.stringify(merged), "reading", now],
    }],
    events: [{ type: "progress.updated", payload: { resourceId: input.resourceId, resourceRevisionId: input.resourceRevisionId } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: { resourceId: input.resourceId, resourceRevisionId: input.resourceRevisionId },
  });
  return { resourceId: input.resourceId, resourceRevisionId: input.resourceRevisionId, consumed: merged };
}

/** Overlapping or adjacent ranges of the same part collapse into one, so the read range stays a true union. */
export function mergeConsumedRanges(ranges: Array<{ partId?: string; start: number; end: number }>): Array<{ partId?: string; start: number; end: number }> {
  const byPart = new Map<string, Array<{ start: number; end: number }>>();
  for (const range of ranges) {
    const key = range.partId ?? "";
    const list = byPart.get(key) ?? [];
    list.push({ start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) });
    byPart.set(key, list);
  }
  const merged: Array<{ partId?: string; start: number; end: number }> = [];
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

export function resolveAnchor(store: DrizzleStore, revisionId: string, locator: SourceLocator): Record<string, unknown> {
  const row = store.sqlite.prepare("SELECT id, resource_id, payload_json FROM resource_revisions WHERE id = ?").get(revisionId) as { id: string; resource_id: string; payload_json: string } | undefined;
  if (!row) return { status: "missing_revision" };
  if (locator.kind !== "text") {
    return { status: "resolved", kind: locator.kind, pageId: locator.kind === "image" ? locator.pageId : undefined };
  }
  const payload = JSON.parse(row.payload_json) as StoredPayload;
  const parts = payloadParts(payload);
  const part = parts.find((item) => item.id === locator.partId) ?? parts[0];
  if (!part) return { status: "unresolved", reason: "part missing" };
  const result = resolveTextLocator(locator, { id: row.id, normalized: part.normalized, available: true, kind: part.kind });
  return { ...result, resourceId: row.resource_id, resourceRevisionId: row.id, partId: part.id, kind: part.kind };
}

/** The note's own locator plus its resolved position, so a jump can place the reader exactly. */
export function openNoteSourceDetail(store: DrizzleStore, objectId: string, blockId?: string): Record<string, unknown> {
  const note = readNote(store, objectId);
  const sources = note.sources as Array<{ blockId: string | null; anchorId: string; resourceId: string; revisionId: string; locator: string }>;
  // A jump names one block; falling back to another block's source would open the wrong excerpt.
  const source = blockId ? sources.find((item) => item.blockId === blockId) : sources[0];
  if (!source) {
    return {
      status: "unresolved",
      reason: sources.length ? "block has no source" : "note has no source",
      card: { status: "unresolved" as const, reason: sources.length ? "block has no source" : "note has no source" },
      returnTo: { objectId, blockId: blockId ?? null },
    };
  }
  const locator = JSON.parse(source.locator) as SourceLocator;
  const resolution = resolveAnchor(store, source.revisionId, locator);
  const range = locator.kind === "text" ? locator.range : undefined;
  const card = sourceCard(store, {
    resourceId: source.resourceId,
    resourceRevisionId: source.revisionId,
    partId: locator.kind === "text" ? locator.partId : undefined,
    start: range?.start,
    end: range?.end,
    anchorId: source.anchorId,
    resolution: String(resolution.status),
  });
  return {
    ...resolution,
    anchorId: source.anchorId,
    locator,
    card,
    returnTo: { objectId, blockId: source.blockId },
  };
}

function loadNote(store: DrizzleStore, objectId: string): { revision: number; title: string; payload: string; schemaVersion: number } {
  const row = store.sqlite.prepare("SELECT revision, title, payload_json, schema_version AS schemaVersion FROM content_objects WHERE id = ? AND deleted_at IS NULL").get(objectId) as { revision: number; title: string; payload_json: string; schemaVersion: number } | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "note missing");
  return { revision: row.revision, title: row.title, payload: row.payload_json, schemaVersion: row.schemaVersion };
}

/**
 * Keep `refs` in step with the note's blocks. A block that no longer exists must not keep a live
 * source link, and a block restored by a revision rollback must not lose the anchor it still names.
 */
export function noteRefMutations(store: DrizzleStore, objectId: string, blocks: Array<{ id: string; anchorId?: string }>): Mutation[] {
  const mutations: Mutation[] = [];
  const blockIds = new Set(blocks.map((block) => block.id));
  const existing = store.sqlite.prepare("SELECT id, to_id AS anchorId, from_block_id AS blockId FROM refs WHERE from_object_id = ? AND to_kind = 'anchor'").all(objectId) as Array<{ id: string; anchorId: string; blockId: string | null }>;
  for (const ref of existing) {
    if (ref.blockId && blockIds.has(ref.blockId)) continue;
    // Only the live link is dropped. The anchor row stays because the note's own revision history still
    // names it, so rolling the note back has to be able to restore the very same link.
    mutations.push({ sql: "DELETE FROM refs WHERE id = ?", params: [ref.id] });
  }
  const linked = new Set(existing.filter((ref) => ref.blockId && blockIds.has(ref.blockId)).map((ref) => ref.blockId!));
  const now = new Date().toISOString();
  for (const block of blocks) {
    if (!block.anchorId || linked.has(block.id)) continue;
    const anchor = store.sqlite.prepare("SELECT id FROM anchors WHERE id = ?").get(block.anchorId);
    if (!anchor) continue;
    mutations.push({ sql: "INSERT INTO refs(id, from_object_id, from_block_id, to_kind, to_id, mode, instance_layout_json, created_at) VALUES (?,?,?,?,?,?,?,?)", params: [createId("ref"), objectId, block.id, "anchor", block.anchorId, "live", null, now] });
  }
  return mutations;
}

export function commitNoteOp(store: DrizzleStore, input: {
  objectId: string;
  expectedRevision: number;
  op: NoteOp;
  title?: string;
  tags?: string[];
  idempotencyKey: string;
  commandId: string;
  candidate?: unknown;
}): { objectId: string; revision: number; document: NoteDocument } {
  const row = loadNote(store, input.objectId);
  if (row.revision !== input.expectedRevision) {
    throw new MangaError("REVISION_CONFLICT", "note revision changed", {
      details: { expected: input.expectedRevision, actual: row.revision, candidate: input.candidate ?? input.op },
    });
  }
  const document = applyNoteOp(coerceNoteDocument(JSON.parse(row.payload)), input.op, () => createId("blk"));
  const next = row.revision + 1;
  const now = new Date().toISOString();
  const fullText = notePlainText(document);
  const existingTags = store.sqlite.prepare("SELECT tags_json FROM content_objects WHERE id = ?").get(input.objectId) as { tags_json?: string } | undefined;
  const tags = input.tags
    ? [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, NOTE_TAG_MAX)
    : document.tags ?? (existingTags?.tags_json ? JSON.parse(existingTags.tags_json) as string[] : []);
  const previous = store.sqlite.prepare("SELECT resource_id FROM text_fragments WHERE object_id = ? AND resource_id IS NOT NULL LIMIT 1").get(input.objectId) as { resource_id: string } | undefined;
  const mutations: Mutation[] = [
    { sql: "UPDATE content_objects SET revision = ?, schema_version = 2, title = ?, payload_json = ?, tags_json = ?, preview_json = ?, updated_at = ? WHERE id = ?", params: [next, input.title ?? row.title, JSON.stringify(document), JSON.stringify(tags), JSON.stringify({ text: fullText.slice(0, 80) }), now, input.objectId] },
    { sql: "INSERT INTO object_revisions(object_id, revision, payload_json, created_at) VALUES (?,?,?,?)", params: [input.objectId, next, JSON.stringify(document), now] },
    { sql: "DELETE FROM search_idx WHERE fragment_id IN (SELECT id FROM text_fragments WHERE object_id = ?)", params: [input.objectId] },
    { sql: "DELETE FROM text_fragments WHERE object_id = ?", params: [input.objectId] },
    ...noteRefMutations(store, input.objectId, document.blocks),
  ];
  for (const block of document.blocks) {
    mutations.push(...store.indexTextChunks({
      objectId: input.objectId,
      resourceId: previous?.resource_id,
      partId: block.id,
      representationId: input.objectId,
      kind: "note",
      text: block.text,
    }));
  }
  store.commit({
    mutations,
    events: [{ type: "note.updated", payload: { objectId: input.objectId, revision: next, op: input.op.type } }],
    idempotencyKey: input.idempotencyKey,
    commandId: input.commandId,
    result: { objectId: input.objectId, revision: next },
  });
  return { objectId: input.objectId, revision: next, document };
}

export function readNote(store: DrizzleStore, objectId: string): Record<string, unknown> {
  const row = loadNote(store, objectId);
  const document = coerceNoteDocument(JSON.parse(row.payload));
  const sources = store.sqlite.prepare(`SELECT r.from_block_id AS blockId, r.to_id AS anchorId, a.resource_id AS resourceId, a.resource_revision_id AS revisionId, a.locator_json AS locator
    FROM refs r JOIN anchors a ON a.id = r.to_id WHERE r.from_object_id = ? AND r.to_kind = 'anchor'`).all(objectId);
  const tags = store.sqlite.prepare("SELECT tags_json FROM content_objects WHERE id = ?").get(objectId) as { tags_json?: string } | undefined;
  return {
    objectId,
    revision: row.revision,
    title: row.title,
    schemaVersion: row.schemaVersion,
    tags: tags?.tags_json ? JSON.parse(tags.tags_json) as string[] : [],
    document,
    sources,
    sourceStatus: describeNoteSource(store, sources as Array<{ resourceId: string; revisionId: string }>),
  };
}

/** Whether every source of a note still resolves; drives the "stale source" repair entry. */
export function describeNoteSource(store: DrizzleStore, sources: Array<{ resourceId: string; revisionId: string }>): "none" | "linked" | "missing_resource" | "missing_revision" {
  if (!sources.length) return "none";
  for (const source of sources) {
    const resource = store.sqlite.prepare("SELECT id FROM resources WHERE id = ?").get(source.resourceId);
    if (!resource) return "missing_resource";
    const revision = store.sqlite.prepare("SELECT id FROM resource_revisions WHERE id = ?").get(source.revisionId);
    if (!revision) return "missing_revision";
  }
  return "linked";
}

export function listNotes(store: DrizzleStore, input: { text?: string; tag?: string; resourceId?: string; limit?: number }): Array<Record<string, unknown>> {
  const limit = Math.min(input.limit ?? 200, 500);
  const rows = store.sqlite.prepare("SELECT id, revision, title, tags_json, preview_json, scope_json, updated_at FROM content_objects WHERE type = 'notes.document' AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?").all(limit * 4) as Array<{
    id: string;
    revision: number;
    title: string;
    tags_json: string;
    preview_json: string;
    scope_json: string;
    updated_at: string;
  }>;
  const refs = store.sqlite.prepare(`SELECT r.from_object_id AS objectId, r.from_block_id AS blockId, r.to_id AS anchorId, a.resource_id AS resourceId, a.resource_revision_id AS revisionId
    FROM refs r JOIN anchors a ON a.id = r.to_id WHERE r.to_kind = 'anchor'`).all() as Array<{ objectId: string; blockId: string | null; anchorId: string; resourceId: string; revisionId: string }>;
  const needle = input.text?.trim() ? [...input.text.trim()] : undefined;
  const results: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const tags = row.tags_json ? JSON.parse(row.tags_json) as string[] : [];
    if (input.tag && !tags.includes(input.tag)) continue;
    const own = refs.filter((ref) => ref.objectId === row.id);
    const resourceId = own[0]?.resourceId ?? (JSON.parse(row.scope_json) as { resourceId?: string | null }).resourceId ?? null;
    if (input.resourceId && resourceId !== input.resourceId) continue;
    const preview = (JSON.parse(row.preview_json) as { text?: string }).text ?? "";
    if (needle) {
      // Search the full block text, not just the truncated preview, so a match deep in a note is found.
      const blocks = store.sqlite.prepare("SELECT payload_json FROM content_objects WHERE id = ?").get(row.id) as { payload_json: string } | undefined;
      const haystack = `${row.title}\n${tags.join(" ")}\n${notePlainText(coerceNoteDocument(JSON.parse(blocks?.payload_json ?? "{}")))}`;
      if (!containsSequence(haystack, needle)) continue;
    }
    results.push({
      objectId: row.id,
      revision: row.revision,
      title: row.title,
      tags,
      preview,
      resourceId: resourceId ?? null,
      anchorId: own[0]?.anchorId ?? null,
      sourceStatus: describeNoteSource(store, own),
      updatedAt: row.updated_at,
    });
    if (results.length >= limit) break;
  }
  return results;
}

function containsSequence(haystack: string, needle: string[]): boolean {
  const hay = [...haystack];
  if (!needle.length) return true;
  for (let i = 0; i <= hay.length - needle.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

export function noteHistory(store: DrizzleStore, objectId: string, limit = 50): Array<Record<string, unknown>> {
  loadNote(store, objectId);
  const rows = store.sqlite.prepare("SELECT revision, payload_json, created_at FROM object_revisions WHERE object_id = ? ORDER BY revision DESC LIMIT ?").all(objectId, Math.min(limit, 100)) as Array<{ revision: number; payload_json: string; created_at: string }>;
  return rows.map((row) => {
    let blocks: Array<{ text?: string }> = [];
    try { blocks = (JSON.parse(row.payload_json) as { blocks?: Array<{ text?: string }> }).blocks ?? []; } catch { blocks = []; }
    const text = blocks.map((block) => block.text ?? "").join("\n");
    return { revision: row.revision, createdAt: row.created_at, blockCount: blocks.length, preview: text.slice(0, 120) };
  });
}

export function setNoteTags(store: DrizzleStore, input: { objectId: string; expectedRevision: number; tags: string[]; idempotencyKey: string; commandId: string }): Record<string, unknown> {
  const row = loadNote(store, input.objectId);
  if (row.revision !== input.expectedRevision) throw new MangaError("REVISION_CONFLICT", "note revision changed", { details: { expected: input.expectedRevision, actual: row.revision } });
  const tags = [...new Set(input.tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, NOTE_TAG_MAX);
  const next = row.revision + 1;
  const now = new Date().toISOString();
  const document = coerceNoteDocument(JSON.parse(row.payload));
  store.commit({
    mutations: [{ sql: "UPDATE content_objects SET revision = ?, tags_json = ?, updated_at = ? WHERE id = ?", params: [next, JSON.stringify(tags), now, input.objectId] }],
    events: [{ type: "note.tagged", payload: { objectId: input.objectId, revision: next, tags } }],
    idempotencyKey: input.idempotencyKey,
    commandId: input.commandId,
    result: { objectId: input.objectId, revision: next, tags },
  });
  return { objectId: input.objectId, revision: next, tags, document };
}

export function restoreNoteRevision(store: DrizzleStore, input: { objectId: string; expectedRevision: number; revision: number; idempotencyKey: string; commandId: string }): { objectId: string; revision: number; restoredFrom: number; document: NoteDocument } {
  const row = loadNote(store, input.objectId);
  if (row.revision !== input.expectedRevision) throw new MangaError("REVISION_CONFLICT", "note revision changed", { details: { expected: input.expectedRevision, actual: row.revision } });
  const previous = store.sqlite.prepare("SELECT payload_json FROM object_revisions WHERE object_id = ? AND revision = ?").get(input.objectId, input.revision) as { payload_json: string } | undefined;
  if (!previous) throw new MangaError("NOT_FOUND", "note revision to restore is missing");
  // Restoring keeps history: it appends a new revision instead of rewriting the sequence.
  const document = coerceNoteDocument(JSON.parse(previous.payload_json));
  const next = row.revision + 1;
  const now = new Date().toISOString();
  store.commit({
    mutations: [
      { sql: "UPDATE content_objects SET revision = ?, schema_version = 2, payload_json = ?, preview_json = ?, updated_at = ? WHERE id = ?", params: [next, JSON.stringify(document), JSON.stringify({ text: notePlainText(document).slice(0, 80) }), now, input.objectId] },
      { sql: "INSERT INTO object_revisions(object_id, revision, payload_json, created_at) VALUES (?,?,?,?)", params: [input.objectId, next, JSON.stringify(document), now] },
      // A restored block that still names an anchor must get its source link back.
      ...noteRefMutations(store, input.objectId, document.blocks),
    ],
    events: [{ type: "note.restored", payload: { objectId: input.objectId, revision: next, restoredFrom: input.revision } }],
    idempotencyKey: input.idempotencyKey,
    commandId: input.commandId,
    result: { objectId: input.objectId, revision: next, restoredFrom: input.revision },
  });
  return { objectId: input.objectId, revision: next, restoredFrom: input.revision, document };
}

export function setBookmark(store: DrizzleStore, input: { bookmarkId?: string; resourceId: string; resourceRevisionId: string; label: string; locator: SourceLocator; idempotencyKey: string; commandId: string }): Record<string, unknown> {
  const revision = store.sqlite.prepare("SELECT id FROM resource_revisions WHERE id = ? AND resource_id = ?").get(input.resourceRevisionId, input.resourceId);
  if (!revision) throw new MangaError("NOT_FOUND", "resource revision does not belong to this resource");
  const id = input.bookmarkId ?? createId("bm");
  const now = new Date().toISOString();
  store.commit({
    mutations: [{
      sql: "INSERT INTO bookmarks(id, resource_id, resource_revision_id, label, locator_json, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label = excluded.label, locator_json = excluded.locator_json",
      params: [id, input.resourceId, input.resourceRevisionId, input.label, JSON.stringify(input.locator), now],
    }],
    events: [{ type: "reading.bookmarkSet", payload: { bookmarkId: id, resourceId: input.resourceId } }],
    idempotencyKey: input.idempotencyKey,
    commandId: input.commandId,
    result: { bookmarkId: id },
  });
  return { bookmarkId: id, resourceId: input.resourceId, resourceRevisionId: input.resourceRevisionId, label: input.label };
}

export function listBookmarks(store: DrizzleStore, resourceId?: string): Array<Record<string, unknown>> {
  const rows = resourceId
    ? store.sqlite.prepare("SELECT id, resource_id AS resourceId, resource_revision_id AS resourceRevisionId, label, locator_json AS locator, created_at AS createdAt FROM bookmarks WHERE resource_id = ? ORDER BY created_at DESC").all(resourceId)
    : store.sqlite.prepare("SELECT id, resource_id AS resourceId, resource_revision_id AS resourceRevisionId, label, locator_json AS locator, created_at AS createdAt FROM bookmarks ORDER BY created_at DESC").all();
  return (rows as Array<Record<string, unknown>>).map((row) => ({ ...row, locator: JSON.parse(String(row.locator)) }));
}

export function removeBookmark(store: DrizzleStore, input: { bookmarkId: string; idempotencyKey: string; commandId: string }): Record<string, unknown> {
  const row = store.sqlite.prepare("SELECT id FROM bookmarks WHERE id = ?").get(input.bookmarkId);
  if (!row) throw new MangaError("NOT_FOUND", "bookmark missing");
  store.commit({
    mutations: [{ sql: "DELETE FROM bookmarks WHERE id = ?", params: [input.bookmarkId] }],
    events: [{ type: "reading.bookmarkRemoved", payload: { bookmarkId: input.bookmarkId } }],
    idempotencyKey: input.idempotencyKey,
    commandId: input.commandId,
    result: { bookmarkId: input.bookmarkId, removed: true },
  });
  return { bookmarkId: input.bookmarkId, removed: true };
}

/** Concrete source card for a note or a reading surface: title, revision, availability and the resolve outcome. */
export function sourceCard(store: DrizzleStore, input: { resourceId: string; resourceRevisionId?: string; partId?: string; start?: number; end?: number; anchorId?: string; resolution?: string }): Record<string, unknown> {
  const resource = store.sqlite.prepare("SELECT id, title FROM resources WHERE id = ?").get(input.resourceId) as { id: string; title: string } | undefined;
  if (!resource) return { status: "missing_resource" as const, resourceId: input.resourceId, anchorId: input.anchorId };
  const revision = input.resourceRevisionId
    ? store.sqlite.prepare("SELECT id, payload_json FROM resource_revisions WHERE id = ? AND resource_id = ?").get(input.resourceRevisionId, input.resourceId) as { id: string; payload_json: string } | undefined
    : store.sqlite.prepare("SELECT id, payload_json FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC LIMIT 1").get(input.resourceId) as { id: string; payload_json: string } | undefined;
  if (!revision) return { status: "missing_revision" as const, resourceId: input.resourceId, title: resource.title, anchorId: input.anchorId };
  const location = store.sqlite.prepare("SELECT relative_path, available, hosted FROM file_locations WHERE resource_revision_id = ? ORDER BY rowid DESC LIMIT 1").get(revision.id) as { relative_path: string; available: number; hosted: number } | undefined;
  const parts = payloadParts(JSON.parse(revision.payload_json) as StoredPayload);
  const part = input.partId ? parts.find((item) => item.id === input.partId) : parts[0];
  const quote = part && input.start !== undefined && input.end !== undefined && part.kind === "text"
    ? sliceCodePoints(part.normalized, input.start, input.end)
    : undefined;
  // The card carries how the anchor resolved, so a duplicate sentence or a scan page is not shown as linked.
  const status = input.resolution && input.resolution !== "resolved" ? input.resolution : "resolved";
  return {
    status,
    resolution: input.resolution,
    anchorId: input.anchorId,
    resourceId: resource.id,
    title: resource.title,
    resourceRevisionId: revision.id,
    partId: part?.id,
    partTitle: part?.title,
    kind: part?.kind,
    range: input.start !== undefined && input.end !== undefined ? { start: input.start, end: input.end } : undefined,
    quote,
    // A note whose own revision file is gone is still readable once the resource holds a picked file, so
    // the repair entry disappears instead of asking again for a file the user already supplied.
    available: location ? location.available === 1 || resourceFileElsewhere(store, resource.id, revision.id) : true,
    revisionAvailable: location ? location.available === 1 : true,
    hosted: location ? location.hosted === 1 : false,
    path: location?.relative_path,
  };
}

export function selectionQuote(store: DrizzleStore, input: { resourceId: string; resourceRevisionId: string; partId?: string; start: number; end: number }, spoilerGuard: boolean): Record<string, unknown> | { blocked: string } {
  const loaded = loadRevision(store, input.resourceId, input.resourceRevisionId);
  const parts = payloadParts(loaded.payload);
  const part = input.partId ? parts.find((item) => item.id === input.partId) : parts[0];
  if (!part) throw new MangaError("NOT_FOUND", "resource part missing");
  if (input.end < input.start || input.end - input.start > 4096) throw new MangaError("VALIDATION_ERROR", "context range is invalid");
  if (spoilerGuard && !rangeConsumed(store, input.resourceId, loaded.revisionId, part.id, input.start, input.end)) {
    return { blocked: "spoiler" };
  }
  const quote = sliceCodePoints(part.normalized, input.start, input.end);
  const locator = createTextLocator({ partId: part.id, representationId: loaded.revisionId, normalized: part.normalized, start: input.start, end: input.end });
  return { resourceId: input.resourceId, resourceRevisionId: loaded.revisionId, partId: part.id, range: { start: input.start, end: input.end }, quote, locator };
}

function rangeConsumed(store: DrizzleStore, resourceId: string, revisionId: string, partId: string, start: number, end: number): boolean {
  const row = store.sqlite.prepare("SELECT consumed_ranges_json FROM progress WHERE resource_id = ? AND resource_revision_id = ?").get(resourceId, revisionId) as { consumed_ranges_json: string } | undefined;
  if (!row) return false;
  const ranges = JSON.parse(row.consumed_ranges_json) as Array<{ partId?: string; start: number; end: number }>;
  return ranges.some((range) => (range.partId ?? partId) === partId && start >= range.start && end <= range.end);
}

export function filterUnread(store: DrizzleStore, hits: SearchHit[]): SearchHit[] {
  return hits.filter((hit) => {
    if (hit.kind !== "body" || !hit.resourceId || !hit.revisionId || !hit.locator) return hit.kind !== "body";
    return rangeConsumed(store, hit.resourceId, hit.revisionId, hit.locator.partId, hit.locator.range.start, hit.locator.range.end);
  });
}

export function quoteLocator(normalized: string, partId: string, representationId: string, start: number, end: number): TextLocator {
  if (end > codePointLength(normalized)) throw new MangaError("VALIDATION_ERROR", "context range is past the end");
  return createTextLocator({ partId, representationId, normalized, start, end });
}
