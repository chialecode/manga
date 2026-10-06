// Synthetic page and cover images. Digits are drawn as seven-segment rectangles so no font is involved and the
// result is identical on every machine: a test can read the page number back from pixels.
import sharp from "sharp";

const SEGMENTS = { 0: "abcdef", 1: "bc", 2: "abdeg", 3: "abcdg", 4: "bcfg", 5: "acdfg", 6: "acdefg", 7: "abc", 8: "abcdefg", 9: "abcdfg" };

function digitSvg(digit, x, y, w, h, thickness, color) {
  const on = SEGMENTS[digit];
  const t = thickness;
  const rects = {
    a: [x + t, y, w - 2 * t, t],
    b: [x + w - t, y + t, t, h / 2 - t],
    c: [x + w - t, y + h / 2, t, h / 2 - t],
    d: [x + t, y + h - t, w - 2 * t, t],
    e: [x, y + h / 2, t, h / 2 - t],
    f: [x, y + t, t, h / 2 - t],
    g: [x + t, y + h / 2 - t / 2, w - 2 * t, t],
  };
  return [...on].map((segment) => `<rect x="${rects[segment][0]}" y="${rects[segment][1]}" width="${rects[segment][2]}" height="${rects[segment][3]}" fill="${color}"/>`).join("");
}

/** SVG fragment for a string of digits whose box is (x, y, width, height). */
export function digitsSvg(text, x, y, width, height, color = "#111") {
  const chars = [...text];
  const gap = width * 0.08;
  const cell = (width - gap * (chars.length - 1)) / chars.length;
  const thickness = Math.max(2, Math.min(cell, height) * 0.16);
  return chars.map((ch, index) => (/\d/.test(ch) ? digitSvg(Number(ch), x + index * (cell + gap), y, cell, height, thickness, color) : "")).join("");
}

const PALETTE = ["#f2d7d5", "#d6eaf8", "#d5f5e3", "#fcf3cf", "#e8daef", "#fae5d3", "#d0ece7", "#f6ddcc"];

/**
 * One page: tinted background, a frame, four corner marks (so crops and rotations are visible), a large number.
 * `label` is digits only. `variant` picks the tint so neighbouring pages differ.
 */
export function pageSvg({ width, height, label, variant = 0, caption }) {
  const bg = PALETTE[variant % PALETTE.length];
  const frame = Math.max(4, Math.round(Math.min(width, height) * 0.015));
  const numberHeight = Math.min(height * 0.3, width * 0.45);
  const numberWidth = Math.min(width * 0.7, numberHeight * 0.65 * label.length);
  const nx = (width - numberWidth) / 2;
  const ny = (height - numberHeight) / 2;
  const mark = Math.round(Math.min(width, height) * 0.06);
  const captionSvg = caption ? digitsSvg(caption, width * 0.1, height * 0.08, width * 0.3, height * 0.05, "#555") : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<rect width="${width}" height="${height}" fill="${bg}"/>`
    + `<rect x="${frame}" y="${frame}" width="${width - 2 * frame}" height="${height - 2 * frame}" fill="none" stroke="#333" stroke-width="${frame}"/>`
    + `<rect x="${frame * 2}" y="${frame * 2}" width="${mark}" height="${mark}" fill="#c0392b"/>`
    + `<rect x="${width - frame * 2 - mark}" y="${frame * 2}" width="${mark}" height="${mark}" fill="#2874a6"/>`
    + `<rect x="${frame * 2}" y="${height - frame * 2 - mark}" width="${mark}" height="${mark}" fill="#1e8449"/>`
    + `<rect x="${width - frame * 2 - mark}" y="${height - frame * 2 - mark}" width="${mark}" height="${mark}" fill="#b7950b"/>`
    + digitsSvg(label, nx, ny, numberWidth, numberHeight)
    + captionSvg
    + `</svg>`;
}

/** Render a page to PNG, JPEG, WebP or GIF bytes. */
export async function renderPage({ width = 600, height = 900, label, variant = 0, caption, format = "png", quality = 85 }) {
  const image = sharp(Buffer.from(pageSvg({ width, height, label, variant, caption })));
  if (format === "png") return image.png({ compressionLevel: 9 }).toBuffer();
  if (format === "jpg" || format === "jpeg") return image.jpeg({ quality }).toBuffer();
  if (format === "webp") return image.webp({ quality }).toBuffer();
  if (format === "gif") return image.gif().toBuffer();
  throw new Error(`unknown format ${format}`);
}

/** A long vertical strip: stacked sections, each labelled with its index (1-based), colours alternate. */
export async function renderStrip({ width = 800, height = 16000, sections = 16 }) {
  const sectionHeight = height / sections;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`];
  for (let i = 0; i < sections; i += 1) {
    const y = i * sectionHeight;
    parts.push(`<rect x="0" y="${y}" width="${width}" height="${sectionHeight}" fill="${PALETTE[i % PALETTE.length]}"/>`);
    parts.push(`<rect x="0" y="${y}" width="${width}" height="6" fill="#333"/>`);
    parts.push(digitsSvg(String(i + 1).padStart(2, "0"), width * 0.3, y + sectionHeight * 0.3, width * 0.4, sectionHeight * 0.4));
  }
  parts.push("</svg>");
  return sharp(Buffer.from(parts.join(""))).png({ compressionLevel: 9 }).toBuffer();
}

/** Cover art: portrait panel with a title-bar stripe. The number identifies the cover in tests. */
export async function renderCover({ width = 600, height = 900, label = "1", variant = 0, format = "png" }) {
  return renderPage({ width, height, label, variant, format, quality: 88 });
}
