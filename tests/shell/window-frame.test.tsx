/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_SHELL_PREFERENCE } from "@manga/contracts";
import { ShellFrame } from "../../apps/desktop/src/renderer/shell.tsx";
import { RAIL_WIDTH, SIDE_WIDTH, clampSide, dragLimit } from "../../packages/app-core/src/domain/shell-layout.ts";
import { frame, frameProps, menus, pointer, shellRail, windowHost } from "../helpers/shell-frame.tsx";

beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });
afterEach(() => { cleanup(); delete (window as unknown as { manga?: unknown }).manga; });

const order = (root: Element, ids: string[]) => Array.from(root.querySelectorAll(ids.map((id) => `[data-testid='${id}']`).join(", "))).map((node) => node.getAttribute("data-testid"));

describe("AT-81 AT-111 window frame: the top row, the rail and the columns", () => {
  it("has one top row across the window with every control in it, the icon rail, the sidebar, the main area and the dock under it, and names no channel", async () => {
    windowHost();
    const { container } = frame(1600, 900);
    // One row across the top (UI-01); it is the first thing in the window and the columns are under it.
    expect(container.querySelectorAll("header").length).toBe(1);
    const root = screen.getByTestId("shell-root");
    const top = screen.getByTestId("shell-top");
    expect(root.firstElementChild).toBe(top);
    expect(top.classList.contains("shell-drag")).toBe(true);
    // The sidebar's switch, back, forward and the menus stand at its left, the debugging and dock switches and the window's buttons at its right.
    const left = top.querySelector(".top-left")!;
    expect(order(left, ["shell-sidebar-toggle", "nav-back", "nav-forward", "menubar"])).toEqual(["shell-sidebar-toggle", "nav-back", "nav-forward", "menubar"]);
    const right = top.querySelector(".top-right")!;
    await screen.findByTestId("window-controls");
    expect(right.lastElementChild).toBe(screen.getByTestId("window-controls"));
    expect(right.contains(screen.getByTestId("shell-dock-toggle"))).toBe(true);
    expect(top.querySelectorAll("[data-testid='window-controls']").length).toBe(1);
    // Under the top: the rail, the sidebar, the main area, the dock, side by side, and dividers between the columns that are docked.
    const body = root.querySelector(".shell-body")!;
    expect(order(body, ["shell-rail", "shell-sidebar", "shell-resize-sidebar", "shell-main", "shell-resize-dock", "shell-dock"])).toEqual(["shell-rail", "shell-sidebar", "shell-resize-sidebar", "shell-main", "shell-resize-dock", "shell-dock"]);
    expect(screen.getByTestId("shell-rail").style.width).toBe(`${RAIL_WIDTH}px`);
    expect(screen.getByTestId("shell-sidebar").getAttribute("data-shell-state")).toBe("dock");
    expect(screen.getByTestId("shell-dock").getAttribute("data-shell-state")).toBe("dock");
    // There is no switch between modes anywhere.
    expect(root.querySelector("[data-testid^='mode-']")).toBeNull();
    expect(screen.getByTestId("sidebar-slot")).toBeTruthy();
    expect(screen.getByTestId("main-slot")).toBeTruthy();
    expect(screen.getByTestId("dock-slot")).toBeTruthy();
    // The build's channel is not in the top (it is in the About dialog).
    expect(root.textContent).not.toMatch(/测试通道|开发版|正式版/);
  });

  it("keeps the same top row in a window too narrow for the columns, and opens them over the page from their buttons", async () => {
    windowHost();
    frame(800, 700);
    const top = screen.getByTestId("shell-top");
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
    expect(screen.queryByTestId("shell-resize-sidebar")).toBeNull();
    expect(order(top, ["shell-sidebar-toggle", "nav-back", "nav-forward", "menubar", "shell-dock-toggle"])).toEqual(["shell-sidebar-toggle", "nav-back", "nav-forward", "menubar", "shell-dock-toggle"]);
    // The window's buttons are still at the end of the only top there is, and the rail is still there.
    await screen.findByTestId("window-controls");
    expect(top.querySelector(".top-right")!.lastElementChild).toBe(screen.getByTestId("window-controls"));
    expect(screen.getByTestId("shell-rail")).toBeTruthy();
    // A button opens its column over the page; the dock cannot be over it at the same time as the sidebar.
    fireEvent.click(screen.getByTestId("shell-dock-toggle"));
    expect(screen.getByTestId("shell-dock").getAttribute("data-shell-state")).toBe("overlay");
    fireEvent.click(screen.getByTestId("shell-sidebar-toggle"));
    expect(screen.getByTestId("shell-sidebar").getAttribute("data-shell-state")).toBe("overlay");
    expect(screen.getByTestId("shell-dock").getAttribute("data-shell-state")).toBe("hidden");
  });

  it("folds the dock and then the sidebar into overlays as the main area would drop below its floor, and a layout of several columns asks for more", () => {
    frame(1000, 800);
    // 1000 - 48 - 260 - 360 = 332 < 560: the dock folds first; the sidebar still docks (692 >= 560).
    expect(screen.getByTestId("shell-sidebar").getAttribute("data-shell-state")).toBe("dock");
    expect(screen.getByTestId("shell-main").getAttribute("data-measure")).toBe("680");
    cleanup();
    frame(1000, 800, { mainFloor: 740 });
    // Four columns need 2 x 320 and more: the sidebar folds as well.
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
    cleanup();
    frame(1280, 840, { mainFloor: 1100 });
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
  });

  it("brings the page up to the window's edges in the window-fullscreen state: no rail, no columns, and a top that floats", () => {
    const { rerender } = frame(1600, 900, { immersive: true });
    expect(screen.queryByTestId("shell-rail")).toBeNull();
    expect(screen.queryByTestId("shell-sidebar")).toBeNull();
    expect(screen.queryByTestId("shell-resize-sidebar")).toBeNull();
    expect(screen.queryByTestId("shell-sidebar-toggle")).toBeNull();
    expect(screen.getByTestId("shell-root").getAttribute("data-immersive")).toBe("true");
    expect(screen.getByTestId("shell-top").getAttribute("data-immersive")).toBe("true");
    // The strip that is the drag area and the hot zone under it stand over the page, which has nothing taken from it by them.
    expect(screen.getByTestId("immersive-hotzone")).toBeTruthy();
    expect(screen.getByTestId("immersive-drag")).toBeTruthy();
    expect(screen.getByTestId("shell-main").textContent).toContain("主面板");
    // The floating top has the way out; the pointer on it brings it down.
    expect(screen.getByTestId("immersive-exit")).toBeTruthy();
    fireEvent.mouseEnter(screen.getByTestId("immersive-hotzone"));
    expect(screen.getByTestId("shell-top").getAttribute("data-revealed")).toBe("true");
    expect(screen.queryByTestId("immersive-hotzone")).toBeNull();
    // With the window ordinary again the columns come back as they were.
    rerender(<ShellFrame {...frameProps(1600, 900)} />);
    expect(screen.getByTestId("shell-sidebar")).toBeTruthy();
    expect(screen.getByTestId("shell-rail")).toBeTruthy();
    expect(screen.getByTestId("shell-root").getAttribute("data-immersive")).toBe("false");
    expect(screen.queryByTestId("immersive-hotzone")).toBeNull();
  });

  it("walks the tab's history from the back and forward buttons, and disables a button with nowhere to go", () => {
    const onBack = vi.fn();
    const onForward = vi.fn();
    frame(1280, 840, { history: { canBack: true, canForward: false, onBack, onForward } });
    const back = screen.getByTestId("nav-back") as HTMLButtonElement;
    const forward = screen.getByTestId("nav-forward") as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    expect(forward.disabled).toBe(true);
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    fireEvent.click(forward);
    expect(onForward).not.toHaveBeenCalled();
    cleanup();
    frame(1280, 840, { history: { canBack: false, canForward: true, onBack, onForward } });
    expect((screen.getByTestId("nav-back") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("nav-forward"));
    expect(onForward).toHaveBeenCalledTimes(1);
  });

  it("has four menus in the top row, opens one and runs the command that is picked", () => {
    const picked = vi.fn();
    frame(1280, 840, { menus: menus(picked) });
    const bar = screen.getByTestId("menubar");
    expect(within(bar).getAllByRole("button").map((node) => node.textContent)).toEqual(["文件", "编辑", "视图", "帮助"]);
    fireEvent.click(screen.getByTestId("menu-file"));
    expect(screen.getAllByRole("menuitem").map((node) => node.textContent)).toEqual(["新标签页", "退出"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "新标签页" }));
    expect(picked).toHaveBeenCalledWith("new-tab");
    expect(picked).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    // Escape closes an open menu and returns the focus to its button.
    fireEvent.click(screen.getByTestId("menu-help"));
    expect(screen.getAllByRole("menuitem").map((node) => node.textContent)).toEqual(["关于"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTestId("menu-help"));
  });

  it("drags a divider to resize its column inside the limits, and puts the default back on a double click", () => {
    const onResize = vi.fn();
    frame(1600, 900, { onResize });
    const sidebar = screen.getByTestId("shell-resize-sidebar");
    expect(sidebar.getAttribute("role")).toBe("separator");
    expect(sidebar.getAttribute("aria-valuenow")).toBe(String(SIDE_WIDTH.sidebar.initial));
    expect(sidebar.getAttribute("aria-valuemin")).toBe(String(SIDE_WIDTH.sidebar.min));
    pointer(sidebar, "pointerdown", 308);
    pointer(sidebar, "pointermove", 368);
    // The column follows the pointer while it is held; nothing is saved yet.
    expect(screen.getByTestId("shell-sidebar").style.width).toBe(`${SIDE_WIDTH.sidebar.initial + 60}px`);
    expect(onResize).not.toHaveBeenCalled();
    pointer(sidebar, "pointerup", 368);
    expect(onResize).toHaveBeenCalledWith("sidebar", SIDE_WIDTH.sidebar.initial + 60);
    // Far past the limit stops at the limit; far short of the least stops there.
    pointer(sidebar, "pointerdown", 308);
    pointer(sidebar, "pointerup", 5000);
    expect(onResize).toHaveBeenLastCalledWith("sidebar", dragLimit("sidebar", 1600, SIDE_WIDTH.dock.initial));
    pointer(sidebar, "pointerdown", 308);
    pointer(sidebar, "pointerup", -4000);
    expect(onResize).toHaveBeenLastCalledWith("sidebar", SIDE_WIDTH.sidebar.min);
    // The dock grows toward the left.
    const dock = screen.getByTestId("shell-resize-dock");
    pointer(dock, "pointerdown", 1200);
    pointer(dock, "pointerup", 1100);
    expect(onResize).toHaveBeenLastCalledWith("dock", SIDE_WIDTH.dock.initial + 100);
    // A double click restores each column's default.
    fireEvent.doubleClick(sidebar);
    expect(onResize).toHaveBeenLastCalledWith("sidebar", SIDE_WIDTH.sidebar.initial);
    fireEvent.doubleClick(dock);
    expect(onResize).toHaveBeenLastCalledWith("dock", SIDE_WIDTH.dock.initial);
  });

  it("moves a divider with the keyboard, so the widths do not need a pointer", () => {
    const onResize = vi.fn();
    frame(1600, 900, { onResize });
    const sidebar = screen.getByTestId("shell-resize-sidebar");
    expect(sidebar.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(sidebar, { key: "ArrowRight" });
    expect(onResize).toHaveBeenLastCalledWith("sidebar", SIDE_WIDTH.sidebar.initial + 16);
    fireEvent.keyDown(sidebar, { key: "ArrowRight", shiftKey: true });
    expect(onResize).toHaveBeenLastCalledWith("sidebar", SIDE_WIDTH.sidebar.initial + 48);
    fireEvent.keyDown(sidebar, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenLastCalledWith("sidebar", SIDE_WIDTH.sidebar.initial - 16);
    fireEvent.keyDown(sidebar, { key: "Home" });
    expect(onResize).toHaveBeenLastCalledWith("sidebar", SIDE_WIDTH.sidebar.min);
    fireEvent.keyDown(sidebar, { key: "Enter" });
    expect(onResize).toHaveBeenLastCalledWith("sidebar", SIDE_WIDTH.sidebar.initial);
    const dock = screen.getByTestId("shell-resize-dock");
    fireEvent.keyDown(dock, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenLastCalledWith("dock", SIDE_WIDTH.dock.initial + 16);
    fireEvent.keyDown(dock, { key: "ArrowRight" });
    expect(onResize).toHaveBeenLastCalledWith("dock", SIDE_WIDTH.dock.initial - 16);
  });

  it("shows a saved width, and keeps the stored widths inside what a column can be", () => {
    const wide = structuredClone(DEFAULT_SHELL_PREFERENCE);
    wide.sidebar.width = 360;
    wide.dock.width = 520;
    frame(1700, 900, { preference: wide });
    expect(screen.getByTestId("shell-sidebar").style.width).toBe("360px");
    expect(screen.getByTestId("shell-dock").style.width).toBe("520px");
    expect(clampSide("sidebar", 9999)).toBe(SIDE_WIDTH.sidebar.max);
    expect(clampSide("dock", 10)).toBe(SIDE_WIDTH.dock.min);
    // No divider where a column is not docked.
    cleanup();
    frame(800, 700);
    expect(screen.queryByTestId("shell-resize-sidebar")).toBeNull();
    expect(screen.queryByTestId("shell-resize-dock")).toBeNull();
  });

  it("hides a column from its switch and shows it again, and has no dock, switch or capsule where nothing is shown there", () => {
    const hide = vi.fn();
    const show = vi.fn();
    frame(1600, 900, { onHide: hide, onShow: show, capsule: <div data-testid="capsule-slot">胶囊</div> });
    // A docked column is hidden from its switch; the capsule is only for a dock that is folded away.
    fireEvent.click(screen.getByTestId("shell-sidebar-toggle"));
    expect(hide).toHaveBeenCalledWith("sidebar");
    fireEvent.click(screen.getByTestId("shell-dock-toggle"));
    expect(hide).toHaveBeenLastCalledWith("dock");
    expect(screen.queryByTestId("capsule-slot")).toBeNull();
    cleanup();
    const folded = structuredClone(DEFAULT_SHELL_PREFERENCE);
    folded.dock.visible = false;
    frame(1600, 900, { preference: folded, onShow: show, capsule: <div data-testid="capsule-slot">胶囊</div> });
    expect(screen.getByTestId("shell-main").contains(screen.getByTestId("capsule-slot"))).toBe(true);
    fireEvent.click(screen.getByTestId("shell-dock-toggle"));
    expect(show).toHaveBeenCalledWith("dock");
    cleanup();
    // A conversation tab in front: the same conversation is not shown twice, so there is no dock, no switch for one and no capsule.
    frame(1600, 900, { hasDock: false, capsule: <div data-testid="capsule-slot">胶囊</div> });
    expect(screen.queryByTestId("shell-dock")).toBeNull();
    expect(screen.queryByTestId("shell-dock-toggle")).toBeNull();
    expect(screen.queryByTestId("capsule-slot")).toBeNull();
  });

  it("opens the columns from their keys, and the sidebar key hides a docked sidebar", () => {
    const hide = vi.fn();
    frame(1600, 900, { onHide: hide, keys: { sidebar: ["Ctrl+B"], dock: ["Ctrl+Alt+B"] } });
    fireEvent.keyDown(window, { key: "b", ctrlKey: true });
    expect(hide).toHaveBeenLastCalledWith("sidebar");
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, altKey: true });
    expect(hide).toHaveBeenLastCalledWith("dock");
    // The key does nothing while a composition is on, or once something has handled it.
    hide.mockClear();
    fireEvent.keyDown(window, { key: "b", ctrlKey: true, isComposing: true });
    expect(hide).not.toHaveBeenCalled();
  });
});

describe("AT-82 AT-111 AT-119 window frame: the icon rail", () => {
  it("has no heading, names every button, marks the view the sidebar is on, and keeps settings at the bottom outside the other buttons", () => {
    const pick = vi.fn();
    const settings = vi.fn();
    frame(1280, 840, { rail: shellRail({ current: "comic", onSelect: pick, settings: { active: false, onSelect: settings } }) });
    const navigation = screen.getByTestId("shell-rail");
    expect(navigation.tagName).toBe("NAV");
    expect(navigation.getAttribute("aria-label")).toBe("图标栏");
    expect(navigation.querySelector("h1, h2")).toBeNull();
    expect(Array.from(navigation.querySelectorAll("button")).map((node) => node.getAttribute("aria-label"))).toEqual(["主页", "对话", "小说", "漫画", "动漫", "笔记", "白板", "设置"]);
    expect(screen.getByTestId("nav-comic").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("nav-home").getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("nav-settings").closest(".rail-bottom")).toBeTruthy();
    expect(screen.getByTestId("nav-home").closest(".rail-bottom")).toBeNull();
    // A name shows on hover, and a click selects the view.
    expect(screen.getByTestId("nav-note").getAttribute("title")).toBe("笔记");
    fireEvent.click(screen.getByTestId("nav-home"));
    expect(pick).toHaveBeenLastCalledWith("home");
    fireEvent.click(screen.getByTestId("nav-settings"));
    expect(settings).toHaveBeenCalledTimes(1);
  });

  it("marks the settings and no view while the settings are on, and shows the settings directory where the sidebar stands", () => {
    frame(1280, 840, { settings: true, rail: shellRail({ current: "comic", settings: { active: true, onSelect: () => undefined } }) });
    expect(screen.getByTestId("nav-settings").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("nav-comic").getAttribute("aria-current")).toBeNull();
    expect(screen.getByTestId("shell-root").getAttribute("data-settings")).toBe("true");
    expect(screen.getByTestId("sidebar-slot").getAttribute("data-view")).toBe("settings");
    expect(screen.getByTestId("shell-sidebar").getAttribute("data-shell-state")).toBe("dock");
    // The dock stays mounted but is out of the way, and has no switch while the settings are on.
    expect(screen.getByTestId("dock-slot")).toBeTruthy();
    expect(screen.queryByTestId("shell-dock-toggle")).toBeNull();
    expect(screen.queryByTestId("shell-resize-dock")).toBeNull();
  });

  it("puts the stop control in the top row only while a task runs", () => {
    const stop = vi.fn();
    frame(1280, 840, { running: true, onStop: stop });
    fireEvent.click(screen.getByTestId("shell-task-stop"));
    expect(stop).toHaveBeenCalledTimes(1);
    cleanup();
    frame(1280, 840);
    expect(screen.queryByTestId("shell-task-stop")).toBeNull();
  });
});

describe("AT-105 the window's own buttons", () => {
  it("draws minimize, maximize and close where the page draws them, named, in that order, and none where the system keeps its own", async () => {
    windowHost();
    frame(1600, 900);
    const group = await screen.findByTestId("window-controls");
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe("窗口控制");
    expect(Array.from(group.querySelectorAll("button")).map((node) => node.getAttribute("aria-label"))).toEqual(["最小化", "最大化", "关闭窗口"]);
    expect(Array.from(group.querySelectorAll("button")).map((node) => node.getAttribute("data-kind"))).toEqual(["minimize", "maximize", "close"]);
    expect(screen.getByTestId("shell-root").getAttribute("data-window-controls")).toBe("page");
    cleanup();
    windowHost({ controls: false, maximized: false });
    frame(1600, 900);
    await waitFor(() => expect(screen.getByTestId("shell-root").getAttribute("data-window-controls")).toBe("system"));
    expect(screen.queryByTestId("window-controls")).toBeNull();
    cleanup();
    // No host (a page opened by a test, or before the main process has answered): the buttons are not drawn, so a window never shows two sets.
    delete (window as unknown as { manga?: unknown }).manga;
    frame(1600, 900);
    expect(screen.queryByTestId("window-controls")).toBeNull();
    expect(screen.getByTestId("shell-root").getAttribute("data-window-controls")).toBe("none");
  });

  it("asks the main process for exactly the action of the button that was pressed", async () => {
    const { action } = windowHost();
    frame(1600, 900);
    await screen.findByTestId("window-controls");
    fireEvent.click(screen.getByTestId("window-minimize"));
    fireEvent.click(screen.getByTestId("window-maximize"));
    fireEvent.click(screen.getByTestId("window-close"));
    expect(action.mock.calls.map((call) => call[0])).toEqual(["minimize", "toggle-maximize", "close"]);
  });

  it("shows restore while the window is maximized, whoever maximized it, and maximize again after", async () => {
    const { push } = windowHost();
    frame(1600, 900);
    const group = await screen.findByTestId("window-controls");
    expect(group.getAttribute("data-maximized")).toBe("false");
    expect(screen.getByTestId("window-maximize").getAttribute("aria-label")).toBe("最大化");
    push({ controls: true, maximized: true });
    expect(screen.getByTestId("window-controls").getAttribute("data-maximized")).toBe("true");
    expect(screen.getByTestId("window-maximize").getAttribute("aria-label")).toBe("还原");
    expect(screen.getByTestId("window-maximize").getAttribute("title")).toBe("还原");
    push({ controls: true, maximized: false });
    expect(screen.getByTestId("window-maximize").getAttribute("aria-label")).toBe("最大化");
  });

  it("is never part of a drag area, while the top it stands in is one", async () => {
    windowHost();
    frame(1600, 900);
    const group = await screen.findByTestId("window-controls");
    expect(group.classList.contains("shell-no-drag")).toBe(true);
    expect(group.closest(".shell-top")!.classList.contains("shell-drag")).toBe(true);
    const css = readFileSync("apps/desktop/src/renderer/styles.css", "utf8");
    expect(css).toMatch(/\.shell-no-drag \{[^}]*app-region: no-drag/);
    expect(css).toMatch(/\.shell-drag \{[^}]*app-region: drag/);
  });

  it("takes its colors from the theme's tokens, with a red close button on hover, and has no color of its own", () => {
    const css = readFileSync("apps/desktop/src/renderer/styles-frame.css", "utf8");
    const rules = css.split("\n").filter((line) => line.startsWith(".window-control"));
    expect(rules.length).toBeGreaterThan(5);
    const joined = rules.join("\n");
    // Symbols, hover and pressed states come from tokens; the only literal is the white of the close symbol on its danger-colored ground.
    expect(joined).toMatch(/color: var\(--color-text\)/);
    expect(joined).toMatch(/:hover[^{]*\{ background: color-mix\(in srgb, var\(--color-text\) 10%/);
    expect(joined).toMatch(/:active[^{]*\{ background: color-mix\(in srgb, var\(--color-text\) 16%/);
    expect(joined).toMatch(/\[data-kind="close"\]:hover[^{]*\{ background: var\(--color-danger\); color: #fff/);
    expect(joined.replace(/color: #fff/g, "").replace(/#000/g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("AT-111 the frame in a short window", () => {
  it("marks a window shorter than the compact height, and keeps every part of the frame", () => {
    frame(1280, 600);
    expect(screen.getByTestId("shell-root").getAttribute("data-compact")).toBe("true");
    for (const id of ["shell-top", "shell-rail", "shell-sidebar", "shell-main", "shell-dock"]) expect(screen.getByTestId(id), id).toBeTruthy();
    cleanup();
    frame(1280, 840);
    expect(screen.getByTestId("shell-root").getAttribute("data-compact")).toBe("false");
  });
});
