/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { ElsewhereBar } from "../../apps/desktop/src/renderer/workspace/elsewhere-bar.tsx";
import type { Elsewhere } from "../../apps/desktop/src/renderer/workspace/elsewhere.ts";

const i18n = createTranslator("zh-CN");

const seen = (patch: Partial<Elsewhere> = {}): Elsewhere => ({
  contextId: "project-1", contextName: "合成项目", locator: { page: 4 }, percent: 0.4, completion: "reading", lastInteractionAt: "2026-10-22T08:00:00.000Z", ...patch,
});

afterEach(cleanup);

describe("the line over a reader that another context has already started", () => {
  it("says where the resource was seen, and going there or putting the line away is the person's choice", () => {
    const onJump = vi.fn();
    const onDismiss = vi.fn();
    render(<ElsewhereBar t={i18n.t} elsewhere={seen()} onJump={onJump} onDismiss={onDismiss} />);

    expect(screen.getByTestId("elsewhere-bar").getAttribute("role")).toBe("status");
    expect(screen.getByTestId("elsewhere-text").textContent).toBe("你在“合成项目”里已经看到 40%");
    // Showing the line does nothing to the position: neither button has been pressed.
    expect(onJump).not.toHaveBeenCalled();
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("elsewhere-jump"));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("elsewhere-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("elsewhere-dismiss").getAttribute("aria-label")).toBe("知道了");
  });

  it("keeps the percentage inside 0–100 and rounds it to a whole number", () => {
    const { rerender } = render(<ElsewhereBar t={i18n.t} elsewhere={seen({ percent: 0.4567 })} onJump={() => {}} onDismiss={() => {}} />);
    expect(screen.getByTestId("elsewhere-text").textContent).toContain("46%");
    rerender(<ElsewhereBar t={i18n.t} elsewhere={seen({ percent: 1.7 })} onJump={() => {}} onDismiss={() => {}} />);
    expect(screen.getByTestId("elsewhere-text").textContent).toContain("100%");
    rerender(<ElsewhereBar t={i18n.t} elsewhere={seen({ percent: -0.2 })} onJump={() => {}} onDismiss={() => {}} />);
    expect(screen.getByTestId("elsewhere-text").textContent).toContain("0%");
  });
});
