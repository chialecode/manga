import { createHash } from "node:crypto";
import { MangaError, createId, validateCommandInput, ProfileConfigSchema, type ProfileConfig, type Actor, type CommandEnvelope, type CommandResult } from "@manga/contracts";
import { MangaRuntime } from "@manga/kernel";
import { SqliteStore, acquireHostLock, releaseHostLock } from "@manga/storage-sqlite";
import { defineModule, type MangaModule } from "@manga/plugin-sdk";
import { parseEpub } from "../domain/epub.ts";
import { createTextLocator, decodeTextBuffer, normalizeText, resolveTextLocator } from "../domain/text-locator.ts";
import { exportLibraryPackage, importLibraryPackage } from "../domain/library-package.ts";
import { associateAsrResult, captureOffsetFromSamples, mapCaptureToSources, runAsrFixture } from "../domain/capture.ts";
import { confirmCandidate, mergeFields, queryProvider, disambiguate } from "../domain/metadata.ts";
import { applyEdit, createEditor, embedStatus, mergeBlockWithNext, splitBlock } from "../domain/notes.ts";
import { ensurePlaybackDerivative, playbackPathFor } from "../domain/webm.ts";
import { startParseWorker, type ParseClient } from "../hosts/parse-client.ts";
import { downloadToStaging, fingerprintFile, publishAtomic, safeFileName } from "../domain/acquisition.ts";
import path from "node:path";
import fs from "node:fs";

export type AppOptions = {
  profileDir: string;
  hostId: string;
  crashAt?: string;
  includeAcquisition?: boolean;
  includeReader?: boolean;
  includeMetadata?: boolean;
  useParseWorker?: boolean;
};

export class MangaApp {
  readonly runtime: MangaRuntime;
  readonly store: SqliteStore;
  private readonly lock;
  private readonly profileDir: string;
  private readonly hostId: string;
  readerEnabled = true;
  readerUiEnabled = false;
  private readonly pendingOperations = new Map<string, Promise<CommandResult>>();
  private parseWorker: ParseClient | undefined;
  private readonly useParseWorker: boolean;
  private parseGeneration = 0;

  constructor(options: AppOptions) {
    this.profileDir = options.profileDir;
    this.hostId = options.hostId;
    this.useParseWorker = options.useParseWorker === true;
    this.lock = acquireHostLock(options.profileDir, options.hostId);
    try { this.store = new SqliteStore({
      profileDir: options.profileDir,
      hostId: options.hostId,
      crashAt: options.crashAt,
    }); } catch(error) { releaseHostLock(options.profileDir,options.hostId); throw error; }
    const modules = [
      this.libraryModule(),
      this.notesModule(),
      ...(options.includeReader === false ? [] : [this.readerModule()]),
      ...(options.includeMetadata === false ? [] : [this.metadataAlpha(), this.metadataBeta(), this.metadataHub()]),
      ...(options.includeAcquisition === false ? [] : [this.acquisitionModule()]),
    ];
    this.runtime = new MangaRuntime(modules);
  }

  async start(features?: string[]): Promise<void> {
    const saved=this.store.db.prepare("SELECT value FROM schema_meta WHERE key='lastValidProfile'").get() as {value:string}|undefined;
    await this.applyProfile(!features && saved ? ProfileConfigSchema.parse(JSON.parse(saved.value)) : {
      profileId: "m0",
      revision: 1,
      enabledFeatures: features ?? ["library", "notes", "novel-reader", "metadata", "download"],
      disabledFeatures: [],
      preferredProviders: {
        "manga.metadata.provider": ["m0.metadata.alpha", "m0.metadata.beta"],
      },
    });
    this.store.replayUnpublished();
  }

  async applyProfile(profile: ProfileConfig): Promise<void> {
    await this.runtime.applyProfile(profile);
    this.store.db.prepare("INSERT INTO schema_meta(key,value) VALUES ('lastValidProfile',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(profile));
  }

  close(): void {
    this.parseWorker?.kill();
    this.parseWorker = undefined;
    this.store.close();
    releaseHostLock(this.profileDir, this.hostId);
  }

  async call(actor: Actor, untrusted: unknown, requestId?: string, scopeHandle = "library"): Promise<CommandResult> {
    try {
    const envelope = this.runtime.gateway.sealFromTrusted({
      untrusted,
      actor,
      scopeHandle,
      requestId,
    });
    if (envelope.commandVersion !== 1) throw new Error("unsupported command version");
    envelope.input = validateCommandInput(envelope.commandId, envelope.input);
    if (!this.runtime.gateway.admits(envelope)) throw new MangaError("CAPABILITY_UNAVAILABLE", "capability unavailable");
    const inputHash=fingerprintOf(JSON.stringify(envelope.input));
    const request=this.store.db.prepare("SELECT command_id,input_hash FROM command_requests WHERE idempotency_key=?").get(envelope.idempotencyKey) as {command_id:string;input_hash:string}|undefined;
    if(request && (request.command_id !== envelope.commandId || request.input_hash !== inputHash)) throw new MangaError("VALIDATION_ERROR","idempotency key reused with different input");
    this.store.db.prepare("INSERT OR IGNORE INTO command_requests(idempotency_key,command_id,input_hash) VALUES (?,?,?)").run(envelope.idempotencyKey,envelope.commandId,inputHash);
    const prior = this.store.db.prepare("SELECT command_id FROM operations WHERE idempotency_key = ?").get(envelope.idempotencyKey) as { command_id: string } | undefined;
    if (prior && prior.command_id !== envelope.commandId) throw new Error("idempotency key belongs to another command");
    const existing = this.store.loadIdempotent(envelope.idempotencyKey);
    if (existing) {
      return { ...existing, idempotentReplay: true };
    }
    const pending = this.pendingOperations.get(envelope.idempotencyKey);
    if (pending) return pending;
    const work = this.runtime.gateway.execute(envelope);
    this.pendingOperations.set(envelope.idempotencyKey, work);
    try { return await work; } finally { this.pendingOperations.delete(envelope.idempotencyKey); }
    } catch (error) {
      return { status: "error", error: error instanceof MangaError ? error.toJSON() : { code: "VALIDATION_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false, details: {} } };
    }
  }

  workspaceSnapshot() {
    const notes = this.store.db.prepare("SELECT id, revision, title, payload_json FROM content_objects WHERE type = 'notes.document' AND deleted_at IS NULL ORDER BY updated_at DESC").all() as Array<{ id: string; revision: number; title: string; payload_json: string }>;
    const resources = this.store.db.prepare("SELECT r.id, r.title, v.id AS revisionId, v.payload_json FROM resources r JOIN resource_revisions v ON v.resource_id = r.id ORDER BY r.created_at DESC LIMIT 100").all() as Array<{ id: string; title: string; revisionId: string; payload_json: string }>;
    return {
      notes: notes.map(({ payload_json, ...row }) => {
        const payload = JSON.parse(payload_json) as { blocks?: Array<{ id: string; type: string; text: string; targetId?: string; targetKind?: string }> };
        return { ...row, text: (payload.blocks ?? []).map((block) => block.text).join("\n"), blocks: payload.blocks ?? [] };
      }),
      resources: resources.map(({ payload_json, ...row }) => {
        const payload = JSON.parse(payload_json);
        const text = payload.normalized ?? payload.parts?.map((part: { normalized: string }) => part.normalized).join("\n\n") ?? "文件资源";
        return { ...row, text: text.slice(0, 400), previewOnly: text.length > 400, length: text.length };
      }),
      captures: (this.store.db.prepare("SELECT id, attachment_id AS attachmentId, clock_json AS metadata, created_at AS createdAt FROM capture_sessions ORDER BY created_at DESC").all() as Array<{ id: string; attachmentId: string; metadata: string; createdAt: string }>).map((item) => {
        const meta = JSON.parse(item.metadata || "{}") as { durationMs?: number; playback?: { durationMs?: number } };
        const original = path.join(this.store.attachmentsDir, item.attachmentId);
        const playback = playbackPathFor(original);
        return {
          ...item,
          durationMs: meta.playback?.durationMs ?? meta.durationMs,
          playbackReady: fs.existsSync(playback),
          originalBytes: fs.existsSync(original) ? fs.statSync(original).size : 0,
        };
      }),
      readerUiEnabled: this.readerUiEnabled,
    };
  }

  private libraryModule(): MangaModule {
    return defineModule({
      manifest: {
        moduleId: "m0.library",
        version: "0.0.1",
        displayName: "Library",
        featureId: "library",
        contributes: [{ capabilityId: "manga.library", version: "1.0.0" }],
        needs: [],
        facets: ["service", "worker"],
        conflictsWith: [],
        ownerModuleIds: [],
      },
      activate: (ctx) => {
        if (this.useParseWorker && !this.parseWorker) this.parseWorker = startParseWorker();
        if (this.parseWorker) {
          ctx.register({
            kind: "worker",
            id: `parse-worker-${ctx.epoch}`,
            dispose: () => {
              this.parseGeneration += 1;
              this.parseWorker?.kill();
              this.parseWorker = undefined;
            },
          });
        }
        this.runtime.registerCommand("m0.library", "workspace.get", () => this.workspaceSnapshot());
        this.runtime.registerCommand("m0.library", "metadata.override", async envelope => this.overrideMetadata(envelope));
        this.runtime.registerCommand("m0.library", "library.importText", async (envelope, signal) => this.importText(envelope, signal));
        this.runtime.registerCommand("m0.library", "library.importEpub", async (envelope, signal) => this.importEpub(envelope, signal));
        this.runtime.registerCommand("m0.library", "library.getResource", async (envelope) => this.getResource(envelope));
        this.runtime.registerCommand("m0.library", "library.contextSnapshot", async (envelope) => this.contextSnapshot(envelope));
        this.runtime.registerCommand("m0.library", "library.exportPackage", async (envelope) => this.exportPackage(envelope));
        this.runtime.registerCommand("m0.library", "library.importPackage", async (envelope) => this.importPackage(envelope));
        this.runtime.registerCommand("m0.library", "library.search", async (envelope) => {
          const input = envelope.input as { text: string; readAllowlist?: string[] };
          return this.store.search({ text: input.text, readAllowlist: input.readAllowlist });
        });
        this.runtime.registerCommand("m0.library", "progress.set", async (envelope) => this.setProgress(envelope));
        this.runtime.registerCommand("m0.library", "metadata.confirm", async (envelope) => this.confirmMetadata(envelope));
      },
      deactivate: () => {
        this.parseGeneration += 1;
      },
    });
  }

  private readerModule(): MangaModule {
    return defineModule({
      manifest: {
        moduleId: "m0.reader.novel",
        version: "0.0.1",
        displayName: "Novel reader",
        featureId: "novel-reader",
        contributes: [{ capabilityId: "manga.reader.novel", version: "1.0.0" }],
        needs: [{ capabilityId: "manga.library", version: "1.0.0", cardinality: "single", required: true }],
        facets: ["service", "ui"],
        conflictsWith: [],
        ownerModuleIds: [],
      },
      activate: (ctx) => {
        this.readerEnabled = true;
        this.readerUiEnabled = true;
        ctx.register({
          kind: "subscription",
          id: `reader-sub-${ctx.epoch}`,
          dispose: () => {
            this.readerEnabled = false;
            this.readerUiEnabled = false;
          },
        });
        this.runtime.registerCommand("m0.reader.novel", "reader.resolveAnchor", async (envelope) => {
          const input = envelope.input as { resourceRevisionId: string; locator: ReturnType<typeof createTextLocator> };
          const row = this.store.db.prepare("SELECT payload_json FROM resource_revisions WHERE id = ?").get(input.resourceRevisionId) as
            | { payload_json: string }
            | undefined;
          if (!row) return { status: "missing_revision" };
          const payload = JSON.parse(row.payload_json) as { id: string; normalized?: string; parserVersion?: string; parts?: Array<{ id: string; normalized: string; parserVersion: string }> };
          const part = payload.parts?.find(item => item.id === input.locator.partId);
          if (payload.parts && !part) return { status: "unresolved", reason: "source part missing" };
          if (!payload.parts && input.locator.partId !== "body") return { status: "unresolved", reason: "source part missing" };
          const normalized = part?.normalized ?? payload.normalized ?? "";
          return resolveTextLocator(input.locator, { id: input.resourceRevisionId, normalized, parserVersion: part?.parserVersion ?? payload.parserVersion ?? "novel-parser-v1", available: true });
        });
        this.runtime.registerCommand("m0.reader.novel", "reader.ui.present", () => ({ available: this.readerUiEnabled, facet: "ui" }));
      },
      deactivate: () => {
        this.readerEnabled = false;
        this.readerUiEnabled = false;
      },
    });
  }

  private notesModule(): MangaModule {
    return defineModule({
      manifest: {
        moduleId: "m0.notes",
        version: "0.0.1",
        displayName: "Notes",
        featureId: "notes",
        contributes: [{ capabilityId: "manga.notes", version: "1.0.0" }],
        needs: [{ capabilityId: "manga.library", version: "1.0.0", cardinality: "single", required: true }],
        facets: ["service", "ui"],
        conflictsWith: [],
        ownerModuleIds: [],
      },
      activate: () => {
        this.runtime.registerCommand("m0.notes", "capture.save", (envelope) => this.saveCapture(envelope));
        this.runtime.registerCommand("m0.notes", "capture.stat", (envelope) => this.statCapture(envelope));
        this.runtime.registerCommand("m0.notes", "capture.preparePlayback", (envelope) => this.prepareCapturePlayback(envelope));
        this.runtime.registerCommand("m0.notes", "capture.markPlayback", (envelope) => this.markCapturePlayback(envelope));
        this.runtime.registerCommand("m0.notes", "notes.create", async (envelope) => this.createNote(envelope));
        this.runtime.registerCommand("m0.notes", "notes.update", async (envelope) => this.updateNote(envelope));
        this.runtime.registerCommand("m0.notes", "notes.split", async (envelope) => this.splitNote(envelope));
        this.runtime.registerCommand("m0.notes", "notes.merge", async (envelope) => this.mergeNote(envelope));
        this.runtime.registerCommand("m0.notes", "notes.embed", async (envelope) => this.embedNote(envelope));
      },
      deactivate: () => undefined,
    });
  }

  private metadataAlpha(): MangaModule {
    return this.providerStub("m0.metadata.alpha", "Fake Alpha");
  }

  private metadataBeta(): MangaModule {
    return this.providerStub("m0.metadata.beta", "Fake Beta");
  }

  private providerStub(moduleId: string, displayName: string): MangaModule {
    return defineModule({
      manifest: {
        moduleId,
        version: "0.0.1",
        displayName,
        featureId: moduleId,
        contributes: [{ capabilityId: "manga.metadata.provider", version: "1.0.0", cardinality: "many" }],
        needs: [],
        facets: ["service"],
        conflictsWith: [],
        ownerModuleIds: [],
      },
      activate: () => undefined,
      deactivate: () => undefined,
    });
  }

  private metadataHub(): MangaModule {
    return defineModule({
      manifest: {
        moduleId: "m0.metadata.hub",
        version: "0.0.1",
        displayName: "Metadata hub",
        featureId: "metadata",
        contributes: [{ capabilityId: "manga.metadata.hub", version: "1.0.0" }],
        needs: [{ capabilityId: "manga.metadata.provider", version: "1.0.0", cardinality: "many", required: true }],
        facets: ["service"],
        conflictsWith: [],
        ownerModuleIds: [],
      },
      activate: () => {
        this.runtime.registerCommand("m0.metadata.hub", "metadata.query", async (envelope,signal) => this.queryMetadata(envelope,signal));
      },
      deactivate: () => undefined,
    });
  }

  private acquisitionModule(): MangaModule {
    return defineModule({
      manifest: {
        moduleId: "m0.acquisition",
        version: "0.0.1",
        displayName: "Acquisition",
        featureId: "download",
        contributes: [{ capabilityId: "manga.acquisition", version: "1.0.0" }],
        needs: [{ capabilityId: "manga.library", version: "1.0.0", cardinality: "single", required: true }],
        facets: ["service"],
        conflictsWith: [],
        ownerModuleIds: [],
      },
      activate: () => {
        this.runtime.registerCommand("m0.acquisition", "acquisition.start", async (envelope, signal) => this.acquire(envelope, signal));
      },
      deactivate: () => undefined,
    });
  }

  private async importText(envelope: CommandEnvelope, signal: AbortSignal) {
    const input = envelope.input as { title: string; bytes: number[]; encoding?: "utf-8" | "utf-16le" };
    const generation = this.parseGeneration;
    const parsed = this.parseWorker
      ? await this.parseWorker.parse({ kind: "text", bytes: input.bytes, encoding: input.encoding, signal }) as { normalized: string; parserVersion: string; bom: boolean }
      : (() => {
        const decoded = decodeTextBuffer(Uint8Array.from(input.bytes), input.encoding ?? "utf-8");
        const normalized = normalizeText(decoded.text);
        return { normalized: normalized.normalized, parserVersion: normalized.parserVersion, bom: decoded.bom };
      })();
    if (signal.aborted || generation !== this.parseGeneration) throw new MangaError("CANCELLED", "parse result discarded after deactivate or cancel");
    const resourceId = createId("res");
    const workId = createId("work");
    const revisionId = createId("rev");
    const now = new Date().toISOString();
    const mutations = [
      {sql:"INSERT INTO works(id,title,created_at) VALUES (?,?,?)",params:[workId,input.title,now]},
      {
        sql: "INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        params: [resourceId, workId, "novel", input.title, JSON.stringify([input.title]), now],
      },
      {
        sql: "INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        params: [revisionId, resourceId, createHash("sha256").update(Buffer.from(input.bytes)).digest("hex"), parsed.parserVersion, JSON.stringify({
          id: revisionId,
          normalized: parsed.normalized,
          parserVersion: parsed.parserVersion,
          bom: parsed.bom,
          parts: [{ id: "body", normalized: parsed.normalized, parserVersion: parsed.parserVersion }],
        }), now],
      },
      ...this.store.indexFragment({
        id: createId("frag"),
        resourceId,
        kind: "title",
        text: input.title,
      }),
      ...this.store.indexFragment({
        id: createId("frag"),
        resourceId,
        kind: "body",
        text: parsed.normalized.slice(0, 4000),
      }),
    ];
    this.store.commit({
      mutations,
      events: [{ type: "resource.imported", payload: { resourceId, revisionId } }],
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      result: { resourceId, workId, revisionId, length: parsed.normalized.length },
    });
    return { resourceId, workId, revisionId, normalized: parsed.normalized, bom: parsed.bom };
  }

  private async importEpub(envelope: CommandEnvelope, signal: AbortSignal) {
    const input = envelope.input as { title: string; bytes: number[] };
    const generation = this.parseGeneration;
    const parsed = this.parseWorker
      ? await this.parseWorker.parse({ kind: "epub", bytes: input.bytes, signal }) as { title: string; parts: Array<{ id: string; normalized: string; parserVersion: string }> }
      : (() => {
        const epub = parseEpub(Uint8Array.from(input.bytes));
        return { title: epub.title, parts: epub.parts.map((part) => ({ id: part.id, normalized: part.text.normalized, parserVersion: part.text.parserVersion })) };
      })();
    if (signal.aborted || generation !== this.parseGeneration) throw new MangaError("CANCELLED", "parse result discarded after deactivate or cancel");
    const resourceId = createId("res");
    const workId = createId("work");
    const revisionId = createId("rev");
    const now = new Date().toISOString();
    this.store.commit({
      mutations: [
        {sql:"INSERT INTO works(id,title,created_at) VALUES (?,?,?)",params:[workId,parsed.title || input.title,now]},
        {
          sql: "INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          params: [resourceId, workId, "novel", parsed.title || input.title, JSON.stringify([parsed.title]), now],
        },
        {
          sql: "INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          params: [revisionId, resourceId, createHash("sha256").update(Buffer.from(input.bytes)).digest("hex"), parsed.parts[0]?.parserVersion ?? "novel-parser-v1", JSON.stringify({
            id: revisionId,
            parts: parsed.parts,
          }), now],
        },
      ],
      events: [{ type: "resource.imported", payload: { resourceId, revisionId } }],
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      result: { resourceId, workId, revisionId, parts: parsed.parts.length },
    });
    return { resourceId, workId, revisionId, parts: parsed.parts };
  }

  private createNote(envelope: CommandEnvelope) {
    const input = envelope.input as {
      title: string;
      text: string;
      resourceId?: string;
      resourceRevisionId?: string;
      locator?: ReturnType<typeof createTextLocator>;
    };
    const objectId = createId("obj");
    const anchorId = input.locator ? createId("anc") : undefined;
    const now = new Date().toISOString();
    const mutations = [
      {
        sql: "INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, attachment_ids_json, preview_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        params: [objectId, "notes.document", "m0.notes", JSON.stringify({ kind: "library" }), 1, 1, input.title, JSON.stringify({ blocks: [{ id: "b1", type: "paragraph", text: input.text }] }), "[]", JSON.stringify({ text: input.text.slice(0, 80) }), now, now],
      },
      {
        sql: "INSERT INTO object_revisions(object_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?)",
        params: [objectId, 1, JSON.stringify({ blocks: [{ id: "b1", text: input.text }] }), now],
      },
      ...this.store.indexFragment({ id: createId("frag"), objectId, resourceId: input.resourceId, kind: "note", text: input.text }),
    ];
    if (anchorId && input.resourceId && input.resourceRevisionId && input.locator) {
      mutations.push({
        sql: "INSERT INTO anchors(id, resource_id, resource_revision_id, locator_json, preview_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        params: [anchorId, input.resourceId, input.resourceRevisionId, JSON.stringify(input.locator), JSON.stringify({ text: input.locator.quote?.exact }), now],
      });
      mutations.push({
        sql: "INSERT INTO refs(id, from_object_id, from_block_id, to_kind, to_id, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        params: [createId("ref"), objectId, "b1", "anchor", anchorId, "live", now],
      });
    }
    this.store.commit({
      mutations,
      events: [{ type: "note.created", payload: { objectId, anchorId } }],
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      result: { objectId, revision: 1, anchorId },
    });
    return { objectId, revision: 1, anchorId };
  }

  private updateNote(envelope: CommandEnvelope) {
    const input = envelope.input as { objectId: string; expectedRevision: number; blockId?: string; text: string };
    const row = this.store.db.prepare("SELECT revision, payload_json FROM content_objects WHERE id = ?").get(input.objectId) as
      | { revision: number; payload_json: string }
      | undefined;
    if (!row) throw new Error("note missing");
    if (row.revision !== input.expectedRevision) {
      throw new MangaError("REVISION_CONFLICT", "note revision changed", {
        details: { expected: input.expectedRevision, actual: row.revision },
      });
    }
    const next = row.revision + 1;
    const indexed = this.store.db.prepare("SELECT resource_id FROM text_fragments WHERE object_id = ? LIMIT 1").get(input.objectId) as { resource_id?: string } | undefined;
    const payload = JSON.parse(row.payload_json);
    if (!input.blockId && payload.blocks.length !== 1) throw new MangaError("VALIDATION_ERROR", "a blockId is required for a multi-block note");
    const block = input.blockId ? payload.blocks.find((item: {id: string}) => item.id === input.blockId) : payload.blocks[0];
    if (!block || block.type === "embed") throw new MangaError("VALIDATION_ERROR", "editable note block missing");
    block.text = input.text;
    const fullText = payload.blocks.map((item: {text: string}) => item.text).join("\n");
    const encoded = JSON.stringify(payload);
    const now = new Date().toISOString();
    this.store.commit({
      mutations: [
        {
          sql: "UPDATE content_objects SET revision = ?, payload_json = ?, preview_json = ?, updated_at = ? WHERE id = ?",
          params: [next, encoded, JSON.stringify({ text: fullText.slice(0, 80) }), now, input.objectId],
        },
        {
          sql: "INSERT INTO object_revisions(object_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?)",
          params: [input.objectId, next, encoded, now],
        },
        { sql: "DELETE FROM search_idx WHERE fragment_id IN (SELECT id FROM text_fragments WHERE object_id = ?)", params: [input.objectId] },
        { sql: "DELETE FROM text_fragments WHERE object_id = ?", params: [input.objectId] },
        ...this.store.indexFragment({ id: createId("frag"), objectId: input.objectId, resourceId: indexed?.resource_id, kind: "note", text: fullText }),
      ],
      events: [{ type: "note.updated", payload: { objectId: input.objectId, revision: next } }],
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      result: { objectId: input.objectId, revision: next },
    });
    return { objectId: input.objectId, revision: next };
  }

  private saveCapture(envelope: CommandEnvelope) {
    const input = envelope.input as { bytes: number[]; mimeType: string; metadata: Record<string, unknown> };
    const id = `capture_${fingerprintOf(envelope.idempotencyKey).slice(0, 24)}`;
    const attachmentId = `${id}.webm`;
    const file = path.join(this.store.attachmentsDir, attachmentId);
    const bytes = Buffer.from(input.bytes);
    writeAttachmentIdempotent(file, bytes);
    const originalFingerprint = createHash("sha256").update(bytes).digest("hex");
    const playbackMeta: Record<string, unknown> = { originalUnchanged:true, method:"renderer-decoded-pcm", originalFingerprint };
    if (!fs.readFileSync(file).equals(bytes)) throw new MangaError("VALIDATION_ERROR", "original recording was modified");
    const metadata = { ...input.metadata, captureId: id, originalFingerprint, playback: playbackMeta };
    const now = new Date().toISOString();
    const existing = this.store.db.prepare("SELECT id FROM capture_sessions WHERE id = ?").get(id) as { id: string } | undefined;
    if (!existing) {
      this.store.commit({
        mutations: [{ sql: "INSERT INTO capture_sessions(id, clock_json, status, attachment_id, created_at) VALUES (?, ?, 'saved', ?, ?)", params: [id, JSON.stringify(metadata), attachmentId, now] }],
        events: [{ type: "capture.saved", payload: { id } }],
        idempotencyKey: envelope.idempotencyKey,
        commandId: envelope.commandId,
        result: { id, attachmentId, durationMs: playbackMeta.durationMs },
      });
    }
    return { id, attachmentId, durationMs: playbackMeta.durationMs, replayed: Boolean(existing) };
  }

  private statCapture(envelope: CommandEnvelope) {
    const input = envelope.input as { attachmentId: string };
    const row = this.store.db.prepare("SELECT id, attachment_id, clock_json FROM capture_sessions WHERE attachment_id = ?").get(input.attachmentId) as { id: string; attachment_id: string; clock_json: string } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "capture attachment is not in this profile");
    const original = path.join(this.store.attachmentsDir, row.attachment_id);
    if (!fs.existsSync(original)) throw new MangaError("NOT_FOUND", "original recording file is missing");
    return {
      id: row.id,
      attachmentId: row.attachment_id,
      originalPath: original,
      playbackPath: playbackPathFor(original),
      bytes: fs.statSync(original).size,
      metadata: JSON.parse(row.clock_json),
    };
  }

  private prepareCapturePlayback(envelope: CommandEnvelope) {
    const stat = this.statCapture(envelope) as { originalPath: string; attachmentId: string };
    const playback = ensurePlaybackDerivative(stat.originalPath);
    return { attachmentId: stat.attachmentId, ...playback };
  }

  private markCapturePlayback(envelope: CommandEnvelope) {
    const input = envelope.input as { attachmentId: string; positionMs: number };
    const row = this.store.db.prepare("SELECT id, clock_json FROM capture_sessions WHERE attachment_id = ?").get(input.attachmentId) as { id: string; clock_json: string } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "capture attachment is not in this profile");
    const metadata = JSON.parse(row.clock_json) as Record<string, unknown>;
    metadata.lastPlaybackMs = input.positionMs;
    this.store.commit({
      mutations: [{ sql: "UPDATE capture_sessions SET clock_json = ? WHERE id = ?", params: [JSON.stringify(metadata), row.id] }],
      events: [{ type: "capture.progress", payload: { attachmentId: input.attachmentId, positionMs: input.positionMs } }],
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      result: { ok: true, positionMs: input.positionMs },
    });
    return { ok: true, positionMs: input.positionMs };
  }

  private setProgress(envelope: CommandEnvelope) {
    const input = envelope.input as { resourceId: string; resourceRevisionId: string; locator: unknown };
    if (!this.store.db.prepare("SELECT id FROM resource_revisions WHERE id = ? AND resource_id = ?").get(input.resourceRevisionId, input.resourceId)) throw new MangaError("NOT_FOUND", "resource revision does not belong to this resource");
    const now = new Date().toISOString();
    this.store.commit({
      mutations: [{
        sql: "INSERT INTO progress(resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(resource_id, resource_revision_id) DO UPDATE SET last_locator_json=excluded.last_locator_json, last_interaction_at=excluded.last_interaction_at",
        params: [input.resourceId, input.resourceRevisionId, JSON.stringify(input.locator), "[]", "reading", now],
      }],
      events: [{ type: "progress.updated", payload: { resourceId: input.resourceId } }],
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      result: { ok: true },
    });
    return { ok: true };
  }

  private async queryMetadata(envelope: CommandEnvelope,signal:AbortSignal) {
    const input = envelope.input as { title: string; mode: "single" | "fallback" | "multi"; workId: string };
    if(!this.store.db.prepare("SELECT id FROM works WHERE id=?").get(input.workId)) throw new MangaError("NOT_FOUND","work not found");
    const link = this.store.db.prepare("SELECT snapshot_json FROM work_links WHERE work_id = ?").get(input.workId) as { snapshot_json: string } | undefined;
    if (link) {
      const snapshot = JSON.parse(link.snapshot_json);
      const overridesRow = this.store.db.prepare("SELECT fields_json, locked_json, cleared_json FROM metadata_overrides WHERE work_id = ?").get(input.workId) as
        | { fields_json: string; locked_json: string; cleared_json: string }
        | undefined;
      return {
        review: "matched",
        candidates: [snapshot],
        confirmed: true,
        merged: mergeFields(
          [snapshot],
          overridesRow ? JSON.parse(overridesRow.fields_json) as Record<string, unknown> : {},
          overridesRow ? JSON.parse(overridesRow.locked_json) as string[] : [],
          overridesRow ? JSON.parse(overridesRow.cleared_json) as string[] : [],
          "single",
        ),
        providerErrors: {},
      };
    }
    const active = this.runtime.snapshot().modules;
    const selected = this.runtime.snapshot().lastValidProfile?.preferredProviders["manga.metadata.provider"] ?? [];
    const enabled = (name: string) => active[`m0.metadata.${name}`]?.state === "active" && (!selected.length || selected.includes(`m0.metadata.${name}`));
    const alpha = enabled("alpha") ? await queryProvider("alpha", input.title).catch((error) => error) : [];
    const beta = !enabled("beta") || input.mode === "single" || (input.mode === "fallback" && Array.isArray(alpha) && alpha.length > 0) ? [] : await queryProvider("beta", input.title).catch((error) => error);
    const snapshots = [...(Array.isArray(alpha) ? alpha : []), ...(Array.isArray(beta) ? beta : [])];
    const review = disambiguate(snapshots);
    if(signal.aborted) throw new MangaError("CANCELLED","metadata request cancelled");
    this.store.commit({mutations:snapshots.map(snapshot=>({sql:"INSERT INTO metadata_candidates(id,work_id,provider_id,payload_json) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json",params:[`${input.workId}:${snapshot.providerId}:${snapshot.externalId}`,input.workId,snapshot.providerId,JSON.stringify(snapshot)]})),events:[]});
    const overridesRow = this.store.db.prepare("SELECT fields_json, locked_json, cleared_json FROM metadata_overrides WHERE work_id = ?").get(input.workId) as
      | { fields_json: string; locked_json: string; cleared_json: string }
      | undefined;
    const merged = mergeFields(
      review.status === "matched" ? snapshots : [],
      overridesRow ? JSON.parse(overridesRow.fields_json) as Record<string, unknown> : {},
      overridesRow ? JSON.parse(overridesRow.locked_json) as string[] : [],
      overridesRow ? JSON.parse(overridesRow.cleared_json) as string[] : [],
      input.mode,
    );
    return {
      review: review.status,
      candidates: review.candidates,
      merged,
      providerErrors: {
        alpha: alpha instanceof Error ? alpha.message : undefined,
        beta: beta instanceof Error ? beta.message : undefined,
      },
    };
  }

  private overrideMetadata(envelope: CommandEnvelope) {
    const input = envelope.input as { workId: string; fields: Record<string, unknown>; locked: string[]; cleared: string[] };
    if(!this.store.db.prepare("SELECT id FROM works WHERE id=?").get(input.workId)) throw new MangaError("NOT_FOUND","work not found");
    this.store.commit({
      mutations: [{
        sql: "INSERT INTO metadata_overrides(work_id, fields_json, locked_json, cleared_json) VALUES (?, ?, ?, ?) ON CONFLICT(work_id) DO UPDATE SET fields_json=excluded.fields_json, locked_json=excluded.locked_json, cleared_json=excluded.cleared_json",
        params: [input.workId, JSON.stringify(input.fields), JSON.stringify(input.locked), JSON.stringify(input.cleared)],
      }],
      events: [{ type: "metadata.overridden", payload: { workId: input.workId } }],
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      result: { ok: true },
    });
    return { ok: true };
  }

  private async acquire(envelope: CommandEnvelope, signal: AbortSignal) {
    const input = envelope.input as {
      url: string;
      fileName: string;
      targetDir: string;
      quotaBytes?: number;
      previousEtag?: string;
      injectDiskFull?: boolean;
    };
    if (signal.aborted) throw new MangaError("CANCELLED", "cancelled");
    const fileName = safeFileName(input.fileName);
    const jobId = `job-${fingerprintOf(envelope.idempotencyKey).slice(0, 24)}`;
    const staging = path.join(this.profileDir, "jobs", jobId, `${fileName}.partial`);
    const target = path.join(input.targetDir, fileName);
    const previous = this.store.db.prepare("SELECT input_json FROM jobs WHERE id = ?").get(jobId) as { input_json: string } | undefined;
    if (previous && previous.input_json !== JSON.stringify(input)) throw new MangaError("VALIDATION_ERROR", "recovery input differs from recorded job");
    this.store.db.prepare("INSERT OR IGNORE INTO jobs(id, type, status, phase, epoch, idempotency_key, input_json, created_at, updated_at) VALUES (?, 'acquisition', 'running', 'transferring', ?, ?, ?, ?, ?)").run(jobId, envelope.moduleEpoch ?? 0, envelope.idempotencyKey, JSON.stringify(input), new Date().toISOString(), new Date().toISOString());
    let artifact = this.store.db.prepare("SELECT fingerprint, bytes, etag FROM artifacts WHERE id = ?").get(jobId) as { fingerprint: string; bytes: number; etag?: string } | undefined;
    if (!artifact) {
      const downloaded = await downloadToStaging({ id: jobId, version: 1, url: input.url, fileName, targetDir: input.targetDir, quotaBytes: input.quotaBytes ?? 1024 * 1024 }, staging, { previousEtag: input.previousEtag, signal });
      if (signal.aborted) throw new MangaError("CANCELLED", "cancelled before publication");
      artifact = { fingerprint: fingerprintFile(staging), bytes: downloaded.bytes, etag: downloaded.etag };
      this.store.db.prepare("INSERT INTO artifacts(id, job_id, entry_id, staging_path, target_path, bytes, fingerprint, etag, publish_state, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified', '{}')").run(jobId, jobId, fileName, staging, target, artifact.bytes, artifact.fingerprint, artifact.etag ?? null);
    }
    const digest = artifact.fingerprint;
    if (signal.aborted) throw new MangaError("CANCELLED", "cancelled before publication");
    if (fs.existsSync(target)) {
      // Only a previously persisted artifact can identify a published result after a crash.
      const owned = this.store.db.prepare("SELECT publish_state,payload_json FROM artifacts WHERE id = ?").get(jobId) as { publish_state: string; payload_json:string };
      const identity=JSON.parse(owned.payload_json).publicationIdentity;
      const actual=fs.statSync(target,{bigint:true});
      if (!["publishing", "published"].includes(owned.publish_state) || !identity || identity.dev !== String(actual.dev) || identity.ino !== String(actual.ino) || fingerprintFile(target) !== digest) throw new MangaError("PUBLISH_CONFLICT", "target is not this job's verified artifact");
    } else {
      if (!fs.existsSync(staging) || fingerprintFile(staging) !== digest) throw new MangaError("VALIDATION_ERROR", "verified staging file is missing or changed");
      this.store.db.prepare("UPDATE artifacts SET publish_state = 'publishing' WHERE id = ?").run(jobId);
      await publishAtomic(staging, target, input.injectDiskFull, publicationIdentity => {
        this.store.db.prepare("UPDATE artifacts SET payload_json=? WHERE id=?").run(JSON.stringify({publicationIdentity}),jobId);
      });
    }
    if (signal.aborted) throw new MangaError("CANCELLED", "file published; import awaits recovery");
    this.store.db.prepare("UPDATE artifacts SET publish_state = 'published' WHERE id = ?").run(jobId);
    const resourceId = createId("res");
    const revisionId = createId("rev");
    const receiptKey = `${envelope.idempotencyKey}:${fileName}:${digest}`;
    const existing = this.store.db.prepare("SELECT resource_id, resource_revision_id FROM import_receipts WHERE idempotency_key = ?").get(receiptKey) as { resource_id: string; resource_revision_id: string } | undefined;
    if (existing) return { resourceId: existing.resource_id, revisionId: existing.resource_revision_id, replay: true, fingerprint: digest };
    this.store.maybeCrash("before-import");
    const now = new Date().toISOString();
    this.store.commit({
      mutations: [
        { sql: "UPDATE jobs SET status = 'succeeded', phase = 'importing', updated_at = ? WHERE id = ?", params: [now, jobId] },
        {
          sql: "INSERT INTO resources(id, kind, title, aliases_json, created_at) VALUES (?, ?, ?, ?, ?)",
          params: [resourceId, "file", fileName, "[]", now],
        },
        {
          sql: "INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          params: [revisionId, resourceId, digest, "file-v1", JSON.stringify({ path: target }), now],
        },
        {
          sql: "INSERT INTO file_locations(id, resource_revision_id, relative_path, fingerprint, available) VALUES (?, ?, ?, ?, 1)",
          params: [createId("loc"), revisionId, target, digest],
        },
        {
          sql: "INSERT INTO import_receipts(idempotency_key, job_id, entry_id, fingerprint, resource_id, resource_revision_id, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          params: [receiptKey, jobId, fileName, digest, resourceId, revisionId, JSON.stringify({ ok: true }), now],
        },
      ],
      events: [{ type: "resource.imported", payload: { resourceId, revisionId } }],
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      result: { resourceId, revisionId, fingerprint: digest },
    });
    this.store.maybeCrash("after-import-commit");
    return { resourceId, revisionId, fingerprint: digest, etag: artifact.etag, bytes: artifact.bytes };
  }

  private getResource(envelope: CommandEnvelope) {
    const input = envelope.input as { resourceId: string };
    const row = this.store.db.prepare("SELECT r.id, r.title, r.kind, v.id AS revisionId, v.parser_version AS parserVersion, v.payload_json FROM resources r JOIN resource_revisions v ON v.resource_id = r.id WHERE r.id = ? ORDER BY v.created_at DESC LIMIT 1").get(input.resourceId) as
      | { id: string; title: string; kind: string; revisionId: string; parserVersion: string; payload_json: string }
      | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "resource missing");
    const payload = JSON.parse(row.payload_json) as { normalized?: string; parts?: Array<{ id: string; normalized: string; parserVersion: string }> };
    const parts = payload.parts ?? [{ id: "body", normalized: payload.normalized ?? "", parserVersion: row.parserVersion }];
    const progress = this.store.db.prepare("SELECT last_locator_json FROM progress WHERE resource_id = ? AND resource_revision_id = ?").get(row.id, row.revisionId) as { last_locator_json?: string } | undefined;
    return {
      id: row.id,
      title: row.title,
      kind: row.kind,
      revisionId: row.revisionId,
      parserVersion: row.parserVersion,
      parts,
      length: parts.reduce((sum, part) => sum + part.normalized.length, 0),
      previewOnly: false,
      progress: progress?.last_locator_json ? JSON.parse(progress.last_locator_json) : undefined,
    };
  }

  private contextSnapshot(envelope: CommandEnvelope) {
    const input = envelope.input as { resourceId: string; resourceRevisionId: string; partId?: string; start?: number; end?: number };
    const row = this.store.db.prepare("SELECT payload_json FROM resource_revisions WHERE id = ? AND resource_id = ?").get(input.resourceRevisionId, input.resourceId) as {payload_json: string} | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "resource revision does not belong to this resource");
    const payload = JSON.parse(row.payload_json) as {normalized?: string; parts?: Array<{id: string; normalized: string}>};
    const parts = payload.parts ?? [{id:"body",normalized:payload.normalized ?? ""}];
    const part = input.partId ? parts.find(item => item.id === input.partId) : parts[0];
    if (!part) throw new MangaError("NOT_FOUND", "resource part missing");
    const start = input.start ?? 0;
    const requestedEnd = input.end ?? start + 240;
    if (start > requestedEnd || requestedEnd - start > 4096) throw new MangaError("VALIDATION_ERROR", "context range is invalid or exceeds the lightweight context budget");
    let count=0,quote="";
    for(const char of part.normalized) {
      if(count>=requestedEnd) break;
      if(count>=start) quote+=char;
      count++;
    }
    if(count < start || (input.end !== undefined && count < input.end)) throw new MangaError("VALIDATION_ERROR","context range is past the end");
    const end=Math.min(requestedEnd,count);
    return {
      resourceId: input.resourceId,
      resourceRevisionId: input.resourceRevisionId,
      partId: part.id,
      range: { start, end },
      quote,
      bytes: Buffer.byteLength(JSON.stringify({ quote, start, end })),
    };
  }

  private exportPackage(envelope: CommandEnvelope) {
    const input = envelope.input as { targetDir: string };
    const manifest = exportLibraryPackage(this.store, input.targetDir);
    return { format: manifest.format, attachments: manifest.attachments.length, objects: manifest.objects.length, works: manifest.works.length };
  }

  private importPackage(envelope: CommandEnvelope) {
    const input = envelope.input as { sourceDir: string };
    if ((this.store.counts().resources ?? 0) > 0 || (this.store.counts().content_objects ?? 0) > 0) {
      throw new MangaError("PUBLISH_CONFLICT", "import requires an empty profile");
    }
    const manifest = importLibraryPackage(this.store, input.sourceDir, {key:envelope.idempotencyKey,commandId:envelope.commandId});
    this.store.replayUnpublished();
    return { format: manifest.format, attachments: manifest.attachments.length, objects: manifest.objects.length, works: manifest.works.length };
  }

  private confirmMetadata(envelope: CommandEnvelope) {
    const input = envelope.input as { workId: string; providerId: string; externalId: string };
    if (!this.store.db.prepare("SELECT id FROM works WHERE id=?").get(input.workId)) throw new MangaError("NOT_FOUND", "work not found");
    const candidates = (this.store.db.prepare("SELECT payload_json FROM metadata_candidates WHERE work_id = ?").all(input.workId) as Array<{ payload_json: string }>).map((item) => JSON.parse(item.payload_json));
    const snapshot = confirmCandidate(candidates, input.providerId, input.externalId);
    const now = new Date().toISOString();
    this.store.commit({
      mutations: [
        { sql: "DELETE FROM work_links WHERE work_id = ? AND provider_id = ?", params: [input.workId, input.providerId] },
        {
          sql: "INSERT INTO work_links(work_id, provider_id, external_id, snapshot_json, confirmed_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(work_id, provider_id, external_id) DO UPDATE SET snapshot_json=excluded.snapshot_json, confirmed_at=excluded.confirmed_at",
          params: [input.workId, input.providerId, input.externalId, JSON.stringify(snapshot), now],
        },
        {
          sql: "INSERT INTO metadata_snapshots(work_id, provider_id, external_id, snapshot_json) VALUES (?, ?, ?, ?) ON CONFLICT(work_id, provider_id) DO UPDATE SET external_id=excluded.external_id, snapshot_json=excluded.snapshot_json",
          params: [input.workId, input.providerId, input.externalId, JSON.stringify(snapshot)],
        },
      ],
      events: [{ type: "metadata.confirmed", payload: { workId: input.workId, providerId: input.providerId, externalId: input.externalId } }],
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      result: { ok: true, snapshot },
    });
    return { ok: true, snapshot };
  }

  private splitNote(envelope: CommandEnvelope) {
    const input = envelope.input as { objectId: string; expectedRevision: number; blockId: string; offset: number };
    return this.mutateNote(envelope, input.objectId, input.expectedRevision, (payload) => {
      const rightId = splitBlock(payload, input.blockId, input.offset);
      return { rightId };
    });
  }

  private mergeNote(envelope: CommandEnvelope) {
    const input = envelope.input as { objectId: string; expectedRevision: number; blockId: string };
    return this.mutateNote(envelope, input.objectId, input.expectedRevision, (payload) => {
      mergeBlockWithNext(payload, input.blockId);
      return { merged: input.blockId };
    });
  }

  private embedNote(envelope: CommandEnvelope) {
    const input = envelope.input as { objectId: string; expectedRevision: number; fromBlockId: string; targetId: string; targetKind: "object" | "anchor" };
    const objects = this.store.db.prepare("SELECT id, payload_json FROM content_objects").all() as Array<{ id: string; payload_json: string }>;
    const graph: Record<string, string[]> = {};
    for (const object of objects) {
      const blocks = (JSON.parse(object.payload_json) as { blocks?: Array<{ targetId?: string; targetKind?: string }> }).blocks ?? [];
      graph[object.id] = blocks.filter((block) => block.targetKind === "object" && block.targetId).map((block) => block.targetId!);
    }
    const refs = this.store.db.prepare("SELECT from_object_id, to_id FROM refs WHERE to_kind = 'object'").all() as Array<{ from_object_id: string; to_id: string }>;
    for (const ref of refs) {
      graph[ref.from_object_id] = [...(graph[ref.from_object_id] ?? []), ref.to_id];
    }
    const status = embedStatus(graph, input.objectId, input.targetId);
    const extraMutations = status === "ok" && input.targetKind === "object"
      ? [{ sql: "INSERT INTO refs(id, from_object_id, from_block_id, to_kind, to_id, mode, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)", params: [createId("ref"), input.objectId, input.fromBlockId, "object", input.targetId, "live", new Date().toISOString()] }]
      : [];
    return this.mutateNote(envelope, input.objectId, input.expectedRevision, (payload) => {
      payload.blocks.push({
        id: `embed-${payload.revision}`,
        type: "embed",
        text: status === "ok" ? `embed:${input.targetId}` : status,
        targetId: input.targetId,
        targetKind: input.targetKind,
      });
      return { embedStatus: status };
    }, extraMutations);
  }

  private mutateNote(envelope: CommandEnvelope, objectId: string, expectedRevision: number, mutate: (document: { id: string; revision: number; title: string; blocks: Array<{ id: string; type: "paragraph" | "quote" | "embed"; text: string; targetId?: string; targetKind?: "object" | "anchor" }> }) => unknown, extraMutations: Array<{ sql: string; params?: Array<string | number | bigint | null> }> = []) {
    const row = this.store.db.prepare("SELECT revision, title, payload_json FROM content_objects WHERE id = ?").get(objectId) as
      | { revision: number; title: string; payload_json: string }
      | undefined;
    if (!row) throw new Error("note missing");
    if (row.revision !== expectedRevision) throw new MangaError("REVISION_CONFLICT", "note revision changed", { details: { expected: expectedRevision, actual: row.revision } });
    const payload = JSON.parse(row.payload_json) as { blocks: Array<{ id: string; type: "paragraph" | "quote" | "embed"; text: string; targetId?: string; targetKind?: "object" | "anchor" }> };
    const document = { id: objectId, revision: row.revision, title: row.title, blocks: payload.blocks };
    const extra = mutate(document);
    document.revision += 1;
    const encoded = JSON.stringify({ blocks: document.blocks });
    const now = new Date().toISOString();
    const text = document.blocks.map((block) => block.text).join("\n");
    const indexed = this.store.db.prepare("SELECT resource_id FROM text_fragments WHERE object_id = ? LIMIT 1").get(objectId) as {resource_id?: string} | undefined;
    this.store.commit({
      mutations: [
        { sql: "UPDATE content_objects SET revision = ?, payload_json = ?, preview_json = ?, updated_at = ? WHERE id = ?", params: [document.revision, encoded, JSON.stringify({ text: text.slice(0, 80) }), now, objectId] },
        { sql: "INSERT INTO object_revisions(object_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?)", params: [objectId, document.revision, encoded, now] },
        ...extraMutations,
        { sql: "DELETE FROM search_idx WHERE fragment_id IN (SELECT id FROM text_fragments WHERE object_id = ?)", params: [objectId] },
        { sql: "DELETE FROM text_fragments WHERE object_id = ?", params: [objectId] },
        ...this.store.indexFragment({id:createId("frag"),objectId,resourceId:indexed?.resource_id,kind:"note",text}),
      ],
      events: [{ type: "note.updated", payload: { objectId, revision: document.revision } }],
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      result: { objectId, revision: document.revision, ...((extra as object) ?? {}) },
    });
    return { objectId, revision: document.revision, blocks: document.blocks, ...(extra as object) };
  }
}

function fingerprintOf(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function writeAttachmentIdempotent(file: string, bytes: Buffer): void {
  try {
    const fd = fs.openSync(file, "wx");
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = fs.readFileSync(file);
    if (!existing.equals(bytes)) throw new MangaError("PUBLISH_CONFLICT", "capture attachment exists with different bytes");
  }
}

export { createEditor, embedStatus, mapCaptureToSources, runAsrFixture, associateAsrResult, captureOffsetFromSamples, createTextLocator, applyEdit };
