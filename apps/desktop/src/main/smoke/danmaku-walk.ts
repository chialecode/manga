import type { BrowserWindow } from "electron";
import { pressKey, setField, sleep, waitForTestId, waitUntil } from "./driver.ts";
import { js } from "./common.ts";
import { SMOKE_DANMAKU_CREDENTIALS } from "../danmaku-credentials.ts";
import { hitTestOpenPopup, realClick } from "./player-menus-walk.ts";
import type { Observe } from "./reader-controls-walk.ts";

/**
 * AT-94 in the real window. The comments of an episode are laid over the picture and not over the bars around it, they are really drawn on the canvas
 * while the video plays, the layer follows the picture when the window changes size and in screen full screen, the panel opens on the top layer with every
 * control reachable, and a work that is not linked asks before the file's details leave: the walk answers no, so the network is reached only by the search the
 * person types. The network here is a fake service on the loopback address that the harness started; the credentials of a release are never used, and
 * nothing the page can see holds the ones that are.
 */

export const DANMAKU_OBSERVATIONS = ["danmaku-layer", "danmaku-privacy"] as const;

type Box = { x: number; y: number; w: number; h: number };
type Alignment = { layer: Box | null; picture: Box | null; canvas: { w: number; h: number } | null; count: number; visible: boolean };

/** Where the layer is, and where the picture is: the part of the stage the video covers once it is fitted inside its box. */
const alignmentOf = (view: BrowserWindow) => js<Alignment>(view, `(() => {
  const layer = document.querySelector('[data-testid="danmaku-layer"]');
  const video = document.querySelector('[data-testid="video-element"]');
  const stage = document.querySelector('[data-testid="video-stage"]');
  if (!layer || !video || !stage) return { layer: null, picture: null, canvas: null, count: 0, visible: false };
  const l = layer.getBoundingClientRect();
  const v = video.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  const scale = video.videoWidth > 0 && video.videoHeight > 0 ? Math.min(v.width / video.videoWidth, v.height / video.videoHeight) : 1;
  const w = video.videoWidth > 0 ? Math.round(video.videoWidth * scale) : v.width;
  const h = video.videoHeight > 0 ? Math.round(video.videoHeight * scale) : v.height;
  const picture = { x: v.x + (v.width - w) / 2, y: v.y + (v.height - h) / 2, w, h };
  const canvas = layer.querySelector("canvas");
  return {
    layer: { x: l.x, y: l.y, w: l.width, h: l.height },
    picture,
    canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
    count: Number(layer.getAttribute("data-count") ?? 0),
    visible: layer.getAttribute("data-visible") === "true",
  };
})()`);

const within = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;

/** The layer covers the top part of the picture and nothing outside it. */
function misplaced(name: string, got: Alignment, area: number): string[] {
  if (!got.layer || !got.picture) return [`${name}: the layer or the picture is not there`];
  const out: string[] = [];
  const { layer, picture } = got;
  if (!within(layer.x, picture.x, 2) || !within(layer.y, picture.y, 2)) out.push(`${name}: the layer starts at ${Math.round(layer.x)},${Math.round(layer.y)} and the picture at ${Math.round(picture.x)},${Math.round(picture.y)}`);
  if (!within(layer.w, picture.w, 2)) out.push(`${name}: the layer is ${Math.round(layer.w)} wide and the picture ${Math.round(picture.w)}`);
  if (!within(layer.h, picture.h * area, 3)) out.push(`${name}: the layer is ${Math.round(layer.h)} high, not ${area} of the picture's ${Math.round(picture.h)}`);
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

  // 3. The comments are on the picture.
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

  // 5. The layer follows the picture when the window changes size...
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

  // 6. ... and in screen full screen, where the picture grows to the screen.
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

  // 7. D turns it off, and the layer goes.
  await pressKey(view, "D");
  const gone = await waitUntil(view, `!document.querySelector('[data-testid="danmaku-layer"][data-visible="true"]')`, 4000);
  if (!gone) problems.push("D did not switch the danmaku off");
  observe("danmaku-layer", problems.length === 0, { ...detail, problems });

  // 8. Nothing the page can see holds the application credentials: not the document, not what it stores.
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
