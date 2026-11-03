/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { OutsideSection } from "../../apps/desktop/src/renderer/pages/settings/outside-section.tsx";

const i18n = createTranslator("zh-CN");
type Call = { commandId: string; input: Record<string, unknown> };

function installHost(answers: Record<string, (input: Record<string, unknown>) => unknown>) {
  const calls: Call[] = [];
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input?: Record<string, unknown> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      return { status: "ok", value: answers[payload.commandId]?.(input) ?? {} };
    },
    onNotice: () => () => undefined,
  };
  return calls;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const OUTSIDE = {
  total: 2,
  groups: [
    { folder: "/合成/旧位置/乙系列", items: [{ resourceId: "r1", title: "第1章", kind: "novel", workTitle: "乙系列" }, { resourceId: "r2", title: "第2章", kind: "novel", workTitle: "乙系列" }] },
  ],
};
const PREVIEW = { resources: 2, remove: { files: 2, assets: 0, playCopies: 0, danmakuMatches: 0 }, keep: { notes: 1, bookmarks: 0, recordings: 0, screenshots: 0, conversations: 0, progress: 1 } };

describe("AT-137 the resources outside the library paths, in the library settings", () => {
  it("is not there when there are none", async () => {
    const calls = installHost({ "library.outside": () => ({ total: 0, groups: [] }) });
    render(<OutsideSection t={i18n.t} refreshKey={0} onViewRecords={() => {}} onChanged={() => {}} onError={() => {}} onNotice={() => {}} />);
    await waitFor(() => expect(calls.some((call) => call.commandId === "library.outside")).toBe(true));
    expect(screen.queryByTestId("library-outside")).toBeNull();
  });

  it("lists them by folder with the count, opens the view of what was made on one, and removes the records after a confirmation that counts what goes and what stays", async () => {
    let removed = false;
    const calls = installHost({
      "library.outside": () => (removed ? { total: 0, groups: [] } : OUTSIDE),
      "library.outsidePreview": () => PREVIEW,
      "library.removeOutside": () => { removed = true; return { removed: 2 }; },
    });
    const viewed = vi.fn();
    const changed = vi.fn();
    const notices: string[] = [];
    render(<OutsideSection t={i18n.t} refreshKey={0} onViewRecords={viewed} onChanged={changed} onError={() => {}} onNotice={(message) => notices.push(message)} />);
    const section = await screen.findByTestId("library-outside");
    expect(section.textContent).toContain("不在资源库位置里的资源（2）");
    expect(within(section).getAllByTestId("library-outside-group")).toHaveLength(1);
    expect(within(section).getByTestId("library-outside-add").textContent).toContain("把这个文件夹加为资源库位置");
    fireEvent.click(within(section).getByTestId("library-outside-view-r1"));
    expect(viewed).toHaveBeenCalledWith("r1", "novel");

    // Nothing is removed before the confirmation; the confirmation says what goes, what stays, and that it cannot be undone.
    fireEvent.click(within(section).getByTestId("library-outside-remove"));
    const confirm = await screen.findByTestId("library-outside-confirm");
    expect(calls.some((call) => call.commandId === "library.removeOutside")).toBe(false);
    expect(confirm.textContent).toContain("文件登记 2 条");
    expect(confirm.textContent).toContain("笔记 1 篇");
    expect(confirm.textContent).toContain("不能撤销；文件不会被删除");
    fireEvent.click(within(confirm).getByTestId("library-outside-confirm-remove"));
    await waitFor(() => expect(calls.filter((call) => call.commandId === "library.removeOutside").map((call) => call.input)).toEqual([{ expectedCount: 2 }]));
    await waitFor(() => expect(screen.queryByTestId("library-outside")).toBeNull());
    expect(changed).toHaveBeenCalled();
    expect(notices.at(-1)).toContain("2");
  });
});
