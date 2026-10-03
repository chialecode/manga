import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startApp, tempProfile } from "../tests/m1b/helpers.ts";
import { buildEpubFixture, buildPdfFixture, parsePdfBytes } from "../packages/app-core/src/domain/formats.ts";
import { exportLibraryPackage, importLibraryPackageResolved } from "../packages/app-core/src/domain/library-package.ts";
import { readDocument } from "../packages/app-core/src/reading-service.ts";
import { m1bFingerprints } from "./m1b-fingerprint.mjs";
import { repoRoot } from "./desktop-paths.ts";

const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? "docs/evidence/m1b-reading-notes/b7-rework");
fs.mkdirSync(evidence, { recursive: true });
const observations = [];
async function check(name, run, finding) {
  const detail = {};
  try { await run(detail); observations.push({ finding, name, status: "passed", detail }); }
  catch (error) { observations.push({ finding, name, status: "failed", actual: error.message, detail }); }
}
async function call(ctx, commandId, input) {
  const result = await ctx.app.call(ctx.actor, { commandId, input, idempotencyKey: crypto.randomUUID() }, ctx.grant.handle);
  assert.equal(result.status, "ok", result.error?.message);
  return result.value;
}
async function fixture() {
  const ctx = await startApp();
  const book = await call(ctx, "library.importDocument", { title: "合成引用保护", format: "txt", bytes: [...new TextEncoder().encode("甲乙丙丁。第二段文字。")] });
  const note = await call(ctx, "notes.create", { title: "合成笔记", text: "原评论", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
    locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "甲乙丙丁" } } });
  const dir = tempProfile();
  const manifest = exportLibraryPackage(ctx.app.store, dir);
  return { ctx, book, note, dir, manifest };
}

// F-09: the hybrid decision matrix must keep every surviving source resolvable.
await check("skipping a note preserves the source resource of its existing anchor", async (detail) => {
  const { ctx, book, note, dir, manifest } = await fixture();
  try {
    const db = ctx.app.store.sqlite;
    const anchorId = manifest.anchors[0].id;
    const before = db.prepare("SELECT resource_id, resource_revision_id, locator_json FROM anchors WHERE id=?").get(anchorId);
    importLibraryPackageResolved(ctx.app.store, dir, { strategy: "replace", decisions: [
      { kind: "resource", id: book.resourceId, action: "duplicate" },
      { kind: "object", id: note.objectId, action: "skip" },
    ] });
    const after = db.prepare("SELECT resource_id, resource_revision_id, locator_json FROM anchors WHERE id=?").get(anchorId);
    detail.sourcePreserved = JSON.stringify(before) === JSON.stringify(after);
    detail.sourceNowTargetsDuplicate = after.resource_id !== book.resourceId;
    assert.deepEqual(after, before, "the skipped note's existing anchor was retargeted to the duplicated resource");
  } finally { ctx.app.close(); }
});

await check("skipping a revision while duplicating a resource retains recoverable excerpt provenance", async (detail) => {
  const { ctx, book, note, dir, manifest } = await fixture();
  try {
    importLibraryPackageResolved(ctx.app.store, dir, { strategy: "duplicate", decisions: [
      { kind: "resource_revision", id: book.revisionId, action: "skip" },
    ] });
    const db = ctx.app.store.sqlite;
    const copy = db.prepare("SELECT id, payload_json FROM content_objects WHERE type='notes.document' AND id<>?").get(note.objectId);
    const blocks = JSON.parse(copy.payload_json).blocks;
    const anchor = blocks.find((block) => block.anchorId)?.anchorId;
    const refs = db.prepare("SELECT to_id FROM refs WHERE from_object_id=? AND to_kind='anchor'").all(copy.id);
    detail.excerptTextKept = blocks.some((block) => block.text === "甲乙丙丁");
    detail.sourceAnchorKept = Boolean(anchor);
    detail.sourceReferenceCount = refs.length;
    detail.originalAnchorStillExists = Boolean(db.prepare("SELECT id FROM anchors WHERE id=?").get(manifest.anchors[0].id));
    assert.ok(anchor && refs.length, "import erased the excerpt's anchor and reference instead of retaining a resolvable or repairable source");
    const opened = await call(ctx, "notes.openSource", { objectId: copy.id });
    detail.copySourceResolves = opened.status === "resolved";
    assert.equal(opened.status, "resolved", "the copied excerpt's kept source does not resolve");
  } finally { ctx.app.close(); }
});

await check("an anchor a surviving local note references is never re-pointed, even under replace", async (detail) => {
  const ctx = await startApp();
  try {
    const book = await call(ctx, "library.importDocument", { title: "替换保护", format: "txt", bytes: [...new TextEncoder().encode("替换保护正文。")] });
    await call(ctx, "notes.create", { title: "包内笔记", text: "包内评论", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
      locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "替换保护" } } });
    const dir = tempProfile();
    const manifest = exportLibraryPackage(ctx.app.store, dir);
    // A local note the package never mentions now references the package's anchor; a replace must not
    // move that source behind the surviving reference.
    const local = await call(ctx, "notes.create", { title: "本地笔记", text: "本地评论",
      locator: { kind: "text", partId: "body", representationId: "none", normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 2 }, quote: { exact: "本地" } } });
    const db = ctx.app.store.sqlite;
    const payload = JSON.parse(db.prepare("SELECT payload_json FROM content_objects WHERE id=?").get(local.objectId).payload_json);
    payload.blocks[0].anchorId = manifest.anchors[0].id;
    db.prepare("UPDATE content_objects SET payload_json=? WHERE id=?").run(JSON.stringify(payload), local.objectId);
    const before = db.prepare("SELECT resource_id, resource_revision_id, locator_json FROM anchors WHERE id=?").get(manifest.anchors[0].id);
    importLibraryPackageResolved(ctx.app.store, dir, { strategy: "replace" });
    const after = db.prepare("SELECT resource_id, resource_revision_id, locator_json FROM anchors WHERE id=?").get(manifest.anchors[0].id);
    detail.localAnchorKept = JSON.stringify(before) === JSON.stringify(after);
    assert.deepEqual(after, before, "a replace import moved the anchor a surviving local note references");
    const opened = await call(ctx, "notes.openSource", { objectId: local.objectId });
    detail.localNoteResolves = opened.status === "resolved";
  } finally { ctx.app.close(); }
});

// F-08: the whole library stays reachable past the bounded first window.
await check("the 101st and oldest resource is listable, searchable and openable", async (detail) => {
  const ctx = await startApp();
  try {
    const db = ctx.app.store.sqlite;
    const resource = db.prepare("INSERT INTO resources(id,work_id,kind,title,aliases_json,created_at) VALUES (?,NULL,'novel',?,'[]',?)");
    const revision = db.prepare("INSERT INTO resource_revisions(id,resource_id,fingerprint,parser_version,payload_json,created_at) VALUES (?,?,?,'synthetic',?,?)");
    db.exec("BEGIN");
    for (let index = 0; index < 101; index += 1) {
      const date = new Date(Date.UTC(2020, 0, 1) + index * 1000).toISOString();
      resource.run(`res_b7_${index}`, `合成书 ${index}`, date);
      revision.run(`rev_b7_${index}`, `res_b7_${index}`, `fp_b7_${index}`, JSON.stringify({ normalized: `合成正文 ${index}` }), date);
    }
    db.exec("COMMIT");
    const inventory = await call(ctx, "inventory.overview", {});
    const workspace = await call(ctx, "workspace.get", {});
    detail.total = inventory.totals.resource.count;
    detail.listed = inventory.items.filter((item) => item.kind === "resource").length;
    detail.inventoryContinuation = Boolean(inventory.pagination?.resource?.nextCursor);
    detail.workspaceContinuation = Boolean(workspace.resourcePage?.nextCursor);
    assert.equal(inventory.totals.resource.count, 101, "the library total changed");
    assert.ok(inventory.pagination?.resource?.nextCursor, "inventory offers no continuation cursor");
    assert.ok(workspace.resourcePage?.nextCursor, "workspace offers no continuation cursor");
    // Page through library.list until the oldest row appears, then open it.
    let cursor;
    let seen = 0;
    let oldestSeen = false;
    for (let page = 0; page < 10; page += 1) {
      const result = await call(ctx, "library.list", { limit: 50, ...(cursor ? { cursor } : {}) });
      seen += result.items.length;
      oldestSeen = oldestSeen || result.items.some((item) => item.id === "res_b7_0");
      detail.pages = page + 1;
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
    }
    detail.listedThroughCursors = seen;
    detail.oldestListed = oldestSeen;
    assert.ok(oldestSeen, "the oldest resource never appeared in any page");
    const search = await call(ctx, "library.list", { query: "合成书 0" });
    detail.searchFindsOldest = search.items.some((item) => item.id === "res_b7_0");
    assert.ok(detail.searchFindsOldest, "whole-library search does not reach the oldest resource");
    const opened = await call(ctx, "library.getResource", { resourceId: "res_b7_0" });
    detail.oldestOpens = opened.title === "合成书 0";
    assert.equal(opened.title, "合成书 0", "the oldest resource did not open");
  } finally { ctx.app.close(); }
});

// F-07: PDF.js text runs must quote the normalized page. EPUB fixed layout still uses its stored shapes.
await check("a text PDF page renders from a positional model that quotes the text layer", async (detail) => {
  const ctx = await startApp();
  try {
    const bytes = buildPdfFixture([{ text: "呈现第一页" }, { text: "呈现第二页" }, { scan: true }]);
    const book = await call(ctx, "library.importDocument", { title: "页面呈现", format: "pdf", bytes: [...bytes] });
    const parsed = await parsePdfBytes(bytes);
    detail.pdfjsPageRendering = parsed.traits.pdfjsPageRendering;
    detail.textPages = parsed.parts.filter((part) => part.normalized.trim()).length;
    assert.equal(parsed.traits.pdfjsPageRendering, true, "pdf.js page rendering is not reported");
    assert.equal(detail.textPages, 2, "expected two text pages");
    assert.equal(parsed.parts[2]?.kind, "image", "the scan page was given a text layer");
    for (const part of parsed.parts.filter((item) => item.normalized.trim())) {
      assert.equal(part.render, undefined, "pdf pages no longer store an SVG operator list");
      const quoted = (part.textRuns ?? []).every((run) => run.offset === undefined || [...part.normalized].slice(run.offset, run.offset + [...run.text].length).join("") === run.text);
      assert.equal(quoted, true, "a text-layer offset does not quote the normalized page");
    }
    const document = readDocument(ctx.app.store, book.resourceId);
    detail.partsHaveRender = document.parts.filter((part) => part.hasRender).length;
    detail.sliceText = document.slice?.text ?? "";
    assert.equal(detail.partsHaveRender, 2, "text pages are not marked renderable");
    assert.match(detail.sliceText, /呈现第一页/);
    assert.equal(document.slice?.render, undefined, "the pdf slice must not revive the old SVG render");
    // The EPUB author layout: fixed pages render from the stored model.
    const epubBytes = buildEpubFixture({ title: "固定页呈现", fixedLayout: true, chapters: [
      { id: "c1", title: "首页", html: "<p>正文甲</p>" },
      { id: "p2", title: "插图页", html: "", svgPage: "plate.png" },
    ] });
    const epub = await call(ctx, "library.importDocument", { title: "固定页呈现", format: "epub", bytes: [...epubBytes] });
    const epubDocument = readDocument(ctx.app.store, epub.resourceId);
    detail.epubFixedPageRender = Boolean(epubDocument.parts?.find((part) => part.id === "p2")?.hasRender);
    assert.ok(detail.epubFixedPageRender, "the fixed-layout page carries no render model");
  } finally { ctx.app.close(); }
});

const report = { at: new Date().toISOString(), ...m1bFingerprints(repoRoot), scriptFingerprint: createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex"), status: observations.every((item) => item.status === "passed") ? "passed" : "rework-required", humanChecks: "not-run", productAcceptance: "not-run", observations };
fs.writeFileSync(path.join(evidence, "a-b7-rework-review.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "passed") process.exitCode = 1;
