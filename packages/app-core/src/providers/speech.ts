import { createHash } from "node:crypto";
import { MangaError } from "@manga/contracts";
import { speechBilledChars, synthesizeDeepSeek, DEEPSEEK_TTS_LIMITS } from "@manga/model-protocol";
import type { ConnectionRow } from "../product-helpers.ts";
import { connectionAccess, providerAbortReason, providerOf, type ProviderAccessHost } from "./access.ts";
import { recordServiceUse } from "./usage.ts";

/** The voices of DeepSeek's speech (计划 4.7): `stella` (女声, the default) and `tide` (男声). */
export const SPEECH_VOICES = ["stella", "tide"] as const;
export type SpeechVoice = (typeof SPEECH_VOICES)[number];

/** What the speech service is asked: the text, and which connection and voice speak it; `task` is what the use is recorded under. */
export type SpeakRequest = { text: string; connectionId?: string | null; voice?: string | null; task?: "read-aloud" | "novel" | "test" };
export type SpeakResult = { billedChars: number; cached: boolean; firstChunkMs: number | null; bytes: number };

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

type Cached = { pcm: Buffer; at: number };

/**
 * Speech from a provider's speech service (计划 4.7, 4.8): the PCM is handed on as it arrives; nothing is written to disk. The same text in the same voice
 * within 10 minutes is answered from memory and not billed again (Q-41 第 15 项). A connection whose plugin is off makes no request, and one turned off
 * while it speaks is cut short.
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
    const text = request.text.trim();
    if (!text) throw new MangaError("VALIDATION_ERROR", "nothing to read aloud");
    const row = this.connection(request.connectionId);
    if (!row) throw new MangaError("MODEL_CAPABILITY_MISSING", "没有配置语音合成：在“设置 › 模型”里从 DeepSeek 加入“语音合成”", { details: { reason: "no_speech_service" } });
    const voice = SPEECH_VOICES.includes((request.voice ?? this.settings().voice) as SpeechVoice) ? (request.voice ?? this.settings().voice) : "stella";
    const key = createHash("sha256").update(`${row.id}\u0000${voice}\u0000${text}`).digest("hex");
    const started = this.now();
    // A connection whose plugin is off does not read aloud, not even from memory (计划 4.1).
    const verifiedProvider = await providerOf(this.app, row);
    const hit = this.fromCache(key);
    if (hit) {
      onChunk(hit);
      return { billedChars: 0, cached: true, firstChunkMs: this.now() - started, bytes: hit.length };
    }
    const access = await connectionAccess(this.app, row, signal, verifiedProvider);
    let billed = 0;
    let firstChunkMs: number | null = null;
    const kept: Buffer[] = [];
    let keptBytes = 0;
    let totalBytes = 0;
    let cacheable = true;
    try {
      if (!access.apiKey) throw new MangaError("AUTHENTICATION_FAILED", "the speech connection has no key");
      for (const piece of splitForSpeech(text)) {
        const spoken = await synthesizeDeepSeek(row.base_url, access.apiKey, {
          text: piece, voice, signal: access.signal ?? signal, timeoutMs: row.timeout_ms,
          onChunk: (chunk) => {
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
          },
        });
        billed += spoken.billedChars;
      }
      recordServiceUse(this.app, { connectionId: row.id, service: "speech", task: request.task ?? "read-aloud", unit: "char", quantity: billed, status: "ok" });
      if (cacheable && keptBytes > 0) this.remember(key, Buffer.concat(kept));
      return { billedChars: billed, cached: false, firstChunkMs, bytes: totalBytes };
    } catch (error) {
      // What was spoken before the failure or cancel was billed all the same; it is recorded with the failure.
      const pluginOff = providerAbortReason(access.signal);
      // A reading the user stopped before any piece finished is not a failure; partial billed usage or a plugin/service failure is recorded.
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
