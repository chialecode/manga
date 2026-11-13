import fs from "node:fs";
import path from "node:path";
import type { PluginManifest } from "@manga/contracts";
import { startMockDeepSeek, type MockDeepSeekOptions } from "@manga/model-protocol";
import { buildPluginPackage } from "../../packages/app-core/src/plugins/package.ts";
import { startApp, tempProfile } from "./app.ts";
import { makeKey, tmpDir, type TestKey } from "./plugin-fixtures.ts";

/**
 * A DeepSeek provider for tests (计划 4.1/4.2): the bundled provider file in a test-signed package, the fake service on this machine as the provider's origin,
 * and an app with the plugin installed and its models and services added under one account. No request leaves the machine.
 */
export const PROVIDER_JSON = fs.readFileSync(path.join(import.meta.dirname, "../../plugins/provider-deepseek/provider.json"), "utf8");
export const PROVIDER_REF = "demo.provider/deepseek";
export const PROVIDER_KEY = "sk-test-provider-1";
export const providerPublisher = makeKey("提供方发布者（测试）");

export function providerManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    format: "manga-plugin-v1", id: "demo.provider", name: "演示提供方", version: "1.0.0", publisher: { id: "demo", name: "演示发布者" },
    description: "只用于测试的提供方插件", host: { min: "0.0.0" }, permissions: ["network"], entry: null,
    provides: [{ slot: "model.provider", id: "deepseek" }], facets: [], provider: "provider.json", ...overrides,
  } as PluginManifest;
}

export function providerPackage(options: { manifest?: Partial<PluginManifest>; provider?: string | null; key?: TestKey } = {}): Buffer {
  const files: Record<string, string> = {};
  if (options.provider !== null) files["provider.json"] = options.provider ?? PROVIDER_JSON;
  return buildPluginPackage({ manifest: providerManifest(options.manifest), files, privateKeyPem: (options.key ?? providerPublisher).privateKeyPem });
}

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;
export const call = (ctx: App, commandId: string, input: Record<string, unknown>) => {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `pf-${counter}`, input }, ctx.grant.handle);
};
const value = async <T>(pending: ReturnType<typeof call>): Promise<T> => {
  const result = await pending;
  if (result.status !== "ok") throw new Error(JSON.stringify(result));
  return result.value as T;
};

/** An app with the provider plugin installed and enabled, and (unless `add` is empty) its models and services added; the fake service runs beside it. */
export async function deepseekApp(options: { mock?: MockDeepSeekOptions; add?: { models: string[]; services: string[] }; app?: NonNullable<Parameters<typeof startApp>[0]>["options"] } = {}) {
  const server = await startMockDeepSeek({ key: PROVIDER_KEY, ...options.mock });
  const ctx = await startApp({ profileRoot: tempProfile(), options: { ...options.app, providers: { testOrigin: server.url } } });
  await value(call(ctx, "plugin.trust.add", { publicKey: providerPublisher.publicKey, label: providerPublisher.label }));
  const file = path.join(tmpDir(), "provider.manga-plugin");
  fs.writeFileSync(file, providerPackage());
  await value(call(ctx, "plugin.install", { pathHandle: ctx.app.registerPath("file", file), grant: ["network"] }));
  const add = options.add ?? { models: ["deepseek-flash"], services: ["transcription", "speech", "search"] };
  const added = add.models.length || add.services.length
    ? await value<{ accountId: string; connections: Array<{ id: string; purpose: string; modelId: string }> }>(call(ctx, "providers.add", { providerRef: PROVIDER_REF, credentialHandle: ctx.app.stashSecret(PROVIDER_KEY), models: add.models, services: add.services, verified: false }))
    : { accountId: "", connections: [] };
  const connection = (purpose: string) => added.connections.find((item) => item.purpose === purpose)?.id;
  return {
    ctx, server, added, connection,
    close: async () => { try { ctx.app.close(); } catch { /* closed already */ } await server.close(); },
  };
}
