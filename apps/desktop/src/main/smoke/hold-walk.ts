import type { BrowserWindow } from "electron";
import { clickTestId, sleep, waitUntil } from "./driver.ts";
import { js } from "./common.ts";
import { realClick } from "./player-menus-walk.ts";
import type { Observe } from "./reader-controls-walk.ts";

/**
 * The arrow keys of the player in the real window (A-112, AT-134, AT-135, 计划 4.12). In window full screen a held → plays at the temporary rate with only its hint
 * on the picture: the bar never comes while the key is down (it is sampled every 100 ms), a bar that was showing fades, a bar with the pointer on it stays, and after
 * the hold the bar stays away; a tap steps once and shows the bar when the key goes up; a held ← is the same. Then three sequences that used to leave a hold without
 * effect, sent through the DevTools protocol so the repeat flag is the keyboard's: a key-up that never came, a hold whose first press went to a menu, and a change
 * of the video's source in the middle of a hold. Each hold reaches the temporary rate within the hold time and gives it back when the key goes up.
 */

export const HOLD_OBSERVATIONS = ["hold-rate-hint-only", "hold-rate-recovers"] as const;

type Player = { time: number; rate: number; paused: boolean; holding: boolean; rewinding: boolean; idle: boolean; duration: number };

const playerOf = (view: BrowserWindow) => js<Player>(view, `(() => {
  const v = document.querySelector('[data-testid="video-element"]');
  return {
    time: v.currentTime, rate: v.playbackRate, paused: v.paused, duration: v.duration,
    holding: Boolean(document.querySelector('[data-testid="video-holding"]')),
    rewinding: Boolean(document.querySelector('[data-testid="video-rewinding"]')),
    idle: Boolean(document.querySelector('[data-testid="video-shell"]')?.hasAttribute("data-idle")),
  };
})()`);

/** Every 100 ms the page notes whether the bar is shown; `stop` gives the samples taken since `start`. */
const barSampler = (view: BrowserWindow) => ({
  start: () => js(view, `(() => { clearInterval(window.__barTimer); window.__barSeen = []; window.__barTimer = setInterval(() => window.__barSeen.push(!document.querySelector('[data-testid="video-shell"]')?.hasAttribute("data-idle")), 100); return true; })()`),
  stop: () => js<boolean[]>(view, `(() => { clearInterval(window.__barTimer); return window.__barSeen ?? []; })()`),
});

const keyDown = (view: BrowserWindow, keyCode: "Right" | "Left") => { view.webContents.focus(); view.webContents.sendInputEvent({ type: "keyDown", keyCode }); };
const keyUp = (view: BrowserWindow, keyCode: "Right" | "Left") => view.webContents.sendInputEvent({ type: "keyUp", keyCode });
const idle = (view: BrowserWindow, ms = 6000) => waitUntil(view, `document.querySelector('[data-testid="video-shell"]')?.hasAttribute("data-idle")`, ms);
const shown = (view: BrowserWindow, ms = 1500) => waitUntil(view, `!document.querySelector('[data-testid="video-shell"]')?.hasAttribute("data-idle")`, ms);

async function pointerAt(view: BrowserWindow, where: "middle" | "bar"): Promise<void> {
  const point = await js<{ x: number; y: number } | null>(view, `(() => {
    const el = document.querySelector(${JSON.stringify(where === "bar" ? '[data-testid="video-controls"]' : '[data-testid="video-stage"]')});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(${where === "bar" ? "b.top + b.height / 2" : "b.top + b.height * 0.4"}) };
  })()`);
  if (point) view.webContents.sendInputEvent({ type: "mouseMove", x: point.x + Math.round(Math.random() * 6), y: point.y });
  await sleep(120);
}

export async function walkHoldKeys(view: BrowserWindow, observe: Observe): Promise<void> {
  await walkHintOnly(view, observe);
  await walkRecovers(view, observe);
}

async function walkHintOnly(view: BrowserWindow, observe: Observe): Promise<void> {
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const sampler = barSampler(view);
  const base = (await playerOf(view)).rate;
  if (!(await realClick(view, "video-window-fullscreen")) || !(await waitUntil(view, `document.querySelector('[data-testid="video-reader"]')?.hasAttribute("data-window-full")`, 4000))) {
    observe("hold-rate-hint-only", false, { problems: ["window full screen did not start"] });
    return;
  }
  try {
    await js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); v.muted = true; v.currentTime = 1; return v.play().then(() => true, () => false); })()`);
    await pointerAt(view, "middle");
    if (!(await idle(view))) problems.push("the bar did not fade while the video played");

    // A hold of → with the bar gone: the rate and the hint, and never the bar.
    await sampler.start();
    keyDown(view, "Right");
    await sleep(900);
    const during = await playerOf(view);
    keyUp(view, "Right");
    await sleep(300);
    const after = await playerOf(view);
    await sleep(500);
    const seen = await sampler.stop();
    detail.hold = { during: { rate: during.rate, holding: during.holding }, after: { rate: after.rate, holding: after.holding }, samples: seen.length, barSeen: seen.filter(Boolean).length };
    if (!during.holding || during.rate !== 2) problems.push(`holding → in window full screen: rate ${during.rate}, hint ${during.holding}`);
    if (after.rate !== base || after.holding) problems.push(`letting go of → left the rate at ${after.rate} (it was ${base}) or the hint on`);
    if (seen.length < 12 || seen.some(Boolean)) problems.push(`the bar showed in ${seen.filter(Boolean).length} of ${seen.length} samples during and after the hold`);

    // The bar is showing (the pointer moved): a hold fades it; with the pointer on the bar it stays.
    await pointerAt(view, "middle");
    const woke = await shown(view);
    keyDown(view, "Right");
    const faded = await idle(view, 800);
    keyUp(view, "Right");
    await sleep(300);
    await pointerAt(view, "bar");
    const onBar = await shown(view);
    keyDown(view, "Right");
    await sleep(800);
    const keptOnBar = !(await playerOf(view)).idle;
    keyUp(view, "Right");
    await sleep(300);
    detail.showing = { woke, faded, onBar, keptOnBar };
    if (!woke) problems.push("moving the pointer did not bring the bar back");
    if (!faded) problems.push("holding → did not fade the bar that was showing");
    if (!onBar || !keptOnBar) problems.push("holding → faded the bar although the pointer was on it");

    // A tap: one step, and the bar when the key goes up.
    await pointerAt(view, "middle");
    await idle(view);
    const before = await playerOf(view);
    keyDown(view, "Right");
    await sleep(60);
    const downIdle = (await playerOf(view)).idle;
    keyUp(view, "Right");
    await sleep(200);
    const tapped = await playerOf(view);
    const step = tapped.time - before.time;
    detail.tap = { from: Number(before.time.toFixed(2)), step: Number(step.toFixed(2)), downIdle, upIdle: tapped.idle };
    if (step < 4.5 || step > 6.5) problems.push(`a tap on → moved ${step.toFixed(2)} s, not one step of 5 s`);
    if (!downIdle) problems.push("the bar came while → was down for a tap");
    if (tapped.idle) problems.push("the bar did not come when the tapped key went up");

    // A hold of ←: rewinding, and never the bar.
    await idle(view);
    await sampler.start();
    keyDown(view, "Left");
    await sleep(1100);
    const rewinding = (await playerOf(view)).rewinding;
    keyUp(view, "Left");
    await sleep(500);
    const leftSeen = await sampler.stop();
    detail.rewind = { rewinding, samples: leftSeen.length, barSeen: leftSeen.filter(Boolean).length };
    if (!rewinding) problems.push("holding ← in window full screen did not rewind");
    if (leftSeen.length < 12 || leftSeen.some(Boolean)) problems.push(`the bar showed in ${leftSeen.filter(Boolean).length} of ${leftSeen.length} samples while ← was held`);
  } finally {
    await js(view, `document.querySelector('[data-testid="video-element"]').pause(); true`);
    await pointerAt(view, "bar");
    await shown(view);
    await realClick(view, "video-window-fullscreen");
    await waitUntil(view, `!document.querySelector('[data-testid="video-reader"]')?.hasAttribute("data-window-full")`, 4000);
    await sleep(300);
  }
  observe("hold-rate-hint-only", problems.length === 0, { ...detail, problems });
}

async function walkRecovers(view: BrowserWindow, observe: Observe): Promise<void> {
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const debug = view.webContents.debugger;
  const wasAttached = debug.isAttached();
  const base = (await playerOf(view)).rate;
  /** The temporary rate within the hold time (300 ms) and a margin for the page's timers. */
  const reached = () => waitUntil(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); return v.playbackRate === 2 && Boolean(document.querySelector('[data-testid="video-holding"]')); })()`, 450);
  const restored = () => waitUntil(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); return v.playbackRate === ${base} && !document.querySelector('[data-testid="video-holding"]'); })()`, 600);
  try {
    if (!wasAttached) debug.attach("1.3");
    const send = (type: "rawKeyDown" | "keyUp", repeat = false) => debug.sendCommand("Input.dispatchKeyEvent", { type, key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, autoRepeat: repeat });
    const repeats = async (ms: number) => { for (let at = 0; at < ms; at += 33) { await send("rawKeyDown", true); await sleep(33); } };
    view.webContents.focus();
    await js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); v.pause(); v.currentTime = 2; return true; })()`);
    await sleep(300);

    // 1. Down, held, and the key-up never comes; then down again (not a repeat) and held: the old hold ends without a step, the new one takes the rate.
    const start = (await playerOf(view)).time;
    await send("rawKeyDown");
    const firstHold = await reached();
    await sleep(300);
    await send("rawKeyDown");
    const secondHold = await reached();
    await sleep(400);
    await send("keyUp");
    const firstBack = await restored();
    await sleep(200);
    const end = await playerOf(view);
    const moved = end.time - start;
    detail.lostKeyUp = { firstHold, secondHold, firstBack, moved: Number(moved.toFixed(2)), paused: end.paused };
    if (!firstHold || !secondHold) problems.push(`a key-up that never came: the first hold reached the rate ${firstHold}, the next one ${secondHold}`);
    if (!firstBack) problems.push("after the lost key-up, letting go did not give the rate back");
    if (moved < 0.2 || moved > 4) problems.push(`the lost key-up moved the video ${moved.toFixed(2)} s, which is a step and not a hold`);
    if (!end.paused) problems.push("after the holds the video that was paused is playing");

    // 2. The first press goes to an open menu (the player leaves it alone); the menu closes, and only the repeats of the held key arrive: the hold starts at once.
    // The page's own click opens the menu when the hand's click does not reach it (the pointer may still be captured by the protocol's key events).
    const menuOpen = () => waitUntil(view, `document.querySelector('[role="menu"]')`, 1500);
    // A narrow bar hands its menus to the "…" panel, so the rate menu is reached the way a person reaches it there.
    const inPanel = !(await js<boolean>(view, `Boolean(document.querySelector('[data-testid="video-rate"]'))`));
    if (inPanel) { await clickTestId(view, "video-more", 3000); await waitUntil(view, `document.querySelector('[data-testid="video-rate"]')`, 2000); }
    let menu = await realClick(view, "video-rate") && await menuOpen();
    if (!menu) menu = await js<boolean>(view, `(() => { const b = document.querySelector('[data-testid="video-rate"]'); if (!b) return false; b.click(); return true; })()`) && await menuOpen();
    detail.rateButton = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="video-rate"]'))`);
    await send("rawKeyDown");
    await sleep(100);
    view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    const menuClosed = await waitUntil(view, `!document.querySelector('[role="menu"]')`, 2000);
    const repeating = repeats(600);
    const fromRepeats = await reached();
    await repeating;
    await send("keyUp");
    const secondBack = await restored();
    if (inPanel && await js<boolean>(view, `document.querySelector('[data-testid="video-more"]')?.getAttribute("aria-expanded") === "true"`)) await clickTestId(view, "video-more", 2000);
    detail.repeatsOnly = { menu, menuClosed, inPanel, fromRepeats, secondBack };
    if (!menu || !menuClosed) problems.push("the rate menu could not be opened and closed for the walk");
    if (!fromRepeats) problems.push("a hold whose first press went to the menu did not reach the rate from its repeats");
    if (!secondBack) problems.push("after a hold made of repeats, letting go did not give the rate back");

    // 3. The source of the video changes in the middle of a hold (the element is loaded again): the rate is the temporary one after it, and the base one after the hold.
    await send("rawKeyDown");
    const thirdHold = await reached();
    await js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); const at = v.currentTime; v.load(); v.addEventListener("loadedmetadata", () => { v.currentTime = at; }, { once: true }); return true; })()`);
    const reloaded = await waitUntil(view, `document.querySelector('[data-testid="video-element"]').readyState >= 1`, 6000);
    await sleep(300);
    const afterLoad = await playerOf(view);
    await send("keyUp");
    const thirdBack = await restored();
    detail.sourceChange = { thirdHold, reloaded, rateAfterLoad: afterLoad.rate, holding: afterLoad.holding, thirdBack };
    if (!thirdHold) problems.push("the hold before the change of source did not reach the rate");
    if (!reloaded || afterLoad.rate !== 2 || !afterLoad.holding) problems.push(`after the change of source in the middle of a hold the rate is ${afterLoad.rate} (hint ${afterLoad.holding})`);
    if (!thirdBack) problems.push("after the change of source, letting go did not give the rate back");
  } catch (error) {
    problems.push(`the walk stopped: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (!wasAttached && debug.isAttached()) debug.detach();
    await js(view, `document.querySelector('[data-testid="video-element"]').pause(); true`);
    await waitUntil(view, `document.querySelector('[data-testid="video-element"]').readyState >= 2`, 6000);
  }
  observe("hold-rate-recovers", problems.length === 0, { ...detail, problems });
}
