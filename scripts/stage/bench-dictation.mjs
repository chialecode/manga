import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { PhoneticCorrector } from "../../packages/app-core/src/voice/correct/index.ts";
import { runVoiceEvaluation } from "../voice-eval/run-eval.mjs";
import { discoverAvailableModels } from "../voice-eval/sherpa-runner.mjs";
import { spawnWindow } from "./bench-scale.mjs";
import { loadGate, p95, packagedExecutable, repoRoot as root } from "./lib.mjs";
import { watchGateTemp } from "./temp-dirs.mjs";

const SYL_A = ["星", "白", "雾", "凛", "苍", "月", "银", "绯", "青", "霜", "夜", "风", "云", "岚", "镜", "影", "流", "雪", "夏", "冬"];
const SYL_B = ["野", "鹭", "岛", "木", "崎", "城", "川", "原", "谷", "泽", "羽", "音", "弦", "华", "叶", "奈", "织", "璃", "穗", "遥"];
const SYL_C = ["澪", "铃", "司", "葵", "悠", "莲", "真", "唯", "飒", "朔", "曜", "澄", "澈", "宁", "汐", "澜", "瑾", "瑜", "桐", "枫"];

function build10kDictionary(targetCount) {
  const entries = [
    {
      id: "term-core-1",
      scope: "work",
      workId: "work-bench",
      workTitle: "星霜学园",
      term: "星野澪",
      category: "character",
      source: "manual",
      disabled: false,
      aliases: [{ alias: "星野灵", kind: "heard" }],
      blocked: [],
    },
    {
      id: "term-core-2",
      scope: "work",
      workId: "work-bench",
      workTitle: "星霜学园",
      term: "白鹭学园",
      category: "term",
      source: "manual",
      disabled: false,
      aliases: [],
      blocked: [],
    },
    {
      id: "term-core-3",
      scope: "global",
      workId: null,
      workTitle: null,
      term: "苍崎青子",
      category: "character",
      source: "manual",
      disabled: false,
      aliases: [],
      blocked: [],
    },
  ];

  const seen = new Set(entries.map((e) => e.term));
  let idx = 0;
  while (entries.length < targetCount) {
    const a = SYL_A[idx % SYL_A.length];
    const b = SYL_B[Math.floor(idx / SYL_A.length) % SYL_B.length];
    const c = SYL_C[Math.floor(idx / (SYL_A.length * SYL_B.length)) % SYL_C.length];
    const suffix = idx >= SYL_A.length * SYL_B.length * SYL_C.length ? String(idx) : "";
    const term = `${a}${b}${c}${suffix}`;
    idx += 1;
    if (seen.has(term)) continue;
    seen.add(term);
    entries.push({
      id: `term-syn-${entries.length}`,
      scope: entries.length % 3 === 0 ? "work" : "global",
      workId: entries.length % 3 === 0 ? "work-bench" : null,
      workTitle: entries.length % 3 === 0 ? "星霜学园" : null,
      term,
      category: "character",
      source: entries.length % 4 === 0 ? "bangumi:character" : "manual",
      disabled: false,
      aliases: [],
      blocked: [],
    });
  }
  return entries;
}

export function runDictationCorrectionBench({ terms = 10_000, runs = 50 } = {}) {
  const entries = build10kDictionary(terms);
  const buildStart = performance.now();
  const corrector = new PhoneticCorrector();
  corrector.setTerms(entries);
  const buildMs = Math.round((performance.now() - buildStart) * 100) / 100;

  const sentences = [
    "今天在白鹿学员旧图书馆里讨论星野灵与仓崎青子的分镜脚本节奏",
    "星野灵推开白鹿学员的旧大门后遇到了仓崎青子并交换了线索",
    "这一幕需要把星野灵在白鹿学员走廊里的台词节奏再收紧一点",
  ];

  // Warm up JIT before timed runs.
  for (let w = 0; w < 3; w += 1) {
    corrector.correct(sentences[w % sentences.length], { currentWorkId: "work-bench" });
  }

  const samples = [];
  let replacementsTotal = 0;
  for (let i = 0; i < runs; i += 1) {
    const text = sentences[i % sentences.length];
    const t0 = performance.now();
    const out = corrector.correct(text, { currentWorkId: "work-bench" });
    const elapsed = Math.round((performance.now() - t0) * 100) / 100;
    samples.push(elapsed);
    replacementsTotal += out.replacements.length;
  }

  return {
    terms: entries.length,
    samples,
    detail: {
      ok: replacementsTotal >= runs * 2,
      buildMs,
      replacementsTotal,
    },
  };
}

export async function runDictationWindowBench({ launch, runs = 5, audioSeconds = 4 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-dictation-"));
  const modelDir = path.join(root, "dist/tools/asr/sense-voice-funasr-nano-int8");
  const speechClip = path.join(root, "dist/samples/media/voice/tts-clips/zh-CN-1.wav");

  const discovered = discoverAvailableModels();
  const extraModels = [];
  for (const spec of discovered) {
    if (spec.id === "sense-voice-funasr-nano-int8" || !spec.files) continue;
    const anyFile = Object.values(spec.files)[0];
    if (typeof anyFile === "string") {
      const folder = fs.statSync(anyFile).isDirectory() ? anyFile : path.dirname(anyFile);
      extraModels.push({ modelId: spec.id, dir: folder });
    }
  }

  const specFile = path.join(dir, "dictation-bench-spec.json");
  fs.writeFileSync(specFile, JSON.stringify({ runs, audioSeconds, modelDir, extraModels }));
  const profileRoot = path.join(dir, "root");

  const env = {
    ...process.env,
    MANGA_CHANNEL: "test",
    MANGA_PROFILE_ROOT: profileRoot,
    MANGA_DOCUMENTS_DIR: path.join(dir, "documents"),
    MANGA_POINTER_FILE: path.join(dir, "launcher", "pointer.json"),
    MANGA_SMOKE_PHASE: "bench-dictation",
    MANGA_SMOKE_AUDIO: speechClip,
    MANGA_SMOKE_DICTATION_SPEC: specFile,
    MANGA_SMOKE_LAUNCHED_AT: String(Date.now()),
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = launch(env, dir);
  const outFile = path.join(profileRoot, "logs", "bench-dictation-window.json");
  const measured = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : undefined;
  if (!child || child.status !== 0 || !measured || measured.ok !== true) {
    return {
      ok: false,
      audioSeconds: 0,
      raw: measured?.raw ?? [],
      modelRecords: measured?.modelRecords ?? {},
      detail: {
        ok: false,
        failures: measured?.failures ?? [`dictation bench failed (exit ${child?.status ?? "null"})`],
      },
      stderr: child?.stderr?.slice(-2000),
      dir,
    };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return {
    ok: true,
    audioSeconds: measured.audioSeconds ?? audioSeconds,
    raw: measured.raw ?? [],
    modelRecords: measured.modelRecords ?? {},
    detail: {
      ok: true,
      failures: [],
      warmWorkingSetMiB: measured.warmWorkingSetMiB ?? null,
    },
  };
}

export async function collectVoiceRecords({ windowBench } = {}) {
  const localModels = { ...(windowBench?.modelRecords ?? {}) };

  // Supplement cold-load & RSS records from offline eval harvest cache for catalog models not currently unpacked on disk.
  const asrCacheFile = path.join(root, "dist/samples/voice-eval/asr-cache.json");
  if (fs.existsSync(asrCacheFile)) {
    try {
      const cache = JSON.parse(fs.readFileSync(asrCacheFile, "utf8"));
      for (const [modelId, entry] of Object.entries(cache?.models ?? {})) {
        if (localModels[modelId]) continue;
        if (entry && typeof entry === "object" && Number.isFinite(entry.loadMs)) {
          localModels[modelId] = {
            source: "eval-harvest-cache",
            kind: entry.kind ?? null,
            coldLoadMs: Math.round(entry.loadMs * 100) / 100,
            rssMiB: Number.isFinite(entry.rssBytes) ? Math.round((entry.rssBytes / (1024 * 1024)) * 100) / 100 : null,
            workingSetMiB: null,
          };
        }
      }
    } catch {
      // Optional cache supplement only.
    }
  }

  const cachedEvalPath = path.join(root, "dist/samples/voice-eval/eval-results.json");
  let existingEval = null;
  if (fs.existsSync(cachedEvalPath)) {
    try {
      existingEval = JSON.parse(fs.readFileSync(cachedEvalPath, "utf8"));
    } catch {
      existingEval = null;
    }
  }
  const hasCachedSwitches = existingEval?.switchComparison?.status === "evaluated";

  let evaluation;
  try {
    const fresh = await runVoiceEvaluation({
      useCache: true,
      outPaths: [],
      skipSwitches: hasCachedSwitches,
    });
    if (fresh.status === "evaluated") {
      const compactModels = {};
      for (const [modelId, m] of Object.entries(fresh.models ?? {})) {
        if (m.status !== "evaluated") {
          compactModels[modelId] = { status: m.status, kind: m.kind };
          continue;
        }
        compactModels[modelId] = {
          status: "evaluated",
          kind: m.kind,
          supportsHotwords: m.supportsHotwords,
          coldLoadMs: m.coldLoadMs,
          rssMiB: m.rssMiB,
          overall240: m.overall240,
          ...(m.hotwordGroupAClean ? { hotwordGroupAClean: m.hotwordGroupAClean } : {}),
        };
      }
      const switchSource = hasCachedSwitches ? existingEval.switchComparison : fresh.switchComparison;
      evaluation = {
        status: "evaluated",
        corpus: fresh.corpus,
        polishAuthorization: fresh.polishAuthorization,
        models: compactModels,
        switchComparison: switchSource,
      };
    } else {
      evaluation = { status: "not-run", reason: fresh.reason ?? "voice eval corpus unavailable" };
    }
  } catch (error) {
    evaluation = {
      status: "not-run",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    localModels,
    evaluation,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tempWatch = watchGateTemp("bench-dictation");
  const config = loadGate();
  const exe = packagedExecutable(root);
  if (!exe) {
    console.error("packaged desktop executable not found; run packaged build first");
    process.exit(1);
  }
  const launch = spawnWindow(exe, ["--manga-smoke"]);
  const winWanted = config.bench.creative?.dictationLocalReleaseToText ?? { minSamples: 5, scale: { audioSeconds: 4 } };
  const corrWanted = config.bench.creative?.dictationCorrection ?? { minSamples: 50, scale: { terms: 10_000 } };

  const winResult = await runDictationWindowBench({
    launch,
    runs: winWanted.minSamples,
    audioSeconds: winWanted.scale.audioSeconds,
  });
  const corrResult = runDictationCorrectionBench({
    terms: corrWanted.scale.terms,
    runs: corrWanted.minSamples,
  });
  const voiceRecords = await collectVoiceRecords({ windowBench: winResult });

  const releaseP95 = winResult.raw.length ? p95(winResult.raw) : Number.POSITIVE_INFINITY;
  const corrP95 = corrResult.samples.length ? p95(corrResult.samples) : Number.POSITIVE_INFINITY;
  const releaseLimit = config.bench.targets?.dictationLocalReleaseToTextMs ?? 1500;
  const corrLimit = config.bench.targets?.dictationCorrectionMs ?? 30;
  const ok = winResult.ok === true
    && corrResult.detail.ok === true
    && releaseP95 <= releaseLimit
    && corrP95 <= corrLimit;

  if (!ok) {
    console.error(JSON.stringify({ status: "failed", winResult, corrResult, releaseP95, corrP95 }, null, 2));
    process.exit(1);
  }
  const tempDirs = tempWatch.passed();
  if (tempDirs.left > 0) {
    console.error(JSON.stringify({ status: "failed", reason: "temporary directories left behind", tempDirs }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({
    status: "passed",
    dictationLocalReleaseToTextMs: { raw: winResult.raw, p95: releaseP95, limit: releaseLimit },
    dictationCorrectionMs: { samplesCount: corrResult.samples.length, p95: corrP95, limit: corrLimit },
    voiceRecordsSummary: {
      localModels: voiceRecords.localModels,
      evaluationStatus: voiceRecords.evaluation.status,
      switchComparisonStatus: voiceRecords.evaluation.switchComparison?.status ?? "not-run",
    },
    tempDirs,
  }, null, 2));
}
