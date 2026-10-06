import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";

/**
 * A synthetic PDF that carries a real TrueType font program under an open licence (SIL OFL or similar), so glyph shapes and
 * combining-mark outlines are the font's own. The existing fixture generator writes a CID font with no program; this builder
 * exists to tell the two cases apart (LOOP-04). The font is read from the machine, never copied into the repository: the file
 * named by MANGA_TEST_PDF_FONT, else the first of the open-licence candidates below that exists. Test and sample use only.
 */

// Smaller files first: the font program is embedded whole, and a CJK font is tens of megabytes.
const CANDIDATES = [
  process.env.MANGA_TEST_PDF_FONT,
  "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  path.join(process.env.WINDIR ?? "", "Fonts", "CascadiaMono.ttf"),
  path.join(process.env.WINDIR ?? "", "Fonts", "NotoSansSC-VF.ttf"),
].filter((item): item is string => Boolean(item));

/** The open-licence TrueType file this machine offers, or undefined when it has none (the caller records not-run). */
export function embeddableFontFile(): string | undefined {
  return CANDIDATES.find((file) => /\.ttf$/i.test(file) && fs.existsSync(file));
}

type Font = {
  bytes: Buffer;
  unitsPerEm: number;
  advance: (gid: number) => number;
  glyphFor: (code: number) => number | undefined;
  /** Horizontal extent of the outline in font units, or undefined for an empty glyph. */
  extent: (gid: number) => { min: number; max: number } | undefined;
};

function parseFont(bytes: Buffer): Font {
  const tableCount = bytes.readUInt16BE(4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let index = 0; index < tableCount; index += 1) {
    const at = 12 + index * 16;
    tables.set(bytes.toString("ascii", at, at + 4), { offset: bytes.readUInt32BE(at + 8), length: bytes.readUInt32BE(at + 12) });
  }
  const table = (name: string) => {
    const found = tables.get(name);
    if (!found) throw new Error(`font has no ${name} table`);
    return found;
  };
  const unitsPerEm = bytes.readUInt16BE(table("head").offset + 18);
  const metrics = bytes.readUInt16BE(table("hhea").offset + 34);
  const hmtx = table("hmtx").offset;
  const advance = (gid: number) => bytes.readUInt16BE(hmtx + Math.min(gid, metrics - 1) * 4);

  const cmap = table("cmap").offset;
  const subtables = bytes.readUInt16BE(cmap + 2);
  let format4: number | undefined;
  for (let index = 0; index < subtables; index += 1) {
    const platform = bytes.readUInt16BE(cmap + 4 + index * 8);
    const encoding = bytes.readUInt16BE(cmap + 6 + index * 8);
    const offset = bytes.readUInt32BE(cmap + 8 + index * 8);
    if (platform === 3 && encoding === 1 && bytes.readUInt16BE(cmap + offset) === 4) format4 = cmap + offset;
  }
  if (format4 === undefined) throw new Error("font has no Unicode BMP cmap");
  const segments = bytes.readUInt16BE(format4 + 6) / 2;
  const ends = format4 + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const rangeOffsets = deltas + segments * 2;
  const glyphFor = (code: number): number | undefined => {
    for (let segment = 0; segment < segments; segment += 1) {
      const end = bytes.readUInt16BE(ends + segment * 2);
      if (code > end) continue;
      const start = bytes.readUInt16BE(starts + segment * 2);
      if (code < start) return undefined;
      const delta = bytes.readUInt16BE(deltas + segment * 2);
      const range = bytes.readUInt16BE(rangeOffsets + segment * 2);
      if (range === 0) return (code + delta) & 0xffff;
      const at = rangeOffsets + segment * 2 + range + (code - start) * 2;
      const gid = bytes.readUInt16BE(at);
      return gid === 0 ? undefined : (gid + delta) & 0xffff;
    }
    return undefined;
  };
  const longLoca = bytes.readInt16BE(table("head").offset + 50) === 1;
  const loca = table("loca").offset;
  const glyf = table("glyf").offset;
  const extent = (gid: number) => {
    const start = longLoca ? bytes.readUInt32BE(loca + gid * 4) : bytes.readUInt16BE(loca + gid * 2) * 2;
    const end = longLoca ? bytes.readUInt32BE(loca + gid * 4 + 4) : bytes.readUInt16BE(loca + gid * 2 + 2) * 2;
    if (end <= start) return undefined;
    return { min: bytes.readInt16BE(glyf + start + 2), max: bytes.readInt16BE(glyf + start + 6) };
  };
  return { bytes, unitsPerEm, advance, glyphFor, extent };
}

let cached: Font | undefined;
const font = () => {
  if (cached) return cached;
  const file = embeddableFontFile();
  if (!file) throw new Error("no open-licence TrueType font is available; set MANGA_TEST_PDF_FONT");
  cached = parseFont(fs.readFileSync(file));
  return cached;
};

/** Whether the font program has an outline for the code point. */
export function embeddedFontHas(char: string): boolean {
  return font().glyphFor(char.codePointAt(0)!) !== undefined;
}

/** The advance, in 1/1000 em, the font gives a character, as the PDF's own `/W` array would record it. */
export function embeddedAdvance(char: string): number {
  const gid = font().glyphFor(char.codePointAt(0)!);
  return gid === undefined ? 0 : Math.round((font().advance(gid) * 1000) / font().unitsPerEm);
}

export type EmbeddedLine = { text: string; x: number; y: number; size: number; /** Overrides the page-wide `positionMarks` for this line. */ positionMarks?: boolean };

/** One page with each line drawn through the embedded font, advancing by the font's widths. */
export function buildEmbeddedFontPdf(lines: EmbeddedLine[], options: { zeroAdvanceMarks?: boolean; positionMarks?: boolean; pageWidth?: number } = {}): Uint8Array {
  const program = font();
  const used = new Map<number, string>();
  const gidOf = (char: string) => {
    const gid = program.glyphFor(char.codePointAt(0)!);
    if (gid === undefined) throw new Error(`the font has no glyph for U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`);
    used.set(gid, char);
    return gid;
  };
  const hex = (gid: number) => gid.toString(16).padStart(4, "0");
  const perMille = (units: number) => Math.round((units * 1000) / program.unitsPerEm);
  const markWidth = (gid: number) => (options.zeroAdvanceMarks ? 0 : program.advance(gid));
  const shown = lines.map((line) => {
    if (!(line.positionMarks ?? options.positionMarks)) return `BT /F1 ${line.size} Tf ${line.x} ${line.y} Td <${[...line.text].map((char) => hex(gidOf(char))).join("")}> Tj ET`;
    // What a shaping producer writes: the mark is drawn where its anchor meets the base's, by moving the pen back before it
    // and forward after it. A viewer that does not shape (PDF.js) then draws what the file says.
    const pieces: string[] = [];
    let base: number | undefined;
    for (const char of line.text) {
      const gid = gidOf(char);
      if (/^\p{M}$/u.test(char) && base !== undefined) {
        const around = program.extent(base);
        const own = program.extent(gid);
        const baseCenter = around ? (around.min + around.max) / 2 : program.advance(base) / 2;
        const markCenter = own ? (own.min + own.max) / 2 : 0;
        const back = program.advance(base) - (baseCenter - markCenter);
        pieces.push(String(perMille(back)), `<${hex(gid)}>`, String(-perMille(back - markWidth(gid))));
      } else {
        pieces.push(`<${hex(gid)}>`);
        base = gid;
      }
    }
    return `BT /F1 ${line.size} Tf ${line.x} ${line.y} Td [${pieces.join(" ")}] TJ ET`;
  });
  const widths = [...used.entries()].map(([gid, char]) => {
    const marked = options.zeroAdvanceMarks && /^\p{M}$/u.test(char);
    return `${gid} [${marked ? 0 : perMille(program.advance(gid))}]`;
  }).join(" ");
  const cmapLines = [...used.entries()].map(([gid, char]) => {
    const units = Buffer.from(char, "utf16le");
    units.swap16();
    return `<${gid.toString(16).padStart(4, "0")}> <${units.toString("hex")}>`;
  });
  const toUnicode = ["/CIDInit /ProcSet findresource begin", "12 dict begin", "begincmap", "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def", "/CMapName /EmbeddedUnicode def", "/CMapType 2 def", "1 begincodespacerange", "<0000> <FFFF>", "endcodespacerange", `${cmapLines.length} beginbfchar`, ...cmapLines, "endbfchar", "endcmap", "CMapName currentdict /CMap defineresource pop", "end end", ""].join("\n");

  const content = Buffer.from(`${shown.join("\n")}\n`);
  const compressedFont = deflateSync(program.bytes);
  const objects: Buffer[] = [];
  const stream = (number: number, dictionary: string, data: Buffer) => Buffer.concat([Buffer.from(`${number} 0 obj << ${dictionary} /Length ${data.length} >> stream\n`), data, Buffer.from("\nendstream\nendobj\n")]);
  objects.push(Buffer.from("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"));
  objects.push(Buffer.from("2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n"));
  objects.push(Buffer.from(`3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 ${options.pageWidth ?? 300} 400] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n`));
  objects.push(stream(4, "", content));
  objects.push(Buffer.from("5 0 obj << /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+SyntheticEmbedded /Encoding /Identity-H /ToUnicode 8 0 R /DescendantFonts [6 0 R] >> endobj\n"));
  objects.push(Buffer.from(`6 0 obj << /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+SyntheticEmbedded /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R /CIDToGIDMap /Identity /DW 556 /W [${widths}] >> endobj\n`));
  objects.push(Buffer.from("7 0 obj << /Type /FontDescriptor /FontName /AAAAAA+SyntheticEmbedded /Flags 4 /FontBBox [-1000 -400 2000 1100] /ItalicAngle 0 /Ascent 905 /Descent -212 /CapHeight 729 /StemV 80 /FontFile2 9 0 R >> endobj\n"));
  objects.push(stream(8, "", Buffer.from(toUnicode)));
  objects.push(stream(9, `/Filter /FlateDecode /Length1 ${program.bytes.length}`, compressedFont));

  const header = Buffer.from("%PDF-1.4\n");
  let cursor = header.length;
  const xref = ["xref\n", `0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
  for (const object of objects) {
    xref.push(`${String(cursor).padStart(10, "0")} 00000 n \n`);
    cursor += object.length;
  }
  const tail = Buffer.from(`${xref.join("")}trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat([header, ...objects, tail]));
}
