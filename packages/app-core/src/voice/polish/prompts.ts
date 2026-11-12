import type { DictionaryCategory, PolishMode, PolishPrompts } from "@manga/contracts";
import { MAX_POLISH_CANDIDATES, type RecalledCandidate } from "../correct/index.ts";

/** Low sampling temperature used for dictation polish (§4.9 Guardrail 3). */
export const POLISH_TEMPERATURE = 0.1;

/** Strict wall-clock timeout for LLM polish requests before falling back to `correctedText` (§4.9 Guardrail 4). */
export const POLISH_TIMEOUT_MS = 5_000;

/** Minimum allowed character-length ratio (`polished / correctedText`) (§4.9 Guardrail 4). */
export const POLISH_MIN_LENGTH_RATIO = 0.4;

/** Maximum allowed character-length ratio (`polished / correctedText`) (§4.9 Guardrail 4). */
export const POLISH_MAX_LENGTH_RATIO = 1.4;

export const DEFAULT_LIGHT_POLISH_PROMPT = [
  "你是语音听写的轻度润色助手。请仅做以下整理：",
  "1. 补齐自然的中文标点符号；",
  "2. 去掉“嗯、啊、呃、那个、就是说”等无意义口水词与口头重复；",
  "3. 遇到说话人中途改口（如“不对是……”“我是说……”“应该叫……”），只保留改口后的最终说法；",
  "4. 若提供了专名候选，仅在句中确有读音相近的识别片段时替换为正式写法。",
  "硬性约束：没有读音相近的片段时不得套用候选、不得改变语气、不得改变原意、不得扩写或总结。只输出整理后的正文，不要附加任何解释或引号。",
].join("\n");

export const DEFAULT_FORMAL_POLISH_PROMPT = [
  "你是语音听写的书面整理助手。请在保持事实与核心意思完全不变的前提下：",
  "1. 去除口水词、重复与中途改口（只保留改口后的说法）；",
  "2. 将口语表达整理为通顺、简洁、自然的书面语，并补齐标点；",
  "3. 若提供了专名候选，仅在句中确有读音相近的识别片段时替换为正式写法。",
  "硬性约束：没有读音相近的片段时不得套用候选、不得改变语气基调、不得凭空增加原文没有的事实或专名。只输出整理后的正文，不要附加任何解释或引号。",
].join("\n");

const CATEGORY_LABELS: Record<DictionaryCategory, string> = {
  character: "角色",
  actor: "声优",
  work: "作品",
  term: "词条",
  other: "其他",
};

export function resolvePolishSystemPrompt(
  mode: Exclude<PolishMode, "raw">,
  customPrompts?: PolishPrompts | null,
): string {
  const custom = mode === "light" ? customPrompts?.light : customPrompts?.formal;
  if (typeof custom === "string" && custom.trim().length > 0) {
    return custom.trim();
  }
  return mode === "light" ? DEFAULT_LIGHT_POLISH_PROMPT : DEFAULT_FORMAL_POLISH_PROMPT;
}

/**
 * Formats recalled candidates (capped at 15) as `正式写法 | 读音或原名 | 类别与作品`
 * with the mandatory §4.9 anti-hallucination instruction.
 */
export function formatCandidateSection(candidates: ReadonlyArray<RecalledCandidate>): string {
  const limited = candidates.slice(0, MAX_POLISH_CANDIDATES);
  if (limited.length === 0) return "";

  const lines = limited.map((c) => {
    const categoryLabel = CATEGORY_LABELS[c.category] ?? "其他";
    const scopeLabel = c.workTitle ? `${categoryLabel} · ${c.workTitle}` : `${categoryLabel} · 全局`;
    const reading = c.readingOrOriginal || c.term;
    return `- ${c.term} | ${reading} | ${scopeLabel}`;
  });

  return [
    "【召回候选词（正式写法 | 读音或原名 | 类别与作品）】",
    ...lines,
    "注意：没有读音相近的片段时不得套用候选、不得改变语气。",
  ].join("\n");
}

export function buildPolishPrompts(input: {
  mode: Exclude<PolishMode, "raw">;
  correctedText: string;
  candidates: ReadonlyArray<RecalledCandidate>;
  customPrompts?: PolishPrompts | null;
}): { system: string; user: string } {
  const baseSystem = resolvePolishSystemPrompt(input.mode, input.customPrompts);
  const candidateBlock = formatCandidateSection(input.candidates);
  const system = candidateBlock ? `${baseSystem}\n\n${candidateBlock}` : baseSystem;
  const user = `待整理听写文本：\n${input.correctedText}`;
  return { system, user };
}
