/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { buildEpubFixture, buildPdfFixture, parseEpubBytes, parsePdfBytes, slicePart } from "@manga/app-core";
import { exportLibraryPackage, importLibraryPackageResolved } from "../../packages/app-core/src/domain/library-package.ts";
import { readDocument, readSlice } from "../../packages/app-core/src/reading-service.ts";
import { startApp, tempProfile } from "./helpers.ts";
import { ReadingPane, pageSelectionRange, type ReadingDocument } from "../../apps/desktop/src/renderer/reading.tsx";
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

describe("M1b b7 PDF page presentation", () => {
  it("renders a positioned page whose run offsets quote the normalized text exactly", async () => {
    const parsed = await parsePdfBytes(buildPdfFixture([{ text: "第一页标题" }, { text: "第二页正文" }]));
    expect(parsed.traits.pdfjsPageRendering).toBe(true);
    const part = parsed.parts[0]!;
    const run = part.textRuns?.[0];
    expect(run?.text).toBe("第一页标题");
    const text = [...part.normalized];
    expect(text.slice(run!.offset!, run!.offset! + [...run!.text].length).join("")).toBe(run!.text);
    expect(part.render).toBeUndefined();
  });

  it("draws filled boxes, strokes and colors from the content stream", async () => {
    const objects: Buffer[] = [];
    const push = (text: string) => objects.push(Buffer.from(text));
    push("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n");
    push("2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n");
    push("3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n");
    const content = "0.2 0.4 0.6 rg 10 300 280 50 re f 1 0 0 RG 2 w 10 10 m 290 10 l S";
    push(`4 0 obj << /Length ${Buffer.byteLength(content)} >> stream\n${content}\nendstream\nendobj\n`);
    push("5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n");
    const header = Buffer.from("%PDF-1.4\n");
    let cursor = header.length;
    const xref = ["xref\n", `0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
    for (const object of objects) { xref.push(`${cursor.toString().padStart(10, "0")} 00000 n \n`); cursor += object.length; }
    const body = Buffer.concat(objects);
    const bytes = new Uint8Array(Buffer.concat([header, body, Buffer.from(xref.join("")), Buffer.from(`trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${header.length + body.length}\n%%EOF`)]));
    const parsed = await parsePdfBytes(bytes);
    expect(parsed.parts).toHaveLength(1);
    const { ctx } = await renderPdfPage(bytes, 2);
    const fill = ctx.getImageData(40, 110, 20, 20).data;
    expect(fill[2]).toBeGreaterThan(fill[0]);
  });

  it("exposes the page render and author styles through the read pipeline", async () => {
    const ctx = await startApp();
    try {
      const book = await command(ctx, "library.importDocument", {
        title: "呈现书", format: "pdf",
        bytes: [...buildPdfFixture([{ text: "呈现正文" }, { scan: true }])],
      });
      const document = readDocument(ctx.app.store, String(book.resourceId)) as { slice?: { text?: string; render?: { w: number } | null }; parts: Array<{ id: string; hasRender?: boolean }> };
      expect(document.parts.find((part) => part.id === "page-1")?.hasRender).toBe(true);
      expect(document.parts.find((part) => part.id === "page-2")?.hasRender).toBe(false);
      expect(document.slice?.text).toContain("呈现正文");
      expect(document.slice?.render).toBeUndefined();
      const slice = readSlice(ctx.app.store, { resourceId: String(book.resourceId), partId: "page-1" }) as { text?: string; render?: unknown };
      expect(slice.text).toContain("呈现正文");
      expect(slice.render).toBeUndefined();

      const epub = await command(ctx, "library.importDocument", {
        title: "样式书", format: "epub",
        bytes: [...buildEpubFixture({ title: "样式书", chapters: [{ id: "c1", title: "章", html: "<p>正文</p>" }] })],
      });
      const styled = readDocument(ctx.app.store, String(epub.resourceId)) as { authorStyle?: { color?: string } | null };
      expect(styled.authorStyle?.color).toBe("SECRETSTYLE");
    } finally { ctx.app.close(); }
  });
});

describe("M1b b7 EPUB author layout", () => {
  it("renders a fixed page from its stored layout and a vector-only page from its shapes", () => {
    const parsed = parseEpubBytes(buildEpubFixture({
      title: "固定版式",
      fixedLayout: true,
      chapters: [
        { id: "c1", title: "首页", html: "<p>正文甲</p>" },
        { id: "p2", title: "插图页", html: "", svgPage: "plate.png" },
        { id: "p3", title: "矢量页", html: "", svgBody: '<rect x="10" y="10" width="200" height="80" fill="teal"/><text x="30" y="150" font-size="24">矢量标题</text>' },
      ],
    }));
    expect(parsed.traits.fixedLayout).toBe(true);
    expect(parsed.traits.fixedPagesRendered).toBe(2);
    const plate = parsed.parts.find((part) => part.id === "p2")!;
    expect(plate.kind).toBe("image");
    expect(plate.render?.w).toBe(600);
    expect(plate.render?.h).toBe(800);
    const image = plate.render?.items.find((item) => item.k === "i") as { a?: string } | undefined;
    expect(image?.a).toBeTruthy();
    const vector = parsed.parts.find((part) => part.id === "p3")!;
    expect(vector.render).toBeDefined();
    const shapes = vector.render!.items;
    expect(shapes.some((item) => item.k === "r")).toBe(true);
    expect(shapes.some((item) => item.k === "t" && item.t === "矢量标题")).toBe(true);
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

const paneLabelsExtra = {
  backToNote: "返回笔记", sourceResolved: "来源可用", sourceNeedsReview: "需要确认", sourceMissing: "来源缺失",
  sourceRepair: "重新指定", sourceCard: "来源卡片",
};

const renderDoc = {
  resourceId: "res_r",
  revisionId: "rev_r",
  title: "呈现书",
  format: "epub",
  warnings: [],
  toc: [],
  parts: [{ id: "page-1", kind: "text", length: 5, textLayer: true, imageCount: 0, index: 0, hasRender: true }],
  slice: {
    partId: "page-1",
    text: "第一页标题",
    start: 0,
    end: 5,
    kind: "text",
    textLayer: true,
    render: {
      w: 300,
      h: 400,
      items: [
        { k: "t", x: 20, y: 300, s: 18, f: "sans", t: "第一页", o: 0 },
        { k: "r", x: 10, y: 200, w: 100, h: 40, c: "rgb(51,102,153)" },
        { k: "t", x: 20, y: 100, s: 14, f: "serif", t: "标题", o: 3 },
      ],
    },
  },
  progress: null,
  readRanges: [],
  assets: [],
  source: { available: true, hosted: false },
  authorStyle: { color: "#123456", background: "#f0f0f0" },
} as unknown as ReadingDocument;

describe("M1b b7 page view", () => {
  afterEach(() => cleanup());

  it("renders the positioned page by default and maps a run selection to text-layer offsets", () => {
    render(<ReadingPane
      resources={[]} document={renderDoc} style={{ measurePx: 680, fontSizePx: 18, fontFamily: "sans", lineHeight: 1.7, marginPx: 24, theme: "white" }}
      hits={[]} bookmarks={[]} assets={{}} highlight={null} sourceCard={null}
      onBackToNote={() => {}} onRepair={() => {}} labelsExtra={paneLabelsExtra} labels={paneLabels}
      onImportBook={() => {}} onOpen={() => {}} onSearch={() => {}} onJump={() => {}} onProgress={() => {}}
      onNote={() => {}} onMore={() => {}} onPart={() => {}} onStyle={() => {}} onBookmark={() => {}}
      onRemoveBookmark={() => {}} onOpenBookmark={() => {}}
    />);
    const pageRender = screen.getByTestId("reading-page-render");
    expect(pageRender.querySelectorAll("text")).toHaveLength(2);
    // The body keeps the text layer hidden so search and the smoke can still read it.
    const body = screen.getByTestId("reading-body");
    expect(body.getAttribute("data-view")).toBe("page");
    expect(body.textContent).toContain("第一页标题");
    // A selection over the second run maps through data-cp to absolute text-layer offsets.
    const run = pageRender.querySelectorAll("text")[1]!;
    const range = document.createRange();
    range.selectNodeContents(run.childNodes[0]!);
    const mapped = pageSelectionRange(range);
    expect(mapped).toEqual({ start: 3, end: 5, quote: "标题" });
    // The author style tints the text view while the reader keeps the built-in defaults.
    expect(body.getAttribute("style")).toContain("rgb(18, 52, 86)");
    fireEvent.click(screen.getByTestId("reading-view-toggle"));
    expect(screen.getByTestId("reading-body").getAttribute("data-view")).toBe("text");
    expect(screen.queryByTestId("reading-page-render")).toBeNull();
  });

  it("lets the reader page through the whole library and open a row past the first window", () => {
    const first = Array.from({ length: 100 }, (_, index) => ({ id: `res_${index + 1}`, title: `书 ${index + 1}` }));
    const onOpen = vi.fn();
    const onMore = vi.fn();
    const pane = (props: { resources: Array<{ id: string; title: string }>; nextCursor: string | null }) => (
      <ReadingPane
        resources={props.resources} document={null} style={{ measurePx: 680, fontSizePx: 18, fontFamily: "sans", lineHeight: 1.7, marginPx: 24, theme: "white" }}
        hits={[]} bookmarks={[]} assets={{}} highlight={null} sourceCard={null}
        resourceTotal={101} resourceNextCursor={props.nextCursor} onMoreResources={onMore} onSearchResources={() => {}}
        onBackToNote={() => {}} onRepair={() => {}} labelsExtra={paneLabelsExtra} labels={paneLabels}
        onImportBook={() => {}} onOpen={onOpen} onSearch={() => {}} onJump={() => {}} onProgress={() => {}}
        onNote={() => {}} onMore={() => {}} onPart={() => {}} onStyle={() => {}} onBookmark={() => {}}
        onRemoveBookmark={() => {}} onOpenBookmark={() => {}}
      />
    );
    const { rerender } = render(pane({ resources: first, nextCursor: "cursor-1" }));
    expect(screen.getByTestId("reading-resource-total").textContent).toContain("101");
    fireEvent.click(screen.getByTestId("reading-resources-more"));
    expect(onMore).toHaveBeenCalledTimes(1);
    rerender(pane({ resources: [...first, { id: "res_101", title: "书 101" }], nextCursor: null }));
    expect(screen.queryByTestId("reading-resources-more")).toBeNull();
    fireEvent.click(screen.getByTestId("open-res_101"));
    expect(onOpen).toHaveBeenCalledWith("res_101");
  });
});

describe("M1b b7 whole-library paging", () => {
  it("pages every resource, finds the oldest by title and opens it", async () => {
    const ctx = await startApp();
    try {
      const db = ctx.app.store.sqlite;
      const resource = db.prepare("INSERT INTO resources(id,work_id,kind,title,aliases_json,created_at) VALUES (?,NULL,'novel',?,'[]',?)");
      const revision = db.prepare("INSERT INTO resource_revisions(id,resource_id,fingerprint,parser_version,payload_json,created_at) VALUES (?,?,?,'synthetic',?,?)");
      db.exec("BEGIN");
      for (let index = 0; index < 101; index += 1) {
        const date = new Date(Date.UTC(2020, 0, 1) + index * 1000).toISOString();
        resource.run(`res_a7_${index}`, `合成书 ${index}`, date);
        revision.run(`rev_a7_${index}`, `res_a7_${index}`, `fp_a7_${index}`, JSON.stringify({ normalized: `合成正文 ${index}` }), date);
      }
      db.exec("COMMIT");
      const inventory = await command(ctx, "inventory.overview", {}) as { totals: { resource: { count: number } }; pagination: { resource: { total: number; listed: number; nextCursor: string | null } } };
      expect(inventory.totals.resource.count).toBe(101);
      expect(inventory.pagination.resource).toMatchObject({ total: 101, listed: 100 });
      expect(inventory.pagination.resource.nextCursor).toBeTruthy();
      const workspace = await command(ctx, "workspace.get", {}) as { resources: unknown[]; resourcePage: { total: number; listed: number; nextCursor: string | null } };
      expect(workspace.resources).toHaveLength(100);
      expect(workspace.resourcePage).toMatchObject({ total: 101, listed: 100 });
      expect(workspace.resourcePage.nextCursor).toBeTruthy();
      // Follow the cursors to the end: the oldest row must be reachable and openable.
      const page1 = await command(ctx, "library.list", { limit: 50 }) as { items: Array<{ id: string }>; total: number; nextCursor: string | null };
      expect(page1.total).toBe(101);
      const page2 = await command(ctx, "library.list", { limit: 50, cursor: page1.nextCursor! }) as { items: Array<{ id: string }>; nextCursor: string | null };
      const page3 = await command(ctx, "library.list", { limit: 50, cursor: page2.nextCursor! }) as { items: Array<{ id: string }>; nextCursor: string | null };
      expect(page3.items.map((item) => item.id)).toEqual(["res_a7_0"]);
      expect(page3.nextCursor).toBeNull();
      const search = await command(ctx, "library.list", { query: "合成书 0" }) as { total: number; items: Array<{ id: string }> };
      expect(search.total).toBe(1);
      expect(search.items[0]?.id).toBe("res_a7_0");
      const opened = await command(ctx, "library.getResource", { resourceId: "res_a7_0" }) as { title: string };
      expect(opened.title).toBe("合成书 0");
      const bad = await ctx.app.call(ctx.actor, { commandId: "library.list", idempotencyKey: crypto.randomUUID(), input: { cursor: "not-a-cursor" } }, ctx.grant.handle);
      expect(bad.status).toBe("error");
      expect((bad.error as { code?: string }).code).toBe("VALIDATION_ERROR");
    } finally { ctx.app.close(); }
  });
});

describe("M1b b7 hybrid package decisions", () => {
  it("keeps a skipped note's source anchor while the resource is duplicated", async () => {
    const ctx = await startApp();
    try {
      const { book, note } = await libraryWithNote(ctx);
      const dir = tempProfile();
      const manifest = exportLibraryPackage(ctx.app.store, dir);
      const db = ctx.app.store.sqlite;
      const anchorId = manifest.anchors[0]!.id;
      const before = db.prepare("SELECT resource_id, resource_revision_id, locator_json FROM anchors WHERE id=?").get(anchorId);
      importLibraryPackageResolved(ctx.app.store, dir, { strategy: "replace", decisions: [
        { kind: "resource", id: String(book.resourceId), action: "duplicate" },
        { kind: "object", id: String(note.objectId), action: "skip" },
      ] });
      const after = db.prepare("SELECT resource_id, resource_revision_id, locator_json FROM anchors WHERE id=?").get(anchorId);
      expect(after).toEqual(before);
    } finally { ctx.app.close(); }
  });

  it("keeps the copied excerpt's provenance when the revision is skipped under a duplicated resource", async () => {
    const ctx = await startApp();
    try {
      const { book, note } = await libraryWithNote(ctx);
      const dir = tempProfile();
      exportLibraryPackage(ctx.app.store, dir);
      importLibraryPackageResolved(ctx.app.store, dir, { strategy: "duplicate", decisions: [
        { kind: "resource_revision", id: String(book.revisionId), action: "skip" },
      ] });
      const db = ctx.app.store.sqlite;
      const copy = db.prepare("SELECT id, payload_json FROM content_objects WHERE type='notes.document' AND id<>?").get(note.objectId) as { id: string; payload_json: string };
      const blocks = (JSON.parse(copy.payload_json) as { blocks: Array<{ text?: string; anchorId?: string }> }).blocks;
      const anchorId = blocks.find((block) => block.anchorId)?.anchorId;
      const refs = db.prepare("SELECT to_id FROM refs WHERE from_object_id=? AND to_kind='anchor'").all(copy.id) as Array<{ to_id: string }>;
      expect(blocks.some((block) => block.text === "甲乙丙丁")).toBe(true);
      expect(anchorId).toBeTruthy();
      expect(refs.length).toBeGreaterThan(0);
      expect(anchorId).toBe(refs[0]!.to_id);
      // The provenance resolves: the copy's anchor names the kept local revision of the original resource.
      const anchor = db.prepare("SELECT resource_id, resource_revision_id FROM anchors WHERE id=?").get(anchorId) as { resource_id: string; resource_revision_id: string };
      expect(anchor.resource_id).toBe(String(book.resourceId));
      expect(anchor.resource_revision_id).toBe(String(book.revisionId));
      const opened = await command(ctx, "notes.openSource", { objectId: copy.id }) as { status: string };
      expect(opened.status).toBe("resolved");
    } finally { ctx.app.close(); }
  });

  it("never re-points an anchor a surviving local note still references, even under replace", async () => {
    const ctx = await startApp();
    try {
      const { note } = await libraryWithNote(ctx);
      const dir = tempProfile();
      const manifest = exportLibraryPackage(ctx.app.store, dir);
      const packageAnchorId = manifest.anchors[0]!.id;
      // A local note created after the export is not in the package; re-point its block onto the
      // package's anchor so a replace would silently retarget the source behind the surviving ref.
      const localNote = await command(ctx, "notes.create", {
        title: "本地笔记", text: "本地评论",
        locator: { kind: "text", partId: "body", representationId: "none", normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 2 }, quote: { exact: "本地" } },
      });
      const db = ctx.app.store.sqlite;
      const payload = JSON.parse((db.prepare("SELECT payload_json FROM content_objects WHERE id=?").get(localNote.objectId) as { payload_json: string }).payload_json) as { blocks: Array<{ anchorId?: string }> };
      payload.blocks[0]!.anchorId = packageAnchorId;
      db.prepare("UPDATE content_objects SET payload_json=? WHERE id=?").run(JSON.stringify(payload), localNote.objectId);
      const before = db.prepare("SELECT resource_id, resource_revision_id, locator_json FROM anchors WHERE id=?").get(packageAnchorId);
      importLibraryPackageResolved(ctx.app.store, dir, { strategy: "replace" });
      const after = db.prepare("SELECT resource_id, resource_revision_id, locator_json FROM anchors WHERE id=?").get(packageAnchorId);
      expect(after).toEqual(before);
      const opened = await command(ctx, "notes.openSource", { objectId: String(note.objectId) }) as { status: string };
      expect(opened.status).toBe("resolved");
    } finally { ctx.app.close(); }
  });

  it("writes progress of a kept revision under its original resource while the resource is duplicated", async () => {
    const ctx = await startApp();
    try {
      const { book } = await libraryWithNote(ctx);
      await command(ctx, "progress.set", {
        resourceId: book.resourceId, resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 2 }, quote: { exact: "甲乙" } },
      });
      const dir = tempProfile();
      exportLibraryPackage(ctx.app.store, dir);
      importLibraryPackageResolved(ctx.app.store, dir, { strategy: "duplicate", decisions: [
        { kind: "resource_revision", id: String(book.revisionId), action: "skip" },
      ] });
      const rows = ctx.app.store.sqlite.prepare("SELECT resource_id, resource_revision_id FROM progress").all() as Array<{ resource_id: string; resource_revision_id: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ resource_id: String(book.resourceId), resource_revision_id: String(book.revisionId) });
    } finally { ctx.app.close(); }
  });
});
