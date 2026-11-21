import { MangaError } from "@manga/contracts";
import { searchDeepSeek, withRetries, type WebSearchResult } from "@manga/model-protocol";
import type { ConnectionRow } from "../product-helpers.ts";
import { connectionAccess, providerAbortReason, type ProviderAccessHost } from "./access.ts";
import { recordServiceUse } from "./usage.ts";

/** What `web.search` uses of the application. */
export type WebSearchHost = ProviderAccessHost;

/** The statuses a search is tried again on (计划 4.5): a timeout the service reports, the rate limit and the service's own errors, twice at most. */
const RETRY_STATUSES = [408, 429, 500, 502, 503, 504];

export type WebSearchAnswer = {
  query: string;
  /** The words were longer than the service takes and were cut. */
  truncated: boolean;
  results: Array<{ title: string; url: string; site: string | null; publishedAt: string | null; snippet: string | null; summary: string | null }>;
};

/**
 * One web search through a provider's search service (`web.search`, 计划 4.5): the connection given, or the first search connection. The result goes back
 * to whoever asked (the Agent's tool, or the material search panel) and is not saved; the use is recorded. An empty result is an answer, not a failure.
 */
export async function webSearch(app: WebSearchHost, input: { query: string; count?: number; connectionId?: string; runId?: string; task?: string }, signal: AbortSignal): Promise<WebSearchAnswer> {
  const row = (input.connectionId
    ? app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ? AND purpose = 'search'").get(input.connectionId)
    : app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE purpose = 'search' ORDER BY created_at, rowid LIMIT 1").get()) as ConnectionRow | undefined;
  if (!row) throw new MangaError("MODEL_CAPABILITY_MISSING", "没有配置网页搜索服务：在“设置 › 模型”里从 DeepSeek 加入“网页搜索”", { details: { reason: "no_search_service" } });
  const access = await connectionAccess(app, row, signal);
  try {
    if (!access.apiKey) throw new MangaError("AUTHENTICATION_FAILED", "the search connection has no key");
    const apiKey = access.apiKey;
    const found = await withRetries(
      () => searchDeepSeek(row.base_url, apiKey, { query: input.query, count: input.count, signal: access.signal ?? signal, timeoutMs: row.timeout_ms }),
      RETRY_STATUSES, { signal: access.signal ?? signal },
    );
    recordServiceUse(app, { connectionId: row.id, service: "search", task: input.task ?? "search", unit: "search", quantity: 1, status: "ok", ...(input.runId ? { runId: input.runId } : {}) });
    return { query: found.query, truncated: found.truncated, results: found.results.map(shape) };
  } catch (error) {
    const pluginOff = providerAbortReason(access.signal);
    if (pluginOff || !signal.aborted) {
      const cause = pluginOff ?? error;
      recordServiceUse(app, { connectionId: row.id, service: "search", task: input.task ?? "search", unit: "search", quantity: 0, status: "error", errorCode: cause instanceof MangaError ? cause.code : "UNKNOWN", ...(input.runId ? { runId: input.runId } : {}) });
    }
    throw pluginOff ?? error;
  } finally {
    access.release();
  }
}

function shape(result: WebSearchResult): WebSearchAnswer["results"][number] {
  let site = result.site ?? null;
  if (!site) { try { site = new URL(result.url).hostname.replace(/^www\./, ""); } catch { site = null; } }
  return { title: result.title, url: result.url, site, publishedAt: result.publishedAt ?? null, snippet: result.snippet ?? null, summary: result.summary ?? null };
}
