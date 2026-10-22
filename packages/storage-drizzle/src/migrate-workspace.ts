import type Database from "better-sqlite3";
import { createId, shellFromV1, ShellPreferenceSchema, ShellPreferenceV1Schema, WORKSPACE_TAB_LIMIT, WorkspaceStateSchema, type WorkspaceState, type WorkspaceTab } from "@manga/contracts";

type SqliteDb = InstanceType<typeof Database>;

export type WorkspaceMigration = {
  /** Resource, work and note conversations that were the older of a pair in the two modes and became general conversations of "最近". */
  convertedToShared: number;
  /** Conversations of projects deleted before v12 that became general conversations of "最近". */
  fromDeletedProjects: number;
  /** Contexts that got a saved set of tabs, and the tabs in them. */
  contexts: number;
  tabs: number;
  /** The context the person is brought back to on the first start. */
  lastContext: string | null;
};

type SessionRow = { id: string; title: string; kind: string; target_id: string | null; mode: string | null; project_id: string | null; updated_at: string };

const MODE_NAME: Record<string, string> = { creator: "工作模式", enthusiast: "娱乐模式" };

const tableExists = (sqlite: SqliteDb, name: string): boolean => Boolean(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/**
 * Schema v12 for data that SQL alone cannot convert (A-94, plan 4.8): conversations, the shell preference and the first set of tabs. It is run inside the
 * migration transaction, after the tables are rebuilt, and can be run again on the same data: every step either writes the same result or leaves what
 * is there. A profile that never had a session or a shell preference gets nothing written.
 */
export function migrateWorkspace(sqlite: SqliteDb): WorkspaceMigration {
  const sessions = sqlite.prepare("SELECT id, title, kind, target_id, mode, project_id, updated_at FROM agent_sessions ORDER BY updated_at DESC, rowid DESC").all() as SessionRow[];
  const closed = new Set(tableExists(sqlite, "closed_sessions")
    ? (sqlite.prepare("SELECT session_id FROM closed_sessions").all() as Array<{ session_id: string }>).map((row) => row.session_id)
    : []);
  const projects = new Map((sqlite.prepare("SELECT id, name, status, updated_at FROM projects").all() as Array<{ id: string; name: string; status: string; updated_at: string }>).map((row) => [row.id, row]));

  // What was open on the left rail, read before the sessions are changed: a resource or a project counts as open when any of its conversations was not closed.
  const openResources: Array<{ id: string; at: string }> = [];
  const openProjects: Array<{ id: string; at: string }> = [];
  for (const row of sessions) {
    if (closed.has(row.id) || !row.target_id) continue;
    if (row.kind === "resource" && !openResources.some((item) => item.id === row.target_id)) openResources.push({ id: row.target_id, at: row.updated_at });
    if (row.kind === "project" && projects.has(row.target_id) && !openProjects.some((item) => item.id === row.target_id)) openProjects.push({ id: row.target_id, at: row.updated_at });
  }

  // Conversations. A project conversation belongs to its project; everything else belongs to "最近" (project_id empty). Deleting a project before v12
  // left its own conversation pointing at it; that one becomes a general conversation of "最近", as deleting a project does now.
  const update = sqlite.prepare("UPDATE agent_sessions SET project_id = ? WHERE id = ?");
  const orphan = sqlite.prepare("UPDATE agent_sessions SET kind = 'shared', target_id = NULL, project_id = NULL WHERE id = ?");
  let fromDeletedProjects = 0;
  for (const row of sessions) {
    const next = row.kind === "project" ? (row.project_id || row.target_id || null) : null;
    if (row.kind === "project" && !(next && projects.has(next))) { orphan.run(row.id); fromDeletedProjects += 1; continue; }
    if (next !== (row.project_id || null)) update.run(next, row.id);
  }
  // The same resource, work or note could have a conversation in each mode. The newer stays as the conversation of the target; the older becomes a general
  // conversation of "最近" that says which mode it came from. Runs, messages and tool events are not touched.
  const seen = new Set<string>();
  let convertedToShared = 0;
  const convert = sqlite.prepare("UPDATE agent_sessions SET kind = 'shared', target_id = NULL, title = ? WHERE id = ?");
  for (const row of sessions) {
    if (!row.target_id || !["resource", "work", "note"].includes(row.kind)) continue;
    const key = `${row.kind}\u0000${row.target_id}`;
    if (!seen.has(key)) { seen.add(key); continue; }
    const suffix = `（原${MODE_NAME[row.mode === "creator" ? "creator" : "enthusiast"]}）`;
    convert.run(row.title.endsWith(suffix) ? row.title : `${row.title}${suffix}`, row.id);
    convertedToShared += 1;
  }

  // The current general conversation of "最近": of the two modes' current ones, the newer. Every project's current one is its newest conversation.
  const metaGet = sqlite.prepare("SELECT value FROM schema_meta WHERE key = ?");
  const metaSet = sqlite.prepare("INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const stamp = sqlite.prepare("SELECT updated_at FROM agent_sessions WHERE id = ? AND kind = 'shared'");
  const recorded = ["enthusiast", "creator"].flatMap((mode) => {
    const id = (metaGet.get(`conversation.current.${mode}`) as { value: string } | undefined)?.value;
    const row = id ? stamp.get(id) as { updated_at: string } | undefined : undefined;
    return id && row ? [{ id, at: row.updated_at }] : [];
  }).sort((a, b) => b.at.localeCompare(a.at));
  if (recorded[0] && !metaGet.get("conversation.current.recent")) metaSet.run("conversation.current.recent", recorded[0].id);
  const newestOfProject = sqlite.prepare("SELECT id FROM agent_sessions WHERE kind = 'project' AND project_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1");
  for (const project of projects.values()) {
    const row = newestOfProject.get(project.id) as { id: string } | undefined;
    if (row && !metaGet.get(`conversation.current.project.${project.id}`)) metaSet.run(`conversation.current.project.${project.id}`, row.id);
  }
  sqlite.prepare("DELETE FROM schema_meta WHERE key IN ('conversation.current.enthusiast', 'conversation.current.creator')").run();

  // The shell preference: the columns of the entertainment mode become the sidebar and the dock; the person comes back to the project they were
  // in when they left in the work mode, otherwise to "最近".
  const shellRow = sqlite.prepare("SELECT revision, value_json FROM config WHERE key = 'shell.layout'").get() as { revision: number; value_json: string } | undefined;
  let lastContext: string | null = null;
  if (shellRow) {
    let json: unknown = null;
    try { json = JSON.parse(shellRow.value_json); } catch { json = null; }
    const old = ShellPreferenceV1Schema.safeParse(json);
    if (old.success) {
      if (old.data.mode === "creator") {
        lastContext = [...projects.values()].filter((project) => project.status === "active").sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]?.id ?? null;
      }
      const next = shellFromV1(old.data, lastContext);
      sqlite.prepare("UPDATE config SET revision = revision + 1, value_json = ? WHERE key = 'shell.layout'").run(JSON.stringify(next));
    } else {
      const current = ShellPreferenceSchema.safeParse(json);
      if (current.success) lastContext = current.data.lastContext;
    }
  }

  // The first set of tabs of each context. Nothing already saved is replaced.
  const resourceTitle = sqlite.prepare("SELECT title, kind FROM resources WHERE id = ?");
  const tab = (kind: string, target: Record<string, unknown>, title: string): WorkspaceTab => ({ id: createId("tab"), kind, target, title: title.slice(0, 200), view: {} });
  const states = new Map<string, WorkspaceState>();
  const recentTabs: WorkspaceTab[] = [];
  for (const item of openResources) {
    const row = resourceTitle.get(item.id) as { title: string; kind: string } | undefined;
    // Only what a reader can show becomes a tab; the conversation of the rest stays, and the resource opens from its work.
    if (row && ["novel", "comic", "video"].includes(row.kind) && recentTabs.length < WORKSPACE_TAB_LIMIT) recentTabs.push(tab("reader", { resourceId: item.id, mediaKind: row.kind }, row.title));
  }
  const single = (tabs: WorkspaceTab[]): WorkspaceState => WorkspaceStateSchema.parse({ version: 1, preset: "single", layout: null, tabs, focusedTab: tabs[0]?.id ?? null, closed: [] });
  if (recentTabs.length) states.set("", single(recentTabs));
  for (const item of openProjects) {
    const project = projects.get(item.id)!;
    states.set(project.id, single([tab("project", { projectId: project.id }, project.name)]));
  }
  const insert = sqlite.prepare("INSERT OR IGNORE INTO workspace_contexts(context_id, state_json, updated_at) VALUES (?, ?, ?)");
  const now = new Date().toISOString();
  let tabs = 0;
  let contexts = 0;
  for (const [contextId, state] of states) {
    if (insert.run(contextId, JSON.stringify(state), now).changes) { contexts += 1; tabs += state.tabs.length; }
  }
  if (tableExists(sqlite, "closed_sessions")) sqlite.exec("DROP TABLE closed_sessions");
  return { convertedToShared, fromDeletedProjects, contexts, tabs, lastContext };
}
