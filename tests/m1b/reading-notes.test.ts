import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { NORMALIZATION_V1 } from "@manga/contracts";
import { DrizzleStore } from "@manga/storage-drizzle";
import { BASE_SCHEMA_SQL, PRODUCT_SCHEMA_VERSION, V2_SCHEMA_SQL, V3_SCHEMA_SQL, V4_SCHEMA_SQL } from "../../packages/storage-drizzle/src/sql.ts";
import { applyNoteOp, buildEpubFixture, deriveShell, reduceHover, initialHover, resolveTextLocator } from "@manga/app-core";
import { startApp, tempProfile } from "./helpers.ts";

const actorAgent = { kind: "agent" as const, id: "agent-1" };

describe("reading, notes and index", () => {
  it("denies ungranted standalone notes and unread direct content queries", async () => {
    const { app, actor, grant } = await startApp();
    try {
      const note = await app.call(actor, { commandId: "notes.create", idempotencyKey: "private-note", input: { title: "private", text: "private-note-marker" } }, grant.handle);
      const book = await app.call(actor, { commandId: "library.importText", idempotencyKey: "spoiler-book", input: { title: "book", bytes: [...Buffer.from("unread-marker")] } }, grant.handle);
      const resourceId = String(book.value?.resourceId);
      const revisionId = String(book.value?.revisionId);
      const agent = app.issueAgentGrant(grant, actorAgent, { readResourceIds: [resourceId] });
      const forbidden = await app.call(actorAgent, { commandId: "notes.get", idempotencyKey: "ungranted", input: { objectId: note.value?.objectId } }, agent.handle);
      expect(forbidden.status).toBe("error");
      expect(forbidden.error?.code).toBe("SCOPE_DENIED");
      await app.call(actor, { commandId: "settings.setShell", idempotencyKey: "protect", input: { spoilerGuard: true } }, grant.handle);
      for (const commandId of ["library.getResource", "library.read", "library.contextSnapshot"]) {
        const input = commandId === "library.contextSnapshot" ? { resourceId, resourceRevisionId: revisionId, partId: "body", start: 0, end: 5 } : { resourceId };
        const result = await app.call(actorAgent, { commandId, idempotencyKey: commandId, input }, agent.handle);
        expect(result.error?.code).toBe("SCOPE_DENIED");
        expect(JSON.stringify(result)).not.toContain("unread-marker");
      }
      const own = await app.call(actor, { commandId: "library.read", idempotencyKey: "owner-read", input: { resourceId } }, grant.handle);
      expect(own.status).toBe("ok");
    } finally { app.close(); }
  });
  it("recovers a v4 migration interrupted after DDL but before publishing its version", () => {
    const dir = tempProfile();
    const file = path.join(dir, "manga.sqlite");
    const db = new Database(file);
    db.exec(BASE_SCHEMA_SQL + V2_SCHEMA_SQL + V3_SCHEMA_SQL + V4_SCHEMA_SQL);
    db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schemaVersion', '4')").run();
    db.close();
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", "import { DrizzleStore } from '@manga/storage-drizzle'; new DrizzleStore({profileDir:process.env.MANGA_MIGRATION_TEST_DIR,hostId:'crash-test',crashAt:'migration-before-version'});"], {
      env: { ...process.env, MANGA_MIGRATION_TEST_DIR: dir }, encoding: "utf8", windowsHide: true, timeout: 20_000,
    });
    expect(child.status, child.stderr).toBe(99);
    const before = new Database(file);
    expect(before.prepare("SELECT value FROM schema_meta WHERE key='schemaVersion'").get()).toEqual({ value: "4" });
    expect((before.prepare("PRAGMA table_info(text_fragments)").all() as Array<{ name: string }>).some((column) => column.name === "part_id")).toBe(false);
    before.close();
    const recovered = new DrizzleStore({ profileDir: dir, hostId: "recovered" });
    expect(recovered.getMeta("schemaVersion")).toBe(String(PRODUCT_SCHEMA_VERSION));
    expect(recovered.sqlite.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    recovered.close();
  });
  it("keeps a v4 library and schema v1 note through migration", () => {
    const dir = tempProfile();
    const db = new Database(path.join(dir, "manga.sqlite"));
    db.exec(BASE_SCHEMA_SQL);
    db.exec(V2_SCHEMA_SQL);
    db.exec(V3_SCHEMA_SQL);
    db.exec(V4_SCHEMA_SQL);
    db.prepare("INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('schemaVersion', '4')").run();
    db.prepare("INSERT INTO content_objects(id, type, owner_module_id, scope_json, schema_version, revision, title, payload_json, attachment_ids_json, preview_json, created_at, updated_at) VALUES ('obj_old','notes.document','manga.notes','{}',1,1,'旧笔记',?,'[]','{}','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run(JSON.stringify({ blocks: [{ id: "b1", text: "旧笔记正文" }] }));
    db.close();
    const store = new DrizzleStore({ profileDir: dir, hostId: "m1b-migrate" });
    expect(store.getMeta("schemaVersion")).toBe(String(PRODUCT_SCHEMA_VERSION));
    expect(fs.existsSync(`${path.join(dir, "manga.sqlite")}.premigrate-v4`)).toBe(true);
    const row = store.sqlite.prepare("SELECT payload_json, schema_version FROM content_objects WHERE id = 'obj_old'").get() as { payload_json: string; schema_version: number };
    expect(row.schema_version).toBe(1);
    expect(JSON.parse(row.payload_json).blocks[0].text).toBe("旧笔记正文");
    const columns = store.sqlite.prepare("PRAGMA table_info(text_fragments)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("part_id");
    store.close();
  });

  it("searches a CJK tail past the old 4000-character index and filters unread ranges", async () => {
    const { app, actor, grant } = await startApp();
    const head = "甲".repeat(4500);
    const imported = await app.call(actor, {
      commandId: "library.importText",
      idempotencyKey: "tail",
      input: { title: "长文", bytes: [...Buffer.from(`${head}末尾检索甲`)] },
    }, grant.handle);
    expect(imported.status).toBe("ok");
    const resourceId = String(imported.value?.resourceId);
    const found = await app.call(actor, { commandId: "library.find", idempotencyKey: "find-tail", input: { text: "末尾检索甲", resourceId } }, grant.handle);
    expect(found.status).toBe("ok");
    const hits = found.value as Array<{ text: string; revisionId?: string; locator?: { partId: string; range: { start: number; end: number } } }>;
    expect(hits.some((hit) => hit.text.includes("末尾检索甲") && hit.locator && hit.revisionId)).toBe(true);
    await app.call(actor, { commandId: "settings.setShell", idempotencyKey: "spoiler", input: { spoilerGuard: true } }, grant.handle);
    const hidden = await app.call(actor, { commandId: "library.find", idempotencyKey: "find-hidden", input: { text: "末尾检索甲", resourceId, withinProgress: true } }, grant.handle);
    expect((hidden.value as unknown[]).length).toBe(0);
    const revisionId = String(hits[0]?.revisionId);
    const locator = hits[0]?.locator;
    await app.call(actor, {
      commandId: "progress.set",
      idempotencyKey: "jump",
      input: { resourceId, resourceRevisionId: revisionId, locator: { kind: "text", partId: locator?.partId, representationId: revisionId, normalizationVersion: NORMALIZATION_V1, range: locator?.range, quote: { exact: "末尾检索甲" } } },
    }, grant.handle);
    const stillHidden = await app.call(actor, { commandId: "library.find", idempotencyKey: "find-jump", input: { text: "末尾检索甲", resourceId, withinProgress: true } }, grant.handle);
    expect((stillHidden.value as unknown[]).length).toBe(0);
    await app.call(actor, {
      commandId: "progress.set",
      idempotencyKey: "read",
      input: { resourceId, resourceRevisionId: revisionId, consumed: true, locator: { kind: "text", partId: locator?.partId, representationId: revisionId, normalizationVersion: NORMALIZATION_V1, range: locator?.range, quote: { exact: "末尾检索甲" } } },
    }, grant.handle);
    const visible = await app.call(actor, { commandId: "library.find", idempotencyKey: "find-read", input: { text: "末尾检索甲", resourceId, withinProgress: true } }, grant.handle);
    expect((visible.value as unknown[]).length).toBeGreaterThan(0);
    app.close();
  });

  it("splits, copies and rejects a stale note revision without writing", async () => {
    const { app, actor, grant } = await startApp();
    const created = await app.call(actor, { commandId: "notes.create", idempotencyKey: "n1", input: { title: "记", text: "甲乙丙丁" } }, grant.handle);
    const objectId = String(created.value?.objectId);
    const split = await app.call(actor, { commandId: "notes.split", idempotencyKey: "split", input: { objectId, expectedRevision: 1, blockId: "b1", offset: 2 } }, grant.handle);
    expect(split.status).toBe("ok");
    const document = (split.value as { document: { blocks: Array<{ id: string; text: string }> } }).document;
    expect(document.blocks[0]?.id).toBe("b1");
    expect(document.blocks[0]?.text).toBe("甲乙");
    expect(document.blocks[1]?.id).not.toBe("b1");
    const copied = await app.call(actor, { commandId: "notes.copy", idempotencyKey: "copy", input: { objectId, expectedRevision: 2, blockId: "b1" } }, grant.handle);
    const copyBlocks = (copied.value as { document: { blocks: Array<{ id: string }> } }).document.blocks;
    expect(new Set(copyBlocks.map((block) => block.id)).size).toBe(copyBlocks.length);
    const conflict = await app.call(actor, { commandId: "notes.update", idempotencyKey: "stale", input: { objectId, expectedRevision: 1, text: "覆盖" } }, grant.handle);
    expect(conflict.status).toBe("error");
    expect(conflict.error?.code).toBe("REVISION_CONFLICT");
    expect(conflict.error?.details).toMatchObject({ candidate: { text: "覆盖" } });
    const current = await app.call(actor, { commandId: "notes.get", idempotencyKey: "get", input: { objectId } }, grant.handle);
    expect((current.value as { document: { blocks: Array<{ text: string }> } }).document.blocks.some((block) => block.text === "覆盖")).toBe(false);
    const undone = await app.call(actor, { commandId: "notes.undo", idempotencyKey: "undo", input: { objectId, expectedRevision: Number((copied.value as { revision: number }).revision) } }, grant.handle);
    expect(undone.status).toBe("ok");
    app.close();
  });

  it("freezes the selection into the agent snapshot and blocks an unread quote", async () => {
    const { app, actor, grant } = await startApp();
    const imported = await app.call(actor, { commandId: "library.importDocument", idempotencyKey: "epub", input: { title: "书", format: "epub", bytes: [...buildEpubFixture({ title: "书", chapters: [{ id: "c1", title: "章", html: "<p>可选正文甲乙</p>" }] })] } }, grant.handle);
    const resourceId = String(imported.value?.resourceId);
    const revisionId = String(imported.value?.revisionId);
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "ses", input: { title: "读" } }, grant.handle);
    const sent = await app.call(actor, {
      commandId: "agent.send",
      idempotencyKey: "send",
      input: { sessionId: session.value?.id, text: "看选区", readResourceIds: [resourceId], selection: { resourceId, resourceRevisionId: revisionId, partId: "c1", start: 0, end: 8 } },
    }, grant.handle);
    expect(sent.status).toBe("ok");
    const row = app.store.sqlite.prepare("SELECT snapshot_json FROM agent_runs WHERE id = ?").get(String(sent.value?.runId)) as { snapshot_json: string };
    const snapshot = JSON.parse(row.snapshot_json) as { selection?: { quote?: string } };
    expect(snapshot.selection?.quote).toContain("可选正文");
    await app.call(actor, { commandId: "agent.cancel", idempotencyKey: "stop", input: { runId: sent.value?.runId } }, grant.handle);
    await app.call(actor, { commandId: "settings.setShell", idempotencyKey: "guard", input: { spoilerGuard: true } }, grant.handle);
    const guarded = await app.call(actor, {
      commandId: "agent.send",
      idempotencyKey: "send-2",
      input: { sessionId: session.value?.id, text: "再看", readResourceIds: [resourceId], selection: { resourceId, resourceRevisionId: revisionId, partId: "c1", start: 0, end: 4 } },
    }, grant.handle);
    const guardedRow = app.store.sqlite.prepare("SELECT snapshot_json FROM agent_runs WHERE id = ?").get(String(guarded.value?.runId)) as { snapshot_json: string };
    expect(JSON.parse(guardedRow.snapshot_json).selection.blocked).toBe("spoiler");
    await app.call(actor, { commandId: "agent.cancel", idempotencyKey: "stop-2", input: { runId: guarded.value?.runId } }, grant.handle);
    app.close();
  });

  it("resolves a duplicate sentence as needs_review and a scan page as missing capability", () => {
    const locator = {
      kind: "text" as const,
      partId: "p",
      representationId: "other",
      normalizationVersion: NORMALIZATION_V1,
      range: { start: 0, end: 2 },
      quote: { exact: "甲乙" },
    };
    expect(resolveTextLocator(locator, { id: "rev", normalized: "甲乙。甲乙。", available: true }).status).toBe("needs_review");
    expect(resolveTextLocator({ ...locator, representationId: "rev" }, { id: "rev", normalized: "", available: true, kind: "scan" }).status).toBe("missing_capability");
  });

  it("discards a note write when the commit process exits", () => {
    const profile = tempProfile();
    const child = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../packages/app-core/src/crash-child.ts");
    const result = spawnSync(process.execPath, ["--experimental-strip-types", child, "--profile", profile, "--crash-at", "in-tx-before-commit", "--op", "notes.create"], {
      encoding: "utf8",
      timeout: 20_000,
      windowsHide: true,
    });
    expect(result.status).toBe(99);
    const store = new DrizzleStore({ profileDir: profile, hostId: "after-crash" });
    const count = store.sqlite.prepare("SELECT COUNT(*) AS n FROM content_objects").get() as { n: number };
    expect(count.n).toBe(0);
    store.close();
  });

  it("parses an epub in the worker and does not treat parser candidates as accepted", async () => {
    const { app, actor, grant } = await startApp({ useParseWorker: true });
    const imported = await app.call(actor, {
      commandId: "library.importDocument",
      idempotencyKey: "worker-epub",
      input: { title: "工人", format: "epub", bytes: [...buildEpubFixture({ title: "工人", chapters: [{ id: "c1", title: "章", html: "<p>工人正文</p>" }] })] },
    }, grant.handle);
    expect(imported.status).toBe("ok");
    const read = await app.call(actor, { commandId: "library.read", idempotencyKey: "read", input: { resourceId: imported.value?.resourceId } }, grant.handle);
    expect(String((read.value as { slice?: { text?: string } }).slice?.text)).toContain("工人正文");
    expect((read.value as { traits?: { accepted?: boolean } }).traits?.accepted).toBe(false);
    app.close();
  });

  it("keeps shell measure independent of the dock and delays overlay close", () => {
    const preference = {
      version: 1 as const,
      mode: "enthusiast" as const,
      spoilerGuard: false,
      layouts: {
        enthusiast: { focus: false, left: { visible: true, width: 224 }, right: { visible: true, width: 360 } },
        creator: { focus: false, left: { visible: true, width: 224 }, right: { visible: true, width: 360 } },
      },
      reading: { measurePx: 680, fontSizePx: 18, lineHeight: 1.7, theme: "paper" as const },
    };
    const wide = deriveShell({ viewport: { width: 1600, height: 900 }, preference, hasRight: true, overlay: null });
    expect(wide.left).toBe("dock");
    expect(wide.mainWidth).toBeGreaterThanOrEqual(640);
    expect(wide.measurePx).toBe(680);
    const narrow = deriveShell({ viewport: { width: 800, height: 500 }, preference, hasRight: true, overlay: null });
    expect(narrow.left).toBe("hidden");
    expect(narrow.compact).toBe(true);
    expect(narrow.mainWidth).toBe(800);
    const opened = reduceHover(initialHover(), { type: "enter", side: "left", now: 0 });
    const leaving = reduceHover(opened, { type: "leave", now: 10 });
    expect(reduceHover(leaving, { type: "tick", now: 100 }).overlay).toBe("left");
    expect(reduceHover(reduceHover(leaving, { type: "enter", side: "left", now: 20 }), { type: "tick", now: 400 }).overlay).toBe("left");
    expect(reduceHover(leaving, { type: "tick", now: 200 }).overlay).toBe(null);
    const split = applyNoteOp({ schemaVersion: 2, blocks: [{ id: "b1", type: "paragraph", text: "甲乙丙丁" }] }, { type: "split", blockId: "b1", offset: 2 }, () => "b2");
    expect(split.blocks.map((block) => block.id)).toEqual(["b1", "b2"]);
    expect(actorAgent.kind).toBe("agent");
  });
});
