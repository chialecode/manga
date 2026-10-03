import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NORMALIZATION_V1 } from "@manga/contracts";
import { buildEpubFixture } from "@manga/app-core";
import { startApp, tempProfile } from "./helpers.ts";

/**
 * Second rework pass: note→source repair, reference hygiene, progress window restore, per-row package
 * decisions, session isolation and the auditable frozen context. Synthetic data only.
 */
describe("M1b rework: source repair and reader state", () => {
  it("re-points a note whose source revision is gone and keeps the link usable", async () => {
    const { app, actor, grant } = await startApp();
    const file = path.join(tempProfile(), "repair-source.txt");
    fs.writeFileSync(file, "修复前的正文，用于来源失效。");
    const handle = app.registerPath("file", file);
    const imported = await app.call(actor, { commandId: "library.importDocument", idempotencyKey: "repair-import", input: { title: "待修来源", pathHandle: handle, format: "auto" } }, grant.handle);
    expect(imported.status).toBe("ok");
    const resourceId = String(imported.value?.resourceId);
    const revisionId = String(imported.value?.revisionId);
    const note = await app.call(actor, {
      commandId: "notes.create",
      idempotencyKey: "repair-note",
      input: {
        title: "来源笔记",
        text: "评论",
        resourceId,
        resourceRevisionId: revisionId,
        locator: { kind: "text", partId: "body", representationId: revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: 0, end: 4 }, quote: { exact: "修复前的" } },
      },
    }, grant.handle);
    const objectId = String(note.value?.objectId);

    // Dropping the revision row is the shape a broken import leaves behind.
    app.store.sqlite.prepare("DELETE FROM resource_revisions WHERE id = ?").run(revisionId);
    const broken = await app.call(actor, { commandId: "notes.openSource", idempotencyKey: "repair-open", input: { objectId } }, grant.handle);
    expect((broken.value as { card: { status: string } }).card.status).toBe("missing_revision");
    const listedBroken = await app.call(actor, { commandId: "notes.list", idempotencyKey: "repair-list", input: {} }, grant.handle);
    expect((listedBroken.value as Array<{ sourceStatus: string }>).some((row) => row.sourceStatus === "missing_revision")).toBe(true);

    // Repair re-reads the file the user picks and reuses the existing resource identity.
    fs.writeFileSync(file, "全新的开头。修复前的正文，用于来源失效。");
    const repaired = await app.call(actor, { commandId: "library.repairSource", idempotencyKey: "repair-run", input: { resourceId, pathHandle: handle } }, grant.handle);
    expect(repaired.status).toBe("ok");
    const newRevisionId = String(repaired.value?.revisionId);
    expect(newRevisionId).not.toBe(revisionId);
    const reread = await app.call(actor, { commandId: "library.read", idempotencyKey: "repair-read", input: { resourceId } }, grant.handle);
    expect(String((reread.value as { slice?: { text?: string } }).slice?.text)).toContain("全新的开头");
    expect(app.store.sqlite.prepare("SELECT id FROM resources WHERE id = ?").get(resourceId)).toBeTruthy();
    const after = await app.call(actor, { commandId: "notes.openSource", idempotencyKey: "repair-open-2", input: { objectId } }, grant.handle);
    const repairedCard = after.value as { card: { status: string; title: string; resourceRevisionId: string; range?: { start: number } } };
    // The card names the same resource the library shows and reports the freshly parsed revision.
    expect(repairedCard.card.title).toBe((app.store.sqlite.prepare("SELECT title FROM resources WHERE id = ?").get(resourceId) as { title: string }).title);
    // The anchor followed the new text and landed on the passage the quote still names.
    expect(repairedCard.card.resourceRevisionId).toBe(newRevisionId);
    expect(repairedCard.card.status).toBe("resolved");
    expect(repairedCard.card.range?.start).toBe(6);
    const listedAfter = await app.call(actor, { commandId: "notes.list", idempotencyKey: "repair-list-2", input: {} }, grant.handle);
    expect((listedAfter.value as Array<{ sourceStatus: string }>).some((row) => row.sourceStatus === "linked")).toBe(true);

    // A file that no longer carries the quoted passage must not be reported as a working link.
    app.store.sqlite.prepare("DELETE FROM resource_revisions WHERE id = ?").run(newRevisionId);
    fs.writeFileSync(file, "这本书里已经没有那句引文了。");
    const second = await app.call(actor, { commandId: "library.repairSource", idempotencyKey: "repair-run-2", input: { resourceId, pathHandle: handle } }, grant.handle);
    expect(second.status).toBe("ok");
    const secondRevisionId = String(second.value?.revisionId);
    expect((second.value as { relocated: number }).relocated).toBe(1);
    const lost = await app.call(actor, { commandId: "notes.openSource", idempotencyKey: "repair-open-3", input: { objectId } }, grant.handle);
    const lostCard = lost.value as { status: string; reason?: string; anchorId: string; card: { status: string; resourceRevisionId: string } };
    expect(lostCard.card.resourceRevisionId).toBe(secondRevisionId);
    expect(lostCard.status).toBe("unresolved");
    expect(lostCard.reason).toBe("quote not found");
    expect(lostCard.card.status).toBe("unresolved");
    // The repair entry stays available, so the user can pick another file instead of seeing a false link.
    expect((lost.value as { card: { status: string } }).card.status).not.toBe("resolved");
    app.close();
  });

  it("never opens another block's source for a jump that names one block", async () => {
    const { app, actor, grant } = await startApp();
    const book = await app.call(actor, {
      commandId: "library.importDocument",
      idempotencyKey: "blk-book",
      input: { title: "段落书", format: "epub", bytes: [...buildEpubFixture({ title: "段落书", chapters: [{ id: "c1", title: "第一章", html: "<p>甲乙丙丁戊己庚辛</p>" }] })] },
    }, grant.handle);
    const resourceId = String(book.value?.resourceId);
    const revisionId = String(book.value?.revisionId);
    const note = await app.call(actor, {
      commandId: "notes.create",
      idempotencyKey: "blk-note",
      input: {
        title: "段落笔记",
        text: "评论",
        resourceId,
        resourceRevisionId: revisionId,
        locator: { kind: "text", partId: "c1", representationId: revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: 6, end: 9 }, quote: { exact: "丙丁戊" } },
      },
    }, grant.handle);
    const objectId = String(note.value?.objectId);
    // The anchored block is "quote"; asking for a block that has no source must say so.
    const missing = await app.call(actor, { commandId: "notes.openSource", idempotencyKey: "blk-missing", input: { objectId, blockId: "b1" } }, grant.handle);
    const missingValue = missing.value as { status: string; reason?: string; card?: { status: string } };
    expect(missingValue.status).toBe("unresolved");
    expect(missingValue.reason).toBe("block has no source");
    expect(missingValue.card?.status).toBe("unresolved");
    const anchored = await app.call(actor, { commandId: "notes.openSource", idempotencyKey: "blk-quote", input: { objectId, blockId: "quote" } }, grant.handle);
    const anchoredValue = anchored.value as { status: string; card: { status: string; quote: string } };
    expect(anchoredValue.card.quote).toBe("丙丁戊");
    expect(anchoredValue.card.status).toBe("resolved");
    app.close();
  });

  it("drops the source link when its block is removed and restores it with the revision", async () => {
    const { app, actor, grant } = await startApp();
    const book = await app.call(actor, {
      commandId: "library.importDocument",
      idempotencyKey: "refs-book",
      input: { title: "引用书", format: "epub", bytes: [...buildEpubFixture({ title: "引用书", chapters: [{ id: "c1", title: "第一章", html: "<p>甲乙丙丁戊己庚辛</p>" }] })] },
    }, grant.handle);
    const resourceId = String(book.value?.resourceId);
    const revisionId = String(book.value?.revisionId);
    const note = await app.call(actor, {
      commandId: "notes.create",
      idempotencyKey: "refs-note",
      input: {
        title: "引用笔记",
        text: "评论",
        resourceId,
        resourceRevisionId: revisionId,
        locator: { kind: "text", partId: "c1", representationId: revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: 6, end: 9 }, quote: { exact: "丙丁戊" } },
      },
    }, grant.handle);
    const objectId = String(note.value?.objectId);
    const before = await app.call(actor, { commandId: "notes.get", idempotencyKey: "refs-get", input: { objectId } }, grant.handle);
    expect((before.value as { sources: unknown[] }).sources).toHaveLength(1);
    expect((before.value as { sourceStatus: string }).sourceStatus).toBe("linked");

    // Copying the anchored block must not create a second source for the same anchor.
    const copied = await app.call(actor, { commandId: "notes.copy", idempotencyKey: "refs-copy", input: { objectId, expectedRevision: 1, blockId: "quote" } }, grant.handle);
    expect(copied.status).toBe("ok");
    const afterCopy = await app.call(actor, { commandId: "notes.get", idempotencyKey: "refs-get-2", input: { objectId } }, grant.handle);
    const copiedBlocks = (afterCopy.value as { document: { blocks: Array<{ anchorId?: string }> } }).document.blocks;
    expect(copiedBlocks.filter((block) => block.anchorId).length).toBe(1);
    expect((afterCopy.value as { sources: unknown[] }).sources).toHaveLength(1);

    // Removing the anchored block leaves a note that no longer claims a live source.
    const removed = await app.call(actor, { commandId: "notes.remove", idempotencyKey: "refs-remove", input: { objectId, expectedRevision: 2, blockId: "quote" } }, grant.handle);
    expect(removed.status).toBe("ok");
    const afterRemove = await app.call(actor, { commandId: "notes.get", idempotencyKey: "refs-get-3", input: { objectId } }, grant.handle);
    expect((afterRemove.value as { sources: unknown[] }).sources).toHaveLength(0);
    expect((afterRemove.value as { sourceStatus: string }).sourceStatus).toBe("none");
    expect(app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM refs WHERE from_object_id = ?").get(objectId)).toEqual({ n: 0 });

    // Restoring the revision brings the anchor - and therefore the link - back.
    const restored = await app.call(actor, { commandId: "notes.restore", idempotencyKey: "refs-restore", input: { objectId, expectedRevision: 3, revision: 1 } }, grant.handle);
    expect(restored.status).toBe("ok");
    const afterRestore = await app.call(actor, { commandId: "notes.get", idempotencyKey: "refs-get-4", input: { objectId } }, grant.handle);
    expect((afterRestore.value as { sources: unknown[] }).sources).toHaveLength(1);
    expect((afterRestore.value as { sourceStatus: string }).sourceStatus).toBe("linked");
    app.close();
  });

  it("stops asking for a file the user already re-picked while the note keeps its own revision", async () => {
    const { app, actor, grant } = await startApp();
    const file = path.join(tempProfile(), "moved-source.txt");
    const text = "开头。源文件稍后会移动，笔记要保留自己的修订。";
    fs.writeFileSync(file, text);
    const handle = app.registerPath("file", file);
    const imported = await app.call(actor, { commandId: "library.importDocument", idempotencyKey: "moved-import", input: { title: "移动来源", pathHandle: handle, format: "auto" } }, grant.handle);
    const resourceId = String(imported.value?.resourceId);
    const revisionId = String(imported.value?.revisionId);
    const note = await app.call(actor, {
      commandId: "notes.create",
      idempotencyKey: "moved-note",
      input: {
        title: "移动笔记",
        text: "评论",
        resourceId,
        resourceRevisionId: revisionId,
        locator: { kind: "text", partId: "body", representationId: revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: 0, end: 2 }, quote: { exact: "开头" } },
      },
    }, grant.handle);
    const objectId = String(note.value?.objectId);

    // The original file moves away: the reader reports it and the card offers the repair entry.
    const moved = `${file}.moved`;
    fs.renameSync(file, moved);
    const missing = await app.call(actor, { commandId: "library.read", idempotencyKey: "moved-read", input: { resourceId } }, grant.handle);
    expect((missing.value as { source: { available: boolean; revisionFileMissing: boolean } }).source).toMatchObject({ available: false, revisionFileMissing: true });
    const staleCard = await app.call(actor, { commandId: "notes.openSource", idempotencyKey: "moved-open", input: { objectId } }, grant.handle);
    expect((staleCard.value as { card: { available: boolean } }).card.available).toBe(false);

    // The user picks the moved file for the same resource; its text changed, so it becomes a new revision.
    fs.writeFileSync(moved, "重排后的新开头。\n" + text);
    const repaired = await app.call(actor, { commandId: "library.repairSource", idempotencyKey: "moved-repair", input: { resourceId, pathHandle: app.registerPath("file", moved) } }, grant.handle);
    expect(repaired.status).toBe("ok");
    const newRevisionId = String(repaired.value?.revisionId);
    expect(newRevisionId).not.toBe(revisionId);

    // The note still points at the revision it was written against, and that excerpt still resolves.
    const card = await app.call(actor, { commandId: "notes.openSource", idempotencyKey: "moved-open-2", input: { objectId } }, grant.handle);
    const cardValue = card.value as { status: string; card: { available: boolean; revisionAvailable: boolean; resourceRevisionId: string; quote?: string } };
    expect(cardValue.status).toBe("resolved");
    expect(cardValue.card.quote).toBe("开头");
    expect(cardValue.card.resourceRevisionId).toBe(revisionId);
    // Repair must not keep asking for a file the user just supplied.
    expect(cardValue.card).toMatchObject({ available: true, revisionAvailable: false });

    // Reopening the note's own revision no longer claims the original is gone, since the text is stored.
    const reopened = await app.call(actor, { commandId: "library.read", idempotencyKey: "moved-read-2", input: { resourceId, revisionId } }, grant.handle);
    expect((reopened.value as { source: { available: boolean; revisionFileMissing: boolean; supersededFile: boolean } }).source)
      .toMatchObject({ available: true, revisionFileMissing: true, supersededFile: true });
    expect(String((reopened.value as { slice: { text: string } }).slice.text)).toContain("笔记要保留自己的修订");
    app.close();
  });

  it("keeps an unknown block payload through a replace so a newer editor never loses data", async () => {
    const { app, actor, grant } = await startApp();
    const note = await app.call(actor, { commandId: "notes.create", idempotencyKey: "attrs-note", input: { title: "未知载荷", text: "正文" } }, grant.handle);
    const objectId = String(note.value?.objectId);
    const replaced = await app.call(actor, {
      commandId: "notes.replace",
      idempotencyKey: "attrs-replace",
      input: { objectId, expectedRevision: 1, blocks: [{ id: "b1", type: "paragraph", text: "正文", attrs: { futureNode: { marks: ["x"], nested: [1, 2] } } }] },
    }, grant.handle);
    expect(replaced.status).toBe("ok");
    const read = await app.call(actor, { commandId: "notes.get", idempotencyKey: "attrs-get", input: { objectId } }, grant.handle);
    const block = (read.value as { document: { blocks: Array<{ attrs?: Record<string, unknown> }> } }).document.blocks[0];
    expect(block?.attrs).toEqual({ futureNode: { marks: ["x"], nested: [1, 2] } });
    app.close();
  });

  it("restores the slice at the stored offset and merges repeated consumed ranges", async () => {
    const { app, actor, grant } = await startApp();
    const text = "甲".repeat(900) + "定位锚点" + "乙".repeat(900);
    const book = await app.call(actor, { commandId: "library.importText", idempotencyKey: "win-book", input: { title: "窗口书", bytes: [...Buffer.from(text)] } }, grant.handle);
    const resourceId = String(book.value?.resourceId);
    const revisionId = String(book.value?.revisionId);
    const locator = { kind: "text" as const, partId: "body", representationId: revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: 900, end: 904 }, quote: { exact: "定位锚点" } };
    // Overlapping and adjacent marks must collapse instead of inflating the read range count.
    await app.call(actor, { commandId: "progress.set", idempotencyKey: "win-set-4", input: { resourceId, resourceRevisionId: revisionId, locator: { ...locator, range: { start: 40, end: 60 } }, consumed: true } }, grant.handle);
    await app.call(actor, { commandId: "progress.set", idempotencyKey: "win-set-2", input: { resourceId, resourceRevisionId: revisionId, locator: { ...locator, range: { start: 902, end: 910 } }, consumed: true } }, grant.handle);
    await app.call(actor, { commandId: "progress.set", idempotencyKey: "win-set-3", input: { resourceId, resourceRevisionId: revisionId, locator: { ...locator, range: { start: 910, end: 930 } }, consumed: true } }, grant.handle);
    // The last position the reader left is the one the library reopens at.
    await app.call(actor, { commandId: "progress.set", idempotencyKey: "win-set", input: { resourceId, resourceRevisionId: revisionId, locator, consumed: true } }, grant.handle);

    const reopened = await app.call(actor, { commandId: "library.read", idempotencyKey: "win-read", input: { resourceId } }, grant.handle);
    const value = reopened.value as { slice: { start: number; text: string }; readRanges: Array<{ partId?: string; start: number; end: number }>; progress: { restoredFrom: string; restoredRange: { start: number; end: number } | null } };
    // The window opens just before the stored offset instead of at the top of the book.
    expect(value.progress.restoredFrom).toBe("progress");
    expect(value.progress.restoredRange).toEqual({ start: 900, end: 904 });
    expect(value.slice.start).toBe(700);
    expect(value.slice.text).toContain("定位锚点");
    // Two disjoint marks remain two ranges; the three touching ones collapsed into one.
    expect(value.readRanges).toHaveLength(2);
    expect(value.readRanges).toEqual(expect.arrayContaining([{ partId: "body", start: 40, end: 60 }, { partId: "body", start: 900, end: 930 }]));

    // A locator that no longer resolves must not claim to have restored a position.
    app.store.sqlite.prepare("UPDATE progress SET last_locator_json = ?").run(JSON.stringify({ ...locator, partId: "gone" }));
    const fallback = await app.call(actor, { commandId: "library.read", idempotencyKey: "win-read-2", input: { resourceId } }, grant.handle);
    expect((fallback.value as { progress: { restoredFrom: string; restoredRange: unknown } }).progress.restoredFrom).toBe("start");
    expect((fallback.value as { progress: { restoredRange: unknown } }).progress.restoredRange).toBeNull();
    app.close();
  });

  it("freezes the material context message with the run so the model request can be checked", async () => {
    const { app, actor, grant } = await startApp();
    const book = await app.call(actor, { commandId: "library.importDocument", idempotencyKey: "ctx-book", input: { title: "上下文书", format: "epub", bytes: [...buildEpubFixture({ title: "上下文书", chapters: [{ id: "c1", title: "章", html: "<p>甲乙丙丁戊己庚辛</p>" }] })] } }, grant.handle);
    const resourceId = String(book.value?.resourceId);
    const revisionId = String(book.value?.revisionId);
    await app.call(actor, { commandId: "progress.set", idempotencyKey: "ctx-progress", input: { resourceId, resourceRevisionId: revisionId, consumed: true, locator: { kind: "text", partId: "c1", representationId: revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: 0, end: 20 }, quote: { exact: "甲乙丙丁戊己庚辛" } } } }, grant.handle);
    const note = await app.call(actor, { commandId: "notes.create", idempotencyKey: "ctx-note", input: { title: "上下文笔记", text: "笔记正文甲乙" } }, grant.handle);
    const objectId = String(note.value?.objectId);
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "ctx-session", input: { title: "上下文会话" } }, grant.handle);
    const sent = await app.call(actor, {
      commandId: "agent.send",
      idempotencyKey: "ctx-send",
      input: { sessionId: String(session.value?.id), text: "按材料回答", readResourceIds: [resourceId], noteObjectIds: [objectId], selection: { resourceId, resourceRevisionId: revisionId, partId: "c1", start: 4, end: 7 } },
    }, grant.handle);
    expect(sent.status).toBe("ok");
    // The send receipt already shows the frozen context, so the user sees what the model was given.
    const sentValue = sent.value as { contextText: string; noteMaterials: Array<{ objectId: string; revision: number; chars: number; preview: string }> };
    expect(sentValue.contextText).toContain("上下文书");
    expect(sentValue.contextText).toContain("丙丁戊");
    expect(sentValue.contextText).toContain("笔记正文甲乙");
    // The material block names the exact revision, so a later re-import cannot silently change the request.
    expect(sentValue.contextText).toContain(revisionId);

    const receipt = await app.call(actor, { commandId: "agent.getRun", idempotencyKey: "ctx-run", input: { runId: String(sent.value?.runId) } }, grant.handle);
    const run = receipt.value as { contextText: string; capturedAt: string; noteMaterials: Array<{ objectId: string; revision: number; chars: number; preview: string }> };
    expect(run.contextText).toBe(sentValue.contextText);
    expect(Date.parse(run.capturedAt)).toBeGreaterThan(0);
    expect(run.noteMaterials[0]).toMatchObject({ objectId, revision: 1 });
    expect(run.noteMaterials[0]?.chars).toBe([..."笔记正文甲乙"].length);
    expect(run.noteMaterials[0]?.preview).toContain("笔记正文甲乙");
    // The frozen text is what the run loop sends, so the request is reproducible from the receipt.
    const stored = JSON.parse((app.store.sqlite.prepare("SELECT snapshot_json FROM agent_runs WHERE id = ?").get(String(sent.value?.runId)) as { snapshot_json: string }).snapshot_json) as { contextText: string };
    expect(stored.contextText).toBe(sentValue.contextText);
    await app.call(actor, { commandId: "agent.cancel", idempotencyKey: "ctx-stop", input: { runId: String(sent.value?.runId) } }, grant.handle);
    app.close();
  });

  it("keeps a note session apart from the book session and from the other work mode", async () => {
    const { app, actor, grant } = await startApp();
    const book = await app.call(actor, { commandId: "library.importDocument", idempotencyKey: "iso-book", input: { title: "隔离书", format: "epub", bytes: [...buildEpubFixture({ title: "隔离书", chapters: [{ id: "c1", title: "章", html: "<p>正文</p>" }] })] } }, grant.handle);
    const resourceId = String(book.value?.resourceId);
    const note = await app.call(actor, { commandId: "notes.create", idempotencyKey: "iso-note", input: { title: "隔离笔记", text: "正文" } }, grant.handle);
    const objectId = String(note.value?.objectId);

    const bookSession = await app.call(actor, { commandId: "session.open", idempotencyKey: "iso-open-book", input: { kind: "resource", targetId: resourceId, mode: "enthusiast" } }, grant.handle);
    const noteSession = await app.call(actor, { commandId: "session.open", idempotencyKey: "iso-open-note", input: { kind: "note", targetId: objectId, mode: "enthusiast" } }, grant.handle);
    // A note session keeps its own kind, so the rail can reopen the note instead of reading it as a book.
    expect((noteSession.value as { kind: string }).kind).toBe("note");
    expect((noteSession.value as { id: string }).id).not.toBe((bookSession.value as { id: string }).id);

    const again = await app.call(actor, { commandId: "session.open", idempotencyKey: "iso-open-note-2", input: { kind: "note", targetId: objectId } }, grant.handle);
    expect((again.value as { id: string }).id).toBe((noteSession.value as { id: string }).id);

    // Creator mode is a different working context, so it must not share the enthusiast session.
    const creator = await app.call(actor, { commandId: "session.open", idempotencyKey: "iso-open-creator", input: { kind: "resource", targetId: resourceId, mode: "creator" } }, grant.handle);
    expect((creator.value as { id: string }).id).not.toBe((bookSession.value as { id: string }).id);
    const enthusiastList = await app.call(actor, { commandId: "workspace.sessions", idempotencyKey: "iso-list", input: { mode: "enthusiast" } }, grant.handle);
    const listed = enthusiastList.value as unknown as Array<{ sessionId: string; kind: string }>;
    expect(listed.some((row) => row.sessionId === String(bookSession.value?.id))).toBe(true);
    expect(listed.some((row) => row.sessionId === String(creator.value?.id))).toBe(false);
    expect(listed.filter((row) => row.kind === "note")).toHaveLength(1);
    const project = await app.call(actor, { commandId: "session.open", idempotencyKey: "iso-project", input: { kind: "project", targetId: "proj-alpha", mode: "creator" } }, grant.handle);
    const projectAgain = await app.call(actor, { commandId: "session.open", idempotencyKey: "iso-project-2", input: { kind: "project", targetId: "proj-alpha", mode: "creator" } }, grant.handle);
    expect((projectAgain.value as { id: string; reused: boolean }).id).toBe((project.value as { id: string }).id);
    expect((projectAgain.value as { reused: boolean }).reused).toBe(true);
    const projectOtherMode = await app.call(actor, { commandId: "session.open", idempotencyKey: "iso-project-mode", input: { kind: "project", targetId: "proj-alpha", mode: "enthusiast" } }, grant.handle);
    expect((projectOtherMode.value as { id: string }).id).not.toBe((project.value as { id: string }).id);
    app.close();
  });

  it("applies a per-row revision decision and remaps the revision inside a stored locator", async () => {
    const source = await startApp();
    const book = await source.app.call(source.actor, { commandId: "library.importDocument", idempotencyKey: "dec-book", input: { title: "决定书", format: "epub", bytes: [...buildEpubFixture({ title: "决定书", chapters: [{ id: "c1", title: "章", html: "<p>甲乙丙丁戊己庚辛</p>" }] })] } }, source.grant.handle);
    const resourceId = String(book.value?.resourceId);
    const revisionId = String(book.value?.revisionId);
    const note = await source.app.call(source.actor, {
      commandId: "notes.create",
      idempotencyKey: "dec-note",
      input: {
        title: "决定笔记",
        text: "评论",
        resourceId,
        resourceRevisionId: revisionId,
        locator: { kind: "text", partId: "c1", representationId: revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: 6, end: 9 }, quote: { exact: "丙丁戊" } },
      },
    }, source.grant.handle);
    expect(note.status).toBe("ok");
    await source.app.call(source.actor, { commandId: "reading.setBookmark", idempotencyKey: "dec-bm", input: { resourceId, resourceRevisionId: revisionId, label: "决定页", locator: { kind: "text", partId: "c1", representationId: revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: 0, end: 5 }, quote: { exact: "甲乙丙丁戊" } } } }, source.grant.handle);
    const pack = path.join(tempProfile(), "decision-package");
    await source.app.call(source.actor, { commandId: "library.exportPackage", idempotencyKey: "dec-export", input: { pathHandle: source.app.registerPath("export", pack) } }, source.grant.handle);
    const exported = JSON.parse(fs.readFileSync(path.join(pack, "manifest.json"), "utf8")) as { bookmarks?: unknown[] };
    expect(exported.bookmarks?.length).toBe(1);
    source.app.close();

    // Import into a library that already holds the same package, so every id collides.
    const target = await startApp();
    await target.app.call(target.actor, { commandId: "library.importPackage", idempotencyKey: "dec-plain", input: { pathHandle: target.app.registerPath("import", pack) } }, target.grant.handle);
    const handle = target.app.registerPath("import", pack);
    const preview = await target.app.call(target.actor, { commandId: "package.preview", idempotencyKey: "dec-preview", input: { pathHandle: handle } }, target.grant.handle);
    const conflicts = (preview.value as { conflicts: Array<{ kind: string; id: string }> }).conflicts;
    // Revision conflicts are reported as their own row kind, so a decision can name them by id.
    expect(conflicts.some((row) => row.kind === "resource_revision" && row.id === revisionId)).toBe(true);
    const bookmarkConflict = conflicts.find((row) => row.kind === "bookmark");
    expect(bookmarkConflict).toBeTruthy();

    // Skip the bookmark but duplicate the note: the decisions must be applied independently.
    const imported = await target.app.call(target.actor, {
      commandId: "package.importResolved",
      idempotencyKey: "dec-import",
      input: {
        pathHandle: handle,
        strategy: "duplicate",
        decisions: [
          { kind: "resource", id: resourceId, action: "duplicate" },
          { kind: "resource_revision", id: revisionId, action: "duplicate" },
          { kind: "bookmark", id: bookmarkConflict!.id, action: "skip" },
          { kind: "work", id: (conflicts.find((row) => row.kind === "work")?.id ?? ""), action: "skip" },
        ].filter((decision) => decision.id),
      },
    }, target.app.handle === undefined ? target.grant.handle : target.grant.handle);
    expect(imported.status).toBe("ok");
    // The bookmark was skipped, so the library still holds the original row only.
    expect(target.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM bookmarks").get()).toEqual({ n: 1 });
    expect(target.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM content_objects").get()).toEqual({ n: 2 });
    // The imported note keeps a locator whose representation id follows the imported revision.
    const importedNote = target.app.store.sqlite.prepare("SELECT id FROM content_objects ORDER BY rowid DESC LIMIT 1").get() as { id: string };
    const anchor = target.app.store.sqlite.prepare("SELECT a.locator_json AS locator, a.resource_revision_id AS revisionId FROM anchors a JOIN refs r ON r.to_id = a.id WHERE r.from_object_id = ?").get(importedNote.id) as { locator: string; revisionId: string };
    const locator = JSON.parse(anchor.locator) as { representationId: string };
    expect(locator.representationId).toBe(anchor.revisionId);
    expect(locator.representationId).not.toBe(revisionId);
    target.app.close();
  });

  it("treats a library that only holds reader state as non-empty", async () => {
    const { app, actor, grant } = await startApp();
    const book = await app.call(actor, { commandId: "library.importDocument", idempotencyKey: "empty-book", input: { title: "状态书", format: "epub", bytes: [...buildEpubFixture({ title: "状态书", chapters: [{ id: "c1", title: "章", html: "<p>正文</p>" }] })] } }, grant.handle);
    const resourceId = String(book.value?.resourceId);
    const revisionId = String(book.value?.revisionId);
    await app.call(actor, { commandId: "reading.setBookmark", idempotencyKey: "empty-bm", input: { resourceId, resourceRevisionId: revisionId, label: "书签", locator: { kind: "text", partId: "c1", representationId: revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: 0, end: 2 }, quote: { exact: "正文" } } } }, grant.handle);
    const pack = path.join(tempProfile(), "state-package");
    await app.call(actor, { commandId: "library.exportPackage", idempotencyKey: "empty-export", input: { pathHandle: app.registerPath("export", pack) } }, grant.handle);
    app.close();

    const target = await startApp();
    const other = await target.app.call(target.actor, { commandId: "library.importText", idempotencyKey: "empty-other", input: { title: "另一本", bytes: [...Buffer.from("另一本正文")] } }, target.grant.handle);
    const otherRevision = String(other.value?.revisionId);
    const otherResource = String(other.value?.resourceId);
    // Leave nothing behind except a progress row, which still means the profile is in use.
    target.app.store.sqlite.prepare("DELETE FROM resources WHERE id = ?").run(otherResource);
    target.app.store.sqlite.prepare("DELETE FROM resource_revisions WHERE id = ?").run(otherRevision);
    target.app.store.sqlite.prepare("DELETE FROM text_fragments").run();
    target.app.store.sqlite.prepare("DELETE FROM search_idx").run();
    target.app.store.sqlite.prepare("INSERT INTO progress(resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at) VALUES (?,?,?,?,?,?)").run("ghost", "ghost-rev", null, "[]", "reading", new Date().toISOString());
    expect(target.app.store.counts().resources).toBe(0);
    expect(target.app.store.counts().content_objects).toBe(0);
    const preview = await target.app.call(target.actor, { commandId: "package.preview", idempotencyKey: "empty-preview", input: { pathHandle: target.app.registerPath("import", pack) } }, target.grant.handle);
    expect((preview.value as { empty: boolean }).empty).toBe(false);
    target.app.close();
  });
});
