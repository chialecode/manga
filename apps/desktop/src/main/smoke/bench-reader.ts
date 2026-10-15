import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, type BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { clickTestId, openFromShelf, pressKey, sleep, waitUntil } from "./driver.ts";
import { caller, js, toRail } from "./common.ts";

/**
 * Two figures of the video player in the real window that the second round of use asked for. Both are measured in a window the harness shows, because a hidden
 * one presents no frames.
 *
 * - Danmaku: an episode with thousands of comments is played in the window with the layer on, and the frames the page is given are counted: how many came
 *   later than one and a half of the usual interval (the interval of the same playback with the layer off) is the share dropped.
 * - Memory: what keeping a player behind settings costs. The application's working set is read with no player kept, and again with one kept (opened, played
 *   a little, paused in the middle, settings opened over it); the difference, in MiB, is the figure.
 */

export type DanmakuBenchSpec = { runs: number; baselineRuns: number; playMs: number; comments: number };
export type MemoryBenchSpec = { runs: number };

const SAMPLE = "video-mp4-h264-aac";

/** A library path with the synthetic video in it, scanned; the resource of its work. */
async function seedVideo(appService: MangaProductApp, call: ReturnType<typeof caller>): Promise<string | null> {
  const root = process.env.MANGA_SMOKE_SAMPLES;
  if (!root) return null;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as { samples: Array<{ id: string; path: string; status: string }> };
  const entry = manifest.samples.find((item) => item.id === SAMPLE && item.status === "generated");
  if (!entry) return null;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "manga-bench-reader-"));
  fs.copyFileSync(path.join(root, entry.path), path.join(folder, "合成动画.mp4"));
  const added = await call("library.paths.add", { pathHandle: appService.registerPath("directory", folder), mediaKind: "video", autoScan: true });
  if (added.status !== "ok") return null;
  await appService.scan.whenIdle();
  const works = ((await call("works.list", { limit: 20, group: false })).value as { items?: Array<{ id: string }> } | undefined)?.items ?? [];
  const work = works[0];
  if (!work) return null;
  const got = (await call("works.get", { workId: work.id })).value as { resources?: Array<{ id: string }>; lastResource?: { id: string } | null } | undefined;
  return got?.lastResource?.id ?? got?.resources?.[0]?.id ?? null;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
};

/** The player is playing from the start, muted, and the page's frame intervals are collected for `ms`. */
const playAndCount = (view: BrowserWindow, ms: number) => js<{ intervals: number[]; dropped: number; decoded: number; comments: number; ink: number }>(view, `(async () => {
  const video = document.querySelector('[data-testid="video-element"]');
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
  const layer = document.querySelector('[data-testid="danmaku-layer"]');
  const canvas = layer ? layer.querySelector("canvas") : null;
  let ink = -1;
  if (canvas && canvas.width > 0 && canvas.height > 0) {
    const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    ink = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink += 1;
  }
  video.pause();
  return { intervals: intervals.slice(2), dropped: after.droppedVideoFrames - before.droppedVideoFrames, decoded: after.totalVideoFrames - before.totalVideoFrames, comments: layer ? Number(layer.getAttribute("data-count") ?? 0) : 0, ink };
})()`);

export async function measureDanmakuBench(appService: MangaProductApp, grant: string, view: BrowserWindow, spec: DanmakuBenchSpec): Promise<Record<string, unknown> & { ok: boolean }> {
  const call = caller(appService, grant);
  const failures: string[] = [];
  view.showInactive();
  await call("settings.skipAi", {});
  const resourceId = await seedVideo(appService, call);
  if (!resourceId) return { ok: false, failures: ["the synthetic video could not be put in a library path"] };
  const chosen = await call("danmaku.choose", { resourceId, episodeId: 900102, animeId: 9001, animeTitle: "样例动画", episodeTitle: "第2话" });
  if (chosen.status !== "ok") failures.push(`the episode could not be chosen: ${chosen.error?.message ?? "failed"}`);
  const set = await call("danmaku.setSettings", { enabled: true, area: 0.5, merge: false });
  if (set.status !== "ok") failures.push("the settings could not be set");
  const loaded = await call("danmaku.load", { resourceId });
  const count = Number((loaded.value as { count?: number } | undefined)?.count ?? 0);
  if (loaded.status !== "ok") failures.push(`the comments could not be loaded: ${loaded.error?.message ?? "failed"}`);
  await view.webContents.reload();
  await toRail(view);
  const opened = await openFromShelf(view, "nav-video", resourceId, 10_000) && await waitUntil(view, `document.querySelector('[data-testid="video-reader"][data-ready]')`, 30_000);
  if (!opened) return { ok: false, failures: [...failures, "the player did not open"], comments: count };
  view.webContents.focus();
  await sleep(600);

  // The layer is on from the settings; it is shown once the comments are in.
  const shown = await waitUntil(view, `document.querySelector('[data-testid="danmaku-layer"][data-visible="true"]')`, 15_000);
  if (!shown) failures.push("the layer did not show");
  const wanted = Number((await js<number>(view, `Number(document.querySelector('[data-testid="danmaku-layer"]')?.getAttribute("data-count") ?? 0)`)));

  // Layer off for the usual interval, then layer on. D turns it off and on again.
  await pressKey(view, "D");
  await sleep(300);
  const baseline: number[] = [];
  const baselineDropped: number[] = [];
  for (let run = 0; run < spec.baselineRuns; run += 1) {
    const got = await playAndCount(view, spec.playMs);
    baseline.push(...got.intervals);
    baselineDropped.push(got.dropped);
  }
  const usual = median(baseline);
  const baselineLatePct = Math.round((baseline.filter((value) => value > usual * 1.5).length / Math.max(1, baseline.length)) * 10_000) / 100;
  await pressKey(view, "D");
  await sleep(500);
  const raw: number[] = [];
  const runs: Array<Record<string, unknown>> = [];
  for (let run = 0; run < spec.runs; run += 1) {
    const got = await playAndCount(view, spec.playMs);
    const late = got.intervals.filter((value) => value > usual * 1.5).length;
    raw.push(Math.round((late / Math.max(1, got.intervals.length)) * 10_000) / 100);
    runs.push({ frames: got.intervals.length, late, decoded: got.decoded, dropped: got.dropped, ink: got.ink, medianMs: Math.round(median(got.intervals) * 100) / 100 });
    if (got.ink <= 40) failures.push(`run ${run + 1} drew nothing on the layer (${got.ink} pixels)`);
  }
  if (!(usual > 0)) failures.push("no frame interval was measured without the layer");
  return {
    ok: failures.length === 0 && raw.length === spec.runs,
    failures,
    comments: count,
    shown: wanted,
    usualIntervalMs: Math.round(usual * 100) / 100,
    baselineFrames: baseline.length,
    baselineLatePct,
    baselineDropped,
    raw,
    runs,
    playMs: spec.playMs,
  };
}

/** The application's working set in MiB, all of its processes, and the part of it each kind of process holds. */
const snapshot = (): { total: number; byType: Record<string, number> } => {
  const byType: Record<string, number> = {};
  let total = 0;
  for (const item of app.getAppMetrics()) {
    const mib = (item.memory?.workingSetSize ?? 0) / 1024;
    total += mib;
    byType[item.type] = (byType[item.type] ?? 0) + mib;
  }
  return { total, byType };
};

/** Several readings a short while apart; the middle one, so that a moment of garbage collection does not decide. */
async function readMemory(): Promise<{ total: number; byType: Record<string, number> }> {
  const values: Array<ReturnType<typeof snapshot>> = [];
  for (let i = 0; i < 5; i += 1) { values.push(snapshot()); await sleep(300); }
  return values.sort((a, b) => a.total - b.total)[Math.floor(values.length / 2)]!;
}

export async function measureMemoryBench(appService: MangaProductApp, grant: string, view: BrowserWindow, spec: MemoryBenchSpec): Promise<Record<string, unknown> & { ok: boolean }> {
  const call = caller(appService, grant);
  const failures: string[] = [];
  view.showInactive();
  await call("settings.skipAi", {});
  const resourceId = await seedVideo(appService, call);
  if (!resourceId) return { ok: false, failures: ["the synthetic video could not be put in a library path"] };
  await view.webContents.reload();
  await toRail(view);
  const raw: number[] = [];
  const rows: Array<Record<string, unknown>> = [];
  for (let run = 0; run < spec.runs; run += 1) {
    // No player kept: settings over the library.
    await toRail(view);
    await clickTestId(view, "nav-settings");
    await waitUntil(view, `document.querySelector('[data-testid="settings-nav"]')`, 6000);
    await sleep(1200);
    const without = await readMemory();
    await clickTestId(view, "settings-back");
    await toRail(view);
    // One player kept: opened, played a little, paused in the middle, and settings opened over it.
    const opened = await openFromShelf(view, "nav-video", resourceId, 10_000) && await waitUntil(view, `document.querySelector('[data-testid="video-reader"][data-ready]')`, 30_000);
    if (!opened) { failures.push(`run ${run + 1}: the player did not open`); break; }
    await js(view, `(async () => { const v = document.querySelector('[data-testid="video-element"]'); v.muted = true; await v.play(); await new Promise((r) => setTimeout(r, 1500)); v.pause(); v.currentTime = (v.duration || 4) / 2; return true; })()`);
    await sleep(500);
    await clickTestId(view, "nav-settings");
    await waitUntil(view, `document.querySelector('[data-testid="settings-nav"]')`, 6000);
    const kept = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="video-element"]'))`);
    if (!kept) failures.push(`run ${run + 1}: the player was not kept behind settings`);
    await sleep(1200);
    const withReader = await readMemory();
    const grew = Math.round((withReader.total - without.total) * 10) / 10;
    const grewBy = Object.fromEntries(Object.keys({ ...withReader.byType, ...without.byType }).sort().map((type) => [type, Math.round(((withReader.byType[type] ?? 0) - (without.byType[type] ?? 0)) * 10) / 10]));
    // A reading that came out lower is noise in what the allocator gave back; the figure is what the player costs, so it is not below nothing. The row keeps what was read.
    raw.push(Math.max(0, grew));
    rows.push({ withoutMiB: Math.round(without.total), withMiB: Math.round(withReader.total), grewMiB: grew, grewByProcessMiB: grewBy, kept });
    // The player comes back, and is closed again for the next run: the cross of its entry in the rail.
    await clickTestId(view, "settings-back");
    await waitUntil(view, `Boolean(document.querySelector('[data-testid="video-reader"]'))`, 6000);
    await toRail(view);
    await js(view, `document.querySelector('[data-testid^="session-close-"]')?.click()`);
    const closed = await waitUntil(view, `!document.querySelector('[data-testid="video-element"]')`, 6000);
    if (!closed) { failures.push(`run ${run + 1}: the player could not be closed again`); break; }
    await sleep(800);
  }
  return { ok: failures.length === 0 && raw.length === spec.runs, failures, raw, rows, unit: "MiB", processes: app.getAppMetrics().map((item) => item.type).sort() };
}
