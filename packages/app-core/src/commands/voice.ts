/** The voice module and the model ports it and the semantic index use. */
import fs from "node:fs";
import path from "node:path";
import { MangaError, type CommandEnvelope, type ScopeGrant } from "@manga/contracts";
import { defineModule, type MangaModule } from "@manga/plugin-sdk";
import { completeText, transcribeAudio, type AiRuntimeId } from "@manga/model-protocol";
import { VOICE_MODULE } from "../voice/ids.ts";
import type { AsrPort, LlmPort } from "../voice/ports.ts";
import { readRecordingSettings } from "../voice/settings.ts";
import { embedTexts } from "../semantic/http.ts";
import type { EmbeddingPort } from "../semantic/ports.ts";
import { promptLimitFor } from "../voice/settings.ts";
import type { MangaProductApp } from "../product-app.ts";
import { type ConnectionRow, mimeForAudio } from "../product-helpers.ts";
import { secretFor } from "./connections.ts";
import { createDraftNote } from "./notes.ts";

/** What these commands use of the application. */
export type VoiceHost = Pick<MangaProductApp, "assertWritable" | "closed" | "covers" | "debugContext" | "grantOf" | "grants" | "interruptRuns" | "layout" | "listModules" | "media" | "pendingRecoveryJobs" | "projects" | "publicLayout" | "queryLog" | "quickTasks" | "resolvePath" | "runtime" | "scanAbort" | "screenshots" | "sealed" | "secrets" | "setModule" | "store" | "trace" | "uiFacets" | "vault" | "voice" | "workFolders">;

/** The configured transcription connection, as the recording pipeline sees it. Audio goes nowhere else. */
export function asrPort(app: VoiceHost): AsrPort {
  return {
    resolve: (connectionId) => {
      const row = (connectionId
        ? app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ? AND purpose = 'transcription'").get(connectionId)
        : app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE purpose = 'transcription' AND credential_ref IS NOT NULL ORDER BY created_at, rowid LIMIT 1").get()) as ConnectionRow | undefined;
      return row?.credential_ref ? { id: row.id, model: row.model_id, timeoutMs: row.timeout_ms } : null;
    },
    transcribe: async (connection, request) => {
      const { row, apiKey } = await secretFor(app, connection.id, "transcription");
      return transcribeAudio(row.base_url, apiKey, {
        model: row.model_id, fileName: request.fileName, bytes: request.bytes, mimeType: request.mimeType,
        prompt: request.prompt, language: request.language, timestamps: request.timestamps, signal: request.signal, timeoutMs: row.timeout_ms,
      });
    },
  };
}

export function llmPort(app: VoiceHost): LlmPort {
  return {
    resolve: (connectionId) => {
      const row = (connectionId
        ? app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ? AND purpose = 'text'").get(connectionId)
        : app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE purpose = 'text' AND credential_ref IS NOT NULL ORDER BY created_at, rowid LIMIT 1").get()) as ConnectionRow | undefined;
      return row?.credential_ref ? { id: row.id, model: row.model_id } : null;
    },
    complete: async (connection, request) => {
      const { row, apiKey } = await secretFor(app, connection.id, "text");
      const answer = await completeText(row.protocol as "openai-responses" | "openai-chat-completions", row.base_url, apiKey, {
        model: row.model_id,
        messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
        signal: request.signal, timeoutMs: row.timeout_ms,
      }, (row.runtime === "pi" ? "pi" : "native") as AiRuntimeId);
      return answer.text;
    },
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
      // The module only counts as current once activation has finished, so picking up unfinished recordings waits for that.
      const resume = setTimeout(() => { if (!app.closed && ctx.isCurrent()) app.voice.recover(); }, 0);
      // Recording, filtering and uploads belong to app activation: turning the module off saves what was recorded and ends the rest.
      ctx.register({
        kind: "ipc",
        id: `voice-work-${ctx.epoch}`,
        dispose: () => {
          clearTimeout(resume);
          app.media.handles.bumpGeneration(moduleId);
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
        return app.voice.addTerm(value.workId, value.term, value.heard);
      }));
      reg("capture.removeTerm", (envelope) => call(envelope, () => {
        const value = input<{ workId: string; term: string }>(envelope);
        return app.voice.removeTerm(value.workId, value.term);
      }));
      reg("capture.audioHandle", (envelope) => call(envelope, () => app.voice.audioHandle(input<{ sessionId: string }>(envelope).sessionId), { write: false }));
      // The voice dictionary: terms for every recording and terms for one work (A-66).
      const dictionary = app.voice.dictionary;
      reg("dictionary.list", (envelope) => call(envelope, () => {
        const value = input<{ scope?: "global" | "work"; workId?: string }>(envelope);
        return { ...dictionary.list(value), promptChars: readRecordingSettings(app.store).promptChars };
      }, { write: false }));
      reg("dictionary.removedWorks", (envelope) => call(envelope, () => ({ works: dictionary.removedWorks() }), { write: false }));
      reg("dictionary.add", (envelope) => call(envelope, () => dictionary.add(input(envelope))));
      reg("dictionary.update", (envelope) => call(envelope, () => dictionary.update(input(envelope))));
      reg("dictionary.remove", (envelope) => call(envelope, () => dictionary.remove(input<{ termId: string }>(envelope).termId)));
      reg("dictionary.importMetadata", (envelope) => call(envelope, () => {
        const workId = input<{ workId: string }>(envelope).workId;
        const result = dictionary.syncFromMetadata(workId);
        if (!result.linked) throw new MangaError("VALIDATION_ERROR", "link the work to a source before taking names from it", { details: { reason: "not-linked" } });
        return { workId, ...result };
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
    },
  });
}

export async function transcribeAuthorizedFile(app: VoiceHost, envelope: CommandEnvelope, signal: AbortSignal) {
  app.assertWritable();
  const input = envelope.input as { pathHandle: string; workId: string; connectionId?: string };
  const original = app.resolvePath(input.pathHandle);
  if (!fs.existsSync(original) || !fs.statSync(original).isFile()) throw new MangaError("NOT_FOUND", "audio file is not available");
  if (!app.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(input.workId)) throw new MangaError("NOT_FOUND", "work missing");
  const connectionId = input.connectionId ?? (app.store.sqlite.prepare("SELECT id FROM provider_connections WHERE purpose = 'transcription' LIMIT 1").get() as { id: string } | undefined)?.id;
  if (!connectionId) throw new MangaError("MODEL_CAPABILITY_MISSING", "no transcription connection is configured");
  const { row, apiKey } = await secretFor(app, connectionId, "transcription");
  // The audio comes into the folder of the work first and is transcribed from there; the file the person picked is not touched (A-79).
  const copy = app.workFolders.put(input.workId, { kind: "audio-import", fileName: path.basename(original), sourcePath: original, copy: true });
  const bytes = new Uint8Array(fs.readFileSync(copy.path));
  const result = await transcribeAudio(row.base_url, apiKey, {
    model: row.model_id,
    fileName: copy.fileName,
    bytes,
    mimeType: mimeForAudio(copy.path),
    signal,
    timeoutMs: row.timeout_ms,
  });
  return { text: result.text, connectionId: row.id, fileName: copy.fileName, fileId: copy.fileId, folderId: copy.folder.id };
}
