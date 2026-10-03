import {
  NORMALIZATION_V1,
  PARSER_V1,
  type TextLocator,
} from "@manga/contracts/location";

export function codePoints(text: string): string[] {
  return [...text];
}

export function codePointLength(text: string): number {
  return codePoints(text).length;
}

export function sliceCodePoints(text: string, start: number, end: number): string {
  return codePoints(text).slice(start, end).join("");
}

/** Code-point search. Callers use this instead of UTF-16 indexOf when a quote may contain an EOL or a surrogate pair. */
export function findQuoteMatches(text: string, quote: string): Array<{ start: number; end: number }> {
  const hay = codePoints(text);
  const needle = codePoints(quote);
  const matches: Array<{ start: number; end: number }> = [];
  if (!needle.length) return matches;
  for (let index = 0; index <= hay.length - needle.length; index += 1) {
    if (needle.every((char, offset) => hay[index + offset] === char)) matches.push({ start: index, end: index + needle.length });
  }
  return matches;
}

export function decodeTextBuffer(buffer: Uint8Array, encoding: "utf-8" | "utf-16le" = "utf-8"): { text: string; bom: boolean } {
  if (encoding === "utf-8") {
    const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
    const slice = bom ? buffer.subarray(3) : buffer;
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(slice), bom };
  }
  const bom = buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe;
  const slice = bom ? buffer.subarray(2) : buffer;
  return { text: new TextDecoder("utf-16le", { fatal: true }).decode(slice), bom };
}

export function normalizeText(text: string, parserVersion = PARSER_V1): { normalized: string; parserVersion: string; bom: boolean } {
  const bom = text.charCodeAt(0) === 0xfeff;
  const withoutBom = bom ? text.slice(1) : text;
  const normalized = withoutBom.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return { normalized, parserVersion, bom };
}

export function createTextLocator(input: {
  partId: string;
  representationId: string;
  normalized: string;
  start: number;
  end: number;
}): TextLocator {
  return {
    kind: "text",
    partId: input.partId,
    representationId: input.representationId,
    normalizationVersion: NORMALIZATION_V1,
    range: { start: input.start, end: input.end },
    quote: { exact: sliceCodePoints(input.normalized, input.start, input.end) },
  };
}
