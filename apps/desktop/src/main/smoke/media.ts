import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { MangaProductApp } from "@manga/app-core";
import { createId } from "@manga/contracts";
import { clickTestId, closeTabs, openFromShelf, setField, sleep, trustedClick, waitForTestId } from "./driver.ts";
import { fullscreenRoundTrip, toRail } from "./common.ts";
import { differenceMask, glyphCells } from "./glyph-cells.ts";
import { expectedPlace, judgeDialogue, judgeTopCaption, MEASURE, type Measure, type Verdict } from "./subtitle-check.ts";
import { runRealVideoTrial } from "./real-video.ts";
import { inkIn, judgeAssShot, judgeSettingOff, judgeTextShot, takeShot, type Verdict as ShotVerdict } from "./shot-subtitles.ts";
import { centreOf, hitTestOpenPopup, realClick } from "./player-menus-walk.ts";
import { WINDOW_SIZES } from "./window-walk.ts";

/**
 * The three media flows through the real packaged window, with synthetic samples only: bring the sample in through a library path and a
 * scan (there is no import dialog), open from the card and the work's page, read or play, move, and check what the renderer actually did
 * (decoded pages, presented frames, subtitles drawn).
 * Samples come from MANGA_SMOKE_SAMPLES (the generated dist/samples/media); without them the phase reports not-run.
 */

const actor = { kind: "user" as const, id: "desktop-user" };

type Input = { appService: MangaProductApp; grant: string; view: BrowserWindow; evidenceDir: string | undefined };
type Step = { id: string; ok: boolean; detail?: unknown };

/** A comic page counts as drawn when it is ready and its image has decoded or its canvas (PDF pages) has a size. */
const PAGE_DRAWN = `(() => {
  const page = document.querySelector('[data-testid^="comic-page-"][data-state="ready"]');
  const img = page?.querySelector("img");
  const canvas = page?.querySelector("canvas");
  return Boolean(page && ((img && img.complete && img.naturalWidth > 0) || (canvas && canvas.width > 0)));
})()`;

const js = <T>(view: BrowserWindow, code: string): Promise<T> => view.webContents.executeJavaScript(code) as Promise<T>;

/** Poll a renderer expression until it is truthy; returns its value, or null on timeout. */
async function until<T>(view: BrowserWindow, expression: string, timeoutMs = 15_000): Promise<T | null> {
  const value = await js<T | null>(view, `new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      let value = null;
      try { value = (${expression}); } catch { value = null; }
      if (value) resolve(value);
      else if (Date.now() - started > ${timeoutMs}) resolve(null);
      else setTimeout(tick, 25);
    };
    tick();
  })`);
  return value;
}

/** The clock's own format, `m:ss.mmm`, written here so the smoke does not import renderer code. */
function clockText(ms: number): string {
  const whole = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(whole / 60_000);
  const seconds = Math.floor((whole % 60_000) / 1000);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${String(whole % 1000).padStart(3, "0")}`;
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]! * 10) / 10;
}

export async function runMediaSmoke(input: Input): Promise<Record<string, unknown> & { ok: boolean }> {
  const { appService, grant, view } = input;
  const root = process.env.MANGA_SMOKE_SAMPLES;
  if (!root || !fs.existsSync(path.join(root, "manifest.json"))) return { ok: true, notRun: true, reason: "MANGA_SMOKE_SAMPLES does not point at the generated samples" };
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as { samples: Array<{ id: string; path: string; status: string }> };
  const samplePath = (id: string) => {
    const entry = manifest.samples.find((item) => item.id === id);
    if (!entry || entry.status !== "generated") throw new Error(`sample ${id} is not available`);
    return path.join(root, entry.path);
  };
  const call = (commandId: string, body: Record<string, unknown>) => appService.call(actor, { commandId, idempotencyKey: createId("smoke"), input: body }, grant);
  const steps: Step[] = [];
  const record = (id: string, ok: boolean, detail?: unknown) => { steps.push({ id, ok, ...(detail !== undefined ? { detail } : {}) }); console.error(`media step ${id}: ${ok ? "ok" : "FAILED"} ${JSON.stringify(detail ?? null).slice(0, 600)}`); return ok; };
  let crash: { reason: string; exitCode: number } | null = null;
  view.webContents.on("render-process-gone", (_event, details) => { crash = { reason: details.reason, exitCode: details.exitCode }; console.error(`render-process-gone ${details.reason} exit=${details.exitCode}`); });
  // A hidden window presents no frames, so the picture checks need it on screen; it must not take the keyboard from the person.
  view.showInactive();
  const timings: Record<string, number[]> = { comicPageTurnMs: [], videoFirstFrameMs: [], videoFrameSeekMs: [], copyBuildMs: [] };
  const matrix: Array<Record<string, unknown>> = [];
  const evidence = input.evidenceDir;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const capture = async (name: string, rect?: { x: number; y: number; width: number; height: number }) => {
    if (!evidence) return null;
    try {
      const image = await view.webContents.capturePage(rect, { stayAwake: true });
      fs.writeFileSync(path.join(evidence, name), image.toPNG());
      return image;
    } catch {
      return null;
    }
  };

  await call("settings.skipAi", {});
  await view.webContents.reload();
  await toRail(view);

  /** Click the clock, type a time and press Enter, as a person does. */
  async function typeTime(text: string): Promise<boolean> {
    if (!await clickTestId(view, "video-time")) return false;
    if (!await waitForTestId(view, "video-time-input", "data-testid", "video-time-input", 2000)) return false;
    await setField(view, "video-time-input", text);
    await js(view, `document.querySelector('[data-testid="video-time-input"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
    return true;
  }

  /** The subtitle, audio and episode menus sit in the player's "more" panel. */
  async function openMore(): Promise<boolean> {
    if (await js<boolean>(view, `Boolean(document.querySelector('[data-testid="video-more-panel"]'))`)) return true;
    return clickTestId(view, "video-more");
  }

  /**
   * Bring a sample into the library the way a person does now (A-69): the folder that holds it becomes a library path of its medium and a
   * scan reads it. There is no import dialog. Returns the ids of the works that appeared.
   */
  async function importThroughLibrary(target: string, mode: "file" | "directory", expectKind: string, withSiblings = false): Promise<{ ok: boolean; suggested: string | null; workIds: string[] }> {
    const listWorks = async () => ((await call("works.list", { limit: 200, group: false })).value as { items: Array<{ id: string }> }).items.map((item) => item.id);
    const before = new Set(await listWorks());
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "manga-smoke-library-"));
    // Subtitles sit beside the video: a sample made of a video and its sidecars is copied whole.
    if (mode === "file" && withSiblings) fs.cpSync(path.dirname(target), folder, { recursive: true });
    else if (mode === "file") fs.copyFileSync(target, path.join(folder, path.basename(target)));
    else fs.cpSync(target, path.join(folder, path.basename(target)), { recursive: true });
    const added = await call("library.paths.add", { pathHandle: appService.registerPath("directory", folder), mediaKind: expectKind, autoScan: true });
    if (added.status !== "ok") return { ok: false, suggested: null, workIds: [] };
    await appService.scan.whenIdle();
    const fresh = (await listWorks()).filter((id) => !before.has(id));
    return { ok: fresh.length > 0, suggested: expectKind, workIds: fresh };
  }

  async function resourceOf(workId: string): Promise<{ resourceId: string; resources: number } | null> {
    const got = await call("works.get", { workId });
    const work = got.value as { resources?: Array<{ id: string }>; lastResource?: { id: string } | null } | undefined;
    const first = work?.lastResource?.id ?? work?.resources?.[0]?.id;
    return first ? { resourceId: first, resources: work?.resources?.length ?? 1 } : null;
  }

  // ------------------------------------------------------------------ comics
  const comicCases: Array<{ id: string; mode: "file" | "directory"; pages: number }> = [
    { id: "cbz-basic", mode: "file", pages: 5 },
    { id: "comic-dir-natural", mode: "directory", pages: 3 },
    { id: "comic-pdf-images", mode: "file", pages: 5 },
  ];
  const only = process.env.MANGA_SMOKE_ONLY?.split(",").filter(Boolean);
  for (const item of comicCases) {
    if (only?.length && !only.includes(item.id)) continue;
    let imported;
    try {
      imported = await importThroughLibrary(samplePath(item.id), item.mode, "comic");
    } catch (error) {
      record(`comic:${item.id}`, false, { error: String(error) });
      continue;
    }
    if (!imported.ok) { record(`comic:${item.id}`, false, { stage: "import", suggested: imported.suggested }); continue; }
    const found = await resourceOf(imported.workIds[0]!);
    if (!found) { record(`comic:${item.id}`, false, { stage: "resource" }); continue; }
    await toRail(view);
    const opened = await openFromShelf(view, "comic", found.resourceId, 10_000);
    const decoded = opened && await until<boolean>(view, PAGE_DRAWN, 20_000);
    const position0 = await js<string>(view, `document.querySelector('[data-testid="comic-position"]')?.textContent ?? ""`);
    await capture(`ui-media-comic-${item.id}.png`);
    if (item.id === "cbz-basic") {
      const full = await fullscreenRoundTrip(view, { button: "comic-fullscreen", root: "comic-reader", evidenceDir: evidence, shot: "ui-fullscreen-comic.png" });
      record("fullscreen:comic", full.ok, full);
    }
    // Turn the pages with the keyboard (right-to-left is the default, so the next page is on the left key) and time each one.
    let turned = 0;
    let lastPosition = position0;
    for (let page = 1; page < Math.min(item.pages, 4); page += 1) {
      const started = Date.now();
      await js(view, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", bubbles: true }))`);
      const moved = await until<string>(view, `(() => { const text = document.querySelector('[data-testid="comic-position"]')?.textContent ?? ""; return text !== ${JSON.stringify(lastPosition)} && (${PAGE_DRAWN}) ? text : null; })()`, 10_000);
      if (!moved) break;
      timings.comicPageTurnMs!.push(Date.now() - started);
      lastPosition = moved;
      turned += 1;
    }
    // Leaving the reader saves the position; reopening restores it.
    await closeTabs(view, ["reader"]);
    await sleep(400);
    // Back goes to the page before (a place passed through quickly is not one of the history's places), and the shelf's "read" resumes at the saved page.
    const landed = await js<string>(view, `document.querySelector('[data-testid^="page-"]')?.getAttribute("data-testid") ?? ""`);
    const reopened = await openFromShelf(view, "comic", found.resourceId, 10_000);
    const restored = reopened && await until<string>(view, `(() => { const text = document.querySelector('[data-testid="comic-position"]')?.textContent ?? ""; return text && text === ${JSON.stringify(lastPosition)} ? text : null; })()`, 10_000);
    const positionAfter = await js<string>(view, `document.querySelector('[data-testid="comic-position"]')?.textContent ?? ""`);
    await closeTabs(view, ["reader"]);
    record(`comic:${item.id}`, Boolean(decoded) && turned >= Math.min(item.pages, 4) - 1 && Boolean(restored), { suggested: imported.suggested, decoded: Boolean(decoded), turned, landed, reopened, restored: Boolean(restored), position: position0, left: lastPosition, positionAfter });
  }

  // ------------------------------------------------------------------ videos
  const videoCases = ["video-mkv-ass-fonts", "video-mp4-h264-aac", "video-mkv-hevc-8bit", "video-mkv-hevc-10bit", "video-ac3", "video-vfr", "video-nonzero-start"];
  const runVideo = async (id: string): Promise<void> => {
    const row: Record<string, unknown> = { sample: id };
    matrix.push(row);
    let file: string;
    try { file = samplePath(id); } catch (error) { row.result = "sample-unavailable"; record(`video:${id}`, true, { skipped: String(error) }); return; }
    const imported = await importThroughLibrary(file, "file", "video");
    if (!imported.ok) { row.result = "import-failed"; record(`video:${id}`, false, { stage: "import" }); return; }
    const found = await resourceOf(imported.workIds[0]!);
    if (!found) { row.result = "no-resource"; record(`video:${id}`, false, { stage: "resource" }); return; }
    const plans: Record<string, unknown> = {};
    for (const hardwareHevc of [false, true]) {
      const planned = (await call("video.playbackPlan", { resourceId: found.resourceId, hardwareHevc })).value as { plan?: { decision?: string; reasons?: string[] } } | undefined;
      plans[hardwareHevc ? "withHardwareHevc" : "withoutHardwareHevc"] = planned?.plan ? { decision: planned.plan.decision, reasons: planned.plan.reasons } : null;
    }
    row.plans = plans;
    await toRail(view);
    const clicked = Date.now();
    await openFromShelf(view, "video", found.resourceId, 10_000);
    const outcome = await until<string>(view, `(() => {
      if (document.querySelector('[data-testid="video-reader"][data-ready]')) return "ready";
      for (const id of ["video-needs-copy", "video-unsupported", "video-failed", "video-missing"]) if (document.querySelector('[data-testid="' + id + '"]')) return id.slice(6);
      return null;
    })()`, 40_000) ?? "timeout";
    row.initial = outcome;
    if (outcome === "needs-copy") {
      row.copyReason = await js<string | null>(view, `document.querySelector('[data-testid="video-needs-copy"]')?.getAttribute("data-reason")`);
      const built = Date.now();
      await clickTestId(view, "video-make-copy");
      const done = await until<string>(view, `(() => {
        if (document.querySelector('[data-testid="video-reader"][data-ready]')) return "ready";
        if (document.querySelector('[data-testid="video-failed"]')) return "failed";
        return null;
      })()`, 180_000) ?? "timeout";
      timings.copyBuildMs!.push(Date.now() - built);
      row.copy = done;
      if (done !== "ready") { row.result = "copy-" + done; record(`video:${id}`, false, row); await closeTabs(view, ["reader"]); return; }
      row.path = "play_copy";
    } else if (outcome === "ready") {
      row.path = "original";
    } else {
      row.result = outcome === "unsupported" ? "unsupported" : outcome;
      // An honest refusal is a valid result; a timeout or a failure is not.
      record(`video:${id}`, outcome === "unsupported", row);
      await closeTabs(view, ["reader"]);
      return;
    }
    timings.videoFirstFrameMs!.push(Date.now() - clicked);

    // Decoding: the element shows a real picture and plays forward.
    await until<boolean>(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); return v && v.readyState >= 2; })()`, 15_000);
    const probed = (await call("video.probe", { resourceId: found.resourceId })).value as { probe?: { startMs?: number } } | undefined;
    // The element's clock starts at the container's start time for an original; a play copy starts at zero.
    const origin = row.path === "original" ? Number(probed?.probe?.startMs ?? 0) : 0;
    row.originMs = origin;
    const element = await js<Record<string, unknown>>(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); return v ? { readyState: v.readyState, width: v.videoWidth, height: v.videoHeight, duration: v.duration, src: v.currentSrc.split(":")[0] } : null; })()`);
    row.element = element;
    const decodedOk = Boolean(element && Number(element.readyState) >= 2 && Number(element.width) > 0);
    const t0 = await js<number>(view, `document.querySelector('[data-testid="video-element"]').currentTime`);
    await clickTestId(view, "video-toggle");
    row.rvfc = await js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); return v ? { has: typeof v.requestVideoFrameCallback, mediaTime: v.dataset.mediaTime ?? null, paused: v.paused, readyState: v.readyState, hidden: document.hidden, visibility: document.visibilityState } : null; })()`);
    const advanced = await until<number>(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); return v && v.currentTime - ${t0} > 0.6 ? v.currentTime - ${t0} : null; })()`, 10_000);
    await clickTestId(view, "video-toggle");
    row.playedTo = advanced;
    // The picture is really made (AT-84): the element counted decoded frames and no "no picture" notice stands over it.
    row.picture = await js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null; return { decodedFrames: q ? q.totalVideoFrames : null, droppedFrames: q ? q.droppedVideoFrames : null, notice: Boolean(document.querySelector('[data-testid="video-health"]')) }; })()`);
    await capture(`ui-media-video-${id}.png`);
    if (id === "video-mp4-h264-aac") {
      const full = await fullscreenRoundTrip(view, { button: "video-fullscreen", root: "video-shell", evidenceDir: evidence, shot: "ui-fullscreen-video.png" });
      record("fullscreen:video", full.ok, full);
    }

    // A typed time lands on the frame that contains it, on the picture the player presented.
    const frames: Array<Record<string, unknown>> = [];
    const total = Number(((await call("video.frameIndex", { resourceId: found.resourceId, frame: 0 })).value as { totalFrames?: number } | undefined)?.totalFrames ?? 0);
    for (const frame of [Math.floor(total * 0.1), Math.floor(total * 0.5), Math.max(0, total - 3)]) {
      const expected = (await call("video.frameIndex", { resourceId: found.resourceId, frame })).value as { ptsMs?: number } | undefined;
      // The clock counts from the file's own start, so the time typed is the frame's time without the container's offset.
      const typed = clockText(Math.ceil(Number(expected?.ptsMs ?? 0)));
      const started = Date.now();
      await typeTime(typed);
      const landed = await until<{ mediaTime: number; verified: string | null }>(view, `(() => {
        const v = document.querySelector('[data-testid="video-element"]');
        const f = document.querySelector('[data-testid="video-frame"]');
        const t = Number(v?.dataset.mediaTime);
        const pts = ${Number(expected?.ptsMs ?? -1) + origin};
        return Number.isFinite(t) && Math.abs(t - pts) <= 1 ? { mediaTime: t, verified: f?.getAttribute("data-verified") ?? null } : null;
      })()`, 8_000);
      const elapsed = Date.now() - started;
      if (landed) timings.videoFrameSeekMs!.push(elapsed);
      const after = await js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); const f = document.querySelector('[data-testid="video-frame"]'); return { mediaTime: v?.dataset.mediaTime ?? null, currentTime: v?.currentTime ?? null, frame: f?.getAttribute("data-frame") ?? null, verified: f?.getAttribute("data-verified") ?? null, error: document.querySelector('[data-testid="video-input-error"]')?.textContent ?? null }; })()`);
      frames.push({ after, frame, typed, expectedMs: expected?.ptsMs ?? null, landed: Boolean(landed), verified: landed?.verified ?? null, ms: elapsed });
    }
    row.frames = frames;
    const framesOk = frames.length > 0 && frames.every((item) => item.landed === true);

    // Subtitles: JASSUB must load from the packaged files and draw; compare the picture with and without the track.
    let subtitles: Record<string, unknown> | null = null;
    if (id === "video-mkv-ass-fonts") {
      await typeTime("0:02.000");
      await sleep(1200);
      const notice = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="video-subtitle-notice"]'))`);
      const rect = await js<{ x: number; y: number; width: number; height: number } | null>(view, `(() => { const r = document.querySelector('[data-testid="video-element"]')?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null; })()`);
      const on = rect ? await view.webContents.capturePage(rect, { stayAwake: true }) : null;
      await openMore();
      await clickTestId(view, "video-subtitles");
      await clickTestId(view, "video-subtitles-off");
      await sleep(800);
      const off = rect ? await view.webContents.capturePage(rect, { stayAwake: true }) : null;
      let differing = 0;
      if (on && off) {
        const a = on.toBitmap();
        const b = off.toBitmap();
        for (let i = 0; i + 3 < Math.min(a.length, b.length); i += 4) {
          if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) > 90) differing += 1;
        }
      }
      if (on && evidence) fs.writeFileSync(path.join(evidence, "ui-media-video-subtitles-on.png"), on.toPNG());
      if (off && evidence) fs.writeFileSync(path.join(evidence, "ui-media-video-subtitles-off.png"), off.toPNG());
      subtitles = { loadFailedNotice: notice, differingPixels: differing, rect };
    }
    if (subtitles) row.subtitles = subtitles;
    const subtitlesOk = !subtitles || (subtitles.loadFailedNotice === false && Number(subtitles.differingPixels) > 200);

    // Position survives leaving and coming back.
    await closeTabs(view, ["reader"]);
    await sleep(500);
    const picture = row.picture as { decodedFrames: number | null; notice: boolean } | undefined;
    const pictureOk = Boolean(picture && Number(picture.decodedFrames) > 0 && picture.notice === false);
    row.result = decodedOk && Number(advanced ?? 0) > 0.6 && framesOk && subtitlesOk && pictureOk ? "passed" : "failed";
    record(`video:${id}`, row.result === "passed", row);
  };
  for (const id of videoCases) {
    if (only?.length && !only.includes(id)) continue;
    const mark = matrix.length;
    try {
      await runVideo(id);
    } catch (error) {
      const row = matrix[mark] ?? { sample: id };
      if (!matrix[mark]) matrix.push(row);
      row.result = crash ? "renderer-crashed" : "error";
      row.error = String(error);
      if (crash) row.crash = crash;
      record(`video:${id}`, false, row);
    }
    if (crash) {
      crash = null;
      await view.webContents.reload();
      await toRail(view);
    }
  }

  // ------------------------------------------------------------------ subtitles by the standard (AT-69)
  // The text subtitles are drawn by the player's own layer. What is measured is what the window shows: the zones and lines as laid out, against the
  // picture worked out from the video's own size, in the three window sizes and in full screen, for a 16:9 and a 2.39:1 picture.
  const subtitleOnly = !only?.length || only.some((item) => item.startsWith("subtitles"));
  if (subtitleOnly) {
    const verdict = (id: string, result: Verdict, extra: Record<string, unknown> = {}) => record(`subtitles:${id}`, result.ok, { ...result.numbers, failures: result.failures, ...extra });
    /**
     * Jump to a time and measure what the layer shows there. A measure counts once the cue that belongs to that time is on screen (`expect` is a
     * piece of its text: lines left from the time before do not count) and the layout has stopped changing (two equal reads 200 ms apart: a window that
     * is still being resized does not count). If it never settles, the last measure is returned so that the judge reports what is wrong.
     */
    const showing = async (time: string, lines: number, captions = 0, expect?: string): Promise<Measure | null> => {
      await typeTime(time);
      const ready = `(() => { const m = ${MEASURE}; if (!m || m.lines.length < ${lines} || m.captions.length < ${captions}) return null; ${expect ? `if (![...m.lines, ...m.captions].some((item) => item.text.includes(${JSON.stringify(expect)}))) return null;` : ""} return m; })()`;
      const deadline = Date.now() + 8000;
      let last: Measure | null = null;
      let lastKey = "";
      while (Date.now() < deadline) {
        const measure = await js<Measure | null>(view, ready);
        const key = JSON.stringify(measure);
        if (measure && key === lastKey) return measure;
        last = measure;
        lastKey = key;
        await sleep(200);
      }
      return last;
    };
    const resize = async (name: keyof typeof WINDOW_SIZES) => { view.setContentSize(WINDOW_SIZES[name][0], WINDOW_SIZES[name][1]); await sleep(500); };
    const openVideo = async (id: string): Promise<{ resourceId: string } | null> => {
      let file: string;
      try { file = id === "video-mkv-srt-tracks" ? samplePath(id) : path.join(samplePath(id), "episode.mp4"); } catch (error) { record(`subtitles:${id}`, true, { skipped: String(error) }); return null; }
      const imported = await importThroughLibrary(file, "file", "video", id !== "video-mkv-srt-tracks");
      const found = imported.ok ? await resourceOf(imported.workIds[0]!) : null;
      if (!found) { record(`subtitles:${id}:open`, false, { stage: imported.ok ? "resource" : "import" }); return null; }
      await toRail(view);
      await openFromShelf(view, "video", found.resourceId, 10_000);
      const ready = await until<boolean>(view, `Boolean(document.querySelector('[data-testid="video-reader"][data-ready]'))`, 40_000);
      if (!ready) { record(`subtitles:${id}:open`, false, { stage: "player" }); return null; }
      return found;
    };
    const tracksOf = async (resourceId: string) => ((await call("video.subtitles", { resourceId })).value as { subtitles: Array<{ id: string; title: string | null; language: string | null }> }).subtitles;
    // Every menu this section opens is hit-tested before an item is picked (AT-89): a menu that is in the page but cannot be clicked fails here.
    const menuHits = { checked: 0, failures: [] as string[] };
    const choose = async (menu: string, trackId: string, whileOpen?: () => Promise<void>) => {
      await openMore();
      await clickTestId(view, menu);
      await sleep(150);
      const report = await hitTestOpenPopup(view);
      menuHits.checked += 1;
      if (!report.found || !report.topLayer || report.items.length === 0 || report.items.some((item) => !item.hit || !item.inView)) menuHits.failures.push(menu);
      await whileOpen?.();
      return clickTestId(view, `${menu}-${trackId}`);
    };
    const inFullscreen = async <T>(work: () => Promise<T>): Promise<T | null> => {
      const wasFull = view.isFullScreen();
      if (!await trustedClick(view, "video-fullscreen")) return null;
      await until<boolean>(view, `document.fullscreenElement !== null`, 4000);
      await sleep(700);
      try { return await work(); } finally {
        view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await until<boolean>(view, `document.fullscreenElement === null`, 3000);
        if (view.isFullScreen() !== wasFull) { await trustedClick(view, "video-fullscreen"); await until<boolean>(view, `document.fullscreenElement === null`, 3000); }
        await sleep(400);
      }
    };

    // ---- the subtitles in a screenshot (AT-109) ----
    // Pictures are taken with the player's own button while the film is held on one frame, and the file the app keeps is read back and compared with the
    // same frame taken without a track: the difference is the subtitle's ink, and it has to lie where the layer had the lines. Then the setting is turned
    // off, the player is opened again and the same frame is taken once more: no ink, the text still in the record.
    const subtitlesInShots = async (screen: Measure, resourceId: string, secondaryId: string) => {
      const note = (id: string, result: ShotVerdict, extra: Record<string, unknown> = {}) => record(`subtitles:${id}`, result.ok, { ...result.numbers, failures: result.failures, ...extra });
      const holdAtTwo = async () => {
        await js(view, `(() => { document.querySelector('[data-testid="video-element"]')?.pause(); return true; })()`);
        await typeTime("0:02.000");
        await sleep(500);
      };
      const lineCount = (lines: number, captions: number) => until<boolean>(view, `document.querySelectorAll('[data-testid="subtitle-line"]').length === ${lines} && document.querySelectorAll('[data-testid="subtitle-caption"]').length === ${captions}`, 6000);
      const keep = (name: string, shot: { file: string } | null) => { if (shot && evidence) fs.copyFileSync(shot.file, path.join(evidence, name)); };
      try {
        await holdAtTwo();
        const withBoth = await takeShot(view, appService);
        await choose("video-subtitles", "secondary-off");
        await lineCount(1, screen.captions.length);
        await holdAtTwo();
        const withMain = await takeShot(view, appService);
        await choose("video-subtitles", "off");
        await lineCount(0, 0);
        await holdAtTwo();
        const without = await takeShot(view, appService);
        if (!withBoth || !withMain || !without) { record("subtitles:shot-text", false, { taken: [Boolean(withBoth), Boolean(withMain), Boolean(without)] }); return; }
        keep("ui-shot-subtitles-both.png", withBoth);
        keep("ui-shot-subtitles-none.png", without);
        const texts = screen.lines.map((line) => line.text);
        note("shot-text", judgeTextShot({ withTracks: withBoth, without, screen, fewer: withMain, expectTexts: texts }), { lines: texts.length, captions: screen.captions.length });

        await call("settings.setMedia", { video: { shotSubtitles: false } });
        await closeTabs(view, ["reader"]);
        await sleep(500);
        await openFromShelf(view, "video", resourceId, 10_000);
        const ready = await until<boolean>(view, `Boolean(document.querySelector('[data-testid="video-reader"][data-ready]'))`, 40_000);
        if (!ready) { record("subtitles:shot-setting-off", false, { stage: "player" }); return; }
        await choose("video-subtitles", `secondary-${secondaryId}`);
        await lineCount(screen.lines.length, screen.captions.length);
        await holdAtTwo();
        const off = await takeShot(view, appService);
        if (!off) { record("subtitles:shot-setting-off", false, { taken: false }); return; }
        keep("ui-shot-subtitles-setting-off.png", off);
        note("shot-setting-off", judgeSettingOff({ off, without, expectTexts: texts }));
      } catch (error) {
        record("subtitles:shot-text", false, { error: String(error) });
      } finally {
        await call("settings.setMedia", { video: { shotSubtitles: true } });
      }
    };

    try {
      // ---- 16:9, a sidecar SRT ----
      const sixteenNine = await openVideo("video-subtitle-layout");
      if (sixteenNine) {
        const tracks = await tracksOf(sixteenNine.resourceId);
        const byName = (name: string) => tracks.find((track) => track.title === name)!;
        // The default track is the Chinese one; a first cue shows by the standard in each window size.
        for (const size of ["wide", "narrow", "short"] as const) {
          await resize(size);
          const m = await showing("0:02.000", 1, 0, "第一句台词");
          if (!m) { record(`subtitles:layout:${size}`, false, { shown: false }); continue; }
          verdict(`layout:${size}`, judgeDialogue(m, { lines: 1 }));
          await capture(`ui-subtitles-16x9-${size}.png`);
        }
        await resize("wide");
        const two = await showing("0:05.000", 2, 0, "你要去哪里");
        if (two) verdict("two-speakers", judgeDialogue(two, { lines: 2, small: 0 })); else record("subtitles:two-speakers", false, { shown: false });
        const long = await showing("0:08.000", 1, 0, "第三句");
        if (long) verdict("long-line", judgeDialogue(long, { lines: 1 }), { wrapped: long.lines[0] ? long.lines[0].box.h > long.lines[0].size * 1.5 : null }); else record("subtitles:long-line", false, { shown: false });

        // On and off differ where the zone is: the subtitle is really drawn.
        const withZone = await showing("0:02.000", 1, 0, "第一句台词");
        if (withZone?.zone) {
          const rect = { x: Math.round(withZone.zone.x), y: Math.round(withZone.zone.y), width: Math.max(1, Math.round(withZone.zone.w)), height: Math.max(1, Math.round(withZone.zone.h)) };
          const on = await view.webContents.capturePage(rect, { stayAwake: true });
          await openMore();
          await clickTestId(view, "video-subtitles");
          await clickTestId(view, "video-subtitles-off");
          await sleep(500);
          const off = await view.webContents.capturePage(rect, { stayAwake: true });
          let differing = 0;
          const a = on.toBitmap();
          const b = off.toBitmap();
          for (let i = 0; i + 3 < Math.min(a.length, b.length); i += 4) if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) > 90) differing += 1;
          if (evidence) { fs.writeFileSync(path.join(evidence, "ui-subtitles-zone-on.png"), on.toPNG()); fs.writeFileSync(path.join(evidence, "ui-subtitles-zone-off.png"), off.toPNG()); }
          record("subtitles:drawn-pixels", differing > 100, { differingPixels: differing, zone: rect });
          await choose("video-subtitles", byName("episode.zh-CN.srt").id);
        } else record("subtitles:drawn-pixels", false, { shown: false });

        // A bilingual cue: Chinese at the standard height, the other language under it at 75%.
        await choose("video-subtitles", byName("episode.bilingual.srt").id);
        const bilingual = await showing("0:02.000", 2, 0, "The first line");
        if (bilingual) verdict("bilingual", judgeDialogue(bilingual, { lines: 2, small: 1 }), { order: bilingual.lines.map((line) => line.text) }); else record("subtitles:bilingual", false, { shown: false });

        // A caption marked for the top, with dialogue at the same time; and a WebVTT cue placed near the top.
        await choose("video-subtitles", byName("episode.signs.srt").id);
        const sign = await showing("0:02.000", 1, 1, "区役所");
        if (sign) { verdict("top-caption-srt", judgeTopCaption(sign)); verdict("top-caption-with-dialogue", judgeDialogue(sign, { lines: 1 })); await capture("ui-subtitles-top-caption.png"); } else record("subtitles:top-caption-srt", false, { shown: false });
        await choose("video-subtitles", byName("episode.top.vtt").id);
        const vtt = await showing("0:02.000", 0, 1, "屏幕上方的说明");
        if (vtt) verdict("top-caption-vtt", judgeTopCaption(vtt)); else record("subtitles:top-caption-vtt", false, { shown: false });

        // Full screen keeps the shares.
        await choose("video-subtitles", byName("episode.zh-CN.srt").id);
        const full = await inFullscreen(async () => { const m = await showing("0:02.000", 1, 0, "第一句台词"); await capture("ui-subtitles-fullscreen.png"); return m; });
        if (full) verdict("fullscreen", judgeDialogue(full, { lines: 1 })); else record("subtitles:fullscreen", false, { entered: false });
        await closeTabs(view, ["reader"]);
        await sleep(400);
      }

      // ---- 2.39:1, the dialogue on the black bar under the picture ----
      const wide = await openVideo("video-widescreen-subs");
      if (wide) {
        for (const size of ["wide", "narrow", "short"] as const) {
          await resize(size);
          const m = await showing("0:02.000", 1, 0, "第一句台词");
          if (!m) { record(`subtitles:widescreen:${size}`, false, { shown: false }); continue; }
          verdict(`widescreen:${size}`, judgeDialogue(m, { lines: 1 }), { expectedPlace: expectedPlace(m) });
          if (size === "wide") await capture("ui-subtitles-239-wide.png");
        }
        await resize("wide");
        const full = await inFullscreen(async () => { const m = await showing("0:02.000", 1, 0, "第一句台词"); await capture("ui-subtitles-239-fullscreen.png"); return m; });
        if (full) verdict("widescreen:fullscreen", judgeDialogue(full, { lines: 1 }), { expectedPlace: expectedPlace(full) }); else record("subtitles:widescreen:fullscreen", false, { entered: false });
        await closeTabs(view, ["reader"]);
        await sleep(400);
      }

      // ---- embedded text tracks: a top caption from the file, and a second track under the first ----
      const embedded = await openVideo("video-mkv-srt-tracks");
      if (embedded) {
        const tracks = await tracksOf(embedded.resourceId);
        const chinese = tracks.find((track) => track.language === "chi");
        const english = tracks.find((track) => track.language === "eng");
        const m = await showing("0:02.000", 1, 1, "区役所");
        if (m) { verdict("embedded-top-caption", judgeTopCaption(m)); verdict("embedded-dialogue", judgeDialogue(m, { lines: 1 })); } else record("subtitles:embedded-top-caption", false, { shown: false });
        if (english && chinese) {
          // One button holds both choices (AT-107): its menu has the main and the second subtitle as two titled groups, each hit-tested with the rest.
          const picked = await choose("video-subtitles", `secondary-${english.id}`, async () => {
            const groups = await js<string[]>(view, `[...document.querySelectorAll('[data-testid^="video-subtitles-group-"]')].map((node) => document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent ?? "")`);
            const buttons = await js<number>(view, `document.querySelectorAll('[data-testid="video-subtitles"],[data-testid="video-subtitles-secondary"]').length`);
            record("subtitles:one-button-two-groups", groups.length === 2 && groups[0] === "主字幕" && (groups[1] ?? "").startsWith("次字幕") && buttons === 1, { groups, buttons });
          });
          const both = picked ? await showing("0:02.000", 2, 1, "The first line") : null;
          if (both) verdict("secondary-track", judgeDialogue(both, { lines: 2, small: 1 }), { order: both.lines.map((line) => line.text) }); else record("subtitles:secondary-track", false, { picked });
          if (both) await subtitlesInShots(both, embedded.resourceId, english.id);
        } else record("subtitles:secondary-track", false, { tracks: tracks.length });
        await closeTabs(view, ["reader"]);
        await sleep(400);
      }
    } catch (error) {
      record("subtitles:error", false, { error: String(error), crashed: crash });
    } finally {
      view.setContentSize(WINDOW_SIZES.wide[0], WINDOW_SIZES.wide[1]);
    }
    record("subtitles:menus-hit-testable", menuHits.checked > 0 && menuHits.failures.length === 0, menuHits);
  }

  // ------------------------------------------------------------------ the episode and audio menus (AT-89)
  // The window walk plays one file with one audio track, so its bar has no episode or audio menu. A folder of episodes and a file with two audio
  // tracks bring both. Each menu is opened with a real click and every item hit-tested, in the window and in screen full screen; then another item
  // is picked with a real click, and the menu opened again says the player took it.
  const menusOnly = !only?.length || only.some((item) => item.startsWith("menus"));
  if (menusOnly) {
    const detail: Record<string, unknown> = {};
    const problems: string[] = [];
    const pause = () => js(view, `(() => { document.querySelector('[data-testid="video-element"]')?.pause(); return true; })()`);
    const ready = () => until<boolean>(view, `Boolean(document.querySelector('[data-testid="video-reader"][data-ready]'))`, 60_000);
    const openSample = async (id: string, mode: "file" | "directory"): Promise<boolean> => {
      let target: string;
      try { target = samplePath(id); } catch (error) { problems.push(`${id}: ${String(error)}`); return false; }
      const imported = await importThroughLibrary(target, mode, "video");
      const found = imported.ok ? await resourceOf(imported.workIds[0]!) : null;
      if (!found) { problems.push(`${id}: it did not come in through the library`); return false; }
      await toRail(view);
      await openFromShelf(view, "video", found.resourceId, 10_000);
      if (!await ready()) { problems.push(`${id}: the player did not become ready`); return false; }
      return true;
    };
    /** Open `menu` with a real click and hit-test every item; returns the enabled items and the checked one, and leaves the menu open. */
    const openAndTest = async (label: string, menu: string): Promise<{ ids: string[]; checked: string | null } | null> => {
      await pause();
      // A narrow bar keeps its menus in the "…" panel.
      if (!await centreOf(view, menu)) await realClick(view, "video-more");
      if (!await realClick(view, menu)) { problems.push(`${label}: the bar has no ${menu} menu`); return null; }
      await until<boolean>(view, `Boolean(document.querySelector('.popup[role="menu"]'))`, 2000);
      await sleep(150);
      const report = await hitTestOpenPopup(view);
      const bad = report.items.filter((item) => !item.hit || !item.inView).map((item) => item.id);
      detail[label] = { items: report.items.length, topLayer: report.topLayer, box: report.box, ...(bad.length ? { bad } : {}) };
      if (!report.found) problems.push(`${label}: the menu did not open`);
      else if (!report.topLayer) problems.push(`${label}: the menu is not on the top layer`);
      else if (report.items.length < 2) problems.push(`${label}: the menu has fewer than two items`);
      else if (bad.length) problems.push(`${label}: clicking the centre of ${bad.join(", ")} reaches something else`);
      return js<{ ids: string[]; checked: string | null }>(view, `(() => {
        const items = [...document.querySelectorAll('.popup[role="menu"] button')];
        const id = (el) => (el.getAttribute("data-testid") ?? "").slice(${menu.length + 1});
        const checked = items.find((el) => el.getAttribute("aria-checked") === "true");
        return { ids: items.filter((el) => !el.disabled).map(id), checked: checked ? id(checked) : null };
      })()`);
    };
    /** A click on the picture, away from the menu, closes it (in screen full screen Esc is the browser's); the click also toggles playing, so pause again. */
    const closeMenu = async () => {
      const at = await centreOf(view, "video-stage");
      if (at) {
        view.webContents.sendInputEvent({ type: "mouseDown", x: at.x, y: Math.round(at.y / 2), button: "left", clickCount: 1 });
        view.webContents.sendInputEvent({ type: "mouseUp", x: at.x, y: Math.round(at.y / 2), button: "left", clickCount: 1 });
      }
      if (!await until<boolean>(view, `!document.querySelector('.popup[role="menu"]')`, 2000)) problems.push("a click outside did not close a menu");
      await sleep(150);
      await pause();
    };
    const inFullscreen = async (work: () => Promise<void>) => {
      const wasFull = view.isFullScreen();
      if (!await realClick(view, "video-fullscreen") || !await until<boolean>(view, `document.fullscreenElement !== null`, 4000)) { problems.push("screen full screen did not start"); return; }
      await sleep(700);
      try { await work(); } finally {
        view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await until<boolean>(view, `document.fullscreenElement === null`, 3000);
        if (view.isFullScreen() !== wasFull) { await realClick(view, "video-fullscreen"); await until<boolean>(view, `document.fullscreenElement === null`, 3000); }
        await sleep(400);
      }
    };
    /** Both window states, then a pick of another item; `settle` waits for what the pick reloads. */
    const walk = async (name: string, menu: string) => {
      const listed = await openAndTest(name, menu);
      if (listed) await closeMenu();
      await inFullscreen(async () => { if (await openAndTest(`${name}-fullscreen`, menu)) await closeMenu(); });
      const other = listed?.ids.find((id) => id !== listed.checked);
      if (!other) { problems.push(`${name}: the menu offers nothing else to pick`); return; }
      if (!await openAndTest(`${name}-pick`, menu)) return;
      await realClick(view, `${menu}-${other}`);
      if (!await until<boolean>(view, `!document.querySelector('.popup[role="menu"]')`, 2000)) problems.push(`${name}: picking an item did not close the menu`);
      await sleep(800);
      // Another audio track of a file that plays as it is needs a play copy, made when the person asks (the player says so); the walk asks.
      const state = await until<string>(view, `document.querySelector('[data-testid="video-reader"][data-ready]') ? "ready" : document.querySelector('[data-testid="video-needs-copy"]') ? "needs-copy" : null`, 60_000);
      if (state === "needs-copy") {
        detail[`${name}-copy`] = true;
        await clickTestId(view, "video-make-copy");
        if (!await until<boolean>(view, `Boolean(document.querySelector('[data-testid="video-reader"][data-ready]'))`, 180_000)) { problems.push(`${name}: the play copy for the pick did not become ready`); return; }
      } else if (state !== "ready") { problems.push(`${name}: the player was not ready after the pick`); return; }
      const after = await openAndTest(`${name}-after`, menu);
      if (after) await closeMenu();
      detail[`${name}-picked`] = { from: listed?.checked ?? null, to: other, now: after?.checked ?? null };
      if (after?.checked !== other) problems.push(`${name}: the player did not take the pick (${after?.checked ?? "nothing"} is checked, not ${other})`);
    };
    try {
      if (await openSample("video-episodes", "directory")) {
        await walk("episodes", "video-episodes");
        await closeTabs(view, ["reader"]);
        await sleep(400);
      }
      if (await openSample("video-mkv-ass-fonts", "file")) {
        await walk("audio", "video-audio");
        await closeTabs(view, ["reader"]);
        await sleep(400);
      }
    } catch (error) {
      problems.push(`error: ${String(error)}`);
    }
    record("menus:episodes-audio", problems.length === 0, { ...detail, problems });
  }

  // ------------------------------------------------------------------ the picture and the fonts (AT-84)
  // A video whose ASS styles name fonts nobody has must still show Chinese and Japanese as letters, not boxes, and the debug panel must say how the
  // picture is being made. The first line of the sample is ten different characters; with the track on and off the difference is the ink of that line,
  // cut into one cell per character: boxes are ten equal cells, letters are ten shapes.
  const pictureOnly = !only?.length || only.some((item) => item.startsWith("picture"));
  if (pictureOnly) {
    try {
      let file: string | null = null;
      try { file = samplePath("video-mkv-ass-missing-font"); } catch (error) { record("picture:missing-font", true, { skipped: String(error) }); }
      const imported = file ? await importThroughLibrary(file, "file", "video") : null;
      const found = imported?.ok ? await resourceOf(imported.workIds[0]!) : null;
      if (file && !found) record("picture:missing-font:open", false, { stage: imported?.ok ? "resource" : "import" });
      if (found) {
        await toRail(view);
        const opened = await openFromShelf(view, "video", found.resourceId, 10_000);
        const ready = await until<boolean>(view, `Boolean(document.querySelector('[data-testid="video-reader"][data-ready]'))`, 40_000);
        // What the window shows instead of a ready player, so a failure says where it stopped.
        if (!ready) record("picture:missing-font:open", false, { stage: "player", opened, showing: await js<string[]>(view, `[...document.querySelectorAll('[data-testid^="page-"], [data-testid^="video-"]')].map((el) => el.getAttribute("data-testid")).filter((id) => !/^video-(row|frame|time)/.test(id)).slice(0, 20)`) });
        else {
          view.setContentSize(WINDOW_SIZES.wide[0], WINDOW_SIZES.wide[1]);
          await sleep(500);
          const track = ((await call("video.subtitles", { resourceId: found.resourceId })).value as { subtitles: Array<{ id: string }> }).subtitles[0];
          await typeTime("0:02.000");
          await sleep(1200);
          const rect = await js<{ x: number; y: number; width: number; height: number } | null>(view, `(() => { const r = document.querySelector('[data-testid="video-element"]')?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null; })()`);
          const pick = async (menu: string, id: string) => { await openMore(); await clickTestId(view, menu); return clickTestId(view, `${menu}-${id}`); };
          // The picture without the track, then with it; the renderer starts its worker and loads the fonts first, so ask until the ink is there.
          await openMore();
          await clickTestId(view, "video-subtitles");
          await clickTestId(view, "video-subtitles-off");
          await sleep(800);
          const off = rect ? await view.webContents.capturePage(rect, { stayAwake: true }) : null;
          // The picture the player's button saves with the track off: the other half of the comparison for AT-109.
          await js(view, `(() => { document.querySelector('[data-testid="video-element"]')?.pause(); return true; })()`);
          const shotOff = off ? await takeShot(view, appService) : null;
          if (track) await pick("video-subtitles", track.id);
          let on = null as Awaited<ReturnType<typeof view.webContents.capturePage>> | null;
          let mask: Uint8Array | null = null;
          let inkPixels = 0;
          const deadline = Date.now() + 20_000;
          while (rect && off && Date.now() < deadline) {
            await sleep(500);
            on = await view.webContents.capturePage(rect, { stayAwake: true });
            mask = differenceMask(on.toBitmap(), off.toBitmap());
            inkPixels = mask.reduce((sum, value) => sum + value, 0);
            if (inkPixels >= 300) break;
          }
          if (on && evidence) fs.writeFileSync(path.join(evidence, "ui-picture-missing-font-on.png"), on.toPNG());
          if (off && evidence) fs.writeFileSync(path.join(evidence, "ui-picture-missing-font-off.png"), off.toPNG());
          const size = on?.getSize() ?? { width: 0, height: 0 };
          const cells = mask ? glyphCells(mask, size.width, size.height, 10) : null;
          record("picture:missing-font-glyphs", Boolean(cells && cells.inked >= 8 && cells.distinct >= 8), { inkPixels, cells, rect });

          // AT-109: the same frame saved with the track on. The renderer draws it again at the size of the file; the file the app keeps must hold the
          // ink as letters, at the place and the share of the picture the window showed it, and the record must say the subtitles were drawn.
          const shotOn = shotOff && inkPixels >= 300 ? await takeShot(view, appService) : null;
          const measured = await js<Measure | null>(view, MEASURE);
          const screenInk = mask && rect ? inkIn(mask, size.width, size.height) : null;
          const scale = rect && size.width > 0 ? size.width / rect.width : 1;
          const screenShare = screenInk && rect && measured
            ? { bottom: (rect.y + (screenInk.y1 + 1) / scale - measured.picture.y) / measured.picture.h, centre: (rect.x + (screenInk.x0 + screenInk.x1 + 1) / 2 / scale - measured.picture.x) / measured.picture.w }
            : null;
          if (shotOff && shotOn) {
            const result = judgeAssShot({ on: shotOn, off: shotOff, screen: screenShare, letters: 10 });
            record("picture:shot-ass-subtitles", result.ok, { ...result.numbers, failures: result.failures, screenMeasured: screenShare !== null });
            if (evidence) { fs.copyFileSync(shotOn.file, path.join(evidence, "ui-shot-ass-on.png")); fs.copyFileSync(shotOff.file, path.join(evidence, "ui-shot-ass-off.png")); }
          } else record("picture:shot-ass-subtitles", false, { off: Boolean(shotOff), on: Boolean(shotOn), inkPixels });

          // The debug panel says how the picture is made, with the numbers of the element itself.
          await clickTestId(view, "debug-toggle");
          await clickTestId(view, "debug-tab-current");
          const row = await until<boolean>(view, `Boolean(document.querySelector('[data-testid="debug-video"]'))`, 5000);
          const facts = row ? await js<Record<string, string | null>>(view, `(() => { const q = (id) => document.querySelector('[data-testid="' + id + '"]'); const root = q("debug-video"); return { health: root?.getAttribute("data-health") ?? null, decoded: root?.getAttribute("data-decoded") ?? null, readyState: root?.getAttribute("data-ready-state") ?? null, playing: q("debug-video-playing")?.textContent ?? null, element: q("debug-video-element")?.textContent ?? null, subtitles: q("debug-video-subtitles")?.textContent ?? null, banner: q("video-health") ? "shown" : "none" }; })()`) : null;
          const subtitleText = (facts?.subtitles ?? "").toLowerCase();
          record("picture:debug-facts", Boolean(facts && facts.health === "ok" && Number(facts.decoded) > 0 && Number(facts.readyState) >= 2 && facts.banner === "none" && subtitleText.includes("jassub") && subtitleText.includes("zz manga missing sans") && subtitleText.includes("zz manga missing serif") && !subtitleText.includes("jassub-default")), facts ?? { debugVideoRow: false });
          await capture("ui-picture-debug-facts.png");
          await clickTestId(view, "debug-toggle");
        }
        await closeTabs(view, ["reader"]);
        await sleep(400);
      }
    } catch (error) {
      record("picture:error", false, { error: String(error), crashed: crash });
    }
  }

  // ------------------------------------------------------------------ a read-only trial on the developer's own library (by hand, never in the gate)
  // Only when asked for by name (MANGA_SMOKE_ONLY=real) and given a folder; the result is counts and times, with no name, title, path or picture.
  if (process.env.MANGA_SMOKE_REAL_ANIME && only?.includes("real")) {
    try {
      const outcome = await runRealVideoTrial({ appService, view, call, until: (expression, timeoutMs) => until(view, expression, timeoutMs), js: (code) => js(view, code), openMore });
      record("real:video-trial", !("skipped" in outcome), outcome);
    } catch {
      record("real:video-trial", false, { error: "the trial stopped" });
    }
  }

  const failed = steps.filter((step) => !step.ok).map((step) => step.id);
  const summary = Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null, samples: values }]));
  if (evidence) fs.writeFileSync(path.join(evidence, "media-smoke.json"), `${JSON.stringify({ steps, matrix, timings: summary }, null, 2)}\n`);
  return { ok: failed.length === 0, failed, steps, matrix, timings: summary };
}
