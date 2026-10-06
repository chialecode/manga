import { describe, expect, it } from "vitest";
import { MangaError } from "@manga/contracts";
import {
  buildEpubFixture,
  buildMobiFixture,
  buildPdfFixture,
  buildPdfObjectStreamFixture,
  buildZip,
  palmdocDecompress,
  parseDocument,
  parseDocumentBytes,
  parseEpubBytes,
  parseMobiBytes,
  parsePdfBytes,
  parseTextBytes,
  readZip,
  sniffFormat,
} from "@manga/app-core";

describe("G-01 format candidates", () => {
  it("rejects invalid txt without replacing bytes and keeps the candidate unaccepted", () => {
    expect(() => parseTextBytes(Uint8Array.from([0xff, 0x20, 0x20]))).toThrow(MangaError);
    const parsed = parseTextBytes(new TextEncoder().encode("\uFEFF甲\r\n乙"));
    expect(parsed.parts[0]?.normalized).toBe("甲\n乙");
    expect(parsed.traits.accepted).toBe(false);
    expect(sniffFormat(Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d]))).toBe("pdf");
  });

  it("reads epub structure, strips script, and records external links", () => {
    const parsed = parseEpubBytes(buildEpubFixture({
      title: "合成书",
      chapters: [{ id: "c1", title: "第一章", html: "<p>正文甲</p>" }],
    }));
    expect(parsed.traits.accepted).toBe(false);
    expect(parsed.traits.images).toBeGreaterThan(0);
    expect(parsed.traits.styles).toBeGreaterThan(0);
    expect(parsed.toc[0]?.label).toContain("第一章");
    const text = parsed.parts.map((part) => part.normalized).join("\n");
    expect(text).toContain("正文甲");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("SECRETSTYLE");
    expect(parsed.warnings.join(" ")).toMatch(/external/);
    expect(() => parseEpubBytes(buildEpubFixture({ title: "密", chapters: [{ id: "c1", title: "章", html: "<p>x</p>" }], encrypt: true }))).toThrow(/encrypt/i);
  });

  it("decompresses PalmDOC and reads a UTF-8 mobi", () => {
    expect(new TextDecoder().decode(palmdocDecompress(Uint8Array.of(0x41, 0x42, 0x43, 0x80, 0x18)))).toBe("ABCABC");
    const parsed = parseMobiBytes(buildMobiFixture("甲乙丙"));
    expect(parsed.traits.accepted).toBe(false);
    expect(parsed.parts[0]?.normalized).toContain("甲乙丙");
  });

  it("extracts pdf text, keeps scan pages without OCR, and rejects encryption", async () => {
    const parsed = await parsePdfBytes(buildPdfFixture([{ text: "页面文字" }, { scan: true }, { utf16: "日文" }]));
    expect(parsed.traits.accepted).toBe(true);
    expect(parsed.parserId).toBe("pdfjs-dist@6.3.289");
    expect(parsed.parts[0]?.normalized).toContain("页面文字");
    expect(parsed.parts.some((part) => part.kind === "image")).toBe(true);
    expect(parsed.warnings.join(" ")).toMatch(/OCR/);
    await expect(parsePdfBytes(buildPdfFixture([{ encrypt: true }]))).rejects.toThrow(/encrypt/i);
    await expect(parseDocument(buildPdfFixture([{ text: "自动" }]), { format: "auto" })).resolves.toMatchObject({ format: "pdf" });
  });

  it("follows the pdf page tree instead of treating every stream as a page", async () => {
    // A page with two content streams must stay one page. The image is painted by PDF.js, not stored as a PNG asset.
    const parsed = await parsePdfBytes(buildPdfFixture([
      { text: "第一页正文" },
      { text: "第二页正文", extraContent: true },
      { scan: true, imageBytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 9, 9]) },
    ]));
    expect(parsed.traits.pageTree).toBe(3);
    expect(parsed.traits.pages).toBe(3);
    expect(parsed.traits.multiContentStream).toBe(true);
    expect(parsed.parts[1]?.normalized).toContain("第二页正文");
    expect(parsed.parts[1]?.id).toBe("page-2");
    const scanPage = parsed.parts.find((part) => part.kind === "image");
    expect(scanPage?.kind).toBe("image");
    expect(scanPage?.normalized ?? "").toBe("");
    expect(parsed.assets?.length ?? 0).toBe(0);
  });

  it("reads a page tree that only exists inside an object stream with an xref stream", async () => {
    // The catalog, page tree and pages are packed in an /ObjStm and the images are inherited from the
    // tree node, so a reader that only scans top-level objects finds no page at all.
    const parsed = await parsePdfBytes(buildPdfObjectStreamFixture([
      { text: "对象流第一页" },
      { scan: true, imageBytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 7, 7]) },
      { text: "对象流末页" },
    ]));
    expect(parsed.traits.objectStreams).toBe(true);
    expect(parsed.traits.pageTree).toBe(3);
    expect(parsed.traits.pages).toBe(3);
    expect(parsed.parts[0]?.normalized).toContain("对象流第一页");
    expect(parsed.parts[2]?.normalized).toContain("对象流末页");
    expect(parsed.parts[1]?.kind).toBe("image");
    expect(parsed.parts[1]?.normalized ?? "").toBe("");
  });

  it("keeps a page without text or image instead of renumbering the pages after it", async () => {
    const parsed = await parsePdfBytes(buildPdfFixture([{ text: "第一页" }, {}, { text: "第三页" }]));
    expect(parsed.parts.map((part) => part.id)).toEqual(["page-1", "page-2", "page-3"]);
    expect(parsed.traits.pageTree).toBe(3);
    expect(parsed.traits.emptyPages).toBe(1);
    expect(parsed.parts[2]?.normalized).toContain("第三页");
    expect(parsed.warnings.join(" ")).toMatch(/without text/);
  });

  it("keeps epub illustrations per chapter and shows a fixed-layout page image", () => {
    const parsed = parseEpubBytes(buildEpubFixture({
      title: "固定版",
      fixedLayout: true,
      chapters: [
        { id: "c1", title: "首页", html: "<p>正文甲</p>" },
        { id: "p2", title: "插图页", html: "", svgPage: "plate.png" },
      ],
    }));
    expect(parsed.traits.fixedLayout).toBe(true);
    expect(parsed.traits.storedAssets).toBeGreaterThanOrEqual(1);
    const chapter = parsed.parts.find((part) => part.id === "c1");
    expect(chapter?.images?.length).toBe(1);
    // The image-only fixed page keeps its illustration even without a text layer.
    const plate = parsed.parts.find((part) => part.id === "p2");
    expect(plate?.kind).toBe("image");
    expect(plate?.images?.length).toBe(1);
    expect(parsed.assets?.some((asset) => asset.mediaType === "image/png")).toBe(true);
  });

  it("reads mobi html pages and their image records instead of showing raw markup", () => {
    const image = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const parsed = parseMobiBytes(buildMobiFixture("", "图文", {
      html: "<html><body><h1>第一章</h1><p>正文乙</p><mbp:pagebreak/><p>第二章</p><img recindex=\"1\"/></body></html>",
      images: [image],
    }));
    expect(parsed.traits.accepted).toBe(false);
    expect(parsed.traits.html).toBe(true);
    expect(parsed.parts.length).toBe(2);
    expect(parsed.parts[0]?.normalized).toContain("第一章");
    // Markup must not leak into the readable text, and the image record is stored.
    const all = parsed.parts.map((part) => part.normalized).join("\n");
    expect(all).not.toContain("<p>");
    expect(parsed.traits.storedAssets).toBe(1);
    expect(parsed.assets?.[0]?.mediaType).toBe("image/jpeg");
    expect(parsed.parts[1]?.images?.length).toBe(1);
  });

  it("rejects zip path escape and compression bombs", () => {
    expect(() => buildZip([{ name: "../secret.txt", data: new Uint8Array([1]) }])).toThrow(MangaError);
    const bomb = buildZip([{ name: "big.txt", data: new Uint8Array(8000), method: 8 }]);
    expect(() => readZip(bomb, { maxEntry: 1_000_000, maxTotal: 1_000_000, maxEntries: 4, maxRatio: 2 })).toThrow(/ratio|budget/i);
  });

  it("bounds actual zip inflation even when the declared size is forged", () => {
    const bomb = buildZip([{ name: "data.txt", data: new Uint8Array(8000), method: 8 }]);
    const bytes = Buffer.from(bomb);
    const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    bytes.writeUInt32LE(1, central + 24);
    bytes.writeUInt32LE(1, 22);
    expect(() => readZip(bytes, { maxEntry: 100, maxTotal: 100, maxEntries: 4, maxRatio: 100 })).toThrow(/budget/);
  });
});
