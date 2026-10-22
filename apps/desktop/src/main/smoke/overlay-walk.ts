import type { BrowserWindow } from "electron";
import { pressKey, setField, sleep, waitUntil } from "./driver.ts";
import { js } from "./common.ts";
import { realClick } from "./player-menus-walk.ts";
import type { Observe } from "./reader-controls-walk.ts";

/**
 * AT-108 in the real window: what a reader puts over its picture or its page (the player's prompt to play again and its big play button, the comic's
 * last-page prompt, the note and button of the region tool, the field a page number is typed in, the "…" panel, the novel's bar and its panel) must be
 * what a person's pointer reaches. Each such element is hit-tested at five of its own points (what the browser says is on top there is the element or
 * something inside it), in the ordinary window, with the window filled by the page, and with the screen filled by it. A bar that floats over the page
 * and covers a prompt shows as a point that lands on the bar.
 */

export const OVERLAY_OBSERVATIONS = ["overlays-comic", "overlays-player", "overlays-novel"] as const;
type State = "ordinary" | "window" | "screen";
const STATES: readonly State[] = ["ordinary", "window", "screen"];
type Probe = { id: string; found: boolean; empty: boolean; hits: number; points: number; coveredBy: string | null; inView: boolean };
type Row = { state: State; step: string; probes: Array<Pick<Probe, "id" | "hits" | "points" | "coveredBy">> };

/** Whether each element is there and what is on top at its centre and at the middle of each side half. */
const probe = (view: BrowserWindow, ids: readonly string[]): Promise<Probe[]> => js<Probe[]>(view, `(() => {
  const out = [];
  for (const id of ${JSON.stringify(ids)}) {
    const el = document.querySelector('[data-testid="' + id + '"]');
    if (!el) { out.push({ id, found: false, empty: false, hits: 0, points: 0, coveredBy: null, inView: false }); continue; }
    const b = el.getBoundingClientRect();
    if (b.width <= 0 || b.height <= 0) { out.push({ id, found: true, empty: true, hits: 0, points: 0, coveredBy: null, inView: false }); continue; }
    const at = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75]];
    let hits = 0; let coveredBy = null;
    for (const [fx, fy] of at) {
      const top = document.elementFromPoint(b.left + b.width * fx, b.top + b.height * fy);
      if (top && (top === el || el.contains(top))) hits += 1;
      else if (coveredBy === null) coveredBy = top ? (top.getAttribute("data-testid") || (typeof top.className === "string" && top.className) || top.tagName) : "nothing";
    }
    const inView = b.left >= -0.5 && b.top >= -0.5 && b.right <= window.innerWidth + 0.5 && b.bottom <= window.innerHeight + 0.5;
    out.push({ id, found: true, empty: false, hits, points: at.length, coveredBy, inView });
  }
  return out;
})()`);

class Walk {
  readonly problems: string[] = [];
  readonly rows: Row[] = [];
  constructor(readonly view: BrowserWindow, readonly shot?: (name: string) => Promise<void>) {}

  /** The elements must exist, be inside the window, and be reached at all five points. */
  async expectReached(state: State, step: string, ids: readonly string[]): Promise<void> {
    const found = await probe(this.view, ids);
    this.rows.push({ state, step, probes: found.map((item) => ({ id: item.id, hits: item.hits, points: item.points, coveredBy: item.coveredBy })) });
    for (const item of found) {
      if (!item.found) this.problems.push(`${state}: ${step}: ${item.id} is not there`);
      else if (item.empty) this.problems.push(`${state}: ${step}: ${item.id} has no size`);
      else {
        if (item.hits < item.points) this.problems.push(`${state}: ${step}: ${item.id} is reached at ${item.hits} of ${item.points} points; the rest land on ${item.coveredBy}`);
        if (!item.inView) this.problems.push(`${state}: ${step}: ${item.id} lies outside the window`);
      }
    }
  }

  /** A prompt sits entirely above a bar that floats over it. */
  async expectAbove(state: State, step: string, prompt: string, bar: string): Promise<void> {
    const gap = await js<{ prompt: number; bar: number } | null>(this.view, `(() => {
      const a = document.querySelector('[data-testid="${prompt}"]'); const b = document.querySelector('[data-testid="${bar}"]');
      if (!a || !b) return null;
      return { prompt: a.getBoundingClientRect().bottom, bar: b.getBoundingClientRect().top };
    })()`);
    if (!gap) { this.problems.push(`${state}: ${step}: ${prompt} or ${bar} is not there`); return; }
    if (gap.prompt > gap.bar + 0.5) this.problems.push(`${state}: ${step}: ${prompt} reaches down to ${Math.round(gap.prompt)}, into ${bar} (which starts at ${Math.round(gap.bar)})`);
  }

  shotAs(name: string): Promise<void> { return this.shot ? this.shot(name) : Promise.resolve(); }
}

const rest = async (view: BrowserWindow, fx = 0.5, fy = 0.5) => {
  const size = await js<{ w: number; h: number }>(view, `({ w: window.innerWidth, h: window.innerHeight })`);
  view.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(size.w * fx), y: Math.round(size.h * fy) });
  await sleep(250);
};

/** Put the reader into the state, run the work, and put the window back as it was. */
async function inState(view: BrowserWindow, walk: Walk, state: State, buttons: { window: string; screen: string }, work: () => Promise<void>): Promise<void> {
  const wasFull = view.isFullScreen();
  if (state === "window") {
    if (!await realClick(view, buttons.window)) { walk.problems.push(`window: ${buttons.window} was not found`); return; }
    if (!await waitUntil(view, `document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-immersive") === "true"`, 4000)) { walk.problems.push("window: the window did not fill with the page"); return; }
    await sleep(700);
  } else if (state === "screen") {
    if (!await realClick(view, buttons.screen)) { walk.problems.push(`screen: ${buttons.screen} was not found`); return; }
    if (!await waitUntil(view, `document.fullscreenElement !== null`, 4000)) { walk.problems.push("screen: the screen did not fill with the page"); return; }
    await sleep(800);
  }
  try {
    await work();
  } finally {
    if (state === "window") {
      await pressKey(view, "Escape");
      await waitUntil(view, `document.querySelector('[data-testid="shell-root"]')?.getAttribute("data-immersive") !== "true"`, 3000);
    } else if (state === "screen") {
      await pressKey(view, "Escape");
      await waitUntil(view, `document.fullscreenElement === null`, 3000);
      if (view.isFullScreen() !== wasFull) { await realClick(view, buttons.screen); await waitUntil(view, `document.fullscreenElement === null`, 3000); }
    }
    await sleep(500);
  }
}

// ------------------------------------------------------------------------------------------------ the comic

export async function walkComicOverlays(view: BrowserWindow, observe: Observe, shot?: (name: string) => Promise<void>): Promise<void> {
  const walk = new Walk(view, shot);
  view.webContents.focus();
  // The number of pages is the last number of the position ("第 3 / 12 页", and "第 3–4 / 12 页" when two pages are shown).
  const total = async () => js<number>(view, String.raw`Number((document.querySelector('[data-testid="comic-position"]')?.textContent ?? "").match(/(\d+)\D*$/)?.[1] ?? 0)`);
  for (const state of STATES) {
    await inState(view, walk, state, { window: "comic-window-fullscreen", screen: "comic-fullscreen" }, async () => {
      // The last page of the comic, then one more step: the prompt that the book has ended.
      const last = await total();
      if (!await realClick(view, "comic-position")) { walk.problems.push(`${state}: the page field was not found`); return; }
      await waitUntil(view, `document.querySelector('[data-testid="comic-page-input"]')`, 2000);
      // The field is where a page number is typed: it must be reachable while the bar floats over the page.
      await walk.expectReached(state, "page field", ["comic-page-input"]);
      await setField(view, "comic-page-input", String(last));
      await pressKey(view, "Enter");
      await sleep(300);
      // The button for the next page is disabled on the last one; the step that goes past it is the key.
      await pressKey(view, "PageDown");
      const ended = await waitUntil(view, `document.querySelector('[data-testid="comic-end"]')`, 3000);
      if (!ended) { walk.problems.push(`${state}: the prompt at the last page did not appear`); return; }
      await sleep(300);
      // The pointer is on the bar (which is what brought it): the hardest case, a floating bar fully shown over the bottom of the page.
      await walk.expectReached(state, "last-page prompt, bar shown", ["comic-end", "comic-end-back"]);
      if (state !== "ordinary") await walk.expectAbove(state, "last-page prompt, bar shown", "comic-end", "comic-footer");
      await walk.shotAs(`overlays-comic-${state}-end`);
      // The pointer elsewhere: the bar is out of sight, but the box it floats in still takes the pointer where it lies.
      await rest(view, 0.5, 0.4);
      await walk.expectReached(state, "last-page prompt, bar hidden", ["comic-end", "comic-end-back"]);
      await realClick(view, "comic-prev");
      await waitUntil(view, `!document.querySelector('[data-testid="comic-end"]')`, 2000);

      // The tool that frames a region: its note and button at the top, with the page's own top brought down over them in a full window.
      if (await realClick(view, "comic-region-tool")) {
        await waitUntil(view, `document.querySelector('[data-testid="comic-region-bar"]')`, 2000);
        await rest(view, 0.5, 0.5);
        await walk.expectReached(state, "region tool", ["comic-region-bar", "comic-region-cancel"]);
        if (state === "window") {
          view.webContents.sendInputEvent({ type: "mouseMove", x: 400, y: 4 });
          await sleep(120);
          view.webContents.sendInputEvent({ type: "mouseMove", x: 400, y: 11 });
          await waitUntil(view, `document.querySelector('[data-testid="shell-top"]')?.getAttribute("data-revealed") === "true"`, 1500);
          await sleep(300);
          await walk.expectReached(state, "region tool, page's top down", ["comic-region-bar", "comic-region-cancel"]);
          await walk.shotAs("overlays-comic-window-region");
        }
        await realClick(view, "comic-region-cancel");
        await waitUntil(view, `!document.querySelector('[data-testid="comic-region-bar"]')`, 2000);
      } else walk.problems.push(`${state}: the region tool was not found`);

      // The "…" panel over the bar.
      if (await realClick(view, "comic-more-settings")) {
        await waitUntil(view, `document.querySelector('[data-testid="comic-more-panel"]')`, 2000);
        await walk.expectReached(state, "more panel", ["comic-more-panel", "comic-layout-single", "comic-direction", "comic-autoflip"]);
        await realClick(view, "comic-more-settings");
        await sleep(150);
      } else walk.problems.push(`${state}: the settings button was not found`);
    });
  }
  // Rows: the page field, the prompt (bar shown, bar hidden), the region tool and the "…" panel in each state, and the region tool again with the page's top brought down in the window state: 5 + 6 + 5.
  observe("overlays-comic", walk.problems.length === 0 && walk.rows.length >= 16, { rows: walk.rows.length, states: STATES, problems: walk.problems, sample: walk.rows.filter((row) => row.step.startsWith("last-page")).slice(0, 6) });
}

// ------------------------------------------------------------------------------------------------ the player

export async function walkPlayerOverlays(view: BrowserWindow, observe: Observe, shot?: (name: string) => Promise<void>): Promise<void> {
  const walk = new Walk(view, shot);
  view.webContents.focus();
  const still = () => js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); v.pause(); v.currentTime = 0; return true; })()`);
  for (const state of STATES) {
    await inState(view, walk, state, { window: "video-window-fullscreen", screen: "video-fullscreen" }, async () => {
      await still();
      await rest(view, 0.5, 0.45);
      await sleep(300);
      await walk.expectReached(state, "big play", ["video-big-play"]);

      // Play to the end: the prompt to play again, and the bar that stays shown.
      await js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); v.muted = true; v.currentTime = Math.max(0, v.duration - 0.6); return v.play().then(() => true, () => false); })()`);
      const ended = await waitUntil(view, `document.querySelector('[data-testid="video-end"]')`, 12_000);
      if (!ended) { walk.problems.push(`${state}: the prompt at the end did not appear`); return; }
      await rest(view, 0.5, 0.3);
      await sleep(3200);
      const bar = await js<{ idle: boolean; opacity: string }>(view, `(() => { const shell = document.querySelector('[data-testid="video-shell"]'); const bar = document.querySelector('[data-testid="video-controls"]'); return { idle: shell?.hasAttribute("data-idle") ?? true, opacity: bar ? getComputedStyle(bar).opacity : "?" }; })()`);
      if (bar.idle || bar.opacity !== "1") walk.problems.push(`${state}: the bar did not stay shown at the end (${JSON.stringify(bar)})`);
      await walk.expectReached(state, "end prompt with the bar shown", ["video-end", "video-replay", "video-controls"]);
      if (state !== "ordinary") await walk.expectAbove(state, "end prompt with the bar shown", "video-end", "video-controls");
      await walk.shotAs(`overlays-player-${state}-end`);
      await realClick(view, "video-replay");
      const replayed = await waitUntil(view, `!document.querySelector('[data-testid="video-end"]')`, 3000);
      if (!replayed) walk.problems.push(`${state}: the replay button did not play again`);
      await still();
      await sleep(200);
    });
  }
  observe("overlays-player", walk.problems.length === 0 && walk.rows.length >= 3 * 2, { rows: walk.rows.length, states: STATES, problems: walk.problems, sample: walk.rows.filter((row) => row.step.startsWith("end prompt")).slice(0, 3) });
}

// ------------------------------------------------------------------------------------------------ the novel reader

export async function walkNovelOverlays(view: BrowserWindow, observe: Observe, shot?: (name: string) => Promise<void>): Promise<void> {
  const walk = new Walk(view, shot);
  view.webContents.focus();
  const bar = ["reading-footer", "reading-settings", "reading-window-fullscreen", "reading-fullscreen", "reading-progress"] as const;
  for (const state of STATES) {
    await inState(view, walk, state, { window: "reading-window-fullscreen", screen: "reading-fullscreen" }, async () => {
      const size = await js<{ w: number; h: number }>(view, `({ w: window.innerWidth, h: window.innerHeight })`);
      view.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(size.w / 2), y: size.h - 14 });
      await sleep(400);
      await walk.expectReached(state, "bar", bar);
      if (await realClick(view, "reading-settings")) {
        await waitUntil(view, `document.querySelector('[data-testid="reading-settings-panel"]')`, 2000);
        await walk.expectReached(state, "settings panel", ["reading-settings-panel"]);
        await walk.shotAs(`overlays-novel-${state}-settings`);
        await realClick(view, "reading-settings");
        await sleep(200);
      } else walk.problems.push(`${state}: the settings button was not found`);
    });
  }
  observe("overlays-novel", walk.problems.length === 0 && walk.rows.length >= 3 * 2, { rows: walk.rows.length, states: STATES, problems: walk.problems });
}

