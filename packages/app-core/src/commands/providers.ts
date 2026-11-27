/** Adding models from a provider plugin (计划 4.2): the providers on offer, the models an account can use, and the accounts with their shared key. */
import { MangaError, createId, type CommandEnvelope, type ProviderModel, type ProviderServiceKind } from "@manga/contracts";
import { applyProfile, DEFAULT_MODEL_PROFILE, type ModelProfile, type ReasoningEffort } from "@manga/contracts/models";
import { joinApiPath, mapHttpError, networkError } from "@manga/model-protocol";
import { failureOf } from "../model-probe.ts";
import type { MangaProductApp } from "../product-app.ts";
import { readCredential, saveCredential } from "../credentials.ts";
import type { ProviderEntry } from "../providers/registry.ts";
import { checkedProfile, type ConnectionsHost } from "./connections.ts";
import { currentRuntime } from "./settings.ts";

export type ProvidersHost = ConnectionsHost & Pick<MangaProductApp, "providers" | "plugins">;

const SERVICE_NAMES: Record<ProviderServiceKind, string> = { transcription: "语音识别", speech: "语音合成", search: "网页搜索", fetch: "网页抓取", ocr: "文档识别" };
const SERVICE_PURPOSE: Record<ProviderServiceKind, "transcription" | "speech" | "search" | "fetch" | "ocr"> = { transcription: "transcription", speech: "speech", search: "search", fetch: "fetch", ocr: "ocr" };

/** A model as an account can use it: the catalogue's entry, with what the service's own list says on top. */
export type DiscoveredModel = {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
  maxOutput: number;
  inputTypes: string[];
  reasoningLevels: string[];
  defaultLevel: string | null;
  /** In the plugin's catalogue (a model the service lists but the catalogue does not is shown with the service's numbers). */
  inCatalog: boolean;
  /** In the service's list for this key. */
  listed: boolean;
  suggested: boolean;
};

export function listProviders(app: ProvidersHost) {
  const providers = app.providers.list().map((entry) => ({
    ref: entry.ref,
    pluginId: entry.pluginId,
    id: entry.file.id,
    name: entry.file.name,
    keyUrl: entry.file.keyUrl ?? null,
    pricesCheckedAt: entry.file.pricesCheckedAt ?? null,
    priceNote: entry.file.priceNote ?? null,
    models: entry.file.models.map((model) => ({ ...catalogModel(model), listed: false })),
    services: entry.file.services.map((service) => ({ kind: service.kind, name: service.name, description: service.description, suggested: service.suggested, voices: service.voices ?? [] })),
  }));
  const accounts = (app.store.sqlite.prepare("SELECT a.id, a.provider_ref, a.label, a.created_at, a.credential_ref, (SELECT COUNT(*) FROM provider_connections c WHERE c.account_id = a.id) AS connections FROM provider_accounts a ORDER BY a.created_at, a.rowid").all() as Array<{ id: string; provider_ref: string; label: string; created_at: string; credential_ref: string | null; connections: number }>)
    .map((row) => ({ id: row.id, providerRef: row.provider_ref, label: row.label, createdAt: row.created_at, credentialConfigured: Boolean(row.credential_ref), connections: Number(row.connections), available: Boolean(app.providers.get(row.provider_ref)) }));
  // A provider plugin that comes with the application or is installed but is off: the models page says where to turn it on.
  const pluginNames = new Map(app.plugins.list().plugins.map((plugin) => [plugin.id, plugin.name]));
  const offered = [
    ...app.plugins.bundled().filter((item) => !item.installed && item.id.startsWith("manga.provider-")).map((item) => ({ pluginId: item.id, name: item.name, state: "not-installed" as const })),
    ...app.plugins.providers("model.provider", { includeDisabled: true }).filter((item) => !item.enabled).map((item) => ({ pluginId: item.pluginId, name: pluginNames.get(item.pluginId) ?? item.id, state: "disabled" as const })),
  ];
  return { providers, accounts, offered };
}

function catalogModel(model: ProviderModel): Omit<DiscoveredModel, "listed"> {
  return {
    id: model.id, name: model.name, description: model.description, contextWindow: model.contextWindow, maxOutput: model.maxOutput, inputTypes: model.inputTypes,
    reasoningLevels: model.reasoning?.levels ?? [], defaultLevel: model.reasoning?.default ?? null, inCatalog: true, suggested: model.suggested,
  };
}

/** The key for a discovery: a new one the page stashed (left in place for the add that follows), or an existing account's. */
async function keyFor(app: ProvidersHost, input: { accountId?: string; credentialHandle?: string }, ref: string): Promise<string> {
  if (input.credentialHandle) {
    const secret = app.secrets.get(input.credentialHandle);
    if (!secret) throw new MangaError("FORBIDDEN", "credential handle is not authorized");
    return secret;
  }
  if (!input.accountId) throw new MangaError("VALIDATION_ERROR", "a key or an account is needed", { details: { reason: "key" } });
  const account = app.store.sqlite.prepare("SELECT provider_ref, credential_ref FROM provider_accounts WHERE id = ?").get(input.accountId) as { provider_ref: string; credential_ref: string | null } | undefined;
  if (!account || account.provider_ref !== ref) throw new MangaError("NOT_FOUND", "account missing");
  const key = account.credential_ref ? await readCredential(app, account.credential_ref) : undefined;
  if (!key) throw new MangaError("AUTHENTICATION_FAILED", "the account has no key");
  return key;
}

/** Reads `GET /models` with the account's key and lays it over the catalogue (计划 4.2 step 2). A failure is a result with its kind, not an error. */
export async function discoverModels(app: ProvidersHost, envelope: CommandEnvelope, signal: AbortSignal) {
  const input = envelope.input as { providerRef: string; accountId?: string; credentialHandle?: string };
  const entry = app.providers.require(input.providerRef);
  const key = await keyFor(app, input, entry.ref);
  const catalog = entry.file.models.map((model) => ({ ...catalogModel(model), listed: false }));
  if (entry.file.discovery !== "openai-models") return { ok: true as const, verified: false, models: catalog };
  const tracked = app.providers.track(entry.ref, signal);
  try {
    await app.providers.checkAddress(entry, entry.baseUrl);
    const response = await fetch(joinApiPath(entry.baseUrl, "/models"), { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, redirect: "error", signal: AbortSignal.any([tracked.signal, AbortSignal.timeout(15_000)]) })
      .catch((error) => { throw networkError(error, signal); });
    if (!response.ok) throw mapHttpError(response.status, await response.text().catch(() => ""));
    const body = await response.json().catch(() => ({})) as { data?: unknown };
    const listed = Array.isArray(body.data) ? body.data.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") : [];
    const models: DiscoveredModel[] = [];
    for (const item of listed) {
      const id = String(item.id);
      const known = catalog.find((model) => model.id === id);
      const remoteName = typeof item.name === "string" && item.name.trim() ? item.name.trim() : undefined;
      const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined);
      const effort = item.effort && typeof item.effort === "object" ? item.effort as { supported_levels?: unknown; default_level?: unknown } : undefined;
      const levels = Array.isArray(effort?.supported_levels) ? effort.supported_levels.filter((level): level is string => typeof level === "string") : undefined;
      const modalities = Array.isArray(item.input_modalities) ? item.input_modalities.filter((value): value is string => value === "text" || value === "image") : undefined;
      const contextWindow = num(item.context_window) ?? known?.contextWindow ?? DEFAULT_MODEL_PROFILE.contextWindow;
      let maxOutput = num(item.max_output_tokens) ?? known?.maxOutput ?? DEFAULT_MODEL_PROFILE.maxOutput;
      if (maxOutput >= contextWindow) maxOutput = Math.floor(contextWindow / 2);
      models.push({
        id, name: known?.name ?? remoteName ?? id, description: known?.description ?? "", contextWindow, maxOutput,
        inputTypes: modalities?.length ? modalities : known?.inputTypes ?? ["text"],
        reasoningLevels: levels ?? known?.reasoningLevels ?? [], defaultLevel: typeof effort?.default_level === "string" ? effort.default_level : known?.defaultLevel ?? null,
        inCatalog: Boolean(known), listed: true, suggested: known?.suggested ?? false,
      });
    }
    // A catalogue model the service no longer lists is still shown, marked, so the person sees it is gone.
    for (const model of catalog) if (!models.some((item) => item.id === model.id)) models.push({ ...model, listed: false, suggested: false });
    return { ok: true as const, verified: true, models };
  } catch (error) {
    if (signal.aborted) throw new MangaError("CANCELLED", "request cancelled", { retryable: true });
    if (error instanceof MangaError && error.code === "PROVIDER_UNAVAILABLE" && (error.details as { reason?: string } | undefined)?.reason === "plugin_disabled") throw error;
    return { ok: false as const, verified: false, failure: failureOf(error), models: catalog };
  } finally {
    tracked.release();
  }
}

const EFFORTS = new Set(["minimal", "low", "medium", "high", "max"]);

/** The profile a model is added with: the service's numbers (or the catalogue's), its declared levels, thinking at its default level, its dialect. */
function profileFor(entry: ProviderEntry, model: DiscoveredModel | undefined, catalog: ProviderModel | undefined): ModelProfile {
  const levels = (model?.reasoningLevels ?? catalog?.reasoning?.levels ?? []).filter((level) => EFFORTS.has(level)) as ReasoningEffort[];
  const defaultLevel = (model?.defaultLevel ?? catalog?.reasoning?.default ?? null) as ReasoningEffort | null;
  const capabilities = [...new Set([...(catalog?.capabilities ?? ["tools"]), ...(levels.length ? ["reasoning" as const] : [])])];
  return applyProfile(DEFAULT_MODEL_PROFILE, {
    contextWindow: model?.contextWindow ?? catalog?.contextWindow,
    maxOutput: model?.maxOutput ?? catalog?.maxOutput,
    inputTypes: (model?.inputTypes ?? catalog?.inputTypes ?? ["text"]) as ModelProfile["inputTypes"],
    capabilities,
    reasoningEffort: levels.length ? (defaultLevel && levels.includes(defaultLevel) ? defaultLevel : levels[levels.length - 1]!) : null,
    ...(entry.file.dialect ? { dialect: entry.file.dialect } : {}),
    ...(levels.length ? { reasoningLevels: levels } : {}),
  }, "detected");
}

/**
 * Creates the account (or uses an existing one) and the chosen connections in one transaction (计划 4.2 step 4). Every connection refers to the account's one
 * credential. A new connection becomes the default of its purpose only by being the first of it: what the person already uses is left as it is (Q-41 第 4 项).
 */
export async function addFromProvider(app: ProvidersHost, envelope: CommandEnvelope, signal: AbortSignal) {
  app.assertWritable();
  const input = envelope.input as { providerRef: string; accountId?: string; credentialHandle?: string; label?: string; models: string[]; services: ProviderServiceKind[]; verified?: boolean };
  const entry = app.providers.require(input.providerRef);
  if (!input.models.length && !input.services.length) throw new MangaError("VALIDATION_ERROR", "choose at least one model or service", { details: { reason: "empty" } });
  for (const kind of input.services) if (!entry.file.services.some((service) => service.kind === kind)) throw new MangaError("VALIDATION_ERROR", "the provider does not offer that service", { details: { reason: "service", kind } });
  // The numbers come from the service's list when it could be read; otherwise from the catalogue, recorded as not checked online.
  const discovered = input.verified === false ? undefined : await discoverModels(app, { ...envelope, input: { providerRef: input.providerRef, accountId: input.accountId, credentialHandle: input.credentialHandle } }, signal).catch((error) => {
    if (signal.aborted || (error instanceof MangaError && (error.code === "CANCELLED" || error.code === "PROVIDER_UNAVAILABLE"))) throw error;
    return undefined;
  });
  // Re-verify the provider plugin is still enabled after discovery finishes.
  app.providers.require(input.providerRef);
  const known = discovered?.ok ? discovered.models : undefined;
  for (const id of input.models) {
    if (!entry.file.models.some((model) => model.id === id) && !known?.some((model) => model.id === id && model.listed)) throw new MangaError("VALIDATION_ERROR", "the provider does not list that model", { details: { reason: "model", model: id } });
  }
  let accountId = input.accountId;
  let credentialRef: string | null = null;
  let createdCredential = false;
  if (accountId) {
    const account = app.store.sqlite.prepare("SELECT provider_ref, credential_ref FROM provider_accounts WHERE id = ?").get(accountId) as { provider_ref: string; credential_ref: string | null } | undefined;
    if (!account || account.provider_ref !== entry.ref) throw new MangaError("NOT_FOUND", "account missing");
    credentialRef = account.credential_ref;
  } else {
    if (!input.credentialHandle) throw new MangaError("VALIDATION_ERROR", "a key is needed for a new account", { details: { reason: "key" } });
    const handle = input.credentialHandle;
    credentialRef = await saveCredential(app, () => {
      const secret = app.secrets.get(handle);
      if (!secret) throw new MangaError("FORBIDDEN", "credential handle is not authorized");
      app.secrets.delete(handle);
      return secret;
    });
    createdCredential = true;
  }
  const runtime = currentRuntime(app);
  const now = new Date().toISOString();
  const created: Array<{ id: string; purpose: string; modelId: string }> = [];
  const insert = app.store.sqlite.prepare(`INSERT INTO provider_connections(id,label,adapter_id,protocol,runtime,base_url,credential_ref,timeout_ms,purpose,model_id,verified_capabilities_json,profile_json,created_at,account_id,provider_model)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  try {
    app.store.sqlite.transaction(() => {
      if (!accountId) {
        accountId = createId("acct");
        app.store.sqlite.prepare("INSERT INTO provider_accounts(id, provider_ref, label, credential_ref, created_at) VALUES (?,?,?,?,?)").run(accountId, entry.ref, input.label?.trim() || entry.file.name, credentialRef, now);
      }
      for (const id of input.models) {
        const catalog = entry.file.models.find((model) => model.id === id);
        const profile = checkedProfile(app, profileFor(entry, known?.find((model) => model.id === id), catalog));
        const connectionId = createId("conn");
        insert.run(connectionId, `${entry.file.name} · ${catalog?.name ?? id}`, "openai-chat-completions", "openai-chat-completions", runtime, entry.baseUrl, credentialRef, 120_000, "text", id, "[]", JSON.stringify(profile), now, accountId, id);
        created.push({ id: connectionId, purpose: "text", modelId: id });
      }
      for (const kind of input.services) {
        const service = entry.file.services.find((item) => item.kind === kind)!;
        const profile = kind === "transcription" ? applyProfile(DEFAULT_MODEL_PROFILE, { transcriptionInterface: "deepseek_asr", capabilities: [] }, "detected") : applyProfile(DEFAULT_MODEL_PROFILE, { capabilities: [] }, "detected");
        const connectionId = createId("conn");
        const modelId = service.adapter.replace(/@\d+$/, "");
        insert.run(connectionId, `${entry.file.name} · ${service.name || SERVICE_NAMES[kind]}`, service.adapter, "openai-chat-completions", runtime, entry.baseUrl, credentialRef, kind === "transcription" ? 120_000 : 60_000, SERVICE_PURPOSE[kind], modelId, "[]", JSON.stringify(profile), now, accountId, kind);
        created.push({ id: connectionId, purpose: SERVICE_PURPOSE[kind], modelId });
      }
    })();
  } catch (error) {
    if (createdCredential && credentialRef) app.store.sqlite.prepare("DELETE FROM credentials WHERE ref = ?").run(credentialRef);
    throw error;
  }
  app.notify("settings.changed", {});
  return { accountId: accountId!, connections: created, verified: Boolean(discovered?.ok && discovered.verified) };
}

/** A new key for an account: saved once, and every connection of the account uses it from the next request (计划 4.2). */
export async function setAccountKey(app: ProvidersHost, envelope: CommandEnvelope) {
  app.assertWritable();
  const input = envelope.input as { accountId: string; credentialHandle: string };
  const account = app.store.sqlite.prepare("SELECT credential_ref FROM provider_accounts WHERE id = ?").get(input.accountId) as { credential_ref: string | null } | undefined;
  if (!account) throw new MangaError("NOT_FOUND", "account missing");
  const ref = await saveCredential(app, () => {
    const secret = app.secrets.get(input.credentialHandle);
    if (!secret) throw new MangaError("FORBIDDEN", "credential handle is not authorized");
    app.secrets.delete(input.credentialHandle);
    return secret;
  });
  app.store.sqlite.transaction(() => {
    app.store.sqlite.prepare("UPDATE provider_accounts SET credential_ref = ? WHERE id = ?").run(ref, input.accountId);
    app.store.sqlite.prepare("UPDATE provider_connections SET credential_ref = ? WHERE account_id = ?").run(ref, input.accountId);
    if (account.credential_ref) app.store.sqlite.prepare("DELETE FROM credentials WHERE ref = ?").run(account.credential_ref);
  })();
  app.notify("settings.changed", {});
  return { accountId: input.accountId, connections: Number((app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_connections WHERE account_id = ?").get(input.accountId) as { n: number }).n) };
}

/** Removes an account and its key, once no connection uses it (计划 4.2). */
export function deleteAccount(app: ProvidersHost, envelope: CommandEnvelope) {
  app.assertWritable();
  const input = envelope.input as { accountId: string };
  const account = app.store.sqlite.prepare("SELECT credential_ref FROM provider_accounts WHERE id = ?").get(input.accountId) as { credential_ref: string | null } | undefined;
  if (!account) throw new MangaError("NOT_FOUND", "account missing");
  const used = Number((app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_connections WHERE account_id = ?").get(input.accountId) as { n: number }).n);
  if (used) throw new MangaError("VALIDATION_ERROR", "先删除这个账户下的连接，再删除账户", { details: { reason: "in_use", connections: used } });
  app.store.sqlite.transaction(() => {
    app.store.sqlite.prepare("DELETE FROM provider_accounts WHERE id = ?").run(input.accountId);
    if (account.credential_ref) app.store.sqlite.prepare("DELETE FROM credentials WHERE ref = ?").run(account.credential_ref);
  })();
  app.notify("settings.changed", {});
  return { ok: true, credentialRemoved: Boolean(account.credential_ref) };
}
