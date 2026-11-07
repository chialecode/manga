import type { BrowserWindow } from "electron";
import { clickTestId, pressKey, setField, sleep, waitUntil } from "./driver.ts";
import { js } from "./common.ts";
import { PLAYER_MENU_OBSERVATIONS } from "./player-menus-walk.ts";

/**
 * AT-83 in the real window: the three readers have no bar of their own at the top (the title bar names the work and goes back), a position
 * is typed into where it is shown, the comic turns its pages with the wheel and zooms with Ctrl and the wheel, and the player's arrows step
 * on a tap and keep going while they are held. Inputs go through the window's own input path (trusted keys, mouse buttons and wheel).
 */

export const READER_CONTROL_OBSERVATIONS = ["reader-controls-comic", "reader-controls-player", "reader-controls-novel", ...PLAYER_MENU_OBSERVATIONS] as const;
export type Observe = (name: string, ok: boolean, detail: unknown) => boolean;
type Point = { x: number; y: number };

/** The centre of an element in window coordinates. */
async function centreOf(view: BrowserWindow, testId: string): Promise<Point | null> {
  return js<Point | null>(view, `(() => {
    const el = document.querySelector('[data-testid="${testId}"]');
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
  })()`);
}

/** What the reader has in the place a top bar used to be: nothing but the stage, and the work's name in the title bar. */
const noTopBar = (reader: string, ids: string[], name: string) => `(() => {
  const root = document.querySelector('[data-testid="${reader}"]');
  const gone = ${JSON.stringify(ids)}.filter((id) => document.querySelector('[data-testid="' + id + '"]'));
  const bars = root ? [...root.querySelectorAll("header, .reader-top, .reader-chrome, .comic-header, .video-top")].map((el) => el.className || el.tagName) : ["no reader"];
  const title = document.querySelector('[data-testid="shell-title"]')?.textContent ?? "";
  return { gone, bars, title, named: title.includes(${JSON.stringify(name)}) };
})()`;

/** The page the comic shows, read from its position text ("3 / 5"): an expression for the page, and a call. */
const PAGE_EXPR = String.raw`Number((document.querySelector('[data-testid="comic-position"]')?.textContent ?? "").match(/\d+/)?.[0] ?? 0)`;
const comicPage = (view: BrowserWindow): Promise<number> => js<number>(view, PAGE_EXPR);

export async function walkComicControls(view: BrowserWindow, observe: Observe, name: string): Promise<void> {
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  view.webContents.focus();
  const bars = await js<{ gone: string[]; bars: string[]; title: string; named: boolean }>(view, noTopBar("comic-reader", ["comic-back", "comic-title", "comic-header"], name));
  detail.topBar = bars;
  if (bars.gone.length || bars.bars.length) problems.push(`the reader still has a bar of its own (${[...bars.gone, ...bars.bars].join(", ")})`);
  if (!bars.named) problems.push("the title bar does not name the comic");

  // The position is typed where it is shown.
  const total = await js<number>(view, String.raw`Number((document.querySelector('[data-testid="comic-position"]')?.textContent ?? "").match(/\d+\D+(\d+)/)?.[1] ?? 0)`);
  const target = total >= 3 ? 3 : 2;
  const opened = await clickTestId(view, "comic-position") && await waitUntil(view, `document.querySelector('[data-testid="comic-page-input"]')`, 2000);
  await setField(view, "comic-page-input", String(target));
  await sleep(60);
  await pressKey(view, "Enter");
  const went = await waitUntil(view, `${PAGE_EXPR} === ${target} && !document.querySelector('[data-testid="comic-page-input"]')`, 4000);
  detail.position = { total, target, opened, went };
  if (!opened || !went) problems.push("the page number typed into the position did not go to that page");

  // Escape leaves the field and the reader where it is.
  const before = await comicPage(view);
  await clickTestId(view, "comic-position");
  await setField(view, "comic-page-input", "1");
  await pressKey(view, "Escape");
  await sleep(150);
  const stayed = (await comicPage(view)) === before && await js<boolean>(view, `!document.querySelector('[data-testid="comic-page-input"]')`);
  detail.escape = { stayed };
  if (!stayed) problems.push("Esc did not leave the position field where it was");

  // One turn of the wheel is one page; a second one after a pause is another. Ctrl and the wheel change the size and leave the page.
  await js(view, `window.__smokeWheel = []; document.querySelector('[data-testid="comic-stage"]')?.addEventListener("wheel", (event) => window.__smokeWheel.push({ dy: event.deltaY, ctrl: event.ctrlKey }), { capture: true }); true`);
  const stage = await centreOf(view, "comic-stage");
  if (!stage) problems.push("the stage was not found");
  else {
    const wheel = (deltaY: number, ctrl = false) => view.webContents.sendInputEvent({ type: "mouseWheel", x: stage.x, y: stage.y, deltaX: 0, deltaY, canScroll: true, ...(ctrl ? { modifiers: ["control" as const] } : {}) });
    const start = await comicPage(view);
    wheel(-120);
    const down = await waitUntil(view, `${PAGE_EXPR} !== ${start}`, 3000);
    const afterDown = await comicPage(view);
    await sleep(450);
    wheel(120);
    await sleep(500);
    const afterUp = await comicPage(view);
    const events = await js<Array<{ dy: number; ctrl: boolean }>>(view, `window.__smokeWheel`);
    detail.wheel = { start, afterDown, afterUp, down, events };
    // The sign of a notch depends on the platform's wheel; what matters is one page for one notch, and the opposite notch coming back.
    if (!down || Math.abs(afterDown - start) !== 1) problems.push(`one notch of the wheel moved ${afterDown - start} pages, not one`);
    if (afterUp !== start) problems.push(`the opposite notch did not come back to the page it began at (${start} → ${afterUp})`);

    const zoom0 = await js<string>(view, `document.querySelector('[data-testid="comic-zoom-value"]')?.textContent ?? ""`);
    const pageBefore = await comicPage(view);
    wheel(-120, true);
    await sleep(250);
    const zoom1 = await js<string>(view, `document.querySelector('[data-testid="comic-zoom-value"]')?.textContent ?? ""`);
    const pageAfter = await comicPage(view);
    detail.zoom = { zoom0, zoom1, pageBefore, pageAfter };
    if (zoom1 === zoom0) problems.push("Ctrl and the wheel did not change the size");
    if (pageAfter !== pageBefore) problems.push("Ctrl and the wheel turned the page");
    await clickTestId(view, "comic-zoom-value");
    await sleep(250);
  }
  observe("reader-controls-comic", problems.length === 0, { ...detail, problems });
}

export async function walkPlayerControls(view: BrowserWindow, observe: Observe, name: string): Promise<void> {
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  view.webContents.focus();
  const bars = await js<{ gone: string[]; bars: string[]; title: string; named: boolean }>(view, noTopBar("video-reader", ["video-back", "video-title", "video-episode", "video-next", "video-end-next"], name));
  detail.topBar = bars;
  if (bars.gone.length || bars.bars.length) problems.push(`the player still has a bar of its own (${[...bars.gone, ...bars.bars].join(", ")})`);
  if (!bars.named) problems.push("the title bar does not name the video");

  const stateOf = () => js<{ time: number; paused: boolean; rate: number; duration: number }>(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); return { time: v.currentTime, paused: v.paused, rate: v.playbackRate, duration: v.duration }; })()`);
  // Start still, at the beginning.
  await js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); v.pause(); v.currentTime = 0; return true; })()`);
  await sleep(300);
  const start = await stateOf();
  detail.start = start;

  // A tap is a step: nothing happens while the key is down, and the time moves by the step when it is let go.
  await pressKey(view, "Right", 60);
  await sleep(300);
  const tapped = await stateOf();
  detail.tap = tapped;
  if (!(tapped.time > start.time + 0.4)) problems.push("a tap on → did not step forward");
  if (!tapped.paused || tapped.rate !== start.rate) problems.push("a tap on → started playing or changed the rate");
  await pressKey(view, "Left", 60);
  await sleep(300);
  const back = await stateOf();
  detail.tapBack = back;
  if (!(back.time < tapped.time - 0.4)) problems.push("a tap on ← did not step back");

  // A hold on → plays at the temporary rate while it is down and goes back, still paused, when it is let go; it does not step.
  await js(view, `document.querySelector('[data-testid="video-element"]').currentTime = 0; true`);
  await sleep(200);
  view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
  await sleep(700);
  const holding = await js<{ shown: boolean; rate: number; paused: boolean }>(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); return { shown: Boolean(document.querySelector('[data-testid="video-holding"]')), rate: v.playbackRate, paused: v.paused }; })()`);
  view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
  await sleep(300);
  const released = await stateOf();
  detail.hold = { holding, released };
  if (!holding.shown || holding.paused || !(holding.rate > start.rate)) problems.push("holding → did not play at the temporary rate");
  if (!released.paused || released.rate !== start.rate) problems.push("letting go of → did not go back to the saved rate and to paused");
  if (!(released.time > 0.2) || released.time > 3) problems.push(`holding → moved the time to ${released.time.toFixed(2)} s, which is neither playing nor a step`);

  // A hold on ← rewinds for as long as it is down.
  if (start.duration > 3) {
    const from = Math.max(start.duration - 0.3, 3);
    await js(view, `document.querySelector('[data-testid="video-element"]').currentTime = ${from}; true`);
    await sleep(300);
    const at = (await stateOf()).time;
    view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Left" });
    await sleep(1100);
    const rewinding = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="video-rewinding"]'))`);
    view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Left" });
    await sleep(300);
    const after = await stateOf();
    detail.rewind = { at, after: after.time, rewinding };
    if (!rewinding || !(after.time < at - 1)) problems.push("holding ← did not rewind");
    if (!after.paused) problems.push("letting go of ← started playing a video that was paused");
  } else problems.push("the sample is too short to rewind");

  // The right button opens the menu; a long press does not change the rate.
  const stage = await centreOf(view, "video-stage");
  if (!stage) problems.push("the stage was not found");
  else {
    const rateBefore = (await stateOf()).rate;
    view.webContents.sendInputEvent({ type: "mouseMove", x: stage.x, y: stage.y });
    view.webContents.sendInputEvent({ type: "mouseDown", x: stage.x, y: stage.y, button: "right", clickCount: 1 });
    await sleep(800);
    const during = await js<{ rate: number; holding: boolean }>(view, `(() => ({ rate: document.querySelector('[data-testid="video-element"]').playbackRate, holding: Boolean(document.querySelector('[data-testid="video-holding"]')) }))()`);
    view.webContents.sendInputEvent({ type: "mouseUp", x: stage.x, y: stage.y, button: "right", clickCount: 1 });
    const menu = await waitUntil(view, `document.querySelector('[data-testid="video-context"]')`, 2500);
    const afterRate = (await stateOf()).rate;
    detail.rightButton = { during, menu, rateBefore, afterRate };
    if (!menu) problems.push("the right button did not open the menu");
    if (during.rate !== rateBefore || during.holding || afterRate !== rateBefore) problems.push("a long press of the right button changed the rate");
    await pressKey(view, "Escape");
    await sleep(150);
    if (await js<boolean>(view, `Boolean(document.querySelector('[data-testid="video-context"]'))`)) await clickTestId(view, "video-stage");
  }
  observe("reader-controls-player", problems.length === 0, { ...detail, problems });
}

export async function walkNovelControls(view: BrowserWindow, observe: Observe, name: string): Promise<void> {
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const bars = await js<{ gone: string[]; bars: string[]; title: string; named: boolean }>(view, noTopBar("reading-page", ["reading-title", "reading-back", "reading-chrome", "reading-prev", "reading-next"], name));
  detail.topBar = bars;
  if (bars.gone.length || bars.bars.length) problems.push(`the reader still has a bar of its own (${[...bars.gone, ...bars.bars].join(", ")})`);
  if (!bars.named) problems.push("the title bar does not name the book");
  const foot = await js<{ inFooter: string[]; outside: string[] }>(view, `(() => {
    const footer = document.querySelector('[data-testid="reading-footer"]');
    const wanted = ["reading-panel-toc", "reading-panel-search", "reading-panel-bookmarks", "reading-bookmark-add", "reading-fullscreen", "reading-settings"];
    return { inFooter: wanted.filter((id) => footer && footer.querySelector('[data-testid="' + id + '"]')), outside: wanted.filter((id) => !(footer && footer.querySelector('[data-testid="' + id + '"]'))) };
  })()`);
  detail.footer = foot;
  if (foot.outside.length) problems.push(`the bottom bar lacks ${foot.outside.join(", ")}`);
  observe("reader-controls-novel", problems.length === 0, { ...detail, problems });
}
