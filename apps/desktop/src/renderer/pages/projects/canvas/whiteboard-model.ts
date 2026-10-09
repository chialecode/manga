import type { Edge, Node } from "@xyflow/react";

export type WbKind = "text" | "card" | "ref" | "group";
export type WbNode = { id: string; kind: WbKind; x: number; y: number; w: number; h: number; z: number; parentId: string | null; data: Record<string, unknown> };
export type WbEdge = { id: string; sourceId: string; targetId: string; label: string };
export type WbRef = { state: "ok" | "missing" | "disabled" | "denied" | "cycle"; label: string; summary: string; mode: "live" | "snapshot"; opens?: { resourceId: string; mediaKind: string; workId: string | null } };
export type WbOps = { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null };
export type WbDelta = { nodes: WbNode[]; removedNodes: string[]; edges: WbEdge[]; removedEdges: string[]; refs: Record<string, WbRef>; ops: WbOps };
export type WbDoc = {
  board: { id: string; projectId: string | null; title: string; viewport: { x: number; y: number; zoom: number } };
  nodes: WbNode[]; edges: WbEdge[]; refs: Record<string, WbRef>; ops: WbOps;
};

export type FlowData = { node: WbNode; ref?: WbRef };
export type FlowNode = Node<FlowData>;
export type FlowEdge = Edge;

export const CARD_COLORS = ["none", "pink", "blue", "green", "yellow"] as const;
export type CardColor = (typeof CARD_COLORS)[number];

export const NO_OPS: WbOps = { canUndo: false, canRedo: false, undoLabel: null, redoLabel: null };

/** A flow node keeps what React Flow needs (position, fixed size, layer) and carries the stored node as data, so a change from the main process replaces only what changed. */
export function toFlowNode(node: WbNode, ref: WbRef | undefined, previous?: FlowNode): FlowNode {
  return {
    id: node.id, type: node.kind, position: { x: node.x, y: node.y }, width: node.w, height: node.h, zIndex: node.z,
    ...(previous?.selected ? { selected: true } : {}),
    data: { node, ...(ref ? { ref } : {}) },
  };
}

export const toFlowEdge = (edge: WbEdge): FlowEdge => ({ id: edge.id, source: edge.sourceId, target: edge.targetId, ...(edge.label ? { label: edge.label } : {}) });

export function flowNodesOf(doc: Pick<WbDoc, "nodes" | "refs">): FlowNode[] {
  return doc.nodes.map((node) => toFlowNode(node, doc.refs[node.id]));
}

/** Folds a change from the main process into the nodes on show. Nodes the change does not mention keep their object, so they are not drawn again. */
export function mergeNodes(current: FlowNode[], delta: Pick<WbDelta, "nodes" | "removedNodes" | "refs">): FlowNode[] {
  if (!delta.nodes.length && !delta.removedNodes.length) return current;
  const removed = new Set(delta.removedNodes);
  const changed = new Map(delta.nodes.map((node) => [node.id, node]));
  const out: FlowNode[] = [];
  for (const node of current) {
    if (removed.has(node.id)) continue;
    const next = changed.get(node.id);
    if (!next) { out.push(node); continue; }
    changed.delete(node.id);
    out.push(toFlowNode(next, delta.refs[next.id], node));
  }
  for (const next of changed.values()) out.push(toFlowNode(next, delta.refs[next.id]));
  return out;
}

export function mergeEdges(current: FlowEdge[], delta: Pick<WbDelta, "edges" | "removedEdges" | "removedNodes">): FlowEdge[] {
  if (!delta.edges.length && !delta.removedEdges.length) return current;
  const removed = new Set(delta.removedEdges);
  const changed = new Map(delta.edges.map((edge) => [edge.id, edge]));
  const out: FlowEdge[] = [];
  for (const edge of current) {
    if (removed.has(edge.id)) continue;
    const next = changed.get(edge.id);
    if (!next) { out.push(edge); continue; }
    changed.delete(edge.id);
    out.push({ ...toFlowEdge(next), ...(edge.selected ? { selected: true } : {}) });
  }
  for (const next of changed.values()) out.push(toFlowEdge(next));
  return out;
}

const centerOf = (node: FlowNode) => ({ x: node.position.x + (node.width ?? node.data.node.w) / 2, y: node.position.y + (node.height ?? node.data.node.h) / 2 });

/** The group a card was dropped into: the topmost group whose frame holds the centre of the card, or `null` when it was dropped on the open board. */
export function groupAt(nodes: FlowNode[], moved: FlowNode): string | null {
  const point = centerOf(moved);
  let best: FlowNode | null = null;
  for (const node of nodes) {
    if (node.type !== "group" || node.id === moved.id) continue;
    const width = node.width ?? node.data.node.w;
    const height = node.height ?? node.data.node.h;
    if (point.x < node.position.x || point.x > node.position.x + width || point.y < node.position.y || point.y > node.position.y + height) continue;
    if (!best || (node.zIndex ?? 0) > (best.zIndex ?? 0)) best = node;
  }
  return best?.id ?? null;
}

export const round = (value: number) => Math.round(value * 100) / 100;

/** The label of a stored step for the undo button: the step's own name from the message catalog, or the raw name when it has none. */
export const opLabelKey = (label: string | null) => (label ? `whiteboard.op.${label}` : "");
