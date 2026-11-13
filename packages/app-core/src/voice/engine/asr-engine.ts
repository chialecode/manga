import {
  MangaError,
  type AsrEngineSelection,
} from "@manga/contracts";
import type { TranscriptionInterface } from "@manga/contracts/models";
import {
  DEFAULT_CHAT_AUDIO_SYSTEM_PROMPT,
  transcribeAudio,
  transcribeChatAudio,
  type TranscriptionResult,
  type TranscriptionSegment,
} from "@manga/model-protocol";
import { PCM_SAMPLE_RATE, wavFromPcm } from "../audio-files.ts";
import { MAX_CHUNK_MS, maxChunkMsForBytes } from "../chunks.ts";
import { PROMPT_ECHO } from "../transcribe.ts";
import type { AsrConnection, AsrPort } from "../ports.ts";
import {
  GTCRN_WET_MIX,
  float32ToInt16,
  int16ToPcmBuffer,
  mixGtcrnAudio,
  normalizePcm16kInput,
  type AudioInputBuffer,
} from "../silence-trimmer.ts";
import type { AsrCatalogModelKind } from "../models/catalog.ts";
import type { AsrModelService } from "../models/service.ts";
import {
  buildVocabularyHint,
  capabilitiesForExternalInterface,
  capabilitiesForLocalModel,
  isHintEcho,
  type AsrCapabilities,
  type BuiltAsrHint,
} from "./prompt-builder.ts";

export type LocalAsrRuntimeStatus = {
  modelId: string;
  status: "unloaded" | "loaded" | "load_failed";
  crashCount: number;
  reason?: string;
};

/**
 * Structural interface matching `apps/desktop/src/main/asr-service.ts` (`AsrService`) without importing
 * desktop or native `sherpa-onnx` modules into `@manga/app-core`.
 */
export interface LocalAsrRuntimePort {
  getModelStatus(modelId: string): LocalAsrRuntimeStatus;
  load(
    modelId: string,
    kind: AsrCatalogModelKind,
    files: Record<string, string>,
    options?: { numThreads?: number; force?: boolean },
  ): Promise<{
    loaded: true;
    modelId: string;
    kind: AsrCatalogModelKind;
    reused: boolean;
    elapsedMs: number;
    rssBytes: number;
  }>;
  recognize(
    samples: Float32Array,
    options?: {
      sampleRate?: number;
      hotwords?: readonly string[] | string;
      language?: string;
    },
  ): Promise<{
    text: string;
    rawText: string;
    tokens: string[];
    timestamps: number[];
    lang: string;
    modelId: string;
    elapsedMs: number;
  }>;
  denoise?(
    samples: Float32Array,
    options?: { sampleRate?: number; mixRatio?: number; gtcrnModelPath?: string },
  ): Promise<{
    samples: Float32Array;
    sampleRate: number;
    elapsedMs: number;
  }>;
  unload?(): Promise<{ unloaded: true }>;
}

export type ExternalAsrConnectionConfig = {
  id: string;
  name?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  transcriptionInterface: TranscriptionInterface;
  timeoutMs?: number;
  promptChars?: number;
  maxUploadBytes?: number;
  maxSeconds?: number;
  supportsLanguage?: boolean;
  supportsTimestamps?: boolean;
};

export type PreAsrDenoiseHook = (
  samples: Float32Array,
  options: { sampleRate: number; mixRatio: number; signal?: AbortSignal },
) => Promise<{ samples: Float32Array; alreadyMixed?: boolean } | Float32Array>;

export type AsrEngineOptions = {
  modelService?: AsrModelService;
  localRuntime?: LocalAsrRuntimePort;
  resolveConnection?: (
    connectionId: string,
  ) => Promise<ExternalAsrConnectionConfig | null> | ExternalAsrConnectionConfig | null;
  fetchImpl?: typeof fetch;
  denoiseHook?: PreAsrDenoiseHook;
  numThreads?: number;
  now?: () => number;
};

export type AsrTranscribeRequest = {
  selection: AsrEngineSelection | null | undefined;
  /** 16 kHz mono audio (`Float32Array`, `Int16Array`, raw PCM `Buffer`, or 16 kHz PCM WAV `Buffer`). */
  audio: AudioInputBuffer;
  fileName?: string;
  mimeType?: string;
  /** Ordered dictionary vocabulary terms (work manual -> work metadata -> global). */
  vocabularyTerms?: readonly string[];
  language?: string;
  timestamps?: boolean;
  /** Runs GTCRN 16 kHz speech enhancement (`0.75 * denoised + 0.25 * raw`) before recognition on either local or external ASR. */
  gtcrnDenoise?: boolean;
  /** Splits audio longer than `capabilities.maxSeconds` (`30s`) into `<= 30s` blocks. Defaults to `true`. */
  chunkLongAudio?: boolean;
  /** Retries once without vocabulary hints on the same engine if the transcript is detected as a hint echo. Defaults to `true`. */
  retryWithoutHintOnEcho?: boolean;
  /** Override capabilities (primarily for unit tests exercising custom capability combinations). */
  capabilitiesOverride?: Partial<AsrCapabilities>;
  signal?: AbortSignal;
};

export type AsrTranscribeResult = {
  text: string;
  segments?: TranscriptionSegment[];
  language?: string;
  engineKind: "local" | "connection";
  engineId: string;
  modelId: string;
  capabilities: AsrCapabilities;
  appliedHint: BuiltAsrHint;
  echoDetected: boolean;
  chunkCount: number;
  denoiseMs?: number;
  recognizeMs: number;
  loadingModel?: boolean;
};

const LOCAL_PREFIX = "local:";

function splitAudioIntoChunkRanges(
  samples: Float32Array,
  maxChunkMs: number,
): Array<{ startSample: number; endSample: number; offsetSec: number }> {
  const maxSamples = Math.max(PCM_SAMPLE_RATE, Math.floor((maxChunkMs * PCM_SAMPLE_RATE) / 1000));
  if (samples.length <= maxSamples) {
    return [{ startSample: 0, endSample: samples.length, offsetSec: 0 }];
  }

  const ranges: Array<{ startSample: number; endSample: number; offsetSec: number }> = [];
  const windowSamples = Math.floor(0.064 * PCM_SAMPLE_RATE); // 64 ms RMS window
  const stepSamples = Math.floor(0.032 * PCM_SAMPLE_RATE); // 32 ms step
  let cursor = 0;

  while (samples.length - cursor > maxSamples) {
    const hardLimit = cursor + maxSamples;
    const searchFloor = cursor + Math.floor(maxSamples * 0.6);
    let bestCut = hardLimit;
    let bestEnergy = Number.POSITIVE_INFINITY;

    for (let pos = hardLimit - windowSamples; pos >= searchFloor; pos -= stepSamples) {
      if (pos <= cursor) break;
      let sumSq = 0;
      for (let i = 0; i < windowSamples; i += 1) {
        const s = samples[pos + i]!;
        sumSq += s * s;
      }
      if (sumSq < bestEnergy) {
        bestEnergy = sumSq;
        bestCut = pos + Math.floor(windowSamples / 2);
        if (sumSq === 0) break;
      }
    }

    ranges.push({
      startSample: cursor,
      endSample: bestCut,
      offsetSec: cursor / PCM_SAMPLE_RATE,
    });
    cursor = bestCut;
  }

  if (cursor < samples.length) {
    ranges.push({
      startSample: cursor,
      endSample: samples.length,
      offsetSec: cursor / PCM_SAMPLE_RATE,
    });
  }

  return ranges;
}

function samplesToWavBuffer(samples: Float32Array): Buffer {
  return wavFromPcm(int16ToPcmBuffer(float32ToInt16(samples)));
}

function mapLocalAsrError(error: unknown, modelId: string): MangaError {
  if (error instanceof MangaError) {
    return new MangaError(error.code, error.message, {
      retryable: error.retryable,
      details: { ...error.details, engineKind: "local", modelId, setupHint: "settings.voice" },
      cause: error,
    });
  }
  const codeProp = (error as { code?: unknown } | undefined)?.code;
  const retryableProp = Boolean((error as { retryable?: unknown } | undefined)?.retryable);
  const message = error instanceof Error ? error.message : String(error);

  if (codeProp === "ASR_MODEL_LOAD_FAILED") {
    return new MangaError("CAPABILITY_UNAVAILABLE", message, {
      retryable: false,
      details: { reason: "model_load_failed", engineKind: "local", modelId, setupHint: "settings.voice" },
      cause: error,
    });
  }
  if (codeProp === "ASR_HOST_MISSING" || codeProp === "ASR_NOT_LOADED") {
    return new MangaError("CAPABILITY_UNAVAILABLE", message, {
      retryable: false,
      details: { reason: String(codeProp).toLowerCase(), engineKind: "local", modelId, setupHint: "settings.voice" },
      cause: error,
    });
  }
  if (codeProp === "ASR_STARTUP_TIMEOUT") {
    return new MangaError("PROVIDER_UNAVAILABLE", message, {
      retryable: true,
      details: { kind: "timeout", engineKind: "local", modelId, setupHint: "settings.voice" },
      cause: error,
    });
  }
  return new MangaError("PROVIDER_UNAVAILABLE", message, {
    retryable: retryableProp,
    details: {
      ...(typeof codeProp === "string" ? { hostCode: codeProp } : {}),
      engineKind: "local",
      modelId,
      setupHint: "settings.voice",
    },
    cause: error,
  });
}

function mapExternalAsrError(error: unknown, connection: ExternalAsrConnectionConfig): MangaError {
  if (error instanceof MangaError) {
    const status = Number(error.details?.status);
    if (status === 413) {
      return new MangaError(
        "VALIDATION_ERROR",
        `音频体积超出转录服务「${connection.name ?? connection.id}」的上传限制（HTTP 413）`,
        {
          retryable: false,
          details: {
            ...error.details,
            reason: "upload_limit_exceeded",
            engineKind: "connection",
            connectionId: connection.id,
            setupHint: "settings.connections",
          },
          cause: error,
        },
      );
    }
    return new MangaError(error.code, error.message, {
      retryable: error.retryable,
      details: {
        ...error.details,
        engineKind: "connection",
        connectionId: connection.id,
        setupHint: "settings.connections",
      },
      cause: error,
    });
  }
  return new MangaError(
    "PROVIDER_UNAVAILABLE",
    `语音转录服务请求失败：${error instanceof Error ? error.message : String(error)}`,
    {
      retryable: true,
      details: {
        engineKind: "connection",
        connectionId: connection.id,
        setupHint: "settings.connections",
      },
      cause: error,
    },
  );
}

/**
 * Unified speech recognition facade across local `sherpa-onnx` models (`qwen3Asr`, `senseVoice`, `funasrNano`)
 * and external HTTP transcription connections (`audio_transcriptions` and `chat_input_audio`).
 *
 * Enforces strict zero cross-engine fallback: a failure or missing setup on the chosen engine surfaces a
 * structured `MangaError` immediately and issues zero requests to any other model or connection.
 */
export class AsrEngine {
  private readonly modelService: AsrModelService | undefined;
  private readonly localRuntime: LocalAsrRuntimePort | undefined;
  private readonly resolveConnection:
    | ((connectionId: string) => Promise<ExternalAsrConnectionConfig | null> | ExternalAsrConnectionConfig | null)
    | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly denoiseHook: PreAsrDenoiseHook | undefined;
  private readonly numThreads: number | undefined;
  private readonly now: () => number;

  constructor(options: AsrEngineOptions = {}) {
    this.modelService = options.modelService;
    this.localRuntime = options.localRuntime;
    this.resolveConnection = options.resolveConnection;
    this.fetchImpl = options.fetchImpl;
    this.denoiseHook = options.denoiseHook;
    this.numThreads = options.numThreads;
    this.now = options.now ?? (() => Date.now());
  }

  async getCapabilities(selection: AsrEngineSelection): Promise<AsrCapabilities> {
    if (selection.kind === "local") {
      if (!this.modelService) {
        throw new MangaError("CAPABILITY_UNAVAILABLE", "本地语音模型服务尚未初始化", {
          details: { reason: "model_service_unavailable", setupHint: "settings.voice" },
        });
      }
      const model = this.modelService.getCatalogEntry(selection.modelId);
      return capabilitiesForLocalModel(model.kind, model.hotwords);
    }

    const conn = await this.resolveConnection?.(selection.connectionId);
    if (!conn) {
      throw new MangaError(
        "CAPABILITY_UNAVAILABLE",
        "所选语音转录连接不存在或尚未配置，请前往「设置 › 语音转录」选择可用引擎",
        {
          details: {
            reason: "connection_unconfigured",
            connectionId: selection.connectionId,
            setupHint: "settings.voice",
          },
        },
      );
    }
    return capabilitiesForExternalInterface(conn.transcriptionInterface, {
      promptChars: conn.promptChars,
      maxUploadBytes: conn.maxUploadBytes,
      maxSeconds: conn.maxSeconds,
      supportsLanguage: conn.supportsLanguage,
      supportsTimestamps: conn.supportsTimestamps,
    });
  }

  async transcribe(request: AsrTranscribeRequest): Promise<AsrTranscribeResult> {
    if (request.signal?.aborted) {
      throw new MangaError("CANCELLED", "语音识别已取消");
    }
    if (!request.selection) {
      throw new MangaError(
        "CAPABILITY_UNAVAILABLE",
        "尚未配置语音识别引擎，请前往「设置 › 语音转录」下载本地模型或选择转录连接",
        {
          retryable: false,
          details: { reason: "asr_unconfigured", setupHint: "settings.voice" },
        },
      );
    }

    if (request.selection.kind === "local") {
      return this.transcribeWithLocalModel(request.selection.modelId, request);
    }
    return this.transcribeWithExternalConnection(request.selection.connectionId, request);
  }

  /**
   * Adapts `AsrEngine` to the `AsrPort` interface consumed by `CaptureService` / `VoicePipeline` so long-form
   * recording notes can run on downloaded local models as well as `audio_transcriptions` and `chat_input_audio`.
   */
  createAsrPort(options: {
    getDefaultSelection?: () => AsrEngineSelection | null;
    resolveSyncConnection?: (connectionId: string) => ExternalAsrConnectionConfig | null;
    shouldDenoise?: () => boolean;
  } = {}): AsrPort {
    return {
      resolve: (connectionId?: string): AsrConnection | null => {
        const selection = this.selectionFromPortId(connectionId, options.getDefaultSelection);
        if (!selection) return null;

        if (selection.kind === "local") {
          if (!this.modelService || !this.localRuntime) return null;
          if (!this.modelService.isInstalled(selection.modelId)) return null;
          const status = this.localRuntime.getModelStatus(selection.modelId);
          if (status.status === "load_failed") return null;
          return {
            id: `${LOCAL_PREFIX}${selection.modelId}`,
            model: selection.modelId,
            timeoutMs: 120_000,
            maxUploadBytes: 30 * PCM_SAMPLE_RATE * 2 + 44,
          };
        }

        const syncConn = options.resolveSyncConnection?.(selection.connectionId);
        if (!syncConn) return null;
        return {
          id: syncConn.id,
          model: syncConn.model,
          timeoutMs: syncConn.timeoutMs ?? 120_000,
          ...(syncConn.maxUploadBytes ? { maxUploadBytes: syncConn.maxUploadBytes } : {}),
        };
      },
      transcribe: async (connection, portReq): Promise<TranscriptionResult> => {
        const selection: AsrEngineSelection = connection.id.startsWith(LOCAL_PREFIX)
          ? { kind: "local", modelId: connection.id.slice(LOCAL_PREFIX.length) }
          : { kind: "connection", connectionId: connection.id };

        const promptTerms = portReq.prompt
          ? portReq.prompt.split(/[,，、;；]+/).map((item) => item.trim()).filter(Boolean)
          : [];

        const res = await this.transcribe({
          selection,
          audio: portReq.bytes,
          fileName: portReq.fileName,
          mimeType: portReq.mimeType,
          vocabularyTerms: promptTerms,
          language: portReq.language,
          timestamps: portReq.timestamps,
          gtcrnDenoise: options.shouldDenoise?.() ?? false,
          chunkLongAudio: true,
          retryWithoutHintOnEcho: false,
          signal: portReq.signal,
        });

        if (res.echoDetected) {
          throw new MangaError("PROVIDER_UNAVAILABLE", "the transcript only repeats the dictionary hint", {
            retryable: true,
            details: { reason: PROMPT_ECHO },
          });
        }

        return {
          text: res.text,
          ...(res.language ? { language: res.language } : {}),
          ...(res.segments ? { segments: res.segments } : {}),
        };
      },
    };
  }

  private selectionFromPortId(
    connectionId: string | undefined,
    getDefaultSelection?: () => AsrEngineSelection | null,
  ): AsrEngineSelection | null {
    if (!connectionId) {
      return getDefaultSelection?.() ?? null;
    }
    if (connectionId.startsWith(LOCAL_PREFIX)) {
      return { kind: "local", modelId: connectionId.slice(LOCAL_PREFIX.length) };
    }
    if (this.modelService) {
      try {
        const entry = this.modelService.getCatalogEntry(connectionId);
        return { kind: "local", modelId: entry.modelId };
      } catch {
        // not a local catalog model id; treat as external connectionId
      }
    }
    return { kind: "connection", connectionId };
  }

  private async maybeDenoiseSamples(
    rawSamples: Float32Array,
    enabled: boolean | undefined,
    signal?: AbortSignal,
  ): Promise<{ samples: Float32Array; denoiseMs?: number }> {
    if (!enabled || rawSamples.length === 0) {
      return { samples: rawSamples };
    }
    const started = this.now();
    if (this.denoiseHook) {
      const hookOut = await this.denoiseHook(rawSamples, {
        sampleRate: PCM_SAMPLE_RATE,
        mixRatio: GTCRN_WET_MIX,
        signal,
      });
      if (hookOut instanceof Float32Array) {
        return {
          samples: mixGtcrnAudio(rawSamples, hookOut, GTCRN_WET_MIX),
          denoiseMs: Math.max(0, this.now() - started),
        };
      }
      return {
        samples: hookOut.alreadyMixed ? hookOut.samples : mixGtcrnAudio(rawSamples, hookOut.samples, GTCRN_WET_MIX),
        denoiseMs: Math.max(0, this.now() - started),
      };
    }

    if (this.localRuntime?.denoise) {
      // `asr-host.ts` already applies `mixDenoisedSamples(..., mixRatio)` inside the isolated speech process.
      const res = await this.localRuntime.denoise(rawSamples, {
        sampleRate: PCM_SAMPLE_RATE,
        mixRatio: GTCRN_WET_MIX,
      });
      return {
        samples: res.samples,
        denoiseMs: Math.max(0, this.now() - started),
      };
    }

    throw new MangaError(
      "CAPABILITY_UNAVAILABLE",
      "当前环境未提供 GTCRN 语音增强组件，请在「设置 › 语音转录」关闭降噪增强或检查安装包",
      { details: { reason: "gtcrn_unavailable", setupHint: "settings.voice" } },
    );
  }

  private async transcribeWithLocalModel(
    modelId: string,
    request: AsrTranscribeRequest,
  ): Promise<AsrTranscribeResult> {
    if (!this.modelService || !this.localRuntime) {
      throw new MangaError(
        "CAPABILITY_UNAVAILABLE",
        "本地语音识别运行环境未就绪，请前往「设置 › 语音转录」检查本地模型配置",
        {
          retryable: false,
          details: { reason: "local_runtime_unavailable", modelId, setupHint: "settings.voice" },
        },
      );
    }

    // Check `load_failed` BEFORE attempting to load or spawn so crash-looped models fail fast with zero side effects.
    const preStatus = this.localRuntime.getModelStatus(modelId);
    if (preStatus.status === "load_failed") {
      throw new MangaError(
        "CAPABILITY_UNAVAILABLE",
        preStatus.reason ?? `本地语音模型「${modelId}」载入失败，请前往「设置 › 语音转录」重新载入或重装模型`,
        {
          retryable: false,
          details: { reason: "model_load_failed", engineKind: "local", modelId, setupHint: "settings.voice" },
        },
      );
    }

    let runtimeResolved: ReturnType<AsrModelService["getRuntimeFiles"]>;
    try {
      runtimeResolved = this.modelService.getRuntimeFiles(modelId);
    } catch (error) {
      throw mapLocalAsrError(error, modelId);
    }
    const { model, files } = runtimeResolved;
    const capabilities: AsrCapabilities = {
      ...capabilitiesForLocalModel(model.kind, model.hotwords),
      ...request.capabilitiesOverride,
    };
    const appliedHint = buildVocabularyHint(capabilities, request.vocabularyTerms ?? [], {
      language: request.language,
    });

    const { samples: rawSamples } = normalizePcm16kInput(request.audio);
    if (rawSamples.length === 0) {
      return {
        text: "",
        engineKind: "local",
        engineId: model.modelId,
        modelId: model.modelId,
        capabilities,
        appliedHint,
        echoDetected: false,
        chunkCount: 0,
        recognizeMs: 0,
      };
    }

    const loadingModel = preStatus.status === "unloaded";
    let denoiseMs: number | undefined;
    let workingSamples = rawSamples;

    try {
      const denoised = await this.maybeDenoiseSamples(rawSamples, request.gtcrnDenoise, request.signal);
      workingSamples = denoised.samples;
      denoiseMs = denoised.denoiseMs;

      if (request.signal?.aborted) {
        throw new MangaError("CANCELLED", "语音识别已取消");
      }

      await this.localRuntime.load(model.modelId, model.kind, files, {
        ...(this.numThreads ? { numThreads: this.numThreads } : {}),
      });
    } catch (error) {
      if (error instanceof MangaError && error.code === "CANCELLED") throw error;
      throw mapLocalAsrError(error, model.modelId);
    }

    const maxChunkMs = Math.min(MAX_CHUNK_MS, Math.max(1_000, capabilities.maxSeconds * 1000));
    const chunkRanges =
      request.chunkLongAudio === false
        ? [{ startSample: 0, endSample: workingSamples.length, offsetSec: 0 }]
        : splitAudioIntoChunkRanges(workingSamples, maxChunkMs);

    const retryOnEcho = request.retryWithoutHintOnEcho ?? true;
    const texts: string[] = [];
    let detectedLang: string | undefined;
    let anyEchoDetected = false;
    const recognizeStarted = this.now();

    for (const range of chunkRanges) {
      if (request.signal?.aborted) {
        throw new MangaError("CANCELLED", "语音识别已取消");
      }
      const chunkSamples = workingSamples.subarray(range.startSample, range.endSample);
      const runOnce = async (useHint: boolean) => {
        try {
          return await this.localRuntime!.recognize(chunkSamples, {
            sampleRate: PCM_SAMPLE_RATE,
            ...(useHint && appliedHint.kind === "hotwords" ? { hotwords: appliedHint.hotwordsCsv } : {}),
            ...(capabilities.language && request.language ? { language: request.language } : {}),
          });
        } catch (error) {
          throw mapLocalAsrError(error, model.modelId);
        }
      };

      let out = await runOnce(appliedHint.kind === "hotwords");
      let text = out.text.trim();

      if (appliedHint.includedTerms.length > 0 && isHintEcho(text, appliedHint.includedTerms)) {
        anyEchoDetected = true;
        if (retryOnEcho) {
          out = await runOnce(false);
          text = out.text.trim();
          if (isHintEcho(text, appliedHint.includedTerms)) {
            text = "";
          } else {
            anyEchoDetected = false;
          }
        } else {
          text = "";
        }
      }

      if (out.lang && !detectedLang) {
        detectedLang = out.lang;
      }
      if (text) {
        texts.push(text);
      }
    }

    const recognizeMs = Math.max(0, this.now() - recognizeStarted);
    return {
      text: texts.join(""),
      ...(detectedLang ? { language: detectedLang } : {}),
      engineKind: "local",
      engineId: model.modelId,
      modelId: model.modelId,
      capabilities,
      appliedHint,
      echoDetected: anyEchoDetected && texts.length === 0,
      chunkCount: chunkRanges.length,
      ...(denoiseMs !== undefined ? { denoiseMs } : {}),
      recognizeMs,
      ...(loadingModel ? { loadingModel: true } : {}),
    };
  }

  private async transcribeWithExternalConnection(
    connectionId: string,
    request: AsrTranscribeRequest,
  ): Promise<AsrTranscribeResult> {
    const conn = await this.resolveConnection?.(connectionId);
    if (!conn) {
      throw new MangaError(
        "CAPABILITY_UNAVAILABLE",
        "所选语音转录连接不存在或尚未配置，请前往「设置 › 语音转录」选择可用引擎",
        {
          retryable: false,
          details: {
            reason: "connection_unconfigured",
            engineKind: "connection",
            connectionId,
            setupHint: "settings.voice",
          },
        },
      );
    }

    if (!conn.apiKey?.trim()) {
      throw new MangaError(
        "CREDENTIAL_UNAVAILABLE",
        `语音转录连接「${conn.name ?? conn.id}」缺少访问密钥，请前往「设置 › 模型连接」重新配置`,
        {
          retryable: false,
          details: {
            reason: "credential_unavailable",
            engineKind: "connection",
            connectionId: conn.id,
            setupHint: "settings.connections",
          },
        },
      );
    }

    if (!conn.baseUrl?.trim() || !conn.model?.trim()) {
      throw new MangaError(
        "CAPABILITY_UNAVAILABLE",
        `语音转录连接「${conn.name ?? conn.id}」地址或模型名不完整，请前往「设置 › 模型连接」检查`,
        {
          retryable: false,
          details: {
            reason: "connection_incomplete",
            engineKind: "connection",
            connectionId: conn.id,
            setupHint: "settings.connections",
          },
        },
      );
    }

    const capabilities: AsrCapabilities = {
      ...capabilitiesForExternalInterface(conn.transcriptionInterface, {
        promptChars: conn.promptChars,
        maxUploadBytes: conn.maxUploadBytes,
        maxSeconds: conn.maxSeconds,
        supportsLanguage: conn.supportsLanguage,
        supportsTimestamps: conn.supportsTimestamps,
      }),
      ...request.capabilitiesOverride,
    };

    const appliedHint = buildVocabularyHint(capabilities, request.vocabularyTerms ?? [], {
      language: request.language,
      baseSystemPrompt: DEFAULT_CHAT_AUDIO_SYSTEM_PROMPT,
    });

    const rawBytesProvided =
      (request.audio instanceof Uint8Array || Buffer.isBuffer(request.audio)) &&
      !request.gtcrnDenoise &&
      request.chunkLongAudio === false;
    const encodedFilePassthrough =
      rawBytesProvided &&
      ((Boolean(request.mimeType) && request.mimeType !== "audio/pcm") ||
        ((request.audio as Uint8Array).byteLength >= 44 &&
          (request.audio as Uint8Array)[0] === 0x52 &&
          (request.audio as Uint8Array)[1] === 0x49));

    if (rawBytesProvided) {
      const directBytes = request.audio as Uint8Array;
      if (capabilities.maxUploadBytes > 0 && directBytes.byteLength > capabilities.maxUploadBytes) {
        throw new MangaError(
          "VALIDATION_ERROR",
          `音频大小（${directBytes.byteLength} 字节）超出连接「${conn.name ?? conn.id}」的上传上限（${capabilities.maxUploadBytes} 字节）`,
          {
            retryable: false,
            details: {
              reason: "upload_limit_exceeded",
              engineKind: "connection",
              connectionId: conn.id,
              bytes: directBytes.byteLength,
              maxUploadBytes: capabilities.maxUploadBytes,
              setupHint: "settings.connections",
            },
          },
        );
      }
    }

    const { samples: rawSamples } = encodedFilePassthrough
      ? { samples: new Float32Array(0) }
      : normalizePcm16kInput(request.audio);
    if (rawSamples.length === 0 && !encodedFilePassthrough) {
      return {
        text: "",
        engineKind: "connection",
        engineId: conn.id,
        modelId: conn.model,
        capabilities,
        appliedHint,
        echoDetected: false,
        chunkCount: 0,
        recognizeMs: 0,
      };
    }

    const denoised = encodedFilePassthrough
      ? { samples: rawSamples }
      : await this.maybeDenoiseSamples(rawSamples, request.gtcrnDenoise, request.signal);
    const workingSamples = denoised.samples;
    const denoiseMs = denoised.denoiseMs;

    const maxByBytes = capabilities.maxUploadBytes > 0 ? maxChunkMsForBytes(capabilities.maxUploadBytes) : MAX_CHUNK_MS;
    const maxChunkMs = Math.min(Math.max(1_000, capabilities.maxSeconds * 1000), maxByBytes);

    const chunkRanges =
      request.chunkLongAudio === false
        ? [{ startSample: 0, endSample: workingSamples.length, offsetSec: 0 }]
        : splitAudioIntoChunkRanges(workingSamples, maxChunkMs);

    const retryOnEcho = request.retryWithoutHintOnEcho ?? true;
    const texts: string[] = [];
    const collectedSegments: TranscriptionSegment[] = [];
    let detectedLang: string | undefined;
    let anyEchoDetected = false;
    const recognizeStarted = this.now();

    for (let idx = 0; idx < chunkRanges.length; idx += 1) {
      if (request.signal?.aborted) {
        throw new MangaError("CANCELLED", "语音识别已取消");
      }
      const range = chunkRanges[idx]!;
      const chunkWav = encodedFilePassthrough
        ? (request.audio as Uint8Array)
        : samplesToWavBuffer(workingSamples.subarray(range.startSample, range.endSample));
      const chatAudioFormat: "wav" | "mp3" =
        encodedFilePassthrough && (request.mimeType === "audio/mpeg" || request.fileName?.toLowerCase().endsWith(".mp3"))
          ? "mp3"
          : "wav";

      if (capabilities.maxUploadBytes > 0 && chunkWav.byteLength > capabilities.maxUploadBytes) {
        throw new MangaError(
          "VALIDATION_ERROR",
          `音频分块大小（${chunkWav.byteLength} 字节）超出连接「${conn.name ?? conn.id}」的上传上限（${capabilities.maxUploadBytes} 字节）`,
          {
            retryable: false,
            details: {
              reason: "upload_limit_exceeded",
              engineKind: "connection",
              connectionId: conn.id,
              bytes: chunkWav.byteLength,
              maxUploadBytes: capabilities.maxUploadBytes,
              setupHint: "settings.connections",
            },
          },
        );
      }

      const sendOnce = async (useHint: boolean): Promise<TranscriptionResult> => {
        try {
          if (conn.transcriptionInterface === "chat_input_audio") {
            return await transcribeChatAudio(
              conn.baseUrl,
              conn.apiKey,
              {
                model: conn.model,
                bytes: chunkWav,
                format: chatAudioFormat,
                systemPrompt:
                  useHint && appliedHint.kind === "context"
                    ? appliedHint.systemPrompt
                    : undefined,
                language: capabilities.language ? request.language : undefined,
                timeoutMs: conn.timeoutMs,
                signal: request.signal,
              },
              this.fetchImpl,
            );
          }

          return await transcribeAudio(
            conn.baseUrl,
            conn.apiKey,
            {
              model: conn.model,
              fileName: request.fileName ?? `chunk-${idx}.wav`,
              bytes: chunkWav,
              mimeType: request.mimeType ?? "audio/wav",
              prompt: useHint && appliedHint.kind === "prompt" ? appliedHint.prompt : undefined,
              language: capabilities.language ? request.language : undefined,
              timestamps: capabilities.timestamps ? request.timestamps : false,
              timeoutMs: conn.timeoutMs,
              signal: request.signal,
            },
            this.fetchImpl,
          );
        } catch (error) {
          throw mapExternalAsrError(error, conn);
        }
      };

      const hasHint = appliedHint.kind === "prompt" || appliedHint.kind === "context";
      let out = await sendOnce(hasHint);
      let text = out.text.trim();

      if (appliedHint.includedTerms.length > 0 && isHintEcho(text, appliedHint.includedTerms)) {
        anyEchoDetected = true;
        if (retryOnEcho) {
          out = await sendOnce(false);
          text = out.text.trim();
          if (isHintEcho(text, appliedHint.includedTerms)) {
            text = "";
          } else {
            anyEchoDetected = false;
          }
        } else {
          text = "";
        }
      }

      if (out.language && !detectedLang) {
        detectedLang = out.language;
      }
      if (text) {
        texts.push(text);
        if (out.segments && out.segments.length > 0) {
          for (const seg of out.segments) {
            collectedSegments.push({
              start: seg.start + range.offsetSec,
              end: seg.end + range.offsetSec,
              text: seg.text,
            });
          }
        }
      }
    }

    const recognizeMs = Math.max(0, this.now() - recognizeStarted);
    return {
      text: texts.join(conn.transcriptionInterface === "audio_transcriptions" ? " " : "").trim(),
      ...(collectedSegments.length > 0 ? { segments: collectedSegments } : {}),
      ...(detectedLang ? { language: detectedLang } : {}),
      engineKind: "connection",
      engineId: conn.id,
      modelId: conn.model,
      capabilities,
      appliedHint,
      echoDetected: anyEchoDetected && texts.length === 0,
      chunkCount: chunkRanges.length,
      ...(denoiseMs !== undefined ? { denoiseMs } : {}),
      recognizeMs,
    };
  }
}
