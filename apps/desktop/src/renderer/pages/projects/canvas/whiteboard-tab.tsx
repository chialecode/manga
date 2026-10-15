import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, ConnectionMode, Controls, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow, type Connection, type OnSelectionChangeParams } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AlignCenterHorizontal, AlignCenterVertical, AlignEndHorizontal, AlignEndVertical, AlignStartHorizontal, AlignStartVertical, ArrowDownToLine, ArrowUpToLine, BoxSelect, Group, Hand, Grid3x3, Link2, Plus, Redo2, StickyNote, Trash2, Type, Undo2, Ungroup } from "lucide-react";
import type { WhiteboardActionInput } from "@manga/contracts/canvas";
import { attempt } from "../../../lib/api.ts";
import { DocWorkspace, type DocKind } from "./doc-workspace.tsx";
import type { ProjectTabContext } from "../project-page.tsx";
import { BoardContext, WHITEBOARD_NODE_TYPES, type BoardActions, type OpenTarget } from "./whiteboard-nodes.tsx";
import { RefPicker, type PickedRef } from "./ref-picker.tsx";
import {
  CARD_COLORS, NO_OPS, flowNodesOf, groupAt, mergeEdges, mergeNodes, opLabelKey, round, toFlowEdge,
  type FlowEdge, type FlowNode, type WbDelta, type WbDoc, type WbOps,
} from "./whiteboard-model.ts";

type BoardSummary = { id: string; title: string; nodes: number; edges: number; updatedAt: string };
type Action = WhiteboardActionInput;
type EditResult = WbDelta & { created: string[] };

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable));
};

const BOARD_KIND: DocKind<BoardSummary> = {
  prefix: "whiteboard", item: "board", focusKind: "whiteboard",
  commands: { list: "whiteboard.list", create: "whiteboard.create", rename: "whiteboard.rename", delete: "whiteboard.delete" },
  idField: "boardId", listField: "boards", createdField: "board",
  meta: (board, ctx) => ctx.t("whiteboard.counts", { nodes: board.nodes, edges: board.edges }),
  defaultTitle: (n, ctx) => ctx.t("whiteboard.defaultTitle", { n }),
  words: { list: "whiteboard.boards", empty: "whiteboard.empty", create: "whiteboard.new", rename: "whiteboard.rename", remove: "whiteboard.delete", confirm: "whiteboard.deleteConfirm", titleLabel: "whiteboard.titleLabel" },
};

/** The whiteboards of one project: the list on the left and the board on show filling the rest. */
export function WhiteboardTab({ ctx }: { ctx: ProjectTabContext }) {
  return (
    <DocWorkspace ctx={ctx} kind={BOARD_KIND} render={(boardId, refresh) => (
      <ReactFlowProvider key={boardId}>
        <BoardView ctx={ctx} boardId={boardId} onChanged={refresh} />
      </ReactFlowProvider>
    )} />
  );
}

function BoardView({ ctx, boardId, onChanged }: { ctx: ProjectTabContext; boardId: string; onChanged: () => void }) {
  const { t } = ctx;
  const flow = useReactFlow<FlowNode, FlowEdge>();
  const [doc, setDoc] = useState<WbDoc | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);
  const [ops, setOps] = useState<WbOps>(NO_OPS);
  const [selection, setSelection] = useState<{ nodes: string[]; edges: string[] }>({ nodes: [], edges: [] });
  const [mode, setMode] = useState<"select" | "pan">("select");
  const [editId, setEditId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const nodesRef = useRef<FlowNode[]>([]);
  const viewportTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragGroup = useRef<{ id: string; start: { x: number; y: number }; members: Map<string, { x: number; y: number }> } | null>(null);
  const cascade = useRef(0);
  const onError = useRef(ctx.onError);
  onError.current = ctx.onError;
  nodesRef.current = nodes;

  const applyDelta = useCallback((delta: WbDelta) => {
    setNodes((current) => mergeNodes(current, delta));
    setEdges((current) => mergeEdges(current, { ...delta, removedNodes: delta.removedNodes }));
    setOps(delta.ops);
  }, [setNodes, setEdges]);

  const load = useCallback(async () => {
    const result = await attempt<WbDoc>("whiteboard.get", { boardId });
    if (!result.ok) { onError.current(result.error.message); return; }
    setDoc(result.value);
    setNodes(flowNodesOf(result.value));
    setEdges(result.value.edges.map(toFlowEdge));
    setOps(result.value.ops);
  }, [boardId, setNodes, setEdges]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => clearTimeout(viewportTimer.current), []);

  /** One edit at a time, in the order they were made, so a drag that ends right after a new card cannot overtake it. */
  const commit = useCallback((actions: Action[], label?: string): Promise<EditResult | null> => {
    const run = async (): Promise<EditResult | null> => {
      const result = await attempt<EditResult>("whiteboard.edit", { boardId, actions, ...(label ? { label } : {}) });
      if (!result.ok) { onError.current(result.error.message); await load(); return null; }
      applyDelta(result.value);
      onChanged();
      return result.value;
    };
    const next = queue.current.then(run, run);
    queue.current = next.catch(() => undefined);
    return next;
  }, [boardId, applyDelta, load, onChanged]);

  const step = useCallback(async (direction: "undo" | "redo") => {
    const run = async () => {
      const result = await attempt<WbDelta>(`whiteboard.${direction}`, { boardId });
      if (!result.ok) { if (result.error.code !== "NOT_FOUND") onError.current(result.error.message); await load(); return; }
      applyDelta(result.value);
      onChanged();
    };
    const next = queue.current.then(run, run);
    queue.current = next.catch(() => undefined);
    await next;
  }, [boardId, applyDelta, load, onChanged]);

  const centerPoint = useCallback(() => {
    const rect = wrapper.current?.getBoundingClientRect();
    const point = flow.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 600) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 400) / 2 });
    cascade.current = (cascade.current + 1) % 8;
    return { x: round(point.x - 120 + cascade.current * 24), y: round(point.y - 60 + cascade.current * 24) };
  }, [flow]);

  const addNode = useCallback(async (kind: "card" | "text", at?: { x: number; y: number }, data?: Record<string, unknown>) => {
    const point = at ?? centerPoint();
    const result = await commit([{ type: "addNode", kind, x: point.x, y: point.y, ...(data ? { data } : {}) }]);
    const id = result?.created[0];
    if (id) { setNodes((current) => current.map((node) => ({ ...node, selected: node.id === id }))); setEditId(id); }
  }, [commit, centerPoint, setNodes]);

  const addRef = useCallback(async (picked: PickedRef) => {
    setPicking(false);
    const point = centerPoint();
    const result = await commit([{ type: "addNode", kind: "ref", x: point.x, y: point.y, data: { refKind: picked.kind, targetId: picked.id, label: picked.label, ...(picked.mode === "snapshot" ? { mode: "snapshot" } : {}) } }]);
    const id = result?.created[0];
    if (id) setNodes((current) => current.map((node) => ({ ...node, selected: node.id === id })));
  }, [commit, centerPoint, setNodes]);

  const actions = useMemo<BoardActions>(() => ({
    t, editId, edit: setEditId,
    update: (id, data) => { void commit([{ type: "updateNode", id, data }]); },
    resize: (id, rect) => { void commit([{ type: "resizeNode", id, w: Math.max(16, round(rect.width)), h: Math.max(16, round(rect.height)), x: round(rect.x), y: round(rect.y) }]); },
    open: (target: OpenTarget) => ctx.onOpenMaterial({ kind: target.kind as never, targetId: target.targetId, label: target.label, ...(target.opens ? { opens: target.opens } : {}) }),
  }), [t, editId, commit, ctx]);

  // ---- dragging, connecting, deleting ----

  const onNodeDragStart = useCallback((_: unknown, node: FlowNode) => {
    if (node.type !== "group") { dragGroup.current = null; return; }
    const members = new Map<string, { x: number; y: number }>();
    for (const other of nodesRef.current) if (other.data.node.parentId === node.id) members.set(other.id, { ...other.position });
    dragGroup.current = { id: node.id, start: { ...node.position }, members };
  }, []);

  const onNodeDrag = useCallback((_: unknown, node: FlowNode) => {
    const drag = dragGroup.current;
    if (!drag || drag.id !== node.id || !drag.members.size) return;
    const dx = node.position.x - drag.start.x;
    const dy = node.position.y - drag.start.y;
    setNodes((current) => current.map((other) => { const from = drag.members.get(other.id); return from ? { ...other, position: { x: from.x + dx, y: from.y + dy } } : other; }));
  }, [setNodes]);

  const onNodeDragStop = useCallback((_: unknown, node: FlowNode, dragged: FlowNode[]) => {
    dragGroup.current = null;
    const moved = dragged.length ? dragged : [node];
    const steps: Action[] = [{ type: "moveNodes", moves: moved.map((item) => ({ id: item.id, x: round(item.position.x), y: round(item.position.y) })) }];
    // A card dropped into a group joins it; one taken out of every group leaves it.
    const movedIds = new Set(moved.map((item) => item.id));
    for (const item of moved) {
      if (item.type === "group") continue;
      const target = groupAt(nodesRef.current.map((other) => (movedIds.has(other.id) ? moved.find((m) => m.id === other.id) ?? other : other)), item);
      const current = item.data.node.parentId;
      if (target !== current) steps.push({ type: "setGroup", ids: [item.id], groupId: target });
    }
    void commit(steps, "moveNodes");
  }, [commit]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    void commit([{ type: "addEdge", sourceId: connection.source, targetId: connection.target }]);
  }, [commit]);

  const onDelete = useCallback(({ nodes: removedNodes, edges: removedEdges }: { nodes: FlowNode[]; edges: FlowEdge[] }) => {
    const gone = new Set(removedNodes.map((node) => node.id));
    const steps: Action[] = [];
    if (removedNodes.length) steps.push({ type: "deleteNodes", ids: removedNodes.map((node) => node.id) });
    const own = removedEdges.filter((edge) => !gone.has(edge.source) && !gone.has(edge.target)).map((edge) => edge.id);
    if (own.length) steps.push({ type: "deleteEdges", ids: own });
    if (steps.length) void commit(steps);
  }, [commit]);

  const onMoveEnd = useCallback((_: unknown, viewport: { x: number; y: number; zoom: number }) => {
    clearTimeout(viewportTimer.current);
    viewportTimer.current = setTimeout(() => { void attempt("whiteboard.setViewport", { boardId, viewport: { x: round(viewport.x), y: round(viewport.y), zoom: round(viewport.zoom) } }); }, 400);
  }, [boardId]);

  const onSelectionChange = useCallback((params: OnSelectionChangeParams) => {
    setSelection((current) => {
      const ids = params.nodes.map((node) => node.id);
      const edgeIds = params.edges.map((edge) => edge.id);
      return current.nodes.join() === ids.join() && current.edges.join() === edgeIds.join() ? current : { nodes: ids, edges: edgeIds };
    });
  }, []);

  const onDoubleClick = useCallback((event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (!target.classList.contains("react-flow__pane")) return;
    const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    void addNode("card", { x: round(point.x - 120), y: round(point.y - 30) });
  }, [flow, addNode]);

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (isTyping(event.target)) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (mod && key === "z") { event.preventDefault(); void step(event.shiftKey ? "redo" : "undo"); }
    else if (mod && key === "y") { event.preventDefault(); void step("redo"); }
    else if (mod && key === "g") { event.preventDefault(); void groupSelected(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selection]);

  // ---- the selection's toolbar ----

  const selectedNodes = useMemo(() => nodes.filter((node) => selection.nodes.includes(node.id)), [nodes, selection.nodes]);
  const pickable = selectedNodes.filter((node) => node.type !== "group");
  const groups = selectedNodes.filter((node) => node.type === "group");
  const colorTargets = selectedNodes.filter((node) => node.type === "card" || node.type === "group");
  const singleEdge = selection.edges.length === 1 && !selection.nodes.length ? edges.find((edge) => edge.id === selection.edges[0]) : undefined;

  function groupSelected() {
    if (pickable.length) void commit([{ type: "group", ids: pickable.map((node) => node.id) }]);
  }
  const arrange = (action: Action) => { void commit([action]); };
  const ids = selection.nodes;
  const opLabel = (label: string | null) => (label ? t(opLabelKey(label) as never) : "");

  if (!doc) return <div className="wb-canvas" aria-busy="true" />;
  const many = nodes.length > 150;
  const selectMode = mode === "select";

  return (
    <BoardContext.Provider value={actions}>
      <div className="wb-board" data-testid="whiteboard-board" data-board={boardId} data-nodes={nodes.length} onKeyDown={onKeyDown}>
        <div className="wb-toolbar" role="toolbar" aria-label={t("whiteboard.toolbar")} data-testid="whiteboard-toolbar">
          <span className="wb-tool-group">
            <button type="button" data-testid="whiteboard-add-card" onClick={() => void addNode("card")} title={t("whiteboard.addCard")}><StickyNote size={15} aria-hidden="true" /> {t("whiteboard.addCard")}</button>
            <button type="button" data-testid="whiteboard-add-text" onClick={() => void addNode("text")} title={t("whiteboard.addText")}><Type size={15} aria-hidden="true" /> {t("whiteboard.addText")}</button>
            <button type="button" data-testid="whiteboard-add-ref" onClick={() => setPicking(true)} title={t("whiteboard.addRef")}><Link2 size={15} aria-hidden="true" /> {t("whiteboard.addRef")}</button>
          </span>
          <span className="wb-tool-group">
            <button type="button" aria-pressed={selectMode} data-testid="whiteboard-mode-select" onClick={() => setMode("select")} title={t("whiteboard.mode.select")}><BoxSelect size={15} aria-hidden="true" /><span className="sr-only">{t("whiteboard.mode.select")}</span></button>
            <button type="button" aria-pressed={!selectMode} data-testid="whiteboard-mode-pan" onClick={() => setMode("pan")} title={t("whiteboard.mode.pan")}><Hand size={15} aria-hidden="true" /><span className="sr-only">{t("whiteboard.mode.pan")}</span></button>
          </span>
          <span className="wb-tool-group">
            <button type="button" data-testid="whiteboard-undo" disabled={!ops.canUndo} onClick={() => void step("undo")} title={ops.undoLabel ? t("whiteboard.undoLabel", { label: opLabel(ops.undoLabel) }) : t("whiteboard.nothingToUndo")} aria-label={t("whiteboard.undo")}><Undo2 size={15} aria-hidden="true" /></button>
            <button type="button" data-testid="whiteboard-redo" disabled={!ops.canRedo} onClick={() => void step("redo")} title={ops.redoLabel ? t("whiteboard.redoLabel", { label: opLabel(ops.redoLabel) }) : t("whiteboard.redo")} aria-label={t("whiteboard.redo")}><Redo2 size={15} aria-hidden="true" /></button>
          </span>
          <span className="wb-tool-group" aria-label={t("whiteboard.align")}>
            {([["left", AlignStartVertical], ["hcenter", AlignCenterVertical], ["right", AlignEndVertical], ["top", AlignStartHorizontal], ["vcenter", AlignCenterHorizontal], ["bottom", AlignEndHorizontal]] as const).map(([alignMode, Icon]) => (
              <button key={alignMode} type="button" data-testid={`whiteboard-align-${alignMode}`} disabled={ids.length < 2} title={t(`whiteboard.align.${alignMode}` as never)} aria-label={t(`whiteboard.align.${alignMode}` as never)} onClick={() => arrange({ type: "align", ids, mode: alignMode })}><Icon size={15} aria-hidden="true" /></button>
            ))}
            <button type="button" data-testid="whiteboard-distribute-h" disabled={ids.length < 3} title={t("whiteboard.distribute.h")} onClick={() => arrange({ type: "distribute", ids, axis: "h" })}>⇔</button>
            <button type="button" data-testid="whiteboard-distribute-v" disabled={ids.length < 3} title={t("whiteboard.distribute.v")} onClick={() => arrange({ type: "distribute", ids, axis: "v" })}>⇕</button>
            <button type="button" data-testid="whiteboard-arrange" disabled={ids.length < 2} title={t("whiteboard.arrange")} aria-label={t("whiteboard.arrange")} onClick={() => arrange({ type: "arrange", ids })}><Grid3x3 size={15} aria-hidden="true" /></button>
          </span>
          <span className="wb-tool-group">
            <button type="button" data-testid="whiteboard-group" disabled={!pickable.length} onClick={groupSelected} title={t("whiteboard.group")}><Group size={15} aria-hidden="true" /> {t("whiteboard.group")}</button>
            <button type="button" data-testid="whiteboard-ungroup" disabled={!groups.length} onClick={() => { void commit(groups.map((node) => ({ type: "ungroup" as const, id: node.id }))); }} title={t("whiteboard.ungroup")}><Ungroup size={15} aria-hidden="true" /> {t("whiteboard.ungroup")}</button>
            <button type="button" data-testid="whiteboard-front" disabled={!ids.length} onClick={() => arrange({ type: "order", ids, to: "front" })} title={t("whiteboard.front")} aria-label={t("whiteboard.front")}><ArrowUpToLine size={15} aria-hidden="true" /></button>
            <button type="button" data-testid="whiteboard-back" disabled={!ids.length} onClick={() => arrange({ type: "order", ids, to: "back" })} title={t("whiteboard.back")} aria-label={t("whiteboard.back")}><ArrowDownToLine size={15} aria-hidden="true" /></button>
            <button type="button" data-testid="whiteboard-delete-selection" disabled={!ids.length && !selection.edges.length} onClick={() => onDelete({ nodes: selectedNodes, edges: edges.filter((edge) => selection.edges.includes(edge.id)) })} title={t("whiteboard.delete.selection")} aria-label={t("whiteboard.delete.selection")}><Trash2 size={15} aria-hidden="true" /></button>
          </span>
          {colorTargets.length ? (
            <span className="wb-tool-group" role="group" aria-label={t("whiteboard.color")}>
              {CARD_COLORS.map((color) => (
                <button key={color} type="button" className={`wb-swatch wb-color-${color}`} data-testid={`whiteboard-color-${color}`} title={t(`whiteboard.color.${color}` as never)} aria-label={t(`whiteboard.color.${color}` as never)}
                  onClick={() => { void commit(colorTargets.map((node) => ({ type: "updateNode" as const, id: node.id, data: { color: color === "none" ? null : color } }))); }} />
              ))}
            </span>
          ) : null}
          {singleEdge ? (
            <label className="wb-tool-group wb-edge-label">
              <span className="sr-only">{t("whiteboard.edgeLabel")}</span>
              <input data-testid="whiteboard-edge-label" key={singleEdge.id} defaultValue={typeof singleEdge.label === "string" ? singleEdge.label : ""} placeholder={t("whiteboard.edgeLabel")} maxLength={200}
                onBlur={(event) => { if (event.target.value !== (typeof singleEdge.label === "string" ? singleEdge.label : "")) void commit([{ type: "updateEdge", id: singleEdge.id, label: event.target.value }]); }}
                onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
            </label>
          ) : null}
          <span className="wb-status detail-muted" data-testid="whiteboard-status" aria-live="polite">{ids.length ? t("whiteboard.selected", { count: ids.length }) : t("whiteboard.counts", { nodes: nodes.length, edges: edges.length })}</span>
        </div>
        <div className="wb-canvas" ref={wrapper} data-testid="whiteboard-canvas" data-mode={mode} onDoubleClick={onDoubleClick}>
          <ReactFlow<FlowNode, FlowEdge>
            nodes={nodes} edges={edges} nodeTypes={WHITEBOARD_NODE_TYPES}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onNodeDragStart={onNodeDragStart} onNodeDrag={onNodeDrag} onNodeDragStop={onNodeDragStop}
            onConnect={onConnect} onDelete={onDelete} onMoveEnd={onMoveEnd} onSelectionChange={onSelectionChange}
            defaultViewport={doc.board.viewport} minZoom={0.1} maxZoom={4}
            selectionOnDrag={selectMode} panOnDrag={selectMode ? [1, 2] : true} panActivationKeyCode="Space" multiSelectionKeyCode={["Shift", "Meta", "Control"]}
            deleteKeyCode={["Delete", "Backspace"]} zoomOnDoubleClick={false} connectionMode={ConnectionMode.Loose}
            onlyRenderVisibleElements={many} nodesConnectable elevateNodesOnSelect={false} proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} />
            <Controls showInteractive={false} position="bottom-right" fitViewOptions={{ padding: 0.2 }} />
          </ReactFlow>
          {!nodes.length ? <p className="wb-hint detail-muted" data-testid="whiteboard-hint">{t("whiteboard.hint")}</p> : null}
        </div>
        {picking ? <RefPicker t={t} projectId={ctx.detail.project.id} excludeId={boardId} onPick={(picked) => void addRef(picked)} onClose={() => setPicking(false)} /> : null}
      </div>
    </BoardContext.Provider>
  );
}
