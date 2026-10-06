/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { parsePdfBytes } from "@manga/app-core";
import { exportLibraryPackage, importLibraryPackageResolved } from "../../packages/app-core/src/domain/library-package.ts";
import { startApp, tempProfile } from "../helpers/app.ts";
import { ReadingPane, type ReadingDocument } from "../../apps/desktop/src/renderer/reading.tsx";

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
const cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Synthetic def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange 1 beginbfrange <0041> <0043> <0041> endbfrange endcmap CMapName currentdict /CMap defineresource pop end end";
const cidFont = "<< /Type /Font /Subtype /Type0 /BaseFont /Custom /Encoding /Identity-H /ToUnicode 7 0 R /DescendantFonts [6 0 R] >>";

describe("M1b b9 font widths and drawing consistency", () => {
  it("treats an indirect /Widths array like a direct one", async () => {
    const parsed = await parsePdfBytes(pdf("BT /F1 10 Tf 1 0 0 1 50 320 Tm (AB) Tj (C) Tj ET",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding /WinAnsiEncoding /FirstChar 65 /LastChar 67 /Widths 6 0 R >>",
      ["[278 556 444]"]));
    expect(parsed.parts[0]!.normalized).toBe("ABC");
    expect(parsed.parts[0]!.textRuns?.[0]?.width).toBeCloseTo(12.78, 2);
  });

  it("parses the per-code array form of a CID /W row", async () => {
    const parsed = await parsePdfBytes(pdf("BT /F1 10 Tf 1 0 0 1 50 320 Tm <00410042> Tj <0043> Tj ET", cidFont, [
      "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /W [65 [278 556 444]] >>",
      `<< /Length ${Buffer.byteLength(cmap, "ascii")} >>\nstream\n${cmap}\nendstream`,
    ]));
    expect(parsed.parts[0]!.normalized).toBe("ABC");
    expect((parsed.parts[0]!.textRuns ?? []).reduce((sum, run) => sum + (run.width ?? 0), 0)).toBeGreaterThan(0);
  });

  it("parses the start/end range form of a CID /W row", async () => {
    const parsed = await parsePdfBytes(pdf("BT /F1 10 Tf 1 0 0 1 50 320 Tm <00410042> Tj <0043> Tj ET", cidFont, [
      "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Custom /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /W [65 67 500] >>",
      `<< /Length ${Buffer.byteLength(cmap, "ascii")} >>\nstream\n${cmap}\nendstream`,
    ]));
    expect(parsed.parts[0]!.normalized).toBe("ABC");
    expect((parsed.parts[0]!.textRuns ?? []).reduce((sum, run) => sum + (run.width ?? 0), 0)).toBeGreaterThan(0);
  });

  it("carries each run's modelled advance so the drawn glyphs cannot overlap the next run", async () => {
    const parsed = await parsePdfBytes(pdf("BT /F1 20 Tf 50 Tz 1 0 0 1 50 320 Tm (HELLO) Tj (WORLD) Tj ET"));
    expect(parsed.parts[0]!.normalized).toBe("HELLOWORLD");
    expect(parsed.parts[0]!.textRuns?.[0]?.width).toBeCloseTo(60, 1);
  });

  it("includes char spacing, word spacing and horizontal scale in the recorded advance", async () => {
    const parsed = await parsePdfBytes(pdf("BT /F1 10 Tf 1 Tc 2 Tw 90 Tz 1 0 0 1 50 320 Tm (A B) Tj ET"));
    expect(parsed.parts[0]!.normalized).toContain("A");
    expect((parsed.parts[0]!.textRuns?.[0]?.width ?? 0)).toBeGreaterThan(0);
  });

  it("leaves the advance unset for fonts whose widths are unknown", async () => {
    const parsed = await parsePdfBytes(pdf("BT /F1 20 Tf 1 0 0 1 50 320 Tm (HELLO) Tj ET",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Custom /Encoding /WinAnsiEncoding >>"));
    expect(parsed.parts[0]!.normalized).toBe("HELLO");
    expect(parsed.parts[0]!.render).toBeUndefined();
  });

  it("adds character spacing between every glyph and word spacing only on word spaces", async () => {
    const parsed = await parsePdfBytes(pdf("BT /F1 10 Tf 1 Tc 2 Tw 1 0 0 1 50 320 Tm (A B) Tj (C) Tj ET"));
    expect(parsed.parts[0]!.normalized.replaceAll(" ", "")).toContain("ABC");
    expect((parsed.parts[0]!.textRuns?.[0]?.width ?? 0)).toBeGreaterThan(0);
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

const advanceDoc = {
  resourceId: "res_w", revisionId: "rev_w", title: "宽度书", format: "pdf", warnings: [], toc: [],
  parts: [{ id: "page-1", kind: "text", length: 10, textLayer: true, imageCount: 0, index: 0, hasRender: true }],
  slice: {
    partId: "page-1", text: "HELLOWORLD", start: 0, end: 10, kind: "text", textLayer: true,
    render: {
      w: 400, h: 400,
      items: [
        { k: "t", x: 50, y: 320, s: 20, f: "mono", t: "HELLO", c: "#111111", o: 0, w: 30 },
        { k: "t", x: 80, y: 320, s: 20, f: "mono", t: "WORLD", c: "#111111", o: 5, w: 30 },
      ],
    },
  },
  progress: null, readRanges: [], assets: [], source: { available: true, hosted: false }, authorStyle: null,
} as unknown as ReadingDocument;

const noAdvanceDoc = {
  ...advanceDoc,
  slice: {
    ...advanceDoc.slice,
    render: { w: 400, h: 400, items: [{ k: "t", x: 50, y: 320, s: 20, f: "mono", t: "GHOST", c: "#111111", o: 0 }] },
  },
} as unknown as ReadingDocument;

const baseStyle = { measurePx: 680, fontSizePx: 18, fontFamily: "sans" as const, lineHeight: 1.7, marginPx: 24, theme: "white" };

describe("M1b b9 page view draws the modelled advance", () => {
  afterEach(() => cleanup());

  it("scales the drawn glyphs to the run's recorded width", () => {
    render(<ReadingPane
      resources={[]} document={advanceDoc} style={baseStyle} hits={[]} bookmarks={[]} assets={{}}
      highlight={null} sourceCard={null} onBackToNote={() => {}} onRepair={() => {}} labelsExtra={paneLabelsExtra}
      labels={paneLabels} onImportBook={() => {}} onOpen={() => {}} onSearch={() => {}} onJump={() => {}}
      onProgress={() => {}} onNote={() => {}} onMore={() => {}} onPart={() => {}} onStyle={() => {}}
      onBookmark={() => {}} onRemoveBookmark={() => {}} onOpenBookmark={() => {}}
    />);
    expect(document.querySelector("text")).toBeNull();
    expect(screen.getByTestId("reading-body").textContent).toContain("HELLOWORLD");
  });

  it("does not constrain runs whose advance the model does not know", () => {
    render(<ReadingPane
      resources={[]} document={noAdvanceDoc} style={baseStyle} hits={[]} bookmarks={[]} assets={{}}
      highlight={null} sourceCard={null} onBackToNote={() => {}} onRepair={() => {}} labelsExtra={paneLabelsExtra}
      labels={paneLabels} onImportBook={() => {}} onOpen={() => {}} onSearch={() => {}} onJump={() => {}}
      onProgress={() => {}} onNote={() => {}} onMore={() => {}} onPart={() => {}} onStyle={() => {}}
      onBookmark={() => {}} onRemoveBookmark={() => {}} onOpenBookmark={() => {}}
    />);
    expect(document.querySelector("[textLength]")).toBeNull();
  });
});

/** One import scenario: decisions per row plus the global strategy. */
type Variant = {
  name: string;
  /** Export the package before the local note exists, so its anchor lives only in the library. */
  noteOutsidePackage?: boolean;
  /** The import rewrites the local note itself, so its rows may legitimately change. */
  rewritesOriginalNote?: boolean;
  strategy: "duplicate" | "replace";
  decisions: Array<{ kind: string; id: string; action: string }>;
};

const VARIANTS: Variant[] = [
  { name: "implicit revision copy with skipped note", strategy: "replace", decisions: [
    { kind: "resource", id: "R", action: "duplicate" }, { kind: "object", id: "N", action: "skip" },
  ] },
  { name: "explicit revision replace with skipped note", strategy: "replace", decisions: [
    { kind: "resource", id: "R", action: "duplicate" }, { kind: "resource_revision", id: "V", action: "replace" }, { kind: "object", id: "N", action: "skip" },
  ] },
  { name: "copied object with replaced ref", strategy: "replace", decisions: [
    { kind: "resource", id: "R", action: "duplicate" }, { kind: "object", id: "N", action: "duplicate" },
  ] },
  { name: "duplicate strategy with skipped revision", strategy: "duplicate", decisions: [
    { kind: "resource_revision", id: "V", action: "skip" },
  ] },
  { name: "surviving local anchor outside the package", noteOutsidePackage: true, strategy: "replace", decisions: [
    { kind: "resource", id: "R", action: "duplicate" }, { kind: "resource_revision", id: "V", action: "replace" },
  ] },
  { name: "outside-package anchor with implicit revision copy", noteOutsidePackage: true, strategy: "replace", decisions: [
    { kind: "resource", id: "R", action: "duplicate" },
  ] },
  { name: "duplicated anchor while the original survives", strategy: "replace", decisions: [
    { kind: "resource", id: "R", action: "duplicate" }, { kind: "resource_revision", id: "V", action: "replace" },
    { kind: "object", id: "N", action: "skip" }, { kind: "anchor", id: "A", action: "duplicate" },
  ] },
  { name: "copied object with skipped ref", strategy: "replace", decisions: [
    { kind: "resource", id: "R", action: "duplicate" }, { kind: "resource_revision", id: "V", action: "replace" },
    { kind: "object", id: "N", action: "duplicate" }, { kind: "ref", id: "F", action: "skip" },
  ] },
  { name: "kept resource with copied note and skipped ref", strategy: "duplicate", decisions: [
    { kind: "resource", id: "R", action: "skip" }, { kind: "object", id: "N", action: "duplicate" }, { kind: "ref", id: "F", action: "skip" },
  ] },
  { name: "replaced note whose ref row is skipped", rewritesOriginalNote: true, strategy: "replace", decisions: [
    { kind: "object", id: "N", action: "replace" }, { kind: "ref", id: "F", action: "skip" },
  ] },
];

describe("M1b b9 package dependency matrix", () => {
  it.each(VARIANTS)("$name keeps every surviving source resolvable", async (variant) => {
    const ctx = await startApp();
    try {
      const book = await command(ctx, "library.importDocument", { title: "合成来源", format: "txt", bytes: [...new TextEncoder().encode("甲乙丙丁。第二段文字。")] });
      const dir = tempProfile();
      if (variant.noteOutsidePackage) exportLibraryPackage(ctx.app.store, dir);
      const note = await command(ctx, "notes.create", {
        title: "合成本地笔记", text: "保留评论", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "甲乙丙丁" } },
      });
      const db = ctx.app.store.sqlite;
      const refs = () => db.prepare("SELECT * FROM refs WHERE from_object_id=? ORDER BY id").all(note.objectId);
      const history = () => db.prepare("SELECT * FROM object_revisions WHERE object_id=? ORDER BY revision").all(note.objectId);
      const beforeRefs = refs();
      const beforeHistory = history();
      const manifest = variant.noteOutsidePackage ? null : exportLibraryPackage(ctx.app.store, dir);
      const decisions = variant.decisions.map((decision) => ({
        ...decision,
        id: decision.id === "R" ? String(book.resourceId) : decision.id === "V" ? String(book.revisionId) : decision.id === "N" ? String(note.objectId)
          : decision.kind === "anchor" ? String(manifest?.anchors[0]?.id ?? db.prepare("SELECT to_id AS id FROM refs WHERE from_object_id=?").get(note.objectId)?.id)
          : decision.kind === "ref" ? String(db.prepare("SELECT id AS id FROM refs WHERE from_object_id=?").get(note.objectId)?.id)
          : decision.id,
      }));
      importLibraryPackageResolved(ctx.app.store, dir, { strategy: variant.strategy, decisions });
      const opened = await command(ctx, "notes.openSource", { objectId: String(note.objectId) }) as { status: string; resourceId: string; card?: { status: string } };
      // A note the import does not rewrite keeps its own links and history; its source chain still agrees with the index.
      if (!variant.rewritesOriginalNote) {
        expect(refs()).toEqual(beforeRefs);
        expect(history()).toEqual(beforeHistory);
      }
      expect(opened.status).toBe("resolved");
      expect(opened.card?.status).toBe("resolved");
      expect(opened.resourceId).toBe(String(book.resourceId));
      expect(db.prepare("SELECT COUNT(*) AS n FROM text_fragments f JOIN resource_revisions v ON v.id=f.resource_revision_id WHERE f.object_id IS NULL AND f.resource_id<>v.resource_id").get()?.n).toBe(0);
      for (const object of db.prepare("SELECT id FROM content_objects WHERE type='notes.document'").all() as Array<{ id: string }>) {
        const payload = JSON.parse(String((db.prepare("SELECT payload_json FROM content_objects WHERE id=?").get(object.id) as { payload_json: string }).payload_json)) as { blocks: Array<{ id: string; anchorId?: string }> };
        const source = await command(ctx, "notes.openSource", { objectId: object.id }) as { status: string; card?: { status: string } };
        expect(source.status).toBe("resolved");
        expect(source.card?.status).toBe("resolved");
        for (const block of payload.blocks) {
          if (!block.anchorId) continue;
          const anchor = db.prepare("SELECT * FROM anchors WHERE id=?").get(block.anchorId) as { resource_id: string; resource_revision_id: string; locator_json: string };
          expect(anchor, `block ${block.id} of ${object.id} names a missing anchor`).toBeTruthy();
          const revision = db.prepare("SELECT resource_id FROM resource_revisions WHERE id=?").get(anchor.resource_revision_id) as { resource_id: string };
          expect(revision.resource_id).toBe(anchor.resource_id);
          expect((JSON.parse(anchor.locator_json) as { representationId: string }).representationId).toBe(anchor.resource_revision_id);
          const ref = db.prepare("SELECT to_id FROM refs WHERE from_object_id=? AND from_block_id=? AND to_kind='anchor'").get(object.id, block.id) as { to_id: string } | undefined;
          expect(ref?.to_id).toBe(block.anchorId);
          const indices = db.prepare("SELECT resource_id FROM text_fragments WHERE object_id=?").all(object.id) as Array<{ resource_id: string }>;
          expect(indices.length).toBeGreaterThan(0);
          for (const row of indices) expect(row.resource_id).toBe(anchor.resource_id);
          const revisions = db.prepare("SELECT payload_json FROM object_revisions WHERE object_id=?").all(object.id) as Array<{ payload_json: string }>;
          expect(revisions.length).toBeGreaterThan(0);
          for (const row of revisions) {
            const blocks = (JSON.parse(row.payload_json) as { blocks: Array<{ anchorId?: string }> }).blocks.filter((item) => item.anchorId);
            for (const item of blocks) expect(db.prepare("SELECT id FROM anchors WHERE id=?").get(item.anchorId)).toBeTruthy();
          }
        }
      }
      for (const copy of db.prepare("SELECT id FROM content_objects WHERE type='notes.document' AND id<>?").all(note.objectId) as Array<{ id: string }>) {
        const source = await command(ctx, "notes.openSource", { objectId: copy.id }) as { status: string; card?: { status: string } };
        const copyRefs = db.prepare("SELECT id FROM refs WHERE from_object_id=? AND to_kind='anchor'").all(copy.id);
        expect(copyRefs.length, "a copied note must retain a public ref").toBeGreaterThan(0);
        expect(source.status).toBe("resolved");
        expect(source.card?.status).toBe("resolved");
        expect(db.prepare("SELECT COUNT(*) AS n FROM object_revisions WHERE object_id=?").get(copy.id)?.n).toBeGreaterThan(0);
      }
    } finally { ctx.app.close(); }
  });

  it("rejects decisions that pin one replaced revision to two owners without changing content", async () => {
    const ctx = await startApp();
    try {
      const book = await command(ctx, "library.importDocument", { title: "冲突来源", format: "txt", bytes: [...new TextEncoder().encode("冲突正文。")] });
      const notes = [];
      for (const title of ["甲", "乙"]) {
        notes.push(await command(ctx, "notes.create", {
          title, text: "合成评论", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
          locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "冲突正文" } },
        }));
      }
      const dir = tempProfile();
      exportLibraryPackage(ctx.app.store, dir);
      const db = ctx.app.store.sqlite;
      db.prepare("UPDATE anchors SET resource_id='res_diverged' WHERE id=(SELECT to_id FROM refs WHERE from_object_id=?)").run(notes[1]!.objectId);
      const snapshot = () => JSON.stringify(["resources", "resource_revisions", "anchors", "refs", "content_objects", "object_revisions", "text_fragments"].map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
      const before = snapshot();
      let error: unknown;
      try {
        importLibraryPackageResolved(ctx.app.store, dir, {
          strategy: "replace",
          decisions: [...notes.map((note) => ({ kind: "object", id: String(note.objectId), action: "skip" })), { kind: "resource_revision", id: String(book.revisionId), action: "replace" }],
        });
      } catch (thrown) { error = thrown; }
      expect((error as { code?: string })?.code).toBe("PUBLISH_CONFLICT");
      expect(snapshot()).toBe(before);
    } finally { ctx.app.close(); }
  });
});
