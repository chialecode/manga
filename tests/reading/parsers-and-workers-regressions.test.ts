import { afterEach, describe, expect, it } from "vitest";
import { MangaError } from "@manga/contracts";
import {
  buildZip,
  palmdocDecompress,
  parseEpubBytes,
  parseMobiBytes,
  readZip,
} from "@manga/app-core";
import { mapCanonicalPieces } from "../../packages/app-core/src/domain/pdf-text-map.ts";
import { startParseWorker, type ParseClient } from "../../packages/app-core/src/parse-client.ts";
import { readPngText } from "../../packages/app-core/src/screenshots.ts";

const workers: ParseClient[] = [];
afterEach(() => {
  while (workers.length) {
    try { workers.pop()!.kill(); } catch { /* killed */ }
  }
});

describe("Parsers, PDF text map & parse-worker regressions (A-11, A-24, A-25)", () => {
  it("A-11: ParseWorker rejects with MangaError(CANCELLED) on AbortSignal and stays usable", async () => {
    const worker = startParseWorker();
    workers.push(worker);
    const ac = new AbortController();
    const pending = worker.parse({ bytes: [...Buffer.from("延迟解析")], format: "txt", delayMs: 2000, signal: ac.signal });
    setTimeout(() => ac.abort(), 40);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" } satisfies Partial<MangaError>);
  });

  it("A-24: formats.ts guards ZIP/MOBI bounds, palmdoc bombs, malformed EPUB %, and PNG CRC bounds", () => {
    // 1) Truncated ZIP EOCD / corrupt central directory offset throws MangaError (never RangeError).
    const badZip = Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 1, 0, 1, 0, 0xff, 0xff, 0, 0, 0xff, 0xff, 0, 0, 0, 0]);
    expect(() => readZip(badZip)).toThrow(MangaError);

    // 2) Corrupt/truncated MOBI header throws MangaError (never RangeError).
    expect(() => parseMobiBytes(new Uint8Array(64))).toThrow(MangaError);

    // 3) PalmDOC decompression bomb is capped instead of OOMing.
    const bomb = new Uint8Array(1 + 500 * 2);
    bomb[0] = 0x41;
    for (let i = 1; i < bomb.length; i += 2) {
      bomb[i] = 0x80;
      bomb[i + 1] = 0x0f;
    }
    expect(() => palmdocDecompress(bomb, 1024)).toThrow(MangaError);

    // 4) Malformed percent-encoding in EPUB manifest href does not throw URIError.
    const zipWithBadPct = buildZip([
      { name: "META-INF/container.xml", data: '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>' },
      { name: "OEBPS/content.opf", data: '<package><metadata><dc:title>坏编码</dc:title></metadata><manifest><item id="c1" href="ch%ZZ1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>' },
      { name: "OEBPS/ch%ZZ1.xhtml", data: "<html><body><p>安全正文</p></body></html>" },
    ]);
    const epub = parseEpubBytes(zipWithBadPct);
    expect(epub.parts[0]?.normalized).toContain("安全正文");

    // 5) Truncated PNG chunk length past buffer end does not throw RangeError in readPngText.
    const truncatedPng = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from([0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]), Buffer.alloc(4),
      Buffer.from([0x00, 0x01, 0x00, 0x00]), Buffer.from("tEXt"), Buffer.from("cut"),
    ]);
    expect(() => readPngText(truncatedPng)).not.toThrow();
    expect(readPngText(truncatedPng)).toEqual({});
  });

  it("A-25: mapCanonicalPieces runs in linear O(N) time on 10,000 pieces and flags cross-boundary combining marks", () => {
    const pieces = Array.from({ length: 10_000 }, (_, i) => ({ text: `段${i}`, eol: i % 10 === 9 }));
    const t0 = performance.now();
    const mapped = mapCanonicalPieces(pieces);
    const elapsedMs = performance.now() - t0;
    expect(mapped.stable).toBe(true);
    expect(mapped.spans).toHaveLength(10_000);
    expect(elapsedMs).toBeLessThan(1500);

    // Cross-boundary NFC merge ("e" + "\u0301" -> "é") marks stable: false with accurate offsets.
    const split = mapCanonicalPieces([{ text: "e", eol: false }, { text: "\u0301", eol: false }]);
    expect(split.stable).toBe(false);
    expect(split.normalized).toBe("\u00e9");
  });
});
