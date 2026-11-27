import {
  MangaError,
  type AgentErrorCode,
  type AgentServerToolPage,
  type AgentServerToolStep,
  type AgentStopReason,
  type ServerToolStepKind,
} from "@manga/contracts";
import {
  createRequestSignal,
  extractExpiredFileIds,
  joinApiPath,
  mapHttpError,
  networkError,
  parseJsonAnswer,
  protocolError,
  readSseLines,
  requireMachineAnswer,
  type ChatMessage,
  type Citation,
  type CompletedText,
  type ServerToolEvent,
  type StreamEvent,
  type StreamUsage,
  type TextRequest,
  type ToolDefinition,
  type WebSource,
} from "./http.ts";

export type { CompletedText };

async function readError(response: Response): Promise<MangaError> {
  const body = await response.text().catch(() => "");
  return mapHttpError(response.status, body);
}

type ResponsesUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
  server_tool_use?: { tool_search?: number; tool_fetch?: number; tool_image_search?: number };
};

function responsesUsageOf(used: ResponsesUsage | undefined | null): StreamUsage | undefined {
  if (!used) return undefined;
  const usage: StreamUsage = {
    ...(typeof used.input_tokens === "number" ? { inputTokens: used.input_tokens } : {}),
    ...(typeof used.output_tokens === "number" ? { outputTokens: used.output_tokens } : {}),
    ...(typeof used.input_tokens_details?.cached_tokens === "number" ? { cachedInputTokens: used.input_tokens_details.cached_tokens } : {}),
    ...(typeof used.output_tokens_details?.reasoning_tokens === "number" ? { reasoningTokens: used.output_tokens_details.reasoning_tokens } : {}),
    ...(typeof used.server_tool_use?.tool_search === "number" ? { searches: used.server_tool_use.tool_search } : {}),
    ...(typeof used.server_tool_use?.tool_fetch === "number" ? { fetches: used.server_tool_use.tool_fetch } : {}),
    ...(typeof used.server_tool_use?.tool_image_search === "number" ? { imageSearches: used.server_tool_use.tool_image_search } : {}),
  };
  return Object.keys(usage).length ? usage : undefined;
}

function toolPayload(tools?: ToolDefinition[], request?: TextRequest) {
  const entries: Array<Record<string, unknown>> = (tools ?? []).map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
  if (request?.dialect === "deepseek") {
    // DeepSeek built-in server tools live in the `tools` array alongside client function tools.
    if (request.nativeWebSearch) entries.push({ type: "deepseek_web_search" });
    if (request.readUrl) entries.push({ type: "deepseek_read_url" });
  }
  return entries.length ? entries : undefined;
}

/** DeepSeek's effort levels are low, high and max; the other names MANGA uses map onto them. */
export function deepseekEffort(effort: NonNullable<TextRequest["reasoningEffort"]>): "low" | "high" | "max" {
  if (effort === "minimal" || effort === "low") return "low";
  if (effort === "max") return "max";
  return "high";
}

const WEEKDAYS_ZH = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"] as const;
const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * Formats a `latest_reminder` content string accepted by DeepSeek (`<YYYY-MM-DD>,<weekday>,<location>,<App|Web>,<language>`).
 */
export function formatLatestReminder(
  date: Date = new Date(),
  options: { language?: "中文" | "English"; platform?: "App" | "Web"; location?: string } = {},
): string {
  const language = options.language ?? "中文";
  const platform = options.platform ?? "App";
  const location = (options.location ?? "").replace(/,/g, " ").trim();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const day = date.getDay();
  const weekday = language === "English" ? WEEKDAYS_EN[day]! : WEEKDAYS_ZH[day]!;
  return `${yyyy}-${mm}-${dd},${weekday},${location},${platform},${language}`;
}

/** The limits and extended DeepSeek options of a Chat Completions request. */
function chatLimits(request: TextRequest): Record<string, unknown> {
  if (request.dialect === "deepseek") {
    // DeepSeek thinks unless told not to, so the switch is always explicit; sampling settings do nothing while it thinks.
    const thinking = Boolean(request.reasoningEffort);
    return {
      ...(request.maxOutputTokens ? { max_tokens: request.maxOutputTokens } : {}),
      thinking: { type: thinking ? "enabled" : "disabled" },
      ...(thinking ? { reasoning_effort: deepseekEffort(request.reasoningEffort!) } : {}),
      ...(!thinking && request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.inlineTitle ? { title: { enabled: true } } : {}),
      ...(request.safetyCheck === "high" ? { safety_check: { level: "high" } } : {}),
      ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
    };
  }
  return {
    ...(request.maxOutputTokens ? { [request.maxTokensField ?? "max_tokens"]: request.maxOutputTokens } : {}),
    ...(request.reasoningEffort ? { reasoning_effort: request.reasoningEffort } : {}),
    ...(request.temperature !== undefined && !request.reasoningEffort ? { temperature: request.temperature } : {}),
    ...(request.responseFormat ? { response_format: request.responseFormat } : {}),
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
    if (message.role === "latest_reminder") return [];
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

function withLatestReminder(messages: ChatMessage[], request?: TextRequest): ChatMessage[] {
  const reminder = request?.dialect === "deepseek" ? request.latestReminder?.trim() : undefined;
  if (!reminder) return messages;
  const lastUser = messages.map((message) => message.role).lastIndexOf("user");
  if (lastUser < 0) return messages;
  if (lastUser > 0 && messages[lastUser - 1]?.role === "latest_reminder") return messages;
  return [
    ...messages.slice(0, lastUser),
    { role: "latest_reminder", content: reminder },
    ...messages.slice(lastUser),
  ];
}

/**
 * The messages as the strictest servers take them: one system message, and first.
 * DeepSeek supports `latest_reminder` roles, flat `{ type: "file", file_id }` parts, `server_tool_calls` passback,
 * active-turn `reasoning_content`, and trailing assistant continuation prefill.
 */
function chatMessages(rawMessages: ChatMessage[], dialect?: TextRequest["dialect"], request?: TextRequest) {
  const messages = withLatestReminder(rawMessages, request);
  const thinking = Boolean(request?.reasoningEffort);
  // The thinking of the turn under way goes back with its assistant messages; an earlier turn's does not.
  const turnStart = messages.map((message) => message.role).lastIndexOf("user");
  const extras = (message: ChatMessage, index: number): Record<string, unknown> => {
    if (dialect !== "deepseek" || message.role !== "assistant") return {};
    const isTrailingContinuation = Boolean(request?.continuePrefill && index === messages.length - 1);
    const includeReasoning = index > turnStart && message.reasoning !== undefined && (!isTrailingContinuation || thinking);
    return {
      ...(includeReasoning ? { reasoning_content: message.reasoning } : {}),
      ...(message.serverToolCalls?.length ? { server_tool_calls: message.serverToolCalls } : {}),
    };
  };
  let lead = 0;
  while (lead < messages.length && messages[lead]!.role === "system") lead += 1;
  const system = messages.slice(0, lead).map((message) => message.content).join("\n\n");
  return [...(lead ? [{ role: "system", content: system }] : []), ...messages.slice(lead).map((message, offset) => {
    const index = lead + offset;
    if (message.role === "system") return { role: "user", content: `System: ${message.content}` };
    if (message.role === "latest_reminder") return { role: "latest_reminder", content: message.content };
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content || null,
        ...extras(message, index),
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
    if (message.role === "user" && (message.images?.length || message.files?.length || message.fileRefs?.length || message.videos?.length)) {
      const fileParts: Array<Record<string, unknown>> = [];
      for (const ref of message.fileRefs ?? []) {
        if (dialect === "deepseek") fileParts.push({ type: "file", file_id: ref.fileId });
        else fileParts.push({ type: "file", file: { file_id: ref.fileId, ...(ref.filename ? { filename: ref.filename } : {}) } });
      }
      for (const file of message.files ?? []) {
        if (dialect === "deepseek" && file.fileId) fileParts.push({ type: "file", file_id: file.fileId });
        else fileParts.push({ type: "file", file: { filename: file.filename, file_data: `data:${file.mediaType};base64,${file.base64}` } });
      }
      return {
        role: "user",
        content: [
          { type: "text", text: message.content },
          ...(message.images ?? []).map((image) => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } })),
          ...fileParts,
          ...(message.videos ?? []).map((video) => ({ type: "video_url", video_url: { url: `data:${video.mediaType};base64,${video.base64}` } })),
        ],
      };
    }
    return { role: message.role, content: message.content, ...extras(message, index) };
  })];
}

type ChatUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number; safety_tokens?: number };
  server_tool_use?: { tool_search?: number; tool_fetch?: number; tool_image_search?: number };
};

/** The counts of an answer as MANGA keeps them; undefined when the service said none. */
function usageOf(used: ChatUsage | undefined | null): StreamUsage | undefined {
  if (!used) return undefined;
  const usage: StreamUsage = {
    ...(typeof used.prompt_tokens === "number" ? { inputTokens: used.prompt_tokens } : {}),
    ...(typeof used.completion_tokens === "number" ? { outputTokens: used.completion_tokens } : {}),
  };
  const cached = used.prompt_cache_hit_tokens ?? used.prompt_tokens_details?.cached_tokens;
  if (typeof cached === "number") usage.cachedInputTokens = cached;
  if (typeof used.completion_tokens_details?.reasoning_tokens === "number") usage.reasoningTokens = used.completion_tokens_details.reasoning_tokens;
  if (typeof used.server_tool_use?.tool_search === "number") usage.searches = used.server_tool_use.tool_search;
  if (typeof used.server_tool_use?.tool_fetch === "number") usage.fetches = used.server_tool_use.tool_fetch;
  if (typeof used.server_tool_use?.tool_image_search === "number") usage.imageSearches = used.server_tool_use.tool_image_search;
  return Object.keys(usage).length ? usage : undefined;
}

type RawSource = { url?: unknown; title?: unknown; site_name?: unknown; site_icon?: unknown; published_at?: unknown; date?: unknown; snippet?: unknown };
const str = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const WEB = /^https?:\/\//i;

function sourceOf(raw: RawSource | undefined): WebSource | undefined {
  const url = str(raw?.url);
  if (!url || !WEB.test(url)) return undefined;
  const snippet = str(raw?.snippet);
  const siteIcon = str(raw?.site_icon);
  const publishedAt = str(raw?.published_at ?? raw?.date);
  return {
    url,
    title: str(raw?.title) ?? url,
    ...(str(raw?.site_name) ? { site: str(raw?.site_name) } : {}),
    ...(siteIcon && WEB.test(siteIcon) ? { siteIcon } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(snippet ? { snippet: [...snippet].slice(0, 300).join("") } : {}),
  };
}

function queriesOf(action: { queries?: unknown; query?: unknown } | undefined): string[] {
  if (Array.isArray(action?.queries)) {
    return action.queries.filter((item): item is string => typeof item === "string" && item.trim().length > 0).slice(0, 8);
  }
  const single = str(action?.query);
  return single ? [single] : [];
}

/**
 * Parses a DeepSeek `server_tool_event` into a typed `ServerToolEvent` aligned with `@manga/contracts`.
 * Covers `search`, `open_page` (emitted as `open` for backward compatibility), `find_in_page`, `read_link`,
 * `image_search`, `deep_image_search`, and `call_completed` (`done`).
 */
export function serverToolEventOf(raw: unknown): ServerToolEvent | undefined {
  const event = raw as {
    type?: string;
    call?: {
      id?: string;
      kind?: string;
      status?: string;
      failed?: boolean;
      found?: boolean;
      matches?: unknown;
      action?: { type?: string; queries?: unknown; query?: unknown; url?: unknown; pattern?: unknown; keyword?: unknown; title?: unknown; site_icon?: unknown };
      sources?: RawSource[];
      page?: RawSource;
    };
  } | undefined;
  const call = event?.call;
  const callId = str(call?.id) ?? "";
  if (event?.type === "call_started") {
    const actionType = str(call?.action?.type);
    const callKind = str(call?.kind);
    if (callKind === "deep_image_search") {
      return { kind: "deep_image_search", callId, queries: queriesOf(call?.action), status: "wip" };
    }
    if (callKind === "image_search" || actionType === "image_search") {
      return { kind: "image_search", callId, queries: queriesOf(call?.action), status: "wip" };
    }
    if (actionType === "search") {
      return { kind: "search", callId, queries: queriesOf(call?.action), status: "wip" };
    }
    if (actionType === "open_page") {
      const url = str(call?.action?.url);
      if (!url) return undefined;
      const title = str(call?.action?.title);
      const siteIcon = str(call?.action?.site_icon);
      return {
        kind: "open",
        callId,
        url,
        ...(title ? { title } : {}),
        ...(siteIcon && WEB.test(siteIcon) ? { siteIcon } : {}),
        status: "wip",
      };
    }
    if (actionType === "read_link") {
      const url = str(call?.action?.url);
      if (!url) return undefined;
      const title = str(call?.action?.title);
      const siteIcon = str(call?.action?.site_icon);
      return {
        kind: "read_link",
        callId,
        url,
        ...(title ? { title } : {}),
        ...(siteIcon && WEB.test(siteIcon) ? { siteIcon } : {}),
        status: "wip",
      };
    }
    if (actionType === "find_in_page") {
      const url = str(call?.action?.url);
      const pattern = str(call?.action?.pattern ?? call?.action?.keyword);
      if (!url || !pattern) return undefined;
      return { kind: "find_in_page", callId, url, pattern, status: "wip" };
    }
  }
  if (event?.type === "call_completed") {
    const sources = (Array.isArray(call?.sources) ? call!.sources : []).map(sourceOf).filter((item): item is WebSource => Boolean(item)).slice(0, 20);
    const page = sourceOf(call?.page);
    const status = str(call?.status)?.toLowerCase();
    const failed = call?.failed === true || status === "failed" || status === "error";
    const found = typeof call?.found === "boolean"
      ? call.found
      : Array.isArray(call?.matches)
        ? call.matches.length > 0
        : undefined;
    return {
      kind: "done",
      callId,
      sources,
      ...(page ? { page } : {}),
      ...(typeof found === "boolean" ? { found } : {}),
      ...(failed ? { failed: true } : {}),
    };
  }
  return undefined;
}

function pageOfSource(source: WebSource, failed?: boolean): AgentServerToolPage {
  return {
    url: source.url,
    ...(source.title ? { title: source.title } : {}),
    ...(source.site ? { site: source.site } : {}),
    ...(source.siteIcon ? { siteIcon: source.siteIcon } : {}),
    ...(source.snippet ? { snippet: source.snippet } : {}),
    ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
    ...(failed ? { failed: true } : {}),
  };
}

/** Aggregates raw streaming `ServerToolEvent[]` into structured `AgentServerToolStep[]` for UI timeline rendering. */
export function aggregateServerToolSteps(events: readonly ServerToolEvent[]): AgentServerToolStep[] {
  const steps: AgentServerToolStep[] = [];
  const byCallId = new Map<string, AgentServerToolStep>();
  let seq = 0;

  for (const event of events) {
    if (event.kind === "done") {
      const target = (event.callId ? byCallId.get(event.callId) : undefined)
        ?? [...steps].reverse().find((step) => step.status === "wip");
      if (!target) continue;
      target.status = event.failed ? "error" : "done";
      if (event.sources.length) {
        const merged = [...(target.pages ?? [])];
        for (const source of event.sources) {
          if (!merged.some((item) => item.url === source.url)) merged.push(pageOfSource(source));
        }
        target.pages = merged;
      }
      if (event.page) {
        const nextPage = pageOfSource(event.page, event.failed);
        const existing = target.pages?.findIndex((item) => item.url === nextPage.url) ?? -1;
        if (existing >= 0 && target.pages) target.pages[existing] = { ...target.pages[existing], ...nextPage };
        else target.pages = [...(target.pages ?? []), nextPage];
      } else if (event.failed && target.pages?.length) {
        target.pages = target.pages.map((page) => ({ ...page, failed: true }));
      }
      if (target.kind === "find_in_page" && target.keywords?.length && typeof event.found === "boolean") {
        target.keywords = target.keywords.map((keyword) => ({ ...keyword, found: event.found }));
      }
      continue;
    }

    seq += 1;
    const id = event.callId || `step-${seq}`;
    const kind: ServerToolStepKind = event.kind === "open" ? "open_page" : event.kind;
    let step: AgentServerToolStep;
    if ("queries" in event) {
      step = {
        id,
        kind,
        status: event.status ?? "wip",
        queries: [...event.queries],
        ...(event.sources?.length ? { pages: event.sources.map((source) => pageOfSource(source)) } : {}),
      };
    } else if (event.kind === "find_in_page") {
      step = {
        id,
        kind,
        status: event.status ?? "wip",
        keywords: [{ pattern: event.pattern, url: event.url, ...(typeof event.found === "boolean" ? { found: event.found } : {}) }],
      };
    } else {
      step = {
        id,
        kind,
        status: event.status ?? "wip",
        pages: [{
          url: event.url,
          ...(event.title ? { title: event.title } : {}),
          ...(event.siteIcon ? { siteIcon: event.siteIcon } : {}),
          ...(event.failed ? { failed: true } : {}),
        }],
      };
    }
    steps.push(step);
    if (event.callId) byCallId.set(event.callId, step);
  }

  return steps;
}

/** The citations of an answer (`annotations` of type `url_citation`), enriched with source metadata when available. */
export function citationsOf(raw: unknown, sourcesByUrl?: ReadonlyMap<string, WebSource>, startIndex = 1): Citation[] {
  if (!Array.isArray(raw)) return [];
  const out: Citation[] = [];
  let nextIndex = startIndex;
  for (const item of raw as Array<{
    type?: string;
    url_citation?: {
      url?: unknown;
      title?: unknown;
      start_index?: unknown;
      end_index?: unknown;
      site_name?: unknown;
      site_icon?: unknown;
      snippet?: unknown;
      published_at?: unknown;
      date?: unknown;
    };
  }>) {
    const cite = item?.type === "url_citation" ? item.url_citation : undefined;
    const url = str(cite?.url);
    if (!url || !WEB.test(url)) continue;
    const meta = sourcesByUrl?.get(url);
    const site = str(cite?.site_name) ?? meta?.site;
    const rawIcon = str(cite?.site_icon);
    const siteIcon = (rawIcon && WEB.test(rawIcon) ? rawIcon : undefined) ?? meta?.siteIcon;
    const snippet = str(cite?.snippet) ?? meta?.snippet;
    const publishedAt = str(cite?.published_at ?? cite?.date) ?? meta?.publishedAt;
    out.push({
      index: nextIndex,
      url,
      title: str(cite?.title) ?? meta?.title ?? url,
      ...(typeof cite?.start_index === "number" ? { start: cite.start_index } : {}),
      ...(typeof cite?.end_index === "number" ? { end: cite.end_index } : {}),
      ...(site ? { site } : {}),
      ...(siteIcon ? { siteIcon } : {}),
      ...(snippet ? { snippet: [...snippet].slice(0, 300).join("") } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    });
    nextIndex += 1;
  }
  return out.slice(0, 50);
}

/** Maps wire `finish_reason` strings onto `@manga/contracts` `AgentStopReason`. */
export function stopReasonOf(finishReason: string | null | undefined, hasRefusal = false): AgentStopReason {
  if (hasRefusal || finishReason === "refusal" || finishReason === "content_filter") return "refusal";
  if (finishReason === "length" || finishReason === "max_tokens") return "max_tokens";
  if (finishReason === "tool_calls" || finishReason === "tool_use" || finishReason === "toolUse") return "tool_use";
  return "end_turn";
}

/** A refusal by the service's content filter, in the words the person sees. */
export const contentFiltered = () => new MangaError("PROVIDER_UNAVAILABLE", "内容被服务拒绝", {
  details: { kind: "content_filter", errorCode: "refusal" satisfies AgentErrorCode },
});

function streamErrorOf(rawError: { message?: string; type?: string; code?: string }): MangaError {
  const text = `${rawError.message ?? ""} ${rawError.type ?? ""} ${rawError.code ?? ""}`.trim();
  const expiredFileIds = extractExpiredFileIds(text);
  let errorCode: AgentErrorCode = "server";
  if (expiredFileIds.length) errorCode = "file_invalid";
  else if (/content[_ ]?filter|refusal|safety/i.test(text)) errorCode = "refusal";
  else if (/rate[_ ]?limit|429/i.test(text)) errorCode = "rate_limit";
  else if (/insufficient[_ ]?balance|402/i.test(text)) errorCode = "balance";
  else if (/auth|invalid api key|401/i.test(text)) errorCode = "auth";
  return new MangaError("PROVIDER_UNAVAILABLE", "the service stopped the answer with an error", {
    retryable: errorCode === "server" || errorCode === "rate_limit",
    details: {
      kind: expiredFileIds.length ? "file_expired" : "stream_error",
      errorCode,
      ...(expiredFileIds.length ? { expiredFileIds } : {}),
    },
  });
}

function mergeSource(sourcesByUrl: Map<string, WebSource>, next: WebSource): void {
  const prev = sourcesByUrl.get(next.url);
  sourcesByUrl.set(next.url, prev ? { ...prev, ...next } : next);
}

function recordSources(sourcesByUrl: Map<string, WebSource>, event: ServerToolEvent): void {
  if (event.kind !== "done") return;
  for (const source of event.sources) mergeSource(sourcesByUrl, source);
  if (event.page) mergeSource(sourcesByUrl, event.page);
}

export async function* streamChatCompletions(baseUrl: string, apiKey: string, request: TextRequest): AsyncGenerator<StreamEvent> {
  const url = joinApiPath(baseUrl, "/chat/completions");
  const req = createRequestSignal(request.timeoutMs ?? 60_000, request.signal);
  try {
    const response = await (request.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: chatMessages(request.messages, request.dialect, request),
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
    if (!response.body) throw new MangaError("PROVIDER_UNAVAILABLE", "empty stream body", { details: { errorCode: "server" satisfies AgentErrorCode } });
    // Real streams carry the call id only in the first chunk of a tool call; later chunks identify it by index.
    const idByIndex = new Map<number, string>();
    const toolArgs = new Map<string, { name: string; arguments: string }>();
    const serverToolCalls: unknown[] = [];
    const serverEvents: ServerToolEvent[] = [];
    const sourcesByUrl = new Map<string, WebSource>();
    const citations: Citation[] = [];
    let title = "";
    let sawRefusal = false;
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
              title?: string | null;
              refusal?: string | null;
              annotations?: unknown;
              server_tool_calls?: unknown[];
              tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
            };
            server_tool_event?: { type?: string };
            finish_reason?: string | null;
          }>;
        }>(data, "a stream event");
        if (json.error) throw streamErrorOf(json.error);
        const choice = json.choices?.[0];
        const delta = choice?.delta;
        if (delta?.reasoning_content) yield { type: "reasoning-delta", text: delta.reasoning_content };
        if (delta?.content) yield { type: "text-delta", text: delta.content };
        if (typeof delta?.title === "string" && delta.title) {
          title += delta.title;
          yield { type: "title-delta", text: delta.title };
        }
        if (typeof delta?.refusal === "string" && delta.refusal) sawRefusal = true;
        if (choice?.server_tool_event?.type === "step_reasoning_done") {
          yield { type: "step-reasoning-done" };
        } else if (choice?.server_tool_event) {
          const serverEvent = serverToolEventOf(choice.server_tool_event);
          if (serverEvent) {
            serverEvents.push(serverEvent);
            recordSources(sourcesByUrl, serverEvent);
            yield { type: "server-tool", event: serverEvent, steps: aggregateServerToolSteps(serverEvents) };
          }
        }
        if (Array.isArray(delta?.server_tool_calls)) serverToolCalls.push(...delta!.server_tool_calls);
        const nextCitations = citationsOf(delta?.annotations, sourcesByUrl, citations.length + 1);
        if (nextCitations.length) citations.push(...nextCitations);
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
          if (choice.finish_reason === "refusal") sawRefusal = true;
          // Keep draining until `[DONE]` or clean EOF so a trailing `choices: []` usage chunk is captured.
          finishReason = choice.finish_reason;
        }
      }
    } catch (error) {
      if (error instanceof MangaError) throw error;
      if (req.isTimedOut()) throw networkError(new DOMException("request timed out", "TimeoutError"), request.signal);
      throw networkError(error, request.signal);
    }
    if (finishReason !== null || sawDone) {
      const serverToolSteps = serverEvents.length ? aggregateServerToolSteps(serverEvents) : undefined;
      const stopReason = stopReasonOf(finishReason, sawRefusal);
      yield {
        type: "completed",
        finishReason: finishReason ?? "stop",
        stopReason,
        ...(sawRefusal || stopReason === "refusal" ? { refusal: true } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(usage ? { usage } : {}),
        ...(serverToolCalls.length ? { serverToolCalls } : {}),
        ...(serverToolSteps?.length ? { serverToolSteps } : {}),
        ...(citations.length ? { citations } : {}),
      };
    }
  } finally {
    req.clear();
  }
}

export async function completeChatCompletions(baseUrl: string, apiKey: string, request: TextRequest): Promise<CompletedText> {
  const url = joinApiPath(baseUrl, "/chat/completions");
  const req = createRequestSignal(request.timeoutMs ?? 60_000, request.signal);
  try {
    const response = await (request.fetchImpl ?? fetch)(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: request.model,
        messages: chatMessages(request.messages, request.dialect, request),
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
          title?: string | null;
          refusal?: string | null;
          server_tool_calls?: unknown[];
          annotations?: unknown;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
    }>(bodyText, "JSON");
    if (!Array.isArray(json.choices)) throw protocolError("no choices");
    const finishReason = json.choices[0]?.finish_reason ?? null;
    if (finishReason === "content_filter") throw contentFiltered();
    const message = json.choices[0]?.message;
    const sawRefusal = finishReason === "refusal" || (typeof message?.refusal === "string" && message.refusal.length > 0);
    const stopReason = stopReasonOf(finishReason, sawRefusal);
    const usage = usageOf(json.usage);
    const citations = citationsOf(message?.annotations);
    const title = typeof message?.title === "string" && message.title.trim() ? message.title.trim() : undefined;
    return {
      ...(typeof message?.reasoning_content === "string" && message.reasoning_content ? { reasoning: message.reasoning_content } : {}),
      ...(title ? { title } : {}),
      stopReason,
      ...(sawRefusal ? { refusal: true } : {}),
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
    const response = await (request.fetchImpl ?? fetch)(url, {
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
    if (!response.body) throw new MangaError("PROVIDER_UNAVAILABLE", "empty stream body", { details: { errorCode: "server" satisfies AgentErrorCode } });
    const items = new Map<string, { callId: string; name: string; emittedArgs: boolean }>();
    try {
      for await (const line of readSseLines(response.body, request.signal)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") {
          yield { type: "completed", finishReason: "stop", stopReason: "end_turn" };
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
          throw new MangaError("PROVIDER_UNAVAILABLE", "the service stopped the answer with an error", {
            retryable: true,
            details: { kind: "stream_error", errorCode: "server" satisfies AgentErrorCode },
          });
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
          const finishReason = reason === "max_output_tokens" ? "length" : "incomplete";
          yield {
            type: "completed",
            finishReason,
            stopReason: stopReasonOf(finishReason),
            ...(usage ? { usage } : {}),
          };
          return;
        }
        if (json.type === "response.completed") {
          if (json.response?.incomplete_details?.reason === "content_filter") throw contentFiltered();
          const usage = responsesUsageOf(json.response?.usage);
          yield {
            type: "completed",
            finishReason: "stop",
            stopReason: "end_turn",
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
    const response = await (request.fetchImpl ?? fetch)(url, {
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
    const finishReason = json.incomplete_details?.reason === "max_output_tokens" ? "length" : toolCalls.length ? "tool_calls" : "stop";
    return { text, toolCalls, stopReason: stopReasonOf(finishReason), ...(usage ? { usage } : {}) };
  } finally {
    req.clear();
  }
}
