import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startApp, tempProfile } from "../tests/m1b/helpers.ts";
import { parsePdfBytes, epubFixedRender } from "../packages/app-core/src/domain/formats.ts";
import { exportLibraryPackage, importLibraryPackageResolved } from "../packages/app-core/src/domain/library-package.ts";
import { m1bFingerprints } from "./m1b-fingerprint.mjs";
import { repoRoot } from "./desktop-paths.ts";

const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? "docs/evidence/m1b-reading-notes/a-b7-review");
fs.mkdirSync(evidence, { recursive: true });
const observations = [];
async function check(finding, name, run) {
  const detail = {};
  try { await run(detail); observations.push({ finding, name, status: "passed", detail }); }
  catch (error) { observations.push({ finding, name, status: "failed", actual: error.message, detail }); }
}
async function call(ctx, commandId, input) {
  const result = await ctx.app.call(ctx.actor, { commandId, input, idempotencyKey: crypto.randomUUID() }, ctx.grant.handle);
  assert.equal(result.status, "ok", result.error?.message);
  return result.value;
}

// Independent classic-xref, standard-font fixture. Coordinates are within the MediaBox; the
// expected text advance follows Courier's 600-unit glyph width, not the candidate's layout model.
function pdf(content) {
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
  ];
  let source = "%PDF-1.4\n";
  const offsets = [];
  bodies.forEach((body, index) => { offsets.push(Buffer.byteLength(source, "ascii")); source += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(source, "ascii");
  source += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(source, "ascii");
}

for (const [name, operators, expectedX, expectedY, normalized] of [
  ["consecutive Tj advances the text matrix", "(HELLO) Tj (WORLD) Tj", 110, 320, "HELLOWORLD"],
  ["TJ applies glyph advance and numeric spacing", "[(HELLO) -300 (WORLD)] TJ", 116, 320, "HELLO WORLD"],
  ["quote operator moves to the next text line", "24 TL (HELLO) Tj (WORLD) '", 50, 296, "HELLO\nWORLD"],
]) {
  await check("F-07", name, async (detail) => {
    const bytes = pdf(`BT /F1 20 Tf 1 0 0 1 50 320 Tm ${operators} ET`);
    if (name.startsWith("consecutive")) fs.writeFileSync(path.join(evidence, "consecutive-text.pdf"), bytes);
    const part = (await parsePdfBytes(bytes)).parts[0];
    detail.normalized = part.normalized;
    assert.equal(part.normalized, normalized, "legacy normalized text changed");
    const runs = part.textRuns ?? [];
    const width = runs.reduce((sum, run) => sum + (run.width ?? 0), 0);
    detail.runs = runs;
    detail.width = width;
    if (name.startsWith("quote")) {
      assert.equal(runs.length, 2, "the quote operator should keep two lines");
      assert.equal(runs[1].y, expectedY, "the quote operator did not move to the next line");
    } else if (name.startsWith("consecutive")) {
      assert.ok(Math.abs(width - 120) < 1, `joined Tj width ${width} is not the Courier advance`);
    } else {
      assert.equal(part.normalized, "HELLO WORLD");
      assert.ok(Math.abs(width - 126) < 1, `TJ width ${width} dropped the numeric spacing`);
    }
  });
}
fs.writeFileSync(path.join(evidence, "white-text.pdf"), pdf("0 g 20 280 320 70 re f 1 g BT /F1 20 Tf 1 0 0 1 50 320 Tm (WHITE TEXT) Tj ET"));

await check("F-07", "fixed EPUB keeps SVG circle geometry", (detail) => {
  const render = epubFixedRender('<svg viewBox="0 0 400 400"><circle cx="200" cy="200" r="80" fill="red"/></svg>', () => undefined);
  detail.render = render;
  assert.ok(render);
  // A rectangle with the circle's bounding box changes the visible author content.
  assert.ok(!render.items.some((item) => item.k === "r" && item.w === 160 && item.h === 160), "a circle is rendered as a filled square");
});

// Cross-object invariants, beyond equality of a pinned anchor row. The original note must keep
// its source resource/revision pair AND outgoing reference after a copy/skip operation.
for (const variant of ["implicit-revision-copy", "explicit-revision-replace", "copied-object-replaced-ref", "duplicate-with-skipped-revision"]) {
  await check("F-09", `mixed strategy: ${variant}`, async (detail) => {
    const ctx = await startApp();
    try {
      const book = await call(ctx, "library.importDocument", { title: "合成引用", format: "txt", bytes: [...new TextEncoder().encode("甲乙丙丁。第二段文字。")] });
      const note = await call(ctx, "notes.create", { title: "合成笔记", text: "原评论", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "甲乙丙丁" } } });
      const dir = tempProfile();
      const manifest = exportLibraryPackage(ctx.app.store, dir);
      const db = ctx.app.store.sqlite;
      const refs = () => db.prepare("SELECT id,to_id FROM refs WHERE from_object_id=? ORDER BY id").all(note.objectId);
      const beforeRefs = refs();
      const decisions = variant === "duplicate-with-skipped-revision"
        ? [{ kind: "resource_revision", id: book.revisionId, action: "skip" }]
        : [{ kind: "resource", id: book.resourceId, action: "duplicate" }, { kind: "object", id: note.objectId, action: variant === "copied-object-replaced-ref" ? "duplicate" : "skip" },
          ...(variant === "explicit-revision-replace" ? [{ kind: "resource_revision", id: book.revisionId, action: "replace" }] : [])];
      detail.strategy = variant === "duplicate-with-skipped-revision" ? "duplicate" : "replace";
      detail.decisions = decisions.map(({ kind, action }) => ({ kind, action }));
      importLibraryPackageResolved(ctx.app.store, dir, { strategy: detail.strategy, decisions });
      const after = await call(ctx, "notes.openSource", { objectId: note.objectId });
      const relation = db.prepare("SELECT a.resource_id AS anchorResource,v.resource_id AS revisionResource FROM anchors a LEFT JOIN resource_revisions v ON v.id=a.resource_revision_id WHERE a.id=?").get(manifest.anchors[0].id);
      detail.sameRevisionOwner = relation.anchorResource === relation.revisionResource;
      detail.sourceResourcePreserved = after.resourceId === book.resourceId;
      detail.openStatus = after.status;
      detail.cardStatus = after.card?.status;
      detail.originalRefsBefore = beforeRefs.length;
      detail.originalRefsAfter = refs().length;
      assert.equal(detail.sameRevisionOwner, true, "the kept anchor and its revision now have different resource owners");
      assert.equal(detail.sourceResourcePreserved, true, "opening the original note silently targets a copied resource");
      assert.equal(after.card?.status, "resolved");
      assert.deepEqual(refs(), beforeRefs, "copying a note moved an existing outgoing ref off the original note");
      for (const copy of db.prepare("SELECT id FROM content_objects WHERE type='notes.document' AND id<>?").all(note.objectId)) {
        const opened = await call(ctx, "notes.openSource", { objectId: copy.id });
        assert.equal(opened.status, "resolved");
        assert.equal(opened.card?.status, "resolved");
        assert.ok(db.prepare("SELECT id FROM refs WHERE from_object_id=? AND to_kind='anchor'").get(copy.id));
      }
    } finally { ctx.app.close(); }
  });
}

await check("F-08", "pagination keeps the full matching total on every page", async (detail) => {
  const ctx = await startApp();
  try {
    const db = ctx.app.store.sqlite;
    const insert = db.prepare("INSERT INTO resources(id,work_id,kind,title,aliases_json,created_at) VALUES (?,NULL,'novel',?,'[]',?)");
    for (let index = 0; index < 205; index++) insert.run(`a-b7-${String(index).padStart(3, "0")}`, `合成书 ${index}`, new Date(Date.UTC(2020, 0, 1) + index * 1000).toISOString());
    let cursor;
    const seen = [];
    const totals = [];
    do {
      const result = await call(ctx, "library.list", { limit: 100, query: "合成书", ...(cursor ? { cursor } : {}) });
      totals.push(result.total); seen.push(...result.items.map((item) => item.id)); cursor = result.nextCursor;
    } while (cursor && totals.length < 10);
    detail.totals = totals; detail.listed = seen.length; detail.oldestListed = seen.includes("a-b7-000");
    assert.equal(new Set(seen).size, 205);
    assert.deepEqual(totals, [205, 205, 205], "total must describe the full match set, not only the remaining suffix");
  } finally { ctx.app.close(); }
});

await check("F-08", "workspace paginates resources once even with multiple revisions", async (detail) => {
  const ctx = await startApp();
  try {
    const book = await call(ctx, "library.importDocument", { title: "多修订", format: "txt", bytes: [...new TextEncoder().encode("同一本书")] });
    const db = ctx.app.store.sqlite;
    const row = db.prepare("SELECT * FROM resource_revisions WHERE id=?").get(book.revisionId);
    const insert = db.prepare("INSERT INTO resource_revisions(id,resource_id,fingerprint,parser_version,payload_json,created_at) VALUES (?,?,?,?,?,?)");
    for (let index = 0; index < 101; index++) insert.run(`a-b7-rev-${index}`, book.resourceId, `a-b7-fp-${index}`, row.parser_version, row.payload_json, new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString());
    const workspace = await call(ctx, "workspace.get", {});
    detail.rows = workspace.resources.length;
    detail.uniqueResources = new Set(workspace.resources.map((item) => item.id)).size;
    detail.resourcePage = workspace.resourcePage;
    assert.equal(detail.rows, detail.uniqueResources, "the initial library page repeats one book for each revision");
    assert.equal(workspace.resourcePage.total, 1);
  } finally { ctx.app.close(); }
});

const report = { at: new Date().toISOString(), ...m1bFingerprints(repoRoot), scriptFingerprint: createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex"), status: observations.every((row) => row.status === "passed") ? "passed" : "rework-required", humanChecks: "not-run", productAcceptance: "not-run", observations };
fs.writeFileSync(path.join(evidence, "a-b7-deep-review.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "passed") process.exitCode = 1;
