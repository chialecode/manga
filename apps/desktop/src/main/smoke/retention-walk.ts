import fs from "node:fs";
import type { BrowserWindow } from "electron";
import { readPngText, type MangaProductApp } from "@manga/app-core";
import { DRAWN, clickTestId, pressKey, setField, sleep, waitUntil } from "./driver.ts";
import { caller, ensureDock, js, leaveSettings } from "./common.ts";
import { centreOf, hitTestOpenPopup, realClick } from "./player-menus-walk.ts";
import type { Observe } from "./reader-controls-walk.ts";

/**
 * What the window keeps of a page that is left, and what it saves: the workspace left for the settings view stays where it was (AT-88, AT-122), and a picture of a video and of a
 * comic page is saved at the source's size and put on a whiteboard (AT-91, AT-92). Each is a name the stage requires. They run with the player open and
 * paused, so the checks are about what was kept, not about what was playing.
 */

export const RETENTION_OBSERVATIONS = ["settings-round-trip", "screenshots-into-whiteboard"] as const;

type Call = ReturnType<typeof caller>;
type Shot = (name: string) => Promise<void>;

/** Whether the browser would draw a node: a tab out of sight is `visibility: hidden` in the dock, and a folded column is `display: none`. */
const SHOWN = DRAWN;

type Kept = { time: number; paused: boolean; text: string | null };

/** What the player and the dock hold, and the marks the walk put on the element to tell it from a new one. */
const keptOf = (view: BrowserWindow) => js<Kept & { marked: string | null; loads: number; shown: boolean }>(view, `(() => {
  const shown = ${SHOWN};
  const video = document.querySelector('[data-testid="video-element"]');
  const reader = document.querySelector('[data-testid="video-reader"]');
  const composer = document.querySelector('[data-testid="agent-composer"]');
  return {
    time: video ? video.currentTime : -1,
    paused: video ? video.paused : false,
    marked: video ? (video.__kept ?? null) : null,
    loads: video ? (video.__loads ?? -1) : -1,
    shown: reader ? shown(reader) : false,
    text: composer ? composer.value : null,
  };
})()`);

const pressKeyEscape = (view: BrowserWindow) => pressKey(view, "Escape").then(() => sleep(150));

/** Pause the player in the middle of the film, mark the element, and count the times it would be loaded again. */
async function settleAtMiddle(view: BrowserWindow): Promise<{ ok: boolean; time: number; width: number; height: number }> {
  return js(view, `(async () => {
    const video = document.querySelector('[data-testid="video-element"]');
    if (!video) return { ok: false, time: 0, width: 0, height: 0 };
    video.__kept = "kept";
    video.__loads = 0;
    video.addEventListener("loadstart", () => { video.__loads += 1; });
    video.pause();
    video.currentTime = Math.max(0.5, (video.duration || 2) / 2);
    await new Promise((resolve) => setTimeout(resolve, 600));
    return { ok: video.paused, time: video.currentTime, width: video.videoWidth, height: video.videoHeight };
  })()`);
}

/**
 * AT-88. The viewer is somewhere in a film with a question typed and not sent; the settings view takes the window, one setting is changed, and the viewer leaves
 * the settings with the title bar's back arrow: the same element, not loaded again, at the same second, paused, with the same words in the box.
 */
export async function walkSettingsRoundTrip(view: BrowserWindow, observe: Observe, shot: Shot): Promise<void> {
  const problems: string[] = [];
  await ensureDock(view);
  const middle = await settleAtMiddle(view);
  if (!middle.ok) problems.push("the player could not be paused in the middle");
  await setField(view, "agent-composer", "设置往返前还没发出的问题");
  await sleep(300);
  const before = await keptOf(view);
  await shot("settings-roundtrip-before");

  const opened = await clickTestId(view, "nav-settings") && await waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="settings-nav"]'))`, 6000);
  if (!opened) problems.push("settings did not open");
  const inSettings = await js<{ readerShown: boolean; paused: boolean }>(view, `(() => {
    const shown = ${SHOWN};
    const reader = document.querySelector('[data-testid="video-reader"]');
    const video = document.querySelector('[data-testid="video-element"]');
    return { readerShown: reader ? shown(reader) : false, paused: video ? video.paused : false };
  })()`);
  if (!(await js<boolean>(view, `Boolean(document.querySelector('[data-testid="video-reader"]'))`))) problems.push("the player was taken out of the page when settings opened");
  if (inSettings.readerShown) problems.push("the player is still drawn over settings");
  if (!inSettings.paused) problems.push("the player plays on behind settings");

  // One setting changed: a rate in the player's list. It is saved, and the player offers it when the viewer comes back.
  const onPage = opened && await clickTestId(view, "settings-nav-reading") && await waitUntil(view, `document.querySelector('[data-testid="settings-page-reading"]')`, 6000);
  let rateAdded = false;
  if (onPage) {
    await setField(view, "msettings-rate-new", "1.7");
    await js(view, `document.querySelector('[data-testid="msettings-rate-new"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))`);
    rateAdded = await waitUntil(view, `document.querySelector('[data-testid="msettings-rate-1_7"]')`, 4000);
  }
  if (!rateAdded) problems.push("the rate was not added in settings");
  await shot("settings-roundtrip-settings");

  const back = await leaveSettings(view) && await waitUntil(view, `(() => { const shown = ${SHOWN}; const reader = document.querySelector('[data-testid="video-reader"]'); return Boolean(reader) && shown(reader); })()`, 6000);
  if (!back) problems.push("the player did not come back");
  await sleep(400);
  const after = await keptOf(view);
  if (after.marked !== "kept") problems.push("the player was made again: its element is not the one that was left");
  if (after.loads !== 0) problems.push(`the player loaded its film ${after.loads} time(s) on the way back`);
  if (!after.paused) problems.push("the film plays after coming back");
  if (Math.abs(after.time - before.time) > 0.15) problems.push(`the film is at ${after.time.toFixed(2)} s, not ${before.time.toFixed(2)} s`);
  if (after.text !== before.text) problems.push("the words typed in the box are gone");
  // The rate that was added in settings is in the player's list when the viewer is back.
  // The menus are in the bar when it is wide and in the "…" panel when it is narrow.
  const panel = !(await centreOf(view, "video-rate")) && await realClick(view, "video-more");
  const menu = await realClick(view, "video-rate") && await waitUntil(view, `document.querySelector('.popup[role="menu"]')`, 2000);
  const offered = menu && await js<boolean>(view, `(document.querySelector('.popup[role="menu"]')?.textContent ?? "").includes("1.7")`);
  const popup = menu ? await hitTestOpenPopup(view) : null;
  await shot("settings-roundtrip-after");
  if (menu) await pressKeyEscape(view);
  if (panel) await realClick(view, "video-more");
  if (!offered) problems.push("the rate added in settings is not in the player's list");
  observe("settings-round-trip", problems.length === 0, { before, inSettings, after, rateAdded, offered, popupItems: popup?.items.length ?? 0, problems });
}

type Saved = { id: string; workId: string | null; resourceId: string; width: number; height: number; kind: string; text: Record<string, any> | null; fileOk: boolean };

/** The newest screenshot the app holds that was not there before, read back from the database and from the file's own PNG text. */
function newestSince(appService: MangaProductApp, known: Set<string>): Saved | null {
  const view = appService.screenshots.list({ limit: 200 }).items.find((item) => !known.has(item.id));
  if (!view) return null;
  let text: Record<string, any> | null = null;
  let fileOk = false;
  try {
    const file = appService.screenshots.pathOf(view.id);
    const bytes = fs.readFileSync(file);
    fileOk = bytes.subarray(1, 4).toString("latin1") === "PNG";
    const raw = readPngText(bytes)["manga.screenshot"];
    text = raw ? JSON.parse(raw) as Record<string, any> : null;
  } catch { /* reported by the caller as a missing file */ }
  return { id: view.id, workId: view.workId, resourceId: view.resourceId, width: view.width, height: view.height, kind: view.mediaKind, text, fileOk };
}

/** What the notice after a screenshot says, read before it goes away. */
const noticeOf = (view: BrowserWindow) => js<{ text: string; thumb: boolean; actions: string[] }>(view, `(() => {
  const notice = document.querySelector('[data-testid="toast-notice"]');
  return { text: notice?.textContent ?? "", thumb: Boolean(notice?.querySelector('[data-testid="toast-thumb"]')), actions: [...(notice?.querySelectorAll('[data-testid^="toast-action-"]') ?? [])].map((el) => el.getAttribute("data-testid")) };
})()`);

/** The picture from the notice onto the whiteboard: choose the board, then look for a reference card to the picture on the board. */
async function putOnBoard(view: BrowserWindow, call: Call, boardId: string, shotId: string): Promise<boolean> {
  if (!await clickTestId(view, "toast-action-board", 3000)) return false;
  if (!await clickTestId(view, `screenshot-target-${boardId}`, 4000)) return false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const board = (await call("whiteboard.get", { boardId })).value;
    if (JSON.stringify(board ?? {}).includes(shotId)) return true;
    await sleep(250);
  }
  return false;
}

/**
 * AT-91 and AT-92 in the window. A film frame is saved with the S key and a comic page from the button of its reader; each at the size of its source, with
 * the PNG's own text and the database record telling the same story, in the folder of the work, and each put on a whiteboard from the notice. The three steps
 * run while the reader they are about is in front; the last one looks at the board.
 */
export function screenshotWalk(input: { view: BrowserWindow; appService: MangaProductApp; call: Call; observe: Observe; shot: Shot; boardId: string; comicId: string | null }) {
  const { view, appService, call, observe, shot, boardId } = input;
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const known = new Set<string>(appService.screenshots.list({ limit: 200 }).items.map((item) => item.id));
  const made: string[] = [];

  /** The player is open and in front. */
  async function video(): Promise<void> {
    const middle = await settleAtMiddle(view);
    await sleep(300);
    await pressKey(view, "s");
    const noticed = await waitUntil(view, `(document.querySelector('[data-testid="toast-notice"]')?.textContent ?? "").includes("截图")`, 8000);
    const notice = await noticeOf(view);
    const saved = noticed ? newestSince(appService, known) : null;
    if (!saved) { problems.push("the key saved no screenshot of the film"); return; }
    known.add(saved.id);
    made.push(saved.id);
    detail.video = {
      width: saved.width, height: saved.height, frame: [middle.width, middle.height],
      text: saved.text ? { positionMs: saved.text.positionMs, work: Boolean(saved.text.work), size: [saved.text.width, saved.text.height] } : null,
      thumb: notice.thumb, actions: notice.actions,
    };
    if (saved.kind !== "video") problems.push("the record of the film's screenshot is not a video's");
    if (!(middle.width > 0) || saved.width !== middle.width || saved.height !== middle.height) problems.push(`the film's screenshot is ${saved.width}x${saved.height}, not the frame's ${middle.width}x${middle.height}`);
    if (!saved.fileOk) problems.push("the film's screenshot file is not a PNG");
    if (!saved.text || saved.text.id !== saved.id || !saved.text.work || !saved.text.resourceRevisionId) problems.push("the film's screenshot carries no PNG text of its own");
    else if (typeof saved.text.positionMs !== "number" || Math.abs(saved.text.positionMs / 1000 - middle.time) > 0.6) problems.push("the time in the PNG's text is not the moment of the frame");
    if (!notice.thumb || !notice.actions.includes("toast-action-board")) problems.push("the notice after the screenshot shows no picture or no way to the whiteboard");
    const folder = appService.workFolders.folderFor({ resourceId: saved.resourceId }, { create: false });
    const inFolder = appService.workFolders.filesOfResource(saved.resourceId).some((file) => file.refId === saved.id && file.subDir === "截图");
    detail.folder = { relDir: folder?.relDir ?? null, inFolder };
    if (!inFolder) problems.push("the film's screenshot is not in the 截图 folder of its resource");
    if (!await putOnBoard(view, call, boardId, saved.id)) problems.push("the film's screenshot did not get onto the whiteboard");
    await shot("screenshots-video");
  }

  /** The comic's reader is open and in front. */
  async function comic(): Promise<void> {
    const pages = input.comicId ? ((await call("comic.pages", { resourceId: input.comicId })).value as { pages?: Array<{ width: number; height: number }> } | undefined)?.pages ?? [] : [];
    await waitUntil(view, `document.querySelector('.comic-page[data-state="ready"]')`, 20_000);
    await sleep(300);
    const clicked = await clickTestId(view, "comic-screenshot", 4000);
    const noticed = clicked && await waitUntil(view, `(document.querySelector('[data-testid="toast-notice"]')?.textContent ?? "").includes("截图")`, 8000);
    const notice = await noticeOf(view);
    const saved = noticed ? newestSince(appService, known) : null;
    if (!saved) { problems.push("the button saved no screenshot of the comic page"); return; }
    known.add(saved.id);
    made.push(saved.id);
    const first = pages[0];
    detail.comic = { width: saved.width, height: saved.height, page: first ? [first.width, first.height] : null, text: saved.text ? { pageId: Boolean(saved.text.pageId), size: [saved.text.width, saved.text.height] } : null, thumb: notice.thumb };
    if (saved.kind !== "comic") problems.push("the record of the comic's screenshot is not a comic's");
    if (!first || saved.width !== first.width || saved.height !== first.height) problems.push(`the comic's screenshot is ${saved.width}x${saved.height}, not the page's own ${first ? `${first.width}x${first.height}` : "size"}`);
    if (!saved.fileOk || !saved.text || !saved.text.pageId) problems.push("the comic's screenshot carries no page in its PNG text");
    if (!await putOnBoard(view, call, boardId, saved.id)) problems.push("the comic's screenshot did not get onto the whiteboard");
    await shot("screenshots-comic");
  }

  /** Both are on the board, each as a card that points at the picture and not at a copy of it. */
  async function finish(): Promise<void> {
    const text = JSON.stringify((await call("whiteboard.get", { boardId })).value ?? {});
    const cards = made.filter((id) => text.includes(id)).length;
    detail.cardsOnBoard = cards;
    if (made.length < 2 || cards < 2) problems.push(`${cards} of the ${Math.max(2, made.length)} screenshots are on the whiteboard`);
    observe("screenshots-into-whiteboard", problems.length === 0, { ...detail, problems });
  }

  return { video, comic, finish };
}
