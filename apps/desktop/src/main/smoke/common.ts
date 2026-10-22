import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { createId } from "@manga/contracts";
import { DRAWN, PICK, clickTestId, sleep, trustedClick, waitUntil } from "./driver.ts";

/** What every smoke flow shares: who calls, how a command is issued, how the evidence is written. */

export const actor = { kind: "user" as const, id: "desktop-user" };

export type FlowResult = Record<string, unknown> & { ok: boolean };

/** A command issued as the window's owner, with a fresh idempotency key unless one is given. */
export function caller(appService: MangaProductApp, grant: string) {
  return (commandId: string, input: Record<string, unknown>, key = createId("smoke")) => appService.call(actor, { commandId, idempotencyKey: key, input }, grant);
}

export const js = <T>(view: BrowserWindow, code: string): Promise<T> => view.webContents.executeJavaScript(code) as Promise<T>;

/**
 * A screenshot is evidence, not a pass condition: a hidden window only yields frames with stayAwake (Electron 44 rejects a plain
 * capture with UnknownVizError), so it is retried and then given up on, and the process always exits.
 *
 * A picture is only the page the walk is about when that page is on screen and has been painted: `mark` is the test id of the page's own element,
 * waited for as the observation waited for it, and two animation frames go by before the capture, so the picture is not the frame before the page.
 */
export async function capturePage(view: BrowserWindow, evidenceDir: string | undefined, name: string, mark?: string): Promise<void> {
  if (!evidenceDir) return;
  fs.mkdirSync(evidenceDir, { recursive: true });
  if (mark) await waitUntil(view, `${DRAWN}(${PICK}(${JSON.stringify(mark)}))`, 4000);
  await view.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))").catch(() => undefined);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const png = await view.webContents.capturePage(undefined, { stayAwake: true });
      fs.writeFileSync(path.join(evidenceDir, name), png.toPNG());
      return;
    } catch (error) {
      if (attempt === 2) console.error(`screenshot ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
      else await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

/** The dock (the Agent's column) is shown, or the window is too narrow for it and its button brings it as an overlay: the composer is drawn when this answers true. */
export async function ensureDock(view: BrowserWindow): Promise<boolean> {
  const composerDrawn = `${DRAWN}(document.querySelector('[data-testid="shell-dock"] [data-testid="agent-composer"]'))`;
  if (await waitUntil(view, composerDrawn, 1500)) return true;
  await clickTestId(view, "shell-dock-toggle", 1500);
  return waitUntil(view, composerDrawn, 4000);
}

/** The first element whose test id starts with a prefix gets a click (a list row whose id is not known to the smoke). */
export async function clickFirst(view: BrowserWindow, prefix: string, timeoutMs = 4000): Promise<boolean> {
  return waitUntil(view, `(() => {
    const el = document.querySelector('[data-testid^="${prefix}"]');
    if (!el || el.disabled) return false;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, cancelable: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
    return true;
  })()`, timeoutMs);
}

/** The rail is there once the window has read its settings; a short wait lets the first tab of the context settle. */
export async function toRail(view: BrowserWindow): Promise<boolean> {
  await waitUntil(view, `document.querySelector('[data-testid="nav-home"]')`, 10_000);
  await sleep(500);
  return waitUntil(view, `document.querySelector('[data-testid="nav-home"]')`, 6000);
}

/**
 * Open a settings page the way a person does: the rail's settings entry (the settings view takes the window's place, the workspace stays mounted under it),
 * then the page's own entry in the view's directory.
 */
export async function openSettingsPage(view: BrowserWindow, page: string): Promise<boolean> {
  if (!(await clickTestId(view, "nav-settings"))) return false;
  if (!(await clickTestId(view, `settings-nav-${page}`))) return false;
  return waitUntil(view, `${DRAWN}(document.querySelector('[data-testid="settings-page-${page}"]'))`, 6000);
}

/** Back to the workspace from the settings view, with the title bar's back arrow (it walks the pages visited, and the first page leaves); true once the settings view is gone. */
export async function leaveSettings(view: BrowserWindow): Promise<boolean> {
  for (let step = 0; step < 14; step += 1) {
    if (!(await waitUntil(view, `document.querySelector('[data-testid="settings-area"]')`, 300))) return true;
    await clickTestId(view, "nav-back", 1000);
    await sleep(80);
  }
  return waitUntil(view, `!document.querySelector('[data-testid="settings-area"]')`, 3000);
}

/**
 * Full screen the way a person asks for it: a real click on the reader's button must put the page and the window into full
 * screen, the reader must fill the screen, and Esc must bring everything back. `rootTestId` is the element that goes full screen.
 */
export async function fullscreenRoundTrip(view: BrowserWindow, input: { button: string; root: string; evidenceDir?: string; shot?: string }): Promise<FlowResult> {
  const wasFull = view.isFullScreen();
  const clicked = await trustedClick(view, input.button);
  const entered = clicked && await waitUntil(view, `document.fullscreenElement !== null`, 4000);
  await sleep(300);
  const windowFull = view.isFullScreen();
  const state = await js<{ element: string | null; rootBox: { width: number; height: number } | null; inner: { width: number; height: number }; pressed: string | null }>(view, `(() => {
    const root = document.querySelector('[data-testid="${input.root}"]');
    const box = root ? root.getBoundingClientRect() : null;
    return {
      element: document.fullscreenElement ? (document.fullscreenElement.getAttribute("data-testid") ?? document.fullscreenElement.tagName) : null,
      rootBox: box ? { width: Math.round(box.width), height: Math.round(box.height) } : null,
      inner: { width: window.innerWidth, height: window.innerHeight },
      pressed: document.querySelector('[data-testid="${input.button}"]')?.getAttribute("aria-pressed") ?? null,
    };
  })()`);
  if (input.shot) await capturePage(view, input.evidenceDir, input.shot);
  // Within a pixel of the screen on both axes: the reader is the full-screen element, not a small box inside it.
  const fills = Boolean(state.rootBox) && Math.abs(state.rootBox!.width - state.inner.width) <= 1 && Math.abs(state.rootBox!.height - state.inner.height) <= 1;
  view.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  view.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  let left = await waitUntil(view, `document.fullscreenElement === null`, 3000);
  let leftBy = "escape";
  if (!left) { await trustedClick(view, input.button); left = await waitUntil(view, `document.fullscreenElement === null`, 3000); leftBy = "button"; }
  await sleep(300);
  const restored = left && view.isFullScreen() === wasFull;
  return { ok: Boolean(entered) && windowFull && fills && restored, entered: Boolean(entered), windowFull, fills, restored, leftBy, state };
}
