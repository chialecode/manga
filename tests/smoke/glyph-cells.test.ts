import { describe, expect, it } from "vitest";
import { differenceMask, glyphCells } from "../../apps/desktop/src/main/smoke/glyph-cells.ts";

const W = 200;
const H = 60;
const CELL = 20;

/** Ten cells of a line; `draw` fills the 14x14 ink area of each cell. */
function line(draw: (cell: number, x: number, y: number) => boolean, offsetY = 30): Uint8Array {
  const mask = new Uint8Array(W * H);
  for (let cell = 0; cell < 10; cell += 1) {
    for (let y = 0; y < 14; y += 1) for (let x = 0; x < 14; x += 1) if (draw(cell, x, y)) mask[(offsetY + y) * W + cell * CELL + 3 + x] = 1;
  }
  return mask;
}

describe("AT-84 glyph check: boxes tell apart from letters", () => {
  it("counts many different shapes in a line of ten different characters", () => {
    // Every cell gets its own pattern: stripes of a different period and direction.
    const mask = line((cell, x, y) => (cell % 2 === 0 ? (x + cell) % (cell + 2) < 2 : (y + cell) % (cell + 2) < 2) || (x === cell && y < 8));
    const result = glyphCells(mask, W, H, 10);
    expect(result.inked).toBe(10);
    expect(result.distinct).toBeGreaterThanOrEqual(8);
    expect(result.box).not.toBeNull();
  });

  it("counts one shape when every character is drawn as the same box", () => {
    const box = line((_cell, x, y) => x === 0 || y === 0 || x === 13 || y === 13);
    const result = glyphCells(box, W, H, 10);
    expect(result.inked).toBe(10);
    expect(result.distinct).toBe(1);
  });

  it("looks at the lowest line only, and says there is nothing when there is no ink", () => {
    const both = line((cell, x) => (x + cell) % 3 === 0, 40);
    // A second line far above, of one solid block.
    for (let y = 2; y < 10; y += 1) for (let x = 0; x < W; x += 1) both[y * W + x] = 1;
    const result = glyphCells(both, W, H, 10);
    expect(result.box!.y).toBeGreaterThanOrEqual(40);
    expect(glyphCells(new Uint8Array(W * H), W, H, 10)).toEqual({ box: null, cells: 10, inked: 0, distinct: 0 });
  });

  it("makes the ink mask from two pictures of the same size", () => {
    const a = new Uint8Array(4 * 4);
    const b = new Uint8Array(4 * 4);
    b.set([255, 255, 255, 255], 4);
    expect([...differenceMask(a, b)]).toEqual([0, 1, 0, 0]);
  });
});
