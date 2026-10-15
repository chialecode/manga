import { EMBED_KINDS, MangaError, REF_KINDS, createId, type CanvasLocator, type EmbedKind, type MindmapActionInput } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { EmbedService, referenceInfo } from "./embeds.ts";
import { applyOps, diffRows, OpLog, type OpState, type RowOp } from "./ops.ts";
import { KEY_LIMIT, evenKeys, keyBetween } from "./sort-key.ts";

type NodeRow = { id: string; map_id: string; parent_id: string | null; sort_key: string; text: string; collapsed: number; refs_json: string; created_at: string; updated_at: string };
type MapRow = { id: string; project_id: string | null; title: string; theme: string; created_at: string; updated_at: string };

export type MapRef = { id: string; kind: string; targetId: string; locator?: CanvasLocator; label: string; mode?: "live" | "snapshot" };
export type MapRefView = MapRef & { state: "ok" | "missing" | "disabled" | "denied" | "cycle"; summary: string; opens?: { resourceId: string; mediaKind: string; workId: string | null } };
export type MapNode = { id: string; parentId: string | null; sortKey: string; text: string; collapsed: boolean; refs: MapRefView[] };
export type MapSummary = { id: string; projectId: string | null; title: string; theme: string; nodes: number; createdAt: string; updatedAt: string };
export type MapDoc = { map: { id: string; projectId: string | null; title: string; theme: string; createdAt: string; updatedAt: string }; nodes: MapNode[]; ops: OpState };

const NODE_COLUMNS = ["id", "map_id", "parent_id", "sort_key", "text", "collapsed", "refs_json", "created_at", "updated_at"] as const;
const TABLES = { mindmap_nodes: NODE_COLUMNS, mindmaps: ["theme", "updated_at"] } as const;
const MAX_NODES = 5000;
const MAX_REFS = 20;
const MAX_MAPS_PER_PROJECT = 100;
const bad = (message: string, reason: string) => new MangaError("VALIDATION_ERROR", message, { details: { reason } });
const refsOf = (row: NodeRow): MapRef[] => JSON.parse(row.refs_json) as MapRef[];

/** The working copy of a map while one edit runs. */
class Draft {
  readonly nodes = new Map<string, NodeRow>();
  readonly now = new Date().toISOString();
  readonly mapId: string;

  constructor(mapId: string, rows: NodeRow[]) {
    this.mapId = mapId;
    for (const row of rows) this.nodes.set(row.id, { ...row });
  }

  node(id: string): NodeRow {
    const found = this.nodes.get(id);
    if (!found) throw new MangaError("NOT_FOUND", "a topic of the map does not exist");
    return found;
  }

  root(): NodeRow {
    for (const row of this.nodes.values()) if (row.parent_id === null) return row;
    throw new MangaError("NOT_FOUND", "the map has no central topic");
  }

  children(parentId: string, except?: string): NodeRow[] {
    return [...this.nodes.values()].filter((row) => row.parent_id === parentId && row.id !== except).sort((a, b) => (a.sort_key < b.sort_key ? -1 : a.sort_key > b.sort_key ? 1 : a.id < b.id ? -1 : 1));
  }

  /** True when `candidate` is `ancestor` or sits anywhere under it. */
  within(candidate: string, ancestor: string): boolean {
    for (let id: string | null = candidate, guard = 0; id && guard <= this.nodes.size; guard += 1) {
      if (id === ancestor) return true;
      id = this.nodes.get(id)?.parent_id ?? null;
    }
    return false;
  }

  subtree(id: string): string[] {
    const found: string[] = [];
    const stack = [id];
    while (stack.length) {
      const next = stack.pop()!;
      found.push(next);
      for (const child of this.children(next)) stack.push(child.id);
    }
    return found;
  }

  /** A key that puts a node at `index` among the children of `parentId` (the node being moved is not counted), renumbering a list whose keys grew long. */
  keyAt(parentId: string, index: number | undefined, except?: string): string {
    const siblings = this.children(parentId, except);
    const at = index === undefined ? siblings.length : Math.min(index, siblings.length);
    const key = keyBetween(siblings[at - 1]?.sort_key ?? null, siblings[at]?.sort_key ?? null);
    if (key.length <= KEY_LIMIT) return key;
    // Renumber the siblings evenly, leaving a gap at `at` for the new key.
    const fresh = evenKeys(siblings.length + 1);
    siblings.forEach((row, i) => { row.sort_key = fresh[i < at ? i : i + 1]!; row.updated_at = this.now; });
    return fresh[at]!;
  }
}

/**
 * Mind maps (CRE-03): one central topic, a stable id per node, a sort key between siblings, a collapsed flag, and references attached to a
 * node (a reference points at personal material or another object and is never a child). Every edit is a list of steps applied to a working
 * copy and saved as one change with its inverse, like a whiteboard, so undo and redo survive a restart.
 */
export class MindmapService {
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

  exists(mapId: string): boolean {
    return Boolean(this.store.sqlite.prepare("SELECT 1 FROM mindmaps WHERE id = ?").get(mapId));
  }

  private map(mapId: string): MapRow {
    const row = this.store.sqlite.prepare("SELECT * FROM mindmaps WHERE id = ?").get(mapId) as MapRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the mind map does not exist");
    return row;
  }

  private summary(row: MapRow): MapSummary {
    const total = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM mindmap_nodes WHERE map_id = ?").get(row.id) as { n: number }).n;
    return { id: row.id, projectId: row.project_id, title: row.title, theme: row.theme, nodes: total, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  list(projectId?: string): { maps: MapSummary[] } {
    const rows = (projectId
      ? this.store.sqlite.prepare("SELECT * FROM mindmaps WHERE project_id = ? ORDER BY updated_at DESC, id").all(projectId)
      : this.store.sqlite.prepare("SELECT * FROM mindmaps ORDER BY updated_at DESC, id").all()) as MapRow[];
    return { maps: rows.map((row) => this.summary(row)) };
  }

  create(input: { projectId: string; title: string; rootText?: string }): MapSummary {
    if (!this.store.sqlite.prepare("SELECT 1 FROM projects WHERE id = ?").get(input.projectId)) throw new MangaError("NOT_FOUND", "the project does not exist");
    const have = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM mindmaps WHERE project_id = ?").get(input.projectId) as { n: number }).n;
    if (have >= MAX_MAPS_PER_PROJECT) throw bad("this project already has too many mind maps", "limit");
    const id = createId("mmp");
    const now = new Date().toISOString();
    this.store.sqlite.transaction(() => {
      this.store.sqlite.prepare("INSERT INTO mindmaps(id, project_id, title, theme, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(id, input.projectId, input.title, "pink", now, now);
      this.store.sqlite.prepare("INSERT INTO mindmap_nodes(id, map_id, parent_id, sort_key, text, collapsed, refs_json, created_at, updated_at) VALUES (?,?,?,?,?,0,'[]',?,?)").run(createId("mmn"), id, null, keyBetween(null, null), input.rootText ?? input.title, now, now);
      this.store.sqlite.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, input.projectId);
    })();
    return this.summary(this.map(id));
  }

  rename(mapId: string, title: string): MapSummary {
    this.map(mapId);
    this.store.sqlite.prepare("UPDATE mindmaps SET title = ?, updated_at = ? WHERE id = ?").run(title, new Date().toISOString(), mapId);
    return this.summary(this.map(mapId));
  }

  delete(mapId: string): { mapId: string; removedNodes: number } {
    this.map(mapId);
    const sqlite = this.store.sqlite;
    return sqlite.transaction(() => {
      const rows = sqlite.prepare("SELECT id FROM mindmap_nodes WHERE map_id = ?").all(mapId) as Array<{ id: string }>;
      sqlite.prepare("DELETE FROM mindmap_nodes WHERE map_id = ?").run(mapId);
      this.ops.clear("mindmap", mapId);
      this.embeds.dropSource("mindmap", mapId);
      sqlite.prepare("DELETE FROM mindmaps WHERE id = ?").run(mapId);
      return { mapId, removedNodes: rows.length };
    })();
  }

  private rows(mapId: string): NodeRow[] {
    return this.store.sqlite.prepare("SELECT * FROM mindmap_nodes WHERE map_id = ? ORDER BY parent_id, sort_key, id").all(mapId) as NodeRow[];
  }

  private view(row: NodeRow, embedded: Map<string, ReturnType<EmbedService["list"]>[number]>): MapNode {
    const refs = refsOf(row).map((ref): MapRefView => {
      const fixed = embedded.get(`${row.id}:${ref.id}`);
      if (fixed) return { ...ref, label: fixed.title || ref.label, state: fixed.state === "valid" ? "ok" : fixed.state === "deleted" ? "missing" : fixed.state, summary: fixed.summary };
      const info = referenceInfo(this.store, ref.kind, ref.targetId, this.featureOn);
      return { ...ref, label: info.label || ref.label, state: info.state, summary: "", ...(info.opens ? { opens: info.opens } : {}) };
    });
    return { id: row.id, parentId: row.parent_id, sortKey: row.sort_key, text: row.text, collapsed: row.collapsed === 1, refs };
  }

  get(mapId: string): MapDoc {
    const row = this.map(mapId);
    const embedded = new Map(this.embeds.list("mindmap", mapId).map((item) => [item.slot, item]));
    return {
      map: { id: row.id, projectId: row.project_id, title: row.title, theme: row.theme, createdAt: row.created_at, updatedAt: row.updated_at },
      nodes: this.rows(mapId).map((node) => this.view(node, embedded)), ops: this.ops.state("mindmap", mapId),
    };
  }

  setTheme(mapId: string, theme: string): MapSummary {
    const row = this.map(mapId);
    if (row.theme === theme) return this.summary(row);
    const now = new Date().toISOString();
    this.store.sqlite.transaction(() => {
      this.store.sqlite.prepare("UPDATE mindmaps SET theme = ?, updated_at = ? WHERE id = ?").run(theme, now, mapId);
      this.ops.record("mindmap", mapId, "theme", [{ t: "mindmaps", id: mapId, set: { theme, updated_at: now } }], [{ t: "mindmaps", id: mapId, set: { theme: row.theme, updated_at: row.updated_at } }]);
    })();
    return this.summary(this.map(mapId));
  }

  edit(input: { mapId: string; label?: string; actions: MindmapActionInput[] }): { doc: MapDoc; created: string[] } {
    const row = this.map(input.mapId);
    return this.store.sqlite.transaction(() => {
      const before = this.rows(row.id);
      const draft = new Draft(row.id, before);
      const created: string[] = [];
      for (const action of input.actions) this.apply(draft, action, created);
      if (draft.nodes.size > MAX_NODES) throw bad("the mind map has too many topics", "limit");
      const b = new Map<string, Record<string, unknown> | null>(before.map((node) => [node.id, node as unknown as Record<string, unknown>]));
      const a = new Map<string, Record<string, unknown> | null>([...draft.nodes].map(([id, node]) => [id, node as unknown as Record<string, unknown>]));
      for (const node of before) if (!draft.nodes.has(node.id)) a.set(node.id, null);
      const { forward, inverse } = diffRows("mindmap_nodes", b, a);
      if (!forward.length) return { doc: this.get(row.id), created };
      applyOps(this.store, forward, TABLES);
      this.syncEmbeds(row.id);
      this.store.sqlite.prepare("UPDATE mindmaps SET updated_at = ? WHERE id = ?").run(draft.now, row.id);
      this.ops.record("mindmap", row.id, input.label ?? input.actions[0]!.type, forward, inverse);
      return { doc: this.get(row.id), created };
    })();
  }

  undo(mapId: string): { doc: MapDoc; label: string } {
    return this.step(mapId, "undo");
  }

  redo(mapId: string): { doc: MapDoc; label: string } {
    return this.step(mapId, "redo");
  }

  private step(mapId: string, direction: "undo" | "redo"): { doc: MapDoc; label: string } {
    this.map(mapId);
    return this.store.sqlite.transaction(() => {
      const label = this.ops[direction]("mindmap", mapId, (ops: RowOp[]) => applyOps(this.store, ops, TABLES));
      if (label === null) throw new MangaError("NOT_FOUND", direction === "undo" ? "there is nothing to undo" : "there is nothing to redo");
      this.syncEmbeds(mapId);
      return { doc: this.get(mapId), label };
    })();
  }

  /** References to objects that can themselves hold content are embeds; the relation follows the map, and a loop is refused. */
  private syncEmbeds(mapId: string): void {
    const wanted = [];
    for (const row of this.rows(mapId)) {
      for (const ref of refsOf(row)) {
        if (!(EMBED_KINDS as readonly string[]).includes(ref.kind)) continue;
        wanted.push({ slot: `${row.id}:${ref.id}`, targetKind: ref.kind as EmbedKind, targetId: ref.targetId, ...(ref.locator ? { locator: ref.locator } : {}), mode: ref.mode === "snapshot" ? "snapshot" as const : "live" as const });
      }
    }
    const have = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM embeds WHERE source_kind = 'mindmap' AND source_id = ?").get(mapId) as { n: number }).n;
    if (!wanted.length && !have) return;
    this.embeds.sync("mindmap", mapId, wanted);
  }

  private apply(draft: Draft, action: MindmapActionInput, created: string[]): void {
    const now = draft.now;
    const add = (parentId: string, index: number | undefined, id: string | undefined, text: string | undefined) => {
      const newId = id ?? createId("mmn");
      if (draft.nodes.has(newId)) throw bad("a topic with that id is already in the map", "duplicate");
      draft.node(parentId);
      draft.nodes.set(newId, { id: newId, map_id: draft.mapId, parent_id: parentId, sort_key: draft.keyAt(parentId, index), text: text ?? "", collapsed: 0, refs_json: "[]", created_at: now, updated_at: now });
      // A parent that was folded opens when it gains a child, so the new topic is not hidden.
      const parent = draft.node(parentId);
      if (parent.collapsed) { parent.collapsed = 0; parent.updated_at = now; }
      created.push(newId);
    };
    switch (action.type) {
      case "addChild": add(action.parentId, action.index, action.id, action.text); return;
      case "addSibling": {
        const node = draft.node(action.nodeId);
        if (node.parent_id === null) throw bad("the central topic has no siblings", "root");
        const at = draft.children(node.parent_id).findIndex((row) => row.id === node.id);
        add(node.parent_id, action.before ? at : at + 1, action.id, action.text);
        return;
      }
      case "setText": { const node = draft.node(action.nodeId); node.text = action.text; node.updated_at = now; return; }
      case "move": {
        const node = draft.node(action.nodeId);
        if (node.parent_id === null) throw bad("the central topic cannot be moved", "root");
        draft.node(action.parentId);
        if (draft.within(action.parentId, node.id)) throw bad("a topic cannot be moved under itself", "descendant");
        node.sort_key = draft.keyAt(action.parentId, action.index, node.id);
        node.parent_id = action.parentId; node.updated_at = now;
        const parent = draft.node(action.parentId);
        if (parent.collapsed) { parent.collapsed = 0; parent.updated_at = now; }
        return;
      }
      case "shift": {
        const node = draft.node(action.nodeId);
        if (node.parent_id === null) throw bad("the central topic has no place among siblings", "root");
        const siblings = draft.children(node.parent_id);
        const at = siblings.findIndex((row) => row.id === node.id);
        const to = action.direction === "up" ? at - 1 : at + 1;
        if (to < 0 || to >= siblings.length) return;
        node.sort_key = draft.keyAt(node.parent_id, to, node.id);
        node.updated_at = now;
        return;
      }
      case "delete": {
        const node = draft.node(action.nodeId);
        if (node.parent_id === null) throw bad("the central topic cannot be deleted", "root");
        for (const id of draft.subtree(node.id)) draft.nodes.delete(id);
        return;
      }
      case "collapse": { const node = draft.node(action.nodeId); const next = action.collapsed ? 1 : 0; if (node.collapsed !== next) { node.collapsed = next; node.updated_at = now; } return; }
      case "addRef": {
        const node = draft.node(action.nodeId);
        const refs = refsOf(node);
        if (refs.length >= MAX_REFS) throw bad("this topic already has too many references", "limit");
        if (!(REF_KINDS as readonly string[]).includes(action.kind)) throw bad("that kind of object cannot be referenced", "ref");
        const info = referenceInfo(this.store, action.kind, action.targetId);
        if (info.state === "missing") throw new MangaError("NOT_FOUND", "what you are pointing at does not exist");
        refs.push({ id: createId("mmr"), kind: action.kind, targetId: action.targetId, ...(action.locator ? { locator: action.locator } : {}), label: (action.label ?? info.label).slice(0, 200) });
        node.refs_json = JSON.stringify(refs); node.updated_at = now;
        created.push(refs[refs.length - 1]!.id);
        return;
      }
      case "removeRef": {
        const node = draft.node(action.nodeId);
        const refs = refsOf(node);
        const next = refs.filter((ref) => ref.id !== action.refId);
        if (next.length === refs.length) throw new MangaError("NOT_FOUND", "that reference is not on this topic");
        node.refs_json = JSON.stringify(next); node.updated_at = now;
        return;
      }
    }
  }

  // ------------------------------------------------------------------ text exports

  /** The map as an outline: the central topic is the title line, every other topic a list item, references written after the topic they belong to. */
  toMarkdown(mapId: string): string {
    const doc = this.get(mapId);
    const byParent = new Map<string | null, MapNode[]>();
    for (const node of doc.nodes) { const list = byParent.get(node.parentId) ?? []; list.push(node); byParent.set(node.parentId, list); }
    const line = (node: MapNode) => {
      const text = node.text.replace(/\s*\n\s*/g, " ").trim() || "（空）";
      const refs = node.refs.map((ref) => ref.label || ref.targetId).filter(Boolean);
      return refs.length ? `${text}（引用：${refs.join("；")}）` : text;
    };
    const lines: string[] = [];
    const walk = (node: MapNode, depth: number) => {
      for (const child of byParent.get(node.id) ?? []) { lines.push(`${"  ".repeat(depth)}- ${line(child)}`); walk(child, depth + 1); }
    };
    const root = (byParent.get(null) ?? [])[0];
    if (!root) return `# ${doc.map.title}\n`;
    lines.push(`# ${line(root)}`, "");
    walk(root, 0);
    return `${lines.join("\n")}\n`;
  }

  /** The map as an OPML 2.0 outline, which outliners and other mind-map tools read. */
  toOpml(mapId: string): string {
    const doc = this.get(mapId);
    const byParent = new Map<string | null, MapNode[]>();
    for (const node of doc.nodes) { const list = byParent.get(node.parentId) ?? []; list.push(node); byParent.set(node.parentId, list); }
    const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\r?\n/g, "&#10;");
    const outline = (node: MapNode, depth: number): string => {
      const pad = "  ".repeat(depth);
      const note = node.refs.length ? ` _note="${escape(`引用：${node.refs.map((ref) => ref.label || ref.targetId).join("；")}`)}"` : "";
      const kids = byParent.get(node.id) ?? [];
      if (!kids.length) return `${pad}<outline text="${escape(node.text)}"${note}/>`;
      return `${pad}<outline text="${escape(node.text)}"${note}>\n${kids.map((kid) => outline(kid, depth + 1)).join("\n")}\n${pad}</outline>`;
    };
    const root = (byParent.get(null) ?? [])[0];
    return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head>\n    <title>${escape(doc.map.title)}</title>\n    <dateModified>${new Date(doc.map.updatedAt).toUTCString()}</dateModified>\n  </head>\n  <body>\n${root ? outline(root, 2) : ""}\n  </body>\n</opml>\n`;
  }
}
