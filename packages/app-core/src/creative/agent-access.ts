import { MangaError, type CommandEnvelope, type ScopeGrant } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import type { GrantRegistry } from "../grants.ts";
import type { ProjectService } from "./projects.ts";

/**
 * What an agent may do with the creative workspace (A-73). Only a conversation of a project reaches these commands, and only the project's own
 * objects: a call that names another project, or an object that is not the project's, is refused here, in the command layer, not only left out of
 * the tool list. Writes are the ones the person can take back (the board's or map's own undo, removing a material or a term, discarding a suggestion);
 * deleting, renaming, packages, rough cuts, semantic search, fetching pages, plugins and downloads stay with the owner.
 */
export const AGENT_PROJECT_READS = [
  "project.list", "project.get", "project.objects", "project.terms",
  "whiteboard.list", "whiteboard.get", "mindmap.list", "mindmap.get", "draft.list", "draft.get", "draft.version",
  "roughcut.list", "roughcut.get", "research.search", "excerpt.list", "excerpt.get", "webpage.list", "webpage.get",
] as const;
export const AGENT_PROJECT_WRITES = ["whiteboard.edit", "mindmap.edit", "project.addMaterial", "project.addTerm", "draft.suggest"] as const;
export const AGENT_PROJECT_COMMANDS: readonly string[] = [...AGENT_PROJECT_READS, ...AGENT_PROJECT_WRITES];

/** The writes that are worth a line in the operation log when an agent makes them (the person's own edits of a board are too frequent to log). */
export const AGENT_LOGGED_COMMANDS: Readonly<Record<string, string>> = { "whiteboard.edit": "canvas", "mindmap.edit": "canvas", "project.addTerm": "projects" };

/** The label an agent's edit carries in the undo list of a board or map, so the person sees whose step they are taking back. */
export const AGENT_EDIT_LABEL = "Agent：";

/** A reply is part of the model's context: it is cut to what fits, never allowed to end the task for being too large. */
export const AGENT_RESULT_CHARS = 8000;

/** What the model is not told about: a suggestion by an agent is its own text, with no model asked and no quoted sources. */
const HIDDEN_PARAMETERS: Record<string, string[]> = { "draft.suggest": ["connectionId", "redoOf", "sources"], "project.addMaterial": ["origin"] };
/** What the task supplies for every command that takes it: the context the conversation runs in. The model never has to say it, and what it says is replaced. */
const TASK_PARAMETERS = ["contextId"];
const REQUIRED_PARAMETERS: Record<string, string[]> = { "draft.suggest": ["text"] };

/**
 * The parameters a project's agent is shown for a command: the project is the task's own, so it is not asked for (see `taskProject`), and a
 * command that has options an agent may not use does not list them.
 */
export function agentToolSchema(commandId: string, schema: Record<string, unknown>): Record<string, unknown> {
  const project = AGENT_PROJECT_COMMANDS.includes(commandId);
  if (!project && !takesContext(schema)) return schema;
  const hidden = new Set([...TASK_PARAMETERS, ...(project ? ["projectId", ...(HIDDEN_PARAMETERS[commandId] ?? [])] : [])]);
  const properties = Object.fromEntries(Object.entries((schema.properties ?? {}) as Record<string, unknown>).filter(([key]) => !hidden.has(key)));
  const required = [...new Set([...((schema.required as string[] | undefined) ?? []).filter((key) => !hidden.has(key)), ...(project ? REQUIRED_PARAMETERS[commandId] ?? [] : [])])];
  const { required: _all, ...rest } = schema;
  return { ...rest, properties, ...(required.length ? { required } : {}) };
}

/** Whether a command takes the context of the conversation (a project or "最近"), from its own input schema. */
export function takesContext(schema: Record<string, unknown> | undefined): boolean {
  return Boolean(schema && typeof schema.properties === "object" && schema.properties && "contextId" in schema.properties);
}

/** Whether a command takes a project at all, from its own input schema. */
export function takesProject(schema: Record<string, unknown> | undefined): boolean {
  return Boolean(schema && typeof schema.properties === "object" && schema.properties && "projectId" in schema.properties);
}

export type AgentRule = {
  /** Refuses what is outside the task's project, and may fill in or narrow the input. */
  check: (envelope: CommandEnvelope, projectId: string, grant: ScopeGrant) => void;
  /** Cuts what comes back down to the project; `asked` is the input as the model gave it. */
  shape?: (value: unknown, projectId: string, asked: Record<string, unknown>) => unknown;
};

type Input = Record<string, unknown>;
type Kind = "whiteboard" | "mindmap" | "draft" | "roughcut" | "excerpt";

const TABLE: Record<Kind, string> = { whiteboard: "whiteboards", mindmap: "mindmaps", draft: "drafts", roughcut: "rough_cuts", excerpt: "excerpts" };
/** The material kinds an agent may add to a project: what it can already see, or what the project already holds. */
const MATERIAL_KINDS = new Set(["note", "resource", "excerpt"]);

const denied = (message: string, reason: string) => new MangaError("SCOPE_DENIED", message, { details: { reason } });
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export class AgentProjectAccess {
  private readonly store: DrizzleStore;
  private readonly projects: ProjectService;
  private readonly grants: GrantRegistry;
  private readonly rules: Record<string, AgentRule>;

  constructor(store: DrizzleStore, projects: ProjectService, grants: GrantRegistry) {
    this.store = store;
    this.projects = projects;
    this.grants = grants;
    const same: AgentRule = { check: (envelope, projectId) => this.same(envelope, projectId) };
    const fill: AgentRule = { check: (envelope, projectId) => this.fill(envelope, projectId) };
    const readOf = (kind: Kind, key: string): AgentRule => ({ check: (envelope, projectId) => this.reach(kind, text(this.input(envelope)[key]), projectId, "read") });
    this.rules = {
      "project.list": { check: () => undefined, shape: (value, projectId) => ({ ...(value as object), projects: ((value as { projects: Array<{ id: string }> }).projects ?? []).filter((item) => item.id === projectId) }) },
      "project.get": same,
      "project.objects": same,
      "project.terms": same,
      "project.addMaterial": {
        check: (envelope, projectId, grant) => {
          this.same(envelope, projectId);
          // What an agent adds is its own addition; only opening or making something in the project adds automatically.
          if (this.input(envelope).origin !== undefined) throw new MangaError("FORBIDDEN", "a material added by an agent does not take origin", { details: { reason: "agent-option" } });
          this.material(this.input(envelope), projectId, grant);
        },
      },
      "project.addTerm": {
        check: (envelope, projectId) => {
          this.same(envelope, projectId);
          // A term that is there stays as the person wrote it: adding it again would change it, and taking that back would remove it.
          if (this.projects.terms(projectId).some((item) => item.term === text(this.input(envelope).term).trim())) throw new MangaError("VALIDATION_ERROR", "the project already has that term", { details: { reason: "exists" } });
        },
      },
      "whiteboard.list": fill,
      "whiteboard.get": readOf("whiteboard", "boardId"),
      "whiteboard.edit": {
        check: (envelope, projectId, grant) => {
          const input = this.input(envelope);
          this.reach("whiteboard", text(input.boardId), projectId, "write");
          for (const action of (input.actions as Array<Input> | undefined) ?? []) {
            if (action.type === "addNode" && action.kind === "ref") this.reference(action.data as Input | undefined, projectId, grant);
            if (action.type === "updateNode" && action.data && typeof action.data === "object" && ("refKind" in (action.data as Input) || "targetId" in (action.data as Input))) this.reference(action.data as Input, projectId, grant);
          }
          this.labelled(input);
        },
      },
      "mindmap.list": fill,
      "mindmap.get": readOf("mindmap", "mapId"),
      "mindmap.edit": {
        check: (envelope, projectId, grant) => {
          const input = this.input(envelope);
          this.reach("mindmap", text(input.mapId), projectId, "write");
          for (const action of (input.actions as Array<Input> | undefined) ?? []) if (action.type === "addRef") this.holds(text(action.kind), text(action.targetId), projectId, grant);
          this.labelled(input);
        },
      },
      "draft.list": fill,
      "draft.get": readOf("draft", "draftId"),
      "draft.version": readOf("draft", "draftId"),
      "draft.suggest": {
        check: (envelope, projectId) => {
          const input = this.input(envelope);
          this.reach("draft", text(input.draftId), projectId, "write");
          // The agent writes the suggestion itself: asking a model would be a second, paid call that nobody authorized, and a quoted source is a read outside the task's scope.
          if (typeof input.text !== "string" || !input.text.trim()) throw new MangaError("VALIDATION_ERROR", "write the suggestion itself: give its text", { details: { reason: "text" } });
          for (const key of ["connectionId", "redoOf", "sources"]) if (input[key] !== undefined) throw new MangaError("FORBIDDEN", `a suggestion by an agent does not take ${key}`, { details: { reason: "agent-option" } });
        },
      },
      "roughcut.list": fill,
      "roughcut.get": readOf("roughcut", "cutId"),
      "research.search": {
        check: (envelope, projectId) => { this.fill(envelope, projectId); this.input(envelope).limit = 100; },
        shape: (value, _projectId, asked) => {
          const found = value as { results: Array<{ kind: string; inProject?: boolean }>; counts: Record<string, number> };
          // The search looks through the whole library and marks what the project holds; an agent of a project sees only that, and never the saved pages.
          const results = found.results.filter((item) => item.kind !== "page" && item.inProject === true).slice(0, typeof asked.limit === "number" ? asked.limit : 30);
          const counts = Object.fromEntries(Object.keys(found.counts).map((kind) => [kind, results.filter((item) => item.kind === kind).length]));
          return { ...found, results, counts };
        },
      },
      "excerpt.list": fill,
      "excerpt.get": readOf("excerpt", "excerptId"),
      "webpage.list": {
        check: (envelope) => { this.input(envelope).limit = 500; },
        shape: (value, projectId, asked) => {
          const urls = this.pageUrls(projectId);
          return { ...(value as object), pages: ((value as { pages: Array<{ url: string }> }).pages ?? []).filter((page) => urls.has(page.url)).slice(0, typeof asked.limit === "number" ? asked.limit : 100) };
        },
      },
      "webpage.get": {
        check: (envelope, projectId) => {
          const row = this.store.sqlite.prepare("SELECT url FROM excerpt_pages WHERE id = ?").get(text(this.input(envelope).pageId)) as { url: string } | undefined;
          if (!row) throw new MangaError("NOT_FOUND", "the page does not exist");
          if (!this.pageUrls(projectId).has(row.url)) throw denied("that page is not part of this project", "outside-project");
        },
        shape: (value, projectId) => {
          const page = value as { excerpts?: Array<{ id: string; projectId: string | null }> };
          return { ...page, excerpts: (page.excerpts ?? []).filter((excerpt) => excerpt.projectId === projectId || this.referenced("excerpt", excerpt.id, projectId)) };
        },
      },
    };
  }

  /** The rule for a command an agent of a project may use; none for any other. */
  rule(commandId: string): AgentRule | undefined {
    return this.rules[commandId];
  }

  /** The project a task belongs to, from the conversation it runs in; a task of any other conversation has none. */
  projectOf(grant: ScopeGrant): string {
    const row = grant.sessionId ? this.store.sqlite.prepare("SELECT project_id AS projectId FROM agent_sessions WHERE id = ?").get(grant.sessionId) as { projectId: string | null } | undefined : undefined;
    if (!row?.projectId || !this.projects.exists(row.projectId)) throw denied("this task does not belong to a project", "no-project");
    return row.projectId;
  }

  /** The context a task runs in: the project its conversation belongs to, or null for "最近". */
  contextOf(grant: ScopeGrant): string | null {
    const row = grant.sessionId ? this.store.sqlite.prepare("SELECT project_id AS projectId FROM agent_sessions WHERE id = ?").get(grant.sessionId) as { projectId: string | null } | undefined : undefined;
    return row?.projectId && this.projects.exists(row.projectId) ? row.projectId : null;
  }

  /** The reply, cut to what the model can be given: long text is shortened and long lists lose their tail, each saying so. */
  fit(value: unknown): unknown {
    for (const [chars, items] of [[4000, 80], [1500, 40], [600, 20], [300, 10]] as const) {
      const cut = cutDeep(value, chars, items);
      if (JSON.stringify(cut).length <= AGENT_RESULT_CHARS) return cut;
    }
    throw new MangaError("VALIDATION_ERROR", "the result is too large to give; ask for something narrower", { details: { reason: "result-too-large" } });
  }

  private input(envelope: CommandEnvelope): Input {
    return (envelope.input ?? {}) as Input;
  }

  /** A call that names a project names this one, or none. */
  private same(envelope: CommandEnvelope, projectId: string): void {
    const named = this.input(envelope).projectId;
    if (named !== undefined && named !== projectId) throw denied("that project is not the one this task belongs to", "cross-project");
  }

  /** Lists default to the task's project; naming another is refused. */
  private fill(envelope: CommandEnvelope, projectId: string): void {
    this.same(envelope, projectId);
    this.input(envelope).projectId = projectId;
  }

  private referenced(kind: string, id: string, projectId: string): boolean {
    return Boolean(this.store.sqlite.prepare("SELECT 1 FROM project_materials WHERE project_id = ? AND kind = ? AND target_id = ?").get(projectId, kind, id));
  }

  /** An object is the project's when it was made in it; it is also readable when the project holds a reference to it. */
  private reach(kind: Kind, id: string, projectId: string, mode: "read" | "write"): void {
    const row = this.store.sqlite.prepare(`SELECT project_id AS projectId FROM ${TABLE[kind]} WHERE id = ?`).get(id) as { projectId: string | null } | undefined;
    if (!row) throw new MangaError("NOT_FOUND", `that ${kind} does not exist`);
    if (row.projectId === projectId) return;
    if (mode === "read" && this.referenced(kind, id, projectId)) return;
    throw denied(`that ${kind} is not part of this project`, "outside-project");
  }

  private material(input: Input, projectId: string, grant: ScopeGrant): void {
    const kind = text(input.kind);
    const id = text(input.targetId);
    if (!MATERIAL_KINDS.has(kind)) throw denied(`a task cannot add ${kind} to a project`, "material-kind");
    if (!this.holds(kind, id, projectId, grant)) throw denied("that material is outside this task", "outside-task");
  }

  /** Whether the task can already see the thing: a resource it may read, a note it wrote or the project holds, or something the project holds. */
  private holds(kind: string, id: string, projectId: string, grant: ScopeGrant): boolean {
    const found = kind === "resource" ? this.grants.canRead(grant, id)
      : kind === "note" ? this.grants.canWriteObject(grant, id) || this.projects.scopeNoteIds(projectId).includes(id)
        : Object.hasOwn(TABLE, kind) ? this.ownedOrHeld(kind as Kind, id, projectId)
          : this.referenced(kind, id, projectId);
    if (!found) throw denied("that is outside this project", "outside-task");
    return true;
  }

  private ownedOrHeld(kind: Kind, id: string, projectId: string): boolean {
    const row = this.store.sqlite.prepare(`SELECT project_id AS projectId FROM ${TABLE[kind]} WHERE id = ?`).get(id) as { projectId: string | null } | undefined;
    return row?.projectId === projectId || this.referenced(kind, id, projectId);
  }

  /** A reference node of a board points only at what the task can see. */
  private reference(data: Input | undefined, projectId: string, grant: ScopeGrant): void {
    if (!data) return;
    const kind = text(data.refKind);
    const id = text(data.targetId);
    if (kind || id) this.holds(kind, id, projectId, grant);
  }

  /** The agent's edit shows as the agent's in the undo list. */
  private labelled(input: Input): void {
    const first = (input.actions as Array<{ type?: string }> | undefined)?.[0]?.type ?? "edit";
    input.label = `${AGENT_EDIT_LABEL}${text(input.label) || first}`.slice(0, 80);
  }

  /** The addresses of the pages the project took excerpts from (its own, or ones it holds a reference to). */
  private pageUrls(projectId: string): Set<string> {
    const rows = this.store.sqlite.prepare(`SELECT DISTINCT p.url AS url FROM excerpts e JOIN excerpt_pages p ON p.id = e.page_id
      WHERE e.project_id = ? OR e.id IN (SELECT target_id FROM project_materials WHERE project_id = ? AND kind = 'excerpt')`).all(projectId, projectId) as Array<{ url: string }>;
    return new Set(rows.map((row) => row.url));
  }
}

/** Long strings and long lists cut to the given sizes, each saying what was left out. */
function cutDeep(value: unknown, chars: number, items: number): unknown {
  if (typeof value === "string") return value.length > chars ? `${value.slice(0, chars)}…（已截短，共 ${value.length} 字）` : value;
  if (Array.isArray(value)) {
    const kept = value.slice(0, items).map((item) => cutDeep(item, chars, items));
    return value.length > items ? [...kept, `…另有 ${value.length - items} 项未显示`] : kept;
  }
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cutDeep(item, chars, items)]));
  return value;
}
