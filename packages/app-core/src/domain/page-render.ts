/**
 * Neutral page model shared by fixed-layout EPUB drawing.
 * PDF pages are painted by PDF.js and do not use this operator list.
 */

export type PdfRenderItem =
  | { k: "t"; x: number; y: number; s: number; f: string; t: string; c?: string; o?: number; w?: number; gx?: number[] }
  | { k: "r"; x: number; y: number; w: number; h: number; c: string }
  | { k: "e"; x: number; y: number; w: number; h: number; c: string }
  | { k: "l"; p: number[]; c: string; w: number }
  | { k: "i"; x: number; y: number; w: number; h: number; a?: string };

/** User-space page box, y up, used by the EPUB fixed-layout view. */
export type PdfPageRender = { w: number; h: number; items: PdfRenderItem[]; truncated?: boolean };
