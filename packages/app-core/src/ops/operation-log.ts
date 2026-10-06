import type { DrizzleStore } from "@manga/storage-drizzle";

/**
 * The operation log (A-49): what the user, the Agent and the system did that changed something. It is written by the one place
 * every command passes through, after the command finished, so a handler cannot forget it. Reading, paging and playing are not
 * logged. An entry holds names and identifiers, never credentials, text of notes or books, or pictures.
 */
export const LOG_RETENTION_DAYS = 180;
export const LOG_RETENTION_ROWS = 50_000;
const PRUNE_EVERY = 500;
/**
 * Changes made in a run, like the zoom and fit buttons of a reader or a dragged volume, are one line: a repeat of the newest entry by
 * the same actor on the same object within this window updates that line instead of adding another.
 */
export const LOG_COALESCE_MS = 60_000;
const COALESCED = new Set(["settings.setMedia"]);

export type LogActorKind = "user" | "agent" | "system";
export type LogEntry = {
  id: number;
  at: string;
  actorKind: LogActorKind;
  actorId: string | null;
  runId: string | null;
  category: string;
  action: string;
  objectKind: string | null;
  objectId: string | null;
  objectLabel: string | null;
  summaryKey: string;
  summaryParams: Record<string, string | number>;
  outcome: "ok" | "error";
  errorCode: string | null;
  requestId: string | null;
};

export type LogInput = {
  actorKind: LogActorKind;
  actorId?: string | null;
  runId?: string | null;
  category: string;
  action: string;
  objectKind?: string | null;
  objectId?: string | null;
  objectLabel?: string | null;
  summaryKey?: string;
  summaryParams?: Record<string, string | number>;
  outcome: "ok" | "error";
  errorCode?: string | null;
  requestId?: string | null;
};

/** Which commands are logged and under which category. Anything not listed is a read, or a change too frequent to be worth a line (page turns, bookmarks, typing). */
export const LOGGED_COMMANDS: Readonly<Record<string, string>> = {
  "library.importText": "library", "library.importEpub": "library", "library.importDocument": "library", "works.importDirectory": "library",
  "library.indexExternal": "library", "library.rebuildIndex": "library", "library.repairSource": "library",
  "works.setKind": "library", "works.moveResource": "library", "works.setOrdinal": "library", "works.setShelf": "library",
  "library.paths.add": "scan", "library.paths.update": "scan", "library.paths.remove": "scan", "library.scan.start": "scan", "library.scan.cancel": "scan", "library.scan.setSchedule": "scan",
  "works.setOverride": "metadata", "covers.select": "metadata", "covers.lock": "metadata", "covers.fromImage": "metadata",
  "metadata.setProvider": "metadata", "metadata.link": "metadata", "metadata.unlink": "metadata", "metadata.refresh": "metadata", "metadata.findMissing": "metadata",
  "notes.create": "notes", "notes.delete": "notes", "notes.undelete": "notes", "notes.restore": "notes", "notes.undo": "notes",
  "capture.start": "recording", "capture.stop": "recording", "capture.retain": "recording", "capture.transcribe": "recording", "capture.retry": "recording", "capture.cancel": "recording", "capture.organize": "recording", "capture.acceptDraft": "recording",
  "agent.send": "agent", "agent.cancel": "agent", "agent.retry": "agent",
  "settings.setModule": "settings", "settings.setRuntime": "settings", "settings.setRecording": "settings", "settings.setMedia": "settings", "settings.skipAi": "settings",
  "quickTasks.save": "settings", "quickTasks.delete": "settings", "quickTasks.reorder": "settings", "quickTasks.restore": "settings",
  "connections.upsert": "connections", "connections.delete": "connections", "connections.test": "connections",
  "library.exportPackage": "backup", "library.importPackage": "backup", "package.importResolved": "backup",
  "settings.proposeLocations": "backup", "settings.applyLocations": "backup", "settings.setLayout": "backup", "settings.recoverJobs": "backup",
  "inventory.repair": "backup", "inventory.scan": "backup",
  "video.playCopy": "library",
};

type Row = {
  id: number; at: string; actor_kind: LogActorKind; actor_id: string | null; run_id: string | null; category: string; action: string;
  object_kind: string | null; object_id: string | null; object_label: string | null; summary_key: string; summary_params_json: string;
  outcome: "ok" | "error"; error_code: string | null; request_id: string | null;
};

const entryOf = (row: Row): LogEntry => ({
  id: row.id, at: row.at, actorKind: row.actor_kind, actorId: row.actor_id, runId: row.run_id, category: row.category, action: row.action,
  objectKind: row.object_kind, objectId: row.object_id, objectLabel: row.object_label, summaryKey: row.summary_key,
  summaryParams: JSON.parse(row.summary_params_json) as Record<string, string | number>, outcome: row.outcome, errorCode: row.error_code, requestId: row.request_id,
});

const clip = (value: string | null | undefined, max: number) => (value && value.length > max ? `${value.slice(0, max)}…` : value ?? null);

export class OperationLog {
  private readonly store: DrizzleStore;
  private readonly now: () => number;
  private since = 0;

  constructor(store: DrizzleStore, now: () => number = Date.now) {
    this.store = store;
    this.now = now;
    this.prune();
  }

  record(input: LogInput): void {
    const params = { ...(input.summaryParams ?? {}) };
    for (const [key, value] of Object.entries(params)) if (typeof value === "string") params[key] = clip(value, 120) ?? "";
    const at = new Date(this.now()).toISOString();
    if (input.outcome === "ok" && COALESCED.has(input.action)) {
      const last = this.store.sqlite.prepare("SELECT id, at, actor_kind, actor_id, action, object_id, outcome FROM operation_log ORDER BY id DESC LIMIT 1").get() as
        Pick<Row, "id" | "at" | "actor_kind" | "actor_id" | "action" | "object_id" | "outcome"> | undefined;
      if (last && last.action === input.action && last.outcome === "ok" && last.actor_kind === input.actorKind && last.actor_id === (input.actorId ?? null)
        && last.object_id === (input.objectId ?? null) && this.now() - Date.parse(last.at) < LOG_COALESCE_MS) {
        this.store.sqlite.prepare("UPDATE operation_log SET at = ?, summary_params_json = ?, request_id = ? WHERE id = ?").run(at, JSON.stringify(params), input.requestId ?? null, last.id);
        return;
      }
    }
    this.store.sqlite.prepare(`INSERT INTO operation_log(at, actor_kind, actor_id, run_id, category, action, object_kind, object_id, object_label, summary_key, summary_params_json, outcome, error_code, request_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      at, input.actorKind, input.actorId ?? null, input.runId ?? null, input.category, input.action,
      input.objectKind ?? null, input.objectId ?? null, clip(input.objectLabel, 160), input.summaryKey ?? `log.${input.action}`, JSON.stringify(params), input.outcome, input.errorCode ?? null, input.requestId ?? null,
    );
    this.since += 1;
    if (this.since >= PRUNE_EVERY) this.prune();
  }

  /** Entries newest first. `before` is the id of the last entry the caller already has. */
  query(filter: { category?: string; actorKind?: LogActorKind; outcome?: "ok" | "error"; q?: string; from?: string; to?: string; limit?: number; before?: number } = {}): { entries: LogEntry[]; nextBefore: number | null; total: number } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.category) { where.push("category = ?"); params.push(filter.category); }
    if (filter.actorKind) { where.push("actor_kind = ?"); params.push(filter.actorKind); }
    if (filter.outcome) { where.push("outcome = ?"); params.push(filter.outcome); }
    if (filter.from) { where.push("at >= ?"); params.push(filter.from); }
    if (filter.to) { where.push("at <= ?"); params.push(filter.to); }
    if (filter.q) { where.push("(object_label LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR object_id = ?)"); const like = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; params.push(like, like, filter.q); }
    const base = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (this.store.sqlite.prepare(`SELECT COUNT(*) AS n FROM operation_log ${base}`).get(...params) as { n: number }).n;
    const limit = Math.min(200, filter.limit ?? 50);
    const paged = filter.before ? `${base ? `${base} AND` : "WHERE"} id < ?` : base;
    const rows = this.store.sqlite.prepare(`SELECT * FROM operation_log ${paged} ORDER BY id DESC LIMIT ?`).all(...params, ...(filter.before ? [filter.before] : []), limit + 1) as Row[];
    const entries = rows.slice(0, limit).map(entryOf);
    return { entries, nextBefore: rows.length > limit ? entries.at(-1)!.id : null, total };
  }

  categories(): string[] {
    return (this.store.sqlite.prepare("SELECT DISTINCT category FROM operation_log ORDER BY category").all() as Array<{ category: string }>).map((row) => row.category);
  }

  /** Drops what is older than the retention window, and the oldest rows beyond the cap. */
  prune(): { removed: number } {
    this.since = 0;
    const cutoff = new Date(this.now() - LOG_RETENTION_DAYS * 86_400_000).toISOString();
    let removed = this.store.sqlite.prepare("DELETE FROM operation_log WHERE at < ?").run(cutoff).changes;
    const over = (this.store.sqlite.prepare("SELECT COUNT(*) AS n FROM operation_log").get() as { n: number }).n - LOG_RETENTION_ROWS;
    if (over > 0) removed += this.store.sqlite.prepare("DELETE FROM operation_log WHERE id IN (SELECT id FROM operation_log ORDER BY id LIMIT ?)").run(over).changes;
    return { removed: Number(removed) };
  }
}

/** The thing a command acted on, found from its input (and result), with a display name read from the library. */
export function describeObject(store: DrizzleStore, input: unknown, value: unknown): { kind: string; id: string; label: string | null } | null {
  const source = { ...(typeof value === "object" && value ? value as Record<string, unknown> : {}), ...(typeof input === "object" && input ? input as Record<string, unknown> : {}) };
  const pick = (key: string): string | null => (typeof source[key] === "string" && source[key] ? String(source[key]) : null);
  const label = (sql: string, id: string): string | null => {
    try { return (store.sqlite.prepare(sql).get(id) as { label?: string } | undefined)?.label ?? null; } catch { return null; }
  };
  const workId = pick("workId");
  if (workId) return { kind: "work", id: workId, label: label("SELECT title AS label FROM works WHERE id = ?", workId) };
  const resourceId = pick("resourceId");
  if (resourceId) return { kind: "resource", id: resourceId, label: label("SELECT title AS label FROM resources WHERE id = ?", resourceId) };
  const objectId = pick("objectId");
  if (objectId) return { kind: "note", id: objectId, label: label("SELECT title AS label FROM content_objects WHERE id = ?", objectId) };
  const pathId = pick("pathId");
  // Only the folder's own name is kept: the log says which path was meant without writing where it is on this machine.
  if (pathId) return { kind: "libraryPath", id: pathId, label: label("SELECT path AS label FROM library_paths WHERE id = ?", pathId)?.split(/[\\/]/).filter(Boolean).pop() ?? null };
  const connectionId = pick("connectionId") ?? pick("id");
  if (connectionId && (pick("connectionId") || pick("baseUrl"))) return { kind: "connection", id: connectionId, label: label("SELECT label FROM provider_connections WHERE id = ?", connectionId) };
  const featureId = pick("featureId");
  if (featureId) return { kind: "module", id: featureId, label: featureId };
  const sessionId = pick("sessionId");
  if (sessionId) return { kind: "session", id: sessionId, label: label("SELECT title AS label FROM agent_sessions WHERE id = ?", sessionId) };
  const runId = pick("runId");
  if (runId) return { kind: "run", id: runId, label: null };
  const captureId = pick("captureId") ?? pick("sessionId");
  if (captureId) return { kind: "recording", id: captureId, label: null };
  return null;
}
