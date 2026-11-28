import type {
  AgentCitation,
  AgentErrorCode,
  AgentRunUsage,
  AgentSearchStep,
  AgentServerToolStep,
  AgentStopReason,
  AgentToolStep,
  ProposalCard,
  SourceLocator,
  StreamUserAttachment,
} from "@manga/contracts";
import { MangaError } from "@manga/contracts";
import { aggregateServerToolSteps, classifyAgentError } from "@manga/model-protocol";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { readLayout } from "../domain/revision-layout.ts";
import { liveRunExtras, type LiveRunExtras } from "./live-extras.ts";
import type { StreamAgent, StreamItem, VoiceSessionLike } from "./stream-types.ts";

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

const NOT_SUPERSEDED_SQL = "(usage_json IS NULL OR NOT json_valid(usage_json) OR json_extract(usage_json, '$.supersededBy') IS NULL)";

type StoredRunUsage = {
  costUsd?: number;
  estimatedCost?: number;
  currency?: string;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  searches?: number;
  fetches?: number;
  latencyMs?: number;
  pricesCheckedAt?: string;
  thinkingRaised?: boolean;
  stopReason?: AgentStopReason;
  refusal?: boolean;
  generatedTitle?: string;
  reasoningStartedAt?: string;
  reasoningElapsedMs?: number;
  errorCode?: AgentErrorCode;
  supersededBy?: string;
  toolSteps?: Record<string, { startedAt?: string; elapsedMs?: number; summary?: string; error?: string }>;
};

type StoredError = {
  code: string;
  message: string;
  errorCode?: AgentErrorCode;
  details?: Record<string, unknown>;
};

type ToolEventRow = {
  id: string;
  run_id: string;
  command_id: string;
  status: string;
  input_summary: string;
  result_summary: string | null;
  created_at: string;
};

function deriveErrorCode(err: StoredError | null, status: string, usageMeta: StoredRunUsage, live: LiveRunExtras | undefined): AgentErrorCode | undefined {
  if (err?.errorCode) return err.errorCode;
  if (typeof err?.details?.errorCode === "string") return err.details.errorCode as AgentErrorCode;
  if (usageMeta.errorCode) return usageMeta.errorCode;
  if (live?.errorCode) return live.errorCode;
  if (status === "cancelled") return "cancelled";
  if (!err) return undefined;
  const synthetic = new MangaError(err.code as never, err.message, { details: err.details });
  return classifyAgentError(synthetic).errorCode;
}

function mapToolEventStatus(status: string): AgentToolStep["status"] {
  if (status === "executed") return "done";
  if (status === "proposed") return "wip";
  return "error";
}

function assembleToolSteps(
  rows: ToolEventRow[],
  usageMeta: StoredRunUsage,
  live: LiveRunExtras | undefined,
): AgentToolStep[] | undefined {
  const steps: AgentToolStep[] = [];
  const byId = new Map<string, AgentToolStep>();
  for (const row of rows) {
    const meta = usageMeta.toolSteps?.[row.id];
    const parsedResult = parse<{ status?: string; error?: { message?: string } } | null>(row.result_summary, null);
    const status = mapToolEventStatus(row.status);
    const error = meta?.error ?? (status === "error"
      ? (parsedResult?.error?.message?.slice(0, 240) || (row.status === "denied" ? "工具调用未获授权" : undefined))
      : undefined);
    const step: AgentToolStep = {
      id: row.id,
      name: row.command_id,
      status,
      startedAt: meta?.startedAt ?? row.created_at,
      ...(typeof meta?.elapsedMs === "number" ? { elapsedMs: meta.elapsedMs } : {}),
      ...(meta?.summary ? { summary: meta.summary } : {}),
      ...(error ? { error } : {}),
    };
    steps.push(step);
    byId.set(step.id, step);
  }
  for (const liveStep of live?.toolSteps ?? []) {
    const existing = byId.get(liveStep.id);
    if (existing) {
      if (existing.elapsedMs === undefined && liveStep.elapsedMs !== undefined) existing.elapsedMs = liveStep.elapsedMs;
      if (!existing.summary && liveStep.summary) existing.summary = liveStep.summary;
      if (!existing.error && liveStep.error) existing.error = liveStep.error;
    } else {
      steps.push(liveStep);
      byId.set(liveStep.id, liveStep);
    }
  }
  return steps.length ? steps : undefined;
}

function assembleUsage(
  run: { input_tokens: number | null; output_tokens: number | null; duration_ms: number | null },
  usageMeta: StoredRunUsage,
  live: LiveRunExtras | undefined,
): AgentRunUsage | undefined {
  const inputTokens = live?.usage?.inputTokens ?? (typeof run.input_tokens === "number" ? run.input_tokens : undefined);
  const outputTokens = live?.usage?.outputTokens ?? (typeof run.output_tokens === "number" ? run.output_tokens : undefined);
  const cachedInputTokens = live?.usage?.cachedInputTokens ?? usageMeta.cachedInputTokens;
  const reasoningTokens = live?.usage?.reasoningTokens ?? usageMeta.reasoningTokens;
  const searches = live?.usage?.searches ?? usageMeta.searches;
  const fetches = live?.usage?.fetches ?? usageMeta.fetches;
  const estimatedCost = live?.usage?.estimatedCost ?? usageMeta.estimatedCost ?? usageMeta.costUsd;
  const currency = live?.usage?.currency ?? usageMeta.currency ?? (estimatedCost !== undefined ? "USD" : undefined);
  const latencyMs = live?.usage?.latencyMs ?? usageMeta.latencyMs ?? (typeof run.duration_ms === "number" ? run.duration_ms : undefined);
  const pricesCheckedAt = live?.usage?.pricesCheckedAt ?? usageMeta.pricesCheckedAt;
  const usage: AgentRunUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
    ...(searches !== undefined ? { searches } : {}),
    ...(fetches !== undefined ? { fetches } : {}),
    ...(estimatedCost !== undefined ? { estimatedCost } : {}),
    ...(currency ? { currency } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(pricesCheckedAt ? { pricesCheckedAt } : {}),
  };
  return Object.keys(usage).length ? usage : undefined;
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

  // The questions asked of the Agent in this session, and its answers (skipping superseded regenerated/edited turns).
  if (from && store.sqlite.prepare(`SELECT 1 FROM agent_runs WHERE session_id = ? AND created_at < ? AND ${NOT_SUPERSEDED_SQL} LIMIT 1`).get(session.id, from)) older = true;
  const runs = store.sqlite.prepare(`SELECT id, status, input_text, live_text, error_json, usage_json, model_id, input_tokens, output_tokens, duration_ms, created_at, updated_at
    FROM agent_runs
    WHERE session_id = ? AND created_at < ? AND created_at >= ? AND ${NOT_SUPERSEDED_SQL}
    ORDER BY created_at DESC LIMIT ?`).all(session.id, before, from, limit + 1) as Array<{
    id: string;
    status: string;
    input_text: string;
    live_text: string | null;
    error_json: string | null;
    usage_json: string | null;
    model_id: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    duration_ms: number | null;
    created_at: string;
    updated_at: string;
  }>;
  const firstUserPayloadByRun = new Map<string, string | null>();
  const assistantRowsByRun = new Map<string, Array<{ text: string; payload_json: string | null }>>();
  const toolEventsByRun = new Map<string, ToolEventRow[]>();
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
    const toolRows = queryInChunks(runIds, (chunk, placeholders) =>
      store.sqlite.prepare(`SELECT id, run_id, command_id, status, input_summary, result_summary, created_at FROM agent_tool_events WHERE run_id IN (${placeholders}) ORDER BY created_at, rowid`).all(...chunk) as ToolEventRow[],
    );
    for (const row of toolRows) {
      let list = toolEventsByRun.get(row.run_id);
      if (!list) toolEventsByRun.set(row.run_id, list = []);
      list.push(row);
    }
  }
  const proposalsByRun = proposals ? proposals.byRunForSession(session.id) : null;
  for (const run of runs) {
    const userPayload = parse<{ quickTask?: { id?: string | null; name?: string }; attachments?: StreamUserAttachment[] }>(firstUserPayloadByRun.get(run.id), {});
    const quick = userPayload.quickTask;
    items.push({
      kind: "user",
      id: `${run.id}:user`,
      at: run.created_at,
      runId: run.id,
      text: run.input_text,
      quickTask: quick?.name ? { id: quick.id ?? null, name: quick.name } : null,
      ...(Array.isArray(userPayload.attachments) && userPayload.attachments.length ? { attachments: userPayload.attachments } : {}),
    });
    const assistantRows = assistantRowsByRun.get(run.id) ?? [];
    const answer = assistantRows.map((row) => row.text).filter(Boolean).join("\n");
    const runProposals = proposalsByRun?.get(run.id);
    const live = liveRunExtras(run.id);
    const isLiveStatus = run.status === "running" || run.status === "queued";
    const activeLive = isLiveStatus ? live : undefined;
    const usageMeta = parse<StoredRunUsage>(run.usage_json, {});
    const parsedError = parse<StoredError | null>(run.error_json, null);
    const errorCode = deriveErrorCode(parsedError, run.status, usageMeta, activeLive);
    const error = parsedError
      ? { code: parsedError.code, message: parsedError.message, ...(errorCode ? { errorCode } : {}) }
      : null;
    const extras = answerExtras(assistantRows, activeLive, usageMeta);
    const toolSteps = assembleToolSteps(toolEventsByRun.get(run.id) ?? [], usageMeta, activeLive);
    const usage = assembleUsage(run, usageMeta, activeLive);
    const modelId = run.model_id ?? activeLive?.modelId ?? undefined;
    const stopReason = usageMeta.stopReason ?? activeLive?.stopReason ?? (run.status === "cancelled" ? "cancelled" : run.status === "failed" ? "error" : undefined);
    const refusal = usageMeta.refusal === true || activeLive?.refusal === true || stopReason === "refusal";
    const canContinue = !refusal && (run.status === "cancelled" || stopReason === "max_tokens");
    const generatedTitle = usageMeta.generatedTitle ?? activeLive?.generatedTitle;
    const text = (isLiveStatus ? (activeLive?.text || run.live_text || answer) : (answer || run.live_text)) ?? "";

    const agentItem: StreamAgent = {
      kind: "agent",
      id: `${run.id}:agent`,
      at: run.created_at,
      runId: run.id,
      status: run.status,
      text,
      error,
      ...(runProposals?.length ? { proposals: runProposals } : {}),
      ...extras,
      ...(toolSteps ? { toolSteps } : {}),
      ...(usage ? { usage } : {}),
      ...(modelId ? { modelId } : {}),
      ...(stopReason ? { stopReason } : {}),
      ...(canContinue ? { canContinue: true } : {}),
      ...(refusal ? { refusal: true } : {}),
      ...(generatedTitle ? { generatedTitle } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
    items.push(agentItem);
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

/** Assembles persisted and live thinking, server-side search/browse steps, and cited sources for a run. */
function answerExtras(
  rows: Array<{ payload_json: string | null }>,
  live: LiveRunExtras | undefined,
  usageMeta: StoredRunUsage,
): Pick<StreamAgent, "reasoning" | "reasoningStartedAt" | "reasoningElapsedMs" | "search" | "serverToolSteps" | "citations" | "thinkingRaised"> {
  const thoughts: string[] = [];
  const search: AgentSearchStep[] = [];
  const serverToolSteps: AgentServerToolStep[] = [];
  let citations: AgentCitation[] | undefined;
  let reasoningStartedAt = usageMeta.reasoningStartedAt ?? live?.reasoningStartedAt;
  let reasoningElapsedMs = usageMeta.reasoningElapsedMs ?? live?.reasoningElapsedMs;

  for (const row of rows) {
    const payload = parse<{
      reasoning?: unknown;
      reasoningStartedAt?: string;
      reasoningElapsedMs?: number;
      search?: AgentSearchStep[];
      serverToolSteps?: AgentServerToolStep[];
      citations?: AgentCitation[];
    }>(row.payload_json, {});
    if (typeof payload.reasoning === "string" && payload.reasoning) thoughts.push(payload.reasoning);
    if (!reasoningStartedAt && typeof payload.reasoningStartedAt === "string") reasoningStartedAt = payload.reasoningStartedAt;
    if (reasoningElapsedMs === undefined && typeof payload.reasoningElapsedMs === "number") reasoningElapsedMs = payload.reasoningElapsedMs;
    if (Array.isArray(payload.search) && payload.search.length) {
      search.push(...payload.search);
      if (Array.isArray(payload.serverToolSteps) && payload.serverToolSteps.length) {
        serverToolSteps.push(...payload.serverToolSteps);
      } else {
        serverToolSteps.push(...aggregateServerToolSteps(payload.search));
      }
    } else if (Array.isArray(payload.serverToolSteps) && payload.serverToolSteps.length) {
      serverToolSteps.push(...payload.serverToolSteps);
    }
    if (Array.isArray(payload.citations) && payload.citations.length) citations = payload.citations;
  }
  if (live?.reasoning) thoughts.push(live.reasoning);
  if (live?.search.length) {
    search.push(...live.search);
    if (live.serverToolSteps.length) serverToolSteps.push(...live.serverToolSteps);
    else serverToolSteps.push(...aggregateServerToolSteps(live.search));
  } else if (live?.serverToolSteps.length) {
    serverToolSteps.push(...live.serverToolSteps);
  }
  if (!citations && live?.citations.length) citations = live.citations;
  const thinkingRaised = usageMeta.thinkingRaised === true || live?.thinkingRaised === true;

  return {
    ...(thoughts.length ? { reasoning: thoughts.join("\n\n") } : {}),
    ...(reasoningStartedAt ? { reasoningStartedAt } : {}),
    ...(reasoningElapsedMs !== undefined ? { reasoningElapsedMs } : {}),
    ...(search.length ? { search } : {}),
    ...(serverToolSteps.length ? { serverToolSteps } : {}),
    ...(citations ? { citations } : {}),
    ...(thinkingRaised ? { thinkingRaised: true } : {}),
  };
}
