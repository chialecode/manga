#!/usr/bin/env node
// Offline voice dictation evaluation runner & 4.2 frontend switch comparison (`stage-plan.md` 4.2, 4.11, 7).
// Evaluates installed local ASR models across `asr_only -> asr_plus_correct -> asr_plus_polish`
// and compares capture frontend switches (`browserNoiseSuppression`, `autoGainControl`, `gtcrnDenoise` 0.75 mix vs 1.0 full vs off).
// Live LLM polish runs ONLY when `MANGA_LIVE_VOICE_EVAL_LLM=1` AND `.env.local` configures `MANGA_TEST_LLM_*`.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PhoneticCorrector } from "../../packages/app-core/src/voice/correct/index.ts";
import { DictationPolisher } from "../../packages/app-core/src/voice/polish/index.ts";
import {
  EVAL_SAMPLE_RATE,
  GTCRN_DEFAULT_WET,
  applyAutoGainControl,
  applyBrowserHighNoiseSuppression,
  decodeWavMono16,
  mixWetDry,
} from "./audio-dsp.mjs";
import { generateVoiceEvalCorpus } from "./generate-corpus.mjs";
import { evaluateRecords, summarizeTimings } from "./metrics.mjs";
import {
  createGtcrnDenoiser,
  createLocalRecognizer,
  discoverAvailableModels,
  loadSherpaAddon,
} from "./sherpa-runner.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const corpusPath = path.join(scriptDir, "corpus.json");
const evalDir = path.join(repoRoot, "dist/samples/voice-eval");
const manifestPath = path.join(evalDir, "manifest.json");
const asrCachePath = path.join(evalDir, "asr-cache.json");
const defaultResultsPath = path.join(evalDir, "eval-results.json");

const VARIANTS = ["clean", "fan10db", "speech10db"];

/**
 * Reads ONLY `MANGA_TEST_LLM_*` keys when `MANGA_LIVE_VOICE_EVAL_LLM === "1"`.
 * Never prints or records any value from `.env.local`.
 */
function resolveAuthorizedLiveLlmConfig() {
  if (process.env.MANGA_LIVE_VOICE_EVAL_LLM !== "1") {
    return { authorized: false, reason: "no live LLM eval authorization" };
  }
  const wantedKeys = new Set([
    "MANGA_TEST_LLM_API_BASE_URL",
    "MANGA_TEST_LLM_API_KEY",
    "MANGA_TEST_LLM_MODEL_ID",
    "MANGA_TEST_LLM_PROTOCOL",
  ]);
  const envMap = new Map();
  const envFile = path.join(repoRoot, ".env.local");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      const eq = trimmed.indexOf("=");
      if (!trimmed || trimmed.startsWith("#") || eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!wantedKeys.has(key)) continue;
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      envMap.set(key, val);
    }
  }
  const getVal = (k) => process.env[k] ?? envMap.get(k) ?? "";
  const baseUrl = getVal("MANGA_TEST_LLM_API_BASE_URL").replace(/\/+$/, "");
  const apiKey = getVal("MANGA_TEST_LLM_API_KEY");
  const modelId = getVal("MANGA_TEST_LLM_MODEL_ID");
  const protocol = getVal("MANGA_TEST_LLM_PROTOCOL") || "openai-chat-completions";
  if (!baseUrl || !apiKey || !modelId) {
    return { authorized: false, reason: "MANGA_TEST_LLM_* unconfigured in local environment" };
  }
  return { authorized: true, baseUrl, apiKey, modelId, protocol };
}

function createLivePolishClient(llmCfg) {
  const connectionStub = {
    id: "live-eval-llm",
    baseUrl: llmCfg.baseUrl,
    apiKey: llmCfg.apiKey,
    modelId: llmCfg.modelId,
    protocol: llmCfg.protocol,
    timeoutMs: 5000,
  };
  return {
    resolve() {
      return connectionStub;
    },
    async complete(_conn, req) {
      const isResponses = llmCfg.protocol === "openai-responses";
      const endpoint = isResponses ? `${llmCfg.baseUrl}/responses` : `${llmCfg.baseUrl}/chat/completions`;
      const body = isResponses
        ? {
            model: llmCfg.modelId,
            instructions: req.system,
            input: req.user,
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          }
        : {
            model: llmCfg.modelId,
            messages: [
              { role: "system", content: req.system },
              { role: "user", content: req.user },
            ],
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          };
      const resp = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${llmCfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
      if (!resp.ok) {
        throw new Error(`LLM HTTP ${resp.status}`);
      }
      const json = await resp.json();
      if (isResponses) {
        const text = typeof json.output_text === "string" ? json.output_text : "";
        return { text };
      }
      const content = json?.choices?.[0]?.message?.content;
      return { text: typeof content === "string" ? content : "" };
    },
  };
}

function attenuateSamples(samples, gainLinear) {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = samples[i] * gainLinear;
  }
  return out;
}

export async function runVoiceEvaluation({ useCache = true, outPaths = [defaultResultsPath], skipSwitches = false } = {}) {
  const corpusGen = generateVoiceEvalCorpus({ force: false, verifyOnly: false });
  if (corpusGen.status === "not-run") {
    const notRun = {
      schema: 1,
      status: "not-run",
      reason: corpusGen.reason,
      evaluatedAt: new Date().toISOString(),
    };
    for (const outFile of outPaths) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, `${JSON.stringify(notRun, null, 2)}\n`, "utf8");
    }
    return notRun;
  }

  const sherpa = loadSherpaAddon();
  if (!sherpa) {
    const noAddon = {
      schema: 1,
      status: "not-run",
      reason: "sherpa-onnx-node native addon is not installed",
      evaluatedAt: new Date().toISOString(),
    };
    for (const outFile of outPaths) {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, `${JSON.stringify(noAddon, null, 2)}\n`, "utf8");
    }
    return noAddon;
  }

  const corpus = JSON.parse(fs.readFileSync(corpusPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const workTitles = new Map(corpus.works.map((w) => [w.id, w.title]));
  const correctorEntries = corpus.dictionary.map((d) => ({
    id: d.id,
    scope: d.scope,
    workId: d.workId,
    workTitle: d.workId ? (workTitles.get(d.workId) ?? null) : null,
    term: d.term,
    category: d.category,
    source: d.source,
    disabled: Boolean(d.disabled),
    aliases: d.aliases ?? [],
    blocked: d.blocked ?? [],
  }));

  const corrector = new PhoneticCorrector();
  corrector.setTerms(correctorEntries);

  const llmConfig = resolveAuthorizedLiveLlmConfig();
  const polisher = llmConfig.authorized ? new DictationPolisher({ llm: createLivePolishClient(llmConfig) }) : null;

  let cachedHarvest = null;
  if (useCache && fs.existsSync(asrCachePath)) {
    try {
      cachedHarvest = JSON.parse(fs.readFileSync(asrCachePath, "utf8"));
    } catch {
      cachedHarvest = null;
    }
  }

  const discoveredModels = discoverAvailableModels();
  const modelEvaluations = {};
  let updatedCacheModels = { ...(cachedHarvest?.models ?? {}) };
  let cacheDirty = false;

  for (const spec of discoveredModels) {
    const cachedModel = updatedCacheModels[spec.id];
    const hasCompleteValidCache =
      Boolean(cachedModel) &&
      VARIANTS.every((v) =>
        manifest.items.every(
          (item) =>
            cachedModel.results?.[v]?.[item.id] &&
            cachedModel.results[v][item.id].wavSha256 === item.sha256[v],
        ),
      );

    if (!spec.files && !hasCompleteValidCache) {
      modelEvaluations[spec.id] = {
        status: "not-installed",
        kind: spec.kind,
        supportsHotwords: spec.supportsHotwords,
      };
      continue;
    }

    let modelHarvest = cachedModel;
    if (!hasCompleteValidCache) {
      const rec = await createLocalRecognizer(spec);
      const results = {};
      const hotwordCleanResults = {};
      for (const variant of VARIANTS) {
        results[variant] = {};
        for (const item of manifest.items) {
          const wavBytes = fs.readFileSync(path.join(evalDir, item.files[variant]));
          const decoded = decodeWavMono16(wavBytes);
          const out = await rec.recognize(decoded.float32, {
            sampleRate: decoded.sampleRate,
            hotwordsCsv: "",
            language: "zh",
          });
          results[variant][item.id] = {
            text: out.text,
            elapsedMs: out.elapsedMs,
            wavSha256: item.sha256[variant],
          };
        }
      }
      if (spec.supportsHotwords) {
        for (const item of manifest.items) {
          const sent = corpus.sentences.find((s) => s.id === item.id);
          if (!sent || sent.group !== "A") continue;
          const hotwords = corpus.dictionary
            .filter((d) => !d.disabled && (d.scope === "global" || d.workId === sent.workId))
            .map((d) => d.term)
            .slice(0, 50)
            .join(",");
          const wavBytes = fs.readFileSync(path.join(evalDir, item.files.clean));
          const decoded = decodeWavMono16(wavBytes);
          const out = await rec.recognize(decoded.float32, {
            sampleRate: decoded.sampleRate,
            hotwordsCsv: hotwords,
            language: "zh",
          });
          hotwordCleanResults[item.id] = { text: out.text, elapsedMs: out.elapsedMs };
        }
      }
      modelHarvest = {
        modelId: spec.id,
        kind: spec.kind,
        supportsHotwords: spec.supportsHotwords,
        loadMs: rec.loadMs,
        rssBytes: process.memoryUsage().rss,
        results,
        hotwordCleanResults,
      };
      updatedCacheModels[spec.id] = modelHarvest;
      cacheDirty = true;
    }

    const byVariant = {};
    const allAsrRecords = [];
    const allCorrectRecords = [];
    const allPolishRecords = [];
    const allAsrMs = [];
    const allCorrectMs = [];
    const allPolishMs = [];

    for (const variant of VARIANTS) {
      const asrRecords = [];
      const correctRecords = [];
      const polishRecords = [];
      const variantAsrMs = [];
      const variantCorrectMs = [];
      const variantPolishMs = [];

      for (const sent of corpus.sentences) {
        const rawEntry = modelHarvest.results[variant][sent.id];
        const rawText = rawEntry.text;
        variantAsrMs.push(rawEntry.elapsedMs);
        allAsrMs.push(rawEntry.elapsedMs);

        const asrRec = {
          id: sent.id,
          group: sent.group,
          referenceText: sent.spokenText,
          expectedEntities: sent.spokenEntities,
          baselineRawText: rawText,
          outputText: rawText,
          candidateTerms: [],
        };
        asrRecords.push(asrRec);
        allAsrRecords.push(asrRec);

        const corrOut = corrector.correct(rawText, { currentWorkId: sent.workId });
        variantCorrectMs.push(corrOut.elapsedMs);
        allCorrectMs.push(corrOut.elapsedMs);

        const corrRec = {
          id: sent.id,
          group: sent.group,
          referenceText: sent.spokenText,
          expectedEntities: sent.spokenEntities,
          baselineRawText: rawText,
          outputText: corrOut.correctedText,
          candidateTerms: corrOut.candidates.map((c) => c.term),
        };
        correctRecords.push(corrRec);
        allCorrectRecords.push(corrRec);

        if (polisher) {
          const activeTerms = corpus.dictionary
            .filter((d) => !d.disabled && (d.scope === "global" || d.workId === sent.workId))
            .map((d) => d.term);
          const polOut = await polisher.polish({
            correctedText: corrOut.correctedText,
            mode: "light",
            chineseVariant: "simplified",
            candidates: corrOut.candidates,
            dictionaryTerms: activeTerms,
          });
          variantPolishMs.push(polOut.elapsedMs);
          allPolishMs.push(polOut.elapsedMs);

          const polRec = {
            id: sent.id,
            group: sent.group,
            referenceText: sent.polishedText,
            expectedEntities: sent.finalEntities,
            baselineRawText: rawText,
            outputText: polOut.finalText,
            candidateTerms: [],
          };
          polishRecords.push(polRec);
          allPolishRecords.push(polRec);
        }
      }

      byVariant[variant] = {
        asr_only: {
          ...evaluateRecords(asrRecords, { checkFalseModifyAgainstBaseline: false }),
          timings: summarizeTimings(variantAsrMs),
        },
        asr_plus_correct: {
          ...evaluateRecords(correctRecords, { checkFalseModifyAgainstBaseline: true }),
          timings: summarizeTimings(variantCorrectMs),
        },
        asr_plus_polish: polisher
          ? {
              status: "evaluated",
              ...evaluateRecords(polishRecords, { checkFalseModifyAgainstBaseline: true }),
              timings: summarizeTimings(variantPolishMs),
            }
          : {
              status: "not-run",
              reason: llmConfig.reason,
            },
      };
    }

    // Optional Layer 1 hotword diagnostic on Group A clean
    let hotwordGroupAClean = undefined;
    if (spec.supportsHotwords && modelHarvest.hotwordCleanResults && Object.keys(modelHarvest.hotwordCleanResults).length > 0) {
      const hwAsrRecs = [];
      const hwPlusCorrRecs = [];
      for (const sent of corpus.sentences.filter((s) => s.group === "A")) {
        const hwEntry = modelHarvest.hotwordCleanResults[sent.id];
        if (!hwEntry) continue;
        const corrOut = corrector.correct(hwEntry.text, { currentWorkId: sent.workId });
        hwAsrRecs.push({
          id: sent.id,
          group: sent.group,
          referenceText: sent.spokenText,
          expectedEntities: sent.spokenEntities,
          baselineRawText: hwEntry.text,
          outputText: hwEntry.text,
          candidateTerms: [],
        });
        hwPlusCorrRecs.push({
          id: sent.id,
          group: sent.group,
          referenceText: sent.spokenText,
          expectedEntities: sent.spokenEntities,
          baselineRawText: hwEntry.text,
          outputText: corrOut.correctedText,
          candidateTerms: corrOut.candidates.map((c) => c.term),
        });
      }
      hotwordGroupAClean = {
        asr_with_hotwords: evaluateRecords(hwAsrRecs),
        asr_with_hotwords_plus_correct: evaluateRecords(hwPlusCorrRecs),
      };
    }

    modelEvaluations[spec.id] = {
      status: "evaluated",
      kind: spec.kind,
      supportsHotwords: spec.supportsHotwords,
      coldLoadMs: modelHarvest.loadMs,
      rssMiB: Number((modelHarvest.rssBytes / (1024 * 1024)).toFixed(2)),
      overall240: {
        asr_only: {
          ...evaluateRecords(allAsrRecords, { checkFalseModifyAgainstBaseline: false }),
          timings: summarizeTimings(allAsrMs),
        },
        asr_plus_correct: {
          ...evaluateRecords(allCorrectRecords, { checkFalseModifyAgainstBaseline: true }),
          timings: summarizeTimings(allCorrectMs),
        },
        asr_plus_polish: polisher
          ? {
              status: "evaluated",
              ...evaluateRecords(allPolishRecords, { checkFalseModifyAgainstBaseline: true }),
              timings: summarizeTimings(allPolishMs),
            }
          : {
              status: "not-run",
              reason: llmConfig.reason,
            },
      },
      byVariant,
      ...(hotwordGroupAClean ? { hotwordGroupAClean } : {}),
    };
  }

  if (cacheDirty) {
    fs.writeFileSync(
      asrCachePath,
      `${JSON.stringify({ schema: 1, generatedAt: new Date().toISOString(), models: updatedCacheModels }, null, 2)}\n`,
      "utf8",
    );
  }

  // ---------------------------------------------------------------------------
  // Section 4.2 Capture Frontend Switch Comparison
  // Evaluates `browserNoiseSuppression` (off vs kHigh on), `autoGainControl` (on vs off),
  // and `gtcrnDenoise` (off vs 0.75*wet+0.25*dry vs 1.0*wet) across `clean`, `fan10db`, `speech10db`, and `quietClean` (-22 dBFS).
  // ---------------------------------------------------------------------------
  let switchComparison = { status: "not-run", reason: "skipped or model unavailable" };
  const senseSpec = discoveredModels.find((m) => m.id === "sense-voice-funasr-nano-int8" && m.files);
  const denoiser = !skipSwitches ? createGtcrnDenoiser() : null;

  if (!skipSwitches && senseSpec && denoiser) {
    const rec = await createLocalRecognizer(senseSpec);
    const acousticConditions = ["clean", "fan10db", "speech10db", "quietClean"];
    const switchConfigs = [
      {
        id: "capture_default",
        label: "browserNS=off, AGC=on, GTCRN=off (default)",
        browserNoiseSuppression: false,
        autoGainControl: true,
        gtcrnDenoise: "off",
      },
      {
        id: "browser_ns_on",
        label: "browserNS=on (kHigh), AGC=on, GTCRN=off",
        browserNoiseSuppression: true,
        autoGainControl: true,
        gtcrnDenoise: "off",
      },
      {
        id: "agc_off",
        label: "browserNS=off, AGC=off, GTCRN=off",
        browserNoiseSuppression: false,
        autoGainControl: false,
        gtcrnDenoise: "off",
      },
      {
        id: "gtcrn_mix_075",
        label: "browserNS=off, AGC=on, GTCRN=0.75*wet+0.25*dry",
        browserNoiseSuppression: false,
        autoGainControl: true,
        gtcrnDenoise: "0.75*wet+0.25*dry",
      },
      {
        id: "gtcrn_full_100",
        label: "browserNS=off, AGC=on, GTCRN=1.0*wet",
        browserNoiseSuppression: false,
        autoGainControl: true,
        gtcrnDenoise: "1.0*wet",
      },
    ];

    const profiles = {};
    for (const cfg of switchConfigs) {
      profiles[cfg.id] = {
        label: cfg.label,
        switches: {
          browserNoiseSuppression: cfg.browserNoiseSuppression,
          autoGainControl: cfg.autoGainControl,
          gtcrnDenoise: cfg.gtcrnDenoise,
        },
        conditions: {},
      };
    }

    for (const cond of acousticConditions) {
      const sourceVariant = cond === "quietClean" ? "clean" : cond;
      const condBuckets = Object.fromEntries(
        switchConfigs.map((c) => [c.id, { asr: [], corr: [], denoiseMs: [] }]),
      );

      for (const item of manifest.items) {
        const sent = corpus.sentences.find((s) => s.id === item.id);
        const wavBytes = fs.readFileSync(path.join(evalDir, item.files[sourceVariant]));
        const decoded = decodeWavMono16(wavBytes);
        // `quietClean` attenuates clean speech by -22 dB (0.0794x, peak ~ -27 dBFS) to test AGC on vs off on quiet speech.
        const rawInput = cond === "quietClean" ? attenuateSamples(decoded.float32, 0.07943) : decoded.float32;

        const agcOnSamples = applyAutoGainControl(rawInput, EVAL_SAMPLE_RATE);
        // Compute GTCRN once per clip over the AGC-on stream so `0.75*wet+0.25*dry` and `1.0*wet` share the exact ONNX pass.
        const gtcrnPass = denoiser.denoise(agcOnSamples, { sampleRate: EVAL_SAMPLE_RATE, wet: 1.0 });
        const gtcrnMix075 = mixWetDry(agcOnSamples, gtcrnPass.denoisedOnly, GTCRN_DEFAULT_WET);

        for (const cfg of switchConfigs) {
          let processed;
          if (cfg.id === "capture_default") {
            processed = agcOnSamples;
          } else if (cfg.id === "agc_off") {
            processed = rawInput;
          } else if (cfg.id === "browser_ns_on") {
            processed = applyAutoGainControl(applyBrowserHighNoiseSuppression(rawInput), EVAL_SAMPLE_RATE);
          } else if (cfg.id === "gtcrn_mix_075") {
            processed = gtcrnMix075;
            condBuckets[cfg.id].denoiseMs.push(gtcrnPass.elapsedMs);
          } else {
            processed = gtcrnPass.denoisedOnly;
            condBuckets[cfg.id].denoiseMs.push(gtcrnPass.elapsedMs);
          }

          const asrOut = await rec.recognize(processed, {
            sampleRate: EVAL_SAMPLE_RATE,
            hotwordsCsv: "",
            language: "zh",
          });
          const corrOut = corrector.correct(asrOut.text, { currentWorkId: sent.workId });

          condBuckets[cfg.id].asr.push({
            id: sent.id,
            group: sent.group,
            referenceText: sent.spokenText,
            expectedEntities: sent.spokenEntities,
            baselineRawText: asrOut.text,
            outputText: asrOut.text,
            candidateTerms: [],
          });
          condBuckets[cfg.id].corr.push({
            id: sent.id,
            group: sent.group,
            referenceText: sent.spokenText,
            expectedEntities: sent.spokenEntities,
            baselineRawText: asrOut.text,
            outputText: corrOut.correctedText,
            candidateTerms: corrOut.candidates.map((c) => c.term),
          });
        }
      }

      for (const cfg of switchConfigs) {
        const b = condBuckets[cfg.id];
        profiles[cfg.id].conditions[cond] = {
          asr_only: evaluateRecords(b.asr, { checkFalseModifyAgainstBaseline: false }),
          asr_plus_correct: evaluateRecords(b.corr, { checkFalseModifyAgainstBaseline: true }),
          ...(b.denoiseMs.length > 0 ? { gtcrnDenoiseTimings: summarizeTimings(b.denoiseMs) } : {}),
        };
      }
    }

    switchComparison = {
      status: "evaluated",
      asrModelId: senseSpec.id,
      gtcrnWetMixConstant: GTCRN_DEFAULT_WET,
      notes:
        "browserNoiseSuppression models WebRTC kHigh spectral over-subtraction; autoGainControl models causal 10 ms RMS digital AGC2; gtcrnDenoise runs real gtcrn_simple.onnx via sherpa-onnx OfflineSpeechDenoiser (enableExternalBuffer: false).",
      profiles,
    };
  }

  const finalSummary = {
    schema: 1,
    status: "evaluated",
    evaluatedAt: new Date().toISOString(),
    corpus: {
      sentences: manifest.sentences,
      groups: manifest.groups,
      variants: VARIANTS,
      totalWavFiles: manifest.totalFiles,
      cleanDurationSeconds: manifest.cleanDurationSeconds,
      dictionaryTerms: corpus.dictionary.length,
    },
    polishAuthorization: {
      status: llmConfig.authorized ? "authorized" : "not-run",
      reason: llmConfig.authorized ? null : llmConfig.reason,
    },
    models: modelEvaluations,
    switchComparison,
  };

  for (const outFile of outPaths) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(finalSummary, null, 2)}\n`, "utf8");
  }
  return finalSummary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const useCache = !args.includes("--no-cache");
  const skipSwitches = args.includes("--skip-switches");
  const outPaths = [defaultResultsPath];
  const outIdx = args.indexOf("--out");
  if (outIdx >= 0 && args[outIdx + 1]) {
    outPaths.push(path.resolve(args[outIdx + 1]));
  }
  runVoiceEvaluation({ useCache, outPaths, skipSwitches })
    .then((summary) => {
      console.log(
        JSON.stringify(
          {
            status: summary.status,
            models: Object.fromEntries(
              Object.entries(summary.models ?? {}).map(([k, v]) => [
                k,
                v.status === "evaluated"
                  ? {
                      status: v.status,
                      asrCer: v.overall240.asr_only.cer,
                      correctCer: v.overall240.asr_plus_correct.cer,
                      asrEntityRecall: v.overall240.asr_only.entityRecall,
                      correctEntityRecall: v.overall240.asr_plus_correct.entityRecall,
                      falseModifyRate: v.overall240.asr_plus_correct.falseModifyRate,
                    }
                  : { status: v.status },
              ]),
            ),
            switchComparison: summary.switchComparison?.status ?? "not-run",
            polish: summary.polishAuthorization?.status ?? "not-run",
          },
          null,
          2,
        ),
      );
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
