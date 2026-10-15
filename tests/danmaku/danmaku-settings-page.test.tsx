/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { DEFAULT_DANMAKU_SETTINGS, type DanmakuSettings } from "@manga/contracts/danmaku";
import { DanmakuPage } from "../../apps/desktop/src/renderer/pages/settings/danmaku-page.tsx";
import { hiddenSettingsPages } from "../../apps/desktop/src/renderer/pages/settings/settings-view.tsx";
import { SETTINGS_GROUPS, SETTINGS_PAGES } from "../../apps/desktop/src/renderer/lib/shell-model.ts";
import { resetDanmakuSettings, setDanmakuSources } from "../../apps/desktop/src/renderer/hooks/use-danmaku-settings.ts";

const i18n = createTranslator("zh-CN");
type Call = { commandId: string; input: Record<string, any> };

const APP_ID = "synthappid1234";
const APP_SECRET = "synthsecretvalue5678";

function installHost(credentials: "built-in" | "custom" | "none" = "built-in") {
  const calls: Call[] = [];
  const stashed: string[] = [];
  let settings: DanmakuSettings = { ...DEFAULT_DANMAKU_SETTINGS };
  let source = credentials;
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input?: Record<string, any> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      switch (payload.commandId) {
        case "danmaku.getSettings": return { status: "ok", value: { settings, credentials: source } };
        case "danmaku.setSettings": settings = { ...settings, ...input } as DanmakuSettings; return { status: "ok", value: { settings, credentials: source } };
        case "danmaku.setCredentials": source = input.clear ? (credentials === "custom" ? "none" : "built-in") : "custom"; return { status: "ok", value: { credentials: source } };
        case "danmaku.clearCache": return { status: "ok", value: { removed: 3 } };
        default: return { status: "ok", value: {} };
      }
    },
    async stashSecret(value: string) { stashed.push(value); return "handle_1"; },
    onNotice: () => () => undefined,
  };
  return { calls, stashed, of: (id: string) => calls.filter((call) => call.commandId === id), current: () => settings };
}

function mount(moduleOn = true) {
  const onError = vi.fn();
  const onNotice = vi.fn();
  const view = render(<DanmakuPage t={i18n.t} moduleOn={moduleOn} onError={onError} onNotice={onNotice} />);
  return { ...view, onError, onNotice };
}

beforeEach(() => { resetDanmakuSettings(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const control = (id: string) => screen.getByTestId(id) as HTMLInputElement;

describe("the danmaku page of the settings (AT-94)", () => {
  it("is hidden from the list while the module is off, and sits with the basic pages while it is on", () => {
    expect(hiddenSettingsPages(new Set(["agent", "metadata"])).has("danmaku")).toBe(true);
    expect(hiddenSettingsPages(new Set(["danmaku"])).has("danmaku")).toBe(false);
    expect(SETTINGS_GROUPS.find((group) => group.id === "basic")!.pages).toContain("danmaku");
    expect(SETTINGS_PAGES).toContain("danmaku");
    expect(i18n.t("settings.page.danmaku")).toBe("弹幕");
  });

  it("says the module is off and shows no controls, keeping what was set", async () => {
    const host = installHost();
    mount(false);
    expect(screen.getByTestId("danmaku-off").textContent).toContain("弹幕模块已关闭");
    expect(screen.queryByTestId("danmaku-enabled")).toBeNull();
    await act(async () => { await Promise.resolve(); });
    expect(host.of("danmaku.getSettings")).toHaveLength(0);
  });

  it("shows where the comments come from and what is set, and saves a change at once", async () => {
    const host = installHost();
    mount();
    await waitFor(() => expect(host.of("danmaku.getSettings")).toHaveLength(1));
    expect(screen.getByTestId("danmaku-source-note").textContent).toBe("弹幕来自弹弹play开放弹幕网络");
    expect(control("danmaku-enabled").checked).toBe(false);
    expect(control("danmaku-opacity").value).toBe("80");
    expect(screen.getByTestId("danmaku-opacity-value").textContent).toBe("80%");
    expect(screen.getByTestId("danmaku-speed-value").textContent).toBe("穿过画面约 10 秒");

    fireEvent.click(control("danmaku-enabled"));
    await waitFor(() => expect(host.current().enabled).toBe(true));
    expect(host.of("danmaku.setSettings")[0]!.input).toEqual({ enabled: true });

    fireEvent.change(control("danmaku-speed"), { target: { value: "240" } });
    await waitFor(() => expect(host.current().speed).toBe(240));
    expect(screen.getByTestId("danmaku-speed-value").textContent).toBe("穿过画面约 8 秒");

    // AT-106: on by default (the speed follows the rate, as before), and the person can turn it off.
    expect(control("danmaku-follow-rate").checked).toBe(true);
    fireEvent.click(control("danmaku-follow-rate"));
    await waitFor(() => expect(host.current().followRate).toBe(false));
    expect(control("danmaku-follow-rate").checked).toBe(false);

    fireEvent.change(control("danmaku-opacity"), { target: { value: "50" } });
    await waitFor(() => expect(host.current().opacity).toBe(0.5));
    fireEvent.change(control("danmaku-size"), { target: { value: "150" } });
    await waitFor(() => expect(host.current().size).toBe(150));
    fireEvent.change(screen.getByTestId("danmaku-area"), { target: { value: "1" } });
    await waitFor(() => expect(host.current().area).toBe(1));
    fireEvent.change(screen.getByTestId("danmaku-convert"), { target: { value: "traditional" } });
    await waitFor(() => expect(host.current().convert).toBe("traditional"));
    fireEvent.click(control("danmaku-type-bottom"));
    await waitFor(() => expect(host.current().bottom).toBe(true));
    fireEvent.click(control("danmaku-type-scroll"));
    await waitFor(() => expect(host.current().scroll).toBe(false));
    fireEvent.click(control("danmaku-shot-with"));
    await waitFor(() => expect(host.current().shotWith).toBe(true));
    fireEvent.click(control("danmaku-merge"));
    await waitFor(() => expect(host.current().merge).toBe(false));
    fireEvent.click(control("danmaku-color"));
    await waitFor(() => expect(host.current().color).toBe(false));
  });

  it("keeps the words typed one to a line, and drops empty lines", async () => {
    const host = installHost();
    mount();
    await waitFor(() => expect(host.of("danmaku.getSettings")).toHaveLength(1));
    const field = screen.getByTestId("danmaku-block-words") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "剧透\n\n  前方高能 \n" } });
    fireEvent.blur(field);
    await waitFor(() => expect(host.current().blockWords).toEqual(["剧透", "前方高能"]));
  });

  it("keeps a pattern that is fine and refuses one that is not, naming the line (AT-94)", async () => {
    const host = installHost();
    mount();
    await waitFor(() => expect(host.of("danmaku.getSettings")).toHaveLength(1));
    const field = screen.getByTestId("danmaku-block-patterns") as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: "^哈+$\n(a+)+" } });
    fireEvent.blur(field);
    expect(screen.getByTestId("danmaku-block-patterns-error").textContent).toBe("第 2 行不是有效的正则表达式：(a+)+");
    expect(host.of("danmaku.setSettings")).toHaveLength(0);
    fireEvent.change(field, { target: { value: "^哈+$\n[" } });
    fireEvent.blur(field);
    expect(screen.getByTestId("danmaku-block-patterns-error").textContent).toContain("第 2 行");
    fireEvent.change(field, { target: { value: "^哈+$\n^w+$" } });
    fireEvent.blur(field);
    await waitFor(() => expect(host.current().blockPatterns).toEqual(["^哈+$", "^w+$"]));
    expect(screen.queryByTestId("danmaku-block-patterns-error")).toBeNull();
  });

  it("lists the sources of the loaded episode and switches them one by one", async () => {
    const host = installHost();
    mount();
    await waitFor(() => expect(host.of("danmaku.getSettings")).toHaveLength(1));
    expect(screen.getByTestId("danmaku-sources-none")).toBeTruthy();
    act(() => setDanmakuSources([{ source: "", count: 40 }, { source: "BiliBili", count: 12 }]));
    expect(screen.getByTestId("danmaku-sources").textContent).toContain("弹弹play");
    expect(control("danmaku-source-own").checked).toBe(true);
    fireEvent.click(control("danmaku-source-BiliBili"));
    await waitFor(() => expect(host.current().sourcesOff).toEqual(["BiliBili"]));
    // A source that was turned off stays in the list when the next episode has none of it.
    act(() => setDanmakuSources([{ source: "", count: 5 }]));
    expect(control("danmaku-source-BiliBili").checked).toBe(false);
    fireEvent.click(control("danmaku-source-BiliBili"));
    await waitFor(() => expect(host.current().sourcesOff).toEqual([]));
  });

  it("sends the person's own credentials to the main process through the secret channel and shows none of them again (A-81)", async () => {
    const host = installHost("built-in");
    const view = mount();
    await waitFor(() => expect(host.of("danmaku.getSettings")).toHaveLength(1));
    expect(screen.getByTestId("danmaku-credential-state").getAttribute("data-source")).toBe("built-in");
    expect(screen.queryByTestId("danmaku-credentials-clear")).toBeNull();
    expect((screen.getByTestId("danmaku-app-secret") as HTMLInputElement).type).toBe("password");

    // The shape is checked before anything leaves the page.
    fireEvent.change(screen.getByTestId("danmaku-app-id"), { target: { value: "a b" } });
    fireEvent.change(screen.getByTestId("danmaku-app-secret"), { target: { value: APP_SECRET } });
    fireEvent.click(screen.getByTestId("danmaku-credentials-save"));
    expect(screen.getByTestId("danmaku-credential-error").textContent).toContain("只由字母和数字");
    expect(host.stashed).toHaveLength(0);

    fireEvent.change(screen.getByTestId("danmaku-app-id"), { target: { value: APP_ID } });
    fireEvent.click(screen.getByTestId("danmaku-credentials-save"));
    await waitFor(() => expect(host.of("danmaku.setCredentials")).toHaveLength(1));
    expect(JSON.parse(host.stashed[0]!)).toEqual({ appId: APP_ID, secret: APP_SECRET });
    // The command carries the handle and not the values.
    expect(host.of("danmaku.setCredentials")[0]!.input).toEqual({ credentialHandle: "handle_1" });
    expect(JSON.stringify(host.calls)).not.toContain(APP_SECRET);
    await waitFor(() => expect(screen.getByTestId("danmaku-credential-state").getAttribute("data-source")).toBe("custom"));
    expect((screen.getByTestId("danmaku-app-id") as HTMLInputElement).value).toBe("");
    expect((screen.getByTestId("danmaku-app-secret") as HTMLInputElement).value).toBe("");
    expect(view.onNotice).toHaveBeenCalledWith("已保存。");
    expect(document.body.innerHTML).not.toContain(APP_SECRET);

    fireEvent.click(screen.getByTestId("danmaku-credentials-clear"));
    await waitFor(() => expect(host.of("danmaku.setCredentials")).toHaveLength(2));
    expect(host.of("danmaku.setCredentials")[1]!.input).toEqual({ clear: true });
    await waitFor(() => expect(screen.getByTestId("danmaku-credential-state").getAttribute("data-source")).toBe("built-in"));
  });

  it("says there are no credentials when neither the release nor the person has any", async () => {
    const host = installHost("none");
    mount();
    await waitFor(() => expect(host.of("danmaku.getSettings")).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("danmaku-credential-state").textContent).toContain("没有可用的凭据"));
  });

  it("clears the cache and says how many episodes were in it", async () => {
    const host = installHost();
    const view = mount();
    await waitFor(() => expect(host.of("danmaku.getSettings")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("danmaku-cache-clear"));
    await waitFor(() => expect(view.onNotice).toHaveBeenCalledWith("已清空 3 集的缓存。"));
    expect(host.of("danmaku.clearCache")).toHaveLength(1);
  });

  it("puts back a change the main process refused and says why", async () => {
    const host = installHost();
    const original = (window as unknown as { manga: { command: (payload: unknown) => Promise<unknown> } }).manga.command;
    (window as unknown as { manga: { command: (payload: { commandId: string }) => Promise<unknown> } }).manga.command = async (payload: { commandId: string }) =>
      payload.commandId === "danmaku.setSettings" ? { status: "error", error: { code: "VALIDATION_ERROR", message: "not accepted" } } : original(payload);
    const view = mount();
    await waitFor(() => expect(host.of("danmaku.getSettings")).toHaveLength(1));
    fireEvent.click(control("danmaku-enabled"));
    await waitFor(() => expect(view.onError).toHaveBeenCalledWith("not accepted"));
    expect(control("danmaku-enabled").checked).toBe(false);
  });
});
