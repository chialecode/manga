import { afterEach, describe, expect, it } from "vitest";
import type { ProviderCapabilities } from "@manga/contracts";
import { startApp, tempProfile } from "../helpers/app.ts";
import { call, deepseekApp, PROVIDER_REF } from "../helpers/provider-fixture.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) {
    try { await closers.pop()!(); } catch { /* ignore */ }
  }
});

describe("providers.capabilities, providers.balance, and fetch/ocr services", () => {
  it("computes accurate main-process ProviderCapabilities across bare, flash, v4-pro, and disabled plugin states", async () => {
    // 1. Bare app with no connections: nothing available.
    const bare = await startApp({ profileRoot: tempProfile() });
    closers.push(async () => { bare.app.close(); });
    const bareCaps = await call(bare, "providers.capabilities", {});
    expect(bareCaps.status, JSON.stringify(bareCaps)).toBe("ok");
    expect(bareCaps.value as ProviderCapabilities).toMatchObject({
      hasAvailableTextModel: false,
      webSearchAvailable: false,
      nativeWebSearchAvailable: false,
      standaloneWebSearchAvailable: false,
      readUrlAvailable: false,
      speechAvailable: false,
      speechVoices: [],
      streamingTtsAvailable: false,
      fetchAvailable: false,
      ocrAvailable: false,
      filesAvailable: false,
      balanceAvailable: false,
    });

    // 2. DeepSeek Flash + all services enabled.
    const rig = await deepseekApp({
      add: {
        models: ["deepseek-flash", "deepseek-v4-pro"],
        services: ["transcription", "speech", "search", "fetch", "ocr"],
      },
    });
    closers.push(rig.close);

    const flashCapsRes = await call(rig.ctx, "providers.capabilities", {});
    expect(flashCapsRes.status, JSON.stringify(flashCapsRes)).toBe("ok");
    expect(flashCapsRes.value as ProviderCapabilities).toMatchObject({
      hasAvailableTextModel: true,
      webSearchAvailable: true,
      nativeWebSearchAvailable: true,
      standaloneWebSearchAvailable: true,
      readUrlAvailable: true,
      speechAvailable: true,
      speechVoices: [
        expect.objectContaining({ id: "stella" }),
        expect.objectContaining({ id: "tide" }),
      ],
      streamingTtsAvailable: true,
      fetchAvailable: true,
      ocrAvailable: true,
      filesAvailable: true,
      balanceAvailable: true,
      activeTextModelId: "deepseek-flash",
      activeTextDialect: "deepseek",
    });

    // 3. Switch active chat model to deepseek-v4-pro: native search, read_url, and files become false while standalone search stays true.
    const proConn = rig.added.connections.find((c) => c.purpose === "text" && c.modelId === "deepseek-v4-pro")!;
    const setAgent = await call(rig.ctx, "settings.setAgent", { chat: { connectionId: proConn.id } });
    expect(setAgent.status, JSON.stringify(setAgent)).toBe("ok");
    const proCapsRes = await call(rig.ctx, "providers.capabilities", {});
    expect(proCapsRes.value as ProviderCapabilities).toMatchObject({
      hasAvailableTextModel: true,
      webSearchAvailable: true,
      nativeWebSearchAvailable: false,
      standaloneWebSearchAvailable: true,
      readUrlAvailable: false,
      filesAvailable: false,
      activeTextModelId: "deepseek-v4-pro",
    });

    // 4. Disable the provider plugin: hasAvailableTextModel & every plugin capability must flip to false (#92)!
    expect((await call(rig.ctx, "plugin.disable", { pluginId: "demo.provider" })).status).toBe("ok");
    const offCapsRes = await call(rig.ctx, "providers.capabilities", {});
    expect(offCapsRes.value as ProviderCapabilities).toMatchObject({
      hasAvailableTextModel: false,
      webSearchAvailable: false,
      nativeWebSearchAvailable: false,
      standaloneWebSearchAvailable: false,
      readUrlAvailable: false,
      speechAvailable: false,
      speechVoices: [],
      streamingTtsAvailable: false,
      fetchAvailable: false,
      ocrAvailable: false,
      filesAvailable: false,
      balanceAvailable: false,
    });

    // 5. Re-enable the plugin: capabilities immediately restore.
    expect((await call(rig.ctx, "plugin.enable", { pluginId: "demo.provider" })).status).toBe("ok");
    const restoredCaps = await call(rig.ctx, "providers.capabilities", {});
    expect((restoredCaps.value as ProviderCapabilities).hasAvailableTextModel).toBe(true);
    expect((restoredCaps.value as ProviderCapabilities).fetchAvailable).toBe(true);
    expect((restoredCaps.value as ProviderCapabilities).ocrAvailable).toBe(true);
  });

  it("queries providers.balance through the provider gate and makes zero requests when plugin is disabled", async () => {
    const rig = await deepseekApp({
      mock: {
        balance: {
          is_available: true,
          balance_infos: [{ currency: "CNY", total_balance: "88.50", granted_balance: "8.50", topped_up_balance: "80.00" }],
        },
      },
      add: { models: ["deepseek-flash"], services: ["fetch", "ocr"] },
    });
    closers.push(rig.close);

    const balRes = await call(rig.ctx, "providers.balance", { accountId: rig.added.accountId });
    expect(balRes.status, JSON.stringify(balRes)).toBe("ok");
    expect(balRes.value).toMatchObject({
      accountId: rig.added.accountId,
      providerRef: PROVIDER_REF,
      available: true,
      balances: [{ currency: "CNY", totalBalance: "88.50", grantedBalance: "8.50", toppedUpBalance: "80.00" }],
    });
    expect(rig.server.count("/user/balance")).toBe(1);

    // Disable plugin: explicit accountId/providerRef fails with PROVIDER_UNAVAILABLE, broad call returns unavailable, BOTH make ZERO requests.
    await call(rig.ctx, "plugin.disable", { pluginId: "demo.provider" });
    const explicitOff = await call(rig.ctx, "providers.balance", { accountId: rig.added.accountId });
    expect(explicitOff.status).toBe("error");
    expect(explicitOff.error?.code).toBe("PROVIDER_UNAVAILABLE");

    const allOff = await call(rig.ctx, "providers.balance", {});
    expect(allOff.status).toBe("ok");
    expect((allOff.value as { available: boolean }).available).toBe(false);
    expect(rig.server.count("/user/balance")).toBe(1);
  });

  it("adds and tests fetch and ocr services cleanly through connections.test", async () => {
    const rig = await deepseekApp({
      add: { models: ["deepseek-flash"], services: ["fetch", "ocr"] },
    });
    closers.push(rig.close);

    const fetchId = rig.connection("fetch")!;
    const ocrId = rig.connection("ocr")!;
    expect(fetchId).toBeTruthy();
    expect(ocrId).toBeTruthy();

    const fetchTest = await call(rig.ctx, "connections.test", { connectionId: fetchId, capability: "fetch" });
    expect(fetchTest.status, JSON.stringify(fetchTest)).toBe("ok");
    expect((fetchTest.value as { ok: boolean }).ok).toBe(true);
    expect(rig.server.count("/v1/tools/fetch")).toBe(1);

    const ocrTest = await call(rig.ctx, "connections.test", { connectionId: ocrId, capability: "ocr" });
    expect(ocrTest.status, JSON.stringify(ocrTest)).toBe("ok");
    expect((ocrTest.value as { ok: boolean }).ok).toBe(true);
    expect(rig.server.count("/v1/tools/ocr")).toBe(1);

    // Disable plugin -> connections.test refuses both with PROVIDER_UNAVAILABLE and zero requests.
    await call(rig.ctx, "plugin.disable", { pluginId: "demo.provider" });
    const fetchOff = await call(rig.ctx, "connections.test", { connectionId: fetchId, capability: "fetch" });
    const ocrOff = await call(rig.ctx, "connections.test", { connectionId: ocrId, capability: "ocr" });
    expect(fetchOff.status).toBe("error");
    expect(fetchOff.error?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(ocrOff.status).toBe("error");
    expect(ocrOff.error?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(rig.server.count("/v1/tools/fetch")).toBe(1);
    expect(rig.server.count("/v1/tools/ocr")).toBe(1);
  });
});
