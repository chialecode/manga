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
  return `${base}${path}`;
}

export type StreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call-delta"; callId: string; name: string; argumentsDelta: string }
  | { type: "completed"; finishReason: string; usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number } }
  | { type: "error"; code: string; message: string; retryable: boolean };

/** A still the model may look at. Only images travel to a chat model: audio is transcribed first and never sent as sound. */
export type ImagePart = { mediaType: "image/jpeg" | "image/png" | "image/webp"; base64: string };

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Attached to user messages only. */
  images?: ImagePart[];
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
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
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
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
  const kind = reasonOf(status, body);
  const details = { status, ...(kind ? { kind } : {}) };
  if (status === 401) return new MangaError("AUTHENTICATION_FAILED", "provider rejected the credentials", { details });
  if (status === 429) return new MangaError("RATE_LIMITED", "provider rate limited the request", { retryable: true, details });
  if (status === 404) return new MangaError("MODEL_CAPABILITY_MISSING", "provider reported a missing capability", { details });
  return new MangaError("PROVIDER_UNAVAILABLE", `provider HTTP ${status}`, { retryable: status >= 500, details });
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
  try {
    while (true) {
      if (signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) yield line;
    }
    buffer += decoder.decode();
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}
