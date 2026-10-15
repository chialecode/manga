import { MangaError, createId, type ConversationKind } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";

export type ConversationMode = "enthusiast" | "creator";

export type ConversationView = { sessionId: string; title: string; mode: ConversationMode; createdAt: string; updatedAt: string; runCount: number };
export type HistoryItem = ConversationView & { excerpt: string };

type Row = { id: string; title: string; mode: string | null; created_at: string; updated_at: string };

const key = (mode: ConversationMode) => `conversation.current.${mode}`;
const EXCERPT_CHARS = 80;

const stamp = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * The one global conversation of each mode (A-65). The current one is recorded in the profile's own settings; every other shared conversation
 * of the mode is its history, which is read-only until one is continued, and continuing makes it the current one. A profile from before this
 * has several shared conversations and no record: the most recent becomes the current one on first use and the rest are history. Nothing is deleted.
 */
export class ConversationService {
  private readonly store: DrizzleStore;

  constructor(store: DrizzleStore) {
    this.store = store;
  }

  private shared(mode: ConversationMode): Row[] {
    return this.store.sqlite.prepare("SELECT id, title, mode, created_at, updated_at FROM agent_sessions WHERE kind = 'shared' AND COALESCE(mode, 'enthusiast') = ? ORDER BY updated_at DESC, rowid DESC").all(mode) as Row[];
  }

  private view(row: Row, mode: ConversationMode): ConversationView {
    const runs = this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ?").get(row.id) as { n: number };
    return { sessionId: row.id, title: row.title, mode, createdAt: row.created_at, updatedAt: row.updated_at, runCount: runs.n };
  }

  /** The current conversation of the mode, or null when there is none yet. */
  current(mode: ConversationMode): ConversationView | null {
    const rows = this.shared(mode);
    const recorded = this.store.getMeta(key(mode));
    const row = rows.find((item) => item.id === recorded) ?? rows[0];
    if (!row) return null;
    if (row.id !== recorded) this.store.setMeta(key(mode), row.id);
    return this.view(row, mode);
  }

  /**
   * Starts a new current conversation. The one that was current moves into the history as it is. A conversation that has no messages yet
   * is reused instead, so pressing the button twice does not leave an empty conversation in the history.
   */
  start(mode: ConversationMode, grantHandle: string): ConversationView & { reused: boolean } {
    const current = this.current(mode);
    if (current && current.runCount === 0) return { ...current, reused: true };
    const id = createId("ses");
    const now = new Date().toISOString();
    const title = `对话 ${stamp(new Date())}`;
    this.store.sqlite.transaction(() => {
      this.store.sqlite.prepare("INSERT INTO agent_sessions(id, title, grant_handle, kind, target_id, mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, title, grantHandle, "shared", null, mode, now, now);
      this.store.setMeta(key(mode), id);
    })();
    return { sessionId: id, title, mode, createdAt: now, updatedAt: now, runCount: 0, reused: false };
  }

  /** The other conversations of the mode, newest first, each with the start of what was said first. */
  history(mode: ConversationMode, limit = 50): { current: string | null; items: HistoryItem[] } {
    const current = this.current(mode);
    const rows = this.shared(mode).filter((row) => row.id !== current?.sessionId).slice(0, limit);
    const first = this.store.sqlite.prepare(`SELECT m.text AS text FROM agent_messages m JOIN agent_runs r ON r.id = m.run_id
      WHERE r.session_id = ? AND m.role = 'user' ORDER BY r.created_at, m.rowid LIMIT 1`);
    return {
      current: current?.sessionId ?? null,
      items: rows.map((row) => {
        const text = (first.get(row.id) as { text: string } | undefined)?.text ?? "";
        const clean = text.replace(/\s+/g, " ").trim();
        return { ...this.view(row, mode), excerpt: [...clean].length > EXCERPT_CHARS ? `${[...clean].slice(0, EXCERPT_CHARS).join("")}…` : clean };
      }),
    };
  }

  /** Continue a conversation from the history: it becomes the current one. */
  resume(sessionId: string): ConversationView {
    const row = this.store.sqlite.prepare("SELECT id, title, mode, created_at, updated_at, kind FROM agent_sessions WHERE id = ?").get(sessionId) as (Row & { kind: string }) | undefined;
    if (!row) throw new MangaError("NOT_FOUND", "the conversation does not exist");
    if (row.kind !== "shared") throw new MangaError("VALIDATION_ERROR", "only a general conversation can be continued from the history", { details: { reason: "kind" } });
    const mode: ConversationMode = row.mode === "creator" ? "creator" : "enthusiast";
    this.store.setMeta(key(mode), row.id);
    this.store.sqlite.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    return this.view({ ...row, updated_at: new Date().toISOString() }, mode);
  }

  // ---------------------------------------------------------------------------------------------------- the records page (A-89)

  private recordWhere(filter: ConversationFilter): { where: string; params: Array<string | number> } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.mode) { where.push("COALESCE(s.mode, 'enthusiast') = ?"); params.push(filter.mode); }
    if (filter.kind) { where.push("s.kind = ?"); params.push(filter.kind); }
    if (filter.after) { where.push(`${LAST_AT} >= ?`); params.push(filter.after); }
    if (filter.before) { where.push(`${LAST_AT} < ?`); params.push(filter.before); }
    if (filter.q) {
      where.push(`(s.title LIKE ? ESCAPE '\\' OR ${OWNER_TITLE} LIKE ? ESCAPE '\\')`);
      const needle = `%${filter.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      params.push(needle, needle);
    }
    return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
  }

  /**
   * Every conversation there is, newest activity first (the settings "records" page): the general ones of each mode, and the ones bound to a resource,
   * a work, a project or a note. A conversation closed from the left rail is still here; closing only takes it off the rail.
   */
  list(filter: ConversationFilter & { limit?: number; offset?: number } = {}, isLive: LiveRun = () => false): { items: ConversationRecord[]; total: number } {
    const { where, params } = this.recordWhere(filter);
    const total = (this.store.sqlite.prepare(`SELECT COUNT(*) AS n FROM agent_sessions s ${where}`).get(...params) as { n: number }).n;
    const limit = Math.min(100, filter.limit ?? 30);
    const rows = this.store.sqlite.prepare(`SELECT s.id AS id, s.title AS title, s.kind AS kind, s.mode AS mode, s.target_id AS targetId, s.created_at AS createdAt,
        ${LAST_AT} AS lastAt, ${OWNER_TITLE} AS ownerTitle, (SELECT COUNT(*) FROM agent_runs r WHERE r.session_id = s.id) AS runCount
      FROM agent_sessions s ${where} ORDER BY lastAt DESC, s.rowid DESC LIMIT ? OFFSET ?`).all(...params, limit, filter.offset ?? 0) as Array<{
      id: string; title: string; kind: string; mode: string | null; targetId: string | null; createdAt: string; lastAt: string; ownerTitle: string | null; runCount: number;
    }>;
    const first = this.store.sqlite.prepare(`SELECT m.text AS text FROM agent_messages m JOIN agent_runs r ON r.id = m.run_id
      WHERE r.session_id = ? AND m.role = 'user' ORDER BY r.created_at, m.rowid LIMIT 1`);
    const active = this.store.sqlite.prepare("SELECT id FROM agent_runs WHERE session_id = ? AND status IN ('queued','running','waiting_input')");
    const currentOf = { enthusiast: this.store.getMeta(key("enthusiast")), creator: this.store.getMeta(key("creator")) };
    const items = rows.map((row): ConversationRecord => {
      const mode: ConversationMode = row.mode === "creator" ? "creator" : "enthusiast";
      const text = ((first.get(row.id) as { text: string } | undefined)?.text ?? "").replace(/\s+/g, " ").trim();
      return {
        sessionId: row.id, title: row.title, kind: row.kind as ConversationKind, mode, targetId: row.targetId, ownerTitle: row.ownerTitle,
        runCount: row.runCount, createdAt: row.createdAt, lastAt: row.lastAt,
        excerpt: [...text].length > EXCERPT_CHARS ? `${[...text].slice(0, EXCERPT_CHARS).join("")}…` : text,
        current: row.kind === "shared" && currentOf[mode] === row.id,
        running: (active.all(row.id) as Array<{ id: string }>).some((run) => isLive(run.id)),
      };
    });
    return { items, total };
  }

  /** The ids of the conversations a filter matches, for "delete all". */
  idsMatching(filter: ConversationFilter): string[] {
    const { where, params } = this.recordWhere(filter);
    return (this.store.sqlite.prepare(`SELECT s.id AS id FROM agent_sessions s ${where}`).all(...params) as Array<{ id: string }>).map((row) => row.id);
  }

  /**
   * Deletes conversations with everything that belongs to them (A-89): the runs, the messages, the tool events, the record of what was sent to the
   * models, the checkpoints and the frozen material that live in the run, the authorization each run was given, and the mark that it was closed.
   * What the agent wrote into the library (notes, boards, drafts) is not part of a conversation and stays. A conversation with a task in progress
   * is left alone and reported: a task that is still writing would bring its rows back. If the current conversation of a mode goes, a new one takes
   * its place, so the person is never left with none.
   */
  remove(sessionIds: string[], grantHandle: string, isLive: LiveRun = () => false): ConversationRemoval {
    const unique = [...new Set(sessionIds)];
    const sqlite = this.store.sqlite;
    const exists = sqlite.prepare("SELECT id, kind, mode FROM agent_sessions WHERE id = ?");
    const runsOf = sqlite.prepare("SELECT id FROM agent_runs WHERE session_id = ?");
    const found: Array<{ id: string; kind: string; mode: ConversationMode }> = [];
    const skipped: ConversationRemoval["skipped"] = [];
    for (const id of unique) {
      const row = exists.get(id) as { id: string; kind: string; mode: string | null } | undefined;
      if (!row) { skipped.push({ sessionId: id, reason: "missing" }); continue; }
      if ((runsOf.all(id) as Array<{ id: string }>).some((run) => isLive(run.id))) { skipped.push({ sessionId: id, reason: "running" }); continue; }
      found.push({ id, kind: row.kind, mode: row.mode === "creator" ? "creator" : "enthusiast" });
    }
    const counts = { sessions: 0, runs: 0, messages: 0, toolEvents: 0, requests: 0, grants: 0 };
    const replaced: Partial<Record<ConversationMode, ConversationView>> = {};
    sqlite.transaction(() => {
      for (const item of found) {
        for (const run of runsOf.all(item.id) as Array<{ id: string }>) {
          counts.messages += sqlite.prepare("DELETE FROM agent_messages WHERE run_id = ?").run(run.id).changes;
          counts.toolEvents += sqlite.prepare("DELETE FROM agent_tool_events WHERE run_id = ?").run(run.id).changes;
          counts.requests += sqlite.prepare("DELETE FROM agent_requests WHERE run_id = ?").run(run.id).changes;
          // The authorization a task was given names what it could read; it goes with the task. The owner's own authorization is never touched.
          counts.grants += sqlite.prepare("DELETE FROM grants WHERE run_id = ? AND access <> 'owner'").run(run.id).changes;
          sqlite.prepare("DELETE FROM command_requests WHERE run_id = ?").run(run.id);
        }
        counts.runs += sqlite.prepare("DELETE FROM agent_runs WHERE session_id = ?").run(item.id).changes;
        sqlite.prepare("DELETE FROM closed_sessions WHERE session_id = ?").run(item.id);
        counts.sessions += sqlite.prepare("DELETE FROM agent_sessions WHERE id = ?").run(item.id).changes;
      }
      for (const mode of new Set(found.filter((item) => item.kind === "shared").map((item) => item.mode))) {
        const recorded = this.store.getMeta(key(mode));
        if (recorded && !exists.get(recorded)) {
          this.store.setMeta(key(mode), "");
          const started = this.start(mode, grantHandle);
          replaced[mode] = { sessionId: started.sessionId, title: started.title, mode, createdAt: started.createdAt, updatedAt: started.updatedAt, runCount: 0 };
        }
      }
    })();
    return { removed: found.map((item) => item.id), skipped, counts, replaced };
  }
}

export type ConversationFilter = { mode?: ConversationMode; kind?: ConversationKind; after?: string; before?: string; q?: string };
export type ConversationRecord = {
  sessionId: string;
  title: string;
  kind: ConversationKind;
  mode: ConversationMode;
  targetId: string | null;
  /** The title of what a bound conversation is about: the resource, the work, the project or the note. */
  ownerTitle: string | null;
  runCount: number;
  createdAt: string;
  lastAt: string;
  excerpt: string;
  /** The general conversation the right pane shows for its mode. */
  current: boolean;
  /** A task of this conversation is in progress, so it cannot be deleted now. */
  running: boolean;
};
export type ConversationRemoval = {
  removed: string[];
  skipped: Array<{ sessionId: string; reason: "missing" | "running" }>;
  counts: { sessions: number; runs: number; messages: number; toolEvents: number; requests: number; grants: number };
  /** The new conversation that took the place of a deleted current one, by mode. */
  replaced: Partial<Record<ConversationMode, ConversationView>>;
};
/** Whether a run is being carried out by this process right now. */
export type LiveRun = (runId: string) => boolean;

/** When a conversation was last spoken in: the later of its own mark and its newest task. */
const LAST_AT = "COALESCE((SELECT MAX(r.updated_at) FROM agent_runs r WHERE r.session_id = s.id), s.updated_at)";
/** The title of what a bound conversation is about. */
const OWNER_TITLE = `(CASE s.kind
  WHEN 'resource' THEN (SELECT x.title FROM resources x WHERE x.id = s.target_id)
  WHEN 'work' THEN COALESCE((SELECT x.title FROM works x WHERE x.id = s.target_id), (SELECT x.title FROM removed_works x WHERE x.id = s.target_id))
  WHEN 'project' THEN (SELECT x.name FROM projects x WHERE x.id = s.project_id)
  WHEN 'note' THEN (SELECT x.title FROM content_objects x WHERE x.id = s.target_id)
  ELSE NULL END)`;
