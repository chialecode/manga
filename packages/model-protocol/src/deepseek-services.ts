import { MangaError, type OcrPage, type OcrResult, type ProviderBalanceInfo, type WebFetchResult } from "@manga/contracts";
import {
  abortableSleep,
  createRequestSignal,
  joinApiPath,
  mapHttpError,
  networkError,
  parseJsonAnswer,
  protocolError,
  requireMachineAnswer,
  type DeepSeekBalanceOptions,
  type DeepSeekBalanceResult,
  type DeepSeekFetchOptions,
  type DeepSeekOcrOptions,
  type DeepSeekSearchOptions,
  type WebSource,
} from "./http.ts";

/**
 * DeepSeek application & tool APIs: recognition (`deepseek-asr@1`), speech (`deepseek-tts@1`),
 * web search (`deepseek-search@1`), web fetch (`deepseek-fetch@1`), document OCR (`deepseek-ocr@1`),
 * and account balance (`GET /user/balance`). Redirects are refused (`redirect: "error"`) so keys never leave declared hosts.
 */

type Common = { signal?: AbortSignal; timeoutMs?: number; fetchImpl?: typeof fetch };

const WEB = /^https?:\/\//i;

async function failure(response: Response): Promise<MangaError> {
  const body = await response.text().catch(() => "");
  const error = mapHttpError(response.status, body);
  const rawWait = response.headers.get("retry-after");
  const wait = rawWait !== null && rawWait.trim() !== "" ? Number(rawWait) : Number.NaN;
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return new MangaError(error.code, error.message, {
    retryable,
    details: { ...(error.details as object), ...(Number.isFinite(wait) && wait >= 0 ? { retryAfterMs: Math.min(wait, 60) * 1000 } : {}) },
  });
}

/** Whether a failure has one of the retryable HTTP statuses. */
export function retryableStatus(error: unknown, statuses: readonly number[]): boolean {
  const status = (error as MangaError | undefined)?.details && Number(((error as MangaError).details as { status?: unknown }).status);
  return typeof status === "number" && statuses.includes(status);
}

/** Tries `work` again up to `times` times when the failure has one of the given statuses, honoring `Retry-After` when present. */
export async function withRetries<T>(work: () => Promise<T>, statuses: readonly number[], options: { times?: number; signal?: AbortSignal; baseMs?: number } = {}): Promise<T> {
  const times = options.times ?? 2;
  for (let attempt = 0; ; attempt += 1) {
    if (options.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" } });
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
 * Recognises one WAV or Ogg Opus upload (`POST /v1/tools/asr`): multipart form with `file` only.
 * Returns the recognized text and billed duration in milliseconds when reported.
 */
export async function transcribeDeepSeek(baseUrl: string, apiKey: string, request: Common & { bytes: Uint8Array; fileName?: string; mimeType?: string }): Promise<{ text: string; durationMs?: number }> {
  if (request.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" } });
  const form = new FormData();
  form.set("file", new Blob([request.bytes as Uint8Array<ArrayBuffer>], { type: request.mimeType ?? "audio/wav" }), request.fileName ?? "audio.wav");
  const req = createRequestSignal(request.timeoutMs ?? 120_000, request.signal);
  try {
    const response = await (request.fetchImpl ?? fetch)(joinApiPath(baseUrl, "/v1/tools/asr"), {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      redirect: "error",
      signal: req.signal,
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

/** DeepSeek's speech limits: at most 10,000 billed characters (a Han character counts two) and 64 KiB body per request; PCM is 24 kHz, 16-bit, mono. */
export const DEEPSEEK_TTS_LIMITS = { billedChars: 10_000, requestBytes: 64 * 1024, sampleRate: 24_000 } as const;

/** Billed characters: a Han character counts two. */
export function speechBilledChars(text: string): number {
  let n = 0;
  for (const char of text) n += /\p{Script=Han}/u.test(char) ? 2 : 1;
  return n;
}

/**
 * Strips non-spoken Markdown artifacts before TTS splitting and billing:
 * fenced code blocks, markdown tables, display math blocks, inline `[citation:N]` tags, raw URLs,
 * images, link targets (preserving visible label text), HTML tags, and formatting punctuation.
 */
export function stripMarkdownForSpeech(text: string): string {
  if (!text) return "";
  let out = text.replace(/\r\n?/g, "\n");
  // Remove fenced code blocks (```...``` and ~~~...~~~), including unclosed trailing fences during live streaming.
  out = out.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, "\n");
  // Remove display math blocks ($$...$$ and \[...\]).
  out = out.replace(/\$\$[\s\S]*?\$\$/g, " ");
  out = out.replace(/\\\[[\s\S]*?\\\]/g, " ");
  // Remove Markdown tables (header + alignment separator + body rows).
  out = out.replace(/(^|\n)[ \t]*\|[^\n]+\|\n[ \t]*\|[ \t:|-]+\|(?:\n[ \t]*\|[^\n]+\|)*/g, "\n");
  // Remove inline citation markers such as [citation:1] or [citation:1, 2].
  out = out.replace(/\[citation:\s*\d+(?:\s*,\s*\d+)*\s*\]/gi, "");
  // Replace Markdown images ![alt](url) with alt text when present.
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => alt.trim());
  // Replace Markdown links [label](url) with label text only.
  out = out.replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:|#)[^)]*\)/gi, "$1");
  // Strip raw URLs and bare www links.
  out = out.replace(/\bhttps?:\/\/[^\s<>()[\]"'。，、；：！？]+/gi, "");
  out = out.replace(/\bwww\.[^\s<>()[\]"'。，、；：！？]+/gi, "");
  // Strip inline HTML tags.
  out = out.replace(/<\/?[a-z][a-z0-9-]*(?:\s+[^>]*)?>/gi, "");
  // Strip horizontal rules.
  out = out.replace(/(^|\n)[ \t]*(?:[-*_][ \t]*){3,}(?=\n|$)/g, "\n");
  // Strip heading markers, blockquote prefixes, and list bullets/checkboxes.
  out = out.replace(/(^|\n)[ \t]*#{1,6}[ \t]+/g, "$1");
  out = out.replace(/(^|\n)(?:[ \t]*>[ \t]?)+/g, "$1");
  out = out.replace(/(^|\n)[ \t]*(?:[-*+][ \t]+(?:\[[ xX]\][ \t]+)?)/g, "$1");
  // Unwrap inline code, bold, italic, and strikethrough delimiters.
  out = out.replace(/`([^`]+)`/g, "$1");
  out = out.replace(/\*\*([^*]+)\*\*/g, "$1");
  out = out.replace(/__([^_]+)__/g, "$1");
  out = out.replace(/~~([^~]+)~~/g, "$1");
  out = out.replace(/(^|[\s\p{P}])\*([^*\n]+)\*(?=$|[\s\p{P}])/gu, "$1$2");
  out = out.replace(/(^|[\s\p{P}])_([^_\n]+)_(?=$|[\s\p{P}])/gu, "$1$2");
  // Clean empty parentheses left behind after removing URLs/citations.
  out = out.replace(/\(\s*\)|（\s*）/g, "");
  // Collapse excess horizontal spaces and blank lines.
  out = out
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1] !== ""))
    .join("\n")
    .trim();
  return out;
}

/**
 * Speaks a text as 24 kHz 16-bit mono PCM via HTTP streaming (`POST /v1/tools/tts`), handing each piece to `onChunk` as it arrives.
 */
export async function synthesizeDeepSeek(baseUrl: string, apiKey: string, request: Common & { text: string; voice?: string; onChunk: (pcm: Uint8Array) => void }): Promise<{ bytes: number; billedChars: number; firstChunkMs: number | null }> {
  if (request.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" } });
  if (!request.text.trim()) throw new MangaError("VALIDATION_ERROR", "there is nothing to read aloud");
  const billed = speechBilledChars(request.text);
  if (billed > DEEPSEEK_TTS_LIMITS.billedChars) throw new MangaError("VALIDATION_ERROR", "the text is longer than one speech request takes", { details: { billedChars: billed } });
  const started = Date.now();
  const req = createRequestSignal(request.timeoutMs ?? 120_000, request.signal);
  try {
    const response = await (request.fetchImpl ?? fetch)(joinApiPath(baseUrl, "/v1/tools/tts"), {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ text: request.text, voice_id: request.voice ?? "stella", format: "pcm", filter_markdown: true }),
      redirect: "error",
      signal: req.signal,
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
        let piece: Uint8Array = carry ? concat(carry, value) : value;
        carry = null;
        if (piece.length % 2) { carry = piece.subarray(piece.length - 1); piece = piece.subarray(0, piece.length - 1); }
        if (piece.length) { bytes += piece.length; request.onChunk(piece); }
      }
    } catch (error) {
      if (request.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" } });
      if (req.isTimedOut()) throw networkError(new DOMException("request timed out", "TimeoutError"), request.signal);
      throw new MangaError("PROVIDER_UNAVAILABLE", "the speech broke off before it was finished", { retryable: true, details: { kind: "truncated", bytes, errorCode: "network" } });
    } finally {
      if (!finished) void reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (!bytes) throw new MangaError("PROVIDER_UNAVAILABLE", "the service sent no audio", { retryable: true, details: { kind: "truncated", bytes: 0, errorCode: "server" } });
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

/**
 * Standalone DeepSeek web search (`POST /v1/tools/search`): trimmed query up to 128 characters,
 * `count` up to 50 results, optional `needContent`, and preserved `siteIcon` / `content`.
 */
export async function searchDeepSeek(
  baseUrl: string,
  apiKey: string,
  request: Common & { query: string; count?: number; needContent?: boolean; oriQuestion?: string; localization?: string },
): Promise<{ results: WebSearchResult[]; query: string; truncated: boolean }> {
  if (request.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" } });
  const trimmed = request.query.trim().replace(/\s+/g, " ");
  if (!trimmed) throw new MangaError("VALIDATION_ERROR", "the search has no words");
  const chars = [...trimmed];
  const query = chars.slice(0, 128).join("");
  const count = Math.min(50, Math.max(1, Math.floor(request.count ?? 8)));
  const needContent = Boolean(request.needContent);
  const req = createRequestSignal(request.timeoutMs ?? 30_000, request.signal);
  try {
    const response = await (request.fetchImpl ?? fetch)(joinApiPath(baseUrl, "/v1/tools/search"), {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        query,
        count,
        need_content: needContent,
        ...(request.oriQuestion?.trim() ? { ori_question: request.oriQuestion.trim() } : {}),
        ...(request.localization?.trim() ? { localization: request.localization.trim() } : {}),
      }),
      redirect: "error",
      signal: req.signal,
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
      if (!url || !WEB.test(url)) continue;
      const site = text(item.site_name, 80);
      const siteIconRaw = text(item.site_icon, 2048);
      const siteIcon = siteIconRaw && WEB.test(siteIconRaw) ? siteIconRaw : undefined;
      const publishedAt = text(item.published_at ?? item.date, 40);
      const snippet = text(item.snippet, 400);
      const summary = text(item.summary, 1200);
      const content = text(item.content, 60_000);
      results.push({
        url,
        title: text(item.title, 200) ?? url,
        ...(site ? { site } : {}),
        ...(siteIcon ? { siteIcon } : {}),
        ...(publishedAt ? { publishedAt } : {}),
        ...(snippet ? { snippet } : {}),
        ...(summary ? { summary } : {}),
        ...(content ? { content } : {}),
      });
      if (results.length >= count) break;
    }
    return { results, query, truncated: chars.length > 128 };
  } finally {
    req.clear();
  }
}

/** Options-object wrapper for `searchDeepSeek` (`/v1/tools/search`). */
export function searchDeepSeekWeb(options: DeepSeekSearchOptions): Promise<{ results: WebSearchResult[]; query: string; truncated: boolean }> {
  return searchDeepSeek(options.baseUrl, options.apiKey, {
    query: options.query,
    count: options.count,
    needContent: options.needContent,
    oriQuestion: options.oriQuestion,
    localization: options.localization,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
}

// ------------------------------------------------------------------------------------------------------------ web fetch

/** Fetches a web page as Markdown through DeepSeek's standalone fetch service (`POST /v1/tools/fetch`). */
export async function fetchDeepSeekWeb(options: DeepSeekFetchOptions): Promise<WebFetchResult> {
  if (options.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" } });
  const url = options.url.trim();
  if (!url || !WEB.test(url) || url.length > 2048) {
    throw new MangaError("VALIDATION_ERROR", "a valid http(s) URL up to 2048 characters is required");
  }
  const req = createRequestSignal(options.timeoutMs ?? 60_000, options.signal);
  try {
    const response = await (options.fetchImpl ?? fetch)(joinApiPath(options.baseUrl, "/v1/tools/fetch"), {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ url }),
      redirect: "error",
      signal: req.signal,
    }).catch((error) => { throw networkError(error, options.signal); });
    if (!response.ok) throw await failure(response);
    try {
      requireMachineAnswer(response);
    } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    const rawText = await response.text().catch((error) => {
      if (req.isTimedOut()) throw networkError(new DOMException("request timed out", "TimeoutError"), options.signal);
      throw networkError(error, options.signal);
    });
    const json = parseJsonAnswer<{
      url?: unknown;
      final_url?: unknown;
      title?: unknown;
      content?: unknown;
      site_name?: unknown;
      site_icon?: unknown;
      published_at?: unknown;
      date?: unknown;
      truncated?: unknown;
    }>(rawText, "JSON");
    if (typeof json.content !== "string") throw protocolError("no content");
    const finalUrl = typeof json.final_url === "string" && WEB.test(json.final_url)
      ? json.final_url
      : typeof json.url === "string" && WEB.test(json.url) && json.url !== url
        ? json.url
        : undefined;
    let site = typeof json.site_name === "string" && json.site_name.trim() ? json.site_name.trim() : undefined;
    if (!site) {
      try { site = new URL(finalUrl ?? url).hostname.replace(/^www\./, ""); } catch { site = undefined; }
    }
    const siteIcon = typeof json.site_icon === "string" && WEB.test(json.site_icon) ? json.site_icon : undefined;
    const publishedAt = typeof json.published_at === "string" && json.published_at.trim()
      ? json.published_at.trim()
      : typeof json.date === "string" && json.date.trim()
        ? json.date.trim()
        : undefined;
    const title = typeof json.title === "string" && json.title.trim() ? json.title.trim() : (site ?? url);
    return {
      url,
      ...(finalUrl ? { finalUrl } : {}),
      title,
      content: json.content,
      ...(site ? { site } : {}),
      ...(siteIcon ? { siteIcon } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      source: "deepseek_fetch",
      ...(json.truncated === true ? { truncated: true } : {}),
    };
  } finally {
    req.clear();
  }
}

// ------------------------------------------------------------------------------------------------------------ document OCR

/** Extracts text or rich layout content from a PDF, Office document, or image via `POST /v1/tools/ocr`. */
export async function ocrDeepSeekDocument(options: DeepSeekOcrOptions): Promise<OcrResult> {
  if (options.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" } });
  const filename = options.filename.trim();
  if (!filename) throw new MangaError("VALIDATION_ERROR", "filename is required", { details: { errorCode: "file_invalid" } });
  if (!options.data.byteLength) throw new MangaError("VALIDATION_ERROR", "file is empty", { details: { errorCode: "file_invalid" } });
  if (options.data.byteLength > 64 * 1024 * 1024) {
    throw new MangaError("VALIDATION_ERROR", "OCR file exceeds 64 MiB limit", { details: { kind: "file_invalid", errorCode: "file_invalid" } });
  }
  const form = new FormData();
  form.append("purpose", options.purpose);
  const copy = new Uint8Array(options.data.byteLength);
  copy.set(options.data);
  form.append("file", new Blob([copy], { type: options.mimeType ?? "application/octet-stream" }), filename);

  const req = createRequestSignal(options.timeoutMs ?? 120_000, options.signal);
  try {
    const response = await (options.fetchImpl ?? fetch)(joinApiPath(options.baseUrl, "/v1/tools/ocr"), {
      method: "POST",
      headers: { authorization: `Bearer ${options.apiKey}` },
      body: form,
      redirect: "error",
      signal: req.signal,
    }).catch((error) => { throw networkError(error, options.signal); });
    if (!response.ok) throw await failure(response);
    try {
      requireMachineAnswer(response);
    } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    const rawText = await response.text().catch((error) => {
      if (req.isTimedOut()) throw networkError(new DOMException("request timed out", "TimeoutError"), options.signal);
      throw networkError(error, options.signal);
    });
    const json = parseJsonAnswer<{
      purpose?: unknown;
      page_count?: unknown;
      pages?: Array<{ index?: unknown; page?: unknown; text?: unknown }>;
      text?: unknown;
      usage?: { input_tokens?: unknown; output_tokens?: unknown; pages?: unknown };
    }>(rawText, "JSON");

    const pages: OcrPage[] = Array.isArray(json.pages)
      ? json.pages
          .filter((item): item is { index?: unknown; page?: unknown; text?: unknown } => Boolean(item) && typeof item === "object")
          .map((item, idx) => ({
            page: typeof item.page === "number" && item.page >= 1
              ? Math.floor(item.page)
              : typeof item.index === "number" && item.index >= 0
                ? Math.floor(item.index) + 1
                : idx + 1,
            text: typeof item.text === "string" ? item.text : "",
          }))
      : typeof json.text === "string"
        ? [{ page: 1, text: json.text }]
        : [];
    if (!pages.length && typeof json.text !== "string") throw protocolError("no OCR pages");
    const fullText = typeof json.text === "string" ? json.text : pages.map((page) => page.text).join("\n\n");
    const pageCount = typeof json.page_count === "number" ? Math.max(0, Math.floor(json.page_count))
      : typeof json.usage?.pages === "number" ? Math.max(0, Math.floor(json.usage.pages))
        : pages.length;
    const inputTokens = typeof json.usage?.input_tokens === "number" ? Math.max(0, Math.floor(json.usage.input_tokens)) : undefined;
    const outputTokens = typeof json.usage?.output_tokens === "number" ? Math.max(0, Math.floor(json.usage.output_tokens)) : undefined;
    const purpose = json.purpose === "text_recognition" || json.purpose === "rich_layout_recognition" ? json.purpose : options.purpose;

    return {
      text: fullText,
      pages,
      purpose,
      usage: {
        pages: pageCount,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
      },
    };
  } finally {
    req.clear();
  }
}

// ------------------------------------------------------------------------------------------------------------ account balance

/** Reads DeepSeek account availability and currency balances via `GET /user/balance`. */
export async function fetchDeepSeekBalance(options: DeepSeekBalanceOptions): Promise<DeepSeekBalanceResult> {
  if (options.signal?.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" } });
  const req = createRequestSignal(options.timeoutMs ?? 15_000, options.signal);
  try {
    const response = await (options.fetchImpl ?? fetch)(joinApiPath(options.baseUrl, "/user/balance"), {
      method: "GET",
      headers: { authorization: `Bearer ${options.apiKey}`, accept: "application/json" },
      redirect: "error",
      signal: req.signal,
    }).catch((error) => { throw networkError(error, options.signal); });
    if (!response.ok) throw await failure(response);
    try {
      requireMachineAnswer(response);
    } catch (error) {
      void response.body?.cancel().catch(() => undefined);
      throw error;
    }
    const rawText = await response.text().catch((error) => {
      if (req.isTimedOut()) throw networkError(new DOMException("request timed out", "TimeoutError"), options.signal);
      throw networkError(error, options.signal);
    });
    const json = parseJsonAnswer<{
      is_available?: unknown;
      balance_infos?: Array<{
        currency?: unknown;
        total_balance?: unknown;
        granted_balance?: unknown;
        topped_up_balance?: unknown;
      }>;
    }>(rawText, "JSON");
    if (typeof json.is_available !== "boolean") throw protocolError("missing is_available");
    const balances: ProviderBalanceInfo[] = (Array.isArray(json.balance_infos) ? json.balance_infos : [])
      .filter((item): item is NonNullable<typeof item> => Boolean(item) && typeof item === "object" && typeof item.currency === "string" && item.currency.trim().length > 0)
      .map((item) => ({
        currency: String(item.currency).trim(),
        totalBalance: String(item.total_balance ?? "0"),
        ...(item.granted_balance !== undefined && item.granted_balance !== null ? { grantedBalance: String(item.granted_balance) } : {}),
        ...(item.topped_up_balance !== undefined && item.topped_up_balance !== null ? { toppedUpBalance: String(item.topped_up_balance) } : {}),
      }));
    return {
      isAvailable: json.is_available,
      available: json.is_available,
      checkedAt: new Date().toISOString(),
      balances,
    };
  } finally {
    req.clear();
  }
}
