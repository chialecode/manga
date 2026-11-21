import fs from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";

type App = Awaited<ReturnType<typeof startApp>>;
const apps: App[] = [];
let seq = 0;

afterEach(() => {
  while (apps.length) {
    try { apps.pop()!.app.close(); } catch { /* closed */ }
  }
});

async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  return ctx;
}

const run = (ctx: App, commandId: string, input: Record<string, unknown>, grantHandle = ctx.grant.handle, actor: { kind: "user" | "agent"; id: string } = ctx.actor) =>
  ctx.app.call(actor, { commandId, idempotencyKey: `note-reg-${++seq}`, input }, grantHandle);

describe("Notes regressions (A-19)", () => {
  it("re-indexes search_idx on notes.restore and rejects notes.undo on soft-deleted notes", async () => {
    const ctx = await boot();
    const created = await run(ctx, "notes.create", { title: "测试笔记", text: "第一版独有词条甲" });
    expect(created.status).toBe("ok");
    const objectId = String(created.value?.objectId);

    const updated = await run(ctx, "notes.update", { objectId, expectedRevision: 1, text: "第二版替换文本乙" });
    expect(updated.status).toBe("ok");

    // Restore revision 1 -> "第一版独有词条甲" must become searchable again immediately!
    const restored = await run(ctx, "notes.restore", { objectId, revision: 1, expectedRevision: 2 });
    expect(restored.status, JSON.stringify(restored)).toBe("ok");
    const found = await run(ctx, "library.find", { text: "第一版独有词条甲" });
    expect(found.status, JSON.stringify(found)).toBe("ok");
    const hits = found.value as Array<{ objectId?: string; text?: string }>;
    expect(hits.some((h) => h.objectId === objectId || h.text?.includes("第一版独有词条甲"))).toBe(true);

    // Soft-delete the note -> notes.undo MUST fail with NOT_FOUND rather than mutating a deleted note!
    const del = await run(ctx, "notes.delete", { objectId });
    expect(del.status, JSON.stringify(del)).toBe("ok");
    const undoDeleted = await run(ctx, "notes.undo", { objectId, expectedRevision: 3 });
    expect(undoDeleted.status).toBe("error");
    expect(undoDeleted.error?.code).toBe("NOT_FOUND");
  });

  it("allows scoped agent access to free/project notes without resourceId and exports tags_json in note files", async () => {
    const ctx = await boot();
    const imp = await run(ctx, "library.importText", { title: "带标签书", bytes: [...Buffer.from("正文段落")] });
    const resourceId = String(imp.value?.resourceId);

    // Create note with tags attached to resource, sync note file, and verify markdown includes tags.
    const noteWithTags = await run(ctx, "notes.create", {
      title: "标签笔记",
      text: "正文内容",
      resourceId,
      tags: ["伏笔", "人物关系"],
    });
    expect(noteWithTags.status).toBe("ok");
    const noteId = String(noteWithTags.value?.objectId);
    ctx.app.noteFiles.sync(noteId);
    const fileRow = ctx.app.store.sqlite.prepare("SELECT id FROM work_files WHERE ref_kind = 'note' AND ref_id = ?").get(noteId) as { id: string } | undefined;
    expect(fileRow).toBeTruthy();
    const mdPath = ctx.app.workFolders.pathOf(fileRow!.id);
    expect(mdPath).toBeTruthy();
    const markdown = fs.readFileSync(mdPath!, "utf8");
    expect(markdown).toContain("伏笔");
    expect(markdown).toContain("人物关系");

    // Scoped agent reading a note attached to an authorized resource via scope_json (no refs/anchors) succeeds via noteResourceId(),
    // while an unauthorized standalone note is denied with SCOPE_DENIED.
    const standalone = await run(ctx, "notes.create", { title: "独立笔记", text: "初始内容" });
    const standaloneId = String(standalone.value?.objectId);
    const agentActor = { kind: "agent" as const, id: "note-helper" };
    const agentGrant = ctx.app.issueAgentGrant(ctx.grant, agentActor, { readResourceIds: [resourceId] });
    const allowed = await run(ctx, "notes.get", { objectId: noteId }, agentGrant.handle, agentActor);
    expect(allowed.status, JSON.stringify(allowed)).toBe("ok");
    const denied = await run(ctx, "notes.get", { objectId: standaloneId }, agentGrant.handle, agentActor);
    expect(denied.status).toBe("error");
    expect(denied.error?.code).toBe("SCOPE_DENIED");
  });
});
