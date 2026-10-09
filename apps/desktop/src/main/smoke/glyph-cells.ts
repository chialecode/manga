/**
 * Tells whether a line of subtitle text was drawn with glyphs or with boxes. A font without Chinese letters draws every character as the same
 * empty box; the check cuts the ink of the line into one cell per character and counts how many different shapes there are. The ink is a mask of the
 * pixels that differ between the picture with the subtitle and the same picture without it.
 */

export type GlyphCells = {
  /** Where the line is (the lowest band of ink in the mask). */
  box: { x: number; y: number; w: number; h: number } | null;
  /** Cells the line was cut into, and how many of them have any ink. */
  cells: number;
  inked: number;
  /** Different shapes among the inked cells. */
  distinct: number;
};

const GRID = 8;

export function glyphCells(mask: Uint8Array, width: number, height: number, count: number): GlyphCells {
  const rowInk = (y: number) => { for (let x = 0; x < width; x += 1) if (mask[y * width + x]) return true; return false; };
  let bottom = height - 1;
  while (bottom >= 0 && !rowInk(bottom)) bottom -= 1;
  if (bottom < 0) return { box: null, cells: count, inked: 0, distinct: 0 };
  // The band: up from the lowest inked row until a few blank rows (the gap between two lines of text).
  let top = bottom;
  let blank = 0;
  for (let y = bottom - 1; y >= 0; y -= 1) {
    if (rowInk(y)) { top = y; blank = 0; } else { blank += 1; if (blank > 3) break; }
  }
  let left = width;
  let right = -1;
  for (let y = top; y <= bottom; y += 1) for (let x = 0; x < width; x += 1) if (mask[y * width + x]) { if (x < left) left = x; if (x > right) right = x; }
  const box = { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
  const shapes: string[] = [];
  for (let cell = 0; cell < count; cell += 1) {
    const x0 = Math.round(box.x + (box.w * cell) / count);
    const x1 = Math.round(box.x + (box.w * (cell + 1)) / count);
    // The cell's own ink, so the same shape is the same wherever it stands in its cell.
    let cl = x1;
    let cr = x0 - 1;
    let ct = bottom + 1;
    let cb = top - 1;
    for (let y = top; y <= bottom; y += 1) for (let x = x0; x < x1; x += 1) if (mask[y * width + x]) { if (x < cl) cl = x; if (x > cr) cr = x; if (y < ct) ct = y; if (y > cb) cb = y; }
    if (cr < cl) continue;
    const w = cr - cl + 1;
    const h = cb - ct + 1;
    let signature = "";
    for (let gy = 0; gy < GRID; gy += 1) {
      for (let gx = 0; gx < GRID; gx += 1) {
        const sx0 = cl + Math.floor((w * gx) / GRID);
        const sx1 = Math.max(sx0 + 1, cl + Math.floor((w * (gx + 1)) / GRID));
        const sy0 = ct + Math.floor((h * gy) / GRID);
        const sy1 = Math.max(sy0 + 1, ct + Math.floor((h * (gy + 1)) / GRID));
        let on = 0;
        let all = 0;
        for (let y = sy0; y < sy1 && y <= cb; y += 1) for (let x = sx0; x < sx1 && x <= cr; x += 1) { all += 1; if (mask[y * width + x]) on += 1; }
        signature += all > 0 && on / all >= 0.3 ? "1" : "0";
      }
    }
    shapes.push(signature);
  }
  return { box, cells: count, inked: shapes.length, distinct: new Set(shapes).size };
}

/** The mask of pixels that differ by more than `threshold` (summed over the colour channels) between two BGRA bitmaps of the same size. */
export function differenceMask(a: Uint8Array, b: Uint8Array, threshold = 90): Uint8Array {
  const pixels = Math.floor(Math.min(a.length, b.length) / 4);
  const mask = new Uint8Array(pixels);
  for (let index = 0; index < pixels; index += 1) {
    const at = index * 4;
    if (Math.abs(a[at]! - b[at]!) + Math.abs(a[at + 1]! - b[at + 1]!) + Math.abs(a[at + 2]! - b[at + 2]!) > threshold) mask[index] = 1;
  }
  return mask;
}
