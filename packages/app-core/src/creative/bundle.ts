import { EMBED_KINDS, MangaError, PROJECT_MATERIAL_KINDS, createId } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { describeObject, isObjectKind, type ObjectKind } from "./objects.ts";

/**
 * A project as plain rows (CRE-01, the project package): the project, what it owns (boards, maps, drafts, excerpts, cuts and their parts), the
 * references it holds, the embeds its boards and maps hold, and a readable snapshot of every piece of personal material they point at. A bundle
 * is what a package carries; applying one to a profile makes a project there, remapping ids when the profile already has them.
 */

/** A column's type: text, integer or real, each with `?` when it may be null, and `j` for text that holds JSON. */
type Code = "t" | "t?" | "i" | "i?" | "r" | "j" | "j?";
type TableSpec = { key: string; columns: Record<string, Code> };

const SPECS = {
  projects: { key: "id", columns: { id: "t", name: "t", goal: "t", status: "t", model_connection_id: "t?", created_at: "t", updated_at: "t" } },
  project_materials: { key: "id", columns: { id: "t", project_id: "t", kind: "t", target_id: "t", label: "t", sort_order: "i", added_at: "t" } },
  project_terms: { key: "id", columns: { id: "t", project_id: "t", term: "t", heard: "t?", note: "t?", created_at: "t" } },
  whiteboards: { key: "id", columns: { id: "t", project_id: "t?", title: "t", viewport_json: "j", created_at: "t", updated_at: "t" } },
  whiteboard_nodes: { key: "id", columns: { id: "t", board_id: "t", kind: "t", x: "r", y: "r", w: "r", h: "r", z: "i", parent_id: "t?", data_json: "j", created_at: "t", updated_at: "t" } },
  whiteboard_edges: { key: "id", columns: { id: "t", board_id: "t", source_id: "t", target_id: "t", label: "t", created_at: "t" } },
  mindmaps: { key: "id", columns: { id: "t", project_id: "t?", title: "t", theme: "t", created_at: "t", updated_at: "t" } },
  mindmap_nodes: { key: "id", columns: { id: "t", map_id: "t", parent_id: "t?", sort_key: "t", text: "t", collapsed: "i", refs_json: "j", created_at: "t", updated_at: "t" } },
  drafts: { key: "id", columns: { id: "t", project_id: "t?", title: "t", text: "t", version: "i", created_at: "t", updated_at: "t" } },
  draft_versions: { key: "id", columns: { id: "t", draft_id: "t", version: "i", text: "t", label: "t", created_at: "t" } },
  draft_suggestions: {
    key: "id",
    columns: { id: "t", draft_id: "t", kind: "t", instruction: "t", status: "t", base_version: "i", base_text: "t", result_text: "t", sources_json: "j", model_json: "j?", adopted_version: "i?", created_at: "t", updated_at: "t" },
  },
  excerpt_pages: { key: "id", columns: { id: "t", url: "t", title: "t", fetched_at: "t", content_hash: "t", body_text: "t", version: "i", previous_id: "t?", created_at: "t" } },
  excerpts: { key: "id", columns: { id: "t", project_id: "t?", page_id: "t", title: "t", text: "t", start_offset: "i", end_offset: "i", note: "t", created_at: "t" } },
  rough_cuts: { key: "id", columns: { id: "t", project_id: "t?", title: "t", created_at: "t", updated_at: "t" } },
  rough_cut_clips: { key: "id", columns: { id: "t", cut_id: "t", resource_id: "t", resource_revision_id: "t", in_ms: "i", out_ms: "i", sort_key: "t", label: "t", created_at: "t" } },
  embeds: {
    key: "id",
    columns: { id: "t", source_kind: "t", source_id: "t", slot: "t", target_kind: "t", target_id: "t", locator_json: "j", mode: "t", snapshot_json: "j?", snapshot_version: "t?", created_at: "t", updated_at: "t" },
  },
} as const satisfies Record<string, TableSpec>;

export type BundleTable = keyof typeof SPECS;
export type Row = Record<string, string | number | null>;

/** The order rows are written in: a table after the ones it points at. */
const ORDER: BundleTable[] = [
  "projects", "project_materials", "project_terms", "whiteboards", "whiteboard_nodes", "whiteboard_edges", "mindmaps", "mindmap_nodes", "drafts", "draft_versions", "draft_suggestions",
  "excerpt_pages", "excerpts", "rough_cuts", "rough_cut_clips", "embeds",
];
/** Tables whose rows have an id of their own that a copy replaces; pages are decided separately. */
const OWNED: BundleTable[] = ORDER.filter((table) => table !== "excerpt_pages");
/** The prefix an id of each table starts with, kept when a copy makes new ids. */
const PREFIX: Record<BundleTable, string> = {
  projects: "prj", project_materials: "pmt", project_terms: "ptm", whiteboards: "wb", whiteboard_nodes: "wbn", whiteboard_edges: "wbe", mindmaps: "mm", mindmap_nodes: "mmn",
  drafts: "drf", draft_versions: "drv", draft_suggestions: "drs", excerpt_pages: "pgv", excerpts: "exc", rough_cuts: "rc", rough_cut_clips: "rcc", embeds: "emb",
};
/** The kind of object a table's rows are, in the words references use. */
const KIND_OF: Partial<Record<BundleTable, ObjectKind>> = { whiteboards: "whiteboard", mindmaps: "mindmap", drafts: "draft", excerpts: "excerpt", rough_cuts: "roughcut" };

export type Snapshot = { kind: string; id: string; label: string; text: string; takenAt: string };

export type ProjectBundle = {
  project: Row;
  tables: Record<Exclude<BundleTable, "projects">, Row[]>;
  snapshots: Snapshot[];
};

export const BUNDLE_LIMITS = { rowsPerTable: 100_000, text: 8 * 1024 * 1024, snapshotText: 4000, snapshots: 5000 } as const;
const SNAPSHOT_TEXT = BUNDLE_LIMITS.snapshotText;
const clip = (value: string, max: number = SNAPSHOT_TEXT) => (value.length > max ? `${value.slice(0, max)}…` : value);

const bad = (message: string, reason: string, extra: Record<string, unknown> = {}) => new MangaError("VALIDATION_ERROR", message, { details: { reason, ...extra } });

// ---------------------------------------------------------------------------------------------------------- collecting

export function selectRows(store: DrizzleStore, table: BundleTable, where: string, params: unknown[]): Row[] {
  const columns = Object.keys(SPECS[table].columns).join(", ");
  return store.sqlite.prepare(`SELECT ${columns} FROM ${table} ${where}`).all(...params) as Row[];
}

/** Walks a value and calls `visit` on every `{ kind, targetId }`-like pair the boards and maps store, so the personal material they point at can be found. */
function referencesIn(value: unknown, visit: (kind: string, id: string) => void): void {
  if (Array.isArray(value)) { for (const item of value) referencesIn(item, visit); return; }
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  const kind = typeof object.refKind === "string" ? object.refKind : typeof object.kind === "string" ? object.kind : null;
  if (kind && typeof object.targetId === "string") visit(kind, object.targetId);
  for (const child of Object.values(object)) referencesIn(child, visit);
}

/** Reads one project into a bundle. Personal material the project refers to is not copied, only described (a snapshot), so a package never carries the library. */
export function collectBundle(store: DrizzleStore, projectId: string, now = new Date().toISOString()): ProjectBundle {
  const project = selectRows(store, "projects", "WHERE id = ?", [projectId])[0];
  if (!project) throw new MangaError("NOT_FOUND", "the project does not exist");
  const inList = (ids: string[]) => ids.map(() => "?").join(",") || "NULL";
  const idsOf = (rows: Row[]) => rows.map((row) => String(row.id));
  const tables = {} as ProjectBundle["tables"];
  tables.project_materials = selectRows(store, "project_materials", "WHERE project_id = ? ORDER BY sort_order, added_at, id", [projectId]);
  tables.project_terms = selectRows(store, "project_terms", "WHERE project_id = ? ORDER BY created_at, rowid", [projectId]);
  tables.whiteboards = selectRows(store, "whiteboards", "WHERE project_id = ? ORDER BY created_at, id", [projectId]);
  const boards = idsOf(tables.whiteboards);
  tables.whiteboard_nodes = selectRows(store, "whiteboard_nodes", `WHERE board_id IN (${inList(boards)}) ORDER BY z, created_at, id`, boards);
  tables.whiteboard_edges = selectRows(store, "whiteboard_edges", `WHERE board_id IN (${inList(boards)}) ORDER BY created_at, id`, boards);
  tables.mindmaps = selectRows(store, "mindmaps", "WHERE project_id = ? ORDER BY created_at, id", [projectId]);
  const maps = idsOf(tables.mindmaps);
  tables.mindmap_nodes = selectRows(store, "mindmap_nodes", `WHERE map_id IN (${inList(maps)}) ORDER BY created_at, id`, maps);
  tables.drafts = selectRows(store, "drafts", "WHERE project_id = ? ORDER BY created_at, id", [projectId]);
  const drafts = idsOf(tables.drafts);
  tables.draft_versions = selectRows(store, "draft_versions", `WHERE draft_id IN (${inList(drafts)}) ORDER BY draft_id, version`, drafts);
  // A suggestion that is still being written is not part of a package: nothing of it is final.
  tables.draft_suggestions = selectRows(store, "draft_suggestions", `WHERE draft_id IN (${inList(drafts)}) AND status <> 'running' ORDER BY created_at, id`, drafts);
  tables.excerpts = selectRows(store, "excerpts", "WHERE project_id = ? ORDER BY created_at, id", [projectId]);
  const pageIds = [...new Set(tables.excerpts.map((row) => String(row.page_id)))];
  tables.excerpt_pages = selectRows(store, "excerpt_pages", `WHERE id IN (${inList(pageIds)}) ORDER BY url, version`, pageIds);
  tables.rough_cuts = selectRows(store, "rough_cuts", "WHERE project_id = ? ORDER BY created_at, id", [projectId]);
  const cuts = idsOf(tables.rough_cuts);
  tables.rough_cut_clips = selectRows(store, "rough_cut_clips", `WHERE cut_id IN (${inList(cuts)}) ORDER BY cut_id, sort_key`, cuts);
  const sources = [...boards.map((id) => ["whiteboard", id]), ...maps.map((id) => ["mindmap", id])] as Array<[string, string]>;
  tables.embeds = sources.length
    ? selectRows(store, "embeds", `WHERE ${sources.map(() => "(source_kind = ? AND source_id = ?)").join(" OR ")} ORDER BY created_at, id`, sources.flat())
    : [];

  // What the project points at that it does not own: each such thing is described once.
  const owned = new Map<string, Set<string>>();
  for (const [table, kind] of Object.entries(KIND_OF) as Array<[Exclude<BundleTable, "projects">, ObjectKind]>) owned.set(kind, new Set(idsOf(tables[table])));
  const wanted = new Map<string, { kind: ObjectKind; id: string }>();
  const want = (kind: string, id: string) => {
    if (!id || !isObjectKind(kind) || owned.get(kind)?.has(id)) return;
    wanted.set(`${kind}:${id}`, { kind, id });
  };
  for (const row of tables.project_materials) want(String(row.kind), String(row.target_id));
  for (const row of tables.embeds) want(String(row.target_kind), String(row.target_id));
  for (const row of tables.whiteboard_nodes) { try { referencesIn(JSON.parse(String(row.data_json)), want); } catch { /* the row is kept as it is */ } }
  for (const row of tables.mindmap_nodes) { try { referencesIn(JSON.parse(String(row.refs_json)), want); } catch { /* the row is kept as it is */ } }
  for (const row of tables.rough_cut_clips) want("resource", String(row.resource_id));
  const snapshots: Snapshot[] = [];
  for (const { kind, id } of wanted.values()) {
    if (snapshots.length >= BUNDLE_LIMITS.snapshots) break;
    const taken = snapshotOf(store, kind, id, now);
    if (taken) snapshots.push(taken);
  }
  return { project, tables, snapshots };
}

/** A readable description of an object that stays readable when the object is not there: its name, and a little of what it says. */
export function snapshotOf(store: DrizzleStore, kind: ObjectKind, id: string, takenAt: string): Snapshot | null {
  const found = describeObject(store, kind, id);
  if (!found.exists) return null;
  const sqlite = store.sqlite;
  let text = "";
  if (kind === "note") {
    const row = sqlite.prepare("SELECT payload_json AS payload FROM content_objects WHERE id = ?").get(id) as { payload: string } | undefined;
    try { text = ((JSON.parse(row?.payload ?? "{}") as { blocks?: Array<{ text?: string }> }).blocks ?? []).map((block) => block.text ?? "").filter(Boolean).join("\n"); } catch { text = ""; }
  } else if (kind === "recording") {
    const rows = sqlite.prepare("SELECT COALESCE(NULLIF(revised_text, ''), text) AS text FROM transcript_segments WHERE session_id = ? ORDER BY seq").all(id) as Array<{ text: string }>;
    text = rows.map((row) => row.text).join("\n");
  } else if (kind === "excerpt") {
    const row = sqlite.prepare("SELECT text, note FROM excerpts WHERE id = ?").get(id) as { text: string; note: string } | undefined;
    text = [row?.text, row?.note].filter(Boolean).join("\n");
  } else if (kind === "anchor") {
    const row = sqlite.prepare("SELECT locator_json AS locator, preview_json AS preview FROM anchors WHERE id = ?").get(id) as { locator: string; preview: string | null } | undefined;
    try { text = String((JSON.parse(row?.locator ?? "{}") as { quote?: { exact?: string } }).quote?.exact ?? ""); } catch { text = ""; }
    if (!text && row?.preview) { try { const preview = JSON.parse(row.preview) as { text?: string }; text = preview.text ?? ""; } catch { text = ""; } }
  } else if (kind === "work") {
    text = (sqlite.prepare("SELECT title FROM resources WHERE work_id = ? ORDER BY sort_key, created_at LIMIT 20").all(id) as Array<{ title: string }>).map((row) => row.title).join("\n");
  }
  return { kind, id, label: clip(found.label, 200), text: clip(text), takenAt };
}

// ---------------------------------------------------------------------------------------------------------- checking

function checkValue(table: string, column: string, code: Code, value: unknown, index: number): void {
  const nullable = code.endsWith("?");
  if (value === null) { if (!nullable) throw bad(`${table}[${index}].${column} is empty`, "schema", { table, column }); return; }
  const base = code.replace("?", "");
  if (base === "t" || base === "j") {
    if (typeof value !== "string" || value.length > BUNDLE_LIMITS.text) throw bad(`${table}[${index}].${column} is not text of a fitting size`, "schema", { table, column });
    if (base === "j") { try { JSON.parse(value); } catch { throw bad(`${table}[${index}].${column} is not JSON`, "schema", { table, column }); } }
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || (base === "i" && !Number.isInteger(value))) throw bad(`${table}[${index}].${column} is not a number`, "schema", { table, column });
}

export function checkRows(table: BundleTable, rows: unknown): Row[] {
  if (!Array.isArray(rows) || rows.length > BUNDLE_LIMITS.rowsPerTable) throw bad(`${table} is not a list of a fitting size`, "schema", { table });
  const spec = SPECS[table] as TableSpec;
  const names = Object.keys(spec.columns);
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw bad(`${table}[${index}] is not a row`, "schema", { table });
    const keys = Object.keys(row);
    if (keys.length !== names.length || keys.some((key) => !(key in spec.columns))) throw bad(`${table}[${index}] does not have the columns of a ${table} row`, "schema", { table });
    for (const name of names) checkValue(table, name, spec.columns[name]!, (row as Row)[name], index);
    const key = String((row as Row)[spec.key]);
    if (!key || seen.has(key)) throw bad(`${table} has a row without an id, or an id twice`, "schema", { table });
    seen.add(key);
  });
  return rows as Row[];
}

/** Checks a bundle read from a file: every row has exactly its columns with the right kinds of value, and every row points at a row that is in the bundle. */
export function checkBundle(raw: unknown): ProjectBundle {
  if (!raw || typeof raw !== "object") throw bad("the package holds no project", "schema");
  const value = raw as { project?: unknown; tables?: Record<string, unknown>; snapshots?: unknown };
  const project = checkRows("projects", [value.project])[0]!;
  const tables = {} as ProjectBundle["tables"];
  for (const table of ORDER) {
    if (table === "projects") continue;
    tables[table] = checkRows(table, value.tables?.[table] ?? []);
  }
  const ids = (table: Exclude<BundleTable, "projects">) => new Set(tables[table].map((row) => String(row.id)));
  const needs = (table: Exclude<BundleTable, "projects">, column: string, parent: Set<string>) => {
    for (const row of tables[table]) if (!parent.has(String(row[column]))) throw bad(`${table} points at a ${column} the package does not hold`, "schema", { table, column });
  };
  const boards = ids("whiteboards"); const maps = ids("mindmaps"); const drafts = ids("drafts"); const pages = ids("excerpt_pages"); const cuts = ids("rough_cuts"); const nodes = ids("whiteboard_nodes");
  needs("whiteboard_nodes", "board_id", boards); needs("whiteboard_edges", "board_id", boards); needs("mindmap_nodes", "map_id", maps);
  needs("draft_versions", "draft_id", drafts); needs("draft_suggestions", "draft_id", drafts); needs("excerpts", "page_id", pages); needs("rough_cut_clips", "cut_id", cuts);
  for (const edge of tables.whiteboard_edges) if (!nodes.has(String(edge.source_id)) || !nodes.has(String(edge.target_id))) throw bad("a link joins a card the package does not hold", "schema", { table: "whiteboard_edges" });
  for (const table of ["whiteboards", "mindmaps", "drafts", "excerpts", "rough_cuts", "project_materials", "project_terms"] as const) {
    for (const row of tables[table]) if (row.project_id !== null && row.project_id !== project.id) throw bad(`${table} holds a row of another project`, "schema", { table });
  }
  for (const row of tables.project_materials) if (!(PROJECT_MATERIAL_KINDS as readonly string[]).includes(String(row.kind))) throw bad("a reference is of a kind a project cannot hold", "schema", { table: "project_materials" });
  for (const row of tables.embeds) {
    if (!(EMBED_KINDS as readonly string[]).includes(String(row.source_kind)) || !(EMBED_KINDS as readonly string[]).includes(String(row.target_kind))) throw bad("an embed is of a kind that cannot be embedded", "schema", { table: "embeds" });
    if (!(row.source_kind === "whiteboard" ? boards : row.source_kind === "mindmap" ? maps : new Set<string>()).has(String(row.source_id))) throw bad("an embed starts from an object the package does not hold", "schema", { table: "embeds" });
  }
  const snapshots = value.snapshots ?? [];
  if (!Array.isArray(snapshots) || snapshots.length > BUNDLE_LIMITS.snapshots) throw bad("the snapshots are not a list of a fitting size", "schema");
  for (const item of snapshots as unknown[]) {
    const snap = item as Partial<Snapshot> | null;
    if (!snap || typeof snap.kind !== "string" || typeof snap.id !== "string" || typeof snap.label !== "string" || typeof snap.text !== "string" || typeof snap.takenAt !== "string" || snap.text.length > SNAPSHOT_TEXT + 1) throw bad("a snapshot is not well formed", "schema");
  }
  return { project, tables, snapshots: snapshots as Snapshot[] };
}

// ---------------------------------------------------------------------------------------------------------- applying

export type BundleHooks = {
  /** Keeps a fetched page of the bundle, or finds the same page already kept (same address and text), and says which id its excerpts should point at. */
  adoptPage: (row: { url: string; title: string; fetched_at: string; content_hash: string; body_text: string; created_at: string }, preferredId: string) => string;
  /** Makes an excerpt findable in the research index. */
  indexExcerpt: (row: { id: string; title: string; text: string; note: string }) => void;
  /** Whether a connection of this id is here (a project asks for one by id). */
  connectionExists?: (id: string) => boolean;
  /** Where a library import put an object of personal material when it made a copy of it: the id in this profile, or the same id. */
  mapTarget?: (kind: string, id: string) => string;
};

export type BundleOutcome = {
  projectId: string;
  /** `restore`: the project came back under its own ids. `copy`: the profile already had them, so everything was made again under new ids. */
  mode: "restore" | "copy";
  counts: Record<string, number>;
  /** Personal material the project points at that this profile does not have; each shows as missing, with what the package said about it. */
  missing: Array<{ kind: string; id: string; label: string }>;
};

export const rowExists = (store: DrizzleStore, table: string, id: string) => Boolean(store.sqlite.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id));

/** Whether applying the bundle would meet ids this profile already has. */
export function bundleConflicts(store: DrizzleStore, bundle: ProjectBundle): boolean {
  if (rowExists(store, "projects", String(bundle.project.id))) return true;
  return OWNED.some((table) => table !== "projects" && bundle.tables[table as Exclude<BundleTable, "projects">].some((row) => rowExists(store, table, String(row.id))));
}

/** Rewrites the ids a JSON value holds: ids of objects the bundle owns, and the `targetId` of a reference (whose kind is its `refKind` or `kind`). */
function rewriteJson(text: string, mapId: (id: string) => string, mapRef: (kind: string, id: string) => string): string {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return mapId(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const object = value as Record<string, unknown>;
      const kind = typeof object.refKind === "string" ? object.refKind : typeof object.kind === "string" ? object.kind : null;
      return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, key === "targetId" && kind && typeof child === "string" ? mapRef(kind, child) : walk(child)]));
    }
    return value;
  };
  return JSON.stringify(walk(JSON.parse(text)));
}

/** Writes a bundle into the profile in one transaction: all of it, or nothing. */
export function applyBundle(store: DrizzleStore, bundle: ProjectBundle, hooks: BundleHooks, now = new Date().toISOString()): BundleOutcome {
  const sqlite = store.sqlite;
  const copy = bundleConflicts(store, bundle);
  const idMap = new Map<string, string>();
  if (copy) {
    for (const table of OWNED) {
      const rows = table === "projects" ? [bundle.project] : bundle.tables[table as Exclude<BundleTable, "projects">];
      for (const row of rows) idMap.set(String(row.id), createId(PREFIX[table]));
    }
  }
  const mapId = (id: string) => idMap.get(id) ?? id;
  const mapJson = (value: string | number | null) => (typeof value === "string" ? rewriteJson(value, mapId, mapRef) : value);
  const mapRef = (kind: string, id: string) => (idMap.has(id) ? idMap.get(id)! : hooks.mapTarget?.(kind, id) ?? id);
  const counts: Record<string, number> = {};
  const missing: BundleOutcome["missing"] = [];
  const projectId = mapId(String(bundle.project.id));

  sqlite.transaction(() => {
    const insert = (table: BundleTable, row: Record<string, string | number | null>) => {
      const columns = Object.keys(row);
      sqlite.prepare(`INSERT INTO ${table}(${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...columns.map((column) => row[column]));
      counts[table] = (counts[table] ?? 0) + 1;
    };
    // The project.
    const name = String(bundle.project.name);
    insert("projects", {
      ...bundle.project, id: projectId, name: copy ? `${name}（副本）`.slice(0, 120) : name, status: "active",
      model_connection_id: typeof bundle.project.model_connection_id === "string" && hooks.connectionExists?.(bundle.project.model_connection_id) ? bundle.project.model_connection_id : null,
      updated_at: now,
    });

    // The pages excerpts point into: one already kept with the same address and text is reused, so a page is never kept twice.
    const pageIds = new Map<string, string>();
    for (const page of bundle.tables.excerpt_pages) {
      const adopted = hooks.adoptPage({ url: String(page.url), title: String(page.title), fetched_at: String(page.fetched_at), content_hash: String(page.content_hash), body_text: String(page.body_text), created_at: String(page.created_at) }, String(page.id));
      pageIds.set(String(page.id), adopted);
      counts.excerpt_pages = (counts.excerpt_pages ?? 0) + 1;
    }

    const remap = (table: Exclude<BundleTable, "projects" | "excerpt_pages">, source: Row): Row => {
      const row: Row = { ...source, id: mapId(String(source.id)) };
      const parent = (column: string) => { if (row[column] !== null) row[column] = mapId(String(row[column])); };
      const json = (column: string) => { const value = row[column]; if (value !== null && value !== undefined) row[column] = mapJson(value); };
      switch (table) {
        case "project_materials": row.project_id = projectId; row.target_id = mapRef(String(source.kind), String(source.target_id)); break;
        case "project_terms": row.project_id = projectId; break;
        case "whiteboards": case "mindmaps": case "drafts": case "rough_cuts": row.project_id = projectId; break;
        case "whiteboard_nodes": parent("board_id"); parent("parent_id"); json("data_json"); break;
        case "whiteboard_edges": parent("board_id"); parent("source_id"); parent("target_id"); break;
        case "mindmap_nodes": parent("map_id"); parent("parent_id"); json("refs_json"); break;
        case "draft_versions": parent("draft_id"); break;
        case "draft_suggestions": parent("draft_id"); json("sources_json"); break;
        case "excerpts": row.project_id = projectId; row.page_id = pageIds.get(String(source.page_id)) ?? String(source.page_id); break;
        case "rough_cut_clips":
          parent("cut_id");
          row.resource_id = mapRef("resource", String(source.resource_id));
          row.resource_revision_id = hooks.mapTarget?.("revision", String(source.resource_revision_id)) ?? String(source.resource_revision_id);
          break;
        case "embeds": {
          row.source_id = mapId(String(source.source_id));
          row.target_id = mapRef(String(source.target_kind), String(source.target_id));
          const [head, ...rest] = String(source.slot).split(":");
          row.slot = [mapId(head!), ...rest].join(":");
          json("locator_json"); json("snapshot_json");
          break;
        }
      }
      return row;
    };
    for (const table of ORDER) {
      if (table === "projects" || table === "excerpt_pages") continue;
      for (const source of bundle.tables[table]) {
        const row = remap(table, source);
        insert(table, row);
        if (table === "excerpts") hooks.indexExcerpt({ id: String(row.id), title: String(row.title), text: String(row.text), note: String(row.note) });
      }
    }

    // What the project points at that this profile does not have: shown as missing, with what the package said about it.
    const taken = new Map(bundle.snapshots.map((snap) => [`${snap.kind}:${snap.id}`, snap]));
    const checked = new Set<string>();
    const check = (kind: string, id: string, label: string) => {
      const key = `${kind}:${id}`;
      if (checked.has(key) || !isObjectKind(kind)) return;
      checked.add(key);
      if (describeObject(store, kind, id).exists) return;
      const snap = taken.get(`${kind}:${source(kind, id)}`);
      missing.push({ kind, id, label: snap?.label || label });
      if (snap) sqlite.prepare("INSERT OR REPLACE INTO project_snapshots(id, project_id, kind, target_id, label, snapshot_json, taken_at) VALUES (?,?,?,?,?,?,?)")
        .run(createId("pss"), projectId, kind, id, snap.label, JSON.stringify({ text: snap.text }), snap.takenAt);
    };
    // A library import may have remapped what a reference points at; the snapshot is filed under the id the package knew it by.
    const reverse = new Map<string, string>();
    for (const row of bundle.tables.project_materials) reverse.set(`${row.kind}:${mapRef(String(row.kind), String(row.target_id))}`, String(row.target_id));
    const source = (kind: string, id: string) => reverse.get(`${kind}:${id}`) ?? id;
    for (const row of sqlite.prepare("SELECT kind, target_id AS id, label FROM project_materials WHERE project_id = ?").all(projectId) as Array<{ kind: string; id: string; label: string }>) check(row.kind, row.id, row.label);
    for (const row of sqlite.prepare("SELECT target_kind AS kind, target_id AS id FROM embeds WHERE (source_kind = 'whiteboard' AND source_id IN (SELECT id FROM whiteboards WHERE project_id = ?)) OR (source_kind = 'mindmap' AND source_id IN (SELECT id FROM mindmaps WHERE project_id = ?))").all(projectId, projectId) as Array<{ kind: string; id: string }>) check(row.kind, row.id, "");
    for (const row of sqlite.prepare("SELECT data_json AS json FROM whiteboard_nodes WHERE board_id IN (SELECT id FROM whiteboards WHERE project_id = ?)").all(projectId) as Array<{ json: string }>) referencesIn(JSON.parse(row.json), (kind, id) => check(kind, id, ""));
    for (const row of sqlite.prepare("SELECT refs_json AS json FROM mindmap_nodes WHERE map_id IN (SELECT id FROM mindmaps WHERE project_id = ?)").all(projectId) as Array<{ json: string }>) referencesIn(JSON.parse(row.json), (kind, id) => check(kind, id, ""));
    for (const row of sqlite.prepare("SELECT resource_id AS id FROM rough_cut_clips WHERE cut_id IN (SELECT id FROM rough_cuts WHERE project_id = ?)").all(projectId) as Array<{ id: string }>) check("resource", row.id, "");
  })();

  return { projectId, mode: copy ? "copy" : "restore", counts, missing };
}
