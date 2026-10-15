import type { BrowserWindow } from "electron";
import { clickTestId, openFromShelf, sleep, trustedClick, waitUntil } from "./driver.ts";
import { js, openSettingsPage, toRail, type caller } from "./common.ts";

/**
 * The window frame in the real window (AT-81, AT-82, AT-86): the three columns' own tops (no title bar row across the window, dividers
 * from the window's top to its bottom, the frame color), flat regions with one-pixel dividers, the page history and the menu, dragging a divider with the real mouse, the left rail (no heading, a fixed settings
 * button, folding groups), the room kept for a scrollbar, and closing an opened entry from its button or a right click. Each observation
 * is named; the package stage requires every one of them to pass.
 */

export const FRAME_OBSERVATIONS = [
  "frame-title-segments",
  "frame-window-controls",
  "frame-flat-chrome",
  "frame-history-menu",
  "frame-resize",
  "frame-rail",
  "frame-scrollbar-stable",
  "frame-close-entry",
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
  /** A comic and a video the window can open from its shelf, and every resource of the walk's library. */
  comicId: string | null;
  videoId: string | null;
  resourceIds: string[];
};

const near = (a: number, b: number, tolerance = 1.5) => Math.abs(a - b) <= tolerance;
const RECT = `(id) => { const el = document.querySelector('[data-testid="' + id + '"]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; }`;

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
  const columnWidth = (testId: string) => js<number | null>(view, `(() => { const el = document.querySelector('[data-testid="${testId.includes("left") ? "shell-left" : "shell-right"}"]'); return el ? el.getBoundingClientRect().width : null; })()`);
  /**
   * A drag with the real mouse. The synthetic pointer is only as reliable as the window's focus: a press that the window did not take (another window
   * took the focus the moment before) moves nothing, so the drag is made once more when the column did not move at all. A column that moved but not far
   * enough is the product's fault and is reported as it is.
   */
  const drag = async (testId: string, dx: number): Promise<{ during: number | null }> => {
    const start = await columnWidth(testId);
    let during: number | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const at = await center(testId);
      if (!at) return { during: null };
      await mouse("mouseMove", at);
      await mouse("mouseDown", at);
      for (const step of [dx * 0.25, dx * 0.6, dx]) await mouse("mouseMove", { x: at.x + step, y: at.y }, { held: true });
      during = await columnWidth(testId);
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
  const widths = async () => {
    const got = (await call("settings.getShell", {})).value as { mode: string; layouts: Record<string, { left: { width: number }; right: { width: number } }> };
    return { mode: got.mode, enthusiast: got.layouts.enthusiast!, creator: got.layouts.creator! };
  };
  const pageNow = () => js<string | null>(view, `document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-page") ?? null`);
  const waitFor = (expression: string, ms = 6000) => waitUntil(view, expression, ms);

  // ---- setup: the rail has an entry for every resource; a comic is left at a later page, then opened and left again ------------------
  await resize("wide");
  await toRail(view);
  for (const resourceId of env.resourceIds) await call("session.open", { kind: "resource", targetId: resourceId });
  let comicSession = "";
  if (env.comicId) {
    const listed = (await call("comic.pages", { resourceId: env.comicId })).value as { revisionId: string; pages: Array<{ id: string }> } | undefined;
    const last = listed?.pages[listed.pages.length - 1];
    if (listed && last) await call("progress.setPage", { resourceId: env.comicId, resourceRevisionId: listed.revisionId, pageId: last.id });
    comicSession = String(((await call("session.open", { kind: "resource", targetId: env.comicId })).value as { id?: string } | undefined)?.id ?? "");
    // The window reads the rail again when a reader closes: open the comic and go back.
    if (await openFromShelf(view, "nav-comic", env.comicId, 8000)) {
      await waitFor(`document.querySelector('.comic-page[data-state="ready"]')`, 20_000);
      await clickTestId(view, "nav-back");
      await waitFor(`document.querySelector('[data-testid="session-open-${comicSession}"]')`, 8000);
    }
  }
  await clickTestId(view, "nav-library");
  await sleep(300);

  // ---- 1. the columns' tops: no title bar row, each top inside its column, dividers from the window's top to its bottom ----------------------------
  await resize("wide");
  const ids = ["column-top-left", "column-top-main", "column-top-right", "shell-left", "shell-main-column", "shell-right", "shell-title", "shell-menu", "shell-left-toggle", "nav-back", "nav-forward", "mode-switch", "shell-right-toggle", "titlebar-right-title", "shell-resize-left", "shell-resize-right"];
  const geometry = await rects(ids);
  const facts = await js<{ barText: string; row: boolean; header: boolean; underlines: number[]; frame: string; tops: Array<string | null>; viewportW: number; viewportH: number }>(view, `(() => {
    const tops = ["column-top-left", "column-top-main", "column-top-right"].map((id) => document.querySelector('[data-testid="' + id + '"]'));
    const hex = getComputedStyle(document.documentElement).getPropertyValue("--color-frame").trim();
    const rgb = (value) => { const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(value); return m ? "rgb(" + parseInt(m[1], 16) + ", " + parseInt(m[2], 16) + ", " + parseInt(m[3], 16) + ")" : value; };
    // A bar across the window's top: any element at the top that is as wide as the window and bar-high, other than the app's own containers.
    const row = [...document.querySelectorAll("body *")].some((el) => {
      if (el.matches("#root, .manga-shell, .shell-workspace, .shell-main-column")) return false;
      const b = el.getBoundingClientRect();
      return b.top < 4 && b.height >= 20 && b.height <= 60 && b.width >= window.innerWidth * 0.95 && getComputedStyle(el).display !== "contents";
    });
    return {
      barText: tops.map((el) => el?.textContent ?? "").join(" "), row, header: Boolean(document.querySelector("header.shell-titlebar, [data-testid='shell-titlebar']")),
      underlines: tops.map((el) => (el ? parseFloat(getComputedStyle(el).borderBottomWidth) : 0)), frame: rgb(hex),
      tops: tops.map((el) => (el ? getComputedStyle(el).backgroundColor : null)), viewportW: window.innerWidth, viewportH: window.innerHeight,
    };
  })()`);
  const g = geometry as Record<string, Rect>;
  const problems: string[] = [];
  // The window's own buttons are drawn by the page (A-91): the right button has to end where they begin.
  const controlsAt = async () => (await rects(["window-controls"]))["window-controls"]?.x ?? facts.viewportW;
  let controlsLeft = await controlsAt();
  if (ids.some((id) => !geometry[id])) problems.push(`missing: ${ids.filter((id) => !geometry[id]).join(", ")}`);
  else {
    if (facts.header || facts.row) problems.push("there is still a title bar row across the window");
    for (const [top, column] of [["column-top-left", "shell-left"], ["column-top-main", "shell-main-column"], ["column-top-right", "shell-right"]] as const) {
      const t = g[top]!, c = g[column]!;
      if (!near(t.h, 36, 2)) problems.push(`${top} is ${Math.round(t.h)}px high`);
      if (!near(t.y, 0, 1)) problems.push(`${top} does not start at the window's top (${Math.round(t.y)})`);
      if (!near(t.x, c.x) || !near(t.w, c.w)) problems.push(`${top} is not as wide as its column (${Math.round(t.x)}+${Math.round(t.w)} against ${Math.round(c.x)}+${Math.round(c.w)})`);
    }
    for (const divider of ["shell-resize-left", "shell-resize-right"] as const) {
      const d = g[divider]!;
      if (!near(d.y, 0, 1) || d.h < facts.viewportH - 2) problems.push(`${divider} does not run from the top of the window to its bottom (${Math.round(d.y)}, ${Math.round(d.h)} of ${facts.viewportH})`);
    }
    if (facts.underlines.some((w) => w > 0)) problems.push("a column's top has a line under it");
    if (facts.tops.some((color) => color !== facts.frame)) problems.push(`the tops are not the frame color ${facts.frame}: ${facts.tops.join(" / ")}`);
    const order = ["shell-menu", "shell-left-toggle", "nav-back", "nav-forward", "mode-switch"].map((id) => g[id]!.x);
    if (order.some((x, index) => index > 0 && x <= order[index - 1]!)) problems.push("the left top's buttons are out of order");
    if (g["column-top-left"]!.x > g["shell-menu"]!.x || g["mode-switch"]!.r > g["column-top-left"]!.r + 1) problems.push("the left top's buttons are not inside the left column");
    if (g["shell-title"]!.x < g["column-top-main"]!.x) problems.push("the title is not in the main top");
    if (!/MANGA Agent/.test(await js<string>(view, `document.querySelector('[data-testid="column-top-right"] [data-testid="titlebar-right-title"]')?.textContent ?? ""`))) problems.push("the assistant's title is not in the right column's top");
    if (g["shell-right-toggle"]!.r > controlsLeft) problems.push("the right button runs into the window's own buttons");
  }
  if (/正式版|开发版|测试通道/.test(facts.barText)) problems.push("the build's channel is in a column's top");
  // With the sidebar folded away the controls move to the start of the main top, in order, and the mode switch moves into the menu.
  const folded: { ok: boolean; gap: number | null; order: string[]; menuModes: string[] } = { ok: false, gap: null, order: [], menuModes: [] };
  if (await clickTestId(view, "shell-left-toggle")) {
    folded.ok = await waitFor(`!document.querySelector('[data-testid="shell-left"]')`, 4000);
    await sleep(250);
    folded.order = await js<string[]>(view, `[...document.querySelectorAll('[data-testid="column-top-main"] [data-testid="shell-menu"], [data-testid="column-top-main"] [data-testid="shell-left-toggle"], [data-testid="column-top-main"] [data-testid="nav-back"], [data-testid="column-top-main"] [data-testid="nav-forward"], [data-testid="column-top-main"] [data-testid="shell-title"]')].map((el) => el.getAttribute("data-testid"))`);
    const after = await rects(["nav-forward", "shell-title", "mode-switch", "column-top-main"]);
    if (after["nav-forward"] && after["shell-title"]) folded.gap = after["shell-title"].x - after["nav-forward"].r;
    if (after["mode-switch"]) problems.push("the mode switch is still in the top when the sidebar is folded away");
    if (await clickTestId(view, "shell-menu")) {
      await waitFor(`document.querySelector('[role="menu"]')`, 2000);
      folded.menuModes = await js<string[]>(view, `[...document.querySelectorAll('[role="menu"] [role="menuitemradio"]')].map((el) => (el.getAttribute("data-testid") ?? "") + ":" + el.getAttribute("aria-checked"))`);
      await clickTestId(view, "shell-menu");
      await waitFor(`!document.querySelector('[role="menu"]')`, 1500);
    }
    await shot("frame-left-folded-wide");
    await clickTestId(view, "shell-left-toggle");
    await waitFor(`document.querySelector('[data-testid="shell-left"]')`, 4000);
    await sleep(250);
  }
  // With the assistant hidden its toggle moves to the end of the main top, left of the window's own buttons.
  const rightHidden: { ok: boolean; inMain: boolean; clear: boolean } = { ok: false, inMain: false, clear: false };
  if (await clickTestId(view, "shell-right-toggle")) {
    rightHidden.ok = await waitFor(`!document.querySelector('[data-testid="shell-right"]')`, 4000);
    await sleep(250);
    const after = await rects(["shell-right-toggle", "column-top-main"]);
    rightHidden.inMain = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="column-top-main"] [data-testid="shell-right-toggle"]'))`);
    controlsLeft = await controlsAt();
    rightHidden.clear = Boolean(after["shell-right-toggle"]) && after["shell-right-toggle"]!.r <= controlsLeft;
    await shot("frame-right-hidden-wide");
    await clickTestId(view, "shell-right-toggle");
    await waitFor(`document.querySelector('[data-testid="shell-right"]')`, 4000);
    await sleep(250);
  }
  if (!rightHidden.ok) problems.push("the assistant did not fold away");
  else if (!rightHidden.inMain || !rightHidden.clear) problems.push(`with the assistant hidden its button is ${rightHidden.inMain ? "" : "not in the main top and "}${rightHidden.clear ? "" : "under the window's own buttons"}`);
  if (!folded.ok) problems.push("the sidebar did not fold away");
  else {
    if (folded.order.join(",") !== "shell-menu,shell-left-toggle,nav-back,nav-forward,shell-title") problems.push(`with the sidebar folded the main top holds ${folded.order.join(", ")}`);
    if (folded.gap === null || folded.gap < 0 || folded.gap > 40) problems.push(`with the sidebar folded the title is ${folded.gap === null ? "?" : Math.round(folded.gap)}px from the buttons`);
    if (folded.menuModes.length !== 2 || !folded.menuModes.some((entry) => entry.endsWith(":true"))) problems.push(`the menu does not offer the modes with the current one checked (${folded.menuModes.join(", ")})`);
  }
  observe("frame-title-segments", problems.length === 0, { problems, rects: { leftTop: g["column-top-left"], rail: g["shell-left"], mainTop: g["column-top-main"], rightTop: g["column-top-right"], assistant: g["shell-right"] }, folded, rightHidden, frame: facts.frame });

  // ---- 1b. the window's own buttons, drawn by the page (AT-105) -------------------------------------------------------------------------------------
  // Their place, size and drag exclusion are measured; the three are clicked with real input (maximize and restore, then minimize and restore from the
  // main process). Closing is left to the unit tests of the command: the walk needs its window. Snap layouts, Win+Z, dragging by the top and the system's
  // animations are the platform's own and are looked at by hand (H-46).
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
    if (!near(group.r, facts.viewportW, 1) || !near(group.y, 0, 1)) controlsProblems.push("the buttons are not in the window's top right corner");
    if (!near(group.h, 36, 2)) controlsProblems.push(`the buttons are ${Math.round(group.h)}px high, not as high as a top`);
    if (buttons.some((b) => !near(b.w, 46, 1) || !near(b.h, group.h, 1))) controlsProblems.push("a button is not 46 px wide and as high as the group");
    if (!(buttons[0]!.r <= buttons[1]!.x + 1 && buttons[1]!.r <= buttons[2]!.x + 1)) controlsProblems.push("the buttons are not in the order minimize, maximize, close");
    if (!near(buttons[2]!.r, facts.viewportW, 1)) controlsProblems.push("the close button is not at the window's right edge");
    // None of them is in a drag area; the top around them is, and a pointer over each of them reaches that button.
    const regions = await js<{ group: string; around: string; reach: boolean[] }>(view, `(() => {
      const region = (el) => (el ? getComputedStyle(el).getPropertyValue("-webkit-app-region") || getComputedStyle(el).getPropertyValue("app-region") : "none");
      const ids = ["window-minimize", "window-maximize", "window-close"];
      return {
        group: region(document.querySelector('[data-testid="window-controls"]')),
        around: region(document.querySelector('[data-testid="column-top-main"]')),
        reach: ids.map((id) => { const el = document.querySelector('[data-testid="' + id + '"]'); if (!el) return false; const b = el.getBoundingClientRect(); const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return Boolean(hit && (hit === el || el.contains(hit))); }),
      };
    })()`);
    controlsDetail.regions = regions;
    if (regions.group.trim() !== "no-drag") controlsProblems.push(`the buttons' group is "${regions.group.trim()}", not no-drag`);
    if (regions.around.trim() !== "drag") controlsProblems.push(`the top around the buttons is "${regions.around.trim()}", not a drag area`);
    if (regions.reach.some((reached) => !reached)) controlsProblems.push("a pointer over a button does not reach it");
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
    await mouse("mouseMove", { x: Math.round(facts.viewportW / 2), y: 300 });
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

  // ---- 2. flat regions, one-pixel dividers ------------------------------------------------------------------------------------------------
  const flat = await js<Record<string, any>>(view, `(() => {
    const rect = ${RECT};
    const style = (id) => { const el = document.querySelector('[data-testid="' + id + '"]'); if (!el) return null; const s = getComputedStyle(el); return { border: ["Top", "Right", "Bottom", "Left"].map((k) => parseFloat(s["border" + k + "Width"])), radius: ["TopLeft", "TopRight", "BottomLeft", "BottomRight"].map((k) => parseFloat(s["border" + k + "Radius"])), shadow: s.boxShadow, padding: [s.paddingTop, s.paddingRight, s.paddingBottom, s.paddingLeft] }; };
    const main = rect("shell-main"), left = rect("shell-left"), right = rect("shell-right");
    return { main: style("shell-main"), assistant: style("shell-right"), root: style("shell-root"), left: style("shell-left"), dividerLeft: rect("shell-resize-left"), dividerRight: rect("shell-resize-right"), gapLeft: main && left ? main.x - left.r : null, gapRight: main && right ? right.x - main.r : null };
  })()`);
  const flatProblems: string[] = [];
  for (const key of ["main", "assistant"] as const) {
    const s = flat[key];
    if (!s) { flatProblems.push(`${key} is missing`); continue; }
    if (s.border.some((w: number) => w > 0)) flatProblems.push(`${key} has a border`);
    if (s.radius.some((r: number) => r > 0)) flatProblems.push(`${key} has rounded corners`);
    if (s.shadow !== "none") flatProblems.push(`${key} has a shadow`);
  }
  if (!flat.root || flat.root.padding.some((p: string) => p !== "0px")) flatProblems.push("the window keeps a margin around the regions");
  for (const key of ["dividerLeft", "dividerRight"] as const) {
    const d = flat[key] as Rect | null;
    if (!d || !near(d.w, 1, 0.5) || d.h < 200) flatProblems.push(`${key} is not a one-pixel line the height of the page`);
  }
  if (flat.gapLeft === null || flat.gapLeft > 1.5 || flat.gapRight === null || flat.gapRight > 1.5) flatProblems.push(`the regions are not next to each other (${flat.gapLeft}, ${flat.gapRight})`);
  observe("frame-flat-chrome", flatProblems.length === 0, { problems: flatProblems, flat });
  await shot("frame-wide");

  // ---- 3. back, forward and the menu ----------------------------------------------------------------------------------------------------------------
  await clickTestId(view, "nav-comic");
  await sleep(300);
  await clickTestId(view, "nav-video");
  await sleep(300);
  const history: Record<string, unknown> = { start: await pageNow() };
  const navState = () => js<{ back: boolean; forward: boolean }>(view, `({ back: !document.querySelector('[data-testid="nav-back"]')?.disabled, forward: !document.querySelector('[data-testid="nav-forward"]')?.disabled })`);
  history.atEnd = await navState();
  await clickTestId(view, "nav-back");
  await sleep(350);
  history.afterBack = await pageNow();
  history.afterBackState = await navState();
  await clickTestId(view, "nav-forward");
  await sleep(350);
  history.afterForward = await pageNow();
  history.afterForwardState = await navState();
  await clickTestId(view, "shell-menu");
  const menuShown = await waitFor(`document.querySelector('[role="menu"]')`, 2000);
  const menuIds = await js<string[]>(view, `[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((el) => el.getAttribute("data-testid"))`);
  await clickTestId(view, "shell-menu-about");
  const about = await waitFor(`document.querySelector('[data-testid="about-dialog"]')`, 3000);
  const aboutVersion = about ? await js<string>(view, `document.querySelector('[data-testid="about-version"]')?.textContent ?? ""`) : "";
  await clickTestId(view, "about-dialog-close");
  await waitFor(`!document.querySelector('[data-testid="about-dialog"]')`, 3000);
  const wantedMenu = ["shell-menu-settings", "shell-menu-scan", "shell-menu-debug", "shell-menu-about", "shell-menu-quit"];
  const historyProblems: string[] = [];
  const atEnd = history.atEnd as { back: boolean; forward: boolean };
  if (history.start !== "video") historyProblems.push(`the video shelf was not reached (${String(history.start)})`);
  if (!atEnd.back || atEnd.forward) historyProblems.push("back should be possible and forward not, at the newest page");
  if (history.afterBack !== "comic") historyProblems.push(`back went to ${String(history.afterBack)}, not the comic shelf`);
  if (!(history.afterBackState as { forward: boolean }).forward) historyProblems.push("forward is not possible after going back");
  if (history.afterForward !== "video") historyProblems.push(`forward went to ${String(history.afterForward)}, not the video shelf`);
  if (!menuShown || wantedMenu.some((id) => !menuIds.includes(id))) historyProblems.push(`the menu lacks ${wantedMenu.filter((id) => !menuIds.includes(id)).join(", ")}`);
  if (!about || !aboutVersion || aboutVersion === "-") historyProblems.push("the About dialog does not show a version");
  observe("frame-history-menu", historyProblems.length === 0, { problems: historyProblems, history, menuIds, aboutVersion });

  // ---- 4. dragging the dividers with the real mouse, remembered per mode, put back on a double click ------------------------------------------
  await clickTestId(view, "nav-library");
  await sleep(300);
  // A wide window, so both columns can be dragged a good way before the page's own room stops them.
  view.setContentSize(1600, 900);
  await sleep(450);
  const resizeProblems: string[] = [];
  const first = await widths();
  const base = first.enthusiast.left.width;
  const moved = await drag("shell-resize-left", 60);
  const afterLeft = await widths();
  const leftShown = await js<number>(view, `document.querySelector('[data-testid="shell-left"]').getBoundingClientRect().width`);
  if (!moved.during || !near(moved.during, base + 60, 3)) resizeProblems.push(`the rail followed the pointer to ${moved.during} (wanted ${base + 60})`);
  if (!near(afterLeft.enthusiast.left.width, base + 60, 3)) resizeProblems.push(`the saved rail width is ${afterLeft.enthusiast.left.width}`);
  if (!near(leftShown, base + 60, 3)) resizeProblems.push(`the rail is ${Math.round(leftShown)}px after the drag`);
  if (afterLeft.creator.left.width !== first.creator.left.width) resizeProblems.push("the other mode's width changed too");
  const rightBase = first.enthusiast.right.width;
  const movedRight = await drag("shell-resize-right", -80);
  const afterRight = await widths();
  if (!movedRight.during || !near(movedRight.during, rightBase + 80, 3) || !near(afterRight.enthusiast.right.width, rightBase + 80, 3)) resizeProblems.push(`the assistant did not grow to ${rightBase + 80} (${movedRight.during}, saved ${afterRight.enthusiast.right.width})`);
  // Dragged as far as it goes, a column stops where the page keeps its room.
  await drag("shell-resize-left", 3000);
  const limits = await js<{ left: number; main: number }>(view, `({ left: document.querySelector('[data-testid="shell-left"]').getBoundingClientRect().width, main: document.querySelector('[data-testid="shell-main"]').getBoundingClientRect().width })`);
  if (limits.left > 421 || limits.main < 630) resizeProblems.push(`the rail went to ${Math.round(limits.left)} and left the page ${Math.round(limits.main)}px`);
  await shot("frame-resized-wide");
  // A narrow window folds the columns away; the saved width is still there when the window is wide again.
  const savedLeft = (await widths()).enthusiast.left.width;
  await resize("narrow");
  const narrowState = await js<{ left: string | null; resizeLeft: boolean; main: number; viewport: number }>(view, `({ left: document.querySelector('[data-testid="shell-left"]')?.getAttribute("data-shell-state") ?? null, resizeLeft: Boolean(document.querySelector('[data-testid="shell-resize-left"]')), main: document.querySelector('[data-testid="shell-main"]').getBoundingClientRect().width, viewport: window.innerWidth })`);
  if (narrowState.left === "dock" || narrowState.resizeLeft || narrowState.main < narrowState.viewport - 1) resizeProblems.push(`a narrow window keeps a docked column (${JSON.stringify(narrowState)})`);
  view.setContentSize(1600, 900);
  await sleep(450);
  const back = await js<number>(view, `document.querySelector('[data-testid="shell-left"]')?.getBoundingClientRect().width ?? 0`);
  if (!near(back, savedLeft, 3)) resizeProblems.push(`the rail came back ${Math.round(back)}px wide, not ${savedLeft}`);
  await doubleClick("shell-resize-left");
  await doubleClick("shell-resize-right");
  const restored = await widths();
  if (restored.enthusiast.left.width !== first.enthusiast.left.width || restored.enthusiast.right.width !== first.enthusiast.right.width) resizeProblems.push(`a double click restored ${restored.enthusiast.left.width} and ${restored.enthusiast.right.width}`);
  observe("frame-resize", resizeProblems.length === 0, { problems: resizeProblems, base, rightBase, saved: afterLeft.enthusiast.left.width, savedRight: afterRight.enthusiast.right.width, narrowState, restored: { left: restored.enthusiast.left.width, right: restored.enthusiast.right.width } });

  // ---- 5. the rail: no heading, a divider, folding groups, the settings button fixed under a list that scrolls on its own --------------------------
  await resize("short");
  await clickTestId(view, "nav-library");
  await sleep(300);
  const railFacts = () => js<Record<string, any>>(view, `(() => {
    const rect = ${RECT};
    const sessions = document.querySelector('[data-testid="shell-sessions"]');
    const left = document.querySelector('[data-testid="shell-left"]');
    const settings = rect("nav-settings"), first = document.querySelector('.shell-nav button[data-testid="nav-library"]')?.getBoundingClientRect();
    return {
      heading: Boolean(sessions?.querySelector("h2")), text: sessions?.textContent ?? "", rows: document.querySelectorAll('[data-testid^="session-open-"]').length,
      sessions: rect("shell-sessions"), settings, navHeight: first ? first.height : null,
      sessionsScroll: sessions ? { scrollHeight: sessions.scrollHeight, clientHeight: sessions.clientHeight } : null,
      leftScroll: left ? { scrollHeight: left.scrollHeight, clientHeight: left.clientHeight } : null,
      divider: sessions ? parseFloat(getComputedStyle(sessions).borderTopWidth) : null, viewportH: window.innerHeight,
    };
  })()`);
  const before = await railFacts();
  const railProblems: string[] = [];
  if (before.heading || /已打开/.test(String(before.text))) railProblems.push("the opened list still has a heading");
  // A 1px line is a device pixel at any scaling, so at 150% it computes to 0.67px; only "no line" is a fault.
  if (!(before.divider > 0)) railProblems.push("no divider between the pages and the opened list");
  if (before.rows < 4) railProblems.push(`only ${before.rows} opened entries to check with`);
  if (!before.settings || before.settings.b > before.viewportH + 1) railProblems.push("the settings button is not on screen");
  if (before.settings && before.navHeight && before.settings.h > before.navHeight + 1) railProblems.push(`the settings button (${Math.round(before.settings.h)}px) is taller than a navigation row (${Math.round(before.navHeight)}px)`);
  if (before.leftScroll && before.leftScroll.scrollHeight > before.leftScroll.clientHeight + 1) railProblems.push("the whole rail scrolls");
  const scrolls = Boolean(before.sessionsScroll && before.sessionsScroll.scrollHeight > before.sessionsScroll.clientHeight + 1);
  await js(view, `(() => { const el = document.querySelector('[data-testid="shell-sessions"]'); if (el) el.scrollTop = el.scrollHeight; })()`);
  await sleep(150);
  const scrolled = await railFacts();
  if (before.settings && scrolled.settings && (!near(before.settings.y, scrolled.settings.y, 0.5) || !near(before.settings.b, scrolled.settings.b, 0.5))) railProblems.push("the settings button moved when the list scrolled");
  // A group folds to its count and unfolds again, and the choice is kept.
  const novelRows = await js<number>(view, `document.querySelectorAll('[data-testid="session-group-novel"] [data-testid^="session-open-"]').length`);
  let folding = { rows: novelRows, folded: -1, count: "", kept: false, unfolded: -1 };
  if (novelRows > 0 && await clickTestId(view, "session-fold-novel")) {
    await sleep(200);
    folding = {
      rows: novelRows,
      folded: await js<number>(view, `document.querySelectorAll('[data-testid="session-group-novel"] [data-testid^="session-open-"]').length`),
      count: await js<string>(view, `document.querySelector('[data-testid="session-count-novel"]')?.textContent ?? ""`),
      kept: await js<boolean>(view, `(() => { try { return (localStorage.getItem("manga.rail.collapsed") ?? "").includes("novel"); } catch { return false; } })()`),
      unfolded: -1,
    };
    await clickTestId(view, "session-fold-novel");
    await sleep(200);
    folding.unfolded = await js<number>(view, `document.querySelectorAll('[data-testid="session-group-novel"] [data-testid^="session-open-"]').length`);
    if (folding.folded !== 0 || folding.count !== String(novelRows) || !folding.kept || folding.unfolded !== novelRows) railProblems.push(`a group does not fold to its count and back (${JSON.stringify(folding)})`);
  } else railProblems.push("there is no novel group to fold");
  observe("frame-rail", railProblems.length === 0, { problems: railProblems, scrolls, before: { rows: before.rows, settings: before.settings, sessions: before.sessions }, folding });
  await shot("frame-rail-short");

  // ---- 6. a scrollbar's room is kept whether or not the page scrolls ------------------------------------------------------------------------------------
  await resize("wide");
  await clickTestId(view, "nav-library");
  await sleep(400);
  // The scroller is the one the page scrolls in: a page that scrolls inside itself (the settings page, a shelf) or else the main area.
  const gutterOf = () => js<{ gutter: number; overflowing: boolean; style: string; thin: string; track: string; docOverflow: number; content: number; scroller: string }>(view, `(() => {
    const main = document.querySelector('[data-testid="shell-main"]');
    const inner = [...main.querySelectorAll("*")].filter((el) => {
      const overflow = getComputedStyle(el).overflowY;
      return (overflow === "auto" || overflow === "scroll") && el.clientWidth >= main.clientWidth * 0.5 && el.clientHeight >= 100;
    }).sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight);
    const scroller = inner[0] ?? main;
    const s = getComputedStyle(scroller);
    return { gutter: scroller.offsetWidth - scroller.clientWidth, overflowing: scroller.scrollHeight > scroller.clientHeight + 1, style: s.scrollbarGutter, thin: s.scrollbarWidth, track: s.scrollbarColor, docOverflow: document.documentElement.scrollWidth - window.innerWidth, content: scroller.clientWidth, scroller: scroller === main ? "main" : String(scroller.className).split(" ")[0] };
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
  await clickTestId(view, "settings-back");
  await resize("wide");
  await toRail(view);

  // ---- 7. closing an opened entry: its button, a right click, and the way back to the same place (AT-82) --------------------------------------------------
  const closeProblems: string[] = [];
  const closeDetail: Record<string, unknown> = {};
  if (env.comicId && comicSession) {
    await clickTestId(view, "nav-library");
    await sleep(300);
    const position = () => js<string>(view, `document.querySelector('[data-testid="session-position-${comicSession}"]')?.textContent ?? ""`);
    const placeBefore = await position();
    closeDetail.placeBefore = placeBefore;
    if (!placeBefore) closeProblems.push("the entry does not say where the comic was left");
    const opened = await openFromShelf(view, "nav-comic", env.comicId, 8000) && await waitFor(`document.querySelector('.comic-page[data-state="ready"]')`, 20_000);
    if (!opened) closeProblems.push("the comic did not open");
    // The close button shows on hover.
    const row = await center(`session-open-${comicSession}`);
    if (row) await mouse("mouseMove", row);
    await sleep(150);
    const hoverShown = await js<boolean>(view, `(() => { const el = document.querySelector('[data-testid="session-close-${comicSession}"]'); return Boolean(el) && getComputedStyle(el).display !== "none"; })()`);
    closeDetail.hoverShown = hoverShown;
    if (!hoverShown) closeProblems.push("the close button does not show when the pointer is over the entry");
    // A real right click opens the menu; "关闭" closes the entry, and the reader that was open on it is left.
    if (row) {
      await mouse("mouseDown", row, { button: "right" });
      await mouse("mouseUp", row, { button: "right" });
    }
    const menuOpen = await waitFor(`document.querySelector('[data-testid="session-menu"]')`, 2500);
    closeDetail.menuOpen = menuOpen;
    if (!menuOpen) closeProblems.push("a right click on the entry opens no menu");
    else await clickTestId(view, "session-menu-close");
    const gone = await waitFor(`!document.querySelector('[data-testid="session-open-${comicSession}"]') && !document.querySelector('[data-testid="comic-reader"]')`, 8000);
    closeDetail.gone = gone;
    if (!gone) closeProblems.push("the entry or the reader is still there after closing");
    const listed = ((await call("workspace.sessions", {})).value as Array<{ sessionId: string }> | undefined) ?? [];
    if (listed.some((item) => item.sessionId === comicSession)) closeProblems.push("the closed entry is still listed by the host");
    // Opening the same comic again brings back the same entry, at the same place.
    const reopened = await openFromShelf(view, "nav-comic", env.comicId, 8000) && await waitFor(`document.querySelector('.comic-page[data-state="ready"]')`, 20_000);
    const back = await waitFor(`document.querySelector('[data-testid="session-open-${comicSession}"]')`, 8000);
    const placeAfter = back ? await position() : "";
    closeDetail.reopened = { reopened, back, placeAfter };
    if (!reopened || !back) closeProblems.push("opening the comic again does not bring the same entry back");
    else if (placeAfter !== placeBefore) closeProblems.push(`the place changed: "${placeBefore}" before, "${placeAfter}" after`);
    await clickTestId(view, "nav-back");
    await sleep(400);
    // The button closes an entry that is not the one open.
    if (env.videoId) {
      const videoSession = String(((await call("session.open", { kind: "resource", targetId: env.videoId })).value as { id?: string } | undefined)?.id ?? "");
      await clickTestId(view, "nav-library");
      await sleep(300);
      const listedBefore = await waitFor(`document.querySelector('[data-testid="session-open-${videoSession}"]')`, 2500);
      if (listedBefore && await clickTestId(view, `session-close-${videoSession}`)) {
        const videoGone = await waitFor(`!document.querySelector('[data-testid="session-open-${videoSession}"]')`, 4000);
        closeDetail.buttonClosed = videoGone;
        if (!videoGone) closeProblems.push("the close button leaves the entry on the rail");
        const reuse = (await call("session.open", { kind: "resource", targetId: env.videoId })).value as { id?: string; reused?: boolean } | undefined;
        if (!reuse || reuse.id !== videoSession || reuse.reused !== true) closeProblems.push("the same conversation does not come back for the video");
      } else closeProblems.push("the video's entry was not on the rail to close");
    }
  } else closeProblems.push("there was no comic to close");
  observe("frame-close-entry", closeProblems.length === 0, { problems: closeProblems, ...closeDetail });

  // ---- 8. every size: the title bar's buttons and the rail's settings button are inside the window, and nothing scrolls sideways ---------------------------------
  for (const size of ["wide", "narrow", "short"] as const) {
    await resize(size);
    await clickTestId(view, "nav-library");
    await sleep(350);
    const fit = await js<{ viewport: { w: number; h: number }; rects: Record<string, Rect | null>; docOverflow: number; barOverflow: number }>(view, `(() => {
      const rect = ${RECT};
      const out = {};
      for (const id of ["shell-menu", "shell-left-toggle", "nav-back", "mode-switch", "shell-right-toggle", "shell-title"]) out[id] = rect(id);
      const bar = document.querySelector('[data-testid="column-top-main"]');
      return { viewport: { w: window.innerWidth, h: window.innerHeight }, rects: out, docOverflow: document.documentElement.scrollWidth - window.innerWidth, barOverflow: bar ? bar.scrollWidth - bar.clientWidth : 0 };
    })()`);
    const fitProblems: string[] = [];
    for (const [id, r] of Object.entries(fit.rects)) {
      if (id === "shell-title") continue;
      // The right button needs a right column or room in the main top; the mode switch is in the menu where the left column is not docked.
      if (!r) { if (id !== "shell-right-toggle" && !(id === "mode-switch" && size === "narrow")) fitProblems.push(`${id} is missing`); continue; }
      if (r.x < -1 || r.r > fit.viewport.w + 1 || r.y < -1 || r.b > fit.viewport.h + 1) fitProblems.push(`${id} is outside the window`);
    }
    const toggle = fit.rects["shell-right-toggle"];
    const buttonsAt = (await rects(["window-controls"]))["window-controls"]?.x ?? fit.viewport.w;
    if (toggle && toggle.r > buttonsAt) fitProblems.push("the right button runs into the window's own buttons");
    if (fit.docOverflow > 1) fitProblems.push(`the window scrolls sideways by ${fit.docOverflow}px`);
    if (fit.barOverflow > 1) fitProblems.push(`the main top overflows by ${fit.barOverflow}px`);
    if (size !== "narrow") {
      // The left rail is on screen wide and short, and its settings button with it.
      const settings = (await rects(["nav-settings"]))["nav-settings"];
      if (!settings || settings.b > fit.viewport.h + 1) fitProblems.push("the settings button is not on screen");
    }
    observe(`frame-fits-${size}`, fitProblems.length === 0, { problems: fitProblems, viewport: fit.viewport, rects: fit.rects });
    await shot(`frame-fit-${size}`);
  }
  await resize("wide");

  // ---- 9. window full screen: the reader fills the window, the main top floats and comes down at the top edge (AT-86, AT-89) -----------------------
  const fullProblems: string[] = [];
  const fullDetail: Record<string, unknown> = {};
  if (env.comicId && await openFromShelf(view, "nav-comic", env.comicId, 8000) && await waitFor(`document.querySelector('.comic-page[data-state="ready"]')`, 20_000)) {
    const key = async (name: string) => {
      for (const type of ["keyDown", "keyUp"] as const) view.webContents.sendInputEvent({ type, keyCode: name } as never);
      await sleep(350);
    };
    const immersive = () => js<boolean>(view, `document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-immersive") === "true"`);
    const topState = async () => {
      const got = await rects(["column-top-main", "comic-reader", "shell-main-column", "immersive-hotzone", "immersive-drag", "window-controls", "window-close", "shell-left"]);
      return got;
    };
    const ordinary = await topState();
    if (!ordinary["shell-left"]) fullProblems.push("the rail is not there before window full screen");
    await clickTestId(view, "comic-window-fullscreen");
    const entered = await waitFor(`document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-immersive") === "true"`, 4000);
    await sleep(500);
    const full = await topState();
    fullDetail.entered = entered;
    const vw = await js<number>(view, `window.innerWidth`);
    const vh = await js<number>(view, `window.innerHeight`);
    if (!entered) fullProblems.push("the button did not fill the window");
    if (full["shell-left"]) fullProblems.push("the rail is still there in window full screen");
    if (!full["comic-reader"] || !near(full["comic-reader"].x, 0, 1) || !near(full["comic-reader"].w, vw, 1) || !near(full["comic-reader"].h, vh, 1)) fullProblems.push(`the reader does not fill the window (${JSON.stringify(full["comic-reader"])} of ${vw}x${vh})`);
    if (!full["column-top-main"] || full["column-top-main"].b > 1) fullProblems.push(`the main top is not out of the way (${JSON.stringify(full["column-top-main"])})`);
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
    if (!shownTop["column-top-main"] || shownTop["column-top-main"].y < -1 || shownTop["column-top-main"].b < 30) fullProblems.push(`the top does not come down at the top edge (${JSON.stringify(shownTop["column-top-main"])})`);
    if (!shownTop["window-controls"] || shownTop["window-controls"].y < -1 || shownTop["window-controls"].b < 30 || !near(shownTop["window-controls"].r, vw, 1)) fullProblems.push(`the window's buttons do not come down with the top (${JSON.stringify(shownTop["window-controls"])})`);
    const closeHit = shownTop["window-close"] ? await js<boolean>(view, `(() => { const el = document.querySelector('[data-testid="window-close"]'); if (!el) return false; const b = el.getBoundingClientRect(); const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2); return Boolean(hit && (hit === el || el.contains(hit))); })()`) : false;
    fullDetail.controlsShown = { rect: shownTop["window-controls"], closeReachable: closeHit };
    if (!closeHit) fullProblems.push("the close button is not reachable when the top is down");
    if (!shownTop["comic-reader"] || !full["comic-reader"] || !near(shownTop["comic-reader"].h, full["comic-reader"].h, 1) || !near(shownTop["comic-reader"].w, full["comic-reader"].w, 1)) fullProblems.push("the page changed size when the top came down");
    await shot("frame-window-fullscreen");
    await mouse("mouseMove", { x: Math.round(vw / 2), y: Math.round(vh / 2) });
    await sleep(500);
    const hiddenTop = await topState();
    if (!hiddenTop["column-top-main"] || hiddenTop["column-top-main"].b > 1) fullProblems.push("the top stays down when the pointer leaves the edge");
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
    if (!back["shell-left"] || !back["comic-reader"] || !ordinary["comic-reader"] || !near(back["comic-reader"].w, ordinary["comic-reader"].w, 1)) fullProblems.push("the window does not come back as it was");
    await clickTestId(view, "nav-back");
    await sleep(400);
  } else fullProblems.push("the comic did not open to check window full screen with");
  observe("frame-window-fullscreen", fullProblems.length === 0, { problems: fullProblems, ...fullDetail });
  await resize("wide");
  await pageNow();
}
