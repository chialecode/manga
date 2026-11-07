import type { BrowserWindow } from "electron";
import { DRAWN, clickTestId, closeTabs, ensureSidebar, openFromShelf, openLibrary, pressChord, pressKey, railTo, sleep, trustedClick, waitDrawn, waitUntil } from "./driver.ts";
import { js, leaveSettings, openSettingsPage, toRail, type caller } from "./common.ts";

/**
 * The window frame in the real window (AT-81, AT-82, AT-86, AT-110, AT-119): the window's own buttons, the regions of the frame (the top row and the icon rail in
 * the frame color, the sidebar in its own color between the frame's and the page's, the main area and the dock on the page color, one-pixel dividers), the tab's history
 * and the keys for it, dragging a divider with the real mouse, the rail that never scrolls and the sidebar that scrolls on its own beside a fixed settings button, the
 * room kept for a scrollbar (in the settings view), the top row inside the window at three sizes, and window full screen. Where the frame is placed is `workspace-frame`'s (workspace-walk.ts). Each observation is named; the package stage requires every one of them.
 */

export const FRAME_OBSERVATIONS = [
  "frame-window-controls",
  "frame-flat-chrome",
  "frame-history-menu",
  "frame-resize",
  "frame-rail",
  "frame-scrollbar-stable",
  "frame-fits-wide",
  "frame-fits-narrow",
  "frame-fits-short",
  "frame-window-fullscreen",
] as const;

type SizeName = "wide" | "narrow" | "short";
type Rect = { x: number; y: number; w: number; h: number; r: number; b: number };
type Point = { x: number; y: number };

export type FrameEnv = {
  view: BrowserWindow;
  call: ReturnType<typeof caller>;
  observe: (name: string, ok: boolean, detail: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  resize: (size: SizeName) => Promise<void>;
  /** A comic the window can open from its shelf. */
  comicId: string | null;
  /** A project the walk may park conversations in for a while. */
  projectId: string;
};

const near = (a: number, b: number, tolerance = 1.5) => Math.abs(a - b) <= tolerance;
const RECT = `(id) => { const el = document.querySelector('[data-testid="' + id + '"]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; }`;
const HOST = `document.querySelector('[data-testid="context-host"][data-active="true"]')`;

export async function runFrameWalk(env: FrameEnv): Promise<void> {
  const { view, call, observe, shot, resize } = env;
  const rects = async (ids: string[]) => js<Record<string, Rect | null>>(view, `(() => { const rect = ${RECT}; const out = {}; for (const id of ${JSON.stringify(ids)}) out[id] = rect(id); return out; })()`);
  const center = async (testId: string): Promise<Point | null> => {
    const got = (await rects([testId]))[testId];
    return got ? { x: got.x + got.w / 2, y: got.y + got.h / 2 } : null;
  };
  /** Real input, as the pointer sends it: trusted events with the pointer's own capture, hover and double click. */
  const mouse = async (type: "mouseMove" | "mouseDown" | "mouseUp", at: Point, options: { button?: "left" | "right"; clickCount?: number; held?: boolean } = {}) => {
    view.webContents.sendInputEvent({
      type, x: Math.round(at.x), y: Math.round(at.y), button: options.button ?? "left", clickCount: options.clickCount ?? 1,
      ...(options.held ? { modifiers: ["leftButtonDown" as const] } : {}),
    } as never);
    await sleep(45);
  };
  const widthOf = (testId: string) => js<number | null>(view, `(() => { const el = document.querySelector('[data-testid="${testId}"]'); return el ? el.getBoundingClientRect().width : null; })()`);
  /** The width once the page has taken the last input: it renders after the event that moved it, so the first sample can still be one step behind. */
  const settledWidth = async (testId: string) => {
    let last = await widthOf(testId);
    for (let still = 0, waited = 0; still < 3 && waited < 2000; waited += 60) {
      await sleep(60);
      const now = await widthOf(testId);
      still = now === last ? still + 1 : 0;
      last = now;
    }
    return last;
  };
  /**
   * A drag with the real mouse. The synthetic pointer is only as reliable as the window's focus: a press that the window did not take (another window
   * took the focus the moment before) moves nothing, so the drag is made once more when the column did not move at all. A column that moved but not far
   * enough is the product's fault and is reported as it is.
   */
  const drag = async (divider: string, column: string, dx: number): Promise<{ during: number | null }> => {
    const start = await widthOf(column);
    let during: number | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const at = await center(divider);
      if (!at) return { during: null };
      await mouse("mouseMove", at);
      await mouse("mouseDown", at);
      for (const step of [dx * 0.25, dx * 0.6, dx]) await mouse("mouseMove", { x: at.x + step, y: at.y }, { held: true });
      during = await settledWidth(column);
      await mouse("mouseUp", { x: at.x + dx, y: at.y });
      await sleep(350);
      if (start === null || during === null || Math.abs(during - start) > 0.5) break;
    }
    return { during };
  };
  const doubleClick = async (testId: string) => {
    const at = await center(testId);
    if (!at) return;
    await mouse("mouseMove", at);
    await mouse("mouseDown", at, { clickCount: 1 });
    await mouse("mouseUp", at, { clickCount: 1 });
    await mouse("mouseDown", at, { clickCount: 2 });
    await mouse("mouseUp", at, { clickCount: 2 });
    await sleep(350);
  };
  const shellSaved = async () => {
    const got = (await call("settings.getShell", {})).value as { version: number; sidebar: { visible: boolean; width: number }; dock: { visible: boolean; width: number } };
    return got;
  };
  const waitFor = (expression: string, ms = 6000) => waitUntil(view, expression, ms);
  const library = async () => {
    await leaveSettings(view);
    await closeTabs(view, "all");
    await openLibrary(view);
    await sleep(250);
  };

  await resize("wide");
  await toRail(view);
  await library();

  // ---- 1. the window's own buttons, drawn by the page (AT-105) --------------------------------------------------------------------------------------
  // Their place, size and drag exclusion are measured; the three are clicked with real input (maximize and restore, then minimize and restore from the
  // main process). Closing is left to the unit tests of the command: the walk needs its window. Snap layouts, Win+Z, dragging by the top and the system's
  // animations are the platform's own and are looked at by hand.
  const viewportW = await js<number>(view, "window.innerWidth");
  const controlsProblems: string[] = [];
  const controlsDetail: Record<string, unknown> = {};
  const parts = await rects(["window-controls", "window-minimize", "window-maximize", "window-close"]);
  const shellMode = await js<string | null>(view, `document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-window-controls") ?? null`);
  controlsDetail.mode = shellMode;
  if (shellMode !== "page") controlsProblems.push(`the window's buttons are drawn by ${shellMode === "system" ? "the system" : "nobody"}, not by the page`);
  else if (!parts["window-controls"] || !parts["window-minimize"] || !parts["window-maximize"] || !parts["window-close"]) controlsProblems.push("a window button is missing");
  else {
    const group = parts["window-controls"]!;
    const buttons = [parts["window-minimize"]!, parts["window-maximize"]!, parts["window-close"]!];
    controlsDetail.geometry = { group, buttons: buttons.map((b) => [Math.round(b.w), Math.round(b.h)]) };
    if (!near(group.r, viewportW, 1) || !near(group.y, 0, 1)) controlsProblems.push("the buttons are not in the window's top right corner");
    if (!near(group.h, 36, 2)) controlsProblems.push(`the buttons are ${Math.round(group.h)}px high, not as high as the top row`);
    if (buttons.some((b) => !near(b.w, 46, 1) || !near(b.h, group.h, 1))) controlsProblems.push("a button is not 46 px wide and as high as the group");
    if (!(buttons[0]!.r <= buttons[1]!.x + 1 && buttons[1]!.r <= buttons[2]!.x + 1)) controlsProblems.push("the buttons are not in the order minimize, maximize, close");
    if (!near(buttons[2]!.r, viewportW, 1)) controlsProblems.push("the close button is not at the window's right edge");
    // None of them is in a drag area; the top around them is, and a pointer over each of them reaches that button.
    const regions = await js<{ group: string; around: string; reach: boolean[] }>(view, `(() => {
      const region = (el) => (el ? getComputedStyle(el).getPropertyValue("-webkit-app-region") || getComputedStyle(el).getPropertyValue("app-region") : "none");
      const ids = ["window-minimize", "window-maximize", "window-close"];
      return {
        group: region(document.querySelector('[data-testid="window-controls"]')),
        around: region(document.querySelector('[data-testid="shell-top"]')),
        reach: ids.map((id) => { const el = document.querySelector('[data-testid="' + id + '"]'); if (!el) return false; const b = el.getBoundingClientRect(); const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return Boolean(hit && (hit === el || el.contains(hit))); }),
      };
    })()`);
    controlsDetail.regions = regions;
    if (regions.group.trim() !== "no-drag") controlsProblems.push(`the buttons' group is "${regions.group.trim()}", not no-drag`);
    if (regions.around.trim() !== "drag") controlsProblems.push(`the top row around the buttons is "${regions.around.trim()}", not a drag area`);
    if (regions.reach.some((reached) => !reached)) controlsProblems.push("a pointer over a button does not reach it");
    // The row's own buttons are not part of the drag area either.
    const noDrag = await js<string[]>(view, `["shell-sidebar-toggle", "nav-back", "menu-file", "shell-dock-toggle"].filter((id) => { const el = document.querySelector('[data-testid="' + id + '"]'); return el && getComputedStyle(el).getPropertyValue("-webkit-app-region").trim() !== "no-drag"; })`);
    if (noDrag.length) controlsProblems.push(`${noDrag.join(", ")} would drag the window instead of being pressed`);
    // Hover paints a button; the close button turns the danger color.
    const paint = async (testId: string) => js<string>(view, `getComputedStyle(document.querySelector('[data-testid="${testId}"]')).backgroundColor`);
    const rest = { minimize: await paint("window-minimize"), close: await paint("window-close") };
    const overMinimize = await center("window-minimize");
    const overClose = await center("window-close");
    if (overMinimize) { await mouse("mouseMove", overMinimize); await sleep(250); }
    const hoverMinimize = await paint("window-minimize");
    if (overClose) { await mouse("mouseMove", overClose); await sleep(250); }
    const hoverClose = await paint("window-close");
    const danger = await js<string>(view, `(() => { const probe = document.createElement("i"); probe.style.color = getComputedStyle(document.documentElement).getPropertyValue("--color-danger"); document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; })()`);
    await mouse("mouseMove", { x: Math.round(viewportW / 2), y: 300 });
    controlsDetail.paint = { rest, hoverMinimize, hoverClose, danger };
    if (hoverMinimize === rest.minimize) controlsProblems.push("hovering a button does not paint it");
    if (hoverClose !== danger) controlsProblems.push(`the close button is ${hoverClose} when hovered, not the danger color ${danger}`);
    // Maximize and restore with a real click; the middle glyph follows the window's state.
    const wasMaximized = view.isMaximized();
    const label = () => js<string>(view, `document.querySelector('[data-testid="window-maximize"]')?.getAttribute("aria-label") ?? ""`);
    const labelBefore = await label();
    const clickedMaximize = await trustedClick(view, "window-maximize");
    const maximized = clickedMaximize && await waitFor(`document.querySelector('[data-testid="window-controls"]')?.getAttribute("data-maximized") === "${!wasMaximized}"`, 4000);
    const labelAfter = await label();
    const windowSays = view.isMaximized();
    const clickedRestore = await trustedClick(view, "window-maximize");
    const restored = clickedRestore && await waitFor(`document.querySelector('[data-testid="window-controls"]')?.getAttribute("data-maximized") === "${wasMaximized}"`, 4000);
    await sleep(500);
    controlsDetail.maximize = { wasMaximized, labelBefore, labelAfter, maximized, windowSays, restored, after: view.isMaximized() };
    if (!maximized || windowSays === wasMaximized) controlsProblems.push("the middle button did not change the window's state");
    if (labelAfter === labelBefore) controlsProblems.push("the middle button's name does not follow the window's state");
    if (!restored || view.isMaximized() !== wasMaximized) controlsProblems.push("the middle button did not put the window back");
    await resize("wide");
    // Minimize with a real click, then bring the window back from the main process.
    const clickedMinimize = await trustedClick(view, "window-minimize");
    await sleep(600);
    const minimized = view.isMinimized();
    view.restore();
    await sleep(600);
    controlsDetail.minimize = { clicked: clickedMinimize, minimized, back: !view.isMinimized() };
    if (!clickedMinimize || !minimized) controlsProblems.push("the minimize button did not minimize the window");
    if (view.isMinimized()) controlsProblems.push("the window did not come back from the minimized state");
    await resize("wide");
    await shot("frame-window-controls");
  }
  observe("frame-window-controls", controlsProblems.length === 0, { problems: controlsProblems, ...controlsDetail });

  // ---- 2. the regions: the frame color around the page, one-pixel dividers, nothing that casts a shadow --------------------------------------------------
  const flat = await js<Record<string, any>>(view, `(() => {
    const rect = ${RECT};
    const style = (id) => { const el = document.querySelector('[data-testid="' + id + '"]'); if (!el) return null; const s = getComputedStyle(el); return { background: s.backgroundColor, border: ["Top", "Right", "Bottom", "Left"].map((k) => parseFloat(s["border" + k + "Width"])), radius: ["TopLeft", "TopRight", "BottomLeft", "BottomRight"].map((k) => parseFloat(s["border" + k + "Radius"])), shadow: s.boxShadow, padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft] }; };
    const hex = getComputedStyle(document.documentElement).getPropertyValue("--color-frame").trim();
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
    const frame = m ? "rgb(" + parseInt(m[1], 16) + ", " + parseInt(m[2], 16) + ", " + parseInt(m[3], 16) + ")" : hex;
    const rgbOf = (name) => { let v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); if (/^#[0-9a-f]{3}$/i.test(v)) v = "#" + [...v.slice(1)].map((ch) => ch + ch).join(""); const c = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(v); return c ? "rgb(" + parseInt(c[1], 16) + ", " + parseInt(c[2], 16) + ", " + parseInt(c[3], 16) + ")" : v; };
    const sidebarColor = rgbOf("--color-sidebar"), surface = rgbOf("--color-surface");
    const sidebar = rect("shell-sidebar"), main = rect("shell-main"), dock = rect("shell-dock");
    return {
      frame, sidebarColor, surface, headers: document.querySelectorAll("header.shell-top").length, top: style("shell-top"), rail: style("shell-rail"), sidebar: style("shell-sidebar"), main: style("shell-main"), dock: style("shell-dock"), root: style("shell-root"),
      dividerSidebar: rect("shell-resize-sidebar"), dividerDock: rect("shell-resize-dock"), gapSidebar: sidebar && main ? main.x - sidebar.r : null, gapDock: dock && main ? dock.x - main.r : null,
    };
  })()`);
  const flatProblems: string[] = [];
  if (flat.headers !== 1) flatProblems.push(`${flat.headers} header rows across the window, not one`);
  for (const key of ["top", "rail", "sidebar"] as const) {
    const s = flat[key];
    if (!s) { flatProblems.push(`${key} is missing`); continue; }
    // The sidebar has a color of its own, between the frame's and the page's (A-99); the rest of the frame is the frame's.
    const wanted = key === "sidebar" ? flat.sidebarColor : flat.frame;
    if (s.background !== wanted) flatProblems.push(`${key} is ${s.background}, not ${key === "sidebar" ? "the sidebar color" : "the frame color"} ${wanted}`);
    if (s.border.some((w: number) => w > 0)) flatProblems.push(`${key} has a border`);
    if (s.shadow !== "none") flatProblems.push(`${key} has a shadow`);
  }
  for (const key of ["main", "dock"] as const) {
    const s = flat[key];
    if (!s) { flatProblems.push(`${key} is missing`); continue; }
    if (s.shadow !== "none") flatProblems.push(`${key} has a shadow`);
    if (!(s.border[3] > 0)) flatProblems.push(`${key} has no line on its left`);
    if (s.radius[1] > 0 || s.radius[2] > 0 || s.radius[3] > 0) flatProblems.push(`${key} has rounded corners other than the top left`);
  }
  if (flat.sidebar && (flat.sidebar.background === flat.frame || flat.sidebar.background === flat.surface)) flatProblems.push("the sidebar is drawn in the frame's color or the page's, not in between");
  if (flat.main && flat.main.background !== flat.surface) flatProblems.push(`the main area is ${flat.main.background}, not the page color ${flat.surface}`);
  if (flat.main && flat.main.radius[0] !== 10) flatProblems.push(`the main area's top left corner is ${flat.main.radius[0]}px, not 10`);
  if (!flat.root || flat.root.padding.some((p: string) => p !== "0px")) flatProblems.push("the window keeps a margin around the regions");
  for (const key of ["dividerSidebar", "dividerDock"] as const) {
    const d = flat[key] as Rect | null;
    if (!d || !near(d.w, 1, 0.5) || d.h < 200) flatProblems.push(`${key} is not a one-pixel line the height of the body`);
  }
  if (flat.gapSidebar === null || flat.gapSidebar > 1.5 || flat.gapDock === null || flat.gapDock > 1.5) flatProblems.push(`the regions are not next to each other (${flat.gapSidebar}, ${flat.gapDock})`);
  observe("frame-flat-chrome", flatProblems.length === 0, { problems: flatProblems, flat });
  await shot("frame-wide");

  // ---- 3. the tab's history: back, forward, their keys, and the About box ------------------------------------------------------------------------------
  await library();
  const pageIs = (testId: string) => waitDrawn(view, testId, 5000);
  const history: Record<string, unknown> = {};
  const navState = () => js<{ back: boolean; forward: boolean }>(view, `({ back: !document.querySelector('[data-testid="nav-back"]')?.disabled, forward: !document.querySelector('[data-testid="nav-forward"]')?.disabled })`);
  history.atStart = await navState();
  await clickTestId(view, "section-all-comic");
  history.comicShelf = await pageIs("shelf-comic");
  history.atEnd = await navState();
  await clickTestId(view, "nav-back");
  history.afterBack = await pageIs("page-library") && !(await js<boolean>(view, `${DRAWN}(document.querySelector('[data-testid="shelf-comic"]'))`));
  history.afterBackState = await navState();
  await clickTestId(view, "nav-forward");
  history.afterForward = await pageIs("shelf-comic");
  await pressChord(view, "Left", ["alt"]);
  history.keyBack = await waitFor(`!${DRAWN}(document.querySelector('[data-testid="shelf-comic"]')) && ${DRAWN}(document.querySelector('[data-testid="page-library"]'))`, 4000);
  await pressChord(view, "Right", ["alt"]);
  history.keyForward = await pageIs("shelf-comic");
  const historyProblems: string[] = [];
  const atStart = history.atStart as { back: boolean; forward: boolean };
  const atEnd = history.atEnd as { back: boolean; forward: boolean };
  if (atStart.back || atStart.forward) historyProblems.push("a tab that has not been anywhere can go back or forward");
  if (!history.comicShelf || !atEnd.back || atEnd.forward) historyProblems.push("back should be possible and forward not, at the newest page of the tab");
  if (!history.afterBack) historyProblems.push("back did not return to the library's overview");
  if (!(history.afterBackState as { forward: boolean }).forward) historyProblems.push("forward is not possible after going back");
  if (!history.afterForward) historyProblems.push("forward did not return to the comic shelf");
  if (!history.keyBack || !history.keyForward) historyProblems.push(`Alt+← / Alt+→ do not walk the tab's history (${history.keyBack}, ${history.keyForward})`);
  // The About box is reached from the help menu and says which version this is.
  await clickTestId(view, "menu-help");
  await waitFor(`document.querySelector('[role="menu"]')`, 2000);
  await clickTestId(view, "menu-help-about");
  const about = await waitFor(`document.querySelector('[data-testid="about-dialog"]')`, 3000);
  const aboutVersion = about ? await js<string>(view, `document.querySelector('[data-testid="about-version"]')?.textContent ?? ""`) : "";
  await clickTestId(view, "about-dialog-close");
  await waitFor(`!document.querySelector('[data-testid="about-dialog"]')`, 3000);
  if (!about || !aboutVersion || aboutVersion === "-") historyProblems.push("the About dialog does not show a version");
  observe("frame-history-menu", historyProblems.length === 0, { problems: historyProblems, history, aboutVersion });

  // ---- 4. dragging the dividers with the real mouse, remembered, put back on a double click -----------------------------------------------------------
  await library();
  // A wide window, so both columns can be dragged a good way before the page's own room stops them.
  view.setContentSize(1600, 900);
  await sleep(450);
  await waitDrawn(view, "agent-composer", 6000);
  const resizeProblems: string[] = [];
  const first = await shellSaved();
  const sidebarBase = first.sidebar.width;
  const dockBase = first.dock.width;
  const movedSidebar = await drag("shell-resize-sidebar", "shell-sidebar", 60);
  const afterSidebar = await shellSaved();
  const sidebarShown = await widthOf("shell-sidebar");
  if (!movedSidebar.during || !near(movedSidebar.during, sidebarBase + 60, 3)) resizeProblems.push(`the sidebar followed the pointer to ${movedSidebar.during} (wanted ${sidebarBase + 60})`);
  if (!near(afterSidebar.sidebar.width, sidebarBase + 60, 3)) resizeProblems.push(`the saved sidebar width is ${afterSidebar.sidebar.width}`);
  if (sidebarShown === null || !near(sidebarShown, sidebarBase + 60, 3)) resizeProblems.push(`the sidebar is ${sidebarShown === null ? "gone" : `${Math.round(sidebarShown)}px`} after the drag`);
  if (afterSidebar.dock.width !== first.dock.width) resizeProblems.push("the dock's width changed with the sidebar's");
  const movedDock = await drag("shell-resize-dock", "shell-dock", -80);
  const afterDock = await shellSaved();
  if (!movedDock.during || !near(movedDock.during, dockBase + 80, 3) || !near(afterDock.dock.width, dockBase + 80, 3)) resizeProblems.push(`the dock did not grow to ${dockBase + 80} (${movedDock.during}, saved ${afterDock.dock.width})`);
  // Dragged as far as it goes, a column stops where the main area keeps its room.
  await drag("shell-resize-sidebar", "shell-sidebar", 3000);
  const limits = await js<{ sidebar: number; main: number }>(view, `({ sidebar: document.querySelector('[data-testid="shell-sidebar"]').getBoundingClientRect().width, main: document.querySelector('[data-testid="shell-main"]').getBoundingClientRect().width })`);
  if (limits.sidebar > 400.5 || limits.main < 560) resizeProblems.push(`the sidebar went to ${Math.round(limits.sidebar)} and left the main area ${Math.round(limits.main)}px`);
  await shot("frame-resized-wide");
  // The keys move a divider as well: Home is the narrowest, Enter the default.
  const divider = await js<boolean>(view, `(() => { const el = document.querySelector('[data-testid="shell-resize-sidebar"]'); if (!el) return false; el.focus(); return document.activeElement === el; })()`);
  await pressKey(view, "Home");
  const homeWidth = await settledWidth("shell-sidebar");
  if (!divider || homeWidth === null || !near(homeWidth, 200, 2)) resizeProblems.push(`Home on the divider made the sidebar ${homeWidth === null ? "?" : Math.round(homeWidth)}px, not 200`);
  // A narrow window folds the columns away; the saved width is still there when the window is wide again.
  const savedSidebar = (await shellSaved()).sidebar.width;
  await resize("narrow");
  const narrowState = await js<{ sidebar: string | null; divider: boolean; main: number; viewport: number }>(view, `({ sidebar: document.querySelector('[data-testid="shell-sidebar"]')?.getAttribute("data-shell-state") ?? null, divider: Boolean(document.querySelector('[data-testid="shell-resize-sidebar"]')), main: document.querySelector('[data-testid="shell-main"]').getBoundingClientRect().width, viewport: window.innerWidth })`);
  if (narrowState.sidebar === "dock" || narrowState.divider || narrowState.main < narrowState.viewport - 49) resizeProblems.push(`a narrow window keeps a docked column (${JSON.stringify(narrowState)})`);
  view.setContentSize(1600, 900);
  await sleep(450);
  const back = await settledWidth("shell-sidebar");
  if (back === null || !near(back, savedSidebar, 3)) resizeProblems.push(`the sidebar came back ${back === null ? "?" : Math.round(back)}px wide, not ${savedSidebar}`);
  await doubleClick("shell-resize-sidebar");
  await doubleClick("shell-resize-dock");
  const restored = await shellSaved();
  if (restored.sidebar.width !== 260 || restored.dock.width !== 360) resizeProblems.push(`a double click restored ${restored.sidebar.width} and ${restored.dock.width}, not 260 and 360`);
  observe("frame-resize", resizeProblems.length === 0, { problems: resizeProblems, sidebarBase, dockBase, saved: afterSidebar.sidebar.width, savedDock: afterDock.dock.width, narrowState, restored: { sidebar: restored.sidebar.width, dock: restored.dock.width } });

  // ---- 5. the rail and the sidebar: the settings button fixed under the icons, the rail never scrolling, the sidebar scrolling on its own, "more" under five ----
  // Conversations enough to make the sidebar longer than a short window. A new conversation reuses the current one while it has said nothing, so each is
  // parked in the project at once, which empties 最近, and all of them are moved back together.
  const parked: string[] = [];
  for (let n = 0; n < 24; n += 1) {
    const created = ((await call("conversation.new", { contextId: null })).value as { sessionId?: string } | undefined)?.sessionId;
    if (!created) break;
    parked.push(created);
    await call("conversation.move", { sessionId: created, contextId: env.projectId });
  }
  for (const sessionId of parked) await call("conversation.move", { sessionId, contextId: null });
  await view.webContents.reload();
  await toRail(view);
  await library();
  await resize("short");
  // The conversations' view lists them as one kind of thing, with "more" under the first five of each group.
  await railTo(view, "conversation");
  await ensureSidebar(view);
  await waitDrawn(view, "sidebar-more-recent", 8000);
  const railFacts = () => js<Record<string, any>>(view, `(() => {
    const rect = ${RECT};
    const scroll = document.querySelector('[data-testid="shell-sidebar"] .sidebar-scroll');
    const rail = document.querySelector('[data-testid="shell-rail"]');
    return {
      settings: rect("nav-settings"), library: rect("nav-home"), rail: rect("shell-rail"), heading: Boolean(rail?.querySelector("h1, h2, h3")),
      buttons: rail ? [...rail.querySelectorAll("button")].map((el) => el.getAttribute("data-testid")) : [],
      scroll: scroll ? { scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight, top: scroll.scrollTop } : null,
      railScroll: rail ? { scrollHeight: rail.scrollHeight, clientHeight: rail.clientHeight } : null, viewportH: window.innerHeight,
      rows: document.querySelectorAll('[data-testid="sidebar-recent"] [data-testid^="session-open-"]').length,
    };
  })()`);
  const railBefore = await railFacts();
  const railProblems: string[] = [];
  if (railBefore.heading) railProblems.push("the rail has a heading");
  // The rail is the home, the views of the kinds of things, "…" where they do not fit this short window, and the settings; it has no entry for the search or for the records.
  const wantedButtons = ["nav-home", "nav-conversation", "nav-novel", "nav-comic", "nav-video", "nav-note", "rail-more", "nav-settings"];
  for (const id of wantedButtons) if (!railBefore.buttons.includes(id)) railProblems.push(`the rail has no ${id}`);
  if (railBefore.buttons.some((id: string) => /^nav-(library|projects|search|records)$/.test(String(id)))) railProblems.push("the rail still has an entry of the old kind (library, projects, search or records)");
  if (!railBefore.settings || railBefore.settings.b > railBefore.viewportH + 1) railProblems.push("the settings button is not on screen in the short window");
  if (railBefore.settings && railBefore.rail && !near(railBefore.settings.b, railBefore.rail.b, 12)) railProblems.push("the settings button is not at the foot of the rail");
  if (railBefore.railScroll && railBefore.railScroll.scrollHeight > railBefore.railScroll.clientHeight + 1) railProblems.push("the rail scrolls");
  if (railBefore.rows !== 5) railProblems.push(`${railBefore.rows} conversations are listed under 最近 before "more", not 5`);
  // "More" shows the rest of the list: the sidebar is then longer than the short window and scrolls on its own, the icons and the settings button staying where they are.
  const more = await clickTestId(view, "sidebar-more-recent");
  await sleep(250);
  const expanded = await railFacts();
  if (!more || expanded.rows <= railBefore.rows) railProblems.push(`"more" did not list more conversations (${railBefore.rows} → ${expanded.rows})`);
  const longer = Boolean(expanded.scroll && expanded.scroll.scrollHeight > expanded.scroll.clientHeight + 1);
  if (!longer) railProblems.push("the sidebar does not scroll in the short window with its conversations");
  await js(view, `(() => { const el = document.querySelector('[data-testid="shell-sidebar"] .sidebar-scroll'); if (el) el.scrollTop = el.scrollHeight; })()`);
  await sleep(200);
  const railScrolled = await railFacts();
  if (railScrolled.scroll && !(railScrolled.scroll.top > 0)) railProblems.push("the sidebar did not scroll");
  if (railBefore.settings && railScrolled.settings && (!near(railBefore.settings.y, railScrolled.settings.y, 0.5) || !near(railBefore.settings.b, railScrolled.settings.b, 0.5))) railProblems.push("the settings button moved when the sidebar scrolled");
  if (railBefore.library && railScrolled.library && !near(railBefore.library.y, railScrolled.library.y, 0.5)) railProblems.push("the rail's icons moved when the sidebar scrolled");
  // The list only grows ("more" has no "less"): asking again lists no fewer, and the icons and the settings button stay where they were.
  await clickTestId(view, "sidebar-more-recent", 1500);
  await sleep(200);
  const folded = await railFacts();
  if (folded.rows < expanded.rows) railProblems.push(`"more" asked again left ${folded.rows} conversations listed, fewer than ${expanded.rows}`);
  if (railBefore.settings && folded.settings && (!near(railBefore.settings.y, folded.settings.y, 0.5) || !near(railBefore.settings.b, folded.settings.b, 0.5))) railProblems.push("the settings button moved when the list grew again");
  observe("frame-rail", railProblems.length === 0, { problems: railProblems, buttons: railBefore.buttons, rows: [railBefore.rows, expanded.rows, folded.rows], scrolls: longer });
  await shot("frame-rail-short");

  // ---- 6. a scrollbar's room is kept whether or not the page scrolls ------------------------------------------------------------------------------------
  await resize("wide");
  await library();
  // The scroller is the one the page scrolls in: a page that scrolls inside itself (the settings page, a shelf) or else the tab's panel.
  const gutterOf = () => js<{ gutter: number; overflowing: boolean; style: string; thin: string; track: string; docOverflow: number; content: number; scroller: string }>(view, `(() => {
    const panel = document.querySelector('[data-testid="settings-pane"]') ?? document.querySelector('[data-testid="tab-panel"][data-focused="true"]');
    const candidates = [...panel.querySelectorAll("*")].filter((el) => {
      const overflow = getComputedStyle(el).overflowY;
      return (overflow === "auto" || overflow === "scroll") && el.clientWidth >= panel.clientWidth * 0.4 && el.clientHeight >= 100;
    });
    // The innermost one: the page's own scroller, not the boundary around it that only catches a page which has none.
    const inner = candidates.filter((el) => !candidates.some((other) => other !== el && el.contains(other))).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    const scroller = inner[0] ?? panel;
    const s = getComputedStyle(scroller);
    return { gutter: scroller.offsetWidth - scroller.clientWidth, overflowing: scroller.scrollHeight > scroller.clientHeight + 1, style: s.scrollbarGutter, thin: s.scrollbarWidth, track: s.scrollbarColor, docOverflow: document.documentElement.scrollWidth - window.innerWidth, content: scroller.clientWidth, scroller: scroller === panel ? "panel" : String(scroller.className).split(" ")[0] };
  })()`);
  // A page that does not scroll (the first of these settings pages that fits the wide window) and one that does (the general page in the short window).
  let shortPage = await gutterOf();
  for (const candidate of ["shortcuts", "usage", "appearance", "logs"]) {
    if (!(await openSettingsPage(view, candidate))) continue;
    await sleep(350);
    shortPage = await gutterOf();
    if (!shortPage.overflowing) break;
  }
  await resize("short");
  await openSettingsPage(view, "general");
  await sleep(400);
  const longPage = await gutterOf();
  const gutterProblems: string[] = [];
  if (shortPage.overflowing) gutterProblems.push("every settings page scrolls in the wide window, so there is nothing to compare with");
  if (!longPage.overflowing) gutterProblems.push("the settings page does not scroll in the short window");
  if (shortPage.gutter <= 0 || !near(shortPage.gutter, longPage.gutter, 0.5)) gutterProblems.push(`the room kept for the scrollbar changes: ${shortPage.gutter}px without it, ${longPage.gutter}px with it`);
  if (longPage.gutter > 14) gutterProblems.push(`the scrollbar takes ${longPage.gutter}px`);
  if (!/stable/.test(longPage.style)) gutterProblems.push(`scrollbar-gutter is ${longPage.style}`);
  if (longPage.thin !== "thin") gutterProblems.push(`scrollbar-width is ${longPage.thin}`);
  if (!/rgba\(0, 0, 0, 0\)|transparent/.test(longPage.track)) gutterProblems.push(`the scrollbar's track is not transparent (${longPage.track})`);
  if (longPage.docOverflow > 1 || shortPage.docOverflow > 1) gutterProblems.push("the window scrolls sideways");
  observe("frame-scrollbar-stable", gutterProblems.length === 0, { problems: gutterProblems, shortPage, longPage });
  await shot("frame-settings-short");
  await leaveSettings(view);
  await resize("wide");
  await library();

  // ---- 7. every size: the top row's buttons and the rail's settings button are inside the window, and nothing scrolls sideways ---------------------------------
  for (const size of ["wide", "narrow", "short"] as const) {
    await resize(size);
    await openLibrary(view);
    await sleep(350);
    const fit = await js<{ viewport: { w: number; h: number }; rects: Record<string, Rect | null>; docOverflow: number; barOverflow: number }>(view, `(() => {
      const rect = ${RECT};
      const out = {};
      for (const id of ["shell-sidebar-toggle", "nav-back", "nav-forward", "menu-file", "menu-help", "shell-dock-toggle", "window-controls"]) out[id] = rect(id);
      const bar = document.querySelector('[data-testid="shell-top"]');
      return { viewport: { w: window.innerWidth, h: window.innerHeight }, rects: out, docOverflow: document.documentElement.scrollWidth - window.innerWidth, barOverflow: bar ? bar.scrollWidth - bar.clientWidth : 0 };
    })()`);
    const fitProblems: string[] = [];
    const controls = fit.rects["window-controls"];
    for (const [id, r] of Object.entries(fit.rects)) {
      // The menus are left out below 640 px and forward below 480; the dock's button is there while the dock has something to show.
      if (!r || r.w <= 0) { if (id === "shell-sidebar-toggle" || id === "nav-back" || id === "window-controls") fitProblems.push(`${id} is missing`); continue; }
      if (r.x < -1 || r.r > fit.viewport.w + 1 || r.y < -1 || r.b > fit.viewport.h + 1) fitProblems.push(`${id} is outside the window`);
      if (controls && id !== "window-controls" && r.r > controls.x + 1) fitProblems.push(`${id} runs into the window's own buttons`);
    }
    if (fit.docOverflow > 1) fitProblems.push(`the window scrolls sideways by ${fit.docOverflow}px`);
    if (fit.barOverflow > 1) fitProblems.push(`the top row overflows by ${fit.barOverflow}px`);
    // The rail is on screen at every size, and its settings button with it.
    const settings = (await rects(["nav-settings"]))["nav-settings"];
    if (!settings || settings.b > fit.viewport.h + 1) fitProblems.push("the settings button is not on screen");
    observe(`frame-fits-${size}`, fitProblems.length === 0, { problems: fitProblems, viewport: fit.viewport, rects: fit.rects });
    await shot(`frame-fit-${size}`);
  }
  await resize("wide");

  // ---- 8. window full screen: the reader fills the window, the top row floats and comes down at the top edge (AT-86, AT-89) --------------------------------
  const fullProblems: string[] = [];
  const fullDetail: Record<string, unknown> = {};
  await closeTabs(view, "all");
  if (env.comicId && await openFromShelf(view, "comic", env.comicId, 10_000, ["library", "reader"]) && await waitFor(`document.querySelector('[data-testid="tab-panel"][data-focused="true"] .comic-page[data-state="ready"]')`, 25_000)) {
    const key = async (name: string) => {
      for (const type of ["keyDown", "keyUp"] as const) view.webContents.sendInputEvent({ type, keyCode: name } as never);
      await sleep(350);
    };
    const immersive = () => js<boolean>(view, `document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-immersive") === "true"`);
    const topState = async () => rects(["shell-top", "comic-reader", "shell-main", "immersive-hotzone", "immersive-drag", "window-controls", "window-close", "shell-rail", "shell-sidebar", "shell-dock"]);
    const ordinary = await topState();
    if (!ordinary["shell-rail"] || !ordinary["shell-sidebar"]) fullProblems.push("the rail or the sidebar is not there before window full screen");
    await clickTestId(view, "comic-window-fullscreen");
    const entered = await waitFor(`document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-immersive") === "true"`, 4000);
    await sleep(500);
    const full = await topState();
    fullDetail.entered = entered;
    const vw = await js<number>(view, `window.innerWidth`);
    const vh = await js<number>(view, `window.innerHeight`);
    if (!entered) fullProblems.push("the button did not fill the window");
    if (full["shell-rail"] || full["shell-sidebar"]) fullProblems.push("the rail or the sidebar is still there in window full screen");
    if (!full["comic-reader"] || !near(full["comic-reader"].x, 0, 1) || !near(full["comic-reader"].w, vw, 1) || !near(full["comic-reader"].h, vh, 1)) fullProblems.push(`the reader does not fill the window (${JSON.stringify(full["comic-reader"])} of ${vw}x${vh})`);
    if (!full["shell-top"] || full["shell-top"].b > 1) fullProblems.push(`the top row is not out of the way (${JSON.stringify(full["shell-top"])})`);
    // The window's own buttons go with the top that floats away, and a thin strip at the very top is left as a place to drag the window by (A-91).
    if (full["window-controls"] && full["window-controls"].b > 1) fullProblems.push(`the window's buttons are on screen in window full screen (${JSON.stringify(full["window-controls"])})`);
    const strip = await js<{ region: string; hit: string | null; hotRegion: string }>(view, `(() => {
      const region = (el) => (el ? (getComputedStyle(el).getPropertyValue("-webkit-app-region") || getComputedStyle(el).getPropertyValue("app-region")).trim() : "missing");
      const hit = document.elementFromPoint(Math.round(window.innerWidth / 2), 2);
      return { region: region(document.querySelector('[data-testid="immersive-drag"]')), hit: hit ? hit.getAttribute("data-testid") : null, hotRegion: region(document.querySelector('[data-testid="immersive-hotzone"]')) };
    })()`);
    fullDetail.strip = { rect: full["immersive-drag"], hotzone: full["immersive-hotzone"], ...strip };
    if (!full["immersive-drag"] || !near(full["immersive-drag"].y, 0, 1) || !near(full["immersive-drag"].h, 8, 1) || !near(full["immersive-drag"].w, vw, 1)) fullProblems.push(`the drag strip is not 8 px along the window's top (${JSON.stringify(full["immersive-drag"])})`);
    if (strip.region !== "drag") fullProblems.push(`the strip along the top is "${strip.region}", not a drag area`);
    if (strip.hit !== "immersive-drag") fullProblems.push(`a pointer at the window's top reaches ${strip.hit ?? "nothing"}, not the drag strip`);
    if (!full["immersive-hotzone"] || !near(full["immersive-hotzone"].y, 8, 1.5) || strip.hotRegion === "drag") fullProblems.push("the strip under the drag strip, which brings the top down, is missing or is a drag area");
    // The pointer at the top edge brings the top down over the page; the page keeps its size.
    await mouse("mouseMove", { x: Math.round(vw / 2), y: 600 });
    await mouse("mouseMove", { x: Math.round(vw / 2), y: 12 });
    await sleep(500);
    const shownTop = await topState();
    if (!shownTop["shell-top"] || shownTop["shell-top"].y < -1 || shownTop["shell-top"].b < 30) fullProblems.push(`the top does not come down at the top edge (${JSON.stringify(shownTop["shell-top"])})`);
    if (!shownTop["window-controls"] || shownTop["window-controls"].y < -1 || shownTop["window-controls"].b < 30 || !near(shownTop["window-controls"].r, vw, 1)) fullProblems.push(`the window's buttons do not come down with the top (${JSON.stringify(shownTop["window-controls"])})`);
    const closeHit = shownTop["window-close"] ? await js<boolean>(view, `(() => { const el = document.querySelector('[data-testid="window-close"]'); if (!el) return false; const b = el.getBoundingClientRect(); const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return Boolean(hit && (hit === el || el.contains(hit))); })()`) : false;
    fullDetail.controlsShown = { rect: shownTop["window-controls"], closeReachable: closeHit };
    if (!closeHit) fullProblems.push("the close button is not reachable when the top is down");
    if (!shownTop["comic-reader"] || !full["comic-reader"] || !near(shownTop["comic-reader"].h, full["comic-reader"].h, 1) || !near(shownTop["comic-reader"].w, full["comic-reader"].w, 1)) fullProblems.push("the page changed size when the top came down");
    await shot("frame-window-fullscreen");
    await mouse("mouseMove", { x: Math.round(vw / 2), y: Math.round(vh / 2) });
    await sleep(500);
    const hiddenTop = await topState();
    if (!hiddenTop["shell-top"] || hiddenTop["shell-top"].b > 1) fullProblems.push("the top stays down when the pointer leaves the edge");
    // Screen full screen on top of it: Esc leaves the screen state first, and the window stays full until the next Esc.
    await mouse("mouseMove", { x: Math.round(vw / 2), y: Math.round(vh / 2) });
    // The comic's bar floats and is seen when the pointer is on it: move there first, then click as a person would (full screen needs a real click).
    const fullscreenButton = await center("comic-fullscreen");
    if (fullscreenButton) { await mouse("mouseMove", fullscreenButton); await sleep(350); }
    const clicked = await trustedClick(view, "comic-fullscreen");
    const screenOn = clicked && await waitFor(`document.fullscreenElement !== null`, 3000);
    fullDetail.screenFullscreen = { clicked, screenOn };
    if (screenOn) {
      await sleep(400);
      await shot("frame-screen-fullscreen");
      await key("Escape");
      const screenLeft = await js<boolean>(view, `document.fullscreenElement === null`);
      const stillWindow = await immersive();
      fullDetail.screenFullscreen = { clicked, screenOn, screenLeft, stillWindow };
      if (!screenLeft) fullProblems.push("Esc did not leave screen full screen");
      if (!stillWindow) fullProblems.push("the Esc that left screen full screen also left window full screen");
      await sleep(500);
    } else fullProblems.push("screen full screen did not start in the window");
    // W and Esc leave and enter it from the keyboard.
    await key("w");
    const leftByKey = !(await immersive());
    await key("w");
    const enteredByKey = await immersive();
    await key("Escape");
    const leftByEsc = !(await immersive());
    fullDetail.keys = { leftByKey, enteredByKey, leftByEsc };
    if (!leftByKey) fullProblems.push("W did not leave window full screen");
    if (!enteredByKey) fullProblems.push("W did not enter window full screen");
    if (!leftByEsc) fullProblems.push("Esc did not leave window full screen");
    const back = await topState();
    if (!back["shell-rail"] || !back["shell-sidebar"] || !back["comic-reader"] || !ordinary["comic-reader"] || !near(back["comic-reader"].w, ordinary["comic-reader"].w, 1)) fullProblems.push("the window does not come back as it was");
    await closeTabs(view, ["reader"]);
  } else fullProblems.push("the comic did not open to check window full screen with");
  observe("frame-window-fullscreen", fullProblems.length === 0, { problems: fullProblems, ...fullDetail });
  await resize("wide");
}
