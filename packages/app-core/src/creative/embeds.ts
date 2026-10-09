import { MangaError, createId, type CanvasLocator, type EmbedKind, type EmbedState } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { describeObject, featureOfKind, isObjectKind, type ObjectKind } from "./objects.ts";

type EmbedRow = {
  id: string; source_kind: EmbedKind; source_id: string; slot: string; target_kind: EmbedKind; target_id: string;
  locator_json: string; mode: "live" | "snapshot"; snapshot_json: string | null; snapshot_version: string | null; created_at: string; updated_at: string;
};

export type EmbedWanted = { slot: string; targetKind: EmbedKind; targetId: string; locator?: CanvasLocator; mode?: "live" | "snapshot" };

type Snapshot = { title: string; summary: string; takenAt: string; version: string };

/** What a reader of the page sees for one embed: its state, a readable summary even when the target cannot be shown, and what can be done about it. */
export type ResolvedEmbed = {
  id: string; slot: string; sourceKind: EmbedKind; sourceId: string; targetKind: EmbedKind; targetId: string; locator: CanvasLocator; mode: "live" | "snapshot";
  state: EmbedState; title: string; summary: string; takenAt: string | null;
  /** `reopen` the target when it is merely off or not yours to read, `remove` the embed, or `keep` the snapshot when the target is gone. */
  recovery: Array<"open" | "enable" | "remove" | "keepSnapshot" | "refresh">;
};

export type EmbedHooks = { featureOn?: (featureId: string) => boolean; canRead?: (kind: EmbedKind, id: string) => boolean };

const MAX_EMBEDS_PER_SOURCE = 500;
const SUMMARY_CHARS = 160;
const SOURCE_KINDS: readonly string[] = ["note", "whiteboard", "mindmap"];

const clip = (value: string, max = SUMMARY_CHARS) => { const flat = value.replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max)}…` : flat; };

/**
 * Embeds (CRE-04). A note, a whiteboard and a mind map can each hold another of the three, whole or by a block or node, either live (shows
 * the target as it is now) or as a snapshot (shows what it was when taken). There is one relation for all of them, so a target that was
 * deleted, a module that is switched off, a target the reader may not see and a loop of embeds all end in a state with a readable summary and
 * a way out, never in a broken page or an endless recursion.
 */
export class EmbedService {
  private readonly store: DrizzleStore;
  private readonly hooks: EmbedHooks;

  constructor(store: DrizzleStore, hooks: EmbedHooks = {}) {
    this.store = store;
    this.hooks = hooks;
  }

  // ------------------------------------------------------------------ what a target looks like

  /** Title and a one-line summary of an embeddable object; `null` when it is gone. */
  describe(kind: EmbedKind, id: string, locator: CanvasLocator = {}): { title: string; summary: string } | null {
    const sqlite = this.store.sqlite;
    if (kind === "note") {
      const row = sqlite.prepare("SELECT title, payload_json AS payload FROM content_objects WHERE id = ? AND type = 'notes.document' AND deleted_at IS NULL").get(id) as { title: string; payload: string } | undefined;
      if (!row) return null;
      const blocks = ((JSON.parse(row.payload) as { blocks?: Array<{ id?: string; type?: string; text?: string }> }).blocks ?? []);
      const picked = locator.blockId ? blocks.filter((block) => block.id === locator.blockId) : blocks.filter((block) => block.type !== "embed").slice(0, 3);
      if (locator.blockId && !picked.length) return { title: row.title, summary: "" };
      return { title: row.title, summary: clip(picked.map((block) => block.text ?? "").join(" ")) };
    }
    if (kind === "whiteboard") {
      const row = sqlite.prepare("SELECT title FROM whiteboards WHERE id = ?").get(id) as { title: string } | undefined;
      if (!row) return null;
      if (locator.nodeId) {
        const node = sqlite.prepare("SELECT kind, data_json AS data FROM whiteboard_nodes WHERE id = ? AND board_id = ?").get(locator.nodeId, id) as { kind: string; data: string } | undefined;
        if (node) { const data = JSON.parse(node.data) as Record<string, unknown>; return { title: row.title, summary: clip(String(data.title ?? data.text ?? data.label ?? "")) }; }
      }
      const counts = sqlite.prepare("SELECT COUNT(*) AS n FROM whiteboard_nodes WHERE board_id = ? AND kind <> 'group'").get(id) as { n: number };
      const first = sqlite.prepare("SELECT data_json AS data FROM whiteboard_nodes WHERE board_id = ? AND kind IN ('card','text') ORDER BY z, created_at LIMIT 3").all(id) as Array<{ data: string }>;
      const lead = first.map((node) => { const data = JSON.parse(node.data) as Record<string, unknown>; return String(data.title ?? data.text ?? ""); }).filter(Boolean).join(" · ");
      return { title: row.title, summary: clip(`${counts.n} 个对象${lead ? `：${lead}` : ""}`) };
    }
    const map = sqlite.prepare("SELECT title FROM mindmaps WHERE id = ?").get(id) as { title: string } | undefined;
    if (!map) return null;
    if (locator.nodeId) {
      const node = sqlite.prepare("SELECT text FROM mindmap_nodes WHERE id = ? AND map_id = ?").get(locator.nodeId, id) as { text: string } | undefined;
      if (node) return { title: map.title, summary: clip(node.text) };
    }
    const total = sqlite.prepare("SELECT COUNT(*) AS n FROM mindmap_nodes WHERE map_id = ?").get(id) as { n: number };
    const root = sqlite.prepare("SELECT text FROM mindmap_nodes WHERE map_id = ? AND parent_id IS NULL").get(id) as { text: string } | undefined;
    return { title: map.title, summary: clip(`${total.n} 个节点${root?.text ? `：${root.text}` : ""}`) };
  }

  private snapshotOf(kind: EmbedKind, id: string, locator: CanvasLocator): Snapshot | null {
    const found = this.describe(kind, id, locator);
    if (!found) return null;
    return { title: found.title, summary: found.summary, takenAt: new Date().toISOString(), version: String(this.versionOf(kind, id)) };
  }

  /** A number that changes when the target does, so a snapshot can say it is older than what is there now. */
  private versionOf(kind: EmbedKind, id: string): string {
    const sqlite = this.store.sqlite;
    const row = kind === "note"
      ? sqlite.prepare("SELECT revision || ':' || updated_at AS v FROM content_objects WHERE id = ?").get(id)
      : sqlite.prepare(`SELECT updated_at AS v FROM ${kind === "whiteboard" ? "whiteboards" : "mindmaps"} WHERE id = ?`).get(id);
    return (row as { v: string } | undefined)?.v ?? "";
  }

  // ------------------------------------------------------------------ the relation

  /** True when putting `target` inside `source` would make the source reach itself through embeds. */
  wouldCycle(sourceKind: EmbedKind, sourceId: string, targetKind: EmbedKind, targetId: string): boolean {
    if (sourceKind === targetKind && sourceId === targetId) return true;
    const sqlite = this.store.sqlite;
    const seen = new Set<string>();
    const queue: Array<[string, string]> = [[targetKind, targetId]];
    while (queue.length) {
      const [kind, id] = queue.pop()!;
      const key = `${kind}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const next of sqlite.prepare("SELECT target_kind AS k, target_id AS i FROM embeds WHERE source_kind = ? AND source_id = ?").all(kind, id) as Array<{ k: EmbedKind; i: string }>) {
        if (next.k === sourceKind && next.i === sourceId) return true;
        queue.push([next.k, next.i]);
      }
    }
    return false;
  }

  /**
   * Makes the embeds of one source exactly the wanted list. The wanted list is derived from the source's own content (the blocks of a note, the
   * reference nodes of a board), so an undo or a restore of the source reconciles the relation without a second code path. A new embed that would
   * make a loop is refused (unless `strictCycles` is off), and the caller's transaction rolls the edit back.
   */
  sync(sourceKind: EmbedKind, sourceId: string, wanted: EmbedWanted[], options: { strictCycles?: boolean } = {}): { added: number; removed: number } {
    if (!SOURCE_KINDS.includes(sourceKind)) throw new MangaError("VALIDATION_ERROR", "that kind of object cannot hold an embed");
    if (wanted.length > MAX_EMBEDS_PER_SOURCE) throw new MangaError("VALIDATION_ERROR", "there are too many embeds here", { details: { reason: "limit" } });
    const sqlite = this.store.sqlite;
    const have = new Map((sqlite.prepare("SELECT * FROM embeds WHERE source_kind = ? AND source_id = ?").all(sourceKind, sourceId) as EmbedRow[]).map((row) => [row.slot, row]));
    const want = new Map(wanted.map((item) => [item.slot, item]));
    let added = 0;
    let removed = 0;
    const now = new Date().toISOString();
    for (const [slot, row] of have) {
      if (!want.has(slot)) { sqlite.prepare("DELETE FROM embeds WHERE id = ?").run(row.id); removed += 1; }
    }
    for (const item of wanted) {
      const locator = JSON.stringify(item.locator ?? {});
      const mode = item.mode ?? "live";
      const row = have.get(item.slot);
      if (row && row.target_kind === item.targetKind && row.target_id === item.targetId && row.locator_json === locator && row.mode === mode) continue;
      // A board or a map refuses a loop at the edit. A note is free text the user already saved, so its loop is recorded and shown as a loop.
      if (options.strictCycles !== false && this.wouldCycle(sourceKind, sourceId, item.targetKind, item.targetId)) throw new MangaError("VALIDATION_ERROR", "that would put an object inside itself", { details: { reason: "cycle" } });
      const snapshot = mode === "snapshot" ? JSON.stringify(this.snapshotOf(item.targetKind, item.targetId, item.locator ?? {})) : null;
      if (row) {
        sqlite.prepare("UPDATE embeds SET target_kind = ?, target_id = ?, locator_json = ?, mode = ?, snapshot_json = ?, snapshot_version = ?, updated_at = ? WHERE id = ?").run(item.targetKind, item.targetId, locator, mode, snapshot, snapshot ? (JSON.parse(snapshot) as Snapshot).version : null, now, row.id);
      } else {
        sqlite.prepare("INSERT INTO embeds(id, source_kind, source_id, slot, target_kind, target_id, locator_json, mode, snapshot_json, snapshot_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(createId("emb"), sourceKind, sourceId, item.slot, item.targetKind, item.targetId, locator, mode, snapshot, snapshot ? (JSON.parse(snapshot) as Snapshot).version : null, now, now);
        added += 1;
      }
    }
    return { added, removed };
  }

  upsert(input: { sourceKind: EmbedKind; sourceId: string; slot: string; targetKind: EmbedKind; targetId: string; locator?: CanvasLocator; mode?: "live" | "snapshot" }): ResolvedEmbed {
    if (!this.describe(input.targetKind, input.targetId)) throw new MangaError("NOT_FOUND", "what you are embedding does not exist");
    if (!this.describe(input.sourceKind, input.sourceId)) throw new MangaError("NOT_FOUND", "the object that holds the embed does not exist");
    this.store.sqlite.transaction(() => {
      const others = (this.store.sqlite.prepare("SELECT slot, target_kind AS targetKind, target_id AS targetId, locator_json AS locator, mode FROM embeds WHERE source_kind = ? AND source_id = ? AND slot <> ?").all(input.sourceKind, input.sourceId, input.slot) as Array<{ slot: string; targetKind: EmbedKind; targetId: string; locator: string; mode: "live" | "snapshot" }>)
        .map((row) => ({ slot: row.slot, targetKind: row.targetKind, targetId: row.targetId, locator: JSON.parse(row.locator) as CanvasLocator, mode: row.mode }));
      this.sync(input.sourceKind, input.sourceId, [...others, { slot: input.slot, targetKind: input.targetKind, targetId: input.targetId, ...(input.locator ? { locator: input.locator } : {}), ...(input.mode ? { mode: input.mode } : {}) }]);
    })();
    return this.list(input.sourceKind, input.sourceId).find((item) => item.slot === input.slot)!;
  }

  remove(sourceKind: EmbedKind, sourceId: string, slot: string): { removed: boolean } {
    return { removed: Boolean(this.store.sqlite.prepare("DELETE FROM embeds WHERE source_kind = ? AND source_id = ? AND slot = ?").run(sourceKind, sourceId, slot).changes) };
  }

  /** Takes the snapshot again, from what the target is now. A live embed has nothing to refresh. */
  refresh(sourceKind: EmbedKind, sourceId: string, slot: string): ResolvedEmbed {
    const row = this.store.sqlite.prepare("SELECT * FROM embeds WHERE source_kind = ? AND source_id = ? AND slot = ?").get(sourceKind, sourceId, slot) as EmbedRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "that embed does not exist");
    if (row.mode === "snapshot") {
      const snapshot = this.snapshotOf(row.target_kind, row.target_id, JSON.parse(row.locator_json) as CanvasLocator);
      if (!snapshot) throw new MangaError("NOT_FOUND", "the target of this embed is gone, so its snapshot cannot be refreshed");
      this.store.sqlite.prepare("UPDATE embeds SET snapshot_json = ?, snapshot_version = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(snapshot), snapshot.version, new Date().toISOString(), row.id);
    }
    return this.resolve(this.store.sqlite.prepare("SELECT * FROM embeds WHERE id = ?").get(row.id) as EmbedRow);
  }

  list(sourceKind: EmbedKind, sourceId: string): ResolvedEmbed[] {
    return (this.store.sqlite.prepare("SELECT * FROM embeds WHERE source_kind = ? AND source_id = ? ORDER BY created_at, rowid").all(sourceKind, sourceId) as EmbedRow[]).map((row) => this.resolve(row));
  }

  /** What holds this object inside it, so removing or moving it can say who would notice. */
  backlinks(targetKind: EmbedKind, targetId: string): Array<{ sourceKind: EmbedKind; sourceId: string; slot: string; title: string; state: EmbedState }> {
    const rows = this.store.sqlite.prepare("SELECT * FROM embeds WHERE target_kind = ? AND target_id = ? ORDER BY created_at, rowid").all(targetKind, targetId) as EmbedRow[];
    return rows.map((row) => ({ sourceKind: row.source_kind, sourceId: row.source_id, slot: row.slot, title: this.describe(row.source_kind, row.source_id)?.title ?? "", state: this.resolve(row).state }));
  }

  /** Removes every embed that sits inside an object, for when that object is deleted. Embeds that point at it stay and show it as gone. */
  dropSource(sourceKind: EmbedKind, sourceId: string): number {
    return Number(this.store.sqlite.prepare("DELETE FROM embeds WHERE source_kind = ? AND source_id = ?").run(sourceKind, sourceId).changes);
  }

  resolve(row: EmbedRow): ResolvedEmbed {
    const locator = JSON.parse(row.locator_json) as CanvasLocator;
    const snapshot = row.snapshot_json ? JSON.parse(row.snapshot_json) as Snapshot | null : null;
    const base = { id: row.id, slot: row.slot, sourceKind: row.source_kind, sourceId: row.source_id, targetKind: row.target_kind, targetId: row.target_id, locator, mode: row.mode };
    const found = this.describe(row.target_kind, row.target_id, locator);
    const featureOn = this.hooks.featureOn ?? (() => true);
    const fixed = row.mode === "snapshot" && snapshot ? { title: snapshot.title, summary: snapshot.summary, takenAt: snapshot.takenAt } : null;
    // A target this profile never had (the embed came in a project package) is still described by what the package said about it.
    const kept = !found && !snapshot ? this.store.sqlite.prepare("SELECT label, snapshot_json AS json, taken_at AS takenAt FROM project_snapshots WHERE kind = ? AND target_id = ? ORDER BY taken_at DESC LIMIT 1").get(row.target_kind, row.target_id) as { label: string; json: string; takenAt: string } | undefined : undefined;
    const keptText = kept ? clip(String((JSON.parse(kept.json) as { text?: string }).text ?? "")) : "";
    const withSnapshot = (state: EmbedState, recovery: ResolvedEmbed["recovery"]): ResolvedEmbed => ({
      ...base, state, title: fixed?.title ?? found?.title ?? snapshot?.title ?? kept?.label ?? "", summary: fixed?.summary ?? snapshot?.summary ?? found?.summary ?? keptText, takenAt: fixed?.takenAt ?? snapshot?.takenAt ?? kept?.takenAt ?? null, recovery,
    });
    if (!found) return withSnapshot("deleted", snapshot ? ["keepSnapshot", "remove"] : ["remove"]);
    if (this.wouldCycle(row.source_kind, row.source_id, row.target_kind, row.target_id)) return withSnapshot("cycle", ["remove"]);
    if (!featureOn(featureOfKind(row.target_kind as ObjectKind))) return withSnapshot("disabled", ["enable", "remove"]);
    if (this.hooks.canRead && !this.hooks.canRead(row.target_kind, row.target_id)) return withSnapshot("denied", ["remove"]);
    const fresh = row.mode === "snapshot" && snapshot && snapshot.version !== this.versionOf(row.target_kind, row.target_id);
    return { ...base, state: "valid", title: fixed?.title ?? found.title, summary: fixed?.summary ?? found.summary, takenAt: fixed?.takenAt ?? null, recovery: row.mode === "snapshot" ? (fresh ? ["refresh", "open", "remove"] : ["open", "remove"]) : ["open", "remove"] };
  }
}

/** Whether the value names an object kind that can sit inside another one. */
export const isEmbedKind = (value: string): value is EmbedKind => isObjectKind(value) && SOURCE_KINDS.includes(value);

/** The name of what a reference points at, with whether it is still there, for rows that only carry a kind and an id. */
export function referenceInfo(store: DrizzleStore, kind: string, id: string, featureOn: (featureId: string) => boolean = () => true): { state: "ok" | "missing" | "disabled"; label: string; opens?: ReturnType<typeof describeObject>["opens"] } {
  if (!isObjectKind(kind)) return { state: "missing", label: "" };
  const found = describeObject(store, kind, id);
  if (!found.exists) return { state: "missing", label: "" };
  return { state: featureOn(featureOfKind(kind)) ? "ok" : "disabled", label: found.label, ...(found.opens ? { opens: found.opens } : {}) };
}

/** The embeds a note holds: its blocks of type `embed`, each carrying what it points at, keyed by the block id. */
export function noteEmbedsOf(blocks: Array<{ id?: string; type?: string; attrs?: Record<string, unknown> }>): EmbedWanted[] {
  const wanted: EmbedWanted[] = [];
  for (const block of blocks) {
    if (block.type !== "embed" || !block.id) continue;
    const embed = block.attrs?.embed as { kind?: string; targetId?: string; locator?: CanvasLocator; mode?: string } | undefined;
    if (!embed || typeof embed.targetId !== "string" || !embed.targetId || !(["note", "whiteboard", "mindmap"] as string[]).includes(String(embed.kind))) continue;
    wanted.push({ slot: block.id, targetKind: embed.kind as EmbedKind, targetId: embed.targetId, ...(embed.locator ? { locator: embed.locator } : {}), mode: embed.mode === "snapshot" ? "snapshot" : "live" });
  }
  return wanted;
}
