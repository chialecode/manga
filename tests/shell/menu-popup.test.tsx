/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Menu } from "../../apps/desktop/src/renderer/components/menu.tsx";
import { popupOpen } from "../../apps/desktop/src/renderer/components/popup.tsx";

const read = (path: string) => readFileSync(join(process.cwd(), "apps/desktop/src/renderer", path), "utf8").replace(/\r\n/g, "\n");

const shown: HTMLElement[] = [];

beforeEach(() => {
  // jsdom has no popover: the calls are what is checked, as the browser draws the top layer.
  Object.defineProperty(HTMLElement.prototype, "showPopover", { configurable: true, value(this: HTMLElement) { shown.push(this); this.setAttribute("data-open", "true"); } });
  Object.defineProperty(HTMLElement.prototype, "hidePopover", { configurable: true, value() { /* the box leaves the DOM with the menu */ } });
});
afterEach(() => {
  cleanup();
  shown.length = 0;
  Reflect.deleteProperty(HTMLElement.prototype, "showPopover");
  Reflect.deleteProperty(HTMLElement.prototype, "hidePopover");
});

describe("menus open on the top layer (AT-89)", () => {
  it("shows the list as a popover when it opens, even inside a box that clips its children", () => {
    const pick = vi.fn();
    render(
      <div style={{ overflow: "auto", height: 20 }}>
        <Menu label="字幕" testId="menu" placement="above" align="end" items={[{ id: "a", label: "甲", onSelect: pick }, { id: "b", label: "乙", onSelect: () => undefined, checked: true }]} trigger="打开" />
      </div>,
    );
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(screen.getByTestId("menu"));
    const list = screen.getByRole("menu");
    // The list asked the browser for the top layer: a clip or scroll area around the button cannot cut it.
    expect(list.getAttribute("popover")).toBe("manual");
    expect(shown).toEqual([list]);
    expect(list.getAttribute("data-placement")).toBe("above");
    expect(list.getAttribute("data-align")).toBe("end");
    expect(popupOpen()).toBe(true);
    fireEvent.click(screen.getByTestId("menu-a"));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(popupOpen()).toBe(false);
  });

  it("opens below the button by default and anchors to it", () => {
    render(<Menu label="排序" testId="menu" items={[{ id: "a", label: "甲", onSelect: () => undefined }]} trigger="排序" />);
    fireEvent.click(screen.getByTestId("menu"));
    const list = screen.getByRole("menu");
    expect(list.getAttribute("data-placement")).toBe("below");
    expect(list.getAttribute("data-align")).toBe("start");
  });

  it("closes with Esc (focus back on the button) or a press outside, and keeps a press inside open", () => {
    render(<Menu label="排序" testId="menu" items={[{ id: "a", label: "甲", onSelect: () => undefined }, { id: "b", label: "乙", onSelect: () => undefined }]} trigger="排序" />);
    fireEvent.click(screen.getByTestId("menu"));
    fireEvent.mouseDown(screen.getByTestId("menu-b"));
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId("menu-a"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("menu"));
    fireEvent.click(screen.getByTestId("menu"));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("styles the list as a fixed, anchored popup and not as an absolute box in the button's parent", () => {
    const shelf = read("styles-shelf.css");
    expect(shelf).toMatch(/\.popup \{[^}]*position: fixed[^}]*\}/);
    expect(shelf).toMatch(/\.popup\[data-placement="above"\]\[data-align="end"\] \{ position-area: top span-left; \}/);
    expect(shelf).toMatch(/\.popup \{[^}]*position-try-fallbacks: flip-block/);
    const menuList = /\.menu-list \{([^}]*)\}/.exec(shelf)?.[1] ?? "";
    expect(menuList).not.toMatch(/position:\s*absolute/);
    // The list of a video menu used to be pinned above its button by a rule that only worked inside the "more" panel; that rule is gone.
    expect(read("styles-video.css")).not.toMatch(/\.video-menu \.menu-list/);
  });
});

describe("menus with groups (AT-107)", () => {
  const groups = (pick = vi.fn()) => [
    { id: "one", title: "第一组", items: [{ id: "off", label: "关闭", checked: false, onSelect: pick }, { id: "a", label: "甲", checked: true, onSelect: pick }] },
    { id: "two", title: "第二组", items: [{ id: "off", testId: "menu-two-off", label: "关闭", checked: true, onSelect: pick }, { id: "b", label: "乙", checked: false, disabled: true, onSelect: pick }, { id: "c", label: "丙", checked: false, onSelect: pick }] },
  ];

  it("draws each group under its title, as a labelled group of choices", () => {
    render(<Menu label="字幕" testId="menu" groups={groups()} trigger="打开" />);
    fireEvent.click(screen.getByTestId("menu"));
    const list = screen.getByRole("menu");
    const found = screen.getAllByRole("group");
    expect(found).toHaveLength(2);
    expect(found.map((node) => document.getElementById(node.getAttribute("aria-labelledby")!)?.textContent)).toEqual(["第一组", "第二组"]);
    expect(found.every((node) => list.contains(node))).toBe(true);
    // the same item id in two groups is two different items, told apart by the test id
    expect(screen.getByTestId("menu-off").textContent).toBe("关闭");
    expect(screen.getByTestId("menu-two-off").textContent).toBe("✓ 关闭");
    expect(screen.getByTestId("menu-group-two")).toBe(found[1]);
  });

  it("goes on from the last item of one group to the first of the next, skips what is off, and wraps round", () => {
    render(<Menu label="字幕" testId="menu" groups={groups()} trigger="打开" />);
    fireEvent.click(screen.getByTestId("menu"));
    const focused = () => document.activeElement?.getAttribute("data-testid");
    const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
    expect(focused()).toBe("menu-off");
    press("ArrowDown"); expect(focused()).toBe("menu-a");
    press("ArrowDown"); expect(focused()).toBe("menu-two-off");
    press("ArrowDown"); expect(focused()).toBe("menu-c");
    press("ArrowDown"); expect(focused()).toBe("menu-off");
    press("ArrowUp"); expect(focused()).toBe("menu-c");
    press("Home"); expect(focused()).toBe("menu-off");
    press("End"); expect(focused()).toBe("menu-c");
  });

  it("selects an item of the second group and closes", () => {
    const pick = vi.fn();
    render(<Menu label="字幕" testId="menu" groups={groups(pick)} trigger="打开" />);
    fireEvent.click(screen.getByTestId("menu"));
    fireEvent.click(screen.getByTestId("menu-c"));
    expect(pick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("without groups draws the items as before: no group, no title", () => {
    render(<Menu label="排序" testId="menu" items={[{ id: "a", label: "甲", onSelect: () => undefined }]} trigger="排序" />);
    fireEvent.click(screen.getByTestId("menu"));
    expect(screen.queryAllByRole("group")).toHaveLength(0);
  });

  it("styles the groups apart and lets a long title stay on one line", () => {
    const shelf = read("styles-shelf.css");
    expect(shelf).toMatch(/\.menu-group \+ \.menu-group \{[^}]*border-top/);
    expect(shelf).toMatch(/\.menu-group-title \{[^}]*white-space: nowrap/);
  });
});
