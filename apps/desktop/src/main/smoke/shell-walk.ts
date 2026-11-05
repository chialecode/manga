import type { BrowserWindow } from "electron";
import { DRAWN, PICK, clickTestId, closeTabs, ensureSidebar, openFromShelf, openLibrary, pressKey, railTo, sleep, waitFrames, waitUntil, type RailName } from "./driver.ts";
import { js, leaveSettings, toRail, type caller } from "./common.ts";
import { boxOf, centreOf, cssColor, hex, mouse, near3, parseRgb, pixelsOf, type Box, type Point, type Rgb } from "./input.ts";
import type { Observe } from "./reader-controls-walk.ts";

/**
 * The window's frame, the rail and the sidebar after the experience pass (A-103 — A-110, UI-01, AT-123 — AT-126, AT-132, AT-136), with the real pointer
 * and the screen's own pixels: the main area meets its neighbours at a right angle; a column dragged past half its least width folds away and comes
 * back from the rail's edge; the menus light their whole row; the icons of the rail move by dragging and by the menu; the home lists one mixed list per
 * context under a folder and a guide line; the counts are the rows; the three media views show covers.
 */
export const SHELL_OBSERVATIONS = ["shell-corner", "sidebar-drag-collapse", "menu-hover", "rail-reorder", "sidebar-home-list", "sidebar-counts", "media-view-covers"] as const;

type Call = ReturnType<typeof caller>;
export type ShellEnv = {
  view: BrowserWindow;
  call: Call;
  observe: Observe;
  shot: (name: string) => Promise<void>;
  resize: (size: "wide" | "narrow" | "short") => Promise<void>;
  projectId: string;
  novelId: string | null;
  /** The library's folders, for a resource made unopenable on purpose. */
  folders: { novel: string; comic: string; video: string };
};

type ShellSaved = { sidebar: { visible: boolean; width: number }; dock: { visible: boolean; width: number }; rail: { hidden: string[]; order: string[]; display: Record<string, string> } };
const saved = async (call: Call): Promise<ShellSaved> => (await call("settings.getShell", {})).value as ShellSaved;
const drawn = (view: BrowserWindow, id: string) => js<boolean>(view, `${DRAWN}(${PICK}(${JSON.stringify(id)}))`);
const attr = (view: BrowserWindow, id: string, name: string) => js<string | null>(view, `${PICK}(${JSON.stringify(id)})?.getAttribute(${JSON.stringify(name)}) ?? null`);
const activeId = (view: BrowserWindow) => js<string | null>(view, `document.activeElement?.getAttribute("data-testid") ?? null`);
const widthOf = async (view: BrowserWindow, id: string) => (await boxOf(view, id))?.w ?? null;
const near = (a: number | null | undefined, b: number, tolerance = 2) => typeof a === "number" && Math.abs(a - b) <= tolerance;

/** The rail's movable icons in the order drawn (the home first is left out, and "…"). */
const railOrderDrawn = (view: BrowserWindow) => js<string[]>(view, `[...document.querySelectorAll('[data-testid="rail-views"] > button[data-rail-view]')].map((b) => b.getAttribute("data-rail-view")).filter((name) => name !== "more" && name !== "home")`);

export async function runShellWalk(env: ShellEnv): Promise<void> {
  const { view } = env;
  await env.resize("wide");
  await leaveSettings(view);
  await toRail(view);
  view.webContents.focus();
  for (const step of [walkCorner, walkDragCollapse, walkMenuHover, walkRailReorder, walkHomeList, walkCounts, walkCovers]) {
    try { await step(env); } catch (error) {
      const name = SHELL_OBSERVATIONS[[walkCorner, walkDragCollapse, walkMenuHover, walkRailReorder, walkHomeList, walkCounts, walkCovers].indexOf(step)]!;
      env.observe(name, false, { problems: [`the walk stopped: ${error instanceof Error ? error.message : String(error)}`] });
    }
    await pressKey(view, "Escape");
    await leaveSettings(view);
  }
  await toRail(view);
}

// ------------------------------------------------------------------------------------------------------------------------------ shell-corner

/**
 * The main area's top left corner (UI-01, AT-136): a 3 × 3 block there is the colour the main area draws a little lower in the same columns (below where a
 * rounded corner would end), never the window frame's colour showing through a curve. Sidebar shown, sidebar folded, and a reader in window full screen.
 */
async function walkCorner(env: ShellEnv): Promise<void> {
  const { view, call, observe, shot, novelId } = env;
  const problems: string[] = [];
  const rows: Record<string, unknown> = {};
  const frame = parseRgb(await js<string>(view, `getComputedStyle(document.querySelector('[data-testid="shell-root"]')).backgroundColor`));
  const measure = async (state: string) => {
    const main = await boxOf(view, "shell-main");
    if (!main) { problems.push(`${state}: the main area is not drawn`); return; }
    const radius = await js<string>(view, `getComputedStyle(document.querySelector('[data-testid="shell-main"]')).borderTopLeftRadius`);
    // Inside the main area's own one-pixel lines (they are the separator UI-01 asks for): a rounded corner would show the frame's colour there.
    const edge = await js<{ left: number; top: number }>(view, `(() => { const el = document.querySelector('[data-testid="shell-main"]'); return { left: el.clientLeft, top: el.clientTop }; })()`);
    const corner = await pixelsOf(view, { x: main.x + edge.left, y: main.y + edge.top, w: 3, h: 3 });
    const below = await pixelsOf(view, { x: main.x + edge.left, y: main.y + 14, w: 3, h: 1 });
    const odd: string[] = [];
    corner.rgb.forEach((pixel, index) => {
      const column = index % corner.width;
      if (near3(pixel, frame, 3)) odd.push(`${column},${Math.floor(index / corner.width)}:${hex(pixel)}=frame`);
    });
    rows[state] = { radius, corner: hex(corner.rgb[0]), below: hex(below.rgb[0]), frame: hex(frame), odd: odd.slice(0, 4) };
    if (radius !== "0px") problems.push(`${state}: the main area's corner is rounded (${radius})`);
    if (odd.length) problems.push(`${state}: the corner shows the window frame's colour (${odd.slice(0, 3).join(", ")})`);
  };
  await closeTabs(view, "all");
  await openLibrary(view);
  await waitFrames(view, 2);
  const before = await saved(call);
  if (!before.sidebar.visible) await clickTestId(view, "shell-sidebar-toggle");
  await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="shell-sidebar"]'))`, 3000);
  await measure("sidebar-shown");
  await clickTestId(view, "shell-sidebar-toggle");
  await waitUntil(view, `!document.querySelector('[data-testid="shell-sidebar"]')`, 3000);
  await waitFrames(view, 2);
  await measure("sidebar-folded");
  await clickTestId(view, "shell-sidebar-toggle");
  await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="shell-sidebar"]'))`, 3000);
  if (novelId && await openFromShelf(view, "novel", novelId, 8000) && await waitUntil(view, `document.querySelector('[data-testid="reading-body"]')`, 10_000)) {
    await clickTestId(view, "reading-window-fullscreen");
    if (await waitUntil(view, `document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-immersive") === "true"`, 4000)) {
      // The pointer away from the top edge, so the floating top stays up.
      view.webContents.sendInputEvent({ type: "mouseMove", x: 400, y: 400 });
      await waitUntil(view, `(document.querySelector('[data-testid="shell-top"]')?.getBoundingClientRect().bottom ?? 36) <= 0.5`, 2000);
      await waitFrames(view, 2);
      await measure("window-full-screen");
      await shot("shell-corner-window-full");
      await pressKey(view, "Escape");
      await waitUntil(view, `document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-immersive") === "false"`, 4000);
    } else problems.push("the reader's window full screen did not start");
    await closeTabs(view, ["reader"]);
  } else problems.push("the novel did not open for the window full screen state");
  observe("shell-corner", problems.length === 0, { rows, problems });
}

// ---------------------------------------------------------------------------------------------------------------------- sidebar-drag-collapse

/**
 * A.104, AT-125, with the real mouse: the sidebar dragged to its least width stops there; on past half of it the column folds away while the pointer is held
 * (the divider says so), comes back when the pointer returns, and folds away when let go there, its saved width as before the drag. A window that loses the
 * focus mid-drag changes nothing. From the rail's right edge it is pulled out (a short pull does nothing). The dock folds the same way. On the divider Enter
 * folds the column and the focus goes to its switch, where Enter brings it back.
 */
async function walkDragCollapse(env: ShellEnv): Promise<void> {
  const { view, call, observe, shot } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  await closeTabs(view, "all");
  await openLibrary(view);
  // A known start: both columns shown, the sidebar at its first width.
  let start = await saved(call);
  if (!start.sidebar.visible) await clickTestId(view, "shell-sidebar-toggle");
  if (!start.dock.visible) await clickTestId(view, "shell-dock-toggle");
  await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="shell-resize-sidebar"]')) && ${DRAWN}(document.querySelector('[data-testid="shell-resize-dock"]'))`, 4000);
  await waitFrames(view, 2);
  start = await saved(call);
  const width0 = Math.round((await widthOf(view, "shell-sidebar")) ?? start.sidebar.width);
  const grip = await centreOf(view, "shell-resize-sidebar");
  if (!grip) { observe("sidebar-drag-collapse", false, { problems: ["the sidebar's divider is not drawn"] }); return; }
  const at = (width: number): Point => ({ x: grip.x - (width0 - width), y: grip.y });
  const collapsing = () => attr(view, "shell-resize-sidebar", "data-collapsing");

  // 1. To the least width, then past half of it, back, and past again: let go there.
  await mouse(view, "mouseMove", grip);
  await mouse(view, "mouseDown", grip);
  await mouse(view, "mouseMove", at(width0 - 20), { held: true });
  await mouse(view, "mouseMove", at(200), { held: true });
  await waitFrames(view, 2);
  const atLeast = { width: await widthOf(view, "shell-sidebar"), collapsing: await collapsing() };
  await mouse(view, "mouseMove", at(140), { held: true });
  await waitFrames(view, 2);
  const stopped = { width: await widthOf(view, "shell-sidebar"), collapsing: await collapsing() };
  await mouse(view, "mouseMove", at(80), { held: true });
  await waitFrames(view, 2);
  const folding = { collapsing: await collapsing(), sidebar: await drawn(view, "shell-sidebar"), valuenow: await attr(view, "shell-resize-sidebar", "aria-valuenow") };
  await shot("sidebar-drag-collapsing");
  await mouse(view, "mouseMove", at(160), { held: true });
  await waitFrames(view, 2);
  const back = { collapsing: await collapsing(), width: await widthOf(view, "shell-sidebar") };
  await mouse(view, "mouseMove", at(60), { held: true });
  await waitFrames(view, 2);
  await mouse(view, "mouseUp", at(60));
  await waitUntil(view, `!document.querySelector('[data-testid="shell-sidebar"]')`, 2000);
  const after = await saved(call);
  detail.drag = { width0, atLeast, stopped, folding, back, after: after.sidebar };
  if (!near(atLeast.width, 200, 2) || atLeast.collapsing) problems.push(`at the least width the sidebar is ${atLeast.width} wide (collapsing ${atLeast.collapsing})`);
  if (!near(stopped.width, 200, 2) || stopped.collapsing) problems.push(`short of half the least width the sidebar is ${stopped.width} wide, not stopped at 200 (collapsing ${stopped.collapsing})`);
  if (folding.collapsing !== "true" || folding.sidebar || folding.valuenow !== "0") problems.push(`past half the least width the sidebar did not fold away while held (${JSON.stringify(folding)})`);
  if (back.collapsing || !near(back.width, 200, 2)) problems.push(`back within the threshold the sidebar did not come back at 200 (${JSON.stringify(back)})`);
  if (after.sidebar.visible || !near(after.sidebar.width, start.sidebar.width, 1)) problems.push(`let go past the threshold: the sidebar is ${after.sidebar.visible ? "shown" : "hidden"} with the width ${after.sidebar.width} (it was ${start.sidebar.width})`);

  // 2. Pulled out from the rail's edge: a short pull does nothing, a long one shows it at that width.
  const pull = await centreOf(view, "shell-pullout");
  const railBox = await boxOf(view, "shell-rail");
  detail.pullout = { drawn: Boolean(pull), rail: railBox ? Math.round(railBox.r) : null, at: pull ? Math.round(pull.x) : null };
  if (!pull || !railBox || Math.abs(pull.x - railBox.r) > 6) problems.push("there is no strip at the rail's right edge to pull the sidebar out");
  else {
    const edge = { x: pull.x - 3, y: pull.y };
    await mouse(view, "mouseMove", edge);
    await mouse(view, "mouseDown", edge);
    await mouse(view, "mouseMove", { x: pull.x + 40, y: pull.y }, { held: true });
    await mouse(view, "mouseMove", { x: edge.x + 70, y: pull.y }, { held: true });
    await mouse(view, "mouseUp", { x: edge.x + 70, y: pull.y });
    await waitFrames(view, 2);
    const short = (await saved(call)).sidebar.visible;
    await mouse(view, "mouseMove", edge);
    await mouse(view, "mouseDown", edge);
    for (const dx of [60, 140, 240, 280]) await mouse(view, "mouseMove", { x: edge.x + dx, y: pull.y }, { held: true });
    await waitFrames(view, 2);
    const during = await widthOf(view, "shell-sidebar");
    await mouse(view, "mouseUp", { x: edge.x + 280, y: pull.y });
    await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="shell-sidebar"]'))`, 2000);
    const pulled = await saved(call);
    detail.pull = { short, during, pulled: pulled.sidebar };
    if (short) problems.push("a pull shorter than half the least width showed the sidebar");
    if (!pulled.sidebar.visible || !near(pulled.sidebar.width, 280, 4) || !near(during, 280, 4)) problems.push(`a pull of 280 px left the sidebar ${pulled.sidebar.visible ? "shown" : "hidden"} at ${pulled.sidebar.width} (${during} while held)`);
  }

  // 3. A window that loses the focus in the middle of a drag past the threshold: nothing changes.
  {
    const now = await centreOf(view, "shell-resize-sidebar");
    const width = Math.round((await widthOf(view, "shell-sidebar")) ?? 0);
    if (now) {
      await mouse(view, "mouseMove", now);
      await mouse(view, "mouseDown", now);
      await mouse(view, "mouseMove", { x: now.x - (width - 60), y: now.y }, { held: true });
      await waitFrames(view, 2);
      const was = await collapsing();
      await js(view, `window.dispatchEvent(new Event("blur")); true`);
      await waitFrames(view, 2);
      await mouse(view, "mouseUp", { x: now.x - (width - 60), y: now.y });
      await waitFrames(view, 2);
      const kept = await saved(call);
      detail.blurred = { was, kept: kept.sidebar, width };
      if (was !== "true") problems.push("the drag for the lost focus did not reach the threshold");
      if (!kept.sidebar.visible || !near(kept.sidebar.width, width, 2)) problems.push(`a window that lost the focus mid-drag changed the sidebar (${JSON.stringify(kept.sidebar)})`);
    }
  }

  // 4. The dock: dragged right past half its least width, let go, it is hidden with its width kept.
  {
    const dockGrip = await centreOf(view, "shell-resize-dock");
    const dockWidth = Math.round((await widthOf(view, "shell-dock")) ?? 0);
    const before = (await saved(call)).dock;
    if (!dockGrip) problems.push("the dock's divider is not drawn");
    else {
      await mouse(view, "mouseMove", dockGrip);
      await mouse(view, "mouseDown", dockGrip);
      await mouse(view, "mouseMove", { x: dockGrip.x + (dockWidth - 320), y: dockGrip.y }, { held: true });
      await mouse(view, "mouseMove", { x: dockGrip.x + (dockWidth - 120), y: dockGrip.y }, { held: true });
      await waitFrames(view, 2);
      const dockFolding = await attr(view, "shell-resize-dock", "data-collapsing");
      await mouse(view, "mouseUp", { x: dockGrip.x + (dockWidth - 120), y: dockGrip.y });
      await waitUntil(view, `!document.querySelector('[data-testid="shell-dock"]')`, 2000);
      const dockAfter = (await saved(call)).dock;
      detail.dock = { dockWidth, dockFolding, before, dockAfter };
      if (dockFolding !== "true") problems.push("the dock did not say it folds away past half its least width");
      if (dockAfter.visible || !near(dockAfter.width, before.width, 1)) problems.push(`the dock let go past the threshold is ${dockAfter.visible ? "shown" : "hidden"} at ${dockAfter.width} (was ${before.width})`);
      await clickTestId(view, "shell-dock-toggle");
      await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="shell-dock"]'))`, 2000);
    }
  }

  // 5. The keys (APG window splitter): Enter on the divider folds the sidebar, the focus is on its switch, Enter there brings it back.
  {
    await js(view, `${PICK}("shell-resize-sidebar")?.focus(); true`);
    await pressKey(view, "Enter");
    await waitUntil(view, `!document.querySelector('[data-testid="shell-sidebar"]')`, 2000);
    const folded = !(await saved(call)).sidebar.visible;
    const focus = await activeId(view);
    view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
    view.webContents.sendInputEvent({ type: "char", keyCode: "\r" });
    view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
    await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="shell-sidebar"]'))`, 2000);
    const back = (await saved(call)).sidebar.visible;
    detail.keys = { folded, focus, back };
    if (!folded) problems.push("Enter on the sidebar's divider did not fold the sidebar");
    if (focus !== "shell-sidebar-toggle") problems.push(`after Enter folded the sidebar the focus is on ${focus}, not its switch`);
    if (!back) problems.push("Enter on the sidebar's switch did not bring it back");
  }
  // The width the walks after this one expect.
  const restore = await centreOf(view, "shell-resize-sidebar");
  if (restore) {
    await mouse(view, "mouseMove", restore);
    await mouse(view, "mouseDown", restore, { clickCount: 1 });
    await mouse(view, "mouseUp", restore, { clickCount: 1 });
    await mouse(view, "mouseDown", restore, { clickCount: 2 });
    await mouse(view, "mouseUp", restore, { clickCount: 2 });
    await waitUntil(view, `Math.abs((document.querySelector('[data-testid="shell-sidebar"]')?.getBoundingClientRect().width ?? 0) - 260) <= 4`, 2000);
  }
  observe("sidebar-drag-collapse", problems.length === 0, { ...detail, problems });
}

// ------------------------------------------------------------------------------------------------------------------------------ menu-hover

/** The colour at the two ends of a row (4 px in from each side, in the middle of its height), as the screen shows it. */
async function rowEnds(view: BrowserWindow, row: Box): Promise<[Rgb | undefined, Rgb | undefined]> {
  const y = row.y + row.h / 2;
  const left = await pixelsOf(view, { x: row.x + 4, y, w: 1, h: 1 });
  const right = await pixelsOf(view, { x: row.r - 5, y, w: 1, h: 1 });
  return [left.rgb[0], right.rgb[0]];
}

/**
 * A-109, AT-132: the hovered row of the rail's right-click menu and of "…" is pink from one end to the other, with no grey under it; the pin is at least
 * 32 × 32, has no ground of its own, and its icon goes darker under the pointer.
 */
async function walkMenuHover(env: ShellEnv): Promise<void> {
  const { view, call, observe, shot } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const pink = await cssColor(view, "var(--color-accent-soft)");
  detail.pink = hex(pink);
  // The right-click menu of an icon.
  const note = await centreOf(view, "nav-note");
  if (!note) problems.push("the note icon is not on the rail");
  else {
    await mouse(view, "mouseMove", note);
    await mouse(view, "mouseDown", note, { button: "right" });
    await mouse(view, "mouseUp", note, { button: "right" });
    if (!(await waitUntil(view, `document.querySelector('[data-testid="rail-menu"]')`, 2000))) problems.push("right click on an icon opened no menu");
    else {
      const list = await boxOf(view, "rail-menu");
      const item = await boxOf(view, "rail-menu-hide");
      if (!list || !item) problems.push("the menu has no hide row");
      else {
        const row: Box = { x: list.x + 1, y: item.y, w: list.w - 2, h: item.h, r: list.r - 1, b: item.b };
        await mouse(view, "mouseMove", { x: item.x + item.w / 2, y: item.y + item.h / 2 });
        await waitFrames(view, 2);
        const [left, right] = await rowEnds(view, row);
        detail.contextMenu = { left: hex(left), right: hex(right), item: [Math.round(item.x - list.x), Math.round(list.r - item.r)] };
        if (!near3(left, pink, 10) || !near3(right, pink, 10)) problems.push(`the hovered row of the right-click menu is ${hex(left)} at its left end and ${hex(right)} at its right end, not pink from end to end`);
        await shot("menu-hover-context");
      }
      await pressKey(view, "Escape");
      await waitUntil(view, `!document.querySelector('[data-testid="rail-menu"]')`, 2000);
    }
  }
  // "…" with an icon taken out: its row and its pin.
  const before = await railOrderDrawn(view);
  const hidden = await hideIcon(view, "mindmap");
  if (!hidden) problems.push("the mind map icon could not be taken out for the \"…\" list");
  else if (await clickReal(view, "rail-more") && await waitUntil(view, `document.querySelector('[data-testid="rail-more-list"]')`, 2000)) {
    const item = await boxOf(view, "rail-more-mindmap");
    const rowBox = await js<Box | null>(view, `(() => { const el = document.querySelector('[data-testid="rail-more-mindmap"]')?.closest('[data-rail-more-row]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; })()`);
    if (!item || !rowBox) problems.push("the hidden icon is not in \"…\"");
    else {
      await mouse(view, "mouseMove", { x: item.x + 12, y: item.y + item.h / 2 });
      await waitFrames(view, 2);
      const [left, right] = await rowEnds(view, rowBox);
      const pinBox = await boxOf(view, "rail-pin-mindmap");
      const pinIdle = await js<{ color: string; background: string }>(view, `(() => { const pin = document.querySelector('[data-testid="rail-pin-mindmap"]'); const s = getComputedStyle(pin); return { color: s.color, background: s.backgroundColor }; })()`);
      await shot("menu-hover-more");
      if (pinBox) await mouse(view, "mouseMove", { x: pinBox.x + pinBox.w / 2, y: pinBox.y + pinBox.h / 2 });
      await waitFrames(view, 2);
      const pinHover = await js<{ color: string; background: string }>(view, `(() => { const pin = document.querySelector('[data-testid="rail-pin-mindmap"]'); const s = getComputedStyle(pin); return { color: s.color, background: s.backgroundColor }; })()`);
      const [leftOnPin, rightOnPin] = await rowEnds(view, rowBox);
      const luminance = (text: string) => { const c = parseRgb(text); return c ? 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] : -1; };
      const transparent = (text: string) => /rgba\(\s*\d+[,\s]+\d+[,\s]+\d+[,\s/]+0(\.0+)?\s*\)/.test(text) || text === "transparent";
      detail.more = { left: hex(left), right: hex(right), leftOnPin: hex(leftOnPin), rightOnPin: hex(rightOnPin), pin: pinBox ? [Math.round(pinBox.w), Math.round(pinBox.h)] : null, pinIdle, pinHover };
      if (!near3(left, pink, 10) || !near3(right, pink, 10)) problems.push(`the hovered row of "…" is ${hex(left)} at its left end and ${hex(right)} at its right end, not pink from end to end`);
      if (!near3(leftOnPin, pink, 10) || !near3(rightOnPin, pink, 10)) problems.push(`with the pointer on the pin the row of "…" is ${hex(leftOnPin)} … ${hex(rightOnPin)}, not pink`);
      if (!pinBox || pinBox.w < 32 || pinBox.h < 32) problems.push(`the pin takes the pointer over ${pinBox ? `${Math.round(pinBox.w)} × ${Math.round(pinBox.h)}` : "nothing"}, less than 32 × 32`);
      if (!transparent(pinHover.background)) problems.push(`the pin has a ground of its own under the pointer (${pinHover.background})`);
      if (!(luminance(pinHover.color) < luminance(pinIdle.color) - 4)) problems.push(`the pin's icon does not go darker under the pointer (${pinIdle.color} → ${pinHover.color})`);
      // Put back with the pin: it comes back where it was.
      if (pinBox) await clickReal(view, "rail-pin-mindmap");
      await waitUntil(view, `document.querySelector('[data-testid="nav-mindmap"]')`, 2000);
    }
    await pressKey(view, "Escape");
  }
  const afterPin = await railOrderDrawn(view);
  detail.order = { before, afterPin };
  if (hidden && JSON.stringify(afterPin) !== JSON.stringify(before)) problems.push(`pinned back, the icons are ${afterPin.join(",")}, not ${before.join(",")} as before`);
  observe("menu-hover", problems.length === 0, { ...detail, problems });
}

/** A click with the real pointer on an element of the page. */
async function clickReal(view: BrowserWindow, id: string, button: "left" | "right" = "left"): Promise<boolean> {
  const at = await centreOf(view, id);
  if (!at) return false;
  await mouse(view, "mouseMove", at);
  await mouse(view, "mouseDown", at, { button });
  await mouse(view, "mouseUp", at, { button });
  await waitFrames(view, 2);
  return true;
}

/** Right click on an icon and "从图标栏隐藏"; true once the icon is gone from the rail. */
async function hideIcon(view: BrowserWindow, name: RailName): Promise<boolean> {
  if (!(await clickReal(view, `nav-${name}`, "right"))) return false;
  if (!(await waitUntil(view, `document.querySelector('[data-testid="rail-menu-hide"]')`, 2000))) return false;
  await clickReal(view, "rail-menu-hide");
  return waitUntil(view, `!document.querySelector('[data-testid="rail-views"] > [data-testid="nav-${name}"]')`, 2000);
}

// ---------------------------------------------------------------------------------------------------------------------------- rail-reorder

/** A drag of an icon with the real mouse, from its centre to a point; `release: false` leaves the button down. */
async function dragIcon(view: BrowserWindow, name: string, to: Point, options: { through?: Point[]; release?: boolean } = {}): Promise<boolean> {
  const from = await centreOf(view, `nav-${name}`);
  if (!from) return false;
  await mouse(view, "mouseMove", from);
  await mouse(view, "mouseDown", from);
  await mouse(view, "mouseMove", { x: from.x, y: from.y + (to.y > from.y ? 6 : -6) }, { held: true });
  for (const point of options.through ?? []) await mouse(view, "mouseMove", point, { held: true });
  const steps = 4;
  for (let step = 1; step <= steps; step += 1) await mouse(view, "mouseMove", { x: from.x + (to.x - from.x) * step / steps, y: from.y + (to.y - from.y) * step / steps }, { held: true });
  await waitFrames(view, 2);
  if (options.release !== false) await mouse(view, "mouseUp", to);
  await waitFrames(view, 3);
  return true;
}

/**
 * A-108, AT-132: the note icon dragged above the conversations and the rough cut to the top (under the home) take those places; one dragged off the rail
 * goes back; the home and the settings do not move; the menu's 上移 / 下移 move one place and keep the focus; a hidden icon pinned back comes back to its
 * place; the order is what the shell preferences keep.
 */
async function walkRailReorder(env: ShellEnv): Promise<void> {
  const { view, call, observe, shot } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const initial = await railOrderDrawn(view);
  detail.initial = initial;
  const slot = async (name: string): Promise<Point | null> => centreOf(view, `nav-${name}`);
  const before = (list: string[], a: string, b: string) => list.indexOf(a) >= 0 && list.indexOf(a) < list.indexOf(b);

  // The note above the conversations.
  const target = await slot("conversation");
  if (target) await dragIcon(view, "note", { x: target.x, y: target.y - 12 });
  const afterNote = await railOrderDrawn(view);
  if (!before(afterNote, "note", "conversation")) problems.push(`dragged above the conversations, the note icon is at ${afterNote.indexOf("note") + 1} (${afterNote.join(",")})`);
  // The rough cut to the top, under the home.
  const top = await slot(afterNote[0]!);
  const home = await boxOf(view, "nav-home");
  if (top && home) await dragIcon(view, "roughcut", { x: top.x, y: Math.max(home.b + 2, top.y - 14) });
  const afterCut = await railOrderDrawn(view);
  if (afterCut[0] !== "roughcut") problems.push(`dragged to the top, the rough cut is at ${afterCut.indexOf("roughcut") + 1} (${afterCut.join(",")})`);
  await shot("rail-reorder");
  // Off the rail sideways: back where it was, and no view was chosen by the drag.
  const sidebarView = await attr(view, "sidebar", "data-view");
  const video = await slot("video");
  if (video) await dragIcon(view, "video", { x: video.x + 120, y: video.y + 70 }, { through: [{ x: video.x, y: video.y + 40 }] });
  const afterLeave = await railOrderDrawn(view);
  if (JSON.stringify(afterLeave) !== JSON.stringify(afterCut)) problems.push(`an icon dragged off the rail moved: ${afterLeave.join(",")}`);
  if ((await attr(view, "sidebar", "data-view")) !== sidebarView) problems.push("a drag off the rail chose the icon's view");
  // Esc in the middle of a drag: back where it was.
  const comic = await slot("comic");
  if (comic) {
    await dragIcon(view, "comic", { x: comic.x, y: comic.y + 90 }, { release: false });
    await pressKey(view, "Escape");
    await mouse(view, "mouseUp", { x: comic.x, y: comic.y + 90 });
    await waitFrames(view, 2);
  }
  const afterEsc = await railOrderDrawn(view);
  if (JSON.stringify(afterEsc) !== JSON.stringify(afterCut)) problems.push(`Esc in the middle of a drag did not put the icon back: ${afterEsc.join(",")}`);
  // The home and the settings stay where they are.
  const homeAt = await boxOf(view, "nav-home");
  if (homeAt) await mouse(view, "mouseMove", { x: homeAt.x + homeAt.w / 2, y: homeAt.y + homeAt.h / 2 });
  if (homeAt) {
    await mouse(view, "mouseDown", { x: homeAt.x + homeAt.w / 2, y: homeAt.y + homeAt.h / 2 });
    for (const dy of [8, 40, 90]) await mouse(view, "mouseMove", { x: homeAt.x + homeAt.w / 2, y: homeAt.y + homeAt.h / 2 + dy }, { held: true });
    const draggingHome = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="rail-views"][data-dragging="true"]'))`);
    await mouse(view, "mouseUp", { x: homeAt.x + homeAt.w / 2, y: homeAt.y + homeAt.h / 2 + 90 });
    await waitFrames(view, 2);
    const homeAfter = await boxOf(view, "nav-home");
    detail.home = { draggingHome, moved: homeAfter ? Math.round(homeAfter.y - homeAt.y) : null };
    if (draggingHome || !homeAfter || Math.abs(homeAfter.y - homeAt.y) > 1) problems.push("the home icon moved with a drag");
  }
  const settingsMenu = await clickReal(view, "nav-settings", "right") && await waitUntil(view, `document.querySelector('[data-testid="rail-menu"]')`, 800);
  if (settingsMenu) { problems.push("the settings icon has a menu to move it"); await pressKey(view, "Escape"); }
  await leaveSettings(view);
  const homeMenu = await clickReal(view, "nav-home", "right") && await waitUntil(view, `document.querySelector('[data-testid="rail-menu"]')`, 800);
  if (homeMenu) { problems.push("the home icon has a menu to move it"); await pressKey(view, "Escape"); }

  // The menu: 上移 moves the comic icon up one place and the focus stays on it; at the top 上移 cannot be chosen.
  const comicAt = afterCut.indexOf("comic");
  if (await clickReal(view, "nav-comic", "right") && await waitUntil(view, `document.querySelector('[data-testid="rail-menu-up"]')`, 2000)) {
    await clickReal(view, "rail-menu-up");
    await waitFrames(view, 2);
    const afterUp = await railOrderDrawn(view);
    const focus = await js<string | null>(view, `document.activeElement?.getAttribute("data-rail-view") ?? null`);
    const said = await js<string>(view, `document.querySelector('[data-testid="rail-said"]')?.textContent ?? ""`);
    detail.menuUp = { from: comicAt, to: afterUp.indexOf("comic"), focus, said };
    if (afterUp.indexOf("comic") !== comicAt - 1) problems.push(`上移 moved the comic icon from ${comicAt + 1} to ${afterUp.indexOf("comic") + 1}`);
    if (focus !== "comic") problems.push(`after 上移 the focus is on ${focus}, not the icon that moved`);
    if (!said) problems.push("the move is not said for a screen reader");
  } else problems.push("the comic icon's menu has no 上移");
  if (await clickReal(view, "nav-roughcut", "right") && await waitUntil(view, `document.querySelector('[data-testid="rail-menu-up"]')`, 2000)) {
    const disabled = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="rail-menu-up"]')?.disabled)`);
    if (!disabled) problems.push("上移 can be chosen for the icon at the top");
    await pressKey(view, "Escape");
  }

  // Hidden and pinned back: the same place.
  const orderBeforeHide = await railOrderDrawn(view);
  const hidden = await hideIcon(view, "draft");
  if (hidden && await clickReal(view, "rail-more") && await waitUntil(view, `document.querySelector('[data-testid="rail-pin-draft"]')`, 2000)) {
    await mouse(view, "mouseMove", (await centreOf(view, "rail-more-draft")) ?? { x: 100, y: 100 });
    await waitFrames(view, 2);
    await clickReal(view, "rail-pin-draft");
    await waitUntil(view, `document.querySelector('[data-testid="nav-draft"]')`, 2000);
    await pressKey(view, "Escape");
  } else problems.push("the draft icon could not be taken out and pinned back");
  const orderAfterPin = await railOrderDrawn(view);
  if (JSON.stringify(orderAfterPin) !== JSON.stringify(orderBeforeHide)) problems.push(`pinned back, the draft icon is at ${orderAfterPin.indexOf("draft") + 1}, not ${orderBeforeHide.indexOf("draft") + 1}`);
  // What the preferences keep is what the rail draws.
  const kept = (await saved(call)).rail.order.filter((name) => orderAfterPin.includes(name));
  detail.final = { drawn: orderAfterPin, kept };
  if (JSON.stringify(kept.slice(0, orderAfterPin.length)) !== JSON.stringify(orderAfterPin)) problems.push(`the preferences keep the order ${kept.join(",")}, the rail draws ${orderAfterPin.join(",")}`);
  observe("rail-reorder", problems.length === 0, { ...detail, problems });
}

// ------------------------------------------------------------------------------------------------------------------------ sidebar-home-list

type HomeRow = { id: string; text: string; pill: string | null; leadIcon: boolean; nameLeft: number; pillWhole: boolean };
type HomeGroup = { key: string; current: boolean; open: boolean; icon: string | null; toggle: string | null; guide: { drawn: boolean; color: string; x: number } | null; headIconX: number | null; nameLeft: number | null; rows: HomeRow[] };

/** What the home draws, read from the page: per context its icon, its guide line and its rows. */
const homeFacts = (view: BrowserWindow) => js<{ groups: HomeGroup[]; recentTitles: number; entries: string[]; projectsAdd: boolean }>(view, `(() => {
  const root = document.querySelector('[data-testid="sidebar"][data-view="home"]');
  if (!root) return { groups: [], recentTitles: 0, entries: [], projectsAdd: false };
  const groups = [...root.querySelectorAll(".sidebar-context")].map((g) => {
    const toggle = g.querySelector(".sidebar-folder");
    const icon = toggle?.querySelector("svg");
    const body = g.querySelector(".sidebar-context-body");
    const bodyStyle = body ? getComputedStyle(body) : null;
    const nameEl = g.querySelector(".sidebar-context-name .truncate");
    const rows = [...g.querySelectorAll(".sidebar-row")].map((r) => {
      const name = r.querySelector(".truncate");
      const pill = r.querySelector(".sidebar-pill");
      const first = r.firstElementChild;
      const pb = pill?.getBoundingClientRect();
      const rb = r.getBoundingClientRect();
      return { id: r.getAttribute("data-testid") ?? "", text: name?.textContent ?? "", pill: pill?.textContent ?? null, leadIcon: Boolean(first && first.tagName.toLowerCase() === "svg"),
        nameLeft: name ? name.getBoundingClientRect().left : -1, pillWhole: !pill || (pill.scrollWidth <= pill.clientWidth + 1 && pb.right <= rb.right + 0.5) };
    });
    const ib = icon?.getBoundingClientRect();
    return {
      key: (g.getAttribute("data-testid") ?? "").slice("context-".length), current: g.getAttribute("data-current") === "true", open: g.getAttribute("data-open") === "true",
      icon: icon ? [...icon.classList].find((c) => c.startsWith("lucide-") && c !== "lucide") ?? null : null, toggle: toggle?.getAttribute("aria-expanded") ?? null,
      guide: body ? { drawn: bodyStyle.borderLeftStyle !== "none" && parseFloat(bodyStyle.borderLeftWidth) > 0, color: bodyStyle.borderLeftColor, x: body.getBoundingClientRect().left } : null,
      headIconX: ib ? ib.left + ib.width / 2 : null, nameLeft: nameEl ? nameEl.getBoundingClientRect().left : null, rows,
    };
  });
  return {
    groups,
    recentTitles: [...root.querySelectorAll("*")].filter((el) => el.children.length === 0 && (el.textContent ?? "").trim() === "最近").length,
    entries: [...root.querySelectorAll('[data-testid="sidebar-entries"] > button')].map((b) => b.getAttribute("data-testid") ?? ""),
    projectsAdd: Boolean(root.querySelector('[data-testid="sidebar-projects"] .sidebar-group-head [data-testid="sidebar-new-project"]')),
  };
})()`);

/**
 * A-103, A-110, AT-123: the home has one list per context, newest activity first, no icon in front of a row and the kind in a pill after the name; a project
 * is a folder that is open or closed with its group; the rows hang from a guide line, the accent for the context of the window; "最近" has one title; no
 * "新对话", and the projects' title has a "+"; at 200 px the pills stay whole. The order is the command's, which sorts by the newest activity.
 */
async function walkHomeList(env: ShellEnv): Promise<void> {
  const { view, call, observe, shot, projectId } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  await closeTabs(view, "all");
  await railTo(view, "home");
  await ensureSidebar(view);
  await waitUntil(view, `document.querySelector('[data-testid="sidebar"][data-view="home"]') && !document.querySelector('[data-testid="sidebar-loading"]')`, 6000);
  // Something new in the project, so it has a newest row: a note written now and put in it.
  const fresh = (await call("notes.create", { title: "主页混排的新笔记", text: "最新的一条" })).value as { objectId?: string } | undefined;
  if (fresh?.objectId) await call("project.addMaterial", { projectId, kind: "note", targetId: fresh.objectId }).catch(() => null);
  await waitFrames(view, 2);
  const expand = async (key: string) => {
    if ((await attr(view, `context-toggle-${key}`, "aria-expanded")) !== "true" && (await attr(view, `context-toggle-${key}`, "disabled")) === null) await clickTestId(view, `context-toggle-${key}`);
    await waitUntil(view, `${PICK}("context-toggle-${key}")?.getAttribute("aria-expanded") === "true" && document.querySelector('[data-testid="context-${key}"] .sidebar-row')`, 3000);
  };
  const fold = async (key: string) => {
    if ((await attr(view, `context-toggle-${key}`, "aria-expanded")) === "true" && (await attr(view, `context-toggle-${key}`, "disabled")) === null) {
      await clickTestId(view, `context-toggle-${key}`);
      await waitUntil(view, `${PICK}("context-toggle-${key}")?.getAttribute("aria-expanded") === "false"`, 2000);
    }
  };
  await fold(projectId);
  const foldedFacts = await homeFacts(view);
  await expand(projectId);
  await expand("recent");
  const facts = await homeFacts(view);
  const project = facts.groups.find((group) => group.key === projectId);
  const projectFolded = foldedFacts.groups.find((group) => group.key === projectId);
  const recent = facts.groups.find((group) => group.key === "recent");
  const accent = parseRgb((await js<string>(view, `(() => { const p = document.createElement("div"); p.style.color = "var(--color-accent)"; document.body.appendChild(p); const c = getComputedStyle(p).color; p.remove(); return c; })()`)));
  const api = (await call("workspace.sidebar", { view: "home", open: [projectId, null] })).value as { groups: Array<{ contextId: string | null; sections: Array<{ type: string; total: number; items: Array<{ title: string; type: string; updatedAt?: string | null }> }> }> };
  const apiProject = api.groups.find((group) => group.contextId === projectId);
  detail.project = project ? { icon: project.icon, folded: projectFolded?.icon, rows: project.rows.slice(0, 8).map((row) => `${row.text}|${row.pill}`), guide: project.guide } : null;
  detail.recent = recent ? { icon: recent.icon, rows: recent.rows.length, guide: recent.guide } : null;
  detail.entries = facts.entries;
  detail.sections = apiProject?.sections.map((section) => `${section.type}:${section.total}`);
  if (!project) problems.push("the project is not in the home");
  else {
    if (project.icon !== "lucide-folder-open" || projectFolded?.icon !== "lucide-folder") problems.push(`the project's folder is ${projectFolded?.icon} folded and ${project.icon} open, not a closed and an open folder`);
    if (project.toggle !== "true" || projectFolded?.toggle !== "false") problems.push("the folder does not say whether its group is open");
    if (project.rows.length === 0) problems.push("the open project lists nothing");
    if (project.rows.some((row) => row.leadIcon)) problems.push("a row of the home has an icon in front of its name");
    if (project.rows.some((row) => !row.pill)) problems.push("a row of the home has no pill naming its kind");
    if (!project.guide?.drawn) problems.push("the project's rows do not hang from a guide line");
    else if (project.headIconX !== null && Math.abs(project.guide.x - project.headIconX) > 3) problems.push(`the guide line is at ${Math.round(project.guide.x)}, not under the folder's middle ${Math.round(project.headIconX)}`);
    if (project.nameLeft !== null && project.rows.some((row) => Math.abs(row.nameLeft - project.nameLeft!) > 3)) problems.push("the names of the rows do not line up with the project's name");
    // One mixed list: one section of every kind, the command's order.
    if (!apiProject || apiProject.sections.length !== 1 || apiProject.sections[0]!.type !== "all") problems.push(`the home's project is not one mixed list (${detail.sections})`);
    else {
      const want = apiProject.sections[0]!.items.map((item) => item.title).slice(0, project.rows.length);
      if (JSON.stringify(project.rows.map((row) => row.text)) !== JSON.stringify(want)) problems.push(`the project lists ${JSON.stringify(project.rows.map((row) => row.text))}, the command ${JSON.stringify(want)}`);
      const kinds = new Set(apiProject.sections[0]!.items.map((item) => item.type));
      if (kinds.size < 2) problems.push(`the project's list has one kind only (${[...kinds].join(",")}): nothing shows the kinds mixed`);
      if (project.rows[0]?.text !== "主页混排的新笔记") problems.push(`the note written last is not first in the project (${project.rows[0]?.text})`);
      if (project.rows.length > 8) problems.push(`the project lists ${project.rows.length} rows before "更多", more than 8`);
    }
  }
  if (!recent) problems.push("最近 is not in the home");
  else {
    if (recent.icon !== "lucide-clock") problems.push(`最近 has the icon ${recent.icon}, not the clock`);
    if (!recent.guide?.drawn) problems.push("最近's rows do not hang from a guide line");
  }
  if (facts.recentTitles !== 1) problems.push(`"最近" is written ${facts.recentTitles} times in the home, not once`);
  if (facts.entries.includes("sidebar-new-conversation")) problems.push("the home still has 新对话");
  if (!facts.projectsAdd) problems.push("the projects' title has no \"+\"");
  // The guide of the context of the window is the accent; another context's is not.
  const current = facts.groups.find((group) => group.current && group.guide);
  const other = facts.groups.find((group) => !group.current && group.guide);
  detail.guides = { current: current ? `${current.key}:${current.guide!.color}` : null, other: other ? `${other.key}:${other.guide!.color}` : null };
  if (current && !near3(parseRgb(current.guide!.color), accent, 12)) problems.push(`the guide line of the window's context is ${current.guide!.color}, not the accent`);
  if (other && near3(parseRgb(other.guide!.color), accent, 12)) problems.push("the guide line of another context is the accent too");
  await shot("sidebar-home");
  // Dark: the same page in the dark theme, for the picture.
  const theme = await js<string | null>(view, `document.documentElement.getAttribute("data-theme")`);
  await js(view, `document.documentElement.setAttribute("data-theme", "dark"); true`);
  await waitFrames(view, 2);
  await shot("sidebar-home-dark");
  await js(view, theme === null ? `document.documentElement.removeAttribute("data-theme"); true` : `document.documentElement.setAttribute("data-theme", ${JSON.stringify(theme)}); true`);
  // At 200 px: the pills whole, the names cut.
  const grip = await centreOf(view, "shell-resize-sidebar");
  const width0 = await widthOf(view, "shell-sidebar");
  if (grip && width0) {
    // With text selected all over the page: a press on a divider is a drag of the divider, not of the selection.
    await js(view, `(() => { getSelection()?.selectAllChildren(document.body); return true; })()`);
    await mouse(view, "mouseMove", grip);
    await mouse(view, "mouseDown", grip);
    await mouse(view, "mouseMove", { x: grip.x - (width0 - 200), y: grip.y }, { held: true });
    await mouse(view, "mouseUp", { x: grip.x - (width0 - 200), y: grip.y });
    await waitUntil(view, `Math.abs((document.querySelector('[data-testid="shell-sidebar"]')?.getBoundingClientRect().width ?? 0) - 200) <= 3`, 2000);
    await js(view, `(() => { getSelection()?.removeAllRanges(); return true; })()`);
    const narrow = await homeFacts(view);
    const rows = narrow.groups.flatMap((group) => group.rows);
    const broken = rows.filter((row) => !row.pillWhole).map((row) => row.text);
    const narrowWidth = await widthOf(view, "shell-sidebar");
    detail.narrow = { width: narrowWidth, rows: rows.length, broken };
    if (!near(narrowWidth, 200, 2)) problems.push(`the sidebar dragged to 200 px with text selected is ${narrowWidth} wide`);
    if (broken.length) problems.push(`at 200 px the pill is cut on ${broken.slice(0, 3).join(", ")}`);
    const back = await centreOf(view, "shell-resize-sidebar");
    if (back) {
      await mouse(view, "mouseMove", back);
      await mouse(view, "mouseDown", back);
      await mouse(view, "mouseMove", { x: back.x + (width0 - 200), y: back.y }, { held: true });
      await mouse(view, "mouseUp", { x: back.x + (width0 - 200), y: back.y });
      await waitUntil(view, `Math.abs((document.querySelector('[data-testid="shell-sidebar"]')?.getBoundingClientRect().width ?? 0) - ${width0}) <= 3`, 2000);
    }
  }
  await fold(projectId);
  observe("sidebar-home-list", problems.length === 0, { ...detail, problems });
}

// --------------------------------------------------------------------------------------------------------------------------- sidebar-counts

/**
 * 计划 4.3, AT-124: a comic of 最近 and a material of the project whose files cannot be opened are neither rows nor counted: every "更多 (n)" says what it then
 * brings, no group draws an empty title or a number without rows.
 */
async function walkCounts(env: ShellEnv): Promise<void> {
  const { view, call, observe, projectId, folders } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = { counts: {} as Record<string, string> };
  const counts = detail.counts as Record<string, string>;
  const fs = await import("node:fs");
  const path = await import("node:path");
  // Two resources of the library that are made unopenable on purpose: a comic read once in 最近 and a novel put in the project, whose files then go away.
  const comicFile = path.join(folders.comic, "计数漫画.cbz");
  const novelFile = path.join(folders.novel, "计数小说.txt");
  const comicSource = fs.readdirSync(folders.comic).map((name) => path.join(folders.comic, name)).find((file) => file.endsWith(".cbz") && fs.statSync(file).isFile());
  if (!comicSource) { observe("sidebar-counts", false, { problems: ["no comic archive in the walk's comic folder to copy"] }); return; }
  fs.copyFileSync(comicSource, comicFile);
  fs.writeFileSync(novelFile, `${"计数用的合成文字。".repeat(120)}`);
  await call("library.scan.start", {});
  for (let waited = 0; waited < 30_000; waited += 50) {
    const status = (await call("library.scan.status", {})).value as { running?: unknown } | undefined;
    if (!status?.running) break;
    await sleep(50); // real time: poll library.scan.status until background scan finishes
  }
  type Work = { id: string; title: string; mediaKind: string; lastResource: { id: string } | null };
  const works = ((await call("works.list", { limit: 200 })).value as { items: Work[] }).items;
  const comic = works.find((work) => work.title === "计数漫画");
  const novel = works.find((work) => work.title === "计数小说");
  const firstOf = async (work: Work | undefined) => work?.lastResource?.id ?? ((await call("works.get", { workId: work?.id ?? "" }).catch(() => null))?.value as { resources?: Array<{ id: string }> } | undefined)?.resources?.[0]?.id ?? null;
  const comicId = comic ? await firstOf(comic) : null;
  const novelId = novel ? await firstOf(novel) : null;
  detail.samples = { comic: comicId, novel: novelId };
  if (!comicId || !novelId) { observe("sidebar-counts", false, { ...detail, problems: ["the scan did not make the two works the walk counts with"] }); return; }
  // The comic is opened once in 最近, so 最近 has read it; the novel is a material of the project.
  await toRail(view);
  const comicOpened = await openFromShelf(view, "comic", comicId, 8000) && await waitUntil(view, `document.querySelector('.comic-page[data-state="ready"]')`, 15_000);
  for (let i = 0; i < 40; i += 1) {
    const check = (await call("workspace.sidebar", { view: "home", open: [null] })).value as { groups: Array<{ contextId: string | null; sections: Array<{ items: Array<{ open: { id: string } }> }> }> };
    if (check.groups.some((g) => g.contextId === null && g.sections.some((s) => s.items.some((item) => item.open.id === comicId)))) break;
    await sleep(50); // real time: poll until reader progress write registers comic in recent list
  }
  await closeTabs(view, ["reader"]);
  const material = (await call("project.addMaterial", { projectId, kind: "resource", targetId: novelId }).catch(() => null))?.value as { id?: string } | undefined;
  const ids = [comicId, novelId];
  const before = (await call("workspace.sidebar", { view: "home", open: [projectId, null] })).value as { groups: Array<{ contextId: string | null; sections: Array<{ items: Array<{ open: { id: string } }> }> }> };
  const listedBefore = before.groups.flatMap((group) => group.sections.flatMap((section) => section.items.map((item) => item.open.id))).filter((id) => ids.includes(id));
  detail.before = { comicOpened, material: Boolean(material), listed: listedBefore.length };
  if (listedBefore.length < 2) problems.push(`before their files went, the home listed ${listedBefore.length} of the two resources (the walk's set-up did not take)`);
  fs.rmSync(comicFile, { force: true });
  fs.rmSync(novelFile, { force: true });
  type Section = { type: string; total: number; items: Array<{ open: { id: string } }>; nextCursor: string | null };
  const check = async (name: RailName) => {
    const answer = (await call("workspace.sidebar", { view: name, open: [projectId, null] })).value as { groups: Array<{ contextId: string | null; sections: Section[] }> };
    for (const group of answer.groups) {
      if (group.contextId !== projectId && group.contextId !== null) continue;
      const where = `${name}/${group.contextId === null ? "recent" : "project"}`;
      for (const section of group.sections) {
        let rows = section.items.length;
        if (section.items.some((item) => ids.includes(item.open.id))) problems.push(`${where}: an unopenable resource is listed`);
        let next = section.nextCursor;
        for (let page = 0; next && page < 20; page += 1) {
          const more = (await call("workspace.items", { view: name, contextId: group.contextId, ...(section.type === "all" ? {} : { type: section.type }), limit: 25, cursor: next }).catch(() => null))?.value as { items?: Array<{ open: { id: string } }>; nextCursor?: string | null } | undefined;
          const got = more?.items ?? [];
          if (got.length === 0) { problems.push(`${where}/${section.type}: "更多" brings an empty page`); break; }
          if (got.some((item) => ids.includes(item.open.id))) problems.push(`${where}: "更多" lists an unopenable resource`);
          rows += got.length;
          next = more?.nextCursor ?? null;
        }
        counts[`${where}/${section.type}`] = `${section.total}=${rows}`;
        if (rows !== section.total) problems.push(`${where}/${section.type}: the count is ${section.total}, the rows are ${rows}`);
      }
    }
  };
  for (const name of ["home", "comic", "novel"] as const) await check(name);
  // As drawn: the comic view's 最近 has neither an empty title nor a number without rows.
  await railTo(view, "comic");
  await ensureSidebar(view);
  await waitUntil(view, `document.querySelector('[data-testid="sidebar"][data-view="comic"] [data-testid="context-recent"]') && !document.querySelector('[data-testid="sidebar-loading"]')`, 4000);
  await waitFrames(view, 2);
  const drawnFacts = await js<{ more: string[]; empty: boolean; rows: number; ids: string[] }>(view, `(() => {
    const group = document.querySelector('[data-testid="sidebar"][data-view="comic"] [data-testid="context-recent"]');
    if (!group) return { more: [], empty: false, rows: 0, ids: [] };
    const cells = [...group.querySelectorAll(".sidebar-row, .sidebar-cover")];
    return { more: [...group.querySelectorAll('[data-testid^="sidebar-more-"]')].map((b) => b.textContent ?? ""), empty: Boolean(group.querySelector('[data-testid^="sidebar-empty-"]')), rows: cells.length, ids: cells.map((c) => c.getAttribute("data-testid") ?? "") };
  })()`);
  detail.drawn = { ...drawnFacts, ids: drawnFacts.ids.length };
  if (drawnFacts.ids.some((id) => id.endsWith(comicId))) problems.push("the comic view draws the unopenable comic");
  if (drawnFacts.rows === 0 && !drawnFacts.empty) problems.push("the comic view's 最近 draws neither rows nor that it is empty");
  if (drawnFacts.rows === 0 && drawnFacts.more.length) problems.push("the comic view's 最近 draws \"更多\" with no rows");
  if (material?.id) await call("project.removeMaterial", { projectId, materialId: material.id }).catch(() => null);
  observe("sidebar-counts", problems.length === 0, { ...detail, problems });
}

// ------------------------------------------------------------------------------------------------------------------------- media-view-covers

/**
 * A-105, AT-126: the novel, comic and video views list covers by default (two a row at 260 px), with a placeholder where a work has no cover; 最近 has one
 * cell per work; the switch turns a view to rows and the choice is kept; the card out of the rail shows the same.
 */
async function walkCovers(env: ShellEnv): Promise<void> {
  const { view, call, observe, shot } = env;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const facts = (name: string) => js<{ display: string | null; covers: number; perRow: number; placeholders: number; images: number; keys: string[]; rows: number; width: number }>(view, `(() => {
    const root = document.querySelector('[data-testid="sidebar"][data-view="${name}"]');
    if (!root) return { display: null, covers: 0, perRow: 0, placeholders: 0, images: 0, keys: [], rows: 0, width: 0 };
    const cells = [...root.querySelectorAll(".sidebar-cover")];
    const tops = cells.map((c) => Math.round(c.getBoundingClientRect().top));
    const first = tops.length ? tops[0] : 0;
    return {
      display: root.querySelector('[data-testid="sidebar-display"]')?.getAttribute("data-display") ?? null,
      covers: cells.length, perRow: tops.filter((t) => Math.abs(t - first) <= 2).length,
      placeholders: cells.filter((c) => !c.querySelector("img")).length, images: cells.filter((c) => c.querySelector("img")).length,
      keys: [...root.querySelectorAll('[data-testid="context-recent"] .sidebar-cover')].map((c) => c.getAttribute("data-testid") ?? ""),
      rows: root.querySelectorAll(".sidebar-row").length, width: Math.round(root.getBoundingClientRect().width),
    };
  })()`);
  // 260 px wide, the sidebar's first width.
  const shellNow = await saved(call);
  detail.width = shellNow.sidebar.width;
  for (const name of ["novel", "comic", "video"] as const) {
    await railTo(view, name);
    await ensureSidebar(view);
    if ((await attr(view, "context-toggle-recent", "aria-expanded")) !== "true" && (await attr(view, "context-toggle-recent", "disabled")) === null) await clickTestId(view, "context-toggle-recent");
    await waitUntil(view, `document.querySelector('[data-testid="sidebar"][data-view="${name}"] .sidebar-cover') && !document.querySelector('[data-testid="sidebar-loading"]')`, 6000);
    await waitFrames(view, 2);
    const got = await facts(name);
    // 最近 merged by work: the command's items of 最近 are one per work.
    const answer = (await call("workspace.sidebar", { view: name, open: [null] })).value as { groups: Array<{ contextId: string | null; sections: Array<{ items: Array<{ key: string; open: { workId?: string | null; id: string } }> }> }> };
    const recentItems = answer.groups.find((group) => group.contextId === null)?.sections.flatMap((section) => section.items) ?? [];
    const workIds = recentItems.map((item) => item.open.workId ?? null).filter(Boolean);
    (detail as Record<string, unknown>)[name] = { ...got, recent: recentItems.map((item) => item.key) };
    if (got.display !== "cover") problems.push(`${name}: the view starts as ${got.display}, not covers`);
    if (got.covers === 0) problems.push(`${name}: no cover is drawn`);
    if (got.rows > 0) problems.push(`${name}: rows are drawn in the covers' place`);
    if (got.covers >= 2 && near(shellNow.sidebar.width, 260, 2) && got.perRow !== 2) problems.push(`${name}: ${got.perRow} covers a row at 260 px, not 2`);
    if (new Set(workIds).size !== workIds.length) problems.push(`${name}: 最近 has a work twice`);
    if (recentItems.some((item) => item.open.workId && !item.key.startsWith("work:"))) problems.push(`${name}: a work's item of 最近 is not keyed by its work`);
    if (name === "comic") await shot("media-view-covers");
  }
  // A placeholder where there is no cover: the novels made of text have none.
  const novelFacts = (detail as Record<string, { placeholders: number }>).novel;
  if (novelFacts && novelFacts.placeholders === 0) problems.push("no cover cell shows a placeholder (the text novels have no cover)");
  // The switch: rows, kept after the view is left and in the preferences.
  await railTo(view, "video");
  await ensureSidebar(view);
  await clickTestId(view, "sidebar-display");
  await waitUntil(view, `document.querySelector('[data-testid="sidebar"][data-view="video"] [data-testid="sidebar-display"]')?.getAttribute("data-display") === "list"`, 2000);
  const listed = await facts("video");
  await railTo(view, "comic");
  await railTo(view, "video");
  await waitUntil(view, `document.querySelector('[data-testid="sidebar"][data-view="video"] [data-testid="sidebar-display"]')?.getAttribute("data-display") === "list"`, 2000);
  const kept = await facts("video");
  const stored = (await saved(call)).rail.display;
  detail.switch = { listed: { display: listed.display, rows: listed.rows, covers: listed.covers }, kept: { display: kept.display, rows: kept.rows }, stored };
  if (listed.display !== "list" || listed.covers > 0) problems.push("the switch did not turn the video view to rows");
  if (kept.display !== "list") problems.push("the video view is covers again after it was left");
  if (stored.video !== "list") problems.push(`the preferences keep ${stored.video ?? "nothing"} for the video view`);
  await clickTestId(view, "sidebar-display");
  await waitUntil(view, `document.querySelector('[data-testid="sidebar"][data-view="video"] [data-testid="sidebar-display"]')?.getAttribute("data-display") === "cover"`, 2000);
  // The card of a view that comes out of the rail with the sidebar folded: covers too.
  await clickTestId(view, "shell-sidebar-toggle");
  await waitUntil(view, `!document.querySelector('[data-testid="shell-sidebar"]')`, 2000);
  const comicIcon = await centreOf(view, "nav-comic");
  if (comicIcon) {
    // From a place off the rail, the way a hand comes to an icon (no button is down).
    view.webContents.sendInputEvent({ type: "mouseMove", x: 700, y: 500 });
    await waitFrames(view, 2);
    view.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(comicIcon.x), y: Math.round(comicIcon.y) });
    await waitUntil(view, `document.querySelector('[data-testid="sidebar"][data-variant="card"][data-view="comic"] .sidebar-cover')`, 3000);
    await waitFrames(view, 2);
    const card = await js<{ covers: number; box: Box | null; viewport: { w: number; h: number } }>(view, `(() => {
      const root = document.querySelector('[data-testid="sidebar"][data-variant="card"]');
      const b = root?.getBoundingClientRect();
      return { covers: root ? root.querySelectorAll(".sidebar-cover").length : 0, box: b ? { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom } : null, viewport: { w: innerWidth, h: innerHeight } };
    })()`);
    detail.card = card;
    if (card.covers === 0) problems.push("the card of the comic view shows no covers");
    if (card.box && (card.box.r > card.viewport.w + 1 || card.box.b > card.viewport.h + 1)) problems.push("the card with covers goes out of the window");
    await mouse(view, "mouseMove", { x: 700, y: 500 });
    await waitUntil(view, `!document.querySelector('[data-testid="sidebar"][data-variant="card"]')`, 2000);
  } else problems.push("the comic icon is not on the rail");
  await clickTestId(view, "shell-sidebar-toggle");
  await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="shell-sidebar"]'))`, 2000);
  observe("media-view-covers", problems.length === 0, { ...detail, problems });
}
