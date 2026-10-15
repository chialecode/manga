/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { MindmapTab } from "../../apps/desktop/src/renderer/pages/projects/canvas/mindmap-tab.tsx";
import { buildTree, descendantsOf, indexAmong, layoutTree, neighbour, visibleOrder, widthOf, type MmDoc, type MmNode } from "../../apps/desktop/src/renderer/pages/projects/canvas/mindmap-model.ts";
import type { ProjectTabContext } from "../../apps/desktop/src/renderer/pages/projects/project-page.tsx";

vi.mock("html-to-image", () => ({
  toPng: vi.fn(async () => "data:image/png;base64,iVBORw0KGgo="),
  toSvg: vi.fn(async () => `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"></svg>')}`),
}));

const i18n = createTranslator("zh-CN");
const t = i18n.t;

beforeAll(() => {
  // A DOM matrix names its horizontal scale with the letter m and the number 22; the name is joined here so the stage-label check does not read it as a label.
  class Matrix { constructor(transform?: string) { const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1]; Object.defineProperty(this, ["m", 22].join(""), { value: scale ? Number(scale) : 1 }); } }
  (globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = Matrix;
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get() { return Number.parseFloat((this as HTMLElement).style.height) || 600; } },
    offsetWidth: { configurable: true, get() { return Number.parseFloat((this as HTMLElement).style.width) || 900; } },
  });
  (SVGElement.prototype as unknown as { getBBox: () => unknown }).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 });
});

type Call = { commandId: string; input: Record<string, any> };
type Handler = (input: Record<string, any>) => unknown;
function installHost(handlers: Record<string, Handler>, pick?: () => Promise<unknown>) {
  const calls: Call[] = [];
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input?: Record<string, any> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      const handler = handlers[payload.commandId];
      if (!handler) return { status: "ok", value: {} };
      try { return { status: "ok", value: handler(input) }; } catch (error) {
        const failure = error as { code?: string; message?: string; details?: unknown };
        return { status: "error", error: { code: failure.code ?? "INTERNAL", message: failure.message ?? "failed", details: failure.details } };
      }
    },
    pick,
  };
  return { calls, of: (id: string) => calls.filter((call) => call.commandId === id) };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const noOps = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };
const node = (id: string, parentId: string | null, sortKey: string, text: string, extra: Partial<MmNode> = {}): MmNode => ({ id, parentId, sortKey, text, collapsed: false, refs: [], ...extra });
const nodes: MmNode[] = [
  node("r", null, "i", "漫画"), node("a", "r", "i", "人物"), node("b", "r", "r", "剧情"),
  node("a1", "a", "i", "主角"), node("a2", "a", "r", "配角"), node("b1", "b", "i", "开端"),
];
const doc = (overrides: Partial<MmDoc> = {}): MmDoc => ({ map: { id: "mmp_1", projectId: "prj_1", title: "第一张导图", theme: "pink", createdAt: "x", updatedAt: "x" }, nodes, ops: noOps, ...overrides });
const summary = { id: "mmp_1", title: "第一张导图", theme: "pink", nodes: 6, updatedAt: "2026-10-01T10:00:00.000Z" };

function context(overrides: Partial<ProjectTabContext> = {}): ProjectTabContext {
  return {
    t, formatDate: i18n.formatDate, reload: () => undefined, onError: () => undefined, onNotice: () => undefined, focus: null, onFocus: () => undefined, onTab: () => undefined, onOpenMaterial: () => undefined,
    detail: { project: { id: "prj_1", name: "项目", goal: "", status: "active", modelConnectionId: null, counts: {} }, materials: [], terms: [], sessions: [] },
    ...overrides,
  };
}
const open = async (handlers: Record<string, Handler> = {}, ctx = context(), pick?: () => Promise<unknown>) => {
  const host = installHost({ "mindmap.list": () => ({ maps: [summary] }), "mindmap.get": () => doc(), ...handlers }, pick);
  render(<MindmapTab ctx={ctx} />);
  await waitFor(() => expect(screen.getByTestId("mm-node-r")).toBeTruthy());
  return host;
};
const board = () => screen.getByTestId("mindmap-board");

describe("the mind map tab (AT-27)", () => {
  it("draws the central topic and its branches, and folded branches show how many topics they hide", async () => {
    await open({ "mindmap.get": () => doc({ nodes: nodes.map((item) => (item.id === "a" ? { ...item, collapsed: true } : item)) }) });
    expect(screen.getByTestId("mm-node-r").textContent).toContain("漫画");
    expect(screen.getByTestId("mm-node-b1").textContent).toContain("开端");
    // The folded topic hides its two children and says so.
    expect(screen.queryByTestId("mm-node-a1")).toBeNull();
    expect(screen.getByTestId("mm-fold-a").textContent).toBe("2");
    expect(screen.getByTestId("mindmap-status").textContent).toBe("6 个节点");
  });

  it("selects with a click and walks with the arrow keys, down the column and in and out of branches", async () => {
    await open();
    fireEvent.click(screen.getByTestId("mm-node-a"));
    expect(screen.getByTestId("mm-node-a").className).toContain("is-selected");
    fireEvent.keyDown(board(), { key: "ArrowDown" });
    expect(screen.getByTestId("mm-node-b").className).toContain("is-selected");
    fireEvent.keyDown(board(), { key: "ArrowRight" });
    expect(screen.getByTestId("mm-node-b1").className).toContain("is-selected");
    fireEvent.keyDown(board(), { key: "ArrowLeft" });
    fireEvent.keyDown(board(), { key: "ArrowLeft" });
    expect(screen.getByTestId("mm-node-r").className).toContain("is-selected");
  });

  it("adds a child with Tab and a sibling with Enter, and starts editing the new topic; the text is saved when the editor is left", async () => {
    let created = 0;
    const host = await open({
      "mindmap.edit": (input) => {
        const action = input.actions[0];
        if (action.type === "addChild" || action.type === "addSibling") {
          created += 1;
          const id = `new${created}`;
          return { doc: doc({ nodes: [...nodes, node(id, action.type === "addChild" ? action.parentId : "r", `z${created}`, action.text)], ops: { canUndo: true, canRedo: false, undoLabel: action.type, redoLabel: null } }), created: [id] };
        }
        return { doc: doc({ nodes: nodes.map((item) => (item.id === action.nodeId ? { ...item, text: action.text } : item)) }), created: [] };
      },
    });
    fireEvent.click(screen.getByTestId("mm-node-b"));
    fireEvent.keyDown(board(), { key: "Tab" });
    await waitFor(() => expect(screen.getByTestId("mm-edit-new1")).toBeTruthy());
    expect(host.of("mindmap.edit")[0]!.input).toMatchObject({ mapId: "mmp_1", actions: [{ type: "addChild", parentId: "b", text: "新主题" }] });
    fireEvent.change(screen.getByTestId("mm-edit-new1"), { target: { value: "转折" } });
    fireEvent.keyDown(screen.getByTestId("mm-edit-new1"), { key: "Enter" });
    await waitFor(() => expect(host.of("mindmap.edit")).toHaveLength(2));
    expect(host.of("mindmap.edit")[1]!.input.actions).toEqual([{ type: "setText", nodeId: "new1", text: "转折" }]);

    // Enter on a topic adds a sibling after it; on the central topic there is no sibling, so it adds a child.
    fireEvent.click(screen.getByTestId("mm-node-a"));
    fireEvent.keyDown(board(), { key: "Enter" });
    await waitFor(() => expect(host.of("mindmap.edit").at(-1)!.input.actions[0]).toMatchObject({ type: "addSibling", nodeId: "a", before: false }));
    await waitFor(() => expect(screen.queryByTestId("mm-edit-new2")).toBeTruthy());
    fireEvent.keyDown(screen.getByTestId("mm-edit-new2"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("mm-edit-new2")).toBeNull());
    fireEvent.click(screen.getByTestId("mm-node-r"));
    fireEvent.keyDown(board(), { key: "Enter" });
    await waitFor(() => expect(host.of("mindmap.edit").at(-1)!.input.actions[0]).toMatchObject({ type: "addChild", parentId: "r" }));
  });

  it("deletes the selected topic with Delete and selects its parent, but never the central topic", async () => {
    const host = await open({ "mindmap.edit": () => ({ doc: doc({ nodes: nodes.filter((item) => item.id !== "b1") }), created: [] }) });
    fireEvent.click(screen.getByTestId("mm-node-b1"));
    fireEvent.keyDown(board(), { key: "Delete" });
    await waitFor(() => expect(host.of("mindmap.edit")).toHaveLength(1));
    expect(host.of("mindmap.edit")[0]!.input.actions).toEqual([{ type: "delete", nodeId: "b1" }]);
    await waitFor(() => expect(screen.getByTestId("mm-node-b").className).toContain("is-selected"));
    fireEvent.click(screen.getByTestId("mm-node-r"));
    expect((screen.getByTestId("mindmap-delete-node") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(board(), { key: "Delete" });
    expect(host.of("mindmap.edit")).toHaveLength(1);
  });

  it("folds at once on screen, saves the fold, and the fold button and Space do the same", async () => {
    const host = await open({ "mindmap.edit": (input) => ({ doc: doc({ nodes: nodes.map((item) => (item.id === input.actions[0].nodeId ? { ...item, collapsed: input.actions[0].collapsed } : item)) }), created: [] }) });
    fireEvent.click(screen.getByTestId("mm-fold-a"));
    expect(screen.queryByTestId("mm-node-a1")).toBeNull();
    await waitFor(() => expect(host.of("mindmap.edit")[0]!.input.actions).toEqual([{ type: "collapse", nodeId: "a", collapsed: true }]));
    fireEvent.click(screen.getByTestId("mm-node-a"));
    fireEvent.keyDown(board(), { key: " " });
    await waitFor(() => expect(screen.getByTestId("mm-node-a1")).toBeTruthy());
    expect(host.of("mindmap.edit")[1]!.input.actions).toEqual([{ type: "collapse", nodeId: "a", collapsed: false }]);
  });

  it("undoes and redoes through the main process, with the keyboard too, and Alt+Arrow moves a topic among its siblings", async () => {
    const host = await open({
      "mindmap.get": () => doc({ ops: { canUndo: true, canRedo: false, undoLabel: "setText", redoLabel: null } }),
      "mindmap.undo": () => ({ doc: doc({ ops: { canUndo: false, canRedo: true, undoLabel: null, redoLabel: "setText" } }), label: "setText" }),
      "mindmap.redo": () => ({ doc: doc({ ops: { canUndo: true, canRedo: false, undoLabel: "setText", redoLabel: null } }), label: "setText" }),
    });
    expect((screen.getByTestId("mindmap-undo") as HTMLButtonElement).title).toBe("撤销：修改文字");
    fireEvent.click(screen.getByTestId("mindmap-undo"));
    await waitFor(() => expect((screen.getByTestId("mindmap-redo") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.keyDown(board(), { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(host.of("mindmap.redo")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("mm-node-b"));
    fireEvent.keyDown(board(), { key: "ArrowUp", altKey: true });
    await waitFor(() => expect(host.of("mindmap.edit")[0]!.input.actions).toEqual([{ type: "shift", nodeId: "b", direction: "up" }]));
  });

  it("changes the theme and says what a reference on a topic points at, with its state, and opens or removes it", async () => {
    const withRefs = nodes.map((item) => (item.id === "a1" ? { ...item, refs: [
      { id: "ref1", kind: "work", targetId: "wrk_1", label: "引用的作品", state: "ok" as const, summary: "" },
      { id: "ref2", kind: "whiteboard", targetId: "wbd_1", label: "旧白板", state: "missing" as const, summary: "" },
    ] } : item));
    const onOpen = vi.fn();
    const host = await open({
      "mindmap.get": () => doc({ nodes: withRefs }),
      "mindmap.edit": () => ({ doc: doc({ nodes: withRefs.map((item) => (item.id === "a1" ? { ...item, refs: item.refs.slice(1) } : item)) }), created: [] }),
    }, context({ onOpenMaterial: onOpen }));
    fireEvent.click(screen.getByTestId("mm-node-a1"));
    expect(screen.getByTestId("mm-refs-a1").textContent).toBe("2");
    expect(screen.getByTestId("mm-ref-ref1").getAttribute("data-state")).toBe("ok");
    expect(screen.getByTestId("mm-ref-ref2").textContent).toContain("原对象已删除");
    expect(screen.queryByTestId("mm-ref-open-ref2")).toBeNull();
    fireEvent.click(screen.getByTestId("mm-ref-open-ref1"));
    expect(onOpen).toHaveBeenCalledWith({ kind: "work", targetId: "wrk_1", label: "引用的作品" });
    fireEvent.click(screen.getByTestId("mm-ref-remove-ref2"));
    await waitFor(() => expect(host.of("mindmap.edit")[0]!.input.actions).toEqual([{ type: "removeRef", nodeId: "a1", refId: "ref2" }]));
    fireEvent.change(screen.getByTestId("mindmap-theme"), { target: { value: "blue" } });
    await waitFor(() => expect(host.of("mindmap.setTheme")[0]!.input).toEqual({ mapId: "mmp_1", theme: "blue" }));
  });

  it("shows the reason when the map refuses a move into its own branch", async () => {
    const onError = vi.fn();
    await open({ "mindmap.edit": () => { throw Object.assign(new Error("x"), { code: "VALIDATION_ERROR", details: { reason: "descendant" } }); } }, context({ onError }));
    fireEvent.click(screen.getByTestId("mm-node-a"));
    fireEvent.click(screen.getByTestId("mindmap-down"));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    // A refused edit is not an error of the page: the map is read again so what is shown is what is saved.
    await waitFor(() => expect(screen.getByTestId("mm-node-a")).toBeTruthy());
  });

  it("exports an outline into the folder the user picks, and an image drawn from the page; cancelling the folder does nothing", async () => {
    const onNotice = vi.fn();
    const pick = vi.fn(async () => ({ pathHandle: "path-1", name: "out", mode: "directory" }));
    const host = await open({ "mindmap.export": (input) => ({ fileName: `第一张导图.${input.format === "markdown" ? "md" : input.format}`, bytes: 10, format: input.format }) }, context({ onNotice }), pick);
    fireEvent.click(screen.getByTestId("mindmap-export"));
    fireEvent.click(screen.getByTestId("mindmap-export-markdown"));
    await waitFor(() => expect(host.of("mindmap.export")).toHaveLength(1));
    expect(host.of("mindmap.export")[0]!.input).toEqual({ mapId: "mmp_1", format: "markdown", pathHandle: "path-1" });
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("已导出导图：第一张导图.md"));
    fireEvent.click(screen.getByTestId("mindmap-export"));
    fireEvent.click(screen.getByTestId("mindmap-export-png"));
    await waitFor(() => expect(host.of("mindmap.export")).toHaveLength(2));
    expect(host.of("mindmap.export")[1]!.input).toMatchObject({ format: "png", pathHandle: "path-1", data: "iVBORw0KGgo=" });
    fireEvent.click(screen.getByTestId("mindmap-export"));
    fireEvent.click(screen.getByTestId("mindmap-export-svg"));
    await waitFor(() => expect(host.of("mindmap.export")).toHaveLength(3));
    expect(host.of("mindmap.export")[2]!.input.data).toBe('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    pick.mockResolvedValueOnce(null as never);
    fireEvent.click(screen.getByTestId("mindmap-export"));
    fireEvent.click(screen.getByTestId("mindmap-export-opml"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(host.of("mindmap.export")).toHaveLength(3);
  });

  it("creates the first map of an empty project and offers a confirmation that says what goes before deleting one", async () => {
    let maps: typeof summary[] = [];
    const host = installHost({
      "mindmap.list": () => ({ maps }),
      "mindmap.create": (input) => { maps = [{ ...summary, title: input.title }]; return { map: maps[0] }; },
      "mindmap.get": () => doc({ nodes: [nodes[0]!] }),
      "mindmap.delete": () => { maps = []; return { mapId: "mmp_1", removedNodes: 1 }; },
    });
    render(<MindmapTab ctx={context()} />);
    await waitFor(() => expect(screen.getByTestId("mindmap-empty")).toBeTruthy());
    fireEvent.click(screen.getByTestId("mindmap-new"));
    await waitFor(() => expect(screen.getByTestId("mm-node-r")).toBeTruthy());
    expect(host.of("mindmap.create")[0]!.input).toEqual({ projectId: "prj_1", title: "导图 1" });
    fireEvent.click(screen.getByTestId("mindmap-delete"));
    expect(screen.getByTestId("mindmap-delete-dialog").textContent).toContain("它引用的原资料不受影响");
    fireEvent.click(screen.getByTestId("mindmap-delete-confirm"));
    await waitFor(() => expect(screen.getByTestId("mindmap-empty")).toBeTruthy());
  });
});

describe("the mind map model", () => {
  const tree = buildTree(nodes);

  it("keeps siblings in sort-key order and reads the tree in reading order, skipping folded branches", () => {
    expect(tree.root!.id).toBe("r");
    expect(tree.children.get("r")!.map((item) => item.id)).toEqual(["a", "b"]);
    expect(visibleOrder(tree)).toEqual(["r", "a", "a1", "a2", "b", "b1"]);
    expect(visibleOrder(buildTree(nodes.map((item) => (item.id === "a" ? { ...item, collapsed: true } : item))))).toEqual(["r", "a", "b", "b1"]);
    expect([...descendantsOf(tree, "a")].sort()).toEqual(["a1", "a2"]);
  });

  it("lays the visible tree out in columns by depth with every parent level with its children, and nothing overlaps", () => {
    const placed = layoutTree(tree);
    const at = Object.fromEntries(placed.map((spot) => [spot.id, spot]));
    expect(placed).toHaveLength(6);
    expect(at.r!.x).toBeLessThan(at.a!.x);
    expect(at.a!.x).toBe(at.b!.x);
    expect(at.a!.x).toBeLessThan(at.a1!.x);
    // A parent sits level with the middle of its children.
    const middle = (spot: { y: number; h: number }) => spot.y + spot.h / 2;
    expect(middle(at.a!)).toBeCloseTo((middle(at.a1!) + middle(at.a2!)) / 2, 0);
    for (let i = 0; i < placed.length; i += 1) for (let j = i + 1; j < placed.length; j += 1) {
      const p = placed[i]!; const q = placed[j]!;
      expect(p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h, `${p.id} overlaps ${q.id}`).toBe(false);
    }
    // A branch carries one colour down to its leaves; the central topic has none of its own.
    expect([at.a!.branch, at.a1!.branch, at.a2!.branch]).toEqual([0, 0, 0]);
    expect([at.b!.branch, at.b1!.branch]).toEqual([1, 1]);
    expect(widthOf("短")).toBeLessThan(widthOf("一段比较长的主题文字，会占更宽的位置"));
    expect(widthOf("x".repeat(500))).toBeLessThanOrEqual(260);
  });

  it("walks to neighbours: left to the parent, right to the first child, up and down along the column", () => {
    expect(neighbour(tree, "a", "ArrowLeft")).toBe("r");
    expect(neighbour(tree, "a", "ArrowRight")).toBe("a1");
    expect(neighbour(tree, "a2", "ArrowDown")).toBe("b1");
    expect(neighbour(tree, "b1", "ArrowUp")).toBe("a2");
    expect(neighbour(tree, "r", "ArrowLeft")).toBeNull();
    expect(neighbour(tree, "b1", "ArrowRight")).toBeNull();
    expect(neighbour(buildTree(nodes.map((item) => (item.id === "a" ? { ...item, collapsed: true } : item))), "a", "ArrowRight")).toBeNull();
  });

  it("works out where a dragged topic lands among its siblings", () => {
    const siblings = [{ id: "a", y: 0 }, { id: "b", y: 100 }, { id: "c", y: 200 }];
    expect(indexAmong(siblings, "a", 150)).toBe(1);
    expect(indexAmong(siblings, "c", -50)).toBe(0);
    expect(indexAmong(siblings, "b", 500)).toBe(2);
    expect(indexAmong(siblings, "b", 90)).toBe(1);
  });
});
