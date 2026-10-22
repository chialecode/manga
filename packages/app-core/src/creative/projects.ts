import { MangaError, PROJECT_MATERIAL_KINDS, createId, type MaterialOrigin, type ProjectMaterialKind } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { describeObject, featureOfKind, resourcesOf, type ObjectKind, type ObjectOpens } from "./objects.ts";

type ProjectRow = { id: string; name: string; goal: string; status: "active" | "archived"; model_connection_id: string | null; created_at: string; updated_at: string };

export type ProjectSummary = {
  id: string; name: string; goal: string; status: "active" | "archived"; modelConnectionId: string | null; createdAt: string; updatedAt: string;
  counts: { materials: number; terms: number; sessions: number; whiteboards: number; mindmaps: number; drafts: number; excerpts: number; roughCuts: number };
};

/** An object a project owns, as the work mode's overview lists the ones edited last. */
export type OverviewObject = { kind: "whiteboard" | "mindmap" | "draft" | "roughcut"; id: string; title: string; projectId: string; projectName: string; updatedAt: string };
/** A suggestion for a draft that has not been taken or dismissed yet. */
export type OverviewSuggestion = { id: string; draftId: string; draftTitle: string; projectId: string; projectName: string; kind: string; createdAt: string };
export type ProjectOverview = {
  recent: ProjectSummary[];
  objects: OverviewObject[];
  suggestions: OverviewSuggestion[];
  totals: { active: number; archived: number };
};

const OVERVIEW_PROJECTS = 6;
const OVERVIEW_ROWS = 8;

export type ProjectMaterial = {
  id: string; kind: ProjectMaterialKind; targetId: string; label: string; state: "ok" | "missing" | "disabled"; addedAt: string; origin: MaterialOrigin; opens?: ObjectOpens;
  /** What a project package said about material this profile does not have, so a missing reference can still be read. */
  snapshot?: { text: string; takenAt: string };
};

const MAX_PROJECTS = 500;
const MAX_MATERIALS = 2000;
const MAX_TERMS = 2000;

/**
 * Projects (CRE-01). A project owns its terms, its sessions and its creative objects (boards, maps, drafts, excerpts, cuts), and only
 * refers to personal material: a reference is a row that points at a work, resource, note or recording, so removing it, or the project,
 * leaves the thing it pointed at where it was. A session of a project reads and writes only inside the project's scope.
 */
export class ProjectService {
  private readonly store: DrizzleStore;
  private readonly featureOn: (featureId: string) => boolean;

  constructor(store: DrizzleStore, featureOn: (featureId: string) => boolean = () => true) {
    this.store = store;
    this.featureOn = featureOn;
  }

  private row(projectId: string): ProjectRow {
    const row = this.store.sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as ProjectRow | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the project does not exist");
    return row;
  }

  exists(projectId: string): boolean {
    return Boolean(this.store.sqlite.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId));
  }

  private count(sql: string, projectId: string): number {
    return (this.store.sqlite.prepare(sql).get(projectId) as { n: number }).n;
  }

  private summary(row: ProjectRow): ProjectSummary {
    return {
      id: row.id, name: row.name, goal: row.goal, status: row.status, modelConnectionId: row.model_connection_id, createdAt: row.created_at, updatedAt: row.updated_at,
      counts: {
        materials: this.count("SELECT COUNT(*) AS n FROM project_materials WHERE project_id = ?", row.id),
        terms: this.count("SELECT COUNT(*) AS n FROM project_terms WHERE project_id = ?", row.id),
        sessions: this.count("SELECT COUNT(*) AS n FROM agent_sessions WHERE project_id = ?", row.id),
        whiteboards: this.count("SELECT COUNT(*) AS n FROM whiteboards WHERE project_id = ?", row.id),
        mindmaps: this.count("SELECT COUNT(*) AS n FROM mindmaps WHERE project_id = ?", row.id),
        drafts: this.count("SELECT COUNT(*) AS n FROM drafts WHERE project_id = ?", row.id),
        excerpts: this.count("SELECT COUNT(*) AS n FROM excerpts WHERE project_id = ?", row.id),
        roughCuts: this.count("SELECT COUNT(*) AS n FROM rough_cuts WHERE project_id = ?", row.id),
      },
    };
  }

  list(status: "active" | "archived" | "all" = "active"): { projects: ProjectSummary[] } {
    const rows = this.store.sqlite.prepare(`SELECT * FROM projects ${status === "all" ? "" : "WHERE status = ?"} ORDER BY updated_at DESC, id`).all(...(status === "all" ? [] : [status])) as ProjectRow[];
    return { projects: rows.map((row) => this.summary(row)) };
  }

  /**
   * The work mode's first page: the projects touched last, the objects edited last across all of them, and the suggestions that wait to be
   * taken. Archived projects are not part of it; they are counted so the page can say they exist.
   */
  overview(): ProjectOverview {
    const sql = this.store.sqlite;
    const recent = (sql.prepare("SELECT * FROM projects WHERE status = 'active' ORDER BY updated_at DESC, id LIMIT ?").all(OVERVIEW_PROJECTS) as ProjectRow[]).map((row) => this.summary(row));
    const owned = (kind: OverviewObject["kind"], table: string) => `SELECT '${kind}' AS kind, o.id AS id, o.title AS title, o.project_id AS projectId, p.name AS projectName, o.updated_at AS updatedAt FROM ${table} o JOIN projects p ON p.id = o.project_id WHERE p.status = 'active'`;
    const objects = sql.prepare(`${[owned("whiteboard", "whiteboards"), owned("mindmap", "mindmaps"), owned("draft", "drafts"), owned("roughcut", "rough_cuts")].join(" UNION ALL ")} ORDER BY updatedAt DESC, id LIMIT ?`).all(OVERVIEW_ROWS) as OverviewObject[];
    const suggestions = sql.prepare(
      `SELECT s.id AS id, s.draft_id AS draftId, d.title AS draftTitle, d.project_id AS projectId, p.name AS projectName, s.kind AS kind, s.created_at AS createdAt
       FROM draft_suggestions s JOIN drafts d ON d.id = s.draft_id JOIN projects p ON p.id = d.project_id
       WHERE s.status = 'pending' AND p.status = 'active' ORDER BY s.created_at DESC, s.id LIMIT ?`,
    ).all(OVERVIEW_ROWS) as OverviewSuggestion[];
    const count = (status: string) => (sql.prepare("SELECT COUNT(*) AS n FROM projects WHERE status = ?").get(status) as { n: number }).n;
    return { recent, objects, suggestions, totals: { active: count("active"), archived: count("archived") } };
  }

  create(input: { name: string; goal?: string }): ProjectSummary {
    const total = this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM projects").get() as { n: number };
    if (total.n >= MAX_PROJECTS) throw new MangaError("VALIDATION_ERROR", "there are already too many projects; archive or delete some first", { details: { reason: "limit" } });
    const id = createId("prj");
    const now = new Date().toISOString();
    this.store.sqlite.prepare("INSERT INTO projects(id, name, goal, status, model_connection_id, created_at, updated_at) VALUES (?,?,?,?,NULL,?,?)").run(id, input.name, input.goal ?? "", "active", now, now);
    return this.summary(this.row(id));
  }

  get(projectId: string): { project: ProjectSummary; materials: ProjectMaterial[]; terms: Array<{ id: string; term: string; heard: string | null; note: string | null }>; sessions: Array<{ sessionId: string; title: string; updatedAt: string }> } {
    const row = this.row(projectId);
    const sessions = this.store.sqlite.prepare("SELECT id AS sessionId, title, updated_at AS updatedAt FROM agent_sessions WHERE project_id = ? ORDER BY updated_at DESC").all(projectId) as Array<{ sessionId: string; title: string; updatedAt: string }>;
    return { project: this.summary(row), materials: this.materials(projectId), terms: this.terms(projectId), sessions };
  }

  update(input: { projectId: string; name?: string; goal?: string; status?: "active" | "archived"; modelConnectionId?: string | null }): ProjectSummary {
    const row = this.row(input.projectId);
    if (input.modelConnectionId) {
      const connection = this.store.sqlite.prepare("SELECT purpose FROM provider_connections WHERE id = ?").get(input.modelConnectionId) as { purpose: string } | undefined;
      if (!connection) throw new MangaError("NOT_FOUND", "that connection does not exist");
      if (connection.purpose !== "text") throw new MangaError("VALIDATION_ERROR", "a project's conversations need a text connection", { details: { reason: "connection-purpose" } });
    }
    this.store.sqlite.prepare("UPDATE projects SET name = ?, goal = ?, status = ?, model_connection_id = ?, updated_at = ? WHERE id = ?").run(
      input.name ?? row.name, input.goal ?? row.goal, input.status ?? row.status,
      input.modelConnectionId === undefined ? row.model_connection_id : input.modelConnectionId, new Date().toISOString(), input.projectId,
    );
    return this.summary(this.row(input.projectId));
  }

  /**
   * Removes the project, its references, terms and its own creative objects. Nothing it merely referred to is touched, and its
   * conversations stay (they become conversations of no project) so no text the user wrote is lost with it.
   */
  delete(projectId: string): { projectId: string; removed: { materials: number; terms: number; objects: number }; keptSessions: number } {
    this.row(projectId);
    const sqlite = this.store.sqlite;
    if (sqlite.prepare("SELECT 1 FROM rough_cut_exports e JOIN rough_cuts c ON c.id = e.cut_id WHERE c.project_id = ? AND e.state IN ('planned','running') LIMIT 1").get(projectId)) {
      throw new MangaError("VALIDATION_ERROR", "a sequence of this project is being exported", { details: { reason: "busy" } });
    }
    return sqlite.transaction(() => {
      const objects = { n: 0 };
      const boards = (sqlite.prepare("SELECT id FROM whiteboards WHERE project_id = ?").all(projectId) as Array<{ id: string }>).map((item) => item.id);
      for (const id of boards) { sqlite.prepare("DELETE FROM whiteboard_nodes WHERE board_id = ?").run(id); sqlite.prepare("DELETE FROM whiteboard_edges WHERE board_id = ?").run(id); sqlite.prepare("DELETE FROM creative_ops WHERE doc_kind = 'whiteboard' AND doc_id = ?").run(id); sqlite.prepare("DELETE FROM embeds WHERE source_kind = 'whiteboard' AND source_id = ?").run(id); }
      objects.n += Number(sqlite.prepare("DELETE FROM whiteboards WHERE project_id = ?").run(projectId).changes);
      const maps = (sqlite.prepare("SELECT id FROM mindmaps WHERE project_id = ?").all(projectId) as Array<{ id: string }>).map((item) => item.id);
      for (const id of maps) { sqlite.prepare("DELETE FROM mindmap_nodes WHERE map_id = ?").run(id); sqlite.prepare("DELETE FROM creative_ops WHERE doc_kind = 'mindmap' AND doc_id = ?").run(id); sqlite.prepare("DELETE FROM embeds WHERE source_kind = 'mindmap' AND source_id = ?").run(id); }
      objects.n += Number(sqlite.prepare("DELETE FROM mindmaps WHERE project_id = ?").run(projectId).changes);
      const drafts = (sqlite.prepare("SELECT id FROM drafts WHERE project_id = ?").all(projectId) as Array<{ id: string }>).map((item) => item.id);
      for (const id of drafts) { sqlite.prepare("DELETE FROM draft_versions WHERE draft_id = ?").run(id); sqlite.prepare("DELETE FROM draft_suggestions WHERE draft_id = ?").run(id); }
      objects.n += Number(sqlite.prepare("DELETE FROM drafts WHERE project_id = ?").run(projectId).changes);
      for (const item of sqlite.prepare("SELECT id FROM excerpts WHERE project_id = ?").all(projectId) as Array<{ id: string }>) {
        sqlite.prepare("DELETE FROM research_idx WHERE ref_kind = 'excerpt' AND ref_id = ?").run(item.id);
        sqlite.prepare("DELETE FROM project_materials WHERE kind = 'excerpt' AND target_id = ?").run(item.id);
      }
      objects.n += Number(sqlite.prepare("DELETE FROM excerpts WHERE project_id = ?").run(projectId).changes);
      const cuts = (sqlite.prepare("SELECT id FROM rough_cuts WHERE project_id = ?").all(projectId) as Array<{ id: string }>).map((item) => item.id);
      for (const id of cuts) { sqlite.prepare("DELETE FROM rough_cut_clips WHERE cut_id = ?").run(id); sqlite.prepare("DELETE FROM rough_cut_exports WHERE cut_id = ?").run(id); sqlite.prepare("DELETE FROM creative_ops WHERE doc_kind = 'roughcut' AND doc_id = ?").run(id); }
      objects.n += Number(sqlite.prepare("DELETE FROM rough_cuts WHERE project_id = ?").run(projectId).changes);
      // Other projects that referred to an object that went with this one see it as gone, with its name kept in the reference.
      const materials = Number(sqlite.prepare("DELETE FROM project_materials WHERE project_id = ?").run(projectId).changes);
      const terms = Number(sqlite.prepare("DELETE FROM project_terms WHERE project_id = ?").run(projectId).changes);
      sqlite.prepare("DELETE FROM project_snapshots WHERE project_id = ?").run(projectId);
      // The project's conversations become conversations of "最近": the one about the project itself is a general conversation there, the rest keep their targets.
      sqlite.prepare("UPDATE agent_sessions SET kind = 'shared', target_id = NULL WHERE project_id = ? AND kind = 'project'").run(projectId);
      const kept = Number(sqlite.prepare("UPDATE agent_sessions SET project_id = NULL WHERE project_id = ?").run(projectId).changes);
      // What was kept per context goes with the context: where the person was in each resource, the tabs and layout, and the removed-material marks.
      sqlite.prepare("DELETE FROM progress WHERE context_id = ?").run(projectId);
      sqlite.prepare("DELETE FROM workspace_contexts WHERE context_id = ?").run(projectId);
      sqlite.prepare("DELETE FROM project_material_exclusions WHERE project_id = ?").run(projectId);
      sqlite.prepare("DELETE FROM schema_meta WHERE key = ?").run(`conversation.current.project.${projectId}`);
      sqlite.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
      return { projectId, removed: { materials, terms, objects: objects.n }, keptSessions: kept };
    })();
  }

  // ------------------------------------------------------------------ materials

  materials(projectId: string): ProjectMaterial[] {
    const rows = this.store.sqlite.prepare("SELECT id, kind, target_id AS targetId, label, added_at AS addedAt, origin FROM project_materials WHERE project_id = ? ORDER BY sort_order, added_at, id").all(projectId) as Array<{ id: string; kind: ProjectMaterialKind; targetId: string; label: string; addedAt: string; origin: MaterialOrigin }>;
    return rows.map((row) => {
      const found = describeObject(this.store, row.kind as ObjectKind, row.targetId);
      const state = !found.exists ? "missing" : this.featureOn(featureOfKind(row.kind as ObjectKind)) ? "ok" : "disabled";
      // The name saved with the reference stays readable when what it pointed at is gone.
      const snap = found.exists ? undefined : this.store.sqlite.prepare("SELECT snapshot_json AS json, taken_at AS takenAt FROM project_snapshots WHERE project_id = ? AND kind = ? AND target_id = ?").get(projectId, row.kind, row.targetId) as { json: string; takenAt: string } | undefined;
      const text = snap ? String((JSON.parse(snap.json) as { text?: string }).text ?? "") : "";
      return { id: row.id, kind: row.kind, targetId: row.targetId, label: found.exists && found.label ? found.label : row.label, state, addedAt: row.addedAt, origin: row.origin, ...(found.opens ? { opens: found.opens } : {}), ...(snap ? { snapshot: { text, takenAt: snap.takenAt } } : {}) };
    });
  }

  /**
   * Everything a project can refer to: the materials it holds and the objects it owns (boards, maps, drafts, excerpts, cuts). A board or a
   * map offers these when it is asked to point at something, so one list serves every module.
   */
  objects(projectId: string): { objects: Array<{ kind: ProjectMaterialKind; id: string; label: string; state: "ok" | "missing" | "disabled"; own: boolean }> } {
    this.row(projectId);
    const own: Array<{ kind: ProjectMaterialKind; table: string; label: string }> = [
      { kind: "whiteboard", table: "whiteboards", label: "title" }, { kind: "mindmap", table: "mindmaps", label: "title" }, { kind: "draft", table: "drafts", label: "title" },
      { kind: "excerpt", table: "excerpts", label: "COALESCE(NULLIF(title, ''), substr(text, 1, 40))" }, { kind: "roughcut", table: "rough_cuts", label: "title" },
    ];
    const found: Array<{ kind: ProjectMaterialKind; id: string; label: string; state: "ok" | "missing" | "disabled"; own: boolean }> = [];
    for (const item of own) {
      const state = this.featureOn(featureOfKind(item.kind as ObjectKind)) ? "ok" as const : "disabled" as const;
      for (const row of this.store.sqlite.prepare(`SELECT id, ${item.label} AS label FROM ${item.table} WHERE project_id = ? ORDER BY created_at, id`).all(projectId) as Array<{ id: string; label: string }>) found.push({ kind: item.kind, id: row.id, label: row.label, state, own: true });
    }
    for (const material of this.materials(projectId)) found.push({ kind: material.kind, id: material.targetId, label: material.label, state: material.state, own: false });
    return { objects: found };
  }

  /**
   * Adds a reference. `origin: "auto"` is what opening or making something inside the project does (Q-33): it adds nothing the person has taken out of the
   * project before (the answer is then `{ skipped: "excluded" }`), and a reference that is there already is left as it is. An addition by the person
   * (the default) works even for something they removed earlier, and lifts that mark.
   */
  addMaterial(input: { projectId: string; kind: ProjectMaterialKind; targetId: string; label?: string; origin?: MaterialOrigin }): ProjectMaterial | { skipped: "excluded" | "limit" } {
    this.row(input.projectId);
    if (!(PROJECT_MATERIAL_KINDS as readonly string[]).includes(input.kind)) throw new MangaError("VALIDATION_ERROR", "that kind of material cannot be added to a project");
    const origin: MaterialOrigin = input.origin ?? "manual";
    const found = describeObject(this.store, input.kind as ObjectKind, input.targetId);
    if (!found.exists) throw new MangaError("NOT_FOUND", "what you are adding does not exist");
    const existing = this.store.sqlite.prepare("SELECT id FROM project_materials WHERE project_id = ? AND kind = ? AND target_id = ?").get(input.projectId, input.kind, input.targetId) as { id: string } | undefined;
    const now = new Date().toISOString();
    let materialId = existing?.id;
    if (!materialId) {
      const excluded = this.store.sqlite.prepare("SELECT 1 FROM project_material_exclusions WHERE project_id = ? AND kind = ? AND target_id = ?").get(input.projectId, input.kind, input.targetId);
      if (origin === "auto" && excluded) return { skipped: "excluded" };
      if (this.count("SELECT COUNT(*) AS n FROM project_materials WHERE project_id = ?", input.projectId) >= MAX_MATERIALS) {
        if (origin === "auto") return { skipped: "limit" };
        throw new MangaError("VALIDATION_ERROR", "this project already holds too many materials", { details: { reason: "limit" } });
      }
      materialId = createId("pmt");
      const order = (this.store.sqlite.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM project_materials WHERE project_id = ?").get(input.projectId) as { n: number }).n;
      this.store.sqlite.transaction(() => {
        this.store.sqlite.prepare("INSERT INTO project_materials(id, project_id, kind, target_id, label, sort_order, added_at, origin) VALUES (?,?,?,?,?,?,?,?)").run(materialId, input.projectId, input.kind, input.targetId, (input.label ?? found.label).slice(0, 200), order, now, origin);
        if (origin === "manual") this.store.sqlite.prepare("DELETE FROM project_material_exclusions WHERE project_id = ? AND kind = ? AND target_id = ?").run(input.projectId, input.kind, input.targetId);
        this.store.sqlite.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, input.projectId);
      })();
    }
    return this.materials(input.projectId).find((item) => item.id === materialId)!;
  }

  /** Takes a reference out. What the person removed is not added again by opening it in this project; adding it by hand lifts that. */
  removeMaterial(projectId: string, materialId: string): { projectId: string; materialId: string } {
    this.row(projectId);
    const row = this.store.sqlite.prepare("SELECT kind, target_id AS targetId FROM project_materials WHERE id = ? AND project_id = ?").get(materialId, projectId) as { kind: string; targetId: string } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "that material is not in the project");
    const now = new Date().toISOString();
    this.store.sqlite.transaction(() => {
      this.store.sqlite.prepare("DELETE FROM project_materials WHERE id = ? AND project_id = ?").run(materialId, projectId);
      this.store.sqlite.prepare("INSERT OR REPLACE INTO project_material_exclusions(project_id, kind, target_id, removed_at) VALUES (?,?,?,?)").run(projectId, row.kind, row.targetId, now);
      this.store.sqlite.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, projectId);
    })();
    return { projectId, materialId };
  }

  /**
   * The resources a conversation of this project may read: what its references lead to. A work leads to its volumes, an anchor to its
   * resource, a note to the resources its quotes come from. The project's own objects are inside the project and need no reference.
   */
  scopeResourceIds(projectId: string): string[] {
    const found = new Set<string>();
    for (const row of this.store.sqlite.prepare("SELECT kind, target_id AS targetId FROM project_materials WHERE project_id = ?").all(projectId) as Array<{ kind: ObjectKind; targetId: string }>) {
      for (const resourceId of resourcesOf(this.store, row.kind, row.targetId)) found.add(resourceId);
    }
    return [...found];
  }

  /** The notes a conversation of this project may read. */
  scopeNoteIds(projectId: string): string[] {
    return (this.store.sqlite.prepare("SELECT target_id AS id FROM project_materials WHERE project_id = ? AND kind = 'note'").all(projectId) as Array<{ id: string }>).map((row) => row.id);
  }

  // ------------------------------------------------------------------ terms (the project's own glossary, apart from the voice dictionary)

  terms(projectId: string): Array<{ id: string; term: string; heard: string | null; note: string | null }> {
    return this.store.sqlite.prepare("SELECT id, term, heard, note FROM project_terms WHERE project_id = ? ORDER BY created_at, rowid").all(projectId) as Array<{ id: string; term: string; heard: string | null; note: string | null }>;
  }

  addTerm(input: { projectId: string; term: string; heard?: string; note?: string }): { id: string; term: string; heard: string | null; note: string | null } {
    this.row(input.projectId);
    if (this.count("SELECT COUNT(*) AS n FROM project_terms WHERE project_id = ?", input.projectId) >= MAX_TERMS) throw new MangaError("VALIDATION_ERROR", "this project already has too many terms", { details: { reason: "limit" } });
    const existing = this.store.sqlite.prepare("SELECT id FROM project_terms WHERE project_id = ? AND term = ?").get(input.projectId, input.term) as { id: string } | undefined;
    const id = existing?.id ?? createId("ptm");
    if (existing) this.store.sqlite.prepare("UPDATE project_terms SET heard = ?, note = ? WHERE id = ?").run(input.heard?.trim() || null, input.note?.trim() || null, id);
    else this.store.sqlite.prepare("INSERT INTO project_terms(id, project_id, term, heard, note, created_at) VALUES (?,?,?,?,?,?)").run(id, input.projectId, input.term, input.heard?.trim() || null, input.note?.trim() || null, new Date().toISOString());
    return this.terms(input.projectId).find((item) => item.id === id)!;
  }

  updateTerm(input: { projectId: string; termId: string; term?: string; heard?: string | null; note?: string | null }): { id: string; term: string; heard: string | null; note: string | null } {
    const row = this.store.sqlite.prepare("SELECT id, term, heard, note FROM project_terms WHERE id = ? AND project_id = ?").get(input.termId, input.projectId) as { id: string; term: string; heard: string | null; note: string | null } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "that term is not in the project");
    const term = input.term ?? row.term;
    const clash = this.store.sqlite.prepare("SELECT id FROM project_terms WHERE project_id = ? AND term = ? AND id <> ?").get(input.projectId, term, input.termId);
    if (clash) throw new MangaError("VALIDATION_ERROR", "the project already has that term", { details: { reason: "duplicate" } });
    this.store.sqlite.prepare("UPDATE project_terms SET term = ?, heard = ?, note = ? WHERE id = ?").run(term, input.heard === undefined ? row.heard : input.heard?.trim() || null, input.note === undefined ? row.note : input.note?.trim() || null, input.termId);
    return this.terms(input.projectId).find((item) => item.id === input.termId)!;
  }

  removeTerm(projectId: string, termId: string): { projectId: string; termId: string } {
    if (!this.store.sqlite.prepare("DELETE FROM project_terms WHERE id = ? AND project_id = ?").run(termId, projectId).changes) throw new MangaError("NOT_FOUND", "that term is not in the project");
    return { projectId, termId };
  }

  /** Copies a work's voice-dictionary terms into the project's glossary. Terms the project already has are left as they are. */
  importWorkTerms(projectId: string, workId: string): { added: number; skipped: number } {
    this.row(projectId);
    if (!this.store.sqlite.prepare("SELECT 1 FROM works WHERE id = ?").get(workId)) throw new MangaError("NOT_FOUND", "the work does not exist");
    const rows = this.store.sqlite.prepare("SELECT term, heard FROM dictionary_terms WHERE scope = 'work' AND work_id = ? ORDER BY (source = 'manual') DESC, created_at, rowid").all(workId) as Array<{ term: string; heard: string | null }>;
    let added = 0;
    let skipped = 0;
    this.store.sqlite.transaction(() => {
      const have = new Set((this.store.sqlite.prepare("SELECT term FROM project_terms WHERE project_id = ?").all(projectId) as Array<{ term: string }>).map((row) => row.term));
      const room = MAX_TERMS - have.size;
      for (const row of rows) {
        if (have.has(row.term) || added >= room) { skipped += 1; continue; }
        this.store.sqlite.prepare("INSERT INTO project_terms(id, project_id, term, heard, note, created_at) VALUES (?,?,?,?,NULL,?)").run(createId("ptm"), projectId, row.term, row.heard, new Date().toISOString());
        have.add(row.term);
        added += 1;
      }
    })();
    return { added, skipped };
  }

  /** The text connection the project asks for, if it still exists and is a text connection. */
  modelConnectionOf(projectId: string): string | null {
    const row = this.store.sqlite.prepare("SELECT p.model_connection_id AS id FROM projects p JOIN provider_connections c ON c.id = p.model_connection_id WHERE p.id = ? AND c.purpose = 'text'").get(projectId) as { id: string } | undefined;
    return row?.id ?? null;
  }
}
