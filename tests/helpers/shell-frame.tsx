import { vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { DEFAULT_SHELL_PREFERENCE } from "@manga/contracts";
import type { RailView } from "@manga/contracts";
import { ShellFrame, type ShellRail, type SidebarContent } from "../../apps/desktop/src/renderer/shell.tsx";

/** The window frame on its own: the labels, a rail and a stand-in for each column, drawn at a given window size. */

export const labels = {
  exitImmersive: "退出窗口全屏", showSidebar: "显示侧栏", hideSidebar: "隐藏侧栏", showDock: "显示对话栏", hideDock: "隐藏对话栏", stop: "停止任务",
  rail: "图标栏", sidebar: "侧栏", dock: "对话栏", resizeSidebar: "调整侧栏宽度", resizeDock: "调整对话栏宽度",
  window: { group: "窗口控制", minimize: "最小化", maximize: "最大化", restore: "还原", close: "关闭窗口" },
};

/** The names the rail gives its views, as the product words them. */
export const VIEW_NAMES: Record<RailView, string> = {
  home: "主页", conversation: "对话", novel: "小说", comic: "漫画", video: "动漫", note: "笔记", whiteboard: "白板", mindmap: "导图", draft: "文稿", roughcut: "粗剪", downloads: "下载",
};

export const railLabels = { more: "更多功能", moreEmpty: "没有收起的功能", hide: "从图标栏隐藏", pin: "固定到图标栏", pinOf: (name: string) => `把“${name}”固定到图标栏`, settings: "设置", moveUp: "上移", moveDown: "下移", moved: (name: string, n: number) => `${name}已移到第 ${n} 位` };

/** The rail of a window: the views it lists (the home, then the kinds), the ones taken out, the view the sidebar is on, and what its buttons do. */
export function shellRail(extra: Partial<ShellRail> & { views?: RailView[] } = {}): ShellRail {
  const { views = ["home", "conversation", "novel", "comic", "video", "note", "whiteboard"], ...rest } = extra;
  return {
    entries: views.map((view) => ({ view, label: VIEW_NAMES[view] })),
    hidden: [],
    current: "home",
    settings: { active: false, onSelect: () => undefined },
    labels: railLabels,
    onSelect: () => undefined,
    onHide: () => undefined,
    onPin: () => undefined,
    ...rest,
  };
}

/** What stands in the sidebar's place: a marker that says which view it was asked for and how it is shown, and the way a card is told something opened. */
export const sidebarSlot: SidebarContent = (view, options) => (
  <div data-testid="sidebar-slot" data-view={view} data-variant={options.variant}>
    侧栏
    <button type="button" data-testid="slot-opened" onClick={() => options.onDone?.()}>打开</button>
  </div>
);

export function frameProps(width: number, height: number, extra: Partial<Parameters<typeof ShellFrame>[0]> = {}): Parameters<typeof ShellFrame>[0] {
  return {
    viewport: { width, height },
    preference: DEFAULT_SHELL_PREFERENCE,
    hasDock: true,
    immersive: false,
    onExitImmersive: () => undefined,
    running: false,
    labels,
    settings: false,
    rail: shellRail(),
    onHide: () => undefined,
    onShow: () => undefined,
    onResize: () => undefined,
    onStop: () => undefined,
    sidebar: sidebarSlot,
    dock: <p data-testid="dock-slot">对话</p>,
    children: <p data-testid="main-slot">主面板</p>,
    ...extra,
  };
}

export function frame(width: number, height: number, extra: Partial<Parameters<typeof ShellFrame>[0]> = {}) {
  return render(<ShellFrame {...frameProps(width, height, extra)} />);
}

/** jsdom has no PointerEvent, so the pointer events are mouse events with a pointer's name, which carry the position the divider reads. */
export function pointer(target: Element, type: "pointerdown" | "pointermove" | "pointerup", clientX: number) {
  fireEvent(target, new MouseEvent(type, { bubbles: true, cancelable: true, clientX }));
}

export type WindowState = { controls: boolean; maximized: boolean };

/** The main process as the page sees it: what the window's state is, the three actions it can ask, and the pushes that follow. */
export function windowHost(initial: WindowState = { controls: true, maximized: false }) {
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
