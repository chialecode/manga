/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { Toasts } from "../../apps/desktop/src/renderer/components/toast.tsx";
import { MatchHost } from "../../apps/desktop/src/renderer/pages/work-match.tsx";

const i18n = createTranslator("zh-CN");

afterEach(() => cleanup());

describe("a notice with one follow-up action", () => {
  it("shows the action beside the notice, runs it once, and closes the notice", () => {
    const action = vi.fn();
    const close = vi.fn();
    render(<Toasts notice="导入完成" noticeAction={{ label: "匹配 Bangumi", onClick: action }} closeLabel="关闭" onCloseNotice={close} onCloseError={() => undefined} />);
    expect(screen.getByTestId("toast-notice").textContent).toContain("导入完成");
    fireEvent.click(screen.getByTestId("toast-notice-action"));
    expect(action).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("shows no action button when none is given", () => {
    render(<Toasts notice="已保存" closeLabel="关闭" onCloseNotice={() => undefined} onCloseError={() => undefined} />);
    expect(screen.queryByTestId("toast-notice-action")).toBeNull();
  });
});

describe("the match dialog opened for a work that is not on screen", () => {
  const host = (works: (input: Record<string, unknown>) => unknown) => {
    const calls: Array<{ commandId: string; input: Record<string, unknown> }> = [];
    (window as unknown as { manga: unknown }).manga = {
      async command(payload: { commandId: string; input?: Record<string, unknown> }) {
        calls.push({ commandId: payload.commandId, input: payload.input ?? {} });
        if (payload.commandId === "works.get") {
          try { return { status: "ok", value: works(payload.input ?? {}) }; } catch (error) { return { status: "error", error: { code: "NOT_FOUND", message: (error as Error).message } }; }
        }
        return { status: "ok", value: payload.commandId === "metadata.candidates" ? { candidates: [] } : {} };
      },
    };
    return calls;
  };
  const work = { id: "w9", title: "刚导入的作品", mediaKind: "comic", linked: false, resources: [], fields: {}, links: [], snapshots: [], override: { fields: {}, locked: [], cleared: [] } };

  it("loads the work, then opens with its title in the box", async () => {
    const calls = host(() => work);
    render(<MatchHost t={i18n.t} workId="w9" formatDate={i18n.formatDate} onClose={() => undefined} onApplied={() => undefined} onOpenExternal={() => undefined} onError={() => undefined} />);
    expect(screen.queryByTestId("work-match")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("work-match")).toBeTruthy());
    expect((screen.getByTestId("match-query") as HTMLInputElement).value).toBe("刚导入的作品");
    expect(calls.find((call) => call.commandId === "works.get")?.input).toEqual({ workId: "w9" });
    // Opening writes nothing.
    expect(calls.filter((call) => call.commandId === "metadata.link")).toHaveLength(0);
  });

  it("reports a work that cannot be read and closes instead of showing an empty dialog", async () => {
    host(() => { throw new Error("no such work"); });
    const closed = vi.fn();
    const errors: string[] = [];
    render(<MatchHost t={i18n.t} workId="gone" formatDate={i18n.formatDate} onClose={closed} onApplied={() => undefined} onOpenExternal={() => undefined} onError={(message) => errors.push(message)} />);
    await waitFor(() => expect(closed).toHaveBeenCalled());
    expect(errors).toEqual(["no such work"]);
    expect(screen.queryByTestId("work-match")).toBeNull();
  });
});
