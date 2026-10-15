import { MangaError } from "@manga/contracts";
import { joinApiPath } from "@manga/model-protocol";

/**
 * Asks an OpenAI-compatible `/embeddings` endpoint for one vector per input. Nothing of the response is kept beyond the numbers, and its text
 * never goes into an error: the caller learns what kind of failure it was, and whether trying again can help.
 */
export async function embedTexts(baseUrl: string, apiKey: string, request: { model: string; inputs: string[]; signal: AbortSignal; timeoutMs: number }): Promise<number[][]> {
  const combined = AbortSignal.any([request.signal, AbortSignal.timeout(request.timeoutMs)]);
  let response: Response;
  try {
    response = await fetch(joinApiPath(baseUrl, "/embeddings"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: request.model, input: request.inputs }),
      signal: combined,
    });
  } catch (error) {
    if (request.signal.aborted) throw new MangaError("CANCELLED", "request cancelled");
    const timedOut = combined.aborted || (error as { name?: string }).name === "TimeoutError";
    throw new MangaError("PROVIDER_UNAVAILABLE", timedOut ? "the embedding service took too long to answer" : "the embedding service could not be reached", { retryable: true, details: { reason: timedOut ? "timeout" : "network" } });
  }
  if (!response.ok) {
    const status = response.status;
    if (status === 401 || status === 403) throw new MangaError("AUTHENTICATION_FAILED", "the embedding service refused the credential", { details: { status } });
    if (status === 404) throw new MangaError("MODEL_CAPABILITY_MISSING", "the embedding service has no such model or endpoint", { details: { status } });
    throw new MangaError("PROVIDER_UNAVAILABLE", `the embedding service answered ${status}`, { retryable: status === 429 || status >= 500, details: { status } });
  }
  let json: { data?: Array<{ embedding?: unknown; index?: unknown }> };
  try {
    json = await response.json() as typeof json;
  } catch {
    throw new MangaError("PROVIDER_UNAVAILABLE", "the embedding service sent an answer that is not JSON", { details: { reason: "format" } });
  }
  const rows = Array.isArray(json.data) ? json.data : [];
  const ordered = [...rows].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));
  const vectors = ordered.map((row) => row.embedding);
  if (vectors.length !== request.inputs.length || !vectors.every((vector) => Array.isArray(vector) && vector.length > 0 && vector.every((value) => typeof value === "number" && Number.isFinite(value)))) {
    throw new MangaError("MODEL_CAPABILITY_MISSING", "the embedding service did not return one usable vector per input", { details: { reason: "vector" } });
  }
  return vectors as number[][];
}
