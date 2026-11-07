/** @vitest-environment jsdom */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { DEFAULT_MODEL_PROFILE, type ConnectionTestResult } from "@manga/contracts/models";
import { ModelsPage } from "../../apps/desktop/src/renderer/pages/settings/models-page.tsx";
import { validateConnection, type PlainTestResult, type SaveConnectionResult } from "../../apps/desktop/src/renderer/pages/settings/connection-dialog.tsx";
import { emptyForm, type ConnectionForm } from "../../apps/desktop/src/renderer/lib/types.ts";

/**
 * AT-103 in the window (A-90): a model is added and changed in one dialog. Every field is checked before saving and says what is wrong beside itself;
 * a refusal from the main process stays in the dialog; closing with unsaved changes asks first; the connection is tested without leaving, and the
 * result shows in the dialog and in the list. The secret is typed once and never shown again.
 */

const i18n = createTranslator("zh-CN");
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

type Row = Record<string, unknown>;

function stored(extra: Row = {}): Row {
  return { id: "conn_1", label: "本地", protocol: "openai-chat-completions", runtime: "native", baseUrl: "http://127.0.0.1:1/v1", modelId: "m", purpose: "text", timeoutMs: 60_000, credentialConfigured: true, profile: DEFAULT_MODEL_PROFILE, lastTest: null, ...extra };
}

/** The page with the settings it reads held in state, as the app does: a save puts the connection among them, a delete takes it out. */
function mount(initial: Row[] = [], handlers: {
  save?: (form: ConnectionForm) => Promise<SaveConnectionResult>;
  probe?: (id: string) => Promise<void>;
  test?: (id: string, capability: string) => Promise<PlainTestResult>;
} = {}) {
  const save = vi.fn(handlers.save ?? (async (form: ConnectionForm): Promise<SaveConnectionResult> => ({ ok: true, id: form.id ?? "conn_new" })));
  const probe = vi.fn(handlers.probe ?? (async () => undefined));
  const test = vi.fn(handlers.test ?? (async (): Promise<PlainTestResult> => ({ ok: true, message: "测试通过" })));
  const remove = vi.fn(async (_id: string) => undefined);
  let setRows!: (rows: Row[]) => void;
  function Harness() {
    const [rows, set] = useState<Row[]>(initial);
    setRows = set;
    return (
      <ModelsPage
        i18n={i18n}
        settings={{ connections: rows, aiRuntime: "native", needsSetup: false }}
        onRuntime={async () => undefined}
        onSaveConnection={async (form) => {
          const outcome = await save(form);
          if (outcome.ok) set((current) => [...current.filter((row) => row.id !== outcome.id), stored({ id: outcome.id, label: form.label, baseUrl: form.baseUrl, modelId: form.modelId, purpose: form.purpose, protocol: form.protocol, runtime: form.runtime, timeoutMs: Number(form.timeoutMs), credentialConfigured: true })]);
          return outcome;
        }}
        onDeleteConnection={async (id) => { await remove(id); set((current) => current.filter((row) => row.id !== id)); }}
        onTestConnection={test}
        onProbeConnection={probe}
        onSkip={() => undefined}
      />
    );
  }
  return { ...render(<Harness />), save, probe, test, remove, setRows: (rows: Row[]) => act(() => setRows(rows)) };
}

const type = (testId: string, value: string) => fireEvent.change(screen.getByTestId(testId), { target: { value } });
const submit = () => fireEvent.submit(document.getElementById("connection-form")!);
const fillValid = () => {
  type("connection-base-url", "https://api.example.com/v1");
  type("connection-model-id", "gpt-x");
  type("connection-secret", "sk-synthetic");
};

describe("the dialog opens from the list and starts empty for a new model", () => {
  it("has an add button above the list, no permanent form on the page, and a dialog with every field blank", () => {
    mount([]);
    expect(screen.getByTestId("models-add").textContent).toBe("添加模型");
    expect(screen.queryByTestId("connection-dialog")).toBeNull();
    expect(screen.queryByTestId("models-form")).toBeNull();
    fireEvent.click(screen.getByTestId("models-add"));
    const dialog = screen.getByTestId("connection-dialog");
    expect(within(dialog).getByText("添加模型")).toBeTruthy();
    for (const id of ["connection-label", "connection-base-url", "connection-model-id", "connection-secret"]) expect((screen.getByTestId(id) as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("connection-timeout") as HTMLInputElement).value).toBe("60");
    expect((screen.getByTestId("connection-protocol") as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("OpenAI 对话补全接口");
    expect((screen.getByTestId("connection-purpose") as HTMLSelectElement).selectedOptions[0]!.textContent).toBe("文本");
    // The fields are in two groups; the model's own numbers are in the second.
    expect(screen.getByTestId("connection-group-connection")).toBeTruthy();
    expect(screen.getByTestId("profile-fields")).toBeTruthy();
    expect(emptyForm().label).toBe("");
  });

  it("does not show the model's numbers for a model that is not asked questions", () => {
    mount([]);
    fireEvent.click(screen.getByTestId("models-add"));
    type("connection-purpose", "transcription");
    expect(screen.queryByTestId("profile-fields")).toBeNull();
    type("connection-purpose", "vision");
    expect(screen.getByTestId("profile-fields")).toBeTruthy();
  });
});

describe("each field says what is wrong beside itself, before anything is sent", () => {
  it("names every empty field at once, takes the person to the first, and sends nothing", async () => {
    const { save } = mount([]);
    fireEvent.click(screen.getByTestId("models-add"));
    submit();
    expect((await screen.findByTestId("field-error-baseUrl")).textContent).toContain("请填写 API 根地址");
    expect(screen.getByTestId("field-error-modelId").textContent).toContain("请填写模型名");
    expect(screen.getByTestId("field-error-secret").textContent).toContain("请填写密钥");
    expect(screen.queryByTestId("field-error-label")).toBeNull();
    expect(screen.getByTestId("connection-base-url").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByTestId("connection-base-url").getAttribute("aria-describedby")).toBe("field-error-baseUrl");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("connection-base-url")));
    expect(save).not.toHaveBeenCalled();
    // Typing in a field takes its problem away; the others stay.
    type("connection-base-url", "https://api.example.com/v1");
    expect(screen.queryByTestId("field-error-baseUrl")).toBeNull();
    expect(screen.getByTestId("field-error-modelId")).toBeTruthy();
  });

  // The cases are named by what is wrong, so the address (one of them has a user name and a password in it) is not part of a test's name.
  it.each([
    ["has no scheme", "api.example.com/v1", "http:// 或 https://"],
    ["has another scheme", "ftp://host/v1", "http:// 或 https://"],
    ["carries a user name and a password", ["https://user:pass", "api.example.com/v1"].join("@"), "不能带用户名或密码"],
  ])("refuses an address that %s", async (_name, address, message) => {
    const { save } = mount([]);
    fireEvent.click(screen.getByTestId("models-add"));
    fillValid();
    type("connection-base-url", address);
    submit();
    expect((await screen.findByTestId("field-error-baseUrl")).textContent).toContain(message);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a timeout that is not a whole number of seconds between 1 and 300, and a name that is too long", async () => {
    const { save } = mount([]);
    fireEvent.click(screen.getByTestId("models-add"));
    fillValid();
    for (const bad of ["0", "301", "1.5", "abc", ""]) {
      type("connection-timeout", bad);
      submit();
      expect((await screen.findByTestId("field-error-timeout")).textContent).toContain("1 到 300");
    }
    type("connection-timeout", "300");
    type("connection-label", "名".repeat(121));
    submit();
    expect((await screen.findByTestId("field-error-label")).textContent).toContain("120");
    expect(screen.queryByTestId("field-error-timeout")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("checks the model's numbers beside their own fields", async () => {
    const { save } = mount([]);
    fireEvent.click(screen.getByTestId("models-add"));
    fillValid();
    type("profile-window", "100");
    submit();
    expect((await screen.findByTestId("field-error-window")).textContent).toContain("4096");
    type("profile-window", "32768");
    type("profile-output", "40000");
    submit();
    expect((await screen.findByTestId("field-error-output")).textContent).toContain("最大输出必须小于上下文窗口");
    expect(screen.queryByTestId("field-error-window")).toBeNull();
    expect(save).not.toHaveBeenCalled();
  });

  it("the same rules hold without the page", () => {
    const form = { ...emptyForm(), baseUrl: "https://api.example.com/v1", modelId: "m", secret: "k" };
    expect(validateConnection(i18n.t, form, "60", true, false)).toEqual({});
    // A stored secret satisfies the secret; a blank one then means "unchanged".
    expect(validateConnection(i18n.t, { ...form, secret: "" }, "60", true, true)).toEqual({});
    expect(Object.keys(validateConnection(i18n.t, { ...form, secret: "  " }, "60", true, false))).toEqual(["secret"]);
    // A transcription model has no numbers of its own to check.
    expect(validateConnection(i18n.t, { ...form, profile: { ...form.profile!, contextWindow: "1" } }, "60", false, false)).toEqual({});
  });
});

describe("saving", () => {
  it("sends the trimmed values with the timeout in milliseconds, names the model by its id when no name was given, and stays open to test", async () => {
    const { save } = mount([]);
    fireEvent.click(screen.getByTestId("models-add"));
    type("connection-base-url", "  https://api.example.com/v1  ");
    type("connection-model-id", " gpt-x ");
    type("connection-secret", "sk-synthetic");
    type("connection-timeout", "90");
    expect((screen.getByTestId("connection-dialog-test-button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("connection-dialog-test-hint").textContent).toContain("先保存");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = save.mock.calls[0]![0];
    expect(sent).toMatchObject({ label: "gpt-x", baseUrl: "https://api.example.com/v1", modelId: "gpt-x", timeoutMs: "90000", secret: "sk-synthetic", purpose: "text" });
    expect(sent.id).toBeUndefined();
    // Saved: the dialog stays, the secret is gone from the field and the hint says it is kept, and the connection is now in the list.
    await waitFor(() => expect((screen.getByTestId("connection-dialog-test-button") as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByTestId("connection-secret") as HTMLInputElement).value).toBe("");
    expect(screen.getByTestId("connection-secret-hint").textContent).toContain("留空表示不修改");
    expect(screen.getByTestId("connection-dialog-test-hint").textContent).toContain("已保存");
    expect(screen.getByTestId("connection-conn_new").textContent).toContain("gpt-x");
    expect(within(screen.getByTestId("connection-dialog")).getByText("编辑模型")).toBeTruthy();
    // Saving again sends the same connection, not another one.
    type("connection-model-id", "gpt-y");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0].id).toBe("conn_new");
  });

  it("keeps the dialog and says why when the main process refuses, and nothing counts as saved", async () => {
    const { save } = mount([], { save: async () => ({ ok: false, message: "无法保存密钥：本机没有可用的凭据保管库" }) });
    fireEvent.click(screen.getByTestId("models-add"));
    fillValid();
    submit();
    expect((await screen.findByTestId("connection-dialog-error")).textContent).toContain("凭据保管库");
    expect(save).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId("connection-dialog-test-button") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("connection-secret") as HTMLInputElement).value).toBe("sk-synthetic");
    expect(screen.queryByTestId("models-empty")).not.toBeNull();
    // A change clears the old refusal.
    type("connection-model-id", "gpt-y");
    expect(screen.queryByTestId("connection-dialog-error")).toBeNull();
  });
});

describe("changing a saved model", () => {
  it("starts from the stored values, says that a blank key keeps the saved one, and sends a blank secret when it is left alone", async () => {
    const { save } = mount([stored()]);
    fireEvent.click(screen.getByTestId("connection-edit-conn_1"));
    expect((screen.getByTestId("connection-label") as HTMLInputElement).value).toBe("本地");
    expect((screen.getByTestId("connection-base-url") as HTMLInputElement).value).toBe("http://127.0.0.1:1/v1");
    expect((screen.getByTestId("connection-timeout") as HTMLInputElement).value).toBe("60");
    const secret = screen.getByTestId("connection-secret") as HTMLInputElement;
    expect(secret.value).toBe("");
    expect(secret.placeholder).toContain("留空表示不修改");
    expect(screen.getByTestId("connection-secret-hint").textContent).toContain("不会再显示");
    // Nothing changed: nothing to save, and the connection can be tested at once.
    expect((screen.getByTestId("connection-dialog-save") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("connection-dialog-test-button") as HTMLButtonElement).disabled).toBe(false);
    type("connection-model-id", "model-b");
    expect((screen.getByTestId("connection-dialog-test-button") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("connection-dialog-test-hint").textContent).toContain("保存之后才能测试");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ id: "conn_1", modelId: "model-b", secret: "" });
  });

  it("asks for a key when the connection has none stored", async () => {
    const { save } = mount([stored({ credentialConfigured: false })]);
    fireEvent.click(screen.getByTestId("connection-edit-conn_1"));
    expect(screen.getByTestId("connection-secret-hint").textContent).not.toContain("留空表示不修改");
    type("connection-model-id", "model-b");
    submit();
    expect((await screen.findByTestId("field-error-secret")).textContent).toContain("请填写密钥");
    expect(save).not.toHaveBeenCalled();
  });
});

describe("closing with unsaved changes", () => {
  it("closes at once when nothing was changed", () => {
    mount([stored()]);
    fireEvent.click(screen.getByTestId("connection-edit-conn_1"));
    fireEvent.click(screen.getByTestId("connection-dialog-cancel"));
    expect(screen.queryByTestId("connection-dialog")).toBeNull();
    expect(screen.queryByTestId("connection-discard")).toBeNull();
  });

  it("asks first, and lets the person keep editing or throw the changes away", () => {
    mount([stored()]);
    fireEvent.click(screen.getByTestId("connection-edit-conn_1"));
    type("connection-model-id", "other");
    fireEvent.click(screen.getByTestId("connection-dialog-cancel"));
    const asked = screen.getByTestId("connection-discard");
    expect(asked.textContent).toContain("放弃未保存的修改");
    fireEvent.click(screen.getByTestId("connection-discard-keep"));
    expect(screen.queryByTestId("connection-discard")).toBeNull();
    expect((screen.getByTestId("connection-model-id") as HTMLInputElement).value).toBe("other");
    fireEvent.click(screen.getByTestId("connection-dialog-cancel"));
    fireEvent.click(screen.getByTestId("connection-discard-confirm"));
    expect(screen.queryByTestId("connection-dialog")).toBeNull();
    expect(screen.getByTestId("connection-conn_1").textContent).toContain("m");
  });

  it("counts a typed secret and a changed timeout as changes, and asks before a new model that was started is dropped", () => {
    mount([]);
    fireEvent.click(screen.getByTestId("models-add"));
    fireEvent.click(screen.getByTestId("connection-dialog-cancel"));
    expect(screen.queryByTestId("connection-dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("models-add"));
    type("connection-timeout", "30");
    fireEvent.click(screen.getByTestId("connection-dialog-cancel"));
    expect(screen.getByTestId("connection-discard")).toBeTruthy();
  });

  it("does not ask once the changes have been saved", async () => {
    const { save } = mount([stored()]);
    fireEvent.click(screen.getByTestId("connection-edit-conn_1"));
    type("connection-model-id", "other");
    submit();
    await waitFor(() => expect(save).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("connection-dialog-cancel").textContent).toBe("完成"));
    fireEvent.click(screen.getByTestId("connection-dialog-cancel"));
    expect(screen.queryByTestId("connection-dialog")).toBeNull();
    expect(screen.queryByTestId("connection-discard")).toBeNull();
  });
});

describe("testing without leaving the dialog", () => {
  it("asks the question of a text model and shows the saved result in the dialog and in the list", async () => {
    const result: ConnectionTestResult = { at: "2026-10-09T03:00:00.000Z", ok: true, latencyMs: 820, reply: "I am ready.", capabilities: ["streaming", "tools"] };
    let rows: ((rows: Row[]) => void) | null = null;
    const { probe, setRows } = mount([stored()], { probe: async () => { rows?.([stored({ lastTest: result })]); } });
    rows = (next) => { void setRows(next); };
    fireEvent.click(screen.getByTestId("connection-edit-conn_1"));
    fireEvent.click(screen.getByTestId("connection-dialog-test-button"));
    await waitFor(() => expect(probe).toHaveBeenCalledExactlyOnceWith("conn_1"));
    await waitFor(() => expect(screen.getByTestId("connection-dialog-test").getAttribute("data-state")).toBe("ok"));
    expect(screen.getByTestId("connection-test-conn_1").getAttribute("data-state")).toBe("ok");
  });

  it("says what to do when a text model's test failed", async () => {
    mount([stored({ lastTest: { at: "2026-10-09T03:00:00.000Z", ok: false, latencyMs: 0, failure: { category: "auth", status: 401 } } })]);
    fireEvent.click(screen.getByTestId("connection-edit-conn_1"));
    const shown = screen.getByTestId("connection-dialog-test");
    expect(shown.getAttribute("data-state")).toBe("fail");
    expect(shown.textContent).toContain("密钥被拒绝");
    expect(shown.textContent).toContain("检查密钥是否填对");
  });

  it("gives a plain answer for a model that is not asked questions, in the dialog and then in the list", async () => {
    const { test } = mount([stored({ id: "conn_asr", purpose: "transcription" })], { test: async () => ({ ok: false, message: "测试没有通过：找不到这个模型或接口。请检查 API 根地址和模型名。" }) });
    fireEvent.click(screen.getByTestId("connection-edit-conn_asr"));
    fireEvent.click(screen.getByTestId("connection-dialog-test-button"));
    const shown = await screen.findByTestId("connection-dialog-test");
    expect(shown.getAttribute("data-state")).toBe("fail");
    expect(shown.textContent).toContain("请检查 API 根地址和模型名");
    expect(test).toHaveBeenCalledExactlyOnceWith("conn_asr", "transcription");
    expect(screen.getByTestId("connection-test-conn_asr").textContent).toContain("请检查 API 根地址和模型名");
  });

  it("shows that the test is running, and does not test while there are unsaved changes", async () => {
    let finish!: (value: PlainTestResult) => void;
    mount([stored({ id: "conn_emb", purpose: "embedding" })], { test: () => new Promise<PlainTestResult>((resolve) => { finish = resolve; }) });
    fireEvent.click(screen.getByTestId("connection-edit-conn_emb"));
    fireEvent.click(screen.getByTestId("connection-dialog-test-button"));
    await waitFor(() => expect(screen.getByTestId("connection-dialog-testing")).toBeTruthy());
    expect((screen.getByTestId("connection-dialog-test-button") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish({ ok: true, message: "测试通过" }); });
    await waitFor(() => expect(screen.getByTestId("connection-dialog-test").textContent).toBe("测试通过"));
  });
});

describe("deleting a model", () => {
  it("asks first, says what goes, and deletes only after the person agrees", async () => {
    const { remove } = mount([stored(), stored({ id: "conn_2", label: "第二个" })]);
    fireEvent.click(screen.getByTestId("connection-delete-conn_1"));
    const asked = screen.getByTestId("connection-delete-dialog");
    expect(asked.textContent).toContain("删除模型“本地”");
    expect(asked.textContent).toContain("保存的密钥会一起删除");
    fireEvent.click(screen.getByTestId("connection-delete-cancel"));
    expect(screen.queryByTestId("connection-delete-dialog")).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("connection-delete-conn_1"));
    fireEvent.click(screen.getByTestId("connection-delete-confirm"));
    await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith("conn_1"));
    await waitFor(() => expect(screen.queryByTestId("connection-conn_1")).toBeNull());
    expect(screen.getByTestId("connection-conn_2")).toBeTruthy();
  });
});
