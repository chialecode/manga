import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseProviderFile, PluginManifestSchema, type PluginManifest } from "@manga/contracts";
import { startMockDeepSeek } from "@manga/model-protocol";
import { UnavailableVault } from "../../packages/app-core/src/credentials.ts";
import { buildPluginPackage, readPluginPackage } from "../../packages/app-core/src/plugins/package.ts";
import { startApp, tempProfile } from "../helpers/app.ts";
import { makeKey, tmpDir, type TestKey } from "../helpers/plugin-fixtures.ts";

/** Provider plugins (PLUG-07, 计划 4.1/4.2, AT-184/AT-185): a declarative package, its checks, and the models it lets the person add. */

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;

const PROVIDER_JSON = fs.readFileSync(path.join(import.meta.dirname, "../../plugins/provider-deepseek/provider.json"), "utf8");
const KEY = "sk-test-provider-1";
const publisher = makeKey("提供方发布者（测试）");

const apps: App[] = [];
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (apps.length) { try { apps.pop()!.app.close(); } catch { /* closed already */ } }
  while (closers.length) await closers.pop()!();
});

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    format: "manga-plugin-v1", id: "demo.provider", name: "演示提供方", version: "1.0.0", publisher: { id: "demo", name: "演示发布者" },
    description: "只用于测试的提供方插件", host: { min: "0.0.0" }, permissions: ["network"], entry: null,
    provides: [{ slot: "model.provider", id: "deepseek" }], facets: [], provider: "provider.json", ...overrides,
  } as PluginManifest;
}
function providerText(change: (file: Record<string, any>) => void = () => {}): string {
  const file = JSON.parse(PROVIDER_JSON) as Record<string, any>;
  change(file);
  return JSON.stringify(file);
}
function bytes(options: { manifest?: Partial<PluginManifest>; provider?: string | null; key?: TestKey; version?: string } = {}): Buffer {
  const files: Record<string, string> = {};
  if (options.provider !== null) files["provider.json"] = options.provider ?? PROVIDER_JSON;
  return buildPluginPackage({ manifest: manifest({ ...(options.version ? { version: options.version } : {}), ...options.manifest }), files, privateKeyPem: (options.key ?? publisher).privateKeyPem });
}
const reason = (work: () => unknown) => {
  try { work(); } catch (error) { return (error as { details?: { reason?: string } }).details?.reason ?? String(error); }
  return "accepted";
};

let counter = 0;
async function boot(origin: string, profileRoot = tempProfile()): Promise<App> {
  const ctx = await startApp({ profileRoot, options: { providers: { testOrigin: origin } } });
  apps.push(ctx);
  return ctx;
}
function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `pv-${counter}`, input }, ctx.grant.handle);
}
const ok = <T = Record<string, any>>(result: Call): T => { expect(result.status, JSON.stringify(result)).toBe("ok"); return result.value as T; };
const fails = (result: Call) => { expect(result.status, JSON.stringify(result)).toBe("error"); return (result as { error: { code: string; message: string; details?: Record<string, unknown> } }).error; };
async function mock() {
  const server = await startMockDeepSeek({ key: KEY });
  closers.push(() => server.close());
  return server;
}
async function installProvider(ctx: App, options: Parameters<typeof bytes>[0] = {}) {
  const file = path.join(tmpDir(), "provider.manga-plugin");
  fs.writeFileSync(file, bytes(options));
  return run(ctx, "plugin.install", { pathHandle: ctx.app.registerPath("file", file), grant: ["network"] });
}
async function trusted(ctx: App) {
  return ok<{ key: { keyId: string } }>(await run(ctx, "plugin.trust.add", { publicKey: publisher.publicKey, label: publisher.label })).key.keyId;
}

describe("the provider file and the package that carries it", () => {
  it("accepts the bundled DeepSeek file", () => {
    const parsed = parseProviderFile(new TextEncoder().encode(PROVIDER_JSON));
    expect(parsed.ok).toBe(true);
  });

  it("refuses a file that names an unknown adapter, an http address, an undeclared host or an oversize file", () => {
    const problem = (text: string) => { const parsed = parseProviderFile(new TextEncoder().encode(text)); return parsed.ok ? "accepted" : "refused"; };
    expect(problem(providerText((file) => { file.models[0].adapter = "anthropic-messages"; }))).toBe("refused");
    expect(problem(providerText((file) => { file.baseUrl = "http://api.deepseek.com"; }))).toBe("refused");
    expect(problem(providerText((file) => { file.baseUrl = "https://elsewhere.example"; }))).toBe("refused");
    expect(problem(providerText((file) => { file.models[0].maxOutput = file.models[0].contextWindow; }))).toBe("refused");
    expect(problem(providerText((file) => { file.services.push(file.services[0]); }))).toBe("refused");
    expect(problem("{not json")).toBe("refused");
    expect(problem(" ".repeat(70 * 1024))).toBe("refused");
  });

  it("allows no entry only for the declarative slot, and needs the provider file with it", () => {
    const check = (value: unknown) => PluginManifestSchema.safeParse(value).success;
    expect(check(manifest())).toBe(true);
    expect(check(manifest({ entry: "main.mjs" }))).toBe(false);
    expect(check(manifest({ provider: undefined }))).toBe(false);
    expect(check(manifest({ provides: [{ slot: "acquisition.engine", id: "x" }] }))).toBe(false);
    expect(check(manifest({ provides: [{ slot: "model.provider", id: "deepseek" }, { slot: "model.provider", id: "other" }] }))).toBe(false);
  });

  it("refuses a package whose provider file is missing, invalid, a different provider, or without the network permission", () => {
    expect(reason(() => bytes({ provider: null }))).toBe("provider");
    expect(reason(() => bytes({ provider: providerText((file) => { file.baseUrl = "http://api.deepseek.com"; }) }))).toBe("provider");
    expect(reason(() => bytes({ provider: providerText((file) => { file.id = "other"; }) }))).toBe("provider");
    expect(reason(() => bytes({ manifest: { permissions: [] } }))).toBe("provider");
    expect(reason(() => readPluginPackage(bytes()))).toBe("accepted");
  });

  it("refuses a package changed after signing", () => {
    const packed = bytes();
    const at = packed.indexOf(Buffer.from("api.deepseek.com"));
    const tampered = Buffer.from(packed);
    if (at >= 0) tampered[at] = "b".charCodeAt(0); else tampered[tampered.length - 30] ^= 1;
    expect(reason(() => readPluginPackage(tampered))).not.toBe("accepted");
  });
});

describe("models from an enabled provider plugin (AT-184, AT-185)", () => {
  it("lists the provider only while the plugin is enabled and trusted, with no request while it is off", async () => {
    const server = await mock();
    const ctx = await boot(server.url);
    expect(ok(await run(ctx, "providers.list", {})).providers).toEqual([]);
    const keyId = await trusted(ctx);
    ok(await installProvider(ctx));
    const listed = ok<{ providers: Array<{ ref: string; models: Array<{ id: string }> }> }>(await run(ctx, "providers.list", {}));
    expect(listed.providers.map((item) => item.ref)).toEqual(["demo.provider/deepseek"]);
    expect(listed.providers[0]!.models.map((model) => model.id)).toContain("deepseek-flash");
    ok(await run(ctx, "plugin.disable", { pluginId: "demo.provider" }));
    const off = ok<{ providers: unknown[]; offered: Array<{ pluginId: string; state: string }> }>(await run(ctx, "providers.list", {}));
    expect(off.providers).toEqual([]);
    expect(off.offered).toContainEqual(expect.objectContaining({ pluginId: "demo.provider", state: "disabled" }));
    ok(await run(ctx, "plugin.enable", { pluginId: "demo.provider" }));
    expect(ok(await run(ctx, "providers.list", {})).providers).toHaveLength(1);
    ok(await run(ctx, "plugin.trust.remove", { keyId }));
    expect(ok(await run(ctx, "providers.list", {})).providers).toEqual([]);
    expect(server.requests.length).toBe(0);
  });

  it("adds models and services under one account with one key, and stops them while the plugin is off", async () => {
    const server = await mock();
    const ctx = await boot(server.url);
    await trusted(ctx);
    ok(await installProvider(ctx));
    const discovered = ok<{ ok: boolean; verified: boolean; models: Array<{ id: string; listed: boolean }> }>(await run(ctx, "providers.discover", { providerRef: "demo.provider/deepseek", credentialHandle: ctx.app.stashSecret(KEY) }));
    expect(discovered).toMatchObject({ ok: true, verified: true });
    expect(discovered.models.find((model) => model.id === "deepseek-flash")?.listed).toBe(true);
    const added = ok<{ accountId: string; connections: Array<{ id: string; purpose: string }>; verified: boolean }>(await run(ctx, "providers.add", {
      providerRef: "demo.provider/deepseek", credentialHandle: ctx.app.stashSecret(KEY), models: ["deepseek-flash", "deepseek-v4-pro"], services: ["speech", "search"],
    }));
    expect(added.verified).toBe(true);
    expect(added.connections.map((item) => item.purpose).sort()).toEqual(["search", "speech", "text", "text"]);
    const refs = ctx.app.store.sqlite.prepare("SELECT DISTINCT credential_ref FROM provider_connections WHERE account_id = ?").all(added.accountId) as unknown[];
    expect(refs).toHaveLength(1);
    const rows = ok<Array<{ id: string; label: string; account: { id: string; available: boolean } | null; providerModel: string | null }>>(await run(ctx, "connections.list", {}));
    const flash = rows.find((row) => row.providerModel === "deepseek-flash")!;
    expect(flash.label).toBe("DeepSeek · DeepSeek V4.1 Flash");
    expect(flash.account).toMatchObject({ id: added.accountId, available: true });

    // The profile keeps the declared levels and the dialect.
    const profile = JSON.parse((ctx.app.store.sqlite.prepare("SELECT profile_json FROM provider_connections WHERE id = ?").get(flash.id) as { profile_json: string }).profile_json);
    expect(profile).toMatchObject({ dialect: "deepseek", reasoningLevels: ["low", "high", "max"], reasoningEffort: "high" });

    const search = added.connections.find((item) => item.purpose === "search")!;
    expect(ok(await run(ctx, "connections.test", { connectionId: search.id, capability: "search" }))).toMatchObject({ ok: true });
    const usage = ctx.app.store.sqlite.prepare("SELECT service, unit, quantity, status FROM service_usage").all();
    expect(usage).toContainEqual(expect.objectContaining({ service: "search", status: "ok" }));

    ok(await run(ctx, "plugin.disable", { pluginId: "demo.provider" }));
    const before = server.requests.length;
    const refused = fails(await run(ctx, "connections.test", { connectionId: search.id, capability: "search" }));
    expect(refused).toMatchObject({ code: "PROVIDER_UNAVAILABLE", message: "插件已停用：去插件页启用" });
    expect(fails(await run(ctx, "connections.test", { connectionId: flash.id, capability: "text" })).details?.reason).toBe("plugin_disabled");
    expect(server.requests.length).toBe(before);
    // The connections and the account stay, shown as unavailable.
    const offRows = ok<Array<{ account: { available: boolean } | null }>>(await run(ctx, "connections.list", {}));
    expect(offRows.filter((row) => row.account)).toHaveLength(4);
    expect(offRows.every((row) => !row.account || row.account.available === false)).toBe(true);
  });

  it("changes the key of every connection of the account at once, keeps the key when one connection goes, and removes the account only when empty", async () => {
    const server = await mock();
    const ctx = await boot(server.url);
    await trusted(ctx);
    ok(await installProvider(ctx));
    const added = ok<{ accountId: string; connections: Array<{ id: string }> }>(await run(ctx, "providers.add", {
      providerRef: "demo.provider/deepseek", credentialHandle: ctx.app.stashSecret("sk-wrong"), models: ["deepseek-flash"], services: ["search"], verified: false,
    }));
    const search = added.connections[1]!.id;
    expect(ok(await run(ctx, "connections.test", { connectionId: search, capability: "search" }))).toMatchObject({ ok: false });
    ok(await run(ctx, "providers.setKey", { accountId: added.accountId, credentialHandle: ctx.app.stashSecret(KEY) }));
    expect(ok(await run(ctx, "connections.test", { connectionId: search, capability: "search" }))).toMatchObject({ ok: true });
    expect(fails(await run(ctx, "providers.deleteAccount", { accountId: added.accountId })).details?.reason).toBe("in_use");
    ok(await run(ctx, "connections.delete", { connectionId: added.connections[0]!.id }));
    expect(ok(await run(ctx, "connections.test", { connectionId: search, capability: "search" }))).toMatchObject({ ok: true });
    ok(await run(ctx, "connections.delete", { connectionId: search }));
    expect(ok(await run(ctx, "providers.deleteAccount", { accountId: added.accountId }))).toMatchObject({ ok: true, credentialRemoved: true });
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM provider_accounts").get()).toEqual({ n: 0 });
  });

  it("refuses to move a provider connection to another address or model", async () => {
    const server = await mock();
    const ctx = await boot(server.url);
    await trusted(ctx);
    ok(await installProvider(ctx));
    const added = ok<{ connections: Array<{ id: string }> }>(await run(ctx, "providers.add", { providerRef: "demo.provider/deepseek", credentialHandle: ctx.app.stashSecret(KEY), models: ["deepseek-flash"], services: [], verified: false }));
    const id = added.connections[0]!.id;
    const moved = await run(ctx, "connections.upsert", { id, label: "x", protocol: "openai-chat-completions", baseUrl: "https://elsewhere.example/v1", modelId: "deepseek-flash", purpose: "text" });
    expect(moved.status).toBe("error");
  });

  it("keeps connections across uninstall and reinstall, unavailable in between", async () => {
    const server = await mock();
    const profileRoot = tempProfile();
    const ctx = await boot(server.url, profileRoot);
    await trusted(ctx);
    ok(await installProvider(ctx));
    const added = ok<{ connections: Array<{ id: string }> }>(await run(ctx, "providers.add", { providerRef: "demo.provider/deepseek", credentialHandle: ctx.app.stashSecret(KEY), models: [], services: ["search"], verified: false }));
    ok(await run(ctx, "plugin.uninstall", { pluginId: "demo.provider" }));
    const before = server.requests.length;
    expect(ok<any[]>(await run(ctx, "connections.list", {})).find((row: { id: string }) => row.id === added.connections[0]!.id).account.available).toBe(false);
    fails(await run(ctx, "connections.test", { connectionId: added.connections[0]!.id, capability: "search" }));
    expect(server.requests.length).toBe(before);
    ok(await installProvider(ctx, { version: "1.0.1" }));
    expect(ok(await run(ctx, "connections.test", { connectionId: added.connections[0]!.id, capability: "search" }))).toMatchObject({ ok: true });
    // After a restart the enabled provider is found again.
    ctx.app.close();
    apps.splice(apps.indexOf(ctx), 1);
    const again = await boot(server.url, profileRoot);
    expect(ok(await run(again, "providers.list", {})).providers).toHaveLength(1);
  });

  it("allows TUN Fake-IP (198.18.0.0/15) and CGNAT (100.64.0.0/10) for declared HTTPS provider hosts while blocking private LAN, loopback and undeclared hosts", async () => {
    let resolved = ["198.18.1.87"];
    const ctx = await startApp({
      options: {
        providers: {
          lookup: async () => resolved,
        },
      },
    });
    apps.push(ctx);
    await trusted(ctx);
    ok(await installProvider(ctx));
    const entry = ctx.app.providers.require("demo.provider/deepseek");

    // TUN Fake-IP (Clash / Mihomo / Sing-Box / Surge), hex-mapped Fake-IP, and CGNAT succeed for declared HTTPS host.
    await expect(ctx.app.providers.checkAddress(entry, "https://api.deepseek.com/models")).resolves.toBeUndefined();
    resolved = ["::ffff:c612:157"];
    await expect(ctx.app.providers.checkAddress(entry, "https://api.deepseek.com/models")).resolves.toBeUndefined();
    resolved = ["100.64.0.10"];
    await expect(ctx.app.providers.checkAddress(entry, "https://api.deepseek.com/chat/completions")).resolves.toBeUndefined();

    // Loopback, RFC1918 LAN, IPv6 ULA, NAT64 well-known prefix, and hex-form IPv4-mapped loopback/LAN are rejected.
    for (const privateIp of ["127.0.0.1", "192.168.1.10", "::1", "fd00::1", "fc00::1", "64:ff9b::1", "::ffff:7f00:1", "::ffff:c0a8:10a"]) {
      resolved = [privateIp];
      await expect(ctx.app.providers.checkAddress(entry, "https://api.deepseek.com/models")).rejects.toMatchObject({ code: "FORBIDDEN", details: { reason: "private_address" } });
    }

    // Plain HTTP, embedded credentials, and undeclared hosts are rejected before network access.
    resolved = ["198.18.1.87"];
    await expect(ctx.app.providers.checkAddress(entry, "http://api.deepseek.com/models")).rejects.toMatchObject({ code: "FORBIDDEN", details: { reason: "provider_host" } });
    const credentialUrl = ["https://", "user", ":", "secret", "@api.deepseek.com/models"].join("");
    await expect(ctx.app.providers.checkAddress(entry, credentialUrl)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(ctx.app.providers.checkAddress(entry, "https://elsewhere.example.com/models")).rejects.toMatchObject({ code: "FORBIDDEN", details: { reason: "provider_host" } });
  });

  it("reports non-plugin probe errors accurately, names disabled providers by manifest name, and clears stale 'provider' failures on enable and restart", async () => {
    const server = await mock();
    const profileRoot = tempProfile();
    const ctx = await boot(server.url, profileRoot);
    await trusted(ctx);
    ok(await installProvider(ctx));
    const added = ok<{ connections: Array<{ id: string; purpose: string }> }>(await run(ctx, "providers.add", {
      providerRef: "demo.provider/deepseek",
      credentialHandle: ctx.app.stashSecret(KEY),
      models: ["deepseek-flash"],
      services: ["transcription", "speech", "search"],
      verified: true,
    }));
    const flashId = added.connections.find((item) => item.purpose === "text")!.id;

    // When the plugin is disabled, `offered` carries the manifest's human-readable name ("演示提供方"), not the raw slot id ("deepseek").
    ok(await run(ctx, "plugin.disable", { pluginId: "demo.provider" }));
    const offList = ok<{ offered: Array<{ pluginId: string; name: string; state: string }> }>(await run(ctx, "providers.list", {}));
    expect(offList.offered).toContainEqual({ pluginId: "demo.provider", name: "演示提供方", state: "disabled" });

    // Probing while disabled records `category: "provider"`.
    const disabledProbe = ok<{ ok: boolean; failure?: { category: string } }>(await run(ctx, "connections.probe", { connectionId: flashId }));
    expect(disabledProbe).toMatchObject({ ok: false, failure: { category: "provider" } });

    // Re-enabling immediately clears the stale `provider` failure in both `connections.list` and `settings.get`.
    ok(await run(ctx, "plugin.enable", { pluginId: "demo.provider" }));
    const liveRows = ok<Array<{ id: string; lastTest: unknown }>>(await run(ctx, "connections.list", {}));
    expect(liveRows.find((row) => row.id === flashId)?.lastTest).toBeNull();

    // Seed a stale `provider` failure into SQLite to simulate a pre-fix database, then restart the app on the same profileRoot.
    ctx.app.store.sqlite.prepare("UPDATE provider_connections SET last_test_json = ? WHERE id = ?").run(
      JSON.stringify({ at: "2026-11-15T00:00:00.000Z", ok: false, failure: { category: "provider" } }),
      flashId,
    );
    ctx.app.close();
    apps.splice(apps.indexOf(ctx), 1);

    const reopened = await boot(server.url, profileRoot);
    const afterRestart = ok<Array<{ id: string; lastTest: unknown; account: { available: boolean } | null }>>(await run(reopened, "connections.list", {}));
    const flashAfter = afterRestart.find((row) => row.id === flashId)!;
    expect(flashAfter.account?.available).toBe(true);
    expect(flashAfter.lastTest).toBeNull();
    expect(ok(await run(reopened, "connections.probe", { connectionId: flashId }))).toMatchObject({ ok: true });

    // `secretFor` / `connections.test` releases its `ProviderRegistry.inflight` controller once finished (zero leaked controllers).
    const searchId = added.connections.find((item) => item.purpose === "search")!.id;
    expect(ok(await run(reopened, "connections.test", { connectionId: searchId, capability: "search" }))).toMatchObject({ ok: true });
    expect(ok(await run(reopened, "connections.test", { connectionId: flashId, capability: "text" }))).toMatchObject({ ok: true });
    reopened.app.store.sqlite.prepare("UPDATE plugins SET enabled = 0 WHERE id = 'demo.provider'").run();
    expect(reopened.app.providers.cancelUnavailable()).toBe(0);
    reopened.app.store.sqlite.prepare("UPDATE plugins SET enabled = 1 WHERE id = 'demo.provider'").run();

    // If the credential vault is unavailable on another host, probing reports `auth` — never false `provider` ("插件已停用").
    reopened.app.close();
    apps.splice(apps.indexOf(reopened), 1);
    const lockedVault = await startApp({ profileRoot, options: { vault: new UnavailableVault(), providers: { testOrigin: server.url } } });
    apps.push(lockedVault);
    const authProbe = ok<{ ok: boolean; failure?: { category: string } }>(await run(lockedVault, "connections.probe", { connectionId: flashId }));
    expect(authProbe).toMatchObject({ ok: false, failure: { category: "auth" } });
  });
});
