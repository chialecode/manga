import { createId, splitProviderRef, type ProviderFile } from "@manga/contracts";
import type { ProviderRegistry } from "./registry.ts";

/** What recording a use needs. */
export type UsageHost = { readonly store: { readonly sqlite: { prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown } } }; readonly providers: ProviderRegistry };

export type ServiceUse = {
  connectionId: string | null;
  modelId?: string | null;
  service: "transcription" | "speech" | "search" | "chat-search" | "fetch" | "ocr";
  /** What the call was for: `dictation`, `recording`, `read-aloud`, `agent`, `research`, `test`, `ocr`. */
  task: string;
  unit: "second" | "char" | "search" | "fetch" | "page";
  quantity: number;
  status: "ok" | "error";
  errorCode?: string | null;
  runId?: string | null;
};

/** The provider file behind a connection, when it has one and the provider is still there. */
export function providerFileOf(app: UsageHost, connectionId: string | null): ProviderFile | undefined {
  if (!connectionId) return undefined;
  const row = app.store.sqlite.prepare("SELECT a.provider_ref FROM provider_connections c JOIN provider_accounts a ON a.id = c.account_id WHERE c.id = ?").get(connectionId) as { provider_ref: string } | undefined;
  return row && splitProviderRef(row.provider_ref) ? app.providers.get(row.provider_ref)?.file : undefined;
}

/** The estimated cost of a use from the provider file's price list, or null when it has none (计划 4.9: an estimate, never a bill). */
export function estimateCost(file: ProviderFile | undefined, use: Pick<ServiceUse, "service" | "unit" | "quantity">): number | null {
  if (!file) return null;
  const kind = use.service === "chat-search" ? "search" : use.service;
  const price = file.services.find((service) => service.kind === kind)?.price;
  if (!price || price.unit !== use.unit) return null;
  return (use.quantity / price.per) * price.usd;
}

/** Records one use of a provider's service: the units it counted and the estimated cost, never the text. */
export function recordServiceUse(app: UsageHost, use: ServiceUse): void {
  const cost = use.status === "ok" || use.quantity > 0 ? estimateCost(providerFileOf(app, use.connectionId), use) : null;
  app.store.sqlite.prepare("INSERT INTO service_usage(id, connection_id, model_id, service, task, unit, quantity, cost_usd, status, error_code, run_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    createId("use"), use.connectionId, use.modelId ?? null, use.service, use.task, use.unit, use.quantity, cost, use.status, use.errorCode ?? null, use.runId ?? null, new Date().toISOString(),
  );
}

/** The estimated cost of a chat answer from the provider file's model prices (input, cached input, output per million tokens). */
export function estimateChatCost(file: ProviderFile | undefined, modelId: string, usage: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }): number | undefined {
  const price = file?.models.find((model) => model.id === modelId)?.price;
  if (!price || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return undefined;
  const cached = Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens ?? 0);
  const fresh = (usage.inputTokens ?? 0) - cached;
  const cachedPrice = price.cachedInput ?? price.input;
  return (fresh / price.input.per) * price.input.usd + (cached / cachedPrice.per) * cachedPrice.usd + ((usage.outputTokens ?? 0) / price.output.per) * price.output.usd;
}
