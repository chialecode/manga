import type { ChineseVariant } from "@manga/contracts";
import * as OpenCC from "opencc-js";

let toSimplifiedConverter: ((text: string) => string) | null = null;
let toTraditionalConverter: ((text: string) => string) | null = null;

function getConverter(variant: Exclude<ChineseVariant, "none">): (text: string) => string {
  if (variant === "simplified") {
    let fn = toSimplifiedConverter;
    if (!fn) {
      fn = OpenCC.Converter({ from: "t", to: "cn" }) as (text: string) => string;
      toSimplifiedConverter = fn;
    }
    return fn;
  }
  let fn = toTraditionalConverter;
  if (!fn) {
    fn = OpenCC.Converter({ from: "cn", to: "t" }) as (text: string) => string;
    toTraditionalConverter = fn;
  }
  return fn;
}

function isAsciiWordChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

/**
 * Converts text to Simplified or Traditional Chinese via lazy-initialized `opencc-js`
 * while preserving exact canonical spellings of dictionary terms (§4.9).
 */
export function convertChineseVariant(
  text: string,
  variant: ChineseVariant,
  protectedTerms: ReadonlyArray<string> = [],
): string {
  if (!text || variant === "none") return text;

  if (protectedTerms.length === 0) {
    return getConverter(variant)(text);
  }

  // Pre-filter candidates against 1-char / 2-char substrings of `text` so 5k-10k dictionaries stay O(text + hits).
  const chars = new Set<string>();
  const bigrams = new Set<string>();
  for (let i = 0; i < text.length; i += 1) {
    chars.add(text[i]!);
    if (i + 1 < text.length) bigrams.add(text.slice(i, i + 2));
  }

  const candidateSet = new Set<string>();
  for (let i = 0; i < protectedTerms.length; i += 1) {
    const t = protectedTerms[i]!.trim();
    if (!t || t.length > text.length) continue;
    if (t.length === 1 ? chars.has(t) : bigrams.has(t.slice(0, 2))) {
      candidateSet.add(t);
    }
  }

  if (candidateSet.size === 0) {
    return getConverter(variant)(text);
  }

  const uniqueTerms = Array.from(candidateSet).sort((a, b) => b.length - a.length);

  // Find non-overlapping exact occurrences of canonical dictionary terms (longest first)
  const spans: Array<{ start: number; end: number; term: string }> = [];
  for (const term of uniqueTerms) {
    const pureAscii = /^[A-Za-z0-9]+$/.test(term);
    let idx = text.indexOf(term);
    while (idx !== -1) {
      const end = idx + term.length;
      let boundaryOk = true;
      if (pureAscii) {
        if (idx > 0 && isAsciiWordChar(text.charCodeAt(idx - 1))) boundaryOk = false;
        if (end < text.length && isAsciiWordChar(text.charCodeAt(end))) boundaryOk = false;
      }
      if (boundaryOk) {
        let overlaps = false;
        for (let s = 0; s < spans.length; s += 1) {
          const existing = spans[s]!;
          if (!(end <= existing.start || idx >= existing.end)) {
            overlaps = true;
            break;
          }
        }
        if (!overlaps) {
          spans.push({ start: idx, end, term });
        }
      }
      idx = text.indexOf(term, idx + 1);
    }
  }

  if (spans.length === 0) {
    return getConverter(variant)(text);
  }

  spans.sort((a, b) => a.start - b.start);

  // Convert unprotected slices directly without PUA sentinels (avoids U+F8FF overflow and O(S*N) replace copies).
  const convert = getConverter(variant);
  let out = "";
  let cursor = 0;
  for (let i = 0; i < spans.length; i += 1) {
    const sp = spans[i]!;
    if (sp.start > cursor) {
      out += convert(text.slice(cursor, sp.start));
    }
    out += sp.term;
    cursor = sp.end;
  }
  if (cursor < text.length) {
    out += convert(text.slice(cursor));
  }
  return out;
}
