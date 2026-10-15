import type { DrizzleStore } from "@manga/storage-drizzle";

export type OpDocKind = "whiteboard" | "mindmap" | "roughcut";

/**
 * One change to one row, in the form both directions use: `row` puts the whole row (or removes it when null), `set` changes only the named
 * columns. An undo is the stored inverse list, so a move of two hundred cards is two hundred small patches, not a copy of the board.
 */
export type RowOp = { t: string; id: string; row?: Record<string, unknown> | null; set?: Record<string, unknown> };

export type OpState = { canUndo: boolean; canRedo: boolean; undoLabel: string | null; redoLabel: string | null };

const MAX_OPS = 300;

type Stored = { id: number; label: string; forward_json: string; inverse_json: string; undone: number };

/**
 * The undo and redo history of a document (a whiteboard, a mind map, a rough cut), kept in the profile so it survives a restart. A new change
 * after an undo drops what could have been redone, as an editor does; the list is capped, oldest first.
 */
export class OpLog {
  private readonly store: DrizzleStore;

  constructor(store: DrizzleStore) {
    this.store = store;
  }

  /** Records a change that has just been applied. The caller runs this in the same transaction as the change. */
  record(kind: OpDocKind, docId: string, label: string, forward: RowOp[], inverse: RowOp[]): void {
    if (!forward.length) return;
    const sqlite = this.store.sqlite;
    sqlite.prepare("DELETE FROM creative_ops WHERE doc_kind = ? AND doc_id = ? AND undone = 1").run(kind, docId);
    sqlite.prepare("INSERT INTO creative_ops(doc_kind, doc_id, at, label, forward_json, inverse_json, undone) VALUES (?,?,?,?,?,?,0)").run(kind, docId, new Date().toISOString(), label, JSON.stringify(forward), JSON.stringify(inverse));
    const total = (sqlite.prepare("SELECT COUNT(*) AS n FROM creative_ops WHERE doc_kind = ? AND doc_id = ?").get(kind, docId) as { n: number }).n;
    if (total > MAX_OPS) sqlite.prepare("DELETE FROM creative_ops WHERE id IN (SELECT id FROM creative_ops WHERE doc_kind = ? AND doc_id = ? ORDER BY id LIMIT ?)").run(kind, docId, total - MAX_OPS);
  }

  state(kind: OpDocKind, docId: string): OpState {
    const sqlite = this.store.sqlite;
    const last = sqlite.prepare("SELECT label FROM creative_ops WHERE doc_kind = ? AND doc_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1").get(kind, docId) as { label: string } | undefined;
    const next = sqlite.prepare("SELECT label FROM creative_ops WHERE doc_kind = ? AND doc_id = ? AND undone = 1 ORDER BY id ASC LIMIT 1").get(kind, docId) as { label: string } | undefined;
    return { canUndo: Boolean(last), canRedo: Boolean(next), undoLabel: last?.label ?? null, redoLabel: next?.label ?? null };
  }

  /** Takes back the last change that is still in force: its stored inverse is handed to `apply`, and the entry is marked as undone. */
  undo(kind: OpDocKind, docId: string, apply: (ops: RowOp[]) => void): string | null {
    const row = this.store.sqlite.prepare("SELECT * FROM creative_ops WHERE doc_kind = ? AND doc_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1").get(kind, docId) as Stored | undefined;
    if (!row) return null;
    apply(JSON.parse(row.inverse_json) as RowOp[]);
    this.store.sqlite.prepare("UPDATE creative_ops SET undone = 1 WHERE id = ?").run(row.id);
    return row.label;
  }

  /** Does the oldest undone change again. */
  redo(kind: OpDocKind, docId: string, apply: (ops: RowOp[]) => void): string | null {
    const row = this.store.sqlite.prepare("SELECT * FROM creative_ops WHERE doc_kind = ? AND doc_id = ? AND undone = 1 ORDER BY id ASC LIMIT 1").get(kind, docId) as Stored | undefined;
    if (!row) return null;
    apply(JSON.parse(row.forward_json) as RowOp[]);
    this.store.sqlite.prepare("UPDATE creative_ops SET undone = 0 WHERE id = ?").run(row.id);
    return row.label;
  }

  clear(kind: OpDocKind, docId: string): void {
    this.store.sqlite.prepare("DELETE FROM creative_ops WHERE doc_kind = ? AND doc_id = ?").run(kind, docId);
  }
}

/**
 * Turns "this was the state, this is the state" into the two op lists. `before` and `after` map an id to its row (null when absent); an id that
 * only appears on one side is an add or a delete, one on both sides becomes a patch of the columns that differ.
 */
export function diffRows(table: string, before: Map<string, Record<string, unknown> | null>, after: Map<string, Record<string, unknown> | null>): { forward: RowOp[]; inverse: RowOp[] } {
  const forward: RowOp[] = [];
  const inverse: RowOp[] = [];
  for (const [id, next] of after) {
    const prev = before.get(id) ?? null;
    if (!prev && !next) continue;
    if (!prev && next) { forward.push({ t: table, id, row: next }); inverse.unshift({ t: table, id, row: null }); continue; }
    if (prev && !next) { forward.push({ t: table, id, row: null }); inverse.unshift({ t: table, id, row: prev }); continue; }
    const set: Record<string, unknown> = {};
    const back: Record<string, unknown> = {};
    for (const key of Object.keys(next!)) {
      if (JSON.stringify(prev![key]) !== JSON.stringify(next![key])) { set[key] = next![key]; back[key] = prev![key]; }
    }
    if (Object.keys(set).length) { forward.push({ t: table, id, set }); inverse.unshift({ t: table, id, set: back }); }
  }
  return { forward, inverse };
}

/**
 * Applies a stored op list to the tables it names. Only tables and columns the caller lists are touched, whatever the stored JSON says, so
 * an op log copied from somewhere else cannot reach any other table.
 */
export function applyOps(store: DrizzleStore, ops: RowOp[], tables: Record<string, readonly string[]>): void {
  const sqlite = store.sqlite;
  for (const op of ops) {
    const columns = tables[op.t];
    if (!columns) throw new Error(`creative op names a table that is not allowed: ${op.t}`);
    if (op.row === null) { sqlite.prepare(`DELETE FROM ${op.t} WHERE id = ?`).run(op.id); continue; }
    const values = op.row ?? op.set ?? {};
    const keys = Object.keys(values).filter((key) => columns.includes(key));
    if (!keys.length) continue;
    if (op.row) {
      sqlite.prepare(`INSERT OR REPLACE INTO ${op.t}(${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`).run(...keys.map((key) => values[key] as string | number | null));
    } else {
      sqlite.prepare(`UPDATE ${op.t} SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE id = ?`).run(...keys.map((key) => values[key] as string | number | null), op.id);
    }
  }
}
