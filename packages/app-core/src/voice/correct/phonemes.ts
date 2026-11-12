/**
 * Adapted from HaujetZhao/asr-hotword (https://github.com/HaujetZhao/asr-hotword, commit 7e282137e780ac4096cac537bef360235d2efe43).
 * Copyright (c) 2026 HaujetZhao. Licensed under the MIT License.
 */

import { pinyin } from "pinyin-pro";
import * as wanakana from "wanakana";

export type PhonemeLang = "zh" | "en" | "num" | "other";

export type Phoneme = {
  value: string;
  lang: PhonemeLang;
  isWordStart: boolean;
  isWordEnd: boolean;
  isTone: boolean;
  charStart: number;
  charEnd: number;
};

const SMALL_KANA_OR_MARK = new Set([
  "ゃ", "ゅ", "ょ", "ぁ", "ぃ", "ぅ", "ぇ", "ぉ", "ゎ",
  "ャ", "ュ", "ョ", "ァ", "ィ", "ゥ", "ェ", "ォ", "ヮ", "ー",
]);

const SOKUON = new Set(["っ", "ッ"]);

const LETTER_RE = /\p{L}/u;

export function isCjkCodePoint(code: number): boolean {
  return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
}

/**
 * Hiragana (U+3041..U+3096) and Katakana (U+30A1..U+30FA, U+30FC..U+30FF),
 * deliberately excluding U+30FB (`・` middle dot) so katakana compound names split cleanly at `・`.
 */
export function isKanaCodePoint(code: number): boolean {
  return (
    (code >= 0x3041 && code <= 0x3096) ||
    (code >= 0x30a1 && code <= 0x30fa) ||
    (code >= 0x30fc && code <= 0x30ff)
  );
}

function isAsciiAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiUpper(code: number): boolean {
  return code >= 0x41 && code <= 0x5a;
}

function isAsciiLower(code: number): boolean {
  return code >= 0x61 && code <= 0x7a;
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function isAsciiAlnum(code: number): boolean {
  return isAsciiAlpha(code) || isAsciiDigit(code);
}

function processZhRun(text: string, start: number, out: Phoneme[]): number {
  let end = start + 1;
  while (end < text.length && isCjkCodePoint(text.charCodeAt(end))) {
    end += 1;
  }
  const fragment = text.slice(start, end);
  const items = pinyin(fragment, { type: "all", toneType: "none" });
  const len = Math.min(fragment.length, items.length);
  for (let i = 0; i < len; i += 1) {
    const idx = start + i;
    const info = items[i];
    if (!info || !info.isZh) {
      out.push({
        value: fragment[i]!,
        lang: "zh",
        isWordStart: true,
        isWordEnd: true,
        isTone: false,
        charStart: idx,
        charEnd: idx + 1,
      });
      continue;
    }
    const init = info.initial || "";
    const fin = info.final || "";
    const tone = String(info.num ?? 0);
    const hasInit = init.length > 0;
    const hasFin = fin.length > 0;

    if (!hasInit && !hasFin) {
      out.push({
        value: fragment[i]!,
        lang: "zh",
        isWordStart: true,
        isWordEnd: true,
        isTone: false,
        charStart: idx,
        charEnd: idx + 1,
      });
      continue;
    }

    if (hasInit) {
      out.push({
        value: init,
        lang: "zh",
        isWordStart: true,
        isWordEnd: false,
        isTone: false,
        charStart: idx,
        charEnd: idx + 1,
      });
    }
    if (hasFin) {
      out.push({
        value: fin,
        lang: "zh",
        isWordStart: !hasInit,
        isWordEnd: false,
        isTone: false,
        charStart: idx,
        charEnd: idx + 1,
      });
    }
    out.push({
      value: tone,
      lang: "zh",
      isWordStart: false,
      isWordEnd: true,
      isTone: true,
      charStart: idx,
      charEnd: idx + 1,
    });
  }
  return end;
}

function processKanaRun(text: string, start: number, out: Phoneme[]): number {
  let end = start + 1;
  while (end < text.length && isKanaCodePoint(text.charCodeAt(end))) {
    end += 1;
  }
  let pos = start;
  while (pos < end) {
    const moraStart = pos;
    while (pos < end && SOKUON.has(text[pos]!)) {
      pos += 1;
    }
    if (pos < end) {
      pos += 1;
      while (pos < end && SMALL_KANA_OR_MARK.has(text[pos]!)) {
        pos += 1;
      }
    }
    const moraEnd = pos;
    const mora = text.slice(moraStart, moraEnd);
    const romaji = wanakana.toRomaji(mora).toLowerCase().replace(/[^a-z]/g, "");
    if (!romaji) continue;
    for (let i = 0; i < romaji.length; i += 1) {
      out.push({
        value: romaji[i]!,
        lang: "en",
        isWordStart: i === 0,
        isWordEnd: i === romaji.length - 1,
        isTone: false,
        charStart: moraStart,
        charEnd: moraEnd,
      });
    }
  }
  return end;
}

function processAsciiRun(text: string, start: number, out: Phoneme[]): number {
  let end = start + 1;
  while (end < text.length && isAsciiAlnum(text.charCodeAt(end))) {
    end += 1;
  }

  let subStart = start;
  for (let i = start + 1; i <= end; i += 1) {
    let split = i === end;
    if (!split) {
      const prev = text.charCodeAt(i - 1);
      const curr = text.charCodeAt(i);
      if (
        (isAsciiLower(prev) && isAsciiUpper(curr)) ||
        (isAsciiAlpha(prev) && isAsciiDigit(curr)) ||
        (isAsciiDigit(prev) && isAsciiAlpha(curr))
      ) {
        split = true;
      }
    }
    if (split) {
      const len = i - subStart;
      const isNum = isAsciiDigit(text.charCodeAt(subStart));
      const lang: PhonemeLang = isNum ? "num" : "en";
      for (let k = 0; k < len; k += 1) {
        const idx = subStart + k;
        out.push({
          value: text[idx]!.toLowerCase(),
          lang,
          isWordStart: k === 0,
          isWordEnd: k === len - 1,
          isTone: false,
          charStart: idx,
          charEnd: idx + 1,
        });
      }
      subStart = i;
    }
  }
  return end;
}

/**
 * Converts mixed Chinese / Japanese Kana / Latin / numeric text into a sequence of
 * boundary-annotated phonemes preserving `[charStart, charEnd)` UTF-16 slices.
 */
export function toPhonemes(text: string): Phoneme[] {
  const out: Phoneme[] = [];
  let pos = 0;
  while (pos < text.length) {
    const code = text.charCodeAt(pos);
    if (isCjkCodePoint(code)) {
      pos = processZhRun(text, pos, out);
    } else if (isKanaCodePoint(code)) {
      pos = processKanaRun(text, pos, out);
    } else if (isAsciiAlnum(code)) {
      pos = processAsciiRun(text, pos, out);
    } else {
      const ch = String.fromCodePoint(text.codePointAt(pos)!);
      const step = ch.length;
      if (LETTER_RE.test(ch)) {
        out.push({
          value: ch.toLowerCase(),
          lang: "other",
          isWordStart: true,
          isWordEnd: true,
          isTone: false,
          charStart: pos,
          charEnd: pos + step,
        });
      }
      pos += step;
    }
  }
  return out;
}

/**
 * Generates a readable phonetic string for a term (used for LLM candidate hints and debugging).
 */
export function describeReading(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  let hasKana = false;
  let hasCjk = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (isKanaCodePoint(code)) hasKana = true;
    else if (isCjkCodePoint(code)) hasCjk = true;
  }
  if (hasKana && !hasCjk) {
    return wanakana.toRomaji(trimmed);
  }
  if (hasCjk) {
    return pinyin(trimmed, { toneType: "none", type: "array" }).join(" ");
  }
  return trimmed.toLowerCase();
}
