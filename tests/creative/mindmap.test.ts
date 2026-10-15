import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startApp, tempProfile } from "../helpers/app.ts";
import { seedComic } from "../helpers/media-seed.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
type Node = { id: string; parentId: string | null; sortKey: string; text: string; collapsed: boolean; refs: Array<{ id: string; kind: string; targetId: string; label: string; state: string }> };
type Doc = { map: { id: string; title: string; theme: string }; nodes: Node[]; ops: { canUndo: boolean; canRedo: boolean; undoLabel: string | null } };
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
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `mm-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
async function map(ctx: App, rootText = "中心主题") {
  const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "导图项目" }));
  const made = ok<{ map: { id: string } }>(await run(ctx, "mindmap.create", { projectId: project.id, title: "第一张导图", rootText })).map;
  return { projectId: project.id, mapId: made.id };
}
const edit = async (ctx: App, mapId: string, actions: unknown[], label?: string) => ok<{ doc: Doc; created: string[] }>(await run(ctx, "mindmap.edit", { mapId, actions, ...(label ? { label } : {}) }));
const get = async (ctx: App, mapId: string) => ok<Doc>(await run(ctx, "mindmap.get", { mapId }));
/** The tree as nested text, children in their stored order, so a test reads the map the way a person does. */
function outline(doc: Doc): string[] {
  const kids = (parent: string | null) => doc.nodes.filter((node) => node.parentId === parent).sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1));
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => { for (const node of kids(parent)) { lines.push(`${"  ".repeat(depth)}${node.text}`); walk(node.id, depth + 1); } };
  walk(null, 0);
  return lines;
}
const idOf = (doc: Doc, text: string) => doc.nodes.find((node) => node.text === text)!.id;

describe("mind maps (AT-27)", () => {
  it("starts with one central topic, builds a tree with children and siblings in the order given, and a restart restores it", async () => {
    const first = await boot();
    const { mapId } = await map(first, "漫画");
    const root = idOf(await get(first, mapId), "漫画");
    await edit(first, mapId, [
      { type: "addChild", parentId: root, id: "a", text: "人物" }, { type: "addChild", parentId: root, id: "b", text: "剧情" },
      { type: "addChild", parentId: "a", id: "a1", text: "主角" }, { type: "addSibling", nodeId: "a1", id: "a2", text: "配角" }, { type: "addSibling", nodeId: "a1", id: "a0", text: "反派", before: true },
      { type: "addChild", parentId: root, id: "c", text: "画风", index: 1 },
    ]);
    const doc = await get(first, mapId);
    expect(outline(doc)).toEqual(["漫画", "  人物", "    反派", "    主角", "    配角", "  画风", "  剧情"]);
    expect(doc.nodes.filter((node) => node.parentId === null)).toHaveLength(1);

    const second = await boot(first);
    expect(outline(await get(second, mapId))).toEqual(outline(doc));
    expect((await get(second, mapId)).ops.canUndo).toBe(true);
    expect(ok<{ maps: Array<{ nodes: number }> }>(await run(second, "mindmap.list", {})).maps[0]!.nodes).toBe(7);
  });

  it("orders siblings with sort keys, so inserting and moving rewrites only the moved topic", async () => {
    const ctx = await boot();
    const { mapId } = await map(ctx);
    const root = (await get(ctx, mapId)).nodes[0]!.id;
    await edit(ctx, mapId, ["a", "b", "c", "d"].map((id) => ({ type: "addChild", parentId: root, id, text: id })));
    const before = Object.fromEntries((await get(ctx, mapId)).nodes.map((node) => [node.id, node.sortKey]));
    await edit(ctx, mapId, [{ type: "move", nodeId: "d", parentId: root, index: 1 }]);
    const after = Object.fromEntries((await get(ctx, mapId)).nodes.map((node) => [node.id, node.sortKey]));
    expect(outline(await get(ctx, mapId))).toEqual(["中心主题", "  a", "  d", "  b", "  c"]);
    expect(Object.keys(after).filter((id) => after[id] !== before[id])).toEqual(["d"]);

    await edit(ctx, mapId, [{ type: "shift", nodeId: "d", direction: "down" }]);
    expect(outline(await get(ctx, mapId))).toEqual(["中心主题", "  a", "  b", "  d", "  c"]);
    await edit(ctx, mapId, [{ type: "shift", nodeId: "c", direction: "up" }, { type: "shift", nodeId: "a", direction: "up" }]);
    expect(outline(await get(ctx, mapId))).toEqual(["中心主题", "  a", "  b", "  c", "  d"]);
  });

  it("keeps order through many appends at one place (keys are renumbered when they grow long)", async () => {
    const ctx = await boot();
    const { mapId } = await map(ctx);
    const root = (await get(ctx, mapId)).nodes[0]!.id;
    for (let batch = 0; batch < 6; batch += 1) {
      await edit(ctx, mapId, Array.from({ length: 40 }, (_, i) => ({ type: "addChild", parentId: root, id: `n${batch * 40 + i}`, text: `n${batch * 40 + i}` })));
    }
    // Insert at the very front over and over: the front is the hardest place for keys.
    await edit(ctx, mapId, Array.from({ length: 60 }, (_, i) => ({ type: "addChild", parentId: root, id: `f${i}`, text: `f${i}`, index: 0 })));
    const doc = await get(ctx, mapId);
    const kids = doc.nodes.filter((node) => node.parentId === root).sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1)).map((node) => node.text);
    expect(kids).toEqual([...Array.from({ length: 60 }, (_, i) => `f${59 - i}`), ...Array.from({ length: 240 }, (_, i) => `n${i}`)]);
    expect(Math.max(...doc.nodes.map((node) => node.sortKey.length))).toBeLessThanOrEqual(26);
    expect(new Set(doc.nodes.map((node) => node.sortKey)).size).toBe(doc.nodes.length);
  });

  it("refuses to move a topic under itself or its own descendant, and leaves the map as it was", async () => {
    const ctx = await boot();
    const { mapId } = await map(ctx);
    const root = (await get(ctx, mapId)).nodes[0]!.id;
    await edit(ctx, mapId, [{ type: "addChild", parentId: root, id: "a", text: "a" }, { type: "addChild", parentId: "a", id: "b", text: "b" }, { type: "addChild", parentId: "b", id: "c", text: "c" }]);
    const before = await get(ctx, mapId);
    for (const parentId of ["a", "b", "c"]) {
      const result = await run(ctx, "mindmap.edit", { mapId, actions: [{ type: "move", nodeId: "a", parentId }] });
      expect(result.error?.code, parentId).toBe("VALIDATION_ERROR");
      expect(result.error?.details).toMatchObject({ reason: "descendant" });
    }
    // A step later in the same call that fails also takes back the steps before it.
    expect((await run(ctx, "mindmap.edit", { mapId, actions: [{ type: "setText", nodeId: "c", text: "changed" }, { type: "move", nodeId: root, parentId: "c" }] })).status).toBe("error");
    expect(await get(ctx, mapId)).toEqual(before);
    // The central topic can be neither moved, deleted nor given a sibling.
    for (const action of [{ type: "delete", nodeId: root }, { type: "move", nodeId: root, parentId: "c" }, { type: "addSibling", nodeId: root }, { type: "shift", nodeId: root, direction: "up" }]) {
      expect((await run(ctx, "mindmap.edit", { mapId, actions: [action] })).error?.code, JSON.stringify(action)).toBe("VALIDATION_ERROR");
    }
    // Moving into a sibling's branch is fine.
    await edit(ctx, mapId, [{ type: "addChild", parentId: root, id: "z", text: "z" }, { type: "move", nodeId: "z", parentId: "c" }]);
    expect(outline(await get(ctx, mapId))).toEqual(["中心主题", "  a", "    b", "      c", "        z"]);
  });

  it("collapses and expands, keeps the state through a restart, and opens a collapsed parent when it gains a child", async () => {
    const first = await boot();
    const { mapId } = await map(first);
    const root = (await get(first, mapId)).nodes[0]!.id;
    await edit(first, mapId, [{ type: "addChild", parentId: root, id: "a", text: "a" }, { type: "addChild", parentId: "a", id: "a1", text: "a1" }, { type: "collapse", nodeId: "a", collapsed: true }]);
    expect((await get(first, mapId)).nodes.find((node) => node.id === "a")!.collapsed).toBe(true);
    const second = await boot(first);
    expect((await get(second, mapId)).nodes.find((node) => node.id === "a")!.collapsed).toBe(true);
    await edit(second, mapId, [{ type: "addChild", parentId: "a", id: "a2", text: "a2" }]);
    expect((await get(second, mapId)).nodes.find((node) => node.id === "a")!.collapsed).toBe(false);
  });

  it("deletes a topic with everything under it, and undoes it with the subtree, the order and the references", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "导图里的漫画", pageCount: 1 });
    const { mapId } = await map(ctx);
    const root = (await get(ctx, mapId)).nodes[0]!.id;
    await edit(ctx, mapId, [
      { type: "addChild", parentId: root, id: "a", text: "a" }, { type: "addChild", parentId: root, id: "b", text: "b" }, { type: "addChild", parentId: "a", id: "a1", text: "a1" }, { type: "addChild", parentId: "a1", id: "a11", text: "a11" },
      { type: "addRef", nodeId: "a1", kind: "work", targetId: comic.workId },
    ]);
    const full = await get(ctx, mapId);
    await edit(ctx, mapId, [{ type: "delete", nodeId: "a" }]);
    expect(outline(await get(ctx, mapId))).toEqual(["中心主题", "  b"]);
    const back = ok<{ doc: Doc; label: string }>(await run(ctx, "mindmap.undo", { mapId }));
    expect(back.label).toBe("delete");
    expect(back.doc.nodes).toEqual(full.nodes);
    const gone = ok<{ doc: Doc }>(await run(ctx, "mindmap.redo", { mapId }));
    expect(outline(gone.doc)).toEqual(["中心主题", "  b"]);
  });

  it("makes one call one step of undo, restores text, theme and shape, and a new edit after an undo drops the redo", async () => {
    const ctx = await boot();
    const { mapId } = await map(ctx);
    const root = (await get(ctx, mapId)).nodes[0]!.id;
    await edit(ctx, mapId, [{ type: "addChild", parentId: root, id: "a", text: "原文" }], "addChild");
    await edit(ctx, mapId, [{ type: "setText", nodeId: "a", text: "改后" }, { type: "addChild", parentId: "a", id: "a1", text: "子" }], "setText");
    expect(ok(await run(ctx, "mindmap.setTheme", { mapId, theme: "blue" })).map).toMatchObject({ theme: "blue" });
    expect((await get(ctx, mapId)).ops.undoLabel).toBe("theme");

    ok(await run(ctx, "mindmap.undo", { mapId }));
    expect((await get(ctx, mapId)).map.theme).toBe("pink");
    const undone = ok<{ doc: Doc }>(await run(ctx, "mindmap.undo", { mapId })).doc;
    expect(outline(undone)).toEqual(["中心主题", "  原文"]);
    expect(undone.ops).toMatchObject({ canUndo: true, canRedo: true });
    await edit(ctx, mapId, [{ type: "setText", nodeId: "a", text: "另起" }]);
    expect((await run(ctx, "mindmap.redo", { mapId })).error?.code).toBe("NOT_FOUND");
    ok(await run(ctx, "mindmap.undo", { mapId }));
    ok(await run(ctx, "mindmap.undo", { mapId }));
    expect(outline(await get(ctx, mapId))).toEqual(["中心主题"]);
    expect((await run(ctx, "mindmap.undo", { mapId })).error?.code).toBe("NOT_FOUND");
  });

  it("attaches references to a topic, never as children, with the name of what they point at and its state", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "引用的作品", pageCount: 1 });
    const { mapId, projectId } = await map(ctx);
    const board = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId, title: "引用的白板" })).board.id;
    const root = (await get(ctx, mapId)).nodes[0]!.id;
    await edit(ctx, mapId, [
      { type: "addRef", nodeId: root, kind: "work", targetId: comic.workId }, { type: "addRef", nodeId: root, kind: "resource", targetId: comic.resourceId },
      { type: "addRef", nodeId: root, kind: "whiteboard", targetId: board },
    ]);
    const doc = await get(ctx, mapId);
    expect(doc.nodes).toHaveLength(1);
    expect(doc.nodes[0]!.refs.map((ref) => [ref.kind, ref.label, ref.state])).toEqual([["work", "引用的作品", "ok"], ["resource", "引用的作品", "ok"], ["whiteboard", "引用的白板", "ok"]]);
    // A board inside a map is an embed: the relation is recorded, and the board knows who holds it.
    expect(ok<{ backlinks: Array<{ sourceKind: string; sourceId: string }> }>(await run(ctx, "embed.backlinks", { targetKind: "whiteboard", targetId: board })).backlinks).toEqual([expect.objectContaining({ sourceKind: "mindmap", sourceId: mapId })]);

    ok(await run(ctx, "whiteboard.delete", { boardId: board }));
    expect((await get(ctx, mapId)).nodes[0]!.refs.map((ref) => ref.state)).toEqual(["ok", "ok", "missing"]);
    await edit(ctx, mapId, [{ type: "removeRef", nodeId: root, refId: doc.nodes[0]!.refs[0]!.id }]);
    expect((await get(ctx, mapId)).nodes[0]!.refs).toHaveLength(2);
    expect((await run(ctx, "mindmap.edit", { mapId, actions: [{ type: "addRef", nodeId: root, kind: "work", targetId: "wrk-none" }] })).error?.code).toBe("NOT_FOUND");
  });

  it("exports the outline as Markdown and OPML, and takes a drawn PNG or SVG, into the folder the user picked without overwriting", async () => {
    const ctx = await boot();
    const { mapId } = await map(ctx, "漫画 & 动画");
    await edit(ctx, mapId, [{ type: "addChild", parentId: (await get(ctx, mapId)).nodes[0]!.id, id: "a", text: "第一\n行 <b>" }, { type: "addChild", parentId: "a", id: "a1", text: "孙" }]);
    const dir = path.join(tempProfile(), "out");
    fs.mkdirSync(dir);
    const handle = ctx.app.registerPath("export", dir);
    const markdown = ok<{ fileName: string }>(await run(ctx, "mindmap.export", { mapId, format: "markdown", pathHandle: handle }));
    expect(markdown.fileName).toBe("第一张导图.md");
    expect(fs.readFileSync(path.join(dir, markdown.fileName), "utf8")).toBe("# 漫画 & 动画\n\n- 第一 行 <b>\n  - 孙\n");
    const opml = ok<{ fileName: string }>(await run(ctx, "mindmap.export", { mapId, format: "opml", pathHandle: handle }));
    const text = fs.readFileSync(path.join(dir, opml.fileName), "utf8");
    expect(text).toContain('<opml version="2.0">');
    expect(text).toContain('<outline text="漫画 &amp; 动画">');
    expect(text).toContain('<outline text="第一&#10;行 &lt;b&gt;">');
    expect(text).toContain('<outline text="孙"/>');
    // A second export of the same map does not overwrite the first.
    expect(ok<{ fileName: string }>(await run(ctx, "mindmap.export", { mapId, format: "markdown", pathHandle: handle })).fileName).toBe("第一张导图 (2).md");

    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("not really a picture")]).toString("base64");
    expect(ok<{ fileName: string }>(await run(ctx, "mindmap.export", { mapId, format: "png", pathHandle: handle, data: png })).fileName).toBe("第一张导图.png");
    expect(ok<{ fileName: string }>(await run(ctx, "mindmap.export", { mapId, format: "svg", pathHandle: handle, data: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' })).fileName).toBe("第一张导图.svg");
    // Not the image it says it is, or no image at all.
    expect((await run(ctx, "mindmap.export", { mapId, format: "png", pathHandle: handle, data: Buffer.from("plain text").toString("base64") })).error?.code).toBe("VALIDATION_ERROR");
    expect((await run(ctx, "mindmap.export", { mapId, format: "svg", pathHandle: handle, data: "<html></html>" })).error?.code).toBe("VALIDATION_ERROR");
    expect((await run(ctx, "mindmap.export", { mapId, format: "png", pathHandle: handle })).error?.code).toBe("VALIDATION_ERROR");
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".part"))).toEqual([]);
    expect((await run(ctx, "mindmap.export", { mapId, format: "markdown", pathHandle: "path-unknown" })).status).toBe("error");
  });

  it("handles a thousand topics: built in one call, read back whole, and every topic keeps its place", async () => {
    const ctx = await boot();
    const { mapId } = await map(ctx);
    const root = (await get(ctx, mapId)).nodes[0]!.id;
    const actions: unknown[] = [];
    for (let i = 0; i < 10; i += 1) {
      actions.push({ type: "addChild", parentId: root, id: `b${i}`, text: `分支${i}` });
      for (let j = 0; j < 9; j += 1) {
        actions.push({ type: "addChild", parentId: `b${i}`, id: `b${i}c${j}`, text: `主题${i}-${j}` });
        for (let k = 0; k < 10; k += 1) actions.push({ type: "addChild", parentId: `b${i}c${j}`, id: `b${i}c${j}d${k}`, text: `叶${i}-${j}-${k}` });
      }
    }
    for (let at = 0; at < actions.length; at += 200) await edit(ctx, mapId, actions.slice(at, at + 200));
    const started = Date.now();
    const doc = await get(ctx, mapId);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(doc.nodes).toHaveLength(1 + 10 + 90 + 900);
    expect(outline(doc).slice(0, 4)).toEqual(["中心主题", "  分支0", "    主题0-0", "      叶0-0-0"]);
    expect((await run(ctx, "mindmap.edit", { mapId, actions: Array.from({ length: 5 }, (_, i) => ({ type: "addChild", parentId: root, id: `more${i}`, text: "x" })) })).status).toBe("ok");
  });

  it("renames, deletes a map with its topics and history, and a project delete takes its maps along", async () => {
    const ctx = await boot();
    const { mapId, projectId } = await map(ctx);
    await edit(ctx, mapId, [{ type: "addChild", parentId: (await get(ctx, mapId)).nodes[0]!.id, text: "x" }]);
    ok(await run(ctx, "mindmap.rename", { mapId, title: "改名" }));
    expect((await get(ctx, mapId)).map.title).toBe("改名");
    const other = ok<{ map: { id: string } }>(await run(ctx, "mindmap.create", { projectId, title: "另一张" })).map.id;
    const sqlite = ctx.app.store.sqlite;
    ok(await run(ctx, "mindmap.delete", { mapId }));
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mindmap_nodes WHERE map_id = ?").get(mapId)).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM creative_ops WHERE doc_kind = 'mindmap' AND doc_id = ?").get(mapId)).toEqual({ n: 0 });
    expect((await run(ctx, "mindmap.get", { mapId })).error?.code).toBe("NOT_FOUND");
    expect(await get(ctx, other)).toBeTruthy();
    ok(await run(ctx, "project.delete", { projectId }));
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mindmaps").get()).toEqual({ n: 0 });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM mindmap_nodes").get()).toEqual({ n: 0 });
  });
});
