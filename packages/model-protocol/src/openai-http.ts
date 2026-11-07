import { MangaError } from "@manga/contracts";
import {
  joinApiPath,
  mapHttpError,
  readSseLines,
  type ChatMessage,
  type StreamEvent,
  type TextRequest,
  type ToolDefinition,
} from "./http.ts";

function timeoutSignal(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => {
    clearTimeout(timer);
    controller.abort();
  };
  external?.addEventListener("abort", onAbort, { once: true });
  controller.signal.addEventListener("abort", () => {
    clearTimeout(timer);
    external?.removeEventListener("abort", onAbort);
  }, { once: true });
  return controller.signal;
}

async function readError(response: Response): Promise<MangaError> {
  const body = await response.text().catch(() => "");
  return mapHttpError(response.status, body);
}

function toolPayload(tools?: ToolDefinition[]) {
  return (tools ?? []).map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function responseTools(tools?: ToolDefinition[]) {
  return tools?.length ? tools.map((tool) => ({ type: "function", ...tool })) : undefined;
}

function responseInput(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.flatMap((message): Array<Record<string, unknown>> => {
    if (message.role === "tool") {
      if (!message.toolCallId) throw new MangaError("VALIDATION_ERROR", "tool result requires a call id");
      return [{ type: "function_call_output", call_id: message.toolCallId, output: message.content }];
    }
    const items: Array<Record<string, unknown>> = [];
    if (message.content || !message.toolCalls?.length) items.push({ role: message.role, content: message.content });
    for (const call of message.toolCalls ?? []) {
      items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
    }
    return items;
  });
}

function chatMessages(messages: ChatMessage[]) {
  return messages.map((message) => {
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
    return { role: message.role, content: message.content };
  });
}

export async function* streamChatCompletions(baseUrl: string, apiKey: string, request: TextRequest): AsyncGenerator<StreamEvent> {
  const url = joinApiPath(baseUrl, "/chat/completions");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: chatMessages(request.messages),
      tools: request.tools?.length ? toolPayload(request.tools) : undefined,
      stream: true,
    }),
    signal: timeoutSignal(request.timeoutMs ?? 60_000, request.signal),
  }).catch((error) => {
    if (request.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
    throw new MangaError("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "network failure", { retryable: true });
  });
  if (!response.ok) throw await readError(response);
  if (!response.body) throw new MangaError("PROVIDER_UNAVAILABLE", "empty stream body");
  // Real streams carry the call id only in the first chunk of a tool call; later chunks identify it by index.
  const idByIndex = new Map<number, string>();
  const toolArgs = new Map<string, { name: string; arguments: string }>();
  for await (const line of readSseLines(response.body, request.signal)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") {
      yield { type: "completed", finishReason: "stop" };
      return;
    }
    const json = JSON.parse(data) as {
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
        };
        finish_reason?: string | null;
      }>;
    };
    const delta = json.choices?.[0]?.delta;
    if (delta?.content) yield { type: "text-delta", text: delta.content };
    for (const call of delta?.tool_calls ?? []) {
      const index = call.index ?? 0;
      if (call.id) idByIndex.set(index, call.id);
      const id = idByIndex.get(index) ?? `call-${index}`;
      const current = toolArgs.get(id) ?? { name: call.function?.name ?? "", arguments: "" };
      current.name = call.function?.name || current.name;
      current.arguments += call.function?.arguments ?? "";
      toolArgs.set(id, current);
      yield { type: "tool-call-delta", callId: id, name: current.name, argumentsDelta: call.function?.arguments ?? "" };
    }
    if (json.choices?.[0]?.finish_reason) {
      yield { type: "completed", finishReason: json.choices[0].finish_reason };
      return;
    }
  }
}

export async function completeChatCompletions(baseUrl: string, apiKey: string, request: TextRequest): Promise<{ text: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }> {
  const url = joinApiPath(baseUrl, "/chat/completions");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      messages: chatMessages(request.messages),
      tools: request.tools?.length ? toolPayload(request.tools) : undefined,
      stream: false,
    }),
    signal: timeoutSignal(request.timeoutMs ?? 60_000, request.signal),
  }).catch((error) => {
    if (request.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
    throw new MangaError("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "network failure", { retryable: true });
  });
  if (!response.ok) throw await readError(response);
  const json = await response.json() as {
    choices?: Array<{
      message?: {
        content?: string;
        tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
      };
    }>;
  };
  const message = json.choices?.[0]?.message;
  return {
    text: message?.content ?? "",
    toolCalls: (message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    })),
  };
}

export async function* streamResponses(baseUrl: string, apiKey: string, request: TextRequest): AsyncGenerator<StreamEvent> {
  const url = joinApiPath(baseUrl, "/responses");
  const input = responseInput(request.messages);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      input,
      tools: responseTools(request.tools),
      stream: true,
    }),
    signal: timeoutSignal(request.timeoutMs ?? 60_000, request.signal),
  }).catch((error) => {
    if (request.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
    throw new MangaError("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "network failure", { retryable: true });
  });
  if (!response.ok) throw await readError(response);
  if (!response.body) throw new MangaError("PROVIDER_UNAVAILABLE", "empty stream body");
  // Real Responses streams announce a function call (item_id, call_id, name) in output_item.added;
  // the argument deltas only carry item_id.
  const items = new Map<string, { callId: string; name: string }>();
  for await (const line of readSseLines(response.body, request.signal)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") {
      yield { type: "completed", finishReason: "stop" };
      return;
    }
    const json = JSON.parse(data) as {
      type?: string;
      delta?: string;
      name?: string;
      call_id?: string;
      item_id?: string;
      arguments?: string;
      item?: { type?: string; id?: string; call_id?: string; name?: string };
      response?: { status?: string };
    };
    if (json.type === "response.output_item.added" && json.item?.type === "function_call" && json.item.id) {
      items.set(json.item.id, { callId: json.item.call_id ?? json.item.id, name: json.item.name ?? "" });
    }
    if (json.type === "response.output_text.delta" && json.delta) yield { type: "text-delta", text: json.delta };
    if (json.type === "response.function_call_arguments.delta") {
      const item = json.item_id ? items.get(json.item_id) : undefined;
      const callId = item?.callId ?? json.call_id;
      if (callId) yield { type: "tool-call-delta", callId, name: item?.name ?? json.name ?? "", argumentsDelta: json.delta ?? json.arguments ?? "" };
    }
    if (json.type === "response.completed") {
      yield { type: "completed", finishReason: "stop" };
      return;
    }
  }
}

export async function completeResponses(baseUrl: string, apiKey: string, request: TextRequest): Promise<{ text: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }> {
  const url = joinApiPath(baseUrl, "/responses");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: request.model,
      input: responseInput(request.messages),
      tools: responseTools(request.tools),
      stream: false,
    }),
    signal: timeoutSignal(request.timeoutMs ?? 60_000, request.signal),
  }).catch((error) => {
    if (request.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
    throw new MangaError("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "network failure", { retryable: true });
  });
  if (!response.ok) throw await readError(response);
  const json = await response.json() as {
    output_text?: string;
    output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string; content?: Array<{ text?: string }> }>;
  };
  const toolCalls = (json.output ?? [])
    .filter((item) => item.type === "function_call")
    .map((item) => ({ id: item.call_id ?? "", name: item.name ?? "", arguments: item.arguments ?? "" }));
  const text = json.output_text ?? json.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("") ?? "";
  return { text, toolCalls };
}
