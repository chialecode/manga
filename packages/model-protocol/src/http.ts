import { MangaError, type AgentErrorCode } from "@manga/contracts";
import type { RequestSignal } from "./types.ts";

export type {
  AgentCitation,
  AgentErrorCode,
  AgentSearchStep,
  AgentServerToolStep,
  AgentStopReason,
  ChatMessage,
  Citation,
  CompletedText,
  DeepSeekBalanceOptions,
  DeepSeekBalanceResult,
  DeepSeekCommonOptions,
  DeepSeekFetchOptions,
  DeepSeekFileDeleteOptions,
  DeepSeekFileUploadOptions,
  DeepSeekOcrOptions,
  DeepSeekSearchOptions,
  DeepSeekTtsWsOptions,
  DeepSeekTtsWsResult,
  DeepSeekTtsWsSession,
  FilePart,
  FileUploadPurpose,
  ImagePart,
  MessageFileRef,
  OcrPurpose,
  OcrResult,
  ProviderBalanceInfo,
  ProviderFileRef,
  RequestSignal,
  ServerToolEvent,
  SpeechVoice,
  StreamEvent,
  StreamUsage,
  TextRequest,
  ToolDefinition,
  TranscriptionRequest,
  TranscriptionResult,
  TranscriptionSegment,
  VideoPart,
  WebFetchResult,
  WebSearchItem,
  WebSource,
} from "./types.ts";

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
  if (signal?.aborted) return Promise.reject(new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" } }));
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" } }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Extracts expired/missing DeepSeek Files API identifiers (`file-api-...`) from an error message or error object so
 * callers can invalidate cached remote file references and re-upload from local storage.
 */
const FILE_API_ID = /\bfile-api-[A-Za-z0-9_-]+\b/g;
const FILE_EXPIRED_HINT = /(file[_ -]?id|file[_ -]?data|file\b).*(not[ _-]?found|missing|expired|invalid|deleted|does ?n[o']t exist|not exist)|(not[ _-]?found|missing|expired|invalid|deleted).*(file[_ -]?id|file-api-)/i;
const FILE_INVALID_HINT = /(file[_ -]?(count|size|type|format|parse)|storage[ _-]?limit|password[ _-]?protected|unsupported file|failed to parse|file_data only accepts)/i;

export function extractExpiredFileIds(errorOrMessage: unknown): string[] {
  if (errorOrMessage instanceof MangaError) {
    const details = errorOrMessage.details as { expiredFileIds?: unknown; reason?: unknown } | undefined;
    if (Array.isArray(details?.expiredFileIds)) {
      const fromDetails = details.expiredFileIds.filter((item): item is string => typeof item === "string" && item.length > 0);
      if (fromDetails.length) return [...new Set(fromDetails)];
    }
    const text = `${errorOrMessage.message} ${typeof details?.reason === "string" ? details.reason : ""}`;
    return extractExpiredFileIds(text);
  }
  const text = typeof errorOrMessage === "string"
    ? errorOrMessage
    : errorOrMessage instanceof Error
      ? errorOrMessage.message
      : "";
  if (!text) return [];
  const matches = text.match(FILE_API_ID);
  if (!matches?.length) return [];
  return [...new Set(matches)];
}

/**
 * Why an answer with an error status is an error, in one word: the request is longer than the model takes, the model is not there, the path is not there,
 * an uploaded file expired or is invalid, or none is known.
 */
const CONTEXT_TOO_LONG = /context[ _-]?(length|window)|maximum context|too many tokens|token limit|prompt is too long|input is too long|reduce the length|exceeds? the (model'?s )?(maximum|limit)|string too long/i;

function reasonOf(status: number, body: string): "model" | "path" | "context" | "file_expired" | "file_invalid" | undefined {
  if ((status === 400 || status === 413 || status === 422) && CONTEXT_TOO_LONG.test(body)) return "context";
  const expiredIds = extractExpiredFileIds(body);
  if ((status === 400 || status === 404 || status === 422) && expiredIds.length && FILE_EXPIRED_HINT.test(body)) return "file_expired";
  if ((status === 400 || status === 413 || status === 415 || status === 422) && FILE_INVALID_HINT.test(body)) return "file_invalid";
  const names = /model/i.test(body) && /(not[ _-]?found|does ?n[o']t exist|not exist|unknown|invalid|no such|unsupported|not available|not_found)/i.test(body);
  if (status === 404) return names ? "model" : "path";
  if ((status === 400 || status === 422) && names) return "model";
  return undefined;
}

function errorCodeOfHttp(status: number, kind: string | undefined, body: string): AgentErrorCode {
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "balance";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (kind === "context") return "context_overflow";
  if (kind === "file_expired" || kind === "file_invalid") return "file_invalid";
  if (kind === "model" || kind === "path" || status === 404) return "capability_missing";
  if (/content[_ ]?filter|safety[_ ]?check|refusal/i.test(body)) return "refusal";
  return "unknown";
}

export function mapHttpError(status: number, body: string): MangaError {
  // Out of credit and too busy are their own kinds: the person tops up the account, or waits.
  if (status === 402) return new MangaError("PROVIDER_UNAVAILABLE", "the account has no balance left", { details: { status, kind: "billing", errorCode: "balance" satisfies AgentErrorCode } });
  if (status === 503) return new MangaError("PROVIDER_UNAVAILABLE", "the service is busy", { retryable: true, details: { status, kind: "busy", errorCode: "server" satisfies AgentErrorCode } });
  const kind = reasonOf(status, body);
  const errorCode = errorCodeOfHttp(status, kind, body);
  const expiredFileIds = kind === "file_expired" ? extractExpiredFileIds(body) : [];
  const details: Record<string, unknown> = {
    status,
    errorCode,
    ...(kind ? { kind } : {}),
    ...(expiredFileIds.length ? { expiredFileIds } : {}),
  };
  if (status === 401) return new MangaError("AUTHENTICATION_FAILED", "provider rejected the credentials", { details });
  if (status === 429) return new MangaError("RATE_LIMITED", "provider rate limited the request", { retryable: true, details });
  if (status === 404) return new MangaError("MODEL_CAPABILITY_MISSING", "provider reported a missing capability", { details });
  const reason = status >= 400 && status < 500 ? providerReason(body) : null;
  return new MangaError("PROVIDER_UNAVAILABLE", reason ? `provider HTTP ${status}: ${reason}` : `provider HTTP ${status}`, {
    retryable: status >= 500,
    details: reason ? { ...details, reason } : details,
  });
}

/** Classifies any thrown error into a structured `AgentErrorCode` (and expired `file_id`s when self-healing applies). */
export function classifyAgentError(error: unknown): { errorCode: AgentErrorCode; expiredFileIds?: string[]; fileExpired?: boolean } {
  if (error instanceof MangaError) {
    const details = (error.details ?? {}) as { errorCode?: unknown; kind?: unknown; reason?: unknown; status?: unknown; expiredFileIds?: unknown };
    const expiredFileIds = extractExpiredFileIds(error);
    const fileExpired = details.kind === "file_expired" || (expiredFileIds.length > 0 && FILE_EXPIRED_HINT.test(error.message));
    if (fileExpired) return { errorCode: "file_invalid", expiredFileIds, fileExpired: true };
    if (typeof details.errorCode === "string") {
      return { errorCode: details.errorCode as AgentErrorCode, ...(expiredFileIds.length ? { expiredFileIds } : {}) };
    }
    if (error.code === "CANCELLED") return { errorCode: "cancelled" };
    if (error.code === "AUTHENTICATION_FAILED" || error.code === "CREDENTIAL_UNAVAILABLE") return { errorCode: "auth" };
    if (error.code === "RATE_LIMITED") return { errorCode: "rate_limit" };
    if (error.code === "MODEL_CAPABILITY_MISSING") return { errorCode: "capability_missing" };
    if (error.code === "BUDGET_EXCEEDED") return { errorCode: "budget_exceeded" };
    if (details.reason === "plugin_disabled") return { errorCode: "plugin_disabled" };
    if (details.kind === "billing" || details.status === 402) return { errorCode: "balance" };
    if (details.kind === "content_filter") return { errorCode: "refusal" };
    if (details.kind === "context") return { errorCode: "context_overflow" };
    if (details.kind === "file_invalid") return { errorCode: "file_invalid" };
    if (details.kind === "busy" || (typeof details.status === "number" && details.status >= 500)) return { errorCode: "server" };
    if (details.kind === "timeout" || details.kind === "address" || details.kind === "network" || details.kind === "tls") return { errorCode: "network" };
  }
  const expiredFileIds = extractExpiredFileIds(error);
  if (expiredFileIds.length) return { errorCode: "file_invalid", expiredFileIds, fileExpired: true };
  return { errorCode: "unknown" };
}

/**
 * `message` without a trailing `(request_id: …)` and the whitespace around it. Found with string searches: a regex
 * anchored at the end is quadratic on a message that repeats the opening many times.
 */
function withoutRequestId(message: string): string {
  const trimmed = message.trimEnd();
  if (!trimmed.endsWith(")")) return message;
  const close = trimmed.length - 1;
  // The id runs to the final ")" without another ")" inside, so it starts after the previous ")".
  const from = trimmed.lastIndexOf(")", close - 1) + 1;
  const at = trimmed.slice(from, close).search(/\(request_id:/i);
  if (at < 0) return message;
  return trimmed.slice(0, from + at).trimEnd();
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
  // Preserve DeepSeek `file-api-...` ids (needed for self-healing) while scrubbing API keys and bearer tokens.
  const preserved: string[] = [];
  const shielded = withoutRequestId(message).replace(FILE_API_ID, (match) => {
    const slot = preserved.push(match) - 1;
    return `__FILE_REF_${slot}__`;
  });
  const redacted = shielded
    .replace(/\bBearer\s+\S+/gi, "Bearer <key>")
    .replace(/\b(?:sk|pk|rk|key)-[A-Za-z0-9_-]{8,}/gi, "<key>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<token>")
    .replace(/__FILE_REF_(\d+)__/g, (_, index) => preserved[Number(index)] ?? "<file>")
    .replace(/\s+/g, " ").trim();
  return redacted ? (redacted.length > 240 ? `${redacted.slice(0, 239)}…` : redacted) : null;
}

/**
 * A request that never got an answer: cancelled by the caller, out of time, an address that is not there or refuses, or a connection that broke. The kind goes in
 * the details so a test of a connection can tell the person which; the text stays the system's own.
 */
export function networkError(error: unknown, signal?: AbortSignal): MangaError {
  if (signal?.aborted) return new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" satisfies AgentErrorCode } });
  const failure = error as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } } | undefined;
  const code = failure?.cause?.code ?? failure?.code;
  let kind = "network";
  if (failure?.name === "AbortError" || failure?.name === "TimeoutError") kind = "timeout";
  else if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED" || code === "ERR_INVALID_URL" || code === "EHOSTUNREACH" || code === "ENETUNREACH") kind = "address";
  else if (typeof code === "string" && /CERT|SSL|TLS/i.test(code)) kind = "tls";
  return new MangaError("PROVIDER_UNAVAILABLE", failure?.message ?? "network failure", {
    retryable: true,
    details: { kind, errorCode: "network" satisfies AgentErrorCode, ...(typeof code === "string" ? { code } : {}) },
  });
}

/** An answer that is not what the protocol says it should be: a page of HTML where JSON should be, a body that does not parse, a shape nobody speaks. */
export function protocolError(what: string): MangaError {
  return new MangaError("PROVIDER_UNAVAILABLE", `provider answered in an unexpected form: ${what}`, {
    retryable: false,
    details: { kind: "protocol", errorCode: "server" satisfies AgentErrorCode },
  });
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
      if (signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" satisfies AgentErrorCode } });
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
