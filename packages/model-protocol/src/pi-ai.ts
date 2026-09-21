import { createModels, createProvider, Type, type Context, type Model, type Tool } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { MangaError } from "@manga/contracts";
import { completeChatCompletions, completeResponses, streamChatCompletions, streamResponses } from "./openai-http.ts";
import type { ChatMessage, StreamEvent, TextRequest, ToolDefinition } from "./http.ts";

export type AiRuntimeId = "native" | "pi";

function unknownCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function piModel(protocol: "openai-responses" | "openai-chat-completions", baseUrl: string, modelId: string): Model<"openai-responses" | "openai-completions"> {
  if (protocol === "openai-responses") {
    return {
      id: modelId,
      name: modelId,
      api: "openai-responses",
      provider: "manga-byok",
      baseUrl,
      reasoning: false,
      input: ["text"],
      cost: unknownCost(),
      contextWindow: 128_000,
      maxTokens: 8192,
      compat: { supportsDeveloperRole: false, supportsLongCacheRetention: false, supportsStrictMode: false },
    };
  }
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "manga-byok",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: unknownCost(),
    contextWindow: 128_000,
    maxTokens: 8192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      supportsFinishReason: true,
    },
  };
}

function piTools(tools?: ToolDefinition[]): Tool[] | undefined {
  if (!tools?.length) return undefined;
  // The command contract already produced a JSON schema; hand it to PI unchanged so both runtimes advertise the same tool surface.
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.parameters),
  }));
}

/** PI's Responses adapter keys tool calls as `call_id|item_id`; MANGA keeps the provider call id so both runtimes report the same identity. */
function providerCallId(id: string): string {
  const separator = id.indexOf("|");
  return separator > 0 ? id.slice(0, separator) : id;
}

function piContext(request: TextRequest, api: "openai-responses" | "openai-completions"): Context {
  const messages: Context["messages"] = [];
  for (const message of request.messages) {
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
      content: message.role === "system" ? `System: ${message.content}` : message.content,
      timestamp: Date.now(),
    });
  }
  return { messages, tools: piTools(request.tools) };
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { value: parsed };
  } catch {
    return {};
  }
}

function mapPiError(message?: string): MangaError {
  const text = message ?? "provider failed";
  if (/abort/i.test(text)) return new MangaError("CANCELLED", "request cancelled", { retryable: true });
  if (/401|unauthor/i.test(text)) return new MangaError("AUTHENTICATION_FAILED", "provider rejected the credentials");
  if (/429|rate/i.test(text)) return new MangaError("RATE_LIMITED", "provider rate limited the request", { retryable: true });
  return new MangaError("PROVIDER_UNAVAILABLE", "provider request failed", { retryable: true });
}

function createByokModels(protocol: "openai-responses" | "openai-chat-completions", baseUrl: string, modelId: string) {
  const model = piModel(protocol, baseUrl, modelId);
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
  const { models, model } = createByokModels(protocol, baseUrl, request.model);
  const stream = models.stream(model, piContext(request, model.api), {
    apiKey,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
  });
  const args = new Map<number, { id: string; name: string; last: string }>();
  for await (const event of stream) {
    if (event.type === "text_delta") yield { type: "text-delta", text: event.delta };
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
      const delta = serialized.slice(current.last.length);
      if (delta) yield { type: "tool-call-delta", callId, name: event.toolCall.name, argumentsDelta: delta };
      args.set(event.contentIndex, { id: callId, name: event.toolCall.name, last: serialized });
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
          costUsd: known ? usage.cost.total : undefined,
        },
      };
    }
    if (event.type === "error") throw mapPiError(event.error.errorMessage);
  }
}

export async function completeTextPi(
  protocol: "openai-responses" | "openai-chat-completions",
  baseUrl: string,
  apiKey: string,
  request: TextRequest,
): Promise<{ text: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } }> {
  const { models, model } = createByokModels(protocol, baseUrl, request.model);
  const message = await models.complete(model, piContext(request, model.api), {
    apiKey,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
  });
  if (message.stopReason === "aborted") throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
  if (message.stopReason === "error") throw mapPiError(message.errorMessage);
  const text = message.content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("");
  const toolCalls = message.content.filter((part) => part.type === "toolCall").map((part) => (
    part.type === "toolCall"
      ? { id: providerCallId(part.id), name: part.name, arguments: JSON.stringify(part.arguments ?? {}) }
      : { id: "", name: "", arguments: "{}" }
  ));
  const known = message.usage.cost.total > 0;
  return {
    text,
    toolCalls,
    usage: {
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
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
): Promise<{ text: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } }> {
  if (runtime === "pi") return completeTextPi(protocol, baseUrl, apiKey, request);
  if (protocol === "openai-responses") return completeResponses(baseUrl, apiKey, request);
  return completeChatCompletions(baseUrl, apiKey, request);
}

export function streamText(
  protocol: "openai-responses" | "openai-chat-completions",
  baseUrl: string,
  apiKey: string,
  request: TextRequest,
  runtime: AiRuntimeId = "native",
): AsyncGenerator<StreamEvent> {
  if (runtime === "pi") return streamTextPi(protocol, baseUrl, apiKey, request);
  if (protocol === "openai-responses") return streamResponses(baseUrl, apiKey, request);
  return streamChatCompletions(baseUrl, apiKey, request);
}
