import { PROMPT_LIMIT_DEFAULT } from "@manga/contracts";
import { DEFAULT_CHAT_AUDIO_SYSTEM_PROMPT } from "@manga/model-protocol";
import type { AsrCatalogModelKind } from "../models/catalog.ts";

export const MAX_HOTWORD_TERMS = 50;
export const MAX_CONTEXT_TERMS = 50;
export const CONTEXT_VOCAB_PREFIX = "可能出现的专有名词：";

export type AsrCapabilities = {
  hotwords: number;
  promptChars: number;
  context: boolean;
  language: boolean;
  timestamps: boolean;
  maxUploadBytes: number;
  maxSeconds: number;
};

export type BuiltAsrHint =
  | {
      kind: "none";
      includedTerms: string[];
      hotwordsCsv?: undefined;
      prompt?: undefined;
      systemPrompt?: undefined;
      contextLine?: undefined;
    }
  | {
      kind: "hotwords";
      includedTerms: string[];
      hotwordsCsv: string;
      prompt?: undefined;
      systemPrompt?: undefined;
      contextLine?: undefined;
    }
  | {
      kind: "prompt";
      includedTerms: string[];
      prompt: string;
      hotwordsCsv?: undefined;
      systemPrompt?: undefined;
      contextLine?: undefined;
    }
  | {
      kind: "context";
      includedTerms: string[];
      systemPrompt: string;
      contextLine: string;
      hotwordsCsv?: undefined;
      prompt?: undefined;
    };

const WEIGHT_SUFFIX_RE = /\s*:\s*[+-]?\d+(?:\.\d+)?\s*$/;
const LEADING_COLONS_RE = /^:+/;
const INTERNAL_DELIMS_RE = /[,，;；\r\n\t]+/g;
const HAS_LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;
const ECHO_SEPARATORS_RE = /[\s,，、;；.。:：!！?？"'“”‘’「」『』()（）[\]【】\-—~·…]+/gu;
const DANGLING_LIST_SEP_RE = /[,，、;；]\s*$/u;
const CONTEXT_HEADER_STRIP_RE = /^(?:可能出现的专有名词|专有名词|词汇提示|热词列表)\s*[:：]\s*/iu;

export function capabilitiesForLocalModel(kind: AsrCatalogModelKind, hotwords?: number): AsrCapabilities {
  if (kind === "qwen3Asr" || kind === "funasrNano") {
    return {
      hotwords: hotwords ?? MAX_HOTWORD_TERMS,
      promptChars: 0,
      context: false,
      language: true,
      timestamps: true,
      maxUploadBytes: 0,
      maxSeconds: 30,
    };
  }
  return {
    hotwords: 0,
    promptChars: 0,
    context: false,
    language: true,
    timestamps: true,
    maxUploadBytes: 0,
    maxSeconds: 30,
  };
}

export function capabilitiesForExternalInterface(
  transcriptionInterface: "audio_transcriptions" | "chat_input_audio",
  options: {
    promptChars?: number;
    maxUploadBytes?: number;
    maxSeconds?: number;
    supportsLanguage?: boolean;
    supportsTimestamps?: boolean;
  } = {},
): AsrCapabilities {
  if (transcriptionInterface === "chat_input_audio") {
    return {
      hotwords: 0,
      promptChars: 0,
      context: true,
      language: options.supportsLanguage ?? true,
      timestamps: false,
      maxUploadBytes: options.maxUploadBytes ?? 20 * 1024 * 1024,
      maxSeconds: options.maxSeconds ?? 30,
    };
  }
  return {
    hotwords: 0,
    promptChars: options.promptChars ?? PROMPT_LIMIT_DEFAULT,
    context: false,
    language: options.supportsLanguage ?? true,
    timestamps: options.supportsTimestamps ?? true,
    maxUploadBytes: options.maxUploadBytes ?? 25 * 1024 * 1024,
    maxSeconds: options.maxSeconds ?? 30,
  };
}

/**
 * Cleans and deduplicates dictionary hint terms while preserving priority order:
 * - Strips leading `:` and trailing `:weight` suffixes (e.g. `"星野澪:2.5"` -> `"星野澪"`)
 * - Replaces embedded commas/newlines/tabs with spaces
 * - Skips empty or symbol-only entries
 * - Deduplicates case-insensitively keeping the earliest occurrence
 */
export function cleanVocabularyTerms(terms: readonly string[], maxTerms?: number): string[] {
  const limit = maxTerms !== undefined ? Math.max(0, maxTerms) : Number.POSITIVE_INFINITY;
  if (limit === 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    if (typeof raw !== "string") continue;
    const cleaned = raw
      .replace(LEADING_COLONS_RE, "")
      .replace(WEIGHT_SUFFIX_RE, "")
      .replace(INTERNAL_DELIMS_RE, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned || !HAS_LETTER_OR_DIGIT_RE.test(cleaned)) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

function buildLanguageInstruction(language: string | undefined): string {
  const trimmed = language?.trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") return "";
  return `主要语言：${trimmed}。`;
}

/**
 * Formats vocabulary hints strictly according to the selected engine's `AsrCapabilities`:
 * - `hotwords > 0` (`qwen3Asr`, `funasrNano`): ASCII comma-separated up to 50 terms.
 * - `promptChars > 0` (`audio_transcriptions`): comma-joined string capped at `promptChars` Unicode code points.
 * - `context === true` (`chat_input_audio`): system message containing `"可能出现的专有名词：..."` up to 50 terms.
 * - All `0`/`false` (`senseVoice` or unsupported): sends NO hint at all.
 */
export function buildVocabularyHint(
  capabilities: AsrCapabilities,
  rawTerms: readonly string[],
  options: { language?: string; baseSystemPrompt?: string } = {},
): BuiltAsrHint {
  if (capabilities.hotwords > 0) {
    const limit = Math.min(MAX_HOTWORD_TERMS, capabilities.hotwords);
    const includedTerms = cleanVocabularyTerms(rawTerms, limit);
    if (includedTerms.length === 0) {
      return { kind: "none", includedTerms: [] };
    }
    return {
      kind: "hotwords",
      includedTerms,
      hotwordsCsv: includedTerms.join(","),
    };
  }

  if (capabilities.promptChars > 0) {
    const cleaned = cleanVocabularyTerms(rawTerms);
    const includedTerms: string[] = [];
    let prompt = "";
    for (const term of cleaned) {
      const candidate = prompt ? `${prompt}, ${term}` : term;
      if ([...candidate].length > capabilities.promptChars) break;
      prompt = candidate;
      includedTerms.push(term);
    }
    if (!prompt) {
      return { kind: "none", includedTerms: [] };
    }
    return {
      kind: "prompt",
      includedTerms,
      prompt,
    };
  }

  if (capabilities.context) {
    const includedTerms = cleanVocabularyTerms(rawTerms, MAX_CONTEXT_TERMS);
    if (includedTerms.length === 0) {
      return { kind: "none", includedTerms: [] };
    }
    const basePrompt = (options.baseSystemPrompt ?? DEFAULT_CHAT_AUDIO_SYSTEM_PROMPT).trim();
    const langNote = capabilities.language ? buildLanguageInstruction(options.language) : "";
    const contextLine = `${CONTEXT_VOCAB_PREFIX}${includedTerms.join("、")}`;
    const header = [basePrompt, langNote].filter(Boolean).join("");
    return {
      kind: "context",
      includedTerms,
      contextLine,
      systemPrompt: `${header}\n${contextLine}`,
    };
  }

  return { kind: "none", includedTerms: [] };
}

function normalizeEchoKey(value: string): string {
  return value.replace(ECHO_SEPARATORS_RE, "").toLowerCase();
}

/**
 * Detects when an ASR model hallucinated or echoed back the supplied hotwords, prompt, or context glossary
 * instead of real speech (common on near-silence or background noise):
 * - Literal context header leak (`"可能出现的专有名词：..."`)
 * - `>= 80%` of normalized transcript characters covered by hint terms AND one of:
 *   - `>= 3` consecutive hint terms in hint order
 *   - Single hint term repeated `>= 3` times in a loop
 *   - `>= 3` distinct hint terms with no surrounding prose (`>= 80%` coverage)
 *   - Exact match of the full hint string (`length >= 6` and `>= 2` hint terms)
 *   - Truncated 2-term list ending in a dangling list separator (`,` / `，` / `、`)
 * Single-entity utterances (e.g. dictating `"星野澪"` into a search bar) are preserved (`false`).
 */
export function isHintEcho(transcript: string, hintTerms: readonly string[]): boolean {
  const rawTrimmed = transcript.trim();
  if (!rawTrimmed || hintTerms.length === 0) return false;

  const hadContextHeader = CONTEXT_HEADER_STRIP_RE.test(rawTrimmed);
  const bodyText = rawTrimmed.replace(CONTEXT_HEADER_STRIP_RE, "").trim();
  if (hadContextHeader && !bodyText) return true;

  const normalizedText = normalizeEchoKey(bodyText);
  if (!normalizedText) return false;

  const cleanedHints = cleanVocabularyTerms(hintTerms);
  const indexedTerms: Array<{ index: number; key: string }> = [];
  for (let i = 0; i < cleanedHints.length; i += 1) {
    const key = normalizeEchoKey(cleanedHints[i]!);
    if (key.length > 0) {
      indexedTerms.push({ index: i, key });
    }
  }
  if (indexedTerms.length === 0) return false;

  if (hadContextHeader) {
    // Any transcript starting with `"可能出现的专有名词："` followed predominantly by hint terms is a system-prompt echo.
    const byLenHeader = [...indexedTerms].sort((a, b) => b.key.length - a.key.length);
    let pos = 0;
    let covered = 0;
    while (pos < normalizedText.length) {
      const hit = byLenHeader.find((item) => normalizedText.startsWith(item.key, pos));
      if (hit) {
        covered += hit.key.length;
        pos += hit.key.length;
      } else {
        pos += 1;
      }
    }
    if (covered / normalizedText.length >= 0.5) return true;
  }

  // Match longest terms first so compound names ("魔王城") are matched before prefixes ("魔王").
  const byLength = [...indexedTerms].sort((a, b) => b.key.length - a.key.length);
  let position = 0;
  let matchedChars = 0;
  const sequence: number[] = [];

  while (position < normalizedText.length) {
    const hit = byLength.find((item) => normalizedText.startsWith(item.key, position));
    if (hit) {
      matchedChars += hit.key.length;
      sequence.push(hit.index);
      position += hit.key.length;
    } else {
      position += 1;
    }
  }

  const coverage = matchedChars / normalizedText.length;
  if (coverage < 0.8) return false;

  const counts = new Map<number, number>();
  for (const idx of sequence) {
    counts.set(idx, (counts.get(idx) ?? 0) + 1);
  }

  const repeatedLoop = [...counts.values()].some((count) => count >= 3);
  if (repeatedLoop) return true;

  let longestOrderedRun = 0;
  let currentRun = 0;
  for (let i = 0; i < sequence.length; i += 1) {
    if (i > 0 && sequence[i]! === sequence[i - 1]! + 1) {
      currentRun += 1;
    } else {
      currentRun = 1;
    }
    if (currentRun > longestOrderedRun) {
      longestOrderedRun = currentRun;
    }
  }
  if (longestOrderedRun >= 3) return true;

  if (counts.size >= 3) return true;

  const wholeHintNormalized = normalizeEchoKey(cleanedHints.join(""));
  if (cleanedHints.length >= 2 && wholeHintNormalized.length >= 6 && normalizedText === wholeHintNormalized) {
    return true;
  }

  if (sequence.length >= 2 && longestOrderedRun >= 2 && DANGLING_LIST_SEP_RE.test(bodyText)) {
    return true;
  }

  return false;
}
