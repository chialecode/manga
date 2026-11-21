import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";
import { buildZip } from "../../packages/app-core/src/index.ts";
import { LightMediaService, LightPositions, imageSizeOf } from "../../packages/app-core/src/light/index.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-light-reg-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** Minimal valid JPEG with an EXIF APP1 orientation tag (little-endian TIFF) and a 200x100 SOF0 frame. */
function jpegWithOrientation(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8); // 1 IFD entry
  tiff.writeUInt16LE(0x0112, 10); // Orientation tag
  tiff.writeUInt16LE(3, 12); // SHORT
  tiff.writeUInt32LE(1, 14); // count
  tiff.writeUInt16LE(orientation, 18); // value at entry + 8
  tiff.writeUInt32LE(0, 22);

  const app1Payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
  const app1 = Buffer.alloc(4 + app1Payload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(app1Payload.length + 2, 2);
  app1Payload.copy(app1, 4);

  const sof0 = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x01, 0x01, 0x11, 0x00]); // H=100, W=200
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, sof0, Buffer.from([0xff, 0xd9])]);
}

describe("light-open regressions", () => {
  it("imageSizeOf applies EXIF orientation swap for orientations 5..8", () => {
    expect(imageSizeOf(jpegWithOrientation(1))).toEqual({ width: 200, height: 100 });
    expect(imageSizeOf(jpegWithOrientation(6))).toEqual({ width: 100, height: 200 });
    expect(imageSizeOf(jpegWithOrientation(8))).toEqual({ width: 100, height: 200 });
  });

  it("LightPositions enforces limit when loading an oversized file", () => {
    const file = path.join(root, "positions.json");
    const keys = Array.from({ length: 10 }, (_, i) => createHash("sha256").update(`file-${i}`).digest("hex"));
    const positionsMap: Record<string, unknown> = {};
    for (let i = 0; i < keys.length; i += 1) {
      positionsMap[keys[i]!] = {
        kind: "video",
        positionMs: i * 1000,
        durationMs: 60_000,
        finished: false,
        at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      };
    }
    fs.writeFileSync(file, JSON.stringify({ version: 1, positions: positionsMap }));
    const positions = new LightPositions(file, 3);
    expect(positions.get(keys[0]!)).toBeNull();
    expect(positions.get(keys[9]!)).toMatchObject({ kind: "video", positionMs: 9000 });
  });

  it("LightMediaService deduplicates CBZ entries and lets ComicInfo.xml override measure() doublePage", async () => {
    const widePng = await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
    const tallPng = await sharp({ create: { width: 100, height: 200, channels: 3, background: { r: 30, g: 20, b: 10 } } }).png().toBuffer();
    const comicInfo = `<?xml version="1.0"?><ComicInfo><Pages><Page Image="0" DoublePage="false"/><Page Image='1' DoublePage='true'/></Pages></ComicInfo>`;
    const cbz = path.join(root, "dup-comicinfo.cbz");
    fs.writeFileSync(cbz, buildZip([
      { name: "001.png", data: widePng },
      { name: "001.png", data: widePng },
      { name: "002.png", data: tallPng },
      { name: "ComicInfo.xml", data: Buffer.from(comicInfo, "utf8") },
    ]));

    const service = new LightMediaService({ cacheDir: path.join(root, "cache"), positionsFile: path.join(root, "pos.json"), tools: null });
    try {
      const opened = await service.open(cbz);
      expect(opened.kind).toBe("comic");
      const pages = (await service.call("comic.pages", { resourceId: opened.sessionId })) as { pages: Array<{ id: string; spread?: boolean }> };
      // Duplicate "001.png" was deduplicated to 2 distinct pages.
      expect(pages.pages.map((page) => page.id)).toEqual(["001.png", "002.png"]);
      // Wide page 0 explicitly marked DoublePage="false" stays non-spread; tall page 1 marked Type="DoublePage" becomes spread.
      expect(Boolean(pages.pages[0]!.spread)).toBe(false);
      expect(Boolean(pages.pages[1]!.spread)).toBe(true);
    } finally {
      service.dispose();
    }
  });
});
