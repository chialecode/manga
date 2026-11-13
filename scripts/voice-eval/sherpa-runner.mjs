// Portable local `sherpa-onnx-node` recognizer and GTCRN denoiser loader for `scripts/voice-eval/`.
// Resolves native bindings from `apps/desktop/node_modules` without bundling or hardcoding machine paths.

import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EVAL_SAMPLE_RATE, GTCRN_DEFAULT_WET, mixWetDry } from "./audio-dsp.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

export const CATALOG_MODEL_SPECS = [
  {
    id: "sense-voice-funasr-nano-int8",
    kind: "senseVoice",
    supportsHotwords: false,
    candidateDirs: [
      "sense-voice-funasr-nano-int8",
      "sherpa-onnx-sense-voice-funasr-nano-int8-2025-12-17",
    ],
    resolveFiles(dir) {
      const model = path.join(dir, "model.int8.onnx");
      const tokens = path.join(dir, "tokens.txt");
      return fs.existsSync(model) && fs.existsSync(tokens) ? { model, tokens } : null;
    },
  },
  {
    id: "qwen3-asr-0.6B-int8",
    kind: "qwen3Asr",
    supportsHotwords: true,
    candidateDirs: [
      "qwen3-asr-0.6B-int8",
      "sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25",
    ],
    resolveFiles(dir) {
      const convFrontend = path.join(dir, "conv_frontend.onnx");
      const encoder = path.join(dir, "encoder.int8.onnx");
      const decoder = path.join(dir, "decoder.int8.onnx");
      const tokenizer = path.join(dir, "tokenizer");
      return fs.existsSync(convFrontend) &&
        fs.existsSync(encoder) &&
        fs.existsSync(decoder) &&
        fs.existsSync(path.join(tokenizer, "vocab.json"))
        ? { convFrontend, encoder, decoder, tokenizer }
        : null;
    },
  },
  {
    id: "funasr-nano-int8",
    kind: "funasrNano",
    supportsHotwords: true,
    candidateDirs: [
      "funasr-nano-int8",
      "sherpa-onnx-funasr-nano-int8-2025-12-30",
    ],
    resolveFiles(dir) {
      const encoderAdaptor = path.join(dir, "encoder_adaptor.int8.onnx");
      const llm = path.join(dir, "llm.int8.onnx");
      const embedding = path.join(dir, "embedding.int8.onnx");
      const tokenizer = path.join(dir, "Qwen3-0.6B");
      return fs.existsSync(encoderAdaptor) &&
        fs.existsSync(llm) &&
        fs.existsSync(embedding) &&
        fs.existsSync(path.join(tokenizer, "vocab.json"))
        ? { encoderAdaptor, llm, embedding, tokenizer }
        : null;
    },
  },
];

let cachedSherpa = null;

export function loadSherpaAddon() {
  if (cachedSherpa) return cachedSherpa;
  const candidateNodeModules = [
    path.join(repoRoot, "apps/desktop/node_modules"),
    path.join(repoRoot, "node_modules"),
  ];
  if (process.platform === "win32") {
    for (const nm of candidateNodeModules) {
      const winBin = path.join(nm, "sherpa-onnx-win-x64");
      if (fs.existsSync(path.join(winBin, "sherpa-onnx.node"))) {
        const curPath = process.env.PATH ?? process.env.Path ?? "";
        if (!curPath.toLowerCase().includes(winBin.toLowerCase())) {
          process.env.PATH = curPath ? `${winBin};${curPath}` : winBin;
        }
        break;
      }
    }
  }
  for (const nm of candidateNodeModules) {
    const entry = path.join(nm, "sherpa-onnx-node", "sherpa-onnx.js");
    if (fs.existsSync(entry)) {
      const req = createRequire(entry);
      cachedSherpa = req(entry);
      return cachedSherpa;
    }
  }
  return null;
}

export function discoverModelSearchRoots() {
  const roots = [];
  const envDirs = process.env.MANGA_ASR_MODELS_DIR;
  if (envDirs) {
    for (const part of envDirs.split(path.delimiter)) {
      const trimmed = part.trim();
      if (trimmed && fs.existsSync(trimmed)) roots.push(path.resolve(trimmed));
    }
  }
  const distToolsAsr = path.join(repoRoot, "dist/tools/asr");
  if (fs.existsSync(distToolsAsr)) roots.push(distToolsAsr);

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    for (const appFolder of ["manga", "manga-dev"]) {
      const installedDir = path.join(localAppData, appFolder, "models", "asr");
      if (fs.existsSync(installedDir)) roots.push(installedDir);
    }
  }
  return roots;
}

export function discoverAvailableModels() {
  const searchRoots = discoverModelSearchRoots();
  const discovered = [];
  for (const spec of CATALOG_MODEL_SPECS) {
    let resolved = null;
    for (const rootDir of searchRoots) {
      const direct = spec.resolveFiles(rootDir);
      if (direct) {
        resolved = { ...spec, files: direct };
        break;
      }
      for (const sub of spec.candidateDirs) {
        const candidatePath = path.join(rootDir, sub);
        if (!fs.existsSync(candidatePath)) continue;
        const files = spec.resolveFiles(candidatePath);
        if (files) {
          resolved = { ...spec, files };
          break;
        }
      }
      if (resolved) break;
    }
    discovered.push(resolved ?? { ...spec, files: null });
  }
  return discovered;
}

export function locateGtcrnModelPath() {
  const candidates = [
    process.env.MANGA_GTCRN_MODEL_PATH,
    path.join(repoRoot, "dist/tools/gtcrn/gtcrn_simple.onnx"),
  ];
  for (const rootDir of discoverModelSearchRoots()) {
    candidates.push(
      path.join(rootDir, "gtcrn_simple.onnx"),
      path.join(rootDir, "gtcrn", "gtcrn_simple.onnx"),
      path.join(path.dirname(rootDir), "gtcrn_simple.onnx"),
      path.join(path.dirname(rootDir), "gtcrn", "gtcrn_simple.onnx"),
    );
  }
  for (const file of candidates) {
    if (file && fs.existsSync(file)) return path.resolve(file);
  }
  return null;
}

export function defaultInferenceThreads() {
  const cores = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, Math.floor(cores / 2) || 2));
}

export function buildSherpaRecognizerConfig(kind, files, numThreads = defaultInferenceThreads()) {
  const baseModelConfig = {
    numThreads,
    provider: "cpu",
    debug: 0,
  };
  if (kind === "qwen3Asr") {
    return {
      featConfig: { sampleRate: EVAL_SAMPLE_RATE, featureDim: 128 },
      decodingMethod: "greedy_search",
      modelConfig: {
        ...baseModelConfig,
        qwen3Asr: {
          convFrontend: files.convFrontend,
          encoder: files.encoder,
          decoder: files.decoder,
          tokenizer: files.tokenizer,
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
    return {
      featConfig: { sampleRate: EVAL_SAMPLE_RATE, featureDim: 80 },
      decodingMethod: "greedy_search",
      modelConfig: {
        ...baseModelConfig,
        funasrNano: {
          encoderAdaptor: files.encoderAdaptor,
          llm: files.llm,
          embedding: files.embedding,
          tokenizer: files.tokenizer,
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
    return {
      featConfig: { sampleRate: EVAL_SAMPLE_RATE, featureDim: 80 },
      decodingMethod: "greedy_search",
      modelConfig: {
        ...baseModelConfig,
        tokens: files.tokens,
        senseVoice: {
          model: files.model,
          language: "auto",
          useInverseTextNormalization: 1,
        },
      },
    };
  }
  throw new Error(`Unsupported recognizer kind: ${kind}`);
}

export async function createLocalRecognizer(spec, numThreads = defaultInferenceThreads()) {
  const sherpa = loadSherpaAddon();
  if (!sherpa) throw new Error("sherpa-onnx-node addon is not installed");
  const t0 = performance.now();
  const config = buildSherpaRecognizerConfig(spec.kind, spec.files, numThreads);
  const recognizer = await sherpa.OfflineRecognizer.createAsync(config);
  const loadMs = Math.round((performance.now() - t0) * 100) / 100;

  return {
    id: spec.id,
    kind: spec.kind,
    supportsHotwords: spec.supportsHotwords,
    loadMs,
    async recognize(samples, { sampleRate = EVAL_SAMPLE_RATE, hotwordsCsv = "", language = "zh" } = {}) {
      const started = performance.now();
      const stream = recognizer.createStream();
      if (spec.kind === "qwen3Asr") {
        stream.setOption("hotwords", hotwordsCsv);
        if (language === "zh") stream.setOption("language", "Chinese");
      } else if (spec.kind === "funasrNano") {
        stream.setOption("hotwords", hotwordsCsv);
        stream.setOption("itn", "1");
        if (language === "zh") stream.setOption("language", "中文");
      } else if (spec.kind === "senseVoice") {
        stream.setOption("use_itn", "1");
      }
      stream.acceptWaveform({ samples, sampleRate });
      const res = await recognizer.decodeAsync(stream);
      const rawText = typeof res?.text === "string" ? res.text : "";
      return {
        text: rawText.trim(),
        rawText,
        elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      };
    },
  };
}

export function createGtcrnDenoiser(modelPath = locateGtcrnModelPath(), numThreads = 2) {
  const sherpa = loadSherpaAddon();
  if (!sherpa || !modelPath) return null;
  const denoiser = new sherpa.OfflineSpeechDenoiser({
    model: {
      gtcrn: { model: modelPath },
      numThreads,
      provider: "cpu",
      debug: 0,
    },
  });
  return {
    denoise(rawSamples, { sampleRate = EVAL_SAMPLE_RATE, wet = GTCRN_DEFAULT_WET } = {}) {
      const started = performance.now();
      const enhanced = denoiser.run({
        samples: rawSamples,
        sampleRate,
        enableExternalBuffer: false,
      });
      const mixed = wet >= 0.999 ? enhanced.samples : mixWetDry(rawSamples, enhanced.samples, wet);
      return {
        samples: mixed,
        denoisedOnly: enhanced.samples,
        elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      };
    },
  };
}
