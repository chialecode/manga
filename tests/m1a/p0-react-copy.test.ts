/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { createTranslator } from "@manga/i18n";

describe("P0 React message rendering", () => {
  it("renders Chinese empty and error copy", async () => {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("<!doctype html><html lang='zh-CN'><body></body></html>");
    const i18n = createTranslator("zh-CN");
    const p = dom.window.document.createElement("p");
    p.textContent = i18n.t("agent.empty");
    dom.window.document.body.append(p);
    const err = dom.window.document.createElement("div");
    err.setAttribute("role", "alert");
    err.textContent = i18n.t("status.error");
    dom.window.document.body.append(err);
    expect(dom.window.document.body.textContent).toContain("从这里开始一次任务");
    expect(dom.window.document.querySelector("[role=alert]")?.textContent).toContain("无法完成");
  });
});
