/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { buildEpubFixture, parseEpubBytes, parsePdfBytes } from "@manga/app-core";
import { exportLibraryPackage, importLibraryPackageResolved } from "../../packages/app-core/src/domain/library-package.ts";
import { MangaError } from "@manga/contracts";
import { startApp, tempProfile } from "./helpers.ts";
import { ReadingPane, type ReadingDocument } from "../../apps/desktop/src/renderer/reading.tsx";
import { renderPdfPage } from "./pdf-pixels.ts";

type Ctx = Awaited<ReturnType<typeof startApp>>;

async function command(ctx: Ctx, commandId: string, input: Record<string, unknown>) {
  const result = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: crypto.randomUUID(), input }, ctx.grant.handle);
  expect(result.status, result.error?.message).toBe("ok");
  return result.value as Record<string, unknown>;
}

async function libraryWithNote(ctx: Ctx) {
  const book = await command(ctx, "library.importDocument", { title: "合成来源", format: "txt", bytes: [...new TextEncoder().encode("甲乙丙丁。第二段文字。")] });
  const note = await command(ctx, "notes.create", {
    title: "合成来源笔记", text: "原评论", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
    locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "甲乙丙丁" } },
  });
  return { book, note };
}

/** A classic-xref PDF with one page and the given content stream operators. */
function classicPdf(content: string, fontDict = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>"): Uint8Array {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
    fontDict,
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  bodies.forEach((body, index) => { offsets.push(Buffer.byteLength(source, "ascii")); source += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(source, "ascii");
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(source, "ascii"));
}

describe("M1b b8 PDF text advancing", () => {
  it("moves the text matrix by the glyphs' real advance after each shown string", async () => {
    const parsed = await parsePdfBytes(classicPdf("BT /F1 20 Tf 1 0 0 1 50 320 Tm (HELLO) Tj (WORLD) Tj ET"));
    expect(parsed.parts[0]!.normalized).toBe("HELLOWORLD");
    const runs = parsed.parts[0]!.textRuns ?? [];
    expect(runs).toHaveLength(1);
    // Courier 20 pt, ten glyphs of 600/1000: the whole run is 120 wide and starts at the text matrix.
    expect(runs[0]!.x).toBe(50);
    expect(runs[0]!.y).toBe(320);
    expect(runs[0]!.width).toBe(120);
  });

  it("applies TJ numeric spacing between elements in the render model", async () => {
    const parsed = await parsePdfBytes(classicPdf("BT /F1 20 Tf 1 0 0 1 50 320 Tm [(HELLO) -300 (WORLD)] TJ ET"));
    expect(parsed.parts[0]!.normalized).toBe("HELLO WORLD");
    const runs = parsed.parts[0]!.textRuns ?? [];
    expect(runs[0]!.width).toBe(126);
  });

  it("starts the quote operator's line at the line matrix with the leading applied", async () => {
    const parsed = await parsePdfBytes(classicPdf("BT /F1 20 Tf 24 TL 1 0 0 1 50 320 Tm (HELLO) Tj (WORLD) ' ET"));
    expect(parsed.parts[0]!.normalized).toBe("HELLO\nWORLD");
    const runs = parsed.parts[0]!.textRuns ?? [];
    expect(runs).toHaveLength(2);
    expect(runs[1]!.x).toBe(50);
    expect(runs[1]!.y).toBe(296);
  });

  it("keeps each text run's fill colour so white text stays white over a dark box", async () => {
    const parsed = await parsePdfBytes(classicPdf("0 g 20 280 320 70 re f 1 g BT /F1 20 Tf 1 0 0 1 50 320 Tm (WHITE TEXT) Tj ET"));
    expect(parsed.parts[0]!.normalized).toBe("WHITE TEXT");
    const { ctx } = await renderPdfPage(classicPdf("0 g 20 280 320 70 re f 1 g BT /F1 20 Tf 1 0 0 1 50 320 Tm (WHITE TEXT) Tj ET"), 2);
    const ink = ctx.getImageData(120, 140, 40, 20).data;
    expect([...ink].some((channel, index) => index % 4 !== 3 && channel > 200)).toBe(true);
  });

  it("honours declared /Widths over the built-in metrics", async () => {
    const parsed = await parsePdfBytes(classicPdf("BT /F1 10 Tf 1 0 0 1 50 320 Tm (AB) Tj (C) Tj ET",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Custom /FirstChar 65 /Widths [278 556 444] /Encoding /WinAnsiEncoding >>"));
    expect(parsed.parts[0]!.normalized).toBe("ABC");
    expect(parsed.parts[0]!.textRuns?.[0]?.width).toBeCloseTo(12.78, 2);
  });
});

describe("M1b b8 EPUB fixed geometry", () => {
  it("renders a circle as an ellipse item, not a filled bounding-box rectangle", () => {
    const parsed = parseEpubBytes(buildEpubFixture({
      title: "固定几何",
      fixedLayout: true,
      chapters: [{ id: "p1", title: "矢量页", html: "", svgBody: '<circle cx="200" cy="200" r="80" fill="red"/>' }],
    }));
    const render = parsed.parts[0]!.render;
    expect(render).toBeDefined();
    expect(render!.items.some((item) => item.k === "r" && item.w === 160 && item.h === 160)).toBe(false);
    const ellipse = render!.items.find((item) => item.k === "e") as { k: "e"; x: number; y: number; w: number; h: number; c: string } | undefined;
    expect(ellipse).toMatchObject({ x: 120, y: 120, w: 160, h: 160, c: "red" });
  });
});

const paneLabels = {
  importBook: "导入", empty: "空", search: "搜索", progress: "进度", note: "记下选区", missing: "缺失", scan: "扫描",
  more: "继续", image: "图片", imageFailed: "失败", restored: "恢复", restoredStart: "开头", restoredOffset: "位置",
  rangeRead: "已读", rangeNone: "未读", style: "样式", fontSize: "字号", fontFamily: "字体", fontSans: "黑体",
  fontSerif: "宋体", fontMono: "等宽", lineHeight: "行距", margin: "边距", measure: "版心", themeWhite: "白",
  themeGreen: "绿", themePaper: "纸", themeNight: "夜", bookmark: "书签", bookmarkAdd: "加书签", bookmarkNone: "无",
  bookmarkRemove: "删", prev: "上一页", next: "下一页", part: "{index}/{total}", hits: "命中", hitNone: "无",
  jump: "跳转", toc: "目录", source: "来源", sourceOpen: "打开", quote: "选区", images: "插图",
  selectForAgent: "交 Agent", partSource: "源文件",
  resourceTotal: "全库共 {count} 本", resourceLoadMore: "加载更早的书", resourceSearch: "全库搜索书名", resourceSearchAction: "搜索",
  viewPage: "页面视图", viewText: "文本视图",
};
const paneLabelsExtra = { backToNote: "返回笔记", sourceResolved: "来源可用", sourceNeedsReview: "需要确认", sourceMissing: "来源缺失", sourceRepair: "重新指定", sourceCard: "来源卡片" };

const geometryDoc = {
  resourceId: "res_g",
  revisionId: "rev_g",
  title: "几何书",
  format: "epub",
  warnings: [],
  toc: [],
  parts: [{ id: "page-1", kind: "text", length: 5, textLayer: true, imageCount: 0, index: 0, hasRender: true }],
  slice: {
    partId: "page-1",
    text: "WHITE",
    start: 0,
    end: 5,
    kind: "text",
    textLayer: true,
    render: {
      w: 400,
      h: 400,
      items: [
        { k: "r", x: 20, y: 280, w: 320, h: 70, c: "rgb(0,0,0)" },
        { k: "t", x: 50, y: 320, s: 20, f: "mono", t: "WHITE", c: "rgb(255,255,255)", o: 0 },
        { k: "e", x: 120, y: 120, w: 160, h: 160, c: "red" },
      ],
    },
  },
  progress: null,
  readRanges: [],
  assets: [],
  source: { available: true, hosted: false },
  authorStyle: null,
} as unknown as ReadingDocument;

const styledDoc = {
  ...geometryDoc,
  slice: { ...geometryDoc.slice, render: null },
  authorStyle: { color: "#223344", background: "#ffffff", lineHeight: 2.3, textAlign: "right" },
} as unknown as ReadingDocument;

const baseStyle = { measurePx: 680, fontSizePx: 18, fontFamily: "sans" as const, lineHeight: 1.7, marginPx: 24, theme: "white" };

function renderPane(document: ReadingDocument) {
  return render(<ReadingPane
    resources={[]} document={document} style={baseStyle}
    hits={[]} bookmarks={[]} assets={{}} highlight={null} sourceCard={null}
    onBackToNote={() => {}} onRepair={() => {}} labelsExtra={paneLabelsExtra} labels={paneLabels}
    onImportBook={() => {}} onOpen={() => {}} onSearch={() => {}} onJump={() => {}} onProgress={() => {}}
    onNote={() => {}} onMore={() => {}} onPart={() => {}} onStyle={() => {}} onBookmark={() => {}}
    onRemoveBookmark={() => {}} onOpenBookmark={() => {}}
  />);
}

describe("M1b b8 page view geometry", () => {
  afterEach(() => cleanup());

  it("draws the stored ellipse and keeps the run's own fill colour", () => {
    renderPane(geometryDoc);
    const pageRender = screen.getByTestId("reading-page-render");
    const ellipse = pageRender.querySelector("ellipse");
    expect(ellipse).not.toBeNull();
    expect(ellipse!.getAttribute("rx")).toBe("80");
    expect(ellipse!.getAttribute("ry")).toBe("80");
    expect(pageRender.querySelectorAll("rect")).toHaveLength(1);
    const run = pageRender.querySelector("text");
    expect(run?.getAttribute("fill")).toBe("rgb(255,255,255)");
  });

  it("applies the author line height and alignment to the visible text view", () => {
    renderPane(styledDoc);
    const body = screen.getByTestId("reading-body");
    const style = body.getAttribute("style") ?? "";
    expect(style).toContain("line-height: 2.3");
    expect(style).toContain("text-align: right");
  });
});

describe("M1b b8 explicit mixed package strategies", () => {
  it("keeps an explicitly replaced revision under the owner its kept anchor names", async () => {
    const ctx = await startApp();
    try {
      const { book, note } = await libraryWithNote(ctx);
      const dir = tempProfile();
      exportLibraryPackage(ctx.app.store, dir);
      const db = ctx.app.store.sqlite;
      const refsBefore = db.prepare("SELECT id, to_id FROM refs WHERE from_object_id=? ORDER BY id").all(note.objectId);
      importLibraryPackageResolved(ctx.app.store, dir, { strategy: "replace", decisions: [
        { kind: "resource", id: String(book.resourceId), action: "duplicate" },
        { kind: "object", id: String(note.objectId), action: "skip" },
        { kind: "resource_revision", id: String(book.revisionId), action: "replace" },
      ] });
      // The anchor row is untouched, so the revision it names must still declare the original owner.
      const relation = db.prepare("SELECT a.resource_id AS anchorResource, v.resource_id AS revisionResource FROM anchors a LEFT JOIN resource_revisions v ON v.id = a.resource_revision_id WHERE a.id = (SELECT to_id FROM refs WHERE from_object_id = ? LIMIT 1)").get(note.objectId) as { anchorResource: string; revisionResource: string };
      expect(relation.anchorResource).toBe(String(book.resourceId));
      expect(relation.revisionResource).toBe(String(book.resourceId));
      expect(db.prepare("SELECT id, to_id FROM refs WHERE from_object_id=? ORDER BY id").all(note.objectId)).toEqual(refsBefore);
      const opened = await command(ctx, "notes.openSource", { objectId: String(note.objectId) }) as { status: string; resourceId: string; card?: { status: string } };
      expect(opened.status).toBe("resolved");
      expect(opened.resourceId).toBe(String(book.resourceId));
      expect(opened.card?.status).toBe("resolved");
      // The replaced payload was rewritten in place: the index names the same owner pair.
      const fragment = db.prepare("SELECT resource_id FROM text_fragments WHERE resource_revision_id = ? AND object_id IS NULL LIMIT 1").get(book.revisionId) as { resource_id: string };
      expect(fragment.resource_id).toBe(String(book.resourceId));
    } finally { ctx.app.close(); }
  });

  it("never moves a surviving note's ref when a copy of that note is imported under replace", async () => {
    const ctx = await startApp();
    try {
      const { book, note } = await libraryWithNote(ctx);
      const dir = tempProfile();
      exportLibraryPackage(ctx.app.store, dir);
      const db = ctx.app.store.sqlite;
      const refsBefore = db.prepare("SELECT id, to_id FROM refs WHERE from_object_id=? ORDER BY id").all(note.objectId);
      importLibraryPackageResolved(ctx.app.store, dir, { strategy: "replace", decisions: [
        { kind: "resource", id: String(book.resourceId), action: "duplicate" },
        { kind: "object", id: String(note.objectId), action: "duplicate" },
      ] });
      expect(db.prepare("SELECT id, to_id FROM refs WHERE from_object_id=? ORDER BY id").all(note.objectId)).toEqual(refsBefore);
      const opened = await command(ctx, "notes.openSource", { objectId: String(note.objectId) }) as { status: string; resourceId: string; card?: { status: string } };
      expect(opened.status).toBe("resolved");
      expect(opened.resourceId).toBe(String(book.resourceId));
      expect(opened.card?.status).toBe("resolved");
      // The copy carries its own reference and history, and both resolve.
      const copy = db.prepare("SELECT id FROM content_objects WHERE type='notes.document' AND id<>?").get(note.objectId) as { id: string };
      expect(copy).toBeTruthy();
      expect(db.prepare("SELECT id FROM refs WHERE from_object_id=? AND to_kind='anchor'").get(copy.id)).toBeTruthy();
      expect(db.prepare("SELECT id FROM object_revisions WHERE object_id=?").get(copy.id)).toBeTruthy();
      const copyOpened = await command(ctx, "notes.openSource", { objectId: copy.id }) as { status: string; card?: { status: string } };
      expect(copyOpened.status).toBe("resolved");
      expect(copyOpened.card?.status).toBe("resolved");
      // The copy's index row names the resource its anchor resolves to.
      const fragment = db.prepare("SELECT resource_id FROM text_fragments WHERE object_id = ? LIMIT 1").get(copy.id) as { resource_id: string };
      const anchorResource = db.prepare("SELECT a.resource_id AS rid FROM refs r JOIN anchors a ON a.id = r.to_id WHERE r.from_object_id = ? LIMIT 1").get(copy.id) as { rid: string };
      expect(fragment.resource_id).toBe(anchorResource.rid);
    } finally { ctx.app.close(); }
  });

  it("rejects a decisions set that pins one replaced revision to two different resources", async () => {
    const ctx = await startApp();
    try {
      const book = await command(ctx, "library.importDocument", { title: "冲突书", format: "txt", bytes: [...new TextEncoder().encode("冲突正文。")] });
      const noteA = await command(ctx, "notes.create", {
        title: "笔记甲", text: "评论甲", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "冲突正文" } },
      });
      const noteB = await command(ctx, "notes.create", {
        title: "笔记乙", text: "评论乙", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "冲突正文" } },
      });
      const dir = tempProfile();
      exportLibraryPackage(ctx.app.store, dir);
      const db = ctx.app.store.sqlite;
      // A diverged local row pins the same revision to a second resource; the package carries both
      // anchors, and both notes are skipped, so both kept anchors would pin the replaced revision.
      const anchorB = db.prepare("SELECT to_id AS id FROM refs WHERE from_object_id = ?").get(noteB.objectId) as { id: string };
      db.prepare("UPDATE anchors SET resource_id = 'res_diverged' WHERE id = ?").run(anchorB.id);
      let error: unknown;
      try {
        importLibraryPackageResolved(ctx.app.store, dir, { strategy: "replace", decisions: [
          { kind: "object", id: String(noteA.objectId), action: "skip" },
          { kind: "object", id: String(noteB.objectId), action: "skip" },
          { kind: "resource_revision", id: String(book.revisionId), action: "replace" },
        ] });
      } catch (thrown) { error = thrown; }
      expect(error).toBeInstanceOf(MangaError);
      expect((error as MangaError).code).toBe("PUBLISH_CONFLICT");
    } finally { ctx.app.close(); }
  });
});
