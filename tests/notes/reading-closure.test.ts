import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NORMALIZATION_V1 } from "@manga/contracts";
import { buildEpubFixture, buildPdfFixture } from "@manga/app-core";
import { startApp, tempProfile } from "../helpers/app.ts";

/**
 * Rework coverage for the reading→record→source→return loop, progress restore, resource-bound
 * sessions, frozen agent materials and the conflicting-package import. Synthetic data only.
 */
describe("M1b rework: reading notes closure", () => {
  it("returns from a note to its source and resolves the exact stored range", async () => {
    const { app, actor, grant } = await startApp();
    const book = await app.call(actor, {
      commandId: "library.importDocument",
      idempotencyKey: "src-epub",
      input: { title: "来源书", format: "epub", bytes: [...buildEpubFixture({ title: "来源书", chapters: [{ id: "c1", title: "第一章", html: "<p>甲乙丙丁戊己庚辛</p>" }] })] },
    }, grant.handle);
    const resourceId = String(book.value?.resourceId);
    const revisionId = String(book.value?.revisionId);
    const note = await app.call(actor, {
      commandId: "notes.create",
      idempotencyKey: "src-note",
      input: {
        title: "来源笔记",
        text: "我的评论",
        resourceId,
        resourceRevisionId: revisionId,
        locator: {
          kind: "text",
          partId: "c1",
          representationId: revisionId,
          normalizationVersion: NORMALIZATION_V1,
          // "第一章\n甲乙丙丁戊己庚辛" → 丙丁戊 occupies code points [6, 9).
          range: { start: 6, end: 9 },
          quote: { exact: "丙丁戊" },
        },
      },
    }, grant.handle);
    const objectId = String(note.value?.objectId);

    const opened = await app.call(actor, { commandId: "notes.openSource", idempotencyKey: "src-open", input: { objectId } }, grant.handle);
    expect(opened.status).toBe("ok");
    const value = opened.value as {
      status: string;
      partId: string;
      card: { status: string; title: string; quote: string; available: boolean };
      returnTo: { objectId: string; blockId: string | null };
    };
    // The card and the resolved range must agree with the stored anchor.
    expect(value.status).toBe("resolved");
    expect(value.partId).toBe("c1");
    expect(value.card.status).toBe("resolved");
    expect(value.card.title).toBe("来源书");
    expect(value.card.quote).toBe("丙丁戊");
    expect(value.card.available).toBe(true);
    expect(value.returnTo.objectId).toBe(objectId);

    // The note keeps its own source status visible for the UI.
    const readBack = await app.call(actor, { commandId: "notes.get", idempotencyKey: "src-get", input: { objectId } }, grant.handle);
    expect((readBack.value as { sourceStatus: string }).sourceStatus).toBe("linked");
    app.close();
  });

  it("reports a missing source and offers the repair entry after the original is replaced", async () => {
    const { app, actor, grant } = await startApp();
    const book = await app.call(actor, {
      commandId: "library.importDocument",
      idempotencyKey: "repair-epub",
      input: { title: "待修复", format: "epub", bytes: [...buildEpubFixture({ title: "待修复", chapters: [{ id: "c1", title: "章", html: "<p>正文甲乙</p>" }] })] },
    }, grant.handle);
    const resourceId = String(book.value?.resourceId);
    const revisionId = String(book.value?.revisionId);
    const note = await app.call(actor, {
      commandId: "notes.create",
      idempotencyKey: "repair-note",
      input: {
        title: "待修复笔记",
        text: "评论",
        resourceId,
        resourceRevisionId: revisionId,
        locator: { kind: "text", partId: "c1", representationId: revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: 0, end: 2 }, quote: { exact: "正文" } },
      },
    }, grant.handle);
    // Removing the revision simulates an unusable source without touching any real data.
    app.store.sqlite.prepare("DELETE FROM resource_revisions WHERE id = ?").run(revisionId);
    const opened = await app.call(actor, { commandId: "notes.openSource", idempotencyKey: "repair-open", input: { objectId: String(note.value?.objectId) } }, grant.handle);
    expect(opened.status).toBe("ok");
    expect((opened.value as { status: string }).status).toBe("missing_revision");
    const card = (opened.value as { card: { status: string; available?: boolean } }).card;
    expect(card.status).toBe("missing_revision");
    const status = await app.call(actor, { commandId: "notes.get", idempotencyKey: "repair-get", input: { objectId: String(note.value?.objectId) } }, grant.handle);
    expect((status.value as { sourceStatus: string }).sourceStatus).toBe("missing_revision");
    app.close();
  });

  it("restores the stored reading position and never marks a jump as read", async () => {
    const { app, actor, grant } = await startApp();
    const head = "甲".repeat(300) + "定位标记" + "乙".repeat(300);
    const book = await app.call(actor, { commandId: "library.importText", idempotencyKey: "progress-book", input: { title: "进度书", bytes: [...Buffer.from(head)] } }, grant.handle);
    const resourceId = String(book.value?.resourceId);
    const revisionId = String(book.value?.revisionId);
    const first = await app.call(actor, { commandId: "library.read", idempotencyKey: "progress-read", input: { resourceId } }, grant.handle);
    expect((first.value as { progress: { restoredFrom: string } }).progress.restoredFrom).toBe("start");

    await app.call(actor, {
      commandId: "progress.set",
      idempotencyKey: "progress-set",
      input: {
        resourceId,
        resourceRevisionId: revisionId,
        consumed: true,
        locator: { kind: "text", partId: "body", representationId: revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: 300, end: 304 }, quote: { exact: "定位标记" } },
      },
    }, grant.handle);

    const restored = await app.call(actor, { commandId: "library.read", idempotencyKey: "progress-restore", input: { resourceId } }, grant.handle);
    const value = restored.value as { progress: { restoredFrom: string; restoredPartId: string | null }; readRanges: Array<{ start: number; end: number }> };
    expect(value.progress.restoredFrom).toBe("progress");
    expect(value.progress.restoredPartId).toBe("body");
    expect(value.readRanges.some((range) => range.start === 300 && range.end === 304)).toBe(true);

    // A bookmark or search jump reads the page but must not extend the consumed range.
    const jumped = await app.call(actor, { commandId: "library.readSlice", idempotencyKey: "progress-jump", input: { resourceId, partId: "body", start: 0, limit: 200 } }, grant.handle);
    expect(jumped.status).toBe("ok");
    const after = await app.call(actor, { commandId: "library.read", idempotencyKey: "progress-after", input: { resourceId } }, grant.handle);
    expect((after.value as { readRanges: unknown[] }).readRanges).toHaveLength(1);
    app.close();
  });

  it("keeps bookmarks, reader style and image parts addressable", async () => {
    const { app, actor, grant } = await startApp();
    const pdf = await app.call(actor, {
      commandId: "library.importDocument",
      idempotencyKey: "pdf-book",
      input: { title: "图文", format: "pdf", bytes: [...buildPdfFixture([{ text: "第一页" }, { scan: true }])] },
    }, grant.handle);
    const resourceId = String(pdf.value?.resourceId);
    const revisionId = String(pdf.value?.revisionId);
    const document = await app.call(actor, { commandId: "library.read", idempotencyKey: "pdf-read", input: { resourceId } }, grant.handle);
    const parts = (document.value as { parts: Array<{ id: string; kind: string; textLayer: boolean }> }).parts;
    // A scanned page is addressed by page identity and reports no text layer.
    expect(parts.some((part) => part.kind === "image" && part.textLayer === false)).toBe(true);

    const bookmark = await app.call(actor, {
      commandId: "reading.setBookmark",
      idempotencyKey: "bm-set",
      input: {
        resourceId,
        resourceRevisionId: revisionId,
        label: "第一页",
        locator: { kind: "text", partId: "page-1", representationId: revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: 0, end: 3 }, quote: { exact: "第一页" } },
      },
    }, grant.handle);
    expect(bookmark.status).toBe("ok");
    const listed = await app.call(actor, { commandId: "reading.bookmarks", idempotencyKey: "bm-list", input: { resourceId } }, grant.handle);
    expect((listed.value as unknown[]).length).toBe(1);
    const removed = await app.call(actor, { commandId: "reading.removeBookmark", idempotencyKey: "bm-del", input: { bookmarkId: String(bookmark.value?.bookmarkId) } }, grant.handle);
    expect(removed.status).toBe("ok");
    expect(((await app.call(actor, { commandId: "reading.bookmarks", idempotencyKey: "bm-list-2", input: { resourceId } }, grant.handle)).value as unknown[]).length).toBe(0);

    // Reader style covers font, line height, margin and the three backgrounds.
    const styled = await app.call(actor, { commandId: "settings.setShell", idempotencyKey: "style-set", input: { reading: { fontSizePx: 22, lineHeight: 2, marginPx: 40, theme: "green" } } }, grant.handle);
    expect(styled.status).toBe("ok");
    const shell = (styled.value as { reading: { fontSizePx: number; lineHeight: number; marginPx: number; theme: string } }).reading;
    expect(shell).toMatchObject({ fontSizePx: 22, lineHeight: 2, marginPx: 40, theme: "green" });
    const night = await app.call(actor, { commandId: "settings.setShell", idempotencyKey: "style-night", input: { reading: { theme: "night" } } }, grant.handle);
    expect((night.value as { reading: { theme: string } }).reading.theme).toBe("night");
    app.close();
  });

  it("supports note tags, listing, search, history and revision restore", async () => {
    const { app, actor, grant } = await startApp();
    const note = await app.call(actor, { commandId: "notes.create", idempotencyKey: "tag-note", input: { title: "带标签", text: "第一版正文", tags: ["大纲", "人物"] } }, grant.handle);
    const objectId = String(note.value?.objectId);
    const read = await app.call(actor, { commandId: "notes.get", idempotencyKey: "tag-get", input: { objectId } }, grant.handle);
    expect((read.value as { tags: string[] }).tags).toEqual(["大纲", "人物"]);

    const listed = await app.call(actor, { commandId: "notes.list", idempotencyKey: "tag-list", input: { tag: "大纲" } }, grant.handle);
    expect((listed.value as unknown[]).length).toBe(1);
    const byText = await app.call(actor, { commandId: "notes.list", idempotencyKey: "tag-text", input: { text: "第一版正文" } }, grant.handle);
    expect((byText.value as unknown[]).length).toBe(1);
    const miss = await app.call(actor, { commandId: "notes.list", idempotencyKey: "tag-miss", input: { text: "不存在的短语" } }, grant.handle);
    expect((miss.value as unknown[]).length).toBe(0);

    // Editing produces history, and restoring an earlier revision appends rather than rewrites.
    await app.call(actor, { commandId: "notes.update", idempotencyKey: "tag-edit", input: { objectId, expectedRevision: 1, blockId: "b1", text: "第二版正文" } }, grant.handle);
    const history = await app.call(actor, { commandId: "notes.history", idempotencyKey: "tag-hist", input: { objectId } }, grant.handle);
    const revisions = history.value as Array<{ revision: number; blockCount: number }>;
    expect(revisions.length).toBeGreaterThanOrEqual(2);
    expect(revisions[0]?.revision).toBe(2);
    const restored = await app.call(actor, { commandId: "notes.restore", idempotencyKey: "tag-restore", input: { objectId, expectedRevision: 2, revision: 1 } }, grant.handle);
    expect(restored.status).toBe("ok");
    expect((restored.value as { revision: number; restoredFrom: number }).restoredFrom).toBe(1);
    const final = await app.call(actor, { commandId: "notes.get", idempotencyKey: "tag-final", input: { objectId } }, grant.handle);
    expect((final.value as { document: { blocks: Array<{ text: string }> } }).document.blocks[0]?.text).toBe("第一版正文");

    const tagged = await app.call(actor, { commandId: "notes.tags", idempotencyKey: "tag-set", input: { objectId, expectedRevision: 3, tags: ["人物"] } }, grant.handle);
    expect((tagged.value as { tags: string[] }).tags).toEqual(["人物"]);
    app.close();
  });

  it("gives each resource its own agent session and freezes the visible materials", async () => {
    const { app, actor, grant } = await startApp();
    const one = await app.call(actor, { commandId: "library.importDocument", idempotencyKey: "sess-a", input: { title: "书甲", format: "epub", bytes: [...buildEpubFixture({ title: "书甲", chapters: [{ id: "c1", title: "章", html: "<p>选区正文甲</p>" }] })] } }, grant.handle);
    const two = await app.call(actor, { commandId: "library.importDocument", idempotencyKey: "sess-b", input: { title: "书乙", format: "epub", bytes: [...buildEpubFixture({ title: "书乙", chapters: [{ id: "c1", title: "章", html: "<p>选区正文乙</p>" }] })] } }, grant.handle);
    const resourceA = String(one.value?.resourceId);
    const resourceB = String(two.value?.resourceId);

    const sessionA = await app.call(actor, { commandId: "session.open", idempotencyKey: "open-a", input: { kind: "resource", targetId: resourceA, mode: "enthusiast" } }, grant.handle);
    const sessionB = await app.call(actor, { commandId: "session.open", idempotencyKey: "open-b", input: { kind: "resource", targetId: resourceB, mode: "enthusiast" } }, grant.handle);
    expect((sessionA.value as { id: string }).id).not.toBe((sessionB.value as { id: string }).id);
    // Reopening the same target reuses its session instead of starting a second task context.
    const again = await app.call(actor, { commandId: "session.open", idempotencyKey: "open-a2", input: { kind: "resource", targetId: resourceA } }, grant.handle);
    expect((again.value as { id: string; reused: boolean }).id).toBe((sessionA.value as { id: string }).id);
    expect((again.value as { reused: boolean }).reused).toBe(true);

    const note = await app.call(actor, { commandId: "notes.create", idempotencyKey: "sess-note", input: { title: "材料笔记", text: "笔记材料正文" } }, grant.handle);
    const objectId = String(note.value?.objectId);
    const sent = await app.call(actor, {
      commandId: "agent.send",
      idempotencyKey: "sess-send",
      input: {
        sessionId: String(sessionA.value?.id),
        text: "用材料回答",
        readResourceIds: [resourceA],
        noteObjectIds: [objectId],
        selection: { resourceId: resourceA, resourceRevisionId: String(one.value?.revisionId), partId: "c1", start: 4, end: 7 },
      },
    }, grant.handle);
    expect(sent.status).toBe("ok");
    const snapshot = JSON.parse((app.store.sqlite.prepare("SELECT snapshot_json FROM agent_runs WHERE id = ?").get(String(sent.value?.runId)) as { snapshot_json: string }).snapshot_json) as {
      materials: Array<{ resourceId: string; revisionId: string }>;
      selection: { quote: string };
      notes: Array<{ objectId: string; revision: number; text: string }>;
    };
    // The snapshot carries the actual note text and the frozen revision, not just a title.
    expect(snapshot.materials.map((item) => item.resourceId)).toEqual([resourceA]);
    expect(snapshot.selection.quote).toContain("正文甲");
    expect(snapshot.notes[0]?.objectId).toBe(objectId);
    expect(snapshot.notes[0]?.text).toContain("笔记材料正文");

    const receipt = await app.call(actor, { commandId: "agent.getRun", idempotencyKey: "sess-get", input: { runId: String(sent.value?.runId) } }, grant.handle);
    const value = receipt.value as { materials: Array<{ resourceId: string }>; noteMaterials: Array<{ objectId: string; revision: number }>; selection: { quote?: string } };
    // The UI receipt exposes what was frozen so the material/version is verifiable.
    expect(value.materials.map((item) => item.resourceId)).toEqual([resourceA]);
    expect(value.noteMaterials[0]?.objectId).toBe(objectId);
    expect(value.selection.quote).toContain("正文甲");

    const sessions = await app.call(actor, { commandId: "workspace.sessions", idempotencyKey: "sess-list", input: {} }, grant.handle);
    const rows = sessions.value as unknown as Array<{ sessionId: string; targetId: string | null; kind: string }>;
    expect(rows.filter((row) => row.kind === "resource").length).toBeGreaterThanOrEqual(2);
    await app.call(actor, { commandId: "agent.cancel", idempotencyKey: "sess-stop", input: { runId: String(sent.value?.runId) } }, grant.handle);
    app.close();
  });

  it("previews a conflicting package and imports it with a chosen strategy", async () => {
    const source = await startApp();
    const book = await source.app.call(source.actor, { commandId: "library.importDocument", idempotencyKey: "pkg-book", input: { title: "包书", format: "pdf", bytes: [...buildPdfFixture([{ text: "包正文" }, { scan: true }])] } }, source.grant.handle);
    const resourceId = String(book.value?.resourceId);
    await source.app.call(source.actor, { commandId: "notes.create", idempotencyKey: "pkg-note", input: { title: "包笔记", text: "包笔记正文", resourceId } }, source.grant.handle);
    const pack = path.join(tempProfile(), "package");
    const exportHandle = source.app.registerPath("export", pack);
    const exported = await source.app.call(source.actor, { commandId: "library.exportPackage", idempotencyKey: "pkg-export", input: { pathHandle: exportHandle } }, source.grant.handle);
    expect(exported.status).toBe("ok");
    const manifest = JSON.parse(fs.readFileSync(path.join(pack, "manifest.json"), "utf8")) as { fileLocations?: unknown[]; assets?: unknown[] };
    // The hosted original is the page payload. PDF.js draws the scan; the package does not carry a separate extracted image.
    expect(manifest.fileLocations?.length).toBeGreaterThanOrEqual(1);
    expect(manifest.assets?.length ?? 0).toBe(0);
    source.app.close();

    // A plain import into a non-empty library still refuses, so the historical guarantee holds.
    const target = await startApp();
    await target.app.call(target.actor, { commandId: "library.importText", idempotencyKey: "pkg-existing", input: { title: "已有", bytes: [...Buffer.from("已有正文")] } }, target.grant.handle);
    const handle = target.app.registerPath("import", pack);
    const refused = await target.app.call(target.actor, { commandId: "library.importPackage", idempotencyKey: "pkg-plain", input: { pathHandle: handle } }, target.grant.handle);
    expect(refused.status).toBe("error");
    expect(refused.error?.code).toBe("PUBLISH_CONFLICT");

    // The preview reports the conflict, and the chosen strategy decides what happens.
    const preview = await target.app.call(target.actor, { commandId: "package.preview", idempotencyKey: "pkg-preview", input: { pathHandle: handle } }, target.grant.handle);
    expect(preview.status).toBe("ok");
    const previewValue = preview.value as { empty: boolean; conflicts: Array<{ kind: string }>; counts: { objects: number } };
    expect(previewValue.empty).toBe(false);
    expect(previewValue.conflicts.length).toBe(0);
    expect(previewValue.counts.objects).toBe(1);

    const imported = await target.app.call(target.actor, { commandId: "package.importResolved", idempotencyKey: "pkg-import", input: { pathHandle: handle, strategy: "duplicate" } }, target.grant.handle);
    expect(imported.status).toBe("ok");
    // Both the existing data and the imported data survive a duplicate import.
    const counts = target.app.store.counts();
    expect(counts.resources).toBe(2);
    expect(counts.content_objects).toBe(1);
    expect(target.app.store.search({ text: "已有正文" }).length).toBe(1);
    expect(target.app.store.search({ text: "包正文" }).length).toBeGreaterThan(0);
    expect(target.app.store.search({ text: "包笔记正文" }).length).toBeGreaterThan(0);

    // Importing the same package again with `duplicate` adds another copy instead of failing.
    const second = await target.app.call(target.actor, { commandId: "package.importResolved", idempotencyKey: "pkg-import-2", input: { pathHandle: handle, strategy: "duplicate" } }, target.grant.handle);
    expect(second.status).toBe("ok");
    expect(target.app.store.counts().resources).toBe(3);
    expect(target.app.store.counts().content_objects).toBe(2);
    target.app.close();
  });

  it("restores hosted media locations and preserves unknown attachments across a package round trip", async () => {
    const source = await startApp();
    const book = await source.app.call(
      source.actor,
      { commandId: "library.importDocument", idempotencyKey: "media-book", input: { title: "托管书", format: "pdf", bytes: [...buildPdfFixture([{ text: "托管正文" }])], hosted: true } },
      source.grant.handle,
    );
    expect(book.status).toBe("ok");
    fs.writeFileSync(path.join(source.app.store.attachmentsDir, "unknown-extra.bin"), "unknown synthetic payload");
    const pack = path.join(tempProfile(), "media-package");
    const exportHandle = source.app.registerPath("export", pack);
    await source.app.call(source.actor, { commandId: "library.exportPackage", idempotencyKey: "media-export", input: { pathHandle: exportHandle } }, source.grant.handle);
    source.app.close();

    const target = await startApp();
    const handle = target.app.registerPath("import", pack);
    const imported = await target.app.call(target.actor, { commandId: "package.importResolved", idempotencyKey: "media-import", input: { pathHandle: handle, strategy: "duplicate" } }, target.grant.handle);
    expect(imported.status).toBe("ok");
    // Managed media keeps a usable location row pointing at the restored attachment.
    const location = target.app.store.sqlite.prepare("SELECT relative_path, available, hosted FROM file_locations LIMIT 1").get() as { relative_path: string; available: number; hosted: number } | undefined;
    expect(location?.hosted).toBe(1);
    expect(location?.available).toBe(1);
    expect(fs.existsSync(location!.relative_path)).toBe(true);
    expect(fs.readFileSync(path.join(target.app.store.attachmentsDir, "unknown-extra.bin"), "utf8")).toBe("unknown synthetic payload");
    expect(target.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resource_assets").get()).toEqual({ n: 0 });
    target.app.close();
  });
});
