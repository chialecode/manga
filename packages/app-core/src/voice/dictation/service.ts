import {
  type AsrEngineSelection,
  type AudioWarning,
  type ChineseVariant,
  type DictationHistoryItem,
  type DictationMode,
  type DictationReplacement,
  type DictationSessionSnapshot,
  type DictationStopReason,
  type DictationTimings,
  MangaError,
  type PolishMode,
  type PolishPrompts,
  createId,
} from "@manga/contracts";
import { PCM_BYTES_PER_MS, pcmDurationMs } from "../audio-files.ts";
import type { CorrectionOutput } from "../correct/index.ts";
import { isPromptEcho } from "../dictionary.ts";
import { DictationPolisher, type PolishInput, type PolishLlmClient, type PolishResult } from "../polish/index.ts";
import { MAX_DICTATION_DURATION_MS, trimSilence } from "../silence-trimmer.ts";
import type { VadEngine } from "../vad-client.ts";
import type { DictationHistoryService } from "./history.ts";

export { MAX_DICTATION_DURATION_MS };

export type DictationTrimOutput = {
  status: "speech" | "no_speech";
  pcmBuffer: Buffer;
  wavBuffer?: Buffer;
  warnings: AudioWarning[];
  inputDurationMs?: number;
  outputDurationMs?: number;
};

export interface DictationTrimmerPort {
  trim(pcmBuffer: Buffer, options?: { signal?: AbortSignal }): Promise<DictationTrimOutput>;
}

export interface DictationAsrEnginePort {
  transcribe(request: {
    selection: AsrEngineSelection | null | undefined;
    audio: Buffer | Int16Array | Float32Array;
    vocabularyTerms?: readonly string[];
    language?: string;
    gtcrnDenoise?: boolean;
    signal?: AbortSignal;
  }): Promise<{
    text: string;
    engineKind: string;
    engineId: string;
    modelId: string;
    echoDetected?: boolean;
    denoiseMs?: number;
    recognizeMs?: number;
    loadingModel?: boolean;
  }>;
}

export interface DictationCorrectorPort {
  correct(rawText: string, workId: string | null): CorrectionOutput;
  hotwordsFor(workId: string | null, limit?: number): string[];
  activeTermStrings(workId: string | null): string[];
}

export interface DictationPolisherPort {
  polish(input: PolishInput): Promise<PolishResult>;
}

export type DictationRuntimeSettings = {
  dictationEngine: AsrEngineSelection | null;
  polishMode: PolishMode;
  polishPrompts?: PolishPrompts | null;
  polishConnectionId?: string | null;
  chineseVariant: ChineseVariant;
  gtcrnDenoise: boolean;
  retainAudio24h: boolean;
  language: string | null;
};

export const DEFAULT_DICTATION_RUNTIME_SETTINGS: DictationRuntimeSettings = {
  dictationEngine: null,
  polishMode: "light",
  polishPrompts: null,
  polishConnectionId: null,
  chineseVariant: "simplified",
  gtcrnDenoise: false,
  retainAudio24h: false,
  language: null,
};

export function createVadTrimmer(vad: VadEngine): DictationTrimmerPort {
  return {
    async trim(pcmBuffer, options) {
      const res = await trimSilence(pcmBuffer, { vad, signal: options?.signal });
      return {
        status: res.status,
        pcmBuffer: res.pcmBuffer,
        wavBuffer: res.wavBuffer,
        warnings: res.warnings,
        inputDurationMs: res.inputDurationMs,
        outputDurationMs: res.outputDurationMs,
      };
    },
  };
}

type ActiveDictationSession = {
  snapshot: DictationSessionSnapshot;
  generation: number;
  startedAtMs: number;
  nextSeq: number;
  chunks: Buffer[];
  bytes: number;
  stopReason: DictationStopReason | null;
  abortController: AbortController;
  maxDurationTimer: ReturnType<typeof setTimeout> | null;
  stopPromise: Promise<DictationSessionSnapshot> | null;
};

const MAX_CHUNK_BYTES = 2 * 1024 * 1024;

function isCancellationError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof MangaError && error.code === "CANCELLED") return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

export type DictationServiceOptions = {
  trimmer?: DictationTrimmerPort;
  vad?: VadEngine;
  asrEngine: DictationAsrEnginePort;
  corrector: DictationCorrectorPort;
  polisher?: DictationPolisherPort;
  llm?: PolishLlmClient | null;
  history: DictationHistoryService;
  notify: (topic: string, payload: Record<string, unknown>) => void;
  readSettings?: () => Partial<DictationRuntimeSettings>;
  preflight?: (settings: DictationRuntimeSettings) => { loadingModel?: boolean } | void;
  maxDurationMs?: number;
  now?: () => number;
};

/**
 * In-memory voice dictation session coordinator (`recording -> trimming -> recognizing -> correcting -> polishing -> done | no_speech | failed | cancelled`).
 * Separate from `VoiceService` (`capture_sessions`): audio lives strictly in memory unless 24-hour WAV retention is enabled on completion.
 */
export class DictationService {
  private readonly trimmer: DictationTrimmerPort;
  private readonly asrEngine: DictationAsrEnginePort;
  private readonly corrector: DictationCorrectorPort;
  private readonly polisher: DictationPolisherPort;
  readonly history: DictationHistoryService;
  private readonly notify: (topic: string, payload: Record<string, unknown>) => void;
  private readonly readSettingsFn: () => DictationRuntimeSettings;
  private readonly preflight?: (settings: DictationRuntimeSettings) => { loadingModel?: boolean } | void;
  private readonly maxDurationMs: number;
  private readonly now: () => number;

  private activeGuard: () => boolean = () => true;
  private generation = 0;
  private current: ActiveDictationSession | null = null;
  private lastCompleted: DictationSessionSnapshot | null = null;

  constructor(options: DictationServiceOptions) {
    if (options.trimmer) {
      this.trimmer = options.trimmer;
    } else if (options.vad) {
      this.trimmer = createVadTrimmer(options.vad);
    } else {
      throw new MangaError("VALIDATION_ERROR", "DictationService requires either a `trimmer` or a `vad` engine");
    }

    this.asrEngine = options.asrEngine;
    this.corrector = options.corrector;
    this.polisher = options.polisher ?? new DictationPolisher({ llm: options.llm ?? null });
    this.history = options.history;
    this.notify = options.notify;
    this.readSettingsFn = () => ({
      ...DEFAULT_DICTATION_RUNTIME_SETTINGS,
      ...(options.readSettings?.() ?? {}),
    });
    this.preflight = options.preflight;
    this.maxDurationMs = options.maxDurationMs ?? MAX_DICTATION_DURATION_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Binds module-lifecycle guard (`manga.voice`). When `isCurrent()` turns false or `deactivate()` is called,
   * in-flight recognition/polish results from an older generation are dropped without emitting or saving.
   */
  bind(isCurrent: () => boolean): void {
    this.activeGuard = isCurrent;
  }

  /** Bumps the generation token and aborts any active dictation when `manga.voice` is deactivated or closed. */
  deactivate(): void {
    this.generation += 1;
    if (this.current) {
      this.clearMaxTimer(this.current);
      this.current.chunks.length = 0;
      this.current.abortController.abort(new MangaError("CANCELLED", "语音模块已停用"));
      this.current = null;
    }
  }

  close(): void {
    this.deactivate();
    this.history.close();
  }

  private assertModuleActive(): void {
    if (!this.activeGuard()) {
      throw new MangaError("CAPABILITY_UNAVAILABLE", "语音模块当前已停用，无法使用听写");
    }
  }

  private isSessionStale(session: ActiveDictationSession): boolean {
    return !this.activeGuard() || session.generation !== this.generation;
  }

  private clearMaxTimer(session: ActiveDictationSession): void {
    if (session.maxDurationTimer !== null) {
      clearTimeout(session.maxDurationTimer);
      session.maxDurationTimer = null;
    }
  }

  private emit(session: ActiveDictationSession): DictationSessionSnapshot {
    const copy: DictationSessionSnapshot = {
      ...session.snapshot,
      warnings: [...session.snapshot.warnings],
      replacements: session.snapshot.replacements.map((r) => ({ ...r })),
      ...(session.snapshot.timings ? { timings: { ...session.snapshot.timings } } : {}),
    };
    if (!this.isSessionStale(session)) {
      this.notify("dictation.changed", copy as unknown as Record<string, unknown>);
    }
    return copy;
  }

  start(input: {
    mode: DictationMode;
    workId?: string | null;
    contextId?: string;
    sampleRate?: number;
  }): DictationSessionSnapshot {
    this.assertModuleActive();
    const settings = this.readSettingsFn();
    const preflightOut = this.preflight?.(settings);

    // Cancel any previous active session before starting a fresh one.
    if (this.current) {
      this.cancel(this.current.snapshot.dictationId);
    }

    const dictationId = createId("dic_ses");
    const workId = input.workId ?? null;
    const abortController = new AbortController();

    const session: ActiveDictationSession = {
      snapshot: {
        dictationId,
        mode: input.mode,
        stage: "recording",
        loadingModel: Boolean(preflightOut?.loadingModel),
        workId,
        durationMs: 0,
        rawText: "",
        correctedText: "",
        finalText: "",
        polishMode: settings.polishMode,
        fallbackReason: null,
        warnings: [],
        replacements: [],
        errorMessage: null,
        errorCode: null,
        timings: {},
        historyId: null,
      },
      generation: this.generation,
      startedAtMs: this.now(),
      nextSeq: 0,
      chunks: [],
      bytes: 0,
      stopReason: null,
      abortController,
      maxDurationTimer: null,
      stopPromise: null,
    };

    const timer = setTimeout(() => {
      if (this.current === session && session.snapshot.stage === "recording") {
        void this.stop({ dictationId, reason: "max_duration" });
      }
    }, this.maxDurationMs);
    if (typeof timer === "object" && timer !== null && "unref" in timer) {
      timer.unref();
    }
    session.maxDurationTimer = timer;

    this.current = session;
    return this.emit(session);
  }

  append(input: {
    dictationId: string;
    seq: number;
    data: string;
  }): { dictationId: string; stage: string; bytes: number; durationMs: number; autoStopped: boolean } {
    this.assertModuleActive();
    const session = this.current;
    if (!session || session.snapshot.dictationId !== input.dictationId) {
      if (this.lastCompleted?.dictationId === input.dictationId) {
        return {
          dictationId: input.dictationId,
          stage: this.lastCompleted.stage,
          bytes: 0,
          durationMs: this.lastCompleted.durationMs,
          autoStopped: true,
        };
      }
      throw new MangaError("NOT_FOUND", "听写会话不存在或已结束");
    }

    if (session.snapshot.stage !== "recording") {
      return {
        dictationId: input.dictationId,
        stage: session.snapshot.stage,
        bytes: session.bytes,
        durationMs: session.snapshot.durationMs,
        autoStopped: session.stopReason === "max_duration",
      };
    }

    if (input.seq < session.nextSeq) {
      return {
        dictationId: input.dictationId,
        stage: session.snapshot.stage,
        bytes: session.bytes,
        durationMs: session.snapshot.durationMs,
        autoStopped: false,
      };
    }

    const decoded = Buffer.from(input.data, "base64");
    if (decoded.byteLength === 0 || decoded.byteLength % 2 !== 0 || decoded.byteLength > MAX_CHUNK_BYTES) {
      throw new MangaError("VALIDATION_ERROR", "听写音频块必须是 16-bit PCM 数据");
    }

    const maxBytes = Math.max(2, Math.floor(this.maxDurationMs * PCM_BYTES_PER_MS) & ~1);
    const remaining = Math.max(0, maxBytes - session.bytes);
    const slice = decoded.byteLength > remaining ? decoded.subarray(0, remaining & ~1) : decoded;
    if (slice.byteLength > 0) {
      session.chunks.push(slice);
      session.bytes += slice.byteLength;
      session.snapshot.durationMs = pcmDurationMs(session.bytes);
    }
    session.nextSeq = input.seq + 1;

    if (session.bytes >= maxBytes) {
      void this.stop({ dictationId: input.dictationId, reason: "max_duration" });
      return {
        dictationId: input.dictationId,
        stage: session.snapshot.stage,
        bytes: session.bytes,
        durationMs: session.snapshot.durationMs,
        autoStopped: true,
      };
    }

    return {
      dictationId: input.dictationId,
      stage: session.snapshot.stage,
      bytes: session.bytes,
      durationMs: session.snapshot.durationMs,
      autoStopped: false,
    };
  }

  async stop(input: { dictationId: string; reason?: DictationStopReason }): Promise<DictationSessionSnapshot> {
    this.assertModuleActive();
    const session = this.current;
    if (!session || session.snapshot.dictationId !== input.dictationId) {
      if (this.lastCompleted?.dictationId === input.dictationId) {
        return { ...this.lastCompleted };
      }
      throw new MangaError("NOT_FOUND", "听写会话不存在或已结束");
    }

    if (session.stopPromise) {
      return session.stopPromise;
    }

    session.stopReason = input.reason ?? "user";
    this.clearMaxTimer(session);
    session.stopPromise = this.runPipeline(session);
    return session.stopPromise;
  }

  cancel(dictationId?: string): DictationSessionSnapshot | { cancelled: false } {
    const session = this.current;
    if (!session) return { cancelled: false };
    if (dictationId && session.snapshot.dictationId !== dictationId) {
      return { cancelled: false };
    }

    this.clearMaxTimer(session);
    session.chunks.length = 0;
    session.abortController.abort(new MangaError("CANCELLED", "听写已取消"));
    session.snapshot.stage = "cancelled";
    session.snapshot.loadingModel = false;
    const snap = this.emit(session);
    this.lastCompleted = snap;
    if (this.current === session) {
      this.current = null;
    }
    return snap;
  }

  status(dictationId?: string): DictationSessionSnapshot | null {
    if (this.current && (!dictationId || this.current.snapshot.dictationId === dictationId)) {
      return {
        ...this.current.snapshot,
        warnings: [...this.current.snapshot.warnings],
        replacements: this.current.snapshot.replacements.map((r) => ({ ...r })),
      };
    }
    if (dictationId && this.lastCompleted?.dictationId === dictationId) {
      return { ...this.lastCompleted };
    }
    return this.current ? { ...this.current.snapshot } : this.lastCompleted ? { ...this.lastCompleted } : null;
  }

  /**
   * Re-transcribes a retained 24-hour WAV history entry using a different `AsrEngineSelection`,
   * running the full stage-2 phonetic correction and stage-3 polish + OpenCC pipeline.
   */
  async retranscribeHistory(historyId: string, engine: AsrEngineSelection): Promise<DictationHistoryItem> {
    this.assertModuleActive();
    const settings = this.readSettingsFn();

    return this.history.retranscribe(historyId, engine, async ({ pcm16le, workId, polishMode }) => {
      const pipelineStart = this.now();
      const vocabularyTerms = this.corrector.hotwordsFor(workId);
      const recStart = this.now();
      const asrOut = await this.asrEngine.transcribe({
        selection: engine,
        audio: pcm16le,
        vocabularyTerms,
        language: settings.language ?? undefined,
        gtcrnDenoise: settings.gtcrnDenoise,
      });
      const recognizeMs = asrOut.recognizeMs ?? Math.max(0, this.now() - recStart);

      if (asrOut.echoDetected || !asrOut.text.trim() || isPromptEcho(asrOut.text, vocabularyTerms)) {
        throw new MangaError("VALIDATION_ERROR", "重新识别未检出有效语音内容", {
          details: { reason: "no_speech" },
        });
      }

      const rawText = asrOut.text.trim();
      const corr = this.corrector.correct(rawText, workId);
      const polishOut = await this.polisher.polish({
        correctedText: corr.correctedText,
        mode: polishMode,
        chineseVariant: settings.chineseVariant,
        candidates: corr.candidates,
        dictionaryTerms: this.corrector.activeTermStrings(workId),
        customPrompts: settings.polishPrompts,
        preferredConnectionId: settings.polishConnectionId,
      });

      const timings: DictationTimings = {
        ...(asrOut.denoiseMs !== undefined ? { denoiseMs: Math.round(asrOut.denoiseMs) } : {}),
        recognizeMs: Math.round(recognizeMs),
        correctMs: Number(corr.elapsedMs.toFixed(2)),
        polishMs: Number(polishOut.elapsedMs.toFixed(2)),
        totalMs: Math.max(0, this.now() - pipelineStart),
      };

      return {
        engineKind: asrOut.engineKind,
        engineId: asrOut.engineId,
        modelId: asrOut.modelId,
        rawText,
        correctedText: corr.correctedText,
        finalText: polishOut.finalText,
        fallbackReason: polishOut.fallbackReason,
        timings,
        replacements: corr.replacements,
      };
    });
  }

  private finalizeSession(session: ActiveDictationSession): DictationSessionSnapshot {
    const snap = this.emit(session);
    if (!this.isSessionStale(session)) {
      this.lastCompleted = snap;
    }
    if (this.current === session) {
      this.current = null;
    }
    return snap;
  }

  private async runPipeline(session: ActiveDictationSession): Promise<DictationSessionSnapshot> {
    const pipelineStartMs = this.now();
    const signal = session.abortController.signal;
    const rawPcm = session.chunks.length > 0 ? Buffer.concat(session.chunks, session.bytes) : Buffer.alloc(0);
    session.chunks.length = 0;

    const recordMs = Math.max(session.snapshot.durationMs, Math.max(0, pipelineStartMs - session.startedAtMs));
    const timings: DictationTimings = { recordMs };
    session.snapshot.timings = timings;

    try {
      // 1. Trimming stage
      session.snapshot.stage = "trimming";
      this.emit(session);

      if (rawPcm.byteLength < 2) {
        timings.trimMs = 0;
        timings.totalMs = Math.max(0, this.now() - pipelineStartMs);
        session.snapshot.stage = "no_speech";
        session.snapshot.errorMessage = "没有听到声音";
        return this.finalizeSession(session);
      }

      const trimStart = this.now();
      const trimmed = await this.trimmer.trim(rawPcm, { signal });
      timings.trimMs = Math.max(0, this.now() - trimStart);

      if (this.isSessionStale(session)) return { ...session.snapshot };
      if (signal.aborted) {
        session.snapshot.stage = "cancelled";
        return this.finalizeSession(session);
      }

      session.snapshot.warnings = [...trimmed.warnings];
      if (trimmed.status === "no_speech" || trimmed.pcmBuffer.byteLength < 2) {
        timings.totalMs = Math.max(0, this.now() - pipelineStartMs);
        session.snapshot.stage = "no_speech";
        session.snapshot.errorMessage = "没有听到声音";
        return this.finalizeSession(session);
      }

      // 2. Recognizing stage
      const settings = this.readSettingsFn();
      session.snapshot.polishMode = settings.polishMode;
      session.snapshot.stage = "recognizing";
      this.emit(session);

      const workId = session.snapshot.workId;
      const vocabularyTerms = this.corrector.hotwordsFor(workId);
      const recStart = this.now();
      const asrOut = await this.asrEngine.transcribe({
        selection: settings.dictationEngine,
        audio: trimmed.pcmBuffer,
        vocabularyTerms,
        language: settings.language ?? undefined,
        gtcrnDenoise: settings.gtcrnDenoise,
        signal,
      });
      timings.recognizeMs = asrOut.recognizeMs ?? Math.max(0, this.now() - recStart);
      if (asrOut.denoiseMs !== undefined) {
        timings.denoiseMs = Math.round(asrOut.denoiseMs);
      }
      session.snapshot.loadingModel = Boolean(asrOut.loadingModel);

      if (this.isSessionStale(session)) return { ...session.snapshot };
      if (signal.aborted) {
        session.snapshot.stage = "cancelled";
        return this.finalizeSession(session);
      }

      const trimmedTranscript = asrOut.text.trim();
      if (asrOut.echoDetected || (trimmedTranscript && isPromptEcho(trimmedTranscript, vocabularyTerms))) {
        timings.totalMs = Math.max(0, this.now() - pipelineStartMs);
        session.snapshot.stage = "no_speech";
        session.snapshot.errorMessage = "没有听清，请再说一次";
        return this.finalizeSession(session);
      }
      if (!trimmedTranscript) {
        timings.totalMs = Math.max(0, this.now() - pipelineStartMs);
        session.snapshot.stage = "no_speech";
        session.snapshot.errorMessage = "没有听到声音";
        return this.finalizeSession(session);
      }

      // 3. Correcting stage (publishes `rawText` so `stream_replace` can insert immediately!)
      session.snapshot.rawText = trimmedTranscript;
      session.snapshot.stage = "correcting";
      this.emit(session);

      const corr = this.corrector.correct(trimmedTranscript, workId);
      timings.correctMs = Number(corr.elapsedMs.toFixed(2));
      session.snapshot.correctedText = corr.correctedText;
      session.snapshot.replacements = corr.replacements;

      if (this.isSessionStale(session)) return { ...session.snapshot };
      if (signal.aborted) {
        session.snapshot.stage = "cancelled";
        return this.finalizeSession(session);
      }

      // 4. Polishing + OpenCC stage
      session.snapshot.stage = "polishing";
      this.emit(session);

      const polishOut = await this.polisher.polish({
        correctedText: corr.correctedText,
        mode: settings.polishMode,
        chineseVariant: settings.chineseVariant,
        candidates: corr.candidates,
        dictionaryTerms: this.corrector.activeTermStrings(workId),
        customPrompts: settings.polishPrompts,
        preferredConnectionId: settings.polishConnectionId,
        signal,
      });

      if (this.isSessionStale(session)) return { ...session.snapshot };
      if (signal.aborted) {
        session.snapshot.stage = "cancelled";
        return this.finalizeSession(session);
      }

      timings.polishMs = Number(polishOut.elapsedMs.toFixed(2));
      timings.totalMs = Math.max(0, this.now() - pipelineStartMs);

      session.snapshot.finalText = polishOut.finalText;
      session.snapshot.fallbackReason = polishOut.fallbackReason;

      // 5. Persist history (and optional 24-hour WAV)
      const savedHistory = this.history.record({
        workId,
        engineKind: asrOut.engineKind,
        engineId: asrOut.engineId,
        modelId: asrOut.modelId,
        polishMode: settings.polishMode,
        rawText: session.snapshot.rawText,
        correctedText: session.snapshot.correctedText,
        finalText: session.snapshot.finalText,
        fallbackReason: session.snapshot.fallbackReason,
        timings,
        replacements: session.snapshot.replacements,
        pcm16le: trimmed.pcmBuffer,
        retainAudio24h: settings.retainAudio24h,
        createdAt: new Date(this.now()),
      });

      session.snapshot.historyId = savedHistory.id;
      session.snapshot.stage = "done";
      if (session.stopReason === "max_duration") {
        session.snapshot.errorMessage = "单次听写最长 5 分钟，已自动结束";
      }
      return this.finalizeSession(session);
    } catch (error) {
      if (this.isSessionStale(session)) {
        return { ...session.snapshot };
      }
      if (isCancellationError(error, signal) || session.snapshot.stage === "cancelled") {
        session.snapshot.stage = "cancelled";
        return this.finalizeSession(session);
      }
      timings.totalMs = Math.max(0, this.now() - pipelineStartMs);
      session.snapshot.stage = "failed";
      session.snapshot.errorCode = error instanceof MangaError ? error.code : "PROVIDER_UNAVAILABLE";
      session.snapshot.errorMessage = error instanceof Error ? error.message : String(error);
      return this.finalizeSession(session);
    }
  }
}
