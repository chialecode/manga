import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { startApp, tempProfile } from "../tests/m1b/helpers.ts";
import { exportLibraryPackage, importLibraryPackageResolved } from "../packages/app-core/src/domain/library-package.ts";
import { parsePdfBytes, parseEpubBytes } from "../packages/app-core/src/domain/formats.ts";
import { m1bFingerprints } from "./m1b-fingerprint.mjs";
import { repoRoot } from "./desktop-paths.ts";

const evidence = path.resolve(repoRoot, process.env.M1B_EVIDENCE_DIR ?? "docs/evidence/m1b-reading-notes/a-recheck");
fs.mkdirSync(evidence, { recursive: true });
const observations = [];
async function check(finding, name, run) {
  try {
    const detail = await run();
    observations.push({ finding, name, status: "passed", detail });
  } catch (error) {
    observations.push({ finding, name, status: "failed", actual: error.message });
  }
}
const source = await startApp();
const target = await startApp();
async function command(context, commandId, input) {
  const result = await context.app.call(context.actor, { commandId, idempotencyKey: crypto.randomUUID(), input }, context.grant.handle);
  assert.equal(result.status, "ok", result.error?.code ?? "command failed");
  return result.value;
}
const bookInput = { title: "合成来源", format: "txt", bytes: [...new TextEncoder().encode("甲乙丙丁，合成正文。")] };
try {
  const book = await command(source, "library.importDocument", bookInput);
  const note = await command(source, "notes.create", {
    title: "合成锚点笔记", text: "我的评论", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
    locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "甲乙丙丁" } },
  });
  const packageDir = tempProfile();
  const manifest = exportLibraryPackage(source.app.store, packageDir);
  await check("F-09", "duplicate import preserves non-conflicting identities", async () => {
    const existing = await command(target, "library.importDocument", { ...bookInput, title: "目标已有书", bytes: [65, 66, 67] });
    importLibraryPackageResolved(target.app.store, packageDir, { strategy: "duplicate" });
    const row = target.app.store.sqlite.prepare("SELECT id FROM resources").all().find((item) => item.id !== existing.resourceId);
    assert.equal(row?.id, book.resourceId, "non-conflicting resource id became null instead of retaining the package id");
  });
  await check("F-09", "duplicated note payload and reference use the same remapped anchor", async () => {
    importLibraryPackageResolved(source.app.store, packageDir, { strategy: "duplicate" });
    const copy = source.app.store.sqlite.prepare("SELECT id, payload_json FROM content_objects WHERE id <> ?").get(note.objectId);
    const quote = JSON.parse(copy.payload_json).blocks.find((block) => block.anchorId);
    const ref = source.app.store.sqlite.prepare("SELECT to_id FROM refs WHERE from_object_id = ? AND from_block_id = ?").get(copy.id, quote.id);
    assert.equal(quote.anchorId, ref.to_id, "duplicated block retains the old anchor while its reference points to the new anchor");
  });
  await check("F-09", "per-row skip of a conflicting anchor succeeds", async () => {
    const before = source.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM anchors").get().n;
    importLibraryPackageResolved(source.app.store, packageDir, { strategy: "duplicate", decisions: [{ kind: "anchor", id: manifest.anchors[0].id, action: "skip" }] });
    assert.equal(source.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM anchors").get().n, before, "skip inserted an additional anchor with a null id");
  });
  await check("F-07", "standard Flate RGB scan produces a browser-decodable image", async () => {
    const parsed = await parsePdfBytes(fs.readFileSync(path.join(evidence, "standard-scan.pdf")));
    assert.equal(parsed.parts.length, 1);
    assert.equal(parsed.parts[0].kind, "image", "the scan page was given selectable text");
    assert.equal((parsed.parts[0].normalized ?? "").trim(), "");
    assert.match(parsed.warnings.join("\n"), /OCR/);
    assert.equal(parsed.traits.pdfjsPageRendering, true);
  });
  await check("F-07", "EPUB resolves a sibling image using a parent-relative path", async () => {
    const parsed = parseEpubBytes(fs.readFileSync(path.join(evidence, "relative-image.epub")));
    assert.equal(parsed.assets.length, 1, "declared ../Images/scan.png was silently dropped");
  });
} finally {
  source.app.close();
  target.app.close();
}
const report = { at: new Date().toISOString(), ...m1bFingerprints(repoRoot), status: observations.some((row) => row.status === "failed") ? "rework-required" : "passed", productAcceptance: "not-run", humanChecks: "not-run", observations };
fs.writeFileSync(path.join(evidence, "a-adversarial-review.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (report.status !== "passed") process.exitCode = 1;
