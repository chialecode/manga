/** Model connections: listing, saving, probing and testing them. */
import { MangaError, createId, type CommandEnvelope } from "@manga/contracts";
import { completeText, streamText, transcribeAudio, transcribeChatAudio, transcribeDeepSeek, synthesizeDeepSeek, searchDeepSeek, normalizeBaseUrl, rejectCredentialUrl, syntheticWav, joinApiPath, type AiRuntimeId } from "@manga/model-protocol";
import sharp from "sharp";
import { applyProfile, effectiveProfile, forgetDetected, ModelProfileSchema, type ConnectionTestResult, type ModelProfile } from "@manga/contracts/models";
import { failureOf, modelLimitsOf, parseLastTest } from "../model-probe.ts";
import { PROBE_PICTURE_SIDE, type ModelPurposeName, type ConnectionRow } from "../product-helpers.ts";
import { currentRuntime } from "./settings.ts";
import { saveCredential } from "../credentials.ts";
import { connectionAccess, providerAbortReason } from "../providers/access.ts";
import { dialectOf } from "../providers/registry.ts";
import { recordServiceUse } from "../providers/usage.ts";
import type { CoreCommandHost } from "./shared.ts";

/** What these commands use of the application. */
export type ConnectionsHost = CoreCommandHost;

/** Clears stale `plugin_disabled` test failures once the provider plugin that owns those connections is enabled again. */
export function clearStaleProviderFailures(app: Pick<ConnectionsHost, "store" | "providers">): number {
  const available = new Set(app.providers.list().map((entry) => entry.ref));
  if (!available.size) return 0;
  const rows = app.store.sqlite.prepare(
    "SELECT c.id, c.last_test_json, a.provider_ref FROM provider_connections c JOIN provider_accounts a ON a.id = c.account_id WHERE c.last_test_json IS NOT NULL",
  ).all() as Array<{ id: string; last_test_json: string | null; provider_ref: string }>;
  const clear = app.store.sqlite.prepare("UPDATE provider_connections SET last_test_json = NULL WHERE id = ?");
  let cleared = 0;
  for (const row of rows) {
    if (!available.has(row.provider_ref)) continue;
    const parsed = parseLastTest(row.last_test_json);
    if (parsed && !parsed.ok && parsed.failure?.category === "provider") {
      clear.run(row.id);
      cleared += 1;
    }
  }
  return cleared;
}

export function listConnections(app: ConnectionsHost) {
  if (!app.sealed) {
    try { clearStaleProviderFailures(app); } catch { /* read-only or closing store */ }
  }
  const rows = app.store.sqlite.prepare("SELECT c.id, c.label, c.adapter_id, c.protocol, c.runtime, c.base_url, c.credential_ref, c.purpose, c.model_id, c.timeout_ms, c.verified_capabilities_json, c.profile_json, c.last_test_json, c.created_at, c.account_id, c.provider_model, a.provider_ref, a.label AS account_label FROM provider_connections c LEFT JOIN provider_accounts a ON a.id = c.account_id ORDER BY c.rowid").all() as Array<Record<string, string | number | null>>;
  return rows.map((row) => {
    const verified = JSON.parse(String(row.verified_capabilities_json || "[]")) as string[];
    const available = Boolean(row.provider_ref && app.providers.get(String(row.provider_ref)));
    const parsedTest = parseLastTest(row.last_test_json as string | null);
    const lastTest = row.account_id && available && parsedTest && !parsedTest.ok && parsedTest.failure?.category === "provider" ? null : parsedTest;
    return {
      id: row.id,
      label: row.label,
      protocol: row.protocol,
      runtime: row.runtime === "pi" ? "pi" : "native",
      baseUrl: row.base_url,
      credentialConfigured: Boolean(row.credential_ref),
      purpose: row.purpose,
      modelId: row.model_id,
      timeoutMs: Number(row.timeout_ms ?? 60_000),
      verifiedCapabilities: verified,
      // The numbers and switches the model works with: what the person set, what a test found, or the default; the budget follows from them.
      profile: effectiveProfile(row.profile_json as string | null, verified),
      lastTest,
      createdAt: row.created_at,
      adapterId: row.adapter_id,
      // A connection from a provider plugin: its account, and whether the plugin is usable now (计划 4.2 列表).
      account: row.account_id ? { id: row.account_id, label: row.account_label ?? "", providerRef: row.provider_ref ?? "", available } : null,
      providerModel: row.provider_model ?? null,
    };
  });
}

export async function upsertConnection(app: ConnectionsHost, envelope: CommandEnvelope) {
  app.assertWritable();
  const input = envelope.input as {
    id?: string;
    label: string;
    protocol: "openai-responses" | "openai-chat-completions";
    runtime?: AiRuntimeId;
    baseUrl: string;
    modelId: string;
    timeoutMs?: number;
    purpose: "text" | "transcription" | "embedding" | "vision";
    credentialHandle?: string;
    profile?: Parameters<typeof applyProfile>[1];
  };
  rejectCredentialUrl(input.baseUrl);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const id = input.id ?? createId("conn");
  const existing = app.store.sqlite.prepare("SELECT credential_ref, base_url, protocol, model_id, runtime, profile_json, verified_capabilities_json, account_id, purpose FROM provider_connections WHERE id = ?").get(id) as { credential_ref: string | null; base_url: string; protocol: string; model_id: string; runtime: string | null; profile_json: string | null; verified_capabilities_json: string; account_id: string | null; purpose: string } | undefined;
  // A connection from a provider keeps the provider's address, protocol, model and key: those change with the provider and the account, not here (计划 4.2).
  if (existing?.account_id && (input.credentialHandle || normalizeBaseUrl(input.baseUrl) !== existing.base_url || input.protocol !== existing.protocol || input.modelId !== existing.model_id || input.purpose !== existing.purpose)) {
    throw new MangaError("VALIDATION_ERROR", "这个连接来自提供者插件：地址、模型与用途随插件，密钥在账户上修改", { details: { reason: "provider_connection" } });
  }
  const runtime = input.runtime ?? currentRuntime(app);
  // Another address, protocol, model or runtime is another model: what a test found about the old one no longer applies.
  const retargeted = Boolean(existing) && (existing!.base_url !== baseUrl || existing!.protocol !== input.protocol || existing!.model_id !== input.modelId || (existing!.runtime === "pi" ? "pi" : "native") !== runtime);
  const resetVerified = retargeted || Boolean(input.credentialHandle);
  let profileJson: string | null = existing?.profile_json ?? null;
  if (input.profile || (retargeted && profileJson)) {
    const stored = effectiveProfile(existing?.profile_json, JSON.parse(existing?.verified_capabilities_json || "[]") as string[]);
    const base = retargeted ? forgetDetected(stored) : stored;
    profileJson = JSON.stringify(checkedProfile(app, input.profile ? applyProfile(base, input.profile, "user") : base));
  }
  let credentialRef: string | undefined;
  if (input.credentialHandle) {
    const handle = input.credentialHandle;
    credentialRef = await saveCredential(app, () => takeSecret(app, handle));
  }
  try {
    app.store.sqlite.transaction(() => {
      app.store.sqlite.prepare(`INSERT INTO provider_connections(id,label,adapter_id,protocol,runtime,base_url,credential_ref,timeout_ms,purpose,model_id,verified_capabilities_json,profile_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET label=excluded.label, protocol=excluded.protocol, runtime=excluded.runtime, base_url=excluded.base_url, credential_ref=COALESCE(excluded.credential_ref, provider_connections.credential_ref), timeout_ms=excluded.timeout_ms, purpose=excluded.purpose, model_id=excluded.model_id, verified_capabilities_json=CASE WHEN ? THEN '[]' ELSE provider_connections.verified_capabilities_json END, profile_json=excluded.profile_json, last_test_json=CASE WHEN ? THEN NULL ELSE provider_connections.last_test_json END`).run(
        id, input.label, "openai-http", input.protocol, runtime, baseUrl, credentialRef ?? null, input.timeoutMs ?? 60_000, input.purpose, input.modelId, "[]", profileJson, new Date().toISOString(), resetVerified ? 1 : 0, retargeted ? 1 : 0,
      );
      if (credentialRef && existing?.credential_ref) {
        app.store.sqlite.prepare("DELETE FROM credentials WHERE ref = ?").run(existing.credential_ref);
      }
    })();
  } catch (error) {
    if (credentialRef) app.store.sqlite.prepare("DELETE FROM credentials WHERE ref = ?").run(credentialRef);
    throw error;
  }
  app.notify("settings.changed", {});
  return { id, baseUrl, runtime, credentialConfigured: Boolean(credentialRef ?? existing?.credential_ref) };
}

/** A profile that does not hold together (an answer as long as the whole window) is refused with the reason, not stored. */
export function checkedProfile(app: ConnectionsHost, profile: ModelProfile): ModelProfile {
  const parsed = ModelProfileSchema.safeParse(profile);
  if (!parsed.success) throw new MangaError("VALIDATION_ERROR", parsed.error.issues.some((issue) => issue.path[0] === "maxOutput") ? "最大输出必须小于上下文窗口，否则请求里放不下任何材料" : "模型设置的数值不在允许的范围内", { details: { reason: "profile" } });
  return parsed.data;
}

export function setProfile(app: ConnectionsHost, envelope: CommandEnvelope) {
  app.assertWritable();
  const input = envelope.input as { connectionId: string; profile: Parameters<typeof applyProfile>[1] };
  const row = app.store.sqlite.prepare("SELECT profile_json, verified_capabilities_json FROM provider_connections WHERE id = ?").get(input.connectionId) as { profile_json: string | null; verified_capabilities_json: string } | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "connection missing");
  const base = effectiveProfile(row.profile_json, JSON.parse(row.verified_capabilities_json || "[]") as string[]);
  const next = checkedProfile(app, applyProfile(base, input.profile, "user"));
  app.store.sqlite.prepare("UPDATE provider_connections SET profile_json = ? WHERE id = ?").run(JSON.stringify(next), input.connectionId);
  app.notify("settings.changed", {});
  return { id: input.connectionId, profile: next };
}

/**
 * Ask a connection one question and look at what it can do (A-82): how long the first words take, whether it streams, calls a tool and accepts a picture,
 * and what the service says about its own limits. A failure is a result, not an error: it carries the kind (the key, the address, the model, the time, the
 * network, the form of the answer) so the person knows what to fix. The result stays with the connection.
 */
export async function probeConnection(app: ConnectionsHost, envelope: CommandEnvelope, signal: AbortSignal): Promise<ConnectionTestResult & { profile: ModelProfile }> {
  app.assertWritable();
  const input = envelope.input as { connectionId: string };
  const row = app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ?").get(input.connectionId) as (ConnectionRow & { profile_json: string | null }) | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "connection missing");
  if (row.purpose !== "text" && row.purpose !== "vision") throw new MangaError("MODEL_CAPABILITY_MISSING", "only a text or vision connection is tested with a question", { details: { purpose: row.purpose } });
  const at = new Date().toISOString();
  const verified = new Set(JSON.parse(String(row.verified_capabilities_json || "[]")) as string[]);
  let profile = effectiveProfile(row.profile_json, [...verified]);
  const save = (result: ConnectionTestResult) => {
    app.store.sqlite.prepare("UPDATE provider_connections SET last_test_json = ?, verified_capabilities_json = ?, profile_json = ? WHERE id = ?").run(
      JSON.stringify(result), JSON.stringify([...verified]), row.profile_json || result.ok ? JSON.stringify(profile) : null, row.id,
    );
    app.notify("settings.changed", {});
    return { ...result, profile };
  };
  let access: Awaited<ReturnType<typeof connectionAccess>>;
  try {
    access = await connectionAccess(app, row, signal);
  } catch (error) {
    if (signal.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
    return save({ at, ok: false, latencyMs: 0, failure: failureOf(error) });
  }
  const { apiKey } = access;
  if (apiKey === undefined) {
    access.release();
    return save({ at, ok: false, latencyMs: 0, failure: { category: "auth", detail: "no key is saved for app connection" } });
  }
  const runSignal = access.signal ?? signal;
  const dialect = dialectOf(profile, row.base_url);
  const protocol = row.protocol as "openai-responses" | "openai-chat-completions";
  const runtime = (row.runtime === "pi" ? "pi" : "native") as AiRuntimeId;
  const timeoutMs = row.timeout_ms;
  const capabilities: string[] = [];
  const started = Date.now();
  let latencyMs = 0;
  let reply = "";
  try {
    // 1. A question, streamed: the time to the first words, and that the stream is whole.
    let completed = false;
    for await (const event of streamText(protocol, row.base_url, apiKey, {
      model: row.model_id,
      messages: [{ role: "user", content: "Reply with one short sentence saying you are ready." }],
      signal: runSignal,
      timeoutMs,
      ...(dialect ? { dialect } : {}),
    }, runtime)) {
      if (event.type === "text-delta") {
        if (!reply) latencyMs = Date.now() - started;
        reply += event.text;
      }
      if (event.type === "completed") completed = true;
      if (event.type === "error") throw new MangaError("PROVIDER_UNAVAILABLE", event.message, { retryable: event.retryable, details: { kind: event.code === "TIMEOUT" ? "timeout" : "network" } });
    }
    if (!completed) throw new MangaError("PROVIDER_UNAVAILABLE", "the stream ended before the model finished", { retryable: true, details: { kind: "protocol" } });
    if (!reply.trim()) throw new MangaError("PROVIDER_UNAVAILABLE", "the model answered with no text", { details: { kind: "protocol" } });
    if (!latencyMs) latencyMs = Date.now() - started;
    capabilities.push("streaming");
    verified.add("text");
    verified.add("streaming");
    // 2. A tool call: what the agent works by.
    const args = new Map<string, string>();
    for await (const event of streamText(protocol, row.base_url, apiKey, {
      model: row.model_id,
      messages: [{ role: "user", content: "Call the function find with the text \"x\"." }],
      tools: [{ name: "find", description: "find something by text", parameters: { type: "object", properties: { text: { type: "string" } } } }],
      signal: runSignal,
      timeoutMs,
      ...(dialect ? { dialect } : {}),
    }, runtime)) {
      if (event.type === "tool-call-delta") args.set(event.callId, (args.get(event.callId) ?? "") + event.argumentsDelta);
      if (event.type === "error") break;
    }
    let toolsWork = args.size > 0;
    for (const value of args.values()) { try { JSON.parse(value); } catch { toolsWork = false; } }
    if (toolsWork) { capabilities.push("tools"); verified.add("tools"); }
    // 3. A picture: a small synthetic one. A model that takes no pictures refuses the request, which is the answer.
    try {
      const image = await sharp({ create: { width: PROBE_PICTURE_SIDE, height: PROBE_PICTURE_SIDE, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
      const seen = await completeText(protocol, row.base_url, apiKey, {
        model: row.model_id,
        messages: [{ role: "user", content: "Reply with one word.", images: [{ mediaType: "image/png", base64: image.toString("base64") }] }],
        signal: runSignal,
        timeoutMs,
        ...(dialect ? { dialect } : {}),
      }, runtime);
      if (seen.text.trim()) { capabilities.push("vision"); verified.add("vision"); }
    } catch (error) {
      if (runSignal.aborted) throw error;
    }
    // What the service says about the model, if it says anything.
    const detected = await modelLimitsOf(row.base_url, apiKey, row.model_id, runSignal, Math.min(timeoutMs, 10_000));
    let next = profile;
    if (detected.contextWindow && profile.source.contextWindow !== "user") next = applyProfile(next, { contextWindow: detected.contextWindow }, "detected");
    if (detected.maxOutput && profile.source.maxOutput !== "user" && detected.maxOutput < next.contextWindow) next = applyProfile(next, { maxOutput: detected.maxOutput }, "detected");
    if (capabilities.includes("vision") && !next.inputTypes.includes("image")) next = applyProfile(next, { inputTypes: [...next.inputTypes, "image"] }, "detected");
    if (capabilities.includes("tools") && !next.capabilities.includes("tools")) next = applyProfile(next, { capabilities: [...next.capabilities, "tools"] }, "detected");
    profile = checkedProfile(app, next);
    return save({
      at, ok: true, latencyMs, reply: [...reply.trim()].slice(0, 80).join(""), capabilities,
      ...(detected.contextWindow || detected.maxOutput ? { detected } : {}),
    });
  } catch (error) {
    const abortedByProvider = providerAbortReason(access.signal);
    if (abortedByProvider) {
      return save({ at, ok: false, latencyMs: Date.now() - started, ...(capabilities.length ? { capabilities } : {}), failure: failureOf(abortedByProvider) });
    }
    if (signal.aborted || (error instanceof MangaError && error.code === "CANCELLED")) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
    return save({ at, ok: false, latencyMs: Date.now() - started, ...(capabilities.length ? { capabilities } : {}), failure: failureOf(error) });
  } finally {
    access.release();
  }
}

/** Takes the secret the page stashed for one save; the handle is used up. */
export function takeSecret(app: { secrets: Map<string, string> }, handle: string): string {
  const secret = app.secrets.get(handle);
  if (!secret) throw new MangaError("FORBIDDEN", "credential handle is not authorized");
  app.secrets.delete(handle);
  return secret;
}

export async function openConnection(
  app: ConnectionsHost,
  connectionId: string,
  purpose: ModelPurposeName | ModelPurposeName[],
  signal?: AbortSignal,
): Promise<{ row: ConnectionRow; apiKey: string; signal: AbortSignal | undefined; providerSignal: AbortSignal | undefined; release: () => void }> {
  const row = app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ?").get(connectionId) as ConnectionRow | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "connection missing");
  if (!(Array.isArray(purpose) ? purpose : [purpose]).includes(row.purpose as ModelPurposeName)) throw new MangaError("MODEL_CAPABILITY_MISSING", "connection purpose does not match the requested model task");
  // Single gate: verifies provider plugin availability & address BEFORE reading the key, and tracks in-flight requests so disabling the plugin cancels them.
  const access = await connectionAccess(app, row, signal);
  if (!row.credential_ref) {
    access.release();
    throw new MangaError("AUTHENTICATION_FAILED", "connection has no credential");
  }
  if (access.apiKey === undefined) {
    access.release();
    throw new MangaError("NOT_FOUND", "credential payload missing");
  }
  return { row, apiKey: access.apiKey, signal: access.signal ?? signal, providerSignal: access.signal, release: access.release };
}

export async function secretFor(app: ConnectionsHost, connectionId: string, purpose: ModelPurposeName | ModelPurposeName[]): Promise<{ row: ConnectionRow; apiKey: string }> {
  const opened = await openConnection(app, connectionId, purpose);
  opened.release();
  return { row: opened.row, apiKey: opened.apiKey };
}

export async function testConnection(app: ConnectionsHost, envelope: CommandEnvelope, signal: AbortSignal) {
  app.assertWritable();
  const input = envelope.input as { connectionId: string; capability: "text" | "tools" | "streaming" | "transcription" | "embedding" | "vision" | "speech" | "search" };
  // A text model that can look at pictures is tested as text; a model kept only for pictures is its own kind of connection.
  const purpose: ModelPurposeName | ModelPurposeName[] = input.capability === "transcription" ? "transcription" : input.capability === "embedding" ? "embedding" : input.capability === "vision" ? ["text", "vision"] : input.capability === "speech" ? "speech" : input.capability === "search" ? "search" : "text";
  const opened = await openConnection(app, input.connectionId, purpose, signal);
  const { row, apiKey } = opened;
  const runSignal = opened.signal ?? signal;
  const protocol = row.protocol as "openai-responses" | "openai-chat-completions";
  const runtime = (row.runtime === "pi" ? "pi" : "native") as AiRuntimeId;
  const timeoutMs = row.timeout_ms;
  try {
    if (input.capability === "speech" || input.capability === "search" || (input.capability === "transcription" && row.adapter_id === "deepseek-asr@1")) {
      return await testService(app, row, apiKey, input.capability, signal, opened.providerSignal);
    }
    if (input.capability === "embedding") {
      const combined = AbortSignal.any([runSignal, AbortSignal.timeout(timeoutMs)]);
      const response = await fetch(joinApiPath(row.base_url, "/embeddings"), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: row.model_id, input: "ping" }),
        redirect: "error",
        signal: combined,
      }).catch((error) => {
        const abortedByProvider = providerAbortReason(opened.providerSignal);
        if (abortedByProvider) throw abortedByProvider;
        if (signal.aborted || combined.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
        throw new MangaError("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "embedding probe failed", { retryable: true });
      });
      if (!response.ok) throw new MangaError(response.status === 404 ? "MODEL_CAPABILITY_MISSING" : "PROVIDER_UNAVAILABLE", "embedding probe failed", { details: { status: response.status } });
      const json = await response.json() as { data?: Array<{ embedding?: unknown[] }> };
      if (!Array.isArray(json.data) || json.data.length !== 1 || !Array.isArray(json.data[0]?.embedding)
        || !json.data[0].embedding.length || !json.data[0].embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new MangaError("MODEL_CAPABILITY_MISSING", "embedding probe returned no valid vector");
      }
      markCapability(app, row.id, "embedding");
      return { ok: true, vectors: json.data.length };
    }
    if (input.capability === "transcription") {
      const verified = JSON.parse(String(row.verified_capabilities_json || "[]")) as string[];
      const profile = effectiveProfile(row.profile_json, verified);
      const result = profile.transcriptionInterface === "chat_input_audio"
        ? await transcribeChatAudio(row.base_url, apiKey, {
          model: row.model_id,
          bytes: syntheticWav(),
          format: "wav",
          signal: runSignal,
          timeoutMs,
        })
        : await transcribeAudio(row.base_url, apiKey, {
          model: row.model_id,
          fileName: "probe.wav",
          bytes: syntheticWav(),
          mimeType: "audio/wav",
          signal: runSignal,
          timeoutMs,
        });
      if (!result.text.trim()) throw new MangaError("MODEL_CAPABILITY_MISSING", "transcription probe returned empty text");
      markCapability(app, row.id, "transcription");
      return { ok: true, text: result.text };
    }
    if (input.capability === "vision") {
      // A small synthetic picture: the model has to accept an image part and answer. A text-only model refuses the request, which is the answer.
      const verified = JSON.parse(String(row.verified_capabilities_json || "[]")) as string[];
      const dialect = dialectOf(effectiveProfile(row.profile_json, verified), row.base_url);
      const probe = await sharp({ create: { width: PROBE_PICTURE_SIDE, height: PROBE_PICTURE_SIDE, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
      const completed = await completeText(protocol, row.base_url, apiKey, {
        model: row.model_id,
        messages: [{ role: "user", content: "Reply with one word.", images: [{ mediaType: "image/png", base64: probe.toString("base64") }] }],
        signal: runSignal,
        timeoutMs,
        ...(dialect ? { dialect } : {}),
      }, runtime).catch((error) => {
        const abortedByProvider = providerAbortReason(opened.providerSignal);
        if (abortedByProvider) throw abortedByProvider;
        const status = error instanceof MangaError ? Number((error.details as { status?: number } | undefined)?.status) : NaN;
        if (error instanceof MangaError && error.code === "PROVIDER_UNAVAILABLE" && [400, 404, 413, 415, 422].includes(status)) {
          throw new MangaError("MODEL_CAPABILITY_MISSING", "the model did not accept an image", { details: { status } });
        }
        throw error;
      });
      if (!completed.text.trim()) throw new MangaError("MODEL_CAPABILITY_MISSING", "the vision probe returned no text");
      markCapability(app, row.id, "vision");
      return { ok: true, text: completed.text };
    }
    const verified = JSON.parse(String(row.verified_capabilities_json || "[]")) as string[];
    const dialect = dialectOf(effectiveProfile(row.profile_json, verified), row.base_url);
    if (input.capability === "streaming" || input.capability === "tools") {
      let text = "";
      const args = new Map<string, string>();
      let completed = false;
      for await (const event of streamText(protocol, row.base_url, apiKey, {
        model: row.model_id,
        messages: [{ role: "user", content: "ping" }],
        tools: input.capability === "tools" ? [{ name: "library.find", description: "find", parameters: { type: "object", properties: { text: { type: "string" } } } }] : undefined,
        signal: runSignal,
        timeoutMs,
        ...(dialect ? { dialect } : {}),
      }, runtime)) {
        if (event.type === "text-delta") text += event.text;
        if (event.type === "tool-call-delta") args.set(event.callId, (args.get(event.callId) ?? "") + event.argumentsDelta);
        if (event.type === "completed") completed = true;
      }
      if (!completed) throw new MangaError("PROVIDER_UNAVAILABLE", "stream ended before the provider completed", { retryable: true });
      if (input.capability === "tools" && args.size === 0) throw new MangaError("MODEL_CAPABILITY_MISSING", "tool probe received no tool call");
      for (const value of args.values()) JSON.parse(value);
      markCapability(app, row.id, input.capability);
      return { ok: true, text, tools: [...args.entries()].map(([id, argumentsJson]) => ({ id, argumentsJson })) };
    }
    const completed = await completeText(protocol, row.base_url, apiKey, {
      model: row.model_id,
      messages: [{ role: "user", content: "ping" }],
      signal: runSignal,
      timeoutMs,
      ...(dialect ? { dialect } : {}),
    }, runtime);
    markCapability(app, row.id, "text");
    return { ok: true, text: completed.text };
  } catch (error) {
    const abortedByProvider = providerAbortReason(opened.providerSignal);
    if (abortedByProvider) throw abortedByProvider;
    throw error;
  } finally {
    opened.release();
  }
}

/**
 * Who looks at pictures for a task. The profile of a model is the authority (A-82): a text model whose profile takes images gets them with the question,
 * otherwise a connection kept for pictures whose profile takes them reads them first. A test that found the model accepts an image puts it in the profile;
 * the person can also switch it off, and then the model is not sent a picture whatever a test once found. Neither means pictures are not sent and the request says why.
 */
export function visionRoute(app: ConnectionsHost, textConnection?: ConnectionRow): { kind: "direct"; connection: ConnectionRow } | { kind: "separate"; connection: ConnectionRow } | { kind: "none"; reason: string } {
  const profileOf = (row: ConnectionRow) => effectiveProfile(row.profile_json, JSON.parse(String(row.verified_capabilities_json || "[]")) as string[]);
  const takesImages = (row: ConnectionRow) => profileOf(row).inputTypes.includes("image");
  // The same connection a run picks: the first text connection.
  const text = textConnection ?? app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE purpose = 'text' LIMIT 1").get() as ConnectionRow | undefined;
  if (!text || !text.credential_ref) return { kind: "none", reason: "没有配置文字模型，无法处理图像材料；请先在设置里添加模型" };
  if (takesImages(text)) return { kind: "direct", connection: text };
  const sight = app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE purpose = 'vision' AND credential_ref IS NOT NULL ORDER BY created_at, rowid").all() as ConnectionRow[];
  const ready = sight.find(takesImages);
  if (ready) return { kind: "separate", connection: ready };
  return {
    kind: "none",
    reason: sight.length
      ? "视觉模型的设置里没有开启图像输入，也没有通过图像检测，没有读取图像；请在设置里检测它或开启图像输入"
      : "当前模型的设置里没有开启图像输入（也没有通过图像检测），又没有配置视觉模型，没有读取图像；请在设置里检测或开启支持图像的模型，或添加一个视觉连接",
  };
}

/** A capability a test found: it is kept with the connection, and a picture that was accepted puts image input in the profile. */
export function markCapability(app: ConnectionsHost, id: string, capability: string) {
  const row = app.store.sqlite.prepare("SELECT verified_capabilities_json, profile_json FROM provider_connections WHERE id = ?").get(id) as { verified_capabilities_json: string; profile_json: string | null };
  const current = new Set(JSON.parse(row.verified_capabilities_json) as string[]);
  current.add(capability);
  let profileJson = row.profile_json;
  if (capability === "vision") {
    const profile = effectiveProfile(row.profile_json, [...current]);
    if (!profile.inputTypes.includes("image")) profileJson = JSON.stringify(applyProfile(profile, { inputTypes: [...profile.inputTypes, "image"] }, "detected"));
  }
  app.store.sqlite.prepare("UPDATE provider_connections SET verified_capabilities_json = ?, profile_json = ? WHERE id = ?").run(JSON.stringify([...current]), profileJson, id);
}

export function deleteConnection(app: ConnectionsHost, envelope: CommandEnvelope) {
  app.assertWritable();
  const input = envelope.input as { connectionId: string };
  const row = app.store.sqlite.prepare("SELECT credential_ref, account_id FROM provider_connections WHERE id = ?").get(input.connectionId) as { credential_ref: string | null; account_id: string | null } | undefined;
  app.store.sqlite.prepare("DELETE FROM provider_connections WHERE id = ?").run(input.connectionId);
  // The key of a provider connection is its account's, shared with the others; it goes with the account, not with one connection (计划 4.2).
  const own = Boolean(row?.credential_ref) && !row?.account_id;
  if (own) app.store.sqlite.prepare("DELETE FROM credentials WHERE ref = ?").run(row!.credential_ref);
  app.notify("settings.changed", {});
  return { ok: true, credentialRemoved: own };
}

const SPEECH_TEST_TEXT = "你好，这是朗读测试。";

/**
 * The test of a provider's recognition, speech or search (计划 4.9): a built-in synthetic WAV, a fixed short sentence, a fixed word with one result. Only
 * when the person presses the button; the result is kept with the connection and the use is recorded like any other.
 */
async function testService(app: ConnectionsHost, row: ConnectionRow, apiKey: string, kind: "transcription" | "speech" | "search", signal: AbortSignal, providerSignal?: AbortSignal) {
  const at = new Date().toISOString();
  const started = Date.now();
  const runSignal = providerSignal ?? signal;
  const save = (result: { ok: boolean; latencyMs: number; failure?: ReturnType<typeof failureOf>; service?: { kind: typeof kind; detail: string } }) => {
    app.store.sqlite.prepare("UPDATE provider_connections SET last_test_json = ? WHERE id = ?").run(JSON.stringify({ at, ...result }), row.id);
    app.notify("settings.changed", {});
    return { at, ...result };
  };
  try {
    if (kind === "transcription") {
      const heard = await transcribeDeepSeek(row.base_url, apiKey, { bytes: syntheticWav(), signal: runSignal, timeoutMs: row.timeout_ms });
      recordServiceUse(app, { connectionId: row.id, service: "transcription", task: "test", unit: "second", quantity: (heard.durationMs ?? 0) / 1000, status: "ok" });
      markCapability(app, row.id, "transcription");
      return save({ ok: true, latencyMs: Date.now() - started, service: { kind, detail: [...heard.text.trim()].slice(0, 40).join("") || "（没有识别出文字）" } });
    }
    if (kind === "speech") {
      let bytes = 0;
      const spoken = await synthesizeDeepSeek(row.base_url, apiKey, { text: SPEECH_TEST_TEXT, signal: runSignal, timeoutMs: row.timeout_ms, onChunk: (chunk) => { bytes += chunk.length; } });
      recordServiceUse(app, { connectionId: row.id, service: "speech", task: "test", unit: "char", quantity: spoken.billedChars, status: "ok" });
      return save({ ok: true, latencyMs: spoken.firstChunkMs ?? Date.now() - started, service: { kind, detail: `${(bytes / 48_000).toFixed(1)} s` } });
    }
    const found = await searchDeepSeek(row.base_url, apiKey, { query: "MANGA", count: 1, signal: runSignal, timeoutMs: row.timeout_ms });
    recordServiceUse(app, { connectionId: row.id, service: "search", task: "test", unit: "search", quantity: 1, status: "ok" });
    return save({ ok: true, latencyMs: Date.now() - started, service: { kind, detail: found.results[0]?.title ?? "没有找到" } });
  } catch (error) {
    const abortedByProvider = providerAbortReason(providerSignal);
    if (abortedByProvider) {
      recordServiceUse(app, { connectionId: row.id, service: kind, task: "test", unit: kind === "transcription" ? "second" : kind === "speech" ? "char" : "search", quantity: 0, status: "error", errorCode: abortedByProvider.code });
      return save({ ok: false, latencyMs: Date.now() - started, failure: failureOf(abortedByProvider) });
    }
    if (signal.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
    recordServiceUse(app, { connectionId: row.id, service: kind, task: "test", unit: kind === "transcription" ? "second" : kind === "speech" ? "char" : "search", quantity: 0, status: "error", errorCode: error instanceof MangaError ? error.code : "UNKNOWN" });
    return save({ ok: false, latencyMs: Date.now() - started, failure: failureOf(error) });
  }
}
