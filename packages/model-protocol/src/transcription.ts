import { MangaError } from "@manga/contracts";
import { joinApiPath, mapHttpError, type TranscriptionRequest, type TranscriptionResult } from "./http.ts";

export async function transcribeAudio(baseUrl: string, apiKey: string, request: TranscriptionRequest): Promise<TranscriptionResult> {
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
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? 60_000);
  const onAbort = () => controller.abort();
  request.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = mapHttpError(response.status, text);
      // A limited request says when to come back; the caller's backoff should honor it.
      const wait = Number(response.headers.get("retry-after"));
      if (response.status === 429 && Number.isFinite(wait) && wait >= 0) {
        throw new MangaError(error.code, error.message, { retryable: true, details: { ...error.details, retryAfterMs: Math.min(wait, 120) * 1000 } });
      }
      throw error;
    }
    const json = await response.json() as { text?: string; duration?: number; language?: string; segments?: Array<{ start?: unknown; end?: unknown; text?: unknown }> };
    const segments = Array.isArray(json.segments)
      ? json.segments.filter((item) => typeof item.start === "number" && typeof item.end === "number" && typeof item.text === "string" && (item.end as number) >= (item.start as number))
        .map((item) => ({ start: item.start as number, end: item.end as number, text: item.text as string }))
      : undefined;
    return {
      text: json.text ?? "",
      ...(segments?.length ? { segments } : {}),
      ...(typeof json.duration === "number" ? { duration: json.duration } : {}),
      ...(typeof json.language === "string" ? { language: json.language } : {}),
    };
  } catch (error) {
    if (request.signal?.aborted || controller.signal.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
    if (error instanceof MangaError) throw error;
    throw new MangaError("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "transcription failed", { retryable: true });
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
