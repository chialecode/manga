import { hierarchy, tree as treeLayout } from "d3-hierarchy";
import type { Edge, Node } from "@xyflow/react";
import type { WbOps } from "./whiteboard-model.ts";

export type MmRef = { id: string; kind: string; targetId: string; locator?: { blockId?: string; nodeId?: string }; label: string; mode?: "live" | "snapshot"; state: "ok" | "missing" | "disabled" | "denied" | "cycle"; summary: string; opens?: { resourceId: string; mediaKind: string; workId: string | null } };
export type MmNode = { id: string; parentId: string | null; sortKey: string; text: string; collapsed: boolean; refs: MmRef[] };
export type MmDoc = { map: { id: string; projectId: string | null; title: string; theme: string; createdAt: string; updatedAt: string }; nodes: MmNode[]; ops: WbOps };

export type TopicData = { node: MmNode; depth: number; branch: number; hasChildren: boolean; hiddenCount: number };
export type TopicNode = Node<TopicData, "topic">;
export type MindEdge = Edge;

export const THEMES = ["pink", "blue", "green", "mono"] as const;
export type MindTheme = (typeof THEMES)[number];

/** Branch colours per theme: the central topic takes the first, each branch of it the next in turn. */
export const THEME_COLORS: Record<MindTheme, { root: string; branches: string[]; surface: string }> = {
  pink: { root: "#AD3268", branches: ["#DE6C9B", "#4F8FD0", "#3CA064", "#D69E00", "#8B5CF6", "#E0743E"], surface: "#FFF7FA" },
  blue: { root: "#245C9C", branches: ["#4F8FD0", "#2FA3A3", "#6C7BD9", "#3C8DBC", "#5FA8E0", "#7B8DB0"], surface: "#F5F9FE" },
  green: { root: "#2F7D4F", branches: ["#3CA064", "#7DB955", "#2FA3A3", "#B8A23A", "#5C9E7B", "#8DB36A"], surface: "#F5FBF7" },
  mono: { root: "#303647", branches: ["#5A6376", "#7A8396", "#98A1B3", "#687184", "#4B5568", "#8A93A5"], surface: "#FFFFFF" },
};

const ROW_HEIGHT = 56;
const NODE_HEIGHT = 40;
const COLUMN_GAP = 56;
const MIN_WIDTH = 96;
const MAX_WIDTH = 260;

export type Tree = { byId: Map<string, MmNode>; children: Map<string | null, MmNode[]>; root: MmNode | null };

export function buildTree(nodes: MmNode[]): Tree {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string | null, MmNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : a.id < b.id ? -1 : 1));
  return { byId, children, root: children.get(null)?.[0] ?? null };
}

/** The width a topic needs for its text: wide characters count double, the width is bounded and longer text wraps inside it. */
export function widthOf(text: string): number {
  let units = 0;
  for (const char of text) units += char.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, units * 7.4 + 36));
}

export function descendantsOf(tree: Tree, id: string): Set<string> {
  const found = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const next = stack.pop()!;
    for (const child of tree.children.get(next) ?? []) { found.add(child.id); stack.push(child.id); }
  }
  return found;
}

/** The topics in the order a person reads them down the page, skipping what is folded away. Arrow keys walk this list. */
export function visibleOrder(tree: Tree): string[] {
  const out: string[] = [];
  const walk = (node: MmNode) => { out.push(node.id); if (!node.collapsed) for (const child of tree.children.get(node.id) ?? []) walk(child); };
  if (tree.root) walk(tree.root);
  return out;
}

export type Placed = { id: string; x: number; y: number; w: number; h: number; depth: number; branch: number };

/**
 * Lays the visible tree out left to right: the tree layout gives each topic its row (children centred on their parent), each depth is a column
 * as wide as its widest topic. Folded topics keep their subtree out of the layout, so a large map shows only what is open.
 */
export function layoutTree(tree: Tree): Placed[] {
  if (!tree.root) return [];
  type Item = { node: MmNode; kids: Item[]; branch: number };
  const make = (node: MmNode, branch: number): Item => ({ node, branch, kids: node.collapsed ? [] : (tree.children.get(node.id) ?? []).map((child, index) => make(child, node.parentId === null ? index : branch)) });
  const top = make(tree.root, 0);
  const laid = treeLayout<Item>().nodeSize([ROW_HEIGHT, 1]).separation(() => 1)(hierarchy(top, (item) => item.kids));
  const widths: number[] = [];
  laid.each((item) => { widths[item.depth] = Math.max(widths[item.depth] ?? MIN_WIDTH, widthOf(item.data.node.text)); });
  const starts: number[] = [];
  let cursor = 0;
  widths.forEach((width, depth) => { starts[depth] = cursor; cursor += width + COLUMN_GAP; });
  const placed: Placed[] = [];
  laid.each((item) => placed.push({ id: item.data.node.id, x: starts[item.depth]!, y: item.x - NODE_HEIGHT / 2, w: widths[item.depth]!, h: NODE_HEIGHT, depth: item.depth, branch: item.data.branch }));
  return placed;
}

export const countBelow = (tree: Tree, id: string): number => descendantsOf(tree, id).size;

export function flowOf(tree: Tree, placed: Placed[], theme: MindTheme): { nodes: TopicNode[]; edges: MindEdge[] } {
  const colors = THEME_COLORS[theme] ?? THEME_COLORS.pink;
  const nodes: TopicNode[] = placed.map((spot) => {
    const node = tree.byId.get(spot.id)!;
    const kids = tree.children.get(node.id) ?? [];
    return {
      id: node.id, type: "topic", position: { x: spot.x, y: spot.y }, width: spot.w, height: spot.h, draggable: node.parentId !== null,
      data: { node, depth: spot.depth, branch: spot.branch, hasChildren: kids.length > 0, hiddenCount: node.collapsed ? countBelow(tree, node.id) : 0 },
    };
  });
  const edges: MindEdge[] = [];
  for (const spot of placed) {
    const node = tree.byId.get(spot.id)!;
    if (!node.parentId) continue;
    edges.push({ id: `e-${node.id}`, source: node.parentId, target: node.id, type: "default", style: { stroke: colors.branches[spot.branch % colors.branches.length], strokeWidth: spot.depth === 1 ? 2.4 : 1.6 }, selectable: false, focusable: false });
  }
  return { nodes, edges };
}

export type Move = { key: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" };

/** Where an arrow key leads from a topic: left to its parent, right to its first child, up and down to the previous or next topic on show. */
export function neighbour(tree: Tree, fromId: string, key: Move["key"]): string | null {
  const node = tree.byId.get(fromId);
  if (!node) return null;
  if (key === "ArrowLeft") return node.parentId;
  if (key === "ArrowRight") return node.collapsed ? null : (tree.children.get(node.id) ?? [])[0]?.id ?? null;
  // Up and down walk the topics on show, in reading order, to the next one at the same depth: that crosses from one branch to the next.
  const depthOf = (id: string) => { let depth = 0; for (let cursor = tree.byId.get(id); cursor?.parentId; cursor = tree.byId.get(cursor.parentId)) depth += 1; return depth; };
  const order = visibleOrder(tree);
  const here = order.indexOf(node.id);
  const mine = depthOf(node.id);
  const step = key === "ArrowDown" ? 1 : -1;
  for (let i = here + step; i >= 0 && i < order.length; i += step) if (depthOf(order[i]!) === mine) return order[i]!;
  return null;
}

/** The index at which a dragged topic lands among its siblings when it is dropped at height `y`, judged by the middle of each sibling. */
export function indexAmong(siblings: Array<{ id: string; y: number }>, movedId: string, y: number): number {
  const others = siblings.filter((item) => item.id !== movedId);
  let index = 0;
  for (const item of others) if (y > item.y) index += 1;
  return index;
}
