/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { DEFAULT_MODEL_PROFILE, type ConnectionTestResult, type ModelProfile } from "@manga/contracts/models";
import { ModelsPage } from "../../apps/desktop/src/renderer/pages/settings/models-page.tsx";
import { AgentPage } from "../../apps/desktop/src/renderer/pages/settings/agent-page.tsx";
import { profileForm, profilePatch, profileProblem } from "../../apps/desktop/src/renderer/lib/model-profile.ts";
import { SETTINGS_GROUPS } from "../../apps/desktop/src/renderer/lib/shell-model.ts";
import type { ConnectionForm } from "../../apps/desktop/src/renderer/lib/types.ts";
import type { PlainTestResult, SaveConnectionResult } from "../../apps/desktop/src/renderer/pages/settings/connection-dialog.tsx";

/**
 * AT-95 in the window: the model's numbers and switches are shown in the list and changed in the dialog, and the one test says what it found or what to
 * fix. The dialog itself (fields, per-field problems, closing with unsaved changes, testing without leaving) is in `connection-dialog.test.tsx`.
 */

const i18n = createTranslator("zh-CN");
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const found: ModelProfile = { ...DEFAULT_MODEL_PROFILE, contextWindow: 32_768, source: { contextWindow: "detected", maxOutput: "default" } };
const tested = (patch: Partial<ConnectionTestResult>): ConnectionTestResult => ({ at: "2026-10-09T03:00:00.000Z", ok: true, latencyMs: 820, reply: "I am ready.", capabilities: ["streaming", "tools"], ...patch });

function connection(extra: Record<string, unknown> = {}) {
  return { id: "conn_1", label: "本地", protocol: "openai-chat-completions", runtime: "native", baseUrl: "http://127.0.0.1:1/v1", modelId: "m", purpose: "text", timeoutMs: 60_000, credentialConfigured: true, profile: found, lastTest: null, ...extra };
}

function mount(connections: Array<Record<string, unknown>>, handlers: { onSaveConnection?: (form: ConnectionForm) => Promise<SaveConnectionResult>; onProbeConnection?: (id: string) => Promise<void> } = {}) {
  const props = {
    i18n,
    settings: { connections, aiRuntime: "native", needsSetup: false } as Record<string, unknown>,
    onRuntime: vi.fn(async () => undefined),
    onSaveConnection: handlers.onSaveConnection ?? vi.fn(async (): Promise<SaveConnectionResult> => ({ ok: true, id: "conn_1" })),
    onDeleteConnection: vi.fn(async () => undefined),
    onTestConnection: vi.fn(async (): Promise<PlainTestResult> => ({ ok: true, message: "测试通过" })),
    onProbeConnection: handlers.onProbeConnection ?? vi.fn(async () => undefined),
    onSkip: vi.fn(),
  };
  return { ...render(<ModelsPage {...props} />), props };
}

describe("the profile of a model in the form", () => {
  it("starts from the profile as stored, and a patch holds only what was changed", () => {
    const before = profileForm(found);
    expect(before).toEqual({ contextWindow: "32768", maxOutput: "8192", inputTypes: ["text"], capabilities: ["tools"], reasoningEffort: "" });
    expect(profilePatch(before, before)).toEqual({});
    expect(profilePatch(before, { ...before, contextWindow: "65536" })).toEqual({ contextWindow: 65_536 });
    expect(profilePatch(before, { ...before, inputTypes: ["text", "image"], capabilities: ["tools", "reasoning"], reasoningEffort: "high" })).toEqual({ inputTypes: ["text", "image"], capabilities: ["tools", "reasoning"], reasoningEffort: "high" });
    // The same set in another order is no change; clearing the effort is a change to "not set".
    expect(profilePatch({ ...before, capabilities: ["tools", "reasoning"] }, { ...before, capabilities: ["reasoning", "tools"] })).toEqual({});
    expect(profilePatch({ ...before, reasoningEffort: "low" }, { ...before, reasoningEffort: "" })).toEqual({ reasoningEffort: null });
    expect(profileProblem(before)).toBeNull();
    expect(profileProblem({ ...before, contextWindow: "100" })).toBe("window");
    expect(profileProblem({ ...before, maxOutput: "10" })).toBe("output");
    expect(profileProblem({ ...before, maxOutput: "40000" })).toBe("order");
    expect(profileProblem({ ...before, contextWindow: "abc" })).toBe("window");
  });

  it("shows the numbers of a connection with where each came from, and has one button to test it", () => {
    mount([connection()]);
    expect(screen.getByTestId("connection-profile-conn_1").textContent).toContain("窗口 32,768");
    expect(screen.getByTestId("connection-profile-conn_1").textContent).toContain("测试读到 / 默认值");
    expect(screen.getByTestId("connection-test-conn_1").getAttribute("data-state")).toBe("never");
    expect(screen.getByTestId("connection-probe-conn_1")).toBeTruthy();
    // The four separate buttons are gone.
    for (const label of ["测工具", "测流式", "检测图像能力"]) expect(screen.queryByText(label)).toBeNull();
  });

  it("opens the profile fields on edit, saves only the change, and refuses numbers that do not hold together before anything is sent", async () => {
    const onSaveConnection = vi.fn(async (_form: ConnectionForm): Promise<SaveConnectionResult> => ({ ok: true, id: "conn_1" }));
    mount([connection()], { onSaveConnection });
    fireEvent.click(screen.getByTestId("connection-edit-conn_1"));
    const window = screen.getByTestId("profile-window") as HTMLInputElement;
    expect(window.value).toBe("32768");
    expect((screen.getByTestId("profile-input-text") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("profile-effort") as HTMLSelectElement).disabled).toBe(true);

    fireEvent.change(screen.getByTestId("profile-output"), { target: { value: "40000" } });
    fireEvent.submit(screen.getByTestId("profile-fields").closest("form")!);
    expect((await screen.findByTestId("field-error-output")).textContent).toContain("最大输出必须小于上下文窗口");
    expect(onSaveConnection).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("profile-output"), { target: { value: "4000" } });
    fireEvent.click(screen.getByTestId("profile-input-image"));
    fireEvent.click(screen.getByTestId("profile-cap-reasoning"));
    expect((screen.getByTestId("profile-effort") as HTMLSelectElement).disabled).toBe(false);
    fireEvent.change(screen.getByTestId("profile-effort"), { target: { value: "high" } });
    fireEvent.submit(screen.getByTestId("profile-fields").closest("form")!);
    await waitFor(() => expect(onSaveConnection).toHaveBeenCalledTimes(1));
    const saved = (onSaveConnection.mock.calls[0] as unknown as [ConnectionForm])[0];
    expect(profilePatch(saved.profileBefore!, saved.profile!)).toEqual({ maxOutput: 4_000, inputTypes: ["text", "image"], capabilities: ["tools", "reasoning"], reasoningEffort: "high" });
  });

  it("does not show the model's numbers for a connection that is not asked questions", () => {
    mount([connection({ id: "conn_asr", purpose: "transcription", profile: DEFAULT_MODEL_PROFILE })]);
    expect(screen.queryByTestId("connection-profile-conn_asr")).toBeNull();
    expect(screen.queryByTestId("connection-probe-conn_asr")).toBeNull();
    expect(screen.getByTestId("connection-test-run-conn_asr")).toBeTruthy();
  });

  it("names the purpose, the protocol and the runtime in words, not by their identifiers", () => {
    mount([connection({ protocol: "openai-responses", runtime: "pi" }), connection({ id: "conn_2", purpose: "vision", protocol: "openai-chat-completions", runtime: "native" })]);
    const first = screen.getByTestId("connection-conn_1").textContent!;
    expect(first).toContain("文本 · OpenAI Responses 接口 · PI");
    const second = screen.getByTestId("connection-conn_2").textContent!;
    expect(second).toContain("图像（视觉） · OpenAI 对话补全接口 · 自研");
    for (const identifier of ["openai-responses", "openai-chat-completions", "· text ·", "· vision ·", "· native"]) {
      expect(first).not.toContain(identifier);
      expect(second).not.toContain(identifier);
    }
  });

  it("shows the plain answer of a test of a connection that is not asked questions, in the list, and says what to do when it fails", async () => {
    const onTestConnection = vi.fn()
      .mockResolvedValueOnce({ ok: false, message: "测试没有通过：密钥不对，或没有权限。请检查密钥。" })
      .mockResolvedValueOnce({ ok: true, message: "测试通过" });
    const props = {
      i18n,
      settings: { connections: [connection({ id: "conn_asr", purpose: "transcription", profile: DEFAULT_MODEL_PROFILE })], aiRuntime: "native", needsSetup: false } as Record<string, unknown>,
      onRuntime: vi.fn(async () => undefined),
      onSaveConnection: vi.fn(async (): Promise<SaveConnectionResult> => ({ ok: true, id: "conn_asr" })),
      onDeleteConnection: vi.fn(async () => undefined),
      onTestConnection,
      onProbeConnection: vi.fn(async () => undefined),
      onSkip: vi.fn(),
    };
    render(<ModelsPage {...props} />);
    fireEvent.click(screen.getByTestId("connection-test-run-conn_asr"));
    const failed = await screen.findByTestId("connection-test-conn_asr");
    expect(failed.getAttribute("data-state")).toBe("fail");
    expect(failed.textContent).toContain("请检查密钥");
    expect(onTestConnection).toHaveBeenCalledWith("conn_asr", "transcription");
    fireEvent.click(screen.getByTestId("connection-test-run-conn_asr"));
    await waitFor(() => expect(screen.getByTestId("connection-test-conn_asr").getAttribute("data-state")).toBe("ok"));
  });
});

describe("the result of the test", () => {
  it("shows the time to the first words, the reply and what the model was found to do", () => {
    mount([connection({ lastTest: tested({ capabilities: ["streaming", "tools", "vision"], detected: { contextWindow: 32_768, maxOutput: 4_096 } }) })]);
    const result = screen.getByTestId("connection-test-conn_1");
    expect(result.getAttribute("data-state")).toBe("ok");
    expect(result.textContent).toContain("首字 0.8 秒");
    expect(result.textContent).toContain("I am ready.");
    expect(result.textContent).toContain("流式输出、工具调用、图像输入");
    expect(result.textContent).toContain("服务给出的上限：窗口 32,768，最大输出 4,096");
    expect(screen.queryByTestId("connection-test-conn_1-image")).toBeNull();
  });

  it("says when the settings claim image input and the test found none", () => {
    mount([connection({ profile: { ...found, inputTypes: ["text", "image"] }, lastTest: tested({}) })]);
    expect(screen.getByTestId("connection-test-conn_1-image").textContent).toContain("没有接受图像");
  });

  it.each([
    ["auth", "密钥被拒绝", "检查密钥是否填对", 401],
    ["address", "地址连不上", "以 /v1 结尾", undefined],
    ["model", "服务不认识这个模型", "检查模型名", 404],
    ["timeout", "等了太久没有回应", "调大超时", undefined],
    ["network", "网络中断", "检查网络、代理", undefined],
    ["rate_limit", "服务限流了", "稍等一会儿", 429],
    ["protocol", "不是模型接口的格式", "确认协议", undefined],
    ["other", "测试没有通过", "稍后再试", 503],
  ] as const)("says what to do about a %s failure", (category, title, advice, status) => {
    mount([connection({ lastTest: tested({ ok: false, capabilities: undefined, reply: undefined, failure: { category, ...(status ? { status } : {}) } }) })]);
    const result = screen.getByTestId("connection-test-conn_1");
    expect(result.getAttribute("data-state")).toBe("fail");
    expect(result.getAttribute("data-category")).toBe(category);
    expect(result.textContent).toContain(title);
    expect(result.textContent).toContain(advice);
    if (status) expect(result.textContent).toContain(`状态码 ${status}`);
  });

  it("shows that the test is running while it runs, and asks for the result once", async () => {
    let finish!: () => void;
    const onProbeConnection = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    mount([connection()], { onProbeConnection });
    fireEvent.click(screen.getByTestId("connection-probe-conn_1"));
    await waitFor(() => expect(screen.getByTestId("connection-probe-conn_1").textContent).toBe("测试中…"));
    expect((screen.getByTestId("connection-probe-conn_1") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.getByTestId("connection-probe-conn_1").textContent).toBe("测试连接"));
    expect(onProbeConnection).toHaveBeenCalledExactlyOnceWith("conn_1");
  });
});

describe("the page of the agent", () => {
  function host(initial = { limits: { maxSteps: 24, maxDurationMs: 600_000 }, trace: { mode: "full", retentionDays: 30, maxMegabytes: 500 } }) {
    const calls: Array<{ commandId: string; input: Record<string, any> }> = [];
    let current = initial;
    (window as unknown as { manga: unknown }).manga = {
      async command(payload: { commandId: string; input?: Record<string, any> }) {
        calls.push({ commandId: payload.commandId, input: payload.input ?? {} });
        if (payload.commandId === "settings.getAgent") return { status: "ok", value: current };
        if (payload.commandId === "settings.setAgent") {
          const input = payload.input as { limits?: object; trace?: object };
          current = { limits: { ...current.limits, ...input.limits }, trace: { ...current.trace, ...input.trace } } as typeof current;
          return { status: "ok", value: current };
        }
        return { status: "ok", value: {} };
      },
      onNotice: () => () => undefined,
    };
    return { calls };
  }

  it("sits among the agent pages and shows the limits as they are set", async () => {
    expect(SETTINGS_GROUPS.find((group) => group.id === "agent")!.pages).toEqual(["models", "agent", "quick", "usage"]);
    expect(i18n.t("settings.page.agent")).toBe("智能体");
    host({ limits: { maxSteps: 12, maxDurationMs: 300_000 }, trace: { mode: "full", retentionDays: 30, maxMegabytes: 500 } });
    render(<AgentPage t={i18n.t} onError={vi.fn()} onNotice={vi.fn()} />);
    await waitFor(() => expect((screen.getByTestId("agent-steps") as HTMLInputElement).value).toBe("12"));
    expect((screen.getByTestId("agent-minutes") as HTMLInputElement).value).toBe("5");
  });

  it("saves a limit when the field is left, in the unit the setting keeps, and puts back one that is out of range", async () => {
    const { calls } = host();
    const onNotice = vi.fn();
    render(<AgentPage t={i18n.t} onError={vi.fn()} onNotice={onNotice} />);
    await waitFor(() => expect((screen.getByTestId("agent-steps") as HTMLInputElement).value).toBe("24"));
    fireEvent.change(screen.getByTestId("agent-steps"), { target: { value: "40" } });
    fireEvent.blur(screen.getByTestId("agent-steps"));
    await waitFor(() => expect(calls.filter((call) => call.commandId === "settings.setAgent")).toHaveLength(1));
    expect(calls.find((call) => call.commandId === "settings.setAgent")!.input).toEqual({ limits: { maxSteps: 40 } });
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("已保存"));

    fireEvent.change(screen.getByTestId("agent-minutes"), { target: { value: "20" } });
    fireEvent.blur(screen.getByTestId("agent-minutes"));
    await waitFor(() => expect(calls.filter((call) => call.commandId === "settings.setAgent")).toHaveLength(2));
    expect(calls.filter((call) => call.commandId === "settings.setAgent")[1]!.input).toEqual({ limits: { maxDurationMs: 1_200_000 } });

    fireEvent.change(screen.getByTestId("agent-steps"), { target: { value: "500" } });
    fireEvent.blur(screen.getByTestId("agent-steps"));
    expect((await screen.findByTestId("agent-steps-error")).textContent).toContain("1 – 64");
    expect((screen.getByTestId("agent-steps") as HTMLInputElement).value).toBe("40");
    expect(calls.filter((call) => call.commandId === "settings.setAgent")).toHaveLength(2);
  });
});
