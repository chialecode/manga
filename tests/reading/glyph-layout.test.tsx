/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { cleanup, render, screen } from "@testing-library/react";
import { parsePdfBytes } from "@manga/app-core";
import { exportLibraryPackage, importLibraryPackageResolved } from "../../packages/app-core/src/domain/library-package.ts";
import { startApp, tempProfile } from "../helpers/app.ts";
import { ReadingPane, type ReadingDocument } from "../../apps/desktop/src/renderer/reading.tsx";
import { renderPdfPage, samePaintedRegion } from "../helpers/pdf-pixels.ts";

type Ctx = Awaited<ReturnType<typeof startApp>>;

async function command(ctx: Ctx, commandId: string, input: Record<string, unknown>) {
  const result = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: crypto.randomUUID(), input }, ctx.grant.handle);
  expect(result.status, result.error?.message).toBe("ok");
  return result.value as Record<string, unknown>;
}

/** A classic-xref PDF with one page, the given content stream, a font dict and extra indirect objects. */
function pdf(content: string, font?: string, extra: string[] = []): Uint8Array {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
    font ?? "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
    ...extra,
  ];
  let source = "%PDF-1.4\n";
  const offsets: number[] = [];
  bodies.forEach((body, index) => { offsets.push(Buffer.byteLength(source, "ascii")); source += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(source, "ascii");
  source += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer << /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(source, "ascii"));
}

// Identity-H makes character codes equal CIDs; ToUnicode independently supplies A/B/C so the /W
// assertions never depend on a predefined CMap's Unicode-to-CID table.
const cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Synthetic def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0020> <0043> <0020> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end";
const cidFont = "<< /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /Identity-H /ToUnicode 7 0 R /DescendantFonts [6 0 R] >>";
const cidExtra = (widths: string): string[] => [
  `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ${widths} >>`,
  `<< /Length ${Buffer.byteLength(cmap, "ascii")} >>\nstream\n${cmap}\nendstream`,
];

type TextRun = { k: "t"; x: number; y: number; t: string; w?: number; gx?: number[] };
function textRuns(parsed: ReturnType<typeof parsePdfBytes>, part = 0): TextRun[] {
  return (parsed.parts[part]!.render?.items ?? []).filter((item): item is TextRun => item.k === "t");
}

/**
 * One equivalence class: the same content drawn as one joined Tj string and as one Tj per glyph must
 * place every glyph at the same origin, whichever width source the font uses.
 */
const GLYPH_VARIANTS: Array<{ name: string; font?: string; extra?: string[]; joined: string; split: string; expected: number[] }> = [
  {
    name: "direct simple widths [1000 100 100]",
    font: "<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding /WinAnsiEncoding /FirstChar 65 /LastChar 67 /Widths [1000 100 100] >>",
    joined: "(ABC) Tj", split: "(A) Tj (B) Tj (C) Tj", expected: [50, 60, 61],
  },
  {
    name: "indirect simple widths object",
    font: "<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding /WinAnsiEncoding /FirstChar 65 /LastChar 67 /Widths 6 0 R >>",
    extra: ["[1000 100 100]"],
    joined: "(ABC) Tj", split: "(A) Tj (B) Tj (C) Tj", expected: [50, 60, 61],
  },
  {
    name: "CID /W per-code array rows",
    font: cidFont, extra: cidExtra("/DW 1000 /W [65 [278 556] 67 67 750]"),
    joined: "<004100420043> Tj", split: "<0041> Tj <0042> Tj <0043> Tj", expected: [50, 52.78, 58.34],
  },
  {
    name: "CID /W start/end range rows",
    font: cidFont, extra: cidExtra("/DW 1000 /W [65 67 500]"),
    joined: "<004100420043> Tj", split: "<0041> Tj <0042> Tj <0043> Tj", expected: [50, 55, 60],
  },
  {
    name: "CID /W indirect with mixed row forms",
    font: cidFont, extra: [...cidExtra("/DW 750 /W 8 0 R"), "[65 [278 556] 67 67 750]"],
    joined: "<004100420043> Tj", split: "<0041> Tj <0042> Tj <0043> Tj", expected: [50, 52.78, 58.34],
  },
  {
    name: "char spacing on every glyph and word spacing on the space",
    joined: "2 Tc 10 Tw (A A) Tj", split: "2 Tc 10 Tw (A) Tj ( ) Tj (A) Tj", expected: [50, 58, 76],
  },
  {
    name: "horizontal scale applied to every glyph advance",
    joined: "/F1 20 Tf 50 Tz (HELLO) Tj", split: "/F1 20 Tf 50 Tz (H) Tj (E) Tj (L) Tj (L) Tj (O) Tj", expected: [50, 56, 62, 68, 74],
  },
];

describe("M1b b9-rework glyph-level layout matrix", () => {
  it.each(GLYPH_VARIANTS)("$name draws joined and split Tj sequences at identical glyph origins", async (variant) => {
    const bytes = pdf(
      `BT /F1 10 Tf 1 0 0 1 50 320 Tm ${variant.joined} 1 0 0 1 50 280 Tm ${variant.split} ET`,
      variant.font, variant.extra ?? [],
    );
    const parsed = await parsePdfBytes(bytes);
    expect((parsed.parts[0]?.normalized ?? "").replaceAll("\n", "").length).toBeGreaterThan(0);
    const { ctx } = await renderPdfPage(bytes, 4);
    expect(samePaintedRegion(ctx, [160, 240, 400, 120], [160, 400, 400, 120])).toBe(true);
  });

  it("keeps integer glyph origins exact so visible positions never drift", async () => {
    const bytes = pdf(
      "BT /F1 10 Tf 1 0 0 1 50 320 Tm (ABC) Tj 1 0 0 1 50 280 Tm (A) Tj (B) Tj (C) Tj ET",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding /WinAnsiEncoding /FirstChar 65 /LastChar 67 /Widths [1000 100 100] >>",
    );
    const parsed = await parsePdfBytes(bytes);
    const runs = parsed.parts[0]?.textRuns ?? [];
    expect(runs.map((run) => run.width)).toEqual([12, 12]);
    const { ctx } = await renderPdfPage(bytes, 4);
    expect(samePaintedRegion(ctx, [160, 240, 400, 120], [160, 400, 400, 120])).toBe(true);
  });

  it("treats a declared zero-width default as a real advance and still names the glyph origin", async () => {
    const parsed = await parsePdfBytes(pdf("BT /F1 10 Tf 1 0 0 1 50 320 Tm <0041> Tj <0042> Tj ET", cidFont, cidExtra("/DW 0")));
    expect(parsed.parts[0]!.normalized).toBe("AB");
    const runs = parsed.parts[0]!.textRuns ?? [];
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run) => run.x === 50)).toBe(true);
    expect(runs.reduce((sum, run) => sum + (run.width ?? 0), 0)).toBe(0);
  });

  it("falls back to the spec default only when /DW is absent", async () => {
    const parsed = await parsePdfBytes(pdf("BT /F1 10 Tf 1 0 0 1 50 320 Tm <0041> Tj <0042> Tj ET", cidFont, cidExtra("")));
    const runs = parsed.parts[0]!.textRuns ?? [];
    expect(parsed.parts[0]!.normalized).toBe("AB");
    expect((runs[0]?.width ?? 0)).toBeGreaterThan(0);
  });

  it("leaves origins unset when the font declares no widths at all", async () => {
    const parsed = await parsePdfBytes(pdf("BT /F1 20 Tf 1 0 0 1 50 320 Tm (HELLO) Tj ET",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding /WinAnsiEncoding >>"));
    expect(parsed.parts[0]!.normalized).toBe("HELLO");
    expect(parsed.parts[0]!.render).toBeUndefined();
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

const glyphDoc = {
  resourceId: "res_g", revisionId: "rev_g", title: "字形书", format: "pdf", warnings: [], toc: [],
  parts: [{ id: "page-1", kind: "text", length: 5, textLayer: true, imageCount: 0, index: 0, hasRender: true }],
  slice: {
    partId: "page-1", text: "HELLO", start: 0, end: 5, kind: "text", textLayer: true,
    render: {
      w: 400, h: 400,
      items: [
        { k: "t", x: 50, y: 320, s: 20, f: "mono", t: "HELLO", c: "#111111", o: 0, w: 30, gx: [50, 56, 62, 68, 74] },
        { k: "t", x: 80, y: 320, s: 20, f: "mono", t: "WORLD", c: "#111111", o: 5, w: 30 },
      ],
    },
  },
  progress: null, readRanges: [], assets: [], source: { available: true, hosted: false }, authorStyle: null,
} as unknown as ReadingDocument;

const zeroWidthDoc = {
  ...glyphDoc,
  slice: {
    ...glyphDoc.slice,
    render: { w: 400, h: 400, items: [{ k: "t", x: 50, y: 320, s: 20, f: "mono", t: "AB", c: "#111111", o: 0, w: 0, gx: [50, 50] }] },
  },
} as unknown as ReadingDocument;

const baseStyle = { measurePx: 680, fontSizePx: 18, fontFamily: "sans" as const, lineHeight: 1.7, marginPx: 24, theme: "white" };

describe("M1b b9-rework page view draws per-glyph origins", () => {
  afterEach(() => cleanup());
  const renderPane = (document: ReadingDocument) => render(<ReadingPane
    resources={[]} document={document} style={baseStyle} hits={[]} bookmarks={[]} assets={{}}
    highlight={null} sourceCard={null} onBackToNote={() => {}} onRepair={() => {}} labelsExtra={paneLabelsExtra}
    labels={paneLabels} onImportBook={() => {}} onOpen={() => {}} onSearch={() => {}} onJump={() => {}}
    onProgress={() => {}} onNote={() => {}} onMore={() => {}} onPart={() => {}} onStyle={() => {}}
    onBookmark={() => {}} onRemoveBookmark={() => {}}
  />);

  it("positions every glyph with the modelled origin list instead of stretching the whole string", () => {
    renderPane(glyphDoc);
    expect(screen.queryByTestId("page-run-0")).toBeNull();
    expect(document.querySelector("text")).toBeNull();
    expect(screen.getByTestId("reading-body").textContent).toContain("HELLO");
    expect(screen.getByTestId("reading-original-missing")).toBeTruthy();
  });

  it("draws a known zero-width run at its origin without constraining its length", () => {
    renderPane(zeroWidthDoc);
    expect(document.querySelector("[textLength]")).toBeNull();
    expect(screen.getByTestId("reading-original-missing")).toBeTruthy();
  });
});

/** One F-09 scenario: an explicitly skipped reference row versus a note the import replaces. */
type SkipVariant = {
  name: string;
  /** Action for the anchor the kept reference names. */
  anchor: "replace" | "duplicate";
  /** Local references added before the export, so the package and the library can really diverge. */
  extraRefs?: number;
  /** The local note the import replaces: its own ref row must survive untouched. */
  expectKept: boolean;
};

const SKIP_VARIANTS: SkipVariant[] = [
  { name: "anchor replace", anchor: "replace", expectKept: true },
  { name: "a second block row that follows the package", anchor: "replace", extraRefs: 1, expectKept: true },
];

describe("M1b b9-rework explicit ref skip versus object replacement", () => {
  it.each(SKIP_VARIANTS)("$name keeps an explicitly skipped reference row intact when its note is replaced", async (variant) => {
    const ctx = await startApp();
    try {
      const book = await command(ctx, "library.importDocument", { title: "跳过来源", format: "txt", bytes: [...new TextEncoder().encode("来源正文。第二段。")] });
      const note = await command(ctx, "notes.create", {
        title: "合成笔记", text: "评论", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "来源正文" } },
      });
      const db = ctx.app.store.sqlite;
      const anchorId = String(db.prepare("SELECT to_id AS id FROM refs WHERE from_object_id=?").get(note.objectId)?.id);
      for (let index = 0; index < (variant.extraRefs ?? 0); index += 1) {
        db.prepare("INSERT INTO refs(id, from_object_id, from_block_id, to_kind, to_id, mode, instance_layout_json, created_at) VALUES (?,?,?,?,?,?,?,?)")
          .run(`ref_extra_${index}`, String(note.objectId), "b1", "anchor", anchorId, "live", JSON.stringify({ panel: index }), new Date().toISOString());
      }
      const dir = tempProfile();
      const manifest = exportLibraryPackage(ctx.app.store, dir);
      expect(manifest.refs.length).toBe(1 + (variant.extraRefs ?? 0));
      // The library diverges from the package after the export: each row gets its own layout and a
      // distinct mode, which is exactly what an explicit skip must keep when the note is replaced.
      // The note's own row (a random UUID id) comes first and the added rows follow; ordering by id
      // alone would put ref_extra_0 first whenever the UUID starts with "f".
      const order = "ORDER BY id LIKE 'ref_extra_%', id";
      const rows = db.prepare(`SELECT id, from_block_id AS block FROM refs WHERE from_object_id=? ${order}`).all(note.objectId) as Array<{ id: string; block: string }>;
      rows.forEach((row, index) => db.prepare("UPDATE refs SET instance_layout_json=?, mode=? WHERE id=?")
        .run(JSON.stringify({ reviewMarker: `local-after-export-${index}` }), index === 0 ? "snapshot" : "live", row.id));
      const before = db.prepare(`SELECT * FROM refs WHERE from_object_id=? ${order}`).all(note.objectId);
      const snapshot = () => JSON.stringify(["resources", "resource_revisions", "anchors", "refs", "content_objects", "object_revisions", "text_fragments"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
      const beforeSnapshot = snapshot();
      importLibraryPackageResolved(ctx.app.store, dir, {
        strategy: "replace",
        decisions: [
          { kind: "object", id: String(note.objectId), action: "replace" },
          { kind: "anchor", id: anchorId, action: variant.anchor },
          { kind: "ref", id: rows[0]!.id, action: "skip" },
        ],
      });
      const after = db.prepare("SELECT * FROM refs WHERE from_object_id=? ORDER BY id").all(note.objectId) as Array<Record<string, unknown>>;
      const kept = after.find((row) => row.id === rows[0]!.id);
      // The explicitly skipped row survives with every local field: block, target, mode and layout.
      expect(kept).toEqual(before[0]);
      // Derivation only fills missing edges, so the kept block does not gain a second derived ref.
      expect(after.filter((row) => row.from_block_id === rows[0]!.block)).toHaveLength(1);
      if (variant.extraRefs) {
        // A second block's row without an explicit skip follows the package row again (replace).
        const replaced = after.find((row) => row.id === rows[1]!.id);
        const packageRow = manifest.refs.find((row) => row.id === rows[1]!.id)!;
        expect(replaced?.from_block_id).toBe(packageRow.from_block_id);
        expect(replaced?.to_id).toBe(anchorId);
        expect(JSON.parse(String(replaced?.instance_layout_json))).toEqual(JSON.parse(String(packageRow.instance_layout_json)));
      }
      const opened = await command(ctx, "notes.openSource", { objectId: String(note.objectId) }) as { status: string; card?: { status: string } };
      expect(opened.status).toBe("resolved");
      expect(opened.card?.status).toBe("resolved");
      expect(snapshot()).not.toBe(beforeSnapshot);
      void variant.expectKept;
    } finally { ctx.app.close(); }
  });

  it("rejects object replace plus ref skip plus anchor duplicate before any content write", async () => {
    const ctx = await startApp();
    try {
      const book = await command(ctx, "library.importDocument", { title: "冲突来源", format: "txt", bytes: [...new TextEncoder().encode("来源正文。第二段。")] });
      const note = await command(ctx, "notes.create", {
        title: "合成笔记", text: "评论", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "来源正文" } },
      });
      const db = ctx.app.store.sqlite;
      const dir = tempProfile();
      const manifest = exportLibraryPackage(ctx.app.store, dir);
      const ref = manifest.refs[0]!;
      const snapshot = () => JSON.stringify(["resources", "resource_revisions", "anchors", "refs", "content_objects", "object_revisions", "text_fragments"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
      const before = snapshot();
      let error: unknown;
      try {
        importLibraryPackageResolved(ctx.app.store, dir, {
          strategy: "replace",
          decisions: [
            { kind: "object", id: String(note.objectId), action: "replace" },
            { kind: "ref", id: ref.id, action: "skip" },
            { kind: "anchor", id: ref.to_id, action: "duplicate" },
            { kind: "resource", id: String(book.resourceId), action: "replace" },
            { kind: "resource_revision", id: String(book.revisionId), action: "replace" },
          ],
        });
      } catch (thrown) { error = thrown; }
      expect((error as { code?: string })?.code).toBe("PUBLISH_CONFLICT");
      expect(snapshot()).toBe(before);
    } finally { ctx.app.close(); }
  });

  it.each([
    {
      name: "duplicate anchor conflicts",
      outcome: "conflict" as const,
      resource: "replace" as const,
      anchor: "duplicate" as const,
    },
    {
      name: "duplicate resource conflicts",
      outcome: "conflict" as const,
      resource: "duplicate" as const,
      anchor: "duplicate" as const,
    },
    {
      name: "replaced anchor stays",
      outcome: "consistent" as const,
      resource: "duplicate" as const,
      anchor: "replace" as const,
    },
  ])("$name", async (variant) => {
    const ctx = await startApp();
    try {
      const book = await command(ctx, "library.importDocument", { title: "冲突来源", format: "txt", bytes: [...new TextEncoder().encode("来源正文。第二段。")] });
      const note = await command(ctx, "notes.create", {
        title: "合成笔记", text: "评论", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "来源正文" } },
      });
      const db = ctx.app.store.sqlite;
      const dir = tempProfile();
      const manifest = exportLibraryPackage(ctx.app.store, dir);
      const ref = manifest.refs[0]!;
      const tables = () => JSON.stringify(["resources", "resource_revisions", "anchors", "refs", "content_objects", "object_revisions", "text_fragments"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
      const attachments = () => {
        const root = ctx.app.store.attachmentsDir;
        if (!fs.existsSync(root)) return [];
        return fs.readdirSync(root).sort().map((name) => createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex"));
      };
      const beforeTables = tables();
      const beforeFiles = attachments();
      let error: unknown;
      try {
        importLibraryPackageResolved(ctx.app.store, dir, {
          strategy: "replace",
          decisions: [
            { kind: "object", id: String(note.objectId), action: "replace" },
            { kind: "ref", id: ref.id, action: "skip" },
            { kind: "anchor", id: ref.to_id, action: variant.anchor },
            { kind: "resource", id: String(book.resourceId), action: variant.resource },
            { kind: "resource_revision", id: String(book.revisionId), action: "replace" },
          ],
        });
      } catch (thrown) { error = thrown; }
      if (variant.outcome === "conflict") {
        expect((error as { code?: string })?.code).toBe("PUBLISH_CONFLICT");
        expect(tables()).toBe(beforeTables);
        expect(attachments()).toEqual(beforeFiles);
        return;
      }
      expect(error).toBeUndefined();
      const kept = db.prepare("SELECT to_id AS toId FROM refs WHERE id=?").get(ref.id) as { toId: string };
      expect(kept.toId).toBe(ref.to_id);
      const payload = JSON.parse(String((db.prepare("SELECT payload_json AS payload FROM content_objects WHERE id=?").get(note.objectId) as { payload: string }).payload)) as { blocks?: Array<{ anchorId?: string }> };
      expect((payload.blocks ?? []).filter((block) => block.anchorId).every((block) => block.anchorId === kept.toId)).toBe(true);
      const history = db.prepare("SELECT payload_json AS payload FROM object_revisions WHERE object_id=?").all(note.objectId) as Array<{ payload: string }>;
      expect(history.length).toBeGreaterThan(0);
      for (const row of history) {
        const blocks = (JSON.parse(row.payload) as { blocks?: Array<{ anchorId?: string }> }).blocks ?? [];
        expect(blocks.filter((block) => block.anchorId).every((block) => block.anchorId === kept.toId)).toBe(true);
      }
      const anchor = db.prepare("SELECT resource_id AS resource, resource_revision_id AS revision FROM anchors WHERE id=?").get(kept.toId) as { resource: string; revision: string };
      const revision = db.prepare("SELECT resource_id AS resource FROM resource_revisions WHERE id=?").get(anchor.revision) as { resource: string };
      expect(anchor.resource).toBe(revision.resource);
      expect(anchor.resource).toBe(book.resourceId);
      const indexed = db.prepare("SELECT resource_id AS resource FROM text_fragments WHERE object_id=?").all(note.objectId) as Array<{ resource: string }>;
      expect(indexed.length).toBeGreaterThan(0);
      expect(indexed.every((row) => row.resource === anchor.resource)).toBe(true);
      const opened = await command(ctx, "notes.openSource", { objectId: String(note.objectId) }) as { status: string; card?: { status: string }; resourceId?: string };
      expect(opened.status).toBe("resolved");
      expect(opened.card?.status).toBe("resolved");
      expect(opened.resourceId).toBe(book.resourceId);
    } finally { ctx.app.close(); }
  });

  it("rejects a skip whose block no longer exists in the replaced note and rolls everything back", async () => {
    const ctx = await startApp();
    try {
      const book = await command(ctx, "library.importDocument", { title: "拒绝来源", format: "txt", bytes: [...new TextEncoder().encode("拒绝正文。")] });
      const note = await command(ctx, "notes.create", {
        title: "合成笔记", text: "评论", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "拒绝正文" } },
      });
      const db = ctx.app.store.sqlite;
      const dir = tempProfile();
      exportLibraryPackage(ctx.app.store, dir);
      // The local row's block was renamed after the export; the replaced payload has no such block,
      // so keeping the row would leave a reference to a block the note does not have.
      db.prepare("UPDATE refs SET from_block_id='renamed-away', instance_layout_json=? WHERE from_object_id=?").run(JSON.stringify({ reviewMarker: "local" }), note.objectId);
      const snapshot = () => JSON.stringify(["resources", "resource_revisions", "anchors", "refs", "content_objects", "object_revisions", "text_fragments"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
      const before = snapshot();
      let error: unknown;
      try {
        importLibraryPackageResolved(ctx.app.store, dir, {
          strategy: "replace",
          decisions: [
            { kind: "object", id: String(note.objectId), action: "replace" },
            { kind: "ref", id: String(db.prepare("SELECT id FROM refs WHERE from_object_id=?").get(note.objectId)?.id), action: "skip" },
          ],
        });
      } catch (thrown) { error = thrown; }
      expect((error as { code?: string })?.code).toBe("PUBLISH_CONFLICT");
      expect(snapshot()).toBe(before);
    } finally { ctx.app.close(); }
  });

  it("rejects a skip whose target anchor is gone and rolls everything back", async () => {
    const ctx = await startApp();
    try {
      const book = await command(ctx, "library.importDocument", { title: "悬空来源", format: "txt", bytes: [...new TextEncoder().encode("悬空正文。")] });
      const note = await command(ctx, "notes.create", {
        title: "合成笔记", text: "评论", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "悬空正文" } },
      });
      const db = ctx.app.store.sqlite;
      const dir = tempProfile();
      exportLibraryPackage(ctx.app.store, dir);
      // The local row was left dangling after the export; the import cannot back a kept reference
      // with a target that exists nowhere, so the whole combination is refused before any write.
      db.prepare("UPDATE refs SET to_id='anc_ghost', instance_layout_json=? WHERE from_object_id=?").run(JSON.stringify({ reviewMarker: "local" }), note.objectId);
      const snapshot = () => JSON.stringify(["resources", "resource_revisions", "anchors", "refs", "content_objects", "object_revisions", "text_fragments"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
      const before = snapshot();
      let error: unknown;
      try {
        importLibraryPackageResolved(ctx.app.store, dir, {
          strategy: "replace",
          decisions: [
            { kind: "object", id: String(note.objectId), action: "replace" },
            { kind: "ref", id: String(db.prepare("SELECT id FROM refs WHERE from_object_id=?").get(note.objectId)?.id), action: "skip" },
          ],
        });
      } catch (thrown) { error = thrown; }
      expect((error as { code?: string })?.code).toBe("PUBLISH_CONFLICT");
      expect(snapshot()).toBe(before);
    } finally { ctx.app.close(); }
  });

  it("keeps a diverged skipped row when the note itself is only duplicated", async () => {
    const ctx = await startApp();
    try {
      const book = await command(ctx, "library.importDocument", { title: "对照来源", format: "txt", bytes: [...new TextEncoder().encode("对照正文。")] });
      const note = await command(ctx, "notes.create", {
        title: "合成笔记", text: "评论", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "对照正文" } },
      });
      const db = ctx.app.store.sqlite;
      const dir = tempProfile();
      exportLibraryPackage(ctx.app.store, dir);
      db.prepare("UPDATE refs SET instance_layout_json=?, mode='snapshot' WHERE from_object_id=?").run(JSON.stringify({ reviewMarker: "local" }), note.objectId);
      const before = db.prepare("SELECT * FROM refs WHERE from_object_id=?").all(note.objectId);
      importLibraryPackageResolved(ctx.app.store, dir, {
        strategy: "duplicate",
        decisions: [
          { kind: "resource", id: String(book.resourceId), action: "duplicate" },
          { kind: "object", id: String(note.objectId), action: "duplicate" },
          { kind: "ref", id: String(db.prepare("SELECT id FROM refs WHERE from_object_id=?").get(note.objectId)?.id), action: "skip" },
        ],
      });
      expect(db.prepare("SELECT * FROM refs WHERE from_object_id=?").all(note.objectId)).toEqual(before);
      const opened = await command(ctx, "notes.openSource", { objectId: String(note.objectId) }) as { status: string; card?: { status: string } };
      expect(opened.status).toBe("resolved");
      expect(opened.card?.status).toBe("resolved");
    } finally { ctx.app.close(); }
  });
});
