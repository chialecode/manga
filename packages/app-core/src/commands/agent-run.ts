/** One agent run: the model calls, the tool calls and the run's history. */
import { createHash } from "node:crypto";
import { commandInputJsonSchema, MangaError, createId, type CommandEnvelope, type CommandResult, type ScopeGrant } from "@manga/contracts";
import { completeText, streamText, type AiRuntimeId, type ChatMessage, type FilePart, type ImagePart, type StreamEvent, type VideoPart, type TextRequest, type ToolDefinition } from "@manga/model-protocol";
import { budgetOfConnection, calibrate, COMPACTION_PROMPT, contextTokens, fitContext, tailToTokens, toolsTokens, truncateToTokens } from "../agent-context.ts";
import { readAgentSettings } from "../agent-settings.ts";
import { requestLimits } from "../model-probe.ts";
import { withEmptyScopeNote } from "../agent-scope.ts";
import { AGENT_PROJECT_COMMANDS, agentToolSchema, takesContext, takesProject } from "../creative/agent-access.ts";
import { recordedRequest, type DeliveryNote } from "../agent-trace.ts";
import { AGENT_COMMANDS, AGENT_OPT_IN_COMMANDS } from "../commands/access.ts";
import { publicMedia, renderImages, type FrozenImage, type FrozenMedia } from "../agent-materials.ts";
import type { MangaProductApp } from "../product-app.ts";
import { VISION_READING_MARK, TOOL_DESCRIPTIONS, toolInputSummary, toolParameters, type AgentLoopBudget, contextShares, clipMaterial, refusedByService, isContextOverflow, type ConnectionRow, redactSnapshot, safeJsonValue } from "../product-helpers.ts";
import { visionRoute } from "./connections.ts";
import { readCredential } from "../credentials.ts";
import { latestRevision, runMedia, sourceStamp } from "../agent-media.ts";
import { DELIVERY_REASONS, readFrozenFile } from "../agent-native-input.ts";
import { loadRunMessages, materialContextMessage, startRunLoop } from "./agent.ts";

/** What these commands use of the application. */
export type AgentRunHost = Pick<MangaProductApp, "agentAccess" | "assertWritable" | "builtinDanmakuCredentials" | "call" | "closed" | "comics" | "conversations" | "covers" | "danmaku" | "debugContext" | "extras" | "followFiles" | "grantOf" | "grants" | "interruptRuns" | "issueAgentGrant" | "layout" | "listModules" | "log" | "materials" | "media" | "metadata" | "notify" | "parseGeneration" | "parseWorker" | "pendingRecoveryJobs" | "projects" | "publicLayout" | "queryLog" | "quickTasks" | "requireModule" | "resolvePath" | "resolvePathFor" | "runAbort" | "runtime" | "scanAbort" | "screenshots" | "sealed" | "secrets" | "setModule" | "store" | "suggestedQuery" | "trace" | "uiFacets" | "vault" | "videos" | "voice" | "workFolders">;

/**
 * Every request an agent run makes to a model goes through here, and every tool it calls through `toolCall`, so the trace of the run sees all of them (A-83).
 * The trace is made beside the call and never in its way: what the caller gets is what the provider gave.
 */
export async function* modelStream(app: AgentRunHost, call: { runId: string; step: number; connection: ConnectionRow; apiKey: string; protocol: "openai-responses" | "openai-chat-completions"; runtime: AiRuntimeId; request: TextRequest; delivery?: readonly DeliveryNote[] }): AsyncGenerator<StreamEvent> {
  const handle = app.trace.begin({
    runId: call.runId, step: call.step, kind: "model", name: "chat",
    connection: { id: call.connection.id, modelId: call.connection.model_id, protocol: `${call.protocol} · ${call.runtime}` },
    request: recordedRequest(call.request), secrets: [call.apiKey], delivery: call.delivery,
  });
  let text = "";
  const toolCalls = new Map<string, { id: string; name: string; arguments: string }>();
  let usage: { inputTokens?: number; outputTokens?: number; costUsd?: number } | undefined;
  let finishReason: string | undefined;
  let first = false;
  const soFar = () => ({ text, toolCalls: [...toolCalls.values()], finishReason });
  const stopped = () => (call.request.signal?.aborted ? "cancelled" : "error") as "cancelled" | "error";
  try {
    for await (const event of streamText(call.protocol, call.connection.base_url, call.apiKey, call.request, call.runtime)) {
      if (!first && (event.type === "text-delta" || event.type === "tool-call-delta")) { first = true; handle.firstToken(); }
      if (event.type === "text-delta") text += event.text;
      else if (event.type === "tool-call-delta") {
        const current = toolCalls.get(event.callId) ?? { id: event.callId, name: event.name, arguments: "" };
        current.name = event.name || current.name;
        current.arguments += event.argumentsDelta;
        toolCalls.set(event.callId, current);
      } else if (event.type === "completed") {
        usage = event.usage;
        finishReason = event.finishReason;
      } else if (event.type === "error") handle.fail(new MangaError("PROVIDER_UNAVAILABLE", event.message), "error", soFar());
      yield event;
    }
    handle.finish(soFar(), usage);
  } catch (error) {
    handle.fail(error, stopped(), soFar());
    throw error;
  } finally {
    // The reader stopped before the answer was complete (it threw, or the run was cut short): nothing more will come, and what did is kept.
    handle.fail(new Error("the application stopped reading the answer before it was complete"), stopped(), soFar());
  }
}

export async function modelComplete(app: AgentRunHost, call: { runId: string; step: number; kind: "model" | "compaction"; name: string; connection: ConnectionRow; apiKey: string; protocol: "openai-responses" | "openai-chat-completions"; runtime: AiRuntimeId; request: TextRequest; delivery?: readonly DeliveryNote[] }) {
  const handle = app.trace.begin({
    runId: call.runId, step: call.step, kind: call.kind, name: call.name,
    connection: { id: call.connection.id, modelId: call.connection.model_id, protocol: `${call.protocol} · ${call.runtime}` },
    request: recordedRequest(call.request), secrets: [call.apiKey], delivery: call.delivery,
  });
  try {
    const result = await completeText(call.protocol, call.connection.base_url, call.apiKey, call.request, call.runtime);
    handle.finish({ text: result.text, toolCalls: result.toolCalls }, result.usage);
    return result;
  } catch (error) {
    handle.fail(error, call.request.signal?.aborted ? "cancelled" : "error");
    throw error;
  }
}

export async function toolCall(app: AgentRunHost, runId: string, step: number, grant: ScopeGrant, command: { commandId: string; idempotencyKey: string; input: unknown }): Promise<CommandResult> {
  const handle = app.trace.begin({ runId, step, kind: "tool", name: command.commandId, request: { commandId: command.commandId, input: command.input } });
  try {
    const result = withEmptyScopeNote(grant, command.commandId, await app.call(grant.actor, command, grant.handle));
    if (result.status === "ok") handle.finish(result);
    else handle.fail(result.error ?? new Error("the command failed"), "error", result);
    return result;
  } catch (error) {
    handle.fail(error);
    throw error;
  }
}

export function persistRunMessage(app: AgentRunHost, runId: string, message: ChatMessage) {
  app.store.sqlite.prepare("INSERT INTO agent_messages(id, run_id, role, text, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(
    createId("msg"),
    runId,
    message.role,
    message.content,
    JSON.stringify({ toolCalls: message.toolCalls, toolCallId: message.toolCallId }),
    new Date().toISOString(),
  );
}

/**
 * Give a task its pictures. A text model that was verified to see them gets them with the question; otherwise a vision
 * model reads them first and its reading goes in as text, labelled as a reading. With neither, the run stops and says so:
 * it never answers as if it had seen a picture it did not.
 */
/**
 * The bytes of a run's frozen stills (计划 4.4). A kept picture is sent as it was frozen (the same bytes, checked against its hash). One whose retention
 * period is over is taken again from its source, but only from the same revision and the same file; when the source changed or is gone the run stops
 * and says why, instead of sending a different picture (CTX-02). The delivery notes say which was which, for the call record.
 */
export async function frozenImageParts(app: AgentRunHost, runId: string, images: FrozenImage[], signal: AbortSignal): Promise<{ parts: ImagePart[]; delivery: DeliveryNote[] }> {
  const parts: ImagePart[] = [];
  const delivery: DeliveryNote[] = [];
  for (const image of images) {
    if (typeof image.base64 === "string") {
      parts.push({ mediaType: image.mediaType, base64: image.base64 });
      delivery.push({ kind: "image", bytes: image.bytes });
      continue;
    }
    const kept = image.expired ? undefined : runMedia(app.store, runId, image.hash);
    if (kept) {
      parts.push({ mediaType: image.mediaType, base64: kept.toString("base64") });
      delivery.push({ kind: "image", bytes: kept.length });
      continue;
    }
    const origin = image.origin;
    const stamp = sourceStamp(app.store, origin.resourceRevisionId);
    const same = latestRevision(app.store, origin.resourceId) === origin.resourceRevisionId && stamp !== null
      && (!image.stamp || (image.stamp.size === stamp.size && image.stamp.mtimeMs === stamp.mtimeMs));
    const changed = (reason: string) => new MangaError("REVISION_CONFLICT", "这次任务附上的图像已过保留期，而它的来源已经改变或不在了，无法再发送同一画面。请重新发起任务。", { details: { reason, resourceId: origin.resourceId } });
    if (!same) throw changed("media-source-changed");
    let again;
    try {
      again = await app.materials.extractAgain(origin, image, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      throw changed("media-source-unreadable");
    }
    parts.push({ mediaType: again.mediaType, base64: again.base64 });
    delivery.push({ kind: "image", bytes: again.bytes, reason: "expired-reextracted" });
  }
  return { parts, delivery };
}

/**
 * The whole PDFs and the clip a run sends (计划 4.5). A PDF is read now and must still be the file the task was sent with. The clip is the kept one; after
 * the retention period it is cut again from the same file, or the run stops and says why. The delivery notes are the ones decided at send time.
 */
export async function frozenNativeParts(app: AgentRunHost, runId: string, media: FrozenMedia, signal: AbortSignal): Promise<{ files: FilePart[]; videos: VideoPart[]; delivery: DeliveryNote[] }> {
  const files: FilePart[] = (media.files ?? []).map((file) => ({ mediaType: "application/pdf", filename: file.filename, base64: readFrozenFile(app.store, file).toString("base64"), pages: file.pages }));
  const delivery = [...(media.delivery ?? [])];
  const videos: VideoPart[] = [];
  const clip = media.clip;
  if (clip) {
    let bytes = clip.expired ? undefined : runMedia(app.store, runId, clip.hash);
    if (!bytes) {
      const changed = (reason: string) => new MangaError("REVISION_CONFLICT", "这次任务附上的视频片段已过保留期，而视频文件已经改变或不在了，无法再发送同一段。请重新发起任务。", { details: { reason, resourceId: clip.resourceId } });
      const stamp = sourceStamp(app.store, clip.revisionId);
      const same = latestRevision(app.store, clip.resourceId) === clip.revisionId && stamp !== null && (!clip.stamp || (clip.stamp.size === stamp.size && clip.stamp.mtimeMs === stamp.mtimeMs));
      if (!same) throw changed("media-source-changed");
      try {
        bytes = await app.videos.clipBytes(clip.resourceId, clip.revisionId, clip.startMs, clip.endMs - clip.startMs, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        throw changed("media-source-unreadable");
      }
      const at = delivery.findIndex((note) => note.kind === "video");
      if (at >= 0) delivery[at] = { ...delivery[at]!, bytes: bytes.length, reason: DELIVERY_REASONS.expired };
    }
    videos.push({ mediaType: "video/mp4", base64: bytes.toString("base64"), seconds: clip.seconds });
  }
  return { files, videos, delivery };
}

export async function attachImages(app: AgentRunHost, runId: string, textConnection: ConnectionRow, messages: ChatMessage[], images: FrozenImage[], parts: ImagePart[], question: string, signal: AbortSignal, delivery?: readonly DeliveryNote[]): Promise<void> {
  const route = visionRoute(app, textConnection);
  if (route.kind === "none") {
    const existing = app.store.sqlite.prepare("SELECT id FROM agent_messages WHERE run_id = ? AND role = 'assistant'").get(runId);
    if (!existing) {
      app.store.sqlite.prepare("INSERT INTO agent_messages(id, run_id, role, text, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(createId("msg"), runId, "assistant", `缺少图像能力：${route.reason}。附上的图像没有被读取，我也无法描述它们。`, JSON.stringify({ completed: true, missing: "vision" }), new Date().toISOString());
    }
    throw new MangaError("MODEL_CAPABILITY_MISSING", route.reason, { details: { capability: "vision" } });
  }
  const lastUser = messages.map((message) => message.role).lastIndexOf("user");
  if (route.kind === "direct") {
    if (lastUser >= 0) messages[lastUser] = { ...messages[lastUser]!, images: parts };
    return;
  }
  const isReading = (message: ChatMessage) => message.role === "system" && message.content.startsWith(VISION_READING_MARK);
  const at = messages.findIndex(isReading);
  let reading = at >= 0 ? messages.splice(at, 1)[0] : undefined;
  if (!reading) {
    const sight = route.connection;
    const sightKey = sight.credential_ref ? await readCredential(app, sight.credential_ref) : undefined;
    if (sightKey === undefined) throw new MangaError("AUTHENTICATION_FAILED", "vision connection is missing credentials");
    const result = await modelComplete(app, { runId, step: 0, kind: "model", name: "vision-reading", delivery, connection: sight, apiKey: sightKey, protocol: sight.protocol, runtime: sight.runtime === "pi" ? "pi" : "native", request: {
      model: sight.model_id,
      messages: [{
        role: "user",
        content: `${renderImages(images)}\n\n请逐张按编号说明：1) 客观描述画面里与下面问题有关的内容；2) 画面中的文字逐字抄录，认不准的字标出；3) 看不清或无法判断的地方写“无法确认”，不要猜测，也不要补充画面之外的剧情。\n\n用户的问题（只用来判断关注点）：${question}`,
        images: parts,
      }],
      signal,
      timeoutMs: sight.timeout_ms,
    } });
    reading = { role: "system", content: `${VISION_READING_MARK}以下是视觉模型对附上的图像的识别结果，不是原图，其中的“无法确认”处没有读到。\n\n${result.text}` };
    persistRunMessage(app, runId, reading);
  }
  messages.splice(lastUser >= 0 ? Math.min(lastUser, messages.length) : messages.length, 0, reading);
}

export async function runAgentLoop(app: AgentRunHost, runId: string, grant: ScopeGrant, text: string, signal: AbortSignal, budget: AgentLoopBudget, runtime: AiRuntimeId) {
  const runRow = app.store.sqlite.prepare("SELECT snapshot_json, usage_json, checkpoint_json, created_at FROM agent_runs WHERE id = ?").get(runId) as { snapshot_json: string | null; usage_json: string | null; checkpoint_json: string | null; created_at: string } | undefined;
  const snapshot = runRow?.snapshot_json ? safeJsonValue(runRow.snapshot_json) as {
    history?: ChatMessage[];
    connectionId?: string | null;
    materials?: Array<{ resourceId: string; revisionId: string; title: string }>;
    selection?: { resourceId?: string; partId?: string; quote?: string; range?: { start: number; end: number } } | { blocked?: string };
    notes?: Array<{ objectId: string; revision: number; title: string; text?: string }>;
    contextText?: string | null;
    media?: FrozenMedia;
  } : {};
  const connection = snapshot.connectionId
    ? app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ?").get(snapshot.connectionId) as ConnectionRow | undefined
    : app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE purpose = 'text' LIMIT 1").get() as ConnectionRow | undefined;
  const tools: ToolDefinition[] = [...AGENT_COMMANDS, ...AGENT_PROJECT_COMMANDS, ...AGENT_OPT_IN_COMMANDS].filter((commandId) => grant.allowedCommands.includes(commandId) && app.runtime.gateway.has(commandId)).map((commandId) => ({
    name: commandId,
    description: TOOL_DESCRIPTIONS[commandId] ?? commandId,
    parameters: agentToolSchema(commandId, toolParameters(commandId)),
  }));
  if (!connection) {
    const existing = app.store.sqlite.prepare("SELECT id FROM agent_messages WHERE run_id = ? AND role = 'assistant'").get(runId);
    if (!existing) {
      app.store.sqlite.prepare("INSERT INTO agent_messages(id, run_id, role, text, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(createId("msg"), runId, "assistant", "未配置模型。本地查询与笔记命令仍可通过界面使用。", JSON.stringify({ completed: true }), new Date().toISOString());
    }
    return { text: "未配置模型", tools: [] as Array<{ commandId: string; result: unknown }>, steps: 0 };
  }
  if (connection.purpose !== "text") throw new MangaError("MODEL_CAPABILITY_MISSING", "agent runs require a text connection");
  app.store.sqlite.prepare("UPDATE agent_runs SET model_id = ? WHERE id = ?").run(connection.model_id, runId);
  const apiKey = connection.credential_ref ? await readCredential(app, connection.credential_ref) : undefined;
  if (apiKey === undefined) throw new MangaError("AUTHENTICATION_FAILED", "text connection is missing credentials");
  const protocol = connection.protocol as "openai-responses" | "openai-chat-completions";
  const frozenRuntime = (runtime === "pi" ? "pi" : "native") as AiRuntimeId;
  // The model's profile is read as the loop starts, so a window or an answer length changed in the settings applies to a retry as well (A-82).
  const { profile, budget: model } = budgetOfConnection(connection);
  const extras = requestLimits(profile);
  const shares = contextShares(model.contextTokens, text);
  const clipped = truncateToTokens(text, Math.floor(model.contextTokens * 0.6)).text;
  const history = snapshot.history ?? sessionHistory(app, runId, shares.history);
  let runMessages = loadRunMessages(app, runId);
  if (!runMessages.some((message) => message.role === "user")) {
    const user: ChatMessage = { role: "user", content: clipped };
    persistRunMessage(app, runId, user);
    runMessages = [...runMessages, user];
  }
  // The frozen materials are what the model may rely on; the request is the last message so the
  // visible material and the user's instruction agree with the snapshot the receipt records.
  // The snapshot keeps the message built at send time, so a retry sends exactly the frozen material.
  const frozenContext = typeof snapshot.contextText === "string" ? snapshot.contextText : undefined;
  const materialMessage = frozenContext ? { role: "system" as const, content: clipMaterial(frozenContext, shares.material) } : materialContextMessage(app, snapshot, shares.material);
  let messages: ChatMessage[] = [...history, ...(materialMessage ? [materialMessage] : []), ...runMessages];
  const images: FrozenImage[] = snapshot.media?.images ?? [];
  // What this run delivers of its material, for the record of every request it makes (计划 4.5).
  const delivery: DeliveryNote[] = [];
  if (images.length) {
    const resolved = await frozenImageParts(app, runId, images, signal);
    delivery.push(...resolved.delivery);
    await attachImages(app, runId, connection, messages, images, resolved.parts, clipped, signal, delivery);
  }
  if (snapshot.media?.files?.length || snapshot.media?.clip) {
    const native = await frozenNativeParts(app, runId, snapshot.media, signal);
    const lastUser = messages.map((message) => message.role).lastIndexOf("user");
    if (lastUser >= 0) messages[lastUser] = { ...messages[lastUser]!, ...(native.files.length ? { files: native.files } : {}), ...(native.videos.length ? { videos: native.videos } : {}) };
    delivery.push(...native.delivery);
  } else delivery.push(...(snapshot.media?.delivery ?? []));
  const toolResults: Array<{ commandId: string; result: unknown }> = [];
  const usage = runRow?.usage_json ? safeJsonValue(runRow.usage_json) as { costUsd?: number; steps?: number; compactions?: number } : {};
  const checkpoint = runRow?.checkpoint_json ? safeJsonValue(runRow.checkpoint_json) as { step?: number; costUsd?: number; at?: string } : {};
  // Tools that already ran since the last finished step were run by an attempt a restart cut short; app attempt does not run them again. Tools it runs itself never count.
  const cutShortSince = checkpoint.at ?? runRow?.created_at ?? "";
  const ranHere = new Set<string>();
  let costUsd = usage.costUsd ?? checkpoint.costUsd;
  let compactions = usage.compactions ?? 0;
  // What the service counted for the input, against what was estimated, scales the estimates of the next requests.
  let calibration = 1;
  // A model that does not call tools is talked to without them; the profile says which it is.
  // The descriptions of the tools are a cost every request pays. A window too small to hold them beside a conversation runs the task as a plain conversation, and the run says so.
  const toolsFit = toolsTokens(tools) <= Math.floor(model.contextTokens * 0.5);
  const offered = profile.capabilities.includes("tools") && toolsFit ? tools : [];
  const toolsOmitted = profile.capabilities.includes("tools") && !toolsFit && tools.length > 0;
  let stepsUsed = typeof checkpoint.step === "number" ? checkpoint.step : messages.filter((message) => message.role === "assistant" && message.toolCalls?.length).length;
  const summarize = async (transcript: string, attempt: number, started: number): Promise<string> => {
    // Each attempt gives the model less to read: the end of the conversation, which the rest of the task leans on most.
    const cap = Math.max(512, Math.floor(model.contextWindow * 0.5) - 300);
    const share = attempt === 1 ? 1 : attempt === 2 ? 0.5 : 0.25;
    const request: TextRequest = {
      model: connection.model_id,
      messages: [{ role: "system", content: COMPACTION_PROMPT }, { role: "user", content: tailToTokens(transcript, Math.floor(cap * share)) }],
      signal,
      timeoutMs: connection.timeout_ms,
      maxOutputTokens: profile.capabilities.includes("reasoning") ? 2_048 : 1_024,
      maxTokensField: extras.maxTokensField,
      ...(extras.reasoningEffort ? { reasoningEffort: extras.reasoningEffort } : {}),
      contextWindow: model.contextWindow,
    };
    const done = await modelComplete(app, { runId, step: started, kind: "compaction", name: `compaction#${attempt}`, connection, apiKey, protocol, request, runtime: frozenRuntime });
    return done.text;
  };
  for (let step = stepsUsed; step < budget.maxSteps; step += 1) {
    if (signal.aborted) throw new MangaError("CANCELLED", "run cancelled", { retryable: true });
    // The request is made to fit before it is sent: old tool results are cut down, then the earlier conversation becomes a summary the model writes.
    // A service that still refuses the request as too long is believed over the estimate: the budget is cut and the request fitted again, twice at most.
    let scale = 1;
    let attemptsLeft = 3;
    const accumulated = new Map<string, { name: string; arguments: string }>();
    let completed = false;
    let finishReason = "";
    let assistant = "";
    while (true) {
      const fitted = await fitContext({
        messages,
        tools: offered,
        budget: { ...model, contextTokens: Math.max(256, Math.floor(model.contextTokens * scale)) },
        calibration,
        summarize: (transcript, attempt) => summarize(transcript, attempt, step),
      }).catch((error) => {
        // Once the service has said the request is too long, not being able to cut it further means the window in the settings is not the model's own.
        if (scale < 1 && error instanceof MangaError && (error.details as { reason?: string } | undefined)?.reason === "context_too_large") throw refusedByService(model.contextWindow);
        throw error;
      });
      if (fitted.trimmed || fitted.compacted) {
        // What the context was made to fit by is part of the story of the run: the model sees less than the conversation holds.
        const budgetTokens = Math.max(256, Math.floor(model.contextTokens * scale));
        if (fitted.trimmed) app.trace.note({ runId, step, kind: "compaction", name: "trim-tool-results", request: { budgetTokens, tokensBefore: fitted.tokensBefore }, response: { trimmed: fitted.trimmed, tokensBefore: fitted.tokensBefore, tokensAfter: fitted.tokensAfter } });
        if (fitted.compacted) app.trace.note({ runId, step, kind: "compaction", name: "compaction", request: { budgetTokens, tokensBefore: fitted.tokensBefore }, response: fitted.compacted });
        messages = fitted.messages;
        if (fitted.compacted) {
          compactions += 1;
          app.store.sqlite.prepare("UPDATE agent_runs SET usage_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ costUsd, steps: step, compactions, ...(toolsOmitted ? { toolsOmitted } : {}) }), new Date().toISOString(), runId);
        }
      }
      accumulated.clear();
      completed = false;
      finishReason = "";
      assistant = "";
      try {
        for await (const event of modelStream(app, {
          runId, step, connection, apiKey, protocol, runtime: frozenRuntime, delivery,
          request: { model: connection.model_id, messages: fitted.messages, tools: offered.length ? offered : undefined, signal, timeoutMs: connection.timeout_ms, ...extras },
        })) {
          if (event.type === "text-delta") {
            assistant += event.text;
            app.store.sqlite.prepare("UPDATE agent_runs SET live_text = ?, updated_at = ? WHERE id = ?").run(assistant, new Date().toISOString(), runId);
            // The service is asked to stop at the model's longest answer; one that goes on regardless is stopped here.
            if (assistant.length > model.maxOutputTokens * 6 + 2_000) throw new MangaError("BUDGET_EXCEEDED", "模型的回答超过了设置里的最大输出，任务已停止。可以在模型设置里调大“最大输出”。", { details: { reason: "max_output", limit: model.maxOutputTokens } });
          }
          if (event.type === "tool-call-delta") {
            const current = accumulated.get(event.callId) ?? { name: event.name, arguments: "" };
            current.name = event.name || current.name;
            current.arguments += event.argumentsDelta;
            accumulated.set(event.callId, current);
          }
          if (event.type === "completed") {
            completed = true;
            finishReason = event.finishReason;
            if (event.usage && "costUsd" in event.usage && typeof event.usage.costUsd === "number") {
              costUsd = (costUsd ?? 0) + event.usage.costUsd;
            }
            // Tokens are added up over the steps of a run; a service that does not state them leaves the columns empty.
            if (event.usage && (typeof event.usage.inputTokens === "number" || typeof event.usage.outputTokens === "number")) {
              app.store.sqlite.prepare("UPDATE agent_runs SET input_tokens = COALESCE(input_tokens, 0) + ?, output_tokens = COALESCE(output_tokens, 0) + ? WHERE id = ?").run(event.usage.inputTokens ?? 0, event.usage.outputTokens ?? 0, runId);
              calibration = calibrate(calibration, event.usage.inputTokens, contextTokens(fitted.messages, offered));
            }
          }
          if (event.type === "error") throw new MangaError("PROVIDER_UNAVAILABLE", event.message, { retryable: event.retryable });
        }
        break;
      } catch (error) {
        if (isContextOverflow(error) && attemptsLeft > 1 && !assistant && !accumulated.size) {
          attemptsLeft -= 1;
          // Cut from what was sent, not from the budget: the service has said that was too much.
          scale = Math.min(scale, (fitted.tokensAfter / model.contextTokens) * 0.7);
          continue;
        }
        if (isContextOverflow(error)) throw refusedByService(model.contextWindow);
        throw error;
      }
    }
    if (budget.maxCostUsd !== undefined && costUsd !== undefined && costUsd > budget.maxCostUsd) {
      throw new MangaError("BUDGET_EXCEEDED", "agent exceeded max cost");
    }
    if (!accumulated.size) {
      // A turn that ends with neither a call nor a word has not answered: shown as done it would be an empty reply with nothing to press. The run fails and a retry
      // asks again from app step (what the tools did is kept), so the blank turn is not kept either.
      if (!assistant.trim()) {
        throw new MangaError("PROVIDER_UNAVAILABLE", finishReason === "length"
          ? "模型还没写出回答就用完了最大输出。可以在模型设置里调大“最大输出”后重试。"
          : "模型这次没有给出回答。可以重试；多次如此时，可以在设置里换一个模型。", { retryable: true, details: { reason: "empty_answer", finishReason: finishReason || null } });
      }
      persistRunMessage(app, runId, { role: "assistant", content: assistant });
      return { text: assistant, tools: toolResults, completed, costUsd, steps: step + 1, compactions, toolsOmitted };
    }
    if (!completed) throw new MangaError("PROVIDER_UNAVAILABLE", "stream ended before the provider completed the tool call", { retryable: true });
    for (const [callId, call] of accumulated) {
      // A call that takes nothing may come with no arguments at all, not even "{}". That is the empty object, and it is kept as one, so the conversation sent back
      // reads the same to a service that parses it.
      if (!call.arguments.trim()) call.arguments = "{}";
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
      if (!grant.allowedCommands.includes(commandId) || !app.runtime.gateway.has(commandId)) {
        app.store.sqlite.prepare("INSERT INTO agent_tool_events(id, run_id, command_id, status, input_summary, created_at) VALUES (?,?,?,?,?,?)").run(createId("tool"), runId, commandId, "denied", call.arguments.slice(0, 200), new Date().toISOString());
        throw new MangaError("FORBIDDEN", `tool ${commandId} is not admitted`);
      }
      // A project's agent works in its own project: the command takes it from the task, so the model never has to copy an id.
      if (AGENT_PROJECT_COMMANDS.includes(commandId) && takesProject(commandInputJsonSchema(commandId)) && parsed && typeof parsed === "object" && !("projectId" in parsed)) {
        try { parsed = { ...(parsed as Record<string, unknown>), projectId: app.agentAccess.projectOf(grant) }; } catch { /* the project is gone: the command itself says so */ }
      }
      // A command that works in a context (the reading position) works in the one the conversation runs in, whatever the model wrote.
      if (takesContext(commandInputJsonSchema(commandId)) && parsed && typeof parsed === "object") {
        parsed = { ...(parsed as Record<string, unknown>), contextId: app.agentAccess.contextOf(grant) };
      }
      const inputHash = createHash("sha256").update(JSON.stringify(parsed ?? {})).digest("hex");
      const summary = toolInputSummary(call.arguments, inputHash);
      // Only in the step a restart cut short: the command that already ran there is not run again, whatever words the model now uses for it. Every other call runs, and a call that repeats an
      // earlier one asks again (the board may have changed since).
      const prior = step === stepsUsed
        ? (app.store.sqlite.prepare("SELECT id, result_summary FROM agent_tool_events WHERE run_id = ? AND command_id = ? AND status = 'executed' AND created_at > ? ORDER BY created_at, rowid").all(runId, commandId, cutShortSince) as Array<{ id: string; result_summary: string | null }>).find((event) => !ranHere.has(event.id))
        : undefined;
      let result: CommandResult;
      if (prior?.result_summary) {
        ranHere.add(prior.id);
        result = safeJsonValue(prior.result_summary) as CommandResult;
      } else {
        result = await toolCall(app, runId, step, grant, { commandId, idempotencyKey: `${runId}:${commandId}:${inputHash}`, input: parsed });
        const eventId = createId("tool");
        ranHere.add(eventId);
        app.store.sqlite.prepare("INSERT INTO agent_tool_events(id, run_id, command_id, status, input_summary, result_summary, created_at) VALUES (?,?,?,?,?,?,?)").run(
          eventId, runId, commandId, result.status === "ok" ? "executed" : "failed", summary, JSON.stringify(result).slice(0, 8000), new Date().toISOString(),
        );
      }
      toolResults.push({ commandId, result });
      const assistantCall: ChatMessage = { role: "assistant", content: "", toolCalls: [{ id: callId, name: commandId, arguments: call.arguments }] };
      const toolMessage: ChatMessage = { role: "tool", toolCallId: callId, content: JSON.stringify(result) };
      persistRunMessage(app, runId, assistantCall);
      persistRunMessage(app, runId, toolMessage);
      messages.push(assistantCall, toolMessage);
    }
    app.store.sqlite.prepare("UPDATE agent_runs SET usage_json = ?, checkpoint_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ costUsd, steps: step + 1, compactions, ...(toolsOmitted ? { toolsOmitted } : {}) }),
      JSON.stringify({ step: step + 1, costUsd, at: new Date().toISOString() }),
      new Date().toISOString(),
      runId,
    );
  }
  throw new MangaError("BUDGET_EXCEEDED", `任务用完了 ${budget.maxSteps} 步仍没有结束。可以在设置的“智能体”里调高步数上限，或把任务拆小。`, { details: { reason: "max_steps", limit: budget.maxSteps } });
}

export function sessionHistoryForNewRun(app: AgentRunHost, sessionId: string, maxTokens: number): ChatMessage[] {
  if (maxTokens <= 0) return [];
  const earlier = app.store.sqlite.prepare("SELECT id, input_text FROM agent_runs WHERE session_id = ? AND status = 'succeeded' ORDER BY created_at DESC LIMIT 50").all(sessionId) as Array<{ id: string; input_text: string }>;
  const history: ChatMessage[] = [];
  let used = 0;
  for (const run of earlier) {
    const reply = (app.store.sqlite.prepare("SELECT text FROM agent_messages WHERE run_id = ? AND role = 'assistant' ORDER BY created_at").all(run.id) as Array<{ text: string }>).map((row) => row.text).filter(Boolean).join("\n");
    const turn: ChatMessage[] = [{ role: "user", content: run.input_text }, ...(reply ? [{ role: "assistant" as const, content: reply }] : [])];
    const size = contextTokens(turn);
    if (used + size > maxTokens) {
      // The newest exchange is the one the next question most likely leans on: when only it is too long, its answer is cut to fit and the cut is said.
      if (!history.length && reply) {
        const room = maxTokens - contextTokens([turn[0]!]) - 16;
        if (room > 64) history.unshift(turn[0]!, { role: "assistant", content: `${truncateToTokens(reply, room).text}\n（上一次的回答较长，这里只带入了前面的部分。）` });
      }
      break;
    }
    used += size;
    history.unshift(...turn);
  }
  return history;
}

/** Frozen snapshot history is preferred; app remains for runs created before checkpoints existed. */
export function sessionHistory(app: AgentRunHost, runId: string, maxTokens: number): ChatMessage[] {
  const current = app.store.sqlite.prepare("SELECT session_id, created_at FROM agent_runs WHERE id = ?").get(runId) as { session_id: string; created_at: string } | undefined;
  if (!current || maxTokens <= 0) return [];
  return sessionHistoryForNewRun(app, current.session_id, maxTokens).filter((message, index, all) => {
    // Drop the current run's own user line if it was included by created_at ordering on older rows.
    return !(message.role === "user" && index === all.length - 1 && message.content === "");
  });
}

export function cancelRun(app: AgentRunHost, envelope: CommandEnvelope) {
  app.assertWritable();
  const input = envelope.input as { runId: string };
  const live = app.runAbort.get(input.runId);
  live?.abort();
  const changed = app.store.sqlite.prepare("UPDATE agent_runs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued','running','waiting_input')").run(new Date().toISOString(), input.runId).changes;
  return { cancelled: Boolean(live) || changed > 0 };
}

export function retryRun(app: AgentRunHost, envelope: CommandEnvelope) {
  app.assertWritable();
  const input = envelope.input as { runId: string };
  const run = app.store.sqlite.prepare("SELECT * FROM agent_runs WHERE id = ?").get(input.runId) as {
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
  const grant = app.grants.get(run.grant_handle);
  if (!grant) throw new MangaError("FORBIDDEN", "original run authorization is no longer available");
  // A retry takes the step limit as the settings are now, so a task that stopped at its steps can go on after the person raised them. The time is the run's own: its
  // deadline was set when it began and a retry does not extend it.
  const budget: AgentLoopBudget = { ...(JSON.parse(run.budget_json) as AgentLoopBudget), maxSteps: readAgentSettings(app.store).limits.maxSteps };
  const runtime = (run.runtime === "pi" ? "pi" : "native") as AiRuntimeId;
  app.store.sqlite.prepare("UPDATE agent_runs SET status = 'running', error_json = NULL, budget_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(budget), new Date().toISOString(), run.id);
  startRunLoop(app, run.id, grant, run.input_text, budget, runtime);
  return { runId: run.id, sessionId: run.session_id, grantHandle: run.grant_handle, status: "running", inputText: run.input_text };
}

export function getRun(app: AgentRunHost, envelope: CommandEnvelope) {
  const input = envelope.input as { runId: string };
  const row = app.store.sqlite.prepare("SELECT id, session_id, status, grant_handle, input_text, error_json, budget_json, usage_json, snapshot_json, runtime, read_resource_ids_json, live_text, deadline_at, created_at, updated_at FROM agent_runs WHERE id = ?").get(input.runId) as {
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
  const toolRows = app.store.sqlite.prepare("SELECT command_id, status, input_summary, result_summary FROM agent_tool_events WHERE run_id = ? ORDER BY created_at").all(input.runId) as Array<{ command_id: string; status: string; input_summary: string; result_summary: string | null }>;
  const messages = app.store.sqlite.prepare("SELECT role, text, payload_json FROM agent_messages WHERE run_id = ? ORDER BY created_at").all(input.runId) as Array<{ role: string; text: string; payload_json: string | null }>;
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
    snapshot: row.snapshot_json ? redactSnapshot(safeJsonValue(row.snapshot_json)) : undefined,
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
    // The visible material receipt: exactly what was frozen for app run, with revisions.
    materials: (safeJsonValue(row.snapshot_json ?? "{}") as { materials?: unknown[] }).materials ?? [],
    selection: (safeJsonValue(row.snapshot_json ?? "{}") as { selection?: unknown }).selection,
    // The frozen system message, so the model request can be checked against what the user was shown.
    contextText: (safeJsonValue(row.snapshot_json ?? "{}") as { contextText?: string | null }).contextText ?? null,
    media: publicMedia((safeJsonValue(row.snapshot_json ?? "{}") as { media?: FrozenMedia }).media),
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
