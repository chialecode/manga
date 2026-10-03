/**
 * Synthetic PDF bytes for tests. These are generators, not a PDF interpreter.
 * Text that is not ASCII is written as Identity-H with an explicit ToUnicode map so PDF.js can read it.
 */

import { deflateSync } from "node:zlib";

type FixturePage = { text?: string; lines?: string[]; utf16?: string; scan?: boolean; flate?: boolean; encrypt?: boolean; extraContent?: boolean; imageBytes?: Uint8Array };

function assemble(objects: Buffer[], trailerExtra = ""): Uint8Array {
  const header = Buffer.from("%PDF-1.4\n");
  let cursor = header.length;
  const xref = ["xref\n", `0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
  for (const object of objects) {
    xref.push(`${String(cursor).padStart(10, "0")} 00000 n \n`);
    cursor += object.length;
  }
  const tail = Buffer.from(`${xref.join("")}trailer << /Size ${objects.length + 1} ${trailerExtra}/Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`);
  return new Uint8Array(Buffer.concat([header, ...objects, tail]));
}

function obj(body: Buffer | string): Buffer {
  return Buffer.isBuffer(body) ? body : Buffer.from(body);
}

function pdfLiteral(text: string): string {
  return `(${text.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)")}) Tj`;
}

function cidFor(table: Map<string, string>, char: string): string {
  let id = table.get(char);
  if (!id) {
    id = (table.size + 1).toString(16).padStart(4, "0");
    table.set(char, id);
  }
  return id;
}

function showUnicode(text: string, table: Map<string, string>): string {
  const ids = [...text].map((char) => cidFor(table, char));
  return `<${ids.join("")}> Tj`;
}

/**
 * Advance widths for the synthetic CID font, which has no font program. PDF.js draws each glyph at the advance the
 * PDF gives it, so a combining mark takes none and sits on its base letter; Latin letters get proportional widths.
 */
function cidWidths(table: Map<string, string>): string {
  const advance = (char: string): number => {
    if (/^\p{M}$/u.test(char)) return 0;
    if (char.codePointAt(0)! >= 0x2e80) return 1000;
    return char === " " ? 278 : 556;
  };
  const entries = [...table.entries()].map(([char, cid]) => `${Number.parseInt(cid, 16)} [${advance(char)}]`);
  return entries.length ? ` /W [${entries.join(" ")}]` : "";
}

function toUnicode(table: Map<string, string>): string {
  const lines = [...table.entries()].map(([char, cid]) => {
    const units = Buffer.from(char, "utf16le");
    units.swap16();
    return `<${cid}> <${units.toString("hex")}>`;
  });
  return [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
    "/CMapName /SyntheticUnicode def",
    "/CMapType 2 def",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    `${Math.max(lines.length, 1)} beginbfchar`,
    ...(lines.length ? lines : ["<0001> <0020>"]),
    "endbfchar",
    "endcmap",
    "CMapName currentdict /CMap defineresource pop",
    "end end",
    "",
  ].join("\n");
}

function pageText(page: FixturePage): string {
  return `${page.lines?.join("") ?? ""}${page.text ?? ""}${page.utf16 ?? ""}`;
}

/** A classic-xref PDF whose page tree, fonts and images PDF.js can open. */
export function buildPdfFixture(pages: FixturePage[]): Uint8Array {
  const unicode = pages.some((page) => [...pageText(page)].some((char) => char.charCodeAt(0) > 127));
  const table = new Map<string, string>();
  const pageCount = pages.length;
  const contents: Buffer[] = [];
  const images: Buffer[] = [];
  const contentIds: number[] = [];
  const extraIds: Array<number | undefined> = [];
  const imageIds: Array<number | undefined> = [];
  let next = 3 + pageCount;
  pages.forEach((page, index) => {
    const shown = `${page.text ?? ""}${page.utf16 ?? ""}`;
    const pieces: string[] = [];
    if (page.lines?.length) {
      pieces.push("BT /F1 12 Tf 16 TL 72 360 Td");
      page.lines.forEach((line, lineIndex) => {
        if (lineIndex) pieces.push("T*");
        pieces.push(line ? (unicode ? showUnicode(line, table) : pdfLiteral(line)) : "() Tj");
      });
      pieces.push("ET");
    } else {
      pieces.push("BT /F1 12 Tf 72 100 Td");
      if (shown) pieces.push(unicode ? showUnicode(shown, table) : pdfLiteral(shown));
      pieces.push("ET");
    }
    if (page.scan) pieces.push("/Im0 Do");
    const plain = Buffer.from(`${pieces.join(" ")}\n`);
    const stored = page.flate ? deflateSync(plain) : plain;
    const filter = page.flate ? "/Filter /FlateDecode " : "";
    contentIds[index] = next;
    contents.push(Buffer.concat([
      Buffer.from(`${next} 0 obj << ${filter}/Length ${stored.length} >> stream\n`),
      stored,
      Buffer.from("\nendstream\nendobj\n"),
    ]));
    next += 1;
    if (page.extraContent) {
      extraIds[index] = next;
      const extra = Buffer.from("q Q\n");
      contents.push(Buffer.concat([
        Buffer.from(`${next} 0 obj << /Length ${extra.length} >> stream\n`),
        extra,
        Buffer.from("\nendstream\nendobj\n"),
      ]));
      next += 1;
    }
    if (page.scan) {
      const image = Uint8Array.of(0);
      imageIds[index] = next;
      images.push(Buffer.concat([
        Buffer.from(`${next} 0 obj << /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${image.length} >> stream\n`),
        Buffer.from(image),
        Buffer.from("\nendstream\nendobj\n"),
      ]));
      next += 1;
      void page.imageBytes;
    }
  });
  const fontId = next;
  const numbered: Array<{ n: number; body: Buffer }> = [
    { n: 1, body: obj("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n") },
    { n: 2, body: obj(`2 0 obj << /Type /Pages /Count ${pageCount} /Kids [${pages.map((_, index) => `${index + 3} 0 R`).join(" ")}] >> endobj\n`) },
  ];
  pages.forEach((page, index) => {
    const resources = page.scan
      ? `/Resources << /Font << /F1 ${fontId} 0 R >> /XObject << /Im0 ${imageIds[index]} 0 R >> >>`
      : `/Resources << /Font << /F1 ${fontId} 0 R >> >>`;
    const contentsRef = page.extraContent
      ? `[${contentIds[index]} 0 R ${extraIds[index]} 0 R]`
      : `${contentIds[index]} 0 R`;
    numbered.push({ n: index + 3, body: obj(`${index + 3} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents ${contentsRef} ${resources} >> endobj\n`) });
  });
  const bind = (body: Buffer) => {
    const match = /^(\d+) 0 obj/.exec(body.toString("latin1"));
    if (!match) throw new Error("pdf fixture object is missing its number");
    numbered.push({ n: Number(match[1]), body });
  };
  contents.forEach(bind);
  images.forEach(bind);
  if (unicode) {
    const cmap = toUnicode(table);
    const descId = fontId + 1;
    const uniId = fontId + 2;
    bind(obj(`${fontId} 0 obj << /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /Identity-H /ToUnicode ${uniId} 0 R /DescendantFonts [${descId} 0 R] >> endobj\n`));
    bind(obj(`${descId} 0 obj << /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000${cidWidths(table)} >> endobj\n`));
    bind(obj(`${uniId} 0 obj << /Length ${Buffer.byteLength(cmap)} >> stream\n${cmap}endstream\nendobj\n`));
  } else {
    bind(obj(`${fontId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >> endobj\n`));
  }
  numbered.sort((left, right) => left.n - right.n);
  const encrypt = pages.some((page) => page.encrypt) ? "/Encrypt 0 0 R " : "";
  return assemble(numbered.map((entry) => entry.body), encrypt);
}

/**
 * A PDF 1.5 fixture whose catalog, page tree and pages live inside an object stream.
 * Page images are inherited from the page tree.
 */
export function buildPdfObjectStreamFixture(pages: Array<{ text?: string; scan?: boolean; imageBytes?: Uint8Array }>): Uint8Array {
  const pageCount = pages.length;
  const contentIds = pages.map((_, index) => 10 + index);
  const imageIds = pages.map((_, index) => 10 + pageCount + index);
  const objectStreamId = 100;
  const xrefId = 101;
  const fontId = 90;
  const descId = 91;
  const uniId = 92;
  const size = 102;
  const table = new Map<string, string>();
  const packed: Array<{ number: number; body: string }> = [{ number: 1, body: "<< /Type /Catalog /Pages 2 0 R >>" }];
  const kids = pages.map((_, index) => `${index + 3} 0 R`).join(" ");
  const xobjects = pages.some((page) => page.scan)
    ? `/XObject << ${pages.map((page, index) => page.scan ? `/Im${index} ${imageIds[index]} 0 R` : "").filter(Boolean).join(" ")} >>`
    : "";
  packed.push({ number: 2, body: `<< /Type /Pages /Count ${pageCount} /Kids [${kids}] /Resources << /Font << /F1 ${fontId} 0 R >> ${xobjects} >> >>` });
  pages.forEach((_page, index) => {
    packed.push({ number: index + 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents ${contentIds[index]} 0 R >>` });
  });
  const headerText = packed.map((entry, position) => `${entry.number} ${position === 0 ? 0 : packed.slice(0, position).reduce((sum, item) => sum + item.body.length + 1, 0)}`).join(" ");
  const objectStreamBody = Buffer.from(`${headerText} ${packed.map((entry) => entry.body).join(" ")}`);
  const streamFirst = headerText.length + 1;
  const topLevel: Buffer[] = [];
  const offsets = new Map<number, number>();
  let cursor = Buffer.byteLength("%PDF-1.5\n");
  const pushTop = (number: number, buffer: Buffer) => {
    offsets.set(number, cursor);
    cursor += buffer.length;
    topLevel.push(buffer);
  };
  pages.forEach((page, index) => {
    const pieces = ["BT /F1 12 Tf 72 100 Td"];
    if (page.text) pieces.push(showUnicode(page.text, table));
    pieces.push("ET");
    if (page.scan) pieces.push(`/Im${index} Do`);
    const stream = `${pieces.join(" ")}\n`;
    pushTop(contentIds[index]!, Buffer.from(`${contentIds[index]} 0 obj << /Length ${Buffer.byteLength(stream)} >> stream\n${stream}endstream\nendobj\n`));
  });
  pages.forEach((page, index) => {
    if (!page.scan) return;
    const image = page.imageBytes ?? Uint8Array.of(0);
    pushTop(imageIds[index]!, Buffer.concat([
      Buffer.from(`${imageIds[index]} 0 obj << /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${image.length} >> stream\n`),
      Buffer.from(image),
      Buffer.from("\nendstream\nendobj\n"),
    ]));
  });
  const cmap = toUnicode(table.size ? table : new Map([[" ", "0001"]]));
  pushTop(fontId, Buffer.from(`${fontId} 0 obj << /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /Identity-H /ToUnicode ${uniId} 0 R /DescendantFonts [${descId} 0 R] >> endobj\n`));
  pushTop(descId, Buffer.from(`${descId} 0 obj << /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >> endobj\n`));
  pushTop(uniId, Buffer.from(`${uniId} 0 obj << /Length ${Buffer.byteLength(cmap)} >> stream\n${cmap}endstream\nendobj\n`));
  pushTop(objectStreamId, Buffer.concat([
    Buffer.from(`${objectStreamId} 0 obj << /Type /ObjStm /N ${packed.length} /First ${streamFirst} /Length ${objectStreamBody.length} >> stream\n`),
    objectStreamBody,
    Buffer.from("\nendstream\nendobj\n"),
  ]));
  const entries: Buffer[] = [];
  const compressedIndex = new Map(packed.map((entry, position) => [entry.number, position]));
  for (let number = 0; number < size; number += 1) {
    if (number === 0) { entries.push(Buffer.from([0, 0, 0, 255, 255])); continue; }
    const packedPosition = compressedIndex.get(number);
    if (packedPosition !== undefined) { entries.push(Buffer.from([2, (objectStreamId >> 8) & 0xff, objectStreamId & 0xff, (packedPosition >> 8) & 0xff, packedPosition & 0xff])); continue; }
    if (number === xrefId) { entries.push(Buffer.from([1, (cursor >> 8) & 0xff, cursor & 0xff, 0, 0])); continue; }
    const offset = offsets.get(number);
    if (offset !== undefined) { entries.push(Buffer.from([1, (offset >> 8) & 0xff, offset & 0xff, 0, 0])); continue; }
    entries.push(Buffer.from([0, 0, 0, 0, 0]));
  }
  const xrefData = Buffer.concat(entries);
  const xrefBuffer = Buffer.concat([
    Buffer.from(`${xrefId} 0 obj << /Type /XRef /Size ${size} /W [1 2 2] /Index [0 ${size}] /Root 1 0 R /Length ${xrefData.length} >> stream\n`),
    xrefData,
    Buffer.from("\nendstream\nendobj\n"),
  ]);
  const body = Buffer.concat([Buffer.from("%PDF-1.5\n"), Buffer.concat(topLevel), xrefBuffer]);
  const startxref = Buffer.byteLength("%PDF-1.5\n") + Buffer.concat(topLevel).length;
  return new Uint8Array(Buffer.concat([body, Buffer.from(`startxref\n${startxref}\n%%EOF\n`)]));
}
