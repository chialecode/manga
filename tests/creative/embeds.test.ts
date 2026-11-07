import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
type Embed = { id: string; slot: string; sourceKind: string; sourceId: string; targetKind: string; targetId: string; mode: string; state: string; title: string; summary: string; takenAt: string | null; recovery: string[] };
let counter = 0;
const apps: App[] = [];
afterEach(() => { while (apps.length) apps.pop()!.app.close(); });

async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  return ctx;
}
async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `emb-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
const list = async (ctx: App, sourceKind: string, sourceId: string) => ok<{ embeds: Embed[] }>(await run(ctx, "embed.list", { sourceKind, sourceId })).embeds;
const backlinks = async (ctx: App, targetKind: string, targetId: string) => ok<{ backlinks: Array<{ sourceKind: string; sourceId: string; state: string }> }>(await run(ctx, "embed.backlinks", { targetKind, targetId })).backlinks;

async function fixtures(ctx: App) {
  const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "嵌入项目" }));
  const board = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId: project.id, title: "目标白板" })).board.id;
  await run(ctx, "whiteboard.edit", { boardId: board, actions: [{ type: "addNode", kind: "card", x: 0, y: 0, data: { title: "白板里的卡片" } }, { type: "addNode", id: "pick", kind: "card", x: 300, y: 0, data: { title: "被指向的卡片" } }] });
  const map = ok<{ map: { id: string } }>(await run(ctx, "mindmap.create", { projectId: project.id, title: "目标导图", rootText: "导图中心" })).map.id;
  const noteA = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "笔记甲", text: "甲的第一段话" }));
  const noteB = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "笔记乙", text: "乙的第一段话" }));
  return { projectId: project.id, board, map, noteA: noteA.objectId, noteB: noteB.objectId };
}
const embedBlock = (id: string, kind: string, targetId: string, extra: Record<string, unknown> = {}) => ({ id, type: "embed", text: "", attrs: { embed: { kind, targetId, ...extra } } });
async function putBlocks(ctx: App, objectId: string, blocks: unknown[]) {
  const got = ok<{ revision: number }>(await run(ctx, "notes.get", { objectId }));
  return ok<{ revision: number }>(await run(ctx, "notes.replace", { objectId, expectedRevision: got.revision, blocks }));
}
const paragraph = (id: string, text: string) => ({ id, type: "paragraph", text });

describe("embeds between notes, whiteboards and mind maps (AT-28)", () => {
  it("follows the blocks of a note: an embed block is registered, a removed one is dropped, and backlinks say who holds the target", async () => {
    const ctx = await boot();
    const f = await fixtures(ctx);
    await putBlocks(ctx, f.noteA, [paragraph("p1", "正文"), embedBlock("e1", "whiteboard", f.board), embedBlock("e2", "mindmap", f.map, { mode: "snapshot" }), embedBlock("e3", "note", f.noteB, { locator: { blockId: "nope" } })]);
    const found = await list(ctx, "note", f.noteA);
    expect(found.map((item) => [item.slot, item.targetKind, item.mode, item.state])).toEqual([["e1", "whiteboard", "live", "valid"], ["e2", "mindmap", "snapshot", "valid"], ["e3", "note", "live", "valid"]]);
    // A live embed reads the target as it is, with a readable line about it.
    expect(found[0]).toMatchObject({ title: "目标白板", summary: "2 个对象：白板里的卡片 · 被指向的卡片" });
    expect(found[1]).toMatchObject({ title: "目标导图", summary: "1 个节点：导图中心" });
    expect(await backlinks(ctx, "whiteboard", f.board)).toEqual([expect.objectContaining({ sourceKind: "note", sourceId: f.noteA, state: "valid" })]);
    // The note keeps the block as written: its kind, what it points at and how.
    const stored = ok<{ document: { blocks: Array<{ id: string; type: string; attrs?: Record<string, unknown> }> } }>(await run(ctx, "notes.get", { objectId: f.noteA })).document.blocks;
    expect(stored.map((block) => block.type)).toEqual(["paragraph", "embed", "embed", "embed"]);
    expect(stored[2]).toMatchObject({ id: "e2", attrs: { embed: { kind: "mindmap", targetId: f.map, mode: "snapshot" } } });

    await putBlocks(ctx, f.noteA, [paragraph("p1", "正文"), embedBlock("e1", "whiteboard", f.board)]);
    expect((await list(ctx, "note", f.noteA)).map((item) => item.slot)).toEqual(["e1"]);
    expect(await backlinks(ctx, "mindmap", f.map)).toEqual([]);
  });

  it("embeds a part of the target: a card of a board, a topic of a map, a block of a note", async () => {
    const ctx = await boot();
    const f = await fixtures(ctx);
    const rootId = (ok<{ nodes: Array<{ id: string }> }>(await run(ctx, "mindmap.get", { mapId: f.map }))).nodes[0]!.id;
    const noteB = ok<{ revision: number; document: { blocks: Array<{ id: string }> } }>(await run(ctx, "notes.get", { objectId: f.noteB }));
    await putBlocks(ctx, f.noteA, [paragraph("p1", "正文"),
      embedBlock("e1", "whiteboard", f.board, { locator: { nodeId: "pick" } }), embedBlock("e2", "mindmap", f.map, { locator: { nodeId: rootId } }), embedBlock("e3", "note", f.noteB, { locator: { blockId: noteB.document.blocks[0]!.id } })]);
    const found = await list(ctx, "note", f.noteA);
    expect(found.map((item) => item.summary)).toEqual(["被指向的卡片", "导图中心", "乙的第一段话"]);
  });

  it("registers an embed from a command, refuses a missing target and a loop, and removes it", async () => {
    const ctx = await boot();
    const f = await fixtures(ctx);
    const made = ok<{ embed: Embed }>(await run(ctx, "embed.upsert", { sourceKind: "note", sourceId: f.noteA, slot: "b1", targetKind: "whiteboard", targetId: f.board }));
    expect(made.embed).toMatchObject({ state: "valid", mode: "live", title: "目标白板" });
    expect((await run(ctx, "embed.upsert", { sourceKind: "note", sourceId: f.noteA, slot: "b2", targetKind: "whiteboard", targetId: "wbd-none" })).error?.code).toBe("NOT_FOUND");
    expect((await run(ctx, "embed.upsert", { sourceKind: "note", sourceId: "note-none", slot: "b2", targetKind: "whiteboard", targetId: f.board })).error?.code).toBe("NOT_FOUND");
    // A note cannot hold itself, and two notes cannot hold each other.
    const self = await run(ctx, "embed.upsert", { sourceKind: "note", sourceId: f.noteA, slot: "b3", targetKind: "note", targetId: f.noteA });
    expect(self.error).toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "cycle" } });
    ok(await run(ctx, "embed.upsert", { sourceKind: "note", sourceId: f.noteA, slot: "b4", targetKind: "note", targetId: f.noteB }));
    const back = await run(ctx, "embed.upsert", { sourceKind: "note", sourceId: f.noteB, slot: "b1", targetKind: "note", targetId: f.noteA });
    expect(back.error).toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "cycle" } });
    // A longer loop through a board is found too.
    ok(await run(ctx, "embed.upsert", { sourceKind: "whiteboard", sourceId: f.board, slot: "n1", targetKind: "mindmap", targetId: f.map }));
    const longer = await run(ctx, "embed.upsert", { sourceKind: "mindmap", sourceId: f.map, slot: "n:1", targetKind: "whiteboard", targetId: f.board });
    expect(longer.error?.details).toMatchObject({ reason: "cycle" });
    expect(await list(ctx, "note", f.noteB)).toEqual([]);

    expect(ok(await run(ctx, "embed.remove", { sourceKind: "note", sourceId: f.noteA, slot: "b4" })).removed).toBe(true);
    expect(ok(await run(ctx, "embed.remove", { sourceKind: "note", sourceId: f.noteA, slot: "b4" })).removed).toBe(false);
  });

  it("a whiteboard reference to a board or a note is an embed, and a loop through a reference node is refused with the edit rolled back", async () => {
    const ctx = await boot();
    const f = await fixtures(ctx);
    const other = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId: f.projectId, title: "另一块" })).board.id;
    await run(ctx, "whiteboard.edit", { boardId: f.board, actions: [{ type: "addNode", id: "r1", kind: "ref", x: 0, y: 100, data: { refKind: "whiteboard", targetId: other } }, { type: "addNode", id: "r2", kind: "ref", x: 0, y: 300, data: { refKind: "note", targetId: f.noteA, mode: "snapshot" } }] });
    expect(await backlinks(ctx, "whiteboard", other)).toEqual([expect.objectContaining({ sourceKind: "whiteboard", sourceId: f.board })]);
    expect((await list(ctx, "whiteboard", f.board)).map((item) => [item.slot, item.mode])).toEqual([["r1", "live"], ["r2", "snapshot"]]);
    const before = ok<{ nodes: unknown[] }>(await run(ctx, "whiteboard.get", { boardId: other })).nodes;
    const loop = await run(ctx, "whiteboard.edit", { boardId: other, actions: [{ type: "addNode", kind: "card", x: 0, y: 0 }, { type: "addNode", kind: "ref", x: 0, y: 0, data: { refKind: "whiteboard", targetId: f.board } }] });
    expect(loop.error).toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "cycle" } });
    expect(ok<{ nodes: unknown[] }>(await run(ctx, "whiteboard.get", { boardId: other })).nodes).toEqual(before);
    // Undo of the removal of a reference node brings the embed back; deleting the node drops it.
    await run(ctx, "whiteboard.edit", { boardId: f.board, actions: [{ type: "deleteNodes", ids: ["r1"] }] });
    expect(await backlinks(ctx, "whiteboard", other)).toEqual([]);
    ok(await run(ctx, "whiteboard.undo", { boardId: f.board }));
    expect(await backlinks(ctx, "whiteboard", other)).toHaveLength(1);
  });

  it("shows a deleted target, a module that is off and a loop as states with a readable line and a way out, never as a broken page", async () => {
    const ctx = await boot();
    const f = await fixtures(ctx);
    await putBlocks(ctx, f.noteA, [paragraph("p1", "正文"), embedBlock("live", "whiteboard", f.board), embedBlock("snap", "mindmap", f.map, { mode: "snapshot" })]);
    // Target deleted: a live embed has only its slot to show, a snapshot keeps what it saw.
    ok(await run(ctx, "mindmap.delete", { mapId: f.map }));
    ok(await run(ctx, "whiteboard.delete", { boardId: f.board }));
    const gone = await list(ctx, "note", f.noteA);
    expect(gone.map((item) => [item.slot, item.state])).toEqual([["live", "deleted"], ["snap", "deleted"]]);
    expect(gone[1]).toMatchObject({ title: "目标导图", summary: "1 个节点：导图中心" });
    expect(gone[0]!.recovery).toEqual(["remove"]);
    expect(gone[1]!.recovery).toEqual(["keepSnapshot", "remove"]);
    expect(await backlinks(ctx, "whiteboard", f.board)).toEqual([expect.objectContaining({ state: "deleted" })]);

    // Module off: the target stays, its embeds say the function is off and offer to switch it on.
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "另一个" }));
    const board = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId: project.id, title: "关闭前的白板" })).board.id;
    await putBlocks(ctx, f.noteA, [paragraph("p1", "正文"), embedBlock("w", "whiteboard", board, { mode: "snapshot" })]);
    ok(await run(ctx, "settings.setModule", { featureId: "whiteboard", enabled: false }));
    const off = (await list(ctx, "note", f.noteA))[0]!;
    expect(off).toMatchObject({ state: "disabled", title: "关闭前的白板" });
    expect(off.recovery).toEqual(["enable", "remove"]);
    ok(await run(ctx, "settings.setModule", { featureId: "whiteboard", enabled: true }));
    expect((await list(ctx, "note", f.noteA))[0]!.state).toBe("valid");

    // A loop written into text is recorded and shown as a loop; both notes stay readable.
    await putBlocks(ctx, f.noteA, [paragraph("p1", "甲"), embedBlock("x", "note", f.noteB)]);
    await putBlocks(ctx, f.noteB, [paragraph("p1", "乙"), embedBlock("y", "note", f.noteA)]);
    expect((await list(ctx, "note", f.noteA))[0]).toMatchObject({ state: "cycle", recovery: ["remove"] });
    expect((await list(ctx, "note", f.noteB))[0]!.state).toBe("cycle");
    expect(ok<{ document: { blocks: unknown[] } }>(await run(ctx, "notes.get", { objectId: f.noteA })).document.blocks).toHaveLength(2);
  });

  it("keeps a snapshot as it was until it is refreshed, and says when it is older than the target", async () => {
    const ctx = await boot();
    const f = await fixtures(ctx);
    await putBlocks(ctx, f.noteA, [paragraph("p1", "正文"), embedBlock("s", "whiteboard", f.board, { mode: "snapshot" }), embedBlock("l", "whiteboard", f.board)]);
    const first = await list(ctx, "note", f.noteA);
    expect(first[0]).toMatchObject({ mode: "snapshot", summary: "2 个对象：白板里的卡片 · 被指向的卡片" });
    expect(first[0]!.takenAt).toBeTruthy();
    expect(first[0]!.recovery).toEqual(["open", "remove"]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await run(ctx, "whiteboard.edit", { boardId: f.board, actions: [{ type: "addNode", kind: "card", x: 9, y: 9, data: { title: "后来加的" } }] });
    const later = await list(ctx, "note", f.noteA);
    // The snapshot did not move; the live embed did.
    expect(later[0]!.summary).toBe(first[0]!.summary);
    expect(later[1]!.summary).toContain("3 个对象");
    expect(later[0]!.recovery).toEqual(["refresh", "open", "remove"]);
    const refreshed = ok<{ embed: Embed }>(await run(ctx, "embed.refresh", { sourceKind: "note", sourceId: f.noteA, slot: "s" })).embed;
    expect(refreshed.summary).toContain("3 个对象");
    expect(refreshed.recovery).toEqual(["open", "remove"]);
    // A live embed has nothing to refresh, and a missing slot is not found.
    expect(ok<{ embed: Embed }>(await run(ctx, "embed.refresh", { sourceKind: "note", sourceId: f.noteA, slot: "l" })).embed.mode).toBe("live");
    expect((await run(ctx, "embed.refresh", { sourceKind: "note", sourceId: f.noteA, slot: "zz" })).error?.code).toBe("NOT_FOUND");
  });

  it("is owner-only, and deleting the object that holds an embed drops the embed while the target keeps its backlinks list clean", async () => {
    const ctx = await boot();
    const f = await fixtures(ctx);
    const agent = ctx.app.issueAgentGrant(ctx.grant, { kind: "agent", id: "agent-embed" }, { readResourceIds: [] });
    const denied = await ctx.app.call({ kind: "agent", id: "agent-embed" }, { commandId: "embed.list", idempotencyKey: "emb-agent", input: { sourceKind: "note", sourceId: f.noteA } }, agent.handle);
    expect(denied.status).toBe("error");
    ok(await run(ctx, "embed.upsert", { sourceKind: "whiteboard", sourceId: f.board, slot: "n1", targetKind: "mindmap", targetId: f.map }));
    expect(await backlinks(ctx, "mindmap", f.map)).toHaveLength(1);
    ok(await run(ctx, "whiteboard.delete", { boardId: f.board }));
    expect(await backlinks(ctx, "mindmap", f.map)).toEqual([]);
    // Deleting the project drops the embeds held by its boards and maps as well.
    ok(await run(ctx, "embed.upsert", { sourceKind: "mindmap", sourceId: f.map, slot: "n:1", targetKind: "note", targetId: f.noteA }));
    ok(await run(ctx, "project.delete", { projectId: f.projectId }));
    expect(await backlinks(ctx, "note", f.noteA)).toEqual([]);
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM embeds").get()).toEqual({ n: 0 });
  });
});
