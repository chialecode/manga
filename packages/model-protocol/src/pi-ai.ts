// The model runtime comes from the `models` entry, which does not load TypeBox (pi-ai 1.x); the types come from the root as types only.
// Tool parameters are plain JSON Schema (pi-ai 1.5 dropped the TypeBox re-exports and validates tool parameters as JSON Schema).
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { Context, JsonObject, Model, Tool } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { MangaError } from "@manga/contracts";
import { completeChatCompletions, completeResponses, contentFiltered, streamChatCompletions, streamResponses, type CompletedText } from "./openai-http.ts";
import { toolNamesOf, toWireRequest, withLocalToolNames } from "./tool-names.ts";
import type { ChatMessage, StreamEvent, TextRequest, ToolDefinition } from "./http.ts";

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
    // DeepSeek's levels are low, high and max; MANGA's names map onto them the same way the native runtime maps them (计划 4.3).
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
  // The command contract already produced a JSON schema; hand it to PI unchanged so both runtimes advertise the same tool surface.
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
  // The thinking of the turn under way goes back as a thinking block, which pi sends as `reasoning_content`; an earlier turn's does not (计划 4.3).
  const turnStart = request.messages.map((message) => message.role).lastIndexOf("user");
  for (const [index, message] of request.messages.entries()) {
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
      role: message.role === "system" ? "user" : "user",
      content: message.images?.length && message.role === "user"
        ? [{ type: "text" as const, text: message.content }, ...message.images.map((image) => ({ type: "image" as const, data: image.base64, mimeType: image.mediaType }))]
        : message.role === "system" ? `System: ${message.content}` : message.content,
      timestamp: Date.now(),
    });
  }
  return { messages, tools: piTools(request.tools) };
}

/** A tool call's arguments as pi-ai 1.x wants them: a JSON object (the text came from JSON.parse, so every value is JSON). */
function safeJson(text: string): JsonObject {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : { value: parsed as JsonObject[string] };
  } catch {
    return {};
  }
}

/**
 * PI reports a failure as text. The words it uses for the status codes and the network are matched here so a failure means the same thing to the person
 * as it does under the native runtime: the code, the status and the kind.
 */
function mapPiError(message: string | undefined, signal?: AbortSignal): MangaError {
  const text = message ?? "provider failed";
  if (signal?.aborted) return new MangaError("CANCELLED", "request cancelled", { retryable: true });
  const status = Number(/\b(40[0-9]|41[0-9]|42[0-9]|5[0-9]{2})\b/.exec(text)?.[1]);
  const known = Number.isFinite(status) ? { status } : {};
  if (/content[_ ]?filter/i.test(text)) return contentFiltered();
  if (status === 402 || /insufficient[_ ]?balance|out of credit/i.test(text)) return new MangaError("PROVIDER_UNAVAILABLE", "the account has no balance left", { details: { status: 402, kind: "billing" } });
  if (status === 503 || /overloaded|service unavailable/i.test(text)) return new MangaError("PROVIDER_UNAVAILABLE", "the service is busy", { retryable: true, details: { status: 503, kind: "busy" } });
  if (/context[ _-]?(length|window)|maximum context|too many tokens|token limit|prompt is too long|input is too long/i.test(text)) return new MangaError("PROVIDER_UNAVAILABLE", "provider HTTP 400", { details: { status: 400, kind: "context" } });
  if (status === 401 || /unauthor|invalid api key|incorrect api key/i.test(text)) return new MangaError("AUTHENTICATION_FAILED", "provider rejected the credentials", { details: { status: 401 } });
  if (status === 429 || /rate.?limit/i.test(text)) return new MangaError("RATE_LIMITED", "provider rate limited the request", { retryable: true, details: { status: 429 } });
  if (status === 404 || (!Number.isFinite(status) && /\bnot found\b/i.test(text))) return new MangaError("MODEL_CAPABILITY_MISSING", "provider reported a missing capability", { details: { status: 404, kind: /model/i.test(text) ? "model" : "path" } });
  if (/time.?out|timed out|abort/i.test(text)) return new MangaError("PROVIDER_UNAVAILABLE", "request timed out", { retryable: true, details: { kind: "timeout" } });
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|connection error|fetch failed|invalid url/i.test(text)) return new MangaError("PROVIDER_UNAVAILABLE", "provider is not reachable", { retryable: true, details: { kind: "address" } });
  if (/unexpected token|not valid json|<!doctype|<html|unexpected end of json|without finish_reason|stream ended|empty (response|stream)/i.test(text)) return new MangaError("PROVIDER_UNAVAILABLE", "provider answered in an unexpected form", { details: { kind: "protocol" } });
  return new MangaError("PROVIDER_UNAVAILABLE", "provider request failed", { retryable: !Number.isFinite(status) || status >= 500, details: Number.isFinite(status) ? known : { kind: "network" } });
}

/** DeepSeek's own web search is a tool pi does not know; it is added to the request pi built (计划 4.4). Its progress and citations are not read under pi. */
function payloadHook(request: TextRequest) {
  if (request.dialect !== "deepseek" || !request.nativeWebSearch) return {};
  return {
    onPayload: (params: unknown) => {
      const body = params as { tools?: unknown[] };
      return { ...body, tools: [...(body.tools ?? []), { type: "deepseek_web_search" }] };
    },
  };
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
  const { models, model } = createByokModels(protocol, baseUrl, request.model, paramsOf(request));
  const stream = request.reasoningEffort
    ? models.streamSimple(model, piContext(request, model.api), { apiKey, signal: request.signal, timeoutMs: request.timeoutMs, reasoning: request.reasoningEffort, ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}), ...payloadHook(request) })
    : models.stream(model, piContext(request, model.api), { apiKey, signal: request.signal, timeoutMs: request.timeoutMs, ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), ...payloadHook(request) });
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
  const { models, model } = createByokModels(protocol, baseUrl, request.model, paramsOf(request));
  const message = request.reasoningEffort
    ? await models.completeSimple(model, piContext(request, model.api), { apiKey, signal: request.signal, timeoutMs: request.timeoutMs, reasoning: request.reasoningEffort, ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}), ...payloadHook(request) })
    : await models.complete(model, piContext(request, model.api), { apiKey, signal: request.signal, timeoutMs: request.timeoutMs, ...(request.maxOutputTokens ? { maxTokens: request.maxOutputTokens } : {}), ...(request.temperature !== undefined ? { temperature: request.temperature } : {}), ...payloadHook(request) });
  if (message.stopReason === "aborted") {
    // Aborted by the caller is a cancel; aborted without the caller asking is the time running out.
    if (request.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
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
  // The tools go out under names the service accepts and their calls come back under the tools' own (`tool-names.ts`).
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
