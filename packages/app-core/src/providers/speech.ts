import { createHash } from "node:crypto";
import { MangaError, SPEECH_VOICES, type SpeechVoice } from "@manga/contracts";
import {
  createDeepSeekTtsStream,
  DEEPSEEK_TTS_LIMITS,
  speechBilledChars,
  stripMarkdownForSpeech,
  synthesizeDeepSeek,
} from "@manga/model-protocol";
import type { ConnectionRow } from "../product-helpers.ts";
import { connectionAccess, providerAbortReason, providerOf, type ProviderAccessHost } from "./access.ts";
import { recordServiceUse } from "./usage.ts";

export { SPEECH_VOICES, type SpeechVoice };

/** What the speech service is asked: the text, which connection and voice speak it, and whether to prefer WS streaming. */
export type SpeakRequest = {
  text: string;
  connectionId?: string | null;
  voice?: SpeechVoice | string | null;
  task?: "read-aloud" | "novel" | "test";
  streaming?: boolean;
};

export type SpeakResult = {
  billedChars: number;
  cached: boolean;
  firstChunkMs: number | null;
  bytes: number;
  transport?: "http" | "ws";
};

export type SpeechStreamStartOptions = {
  connectionId?: string | null;
  voice?: SpeechVoice | string | null;
  task?: "read-aloud" | "novel" | "test";
};

export type SpeechStreamSession = {
  push(textChunk: string): void;
  finish(): Promise<SpeakResult & { transport: "http" | "ws" }>;
  abort(): void;
};

const CACHE_TTL_MS = 10 * 60_000;
const CACHE_ENTRY_BYTES = 8 * 1024 * 1024;
const CACHE_TOTAL_BYTES = 64 * 1024 * 1024;

const HAN = /\p{Script=Han}/u;
const charBilled = (char: string): number => (HAN.test(char) ? 2 : 1);

/**
 * Splits a text into the pieces one request takes (计划 4.7): at most 10,000 billed characters (a Chinese character counts 2), cut after a sentence where it
 * can, and inside one only when a sentence alone is longer.
 */
export function splitForSpeech(text: string, limit = DEEPSEEK_TTS_LIMITS.billedChars): string[] {
  const sentences = text.match(/[^。！？!?；;\n]+[。！？!?；;\n]*|[。！？!?；;\n]+/g) ?? [];
  const pieces: string[] = [];
  let current = "";
  let currentBilled = 0;
  const push = () => {
    if (current.trim()) pieces.push(current);
    current = "";
    currentBilled = 0;
  };
  for (const sentence of sentences) {
    const sentenceBilled = speechBilledChars(sentence);
    if (currentBilled + sentenceBilled <= limit) {
      current += sentence;
      currentBilled += sentenceBilled;
      continue;
    }
    push();
    if (sentenceBilled <= limit) {
      current = sentence;
      currentBilled = sentenceBilled;
      continue;
    }
    // One sentence longer than a request: cut by characters.
    let part = "";
    let partBilled = 0;
    for (const char of sentence) {
      const weight = charBilled(char);
      if (part && partBilled + weight > limit) {
        if (part.trim()) pieces.push(part);
        part = "";
        partBilled = 0;
      }
      part += char;
      partBilled += weight;
    }
    current = part;
    currentBilled = partBilled;
  }
  push();
  return pieces;
}

function resolveVoice(requested: string | null | undefined, fallback: string): SpeechVoice {
  const candidate = requested ?? fallback;
  return SPEECH_VOICES.includes(candidate as SpeechVoice) ? (candidate as SpeechVoice) : "stella";
}

function isNonFallbackError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (!(error instanceof MangaError)) return false;
  if (error.code === "CANCELLED" || error.code === "AUTHENTICATION_FAILED") return true;
  const details = (error.details ?? {}) as { reason?: string; kind?: string; errorCode?: string; status?: number };
  if (details.reason === "plugin_disabled" || details.kind === "content_filter" || details.errorCode === "refusal" || details.kind === "billing" || details.status === 402) {
    return true;
  }
  return false;
}

type Cached = { pcm: Buffer; at: number };

/**
 * Speech from a provider's speech service (VOICE-19): in-memory PCM only (never written to disk), pre-TTS Markdown
 * stripping before billing/splitting, 10-minute in-memory cache, and WebSocket incremental streaming with clean HTTP fallback.
 */
export class SpeechService {
  private readonly cache = new Map<string, Cached>();
  private cachedBytes = 0;

  private readonly app: ProviderAccessHost;
  private readonly settings: () => { connectionId: string | null; voice: string };
  private readonly now: () => number;

  constructor(app: ProviderAccessHost, settings: () => { connectionId: string | null; voice: string }, now: () => number = Date.now) {
    this.app = app;
    this.settings = settings;
    this.now = now;
  }

  /** The connection that speaks: the one asked for, the one chosen in the settings, or the first speech connection. */
  connection(connectionId?: string | null): ConnectionRow | undefined {
    const wanted = connectionId ?? this.settings().connectionId;
    const byId = wanted ? this.app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ? AND purpose = 'speech'").get(wanted) as ConnectionRow | undefined : undefined;
    return byId ?? this.app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE purpose = 'speech' ORDER BY created_at, rowid LIMIT 1").get() as ConnectionRow | undefined;
  }

  async speak(request: SpeakRequest, onChunk: (pcm: Uint8Array) => void, signal: AbortSignal): Promise<SpeakResult> {
    const text = stripMarkdownForSpeech(request.text).trim();
    if (!text) throw new MangaError("VALIDATION_ERROR", "nothing to read aloud");
    const row = this.connection(request.connectionId);
    if (!row) throw new MangaError("MODEL_CAPABILITY_MISSING", "没有配置语音合成：在“设置 › 模型”里从 DeepSeek 加入“语音合成”", { details: { reason: "no_speech_service" } });
    const voice = resolveVoice(request.voice, this.settings().voice);
    const key = createHash("sha256").update(`${row.id}\u0000${voice}\u0000${text}`).digest("hex");
    const started = this.now();
    // A connection whose plugin is off does not read aloud, not even from memory (计划 4.1).
    const verifiedProvider = await providerOf(this.app, row);
    const hit = this.fromCache(key);
    if (hit) {
      onChunk(hit);
      return { billedChars: 0, cached: true, firstChunkMs: this.now() - started, bytes: hit.length, transport: "http" };
    }

    const access = await connectionAccess(this.app, row, signal, verifiedProvider);
    let billed = 0;
    let firstChunkMs: number | null = null;
    const kept: Buffer[] = [];
    let keptBytes = 0;
    let totalBytes = 0;
    let cacheable = true;
    const recordChunk = (chunk: Uint8Array) => {
      if (firstChunkMs === null) firstChunkMs = this.now() - started;
      totalBytes += chunk.length;
      if (cacheable) {
        if (keptBytes + chunk.length <= CACHE_ENTRY_BYTES) {
          kept.push(Buffer.from(chunk));
          keptBytes += chunk.length;
        } else {
          cacheable = false;
          kept.length = 0;
          keptBytes = 0;
        }
      }
      onChunk(chunk);
    };

    try {
      if (!access.apiKey) throw new MangaError("AUTHENTICATION_FAILED", "the speech connection has no key");
      const runSignal = access.signal ?? signal;

      // When caller opts into streaming TTS and the text fits in a single WS session, prefer WS with transparent HTTP fallback.
      if (request.streaming && speechBilledChars(text) <= DEEPSEEK_TTS_LIMITS.billedChars) {
        try {
          const ws = createDeepSeekTtsStream({
            baseUrl: row.base_url,
            apiKey: access.apiKey,
            voice,
            format: "pcm",
            filterMarkdown: true,
            signal: runSignal,
            timeoutMs: row.timeout_ms,
            onChunk: recordChunk,
          });
          ws.push(text);
          const wsResult = await ws.finish();
          billed = wsResult.billedChars;
          recordServiceUse(this.app, { connectionId: row.id, service: "speech", task: request.task ?? "read-aloud", unit: "char", quantity: billed, status: "ok" });
          if (cacheable && keptBytes > 0) this.remember(key, Buffer.concat(kept));
          return { billedChars: billed, cached: false, firstChunkMs, bytes: totalBytes, transport: "ws" };
        } catch (wsError) {
          const pluginOff = providerAbortReason(access.signal);
          if (pluginOff || totalBytes > 0 || isNonFallbackError(wsError, signal)) throw pluginOff ?? wsError;
          // WS failed before producing audio: fall through cleanly to HTTP TTS.
        }
      }

      for (const piece of splitForSpeech(text)) {
        const spoken = await synthesizeDeepSeek(row.base_url, access.apiKey, {
          text: piece, voice, signal: runSignal, timeoutMs: row.timeout_ms,
          onChunk: recordChunk,
        });
        billed += spoken.billedChars;
      }
      recordServiceUse(this.app, { connectionId: row.id, service: "speech", task: request.task ?? "read-aloud", unit: "char", quantity: billed, status: "ok" });
      if (cacheable && keptBytes > 0) this.remember(key, Buffer.concat(kept));
      return { billedChars: billed, cached: false, firstChunkMs, bytes: totalBytes, transport: "http" };
    } catch (error) {
      const pluginOff = providerAbortReason(access.signal);
      if (pluginOff || !signal.aborted || billed > 0) {
        const cause = pluginOff ?? error;
        recordServiceUse(this.app, {
          connectionId: row.id,
          service: "speech",
          task: request.task ?? "read-aloud",
          unit: "char",
          quantity: billed,
          status: "error",
          errorCode: cause instanceof MangaError ? cause.code : signal.aborted ? "CANCELLED" : "UNKNOWN",
        });
      }
      throw pluginOff ?? error;
    } finally {
      access.release();
    }
  }

  /**
   * Opens a real-time incremental WebSocket streaming TTS session (`VOICE-19`: in-memory PCM only, zero disk writes).
   * Falls back cleanly to HTTP TTS if the WebSocket fails before emitting audio.
   */
  async startStream(
    request: SpeechStreamStartOptions,
    onChunk: (pcm: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<SpeechStreamSession> {
    const row = this.connection(request.connectionId);
    if (!row) {
      throw new MangaError("MODEL_CAPABILITY_MISSING", "没有配置语音合成：在“设置 › 模型”里从 DeepSeek 加入“语音合成”", {
        details: { reason: "no_speech_service" },
      });
    }
    const voice = resolveVoice(request.voice, this.settings().voice);
    const verifiedProvider = await providerOf(this.app, row);
    const access = await connectionAccess(this.app, row, signal, verifiedProvider);
    if (!access.apiKey) {
      access.release();
      throw new MangaError("AUTHENTICATION_FAILED", "the speech connection has no key");
    }
    const apiKey = access.apiKey;
    const runSignal = access.signal ?? signal;
    const task = request.task ?? "read-aloud";
    const started = this.now();

    let firstChunkMs: number | null = null;
    let totalBytes = 0;
    let wsBytes = 0;
    let released = false;
    let finished = false;
    const rawChunks: string[] = [];
    // Lightweight fence tracker so incremental streaming skips fenced code blocks.
    let inFence = false;
    let fenceCarry = "";

    const releaseOnce = () => {
      if (released) return;
      released = true;
      access.release();
    };

    const ws = createDeepSeekTtsStream({
      baseUrl: row.base_url,
      apiKey,
      voice,
      format: "pcm",
      filterMarkdown: true,
      signal: runSignal,
      timeoutMs: row.timeout_ms,
      onChunk: (chunk) => {
        if (firstChunkMs === null) firstChunkMs = this.now() - started;
        totalBytes += chunk.length;
        wsBytes += chunk.length;
        onChunk(chunk);
      },
    });

    const sanitizeIncremental = (chunk: string): string => {
      const combined = fenceCarry + chunk;
      fenceCarry = "";
      let out = "";
      let i = 0;
      while (i < combined.length) {
        const fenceAt = combined.indexOf("```", i);
        if (fenceAt < 0) {
          // Hold trailing 1-2 backticks in case a fence splits across chunks.
          const tailTicks = combined.endsWith("``") ? 2 : combined.endsWith("`") ? 1 : 0;
          const body = tailTicks ? combined.slice(i, combined.length - tailTicks) : combined.slice(i);
          if (tailTicks) fenceCarry = combined.slice(combined.length - tailTicks);
          if (!inFence) out += body;
          break;
        }
        if (!inFence) {
          out += combined.slice(i, fenceAt);
          inFence = true;
          // Skip fence language header line if present inside this chunk.
          const nl = combined.indexOf("\n", fenceAt + 3);
          i = nl >= 0 ? nl + 1 : combined.length;
        } else {
          inFence = false;
          i = fenceAt + 3;
        }
      }
      if (!out) return "";
      const stripped = stripMarkdownForSpeech(out);
      return stripped;
    };

    const app = this.app;
    const now = this.now;
    return {
      push(textChunk: string) {
        if (finished || !textChunk) return;
        rawChunks.push(textChunk);
        const cleaned = sanitizeIncremental(textChunk);
        if (cleaned) ws.push(cleaned);
      },
      async finish(): Promise<SpeakResult & { transport: "http" | "ws" }> {
        if (finished) return { billedChars: 0, cached: false, firstChunkMs, bytes: totalBytes, transport: wsBytes > 0 ? "ws" : "http" };
        finished = true;
        try {
          if (fenceCarry && !inFence) {
            const tail = stripMarkdownForSpeech(fenceCarry);
            fenceCarry = "";
            if (tail) ws.push(tail);
          }
          const wsResult = await ws.finish();
          recordServiceUse(app, { connectionId: row.id, service: "speech", task, unit: "char", quantity: wsResult.billedChars, status: "ok" });
          return { billedChars: wsResult.billedChars, cached: false, firstChunkMs, bytes: totalBytes, transport: "ws" };
        } catch (wsError) {
          const pluginOff = providerAbortReason(access.signal);
          if (!pluginOff && wsBytes === 0 && !isNonFallbackError(wsError, signal)) {
            // Transparent HTTP fallback when WebSocket handshake or stream failed before emitting any audio.
            const fallbackText = stripMarkdownForSpeech(rawChunks.join("")).trim();
            if (!fallbackText) {
              return { billedChars: 0, cached: false, firstChunkMs: null, bytes: 0, transport: "http" };
            }
            let httpBilled = 0;
            try {
              for (const piece of splitForSpeech(fallbackText)) {
                const spoken = await synthesizeDeepSeek(row.base_url, apiKey, {
                  text: piece,
                  voice,
                  signal: runSignal,
                  timeoutMs: row.timeout_ms,
                  onChunk: (chunk) => {
                    if (firstChunkMs === null) firstChunkMs = now() - started;
                    totalBytes += chunk.length;
                    onChunk(chunk);
                  },
                });
                httpBilled += spoken.billedChars;
              }
              recordServiceUse(app, { connectionId: row.id, service: "speech", task, unit: "char", quantity: httpBilled, status: "ok" });
              return { billedChars: httpBilled, cached: false, firstChunkMs, bytes: totalBytes, transport: "http" };
            } catch (httpError) {
              const httpPluginOff = providerAbortReason(access.signal);
              if (httpPluginOff || !signal.aborted || httpBilled > 0) {
                const cause = httpPluginOff ?? httpError;
                recordServiceUse(app, {
                  connectionId: row.id,
                  service: "speech",
                  task,
                  unit: "char",
                  quantity: httpBilled,
                  status: "error",
                  errorCode: cause instanceof MangaError ? cause.code : signal.aborted ? "CANCELLED" : "UNKNOWN",
                });
              }
              throw httpPluginOff ?? httpError;
            }
          }
          if (pluginOff || !signal.aborted) {
            const cause = pluginOff ?? wsError;
            recordServiceUse(app, {
              connectionId: row.id,
              service: "speech",
              task,
              unit: "char",
              quantity: 0,
              status: "error",
              errorCode: cause instanceof MangaError ? cause.code : signal.aborted ? "CANCELLED" : "UNKNOWN",
            });
          }
          throw pluginOff ?? wsError;
        } finally {
          releaseOnce();
        }
      },
      abort() {
        finished = true;
        ws.abort();
        releaseOnce();
      },
    };
  }

  private fromCache(key: string): Buffer | undefined {
    this.expire();
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    // Most recently used last, so the oldest goes first when room is needed.
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.pcm;
  }

  private remember(key: string, pcm: Buffer): void {
    if (!pcm.length || pcm.length > CACHE_ENTRY_BYTES) return;
    const old = this.cache.get(key);
    if (old) { this.cache.delete(key); this.cachedBytes -= old.pcm.length; }
    this.cache.set(key, { pcm, at: this.now() });
    this.cachedBytes += pcm.length;
    for (const [oldest, entry] of this.cache) {
      if (this.cachedBytes <= CACHE_TOTAL_BYTES) break;
      this.cache.delete(oldest);
      this.cachedBytes -= entry.pcm.length;
    }
  }

  private expire(): void {
    const now = this.now();
    for (const [key, entry] of this.cache) {
      if (now - entry.at <= CACHE_TTL_MS) continue;
      this.cache.delete(key);
      this.cachedBytes -= entry.pcm.length;
    }
  }

  /** What the cache holds, for the tests and the debug view. */
  cacheState(): { entries: number; bytes: number } {
    this.expire();
    return { entries: this.cache.size, bytes: this.cachedBytes };
  }
}
