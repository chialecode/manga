/**
 * Isolated local speech inference worker (`asr-host.cjs`).
 *
 * Spawned lazily by `AsrService` via `utilityProcess.fork` (`serviceName: "MANGA speech"`) and addressed over a
 * dedicated `MessagePort` (or Node IPC in headless unit tests). Owns `sherpa-onnx-node` exclusively: neither the
 * main process nor light-open ever imports this module or `sherpa-onnx-node`. Does not touch the database or network.
 *
 * Electron >= 21 enforces the V8 memory cage, forbidding external-pointer ArrayBuffers; every audio-returning
 * `sherpa-onnx-node` call here MUST pass `enableExternalBuffer: false`.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_ASR_SAMPLE_RATE,
  GTCRN_WET_MIX,
  formatHotwordsCsv,
  mixDenoisedSamples,
  normalizeLanguageForModel,
  toFloat32Array,
  type AsrDenoiseResult,
  type AsrHostMessage,
  type AsrHostRequest,
  type AsrLoadResult,
  type AsrModelKind,
  type AsrPingResult,
  type AsrRecognizeResult,
  type AsrUnloadResult,
} from "./asr-protocol.ts";

type SherpaOfflineStream = {
  acceptWaveform(waveform: { samples: Float32Array; sampleRate: number }): void;
  setOption(key: string, value: string): void;
};

type SherpaOfflineRecognizerResult = {
  text?: string;
  tokens?: string[];
  timestamps?: number[];
  lang?: string;
  emotion?: string;
  event?: string;
};

type SherpaOfflineRecognizer = {
  createStream(hotwords?: string): SherpaOfflineStream;
  decode(stream: SherpaOfflineStream): void;
  decodeAsync(stream: SherpaOfflineStream): Promise<SherpaOfflineRecognizerResult>;
  getResult(stream: SherpaOfflineStream): SherpaOfflineRecognizerResult;
};

type SherpaOfflineSpeechDenoiser = {
  readonly sampleRate: number;
  run(request: { samples: Float32Array; sampleRate: number; enableExternalBuffer: false }): {
    samples: Float32Array;
    sampleRate: number;
  };
};

type SherpaModule = {
  version: string;
  gitSha1: string;
  onnxruntimeVersion: string;
  OfflineRecognizer: {
    new (config: Record<string, unknown>): SherpaOfflineRecognizer;
    createAsync(config: Record<string, unknown>): Promise<SherpaOfflineRecognizer>;
  };
  OfflineSpeechDenoiser: {
    new (config: Record<string, unknown>): SherpaOfflineSpeechDenoiser;
  };
  readWave: (filename: string, enableExternalBuffer: false) => { samples: Float32Array; sampleRate: number };
};

let sherpaCache: SherpaModule | null = null;

function loadSherpa(): SherpaModule {
  if (sherpaCache) return sherpaCache;
  const hostDir = typeof __dirname === "string" ? __dirname : process.cwd();
  const nodeModulesDirs = [
    path.resolve(hostDir, "../../node_modules"),
    path.resolve(hostDir, "../node_modules"),
    path.resolve(hostDir, "app.asar.unpacked/node_modules"),
    path.resolve(hostDir, "../../../node_modules"),
    path.resolve(process.cwd(), "node_modules"),
  ];
  if (process.platform === "win32") {
    for (const nm of nodeModulesDirs) {
      const winX64 = path.join(nm, "sherpa-onnx-win-x64");
      if (fs.existsSync(path.join(winX64, "sherpa-onnx.node"))) {
        const currentPath = process.env.PATH ?? process.env.Path ?? "";
        if (!currentPath.toLowerCase().includes(winX64.toLowerCase())) {
          process.env.PATH = currentPath ? `${winX64};${currentPath}` : winX64;
        }
        break;
      }
    }
  }

  let loaded: SherpaModule | null = null;
  let firstError: unknown;
  try {
    // Kept as a literal require so bundlers/analyzers see the external dependency while packaged builds resolve it from unpacked node_modules.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require("sherpa-onnx-node") as SherpaModule;
  } catch (error) {
    firstError = error;
  }
  if (!loaded) {
    for (const nm of nodeModulesDirs) {
      const entry = path.join(nm, "sherpa-onnx-node", "sherpa-onnx.js");
      if (fs.existsSync(entry)) {
        const req = createRequire(entry);
        loaded = req(entry) as SherpaModule;
        break;
      }
    }
  }
  if (!loaded) {
    throw firstError instanceof Error ? firstError : new Error("无法加载 sherpa-onnx-node 原生模块");
  }
  sherpaCache = loaded;
  return loaded;
}

function defaultThreads(): number {
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(cores / 2) || 2));
}

function assertFileExists(label: string, filePath: string | undefined): string {
  if (!filePath || typeof filePath !== "string") {
    throw Object.assign(new Error(`缺少模型文件路径：${label}`), { code: "ASR_INVALID_MODEL_FILES" });
  }
  if (!fs.existsSync(filePath)) {
    throw Object.assign(new Error(`模型文件不存在（${label}）：${filePath}`), { code: "ASR_MODEL_FILE_MISSING" });
  }
  return filePath;
}

function buildRecognizerConfig(kind: AsrModelKind, files: Record<string, string>, numThreads = defaultThreads()): Record<string, unknown> {
  const baseModelConfig: Record<string, unknown> = {
    numThreads,
    provider: "cpu",
    debug: 0,
  };

  if (kind === "qwen3Asr") {
    const convFrontend = assertFileExists("convFrontend", files.convFrontend);
    const encoder = assertFileExists("encoder", files.encoder);
    const decoder = assertFileExists("decoder", files.decoder);
    const tokenizer = assertFileExists("tokenizer", files.tokenizer);
    return {
      featConfig: { sampleRate: DEFAULT_ASR_SAMPLE_RATE, featureDim: 128 },
      decodingMethod: "greedy_search",
      modelConfig: {
        ...baseModelConfig,
        qwen3Asr: {
          convFrontend,
          encoder,
          decoder,
          tokenizer,
          maxTotalLen: 2048,
          maxNewTokens: 512,
          temperature: 1e-6,
          topP: 0.8,
          seed: 42,
          hotwords: "",
        },
      },
    };
  }

  if (kind === "funasrNano") {
    const encoderAdaptor = assertFileExists("encoderAdaptor", files.encoderAdaptor);
    const llm = assertFileExists("llm", files.llm);
    const embedding = assertFileExists("embedding", files.embedding);
    const tokenizer = assertFileExists("tokenizer", files.tokenizer);
    return {
      featConfig: { sampleRate: DEFAULT_ASR_SAMPLE_RATE, featureDim: 80 },
      decodingMethod: "greedy_search",
      modelConfig: {
        ...baseModelConfig,
        funasrNano: {
          encoderAdaptor,
          llm,
          embedding,
          tokenizer,
          systemPrompt: "You are a helpful assistant.",
          userPrompt: "语音转写：",
          language: "",
          itn: 1,
          hotwords: "",
          maxNewTokens: 512,
          temperature: 1e-6,
          topP: 0.8,
          seed: 42,
        },
      },
    };
  }

  if (kind === "senseVoice") {
    const model = assertFileExists("model", files.model);
    const tokens = assertFileExists("tokens", files.tokens);
    return {
      featConfig: { sampleRate: DEFAULT_ASR_SAMPLE_RATE, featureDim: 80 },
      decodingMethod: "greedy_search",
      modelConfig: {
        ...baseModelConfig,
        tokens,
        senseVoice: {
          model,
          language: "auto",
          useInverseTextNormalization: 1,
        },
      },
    };
  }

  throw Object.assign(new Error(`不支持的本地语音模型类型：${String(kind)}`), { code: "ASR_UNSUPPORTED_KIND" });
}

let defaultGtcrnPath: string | undefined;
let loadedRecognizer: SherpaOfflineRecognizer | null = null;
let loadedModelId: string | null = null;
let loadedKind: AsrModelKind | null = null;
let loadedSignature: string | null = null;

let loadedDenoiser: SherpaOfflineSpeechDenoiser | null = null;
let loadedDenoiserPath: string | null = null;

async function handleLoad(params: {
  modelId: string;
  kind: AsrModelKind;
  files: Record<string, string>;
  numThreads?: number;
}): Promise<AsrLoadResult> {
  const started = performance.now();
  const sherpa = loadSherpa();
  const signature = JSON.stringify({ modelId: params.modelId, kind: params.kind, files: params.files, numThreads: params.numThreads ?? null });
  if (loadedRecognizer && loadedSignature === signature && loadedModelId === params.modelId && loadedKind === params.kind) {
    return {
      loaded: true,
      modelId: params.modelId,
      kind: params.kind,
      reused: true,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      rssBytes: process.memoryUsage().rss,
    };
  }

  loadedRecognizer = null;
  loadedModelId = null;
  loadedKind = null;
  loadedSignature = null;

  const config = buildRecognizerConfig(params.kind, params.files, params.numThreads);
  const recognizer = await sherpa.OfflineRecognizer.createAsync(config);
  loadedRecognizer = recognizer;
  loadedModelId = params.modelId;
  loadedKind = params.kind;
  loadedSignature = signature;

  return {
    loaded: true,
    modelId: params.modelId,
    kind: params.kind,
    reused: false,
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    rssBytes: process.memoryUsage().rss,
  };
}

async function handleRecognize(params: {
  samples: unknown;
  sampleRate?: number;
  hotwords?: readonly string[] | string;
  language?: string;
}): Promise<AsrRecognizeResult> {
  if (!loadedRecognizer || !loadedKind || !loadedModelId) {
    throw Object.assign(new Error("尚未载入本地语音识别模型"), { code: "ASR_NOT_LOADED" });
  }
  const samples = toFloat32Array(params.samples);
  const sampleRate = params.sampleRate ?? DEFAULT_ASR_SAMPLE_RATE;
  if (samples.length === 0) {
    return { text: "", rawText: "", tokens: [], timestamps: [], lang: "", modelId: loadedModelId, elapsedMs: 0 };
  }

  const started = performance.now();
  const stream = loadedRecognizer.createStream();
  const hotwordsCsv = formatHotwordsCsv(params.hotwords);
  const normalizedLang = normalizeLanguageForModel(loadedKind, params.language);

  if (loadedKind === "qwen3Asr") {
    stream.setOption("hotwords", hotwordsCsv);
    if (normalizedLang) stream.setOption("language", normalizedLang);
  } else if (loadedKind === "funasrNano") {
    stream.setOption("hotwords", hotwordsCsv);
    stream.setOption("itn", "1");
    stream.setOption("language", normalizedLang);
  } else if (loadedKind === "senseVoice") {
    stream.setOption("use_itn", "1");
  }

  stream.acceptWaveform({ samples, sampleRate });
  const raw = await loadedRecognizer.decodeAsync(stream);
  const rawText = typeof raw?.text === "string" ? raw.text : "";
  return {
    text: rawText.trim(),
    rawText,
    tokens: Array.isArray(raw?.tokens) ? raw.tokens : [],
    timestamps: Array.isArray(raw?.timestamps) ? raw.timestamps : [],
    lang: typeof raw?.lang === "string" ? raw.lang : "",
    modelId: loadedModelId,
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

function ensureDenoiser(modelPath: string): SherpaOfflineSpeechDenoiser {
  const verifiedPath = assertFileExists("gtcrn", modelPath);
  if (loadedDenoiser && loadedDenoiserPath === verifiedPath) return loadedDenoiser;
  const sherpa = loadSherpa();
  loadedDenoiser = new sherpa.OfflineSpeechDenoiser({
    model: {
      gtcrn: { model: verifiedPath },
      numThreads: Math.min(2, defaultThreads()),
      provider: "cpu",
      debug: 0,
    },
  });
  loadedDenoiserPath = verifiedPath;
  return loadedDenoiser;
}

function handleDenoise(params: {
  samples: unknown;
  sampleRate?: number;
  mixRatio?: number;
  gtcrnModelPath?: string;
}): AsrDenoiseResult {
  const rawSamples = toFloat32Array(params.samples);
  const sampleRate = params.sampleRate ?? DEFAULT_ASR_SAMPLE_RATE;
  if (rawSamples.length === 0) {
    return { samples: new Float32Array(0), sampleRate, elapsedMs: 0 };
  }
  const modelPath = params.gtcrnModelPath ?? defaultGtcrnPath;
  if (!modelPath) {
    throw Object.assign(new Error("未找到随包 GTCRN 语音增强模型"), { code: "ASR_GTCRN_MISSING" });
  }
  const started = performance.now();
  const denoiser = ensureDenoiser(modelPath);
  // CRITICAL: Electron >= 21 V8 memory cage forbids external buffers; enableExternalBuffer MUST be false.
  const denoised = denoiser.run({
    samples: rawSamples,
    sampleRate,
    enableExternalBuffer: false,
  });
  const mixed = mixDenoisedSamples(rawSamples, denoised.samples, params.mixRatio ?? GTCRN_WET_MIX);
  return {
    samples: mixed,
    sampleRate: denoised.sampleRate || sampleRate,
    elapsedMs: Math.round((performance.now() - started) * 100) / 100,
  };
}

function handleUnload(): AsrUnloadResult {
  loadedRecognizer = null;
  loadedModelId = null;
  loadedKind = null;
  loadedSignature = null;
  loadedDenoiser = null;
  loadedDenoiserPath = null;
  return { unloaded: true };
}

function handlePing(): AsrPingResult {
  const sherpa = loadSherpa();
  return {
    pong: true,
    pid: process.pid,
    version: sherpa.version,
    onnxruntimeVersion: sherpa.onnxruntimeVersion,
    loadedModelId,
    rssBytes: process.memoryUsage().rss,
  };
}

async function dispatchRequest(message: AsrHostRequest, send: (reply: AsrHostMessage) => void): Promise<void> {
  if (!message || typeof message !== "object") return;
  if (message.t === "stop") {
    handleUnload();
    process.exit(0);
  }
  if (message.t !== "call") return;
  try {
    let value: unknown;
    switch (message.method) {
      case "ping":
        value = handlePing();
        break;
      case "load":
        value = await handleLoad(message.params);
        break;
      case "recognize":
        value = await handleRecognize(message.params);
        break;
      case "denoise":
        value = handleDenoise(message.params);
        break;
      case "unload":
        value = handleUnload();
        break;
      default:
        throw Object.assign(new Error(`未知推理请求：${String((message as { method?: unknown }).method)}`), { code: "ASR_UNKNOWN_METHOD" });
    }
    send({ t: "result", id: message.id, ok: true, value });
  } catch (error) {
    const err = error as { code?: unknown; message?: unknown } | undefined;
    send({
      t: "result",
      id: message.id,
      ok: false,
      error: {
        code: typeof err?.code === "string" ? err.code : "ASR_HOST_FAILED",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

type PortLike = {
  start?: () => void;
  postMessage: (message: unknown) => void;
  on: (event: "message", listener: (event: { data: unknown; ports?: PortLike[] }) => void) => void;
};

const parentPort = (process as unknown as { parentPort?: PortLike }).parentPort;

if (parentPort) {
  parentPort.on("message", (event) => {
    const payload = event.data as { t?: string; gtcrnModelPath?: string } | AsrHostRequest | undefined;
    if (payload && typeof payload === "object" && payload.t === "connect") {
      if (typeof payload.gtcrnModelPath === "string") defaultGtcrnPath = payload.gtcrnModelPath;
      const transferred = event.ports?.[0];
      if (transferred) {
        transferred.start?.();
        const send = (reply: AsrHostMessage) => transferred.postMessage(reply);
        transferred.on("message", (msgEvent) => {
          void dispatchRequest(msgEvent.data as AsrHostRequest, send);
        });
        send({ t: "ready", pid: process.pid });
        return;
      }
      parentPort.postMessage({ t: "ready", pid: process.pid } satisfies AsrHostMessage);
      return;
    }
    void dispatchRequest(payload as AsrHostRequest, (reply) => parentPort.postMessage(reply));
  });
} else {
  const send = (reply: AsrHostMessage) => {
    process.send?.(reply);
  };
  process.on("message", (raw: unknown) => {
    const payload = raw as { t?: string; gtcrnModelPath?: string } | AsrHostRequest | undefined;
    if (payload && typeof payload === "object" && payload.t === "connect") {
      if (typeof payload.gtcrnModelPath === "string") defaultGtcrnPath = payload.gtcrnModelPath;
      send({ t: "ready", pid: process.pid });
      return;
    }
    void dispatchRequest(payload as AsrHostRequest, send);
  });
}
