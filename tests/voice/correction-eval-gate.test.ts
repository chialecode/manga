import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CANDIDATE_RECALL_THRESHOLD,
  type CorrectorAliasEntry,
  type CorrectorTermEntry,
  DIRECT_REPLACE_THRESHOLD,
  MAX_POLISH_CANDIDATES,
  PhoneticCorrector,
} from "../../packages/app-core/src/voice/correct/index.ts";

type FixturePair = {
  id: string;
  kind: "entity" | "non_entity";
  workId: string | null;
  source: string;
  recognizedText: string;
  expectedText: string;
  expectedEntities: string[];
};

type VoiceCorrectionFixture = {
  schema: number;
  description: string;
  works: Array<{ id: string; title: string; mediaType: string }>;
  dictionary: Array<{
    id: string;
    scope: "global" | "work";
    workId: string | null;
    term: string;
    category: "character" | "actor" | "work" | "term" | "other";
    source: string;
    disabled?: boolean;
    aliases?: CorrectorAliasEntry[];
    blocked?: string[];
  }>;
  pairs: FixturePair[];
};

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.resolve(testDir, "../fixtures/voice-correction.json");

function loadFixture(): VoiceCorrectionFixture {
  return JSON.parse(fs.readFileSync(fixturePath, "utf8")) as VoiceCorrectionFixture;
}

function containsEntity(text: string, entity: string): boolean {
  if (/^[A-Za-z0-9_.-]+$/.test(entity)) {
    const escaped = entity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(text);
  }
  return text.includes(entity);
}

function buildCorrectorFromFixture(fixture: VoiceCorrectionFixture): PhoneticCorrector {
  const workTitles = new Map(fixture.works.map((w) => [w.id, w.title]));
  const entries: CorrectorTermEntry[] = fixture.dictionary.map((d) => ({
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
  corrector.setTerms(entries);
  return corrector;
}

describe("AT-181 / AT-183: 200+ pair voice correction quality & 10k-term latency gate", () => {
  it("validates 220+ authentic multi-model & phonetic-confusion pairs with complete provenance", () => {
    const fixture = loadFixture();
    expect(fixture.schema).toBe(1);
    expect(fixture.dictionary.length).toBeGreaterThanOrEqual(35);
    expect(fixture.pairs.length).toBeGreaterThanOrEqual(220);

    const entityPairs = fixture.pairs.filter((p) => p.kind === "entity");
    const nonEntityPairs = fixture.pairs.filter((p) => p.kind === "non_entity");
    expect(entityPairs.length).toBeGreaterThanOrEqual(150);
    expect(nonEntityPairs.length).toBeGreaterThanOrEqual(60);

    const seenIds = new Set<string>();
    const modelSources = new Set<string>();
    const variantsCovered = new Set<string>();
    let phoneticConfusionPairs = 0;

    for (const pair of fixture.pairs) {
      expect(pair.id.length).toBeGreaterThan(0);
      expect(seenIds.has(pair.id)).toBe(false);
      seenIds.add(pair.id);

      expect(pair.source.trim().length).toBeGreaterThan(0);
      expect(pair.recognizedText.trim().length).toBeGreaterThan(0);
      expect(pair.expectedText.trim().length).toBeGreaterThan(0);

      const asrTagMatch = /^([a-z0-9.-]+)@(clean|fan10db|speech10db):([ABC]\d{2})$/i.exec(pair.source);
      if (asrTagMatch) {
        modelSources.add(asrTagMatch[1]!);
        variantsCovered.add(asrTagMatch[2]!);
      } else if (pair.source.startsWith("phonetic-confusion:")) {
        phoneticConfusionPairs += 1;
      } else {
        throw new Error(`Unexpected pair provenance format on ${pair.id}: ${pair.source}`);
      }

      if (pair.kind === "entity") {
        expect(pair.expectedEntities.length).toBeGreaterThanOrEqual(1);
      } else {
        expect(pair.expectedEntities).toEqual([]);
      }
    }

    // Must include real ASR outputs from all 3 local models across all 3 acoustic variants, plus phonetic confusions.
    expect(modelSources.has("sense-voice-funasr-nano-int8")).toBe(true);
    expect(modelSources.has("qwen3-asr-0.6B-int8")).toBe(true);
    expect(modelSources.has("funasr-nano-int8")).toBe(true);
    expect(variantsCovered.has("clean")).toBe(true);
    expect(variantsCovered.has("fan10db")).toBe(true);
    expect(variantsCovered.has("speech10db")).toBe(true);
    expect(phoneticConfusionPairs).toBeGreaterThanOrEqual(15);

    // Confirm threshold constants match specification (4.8).
    expect(DIRECT_REPLACE_THRESHOLD).toBe(0.9);
    expect(CANDIDATE_RECALL_THRESHOLD).toBe(0.75);
    expect(MAX_POLISH_CANDIDATES).toBe(15);
  });

  it("achieves proper-noun recall >= 0.85 (deterministic replacement + recalled candidates) on entity pairs", () => {
    const fixture = loadFixture();
    const corrector = buildCorrectorFromFixture(fixture);
    const entityPairs = fixture.pairs.filter((p) => p.kind === "entity");

    let totalEntities = 0;
    let baselineHits = 0;
    let directHits = 0;
    let combinedHits = 0;
    const missedExamples: string[] = [];

    for (const pair of entityPairs) {
      const result = corrector.correct(pair.recognizedText, {
        currentWorkId: pair.workId,
      });
      const candidateSet = new Set(result.candidates.map((c) => c.term.toLowerCase()));

      for (const expectedEntity of pair.expectedEntities) {
        totalEntities += 1;
        if (containsEntity(pair.recognizedText, expectedEntity)) {
          baselineHits += 1;
        }
        const inCorrected = containsEntity(result.correctedText, expectedEntity);
        const inCandidates = candidateSet.has(expectedEntity.toLowerCase());
        if (inCorrected) {
          directHits += 1;
          combinedHits += 1;
        } else if (inCandidates) {
          combinedHits += 1;
        } else if (missedExamples.length < 12) {
          missedExamples.push(
            `${pair.id} [${pair.source}] expected "${expectedEntity}" in "${pair.recognizedText}" -> "${result.correctedText}"`,
          );
        }
      }
    }

    const baselineRecall = baselineHits / totalEntities;
    const directRecall = directHits / totalEntities;
    const combinedRecall = combinedHits / totalEntities;

    expect(totalEntities).toBeGreaterThanOrEqual(200);
    expect(combinedRecall).toBeGreaterThan(baselineRecall);
    expect(directRecall).toBeGreaterThan(baselineRecall);
    expect(
      combinedRecall,
      `Combined proper-noun recall ${combinedRecall.toFixed(4)} (< 0.85); sample misses:\n${missedExamples.join("\n")}`,
    ).toBeGreaterThanOrEqual(0.85);
  });

  it("keeps non-entity sentence false-modification rate <= 0.01 (1%) across near-homophone traps", () => {
    const fixture = loadFixture();
    const corrector = buildCorrectorFromFixture(fixture);
    const nonEntityPairs = fixture.pairs.filter((p) => p.kind === "non_entity");

    const falseModifications: string[] = [];
    for (const pair of nonEntityPairs) {
      const result = corrector.correct(pair.recognizedText, {
        currentWorkId: pair.workId,
      });
      if (result.correctedText !== pair.recognizedText) {
        falseModifications.push(
          `${pair.id} [${pair.source}]: "${pair.recognizedText}" falsely modified to "${result.correctedText}"`,
        );
      }
    }

    const falseModifyRate = falseModifications.length / nonEntityPairs.length;
    expect(
      falseModifyRate,
      `False-modification rate ${falseModifyRate.toFixed(4)} (> 0.01):\n${falseModifications.join("\n")}`,
    ).toBeLessThanOrEqual(0.01);
  });

  it("meets 10,000-term single-sentence correction p95 <= 30 ms and supports incremental index updates", () => {
    const fixture = loadFixture();
    const workTitles = new Map(fixture.works.map((w) => [w.id, w.title]));
    const entries: CorrectorTermEntry[] = fixture.dictionary.map((d) => ({
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

    // Synthesize fictional 4-character ACG-style terms up to 10,000 total entries.
    const surnamePool = [
      "星庭", "雾坛", "月阶", "霜桥", "风院", "苍坂", "翠谷", "白渚", "绯原", "雪川",
      "银栏", "青屿", "琉城", "灯林", "汐丘", "镜野", "岚台", "铁门", "夜港", "云塔",
    ];
    const givenFirst = [
      "清", "明", "遥", "静", "悠", "真", "希", "千", "久", "朝",
      "夕", "春", "秋", "冬", "弦", "祈", "澄", "朔", "凛", "纱",
    ];
    const givenSecond = [
      "音", "夏", "夜", "织", "叶", "奈", "香", "沙", "月", "里",
      "人", "寻", "司", "远", "咲", "之", "华", "羽", "灯", "帆",
    ];

    let idx = 0;
    while (entries.length < 10_000) {
      const s = surnamePool[idx % surnamePool.length]!;
      const g1 = givenFirst[Math.floor(idx / surnamePool.length) % givenFirst.length]!;
      const g2 = givenSecond[Math.floor(idx / (surnamePool.length * givenFirst.length)) % givenSecond.length]!;
      const suffix = idx >= 8_000 ? givenFirst[(idx * 7) % givenFirst.length]! : "";
      const syntheticTerm = `${s}${g1}${g2}${suffix}`;
      idx += 1;
      entries.push({
        id: `synth-term-${entries.length}`,
        scope: "work",
        workId: idx % 3 === 0 ? "work-fogsea-clocktower" : "work-synthetic-extra",
        workTitle: "虚构词库扩展卷",
        term: syntheticTerm,
        category: "character",
        source: `metadata:bangumi:character:${200_000 + idx}`,
      });
    }

    const corrector = new PhoneticCorrector();
    corrector.setTerms(entries);
    expect(corrector.size).toBe(10_000);

    // Warm up JIT before measuring latency distribution.
    for (let w = 0; w < 5; w += 1) {
      const sample = fixture.pairs[w]!;
      corrector.correct(sample.recognizedText, { currentWorkId: sample.workId });
    }

    const sampleCount = 60;
    const timingsMs: number[] = [];
    for (let i = 0; i < sampleCount; i += 1) {
      const pair = fixture.pairs[i % fixture.pairs.length]!;
      const t0 = performance.now();
      corrector.correct(pair.recognizedText, { currentWorkId: pair.workId });
      timingsMs.push(performance.now() - t0);
    }

    const sorted = [...timingsMs].sort((a, b) => a - b);
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!;
    expect(p95).toBeLessThanOrEqual(30);

    // Verify incremental upsertTerm / removeTerm at 10,000-term scale.
    corrector.upsertTerm({
      id: "incremental-custom-1",
      scope: "global",
      workId: null,
      term: "空庭星语录",
      category: "work",
      source: "manual",
    });
    expect(corrector.size).toBe(10_001);
    const afterUpsert = corrector.correct("请打开空庭新语录的第三章。", {
      currentWorkId: "work-fogsea-clocktower",
    });
    expect(afterUpsert.correctedText).toContain("空庭星语录");

    corrector.removeTerm("incremental-custom-1");
    expect(corrector.size).toBe(10_000);
    const afterRemove = corrector.correct("请打开空庭新语录的第三章。", {
      currentWorkId: "work-fogsea-clocktower",
    });
    expect(afterRemove.correctedText).toBe("请打开空庭新语录的第三章。");
  });
});
