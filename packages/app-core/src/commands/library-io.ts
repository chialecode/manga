/** Reading and importing resources for the library module: documents, comics, videos, folders and the scan's units. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { contextKey, MangaError, createId, type CommandEnvelope, type ContextId, type Ordinal, type ScopeGrant } from "@manga/contracts";
import { decodeTextBuffer, normalizeText } from "../domain/text.ts";
import { parseDocument, type ParsedDocument } from "../domain/formats.ts";
import { persistParsedDocument, readDocument, readOriginal, readShell, readSlice, selectionQuote } from "../reading-service.ts";
import { planDirectoryAsync, type DirectoryItem } from "../comic/scan.ts";
import { ordinalFromParsed, parseOrdinalName } from "../domain/ordinal.ts";
import type { ScanHost, ScanJob } from "../library-scan/service.ts";
import { assertOpenable, inLibrarySql, insertLocation, moveLocation, requireInLibrary } from "../library-locations.ts";
import { sampledFingerprint } from "../video/sidecars.ts";
import type { MangaProductApp } from "../product-app.ts";
import { encodeResourceCursor, decodeResourceCursor, decodeWorkerAssets } from "../product-helpers.ts";
import { snapshotRevision } from "./agent.ts";
import { queueExtras } from "./media.ts";

/** What these commands use of the application. */
export type LibraryIoHost = Pick<MangaProductApp, "agentAccess" | "assertWritable" | "builtinDanmakuCredentials" | "call" | "closed" | "comics" | "conversations" | "covers" | "danmaku" | "debugContext" | "extras" | "followFiles" | "grantOf" | "grants" | "interruptRuns" | "issueAgentGrant" | "layout" | "listModules" | "log" | "materials" | "media" | "metadata" | "notify" | "parseGeneration" | "parseWorker" | "pendingRecoveryJobs" | "projects" | "proposals" | "publicLayout" | "queryLog" | "quickTasks" | "requireModule" | "resolvePath" | "resolvePathFor" | "runAbort" | "runtime" | "scanAbort" | "screenshots" | "sealed" | "secrets" | "setModule" | "store" | "suggestedQuery" | "trace" | "uiFacets" | "vault" | "videos" | "voice" | "workFolders">;

export async function importText(app: LibraryIoHost, envelope: CommandEnvelope, signal: AbortSignal) {
  const input = envelope.input as { title: string; bytes: number[]; encoding?: "utf-8" | "utf-16le" };
  const generation = app.parseGeneration;
  const parsed = app.parseWorker
    ? await app.parseWorker.parse({ bytes: input.bytes, encoding: input.encoding, signal }) as { normalized: string; parserVersion: string; bom: boolean }
    : (() => {
      const decoded = decodeTextBuffer(Uint8Array.from(input.bytes), input.encoding ?? "utf-8");
      const normalized = normalizeText(decoded.text);
      return { normalized: normalized.normalized, parserVersion: normalized.parserVersion, bom: decoded.bom };
    })();
  if (signal.aborted || generation !== app.parseGeneration) throw new MangaError("CANCELLED", "parse result discarded after deactivate or cancel");
  app.assertWritable();
  const resourceId = createId("res");
  const workId = createId("work");
  const revisionId = createId("rev");
  const now = new Date().toISOString();
  app.store.commit({
    mutations: [
      { sql: "INSERT INTO works(id,title,created_at,media_kind,updated_at) VALUES (?,?,?,?,?)", params: [workId, input.title, now, "novel", now] },
      { sql: "INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?,?,?,?,?,?)", params: [resourceId, workId, "novel", input.title, JSON.stringify([input.title]), now] },
      { sql: "INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)", params: [revisionId, resourceId, createHash("sha256").update(Buffer.from(input.bytes)).digest("hex"), parsed.parserVersion, JSON.stringify({ id: revisionId, normalized: parsed.normalized, parserVersion: parsed.parserVersion, parts: [{ id: "body", normalized: parsed.normalized, parserVersion: parsed.parserVersion }] }), now] },
      ...app.store.indexFragment({ id: createId("frag"), resourceId, kind: "title", text: input.title }),
      ...app.store.indexTextChunks({ resourceId, resourceRevisionId: revisionId, partId: "body", representationId: revisionId, kind: "body", text: parsed.normalized }),
    ],
    events: [{ type: "resource.imported", payload: { resourceId, revisionId } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: { resourceId, workId, revisionId, length: parsed.normalized.length },
  });
  return { resourceId, workId, revisionId, normalized: parsed.normalized, bom: parsed.bom };
}

export function getResource(app: LibraryIoHost, envelope: CommandEnvelope) {
  const grant = app.grantOf(envelope);
  const input = envelope.input as { resourceId: string };
  if (!app.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
  const pinnedRevision = grant.runId ? snapshotRevision(app, grant.runId, input.resourceId) : undefined;
  const row = pinnedRevision
    ? app.store.sqlite.prepare("SELECT r.id, r.title, r.kind, v.id AS revisionId, v.parser_version AS parserVersion, v.payload_json FROM resources r JOIN resource_revisions v ON v.id = ? WHERE r.id = ?").get(pinnedRevision, input.resourceId) as
      | { id: string; title: string; kind: string; revisionId: string; parserVersion: string; payload_json: string }
      | undefined
    : app.store.sqlite.prepare("SELECT r.id, r.title, r.kind, v.id AS revisionId, v.parser_version AS parserVersion, v.payload_json FROM resources r JOIN resource_revisions v ON v.resource_id = r.id WHERE r.id = ? ORDER BY v.created_at DESC LIMIT 1").get(input.resourceId) as
      | { id: string; title: string; kind: string; revisionId: string; parserVersion: string; payload_json: string }
      | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "resource missing");
  if (grant.access !== "owner" && readShell(app.store).spoilerGuard) {
    throw new MangaError("SCOPE_DENIED", "spoiler protection requires a bounded context query");
  }
  const payload = JSON.parse(row.payload_json) as { normalized?: string; parts?: Array<{ id: string; normalized: string; parserVersion: string }> };
  return { id: row.id, title: row.title, kind: row.kind, revisionId: row.revisionId, parserVersion: row.parserVersion, parts: payload.parts ?? [{ id: "body", normalized: payload.normalized ?? "", parserVersion: row.parserVersion }] };
}

/**
 * Bounded, ordered access to the whole library. A page names at most `limit` rows and carries the cursor
 * of the next older row, so resources past the first window (and titles anywhere in the library) stay
 * reachable instead of being truncated away.
 */
export function libraryList(app: LibraryIoHost, envelope: CommandEnvelope) {
  const grant = app.grantOf(envelope);
  const input = envelope.input as { limit?: number; cursor?: string; query?: string };
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
  // The library is what is in its paths (A-113).
  const where: string[] = [inLibrarySql("r")];
  const params: string[] = [];
  if (grant.access !== "owner") {
    const ids = grant.readResourceIds;
    if (!ids.length) return { items: [], total: 0, nextCursor: null };
    where.push(`r.id IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  }
  if (input.query?.trim()) {
    where.push("r.title LIKE ? ESCAPE '\\'");
    params.push(`%${input.query.trim().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`);
  }
  // The total describes the complete filtered library; the cursor only narrows the returned page.
  const totalFilter = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = (app.store.sqlite.prepare(`SELECT COUNT(*) AS n FROM resources r${totalFilter}`).get(...params) as { n: number }).n;
  if (input.cursor) {
    const decoded = decodeResourceCursor(input.cursor);
    if (!decoded) throw new MangaError("VALIDATION_ERROR", "library page cursor is invalid");
    where.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))");
    params.push(decoded.createdAt, decoded.createdAt, decoded.id);
  }
  const filter = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const rows = app.store.sqlite.prepare(`SELECT r.id, r.title, r.kind, r.created_at AS createdAt, v.id AS revisionId
    FROM resources r
    LEFT JOIN resource_revisions v ON v.id = (
      SELECT v2.id FROM resource_revisions v2 WHERE v2.resource_id = r.id ORDER BY v2.created_at DESC, v2.rowid DESC LIMIT 1
    )${filter} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`).all(...params, limit + 1) as Array<{ id: string; title: string; kind: string; createdAt: string; revisionId: string | null }>;
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) => ({ id: row.id, title: row.title, kind: row.kind, revisionId: row.revisionId ?? null })),
    total,
    nextCursor: hasMore && last ? encodeResourceCursor({ createdAt: last.createdAt, id: last.id }) : null,
  };
}

export function scanHost(app: LibraryIoHost): ScanHost {
  return {
    importUnit: (request, signal) => importScanUnit(app, request, signal),
    afterImport: (resourceIds) => { queueExtras(app, { resources: resourceIds.map((resourceId) => ({ resourceId })) }); },
    moduleEnabled: (kind) => kind === "comic" ? app.runtime.gateway.has("comic.pages") : kind === "video" ? app.runtime.gateway.has("video.probe") : app.runtime.gateway.has("library.importDocument"),
    assertWritable: () => app.assertWritable(),
    notify: (topic, payload) => {
      app.notify(topic, payload);
      if (topic === "scan.finished") logScan(app, payload.job as ScanJob);
    },
  };
}

export function logScan(app: LibraryIoHost, job: ScanJob): void {
  app.log.record({
    actorKind: "system", category: "scan", action: "library.scan.run", objectKind: "libraryPath", objectId: job.pathId, objectLabel: path.basename(job.path) || null,
    summaryKey: "log.library.scan.run",
    summaryParams: { status: job.status, trigger: job.trigger, added: job.added, changed: job.changed, moved: job.moved, unavailable: job.unavailable, failed: job.failed, skipped: job.skipped },
    outcome: job.status === "failed" ? "error" : "ok", errorCode: job.error?.code ?? null,
  });
}

/** One unit the scan found, read into the library by the same code the folder import uses, so a scan and an import make the same works. */
export async function importScanUnit(app: LibraryIoHost, request: Parameters<ScanHost["importUnit"]>[0], signal: AbortSignal): Promise<{ resourceId: string; revisionId: string; workId: string; duplicate: boolean; replaced: boolean; relinked?: boolean }> {
  const { kind, rootAbs, groupAbs, unit, group, workId, index } = request;
  signal.throwIfAborted();
  const abs = unit.rel === "." ? rootAbs : path.join(rootAbs, ...unit.rel.split("/"));
  if (kind === "comic") {
    const item: DirectoryItem = { path: abs, type: unit.type, relative: unit.inGroup, name: path.basename(abs), imageCount: unit.imageCount };
    const result = await app.comics.importItem(item, { workId, workTitle: group.title, single: group.single, nested: group.nested, index, signal, root: groupAbs });
    return { resourceId: result.resourceId, revisionId: result.revisionId, workId: result.workId, duplicate: result.duplicate, replaced: result.replaced, relinked: result.relinked };
  }
  if (kind === "video") {
    const stem = path.basename(abs, path.extname(abs));
    const result = await app.videos.importOne({
      sourcePath: abs, title: stem, ...(group.folder ? { workTitle: group.title } : {}), workId,
      sortKey: group.nested ? `1|${String(index).padStart(12, "0")}|${stem.toLowerCase()}` : undefined, signal,
    });
    return { resourceId: result.resourceId, revisionId: result.revisionId, workId: result.workId, duplicate: result.duplicate, replaced: result.replaced, relinked: result.relinked };
  }
  const stem = unit.inGroup.replace(/\.[^./]+$/, "");
  const bytes = new Uint8Array(await fs.promises.readFile(abs));
  const parsed = await parseIncoming(app, signal, { filePath: abs, format: "auto" });
  app.assertWritable();
  const result = await persistParsedDocument(app.store, {
    title: group.folder ? stem.replaceAll("/", " / ") : stem, bytes, parsed, sourcePath: abs, hosted: false, kind: "novel", workId,
    ordinal: ordinalFromParsed(parseOrdinalName(path.basename(stem), "comic")), idempotencyKey: createId("scan"), commandId: "library.scan.start",
  });
  const resourceId = String(result.resourceId);
  const owner = (app.store.sqlite.prepare("SELECT work_id AS id FROM resources WHERE id = ?").get(resourceId) as { id: string }).id;
  if (result.duplicate !== true) {
    // The first file of a folder creates its work, named after the folder; files that come later join it.
    if (!workId && group.folder) app.store.sqlite.prepare("UPDATE works SET title = ? WHERE id = ?").run(group.title, owner);
    if (group.nested) app.store.sqlite.prepare("UPDATE resources SET sort_key = ? WHERE id = ?").run(`1|${String(index).padStart(12, "0")}|${stem.toLowerCase()}`, resourceId);
  }
  return { resourceId, revisionId: String(result.revisionId), workId: owner, duplicate: result.duplicate === true, replaced: result.replaced === true, relinked: result.relinked === true };
}

export async function parseIncoming(app: LibraryIoHost, signal: AbortSignal, input: { bytes?: Uint8Array; filePath?: string; format?: "txt" | "epub" | "mobi" | "pdf" | "auto"; encoding?: "utf-8" | "utf-16le" }): Promise<ParsedDocument> {
  const generation = app.parseGeneration;
  try {
    const parsed = app.parseWorker
      ? await app.parseWorker.parse({
        kind: "document",
        bytes: input.filePath ? undefined : [...(input.bytes ?? [])],
        filePath: input.filePath,
        format: input.format,
        encoding: input.encoding,
        signal,
      }) as ParsedDocument
      : await parseDocument(input.bytes ?? new Uint8Array(fs.readFileSync(input.filePath ?? "")), { format: input.format, encoding: input.encoding, signal });
    if (signal.aborted || generation !== app.parseGeneration) throw new MangaError("CANCELLED", "parse result discarded after deactivate or cancel");
    return decodeWorkerAssets(parsed);
  } catch (error) {
    if (error instanceof MangaError) throw error;
    if (signal.aborted || generation !== app.parseGeneration) throw new MangaError("CANCELLED", "parse cancelled");
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    if (code === "PATH_ESCAPE" || code === "UNSUPPORTED_FORMAT" || code === "VALIDATION_ERROR" || code === "CANCELLED") {
      throw new MangaError(code, message);
    }
    throw error instanceof Error ? error : new MangaError("UNSUPPORTED_FORMAT", message);
  }
}

export async function importDocument(app: LibraryIoHost, envelope: CommandEnvelope, signal: AbortSignal) {
  const input = envelope.input as { title: string; bytes?: number[]; pathHandle?: string; format?: "txt" | "epub" | "mobi" | "pdf" | "cbz" | "auto"; encoding?: "utf-8" | "utf-16le"; hosted?: boolean; kind?: "novel" | "comic" | "video"; workId?: string; ordinal?: Ordinal };
  if (input.kind === "comic") return importComicDocument(app, envelope, signal);
  if (input.kind === "video") return importVideoDocument(app, envelope, signal);
  if (input.format === "cbz") throw new MangaError("VALIDATION_ERROR", "a comic archive must be imported as a comic");
  const format = input.format as "txt" | "epub" | "mobi" | "pdf" | "auto" | undefined;
  const sourcePath = input.pathHandle ? app.resolvePath(input.pathHandle) : undefined;
  // The file is read without holding the main thread, whatever its size.
  if (sourcePath && !(await fsp.stat(sourcePath).catch(() => null))?.isFile()) throw new MangaError("NOT_FOUND", "document file is not available");
  const bytes = sourcePath ? new Uint8Array(await fsp.readFile(sourcePath, { signal })) : Uint8Array.from(input.bytes ?? []);
  const parsed = await parseIncoming(app, signal, sourcePath ? { filePath: sourcePath, format, encoding: input.encoding } : { bytes, format, encoding: input.encoding });
  app.assertWritable();
  return await persistParsedDocument(app.store, {
    title: input.title,
    bytes,
    parsed,
    sourcePath,
    hosted: input.hosted === true,
    kind: "novel",
    workId: input.workId,
    ordinal: input.ordinal,
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
  });
}

export async function inspectFile(app: LibraryIoHost, envelope: CommandEnvelope, signal: AbortSignal) {
  const input = envelope.input as { pathHandle: string };
  const source = app.resolvePathFor(input.pathHandle, ["file", "directory", "import"]);
  const requestId = envelope.requestId ?? envelope.idempotencyKey;
  // The check reads the folder in the background and says how far it has got; the answer arrives when it is done.
  app.notify("inspect.progress", { requestId, stage: "start" });
  try {
    return await app.comics.inspect(source, signal, (folders, items) => app.notify("inspect.progress", { requestId, stage: "folders", folders, items }));
  } finally {
    app.notify("inspect.progress", { requestId, stage: "done" });
  }
}

export async function importComicDocument(app: LibraryIoHost, envelope: CommandEnvelope, signal: AbortSignal) {
  app.requireModule("comic.pages", "comic reading");
  const input = envelope.input as { title: string; bytes?: number[]; pathHandle?: string; hosted?: boolean; workId?: string; ordinal?: Ordinal };
  const receipt = { idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId };
  let sourcePath = input.pathHandle ? app.resolvePathFor(input.pathHandle, ["file", "import", "directory"]) : undefined;
  let staged: string | undefined;
  let hosted = input.hosted === true;
  if (!sourcePath) {
    // Bytes only exist in memory: stage them, and keep the copy as the hosted original.
    staged = path.join(app.media.dir("staging"), `${createId("up")}.cbz`);
    fs.writeFileSync(staged, Uint8Array.from(input.bytes ?? []));
    sourcePath = staged;
    hosted = true;
  }
  try {
    const result = await app.comics.importOne({ sourcePath, title: input.title, hosted, workId: input.workId, ordinal: input.ordinal, signal, receipt });
    app.assertWritable();
    return { ...result, format: `comic-${result.source}`, kind: "comic" };
  } finally {
    if (staged) fs.rmSync(staged, { force: true });
  }
}

export async function importVideoDocument(app: LibraryIoHost, envelope: CommandEnvelope, signal: AbortSignal) {
  app.requireModule("video.probe", "video playback");
  const input = envelope.input as { title: string; pathHandle?: string; workId?: string; ordinal?: Ordinal };
  if (!input.pathHandle) throw new MangaError("VALIDATION_ERROR", "a video is imported from a file on disk, not from bytes");
  const sourcePath = app.resolvePathFor(input.pathHandle, ["file", "import", "directory"]);
  const result = await app.videos.importOne({ sourcePath, title: input.title, workId: input.workId, ordinal: input.ordinal, signal, receipt: { idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId } });
  app.assertWritable();
  return { ...result, format: "video", kind: "video" };
}

export async function importDirectory(app: LibraryIoHost, envelope: CommandEnvelope, signal: AbortSignal) {
  const input = envelope.input as { pathHandle: string; kind: "novel" | "comic" | "video"; title?: string; workId?: string; hosted?: boolean };
  const root = app.resolvePathFor(input.pathHandle, ["directory", "import"]);
  const receipt = { idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId };
  const progress = (done: number, total: number, label: string) => app.notify("import.progress", { requestId: envelope.requestId ?? envelope.idempotencyKey, done, total, label });
  // A folder is read through a library path unless the application keeps its own copies (A-80); saying so first beats listing every file as failed.
  if (!(input.hosted === true && input.kind !== "video")) requireInLibrary(app.store, root, { isFolder: true });
  if (input.kind === "comic") {
    app.requireModule("comic.pages", "comic reading");
    return app.comics.importDirectory({ root, title: input.title, workId: input.workId, hosted: input.hosted, signal, progress, receipt });
  }
  if (input.kind === "video") {
    app.requireModule("video.probe", "video playback");
    return app.videos.importDirectory({ root, title: input.title, workId: input.workId, signal, progress, receipt });
  }
  return importNovelDirectory(app, { root, title: input.title, workId: input.workId, hosted: input.hosted === true, signal, progress, receipt });
}

/** Every text file and book below the folder becomes one volume of one work, in natural order. */
export async function importNovelDirectory(app: LibraryIoHost, input: { root: string; title?: string; workId?: string; hosted: boolean; signal: AbortSignal; progress: (done: number, total: number, label: string) => void; receipt: { idempotencyKey: string; commandId: string } }) {
  if (!(await fsp.stat(input.root).catch(() => null))?.isDirectory()) throw new MangaError("NOT_FOUND", "the folder is not available");
  const plan = (await planDirectoryAsync(input.root, ["novel"], { signal: input.signal })).novel;
  if (!plan.items.length) throw new MangaError("UNSUPPORTED_FORMAT", "the folder holds no text files or books");
  const nested = plan.items.some((item) => item.relative.includes("/"));
  const workTitle = input.title ?? path.basename(input.root);
  const resources: Array<Record<string, unknown>> = [];
  let workId = input.workId;
  let done = 0;
  for (const item of plan.items) {
    input.signal.throwIfAborted();
    input.progress(done, plan.items.length, item.relative);
    try {
      const stem = item.relative.replace(/\.[^./]+$/, "");
      const parsedName = ordinalFromParsed(parseOrdinalName(path.basename(stem), "comic"));
      const bytes = new Uint8Array(await fsp.readFile(item.path, { signal: input.signal }));
      const parsed = await parseIncoming(app, input.signal, { filePath: item.path, format: "auto" });
      app.assertWritable();
      const result = await persistParsedDocument(app.store, {
        title: stem.replaceAll("/", " / "),
        bytes,
        parsed,
        sourcePath: item.path,
        hosted: input.hosted,
        kind: "novel",
        workId,
        ordinal: parsedName,
        idempotencyKey: `${input.receipt.idempotencyKey}:${done}`,
        commandId: input.receipt.commandId,
      });
      const resourceId = String(result.resourceId);
      if (!workId) workId = (app.store.sqlite.prepare("SELECT work_id AS id FROM resources WHERE id = ?").get(resourceId) as { id: string }).id;
      if (nested) app.store.sqlite.prepare("UPDATE resources SET sort_key = ? WHERE id = ?").run(`1|${String(done).padStart(12, "0")}|${stem.toLowerCase()}`, resourceId);
      resources.push({ ...result, relative: item.relative });
    } catch (error) {
      if (error instanceof MangaError && error.code === "CANCELLED") throw error;
      if (input.signal.aborted) throw new MangaError("CANCELLED", "import was cancelled");
      const known = error instanceof MangaError ? { code: error.code, message: error.message } : { code: "UNSUPPORTED_FORMAT", message: error instanceof Error ? error.message : String(error) };
      resources.push({ relative: item.relative, error: known });
    }
    done += 1;
  }
  input.progress(done, plan.items.length, "");
  if (!workId) throw new MangaError("UNSUPPORTED_FORMAT", "none of the files in the folder could be read", { details: { failures: resources.length } });
  if (!input.workId) app.store.sqlite.prepare("UPDATE works SET title = ? WHERE id = ?").run(workTitle, workId);
  const value = { workId, resources, truncated: plan.truncated };
  app.store.commit({ mutations: [], events: [], idempotencyKey: input.receipt.idempotencyKey, commandId: input.receipt.commandId, result: value });
  return value;
}

export function readResourceOriginal(app: LibraryIoHost, envelope: CommandEnvelope) {
  const grant = app.grantOf(envelope);
  if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "only the owner can read original bytes");
  const input = envelope.input as { resourceId: string; revisionId?: string };
  if (!app.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
  const snapshot = grant.runId ? snapshotRevision(app, grant.runId, input.resourceId) : undefined;
  if (snapshot && input.revisionId && snapshot !== input.revisionId) throw new MangaError("REVISION_CONFLICT", "requested material revision differs from the run snapshot");
  return readOriginal(app.store, input.resourceId, snapshot ?? input.revisionId);
}

export function readResource(app: LibraryIoHost, envelope: CommandEnvelope) {
  const grant = app.grantOf(envelope);
  const input = envelope.input as { resourceId: string; revisionId?: string; contextId?: ContextId };
  if (!app.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
  assertOpenable(app.store, input.resourceId);
  const snapshot = grant.runId ? snapshotRevision(app, grant.runId, input.resourceId) : undefined;
  if (snapshot && input.revisionId && snapshot !== input.revisionId) throw new MangaError("REVISION_CONFLICT", "requested material revision differs from the run snapshot");
  const document = readDocument(app.store, input.resourceId, snapshot ?? input.revisionId, contextKey(input.contextId));
  const slice = document.slice as { partId: string; start: number; end: number; textLayer: boolean } | null;
  if (slice?.textLayer) assertConsumedRange(app, grant, input.resourceId, String(document.revisionId), slice.partId, slice.start, slice.end);
  return document;
}

export function readResourceSlice(app: LibraryIoHost, envelope: CommandEnvelope) {
  const grant = app.grantOf(envelope);
  const input = envelope.input as { resourceId: string; revisionId?: string; partId: string; start?: number; limit?: number };
  if (!app.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
  assertOpenable(app.store, input.resourceId);
  const snapshot = grant.runId ? snapshotRevision(app, grant.runId, input.resourceId) : undefined;
  if (snapshot && input.revisionId && snapshot !== input.revisionId) throw new MangaError("REVISION_CONFLICT", "requested material revision differs from the run snapshot");
  const slice = readSlice(app.store, { ...input, revisionId: snapshot ?? input.revisionId });
  if (slice.textLayer) assertConsumedRange(app, grant, input.resourceId, String(slice.revisionId), input.partId, Number(slice.start), Number(slice.end));
  return slice;
}

export function assertConsumedRange(app: LibraryIoHost, grant: ScopeGrant, resourceId: string, resourceRevisionId: string, partId: string, start: number, end: number): void {
  if (grant.access === "owner" || !readShell(app.store).spoilerGuard) return;
  const range = selectionQuote(app.store, { resourceId, resourceRevisionId, partId, start, end }, true);
  if (range.blocked) throw new MangaError("SCOPE_DENIED", "requested range is outside consumed progress");
}

export async function repairSource(app: LibraryIoHost, envelope: CommandEnvelope, signal: AbortSignal) {
  app.assertWritable();
  const grant = app.grantOf(envelope);
  if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "only the owner can repair a source file");
  const input = envelope.input as { resourceId: string; pathHandle: string };
  const sourcePath = app.resolvePath(input.pathHandle);
  // A file is only ever read through a library path (A-80): the one picked has to be inside one, and nothing else is looked at before that is known.
  const placed = requireInLibrary(app.store, sourcePath);
  const resource = app.store.sqlite.prepare("SELECT kind FROM resources WHERE id = ?").get(input.resourceId) as { kind: string } | undefined;
  if (!resource) throw new MangaError("NOT_FOUND", "resource missing");
  if (resource.kind === "video" || resource.kind === "comic") {
    // A video or a comic is not re-read from a new file: the file picked has to be the same content, at its new place.
    const stat = fs.statSync(sourcePath, { throwIfNoEntry: false });
    if (!stat || (resource.kind === "video" && !stat.isFile())) throw new MangaError("NOT_FOUND", "replacement file is not available");
    const revision = app.store.sqlite.prepare("SELECT id, fingerprint FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(input.resourceId) as { id: string; fingerprint: string } | undefined;
    if (!revision) throw new MangaError("NOT_FOUND", "resource has no revision");
    const fingerprint = resource.kind === "video" ? await sampledFingerprint(sourcePath, signal) : (await app.comics.scan(sourcePath, { signal })).fingerprint;
    if (fingerprint !== revision.fingerprint) throw new MangaError("VALIDATION_ERROR", "that file is not the one app resource was made from", { details: { reason: "different-file" } });
    if (!moveLocation(app.store, { revisionId: revision.id, placed, fingerprint })) {
      const insert = insertLocation({ revisionId: revision.id, placed, fingerprint });
      app.store.sqlite.prepare(insert.sql).run(...(insert.params ?? []));
    }
    const result = { resourceId: input.resourceId, revisionId: revision.id, replaced: false, relinked: true, pointersKept: 0 };
    app.store.commit({ mutations: [], events: [{ type: "resource.relocated", payload: { resourceId: input.resourceId, revisionId: revision.id } }], idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId, result });
    return result;
  }
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new MangaError("NOT_FOUND", "replacement file is not available");
  const bytes = new Uint8Array(fs.readFileSync(sourcePath));
  const parsed = await parseDocument(bytes, { signal });
  return await persistParsedDocument(app.store, {
    title: sourcePath,
    bytes,
    parsed,
    sourcePath,
    hosted: false,
    resourceId: input.resourceId,
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
  });
}
