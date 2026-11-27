// The model runtime comes from the `models` entry, which does not load TypeBox (pi-ai 1.x); the types come from the root as types only.
// Tool parameters are plain JSON Schema (pi-ai 1.5 dropped the TypeBox re-exports and validates tool parameters as JSON Schema).
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { Context, JsonObject, Model, Tool } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { MangaError, type AgentErrorCode } from "@manga/contracts";
import { completeChatCompletions, completeResponses, contentFiltered, stopReasonOf, streamChatCompletions, streamResponses, type CompletedText } from "./openai-http.ts";
import { toolNamesOf, toWireRequest, withLocalToolNames } from "./tool-names.ts";
import { extractExpiredFileIds, type StreamEvent, type TextRequest, type ToolDefinition } from "./http.ts";

export type AiRuntimeId = "native" | "pi";

function unknownCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

type PiParams = { vision: boolean; reasoning: boolean; contextWindow: number; maxTokens: number; maxTokensField: "max_tokens" | "max_completion_tokens"; dialect?: "deepseek" };

const paramsOf = (request: TextRequest): PiParams => ({
  vision: request.messages.some((message) => message.images?.length),
  // A DeepSeek model is a reasoning model to pi either way, so pi says `thinking: disabled` when no effort is asked for (the service thinks by default).
  reasoning: Boolean(request.reasoningEffort) || request.dialect === "deepseek",
  ...(request.dialect ? { dialect: request.dialect } : {}),
  contextWindow: request.contextWindow ?? 128_000,
  maxTokens: request.maxOutputTokens ?? 8192,
  maxTokensField: request.maxTokensField ?? "max_tokens",
});

/**
 * DeepSeek extended Chat Completions features (`deepseek_web_search`, `deepseek_read_url`, inline `title`,
 * `latest_reminder`, continuation prefill, `safety_check`, `server_tool_calls` passback, and flat `file_id` refs)
 * emit DeepSeek-specific SSE/JSON fields that `@earendil-works/pi-ai`'s generic OpenAI stream parser drops.
 * Routing those requests through the unified DeepSeek dialect stream guarantees 100% parity under `pi`.
 */
export function usesDeepSeekExtendedStream(
  protocol: "openai-responses" | "openai-chat-completions",
  request: TextRequest,
): boolean {
  if (protocol !== "openai-chat-completions" || request.dialect !== "deepseek") return false;
  if (
    request.nativeWebSearch
    || request.readUrl
    || request.inlineTitle
    || Boolean(request.latestReminder)
    || request.continuePrefill
    || Boolean(request.safetyCheck)
    || Boolean(request.responseFormat)
  ) {
    return true;
  }
  return request.messages.some(
    (message) =>
      message.role === "latest_reminder"
      || Boolean(message.serverToolCalls?.length)
      || Boolean(message.fileRefs?.length)
      || Boolean(message.files?.some((file) => Boolean(file.fileId))),
  );
}

function piModel(protocol: "openai-responses" | "openai-chat-completions", baseUrl: string, modelId: string, params: PiParams): Model<"openai-responses" | "openai-completions"> {
  const input: Array<"text" | "image"> = params.vision ? ["text", "image"] : ["text"];
  if (protocol === "openai-responses") {
    return {
      id: modelId,
      name: modelId,
      api: "openai-responses",
      provider: "manga-byok",
      baseUrl,
      reasoning: params.reasoning,
      input,
      cost: unknownCost(),
      contextWindow: params.contextWindow,
      maxTokens: params.maxTokens,
      compat: { supportsDeveloperRole: false, supportsLongCacheRetention: false, supportsStrictMode: false },
    };
  }
  const deepseek = params.dialect === "deepseek";
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "manga-byok",
    baseUrl,
    reasoning: params.reasoning,
    input,
    cost: unknownCost(),
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
    ...(deepseek ? { thinkingLevelMap: { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" } } : {}),
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: params.reasoning,
      supportsUsageInStreaming: deepseek,
      supportsFinishReason: true,
      maxTokensField: deepseek ? "max_tokens" : params.maxTokensField,
      ...(deepseek ? { thinkingFormat: "deepseek" as const, requiresReasoningContentOnAssistantMessages: true } : {}),
    },
  };
}

function piTools(tools?: ToolDefinition[]): Tool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Tool["parameters"],
  }));
}

/** PI's Responses adapter keys tool calls as `call_id|item_id`; MANGA keeps the provider call id so both runtimes report the same identity. */
function providerCallId(id: string): string {
  const separator = id.indexOf("|");
  return separator > 0 ? id.slice(0, separator) : id;
}

function piContext(request: TextRequest, api: "openai-responses" | "openai-completions"): Context {
  const messages: Context["messages"] = [];
  const turnStart = request.messages.map((message) => message.role).lastIndexOf("user");
  for (const [index, message] of request.messages.entries()) {
    if (message.role === "latest_reminder") continue;
    if (message.role === "tool") {
      messages.push({
        role: "toolResult",
        toolCallId: message.toolCallId ?? "",
        toolName: "",
        content: [{ type: "text", text: message.content }],
        isError: false,
        timestamp: Date.now(),
      });
      continue;
    }
    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: [
          ...(request.dialect === "deepseek" && index > turnStart && message.reasoning !== undefined ? [{ type: "thinking" as const, thinking: message.reasoning, thinkingSignature: "reasoning_content" }] : []),
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...(message.toolCalls ?? []).map((call) => ({
            type: "toolCall" as const,
            id: call.id,
            name: call.name,
            arguments: safeJson(call.arguments),
          })),
        ],
        api,
        provider: "manga-byok",
        model: request.model,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: message.toolCalls?.length ? "toolUse" : "stop",
        timestamp: Date.now(),
      });
      continue;
    }
    messages.push({
      role: "user",
      content: message.images?.length && message.role === "user"
        ? [{ type: "text" as const, text: message.content }, ...message.images.map((image) => ({ type: "image" as const, data: image.base64, mimeType: image.mediaType }))]
        : message.role === "system" ? `System: ${message.content}` : message.content,
      timestamp: Date.now(),
    });
  }
  return { messages, tools: piTools(request.tools) };
}

/** A tool call's arguments as pi-ai 1.x wants them: a JSON object. */
function safeJson(text: string): JsonObject {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : { value: parsed as JsonObject[string] };
  } catch {
    return {};
  }
}

/**
 * PI reports a failure as text. The words it uses for status codes, expired files, and network faults are mapped here so
 * a failure carries the same code, status, kind, and `AgentErrorCode` under both runtimes.
 */
function mapPiError(message: string | undefined, signal?: AbortSignal): MangaError {
  const text = message ?? "provider failed";
  if (signal?.aborted) return new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" satisfies AgentErrorCode } });
  const status = Number(/\b(40[0-9]|41[0-9]|42[0-9]|5[0-9]{2})\b/.exec(text)?.[1]);
  const known = Number.isFinite(status) ? { status } : {};
  const expiredFileIds = extractExpiredFileIds(text);
  if (expiredFileIds.length) {
    return new MangaError("PROVIDER_UNAVAILABLE", "an uploaded file reference expired or is missing", {
      details: { ...known, kind: "file_expired", errorCode: "file_invalid" satisfies AgentErrorCode, expiredFileIds },
    });
  }
  if (/content[_ ]?filter|safety[_ ]?check|refusal/i.test(text)) return contentFiltered();
  if (status === 402 || /insufficient[_ ]?balance|out of credit/i.test(text)) {
    return new MangaError("PROVIDER_UNAVAILABLE", "the account has no balance left", { details: { status: 402, kind: "billing", errorCode: "balance" satisfies AgentErrorCode } });
  }
  if (status === 503 || /overloaded|service unavailable/i.test(text)) {
    return new MangaError("PROVIDER_UNAVAILABLE", "the service is busy", { retryable: true, details: { status: 503, kind: "busy", errorCode: "server" satisfies AgentErrorCode } });
  }
  if (/context[ _-]?(length|window)|maximum context|too many tokens|token limit|prompt is too long|input is too long/i.test(text)) {
    return new MangaError("PROVIDER_UNAVAILABLE", "provider HTTP 400", { details: { status: 400, kind: "context", errorCode: "context_overflow" satisfies AgentErrorCode } });
  }
  if (status === 401 || /unauthor|invalid api key|incorrect api key/i.test(text)) {
    return new MangaError("AUTHENTICATION_FAILED", "provider rejected the credentials", { details: { status: 401, errorCode: "auth" satisfies AgentErrorCode } });
  }
  if (status === 429 || /rate.?limit/i.test(text)) {
    return new MangaError("RATE_LIMITED", "provider rate limited the request", { retryable: true, details: { status: 429, errorCode: "rate_limit" satisfies AgentErrorCode } });
  }
  if (status === 404 || (!Number.isFinite(status) && /\bnot found\b/i.test(text))) {
    return new MangaError("MODEL_CAPABILITY_MISSING", "provider reported a missing capability", {
      details: { status: 404, kind: /model/i.test(text) ? "model" : "path", errorCode: "capability_missing" satisfies AgentErrorCode },
    });
  }
  if (/time.?out|timed out|abort/i.test(text)) {
    return new MangaError("PROVIDER_UNAVAILABLE", "request timed out", { retryable: true, details: { kind: "timeout", errorCode: "network" satisfies AgentErrorCode } });
  }
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|connection error|fetch failed|invalid url/i.test(text)) {
    return new MangaError("PROVIDER_UNAVAILABLE", "provider is not reachable", { retryable: true, details: { kind: "address", errorCode: "network" satisfies AgentErrorCode } });
  }
  if (/unexpected token|not valid json|<!doctype|<html|unexpected end of json|without finish_reason|stream ended|empty (response|stream)/i.test(text)) {
    return new MangaError("PROVIDER_UNAVAILABLE", "provider answered in an unexpected form", { details: { kind: "protocol", errorCode: "server" satisfies AgentErrorCode } });
  }
  const errorCode: AgentErrorCode = Number.isFinite(status) ? (status >= 500 ? "server" : "unknown") : "network";
  return new MangaError("PROVIDER_UNAVAILABLE", "provider request failed", {
    retryable: !Number.isFinite(status) || status >= 500,
    details: Number.isFinite(status) ? { ...known, errorCode } : { kind: "network", errorCode },
  });
}

function createByokModels(protocol: "openai-responses" | "openai-chat-completions", baseUrl: string, modelId: string, params: PiParams) {
  const model = piModel(protocol, baseUrl, modelId, params);
  const models = createModels();
  models.setProvider(createProvider({
    id: "manga-byok",
    name: "MANGA BYOK",
    baseUrl,
    auth: {
      apiKey: {
        name: "MANGA BYOK",
        resolve: async () => ({ auth: {} }),
      },
    },
    models: [model],
    api: protocol === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi(),
  }));
  return { models, model };
}

export async function* streamTextPi(
  protocol: "openai-responses" | "openai-chat-completions",
  baseUrl: string,
  apiKey: string,
  request: TextRequest,
): AsyncGenerator<StreamEvent> {
  if (usesDeepSeekExtendedStream(protocol, request)) {
    yield* streamChatCompletions(baseUrl, apiKey, request);
    return;
  }
  const { models, model } = createByokModels(protocol, baseUrl, request.model, paramsOf(request));
  const stream = request.reasoningEffort
    ? models.streamSimple(model, piContext(request, model.api), { apiKey, signal: request.signal, timeoutMs: request.timeoutMs, reasoning: request.reasoningEffort, ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}) })
    : models.stream(model, piContext(request, model.api), { apiKey, signal: request.signal, timeoutMs: request.timeoutMs, ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) });
  const args = new Map<number, { id: string; name: string; last: string }>();
  for await (const event of stream) {
    if (event.type === "text_delta") yield { type: "text-delta", text: event.delta };
    if (event.type === "thinking_delta" && event.delta) yield { type: "reasoning-delta", text: event.delta };
    if (event.type === "toolcall_start") {
      const block = event.partial.content[event.contentIndex];
      if (block && block.type === "toolCall") {
        const callId = providerCallId(block.id);
        args.set(event.contentIndex, { id: callId, name: block.name, last: "" });
        yield { type: "tool-call-delta", callId, name: block.name, argumentsDelta: "" };
      }
    }
    if (event.type === "toolcall_delta") {
      const current = args.get(event.contentIndex);
      if (current) {
        const next = current.last + event.delta;
        const delta = next.slice(current.last.length);
        current.last = next;
        if (delta) yield { type: "tool-call-delta", callId: current.id, name: current.name, argumentsDelta: delta };
      }
    }
    if (event.type === "toolcall_end") {
      const serialized = JSON.stringify(event.toolCall.arguments ?? {});
      const callId = providerCallId(event.toolCall.id);
      const current = args.get(event.contentIndex) ?? { id: callId, name: event.toolCall.name, last: "" };
      if (current.last.length === 0) {
        yield { type: "tool-call-delta", callId, name: event.toolCall.name, argumentsDelta: serialized };
        args.set(event.contentIndex, { id: callId, name: event.toolCall.name, last: serialized });
      }
    }
    if (event.type === "done") {
      const usage = event.message.usage;
      const known = usage.cost.total > 0;
      yield {
        type: "completed",
        finishReason: event.reason,
        stopReason: stopReasonOf(event.reason),
        usage: {
          inputTokens: usage.input,
          outputTokens: usage.output,
          ...(usage.cacheRead > 0 ? { cachedInputTokens: usage.cacheRead } : {}),
          costUsd: known ? usage.cost.total : undefined,
        },
      };
    }
    if (event.type === "error") throw mapPiError(event.error.errorMessage, request.signal);
  }
}

export async function completeTextPi(
  protocol: "openai-responses" | "openai-chat-completions",
  baseUrl: string,
  apiKey: string,
  request: TextRequest,
): Promise<CompletedText> {
  if (usesDeepSeekExtendedStream(protocol, request)) {
    return completeChatCompletions(baseUrl, apiKey, request);
  }
  const { models, model } = createByokModels(protocol, baseUrl, request.model, paramsOf(request));
  const message = request.reasoningEffort
    ? await models.completeSimple(model, piContext(request, model.api), { apiKey, signal: request.signal, timeoutMs: request.timeoutMs, reasoning: request.reasoningEffort, ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}) })
    : await models.complete(model, piContext(request, model.api), { apiKey, signal: request.signal, timeoutMs: request.timeoutMs, ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}) });
  if (message.stopReason === "aborted") {
    if (request.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" satisfies AgentErrorCode } });
    throw mapPiError("request timed out", request.signal);
  }
  if (message.stopReason === "error") throw mapPiError(message.errorMessage, request.signal);
  const text = message.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("");
  const toolCalls = message.content.filter((part) => part.type === "toolCall").map((part) => (
    part.type === "toolCall"
      ? { id: providerCallId(part.id), name: part.name, arguments: JSON.stringify(part.arguments ?? {}) }
      : { id: "", name: "", arguments: "{}" }
  ));
  const known = message.usage.cost.total > 0;
  const reasoning = message.content.filter((part) => part.type === "thinking").map((part) => part.type === "thinking" ? part.thinking : "").join("");
  return {
    text,
    toolCalls,
    stopReason: stopReasonOf(message.stopReason),
    ...(reasoning ? { reasoning } : {}),
    usage: {
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      ...(message.usage.cacheRead > 0 ? { cachedInputTokens: message.usage.cacheRead } : {}),
      costUsd: known ? message.usage.cost.total : undefined,
    },
  };
}

export async function completeText(
  protocol: "openai-responses" | "openai-chat-completions",
  baseUrl: string,
  apiKey: string,
  request: TextRequest,
  runtime: AiRuntimeId = "native",
): Promise<CompletedText> {
  const names = toolNamesOf(request);
  const wire = toWireRequest(request, names);
  const done = runtime === "pi" ? await completeTextPi(protocol, baseUrl, apiKey, wire)
    : protocol === "openai-responses" ? await completeResponses(baseUrl, apiKey, wire)
      : await completeChatCompletions(baseUrl, apiKey, wire);
  return done.toolCalls.length ? { ...done, toolCalls: done.toolCalls.map((call) => ({ ...call, name: names.local(call.name) })) } : done;
}

export function streamText(
  protocol: "openai-responses" | "openai-chat-completions",
  baseUrl: string,
  apiKey: string,
  request: TextRequest,
  runtime: AiRuntimeId = "native",
): AsyncGenerator<StreamEvent> {
  const names = toolNamesOf(request);
  const wire = toWireRequest(request, names);
  const events = runtime === "pi" ? streamTextPi(protocol, baseUrl, apiKey, wire)
    : protocol === "openai-responses" ? streamResponses(baseUrl, apiKey, wire)
      : streamChatCompletions(baseUrl, apiKey, wire);
  return withLocalToolNames(events, names);
}
