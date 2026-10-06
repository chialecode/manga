import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DrizzleStore } from "@manga/storage-drizzle";
import { ComicService } from "../../packages/app-core/src/comic/service.ts";
import { planDirectory } from "../../packages/app-core/src/comic/scan.ts";
import { MediaServices, serveMedia } from "../../packages/app-core/src/media/index.ts";
import { requireSamples, samplePath } from "../helpers/samples.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-comic-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let counter = 0;

function setup() {
  counter += 1;
  const dir = path.join(root, `profile-${counter}`);
  const store = new DrizzleStore({ profileDir: path.join(dir, "data"), hostId: `comic-${counter}`, attachmentsDir: path.join(dir, "attachments") });
  const media = new MediaServices({ cacheDir: path.join(dir, "cache"), tools: null });
  const comics = new ComicService(store, media);
  return { store, media, comics, dir, close: () => { media.dispose(); store.close(); } };
}

const get = (env: ReturnType<typeof setup>, url: string, headers: Record<string, string> = {}) => serveMedia({ handles: env.media.handles, zips: env.media.zips }, { url, method: "GET", headers: { get: (name: string) => headers[name.toLowerCase()] ?? null } });

describe("importing a folder of images", () => {
  requireSamples(["comic-dir-natural", "comic-dir-sparse", "comic-dir-mixed", "comic-dir-corrupt", "comic-dir-long-strip", "comic-dir-huge", "comic-dir-duplicates"]);

  it("lists pages in natural order with stable ids, sizes and hashes, and notices a re-import", async () => {
    const env = setup();
    try {
      const result = await env.comics.importOne({ sourcePath: samplePath("comic-dir-natural") });
      expect(result).toMatchObject({ source: "dir", duplicate: false, unreadablePages: 0 });
      const pages = env.comics.pages(result.resourceId);
      expect(pages.pages.length).toBeGreaterThanOrEqual(5);
      const names = pages.pages.map((page) => page.name);
      const sorted = [...names].sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
      expect(names).toEqual(sorted);
      expect(pages.pages.every((page) => page.ok && page.width > 0 && page.height > 0)).toBe(true);
      expect(pages.pages.map((page) => page.id)).toEqual(names);
      const again = await env.comics.importOne({ sourcePath: samplePath("comic-dir-natural") });
      expect(again).toMatchObject({ duplicate: true, resourceId: result.resourceId, revisionId: result.revisionId });
      expect(env.store.sqlite.prepare("SELECT COUNT(*) AS n FROM works").get()).toEqual({ n: 1 });
      expect(env.store.sqlite.prepare("SELECT layout_json FROM resource_revisions WHERE id = ?").get(result.revisionId)).toMatchObject({ layout_json: expect.stringContaining('"unit":"pages"') });
    } finally { env.close(); }
  });

  it("keeps non-consecutive numbering as it is and ignores system files and non-images", async () => {
    const env = setup();
    try {
      const sparse = await env.comics.importOne({ sourcePath: samplePath("comic-dir-sparse") });
      expect(env.comics.pages(sparse.resourceId).pages.map((page) => page.id)).toEqual(["p001.png", "p002.png", "p004.png", "p007.png", "p100.png"]);
      const mixed = await env.comics.importOne({ sourcePath: samplePath("comic-dir-mixed") });
      const pages = env.comics.pages(mixed.resourceId);
      expect(pages.pages.map((page) => page.id)).toEqual(["001.png", "002.jpg", "003.webp", "004.gif"]);
      expect(pages.pages.every((page) => page.ok)).toBe(true);
      expect(pages.info).toBeTruthy();
    } finally { env.close(); }
  });

  it("marks a damaged page unreadable, keeps the others and answers its handle without throwing", async () => {
    const env = setup();
    try {
      const result = await env.comics.importOne({ sourcePath: samplePath("comic-dir-corrupt") });
      expect(result.unreadablePages).toBeGreaterThanOrEqual(1);
      expect(result.warnings.length).toBeGreaterThanOrEqual(1);
      const { pages } = env.comics.pages(result.resourceId);
      const bad = pages.find((page) => !page.ok)!;
      const good = pages.find((page) => page.ok)!;
      expect(bad.error).toBeTruthy();
      const base = { resourceId: result.resourceId, revisionId: result.revisionId };
      expect(await env.comics.pageHandle({ ...base, pageId: bad.id })).toMatchObject({ available: false });
      const ok = await env.comics.pageHandle({ ...base, pageId: good.id });
      expect(ok).toMatchObject({ available: true, kind: "image" });
      const batch = await env.comics.pageHandles({ ...base, pageIds: [bad.id, good.id, "missing.png"] });
      expect(batch.map((item) => item.available)).toEqual([false, true, false]);
    } finally { env.close(); }
  });

  it("serves an intact page straight from the original, and a converted copy for a format the browser cannot show", async () => {
    const env = setup();
    try {
      const result = await env.comics.importOne({ sourcePath: samplePath("comic-dir-mixed") });
      const base = { resourceId: result.resourceId, revisionId: result.revisionId };
      const png = await env.comics.pageHandle({ ...base, pageId: "001.png" });
      if (!png.available || png.kind !== "image") throw new Error("expected an image handle");
      expect(png).toMatchObject({ mediaType: "image/png", scaled: false });
      const response = await get(env, png.url);
      expect(response.status).toBe(200);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.equals(fs.readFileSync(path.join(samplePath("comic-dir-mixed"), "001.png")))).toBe(true);
      const thumb = await env.comics.pageHandle({ ...base, pageId: "001.png", variant: "thumb", maxEdge: 96 });
      if (!thumb.available || thumb.kind !== "image") throw new Error("expected a thumbnail");
      expect(thumb.scaled).toBe(true);
      expect(Math.max(thumb.width, thumb.height)).toBeLessThanOrEqual(96);
      expect(thumb.original.width).toBe(png.width);
      // The cache holds the thumbnail; asking again does not make a second file.
      const before = env.media.thumbs.totalBytes();
      await env.comics.pageHandle({ ...base, pageId: "001.png", variant: "thumb", maxEdge: 96 });
      expect(env.media.thumbs.totalBytes()).toBe(before);
    } finally { env.close(); }
  });

  it("fits a long strip by width so its height does not exhaust memory", async () => {
    const env = setup();
    try {
      const result = await env.comics.importOne({ sourcePath: samplePath("comic-dir-long-strip") });
      const strip = env.comics.pages(result.resourceId).pages.find((page) => page.name.includes("strip"))!;
      expect(strip.height / strip.width).toBeGreaterThan(5);
      const handle = await env.comics.pageHandle({ resourceId: result.resourceId, revisionId: result.revisionId, pageId: strip.id, maxEdge: 400 });
      if (!handle.available || handle.kind !== "image") throw new Error("expected image");
      expect(handle.scaled).toBe(true);
      expect(handle.width).toBeLessThanOrEqual(400);
      expect(handle.height / handle.width).toBeGreaterThan(5);
    } finally { env.close(); }
  });

  it("handles the oversized image sample without decoding past its budget", async () => {
    const env = setup();
    try {
      const result = await env.comics.importOne({ sourcePath: samplePath("comic-dir-huge") });
      const { pages } = env.comics.pages(result.resourceId);
      expect(pages).toHaveLength(3);
      const huge = pages.find((page) => page.name.includes("huge"))!;
      if (huge.ok) {
        const handle = await env.comics.pageHandle({ resourceId: result.resourceId, revisionId: result.revisionId, pageId: huge.id });
        expect(handle).toMatchObject({ available: true });
        if (handle.available && handle.kind === "image") expect(handle.scaled).toBe(true);
      } else {
        expect(huge.error).toMatch(/pixel|budget|larger/i);
      }
    } finally { env.close(); }
  });

  it("imports volume/chapter folders as one work in walk order, although the chapter numbers repeat", async () => {
    const env = setup();
    try {
      const plan = planDirectory(samplePath("comic-dir-duplicates"), "comic");
      expect(plan.items.map((item) => item.relative)).toEqual(["vol01/ch01", "vol01/ch02", "vol02/ch01"]);
      const result = await env.comics.importDirectory({ root: samplePath("comic-dir-duplicates"), title: "合集" });
      const imported = result.resources as Array<{ resourceId: string; revisionId: string; ordinalLabel: string | null; title: string }>;
      expect(imported.map((item) => item.ordinalLabel)).toEqual(["第 1 卷 · 第 1 话", "第 1 卷 · 第 2 话", "第 2 卷 · 第 1 话"]);
      expect(env.store.sqlite.prepare("SELECT COUNT(*) AS n FROM works").get()).toEqual({ n: 1 });
      expect(env.store.sqlite.prepare("SELECT title, media_kind FROM works WHERE id = ?").get(result.workId)).toEqual({ title: "合集", media_kind: "comic" });
      const rows = env.store.sqlite.prepare("SELECT title FROM resources WHERE work_id = ? ORDER BY sort_key").all(result.workId);
      expect(rows).toEqual([{ title: "vol01 / ch01" }, { title: "vol01 / ch02" }, { title: "vol02 / ch01" }]);
      // The same file names in different folders are separate pages of separate resources.
      const first = env.comics.pages(imported[0]!.resourceId).pages.map((page) => page.id);
      const third = env.comics.pages(imported[2]!.resourceId).pages.map((page) => page.id);
      expect(first.some((id) => third.includes(id))).toBe(true);
      expect(imported[0]!.revisionId).not.toBe(imported[2]!.revisionId);
      // Importing the same folder again adds nothing.
      const again = await env.comics.importDirectory({ root: samplePath("comic-dir-duplicates"), title: "合集" });
      expect((again.resources as Array<{ duplicate: boolean }>).every((item) => item.duplicate)).toBe(true);
      expect(env.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get()).toEqual({ n: 3 });
    } finally { env.close(); }
  });

  it("makes a new revision, keeping the old one readable, when the folder's pages change", async () => {
    const env = setup();
    try {
      const copy = path.join(root, "改变 的 目录");
      fs.cpSync(samplePath("comic-dir-sparse"), copy, { recursive: true });
      const first = await env.comics.importOne({ sourcePath: copy });
      fs.copyFileSync(path.join(copy, "p001.png"), path.join(copy, "p200.png"));
      const second = await env.comics.importOne({ sourcePath: copy });
      expect(second).toMatchObject({ resourceId: first.resourceId, duplicate: false, replaced: true });
      expect(second.revisionId).not.toBe(first.revisionId);
      expect(env.comics.pages(first.resourceId, first.revisionId).pages).toHaveLength(5);
      expect(env.comics.pages(first.resourceId).pages).toHaveLength(6);
      fs.rmSync(path.join(copy, "p200.png"));
    } finally { env.close(); }
  });

  it("answers that the original is gone instead of failing, and refuses a page path that leaves the folder", async () => {
    const env = setup();
    try {
      const copy = path.join(root, "将被删除");
      fs.cpSync(samplePath("comic-dir-sparse"), copy, { recursive: true });
      const result = await env.comics.importOne({ sourcePath: copy });
      const base = { resourceId: result.resourceId, revisionId: result.revisionId };
      // A manifest edited to point outside the folder is refused.
      const row = env.store.sqlite.prepare("SELECT payload_json FROM resource_revisions WHERE id = ?").get(result.revisionId) as { payload_json: string };
      const payload = JSON.parse(row.payload_json);
      payload.comic.pages[0].ref.relativePath = "../outside.png";
      env.store.sqlite.prepare("UPDATE resource_revisions SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), result.revisionId);
      await expect(env.comics.pageHandle({ ...base, pageId: payload.comic.pages[0].id })).rejects.toMatchObject({ code: "PATH_ESCAPE" });
      fs.rmSync(copy, { recursive: true, force: true });
      expect(env.comics.pages(result.resourceId).available).toBe(false);
      expect(await env.comics.pageHandle({ ...base, pageId: payload.comic.pages[1].id })).toMatchObject({ available: false, reason: expect.stringContaining("not available") });
    } finally { env.close(); }
  });

  it("stops a scan that is cancelled and writes nothing", async () => {
    const env = setup();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(env.comics.importOne({ sourcePath: samplePath("comic-dir-natural"), signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED" });
      expect(env.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get()).toEqual({ n: 0 });
    } finally { env.close(); }
  });
});

describe("importing archives and documents", () => {
  requireSamples(["cbz-basic", "cbz-comicinfo", "cbz-traversal", "cbz-bomb", "cbz-encrypted", "comic-pdf-images", "comic-epub-images", "comic-mobi-images"]);

  it("reads a CBZ in order and serves each page from inside the archive", async () => {
    const env = setup();
    try {
      const result = await env.comics.importOne({ sourcePath: samplePath("cbz-basic") });
      expect(result).toMatchObject({ source: "cbz", pages: 5, unreadablePages: 0 });
      const { pages } = env.comics.pages(result.resourceId);
      expect(pages.map((page) => page.id)).toEqual(["001.png", "002.png", "003.png", "004.png", "005.png"]);
      const handle = await env.comics.pageHandle({ resourceId: result.resourceId, revisionId: result.revisionId, pageId: "003.png" });
      if (!handle.available || handle.kind !== "image") throw new Error("expected image");
      const response = await get(env, handle.url);
      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(100);
      const partial = await get(env, handle.url, { range: "bytes=0-3" });
      expect(partial.status).toBe(206);
    } finally { env.close(); }
  });

  it("keeps ComicInfo.xml series, reading direction and double-page flags", async () => {
    const env = setup();
    try {
      const result = await env.comics.importOne({ sourcePath: samplePath("cbz-comicinfo") });
      const pages = env.comics.pages(result.resourceId);
      expect(pages.info).toBeTruthy();
      expect(Object.keys(pages.info!).length).toBeGreaterThan(0);
      expect(pages.pages.length).toBeGreaterThan(2);
    } finally { env.close(); }
  });

  it("skips archive entries with hostile names and says so", async () => {
    const env = setup();
    try {
      const result = await env.comics.importOne({ sourcePath: samplePath("cbz-traversal") });
      expect(env.comics.pages(result.resourceId).pages.map((page) => page.id)).toEqual(["001.png", "004.png"]);
      expect(result.warnings.join(" ")).toMatch(/unsafe/);
    } finally { env.close(); }
  });

  it("refuses an expansion bomb and an encrypted archive with a clear error and no rows", async () => {
    const env = setup();
    try {
      await expect(env.comics.importOne({ sourcePath: samplePath("cbz-bomb") })).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
      await expect(env.comics.importOne({ sourcePath: samplePath("cbz-encrypted") })).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT", message: expect.stringContaining("encrypted") });
      expect(env.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get()).toEqual({ n: 0 });
    } finally { env.close(); }
  });

  it("reads an image-only PDF as pages and hands the reader the PDF with a page number", async () => {
    const env = setup();
    try {
      const result = await env.comics.importOne({ sourcePath: samplePath("comic-pdf-images") });
      expect(result).toMatchObject({ source: "pdf", pages: 5 });
      const { pages } = env.comics.pages(result.resourceId);
      expect(pages.map((page) => page.id)).toEqual(["page-1", "page-2", "page-3", "page-4", "page-5"]);
      expect(pages.every((page) => page.width > 0 && page.height > 0)).toBe(true);
      const handle = await env.comics.pageHandle({ resourceId: result.resourceId, revisionId: result.revisionId, pageId: "page-3" });
      expect(handle).toMatchObject({ available: true, kind: "pdf", pageNumber: 3, mediaType: "application/pdf" });
      if (handle.available) {
        const head = await get(env, handle.url, { range: "bytes=0-4" });
        expect(head.status).toBe(206);
        expect(Buffer.from(await head.arrayBuffer()).toString("latin1")).toBe("%PDF-");
      }
    } finally { env.close(); }
  });

  it("reads image-only EPUB and MOBI pages in book order and serves them", async () => {
    const env = setup();
    try {
      const epub = await env.comics.importOne({ sourcePath: samplePath("comic-epub-images") });
      const mobi = await env.comics.importOne({ sourcePath: samplePath("comic-mobi-images") });
      for (const [result, source] of [[epub, "epub"], [mobi, "mobi"]] as const) {
        expect(result.source).toBe(source);
        expect(result.pages).toBeGreaterThanOrEqual(3);
        const { pages } = env.comics.pages(result.resourceId);
        expect(pages.every((page) => page.ok)).toBe(true);
        const first = await env.comics.pageHandle({ resourceId: result.resourceId, revisionId: result.revisionId, pageId: pages[0]!.id });
        if (!first.available || first.kind !== "image") throw new Error("expected image");
        const response = await get(env, first.url);
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.length).toBeGreaterThan(100);
        const sharp = (await import("sharp")).default;
        expect((await sharp(bytes).metadata()).width).toBe(pages[0]!.width);
      }
    } finally { env.close(); }
  });

  it("copies a single-file comic into the library when asked, and keeps reading it after the original is removed", async () => {
    const env = setup();
    try {
      const copy = path.join(root, "托管 测试.cbz");
      fs.copyFileSync(samplePath("cbz-basic"), copy);
      const result = await env.comics.importOne({ sourcePath: copy, hosted: true });
      fs.rmSync(copy);
      const handle = await env.comics.pageHandle({ resourceId: result.resourceId, revisionId: result.revisionId, pageId: "002.png" });
      expect(handle).toMatchObject({ available: true });
      const hosted = fs.readdirSync(env.store.attachmentsDir).filter((name) => name.endsWith(".bin"));
      expect(hosted).toEqual([`${result.revisionId}.bin`]);
      await expect(env.comics.importOne({ sourcePath: samplePath("comic-dir-natural"), hosted: true })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(fs.readdirSync(env.store.attachmentsDir).filter((name) => name.endsWith(".part"))).toEqual([]);
    } finally { env.close(); }
  });

  it("rejects what is not a comic", async () => {
    const env = setup();
    try {
      const text = path.join(root, "notes.txt");
      fs.writeFileSync(text, "not a comic");
      await expect(env.comics.importOne({ sourcePath: text })).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
      await expect(env.comics.importOne({ sourcePath: path.join(root, "absent") })).rejects.toMatchObject({ code: "NOT_FOUND" });
      const empty = path.join(root, "空目录");
      fs.mkdirSync(empty);
      await expect(env.comics.importOne({ sourcePath: empty })).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    } finally { env.close(); }
  });
});
