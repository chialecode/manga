import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeThumbnail } from "../../packages/app-core/src/media/thumbnails.ts";
import { cleanPdfInfo, comicInfoFields, decodeXml, isEmptyFields, parseOpf, videoTagFields } from "../../packages/app-core/src/metadata/local-file.ts";
import { startApp } from "../helpers/app.ts";
import { requireSamples, samplePath } from "../helpers/samples.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>) {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `local-file-${counter}`, input }, ctx.grant.handle);
}

function ok<T = Record<string, unknown>>(result: Awaited<ReturnType<typeof run>>): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}

const pick = (ctx: App, target: string) => ctx.app.registerPath("file", target);

type Work = {
  mediaKind: string;
  coverCount: number;
  coverState: string;
  fields: Record<string, { value: unknown; source: string | null; providerId?: string; policy: string }>;
  snapshots: Array<{ providerId: string; detached: boolean }>;
};

async function importAndSettle(ctx: App, input: Record<string, unknown>): Promise<{ workId: string; resourceId: string; duplicate: boolean }> {
  const result = ok<{ workId: string; resourceId: string; duplicate: boolean }>(await run(ctx, "library.importDocument", input));
  await ctx.app.media.jobs.idle();
  return result;
}

const work = async (ctx: App, workId: string) => ok<Work>(await run(ctx, "works.get", { workId }));

describe("what a file says about itself, as units", () => {
  it("reads Dublin Core fields and finds the cover three ways", () => {
    const opf = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:title>Fish &amp; Chips &#x4E2D;</dc:title><dc:creator>A. Writer</dc:creator><dc:creator>B. Drawer</dc:creator><dc:creator>A. Writer</dc:creator>
      <dc:publisher>Synthetic Press</dc:publisher><dc:date>2021-03-04T00:00:00Z</dc:date>
      <dc:description><![CDATA[<p>Line one</p><p>Line two</p>]]></dc:description>
      <dc:subject>one</dc:subject><dc:subject>two</dc:subject><meta name="cover" content="img-cover"/></metadata>
      <manifest><item id="img-cover" href="images/front%20page.png" media-type="image/png"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/></manifest></package>`;
    const info = parseOpf(opf, "OEBPS/content.opf");
    expect(info.fields).toMatchObject({ title: "Fish & Chips 中", author: "A. Writer / B. Drawer", studio: "Synthetic Press", releaseDate: "2021-03-04", tags: ["one", "two"] });
    expect(info.fields.summary).toBe("Line one Line two");
    expect(info.coverHref).toBe("images/front%20page.png");
    expect(info.opfDir).toBe("OEBPS/");

    const byProperty = parseOpf(`<package><metadata/><manifest><item id="a" href="a.png" media-type="image/png"/><item id="c" href="c.jpg" media-type="image/jpeg" properties="cover-image"/></manifest></package>`, "content.opf");
    expect(byProperty.coverHref).toBe("c.jpg");
    const byName = parseOpf(`<package><metadata/><manifest><item id="a" href="a.png" media-type="image/png"/><item id="x" href="img/Cover.png" media-type="image/png"/></manifest></package>`, "content.opf");
    expect(byName.coverHref).toBe("img/Cover.png");
    const none = parseOpf(`<package><metadata><dc:title>Untitled</dc:title></metadata><manifest><item id="a" href="a.html" media-type="text/html"/></manifest></package>`, "content.opf");
    expect(none.coverHref).toBeUndefined();
    expect(isEmptyFields(none.fields)).toBe(true);
  });

  it("decodes XML entities and ignores impossible code points", () => {
    expect(decodeXml("a &lt; b &amp;amp; &#65;&#x42; &#0; &unknown; &#x110000;")).toBe("a < b &amp; AB &#0; &unknown; &#x110000;");
  });

  it("keeps PDF information that means something and drops authoring-tool leftovers", () => {
    expect(cleanPdfInfo({ Title: "Synthetic Book", Author: "A. Writer", Subject: "About it", CreationDate: "D:20190203040506+08'00'" })).toEqual({ title: "Synthetic Book", author: "A. Writer", summary: "About it", releaseDate: "2019-02-03" });
    expect(cleanPdfInfo({ Title: "Microsoft Word - draft.docx", Author: "" })).toEqual({});
    expect(cleanPdfInfo({ Title: "scan0001.pdf" })).toEqual({});
    expect(cleanPdfInfo(undefined)).toEqual({});
  });

  it("takes ComicInfo and video tags as fields, and ignores a video title that is only the file name", () => {
    expect(comicInfoFields({ series: "Series", title: "Volume", writer: "W", summary: "S", year: 2020 } as never)).toEqual({ title: "Series", author: "W", summary: "S", releaseDate: "2020" });
    expect(comicInfoFields(undefined)).toEqual({});
    expect(videoTagFields({ tags: { title: "Episode", artist: "Someone", date: "2018-05-06", genre: "a; b/c" } }, "file")).toMatchObject({ title: "Episode", author: "Someone", releaseDate: "2018-05-06", tags: ["a", "b", "c"] });
    expect(videoTagFields({ tags: { title: "FILE" } }, "file")).toEqual({});
    expect(videoTagFields({}, "file")).toEqual({});
  });
});

describe("covers and metadata taken from files at import", () => {
  requireSamples(["cbz-comicinfo", "epub-with-cover", "comic-pdf-images", "comic-mobi-images", "video-mkv-ass-fonts", "video-mp4-h264-aac"]);

  it("takes the cover and the ComicInfo fields from a comic archive, once, as the first source", async () => {
    const ctx = await startApp();
    try {
      const first = await importAndSettle(ctx, { title: "文件名里的标题", kind: "comic", pathHandle: pick(ctx, samplePath("cbz-comicinfo")) });
      const detail = await work(ctx, first.workId);
      expect(detail.coverCount).toBe(1);
      expect(detail.coverState).toBe("auto");
      // The file's own series name outranks the name the user typed at import (a file name source), and says where it came from.
      expect(detail.fields.title).toMatchObject({ value: "Synthetic Series", source: "file", providerId: "local-file" });
      expect(detail.fields.author).toMatchObject({ value: "A. Writer", source: "file" });
      expect(detail.snapshots.map((item) => item.providerId)).toEqual(["local-file"]);

      const again = await importAndSettle(ctx, { title: "文件名里的标题", kind: "comic", pathHandle: pick(ctx, samplePath("cbz-comicinfo")) });
      expect(again.duplicate).toBe(true);
      expect((await work(ctx, first.workId)).coverCount).toBe(1);

      const covers = ok<{ coverId: string; covers: Array<{ id: string; source: string; selected: boolean; width: number | null }> }>(await run(ctx, "covers.list", { workId: first.workId }));
      expect(covers.covers).toHaveLength(1);
      expect(covers.covers[0]).toMatchObject({ source: "file", selected: true });
      expect(covers.coverId).toBe(covers.covers[0]!.id);
    } finally { ctx.app.close(); }
  });

  it("uses the EPUB's declared cover rather than its first picture", async () => {
    const ctx = await startApp();
    try {
      const imported = await importAndSettle(ctx, { title: "带封面的书", kind: "novel", format: "epub", pathHandle: pick(ctx, samplePath("epub-with-cover")) });
      const file = samplePath("epub-with-cover");
      const hashOf = async (entry: string) => createHash("sha256").update((await makeThumbnail(await ctx.app.media.zips.read(file, entry), { maxEdge: 1200, format: "webp", quality: 85 })).bytes).digest("hex");
      const stored = ctx.app.store.sqlite.prepare("SELECT content_hash AS hash, source FROM covers WHERE work_id = ?").all(imported.workId) as Array<{ hash: string; source: string }>;
      expect(stored).toHaveLength(1);
      expect(stored[0]!.source).toBe("file");
      expect(stored[0]!.hash).toBe(await hashOf("OEBPS/images/cover.png"));
      expect(stored[0]!.hash).not.toBe(await hashOf("OEBPS/images/001.png"));
    } finally { ctx.app.close(); }
  });

  it("renders the first page of a PDF and takes the first picture of an image-only MOBI as covers", async () => {
    const ctx = await startApp();
    try {
      const pdf = await importAndSettle(ctx, { title: "PDF 漫画", kind: "comic", pathHandle: pick(ctx, samplePath("comic-pdf-images")) });
      expect((await work(ctx, pdf.workId)).coverCount).toBe(1);
      const mobi = await importAndSettle(ctx, { title: "MOBI 漫画", kind: "comic", pathHandle: pick(ctx, samplePath("comic-mobi-images")) });
      expect((await work(ctx, mobi.workId)).coverCount).toBe(1);
      const sizes = ctx.app.store.sqlite.prepare("SELECT width, height FROM covers").all() as Array<{ width: number; height: number }>;
      for (const size of sizes) expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(1200);
    } finally { ctx.app.close(); }
  });

  it("takes a frame from a video as its cover, and leaves a file without any tags without a snapshot", async () => {
    const ctx = await startApp();
    try {
      const mkv = await importAndSettle(ctx, { title: "样例视频", kind: "video", pathHandle: pick(ctx, samplePath("video-mkv-ass-fonts")) });
      const detail = await work(ctx, mkv.workId);
      expect(detail.mediaKind).toBe("video");
      expect(detail.coverCount).toBe(1);
      expect(detail.fields.title?.source).not.toBe("file");
      expect(detail.snapshots.filter((item) => item.providerId === "local-file")).toHaveLength(0);
    } finally { ctx.app.close(); }
  });

  it("serves a small thumbnail for the grid and a bigger one for the detail page, by handle", async () => {
    const ctx = await startApp();
    try {
      const imported = await importAndSettle(ctx, { title: "封面", kind: "comic", pathHandle: pick(ctx, samplePath("cbz-comicinfo")) });
      const coverId = ok<{ coverId: string }>(await run(ctx, "covers.list", { workId: imported.workId })).coverId;
      const grid = ok<{ covers: Array<{ available: boolean; url?: string; width?: number; height?: number; mediaType?: string }> }>(await run(ctx, "covers.handles", { coverIds: [coverId, "cov_missing"], size: "grid" }));
      expect(grid.covers[0]).toMatchObject({ available: true, mediaType: "image/webp" });
      expect(Math.max(grid.covers[0]!.width!, grid.covers[0]!.height!)).toBeLessThanOrEqual(360);
      expect(grid.covers[1]).toMatchObject({ available: false });
      expect(JSON.stringify(grid)).not.toContain(path.basename(samplePath("cbz-comicinfo")));
      expect(grid.covers[0]!.url).toMatch(/^manga-media:\/\/media\/h/);
    } finally { ctx.app.close(); }
  });

  it("does not read the file's own metadata when metadata is switched off, but still takes the cover", async () => {
    const ctx = await startApp();
    try {
      const profile = ctx.app.runtime.snapshot().lastValidProfile!;
      await ctx.app.runtime.applyProfile({ ...profile, revision: profile.revision + 1, disabledFeatures: [...profile.disabledFeatures, "metadata"] });
      const imported = await importAndSettle(ctx, { title: "关闭资料", kind: "comic", pathHandle: pick(ctx, samplePath("cbz-comicinfo")) });
      const detail = await work(ctx, imported.workId);
      expect(detail.coverCount).toBe(1);
      expect(detail.snapshots).toHaveLength(0);
      expect(detail.fields.title?.value).not.toBe("Synthetic Series");
      expect(fs.existsSync(samplePath("cbz-comicinfo"))).toBe(true);
    } finally { ctx.app.close(); }
  });
});
