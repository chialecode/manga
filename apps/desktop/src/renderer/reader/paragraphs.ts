/**
 * Paragraph layout for a text window. The window is split at line breaks into paragraphs; the separators stay in the DOM
 * as hidden text, so the text of the rendered body is still exactly the stored text and every selection offset stays valid.
 * Highlights and illustrations are cut into their paragraphs by code-point offset.
 */

export type ParagraphPart =
  | { kind: "text"; text: string; marked: boolean }
  | { kind: "image"; assetId: string; offset: number };

export type ParagraphPiece =
  | { kind: "paragraph"; start: number; parts: ParagraphPart[] }
  | { kind: "separator"; text: string }
  | { kind: "image"; assetId: string; offset: number };

/** `sliceStart` and the highlight / placement offsets are absolute code points; the pieces carry absolute starts too. */
export function layoutParagraphs(
  text: string,
  sliceStart: number,
  highlight: { start: number; end: number } | null,
  placements: Array<{ assetId: string; offset: number }>,
): ParagraphPiece[] {
  const chars = [...text];
  const length = chars.length;
  const markFrom = highlight ? Math.max(0, highlight.start - sliceStart) : -1;
  const markTo = highlight ? Math.min(length, highlight.end - sliceStart) : -1;
  const marks = markFrom >= 0 && markTo > markFrom;
  const images = placements
    .map((placement) => ({ assetId: placement.assetId, at: placement.offset - sliceStart, offset: placement.offset }))
    .filter((placement) => placement.at >= 0 && placement.at <= length)
    .sort((a, b) => a.at - b.at);
  let nextImage = 0;
  const pieces: ParagraphPiece[] = [];

  // Illustrations that sit in a separator, or before the first paragraph, are blocks of their own.
  const flushImagesUntil = (limit: number) => {
    while (nextImage < images.length && images[nextImage]!.at < limit) {
      const image = images[nextImage++]!;
      pieces.push({ kind: "image", assetId: image.assetId, offset: image.offset });
    }
  };

  let index = 0;
  while (index < length) {
    if (chars[index] === "\n") {
      let end = index;
      while (end < length && chars[end] === "\n") end += 1;
      flushImagesUntil(end);
      pieces.push({ kind: "separator", text: chars.slice(index, end).join("") });
      index = end;
      continue;
    }
    let end = index;
    while (end < length && chars[end] !== "\n") end += 1;
    const parts: ParagraphPart[] = [];
    // Cut points inside the paragraph: the mark's edges and the illustrations placed within it.
    const cuts = new Set<number>([index, end]);
    if (marks) {
      if (markFrom > index && markFrom < end) cuts.add(markFrom);
      if (markTo > index && markTo < end) cuts.add(markTo);
    }
    const inside: typeof images = [];
    while (nextImage < images.length && images[nextImage]!.at <= end) {
      // An illustration exactly at the paragraph's end belongs after it, with the separator that follows.
      if (images[nextImage]!.at === end && end < length) break;
      const image = images[nextImage++]!;
      inside.push(image);
      cuts.add(Math.max(index, Math.min(end, image.at)));
    }
    const ordered = [...cuts].sort((a, b) => a - b);
    let placed = 0;
    for (let cut = 0; cut < ordered.length; cut += 1) {
      const at = ordered[cut]!;
      while (placed < inside.length && inside[placed]!.at <= at) {
        const image = inside[placed++]!;
        parts.push({ kind: "image", assetId: image.assetId, offset: image.offset });
      }
      const to = ordered[cut + 1];
      if (to === undefined || to <= at) continue;
      parts.push({ kind: "text", text: chars.slice(at, to).join(""), marked: marks && at >= markFrom && to <= markTo });
    }
    while (placed < inside.length) {
      const image = inside[placed++]!;
      parts.push({ kind: "image", assetId: image.assetId, offset: image.offset });
    }
    pieces.push({ kind: "paragraph", start: sliceStart + index, parts });
    index = end;
  }
  flushImagesUntil(length + 1);
  return pieces;
}

/** The text a layout renders, in order. It must equal the window's text for offsets to stay valid. */
export function layoutText(pieces: ParagraphPiece[]): string {
  let out = "";
  for (const piece of pieces) {
    if (piece.kind === "separator") out += piece.text;
    else if (piece.kind === "paragraph") for (const part of piece.parts) if (part.kind === "text") out += part.text;
  }
  return out;
}
