/** The settings module: runtime, storage layout and its relocation. */
import fs from "node:fs";
import path from "node:path";
import { MangaError, LOCATION_PARTITIONS, createId, type CommandEnvelope, type LocationLayout } from "@manga/contracts";
import { DrizzleStore } from "@manga/storage-drizzle";
import { defineModule, type MangaModule } from "@manga/plugin-sdk";
import type { AiRuntimeId } from "@manga/model-protocol";
import { readShell, writeShell } from "../reading-service.ts";
import { comparablePath } from "../domain/file-ownership.ts";
import { recoverOrRollback } from "../domain/library-package.ts";
import { assertSafeMigrationTarget, copyOwnedFile, fingerprintTree, listCopyFiles, persistPointer, persistPointerAt, writeRelocationMarker } from "../locations.ts";
import { readAgentSettings, writeAgentSettings } from "../agent-settings.ts";
import { readMediaSettings, readRecordingSettings, writeMediaSettings, writeRecordingSettings } from "../voice/settings.ts";
import { usageQuery } from "../ops/usage.ts";
import { recordsList } from "../ops/records.ts";
import { QuickTaskService } from "../quick-tasks.ts";
import type { MangaProductApp } from "../product-app.ts";
import { INDEXABLE_PARTITIONS } from "../product-helpers.ts";
import { listConnections, upsertConnection, testConnection, deleteConnection, setProfile, probeConnection } from "./connections.ts";
import { indexRootRecord } from "./inventory.ts";

/** What these commands use of the application. */
export type SettingsHost = Pick<MangaProductApp, "assertWritable" | "covers" | "debugContext" | "grantOf" | "interruptRuns" | "layout" | "listModules" | "pendingRecoveryJobs" | "publicLayout" | "queryLog" | "quickTasks" | "resolvePath" | "runtime" | "scanAbort" | "screenshots" | "sealed" | "secrets" | "setModule" | "store" | "trace" | "uiFacets" | "vault" | "workFolders">;

export function settingsModule(app: SettingsHost): MangaModule {
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
        app.uiFacets.add("settings");
        ctx.register({ kind: "subscription", id: `settings-ui-${ctx.epoch}`, dispose: () => {
          app.uiFacets.delete("settings");
        } });
      }
      app.runtime.registerCommand("manga.settings", "settings.get", () => settingsSnapshot(app));
      app.runtime.registerCommand("manga.settings", "settings.skipAi", () => {
        app.assertWritable();
        app.store.setMeta("aiSkipped", "1");
        return { skipped: true };
      });
      app.runtime.registerCommand("manga.settings", "settings.proposeLocations", (envelope) => {
        app.assertWritable();
        return proposeLocations(app, envelope);
      });
      app.runtime.registerCommand("manga.settings", "settings.applyLocations", (envelope) => applyLocations(app, envelope));
      app.runtime.registerCommand("manga.settings", "settings.recoverJobs", (envelope) => {
        // A sealed host no longer owns the authoritative library; its stale job rows must not drive deletions.
        app.assertWritable();
        const input = envelope.input as { action: "recover" | "rollback" };
        return recoverJobs(app, input.action);
      });
      app.runtime.registerCommand("manga.settings", "settings.setRuntime", (envelope) => setRuntime(app, envelope));
      app.runtime.registerCommand("manga.settings", "settings.setLayout", (envelope) => setLayout(app, envelope));
      app.runtime.registerCommand("manga.settings", "settings.getShell", () => readShell(app.store));
      app.runtime.registerCommand("manga.settings", "settings.setShell", (envelope) => {
        app.assertWritable();
        return writeShell(app.store, readShell(app.store), envelope.input as Parameters<typeof writeShell>[2], envelope);
      });
      app.runtime.registerCommand("manga.settings", "settings.getRecording", () => readRecordingSettings(app.store));
      app.runtime.registerCommand("manga.settings", "settings.setRecording", (envelope) => {
        app.assertWritable();
        return writeRecordingSettings(app.store, envelope.input as Parameters<typeof writeRecordingSettings>[1]);
      });
      app.runtime.registerCommand("manga.settings", "settings.getModules", () => app.listModules());
      app.runtime.registerCommand("manga.settings", "settings.setModule", (envelope) => app.setModule(envelope));
      app.runtime.registerCommand("manga.settings", "settings.getMedia", () => readMediaSettings(app.store));
      app.runtime.registerCommand("manga.settings", "settings.setMedia", (envelope) => {
        app.assertWritable();
        return writeMediaSettings(app.store, envelope.input as Parameters<typeof writeMediaSettings>[1]);
      });
      app.runtime.registerCommand("manga.settings", "quickTasks.list", (envelope) => app.quickTasks.list(envelope.input as Parameters<QuickTaskService["list"]>[0]));
      app.runtime.registerCommand("manga.settings", "quickTasks.save", (envelope) => {
        app.assertWritable();
        return { task: app.quickTasks.save(envelope.input as Parameters<QuickTaskService["save"]>[0]) };
      });
      app.runtime.registerCommand("manga.settings", "quickTasks.delete", (envelope) => {
        app.assertWritable();
        return app.quickTasks.delete((envelope.input as { id: string }).id);
      });
      app.runtime.registerCommand("manga.settings", "quickTasks.reorder", (envelope) => {
        app.assertWritable();
        return app.quickTasks.reorder((envelope.input as { ids: string[] }).ids);
      });
      app.runtime.registerCommand("manga.settings", "quickTasks.restore", (envelope) => {
        app.assertWritable();
        return app.quickTasks.restore((envelope.input as { builtinKey?: string }).builtinKey);
      });
      app.runtime.registerCommand("manga.settings", "log.query", (envelope) => app.queryLog(envelope));
      app.runtime.registerCommand("manga.settings", "usage.query", (envelope) => usageQuery(app.store, envelope.input as Parameters<typeof usageQuery>[1]));
      app.runtime.registerCommand("manga.settings", "records.list", (envelope) => recordsList(app.store, envelope.input as Parameters<typeof recordsList>[1]));
      app.runtime.registerCommand("manga.settings", "debug.context", (envelope) => app.debugContext(envelope));
      app.runtime.registerCommand("manga.settings", "connections.list", () => listConnections(app));
      app.runtime.registerCommand("manga.settings", "connections.upsert", (envelope) => upsertConnection(app, envelope));
      app.runtime.registerCommand("manga.settings", "connections.test", (envelope, signal) => testConnection(app, envelope, signal));
      app.runtime.registerCommand("manga.settings", "connections.delete", (envelope) => deleteConnection(app, envelope));
      app.runtime.registerCommand("manga.settings", "connections.setProfile", (envelope) => setProfile(app, envelope));
      app.runtime.registerCommand("manga.settings", "connections.probe", (envelope, signal) => probeConnection(app, envelope, signal));
      app.runtime.registerCommand("manga.settings", "settings.getAgent", () => readAgentSettings(app.store));
      app.runtime.registerCommand("manga.settings", "settings.setAgent", (envelope) => {
        app.assertWritable();
        const saved = writeAgentSettings(app.store, envelope.input as Parameters<typeof writeAgentSettings>[1]);
        // A shorter time or a smaller size applies at once to what is already kept.
        app.trace.prune();
        return saved;
      });
      app.runtime.registerCommand("manga.settings", "agent.trace.list", (envelope) => ({ entries: app.trace.list((envelope.input as { runId: string }).runId) }));
      app.runtime.registerCommand("manga.settings", "agent.trace.get", (envelope) => {
        const input = envelope.input as { entryId: string; part: "request" | "response"; offset?: number; limit?: number };
        return app.trace.get(input.entryId, input.part, input.offset ?? 0, input.limit ?? 16 * 1024);
      });
      app.runtime.registerCommand("manga.settings", "agent.trace.export", (envelope) => app.trace.export((envelope.input as { runId: string }).runId));
      app.runtime.registerCommand("manga.settings", "agent.trace.stats", () => app.trace.stats());
      app.runtime.registerCommand("manga.settings", "agent.trace.clear", () => {
        app.assertWritable();
        return app.trace.clear();
      });
    },
    deactivate: () => undefined,
  });
}

export function settingsSnapshot(app: SettingsHost) {
  return {
    layout: app.publicLayout(),
    pointerPath: app.layout.pointerPath,
    layoutConfig: app.store.getMeta("layoutConfig") ? JSON.parse(app.store.getMeta("layoutConfig")!) : { pointerPath: app.layout.pointerPath, partitions: app.layout.overrides },
    aiSkipped: app.store.getMeta("aiSkipped") === "1",
    aiRuntime: currentRuntime(app),
    vaultAvailable: app.vault.available(),
    connections: listConnections(app),
    recoveryJobs: app.pendingRecoveryJobs(),
    restartRequired: app.sealed,
    needsSetup: app.store.getMeta("aiSkipped") !== "1" && listConnections(app).length === 0,
    shell: readShell(app.store),
  };
}

export function currentRuntime(app: SettingsHost): AiRuntimeId {
  const saved = app.store.getMeta("aiRuntime");
  return saved === "pi" ? "pi" : "native";
}

export function setRuntime(app: SettingsHost, envelope: CommandEnvelope) {
  app.assertWritable();
  const input = envelope.input as { runtime: AiRuntimeId };
  app.store.setMeta("aiRuntime", input.runtime);
  return { runtime: input.runtime };
}

export function setLayout(app: SettingsHost, envelope: CommandEnvelope) {
  app.assertWritable();
  const input = envelope.input as { pointerPathHandle?: string; partitions?: Partial<Record<string, string>> };
  if (input.partitions && Object.keys(input.partitions).length) {
    throw new MangaError("CAPABILITY_UNAVAILABLE", "per-partition relocation is not available yet; save a pointer location or migrate the whole profile root");
  }
  if (!input.pointerPathHandle) throw new MangaError("VALIDATION_ERROR", "layout update requires a pointer path handle");
  const nextPointer = app.resolvePath(input.pointerPathHandle);
  if (path.extname(nextPointer) && path.extname(nextPointer).toLowerCase() !== ".json") {
    throw new MangaError("VALIDATION_ERROR", "pointer path must be a json file or directory");
  }
  const pointerFile = fs.existsSync(nextPointer) && fs.statSync(nextPointer).isDirectory()
    ? path.join(nextPointer, "pointer.json")
    : nextPointer;
  const previous = app.layout.pointerPath;
  persistPointerAt(app.layout, pointerFile);
  if (comparablePath(previous) !== comparablePath(pointerFile) && fs.existsSync(previous)) {
    fs.writeFileSync(previous, `${JSON.stringify({ redirectedTo: pointerFile, channel: app.layout.channel, revision: app.layout.revision }, null, 2)}\n`);
  }
  app.layout.pointerPath = pointerFile;
  app.store.setMeta("layoutConfig", JSON.stringify({ pointerPath: pointerFile, partitions: app.layout.overrides }));
  return { pointerPath: pointerFile, partitions: app.layout.partitions, restartRequired: false };
}

export function recoverJobs(app: SettingsHost, action: "recover" | "rollback") {
  const outcome = recoverOrRollback(app.store, action, app.layout.defaultRoot);
  if (action !== "recover" || !outcome.recovered.length) return outcome;
  for (const jobId of outcome.recovered) {
    const job = app.store.sqlite.prepare("SELECT payload_json FROM recovery_jobs WHERE id = ?").get(jobId) as { payload_json: string } | undefined;
    if (!job) continue;
    const payload = JSON.parse(job.payload_json) as { copies: Array<{ partition: string; source: string; target: string; indexedOnly?: boolean }>; targetRoot?: string; verified?: Array<{ partition: string; bytes: number; fingerprint: string }> };
    if (!payload.targetRoot) continue;
    publishRelocatedLibrary(app, jobId, { copies: payload.copies, targetRoot: payload.targetRoot }, payload.verified ?? []);
  }
  return { ...outcome, restartRequired: app.sealed };
}

export function proposeLocations(app: SettingsHost, envelope: CommandEnvelope) {
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
  const targetRoot = app.resolvePath(input.pathHandle);
  assertSafeMigrationTarget(app.layout.defaultRoot, targetRoot);
  const copies = LOCATION_PARTITIONS.map((partition) => {
    const source = app.layout.partitions[partition];
    const fp = fingerprintTree(source);
    return { partition, source, target: path.join(targetRoot, partition), bytes: fp.bytes, fingerprint: fp.hash, indexedOnly: indexedOnly.has(partition) };
  });
  app.store.sqlite.prepare("INSERT INTO recovery_jobs(id, kind, stage, status, staging_path, payload_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(
    checkpointId, "location-migrate", "planned", "planned", null, JSON.stringify({ copies, targetRoot, liveRoot: app.layout.defaultRoot }), new Date().toISOString(), new Date().toISOString(),
  );
  return { checkpointId, copies };
}

export function applyLocations(app: SettingsHost, envelope: CommandEnvelope) {
  app.assertWritable();
  const input = envelope.input as { checkpointId: string; pathHandle?: string };
  const job = app.store.sqlite.prepare("SELECT payload_json, status FROM recovery_jobs WHERE id = ?").get(input.checkpointId) as { payload_json: string; status: string } | undefined;
  if (!job) throw new MangaError("NOT_FOUND", "migration checkpoint missing");
  const payload = JSON.parse(job.payload_json) as { copies: Array<{ partition: string; source: string; target: string; indexedOnly?: boolean }>; targetRoot?: string; liveRoot?: string };
  if (job.status !== "planned") throw new MangaError("VALIDATION_ERROR", "migration checkpoint was already applied or abandoned", { details: { status: job.status } });
  // A partition-only plan has no root; applying it with an arbitrary handle would point the launcher at a partition directory.
  if (!payload.targetRoot) throw new MangaError("CAPABILITY_UNAVAILABLE", "checkpoint has no root target; per-partition relocation is not available yet");
  const targetRoot = input.pathHandle ? app.resolvePath(input.pathHandle) : payload.targetRoot;
  if (path.resolve(payload.targetRoot) !== path.resolve(targetRoot)) throw new MangaError("VALIDATION_ERROR", "checkpoint was planned for a different target");
  assertSafeMigrationTarget(app.layout.defaultRoot, targetRoot);
  for (const copy of payload.copies) {
    if (copy.indexedOnly) continue;
    const dest = path.resolve(copy.target);
    if (fs.existsSync(dest) && fs.readdirSync(dest).length) throw new MangaError("PUBLISH_CONFLICT", "location target must be empty");
  }
  // Runs still in flight would keep writing into the library that is about to be abandoned.
  app.interruptRuns("profile location changed while the run was in progress");
  // Index-only partitions stay where they are; the record must land before the checkpoint so the copied database carries it.
  for (const copy of payload.copies) {
    if (copy.indexedOnly) indexRootRecord(app, copy.source, "file");
  }
  const checkpoint = app.store.sqlite.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number; log: number; checkpointed: number }>;
  if (checkpoint[0]?.busy || (checkpoint[0] && checkpoint[0].log !== checkpoint[0].checkpointed)) {
    throw new MangaError("LOCATION_UNAVAILABLE", "database is busy; retry the migration", { retryable: true });
  }
  app.store.sqlite.prepare("UPDATE recovery_jobs SET status = 'running', stage = 'copy', updated_at = ? WHERE id = ?").run(new Date().toISOString(), input.checkpointId);
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
        app.store.sqlite.prepare("INSERT OR REPLACE INTO migration_owned_files(job_id, partition, relative_path, absolute_path, state, fingerprint) VALUES (?,?,?,?,?,?)").run(
          input.checkpointId, copy.partition, relative, targetFile, "planned", null,
        );
        app.store.sqlite.prepare("UPDATE migration_owned_files SET state = 'copying' WHERE job_id = ? AND partition = ? AND relative_path = ?").run(input.checkpointId, copy.partition, relative);
        const hash = copyOwnedFile(file.absolutePath, targetFile);
        app.store.sqlite.prepare("UPDATE migration_owned_files SET state = 'committed', fingerprint = ? WHERE job_id = ? AND partition = ? AND relative_path = ?").run(hash, input.checkpointId, copy.partition, relative);
      }
      const expected = fingerprintTree(copy.source);
      const actual = fingerprintTree(dest);
      if (actual.hash !== expected.hash) throw new MangaError("VALIDATION_ERROR", `copied ${copy.partition} does not match its source`, { details: { partition: copy.partition } });
      verified.push({ partition: copy.partition, bytes: actual.bytes, fingerprint: actual.hash });
      app.store.maybeCrash("location-copy");
    }
  } catch (error) {
    // Owned rows stay so recoverJobs can remove exactly what app job produced.
    app.store.sqlite.prepare("UPDATE recovery_jobs SET status = 'failed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), input.checkpointId);
    throw error;
  }
  app.store.maybeCrash("location-verify");
  return publishRelocatedLibrary(app, input.checkpointId, { ...payload, targetRoot }, verified);
}

export function publishRelocatedLibrary(app: SettingsHost, jobId: string, payload: { copies: Array<{ partition: string; source: string; target: string; indexedOnly?: boolean }>; targetRoot: string }, verified: Array<{ partition: string; bytes: number; fingerprint: string }>) {
  const targetRoot = payload.targetRoot;
  app.store.maybeCrash("location-publish");
  const targetData = path.join(targetRoot, "data");
  if (fs.existsSync(path.join(targetData, "manga.sqlite"))) {
    const remote = new DrizzleStore({ profileDir: targetData, hostId: "migrate-target", attachmentsDir: path.join(targetRoot, "attachments"), resourcesDir: path.join(targetRoot, "resources"), worksDir: path.join(targetRoot, "works") });
    try {
      remote.sqlite.prepare("UPDATE recovery_jobs SET status = 'succeeded', stage = 'done', payload_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...payload, verified }), new Date().toISOString(), jobId);
      remote.sqlite.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      remote.close();
    }
  }
  app.store.maybeCrash("location-commit");
  app.store.sqlite.prepare("UPDATE recovery_jobs SET status = 'succeeded', stage = 'done', payload_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ ...payload, verified }), new Date().toISOString(), jobId);
  app.store.setMeta("relocatedRoot", targetRoot);
  writeRelocationMarker(app.layout.defaultRoot, targetRoot);
  persistPointer({
    ...app.layout,
    defaultRoot: targetRoot,
    partitions: Object.fromEntries(LOCATION_PARTITIONS.map((name) => [name, path.join(targetRoot, name)])) as LocationLayout["partitions"],
  }, () => app.store.maybeCrash("location-pointer"));
  app.store.maybeCrash("location-switch");
  app.sealed = true;
  return { ok: true, root: targetRoot, restartRequired: true, verified };
}
