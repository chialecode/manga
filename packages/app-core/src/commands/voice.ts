/** The voice module and the model ports it and the semantic index use. */
import fs from "node:fs";
import path from "node:path";
import { MangaError, type AsrEngineSelection, type CommandEnvelope, type DictationStopReason, type ScopeGrant } from "@manga/contracts";
import { effectiveProfile } from "@manga/contracts/models";
import { defineModule, type MangaModule } from "@manga/plugin-sdk";
import { completeText, type AiRuntimeId } from "@manga/model-protocol";
import { readCredential } from "../credentials.ts";
import { decodeRetainedRange } from "../voice/audio-files.ts";
import type { ExternalAsrConnectionConfig } from "../voice/engine/index.ts";
import { VOICE_MODULE } from "../voice/ids.ts";
import type { PolishLlmClient } from "../voice/polish/index.ts";
import type { LlmPort } from "../voice/ports.ts";
import { promptLimitFor, readRecordingSettings } from "../voice/settings.ts";
import { embedTexts } from "../semantic/http.ts";
import type { EmbeddingPort } from "../semantic/ports.ts";
import type { MangaProductApp } from "../product-app.ts";
import { type ConnectionRow, mimeForAudio } from "../product-helpers.ts";
import { secretFor } from "./connections.ts";
import { createDraftNote } from "./notes.ts";

/** What these commands use of the application. */
export type VoiceHost = Pick<
  MangaProductApp,
  | "asrEngine"
  | "asrModels"
  | "assertWritable"
  | "bangumiClient"
  | "closed"
  | "covers"
  | "debugContext"
  | "dictation"
  | "dictationHistory"
  | "dictationLearn"
  | "grantOf"
  | "grants"
  | "interruptRuns"
  | "layout"
  | "listModules"
  | "localAsr"
  | "media"
  | "notify"
  | "pendingRecoveryJobs"
  | "polisher"
  | "projects"
  | "publicLayout"
  | "queryLog"
  | "quickTasks"
  | "resolveCaptureEngine"
  | "resolveDictationEngine"
  | "resolvePath"
  | "resolvePathFor"
  | "runtime"
  | "scanAbort"
  | "screenshots"
  | "sealed"
  | "secrets"
  | "setModule"
  | "store"
  | "trace"
  | "uiFacets"
  | "vault"
  | "voice"
  | "workFolders"
>;

export function resolveSyncExternalAsrConnection(
  app: Pick<MangaProductApp, "store">,
  connectionId: string,
): ExternalAsrConnectionConfig | null {
  const row = app.store.sqlite
    .prepare("SELECT * FROM provider_connections WHERE id = ? AND purpose = 'transcription'")
    .get(connectionId) as (ConnectionRow & { label?: string }) | undefined;
  if (!row || !row.credential_ref) return null;
  const verified = JSON.parse(String(row.verified_capabilities_json || "[]")) as string[];
  const profile = effectiveProfile(row.profile_json, verified);
  const settings = readRecordingSettings(app.store);
  return {
    id: row.id,
    name: row.label,
    baseUrl: row.base_url,
    apiKey: "",
    model: row.model_id,
    transcriptionInterface: profile.transcriptionInterface,
    timeoutMs: row.timeout_ms,
    promptChars: promptLimitFor(settings, row.id),
  };
}

export async function resolveExternalAsrConnection(
  app: Pick<MangaProductApp, "store" | "vault" | "secrets">,
  connectionId: string,
): Promise<ExternalAsrConnectionConfig | null> {
  const row = app.store.sqlite
    .prepare("SELECT * FROM provider_connections WHERE id = ? AND purpose = 'transcription'")
    .get(connectionId) as (ConnectionRow & { label?: string }) | undefined;
  if (!row) return null;
  const verified = JSON.parse(String(row.verified_capabilities_json || "[]")) as string[];
  const profile = effectiveProfile(row.profile_json, verified);
  const settings = readRecordingSettings(app.store);
  const apiKey = row.credential_ref ? ((await readCredential(app, row.credential_ref)) ?? "") : "";
  return {
    id: row.id,
    name: row.label,
    baseUrl: row.base_url,
    apiKey,
    model: row.model_id,
    transcriptionInterface: profile.transcriptionInterface,
    timeoutMs: row.timeout_ms,
    promptChars: promptLimitFor(settings, row.id),
  };
}

export function llmPort(app: Pick<MangaProductApp, "store" | "vault" | "secrets" | "assertWritable" | "covers" | "debugContext" | "grantOf" | "interruptRuns" | "layout" | "listModules" | "notify" | "pendingRecoveryJobs" | "publicLayout" | "queryLog" | "quickTasks" | "resolvePath" | "runtime" | "scanAbort" | "screenshots" | "sealed" | "setModule" | "trace" | "uiFacets" | "workFolders">): LlmPort {
  return {
    resolve: (connectionId) => {
      const row = (connectionId
        ? app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ? AND purpose IN ('text', 'vision')").get(connectionId)
        : app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE purpose = 'text' AND credential_ref IS NOT NULL ORDER BY created_at, rowid LIMIT 1").get()) as ConnectionRow | undefined;
      return row?.credential_ref ? { id: row.id, model: row.model_id, timeoutMs: row.timeout_ms } : null;
    },
    complete: async (connection, request) => {
      const { row, apiKey } = await secretFor(app, connection.id, ["text", "vision"]);
      const answer = await completeText(row.protocol as "openai-responses" | "openai-chat-completions", row.base_url, apiKey, {
        model: row.model_id,
        messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
        temperature: request.temperature,
        signal: request.signal,
        timeoutMs: request.timeoutMs ?? row.timeout_ms,
      }, (row.runtime === "pi" ? "pi" : "native") as AiRuntimeId);
      return answer.text;
    },
  };
}

export function polishLlmClient(port: LlmPort): PolishLlmClient {
  return {
    resolve: (connectionId) => port.resolve(connectionId ?? undefined),
    complete: async (connection, request) => ({
      text: await port.complete(connection, {
        system: request.system,
        user: request.user,
        temperature: request.temperature,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      }),
    }),
  };
}

/** Embedding connections the user configured, with a credential; the first one is used when the settings name none. */
export function embeddingPort(app: VoiceHost): EmbeddingPort {
  const rows = () => app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE purpose = 'embedding' AND credential_ref IS NOT NULL ORDER BY created_at, rowid").all() as Array<ConnectionRow & { label: string }>;
  return {
    resolve: (connectionId) => {
      const list = rows();
      const row = connectionId ? list.find((item) => item.id === connectionId) : list[0];
      return row ? { id: row.id, model: row.model_id, label: row.label } : null;
    },
    list: () => rows().map((row) => ({ id: row.id, model: row.model_id, label: row.label })),
    embed: async (connection, request) => {
      const { row, apiKey } = await secretFor(app, connection.id, "embedding");
      return embedTexts(row.base_url, apiKey, { model: row.model_id, inputs: request.inputs, signal: request.signal, timeoutMs: row.timeout_ms });
    },
  };
}

export function voiceModule(app: VoiceHost): MangaModule {
  const moduleId = VOICE_MODULE;
  const owner = (envelope: CommandEnvelope): ScopeGrant => {
    const grant = app.grantOf(envelope);
    if (grant.access !== "owner") throw new MangaError("FORBIDDEN", "recording is the owner's");
    return grant;
  };
  return defineModule({
    manifest: {
      moduleId,
      version: "1.0.0",
      displayName: "语音记录",
      featureId: "voice",
      contributes: [{ capabilityId: "manga.voice", version: "1.0.0" }],
      needs: [{ capabilityId: "manga.library", version: "1.0.0", cardinality: "single", required: true }],
      facets: ["service", "ui"],
      conflictsWith: [],
      ownerModuleIds: [],
    },
    activate: (ctx) => {
      if ((ctx.hostFacets ?? []).includes("ui")) {
        app.uiFacets.add("voice");
        ctx.register({ kind: "subscription", id: `voice-ui-${ctx.epoch}`, dispose: () => { app.uiFacets.delete("voice"); } });
      }
      app.voice.bind(() => ctx.isCurrent());
      app.dictation.bind(() => ctx.isCurrent());
      // The module only counts as current once activation has finished, so picking up unfinished recordings waits for that.
      const resume = setTimeout(() => { if (!app.closed && ctx.isCurrent()) app.voice.recover(); }, 0);
      // Recording, filtering and uploads belong to app activation: turning the module off saves what was recorded and ends the rest.
      ctx.register({
        kind: "ipc",
        id: `voice-work-${ctx.epoch}`,
        dispose: () => {
          clearTimeout(resume);
          app.media.handles.bumpGeneration(moduleId);
          app.dictation.deactivate();
          app.voice.dictionary.cancelAllEnrich();
          void app.voice.shutdown("deactivated").catch(() => undefined);
          app.media.jobs.cancelWhere((job) => job.owner === moduleId);
        },
      });
      const call = <T>(envelope: CommandEnvelope, work: () => T, options: { write?: boolean } = {}): T => {
        owner(envelope);
        if (options.write !== false) app.assertWritable();
        return work();
      };
      const reg = (commandId: string, handler: (envelope: CommandEnvelope, signal: AbortSignal) => unknown) => app.runtime.registerCommand(moduleId, commandId, handler);
      const input = <T>(envelope: CommandEnvelope) => envelope.input as T;
      reg("capture.start", (envelope) => call(envelope, () => app.voice.start(input(envelope))));
      reg("capture.append", (envelope) => call(envelope, () => {
        const value = input<{ sessionId: string; seq: number; data: string }>(envelope);
        return app.voice.append(value.sessionId, value.seq, value.data);
      }));
      reg("capture.event", (envelope) => call(envelope, () => app.voice.event(input(envelope))));
      reg("capture.stop", async (envelope) => {
        const value = call(envelope, () => input<{ sessionId: string; reason?: "user"; durationMs?: number }>(envelope));
        const view = await app.voice.stop(value);
        // Per-chunk request records are of no use once the recording has ended.
        app.store.sqlite.prepare("DELETE FROM command_requests WHERE command_id IN ('capture.append','capture.event') AND idempotency_key LIKE ? ESCAPE '\\'").run(`cap:${value.sessionId.replace(/[\\%_]/g, "\\$&")}:%`);
        return view;
      });
      reg("capture.status", (envelope) => call(envelope, () => app.voice.status(input<{ sessionId?: string }>(envelope).sessionId), { write: false }));
      reg("capture.list", (envelope) => call(envelope, () => app.voice.list(input(envelope)), { write: false }));
      reg("capture.review", (envelope) => call(envelope, () => app.voice.review(input<{ sessionId: string }>(envelope).sessionId), { write: false }));
      reg("capture.transcribe", (envelope) => call(envelope, () => {
        const value = input<{ sessionId: string; connectionId?: string }>(envelope);
        const row = app.voice.row(value.sessionId);
        if (row.stage === "recording") throw new MangaError("VALIDATION_ERROR", "stop the recording first", { details: { reason: "recording" } });
        void app.voice.pipeline.schedule(value.sessionId, { connectionId: value.connectionId, retryFailed: true });
        return app.voice.view(app.voice.row(value.sessionId));
      }));
      reg("capture.retry", (envelope) => call(envelope, () => {
        const value = input<{ sessionId: string; segmentId?: string }>(envelope);
        void app.voice.pipeline.retry(value.sessionId, value.segmentId);
        return app.voice.view(app.voice.row(value.sessionId));
      }));
      reg("capture.cancel", (envelope) => call(envelope, () => app.voice.cancel(input<{ sessionId: string }>(envelope).sessionId)));
      reg("capture.organize", (envelope) => call(envelope, () => {
        const value = input<{ sessionId: string; connectionId?: string; projectId?: string }>(envelope);
        // The project's glossary goes to the model with the work's dictionary.
        const extra = value.projectId ? app.projects.terms(value.projectId).map((item) => item.term) : undefined;
        // The draft is written in the background: the command returns the draft row at once and the transcript stays readable.
        const running = app.voice.organizer.organize(value.sessionId, value.connectionId, extra);
        void running.catch(() => undefined);
        return { drafts: app.voice.organizer.list(value.sessionId) };
      }));
      reg("capture.editDraft", (envelope) => call(envelope, () => {
        const value = input<{ draftId: string; editedText: string }>(envelope);
        return app.voice.organizer.edit(value.draftId, value.editedText);
      }));
      reg("capture.acceptDraft", (envelope) => call(envelope, () => {
        const value = input<{ draftId: string; editedText?: string; title?: string }>(envelope);
        const prepared = app.voice.organizer.prepareAccept(value.draftId, value);
        if (prepared.existing) return { objectId: prepared.existing, duplicate: true };
        return createDraftNote(app, envelope, value.draftId, prepared);
      }));
      reg("capture.retain", async (envelope) => {
        const value = call(envelope, () => input<{ sessionId: string; action: "keep" | "discard" }>(envelope));
        return app.voice.retain(value.sessionId, value.action);
      });
      reg("capture.reviseSegment", (envelope) => call(envelope, () => {
        const value = input<{ segmentId: string; text: string }>(envelope);
        return app.voice.reviseSegment(value.segmentId, value.text);
      }));
      reg("capture.calibrate", (envelope) => call(envelope, () => app.voice.calibrate(input(envelope))));
      reg("capture.terms", (envelope) => call(envelope, () => app.voice.terms(input<{ workId: string }>(envelope).workId), { write: false }));
      reg("capture.addTerm", (envelope) => call(envelope, () => {
        const value = input<{ workId: string; term: string; heard?: string }>(envelope);
        const out = app.voice.addTerm(value.workId, value.term, value.heard);
        app.notify("dictionary.changed", { workId: value.workId });
        return out;
      }));
      reg("capture.removeTerm", (envelope) => call(envelope, () => {
        const value = input<{ workId: string; term: string }>(envelope);
        const out = app.voice.removeTerm(value.workId, value.term);
        app.notify("dictionary.changed", { workId: value.workId });
        return out;
      }));
      reg("capture.audioHandle", (envelope) => call(envelope, () => app.voice.audioHandle(input<{ sessionId: string }>(envelope).sessionId), { write: false }));

      // In-app voice dictation (`dictation.*`, owner-only).
      reg("dictation.start", (envelope) => call(envelope, () => app.dictation.start(input(envelope)), { write: false }));
      reg("dictation.append", (envelope) => call(envelope, () => app.dictation.append(input(envelope)), { write: false }));
      reg("dictation.stop", async (envelope) => {
        const value = call(envelope, () => input<{ dictationId: string; reason?: DictationStopReason }>(envelope));
        const snap = await app.dictation.stop(value);
        app.store.sqlite.prepare("DELETE FROM command_requests WHERE command_id = 'dictation.append' AND idempotency_key LIKE ? ESCAPE '\\'").run(`dic:${value.dictationId.replace(/[\\%_]/g, "\\$&")}:%`);
        return snap;
      });
      reg("dictation.cancel", (envelope) => call(envelope, () => {
        const value = input<{ dictationId?: string }>(envelope);
        const activeId = value.dictationId ?? app.dictation.status()?.dictationId;
        const snap = app.dictation.cancel(value.dictationId);
        if (activeId) {
          app.store.sqlite.prepare("DELETE FROM command_requests WHERE command_id = 'dictation.append' AND idempotency_key LIKE ? ESCAPE '\\'").run(`dic:${activeId.replace(/[\\%_]/g, "\\$&")}:%`);
        }
        return snap ?? { cancelled: false };
      }, { write: false }));
      reg("dictation.status", (envelope) => call(envelope, () => app.dictation.status(input<{ dictationId?: string }>(envelope).dictationId), { write: false }));

      reg("dictation.history.list", (envelope) => call(envelope, () => app.dictationHistory.list(input(envelope)), { write: false }));
      reg("dictation.history.delete", (envelope) => call(envelope, () => {
        const value = input<{ historyId: string }>(envelope);
        const out = app.dictationHistory.delete(value.historyId);
        app.notify("dictation.changed", { historyDeleted: value.historyId });
        return out;
      }));
      reg("dictation.history.clear", (envelope) => call(envelope, () => {
        const out = app.dictationHistory.clear();
        app.notify("dictation.changed", { historyCleared: true });
        return out;
      }));
      reg("dictation.history.retranscribe", async (envelope) => {
        const value = call(envelope, () => input<{ historyId: string; engine: AsrEngineSelection }>(envelope));
        const item = await app.dictation.retranscribeHistory(value.historyId, value.engine);
        app.notify("dictation.changed", { historyRetranscribed: value.historyId });
        return item;
      });

      // Local offline ASR model catalog, download, import and deletion (`asrModel.*`, owner-only).
      reg("asrModel.list", (envelope) => call(envelope, () => {
        const models = app.asrModels.list();
        return { models, items: models };
      }, { write: false }));
      reg("asrModel.download", async (envelope, signal) => {
        const value = call(envelope, () => input<{ modelId: string; confirmed: true; sourceId?: string }>(envelope));
        if (value.confirmed !== true) {
          throw new MangaError("VALIDATION_ERROR", "下载本地语音模型前必须先确认体积与许可协议");
        }
        try {
          const item = await app.asrModels.download({
            modelId: value.modelId,
            confirmed: true,
            sourceId: value.sourceId,
            signal,
          });
          app.notify("asrModel.changed", { modelId: value.modelId, state: item.state });
          return item;
        } catch (error) {
          if (error instanceof MangaError && error.code === "CANCELLED") {
            const item = app.asrModels.getItem(value.modelId);
            app.notify("asrModel.changed", { modelId: value.modelId, state: item.state });
            return item;
          }
          try {
            app.notify("asrModel.changed", { modelId: value.modelId, state: app.asrModels.getItem(value.modelId).state });
          } catch { /* ignore unknown modelId */ }
          throw error;
        }
      });
      reg("asrModel.pause", async (envelope) => {
        const value = call(envelope, () => input<{ modelId: string }>(envelope));
        const item = await app.asrModels.pause(value.modelId);
        app.notify("asrModel.changed", { modelId: value.modelId, state: item.state });
        return item;
      });
      reg("asrModel.cancel", async (envelope) => {
        const value = call(envelope, () => input<{ modelId: string }>(envelope));
        const item = await app.asrModels.cancel(value.modelId);
        app.notify("asrModel.changed", { modelId: value.modelId, state: item.state });
        return item;
      });
      reg("asrModel.import", async (envelope, signal) => {
        const value = call(envelope, () => input<{ modelId: string; pathHandle: string; kind: "archive" | "directory" }>(envelope));
        const sourcePath = app.resolvePathFor(value.pathHandle, value.kind === "directory" ? ["directory"] : ["file"]);
        const item = await app.asrModels.importModel({
          modelId: value.modelId,
          sourcePath,
          kind: value.kind,
          signal,
        });
        app.notify("asrModel.changed", { modelId: value.modelId, state: item.state });
        return item;
      });
      reg("asrModel.delete", async (envelope) => {
        const value = call(envelope, () => input<{ modelId: string }>(envelope));
        const out = await app.asrModels.delete(value.modelId);
        app.notify("asrModel.changed", { modelId: value.modelId, state: "not_installed", deleted: out.deleted });
        return out;
      });

      // The voice dictionary: terms for every recording and terms for one work (A-66, M12).
      const dictionary = app.voice.dictionary;
      reg("dictionary.list", (envelope) => call(envelope, () => {
        const value = input<{ scope?: "global" | "work"; workId?: string }>(envelope);
        return { ...dictionary.list(value), promptChars: readRecordingSettings(app.store).promptChars };
      }, { write: false }));
      reg("dictionary.removedWorks", (envelope) => call(envelope, () => ({ works: dictionary.removedWorks() }), { write: false }));
      reg("dictionary.add", (envelope) => call(envelope, () => {
        const out = dictionary.add(input(envelope));
        app.notify("dictionary.changed", { termId: out.id });
        return out;
      }));
      reg("dictionary.update", (envelope) => call(envelope, () => {
        const out = dictionary.update(input(envelope));
        app.notify("dictionary.changed", { termId: out.id });
        return out;
      }));
      reg("dictionary.remove", (envelope) => call(envelope, () => {
        const termId = input<{ termId: string }>(envelope).termId;
        const out = dictionary.remove(termId);
        app.notify("dictionary.changed", { termId });
        return out;
      }));
      reg("dictionary.importBatch", (envelope) => call(envelope, () => {
        const value = input<{ scope: "global" | "work"; workId?: string; text: string; category?: "work" | "character" | "actor" | "term" | "other" }>(envelope);
        const out = dictionary.importBatch(value);
        app.notify("dictionary.changed", { scope: value.scope, workId: value.workId ?? null, added: out.added });
        return out;
      }));
      reg("dictionary.importMetadata", async (envelope, signal) => {
        const value = call(envelope, () => input<{ workId: string; enrichDetails?: boolean; refresh?: boolean }>(envelope));
        if (value.enrichDetails) {
          const submitted = app.media.jobs.submit({
            lane: "net",
            kind: "dictionary-enrich",
            key: `dictionary-enrich:${value.workId}`,
            owner: moduleId,
            run: ({ signal: jobSignal, progress }) => dictionary.enrichFromBangumi({
              workId: value.workId,
              client: app.bangumiClient,
              refresh: value.refresh,
              signal: AbortSignal.any([signal, jobSignal]),
              onProgress: (p) => {
                if (p.total > 0) progress(p.completed / p.total);
                app.notify("dictionary.importProgress", {
                  workId: p.workId,
                  done: p.completed,
                  completed: p.completed,
                  total: p.total,
                  requestsSent: p.requestsSent,
                  cachedHits: p.cachedHits,
                });
              },
            }),
          });
          const result = await submitted.promise;
          if (!result.linked) throw new MangaError("VALIDATION_ERROR", "link the work to a source before taking names from it", { details: { reason: "not-linked" } });
          app.notify("dictionary.changed", { workId: value.workId, added: result.added });
          return { workId: value.workId, ...result };
        }
        const result = dictionary.syncFromMetadata(value.workId);
        if (!result.linked) throw new MangaError("VALIDATION_ERROR", "link the work to a source before taking names from it", { details: { reason: "not-linked" } });
        app.notify("dictionary.changed", { workId: value.workId, added: result.added });
        return { workId: value.workId, ...result };
      });
      reg("dictionary.cancelImportMetadata", (envelope) => call(envelope, () => {
        const { workId } = input<{ workId: string }>(envelope);
        const cancelled = dictionary.cancelEnrich(workId);
        app.media.jobs.cancelWhere((job) => job.key === `dictionary-enrich:${workId}`);
        return { workId, cancelled };
      }, { write: false }));
      reg("dictionary.observeEdit", (envelope) => call(envelope, () => {
        const out = app.dictationLearn.observeEdit(input(envelope));
        if (out.suggestion) app.notify("dictionary.changed", { suggestionId: out.suggestion.id });
        return out;
      }));
      reg("dictionary.suggestions.list", (envelope) => call(envelope, () => {
        const out = app.dictationLearn.list(input(envelope));
        return { items: out.items, suggestions: out.items };
      }, { write: false }));
      reg("dictionary.suggestions.decide", (envelope) => call(envelope, () => {
        const out = app.dictationLearn.decide(input(envelope));
        app.notify("dictionary.changed", { suggestionId: out.suggestion.id, status: out.suggestion.status });
        return out;
      }));
      // What a block of audio of app work would be sent with, and how much of the dictionary did not fit.
      reg("dictionary.prompt", (envelope) => call(envelope, () => {
        const settings = readRecordingSettings(app.store);
        const connection = app.voice.asr.resolve();
        const limit = promptLimitFor(settings, connection?.id);
        const built = dictionary.prompt(input<{ workId?: string }>(envelope).workId ?? null, limit);
        return { ...built, connectionId: connection?.id ?? null, language: settings.language };
      }, { write: false }));
    },
    deactivate: () => {
      app.media.handles.bumpGeneration(moduleId);
      app.dictation.deactivate();
      app.voice.dictionary.cancelAllEnrich();
    },
  });
}

export type TranscribeFileHost = Pick<
  MangaProductApp,
  | "assertWritable"
  | "covers"
  | "debugContext"
  | "grantOf"
  | "interruptRuns"
  | "layout"
  | "listModules"
  | "media"
  | "notify"
  | "pendingRecoveryJobs"
  | "publicLayout"
  | "queryLog"
  | "quickTasks"
  | "resolvePath"
  | "runtime"
  | "scanAbort"
  | "screenshots"
  | "sealed"
  | "secrets"
  | "setModule"
  | "store"
  | "trace"
  | "uiFacets"
  | "vault"
  | "voice"
  | "workFolders"
> &
  Partial<Pick<MangaProductApp, "asrEngine" | "asrModels" | "localAsr" | "resolveCaptureEngine">>;

export async function transcribeAuthorizedFile(app: TranscribeFileHost, envelope: CommandEnvelope, signal: AbortSignal) {
  app.assertWritable();
  const input = envelope.input as { pathHandle: string; workId: string; connectionId?: string };
  const original = app.resolvePath(input.pathHandle);
  if (!fs.existsSync(original) || !fs.statSync(original).isFile()) throw new MangaError("NOT_FOUND", "audio file is not available");
  if (!app.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(input.workId)) throw new MangaError("NOT_FOUND", "work missing");

  const settings = readRecordingSettings(app.store);
  let selection: AsrEngineSelection | null = null;
  if (input.connectionId) {
    if (input.connectionId.startsWith("local:")) {
      selection = { kind: "local", modelId: input.connectionId.slice("local:".length) };
    } else if (app.asrModels?.getCatalog().some((item) => item.modelId === input.connectionId)) {
      selection = { kind: "local", modelId: input.connectionId };
    } else {
      selection = { kind: "connection", connectionId: input.connectionId };
    }
  } else if (app.resolveCaptureEngine) {
    selection = app.resolveCaptureEngine();
  } else {
    const first = app.store.sqlite.prepare("SELECT id FROM provider_connections WHERE purpose = 'transcription' AND credential_ref IS NOT NULL LIMIT 1").get() as { id: string } | undefined;
    selection = first ? { kind: "connection", connectionId: first.id } : null;
  }

  if (!selection) {
    throw new MangaError("MODEL_CAPABILITY_MISSING", "no transcription connection is configured", {
      details: { reason: "asr_unconfigured", setupHint: "settings.voice" },
    });
  }

  // Validate engine availability before importing the audio copy into the work folder so failed preflight leaves no orphan copy.
  if (selection.kind === "connection") {
    await secretFor(app, selection.connectionId, "transcription");
  } else {
    if (!app.asrModels || !app.localAsr) {
      throw new MangaError("CAPABILITY_UNAVAILABLE", "本地语音识别运行环境未就绪", {
        details: { reason: "local_runtime_unavailable", modelId: selection.modelId, setupHint: "settings.voice" },
      });
    }
    app.asrModels.getRuntimeFiles(selection.modelId);
    const status = app.localAsr.getModelStatus(selection.modelId);
    if (status.status === "load_failed") {
      throw new MangaError("CAPABILITY_UNAVAILABLE", status.reason ?? "本地语音识别模型载入失败", {
        details: { reason: "model_load_failed", modelId: selection.modelId, setupHint: "settings.voice" },
      });
    }
  }

  // The audio comes into the folder of the work first and is transcribed from there; the file the person picked is not touched (A-79).
  const copy = app.workFolders.put(input.workId, { kind: "audio-import", fileName: path.basename(original), sourcePath: original, copy: true });
  const mimeType = mimeForAudio(copy.path);
  let audioBytes: Uint8Array = new Uint8Array(fs.readFileSync(copy.path));
  let effectiveMime = mimeType;
  if ((selection.kind === "local" || settings.gtcrnDenoise) && mimeType !== "audio/wav") {
    audioBytes = new Uint8Array(await decodeRetainedRange(app.media.ffmpeg, copy.path, 0, 3_600_000, signal));
    effectiveMime = "audio/pcm";
  }

  if (!app.asrEngine) {
    throw new MangaError("CAPABILITY_UNAVAILABLE", "语音识别引擎尚未初始化");
  }

  const vocabularyTerms = app.voice.dictionary.ordered(input.workId).map((item) => item.term);
  const result = await app.asrEngine.transcribe({
    selection,
    audio: audioBytes,
    fileName: copy.fileName,
    mimeType: effectiveMime,
    vocabularyTerms,
    language: settings.language ?? undefined,
    gtcrnDenoise: settings.gtcrnDenoise,
    chunkLongAudio: selection.kind === "local" || effectiveMime === "audio/pcm",
    signal,
  });

  return {
    text: result.text,
    connectionId: selection.kind === "connection" ? selection.connectionId : `local:${selection.modelId}`,
    engineKind: result.engineKind,
    engineId: result.engineId,
    fileName: copy.fileName,
    fileId: copy.fileId,
    folderId: copy.folder.id,
  };
}
