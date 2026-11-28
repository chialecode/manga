/** One agent run: the model calls, the tool calls, live streaming events, and run continuation/regeneration actions. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import {
  commandInputJsonSchema,
  MangaError,
  createId,
  type AgentCitation,
  type AgentErrorCode,
  type AgentRunActionResult,
  type AgentRunUsage,
  type AgentSearchStep,
  type AgentServerToolStep,
  type AgentStopReason,
  type AgentToolStep,
  type CommandEnvelope,
  type CommandResult,
  type FileUploadPurpose,
  type ScopeGrant,
  type StreamUserAttachment,
} from "@manga/contracts";
import { DEFAULT_MODEL_PROFILE } from "@manga/contracts/models";
import {
  aggregateServerToolSteps,
  classifyAgentError,
  completeText,
  deleteDeepSeekFile,
  extractExpiredFileIds,
  formatLatestReminder,
  inferDeepSeekFilePurpose,
  stopReasonOf,
  streamText,
  uploadDeepSeekFile,
  type AiRuntimeId,
  type ChatMessage,
  type Citation,
  type FilePart,
  type ImagePart,
  type MessageFileRef,
  type ServerToolEvent,
  type StreamEvent,
  type TextRequest,
  type ToolDefinition,
  type VideoPart,
} from "@manga/model-protocol";
import type { Mutation } from "@manga/storage-drizzle";
import {
  budgetOf,
  budgetOfConnection,
  withChoice,
  type ChatChoice,
  calibrate,
  COMPACTION_PROMPT,
  contextTokens,
  fitContext,
  tailToTokens,
  toolsTokens,
  truncateToTokens,
} from "../agent-context.ts";
import { readAgentSettings } from "../agent-settings.ts";
import { requestLimits } from "../model-probe.ts";
import { connectionAccess } from "../providers/access.ts";
import { estimateChatCost, providerFileOf, recordServiceUse } from "../providers/usage.ts";
import { beginLiveStep, endLiveExtras, liveRunExtras, startLiveExtras } from "../ops/live-extras.ts";
import { withEmptyScopeNote } from "../agent-scope.ts";
import { AGENT_PROJECT_COMMANDS, agentToolSchema, takesContext, takesProject } from "../creative/agent-access.ts";
import { recordedRequest, type DeliveryNote } from "../agent-trace.ts";
import { AGENT_COMMANDS, AGENT_OPT_IN_COMMANDS } from "../commands/access.ts";
import { publicMedia, renderImages, type FrozenImage, type FrozenMedia } from "../agent-materials.ts";
import {
  VISION_READING_MARK,
  TOOL_DESCRIPTIONS,
  toolInputSummary,
  toolParameters,
  type AgentLoopBudget,
  contextShares,
  clipMaterial,
  refusedByService,
  isContextOverflow,
  type ConnectionRow,
  redactSnapshot,
  safeJsonValue,
} from "../product-helpers.ts";
import { visionRoute } from "./connections.ts";
import { latestRevision, runMedia, sourceStamp } from "../agent-media.ts";
import { DELIVERY_REASONS, readFrozenFile, type FrozenFile } from "../agent-native-input.ts";
import { titleFrom } from "../conversations.ts";
import { chatConnection, loadRunMessages, materialContextMessage, startRunLoop } from "./agent.ts";
import { currentRuntime } from "./settings.ts";
import type { AgentCommandHost } from "./shared.ts";

/** What these commands use of the application. */
export type AgentRunHost = AgentCommandHost;

/** Throttle interval for SQLite `UPDATE agent_runs SET live_text = ...` writes during streaming. */
export const LIVE_TEXT_FLUSH_MS = 280;

const URL_IN_TEXT = /https?:\/\/[^\s<>()[\]"']+/i;
const NOT_SUPERSEDED_SQL = "(usage_json IS NULL OR NOT json_valid(usage_json) OR json_extract(usage_json, '$.supersededBy') IS NULL)";

export type FrozenAttachment = {
  id: string;
  pathHandle: string;
  name: string;
  kind: "image" | "file";
  mimeType: string;
  bytes: number;
  purpose?: FileUploadPurpose;
};

export type RunLoopOptions = {
  continuePrefill?: boolean;
  prefixText?: string;
  prefixReasoning?: string;
  replaceMessageId?: string;
  /** When true, caller (`startRunLoop`) owns `endLiveExtras` after persisting terminal run status. */
  keepLiveAfterReturn?: boolean;
};

export type RunLoopResult = {
  text: string;
  tools: Array<{ commandId: string; result: unknown }>;
  completed?: boolean;
  costUsd?: number;
  steps: number;
  compactions?: number;
  toolsOmitted?: boolean;
  thinkingRaised?: boolean;
  costEstimated?: boolean;
  pricesCheckedAt?: string;
  modelId?: string;
  stopReason?: AgentStopReason;
  canContinue?: boolean;
  refusal?: boolean;
  generatedTitle?: string;
  reasoningStartedAt?: string;
  reasoningElapsedMs?: number;
  citations?: AgentCitation[];
  usage?: AgentRunUsage;
  toolSteps?: Record<string, { startedAt?: string; elapsedMs?: number; summary?: string; error?: string }>;
};

type UploadSource =
  | { kind: "attachment"; attachment: FrozenAttachment }
  | { kind: "frozenPdf"; frozenFile: FrozenFile };

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

/** What an answer brought besides its words: thinking, server-side search/browse steps, and cited sources. */
export type AnswerExtras = {
  search?: ServerToolEvent[];
  serverToolSteps?: AgentServerToolStep[];
  citations?: Citation[];
  reasoningStartedAt?: string;
  reasoningElapsedMs?: number;
};

export function persistRunMessage(app: AgentRunHost, runId: string, message: ChatMessage, extras: AnswerExtras = {}) {
  app.store.sqlite.prepare("INSERT INTO agent_messages(id, run_id, role, text, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(
    createId("msg"),
    runId,
    message.role,
    message.content,
    JSON.stringify({
      toolCalls: message.toolCalls, toolCallId: message.toolCallId,
      ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
      ...(message.serverToolCalls?.length ? { serverToolCalls: message.serverToolCalls } : {}),
      ...(extras.search?.length ? { search: extras.search } : {}),
      ...(extras.serverToolSteps?.length ? { serverToolSteps: extras.serverToolSteps } : {}),
      ...(extras.citations?.length ? { citations: extras.citations } : {}),
      ...(extras.reasoningStartedAt ? { reasoningStartedAt: extras.reasoningStartedAt } : {}),
      ...(extras.reasoningElapsedMs !== undefined ? { reasoningElapsedMs: extras.reasoningElapsedMs } : {}),
    }),
    new Date().toISOString(),
  );
}

/** Updates an existing assistant message in place when a continuation appends seamlessly to it. */
function updateContinuedAssistantMessage(
  app: AgentRunHost,
  messageId: string,
  fullText: string,
  message: ChatMessage,
  extras: AnswerExtras,
) {
  const row = app.store.sqlite.prepare("SELECT payload_json FROM agent_messages WHERE id = ?").get(messageId) as { payload_json: string | null } | undefined;
  const prev = (row?.payload_json ? safeJsonValue(row.payload_json) : {}) as {
    reasoning?: string;
    serverToolCalls?: unknown[];
    search?: AgentSearchStep[];
    serverToolSteps?: AgentServerToolStep[];
    citations?: AgentCitation[];
    reasoningStartedAt?: string;
    reasoningElapsedMs?: number;
  };
  const mergedReasoning = [prev.reasoning, message.reasoning].filter((item): item is string => typeof item === "string" && item.length > 0).join("\n\n");
  const mergedServerToolCalls = [...(prev.serverToolCalls ?? []), ...(message.serverToolCalls ?? [])];
  const mergedSearch = [...(prev.search ?? []), ...(extras.search ?? [])];
  const mergedServerToolSteps = [...(prev.serverToolSteps ?? []), ...(extras.serverToolSteps ?? [])];
  const mergedCitations = extras.citations?.length ? extras.citations : prev.citations;
  app.store.sqlite.prepare("UPDATE agent_messages SET text = ?, payload_json = ? WHERE id = ?").run(
    fullText,
    JSON.stringify({
      ...(mergedReasoning ? { reasoning: mergedReasoning } : {}),
      ...(mergedServerToolCalls.length ? { serverToolCalls: mergedServerToolCalls } : {}),
      ...(mergedSearch.length ? { search: mergedSearch } : {}),
      ...(mergedServerToolSteps.length ? { serverToolSteps: mergedServerToolSteps } : {}),
      ...(mergedCitations?.length ? { citations: mergedCitations } : {}),
      ...(prev.reasoningStartedAt ?? extras.reasoningStartedAt ? { reasoningStartedAt: prev.reasoningStartedAt ?? extras.reasoningStartedAt } : {}),
      ...(extras.reasoningElapsedMs !== undefined || prev.reasoningElapsedMs !== undefined
        ? { reasoningElapsedMs: (prev.reasoningElapsedMs ?? 0) + (extras.reasoningElapsedMs ?? 0) }
        : {}),
    }),
    messageId,
  );
}

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
    if (lastUser >= 0) messages[lastUser] = { ...messages[lastUser]!, images: [...(messages[lastUser]!.images ?? []), ...parts] };
    return;
  }
  const isReading = (message: ChatMessage) => message.role === "system" && message.content.startsWith(VISION_READING_MARK);
  const at = messages.findIndex(isReading);
  let reading = at >= 0 ? messages.splice(at, 1)[0] : undefined;
  if (!reading) {
    const sight = route.connection;
    // A vision connection added from a provider is behind the same gate as the run's own: with its plugin off, no request is made (计划 4.1).
    const access = await connectionAccess(app, sight, signal);
    const sightKey = access.apiKey;
    let result: Awaited<ReturnType<typeof modelComplete>>;
    try {
      if (sightKey === undefined) throw new MangaError("AUTHENTICATION_FAILED", "vision connection is missing credentials");
      result = await modelComplete(app, { runId, step: 0, kind: "model", name: "vision-reading", delivery, connection: sight, apiKey: sightKey, protocol: sight.protocol, runtime: sight.runtime === "pi" ? "pi" : "native", request: {
        model: sight.model_id,
        messages: [{
          role: "user",
          content: `${renderImages(images)}\n\n请逐张按编号说明：1) 客观描述画面里与下面问题有关的内容；2) 画面中的文字逐字抄录，认不准的字标出；3) 看不清或无法判断的地方写“无法确认”，不要猜测，也不要补充画面之外的剧情。\n\n用户的问题（只用来判断关注点）：${question}`,
          images: parts,
        }],
        signal: access.signal ?? signal,
        timeoutMs: sight.timeout_ms,
      } });
    } finally {
      access.release();
    }
    reading = { role: "system", content: `${VISION_READING_MARK}以下是视觉模型对附上的图像的识别结果，不是原图，其中的“无法确认”处没有读到。\n\n${result.text}` };
    persistRunMessage(app, runId, reading);
  }
  messages.splice(lastUser >= 0 ? Math.min(lastUser, messages.length) : messages.length, 0, reading);
}

export async function runAgentLoop(
  app: AgentRunHost,
  runId: string,
  grant: ScopeGrant,
  text: string,
  signal: AbortSignal,
  budget: AgentLoopBudget,
  runtime: AiRuntimeId,
  options: RunLoopOptions = {},
): Promise<RunLoopResult> {
  // A connection from a provider plugin is tracked for the length of the run, so turning the plugin off cancels it (计划 4.1).
  const releases: Array<() => void> = [];
  const cleanupTasks: Array<() => Promise<void>> = [];
  try {
    return await agentLoop(app, runId, grant, text, signal, budget, runtime, releases, cleanupTasks, options);
  } finally {
    for (const task of cleanupTasks) {
      try { await task(); } catch { /* best-effort ephemeral cleanup */ }
    }
    for (const release of releases) release();
    if (!options.keepLiveAfterReturn) endLiveExtras(runId);
  }
}

async function agentLoop(
  app: AgentRunHost,
  runId: string,
  grant: ScopeGrant,
  text: string,
  signal: AbortSignal,
  budget: AgentLoopBudget,
  runtime: AiRuntimeId,
  releases: Array<() => void>,
  cleanupTasks: Array<() => Promise<void>>,
  options: RunLoopOptions,
): Promise<RunLoopResult> {
  const runStartedMs = Date.now();
  const runRow = app.store.sqlite.prepare("SELECT session_id, snapshot_json, usage_json, checkpoint_json, created_at FROM agent_runs WHERE id = ?").get(runId) as {
    session_id: string;
    snapshot_json: string | null;
    usage_json: string | null;
    checkpoint_json: string | null;
    created_at: string;
  } | undefined;
  const sessionId = runRow?.session_id ?? grant.sessionId ?? "";
  const snapshot = runRow?.snapshot_json ? safeJsonValue(runRow.snapshot_json) as {
    history?: ChatMessage[];
    connectionId?: string | null;
    choice?: ChatChoice;
    materials?: Array<{ resourceId: string; revisionId: string; title: string }>;
    selection?: { resourceId?: string; partId?: string; quote?: string; range?: { start: number; end: number } } | { blocked?: string };
    notes?: Array<{ objectId: string; revision: number; title: string; text?: string }>;
    contextText?: string | null;
    media?: FrozenMedia;
    fileAttachments?: FrozenAttachment[];
    wantInlineTitle?: boolean;
    fallbackTitle?: string | null;
  } : {};
  const connection = snapshot.connectionId
    ? app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ?").get(snapshot.connectionId) as ConnectionRow | undefined
    : app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE purpose = 'text' LIMIT 1").get() as ConnectionRow | undefined;
  const tools: ToolDefinition[] = [...AGENT_COMMANDS, ...AGENT_PROJECT_COMMANDS, ...AGENT_OPT_IN_COMMANDS]
    .filter((commandId) => grant.allowedCommands.includes(commandId) && app.runtime.gateway.has(commandId) && (commandId !== "web.search" || hasSearchService(app)))
    .map((commandId) => ({
      name: commandId,
      description: TOOL_DESCRIPTIONS[commandId] ?? commandId,
      parameters: agentToolSchema(commandId, toolParameters(commandId)),
    }));
  if (!connection) {
    const existing = app.store.sqlite.prepare("SELECT id FROM agent_messages WHERE run_id = ? AND role = 'assistant'").get(runId);
    if (!existing) {
      app.store.sqlite.prepare("INSERT INTO agent_messages(id, run_id, role, text, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(createId("msg"), runId, "assistant", "未配置模型。本地查询与笔记命令仍可通过界面使用。", JSON.stringify({ completed: true }), new Date().toISOString());
    }
    return { text: "未配置模型", tools: [] as Array<{ commandId: string; result: unknown }>, steps: 0, stopReason: "end_turn" };
  }
  if (connection.purpose !== "text") throw new MangaError("MODEL_CAPABILITY_MISSING", "agent runs require a text connection");
  app.store.sqlite.prepare("UPDATE agent_runs SET model_id = ? WHERE id = ?").run(connection.model_id, runId);
  const access = await connectionAccess(app, connection, signal);
  releases.push(access.release);
  if (access.signal) signal = access.signal;
  const apiKey = access.apiKey;
  if (apiKey === undefined) throw new MangaError("AUTHENTICATION_FAILED", "text connection is missing credentials");
  const protocol = connection.protocol as "openai-responses" | "openai-chat-completions";
  const frozenRuntime = (runtime === "pi" ? "pi" : "native") as AiRuntimeId;
  // The model's profile is read as the loop starts, so a window or an answer length changed in the settings applies to a retry as well (A-82).
  // With the conversation's choice of thinking and window, as it was when the message was sent (A-137).
  const profile = withChoice(budgetOfConnection(connection).profile, snapshot.choice);
  const model = budgetOf(profile);
  const extras = requestLimits(profile, connection.base_url);
  // Guard against sending native `deepseek_web_search` or `deepseek_read_url` / inline `title` to `deepseek-v4-pro` (even for older persisted profiles).
  const modelKey = ((connection as { provider_model?: string | null }).provider_model ?? connection.model_id).toLowerCase();
  const isV4Pro = extras.dialect === "deepseek" && modelKey === "deepseek-v4-pro";
  const nativeSearch = grant.allowedCommands.includes("web.search") && extras.dialect === "deepseek" && !isV4Pro && profile.capabilities.includes("web_search");
  const autoReadUrl = extras.dialect === "deepseek" && !isV4Pro && (nativeSearch || URL_IN_TEXT.test(text));
  // Compute offered client tools BEFORE deciding `thinkingRaised`: only auto-raise thinking to `low` when `deepseek_web_search` is combined with client function tools.
  const ownTools = nativeSearch ? tools.filter((tool) => tool.name !== "web.search") : tools;
  const toolsFit = toolsTokens(ownTools) <= Math.floor(model.contextTokens * 0.5);
  const offered = profile.capabilities.includes("tools") && toolsFit ? ownTools : [];
  const toolsOmitted = profile.capabilities.includes("tools") && !toolsFit && ownTools.length > 0;
  const thinkingRaised = nativeSearch && offered.length > 0 && !extras.reasoningEffort;
  if (thinkingRaised) extras.reasoningEffort = "low";

  const shares = contextShares(model.contextTokens, text);
  const clipped = truncateToTokens(text, Math.floor(model.contextTokens * 0.6)).text;
  const history = snapshot.history ?? sessionHistory(app, runId, shares.history);
  let runMessages = loadRunMessages(app, runId);
  if (!runMessages.some((message) => message.role === "user")) {
    const user: ChatMessage = { role: "user", content: clipped };
    persistRunMessage(app, runId, user);
    runMessages = [...runMessages, user];
  }
  const hasContinuePrefill = Boolean(options.continuePrefill && options.prefixText && options.prefixText.length > 0);
  if (hasContinuePrefill) {
    // Drop a trailing final assistant reply if one was persisted (e.g. max_tokens) so we replace it cleanly with the continuation prefill.
    while (runMessages.length && runMessages[runMessages.length - 1]!.role === "assistant" && !runMessages[runMessages.length - 1]!.toolCalls?.length) {
      runMessages = runMessages.slice(0, -1);
    }
    runMessages = [
      ...runMessages,
      {
        role: "assistant",
        content: options.prefixText!,
        ...(options.prefixReasoning !== undefined ? { reasoning: options.prefixReasoning } : {}),
      },
    ];
  }

  // The frozen materials are what the model may rely on; the request is the last message so the
  // visible material and the user's instruction agree with the snapshot the receipt records.
  const frozenContext = typeof snapshot.contextText === "string" ? snapshot.contextText : undefined;
  const materialMessage = frozenContext ? { role: "system" as const, content: clipMaterial(frozenContext, shares.material) } : materialContextMessage(app, snapshot, shares.material);
  // When DeepSeek built-in server tools (`deepseek_web_search` / `deepseek_read_url`) are offered alongside client function tools,
  // remind the model that built-in server tools are active (otherwise `deepseek-flash` tends to focus only on client function tools).
  const serverToolsHint = offered.length > 0 && (nativeSearch || autoReadUrl)
    ? {
        role: "system" as const,
        content: nativeSearch && autoReadUrl
          ? "本次对话已开启内置联网搜索与网页链接读取能力；涉及实时信息、公开网页或用户提供的 URL 时请直接使用内置联网搜索/链接读取并保留来源引用，涉及用户本地资料库或笔记时再调用本地工具。"
          : nativeSearch
            ? "本次对话已开启内置联网搜索能力；涉及实时信息、公开网页或最新资料时请直接使用内置联网搜索并保留来源引用，涉及用户本地资料库或笔记时再调用本地工具。"
            : "本次对话已开启内置网页链接读取能力；当用户提供 HTTP/HTTPS 链接并要求读取或总结时，请直接使用内置链接读取功能获取网页内容，涉及用户本地资料库或笔记时再调用本地工具。",
      }
    : undefined;
  let messages: ChatMessage[] = [...(serverToolsHint ? [serverToolsHint] : []), ...history, ...(materialMessage ? [materialMessage] : []), ...runMessages];
  const images: FrozenImage[] = snapshot.media?.images ?? [];
  const delivery: DeliveryNote[] = [];
  if (images.length) {
    const resolved = await frozenImageParts(app, runId, images, signal);
    delivery.push(...resolved.delivery);
    await attachImages(app, runId, connection, messages, images, resolved.parts, clipped, signal, delivery);
  }

  const priceFile = providerFileOf(app, connection.id);
  const supportsFilesApi = extras.dialect === "deepseek" && !isV4Pro && (!connection.account_id || Boolean(priceFile?.accountCapabilities?.includes("files")));
  const uploadedSources = new Map<string, UploadSource>();
  const ephemeralFileIds = new Set<string>();
  const uploadForRun = async (source: UploadSource): Promise<MessageFileRef> => {
    let filename: string;
    let mimeType: string;
    let data: Uint8Array;
    let explicitPurpose: FileUploadPurpose | undefined;
    if (source.kind === "attachment") {
      const resolvedPath = app.resolvePathFor(source.attachment.pathHandle, ["file", "import"]);
      data = fs.readFileSync(resolvedPath);
      filename = source.attachment.name;
      mimeType = source.attachment.mimeType;
      explicitPurpose = source.attachment.purpose;
    } else {
      data = readFrozenFile(app.store, source.frozenFile);
      filename = source.frozenFile.filename;
      mimeType = "application/pdf";
      explicitPurpose = "rich_layout_recognition";
    }
    const inferred = explicitPurpose ?? inferDeepSeekFilePurpose(filename, mimeType);
    const ref = await uploadDeepSeekFile({
      baseUrl: connection.base_url,
      apiKey,
      filename,
      mimeType,
      data,
      purpose: inferred ?? null,
      signal,
      timeoutMs: connection.timeout_ms,
    });
    uploadedSources.set(ref.fileId, source);
    ephemeralFileIds.add(ref.fileId);
    return { fileId: ref.fileId, filename: ref.filename, mimeType: ref.mimeType ?? mimeType };
  };

  // Register ephemeral Files API cleanup (zero network requests if provider plugin was disabled).
  cleanupTasks.push(async () => {
    if (!ephemeralFileIds.size) return;
    if (access.provider && !app.providers.get(access.provider.ref)) return;
    const ids = [...ephemeralFileIds];
    ephemeralFileIds.clear();
    await Promise.allSettled(
      ids.map((fileId) => deleteDeepSeekFile({ baseUrl: connection.base_url, apiKey, fileId, timeoutMs: 10_000 })),
    );
  });

  if (snapshot.media?.files?.length || snapshot.media?.clip) {
    const native = await frozenNativeParts(app, runId, snapshot.media, signal);
    if (supportsFilesApi && native.files.length && snapshot.media.files?.length) {
      for (let i = 0; i < native.files.length; i += 1) {
        const frozenFile = snapshot.media.files[i];
        if (!frozenFile) continue;
        const ref = await uploadForRun({ kind: "frozenPdf", frozenFile });
        native.files[i] = { ...native.files[i]!, fileId: ref.fileId };
      }
    }
    const lastUser = messages.map((message) => message.role).lastIndexOf("user");
    if (lastUser >= 0) messages[lastUser] = { ...messages[lastUser]!, ...(native.files.length ? { files: native.files } : {}), ...(native.videos.length ? { videos: native.videos } : {}) };
    delivery.push(...native.delivery);
  } else delivery.push(...(snapshot.media?.delivery ?? []));

  if (snapshot.fileAttachments?.length) {
    const lastUser = messages.map((message) => message.role).lastIndexOf("user");
    if (supportsFilesApi) {
      const refs: MessageFileRef[] = [];
      for (const attachment of snapshot.fileAttachments) {
        refs.push(await uploadForRun({ kind: "attachment", attachment }));
        delivery.push({ kind: attachment.kind === "image" ? "image" : "file", bytes: attachment.bytes });
      }
      if (lastUser >= 0 && refs.length) {
        messages[lastUser] = { ...messages[lastUser]!, fileRefs: [...(messages[lastUser]!.fileRefs ?? []), ...refs] };
      }
    } else {
      // Non-DeepSeek or v4-pro: allow image attachments when vision is configured; refuse non-image binary files cleanly.
      const imageAtts = snapshot.fileAttachments.filter((att) => att.kind === "image");
      const fileAtts = snapshot.fileAttachments.filter((att) => att.kind !== "image");
      if (fileAtts.length) {
        throw new MangaError("MODEL_CAPABILITY_MISSING", "当前模型不支持文件附件上传；请切换到支持文件输入的模型（如 DeepSeek Flash）。", { details: { capability: "files" } });
      }
      if (imageAtts.length) {
        const route = visionRoute(app, connection);
        if (route.kind !== "direct") {
          throw new MangaError("MODEL_CAPABILITY_MISSING", route.kind === "none" ? route.reason : "当前模型不支持直接发送图片附件", { details: { capability: "vision" } });
        }
        const parts: ImagePart[] = imageAtts.map((att) => {
          const raw = fs.readFileSync(app.resolvePathFor(att.pathHandle, ["file", "import"]));
          const mediaType: ImagePart["mediaType"] = att.mimeType === "image/png" ? "image/png" : att.mimeType === "image/webp" ? "image/webp" : "image/jpeg";
          delivery.push({ kind: "image", bytes: raw.length });
          return { mediaType, base64: raw.toString("base64") };
        });
        if (lastUser >= 0) messages[lastUser] = { ...messages[lastUser]!, images: [...(messages[lastUser]!.images ?? []), ...parts] };
      }
    }
  }

  const toolResults: Array<{ commandId: string; result: unknown }> = [];
  const storedUsage = runRow?.usage_json ? safeJsonValue(runRow.usage_json) as {
    costUsd?: number;
    steps?: number;
    compactions?: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    searches?: number;
    fetches?: number;
    reasoningStartedAt?: string;
    reasoningElapsedMs?: number;
    generatedTitle?: string;
    toolSteps?: Record<string, { startedAt?: string; elapsedMs?: number; summary?: string; error?: string }>;
  } : {};
  const checkpoint = runRow?.checkpoint_json ? safeJsonValue(runRow.checkpoint_json) as { step?: number; costUsd?: number; at?: string } : {};
  const cutShortSince = checkpoint.at ?? runRow?.created_at ?? "";
  const ranHere = new Set<string>();
  let costUsd = storedUsage.costUsd ?? checkpoint.costUsd;
  let compactions = storedUsage.compactions ?? 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedInputTokens = storedUsage.cachedInputTokens ?? 0;
  let totalReasoningTokens = storedUsage.reasoningTokens ?? 0;
  let totalSearches = storedUsage.searches ?? 0;
  let totalFetches = storedUsage.fetches ?? 0;
  let generatedTitle = storedUsage.generatedTitle;
  let reasoningStartedAt = storedUsage.reasoningStartedAt;
  let reasoningElapsedMs = storedUsage.reasoningElapsedMs;
  let reasoningStartMs: number | undefined;
  let reasoningFinished = false;
  const toolStepMeta: Record<string, { startedAt?: string; elapsedMs?: number; summary?: string; error?: string }> = { ...(storedUsage.toolSteps ?? {}) };
  let calibration = 1;

  const flags: { toolsOmitted?: boolean; thinkingRaised?: boolean; costEstimated?: boolean; pricesCheckedAt?: string } = {
    ...(toolsOmitted ? { toolsOmitted } : {}),
    ...(thinkingRaised ? { thinkingRaised } : {}),
  };
  if (thinkingRaised) {
    app.store.sqlite.prepare("UPDATE agent_runs SET usage_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({ ...storedUsage, ...flags }), new Date().toISOString(), runId,
    );
  }

  const initialBaseText = hasContinuePrefill ? options.prefixText! : "";
  const liveRun = startLiveExtras(runId, {
    text: initialBaseText,
    modelId: connection.model_id,
    status: "running",
    ...(thinkingRaised ? { thinkingRaised: true } : {}),
    ...(reasoningStartedAt ? { reasoningStartedAt } : {}),
    ...(reasoningElapsedMs !== undefined ? { reasoningElapsedMs } : {}),
    ...(generatedTitle ? { generatedTitle } : {}),
  });
  app.emitAgentStream({
    kind: "start",
    sessionId,
    runId,
    modelId: connection.model_id,
    ...(thinkingRaised ? { thinkingRaised: true } : {}),
    at: new Date().toISOString(),
  });

  let stepsUsed = typeof checkpoint.step === "number" ? checkpoint.step : messages.filter((message) => message.role === "assistant" && message.toolCalls?.length).length;
  const summarize = async (transcript: string, attempt: number, started: number): Promise<string> => {
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
      ...(extras.dialect ? { dialect: extras.dialect } : {}),
      contextWindow: model.contextWindow,
    };
    const done = await modelComplete(app, { runId, step: started, kind: "compaction", name: `compaction#${attempt}`, connection, apiKey, protocol, request, runtime: frozenRuntime });
    return done.text;
  };

  let lastLiveFlushAt = 0;
  let dirtyLiveText = false;
  let latestLiveText = initialBaseText;
  const flushLiveText = (force = false) => {
    if (!dirtyLiveText) return;
    const nowMs = Date.now();
    if (!force && nowMs - lastLiveFlushAt < LIVE_TEXT_FLUSH_MS) return;
    lastLiveFlushAt = nowMs;
    dirtyLiveText = false;
    app.store.sqlite.prepare("UPDATE agent_runs SET live_text = ?, updated_at = ? WHERE id = ?").run(latestLiveText, new Date().toISOString(), runId);
  };

  const buildUsageSummary = (): AgentRunUsage | undefined => {
    const latencyMs = Math.max(0, Date.now() - runStartedMs);
    const summary: AgentRunUsage = {
      ...(totalInputTokens > 0 ? { inputTokens: totalInputTokens } : {}),
      ...(totalOutputTokens > 0 ? { outputTokens: totalOutputTokens } : {}),
      ...(totalCachedInputTokens > 0 ? { cachedInputTokens: totalCachedInputTokens } : {}),
      ...(totalReasoningTokens > 0 ? { reasoningTokens: totalReasoningTokens } : {}),
      ...(totalSearches > 0 ? { searches: totalSearches } : {}),
      ...(totalFetches > 0 ? { fetches: totalFetches } : {}),
      ...(costUsd !== undefined ? { estimatedCost: costUsd, currency: "USD" } : {}),
      ...(flags.pricesCheckedAt ? { pricesCheckedAt: flags.pricesCheckedAt } : {}),
      latencyMs,
    };
    return Object.keys(summary).length ? summary : undefined;
  };

  let fileHealRetriesLeft = 1;

  for (let step = stepsUsed; step < budget.maxSteps; step += 1) {
    if (signal.aborted) {
      flushLiveText(true);
      throw new MangaError("CANCELLED", "run cancelled", { retryable: true, details: { errorCode: "cancelled" } });
    }
    const isContinueStep = hasContinuePrefill && step === stepsUsed;
    const stepBaseText = isContinueStep ? initialBaseText : "";
    const wantInlineTitle = Boolean(snapshot.wantInlineTitle && !generatedTitle && !isContinueStep && extras.dialect === "deepseek" && !isV4Pro);
    const latestReminder = extras.dialect === "deepseek" && !isV4Pro ? formatLatestReminder(new Date()) : undefined;

    let scale = 1;
    let attemptsLeft = 3;
    const accumulated = new Map<string, { name: string; arguments: string }>();
    let completed = false;
    let finishReason = "";
    let stopReason: AgentStopReason | undefined;
    let refusal = false;
    let assistant = "";
    let reasoning: string | undefined;
    let search: ServerToolEvent[] = [];
    let serverToolSteps: AgentServerToolStep[] = [];
    let serverToolCalls: unknown[] | undefined;
    let citations: Citation[] | undefined;
    let stepTitle = "";
    let lastEmittedTitle = generatedTitle ?? "";

    while (true) {
      const fitted = await fitContext({
        messages,
        tools: offered,
        budget: { ...model, contextTokens: Math.max(256, Math.floor(model.contextTokens * scale)) },
        calibration,
        summarize: (transcript, attempt) => summarize(transcript, attempt, step),
      }).catch((error) => {
        if (scale < 1 && error instanceof MangaError && (error.details as { reason?: string } | undefined)?.reason === "context_too_large") throw refusedByService(model.contextWindow);
        throw error;
      });
      if (fitted.trimmed || fitted.compacted) {
        const budgetTokens = Math.max(256, Math.floor(model.contextTokens * scale));
        if (fitted.trimmed) app.trace.note({ runId, step, kind: "compaction", name: "trim-tool-results", request: { budgetTokens, tokensBefore: fitted.tokensBefore }, response: { trimmed: fitted.trimmed, tokensBefore: fitted.tokensBefore, tokensAfter: fitted.tokensAfter } });
        if (fitted.compacted) app.trace.note({ runId, step, kind: "compaction", name: "compaction", request: { budgetTokens, tokensBefore: fitted.tokensBefore }, response: fitted.compacted });
        messages = fitted.messages;
        if (fitted.compacted) {
          compactions += 1;
          app.store.sqlite.prepare("UPDATE agent_runs SET usage_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify({ costUsd, steps: step, compactions, ...flags }), new Date().toISOString(), runId);
        }
      }
      accumulated.clear();
      completed = false;
      finishReason = "";
      stopReason = undefined;
      refusal = false;
      assistant = "";
      reasoning = undefined;
      search = [];
      serverToolSteps = [];
      serverToolCalls = undefined;
      citations = undefined;
      stepTitle = "";
      const live = beginLiveStep(runId, { text: stepBaseText, modelId: connection.model_id });
      const finalizeReasoningElapsed = () => {
        if (reasoningStartMs !== undefined && !reasoningFinished) {
          reasoningFinished = true;
          reasoningElapsedMs = Math.max(0, Date.now() - reasoningStartMs);
          live.reasoningElapsedMs = reasoningElapsedMs;
        }
      };

      try {
        const request: TextRequest = {
          model: connection.model_id,
          messages: fitted.messages,
          tools: offered.length ? offered : undefined,
          signal,
          timeoutMs: connection.timeout_ms,
          ...extras,
          ...(nativeSearch ? { nativeWebSearch: true } : {}),
          ...(autoReadUrl ? { readUrl: true } : {}),
          ...(wantInlineTitle ? { inlineTitle: true } : {}),
          ...(latestReminder ? { latestReminder } : {}),
          ...(isContinueStep ? { continuePrefill: true } : {}),
        };
        for await (const event of modelStream(app, {
          runId, step, connection, apiKey, protocol, runtime: frozenRuntime, delivery, request,
        })) {
          if (signal.aborted) {
            flushLiveText(true);
            throw new MangaError("CANCELLED", "run cancelled", { retryable: true, details: { errorCode: "cancelled" } });
          }
          if (event.type === "reasoning-delta") {
            if (!reasoningStartedAt) {
              reasoningStartedAt = new Date().toISOString();
              reasoningStartMs = Date.now();
              live.reasoningStartedAt = reasoningStartedAt;
            }
            reasoningFinished = false;
            reasoning = (reasoning ?? "") + event.text;
            live.reasoning = reasoning;
            if (reasoningStartMs !== undefined) {
              reasoningElapsedMs = Math.max(0, Date.now() - reasoningStartMs);
              live.reasoningElapsedMs = reasoningElapsedMs;
            }
            app.emitAgentStream({
              kind: "reasoning-delta",
              sessionId,
              runId,
              delta: event.text,
              ...(reasoningStartedAt ? { reasoningStartedAt } : {}),
              ...(reasoningElapsedMs !== undefined ? { reasoningElapsedMs } : {}),
            });
          }
          if (event.type === "step-reasoning-done") {
            finalizeReasoningElapsed();
          }
          if (event.type === "server-tool") {
            search = [...search, event.event];
            serverToolSteps = event.steps?.length ? event.steps : aggregateServerToolSteps(search);
            live.search = search;
            live.serverToolSteps = serverToolSteps;
            if (event.event.kind === "done") {
              const foundSources = [...event.event.sources, ...(event.event.page ? [event.event.page] : [])];
              if (foundSources.length) live.sources = [...live.sources, ...foundSources];
            }
            app.emitAgentStream({
              kind: "server-tool",
              sessionId,
              runId,
              event: event.event,
              steps: serverToolSteps,
            });
          }
          if (event.type === "title-delta") {
            stepTitle += event.text;
            const trimmedTitle = stepTitle.trim();
            if (trimmedTitle && trimmedTitle !== lastEmittedTitle) {
              generatedTitle = trimmedTitle;
              live.generatedTitle = trimmedTitle;
              lastEmittedTitle = trimmedTitle;
              app.emitAgentStream({ kind: "title", sessionId, runId, title: trimmedTitle });
            }
          }
          if (event.type === "text-delta") {
            finalizeReasoningElapsed();
            assistant += event.text;
            latestLiveText = stepBaseText + assistant;
            live.text = latestLiveText;
            dirtyLiveText = true;
            flushLiveText(false);
            app.emitAgentStream({ kind: "text-delta", sessionId, runId, delta: event.text });
            // The service is asked to stop at the model's longest answer; one that goes on regardless is stopped here.
            if (assistant.length > model.maxOutputTokens * 6 + 2_000) {
              flushLiveText(true);
              throw new MangaError("BUDGET_EXCEEDED", "模型的回答超过了设置里的最大输出，任务已停止。可以在模型设置里调大“最大输出”。", { details: { reason: "max_output", limit: model.maxOutputTokens } });
            }
          }
          if (event.type === "tool-call-delta") {
            finalizeReasoningElapsed();
            const current = accumulated.get(event.callId) ?? { name: event.name, arguments: "" };
            current.name = event.name || current.name;
            current.arguments += event.argumentsDelta;
            accumulated.set(event.callId, current);
          }
          if (event.type === "completed") {
            finalizeReasoningElapsed();
            flushLiveText(true);
            completed = true;
            finishReason = event.finishReason;
            refusal = Boolean(event.refusal);
            stopReason = event.stopReason ?? stopReasonOf(event.finishReason, refusal);
            live.stopReason = stopReason;
            if (refusal) live.refusal = true;
            if (event.serverToolCalls?.length) serverToolCalls = event.serverToolCalls;
            if (event.serverToolSteps?.length) {
              serverToolSteps = event.serverToolSteps;
              live.serverToolSteps = serverToolSteps;
            }
            if (event.citations?.length) {
              citations = event.citations;
              live.citations = citations;
              app.emitAgentStream({ kind: "citations", sessionId, runId, citations });
            }
            const completedTitle = event.title?.trim() || stepTitle.trim();
            if (wantInlineTitle && completedTitle) {
              const applied = app.conversations.applyGeneratedTitle(sessionId, completedTitle, snapshot.fallbackTitle);
              const finalTitle = applied ?? completedTitle;
              generatedTitle = finalTitle;
              live.generatedTitle = finalTitle;
              if (finalTitle !== lastEmittedTitle) {
                lastEmittedTitle = finalTitle;
                app.emitAgentStream({ kind: "title", sessionId, runId, title: finalTitle });
              }
              if (applied) app.notify("conversation.renamed", { sessionId, title: applied });
            }
            // The searches the service ran are billed apart from the tokens (计划 4.4, 4.8).
            if (event.usage?.searches) {
              totalSearches += event.usage.searches;
              recordServiceUse(app, { connectionId: connection.id, modelId: connection.model_id, service: "search", task: "agent", unit: "search", quantity: event.usage.searches, status: "ok", runId });
            }
            if (event.usage?.fetches) totalFetches += event.usage.fetches;
            if (typeof event.usage?.cachedInputTokens === "number") totalCachedInputTokens += event.usage.cachedInputTokens;
            if (typeof event.usage?.reasoningTokens === "number") totalReasoningTokens += event.usage.reasoningTokens;
            if (event.usage && "costUsd" in event.usage && typeof event.usage.costUsd === "number") {
              costUsd = (costUsd ?? 0) + event.usage.costUsd;
            } else if (event.usage && priceFile) {
              const estimate = estimateChatCost(priceFile, (connection as { provider_model?: string | null }).provider_model ?? connection.model_id, event.usage);
              if (estimate !== undefined) {
                costUsd = (costUsd ?? 0) + estimate;
                flags.costEstimated = true;
                flags.pricesCheckedAt = priceFile.pricesCheckedAt;
              }
            }
            // Tokens are added up over the steps of a run; a service that does not state them leaves the columns empty.
            if (event.usage && (typeof event.usage.inputTokens === "number" || typeof event.usage.outputTokens === "number")) {
              totalInputTokens += event.usage.inputTokens ?? 0;
              totalOutputTokens += event.usage.outputTokens ?? 0;
              app.store.sqlite.prepare("UPDATE agent_runs SET input_tokens = COALESCE(input_tokens, 0) + ?, output_tokens = COALESCE(output_tokens, 0) + ? WHERE id = ?").run(event.usage.inputTokens ?? 0, event.usage.outputTokens ?? 0, runId);
              calibration = calibrate(calibration, event.usage.inputTokens, contextTokens(fitted.messages, offered));
            }
            live.usage = buildUsageSummary();
          }
          if (event.type === "error") {
            flushLiveText(true);
            throw new MangaError("PROVIDER_UNAVAILABLE", event.message, {
              retryable: event.retryable,
              details: {
                ...(event.errorCode ? { errorCode: event.errorCode } : {}),
                ...(event.expiredFileIds?.length ? { expiredFileIds: event.expiredFileIds, kind: "file_expired" } : {}),
              },
            });
          }
        }
        break;
      } catch (error) {
        flushLiveText(true);
        // Self-heal expired DeepSeek Files API `file_id` (max 1 retry): re-upload from local storage and retry seamlessly.
        const classified = classifyAgentError(error);
        const expiredIds = classified.expiredFileIds ?? extractExpiredFileIds(error);
        if (supportsFilesApi && expiredIds.length > 0 && fileHealRetriesLeft > 0 && !assistant && !accumulated.size) {
          const replacements = new Map<string, string>();
          for (const expiredId of expiredIds) {
            const source = uploadedSources.get(expiredId);
            if (!source) continue;
            const fresh = await uploadForRun(source);
            ephemeralFileIds.delete(expiredId);
            uploadedSources.delete(expiredId);
            replacements.set(expiredId, fresh.fileId);
          }
          if (replacements.size > 0) {
            fileHealRetriesLeft -= 1;
            messages = messages.map((msg) => {
              if (msg.role !== "user" || (!msg.fileRefs?.length && !msg.files?.length)) return msg;
              return {
                ...msg,
                ...(msg.fileRefs?.length
                  ? { fileRefs: msg.fileRefs.map((ref) => (replacements.has(ref.fileId) ? { ...ref, fileId: replacements.get(ref.fileId)! } : ref)) }
                  : {}),
                ...(msg.files?.length
                  ? { files: msg.files.map((file) => (file.fileId && replacements.has(file.fileId) ? { ...file, fileId: replacements.get(file.fileId)! } : file)) }
                  : {}),
              };
            });
            continue;
          }
        }
        if (isContextOverflow(error) && attemptsLeft > 1 && !assistant && !accumulated.size) {
          attemptsLeft -= 1;
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
      if (refusal && !assistant.trim()) {
        throw new MangaError("PROVIDER_UNAVAILABLE", "内容被服务拒绝", { details: { kind: "content_filter", errorCode: "refusal" satisfies AgentErrorCode } });
      }
      if (!assistant.trim()) {
        throw new MangaError("PROVIDER_UNAVAILABLE", finishReason === "length"
          ? "模型还没写出回答就用完了最大输出。可以在模型设置里调大“最大输出”后重试。"
          : "模型这次没有给出回答。可以重试；多次如此时，可以在设置里换一个模型。", { retryable: true, details: { reason: "empty_answer", finishReason: finishReason || null } });
      }
      const finalText = isContinueStep ? stepBaseText + assistant : assistant;
      const finalStopReason = stopReason ?? stopReasonOf(finishReason, refusal);
      const finalCanContinue = !refusal && finalStopReason === "max_tokens";
      const messagePayload: ChatMessage = {
        role: "assistant",
        content: finalText,
        ...(reasoning !== undefined ? { reasoning } : {}),
        ...(serverToolCalls ? { serverToolCalls } : {}),
      };
      const messageExtras: AnswerExtras = {
        search,
        ...(serverToolSteps.length ? { serverToolSteps } : {}),
        ...(citations ? { citations } : {}),
        ...(reasoningStartedAt ? { reasoningStartedAt } : {}),
        ...(reasoningElapsedMs !== undefined ? { reasoningElapsedMs } : {}),
      };
      if (isContinueStep && options.replaceMessageId) {
        updateContinuedAssistantMessage(app, options.replaceMessageId, finalText, messagePayload, messageExtras);
      } else {
        persistRunMessage(app, runId, messagePayload, messageExtras);
      }
      // Clear step-local live fields immediately after DB persistence so concurrent `session.stream` reads never double-count them.
      liveRun.reasoning = "";
      liveRun.search = [];
      liveRun.serverToolSteps = [];
      const usageSummary = buildUsageSummary();
      liveRun.text = finalText;
      liveRun.status = "succeeded";
      liveRun.stopReason = finalStopReason;
      liveRun.canContinue = finalCanContinue;
      if (refusal) liveRun.refusal = true;
      liveRun.usage = usageSummary;
      return {
        text: finalText,
        tools: toolResults,
        completed,
        costUsd,
        steps: step + 1,
        compactions,
        toolsOmitted,
        modelId: connection.model_id,
        stopReason: finalStopReason,
        canContinue: finalCanContinue,
        ...(refusal ? { refusal: true } : {}),
        ...(generatedTitle ? { generatedTitle } : {}),
        ...(reasoningStartedAt ? { reasoningStartedAt } : {}),
        ...(reasoningElapsedMs !== undefined ? { reasoningElapsedMs } : {}),
        ...(citations ? { citations } : {}),
        ...(usageSummary ? { usage: usageSummary } : {}),
        ...(Object.keys(toolStepMeta).length ? { toolSteps: toolStepMeta } : {}),
        ...(thinkingRaised ? { thinkingRaised } : {}),
        ...(flags.costEstimated ? { costEstimated: true, pricesCheckedAt: flags.pricesCheckedAt } : {}),
      };
    }
    if (!completed) throw new MangaError("PROVIDER_UNAVAILABLE", "stream ended before the provider completed the tool call", { retryable: true });
    let firstOfStep = true;
    for (const [callId, call] of accumulated) {
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
        const deniedId = createId("tool");
        const deniedAt = new Date().toISOString();
        app.store.sqlite.prepare("INSERT INTO agent_tool_events(id, run_id, command_id, status, input_summary, created_at) VALUES (?,?,?,?,?,?)").run(deniedId, runId, commandId, "denied", call.arguments.slice(0, 200), deniedAt);
        const deniedStep: AgentToolStep = { id: deniedId, name: commandId, status: "error", startedAt: deniedAt, elapsedMs: 0, error: `tool ${commandId} is not admitted` };
        liveRun.toolSteps = [...liveRun.toolSteps, deniedStep];
        app.emitAgentStream({ kind: "tool-step", sessionId, runId, step: deniedStep });
        throw new MangaError("FORBIDDEN", `tool ${commandId} is not admitted`);
      }
      if (AGENT_PROJECT_COMMANDS.includes(commandId) && takesProject(commandInputJsonSchema(commandId)) && parsed && typeof parsed === "object" && !("projectId" in parsed)) {
        try { parsed = { ...(parsed as Record<string, unknown>), projectId: app.agentAccess.projectOf(grant) }; } catch { /* the project is gone: the command itself says so */ }
      }
      if (takesContext(commandInputJsonSchema(commandId)) && parsed && typeof parsed === "object") {
        parsed = { ...(parsed as Record<string, unknown>), contextId: app.agentAccess.contextOf(grant) };
      }
      const inputHash = createHash("sha256").update(JSON.stringify(parsed ?? {})).digest("hex");
      const summary = toolInputSummary(call.arguments, inputHash);
      const prior = step === stepsUsed
        ? (app.store.sqlite.prepare("SELECT id, result_summary FROM agent_tool_events WHERE run_id = ? AND command_id = ? AND status = 'executed' AND created_at > ? ORDER BY created_at, rowid").all(runId, commandId, cutShortSince) as Array<{ id: string; result_summary: string | null }>).find((event) => !ranHere.has(event.id))
        : undefined;
      let result: CommandResult;
      if (prior?.result_summary) {
        ranHere.add(prior.id);
        result = safeJsonValue(prior.result_summary) as CommandResult;
      } else {
        const eventId = createId("tool");
        const toolStartedAt = new Date().toISOString();
        const toolStartedMs = Date.now();
        const wipStep: AgentToolStep = { id: eventId, name: commandId, status: "wip", startedAt: toolStartedAt };
        liveRun.toolSteps = [...liveRun.toolSteps, wipStep];
        app.emitAgentStream({ kind: "tool-step", sessionId, runId, step: wipStep });

        result = await toolCall(app, runId, step, grant, { commandId, idempotencyKey: `${runId}:${step}:${callId}:${commandId}:${inputHash}`, input: parsed });
        const elapsedMs = Math.max(0, Date.now() - toolStartedMs);
        ranHere.add(eventId);
        const stepSummary = briefToolSummary(commandId, parsed, result);
        const stepError = result.status === "ok" ? undefined : (result.error?.message?.slice(0, 240) || "tool failed");
        toolStepMeta[eventId] = { startedAt: toolStartedAt, elapsedMs, ...(stepSummary ? { summary: stepSummary } : {}), ...(stepError ? { error: stepError } : {}) };
        const finishedStep: AgentToolStep = {
          id: eventId,
          name: commandId,
          status: result.status === "ok" ? "done" : "error",
          startedAt: toolStartedAt,
          elapsedMs,
          ...(stepSummary ? { summary: stepSummary } : {}),
          ...(stepError ? { error: stepError } : {}),
        };
        liveRun.toolSteps = liveRun.toolSteps.map((item) => (item.id === eventId ? finishedStep : item));
        app.emitAgentStream({ kind: "tool-step", sessionId, runId, step: finishedStep });
        app.store.sqlite.prepare("INSERT INTO agent_tool_events(id, run_id, command_id, status, input_summary, result_summary, created_at) VALUES (?,?,?,?,?,?,?)").run(
          eventId, runId, commandId, result.status === "ok" ? "executed" : "failed", summary, summarizeToolResult(result), toolStartedAt,
        );
      }
      toolResults.push({ commandId, result });
      const assistantCall: ChatMessage = {
        role: "assistant", content: "", toolCalls: [{ id: callId, name: commandId, arguments: call.arguments }],
        ...(reasoning !== undefined ? { reasoning: firstOfStep ? reasoning : "" } : {}),
        ...(firstOfStep && serverToolCalls ? { serverToolCalls } : {}),
      };
      const toolMessage: ChatMessage = { role: "tool", toolCallId: callId, content: JSON.stringify(result) };
      persistRunMessage(app, runId, assistantCall, firstOfStep ? { search, ...(serverToolSteps.length ? { serverToolSteps } : {}) } : {});
      if (firstOfStep) {
        // Clear step-local live fields immediately after DB persistence so `session.stream` between steps never duplicates them.
        liveRun.reasoning = "";
        liveRun.search = [];
        liveRun.serverToolSteps = [];
      }
      firstOfStep = false;
      persistRunMessage(app, runId, toolMessage);
      messages.push(assistantCall, toolMessage);
    }
    app.store.sqlite.prepare("UPDATE agent_runs SET usage_json = ?, checkpoint_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify({
        costUsd,
        steps: step + 1,
        compactions,
        ...flags,
        ...(totalCachedInputTokens ? { cachedInputTokens: totalCachedInputTokens } : {}),
        ...(totalReasoningTokens ? { reasoningTokens: totalReasoningTokens } : {}),
        ...(totalSearches ? { searches: totalSearches } : {}),
        ...(totalFetches ? { fetches: totalFetches } : {}),
        ...(reasoningStartedAt ? { reasoningStartedAt } : {}),
        ...(reasoningElapsedMs !== undefined ? { reasoningElapsedMs } : {}),
        ...(generatedTitle ? { generatedTitle } : {}),
        ...(Object.keys(toolStepMeta).length ? { toolSteps: toolStepMeta } : {}),
      }),
      JSON.stringify({ step: step + 1, costUsd, at: new Date().toISOString() }),
      new Date().toISOString(),
      runId,
    );
  }
  throw new MangaError("BUDGET_EXCEEDED", `任务用完了 ${budget.maxSteps} 步仍没有结束。可以在设置的“智能体”里调高步数上限，或把任务拆小。`, { details: { reason: "max_steps", limit: budget.maxSteps } });
}

export function sessionHistoryForNewRun(app: AgentRunHost, sessionId: string, maxTokens: number, beforeCreatedAt?: string): ChatMessage[] {
  if (maxTokens <= 0) return [];
  const earlier = (beforeCreatedAt
    ? app.store.sqlite.prepare(`SELECT id, input_text FROM agent_runs WHERE session_id = ? AND status = 'succeeded' AND created_at < ? AND ${NOT_SUPERSEDED_SQL} ORDER BY created_at DESC LIMIT 50`).all(sessionId, beforeCreatedAt)
    : app.store.sqlite.prepare(`SELECT id, input_text FROM agent_runs WHERE session_id = ? AND status = 'succeeded' AND ${NOT_SUPERSEDED_SQL} ORDER BY created_at DESC LIMIT 50`).all(sessionId)) as Array<{ id: string; input_text: string }>;
  const history: ChatMessage[] = [];
  let used = 0;
  for (const run of earlier) {
    const rows = app.store.sqlite.prepare("SELECT text, payload_json FROM agent_messages WHERE run_id = ? AND role = 'assistant' ORDER BY created_at").all(run.id) as Array<{ text: string; payload_json: string | null }>;
    const reply = rows.map((row) => row.text).filter(Boolean).join("\n");
    // The searches and URL reads the service ran for an earlier answer go back with it, as they were given; only a DeepSeek request sends them.
    const serverToolCalls = rows.flatMap((row) => {
      const payload = row.payload_json ? safeJsonValue(row.payload_json) as { serverToolCalls?: unknown } | null : null;
      return Array.isArray(payload?.serverToolCalls) ? payload.serverToolCalls as unknown[] : [];
    });
    const answer = (content: string): ChatMessage => ({ role: "assistant", content, ...(serverToolCalls.length ? { serverToolCalls } : {}) });
    const turn: ChatMessage[] = [{ role: "user", content: run.input_text }, ...(reply ? [answer(reply)] : [])];
    const size = contextTokens(turn);
    if (used + size > maxTokens) {
      if (!history.length && reply) {
        const room = maxTokens - contextTokens([turn[0]!]) - 16;
        if (room > 64) history.unshift(turn[0]!, answer(`${truncateToTokens(reply, room).text}\n（上一次的回答较长，这里只带入了前面的部分。）`));
      }
      break;
    }
    used += size;
    history.unshift(...turn);
  }
  return history;
}

/** Frozen snapshot history is preferred; remains for runs created before checkpoints existed. */
export function sessionHistory(app: AgentRunHost, runId: string, maxTokens: number): ChatMessage[] {
  const current = app.store.sqlite.prepare("SELECT session_id, created_at FROM agent_runs WHERE id = ?").get(runId) as { session_id: string; created_at: string } | undefined;
  if (!current || maxTokens <= 0) return [];
  return sessionHistoryForNewRun(app, current.session_id, maxTokens, current.created_at).filter((message, index, all) => {
    return !(message.role === "user" && index === all.length - 1 && message.content === "");
  });
}

export function cancelRun(app: AgentRunHost, envelope: CommandEnvelope) {
  app.assertWritable();
  const input = envelope.input as { runId: string };
  const live = app.runAbort.get(input.runId);
  const row = app.store.sqlite.prepare("SELECT session_id, usage_json FROM agent_runs WHERE id = ?").get(input.runId) as { session_id: string; usage_json: string | null } | undefined;
  const now = new Date().toISOString();
  // Flush any buffered in-memory text before aborting so `agent.continueRun` never loses streamed tokens.
  const extras = liveRunExtras(input.runId);
  if (extras?.text) {
    app.store.sqlite.prepare("UPDATE agent_runs SET live_text = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running','waiting_input')").run(extras.text, now, input.runId);
  }
  // Detach from `runAbort` and live extras immediately so a subsequent `continueRun` / `retry` / `regenerateRun`
  // is never blocked while the aborted HTTP stream finishes tearing down in the background.
  if (live) {
    app.runAbort.delete(input.runId);
    endLiveExtras(input.runId);
    live.abort();
  }
  const prevUsage = (row?.usage_json ? safeJsonValue(row.usage_json) : {}) as Record<string, unknown>;
  const changed = app.store.sqlite.prepare("UPDATE agent_runs SET status = 'cancelled', usage_json = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running','waiting_input')").run(
    JSON.stringify({ ...prevUsage, stopReason: "cancelled", errorCode: "cancelled" }),
    now,
    input.runId,
  ).changes;
  if (changed > 0 && row?.session_id && !app.closed) {
    app.emitAgentStream({
      kind: "done",
      sessionId: row.session_id,
      runId: input.runId,
      status: "cancelled",
      stopReason: "cancelled",
      canContinue: true,
      errorCode: "cancelled",
      error: null,
    });
  }
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
  if (run.status === "running" || run.status === "queued" || run.status === "waiting_input" || app.runAbort.has(run.id)) {
    throw new MangaError("VALIDATION_ERROR", "run is still in progress");
  }
  if (run.status === "succeeded") {
    return { runId: run.id, sessionId: run.session_id, grantHandle: run.grant_handle, status: "succeeded" };
  }
  const grant = app.grants.get(run.grant_handle);
  if (!grant || grant.revoked) throw new MangaError("FORBIDDEN", "original run authorization is no longer available");
  const budget: AgentLoopBudget = { ...(JSON.parse(run.budget_json) as AgentLoopBudget), maxSteps: readAgentSettings(app.store).limits.maxSteps };
  const runtime = (run.runtime === "pi" ? "pi" : "native") as AiRuntimeId;
  app.store.sqlite.prepare("UPDATE agent_runs SET status = 'running', error_json = NULL, budget_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(budget), new Date().toISOString(), run.id);
  startRunLoop(app, run.id, grant, run.input_text, budget, runtime);
  return { runId: run.id, sessionId: run.session_id, grantHandle: run.grant_handle, status: "running", inputText: run.input_text };
}

/**
 * Continues a `cancelled` or `max_tokens` run using trailing assistant continuation prefill (`continuePrefill: true`),
 * smoothly appending to the existing assistant reply without creating a duplicate user message.
 */
export function continueRun(app: AgentRunHost, envelope: CommandEnvelope): AgentRunActionResult {
  app.assertWritable();
  const owner = app.grantOf(envelope);
  if (owner.access !== "owner") throw new MangaError("FORBIDDEN", "continuing a run belongs to the owner");
  const input = envelope.input as { runId: string };
  const run = app.store.sqlite.prepare("SELECT * FROM agent_runs WHERE id = ?").get(input.runId) as {
    id: string;
    session_id: string;
    status: string;
    grant_handle: string;
    input_text: string;
    budget_json: string;
    usage_json: string | null;
    live_text: string | null;
    runtime: string | null;
  } | undefined;
  if (!run) throw new MangaError("NOT_FOUND", "run missing");
  if (run.status === "running" || run.status === "queued" || run.status === "waiting_input" || app.runAbort.has(run.id)) {
    throw new MangaError("VALIDATION_ERROR", "run is still in progress");
  }
  const usageMeta = (run.usage_json ? safeJsonValue(run.usage_json) : {}) as { stopReason?: AgentStopReason; refusal?: boolean };
  const refusal = usageMeta.refusal === true || usageMeta.stopReason === "refusal";
  const continuable = !refusal && (run.status === "cancelled" || usageMeta.stopReason === "max_tokens");
  if (!continuable) {
    throw new MangaError("VALIDATION_ERROR", "only cancelled or max_tokens runs without refusal can be continued", { details: { status: run.status, stopReason: usageMeta.stopReason ?? null } });
  }
  const grant = app.grants.get(run.grant_handle);
  if (!grant || grant.revoked) throw new MangaError("FORBIDDEN", "original run authorization is no longer available");

  const assistantRows = app.store.sqlite.prepare("SELECT id, text, payload_json FROM agent_messages WHERE run_id = ? AND role = 'assistant' ORDER BY created_at, rowid").all(run.id) as Array<{ id: string; text: string; payload_json: string | null }>;
  const trailingFinal = [...assistantRows].reverse().find((row) => {
    const payload = row.payload_json ? safeJsonValue(row.payload_json) as { toolCalls?: unknown[] } : undefined;
    return !payload?.toolCalls?.length && Boolean(row.text);
  });
  const prefixText = trailingFinal?.text ?? run.live_text ?? "";
  const prefixReasoning = trailingFinal?.payload_json
    ? (safeJsonValue(trailingFinal.payload_json) as { reasoning?: string } | undefined)?.reasoning
    : undefined;
  const limits = readAgentSettings(app.store).limits;
  const budget: AgentLoopBudget = { ...(JSON.parse(run.budget_json) as AgentLoopBudget), maxSteps: limits.maxSteps, maxDurationMs: limits.maxDurationMs };
  const runtime = (run.runtime === "pi" ? "pi" : "native") as AiRuntimeId;
  const now = new Date().toISOString();
  const deadlineAt = new Date(Date.now() + budget.maxDurationMs).toISOString();
  app.store.sqlite.prepare("UPDATE agent_runs SET status = 'running', error_json = NULL, budget_json = ?, deadline_at = ?, live_text = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(budget),
    deadlineAt,
    prefixText,
    now,
    run.id,
  );
  startRunLoop(app, run.id, grant, run.input_text, budget, runtime, {
    continuePrefill: prefixText.length > 0,
    prefixText,
    ...(prefixReasoning !== undefined ? { prefixReasoning } : {}),
    ...(trailingFinal ? { replaceMessageId: trailingFinal.id } : {}),
  });
  return {
    runId: run.id,
    sessionId: run.session_id,
    status: "running",
    inputText: run.input_text,
    previousRunId: run.id,
  };
}

/** Shared helper for `agent.regenerateRun` and `agent.editAndResend`: supersedes target turn (and any subsequent turns) cleanly and launches a fresh run. */
function relaunchTurn(
  app: AgentRunHost,
  envelope: CommandEnvelope,
  input: { runId: string; editedText?: string; allowCommands?: string[] },
): AgentRunActionResult {
  app.assertWritable();
  const owner = app.grantOf(envelope);
  if (owner.access !== "owner") throw new MangaError("FORBIDDEN", "relaunching a run belongs to the owner");
  const orig = app.store.sqlite.prepare("SELECT * FROM agent_runs WHERE id = ?").get(input.runId) as {
    id: string;
    session_id: string;
    status: string;
    grant_handle: string;
    snapshot_id: string | null;
    input_text: string;
    read_resource_ids_json: string | null;
    snapshot_json: string | null;
    created_at: string;
  } | undefined;
  if (!orig) throw new MangaError("NOT_FOUND", "run missing");

  // Ensure neither the target run nor any later run in the same session is still executing.
  const affected = app.store.sqlite.prepare(`SELECT id, status, usage_json FROM agent_runs WHERE session_id = ? AND created_at >= ? AND ${NOT_SUPERSEDED_SQL} ORDER BY created_at, rowid`).all(orig.session_id, orig.created_at) as Array<{ id: string; status: string; usage_json: string | null }>;
  for (const row of affected) {
    if (row.status === "running" || row.status === "queued" || row.status === "waiting_input" || app.runAbort.has(row.id)) {
      throw new MangaError("VALIDATION_ERROR", "run is still in progress");
    }
  }

  const promptText = input.editedText !== undefined ? input.editedText : orig.input_text;
  const origGrant = app.grants.get(orig.grant_handle);
  const origSnapshot = (orig.snapshot_json ? safeJsonValue(orig.snapshot_json) : {}) as Record<string, unknown>;
  const readResourceIds = (orig.read_resource_ids_json ? safeJsonValue(orig.read_resource_ids_json) : []) as string[];
  const projectId = typeof origSnapshot.contextId === "string" && app.projects.exists(origSnapshot.contextId) ? origSnapshot.contextId : null;
  const allowCommands = input.allowCommands !== undefined
    ? input.allowCommands
    : (origGrant?.allowedCommands ?? []).filter((cmd) => AGENT_OPT_IN_COMMANDS.includes(cmd));

  if (allowCommands.includes("metadata.search")) app.requireModule("metadata.search", "online metadata search");
  if (allowCommands.includes("semantic.search")) app.requireModule("semantic.search", "semantic search");
  if (allowCommands.includes("webpage.fetch")) {
    app.requireModule("webpage.fetch", "web page fetch");
    if (!projectId) throw new MangaError("FORBIDDEN", "webpage.fetch is only available in a project conversation", { details: { reason: "no-project" } });
  }

  const newRunId = createId("run");
  const now = new Date().toISOString();
  const runtime = currentRuntime(app);
  const agentSettings = readAgentSettings(app.store);
  const chosenConn = chatConnection(app, projectId ? app.projects.modelConnectionOf(projectId) : null, agentSettings.chat.connectionId);
  const connectionRow = chosenConn ? app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ?").get(chosenConn.id) as ConnectionRow | undefined : undefined;
  const choice: ChatChoice = { reasoningEffort: agentSettings.chat.reasoningEffort, contextWindow: agentSettings.chat.contextWindow };
  const chosenProfile = connectionRow ? withChoice(budgetOfConnection(connectionRow).profile, choice) : null;
  const model = budgetOf(chosenProfile ?? DEFAULT_MODEL_PROFILE);
  const budget: AgentLoopBudget = {
    maxSteps: agentSettings.limits.maxSteps,
    maxDurationMs: agentSettings.limits.maxDurationMs,
    contextWindow: model.contextWindow,
    contextTokens: model.contextTokens,
    maxOutputTokens: model.maxOutputTokens,
  };
  const shares = contextShares(model.contextTokens, promptText);
  const history = sessionHistoryForNewRun(app, orig.session_id, shares.history, orig.created_at);
  const deadlineAt = new Date(Date.now() + budget.maxDurationMs).toISOString();

  const agentGrant = app.issueAgentGrant(owner, { kind: "agent", id: `agent:${newRunId}` }, {
    sessionId: orig.session_id,
    runId: newRunId,
    readResourceIds,
    allowCommands,
    projectId,
  });

  const nextSnapshot: Record<string, unknown> = {
    ...origSnapshot,
    history,
    connectionId: chosenConn?.id ?? (typeof origSnapshot.connectionId === "string" ? origSnapshot.connectionId : null),
    choice,
    runtime,
    capturedAt: now,
    previousRunId: orig.id,
    ...(origSnapshot.wantInlineTitle ? { fallbackTitle: titleFrom(promptText) || origSnapshot.fallbackTitle } : {}),
  };

  // Preserve original user message payload metadata (quickTask, attachments).
  const origUserRow = app.store.sqlite.prepare("SELECT payload_json FROM agent_messages WHERE run_id = ? AND role = 'user' ORDER BY created_at, rowid LIMIT 1").get(orig.id) as { payload_json: string | null } | undefined;
  const origUserPayload = (origUserRow?.payload_json ? safeJsonValue(origUserRow.payload_json) : {}) as { quickTask?: { id: string | null; name: string }; attachments?: StreamUserAttachment[] };

  const mediaRows = app.store.sqlite.prepare("SELECT hash, ordinal FROM agent_run_media WHERE run_id = ? ORDER BY ordinal").all(orig.id) as Array<{ hash: string; ordinal: number }>;
  const supersedeMutations: Mutation[] = affected.map((row) => {
    const prevUsage = (row.usage_json ? safeJsonValue(row.usage_json) : {}) as Record<string, unknown>;
    return {
      sql: "UPDATE agent_runs SET usage_json = ?, updated_at = ? WHERE id = ?",
      params: [JSON.stringify({ ...prevUsage, supersededBy: newRunId }), now, row.id],
    };
  });
  const mediaCopyMutations: Mutation[] = mediaRows.map((row) => ({
    sql: "INSERT OR IGNORE INTO agent_run_media(run_id, hash, ordinal) VALUES (?,?,?)",
    params: [newRunId, row.hash, row.ordinal],
  }));

  const actionResult: AgentRunActionResult = {
    runId: newRunId,
    sessionId: orig.session_id,
    status: "running",
    inputText: promptText,
    previousRunId: orig.id,
  };

  app.store.commit({
    mutations: [
      ...supersedeMutations,
      {
        sql: "INSERT INTO agent_runs(id, session_id, status, grant_handle, snapshot_id, budget_json, input_text, read_resource_ids_json, snapshot_json, runtime, deadline_at, live_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params: [newRunId, orig.session_id, "running", agentGrant.handle, orig.snapshot_id, JSON.stringify(budget), promptText, JSON.stringify(readResourceIds), JSON.stringify(nextSnapshot), runtime, deadlineAt, "", now, now],
      },
      ...mediaCopyMutations,
    ],
    events: [{ type: "agent.run.started", payload: { runId: newRunId, sessionId: orig.session_id, previousRunId: orig.id } }],
    idempotencyKey: envelope.idempotencyKey,
    commandId: envelope.commandId,
    result: actionResult,
  });

  app.store.sqlite.prepare("INSERT INTO agent_messages(id, run_id, role, text, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(
    createId("msg"),
    newRunId,
    "user",
    promptText,
    JSON.stringify({
      kind: "user",
      ...(origUserPayload.quickTask ? { quickTask: origUserPayload.quickTask } : {}),
      ...(origUserPayload.attachments?.length ? { attachments: origUserPayload.attachments } : {}),
    }),
    now,
  );

  startRunLoop(app, newRunId, agentGrant, promptText, budget, runtime);
  return actionResult;
}

/** Regenerates an assistant reply (works on succeeded, failed, cancelled, or interrupted runs) with clean prior-turn context. */
export function regenerateRun(app: AgentRunHost, envelope: CommandEnvelope): AgentRunActionResult {
  const input = envelope.input as { runId: string; allowCommands?: string[] };
  return relaunchTurn(app, envelope, { runId: input.runId, allowCommands: input.allowCommands });
}

/** Updates an earlier user prompt cleanly and launches a fresh run in the same session. */
export function editAndResend(app: AgentRunHost, envelope: CommandEnvelope): AgentRunActionResult {
  const input = envelope.input as { runId: string; text: string; allowCommands?: string[] };
  return relaunchTurn(app, envelope, { runId: input.runId, editedText: input.text, allowCommands: input.allowCommands });
}

export function getRun(app: AgentRunHost, envelope: CommandEnvelope) {
  const input = envelope.input as { runId: string };
  const row = app.store.sqlite.prepare("SELECT id, session_id, status, grant_handle, input_text, error_json, budget_json, usage_json, snapshot_json, runtime, read_resource_ids_json, live_text, deadline_at, model_id, input_tokens, output_tokens, duration_ms, created_at, updated_at FROM agent_runs WHERE id = ?").get(input.runId) as {
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
    model_id: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    duration_ms: number | null;
    created_at: string;
    updated_at: string;
  } | undefined;
  if (!row) throw new MangaError("NOT_FOUND", "run missing");
  const toolRows = app.store.sqlite.prepare("SELECT id, command_id, status, input_summary, result_summary, created_at FROM agent_tool_events WHERE run_id = ? ORDER BY created_at, rowid").all(input.runId) as Array<{ id: string; command_id: string; status: string; input_summary: string; result_summary: string | null; created_at: string }>;
  const messages = app.store.sqlite.prepare("SELECT role, text, payload_json FROM agent_messages WHERE run_id = ? ORDER BY created_at, rowid").all(input.runId) as Array<{ role: string; text: string; payload_json: string | null }>;
  const tools = toolRows.map((item) => ({
    commandId: item.command_id,
    status: item.status,
    result: item.result_summary ? safeJsonValue(item.result_summary) : undefined,
  }));
  const live = liveRunExtras(row.id);
  const assistantText = messages.filter((item) => item.role === "assistant").map((item) => item.text).filter(Boolean).join("\n");
  const text = (row.status === "running" || row.status === "queued" ? (live?.text || row.live_text || assistantText) : (assistantText || live?.text || row.live_text)) || "";
  const rawSnapshot = row.snapshot_json ? safeJsonValue(row.snapshot_json) : undefined;
  const snapshotObj = (rawSnapshot && typeof rawSnapshot === "object" ? rawSnapshot : {}) as {
    materials?: unknown[];
    selection?: unknown;
    contextText?: string | null;
    media?: FrozenMedia;
    capturedAt?: string;
    notes?: Array<{ objectId: string; revision: number; title: string; text?: string; blockCount?: number; truncated?: boolean }>;
  };
  return {
    runId: row.id,
    sessionId: row.session_id,
    grantHandle: row.grant_handle,
    status: row.status,
    inputText: row.input_text,
    runtime: row.runtime === "pi" ? "pi" : "native",
    modelId: row.model_id ?? live?.modelId ?? null,
    error: row.error_json ? safeJsonValue(row.error_json) : undefined,
    budget: safeJsonValue(row.budget_json),
    usage: row.usage_json ? safeJsonValue(row.usage_json) : undefined,
    snapshot: rawSnapshot !== undefined ? redactSnapshot(rawSnapshot) : undefined,
    readResourceIds: row.read_resource_ids_json ? safeJsonValue(row.read_resource_ids_json) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deadlineAt: row.deadline_at,
    liveText: live?.text || row.live_text,
    live: live ?? null,
    run: {
      id: row.id,
      sessionId: row.session_id,
      status: row.status,
      inputText: row.input_text,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    tools,
    proposals: app.proposals.list({ runId: row.id }).proposals,
    messages,
    text,
    materials: snapshotObj.materials ?? [],
    selection: snapshotObj.selection,
    contextText: snapshotObj.contextText ?? null,
    media: publicMedia(snapshotObj.media),
    capturedAt: snapshotObj.capturedAt ?? null,
    noteMaterials: (snapshotObj.notes ?? []).map((note) => ({
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

function briefToolSummary(commandId: string, input: unknown, result: CommandResult): string | undefined {
  if (result.status !== "ok") return undefined;
  const obj = input && typeof input === "object" ? input as Record<string, unknown> : undefined;
  if (commandId === "web.search" && typeof obj?.query === "string") {
    const count = Array.isArray((result.value as { results?: unknown[] } | undefined)?.results)
      ? (result.value as { results: unknown[] }).results.length
      : undefined;
    return count !== undefined ? `${obj.query.slice(0, 60)}（${count} 条）` : obj.query.slice(0, 60);
  }
  if ((commandId === "library.find" || commandId === "research.search" || commandId === "semantic.search") && typeof obj?.text === "string") {
    return obj.text.slice(0, 60);
  }
  if (typeof obj?.query === "string" && obj.query.trim()) return obj.query.trim().slice(0, 60);
  if (typeof obj?.title === "string" && obj.title.trim()) return obj.title.trim().slice(0, 60);
  return undefined;
}

/** Keeps `result_summary` valid JSON even for large tool outputs so crash-resume replay always restores a `CommandResult`. */
function summarizeToolResult(result: CommandResult): string {
  const serialized = JSON.stringify(result);
  if (serialized.length <= 8000) return serialized;
  if (result.status === "ok") {
    return JSON.stringify({ status: "ok", value: { _truncated: true, originalChars: serialized.length, preview: serialized.slice(0, 7200) } });
  }
  return JSON.stringify({
    status: "error",
    error: {
      code: result.error?.code ?? "INTERNAL_ERROR",
      message: (result.error?.message ?? "").slice(0, 2000),
      retryable: Boolean(result.error?.retryable),
    },
  });
}

/** The `web.search` tool is offered only when an available search service is configured. */
function hasSearchService(app: AgentRunHost): boolean {
  const rows = app.store.sqlite.prepare(
    "SELECT c.id, a.provider_ref FROM provider_connections c LEFT JOIN provider_accounts a ON a.id = c.account_id WHERE c.purpose = 'search'",
  ).all() as Array<{ id: string; provider_ref: string | null }>;
  return rows.some((row) => !row.provider_ref || Boolean(app.providers.get(row.provider_ref)));
}
