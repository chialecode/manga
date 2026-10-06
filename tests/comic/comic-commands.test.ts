import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { requireSamples, samplePath } from "../helpers/samples.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>, grantHandle = ctx.grant.handle, actor: { kind: "user" | "agent"; id: string } = ctx.actor) {
  counter += 1;
  return ctx.app.call(actor, { commandId, idempotencyKey: `comic-cmd-${counter}`, input }, grantHandle);
}

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

function pick(ctx: App, purpose: "file" | "directory" | "export", target: string): string {
  return ctx.app.registerPath(purpose, target);
}

function scratch(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `manga-${prefix}-`));
}

describe("comic commands through the product app", () => {
  requireSamples(["comic-dir-natural", "comic-dir-sparse", "comic-dir-duplicates", "cbz-basic", "comic-pdf-images", "comic-epub-images", "comic-mobi-images", "epub-with-cover", "video-mp4-h264-aac"]);

  it("suggests a media kind from the content, not only the extension", async () => {
    const ctx = await startApp();
    try {
      const suggest = async (file: string) => {
        const result = await run(ctx, "library.inspectFile", { pathHandle: pick(ctx, "file", file) });
        expect(result.status, JSON.stringify(result)).toBe("ok");
        return result.value as { entry: string; suggestion: { kind: string; basis: string; confidence: string } };
      };
      expect((await suggest(samplePath("cbz-basic"))).suggestion).toMatchObject({ kind: "comic", basis: "extension" });
      expect((await suggest(samplePath("comic-pdf-images"))).suggestion).toMatchObject({ kind: "comic", basis: "images_only" });
      expect((await suggest(samplePath("comic-epub-images"))).suggestion).toMatchObject({ kind: "comic", basis: "images_only" });
      expect((await suggest(samplePath("comic-mobi-images"))).suggestion).toMatchObject({ kind: "comic", basis: "images_only" });
      expect((await suggest(path.join(FIXTURES, "external-samples", "reading-sample.epub"))).suggestion.kind).toBe("novel");
      expect((await suggest(path.join(FIXTURES, "external-samples", "palmdoc-sample.mobi"))).suggestion.kind).toBe("novel");
      expect((await suggest(path.join(FIXTURES, "external-samples", "external-pages.pdf"))).suggestion.kind).toBe("novel");
      expect((await suggest(samplePath("video-mp4-h264-aac"))).suggestion).toMatchObject({ kind: "video", basis: "extension" });
      const dir = await run(ctx, "library.inspectFile", { pathHandle: pick(ctx, "directory", samplePath("comic-dir-duplicates")) });
      const value = dir.value as { entry: string; suggestion: { kind: string }; items: Array<{ relative: string }>; counts: { comic: number } };
      expect(value.entry).toBe("directory");
      expect(value.suggestion.kind).toBe("comic");
      expect(value.counts.comic).toBe(3);
      expect(value.items.map((item) => item.relative)).toEqual(["vol01/ch01", "vol01/ch02", "vol02/ch01"]);
    } finally { ctx.app.close(); }
  });

  it("refuses a path handle issued for another purpose and a handle nobody issued", async () => {
    const ctx = await startApp();
    try {
      const exportHandle = pick(ctx, "export", samplePath("cbz-basic"));
      const wrong = await run(ctx, "library.inspectFile", { pathHandle: exportHandle });
      expect(wrong.error?.code).toBe("FORBIDDEN");
      const forged = await run(ctx, "library.inspectFile", { pathHandle: "path_forged" });
      expect(forged.error?.code).toBe("FORBIDDEN");
      const file = await run(ctx, "works.importDirectory", { pathHandle: pick(ctx, "file", samplePath("cbz-basic")), kind: "comic" });
      expect(file.error?.code).toBe("FORBIDDEN");
      const missing = await run(ctx, "library.inspectFile", { pathHandle: pick(ctx, "file", path.join(os.tmpdir(), "manga-no-such-file.cbz")) });
      expect(missing.error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); }
  });

  it("imports a comic archive from bytes or from a path, once, and reads its pages", async () => {
    const ctx = await startApp();
    try {
      const bytes = [...fs.readFileSync(samplePath("cbz-basic"))];
      const first = await run(ctx, "library.importDocument", { title: "示例本", kind: "comic", bytes });
      expect(first.status, JSON.stringify(first)).toBe("ok");
      const value = first.value as { resourceId: string; revisionId: string; workId: string; pages: number; duplicate: boolean; kind: string };
      expect(value).toMatchObject({ pages: 5, duplicate: false, kind: "comic" });
      expect(fs.existsSync(path.join(ctx.app.media.dir("staging"), "x"))).toBe(false);
      expect(fs.readdirSync(ctx.app.media.dir("staging"))).toEqual([]);
      const same = await run(ctx, "library.importDocument", { title: "示例本", kind: "comic", pathHandle: pick(ctx, "file", samplePath("cbz-basic")) });
      // Bytes are hosted at an attachment path and the picked file lives elsewhere, so this is a second resource of equal content.
      expect(same.status, JSON.stringify(same)).toBe("ok");
      const pages = await run(ctx, "comic.pages", { resourceId: value.resourceId });
      expect(pages.status, JSON.stringify(pages)).toBe("ok");
      const manifest = pages.value as { pages: Array<{ id: string; ok: boolean }>; revisionId: string; available: boolean };
      expect(manifest.pages).toHaveLength(5);
      expect(manifest.available).toBe(true);
      const handle = await run(ctx, "comic.pageHandle", { resourceId: value.resourceId, revisionId: value.revisionId, pageId: manifest.pages[0]!.id });
      expect(handle.status, JSON.stringify(handle)).toBe("ok");
      const info = handle.value as { available: boolean; url: string; handle: string; mediaType: string };
      expect(info.available).toBe(true);
      expect(info.url).toMatch(/^manga-media:\/\/media\/h[A-Za-z0-9_-]{20,}$/);
      expect(ctx.app.media.handles.resolve(info.handle)?.binding).toMatchObject({ moduleId: "manga.comic", resourceId: value.resourceId, revisionId: value.revisionId });
      const batch = await run(ctx, "comic.pageHandles", { resourceId: value.resourceId, revisionId: value.revisionId, pageIds: manifest.pages.slice(0, 3).map((page) => page.id), variant: "thumb" });
      const items = (batch.value as { pages: Array<{ available: boolean }> }).pages;
      expect(items).toHaveLength(3);
      expect(items.every((item) => item.available)).toBe(true);
      const work = await run(ctx, "works.get", { workId: value.workId });
      expect((work.value as { mediaKind: string }).mediaKind).toBe("comic");
    } finally { ctx.app.close(); }
  });

  it("imports a folder of chapters as one work and a folder of books as one work in order", async () => {
    const ctx = await startApp();
    try {
      const comic = await run(ctx, "works.importDirectory", { pathHandle: pick(ctx, "directory", samplePath("comic-dir-duplicates")), kind: "comic", title: "合集" });
      expect(comic.status, JSON.stringify(comic)).toBe("ok");
      const value = comic.value as { workId: string; resources: Array<{ ordinalLabel: string }> };
      expect(value.resources.map((item) => item.ordinalLabel)).toEqual(["第 1 卷 · 第 1 话", "第 1 卷 · 第 2 话", "第 2 卷 · 第 1 话"]);
      const detail = await run(ctx, "works.get", { workId: value.workId });
      const resources = (detail.value as { resources: Array<{ ordinalLabel: string | null; kind: string }> }).resources;
      expect(resources.map((item) => item.ordinalLabel)).toEqual(["第 1 卷 · 第 1 话", "第 1 卷 · 第 2 话", "第 2 卷 · 第 1 话"]);
      expect(resources.every((item) => item.kind === "comic")).toBe(true);

      const books = scratch("books");
      for (const [name, body] of [["第10卷.txt", "第十卷的正文。"], ["第2卷.txt", "第二卷的正文。"], ["第1卷.txt", "第一卷的正文。"]] as const) fs.writeFileSync(path.join(books, name), body);
      fs.writeFileSync(path.join(books, "notes.docx"), "not a book");
      const novel = await run(ctx, "works.importDirectory", { pathHandle: pick(ctx, "directory", books), kind: "novel", title: "三卷小说" });
      expect(novel.status, JSON.stringify(novel)).toBe("ok");
      const novelWork = (novel.value as { workId: string; resources: Array<{ error?: unknown }> });
      expect(novelWork.resources).toHaveLength(3);
      expect(novelWork.resources.every((item) => !item.error)).toBe(true);
      const novelDetail = await run(ctx, "works.get", { workId: novelWork.workId });
      const detailValue = novelDetail.value as { title: string; mediaKind: string; resources: Array<{ ordinalLabel: string | null }> };
      expect(detailValue).toMatchObject({ title: "三卷小说", mediaKind: "novel" });
      expect(detailValue.resources.map((item) => item.ordinalLabel)).toEqual(["第 1 卷", "第 2 卷", "第 10 卷"]);
      fs.rmSync(books, { recursive: true, force: true });

      const video = await run(ctx, "works.importDirectory", { pathHandle: pick(ctx, "directory", samplePath("comic-dir-natural")), kind: "video" });
      expect(video.status).toBe("error");
    } finally { ctx.app.close(); }
  });

  it("keeps a folder import idempotent and reports unreadable pages without stopping", async () => {
    const ctx = await startApp();
    try {
      const handle = pick(ctx, "directory", samplePath("comic-dir-sparse"));
      counter += 1;
      const input = { commandId: "works.importDirectory", idempotencyKey: `comic-cmd-fixed-${counter}`, input: { pathHandle: handle, kind: "comic" } };
      const first = await ctx.app.call(ctx.actor, input, ctx.grant.handle);
      const again = await ctx.app.call(ctx.actor, input, ctx.grant.handle);
      expect(first.status, JSON.stringify(first)).toBe("ok");
      expect(again.idempotentReplay).toBe(true);
      expect(again.value).toEqual(first.value);
      const imported = await run(ctx, "works.importDirectory", { pathHandle: handle, kind: "comic" });
      const resources = (imported.value as { resources: Array<{ duplicate: boolean }> }).resources;
      expect(resources.every((item) => item.duplicate)).toBe(true);
      const count = ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number };
      expect(count.n).toBe(1);
    } finally { ctx.app.close(); }
  });

  it("turns comic reading off and on without losing the library", async () => {
    const ctx = await startApp();
    try {
      const bytes = [...fs.readFileSync(samplePath("cbz-basic"))];
      const imported = await run(ctx, "library.importDocument", { title: "可停用", kind: "comic", bytes });
      const value = imported.value as { resourceId: string; revisionId: string; workId: string };
      const manifest = (await run(ctx, "comic.pages", { resourceId: value.resourceId })).value as { pages: Array<{ id: string }> };
      const handle = (await run(ctx, "comic.pageHandle", { resourceId: value.resourceId, revisionId: value.revisionId, pageId: manifest.pages[0]!.id })).value as { handle: string };
      expect(ctx.app.media.handles.resolve(handle.handle)).not.toBeNull();
      expect(ctx.app.uiFacets.has("comic")).toBe(true);

      const profile = ctx.app.runtime.snapshot().lastValidProfile!;
      await ctx.app.runtime.applyProfile({ ...profile, revision: profile.revision + 1, disabledFeatures: [...profile.disabledFeatures, "comic"] });
      expect(ctx.app.uiFacets.has("comic")).toBe(false);
      expect(ctx.app.media.handles.resolve(handle.handle)).toBeNull();
      const off = await run(ctx, "comic.pages", { resourceId: value.resourceId });
      expect(off.status).toBe("error");
      const blocked = await run(ctx, "library.importDocument", { title: "不能导入", kind: "comic", bytes });
      expect(blocked.error?.code).toBe("CAPABILITY_UNAVAILABLE");
      // The library, its progress and notes stay manageable while the reader is off.
      const detail = await run(ctx, "works.get", { workId: value.workId });
      expect(detail.status).toBe("ok");
      const note = await run(ctx, "notes.create", { title: "停用时的笔记", text: "仍可记录" });
      expect(note.status, JSON.stringify(note)).toBe("ok");

      await ctx.app.runtime.applyProfile({ ...profile, revision: profile.revision + 2 });
      const back = await run(ctx, "comic.pages", { resourceId: value.resourceId });
      expect(back.status, JSON.stringify(back)).toBe("ok");
      const fresh = await run(ctx, "comic.pageHandle", { resourceId: value.resourceId, revisionId: value.revisionId, pageId: manifest.pages[0]!.id });
      expect((fresh.value as { handle: string }).handle).not.toBe(handle.handle);
      expect(ctx.app.media.handles.resolve(handle.handle)).toBeNull();
    } finally { ctx.app.close(); }
  });

  it("lets an agent read a page list inside its grant and nothing else", async () => {
    const ctx = await startApp();
    try {
      const bytes = [...fs.readFileSync(samplePath("cbz-basic"))];
      const imported = await run(ctx, "library.importDocument", { title: "授权漫画", kind: "comic", bytes });
      const value = imported.value as { resourceId: string; revisionId: string };
      const other = await run(ctx, "library.importDocument", { title: "未授权漫画", kind: "comic", pathHandle: pick(ctx, "file", samplePath("comic-pdf-images")) });
      const agent = { kind: "agent" as const, id: "agent-1" };
      const grant = ctx.app.issueAgentGrant(ctx.grant, agent, { sessionId: "sess-1", runId: "run-1", readResourceIds: [value.resourceId] });
      const allowed = await run(ctx, "comic.pages", { resourceId: value.resourceId }, grant.handle, agent);
      expect(allowed.status, JSON.stringify(allowed)).toBe("ok");
      const denied = await run(ctx, "comic.pages", { resourceId: (other.value as { resourceId: string }).resourceId }, grant.handle, agent);
      expect(denied.error?.code).toBe("SCOPE_DENIED");
      const handle = await run(ctx, "comic.pageHandle", { resourceId: value.resourceId, revisionId: value.revisionId, pageId: "x" }, grant.handle, agent);
      expect(handle.error?.code).toBe("FORBIDDEN");
      const importing = await run(ctx, "works.importDirectory", { pathHandle: "p", kind: "comic" }, grant.handle, agent);
      expect(importing.error?.code).toBe("FORBIDDEN");
      const pdf = await run(ctx, "comic.pageHandle", { resourceId: (other.value as { resourceId: string }).resourceId, revisionId: (other.value as { revisionId: string }).revisionId, pageId: "page-1" });
      expect(pdf.value).toMatchObject({ available: true, kind: "pdf", pageNumber: 1 });
    } finally { ctx.app.close(); }
  });
});
