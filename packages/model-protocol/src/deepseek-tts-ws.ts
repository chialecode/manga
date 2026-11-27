import { MangaError, type AgentErrorCode } from "@manga/contracts";
import { DEEPSEEK_TTS_LIMITS, speechBilledChars } from "./deepseek-services.ts";
import { joinApiPath, networkError } from "./http.ts";
import type { DeepSeekTtsWsOptions, DeepSeekTtsWsResult, DeepSeekTtsWsSession } from "./types.ts";

/**
 * Builds the WebSocket URL (`wss://` or `ws://`) for DeepSeek's real-time streaming TTS endpoint (`/v1/tools/tts`).
 */
export function deepSeekTtsWsUrl(
  baseUrl: string,
  options: { voice?: string; format?: "pcm" | "opus"; filterMarkdown?: boolean } = {},
): string {
  const httpUrl = joinApiPath(baseUrl, "/v1/tools/tts");
  const parsed = new URL(httpUrl);
  parsed.protocol = parsed.protocol === "http:" ? "ws:" : "wss:";
  parsed.searchParams.set("voice_id", options.voice ?? "stella");
  parsed.searchParams.set("format", options.format ?? "pcm");
  parsed.searchParams.set("filter_markdown", String(options.filterMarkdown ?? true));
  return parsed.toString();
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function mapFinishError(code: string | undefined, message: string | undefined): MangaError {
  const normalized = (code ?? "").toLowerCase();
  if (normalized === "content_filter") {
    return new MangaError("PROVIDER_UNAVAILABLE", "内容被服务拒绝", {
      details: { kind: "content_filter", errorCode: "refusal" satisfies AgentErrorCode, wsCode: code },
    });
  }
  if (normalized === "invalid_input") {
    return new MangaError("VALIDATION_ERROR", message || "invalid speech input", {
      details: { errorCode: "unknown" satisfies AgentErrorCode, wsCode: code },
    });
  }
  if (normalized === "input_timeout") {
    return new MangaError("PROVIDER_UNAVAILABLE", message || "speech input timed out", {
      retryable: true,
      details: { kind: "timeout", errorCode: "network" satisfies AgentErrorCode, wsCode: code },
    });
  }
  return new MangaError("PROVIDER_UNAVAILABLE", message || `speech stream failed (${code || "unknown"})`, {
    retryable: true,
    details: { kind: "stream_error", errorCode: "server" satisfies AgentErrorCode, wsCode: code },
  });
}

/**
 * Opens an incremental WebSocket streaming TTS session against DeepSeek `/v1/tools/tts`.
 * Authenticates via standard `Sec-WebSocket-Protocol: tts, bearer.<apiKey>`, buffers `push()` chunks until the
 * handshake completes, preserves 16-bit PCM sample alignment, and supports both `onChunk` callbacks and `for await`.
 */
export function createDeepSeekTtsStream(options: DeepSeekTtsWsOptions): DeepSeekTtsWsSession {
  const format = options.format ?? "pcm";
  const url = deepSeekTtsWsUrl(options.baseUrl, {
    voice: options.voice ?? "stella",
    format,
    filterMarkdown: options.filterMarkdown ?? true,
  });

  const started = Date.now();
  let bytes = 0;
  let billedChars = 0;
  let firstChunkMs: number | null = null;
  let carry: Uint8Array | null = null;
  let opened = false;
  let finishing = false;
  let settled = false;
  const outgoing: string[] = [];

  // Async iterator queue state.
  const queue: Uint8Array[] = [];
  const waiters: Array<{ resolve: (result: IteratorResult<Uint8Array>) => void; reject: (error: unknown) => void }> = [];
  let terminalError: unknown = null;

  let resolveDone!: (result: DeepSeekTtsWsResult) => void;
  let rejectDone!: (error: unknown) => void;
  const done = new Promise<DeepSeekTtsWsResult>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  // Prevent unhandled rejection noise when callers consume via `for await` instead of `await session.done`.
  done.catch(() => undefined);

  const timeoutMs = options.timeoutMs ?? 120_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ws: WebSocket | null = null;

  const cleanup = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    options.signal?.removeEventListener("abort", onAbort);
  };

  const emitChunk = (chunk: Uint8Array) => {
    options.onChunk?.(chunk);
    const waiter = waiters.shift();
    if (waiter) waiter.resolve({ value: chunk, done: false });
    else queue.push(chunk);
  };

  const succeed = () => {
    if (settled) return;
    settled = true;
    cleanup();
    const result: DeepSeekTtsWsResult = { bytes, billedChars, firstChunkMs, transport: "ws" };
    while (waiters.length) waiters.shift()!.resolve({ value: undefined, done: true });
    resolveDone(result);
  };

  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    terminalError = error;
    cleanup();
    try { ws?.close(); } catch { /* closing */ }
    while (waiters.length) waiters.shift()!.reject(error);
    rejectDone(error);
  };

  const onAbort = () => {
    fail(new MangaError("CANCELLED", "request cancelled", { retryable: true, details: { errorCode: "cancelled" satisfies AgentErrorCode } }));
  };

  if (options.signal?.aborted) {
    onAbort();
  } else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      fail(networkError(new DOMException("request timed out", "TimeoutError"), options.signal));
    }, timeoutMs);

    try {
      ws = new WebSocket(url, ["tts", `bearer.${options.apiKey}`]);
      ws.binaryType = "arraybuffer";
    } catch (error) {
      fail(networkError(error, options.signal));
    }

    if (ws) {
      ws.addEventListener("open", () => {
        if (settled || !ws) return;
        opened = true;
        while (outgoing.length) ws.send(outgoing.shift()!);
      });

      ws.addEventListener("message", (event) => {
        if (settled) return;
        if (typeof event.data === "string") {
          let parsed: { event?: string; code?: string; message?: string } | null = null;
          try { parsed = JSON.parse(event.data) as { event?: string; code?: string; message?: string }; } catch { parsed = null; }
          if (!parsed) return;
          if (parsed.event === "finish") {
            if (!parsed.code || parsed.code === "success") {
              try { ws?.close(1000, "done"); } catch { /* closing */ }
              succeed();
            } else {
              fail(mapFinishError(parsed.code, parsed.message));
            }
          } else if (parsed.event === "error") {
            fail(mapFinishError(parsed.code, parsed.message));
          }
          return;
        }

        const handleBinary = (raw: Uint8Array) => {
          if (settled || !raw.byteLength) return;
          firstChunkMs ??= Date.now() - started;
          if (format === "pcm") {
            let piece: Uint8Array = carry ? concatBytes(carry, raw) : raw;
            carry = null;
            if (piece.length % 2) {
              carry = piece.subarray(piece.length - 1);
              piece = piece.subarray(0, piece.length - 1);
            }
            if (piece.length) {
              bytes += piece.length;
              emitChunk(piece);
            }
          } else {
            bytes += raw.length;
            emitChunk(raw);
          }
        };

        if (event.data instanceof ArrayBuffer) {
          handleBinary(new Uint8Array(event.data));
        } else if (ArrayBuffer.isView(event.data)) {
          handleBinary(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
        } else if (typeof Blob !== "undefined" && event.data instanceof Blob) {
          void event.data.arrayBuffer().then((buf) => handleBinary(new Uint8Array(buf))).catch((error) => fail(networkError(error, options.signal)));
        }
      });

      ws.addEventListener("error", () => {
        if (settled) return;
        fail(new MangaError("PROVIDER_UNAVAILABLE", "speech WebSocket connection failed", {
          retryable: true,
          details: { kind: "network", errorCode: "network" satisfies AgentErrorCode },
        }));
      });

      ws.addEventListener("close", (event) => {
        if (settled) return;
        if (finishing && bytes > 0 && event.code === 1000) {
          succeed();
          return;
        }
        fail(new MangaError("PROVIDER_UNAVAILABLE", "the speech stream closed before completion", {
          retryable: true,
          details: { kind: "truncated", bytes, closeCode: event.code, errorCode: "network" satisfies AgentErrorCode },
        }));
      });
    }
  }

  const sendPayload = (payload: Record<string, unknown>) => {
    const frame = JSON.stringify(payload);
    if (opened && ws && ws.readyState === WebSocket.OPEN) ws.send(frame);
    else outgoing.push(frame);
  };

  return {
    push(textChunk: string) {
      if (settled || finishing) return;
      if (!textChunk) return;
      const added = speechBilledChars(textChunk);
      if (billedChars + added > DEEPSEEK_TTS_LIMITS.billedChars) {
        fail(new MangaError("VALIDATION_ERROR", "the text exceeds one speech session limit", {
          details: { billedChars: billedChars + added, limit: DEEPSEEK_TTS_LIMITS.billedChars },
        }));
        return;
      }
      billedChars += added;
      sendPayload({ event: "text", text: textChunk });
    },
    finish() {
      if (!settled && !finishing) {
        finishing = true;
        sendPayload({ event: "finish_text" });
      }
      return done;
    },
    abort() {
      if (settled) return;
      onAbort();
    },
    get done() {
      return done;
    },
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
          if (settled) {
            if (terminalError) return Promise.reject(terminalError);
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<IteratorResult<Uint8Array>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
        return(): Promise<IteratorResult<Uint8Array>> {
          if (!settled) onAbort();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}
