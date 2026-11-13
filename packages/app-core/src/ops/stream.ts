import type { ProposalCard, SourceLocator } from "@manga/contracts";
import { MangaError } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { readLayout } from "../domain/revision-layout.ts";
import { liveRunExtras } from "./live-extras.ts";
import type { AgentSearchStep, StreamAgent, StreamItem, VoiceSessionLike } from "./stream-types.ts";

export type { StreamItem } from "./stream-types.ts";

/** The most messages a refresh from an earlier message returns; past it the newest are kept and "older messages" comes back (LOOP-07). */
export const FROM_CAP = 5000;

type SessionRow = { id: string; kind: string; target_id: string | null };

const parse = <T>(raw: string | null | undefined, fallback: T): T => { if (!raw) return fallback; try { return JSON.parse(raw) as T; } catch { return fallback; } };

const IN_CHUNK = 400;
function queryInChunks<T>(ids: string[], query: (chunk: string[], placeholders: string) => T[]): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    out.push(...query(chunk, placeholders));
  }
  return out;
}

export type ProposalStreamLike = {
  byRunForSession(sessionId: string): Map<string, ProposalCard[]>;
};

export function sessionStream(
  store: DrizzleStore,
  voice: VoiceSessionLike | null,
  input: { sessionId: string; limit?: number; before?: string; from?: string },
  proposals?: ProposalStreamLike | null,
): { items: StreamItem[]; hasMore: boolean; session: { id: string; kind: string; targetId: string | null; workId: string | null; resourceId: string | null } } {
  const session = store.sqlite.prepare("SELECT id, kind, target_id FROM agent_sessions WHERE id = ?").get(input.sessionId) as SessionRow | undefined;
  if (!session) throw new MangaError("NOT_FOUND", "session missing");
  // `from` reads every message from that time to the newest, at most FROM_CAP of them (a refresh that keeps the pages already loaded).
  const from = input.from ?? "";
  const limit = input.from !== undefined ? FROM_CAP : Math.max(1, Math.min(1000, Math.floor(input.limit ?? 200)));
  const before = input.before ?? "9999";
  let older = false;
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
    const noteRows = (upper: string, lower: string, count: number) => resourceId
      ? store.sqlite.prepare(`SELECT o.id, o.title, o.revision, o.payload_json, o.tags_json, o.created_at FROM content_objects o
          WHERE o.type = 'notes.document' AND o.deleted_at IS NULL AND o.created_at < ? AND o.created_at >= ?
            AND (json_extract(o.scope_json, '$.resourceId') = ? OR EXISTS (SELECT 1 FROM refs f JOIN anchors a ON a.id = f.to_id WHERE f.from_object_id = o.id AND f.to_kind = 'anchor' AND a.resource_id = ?))
          ORDER BY o.created_at DESC LIMIT ?`).all(upper, lower, resourceId, resourceId, count)
      : store.sqlite.prepare(`SELECT o.id, o.title, o.revision, o.payload_json, o.tags_json, o.created_at FROM content_objects o
          WHERE o.type = 'notes.document' AND o.deleted_at IS NULL AND o.created_at < ? AND o.created_at >= ? AND o.work_id = ? ORDER BY o.created_at DESC LIMIT ?`).all(upper, lower, workId, count);
    const rows = noteRows(before, from, limit + 1) as Array<{ id: string; title: string; revision: number; payload_json: string; tags_json: string; created_at: string }>;
    if (from && noteRows(from, "", 1).length > 0) older = true;
    const parsedNotes = rows.map((row) => {
      const document = parse<{ blocks?: Array<{ id: string; type: string; text: string; anchorId?: string }> }>(row.payload_json, {});
      const blocks = document.blocks ?? [];
      const quoteBlock = blocks.find((block) => block.type === "quote");
      const anchorId = quoteBlock?.anchorId ?? blocks.find((block) => block.anchorId)?.anchorId ?? null;
      return { row, blocks, quoteBlock, anchorId };
    });
    const anchorIds = [...new Set(parsedNotes.map((note) => note.anchorId).filter((id): id is string => Boolean(id)))];
    const anchorMap = new Map<string, { id: string; resource_id: string; resource_revision_id: string; locator_json: string }>();
    if (anchorIds.length) {
      for (const anchor of queryInChunks(anchorIds, (chunk, placeholders) =>
        store.sqlite.prepare(`SELECT id, resource_id, resource_revision_id, locator_json FROM anchors WHERE id IN (${placeholders})`).all(...chunk) as Array<{ id: string; resource_id: string; resource_revision_id: string; locator_json: string }>,
      )) {
        anchorMap.set(anchor.id, anchor);
      }
    }
    for (const { row, blocks, quoteBlock, anchorId } of parsedNotes) {
      const anchor = anchorId ? anchorMap.get(anchorId) : undefined;
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
    const voiceQuery = resourceId
      ? { resourceId, ...(input.before ? { before: input.before } : {}), limit: Math.min(limit + 1, 100) }
      : { workId: workId!, ...(input.before ? { before: input.before } : {}), limit: Math.min(limit + 1, 100) };
    const sessions = voice.list(voiceQuery).sessions;
    if (from && !older) {
      const hasOlderVoice = resourceId
        ? store.sqlite.prepare("SELECT 1 FROM capture_sessions s WHERE s.created_at < ? AND s.id IN (SELECT DISTINCT session_id FROM capture_events WHERE resource_id = ?) LIMIT 1").get(from, resourceId)
        : store.sqlite.prepare("SELECT 1 FROM capture_sessions WHERE work_id = ? AND created_at < ? LIMIT 1").get(workId, from);
      if (hasOlderVoice) older = true;
    }
    const visibleSessions = sessions.filter((view) => {
      if (view.createdAt >= before) return false;
      if (view.createdAt < from) { older = true; return false; }
      return true;
    });
    const segmentsBySession = new Map<string, Array<{ start_ms: number; text: string; anchors_json: string }>>();
    if (visibleSessions.length) {
      const sessionIds = visibleSessions.map((view) => view.id);
      const segmentRows = queryInChunks(sessionIds, (chunk, placeholders) =>
        store.sqlite.prepare(`SELECT session_id, start_ms, COALESCE(revised_text, text) AS text, anchors_json FROM transcript_segments WHERE session_id IN (${placeholders}) AND state = 'done' ORDER BY session_id, start_ms, seq`).all(...chunk) as Array<{ session_id: string; start_ms: number; text: string; anchors_json: string }>,
      );
      for (const seg of segmentRows) {
        let list = segmentsBySession.get(seg.session_id);
        if (!list) segmentsBySession.set(seg.session_id, list = []);
        list.push(seg);
      }
    }
    for (const view of visibleSessions) {
      const segments = segmentsBySession.get(view.id) ?? [];
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
  if (from && store.sqlite.prepare("SELECT 1 FROM agent_runs WHERE session_id = ? AND created_at < ? LIMIT 1").get(session.id, from)) older = true;
  const runs = store.sqlite.prepare("SELECT id, status, input_text, live_text, error_json, usage_json, created_at, updated_at FROM agent_runs WHERE session_id = ? AND created_at < ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?").all(session.id, before, from, limit + 1) as Array<{
    id: string; status: string; input_text: string; live_text: string | null; error_json: string | null; usage_json: string | null; created_at: string; updated_at: string;
  }>;
  const firstUserPayloadByRun = new Map<string, string | null>();
  const assistantRowsByRun = new Map<string, Array<{ text: string; payload_json: string | null }>>();
  if (runs.length) {
    const runIds = runs.map((run) => run.id);
    const msgRows = queryInChunks(runIds, (chunk, placeholders) =>
      store.sqlite.prepare(`SELECT run_id, role, text, payload_json FROM agent_messages WHERE run_id IN (${placeholders}) AND role IN ('user', 'assistant') ORDER BY created_at, rowid`).all(...chunk) as Array<{ run_id: string; role: string; text: string; payload_json: string | null }>,
    );
    for (const msg of msgRows) {
      if (msg.role === "user") {
        if (!firstUserPayloadByRun.has(msg.run_id)) firstUserPayloadByRun.set(msg.run_id, msg.payload_json);
      } else {
        let list = assistantRowsByRun.get(msg.run_id);
        if (!list) assistantRowsByRun.set(msg.run_id, list = []);
        list.push({ text: msg.text, payload_json: msg.payload_json });
      }
    }
  }
  const proposalsByRun = proposals ? proposals.byRunForSession(session.id) : null;
  for (const run of runs) {
    const quick = parse<{ quickTask?: { id?: string | null; name?: string } }>(firstUserPayloadByRun.get(run.id), {}).quickTask;
    items.push({ kind: "user", id: `${run.id}:user`, at: run.created_at, runId: run.id, text: run.input_text, quickTask: quick?.name ? { id: quick.id ?? null, name: quick.name } : null });
    const assistantRows = assistantRowsByRun.get(run.id) ?? [];
    const answer = assistantRows.map((row) => row.text).filter(Boolean).join("\n");
    const runProposals = proposalsByRun?.get(run.id);
    items.push({
      kind: "agent", id: `${run.id}:agent`, at: run.created_at, runId: run.id, status: run.status,
      text: (run.status === "running" || run.status === "queued" ? run.live_text : answer || run.live_text) ?? "", error: parse<{ code: string; message: string } | null>(run.error_json, null),
      ...(runProposals?.length ? { proposals: runProposals } : {}),
      ...answerExtras(assistantRows, liveRunExtras(run.id), parse<{ thinkingRaised?: boolean }>(run.usage_json, {}).thinkingRaised === true),
    });
  }

  // Newest `limit` items, oldest first. At equal times a question comes before its answer.
  const order = { note: 0, voice: 1, user: 2, agent: 3 } as const;
  items.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : order[a.kind] - order[b.kind]));
  const cut = items.length > limit;
  let start = cut ? items.length - limit : 0;
  // Never split a `(user, agent)` pair from the same run across the `before` cursor boundary, or the user message would be dropped by `created_at < before`.
  const boundary = items[start];
  const prev = start > 0 ? items[start - 1] : undefined;
  if (
    start > 0 &&
    start + 1 < items.length &&
    boundary?.kind === "agent" &&
    prev?.kind === "user" &&
    prev.runId === boundary.runId
  ) {
    start += 1;
  }
  return { items: start > 0 ? items.slice(start) : items, hasMore: start > 0 || older, session: { id: session.id, kind: session.kind, targetId: session.target_id, workId, resourceId } };
}

/** The thinking, the searches and the cited sources of a run's answer: what its steps kept, then what the step under way has so far (计划 4.3/4.4). */
function answerExtras(rows: Array<{ payload_json: string | null }>, live: { reasoning: string; search: AgentSearchStep[] } | undefined, thinkingRaised: boolean): Pick<StreamAgent, "reasoning" | "search" | "citations" | "thinkingRaised"> {
  const thoughts: string[] = [];
  const search: AgentSearchStep[] = [];
  let citations: StreamAgent["citations"];
  for (const row of rows) {
    const payload = parse<{ reasoning?: unknown; search?: AgentSearchStep[]; citations?: StreamAgent["citations"] }>(row.payload_json, {});
    if (typeof payload.reasoning === "string" && payload.reasoning) thoughts.push(payload.reasoning);
    if (Array.isArray(payload.search)) search.push(...payload.search);
    if (Array.isArray(payload.citations) && payload.citations.length) citations = payload.citations;
  }
  if (live?.reasoning) thoughts.push(live.reasoning);
  if (live?.search.length) search.push(...live.search);
  return {
    ...(thoughts.length ? { reasoning: thoughts.join("\n\n") } : {}),
    ...(search.length ? { search } : {}),
    ...(citations ? { citations } : {}),
    ...(thinkingRaised ? { thinkingRaised } : {}),
  };
}
