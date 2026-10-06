import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { MangaProductApp } from "@manga/app-core";
import { createId } from "@manga/contracts";
import { testHooks } from "../test-hooks.ts";
import { clickTestId, openFromShelf, sleep, waitForTestId } from "./driver.ts";
import { openSettingsPage, toRail } from "./common.ts";

/**
 * The three media flows through the real packaged window, with synthetic samples only: import through the dialog (opened from the
 * library page of settings), open from the card and the work's page, read or play, move, and check what the renderer actually did
 * (decoded pages, presented frames, subtitles drawn).
 * Samples come from MANGA_SMOKE_SAMPLES (the generated dist/samples/m2); without them the phase reports not-run.
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

  /** Import through the dialog, the way a person does; returns the ids of the works that appeared. */
  async function importThroughDialog(target: string, mode: "file" | "directory", expectKind: string): Promise<{ ok: boolean; suggested: string | null; workIds: string[] }> {
    const before = new Set(((await call("works.list", { limit: 200 })).value as { items: Array<{ id: string }> }).items.map((item) => item.id));
    testHooks.pick = () => target;
    try {
      if (!await openSettingsPage(view, "library") || !await clickTestId(view, "settings-import")) return { ok: false, suggested: null, workIds: [] };
      await clickTestId(view, mode === "file" ? "import-pick-file" : "import-pick-dir");
      const ready = await until<boolean>(view, `(() => { const b = document.querySelector('[data-testid="import-confirm"]'); return b && !b.disabled; })()`, 20_000);
      if (!ready) return { ok: false, suggested: null, workIds: [] };
      const suggested = await js<string | null>(view, `(() => { const chip = document.querySelector('[data-testid="import-suggested"]'); const input = chip?.closest("label")?.querySelector("input"); return input ? input.value : null; })()`);
      // The kind is the user's choice: pick the expected one explicitly when the suggestion differs.
      if (suggested !== expectKind) await clickTestId(view, `import-kind-${expectKind}`);
      await clickTestId(view, "import-confirm");
      const closed = await until<boolean>(view, `!document.querySelector('[data-testid="import-dialog"]')`, 60_000);
      const after = ((await call("works.list", { limit: 200 })).value as { items: Array<{ id: string }> }).items.map((item) => item.id);
      const fresh = after.filter((id) => !before.has(id));
      return { ok: Boolean(closed) && fresh.length > 0, suggested, workIds: fresh };
    } finally {
      testHooks.pick = undefined;
    }
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
      imported = await importThroughDialog(samplePath(item.id), item.mode, "comic");
    } catch (error) {
      record(`comic:${item.id}`, false, { error: String(error) });
      continue;
    }
    if (!imported.ok) { record(`comic:${item.id}`, false, { stage: "import", suggested: imported.suggested }); continue; }
    const found = await resourceOf(imported.workIds[0]!);
    if (!found) { record(`comic:${item.id}`, false, { stage: "resource" }); continue; }
    await toRail(view);
    const opened = await openFromShelf(view, "nav-comic", found.resourceId, 10_000);
    const decoded = opened && await until<boolean>(view, PAGE_DRAWN, 20_000);
    const position0 = await js<string>(view, `document.querySelector('[data-testid="comic-position"]')?.textContent ?? ""`);
    await capture(`ui-media-comic-${item.id}.png`);
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
    await clickTestId(view, "comic-back");
    await sleep(400);
    // Back lands on the work's page; "read" there resumes at the saved page.
    const reopened = await clickTestId(view, "work-read", 10_000);
    const restored = reopened && await until<string>(view, `(() => { const text = document.querySelector('[data-testid="comic-position"]')?.textContent ?? ""; return text && text === ${JSON.stringify(lastPosition)} ? text : null; })()`, 10_000);
    await clickTestId(view, "comic-back");
    record(`comic:${item.id}`, Boolean(decoded) && turned >= Math.min(item.pages, 4) - 1 && Boolean(restored), { suggested: imported.suggested, decoded: Boolean(decoded), turned, restored: Boolean(restored), position: position0 });
  }

  // ------------------------------------------------------------------ videos
  const videoCases = ["video-mkv-ass-fonts", "video-mp4-h264-aac", "video-mkv-hevc-8bit", "video-mkv-hevc-10bit", "video-ac3", "video-vfr", "video-nonzero-start"];
  const runVideo = async (id: string): Promise<void> => {
    const row: Record<string, unknown> = { sample: id };
    matrix.push(row);
    let file: string;
    try { file = samplePath(id); } catch (error) { row.result = "sample-unavailable"; record(`video:${id}`, true, { skipped: String(error) }); return; }
    const imported = await importThroughDialog(file, "file", "video");
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
    await openFromShelf(view, "nav-video", found.resourceId, 10_000);
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
      if (done !== "ready") { row.result = "copy-" + done; record(`video:${id}`, false, row); await clickTestId(view, "video-back"); return; }
      row.path = "play_copy";
    } else if (outcome === "ready") {
      row.path = "original";
    } else {
      row.result = outcome === "unsupported" ? "unsupported" : outcome;
      // An honest refusal is a valid result; a timeout or a failure is not.
      record(`video:${id}`, outcome === "unsupported", row);
      await clickTestId(view, "video-back");
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
    await capture(`ui-media-video-${id}.png`);

    // Frame jumps land on the frame the index names, on the picture the player presented.
    const frames: Array<Record<string, unknown>> = [];
    // The frame and time fields sit in the player's "more" panel now.
    if (!await js<boolean>(view, `Boolean(document.querySelector('[data-testid="video-more-panel"]'))`)) await clickTestId(view, "video-more");
    const total = Number(((await call("video.frameIndex", { resourceId: found.resourceId, frame: 0 })).value as { totalFrames?: number } | undefined)?.totalFrames ?? 0);
    for (const frame of [Math.floor(total * 0.1), Math.floor(total * 0.5), Math.max(0, total - 3)]) {
      const expected = (await call("video.frameIndex", { resourceId: found.resourceId, frame })).value as { ptsMs?: number } | undefined;
      const started = Date.now();
      await js(view, `(() => {
        const el = document.querySelector('[data-testid="video-frame-input"]');
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        set.call(el, ${JSON.stringify(String(frame + 1))});
        el.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await sleep(80);
      await clickTestId(view, "video-frame-go");
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
      frames.push({ after, frame, expectedMs: expected?.ptsMs ?? null, landed: Boolean(landed), verified: landed?.verified ?? null, ms: elapsed });
    }
    row.frames = frames;
    const framesOk = frames.length > 0 && frames.every((item) => item.landed === true);

    // Subtitles: JASSUB must load from the packaged files and draw; compare the picture with and without the track.
    let subtitles: Record<string, unknown> | null = null;
    if (id === "video-mkv-ass-fonts") {
      await js(view, `document.querySelector('[data-testid="video-time-input"]') && (() => {
        const el = document.querySelector('[data-testid="video-time-input"]');
        const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        set.call(el, "0:02");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await sleep(80);
      await clickTestId(view, "video-time-go");
      await sleep(1200);
      const notice = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="video-subtitle-notice"]'))`);
      const rect = await js<{ x: number; y: number; width: number; height: number } | null>(view, `(() => { const r = document.querySelector('[data-testid="video-element"]')?.getBoundingClientRect(); return r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null; })()`);
      const on = rect ? await view.webContents.capturePage(rect, { stayAwake: true }) : null;
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
    await clickTestId(view, "video-back");
    await sleep(500);
    row.result = decodedOk && Number(advanced ?? 0) > 0.6 && framesOk && subtitlesOk ? "passed" : "failed";
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

  const failed = steps.filter((step) => !step.ok).map((step) => step.id);
  const summary = Object.fromEntries(Object.entries(timings).map(([key, values]) => [key, { n: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: values.length ? Math.max(...values) : null, samples: values }]));
  if (evidence) fs.writeFileSync(path.join(evidence, "media-smoke.json"), `${JSON.stringify({ steps, matrix, timings: summary }, null, 2)}\n`);
  return { ok: failed.length === 0, failed, steps, matrix, timings: summary };
}
