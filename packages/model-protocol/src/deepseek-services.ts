import { MangaError } from "@manga/contracts";
import { abortableSleep, createRequestSignal, joinApiPath, mapHttpError, networkError, parseJsonAnswer, protocolError, requireMachineAnswer, type WebSource } from "./http.ts";

/**
 * DeepSeek's application APIs (计划 4.5—4.7): recognition (`deepseek-asr@1`), speech (`deepseek-tts@1`) and web search (`deepseek-search@1`). Each is one
 * request to the provider's own address; the caller has checked that the provider is enabled and the address is one it declares. Redirects are not
 * followed (`redirect: "error"`): an API answer never moves, and a request with a key must not be sent anywhere else.
 */

type Common = { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch };

async function failure(response: Response): Promise<MangaError> {
  const body = await response.text().catch(() => "");
  const error = mapHttpError(response.status, body);
  const rawWait = response.headers.get("retry-after");
  const wait = rawWait !== null && rawWait.trim() !== "" ? Number(rawWait) : Number.NaN;
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return new MangaError(error.code, error.message, { retryable, details: { ...(error.details as object), ...(Number.isFinite(wait) && wait >= 0 ? { retryAfterMs: Math.min(wait, 60) * 1000 } : {}) } });
}

/** Whether a failure is one to try again: too many requests, busy, or (for search) a timeout and a server error (计划 4.5, 4.6). */
export function retryableStatus(error: unknown, statuses: readonly number[]): boolean {
  const status = (error as MangaError | undefined)?.details && Number(((error as MangaError).details as { status?: unknown }).status);
  return typeof status === "number" && statuses.includes(status);
}

/** Tries `work` again up to `times` times when the failure has one of the given statuses, waiting a little longer each time (or what the service asked). */
export async function withRetries<T>(work: () => Promise<T>, statuses: readonly number[], options: { times?: number; signal?: AbortSignal; baseMs?: number } = {}): Promise<T> {
  const times = options.times ?? 2;
  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
    try {
      return await work();
    } catch (error) {
      if (attempt >= times || options.signal?.aborted || !retryableStatus(error, statuses)) throw error;
      const asked = Number(((error as MangaError).details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs);
      const wait = Number.isFinite(asked) && asked > 0 ? Math.min(asked, 10_000) : (options.baseMs ?? 500) * 2 ** attempt;
      await abortableSleep(wait, options.signal);
    }
  }
}

// ------------------------------------------------------------------------------------------------------------ recognition

/**
 * Recognises one WAV: a multipart form with the file and nothing else (the service takes no language, no hot words and no prompt). Returns the text and the
 * seconds the service counted.
 */
export async function transcribeDeepSeek(baseUrl: string, apiKey: string, request: Common & { bytes: Uint8Array; fileName?: string; mimeType?: string }): Promise<{ text: string; durationMs?: number }> {
  if (request.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
  const form = new FormData();
  form.set("file", new Blob([request.bytes as Uint8Array<ArrayBuffer>], { type: request.mimeType ?? "audio/wav" }), request.fileName ?? "audio.wav");
  const req = createRequestSignal(request.timeoutMs ?? 120_000, request.signal);
  try {
    const response = await (request.fetchImpl ?? fetch)(joinApiPath(baseUrl, "/v1/tools/asr"), {
      method: "POST", headers: { authorization: `Bearer ${apiKey}` }, body: form, redirect: "error", signal: req.signal,
    }).catch((error) => { throw networkError(error, request.signal); });
    if (!response.ok) throw await failure(response);
    try {
      requireMachineAnswer(response);
    } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    const text = await response.text().catch((error) => {
      if (req.isTimedOut()) throw networkError(new DOMException("request timed out", "TimeoutError"), request.signal);
      throw networkError(error, request.signal);
    });
    const json = parseJsonAnswer<{ text?: unknown; duration_ms?: unknown }>(text, "JSON");
    if (typeof json.text !== "string") throw protocolError("no text");
    return { text: json.text, ...(typeof json.duration_ms === "number" ? { durationMs: json.duration_ms } : {}) };
  } finally {
    req.clear();
  }
}

// ------------------------------------------------------------------------------------------------------------ speech

/** DeepSeek's speech: at most 10,000 billed characters (a Han character counts two) and a 64 KiB body per request; PCM is 24 kHz, 16-bit, mono. */
export const DEEPSEEK_TTS_LIMITS = { billedChars: 10_000, requestBytes: 64 * 1024, sampleRate: 24_000 } as const;

/** Billed characters: a Han character counts two (计划 4.7). */
export function speechBilledChars(text: string): number {
  let n = 0;
  for (const char of text) n += /\p{Script=Han}/u.test(char) ? 2 : 1;
  return n;
}

/**
 * Speaks a text as 24 kHz 16-bit mono PCM, handing each piece to `onChunk` as it arrives (the service sends while it speaks). An answer that ends early
 * (the connection breaks, or the stream errors) is a failure, and what was already handed on stays with the caller (计划 4.7).
 */
export async function synthesizeDeepSeek(baseUrl: string, apiKey: string, request: Common & { text: string; voice?: string; onChunk: (pcm: Uint8Array) => void }): Promise<{ bytes: number; billedChars: number; firstChunkMs: number | null }> {
  if (request.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
  if (!request.text.trim()) throw new MangaError("VALIDATION_ERROR", "there is nothing to read aloud");
  const billed = speechBilledChars(request.text);
  if (billed > DEEPSEEK_TTS_LIMITS.billedChars) throw new MangaError("VALIDATION_ERROR", "the text is longer than one speech request takes", { details: { billedChars: billed } });
  const started = Date.now();
  const req = createRequestSignal(request.timeoutMs ?? 120_000, request.signal);
  try {
    const response = await (request.fetchImpl ?? fetch)(joinApiPath(baseUrl, "/v1/tools/tts"), {
      method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ text: request.text, voice_id: request.voice ?? "stella", format: "pcm", filter_markdown: true }), redirect: "error", signal: req.signal,
    }).catch((error) => { throw networkError(error, request.signal); });
    if (!response.ok) throw await failure(response);
    try {
      requireMachineAnswer(response);
      if (/json/i.test(response.headers.get("content-type") ?? "")) throw protocolError("JSON where audio was expected");
    } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (!response.body) throw protocolError("no audio");
    const reader = response.body.getReader();
    let bytes = 0;
    let firstChunkMs: number | null = null;
    let carry: Uint8Array | null = null;
    let finished = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          finished = true;
          break;
        }
        if (!value?.length) continue;
        firstChunkMs ??= Date.now() - started;
        // Samples are two bytes: an odd byte waits for the next piece so no sample is split.
        let piece: Uint8Array = carry ? concat(carry, value) : value;
        carry = null;
        if (piece.length % 2) { carry = piece.subarray(piece.length - 1); piece = piece.subarray(0, piece.length - 1); }
        if (piece.length) { bytes += piece.length; request.onChunk(piece); }
      }
    } catch (error) {
      if (request.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
      if (req.isTimedOut()) throw networkError(new DOMException("request timed out", "TimeoutError"), request.signal);
      throw new MangaError("PROVIDER_UNAVAILABLE", "the speech broke off before it was finished", { retryable: true, details: { kind: "truncated", bytes } });
    } finally {
      if (!finished) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (!bytes) throw new MangaError("PROVIDER_UNAVAILABLE", "the service sent no audio", { retryable: true, details: { kind: "truncated", bytes: 0 } });
    return { bytes, billedChars: billed, firstChunkMs };
  } finally {
    req.clear();
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ------------------------------------------------------------------------------------------------------------ search

export type WebSearchResult = WebSource & { summary?: string };

/** One query (trimmed, at most 128 characters; a longer one is cut and the result says so) for at most 10 results (计划 4.5). */
export async function searchDeepSeek(baseUrl: string, apiKey: string, request: Common & { query: string; count?: number }): Promise<{ results: WebSearchResult[]; query: string; truncated: boolean }> {
  if (request.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
  const trimmed = request.query.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new MangaError("VALIDATION_ERROR", "the search has no words");
  const chars = [...trimmed];
  const query = chars.slice(0, 128).join("");
  const count = Math.min(10, Math.max(1, request.count ?? 8));
  const req = createRequestSignal(request.timeoutMs ?? 30_000, request.signal);
  try {
    const response = await (request.fetchImpl ?? fetch)(joinApiPath(baseUrl, "/v1/tools/search"), {
      method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ query, count, need_content: false }), redirect: "error", signal: req.signal,
    }).catch((error) => { throw networkError(error, request.signal); });
    if (!response.ok) throw await failure(response);
    try {
      requireMachineAnswer(response);
    } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    const rawText = await response.text().catch((error) => {
      if (req.isTimedOut()) throw networkError(new DOMException("request timed out", "TimeoutError"), request.signal);
      throw networkError(error, request.signal);
    });
    const json = parseJsonAnswer<{ results?: unknown; data?: unknown }>(rawText, "JSON");
    const list = Array.isArray(json.results) ? json.results : Array.isArray(json.data) ? json.data : null;
    if (!list) throw protocolError("no results");
    const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? [...value.trim()].slice(0, max).join("") : undefined);
    const results: WebSearchResult[] = [];
    for (const item of list as Array<Record<string, unknown>>) {
      const url = text(item?.url, 2048);
      if (!url || !/^https?:\/\//i.test(url)) continue;
      const site = text(item.site_name, 80);
      const publishedAt = text(item.published_at ?? item.date, 40);
      const snippet = text(item.snippet, 400);
      const summary = text(item.summary, 1200);
      results.push({ url, title: text(item.title, 200) ?? url, ...(site ? { site } : {}), ...(publishedAt ? { publishedAt } : {}), ...(snippet ? { snippet } : {}), ...(summary ? { summary } : {}) });
      if (results.length >= count) break;
    }
    return { results, query, truncated: chars.length > 128 };
  } finally {
    req.clear();
  }
}
