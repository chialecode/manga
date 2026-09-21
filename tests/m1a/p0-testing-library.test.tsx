/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";

function StatusView({ kind }: { kind: "empty" | "error" }) {
  const i18n = createTranslator("zh-CN");
  if (kind === "empty") return <p>{i18n.t("status.empty")}</p>;
  return <div role="alert">{i18n.t("status.error")}</div>;
}

describe("P0 Testing Library states", () => {
  it("renders empty and error states from message keys", () => {
    const empty = render(<StatusView kind="empty" />);
    expect(screen.getByText("还没有内容")).toBeTruthy();
    empty.unmount();
    render(<StatusView kind="error" />);
    expect(screen.getByRole("alert").textContent).toContain("无法完成这次操作");
  });
});
