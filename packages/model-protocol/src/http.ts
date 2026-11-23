import { MangaError } from "@manga/contracts";

export function rejectCredentialUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MangaError("VALIDATION_ERROR", "base URI is not a valid URL");
  }
  if (parsed.username || parsed.password) {
    throw new MangaError("VALIDATION_ERROR", "credentials must not be embedded in the URL");
  }
}

export function normalizeBaseUrl(url: string): string {
  rejectCredentialUrl(url);
  const parsed = new URL(url);
  let pathname = parsed.pathname.replace(/\/+$/, "") || "";
  if (pathname === "/") pathname = "";
  parsed.pathname = pathname;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/+$/, "");
}

export function joinApiPath(baseUrl: string, suffix: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const path = suffix.startsWith("/") ? suffix : `/${suffix}`;
  if (base.endsWith(path)) return base;
  const version = /^(\/v\d+)\//.exec(path)?.[1];
  if (version && base.endsWith(version)) return `${base}${path.slice(version.length)}`;
  return `${base}${path}`;
}

export type RequestSignal = {
  signal: AbortSignal;
  clear: () => void;
  isTimedOut: () => boolean;
};

/** Combines a timeout with an optional caller AbortSignal and clears timer + listener cleanly in `clear()`. */
export function createRequestSignal(timeoutMs: number, external?: AbortSignal): RequestSignal {
  const controller = new AbortController();
  let timedOut = false;
  let cleared = false;
  if (external?.aborted) {
    controller.abort(external.reason);
    return { signal: controller.signal, clear: () => {}, isTimedOut: () => false };
  }
  const onAbort = () => {
    clearTimeout(timer);
    controller.abort(external?.reason);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("request timed out", "TimeoutError"));
  }, timeoutMs);
  external?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    clear: () => {
      if (cleared) return;
      cleared = true;
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
    isTimedOut: () => timedOut,
  };
}

/** Sleeps for `ms` milliseconds, waking immediately with `CANCELLED` if `signal` aborts. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new MangaError("CANCELLED", "request cancelled", { retryable: true }));
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MangaError("CANCELLED", "request cancelled", { retryable: true }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** What a service counted for one answer. DeepSeek also says how much of the input came from its cache and how many searches it ran (计划 4.4, 4.9). */
export type StreamUsage = { inputTokens?: number; outputTokens?: number; costUsd?: number; cachedInputTokens?: number; searches?: number };

/**
 * A step of a search the service runs itself (DeepSeek's `server_tool_event`, 计划 4.4): a search started with its queries, a page being opened, a step
 * finished with the sources it found. Only what the interface shows is kept.
 */
export type ServerToolEvent =
  | { kind: "search"; callId: string; queries: string[] }
  | { kind: "open"; callId: string; url: string }
  | { kind: "done"; callId: string; sources: WebSource[]; page?: WebSource };

/** A web page a search found or an answer cites. */
export type WebSource = { url: string; title: string; site?: string; publishedAt?: string; snippet?: string };

/** A citation in an answer: the source, and where in the answer's text it applies (character offsets). */
export type Citation = { url: string; title: string; start?: number; end?: number };

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | { type: "server-tool"; event: ServerToolEvent }
  | { type: "tool-call-delta"; callId: string; name: string; argumentsDelta: string }
  | { type: "completed"; finishReason: string; usage?: StreamUsage; serverToolCalls?: unknown[]; citations?: Citation[] }
  | { type: "error"; code: string; message: string; retryable: boolean };

/** A still the model may look at. Only images travel to a chat model: audio is transcribed first and never sent as sound. */
export type ImagePart = { mediaType: "image/jpeg" | "image/png" | "image/webp"; base64: string };

/** A whole file handed to the model as it is (a PDF, 计划 4.5). Only the native runtime sends it, and only to a model whose profile takes PDF. */
export type FilePart = { mediaType: "application/pdf"; filename: string; base64: string; /** For the budget only; not sent. */ pages: number };

/** A stretch of video handed to the model as a clip (计划 4.5). Only the native runtime sends it, and only over Chat Completions (`video_url`). */
export type VideoPart = { mediaType: "video/mp4"; base64: string; /** For the budget only; not sent. */ seconds: number };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Attached to user messages only. */
  images?: ImagePart[];
  /** Attached to user messages only. */
  files?: FilePart[];
  /** Attached to user messages only; the Responses protocol never carries them (the caller sends frames instead). */
  videos?: VideoPart[];
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  /**
   * What the model thought before this assistant message (`reasoning_content`). Sent back only within the turn it belongs to, the way DeepSeek asks for
   * it during a tool loop; earlier turns go without it (计划 4.3, the rule checked against the real service is in the stage report).
   */
  reasoning?: string;
  /** The searches the service ran itself for this assistant message, as it gave them; sent back unchanged (DeepSeek `server_tool_calls`). */
  serverToolCalls?: unknown[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type TextRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  stream?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The most tokens the model may answer with; left out, the service decides. */
  maxOutputTokens?: number;
  /** Chat Completions names the limit `max_tokens`, or `max_completion_tokens` for models that reason. */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** How hard a reasoning model thinks: `reasoning_effort` for Chat Completions, `reasoning.effort` for Responses. Left out when the model does not reason. */
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "max";
  /**
   * How the service differs from plain Chat Completions. `deepseek`: thinking is switched by `thinking: {type}` and always said (the service thinks by
   * default), `reasoning_effort` takes low, high or max, `reasoning_content` is read and sent back, and the built-in web search can be offered.
   */
  dialect?: "deepseek";
  /** Offer the service's own web search with the tools (only the deepseek dialect has one; it needs thinking on). */
  nativeWebSearch?: boolean;
  /** Sampling temperature when the model does not reason; omitted when `reasoningEffort` is set. */
  temperature?: number;
  /** The model's window, for runtimes that need to know it. */
  contextWindow?: number;
};

export type TranscriptionRequest = {
  model: string;
  fileName: string;
  bytes: Uint8Array;
  mimeType: string;
  /** Names and terms the speaker is likely to say; helps the recogniser spell them. */
  prompt?: string;
  /** ISO-639-1 hint, when the speaker's language is known. */
  language?: string;
  /** Ask for per-segment times (`verbose_json`). Providers that do not support it answer plain text. */
  timestamps?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type TranscriptionSegment = { start: number; end: number; text: string };
export type TranscriptionResult = { text: string; segments?: TranscriptionSegment[]; duration?: number; language?: string };

/**
 * Why an answer with an error status is an error, in one word: the request is longer than the model takes, the model is not there, the path is not there, or none is known. Only the word is kept, never the
 * body: a provider can reflect request text or authorization into its error body, and public command errors are persisted and displayed.
 */
const CONTEXT_TOO_LONG = /context[ _-]?(length|window)|maximum context|too many tokens|token limit|prompt is too long|input is too long|reduce the length|exceeds? the (model'?s )?(maximum|limit)|string too long/i;

function reasonOf(status: number, body: string): "model" | "path" | "context" | undefined {
  if ((status === 400 || status === 413 || status === 422) && CONTEXT_TOO_LONG.test(body)) return "context";
  const names = /model/i.test(body) && /(not[ _-]?found|does ?n[o']t exist|not exist|unknown|invalid|no such|unsupported|not available|not_found)/i.test(body);
  if (status === 404) return names ? "model" : "path";
  if ((status === 400 || status === 422) && names) return "model";
  return undefined;
}

export function mapHttpError(status: number, body: string): MangaError {
  // Out of credit and too busy are their own kinds: the person tops up the account, or waits (计划 4.3, 4.9).
  if (status === 402) return new MangaError("PROVIDER_UNAVAILABLE", "the account has no balance left", { details: { status, kind: "billing" } });
  if (status === 503) return new MangaError("PROVIDER_UNAVAILABLE", "the service is busy", { retryable: true, details: { status, kind: "busy" } });
  const kind = reasonOf(status, body);
  const details = { status, ...(kind ? { kind } : {}) };
  if (status === 401) return new MangaError("AUTHENTICATION_FAILED", "provider rejected the credentials", { details });
  if (status === 429) return new MangaError("RATE_LIMITED", "provider rate limited the request", { retryable: true, details });
  if (status === 404) return new MangaError("MODEL_CAPABILITY_MISSING", "provider reported a missing capability", { details });
  const reason = status >= 400 && status < 500 ? providerReason(body) : null;
  return new MangaError("PROVIDER_UNAVAILABLE", reason ? `provider HTTP ${status}: ${reason}` : `provider HTTP ${status}`, { retryable: status >= 500, details: reason ? { ...details, reason } : details });
}

/**
 * `message` without a trailing `(request_id: …)` and the whitespace around it. Found with string searches: a regex
 * anchored at the end is quadratic on a message that repeats the opening many times.
 */
function withoutRequestId(message: string): string {
  const at = message.toLowerCase().lastIndexOf("(request_id:");
  if (at < 0) return message;
  const close = message.indexOf(")", at);
  if (close < 0 || message.slice(close + 1).trim() !== "") return message;
  return message.slice(0, at).trimEnd();
}

/**
 * What a service said about a request it refused (`{"error":{"message":…}}`), so the person and the call record see why instead of a bare status. Only
 * that one field is read, without the request id the service adds, cut to 240 characters; a body that is not that JSON gives nothing.
 */
export function providerReason(body: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  const error = (parsed as { error?: unknown } | null)?.error;
  const message = typeof error === "string" ? error : typeof (error as { message?: unknown } | null)?.message === "string" ? (error as { message: string }).message : null;
  if (!message) return null;
  // Nothing key- or token-shaped goes on (an error is shown and logged); the service's own words about the request do.
  const text = withoutRequestId(message)
    .replace(/\bBearer\s+\S+/gi, "Bearer <key>")
    .replace(/\b(?:sk|pk|rk|key)-[A-Za-z0-9_-]{8,}/gi, "<key>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<token>")
    .replace(/\s+/g, " ").trim();
  return text ? (text.length > 240 ? `${text.slice(0, 239)}…` : text) : null;
}

/**
 * A request that never got an answer: cancelled by the caller, out of time, an address that is not there or refuses, or a connection that broke. The kind goes in
 * the details so a test of a connection can tell the person which; the text stays the system's own.
 */
export function networkError(error: unknown, signal?: AbortSignal): MangaError {
  if (signal?.aborted) return new MangaError("CANCELLED", "request cancelled", { retryable: true });
  const failure = error as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } } | undefined;
  const code = failure?.cause?.code ?? failure?.code;
  let kind = "network";
  if (failure?.name === "AbortError" || failure?.name === "TimeoutError") kind = "timeout";
  else if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED" || code === "ERR_INVALID_URL" || code === "EHOSTUNREACH" || code === "ENETUNREACH") kind = "address";
  else if (typeof code === "string" && /CERT|SSL|TLS/i.test(code)) kind = "tls";
  return new MangaError("PROVIDER_UNAVAILABLE", failure?.message ?? "network failure", { retryable: true, details: { kind, ...(typeof code === "string" ? { code } : {}) } });
}

/** An answer that is not what the protocol says it should be: a page of HTML where JSON should be, a body that does not parse, a shape nobody speaks. */
export function protocolError(what: string): MangaError {
  return new MangaError("PROVIDER_UNAVAILABLE", `provider answered in an unexpected form: ${what}`, { retryable: false, details: { kind: "protocol" } });
}

/** A successful answer must look like what was asked for; a web page at the address (a login page, a proxy's notice) never does. */
export function requireMachineAnswer(response: Response): void {
  const type = response.headers.get("content-type") ?? "";
  if (/text\/html/i.test(type)) throw protocolError("a web page");
}

/** Parse the JSON of an answer, or say the answer is not in the protocol. */
export function parseJsonAnswer<T>(text: string, what = "JSON"): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw protocolError(`not ${what}`);
  }
}

export async function* readSseLines(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  try {
    while (true) {
      if (signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) yield line;
    }
    buffer += decoder.decode();
    if (buffer) yield buffer;
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
