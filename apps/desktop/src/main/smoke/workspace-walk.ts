import type { BrowserWindow } from "electron";
import {
  DRAWN, clickTestId, closeTabs, ensureSidebar, openFromShelf, openLibrary, openProjectsPage, pointerClick, pressChord, pressKey, railTo, showTab, sleep, tabsOf, trustedClick, viaSidebar,
  waitDrawn, waitForTestId, waitUntil, type TabFact,
} from "./driver.ts";
import { js, leaveSettings, toRail, type caller } from "./common.ts";

/**
 * The workspace in the real window (UI-01, UI-06 — UI-10, AT-110 — AT-118): where the top row, the icon rail, the sidebar, the tabbed main area and the
 * dock are at three window sizes; the four menus, item by item; tabs opened from the library and brought back; the four layouts of the split; a video moved between
 * columns without stopping; the keys going to the focused column only; the contexts (two projects and "最近") each with its own tabs and layout; the same
 * file in three contexts with three positions; and the dock following the tab in front. Each observation is named; the package stage requires every one.
 */

export const WORKSPACE_OBSERVATIONS = [
  "workspace-frame",
  "workspace-menu",
  "tabs-open-restore",
  "split-presets",
  "split-move-video",
  "split-focus-keys",
  "context-switch",
  "same-file-contexts",
  "dock-follows-focus",
] as const;

type SizeName = "wide" | "narrow" | "short";
export type Rect = { x: number; y: number; w: number; h: number; r: number; b: number };

export type WorkspaceEnv = {
  view: BrowserWindow;
  call: ReturnType<typeof caller>;
  observe: (name: string, ok: boolean, detail: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  resize: (size: SizeName) => Promise<void>;
  comicId: string | null;
  videoId: string | null;
  novelId: string | null;
  /** The titles the works carry (the readers' tabs are named after them). */
  titles: { comic: string; video: string; novel: string };
  /** A project made earlier in the walk, with a whiteboard in it. */
  projectId: string;
  boardId: string;
};

const near = (a: number, b: number, tolerance = 2) => Math.abs(a - b) <= tolerance;
const RECT_OF = `(id) => { const el = document.querySelector('[data-testid="' + id + '"]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; }`;
/** The context in front, as the dock of it says. */
const HOST = `document.querySelector('[data-testid="context-host"][data-active="true"]')`;
/** The page in front of the context in front: the contexts and tabs out of sight keep their own pages, with the same test ids. */
const FRONT = `${HOST}?.querySelector('[data-testid="tab-panel"][data-focused="true"]')`;

export async function rectsOf(view: BrowserWindow, ids: string[]): Promise<Record<string, Rect | null>> {
  return js<Record<string, Rect | null>>(view, `(() => { const rect = ${RECT_OF}; const out = {}; for (const id of ${JSON.stringify(ids)}) out[id] = rect(id); return out; })()`);
}

/** Whether a pointer at the middle of the element would reach it (or something in it): nothing draws over it. */
export async function reaches(view: BrowserWindow, ids: string[]): Promise<Record<string, boolean | null>> {
  return js<Record<string, boolean | null>>(view, `(() => {
    const out = {};
    for (const id of ${JSON.stringify(ids)}) {
      const el = document.querySelector('[data-testid="' + id + '"]');
      if (!el) { out[id] = null; continue; }
      const b = el.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) { out[id] = false; continue; }
      const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      out[id] = Boolean(hit && (hit === el || el.contains(hit)));
    }
    return out;
  })()`);
}

export type HostFacts = { key: string | null; columns: number; groups: number; single: boolean; ids: string[]; focused: string | null; rects: Rect[] };

/** The context in front: its columns as the model has them and as the dock draws them, its tabs and the focused one. */
export async function hostFacts(view: BrowserWindow): Promise<HostFacts | null> {
  return js<HostFacts | null>(view, `(() => {
    const host = ${HOST};
    if (!host) return null;
    const chips = [...host.querySelectorAll('[data-testid="tab"]')];
    const groups = [...host.querySelectorAll('.dv-groupview')].filter((group) => group.getClientRects().length > 0);
    const box = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; };
    return {
      key: host.getAttribute("data-context"),
      columns: Number(host.getAttribute("data-columns") ?? "0"),
      groups: groups.length,
      single: host.getAttribute("data-single") === "true",
      ids: chips.map((chip) => chip.getAttribute("data-tab") ?? "").sort(),
      focused: chips.find((chip) => chip.getAttribute("data-focused") === "true")?.getAttribute("data-tab") ?? null,
      rects: groups.map(box),
    };
  })()`);
}

/**
 * The context in front once its state has been read: a context's tabs arrive a moment after the switch to it, so the tabs are taken when two reads a little
 * apart agree.
 */
export async function settledHost(view: BrowserWindow): Promise<HostFacts | null> {
  const key = (facts: HostFacts | null) => JSON.stringify(facts && { key: facts.key, columns: facts.columns, ids: facts.ids, focused: facts.focused, single: facts.single });
  let facts = await hostFacts(view);
  for (let round = 0; round < 12; round += 1) {
    await sleep(300);
    const next = await hostFacts(view);
    if (key(next) === key(facts)) return next;
    facts = next;
  }
  return facts;
}

/** The context in front is this one ("" is 最近) and its dock is on screen. */
export const waitContext = (view: BrowserWindow, key: string, ms = 8000) => waitUntil(view, `${HOST}?.getAttribute("data-context") === ${JSON.stringify(key)}`, ms);

/** The tab bar of the context in front has a tab like this one, focused. */
export const focusedChip = (view: BrowserWindow) => js<{ id: string; kind: string; title: string } | null>(view, `(() => {
  const chip = ${HOST}?.querySelector('[data-testid="tab"][data-focused="true"]');
  return chip ? { id: chip.getAttribute("data-tab") ?? "", kind: chip.getAttribute("data-kind") ?? "", title: chip.querySelector(".tab-title")?.textContent ?? "" } : null;
})()`);

/** An open menu's items: test id, whether the item is off, whether it is checked. */
async function menuItemsOf(view: BrowserWindow, trigger: string): Promise<Array<{ testId: string; disabled: boolean; checked: string | null }>> {
  if (!(await clickTestId(view, trigger, 3000))) return [];
  if (!(await waitUntil(view, `document.querySelector('[role="menu"]')`, 2500))) return [];
  return js(view, `[...document.querySelectorAll('[role="menu"] [role="menuitem"], [role="menu"] [role="menuitemradio"]')].map((el) => ({ testId: el.getAttribute("data-testid") ?? "", disabled: el.disabled === true, checked: el.getAttribute("aria-checked") }))`);
}
const closeMenu = async (view: BrowserWindow) => {
  await pressKey(view, "Escape");
  await waitUntil(view, `!document.querySelector('[role="menu"]')`, 1500);
};
async function chooseMenu(view: BrowserWindow, trigger: string, item: string): Promise<boolean> {
  if (!(await clickTestId(view, trigger, 3000))) return false;
  if (!(await waitUntil(view, `document.querySelector('[data-testid="${item}"]')`, 2500))) { await closeMenu(view); return false; }
  const clicked = await clickTestId(view, item, 2000);
  await waitUntil(view, `!document.querySelector('[role="menu"]')`, 1500);
  return clicked;
}

/** All tabs closed, then the library: the walk's start for a part that wants a context with nothing in it. */
async function freshLibrary(view: BrowserWindow): Promise<boolean> {
  await leaveSettings(view);
  await closeTabs(view, "all");
  return openLibrary(view, 8000);
}

/** The tab menu of a chip, opened the way a right click opens it, and one of its items chosen. */
async function tabMenu(view: BrowserWindow, tabId: string, item: string): Promise<boolean> {
  const opened = await js<boolean>(view, `(() => {
    const chip = ${HOST}?.querySelector('[data-testid="tab"][data-tab="${tabId}"]');
    if (!chip) return false;
    const b = chip.getBoundingClientRect();
    chip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: Math.round(b.x + 20), clientY: Math.round(b.y + b.height / 2) }));
    return true;
  })()`);
  if (!opened || !(await waitUntil(view, `document.querySelector('[data-testid="tab-menu"]')`, 2500))) return false;
  if (!(await waitUntil(view, `(() => { const el = document.querySelector('[data-testid="tab-menu-${item}"]'); return el && !el.disabled; })()`, 1500))) { await pressKey(view, "Escape"); return false; }
  const clicked = await clickTestId(view, `tab-menu-${item}`, 1500);
  await waitUntil(view, `!document.querySelector('[data-testid="tab-menu"]')`, 1500);
  return clicked;
}

/** Which column (1-based, reading order) holds the tab. */
async function columnOf(view: BrowserWindow, tabId: string): Promise<number> {
  return js<number>(view, `(() => {
    const host = ${HOST};
    const groups = [...host.querySelectorAll('.dv-groupview')].filter((group) => group.getClientRects().length > 0);
    const placed = groups.map((group) => ({ group, box: group.getBoundingClientRect() })).sort((a, b) => (Math.abs(a.box.y - b.box.y) < 4 ? a.box.x - b.box.x : a.box.y - b.box.y));
    const at = placed.findIndex((entry) => entry.group.querySelector('[data-testid="tab"][data-tab="${tabId}"]'));
    return at + 1;
  })()`);
}

const READERS = `[data-testid="tab"][data-kind="reader"]`;
/** The icons of the rail that are always in it, in a window of any of the three sizes: the home and the views of the kinds of things (the rest wait behind "…" in a short window). */
const RAIL_ICONS = ["nav-home", "nav-conversation", "nav-novel", "nav-comic", "nav-video", "nav-note"];

/** Opens one work's reader from its shelf and card, keeping the readers already open, and answers the tab it opened in. */
async function openReader(env: WorkspaceEnv, kind: "comic" | "video" | "novel", resourceId: string | null): Promise<{ id: string; title: string } | null> {
  const { view } = env;
  if (!resourceId) return null;
  if (!(await openFromShelf(view, kind, resourceId, 10_000, ["library"]))) return null;
  const root = kind === "comic" ? "comic-reader" : kind === "video" ? "video-reader" : "reading-page";
  const front = await waitUntil(view, `(() => { const chip = ${HOST}?.querySelector('${READERS}[data-focused="true"]'); const panel = document.querySelector('[data-testid="tab-panel"][data-focused="true"] [data-testid="${root}"]'); return chip && panel && ${DRAWN}(panel); })()`, 25_000);
  if (!front) return null;
  return focusedChip(view);
}

// -------------------------------------------------------------------------------------------------------------------- 1. the frame

async function walkFrame(env: WorkspaceEnv): Promise<void> {
  const { view, observe, shot, resize } = env;
  const problems: string[] = [];
  const sizes: Record<string, unknown> = {};
  await freshLibrary(view);
  for (const size of ["wide", "narrow", "short"] as const) {
    await resize(size);
    await openLibrary(view, 6000);
    await sleep(250);
    const ids = ["shell-top", "shell-rail", "shell-sidebar", "shell-main", "shell-dock", "shell-resize-sidebar", "shell-resize-dock", "shell-sidebar-toggle", "shell-dock-toggle", "nav-back", "nav-forward", "menubar", "menu-file", "menu-edit", "menu-view", "menu-help", ...RAIL_ICONS, "nav-settings", "window-controls", "window-close"];
    const got = await rectsOf(view, ids);
    const hit = await reaches(view, [...RAIL_ICONS, "nav-settings", "shell-sidebar-toggle", "nav-back", "nav-forward", "menu-file", "menu-edit", "menu-view", "menu-help", "window-minimize", "window-maximize", "window-close", "shell-main"]);
    const facts = await js<{ w: number; h: number; docOverflow: number; topOverflow: number; gone: string[]; sidebar: string | null; dock: string | null; dockDrawn: boolean; sidebarDrawn: boolean; chipReach: boolean | null; tops: number }>(view, `(() => {
      const gone = ["mode-switch", "shell-title", "shell-left", "shell-right", "column-top-main", "column-top-left", "column-top-right", "nav-agent", "nav-library", "nav-projects", "nav-search", "nav-records"].filter((id) => document.querySelector('[data-testid="' + id + '"]'));
      const top = document.querySelector('[data-testid="shell-top"]');
      const chip = ${HOST}?.querySelector('[data-testid="tab"]');
      let chipReach = null;
      if (chip) { const b = chip.getBoundingClientRect(); const at = document.elementFromPoint(b.x + Math.min(30, b.width / 2), b.y + b.height / 2); chipReach = Boolean(at && (at === chip || chip.contains(at))); }
      const drawn = ${DRAWN};
      return {
        w: window.innerWidth, h: window.innerHeight, docOverflow: document.documentElement.scrollWidth - window.innerWidth, topOverflow: top ? top.scrollWidth - top.clientWidth : 0, gone,
        sidebar: document.querySelector('[data-testid="shell-sidebar"]')?.getAttribute("data-shell-state") ?? null,
        dock: document.querySelector('[data-testid="shell-dock"]')?.getAttribute("data-shell-state") ?? null,
        sidebarDrawn: drawn(document.querySelector('[data-testid="shell-sidebar"]')), dockDrawn: drawn(document.querySelector('[data-testid="shell-dock"]')), chipReach,
        tops: document.querySelectorAll('[data-testid="shell-top"]').length,
      };
    })()`);
    const here: string[] = [];
    const g = got as Record<string, Rect>;
    if (facts.gone.length) here.push(`parts of the old frame are still there: ${facts.gone.join(", ")}`);
    if (facts.tops !== 1) here.push(`${facts.tops} top rows`);
    // Below 640 px the menus are left to the keys and the tab strip's own buttons, and below 480 forward is too (the stylesheet says so).
    const menusShown = facts.w >= 640, forwardShown = facts.w >= 480;
    const shownIds = (list: string[]) => list.filter((id) => (menusShown || !id.startsWith("menu")) && (forwardShown || id !== "nav-forward"));
    for (const id of shownIds(["shell-top", "shell-rail", "shell-main", "shell-sidebar-toggle", "nav-back", "nav-forward", "menubar", "menu-file", "menu-edit", "menu-view", "menu-help", ...RAIL_ICONS, "nav-settings", "window-controls"])) if (!got[id]) here.push(`${id} is missing`);
    if (!menusShown && got["menu-file"] && got["menu-file"]!.w > 0) here.push("the menus are on screen in a window narrower than 640 px");
    if (here.length === 0) {
      const top = g["shell-top"]!, rail = g["shell-rail"]!, main = g["shell-main"]!;
      if (!near(top.y, 0, 1) || !near(top.h, 36, 2) || !near(top.w, facts.w, 1)) here.push(`the top row is ${Math.round(top.w)}x${Math.round(top.h)} at ${Math.round(top.y)}, not one 36 px row across the window`);
      if (!near(rail.x, 0, 1) || !near(rail.w, 48, 1) || !near(rail.y, top.b, 1.5) || rail.b < facts.h - 2) here.push(`the icon rail is ${Math.round(rail.w)} wide at ${Math.round(rail.x)}, from ${Math.round(rail.y)} to ${Math.round(rail.b)}`);
      if (g["window-controls"]!.r < facts.w - 1.5 || !near(g["window-controls"]!.y, 0, 1)) here.push("the window's own buttons are not in the top right corner");
      // The top row's own buttons are all inside the window and in order, and the row does not overflow.
      const order = shownIds(["shell-sidebar-toggle", "nav-back", "nav-forward", "menu-file", "menu-edit", "menu-view", "menu-help"]).map((id) => g[id]!.x);
      if (order.some((x, index) => index > 0 && x <= order[index - 1]!)) here.push("the top row's buttons are out of order");
      for (const id of shownIds(["shell-sidebar-toggle", "nav-back", "nav-forward", "menu-help", "shell-dock-toggle"])) if (got[id] && got[id]!.w > 0 && (got[id]!.r > facts.w + 1 || got[id]!.x < -1 || got[id]!.r > (g["window-controls"]!.x + 1))) here.push(`${id} is under the window's own buttons or outside the window`);
      if (facts.topOverflow > 1) here.push(`the top row overflows by ${facts.topOverflow}px`);
      if (facts.docOverflow > 1) here.push(`the window scrolls sideways by ${facts.docOverflow}px`);
      if (main.b < facts.h - 2 || !near(main.y, top.b, 1.5)) here.push("the main area does not run from the top row to the window's bottom");
      if (got["nav-settings"] && got["nav-settings"]!.b > facts.h + 1) here.push("the rail's settings button is outside the window");
      for (const [id, reached] of Object.entries(hit)) if (reached === false && shownIds([id]).length > 0) here.push(`something is drawn over ${id}`);
      if (facts.chipReach === false) here.push("a tab's title is covered");
      if (size === "wide") {
        const sidebar = g["shell-sidebar"], dock = g["shell-dock"];
        if (facts.sidebar !== "dock" || !sidebar || !facts.sidebarDrawn) here.push("the sidebar is not docked in the wide window");
        else {
          if (!near(sidebar.x, rail.r, 1.5) || sidebar.w < 200 || sidebar.w > 400.5) here.push(`the sidebar is ${Math.round(sidebar.w)}px at ${Math.round(sidebar.x)}`);
          if (!near(main.x, sidebar.r + 1, 2)) here.push(`the main area starts at ${Math.round(main.x)}, not beside the sidebar's divider (${Math.round(sidebar.r)})`);
        }
        if (facts.dock !== "dock" || !dock || !facts.dockDrawn) here.push("the dock is not docked in the wide window");
        else {
          if (!near(dock.r, facts.w, 1.5) || dock.w < 320 || dock.w > 640.5) here.push(`the dock is ${Math.round(dock.w)}px wide, ending at ${Math.round(dock.r)}`);
          if (!near(main.r, dock.x - 1, 2)) here.push(`the main area ends at ${Math.round(main.r)}, not at the dock's divider (${Math.round(dock.x)})`);
        }
        for (const divider of ["shell-resize-sidebar", "shell-resize-dock"]) {
          const d = got[divider];
          if (!d || !near(d.y, top.b, 1.5) || d.h < facts.h - top.b - 2) here.push(`${divider} does not run from the top row to the bottom`);
        }
      } else if (size === "narrow") {
        if (facts.sidebarDrawn || facts.dockDrawn) here.push("a narrow window keeps a docked column");
        if (!near(main.x, rail.r, 1.5) || !near(main.r, facts.w, 1.5)) here.push(`the main area is ${Math.round(main.x)}..${Math.round(main.r)} of ${facts.w}`);
      } else {
        // A short, 1100 px window: the sidebar keeps its place and the dock folds into an overlay.
        if (facts.sidebar !== "dock" || !facts.sidebarDrawn) here.push("the sidebar is not docked in the short window");
        if (facts.dockDrawn && facts.dock === "dock") here.push("the dock stayed docked where the main area would be squeezed");
      }
    }
    // A folded column opens from its button over the main area, stays in the window and goes away with Esc.
    const folded: Array<"sidebar" | "dock"> = [];
    if (size !== "wide" && !facts.sidebarDrawn) folded.push("sidebar");
    if (size !== "wide" && !facts.dockDrawn) folded.push("dock");
    for (const side of folded) {
      if (!(await clickTestId(view, `shell-${side}-toggle`, 2000))) { here.push(`the ${side} has no button to open it from`); continue; }
      const opened = await waitUntil(view, `(() => { const el = document.querySelector('[data-testid="shell-${side}"]'); return el && el.getAttribute("data-shell-state") === "overlay" && ${DRAWN}(el); })()`, 2500);
      const box = (await rectsOf(view, [`shell-${side}`]))[`shell-${side}`];
      if (!opened || !box) here.push(`the ${side} did not open as an overlay from its button`);
      else if (box.x < -1 || box.r > facts.w + 1 || box.b > facts.h + 1) here.push(`the ${side} overlay is outside the window`);
      await shot(`workspace-${side}-overlay-${size}`);
      await pressKey(view, "Escape");
      const closed = await waitUntil(view, `!${DRAWN}(document.querySelector('[data-testid="shell-${side}"]'))`, 2500);
      if (!closed) here.push(`Esc did not close the ${side} overlay`);
    }
    sizes[size] = { problems: here, rects: { top: g["shell-top"], rail: g["shell-rail"], sidebar: got["shell-sidebar"], main: g["shell-main"], dock: got["shell-dock"] }, state: { sidebar: facts.sidebar, dock: facts.dock } };
    problems.push(...here.map((text) => `${size}: ${text}`));
    await shot(`workspace-frame-${size}`);
  }
  await resize("wide");
  observe("workspace-frame", problems.length === 0, { problems, sizes });
}

// ---------------------------------------------------------------------------------------------------------------------- 2. the menus

async function walkMenus(env: WorkspaceEnv): Promise<void> {
  const { view, observe, shot } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  await freshLibrary(view);
  const wanted: Record<string, string[]> = {
    file: ["new-project", "new-conversation", "new-tab", "reopen-tab", "close-tab", "import-package", "export-package", "scan", "quit"],
    edit: ["undo", "redo", "cut", "copy", "paste", "select-all", "find"],
    view: ["layout-single", "layout-two", "layout-three", "layout-quad", "sidebar", "dock", "window-fullscreen", "screen-fullscreen", "debug"],
    help: ["shortcuts", "logs", "about"],
  };
  const items: Record<string, Array<{ testId: string; disabled: boolean; checked: string | null }>> = {};
  for (const [menu, list] of Object.entries(wanted)) {
    items[menu] = await menuItemsOf(view, `menu-${menu}`);
    const have = items[menu]!.map((item) => item.testId);
    const missing = list.filter((id) => !have.includes(`menu-${menu}-${id}`));
    if (missing.length) problems.push(`the ${menu} menu lacks ${missing.join(", ")}`);
    if (have.length !== list.length) problems.push(`the ${menu} menu has ${have.length} items, not ${list.length}`);
    if (menu === "view" && itemOf(items.view!, "menu-view-layout-single")?.checked !== "true") problems.push("the layout in use is not checked in the view menu");
    // Whether "reopen" is on depends on what was closed before this walk; it is checked below, by closing a tab and reopening it.
    if (menu === "file" && !itemOf(items.file!, "menu-file-reopen-tab")) problems.push("the file menu has no reopen item");
    if (menu === "view" && itemOf(items.view!, "menu-view-window-fullscreen")?.disabled !== true) problems.push("window full screen is on where no reader is in front");
    await shot(`workspace-menu-${menu}`);
    await closeMenu(view);
  }
  detail.items = Object.fromEntries(Object.entries(items).map(([menu, list]) => [menu, list.map((item) => `${item.testId.replace(`menu-${menu}-`, "")}${item.disabled ? "(off)" : ""}`)]));

  // File: a new tab, close it, reopen it, a new conversation, a new project's dialog, the scan.
  const count = async () => (await tabsOf(view)).length;
  const start = await count();
  const newTab = await chooseMenu(view, "menu-file", "menu-file-new-tab");
  const afterNew = await waitUntil(view, `${HOST}.querySelectorAll('[data-testid="tab"]').length === ${start + 1}`, 4000);
  if (!newTab || !afterNew) problems.push("File > New tab did not add a tab");
  const closed = await chooseMenu(view, "menu-file", "menu-file-close-tab");
  if (!closed || !(await waitUntil(view, `${HOST}.querySelectorAll('[data-testid="tab"]').length === ${start}`, 4000))) problems.push("File > Close tab did not close the tab in front");
  const reopened = await chooseMenu(view, "menu-file", "menu-file-reopen-tab");
  if (!reopened || !(await waitUntil(view, `${HOST}.querySelectorAll('[data-testid="tab"]').length === ${start + 1}`, 4000))) problems.push("File > Reopen tab did not bring the closed tab back");
  // The same three from the keyboard.
  await pressChord(view, "T", ["control"]);
  const keyNew = await waitUntil(view, `${HOST}.querySelectorAll('[data-testid="tab"]').length === ${start + 2}`, 3000);
  await pressChord(view, "W", ["control"]);
  const keyClose = await waitUntil(view, `${HOST}.querySelectorAll('[data-testid="tab"]').length === ${start + 1}`, 3000);
  await pressChord(view, "T", ["control", "shift"]);
  const keyReopen = await waitUntil(view, `${HOST}.querySelectorAll('[data-testid="tab"]').length === ${start + 2}`, 3000);
  detail.keys = { keyNew, keyClose, keyReopen };
  if (!keyNew || !keyClose || !keyReopen) problems.push(`the tab keys do not do what the menu does (new ${keyNew}, close ${keyClose}, reopen ${keyReopen})`);
  await closeTabs(view, "all");
  await openLibrary(view, 6000);

  const conversation = await chooseMenu(view, "menu-file", "menu-file-new-conversation");
  const conversationTab = conversation && await waitUntil(view, `${HOST}.querySelector('[data-testid="tab"][data-kind="conversation"]')`, 5000);
  detail.newConversation = conversationTab;
  if (!conversationTab) problems.push("File > New conversation opened no conversation");
  await closeTabs(view, ["conversation"]);

  const project = await chooseMenu(view, "menu-file", "menu-file-new-project");
  const dialog = project && await waitUntil(view, `document.querySelector('[data-testid="project-name"]')`, 3000);
  if (!dialog) problems.push("File > New project opened no dialog");
  else await pressKey(view, "Escape");
  await waitUntil(view, `!document.querySelector('[data-testid="project-name"]')`, 2000);

  const scan = await chooseMenu(view, "menu-file", "menu-file-scan");
  await sleep(500);
  const scanErr = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="toast-error"]'))`);
  detail.scan = { scan, error: scanErr };
  if (!scan || scanErr) problems.push("File > Scan the library failed");
  await waitUntil(view, `!document.querySelector('[data-testid="scan-indicator"]')`, 20_000);

  // Edit: find brings up the search box over the window, not a tab; the rest are clicked in the page (nothing is selected, so nothing changes).
  for (const id of ["undo", "redo", "cut", "copy", "select-all"]) if (!(await chooseMenu(view, "menu-edit", `menu-edit-${id}`))) problems.push(`Edit > ${id} cannot be chosen`);
  const found = await chooseMenu(view, "menu-edit", "menu-edit-find");
  if (!found || !(await waitDrawn(view, "search-input", 4000))) problems.push("Edit > Find brought up no search box");
  if (await js<boolean>(view, `Boolean(${HOST}.querySelector('[data-testid="tab"][data-kind="search"]'))`)) problems.push("Edit > Find opened a search tab");
  await pressKey(view, "Escape");
  if (!(await waitUntil(view, `!document.querySelector('[data-testid="search-box"]')`, 3000))) problems.push("Esc did not close the search box");

  // View: the four layouts, the sidebar and the dock, the debug panel.
  for (const [layout, columns] of [["two", 2], ["three", 3], ["quad", 4], ["single", 1]] as const) {
    const ok = await chooseMenu(view, "menu-view", `menu-view-layout-${layout}`);
    const done = ok && await waitUntil(view, `${HOST}.getAttribute("data-columns") === "${columns}"`, 4000);
    if (!done) problems.push(`View > ${layout} did not make ${columns} column(s)`);
  }
  const sidebarWas = await js<boolean>(view, `${DRAWN}(document.querySelector('[data-testid="shell-sidebar"]'))`);
  const toggled = await chooseMenu(view, "menu-view", "menu-view-sidebar") && await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="shell-sidebar"]')) === ${!sidebarWas}`, 3000);
  const restoredSide = await chooseMenu(view, "menu-view", "menu-view-sidebar") && await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="shell-sidebar"]')) === ${sidebarWas}`, 3000);
  if (!toggled || !restoredSide) problems.push("View > Sidebar does not fold and bring back the sidebar");
  const dockWas = await js<boolean>(view, `${DRAWN}(document.querySelector('[data-testid="shell-dock"]'))`);
  const dockToggled = await chooseMenu(view, "menu-view", "menu-view-dock") && await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="shell-dock"]')) === ${!dockWas}`, 3000);
  const dockBack = await chooseMenu(view, "menu-view", "menu-view-dock") && await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="shell-dock"]')) === ${dockWas}`, 3000);
  if (!dockToggled || !dockBack) problems.push("View > Dock does not fold and bring back the dock");
  const debugOn = await chooseMenu(view, "menu-view", "menu-view-debug") && await waitUntil(view, `document.querySelector('[data-testid="debug-panel"]')`, 3000);
  const debugOff = await chooseMenu(view, "menu-view", "menu-view-debug") && await waitUntil(view, `!document.querySelector('[data-testid="debug-panel"]')`, 3000);
  if (!debugOn || !debugOff) problems.push("View > Debug does not open and close the debug panel");

  // Help: shortcuts and logs are pages of the settings view (no tab opens), about is a dialog with the version.
  const keys = await chooseMenu(view, "menu-help", "menu-help-shortcuts");
  if (!keys || !(await waitDrawn(view, "settings-page-shortcuts", 4000))) problems.push("Help > Shortcuts did not show the shortcuts page of the settings");
  const logs = await chooseMenu(view, "menu-help", "menu-help-logs");
  if (!logs || !(await waitDrawn(view, "settings-page-logs", 5000))) problems.push("Help > Logs did not show the logs page");
  if (await js<boolean>(view, `Boolean(${HOST}.querySelector('[data-testid="tab"][data-kind="keys"], [data-testid="tab"][data-kind="settings"]'))`)) problems.push("Help opened a tab for the shortcuts or the settings");
  const about = await chooseMenu(view, "menu-help", "menu-help-about");
  const aboutShown = about && await waitUntil(view, `document.querySelector('[data-testid="about-dialog"]')`, 3000);
  const version = aboutShown ? await js<string>(view, `document.querySelector('[data-testid="about-version"]')?.textContent ?? ""`) : "";
  if (!aboutShown || !version || version === "-") problems.push("Help > About shows no version");
  await clickTestId(view, "about-dialog-close");
  await waitUntil(view, `!document.querySelector('[data-testid="about-dialog"]')`, 3000);
  if (!(await leaveSettings(view))) problems.push("the settings did not close with the back arrow");
  observe("workspace-menu", problems.length === 0, { problems, ...detail });
  await closeTabs(view, "all");
}
const itemOf = <T extends { testId: string }>(list: T[], testId: string): T | undefined => list.find((item) => item.testId === testId);

// ---------------------------------------------------------------------------------------------------------- 3. tabs: open, no duplicates, close, reopen, reload

type Opened = { comic: { id: string; title: string } | null; video: { id: string; title: string } | null; novel: { id: string; title: string } | null };

async function walkTabs(env: WorkspaceEnv): Promise<Opened> {
  const { view, call, observe, shot } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  await freshLibrary(view);
  const opened: Opened = { comic: null, video: null, novel: null };
  for (const kind of ["comic", "video", "novel"] as const) {
    const id = kind === "comic" ? env.comicId : kind === "video" ? env.videoId : env.novelId;
    const tab = await openReader(env, kind, id);
    opened[kind] = tab;
    const wantTitle = env.titles[kind];
    if (!tab) problems.push(`the ${kind} did not open in a tab from the shelf`);
    else if (!tab.title || (wantTitle && !tab.title.includes(wantTitle))) problems.push(`the ${kind} tab is named "${tab.title}", not after the work "${wantTitle}"`);
  }
  const afterThree = await tabsOf(view);
  detail.afterThree = afterThree.map((tab) => `${tab.kind}:${tab.title}`);
  const readers = afterThree.filter((tab) => tab.kind === "reader");
  if (readers.length !== 3) problems.push(`${readers.length} reader tabs after three were opened`);
  if (new Set(readers.map((tab) => tab.id)).size !== readers.length) problems.push("two reader tabs share an id");

  // The same resource is not opened twice: opening the comic again brings its tab to the front.
  if (env.comicId && opened.comic) {
    const again = await openFromShelf(view, "comic", env.comicId, 10_000, ["library"]);
    const settled = again && await waitUntil(view, `${HOST}.querySelector('${READERS}[data-focused="true"]')?.getAttribute("data-tab") === ${JSON.stringify(opened.comic.id)}`, 8000);
    const after = (await tabsOf(view)).filter((tab) => tab.kind === "reader");
    detail.noDuplicate = { settled, readers: after.length };
    if (!settled || after.length !== 3) problems.push(`opening the comic again made ${after.length} reader tabs and ${settled ? "" : "did not "}brought the first one to the front`);
  }

  // Close one with its button and bring it back from the menu: same place in the strip, the reader is drawn again.
  const strip = (await tabsOf(view)).map((tab) => tab.id);
  const videoTab = opened.video;
  if (videoTab) {
    const place = strip.indexOf(videoTab.id);
    await closeById(view, videoTab.id);
    const gone = await waitUntil(view, `!${HOST}.querySelector('[data-testid="tab"][data-tab="${videoTab.id}"]')`, 4000);
    await pressChord(view, "T", ["control", "shift"]);
    const back = await waitUntil(view, `${HOST}.querySelector('${READERS}[data-focused="true"] .tab-title')?.textContent === ${JSON.stringify(videoTab.title)}`, 8000);
    const ready = back && await waitUntil(view, `(() => { const panel = document.querySelector('[data-testid="tab-panel"][data-focused="true"] [data-testid="video-reader"]'); return panel && ${DRAWN}(panel); })()`, 25_000);
    const stripAfter = (await tabsOf(view)).map((tab) => tab.title);
    const placeAfter = stripAfter.indexOf(videoTab.title);
    detail.reopen = { gone, back, ready, place, placeAfter, of: stripAfter.length };
    if (!gone) problems.push("the close button left the tab");
    if (!back || !ready) problems.push("Ctrl+Shift+T did not bring the closed video back");
    // The tab comes back with its page and its reading position, at the end of the column in front, and takes the focus there.
    else if (placeAfter !== stripAfter.length - 1) problems.push(`the reopened tab is number ${placeAfter + 1} of ${stripAfter.length} in the strip, not the last of the column in front`);
  }

  // From a view of the sidebar: the notes view's manage entry opens the records tab, once (a second press brings the same tab to the front). The settings are a view
  // over the window and not a tab: the tabs are the same while they are up and after they are left.
  const manage = await viaSidebar(view, "note", "sidebar-manage", 8000) && await waitUntil(view, `${HOST}.querySelector('[data-testid="tab"][data-kind="records"]')`, 6000);
  await viaSidebar(view, "note", "sidebar-manage", 8000);
  const recordsTabs = (await tabsOf(view)).filter((tab) => tab.kind === "records").length;
  if (!manage) problems.push("the notes view's manage entry opened no records tab");
  if (recordsTabs !== 1) problems.push(`the manage entry pressed twice made ${recordsTabs} records tabs, not one`);
  const tabsBeforeSettings = (await tabsOf(view)).map((tab) => `${tab.id}:${tab.focused}`);
  const settingsIn = await clickTestId(view, "nav-settings", 4000) && await waitDrawn(view, "settings-area", 6000);
  const tabsInSettings = await tabsOf(view);
  if (!settingsIn) problems.push("the settings view did not open over the tabs");
  if (tabsInSettings.some((tab) => tab.kind === "settings" || tab.kind === "search" || tab.kind === "keys" || tab.kind === "plugins")) problems.push("the settings, the search or the shortcuts are a tab");
  const settingsOut = await leaveSettings(view);
  const tabsAfterSettings = (await tabsOf(view)).map((tab) => `${tab.id}:${tab.focused}`);
  if (!settingsOut || JSON.stringify(tabsAfterSettings) !== JSON.stringify(tabsBeforeSettings)) problems.push("the tabs are not the same after the settings were left");
  detail.fromViews = { manage: Boolean(manage), recordsTabs, tabsInSettings: tabsInSettings.length, same: JSON.stringify(tabsAfterSettings) === JSON.stringify(tabsBeforeSettings) };
  await closeTabs(view, ["records"]);

  // A project's whiteboard, from the project's materials, in its own context.
  const board = await openBoard(env);
  detail.board = board;
  if (!board.ok) problems.push(board.reason);

  // The window reloaded: the tabs of each context come back as they were.
  await toRail(view);
  await waitUntil(view, `${HOST}?.getAttribute("data-context") === ""`, 4000);
  if ((await hostFacts(view))?.key !== "") { await clickTestId(view, "context-open-recent"); await waitContext(view, ""); }
  const before = await tabsOf(view);
  const beforeHost = await hostFacts(view);
  await sleep(900);
  await view.webContents.reload();
  await toRail(view);
  const restored = await waitUntil(view, `${HOST}.querySelectorAll('[data-testid="tab"]').length === ${before.length}`, 15_000);
  const after = await tabsOf(view);
  const afterHost = await hostFacts(view);
  detail.reload = { before: before.map((tab) => `${tab.kind}:${tab.title}`), after: after.map((tab) => `${tab.kind}:${tab.title}`), focusedBefore: beforeHost?.focused, focusedAfter: afterHost?.focused, context: afterHost?.key };
  const same = restored && after.length === before.length && after.every((tab, index) => tab.kind === before[index]!.kind && tab.title === before[index]!.title);
  if (!same) problems.push("the tabs after a reload are not the tabs before it");
  else if (beforeHost?.focused !== afterHost?.focused) problems.push("the tab in front after a reload is not the one that was in front");
  const stored = ((await call("workspace.loadContext", { contextId: null })).value as { state?: { tabs?: unknown[] } } | undefined)?.state?.tabs?.length ?? -1;
  detail.stored = stored;
  if (stored !== before.length) problems.push(`${stored} tabs are saved for 最近, ${before.length} are open`);
  await shot("workspace-tabs");
  observe("tabs-open-restore", problems.length === 0, { problems, ...detail });
  return opened;
}

async function closeById(view: BrowserWindow, tabId: string): Promise<void> {
  await js(view, `${HOST}?.querySelector('[data-testid="tab"][data-tab="${tabId}"] [data-testid="tab-close"]')?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))`);
}

/** The project's whiteboard opened from the project's materials (in the project's own context), then back to 最近. */
async function openBoard(env: WorkspaceEnv): Promise<{ ok: boolean; reason: string; title?: string }> {
  const { view, call, projectId, boardId } = env;
  if (!projectId || !boardId) return { ok: false, reason: "there was no project with a whiteboard" };
  await call("project.addMaterial", { projectId, kind: "whiteboard", targetId: boardId, label: "截图白板" });
  await view.webContents.executeJavaScript("true");
  if (!(await clickTestId(view, `context-open-${projectId}`, 5000)) || !(await waitContext(view, projectId))) return { ok: false, reason: "the project was not on the sidebar to open" };
  // The project's home may already be a tab; materials is its first sub-page.
  if (!(await waitUntil(view, `${HOST}.querySelector('[data-testid="tab"][data-kind="project"]')`, 8000))) await openProjectsPage(view);
  await clickTestId(view, "project-tab-materials");
  const listed = await waitUntil(view, `document.querySelector('[data-testid^="material-open-"]')`, 8000);
  if (!listed) return { ok: false, reason: "the project's materials did not list the whiteboard" };
  const opened = await js<boolean>(view, `(() => { const row = [...document.querySelectorAll('[data-testid^="material-"][data-kind="whiteboard"]')][0]; const button = row?.querySelector('[data-testid^="material-open-"]'); if (!button) return false; button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); return true; })()`);
  const tab = opened && await waitUntil(view, `${HOST}.querySelector('[data-testid="tab"][data-kind="whiteboard"]')`, 8000);
  const title = tab ? (await tabsOf(view)).find((item) => item.kind === "whiteboard")?.title : undefined;
  await clickTestId(view, "context-open-recent");
  await waitContext(view, "");
  if (!tab) return { ok: false, reason: "the whiteboard did not open as a tab of its own" };
  if (!title || !title.includes("白板")) return { ok: false, reason: `the whiteboard's tab is named "${title ?? ""}"`, title };
  return { ok: true, reason: "", title };
}

// -------------------------------------------------------------------------------------------------------------------------- 4. the layouts

async function walkPresets(env: WorkspaceEnv): Promise<void> {
  const { view, observe, shot, resize } = env;
  const problems: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  await resize("wide");
  await clickTestId(view, "context-open-recent");
  await waitContext(view, "");
  const baseline = await hostFacts(view);
  if (!baseline || baseline.ids.length < 4) { observe("split-presets", false, { problems: [`only ${baseline?.ids.length ?? 0} tabs to lay out`] }); return; }
  const want: Array<[string, number]> = [["two", 2], ["three", 3], ["quad", 4], ["single", 1]];
  for (const [name, columns] of want) {
    const chosen = await chooseMenu(view, "menu-view", `menu-view-layout-${name}`);
    const done = chosen && await waitUntil(view, `${HOST}.getAttribute("data-columns") === "${columns}" && [...${HOST}.querySelectorAll('.dv-groupview')].filter((group) => group.getClientRects().length > 0).length === ${columns}`, 5000);
    await sleep(300);
    const facts = await hostFacts(view);
    const row: Record<string, unknown> = { name, columns, groups: facts?.groups, tabs: facts?.ids.length };
    rows.push(row);
    if (!done || !facts) { problems.push(`${name}: the layout was not made`); continue; }
    if (facts.ids.join() !== baseline.ids.join()) problems.push(`${name}: the set of tabs changed`);
    // The columns are laid out next to each other (or two by two), none too narrow, none outside the main area.
    const xs = new Set(facts.rects.map((rect) => Math.round(rect.x / 8)));
    const ys = new Set(facts.rects.map((rect) => Math.round(rect.y / 8)));
    const expectedXs = columns === 4 ? 2 : columns;
    if (xs.size !== expectedXs || ys.size !== (columns === 4 ? 2 : 1)) problems.push(`${name}: the columns are not laid out as ${columns === 4 ? "two by two" : `${columns} in a row`} (${xs.size} x ${ys.size})`);
    if (facts.rects.some((rect) => rect.w < 300)) problems.push(`${name}: a column is narrower than 300 px`);
    // Every column shows one tab, and a tab that is shown is drawn.
    const shown = await js<number>(view, `[...${HOST}.querySelectorAll('[data-testid="tab-panel"][data-visible="true"]')].filter((panel) => panel.getClientRects().length > 0).length`);
    row.shown = shown;
    if (shown < Math.min(columns, baseline.ids.length)) problems.push(`${name}: ${shown} tabs are drawn for ${columns} columns`);
    await shot(`workspace-layout-${name}`);
  }
  // The layout button on the strip makes the same layouts.
  const viaStrip = await chooseMenu(view, "layout-menu", "layout-two") && await waitUntil(view, `${HOST}.getAttribute("data-columns") === "2"`, 4000);
  if (!viaStrip) problems.push("the layout button on the tab strip did not make two columns");
  // A window too narrow for the columns shows one of them and a way to choose; the saved layout stays.
  await resize("narrow");
  const squeezed = await waitUntil(view, `document.querySelector('[data-testid="column-switcher"]')`, 4000);
  const second = squeezed && await clickTestId(view, "column-switch-2");
  const shownSecond = second && await waitUntil(view, `document.querySelector('[data-testid="column-switch-2"]')?.getAttribute("aria-pressed") === "true"`, 3000);
  const columnsKept = (await hostFacts(view))?.columns;
  rows.push({ name: "narrow", squeezed, shownSecond, columnsKept });
  if (!squeezed || !shownSecond || columnsKept !== 2) problems.push(`a narrow window with two columns: switcher ${squeezed}, second column ${shownSecond}, layout kept ${columnsKept}`);
  await shot("workspace-layout-narrow");
  await resize("wide");
  await chooseMenu(view, "menu-view", "menu-view-layout-single");
  await waitUntil(view, `${HOST}.getAttribute("data-columns") === "1"`, 4000);
  observe("split-presets", problems.length === 0, { problems, rows });
}

// ---------------------------------------------------------------------------------------------------------------------- 5. a video moved

const VIDEO = `(() => document.querySelector('[data-testid="video-reader"] video') ?? document.querySelector('[data-testid="tab-panel"] video'))()`;

async function walkMoveVideo(env: WorkspaceEnv, opened: Opened): Promise<void> {
  const { view, observe, shot } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const video = opened.video;
  if (!video) { observe("split-move-video", false, { problems: ["there was no video tab"] }); return; }
  await chooseMenu(view, "menu-view", "menu-view-layout-two");
  await waitUntil(view, `${HOST}.getAttribute("data-columns") === "2"`, 4000);
  await showTab(view, { id: video.id });
  await waitUntil(view, `(() => { const el = ${VIDEO}; return el && el.readyState >= 2; })()`, 25_000);
  // Play it with a real click and leave it playing.
  const state = () => js<{ paused: boolean; t: number; ready: number; mark: string | null; connected: boolean; loadstart: number; emptied: number; same: boolean }>(view, `(() => {
    const el = ${VIDEO};
    if (!el) return { paused: true, t: -1, ready: 0, mark: null, connected: false, loadstart: -1, emptied: -1, same: false };
    return { paused: el.paused, t: el.currentTime, ready: el.readyState, mark: el.__walkMark ?? null, connected: el.isConnected, loadstart: el.__walkLoad ?? 0, emptied: el.__walkEmptied ?? 0, same: window.__walkVideo === el };
  })()`);
  if ((await state()).paused) { await trustedClick(view, "video-toggle"); }
  const playing = await waitUntil(view, `(() => { const el = ${VIDEO}; return el && !el.paused && el.currentTime > 0.4; })()`, 12_000);
  if (!playing) { observe("split-move-video", false, { problems: ["the video did not play"], detail: await state() }); return; }
  await js(view, `(() => { const el = ${VIDEO}; el.__walkMark = "marked"; el.__walkLoad = 0; el.__walkEmptied = 0; el.addEventListener("loadstart", () => { el.__walkLoad += 1; }); el.addEventListener("emptied", () => { el.__walkEmptied += 1; }); window.__walkVideo = el; return true; })()`);

  const check = async (label: string, before: Awaited<ReturnType<typeof state>>) => {
    await sleep(1800);
    const after = await state();
    const column = await columnOf(view, video.id);
    detail[label] = { before: before.t, after: after.t, column, paused: after.paused, loadstart: after.loadstart, emptied: after.emptied };
    if (!after.same || after.mark !== "marked" || !after.connected) problems.push(`${label}: the video element was made again`);
    if (after.loadstart !== 0 || after.emptied !== 0) problems.push(`${label}: the video was loaded again (${after.loadstart} loadstart, ${after.emptied} emptied)`);
    if (after.paused) problems.push(`${label}: the video stopped`);
    if (!(after.t >= before.t) || after.t - before.t > 8) problems.push(`${label}: the time went from ${before.t.toFixed(2)} to ${after.t.toFixed(2)}`);
    if (after.ready < 2) problems.push(`${label}: the video has nothing to show (ready state ${after.ready})`);
    return column;
  };

  // To the other column of the two.
  const startColumn = await columnOf(view, video.id);
  const target = startColumn === 1 ? 2 : 1;
  const before1 = await state();
  const moved = await tabMenu(view, video.id, `move-${target}`);
  if (!moved) problems.push("the tab menu has no item to move the tab to the other column");
  const column1 = await check("other-column", before1);
  if (moved && column1 !== target) problems.push(`the tab is in column ${column1}, not column ${target}`);
  await shot("workspace-video-moved");

  // To a column of its own (the column needs a second tab to stay behind in).
  const before2 = await state();
  const split = await tabMenu(view, video.id, "move-new");
  if (!split) problems.push("the tab menu has no item to move the tab to a new column");
  await waitUntil(view, `${HOST}.getAttribute("data-columns") === "3"`, 3000);
  const column2 = await check("new-column", before2);
  detail.columnsAfter = (await hostFacts(view))?.columns;
  if (split && (await hostFacts(view))?.columns !== 3) problems.push(`there are ${(await hostFacts(view))?.columns} columns after moving to a new column`);
  void column2;
  observe("split-move-video", problems.length === 0, { problems, ...detail });
}

// ------------------------------------------------------------------------------------------------------------------------ 6. the keys

async function walkKeys(env: WorkspaceEnv, opened: Opened): Promise<void> {
  const { view, observe, shot } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const comic = opened.comic, video = opened.video;
  if (!comic || !video) { observe("split-focus-keys", false, { problems: ["the comic and the video were not both open"] }); return; }
  await chooseMenu(view, "menu-view", "menu-view-layout-two");
  await waitUntil(view, `${HOST}.getAttribute("data-columns") === "2"`, 4000);
  // The comic in one column and the video in the other.
  const comicColumn = await columnOf(view, comic.id);
  if ((await columnOf(view, video.id)) === comicColumn) await tabMenu(view, video.id, `move-${comicColumn === 1 ? 2 : 1}`);
  await sleep(600);
  const videoColumn = await columnOf(view, video.id);
  const columnNow = await columnOf(view, comic.id);
  if (videoColumn === columnNow) { observe("split-focus-keys", false, { problems: ["the comic and the video are in one column"] }); return; }
  // What the window sees of the keys sent below, so a key that goes astray can be told from one that never came.
  await js(view, `(() => {
    window.__walkKeys = [];
    // Who called: the function names only, since the frames' own text carries the packaged app's location.
    const callers = (count) => String(new Error().stack).split("\\n").slice(2, 2 + count).map((line) => { const name = (line.trim().match(/^at (\\S+)/) || [])[1] || "?"; return name.includes("/") ? "anonymous" : name; }).join(" < ");
    window.addEventListener("keydown", (event) => {
      const at = document.activeElement;
      const entry = { key: event.key, code: event.code, ctrl: event.ctrlKey, at: at ? (at.getAttribute("data-testid") ?? at.tagName) : null, within: at?.closest?.('[data-testid="tab-panel"]')?.getAttribute("data-tab") ?? null, dialog: Boolean(document.querySelector('[role="dialog"]')), prevented: false, by: "", focus: document.hasFocus() };
      const prevent = event.preventDefault.bind(event);
      event.preventDefault = () => { entry.by = callers(3); prevent(); };
      setTimeout(() => { entry.prevented = event.defaultPrevented; }, 0);
      window.__walkKeys.push(entry);
      if (window.__walkKeys.length > 40) window.__walkKeys.shift();
    }, true);
    window.__walkMedia = [];
    for (const name of ["play", "pause"]) {
      const original = HTMLMediaElement.prototype[name];
      HTMLMediaElement.prototype[name] = function () {
        const tab = this.closest?.('[data-testid="tab-panel"]')?.getAttribute("data-tab") ?? null;
        window.__walkMedia.push({ call: name, tab, at: Math.round(performance.now()), by: callers(2) });
        if (window.__walkMedia.length > 40) window.__walkMedia.shift();
        return original.apply(this, arguments);
      };
    }
  })()`);
  // Both are in front in their columns; the video plays.
  await showTab(view, { id: video.id });
  const wasPlaying = await js<boolean>(view, `(() => { const el = ${VIDEO}; return Boolean(el) && !el.paused; })()`);
  if (!wasPlaying) await trustedClick(view, "video-toggle");
  await waitUntil(view, `(() => { const el = ${VIDEO}; return el && !el.paused; })()`, 8000);
  const comicPosition = () => js<string>(view, `document.querySelector('[data-testid="tab-panel"][data-tab="${comic.id}"] [data-testid="comic-position"]')?.textContent ?? ""`);
  const videoFacts = () => js<{ paused: boolean; t: number }>(view, `(() => { const el = document.querySelector('[data-testid="tab-panel"][data-tab="${video.id}"] video'); return { paused: el ? el.paused : true, t: el ? el.currentTime : -1 }; })()`);
  const focusedIs = (id: string) => waitUntil(view, `${HOST}.querySelector('[data-testid="tab"][data-focused="true"]')?.getAttribute("data-tab") === ${JSON.stringify(id)}`, 3000);

  // Ctrl+<n> focuses a column; Space is bound in both readers (the player's play/pause, the comic's next page): it must reach the focused one only.
  await pressChord(view, String(videoColumn), ["control"]);
  const videoFocused = await focusedIs(video.id);
  const comic0 = await comicPosition();
  const video0 = await videoFacts();
  await pressKey(view, "Space");
  const afterKey: boolean[] = [];
  for (const wait of [60, 200, 340]) { await sleep(wait); afterKey.push((await videoFacts()).paused); }
  const video1 = await videoFacts();
  const comic1 = await comicPosition();
  detail.videoFocus = { focused: videoFocused, playing: !video0.paused, afterSpace: !video1.paused, pausedAfter: afterKey, comic: [comic0, comic1] };
  if (!videoFocused) problems.push(`Ctrl+${videoColumn} did not focus the video's column`);
  if (video1.paused === video0.paused) problems.push("Space in the focused video did not play or pause it");
  if (comic1 !== comic0) problems.push(`Space in the focused video turned the comic's page (${comic0} → ${comic1})`);
  if (video1.paused) { await pressKey(view, "Space"); await sleep(400); }

  // A column answers to Ctrl+<n> with the tab it shows: the comic is brought to the front of its column first.
  await showTab(view, { id: comic.id });
  await showTab(view, { id: video.id });
  await pressChord(view, String(columnNow), ["control"]);
  const comicFocused = await focusedIs(comic.id);
  const video2 = await videoFacts();
  await pressKey(view, "Space");
  await sleep(600);
  const comic2 = await comicPosition();
  const video3 = await videoFacts();
  detail.comicFocus = { focused: comicFocused, comic: [comic1, comic2], video: [video2.paused, video3.paused] };
  if (!comicFocused) problems.push(`Ctrl+${columnNow} did not focus the comic's column`);
  if (comic2 === comic1) problems.push("Space in the focused comic did not turn its page");
  if (video3.paused !== video2.paused) problems.push("Space in the focused comic played or paused the video");

  // A click on a column's content focuses it as well.
  await js(view, `document.querySelector('[data-testid="tab-panel"][data-tab="${video.id}"]')?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, capture: true, clientX: 10, clientY: 10 }))`);
  const byClick = await focusedIs(video.id);
  detail.byClick = byClick;
  if (!byClick) problems.push("pressing in a column's content did not focus the column");

  // Window full screen of the column in focus: only that column is shown, and the layout comes back.
  await pressChord(view, String(columnNow), ["control"]);
  await focusedIs(comic.id);
  await pressKey(view, "w");
  const entered = await waitUntil(view, `document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-immersive") === "true"`, 4000);
  await sleep(600);
  const full = await js<{ single: boolean; comic: boolean; video: boolean; fills: boolean }>(view, `(() => {
    const drawn = ${DRAWN};
    const comic = document.querySelector('[data-testid="tab-panel"][data-tab="${comic.id}"]');
    const video = document.querySelector('[data-testid="tab-panel"][data-tab="${video.id}"]');
    const reader = comic?.querySelector('[data-testid="comic-reader"]');
    const b = reader ? reader.getBoundingClientRect() : null;
    return { single: ${HOST}.getAttribute("data-single") === "true", comic: drawn(comic), video: drawn(video), fills: Boolean(b) && Math.abs(b.width - window.innerWidth) <= 1.5 && Math.abs(b.height - window.innerHeight) <= 1.5 };
  })()`);
  detail.fullscreen = { entered, ...full };
  if (!entered) problems.push("W did not fill the window with the column in focus");
  if (!full.comic || full.video || !full.single) problems.push(`in window full screen the comic is ${full.comic ? "" : "not "}drawn and the video is ${full.video ? "still" : "not"} drawn`);
  if (!full.fills) problems.push("the focused column does not fill the window in window full screen");
  await shot("workspace-split-fullscreen");
  await pressKey(view, "Escape");
  const left = await waitUntil(view, `document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-immersive") === "false" && ${HOST}.getAttribute("data-single") === "false"`, 4000);
  await sleep(500);
  const back = await js<{ comic: boolean; video: boolean }>(view, `({ comic: ${DRAWN}(document.querySelector('[data-testid="tab-panel"][data-tab="${comic.id}"]')), video: ${DRAWN}(document.querySelector('[data-testid="tab-panel"][data-tab="${video.id}"]')) })`);
  detail.back = { left, ...back };
  if (!left || !back.comic || !back.video) problems.push("Esc did not bring both columns back");
  detail.keyLog = await js(view, `window.__walkKeys ?? []`);
  detail.mediaLog = await js(view, `window.__walkMedia ?? []`);
  observe("split-focus-keys", problems.length === 0, { problems, ...detail });
  // The video is left paused for what follows.
  await showTab(view, { id: video.id });
  const playingNow = await js<boolean>(view, `(() => { const el = ${VIDEO}; return Boolean(el) && !el.paused; })()`);
  if (playingNow) await pressKey(view, "Space");
}

// -------------------------------------------------------------------------------------------------------------------- 7 / 8. contexts

type Position = { page?: string; at?: number };

async function walkContexts(env: WorkspaceEnv, opened: Opened): Promise<void> {
  const { view, call, observe, shot, projectId } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  await clickTestId(view, "context-open-recent");
  await waitContext(view, "");
  // 最近 is laid out in four, with the tabs it has; a draft is left in its dock.
  await chooseMenu(view, "menu-view", "menu-view-layout-quad");
  await waitUntil(view, `${HOST}.getAttribute("data-columns") === "4"`, 5000);
  const recent = await settledHost(view);
  await showTab(view, { kind: "library" });
  await waitDrawn(view, "agent-composer", 5000);
  await js(view, `(() => { const el = document.querySelector('[data-testid="shell-dock"] [data-testid="agent-composer"]'); if (!el) return false; const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set; set?.call(el, "最近的草稿"); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  await sleep(900);
  detail.recent = { columns: recent?.columns, tabs: recent?.ids.length };

  // A second project made from the sidebar becomes the context on screen and is empty of what 最近 holds.
  const created = await viaSidebar(view, "home", "sidebar-new-project", 4000)
    && await js<boolean>(view, "true")
    && await waitUntil(view, `document.querySelector('[data-testid="project-name"]')`, 4000);
  const name2 = "走查项目乙";
  const submitted = created && await js<boolean>(view, `(() => { const el = document.querySelector('[data-testid="project-name"]'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set; set?.call(el, ${JSON.stringify(name2)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`) && await clickTestId(view, "project-create-submit");
  const projectTwo = submitted ? await waitUntil(view, `(() => { const key = ${HOST}?.getAttribute("data-context"); return Boolean(key) && key !== ${JSON.stringify(projectId)}; })()`, 10_000) : false;
  const two = (await hostFacts(view))?.key ?? "";
  detail.second = { created: Boolean(projectTwo), key: two ? "set" : "" };
  if (!projectTwo || !two) { observe("context-switch", false, { problems: ["a second project could not be made from the sidebar"], ...detail }); observe("same-file-contexts", false, { problems: ["there was no second project"] }); return; }
  const inTwo = await settledHost(view);
  if (inTwo && opened.comic && inTwo.ids.includes(opened.comic.id)) problems.push("the new project shows a tab of 最近");
  const draftInTwo = await js<string>(view, `document.querySelector('[data-testid="shell-dock"] [data-testid="agent-composer"]')?.value ?? ""`);
  if (draftInTwo.includes("最近的草稿")) problems.push("the new project's dock holds the draft of 最近");
  await chooseMenu(view, "menu-view", "menu-view-layout-two");
  await waitUntil(view, `${HOST}.getAttribute("data-columns") === "2"`, 4000);
  // A tab only this project has: the projects page (the settings are not a tab any more). And another layout of its own.
  await openProjectsPage(view);
  const twoState = await settledHost(view);
  await sleep(900);

  // The first project, its own: one column, its project tab.
  await clickTestId(view, `context-open-${projectId}`);
  await waitContext(view, projectId);
  const inOne = await settledHost(view);
  detail.projects = { two: { columns: twoState?.columns, tabs: twoState?.ids.length }, one: { columns: inOne?.columns, tabs: inOne?.ids.length } };

  // Back to 最近: four columns, the same tabs, the draft.
  await clickTestId(view, "context-open-recent");
  const home = await waitContext(view, "");
  await sleep(500);
  const recentAgain = await settledHost(view);
  const draftBack = await js<string>(view, `document.querySelector('[data-testid="shell-dock"] [data-testid="agent-composer"]')?.value ?? ""`);
  detail.recentAgain = { columns: recentAgain?.columns, tabs: recentAgain?.ids.length, draft: draftBack.includes("最近的草稿") };
  if (!home || !recentAgain || !recent || recentAgain.columns !== 4 || recentAgain.ids.join() !== recent.ids.join()) problems.push(`back in 最近 the tabs or the layout changed (${recentAgain?.columns} columns, ${recentAgain?.ids.length} tabs; before ${recent?.columns}, ${recent?.ids.length})`);
  if (!draftBack.includes("最近的草稿")) problems.push("the draft left in 最近 is gone after the other contexts");
  await clickTestId(view, `context-open-${two}`);
  await waitContext(view, two);
  const twoAgain = await settledHost(view);
  if (!twoAgain || twoAgain.columns !== 2 || twoAgain.ids.join() !== (twoState?.ids ?? []).join()) problems.push("the second project came back with other tabs or another layout");
  await clickTestId(view, `context-open-${projectId}`);
  await waitContext(view, projectId);
  const oneAgain = await settledHost(view);
  if (!oneAgain || oneAgain.columns !== inOne?.columns || oneAgain.ids.join() !== (inOne?.ids ?? []).join()) problems.push("the first project came back with other tabs or another layout");
  // From a view: a conversation listed under another project (its group opened in the conversations' view) is opened in that project, the window going to it first; the
  // tabs the first project has stay as they were.
  const made = ((await call("conversation.new", { contextId: two })).value as { sessionId?: string } | undefined)?.sessionId;
  if (!made) problems.push("a conversation could not be made in the second project");
  else {
    await railTo(view, "home");
    await railTo(view, "conversation");
    await ensureSidebar(view);
    await clickTestId(view, `context-toggle-${two}`, 4000);
    const row = await waitDrawn(view, `session-open-${made}`, 8000);
    const clicked = row && await clickTestId(view, `session-open-${made}`, 3000);
    const there = clicked && await waitContext(view, two, 8000);
    const opensTab = there && await waitUntil(view, `${HOST}.querySelector('[data-testid="tab"][data-kind="conversation"]')`, 6000);
    detail.fromView = { row, clicked: Boolean(clicked), there: Boolean(there), tab: Boolean(opensTab) };
    if (!row) problems.push("a conversation of the second project is not listed under its group in the conversations' view");
    else if (!there) problems.push("a row under another project opened without going to that project");
    else if (!opensTab) problems.push("a row under another project opened no conversation tab in that project");
    await clickTestId(view, `context-open-${projectId}`);
    await waitContext(view, projectId);
    const oneAfter = await settledHost(view);
    if (!oneAfter || oneAfter.ids.join() !== (inOne?.ids ?? []).join()) problems.push("opening a row of the second project changed the first project's tabs");
  }
  // What was saved for each is what is on screen.
  await sleep(900);
  const saved = async (id: string | null) => ((await call("workspace.loadContext", { contextId: id })).value as { state?: { preset?: string; tabs?: unknown[] } } | undefined)?.state;
  const [s0, s1, s2] = [await saved(null), await saved(projectId), await saved(two)];
  detail.saved = { recent: [s0?.preset, s0?.tabs?.length], one: [s1?.preset, s1?.tabs?.length], two: [s2?.preset, s2?.tabs?.length] };
  if (s0?.preset !== "quad" || s2?.preset !== "two") problems.push(`saved layouts are ${s0?.preset} / ${s2?.preset}, not quad / two`);
  await shot("workspace-contexts");
  observe("context-switch", problems.length === 0, { problems, ...detail });

  await walkSameFile(env, two, name2);
}

async function walkSameFile(env: WorkspaceEnv, two: string, nameTwo: string): Promise<void> {
  const { view, call, observe, shot, projectId } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const comicId = env.comicId;
  if (!comicId) { observe("same-file-contexts", false, { problems: ["there was no comic"] }); return; }
  const pages = (await call("comic.pages", { resourceId: comicId })).value as { revisionId: string; pages: Array<{ id: string }> } | undefined;
  if (!pages || pages.pages.length < 3) { observe("same-file-contexts", false, { problems: [`the comic has ${pages?.pages.length ?? 0} pages, three are needed`] }); return; }
  const revisionId = pages.revisionId;
  const projectName = String(((await call("project.get", { projectId })).value as { project?: { name?: string } } | undefined)?.project?.name ?? "");
  // A position in 最近 and another in the first project; the second project has none. The later one is the project's.
  await call("progress.setPage", { contextId: null, resourceId: comicId, resourceRevisionId: revisionId, pageId: pages.pages[1]!.id });
  await sleep(40);
  await call("progress.setPage", { contextId: projectId, resourceId: comicId, resourceRevisionId: revisionId, pageId: pages.pages[2]!.id });
  const got = async (contextId: string | null) => ((await call("progress.get", { contextId, resourceId: comicId, resourceRevisionId: revisionId })).value as { percent?: number; locator?: { pageId?: string; index?: number } | null } | undefined);
  const p0 = await got(null), p1 = await got(projectId), p2 = await got(two);
  detail.stored = { recent: p0?.percent ?? null, one: p1?.percent ?? null, two: p2?.percent ?? null };
  if (!(p0?.percent && p1?.percent && p1.percent > p0.percent)) problems.push("the two positions were not kept apart");
  if (p2?.percent) problems.push("the second project has a position it never made");

  const workTitle = env.titles.comic;
  const cardOrigin = async (contextKey: string): Promise<string> => {
    await clickTestId(view, `context-open-${contextKey || "recent"}`);
    await waitContext(view, contextKey);
    await closeTabs(view, ["library"]);
    await openLibrary(view, 6000);
    await clickTestId(view, "section-all-comic");
    await waitDrawn(view, "shelf-comic", 6000);
    await waitUntil(view, `${FRONT}?.querySelector('[data-testid="open-${comicId}"]')`, 8000);
    await sleep(200);
    // The note on this comic's card only: other works on the shelf carry notes of their own.
    return js<string>(view, `${FRONT}?.querySelector('[data-testid="open-${comicId}"]')?.closest("article")?.querySelector('[data-testid^="work-origin-"]')?.textContent ?? ""`);
  };
  const originRecent = await cardOrigin("");
  const originOne = await cardOrigin(projectId);
  const originTwo = await cardOrigin(two);
  detail.cards = { recent: originRecent, one: originOne, two: originTwo };
  if (!originRecent.includes(projectName)) problems.push(`the card in 最近 does not say its position is from "${projectName}" (${originRecent || "no note"})`);
  if (originOne !== "") problems.push(`the card in the project that has the latest position carries a note (${originOne})`);
  if (!originTwo.includes(projectName)) problems.push(`the card in the second project does not say whose position it shows (${originTwo || "no note"})`);

  // The reader of each context starts where that context was; the second one starts at the beginning and offers the other.
  const position = () => js<string>(view, `${FRONT}?.querySelector('[data-testid="comic-position"]')?.textContent ?? ""`);
  const read = async (contextKey: string) => {
    await clickTestId(view, `context-open-${contextKey || "recent"}`);
    await waitContext(view, contextKey);
    await closeTabs(view, ["library", "reader"]);
    const open = await openFromShelf(view, "comic", comicId, 10_000, ["library", "reader"]);
    const ready = open && await waitUntil(view, `${FRONT}?.querySelector('.comic-page[data-state="ready"]')`, 25_000);
    await sleep(500);
    return { ready, position: ready ? await position() : "", bar: await js<string>(view, `${FRONT}?.querySelector('[data-testid="elsewhere-text"]')?.textContent ?? ""`) };
  };
  const inRecent = await read("");
  const inOne = await read(projectId);
  const inTwo = await read(two);
  // The line names the other context whose position was the latest. Opening a reader is itself a latest interaction, so which context that is comes from the
  // data and not from the order the positions were set in.
  const choices = [
    { name: "最近", percent: Math.round((p0?.percent ?? 0) * 100), position: inRecent.position },
    { name: projectName, percent: Math.round((p1?.percent ?? 0) * 100), position: inOne.position },
  ];
  const named = choices.find((choice) => inTwo.bar.includes(`“${choice.name}”`) && inTwo.bar.includes(`${choice.percent}%`));
  detail.readers = { recent: inRecent.position, one: inOne.position, two: inTwo.position, barTwo: inTwo.bar, barRecent: inRecent.bar, barOne: inOne.bar, named: named?.name ?? null };
  if (!inRecent.ready || !inOne.ready || !inTwo.ready) problems.push("the comic did not open in every context");
  else {
    if (inRecent.position === inOne.position) problems.push(`the comic is at ${inRecent.position} in both 最近 and the first project`);
    if (inTwo.position === inRecent.position || inTwo.position === inOne.position) problems.push(`the second project did not start the comic from its own beginning (${inTwo.position})`);
    if (inOne.bar) problems.push("a context that has its own position shows the line about another context");
    if (!named) problems.push(`the second project's reader does not say where the file was seen and how far ("${inTwo.bar}"; 最近 ${choices[0]!.percent}%, ${projectName} ${choices[1]!.percent}%)`);
  }
  await shot("workspace-same-file");
  // Going there is a choice: the line's button, and the position then becomes the second project's own; the other two stay as they were.
  if (await clickTestId(view, "elsewhere-jump", 2000)) {
    await sleep(1200);
    const jumped = await position();
    detail.jumped = jumped;
    if (jumped === inTwo.position || !named || jumped !== named.position) problems.push(`jumping went to ${jumped}, not to ${named?.position ?? "the position the line named"}`);
    await sleep(900);
    const after = [await got(null), await got(projectId), await got(two)];
    if (after[0]?.percent !== p0?.percent) problems.push("jumping in the second project changed the position in 最近");
    if (after[1]?.percent !== p1?.percent) problems.push("jumping in the second project changed the position in the first project");
    if (!(after[2]?.percent && after[2].percent > 0)) problems.push("the second project has no position of its own after jumping");
  } else problems.push("the line about the other context has no button to go there");
  void nameTwo;
  await closeTabs(view, ["reader"]);
  await clickTestId(view, "context-open-recent");
  await waitContext(view, "");
  observe("same-file-contexts", problems.length === 0, { problems, ...detail, title: workTitle ? "set" : "" });
}

// ------------------------------------------------------------------------------------------------------------------ 9. the dock follows focus

async function walkDock(env: WorkspaceEnv, opened: Opened): Promise<void> {
  const { view, call, observe, shot, projectId } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const titleOfDock = () => js<string>(view, `document.querySelector('[data-testid="shell-dock"] [data-testid="conversation-title"]')?.textContent ?? ""`);
  const dockDrawn = () => js<boolean>(view, `${DRAWN}(document.querySelector('[data-testid="shell-dock"]'))`);
  await clickTestId(view, "context-open-recent");
  await waitContext(view, "");
  await closeTabs(view, "all");
  await openLibrary(view, 6000);
  await waitDrawn(view, "agent-composer", 6000);
  const libraryDock = { drawn: await dockDrawn(), title: await titleOfDock() };
  detail.library = libraryDock;
  if (!libraryDock.drawn) problems.push("the dock is not on screen with the library in front");

  // A reader: the dock shows that resource's conversation in this context, named after the tab.
  const reader = await openReader(env, "comic", env.comicId);
  await sleep(700);
  const readerDock = { drawn: await dockDrawn(), title: await titleOfDock() };
  detail.reader = { ...readerDock, tab: reader?.title };
  if (!reader || !readerDock.drawn || !readerDock.title.includes(env.titles.comic)) problems.push(`with the comic in front the dock says "${readerDock.title}"`);
  const sessions = ((await call("workspace.sessions", { contextId: null })).value as Array<{ kind: string; targetId: string | null; contextId: string | null }> | undefined) ?? [];
  const forComic = sessions.some((row) => row.kind === "resource" && row.targetId === env.comicId && row.contextId === null);
  detail.sessionForComic = forComic;
  if (!forComic) problems.push("no conversation about the comic exists in 最近 after it was in front");

  // The library again: back to the context's own conversation.
  await showTab(view, { kind: "library" });
  await sleep(500);
  // The library tab is on the work's page, where the conversation is the work's; on its overview the dock is the context's own conversation again.
  const onWork = await js<boolean>(view, `${DRAWN}(${FRONT}?.querySelector('[data-testid="page-work"]'))`);
  const back = { drawn: await dockDrawn(), title: await titleOfDock(), onWork };
  detail.libraryAgain = back;
  if (!back.drawn) problems.push("the dock is not on screen with the library in front again");
  else if (onWork && !back.title.includes(env.titles.comic)) problems.push(`with the library on the work's page the dock says "${back.title}", not the work's "${env.titles.comic}"`);
  else if (!onWork && back.title !== libraryDock.title) problems.push(`with the library in front again the dock says "${back.title}", it said "${libraryDock.title}"`);
  await openLibrary(view, 6000);
  await sleep(500);
  const overview = { drawn: await dockDrawn(), title: await titleOfDock() };
  detail.libraryOverview = overview;
  if (!overview.drawn || overview.title !== libraryDock.title) problems.push(`on the library's overview the dock says "${overview.title}", it said "${libraryDock.title}"`);

  // A conversation tab: the dock folds away (the same conversation is not shown twice), and comes back when the tab is left.
  const row = ((await call("conversation.history", { contextId: null })).value as { items?: Array<{ sessionId: string }>; conversations?: Array<{ sessionId: string }> } | undefined);
  const listed = row?.items ?? row?.conversations ?? [];
  let conv = await viaSidebar(view, "conversation", "sidebar-new-conversation", 3000) && await waitUntil(view, `${HOST}.querySelector('[data-testid="tab"][data-kind="conversation"]')`, 5000);
  if (!conv && listed[0]) conv = false;
  if (!conv) problems.push("a new conversation opened no conversation tab");
  else {
    await sleep(500);
    const hidden = !(await dockDrawn()) && !(await js<boolean>(view, `Boolean(document.querySelector('[data-testid="shell-dock-toggle"]'))`));
    detail.conversationTab = { dockHidden: hidden };
    if (!hidden) problems.push("the dock stays when a conversation tab is in front");
    await showTab(view, { kind: "library" });
    const returned = await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="shell-dock"]'))`, 4000);
    if (!returned) problems.push("the dock did not come back when the conversation tab was left");
  }

  // In a project: the project page and the whiteboard say the project's name; the project's conversation is a project one.
  await clickTestId(view, `context-open-${projectId}`);
  await waitContext(view, projectId);
  const projectName = String(((await call("project.get", { projectId })).value as { project?: { name?: string } } | undefined)?.project?.name ?? "");
  await openProjectsPage(view);
  await waitUntil(view, `${HOST}.querySelector('[data-testid="tab"][data-kind="project"]')`, 5000);
  await showTab(view, { kind: "project" });
  await sleep(700);
  const projectDock = { drawn: await dockDrawn(), title: await titleOfDock() };
  detail.project = projectDock;
  if (!projectDock.drawn || !projectDock.title.includes(projectName)) problems.push(`with the project page in front the dock says "${projectDock.title}", not "${projectName}"`);
  const projectSessions = ((await call("workspace.sessions", { contextId: projectId })).value as Array<{ kind: string; contextId: string | null }> | undefined) ?? [];
  if (!projectSessions.some((entry) => entry.kind === "project" && entry.contextId === projectId)) problems.push("the project has no conversation of the project kind");
  // The whiteboard's tab is behind the project page: none of its parts may be drawn through the page (the dock hides a tab by `visibility`, which a part can set back).
  const behind = await js<{ hiddenTabs: number; boardCards: number; drawn: number }>(view, `(() => {
    const hidden = [...document.querySelectorAll('.dv-render-overlay')].filter((overlay) => getComputedStyle(overlay).visibility === "hidden");
    const drawn = hidden.reduce((count, overlay) => count + [...overlay.querySelectorAll('*')].filter((el) => getComputedStyle(el).visibility !== "hidden" && el.getClientRects().length > 0).length, 0);
    const boardCards = hidden.reduce((count, overlay) => count + overlay.querySelectorAll('.react-flow__node').length, 0);
    return { hiddenTabs: hidden.length, boardCards, drawn };
  })()`);
  detail.behind = behind;
  if (behind.hiddenTabs === 0) problems.push("no tab was out of sight behind the project page");
  // The cards are the parts that set `visibility` back; without them behind the page the count above proves nothing.
  if (behind.boardCards === 0) problems.push("the whiteboard's cards are not among the tabs out of sight");
  if (behind.drawn > 0) problems.push(`${behind.drawn} parts of tabs that are out of sight are drawn through the page in front`);
  // The dock follows the tabs, and the tabs are not the settings or the search: the dock's tab strip has neither kind. The settings view takes the window and the dock
  // folds away, its conversation kept; leaving the settings brings it back, saying the same.
  const titleBefore = await titleOfDock();
  const kinds = new Set((await tabsOf(view)).map((tab) => tab.kind));
  if (kinds.has("settings") || kinds.has("search") || kinds.has("keys") || kinds.has("plugins")) problems.push("a settings, search, shortcuts or plug-ins tab is among the tabs the dock follows");
  const settingsUp = await clickTestId(view, "nav-settings", 4000) && await waitDrawn(view, "settings-area", 6000);
  await sleep(300);
  const dockInSettings = await dockDrawn();
  detail.settings = { up: settingsUp, dockDrawn: dockInSettings };
  if (!settingsUp) problems.push("the settings view did not open");
  if (dockInSettings) problems.push("the dock stays on screen while the settings view is up");
  const settingsLeft = await leaveSettings(view);
  const dockBack = await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="shell-dock"]'))`, 4000);
  const titleAfter = dockBack ? await titleOfDock() : "";
  detail.settings = { ...(detail.settings as object), left: settingsLeft, dockBack, same: titleAfter === titleBefore };
  if (!settingsLeft || !dockBack) problems.push("the dock did not come back when the settings were left");
  else if (titleAfter !== titleBefore) problems.push(`the dock says "${titleAfter}" after the settings, it said "${titleBefore}"`);
  await shot("workspace-dock");
  await clickTestId(view, "context-open-recent");
  await waitContext(view, "");
  void opened;
  observe("dock-follows-focus", problems.length === 0, { problems, ...detail });
}

// ------------------------------------------------------------------------------------------------------------------------------ the walk

export async function runWorkspaceWalk(env: WorkspaceEnv): Promise<void> {
  const { view, resize } = env;
  await resize("wide");
  // Projects made from outside the window are on the sidebar after the window reads them again.
  await view.webContents.reload();
  await toRail(view);
  await closeTabs(view, "all");
  await walkFrame(env);
  await walkMenus(env);
  const opened = await walkTabs(env);
  await walkPresets(env);
  await walkMoveVideo(env, opened);
  await walkKeys(env, opened);
  await walkContexts(env, opened);
  await walkDock(env, opened);
  await resize("wide");
  await forgetTabs(view);
}

/** The walk leaves the window with a library tab and nothing else, in 最近 and one column. */
async function forgetTabs(view: BrowserWindow): Promise<void> {
  await chooseMenu(view, "menu-view", "menu-view-layout-single");
  await closeTabs(view, "all");
  await waitForTestId(view, "nav-home");
}

export type { TabFact };
