import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { parsePdfBytes } from "../../packages/app-core/src/index.ts";
import { evidenceRunDir } from "../../scripts/desktop-paths.ts";
import { buildEmbeddedFontPdf, embeddableFontFile } from "../../scripts/samples/pdf-embedded-font.ts";
import { renderPdfPage } from "../helpers/pdf-pixels.ts";
import { isAvailable, sampleBytes } from "../helpers/samples.ts";

/**
 * LOOP-04: why the accent of a decomposed "e" + U+0301 drew away from its letter in the synthetic PDF sample.
 *
 * A PDF has no text shaping: a viewer draws each glyph at the pen position the file gives it. These tests draw the same
 * word three ways through a real embedded open-licence font and the same PDF.js options the product uses, and measure
 * where the accent lands against the letter body.
 */
const hasFont = embeddableFontFile() !== undefined;
const SIZE = 60;
const SCALE = 3;
const MARK = String.fromCharCode(0x301);
const PRECOMPOSED = "é";

type Drawn = { ctx: SKRSContext2D; width: number; height: number; accentOffsetEm: number };

/** Draws one letter and measures the horizontal distance, in em, between the centre of its top band (the accent) and its body. */
async function draw(text: string, options: Parameters<typeof buildEmbeddedFontPdf>[1]): Promise<Drawn> {
  const { ctx, width, height } = await renderPdfPage(buildEmbeddedFontPdf([{ text, x: 100, y: 200, size: SIZE }], options), SCALE);
  const w = Math.ceil(width);
  const h = Math.ceil(height);
  const data = ctx.getImageData(0, 0, w, h).data;
  const ink = (x: number, y: number) => data[(y * w + x) * 4]! < 128;
  let top = h;
  let bottom = 0;
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) if (ink(x, y)) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
  const centre = (from: number, to: number) => {
    let sum = 0;
    let count = 0;
    for (let y = from; y < to; y += 1) for (let x = 0; x < w; x += 1) if (ink(x, y)) { sum += x; count += 1; }
    return count ? sum / count : Number.NaN;
  };
  const span = bottom - top;
  const accent = centre(top, top + Math.floor(span * 0.12));
  const body = centre(top + Math.floor(span * 0.5), bottom);
  return { ctx, width: w, height: h, accentOffsetEm: (accent - body) / (SIZE * SCALE) };
}

describe.skipIf(!hasFont)("combining marks in a PDF drawn with a real embedded font (LOOP-04)", () => {
  it("draws the accent over its letter when the file positions it, and away from it when the file does not", async () => {
    const precomposed = await draw(PRECOMPOSED, {});
    const raw = await draw(`e${MARK}`, {});
    const rawZero = await draw(`e${MARK}`, { zeroAdvanceMarks: true });
    const placed = await draw(`e${MARK}`, { positionMarks: true });

    // A precomposed letter and a decomposed one whose file moves the pen back for the mark look alike.
    expect(Math.abs(precomposed.accentOffsetEm)).toBeLessThan(0.2);
    expect(Math.abs(placed.accentOffsetEm)).toBeLessThan(0.2);
    expect(Math.abs(placed.accentOffsetEm - precomposed.accentOffsetEm)).toBeLessThan(0.12);
    // A bare glyph run draws the mark at the pen position after the letter, well to its right...
    expect(raw.accentOffsetEm).toBeGreaterThan(0.4);
    // ...and giving the mark a zero advance (the change made in M1b) does not move where it is drawn.
    expect(rawZero.accentOffsetEm).toBeCloseTo(raw.accentOffsetEm, 2);

    // The three drawings side by side, for the delivery evidence.
    const crop = { x: 280, y: 400, w: 320, h: 240 };
    const sheet = createCanvas(crop.w * 3 + 20, crop.h);
    const out = sheet.getContext("2d");
    out.fillStyle = "#ffffff";
    out.fillRect(0, 0, sheet.width, sheet.height);
    [precomposed, raw, placed].forEach((item, index) => {
      out.drawImage((item.ctx as unknown as { canvas: ReturnType<typeof createCanvas> }).canvas, crop.x, crop.y, crop.w, crop.h, index * (crop.w + 10), 0, crop.w, crop.h);
    });
    const dir = evidenceRunDir("m2", "l1-combining-marks");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "comparison.png"), sheet.toBuffer("image/png"));
    fs.writeFileSync(path.join(dir, "measurements.json"), JSON.stringify({
      font: path.basename(embeddableFontFile()!),
      unit: "accent centre minus letter-body centre, in em",
      precomposed: Number(precomposed.accentOffsetEm.toFixed(3)),
      decomposedPositioned: Number(placed.accentOffsetEm.toFixed(3)),
      decomposedRaw: Number(raw.accentOffsetEm.toFixed(3)),
      decomposedRawZeroAdvance: Number(rawZero.accentOffsetEm.toFixed(3)),
      conclusion: "PDF.js draws what the file says; a bare e + U+0301 run needs a producer's mark positioning, so the sample generator was at fault, not the viewer or the text layer",
    }, null, 2));
  }, 120_000);

  it("reads every drawing as the same composed text, so quotes, notes and sources do not depend on how the accent was drawn", async () => {
    const word = `cafe${MARK} au lait, re${MARK}sume${MARK} e${MARK}e${MARK}`;
    const composed = word.normalize("NFC");
    expect(composed).not.toContain(MARK);
    for (const options of [{}, { zeroAdvanceMarks: true }, { positionMarks: true }]) {
      const parsed = await parsePdfBytes(buildEmbeddedFontPdf([{ text: word, x: 40, y: 300, size: 14 }], options));
      expect(parsed.parts[0]?.normalized, JSON.stringify(options)).toBe(composed);
    }
    const plain = await parsePdfBytes(buildEmbeddedFontPdf([{ text: composed, x: 40, y: 300, size: 14 }]));
    expect(plain.parts[0]?.normalized).toBe(composed);
  }, 120_000);

  it.skipIf(!isAvailable("pdf-combining-marks"))("the generated manual-check sample draws two decomposed lines and one precomposed, and reads all three as the same text", async () => {
    const parsed = await parsePdfBytes(new Uint8Array(sampleBytes("pdf-combining-marks")));
    const text = parsed.parts[0]?.normalized ?? "";
    const lines = ["A precomposed:", "B decomposed, positioned:", "C decomposed, raw:"].map((label) => {
      const at = text.indexOf(label);
      expect(at, label).toBeGreaterThanOrEqual(0);
      return text.slice(at + label.length).trim().split(/\s{2,}|\n/)[0]!.slice(0, "café résumé".length);
    });
    expect(lines).toEqual(["café résumé", "café résumé", "café résumé"]);
    expect(text).not.toContain(MARK);
  }, 120_000);
});
