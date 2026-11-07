import {
  EMPTY_WORKSPACE_STATE, MangaError, WorkspaceStateSchema, contextKey, dropLegacyTabs, trimWorkspaceState,
  type ContextId, type WorkspaceContext, type WorkspaceState,
} from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";

type StateRow = { context_id: string; state_json: string; updated_at: string };

/**
 * The saved tabs and split layout of each context (A-94). A context is a project or "最近"; each has one row. What is stored is validated when it is
 * saved and again when it is read: a row that no longer parses (damaged by hand, or written by a build that made a different shape) is answered with
 * the empty state and left where it is until the next save replaces it, so reading never destroys anything. Unknown tab kinds and unknown fields
 * inside a tab pass through unchanged.
 */
export class WorkspaceService {
  private readonly store: DrizzleStore;

  constructor(store: DrizzleStore) {
    this.store = store;
  }

  private assertContext(contextId: ContextId): void {
    if (contextId && !this.store.sqlite.prepare("SELECT 1 FROM projects WHERE id = ?").get(contextId)) throw new MangaError("NOT_FOUND", "the project does not exist");
  }

  private parse(row: StateRow | undefined): { state: WorkspaceState; damaged: boolean } {
    if (!row) return { state: structuredClone(EMPTY_WORKSPACE_STATE), damaged: false };
    try {
      const parsed = WorkspaceStateSchema.safeParse(JSON.parse(row.state_json));
      // The tabs of the kinds that are gone (search, settings, plugins, shortcuts) are not given back; the row keeps them until the next save replaces it.
      if (parsed.success) return { state: dropLegacyTabs(parsed.data).state, damaged: false };
    } catch { /* fall through to the empty state */ }
    return { state: structuredClone(EMPTY_WORKSPACE_STATE), damaged: true };
  }

  /** "最近" and the projects with what each holds, "最近" first, then by the most recent activity. */
  contexts(includeArchived = false): { contexts: WorkspaceContext[] } {
    const sqlite = this.store.sqlite;
    const rows = new Map((sqlite.prepare("SELECT context_id, state_json, updated_at FROM workspace_contexts").all() as StateRow[]).map((row) => [row.context_id, row]));
    const conversations = new Map((sqlite.prepare("SELECT COALESCE(project_id, '') AS key, COUNT(*) AS n, MAX(updated_at) AS at FROM agent_sessions GROUP BY COALESCE(project_id, '')").all() as Array<{ key: string; n: number; at: string | null }>).map((row) => [row.key, row]));
    const describe = (key: string, kind: "recent" | "project", name: string, status: "active" | "archived", touched: string | null): WorkspaceContext => {
      const saved = rows.get(key);
      const chats = conversations.get(key);
      const latest = [touched, chats?.at ?? null, saved?.updated_at ?? null].filter((value): value is string => Boolean(value)).sort().pop() ?? null;
      return { contextId: key || null, kind, name, status, conversationCount: chats?.n ?? 0, tabCount: saved ? this.parse(saved).state.tabs.length : 0, lastActivityAt: latest };
    };
    const projects = (sqlite.prepare(`SELECT id, name, status, updated_at FROM projects ${includeArchived ? "" : "WHERE status = 'active'"} ORDER BY updated_at DESC, id`).all() as Array<{ id: string; name: string; status: "active" | "archived"; updated_at: string }>)
      .map((row) => describe(row.id, "project", row.name, row.status, row.updated_at));
    return { contexts: [describe("", "recent", "最近", "active", null), ...projects] };
  }

  load(contextId: ContextId): { contextId: ContextId; state: WorkspaceState; updatedAt: string | null; damaged: boolean } {
    this.assertContext(contextId);
    const row = this.store.sqlite.prepare("SELECT context_id, state_json, updated_at FROM workspace_contexts WHERE context_id = ?").get(contextKey(contextId)) as StateRow | undefined;
    const parsed = this.parse(row);
    return { contextId, state: parsed.state, updatedAt: row?.updated_at ?? null, damaged: parsed.damaged };
  }

  save(contextId: ContextId, state: WorkspaceState): { contextId: ContextId; trimmed: boolean; bytes: number; updatedAt: string } {
    this.assertContext(contextId);
    const cut = trimWorkspaceState(state);
    const updatedAt = new Date().toISOString();
    this.store.sqlite.prepare("INSERT INTO workspace_contexts(context_id, state_json, updated_at) VALUES (?,?,?) ON CONFLICT(context_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at")
      .run(contextKey(contextId), JSON.stringify(cut.state), updatedAt);
    return { contextId, trimmed: cut.trimmed, bytes: cut.bytes, updatedAt };
  }
}
