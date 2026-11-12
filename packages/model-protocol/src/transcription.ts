import { MangaError } from "@manga/contracts";
import {
  joinApiPath,
  mapHttpError,
  networkError,
  parseJsonAnswer,
  protocolError,
  requireMachineAnswer,
  type TranscriptionRequest,
  type TranscriptionResult,
} from "./http.ts";

export const DEFAULT_CHAT_AUDIO_SYSTEM_PROMPT = "请逐字转写音频内容，不要解释或扩写。";

export type ChatAudioTranscriptionRequest = {
  model: string;
  bytes: Uint8Array;
  fileName?: string;
  mimeType?: string;
  format?: "wav" | "mp3";
  /** Explicit full system prompt. When omitted, built from `DEFAULT_CHAT_AUDIO_SYSTEM_PROMPT` plus `language` and `context`/`prompt`. */
  systemPrompt?: string;
  /** Proper-noun context clause or list injected into the system message when `systemPrompt` is omitted. */
  context?: string;
  /** Fallback alias for `context` when callers share a `TranscriptionRequest`-shaped object. */
  prompt?: string;
  /** ISO-639-1 / BCP-47 language hint. */
  language?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

function inferAudioFormat(request: Pick<ChatAudioTranscriptionRequest, "format" | "mimeType" | "fileName">): "wav" | "mp3" {
  if (request.format) return request.format;
  const mime = (request.mimeType ?? "").toLowerCase();
  const name = (request.fileName ?? "").toLowerCase();
  if (mime.includes("mpeg") || mime.includes("mp3") || name.endsWith(".mp3")) return "mp3";
  return "wav";
}

function buildChatAudioSystemContent(request: ChatAudioTranscriptionRequest): string {
  if (request.systemPrompt !== undefined) return request.systemPrompt;
  const parts = [DEFAULT_CHAT_AUDIO_SYSTEM_PROMPT];
  const lang = request.language?.trim();
  if (lang && lang.toLowerCase() !== "auto") {
    parts.push(`主要语言：${lang}。`);
  }
  const hint = (request.context ?? request.prompt ?? "").trim();
  if (hint) {
    parts.push(hint.startsWith("可能出现的专有名词：") ? hint : `可能出现的专有名词：${hint}`);
  }
  return parts.join("");
}

function mapErrorWithRetryAfter(response: Response, bodyText: string): MangaError {
  const error = mapHttpError(response.status, bodyText);
  const wait = Number(response.headers.get("retry-after"));
  if (response.status === 429 && Number.isFinite(wait) && wait >= 0) {
    return new MangaError(error.code, error.message, {
      retryable: true,
      details: { ...error.details, retryAfterMs: Math.min(wait, 120) * 1000 },
    });
  }
  return error;
}

export async function transcribeAudio(
  baseUrl: string,
  apiKey: string,
  request: TranscriptionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<TranscriptionResult> {
  if (request.signal?.aborted) {
    throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
  }
  const url = joinApiPath(baseUrl, "/audio/transcriptions");
  const body = new FormData();
  body.set("model", request.model);
  if (request.prompt) body.set("prompt", request.prompt);
  if (request.language) body.set("language", request.language);
  if (request.timestamps) {
    body.set("response_format", "verbose_json");
    body.append("timestamp_granularities[]", "segment");
  }
  const copy = new Uint8Array(request.bytes.byteLength);
  copy.set(request.bytes);
  body.set("file", new Blob([copy], { type: request.mimeType }), request.fileName);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs ?? 60_000);
  const onAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw mapErrorWithRetryAfter(response, text);
    }
    requireMachineAnswer(response);
    const json = parseJsonAnswer<{
      text?: string;
      duration?: number;
      language?: string;
      segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }>;
    }>(await response.text().catch(() => ""), "JSON");
    const segments = Array.isArray(json.segments)
      ? json.segments
          .filter(
            (item) =>
              typeof item.start === "number" &&
              typeof item.end === "number" &&
              typeof item.text === "string" &&
              (item.end as number) >= (item.start as number),
          )
          .map((item) => ({ start: item.start as number, end: item.end as number, text: item.text as string }))
      : undefined;
    return {
      text: json.text ?? "",
      ...(segments?.length ? { segments } : {}),
      ...(typeof json.duration === "number" ? { duration: json.duration } : {}),
      ...(typeof json.language === "string" ? { language: json.language } : {}),
    };
  } catch (error) {
    if (request.signal?.aborted) {
      throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
    }
    if (timedOut) {
      throw new MangaError("PROVIDER_UNAVAILABLE", "transcription request timed out", {
        retryable: true,
        details: { kind: "timeout" },
      });
    }
    if (error instanceof MangaError) throw error;
    throw networkError(error, request.signal);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Transcribes audio through OpenAI-compatible `POST /chat/completions` with `input_audio`
 * (for providers such as Bailian `qwen3-asr-flash` that expose audio recognition on Chat Completions).
 */
export async function transcribeChatAudio(
  baseUrl: string,
  apiKey: string,
  request: ChatAudioTranscriptionRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<TranscriptionResult> {
  if (request.signal?.aborted) {
    throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
  }
  const url = joinApiPath(baseUrl, "/chat/completions");
  const systemContent = buildChatAudioSystemContent(request);
  const format = inferAudioFormat(request);
  const base64Wav = Buffer.from(request.bytes.buffer, request.bytes.byteOffset, request.bytes.byteLength).toString("base64");

  const payload = {
    model: request.model,
    temperature: 0,
    messages: [
      { role: "system", content: systemContent },
      {
        role: "user",
        content: [
          {
            type: "input_audio",
            input_audio: {
              data: base64Wav,
              format,
            },
          },
        ],
      },
    ],
  };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, request.timeoutMs ?? 60_000);
  const onAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw mapErrorWithRetryAfter(response, text);
    }
    requireMachineAnswer(response);
    const json = parseJsonAnswer<{
      choices?: Array<{
        message?: {
          content?: string | Array<{ type?: string; text?: string }> | null;
        };
      }>;
    }>(await response.text().catch(() => ""), "JSON");
    if (!Array.isArray(json.choices)) throw protocolError("no choices");
    const rawContent = json.choices[0]?.message?.content;
    let text = "";
    if (typeof rawContent === "string") {
      text = rawContent;
    } else if (Array.isArray(rawContent)) {
      text = rawContent
        .map((part) => (part && typeof part.text === "string" ? part.text : ""))
        .join("");
    }
    return { text };
  } catch (error) {
    if (request.signal?.aborted) {
      throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
    }
    if (timedOut) {
      throw new MangaError("PROVIDER_UNAVAILABLE", "transcription request timed out", {
        retryable: true,
        details: { kind: "timeout" },
      });
    }
    if (error instanceof MangaError) throw error;
    throw networkError(error, request.signal);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
