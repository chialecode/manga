/** The notes module and the note operations other modules share. */
import { MangaError, NOTE_TAG_MAX, type NoteDocument, createId, type CommandEnvelope, type SourceLocator } from "@manga/contracts";
import type { Mutation } from "@manga/storage-drizzle";
import { defineModule, type MangaModule } from "@manga/plugin-sdk";
import { commitNoteOp, listNotes, noteHistory, openNoteSourceDetail, readAsset, readNote, restoreNoteRevision, setNoteTags } from "../reading-service.ts";
import { assertLocatorFits, describeMediaLocator } from "../domain/media-anchors.ts";
import type { MangaProductApp } from "../product-app.ts";

/** What these commands use of the application. */
export type NotesHost = Pick<MangaProductApp, "assertWritable" | "grantOf" | "grants" | "runtime" | "store" | "uiFacets">;

/** A note from an accepted draft: the user's text, and one quote block per place the recording was at. The draft is marked in the same commit, so a repeat never makes a second note. */
export function createDraftNote(app: NotesHost, envelope: CommandEnvelope, draftId: string, prepared: { title: string; text: string; anchors: Array<{ resourceId?: string; resourceRevisionId?: string; locator?: SourceLocator }>; resourceId: string | null }) {
  const grant = app.grantOf(envelope);
  const objectId = createId("obj");
  const now = new Date().toISOString();
  const quotes: Array<{ id: string; type: "quote"; text: string; anchorId: string }> = [];
  const mutations: Mutation[] = [];
  prepared.anchors.forEach((anchor, index) => {
    if (!anchor.resourceId || !anchor.resourceRevisionId || !anchor.locator) return;
    if (anchor.locator.kind !== "text") assertLocatorFits(app.store, anchor.resourceRevisionId, anchor.locator);
    const anchorId = createId("anc");
    const quoteText = anchor.locator.kind === "text" ? anchor.locator.quote?.exact ?? "" : describeMediaLocator(anchor.locator);
    quotes.push({ id: `q${index + 1}`, type: "quote", text: quoteText, anchorId });
    mutations.push(
      { sql: "INSERT INTO anchors(id, resource_id, resource_revision_id, locator_json, preview_json, created_at) VALUES (?,?,?,?,?,?)", params: [anchorId, anchor.resourceId, anchor.resourceRevisionId, JSON.stringify(anchor.locator), JSON.stringify({ text: quoteText, kind: anchor.locator.kind }), now] },
      { sql: "INSERT INTO refs(id, from_object_id, from_block_id, to_kind, to_id, mode, instance_layout_json, created_at) VALUES (?,?,?,?,?,?,?,?)", params: [createId("ref"), objectId, `q${index + 1}`, "anchor", anchorId, "live", null, now] },
    );
  });
  const blocks = [...quotes, { id: "b1", type: "paragraph", text: prepared.text }];
  const payload = JSON.stringify(quotes.length ? { schemaVersion: 2, blocks } : { blocks });
  app.store.commit({
    mutations: [
      { sql: "INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, tags_json, attachment_ids_json, preview_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", params: [objectId, "notes.document", "manga.notes", JSON.stringify({ kind: "library", resourceId: prepared.resourceId }), quotes.length ? 2 : 1, 1, prepared.title, payload, JSON.stringify(["口述"]), "[]", JSON.stringify({ text: prepared.text.slice(0, 80) }), now, now] },
      { sql: "INSERT INTO object_revisions(object_id, revision, payload_json, created_at) VALUES (?,?,?,?)", params: [objectId, 1, payload, now] },
      ...app.store.indexFragment({ id: createId("frag"), objectId, resourceId: prepared.resourceId ?? undefined, kind: "note", text: `${quotes.map((quote) => quote.text).join("\n")}\n${prepared.text}`.trim() }),
      ...mutations,
      { sql: "UPDATE capture_drafts SET state = 'accepted', note_object_id = ?, updated_at = ? WHERE id = ? AND note_object_id IS NULL", params: [objectId, now, draftId] },
    ],
    events: [{ type: "note.created", payload: { objectId } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: { objectId, revision: 1 },
  });
  if (grant.access === "enumerated") app.grants.save({ ...grant, writeObjectIds: [...grant.writeObjectIds, objectId] });
  return { objectId, revision: 1, anchors: quotes.length };
}

export function notesModule(app: NotesHost): MangaModule {
  return defineModule({
    manifest: {
      moduleId: "manga.notes",
      version: "1.0.0",
      displayName: "笔记",
      featureId: "notes",
      contributes: [{ capabilityId: "manga.notes", version: "1.0.0" }],
      needs: [{ capabilityId: "manga.library", version: "1.0.0", cardinality: "single", required: true }],
      facets: ["service", "ui"],
      conflictsWith: [],
      ownerModuleIds: [],
    },
    activate: (ctx) => {
      if ((ctx.hostFacets ?? []).includes("ui")) {
        app.uiFacets.add("notes");
        ctx.register({ kind: "subscription", id: `notes-ui-${ctx.epoch}`, dispose: () => {
          app.uiFacets.delete("notes");
        } });
      }
      app.runtime.registerCommand("manga.notes", "notes.create", (envelope) => {
        app.assertWritable();
        return createNote(app, envelope);
      });
      app.runtime.registerCommand("manga.notes", "notes.update", (envelope) => {
        app.assertWritable();
        return updateNote(app, envelope);
      });
      app.runtime.registerCommand("manga.notes", "notes.undo", (envelope) => {
        app.assertWritable();
        return undoNote(app, envelope);
      });
      app.runtime.registerCommand("manga.notes", "notes.get", (envelope) => {
        const input = envelope.input as { objectId: string };
        assertNoteAccess(app, envelope, input.objectId, false);
        return readNote(app.store, input.objectId);
      });
      app.runtime.registerCommand("manga.notes", "notes.split", (envelope) => noteOp(app, envelope, "split"));
      app.runtime.registerCommand("manga.notes", "notes.merge", (envelope) => noteOp(app, envelope, "merge"));
      app.runtime.registerCommand("manga.notes", "notes.move", (envelope) => noteOp(app, envelope, "move"));
      app.runtime.registerCommand("manga.notes", "notes.copy", (envelope) => noteOp(app, envelope, "copy"));
      app.runtime.registerCommand("manga.notes", "notes.replace", (envelope) => noteOp(app, envelope, "replace"));
      app.runtime.registerCommand("manga.notes", "notes.insert", (envelope) => noteOp(app, envelope, "insert"));
      app.runtime.registerCommand("manga.notes", "notes.remove", (envelope) => noteOp(app, envelope, "remove"));
      app.runtime.registerCommand("manga.notes", "notes.setType", (envelope) => noteOp(app, envelope, "setType"));
      app.runtime.registerCommand("manga.notes", "notes.rename", (envelope) => noteOp(app, envelope, "rename"));
      app.runtime.registerCommand("manga.notes", "notes.asset", (envelope) => {
        const input = envelope.input as { resourceRevisionId: string; assetId: string };
        const grant = app.grantOf(envelope);
        const owner = app.store.sqlite.prepare("SELECT resource_id FROM resource_assets WHERE id = ?").get(`${input.resourceRevisionId}:${input.assetId}`) as { resource_id: string } | undefined;
        if (!owner) throw new MangaError("NOT_FOUND", "asset missing");
        if (!app.grants.canRead(grant, owner.resource_id)) throw new MangaError("SCOPE_DENIED", "asset is outside the authorized set");
        const asset = readAsset(app.store, input.resourceRevisionId, input.assetId);
        if (!asset) throw new MangaError("NOT_FOUND", "asset missing");
        return { mediaType: asset.mediaType, name: asset.name, bytes: [...asset.bytes] };
      });
      app.runtime.registerCommand("manga.notes", "notes.openSource", (envelope) => {
        const input = envelope.input as { objectId: string; blockId?: string };
        assertNoteAccess(app, envelope, input.objectId, false);
        return openNoteSourceDetail(app.store, input.objectId, input.blockId);
      });
      app.runtime.registerCommand("manga.notes", "notes.list", (envelope) => {
        const grant = app.grantOf(envelope);
        const input = envelope.input as { resourceId?: string };
        if (input.resourceId && !app.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
        return filterNotesForGrant(app, envelope, listNotes(app.store, envelope.input as Parameters<typeof listNotes>[1]));
      });
      app.runtime.registerCommand("manga.notes", "notes.history", (envelope) => {
        const input = envelope.input as { objectId: string; limit?: number };
        assertNoteAccess(app, envelope, input.objectId, false);
        return noteHistory(app.store, input.objectId, input.limit);
      });
      app.runtime.registerCommand("manga.notes", "notes.restore", (envelope) => {
        app.assertWritable();
        const input = envelope.input as { objectId: string };
        assertNoteAccess(app, envelope, input.objectId, true);
        return restoreNoteRevision(app.store, { ...(envelope.input as Parameters<typeof restoreNoteRevision>[1]), objectId: input.objectId, idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId });
      });
      app.runtime.registerCommand("manga.notes", "notes.delete", (envelope) => {
        app.assertWritable();
        const input = envelope.input as { objectId: string };
        assertNoteAccess(app, envelope, input.objectId, true);
        return setNoteDeleted(app, envelope, input.objectId, true);
      });
      app.runtime.registerCommand("manga.notes", "notes.undelete", (envelope) => {
        app.assertWritable();
        const input = envelope.input as { objectId: string };
        assertNoteAccess(app, envelope, input.objectId, true);
        return setNoteDeleted(app, envelope, input.objectId, false);
      });
      app.runtime.registerCommand("manga.notes", "notes.tags", (envelope) => {
        app.assertWritable();
        const input = envelope.input as { objectId: string };
        assertNoteAccess(app, envelope, input.objectId, true);
        return setNoteTags(app.store, { ...(envelope.input as Parameters<typeof setNoteTags>[1]), objectId: input.objectId, idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId });
      });
    },
    deactivate: () => undefined,
  });
}

/** A note is visible to a bounded grant only when its own id or its source resource is authorized. */
export function filterNotesForGrant(app: NotesHost, envelope: CommandEnvelope, notes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const grant = app.grantOf(envelope);
  if (grant.access === "owner") return notes;
  return notes.filter((note) => {
    if (app.grants.canWriteObject(grant, String(note.objectId))) return true;
    const resourceId = note.resourceId;
    return typeof resourceId === "string" && app.grants.canRead(grant, resourceId);
  });
}

export function createNote(app: NotesHost, envelope: CommandEnvelope) {
  const grant = app.grantOf(envelope);
  const input = envelope.input as { title: string; text: string; resourceId?: string; resourceRevisionId?: string; tags?: string[]; quoteText?: string; locator?: SourceLocator; workId?: string };
  if (!grant.allowCreateObjects) throw new MangaError("FORBIDDEN", "creating objects is not authorized");
  if (input.resourceId && !app.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "note source is outside the authorized set");
  if (input.resourceId && input.resourceRevisionId) {
    // A note must not point at a revision that does not belong to the resource it names.
    const revision = app.store.sqlite.prepare("SELECT id FROM resource_revisions WHERE id = ? AND resource_id = ?").get(input.resourceRevisionId, input.resourceId);
    if (!revision) throw new MangaError("NOT_FOUND", "resource revision does not belong to app resource");
  }
  if (input.locator && input.locator.kind !== "text") {
    // A page or time source must name a place its revision has; text is checked by the text resolver.
    if (!input.resourceId || !input.resourceRevisionId) throw new MangaError("VALIDATION_ERROR", "a page or time source needs its resource and revision");
    assertLocatorFits(app.store, input.resourceRevisionId, input.locator);
  }
  // A note belongs to the work of the resource it was written beside, or to the work page it was written on.
  const noteWorkId = input.resourceId
    ? (app.store.sqlite.prepare("SELECT work_id FROM resources WHERE id = ?").get(input.resourceId) as { work_id: string | null } | undefined)?.work_id ?? null
    : input.workId && app.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(input.workId) ? input.workId : null;
  const quoteText = input.locator ? (input.locator.kind === "text" ? input.locator.quote?.exact ?? "" : input.quoteText ?? describeMediaLocator(input.locator)) : "";
  const objectId = createId("obj");
  const anchorId = input.locator && input.resourceId && input.resourceRevisionId ? createId("anc") : undefined;
  const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, NOTE_TAG_MAX);
  // The excerpt is a distinct block from the user's own comment, so the two read as different sources.
  const blocks = anchorId
    ? [{ id: "quote", type: "quote", text: quoteText, anchorId }, { id: "b1", type: "paragraph", text: input.text }]
    : [{ id: "b1", type: "paragraph", text: input.text }];
  const now = new Date().toISOString();
  const mutations: Mutation[] = [
      { sql: "INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, tags_json, attachment_ids_json, preview_json, created_at, updated_at, work_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", params: [objectId, "notes.document", "manga.notes", JSON.stringify({ kind: "library", resourceId: input.resourceId ?? null }), anchorId ? 2 : 1, 1, input.title, JSON.stringify(anchorId ? { schemaVersion: 2, blocks } : { blocks }), JSON.stringify(tags), "[]", JSON.stringify({ text: input.text.slice(0, 80) }), now, now, noteWorkId] },
      { sql: "INSERT INTO object_revisions(object_id, revision, payload_json, created_at) VALUES (?,?,?,?)", params: [objectId, 1, JSON.stringify(anchorId ? { schemaVersion: 2, blocks } : { blocks }), now] },
      ...app.store.indexFragment({ id: createId("frag"), objectId, resourceId: input.resourceId, kind: "note", text: `${quoteText}\n${input.text}`.trim() }),
  ];
  if (anchorId && input.resourceId && input.resourceRevisionId && input.locator) {
    mutations.push(
      { sql: "INSERT INTO anchors(id, resource_id, resource_revision_id, locator_json, preview_json, created_at) VALUES (?,?,?,?,?,?)", params: [anchorId, input.resourceId, input.resourceRevisionId, JSON.stringify(input.locator), JSON.stringify({ text: quoteText, kind: input.locator.kind }), now] },
      { sql: "INSERT INTO refs(id, from_object_id, from_block_id, to_kind, to_id, mode, instance_layout_json, created_at) VALUES (?,?,?,?,?,?,?,?)", params: [createId("ref"), objectId, "quote", "anchor", anchorId, "live", null, now] },
    );
  }
  app.store.commit({
    mutations,
    events: [{ type: "note.created", payload: { objectId } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: { objectId, revision: 1, anchorId },
  });
  if (grant.access === "enumerated") {
    app.grants.save({ ...grant, writeObjectIds: [...grant.writeObjectIds, objectId] });
  }
  return { objectId, revision: 1, anchorId };
}

export function updateNote(app: NotesHost, envelope: CommandEnvelope) {
  const grant = app.grantOf(envelope);
  const input = envelope.input as { objectId: string; expectedRevision: number; blockId?: string; text: string };
  if (!app.grants.canWriteObject(grant, input.objectId) && grant.access !== "owner") throw new MangaError("SCOPE_DENIED", "object is outside the authorized set");
  const row = app.store.sqlite.prepare("SELECT revision, payload_json FROM content_objects WHERE id = ?").get(input.objectId) as { revision: number; payload_json: string } | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "note missing");
  if (row.revision !== input.expectedRevision) {
    throw new MangaError("REVISION_CONFLICT", "note revision changed", { details: { expected: input.expectedRevision, actual: row.revision, candidate: { text: input.text, blockId: input.blockId } } });
  }
  const payload = JSON.parse(row.payload_json) as { blocks?: Array<{ id: string }> };
  if (!input.blockId && (payload.blocks?.length ?? 0) !== 1) throw new MangaError("VALIDATION_ERROR", "a blockId is required for a multi-block note");
  const blockId = input.blockId ?? payload.blocks?.[0]?.id;
  if (!blockId) throw new MangaError("VALIDATION_ERROR", "editable note block missing");
  return commitNoteOp(app.store, {
    objectId: input.objectId,
    expectedRevision: input.expectedRevision,
    op: { type: "setText", blockId, text: input.text },
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    candidate: { text: input.text, blockId },
  });
}

export function undoNote(app: NotesHost, envelope: CommandEnvelope) {
  const grant = app.grantOf(envelope);
  const input = envelope.input as { objectId: string; expectedRevision: number };
  if (!app.grants.canWriteObject(grant, input.objectId) && grant.access !== "owner") throw new MangaError("SCOPE_DENIED", "object is outside the authorized set");
  const row = app.store.sqlite.prepare("SELECT revision FROM content_objects WHERE id = ?").get(input.objectId) as { revision: number } | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "note missing");
  if (row.revision !== input.expectedRevision) throw new MangaError("REVISION_CONFLICT", "note revision changed");
  const previous = app.store.sqlite.prepare("SELECT payload_json FROM object_revisions WHERE object_id = ? AND revision = ?").get(input.objectId, row.revision - 1) as { payload_json: string } | undefined;
  if (!previous) throw new MangaError("NOT_FOUND", "no previous revision to restore");
  const next = row.revision + 1;
  const now = new Date().toISOString();
  const payload = JSON.parse(previous.payload_json) as { blocks?: Array<{ id?: string; text?: string }> };
  const text = (payload.blocks ?? []).map((block) => block.text ?? "").join("\n");
  const linked = app.store.sqlite.prepare("SELECT resource_id FROM text_fragments WHERE object_id = ? AND resource_id IS NOT NULL LIMIT 1").get(input.objectId) as { resource_id?: string } | undefined;
  const tags = app.store.sqlite.prepare("SELECT tags_json FROM content_objects WHERE id = ?").get(input.objectId) as { tags_json?: string } | undefined;
  app.store.commit({
    mutations: [
      { sql: "UPDATE content_objects SET revision = ?, payload_json = ?, tags_json = ?, preview_json = ?, updated_at = ? WHERE id = ?", params: [next, previous.payload_json, tags?.tags_json ?? "[]", JSON.stringify({ text: text.slice(0, 80) }), now, input.objectId] },
      { sql: "INSERT INTO object_revisions(object_id, revision, payload_json, created_at) VALUES (?,?,?,?)", params: [input.objectId, next, previous.payload_json, now] },
      { sql: "DELETE FROM search_idx WHERE fragment_id IN (SELECT id FROM text_fragments WHERE object_id = ?)", params: [input.objectId] },
      { sql: "DELETE FROM text_fragments WHERE object_id = ?", params: [input.objectId] },
      ...(payload.blocks ?? []).flatMap((block) => app.store.indexTextChunks({
        objectId: input.objectId,
        resourceId: linked?.resource_id,
        partId: block.id,
        representationId: input.objectId,
        kind: "note",
        text: block.text ?? "",
      })),
    ],
    events: [{ type: "note.undone", payload: { objectId: input.objectId, revision: next } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: { objectId: input.objectId, revision: next },
  });
  return { objectId: input.objectId, revision: next, restoredFrom: row.revision - 1 };
}

export function assertNoteAccess(app: NotesHost, envelope: CommandEnvelope, objectId: string, write: boolean): void {
  const grant = app.grantOf(envelope);
  if (write) {
    if (!app.grants.canWriteObject(grant, objectId) && grant.access !== "owner") throw new MangaError("SCOPE_DENIED", "object is outside the authorized set");
    return;
  }
  if (grant.access === "owner") return;
  if (app.grants.canWriteObject(grant, objectId)) return;
  const linked = app.store.sqlite.prepare("SELECT resource_id FROM text_fragments WHERE object_id = ? AND resource_id IS NOT NULL LIMIT 1").get(objectId) as { resource_id?: string } | undefined;
  if (!linked?.resource_id || !app.grants.canRead(grant, linked.resource_id)) throw new MangaError("SCOPE_DENIED", "note is outside the authorized set");
}

export function noteOp(app: NotesHost, envelope: CommandEnvelope, kind: "split" | "merge" | "move" | "copy" | "replace" | "insert" | "remove" | "setType" | "rename") {
  app.assertWritable();
  const input = envelope.input as { objectId: string; expectedRevision: number; blockId?: string; offset?: number; toIndex?: number; atIndex?: number; blockType?: string; level?: number; ordered?: boolean; text?: string; blocks?: NoteDocument["blocks"]; title?: string; tags?: string[] };
  assertNoteAccess(app, envelope, input.objectId, true);
  const op = kind === "replace"
    ? { type: "replace" as const, blocks: input.blocks ?? [], title: input.title }
    : kind === "split"
      ? { type: "split" as const, blockId: input.blockId ?? "", offset: input.offset ?? 0 }
      : kind === "merge"
        ? { type: "merge" as const, blockId: input.blockId ?? "" }
        : kind === "move"
          ? { type: "move" as const, blockId: input.blockId ?? "", toIndex: input.toIndex ?? 0 }
          : kind === "insert"
            ? { type: "insert" as const, atIndex: input.atIndex ?? 0, blockType: input.blockType ?? "paragraph", text: input.text, level: input.level, ordered: input.ordered }
            : kind === "remove"
              ? { type: "remove" as const, blockId: input.blockId ?? "" }
              : kind === "setType"
                ? { type: "setType" as const, blockId: input.blockId ?? "", blockType: input.blockType ?? "paragraph", level: input.level ?? null, ordered: input.ordered ?? null }
                : kind === "rename"
                  ? { type: "replace" as const, blocks: (readNote(app.store, input.objectId).document as NoteDocument).blocks }
                  : { type: "copy" as const, blockId: input.blockId ?? "" };
  return commitNoteOp(app.store, {
    objectId: input.objectId,
    expectedRevision: input.expectedRevision,
    op,
    title: kind === "rename" ? input.title : input.title,
    tags: kind === "rename" ? input.tags : undefined,
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    candidate: input,
  });
}

/** Delete hides a note and takes it out of search; nothing is lost, and undelete brings it back as it was. */
export function setNoteDeleted(app: NotesHost, envelope: CommandEnvelope, objectId: string, deleted: boolean) {
  const row = app.store.sqlite.prepare("SELECT revision, payload_json, scope_json, deleted_at FROM content_objects WHERE id = ? AND type = 'notes.document'").get(objectId) as { revision: number; payload_json: string; scope_json: string; deleted_at: string | null } | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "note missing");
  const result = { objectId, deleted };
  if ((row.deleted_at !== null) === deleted) {
    app.store.commit({ mutations: [], events: [], idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId, result });
    return result;
  }
  const now = new Date().toISOString();
  const mutations: Mutation[] = [];
  if (deleted) {
    mutations.push(
      { sql: "UPDATE content_objects SET deleted_at = ?, updated_at = ? WHERE id = ?", params: [now, now, objectId] },
      { sql: "DELETE FROM search_idx WHERE fragment_id IN (SELECT id FROM text_fragments WHERE object_id = ?)", params: [objectId] },
      { sql: "DELETE FROM text_fragments WHERE object_id = ?", params: [objectId] },
    );
  } else {
    const source = app.store.sqlite.prepare("SELECT a.resource_id AS resourceId FROM refs f JOIN anchors a ON a.id = f.to_id WHERE f.from_object_id = ? AND f.to_kind = 'anchor' LIMIT 1").get(objectId) as { resourceId: string } | undefined;
    const scope = JSON.parse(row.scope_json) as { resourceId?: string | null };
    const resourceId = source?.resourceId ?? scope.resourceId ?? undefined;
    const payload = JSON.parse(row.payload_json) as { blocks?: Array<{ id: string; text?: string }> };
    mutations.push(
      { sql: "UPDATE content_objects SET deleted_at = NULL, updated_at = ? WHERE id = ?", params: [now, objectId] },
      ...(payload.blocks ?? []).flatMap((block) => app.store.indexTextChunks({ objectId, resourceId, partId: block.id, representationId: objectId, kind: "note", text: block.text ?? "" })),
    );
  }
  app.store.commit({ mutations, events: [{ type: deleted ? "note.deleted" : "note.undeleted", payload: { objectId } }], idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId, result });
  return result;
}
