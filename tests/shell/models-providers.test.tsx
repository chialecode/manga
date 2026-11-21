/** @vitest-environment jsdom */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { startMockDeepSeek } from "@manga/model-protocol";
import { buildPluginPackage } from "../../packages/app-core/src/plugins/package.ts";
import { ModelsPage, type ProviderActions } from "../../apps/desktop/src/renderer/pages/settings/models-page.tsx";
import { PluginsPage } from "../../apps/desktop/src/renderer/pages/settings/plugins-page.tsx";
import { startApp, tempProfile } from "../helpers/app.ts";
import { makeKey, tmpDir } from "../helpers/plugin-fixtures.ts";
import { bridgeToApp } from "../helpers/ui-host.ts";

/**
 * Live reactivity and restart persistence between the Plugins page and the Models page for `manga.provider-deepseek`
 * (items #4 and #5: live `plugin.changed` / `settings.changed` sync, model discovery & probing, and clearing stale `"provider"` failures).
 */

const i18n = createTranslator("zh-CN");
const first = makeKey("MANGA（第一方，测试）");
const KEY = "sk-ui-deepseek-test";
const PLUGIN_MANIFEST = (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../plugins/provider-deepseek/plugin.json"), "utf8")) as { manifest: unknown }).manifest;
const PROVIDER_JSON = fs.readFileSync(path.join(import.meta.dirname, "../../plugins/provider-deepseek/provider.json"), "utf8");

type App = Awaited<ReturnType<typeof startApp>>;
const apps: App[] = [];
const closers: Array<() => Promise<void> | void> = [];
const disposers: Array<() => void> = [];

afterEach(async () => {
  cleanup();
  while (disposers.length) disposers.pop()!();
  while (apps.length) { try { apps.pop()!.app.close(); } catch { /* closed */ } }
  while (closers.length) await closers.pop()!();
});

function writeBundledDeepSeek(): string {
  const dir = tmpDir();
  const pkg = buildPluginPackage({ manifest: PLUGIN_MANIFEST, files: { "provider.json": PROVIDER_JSON }, privateKeyPem: first.privateKeyPem });
  fs.writeFileSync(path.join(dir, "manga.provider-deepseek.manga-plugin"), pkg);
  return dir;
}

let seq = 0;
function callApp<T = Record<string, unknown>>(ctx: App, commandId: string, input: Record<string, unknown> = {}): Promise<T> {
  seq += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `mp-${seq}`, input }, ctx.grant.handle).then((res) => {
    expect(res.status, JSON.stringify(res)).toBe("ok");
    return res.value as T;
  });
}

async function mountPages(ctx: App) {
  const bridge = bridgeToApp(ctx, { stashSecret: async (secret: string) => ctx.app.stashSecret(secret) });
  disposers.push(bridge.dispose);
  const initialSettings = await callApp<Record<string, unknown>>(ctx, "settings.get");
  const initialProviders = await callApp<NonNullable<ProviderActions["providers"]>>(ctx, "providers.list");
  // Mount PluginsPage and ModelsPage with static initial props so live updates must flow through `window.manga.onNotice`.
  const view = render(
    <div>
      <PluginsPage t={i18n.t} formatDate={(iso) => iso.slice(0, 10)} onModulesChanged={() => undefined} onError={() => undefined} onNotice={() => undefined} />
      <ModelsPage
        i18n={i18n}
        settings={initialSettings}
        providers={initialProviders}
        onRuntime={vi.fn(async () => undefined)}
        onSaveConnection={vi.fn(async () => ({ ok: true as const, id: "x" }))}
        onDeleteConnection={async (connectionId) => { await callApp(ctx, "connections.delete", { connectionId }); }}
        onTestConnection={async (connectionId, capability) => {
          const out = await callApp<{ ok: boolean; latencyMs?: number }>(ctx, "connections.test", { connectionId, capability });
          return { ok: out.ok, message: out.ok ? "测试通过" : "测试未通过" };
        }}
        onProbeConnection={async (connectionId) => { await callApp(ctx, "connections.probe", { connectionId }); }}
        onSkip={vi.fn()}
        onDiscover={async ({ providerRef, accountId, secret }) => callApp(ctx, "providers.discover", {
          providerRef, ...(accountId ? { accountId } : {}), ...(secret ? { credentialHandle: ctx.app.stashSecret(secret) } : {}),
        })}
        onAddFromProvider={async (input) => {
          const out = await callApp<{ connections: unknown[] }>(ctx, "providers.add", {
            providerRef: input.providerRef,
            ...(input.accountId ? { accountId: input.accountId } : {}),
            ...(input.secret ? { credentialHandle: ctx.app.stashSecret(input.secret) } : {}),
            models: input.models,
            services: input.services,
            verified: input.verified,
          });
          return { ok: true as const, count: out.connections.length };
        }}
        onSetAccountKey={async (accountId, secret) => {
          await callApp(ctx, "providers.setKey", { accountId, credentialHandle: ctx.app.stashSecret(secret) });
          return null;
        }}
        onDeleteAccount={async (accountId) => { await callApp(ctx, "providers.deleteAccount", { accountId }); }}
        onOpenPlugins={vi.fn()}
        onOpenLink={vi.fn()}
      />
    </div>,
  );
  await screen.findByTestId("settings-page-plugins");
  return { view, bridge };
}

describe("DeepSeek provider plugin live sync and restart persistence on ModelsPage", () => {
  it("live-updates ModelsPage on install, discovers and adds models, and passes model probe and service test without manual reload", async () => {
    const server = await startMockDeepSeek({ key: KEY });
    closers.push(() => server.close());
    const bundledDir = writeBundledDeepSeek();
    const ctx = await startApp({
      options: {
        plugins: { firstPartyKeys: [{ publicKey: first.publicKey, label: first.label }], bundledDir },
        providers: { testOrigin: server.url },
      },
    });
    apps.push(ctx);
    await mountPages(ctx);

    // Before installing, ModelsPage offers DeepSeek as not-installed.
    expect(screen.getByTestId("models-offer-manga.provider-deepseek").getAttribute("data-state")).toBe("not-installed");

    // Install bundled DeepSeek on PluginsPage.
    fireEvent.click(await screen.findByTestId("plugin-bundled-manga.provider-deepseek-install"));
    await screen.findByTestId("plugin-install");
    fireEvent.click(screen.getByTestId("plugin-confirm-network"));
    fireEvent.click(screen.getByTestId("plugin-install-do"));
    await waitFor(() => expect(screen.queryByTestId("plugin-install")).toBeNull());

    // ModelsPage live-updates without manual reload: the not-installed banner disappears and 添加模型 becomes a provider menu.
    await waitFor(() => expect(screen.queryByTestId("models-offer-manga.provider-deepseek")).toBeNull());
    fireEvent.click(screen.getByTestId("models-add"));
    fireEvent.click(await screen.findByTestId("models-add-provider-deepseek"));

    // Read models online and add suggested models + services.
    fireEvent.change(await screen.findByTestId("provider-key"), { target: { value: KEY } });
    fireEvent.click(screen.getByTestId("provider-discover"));
    await waitFor(() => expect(screen.getByTestId("provider-verified").getAttribute("data-verified")).toBe("yes"));
    fireEvent.click(screen.getByTestId("provider-add"));
    await waitFor(() => expect(screen.queryByTestId("provider-dialog")).toBeNull());

    // Account and connections appear live on ModelsPage; probing chat model and testing speech service both pass.
    const listed = await callApp<Array<{ id: string; purpose: string; providerModel: string | null }>>(ctx, "connections.list");
    const flash = listed.find((row) => row.providerModel === "deepseek-flash")!;
    const speech = listed.find((row) => row.purpose === "speech")!;
    await screen.findByTestId(`connection-${flash.id}`);
    expect(screen.getByTestId(`connection-${flash.id}`).getAttribute("data-available")).toBe("yes");

    fireEvent.click(screen.getByTestId(`connection-probe-${flash.id}`));
    await waitFor(() => expect(screen.getByTestId(`connection-test-${flash.id}`).getAttribute("data-state")).toBe("ok"));

    fireEvent.click(screen.getByTestId(`connection-test-run-${speech.id}`));
    await waitFor(() => expect(screen.getByTestId(`connection-test-${speech.id}`).getAttribute("data-state")).toBe("ok"));
  });

  it("clears stale '插件已停用' test failures immediately on re-enable and across app restart", async () => {
    const server = await startMockDeepSeek({ key: KEY });
    closers.push(() => server.close());
    const bundledDir = writeBundledDeepSeek();
    const profileRoot = tempProfile();
    const ctx = await startApp({
      profileRoot,
      options: {
        plugins: { firstPartyKeys: [{ publicKey: first.publicKey, label: first.label }], bundledDir },
        providers: { testOrigin: server.url },
      },
    });
    apps.push(ctx);
    const { bridge } = await mountPages(ctx);

    // Install DeepSeek and add deepseek-flash.
    fireEvent.click(await screen.findByTestId("plugin-bundled-manga.provider-deepseek-install"));
    await screen.findByTestId("plugin-install");
    fireEvent.click(screen.getByTestId("plugin-confirm-network"));
    fireEvent.click(screen.getByTestId("plugin-install-do"));
    await waitFor(() => expect(screen.queryByTestId("plugin-install")).toBeNull());

    const added = await callApp<{ accountId: string; connections: Array<{ id: string }> }>(ctx, "providers.add", {
      providerRef: "manga.provider-deepseek/deepseek",
      credentialHandle: ctx.app.stashSecret(KEY),
      models: ["deepseek-flash"],
      services: [],
      verified: true,
    });
    const flashId = added.connections[0]!.id;
    await screen.findByTestId(`connection-${flashId}`);

    // Turn the plugin off on PluginsPage -> ModelsPage immediately marks the account disabled with human-readable DeepSeek name.
    fireEvent.click(screen.getByTestId("plugin-manga.provider-deepseek-toggle"));
    await waitFor(() => expect(screen.getByTestId(`account-disabled-${added.accountId}`).textContent).toContain("插件已停用"));
    expect(screen.getByTestId("models-offer-manga.provider-deepseek").textContent).toContain("DeepSeek 插件已停用");

    // Probe while disabled -> records `category: "provider"` ("插件已停用").
    await callApp(ctx, "connections.probe", { connectionId: flashId });
    await waitFor(() => expect(screen.getByTestId(`connection-test-${flashId}`).getAttribute("data-category")).toBe("provider"));

    // Re-enable on PluginsPage -> ModelsPage immediately clears both `account-disabled` and the stale "插件已停用" test failure!
    fireEvent.click(screen.getByTestId("plugin-manga.provider-deepseek-toggle"));
    await waitFor(() => expect(screen.queryByTestId(`account-disabled-${added.accountId}`)).toBeNull());
    await waitFor(() => expect(screen.getByTestId(`connection-test-${flashId}`).getAttribute("data-state")).toBe("never"));
    expect(within(screen.getByTestId(`connection-${flashId}`)).queryByText(/插件已停用/)).toBeNull();

    // Also simulate a previously affected database that still had `category: "provider"` written in SQLite before restart.
    ctx.app.store.sqlite.prepare("UPDATE provider_connections SET last_test_json = ? WHERE id = ?").run(
      JSON.stringify({ at: "2026-11-15T00:00:00.000Z", ok: false, failure: { category: "provider" } }),
      flashId,
    );
    cleanup();
    bridge.dispose();
    disposers.pop();
    ctx.app.close();
    apps.pop();

    const reopened = await startApp({
      profileRoot,
      options: {
        plugins: { firstPartyKeys: [{ publicKey: first.publicKey, label: first.label }], bundledDir },
        providers: { testOrigin: server.url },
      },
    });
    apps.push(reopened);
    await mountPages(reopened);

    expect(screen.queryByTestId(`account-disabled-${added.accountId}`)).toBeNull();
    expect(screen.getByTestId(`connection-test-${flashId}`).getAttribute("data-state")).toBe("never");
    fireEvent.click(screen.getByTestId(`connection-probe-${flashId}`));
    await waitFor(() => expect(screen.getByTestId(`connection-test-${flashId}`).getAttribute("data-state")).toBe("ok"));
  });

  it("trusts fresh settings availability on remount when props.providers is stale, filters stale 'provider' failure in ConnectionDialog, and refreshes providers on mount", async () => {
    const server = await startMockDeepSeek({ key: KEY });
    closers.push(() => server.close());
    const bundledDir = writeBundledDeepSeek();
    const ctx = await startApp({
      options: {
        plugins: { firstPartyKeys: [{ publicKey: first.publicKey, label: first.label }], bundledDir },
        providers: { testOrigin: server.url },
      },
    });
    apps.push(ctx);

    await callApp(ctx, "plugin.install", { bundledId: "manga.provider-deepseek", grant: ["network"], enable: true });
    const added = await callApp<{ accountId: string; connections: Array<{ id: string }> }>(ctx, "providers.add", {
      providerRef: "manga.provider-deepseek/deepseek",
      credentialHandle: ctx.app.stashSecret(KEY),
      models: ["deepseek-flash"],
      services: [],
      verified: true,
    });
    const flashId = added.connections[0]!.id;

    // Capture stale `providers` while disabled, then re-enable so `settings.get` has `account.available === true` while `staleProviders` still says disabled.
    await callApp(ctx, "plugin.disable", { pluginId: "manga.provider-deepseek" });
    const staleProviders = await callApp<NonNullable<ProviderActions["providers"]>>(ctx, "providers.list");
    await callApp(ctx, "plugin.enable", { pluginId: "manga.provider-deepseek" });
    const freshSettings = await callApp<Record<string, unknown>>(ctx, "settings.get");
    const seededSettings = {
      ...freshSettings,
      connections: ((freshSettings.connections as Array<Record<string, unknown>>) ?? []).map((item) => (
        item.id === flashId ? { ...item, lastTest: { at: "2026-11-15T00:00:00.000Z", ok: false, failure: { category: "provider" } } } : item
      )),
    };

    const bridge = bridgeToApp(ctx, { stashSecret: async (secret: string) => ctx.app.stashSecret(secret) });
    disposers.push(bridge.dispose);
    render(
      <ModelsPage
        i18n={i18n}
        settings={seededSettings}
        providers={staleProviders}
        onRuntime={vi.fn(async () => undefined)}
        onSaveConnection={vi.fn(async () => ({ ok: true as const, id: flashId }))}
        onDeleteConnection={vi.fn(async () => undefined)}
        onTestConnection={vi.fn(async () => ({ ok: true, message: "测试通过" }))}
        onProbeConnection={vi.fn(async () => undefined)}
        onSkip={vi.fn()}
        onDiscover={vi.fn(async () => ({ ok: true as const, verified: true, models: [] }))}
        onAddFromProvider={vi.fn(async () => ({ ok: true as const, count: 1 }))}
        onSetAccountKey={vi.fn(async () => null)}
        onDeleteAccount={vi.fn(async () => undefined)}
        onOpenPlugins={vi.fn()}
        onOpenLink={vi.fn()}
      />,
    );

    // Even on initial synchronous render (before mount reload settles), fresh `settings` wins over stale `props.providers`:
    expect(screen.queryByTestId(`account-disabled-${added.accountId}`)).toBeNull();
    expect(screen.getByTestId(`account-${added.accountId}`).getAttribute("data-available")).toBe("yes");
    expect(screen.getByTestId(`connection-${flashId}`).getAttribute("data-available")).toBe("yes");
    expect(screen.queryByTestId("models-offer-manga.provider-deepseek")).toBeNull();
    expect(screen.getByTestId(`connection-test-${flashId}`).getAttribute("data-state")).toBe("never");

    // Opening ConnectionDialog before IPC settles also suppresses the stale `"provider"` failure via `saved(id)`.
    fireEvent.click(screen.getByTestId(`connection-edit-${flashId}`));
    const dialog = screen.getByTestId("connection-dialog");
    expect(dialog.textContent).not.toContain("插件已停用");
    fireEvent.click(within(dialog).getByLabelText("关闭"));

    // Once the mount `reload()` settles, `providers.list` is also refreshed so `models-add` offers `manga.provider-deepseek`.
    await waitFor(() => {
      fireEvent.click(screen.getByTestId("models-add"));
      expect(screen.getByTestId("models-add-provider-deepseek")).toBeTruthy();
    });
  });
});
