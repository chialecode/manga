import { useSyncExternalStore } from "react";
import type { SpeechVoice } from "@manga/contracts";
import workletUrl from "./speech-worklet.ts?worker&url";

/**
 * Reading aloud (计划 4.7, 4.8): one reading at a time, of an answer or of a novel's paragraphs. Each paragraph is one request to the speech service; the
 * next is asked for as soon as the one before has all arrived, so there is no wait between them. When WebSocket streaming TTS is available on the host
 * bridge and requested (`streaming: true`), paragraphs flow over a single continuous stream. The PCM is played as it arrives and nothing is kept on disk.
 * Dictation and recording pause a reading; it does not go on by itself.
 */

export type SpeechMessage = { id: string; kind: "chunk" | "end" | "error"; pcm?: Uint8Array; result?: unknown; error?: SpeechFailure };
export type SpeechFailure = { code: string; message: string; retryable?: boolean; details?: Record<string, unknown> };
export type SpeechRequest = { text: string; voice?: string; connectionId?: string; task?: "read-aloud" | "novel" | "test"; streaming?: boolean };

/** How the requests leave the page: by default the main process (`window.manga.speak`). */
export type SpeechTransport = {
  speak(id: string, request: SpeechRequest): void;
  stop(id: string): void;
  onSpeech(listener: (message: SpeechMessage) => void): () => void;
  streamStart?(id: string, request: { voice?: SpeechVoice; connectionId?: string; task?: "read-aloud" | "novel" | "test" }): void;
  streamPush?(id: string, request: { text: string }): void;
  streamFinish?(id: string): void;
  streamStop?(id: string): void;
};

/** Where the samples are played: by default an AudioWorklet at 24 kHz. `onProgress` says how many samples of the current generation have been heard. */
export type SpeechSink = {
  open(): Promise<void>;
  push(pcm: Int16Array): void;
  pause(): void;
  resume(): void;
  /** Suspends audio output when idle so the AudioWorklet thread does not spin unused. */
  suspend?(): void;
  /** Drops what waits and starts counting again from 0 under a new generation. */
  clear(generation: number): void;
  onProgress(listener: (generation: number, played: number, empty: boolean) => void): void;
};

export type ReadAloudStatus = "idle" | "loading" | "playing" | "paused" | "error";
export type ReadAloudState = {
  status: ReadAloudStatus;
  /** Who is reading: an answer's id, or `novel:<itemId>`. */
  owner: string | null;
  /** The paragraph being heard. */
  segment: number;
  count: number;
  error: SpeechFailure | null;
};

export type ReadAloudOptions = {
  owner: string;
  segments: string[];
  start?: number;
  task?: SpeechRequest["task"];
  voice?: string;
  connectionId?: string;
  streaming?: boolean;
  /** Told when another paragraph starts to be heard. */
  onSegment?: (index: number) => void;
  /** Told once when the reading ends: it was finished, stopped (with the paragraph that was being heard) or failed. */
  onEnd?: (reason: "done" | "stopped" | "error", segment: number) => void;
};

/** How the reading went, for the benchmarks (计划 T1): from the request to the first sound, and the silences between paragraphs. */
export type ReadAloudStats = { firstAudioMs: number | null; gapsMs: number[] };

/** Strips Markdown syntax, code fences, inline citations, and raw URLs before splitting into speech segments. */
export function stripMarkdownForSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/~~~[\s\S]*?~~~/g, "\n")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\[citation:\d+\]/gi, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[-*_]{3,}\s*$/gm, "")
    .replace(/\|/g, " ")
    .replace(/(\*\*|__|~~|\*|_)/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const VOICE_STORAGE_KEY = "manga.readAloud.voice";
const voiceListeners = new Set<() => void>();
let preferredVoice: SpeechVoice = (() => {
  try {
    const saved = typeof window !== "undefined" ? window.localStorage.getItem(VOICE_STORAGE_KEY) : null;
    return saved === "tide" ? "tide" : "stella";
  } catch {
    return "stella";
  }
})();

export function setReadAloudVoice(voice: SpeechVoice): void {
  if (preferredVoice === voice) return;
  preferredVoice = voice;
  try { window.localStorage.setItem(VOICE_STORAGE_KEY, voice); } catch { /* ignore */ }
  for (const listener of [...voiceListeners]) listener();
}

export function getReadAloudVoice(): SpeechVoice {
  return preferredVoice;
}

export function useReadAloudVoice(): SpeechVoice {
  return useSyncExternalStore(
    (listener) => {
      voiceListeners.add(listener);
      return () => { voiceListeners.delete(listener); };
    },
    getReadAloudVoice,
    getReadAloudVoice,
  );
}

/** The timings of a reading, told to the page as a window event, for the walkthroughs and the benchmarks to read (计划 T1); nothing else listens. */
function announce(detail: { kind: "first-audio" | "gap" | "end"; ms: number; owner: string; reason?: string; segment?: number; played?: number; pushed?: number }): void {
  if (typeof window !== "undefined" && typeof CustomEvent === "function") window.dispatchEvent(new CustomEvent("manga-read-aloud", { detail: { ...detail, at: Math.round(performance.now()) } }));
}

const IDLE: ReadAloudState = { status: "idle", owner: null, segment: 0, count: 0, error: null };
/** Keep at most 2 paragraphs ahead of the currently heard segment and at most 30 s of unplayed 24 kHz PCM buffered. */
const MAX_PREFETCH_AHEAD = 2;
const MAX_BUFFERED_SAMPLES = 30 * 24_000;

type Pending = { id: string; chunks: Int16Array[]; done: boolean; error: SpeechFailure | null; isStream?: boolean };

export class ReadAloudController {
  private state: ReadAloudState = IDLE;
  private readonly listeners = new Set<() => void>();
  private options: ReadAloudOptions | null = null;
  private generation = 0;
  private pending = new Map<number, Pending>();
  private byId = new Map<string, number>();
  /** The paragraph whose samples are being handed to the sink, and where each handed paragraph ends, in samples. */
  private feeding = 0;
  private nextToRequest = 0;
  private pushed = 0;
  private ends: number[] = [];
  private played = 0;
  private startedAt = 0;
  private gapFrom: number | null = null;
  private atBoundary = false;
  private stats: ReadAloudStats = { firstAudioMs: null, gapsMs: [] };
  private sinkOpened: Promise<void> | null = null;
  private sinkReady = false;
  private unsubscribe: (() => void) | null = null;
  private counter = 0;

  private readonly transportOf: () => SpeechTransport | null;
  private readonly sinkOf: () => SpeechSink;
  private readonly now: () => number;

  constructor(transportOf: () => SpeechTransport | null, sinkOf: () => SpeechSink, now: () => number = () => performance.now()) {
    this.transportOf = transportOf;
    this.sinkOf = sinkOf;
    this.now = now;
  }

  getState = (): ReadAloudState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  lastStats(): ReadAloudStats { return { firstAudioMs: this.stats.firstAudioMs, gapsMs: [...this.stats.gapsMs] }; }

  private set(next: Partial<ReadAloudState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  /** Starts a reading; one already under way stops first. */
  async play(options: ReadAloudOptions): Promise<void> {
    const segments = options.segments.map((text) => text.trim());
    const transport = this.transportOf();
    if (this.options) this.finish("stopped");
    if (!transport || !segments.some(Boolean)) return;
    this.options = { ...options, segments };
    this.generation += 1;
    const myGen = this.generation;
    const start = Math.max(0, Math.min(options.start ?? 0, segments.length - 1));
    this.pending = new Map();
    this.byId = new Map();
    this.feeding = start;
    this.nextToRequest = start;
    this.pushed = 0;
    this.played = 0;
    this.ends = [];
    this.ends[start - 1] = 0;
    this.gapFrom = null;
    this.atBoundary = false;
    this.stats = { firstAudioMs: null, gapsMs: [] };
    this.startedAt = this.now();
    this.set({ status: "loading", owner: options.owner, segment: start, count: segments.length, error: null });
    const sink = this.sinkOf();
    if (!this.sinkOpened) {
      this.sinkReady = false;
      this.sinkOpened = sink.open().then(() => { this.sinkReady = true; });
      sink.onProgress((generation, played, empty) => this.progress(generation, played, empty));
    }
    this.unsubscribe ??= transport.onSpeech((message) => this.message(message));
    sink.clear(this.generation);

    // Prefer continuous WebSocket streaming TTS when requested and exposed on the preload bridge.
    const canStream = Boolean(options.streaming && transport.streamStart && transport.streamPush && transport.streamFinish);
    if (canStream) {
      this.startStreaming(start);
    } else {
      this.request(start);
    }

    try {
      await this.sinkOpened;
    } catch (error) {
      this.sinkOpened = null;
      this.sinkReady = false;
      if (this.generation === myGen && this.options) {
        this.fail({ code: "AUDIO_UNAVAILABLE", message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (this.generation !== myGen || !this.options) return;
    if (this.state.status === "paused") sink.pause();
    else sink.resume();
    this.feed();
  }

  private startStreaming(start: number): void {
    const options = this.options;
    const transport = this.transportOf();
    if (!options || !transport?.streamStart || !transport.streamPush || !transport.streamFinish) return;
    this.counter += 1;
    const id = `speech-ws-${this.generation}-${this.counter}`;
    const entry: Pending = { id, chunks: [], done: false, error: null, isStream: true };
    this.pending.set(start, entry);
    this.byId.set(id, start);
    this.nextToRequest = options.segments.length;
    const voice = options.voice === "tide" || options.voice === "stella" ? options.voice : undefined;
    transport.streamStart(id, {
      task: options.task ?? "read-aloud",
      ...(voice ? { voice } : {}),
      ...(options.connectionId ? { connectionId: options.connectionId } : {}),
    });
    for (let i = start; i < options.segments.length; i += 1) {
      const seg = options.segments[i];
      if (seg) transport.streamPush(id, { text: `${seg}\n` });
    }
    transport.streamFinish(id);
  }

  pause(): void {
    if (this.state.status !== "playing" && this.state.status !== "loading") return;
    this.sinkOf().pause();
    this.set({ status: "paused" });
  }

  resume(): void {
    if (this.state.status !== "paused") return;
    this.sinkOf().resume();
    this.set({ status: this.played < this.pushed ? "playing" : "loading" });
    this.maybePrefetch();
  }

  stop(): void {
    if (this.options) this.finish("stopped");
    else if (this.state.status === "error") this.set(IDLE);
  }

  /** Dictation or a recording starts: the reading pauses and waits to be continued by hand. */
  pauseForCapture(): void { this.pause(); }

  private request(index: number): void {
    const options = this.options;
    const transport = this.transportOf();
    if (!options || !transport || index >= options.segments.length || this.pending.has(index)) return;
    if (index >= this.nextToRequest) this.nextToRequest = index + 1;
    const text = options.segments[index]!;
    this.counter += 1;
    const id = `speech-${this.generation}-${index}-${this.counter}`;
    const entry: Pending = { id, chunks: [], done: false, error: null };
    this.pending.set(index, entry);
    this.byId.set(id, index);
    // An empty paragraph has nothing to say: it is passed over at once.
    if (!text) { entry.done = true; queueMicrotask(() => this.feed()); return; }
    transport.speak(id, {
      text,
      task: options.task ?? "read-aloud",
      ...(options.voice ? { voice: options.voice } : {}),
      ...(options.connectionId ? { connectionId: options.connectionId } : {}),
      ...(options.streaming ? { streaming: true } : {}),
    });
  }

  /** Requests at most one next paragraph when playing, the prior paragraph finished arriving, and lookahead/buffer caps allow it. */
  private maybePrefetch(): void {
    const options = this.options;
    if (!options || this.state.status === "paused") return;
    const nextIdx = Math.max(this.feeding, this.nextToRequest);
    if (nextIdx >= options.segments.length) return;
    if (this.byId.size > 0) return;
    const buffered = Math.max(0, this.pushed - this.played);
    if (nextIdx > this.state.segment) {
      if (nextIdx - this.state.segment > MAX_PREFETCH_AHEAD) return;
      if (buffered >= MAX_BUFFERED_SAMPLES) return;
    } else if (buffered >= MAX_BUFFERED_SAMPLES) {
      return;
    }
    this.request(nextIdx);
  }

  private message(message: SpeechMessage): void {
    const index = this.byId.get(message.id);
    if (index === undefined) return;
    const entry = this.pending.get(index);
    if (!entry) return;
    if (message.kind === "chunk" && message.pcm?.byteLength) {
      const bytes = message.pcm;
      const copy = new Int16Array(bytes.byteLength >> 1);
      new Uint8Array(copy.buffer).set(bytes.subarray(0, copy.length * 2));
      entry.chunks.push(copy);
    } else if (message.kind === "end") {
      entry.done = true;
      this.byId.delete(message.id);
      this.maybePrefetch();
    } else if (message.kind === "error") {
      entry.done = true;
      entry.error = message.error ?? { code: "UNKNOWN", message: "" };
      this.byId.delete(message.id);
    }
    this.feed();
  }

  /** Hands the sink what has arrived, in order, and moves on to the next paragraph once the one being fed has all arrived. */
  private feed(): void {
    const options = this.options;
    if (!options || !this.sinkReady) return;
    const sink = this.sinkOf();
    while (true) {
      const entry = this.pending.get(this.feeding);
      if (!entry) { this.maybePrefetch(); return; }
      for (const chunk of entry.chunks.splice(0)) {
        if (this.stats.firstAudioMs === null) { this.stats.firstAudioMs = this.now() - this.startedAt; announce({ kind: "first-audio", ms: this.stats.firstAudioMs, owner: options.owner }); }
        // Each paragraph after the first is a boundary: the silence before it is 0 when it came before the one before had been heard, and the time the
        // sink stood empty otherwise. A silence inside a paragraph is counted too.
        if (this.atBoundary || this.gapFrom !== null) {
          const gap = this.gapFrom !== null ? this.now() - this.gapFrom : 0;
          this.stats.gapsMs.push(gap);
          this.gapFrom = null;
          this.atBoundary = false;
          announce({ kind: "gap", ms: gap, owner: options.owner });
        }
        // Counted before it is handed over: the sink may transfer the buffer, which leaves the array empty here.
        this.pushed += chunk.length;
        sink.push(chunk);
        if (this.state.status === "loading") this.set({ status: "playing" });
      }
      if (entry.error) { this.fail(entry.error); return; }
      if (!entry.done) return;
      this.ends[this.feeding] = this.pushed;
      this.pending.delete(this.feeding);
      if (entry.isStream) {
        this.feeding = options.segments.length;
      } else {
        this.feeding += 1;
        this.atBoundary = true;
      }
      if (this.feeding >= options.segments.length) { this.progress(this.generation, this.played, this.played >= this.pushed); return; }
      this.maybePrefetch();
    }
  }

  private progress(generation: number, played: number, empty: boolean): void {
    const options = this.options;
    if (!options || generation !== this.generation) return;
    this.played = played;
    let segment = this.state.segment;
    while (segment < this.feeding && this.ends[segment] !== undefined && played >= this.ends[segment]! && segment + 1 < options.segments.length) segment += 1;
    if (segment !== this.state.segment) {
      this.set({ segment });
      options.onSegment?.(segment);
    }
    if (this.feeding >= options.segments.length && played >= this.pushed) { this.finish("done"); return; }
    this.maybePrefetch();
    // Everything handed over has been heard and the next paragraph is not there yet: the silence is measured until it is.
    if (empty && played >= this.pushed && this.gapFrom === null && this.stats.firstAudioMs !== null && this.state.status === "playing") {
      this.gapFrom = this.now();
      this.set({ status: "loading" });
    }
  }

  private fail(error: SpeechFailure): void {
    const options = this.options;
    this.cancelAll();
    this.options = null;
    this.set({ status: "error", error });
    if (options) announce({ kind: "end", ms: this.now() - this.startedAt, owner: options.owner, reason: "error", segment: this.state.segment });
    options?.onEnd?.("error", this.state.segment);
  }

  private finish(reason: "done" | "stopped"): void {
    const options = this.options;
    const segment = this.state.segment;
    this.cancelAll();
    this.options = null;
    this.set({ ...IDLE });
    if (options) announce({ kind: "end", ms: this.now() - this.startedAt, owner: options.owner, reason, segment, played: this.played, pushed: this.pushed });
    options?.onEnd?.(reason, segment);
  }

  private cancelAll(): void {
    const transport = this.transportOf();
    for (const entry of this.pending.values()) {
      if (!entry.done) {
        if (entry.isStream && transport?.streamStop) transport.streamStop(entry.id);
        else transport?.stop(entry.id);
      }
    }
    this.pending = new Map();
    this.byId = new Map();
    this.generation += 1;
    const sink = this.sinkOf();
    sink.clear(this.generation);
    sink.suspend?.();
  }
}

/** The sink of the application: an AudioContext at 24 kHz with the playback worklet, made on the first reading. */
export function createWorkletSink(): SpeechSink {
  let node: AudioWorkletNode | null = null;
  let context: AudioContext | null = null;
  let progress: (generation: number, played: number, empty: boolean) => void = () => undefined;
  let generation = 0;
  const post = (message: unknown, transfer: Transferable[] = []) => node?.port.postMessage(message, transfer);
  return {
    async open() {
      const ctx = new AudioContext({ sampleRate: 24_000 });
      try {
        await ctx.audioWorklet.addModule(workletUrl);
        const worklet = new AudioWorkletNode(ctx, "manga-speech", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
        worklet.connect(ctx.destination);
        worklet.port.onmessage = (event: MessageEvent<{ played: number; empty: boolean; generation: number }>) => {
          if (event.data.generation === generation) progress(generation, event.data.played, event.data.empty);
        };
        context = ctx;
        node = worklet;
        post({ type: "clear", generation });
      } catch (error) {
        void ctx.close().catch(() => {});
        throw error;
      }
    },
    push(pcm) { post({ type: "push", pcm: pcm.buffer }, [pcm.buffer]); },
    pause() { post({ type: "pause" }); void context?.suspend(); },
    resume() { post({ type: "resume" }); void context?.resume(); },
    suspend() { post({ type: "pause" }); void context?.suspend(); },
    clear(next) { generation = next; post({ type: "clear", generation: next }); },
    onProgress(listener) { progress = listener; },
  };
}

function hostTransport(): SpeechTransport | null {
  const host = (globalThis as {
    manga?: {
      speak?: SpeechTransport["speak"];
      stopSpeaking?: SpeechTransport["stop"];
      onSpeech?: SpeechTransport["onSpeech"];
      speechStreamStart?: SpeechTransport["streamStart"];
      speechStreamPush?: SpeechTransport["streamPush"];
      speechStreamFinish?: SpeechTransport["streamFinish"];
      speechStreamStop?: SpeechTransport["streamStop"];
    };
  }).manga;
  if (!host?.speak || !host.stopSpeaking || !host.onSpeech) return null;
  return {
    speak: (id, request) => host.speak!(id, request),
    stop: (id) => host.stopSpeaking!(id),
    onSpeech: (listener) => host.onSpeech!(listener),
    ...(host.speechStreamStart ? { streamStart: (id, req) => host.speechStreamStart!(id, req) } : {}),
    ...(host.speechStreamPush ? { streamPush: (id, req) => host.speechStreamPush!(id, req) } : {}),
    ...(host.speechStreamFinish ? { streamFinish: (id) => host.speechStreamFinish!(id) } : {}),
    ...(host.speechStreamStop ? { streamStop: (id) => host.speechStreamStop!(id) } : {}),
  };
}

let sink: SpeechSink | null = null;
/** The one reading of the window. */
export const readAloud = new ReadAloudController(hostTransport, () => (sink ??= createWorkletSink()));

export function useReadAloud(): ReadAloudState {
  return useSyncExternalStore(readAloud.subscribe, readAloud.getState, readAloud.getState);
}

/** What the failure of a reading says (计划 4.7): the key of the message and whether trying again can help. */
export function readAloudProblem(error: SpeechFailure | null): { key: string; retry: boolean } | null {
  if (!error) return null;
  const reason = (error.details as { reason?: unknown; kind?: unknown } | undefined) ?? {};
  if (reason.kind === "truncated") return { key: "readAloud.error.truncated", retry: true };
  if (reason.reason === "no_speech_service") return { key: "readAloud.error.noService", retry: false };
  if (reason.reason === "plugin_disabled") return { key: "readAloud.error.pluginOff", retry: false };
  if (error.code === "AUTHENTICATION_FAILED") return { key: "readAloud.error.key", retry: false };
  if (error.code === "QUOTA_EXCEEDED" || reason.kind === "billing") return { key: "readAloud.error.billing", retry: false };
  if (error.code === "AUDIO_UNAVAILABLE") return { key: "readAloud.error.audio", retry: true };
  return { key: "readAloud.error.other", retry: true };
}
