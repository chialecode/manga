import type { BrowserWindow } from "electron";
import { clickTestId, pressKey, setField, setSelect, sleep, waitForTestId, waitUntil } from "./driver.ts";
import { js, leaveSettings, openSettingsPage } from "./common.ts";
import { SMOKE_DANMAKU_CREDENTIALS } from "../danmaku-credentials.ts";
import { hitTestOpenPopup, realClick } from "./player-menus-walk.ts";
import type { Observe } from "./reader-controls-walk.ts";

/**
 * AT-94 and AT-133 in the real window. The comments of an episode are laid from the top of the play area across its whole width (A-111), they are really drawn on
 * the canvas while the video plays, the layer follows the play area when the window changes size and in screen full screen, the panel opens on the top layer with every
 * control reachable, and a work that is not linked asks before the file's details leave: the walk answers no, so the network is reached only by the search the
 * person types. The network here is a fake service on the loopback address that the harness started; the credentials of a release are never used, and
 * nothing the page can see holds the ones that are.
 */

export const DANMAKU_OBSERVATIONS = ["danmaku-layer", "danmaku-window-top", "danmaku-privacy"] as const;

type Box = { x: number; y: number; w: number; h: number };
type Alignment = { layer: Box | null; picture: Box | null; area: Box | null; canvas: { w: number; h: number } | null; count: number; visible: boolean };

/** Where the layer is, where the play area is (the layer's parent), and where the picture is: the part of the play area the video covers once it is fitted inside it. */
const alignmentOf = (view: BrowserWindow) => js<Alignment>(view, `(() => {
  const layer = document.querySelector('[data-testid="danmaku-layer"]');
  const video = document.querySelector('[data-testid="video-element"]');
  const area = layer?.parentElement;
  if (!layer || !video || !area) return { layer: null, picture: null, area: null, canvas: null, count: 0, visible: false };
  const l = layer.getBoundingClientRect();
  const v = video.getBoundingClientRect();
  const a = area.getBoundingClientRect();
  const scale = video.videoWidth > 0 && video.videoHeight > 0 ? Math.min(v.width / video.videoWidth, v.height / video.videoHeight) : 1;
  const w = video.videoWidth > 0 ? Math.round(video.videoWidth * scale) : v.width;
  const h = video.videoHeight > 0 ? Math.round(video.videoHeight * scale) : v.height;
  const picture = { x: v.x + (v.width - w) / 2, y: v.y + (v.height - h) / 2, w, h };
  const canvas = layer.querySelector("canvas");
  return {
    layer: { x: l.x, y: l.y, w: l.width, h: l.height },
    picture,
    area: { x: a.x + area.clientLeft, y: a.y + area.clientTop, w: area.clientWidth, h: area.clientHeight },
    canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
    count: Number(layer.getAttribute("data-count") ?? 0),
    visible: layer.getAttribute("data-visible") === "true",
  };
})()`);

const within = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

/** The layer starts at the top of the play area and is as wide as it (A-111), its height is the play area's times the setting, and it reaches across the picture. */
function misplaced(name: string, got: Alignment, area: number): string[] {
  if (!got.layer || !got.picture || !got.area) return [`${name}: the layer, the play area or the picture is not there`];
  const out: string[] = [];
  const { layer, picture, area: play } = got;
  if (!within(layer.x, play.x, 2) || !within(layer.y, play.y, 2)) out.push(`${name}: the layer starts at ${Math.round(layer.x)},${Math.round(layer.y)} and the play area at ${Math.round(play.x)},${Math.round(play.y)}`);
  if (!within(layer.w, play.w, 2)) out.push(`${name}: the layer is ${Math.round(layer.w)} wide and the play area ${Math.round(play.w)}`);
  if (!within(layer.h, play.h * area, 3)) out.push(`${name}: the layer is ${Math.round(layer.h)} high, not ${area} of the play area's ${Math.round(play.h)}`);
  if (layer.x > picture.x + 1 || layer.x + layer.w < picture.x + picture.w - 1) out.push(`${name}: the layer (${Math.round(layer.x)}–${Math.round(layer.x + layer.w)}) does not reach across the picture (${Math.round(picture.x)}–${Math.round(picture.x + picture.w)})`);
  return out;
}

/** How many pixels of the comments' canvas are not empty. */
const inkOf = (view: BrowserWindow) => js<number>(view, `(() => {
  const canvas = document.querySelector('[data-testid="danmaku-layer"] canvas');
  if (!canvas || canvas.width === 0 || canvas.height === 0) return -1;
  const context = canvas.getContext("2d");
  if (!context) return -1;
  const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let ink = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink += 1;
  return ink;
})()`);

/** The comments of the walk: the fake service gives this episode (the second) seven; the page shows five of them after merging the repeat and leaving the bottom one out. */
const EXPECTED_SHOWN = 5;

/** The player's button is pressed; the picture has the file's size, and the comments are in it exactly when the layer lies over the picture (A-111). */
async function checkShot(view: BrowserWindow, detail: Record<string, unknown>, name: string, commentsExpected: boolean): Promise<string[]> {
  type Shot = { id: string; width: number; height: number; meta?: { composited?: string } };
  // The command lists at most 200 at a time, the newest first.
  const list = () => js<Shot[]>(view, `window.manga.command({ commandId: "screenshot.list", idempotencyKey: crypto.randomUUID(), input: { limit: 200 } }).then((result) => { if (result.status !== "ok") throw new Error(result.error?.message ?? "screenshot.list failed"); return result.value.items; })`);
  const native = await js<{ w: number; h: number }>(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); return { w: v.videoWidth, h: v.videoHeight }; })()`);
  const known = new Set((await list()).map((item) => item.id));
  // Pressed the way the other screenshot walks press it; the real pointer may rest on the comments panel of a narrow window.
  if (!await clickTestId(view, "video-screenshot", 4000)) return [`${name}: the button could not be pressed`];
  let taken: Shot | undefined;
  for (let waited = 0; !taken && waited < 15_000; waited += 250) {
    taken = (await list()).find((item) => !known.has(item.id));
    if (!taken) await sleep(250);
  }
  if (await clickTestId(view, "toast-notice-close", 1500)) await sleep(200);
  detail[name] = taken ? { width: taken.width, height: taken.height, composited: taken.meta?.composited ?? null, native, commentsExpected } : null;
  if (!taken) return [`${name}: the screenshot was not saved`];
  const problems: string[] = [];
  if (taken.width !== native.w || taken.height !== native.h) problems.push(`${name}: the screenshot is ${taken.width}x${taken.height}, not the picture's ${native.w}x${native.h}: something outside the picture is in it`);
  const drawn = taken.meta?.composited === "danmaku" || taken.meta?.composited === "both";
  if (drawn !== commentsExpected) problems.push(`${name}: the screenshot says the comments were ${taken.meta?.composited ?? "not"} drawn on it, and they ${commentsExpected ? "are" : "are not"} over the picture`);
  return problems;
}

export async function walkDanmaku(view: BrowserWindow, observe: Observe, shot?: (name: string) => Promise<void>): Promise<void> {
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  view.webContents.focus();
  await js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); v.pause(); v.muted = true; v.currentTime = 0; return true; })()`);

  // 1. Turn it on with a real click. The work is not linked, so the first thing is the question; the panel opens by itself, on the top layer.
  if (!await realClick(view, "video-danmaku")) { observe("danmaku-layer", false, { problems: ["the danmaku button was not found"] }); observe("danmaku-privacy", false, { problems: ["the danmaku button was not found"] }); return; }
  const asked = await waitForTestId(view, "danmaku-consent-deny", "data-testid", null, 8000);
  detail.asked = asked;
  if (!asked) problems.push("the question before the file's details are sent did not come");
  else {
    await sleep(200);
    const panel = await hitTestOpenPopup(view, '[data-testid="danmaku-panel"]');
    detail.panel = { items: panel.items.length, topLayer: panel.topLayer, box: panel.box };
    if (!panel.found || !panel.topLayer) problems.push("the danmaku panel did not open on the top layer");
    const unreachable = panel.items.filter((item) => !item.hit || !item.inView).map((item) => item.id);
    if (unreachable.length) problems.push(`the danmaku panel items ${unreachable.join(", ")} cannot be reached`);
    if (shot) await shot("danmaku-consent");
    // 2. The answer is no: nothing about the file is sent, and the person searches by name and number instead.
    await realClick(view, "danmaku-consent-deny");
    const choosing = await waitForTestId(view, "danmaku-search-query", "data-testid", null, 6000);
    if (!choosing) problems.push("saying no did not lead to the search");
    else {
      await setField(view, "danmaku-search-query", "样例动画");
      await setField(view, "danmaku-search-episode", "2");
      const searchStarted = Date.now();
      await realClick(view, "danmaku-search-go");
      // Up to a little past the client's own 15 s limit, so a search that does not answer ends as the application's error (shown in the panel), not as the walk's impatience.
      // The longer wait is for the record only: a list that comes later than the 8 s the walk always allowed still fails (LOOP-21).
      const found = await waitForTestId(view, "danmaku-candidate-900102", "data-testid", null, 17_000);
      const searchMs = Date.now() - searchStarted;
      detail.searchMs = searchMs;
      if (found && searchMs > 8000) problems.push(`the search listed the episode only after ${searchMs} ms (limit 8000 ms)`);
      if (!found) {
        problems.push("the search did not list the episode");
        // What the form looked like when the search was asked for: whether the button was there, enabled and the thing under its centre.
        detail.searchDiag = await js(view, `(() => {
          const go = document.querySelector('[data-testid="danmaku-search-go"]');
          const box = go ? go.getBoundingClientRect() : null;
          const hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
          return {
            query: document.querySelector('[data-testid="danmaku-search-query"]')?.value ?? null,
            episode: document.querySelector('[data-testid="danmaku-search-episode"]')?.value ?? null,
            go: box ? { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height), disabled: go.disabled, text: go.textContent } : null,
            hit: hit ? (hit.getAttribute("data-testid") || hit.tagName.toLowerCase()) : null,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            empty: Boolean(document.querySelector('[data-testid="danmaku-search-empty"]')),
            candidates: [...document.querySelectorAll('[data-testid^="danmaku-candidate-"]')].map((el) => el.getAttribute("data-testid")),
            panel: (document.querySelector('[data-testid="danmaku-panel"]')?.textContent ?? "").slice(0, 160),
          };
        })()`);
        // The same search asked for directly, with a time limit: the answer or the error says where the first one stopped.
        detail.searchDirect = await js(view, `(() => {
          const started = performance.now();
          const ask = window.manga.command({ commandId: "danmaku.search", idempotencyKey: crypto.randomUUID(), input: { query: "样例动画", episode: 2 } }).then((result) => ({ status: result.status, code: result.error?.code ?? null, message: String(result.error?.message ?? "").slice(0, 160), candidates: result.value?.candidates?.length ?? null, ms: Math.round(performance.now() - started) }), (error) => ({ thrown: String(error).slice(0, 160) }));
          return Promise.race([ask, new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 12000))]);
        })()`);
      }
      else {
        if (shot) await shot("danmaku-search");
        await realClick(view, "danmaku-candidate-900102");
        const ready = await waitUntil(view, `document.querySelector('[data-testid="danmaku-state"][data-phase="ready"]')`, 10_000);
        if (!ready) problems.push("choosing the episode did not load its comments");
        else if (shot) await shot("danmaku-panel");
      }
    }
  }
  await pressKey(view, "Escape");
  await sleep(250);

  // 3. The comments are on the top half of the play area.
  const loaded = await waitUntil(view, `document.querySelector('[data-testid="danmaku-layer"][data-visible="true"]')`, 6000);
  if (!loaded) problems.push("the layer is not showing");
  const settled = await alignmentOf(view);
  detail.layer = settled;
  if (settled.count !== EXPECTED_SHOWN) problems.push(`the layer was given ${settled.count} comments, not ${EXPECTED_SHOWN}`);
  if (!settled.canvas || settled.canvas.w < 16 || settled.canvas.h < 16) problems.push("the engine has no canvas to draw on");
  problems.push(...misplaced("in the window", settled, 0.5));

  // 4. They are really drawn while the video plays: the first comes at 1.5 s and crosses in about ten.
  await js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); v.currentTime = 1; return v.play().then(() => true, () => false); })()`);
  await sleep(2800);
  const ink = await inkOf(view);
  detail.ink = ink;
  if (ink <= 40) problems.push(`nothing was drawn on the canvas while the video played (${ink} pixels)`);
  if (shot) await shot("danmaku-playing");
  await js(view, `document.querySelector('[data-testid="video-element"]').pause(); true`);

  // 5. The layer follows the play area when the window changes size...
  const [width, height] = view.getContentSize();
  try {
    view.setContentSize(980, 640);
    await sleep(700);
    const small = await alignmentOf(view);
    problems.push(...misplaced("in a smaller window", small, 0.5));
    detail.small = small;
  } finally {
    view.setContentSize(width!, height!);
    await sleep(700);
  }
  const restored = await alignmentOf(view);
  problems.push(...misplaced("back in the first size", restored, 0.5));

  // 6. ... and in screen full screen, where the play area is the screen.
  const wasFull = view.isFullScreen();
  if (await realClick(view, "video-fullscreen") && await waitUntil(view, `document.fullscreenElement !== null`, 4000)) {
    try {
      await sleep(900);
      const full = await alignmentOf(view);
      detail.fullscreen = full;
      problems.push(...misplaced("in screen full screen", full, 0.5));
      if (!full.visible) problems.push("the layer is not showing in screen full screen");
    } finally {
      view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
      view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      await waitUntil(view, `document.fullscreenElement === null`, 3000);
      if (view.isFullScreen() !== wasFull) { await realClick(view, "video-fullscreen"); await waitUntil(view, `document.fullscreenElement === null`, 3000); }
      await sleep(500);
    }
  } else problems.push("screen full screen did not start");

  // 7. Above the picture: a tall window, a wide one, window full screen and screen full screen, and a screenshot (its own observation).
  if (loaded) await walkDanmakuWindowTop(view, observe, shot);
  else observe("danmaku-window-top", false, { problems: ["the layer never showed"] });

  // 8. D turns it off, and the layer goes.
  await pressKey(view, "D");
  const gone = await waitUntil(view, `!document.querySelector('[data-testid="danmaku-layer"][data-visible="true"]')`, 4000);
  if (!gone) problems.push("D did not switch the danmaku off");
  observe("danmaku-layer", problems.length === 0, { ...detail, problems });

  // 9. Nothing the page can see holds the application credentials: not the document, not what it stores.
  const privacy: string[] = [];
  const seen = await js<{ document: string; stored: string }>(view, `(() => {
    let stored = "";
    try { stored = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }); } catch { stored = ""; }
    return { document: document.documentElement.outerHTML, stored };
  })()`);
  for (const [where, text] of Object.entries(seen)) {
    if (text.includes(SMOKE_DANMAKU_CREDENTIALS.secret)) privacy.push(`the secret is in the ${where}`);
    if (text.includes(SMOKE_DANMAKU_CREDENTIALS.appId)) privacy.push(`the AppId is in the ${where}`);
  }
  const bridge = await js<string[]>(view, `Object.keys(window.manga ?? {})`);
  if (bridge.some((name) => /dandan|danmakuCredential|appSecret/i.test(name))) privacy.push("the preload offers a way to read the credentials");
  observe("danmaku-privacy", privacy.length === 0, { problems: privacy, bridge: bridge.length });
}

/** The pixels of the comments' canvas, between two lines given in CSS pixels from the layer's top, that are not empty. */
const inkBetween = (view: BrowserWindow, fromCss: number, toCss: number) => js<number>(view, `(() => {
  const layer = document.querySelector('[data-testid="danmaku-layer"]');
  const canvas = layer?.querySelector("canvas");
  if (!canvas || canvas.width === 0 || canvas.height === 0) return -1;
  const scale = canvas.height / Math.max(1, layer.getBoundingClientRect().height);
  const top = Math.max(0, Math.floor(${fromCss} * scale));
  const bottom = Math.min(canvas.height, Math.ceil(${toCss} * scale));
  if (bottom <= top) return 0;
  const data = canvas.getContext("2d").getImageData(0, top, canvas.width, bottom - top).data;
  let ink = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] > 0) ink += 1;
  return ink;
})()`);

/** Bright pixels in a part of the window as the screen shows it (the comments are white letters; the bars around the picture are black). */
async function brightOnScreen(view: BrowserWindow, box: Box): Promise<number> {
  if (box.w < 2 || box.h < 2) return 0;
  const image = await view.webContents.capturePage({ x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.w), height: Math.round(box.h) }, { stayAwake: true });
  const bitmap = image.toBitmap();
  let bright = 0;
  for (let i = 0; i + 3 < bitmap.length; i += 4) if (bitmap[i]! > 200 && bitmap[i + 1]! > 200 && bitmap[i + 2]! > 200) bright += 1;
  return bright;
}

/**
 * The comments above the picture (A-111, 计划 4.12): with a window taller than the picture and the area at a quarter, the layer is the top of the play area and
 * its first rows are in the black bar above the picture, which the canvas, a hit test and the screen's own pixels all show; with a window wider than the picture the
 * layer spans the bars on both sides; window full screen and screen full screen are the same; and a screenshot is the picture alone, with the comments on it.
 */
async function walkDanmakuWindowTop(view: BrowserWindow, observe: Observe, shot?: (name: string) => Promise<void>): Promise<void> {
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  const [width, height] = view.getContentSize();
  const play = (from: number) => js(view, `(() => { const v = document.querySelector('[data-testid="video-element"]'); v.muted = true; v.currentTime = ${from}; return v.play().then(() => true, () => false); })()`);
  const pause = () => js(view, `document.querySelector('[data-testid="video-element"]').pause(); true`);
  // The comments are in a screenshot only when the person asks for that, so the setting goes with the area here and is put back with it.
  const area = async (value: string, shotWith: boolean) => {
    const set = await openSettingsPage(view, "danmaku") && await setSelect(view, "danmaku-area", value)
      && await js<boolean>(view, `(() => { const el = document.getElementById("danmaku-shot-with"); if (!el) return false; const on = el.checked ?? el.getAttribute("aria-checked") === "true"; if (on !== ${shotWith}) el.click(); return true; })()`);
    await leaveSettings(view);
    await waitUntil(view, `document.querySelector('[data-testid="danmaku-layer"][data-visible="true"]')`, 4000);
    await sleep(400);
    return set;
  };
  try {
    if (!(await area("0.25", true))) problems.push("the area could not be set to a quarter in the settings");

    // A window taller than the picture: black bars above and below it.
    view.setContentSize(720, 900);
    await sleep(900);
    const tall = await alignmentOf(view);
    detail.tall = tall;
    problems.push(...misplaced("in a tall window", tall, 0.25));
    const bar = tall.picture && tall.area ? tall.picture.y - tall.area.y : 0;
    if (bar < 40) problems.push(`the tall window leaves ${Math.round(bar)} px above the picture, too little to look at`);
    else {
      await play(1);
      await sleep(2800);
      await pause();
      await sleep(200);
      const above = await inkBetween(view, 0, Math.min(bar, tall.layer?.h ?? 0));
      // A pointer at a point of the bar above the picture, inside the layer, reaches the play area: nothing of the page is drawn over the comments there.
      const point = { x: Math.round((tall.area!.x + tall.area!.w / 2)), y: Math.round(tall.area!.y + Math.min(bar, tall.layer!.h) / 2) };
      const reach = await js<boolean>(view, `(() => {
        const hit = document.elementFromPoint(${point.x}, ${point.y});
        const layer = document.querySelector('[data-testid="danmaku-layer"]');
        const area = layer?.parentElement;
        const l = layer?.getBoundingClientRect();
        return Boolean(hit && area && area.contains(hit) && l && ${point.y} >= l.top && ${point.y} <= l.bottom);
      })()`);
      const screen = await brightOnScreen(view, { x: tall.area!.x, y: tall.area!.y, w: tall.area!.w, h: bar });
      detail.aboveThePicture = { bar: Math.round(bar), canvasInk: above, screenBright: screen, reach };
      if (above <= 40) problems.push(`no comment was drawn on the canvas above the picture (${above} pixels)`);
      if (!reach) problems.push("something of the page covers the bar above the picture where the comments are");
      if (screen <= 20) problems.push(`the screen shows no comment above the picture (${screen} bright pixels)`);
      if (shot) await shot("danmaku-above-picture");

      // A screenshot here: the picture alone, at the file's size. The layer ends above the picture when a quarter of a tall window is over the bar, and the comments in the bar stay out of it.
      const overlaps = tall.layer!.y + tall.layer!.h > tall.picture!.y + 1;
      problems.push(...await checkShot(view, detail, "screenshot", overlaps));
    }

    // A window wider than the picture: the layer spans the bars on both sides.
    view.setContentSize(1500, 520);
    await sleep(900);
    const wide = await alignmentOf(view);
    detail.wide = wide;
    problems.push(...misplaced("in a wide window", wide, 0.25));
    // A screenshot here: the layer lies over the top of the picture, so the comments on it are in the picture.
    problems.push(...await checkShot(view, detail, "screenshotOver", true));
    if (wide.layer && wide.picture && wide.layer.w < wide.picture.w + 40) problems.push(`in a wide window the layer is ${Math.round(wide.layer.w)} wide, not wider than the picture's ${Math.round(wide.picture.w)}`);
    view.setContentSize(width!, height!);
    await sleep(700);

    // Window full screen and screen full screen: the play area is the window, then the screen.
    if (await realClick(view, "video-window-fullscreen") && await waitUntil(view, `document.querySelector('[data-testid="video-reader"]')?.hasAttribute("data-window-full")`, 4000)) {
      await sleep(700);
      const windowFull = await alignmentOf(view);
      detail.windowFull = windowFull;
      problems.push(...misplaced("in window full screen", windowFull, 0.25));
      await realClick(view, "video-window-fullscreen");
      await waitUntil(view, `!document.querySelector('[data-testid="video-reader"]')?.hasAttribute("data-window-full")`, 4000);
      await sleep(400);
    } else problems.push("window full screen did not start");
    const wasFull = view.isFullScreen();
    if (await realClick(view, "video-fullscreen") && await waitUntil(view, `document.fullscreenElement !== null`, 4000)) {
      try {
        await sleep(900);
        const screenFull = await alignmentOf(view);
        detail.screenFull = screenFull;
        problems.push(...misplaced("in screen full screen", screenFull, 0.25));
      } finally {
        view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await waitUntil(view, `document.fullscreenElement === null`, 3000);
        if (view.isFullScreen() !== wasFull) { await realClick(view, "video-fullscreen"); await waitUntil(view, `document.fullscreenElement === null`, 3000); }
        await sleep(500);
      }
    } else problems.push("screen full screen did not start");
  } finally {
    view.setContentSize(width!, height!);
    await sleep(500);
    await pause();
    await area("0.5", false);
  }
  observe("danmaku-window-top", problems.length === 0, { ...detail, problems });
}
