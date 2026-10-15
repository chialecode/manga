import { EMBED_KINDS, MangaError, REF_KINDS, createId, type CanvasLocator, type EmbedKind, type WhiteboardActionInput } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { EmbedService, referenceInfo } from "./embeds.ts";
import { applyOps, diffRows, OpLog, type OpState, type RowOp } from "./ops.ts";

type NodeRow = {
  id: string; board_id: string; kind: string; x: number; y: number; w: number; h: number; z: number; parent_id: string | null; data_json: string; created_at: string; updated_at: string;
};
type EdgeRow = { id: string; board_id: string; source_id: string; target_id: string; label: string; created_at: string };

export type BoardNode = { id: string; kind: string; x: number; y: number; w: number; h: number; z: number; parentId: string | null; data: Record<string, unknown> };
export type BoardEdge = { id: string; sourceId: string; targetId: string; label: string };
export type BoardRef = { state: "ok" | "missing" | "disabled" | "denied" | "cycle"; label: string; summary: string; mode: "live" | "snapshot"; opens?: { resourceId: string; mediaKind: string; workId: string | null } };
export type BoardSummary = { id: string; projectId: string | null; title: string; nodes: number; edges: number; createdAt: string; updatedAt: string };
export type BoardDelta = { nodes: BoardNode[]; removedNodes: string[]; edges: BoardEdge[]; removedEdges: string[]; refs: Record<string, BoardRef>; ops: OpState };

const NODE_COLUMNS = ["id", "board_id", "kind", "x", "y", "w", "h", "z", "parent_id", "data_json", "created_at", "updated_at"] as const;
const EDGE_COLUMNS = ["id", "board_id", "source_id", "target_id", "label", "created_at"] as const;
const TABLES = { whiteboard_nodes: NODE_COLUMNS, whiteboard_edges: EDGE_COLUMNS } as const;

const MAX_NODES = 5000;
const MAX_EDGES = 10_000;
const MAX_BOARDS_PER_PROJECT = 100;
const GROUP_PAD = 24;
const GROUP_HEADER = 36;
const DEFAULT_SIZE: Record<string, { w: number; h: number }> = { text: { w: 200, h: 64 }, card: { w: 240, h: 140 }, ref: { w: 260, h: 120 }, group: { w: 400, h: 300 } };

const nodeOf = (row: NodeRow): BoardNode => ({ id: row.id, kind: row.kind, x: row.x, y: row.y, w: row.w, h: row.h, z: row.z, parentId: row.parent_id, data: JSON.parse(row.data_json) as Record<string, unknown> });
const edgeOf = (row: EdgeRow): BoardEdge => ({ id: row.id, sourceId: row.source_id, targetId: row.target_id, label: row.label });
const bad = (message: string, reason: string) => new MangaError("VALIDATION_ERROR", message, { details: { reason } });

/** The working copy of a board while one edit runs; the edit is applied to this and the difference to the stored rows becomes the change. */
class Draft {
  readonly nodes = new Map<string, NodeRow>();
  readonly edges = new Map<string, EdgeRow>();
  readonly now = new Date().toISOString();
  readonly boardId: string;

  constructor(boardId: string, nodes: NodeRow[], edges: EdgeRow[]) {
    this.boardId = boardId;
    for (const row of nodes) this.nodes.set(row.id, { ...row });
    for (const row of edges) this.edges.set(row.id, { ...row });
  }

  node(id: string): NodeRow {
    const found = this.nodes.get(id);
    if (!found) throw new MangaError("NOT_FOUND", "a card on the board does not exist");
    return found;
  }

  members(groupId: string): NodeRow[] {
    return [...this.nodes.values()].filter((row) => row.parent_id === groupId);
  }

  /** Moves a node, and the members of a group with it. */
  shift(row: NodeRow, dx: number, dy: number): void {
    if (!dx && !dy) return;
    row.x += dx; row.y += dy; row.updated_at = this.now;
    if (row.kind === "group") for (const member of this.members(row.id)) this.shift(member, dx, dy);
  }

  /** The nodes of the list that are not already carried by a group of the list, in a stable order. */
  lead(ids: string[]): NodeRow[] {
    const picked = new Set(ids);
    return ids.filter((id, index) => ids.indexOf(id) === index).map((id) => this.node(id)).filter((row) => !(row.parent_id && picked.has(row.parent_id)));
  }

  maxZ(): number { let top = 0; for (const row of this.nodes.values()) top = Math.max(top, row.z); return top; }
  minZ(): number { let low = 0; for (const row of this.nodes.values()) low = Math.min(low, row.z); return low; }
}

/**
 * Whiteboards (CRE-02). A board is cards, free text, references to personal material (a reference instance points at the original and never
 * copies it) and groups, with edges between them. Every edit is a list of steps applied to a working copy; the difference to the stored rows is
 * saved as one change and recorded with its inverse, so undo and redo survive a restart and one call is one step of undo.
 */
export class WhiteboardService {
  private readonly store: DrizzleStore;
  private readonly ops: OpLog;
  private readonly embeds: EmbedService;
  private readonly featureOn: (featureId: string) => boolean;

  constructor(store: DrizzleStore, ops: OpLog, embeds: EmbedService, featureOn: (featureId: string) => boolean = () => true) {
    this.store = store;
    this.ops = ops;
    this.embeds = embeds;
    this.featureOn = featureOn;
  }

  exists(boardId: string): boolean {
    return Boolean(this.store.sqlite.prepare("SELECT 1 FROM whiteboards WHERE id = ?").get(boardId));
  }

  private board(boardId: string): { id: string; project_id: string | null; title: string; viewport_json: string; created_at: string; updated_at: string } {
    const row = this.store.sqlite.prepare("SELECT * FROM whiteboards WHERE id = ?").get(boardId) as { id: string; project_id: string | null; title: string; viewport_json: string; created_at: string; updated_at: string } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the whiteboard does not exist");
    return row;
  }

  private summary(row: { id: string; project_id: string | null; title: string; created_at: string; updated_at: string }): BoardSummary {
    const count = (table: string) => (this.store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE board_id = ?`).get(row.id) as { n: number }).n;
    return { id: row.id, projectId: row.project_id, title: row.title, nodes: count("whiteboard_nodes"), edges: count("whiteboard_edges"), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  list(projectId?: string): { boards: BoardSummary[] } {
    const rows = (projectId
      ? this.store.sqlite.prepare("SELECT * FROM whiteboards WHERE project_id = ? ORDER BY updated_at DESC, id").all(projectId)
      : this.store.sqlite.prepare("SELECT * FROM whiteboards ORDER BY updated_at DESC, id").all()) as Array<{ id: string; project_id: string | null; title: string; created_at: string; updated_at: string }>;
    return { boards: rows.map((row) => this.summary(row)) };
  }

  create(input: { projectId: string; title: string }): BoardSummary {
    if (!this.store.sqlite.prepare("SELECT 1 FROM projects WHERE id = ?").get(input.projectId)) throw new MangaError("NOT_FOUND", "the project does not exist");
    const have = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM whiteboards WHERE project_id = ?").get(input.projectId) as { n: number }).n;
    if (have >= MAX_BOARDS_PER_PROJECT) throw bad("this project already has too many whiteboards", "limit");
    const id = createId("wbd");
    const now = new Date().toISOString();
    this.store.sqlite.prepare("INSERT INTO whiteboards(id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)").run(id, input.projectId, input.title, now, now);
    this.store.sqlite.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, input.projectId);
    return this.summary(this.board(id));
  }

  rename(boardId: string, title: string): BoardSummary {
    this.board(boardId);
    this.store.sqlite.prepare("UPDATE whiteboards SET title = ?, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), boardId);
    return this.summary(this.board(boardId));
  }

  delete(boardId: string): { boardId: string; removedNodes: number } {
    this.board(boardId);
    const sqlite = this.store.sqlite;
    return sqlite.transaction(() => {
      const removedNodes = Number(sqlite.prepare("DELETE FROM whiteboard_nodes WHERE board_id = ?").run(boardId).changes);
      sqlite.prepare("DELETE FROM whiteboard_edges WHERE board_id = ?").run(boardId);
      this.ops.clear("whiteboard", boardId);
      this.embeds.dropSource("whiteboard", boardId);
      sqlite.prepare("DELETE FROM whiteboards WHERE id = ?").run(boardId);
      return { boardId, removedNodes };
    })();
  }

  private rows(boardId: string): { nodes: NodeRow[]; edges: EdgeRow[] } {
    return {
      nodes: this.store.sqlite.prepare("SELECT * FROM whiteboard_nodes WHERE board_id = ? ORDER BY z, created_at, id").all(boardId) as NodeRow[],
      edges: this.store.sqlite.prepare("SELECT * FROM whiteboard_edges WHERE board_id = ? ORDER BY created_at, id").all(boardId) as EdgeRow[],
    };
  }

  /** What a reference node shows: whether its target is still there and switched on, and a line of what it holds. */
  private refsOf(boardId: string, nodes: BoardNode[]): Record<string, BoardRef> {
    const refs: Record<string, BoardRef> = {};
    const embedded = new Map(this.embeds.list("whiteboard", boardId).map((item) => [item.slot, item]));
    for (const node of nodes) {
      if (node.kind !== "ref") continue;
      const kind = String(node.data.refKind ?? "");
      const targetId = String(node.data.targetId ?? "");
      const mode = node.data.mode === "snapshot" ? "snapshot" : "live";
      const fixed = embedded.get(node.id);
      if (fixed) {
        refs[node.id] = { state: fixed.state === "valid" ? "ok" : fixed.state === "deleted" ? "missing" : fixed.state, label: fixed.title, summary: fixed.summary, mode: fixed.mode };
        continue;
      }
      const info = referenceInfo(this.store, kind, targetId, this.featureOn);
      refs[node.id] = { state: info.state, label: info.label || String(node.data.label ?? ""), summary: "", mode, ...(info.opens ? { opens: info.opens } : {}) };
    }
    return refs;
  }

  get(boardId: string): { board: { id: string; projectId: string | null; title: string; viewport: { x: number; y: number; zoom: number }; createdAt: string; updatedAt: string }; nodes: BoardNode[]; edges: BoardEdge[]; refs: Record<string, BoardRef>; ops: OpState } {
    const row = this.board(boardId);
    const { nodes, edges } = this.rows(boardId);
    const mapped = nodes.map(nodeOf);
    return {
      board: { id: row.id, projectId: row.project_id, title: row.title, viewport: JSON.parse(row.viewport_json) as { x: number; y: number; zoom: number }, createdAt: row.created_at, updatedAt: row.updated_at },
      nodes: mapped, edges: edges.map(edgeOf), refs: this.refsOf(boardId, mapped), ops: this.ops.state("whiteboard", boardId),
    };
  }

  setViewport(boardId: string, viewport: { x: number; y: number; zoom: number }): { boardId: string } {
    this.board(boardId);
    this.store.sqlite.prepare("UPDATE whiteboards SET viewport_json = ? WHERE id = ?").run(JSON.stringify(viewport), boardId);
    return { boardId };
  }

  // ------------------------------------------------------------------ editing

  edit(input: { boardId: string; label?: string; actions: WhiteboardActionInput[] }): BoardDelta & { created: string[] } {
    const board = this.board(input.boardId);
    const sqlite = this.store.sqlite;
    return sqlite.transaction(() => {
      const before = this.rows(board.id);
      const draft = new Draft(board.id, before.nodes, before.edges);
      const created: string[] = [];
      for (const action of input.actions) this.apply(draft, action, created);
      if (draft.nodes.size > MAX_NODES) throw bad("the whiteboard has too many cards", "limit");
      if (draft.edges.size > MAX_EDGES) throw bad("the whiteboard has too many links", "limit");
      const nodeMaps = this.rowMaps(before.nodes, draft.nodes);
      const edgeMaps = this.rowMaps(before.edges, draft.edges);
      const a = diffRows("whiteboard_nodes", nodeMaps.before, nodeMaps.after);
      const b = diffRows("whiteboard_edges", edgeMaps.before, edgeMaps.after);
      // Edges go before the nodes they hang on when something is removed, and after them when something is added: both orders are stored, so redo and undo agree.
      const forward = [...b.forward.filter((op) => op.row === null), ...a.forward, ...b.forward.filter((op) => op.row !== null)];
      const inverse = [...b.inverse.filter((op) => op.row === null), ...a.inverse, ...b.inverse.filter((op) => op.row !== null)];
      if (!forward.length) return { ...this.delta([], board.id), created };
      applyOps(this.store, forward, TABLES);
      this.syncEmbeds(board.id);
      sqlite.prepare("UPDATE whiteboards SET updated_at = ? WHERE id = ?").run(draft.now, board.id);
      this.ops.record("whiteboard", board.id, input.label ?? input.actions[0]!.type, forward, inverse);
      return { ...this.delta(forward, board.id), created };
    })();
  }

  undo(boardId: string): BoardDelta & { label: string | null } {
    return this.step(boardId, "undo");
  }

  redo(boardId: string): BoardDelta & { label: string | null } {
    return this.step(boardId, "redo");
  }

  private step(boardId: string, direction: "undo" | "redo"): BoardDelta & { label: string | null } {
    this.board(boardId);
    return this.store.sqlite.transaction(() => {
      let applied: RowOp[] = [];
      const label = this.ops[direction]("whiteboard", boardId, (ops) => { applied = ops; applyOps(this.store, ops, TABLES); });
      if (label === null) throw new MangaError("NOT_FOUND", direction === "undo" ? "there is nothing to undo" : "there is nothing to redo");
      this.syncEmbeds(boardId);
      this.store.sqlite.prepare("UPDATE whiteboards SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), boardId);
      return { ...this.delta(applied, boardId), label };
    })();
  }

  private rowMaps<T extends { id: string }>(before: T[], after: Map<string, T>) {
    const b = new Map<string, Record<string, unknown> | null>();
    const a = new Map<string, Record<string, unknown> | null>();
    for (const row of before) b.set(row.id, row as unknown as Record<string, unknown>);
    for (const [id, row] of after) a.set(id, row as unknown as Record<string, unknown>);
    for (const row of before) if (!after.has(row.id)) a.set(row.id, null);
    return { before: b, after: a };
  }

  /** The nodes and edges a list of ops touched, as they are now, so a client can patch what it shows without loading the board again. */
  private delta(ops: RowOp[], boardId: string): BoardDelta {
    const nodeIds = [...new Set(ops.filter((op) => op.t === "whiteboard_nodes").map((op) => op.id))];
    const edgeIds = [...new Set(ops.filter((op) => op.t === "whiteboard_edges").map((op) => op.id))];
    const sqlite = this.store.sqlite;
    const nodes: BoardNode[] = [];
    const removedNodes: string[] = [];
    for (const id of nodeIds) {
      const row = sqlite.prepare("SELECT * FROM whiteboard_nodes WHERE id = ? AND board_id = ?").get(id, boardId) as NodeRow | undefined;
      if (row) nodes.push(nodeOf(row)); else removedNodes.push(id);
    }
    const edges: BoardEdge[] = [];
    const removedEdges: string[] = [];
    for (const id of edgeIds) {
      const row = sqlite.prepare("SELECT * FROM whiteboard_edges WHERE id = ? AND board_id = ?").get(id, boardId) as EdgeRow | undefined;
      if (row) edges.push(edgeOf(row)); else removedEdges.push(id);
    }
    return { nodes, removedNodes, edges, removedEdges, refs: this.refsOf(boardId, nodes), ops: this.ops.state("whiteboard", boardId) };
  }

  /** Reference nodes whose target can itself hold content are embeds, so the relation is kept in step with the board, and a loop is refused. */
  private syncEmbeds(boardId: string): void {
    const rows = this.store.sqlite.prepare("SELECT id, data_json AS data FROM whiteboard_nodes WHERE board_id = ? AND kind = 'ref'").all(boardId) as Array<{ id: string; data: string }>;
    const wanted = rows.flatMap((row) => {
      const data = JSON.parse(row.data) as { refKind?: string; targetId?: string; locator?: CanvasLocator; mode?: "live" | "snapshot" };
      if (!data.refKind || !data.targetId || !(EMBED_KINDS as readonly string[]).includes(data.refKind)) return [];
      return [{ slot: row.id, targetKind: data.refKind as EmbedKind, targetId: data.targetId, ...(data.locator ? { locator: data.locator } : {}), mode: data.mode === "snapshot" ? "snapshot" as const : "live" as const }];
    });
    const have = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM embeds WHERE source_kind = 'whiteboard' AND source_id = ?").get(boardId) as { n: number }).n;
    if (!wanted.length && !have) return;
    this.embeds.sync("whiteboard", boardId, wanted);
  }

  private checkRef(data: Record<string, unknown>): Record<string, unknown> {
    const kind = String(data.refKind ?? "");
    const targetId = String(data.targetId ?? "");
    if (!(REF_KINDS as readonly string[]).includes(kind) || !targetId) throw bad("a reference needs a kind and a target", "ref");
    const info = referenceInfo(this.store, kind, targetId);
    if (info.state === "missing") throw new MangaError("NOT_FOUND", "what you are pointing at does not exist");
    const clean: Record<string, unknown> = { refKind: kind, targetId };
    if (data.locator && typeof data.locator === "object") clean.locator = data.locator;
    if (data.mode === "snapshot") clean.mode = "snapshot";
    clean.label = typeof data.label === "string" && data.label ? data.label.slice(0, 200) : info.label;
    return clean;
  }

  private apply(draft: Draft, action: WhiteboardActionInput, created: string[]): void {
    const now = draft.now;
    switch (action.type) {
      case "addNode": {
        const id = action.id ?? createId("wbn");
        if (draft.nodes.has(id)) throw bad("a card with that id is already on the board", "duplicate");
        const size = DEFAULT_SIZE[action.kind] ?? DEFAULT_SIZE.card!;
        let data: Record<string, unknown> = action.data ?? {};
        if (action.kind === "ref") data = this.checkRef(data);
        if (action.parentId) {
          if (draft.node(action.parentId).kind !== "group") throw bad("a card can only be put into a group", "parent");
        }
        draft.nodes.set(id, {
          id, board_id: draft.boardId, kind: action.kind, x: action.x, y: action.y, w: action.w ?? size.w, h: action.h ?? size.h,
          z: action.kind === "group" ? draft.minZ() - 1 : draft.maxZ() + 1, parent_id: action.parentId ?? null, data_json: JSON.stringify(data), created_at: now, updated_at: now,
        });
        created.push(id);
        return;
      }
      case "moveNodes": {
        const listed = new Set(action.moves.map((move) => move.id));
        for (const move of action.moves) {
          const row = draft.node(move.id);
          // A card that moves with its group in the same step is carried by the group.
          if (row.parent_id && listed.has(row.parent_id)) continue;
          draft.shift(row, move.x - row.x, move.y - row.y);
        }
        return;
      }
      case "resizeNode": {
        const row = draft.node(action.id);
        row.w = action.w; row.h = action.h;
        if (action.x !== undefined) row.x = action.x;
        if (action.y !== undefined) row.y = action.y;
        row.updated_at = now;
        return;
      }
      case "updateNode": {
        const row = draft.node(action.id);
        const merged: Record<string, unknown> = { ...(JSON.parse(row.data_json) as Record<string, unknown>) };
        for (const [key, value] of Object.entries(action.data)) { if (value === null) delete merged[key]; else merged[key] = value; }
        row.data_json = JSON.stringify(row.kind === "ref" ? this.checkRef(merged) : merged);
        row.updated_at = now;
        return;
      }
      case "deleteNodes": {
        for (const id of new Set(action.ids)) {
          const row = draft.node(id);
          // Members of a deleted group stay on the board, outside any group.
          if (row.kind === "group") for (const member of draft.members(id)) { member.parent_id = null; member.updated_at = now; }
          draft.nodes.delete(id);
          for (const [edgeId, edge] of draft.edges) if (edge.source_id === id || edge.target_id === id) draft.edges.delete(edgeId);
        }
        return;
      }
      case "addEdge": {
        if (action.sourceId === action.targetId) throw bad("a card cannot be linked to itself", "self");
        draft.node(action.sourceId); draft.node(action.targetId);
        for (const edge of draft.edges.values()) if (edge.source_id === action.sourceId && edge.target_id === action.targetId) return;
        const id = action.id ?? createId("wbe");
        if (draft.edges.has(id)) throw bad("a link with that id is already on the board", "duplicate");
        draft.edges.set(id, { id, board_id: draft.boardId, source_id: action.sourceId, target_id: action.targetId, label: action.label ?? "", created_at: now });
        created.push(id);
        return;
      }
      case "updateEdge": {
        const edge = draft.edges.get(action.id);
        if (!edge) throw new MangaError("NOT_FOUND", "a link on the board does not exist");
        edge.label = action.label;
        return;
      }
      case "deleteEdges": {
        for (const id of action.ids) draft.edges.delete(id);
        return;
      }
      case "group": {
        const members = [...new Set(action.ids)].map((id) => draft.node(id));
        if (members.some((row) => row.kind === "group")) throw bad("a group cannot be put into a group", "nested");
        const minX = Math.min(...members.map((row) => row.x));
        const minY = Math.min(...members.map((row) => row.y));
        const maxX = Math.max(...members.map((row) => row.x + row.w));
        const maxY = Math.max(...members.map((row) => row.y + row.h));
        const id = action.groupId ?? createId("wbn");
        if (draft.nodes.has(id)) throw bad("a card with that id is already on the board", "duplicate");
        draft.nodes.set(id, {
          id, board_id: draft.boardId, kind: "group", x: minX - GROUP_PAD, y: minY - GROUP_PAD - GROUP_HEADER, w: maxX - minX + GROUP_PAD * 2, h: maxY - minY + GROUP_PAD * 2 + GROUP_HEADER,
          z: draft.minZ() - 1, parent_id: null, data_json: JSON.stringify({ title: action.title ?? "" }), created_at: now, updated_at: now,
        });
        for (const row of members) { row.parent_id = id; row.updated_at = now; }
        created.push(id);
        return;
      }
      case "ungroup": {
        const group = draft.node(action.id);
        if (group.kind !== "group") throw bad("that card is not a group", "kind");
        for (const member of draft.members(group.id)) { member.parent_id = null; member.updated_at = now; }
        draft.nodes.delete(group.id);
        for (const [edgeId, edge] of draft.edges) if (edge.source_id === group.id || edge.target_id === group.id) draft.edges.delete(edgeId);
        return;
      }
      case "setGroup": {
        if (action.groupId && draft.node(action.groupId).kind !== "group") throw bad("a card can only be put into a group", "parent");
        for (const id of new Set(action.ids)) {
          const row = draft.node(id);
          if (row.kind === "group") throw bad("a group cannot be put into a group", "nested");
          if (row.parent_id !== action.groupId) { row.parent_id = action.groupId; row.updated_at = now; }
        }
        return;
      }
      case "align": {
        const rows = draft.lead(action.ids);
        const left = Math.min(...rows.map((row) => row.x));
        const right = Math.max(...rows.map((row) => row.x + row.w));
        const top = Math.min(...rows.map((row) => row.y));
        const bottom = Math.max(...rows.map((row) => row.y + row.h));
        for (const row of rows) {
          const x = action.mode === "left" ? left : action.mode === "right" ? right - row.w : action.mode === "hcenter" ? (left + right) / 2 - row.w / 2 : row.x;
          const y = action.mode === "top" ? top : action.mode === "bottom" ? bottom - row.h : action.mode === "vcenter" ? (top + bottom) / 2 - row.h / 2 : row.y;
          draft.shift(row, x - row.x, y - row.y);
        }
        return;
      }
      case "distribute": {
        const rows = draft.lead(action.ids);
        if (rows.length < 3) return;
        const horizontal = action.axis === "h";
        const sorted = [...rows].sort((p, q) => (horizontal ? p.x - q.x : p.y - q.y));
        const first = sorted[0]!;
        const last = sorted[sorted.length - 1]!;
        const span = horizontal ? last.x + last.w - first.x : last.y + last.h - first.y;
        const used = sorted.reduce((sum, row) => sum + (horizontal ? row.w : row.h), 0);
        const gap = (span - used) / (sorted.length - 1);
        let cursor = horizontal ? first.x + first.w + gap : first.y + first.h + gap;
        for (const row of sorted.slice(1, -1)) {
          if (horizontal) { draft.shift(row, cursor - row.x, 0); cursor += row.w + gap; } else { draft.shift(row, 0, cursor - row.y); cursor += row.h + gap; }
        }
        return;
      }
      case "arrange": {
        const rows = draft.lead(action.ids);
        const columns = Math.min(action.columns ?? Math.max(1, Math.ceil(Math.sqrt(rows.length))), rows.length);
        const gap = action.gap ?? 24;
        const sorted = [...rows].sort((p, q) => (Math.abs(p.y - q.y) > 8 ? p.y - q.y : p.x - q.x));
        const originX = Math.min(...rows.map((row) => row.x));
        const originY = Math.min(...rows.map((row) => row.y));
        const widths: number[] = [];
        const heights: number[] = [];
        sorted.forEach((row, index) => {
          const column = index % columns;
          const line = Math.floor(index / columns);
          widths[column] = Math.max(widths[column] ?? 0, row.w);
          heights[line] = Math.max(heights[line] ?? 0, row.h);
        });
        sorted.forEach((row, index) => {
          const column = index % columns;
          const line = Math.floor(index / columns);
          const x = originX + widths.slice(0, column).reduce((sum, value) => sum + value + gap, 0);
          const y = originY + heights.slice(0, line).reduce((sum, value) => sum + value + gap, 0);
          draft.shift(row, x - row.x, y - row.y);
        });
        return;
      }
      case "order": {
        const rows = [...new Set(action.ids)].map((id) => draft.node(id)).sort((p, q) => p.z - q.z);
        if (action.to === "front") { let top = draft.maxZ(); for (const row of rows) { top += 1; row.z = top; row.updated_at = now; } } else { let low = draft.minZ(); for (const row of [...rows].reverse()) { low -= 1; row.z = low; row.updated_at = now; } }
        return;
      }
    }
  }
}
