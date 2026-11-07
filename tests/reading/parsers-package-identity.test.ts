import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildEpubFixture, parseEpubBytes, parsePdfBytes } from "@manga/app-core";
import { resolveArchiveReference } from "../../packages/app-core/src/domain/formats.ts";
import { exportLibraryPackage, importLibraryPackageResolved } from "../../packages/app-core/src/domain/library-package.ts";
import { startApp, tempProfile } from "../helpers/app.ts";

const root = path.resolve(__dirname, "..", "..");
const samples = path.join(root, "tests", "fixtures", "reading");

async function command(context: Awaited<ReturnType<typeof startApp>>, commandId: string, input: Record<string, unknown>) {
  const result = await context.app.call(context.actor, { commandId, idempotencyKey: crypto.randomUUID(), input }, context.grant.handle);
  expect(result.status, result.error?.message).toBe("ok");
  return result.value as Record<string, unknown>;
}

describe("M1b b5 rework parsers", () => {
  it("turns the ReportLab Flate RGB scan into a browser image and keeps the candidate unaccepted", async () => {
    const parsed = await parsePdfBytes(fs.readFileSync(path.join(samples, "standard-scan.pdf")));
    expect(parsed.parts).toHaveLength(1);
    expect(parsed.parts[0]?.kind).toBe("image");
    expect(parsed.parts[0]?.normalized.trim()).toBe("");
    expect(parsed.warnings.join(" ")).toMatch(/OCR/);
    expect(parsed.traits.accepted).toBe(true);
    expect(parsed.traits.pdfjsPageRendering).toBe(true);
  });

  it("keeps a dotted PDF image name and records an unmapped sample instead of dropping the page", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const content = Buffer.from("/FormXob.abc Do\n");
    const objects = [
      Buffer.from("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"),
      Buffer.from("2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj\n"),
      Buffer.from("3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Contents 5 0 R /Resources << /XObject << /FormXob.abc 4 0 R >> /Font << /F.Missing 6 0 R >> >> >> endobj\n"),
      Buffer.concat([
        Buffer.from(`4 0 obj << /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${png.length} >> stream\n`),
        png,
        Buffer.from("\nendstream\nendobj\n"),
      ]),
      Buffer.concat([
        Buffer.from(`5 0 obj << /Length ${content.length} >> stream\n`),
        content,
        Buffer.from("endstream\nendobj\n"),
      ]),
      Buffer.from("6 0 obj << /Type /Font /Subtype /Type1 /BaseFont /CustomFace >> endobj\n"),
    ];
    const header = Buffer.from("%PDF-1.4\n");
    let cursor = header.length;
    const xref = ["xref\n", `0 ${objects.length + 1}\n`, "0000000000 65535 f \n"];
    for (const object of objects) {
      xref.push(`${cursor.toString().padStart(10, "0")} 00000 n \n`);
      cursor += object.length;
    }
    const body = Buffer.concat(objects);
    const bytes = Buffer.concat([
      header,
      body,
      Buffer.from(xref.join("")),
      Buffer.from(`trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${header.length + body.length}\n%%EOF`),
    ]);
    const parsed = await parsePdfBytes(new Uint8Array(bytes));
    expect(parsed.parts).toHaveLength(1);
    expect((parsed.parts[0]?.normalized ?? "").trim()).toBe("");
    expect(parsed.traits.accepted).toBe(true);
  });

  it("resolves a parent-relative EPUB image without applying author CSS", () => {
    expect(resolveArchiveReference("OEBPS/Text/", "../Images/scan.png")).toBe("OEBPS/Images/scan.png");
    expect(resolveArchiveReference("OEBPS/Text/", "../../../secret.png")).toBeUndefined();
    const relative = parseEpubBytes(fs.readFileSync(path.join(samples, "relative-image.epub")));
    expect(relative.assets).toHaveLength(1);
    expect(relative.parts[0]?.placements?.[0]?.assetId).toBe(relative.assets[0]?.id);
    expect(relative.traits.accepted).toBe(false);
    const styled = parseEpubBytes(buildEpubFixture({ title: "样式", chapters: [{ id: "c1", title: "章", html: "<p>正文</p>" }] }));
    expect(styled.stylesheets?.some((sheet) => sheet.text.includes("SECRETSTYLE"))).toBe(true);
    expect(styled.parts.map((part) => part.normalized).join("\n")).not.toContain("SECRETSTYLE");
    expect(styled.assets.every((asset) => asset.mediaType.startsWith("image/"))).toBe(true);
    expect(styled.traits.accepted).toBe(false);
  });
});

describe("M1b b5 rework package identity", () => {
  it("keeps a non-conflicting id and aligns a duplicated note payload, history and reference", async () => {
    const source = await startApp();
    const target = await startApp();
    try {
      const book = await command(source, "library.importDocument", { title: "合成来源", format: "txt", bytes: [...new TextEncoder().encode("甲乙丙丁，合成正文。")] });
      const note = await command(source, "notes.create", {
        title: "合成锚点笔记",
        text: "我的评论",
        resourceId: book.resourceId,
        resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 4 }, quote: { exact: "甲乙丙丁" } },
      });
      source.app.store.sqlite.prepare("INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, attachment_ids_json, preview_json, created_at, updated_at) VALUES ('plugin_private','plugin.private','plugin.sample','{}',1,1,'插件',?,'[]','{}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')")
        .run(JSON.stringify({ secret: "KEEP", blocks: [{ id: "p1", anchorId: "anc_should_stay", attrs: { token: "do-not-rewrite" } }] }));
      const packageDir = tempProfile();
      const manifest = exportLibraryPackage(source.app.store, packageDir);
      const noteRow = manifest.objects.find((row) => row.id === note.objectId);
      const payload = JSON.parse(noteRow!.payload_json) as { blocks: Array<{ attrs?: { plugin: string } }> };
      payload.blocks[0]!.attrs = { plugin: "KEEP-ATTR" };
      noteRow!.payload_json = JSON.stringify(payload);
      for (const revision of manifest.objectRevisions.filter((row) => row.object_id === note.objectId)) {
        const historic = JSON.parse(revision.payload_json) as { blocks?: Array<{ attrs?: { plugin: string } }> };
        if (historic.blocks?.[0]) historic.blocks[0].attrs = { plugin: "KEEP-ATTR" };
        revision.payload_json = JSON.stringify(historic);
      }
      fs.writeFileSync(path.join(packageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      const existing = await command(target, "library.importDocument", { title: "目标已有书", format: "txt", bytes: [65, 66, 67] });
      importLibraryPackageResolved(target.app.store, packageDir, { strategy: "duplicate" });
      const copiedResource = target.app.store.sqlite.prepare("SELECT id FROM resources").all() as Array<{ id: string }>;
      expect(copiedResource.find((row) => row.id !== existing.resourceId)?.id).toBe(book.resourceId);

      importLibraryPackageResolved(source.app.store, packageDir, { strategy: "duplicate" });
      const copy = source.app.store.sqlite.prepare("SELECT id, payload_json FROM content_objects WHERE type = 'notes.document' AND id <> ?").get(note.objectId) as { id: string; payload_json: string };
      const quote = (JSON.parse(copy.payload_json) as { blocks: Array<{ id: string; anchorId?: string; attrs?: { plugin?: string } }> }).blocks.find((block) => block.anchorId);
      const ref = source.app.store.sqlite.prepare("SELECT to_id FROM refs WHERE from_object_id = ? AND from_block_id = ?").get(copy.id, quote!.id) as { to_id: string };
      expect(quote?.anchorId).toBe(ref.to_id);
      expect(quote?.attrs?.plugin).toBe("KEEP-ATTR");
      const history = source.app.store.sqlite.prepare("SELECT payload_json FROM object_revisions WHERE object_id = ?").all(copy.id) as Array<{ payload_json: string }>;
      expect(history.length).toBeGreaterThan(0);
      for (const row of history) {
        const block = (JSON.parse(row.payload_json) as { blocks?: Array<{ anchorId?: string; attrs?: { plugin?: string } }> }).blocks?.find((item) => item.anchorId);
        expect(block?.anchorId).toBe(quote?.anchorId);
        expect(block?.attrs?.plugin).toBe("KEEP-ATTR");
      }
      const plugin = source.app.store.sqlite.prepare("SELECT payload_json FROM content_objects WHERE type = 'plugin.private' AND id <> 'plugin_private'").get() as { payload_json: string };
      expect(JSON.parse(plugin.payload_json)).toEqual({ secret: "KEEP", blocks: [{ id: "p1", anchorId: "anc_should_stay", attrs: { token: "do-not-rewrite" } }] });

      const before = (source.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM anchors").get() as { n: number }).n;
      importLibraryPackageResolved(source.app.store, packageDir, { strategy: "duplicate", decisions: [{ kind: "anchor", id: manifest.anchors[0]!.id, action: "skip" }] });
      expect((source.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM anchors").get() as { n: number }).n).toBe(before);
      expect((source.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM anchors WHERE id IS NULL OR id = ''").get() as { n: number }).n).toBe(0);
    } finally {
      source.app.close();
      target.app.close();
    }
  });

  it("applies skip and duplicate per row and continues when an illustration or hosted file is missing", async () => {
    const source = await startApp();
    const target = await startApp();
    try {
      const book = await command(source, "library.importDocument", { title: "两锚点", format: "txt", hosted: true, bytes: [...new TextEncoder().encode("甲乙丙丁戊己庚辛")] });
      const first = await command(source, "notes.create", {
        title: "锚点甲", text: "评论甲", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 2 }, quote: { exact: "甲乙" } },
      });
      const second = await command(source, "notes.create", {
        title: "锚点乙", text: "评论乙", resourceId: book.resourceId, resourceRevisionId: book.revisionId,
        locator: { kind: "text", partId: "body", representationId: book.revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 2, end: 4 }, quote: { exact: "丙丁" } },
      });
      const packageDir = tempProfile();
      const manifest = exportLibraryPackage(source.app.store, packageDir);
      const skippedAnchor = manifest.anchors.find((row) => manifest.refs.some((ref) => ref.to_id === row.id && ref.from_object_id === first.objectId))!;
      const keptAnchor = manifest.anchors.find((row) => manifest.refs.some((ref) => ref.to_id === row.id && ref.from_object_id === second.objectId))!;
      const before = (source.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM anchors").get() as { n: number }).n;
      const sourceFile = source.app.store.sqlite.prepare("SELECT relative_path FROM file_locations WHERE hosted = 1").get() as { relative_path: string };
      const sourceBytes = fs.readFileSync(sourceFile.relative_path);
      importLibraryPackageResolved(source.app.store, packageDir, {
        strategy: "duplicate",
        decisions: [{ kind: "anchor", id: skippedAnchor.id, action: "skip" }],
      });
      expect((source.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM anchors").get() as { n: number }).n).toBe(before + 1);
      const copies = source.app.store.sqlite.prepare("SELECT id, title, payload_json FROM content_objects WHERE type = 'notes.document' AND id NOT IN (?, ?)").all(first.objectId, second.objectId) as Array<{ id: string; title: string; payload_json: string }>;
      const skippedCopy = copies.find((row) => row.title === "锚点甲")!;
      const keptCopy = copies.find((row) => row.title === "锚点乙")!;
      const skippedBlock = (JSON.parse(skippedCopy.payload_json) as { blocks: Array<{ id: string; anchorId?: string }> }).blocks[0]!;
      const keptBlock = (JSON.parse(keptCopy.payload_json) as { blocks: Array<{ id: string; anchorId?: string }> }).blocks[0]!;
      const skippedRef = source.app.store.sqlite.prepare("SELECT to_id FROM refs WHERE from_object_id = ?").get(skippedCopy.id) as { to_id: string } | undefined;
      const keptRef = source.app.store.sqlite.prepare("SELECT to_id FROM refs WHERE from_object_id = ?").get(keptCopy.id) as { to_id: string };
      expect(skippedBlock.anchorId).toBe(skippedAnchor.id);
      expect(skippedRef?.to_id).toBe(skippedAnchor.id);
      expect(keptBlock.anchorId).toBe(keptRef.to_id);
      expect(keptBlock.anchorId).not.toBe(keptAnchor.id);
      expect(fs.readFileSync(sourceFile.relative_path).equals(sourceBytes)).toBe(true);

      const hostedName = path.basename(sourceFile.relative_path);
      fs.rmSync(path.join(packageDir, "attachments", hostedName));
      importLibraryPackageResolved(target.app.store, packageDir, { strategy: "duplicate" });
      const imported = target.app.store.sqlite.prepare("SELECT available, hosted FROM file_locations").get() as { available: number; hosted: number };
      expect(imported.hosted).toBe(1);
      expect(imported.available).toBe(0);
      expect(target.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get()).toEqual({ n: 1 });
      expect((source.app.store.sqlite.prepare("SELECT available FROM file_locations WHERE hosted = 1").get() as { available: number }).available).toBe(1);
      expect(fs.readFileSync(sourceFile.relative_path).equals(sourceBytes)).toBe(true);
    } finally {
      source.app.close();
      target.app.close();
    }
  });
});
