import type { SourceLocator } from "@manga/contracts";
import { MangaError } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { readLayout } from "../domain/revision-layout.ts";
import type { StreamItem, VoiceSessionLike } from "./stream-types.ts";

export type { StreamAgent, StreamItem, StreamNote, StreamUser, StreamVoice } from "./stream-types.ts";

type SessionRow = { id: string; kind: string; target_id: string | null };

const parse = <T>(raw: string | null | undefined, fallback: T): T => { if (!raw) return fallback; try { return JSON.parse(raw) as T; } catch { return fallback; } };

export function sessionStream(store: DrizzleStore, voice: VoiceSessionLike | null, input: { sessionId: string; limit?: number; before?: string }): { items: StreamItem[]; hasMore: boolean; session: { id: string; kind: string; targetId: string | null; workId: string | null; resourceId: string | null } } {
  const session = store.sqlite.prepare("SELECT id, kind, target_id FROM agent_sessions WHERE id = ?").get(input.sessionId) as SessionRow | undefined;
  if (!session) throw new MangaError("NOT_FOUND", "session missing");
  const limit = Math.min(1000, input.limit ?? 200);
  const before = input.before ?? "9999";
  const resourceId = session.kind === "resource" ? session.target_id : null;
  const workId = session.kind === "work" ? session.target_id : resourceId
    ? (store.sqlite.prepare("SELECT work_id FROM resources WHERE id = ?").get(resourceId) as { work_id: string | null } | undefined)?.work_id ?? null
    : null;
  const items: StreamItem[] = [];
  const layouts = new Map<string, string[] | null>();
  const pageOf = (revisionId: string | null, locator: SourceLocator | null): number | null => {
    if (!revisionId || locator?.kind !== "image") return null;
    if (!layouts.has(revisionId)) layouts.set(revisionId, (readLayout(store, revisionId) as { pages?: string[] } | undefined)?.pages ?? null);
    const index = layouts.get(revisionId)?.indexOf(locator.pageId) ?? -1;
    return index >= 0 ? index + 1 : null;
  };

  // Notes: those of this resource, or of the whole work for a work page. Each source is asked for one more than a page, so a source
  // that holds more than a page is seen to hold more; asking for exactly a page would read a full page as "nothing older".
  if (resourceId || (session.kind === "work" && workId)) {
    const rows = resourceId
      ? store.sqlite.prepare(`SELECT o.id, o.title, o.revision, o.payload_json, o.tags_json, o.created_at FROM content_objects o
          WHERE o.type = 'notes.document' AND o.deleted_at IS NULL AND o.created_at < ?
            AND (json_extract(o.scope_json, '$.resourceId') = ? OR EXISTS (SELECT 1 FROM refs f JOIN anchors a ON a.id = f.to_id WHERE f.from_object_id = o.id AND f.to_kind = 'anchor' AND a.resource_id = ?))
          ORDER BY o.created_at DESC LIMIT ?`).all(before, resourceId, resourceId, limit + 1)
      : store.sqlite.prepare(`SELECT o.id, o.title, o.revision, o.payload_json, o.tags_json, o.created_at FROM content_objects o
          WHERE o.type = 'notes.document' AND o.deleted_at IS NULL AND o.created_at < ? AND o.work_id = ? ORDER BY o.created_at DESC LIMIT ?`).all(before, workId, limit + 1);
    for (const row of rows as Array<{ id: string; title: string; revision: number; payload_json: string; tags_json: string; created_at: string }>) {
      const document = parse<{ blocks?: Array<{ id: string; type: string; text: string; anchorId?: string }> }>(row.payload_json, {});
      const blocks = document.blocks ?? [];
      const quoteBlock = blocks.find((block) => block.type === "quote");
      const anchorId = quoteBlock?.anchorId ?? blocks.find((block) => block.anchorId)?.anchorId ?? null;
      const anchor = anchorId ? store.sqlite.prepare("SELECT resource_id, resource_revision_id, locator_json FROM anchors WHERE id = ?").get(anchorId) as { resource_id: string; resource_revision_id: string; locator_json: string } | undefined : undefined;
      const locator = anchor ? parse<SourceLocator | null>(anchor.locator_json, null) : null;
      items.push({
        kind: "note", id: row.id, at: row.created_at, title: row.title,
        text: blocks.filter((block) => block.type !== "quote").map((block) => block.text).join("\n").slice(0, 4000),
        quote: (quoteBlock?.text ?? "").slice(0, 600), tags: parse<string[]>(row.tags_json, []), revision: row.revision,
        resourceId: anchor?.resource_id ?? null, resourceRevisionId: anchor?.resource_revision_id ?? null, anchorId, locator, pageNumber: pageOf(anchor?.resource_revision_id ?? null, locator),
      });
    }
  }

  // Voice bubbles: recordings made on this resource, or on any resource of the work.
  if (voice && (resourceId || workId) && session.kind !== "shared") {
    const sessions = voice.list(resourceId ? { resourceId, limit: Math.min(limit, 100) } : { workId: workId!, limit: Math.min(limit, 100) }).sessions;
    for (const view of sessions) {
      if (view.createdAt >= before) continue;
      const segments = store.sqlite.prepare("SELECT start_ms, COALESCE(revised_text, text) AS text, anchors_json FROM transcript_segments WHERE session_id = ? AND state = 'done' ORDER BY start_ms, seq").all(view.id) as Array<{ start_ms: number; text: string; anchors_json: string }>;
      items.push({
        kind: "voice", id: view.id, at: view.createdAt, stage: view.stage, audioState: view.audioState, playable: view.playable, durationMs: view.durationMs,
        text: segments.map((item) => item.text).join("").slice(0, 4000),
        segments: { total: view.segments.total, done: view.segments.done, failed: view.segments.failed, pending: view.segments.pending },
        sources: segments.slice(0, 20).map((item) => {
          const anchors = parse<Array<{ locator?: SourceLocator; resourceId?: string }>>(item.anchors_json, []);
          return { startMs: item.start_ms, locator: anchors[0]?.locator ?? null, resourceId: anchors[0]?.resourceId ?? view.resourceId };
        }),
        resourceId: view.resourceId,
      });
    }
  }

  // The questions asked of the Agent in this session, and its answers.
  const runs = store.sqlite.prepare("SELECT id, status, input_text, live_text, error_json, created_at, updated_at FROM agent_runs WHERE session_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?").all(session.id, before, limit + 1) as Array<{
    id: string; status: string; input_text: string; live_text: string | null; error_json: string | null; created_at: string; updated_at: string;
  }>;
  for (const run of runs) {
    const first = store.sqlite.prepare("SELECT payload_json FROM agent_messages WHERE run_id = ? AND role = 'user' ORDER BY created_at LIMIT 1").get(run.id) as { payload_json: string | null } | undefined;
    const quick = parse<{ quickTask?: { id?: string | null; name?: string } }>(first?.payload_json, {}).quickTask;
    items.push({ kind: "user", id: `${run.id}:user`, at: run.created_at, runId: run.id, text: run.input_text, quickTask: quick?.name ? { id: quick.id ?? null, name: quick.name } : null });
    const answer = (store.sqlite.prepare("SELECT text FROM agent_messages WHERE run_id = ? AND role = 'assistant' ORDER BY created_at").all(run.id) as Array<{ text: string }>).map((row) => row.text).filter(Boolean).join("\n");
    items.push({
      kind: "agent", id: `${run.id}:agent`, at: run.created_at, runId: run.id, status: run.status,
      text: (run.status === "running" || run.status === "queued" ? run.live_text : answer || run.live_text) ?? "", error: parse<{ code: string; message: string } | null>(run.error_json, null),
    });
  }

  // Newest `limit` items, oldest first. At equal times a question comes before its answer.
  const order = { note: 0, voice: 1, user: 2, agent: 3 } as const;
  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : order[a.kind] - order[b.kind]));
  const hasMore = items.length > limit;
  return { items: hasMore ? items.slice(items.length - limit) : items, hasMore, session: { id: session.id, kind: session.kind, targetId: session.target_id, workId, resourceId } };
}
