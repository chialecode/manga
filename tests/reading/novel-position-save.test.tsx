/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { useNovel } from "../../apps/desktop/src/renderer/hooks/use-novel.ts";

type Call = { commandId: string; input: Record<string, unknown> };

/** A page turned just before the reader closes, or the window does, is still saved (A-115): the waiting save is made at once, not dropped. */
describe("the novel reader's last position", () => {
  const calls: Call[] = [];
  const document = { resourceId: "res_1", revisionId: "rev_1", title: "合成书", format: "txt", parts: [{ id: "p1", length: 5000 }], slice: null, assets: [] };

  function setup() {
    calls.length = 0;
    (window as unknown as { manga: unknown }).manga = {
      command: vi.fn(async (envelope: { commandId: string; input: Record<string, unknown> }) => {
        calls.push({ commandId: envelope.commandId, input: envelope.input });
        if (envelope.commandId === "library.read") return { status: "ok", value: document };
        return { status: "ok", value: envelope.commandId === "reading.bookmarks" ? [] : {} };
      }),
    };
    return renderHook(() => useNovel({
      i18n: createTranslator("zh-CN"), setError: () => undefined, setNotice: () => undefined, contextId: null, tabId: "tab_1",
      openNote: () => undefined, refresh: async () => undefined,
    }));
  }
  const saved = () => calls.filter((call) => call.commandId === "progress.set").map((call) => (call.input.locator as { range: { start: number } }).range.start);

  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("saves the page on screen when the reader goes away before the save was due", async () => {
    const view = setup();
    await act(async () => { await view.result.current.openResource("res_1"); });
    vi.useFakeTimers();
    act(() => { view.result.current.savePosition("p1", 1200, 1500); });
    expect(saved()).toEqual([]);
    view.unmount();
    expect(saved()).toEqual([1200]);
    // Nothing is saved twice when the timer would have come.
    vi.advanceTimersByTime(2000);
    expect(saved()).toEqual([1200]);
  });

  it("saves it when the window is closing, and only once", async () => {
    const view = setup();
    await act(async () => { await view.result.current.openResource("res_1"); });
    vi.useFakeTimers();
    act(() => { view.result.current.savePosition("p1", 2400, 2700); });
    window.dispatchEvent(new Event("pagehide"));
    expect(saved()).toEqual([2400]);
    vi.advanceTimersByTime(2000);
    view.unmount();
    expect(saved()).toEqual([2400]);
  });

  it("still waits for the reader to rest on a page before saving it", async () => {
    const view = setup();
    await act(async () => { await view.result.current.openResource("res_1"); });
    vi.useFakeTimers();
    act(() => { view.result.current.savePosition("p1", 100, 400); });
    act(() => { view.result.current.savePosition("p1", 400, 700); });
    expect(saved()).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(saved()).toEqual([400]);
  });
});
