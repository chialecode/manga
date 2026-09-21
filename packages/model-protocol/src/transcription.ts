import { MangaError } from "@manga/contracts";
import { joinApiPath, mapHttpError, type TranscriptionRequest } from "./http.ts";

export async function transcribeAudio(baseUrl: string, apiKey: string, request: TranscriptionRequest): Promise<{ text: string }> {
  const url = joinApiPath(baseUrl, "/audio/transcriptions");
  const body = new FormData();
  body.set("model", request.model);
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
      throw mapHttpError(response.status, text);
    }
    const json = await response.json() as { text?: string };
    return { text: json.text ?? "" };
  } catch (error) {
    if (request.signal?.aborted || controller.signal.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
    if (error instanceof MangaError) throw error;
    throw new MangaError("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "transcription failed", { retryable: true });
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", onAbort);
  }
}
