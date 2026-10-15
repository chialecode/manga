import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Background, BackgroundVariant, Controls, Handle, Position, ReactFlow, ReactFlowProvider, getNodesBounds, useNodesState, useReactFlow, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { toPng, toSvg } from "html-to-image";
import { ChevronDown, ChevronUp, CornerDownRight, Download, Link2, Minus, Plus, Redo2, Trash2, Undo2, X } from "lucide-react";
import type { MindmapActionInput } from "@manga/contracts/canvas";
import { attempt } from "../../../lib/api.ts";
import type { ProjectTabContext } from "../project-page.tsx";
import { DocWorkspace, type DocKind } from "./doc-workspace.tsx";
import { RefPicker, type PickedRef } from "./ref-picker.tsx";
import { THEMES, THEME_COLORS, buildTree, descendantsOf, flowOf, indexAmong, layoutTree, neighbour, type MindTheme, type MmDoc, type MmRef, type TopicNode } from "./mindmap-model.ts";

type MapSummary = { id: string; title: string; theme: string; nodes: number; updatedAt: string };
type Action = MindmapActionInput;
type EditResult = { doc: MmDoc; created: string[] };
type ExportFormat = "png" | "svg" | "markdown" | "opml";

const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return Boolean(element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT" || element.isContentEditable));
};

const MAP_KIND: DocKind<MapSummary> = {
  prefix: "mindmap", item: "map", focusKind: "mindmap",
  commands: { list: "mindmap.list", create: "mindmap.create", rename: "mindmap.rename", delete: "mindmap.delete" },
  idField: "mapId", listField: "maps", createdField: "map",
  meta: (map, ctx) => ctx.t("mindmap.counts", { count: map.nodes }),
  defaultTitle: (n, ctx) => ctx.t("mindmap.defaultTitle", { n }),
  words: { list: "mindmap.maps", empty: "mindmap.empty", create: "mindmap.new", rename: "mindmap.rename", remove: "mindmap.delete", confirm: "mindmap.deleteConfirm" },
};

/** The mind maps of one project: the list on the left and the map on show filling the rest. */
export function MindmapTab({ ctx }: { ctx: ProjectTabContext }) {
  return (
    <DocWorkspace ctx={ctx} kind={MAP_KIND} render={(mapId, refresh) => (
      <ReactFlowProvider key={mapId}>
        <MapView ctx={ctx} mapId={mapId} onChanged={refresh} />
      </ReactFlowProvider>
    )} />
  );
}

/** What a topic may ask of its map. Stable for the life of the map: the volatile state is read through refs, so a selection does not redraw every topic. */
type TopicActions = {
  select: (id: string) => void;
  edit: (id: string) => void;
  commitText: (id: string, text: string | null) => void;
  fold: (id: string) => void;
  placeholder: string;
  foldLabel: (collapsed: boolean) => string;
  refsLabel: string;
};
const TopicContext = createContext<TopicActions | null>(null);

function TopicView({ id, data, selected }: NodeProps<TopicNode>) {
  const actions = useContext(TopicContext)!;
  const { node } = data;
  const editing = Boolean((data as { editing?: boolean }).editing);
  const [value, setValue] = useState(node.text);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) { setValue(node.text); requestAnimationFrame(() => { area.current?.focus(); area.current?.select(); }); } }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const done = (save: boolean) => actions.commitText(id, save ? value : null);
  return (
    <div className={`mm-topic mm-b${data.branch % 6}${data.depth === 0 ? " is-root" : ""}${selected ? " is-selected" : ""}`} data-testid={`mm-node-${id}`} data-depth={data.depth} data-collapsed={node.collapsed ? "true" : "false"}
      onClick={() => actions.select(id)} onDoubleClick={() => actions.edit(id)}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      {editing ? (
        <textarea ref={area} className="mm-edit nodrag nowheel" data-testid={`mm-edit-${id}`} value={value} rows={1} aria-label={actions.placeholder} onChange={(event) => setValue(event.target.value)} onBlur={() => done(true)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); done(true); } else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); done(false); } else if (event.key === "Tab") { event.stopPropagation(); } }} />
      ) : (
        <span className="mm-text" title={node.text}>{node.text || actions.placeholder}</span>
      )}
      {node.refs.length ? <span className="mm-refcount" title={actions.refsLabel} data-testid={`mm-refs-${id}`}><Link2 size={11} aria-hidden="true" />{node.refs.length}</span> : null}
      {data.hasChildren ? (
        <button type="button" className="mm-fold nodrag" data-testid={`mm-fold-${id}`} aria-expanded={!node.collapsed} aria-label={actions.foldLabel(node.collapsed)} title={actions.foldLabel(node.collapsed)} onClick={(event) => { event.stopPropagation(); actions.fold(id); }}>
          {node.collapsed ? <span>{data.hiddenCount}</span> : <Minus size={11} aria-hidden="true" />}
        </button>
      ) : null}
    </div>
  );
}
const NODE_TYPES = { topic: memo(TopicView) };

function MapView({ ctx, mapId, onChanged }: { ctx: ProjectTabContext; mapId: string; onChanged: () => void }) {
  const { t } = ctx;
  const flow = useReactFlow();
  const [doc, setDoc] = useState<MmDoc | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [menu, setMenu] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pending = useRef(0);
  const docRef = useRef<MmDoc | null>(null);
  const selectedRef = useRef<string | null>(null);
  const onError = useRef(ctx.onError);
  onError.current = ctx.onError;
  docRef.current = doc;
  selectedRef.current = selectedId;

  const tree = useMemo(() => buildTree(doc?.nodes ?? []), [doc?.nodes]);
  const placed = useMemo(() => layoutTree(tree), [tree]);
  const theme = (THEMES as readonly string[]).includes(doc?.map.theme ?? "") ? (doc!.map.theme as MindTheme) : "pink";
  const base = useMemo(() => flowOf(tree, placed, theme), [tree, placed, theme]);
  const [nodes, setNodes, onNodesChange] = useNodesState<TopicNode>([]);

  // The nodes on show are the layout, with the selection and the editor marked. Nodes that did not change keep their object.
  useEffect(() => {
    setNodes(base.nodes.map((node) => {
      const isSelected = node.id === selectedId;
      const isEditing = node.id === editId;
      return isSelected || isEditing ? { ...node, selected: isSelected, data: { ...node.data, editing: isEditing } as TopicNode["data"] } : node;
    }));
  }, [base, selectedId, editId, setNodes]);

  const load = useCallback(async () => {
    const result = await attempt<MmDoc>("mindmap.get", { mapId });
    if (!result.ok) { onError.current(result.error.message); return; }
    setDoc(result.value);
    setSelectedId((current) => (current && result.value.nodes.some((node) => node.id === current) ? current : result.value.nodes.find((node) => node.parentId === null)?.id ?? null));
  }, [mapId]);
  useEffect(() => { void load(); }, [load]);

  /** One edit at a time, in order. While more are waiting, an answer is not drawn: the last one carries the final state, so a quick run of edits does not flicker. */
  const commit = useCallback((actions: Action[], label?: string): Promise<EditResult | null> => {
    pending.current += 1;
    const run = async (): Promise<EditResult | null> => {
      try {
        const result = await attempt<EditResult>("mindmap.edit", { mapId, actions, ...(label ? { label } : {}) });
        if (!result.ok) { onError.current(result.error.code === "VALIDATION_ERROR" && (result.error.details as { reason?: string } | undefined)?.reason === "descendant" ? t("mindmap.cannotMove") : result.error.message); await load(); return null; }
        if (pending.current <= 1) setDoc(result.value.doc);
        onChanged();
        return result.value;
      } finally { pending.current -= 1; }
    };
    const next = queue.current.then(run, run);
    queue.current = next.catch(() => undefined);
    return next;
  }, [mapId, load, onChanged, t]);

  const step = useCallback(async (direction: "undo" | "redo") => {
    pending.current += 1;
    const run = async () => {
      try {
        const result = await attempt<{ doc: MmDoc }>(`mindmap.${direction}`, { mapId });
        if (!result.ok) { if (result.error.code !== "NOT_FOUND") onError.current(result.error.message); await load(); return; }
        setDoc(result.value.doc);
        setSelectedId((current) => (current && result.value.doc.nodes.some((node) => node.id === current) ? current : result.value.doc.nodes.find((node) => node.parentId === null)?.id ?? null));
        onChanged();
      } finally { pending.current -= 1; }
    };
    const next = queue.current.then(run, run);
    queue.current = next.catch(() => undefined);
    await next;
  }, [mapId, load, onChanged]);

  const reveal = useCallback((id: string) => {
    const spot = placed.find((item) => item.id === id);
    const rect = wrapper.current?.getBoundingClientRect();
    if (!spot || !rect) return;
    const screen = flow.flowToScreenPosition({ x: spot.x, y: spot.y });
    const right = flow.flowToScreenPosition({ x: spot.x + spot.w, y: spot.y + spot.h });
    if (screen.x < rect.left + 20 || right.x > rect.right - 20 || screen.y < rect.top + 20 || right.y > rect.bottom - 20) void flow.setCenter(spot.x + spot.w / 2, spot.y + spot.h / 2, { zoom: flow.getZoom(), duration: 160 });
  }, [flow, placed]);

  const select = useCallback((id: string) => { setSelectedId(id); }, []);

  const addChild = useCallback(async (parentId: string) => {
    const result = await commit([{ type: "addChild", parentId, text: t("mindmap.defaultNode") }]);
    const id = result?.created[0];
    if (id) { setSelectedId(id); setEditId(id); }
  }, [commit, t]);

  const addSibling = useCallback(async (nodeId: string, before = false) => {
    const node = docRef.current?.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    if (node.parentId === null) { await addChild(nodeId); return; }
    const result = await commit([{ type: "addSibling", nodeId, before, text: t("mindmap.defaultNode") }]);
    const id = result?.created[0];
    if (id) { setSelectedId(id); setEditId(id); }
  }, [commit, addChild, t]);

  const remove = useCallback(async (nodeId: string) => {
    const node = docRef.current?.nodes.find((item) => item.id === nodeId);
    if (!node || node.parentId === null) return;
    setSelectedId(node.parentId);
    await commit([{ type: "delete", nodeId }]);
  }, [commit]);

  const fold = useCallback((id: string) => {
    const current = docRef.current;
    const node = current?.nodes.find((item) => item.id === id);
    if (!current || !node) return;
    const next = !node.collapsed;
    // The map folds at once on screen; the saved state follows.
    setDoc({ ...current, nodes: current.nodes.map((item) => (item.id === id ? { ...item, collapsed: next } : item)) });
    void commit([{ type: "collapse", nodeId: id, collapsed: next }]);
  }, [commit]);

  const commitText = useCallback((id: string, text: string | null) => {
    setEditId(null);
    const node = docRef.current?.nodes.find((item) => item.id === id);
    if (text !== null && node && text.trim() !== node.text) void commit([{ type: "setText", nodeId: id, text: text.trim() }]);
    requestAnimationFrame(() => wrapper.current?.focus());
  }, [commit]);

  const topicActions = useMemo<TopicActions>(() => ({
    select, edit: setEditId, commitText, fold, placeholder: t("mindmap.nodeText"),
    foldLabel: (collapsed) => (collapsed ? t("mindmap.expand") : t("mindmap.collapse")), refsLabel: t("mindmap.refs"),
  }), [select, commitText, fold, t]);

  // ---- drag to move or reorder ----

  const onNodeDragStop = useCallback((_: unknown, dragged: TopicNode) => {
    const current = docRef.current;
    if (!current) return;
    const node = tree.byId.get(dragged.id);
    if (!node || !node.parentId) return;
    const below = descendantsOf(tree, node.id);
    const hit = flow.getIntersectingNodes(dragged, true).find((other) => other.id !== node.id);
    const reset = () => setNodes(base.nodes.map((item) => (item.id === selectedRef.current ? { ...item, selected: true } : item)));
    if (hit && hit.id !== node.parentId) {
      if (below.has(hit.id)) { ctx.onError(t("mindmap.cannotMove")); reset(); return; }
      void commit([{ type: "move", nodeId: node.id, parentId: hit.id }]);
      return;
    }
    const siblings = (tree.children.get(node.parentId) ?? []).map((item) => ({ id: item.id, y: placed.find((spot) => spot.id === item.id)?.y ?? 0 }));
    const index = indexAmong(siblings, node.id, dragged.position.y);
    const at = siblings.findIndex((item) => item.id === node.id);
    if (index !== at) void commit([{ type: "move", nodeId: node.id, parentId: node.parentId, index }]);
    else reset();
  }, [tree, flow, base, placed, commit, ctx, setNodes, t]);

  // ---- keyboard ----

  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (isTyping(event.target) || editId) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    const id = selectedRef.current;
    if (mod && key.toLowerCase() === "z") { event.preventDefault(); void step(event.shiftKey ? "redo" : "undo"); return; }
    if (mod && key.toLowerCase() === "y") { event.preventDefault(); void step("redo"); return; }
    if (!id) return;
    if (key === "Tab") { event.preventDefault(); void addChild(id); }
    else if (key === "Enter") { event.preventDefault(); void addSibling(id, event.shiftKey); }
    else if (key === "Delete" || key === "Backspace") { event.preventDefault(); void remove(id); }
    else if (key === " ") { event.preventDefault(); fold(id); }
    else if (key === "F2") { event.preventDefault(); setEditId(id); }
    else if (event.altKey && (key === "ArrowUp" || key === "ArrowDown")) { event.preventDefault(); void commit([{ type: "shift", nodeId: id, direction: key === "ArrowUp" ? "up" : "down" }]); }
    else if (key === "ArrowLeft" || key === "ArrowRight" || key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault();
      const next = neighbour(tree, id, key);
      if (next) { setSelectedId(next); reveal(next); }
    }
  }, [editId, step, addChild, addSibling, remove, fold, commit, tree, reveal]);

  // ---- references, theme, export ----

  const addRef = useCallback(async (picked: PickedRef) => {
    setPicking(false);
    const id = selectedRef.current;
    if (!id) return;
    await commit([{ type: "addRef", nodeId: id, kind: picked.kind as never, targetId: picked.id, label: picked.label }]);
  }, [commit]);

  async function setTheme(next: string) {
    const result = await attempt("mindmap.setTheme", { mapId, theme: next });
    if (!result.ok) { onError.current(result.error.message); return; }
    await load();
    onChanged();
  }

  async function draw(format: "png" | "svg"): Promise<string> {
    const element = wrapper.current?.querySelector<HTMLElement>(".react-flow__viewport");
    if (!element) throw new Error("the map is not on screen");
    const bounds = getNodesBounds(flow.getNodes());
    const pad = 40;
    const width = Math.ceil(bounds.width + pad * 2);
    const height = Math.ceil(bounds.height + pad * 2);
    const options = {
      backgroundColor: THEME_COLORS[theme].surface, width, height, pixelRatio: Math.min(1.5, 8000 / Math.max(width, height)),
      style: { width: `${width}px`, height: `${height}px`, transform: `translate(${pad - bounds.x}px, ${pad - bounds.y}px) scale(1)` },
    };
    if (format === "png") return (await toPng(element, options)).split(",")[1] ?? "";
    const url = await toSvg(element, options);
    return decodeURIComponent(url.slice(url.indexOf(",") + 1));
  }

  async function exportAs(format: ExportFormat) {
    setMenu(false);
    if (!window.manga.pick) return;
    const folder = await window.manga.pick({ mode: "directory" });
    if (!folder) return;
    setExporting(true);
    try {
      const data = format === "png" || format === "svg" ? await draw(format) : undefined;
      const result = await attempt<{ fileName: string }>("mindmap.export", { mapId, format, pathHandle: folder.pathHandle, ...(data ? { data } : {}) });
      if (result.ok) ctx.onNotice(t("mindmap.exported", { name: result.value.fileName }));
      else onError.current(t("mindmap.exportFailed", { reason: result.error.message }));
    } catch (error) {
      onError.current(t("mindmap.exportFailed", { reason: error instanceof Error ? error.message : String(error) }));
    } finally { setExporting(false); }
  }

  if (!doc) return <div className="wb-canvas" aria-busy="true" />;
  const selected = selectedId ? tree.byId.get(selectedId) : undefined;
  const hasChildren = Boolean(selected && (tree.children.get(selected.id) ?? []).length);
  const isRoot = Boolean(selected && selected.parentId === null);
  const opLabel = (label: string | null) => (label ? t(`mindmap.op.${label}` as never) : "");
  const colors = THEME_COLORS[theme];
  const themeStyle = Object.fromEntries([["--mm-root", colors.root], ["--mm-surface", colors.surface], ...colors.branches.map((color, index) => [`--mm-b${index}`, color])]) as React.CSSProperties;

  return (
    <TopicContext.Provider value={topicActions}>
      <div className="wb-board mm-board" data-testid="mindmap-board" data-map={mapId} data-nodes={doc.nodes.length} data-theme={theme} onKeyDown={onKeyDown}>
        <div className="wb-toolbar" role="toolbar" aria-label={t("mindmap.toolbar")} data-testid="mindmap-toolbar">
          <span className="wb-tool-group">
            <button type="button" data-testid="mindmap-add-child" disabled={!selected} onClick={() => selected && void addChild(selected.id)} title="Tab"><Plus size={15} aria-hidden="true" /> {t("mindmap.addChild")}</button>
            <button type="button" data-testid="mindmap-add-sibling" disabled={!selected} onClick={() => selected && void addSibling(selected.id)} title="Enter"><CornerDownRight size={15} aria-hidden="true" /> {t("mindmap.addSibling")}</button>
            <button type="button" data-testid="mindmap-delete-node" disabled={!selected || isRoot} onClick={() => selected && void remove(selected.id)} title="Delete" aria-label={t("mindmap.delete.node")}><Trash2 size={15} aria-hidden="true" /></button>
          </span>
          <span className="wb-tool-group">
            <button type="button" data-testid="mindmap-fold" disabled={!hasChildren} onClick={() => selected && fold(selected.id)} title="Space">{selected?.collapsed ? t("mindmap.expand") : t("mindmap.collapse")}</button>
            <button type="button" data-testid="mindmap-up" disabled={!selected || isRoot} onClick={() => selected && void commit([{ type: "shift", nodeId: selected.id, direction: "up" }])} title={`Alt+↑ ${t("mindmap.moveUp")}`} aria-label={t("mindmap.moveUp")}><ChevronUp size={15} aria-hidden="true" /></button>
            <button type="button" data-testid="mindmap-down" disabled={!selected || isRoot} onClick={() => selected && void commit([{ type: "shift", nodeId: selected.id, direction: "down" }])} title={`Alt+↓ ${t("mindmap.moveDown")}`} aria-label={t("mindmap.moveDown")}><ChevronDown size={15} aria-hidden="true" /></button>
            <button type="button" data-testid="mindmap-add-ref" disabled={!selected} onClick={() => setPicking(true)}><Link2 size={15} aria-hidden="true" /> {t("mindmap.addRef")}</button>
          </span>
          <span className="wb-tool-group">
            <button type="button" data-testid="mindmap-undo" disabled={!doc.ops.canUndo} onClick={() => void step("undo")} title={doc.ops.undoLabel ? `${t("mindmap.undo")}：${opLabel(doc.ops.undoLabel)}` : t("mindmap.undo")} aria-label={t("mindmap.undo")}><Undo2 size={15} aria-hidden="true" /></button>
            <button type="button" data-testid="mindmap-redo" disabled={!doc.ops.canRedo} onClick={() => void step("redo")} title={doc.ops.redoLabel ? `${t("mindmap.redo")}：${opLabel(doc.ops.redoLabel)}` : t("mindmap.redo")} aria-label={t("mindmap.redo")}><Redo2 size={15} aria-hidden="true" /></button>
          </span>
          <span className="wb-tool-group">
            <label className="mm-theme"><span>{t("mindmap.theme")}</span>
              <select data-testid="mindmap-theme" value={theme} onChange={(event) => void setTheme(event.target.value)}>
                {THEMES.map((item) => <option key={item} value={item}>{t(`mindmap.theme.${item}` as never)}</option>)}
              </select>
            </label>
          </span>
          <span className="wb-tool-group mm-export">
            <button type="button" data-testid="mindmap-export" aria-haspopup="menu" aria-expanded={menu} disabled={exporting} onClick={() => setMenu((open) => !open)}><Download size={15} aria-hidden="true" /> {t("mindmap.export")}</button>
            {menu ? (
              <div className="mm-menu" role="menu" data-testid="mindmap-export-menu">
                {(["png", "svg", "markdown", "opml"] as const).map((format) => <button key={format} type="button" role="menuitem" data-testid={`mindmap-export-${format}`} onClick={() => void exportAs(format)}>{t(`mindmap.export.${format}` as never)}</button>)}
              </div>
            ) : null}
          </span>
          <span className="wb-status detail-muted" data-testid="mindmap-status" aria-live="polite">{t("mindmap.counts", { count: doc.nodes.length })}</span>
        </div>
        <div className="wb-canvas mm-canvas" ref={wrapper} tabIndex={0} data-testid="mindmap-canvas" style={themeStyle}>
          <ReactFlow<TopicNode>
            nodes={nodes} edges={base.edges} nodeTypes={NODE_TYPES} onNodesChange={onNodesChange} onNodeDragStop={onNodeDragStop}
            fitView fitViewOptions={{ padding: 0.2, maxZoom: 1.2 }} minZoom={0.1} maxZoom={3} nodesConnectable={false} elementsSelectable={false} selectNodesOnDrag={false}
            deleteKeyCode={null} zoomOnDoubleClick={false} panOnScroll={false} proOptions={{ hideAttribution: true }} onPaneClick={() => { wrapper.current?.focus(); }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
            <Controls showInteractive={false} position="bottom-right" />
          </ReactFlow>
        </div>
        {selected ? <Inspector t={t} refs={selected.refs} onOpen={(ref) => ctx.onOpenMaterial({ kind: ref.kind as never, targetId: ref.targetId, label: ref.label, ...(ref.opens ? { opens: ref.opens } : {}) })} onRemove={(ref) => void commit([{ type: "removeRef", nodeId: selected.id, refId: ref.id }])} /> : null}
        <p className="detail-muted mm-hint" data-testid="mindmap-hint">{t("mindmap.hint")}</p>
        {picking ? <RefPicker t={t} projectId={ctx.detail.project.id} excludeId={mapId} onPick={(picked) => void addRef(picked)} onClose={() => setPicking(false)} /> : null}
      </div>
    </TopicContext.Provider>
  );
}

/** The references of the selected topic: what each points at and whether it is still there. They are attachments to the topic, never children of it. */
function Inspector(props: { t: ProjectTabContext["t"]; refs: MmRef[]; onOpen: (ref: MmRef) => void; onRemove: (ref: MmRef) => void }) {
  const { t } = props;
  return (
    <div className="mm-inspector" data-testid="mindmap-inspector">
      <strong>{t("mindmap.refs")}</strong>
      {!props.refs.length ? <span className="detail-muted">{t("mindmap.refs.empty")}</span> : null}
      <ul>
        {props.refs.map((ref) => (
          <li key={ref.id} className={ref.state === "ok" ? "" : "is-gone"} data-testid={`mm-ref-${ref.id}`} data-state={ref.state}>
            <span className="chip">{t(`whiteboard.ref.kind.${ref.kind}` as never)}</span>
            {ref.state === "ok" ? <button type="button" className="link-button" data-testid={`mm-ref-open-${ref.id}`} onClick={() => props.onOpen(ref)}>{ref.label || t("embed.untitled")}</button> : <span className="mm-ref-gone">{ref.label || t("embed.untitled")} · {t(`whiteboard.ref.state.${ref.state}` as never)}</span>}
            {ref.mode === "snapshot" ? <span className="chip">{t("whiteboard.ref.snapshotTag")}</span> : null}
            {ref.summary ? <small className="detail-muted">{ref.summary}</small> : null}
            <button type="button" className="icon-button" data-testid={`mm-ref-remove-${ref.id}`} aria-label={t("mindmap.ref.remove")} title={t("mindmap.ref.remove")} onClick={() => props.onRemove(ref)}><X size={13} /></button>
          </li>
        ))}
      </ul>
    </div>
  );
}
