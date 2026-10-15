/** How text is cut into the pieces that get a vector: a larger piece keeps more context, a smaller one finds a passage more exactly. */
export const SEGMENTATIONS = { "paragraph-300": 300, "paragraph-600": 600, "paragraph-1200": 1200 } as const;
export type SegmentationId = keyof typeof SEGMENTATIONS;
export const DEFAULT_SEGMENTATION: SegmentationId = "paragraph-600";
export const isSegmentation = (value: string): value is SegmentationId => Object.prototype.hasOwnProperty.call(SEGMENTATIONS, value);

/** A piece of a text. Offsets count code points from the start of the text, the way locators do, so a hit can be opened at its place. */
export type Chunk = { start: number; end: number; text: string };

const SENTENCE_END = new Set(["。", "！", "？", "!", "?", "；", ";", "…"]);
const CLOSERS = new Set(["”", "’", "」", "』", "）", ")", "\"", "'", "】", "》"]);
const isSpace = (char: string) => /\s/u.test(char);

/** The ends of the units a text is packed from: a line break, or the end of a sentence together with any closing quote after it. */
function unitEnds(chars: string[]): number[] {
  const ends: number[] = [];
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i]!;
    if (char === "\n") { ends.push(i + 1); continue; }
    const terminator = SENTENCE_END.has(char) || (char === "." && (i + 1 >= chars.length || isSpace(chars[i + 1]!)));
    if (!terminator) continue;
    let end = i + 1;
    while (end < chars.length && (SENTENCE_END.has(chars[end]!) || CLOSERS.has(chars[end]!))) end += 1;
    ends.push(end);
    i = end - 1;
  }
  if (!ends.length || ends[ends.length - 1] !== chars.length) ends.push(chars.length);
  return ends;
}

/**
 * Packs the sentences and lines of a text into pieces of at most `size` code points, never splitting a sentence unless a single one is longer
 * than that. The pieces cover the text in order and do not overlap; whitespace at their edges is left out of the offsets.
 */
export function chunkText(text: string, size: number): Chunk[] {
  const chars = Array.from(text);
  if (!chars.length) return [];
  const chunks: Chunk[] = [];
  const emit = (from: number, to: number) => {
    let start = from;
    let end = to;
    while (start < end && isSpace(chars[start]!)) start += 1;
    while (end > start && isSpace(chars[end - 1]!)) end -= 1;
    if (end > start) chunks.push({ start, end, text: chars.slice(start, end).join("") });
  };
  let from = 0;
  let unitStart = 0;
  for (const unitEnd of unitEnds(chars)) {
    if (unitEnd - unitStart > size) {
      // One sentence is longer than a piece: what is packed so far goes first, then the sentence is cut at the limit.
      if (unitStart > from) { emit(from, unitStart); from = unitStart; }
      for (let at = unitStart; at < unitEnd; at += size) emit(at, Math.min(unitEnd, at + size));
      from = unitEnd;
    } else if (unitEnd - from > size) {
      emit(from, unitStart);
      from = unitStart;
    }
    unitStart = unitEnd;
  }
  if (from < chars.length) emit(from, chars.length);
  return chunks;
}

/** How many pieces a text of this many code points is expected to give, for a progress total before the text is cut. */
export function estimateChunks(codePoints: number, size: number): number {
  return Math.max(1, Math.ceil(codePoints / Math.max(1, Math.floor(size * 0.8))));
}
