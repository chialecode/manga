import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startApp, tempProfile } from "../tests/m1b/helpers.ts";
import { exportLibraryPackage, importLibraryPackageResolved } from "../packages/app-core/src/domain/library-package.ts";
import { parsePdfBytes } from "../packages/app-core/src/domain/formats.ts";
import { m1bFingerprints } from "./m1b-fingerprint.mjs";
import { repoRoot } from "./desktop-paths.ts";

const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? "docs/evidence/m1b-reading-notes/a-b5-review");
fs.mkdirSync(evidence, { recursive: true });
const observations = [];
async function check(finding, name, run) {
  const detail = {};
  try { await run(detail); observations.push({ finding, name, status: "passed", detail }); }
  catch (error) { observations.push({ finding, name, status: "failed", actual: error.message, detail }); }
}
async function command(ctx, commandId, input) {
  const result = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: crypto.randomUUID(), input }, ctx.grant.handle);
  assert.equal(result.status, "ok", result.error?.code);
  return result.value;
}
async function fixture() {
  const ctx = await startApp();
  const book = await command(ctx, "library.importDocument", { title: "合成依赖图", format: "txt", bytes: [...new TextEncoder().encode("甲乙丙丁，合成依赖图正文。")] });
  const note = await command(ctx, "notes.create", {
    title: "合成来源笔记", text: "保留来源", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
    locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "甲乙丙丁" } },
  });
  const dir = tempProfile();
  const manifest = exportLibraryPackage(ctx.app.store, dir);
  return { ctx, book, note, dir, manifest };
}

await check("F-09", "skip an existing resource while duplicating its note keeps a resolvable source", async (detail) => {
  const { ctx, book, note, dir } = await fixture();
  try {
    importLibraryPackageResolved(ctx.app.store, dir, { strategy: "duplicate", decisions: [{ kind: "resource", id: book.resourceId, action: "skip" }] });
    const db = ctx.app.store.sqlite;
    const copy = db.prepare("SELECT id, payload_json FROM content_objects WHERE type='notes.document' AND id <> ?").get(note.objectId);
    const anchorId = JSON.parse(copy.payload_json).blocks.find((block) => block.anchorId)?.anchorId;
    const ref = db.prepare("SELECT to_id FROM refs WHERE from_object_id=?").get(copy.id);
    detail.copyId = copy.id;
    detail.payloadAnchor = anchorId;
    detail.refTarget = ref?.to_id;
    detail.anchorExists = Boolean(db.prepare("SELECT id FROM anchors WHERE id=?").get(anchorId));
    assert.equal(detail.anchorExists, true, "duplicate note and ref point to an anchor that was never inserted after its resource was skipped");
  } finally { ctx.app.close(); }
});

await check("F-09", "skip a colliding revision preserves its text and search index", async (detail) => {
  const { ctx, book, dir, manifest } = await fixture();
  try {
    const revision = manifest.revisions.find((row) => row.id === book.revisionId);
    const payload = JSON.parse(revision.payload_json);
    for (const part of payload.parts ?? []) part.normalized = "package-only-sentinel";
    if (typeof payload.normalized === "string") payload.normalized = "package-only-sentinel";
    revision.payload_json = JSON.stringify(payload);
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    const before = ctx.app.store.sqlite.prepare("SELECT payload_json FROM resource_revisions WHERE id=?").get(book.revisionId).payload_json;
    importLibraryPackageResolved(ctx.app.store, dir, { strategy: "replace", decisions: [{ kind: "resource_revision", id: book.revisionId, action: "skip" }] });
    const after = ctx.app.store.sqlite.prepare("SELECT payload_json FROM resource_revisions WHERE id=?").get(book.revisionId).payload_json;
    const fragments = ctx.app.store.sqlite.prepare("SELECT text FROM text_fragments WHERE resource_revision_id=?").all(book.revisionId);
    detail.payloadPreserved = before === after;
    detail.indexContainsSkippedText = fragments.some((row) => row.text.includes("package-only-sentinel"));
    assert.equal(detail.payloadPreserved, true);
    assert.equal(detail.indexContainsSkippedText, false, "search indexed the rejected package revision instead of the preserved local revision");
  } finally { ctx.app.close(); }
});

// A complete classic-xref PDF with an explicit ToUnicode mapping: code 0x41 maps to U+4E2D.
// Copy/search must use the character map, even if a font uses a different glyph code internally.
function mappedPdf() {
  const stream = (s) => `<< /Length ${Buffer.byteLength(s, "latin1")} >>\nstream\n${s}\nendstream`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode 6 0 R >>",
    stream("BT /F1 18 Tf 30 350 Td (A) Tj ET"),
    stream("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /SyntheticUnicode def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n1 beginbfchar\n<41> <4E2D>\nendbfchar\nendcmap\nCMapName currentdict /CMap defineresource pop\nend end"),
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(body, "latin1")); body += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer << /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
await check("F-07", "PDF text uses an explicit Unicode character map", async (detail) => {
  const sample = mappedPdf();
  fs.writeFileSync(path.join(evidence, "unicode-map.pdf"), sample);
  const parsed = await parsePdfBytes(sample);
  detail.expected = "中";
  detail.actual = parsed.parts.map((part) => part.normalized).join("").trim();
  detail.unmappedFonts = parsed.traits.unmappedFonts;
  detail.warnings = parsed.warnings;
  detail.sha256 = createHash("sha256").update(sample).digest("hex");
  assert.equal(detail.actual, detail.expected, "ToUnicode is reported as mapped but is never applied to the extracted text");
});

const report = { at: new Date().toISOString(), ...m1bFingerprints(repoRoot), scriptFingerprint: createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex"), status: observations.every((row) => row.status === "passed") ? "passed" : "rework-required", productAcceptance: "not-run", humanChecks: "not-run", observations };
fs.writeFileSync(path.join(evidence, "a-b5-deep-review.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "passed") process.exitCode = 1;
