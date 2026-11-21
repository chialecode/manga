/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { DEFAULT_MODEL_PROFILE, type ModelProfile } from "@manga/contracts/models";
import { ModelsPage, type ProviderActions } from "../../apps/desktop/src/renderer/pages/settings/models-page.tsx";
import { ConnectionDialog } from "../../apps/desktop/src/renderer/pages/settings/connection-dialog.tsx";
import { profileForm } from "../../apps/desktop/src/renderer/lib/model-profile.ts";
import type { DiscoveredModel, ProviderInfo } from "../../apps/desktop/src/renderer/pages/settings/provider-dialog.tsx";

/** AT-184/AT-185 in the window: adding from an enabled provider, the account groups, a plugin that is off, and the levels a provider declares. */

const i18n = createTranslator("zh-CN");
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const flash: DiscoveredModel = { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", description: "对话与看图", contextWindow: 1_048_576, maxOutput: 393_216, inputTypes: ["text", "image"], reasoningLevels: ["low", "high", "max"], defaultLevel: "high", inCatalog: true, listed: false, suggested: true };
const pro: DiscoveredModel = { ...flash, id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", inputTypes: ["text"], suggested: false };
const deepseek: ProviderInfo = {
  ref: "manga.provider-deepseek/deepseek", name: "DeepSeek", keyUrl: "https://platform.deepseek.com/api_keys", pricesCheckedAt: "2026-11-14", models: [flash, pro],
  services: [{ kind: "transcription", name: "语音识别", description: "", suggested: true }, { kind: "speech", name: "语音合成", description: "", suggested: true }, { kind: "search", name: "网页搜索", description: "", suggested: true }],
};
const profile: ModelProfile = { ...DEFAULT_MODEL_PROFILE, dialect: "deepseek", reasoningLevels: ["low", "high", "max"], reasoningEffort: "high", capabilities: ["tools", "reasoning"] };

function mount(options: { providers?: ProviderActions["providers"]; connections?: Array<Record<string, unknown>>; actions?: Partial<ProviderActions> } = {}) {
  const props = {
    i18n,
    settings: { connections: options.connections ?? [], aiRuntime: "native", needsSetup: false } as Record<string, unknown>,
    onRuntime: vi.fn(async () => undefined),
    onSaveConnection: vi.fn(async () => ({ ok: true as const, id: "x" })),
    onDeleteConnection: vi.fn(async () => undefined),
    onTestConnection: vi.fn(async () => ({ ok: true, message: "测试通过" })),
    onProbeConnection: vi.fn(async () => undefined),
    onSkip: vi.fn(),
    providers: options.providers ?? null,
    onDiscover: vi.fn(async () => ({ ok: true as const, verified: true, models: [{ ...flash, listed: true }, { ...pro, listed: true }] })),
    onAddFromProvider: vi.fn(async () => ({ ok: true as const, count: 4 })),
    onSetAccountKey: vi.fn(async () => null),
    onDeleteAccount: vi.fn(async () => undefined),
    onOpenPlugins: vi.fn(),
    onOpenLink: vi.fn(),
    ...options.actions,
  };
  return { ...render(<ModelsPage {...props} />), props };
}

describe("adding models from a provider plugin", () => {
  it("keeps one button that opens the manual dialog when no provider is on, and says where to install one", () => {
    const { props } = mount({ providers: { providers: [], accounts: [], offered: [{ pluginId: "manga.provider-deepseek", name: "DeepSeek", state: "not-installed" }] } });
    expect(screen.getByTestId("models-offer-manga.provider-deepseek").textContent).toContain("安装 DeepSeek 插件后可以直接加入 DeepSeek 的模型");
    fireEvent.click(screen.getByTestId("models-offer-open-manga.provider-deepseek"));
    expect(props.onOpenPlugins).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("models-add"));
    expect(screen.getByTestId("connection-dialog")).toBeTruthy();
  });

  it("turns 添加模型 into a menu, reads the models with the new key, ticks the suggested ones and adds them in one go", async () => {
    const { props } = mount({ providers: { providers: [deepseek], accounts: [], offered: [] } });
    fireEvent.click(screen.getByTestId("models-add"));
    expect(screen.getByTestId("models-add-manual").textContent).toBe("手动添加…");
    fireEvent.click(screen.getByTestId("models-add-provider-deepseek"));
    const dialog = screen.getByTestId("provider-dialog");
    expect((screen.getByTestId("provider-add") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("provider-discover"));
    expect(screen.getByTestId("provider-error").textContent).toBe("请填写密钥");
    fireEvent.change(screen.getByTestId("provider-key"), { target: { value: "sk-synthetic" } });
    fireEvent.click(screen.getByTestId("provider-discover"));
    await waitFor(() => expect(screen.getByTestId("provider-verified").dataset.verified).toBe("yes"));
    expect(props.onDiscover).toHaveBeenCalledWith({ providerRef: deepseek.ref, secret: "sk-synthetic" });
    const flashBox = within(screen.getByTestId("provider-model-deepseek-flash")).getByRole("checkbox") as HTMLInputElement;
    const proBox = within(screen.getByTestId("provider-model-deepseek-v4-pro")).getByRole("checkbox") as HTMLInputElement;
    expect([flashBox.checked, proBox.checked]).toEqual([true, false]);
    expect(screen.getByTestId("provider-model-deepseek-flash").textContent).toContain("思考：低、高、最高");
    for (const kind of ["transcription", "speech", "search"]) expect((within(screen.getByTestId(`provider-service-${kind}`)).getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    expect(dialog.textContent).toContain("2026-11-14");
    fireEvent.click(screen.getByTestId("provider-add"));
    await waitFor(() => expect(props.onAddFromProvider).toHaveBeenCalledWith({ providerRef: deepseek.ref, secret: "sk-synthetic", models: ["deepseek-flash"], services: ["transcription", "speech", "search"], verified: true }));
    await waitFor(() => expect(screen.queryByTestId("provider-dialog")).toBeNull());
  });

  it("explains a failed read and can go on with the plugin's catalogue, marked as not checked online", async () => {
    const { props } = mount({
      providers: { providers: [deepseek], accounts: [], offered: [] },
      actions: { onDiscover: vi.fn(async () => ({ ok: false as const, verified: false as const, failure: { category: "billing" }, models: [flash, pro] })) },
    });
    fireEvent.click(screen.getByTestId("models-add"));
    fireEvent.click(screen.getByTestId("models-add-provider-deepseek"));
    fireEvent.change(screen.getByTestId("provider-key"), { target: { value: "sk-synthetic" } });
    fireEvent.click(screen.getByTestId("provider-discover"));
    await waitFor(() => expect(screen.getByTestId("provider-discover-fail").textContent).toContain("账户余额不足"));
    fireEvent.click(screen.getByTestId("provider-use-catalog"));
    expect(screen.getByTestId("provider-verified").textContent).toBe("未联网核对");
    fireEvent.click(screen.getByTestId("provider-add"));
    await waitFor(() => expect(props.onAddFromProvider).toHaveBeenCalledWith(expect.objectContaining({ verified: false, models: ["deepseek-flash"] })));
  });
});

describe("the list grouped by account", () => {
  const account = { id: "acct_1", label: "DeepSeek", providerRef: deepseek.ref, available: true };
  const rows = (available: boolean) => [
    { id: "conn_hand", label: "手动", protocol: "openai-chat-completions", runtime: "native", baseUrl: "https://api.example.invalid/v1", modelId: "m", purpose: "text", profile: DEFAULT_MODEL_PROFILE, lastTest: null, account: null },
    { id: "conn_ds", label: "DeepSeek · DeepSeek V4.1 Flash", protocol: "openai-chat-completions", runtime: "native", baseUrl: "https://api.deepseek.com", modelId: "deepseek-flash", purpose: "text", profile, lastTest: null, account: { ...account, available }, adapterId: "openai-chat-completions" },
    { id: "conn_tts", label: "DeepSeek · 语音合成", protocol: "openai-chat-completions", baseUrl: "https://api.deepseek.com", modelId: "deepseek-tts", purpose: "speech", profile: DEFAULT_MODEL_PROFILE, adapterId: "deepseek-tts@1", account: { ...account, available },
      lastTest: { at: "2026-11-14T03:00:00.000Z", ok: true, latencyMs: 210, service: { kind: "speech", detail: "1.6 s" } } },
  ];

  it("puts the provider's connections under their account, with the service test and a key changed once for all", async () => {
    const { props } = mount({ providers: { providers: [deepseek], accounts: [{ ...account, credentialConfigured: true, connections: 2 }], offered: [] }, connections: rows(true) });
    const group = screen.getByTestId("account-acct_1");
    expect(within(group).getByTestId("connection-conn_ds")).toBeTruthy();
    expect(within(group).queryByTestId("connection-conn_hand")).toBeNull();
    expect(screen.getByTestId("connection-test-conn_tts-service").textContent).toBe("合成了 1.6 s 的声音");
    expect((screen.getByTestId("account-delete-acct_1") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("account-set-key-acct_1"));
    fireEvent.change(screen.getByTestId("account-key-input"), { target: { value: "sk-new" } });
    fireEvent.click(screen.getByTestId("account-key-save"));
    await waitFor(() => expect(props.onSetAccountKey).toHaveBeenCalledWith("acct_1", "sk-new"));
    fireEvent.click(screen.getByTestId("connection-test-run-conn_tts"));
    await waitFor(() => expect(props.onTestConnection).toHaveBeenCalledWith("conn_tts", "speech"));
  });

  it("marks the whole group when the plugin is off: no editing or testing, deleting still possible", () => {
    mount({ providers: { providers: [], accounts: [{ ...account, available: false, credentialConfigured: true, connections: 2 }], offered: [{ pluginId: "manga.provider-deepseek", name: "DeepSeek", state: "disabled" }] }, connections: rows(false) });
    expect(screen.getByTestId("account-disabled-acct_1").textContent).toContain("插件已停用");
    expect((screen.getByTestId("connection-edit-conn_ds") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("connection-probe-conn_ds") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("connection-test-run-conn_tts") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("connection-delete-conn_ds") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("connection-edit-conn_hand") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("models-offer-manga.provider-deepseek").textContent).toContain("插件已停用");
  });

  it("removes an account with no connection after asking", async () => {
    const { props } = mount({ providers: { providers: [deepseek], accounts: [{ ...account, credentialConfigured: true, connections: 0 }], offered: [] }, connections: [] });
    expect(screen.getByTestId("account-acct_1").textContent).toContain("这个账户下没有连接");
    fireEvent.click(screen.getByTestId("account-delete-acct_1"));
    fireEvent.click(screen.getByTestId("account-delete-confirm"));
    await waitFor(() => expect(props.onDeleteAccount).toHaveBeenCalledWith("acct_1"));
  });
});

describe("a provider connection in the dialog", () => {
  it("keeps the address, model, purpose and key, and offers only the declared levels and 关闭思考", () => {
    const form = { id: "conn_ds", label: "DeepSeek · Flash", protocol: "openai-chat-completions", runtime: "native", baseUrl: "https://api.deepseek.com", modelId: "deepseek-flash", purpose: "text", timeoutMs: "120000", secret: "", profile: profileForm(profile), profileBefore: profileForm(profile), provider: "DeepSeek" };
    render(<ConnectionDialog i18n={i18n} initial={form} secretStored saved={() => undefined} onSave={vi.fn(async () => ({ ok: true as const, id: "conn_ds" }))} onProbe={vi.fn(async () => undefined)} onTest={vi.fn(async () => ({ ok: true, message: "" }))} onClose={vi.fn()} />);
    expect(screen.getByTestId("connection-provider-locked").textContent).toContain("DeepSeek 插件");
    for (const id of ["connection-base-url", "connection-model-id", "connection-protocol", "connection-purpose"]) expect((screen.getByTestId(id) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId("connection-secret")).toBeNull();
    const options = [...(screen.getByTestId("profile-effort") as HTMLSelectElement).options].map((option) => option.textContent);
    expect(options).toEqual(["低", "高", "最高", "关闭思考"]);
  });
});
