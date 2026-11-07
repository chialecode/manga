/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_SHELL_PREFERENCE } from "@manga/contracts";
import { ShellFrame, type ShellSession } from "../../apps/desktop/src/renderer/shell.tsx";
import { SIDE_WIDTH, clampSide, dragLimit } from "../../packages/app-core/src/domain/shell-layout.ts";

const labels = {
  showLeft: "打开导航", showRight: "打开辅助", hideLeft: "收起导航", hideRight: "收起辅助", stop: "停止任务", modeGroup: "模式",
  menu: "菜单", back: "后退", forward: "前进", rightTitle: "MANGA Agent", resizeLeft: "调整导航栏宽度", resizeRight: "调整辅助栏宽度",
  window: { group: "窗口控制", minimize: "最小化", maximize: "最大化", restore: "还原", close: "关闭窗口" },
};

type WindowState = { controls: boolean; maximized: boolean };
/** The main process as the page sees it: what the window's state is, the three actions it can ask, and the pushes that follow. */
function windowHost(initial: WindowState = { controls: true, maximized: false }) {
  let listener: ((state: WindowState) => void) | null = null;
  let current = initial;
  const action = vi.fn(async (_name: string) => current);
  (window as unknown as { manga: unknown }).manga = {
    windowState: async () => current,
    windowAction: action,
    onWindowState: (next: (state: WindowState) => void) => { listener = next; return () => { listener = null; }; },
  };
  return { action, push: (state: WindowState) => { current = state; act(() => listener?.(state)); } };
}

const session = (sessionId: string, title: string, mediaKind: string | null = null, kind = "resource"): ShellSession => ({
  sessionId, title, kind, targetId: `target_${sessionId}`, mediaKind, mode: "enthusiast", runCount: 0, activeRunId: null, activeRunStatus: null,
});

function frame(width: number, height: number, extra: Partial<Parameters<typeof ShellFrame>[0]> = {}) {
  return render(
    <ShellFrame
      viewport={{ width, height }}
      preference={DEFAULT_SHELL_PREFERENCE}
      page="library"
      pages={[
        { id: "library", label: "书架", testId: "nav-library" },
        { id: "settings", label: "设置", testId: "nav-settings" },
      ]}
      onPage={() => undefined}
      hasRight
      running={false}
      title="合成作品"
      modeLabel="娱乐模式"
      modeNames={{ enthusiast: "娱乐模式", creator: "工作模式" }}
      modeHints={{ enthusiast: "阅读、观看与随手记录", creator: "整理笔记与管理项目" }}
      labels={labels}
      menuItems={[{ id: "settings", label: "设置", onSelect: () => undefined }]}
      history={{ canBack: false, canForward: false, onBack: () => undefined, onForward: () => undefined }}
      onMode={() => undefined}
      onHide={() => undefined}
      onShow={() => undefined}
      onStop={() => undefined}
      right={<p>辅助</p>}
      {...extra}
    >
      <p>主面板</p>
    </ShellFrame>,
  );
}

/** jsdom has no PointerEvent, so the pointer events are mouse events with a pointer's name, which carry the position the divider reads. */
function pointer(target: Element, type: "pointerdown" | "pointermove" | "pointerup", clientX: number) {
  fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
}

beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });
afterEach(() => { cleanup(); delete (window as unknown as { manga?: unknown }).manga; });

describe("AT-81 window frame: title bar and columns", () => {
  it("gives every column its own top, with no title bar row across the window, and names no channel", async () => {
    windowHost();
    const { container } = frame(1600, 900);
    // AT-86: there is no row of its own for the title bar; the tops belong to the columns and sit inside them.
    expect(container.querySelector("header")).toBeNull();
    expect(screen.queryByTestId("shell-titlebar")).toBeNull();
    const left = screen.getByTestId("shell-left");
    const right = screen.getByTestId("shell-right");
    const main = screen.getByTestId("shell-main-column");
    expect(left.contains(screen.getByTestId("column-top-left"))).toBe(true);
    expect(main.contains(screen.getByTestId("column-top-main"))).toBe(true);
    expect(right.contains(screen.getByTestId("column-top-right"))).toBe(true);
    // The tops start the columns, so the columns' widths are the tops' widths and the dividers run through the whole height.
    expect(left.firstElementChild).toBe(screen.getByTestId("column-top-left"));
    expect(main.firstElementChild).toBe(screen.getByTestId("column-top-main"));
    expect(right.firstElementChild).toBe(screen.getByTestId("column-top-right"));
    const workspace = left.parentElement!;
    expect(workspace.contains(screen.getByTestId("shell-resize-left"))).toBe(true);
    expect(workspace.contains(screen.getByTestId("shell-resize-right"))).toBe(true);
    expect(screen.getByTestId("shell-root").firstElementChild).toBe(workspace);
    expect(screen.getByTestId("titlebar-left").getAttribute("data-docked")).toBe("true");
    expect(screen.getByTestId("titlebar-right").getAttribute("data-docked")).toBe("true");
    // The assistant's own title sits in the top of its column; the column no longer carries a heading of its own.
    expect(screen.getByTestId("titlebar-right-title").textContent).toContain("MANGA Agent");
    expect(within(right.querySelector<HTMLElement>(".shell-right-body")!).queryByText("MANGA Agent")).toBeNull();
    expect(right.contains(screen.getByTestId("titlebar-right-title"))).toBe(true);
    // The left top holds the menu, the sidebar button, back, forward and the mode switch; the title is the main top's.
    const leftTop = screen.getByTestId("titlebar-left");
    for (const id of ["shell-menu", "shell-left-toggle", "nav-back", "nav-forward", "mode-switch"]) expect(leftTop.contains(screen.getByTestId(id))).toBe(true);
    expect(screen.getByTestId("titlebar-main").contains(screen.getByTestId("shell-title"))).toBe(true);
    // The window's own buttons are at the right end of the last top: only that top has them.
    await screen.findByTestId("window-controls");
    expect(right.querySelectorAll("[data-testid='window-controls']").length).toBe(1);
    expect(main.querySelectorAll("[data-testid='window-controls']").length).toBe(0);
    expect(screen.getByTestId("column-top-right").lastElementChild).toBe(screen.getByTestId("window-controls"));
    // The build's channel is not in the tops (it is in the About dialog).
    expect(screen.getByTestId("shell-root").textContent).not.toMatch(/测试通道|开发版|正式版/);
  });

  it("puts the menu, sidebar, back, forward and the title at the start of the main top when the left column is not docked", async () => {
    // A window too narrow to dock the columns: the controls of both side columns move into the main top.
    windowHost();
    frame(800, 700);
    const main = screen.getByTestId("column-top-main");
    expect(screen.queryByTestId("shell-left")).toBeNull();
    expect(screen.queryByTestId("titlebar-right-title")).toBeNull();
    const order = Array.from(main.querySelectorAll("[data-testid='shell-menu'], [data-testid='shell-left-toggle'], [data-testid='nav-back'], [data-testid='nav-forward'], [data-testid='mode-switch'], [data-testid='shell-title'], [data-testid='shell-right-toggle']")).map((node) => node.getAttribute("data-testid"));
    expect(order).toEqual(["shell-menu", "shell-left-toggle", "nav-back", "nav-forward", "shell-title", "shell-right-toggle"]);
    // The window's buttons are at the end of the only top there is.
    await screen.findByTestId("window-controls");
    expect(main.querySelectorAll("[data-testid='window-controls']").length).toBe(1);
    expect(main.lastElementChild).toBe(screen.getByTestId("window-controls"));
    // There is no room for the mode switch, so the two modes are in the menu, the current one checked.
    expect(screen.queryByTestId("mode-switch")).toBeNull();
    fireEvent.click(screen.getByTestId("shell-menu"));
    const modes = screen.getAllByRole("menuitemradio");
    expect(modes.map((node) => (node.textContent ?? "").replace("✓", "").trim())).toEqual(["娱乐模式", "工作模式"]);
    expect(modes.map((node) => node.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("brings the page up to the window's edges in the window-fullscreen state: no columns, and a main top that floats", () => {
    const { rerender } = frame(1600, 900, { immersive: true });
    expect(screen.queryByTestId("shell-left")).toBeNull();
    expect(screen.queryByTestId("shell-resize-left")).toBeNull();
    expect(screen.getByTestId("shell-root").getAttribute("data-immersive")).toBe("true");
    const main = screen.getByTestId("shell-main-column");
    expect(main.getAttribute("data-immersive")).toBe("true");
    // The floating top and its hot zone are in the main column; the page below has nothing taken from it by them.
    expect(main.querySelector("[data-testid='immersive-hotzone']")).toBeTruthy();
    expect(main.contains(screen.getByTestId("column-top-main"))).toBe(true);
    expect(screen.getByTestId("shell-main").textContent).toContain("主面板");
    // With the window ordinary again the columns come back as they were.
    rerender(
      <ShellFrame
        viewport={{ width: 1600, height: 900 }}
        preference={DEFAULT_SHELL_PREFERENCE}
        page="library"
        pages={[{ id: "library", label: "书架", testId: "nav-library" }, { id: "settings", label: "设置", testId: "nav-settings" }]}
        onPage={() => undefined}
        hasRight
        running={false}
        title="合成作品"
        modeLabel="娱乐模式"
        modeNames={{ enthusiast: "娱乐模式", creator: "工作模式" }}
        modeHints={{ enthusiast: "阅读、观看与随手记录", creator: "整理笔记与管理项目" }}
        labels={labels}
        menuItems={[]}
        history={{ canBack: false, canForward: false, onBack: () => undefined, onForward: () => undefined }}
        onMode={() => undefined}
        onHide={() => undefined}
        onShow={() => undefined}
        onStop={() => undefined}
        right={<p>辅助</p>}
      >
        <p>主面板</p>
      </ShellFrame>,
    );
    expect(screen.getByTestId("shell-left")).toBeTruthy();
    expect(screen.getByTestId("shell-root").getAttribute("data-immersive")).toBe("false");
    expect(screen.queryByTestId("immersive-hotzone")).toBeNull();
  });

  it("walks the page history from the back and forward buttons, and disables a button with nowhere to go", () => {
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

  it("opens the title bar's menu and runs the command that is picked", () => {
    const quit = vi.fn();
    const about = vi.fn();
    frame(1280, 840, { menuItems: [
      { id: "settings", label: "设置", onSelect: () => undefined },
      { id: "about", label: "关于", onSelect: about },
      { id: "quit", label: "退出", onSelect: quit, danger: true },
    ] });
    fireEvent.click(screen.getByTestId("shell-menu"));
    const items = screen.getAllByRole("menuitem").map((node) => node.textContent);
    expect(items).toEqual(["设置", "关于", "退出"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "关于" }));
    expect(about).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("drags a divider to resize its column inside the limits, and puts the default back on a double click", () => {
    const onResize = vi.fn();
    frame(1600, 900, { onResize });
    const left = screen.getByTestId("shell-resize-left");
    expect(left.getAttribute("role")).toBe("separator");
    expect(left.getAttribute("aria-valuenow")).toBe("224");
    expect(left.getAttribute("aria-valuemin")).toBe(String(SIDE_WIDTH.left.min));
    pointer(left, "pointerdown", 224);
    pointer(left, "pointermove", 284);
    // The column follows the pointer while it is held; nothing is saved yet.
    expect(screen.getByTestId("shell-left").style.width).toBe("284px");
    expect(onResize).not.toHaveBeenCalled();
    pointer(left, "pointerup", 284);
    expect(onResize).toHaveBeenCalledWith("left", 284);
    // Far past the limit stops at the limit; far short of the least stops there.
    pointer(left, "pointerdown", 224);
    pointer(left, "pointerup", 5000);
    expect(onResize).toHaveBeenLastCalledWith("left", dragLimit("left", 1600, 360));
    pointer(left, "pointerdown", 224);
    pointer(left, "pointerup", -4000);
    expect(onResize).toHaveBeenLastCalledWith("left", SIDE_WIDTH.left.min);
    // The right column grows toward the left.
    const right = screen.getByTestId("shell-resize-right");
    pointer(right, "pointerdown", 1200);
    pointer(right, "pointerup", 1100);
    expect(onResize).toHaveBeenLastCalledWith("right", 460);
    // A double click restores each column's default.
    fireEvent.doubleClick(left);
    expect(onResize).toHaveBeenLastCalledWith("left", SIDE_WIDTH.left.initial);
    fireEvent.doubleClick(right);
    expect(onResize).toHaveBeenLastCalledWith("right", SIDE_WIDTH.right.initial);
  });

  it("moves a divider with the keyboard, so the widths do not need a pointer", () => {
    const onResize = vi.fn();
    frame(1600, 900, { onResize });
    const left = screen.getByTestId("shell-resize-left");
    expect(left.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(left, { key: "ArrowRight" });
    expect(onResize).toHaveBeenLastCalledWith("left", 240);
    fireEvent.keyDown(left, { key: "ArrowRight", shiftKey: true });
    expect(onResize).toHaveBeenLastCalledWith("left", 272);
    fireEvent.keyDown(left, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenLastCalledWith("left", SIDE_WIDTH.left.min);
    fireEvent.keyDown(left, { key: "Home" });
    expect(onResize).toHaveBeenLastCalledWith("left", SIDE_WIDTH.left.min);
    fireEvent.keyDown(left, { key: "Enter" });
    expect(onResize).toHaveBeenLastCalledWith("left", SIDE_WIDTH.left.initial);
    const right = screen.getByTestId("shell-resize-right");
    fireEvent.keyDown(right, { key: "ArrowLeft" });
    expect(onResize).toHaveBeenLastCalledWith("right", 376);
    fireEvent.keyDown(right, { key: "ArrowRight" });
    expect(onResize).toHaveBeenLastCalledWith("right", 344);
  });

  it("shows a saved width, and keeps the stored widths inside what a column can be", () => {
    const wide = structuredClone(DEFAULT_SHELL_PREFERENCE);
    wide.layouts.enthusiast.left.width = 360;
    wide.layouts.enthusiast.right.width = 520;
    frame(1700, 900, { preference: wide });
    expect(screen.getByTestId("shell-left").style.width).toBe("360px");
    expect(screen.getByTestId("shell-right").style.width).toBe("520px");
    expect(screen.getByTestId("column-top-left").parentElement).toBe(screen.getByTestId("shell-left"));
    expect(screen.getByTestId("column-top-right").parentElement).toBe(screen.getByTestId("shell-right"));
    expect(clampSide("left", 9999)).toBe(SIDE_WIDTH.left.max);
    expect(clampSide("right", 10)).toBe(SIDE_WIDTH.right.min);
    // No divider where a column is not docked.
    cleanup();
    frame(800, 700);
    expect(screen.queryByTestId("shell-resize-left")).toBeNull();
    expect(screen.queryByTestId("shell-resize-right")).toBeNull();
  });
});

describe("AT-82 window frame: the left rail", () => {
  it("has no heading over the opened list, a divider above it, and the settings button outside the scrolling list", () => {
    frame(1280, 840, {
      sessions: [session("ses_a", "合成书"), session("ses_b", "另一本", "comic")],
      sessionLabels: { empty: "还没有打开的资源", active: "进行中", close: "关闭", groups: { novel: "小说", comic: "漫画" }, position: () => "第 3 章" },
    });
    const rail = screen.getByTestId("shell-sessions");
    expect(rail.querySelector("h2")).toBeNull();
    expect(rail.textContent).not.toContain("已打开");
    const settings = screen.getByTestId("nav-settings");
    expect(rail.contains(settings)).toBe(false);
    expect(settings.closest(".shell-settings")).toBeTruthy();
  });

  it("folds a group down to its count, unfolds it again, and remembers the choice", () => {
    const rows = [session("ses_a", "合成书"), session("ses_b", "第二本"), session("ses_c", "漫画书", "comic")];
    const sessionLabels = { empty: "x", active: "进行中", close: "关闭", groups: { novel: "小说", comic: "漫画" }, position: () => "" };
    frame(1280, 840, { sessions: rows, sessionLabels });
    expect(screen.getByTestId("session-open-ses_a")).toBeTruthy();
    expect(screen.queryByTestId("session-count-novel")).toBeNull();
    fireEvent.click(screen.getByTestId("session-fold-novel"));
    expect(screen.queryByTestId("session-open-ses_a")).toBeNull();
    expect(screen.queryByTestId("session-open-ses_b")).toBeNull();
    expect(screen.getByTestId("session-count-novel").textContent).toBe("2");
    expect(screen.getByTestId("session-group-novel").getAttribute("data-collapsed")).toBe("true");
    expect(screen.getByTestId("session-fold-novel").getAttribute("aria-expanded")).toBe("false");
    // The other group is untouched.
    expect(screen.getByTestId("session-open-ses_c")).toBeTruthy();
    // The fold outlives the window being drawn again.
    cleanup();
    frame(1280, 840, { sessions: rows, sessionLabels });
    expect(screen.queryByTestId("session-open-ses_a")).toBeNull();
    expect(screen.getByTestId("session-count-novel").textContent).toBe("2");
    fireEvent.click(screen.getByTestId("session-fold-novel"));
    expect(screen.getByTestId("session-open-ses_a")).toBeTruthy();
    expect(screen.queryByTestId("session-count-novel")).toBeNull();
  });

  it("closes an entry from its own button without opening it, and keeps the others", () => {
    const onClose = vi.fn();
    const onSession = vi.fn();
    frame(1280, 840, {
      sessions: [session("ses_a", "合成书"), session("ses_b", "第二本")],
      sessionLabels: { empty: "x", active: "进行中", close: "关闭", groups: { novel: "小说" }, position: () => "" },
      onCloseSession: onClose,
      onSession,
    });
    const button = screen.getByTestId("session-close-ses_a");
    expect(button.getAttribute("aria-label")).toBe("关闭：合成书");
    fireEvent.click(button);
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_a" }));
    expect(onSession).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers 关闭 on a right click, and Escape or a click elsewhere dismisses it", () => {
    const onClose = vi.fn();
    frame(1280, 840, {
      sessions: [session("ses_a", "合成书")],
      sessionLabels: { empty: "x", active: "进行中", close: "关闭", groups: { novel: "小说" }, position: () => "" },
      onCloseSession: onClose,
    });
    fireEvent.contextMenu(screen.getByTestId("session-open-ses_a"), { clientX: 40, clientY: 200 });
    const menu = screen.getByTestId("session-menu");
    expect(menu.style.left).toBe("40px");
    expect(menu.style.top).toBe("200px");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("session-menu")).toBeNull();
    fireEvent.contextMenu(screen.getByTestId("session-open-ses_a"), { clientX: 40, clientY: 200 });
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId("session-menu")).toBeNull();
    fireEvent.contextMenu(screen.getByTestId("session-open-ses_a"), { clientX: 40, clientY: 200 });
    fireEvent.click(screen.getByTestId("session-menu-close"));
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ses_a" }));
    expect(screen.queryByTestId("session-menu")).toBeNull();
  });

  it("has no close button or menu where the host does not close entries", () => {
    frame(1280, 840, {
      sessions: [session("ses_a", "合成书")],
      sessionLabels: { empty: "x", active: "进行中", close: "关闭", groups: { novel: "小说" }, position: () => "" },
    });
    expect(screen.queryByTestId("session-close-ses_a")).toBeNull();
    fireEvent.contextMenu(screen.getByTestId("session-open-ses_a"));
    expect(screen.queryByTestId("session-menu")).toBeNull();
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
    expect(group.closest(".column-top")!.classList.contains("shell-drag")).toBe(true);
    const css = readFileSync("apps/desktop/src/renderer/styles.css", "utf8");
    expect(css).toMatch(/\.shell-no-drag \{[^}]*app-region: no-drag/);
    expect(css).toMatch(/\.shell-drag \{[^}]*app-region: drag/);
  });

  it("takes its colors from the theme's tokens, with a red close button on hover, and has no color of its own", () => {
    const css = readFileSync("apps/desktop/src/renderer/styles.css", "utf8");
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
