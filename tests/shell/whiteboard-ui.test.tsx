/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { WhiteboardTab } from "../../apps/desktop/src/renderer/pages/projects/canvas/whiteboard-tab.tsx";
import { mergeEdges, mergeNodes, flowNodesOf, groupAt, type WbDelta, type WbNode } from "../../apps/desktop/src/renderer/pages/projects/canvas/whiteboard-model.ts";
import type { ProjectTabContext } from "../../apps/desktop/src/renderer/pages/projects/project-page.tsx";

const i18n = createTranslator("zh-CN");
const t = i18n.t;

// The canvas library measures the DOM; jsdom has no layout, so give it the few things it asks for.
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
function installHost(handlers: Record<string, Handler>) {
  const calls: Call[] = [];
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input?: Record<string, any> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      const handler = handlers[payload.commandId];
      if (!handler) return { status: "ok", value: {} };
      try { return { status: "ok", value: handler(input) }; } catch (error) {
        const failure = error as { code?: string; message?: string };
        return { status: "error", error: { code: failure.code ?? "INTERNAL", message: failure.message ?? "failed" } };
      }
    },
  };
  return { calls, of: (id: string) => calls.filter((call) => call.commandId === id) };
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const noOps = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };
const node = (id: string, kind: WbNode["kind"], x: number, y: number, data: Record<string, unknown> = {}, extra: Partial<WbNode> = {}): WbNode => ({ id, kind, x, y, w: 200, h: 100, z: 1, parentId: null, data, ...extra });
const board = { id: "wbd_1", title: "第一块白板", nodes: 3, edges: 1, updatedAt: "2026-10-01T10:00:00.000Z" };

function context(overrides: Partial<ProjectTabContext> = {}): ProjectTabContext {
  return {
    t, formatDate: i18n.formatDate, reload: () => undefined, onError: () => undefined, onNotice: () => undefined, focus: null, onFocus: () => undefined, onTab: () => undefined, onOpenMaterial: () => undefined,
    detail: { project: { id: "prj_1", name: "项目", goal: "", status: "active", modelConnectionId: null, counts: {} }, materials: [], terms: [], sessions: [] },
    ...overrides,
  };
}

const nodes: WbNode[] = [
  node("n1", "card", 10, 20, { title: "第一张卡片", text: "卡片正文" }),
  node("n2", "text", 300, 40, { text: "一段自由文字" }),
  node("n3", "ref", 600, 60, { refKind: "work", targetId: "wrk_1", label: "引用的作品" }),
];
const doc = (overrides: Record<string, unknown> = {}) => ({
  board: { id: "wbd_1", projectId: "prj_1", title: "第一块白板", viewport: { x: 0, y: 0, zoom: 1 } },
  nodes, edges: [{ id: "e1", sourceId: "n1", targetId: "n2", label: "引出" }], refs: { n3: { state: "ok", label: "引用的作品", summary: "", mode: "live" } }, ops: noOps, ...overrides,
});
const delta = (overrides: Partial<WbDelta> = {}): WbDelta & { created: string[] } => ({ nodes: [], removedNodes: [], edges: [], removedEdges: [], refs: {}, ops: noOps, created: [], ...overrides });

describe("the whiteboard tab (AT-26)", () => {
  it("lists the project's boards, opens the first one and shows its cards, text, references and the state of what a reference points at", async () => {
    installHost({
      "whiteboard.list": () => ({ boards: [board] }),
      "whiteboard.get": () => doc({ refs: { n3: { state: "missing", label: "引用的作品", summary: "", mode: "live" } } }),
    });
    render(<WhiteboardTab ctx={context()} />);
    await waitFor(() => expect(screen.getByTestId("wb-node-n1")).toBeTruthy());
    expect(screen.getByTestId("whiteboard-board-wbd_1").textContent).toContain("第一块白板");
    expect(screen.getByTestId("wb-node-n1").textContent).toContain("第一张卡片");
    expect(screen.getByTestId("wb-node-n2").textContent).toContain("一段自由文字");
    // A reference whose target is gone says so and offers no way to open it; the saved name is still readable.
    expect(screen.getByTestId("wb-state-n3").textContent).toBe("原对象已删除");
    expect(screen.getByTestId("wb-node-n3").textContent).toContain("引用的作品");
    expect(screen.queryByTestId("wb-open-n3")).toBeNull();
    expect(screen.getByTestId("whiteboard-status").textContent).toBe("3 个对象 · 1 条连线");
  });

  it("opens the original of a live reference, and keeps the selection tools off until something is selected", async () => {
    installHost({ "whiteboard.list": () => ({ boards: [board] }), "whiteboard.get": () => doc() });
    const open = vi.fn();
    render(<WhiteboardTab ctx={context({ onOpenMaterial: open })} />);
    await waitFor(() => expect(screen.getByTestId("wb-open-n3")).toBeTruthy());
    // The selection tools wait for a selection.
    expect((screen.getByTestId("whiteboard-group") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("whiteboard-align-left") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("whiteboard-undo") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("wb-open-n3"));
    expect(open).toHaveBeenCalledWith({ kind: "work", targetId: "wrk_1", label: "引用的作品" });
  });

  it("adds a card through one edit, shows it and starts editing it; the text is saved as one more edit when the editor is left", async () => {
    const created = node("n9", "card", 100, 100, {});
    const host = installHost({
      "whiteboard.list": () => ({ boards: [board] }),
      "whiteboard.get": () => doc(),
      "whiteboard.edit": (input) => (input.actions[0].type === "addNode"
        ? delta({ nodes: [created], created: ["n9"], ops: { canUndo: true, canRedo: false, undoLabel: "addNode", redoLabel: null } })
        : delta({ nodes: [{ ...created, data: input.actions[0].data }], ops: { canUndo: true, canRedo: false, undoLabel: "updateNode", redoLabel: null } })),
    });
    render(<WhiteboardTab ctx={context()} />);
    await waitFor(() => expect(screen.getByTestId("wb-node-n1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("whiteboard-add-card"));
    await waitFor(() => expect(screen.getByTestId("wb-title-n9")).toBeTruthy());
    expect(host.of("whiteboard.edit")[0]!.input).toMatchObject({ boardId: "wbd_1", actions: [{ type: "addNode", kind: "card" }] });
    expect((screen.getByTestId("whiteboard-undo") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByTestId("wb-title-n9"), { target: { value: "新想法" } });
    fireEvent.change(screen.getByTestId("wb-body-n9"), { target: { value: "写下来" } });
    // Moving from the title to the body is not leaving the editor; leaving the editor saves.
    fireEvent.blur(screen.getByTestId("wb-title-n9"), { relatedTarget: screen.getByTestId("wb-body-n9") });
    expect(host.of("whiteboard.edit")).toHaveLength(1);
    fireEvent.blur(screen.getByTestId("wb-body-n9"), { relatedTarget: null });
    await waitFor(() => expect(host.of("whiteboard.edit")).toHaveLength(2));
    expect(host.of("whiteboard.edit")[1]!.input.actions).toEqual([{ type: "updateNode", id: "n9", data: { title: "新想法", text: "写下来" } }]);
    await waitFor(() => expect(screen.getByTestId("wb-node-n9").textContent).toContain("新想法"));
  });

  it("undoes and redoes through the main process and reflects the result; nothing to undo is not an error", async () => {
    const onError = vi.fn();
    let state: "done" | "undone" = "done";
    const host = installHost({
      "whiteboard.list": () => ({ boards: [board] }),
      "whiteboard.get": () => doc({ ops: { canUndo: true, canRedo: false, undoLabel: "moveNodes", redoLabel: null } }),
      "whiteboard.undo": () => { state = "undone"; return delta({ nodes: [{ ...nodes[0]!, x: 0 }], ops: { canUndo: false, canRedo: true, undoLabel: null, redoLabel: "moveNodes" } }); },
      "whiteboard.redo": () => { state = "done"; return delta({ nodes: [{ ...nodes[0]!, x: 10 }], ops: { canUndo: true, canRedo: false, undoLabel: "moveNodes", redoLabel: null } }); },
    });
    render(<WhiteboardTab ctx={context({ onError })} />);
    await waitFor(() => expect(screen.getByTestId("wb-node-n1")).toBeTruthy());
    const undo = screen.getByTestId("whiteboard-undo") as HTMLButtonElement;
    expect(undo.title).toBe("撤销：移动");
    fireEvent.click(undo);
    await waitFor(() => expect((screen.getByTestId("whiteboard-redo") as HTMLButtonElement).disabled).toBe(false));
    expect(state).toBe("undone");
    expect((screen.getByTestId("whiteboard-undo") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("whiteboard-redo"));
    await waitFor(() => expect((screen.getByTestId("whiteboard-undo") as HTMLButtonElement).disabled).toBe(false));
    expect(host.of("whiteboard.undo")).toHaveLength(1);
    // Keyboard shortcut goes to the same command.
    fireEvent.keyDown(screen.getByTestId("whiteboard-board"), { key: "z", ctrlKey: true });
    await waitFor(() => expect(host.of("whiteboard.undo")).toHaveLength(2));
    expect(onError).not.toHaveBeenCalled();
  });

  it("creates the first board of an empty project, and deletes a board only after a confirmation that says what goes", async () => {
    let boards: typeof board[] = [];
    const host = installHost({
      "whiteboard.list": () => ({ boards }),
      "whiteboard.create": (input) => { boards = [{ ...board, nodes: 0, edges: 0, title: input.title }]; return { board: boards[0] }; },
      "whiteboard.get": () => doc({ nodes: [], edges: [], refs: {} }),
      "whiteboard.delete": () => { boards = []; return { boardId: "wbd_1", removedNodes: 0 }; },
    });
    render(<WhiteboardTab ctx={context()} />);
    await waitFor(() => expect(screen.getByTestId("whiteboard-empty")).toBeTruthy());
    fireEvent.click(screen.getByTestId("whiteboard-new"));
    await waitFor(() => expect(screen.getByTestId("whiteboard-board")).toBeTruthy());
    expect(host.of("whiteboard.create")[0]!.input).toEqual({ projectId: "prj_1", title: "白板 1" });
    expect(screen.getByTestId("whiteboard-hint")).toBeTruthy();

    fireEvent.click(screen.getByTestId("whiteboard-delete"));
    const dialog = screen.getByTestId("whiteboard-delete-dialog");
    expect(within(dialog).getByText(/它引用的原资料不受影响/)).toBeTruthy();
    expect(host.of("whiteboard.delete")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("whiteboard-delete-confirm"));
    await waitFor(() => expect(screen.getByTestId("whiteboard-empty")).toBeTruthy());
    expect(host.of("whiteboard.delete")[0]!.input).toEqual({ boardId: "wbd_1" });
  });

  it("opens the board that was asked for through the project's focus", async () => {
    const second = { ...board, id: "wbd_2", title: "第二块" };
    const host = installHost({ "whiteboard.list": () => ({ boards: [board, second] }), "whiteboard.get": (input) => doc({ board: { id: input.boardId, projectId: "prj_1", title: "x", viewport: { x: 0, y: 0, zoom: 1 } } }) });
    const onFocus = vi.fn();
    render(<WhiteboardTab ctx={context({ focus: { kind: "whiteboard", id: "wbd_2" }, onFocus })} />);
    await waitFor(() => expect(host.of("whiteboard.get").some((call) => call.input.boardId === "wbd_2")).toBe(true));
    expect(screen.getByTestId("whiteboard-board-wbd_2").getAttribute("aria-current")).toBe("true");
    await waitFor(() => expect(onFocus).toHaveBeenCalledWith(null));
  });
});

describe("the whiteboard model", () => {
  it("folds a change into the nodes on show and leaves the nodes it does not mention as they were", () => {
    const current = flowNodesOf({ nodes, refs: {} });
    const next = mergeNodes(current, { nodes: [{ ...nodes[0]!, x: 99 }, node("n4", "card", 0, 0)], removedNodes: ["n2"], refs: {} });
    expect(next.map((item) => item.id)).toEqual(["n1", "n3", "n4"]);
    expect(next.find((item) => item.id === "n1")!.position.x).toBe(99);
    expect(next.find((item) => item.id === "n3")).toBe(current.find((item) => item.id === "n3"));
    // An empty change returns the very same list, so nothing is drawn again.
    expect(mergeNodes(current, { nodes: [], removedNodes: [], refs: {} })).toBe(current);
    const edges = mergeEdges([{ id: "e1", source: "n1", target: "n2" }], { edges: [{ id: "e2", sourceId: "n1", targetId: "n3", label: "x" }], removedEdges: ["e1"], removedNodes: [] });
    expect(edges).toEqual([{ id: "e2", source: "n1", target: "n3", label: "x" }]);
  });

  it("finds the topmost group that holds the centre of a dropped card", () => {
    const list = flowNodesOf({
      nodes: [node("g1", "group", 0, 0, {}, { w: 400, h: 400, z: -1 }), node("g2", "group", 100, 100, {}, { w: 150, h: 150, z: -2 }), node("c", "card", 120, 120, {}, { w: 40, h: 40 }), node("far", "card", 800, 800)],
      refs: {},
    });
    expect(groupAt(list, list.find((item) => item.id === "c")!)).toBe("g1");
    expect(groupAt(list, list.find((item) => item.id === "far")!)).toBeNull();
  });
});
