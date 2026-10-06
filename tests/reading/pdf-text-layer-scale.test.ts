import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DrizzleStore } from "@manga/storage-drizzle";
import { buildPdfFixture, parsePdfBytes } from "@manga/app-core";
import { exportLibraryPackage, importLibraryPackageResolved, recoverOrRollback } from "../../packages/app-core/src/domain/library-package.ts";
import { startApp, tempProfile } from "../helpers/app.ts";

type Ctx = Awaited<ReturnType<typeof startApp>>;

async function command(ctx: Ctx, commandId: string, input: Record<string, unknown>) {
  const result = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: crypto.randomUUID(), input }, ctx.grant.handle);
  expect(result.status, result.error?.message).toBe("ok");
  return result.value as Record<string, unknown>;
}

/** A classic-xref PDF built from object bodies; streams are written with their exact /Length. */
function pdf(objects: Array<string | { dict: string; data: string }>): Uint8Array {
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    const text = typeof object === "string" ? object : `<< ${object.dict} /Length ${Buffer.byteLength(object.data, "latin1")} >>\nstream\n${object.data}\nendstream`;
    body += `${index + 1} 0 obj\n${text}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}

const hex = (text: string) => Buffer.from(text, "utf16le").swap16().toString("hex").toUpperCase();

/** Two-byte Identity-H CID font whose glyph ids only become text through bfchar/bfrange (incl. the array form). */
function cidPdf(withToUnicode: boolean): Uint8Array {
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "1 begincodespacerange <0000> <FFFF> endcodespacerange",
    `2 beginbfchar <0003> <${hex("中")}> <0004> <${hex("文")}> endbfchar`,
    `2 beginbfrange <0010> <0011> <${hex("日")}> <0020> <0022> [<${hex("語")}> <${hex("😀")}> <${hex("é")}>] endbfrange`,
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
  return pdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /C0 4 0 R /H 6 0 R >> >> /Contents 5 0 R >>",
    `<< /Type /Font /Subtype /Type0 /BaseFont /Synthetic-CID /Encoding /Identity-H /DescendantFonts [8 0 R] ${withToUnicode ? "/ToUnicode 7 0 R " : ""}>>`,
    // q/Q restores the CID font after a Latin run; the second BT line must start a new line.
    { dict: "", data: "BT /C0 12 Tf 20 360 Td <00030004> Tj q /H 12 Tf (\\101\\102) Tj Q <0010> Tj 0 -20 Td [<0011> -300 <002000210022>] TJ ET" },
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    { dict: "", data: cmap },
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Synthetic-CID /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 >>",
  ]);
}

describe("M1b b6 PDF text layer", () => {
  it("decodes two-byte CID codes through ToUnicode bfchar and both bfrange forms", async () => {
    const parsed = await parsePdfBytes(cidPdf(true));
    expect(parsed.parts[0]?.normalized).toContain("中文");
    expect(parsed.parts[0]?.normalized).toContain("😀");
    expect(parsed.traits.accepted).toBe(true);
    expect(parsed.warnings.join("\n")).not.toMatch(/no Unicode mapping/);
  });

  it("leaves unmappable Identity-H glyphs out of the text layer and says so", async () => {
    const parsed = await parsePdfBytes(cidPdf(false));
    // Glyph ids must not leak as the page text. A Latin run that has a real encoding can remain.
    expect(parsed.parts[0]?.normalized).not.toMatch(/[\u0000-\u0008]/);
    const text = parsed.parts[0]?.normalized ?? "";
    expect(text.includes("中") && text.includes("文")).toBe(false);
    expect(text).toContain("AB");
    expect(parsed.warnings.join("\n")).toMatch(/no Unicode mapping/);
  });

  it("applies WinAnsi, Differences glyph names and form XObject text", async () => {
    const sample = pdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /W 4 0 R >> /XObject << /Fm.1 6 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman /Encoding << /BaseEncoding /WinAnsiEncoding /Differences [65 /uni4E2D /eacute] >> >>",
      { dict: "", data: "BT /W 12 Tf 20 360 Td (\\223AB\\224 caf\\351) Tj ET /Fm.1 Do" },
      { dict: "/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Resources << /Font << /W 4 0 R >> >>", data: "BT /W 10 Tf 0 -30 Td (form B) Tj ET" },
    ]);
    const parsed = await parsePdfBytes(sample);
    expect(parsed.parts[0]?.normalized).toContain("中");
    expect(parsed.parts[0]?.normalized).toContain("café");
  });

  it("keeps the legacy fixtures, scan pages and page identity", async () => {
    const parsed = await parsePdfBytes(buildPdfFixture([{ text: "第一页" }, { scan: true }, { utf16: "第三页😀" }]));
    expect(parsed.parts.map((part) => part.id)).toEqual(["page-1", "page-2", "page-3"]);
    expect(parsed.parts[0]?.normalized).toBe("第一页");
    expect(parsed.parts[1]?.kind).toBe("image");
    expect(parsed.parts[2]?.normalized).toBe("第三页😀");
    expect(parsed.traits.pdfjsPageRendering).toBe(true);
    expect(parsed.parts[1]?.render).toBeUndefined();
    expect(parsed.parts[0]?.textRuns?.[0]?.text).toBe("第一页");
    expect(parsed.parts[0]?.textRuns?.[0]?.offset).toBe(0);
  });

  it("imports a ToUnicode PDF whose mapped text is searchable and quotable", async () => {
    const ctx = await startApp();
    try {
      const book = await command(ctx, "library.importDocument", { title: "映射 PDF", format: "pdf", bytes: [...cidPdf(true)] });
      const hits = await command(ctx, "library.search", { text: "中文", resourceId: book.resourceId }) as unknown as { hits?: Array<{ text: string }> } | Array<{ text: string }>;
      const list = Array.isArray(hits) ? hits : hits.hits ?? [];
      expect(list.some((hit) => hit.text.includes("中文"))).toBe(true);
      const note = await command(ctx, "notes.create", {
        title: "PDF 摘录", text: "评论", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "page-1", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 9, end: 11 }, quote: { exact: "😀é" } },
      });
      const opened = await command(ctx, "notes.openSource", { objectId: note.objectId });
      expect(opened.status).toBe("resolved");
    } finally { ctx.app.close(); }
  });
});

async function libraryWithNote(ctx: Ctx, text = "甲乙丙丁，合成依赖图正文。") {
  const book = await command(ctx, "library.importDocument", { title: "合成依赖图", format: "txt", bytes: [...new TextEncoder().encode(text)] });
  const note = await command(ctx, "notes.create", {
    title: "合成来源笔记", text: "保留来源", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
    locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "甲乙丙丁" } },
  });
  return { book, note };
}

function counts(store: DrizzleStore) {
  const n = (sql: string, ...args: unknown[]) => (store.sqlite.prepare(sql).get(...args) as { n: number }).n;
  return {
    revisions: n("SELECT COUNT(*) AS n FROM resource_revisions"),
    fragments: n("SELECT COUNT(*) AS n FROM text_fragments WHERE object_id IS NULL"),
    locations: n("SELECT COUNT(*) AS n FROM file_locations"),
    assets: n("SELECT COUNT(*) AS n FROM resource_assets"),
    danglingRefs: n("SELECT COUNT(*) AS n FROM refs WHERE to_kind='anchor' AND to_id NOT IN (SELECT id FROM anchors)"),
  };
}

function danglingNoteAnchors(store: DrizzleStore): string[] {
  const rows = [
    ...store.sqlite.prepare("SELECT payload_json FROM content_objects WHERE type='notes.document'").all(),
    ...store.sqlite.prepare("SELECT payload_json FROM object_revisions").all(),
  ] as Array<{ payload_json: string }>;
  const ids = rows.flatMap((row) => ((JSON.parse(row.payload_json) as { blocks?: Array<{ anchorId?: string }> }).blocks ?? []).map((block) => block.anchorId).filter((id): id is string => Boolean(id)));
  return ids.filter((id) => !store.sqlite.prepare("SELECT 1 FROM anchors WHERE id = ?").get(id));
}

describe("M1b b6 package dependency plan", () => {
  it("skipping an existing resource while duplicating its note keeps every note source resolvable", async () => {
    const ctx = await startApp();
    try {
      const { book, note } = await libraryWithNote(ctx);
      const dir = tempProfile();
      exportLibraryPackage(ctx.app.store, dir);
      const before = counts(ctx.app.store);
      importLibraryPackageResolved(ctx.app.store, dir, { strategy: "duplicate", decisions: [{ kind: "resource", id: String(book.resourceId), action: "skip" }] });
      const after = counts(ctx.app.store);
      // The kept resource gains no revision, index, location or media from the package.
      expect({ ...after, danglingRefs: 0 }).toEqual({ ...before, danglingRefs: 0 });
      expect(after.danglingRefs).toBe(0);
      expect(danglingNoteAnchors(ctx.app.store)).toEqual([]);
      const copy = ctx.app.store.sqlite.prepare("SELECT id FROM content_objects WHERE type='notes.document' AND id <> ?").get(note.objectId) as { id: string };
      const opened = await command(ctx, "notes.openSource", { objectId: copy.id });
      expect(opened.status).toBe("resolved");
    } finally { ctx.app.close(); }
  });

  it("skipping a colliding revision keeps its payload, index and media while replacing the rest", async () => {
    const ctx = await startApp();
    try {
      const book = await command(ctx, "library.importDocument", { title: "扫描", format: "pdf", bytes: [...buildPdfFixture([{ text: "本地正文" }, { scan: true }])] });
      const dir = tempProfile();
      const manifest = exportLibraryPackage(ctx.app.store, dir);
      const revision = manifest.revisions.find((row) => row.id === book.revisionId)!;
      const payload = JSON.parse(revision.payload_json) as { parts?: Array<{ normalized?: string }> };
      for (const part of payload.parts ?? []) part.normalized = "package-only-sentinel";
      revision.payload_json = JSON.stringify(payload);
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
      const store = ctx.app.store;
      const snapshot = () => ({
        payload: (store.sqlite.prepare("SELECT payload_json FROM resource_revisions WHERE id=?").get(book.revisionId) as { payload_json: string }).payload_json,
        fragments: (store.sqlite.prepare("SELECT text FROM text_fragments WHERE resource_revision_id=? ORDER BY text").all(book.revisionId) as Array<{ text: string }>).map((row) => row.text),
        assets: store.sqlite.prepare("SELECT id, hash FROM resource_assets WHERE resource_revision_id=? ORDER BY id").all(book.revisionId),
        locations: store.sqlite.prepare("SELECT relative_path, available FROM file_locations WHERE resource_revision_id=? ORDER BY id").all(book.revisionId),
      });
      const before = snapshot();
      importLibraryPackageResolved(store, dir, { strategy: "replace", decisions: [{ kind: "resource_revision", id: String(book.revisionId), action: "skip" }] });
      expect(snapshot()).toEqual(before);
      const search = store.sqlite.prepare("SELECT COUNT(*) AS n FROM search_idx WHERE text LIKE '%package-only-sentinel%'").get() as { n: number };
      expect(search.n).toBe(0);
    } finally { ctx.app.close(); }
  });

  it("replacing a revision drops its stale index before indexing the package text", async () => {
    const ctx = await startApp();
    try {
      const { book } = await libraryWithNote(ctx, "本地旧版正文独有词");
      const dir = tempProfile();
      const manifest = exportLibraryPackage(ctx.app.store, dir);
      const revision = manifest.revisions.find((row) => row.id === book.revisionId)!;
      const payload = JSON.parse(revision.payload_json) as { parts?: Array<{ normalized?: string }>; normalized?: string };
      for (const part of payload.parts ?? []) part.normalized = "包内新版正文";
      if (typeof payload.normalized === "string") payload.normalized = "包内新版正文";
      revision.payload_json = JSON.stringify(payload);
      fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
      importLibraryPackageResolved(ctx.app.store, dir, { strategy: "replace" });
      const texts = (ctx.app.store.sqlite.prepare("SELECT text FROM text_fragments WHERE resource_revision_id=? AND object_id IS NULL").all(book.revisionId) as Array<{ text: string }>).map((row) => row.text);
      expect(texts.join("")).toContain("包内新版正文");
      expect(texts.join("")).not.toContain("旧版正文独有词");
      expect(counts(ctx.app.store).danglingRefs).toBe(0);
      expect(danglingNoteAnchors(ctx.app.store)).toEqual([]);
    } finally { ctx.app.close(); }
  });

  it("mixed skip/duplicate decisions keep notes, history, refs and index on persisted rows only", async () => {
    const source = await startApp();
    const target = await startApp();
    try {
      const a = await libraryWithNote(source);
      const other = await command(source, "library.importDocument", { title: "第二本", format: "txt", bytes: [...new TextEncoder().encode("第二本书的正文。")] });
      await command(source, "notes.create", {
        title: "第二笔记", text: "第二评论", resourceId: other.resourceId, resourceRevisionId: other.revisionId,
        locator: { kind: "text", partId: "body", representationId: other.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 3 }, quote: { exact: "第二本" } },
      });
      const dir = tempProfile();
      exportLibraryPackage(source.app.store, dir);
      // The target already holds the first book under the same ids; the second book is new to it.
      const seed = tempProfile();
      exportLibraryPackage(source.app.store, seed);
      importLibraryPackageResolved(target.app.store, seed, { strategy: "replace" });
      target.app.store.sqlite.prepare("DELETE FROM resources WHERE id = ?").run(other.resourceId);
      const packageFiles = fs.readdirSync(dir, { recursive: true }).map(String).sort().map((name) => [name, fs.statSync(path.join(dir, name)).isFile() ? createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex") : "dir"]);
      importLibraryPackageResolved(target.app.store, dir, {
        strategy: "duplicate",
        decisions: [{ kind: "resource", id: String(a.book.resourceId), action: "skip" }, { kind: "object", id: String(a.note.objectId), action: "skip" }],
      });
      const store = target.app.store;
      expect(counts(store).danglingRefs).toBe(0);
      expect(danglingNoteAnchors(store)).toEqual([]);
      const notes = store.sqlite.prepare("SELECT id FROM content_objects WHERE type='notes.document' AND deleted_at IS NULL").all() as Array<{ id: string }>;
      for (const row of notes) {
        const opened = await target.app.call(target.actor, { commandId: "notes.openSource", idempotencyKey: crypto.randomUUID(), input: { objectId: row.id } }, target.grant.handle);
        expect(opened.status, row.id).toBe("ok");
        expect((opened.value as { status: string }).status, row.id).toBe("resolved");
      }
      // Every indexed body fragment belongs to a revision that exists.
      const orphanFragments = store.sqlite.prepare("SELECT COUNT(*) AS n FROM text_fragments WHERE resource_revision_id IS NOT NULL AND resource_revision_id NOT IN (SELECT id FROM resource_revisions)").get() as { n: number };
      expect(orphanFragments.n).toBe(0);
      // The package is a source: the import never rewrites it.
      const afterFiles = fs.readdirSync(dir, { recursive: true }).map(String).sort().map((name) => [name, fs.statSync(path.join(dir, name)).isFile() ? createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex") : "dir"]);
      expect(afterFiles).toEqual(packageFiles);
    } finally {
      source.app.close();
      target.app.close();
    }
  });

  it("an import that exits before commit leaves no rows and rolls back its published media", async () => {
    const ctx = await startApp();
    const dir = tempProfile();
    let profileDir = "";
    try {
      await command(ctx, "library.importDocument", { title: "扫描", format: "pdf", bytes: [...buildPdfFixture([{ text: "中断" }, { scan: true }])] });
      await libraryWithNote(ctx);
      exportLibraryPackage(ctx.app.store, dir);
      profileDir = path.dirname(ctx.app.store.attachmentsDir);
    } finally { ctx.app.close(); }
    const target = tempProfile();
    const packageModule = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/app-core/src/domain/library-package.ts");
    const storeModule = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/storage-drizzle/src/index.ts");
    const script = `const { DrizzleStore } = await import(${JSON.stringify(`file:///${storeModule.replaceAll("\\", "/")}`)});
const { importLibraryPackageResolved } = await import(${JSON.stringify(`file:///${packageModule.replaceAll("\\", "/")}`)});
const store = new DrizzleStore({ profileDir: ${JSON.stringify(target)}, hostId: "pkg-crash" });
importLibraryPackageResolved(store, ${JSON.stringify(dir)}, { strategy: "replace", crashAt: "publish" });`;
    const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000, windowsHide: true });
    expect(child.status, child.stderr).toBe(99);
    expect(profileDir).not.toBe("");
    const store = new DrizzleStore({ profileDir: target, hostId: "pkg-after-crash" });
    try {
      const n = (table: string) => (store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect([n("resources"), n("content_objects"), n("anchors"), n("text_fragments")]).toEqual([0, 0, 0, 0]);
      recoverOrRollback(store, "rollback");
      const leftovers = fs.readdirSync(store.attachmentsDir).filter((name) => !name.startsWith(".import-"));
      expect(leftovers).toEqual([]);
      importLibraryPackageResolved(store, dir, { strategy: "replace" });
      expect(n("resources")).toBe(2);
      expect(danglingNoteAnchors(store)).toEqual([]);
    } finally { store.close(); }
  });
});

describe("M1b b6 scale library", () => {
  it("indexes a text tail past the first search window", async () => {
    const ctx = await startApp();
    try {
      const marker = "窗口尾标记乙";
      const text = `${"甲".repeat(64_000)}${marker}`;
      const book = await command(ctx, "library.importDocument", { title: "长段", format: "txt", bytes: [...new TextEncoder().encode(text)] });
      const found = await command(ctx, "library.find", { text: marker, resourceId: book.resourceId }) as unknown as Array<{ text?: string; locator?: { range?: { start?: number } } }>;
      expect(found.some((hit) => (hit.text ?? "").includes(marker) && Number(hit.locator?.range?.start) >= 64_000)).toBe(true);
    } finally { ctx.app.close(); }
  });

  it("reports a large library total without listing or loading every payload", async () => {
    const ctx = await startApp();
    try {
      const sqlite = ctx.app.store.sqlite;
      sqlite.exec("BEGIN");
      const insertResource = sqlite.prepare("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES (?,?,?,?,?,?)");
      const insertRevision = sqlite.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES (?,?,?,?,?,?)");
      for (let i = 0; i < 300; i += 1) {
        insertResource.run(`res_w${i}`, null, "novel", `窗口 ${i}`, "[]", "2020-01-01T00:00:00.000Z");
        insertRevision.run(`rev_w${i}`, `res_w${i}`, `fp${i}`, "t", JSON.stringify({ normalized: "甲" }), "2020-01-01T00:00:00.000Z");
      }
      sqlite.exec("COMMIT");
      const overview = await command(ctx, "inventory.overview", {}) as { totals?: { resource?: { count?: number; bytes?: number } }; items?: Array<{ kind?: string }> };
      expect(overview.totals?.resource?.count).toBeGreaterThanOrEqual(300);
      expect(overview.totals?.resource?.bytes).toBeGreaterThan(0);
      expect((overview.items ?? []).filter((item) => item.kind === "resource").length).toBeLessThanOrEqual(100);
    } finally { ctx.app.close(); }
  });
});
