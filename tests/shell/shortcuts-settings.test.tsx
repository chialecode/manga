/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { KEY_ACTIONS, resolveKeys } from "@manga/contracts/keys";
import { readMediaSettings, writeMediaSettings } from "../../packages/app-core/src/voice/settings.ts";
import { useKeyBindings } from "../../apps/desktop/src/renderer/hooks/use-key-bindings.ts";
import { ShortcutsPage } from "../../apps/desktop/src/renderer/pages/settings/shortcuts-page.tsx";
import { CustomRate, RateList } from "../../apps/desktop/src/renderer/pages/settings-rates.tsx";
import { useState } from "react";

const i18n = createTranslator("zh-CN");

/** The two calls the media settings make on a store, with the real validation behind them. */
function installStore() {
  const meta = new Map<string, string>();
  const store = { getMeta: (key: string) => meta.get(key) ?? null, setMeta: (key: string, value: string) => { meta.set(key, value); } } as never;
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input?: Record<string, unknown> }) {
      try {
        if (payload.commandId === "settings.getMedia") return { status: "ok", value: readMediaSettings(store) };
        if (payload.commandId === "settings.setMedia") return { status: "ok", value: writeMediaSettings(store, payload.input as never) };
        return { status: "ok", value: {} };
      } catch (error) {
        return { status: "error", error: { code: "INVALID", message: (error as Error).message } };
      }
    },
  };
  return { saved: () => readMediaSettings(store).keys };
}

function Harness() {
  const keys = useKeyBindings();
  return <ShortcutsPage t={i18n.t} keys={keys} recording={{ holdKey: "AltRight", toggleKey: "KeyV" }} onGoto={() => undefined} />;
}

const chords = (id: string) => Array.from(screen.getByTestId(`key-row-${id}`).querySelectorAll("kbd")).map((node) => node.textContent);
const add = (id: string, key: string, extra: Partial<KeyboardEventInit> = {}) => {
  fireEvent.click(screen.getByTestId(`key-add-${id}`));
  fireEvent.keyDown(window, { key, ...extra });
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Settings › Shortcuts (AT-90)", () => {
  it("lists every action of the table by reader, with its keys; the keys of Esc are fixed", async () => {
    installStore();
    render(<Harness />);
    for (const group of ["global", "video", "comic", "novel"]) expect(screen.getByTestId(`shortcuts-${group}`)).toBeTruthy();
    for (const entry of KEY_ACTIONS) expect(screen.getByTestId(`key-row-${entry.id}`), entry.id).toBeTruthy();
    expect(chords("video.toggle")).toEqual(["Space", "K"]);
    expect(chords("video.seekBack")).toEqual(["←"]);
    expect(chords("global.windowFullscreen")).toEqual(["W"]);
    expect(chords("comic.zoomIn")).toEqual(["Ctrl + =", "Ctrl + +"]);
    expect(screen.queryByTestId("key-add-global.escape")).toBeNull();
    expect(screen.queryByTestId("key-remove-global.escape-0")).toBeNull();
    // The recording keys are shown too, and changed on their own page.
    expect(screen.getByTestId("shortcuts-goto-recording")).toBeTruthy();
  });

  it("adds a key by pressing it, keeps it, and offers to put the default back", async () => {
    const store = installStore();
    render(<Harness />);
    expect(screen.queryByTestId("key-reset-video.customRate")).toBeNull();
    add("video.customRate", "y");
    await waitFor(() => expect(chords("video.customRate")).toEqual(["R", "Y"]));
    expect(store.saved()).toEqual({ "video.customRate": ["R", "Y"] });
    fireEvent.click(screen.getByTestId("key-remove-video.customRate-0"));
    await waitFor(() => expect(chords("video.customRate")).toEqual(["Y"]));
    fireEvent.click(screen.getByTestId("key-reset-video.customRate"));
    await waitFor(() => expect(chords("video.customRate")).toEqual(["R"]));
    expect(store.saved()).toEqual({});
  });

  it("refuses a key another action of the reader has, or a global one, and says which action has it", async () => {
    const store = installStore();
    render(<Harness />);
    add("video.customRate", "s");
    expect(screen.getByTestId("key-message").textContent).toContain("S 已被“截图”使用");
    expect(chords("video.customRate")).toEqual(["R"]);
    add("comic.zoomReset", "w");
    expect(screen.getByTestId("key-message").textContent).toContain("W 已被“窗口全屏");
    // The comic's S is the comic's own, and the video's is the video's: the same key in two readers is not a conflict.
    add("comic.zoomReset", "z");
    await waitFor(() => expect(chords("comic.zoomReset")).toEqual(["Ctrl + 0", "Z"]));
    expect(screen.queryByTestId("key-message")).toBeNull();
    expect(store.saved()).toEqual({ "comic.zoomReset": ["Ctrl+0", "Z"] });
  });

  it("takes a key with its modifiers, and an action may be left with no key", async () => {
    installStore();
    render(<Harness />);
    add("video.markA", "k", { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(chords("video.markA")).toEqual(["I", "Ctrl + Shift + K"]));
    fireEvent.click(screen.getByTestId("key-remove-video.markA-0"));
    await waitFor(() => expect(chords("video.markA")).toEqual(["Ctrl + Shift + K"]));
    fireEvent.click(screen.getByTestId("key-remove-video.markA-0"));
    await waitFor(() => expect(screen.getByTestId("key-none-video.markA")).toBeTruthy());
  });

  it("lets Esc and Tab back out of a key capture, and keeps the key out of the rest of the window while it waits", async () => {
    const store = installStore();
    const elsewhere = vi.fn();
    window.addEventListener("keydown", elsewhere);
    render(<Harness />);
    fireEvent.click(screen.getByTestId("key-add-video.customRate"));
    expect(screen.getByTestId("key-add-video.customRate").textContent).toContain("请按下新的键");
    fireEvent.keyDown(window, { key: "q" });
    // The key was the capture's: nothing else in the window saw it.
    expect(elsewhere).not.toHaveBeenCalled();
    await waitFor(() => expect(chords("video.customRate")).toEqual(["R", "Q"]));
    fireEvent.click(screen.getByTestId("key-add-video.customRate"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("key-add-video.customRate").textContent).toContain("添加按键");
    fireEvent.click(screen.getByTestId("key-add-video.customRate"));
    fireEvent.keyDown(window, { key: "Tab" });
    expect(screen.getByTestId("key-add-video.customRate").textContent).toContain("添加按键");
    expect(store.saved()).toEqual({ "video.customRate": ["R", "Q"] });
    window.removeEventListener("keydown", elsewhere);
  });

  it("refuses to put a default back where another action has taken the key, and puts every default back in one step", async () => {
    const store = installStore();
    render(<Harness />);
    // Mute moves from M to N; the custom-rate key takes M.
    fireEvent.click(screen.getByTestId("key-remove-video.mute-0"));
    await waitFor(() => expect(screen.getByTestId("key-none-video.mute")).toBeTruthy());
    add("video.mute", "n");
    await waitFor(() => expect(chords("video.mute")).toEqual(["N"]));
    add("video.customRate", "m");
    await waitFor(() => expect(chords("video.customRate")).toEqual(["R", "M"]));
    fireEvent.click(screen.getByTestId("key-reset-video.mute"));
    expect(screen.getByTestId("key-message").textContent).toContain("M 现在被“切换自定义倍速");
    expect(chords("video.mute")).toEqual(["N"]);
    expect(store.saved()).toEqual({ "video.mute": ["N"], "video.customRate": ["R", "M"] });
    fireEvent.click(screen.getByTestId("keys-reset-all"));
    await waitFor(() => expect(chords("video.mute")).toEqual(["M"]));
    expect(chords("video.customRate")).toEqual(["R"]);
    expect(store.saved()).toEqual({});
    expect((screen.getByTestId("keys-reset-all") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows what the server refuses instead of keeping it", async () => {
    installStore();
    render(<Harness />);
    const manga = (window as unknown as { manga: { command: (payload: unknown) => Promise<unknown> } }).manga;
    const original = manga.command;
    manga.command = async (payload: unknown) => (payload as { commandId: string }).commandId === "settings.setMedia"
      ? { status: "error", error: { code: "INVALID", message: "X is used by video.toggle and video.mute" } }
      : original(payload);
    add("video.customRate", "x");
    await waitFor(() => expect(screen.getByTestId("key-message").textContent).toContain("没有保存"));
    expect(chords("video.customRate")).toEqual(["R"]);
  });

  it("starts from the defaults of the table", () => {
    expect(resolveKeys(null)["video.customRate"]).toEqual(["R"]);
  });
});

function RateHarness(props: { start: number[]; onChange?: (rates: number[]) => void }) {
  const [rates, setRates] = useState(props.start);
  return <RateList t={i18n.t} rates={rates} onChange={(next) => { props.onChange?.(next); setRates(next); }} />;
}

const type = (testId: string, text: string) => {
  fireEvent.change(screen.getByTestId(testId), { target: { value: text } });
  fireEvent.keyDown(screen.getByTestId(testId), { key: "Enter" });
};

describe("Settings › the list of rates (AT-90)", () => {
  const DEFAULT = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

  it("changes 1.25 to 1.3, removes 3, adds one, and keeps the list sorted", () => {
    const onChange = vi.fn();
    render(<RateHarness start={DEFAULT} onChange={onChange} />);
    type("msettings-rate-input-1_25", "1.3");
    expect(onChange).toHaveBeenLastCalledWith([0.5, 0.75, 1, 1.3, 1.5, 2, 3]);
    fireEvent.click(screen.getByTestId("msettings-rate-remove-3"));
    expect(onChange).toHaveBeenLastCalledWith([0.5, 0.75, 1, 1.3, 1.5, 2]);
    type("msettings-rate-new", "0.6");
    expect(onChange).toHaveBeenLastCalledWith([0.5, 0.6, 0.75, 1, 1.3, 1.5, 2]);
    // Changing a rate past its neighbour sorts the list again.
    type("msettings-rate-input-0_6", "1.8");
    expect(onChange).toHaveBeenLastCalledWith([0.5, 0.75, 1, 1.3, 1.5, 1.8, 2]);
    expect(screen.queryByTestId("msettings-rate-error")).toBeNull();
  });

  it("keeps 1x: it has no field and no remove button", () => {
    render(<RateHarness start={DEFAULT} />);
    expect(screen.queryByTestId("msettings-rate-input-1")).toBeNull();
    expect(screen.queryByTestId("msettings-rate-remove-1")).toBeNull();
    expect(screen.getByTestId("msettings-rate-1").textContent).toContain("1×");
  });

  it("refuses a rate out of range, with three decimals, repeated or not a number, and says why", () => {
    const onChange = vi.fn();
    render(<RateHarness start={DEFAULT} onChange={onChange} />);
    for (const bad of ["0.2", "4.5", "1.255", "abc"]) {
      type("msettings-rate-new", bad);
      expect(screen.getByTestId("msettings-rate-error").textContent, bad).toContain("0.25 到 4");
    }
    type("msettings-rate-new", "2");
    expect(screen.getByTestId("msettings-rate-error").textContent).toContain("2× 已在列表里");
    type("msettings-rate-input-1_5", "2");
    expect(screen.getByTestId("msettings-rate-error").textContent).toContain("2× 已在列表里");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("msettings-rate-new").getAttribute("aria-invalid")).toBe("true");
    // A valid rate clears the message.
    type("msettings-rate-new", "2.5");
    expect(screen.queryByTestId("msettings-rate-error")).toBeNull();
  });

  it("holds at most 16 rates, puts the defaults back, and takes a custom rate with the same bounds", () => {
    const onChange = vi.fn();
    const many = Array.from({ length: 16 }, (_, index) => (index === 0 ? 1 : 0.25 + index * 0.1));
    render(<RateHarness start={many.map((value) => Math.round(value * 100) / 100)} onChange={onChange} />);
    type("msettings-rate-new", "3.9");
    expect(screen.getByTestId("msettings-rate-error").textContent).toContain("最多 16 项");
    cleanup();
    render(<RateHarness start={[1, 2]} onChange={onChange} />);
    fireEvent.click(screen.getByTestId("msettings-rate-reset"));
    expect(onChange).toHaveBeenLastCalledWith(DEFAULT);
    cleanup();
    const custom = vi.fn();
    render(<CustomRate t={i18n.t} value={1.5} onChange={custom} />);
    type("msettings-video-custom", "1.7");
    expect(custom).toHaveBeenLastCalledWith(1.7);
    type("msettings-video-custom", "9");
    expect(screen.getByTestId("msettings-custom-error").textContent).toContain("0.25 到 4");
    expect(custom).toHaveBeenCalledTimes(1);
  });
});
