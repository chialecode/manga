import type { PolishMode } from "@manga/contracts";
import type { RecalledCandidate } from "../correct/index.ts";
import { POLISH_MAX_LENGTH_RATIO, POLISH_MIN_LENGTH_RATIO } from "./prompts.ts";

export type PolishSkipReason = "empty" | "raw_mode" | "no_connection" | "clean_light";

export type PolishFallbackReason =
  | "timeout"
  | "llm_error"
  | "empty_output"
  | "length_out_of_range"
  | "unexpected_entity"
  | "repetition";

const INTERJECTION_FILLER_RE =
  /(?:^|[，,。！？、；\s…])(?:嗯+|呃+|额+|唔+|唉+|哎呀|诶+)(?:[，,。！？、；\s…]+|$)|^(?:嗯+|呃+|额+|唔+|诶+)(?=[我你他她这那就但实在今明昨])|[嗯呃额唔]{2,}/u;

const PHRASE_FILLER_RE =
  /就是说|怎么说呢|这个这个|那个那个|然后然后|(?:^|[，,。！？、\s])那个(?:[，,、\s…]|$)/u;

const STUTTER_RE =
  /([\u4e00-\u9fff])\1{2,}|(?:^|[，,。！？、\s])(我|你|他|她|这|那|是|就|在)\2(?=[\u4e00-\u9fff])/u;

const SELF_REPAIR_RE =
  /不对[，,、\s]*是|不是[，,、\s]*我是说|我是说|应该叫|准确说是|更正一下|说错了[，,、\s]*是|不对不对|或者说应该叫/u;

const LATIN_WORD_RE = /[A-Za-z]{2,}/g;
const KATAKANA_WORD_RE = /[\u30A1-\u30FA\u30FC-\u30FF]{2,}/g;

/**
 * Detects oral fillers/disfluencies (`嗯、啊、呃、那个、就是说…`) or mid-sentence self-repairs (`不对是…`).
 */
export function hasDisfluencyOrRepair(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (INTERJECTION_FILLER_RE.test(trimmed)) return true;
  if (PHRASE_FILLER_RE.test(trimmed)) return true;
  if (STUTTER_RE.test(trimmed)) return true;
  if (SELF_REPAIR_RE.test(trimmed)) return true;
  // Also catch standalone `啊` used as an oral hesitation marker with punctuation around it (e.g. `啊，我想想`)
  if (/(?:^|[，,。！？、\s])啊[，,、…]+/u.test(trimmed)) return true;
  return false;
}

/**
 * Guardrail 1 (§4.9): Determines whether to bypass the LLM call completely.
 */
export function checkPolishSkip(input: {
  mode: PolishMode;
  hasConnection: boolean;
  correctedText: string;
  candidates: ReadonlyArray<RecalledCandidate>;
}): PolishSkipReason | null {
  if (!input.correctedText.trim()) return "empty";
  if (input.mode === "raw") return "raw_mode";
  if (!input.hasConnection) return "no_connection";
  if (
    input.mode === "light" &&
    input.candidates.length === 0 &&
    !hasDisfluencyOrRepair(input.correctedText)
  ) {
    return "clean_light";
  }
  return null;
}

function codePointLen(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function isAsciiAlphaCode(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function containsWholeTerm(haystack: string, haystackLower: string, term: string): boolean {
  const t = term.trim();
  if (!t) return false;
  const pureAscii = /^[A-Za-z0-9]+$/.test(t);
  if (pureAscii) {
    const target = t.toLowerCase();
    let idx = haystackLower.indexOf(target);
    while (idx !== -1) {
      const end = idx + target.length;
      const beforeOk = idx === 0 || !isAsciiAlphaCode(haystack.charCodeAt(idx - 1));
      const afterOk = end === haystack.length || !isAsciiAlphaCode(haystack.charCodeAt(end));
      if (beforeOk && afterOk) return true;
      idx = haystackLower.indexOf(target, idx + 1);
    }
    return false;
  }
  return haystack.includes(t);
}

function stripPunctAndSpace(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, "");
}

function hasPathologicalFullRepetition(correctedText: string, polishedText: string): boolean {
  const normOut = stripPunctAndSpace(polishedText);
  if (codePointLen(normOut) < 8) return false;
  const normIn = stripPunctAndSpace(correctedText);

  // Check if output is `S + S` (or `S + S + S`) while input was NOT already repeated
  const chars = Array.from(normOut);
  for (const parts of [2, 3]) {
    if (chars.length % parts !== 0) continue;
    const chunkLen = chars.length / parts;
    if (chunkLen < 4) continue;
    const first = chars.slice(0, chunkLen).join("");
    let allSame = true;
    for (let k = 1; k < parts; k += 1) {
      if (chars.slice(k * chunkLen, (k + 1) * chunkLen).join("") !== first) {
        allSame = false;
        break;
      }
    }
    if (allSame && !normIn.includes(first + first)) {
      return true;
    }
  }
  return false;
}

/**
 * Guardrail 4 (§4.9): Validates LLM output against length bounds, repetition, and hallucinated
 * dictionary terms / Latin words / Katakana words.
 */
export function validatePolishOutput(input: {
  correctedText: string;
  polishedText: string;
  candidates: ReadonlyArray<RecalledCandidate>;
  dictionaryTerms?: ReadonlyArray<string>;
}): PolishFallbackReason | null {
  const baseTrimmed = input.correctedText.trim();
  const outTrimmed = input.polishedText.trim();
  if (!outTrimmed) return "empty_output";

  if (hasPathologicalFullRepetition(baseTrimmed, outTrimmed)) {
    return "repetition";
  }

  const baseLen = codePointLen(baseTrimmed);
  const outLen = codePointLen(outTrimmed);
  if (baseLen > 0) {
    const ratio = outLen / baseLen;
    if (ratio < POLISH_MIN_LENGTH_RATIO || ratio > POLISH_MAX_LENGTH_RATIO) {
      return "length_out_of_range";
    }
  }

  const allowedTexts = [
    baseTrimmed,
    ...input.candidates.map((c) => c.term),
    ...input.candidates.map((c) => c.readingOrOriginal),
  ];
  const allowedJoined = allowedTexts.join("\n");
  const allowedLower = allowedJoined.toLowerCase();
  const outLower = outTrimmed.toLowerCase();

  // 1. Check Latin words in output (`[A-Za-z]{2,}`)
  const outLatin = outTrimmed.match(LATIN_WORD_RE);
  if (outLatin) {
    const allowedLatinSet = new Set(
      (allowedJoined.match(LATIN_WORD_RE) ?? []).map((w) => w.toLowerCase()),
    );
    for (const word of outLatin) {
      const lower = word.toLowerCase();
      if (!allowedLatinSet.has(lower) && !allowedLower.includes(lower)) {
        return "unexpected_entity";
      }
    }
  }

  // 2. Check Katakana words in output (`[\u30A1-\u30FA\u30FC-\u30FF]{2,}`)
  const outKatakana = outTrimmed.match(KATAKANA_WORD_RE);
  if (outKatakana) {
    for (const kata of outKatakana) {
      if (!allowedJoined.includes(kata)) {
        return "unexpected_entity";
      }
    }
  }

  // 3. Check unprompted dictionary terms introduced by the LLM
  if (input.dictionaryTerms && input.dictionaryTerms.length > 0) {
    for (const rawTerm of input.dictionaryTerms) {
      const term = rawTerm.trim();
      if (codePointLen(term) < 2) continue;
      if (!containsWholeTerm(outTrimmed, outLower, term)) continue;
      if (!containsWholeTerm(allowedJoined, allowedLower, term)) {
        return "unexpected_entity";
      }
    }
  }

  return null;
}
