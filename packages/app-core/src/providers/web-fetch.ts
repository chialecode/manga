import net from "node:net";
import { MangaError, type WebFetchResult } from "@manga/contracts";
import { fetchDeepSeekWeb, withRetries } from "@manga/model-protocol";
import { defaultLookup, isLocalHostname, isPrivateAddress, normalizeHostname } from "../net/address.ts";
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

/**
 * Validates a target URL before routing to a cloud web-fetch provider:
 * - Always rejects invalid schemes and embedded credentials (`user:pass@host`) with `VALIDATION_ERROR`.
 * - Classifies loopback, RFC1918/ULA/link-local IPs, single-label names, and local/intranet hostnames as `privateOrLocal`.
 */
export function classifyCloudFetchUrl(rawUrl: string): { url: URL; host: string; privateOrLocal: boolean } {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new MangaError("VALIDATION_ERROR", "that is not a web address", { details: { reason: "url" } });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new MangaError("VALIDATION_ERROR", "only http and https addresses can be fetched", { details: { reason: "scheme" } });
  }
  if (url.username || url.password) {
    throw new MangaError("VALIDATION_ERROR", "an address with a login in it is not fetched", { details: { reason: "credentials" } });
  }
  const host = normalizeHostname(url.hostname);
  if (!host) {
    throw new MangaError("VALIDATION_ERROR", "that address has no host", { details: { reason: "url" } });
  }
  const privateOrLocal = net.isIP(host) ? isPrivateAddress(host) : isLocalHostname(host);
  return { url, host, privateOrLocal };
}

/** Returns true when at least one `fetch` provider connection exists and its provider plugin is currently enabled. */
export function hasAvailableFetchService(app: WebFetchHost): boolean {
  const rows = app.store.sqlite.prepare(
    "SELECT c.id, a.provider_ref FROM provider_connections c LEFT JOIN provider_accounts a ON a.id = c.account_id WHERE c.purpose = 'fetch' ORDER BY c.created_at, c.rowid",
  ).all() as Array<{ id: string; provider_ref: string | null }>;
  return rows.some((row) => !row.provider_ref || Boolean(app.providers.get(row.provider_ref)));
}

/**
 * Fetches a web page as Markdown through a provider's fetch service (`deepseek-fetch@1` / `POST /v1/tools/fetch`),
 * enforcing URL credential/private-address safety, the provider plugin access gate, and `service_usage` recording.
 */
export async function fetchWithDeepSeek(
  app: WebFetchHost,
  input: { url: string; connectionId?: string; runId?: string; task?: string },
  signal: AbortSignal,
): Promise<WebFetchResult> {
  const target = classifyCloudFetchUrl(input.url);
  if (target.privateOrLocal) {
    throw new MangaError("PATH_ESCAPE", "that address leads to this computer or its local network, which a cloud fetch service cannot fetch", {
      details: { reason: "private", host: target.host },
    });
  }
  if (!net.isIP(target.host)) {
    let addresses: string[] = [];
    try {
      addresses = await defaultLookup(target.host);
    } catch {
      // Unresolvable locally may still be reachable via the cloud provider or system proxy.
      addresses = [];
    }
    if (addresses.some((addr) => isPrivateAddress(addr))) {
      throw new MangaError("PATH_ESCAPE", "that address leads to this computer or its local network, which a cloud fetch service cannot fetch", {
        details: { reason: "private", host: target.host },
      });
    }
  }
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
