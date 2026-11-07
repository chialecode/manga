import {
  NORMALIZATION_V1,
  PARSER_V1,
  type AnchorResolveResult,
  type TextLocator,
} from "@manga/contracts";

export type NormalizedText = {
  original: string;
  normalized: string;
  normalizationVersion: string;
  parserVersion: string;
  bom: boolean;
  mapToOriginal: number[];
};

export function codePoints(text: string): string[] {
  return [...text];
}

export function codePointLength(text: string): number {
  return codePoints(text).length;
}

export function sliceCodePoints(text: string, start: number, end: number): string {
  return codePoints(text).slice(start, end).join("");
}

export function codePointRangeToUtf16(text: string, start: number, end: number): { start: number; end: number } {
  const chars = codePoints(text);
  const prefix = chars.slice(0, start).join("");
  const inner = chars.slice(start, end).join("");
  return { start: prefix.length, end: prefix.length + inner.length };
}

export function utf16RangeToCodePoints(text: string, start: number, end: number): { start: number; end: number } {
  const before = codePointLength(text.slice(0, start));
  const inner = codePointLength(text.slice(start, end));
  return { start: before, end: before + inner };
}

export function decodeTextBuffer(buffer: Uint8Array, encoding: "utf-8" | "utf-16le" | "shift-jis" = "utf-8"): {
  text: string;
  bom: boolean;
} {
  if (encoding === "utf-8") {
    const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    const slice = bom ? buffer.subarray(3) : buffer;
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(slice), bom };
  }
  if (encoding === "utf-16le") {
    const bom = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
    const slice = bom ? buffer.subarray(2) : buffer;
    return { text: new TextDecoder("utf-16le", { fatal: true }).decode(slice), bom };
  }
  throw new Error(`M0 prototype does not include ${encoding} decoder; use utf-8 samples or an explicit fixture map`);
}

export function normalizeText(text: string, parserVersion = PARSER_V1): NormalizedText {
  const bom = text.charCodeAt(0) === 0xfeff;
  const withoutBom = bom ? text.slice(1) : text;
  const normalizedPoints: string[] = [];
  const mapToOriginal: number[] = [];
  let originalOffset = 0;
  for (const {segment} of new Intl.Segmenter("und",{granularity:"grapheme"}).segment(withoutBom)) {
    const transformed=segment.normalize("NFC").replaceAll("\r\n","\n").replaceAll("\r","\n");
    let within=0;
    for (let char of transformed) {
      if(parserVersion === "novel-parser-v2-spacing" && /[ \t]/.test(char)) {
        char=" "; if(normalizedPoints.at(-1) === " ") continue;
      }
      normalizedPoints.push(char); mapToOriginal.push(originalOffset + (transformed === segment ? within : 0)); within++;
    }
    originalOffset += codePointLength(segment);
  }
  const normalized = normalizedPoints.join("");
  return {
    original: withoutBom,
    normalized,
    normalizationVersion: NORMALIZATION_V1,
    parserVersion,
    bom,
    mapToOriginal,
  };
}

export function createTextLocator(input: {
  partId: string;
  representationId: string;
  normalized: string;
  start: number;
  end: number;
  normalizationVersion?: string;
}): TextLocator {
  const exact = sliceCodePoints(input.normalized, input.start, input.end);
  const prefix = sliceCodePoints(input.normalized, Math.max(0, input.start - 8), input.start);
  const suffix = sliceCodePoints(input.normalized, input.end, Math.min(codePointLength(input.normalized), input.end + 8));
  return {
    kind: "text",
    partId: input.partId,
    representationId: input.representationId,
    normalizationVersion: input.normalizationVersion ?? NORMALIZATION_V1,
    range: { start: input.start, end: input.end },
    quote: { exact, prefix, suffix },
  };
}

export function findQuoteMatches(text: string, quote: string): Array<{ start: number; end: number }> {
  const hay = codePoints(text);
  const needle = codePoints(quote);
  const matches: Array<{ start: number; end: number }> = [];
  if (needle.length === 0) return matches;
  for (let i = 0; i <= hay.length - needle.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) matches.push({ start: i, end: i + needle.length });
  }
  return matches;
}

export function resolveTextLocator(
  locator: TextLocator,
  representation: { id: string; normalized: string; parserVersion: string; available: boolean },
  options: { resourceExists?: boolean; revisionExists?: boolean; capability?: boolean } = {},
): AnchorResolveResult {
  if (options.resourceExists === false) return { status: "missing_resource" };
  if (options.revisionExists === false) return { status: "missing_revision" };
  if (options.capability === false) return { status: "missing_capability" };
  if (!representation.available) return { status: "unresolved", reason: "representation unavailable" };
  if (representation.id !== locator.representationId && locator.quote?.exact) {
    return resolveByQuote(locator, representation.normalized);
  }
  const { start, end } = locator.range;
  if (end > codePointLength(representation.normalized)) {
    return locator.quote?.exact
      ? resolveByQuote(locator, representation.normalized)
      : { status: "unresolved", reason: "range past end" };
  }
  const text = sliceCodePoints(representation.normalized, start, end);
  if (locator.quote?.exact && text !== locator.quote.exact) {
    return resolveByQuote(locator, representation.normalized);
  }
  return {
    status: "resolved",
    text,
    utf16Range: codePointRangeToUtf16(representation.normalized, start, end),
  };
}

function resolveByQuote(locator: TextLocator, normalized: string): AnchorResolveResult {
  const exact = locator.quote?.exact;
  if (!exact) return { status: "unresolved", reason: "quote missing" };
  const matches = findQuoteMatches(normalized, exact).map((item) => ({
    ...item,
    text: sliceCodePoints(normalized, item.start, item.end),
  }));
  if (matches.length === 1) {
    const match = matches[0]!;
    return {
      status: "resolved",
      text: match.text,
      utf16Range: codePointRangeToUtf16(normalized, match.start, match.end),
    };
  }
  if (matches.length > 1) {
    return {
      status: "needs_review",
      candidates: matches,
      reason: "ambiguous duplicate sentence",
    };
  }
  return { status: "unresolved", reason: "quote not found" };
}
