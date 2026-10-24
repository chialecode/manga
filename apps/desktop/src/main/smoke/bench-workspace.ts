import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { clickTestId, closeTabs, DRAWN, openFromShelf, openProjectsPage, PICK, pressChord, sleep, tabsOf, viaSidebar, waitUntil, type TabFact } from "./driver.ts";
import { caller, js, toRail } from "./common.ts";
import { median, readMemory } from "./bench-reader.ts";

/**
 * The workspace in the real window (plan 7, AT-117): tabs, contexts, readers kept loaded and a four-column layout with a video playing. Every
 * press is a real pointer press on the title or the sidebar row, so the strip and the sidebar handle it as they handle a person's; the clock
 * runs inside the page, from the press that reaches it to the poll where the awaited content is drawn, so the polling from this process
 * adds nothing to the figure. The window is shown (a hidden one presents no frames) and made large enough for four columns.
 *
 * - tab switch: the tabs of one column are pressed in turn; the content of the one pressed is drawn (readers among them are still loaded)
 * - context switch, loaded: three contexts that were all visited, pressed in turn; the focused tab of the one pressed is drawn
 * - context switch, after a restart: the page is loaded again (the contexts are made anew from the library), and each context other than the
 *   one the window comes back in is pressed once
 * - readers kept loaded: ten readers opened one after the other and pressed in turn; the readers whose content is in the page, over the columns
 * - late frames: one video of four columns (two videos, a comic, a note) plays, and the frames the page is given are counted against
 *   the interval of the same playback in a single column
 * - memory: the application's working set with the four columns, over the same with the one video in a single column
 */

export type WorkspaceBenchSpec = { switchRounds: number; contextRounds: number; restoreRounds: number; readers: number; quadRuns: number; baselineRuns: number; playMs: number };
export type WorkspaceMemorySpec = { runs: number };

type Sample = { ok: boolean; ms: number; reason?: string };
type Seeds = { videoA: string; videoB: string; comic: string; novels: string[]; noteId: string; projects: string[] };

const SAMPLES = { videoA: "video-mp4-h264-aac", videoB: "video-vfr", comic: "cbz-basic" } as const;
const HOST = `document.querySelector('[data-testid="context-host"][data-active="true"]')`;
const LARGE = { width: 1920, height: 1040 };

/** The page's own clock: armed with a check, it starts at the next pointer press and stops at the first 4 ms poll where the check holds. */
const PRELUDE = `(() => {
  if (window.__ws) return true;
  const ws = (window.__ws = { until: null, started: 0, timeout: 0, result: null, timer: 0 });
  const step = () => {
    if (!ws.until || ws.result) return;
    let held = false;
    try { held = Boolean(ws.until()); } catch { held = false; }
    const ms = performance.now() - ws.started;
    if (held) { void document.body.offsetHeight; ws.result = { ok: true, ms }; ws.until = null; }
    else if (ms > ws.timeout) { ws.result = { ok: false, ms, reason: "timeout" }; ws.until = null; }
    else ws.timer = setTimeout(step, 4);
  };
  document.addEventListener("pointerdown", () => { if (ws.until && ws.started === 0) { ws.started = performance.now(); step(); } }, true);
  ws.arm = (until, timeout) => { clearTimeout(ws.timer); ws.until = until; ws.timeout = timeout; ws.started = 0; ws.result = null; };
  return true;
})()`;

/** The content of a tab is drawn: its panel is the one in front of the context in front, shows no "loading" placeholder, and draws its first element. */
const tabShown = (id: string) => `(() => {
  const panel = ${HOST}?.querySelector('[data-testid="tab-panel"][data-tab="${id}"]');
  if (!panel || panel.getAttribute("data-focused") !== "true" || panel.getClientRects().length === 0) return false;
  if (panel.querySelector('[data-testid="reader-unloaded"]')) return false;
  const root = panel.firstElementChild;
  return Boolean(root) && root.getClientRects().length > 0 && getComputedStyle(root).visibility !== "hidden";
})()`;

/** The context is in front and the tab it was left on is drawn with its text. */
const contextShown = (key: string) => `(() => {
  const host = ${HOST};
  if (!host || host.getAttribute("data-context") !== ${JSON.stringify(key)}) return false;
  const panel = host.querySelector('[data-testid="tab-panel"][data-focused="true"]');
  const body = panel?.querySelector('[data-testid="reading-body"]');
  return Boolean(body) && body.getClientRects().length > 0 && (body.textContent || "").length > 0;
})()`;

/** Where the run is, on the process's error stream (the runner keeps the tail of it when a window does not finish). */
const note = (text: string) => console.error(`[workspace-bench] ${text}`);

const percentile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]! : 0;
};

/** Where a real press goes: the middle of the left part of the element (a title also holds a close button at its right). */
const pointOf = (view: BrowserWindow, selector: string) => js<{ x: number; y: number } | null>(view, `(() => {
  const el = ${selector};
  if (!el) return null;
  const box = el.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  return { x: Math.round(box.left + Math.min(box.width / 2, 40)), y: Math.round(box.top + box.height / 2) };
})()`);

const chipOf = (id: string) => `${HOST}?.querySelector('[data-testid="tab"][data-tab="${id}"]')`;
const rowOf = (testId: string) => `${PICK}(${JSON.stringify(testId)})`;

/** A real press at a point, timed in the page until `until` holds. */
async function timedPress(view: BrowserWindow, selector: string, until: string, timeoutMs = 10_000): Promise<Sample> {
  const point = await pointOf(view, selector);
  if (!point) return { ok: false, ms: -1, reason: "nothing to press" };
  await js(view, `window.__ws.arm(() => (${until}), ${timeoutMs})`);
  view.webContents.focus();
  view.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  view.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  view.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  if (!(await waitUntil(view, `window.__ws.result !== null`, timeoutMs + 3000))) return { ok: false, ms: -1, reason: "no answer" };
  return js<Sample>(view, `window.__ws.result`);
}

/** A press that is not timed: the tab is brought to the front and its content waited for. */
async function show(view: BrowserWindow, id: string): Promise<boolean> {
  const point = await pointOf(view, chipOf(id));
  if (!point) return false;
  view.webContents.focus();
  view.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
  view.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
  view.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
  return waitUntil(view, tabShown(id), 10_000);
}

async function chooseMenu(view: BrowserWindow, trigger: string, item: string): Promise<boolean> {
  if (!(await clickTestId(view, trigger, 3000))) return false;
  if (!(await waitUntil(view, `document.querySelector('[data-testid="${item}"]')`, 2500))) return false;
  const clicked = await clickTestId(view, item, 2000);
  await waitUntil(view, `!document.querySelector('[role="menu"]')`, 1500);
  return clicked;
}

const keep = (label: string, sample: Sample, into: number[], failures: string[]) => {
  if (sample.ok) into.push(sample.ms);
  else failures.push(`${label}: ${sample.reason ?? "failed"}`);
};

/** The note is opened the way a person opens one: the notes view's manage entry (the records tab), then the note's row. */
async function openNote(view: BrowserWindow, noteId: string): Promise<boolean> {
  if (!(await viaSidebar(view, "note", "sidebar-manage", 6000))) return false;
  const row = await waitUntil(view, `${DRAWN}(${PICK}("record-open-${noteId}"))`, 10_000);
  if (!row) note(`the records list has ${await js<number>(view, `document.querySelectorAll('[data-testid^="record-open-"]').length`)} notes to open and not this one`);
  return row && clickTestId(view, `record-open-${noteId}`, 4000);
}

/** The synthetic resources of the bench: two videos, a comic, ten novels, a note and two projects, all made the way the window's own flows make them. */
async function seed(appService: MangaProductApp, call: ReturnType<typeof caller>, wanted: { novels: number }): Promise<Seeds | null> {
  const root = process.env.MANGA_SMOKE_SAMPLES;
  if (!root) return null;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as { samples: Array<{ id: string; path: string; status: string }> };
  const sample = (id: string) => {
    const entry = manifest.samples.find((item) => item.id === id && item.status === "generated");
    return entry ? path.join(root, entry.path) : null;
  };
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-workspace-"));
  const place = (kind: "video" | "comic", folder: string, name: string, from: string | null) => {
    if (!from) return null;
    const dir = path.join(base, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(from, path.join(dir, name));
    return { dir, kind };
  };
  const places = [
    place("video", "video-a", "合成动画甲.mp4", sample(SAMPLES.videoA)),
    place("video", "video-b", "合成动画乙.mp4", sample(SAMPLES.videoB)),
    place("comic", "comic", "合成漫画.cbz", sample(SAMPLES.comic)),
  ];
  if (places.some((item) => !item)) return null;
  for (const item of places) {
    const added = await call("library.paths.add", { pathHandle: appService.registerPath("directory", item!.dir), mediaKind: item!.kind, autoScan: true });
    if (added.status !== "ok") return null;
    await appService.scan.whenIdle();
  }
  const works = ((await call("works.list", { limit: 50, group: false })).value as { items?: Array<{ id: string; title: string; mediaKind: string }> } | undefined)?.items ?? [];
  const resourceOf = async (match: (work: { title: string; mediaKind: string }) => boolean): Promise<string | null> => {
    const work = works.find(match);
    if (!work) return null;
    const got = (await call("works.get", { workId: work.id })).value as { resources?: Array<{ id: string }>; lastResource?: { id: string } | null } | undefined;
    return got?.lastResource?.id ?? got?.resources?.[0]?.id ?? null;
  };
  const videoA = await resourceOf((work) => work.mediaKind === "video" && work.title.includes("甲"));
  const videoB = await resourceOf((work) => work.mediaKind === "video" && work.title.includes("乙"));
  const comic = await resourceOf((work) => work.mediaKind === "comic");
  if (!videoA || !videoB || !comic) return null;
  const novels: string[] = [];
  for (let i = 0; i < wanted.novels; i += 1) {
    const text = `${"基准正文，每一段都不长。".repeat(120)}末尾标记${i}`;
    const imported = await call("library.importDocument", { title: `基准书${String(i + 1).padStart(2, "0")}`, format: "txt", bytes: [...new TextEncoder().encode(text)] });
    const id = String((imported.value as { resourceId?: string } | undefined)?.resourceId ?? "");
    if (id) novels.push(id);
  }
  const created = await call("notes.create", { title: "基准文稿", text: "基准文稿的正文。" });
  const noteId = String((created.value as { objectId?: string } | undefined)?.objectId ?? "");
  const projects: string[] = [];
  for (const name of ["基准项目甲", "基准项目乙"]) {
    const made = await call("project.create", { name });
    const id = String((made.value as { id?: string } | undefined)?.id ?? "");
    if (id) projects.push(id);
  }
  if (novels.length < wanted.novels || !noteId || projects.length < 2) return null;
  return { videoA, videoB, comic, novels, noteId, projects };
}

/** The four tabs of the quad and nothing else, in one column: the two videos, the comic, the note. A player already open (`videoA`) is kept. */
async function openFour(view: BrowserWindow, seeds: Seeds, videoA?: string): Promise<{ ids: Record<"videoA" | "videoB" | "comic" | "note", string>; failures: string[] } | null> {
  const failures: string[] = [];
  if (!videoA) await closeTabs(view, "all");
  const before = new Set((await tabsOf(view)).map((tab) => tab.id));
  // The strip adds a tab's title a moment after the page of the tab is drawn, so the new title is waited for (setup only; nothing is timed here).
  const idOfNew = async (): Promise<string | null> => {
    for (let waited = 0; waited <= 5000; waited += 100) {
      const found = (await tabsOf(view)).find((tab: TabFact) => !before.has(tab.id) && tab.kind !== "library" && tab.kind !== "records")?.id;
      if (found) return found;
      await sleep(100);
    }
    return null;
  };
  const ids: Partial<Record<"videoA" | "videoB" | "comic" | "note", string>> = videoA ? { videoA } : {};
  for (const [name, kind, resource] of [["videoA", "video", seeds.videoA], ["videoB", "video", seeds.videoB], ["comic", "comic", seeds.comic]] as const) {
    if (name === "videoA" && videoA) continue;
    if (!(await openFromShelf(view, kind, resource, 12_000, []))) { failures.push(`${name} did not open`); continue; }
    const id = await idOfNew();
    if (id) { ids[name] = id; before.add(id); } else failures.push(`${name} has no tab`);
  }
  if (await openNote(view, seeds.noteId)) {
    const id = await idOfNew();
    if (id) ids.note = id; else failures.push("the note has no tab");
  } else failures.push("the note did not open");
  await closeTabs(view, ["library", "records"]);
  if (!ids.videoA || !ids.videoB || !ids.comic || !ids.note) return { ids: ids as never, failures: [...failures, "a tab is missing"] };
  return { ids: ids as never, failures };
}

/** The player of a tab plays from the start, muted, and the page's frame intervals are collected for `ms`. */
const playAndCount = (view: BrowserWindow, tabId: string, ms: number) => js<{ intervals: number[]; dropped: number; decoded: number }>(view, `(async () => {
  const video = document.querySelector('[data-testid="tab-panel"][data-tab="${tabId}"] [data-testid="video-element"]');
  if (!video) return { intervals: [], dropped: 0, decoded: 0 };
  video.muted = true;
  video.currentTime = 0;
  await video.play();
  const intervals = [];
  let last = performance.now();
  let running = true;
  const tick = (now) => { intervals.push(now - last); last = now; if (running) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  const before = video.getVideoPlaybackQuality();
  await new Promise((resolve) => setTimeout(resolve, ${ms}));
  running = false;
  const after = video.getVideoPlaybackQuality();
  video.pause();
  return { intervals: intervals.slice(2), dropped: after.droppedVideoFrames - before.droppedVideoFrames, decoded: after.totalVideoFrames - before.totalVideoFrames };
})()`);

const playerReady = (view: BrowserWindow, tabId: string) => waitUntil(view, `(() => { const v = document.querySelector('[data-testid="tab-panel"][data-tab="${tabId}"] [data-testid="video-element"]'); return Boolean(v) && v.readyState >= 2; })()`, 30_000);

/** A player of a tab has its first frame (it is made anew when its tab comes back into view), then plays a little, muted, and stops in the middle. */
async function playBriefly(view: BrowserWindow, tabId: string): Promise<boolean> {
  const player = `document.querySelector('[data-testid="tab-panel"][data-tab="${tabId}"] [data-testid="video-element"]')`;
  if (!(await playerReady(view, tabId))) return false;
  return js<boolean>(view, `(async () => { const v = ${player}; v.muted = true; await v.play(); await new Promise((r) => setTimeout(r, 1500)); v.pause(); v.currentTime = (v.duration || 4) / 2; return true; })()`);
}

/** Four columns, each showing one of the four tabs, all of them drawn. */
async function quadDrawn(view: BrowserWindow, ids: string[]): Promise<boolean> {
  const columns = await chooseMenu(view, "layout-menu", "layout-quad") && await waitUntil(view, `${HOST}.getAttribute("data-columns") === "4"`, 5000);
  if (!columns) return false;
  return waitUntil(view, `(() => {
    const drawn = ${DRAWN};
    return ${JSON.stringify(ids)}.every((id) => {
      const panel = ${HOST}.querySelector('[data-testid="tab-panel"][data-tab="' + id + '"]');
      return panel && panel.getAttribute("data-visible") === "true" && drawn(panel) && !panel.querySelector('[data-testid="reader-unloaded"]') && panel.firstElementChild && drawn(panel.firstElementChild);
    });
  })()`, 20_000);
}

export async function measureWorkspaceBench(appService: MangaProductApp, grant: string, view: BrowserWindow, spec: WorkspaceBenchSpec): Promise<Record<string, unknown> & { ok: boolean }> {
  const call = caller(appService, grant);
  const failures: string[] = [];
  view.showInactive();
  view.setContentSize(LARGE.width, LARGE.height);
  await call("settings.skipAi", {});
  const seeds = await seed(appService, call, { novels: spec.readers });
  if (!seeds) return { ok: false, failures: ["the synthetic resources could not be put in the library"] };
  await view.webContents.reload();
  await toRail(view);
  await js(view, PRELUDE);
  await sleep(800);

  // ---- tab switch: eight tabs of one column, three of them readers, pressed in turn ----
  note("seeded; tab switch");
  await closeTabs(view, "all");
  // One tab that is neither a reader nor a note stands in the strip first: the projects page, from the home's entry.
  await openProjectsPage(view, 4000);
  const opened = [
    await openFromShelf(view, "novel", seeds.novels[0]!, 12_000, []),
    await openFromShelf(view, "comic", seeds.comic, 12_000, []),
    await openFromShelf(view, "video", seeds.videoA, 12_000, []),
    await openNote(view, seeds.noteId),
  ];
  if (opened.some((ok) => !ok)) failures.push(`tab switch: not every tab opened (${JSON.stringify(opened)})`);
  await sleep(1200);
  const strip = await tabsOf(view);
  const tabMs: number[] = [];
  if (strip.length < 6) failures.push(`tab switch: only ${strip.length} tabs`);
  for (let round = 0; round < spec.switchRounds; round += 1) {
    for (const tab of strip) {
      if ((await tabsOf(view)).find((item) => item.id === tab.id)?.focused) continue;
      keep(`tab ${tab.kind}`, await timedPress(view, chipOf(tab.id), tabShown(tab.id)), tabMs, failures);
    }
  }

  // ---- context switch: 最近 and two projects, each left on a book ----
  note(`tab switch done (${tabMs.length} samples)`);
  const keys = ["", ...seeds.projects];
  const rowFor = (key: string) => (key ? `context-open-${key}` : "context-open-recent");
  const readerOf = (index: number) => seeds.novels[index % seeds.novels.length]!;
  for (const [index, key] of keys.entries()) {
    if (!(await clickTestId(view, rowFor(key), 6000)) || !(await waitUntil(view, `${HOST}?.getAttribute("data-context") === ${JSON.stringify(key)}`, 8000))) { failures.push(`context ${index}: could not be entered`); continue; }
    await closeTabs(view, "all");
    if (!(await openFromShelf(view, "novel", readerOf(index), 12_000, []))) failures.push(`context ${index}: its book did not open`);
    await sleep(500);
  }
  await sleep(1500);
  const contextMs: number[] = [];
  for (let round = 0; round < spec.contextRounds; round += 1) {
    for (const key of [keys[1]!, keys[2]!, keys[0]!]) keep(`context ${key || "recent"}`, await timedPress(view, rowOf(rowFor(key)), contextShown(key), 10_000), contextMs, failures);
  }

  // ---- context switch after a restart: the page is made anew, and each context other than the one it returns in is pressed once ----
  note(`context switch done (${contextMs.length} samples)`);
  const restoreMs: number[] = [];
  for (let round = 0; round < spec.restoreRounds; round += 1) {
    await view.webContents.reload();
    await toRail(view);
    await js(view, PRELUDE);
    await waitUntil(view, `${HOST}`, 10_000);
    await sleep(2000);
    const active = await js<string>(view, `${HOST}?.getAttribute("data-context") ?? ""`);
    for (const key of keys.filter((item) => item !== active)) keep(`restore ${key || "recent"}`, await timedPress(view, rowOf(rowFor(key)), contextShown(key), 20_000), restoreMs, failures);
  }

  // ---- readers kept loaded: ten books opened one after the other and pressed in turn ----
  note(`restore done (${restoreMs.length} samples)`);
  await clickTestId(view, "context-open-recent", 5000);
  await waitUntil(view, `${HOST}?.getAttribute("data-context") === ""`, 8000);
  await closeTabs(view, "all");
  let openedReaders = 0;
  for (const resource of seeds.novels) if (await openFromShelf(view, "novel", resource, 12_000, [])) openedReaders += 1;
  if (openedReaders < seeds.novels.length) failures.push(`readers: ${openedReaders} of ${seeds.novels.length} opened`);
  // The strip of eleven tabs does not show every title, so the tabs are walked with the keys that step through them (Ctrl+Tab), twice around.
  const front = () => js<string>(view, `${HOST}?.querySelector('[data-testid="tab"][data-focused="true"]')?.getAttribute("data-tab") ?? ""`);
  const around = (await tabsOf(view)).length * 2;
  for (let step = 0; step < around; step += 1) {
    const was = await front();
    await pressChord(view, "Tab", ["control"]);
    const moved = await waitUntil(view, `(${HOST}?.querySelector('[data-testid="tab"][data-focused="true"]')?.getAttribute("data-tab") ?? "") !== ${JSON.stringify(was)}`, 4000);
    if (!moved || !(await waitUntil(view, tabShown(await front()), 10_000))) failures.push(`readers: step ${step + 1} did not bring a tab to the front`);
  }
  await sleep(800);
  const loaded = await js<{ loaded: number; columns: number; tabs: number }>(view, `(() => {
    const host = ${HOST};
    const chips = [...host.querySelectorAll('[data-testid="tab"][data-kind="reader"]')];
    const loaded = chips.filter((chip) => {
      const panel = host.querySelector('[data-testid="tab-panel"][data-tab="' + chip.getAttribute("data-tab") + '"]');
      return panel && !panel.querySelector('[data-testid="reader-unloaded"]') && panel.firstElementChild;
    }).length;
    return { loaded, columns: Number(host.getAttribute("data-columns") ?? "1"), tabs: chips.length };
  })()`);
  const loadedOver = [Math.max(0, loaded.loaded - loaded.columns)];

  // ---- late frames in the four columns ----
  note("readers done; four columns");
  const four = await openFour(view, seeds);
  const lateRaw: number[] = [];
  const runs: Array<Record<string, unknown>> = [];
  let usual = 0;
  let baselineLatePct = -1;
  if (!four || four.failures.length > 0) failures.push(`quad: ${(four?.failures ?? ["the tabs did not open"]).join("; ")}`);
  else {
    const { ids } = four;
    if (!(await show(view, ids.videoA))) failures.push("quad: the video did not come to the front in one column");
    const baseline: number[] = [];
    for (let run = 0; run < spec.baselineRuns; run += 1) baseline.push(...(await playAndCount(view, ids.videoA, spec.playMs)).intervals);
    usual = median(baseline);
    baselineLatePct = baseline.length ? Math.round((baseline.filter((value) => value > usual * 1.5).length / baseline.length) * 10_000) / 100 : -1;
    if (!(usual > 0)) failures.push("quad: no frame interval was measured in one column");
    if (!(await quadDrawn(view, [ids.videoA, ids.videoB, ids.comic, ids.note]))) failures.push("quad: the four columns were not all drawn");
    if (!(await playerReady(view, ids.videoA)) || !(await playerReady(view, ids.videoB))) failures.push("quad: a player has no first frame");
    await sleep(1500);
    for (let run = 0; run < spec.quadRuns; run += 1) {
      const got = await playAndCount(view, ids.videoA, spec.playMs);
      const late = got.intervals.filter((value) => value > usual * 1.5).length;
      lateRaw.push(Math.round((late / Math.max(1, got.intervals.length)) * 10_000) / 100);
      runs.push({ frames: got.intervals.length, late, decoded: got.decoded, dropped: got.dropped, medianMs: Math.round(median(got.intervals) * 100) / 100 });
      if (got.intervals.length < 30) failures.push(`quad run ${run + 1}: only ${got.intervals.length} frames`);
      await sleep(400);
    }
    await chooseMenu(view, "layout-menu", "layout-single");
  }

  note("done");
  const samples = { tabMs, contextMs, restoreMs };
  const enough = tabMs.length >= 60 && contextMs.length >= 30 && restoreMs.length >= 10 && lateRaw.length === spec.quadRuns;
  return {
    ok: failures.length === 0 && enough,
    failures,
    window: LARGE,
    tabSwitchMs: tabMs,
    contextSwitchMs: contextMs,
    contextRestoreMs: restoreMs,
    tabs: strip.map((tab) => tab.kind),
    contexts: keys.length,
    p95: { tab: percentile(tabMs, 0.95), context: percentile(contextMs, 0.95), restore: percentile(restoreMs, 0.95) },
    readers: { opened: openedReaders, ...loaded, over: loadedOver },
    mountedReadersOverColumns: loadedOver,
    quadLateFramePct: lateRaw,
    quadRuns: runs,
    usualIntervalMs: Math.round(usual * 100) / 100,
    baselineLatePct,
    playMs: spec.playMs,
    counts: Object.fromEntries(Object.entries(samples).map(([name, list]) => [name, list.length])),
    waits: {
      tabSwitch: "real press on the title of a tab of the column → the content of that tab (a reader among them, still loaded) is drawn, timed in the page from the press",
      contextSwitch: "real press on the context's row in the sidebar → the context is in front and the book its front tab holds is drawn, all three contexts visited before",
      contextRestore: "same, after the page was loaded again: the context is made anew from the library (the one the window returns in is not pressed)",
      mountedReaders: "ten books opened and pressed in turn twice; reader tabs whose content is in the page, minus the columns shown",
      quadLateFrame: "frames given to the page while one of two videos plays in four columns (two videos, a comic, a note), later than 1.5 times the usual interval of the same playback in one column",
    },
  };
}

/** One window of the memory figure: a video in a single column, then the four columns; the application's working set is read each time. */
export async function measureWorkspaceMemory(appService: MangaProductApp, grant: string, view: BrowserWindow, spec: WorkspaceMemorySpec): Promise<Record<string, unknown> & { ok: boolean }> {
  const call = caller(appService, grant);
  const failures: string[] = [];
  view.showInactive();
  view.setContentSize(LARGE.width, LARGE.height);
  await call("settings.skipAi", {});
  const seeds = await seed(appService, call, { novels: 1 });
  if (!seeds) return { ok: false, failures: ["the synthetic resources could not be put in the library"] };
  await view.webContents.reload();
  await toRail(view);
  const raw: number[] = [];
  const rows: Array<Record<string, unknown>> = [];
  note("memory: seeded");
  for (let run = 0; run < spec.runs; run += 1) {
    await closeTabs(view, "all");
    const first = await openFromShelf(view, "video", seeds.videoA, 12_000, []) && await waitUntil(view, `${DRAWN}(${PICK}("video-reader"))`, 30_000);
    note(`memory: single column opened (${first})`);
    if (!first) { failures.push(`run ${run + 1}: the player did not open`); break; }
    const playerTab = (await tabsOf(view)).find((tab) => tab.kind === "reader")?.id;
    if (!playerTab || !(await playBriefly(view, playerTab))) { failures.push(`run ${run + 1}: the player in one column did not play`); break; }
    await closeTabs(view, ["library"]);
    await sleep(1500);
    const single = await readMemory();
    note("memory: single read");
    const four = await openFour(view, seeds, playerTab);
    if (!four || four.failures.length > 0) { failures.push(`run ${run + 1}: ${(four?.failures ?? ["the tabs did not open"]).join("; ")}`); break; }
    if (!(await quadDrawn(view, [four.ids.videoA, four.ids.videoB, four.ids.comic, four.ids.note]))) { failures.push(`run ${run + 1}: the four columns were not all drawn`); break; }
    note("memory: four columns drawn");
    if (!(await playBriefly(view, four.ids.videoA))) { failures.push(`run ${run + 1}: the player in the four columns did not play`); break; }
    await sleep(1500);
    const quad = await readMemory();
    const grew = Math.round((quad.total - single.total) * 10) / 10;
    const grewBy = Object.fromEntries(Object.keys({ ...quad.byType, ...single.byType }).sort().map((type) => [type, Math.round(((quad.byType[type] ?? 0) - (single.byType[type] ?? 0)) * 10) / 10]));
    // A reading that came out lower is noise in what the allocator gave back; the figure is what the columns cost, so it is not below nothing. The row keeps what was read.
    raw.push(Math.max(0, grew));
    rows.push({ singleMiB: Math.round(single.total), quadMiB: Math.round(quad.total), grewMiB: grew, grewByProcessMiB: grewBy });
  }
  return { ok: failures.length === 0 && raw.length === spec.runs, failures, raw, rows, unit: "MiB", window: LARGE };
}
