import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { clickTestId, openFromShelf, sleep } from "./driver.ts";
import { toRail } from "./common.ts";

/**
 * A read-only trial of the packaged player on the developer's own anime library, run by hand (it is not part of the gate): one folder with
 * several videos becomes a library path of a throwaway profile, a few episodes are opened and played for a few seconds, and what the window did
 * is counted. The folder's path comes from the process environment and is never written anywhere; nothing is copied; no file name, title or
 * picture leaves this function. The result is numbers: first-frame times, decoded and dropped frames, which subtitle renderer and which
 * default font were used, how many fonts the styles asked for that nobody had, and whether the player showed its "no picture" notice. Each episode is also
 * screenshotted with the player's button: how long that took from the click to the notice, which resolutions came out (a count per size, no picture is kept
 * outside the throwaway profile) and whether the picture is the size the film is decoded at. The screenshot is taken with the setting as it ships (the subtitles
 * on the picture): how many records say the subtitles were drawn into it and how many had a line of text at that moment (a picture taken in a gap between
 * lines has none to show).
 */

const VIDEO = /\.(mkv|mp4|m4v|webm|avi|mov|ts)$/i;
const MAX_EPISODES = 4;
const PLAY_MS = 4000;

type Call = (commandId: string, body: Record<string, unknown>) => Promise<{ status: string; value?: unknown }>;
export type TrialInput = {
  appService: MangaProductApp;
  view: BrowserWindow;
  call: Call;
  until: <T>(expression: string, timeoutMs?: number) => Promise<T | null>;
  js: <T>(code: string) => Promise<T>;
  openMore: () => Promise<boolean>;
};
export type TrialResult = {
  folders: number;
  episodes: number;
  firstFrameMs: number[];
  decodedIn4s: number[];
  dropped: number;
  noPicture: number;
  renderer: Record<string, number>;
  defaultFont: Record<string, number>;
  missingFonts: number[];
  subtitleTracks: number[];
  picked: Record<string, number>;
  /** How many tracks of each format (ass, srt, pgs...) the episodes had. */
  formats: Record<string, number>;
  /** The debug line with the font names cut off (a label, the renderer, its state). */
  shape: Record<string, number>;
  /** Milliseconds from choosing a subtitle track to the renderer saying it is ready. */
  subtitleReadyMs: number[];
  /** Milliseconds from the click on the screenshot button to the notice that says it was saved. */
  shotMs: number[];
  /** How many screenshots came out at the size the film is decoded at, and how many did not come out at all. */
  shotSizeMatches: number;
  shotMissing: number;
  /** Why a screenshot did not come out. */
  shotWhy?: string[];
  /** A count per resolution of the screenshots that were saved. */
  shotResolutions: Record<string, number>;
  /** How many records say the subtitles were drawn into the picture, and how many had a line of text at that moment. */
  shotComposited: number;
  shotCue: number;
  /** The same for a picture taken a third of the way into the film, and how many of those were taken. */
  middleShots: number;
  middleComposited: number;
  middleCue: number;
  /** Milliseconds the command that makes the chosen subtitle track readable (taking it out of the container) took. */
  subtitleHandleMs: number[];
};

/** A folder (breadth first, a bounded number of directories looked at) that holds at least two videos; `skip` passes over that many such folders first. */
function findFolder(start: string, skip: number): { folder: string; videos: number } | null {
  const queue = [start];
  let left = skip;
  for (let looked = 0; queue.length && looked < 400; looked += 1) {
    const dir = queue.shift()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    const videos = entries.filter((entry) => entry.isFile() && VIDEO.test(entry.name)).length;
    if (videos >= 2 && left-- <= 0) return { folder: dir, videos };
    for (const entry of entries) if (entry.isDirectory()) queue.push(path.join(dir, entry.name));
  }
  return null;
}

export async function runRealVideoTrial(input: TrialInput): Promise<TrialResult | { skipped: string }> {
  const { appService, view, call, until, js, openMore } = input;
  const start = process.env.MANGA_SMOKE_REAL_ANIME;
  if (!start || !fs.existsSync(start)) return { skipped: "no folder given" };
  const found = findFolder(start, Number(process.env.MANGA_SMOKE_REAL_SKIP ?? 0) || 0);
  if (!found) return { skipped: "no folder with videos" };

  const result: TrialResult = { folders: 1, episodes: 0, firstFrameMs: [], decodedIn4s: [], dropped: 0, noPicture: 0, renderer: {}, defaultFont: {}, missingFonts: [], subtitleTracks: [], picked: {}, formats: {}, shape: {}, subtitleReadyMs: [], shotMs: [], shotSizeMatches: 0, shotMissing: 0, shotResolutions: {}, shotComposited: 0, shotCue: 0, middleShots: 0, middleComposited: 0, middleCue: 0, subtitleHandleMs: [] };
  const listWorks = async () => ((await call("works.list", { limit: 200, group: false })).value as { items: Array<{ id: string }> }).items.map((item) => item.id);
  const before = new Set(await listWorks());
  const added = await call("library.paths.add", { pathHandle: appService.registerPath("directory", found.folder), mediaKind: "video", autoScan: true });
  if (added.status !== "ok") return { skipped: "the folder could not be added" };
  await appService.scan.whenIdle();
  const fresh = (await listWorks()).filter((id) => !before.has(id));
  // One episode per work, as many works as the folder made (up to MAX_EPISODES): each opens from the shelf like a person opens it.
  const episodes: string[] = [];
  for (const workId of fresh.slice(0, MAX_EPISODES)) {
    const got = await call("works.get", { workId });
    const work = got.value as { resources?: Array<{ id: string }>; lastResource?: { id: string } | null } | undefined;
    const id = work?.lastResource?.id ?? work?.resources?.[0]?.id;
    if (id) episodes.push(id);
  }
  if (!episodes.length) return { skipped: "the scan found no episode" };

  for (const episode of episodes) {
    await toRail(view);
    const started = Date.now();
    if (!await openFromShelf(view, "nav-video", episode, 15_000)) { result.noPicture += 1; result.episodes += 1; continue; }
    const playing = await until<boolean>(`(() => { const v = document.querySelector('[data-testid="video-element"]'); return Boolean(v && v.readyState >= 2 && v.getVideoPlaybackQuality().totalVideoFrames > 0); })()`, 40_000);
    result.episodes += 1;
    if (!playing) { result.noPicture += 1; continue; }
    result.firstFrameMs.push(Date.now() - started);
    // The first subtitle track, the ASS one when there is one, as a person who wants subtitles would choose it.
    const tracks = ((await call("video.subtitles", { resourceId: episode })).value as { subtitles?: Array<{ id: string; format?: string; source?: string }> } | undefined)?.subtitles ?? [];
    result.subtitleTracks.push(tracks.length);
    for (const item of tracks) result.formats[String(item.format ?? "?")] = (result.formats[String(item.format ?? "?")] ?? 0) + 1;
    const track = tracks.find((item) => item.format === "ass") ?? tracks[0];
    // Taking the track out of the container reads the file through; this is how long that took, before the renderer is asked for it.
    if (track) {
      const probed = (await call("video.probe", { resourceId: episode })).value as { revisionId?: string } | undefined;
      if (probed?.revisionId) {
        const handleStart = Date.now();
        const handled = await call("video.subtitleHandle", { resourceId: episode, revisionId: probed.revisionId, trackId: track.id });
        if (handled.status === "ok") result.subtitleHandleMs.push(Date.now() - handleStart);
      }
    }
    let pickedAt = Date.now();
    if (track) {
      const menu = await openMore() && await clickTestId(view, "video-subtitles");
      const chosen = menu && await clickTestId(view, `video-subtitles-${track.id}`);
      result.picked[chosen ? "yes" : menu ? "item-missing" : "menu-missing"] = (result.picked[chosen ? "yes" : menu ? "item-missing" : "menu-missing"] ?? 0) + 1;
      pickedAt = Date.now();
    }
    // The debug panel says which renderer draws the subtitles and with which default font; only the kind, a count and a time are kept. The
    // renderer starts after the video's fonts are read, which takes a while on a file that carries many.
    await clickTestId(view, "debug-toggle");
    await clickTestId(view, "debug-tab-current");
    const text = await until<string>(`(() => { const t = document.querySelector('[data-testid="debug-video-subtitles"]')?.textContent ?? ""; return /jassub \\((ready|failed)\\)|text/i.test(t) ? t : null; })()`, 60_000) ?? await js<string>(`document.querySelector('[data-testid="debug-video-subtitles"]')?.textContent ?? ""`);
    if (track) result.subtitleReadyMs.push(Date.now() - pickedAt);
    result.shape[text.replace(/缺失字体.*$/, "缺失字体 …").slice(0, 40)] = 1;
    const decodedBefore = await js<number>(`document.querySelector('[data-testid="video-element"]').getVideoPlaybackQuality().totalVideoFrames`);
    await js(`document.querySelector('[data-testid="video-element"]').play().catch(() => undefined); true`);
    await sleep(PLAY_MS);
    const after = await js<{ decoded: number; dropped: number; banner: boolean }>(`(() => { const q = document.querySelector('[data-testid="video-element"]').getVideoPlaybackQuality(); return { decoded: q.totalVideoFrames, dropped: q.droppedVideoFrames, banner: Boolean(document.querySelector('[data-testid="video-health"]')) }; })()`);
    await js(`document.querySelector('[data-testid="video-element"]').pause(); true`);
    result.decodedIn4s.push(after.decoded - decodedBefore);
    result.dropped += after.dropped;
    if (after.banner) result.noPicture += 1;
    await clickTestId(view, "debug-toggle");
    // A screenshot of the frame the film is paused on, the way a person takes one: first where it stopped after the first seconds, then a third of the
    // way in, where there is more likely to be a line of dialogue on screen.
    const shoot = async (where: "start" | "middle"): Promise<void> => {
      const native = await js<{ w: number; h: number }>(`(() => { const v = document.querySelector('[data-testid="video-element"]'); return { w: v.videoWidth, h: v.videoHeight }; })()`);
      const known = new Set(appService.screenshots.list({ limit: 500 }).items.map((item) => item.id));
      const clickedAt = Date.now();
      const clicked = await clickTestId(view, "video-screenshot", 4000);
      // The record is what counts: the notice of an earlier screenshot may still be on screen, so it is not waited for.
      let saved: ReturnType<typeof appService.screenshots.list>["items"][number] | undefined;
      for (let waited = 0; clicked && !saved && waited < 20_000; waited += 250) {
        saved = appService.screenshots.list({ limit: 500 }).items.find((item) => !known.has(item.id));
        if (!saved) await sleep(250);
      }
      if (!saved) { result.shotMissing += 1; (result.shotWhy ??= []).push(clicked ? "no record within 20 s" : "button not clicked"); return; }
      result.shotMs.push(Date.now() - clickedAt);
      const size = `${saved.width}x${saved.height}`;
      result.shotResolutions[size] = (result.shotResolutions[size] ?? 0) + 1;
      if (saved.width === native.w && saved.height === native.h) result.shotSizeMatches += 1;
      const drawn = saved.meta.composited === "subtitles" || saved.meta.composited === "both";
      const cue = Boolean(saved.subtitleText && saved.subtitleText.trim());
      if (where === "start") { result.shotComposited += drawn ? 1 : 0; result.shotCue += cue ? 1 : 0; }
      else { result.middleShots += 1; result.middleComposited += drawn ? 1 : 0; result.middleCue += cue ? 1 : 0; }
    };
    await shoot("start");
    const moved = await js<boolean>(`(async () => { const v = document.querySelector('[data-testid="video-element"]'); const to = v.duration * 0.35; await new Promise((resolve) => { v.addEventListener("seeked", resolve, { once: true }); v.currentTime = to; setTimeout(resolve, 10000); }); return v.readyState >= 2; })()`);
    if (moved) { await sleep(1200); await shoot("middle"); }
    const line = text ?? "";
    const renderer = /jassub/i.test(line) ? "jassub" : /text|文本/i.test(line) ? "text" : "none";
    const font = /bundled:/.test(line) ? "bundled" : /system:/.test(line) ? "system" : /jassub-default/.test(line) ? "jassub-default" : "-";
    const missing = /缺失字体\s*([^·]*)/.exec(line)?.[1]?.split("、").filter((name) => name.trim()).length ?? 0;
    result.renderer[renderer] = (result.renderer[renderer] ?? 0) + 1;
    result.defaultFont[font] = (result.defaultFont[font] ?? 0) + 1;
    result.missingFonts.push(missing);
  }
  return result;
}
