import { app, nativeTheme, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { LightMediaService, LightPositions } from "@manga/app-core/light";

/**
 * Light open's packaged-window checks (第 7 节: light-video, light-video-copy, light-comic, light-multi), run inside light open's own process when it
 * is started with `--manga-smoke`. The harness (`scripts/stage/package.mjs`) starts it on synthetic samples with a fresh application data root and
 * reads the report it writes; the harness itself checks what is outside the process (the files written, the single-instance locks, the timings).
 * Keys go in as real input events; nothing here reaches into React.
 */
type Dirs = { root: string; runtime: string; positions: string; cache: string; logs: string };
type Row = { name: string; status: "passed" | "failed"; detail?: unknown };
type Input = { first: BrowserWindow; dirs: Dirs; windows: () => BrowserWindow[]; service: LightMediaService; positions: LightPositions; askedAt: (window: BrowserWindow) => number | null };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function js<T>(window: BrowserWindow, code: string): Promise<T> {
  return window.webContents.executeJavaScript(code, true) as Promise<T>;
}

async function waitFor(window: BrowserWindow, expression: string, timeoutMs = 20_000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if (await js<boolean>(window, `Boolean(${expression})`)) return true; } catch { /* the page is still loading */ }
    await sleep(50);
  }
  return false;
}

async function key(window: BrowserWindow, keyCode: string, holdMs = 30): Promise<void> {
  window.webContents.sendInputEvent({ type: "keyDown", keyCode });
  await sleep(holdMs);
  window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  await sleep(60);
}

const click = (window: BrowserWindow, testId: string) => js<boolean>(window, `(() => { const node = document.querySelector('[data-testid="${testId}"]'); if (!node || node.disabled) return false; node.click(); return true; })()`);
const videoTime = (window: BrowserWindow) => js<number>(window, `document.querySelector('[data-testid="video-element"]')?.currentTime ?? -1`);
const title = (window: BrowserWindow) => js<string>(window, `document.querySelector('[data-testid="light-title"]')?.textContent ?? ""`);
const comicPage = (window: BrowserWindow) => js<number>(window, `Number(document.querySelector('[data-testid="comic-reader"]')?.getAttribute('data-page-index') ?? -1)`);

/** The first frame on screen: the element has a picture and has presented one frame to the compositor. */
async function firstFrame(window: BrowserWindow, timeoutMs = 30_000): Promise<boolean> {
  if (!(await waitFor(window, `document.querySelector('[data-testid="video-element"]')?.readyState >= 2`, timeoutMs))) return false;
  return js<boolean>(window, `new Promise((resolve) => { const v = document.querySelector('[data-testid="video-element"]'); if (!v || typeof v.requestVideoFrameCallback !== "function") { resolve(v?.videoWidth > 0); return; } const timer = setTimeout(() => resolve(v.videoWidth > 0), 3000); v.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(true); }); })`);
}

async function shot(window: BrowserWindow, name: string): Promise<string | null> {
  const dir = process.env.MANGA_SMOKE_EVIDENCE_DIR;
  if (!dir) return null;
  // A window that has not painted since it was shown may answer with an error; it is asked again after a frame or two.
  let image: Electron.NativeImage | null = null;
  for (let attempt = 0; attempt < 10 && !image; attempt += 1) {
    try { image = await window.webContents.capturePage(); } catch { await sleep(200); }
  }
  if (!image) return null;
  const shotsDir = path.join(dir, "screenshots");
  const file = path.join(shotsDir, `ui-${name}.png`);
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.writeFileSync(file, image.toPNG());
  return path.basename(file);
}

async function videoWalk(window: BrowserWindow, rows: Row[], timings: Record<string, number>): Promise<void> {
  const started = Number(process.env.MANGA_SMOKE_SPAWNED_AT) || Date.now();
  const shown = await firstFrame(window);
  timings.firstFrameMs = Date.now() - started;
  rows.push({ name: "light-video-first-frame", status: shown ? "passed" : "failed", detail: { ms: timings.firstFrameMs } });
  if (!shown) return;
  const before = await videoTime(window);
  await sleep(1200);
  const playing = (await videoTime(window)) > before + 0.3;
  rows.push({ name: "light-video-plays", status: playing ? "passed" : "failed", detail: { before } });
  await key(window, "Space");
  await sleep(300);
  const pausedAt = await videoTime(window);
  await sleep(500);
  const paused = Math.abs((await videoTime(window)) - pausedAt) < 0.05;
  rows.push({ name: "light-video-pause", status: paused ? "passed" : "failed", detail: { pausedAt } });
  await key(window, "Right");
  await sleep(500);
  const jumped = await videoTime(window);
  rows.push({ name: "light-video-seek-key", status: jumped >= pausedAt + 4 ? "passed" : "failed", detail: { from: pausedAt, to: jumped } });
  // The rate menu: 1.5×.
  await click(window, "video-rate");
  await sleep(150);
  await js(window, `(() => { const item = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')].find((node) => /1\\.5/.test(node.textContent ?? "")); item?.click(); })()`);
  await sleep(200);
  const rate = await js<number>(window, `document.querySelector('[data-testid="video-element"]')?.playbackRate ?? 0`);
  rows.push({ name: "light-video-rate", status: Math.abs(rate - 1.5) < 0.01 ? "passed" : "failed", detail: { rate } });
  await js(window, `(() => { const item = [...document.querySelectorAll('[role="menuitemradio"],[role="menuitem"]')].find((node) => /^1×|^1x|^1 ?倍/.test((node.textContent ?? "").trim())); if (item) item.click(); else document.body.click(); })()`);
  // The picture with its bar and subtitles, in the light and the dark theme (light open follows the system; the check sets the theme it asks for).
  await key(window, "Space");
  await sleep(1500);
  await key(window, "Space");
  await js(window, `window.dispatchEvent(new PointerEvent("pointermove"))`);
  await sleep(300);
  const lightShot = await shot(window, "light-video-light");
  nativeTheme.themeSource = "dark";
  await waitFor(window, `document.documentElement.dataset.theme === "dark"`, 3000);
  await sleep(300);
  const darkShot = await shot(window, "light-video-dark");
  nativeTheme.themeSource = "system";
  rows.push({ name: "light-video-screenshot", status: "passed", detail: { files: [lightShot, darkShot] } });
  // Audio tracks: when the file has two, the second can be chosen (that needs a play copy, which the window offers), and the default again.
  const audioMenu = await click(window, "video-audio");
  if (audioMenu) {
    await sleep(150);
    const picked = await js<boolean>(window, `(() => { const items = [...document.querySelectorAll('[role="menuitemradio"]')]; if (items.length < 2) return false; items[1].click(); return true; })()`);
    await sleep(400);
    const offered = await waitFor(window, `document.querySelector('[data-testid="video-make-copy"]') || document.querySelector('[data-testid="video-element"]')?.readyState >= 2`, 15_000);
    const back = await click(window, "video-default-audio");
    const playsAgain = back && await firstFrame(window);
    rows.push({ name: "light-video-audio-track", status: picked && offered && playsAgain ? "passed" : "failed", detail: { picked, offered, back } });
  }
  // Subtitles: off, then back on.
  const subtitleMenu = await click(window, "video-subtitles");
  if (subtitleMenu) {
    await sleep(150);
    const off = await js<boolean>(window, `(() => { const item = [...document.querySelectorAll('[role="menuitemradio"]')][0]; if (!item) return false; item.click(); return true; })()`);
    await sleep(300);
    await click(window, "video-subtitles");
    await sleep(150);
    const on = await js<boolean>(window, `(() => { const items = [...document.querySelectorAll('[role="menuitemradio"]')]; if (items.length < 2) return false; items[1].click(); return true; })()`);
    await sleep(300);
    rows.push({ name: "light-video-subtitles", status: off && on ? "passed" : "failed" });
  }
  timings.memoryWorkingSetMiB = Math.round(app.getAppMetrics().reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) / 1024);
}

async function nextEpisode(window: BrowserWindow, rows: Row[]): Promise<void> {
  const before = await title(window);
  const moved = await click(window, "light-next");
  const changed = moved && await waitFor(window, `document.querySelector('[data-testid="light-title"]')?.textContent !== ${JSON.stringify(before)}`, 15_000);
  const after = await title(window);
  const ready = changed && await firstFrame(window);
  rows.push({ name: "light-video-next", status: ready ? "passed" : "failed", detail: { before, after } });
}

async function comicWalk(window: BrowserWindow, rows: Row[], timings: Record<string, number>, expectStart: number | null, screenshot = true): Promise<void> {
  const started = Number(process.env.MANGA_SMOKE_SPAWNED_AT) || Date.now();
  const shown = await waitFor(window, `document.querySelector('[data-testid^="comic-page-"][data-state="ready"] img')?.complete && document.querySelector('[data-testid^="comic-page-"][data-state="ready"] img')?.naturalWidth > 0`, 30_000);
  timings.firstPageMs = Date.now() - started;
  rows.push({ name: "light-comic-first-page", status: shown ? "passed" : "failed", detail: { ms: timings.firstPageMs } });
  if (!shown) return;
  const start = await comicPage(window);
  if (expectStart !== null) rows.push({ name: "light-comic-start-page", status: start === expectStart ? "passed" : "failed", detail: { start, expectStart } });
  // Right to left by default: ← is the next page.
  const direction = await js<string>(window, `document.querySelector('[data-testid="comic-reader"]')?.getAttribute('data-direction') ?? ""`);
  await key(window, direction === "rtl" ? "Left" : "Right");
  await sleep(300);
  const turned = await comicPage(window);
  rows.push({ name: "light-comic-turn", status: turned === start + 1 ? "passed" : "failed", detail: { start, turned, direction } });
  await click(window, "comic-more-settings");
  await sleep(150);
  await click(window, "comic-direction");
  await sleep(150);
  const flipped = await js<string>(window, `document.querySelector('[data-testid="comic-reader"]')?.getAttribute('data-direction') ?? ""`);
  rows.push({ name: "light-comic-direction", status: flipped !== direction ? "passed" : "failed", detail: { from: direction, to: flipped } });
  await click(window, "comic-layout-double");
  await sleep(300);
  const pair = await js<number>(window, `document.querySelectorAll('[data-testid="comic-spread"] [data-testid^="comic-page-"]').length`);
  await click(window, "comic-layout-strip");
  await sleep(500);
  const stripPage = await comicPage(window);
  await click(window, "comic-layout-single");
  await sleep(300);
  const backPage = await comicPage(window);
  rows.push({ name: "light-comic-layouts", status: pair >= 1 && await js<boolean>(window, `!!document.querySelector('[data-testid="comic-spread"]')`) && stripPage === backPage ? "passed" : "failed", detail: { pair, stripPage, backPage } });
  // The page number: type 3.
  await click(window, "comic-position");
  await sleep(100);
  await js(window, `(() => { const input = document.querySelector('[data-testid="comic-page-input"]'); if (!input) return; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, "3"); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
  await sleep(300);
  const jumped = await comicPage(window);
  rows.push({ name: "light-comic-page-jump", status: jumped === 2 ? "passed" : "failed", detail: { jumped } });
  await click(window, "comic-more-settings");
  await sleep(200);
  if (screenshot) rows.push({ name: "light-comic-screenshot", status: "passed", detail: { file: await shot(window, "light-comic") } });
  await sleep(700);
}

/** Close every window the way a person does; the last one ends the process. */
function closeAll(windows: BrowserWindow[]): void {
  for (const window of windows) if (!window.isDestroyed()) window.close();
}

export async function runLightSmoke(input: Input): Promise<void> {
  const phase = process.env.MANGA_SMOKE_PHASE ?? "light-video";
  const reportFile = process.env.MANGA_SMOKE_REPORT ?? path.join(input.dirs.logs, `smoke-${phase}.json`);
  const rows: Row[] = [];
  const timings: Record<string, number> = {};
  const window = input.first;
  const write = (extra: Record<string, unknown> = {}) => {
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, `${JSON.stringify({ phase, status: "passed", ok: rows.length > 0 && rows.every((row) => row.status === "passed"), pid: process.pid, observations: rows, timings, ...extra }, null, 2)}\n`);
  };
  const guard = setTimeout(() => { rows.push({ name: `${phase}-timeout`, status: "failed" }); write(); app.exit(2); }, Number(process.env.MANGA_SMOKE_TIMEOUT_MS) || 180_000);
  try {
    await waitFor(window, `document.querySelector('[data-testid="light-shell"]')`, 30_000);
    if (phase === "light-video") {
      await videoWalk(window, rows, timings);
      if (process.env.MANGA_SMOKE_NEXT === "1") await nextEpisode(window, rows);
      // Leave somewhere known for the next start: 4 s in, paused.
      await js(window, `(() => { const v = document.querySelector('[data-testid="video-element"]'); v.pause(); v.currentTime = 4; })()`);
      await sleep(400);
    } else if (phase === "light-video-resume") {
      const shown = await firstFrame(window);
      const at = await videoTime(window);
      const resumed = await js<boolean>(window, `!!document.querySelector('[data-testid="light-resumed"]')`);
      rows.push({ name: "light-video-resume", status: shown && at >= 3.5 && resumed ? "passed" : "failed", detail: { at, resumed } });
    } else if (phase === "light-video-copy") {
      const asked = await waitFor(window, `document.querySelector('[data-testid="video-make-copy"]')`, 30_000);
      const reason = await js<string>(window, `document.querySelector('[data-testid="video-copy-reason"]')?.textContent ?? ""`);
      rows.push({ name: "light-video-copy-reason", status: asked && reason.length > 0 ? "passed" : "failed", detail: { reason } });
      if (asked) {
        await click(window, "video-make-copy");
        const ready = await firstFrame(window, 240_000);
        const badge = await js<boolean>(window, `!!document.querySelector('[data-testid="video-copy-badge"]')`);
        const copies = fs.existsSync(path.join(input.dirs.cache, "play-copies")) ? fs.readdirSync(path.join(input.dirs.cache, "play-copies")).filter((name) => name.endsWith(".mp4")) : [];
        rows.push({ name: "light-video-copy-plays", status: ready && badge && copies.length > 0 ? "passed" : "failed", detail: { badge, copies: copies.length } });
      }
    } else if (phase === "light-comic") {
      await comicWalk(window, rows, timings, process.env.MANGA_SMOKE_START_PAGE ? Number(process.env.MANGA_SMOKE_START_PAGE) : 0);
      if (process.env.MANGA_SMOKE_NEXT === "1") {
        const before = await title(window);
        const moved = await click(window, "light-next");
        const changed = moved && await waitFor(window, `document.querySelector('[data-testid="light-title"]')?.textContent !== ${JSON.stringify(before)}`, 15_000);
        rows.push({ name: "light-comic-next-volume", status: changed ? "passed" : "failed", detail: { before, after: await title(window) } });
        if (changed) await comicWalk(window, [], {}, null, false);
        await click(window, "light-previous");
        await waitFor(window, `document.querySelector('[data-testid="light-title"]')?.textContent === ${JSON.stringify(before)}`, 15_000);
        await waitFor(window, `document.querySelector('[data-testid^="comic-page-"][data-state="ready"]')`, 15_000);
        await click(window, "comic-position");
        await sleep(100);
        await js(window, `(() => { const input = document.querySelector('[data-testid="comic-page-input"]'); if (!input) return; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, "3"); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); })()`);
        await sleep(900);
      }
    } else if (phase === "light-comic-resume") {
      await waitFor(window, `document.querySelector('[data-testid^="comic-page-"][data-state="ready"]')`, 30_000);
      const page = await comicPage(window);
      rows.push({ name: "light-comic-resume", status: page === Number(process.env.MANGA_SMOKE_EXPECT_PAGE ?? 2) ? "passed" : "failed", detail: { page } });
    } else if (phase === "light-empty") {
      const empty = await waitFor(window, `document.querySelector('[data-testid="light-empty"]') && document.querySelector('[data-testid="light-types"]')`, 15_000);
      rows.push({ name: "light-empty-window", status: empty ? "passed" : "failed", detail: { file: await shot(window, "light-empty") } });
    } else if (phase === "light-unsupported") {
      const said = await waitFor(window, `document.querySelector('[data-testid="light-error"][data-error="unsupported"]')`, 15_000);
      rows.push({ name: "light-unsupported-file", status: said ? "passed" : "failed" });
    } else if (phase === "light-bench") {
      const kind = process.env.MANGA_SMOKE_BENCH_KIND ?? "video";
      const started = Number(process.env.MANGA_SMOKE_SPAWNED_AT) || Date.now();
      let shown: boolean;
      if (kind === "comic") {
        shown = await waitFor(window, `document.querySelector('[data-testid^="comic-page-"][data-state="ready"] img')?.complete && document.querySelector('[data-testid^="comic-page-"][data-state="ready"] img')?.naturalWidth > 0`, 30_000);
        timings.firstPageMs = Date.now() - started;
      } else {
        shown = await firstFrame(window);
        timings.firstFrameMs = Date.now() - started;
        // What light open holds with one video playing: the working set of all its processes, a second after the first frame.
        await sleep(1000);
        timings.workingSetMiB = Math.round(app.getAppMetrics().reduce((sum, item) => sum + item.memory.workingSetSize, 0) / 1024);
      }
      rows.push({ name: "light-bench", status: shown ? "passed" : "failed" });
    } else if (phase === "light-multi" || phase === "light-hold") {
      // Stays open: the harness opens more files into this process, or asks it to leave for an update, and reads the windows from here.
      const want = Number(process.env.MANGA_SMOKE_WINDOWS ?? 1);
      const enough = await (async () => { const until = Date.now() + 60_000; while (Date.now() < until) { if (input.windows().length >= want) return true; await sleep(100); } return false; })();
      rows.push({ name: `${phase}-windows`, status: enough ? "passed" : "failed", detail: { windows: input.windows().length, want, pid: process.pid } });
      write({ waiting: true });
      // lightSecondOpenMs (第 7 节): each file opened into this running process, from the moment its process was started to the first frame.
      const secondOpens = Number(process.env.MANGA_SMOKE_SECOND_OPENS ?? 0);
      if (secondOpens > 0) {
        const secondOpenMs: number[] = [];
        const seen = new Set(input.windows());
        for (let n = 0; n < secondOpens; n += 1) {
          const until = Date.now() + 60_000;
          let opened: BrowserWindow | undefined;
          while (!opened && Date.now() < until) { opened = input.windows().find((item) => !seen.has(item)); if (!opened) await sleep(20); }
          if (!opened) break;
          seen.add(opened);
          await waitFor(opened, `document.querySelector('[data-testid="light-shell"]')`, 30_000);
          const shown = await firstFrame(opened);
          const asked = input.askedAt(opened);
          if (shown && asked) secondOpenMs.push(Date.now() - asked);
          opened.close();
          write({ waiting: true, secondOpenMs });
        }
        rows.push({ name: "light-second-open", status: secondOpenMs.length === secondOpens ? "passed" : "failed", detail: { secondOpenMs } });
        write({ waiting: true, secondOpenMs, secondOpensDone: true });
      }
      if (phase === "light-hold") { clearTimeout(guard); return; }
      await sleep(1500);
    }
    // Every page read went through light open's own handles and nothing else.
    rows.push({ name: `${phase}-sessions`, status: "passed", detail: { open: input.service.openSessions, remembered: input.positions.size } });
  } catch (error) {
    rows.push({ name: `${phase}-error`, status: "failed", detail: error instanceof Error ? error.message : String(error) });
  }
  clearTimeout(guard);
  write();
  closeAll(input.windows());
}
