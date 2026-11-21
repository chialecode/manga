/**
 * One TextItem → NFC/LF code-point map.
 * The parser stores these offsets and the text layer uses the same ranges for selection and source highlight.
 * DOM string length, innerText and Range.toString() are not substitutes: they drop EOL markers and split surrogate pairs.
 */

import { codePointLength, findQuoteMatches, normalizeText, sliceCodePoints } from "./text.ts";

export type CanonicalPiece = { text: string; eol: boolean };

export type CanonicalSpan = {
  /** Code-point start of this piece's text. The following EOL, when present, is the next code point and is not included. */
  start: number;
  end: number;
  eol: boolean;
};

export type CanonicalMap = {
  normalized: string;
  /** False when NFC would merge across a piece boundary, so a local offset must not be guessed. */
  stable: boolean;
  spans: CanonicalSpan[];
};

/** Map ordered text pieces onto one normalized string in O(N) for NFC/LF-stable pages. An EOL is a single LF code point after that piece. */
export function mapCanonicalPieces(pieces: CanonicalPiece[]): CanonicalMap {
  const spans: CanonicalSpan[] = [];
  const rawParts: string[] = [];
  const normParts: string[] = [];
  let cursor = 0;
  for (const piece of pieces) {
    const normPiece = normalizeText(piece.text).normalized;
    const len = codePointLength(normPiece);
    spans.push({ start: cursor, end: cursor + len, eol: piece.eol });
    cursor += len + (piece.eol ? 1 : 0);
    rawParts.push(piece.text, piece.eol ? "\n" : "");
    normParts.push(normPiece, piece.eol ? "\n" : "");
  }
  const raw = rawParts.join("");
  const joinedNorm = normParts.join("");
  const normalized = normalizeText(raw).normalized;
  if (joinedNorm === normalized) {
    return { normalized, stable: true, spans };
  }
  // Rare cross-boundary NFC/CRLF merge (e.g. combining mark split across TextItems): mark unstable and compute exact cumulative spans.
  const exactSpans: CanonicalSpan[] = [];
  let prefix = "";
  for (const piece of pieces) {
    const start = codePointLength(normalizeText(prefix).normalized);
    const end = codePointLength(normalizeText(prefix + piece.text).normalized);
    exactSpans.push({ start, end, eol: piece.eol });
    prefix += piece.text + (piece.eol ? "\n" : "");
  }
  return { normalized, stable: false, spans: exactSpans };
}

function snapUtf16(text: string, offset: number): number {
  const safe = Math.max(0, Math.min(offset, text.length));
  if (safe > 0 && safe < text.length) {
    const prev = text.charCodeAt(safe - 1);
    const curr = text.charCodeAt(safe);
    if (prev >= 0xd800 && prev <= 0xdbff && curr >= 0xdc00 && curr <= 0xdfff) return safe - 1;
  }
  return safe;
}

/**
 * A selection boundary relative to the pieces: inside one piece's text, or just after its EOL.
 * Boundaries in the gaps between pieces resolve to the start or end of a piece, or to the point after its EOL.
 */
export type PiecePoint = { piece: number; utf16: number } | { piece: number; afterEol: true };

/**
 * Code-point range of a selection, without leading or trailing whitespace and EOLs.
 * The text layer has no visible gaps, so edge whitespace only means the drag started or ended between lines.
 * Null when the map is not stable or nothing but whitespace is selected.
 */
export function selectionOffsets(
  pieces: CanonicalPiece[],
  start: PiecePoint,
  end: PiecePoint,
): { start: number; end: number; quote: string } | null {
  const map = mapCanonicalPieces(pieces);
  if (!map.stable) return null;
  const point = (marker: PiecePoint): number | null => {
    const span = map.spans[marker.piece];
    const piece = pieces[marker.piece];
    if (!span || !piece) return null;
    if ("afterEol" in marker) return span.end + (span.eol ? 1 : 0);
    const pieceLength = codePointLength(normalizeText(piece.text).normalized);
    if (span.end - span.start !== pieceLength) return null;
    const local = codePointLength(normalizeText(piece.text.slice(0, snapUtf16(piece.text, marker.utf16))).normalized);
    if (local > pieceLength) return null;
    return span.start + local;
  };
  let from = point(start);
  let to = point(end);
  if (from === null || to === null) return null;
  const chars = [...map.normalized];
  while (from < to && /\s/u.test(chars[from]!)) from += 1;
  while (to > from && /\s/u.test(chars[to - 1]!)) to -= 1;
  if (to <= from) return null;
  return { start: from, end: to, quote: chars.slice(from, to).join("") };
}

export type PdfSelectionPlacement = { quote: string; start: number; end: number } | { review: true };

/**
 * Place a page-local selection into stored code points.
 * A stable current representation keeps the selected occurrence, including a repeated quote.
 * An old representation falls back to a unique quote match and otherwise stays in review.
 */
export function alignPdfSelection(input: {
  pageText: string;
  stable: boolean;
  storedText: string;
  sliceStart: number;
  start: number;
  end: number;
}): PdfSelectionPlacement {
  const stored = normalizeText(input.storedText).normalized;
  const page = normalizeText(input.pageText).normalized;
  const storedLength = codePointLength(stored);
  if (input.end <= input.start || input.start < 0 || input.end > codePointLength(page)) return { review: true };
  const quote = sliceCodePoints(page, input.start, input.end);
  if (!quote.trim()) return { review: true };
  const pageHasStoredPrefix = input.sliceStart === 0 && sliceCodePoints(page, 0, storedLength) === stored;
  if (input.stable && pageHasStoredPrefix && input.end <= storedLength) {
    return {
      quote: sliceCodePoints(stored, input.start, input.end),
      start: input.start,
      end: input.end,
    };
  }
  if (input.stable && input.sliceStart > 0 && input.start >= input.sliceStart && input.end <= input.sliceStart + storedLength) {
    const windowText = sliceCodePoints(page, input.sliceStart, input.sliceStart + storedLength);
    if (windowText === stored) return { quote, start: input.start, end: input.end };
  }
  const matches = findQuoteMatches(stored, quote);
  if (matches.length === 1) {
    const match = matches[0]!;
    return { quote, start: input.sliceStart + match.start, end: input.sliceStart + match.end };
  }
  return { review: true };
}

/** Page-local highlight range. A repeated quote uses the stored range when the representations still agree. */
export function pdfHighlightRange(input: {
  pageText: string;
  stable: boolean;
  storedText: string;
  sliceStart: number;
  highlight: { start: number; end: number } | null;
  quote: string | null;
}): { start: number; end: number } | "review" | null {
  const stored = normalizeText(input.storedText).normalized;
  const page = normalizeText(input.pageText).normalized;
  const storedLength = codePointLength(stored);
  const aligned = input.stable && input.sliceStart === 0 && sliceCodePoints(page, 0, storedLength) === stored;
  if (input.highlight && aligned) {
    const start = input.highlight.start - input.sliceStart;
    const end = input.highlight.end - input.sliceStart;
    if (start >= 0 && end <= codePointLength(page) && end > start) return { start, end };
  }
  if (input.stable && input.highlight && input.sliceStart > 0) {
    const windowText = sliceCodePoints(page, input.sliceStart, input.sliceStart + storedLength);
    const start = input.highlight.start;
    const end = input.highlight.end;
    if (windowText === stored && start >= input.sliceStart && end <= input.sliceStart + storedLength && end > start) {
      return { start, end };
    }
  }
  const quote = input.quote?.trim() ? input.quote : null;
  if (!quote) return input.highlight ? "review" : null;
  const matches = findQuoteMatches(page, quote);
  if (matches.length === 1) return matches[0]!;
  return matches.length > 1 || input.highlight ? "review" : null;
}
