import { describe, expect, it } from "vitest";
import {
  CANDIDATE_RECALL_THRESHOLD,
  type CorrectorTermEntry,
  DIRECT_REPLACE_THRESHOLD,
  FUZZY_PHONEME_COST,
  getPhonemeCost,
  MAX_POLISH_CANDIDATES,
  PhoneticCorrector,
  phoneticSimilarity,
  TONE_MISMATCH_COST,
  toPhonemes,
} from "../../packages/app-core/src/voice/correct/index.ts";

function makeTerm(
  id: string,
  term: string,
  extra: Partial<CorrectorTermEntry> = {},
): CorrectorTermEntry {
  return {
    id,
    scope: extra.scope ?? "work",
    workId: extra.scope === "global" ? null : (extra.workId ?? "work_astral"),
    workTitle: extra.workTitle ?? "星穹航路",
    term,
    category: extra.category ?? "character",
    source: extra.source ?? "metadata:bangumi:character:101",
    disabled: extra.disabled ?? false,
    aliases: extra.aliases ?? [],
    blocked: extra.blocked ?? [],
  };
}

describe("voice phonetic recall & deterministic replacement (R1)", () => {
  it("exports threshold constants and enforces hIsTone && iIsTone cost rule", () => {
    expect(DIRECT_REPLACE_THRESHOLD).toBe(0.9);
    expect(CANDIDATE_RECALL_THRESHOLD).toBe(0.75);
    expect(MAX_POLISH_CANDIDATES).toBe(15);
    expect(TONE_MISMATCH_COST).toBeLessThan(FUZZY_PHONEME_COST);

    const pTone1 = toPhonemes("妈").find((p) => p.isTone)!;
    const pTone4 = toPhonemes("骂").find((p) => p.isTone)!;
    const pInitial = toPhonemes("骂").find((p) => !p.isTone && p.isWordStart)!;

    // Two different tones -> TONE_MISMATCH_COST
    expect(getPhonemeCost(pTone1, pTone4)).toBe(TONE_MISMATCH_COST);
    // Upstream bug regression: tone vs non-tone MUST cost 1.0, never 0.5 / TONE_MISMATCH_COST
    expect(getPhonemeCost(pTone1, pInitial)).toBe(1.0);
    expect(getPhonemeCost(pInitial, pTone4)).toBe(1.0);
  });

  it("replaces Mandarin retroflex, nasal/lateral, and front/back nasal confusions for current-work and manual terms", () => {
    const corrector = new PhoneticCorrector();
    corrector.setTerms([
      // z/zh + in/ing + tone confusion on 4-syllable fictional name
      makeTerm("t1", "星野苍真", { workId: "work_astral" }),
      // n/l + s/sh + c/ch + an/ang + en/eng confusion
      makeTerm("t2", "森山千春", { workId: "work_astral" }),
      makeTerm("t3", "蓝原凛音", { scope: "global", workId: null, source: "manual" }),
    ]);

    const res1 = corrector.correct("刚才心野仓真和深山千村一起到了社团，南原林音也在。", {
      currentWorkId: "work_astral",
    });

    expect(res1.correctedText).toBe("刚才星野苍真和森山千春一起到了社团，蓝原凛音也在。");
    expect(res1.replacements).toHaveLength(3);
    expect(res1.replacements.map((r) => r.replacement)).toEqual([
      "星野苍真",
      "森山千春",
      "蓝原凛音",
    ]);
    for (const r of res1.replacements) {
      expect(res1.correctedText.slice(r.start, r.end)).toBe(r.replacement);
      expect(r.score).toBeGreaterThanOrEqual(DIRECT_REPLACE_THRESHOLD);
    }
  });

  it("routes non-current-work auto terms and 0.75..0.90 partial matches into recalled candidates (capped at 15)", () => {
    const corrector = new PhoneticCorrector();
    const entries: CorrectorTermEntry[] = [
      // Auto term belonging to a DIFFERENT work: even >= 0.90 phonetic match goes to candidates, not direct replace
      makeTerm("other_work_char", "雾岛千夏", {
        workId: "work_other",
        workTitle: "白昼海风",
        source: "metadata:bangumi:character:900",
      }),
      // Current-work 4-char term with 2 non-fuzzy phoneme errors (~0.83 score -> candidate)
      makeTerm("partial_char", "神代遥香", {
        workId: "work_astral",
        source: "metadata:bangumi:character:901",
      }),
    ];
    for (let idx = 0; idx < 20; idx += 1) {
      entries.push(
        makeTerm(`extra_${idx}`, `风间奏太${idx}`, {
          workId: "work_other",
          source: `metadata:bangumi:character:${1000 + idx}`,
        }),
      );
    }
    corrector.setTerms(entries);

    const out = corrector.correct("务岛千夏昨天遇到了程代遥香，还有风间奏太。", {
      currentWorkId: "work_astral",
    });

    // Neither should blindly overwrite correctedText
    expect(out.correctedText).toBe("务岛千夏昨天遇到了程代遥香，还有风间奏太。");
    expect(out.replacements).toHaveLength(0);
    expect(out.candidates.length).toBeLessThanOrEqual(MAX_POLISH_CANDIDATES);
    const recalledTerms = out.candidates.map((c) => c.term);
    expect(recalledTerms).toContain("雾岛千夏");
    expect(recalledTerms).toContain("神代遥香");
  });

  it("handles exact alias, kana, romaji, and Latin camelCase matches while respecting ASCII word boundaries", () => {
    const corrector = new PhoneticCorrector();
    corrector.setTerms([
      makeTerm("beniha", "藤崎红羽", {
        workId: "work_astral",
        aliases: [
          { alias: "藤崎紅羽", kind: "alias" },
          { alias: "ふじさきべには", kind: "kana" },
          { alias: "Fujisaki Beniha", kind: "romaji" },
          { alias: "藤崎贝妮羽", kind: "heard" },
        ],
      }),
      makeTerm("arc", "StarlightChronicle", {
        scope: "global",
        workId: null,
        source: "manual",
        category: "work",
      }),
      makeTerm("short_en", "Cat", {
        scope: "global",
        workId: null,
        source: "manual",
        category: "term",
      }),
    ]);

    const rKana = corrector.correct("今天フジサキ・ベニハ和藤崎贝妮羽在讨论 starlight cronicle。", {
      currentWorkId: "work_astral",
    });
    expect(rKana.correctedText).toBe("今天藤崎红羽和藤崎红羽在讨论 StarlightChronicle。");

    // Short ASCII term "Cat" must NOT match inside "category" or "concat", only whole word "cat"
    const rBoundary = corrector.correct("This category has a cat in concat.", {
      currentWorkId: "work_astral",
    });
    expect(rBoundary.correctedText).toBe("This category has a Cat in concat.");
  });

  it("prefers longer compound terms when one term is a substring of another", () => {
    const corrector = new PhoneticCorrector();
    corrector.setTerms([
      makeTerm("short", "星穹航路", { scope: "global", workId: null, source: "manual", category: "work" }),
      makeTerm("long", "星穹航路：拂晓篇", {
        scope: "global",
        workId: null,
        source: "manual",
        category: "work",
        aliases: [{ alias: "星穹航路拂晓篇", kind: "alias" }],
      }),
      makeTerm("en_short", "Chronicle", { scope: "global", workId: null, source: "manual", category: "term" }),
      makeTerm("en_long", "ChronicleEngine", { scope: "global", workId: null, source: "manual", category: "term" }),
    ]);

    const out = corrector.correct("昨晚看完了星穹航路拂晓篇，顺便试了 chronicle engine。", {
      currentWorkId: null,
    });
    expect(out.correctedText).toBe("昨晚看完了星穹航路：拂晓篇，顺便试了 ChronicleEngine。");
  });

  it("respects per-term blocked surface forms and protects ordinary words in non-entity sentences", () => {
    const corrector = new PhoneticCorrector();
    corrector.setTerms([
      makeTerm("qianxia", "千夏", { workId: "work_astral", source: "manual" }),
      makeTerm("xingye", "星野", { workId: "work_astral", source: "manual" }),
      makeTerm("shendai", "神代", { workId: "work_astral", source: "manual" }),
      makeTerm("zhensi", "真司", { workId: "work_astral", source: "manual" }),
      makeTerm("blocked_term", "雾岛千夏", {
        workId: "work_astral",
        source: "manual",
        blocked: ["务岛签下"],
      }),
    ]);

    const nonEntitySentences = [
      "昨天我们正式签下了那份租房合同。",
      "听完音乐之后我的心也平静下来了。",
      "背包里装着两根结实的绳带。",
      "今天天气真是太好了，我们一起出去散步吧。",
      "务岛签下了这份委托。",
    ];

    for (const sentence of nonEntitySentences) {
      const res = corrector.correct(sentence, { currentWorkId: "work_astral" });
      expect(res.correctedText).toBe(sentence);
      expect(res.replacements).toHaveLength(0);
    }

    // Blocked form should not even appear in candidates
    const blockedRes = corrector.correct("务岛签下了这份委托。", { currentWorkId: "work_astral" });
    expect(blockedRes.candidates.map((c) => c.term)).not.toContain("雾岛千夏");
  });

  it("supports incremental upsertTerm, removeTerm, disabled terms, and phoneticSimilarity", () => {
    const corrector = new PhoneticCorrector();
    corrector.upsertTerm(makeTerm("d1", "苍井遥香", { workId: "work_astral" }));
    expect(corrector.correct("仓井遥香来了", { currentWorkId: "work_astral" }).correctedText).toBe("苍井遥香来了");

    // Disable term incrementally -> no longer replaces
    corrector.upsertTerm(makeTerm("d1", "苍井遥香", { workId: "work_astral", disabled: true }));
    expect(corrector.correct("仓井遥香来了", { currentWorkId: "work_astral" }).correctedText).toBe("仓井遥香来了");

    // Re-enable and then remove
    corrector.upsertTerm(makeTerm("d1", "苍井遥香", { workId: "work_astral", disabled: false }));
    corrector.removeTerm("d1");
    expect(corrector.size).toBe(0);
    expect(corrector.correct("仓井遥香来了", { currentWorkId: "work_astral" }).correctedText).toBe("仓井遥香来了");

    expect(phoneticSimilarity("雷娜", "蕾娜")).toBeGreaterThanOrEqual(0.6);
    expect(phoneticSimilarity("完全无关的句子", "星穹航路")).toBeLessThan(0.6);
  });

  it("corrects a sentence against 10,000 dictionary terms with p95 <= 30 ms", () => {
    const corrector = new PhoneticCorrector();
    const surnames = ["星野", "神代", "雾岛", "苍井", "白石", "黑泽", "风间", "月城", "朝比奈", "七海"];
    const givens = ["千夏", "凛音", "苍真", "遥香", "奏太", "美琴", "雪乃", "结衣", "阳菜", "莲华"];
    const suffixes = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];

    const bulk: CorrectorTermEntry[] = [];
    let count = 0;
    for (let round = 0; round < 10; round += 1) {
      for (const s of surnames) {
        for (const g of givens) {
          for (const suf of suffixes) {
            count += 1;
            bulk.push(
              makeTerm(`term_${count}`, `${s}${g}${suf}号`, {
                workId: round === 0 ? "work_astral" : `work_${round}`,
                source: `metadata:bangumi:character:${count}`,
              }),
            );
          }
        }
      }
    }
    expect(bulk).toHaveLength(10_000);
    corrector.setTerms(bulk);

    const sample = "今天在活动室里，心野千夏三号和神代林音七号一起讨论了明天的排练计划。";
    // Warm up JIT once
    const warm = corrector.correct(sample, { currentWorkId: "work_astral" });
    expect(warm.correctedText).toContain("星野千夏三号");
    expect(warm.correctedText).toContain("神代凛音七号");

    const samplesMs: number[] = [];
    for (let iter = 0; iter < 25; iter += 1) {
      const t0 = performance.now();
      corrector.correct(sample, { currentWorkId: "work_astral" });
      samplesMs.push(performance.now() - t0);
    }
    samplesMs.sort((a, b) => a - b);
    const p95 = samplesMs[Math.floor(samplesMs.length * 0.95)]!;
    expect(p95).toBeLessThanOrEqual(30);
  });
});
