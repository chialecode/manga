import path from "node:path";
import type { LocalAsrModelSource } from "@manga/contracts";

export const ASR_CATALOG_QUERY_DATE = "2026-11-13";

export const ALLOWED_MODEL_DOWNLOAD_HOSTS = [
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
] as const;

export type AsrCatalogModelKind = "qwen3Asr" | "senseVoice" | "funasrNano";

export type AsrModelRequiredFile = {
  /** POSIX-style path relative to the extracted model directory. */
  path: string;
  byteSize: number;
  sha256: string;
  /** Logical role mapped into `AsrService.load` file paths (`tokenizerDir/*` resolves to the parent directory). */
  configRole: string;
};

export type AsrCatalogModel = {
  id: string;
  modelId: string;
  name: string;
  kind: AsrCatalogModelKind;
  recommended: boolean;
  license: string;
  licenseUrl: string;
  upstreamDocsUrl: string;
  languages: readonly string[];
  hotwords: number;
  archiveName: string;
  archiveBytes: number;
  archiveSha256: string;
  topLevelDirectory: string;
  sources: readonly LocalAsrModelSource[];
  requiredFiles: readonly AsrModelRequiredFile[];
};

/**
 * Verified offline speech recognition model catalog (`sherpa-onnx` `asr-models` release).
 * Every byte size and SHA-256 digest was computed against the upstream `.tar.bz2` archives and extracted ONNX/tokenizer files.
 * Production entries list only verified GitHub Release URLs; `sources` remains an ordered list so mirror fallback and
 * explicit `sourceId` selection work seamlessly when additional verified mirrors are configured.
 */
export const ASR_MODEL_CATALOG: readonly AsrCatalogModel[] = [
  {
    id: "qwen3-asr-0.6B-int8",
    modelId: "qwen3-asr-0.6B-int8",
    name: "Qwen3-ASR 0.6B (int8)",
    kind: "qwen3Asr",
    recommended: true,
    license: "Apache-2.0",
    licenseUrl: "https://huggingface.co/Qwen/Qwen3-ASR-0.6B",
    upstreamDocsUrl: "https://k2-fsa.github.io/sherpa/onnx/qwen3-asr/index.html",
    languages: ["zh", "yue", "en", "ja", "ko", "auto"],
    hotwords: 50,
    archiveName: "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2",
    archiveBytes: 878_702_423,
    archiveSha256: "393f8a14e2f5fb96746aaab342997a40641001fbd5bf9592a080a8329178ee96",
    topLevelDirectory: "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
    sources: [
      {
        id: "github",
        label: "GitHub Releases",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2",
      },
    ],
    requiredFiles: [
      {
        path: "conv_frontend.onnx",
        byteSize: 44_148_281,
        sha256: "d22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e",
        configRole: "convFrontend",
      },
      {
        path: "encoder.int8.onnx",
        byteSize: 182_491_662,
        sha256: "60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9",
        configRole: "encoder",
      },
      {
        path: "decoder.int8.onnx",
        byteSize: 755_914_231,
        sha256: "4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771",
        configRole: "decoder",
      },
      {
        path: "tokenizer/vocab.json",
        byteSize: 2_776_833,
        sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
        configRole: "tokenizerDir/vocab",
      },
      {
        path: "tokenizer/merges.txt",
        byteSize: 1_671_853,
        sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
        configRole: "tokenizerDir/merges",
      },
      {
        path: "tokenizer/tokenizer_config.json",
        byteSize: 12_487,
        sha256: "4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c",
        configRole: "tokenizerDir/config",
      },
    ],
  },
  {
    id: "sense-voice-funasr-nano-int8",
    modelId: "sense-voice-funasr-nano-int8",
    name: "SenseVoice Fun-ASR-Nano (int8)",
    kind: "senseVoice",
    recommended: false,
    license: "Apache-2.0",
    licenseUrl: "https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-2512",
    upstreamDocsUrl: "https://k2-fsa.github.io/sherpa/onnx/sense-voice/index.html",
    languages: ["zh", "yue", "en", "ja", "ko", "auto"],
    hotwords: 0,
    archiveName: "sherpa-onnx-sense-voice-funasr-nano-int8-2025-12-17.tar.bz2",
    archiveBytes: 187_693_225,
    archiveSha256: "257936ea9a64cbe33200274e6367fc26d373ff6ca58b996b15108ffd6b9f6148",
    topLevelDirectory: "sherpa-onnx-sense-voice-funasr-nano-int8-2025-12-17",
    sources: [
      {
        id: "github",
        label: "GitHub Releases",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-funasr-nano-int8-2025-12-17.tar.bz2",
      },
    ],
    requiredFiles: [
      {
        path: "model.int8.onnx",
        byteSize: 263_531_902,
        sha256: "9dc6e72aa8bc6f5966cf2857a0ce3a425b1d72e91500e147d66329f407c017a1",
        configRole: "model",
      },
      {
        path: "tokens.txt",
        byteSize: 939_815,
        sha256: "2db4bb25d046e8849e336c9465e248e1694914d996c58c71bdeca18cfb722992",
        configRole: "tokens",
      },
    ],
  },
  {
    id: "funasr-nano-int8",
    modelId: "funasr-nano-int8",
    name: "Fun-ASR-Nano 2512 (int8)",
    kind: "funasrNano",
    recommended: false,
    license: "Apache-2.0",
    licenseUrl: "https://huggingface.co/FunAudioLLM/Fun-ASR-Nano-2512",
    upstreamDocsUrl: "https://k2-fsa.github.io/sherpa/onnx/funasr-nano/index.html",
    languages: ["zh", "yue", "en", "ja", "ko", "auto"],
    hotwords: 50,
    archiveName: "sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2",
    archiveBytes: 841_730_611,
    archiveSha256: "eb43d7ccc2e86b243f6a03b7df361033dda66db9523d1a92bf6aca2b50c9476b",
    topLevelDirectory: "sherpa-onnx-funasr-nano-int8-2025-12-30",
    sources: [
      {
        id: "github",
        label: "GitHub Releases",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-funasr-nano-int8-2025-12-30.tar.bz2",
      },
    ],
    requiredFiles: [
      {
        path: "encoder_adaptor.int8.onnx",
        byteSize: 238_277_200,
        sha256: "d0246c823f2c34133ae0efee395d8a189c8f92643e3432f866939ee34d34492c",
        configRole: "encoderAdaptor",
      },
      {
        path: "llm.int8.onnx",
        byteSize: 600_339_316,
        sha256: "7f0c5a508b41474b1b1ec1cdbdefafd2cf8b3642c6915a0a425265b7b7d2c960",
        configRole: "llm",
      },
      {
        path: "embedding.int8.onnx",
        byteSize: 155_583_106,
        sha256: "a05d2816e284fcca29a5dccb2c14b9edeb638fd983a84cd4a447248889b6a408",
        configRole: "embedding",
      },
      {
        path: "Qwen3-0.6B/vocab.json",
        byteSize: 2_776_833,
        sha256: "ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910",
        configRole: "tokenizerDir/vocab",
      },
      {
        path: "Qwen3-0.6B/merges.txt",
        byteSize: 1_671_853,
        sha256: "8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5",
        configRole: "tokenizerDir/merges",
      },
      {
        path: "Qwen3-0.6B/tokenizer.json",
        byteSize: 11_422_654,
        sha256: "aeb13307a71acd8fe81861d94ad54ab689df773318809eed3cbe794b4492dae4",
        configRole: "tokenizerDir/tokenizer",
      },
    ],
  },
] as const;

export function getCatalogModel(
  modelId: string,
  catalog: readonly AsrCatalogModel[] = ASR_MODEL_CATALOG,
): AsrCatalogModel | undefined {
  return catalog.find((entry) => entry.modelId === modelId || entry.id === modelId);
}

/**
 * Resolves the concrete filesystem paths inside `installDir` expected by `AsrService.load`.
 * Roles prefixed with `tokenizerDir/` collapse to their shared tokenizer directory path.
 */
export function resolveModelRuntimeFiles(model: AsrCatalogModel, installDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  for (const req of model.requiredFiles) {
    const segments = req.path.split("/").filter(Boolean);
    if (req.configRole.startsWith("tokenizerDir/")) {
      const dirSegments = segments.slice(0, -1);
      files.tokenizer = path.join(installDir, ...dirSegments);
    } else {
      files[req.configRole] = path.join(installDir, ...segments);
    }
  }
  return files;
}

export function sumRequiredModelBytes(model: AsrCatalogModel): number {
  return model.requiredFiles.reduce((acc, item) => acc + item.byteSize, 0);
}
