import { afterEach, describe, expect, it } from "vitest";
import { startApp } from "../helpers/app.ts";
import { seedComic } from "../helpers/media-seed.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
type Node = { id: string; kind: string; x: number; y: number; w: number; h: number; z: number; parentId: string | null; data: Record<string, any> };
type Doc = { board: { id: string; title: string; viewport: { x: number; y: number; zoom: number } }; nodes: Node[]; edges: Array<{ id: string; sourceId: string; targetId: string; label: string }>; refs: Record<string, { state: string; label: string; summary: string }>; ops: { canUndo: boolean; canRedo: boolean; undoLabel: string | null } };
let counter = 0;
const apps: App[] = [];
afterEach(() => { while (apps.length) apps.pop()!.app.close(); });

async function boot(restartOf?: App) {
  restartOf?.app.close();
  const ctx = await startApp(restartOf ? { profileRoot: restartOf.profileRoot } : {});
  apps.push(ctx);
  return ctx;
}
async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `wb-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
async function board(ctx: App) {
  const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "白板项目" }));
  const made = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId: project.id, title: "第一块白板" })).board;
  return { projectId: project.id, boardId: made.id };
}
const edit = async (ctx: App, boardId: string, actions: unknown[], label?: string) => ok<{ nodes: Node[]; removedNodes: string[]; edges: Array<{ id: string }>; removedEdges: string[]; created: string[]; ops: Doc["ops"] }>(await run(ctx, "whiteboard.edit", { boardId, actions, ...(label ? { label } : {}) }));
const get = async (ctx: App, boardId: string) => ok<Doc>(await run(ctx, "whiteboard.get", { boardId }));
const card = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ type: "addNode", id, kind: "card", x, y, data: { title: id }, ...extra });

describe("whiteboards (AT-26)", () => {
  it("holds cards, free text and references, and a restart restores the layout and the view", async () => {
    const first = await boot();
    const comic = seedComic(first.app, { title: "白板里的漫画", pageCount: 2 });
    const { boardId, projectId } = await board(first);
    const added = await edit(first, boardId, [
      card("n1", 10, 20), { type: "addNode", id: "n2", kind: "text", x: 300, y: 40, data: { text: "自由文字" } },
      { type: "addNode", id: "n3", kind: "ref", x: 600, y: 60, data: { refKind: "work", targetId: comic.workId } },
      { type: "addEdge", id: "e1", sourceId: "n1", targetId: "n2", label: "引出" },
    ]);
    expect(added.created).toEqual(["n1", "n2", "n3", "e1"]);
    ok(await run(first, "whiteboard.setViewport", { boardId, viewport: { x: -120, y: 35, zoom: 0.75 } }));
    // The reference shows the name of what it points at, and the work itself is untouched.
    const doc = await get(first, boardId);
    expect(doc.refs.n3).toMatchObject({ state: "ok", label: "白板里的漫画" });
    expect(doc.nodes.map((node) => node.id)).toEqual(["n1", "n2", "n3"]);
    expect(ok<{ boards: Array<{ nodes: number; edges: number }> }>(await run(first, "whiteboard.list", { projectId })).boards[0]).toMatchObject({ nodes: 3, edges: 1 });

    const second = await boot(first);
    const again = await get(second, boardId);
    expect(again.board.viewport).toEqual({ x: -120, y: 35, zoom: 0.75 });
    expect(again.nodes.map((node) => [node.id, node.x, node.y])).toEqual([["n1", 10, 20], ["n2", 300, 40], ["n3", 600, 60]]);
    expect(again.edges).toEqual([{ id: "e1", sourceId: "n1", targetId: "n2", label: "引出" }]);
    // The history is kept too, so undo still works after the restart.
    expect(again.ops.canUndo).toBe(true);
  });

  it("makes one call one step of undo and redo, and a new edit after an undo drops what could have been redone", async () => {
    const ctx = await boot();
    const { boardId } = await board(ctx);
    await edit(ctx, boardId, [card("a", 0, 0), card("b", 100, 0), card("c", 200, 0)], "addMany");
    const moved = await edit(ctx, boardId, [{ type: "moveNodes", moves: [{ id: "a", x: 50, y: 60 }, { id: "b", x: 150, y: 60 }] }], "move");
    expect(moved.nodes.map((node) => [node.id, node.x, node.y])).toEqual([["a", 50, 60], ["b", 150, 60]]);
    expect(moved.ops).toMatchObject({ canUndo: true, canRedo: false, undoLabel: "move" });

    const undone = ok<{ nodes: Node[]; label: string; ops: Doc["ops"] }>(await run(ctx, "whiteboard.undo", { boardId }));
    expect(undone.label).toBe("move");
    expect(undone.nodes.map((node) => [node.id, node.x, node.y]).sort()).toEqual([["a", 0, 0], ["b", 100, 0]]);
    expect(undone.ops.canRedo).toBe(true);
    const redone = ok<{ nodes: Node[] }>(await run(ctx, "whiteboard.redo", { boardId }));
    expect(redone.nodes.map((node) => [node.id, node.x]).sort()).toEqual([["a", 50], ["b", 150]]);

    ok(await run(ctx, "whiteboard.undo", { boardId }));
    await edit(ctx, boardId, [{ type: "moveNodes", moves: [{ id: "c", x: 999, y: 0 }] }]);
    expect((await run(ctx, "whiteboard.redo", { boardId })).status).toBe("error");
    // Undo all the way back to an empty board, then redo all the way forward.
    ok(await run(ctx, "whiteboard.undo", { boardId }));
    ok(await run(ctx, "whiteboard.undo", { boardId }));
    expect((await get(ctx, boardId)).nodes).toHaveLength(0);
    expect((await run(ctx, "whiteboard.undo", { boardId })).error?.code).toBe("NOT_FOUND");
    ok(await run(ctx, "whiteboard.redo", { boardId }));
    ok(await run(ctx, "whiteboard.redo", { boardId }));
    expect((await get(ctx, boardId)).nodes.map((node) => [node.id, node.x])).toEqual([["a", 0], ["b", 100], ["c", 999]]);
  });

  it("undoes the removal of cards together with their links and the membership they had", async () => {
    const ctx = await boot();
    const { boardId } = await board(ctx);
    await edit(ctx, boardId, [card("a", 0, 0), card("b", 300, 0), card("c", 600, 0), { type: "addEdge", id: "ab", sourceId: "a", targetId: "b" }, { type: "addEdge", id: "bc", sourceId: "b", targetId: "c" }, { type: "group", ids: ["a", "b"], groupId: "g" }]);
    const removed = await edit(ctx, boardId, [{ type: "deleteNodes", ids: ["b"] }]);
    expect(removed.removedNodes).toEqual(["b"]);
    expect(removed.removedEdges.sort()).toEqual(["ab", "bc"]);
    expect((await get(ctx, boardId)).edges).toHaveLength(0);
    const back = ok<{ nodes: Node[]; edges: Array<{ id: string }> }>(await run(ctx, "whiteboard.undo", { boardId }));
    expect(back.nodes.find((node) => node.id === "b")).toMatchObject({ parentId: "g" });
    expect(back.edges.map((edge) => edge.id).sort()).toEqual(["ab", "bc"]);
  });

  it("groups cards, carries members with their group, and returns them when the group is dissolved", async () => {
    const ctx = await boot();
    const { boardId } = await board(ctx);
    await edit(ctx, boardId, [card("a", 100, 100), card("b", 400, 100), card("loose", 900, 900)]);
    const grouped = await edit(ctx, boardId, [{ type: "group", ids: ["a", "b"], title: "一组", groupId: "g" }]);
    const group = grouped.nodes.find((node) => node.id === "g")!;
    expect(group).toMatchObject({ kind: "group", parentId: null, data: { title: "一组" } });
    // The group frames its members with a margin and a title strip, and sits behind them.
    expect(group.x).toBeLessThan(100);
    expect(group.y).toBeLessThan(100);
    expect(group.x + group.w).toBeGreaterThan(400 + 240);
    const doc = await get(ctx, boardId);
    expect(doc.nodes.find((node) => node.id === "a")!.parentId).toBe("g");
    expect(group.z).toBeLessThan(doc.nodes.find((node) => node.id === "a")!.z);

    await edit(ctx, boardId, [{ type: "moveNodes", moves: [{ id: "g", x: group.x + 40, y: group.y + 10 }] }]);
    const shifted = await get(ctx, boardId);
    expect(shifted.nodes.filter((node) => ["a", "b"].includes(node.id)).map((node) => [node.x, node.y])).toEqual([[140, 110], [440, 110]]);
    expect(shifted.nodes.find((node) => node.id === "loose")).toMatchObject({ x: 900, y: 900 });

    // A group cannot be nested, and a loose card can join a group later.
    expect((await run(ctx, "whiteboard.edit", { boardId, actions: [{ type: "group", ids: ["g"] }] })).error?.code).toBe("VALIDATION_ERROR");
    await edit(ctx, boardId, [{ type: "setGroup", ids: ["loose"], groupId: "g" }]);
    expect((await get(ctx, boardId)).nodes.find((node) => node.id === "loose")!.parentId).toBe("g");

    const ungrouped = await edit(ctx, boardId, [{ type: "ungroup", id: "g" }]);
    expect(ungrouped.removedNodes).toEqual(["g"]);
    expect((await get(ctx, boardId)).nodes.every((node) => node.parentId === null)).toBe(true);
  });

  it("aligns, distributes and arranges the selection", async () => {
    const ctx = await boot();
    const { boardId } = await board(ctx);
    const sized = (id: string, x: number, y: number, w: number, h: number) => card(id, x, y, { w, h });
    await edit(ctx, boardId, [sized("a", 10, 10, 100, 50), sized("b", 200, 80, 60, 40), sized("c", 500, 30, 80, 80), sized("d", 320, 300, 100, 100)]);
    const at = async () => Object.fromEntries((await get(ctx, boardId)).nodes.map((node) => [node.id, [node.x, node.y]]));

    await edit(ctx, boardId, [{ type: "align", ids: ["a", "b", "c"], mode: "left" }]);
    expect(await at()).toMatchObject({ a: [10, 10], b: [10, 80], c: [10, 30] });
    await edit(ctx, boardId, [{ type: "align", ids: ["a", "b", "c"], mode: "right" }]);
    // Right edge of the widest-reaching card (a, which ends at 110) is where the others now end.
    expect(await at()).toMatchObject({ a: [10, 10], b: [50, 80], c: [30, 30] });

    await edit(ctx, boardId, [{ type: "align", ids: ["a", "b", "c"], mode: "top" }, { type: "align", ids: ["a", "b", "c"], mode: "left" }]);
    await edit(ctx, boardId, [{ type: "moveNodes", moves: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 130, y: 0 }, { id: "c", x: 600, y: 0 }] }]);
    await edit(ctx, boardId, [{ type: "distribute", ids: ["a", "b", "c"], axis: "h" }]);
    const spread = await at();
    // a (0..100) and c (600..680) stay; the gap left between the three is split evenly: (680 - 240) / 2 = 220.
    expect(spread.a![0]).toBe(0);
    expect(spread.c![0]).toBe(600);
    expect(spread.b![0]).toBe(320);

    await edit(ctx, boardId, [{ type: "arrange", ids: ["a", "b", "c", "d"], columns: 2, gap: 20 }]);
    const grid = await get(ctx, boardId);
    const cell = Object.fromEntries(grid.nodes.map((node) => [node.id, node]));
    // Two columns by two rows, none overlapping, packed with the requested gap.
    const rects = ["a", "b", "c", "d"].map((id) => cell[id]!);
    for (let i = 0; i < rects.length; i += 1) for (let j = i + 1; j < rects.length; j += 1) {
      const p = rects[i]!; const q = rects[j]!;
      expect(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h, `${p.id} overlaps ${q.id}`).toBe(false);
    }
    expect(new Set(rects.map((node) => node.x)).size).toBe(2);
    expect(new Set(rects.map((node) => node.y)).size).toBe(2);
    expect((await get(ctx, boardId)).ops.canUndo).toBe(true);
  });

  it("keeps stacking order, and brings a card to the front or sends it to the back", async () => {
    const ctx = await boot();
    const { boardId } = await board(ctx);
    await edit(ctx, boardId, [card("a", 0, 0), card("b", 10, 10), card("c", 20, 20)]);
    const z = async () => Object.fromEntries((await get(ctx, boardId)).nodes.map((node) => [node.id, node.z]));
    await edit(ctx, boardId, [{ type: "order", ids: ["a"], to: "front" }]);
    const front = await z();
    expect(front.a!).toBeGreaterThan(front.b!);
    expect(front.a!).toBeGreaterThan(front.c!);
    await edit(ctx, boardId, [{ type: "order", ids: ["c"], to: "back" }]);
    const back = await z();
    expect(back.c!).toBeLessThan(back.a!);
    expect(back.c!).toBeLessThan(back.b!);
  });

  it("refuses what would break the board, and changes nothing when a step fails", async () => {
    const ctx = await boot();
    const { boardId } = await board(ctx);
    await edit(ctx, boardId, [card("a", 0, 0), card("b", 50, 0)]);
    const before = await get(ctx, boardId);
    const fail = async (actions: unknown[], code: string) => expect((await run(ctx, "whiteboard.edit", { boardId, actions })).error?.code, JSON.stringify(actions)).toBe(code);
    await fail([card("a", 1, 1)], "VALIDATION_ERROR");
    await fail([{ type: "addEdge", sourceId: "a", targetId: "a" }], "VALIDATION_ERROR");
    await fail([{ type: "addEdge", sourceId: "a", targetId: "nope" }], "NOT_FOUND");
    await fail([{ type: "moveNodes", moves: [{ id: "nope", x: 0, y: 0 }] }], "NOT_FOUND");
    await fail([{ type: "addNode", kind: "ref", x: 0, y: 0, data: { refKind: "work", targetId: "wrk-nope" } }], "NOT_FOUND");
    await fail([{ type: "addNode", kind: "card", x: 0, y: 0, parentId: "a" }], "VALIDATION_ERROR");
    // A later step that fails undoes an earlier step of the same call.
    await fail([{ type: "moveNodes", moves: [{ id: "a", x: 777, y: 777 }] }, { type: "deleteNodes", ids: ["missing"] }], "NOT_FOUND");
    expect((await get(ctx, boardId)).nodes).toEqual(before.nodes);
    expect((await run(ctx, "whiteboard.edit", { boardId, actions: [{ type: "addNode", kind: "card", x: 0, y: 99_000_000 }] })).status).toBe("error");
    expect((await run(ctx, "whiteboard.get", { boardId: "wbd-none" })).error?.code).toBe("NOT_FOUND");
    expect((await run(ctx, "whiteboard.create", { projectId: "prj-none", title: "x" })).error?.code).toBe("NOT_FOUND");
  });

  it("shows a reference whose target was deleted as missing, and points at the original and never copies it", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "会被删的作品", pageCount: 1 });
    const { boardId } = await board(ctx);
    await edit(ctx, boardId, [{ type: "addNode", id: "r", kind: "ref", x: 0, y: 0, data: { refKind: "resource", targetId: comic.resourceId } }]);
    expect((await get(ctx, boardId)).refs.r).toMatchObject({ state: "ok", label: "会被删的作品" });
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get()).toEqual({ n: 1 });
    ctx.app.store.sqlite.prepare("DELETE FROM resources WHERE id = ?").run(comic.resourceId);
    const missing = (await get(ctx, boardId)).refs.r!;
    expect(missing.state).toBe("missing");
    // The name that was saved with the card is still there to read.
    expect((await get(ctx, boardId)).nodes[0]!.data.label).toBe("会被删的作品");
  });

  it("deletes a board with its cards, links and history, and deleting a project deletes its boards", async () => {
    const ctx = await boot();
    const { boardId, projectId } = await board(ctx);
    await edit(ctx, boardId, [card("a", 0, 0), card("b", 1, 1), { type: "addEdge", sourceId: "a", targetId: "b" }]);
    const second = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId, title: "第二块" })).board.id;
    await edit(ctx, second, [card("x", 0, 0)]);
    const sqlite = ctx.app.store.sqlite;
    ok(await run(ctx, "whiteboard.rename", { boardId, title: "改名" }));
    expect(ok<Doc>(await run(ctx, "whiteboard.get", { boardId })).board.title).toBe("改名");
    ok(await run(ctx, "whiteboard.delete", { boardId }));
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM whiteboard_nodes WHERE board_id = ?").get(boardId)).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM whiteboard_edges WHERE board_id = ?").get(boardId)).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM creative_ops WHERE doc_kind = 'whiteboard' AND doc_id = ?").get(boardId)).toEqual({ n: 0 });
    expect((await run(ctx, "whiteboard.get", { boardId })).error?.code).toBe("NOT_FOUND");
    ok(await run(ctx, "project.delete", { projectId }));
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM whiteboards").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM whiteboard_nodes").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM creative_ops").get()).toEqual({ n: 0 });
  });

  it("is owner-only, and a switched-off whiteboard module takes its commands with it while the rows stay", async () => {
    const ctx = await boot();
    const { boardId } = await board(ctx);
    await edit(ctx, boardId, [card("a", 0, 0)]);
    // An agent grant that is not a project's (no project in its conversation) never reaches the board commands; a project's task reaches its own project's only (AT-85).
    const agentGrant = ctx.app.issueAgentGrant(ctx.grant, { kind: "agent", id: "agent-1" }, { readResourceIds: [] });
    const denied = await ctx.app.call({ kind: "agent", id: "agent-1" }, { commandId: "whiteboard.get", idempotencyKey: "wb-agent", input: { boardId } }, agentGrant.handle);
    expect(denied.status).toBe("error");

    ok(await run(ctx, "settings.setModule", { featureId: "whiteboard", enabled: false }));
    expect((await run(ctx, "whiteboard.get", { boardId })).status).toBe("error");
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM whiteboard_nodes WHERE board_id = ?").get(boardId)).toEqual({ n: 1 });
    ok(await run(ctx, "settings.setModule", { featureId: "whiteboard", enabled: true }));
    expect((await get(ctx, boardId)).nodes).toHaveLength(1);
  });
});
