import type { BrowserWindow } from "electron";
import { clickTestId, openFromShelf, railTo, revealNovelControls, sleep, waitForTestId, waitUntil } from "./driver.ts";
import { js, type caller } from "./common.ts";
import { longChaptersEpub } from "./novel-walk.ts";

/**
 * What a view switch, a drag and a book by the page cost in the real window (plan 7), after the workspace's own figures, in the same window:
 *
 * - a view: a real press on its icon until its sidebar and its main area are drawn, with both tabs loaded, and the first time after the page was loaded again;
 * - the covers of a media view: the same press after a load, until every cover of the view's grid has its picture;
 * - a drag: the frames the page is given while a divider and an icon are dragged, later than 1.5 times the usual interval with nothing going on;
 * - a book: a page turned, a larger letter with the place kept, and a chapter opened from the contents, in chapters of 300 000 characters.
 */
export type PolishTools = {
  timedPress: (view: BrowserWindow, selector: string, until: string, timeoutMs?: number) => Promise<{ ok: boolean; ms: number; reason?: string }>;
  prelude: string;
  failures: string[];
};
export type PolishFigures = { viewSwitchMs: number[]; viewRestoreMs: number[]; coversShownMs: number[]; coverImages: number; coverCells: number; novelCharacters: number; dragLateFramePct: number[]; novelTurnMs: number[]; novelRefontMs: number[]; novelOpenMs: number[] };

const LONG_CHAPTER_CHARACTERS = 300_000;
const POLISH = { switchRounds: 30, restoreRounds: 10, coverRounds: 10, dragRuns: 5, dragSteps: 90, turns: 60, refonts: 20, opens: 20, idleFrames: 120 };
const NAV = (name: string) => `document.querySelector('[data-testid="nav-${name}"]')`;
const HOST = `document.querySelector('[data-testid="context-host"][data-active="true"]')`;

/** The sidebar lists the view, and its main area shows the tab it has in front. */
const viewShown = (name: string) => `(() => {
  const side = document.querySelector('[data-testid="sidebar"]');
  if (!side || side.getAttribute("data-view") !== ${JSON.stringify(name)} || side.querySelector('[data-testid="sidebar-loading"]')) return false;
  const dock = ${HOST}?.querySelector('[data-testid="view-dock"]');
  if (!dock || dock.getAttribute("data-view") !== ${JSON.stringify(name)}) return false;
  const panel = dock.querySelector('[data-testid="tab-panel"][data-focused="true"]');
  return Boolean(panel) && panel.getClientRects().length > 0 && !panel.querySelector('[data-testid="reader-unloaded"]');
})()`;

/** Every cell of the view's grid is drawn, and each picture it has is decoded. */
const coversShown = (name: string) => `(() => {
  const side = document.querySelector('[data-testid="sidebar"]');
  if (!side || side.getAttribute("data-view") !== ${JSON.stringify(name)}) return false;
  const cells = [...side.querySelectorAll(".sidebar-cover")];
  if (!cells.length) return false;
  return cells.every((cell) => { const img = cell.querySelector("img"); return !img || (img.complete && img.naturalWidth > 0); });
})()`;

const pageLabel = `(document.querySelector('[data-testid="reading-page-position"]')?.textContent ?? "")`;
const pageNumbers = `((label) => { const hit = /第\\s*(\\d+)\\s*\\/\\s*约?\\s*(\\d+)/.exec(label); return hit ? [Number(hit[1]), Number(hit[2])] : [0, 0]; })`;

/** Frames the page is given while `run` goes on, as the time between them. */
async function framesDuring(view: BrowserWindow, run: () => Promise<void>): Promise<number[]> {
  await js(view, `(() => { const box = (window.__frames = { on: true, times: [] }); const tick = (at) => { if (!box.on) return; box.times.push(at); requestAnimationFrame(tick); }; requestAnimationFrame(tick); return true; })()`);
  await run();
  const times = await js<number[]>(view, `(() => { window.__frames.on = false; return window.__frames.times; })()`);
  return times.slice(1).map((at, index) => at - times[index]!);
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

async function drag(view: BrowserWindow, selector: string, dx: number, dy: number, steps: number): Promise<boolean> {
  const at = await js<{ x: number; y: number } | null>(view, `(() => { const el = ${selector}; if (!el) return null; const b = el.getBoundingClientRect(); return b.width || b.height ? { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) } : null; })()`);
  if (!at) return false;
  view.webContents.sendInputEvent({ type: "mouseMove", x: at.x, y: at.y });
  view.webContents.sendInputEvent({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1 });
  for (let step = 1; step <= steps; step += 1) {
    const move = { x: Math.round(at.x + (dx * step) / steps), y: Math.round(at.y + (dy * step) / steps) };
    view.webContents.sendInputEvent({ type: "mouseMove", ...move, button: "left" });
    await sleep(16);
  }
  // Back where it started, so that a run leaves the layout as it found it.
  for (let step = steps; step >= 0; step -= 1) {
    const move = { x: Math.round(at.x + (dx * step) / steps), y: Math.round(at.y + (dy * step) / steps) };
    view.webContents.sendInputEvent({ type: "mouseMove", ...move, button: "left" });
    await sleep(16);
  }
  view.webContents.sendInputEvent({ type: "mouseUp", x: at.x, y: at.y, button: "left", clickCount: 1 });
  await sleep(150);
  return true;
}

export async function measurePolish(view: BrowserWindow, call: ReturnType<typeof caller>, seeds: { videoA: string; novels: string[] }, tools: PolishTools): Promise<PolishFigures> {
  const { timedPress, prelude, failures } = tools;
  const figures: PolishFigures = { viewSwitchMs: [], viewRestoreMs: [], coversShownMs: [], coverImages: 0, coverCells: 0, novelCharacters: 0, dragLateFramePct: [], novelTurnMs: [], novelRefontMs: [], novelOpenMs: [] };
  const keep = (name: string, sample: { ok: boolean; ms: number; reason?: string }, into: number[]) => {
    if (sample.ok) into.push(sample.ms);
    else failures.push(`${name}: ${sample.reason ?? "no answer"}`);
  };

  // ---- a view: a book in the novels' view, a video in the anime's, both loaded ----
  if (!(await openFromShelf(view, "novel", seeds.novels[0]!, 8000)) || !(await waitForTestId(view, "reading-body", "data-present", null, 10_000))) failures.push("polish: the book did not open");
  if (!(await openFromShelf(view, "video", seeds.videoA, 8000, [])) || !(await waitForTestId(view, "video-element", "data-present", null, 10_000))) failures.push("polish: the video did not open");
  await js(view, `document.querySelector('[data-testid="video-element"]')?.pause(); true`);
  await railTo(view, "video");
  await sleep(600);
  for (let round = 0; round < POLISH.switchRounds; round += 1) {
    for (const name of ["novel", "video"]) keep(`view ${name}`, await timedPress(view, NAV(name), viewShown(name), 5000), figures.viewSwitchMs);
    await sleep(40);
  }

  // ---- the first press on a view after the page was loaded again, and the covers ----
  const reload = async (front: "novel" | "video") => {
    await railTo(view, front);
    await sleep(350);
    await view.webContents.reload();
    await waitUntil(view, `document.querySelector('[data-testid="nav-home"]')`, 15_000);
    await js(view, prelude);
    await sleep(500);
  };
  for (let round = 0; round < POLISH.restoreRounds; round += 1) {
    const [from, to] = (round % 2 === 0 ? ["novel", "video"] : ["video", "novel"]) as ["novel" | "video", "novel" | "video"];
    await reload(from);
    keep(`view after a load ${to}`, await timedPress(view, NAV(to), viewShown(to), 8000), figures.viewRestoreMs);
  }
  for (let round = 0; round < POLISH.coverRounds; round += 1) {
    await reload("novel");
    keep("covers", await timedPress(view, NAV("video"), coversShown("video"), 8000), figures.coversShownMs);
    figures.coverImages = await js<number>(view, `document.querySelectorAll('[data-testid="sidebar"] .sidebar-cover img').length`);
    figures.coverCells = await js<number>(view, `document.querySelectorAll('[data-testid="sidebar"] .sidebar-cover').length`);
  }

  // ---- a drag: the divider of the sidebar and an icon of the rail ----
  await railTo(view, "home");
  await sleep(500);
  const idle = await framesDuring(view, async () => { await sleep(Math.round((POLISH.idleFrames * 1000) / 60)); });
  const usual = median(idle);
  for (let run = 0; run < POLISH.dragRuns; run += 1) {
    const intervals = await framesDuring(view, async () => {
      const divider = await drag(view, `document.querySelector('[data-testid="shell-resize-sidebar"]')`, 100, 0, POLISH.dragSteps);
      const icon = await drag(view, NAV("mindmap"), 0, -120, POLISH.dragSteps);
      if (!divider || !icon) failures.push(`drag ${run + 1}: the divider or the icon is not there`);
    });
    const late = intervals.filter((value) => value > usual * 1.5).length;
    figures.dragLateFramePct.push(Math.round((late / Math.max(1, intervals.length)) * 10_000) / 100);
    if (intervals.length < 60) failures.push(`drag ${run + 1}: only ${intervals.length} frames`);
  }

  // ---- a book of two chapters of 300 000 characters ----
  const made = await call("library.importDocument", { title: "基准长章 EPUB", format: "epub", bytes: [...longChaptersEpub(2, LONG_CHAPTER_CHARACTERS)] }, "bench-polish-long");
  if (made.status !== "ok") { failures.push(`long book: ${JSON.stringify(made.error)}`); return figures; }
  const book = String((made.value as { resourceId: string }).resourceId);
  await view.webContents.reload();
  await waitUntil(view, `document.querySelector('[data-testid="nav-home"]')`, 15_000);
  await js(view, prelude);
  if (!(await openFromShelf(view, "novel", book, 15_000)) || !(await waitForTestId(view, "reading-body", "data-present", null, 20_000))) { failures.push("long book: it did not open"); return figures; }
  figures.novelCharacters = LONG_CHAPTER_CHARACTERS;
  await sleep(1200);
  view.setContentSize(1280, 820);
  await sleep(900);

  for (let turn = 0; turn < POLISH.turns; turn += 1) {
    await revealNovelControls(view);
    const page = await js<number>(view, `${pageNumbers}(${pageLabel})[0]`);
    keep("turn", await timedPress(view, `document.querySelector('[data-testid="reading-page-next"]')`, `${pageNumbers}(${pageLabel})[0] === ${page + 1}`, 4000), figures.novelTurnMs);
    await sleep(220);
  }

  await revealNovelControls(view);
  await clickTestId(view, "reading-settings", 3000);
  await waitUntil(view, `document.querySelector('[data-testid="reading-settings-panel"]')`, 3000);
  await sleep(300);
  // Where the reader is: the first character of the page the turns above brought. Every change of letter must come back to the page that holds it,
  // so that changing and changing back does not walk back a page each time.
  const point = await js<number>(view, `Number(document.querySelector('[data-testid="reading-body"]')?.getAttribute("data-page-start") ?? -1)`);
  for (let change = 0; change < POLISH.refonts; change += 1) {
    const now = await js<{ start: number; total: number }>(view, `(() => ({ start: Number(document.querySelector('[data-testid="reading-body"]')?.getAttribute("data-page-start") ?? -1), total: ${pageNumbers}(${pageLabel})[1] }))()`);
    const button = change % 2 === 0 ? "reading-font-larger" : "reading-font-smaller";
    // The new pages are laid out, the total has moved, and the page holds the character the reader is at.
    const placed = `(() => { const body = document.querySelector('[data-testid="reading-body"]'); const from = Number(body?.getAttribute("data-page-start")); const to = Number(body?.getAttribute("data-page-end")); return ${pageNumbers}(${pageLabel})[1] !== ${now.total} && from <= ${point} && ${point} < to; })()`;
    keep("larger letter", await timedPress(view, `document.querySelector('[data-testid="${button}"]')`, placed, 5000), figures.novelRefontMs);
    await sleep(300);
  }
  await revealNovelControls(view);
  await clickTestId(view, "reading-settings", 3000);
  await sleep(400);

  const row = (title: string) => `[...document.querySelectorAll('[data-testid="reading-panel"] button')].find((el) => (el.textContent ?? "").includes(${JSON.stringify(title)}))`;
  for (let open = 0; open < POLISH.opens; open += 1) {
    // Choosing a chapter closes the contents, as it does for a person.
    await revealNovelControls(view);
    await clickTestId(view, "reading-panel-toc", 3000);
    await waitUntil(view, `document.querySelector('[data-testid="reading-panel"]')`, 3000);
    await sleep(300);
    const title = open % 2 === 0 ? "第2章" : "第1章";
    const shown = `(document.querySelector('[data-testid="reading-chapter"]')?.textContent ?? "").includes(${JSON.stringify(title)}) && document.querySelector('[data-testid="reading-body"]')?.hasAttribute("data-page-start") && ${pageNumbers}(${pageLabel})[0] === 1`;
    keep("chapter", await timedPress(view, row(title), shown, 8000), figures.novelOpenMs);
    await sleep(300);
  }
  return figures;
}
