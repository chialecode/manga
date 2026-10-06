import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { MangaError, createId } from "@manga/contracts";
import { DrizzleStore } from "@manga/storage-drizzle";
import type { TranscriptionResult } from "@manga/model-protocol";
import { MediaServices } from "../../packages/app-core/src/media/services.ts";
import { CaptureService, type CaptureDeps } from "../../packages/app-core/src/voice/capture.ts";
import type { AsrConnection, AsrPort, LlmConnection, LlmPort } from "../../packages/app-core/src/voice/ports.ts";
import type { VadEngine, VadStream } from "../../packages/app-core/src/voice/vad-client.ts";
import { VAD_FRAME_SAMPLES } from "../../packages/app-core/src/voice/vad-segmenter.ts";

// ------------------------------------------------------------------ audio

/** Synthetic audio: a steady tone stands for speech, near-silence for the quiet around it. */
export const SPEECH_AMPLITUDE = 9000;
export const samplesFor = (ms: number) => Math.round((ms * 16_000) / 1000);

export function tone(ms: number, amplitude = SPEECH_AMPLITUDE, hz = 220): Int16Array {
  const out = new Int16Array(samplesFor(ms));
  for (let i = 0; i < out.length; i += 1) out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / 16_000) * amplitude);
  return out;
}

export function quiet(ms: number): Int16Array {
  const out = new Int16Array(samplesFor(ms));
  let seed = 1;
  for (let i = 0; i < out.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed % 41) - 20;
  }
  return out;
}

export function join(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

export const toBase64 = (samples: Int16Array) => Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");

/** Frame energy as a stand-in for a speech model: loud frames are speech. Deterministic, and fast enough to run on hours of audio. */
export class EnergyVad implements VadEngine {
  available = true;
  unavailableReason: string | undefined;
  opened = 0;
  fullPasses = 0;

  private static probabilities(samples: Int16Array): Float32Array {
    const frames = Math.floor(samples.length / VAD_FRAME_SAMPLES);
    const out = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      let sum = 0;
      for (let i = 0; i < VAD_FRAME_SAMPLES; i += 1) sum += samples[frame * VAD_FRAME_SAMPLES + i]! ** 2;
      out[frame] = Math.sqrt(sum / VAD_FRAME_SAMPLES) > 1500 ? 0.95 : 0.02;
    }
    return out;
  }

  open(): VadStream {
    this.opened += 1;
    let rest = new Int16Array(0);
    return {
      push: async (pcm) => {
        const all = join(rest, pcm);
        const frames = Math.floor(all.length / VAD_FRAME_SAMPLES);
        rest = all.slice(frames * VAD_FRAME_SAMPLES);
        return EnergyVad.probabilities(all.subarray(0, frames * VAD_FRAME_SAMPLES));
      },
      close: () => undefined,
    };
  }

  async analyzeFile(file: string, options: { signal?: AbortSignal } = {}): Promise<Float32Array> {
    this.fullPasses += 1;
    if (options.signal?.aborted) throw new MangaError("CANCELLED", "cancelled");
    const bytes = fs.readFileSync(file);
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.length >> 1);
    return EnergyVad.probabilities(samples);
  }

  dispose(): void {}
}

// ------------------------------------------------------------------ providers

export type AsrCall = { fileName: string; bytes: number; prompt?: string; timestamps?: boolean; at: number };

/** A transcription provider whose answers and failures are scripted. */
export class FakeAsr implements AsrPort {
  connection: AsrConnection | null = { id: "conn-asr", model: "fake-asr", timeoutMs: 5000 };
  calls: AsrCall[] = [];
  /** Text for a block, by its start offset in milliseconds; blocks it has no entry for get a default. */
  text = (startMs: number) => `说话@${startMs}`;
  /** Answer with per-sentence timestamps (in seconds into the block). */
  segmentsFor: ((startMs: number, endMs: number) => TranscriptionResult["segments"]) | null = null;
  /** Throw for the n-th call (0-based) with this error. */
  failures = new Map<number, MangaError>();
  /** Throw for every call whose block starts at one of these offsets. */
  failAlways = new Map<number, MangaError>();
  /** Reject timestamped requests with this HTTP status, as a provider without segment timestamps does. */
  rejectTimestamps: number | null = null;
  delayMs = 0;
  blockOn: Promise<void> | null = null;
  /** Keep working after the request was cancelled, as a remote service does: the answer arrives late. */
  ignoreAbort = false;
  empty = new Set<number>();

  resolve(connectionId?: string): AsrConnection | null {
    if (connectionId && this.connection && connectionId !== this.connection.id) return null;
    return this.connection;
  }

  async transcribe(_connection: AsrConnection, request: Parameters<AsrPort["transcribe"]>[1]): Promise<TranscriptionResult> {
    const index = this.calls.length;
    const key = /^c(\d+)-(\d+)/.exec(request.fileName);
    const startMs = key ? Number(key[1]) : 0;
    const endMs = key ? Number(key[2]) : 0;
    this.calls.push({ fileName: request.fileName, bytes: request.bytes.byteLength, prompt: request.prompt, timestamps: request.timestamps, at: Date.now() });
    if (this.blockOn) await (this.ignoreAbort ? this.blockOn : Promise.race([this.blockOn, new Promise<void>((_, reject) => request.signal.addEventListener("abort", () => reject(new MangaError("CANCELLED", "cancelled")), { once: true }))]));
    if (this.delayMs) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, this.delayMs);
      request.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new MangaError("CANCELLED", "cancelled")); }, { once: true });
    });
    if (request.signal.aborted && !this.ignoreAbort) throw new MangaError("CANCELLED", "cancelled");
    if (request.timestamps && this.rejectTimestamps) throw new MangaError("PROVIDER_UNAVAILABLE", `provider HTTP ${this.rejectTimestamps}`, { details: { status: this.rejectTimestamps } });
    const scripted = this.failures.get(index);
    if (scripted) throw scripted;
    const always = this.failAlways.get(startMs);
    if (always) throw always;
    if (this.empty.has(startMs)) return { text: "" };
    const result: TranscriptionResult = { text: this.text(startMs) };
    const segments = request.timestamps && this.segmentsFor ? this.segmentsFor(startMs, endMs) : undefined;
    if (segments?.length) result.segments = segments;
    return result;
  }

  keys(): string[] {
    return this.calls.map((call) => call.fileName.replace(/\.wav$/, ""));
  }
}

export class FakeLlm implements LlmPort {
  connection: LlmConnection | null = { id: "conn-llm" };
  calls: Array<{ system: string; user: string }> = [];
  failNext: MangaError | null = null;
  output = (user: string) => `整理：${user.replace(/\s+/g, " ").slice(0, 200)}`;
  blockOn: Promise<void> | null = null;

  resolve(): LlmConnection | null {
    return this.connection;
  }

  async complete(_connection: LlmConnection, request: { system: string; user: string; signal: AbortSignal }): Promise<string> {
    this.calls.push({ system: request.system, user: request.user });
    if (this.blockOn) await this.blockOn;
    if (this.failNext) { const error = this.failNext; this.failNext = null; throw error; }
    return this.output(request.user);
  }
}

// ------------------------------------------------------------------ harness

export type Notice = { topic: string; payload: Record<string, unknown> };

export function voiceHarness(options: { vad?: VadEngine; deps?: Partial<CaptureDeps>; profileDir?: string } = {}) {
  const dir = options.profileDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "manga-voice-"));
  const store = new DrizzleStore({ profileDir: dir, hostId: `voice-${createId("h")}` });
  const media = new MediaServices({ cacheDir: path.join(dir, "cache") });
  const vad = options.vad ?? new EnergyVad();
  const asr = new FakeAsr();
  const llm = new FakeLlm();
  const notices: Notice[] = [];
  const service = new CaptureService({ store, media, vad, asr, llm, notify: (topic, payload) => notices.push({ topic, payload }), retryBaseMs: 0, ...options.deps });
  let live = true;
  service.bind(() => live);
  return {
    dir, store, media, vad, asr, llm, notices, service,
    /** Turn the module off: work finishing afterwards is dropped. */
    deactivate: () => { live = false; },
    activate: () => { live = true; },
    /** Wait for every background job, including ones they start. */
    async idle() {
      for (let i = 0; i < 6; i += 1) {
        await media.jobs.idle();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    async settle(sessionId: string) {
      for (let i = 0; i < 400; i += 1) {
        await media.jobs.idle();
        if (!service.pipeline.busy(sessionId)) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("the recording did not settle");
    },
    close() {
      media.dispose();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type Harness = ReturnType<typeof voiceHarness>;

/** Feed audio to a recording the way the renderer does: fixed-size chunks with rising sequence numbers. */
export function feed(service: CaptureService, sessionId: string, samples: Int16Array, options: { chunkMs?: number; seqFrom?: number } = {}): number {
  const size = samplesFor(options.chunkMs ?? 100);
  let seq = options.seqFrom ?? 0;
  for (let at = 0; at < samples.length; at += size) {
    service.append(sessionId, seq, toBase64(samples.subarray(at, Math.min(samples.length, at + size))));
    seq += 1;
  }
  return seq;
}

/** A resource with a revision, enough for recordings to point at. */
export function seedResource(store: DrizzleStore, input: { kind?: "novel" | "comic" | "video"; title?: string; workId?: string } = {}) {
  const db = store.sqlite;
  const now = new Date().toISOString();
  const workId = input.workId ?? createId("work");
  const resourceId = createId("res");
  const revisionId = createId("rev");
  if (!input.workId) db.prepare("INSERT INTO works(id,title,created_at,media_kind,updated_at) VALUES (?,?,?,?,?)").run(workId, input.title ?? "测试作品", now, input.kind ?? "novel", now);
  db.prepare("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at, sort_key) VALUES (?,?,?,?,?,?,?)").run(resourceId, workId, input.kind ?? "novel", input.title ?? "测试作品", "[]", now, "");
  db.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)").run(revisionId, resourceId, createHash("sha256").update(resourceId).digest("hex"), "test", "{}", now);
  return { workId, resourceId, revisionId };
}

export const textLocator = (start: number): import("@manga/contracts").SourceLocator => ({
  kind: "text", partId: "p1", representationId: "r1", normalizationVersion: "text-nfc-lf-v1", range: { start, end: start + 20 },
});
