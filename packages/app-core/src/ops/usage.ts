import type { DrizzleStore } from "@manga/storage-drizzle";

/**
 * Usage records (A-49): each Agent run with the model it used, the tokens and cost the service reported, how long it took and how it
 * ended; and each transcription with the length of audio it covered. A value the service did not provide is `null` and the page says
 * "not provided"; a run saved before these fields existed has `recorded: false` and the page says "not recorded".
 */
export type UsageRow = {
  kind: "run" | "transcription";
  id: string;
  at: string;
  status: string;
  recorded: boolean;
  modelId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  durationMs: number | null;
  /** For a transcription: the length of the audio. */
  audioMs: number | null;
  sessionId: string | null;
  errorCode: string | null;
};

export type UsageSummary = { key: string; runs: number; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; audioMs: number };

type RunRow = {
  id: string; session_id: string; status: string; usage_json: string | null; error_json: string | null; model_id: string | null;
  input_tokens: number | null; output_tokens: number | null; duration_ms: number | null; created_at: string;
};

const parse = <T>(raw: string | null): T | null => { if (!raw) return null; try { return JSON.parse(raw) as T; } catch { return null; } };

export function usageQuery(store: DrizzleStore, filter: { from?: string; to?: string; modelId?: string; limit?: number; offset?: number } = {}): { rows: UsageRow[]; total: number; byDay: UsageSummary[]; byModel: UsageSummary[]; models: string[] } {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.from) { where.push("created_at >= ?"); params.push(filter.from); }
  if (filter.to) { where.push("created_at <= ?"); params.push(filter.to); }
  if (filter.modelId) { where.push("model_id = ?"); params.push(filter.modelId); }
  const base = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const runs = store.sqlite.prepare(`SELECT id, session_id, status, usage_json, error_json, model_id, input_tokens, output_tokens, duration_ms, created_at FROM agent_runs ${base}`).all(...params) as RunRow[];
  const all: UsageRow[] = runs.map((row) => {
    const usage = parse<{ costUsd?: number }>(row.usage_json);
    return {
      kind: "run", id: row.id, at: row.created_at, status: row.status, recorded: row.model_id !== null || row.duration_ms !== null,
      modelId: row.model_id, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
      costUsd: typeof usage?.costUsd === "number" ? usage.costUsd : null, durationMs: row.duration_ms, audioMs: null, sessionId: row.session_id,
      errorCode: parse<{ code?: string }>(row.error_json)?.code ?? null,
    };
  });
  if (!filter.modelId) {
    const capWhere: string[] = ["stage IN ('done','no_speech','failed','transcribing','pending','awaiting_asr')"];
    const capParams: Array<string | number> = [];
    if (filter.from) { capWhere.push("created_at >= ?"); capParams.push(filter.from); }
    if (filter.to) { capWhere.push("created_at <= ?"); capParams.push(filter.to); }
    const captures = store.sqlite.prepare(`SELECT id, stage, duration_ms, created_at, error_json FROM capture_sessions WHERE ${capWhere.join(" AND ")}`).all(...capParams) as Array<{ id: string; stage: string; duration_ms: number; created_at: string; error_json: string | null }>;
    for (const row of captures) {
      all.push({
        kind: "transcription", id: row.id, at: row.created_at, status: row.stage, recorded: true, modelId: null, inputTokens: null, outputTokens: null, costUsd: null,
        durationMs: null, audioMs: row.duration_ms, sessionId: null, errorCode: parse<{ code?: string }>(row.error_json)?.code ?? null,
      });
    }
  }
  all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const summarize = (key: (row: UsageRow) => string): UsageSummary[] => {
    const map = new Map<string, UsageSummary>();
    for (const row of all) {
      const id = key(row);
      const item = map.get(id) ?? { key: id, runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, audioMs: 0 };
      item.runs += 1;
      item.inputTokens += row.inputTokens ?? 0;
      item.outputTokens += row.outputTokens ?? 0;
      item.costUsd += row.costUsd ?? 0;
      item.durationMs += row.durationMs ?? 0;
      item.audioMs += row.audioMs ?? 0;
      map.set(id, item);
    }
    return [...map.values()];
  };
  const limit = Math.min(200, filter.limit ?? 50);
  const offset = filter.offset ?? 0;
  const models = (store.sqlite.prepare("SELECT DISTINCT model_id FROM agent_runs WHERE model_id IS NOT NULL ORDER BY model_id").all() as Array<{ model_id: string }>).map((row) => row.model_id);
  return {
    rows: all.slice(offset, offset + limit),
    total: all.length,
    byDay: summarize((row) => row.at.slice(0, 10)).sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, 60),
    byModel: summarize((row) => row.modelId ?? (row.kind === "transcription" ? "transcription" : "unrecorded")).sort((a, b) => b.runs - a.runs),
    models,
  };
}
