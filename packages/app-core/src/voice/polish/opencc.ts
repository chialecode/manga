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

  const uniqueTerms = Array.from(
    new Set(protectedTerms.map((t) => t.trim()).filter((t) => t.length > 0)),
  ).sort((a, b) => b.length - a.length);

  if (uniqueTerms.length === 0) {
    return getConverter(variant)(text);
  }

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

  // Mask protected spans using Private Use Area sentinels untouched by OpenCC
  let masked = "";
  let cursor = 0;
  for (let i = 0; i < spans.length; i += 1) {
    const sp = spans[i]!;
    masked += text.slice(cursor, sp.start);
    masked += `\uE0FF${String.fromCharCode(0xe100 + i)}\uE0FE`;
    cursor = sp.end;
  }
  masked += text.slice(cursor);

  const converted = getConverter(variant)(masked);

  let restored = converted;
  for (let i = 0; i < spans.length; i += 1) {
    const token = `\uE0FF${String.fromCharCode(0xe100 + i)}\uE0FE`;
    restored = restored.replace(token, () => spans[i]!.term);
  }
  return restored;
}
