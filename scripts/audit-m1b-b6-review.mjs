import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startApp, tempProfile } from "../tests/m1b/helpers.ts";
import { exportLibraryPackage, importLibraryPackageResolved } from "../packages/app-core/src/domain/library-package.ts";
import { m1bFingerprints } from "./m1b-fingerprint.mjs";
import { repoRoot } from "./desktop-paths.ts";

const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? "docs/evidence/m1b-reading-notes/a-b6-review");
fs.mkdirSync(evidence, { recursive: true });
const observations = [];
async function check(name, run, finding = "F-09") {
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
  } finally { ctx.app.close(); }
});

await check("a truncated library provides a continuation path for the oldest resource", async (detail) => {
  const ctx = await startApp();
  try {
    const db = ctx.app.store.sqlite;
    const resource = db.prepare("INSERT INTO resources(id,work_id,kind,title,aliases_json,created_at) VALUES (?,NULL,'novel',?,'[]',?)");
    const revision = db.prepare("INSERT INTO resource_revisions(id,resource_id,fingerprint,parser_version,payload_json,created_at) VALUES (?,?,?,'synthetic',?,?)");
    db.exec("BEGIN");
    for (let index = 0; index < 101; index += 1) {
      const date = new Date(Date.UTC(2020, 0, 1) + index * 1000).toISOString();
      resource.run(`res_a6_${index}`, `合成书 ${index}`, date);
      revision.run(`rev_a6_${index}`, `res_a6_${index}`, `fp_a6_${index}`, JSON.stringify({ normalized: `合成正文 ${index}` }), date);
    }
    db.exec("COMMIT");
    const inventory = await call(ctx, "inventory.overview", {});
    const workspace = await call(ctx, "workspace.get", {});
    detail.total = inventory.totals.resource.count;
    detail.listed = inventory.items.filter((item) => item.kind === "resource").length;
    detail.oldestInInventory = inventory.items.some((item) => item.id === "res_a6_0");
    detail.oldestInReading = workspace.resources.some((item) => item.id === "res_a6_0");
    detail.inventoryFields = Object.keys(inventory);
    detail.continuation = Boolean(inventory.nextCursor || inventory.pagination?.nextCursor || workspace.resourcePage?.nextCursor);
    assert.ok(detail.oldestInInventory || detail.oldestInReading || detail.continuation, "resource 101 is absent from both available lists and neither provides a continuation cursor; the UI has no browse/search path to it");
  } finally { ctx.app.close(); }
}, "F-08");

const report = { at: new Date().toISOString(), ...m1bFingerprints(repoRoot), scriptFingerprint: createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex"), status: observations.every((item) => item.status === "passed") ? "passed" : "rework-required", humanChecks: "not-run", productAcceptance: "not-run", observations };
fs.writeFileSync(path.join(evidence, "a-b6-deep-review.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "passed") process.exitCode = 1;
