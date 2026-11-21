import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DrizzleStore } from "@manga/storage-drizzle";
import { buildZip } from "../../packages/app-core/src/index.ts";
import { scanCbz, scanComicMobi } from "../../packages/app-core/src/comic/scan.ts";
import { ComicService } from "../../packages/app-core/src/comic/service.ts";
import { suggestKind } from "../../packages/app-core/src/comic/suggest.ts";
import { MediaServices, ZipPool, serveMedia } from "../../packages/app-core/src/media/index.ts";
import { libraryRoot } from "../helpers/app.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-comic-reg-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/** Build a tiny valid MOBI/PalmDOC file containing text records and image records. */
function buildSyntheticMobi(options: { compression?: 1 | 2; textRecords: Buffer[]; imageRecords: Buffer[] }): Buffer {
  const compression = options.compression ?? 1;
  const firstImageIndex = 1 + options.textRecords.length;
  const header = Buffer.alloc(132);
  header.writeUInt16BE(compression, 0);
  header.writeUInt32BE(options.textRecords.reduce((sum, rec) => sum + rec.length, 0), 4);
  header.writeUInt16BE(options.textRecords.length, 8);
  header.writeUInt16BE(4096, 10);
  header.write("MOBI", 16, "ascii");
  header.writeUInt32BE(116, 20);
  header.writeUInt32BE(65001, 28); // UTF-8
  header.writeUInt32BE(firstImageIndex, 108);

  const records = [header, ...options.textRecords, ...options.imageRecords];
  const pdbHeaderSize = 78 + records.length * 8;
  const pdb = Buffer.alloc(pdbHeaderSize);
  pdb.write("TestMobi", 0, "ascii");
  pdb.write("BOOKMOBI", 60, "ascii");
  pdb.writeUInt16BE(records.length, 76);

  let offset = pdbHeaderSize;
  for (let i = 0; i < records.length; i += 1) {
    pdb.writeUInt32BE(offset, 78 + i * 8);
    offset += records[i]!.length;
  }
  return Buffer.concat([pdb, ...records]);
}

describe("comic regressions", () => {
  it("serves a valid page file literally named '..cover.jpg' while still blocking '../escape.jpg'", async () => {
    const dir = path.join(root, "dotdot-page");
    const comicDir = path.join(dir, "lib", "book-dotdot");
    fs.mkdirSync(comicDir, { recursive: true });
    const jpg = await sharp({ create: { width: 120, height: 160, channels: 3, background: { r: 200, g: 50, b: 50 } } }).jpeg().toBuffer();
    fs.writeFileSync(path.join(comicDir, "..cover.jpg"), jpg);
    fs.writeFileSync(path.join(comicDir, "002.jpg"), jpg);

    const store = new DrizzleStore({ profileDir: path.join(dir, "data"), hostId: "c-dotdot", attachmentsDir: path.join(dir, "att") });
    const media = new MediaServices({ cacheDir: path.join(dir, "cache"), tools: null });
    try {
      libraryRoot({ store }, path.join(dir, "lib"), "comic");
      const comics = new ComicService(store, media);
      const imported = await comics.importOne({ sourcePath: comicDir });
      // Inject a legitimate sibling file starting with ".." plus an actual parent-escape attempt into the manifest.
      const row = store.sqlite.prepare("SELECT payload_json FROM resource_revisions WHERE id = ?").get(imported.revisionId) as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as { comic: { pages: Array<Record<string, unknown>> } };
      const base = payload.comic.pages[0]!;
      payload.comic.pages.push(
        { ...base, id: "..cover.jpg", index: 1, name: "..cover.jpg", ref: { kind: "file", relativePath: "..cover.jpg" } },
        { ...base, id: "escape", index: 2, name: "escape.jpg", ref: { kind: "file", relativePath: "../escape.jpg" } },
      );
      store.sqlite.prepare("UPDATE resource_revisions SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), imported.revisionId);

      const handles = await comics.pageHandles({ resourceId: imported.resourceId, revisionId: imported.revisionId, pageIds: ["..cover.jpg", "escape"], variant: "display" });
      expect(handles[0]!.available).toBe(true);
      expect(handles[1]!.available).toBe(false);
      const response = await serveMedia({ handles: media.handles, zips: media.zips }, { url: handles[0]!.available ? handles[0]!.url : "", method: "GET", headers: { get: () => null } });
      expect(response.status).toBe(200);
    } finally {
      media.dispose();
      store.close();
    }
  });

  it("ComicService reads MOBI page images via record slice without fs.readFileSync on the entire MOBI", async () => {
    const dir = path.join(root, "mobi-slice");
    const libDir = path.join(dir, "lib");
    fs.mkdirSync(libDir, { recursive: true });
    const img = await sharp({ create: { width: 100, height: 120, channels: 3, background: { r: 40, g: 120, b: 200 } } }).jpeg().toBuffer();
    const mobiFile = path.join(libDir, "slice.mobi");
    fs.writeFileSync(mobiFile, buildSyntheticMobi({
      textRecords: [Buffer.from('<html><body><img recindex="00001"/></body></html>', "utf8")],
      imageRecords: [img],
    }));

    const store = new DrizzleStore({ profileDir: path.join(dir, "data"), hostId: "c-mobi", attachmentsDir: path.join(dir, "att") });
    const media = new MediaServices({ cacheDir: path.join(dir, "cache"), tools: null });
    try {
      libraryRoot({ store }, libDir, "comic");
      const comics = new ComicService(store, media);
      const imported = await comics.importOne({ sourcePath: mobiFile });
      const pages = comics.pages(imported.resourceId);
      expect(pages.pages).toHaveLength(1);

      const spy = vi.spyOn(fs, "readFileSync");
      try {
        const result = await comics.pageImage({ resourceId: imported.resourceId, revisionId: imported.revisionId, pageId: pages.pages[0]!.id, maxEdge: 200 });
        expect(result.bytes.length).toBeGreaterThan(0);
        const mobiFullReads = spy.mock.calls.filter(([arg]) => String(arg) === mobiFile);
        expect(mobiFullReads).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    } finally {
      media.dispose();
      store.close();
    }
  });

  it("suggestKind detects image .zip as comic, scanComicCbz deduplicates entries, and MOBI enforces decompressed text budget", async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 10, g: 10, b: 10 } } }).png().toBuffer();
    const zipFile = path.join(root, "images.zip");
    fs.writeFileSync(zipFile, buildZip([
      { name: "001.png", data: png },
      { name: "001.png", data: png },
      { name: "002.png", data: png },
    ]));

    const zips = new ZipPool();
    try {
      const suggestion = await suggestKind(zipFile, { zips });
      expect(suggestion).toMatchObject({ kind: "comic", basis: "images_only", confidence: "high" });
      const scanned = await scanCbz(zipFile, { zips });
      expect(scanned.manifest.pages.map((page) => page.id)).toEqual(["001.png", "002.png"]);
    } finally {
      zips.close();
    }

    // PalmDOC back-reference bomb: 2200 compressed records expanding to ~32 KiB each (>64 MiB decompressed, <15 MiB raw),
    // followed by a final text record reversing the two images. Decompressed budget enforcement stops before the final record.
    const compressedRecord = Buffer.alloc(2 + 3200 * 2);
    compressedRecord[0] = 0x41; // literal 'A'
    compressedRecord[1] = 0x41;
    let pos = 2;
    for (let i = 0; i < 3200; i += 1) {
      compressedRecord.writeUInt16BE(0x8000 | (1 << 3) | 7, pos);
      pos += 2;
    }
    const png2 = await sharp({ create: { width: 80, height: 64, channels: 3, background: { r: 20, g: 30, b: 40 } } }).png().toBuffer();
    const tailMarkup = Buffer.from('<img recindex="00002"/><img recindex="00001"/>', "latin1");
    const bombMobi = path.join(root, "text-bomb.mobi");
    fs.writeFileSync(bombMobi, buildSyntheticMobi({
      compression: 2,
      textRecords: [...Array.from({ length: 2200 }, () => compressedRecord), tailMarkup],
      imageRecords: [png, png2],
    }));
    const mobiScanned = await scanComicMobi(bombMobi, { zips });
    // Because decompressed text exceeded MOBI_TEXT_BUDGET before tailMarkup, fallback record order [64x64, 80x64] is preserved.
    expect(mobiScanned.manifest.pages.map((page) => page.width)).toEqual([64, 80]);
  });
});
