import { CAPTURE_STAGES } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";

export type RecordItem = {
  kind: "note" | "recording";
  id: string;
  title: string;
  preview: string;
  at: string;
  deleted: boolean;
  workId: string | null;
  workTitle: string | null;
  mediaKind: string | null;
  resourceId: string | null;
  resourceTitle: string | null;
  tags: string[];
  /** For a recording: the stage and what became of its audio. */
  stage: string | null;
  audioState: string | null;
  durationMs: number | null;
  /** Whether the note names a place in a resource, so "go to source" can be offered. */
  hasSource: boolean;
};

const AUDIO_STATES = ["staged", "retained", "cleaned", "none"];
const like = (value: string) => `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

/**
 * Every note and recording in one filterable list (the settings "records" page). Notes that were deleted are kept hidden but not
 * lost: `deleted: true` lists exactly those so they can be restored. The list is paged in SQL, so ten thousand notes stay cheap.
 */
export function recordsList(store: DrizzleStore, filter: { type?: "all" | "note" | "recording"; workId?: string; mediaKind?: string; state?: string; q?: string; deleted?: boolean; limit?: number; offset?: number } = {}): { items: RecordItem[]; total: number } {
  const type = filter.type ?? "all";
  const parts: string[] = [];
  if (type !== "recording") {
    parts.push(`SELECT 'note' AS kind, o.id AS id, o.title AS title, o.preview_json AS preview, o.updated_at AS at, o.deleted_at AS deleted_at, o.work_id AS work_id, o.tags_json AS tags,
      NULL AS stage, NULL AS audio_state, NULL AS duration_ms, json_extract(o.scope_json, '$.resourceId') AS resource_id, o.payload_json AS body
      FROM content_objects o WHERE o.type = 'notes.document'`);
  }
  if (type !== "note") {
    parts.push(`SELECT 'recording' AS kind, c.id AS id, '' AS title, '' AS preview, c.created_at AS at, NULL AS deleted_at, c.work_id AS work_id, '[]' AS tags,
      c.stage AS stage, c.audio_state AS audio_state, c.duration_ms AS duration_ms,
      (SELECT e.resource_id FROM capture_events e WHERE e.session_id = c.id AND e.resource_id IS NOT NULL ORDER BY e.offset_ms, e.id LIMIT 1) AS resource_id, '' AS body
      FROM capture_sessions c`);
  }
  const where: string[] = [];
  const params: Array<string | number> = [];
  where.push(filter.deleted ? "x.deleted_at IS NOT NULL" : "x.deleted_at IS NULL");
  if (filter.workId) { where.push("x.work_id = ?"); params.push(filter.workId); }
  if (filter.mediaKind) { where.push("w.media_kind = ?"); params.push(filter.mediaKind); }
  if (filter.state) {
    if ((CAPTURE_STAGES as readonly string[]).includes(filter.state)) { where.push("x.kind = 'recording' AND x.stage = ?"); params.push(filter.state); }
    else if (AUDIO_STATES.includes(filter.state)) { where.push("x.kind = 'recording' AND x.audio_state = ?"); params.push(filter.state); }
  }
  if (filter.q) {
    where.push("(x.title LIKE ? ESCAPE '\\' OR x.preview LIKE ? ESCAPE '\\' OR x.body LIKE ? ESCAPE '\\' OR w.title LIKE ? ESCAPE '\\')");
    const needle = like(filter.q);
    params.push(needle, needle, needle, needle);
  }
  const from = `FROM (${parts.join(" UNION ALL ")}) x LEFT JOIN works w ON w.id = x.work_id LEFT JOIN resources r ON r.id = x.resource_id WHERE ${where.join(" AND ")}`;
  const total = (store.sqlite.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params) as { n: number }).n;
  const limit = Math.min(100, filter.limit ?? 30);
  const rows = store.sqlite.prepare(`SELECT x.kind, x.id, x.title, x.preview, x.at, x.deleted_at, x.work_id, x.tags, x.stage, x.audio_state, x.duration_ms, x.resource_id,
      w.title AS work_title, w.media_kind AS media_kind, r.title AS resource_title,
      CASE WHEN x.kind = 'note' THEN EXISTS (SELECT 1 FROM refs f WHERE f.from_object_id = x.id AND f.to_kind = 'anchor') ELSE x.resource_id IS NOT NULL END AS has_source
      ${from} ORDER BY x.at DESC, x.id DESC LIMIT ? OFFSET ?`).all(...params, limit, filter.offset ?? 0) as Array<{
    kind: "note" | "recording"; id: string; title: string; preview: string; at: string; deleted_at: string | null; work_id: string | null; tags: string; stage: string | null; audio_state: string | null;
    duration_ms: number | null; resource_id: string | null; work_title: string | null; media_kind: string | null; resource_title: string | null; has_source: number;
  }>;
  const items = rows.map((row): RecordItem => {
    let preview = "";
    if (row.kind === "note") { try { preview = (JSON.parse(row.preview) as { text?: string }).text ?? ""; } catch { preview = ""; } }
    else preview = (store.sqlite.prepare("SELECT COALESCE(revised_text, text) AS text FROM transcript_segments WHERE session_id = ? AND state = 'done' ORDER BY start_ms, seq LIMIT 1").get(row.id) as { text?: string } | undefined)?.text ?? "";
    let tags: string[] = [];
    try { tags = JSON.parse(row.tags) as string[]; } catch { tags = []; }
    return {
      kind: row.kind, id: row.id, title: row.title, preview: preview.slice(0, 160), at: row.at, deleted: row.deleted_at !== null, workId: row.work_id, workTitle: row.work_title, mediaKind: row.media_kind,
      resourceId: row.resource_id, resourceTitle: row.resource_title, tags, stage: row.stage, audioState: row.audio_state, durationMs: row.duration_ms, hasSource: row.has_source === 1,
    };
  });
  return { items, total };
}
