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

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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
};

export type TranscriptionRequest = {
  model: string;
  fileName: string;
  bytes: Uint8Array;
  mimeType: string;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export function mapHttpError(status: number, _body: string): MangaError {
  if (status === 401) return new MangaError("AUTHENTICATION_FAILED", "provider rejected the credentials", { details: { status } });
  if (status === 429) return new MangaError("RATE_LIMITED", "provider rate limited the request", { retryable: true, details: { status } });
  // A provider can reflect request text or authorization into its error body.
  // Public command errors are persisted and displayed, so retain only the status.
  if (status === 404) return new MangaError("MODEL_CAPABILITY_MISSING", "provider reported a missing capability", { details: { status } });
  return new MangaError("PROVIDER_UNAVAILABLE", `provider HTTP ${status}`, { retryable: status >= 500, details: { status } });
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
