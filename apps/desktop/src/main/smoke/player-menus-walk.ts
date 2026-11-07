import type { BrowserWindow } from "electron";
import { pressKey, sleep, waitUntil } from "./driver.ts";
import { js } from "./common.ts";
import type { Observe } from "./reader-controls-walk.ts";

/**
 * AT-89 in the real window. The player's menus open on the top layer, and a menu that is "in the page" is not the same as a menu a person can
 * click: so every item of every menu is hit-tested at its centre (what the browser says is under that point is the item itself), in the ordinary
 * window and in screen full screen. The volume is a button with a slider that pops up; the wheel over it turns the volume by five percent. In
 * screen full screen the controls float over the picture: the picture keeps its size whether they show or not.
 */

export const PLAYER_MENU_OBSERVATIONS = ["player-menus", "player-fullscreen-bar"] as const;

type Point = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };
export type PopupReport = { found: boolean; topLayer: boolean; box: Box | null; viewport: { w: number; h: number }; items: Array<{ id: string; hit: boolean; inView: boolean }> };

export const centreOf = (view: BrowserWindow, testId: string) => js<Point | null>(view, `(() => {
  const el = document.querySelector('[data-testid="${testId}"]');
  if (!el) return null;
  const box = el.getBoundingClientRect();
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
})()`);

/** A real mouse click on an element: the pointer goes there first (which also brings back floating controls), then down and up. */
export async function realClick(view: BrowserWindow, testId: string): Promise<boolean> {
  view.webContents.focus();
  const at = await centreOf(view, testId);
  if (!at) return false;
  view.webContents.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y });
  await sleep(120);
  view.webContents.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
  view.webContents.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await sleep(200);
  return true;
}

/** What the open popup is: is it on the top layer, inside the window, and is every item the thing under its own centre. */
export async function hitTestOpenPopup(view: BrowserWindow, selector = '.popup[role="menu"]'): Promise<PopupReport> {
  return js<PopupReport>(view, `(() => {
    const pop = document.querySelector(${JSON.stringify(selector)});
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    if (!pop) return { found: false, topLayer: false, box: null, viewport, items: [] };
    const r = pop.getBoundingClientRect();
    let topLayer = false;
    try { topLayer = pop.matches(":popover-open"); } catch { topLayer = false; }
    const items = [...pop.querySelectorAll('[role="menuitem"], [role="menuitemradio"], input, button')].map((el) => {
      const b = el.getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { id: el.getAttribute("data-testid") ?? el.tagName, hit: hit === el || el.contains(hit), inView: b.left >= -0.5 && b.top >= -0.5 && b.right <= viewport.w + 0.5 && b.bottom <= viewport.h + 0.5 };
    });
    return { found: true, topLayer, box: { x: r.x, y: r.y, w: r.width, h: r.height }, viewport, items };
  })()`);
}

const complaints = (name: string, report: PopupReport): string[] => {
  if (!report.found) return [`${name}: the menu did not open`];
  const out: string[] = [];
  if (!report.topLayer) out.push(`${name}: the menu is not on the top layer`);
  if (report.items.length === 0) out.push(`${name}: the menu has no items`);
  const unreachable = report.items.filter((item) => !item.hit).map((item) => item.id);
  if (unreachable.length) out.push(`${name}: clicking the centre of ${unreachable.join(", ")} reaches something else`);
  const cut = report.items.filter((item) => !item.inView).map((item) => item.id);
  if (cut.length) out.push(`${name}: ${cut.join(", ")} lie outside the window`);
  return out;
};

type Walk = { problems: string[]; detail: Record<string, unknown>; shot?: (name: string) => Promise<void>; prefix: string };

/** Open a menu with a real click, hit-test it, pick an item with a real click, and tell if the menu closed. */
async function walkMenu(view: BrowserWindow, walk: Walk, trigger: string, pick: string | null): Promise<boolean> {
  if (!await realClick(view, trigger)) { walk.detail[trigger] = "absent"; return false; }
  await waitUntil(view, `document.querySelector('.popup[role="menu"]')`, 2000);
  await sleep(120);
  const report = await hitTestOpenPopup(view);
  walk.detail[trigger] = { items: report.items.length, topLayer: report.topLayer, box: report.box };
  walk.problems.push(...complaints(trigger, report));
  if (walk.shot && report.found && trigger === "video-rate") await walk.shot(`${walk.prefix}-rate-menu`);
  if (pick && report.found) {
    await realClick(view, pick);
    const closed = await waitUntil(view, `!document.querySelector('.popup[role="menu"]')`, 2000);
    if (!closed) walk.problems.push(`${trigger}: picking ${pick} did not close the menu`);
  } else if (report.found) {
    await pressKey(view, "Escape");
    await sleep(150);
  }
  return true;
}

const stateOf = (view: BrowserWindow) => js<{ rate: number; volumeText: string | null; paused: boolean }>(view, `(() => {
  const video = document.querySelector('[data-testid="video-element"]');
  return { rate: video ? video.playbackRate : 0, volumeText: document.querySelector('[data-testid="video-volume-value"]')?.textContent ?? null, paused: video ? video.paused : true };
})()`);

/** The volume button, its slider popup on the top layer, the wheel over the button, and Esc. */
async function walkVolume(view: BrowserWindow, walk: Walk, closeWith: "escape" | "click"): Promise<void> {
  if (!await realClick(view, "video-volume-button")) { walk.problems.push("the volume button was not found"); return; }
  await waitUntil(view, `document.querySelector('[data-testid="video-volume-pop"]')`, 2000);
  await sleep(150);
  const report = await hitTestOpenPopup(view, '[data-testid="video-volume-pop"]');
  walk.detail.volume = { items: report.items.length, topLayer: report.topLayer, box: report.box };
  walk.problems.push(...complaints("the volume popup", report));
  if (walk.shot) await walk.shot(`${walk.prefix}-volume`);
  const upright = await js<boolean>(view, `(() => { const r = document.querySelector('[data-testid="video-volume"]')?.getBoundingClientRect(); return Boolean(r) && r.height > r.width * 3; })()`);
  if (!upright) walk.problems.push("the volume slider is not upright");
  // The wheel over the button turns the volume by five percent a notch, up and down.
  const button = await centreOf(view, "video-volume-button");
  const before = Number((await stateOf(view)).volumeText);
  if (button && Number.isFinite(before)) {
    // The input path counts a wheel the other way round from the page's `deltaY`: +120 here is a notch up.
    view.webContents.sendInputEvent({ type: "mouseWheel", x: button.x, y: button.y, deltaX: 0, deltaY: 120, canScroll: true });
    await sleep(350);
    const up = Number((await stateOf(view)).volumeText);
    view.webContents.sendInputEvent({ type: "mouseWheel", x: button.x, y: button.y, deltaX: 0, deltaY: -120, canScroll: true });
    await sleep(350);
    const down = Number((await stateOf(view)).volumeText);
    walk.detail.wheel = { before, up, down };
    if (!(up === Math.min(100, before + 5))) walk.problems.push(`the wheel up moved the volume from ${before} to ${up}, not by 5`);
    if (!(down === up - 5 || (up === 100 && down === 95))) walk.problems.push(`the wheel down moved the volume from ${up} to ${down}, not by 5`);
  } else walk.problems.push("the volume could not be read for the wheel");
  // Esc closes it in the window; in screen full screen Esc belongs to the browser (it leaves full screen), so a click outside closes it there.
  if (closeWith === "escape") await pressKey(view, "Escape");
  else {
    const away = await centreOf(view, "video-stage");
    if (away) {
      view.webContents.sendInputEvent({ type: "mouseDown", x: away.x, y: Math.round(away.y / 2), button: "left", clickCount: 1 });
      view.webContents.sendInputEvent({ type: "mouseUp", x: away.x, y: Math.round(away.y / 2), button: "left", clickCount: 1 });
    }
  }
  const closed = await waitUntil(view, `!document.querySelector('[data-testid="video-volume-pop"]')`, 2000);
  if (!closed) walk.problems.push(closeWith === "escape" ? "Esc did not close the volume popup" : "a click outside did not close the volume popup");
  // A click on the stage toggles playing; the walk wants the picture still.
  await js(view, `document.querySelector('[data-testid="video-element"]').pause(); true`);
}

/** The menus of the bar, in the ordinary window. */
export async function walkPlayerMenus(view: BrowserWindow, observe: Observe, shot?: (name: string) => Promise<void>): Promise<void> {
  const walk: Walk = { problems: [], detail: {}, prefix: "player", ...(shot ? { shot } : {}) };
  view.webContents.focus();
  // Still, at the start, so a picked rate is the only thing that changes the element.
  await js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); v.pause(); v.currentTime = 0; return true; })()`);
  // The bar's menus are in the bar when it is wide and in the "…" panel when it is narrow: open the panel when the button is not there.
  const inBar = await centreOf(view, "video-rate");
  if (!inBar) await realClick(view, "video-more");
  // The subtitle and rate menus are always on the bar. This sample has one file and one audio track, so the episode and audio menus are absent
  // here; the media phase opens a folder of episodes and a file with two audio tracks and hit-tests those two (menus:episodes-audio).
  if (!await walkMenu(view, walk, "video-subtitles", "video-subtitles-off")) walk.problems.push("the bar has no subtitle menu");
  await walkMenu(view, walk, "video-audio", null);
  await walkMenu(view, walk, "video-episodes", null);
  if (!await walkMenu(view, walk, "video-rate", "video-rate-1_5")) walk.problems.push("the bar has no rate menu");
  await sleep(500);
  const picked = await stateOf(view);
  walk.detail.rate = picked.rate;
  if (picked.rate !== 1.5) walk.problems.push(`picking 1.5× from the rate menu left the rate at ${picked.rate}`);
  await walkMenu(view, walk, "video-rate", "video-rate-1");
  await sleep(300);
  if ((await stateOf(view)).rate !== 1) walk.problems.push("picking 1× did not put the rate back");
  await walkVolume(view, walk, "escape");
  // The right button's menu is inside the stage; it must be reachable too.
  const stage = await centreOf(view, "video-stage");
  if (stage) {
    view.webContents.sendInputEvent({ type: "mouseMove", x: stage.x, y: stage.y });
    view.webContents.sendInputEvent({ type: "mouseDown", x: stage.x, y: stage.y, button: "right", clickCount: 1 });
    view.webContents.sendInputEvent({ type: "mouseUp", x: stage.x, y: stage.y, button: "right", clickCount: 1 });
    await waitUntil(view, `document.querySelector('[data-testid="video-context"]')`, 2000);
    const context = await hitTestOpenPopup(view, '[data-testid="video-context"]');
    walk.detail.context = { items: context.items.length, box: context.box };
    if (!context.found) walk.problems.push("the right button did not open the menu");
    else {
      const bad = context.items.filter((item) => !item.hit || !item.inView).map((item) => item.id);
      if (bad.length) walk.problems.push(`the right-button menu items ${bad.join(", ")} cannot be reached`);
    }
    await pressKey(view, "Escape");
    await sleep(150);
  }
  // The "…" panel, if this walk opened it.
  if (!inBar && await js<boolean>(view, `Boolean(document.querySelector('[data-testid="video-more-panel"]'))`)) await realClick(view, "video-more");
  observe("player-menus", walk.problems.length === 0, { ...walk.detail, problems: walk.problems });
}

const pictureOf = (view: BrowserWindow) => js<{ video: Box | null; stage: Box | null; shell: string | null; idle: boolean; barShown: boolean }>(view, `(() => {
  const box = (id) => { const el = document.querySelector('[data-testid="' + id + '"]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
  const shell = document.querySelector('[data-testid="video-shell"]');
  const controls = document.querySelector('[data-testid="video-controls"]');
  return { video: box("video-element"), stage: box("video-stage"), shell: shell?.getAttribute("data-full") ?? null, idle: shell?.hasAttribute("data-idle") ?? false, barShown: Boolean(controls) && getComputedStyle(controls).opacity === "1" };
})()`);

const sameBox = (a: Box | null, b: Box | null, tolerance = 1) => Boolean(a && b) && Math.abs(a!.x - b!.x) <= tolerance && Math.abs(a!.y - b!.y) <= tolerance && Math.abs(a!.w - b!.w) <= tolerance && Math.abs(a!.h - b!.h) <= tolerance;

/** Screen full screen: the picture fills the screen and keeps its size while the glass bar shows and hides; the menus still open above it. */
export async function walkPlayerFullscreen(view: BrowserWindow, observe: Observe, shot?: (name: string) => Promise<void>): Promise<void> {
  const walk: Walk = { problems: [], detail: {}, prefix: "player-fullscreen", ...(shot ? { shot } : {}) };
  view.webContents.focus();
  const wasFull = view.isFullScreen();
  if (!await realClick(view, "video-fullscreen")) { observe("player-fullscreen-bar", false, { problems: ["the full screen button was not found"] }); return; }
  const entered = await waitUntil(view, `document.fullscreenElement !== null`, 4000);
  if (!entered) { observe("player-fullscreen-bar", false, { problems: ["screen full screen did not start"] }); return; }
  await sleep(700);
  try {
    const viewport = await js<{ w: number; h: number }>(view, `({ w: window.innerWidth, h: window.innerHeight })`);
    // The bar is shown now. Play so that it can fade, and read the picture with it shown and with it hidden.
    await js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); v.muted = true; return v.play().then(() => true, () => false); })()`);
    await sleep(500);
    view.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(viewport.w / 2), y: Math.round(viewport.h / 2) });
    await sleep(300);
    const shown = await pictureOf(view);
    const faded = await waitUntil(view, `document.querySelector('[data-testid="video-shell"]')?.hasAttribute("data-idle")`, 6000);
    await sleep(350);
    const hidden = await pictureOf(view);
    view.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(viewport.w / 2) + 7, y: Math.round(viewport.h / 2) + 5 });
    await sleep(500);
    const back = await pictureOf(view);
    walk.detail.picture = { viewport, shown: shown.video, hidden: hidden.video, back: back.video, faded };
    if (!shown.video || !near(shown.video.w, viewport.w, 1) || !near(shown.video.h, viewport.h, 1)) walk.problems.push(`the picture does not fill the screen (${JSON.stringify(shown.video)} of ${viewport.w}x${viewport.h})`);
    if (!faded) walk.problems.push("the bar did not hide after the pointer stopped");
    if (!sameBox(shown.video, hidden.video)) walk.problems.push(`the picture changed size when the bar hid (${JSON.stringify(shown.video)} → ${JSON.stringify(hidden.video)})`);
    if (!sameBox(shown.video, back.video)) walk.problems.push(`the picture changed size when the bar came back (${JSON.stringify(shown.video)} → ${JSON.stringify(back.video)})`);
    if (back.idle) walk.problems.push("moving the pointer did not bring the bar back");
    // The bar is glass over the picture: it lies inside the stage and does not push the stage's edge up.
    const overlay = await js<boolean>(view, `(() => { const bar = document.querySelector('[data-testid="video-controls"]'); const stage = document.querySelector('[data-testid="video-stage"]'); if (!bar || !stage) return false; const a = bar.getBoundingClientRect(); const s = stage.getBoundingClientRect(); return getComputedStyle(bar).position === "absolute" && a.bottom <= s.bottom + 1 && a.top >= s.top; })()`);
    if (!overlay) walk.problems.push("the bar does not float over the picture");
    if (shot) await shot("player-fullscreen-bar");
    await js(view, `document.querySelector('[data-testid="video-element"]').pause(); true`);
    await sleep(200);
    view.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(viewport.w / 2), y: Math.round(viewport.h) - 30 });
    await sleep(300);
    // The menus open above the bar in screen full screen too, and every item is reachable there.
    await walkMenu(view, walk, "video-subtitles", "video-subtitles-off");
    await walkMenu(view, walk, "video-rate", "video-rate-1");
    await walkVolume(view, walk, "click");
  } finally {
    view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await waitUntil(view, `document.fullscreenElement === null`, 3000);
    if (view.isFullScreen() !== wasFull) { await realClick(view, "video-fullscreen"); await waitUntil(view, `document.fullscreenElement === null`, 3000); }
    await sleep(400);
  }
  observe("player-fullscreen-bar", walk.problems.length === 0, { ...walk.detail, problems: walk.problems });
}

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
