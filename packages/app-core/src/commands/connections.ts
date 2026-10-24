/** Model connections: listing, saving, probing and testing them. */
import { MangaError, createId, type CommandEnvelope } from "@manga/contracts";
import { completeText, streamText, transcribeAudio, normalizeBaseUrl, rejectCredentialUrl, syntheticWav, joinApiPath, type AiRuntimeId } from "@manga/model-protocol";
import sharp from "sharp";
import { applyProfile, effectiveProfile, forgetDetected, ModelProfileSchema, type ConnectionTestResult, type ModelProfile } from "@manga/contracts/models";
import { failureOf, modelLimitsOf, parseLastTest } from "../model-probe.ts";
import type { MangaProductApp } from "../product-app.ts";
import { PROBE_PICTURE_SIDE, type ModelPurposeName, type ConnectionRow } from "../product-helpers.ts";
import { currentRuntime } from "./settings.ts";

/** What these commands use of the application. */
export type ConnectionsHost = Pick<MangaProductApp, "assertWritable" | "covers" | "debugContext" | "grantOf" | "interruptRuns" | "layout" | "listModules" | "pendingRecoveryJobs" | "publicLayout" | "queryLog" | "quickTasks" | "resolvePath" | "runtime" | "scanAbort" | "screenshots" | "sealed" | "secrets" | "setModule" | "store" | "trace" | "uiFacets" | "vault" | "workFolders">;

export function listConnections(app: ConnectionsHost) {
  const rows = app.store.sqlite.prepare("SELECT id, label, protocol, runtime, base_url, credential_ref, purpose, model_id, timeout_ms, verified_capabilities_json, profile_json, last_test_json, created_at FROM provider_connections").all() as Array<Record<string, string | number | null>>;
  return rows.map((row) => {
    const verified = JSON.parse(String(row.verified_capabilities_json || "[]")) as string[];
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
      lastTest: parseLastTest(row.last_test_json as string | null),
      createdAt: row.created_at,
    };
  });
}

export function upsertConnection(app: ConnectionsHost, envelope: CommandEnvelope) {
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
  const existing = app.store.sqlite.prepare("SELECT credential_ref, base_url, protocol, model_id, runtime, profile_json, verified_capabilities_json FROM provider_connections WHERE id = ?").get(id) as { credential_ref: string | null; base_url: string; protocol: string; model_id: string; runtime: string | null; profile_json: string | null; verified_capabilities_json: string } | undefined;
  const runtime = input.runtime ?? currentRuntime(app);
  // Another address, protocol, model or runtime is another model: what a test found about the old one no longer applies.
  const retargeted = Boolean(existing) && (existing!.base_url !== baseUrl || existing!.protocol !== input.protocol || existing!.model_id !== input.modelId || (existing!.runtime === "pi" ? "pi" : "native") !== runtime);
  let profileJson: string | null = existing?.profile_json ?? null;
  if (input.profile || (retargeted && profileJson)) {
    const stored = effectiveProfile(existing?.profile_json, JSON.parse(existing?.verified_capabilities_json || "[]") as string[]);
    const base = retargeted ? forgetDetected(stored) : stored;
    profileJson = JSON.stringify(checkedProfile(app, input.profile ? applyProfile(base, input.profile, "user") : base));
  }
  let credentialRef: string | undefined;
  if (input.credentialHandle) {
    if (!app.vault.available()) throw new MangaError("CREDENTIAL_UNAVAILABLE", "cannot store credentials without platform protection");
    const secret = app.secrets.get(input.credentialHandle);
    if (!secret) throw new MangaError("FORBIDDEN", "credential handle is not authorized");
    app.secrets.delete(input.credentialHandle);
    credentialRef = createId("cred");
    const cipher = app.vault.encrypt(secret);
    app.store.sqlite.prepare("INSERT INTO credentials(ref, ciphertext, created_at) VALUES (?,?,?)").run(credentialRef, cipher, new Date().toISOString());
    if (existing?.credential_ref) app.store.sqlite.prepare("DELETE FROM credentials WHERE ref = ?").run(existing.credential_ref);
  }
  app.store.sqlite.prepare(`INSERT INTO provider_connections(id,label,adapter_id,protocol,runtime,base_url,credential_ref,timeout_ms,purpose,model_id,verified_capabilities_json,profile_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET label=excluded.label, protocol=excluded.protocol, runtime=excluded.runtime, base_url=excluded.base_url, credential_ref=COALESCE(excluded.credential_ref, provider_connections.credential_ref), timeout_ms=excluded.timeout_ms, purpose=excluded.purpose, model_id=excluded.model_id, verified_capabilities_json='[]', profile_json=excluded.profile_json, last_test_json=CASE WHEN ? THEN NULL ELSE provider_connections.last_test_json END`).run(
    id, input.label, "openai-http", input.protocol, runtime, baseUrl, credentialRef ?? null, input.timeoutMs ?? 60_000, input.purpose, input.modelId, "[]", profileJson, new Date().toISOString(), retargeted ? 1 : 0,
  );
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
    return { ...result, profile };
  };
  const cred = row.credential_ref ? app.store.sqlite.prepare("SELECT ciphertext FROM credentials WHERE ref = ?").get(row.credential_ref) as { ciphertext: Buffer } | undefined : undefined;
  if (!cred) return save({ at, ok: false, latencyMs: 0, failure: { category: "auth", detail: "no key is saved for app connection" } });
  const apiKey = app.vault.decrypt(cred.ciphertext);
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
      signal,
      timeoutMs,
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
      signal,
      timeoutMs,
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
        signal,
        timeoutMs,
      }, runtime);
      if (seen.text.trim()) { capabilities.push("vision"); verified.add("vision"); }
    } catch (error) {
      if (signal.aborted) throw error;
    }
    // What the service says about the model, if it says anything.
    const detected = await modelLimitsOf(row.base_url, apiKey, row.model_id, signal, Math.min(timeoutMs, 10_000));
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
    if (signal.aborted || (error instanceof MangaError && error.code === "CANCELLED")) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
    return save({ at, ok: false, latencyMs: Date.now() - started, ...(capabilities.length ? { capabilities } : {}), failure: failureOf(error) });
  }
}

export function secretFor(app: ConnectionsHost, connectionId: string, purpose: ModelPurposeName | ModelPurposeName[]): { row: ConnectionRow; apiKey: string } {
  const row = app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ?").get(connectionId) as ConnectionRow | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "connection missing");
  if (!(Array.isArray(purpose) ? purpose : [purpose]).includes(row.purpose as ModelPurposeName)) throw new MangaError("MODEL_CAPABILITY_MISSING", "connection purpose does not match the requested model task");
  if (!row.credential_ref) throw new MangaError("AUTHENTICATION_FAILED", "connection has no credential");
  const cred = app.store.sqlite.prepare("SELECT ciphertext FROM credentials WHERE ref = ?").get(row.credential_ref) as { ciphertext: Buffer } | undefined;
  if (!cred) throw new MangaError("NOT_FOUND", "credential payload missing");
  return { row, apiKey: app.vault.decrypt(cred.ciphertext) };
}

export async function testConnection(app: ConnectionsHost, envelope: CommandEnvelope, signal: AbortSignal) {
  app.assertWritable();
  const input = envelope.input as { connectionId: string; capability: "text" | "tools" | "streaming" | "transcription" | "embedding" | "vision" };
  // A text model that can look at pictures is tested as text; a model kept only for pictures is its own kind of connection.
  const purpose: ModelPurposeName | ModelPurposeName[] = input.capability === "transcription" ? "transcription" : input.capability === "embedding" ? "embedding" : input.capability === "vision" ? ["text", "vision"] : "text";
  const { row, apiKey } = secretFor(app, input.connectionId, purpose);
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
    markCapability(app, row.id, "embedding");
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
    markCapability(app, row.id, "transcription");
    return { ok: true, text: result.text };
  }
  if (input.capability === "vision") {
    // A small synthetic picture: the model has to accept an image part and answer. A text-only model refuses the request, which is the answer.
    const probe = await sharp({ create: { width: PROBE_PICTURE_SIDE, height: PROBE_PICTURE_SIDE, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
    const completed = await completeText(protocol, row.base_url, apiKey, {
      model: row.model_id,
      messages: [{ role: "user", content: "Reply with one word.", images: [{ mediaType: "image/png", base64: probe.toString("base64") }] }],
      signal,
      timeoutMs,
    }, runtime).catch((error) => {
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
    markCapability(app, row.id, input.capability);
    return { ok: true, text, tools: [...args.entries()].map(([id, argumentsJson]) => ({ id, argumentsJson })) };
  }
  const completed = await completeText(protocol, row.base_url, apiKey, {
    model: row.model_id,
    messages: [{ role: "user", content: "ping" }],
    signal,
    timeoutMs,
  }, runtime);
  markCapability(app, row.id, "text");
  return { ok: true, text: completed.text };
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
  const row = app.store.sqlite.prepare("SELECT credential_ref FROM provider_connections WHERE id = ?").get(input.connectionId) as { credential_ref: string | null } | undefined;
  app.store.sqlite.prepare("DELETE FROM provider_connections WHERE id = ?").run(input.connectionId);
  if (row?.credential_ref) app.store.sqlite.prepare("DELETE FROM credentials WHERE ref = ?").run(row.credential_ref);
  return { ok: true, credentialRemoved: Boolean(row?.credential_ref) };
}
