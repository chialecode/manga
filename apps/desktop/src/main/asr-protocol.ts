/**
 * Shared wire types and pure audio/prompt helpers between `asr-service.ts` (main process) and `asr-host.ts`
 * (the isolated `utilityProcess` that loads `sherpa-onnx-node`). Kept free of native and Electron imports so
 * both closures can import it without pulling native bindings into the main bundle.
 */

export const GTCRN_WET_MIX = 0.75;
export const GTCRN_DRY_MIX = 0.25;
export const DEFAULT_ASR_SAMPLE_RATE = 16_000;
export const DEFAULT_ASR_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_ASR_CRASH_WINDOW_MS = 60 * 1000;
export const DEFAULT_ASR_CRASH_THRESHOLD = 2;
export const MAX_ASR_HOTWORDS = 50;

export type AsrModelKind = "qwen3Asr" | "senseVoice" | "funasrNano";

export type Qwen3AsrModelFiles = {
  convFrontend: string;
  encoder: string;
  decoder: string;
  tokenizer: string;
};

export type SenseVoiceModelFiles = {
  model: string;
  tokens: string;
};

export type FunasrNanoModelFiles = {
  encoderAdaptor: string;
  llm: string;
  embedding: string;
  tokenizer: string;
};

export type AsrModelFiles =
  | Qwen3AsrModelFiles
  | SenseVoiceModelFiles
  | FunasrNanoModelFiles
  | Readonly<Record<string, string>>;

export type AsrLoadOptions = {
  numThreads?: number;
  force?: boolean;
};

export type AsrRecognizeOptions = {
  sampleRate?: number;
  hotwords?: readonly string[] | string;
  language?: string;
};

export type AsrDenoiseOptions = {
  sampleRate?: number;
  mixRatio?: number;
  gtcrnModelPath?: string;
};

export type AsrLoadResult = {
  loaded: true;
  modelId: string;
  kind: AsrModelKind;
  reused: boolean;
  elapsedMs: number;
  rssBytes: number;
};

export type AsrRecognizeResult = {
  text: string;
  rawText: string;
  tokens: string[];
  timestamps: number[];
  lang: string;
  modelId: string;
  elapsedMs: number;
};

export type AsrDenoiseResult = {
  samples: Float32Array;
  sampleRate: number;
  elapsedMs: number;
};

export type AsrUnloadResult = {
  unloaded: true;
};

export type AsrPingResult = {
  pong: true;
  pid: number;
  version: string;
  onnxruntimeVersion: string;
  loadedModelId: string | null;
  rssBytes: number;
};

export type AsrHostRequest =
  | { t: "call"; id: number; method: "ping"; params?: Record<string, never> }
  | { t: "call"; id: number; method: "load"; params: { modelId: string; kind: AsrModelKind; files: Record<string, string>; numThreads?: number } }
  | { t: "call"; id: number; method: "recognize"; params: { samples: Float32Array; sampleRate: number; hotwords?: readonly string[] | string; language?: string } }
  | { t: "call"; id: number; method: "denoise"; params: { samples: Float32Array; sampleRate: number; mixRatio?: number; gtcrnModelPath?: string } }
  | { t: "call"; id: number; method: "unload"; params?: Record<string, never> }
  | { t: "stop" };

export type AsrHostMessage =
  | { t: "ready"; pid: number }
  | { t: "result"; id: number; ok: true; value: unknown }
  | { t: "result"; id: number; ok: false; error: { code: string; message: string } };

/**
 * Dry/wet linear mix (`0.75 * denoised + 0.25 * raw` by default, per stage-plan 4.2) so speech enhancement never
 * strips soft consonants completely. Preserves the exact length of `raw`.
 */
export function mixDenoisedSamples(raw: Float32Array, denoised: Float32Array, wet = GTCRN_WET_MIX): Float32Array {
  const clampedWet = Math.min(1, Math.max(0, Number.isFinite(wet) ? wet : GTCRN_WET_MIX));
  const dry = 1 - clampedWet;
  const out = new Float32Array(raw.length);
  const common = Math.min(raw.length, denoised.length);
  for (let i = 0; i < common; i += 1) {
    const mixed = clampedWet * denoised[i]! + dry * raw[i]!;
    out[i] = Math.min(1, Math.max(-1, mixed));
  }
  for (let i = common; i < raw.length; i += 1) {
    out[i] = Math.min(1, Math.max(-1, raw[i]!));
  }
  return out;
}

/**
 * Normalizes hotwords into an ASCII comma-separated string (`foo,bar`), which both `qwen3Asr`
 * (`SplitStringAndTrim(csv, ',')`) and `funasrNano` (`ParseHotwordsCsv`) accept per stream.
 */
export function formatHotwordsCsv(hotwords?: readonly string[] | string, maxTerms = MAX_ASR_HOTWORDS): string {
  if (!hotwords) return "";
  const rawList = typeof hotwords === "string" ? hotwords.split(/[,，;；\r\n\t]+/) : hotwords;
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const entry of rawList) {
    if (typeof entry !== "string") continue;
    const term = entry
      .replaceAll(/[,，;；\r\n\t]+/g, " ")
      .replace(/\s*:\s*-?\d+(?:\.\d+)?\s*$/, "")
      .trim();
    const key = term.toLowerCase();
    if (!term || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(term);
    if (cleaned.length >= maxTerms) break;
  }
  return cleaned.join(",");
}

/**
 * Maps canonical BCP-47 / ISO language tags to the exact per-model language string expected by `sherpa-onnx` 2.0.1:
 * - `qwen3Asr`: `"Chinese"` / `"Cantonese"` / `"Japanese"` / `"English"` / `"Korean"`, or `""` for auto-detect;
 * - `funasrNano`: `"中文"` / `"粤语"` / `"日文"` / `"英文"` / `"韩文"`, or `""` for auto-detect (`"语音转写："`);
 * - `senseVoice`: `"zh"` / `"yue"` / `"ja"` / `"en"` / `"ko"` / `"auto"`.
 */
export function normalizeLanguageForModel(kind: AsrModelKind, language?: string): string {
  const trimmed = (language ?? "").trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower === "auto") {
    return kind === "senseVoice" ? "auto" : "";
  }
  const bucket =
    lower === "zh" || lower.startsWith("zh-cn") || lower.startsWith("zh-hans") || lower.startsWith("zh-tw") || lower.startsWith("zh-hant") || lower === "cmn" || trimmed === "中文" || lower === "chinese"
      ? "zh"
      : lower === "yue" || lower.startsWith("zh-hk") || trimmed === "粤语" || lower === "cantonese"
        ? "yue"
        : lower === "ja" || lower.startsWith("ja-") || lower === "jp" || trimmed === "日文" || trimmed === "日语" || lower === "japanese"
          ? "ja"
          : lower === "en" || lower.startsWith("en-") || trimmed === "英文" || trimmed === "英语" || lower === "english"
            ? "en"
            : lower === "ko" || lower.startsWith("ko-") || trimmed === "韩文" || trimmed === "韩语" || lower === "korean"
              ? "ko"
              : null;
  if (!bucket) return trimmed;
  if (kind === "qwen3Asr") {
    return { zh: "Chinese", yue: "Cantonese", ja: "Japanese", en: "English", ko: "Korean" }[bucket];
  }
  if (kind === "funasrNano") {
    return { zh: "中文", yue: "粤语", ja: "日文", en: "英文", ko: "韩文" }[bucket];
  }
  return bucket;
}

/** Coerces structured-cloned typed arrays / buffers across MessagePort or Node IPC back into a `Float32Array`. */
export function toFloat32Array(value: unknown): Float32Array {
  if (value instanceof Float32Array) return value;
  if (value instanceof ArrayBuffer) return new Float32Array(value);
  if (ArrayBuffer.isView(value)) {
    if (value.byteLength % 4 !== 0) throw new TypeError(`PCM byteLength (${value.byteLength}) is not a multiple of 4`);
    if (value.byteOffset % 4 === 0) {
      return new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4);
    }
    const copy = new Uint8Array(value.byteLength);
    copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return new Float32Array(copy.buffer);
  }
  if (Array.isArray(value)) return Float32Array.from(value);
  throw new TypeError("expected Float32Array audio samples");
}
