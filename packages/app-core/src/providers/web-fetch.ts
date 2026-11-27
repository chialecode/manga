import { MangaError, type WebFetchResult } from "@manga/contracts";
import { fetchDeepSeekWeb, withRetries } from "@manga/model-protocol";
import type { ConnectionRow } from "../product-helpers.ts";
import { connectionAccess, providerAbortReason, type ProviderAccessHost } from "./access.ts";
import { recordServiceUse } from "./usage.ts";

/** What DeepSeek web fetch uses of the application. */
export type WebFetchHost = Omit<ProviderAccessHost, "store"> & {
  store: {
    sqlite: {
      prepare(sql: string): {
        get(...params: unknown[]): unknown;
        all(...params: unknown[]): unknown[];
        run(...params: unknown[]): unknown;
      };
    };
  };
};

const RETRY_STATUSES = [408, 429, 500, 502, 503, 504];

/** Returns true when at least one `fetch` provider connection exists and its provider plugin is currently enabled. */
export function hasAvailableFetchService(app: WebFetchHost): boolean {
  const rows = app.store.sqlite.prepare(
    "SELECT c.id, a.provider_ref FROM provider_connections c LEFT JOIN provider_accounts a ON a.id = c.account_id WHERE c.purpose = 'fetch' ORDER BY c.created_at, c.rowid",
  ).all() as Array<{ id: string; provider_ref: string | null }>;
  return rows.some((row) => !row.provider_ref || Boolean(app.providers.get(row.provider_ref)));
}

/**
 * Fetches a web page as Markdown through a provider's fetch service (`deepseek-fetch@1` / `POST /v1/tools/fetch`),
 * enforcing the provider plugin access gate and recording `service_usage`.
 */
export async function fetchWithDeepSeek(
  app: WebFetchHost,
  input: { url: string; connectionId?: string; runId?: string; task?: string },
  signal: AbortSignal,
): Promise<WebFetchResult> {
  const row = (input.connectionId
    ? app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE id = ? AND purpose = 'fetch'").get(input.connectionId)
    : app.store.sqlite.prepare("SELECT * FROM provider_connections WHERE purpose = 'fetch' ORDER BY created_at, rowid LIMIT 1").get()) as ConnectionRow | undefined;
  if (!row) {
    throw new MangaError("MODEL_CAPABILITY_MISSING", "没有配置网页抓取服务：在“设置 › 模型”里从 DeepSeek 加入“网页抓取”", {
      details: { reason: "no_fetch_service" },
    });
  }
  const access = await connectionAccess(app, row, signal);
  try {
    if (!access.apiKey) throw new MangaError("AUTHENTICATION_FAILED", "the fetch connection has no key");
    const apiKey = access.apiKey;
    const fetched = await withRetries(
      () => fetchDeepSeekWeb({
        baseUrl: row.base_url,
        apiKey,
        url: input.url,
        signal: access.signal ?? signal,
        timeoutMs: row.timeout_ms,
      }),
      RETRY_STATUSES,
      { signal: access.signal ?? signal },
    );
    recordServiceUse(app, {
      connectionId: row.id,
      service: "fetch",
      task: input.task ?? "research",
      unit: "fetch",
      quantity: 1,
      status: "ok",
      ...(input.runId ? { runId: input.runId } : {}),
    });
    return fetched;
  } catch (error) {
    const pluginOff = providerAbortReason(access.signal);
    if (pluginOff || !signal.aborted) {
      const cause = pluginOff ?? error;
      recordServiceUse(app, {
        connectionId: row.id,
        service: "fetch",
        task: input.task ?? "research",
        unit: "fetch",
        quantity: 0,
        status: "error",
        errorCode: cause instanceof MangaError ? cause.code : "UNKNOWN",
        ...(input.runId ? { runId: input.runId } : {}),
      });
    }
    throw pluginOff ?? error;
  } finally {
    access.release();
  }
}
