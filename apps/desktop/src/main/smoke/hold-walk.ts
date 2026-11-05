import type { BrowserWindow } from "electron";
import { clickTestId, sleep, waitFrames, waitUntil } from "./driver.ts";
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

/**
 * LOOP-27: whether a hold reached the temporary rate in time is judged by the page's own clock, not by how long the walk waited. The page notes
 * when → goes down and up (`performance.now()` in its key handlers, capture phase) and every change of the player's state ("in": rate 2 with the
 * hint; "out": the base rate without it); `stateAt` reads the state at a time. The walk waits as long as it likes for the result to appear; the
 * conditions (the rate within 450 ms of the press, back within 600 ms of the release; in the full-screen hold, the rate at 900 ms and back at 300 ms)
 * are the ones the walk had before.
 */
const holdClock = (base: number) => `(() => {
  if (window.__holdClock) { window.__holdClock.base = ${base}; return true; }
  const clock = { base: ${base}, keys: [], states: [] };
  const video = () => document.querySelector('[data-testid="video-element"]');
  const state = () => {
    const v = video();
    if (!v) return "other";
    const hint = Boolean(document.querySelector('[data-testid="video-holding"]'));
    return v.playbackRate === 2 && hint ? "in" : v.playbackRate === clock.base && !hint ? "out" : "other";
  };
  const note = () => { const now = state(); if (clock.states.at(-1)?.s !== now) clock.states.push({ s: now, t: performance.now() }); };
  clock.states.push({ s: state(), t: performance.now() });
  window.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") clock.keys.push({ k: "down", repeat: e.repeat, t: performance.now() }); }, true);
  window.addEventListener("keyup", (e) => { if (e.key === "ArrowRight") clock.keys.push({ k: "up", t: performance.now() }); }, true);
  document.addEventListener("ratechange", note, true);
  new MutationObserver(note).observe(document.body, { childList: true, subtree: true });
  const poll = () => { note(); requestAnimationFrame(poll); };
  requestAnimationFrame(poll);
  clock.stateAt = (t) => { let at = "other"; for (const entry of clock.states) { if (entry.t <= t) at = entry.s; else break; } return at; };
  window.__holdClock = clock;
  return true;
})()`;
type KeyMark = { k: "down" | "up"; repeat?: boolean; t: number };
/** The page's time now: the next key of the walk comes after it. */
const pageNow = (view: BrowserWindow) => js<number>(view, "performance.now()");
const keyAfter = (view: BrowserWindow, mark: number, kind: "down" | "up") => js<KeyMark | null>(view, `(window.__holdClock?.keys ?? []).find((e) => e.k === "${kind}" && e.t > ${mark}) ?? null`);

/**
 * The first → event of `kind` the page saw after `mark`; once the page's clock is past it by `within` (the walk waits up to `waitMs` for that), whether
 * the player was `expected` at that moment by the page's own record, and how long after the key it got there (page clock).
 */
async function byPageClock(view: BrowserWindow, mark: number, kind: "down" | "up", expected: "in" | "out", within: number, waitMs = 4000): Promise<{ ok: boolean; ms: number | null }> {
  await waitUntil(view, `(window.__holdClock?.keys ?? []).some((e) => e.k === "${kind}" && e.t > ${mark})`, waitMs);
  const key = await keyAfter(view, mark, kind);
  if (!key) return { ok: false, ms: null };
  const at = key.t;
  await waitUntil(view, `performance.now() > ${at + within + 20}`, waitMs);
  return js<{ ok: boolean; ms: number | null }>(view, `(() => {
    const c = window.__holdClock;
    const entered = c.stateAt(${at}) === "${expected}" ? ${at} : c.states.find((e) => e.t >= ${at} && e.s === "${expected}")?.t;
    return { ok: c.stateAt(${at + within}) === "${expected}", ms: entered === undefined ? null : Math.round(entered - ${at}) };
  })()`);
}

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
  await waitFrames(view);
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
    // The rate and the hint 900 ms into the hold, the base rate 300 ms after it, by the page's clock (LOOP-27).
    await js(view, holdClock(base));
    await sampler.start();
    const mark = await pageNow(view);
    keyDown(view, "Right");
    const during = await byPageClock(view, mark, "down", "in", 900);
    const duringState = await playerOf(view);
    keyUp(view, "Right");
    const after = await byPageClock(view, mark, "up", "out", 300);
    const afterState = await playerOf(view);
    await sleep(500); // real time: 100ms bar sampler post-hold samples (at least 12 total)
    const seen = await sampler.stop();
    detail.hold = { judged: "page clock", during: { ok: during.ok, enteredMs: during.ms, rate: duringState.rate, holding: duringState.holding }, after: { ok: after.ok, backMs: after.ms, rate: afterState.rate, holding: afterState.holding }, samples: seen.length, barSeen: seen.filter(Boolean).length };
    if (!during.ok) problems.push(`holding → in window full screen: not at rate 2 with the hint 900 ms into the hold by the page's clock (entered after ${during.ms} ms; rate ${duringState.rate}, hint ${duringState.holding})`);
    if (!after.ok) problems.push(`letting go of → did not give the rate back (${base}) without the hint within 300 ms by the page's clock (${after.ms} ms; rate ${afterState.rate})`);
    if (seen.length < 12 || seen.some(Boolean)) problems.push(`the bar showed in ${seen.filter(Boolean).length} of ${seen.length} samples during and after the hold`);

    // The bar is showing (the pointer moved): a hold fades it; with the pointer on the bar it stays.
    await pointerAt(view, "middle");
    const woke = await shown(view);
    keyDown(view, "Right");
    const faded = await idle(view, 800);
    keyUp(view, "Right");
    await waitUntil(view, `!document.querySelector('[data-testid="video-holding"]')`, 1000);
    await pointerAt(view, "bar");
    const onBar = await shown(view);
    keyDown(view, "Right");
    await sleep(800); // real time: hold duration while pointer is on bar to verify bar stays visible
    const keptOnBar = !(await playerOf(view)).idle;
    keyUp(view, "Right");
    await waitUntil(view, `!document.querySelector('[data-testid="video-holding"]')`, 1000);
    detail.showing = { woke, faded, onBar, keptOnBar };
    if (!woke) problems.push("moving the pointer did not bring the bar back");
    if (!faded) problems.push("holding → did not fade the bar that was showing");
    if (!onBar || !keptOnBar) problems.push("holding → faded the bar although the pointer was on it");

    // A tap: one step, and the bar when the key goes up.
    await pointerAt(view, "middle");
    await idle(view);
    const before = await playerOf(view);
    keyDown(view, "Right");
    await sleep(60); // real time: tap press duration below hold threshold
    const downIdle = (await playerOf(view)).idle;
    keyUp(view, "Right");
    await shown(view, 1500);
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
    await sleep(1100); // real time: hold Left duration and 100ms bar sampler
    const rewinding = (await playerOf(view)).rewinding;
    keyUp(view, "Left");
    await sleep(500); // real time: 100ms bar sampler post-rewind samples (at least 12 total)
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
    await waitFrames(view);
  }
  observe("hold-rate-hint-only", problems.length === 0, { ...detail, problems });
}

async function walkRecovers(view: BrowserWindow, observe: Observe): Promise<void> {
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const debug = view.webContents.debugger;
  const wasAttached = debug.isAttached();
  const base = (await playerOf(view)).rate;
  /** The temporary rate within the hold time (300 ms) and a margin for the page's timers, 450 ms after the press that follows the mark, by the page's clock. */
  const timings: Array<{ step: string; ms: number | null }> = [];
  const reached = async (mark: number, step: string) => { const got = await byPageClock(view, mark, "down", "in", 450); timings.push({ step, ms: got.ms }); return got.ok; };
  /** The base rate without the hint 600 ms after the release that follows the mark, by the page's clock. */
  const restored = async (mark: number, step: string) => { const got = await byPageClock(view, mark, "up", "out", 600); timings.push({ step, ms: got.ms }); return got.ok; };
  try {
    if (!wasAttached) debug.attach("1.3");
    const send = (type: "rawKeyDown" | "keyUp", repeat = false) => debug.sendCommand("Input.dispatchKeyEvent", { type, key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, autoRepeat: repeat });
    const repeats = async (ms: number) => {
      for (let at = 0; at < ms; at += 33) {
        await send("rawKeyDown", true);
        await sleep(33); // real time: OS keyboard auto-repeat cadence (30 Hz)
      }
    };
    view.webContents.focus();
    await js(view, holdClock(base));
    await js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); v.pause(); v.currentTime = 2; return true; })()`);
    await waitFrames(view);

    // 1. Down, held, and the key-up never comes; then down again (not a repeat) and held: the old hold ends without a step, the new one takes the rate.
    const start = (await playerOf(view)).time;
    let mark = await pageNow(view);
    await send("rawKeyDown");
    const firstHold = await reached(mark, "first hold");
    await waitFrames(view);
    mark = await pageNow(view);
    await send("rawKeyDown");
    const secondHold = await reached(mark, "second hold");
    await waitUntil(view, `document.querySelector('[data-testid="video-element"]').currentTime > ${start + 0.3}`, 1500);
    mark = await pageNow(view);
    await send("keyUp");
    const firstBack = await restored(mark, "after the lost key-up");
    await waitFrames(view);
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
    await waitFrames(view);
    view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    const menuClosed = await waitUntil(view, `!document.querySelector('[role="menu"]')`, 2000);
    // The hold counts from the first repeat that reaches the page after the menu closed.
    mark = await pageNow(view);
    const repeating = repeats(600);
    const fromRepeats = await reached(mark, "from the repeats");
    await repeating;
    mark = await pageNow(view);
    await send("keyUp");
    const secondBack = await restored(mark, "after the repeats");
    if (inPanel && await js<boolean>(view, `document.querySelector('[data-testid="video-more"]')?.getAttribute("aria-expanded") === "true"`)) await clickTestId(view, "video-more", 2000);
    detail.repeatsOnly = { menu, menuClosed, inPanel, fromRepeats, secondBack };
    if (!menu || !menuClosed) problems.push("the rate menu could not be opened and closed for the walk");
    if (!fromRepeats) problems.push("a hold whose first press went to the menu did not reach the rate from its repeats");
    if (!secondBack) problems.push("after a hold made of repeats, letting go did not give the rate back");

    // 3. The source of the video changes in the middle of a hold (the element is loaded again): the rate is the temporary one after it, and the base one after the hold.
    mark = await pageNow(view);
    await send("rawKeyDown");
    const thirdHold = await reached(mark, "before the change of source");
    await js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); const at = v.currentTime; v.load(); v.addEventListener("loadedmetadata", () => { v.currentTime = at; }, { once: true }); return true; })()`);
    const reloaded = await waitUntil(view, `document.querySelector('[data-testid="video-element"]').readyState >= 1`, 6000);
    await waitUntil(view, `document.querySelector('[data-testid="video-element"]').playbackRate === 2 && Boolean(document.querySelector('[data-testid="video-holding"]'))`, 2000);
    const afterLoad = await playerOf(view);
    mark = await pageNow(view);
    await send("keyUp");
    const thirdBack = await restored(mark, "after the change of source");
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
  observe("hold-rate-recovers", problems.length === 0, { ...detail, judged: "page clock", timings, problems });
}
