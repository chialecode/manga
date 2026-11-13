import { MangaError } from "@manga/contracts";
import {
  createRequestSignal,
  joinApiPath,
  mapHttpError,
  networkError,
  parseJsonAnswer,
  protocolError,
  readSseLines,
  requireMachineAnswer,
  type ChatMessage,
  type Citation,
  type ServerToolEvent,
  type StreamEvent,
  type StreamUsage,
  type WebSource,
  type TextRequest,
  type ToolDefinition,
} from "./http.ts";

async function readError(response: Response): Promise<MangaError> {
  const body = await response.text().catch(() => "");
  return mapHttpError(response.status, body);
}

type ResponsesUsage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };

function responsesUsageOf(used: ResponsesUsage | undefined | null): StreamUsage | undefined {
  if (!used) return undefined;
  const usage: StreamUsage = {
    ...(typeof used.input_tokens === "number" ? { inputTokens: used.input_tokens } : {}),
    ...(typeof used.output_tokens === "number" ? { outputTokens: used.output_tokens } : {}),
    ...(typeof used.input_tokens_details?.cached_tokens === "number" ? { cachedInputTokens: used.input_tokens_details.cached_tokens } : {}),
  };
  return Object.keys(usage).length ? usage : undefined;
}

function toolPayload(tools?: ToolDefinition[], request?: TextRequest) {
  const functions: Array<Record<string, unknown>> = (tools ?? []).map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  // DeepSeek's own web search sits among the tools; it is only accepted with thinking on, which the caller has made sure of (计划 4.4).
  if (request?.dialect === "deepseek" && request.nativeWebSearch) functions.push({ type: "deepseek_web_search" });
  return functions.length ? functions : undefined;
}

/** DeepSeek's effort levels are low, high and max; the other names MANGA uses are mapped onto them (计划 4.3). */
export function deepseekEffort(effort: NonNullable<TextRequest["reasoningEffort"]>): "low" | "high" | "max" {
  if (effort === "minimal" || effort === "low") return "low";
  if (effort === "max") return "max";
  return "high";
}

/** The limits of a Chat Completions request: how long the answer may be and how hard to think, only when they were asked for. */
function chatLimits(request: TextRequest): Record<string, unknown> {
  if (request.dialect === "deepseek") {
    // The service thinks unless told not to, so the switch is always said; sampling settings do nothing while it thinks and are left out.
    const thinking = Boolean(request.reasoningEffort);
    return {
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      thinking: { type: thinking ? "enabled" : "disabled" },
      ...(thinking ? { reasoning_effort: deepseekEffort(request.reasoningEffort!) } : {}),
      ...(!thinking && request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };
  }
  return {
    ...(request.maxOutputTokens ? { [request.maxTokensField ?? "max_tokens"]: request.maxOutputTokens } : {}),
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.temperature !== undefined && !request.reasoningEffort ? { temperature: request.temperature } : {}),
  };
}

/** The same for Responses, which names them differently. */
function responseLimits(request: TextRequest): Record<string, unknown> {
  return {
    ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
    ...(request.reasoningEffort ? { reasoning: { effort: request.reasoningEffort } } : {}),
    ...(request.temperature !== undefined && !request.reasoningEffort ? { temperature: request.temperature } : {}),
  };
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
    if (message.role === "user" && (message.images?.length || message.files?.length)) {
      items.push({ role: "user", content: [
        { type: "input_text", text: message.content },
        ...(message.images ?? []).map((image) => ({ type: "input_image", image_url: `data:${image.mediaType};base64,${image.base64}` })),
        ...(message.files ?? []).map((file) => ({ type: "input_file", filename: file.filename, file_data: `data:${file.mediaType};base64,${file.base64}` })),
      ] });
    } else if (message.content || !message.toolCalls?.length) items.push({ role: message.role, content: message.content });
    for (const call of message.toolCalls ?? []) {
      items.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
    }
    return items;
  });
}

/**
 * The messages as the strictest servers take them: one system message, and first. The chat templates of many open models (Qwen's among them) refuse a system
 * message anywhere else, and a second one. The system messages that lead are joined into one; one later in the conversation (the material after earlier turns, a
 * summary, what a vision model read) goes as a user message marked as the system's, the way the PI runtime sends every one.
 */
function chatMessages(messages: ChatMessage[], dialect?: TextRequest["dialect"]) {
  // The thinking of the turn under way goes back with its assistant messages; an earlier turn's does not (计划 4.3).
  const turnStart = messages.map((message) => message.role).lastIndexOf("user");
  const extras = (message: ChatMessage, index: number): Record<string, unknown> => dialect !== "deepseek" || message.role !== "assistant" ? {} : {
    ...(index > turnStart && message.reasoning !== undefined ? { reasoning_content: message.reasoning } : {}),
    ...(message.serverToolCalls?.length ? { server_tool_calls: message.serverToolCalls } : {}),
  };
  let lead = 0;
  while (lead < messages.length && messages[lead]!.role === "system") lead += 1;
  const system = messages.slice(0, lead).map((message) => message.content).join("\n\n");
  return [...(lead ? [{ role: "system", content: system }] : []), ...messages.slice(lead).map((message, offset) => {
    if (message.role === "system") return { role: "user", content: `System: ${message.content}` };
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        ...extras(message, lead + offset),
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
    if (message.role === "user" && (message.images?.length || message.files?.length || message.videos?.length)) {
      return { role: "user", content: [
        { type: "text", text: message.content },
        ...(message.images ?? []).map((image) => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } })),
        ...(message.files ?? []).map((file) => ({ type: "file", file: { filename: file.filename, file_data: `data:${file.mediaType};base64,${file.base64}` } })),
        ...(message.videos ?? []).map((video) => ({ type: "video_url", video_url: { url: `data:${video.mediaType};base64,${video.base64}` } })),
      ] };
    }
    return { role: message.role, content: message.content, ...extras(message, lead + offset) };
  })];
}

type ChatUsage = { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; server_tool_use?: { tool_search?: number } };

/** The counts of an answer as MANGA keeps them; undefined when the service said none. */
function usageOf(used: ChatUsage | undefined | null): StreamUsage | undefined {
  if (!used) return undefined;
  const usage: StreamUsage = {
    ...(typeof used.prompt_tokens === "number" ? { inputTokens: used.prompt_tokens } : {}),
    ...(typeof used.completion_tokens === "number" ? { outputTokens: used.completion_tokens } : {}),
  };
  const cached = used.prompt_cache_hit_tokens ?? used.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number") usage.cachedInputTokens = cached;
  if (typeof used.server_tool_use?.tool_search === "number") usage.searches = used.server_tool_use.tool_search;
  return Object.keys(usage).length ? usage : undefined;
}

type RawSource = { url?: unknown; title?: unknown; site_name?: unknown; published_at?: unknown; snippet?: unknown };
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const WEB = /^https?:///i;
function sourceOf(raw: RawSource | undefined): WebSource | undefined {
  const url = str(raw?.url);
  if (!url || !WEB.test(url)) return undefined;
  const snippet = str(raw?.snippet);
  return { url, title: str(raw?.title) ?? url, ...(str(raw?.site_name) ? { site: str(raw?.site_name) } : {}), ...(str(raw?.published_at) ? { publishedAt: str(raw?.published_at) } : {}), ...(snippet ? { snippet: [...snippet].slice(0, 300).join("") } : {}) };
}

/** A `server_tool_event` as the interface shows it; one of a kind it does not know is left out. */
export function serverToolEventOf(raw: unknown): ServerToolEvent | undefined {
  const event = raw as { type?: string; call?: { id?: string; action?: { type?: string; queries?: unknown; url?: unknown }; sources?: RawSource[]; page?: RawSource } } | undefined;
  const call = event?.call;
  const callId = str(call?.id) ?? "";
  if (event?.type === "call_started" && call?.action?.type === "search") return { kind: "search", callId, queries: Array.isArray(call.action.queries) ? call.action.queries.filter((item): item is string => typeof item === "string").slice(0, 8) : [] };
  if (event?.type === "call_started" && call?.action?.type === "open_page" && str(call.action.url)) return { kind: "open", callId, url: str(call.action.url)! };
  if (event?.type === "call_completed") {
    const sources = (Array.isArray(call?.sources) ? call!.sources : []).map(sourceOf).filter((item): item is WebSource => Boolean(item)).slice(0, 20);
    const page = sourceOf(call?.page);
    return { kind: "done", callId, sources, ...(page ? { page } : {}) };
  }
  return undefined;
}

/** The citations of an answer (`annotations` of type `url_citation`). */
export function citationsOf(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  const out: Citation[] = [];
  for (const item of raw as Array<{ type?: string; url_citation?: { url?: unknown; title?: unknown; start_index?: unknown; end_index?: unknown } }>) {
    const cite = item?.type === "url_citation" ? item.url_citation : undefined;
    const url = str(cite?.url);
    if (!url || !WEB.test(url)) continue;
    out.push({ url, title: str(cite?.title) ?? url, ...(typeof cite?.start_index === "number" ? { start: cite.start_index } : {}), ...(typeof cite?.end_index === "number" ? { end: cite.end_index } : {}) });
  }
  return out.slice(0, 50);
}

/** A refusal by the service's content filter, in the words the person sees (计划 4.3). */
export const contentFiltered = () => new MangaError("PROVIDER_UNAVAILABLE", "内容被服务拒绝", { details: { kind: "content_filter" } });

export async function* streamChatCompletions(baseUrl: string, apiKey: string, request: TextRequest): AsyncGenerator<StreamEvent> {
  const url = joinApiPath(baseUrl, "/chat/completions");
  const req = createRequestSignal(request.timeoutMs ?? 60_000, request.signal);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: chatMessages(request.messages, request.dialect),
        tools: toolPayload(request.tools, request),
        stream: true,
        ...(request.dialect === "deepseek" ? { stream_options: { include_usage: true } } : {}),
        ...chatLimits(request),
      }),
      redirect: "error",
      signal: req.signal,
    }).catch((error) => { throw networkError(error, request.signal); });
    if (!response.ok) throw await readError(response);
    try {
      requireMachineAnswer(response);
    } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (!response.body) throw new MangaError("PROVIDER_UNAVAILABLE", "empty stream body");
    // Real streams carry the call id only in the first chunk of a tool call; later chunks identify it by index.
    const idByIndex = new Map<number, string>();
    const toolArgs = new Map<string, { name: string; arguments: string }>();
    const serverToolCalls: unknown[] = [];
    const citations: Citation[] = [];
    let usage: StreamUsage | undefined;
    let finishReason: string | null = null;
    let sawDone = false;
    try {
      for await (const line of readSseLines(response.body, request.signal)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          sawDone = true;
          break;
        }
        const json = parseJsonAnswer<{
          usage?: ChatUsage | null;
          error?: { message?: string; type?: string; code?: string };
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              annotations?: unknown;
              server_tool_calls?: unknown[];
              tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
            };
            server_tool_event?: unknown;
            finish_reason?: string | null;
          }>;
        }>(data, "a stream event");
        // A stream can end in an error of its own after a 200 (DeepSeek sends one as a data event): a failure the person can retry (计划 4.3).
        if (json.error) throw new MangaError("PROVIDER_UNAVAILABLE", "the service stopped the answer with an error", { retryable: true, details: { kind: "stream_error" } });
        const choice = json.choices?.[0];
        const delta = choice?.delta;
        if (delta?.reasoning_content) yield { type: "reasoning-delta", text: delta.reasoning_content };
        if (delta?.content) yield { type: "text-delta", text: delta.content };
        const serverEvent = choice?.server_tool_event ? serverToolEventOf(choice.server_tool_event) : undefined;
        if (serverEvent) yield { type: "server-tool", event: serverEvent };
        if (Array.isArray(delta?.server_tool_calls)) serverToolCalls.push(...delta!.server_tool_calls);
        citations.push(...citationsOf(delta?.annotations));
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
        usage = usageOf(json.usage) ?? usage;
        if (choice?.finish_reason) {
          if (choice.finish_reason === "content_filter") throw contentFiltered();
          // Keep draining until `[DONE]` or clean EOF so a trailing `choices: []` usage chunk (stream_options.include_usage) is captured.
          finishReason = choice.finish_reason;
        }
      }
    } catch (error) {
      if (error instanceof MangaError) throw error;
      if (req.isTimedOut()) throw networkError(new DOMException("request timed out", "TimeoutError"), request.signal);
      throw networkError(error, request.signal);
    }
    if (finishReason !== null || sawDone) {
      yield {
        type: "completed",
        finishReason: finishReason ?? "stop",
        ...(usage ? { usage } : {}),
        ...(serverToolCalls.length ? { serverToolCalls } : {}),
        ...(citations.length ? { citations } : {}),
      };
    }
  } finally {
    req.clear();
  }
}

export type CompletedText = { text: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; reasoning?: string; serverToolCalls?: unknown[]; citations?: Citation[]; usage?: StreamUsage };

export async function completeChatCompletions(baseUrl: string, apiKey: string, request: TextRequest): Promise<CompletedText> {
  const url = joinApiPath(baseUrl, "/chat/completions");
  const req = createRequestSignal(request.timeoutMs ?? 60_000, request.signal);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: chatMessages(request.messages, request.dialect),
        tools: toolPayload(request.tools, request),
        stream: false,
        ...chatLimits(request),
      }),
      redirect: "error",
      signal: req.signal,
    }).catch((error) => { throw networkError(error, request.signal); });
    if (!response.ok) throw await readError(response);
    try {
      requireMachineAnswer(response);
    } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    const bodyText = await response.text().catch((error) => {
      if (req.isTimedOut()) throw networkError(new DOMException("request timed out", "TimeoutError"), request.signal);
      throw networkError(error, request.signal);
    });
    const json = parseJsonAnswer<{
      usage?: ChatUsage;
      choices?: Array<{
        finish_reason?: string | null;
        message?: {
          content?: string | null;
          reasoning_content?: string | null;
          server_tool_calls?: unknown[];
          annotations?: unknown;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
    }>(bodyText, "JSON");
    // A service that answers with JSON that has no choices is not speaking Chat Completions.
    if (!Array.isArray(json.choices)) throw protocolError("no choices");
    if (json.choices[0]?.finish_reason === "content_filter") throw contentFiltered();
    const message = json.choices[0]?.message;
    const usage = usageOf(json.usage);
    const citations = citationsOf(message?.annotations);
    return {
      ...(typeof message?.reasoning_content === "string" && message.reasoning_content ? { reasoning: message.reasoning_content } : {}),
      ...(Array.isArray(message?.server_tool_calls) && message.server_tool_calls.length ? { serverToolCalls: message.server_tool_calls } : {}),
      ...(citations.length ? { citations } : {}),
      ...(usage ? { usage } : {}),
      text: message?.content ?? "",
      toolCalls: (message?.tool_calls ?? []).map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
    };
  } finally {
    req.clear();
  }
}

export async function* streamResponses(baseUrl: string, apiKey: string, request: TextRequest): AsyncGenerator<StreamEvent> {
  const url = joinApiPath(baseUrl, "/responses");
  const input = responseInput(request.messages);
  const req = createRequestSignal(request.timeoutMs ?? 60_000, request.signal);
  try {
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
        ...responseLimits(request),
      }),
      redirect: "error",
      signal: req.signal,
    }).catch((error) => { throw networkError(error, request.signal); });
    if (!response.ok) throw await readError(response);
    try {
      requireMachineAnswer(response);
    } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (!response.body) throw new MangaError("PROVIDER_UNAVAILABLE", "empty stream body");
    // Real Responses streams announce a function call (item_id, call_id, name) in output_item.added;
    // the argument deltas only carry item_id.
    const items = new Map<string, { callId: string; name: string; emittedArgs: boolean }>();
    try {
      for await (const line of readSseLines(response.body, request.signal)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          yield { type: "completed", finishReason: "stop" };
          return;
        }
        const json = parseJsonAnswer<{
          type?: string;
          delta?: string;
          name?: string;
          call_id?: string;
          item_id?: string;
          arguments?: string;
          error?: unknown;
          item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
          response?: { status?: string; incomplete_details?: { reason?: string } | null; usage?: ResponsesUsage };
        }>(data, "a stream event");
        if (json.type === "response.failed" || json.type === "error" || json.error) {
          throw new MangaError("PROVIDER_UNAVAILABLE", "the service stopped the answer with an error", { retryable: true, details: { kind: "stream_error" } });
        }
        if (json.type === "response.output_item.added" && json.item?.type === "function_call" && json.item.id) {
          items.set(json.item.id, { callId: json.item.call_id ?? json.item.id, name: json.item.name ?? "", emittedArgs: false });
        }
        if (json.type === "response.output_text.delta" && json.delta) yield { type: "text-delta", text: json.delta };
        if (json.type === "response.function_call_arguments.delta") {
          const item = json.item_id ? items.get(json.item_id) : undefined;
          const callId = item?.callId ?? json.call_id;
          if (callId) {
            if (item) item.emittedArgs = true;
            yield { type: "tool-call-delta", callId, name: item?.name ?? json.name ?? "", argumentsDelta: json.delta ?? json.arguments ?? "" };
          }
        }
        if (json.type === "response.function_call_arguments.done") {
          const item = json.item_id ? items.get(json.item_id) : undefined;
          if (item && !item.emittedArgs) {
            item.emittedArgs = true;
            yield { type: "tool-call-delta", callId: item.callId, name: item.name || json.name || "", argumentsDelta: json.arguments ?? "{}" };
          }
        }
        if (json.type === "response.output_item.done" && json.item?.type === "function_call") {
          const item = json.item.id ? items.get(json.item.id) : undefined;
          if (item && !item.emittedArgs) {
            item.emittedArgs = true;
            yield { type: "tool-call-delta", callId: item.callId, name: item.name || json.item.name || "", argumentsDelta: json.item.arguments ?? "{}" };
          } else if (!item && (json.item.call_id || json.item.id)) {
            const callId = json.item.call_id ?? json.item.id!;
            if (json.item.id) items.set(json.item.id, { callId, name: json.item.name ?? "", emittedArgs: true });
            yield { type: "tool-call-delta", callId, name: json.item.name ?? "", argumentsDelta: json.item.arguments ?? "{}" };
          }
        }
        if (json.type === "response.incomplete") {
          const reason = json.response?.incomplete_details?.reason;
          if (reason === "content_filter") throw contentFiltered();
          const usage = responsesUsageOf(json.response?.usage);
          yield {
            type: "completed",
            finishReason: reason === "max_output_tokens" ? "length" : "incomplete",
            ...(usage ? { usage } : {}),
          };
          return;
        }
        if (json.type === "response.completed") {
          if (json.response?.incomplete_details?.reason === "content_filter") throw contentFiltered();
          // The service states how many tokens the call used; a service that does not leaves them out and the usage page says so.
          const usage = responsesUsageOf(json.response?.usage);
          yield {
            type: "completed",
            finishReason: "stop",
            ...(usage ? { usage } : {}),
          };
          return;
        }
      }
    } catch (error) {
      if (error instanceof MangaError) throw error;
      if (req.isTimedOut()) throw networkError(new DOMException("request timed out", "TimeoutError"), request.signal);
      throw networkError(error, request.signal);
    }
  } finally {
    req.clear();
  }
}

export async function completeResponses(baseUrl: string, apiKey: string, request: TextRequest): Promise<CompletedText> {
  const url = joinApiPath(baseUrl, "/responses");
  const req = createRequestSignal(request.timeoutMs ?? 60_000, request.signal);
  try {
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
        ...responseLimits(request),
      }),
      redirect: "error",
      signal: req.signal,
    }).catch((error) => { throw networkError(error, request.signal); });
    if (!response.ok) throw await readError(response);
    try {
      requireMachineAnswer(response);
    } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    const bodyText = await response.text().catch((error) => {
      if (req.isTimedOut()) throw networkError(new DOMException("request timed out", "TimeoutError"), request.signal);
      throw networkError(error, request.signal);
    });
    const json = parseJsonAnswer<{
      output_text?: string;
      usage?: ResponsesUsage;
      incomplete_details?: { reason?: string } | null;
      output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string; content?: Array<{ text?: string }> }>;
    }>(bodyText, "JSON");
    if (json.incomplete_details?.reason === "content_filter") throw contentFiltered();
    if (typeof json.output_text !== "string" && !Array.isArray(json.output)) throw protocolError("no output");
    const toolCalls = (json.output ?? [])
      .filter((item) => item.type === "function_call")
      .map((item) => ({ id: item.call_id ?? "", name: item.name ?? "", arguments: item.arguments ?? "" }));
    const text = json.output_text ?? json.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("") ?? "";
    const usage = responsesUsageOf(json.usage);
    return { text, toolCalls, ...(usage ? { usage } : {}) };
  } finally {
    req.clear();
  }
}
