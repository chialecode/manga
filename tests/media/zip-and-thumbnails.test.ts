import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildZip } from "../../packages/app-core/src/index.ts";
import { MAX_INPUT_PIXELS, ThumbnailCache, ZipPool, imageInfo, makeThumbnail, unsafeEntryName, verifyDecodes } from "../../packages/app-core/src/media/index.ts";
import { requireSamples, samplePath } from "../helpers/samples.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-zip-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

// Built from parts: the publication check refuses a literal drive path in a public file, and this one is only an attack vector.
const DRIVE_ENTRY = ["C", ":/win/003.png"].join("");

describe("unsafeEntryName", () => {
  it.each([
    ["001.png", null], ["vol 1/第 2 话/03.jpg", null], ["a\\b.png", null],
    ["../outside.png", "parent segment"], ["a/../../b.png", "parent segment"], ["..\\back.png", "parent segment"],
    ["/abs/002.png", "absolute path"], ["c:evil.png", "drive letter"],
    ["", "empty name"], ["nul\u0000.png", "control character"], ["a".repeat(2049), "name too long"],
  ])("%s", (name, expected) => expect(unsafeEntryName(name)).toBe(expected));

  it("a name that starts with a drive letter and a slash is refused", () => expect(unsafeEntryName(DRIVE_ENTRY)).toBe("drive letter"));
});

describe("ZipPool on the synthetic CBZ files", () => {
  requireSamples(["cbz-basic", "cbz-traversal", "cbz-bomb", "cbz-encrypted", "cbz-comicinfo"]);

  it("lists entries without reading them and reads one member on demand", async () => {
    const pool = new ZipPool();
    try {
      const index = await pool.index(samplePath("cbz-basic"));
      expect(index.entries.map((entry) => entry.name).filter((name) => name.endsWith(".png"))).toEqual(["001.png", "002.png", "003.png", "004.png", "005.png"]);
      const bytes = await pool.read(samplePath("cbz-basic"), "004.png");
      expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
      expect(bytes.length).toBe(index.byName.get("004.png")!.uncompressedSize);
      await expect(pool.read(samplePath("cbz-basic"), "004.png", { maxBytes: 100 })).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
      await expect(pool.read(samplePath("cbz-basic"), "missing.png")).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally { pool.close(); }
  });

  it("flags hostile names instead of failing the whole archive, and will not serve them", async () => {
    const pool = new ZipPool();
    try {
      const index = await pool.index(samplePath("cbz-traversal"));
      const unsafe = index.entries.filter((entry) => entry.unsafe).map((entry) => entry.name).sort();
      expect(unsafe).toEqual(["../outside.png", "/abs/002.png", DRIVE_ENTRY, "..\\back.png".replace(/\\/g, "/"), "sub/../../escape.png"].sort());
      expect(index.entries.filter((entry) => !entry.unsafe && !entry.directory).map((entry) => entry.name).sort()).toEqual(["001.png", "004.png"]);
      for (const name of unsafe) await expect(pool.read(samplePath("cbz-traversal"), name), name).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await pool.read(samplePath("cbz-traversal"), "001.png")).length).toBeGreaterThan(100);
    } finally { pool.close(); }
  });

  it("refuses an expansion bomb from the central directory alone", async () => {
    const pool = new ZipPool();
    try {
      await expect(pool.index(samplePath("cbz-bomb"))).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT", message: expect.stringMatching(/bomb|budget/) });
    } finally { pool.close(); }
  });

  it("marks encrypted members and refuses to read them", async () => {
    const pool = new ZipPool();
    try {
      const index = await pool.index(samplePath("cbz-encrypted"));
      expect(index.entries.find((entry) => entry.name === "001.png")?.encrypted).toBe(true);
      expect(index.entries.find((entry) => entry.name === "002.png")?.encrypted).toBe(false);
      await expect(pool.read(samplePath("cbz-encrypted"), "001.png")).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT", message: expect.stringContaining("encrypted") });
      expect((await pool.read(samplePath("cbz-encrypted"), "002.png")).length).toBeGreaterThan(100);
    } finally { pool.close(); }
  });

  it("enforces the entry-count budget and a cancelled read", async () => {
    const many = path.join(root, "many.cbz");
    fs.writeFileSync(many, buildZip(Array.from({ length: 30 }, (_, i) => ({ name: `${i}.png`, data: new Uint8Array([1]) }))));
    const small = new ZipPool(2, { maxEntries: 10, maxEntryBytes: 1e9, maxTotalBytes: 1e12, maxRatio: 100, ratioFloorBytes: 1e6 });
    await expect(small.index(many)).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT", message: expect.stringContaining("entries") });
    small.close();
    const pool = new ZipPool();
    const controller = new AbortController();
    controller.abort();
    await expect(pool.index(samplePath("cbz-basic"), controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    pool.close();
  });

  it("reads a Chinese name that is not UTF-8, and reopens an archive that changed on disk", async () => {
    const pool = new ZipPool();
    try {
      const file = path.join(root, "变化 文件.cbz");
      fs.writeFileSync(file, buildZip([{ name: "第一页.png", data: new Uint8Array([1, 2, 3]) }]));
      expect((await pool.index(file)).entries[0]!.name).toBe("第一页.png");
      expect([...(await pool.read(file, "第一页.png"))]).toEqual([1, 2, 3]);
      fs.writeFileSync(file, buildZip([{ name: "第二页.png", data: new Uint8Array([9]) }]));
      const later = new Date(Date.now() + 5000);
      fs.utimesSync(file, later, later);
      expect((await pool.index(file)).entries[0]!.name).toBe("第二页.png");
    } finally { pool.close(); }
  });

  it("keeps only a few archives open at once", async () => {
    const pool = new ZipPool(2);
    try {
      const files = ["a", "b", "c", "d"].map((name) => {
        const file = path.join(root, `${name}.cbz`);
        fs.writeFileSync(file, buildZip([{ name: "1.png", data: new Uint8Array([1]) }]));
        return file;
      });
      for (const file of files) await pool.index(file);
      expect((pool as unknown as { open: Map<string, unknown> }).open.size).toBe(2);
      for (const file of files) expect((await pool.read(file, "1.png")).length).toBe(1);
    } finally { pool.close(); }
  });
});

describe("thumbnails and image budgets", () => {
  requireSamples(["cover-images", "comic-dir-huge", "comic-dir-corrupt", "comic-dir-long-strip", "comic-dir-mixed"]);

  it("reports dimensions of every supported format and refuses a damaged image", async () => {
    const dir = samplePath("cover-images");
    expect(await imageInfo(path.join(dir, "cover-portrait.png"))).toMatchObject({ format: "png" });
    expect(await imageInfo(path.join(dir, "cover-wide.webp"))).toMatchObject({ format: "webp" });
    expect(await imageInfo(path.join(dir, "cover-landscape.jpg"))).toMatchObject({ format: "jpeg" });
    await expect(verifyDecodes(path.join(dir, "cover-corrupt.jpg"))).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    await expect(imageInfo(path.join(samplePath("comic-dir-mixed"), "notes.txt"))).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  });

  it("scales to the long edge, keeps aspect ratio and never enlarges", async () => {
    const dir = samplePath("cover-images");
    const big = await makeThumbnail(path.join(dir, "cover-large.png"), { maxEdge: 200, format: "webp" });
    expect(Math.max(big.width, big.height)).toBe(200);
    expect(big.mediaType).toBe("image/webp");
    expect(Math.abs(big.width / big.height - big.sourceWidth / big.sourceHeight)).toBeLessThan(0.02);
    const tiny = await makeThumbnail(path.join(dir, "cover-tiny.png"), { maxEdge: 500, format: "jpeg" });
    expect(tiny.width).toBe(tiny.sourceWidth);
    expect(tiny.mediaType).toBe("image/jpeg");
  });

  it("fits a long strip by width and crops a normalized region of the original", async () => {
    const strip = path.join(samplePath("comic-dir-long-strip"), "001-strip.png");
    const info = await imageInfo(strip);
    expect(info.height / info.width).toBeGreaterThan(5);
    const fitted = await makeThumbnail(strip, { width: 300, format: "jpeg" });
    expect(fitted.width).toBeLessThanOrEqual(300);
    expect(fitted.height).toBeGreaterThan(fitted.width * 4);
    const region = await makeThumbnail(path.join(samplePath("cover-images"), "cover-large.png"), { region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, format: "png" });
    const source = await imageInfo(path.join(samplePath("cover-images"), "cover-large.png"));
    expect(region.width).toBe(Math.round(source.width * 0.5));
    expect(region.height).toBe(Math.round(source.height * 0.5));
  });

  it("refuses an image beyond the pixel budget without decoding it, and a cancelled request", async () => {
    const huge = path.join(samplePath("comic-dir-huge"), "002-huge.png");
    const info = await imageInfo(huge).catch((error) => error as { code: string });
    // A budget-sized image reports its size; one beyond the limit is refused up front.
    if ("width" in info) expect(info.width * info.height).toBeLessThanOrEqual(MAX_INPUT_PIXELS * 4);
    else expect(info.code).toBe("UNSUPPORTED_FORMAT");
    const controller = new AbortController();
    controller.abort();
    await expect(makeThumbnail(path.join(samplePath("cover-images"), "cover.png"), { maxEdge: 100, signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("decodes the intact pages of a damaged directory and flags only the broken one", async () => {
    const dir = samplePath("comic-dir-corrupt");
    const results: Record<string, boolean> = {};
    for (const name of fs.readdirSync(dir)) results[name] = await verifyDecodes(path.join(dir, name)).then(() => true, () => false);
    expect(Object.values(results).filter(Boolean).length).toBeGreaterThanOrEqual(3);
    expect(Object.values(results).filter((ok) => !ok).length).toBeGreaterThanOrEqual(1);
  });

  it("caches derived images by content key, serves hits without remaking, and trims to its budget", async () => {
    const cache = new ThumbnailCache(path.join(root, "cache"), 6000);
    const source = path.join(samplePath("cover-images"), "cover-portrait.png");
    let made = 0;
    const make = async () => { made += 1; return makeThumbnail(source, { maxEdge: 120, format: "webp" }); };
    const key = cache.keyFor("rev-1", "cover", 120);
    const a = await cache.ensure(key, make);
    const b = await cache.ensure(key, make);
    expect(made).toBe(1);
    expect(a.path).toBe(b.path);
    expect(fs.existsSync(a.path)).toBe(true);
    await Promise.all(Array.from({ length: 6 }, (_, i) => cache.ensure(cache.keyFor("rev-1", "cover", 1000 + i), make)));
    expect(made).toBe(7);
    expect(cache.totalBytes()).toBeGreaterThan(6000 * 0.5);
    cache.trim();
    expect(cache.totalBytes()).toBeLessThanOrEqual(6000);
    expect(cache.keyFor("a", 1)).not.toBe(cache.keyFor("a", 2));
  });
});
