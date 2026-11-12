import { describe, expect, it } from "vitest";
import type { RecalledCandidate } from "../../packages/app-core/src/voice/correct/index.ts";
import {
  convertChineseVariant,
  DEFAULT_FORMAL_POLISH_PROMPT,
  DEFAULT_LIGHT_POLISH_PROMPT,
  DictationPolisher,
  POLISH_MAX_LENGTH_RATIO,
  POLISH_MIN_LENGTH_RATIO,
  POLISH_TEMPERATURE,
  POLISH_TIMEOUT_MS,
  type PolishLlmClient,
  type PolishLlmConnection,
  type PolishLlmRequest,
  resolvePolishSystemPrompt,
} from "../../packages/app-core/src/voice/polish/index.ts";

const FAKE_CONNECTION: PolishLlmConnection = {
  id: "conn_text",
  model: "stub-polish-model",
  timeoutMs: 8_000,
};

function makeStubLlm(
  responder: (req: PolishLlmRequest) => Promise<string> | string,
): { client: PolishLlmClient; calls: PolishLlmRequest[] } {
  const calls: PolishLlmRequest[] = [];
  const client: PolishLlmClient = {
    resolve: () => FAKE_CONNECTION,
    async complete(_conn, req) {
      calls.push(req);
      const text = await responder(req);
      return { text };
    },
  };
  return { client, calls };
}

function makeCandidate(term: string, readingOrOriginal = "しんしろ"): RecalledCandidate {
  return {
    termId: `id_${term}`,
    term,
    matchedText: "新成",
    start: 0,
    end: 2,
    score: 0.84,
    category: "character",
    scope: "work",
    workId: "work_astral",
    workTitle: "星穹航路",
    source: "metadata:bangumi:character:1",
    readingOrOriginal,
  };
}

describe("voice dictation LLM polish, 4 guardrails & OpenCC (P1)", () => {
  it("Guardrail 1: skips LLM in raw mode, when unconfigured, or in clean light mode without candidates or disfluencies", async () => {
    const { client, calls } = makeStubLlm(() => "不应被调用");
    const polisher = new DictationPolisher({ llm: client });

    // 1. Raw mode never calls LLM
    const rRaw = await polisher.polish({
      correctedText: "嗯，那个，今天去图书馆，不对是去活动室。",
      mode: "raw",
      candidates: [makeCandidate("新城凛音")],
    });
    expect(rRaw.usedLlm).toBe(false);
    expect(rRaw.skippedReason).toBe("raw_mode");
    expect(calls).toHaveLength(0);

    // 2. Light mode with 0 candidates and clean phrasing skips LLM
    const rCleanLight = await polisher.polish({
      correctedText: "今天下午我们一起整理了分镜草稿。",
      mode: "light",
      candidates: [],
    });
    expect(rCleanLight.usedLlm).toBe(false);
    expect(rCleanLight.skippedReason).toBe("clean_light");
    expect(calls).toHaveLength(0);

    // 3. Unconfigured LLM connection falls back cleanly to raw handling
    const unconfiguredPolisher = new DictationPolisher({
      llm: { resolve: () => null, complete: async () => ({ text: "" }) },
    });
    const rNoConn = await unconfiguredPolisher.polish({
      correctedText: "嗯，今天下午整理草稿。",
      mode: "light",
    });
    expect(rNoConn.usedLlm).toBe(false);
    expect(rNoConn.skippedReason).toBe("no_connection");
    expect(rNoConn.finalText).toBe("嗯，今天下午整理草稿。");
  });

  it("Guardrails 2 & 3: passes ONLY recalled candidates (<=15) with anti-forcing notice and temperature=0.1", async () => {
    const { client, calls } = makeStubLlm(() => "今天新城凛音去活动室整理了草稿。");
    const polisher = new DictationPolisher({ llm: client });

    const twentyCandidates = Array.from({ length: 20 }, (_, i) =>
      makeCandidate(i === 0 ? "新城凛音" : `虚构候选${i + 1}`, `reading_${i + 1}`),
    );

    const res = await polisher.polish({
      correctedText: "嗯，今天新成凛音去图书馆，不对是去活动室整理了草稿",
      mode: "light",
      candidates: twentyCandidates,
      dictionaryTerms: ["新城凛音", "未被召回的词典专名"],
    });

    expect(res.usedLlm).toBe(true);
    expect(res.fallbackReason).toBeNull();
    expect(res.finalText).toBe("今天新城凛音去活动室整理了草稿。");
    expect(calls).toHaveLength(1);

    const req = calls[0]!;
    expect(req.temperature).toBe(POLISH_TEMPERATURE);
    expect(req.system).toContain("新城凛音 | reading_1 | 角色 · 星穹航路");
    expect(req.system).toContain("没有读音相近的片段时不得套用候选、不得改变语气");
    // Must cap at 15 candidates and NEVER inject un-recalled dictionary terms
    expect(req.system).toContain("虚构候选15");
    expect(req.system).not.toContain("虚构候选16");
    expect(req.system).not.toContain("未被召回的词典专名");

    // Guardrail 3 retry: if provider rejects `temperature`, retry once without `temperature`
    const retryCalls: PolishLlmRequest[] = [];
    const noTempClient: PolishLlmClient = {
      resolve: () => FAKE_CONNECTION,
      async complete(_conn, r) {
        retryCalls.push(r);
        if (r.temperature !== undefined) {
          throw new Error("HTTP 400: Unsupported parameter: 'temperature' is not supported with this model.");
        }
        return { text: "今天新城凛音去活动室整理了草稿。" };
      },
    };
    const retryRes = await new DictationPolisher({ llm: noTempClient }).polish({
      correctedText: "嗯，今天新成凛音去图书馆，不对是去活动室整理了草稿",
      mode: "light",
      candidates: [makeCandidate("新城凛音")],
      dictionaryTerms: ["新城凛音"],
    });
    expect(retryCalls).toHaveLength(2);
    expect(retryCalls[0]!.temperature).toBe(POLISH_TEMPERATURE);
    expect(retryCalls[1]!.temperature).toBeUndefined();
    expect(retryRes.fallbackReason).toBeNull();
    expect(retryRes.finalText).toBe("今天新城凛音去活动室整理了草稿。");
  });

  it("supports custom light/formal prompts and restoring defaults", async () => {
    expect(resolvePolishSystemPrompt("light", null)).toBe(DEFAULT_LIGHT_POLISH_PROMPT);
    expect(resolvePolishSystemPrompt("formal", { formal: "自定义书面提示词" })).toBe("自定义书面提示词");
    // Empty/null restores default
    expect(resolvePolishSystemPrompt("formal", { formal: "   " })).toBe(DEFAULT_FORMAL_POLISH_PROMPT);
    expect(resolvePolishSystemPrompt("formal", { formal: null })).toBe(DEFAULT_FORMAL_POLISH_PROMPT);

    const { client, calls } = makeStubLlm(() => "整理后的书面句子。");
    const polisher = new DictationPolisher({ llm: client });
    await polisher.polish({
      correctedText: "今天把这章的分镜看完了。",
      mode: "formal",
      customPrompts: { formal: "请按自定义书面规范整理。" },
    });
    expect(calls[0]!.system).toContain("请按自定义书面规范整理。");
  });

  it("Guardrail 4: rejects outputs failing length ratio [0.4, 1.4], hallucinated entities/Latin/katakana, repetition, errors, or >5s timeout", async () => {
    expect(POLISH_MIN_LENGTH_RATIO).toBe(0.4);
    expect(POLISH_MAX_LENGTH_RATIO).toBe(1.4);
    expect(POLISH_TIMEOUT_MS).toBe(5_000);

    const source = "嗯，今天下午我们讨论了第三话的节奏安排";

    // 1. Over-long expansion (> 1.4x)
    {
      const { client } = makeStubLlm(
        () => "今天下午我们在会议室里非常详细而深入地讨论了第三话整体剧情与分镜节奏的具体推进安排以及后续修改计划。",
      );
      const res = await new DictationPolisher({ llm: client }).polish({
        correctedText: source,
        mode: "light",
      });
      expect(res.fallbackReason).toBe("length_out_of_range");
      expect(res.finalText).toBe(source);
    }

    // 2. Too short (< 0.4x)
    {
      const { client } = makeStubLlm(() => "讨论了。");
      const res = await new DictationPolisher({ llm: client }).polish({
        correctedText: source,
        mode: "light",
      });
      expect(res.fallbackReason).toBe("length_out_of_range");
      expect(res.finalText).toBe(source);
    }

    // 3. Hallucinated un-recalled dictionary term
    {
      const { client } = makeStubLlm(() => "今天下午我们和雾岛千夏讨论了节奏安排。");
      const res = await new DictationPolisher({ llm: client }).polish({
        correctedText: source,
        mode: "light",
        dictionaryTerms: ["雾岛千夏"],
      });
      expect(res.fallbackReason).toBe("unexpected_entity");
      expect(res.finalText).toBe(source);
    }

    // 4. Hallucinated Latin word absent from source & candidates
    {
      const { client } = makeStubLlm(() => "今天下午我们讨论了 Flow 的节奏安排。");
      const res = await new DictationPolisher({ llm: client }).polish({
        correctedText: source,
        mode: "light",
      });
      expect(res.fallbackReason).toBe("unexpected_entity");
      expect(res.finalText).toBe(source);
    }

    // 5. Hallucinated Katakana word absent from source & candidates
    {
      const { client } = makeStubLlm(() => "今天下午我们讨论了アークライト的安排。");
      const res = await new DictationPolisher({ llm: client }).polish({
        correctedText: source,
        mode: "light",
      });
      expect(res.fallbackReason).toBe("unexpected_entity");
      expect(res.finalText).toBe(source);
    }

    // 6. Pathological full-sentence duplication
    {
      const dupSource = "嗯，今天整理分镜草稿";
      const { client } = makeStubLlm(() => "今天整理分镜草稿。今天整理分镜草稿。");
      const res = await new DictationPolisher({ llm: client }).polish({
        correctedText: dupSource,
        mode: "formal",
      });
      expect(res.fallbackReason).toBe("repetition");
      expect(res.finalText).toBe(dupSource);
    }

    // 7. LLM error -> fallback `llm_error`
    {
      const { client } = makeStubLlm(() => {
        throw new Error("HTTP 502 Bad Gateway");
      });
      const res = await new DictationPolisher({ llm: client }).polish({
        correctedText: source,
        mode: "light",
      });
      expect(res.fallbackReason).toBe("llm_error");
      expect(res.finalText).toBe(source);
    }

    // 8. Timeout -> fallback `timeout` preserving correctedText
    {
      const { client } = makeStubLlm(
        () => new Promise<string>((resolve) => setTimeout(() => resolve("迟到的结果"), 250)),
      );
      const res = await new DictationPolisher({ llm: client }).polish({
        correctedText: source,
        mode: "light",
        timeoutMs: 40,
      });
      expect(res.fallbackReason).toBe("timeout");
      expect(res.finalText).toBe(source);
    }
  });

  it("converts Traditional <-> Simplified Chinese via OpenCC while protecting canonical dictionary spellings", async () => {
    // Traditional input -> Simplified output, EXCEPT canonical term `藤崎紅羽` (keeps Traditional `紅`) and kana `アストラル`
    const simplified = convertChineseVariant(
      "這個軟體裡記錄了藤崎紅羽與アストラル的設定。",
      "simplified",
      ["藤崎紅羽", "アストラル"],
    );
    expect(simplified).toBe("这个软体里记录了藤崎紅羽与アストラル的设定。");

    // Simplified input -> Traditional output, EXCEPT canonical term `云端记事` (keeps Simplified `云`/`记`)
    const traditional = convertChineseVariant(
      "我们在云端记事里写下了头发与背景的细节。",
      "traditional",
      ["云端记事"],
    );
    expect(traditional).toBe("我們在云端记事裏寫下了頭髮與背景的細節。");

    // Variant `none` leaves script untouched
    const untouched = convertChineseVariant("這個軟體裡记录了细节。", "none", []);
    expect(untouched).toBe("這個軟體裡记录了细节。");
  });
});
