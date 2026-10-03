import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  commandInputJsonSchema,
  MangaError,
  NOTE_TAG_MAX,
  type NoteDocument,
  ProfileConfigSchema,
  LOCATION_PARTITIONS,
  createId,
  validateCommandInput,
  type Actor,
  type CommandEnvelope,
  type CommandResult,
  type LocationLayout,
  type ScopeGrant,
} from "@manga/contracts";
import { MangaRuntime } from "@manga/kernel";
import { DrizzleStore, acquireHostLock, releaseHostLock, type Mutation } from "@manga/storage-drizzle";
import { defineModule, type MangaModule } from "@manga/plugin-sdk";
import { completeText, streamText, transcribeAudio, normalizeBaseUrl, rejectCredentialUrl, syntheticWav, joinApiPath, type AiRuntimeId, type ChatMessage, type ToolDefinition } from "@manga/model-protocol";
import { decodeTextBuffer, normalizeText, sliceCodePoints } from "./domain/text.ts";
import { parseDocument, type ParsedAsset, type ParsedDocument } from "./domain/formats.ts";
import {
  commitNoteOp,
  filterUnread,
  listBookmarks,
  listNotes,
  noteHistory,
  openNoteSourceDetail,
  persistParsedDocument,
  readAsset,
  readDocument,
  readNote,
  readOriginal,
  readShell,
  readSlice,
  removeBookmark,
  resolveAnchor,
  restoreNoteRevision,
  selectionQuote,
  setBookmark,
  setNoteTags,
  setProgress,
  sourceCard,
  writeShell,
} from "./reading-service.ts";
import { comparablePath } from "./domain/file-ownership.ts";
import { exportLibraryPackage, importLibraryPackage, importLibraryPackageResolved, previewLibraryPackage, recoverOrRollback } from "./domain/library-package.ts";
import { GrantRegistry } from "./grants.ts";
import { type CredentialVault, UnavailableVault } from "./credentials.ts";
import { assertSafeMigrationTarget, copyOwnedFile, directoryStats, fingerprintTree, listCopyFiles, persistPointer, persistPointerAt, pathsOverlap, scanDirectoryBatched, type LaunchRequest, resolveLaunchLayout, writeRelocationMarker } from "./locations.ts";
import { startParseWorker, type ParseClient } from "./parse-client.ts";

const OWNER_COMMANDS = [
  "workspace.get", "workspace.sessions", "session.open", "library.importText", "library.importEpub", "library.importDocument", "library.getResource", "library.read", "library.readOriginal", "library.readSlice", "library.contextSnapshot", "library.search", "library.find", "library.list",
  "library.exportPackage", "library.importPackage", "package.preview", "package.importResolved", "library.transcribeAudio", "library.indexExternal", "library.rebuildIndex", "library.repairSource", "progress.set",
  "notes.create", "notes.update", "notes.undo", "notes.get", "notes.list", "notes.history", "notes.restore", "notes.tags", "notes.split", "notes.merge", "notes.move", "notes.copy", "notes.replace", "notes.insert", "notes.remove", "notes.setType", "notes.rename", "notes.asset", "notes.openSource",
  "reader.resolveAnchor", "reader.ui.present", "source.card",
  "reading.bookmarks", "reading.setBookmark", "reading.removeBookmark",
  "inventory.overview", "inventory.scan", "inventory.cancelScan", "inventory.reveal", "inventory.repair", "settings.get", "settings.skipAi",
  "settings.proposeLocations", "settings.applyLocations", "settings.recoverJobs", "settings.setRuntime", "settings.setLayout", "settings.getShell", "settings.setShell",
  "connections.list", "connections.upsert", "connections.test", "connections.delete",
  "agent.createSession", "agent.send", "agent.cancel", "agent.retry", "agent.getRun",
];
const AGENT_COMMANDS = ["library.find", "library.list", "library.getResource", "library.read", "library.contextSnapshot", "source.card", "notes.create", "notes.update", "notes.get", "notes.list", "notes.undo", "inventory.overview"];
/** Partitions whose files are only located by path, so a move may leave them behind as an indexed root. `data` and `attachments` are referenced by identity and must travel. */
const INDEXABLE_PARTITIONS = new Set<string>(["resources", "downloads", "backups", "exports", "cache"]);

export type ProductAppOptions = LaunchRequest & {
  hostId?: string;
  crashAt?: string;
  vault?: CredentialVault;
  useParseWorker?: boolean;
  parseWorkerPath?: string;
  nativeBinding?: string;
};

export class MangaProductApp {
  readonly runtime: MangaRuntime;
  readonly store: DrizzleStore;
  readonly grants: GrantRegistry;
  readonly layout: LocationLayout;
  readonly uiFacets = new Set<string>();
  private readonly lock;
  private readonly vault: CredentialVault;
  private readonly pending = new Map<string, { actorId: string; actorKind: string; sessionId: string | null; runId: string | null; work: Promise<CommandResult> }>();
  private parseWorker: ParseClient | undefined;
  private readonly parseWorkerPath: string | undefined;
  private readonly wantParseWorker: boolean;
  private parseGeneration = 0;
  private scanAbort: AbortController | undefined;
  private readonly runAbort = new Map<string, AbortController>();
  readonly pathResolved = new Map<string, string>();
  private readonly secrets = new Map<string, string>();
  private sealed = false;
  private closed = false;

  constructor(options: ProductAppOptions) {
    this.layout = resolveLaunchLayout(options);
    if (!this.layout.writable) {
      throw new MangaError("LOCATION_UNAVAILABLE", "profile data directory is not writable", {
        details: { recovery: this.layout.recovery },
      });
    }
    for (const dir of Object.values(this.layout.partitions)) fs.mkdirSync(dir, { recursive: true });
    persistPointer(this.layout);
    this.vault = options.vault ?? new UnavailableVault();
    const hostId = options.hostId ?? "product";
    this.lock = acquireHostLock(this.layout.partitions.data, hostId);
    try {
      this.store = new DrizzleStore({
        profileDir: this.layout.partitions.data,
        hostId,
        crashAt: options.crashAt,
        attachmentsDir: this.layout.partitions.attachments,
        nativeBinding: options.nativeBinding,
      });
    } catch (error) {
      releaseHostLock(this.layout.partitions.data, hostId);
      throw error;
    }
    this.grants = new GrantRegistry(this.store);
    this.store.setMeta("layoutConfig", JSON.stringify({
      pointerPath: this.layout.pointerPath,
      partitions: this.layout.overrides,
      profileRoot: this.layout.defaultRoot,
    }));
    this.runtime = new MangaRuntime([
      this.libraryModule(),
      this.notesModule(),
      this.settingsModule(),
      this.inventoryModule(),
      this.agentModule(),
    ], {
      hostFacets: ["service", "ui", "worker"],
      trustedScope: (actor, handle) => this.grants.trustedScope(actor, handle),
      isCommandAdmitted: (_commandId, envelope) => {
        const grant = this.grants.get(envelope.scopeHandle);
        if (!grant || grant.revoked) return false;
        return grant.allowedCommands.includes(envelope.commandId);
      },
    });
    this.parseWorkerPath = options.parseWorkerPath;
    this.wantParseWorker = options.useParseWorker === true;
  }

  async start(): Promise<void> {
    const saved = this.store.getMeta("lastValidProfile");
    const profile = saved ? ProfileConfigSchema.parse(JSON.parse(saved)) : {
      profileId: "m1a",
      revision: 1,
      enabledFeatures: ["library", "notes", "settings", "inventory", "agent"],
      disabledFeatures: [],
      preferredProviders: {},
    };
    await this.runtime.applyProfile(profile);
    this.store.setMeta("lastValidProfile", JSON.stringify(this.runtime.snapshot().lastValidProfile ?? profile));
    // No run loop survives a process boundary: anything still "running" in the database is stale.
    this.interruptRuns("host restarted before the run finished");
    this.store.replayUnpublished();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.interruptRuns("host closed while the run was in progress");
    this.parseWorker?.kill();
    this.store.close();
    releaseHostLock(this.layout.partitions.data, this.lock.hostId);
  }

  /** Abort live run loops and persist `interrupted` for every unfinished run so a reopen never shows a phantom `running`. */
  private interruptRuns(reason: string): number {
    for (const controller of this.runAbort.values()) controller.abort();
    return this.store.sqlite.prepare("UPDATE agent_runs SET status = 'interrupted', error_json = ?, updated_at = ? WHERE status IN ('queued','running','waiting_input')").run(
      JSON.stringify({ code: "INTERRUPTED", message: reason, retryable: true, details: {} }),
      new Date().toISOString(),
    ).changes;
  }

  issueOwnerGrant(actor: Actor): ScopeGrant {
    const snapshot = this.runtime.snapshot();
    return this.grants.issue({
      actor,
      allowedCommands: OWNER_COMMANDS,
      access: "owner",
      readResourceIds: [],
      writeResourceIds: [],
      writeObjectIds: [],
      allowCreateObjects: true,
      pathHandles: [],
      moduleEpoch: 1,
      bindingEpoch: 1,
      registryGeneration: snapshot.registryGeneration,
    });
  }

  issueAgentGrant(owner: ScopeGrant, actor: Actor, input: { sessionId?: string; runId?: string; readResourceIds: string[] }): ScopeGrant {
    return this.grants.issue({
      actor,
      sessionId: input.sessionId,
      runId: input.runId,
      allowedCommands: AGENT_COMMANDS,
      access: "enumerated",
      readResourceIds: input.readResourceIds,
      writeResourceIds: [],
      writeObjectIds: [],
      allowCreateObjects: true,
      pathHandles: [...owner.pathHandles],
      moduleEpoch: owner.moduleEpoch,
      bindingEpoch: owner.bindingEpoch,
      registryGeneration: owner.registryGeneration,
    });
  }

  registerPath(purpose: ScopeGrant["pathHandles"] extends string[] ? "file" | "directory" | "export" | "import" | "profile" : never, resolvedPath: string): string {
    const id = createId("path");
    this.store.sqlite.prepare("INSERT INTO path_handles(id, purpose, resolved_path, created_at) VALUES (?,?,?,?)").run(id, purpose, resolvedPath, new Date().toISOString());
    this.pathResolved.set(id, resolvedPath);
    return id;
  }

  stashSecret(plain: string): string {
    if (plain.length < 1 || plain.length > 4096) throw new MangaError("VALIDATION_ERROR", "credential payload is invalid");
    const id = createId("sec");
    this.secrets.set(id, plain);
    return id;
  }

  resolvePath(handle: string): string {
    const stored = this.store.sqlite.prepare("SELECT resolved_path FROM path_handles WHERE id = ?").get(handle) as { resolved_path: string } | undefined;
    if (!stored) throw new MangaError("FORBIDDEN", "path handle is not authorized");
    return stored.resolved_path;
  }

  private assertWritable(): void {
    if (this.sealed) throw new MangaError("RESTART_REQUIRED", "profile location changed; restart to open the authoritative library");
  }

  private grantFingerprint(grant: ScopeGrant): string {
    return createHash("sha256").update(JSON.stringify({
      access: grant.access,
      allowedCommands: grant.allowedCommands,
      readResourceIds: grant.readResourceIds,
      writeResourceIds: grant.writeResourceIds,
      writeObjectIds: grant.writeObjectIds,
      allowCreateObjects: grant.allowCreateObjects,
    })).digest("hex");
  }

  private assertIdempotentReplay(existing: CommandResult, envelope: CommandEnvelope, grant: ScopeGrant, request: {
    actor_kind: string | null;
    actor_id: string | null;
    session_id: string | null;
    run_id: string | null;
    grant_fingerprint: string | null;
  }): void {
    if (request.actor_kind !== envelope.actor.kind || request.actor_id !== envelope.actor.id) {
      throw new MangaError("FORBIDDEN", "idempotency key belongs to a different actor");
    }
    if (request.session_id !== (grant.sessionId ?? null) || request.run_id !== (grant.runId ?? null)) {
      throw new MangaError("FORBIDDEN", "idempotency key belongs to a different task");
    }
    this.grants.assertCommand(grant, envelope.commandId);
    if (!this.runtime.gateway.has(envelope.commandId)) {
      throw new MangaError("CAPABILITY_UNAVAILABLE", `command ${envelope.commandId} is not admitted`);
    }
    const value = existing.value as { objectId?: string; resourceId?: string } | undefined;
    if (grant.access === "enumerated") {
      if (value?.objectId && !this.grants.canWriteObject(grant, value.objectId)) {
        throw new MangaError("SCOPE_DENIED", "replayed object is outside the current authorization");
      }
      if (value?.resourceId && !this.grants.canRead(grant, value.resourceId)) {
        throw new MangaError("SCOPE_DENIED", "replayed resource is outside the current authorization");
      }
    }
    if (!request.grant_fingerprint) throw new MangaError("FORBIDDEN", "legacy receipt has no verifiable authorization binding");
    if (request.grant_fingerprint !== this.grantFingerprint(grant)) {
      // A successful creation extends the same run's writable object set. Only an object receipt
      // can survive this change, after checking that the object is still authorized above.
      const authorizedObjectReceipt = envelope.commandId.startsWith("notes.") && value?.objectId && this.grants.canWriteObject(grant, value.objectId);
      if (!authorizedObjectReceipt) throw new MangaError("SCOPE_DENIED", "authorization changed since the original result");
    }
  }

  async call(actor: Actor, untrusted: unknown, grantHandle: string, requestId?: string): Promise<CommandResult> {
    try {
      const envelope = this.runtime.gateway.sealFromTrusted({ untrusted, actor, scopeHandle: grantHandle, requestId });
      envelope.input = validateCommandInput(envelope.commandId, envelope.input);
      const grant = this.grants.get(grantHandle);
      if (!grant) throw new MangaError("FORBIDDEN", "unknown authorization handle");
      this.grants.assertCommand(grant, envelope.commandId);
      if (grant.actor.kind !== actor.kind || grant.actor.id !== actor.id) throw new MangaError("FORBIDDEN", "actor does not match grant");
      const inputHash = createHash("sha256").update(JSON.stringify(envelope.input)).digest("hex");
      const request = this.store.sqlite.prepare("SELECT command_id, input_hash, actor_kind, actor_id, session_id, run_id, grant_fingerprint FROM command_requests WHERE idempotency_key = ?").get(envelope.idempotencyKey) as {
        command_id: string;
        input_hash: string;
        actor_kind: string | null;
        actor_id: string | null;
        session_id: string | null;
        run_id: string | null;
        grant_fingerprint: string | null;
      } | undefined;
      if (request && (request.command_id !== envelope.commandId || request.input_hash !== inputHash)) {
        throw new MangaError("VALIDATION_ERROR", "idempotency key reused with a different command or input");
      }
      if (request && (request.actor_kind !== actor.kind || request.actor_id !== actor.id)) {
        throw new MangaError("FORBIDDEN", "idempotency key belongs to a different actor");
      }
      if (request && (request.session_id !== (grant.sessionId ?? null) || request.run_id !== (grant.runId ?? null))) {
        throw new MangaError("FORBIDDEN", "idempotency key belongs to a different task");
      }
      const existing = this.store.loadIdempotent(envelope.idempotencyKey);
      if (existing && !request) throw new MangaError("FORBIDDEN", "legacy receipt has no trusted request binding");
      this.store.sqlite.prepare("INSERT OR IGNORE INTO command_requests(idempotency_key,command_id,input_hash,actor_kind,actor_id,grant_handle,session_id,run_id,registry_generation,grant_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)").run(
        envelope.idempotencyKey,
        envelope.commandId,
        inputHash,
        actor.kind,
        actor.id,
        grant.handle,
        grant.sessionId ?? null,
        grant.runId ?? null,
        grant.registryGeneration,
        this.grantFingerprint(grant),
      );
      if (existing) {
        const stored = this.store.sqlite.prepare("SELECT actor_kind, actor_id, session_id, run_id, grant_fingerprint FROM command_requests WHERE idempotency_key = ?").get(envelope.idempotencyKey) as {
          actor_kind: string | null;
          actor_id: string | null;
          session_id: string | null;
          run_id: string | null;
          grant_fingerprint: string | null;
        };
        this.assertIdempotentReplay(existing, envelope, grant, stored);
        return { ...existing, idempotentReplay: true };
      }
      const pending = this.pending.get(envelope.idempotencyKey);
      if (pending) {
        if (pending.actorKind !== actor.kind || pending.actorId !== actor.id) {
          throw new MangaError("FORBIDDEN", "idempotency key is already in flight for another actor");
        }
        if ((pending.sessionId || pending.runId) && (pending.sessionId !== (grant.sessionId ?? null) || pending.runId !== (grant.runId ?? null))) {
          throw new MangaError("FORBIDDEN", "idempotency key is already in flight for another task");
        }
        const result = await pending.work;
        const currentGrant = this.grants.get(grantHandle);
        if (!currentGrant || !request) throw new MangaError("FORBIDDEN", "authorization is no longer available");
        this.assertIdempotentReplay(result, envelope, currentGrant, request);
        return result;
      }
      const work = this.runtime.gateway.execute(envelope);
      this.pending.set(envelope.idempotencyKey, {
        actorId: actor.id,
        actorKind: actor.kind,
        sessionId: grant.sessionId ?? null,
        runId: grant.runId ?? null,
        work,
      });
      try {
        return await work;
      } finally {
        this.pending.delete(envelope.idempotencyKey);
      }
    } catch (error) {
      return {
        status: "error",
        error: error instanceof MangaError ? error.toJSON() : { code: "VALIDATION_ERROR", message: error instanceof Error ? error.message : String(error), retryable: false, details: {} },
      };
    }
  }

  private libraryModule(): MangaModule {
    return defineModule({
      manifest: {
        moduleId: "manga.library",
        version: "1.0.0",
        displayName: "资料库",
        featureId: "library",
        contributes: [{ capabilityId: "manga.library", version: "1.0.0" }],
        needs: [],
        facets: ["service", "ui", "worker"],
        conflictsWith: [],
        ownerModuleIds: [],
      },
      activate: (ctx) => {
        if (this.wantParseWorker) {
          this.parseWorker ??= startParseWorker(this.parseWorkerPath);
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
        if ((ctx.hostFacets ?? []).includes("ui")) {
          this.uiFacets.add("library");
          ctx.register({
            kind: "subscription",
            id: `library-ui-${ctx.epoch}`,
            dispose: () => {
              this.uiFacets.delete("library");
            },
          });
        }
        this.runtime.registerCommand("manga.library", "workspace.get", () => this.workspace());
        this.runtime.registerCommand("manga.library", "workspace.sessions", (envelope) => {
          const input = envelope.input as { mode?: "enthusiast" | "creator" };
          return this.sessionList(input.mode);
        });
        this.runtime.registerCommand("manga.library", "library.importText", (envelope, signal) => {
          this.assertWritable();
          return this.importText(envelope, signal);
        });
        this.runtime.registerCommand("manga.library", "library.importEpub", (envelope, signal) => {
          this.assertWritable();
          const input = envelope.input as { title: string; bytes: number[] };
          return this.importDocument({ ...envelope, input: { title: input.title, bytes: input.bytes, format: "epub" } }, signal);
        });
        this.runtime.registerCommand("manga.library", "library.importDocument", (envelope, signal) => {
          this.assertWritable();
          return this.importDocument(envelope, signal);
        });
        this.runtime.registerCommand("manga.library", "library.read", (envelope) => this.readResource(envelope));
        this.runtime.registerCommand("manga.library", "library.readOriginal", (envelope) => this.readOriginal(envelope));
        this.runtime.registerCommand("manga.library", "library.readSlice", (envelope) => this.readResourceSlice(envelope));
        this.runtime.registerCommand("manga.library", "library.rebuildIndex", (envelope) => {
          this.assertWritable();
          return this.store.rebuildSearchIndex();
        });
        this.runtime.registerCommand("manga.library", "library.repairSource", (envelope, signal) => this.repairSource(envelope, signal));
        this.runtime.registerCommand("manga.library", "progress.set", (envelope) => {
          this.assertWritable();
          return setProgress(this.store, envelope, this.grantOf(envelope), this.grants);
        });
        this.runtime.registerCommand("manga.library", "reader.resolveAnchor", (envelope) => {
          const grant = this.grantOf(envelope);
          const input = envelope.input as { resourceRevisionId: string; locator: Parameters<typeof resolveAnchor>[2] };
          const resolved = resolveAnchor(this.store, input.resourceRevisionId, input.locator);
          const resourceId = resolved.resourceId;
          if (typeof resourceId === "string" && !this.grants.canRead(grant, resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
          return resolved;
        });
        this.runtime.registerCommand("manga.library", "reader.ui.present", () => ({ available: this.uiFacets.has("library"), facet: "ui" }));
        this.runtime.registerCommand("manga.library", "library.getResource", (envelope) => this.getResource(envelope));
        this.runtime.registerCommand("manga.library", "library.contextSnapshot", (envelope) => this.contextSnapshot(envelope));
        this.runtime.registerCommand("manga.library", "library.search", (envelope) => this.search(envelope));
        this.runtime.registerCommand("manga.library", "library.find", (envelope) => this.search(envelope));
        this.runtime.registerCommand("manga.library", "library.list", (envelope) => this.libraryList(envelope));
        this.runtime.registerCommand("manga.library", "library.exportPackage", (envelope) => {
          const input = envelope.input as { pathHandle?: string; targetDir?: string };
          if (!input.pathHandle || input.targetDir) throw new MangaError("FORBIDDEN", "export requires a host path handle");
          return exportLibraryPackage(this.store, this.resolvePath(input.pathHandle));
        });
        this.runtime.registerCommand("manga.library", "library.importPackage", (envelope) => {
          this.assertWritable();
          const input = envelope.input as { pathHandle?: string; sourceDir?: string };
          if (!input.pathHandle || input.sourceDir) throw new MangaError("FORBIDDEN", "import requires a host path handle");
          return importLibraryPackage(this.store, this.resolvePath(input.pathHandle), { crashAt: this.store.crashAt, receipt: { key: envelope.idempotencyKey, commandId: envelope.commandId } });
        });
        this.runtime.registerCommand("manga.library", "package.preview", (envelope) => {
          const input = envelope.input as { pathHandle?: string; sourceDir?: string };
          if (!input.pathHandle || input.sourceDir) throw new MangaError("FORBIDDEN", "preview requires a host path handle");
          return previewLibraryPackage(this.store, this.resolvePath(input.pathHandle));
        });
        this.runtime.registerCommand("manga.library", "package.importResolved", (envelope) => {
          this.assertWritable();
          const input = envelope.input as { pathHandle?: string; sourceDir?: string; strategy?: "skip" | "replace" | "duplicate"; decisions?: Array<{ kind: string; id: string; action: "skip" | "replace" | "duplicate" }> };
          if (!input.pathHandle || input.sourceDir) throw new MangaError("FORBIDDEN", "import requires a host path handle");
          return importLibraryPackageResolved(this.store, this.resolvePath(input.pathHandle), {
            crashAt: this.store.crashAt,
            receipt: { key: envelope.idempotencyKey, commandId: envelope.commandId },
            strategy: input.strategy ?? "duplicate",
            decisions: (input.decisions ?? []) as never,
          });
        });
        this.runtime.registerCommand("manga.library", "source.card", (envelope) => {
          const input = envelope.input as { resourceId: string };
          if (!this.grants.canRead(this.grantOf(envelope), input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
          return sourceCard(this.store, envelope.input as Parameters<typeof sourceCard>[1]);
        });
        this.runtime.registerCommand("manga.library", "reading.bookmarks", (envelope) => {
          const input = envelope.input as { resourceId?: string };
          if (input.resourceId && !this.grants.canRead(this.grantOf(envelope), input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
          return listBookmarks(this.store, input.resourceId);
        });
        this.runtime.registerCommand("manga.library", "reading.setBookmark", (envelope) => {
          this.assertWritable();
          const input = envelope.input as { resourceId: string; bookmarkId?: string; label?: string };
          if (!this.grants.canRead(this.grantOf(envelope), input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
          const detail = envelope.input as Parameters<typeof setBookmark>[1];
          return setBookmark(this.store, { ...detail, label: input.label ?? "", idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId });
        });
        this.runtime.registerCommand("manga.library", "reading.removeBookmark", (envelope) => {
          this.assertWritable();
          return removeBookmark(this.store, { bookmarkId: (envelope.input as { bookmarkId: string }).bookmarkId, idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId });
        });
        this.runtime.registerCommand("manga.library", "library.transcribeAudio", (envelope, signal) => this.transcribeAuthorizedFile(envelope, signal));
        this.runtime.registerCommand("manga.library", "library.indexExternal", (envelope) => this.indexExternalRoot(envelope));
      },
      deactivate: () => {
        this.parseGeneration += 1;
      },
    });
  }

  private notesModule(): MangaModule {
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
          this.uiFacets.add("notes");
          ctx.register({ kind: "subscription", id: `notes-ui-${ctx.epoch}`, dispose: () => {
            this.uiFacets.delete("notes");
          } });
        }
        this.runtime.registerCommand("manga.notes", "notes.create", (envelope) => {
          this.assertWritable();
          return this.createNote(envelope);
        });
        this.runtime.registerCommand("manga.notes", "notes.update", (envelope) => {
          this.assertWritable();
          return this.updateNote(envelope);
        });
        this.runtime.registerCommand("manga.notes", "notes.undo", (envelope) => {
          this.assertWritable();
          return this.undoNote(envelope);
        });
        this.runtime.registerCommand("manga.notes", "notes.get", (envelope) => {
          const input = envelope.input as { objectId: string };
          this.assertNoteAccess(envelope, input.objectId, false);
          return readNote(this.store, input.objectId);
        });
        this.runtime.registerCommand("manga.notes", "notes.split", (envelope) => this.noteOp(envelope, "split"));
        this.runtime.registerCommand("manga.notes", "notes.merge", (envelope) => this.noteOp(envelope, "merge"));
        this.runtime.registerCommand("manga.notes", "notes.move", (envelope) => this.noteOp(envelope, "move"));
        this.runtime.registerCommand("manga.notes", "notes.copy", (envelope) => this.noteOp(envelope, "copy"));
        this.runtime.registerCommand("manga.notes", "notes.replace", (envelope) => this.noteOp(envelope, "replace"));
        this.runtime.registerCommand("manga.notes", "notes.insert", (envelope) => this.noteOp(envelope, "insert"));
        this.runtime.registerCommand("manga.notes", "notes.remove", (envelope) => this.noteOp(envelope, "remove"));
        this.runtime.registerCommand("manga.notes", "notes.setType", (envelope) => this.noteOp(envelope, "setType"));
        this.runtime.registerCommand("manga.notes", "notes.rename", (envelope) => this.noteOp(envelope, "rename"));
        this.runtime.registerCommand("manga.notes", "notes.asset", (envelope) => {
          const input = envelope.input as { resourceRevisionId: string; assetId: string };
          const grant = this.grantOf(envelope);
          const owner = this.store.sqlite.prepare("SELECT resource_id FROM resource_assets WHERE id = ?").get(`${input.resourceRevisionId}:${input.assetId}`) as { resource_id: string } | undefined;
          if (!owner) throw new MangaError("NOT_FOUND", "asset missing");
          if (!this.grants.canRead(grant, owner.resource_id)) throw new MangaError("SCOPE_DENIED", "asset is outside the authorized set");
          const asset = readAsset(this.store, input.resourceRevisionId, input.assetId);
          if (!asset) throw new MangaError("NOT_FOUND", "asset missing");
          return { mediaType: asset.mediaType, name: asset.name, bytes: [...asset.bytes] };
        });
        this.runtime.registerCommand("manga.notes", "notes.openSource", (envelope) => {
          const input = envelope.input as { objectId: string; blockId?: string };
          this.assertNoteAccess(envelope, input.objectId, false);
          return openNoteSourceDetail(this.store, input.objectId, input.blockId);
        });
        this.runtime.registerCommand("manga.notes", "notes.list", (envelope) => {
          const grant = this.grantOf(envelope);
          const input = envelope.input as { resourceId?: string };
          if (input.resourceId && !this.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
          return this.filterNotesForGrant(envelope, listNotes(this.store, envelope.input as Parameters<typeof listNotes>[1]));
        });
        this.runtime.registerCommand("manga.notes", "notes.history", (envelope) => {
          const input = envelope.input as { objectId: string; limit?: number };
          this.assertNoteAccess(envelope, input.objectId, false);
          return noteHistory(this.store, input.objectId, input.limit);
        });
        this.runtime.registerCommand("manga.notes", "notes.restore", (envelope) => {
          this.assertWritable();
          const input = envelope.input as { objectId: string };
          this.assertNoteAccess(envelope, input.objectId, true);
          return restoreNoteRevision(this.store, { ...(envelope.input as Parameters<typeof restoreNoteRevision>[1]), objectId: input.objectId, idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId });
        });
        this.runtime.registerCommand("manga.notes", "notes.tags", (envelope) => {
          this.assertWritable();
          const input = envelope.input as { objectId: string };
          this.assertNoteAccess(envelope, input.objectId, true);
          return setNoteTags(this.store, { ...(envelope.input as Parameters<typeof setNoteTags>[1]), objectId: input.objectId, idempotencyKey: envelope.idempotencyKey, commandId: envelope.commandId });
        });
      },
      deactivate: () => undefined,
    });
  }

  private settingsModule(): MangaModule {
    return defineModule({
      manifest: {
        moduleId: "manga.settings",
        version: "1.0.0",
        displayName: "设置",
        featureId: "settings",
        contributes: [{ capabilityId: "manga.settings", version: "1.0.0" }],
        needs: [],
        facets: ["service", "ui"],
        conflictsWith: [],
        ownerModuleIds: [],
      },
      activate: (ctx) => {
        if ((ctx.hostFacets ?? []).includes("ui")) {
          this.uiFacets.add("settings");
          ctx.register({ kind: "subscription", id: `settings-ui-${ctx.epoch}`, dispose: () => {
            this.uiFacets.delete("settings");
          } });
        }
        this.runtime.registerCommand("manga.settings", "settings.get", () => this.settingsSnapshot());
        this.runtime.registerCommand("manga.settings", "settings.skipAi", () => {
          this.assertWritable();
          this.store.setMeta("aiSkipped", "1");
          return { skipped: true };
        });
        this.runtime.registerCommand("manga.settings", "settings.proposeLocations", (envelope) => {
          this.assertWritable();
          return this.proposeLocations(envelope);
        });
        this.runtime.registerCommand("manga.settings", "settings.applyLocations", (envelope) => this.applyLocations(envelope));
        this.runtime.registerCommand("manga.settings", "settings.recoverJobs", (envelope) => {
          // A sealed host no longer owns the authoritative library; its stale job rows must not drive deletions.
          this.assertWritable();
          const input = envelope.input as { action: "recover" | "rollback" };
          return this.recoverJobs(input.action);
        });
        this.runtime.registerCommand("manga.settings", "settings.setRuntime", (envelope) => this.setRuntime(envelope));
        this.runtime.registerCommand("manga.settings", "settings.setLayout", (envelope) => this.setLayout(envelope));
        this.runtime.registerCommand("manga.settings", "settings.getShell", () => readShell(this.store));
        this.runtime.registerCommand("manga.settings", "settings.setShell", (envelope) => {
          this.assertWritable();
          return writeShell(this.store, readShell(this.store), envelope.input as {
            mode?: "enthusiast" | "creator";
            spoilerGuard?: boolean;
            focus?: boolean;
            left?: { visible?: boolean; width?: number };
            right?: { visible?: boolean; width?: number };
            reading?: { measurePx?: number; fontSizePx?: number; lineHeight?: number; theme?: "paper" | "night" };
          }, envelope);
        });
        this.runtime.registerCommand("manga.settings", "connections.list", () => this.listConnections());
        this.runtime.registerCommand("manga.settings", "connections.upsert", (envelope) => this.upsertConnection(envelope));
        this.runtime.registerCommand("manga.settings", "connections.test", (envelope, signal) => this.testConnection(envelope, signal));
        this.runtime.registerCommand("manga.settings", "connections.delete", (envelope) => this.deleteConnection(envelope));
      },
      deactivate: () => undefined,
    });
  }

  private inventoryModule(): MangaModule {
    return defineModule({
      manifest: {
        moduleId: "manga.inventory",
        version: "1.0.0",
        displayName: "资源总览",
        featureId: "inventory",
        contributes: [{ capabilityId: "manga.inventory", version: "1.0.0" }],
        needs: [{ capabilityId: "manga.library", version: "1.0.0", cardinality: "single", required: true }],
        facets: ["service", "ui"],
        conflictsWith: [],
        ownerModuleIds: [],
      },
      activate: (ctx) => {
        if ((ctx.hostFacets ?? []).includes("ui")) {
          this.uiFacets.add("inventory");
          ctx.register({ kind: "subscription", id: `inventory-ui-${ctx.epoch}`, dispose: () => {
            this.uiFacets.delete("inventory");
          } });
        }
        this.runtime.registerCommand("manga.inventory", "inventory.overview", (envelope, signal) => this.inventory(signal, false, this.grantOf(envelope)));
        this.runtime.registerCommand("manga.inventory", "inventory.scan", async (envelope, signal) => {
          this.assertWritable();
          this.scanAbort?.abort();
          this.scanAbort = new AbortController();
          const combined = AbortSignal.any([signal, this.scanAbort.signal]);
          return this.inventory(combined, true, this.grantOf(envelope));
        });
        this.runtime.registerCommand("manga.inventory", "inventory.cancelScan", () => {
          this.scanAbort?.abort();
          return { cancelled: true };
        });
        this.runtime.registerCommand("manga.inventory", "inventory.reveal", (envelope) => this.revealInventory(envelope));
        this.runtime.registerCommand("manga.inventory", "inventory.repair", (envelope) => this.repairInventory(envelope));
      },
      deactivate: () => this.scanAbort?.abort(),
    });
  }

  private agentModule(): MangaModule {
    return defineModule({
      manifest: {
        moduleId: "manga.agent",
        version: "1.0.0",
        displayName: "Agent",
        featureId: "agent",
        contributes: [{ capabilityId: "manga.agent", version: "1.0.0" }],
        needs: [{ capabilityId: "manga.library", version: "1.0.0", cardinality: "single", required: true }],
        facets: ["service", "ui"],
        conflictsWith: [],
        ownerModuleIds: [],
      },
      activate: (ctx) => {
        if ((ctx.hostFacets ?? []).includes("ui")) {
          this.uiFacets.add("agent");
          ctx.register({ kind: "subscription", id: `agent-ui-${ctx.epoch}`, dispose: () => {
            this.uiFacets.delete("agent");
          } });
        }
        this.runtime.registerCommand("manga.agent", "agent.createSession", (envelope) => this.createSession(envelope));
        this.runtime.registerCommand("manga.agent", "agent.send", (envelope) => this.sendAgent(envelope));
        this.runtime.registerCommand("manga.agent", "agent.cancel", (envelope) => this.cancelRun(envelope));
        this.runtime.registerCommand("manga.agent", "agent.retry", (envelope) => this.retryRun(envelope));
        this.runtime.registerCommand("manga.agent", "agent.getRun", (envelope) => this.getRun(envelope));
        // Bound resource/project sessions belong to the agent module: it owns their identity and tasks.
        this.runtime.registerCommand("manga.agent", "session.open", (envelope) => {
          this.assertWritable();
          return this.openSession(envelope, envelope.input as { kind: "resource" | "project" | "note"; targetId: string; mode?: "enthusiast" | "creator"; sessionId?: string });
        });
      },
      deactivate: () => {
        for (const controller of this.runAbort.values()) controller.abort();
      },
    });
  }

  workspace() {
    const notes = this.store.sqlite.prepare("SELECT id, revision, title, tags_json, payload_json, updated_at AS updatedAt FROM content_objects WHERE type = 'notes.document' AND deleted_at IS NULL ORDER BY updated_at DESC").all() as Array<{ id: string; revision: number; title: string; tags_json: string; payload_json: string; updatedAt: string }>;
    // One row more than the page shows tells the reader whether older resources exist; the cursor in
    // resourcePage keeps everything past this window reachable through library.list.
    const resourceRows = this.store.sqlite.prepare(`SELECT r.id, r.title, r.created_at AS createdAt, v.id AS revisionId FROM resources r
      LEFT JOIN resource_revisions v ON v.id = (SELECT v2.id FROM resource_revisions v2 WHERE v2.resource_id = r.id ORDER BY v2.created_at DESC, v2.rowid DESC LIMIT 1)
      ORDER BY r.created_at DESC, r.id DESC LIMIT 101`).all() as Array<{ id: string; title: string; createdAt: string; revisionId: string | null }>;
    const resources = resourceRows.slice(0, 100);
    const resourceTotal = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number }).n;
    const sessions = this.store.sqlite.prepare("SELECT * FROM agent_sessions ORDER BY updated_at DESC").all();
    const runs = this.store.sqlite.prepare("SELECT id, session_id AS sessionId, status, grant_handle AS grantHandle, input_text AS inputText, created_at AS createdAt, updated_at AS updatedAt FROM agent_runs ORDER BY created_at DESC LIMIT 50").all();
    const refs = this.store.sqlite.prepare(`SELECT r.from_object_id AS objectId, r.from_block_id AS blockId, r.to_id AS anchorId, a.resource_id AS resourceId
      FROM refs r JOIN anchors a ON a.id = r.to_id WHERE r.to_kind = 'anchor'`).all() as Array<{ objectId: string; blockId: string | null; anchorId: string; resourceId: string }>;
    return {
      notes: notes.map((row) => {
        const own = refs.filter((ref) => ref.objectId === row.id);
        const payload = JSON.parse(row.payload_json) as { blocks?: unknown[] };
        return {
          id: row.id,
          revision: row.revision,
          title: row.title,
          tags: row.tags_json ? JSON.parse(row.tags_json) as string[] : [],
          blocks: payload.blocks ?? [],
          resourceId: own[0]?.resourceId ?? null,
          anchorId: own[0]?.anchorId ?? null,
          blockId: own[0]?.blockId ?? null,
          updatedAt: row.updatedAt,
        };
      }),
      resources,
      resourcePage: {
        total: resourceTotal,
        listed: resources.length,
        nextCursor: resourceRows.length > 100 && resources.length
          ? encodeResourceCursor({ createdAt: resources[resources.length - 1]!.createdAt, id: resources[resources.length - 1]!.id })
          : null,
      },
      sessions,
      runs,
      uiFacets: [...this.uiFacets],
      layout: this.publicLayout(),
      aiSkipped: this.store.getMeta("aiSkipped") === "1",
      restartRequired: this.sealed,
      shell: readShell(this.store),
    };
  }

  /** Resource/project sessions shown under the left-rail navigation, each bound to its own agent session. */
  sessionList(mode?: "enthusiast" | "creator"): Array<Record<string, unknown>> {
    const rows = this.store.sqlite.prepare("SELECT id, title, kind, target_id AS targetId, mode, updated_at AS updatedAt FROM agent_sessions ORDER BY updated_at DESC LIMIT 100").all() as Array<{ id: string; title: string; kind: string; targetId: string | null; mode: string | null; updatedAt: string }>;
    // A row saved before modes existed belongs to the enthusiast default, matching session.open.
    const filtered = mode ? rows.filter((row) => (row.mode ?? "enthusiast") === mode) : rows;
    return filtered.map((row) => {
      const runCount = Number((this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ?").get(row.id) as { n: number }).n);
      const active = this.store.sqlite.prepare("SELECT id, status FROM agent_runs WHERE session_id = ? AND status IN ('queued','running','waiting_input') ORDER BY created_at DESC LIMIT 1").get(row.id) as { id: string; status: string } | undefined;
      const resource = row.targetId ? this.store.sqlite.prepare("SELECT title FROM resources WHERE id = ?").get(row.targetId) as { title: string } | undefined : undefined;
      return {
        sessionId: row.id,
        title: resource?.title ?? row.title,
        kind: row.kind,
        targetId: row.targetId,
        mode: row.mode,
        runCount,
        activeRunId: active?.id ?? null,
        activeRunStatus: active?.status ?? null,
        updatedAt: row.updatedAt,
      };
    });
  }

  /** A note is visible to a bounded grant only when its own id or its source resource is authorized. */
  private filterNotesForGrant(envelope: CommandEnvelope, notes: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const grant = this.grantOf(envelope);
    if (grant.access === "owner") return notes;
    return notes.filter((note) => {
      if (this.grants.canWriteObject(grant, String(note.objectId))) return true;
      const resourceId = note.resourceId;
      return typeof resourceId === "string" && this.grants.canRead(grant, resourceId);
    });
  }

  private publicLayout() {
    return {
      ...this.layout,
      partitions: this.layout.partitions,
    };
  }

  private grantOf(envelope: CommandEnvelope): ScopeGrant {
    const grant = this.grants.get(envelope.scopeHandle);
    if (!grant) throw new MangaError("FORBIDDEN", "missing grant");
    return grant;
  }

  private async importText(envelope: CommandEnvelope, signal: AbortSignal) {
    const input = envelope.input as { title: string; bytes: number[]; encoding?: "utf-8" | "utf-16le" };
    const generation = this.parseGeneration;
    const parsed = this.parseWorker
      ? await this.parseWorker.parse({ bytes: input.bytes, encoding: input.encoding, signal }) as { normalized: string; parserVersion: string; bom: boolean }
      : (() => {
        const decoded = decodeTextBuffer(Uint8Array.from(input.bytes), input.encoding ?? "utf-8");
        const normalized = normalizeText(decoded.text);
        return { normalized: normalized.normalized, parserVersion: normalized.parserVersion, bom: decoded.bom };
      })();
    if (signal.aborted || generation !== this.parseGeneration) throw new MangaError("CANCELLED", "parse result discarded after deactivate or cancel");
    this.assertWritable();
    const resourceId = createId("res");
    const workId = createId("work");
    const revisionId = createId("rev");
    const now = new Date().toISOString();
    this.store.commit({
      mutations: [
        { sql: "INSERT INTO works(id,title,created_at) VALUES (?,?,?)", params: [workId, input.title, now] },
        { sql: "INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?,?,?,?,?,?)", params: [resourceId, workId, "novel", input.title, JSON.stringify([input.title]), now] },
        { sql: "INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)", params: [revisionId, resourceId, createHash("sha256").update(Buffer.from(input.bytes)).digest("hex"), parsed.parserVersion, JSON.stringify({ id: revisionId, normalized: parsed.normalized, parserVersion: parsed.parserVersion, parts: [{ id: "body", normalized: parsed.normalized, parserVersion: parsed.parserVersion }] }), now] },
        ...this.store.indexFragment({ id: createId("frag"), resourceId, kind: "title", text: input.title }),
        ...this.store.indexTextChunks({ resourceId, resourceRevisionId: revisionId, partId: "body", representationId: revisionId, kind: "body", text: parsed.normalized }),
      ],
      events: [{ type: "resource.imported", payload: { resourceId, revisionId } }],
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      result: { resourceId, workId, revisionId, length: parsed.normalized.length },
    });
    return { resourceId, workId, revisionId, normalized: parsed.normalized, bom: parsed.bom };
  }

  private getResource(envelope: CommandEnvelope) {
    const grant = this.grantOf(envelope);
    const input = envelope.input as { resourceId: string };
    if (!this.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
    const snapshotRevision = grant.runId ? this.snapshotRevision(grant.runId, input.resourceId) : undefined;
    const row = snapshotRevision
      ? this.store.sqlite.prepare("SELECT r.id, r.title, r.kind, v.id AS revisionId, v.parser_version AS parserVersion, v.payload_json FROM resources r JOIN resource_revisions v ON v.id = ? WHERE r.id = ?").get(snapshotRevision, input.resourceId) as
        | { id: string; title: string; kind: string; revisionId: string; parserVersion: string; payload_json: string }
        | undefined
      : this.store.sqlite.prepare("SELECT r.id, r.title, r.kind, v.id AS revisionId, v.parser_version AS parserVersion, v.payload_json FROM resources r JOIN resource_revisions v ON v.resource_id = r.id WHERE r.id = ? ORDER BY v.created_at DESC LIMIT 1").get(input.resourceId) as
        | { id: string; title: string; kind: string; revisionId: string; parserVersion: string; payload_json: string }
        | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "resource missing");
    if (grant.access !== "owner" && readShell(this.store).spoilerGuard) {
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
  private libraryList(envelope: CommandEnvelope) {
    const grant = this.grantOf(envelope);
    const input = envelope.input as { limit?: number; cursor?: string; query?: string };
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 200);
    const where: string[] = [];
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
    const total = (this.store.sqlite.prepare(`SELECT COUNT(*) AS n FROM resources r${totalFilter}`).get(...params) as { n: number }).n;
    if (input.cursor) {
      const decoded = decodeResourceCursor(input.cursor);
      if (!decoded) throw new MangaError("VALIDATION_ERROR", "library page cursor is invalid");
      where.push("(r.created_at < ? OR (r.created_at = ? AND r.id < ?))");
      params.push(decoded.createdAt, decoded.createdAt, decoded.id);
    }
    const filter = where.length ? ` WHERE ${where.join(" AND ")}` : "";
    const rows = this.store.sqlite.prepare(`SELECT r.id, r.title, r.kind, r.created_at AS createdAt, v.id AS revisionId
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

  private snapshotRevision(runId: string, resourceId: string): string | undefined {    const run = this.store.sqlite.prepare("SELECT snapshot_json FROM agent_runs WHERE id = ?").get(runId) as { snapshot_json: string | null } | undefined;
    if (!run?.snapshot_json) return undefined;
    const snapshot = JSON.parse(run.snapshot_json) as { materials?: Array<{ resourceId: string; revisionId: string }> };
    return snapshot.materials?.find((item) => item.resourceId === resourceId)?.revisionId;
  }

  private contextSnapshot(envelope: CommandEnvelope) {
    const grant = this.grantOf(envelope);
    const input = envelope.input as { resourceId: string; resourceRevisionId: string; partId?: string; start?: number; end?: number };
    if (!this.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
    const capturedRevision = grant.runId ? this.snapshotRevision(grant.runId, input.resourceId) : undefined;
    if (capturedRevision && capturedRevision !== input.resourceRevisionId) {
      throw new MangaError("REVISION_CONFLICT", "requested material revision differs from the run snapshot");
    }
    const row = this.store.sqlite.prepare("SELECT payload_json FROM resource_revisions WHERE id = ? AND resource_id = ?").get(input.resourceRevisionId, input.resourceId) as { payload_json: string } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "resource revision does not belong to this resource");
    const payload = JSON.parse(row.payload_json) as { normalized?: string; parts?: Array<{ id: string; normalized: string }> };
    const parts = payload.parts ?? [{ id: "body", normalized: payload.normalized ?? "" }];
    const part = input.partId ? parts.find((item) => item.id === input.partId) : parts[0];
    if (!part) throw new MangaError("NOT_FOUND", "resource part missing");
    const start = input.start ?? 0;
    const end = input.end ?? Math.min(start + 240, codePointSafeEnd(part.normalized, start));
    this.assertConsumedRange(grant, input.resourceId, input.resourceRevisionId, part.id, start, end);
    if (start > end || end - start > 4096) throw new MangaError("VALIDATION_ERROR", "context range is invalid");
    const quote = sliceCodePoints(part.normalized, start, end);
    if (end > [...part.normalized].length) throw new MangaError("VALIDATION_ERROR", "context range is past the end");
    return { resourceId: input.resourceId, resourceRevisionId: input.resourceRevisionId, partId: part.id, range: { start, end }, quote };
  }

  private search(envelope: CommandEnvelope) {
    const grant = this.grantOf(envelope);
    const input = envelope.input as { text: string; readAllowlist?: string[]; resourceId?: string; withinProgress?: boolean };
    const allowlist = this.grants.intersectRead(grant, input.readAllowlist);
    const hits = this.store.search({ text: input.text, readAllowlist: allowlist, resourceIds: input.resourceId ? [input.resourceId] : undefined });
    const spoiler = grant.access !== "owner" && readShell(this.store).spoilerGuard;
    return input.withinProgress || spoiler ? filterUnread(this.store, hits) : hits;
  }

  private createNote(envelope: CommandEnvelope) {
    const grant = this.grantOf(envelope);
    const input = envelope.input as { title: string; text: string; resourceId?: string; resourceRevisionId?: string; tags?: string[]; locator?: { quote?: { exact?: string }; partId?: string; range?: { start: number; end: number } } };
    if (!grant.allowCreateObjects) throw new MangaError("FORBIDDEN", "creating objects is not authorized");
    if (input.resourceId && !this.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "note source is outside the authorized set");
    if (input.resourceId && input.resourceRevisionId) {
      // A note must not point at a revision that does not belong to the resource it names.
      const revision = this.store.sqlite.prepare("SELECT id FROM resource_revisions WHERE id = ? AND resource_id = ?").get(input.resourceRevisionId, input.resourceId);
      if (!revision) throw new MangaError("NOT_FOUND", "resource revision does not belong to this resource");
    }
    const objectId = createId("obj");
    const anchorId = input.locator && input.resourceId && input.resourceRevisionId ? createId("anc") : undefined;
    const tags = [...new Set((input.tags ?? []).map((tag) => tag.trim()).filter(Boolean))].slice(0, NOTE_TAG_MAX);
    // The excerpt is a distinct block from the user's own comment, so the two read as different sources.
    const blocks = anchorId
      ? [{ id: "quote", type: "quote", text: input.locator?.quote?.exact ?? "", anchorId }, { id: "b1", type: "paragraph", text: input.text }]
      : [{ id: "b1", type: "paragraph", text: input.text }];
    const now = new Date().toISOString();
    const mutations: Mutation[] = [
        { sql: "INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, tags_json, attachment_ids_json, preview_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", params: [objectId, "notes.document", "manga.notes", JSON.stringify({ kind: "library", resourceId: input.resourceId ?? null }), anchorId ? 2 : 1, 1, input.title, JSON.stringify(anchorId ? { schemaVersion: 2, blocks } : { blocks }), JSON.stringify(tags), "[]", JSON.stringify({ text: input.text.slice(0, 80) }), now, now] },
        { sql: "INSERT INTO object_revisions(object_id, revision, payload_json, created_at) VALUES (?,?,?,?)", params: [objectId, 1, JSON.stringify(anchorId ? { schemaVersion: 2, blocks } : { blocks }), now] },
        ...this.store.indexFragment({ id: createId("frag"), objectId, resourceId: input.resourceId, kind: "note", text: `${input.locator?.quote?.exact ?? ""}\n${input.text}`.trim() }),
    ];
    if (anchorId && input.resourceId && input.resourceRevisionId && input.locator) {
      mutations.push(
        { sql: "INSERT INTO anchors(id, resource_id, resource_revision_id, locator_json, preview_json, created_at) VALUES (?,?,?,?,?,?)", params: [anchorId, input.resourceId, input.resourceRevisionId, JSON.stringify(input.locator), JSON.stringify({ text: input.locator.quote?.exact ?? "" }), now] },
        { sql: "INSERT INTO refs(id, from_object_id, from_block_id, to_kind, to_id, mode, instance_layout_json, created_at) VALUES (?,?,?,?,?,?,?,?)", params: [createId("ref"), objectId, "quote", "anchor", anchorId, "live", null, now] },
      );
    }
    this.store.commit({
      mutations,
      events: [{ type: "note.created", payload: { objectId } }],
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      result: { objectId, revision: 1, anchorId },
    });
    if (grant.access === "enumerated") {
      this.grants.save({ ...grant, writeObjectIds: [...grant.writeObjectIds, objectId] });
    }
    return { objectId, revision: 1, anchorId };
  }

  private updateNote(envelope: CommandEnvelope) {
    const grant = this.grantOf(envelope);
    const input = envelope.input as { objectId: string; expectedRevision: number; blockId?: string; text: string };
    if (!this.grants.canWriteObject(grant, input.objectId) && grant.access !== "owner") throw new MangaError("SCOPE_DENIED", "object is outside the authorized set");
    const row = this.store.sqlite.prepare("SELECT revision, payload_json FROM content_objects WHERE id = ?").get(input.objectId) as { revision: number; payload_json: string } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "note missing");
    if (row.revision !== input.expectedRevision) {
      throw new MangaError("REVISION_CONFLICT", "note revision changed", { details: { expected: input.expectedRevision, actual: row.revision, candidate: { text: input.text, blockId: input.blockId } } });
    }
    const payload = JSON.parse(row.payload_json) as { blocks?: Array<{ id: string }> };
    if (!input.blockId && (payload.blocks?.length ?? 0) !== 1) throw new MangaError("VALIDATION_ERROR", "a blockId is required for a multi-block note");
    const blockId = input.blockId ?? payload.blocks?.[0]?.id;
    if (!blockId) throw new MangaError("VALIDATION_ERROR", "editable note block missing");
    return commitNoteOp(this.store, {
      objectId: input.objectId,
      expectedRevision: input.expectedRevision,
      op: { type: "setText", blockId, text: input.text },
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      candidate: { text: input.text, blockId },
    });
  }

  private undoNote(envelope: CommandEnvelope) {
    const grant = this.grantOf(envelope);
    const input = envelope.input as { objectId: string; expectedRevision: number };
    if (!this.grants.canWriteObject(grant, input.objectId) && grant.access !== "owner") throw new MangaError("SCOPE_DENIED", "object is outside the authorized set");
    const row = this.store.sqlite.prepare("SELECT revision FROM content_objects WHERE id = ?").get(input.objectId) as { revision: number } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "note missing");
    if (row.revision !== input.expectedRevision) throw new MangaError("REVISION_CONFLICT", "note revision changed");
    const previous = this.store.sqlite.prepare("SELECT payload_json FROM object_revisions WHERE object_id = ? AND revision = ?").get(input.objectId, row.revision - 1) as { payload_json: string } | undefined;
    if (!previous) throw new MangaError("NOT_FOUND", "no previous revision to restore");
    const next = row.revision + 1;
    const now = new Date().toISOString();
    const payload = JSON.parse(previous.payload_json) as { blocks?: Array<{ id?: string; text?: string }> };
    const text = (payload.blocks ?? []).map((block) => block.text ?? "").join("\n");
    const linked = this.store.sqlite.prepare("SELECT resource_id FROM text_fragments WHERE object_id = ? AND resource_id IS NOT NULL LIMIT 1").get(input.objectId) as { resource_id?: string } | undefined;
    const tags = this.store.sqlite.prepare("SELECT tags_json FROM content_objects WHERE id = ?").get(input.objectId) as { tags_json?: string } | undefined;
    this.store.commit({
      mutations: [
        { sql: "UPDATE content_objects SET revision = ?, payload_json = ?, tags_json = ?, preview_json = ?, updated_at = ? WHERE id = ?", params: [next, previous.payload_json, tags?.tags_json ?? "[]", JSON.stringify({ text: text.slice(0, 80) }), now, input.objectId] },
        { sql: "INSERT INTO object_revisions(object_id, revision, payload_json, created_at) VALUES (?,?,?,?)", params: [input.objectId, next, previous.payload_json, now] },
        { sql: "DELETE FROM search_idx WHERE fragment_id IN (SELECT id FROM text_fragments WHERE object_id = ?)", params: [input.objectId] },
        { sql: "DELETE FROM text_fragments WHERE object_id = ?", params: [input.objectId] },
        ...(payload.blocks ?? []).flatMap((block) => this.store.indexTextChunks({
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

  private settingsSnapshot() {
    return {
      layout: this.publicLayout(),
      pointerPath: this.layout.pointerPath,
      layoutConfig: this.store.getMeta("layoutConfig") ? JSON.parse(this.store.getMeta("layoutConfig")!) : { pointerPath: this.layout.pointerPath, partitions: this.layout.overrides },
      aiSkipped: this.store.getMeta("aiSkipped") === "1",
      aiRuntime: this.currentRuntime(),
      vaultAvailable: this.vault.available(),
      connections: this.listConnections(),
      recoveryJobs: this.pendingRecoveryJobs(),
      restartRequired: this.sealed,
      needsSetup: this.store.getMeta("aiSkipped") !== "1" && this.listConnections().length === 0,
      shell: readShell(this.store),
    };
  }

  /** Jobs whose staging or partial copies still need a decision (identified, never auto-deleted). */
  pendingRecoveryJobs() {
    return this.store.sqlite.prepare("SELECT id, kind, stage, status, staging_path AS stagingPath, updated_at AS updatedAt FROM recovery_jobs WHERE status IN ('planned','running','interrupted','failed','needs-review') ORDER BY created_at").all() as Array<{ id: string; kind: string; stage: string; status: string; stagingPath: string | null; updatedAt: string }>;
  }

  private currentRuntime(): AiRuntimeId {
    const saved = this.store.getMeta("aiRuntime");
    return saved === "pi" ? "pi" : "native";
  }

  private setRuntime(envelope: CommandEnvelope) {
    this.assertWritable();
    const input = envelope.input as { runtime: AiRuntimeId };
    this.store.setMeta("aiRuntime", input.runtime);
    return { runtime: input.runtime };
  }

  private setLayout(envelope: CommandEnvelope) {
    this.assertWritable();
    const input = envelope.input as { pointerPathHandle?: string; partitions?: Partial<Record<string, string>> };
    if (input.partitions && Object.keys(input.partitions).length) {
      throw new MangaError("CAPABILITY_UNAVAILABLE", "per-partition relocation is not available yet; save a pointer location or migrate the whole profile root");
    }
    if (!input.pointerPathHandle) throw new MangaError("VALIDATION_ERROR", "layout update requires a pointer path handle");
    const nextPointer = this.resolvePath(input.pointerPathHandle);
    if (path.extname(nextPointer) && path.extname(nextPointer).toLowerCase() !== ".json") {
      throw new MangaError("VALIDATION_ERROR", "pointer path must be a json file or directory");
    }
    const pointerFile = fs.existsSync(nextPointer) && fs.statSync(nextPointer).isDirectory()
      ? path.join(nextPointer, "pointer.json")
      : nextPointer;
    const previous = this.layout.pointerPath;
    persistPointerAt(this.layout, pointerFile);
    if (comparablePath(previous) !== comparablePath(pointerFile) && fs.existsSync(previous)) {
      fs.writeFileSync(previous, `${JSON.stringify({ redirectedTo: pointerFile, channel: this.layout.channel, revision: this.layout.revision }, null, 2)}\n`);
    }
    this.layout.pointerPath = pointerFile;
    this.store.setMeta("layoutConfig", JSON.stringify({ pointerPath: pointerFile, partitions: this.layout.overrides }));
    return { pointerPath: pointerFile, partitions: this.layout.partitions, restartRequired: false };
  }

  private recoverJobs(action: "recover" | "rollback") {
    const outcome = recoverOrRollback(this.store, action, this.layout.defaultRoot);
    if (action !== "recover" || !outcome.recovered.length) return outcome;
    for (const jobId of outcome.recovered) {
      const job = this.store.sqlite.prepare("SELECT payload_json FROM recovery_jobs WHERE id = ?").get(jobId) as { payload_json: string } | undefined;
      if (!job) continue;
      const payload = JSON.parse(job.payload_json) as { copies: Array<{ partition: string; source: string; target: string; indexedOnly?: boolean }>; targetRoot?: string; verified?: Array<{ partition: string; bytes: number; fingerprint: string }> };
      if (!payload.targetRoot) continue;
      this.publishRelocatedLibrary(jobId, { copies: payload.copies, targetRoot: payload.targetRoot }, payload.verified ?? []);
    }
    return { ...outcome, restartRequired: this.sealed };
  }

  private proposeLocations(envelope: CommandEnvelope) {
    const input = envelope.input as { pathHandle?: string; partitions?: Partial<Record<string, string>>; indexedOnly?: string[] };
    const indexedOnly = new Set(input.indexedOnly ?? []);
    // The launcher pointer records one profile root; a partition parked elsewhere would be lost on the next start.
    if (input.partitions && Object.keys(input.partitions).length) {
      throw new MangaError("CAPABILITY_UNAVAILABLE", "per-partition relocation is not available yet; the launcher pointer only records a profile root");
    }
    if (!input.pathHandle) throw new MangaError("VALIDATION_ERROR", "migration plan requires a root path handle");
    for (const partition of indexedOnly) {
      if (!INDEXABLE_PARTITIONS.has(partition)) {
        throw new MangaError("VALIDATION_ERROR", `partition ${partition} is referenced by the library database and must be copied`, { details: { partition } });
      }
    }
    const checkpointId = createId("ckpt");
    const targetRoot = this.resolvePath(input.pathHandle);
    assertSafeMigrationTarget(this.layout.defaultRoot, targetRoot);
    const copies = LOCATION_PARTITIONS.map((partition) => {
      const source = this.layout.partitions[partition];
      const fp = fingerprintTree(source);
      return { partition, source, target: path.join(targetRoot, partition), bytes: fp.bytes, fingerprint: fp.hash, indexedOnly: indexedOnly.has(partition) };
    });
    this.store.sqlite.prepare("INSERT INTO recovery_jobs(id, kind, stage, status, staging_path, payload_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(
      checkpointId, "location-migrate", "planned", "planned", null, JSON.stringify({ copies, targetRoot, liveRoot: this.layout.defaultRoot }), new Date().toISOString(), new Date().toISOString(),
    );
    return { checkpointId, copies };
  }

  private applyLocations(envelope: CommandEnvelope) {
    this.assertWritable();
    const input = envelope.input as { checkpointId: string; pathHandle?: string };
    const job = this.store.sqlite.prepare("SELECT payload_json, status FROM recovery_jobs WHERE id = ?").get(input.checkpointId) as { payload_json: string; status: string } | undefined;
    if (!job) throw new MangaError("NOT_FOUND", "migration checkpoint missing");
    const payload = JSON.parse(job.payload_json) as { copies: Array<{ partition: string; source: string; target: string; indexedOnly?: boolean }>; targetRoot?: string; liveRoot?: string };
    if (job.status !== "planned") throw new MangaError("VALIDATION_ERROR", "migration checkpoint was already applied or abandoned", { details: { status: job.status } });
    // A partition-only plan has no root; applying it with an arbitrary handle would point the launcher at a partition directory.
    if (!payload.targetRoot) throw new MangaError("CAPABILITY_UNAVAILABLE", "checkpoint has no root target; per-partition relocation is not available yet");
    const targetRoot = input.pathHandle ? this.resolvePath(input.pathHandle) : payload.targetRoot;
    if (path.resolve(payload.targetRoot) !== path.resolve(targetRoot)) throw new MangaError("VALIDATION_ERROR", "checkpoint was planned for a different target");
    assertSafeMigrationTarget(this.layout.defaultRoot, targetRoot);
    for (const copy of payload.copies) {
      if (copy.indexedOnly) continue;
      const dest = path.resolve(copy.target);
      if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new MangaError("PUBLISH_CONFLICT", "location target must be empty");
    }
    // Runs still in flight would keep writing into the library that is about to be abandoned.
    this.interruptRuns("profile location changed while the run was in progress");
    // Index-only partitions stay where they are; the record must land before the checkpoint so the copied database carries it.
    for (const copy of payload.copies) {
      if (copy.indexedOnly) this.indexRootRecord(copy.source, "file");
    }
    const checkpoint = this.store.sqlite.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>;
    if (checkpoint[0]?.busy || (checkpoint[0] && checkpoint[0].log !== checkpoint[0].checkpointed)) {
      throw new MangaError("LOCATION_UNAVAILABLE", "database is busy; retry the migration", { retryable: true });
    }
    this.store.sqlite.prepare("UPDATE recovery_jobs SET status = 'running', stage = 'copy', updated_at = ? WHERE id = ?").run(new Date().toISOString(), input.checkpointId);
    const verified: Array<{ partition: string; bytes: number; fingerprint: string }> = [];
    try {
      for (const copy of payload.copies) {
        if (copy.indexedOnly) continue;
        const dest = copy.target;
        fs.mkdirSync(dest, { recursive: true });
        const files = listCopyFiles(copy.source);
        for (const file of files) {
          const relative = file.relativePath.replace(/^\.\//, "");
          const targetFile = path.join(dest, relative);
          this.store.sqlite.prepare("INSERT OR REPLACE INTO migration_owned_files(job_id, partition, relative_path, absolute_path, state, fingerprint) VALUES (?,?,?,?,?,?)").run(
            input.checkpointId, copy.partition, relative, targetFile, "planned", null,
          );
          this.store.sqlite.prepare("UPDATE migration_owned_files SET state = 'copying' WHERE job_id = ? AND partition = ? AND relative_path = ?").run(input.checkpointId, copy.partition, relative);
          const hash = copyOwnedFile(file.absolutePath, targetFile);
          this.store.sqlite.prepare("UPDATE migration_owned_files SET state = 'committed', fingerprint = ? WHERE job_id = ? AND partition = ? AND relative_path = ?").run(hash, input.checkpointId, copy.partition, relative);
        }
        const expected = fingerprintTree(copy.source);
        const actual = fingerprintTree(dest);
        if (actual.hash !== expected.hash) throw new MangaError("VALIDATION_ERROR", `copied ${copy.partition} does not match its source`, { details: { partition: copy.partition } });
        verified.push({ partition: copy.partition, bytes: actual.bytes, fingerprint: actual.hash });
        this.store.maybeCrash("location-copy");
      }
    } catch (error) {
      // Owned rows stay so recoverJobs can remove exactly what this job produced.
      this.store.sqlite.prepare("UPDATE recovery_jobs SET status = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), input.checkpointId);
      throw error;
    }
    this.store.maybeCrash("location-verify");
    return this.publishRelocatedLibrary(input.checkpointId, { ...payload, targetRoot }, verified);
  }

  private publishRelocatedLibrary(jobId: string, payload: { copies: Array<{ partition: string; source: string; target: string; indexedOnly?: boolean }>; targetRoot: string }, verified: Array<{ partition: string; bytes: number; fingerprint: string }>) {
    const targetRoot = payload.targetRoot;
    this.store.maybeCrash("location-publish");
    const targetData = path.join(targetRoot, "data");
    if (fs.existsSync(path.join(targetData, "manga.sqlite"))) {
      const remote = new DrizzleStore({ profileDir: targetData, hostId: "migrate-target", attachmentsDir: path.join(targetRoot, "attachments"), nativeBinding: this.store.options.nativeBinding });
      try {
        remote.sqlite.prepare("UPDATE recovery_jobs SET status = 'succeeded', stage = 'done', payload_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...payload, verified }), new Date().toISOString(), jobId);
        remote.sqlite.pragma("wal_checkpoint(TRUNCATE)");
      } finally {
        remote.close();
      }
    }
    this.store.maybeCrash("location-commit");
    this.store.sqlite.prepare("UPDATE recovery_jobs SET status = 'succeeded', stage = 'done', payload_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...payload, verified }), new Date().toISOString(), jobId);
    this.store.setMeta("relocatedRoot", targetRoot);
    writeRelocationMarker(this.layout.defaultRoot, targetRoot);
    persistPointer({
      ...this.layout,
      defaultRoot: targetRoot,
      partitions: Object.fromEntries(LOCATION_PARTITIONS.map((name) => [name, path.join(targetRoot, name)])) as LocationLayout["partitions"],
    }, () => this.store.maybeCrash("location-pointer"));
    this.store.maybeCrash("location-switch");
    this.sealed = true;
    return { ok: true, root: targetRoot, restartRequired: true, verified };
  }

  private listConnections() {
    const rows = this.store.sqlite.prepare("SELECT id, label, protocol, runtime, base_url, credential_ref, purpose, model_id, timeout_ms, verified_capabilities_json, created_at FROM provider_connections").all() as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      protocol: row.protocol,
      runtime: row.runtime === "pi" ? "pi" : "native",
      baseUrl: row.base_url,
      credentialConfigured: Boolean(row.credential_ref),
      purpose: row.purpose,
      modelId: row.model_id,
      timeoutMs: Number(row.timeout_ms ?? 60_000),
      verifiedCapabilities: JSON.parse(String(row.verified_capabilities_json || "[]")),
      createdAt: row.created_at,
    }));
  }

  private upsertConnection(envelope: CommandEnvelope) {
    this.assertWritable();
    const input = envelope.input as {
      id?: string;
      label: string;
      protocol: "openai-responses" | "openai-chat-completions";
      runtime?: AiRuntimeId;
      baseUrl: string;
      modelId: string;
      timeoutMs?: number;
      purpose: "text" | "transcription" | "embedding";
      credentialHandle?: string;
    };
    rejectCredentialUrl(input.baseUrl);
    const baseUrl = normalizeBaseUrl(input.baseUrl);
    const id = input.id ?? createId("conn");
    const existing = this.store.sqlite.prepare("SELECT credential_ref FROM provider_connections WHERE id = ?").get(id) as { credential_ref: string | null } | undefined;
    let credentialRef: string | undefined;
    if (input.credentialHandle) {
      if (!this.vault.available()) throw new MangaError("CREDENTIAL_UNAVAILABLE", "cannot store credentials without platform protection");
      const secret = this.secrets.get(input.credentialHandle);
      if (!secret) throw new MangaError("FORBIDDEN", "credential handle is not authorized");
      this.secrets.delete(input.credentialHandle);
      credentialRef = createId("cred");
      const cipher = this.vault.encrypt(secret);
      this.store.sqlite.prepare("INSERT INTO credentials(ref, ciphertext, created_at) VALUES (?,?,?)").run(credentialRef, cipher, new Date().toISOString());
      if (existing?.credential_ref) this.store.sqlite.prepare("DELETE FROM credentials WHERE ref = ?").run(existing.credential_ref);
    }
    const runtime = input.runtime ?? this.currentRuntime();
    this.store.sqlite.prepare(`INSERT INTO provider_connections(id,label,adapter_id,protocol,runtime,base_url,credential_ref,timeout_ms,purpose,model_id,verified_capabilities_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET label=excluded.label, protocol=excluded.protocol, runtime=excluded.runtime, base_url=excluded.base_url, credential_ref=COALESCE(excluded.credential_ref, provider_connections.credential_ref), timeout_ms=excluded.timeout_ms, purpose=excluded.purpose, model_id=excluded.model_id, verified_capabilities_json='[]'`).run(
      id, input.label, "openai-http", input.protocol, runtime, baseUrl, credentialRef ?? null, input.timeoutMs ?? 60_000, input.purpose, input.modelId, "[]", new Date().toISOString(),
    );
    return { id, baseUrl, runtime, credentialConfigured: Boolean(credentialRef ?? existing?.credential_ref) };
  }

  private secretFor(connectionId: string, purpose: "text" | "transcription" | "embedding"): { row: ConnectionRow; apiKey: string } {
    const row = this.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ?").get(connectionId) as ConnectionRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "connection missing");
    if (row.purpose !== purpose) throw new MangaError("MODEL_CAPABILITY_MISSING", "connection purpose does not match the requested model task");
    if (!row.credential_ref) throw new MangaError("AUTHENTICATION_FAILED", "connection has no credential");
    const cred = this.store.sqlite.prepare("SELECT ciphertext FROM credentials WHERE ref = ?").get(row.credential_ref) as { ciphertext: Buffer } | undefined;
    if (!cred) throw new MangaError("NOT_FOUND", "credential payload missing");
    return { row, apiKey: this.vault.decrypt(cred.ciphertext) };
  }

  private async testConnection(envelope: CommandEnvelope, signal: AbortSignal) {
    this.assertWritable();
    const input = envelope.input as { connectionId: string; capability: "text" | "tools" | "streaming" | "transcription" | "embedding" };
    const purpose = input.capability === "transcription" ? "transcription" : input.capability === "embedding" ? "embedding" : "text";
    const { row, apiKey } = this.secretFor(input.connectionId, purpose);
    const protocol = row.protocol as "openai-responses" | "openai-chat-completions";
    const runtime = (row.runtime === "pi" ? "pi" : "native") as AiRuntimeId;
    const timeoutMs = row.timeout_ms;
    if (input.capability === "embedding") {
      const combined = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
      const response = await fetch(joinApiPath(row.base_url, "/embeddings"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: row.model_id, input: "ping" }),
        signal: combined,
      }).catch((error) => {
        if (signal.aborted || combined.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
        throw new MangaError("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "embedding probe failed", { retryable: true });
      });
      if (!response.ok) throw new MangaError(response.status === 404 ? "MODEL_CAPABILITY_MISSING" : "PROVIDER_UNAVAILABLE", "embedding probe failed", { details: { status: response.status } });
      const json = await response.json() as { data?: Array<{ embedding?: unknown[] }> };
      if (!Array.isArray(json.data) || json.data.length !== 1 || !Array.isArray(json.data[0]?.embedding)
        || !json.data[0].embedding.length || !json.data[0].embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new MangaError("MODEL_CAPABILITY_MISSING", "embedding probe returned no valid vector");
      }
      this.markCapability(row.id, "embedding");
      return { ok: true, vectors: json.data.length };
    }
    if (input.capability === "transcription") {
      const result = await transcribeAudio(row.base_url, apiKey, {
        model: row.model_id,
        fileName: "probe.wav",
        bytes: syntheticWav(),
        mimeType: "audio/wav",
        signal,
        timeoutMs,
      });
      if (!result.text.trim()) throw new MangaError("MODEL_CAPABILITY_MISSING", "transcription probe returned empty text");
      this.markCapability(row.id, "transcription");
      return { ok: true, text: result.text };
    }
    if (input.capability === "streaming" || input.capability === "tools") {
      let text = "";
      const args = new Map<string, string>();
      let completed = false;
      for await (const event of streamText(protocol, row.base_url, apiKey, {
        model: row.model_id,
        messages: [{ role: "user", content: "ping" }],
        tools: input.capability === "tools" ? [{ name: "library.find", description: "find", parameters: { type: "object", properties: { text: { type: "string" } } } }] : undefined,
        signal,
        timeoutMs,
      }, runtime)) {
        if (event.type === "text-delta") text += event.text;
        if (event.type === "tool-call-delta") args.set(event.callId, (args.get(event.callId) ?? "") + event.argumentsDelta);
        if (event.type === "completed") completed = true;
      }
      if (!completed) throw new MangaError("PROVIDER_UNAVAILABLE", "stream ended before the provider completed", { retryable: true });
      if (input.capability === "tools" && args.size === 0) throw new MangaError("MODEL_CAPABILITY_MISSING", "tool probe received no tool call");
      for (const value of args.values()) JSON.parse(value);
      this.markCapability(row.id, input.capability);
      return { ok: true, text, tools: [...args.entries()].map(([id, argumentsJson]) => ({ id, argumentsJson })) };
    }
    const completed = await completeText(protocol, row.base_url, apiKey, {
      model: row.model_id,
      messages: [{ role: "user", content: "ping" }],
      signal,
      timeoutMs,
    }, runtime);
    this.markCapability(row.id, "text");
    return { ok: true, text: completed.text };
  }

  private markCapability(id: string, capability: string) {
    const row = this.store.sqlite.prepare("SELECT verified_capabilities_json FROM provider_connections WHERE id = ?").get(id) as { verified_capabilities_json: string };
    const current = new Set(JSON.parse(row.verified_capabilities_json) as string[]);
    current.add(capability);
    this.store.sqlite.prepare("UPDATE provider_connections SET verified_capabilities_json = ? WHERE id = ?").run(JSON.stringify([...current]), id);
  }

  private deleteConnection(envelope: CommandEnvelope) {
    this.assertWritable();
    const input = envelope.input as { connectionId: string };
    const row = this.store.sqlite.prepare("SELECT credential_ref FROM provider_connections WHERE id = ?").get(input.connectionId) as { credential_ref: string | null } | undefined;
    this.store.sqlite.prepare("DELETE FROM provider_connections WHERE id = ?").run(input.connectionId);
    if (row?.credential_ref) this.store.sqlite.prepare("DELETE FROM credentials WHERE ref = ?").run(row.credential_ref);
    return { ok: true, credentialRemoved: Boolean(row?.credential_ref) };
  }

  private resourceBytes(resourceId: string): number {
    const row = this.store.sqlite.prepare("SELECT length(CAST(payload_json AS BLOB)) AS bytes FROM resource_revisions WHERE resource_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(resourceId) as { bytes: number } | undefined;
    return row?.bytes ?? 0;
  }

  private noteBytes(objectId: string): number {
    const row = this.store.sqlite.prepare("SELECT payload_json FROM content_objects WHERE id = ?").get(objectId) as { payload_json: string } | undefined;
    return row ? Buffer.byteLength(row.payload_json) : 0;
  }

  private inventoryItemForResource(row: { id: string; title: string; bytes?: number }, grant: ScopeGrant) {
    const bytes = row.bytes ?? this.resourceBytes(row.id);
    return {
      id: row.id,
      kind: "resource" as const,
      title: row.title,
      bytes,
      location: grant.access === "owner" ? this.layout.partitions.resources : undefined,
      hosted: true,
      indexed: true,
      available: true,
      moduleEnabled: this.uiFacets.has("library"),
      status: this.uiFacets.has("library") ? "ready" as const : "disabled" as const,
      revealable: grant.access === "owner",
    };
  }

  private inventorySync(signal: AbortSignal, grant: ScopeGrant) {
    if (signal.aborted) return { generatedAt: new Date().toISOString(), totals: {}, items: [], cancelled: true };
    if (grant.access !== "owner") {
      const resources = grant.readResourceIds.flatMap((id) => {
        const row = this.store.sqlite.prepare("SELECT id, title FROM resources WHERE id = ?").get(id) as { id: string; title: string } | undefined;
        return row ? [this.inventoryItemForResource(row, grant)] : [];
      });
      const notes = grant.writeObjectIds.flatMap((id) => {
        const row = this.store.sqlite.prepare("SELECT id, title FROM content_objects WHERE id = ? AND type = 'notes.document' AND deleted_at IS NULL").get(id) as { id: string; title: string } | undefined;
        return row ? [{ id: row.id, kind: "note" as const, title: row.title, bytes: this.noteBytes(row.id), moduleEnabled: this.uiFacets.has("notes") }] : [];
      });
      return { generatedAt: new Date().toISOString(), items: [...resources, ...notes], totals: { resource: { count: resources.length, bytes: resources.reduce((sum, item) => sum + item.bytes, 0) }, note: { count: notes.length, bytes: notes.reduce((sum, item) => sum + item.bytes, 0) } }, cancelled: false };
    }
    // Byte sizes stay in SQLite. Copying every payload into the process, then painting every row, is what
    // made a 10k library miss the cold-start and click budgets.
    const revisionSizes = this.store.sqlite.prepare("SELECT resource_id AS resourceId, length(CAST(payload_json AS BLOB)) AS bytes, created_at AS createdAt, rowid FROM resource_revisions").all() as Array<{ resourceId: string; bytes: number; createdAt: string; rowid: number }>;
    const latestBytes = new Map<string, { bytes: number; createdAt: string; rowid: number }>();
    for (const row of revisionSizes) {
      const prev = latestBytes.get(row.resourceId);
      if (!prev || row.createdAt > prev.createdAt || (row.createdAt === prev.createdAt && row.rowid > prev.rowid)) latestBytes.set(row.resourceId, row);
    }
    const resources = this.store.sqlite.prepare("SELECT id, title, created_at AS createdAt FROM resources ORDER BY created_at DESC, id DESC").all() as Array<{ id: string; title: string; createdAt: string }>;
    const resourceBytesTotal = resources.reduce((sum, row) => sum + (latestBytes.get(row.id)?.bytes ?? 0), 0);
    const listedResources = resources.slice(0, 100).map((row) => this.inventoryItemForResource({ id: row.id, title: row.title, bytes: latestBytes.get(row.id)?.bytes ?? 0 }, grant));
    const notes = this.store.sqlite.prepare("SELECT id, title FROM content_objects WHERE type='notes.document' AND deleted_at IS NULL").all() as Array<{ id: string; title: string }>;
    const attachmentDir = this.layout.partitions.attachments;
    const attachments = fs.existsSync(attachmentDir) ? fs.readdirSync(attachmentDir).filter((name) => !name.startsWith(".")) : [];
    const indexed = this.store.sqlite.prepare("SELECT id, path, kind, hosted, bytes, file_count AS fileCount FROM indexed_roots").all() as Array<{ id: string; path: string; kind: string; hosted: number; bytes: number; fileCount: number }>;
    const partitionStat = (name: string) => this.store.sqlite.prepare("SELECT bytes, file_count AS fileCount, missing, scanned_at AS scannedAt FROM partition_stats WHERE name = ?").get(name) as { bytes: number; fileCount: number; missing: number; scannedAt: string | null } | undefined;
    const backup = partitionStat("backups") ?? { bytes: 0, fileCount: 0, missing: fs.existsSync(this.layout.partitions.backups) ? 0 : 1, scannedAt: null };
    const cache = partitionStat("cache") ?? { bytes: 0, fileCount: 0, missing: fs.existsSync(this.layout.partitions.cache) ? 0 : 1, scannedAt: null };
    const partitionItems = (["backups", "cache", "attachments", "resources", "downloads", "exports"] as const).map((name) => {
      const location = this.layout.partitions[name];
      const exists = fs.existsSync(location);
      const stats = partitionStat(name);
      return {
        id: name,
        kind: "partition" as const,
        title: name,
        bytes: stats?.bytes ?? 0,
        location,
        hosted: true,
        indexed: false,
        available: exists,
        moduleEnabled: true,
        status: exists ? "ready" as const : "missing" as const,
        revealable: exists,
        scannedAt: stats?.scannedAt ?? null,
        missing: Boolean(stats?.missing) || !exists,
        fileCount: stats?.fileCount ?? 0,
      };
    });
    const items = [
      ...listedResources,
      ...partitionItems,
      ...notes.map((row) => ({
        id: row.id,
        kind: "note" as const,
        title: row.title,
        bytes: this.noteBytes(row.id),
        location: this.layout.partitions.projects,
        hosted: true,
        indexed: true,
        available: true,
        moduleEnabled: this.uiFacets.has("notes"),
        status: this.uiFacets.has("notes") ? "ready" as const : "disabled" as const,
        revealable: true,
      })),
      ...attachments.map((name) => {
        const location = path.join(attachmentDir, name);
        const exists = fs.existsSync(location);
        return {
          id: name,
          kind: "attachment" as const,
          title: name,
          bytes: exists ? fs.statSync(location).size : 0,
          location,
          hosted: true,
          indexed: false,
          available: exists,
          moduleEnabled: true,
          status: exists ? "ready" as const : "missing" as const,
          revealable: exists,
        };
      }),
      ...indexed.map((root) => ({
        id: root.id,
        kind: "indexed-root" as const,
        title: root.path,
        bytes: root.bytes,
        location: root.path,
        hosted: root.hosted === 1,
        indexed: true,
        available: fs.existsSync(root.path),
        moduleEnabled: true,
        status: fs.existsSync(root.path) ? "indexed" as const : "missing" as const,
        revealable: fs.existsSync(root.path),
        fileCount: root.fileCount,
      })),
    ];
    if (signal.aborted) return { generatedAt: new Date().toISOString(), totals: {}, items: [], cancelled: true };
    // Resources past the bounded page stay reachable: the cursor names the next older row for library.list.
    const resourcePagination = {
      resource: {
        total: resources.length,
        listed: listedResources.length,
        nextCursor: resources.length > 100 && listedResources.length
          ? encodeResourceCursor({ createdAt: resources[99]!.createdAt, id: resources[99]!.id })
          : null,
      },
    };
    const totals = {
      resource: { count: resources.length, bytes: resourceBytesTotal },
      note: { count: notes.length, bytes: items.filter((item) => item.kind === "note").reduce((sum, item) => sum + item.bytes, 0) },
      attachment: { count: attachments.length, bytes: items.filter((item) => item.kind === "attachment").reduce((sum, item) => sum + item.bytes, 0) },
      backup: { count: backup.fileCount, bytes: backup.bytes, missing: Boolean(backup.missing), scanned: Boolean(backup.scannedAt) },
      cache: { count: cache.fileCount, bytes: cache.bytes, missing: Boolean(cache.missing), scanned: Boolean(cache.scannedAt) },
      indexedRoot: { count: indexed.length, bytes: indexed.reduce((sum, item) => sum + item.bytes, 0) },
    };
    return { generatedAt: new Date().toISOString(), totals, items, pagination: resourcePagination, cancelled: false };
  }

  private async inventory(signal: AbortSignal, scan: boolean, grant: ScopeGrant) {
    if (!scan) return this.inventorySync(signal, grant);
    const cancelled = () => ({ generatedAt: new Date().toISOString(), totals: {}, items: [], cancelled: true });
    const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
    await yieldTurn();
    if (signal.aborted) return cancelled();
    if (grant.access === "owner") {
      for (const name of ["backups", "cache", "attachments", "resources", "downloads", "exports"] as const) {
        if (signal.aborted) return cancelled();
        const stats = await scanDirectoryBatched(this.layout.partitions[name], signal);
        if (stats.cancelled) return cancelled();
        this.store.sqlite.prepare("INSERT INTO partition_stats(name, bytes, file_count, missing, scanned_at) VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes, file_count=excluded.file_count, missing=excluded.missing, scanned_at=excluded.scanned_at").run(
          name, stats.bytes, stats.fileCount, stats.missing ? 1 : 0, new Date().toISOString(),
        );
      }
      const roots = this.store.sqlite.prepare("SELECT id, path FROM indexed_roots").all() as Array<{ id: string; path: string }>;
      for (const root of roots) {
        if (signal.aborted) return cancelled();
        const stats = await scanDirectoryBatched(root.path, signal);
        if (stats.cancelled) return cancelled();
        this.store.sqlite.prepare("UPDATE indexed_roots SET bytes = ?, file_count = ? WHERE id = ?").run(stats.bytes, stats.fileCount, root.id);
      }
    }
    await yieldTurn();
    if (signal.aborted) return cancelled();
    const result = this.inventorySync(signal, grant);
    await yieldTurn();
    if (signal.aborted) return cancelled();
    return result;
  }

  private indexRootRecord(target: string, kind: string) {
    const stats = directoryStats(target);
    const existing = this.store.sqlite.prepare("SELECT id FROM indexed_roots WHERE path = ?").get(target) as { id: string } | undefined;
    const id = existing?.id ?? createId("idx");
    this.store.sqlite.prepare("INSERT OR REPLACE INTO indexed_roots(id, path, kind, hosted, bytes, file_count, created_at) VALUES (?,?,?,?,?,?,?)").run(
      id, target, kind, 0, stats.bytes, stats.fileCount, new Date().toISOString(),
    );
    return { id, path: target, bytes: stats.bytes, fileCount: stats.fileCount };
  }

  private indexExternalRoot(envelope: CommandEnvelope) {
    this.assertWritable();
    const input = envelope.input as { pathHandle: string; kind?: "novel" | "comic" | "video" | "audio" | "file" };
    const target = this.resolvePath(input.pathHandle);
    if (pathsOverlap(target, this.layout.defaultRoot)) {
      throw new MangaError("PUBLISH_CONFLICT", "indexed external roots cannot overlap the active profile");
    }
    return this.indexRootRecord(target, input.kind ?? "file");
  }

  private revealInventory(envelope: CommandEnvelope) {
    const grant = this.grantOf(envelope);
    if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "only the owner can reveal inventory locations");
    const input = envelope.input as { id: string };
    const overview = this.inventorySync(new AbortController().signal, grant);
    const item = overview.items.find((entry) => entry.id === input.id);
    if (!item || !("location" in item) || !item.location) throw new MangaError("NOT_FOUND", "inventory item missing");
    if (!fs.existsSync(item.location)) throw new MangaError("NOT_FOUND", "inventory location is not available");
    return { id: item.id, path: item.location, kind: item.kind };
  }

  private repairInventory(envelope: CommandEnvelope) {
    this.assertWritable();
    const grant = this.grantOf(envelope);
    if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "only the owner can repair inventory locations");
    const input = envelope.input as { id: string; pathHandle?: string };
    const root = this.store.sqlite.prepare("SELECT id, path, kind FROM indexed_roots WHERE id = ?").get(input.id) as { id: string; path: string; kind: string } | undefined;
    if (root) {
      const next = input.pathHandle ? this.resolvePath(input.pathHandle) : root.path;
      if (pathsOverlap(next, this.layout.defaultRoot)) {
        throw new MangaError("PUBLISH_CONFLICT", "indexed external roots cannot overlap the active profile");
      }
      if (!fs.existsSync(next)) throw new MangaError("NOT_FOUND", "repair target is missing");
      const stats = directoryStats(next);
      this.store.sqlite.prepare("UPDATE indexed_roots SET path = ?, bytes = ?, file_count = ? WHERE id = ?").run(next, stats.bytes, stats.fileCount, root.id);
      return { id: root.id, path: next, repaired: true, kind: "indexed-root", available: true };
    }
    const partition = (LOCATION_PARTITIONS as readonly string[]).includes(input.id) ? input.id as keyof LocationLayout["partitions"] : undefined;
    if (!partition) throw new MangaError("NOT_FOUND", "inventory item missing");
    if (input.pathHandle) {
      throw new MangaError("CAPABILITY_UNAVAILABLE", "per-partition relocation is not available yet; migrate the profile root instead");
    }
    const location = this.layout.partitions[partition];
    fs.mkdirSync(location, { recursive: true });
    const stats = directoryStats(location);
    this.store.sqlite.prepare("INSERT INTO partition_stats(name, bytes, file_count, missing, scanned_at) VALUES (?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET bytes=excluded.bytes, file_count=excluded.file_count, missing=excluded.missing, scanned_at=excluded.scanned_at").run(
      partition, stats.bytes, stats.fileCount, 0, new Date().toISOString(),
    );
    return { id: partition, path: location, repaired: true, kind: "partition", available: true };
  }

  private async transcribeAuthorizedFile(envelope: CommandEnvelope, signal: AbortSignal) {
    this.assertWritable();
    const input = envelope.input as { pathHandle: string; connectionId?: string };
    const file = this.resolvePath(input.pathHandle);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new MangaError("NOT_FOUND", "audio file is not available");
    const connectionId = input.connectionId ?? (this.store.sqlite.prepare("SELECT id FROM provider_connections WHERE purpose = 'transcription' LIMIT 1").get() as { id: string } | undefined)?.id;
    if (!connectionId) throw new MangaError("MODEL_CAPABILITY_MISSING", "no transcription connection is configured");
    const { row, apiKey } = this.secretFor(connectionId, "transcription");
    const bytes = new Uint8Array(fs.readFileSync(file));
    const result = await transcribeAudio(row.base_url, apiKey, {
      model: row.model_id,
      fileName: path.basename(file),
      bytes,
      mimeType: mimeForAudio(file),
      signal,
      timeoutMs: row.timeout_ms,
    });
    return { text: result.text, connectionId: row.id, fileName: path.basename(file) };
  }

  private createSession(envelope: CommandEnvelope) {
    this.assertWritable();
    const input = envelope.input as { title?: string; kind?: "shared" | "resource" | "project"; targetId?: string; mode?: "enthusiast" | "creator" };
    if (input.targetId && !this.grants.canRead(this.grantOf(envelope), input.targetId)) throw new MangaError("SCOPE_DENIED", "session target is outside the authorized set");
    const id = createId("ses");
    const now = new Date().toISOString();
    const kind = input.kind ?? "shared";
    const title = input.title ?? (input.targetId ? this.resourceTitle(input.targetId) ?? "会话" : "会话");
    this.store.sqlite.prepare("INSERT INTO agent_sessions(id, title, grant_handle, kind, target_id, mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, title, envelope.scopeHandle, kind, input.targetId ?? null, input.mode ?? null, now, now);
    return { id, title, kind, targetId: input.targetId ?? null, mode: input.mode ?? null };
  }

  /**
   * Open (or reuse) the session owned by a resource or project. Each session keeps its own agent
   * context, so switching targets never reuses another target's task.
   */
  private openSession(envelope: CommandEnvelope, input: { kind: "resource" | "project" | "note"; targetId: string; mode?: "enthusiast" | "creator"; sessionId?: string }) {
    const grant = this.grantOf(envelope);
    const owner = { kind: "user" as const, id: "desktop-user" };
    void owner;
    if (input.kind === "resource") {
      if (!this.grants.canRead(grant, input.targetId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
      const existing = this.store.sqlite.prepare("SELECT id, title, kind, target_id AS targetId, mode FROM agent_sessions WHERE kind = 'resource' AND target_id = ? AND COALESCE(mode, 'enthusiast') = COALESCE(?, 'enthusiast') ORDER BY updated_at DESC LIMIT 1").get(input.targetId, input.mode ?? null) as { id: string; title: string; kind: string; targetId: string; mode: string | null } | undefined;
      if (existing) {
        // Switching back to a session must not silently change its bound model, runtime or grant.
        this.store.sqlite.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), existing.id);
        return { ...existing, reused: true };
      }
      return { ...this.createSession({ ...envelope, input: { title: this.resourceTitle(input.targetId), kind: "resource", targetId: input.targetId, mode: input.mode } }), reused: false };
    }
    if (input.kind === "note") {
      this.assertNoteAccess(envelope, input.targetId, false);
      const note = readNote(this.store, input.targetId);
      const resourceId = ((note.sources as Array<{ resourceId: string }>)[0]?.resourceId) ?? null;
      // A note session is its own kind, so the left rail opens the note instead of trying to read it as a book.
      const existing = this.store.sqlite.prepare("SELECT id, title, kind, target_id AS targetId, mode FROM agent_sessions WHERE kind = 'note' AND target_id = ? AND COALESCE(mode, 'enthusiast') = COALESCE(?, 'enthusiast') ORDER BY updated_at DESC LIMIT 1").get(input.targetId, input.mode ?? null) as { id: string; title: string; kind: string; targetId: string; mode: string | null } | undefined;
      if (existing) {
        this.store.sqlite.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), existing.id);
        return { ...existing, resourceId, reused: true };
      }
      const id = createId("ses");
      const now = new Date().toISOString();
      this.store.sqlite.prepare("INSERT INTO agent_sessions(id, title, grant_handle, kind, target_id, mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, String(note.title), envelope.scopeHandle, "note", input.targetId, input.mode ?? null, now, now);
      return { id, title: String(note.title), kind: "note", targetId: input.targetId, mode: input.mode ?? null, resourceId, reused: false };
    }
    if (input.kind === "project") {
      // The project workspace arrives in M3. The session identity is already stable: one target and mode, one session.
      const existing = this.store.sqlite.prepare("SELECT id, title, kind, target_id AS targetId, mode FROM agent_sessions WHERE kind = 'project' AND target_id = ? AND COALESCE(mode, 'enthusiast') = COALESCE(?, 'enthusiast') ORDER BY updated_at DESC LIMIT 1").get(input.targetId, input.mode ?? null) as { id: string; title: string; kind: string; targetId: string; mode: string | null } | undefined;
      if (existing) {
        this.store.sqlite.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), existing.id);
        return { ...existing, reused: true };
      }
      return { ...this.createSession({ ...envelope, input: { title: input.targetId, kind: "project", targetId: input.targetId, mode: input.mode } }), reused: false };
    }
    if (input.sessionId) {
      const existing = this.store.sqlite.prepare("SELECT id, title, kind, target_id AS targetId, mode FROM agent_sessions WHERE id = ?").get(input.sessionId) as { id: string; title: string; kind: string; targetId: string; mode: string | null } | undefined;
      if (existing) return { ...existing, reused: true };
    }
    throw new MangaError("VALIDATION_ERROR", "session target is missing");
  }

  private resourceTitle(resourceId: string): string | undefined {
    return (this.store.sqlite.prepare("SELECT title FROM resources WHERE id = ?").get(resourceId) as { title: string } | undefined)?.title;
  }

  private captureMaterials(resourceIds: string[]): Array<{ resourceId: string; revisionId: string; title: string }> {
    return resourceIds.flatMap((resourceId) => {
      const row = this.store.sqlite.prepare("SELECT r.title, v.id AS revisionId FROM resources r JOIN resource_revisions v ON v.resource_id = r.id WHERE r.id = ? ORDER BY v.created_at DESC LIMIT 1").get(resourceId) as { title: string; revisionId: string } | undefined;
      return row ? [{ resourceId, revisionId: row.revisionId, title: row.title }] : [];
    });
  }

  private sendAgent(envelope: CommandEnvelope) {
    this.assertWritable();
    const input = envelope.input as { sessionId: string; text: string; readResourceIds?: string[]; noteObjectIds?: string[]; selection?: { resourceId: string; resourceRevisionId: string; partId?: string; start: number; end: number } };
    const session = this.store.sqlite.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(input.sessionId) as { id: string; grant_handle: string } | undefined;
    if (!session) throw new MangaError("NOT_FOUND", "session missing");
    const runId = createId("run");
    const now = new Date().toISOString();
    const owner = this.grantOf(envelope);
    const requested = (input.readResourceIds ?? []).filter((resourceId) => this.grants.canRead(owner, resourceId));
    const agentGrant = this.issueAgentGrant(owner, { kind: "agent", id: `agent:${runId}` }, { sessionId: session.id, runId, readResourceIds: requested });
    const budget = { maxSteps: 8, maxDurationMs: 60_000, maxContextChars: 16_000, maxOutputChars: 16_000 };
    const runtime = this.currentRuntime();
    const connection = this.store.sqlite.prepare("SELECT id FROM provider_connections WHERE purpose = 'text' LIMIT 1").get() as { id: string } | undefined;
    const history = this.sessionHistoryForNewRun(session.id, Math.max(0, budget.maxContextChars - [...input.text].length));
    const deadlineAt = new Date(Date.now() + budget.maxDurationMs).toISOString();
    const selection = input.selection && this.grants.canRead(owner, input.selection.resourceId)
      ? selectionQuote(this.store, input.selection, readShell(this.store).spoilerGuard)
      : undefined;
    // Notes are captured by revision with their text, so the model sees what the user saw and a later
    // edit cannot silently change the material under a running task.
    type FrozenNote = { objectId: string; revision: number; title: string; text: string; truncated: boolean; blockCount: number; resourceId?: string; resourceRevisionId?: string };
    const notes: FrozenNote[] = (input.noteObjectIds ?? []).flatMap((objectId) => {
      try {
        const note = readNote(this.store, objectId);
        if (!this.grants.canRead(owner, String((note.sources as Array<{ resourceId: string }>)[0]?.resourceId ?? "")) && !this.grants.canWriteObject(owner, objectId) && owner.access !== "owner") return [];
        const document = note.document as { blocks: Array<{ id: string; type: string; text: string }> };
        const text = document.blocks.map((block) => block.text).join("\n");
        const source = (note.sources as Array<{ resourceId: string; revisionId: string; blockId: string | null }>)[0];
        return [{
          objectId,
          revision: Number(note.revision),
          title: String(note.title ?? ""),
          text: text.slice(0, 8000),
          truncated: [...text].length > 8000,
          blockCount: document.blocks.length,
          resourceId: source?.resourceId,
          resourceRevisionId: source?.revisionId,
        }];
      } catch {
        return [];
      }
    });
    const snapshot = {
      materials: this.captureMaterials(requested),
      selection,
      notes,
      capturedAt: now,
      history,
      connectionId: connection?.id ?? null,
      runtime,
    };
    // The frozen context message is built once at send time and stored with the snapshot, so the receipt
    // shows the exact wording the model receives and a retry reuses the same frozen material.
    const contextMessage = this.materialContextMessage(snapshot, budget.maxContextChars);
    const frozen = { ...snapshot, contextText: contextMessage?.content ?? null };
    this.store.commit({
      mutations: [{
        sql: "INSERT INTO agent_runs(id, session_id, status, grant_handle, snapshot_id, budget_json, input_text, read_resource_ids_json, snapshot_json, runtime, deadline_at, live_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params: [runId, session.id, "running", agentGrant.handle, envelope.contextSnapshotId ?? null, JSON.stringify(budget), input.text, JSON.stringify(requested), JSON.stringify(frozen), runtime, deadlineAt, "", now, now],
      }],
      events: [{ type: "agent.run.started", payload: { runId, sessionId: session.id } }],
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
      result: { runId, sessionId: session.id, grantHandle: agentGrant.handle, status: "running", inputText: input.text },
    });
    this.store.sqlite.prepare("INSERT INTO agent_messages(id, run_id, role, text, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(createId("msg"), runId, "user", input.text, JSON.stringify({ kind: "user" }), now);
    this.startRunLoop(runId, agentGrant, input.text, budget, runtime);
    return {
      runId,
      sessionId: session.id,
      grantHandle: agentGrant.handle,
      status: "running",
      inputText: input.text,
      materials: frozen.materials,
      selection,
      noteMaterials: notes.map((note) => ({ objectId: note.objectId, revision: note.revision, title: note.title, blockCount: note.blockCount, truncated: note.truncated, chars: [...note.text].length, preview: [...note.text].slice(0, 120).join("") })),
      contextText: frozen.contextText,
      messages: [{ role: "user", text: input.text }],
    };
  }

  private startRunLoop(runId: string, grant: ScopeGrant, text: string, budget: AgentLoopBudget, runtime: AiRuntimeId) {
    if (this.runAbort.has(runId)) return;
    const controller = new AbortController();
    this.runAbort.set(runId, controller);
    const remaining = this.remainingBudgetMs(runId, budget);
    const deadline = AbortSignal.timeout(remaining);
    const combined = AbortSignal.any([controller.signal, deadline]);
    const finish = (status: "succeeded" | "failed" | "cancelled", column: "usage_json" | "error_json", value: string) => {
      if (this.closed) return;
      this.store.sqlite.prepare(`UPDATE agent_runs SET status = ?, ${column} = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running','waiting_input')`).run(status, value, new Date().toISOString(), runId);
    };
    void this.runAgentLoop(runId, grant, text, combined, budget, runtime).then((result) => {
      finish("succeeded", "usage_json", JSON.stringify({ outputChars: [...(result.text ?? "")].length, costUsd: result.costUsd, steps: result.steps }));
    }).catch((error) => {
      const cancelled = controller.signal.aborted || deadline.aborted;
      const status = cancelled ? (deadline.aborted && !controller.signal.aborted ? "failed" : "cancelled") : "failed";
      const payload = error instanceof MangaError
        ? error.toJSON()
        : { code: "PROVIDER_UNAVAILABLE", message: error instanceof Error ? error.message : String(error), retryable: true, details: {} };
      if (deadline.aborted && !controller.signal.aborted) {
        finish("failed", "error_json", JSON.stringify({ code: "BUDGET_EXCEEDED", message: "agent exceeded max duration", retryable: false, details: {} }));
        return;
      }
      finish(status, "error_json", JSON.stringify(payload));
    }).finally(() => {
      this.runAbort.delete(runId);
    });
  }

  /**
   * Render the frozen snapshot as one system message. Materials carry their revision id so the model
   * can ask for the exact revision it was given, and a note keeps the revision it was frozen at.
   */
  private materialContextMessage(snapshot: {
    materials?: Array<{ resourceId: string; revisionId: string; title: string }>;
    selection?: { resourceId?: string; partId?: string; quote?: string; range?: { start: number; end: number }; blocked?: string } | { blocked?: string };
    notes?: Array<{ objectId: string; revision: number; title: string; text?: string; truncated?: boolean }>;
  }, maxChars: number): ChatMessage | undefined {
    const parts: string[] = [];
    const selection = snapshot.selection as { resourceId?: string; partId?: string; quote?: string; range?: { start: number; end: number }; blocked?: string } | undefined;
    if (selection && !selection.blocked && typeof selection.quote === "string") {
      parts.push(`当前选区（资源 ${selection.resourceId ?? "?"} · 片段 ${selection.partId ?? "?"} · 码点 ${selection.range?.start ?? "?"}-${selection.range?.end ?? "?"}）：\n${selection.quote}`);
    } else if (selection?.blocked) {
      parts.push(`当前选区因防剧透边界未提供（${selection.blocked}）。`);
    }
    for (const material of snapshot.materials ?? []) {
      parts.push(`材料：${material.title}（资源 ${material.resourceId}，修订 ${material.revisionId}）`);
    }
    for (const note of snapshot.notes ?? []) {
      const body = note.text ?? "";
      parts.push(`笔记：${note.title}（对象 ${note.objectId}，修订 ${note.revision}${note.truncated ? "，正文已截断" : ""}）：\n${body}`);
    }
    if (!parts.length) return undefined;
    const joined = parts.join("\n\n");
    return { role: "system", content: `以下是本次任务冻结的材料快照，只能据此作答；需要更多正文时用工具按修订读取。\n\n${joined}`.slice(0, maxChars) };
  }

  private remainingBudgetMs(runId: string, budget: AgentLoopBudget): number {
    const row = this.store.sqlite.prepare("SELECT deadline_at, created_at FROM agent_runs WHERE id = ?").get(runId) as { deadline_at: string | null; created_at: string } | undefined;
    const deadline = row?.deadline_at ? Date.parse(row.deadline_at) : Date.parse(row?.created_at ?? "") + budget.maxDurationMs;
    return Math.max(1, deadline - Date.now());
  }

  private loadRunMessages(runId: string): ChatMessage[] {
    const rows = this.store.sqlite.prepare("SELECT role, text, payload_json FROM agent_messages WHERE run_id = ? ORDER BY created_at").all(runId) as Array<{ role: string; text: string; payload_json: string | null }>;
    const messages: ChatMessage[] = [];
    for (const row of rows) {
      const payload = row.payload_json ? safeJsonValue(row.payload_json) as { toolCalls?: ChatMessage["toolCalls"]; toolCallId?: string } : undefined;
      if (row.role === "tool") messages.push({ role: "tool", content: row.text, toolCallId: payload?.toolCallId });
      else if (row.role === "assistant" && payload?.toolCalls?.length) messages.push({ role: "assistant", content: row.text, toolCalls: payload.toolCalls });
      else if (row.role === "assistant" || row.role === "user" || row.role === "system") messages.push({ role: row.role, content: row.text });
    }
    return messages;
  }

  private persistRunMessage(runId: string, message: ChatMessage) {
    this.store.sqlite.prepare("INSERT INTO agent_messages(id, run_id, role, text, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(
      createId("msg"),
      runId,
      message.role,
      message.content,
      JSON.stringify({ toolCalls: message.toolCalls, toolCallId: message.toolCallId }),
      new Date().toISOString(),
    );
  }

  private async runAgentLoop(runId: string, grant: ScopeGrant, text: string, signal: AbortSignal, budget: AgentLoopBudget, runtime: AiRuntimeId) {
    const runRow = this.store.sqlite.prepare("SELECT snapshot_json, usage_json, checkpoint_json FROM agent_runs WHERE id = ?").get(runId) as { snapshot_json: string | null; usage_json: string | null; checkpoint_json: string | null } | undefined;
    const snapshot = runRow?.snapshot_json ? safeJsonValue(runRow.snapshot_json) as {
      history?: ChatMessage[];
      connectionId?: string | null;
      materials?: Array<{ resourceId: string; revisionId: string; title: string }>;
      selection?: { resourceId?: string; partId?: string; quote?: string; range?: { start: number; end: number } } | { blocked?: string };
      notes?: Array<{ objectId: string; revision: number; title: string; text?: string }>;
      contextText?: string | null;
    } : {};
    const connection = snapshot.connectionId
      ? this.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ?").get(snapshot.connectionId) as ConnectionRow | undefined
      : this.store.sqlite.prepare("SELECT * FROM provider_connections WHERE purpose = 'text' LIMIT 1").get() as ConnectionRow | undefined;
    const tools: ToolDefinition[] = AGENT_COMMANDS.filter((commandId) => grant.allowedCommands.includes(commandId) && this.runtime.gateway.has(commandId)).map((commandId) => ({
      name: commandId,
      description: TOOL_DESCRIPTIONS[commandId] ?? commandId,
      parameters: toolParameters(commandId),
    }));
    if (!connection) {
      const existing = this.store.sqlite.prepare("SELECT id FROM agent_messages WHERE run_id = ? AND role = 'assistant'").get(runId);
      if (!existing) {
        this.store.sqlite.prepare("INSERT INTO agent_messages(id, run_id, role, text, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(createId("msg"), runId, "assistant", "未配置模型。本地查询与笔记命令仍可通过界面使用。", JSON.stringify({ completed: true }), new Date().toISOString());
      }
      return { text: "未配置模型", tools: [] as Array<{ commandId: string; result: unknown }>, steps: 0 };
    }
    if (connection.purpose !== "text") throw new MangaError("MODEL_CAPABILITY_MISSING", "agent runs require a text connection");
    const cred = this.store.sqlite.prepare("SELECT ciphertext FROM credentials WHERE ref = ?").get(connection.credential_ref) as { ciphertext: Buffer } | undefined;
    if (!cred) throw new MangaError("AUTHENTICATION_FAILED", "text connection is missing credentials");
    const apiKey = this.vault.decrypt(cred.ciphertext);
    const protocol = connection.protocol as "openai-responses" | "openai-chat-completions";
    const frozenRuntime = (runtime === "pi" ? "pi" : "native") as AiRuntimeId;
    const clipped = [...text].slice(0, budget.maxContextChars).join("");
    const history = snapshot.history ?? this.sessionHistory(runId, Math.max(0, budget.maxContextChars - [...clipped].length));
    let runMessages = this.loadRunMessages(runId);
    if (!runMessages.some((message) => message.role === "user")) {
      const user: ChatMessage = { role: "user", content: clipped };
      this.persistRunMessage(runId, user);
      runMessages = [...runMessages, user];
    }
    // The frozen materials are what the model may rely on; the request is the last message so the
    // visible material and the user's instruction agree with the snapshot the receipt records.
    // The snapshot keeps the message built at send time, so a retry sends exactly the frozen material.
    const frozenContext = typeof snapshot.contextText === "string" ? snapshot.contextText : undefined;
    const materialMessage = frozenContext ? { role: "system" as const, content: frozenContext } : this.materialContextMessage(snapshot, budget.maxContextChars);
    const messages: ChatMessage[] = [...history, ...(materialMessage ? [materialMessage] : []), ...runMessages];
    const toolResults: Array<{ commandId: string; result: unknown }> = [];
    const usage = runRow?.usage_json ? safeJsonValue(runRow.usage_json) as { costUsd?: number; steps?: number } : {};
    const checkpoint = runRow?.checkpoint_json ? safeJsonValue(runRow.checkpoint_json) as { step?: number; costUsd?: number } : {};
    let costUsd = usage.costUsd ?? checkpoint.costUsd;
    let stepsUsed = typeof checkpoint.step === "number" ? checkpoint.step : messages.filter((message) => message.role === "assistant" && message.toolCalls?.length).length;
    for (let step = stepsUsed; step < budget.maxSteps; step += 1) {
      if (signal.aborted) throw new MangaError("CANCELLED", "run cancelled", { retryable: true });
      if (contextChars(messages) > budget.maxContextChars) throw new MangaError("BUDGET_EXCEEDED", "agent exceeded max context");
      const accumulated = new Map<string, { name: string; arguments: string }>();
      let completed = false;
      let assistant = "";
      for await (const event of streamText(protocol, connection.base_url, apiKey, {
        model: connection.model_id,
        messages,
        tools,
        signal,
        timeoutMs: connection.timeout_ms,
      }, frozenRuntime)) {
        if (event.type === "text-delta") {
          assistant += event.text;
          this.store.sqlite.prepare("UPDATE agent_runs SET live_text = ?, updated_at = ? WHERE id = ?").run(assistant, new Date().toISOString(), runId);
          if ([...assistant].length > budget.maxOutputChars) throw new MangaError("BUDGET_EXCEEDED", "agent exceeded max output");
        }
        if (event.type === "tool-call-delta") {
          const current = accumulated.get(event.callId) ?? { name: event.name, arguments: "" };
          current.name = event.name || current.name;
          current.arguments += event.argumentsDelta;
          accumulated.set(event.callId, current);
        }
        if (event.type === "completed") {
          completed = true;
          if (event.usage && "costUsd" in event.usage && typeof event.usage.costUsd === "number") {
            costUsd = (costUsd ?? 0) + event.usage.costUsd;
          }
        }
        if (event.type === "error") throw new MangaError("PROVIDER_UNAVAILABLE", event.message, { retryable: event.retryable });
      }
      if (budget.maxCostUsd !== undefined && costUsd !== undefined && costUsd > budget.maxCostUsd) {
        throw new MangaError("BUDGET_EXCEEDED", "agent exceeded max cost");
      }
      if (!accumulated.size) {
        this.persistRunMessage(runId, { role: "assistant", content: assistant });
        return { text: assistant, tools: toolResults, completed, costUsd, steps: step + 1 };
      }
      if (!completed) throw new MangaError("PROVIDER_UNAVAILABLE", "stream ended before the provider completed the tool call", { retryable: true });
      for (const [callId, call] of accumulated) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(call.arguments);
        } catch {
          throw new MangaError("VALIDATION_ERROR", "tool arguments were incomplete or invalid");
        }
        if (parsed && typeof parsed === "object") {
          for (const banned of ["actor", "scopeHandle", "path", "targetDir", "sourceDir", "pathHandle"]) {
            if (banned in (parsed as object)) throw new MangaError("FORBIDDEN", "model cannot set trusted authorization fields");
          }
        }
        const commandId = call.name;
        if (!grant.allowedCommands.includes(commandId) || !this.runtime.gateway.has(commandId)) {
          this.store.sqlite.prepare("INSERT INTO agent_tool_events(id, run_id, command_id, status, input_summary, created_at) VALUES (?,?,?,?,?,?)").run(createId("tool"), runId, commandId, "denied", call.arguments.slice(0, 200), new Date().toISOString());
          throw new MangaError("FORBIDDEN", `tool ${commandId} is not admitted`);
        }
        const prior = this.store.sqlite.prepare("SELECT result_summary FROM agent_tool_events WHERE run_id = ? AND command_id = ? AND status = 'executed' ORDER BY created_at LIMIT 1").get(runId, commandId) as { result_summary: string | null } | undefined;
        let result: CommandResult;
        if (prior?.result_summary) {
          result = safeJsonValue(prior.result_summary) as CommandResult;
        } else {
          const inputHash = createHash("sha256").update(JSON.stringify(parsed ?? {})).digest("hex");
          result = await this.call(grant.actor, {
            commandId,
            idempotencyKey: `${runId}:${commandId}:${inputHash}`,
            input: parsed,
          }, grant.handle);
          this.store.sqlite.prepare("INSERT INTO agent_tool_events(id, run_id, command_id, status, input_summary, result_summary, created_at) VALUES (?,?,?,?,?,?,?)").run(
            createId("tool"), runId, commandId, result.status === "ok" ? "executed" : "failed", call.arguments.slice(0, 200), JSON.stringify(result).slice(0, 8000), new Date().toISOString(),
          );
        }
        toolResults.push({ commandId, result });
        const assistantCall: ChatMessage = { role: "assistant", content: "", toolCalls: [{ id: callId, name: commandId, arguments: call.arguments }] };
        const toolMessage: ChatMessage = { role: "tool", toolCallId: callId, content: JSON.stringify(result) };
        this.persistRunMessage(runId, assistantCall);
        this.persistRunMessage(runId, toolMessage);
        messages.push(assistantCall, toolMessage);
        if (contextChars(messages) > budget.maxContextChars) throw new MangaError("BUDGET_EXCEEDED", "agent exceeded max context");
      }
      this.store.sqlite.prepare("UPDATE agent_runs SET usage_json = ?, checkpoint_json = ?, updated_at = ? WHERE id = ?").run(
        JSON.stringify({ costUsd, steps: step + 1 }),
        JSON.stringify({ step: step + 1, costUsd }),
        new Date().toISOString(),
        runId,
      );
    }
    throw new MangaError("BUDGET_EXCEEDED", "agent exceeded max steps");
  }

  private sessionHistoryForNewRun(sessionId: string, maxChars: number): ChatMessage[] {
    if (maxChars <= 0) return [];
    const earlier = this.store.sqlite.prepare("SELECT id, input_text FROM agent_runs WHERE session_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 50").all(sessionId) as Array<{ id: string; input_text: string }>;
    const history: ChatMessage[] = [];
    let chars = 0;
    for (const run of earlier) {
      const reply = (this.store.sqlite.prepare("SELECT text FROM agent_messages WHERE run_id = ? AND role = 'assistant' ORDER BY created_at").all(run.id) as Array<{ text: string }>).map((row) => row.text).filter(Boolean).join("\n");
      const turn: ChatMessage[] = [{ role: "user", content: run.input_text }, ...(reply ? [{ role: "assistant" as const, content: reply }] : [])];
      const size = contextChars(turn);
      if (chars + size > maxChars) break;
      chars += size;
      history.unshift(...turn);
    }
    return history;
  }

  /** Frozen snapshot history is preferred; this remains for runs created before checkpoints existed. */
  private sessionHistory(runId: string, maxChars: number): ChatMessage[] {
    const current = this.store.sqlite.prepare("SELECT session_id, created_at FROM agent_runs WHERE id = ?").get(runId) as { session_id: string; created_at: string } | undefined;
    if (!current || maxChars <= 0) return [];
    return this.sessionHistoryForNewRun(current.session_id, maxChars).filter((message, index, all) => {
      // Drop the current run's own user line if it was included by created_at ordering on older rows.
      return !(message.role === "user" && index === all.length - 1 && message.content === "");
    });
  }

  private cancelRun(envelope: CommandEnvelope) {
    this.assertWritable();
    const input = envelope.input as { runId: string };
    const live = this.runAbort.get(input.runId);
    live?.abort();
    const changed = this.store.sqlite.prepare("UPDATE agent_runs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued','running','waiting_input')").run(new Date().toISOString(), input.runId).changes;
    return { cancelled: Boolean(live) || changed > 0 };
  }

  private retryRun(envelope: CommandEnvelope) {
    this.assertWritable();
    const input = envelope.input as { runId: string };
    const run = this.store.sqlite.prepare("SELECT * FROM agent_runs WHERE id = ?").get(input.runId) as {
      id: string;
      session_id: string;
      status: string;
      grant_handle: string;
      input_text: string;
      budget_json: string;
      runtime: string | null;
    } | undefined;
    if (!run) throw new MangaError("NOT_FOUND", "run missing");
    if (run.status === "running" || run.status === "queued" || run.status === "waiting_input") {
      throw new MangaError("VALIDATION_ERROR", "run is still in progress");
    }
    if (run.status === "succeeded") {
      return { runId: run.id, sessionId: run.session_id, grantHandle: run.grant_handle, status: "succeeded" };
    }
    const grant = this.grants.get(run.grant_handle);
    if (!grant) throw new MangaError("FORBIDDEN", "original run authorization is no longer available");
    const budget = JSON.parse(run.budget_json) as AgentLoopBudget;
    const runtime = (run.runtime === "pi" ? "pi" : "native") as AiRuntimeId;
    this.store.sqlite.prepare("UPDATE agent_runs SET status = 'running', error_json = NULL, updated_at = ? WHERE id = ?").run(new Date().toISOString(), run.id);
    this.startRunLoop(run.id, grant, run.input_text, budget, runtime);
    return { runId: run.id, sessionId: run.session_id, grantHandle: run.grant_handle, status: "running", inputText: run.input_text };
  }

  private getRun(envelope: CommandEnvelope) {
    const input = envelope.input as { runId: string };
    const row = this.store.sqlite.prepare("SELECT id, session_id, status, grant_handle, input_text, error_json, budget_json, usage_json, snapshot_json, runtime, read_resource_ids_json, live_text, deadline_at, created_at, updated_at FROM agent_runs WHERE id = ?").get(input.runId) as {
      id: string;
      session_id: string;
      status: string;
      grant_handle: string;
      input_text: string;
      error_json: string | null;
      budget_json: string;
      usage_json: string | null;
      snapshot_json: string | null;
      runtime: string | null;
      read_resource_ids_json: string | null;
      live_text: string | null;
      deadline_at: string | null;
      created_at: string;
      updated_at: string;
    } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "run missing");
    const toolRows = this.store.sqlite.prepare("SELECT command_id, status, input_summary, result_summary FROM agent_tool_events WHERE run_id = ? ORDER BY created_at").all(input.runId) as Array<{ command_id: string; status: string; input_summary: string; result_summary: string | null }>;
    const messages = this.store.sqlite.prepare("SELECT role, text, payload_json FROM agent_messages WHERE run_id = ? ORDER BY created_at").all(input.runId) as Array<{ role: string; text: string; payload_json: string | null }>;
    const tools = toolRows.map((item) => ({
      commandId: item.command_id,
      status: item.status,
      result: item.result_summary ? safeJsonValue(item.result_summary) : undefined,
    }));
    const assistantText = messages.filter((item) => item.role === "assistant").map((item) => item.text).filter(Boolean).join("\n");
    const text = assistantText || row.live_text || "";
    return {
      runId: row.id,
      sessionId: row.session_id,
      grantHandle: row.grant_handle,
      status: row.status,
      inputText: row.input_text,
      runtime: row.runtime === "pi" ? "pi" : "native",
      error: row.error_json ? safeJsonValue(row.error_json) : undefined,
      budget: safeJsonValue(row.budget_json),
      usage: row.usage_json ? safeJsonValue(row.usage_json) : undefined,
      snapshot: row.snapshot_json ? safeJsonValue(row.snapshot_json) : undefined,
      readResourceIds: row.read_resource_ids_json ? safeJsonValue(row.read_resource_ids_json) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deadlineAt: row.deadline_at,
      liveText: row.live_text,
      run: {
        id: row.id,
        sessionId: row.session_id,
        status: row.status,
        inputText: row.input_text,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
      tools,
      messages,
      text,
      // The visible material receipt: exactly what was frozen for this run, with revisions.
      materials: (safeJsonValue(row.snapshot_json ?? "{}") as { materials?: unknown[] }).materials ?? [],
      selection: (safeJsonValue(row.snapshot_json ?? "{}") as { selection?: unknown }).selection,
      // The frozen system message, so the model request can be checked against what the user was shown.
      contextText: (safeJsonValue(row.snapshot_json ?? "{}") as { contextText?: string | null }).contextText ?? null,
      capturedAt: (safeJsonValue(row.snapshot_json ?? "{}") as { capturedAt?: string }).capturedAt ?? null,
      noteMaterials: ((safeJsonValue(row.snapshot_json ?? "{}") as { notes?: Array<{ objectId: string; revision: number; title: string; text?: string; blockCount?: number; truncated?: boolean }> }).notes ?? []).map((note) => ({
        objectId: note.objectId,
        revision: note.revision,
        title: note.title,
        blockCount: note.blockCount,
        truncated: Boolean(note.truncated),
        chars: [...(note.text ?? "")].length,
        preview: [...(note.text ?? "")].slice(0, 120).join(""),
      })),
    };
  }

  private assertNoteAccess(envelope: CommandEnvelope, objectId: string, write: boolean): void {
    const grant = this.grantOf(envelope);
    if (write) {
      if (!this.grants.canWriteObject(grant, objectId) && grant.access !== "owner") throw new MangaError("SCOPE_DENIED", "object is outside the authorized set");
      return;
    }
    if (grant.access === "owner") return;
    if (this.grants.canWriteObject(grant, objectId)) return;
    const linked = this.store.sqlite.prepare("SELECT resource_id FROM text_fragments WHERE object_id = ? AND resource_id IS NOT NULL LIMIT 1").get(objectId) as { resource_id?: string } | undefined;
    if (!linked?.resource_id || !this.grants.canRead(grant, linked.resource_id)) throw new MangaError("SCOPE_DENIED", "note is outside the authorized set");
  }

  private noteOp(envelope: CommandEnvelope, kind: "split" | "merge" | "move" | "copy" | "replace" | "insert" | "remove" | "setType" | "rename") {
    this.assertWritable();
    const input = envelope.input as { objectId: string; expectedRevision: number; blockId?: string; offset?: number; toIndex?: number; atIndex?: number; blockType?: string; level?: number; ordered?: boolean; text?: string; blocks?: NoteDocument["blocks"]; title?: string; tags?: string[] };
    this.assertNoteAccess(envelope, input.objectId, true);
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
                    ? { type: "replace" as const, blocks: (readNote(this.store, input.objectId).document as NoteDocument).blocks }
                    : { type: "copy" as const, blockId: input.blockId ?? "" };
    return commitNoteOp(this.store, {
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

  private async parseIncoming(signal: AbortSignal, input: { bytes?: Uint8Array; filePath?: string; format?: "txt" | "epub" | "mobi" | "pdf" | "auto"; encoding?: "utf-8" | "utf-16le" }): Promise<ParsedDocument> {
    const generation = this.parseGeneration;
    try {
      const parsed = this.parseWorker
        ? await this.parseWorker.parse({
          kind: "document",
          bytes: input.filePath ? undefined : [...(input.bytes ?? [])],
          filePath: input.filePath,
          format: input.format,
          encoding: input.encoding,
          signal,
        }) as ParsedDocument
        : await parseDocument(input.bytes ?? new Uint8Array(fs.readFileSync(input.filePath ?? "")), { format: input.format, encoding: input.encoding, signal });
      if (signal.aborted || generation !== this.parseGeneration) throw new MangaError("CANCELLED", "parse result discarded after deactivate or cancel");
      return decodeWorkerAssets(parsed);
    } catch (error) {
      if (error instanceof MangaError) throw error;
      if (signal.aborted || generation !== this.parseGeneration) throw new MangaError("CANCELLED", "parse cancelled");
      const code = (error as { code?: string }).code;
      const message = error instanceof Error ? error.message : String(error);
      if (code === "PATH_ESCAPE" || code === "UNSUPPORTED_FORMAT" || code === "VALIDATION_ERROR" || code === "CANCELLED") {
        throw new MangaError(code, message);
      }
      throw error instanceof Error ? error : new MangaError("UNSUPPORTED_FORMAT", message);
    }
  }

  private async importDocument(envelope: CommandEnvelope, signal: AbortSignal) {
    const input = envelope.input as { title: string; bytes?: number[]; pathHandle?: string; format?: "txt" | "epub" | "mobi" | "pdf" | "auto"; encoding?: "utf-8" | "utf-16le"; hosted?: boolean };
    const sourcePath = input.pathHandle ? this.resolvePath(input.pathHandle) : undefined;
    if (sourcePath && (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile())) throw new MangaError("NOT_FOUND", "document file is not available");
    const bytes = sourcePath ? new Uint8Array(fs.readFileSync(sourcePath)) : Uint8Array.from(input.bytes ?? []);
    const parsed = await this.parseIncoming(signal, sourcePath ? { filePath: sourcePath, format: input.format, encoding: input.encoding } : { bytes, format: input.format, encoding: input.encoding });
    this.assertWritable();
    return await persistParsedDocument(this.store, {
      title: input.title,
      bytes,
      parsed,
      sourcePath,
      hosted: input.hosted === true,
      idempotencyKey: envelope.idempotencyKey,
      commandId: envelope.commandId,
    });
  }

  private readOriginal(envelope: CommandEnvelope) {
    const grant = this.grantOf(envelope);
    if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "only the owner can read original bytes");
    const input = envelope.input as { resourceId: string; revisionId?: string };
    if (!this.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
    const snapshot = grant.runId ? this.snapshotRevision(grant.runId, input.resourceId) : undefined;
    if (snapshot && input.revisionId && snapshot !== input.revisionId) throw new MangaError("REVISION_CONFLICT", "requested material revision differs from the run snapshot");
    return readOriginal(this.store, input.resourceId, snapshot ?? input.revisionId);
  }

  private readResource(envelope: CommandEnvelope) {
    const grant = this.grantOf(envelope);
    const input = envelope.input as { resourceId: string; revisionId?: string };
    if (!this.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
    const snapshot = grant.runId ? this.snapshotRevision(grant.runId, input.resourceId) : undefined;
    if (snapshot && input.revisionId && snapshot !== input.revisionId) throw new MangaError("REVISION_CONFLICT", "requested material revision differs from the run snapshot");
    const document = readDocument(this.store, input.resourceId, snapshot ?? input.revisionId);
    const slice = document.slice as { partId: string; start: number; end: number; textLayer: boolean } | null;
    if (slice?.textLayer) this.assertConsumedRange(grant, input.resourceId, String(document.revisionId), slice.partId, slice.start, slice.end);
    return document;
  }

  private readResourceSlice(envelope: CommandEnvelope) {
    const grant = this.grantOf(envelope);
    const input = envelope.input as { resourceId: string; revisionId?: string; partId: string; start?: number; limit?: number };
    if (!this.grants.canRead(grant, input.resourceId)) throw new MangaError("SCOPE_DENIED", "resource is outside the authorized set");
    const snapshot = grant.runId ? this.snapshotRevision(grant.runId, input.resourceId) : undefined;
    if (snapshot && input.revisionId && snapshot !== input.revisionId) throw new MangaError("REVISION_CONFLICT", "requested material revision differs from the run snapshot");
    const slice = readSlice(this.store, { ...input, revisionId: snapshot ?? input.revisionId });
    if (slice.textLayer) this.assertConsumedRange(grant, input.resourceId, String(slice.revisionId), input.partId, Number(slice.start), Number(slice.end));
    return slice;
  }

  private assertConsumedRange(grant: ScopeGrant, resourceId: string, resourceRevisionId: string, partId: string, start: number, end: number): void {
    if (grant.access === "owner" || !readShell(this.store).spoilerGuard) return;
    const range = selectionQuote(this.store, { resourceId, resourceRevisionId, partId, start, end }, true);
    if (range.blocked) throw new MangaError("SCOPE_DENIED", "requested range is outside consumed progress");
  }

  private async repairSource(envelope: CommandEnvelope, signal: AbortSignal) {
    this.assertWritable();
    const grant = this.grantOf(envelope);
    if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "only the owner can repair a source file");
    const input = envelope.input as { resourceId: string; pathHandle: string };
    const sourcePath = this.resolvePath(input.pathHandle);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) throw new MangaError("NOT_FOUND", "replacement file is not available");
    const bytes = new Uint8Array(fs.readFileSync(sourcePath));
    const parsed = await parseDocument(bytes, { signal });
    return await persistParsedDocument(this.store, {
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

  recoverPackage(action: "recover" | "rollback") {
    this.assertWritable();
    return this.recoverJobs(action);
  }
}


const TOOL_DESCRIPTIONS: Record<string, string> = {
  "library.find": "在已授权的资源中检索文本片段，返回命中的片段与资源 ID。",
  "library.list": "分页列出全库资源，可按书名搜索；返回总数与下一页游标。",
  "library.getResource": "读取一个已授权资源的最新修订正文。",
  "library.read": "按资源与修订读取指定片段的一段正文。",
  "library.contextSnapshot": "按资源修订与码点范围读取一段引用上下文。",
  "source.card": "读取一个资源的来源卡片（标题、修订、可用性与命中片段）。",
  "notes.create": "创建一条新的笔记；可关联一个已授权的资源 ID。",
  "notes.update": "按修订更新一条笔记中某个块或单块笔记的正文。",
  "notes.get": "按对象 ID 读取一条笔记的块、标签与来源。",
  "notes.list": "列出当前授权范围内的笔记摘要；可按文本、标签或资源筛选。",
  "notes.undo": "撤销本次任务创建的笔记的上一次修改。",
  "inventory.overview": "读取资源、笔记与附件的总览统计。",
};

function toolParameters(commandId: string): Record<string, unknown> {
  return commandInputJsonSchema(commandId) ?? { type: "object", additionalProperties: false, properties: {} };
}

/** Opaque keyset cursor over (created_at, id), so pages stay stable while the library grows. */
function encodeResourceCursor(row: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify({ a: row.createdAt, i: row.id }), "utf8").toString("base64url");
}

function decodeResourceCursor(cursor: string): { createdAt: string; id: string } | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { a?: unknown; i?: unknown };
    if (typeof parsed.a !== "string" || typeof parsed.i !== "string" || !parsed.a || !parsed.i) return undefined;
    return { createdAt: parsed.a, id: parsed.i };
  } catch {
    return undefined;
  }
}

function codePointSafeEnd(text: string, start: number): number {
  return Math.min(start + 240, [...text].length);
}

type AgentLoopBudget = { maxSteps: number; maxDurationMs: number; maxContextChars: number; maxOutputChars: number; maxCostUsd?: number };

type ConnectionRow = {
  id: string;
  purpose: "text" | "transcription" | "embedding";
  protocol: "openai-responses" | "openai-chat-completions";
  runtime: string | null;
  base_url: string;
  model_id: string;
  timeout_ms: number;
  credential_ref: string | null;
};

function contextChars(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => {
    const calls = message.toolCalls?.reduce((inner, call) => inner + [...call.arguments].length + call.name.length, 0) ?? 0;
    return sum + [...message.content].length + calls;
  }, 0);
}

function mimeForAudio(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".webm") return "audio/webm";
  return "application/octet-stream";
}

function safeJsonValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Restore base64 asset payloads that crossed the line-delimited JSON worker boundary. */
function decodeWorkerAssets(parsed: ParsedDocument): ParsedDocument {
  if (!parsed.assets?.length) return parsed;
  return {
    ...parsed,
    assets: parsed.assets.map((asset) => {
      const encoded = asset as ParsedAsset & { bytesEncoding?: string; bytes: Uint8Array | string };
      if (encoded.bytesEncoding === "base64" && typeof encoded.bytes === "string") {
        return { ...asset, bytes: new Uint8Array(Buffer.from(encoded.bytes, "base64")) };
      }
      return asset;
    }),
  };
}
