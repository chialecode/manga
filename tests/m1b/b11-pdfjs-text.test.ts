import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parsePdfBytes } from "@manga/app-core";
import { parsePdfDocument } from "../../packages/app-core/src/domain/pdfjs-document.ts";
import { buildPdfFixture } from "../../packages/app-core/src/domain/pdf-fixture.ts";
import { alignPdfSelection, mapCanonicalPieces, pdfHighlightRange, selectionOffsets } from "../../packages/app-core/src/domain/pdf-text-map.ts";
import { startApp } from "./helpers.ts";
import { renderPdfPage } from "./pdf-pixels.ts";

function pdf(content: string, font = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"): Uint8Array {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
    font,
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  bodies.forEach((body, index) => {
    offsets.push(Buffer.byteLength(source, "ascii"));
    source += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(source, "ascii");
  source += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer << /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(source, "ascii"));
}

function assemble(objects: Buffer[]): Uint8Array {
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

/** A TrueType program embedded as FontFile2. Courier below has no font program and uses the standard-font substitute. */
function embeddedFontPdf(text: string): Uint8Array {
  const fontData = fs.readFileSync(path.resolve("node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf"));
  const content = Buffer.from(`BT /F1 20 Tf 1 0 0 1 50 320 Tm (${text}) Tj ET\n`);
  const widths = Array.from({ length: 77 - 32 + 1 }, () => 600).join(" ");
  return assemble([
    Buffer.from("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"),
    Buffer.from("2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n"),
    Buffer.from("3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj\n"),
    Buffer.concat([Buffer.from(`4 0 obj << /Length ${content.length} >> stream\n`), content, Buffer.from("\nendstream endobj\n")]),
    Buffer.from(`5 0 obj << /Type /Font /Subtype /TrueType /BaseFont /LiberationSans /Encoding /WinAnsiEncoding /FirstChar 32 /LastChar 77 /Widths [${widths}] /FontDescriptor 6 0 R >> endobj\n`),
    Buffer.from("6 0 obj << /Type /FontDescriptor /FontName /LiberationSans /Flags 32 /FontBBox [-543 -303 1300 980] /ItalicAngle 0 /Ascent 905 /Descent -211 /CapHeight 728 /StemV 80 /FontFile2 7 0 R >> endobj\n"),
    Buffer.concat([
      Buffer.from(`7 0 obj << /Length ${fontData.length} >> stream\n`),
      fontData,
      Buffer.from("\nendstream endobj\n"),
    ]),
  ]);
}

function ink(ctx: { getImageData: (x: number, y: number, w: number, h: number) => { data: Uint8ClampedArray } }, width: number, height: number): number {
  const data = ctx.getImageData(0, 0, Math.ceil(width), Math.ceil(height)).data;
  let count = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index]! < 250 || data[index + 1]! < 250 || data[index + 2]! < 250) count += 1;
  }
  return count;
}

function occurrence(text: string, quote: string, which: number): { start: number; end: number } {
  const hay = [...text];
  const needle = [...quote];
  let seen = 0;
  for (let index = 0; index <= hay.length - needle.length; index += 1) {
    if (needle.every((char, offset) => hay[index + offset] === char)) {
      seen += 1;
      if (seen === which) return { start: index, end: index + needle.length };
    }
  }
  throw new Error(`occurrence ${which} of ${quote} missing`);
}

async function command(ctx: Awaited<ReturnType<typeof startApp>>, commandId: string, input: Record<string, unknown>) {
  const result = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: crypto.randomUUID(), input }, ctx.grant.handle);
  expect(result.status, result.error?.message).toBe("ok");
  return result.value as Record<string, unknown>;
}

describe("pdf.js text map", () => {
  it("maps pdf text items through one canonical code-point map", () => {
    const emoji = mapCanonicalPieces([{ text: "中文 😀", eol: false }]);
    expect(emoji.stable).toBe(true);
    expect(emoji.normalized).toBe("中文 😀");
    expect(emoji.spans[0]).toEqual({ start: 0, end: [..."中文 😀"].length, eol: false });
    const composed = mapCanonicalPieces([{ text: "e\u0301", eol: false }]);
    expect(composed.normalized).toBe("é");
    expect(composed.spans[0]?.end).toBe(1);
    const merged = mapCanonicalPieces([{ text: "e", eol: false }, { text: "\u0301", eol: false }]);
    expect(merged.stable).toBe(false);
    const spaced = mapCanonicalPieces([{ text: "HELLO WORLD", eol: true }, { text: "NEXT", eol: false }]);
    expect(spaced.normalized).toBe("HELLO WORLD\nNEXT");
    expect(spaced.spans[1]?.start).toBe("HELLO WORLD\n".length);
  });

  it("places a repeated pdf quote on the selected occurrence", () => {
    const pieces = [{ text: "REPEAT", eol: true }, { text: "REPEAT", eol: false }];
    const map = mapCanonicalPieces(pieces);
    const selected = selectionOffsets(pieces, { piece: 1, utf16: 0 }, { piece: 1, utf16: "REPEAT".length });
    expect(selected?.quote).toBe("REPEAT");
    expect(selected?.start).toBe(7);
    const placed = alignPdfSelection({
      pageText: map.normalized,
      stable: map.stable,
      storedText: map.normalized,
      sliceStart: 0,
      start: selected!.start,
      end: selected!.end,
    });
    expect(placed).toEqual({ quote: "REPEAT", start: 7, end: 13 });
    const highlight = pdfHighlightRange({
      pageText: map.normalized,
      stable: true,
      storedText: map.normalized,
      sliceStart: 0,
      highlight: { start: 7, end: 13 },
      quote: "REPEAT",
    });
    expect(highlight).toEqual({ start: 7, end: 13 });
    const hits = map.spans.filter((span) => highlight && highlight !== "review" && span.end > highlight.start && span.start < highlight.end);
    expect(hits).toEqual([map.spans[1]]);
  });

  it("places a cross-line pdf selection with the end-of-line code point", () => {
    const pieces = [{ text: "FIRST LINE", eol: true }, { text: "SECOND LINE", eol: true }, { text: "THIRD LINE", eol: false }];
    const map = mapCanonicalPieces(pieces);
    const selected = selectionOffsets(pieces, { piece: 0, utf16: 0 }, { piece: 1, utf16: "SECOND LINE".length });
    expect(selected?.quote).toBe("FIRST LINE\nSECOND LINE");
    const placed = alignPdfSelection({
      pageText: map.normalized,
      stable: true,
      storedText: map.normalized,
      sliceStart: 0,
      start: selected!.start,
      end: selected!.end,
    });
    expect(placed).toEqual({ quote: "FIRST LINE\nSECOND LINE", start: 0, end: selected!.end });
    const second = selectionOffsets(pieces, { piece: 1, utf16: 0 }, { piece: 1, utf16: "SECOND LINE".length });
    const highlight = pdfHighlightRange({
      pageText: map.normalized,
      stable: true,
      storedText: map.normalized,
      sliceStart: 0,
      highlight: { start: second!.start, end: second!.end },
      quote: "SECOND LINE",
    });
    const hits = map.spans.filter((span) => highlight && highlight !== "review" && span.end > highlight.start && span.start < highlight.end);
    expect(hits.map((span) => sliceCode(map.normalized, span))).toEqual(["SECOND LINE"]);
    const ambiguous = alignPdfSelection({
      pageText: "REPEAT\nREPEAT",
      stable: false,
      storedText: "REPEAT\nREPEAT",
      sliceStart: 0,
      start: 0,
      end: 6,
    });
    expect(ambiguous).toEqual({ review: true });
  });
});

async function shownWidth(bytes: Uint8Array): Promise<number> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, useWorkerFetch: false });
  try {
    const page = await (await task.promise).getPage(1);
    const content = await page.getTextContent();
    return content.items.reduce((sum, item) => sum + ("width" in item ? item.width : 0), 0);
  } finally {
    await task.destroy();
  }
}

describe("synthetic pdf samples", () => {
  it("draws a combining mark on its base letter instead of one em to the right", async () => {
    const combined = buildPdfFixture([{ lines: ["中e\u0301"] }]);
    const plain = buildPdfFixture([{ lines: ["中e"] }]);
    expect(await shownWidth(combined)).toBeCloseTo(await shownWidth(plain), 3);
    expect(await shownWidth(plain)).toBeGreaterThan(0);
    expect((await parsePdfBytes(combined)).parts[0]?.normalized).toBe("中\u00e9");
  });
});

function sliceCode(text: string, span: { start: number; end: number }): string {
  return [...text].slice(span.start, span.end).join("");
}

describe("pdf.js source and lifecycle", () => {
  it("keeps an old ambiguous pdf quote in needs_review and a missing original", async () => {
    const bytes = pdf("BT /F1 20 Tf 24 TL 1 0 0 1 50 320 Tm (REPEAT) Tj T* (UNIQUE) Tj T* (REPEAT) Tj ET");
    const parsed = await parsePdfBytes(bytes);
    const text = parsed.parts[0]?.normalized ?? "";
    const ctx = await startApp();
    try {
      const book = await command(ctx, "library.importDocument", { title: "旧表示", format: "pdf", bytes: [...bytes] });
      const revisionBefore = book.revisionId;
      const second = occurrence(text, "REPEAT", 2);
      const exact = await command(ctx, "notes.create", {
        title: "第二次",
        text: "REPEAT",
        resourceId: book.resourceId,
        resourceRevisionId: book.revisionId,
        locator: {
          kind: "text",
          partId: "page-1",
          representationId: book.revisionId,
          normalizationVersion: "nfc-lf-codepoint-v1",
          range: second,
          quote: { exact: "REPEAT" },
        },
      });
      const opened = await command(ctx, "notes.openSource", { objectId: exact.objectId, blockId: "quote" });
      expect(opened.status).toBe("resolved");
      expect(opened.codePointRange).toEqual(second);
      const ambiguous = await command(ctx, "notes.create", {
        title: "旧歧义",
        text: "REPEAT",
        resourceId: book.resourceId,
        resourceRevisionId: book.revisionId,
        locator: {
          kind: "text",
          partId: "page-1",
          representationId: book.revisionId,
          normalizationVersion: "nfc-lf-codepoint-v1",
          range: { start: 0, end: 3 },
          quote: { exact: "REPEAT" },
        },
      });
      const review = await command(ctx, "notes.openSource", { objectId: ambiguous.objectId, blockId: "quote" });
      expect(review.status).toBe("needs_review");
      const location = ctx.app.store.sqlite.prepare("SELECT relative_path FROM file_locations WHERE resource_revision_id = ?").get(book.revisionId) as { relative_path: string };
      fs.rmSync(location.relative_path);
      const original = await command(ctx, "library.readOriginal", { resourceId: book.resourceId, revisionId: book.revisionId });
      expect(original.available).toBe(false);
      const note = await command(ctx, "notes.get", { objectId: exact.objectId });
      expect(JSON.stringify(note)).toContain("REPEAT");
      const read = await command(ctx, "library.read", { resourceId: book.resourceId, revisionId: book.revisionId });
      expect(String((read.slice as { text?: string } | undefined)?.text ?? "")).toContain("REPEAT");
      expect(read.revisionId).toBe(revisionBefore);
    } finally {
      ctx.app.close();
    }
  });

  it("cancels a pdf parse when the signal aborts and after the library module stops", async () => {
    const bytes = buildPdfFixture([{ text: "取消样本" }]);
    await expect(parsePdfDocument(bytes, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: "CANCELLED" });
    // Hold a real in-flight page response so the abort cannot accidentally occur after a fast parse.
    await parsePdfDocument(bytes);
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const probe = pdfjs.getDocument({ data: bytes.slice() });
    const probePage = await (await probe.promise).getPage(1);
    const prototype = Object.getPrototypeOf(probePage) as typeof probePage;
    const original = prototype.getTextContent;
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const spy = vi.spyOn(prototype, "getTextContent").mockImplementation(async function (this: typeof probePage) {
      const content = await original.call(this);
      entered.resolve();
      await released.promise;
      return content;
    });
    const controller = new AbortController();
    const pending = parsePdfDocument(bytes, { signal: controller.signal });
    try {
      const rejected = expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
      await entered.promise;
      controller.abort();
      await rejected;
    } finally {
      released.resolve();
      spy.mockRestore();
      await probe.destroy();
    }
    const ctx = await startApp();
    try {
      const generation = () => (ctx.app as unknown as { parseGeneration: number }).parseGeneration;
      const before = generation();
      await ctx.app.runtime.applyProfile({
        profileId: "m1a",
        revision: 2,
        enabledFeatures: ["settings"],
        disabledFeatures: ["library", "notes", "inventory", "agent"],
        preferredProviders: {},
      });
      expect(generation()).toBeGreaterThan(before);
      const refused = await ctx.app.call(ctx.actor, {
        commandId: "library.importDocument",
        idempotencyKey: crypto.randomUUID(),
        input: { title: "停用期间", format: "pdf", bytes: [...bytes] },
      }, ctx.grant.handle);
      expect(refused.status).toBe("error");
      expect(refused.error?.code).toBe("CAPABILITY_UNAVAILABLE");
      await ctx.app.runtime.applyProfile({
        profileId: "m1a",
        revision: 3,
        enabledFeatures: ["library", "notes", "settings", "inventory", "agent"],
        disabledFeatures: [],
        preferredProviders: {},
      });
      const imported = await command(ctx, "library.importDocument", { title: "重新启用", format: "pdf", bytes: [...bytes] });
      expect(imported.resourceId).toEqual(expect.any(String));
      const read = await command(ctx, "library.read", { resourceId: imported.resourceId });
      expect(String((read.slice as { text?: string } | undefined)?.text ?? "")).toContain("取消样本");
    } finally {
      ctx.app.close();
    }
  });

  it("paints an embedded font and a substitute font as separate samples", async () => {
    const substitute = pdf("BT /F1 20 Tf 1 0 0 1 50 320 Tm (FIRST LINE) Tj ET");
    const embedded = embeddedFontPdf("EMBED");
    expect(Buffer.from(substitute).includes(Buffer.from("/FontFile"))).toBe(false);
    expect(Buffer.from(embedded).includes(Buffer.from("/FontFile"))).toBe(true);
    const substituteText = (await parsePdfBytes(substitute)).parts[0]?.normalized ?? "";
    const embeddedText = (await parsePdfBytes(embedded)).parts[0]?.normalized ?? "";
    expect(substituteText).toContain("FIRST LINE");
    expect(embeddedText).toContain("EMBED");
    const substitutePaint = await renderPdfPage(substitute, 2);
    const embeddedPaint = await renderPdfPage(embedded, 2);
    expect(ink(substitutePaint.ctx, substitutePaint.width, substitutePaint.height)).toBeGreaterThan(20);
    expect(ink(embeddedPaint.ctx, embeddedPaint.width, embeddedPaint.height)).toBeGreaterThan(20);
  });
});
