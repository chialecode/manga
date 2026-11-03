import type { BrowserWindow } from "electron";
import { PICK, sleep } from "./driver.ts";
import { js } from "./common.ts";

/** The real pointer and the screen's own pixels, for the walks that check what a person sees and does with the hand (packaged-window smoke only). */

export type Point = { x: number; y: number };
export type Box = { x: number; y: number; w: number; h: number; r: number; b: number };
export type Rgb = [number, number, number];

/** A trusted mouse event; `held` says the left button is down (a drag), so the page's pointer capture and hover are the hand's. */
export async function mouse(view: BrowserWindow, type: "mouseMove" | "mouseDown" | "mouseUp", at: Point, options: { button?: "left" | "right"; clickCount?: number; held?: boolean } = {}): Promise<void> {
  view.webContents.sendInputEvent({
    type, x: Math.round(at.x), y: Math.round(at.y), button: options.button ?? "left", clickCount: options.clickCount ?? 1,
    ...(options.held ? { modifiers: ["leftButtonDown" as const] } : {}),
  } as never);
  await sleep(45);
}

/** The drawn box of the element with this test id (the one on screen when the page has several). */
export function boxOf(view: BrowserWindow, testId: string): Promise<Box | null> {
  return js<Box | null>(view, `(() => { const el = ${PICK}(${JSON.stringify(testId)}); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right, b: b.bottom }; })()`);
}

export async function centreOf(view: BrowserWindow, testId: string): Promise<Point | null> {
  const box = await boxOf(view, testId);
  return box ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : null;
}

/**
 * The colors the screen shows in a box of the page (in CSS pixels), one per device pixel, row by row. The capture is the composited window, so it is what a
 * person sees, not what the styles say; the bitmap is in the platform's order (BGRA), turned into RGB here.
 */
export async function pixelsOf(view: BrowserWindow, box: { x: number; y: number; w: number; h: number }): Promise<{ width: number; height: number; rgb: Rgb[] }> {
  await js(view, "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))");
  const image = await view.webContents.capturePage({ x: Math.round(box.x), y: Math.round(box.y), width: Math.max(1, Math.round(box.w)), height: Math.max(1, Math.round(box.h)) }, { stayAwake: true });
  const size = image.getSize();
  const bitmap = image.toBitmap();
  const rgb: Rgb[] = [];
  for (let i = 0; i + 3 < bitmap.length; i += 4) rgb.push([bitmap[i + 2]!, bitmap[i + 1]!, bitmap[i]!]);
  // The bitmap is in device pixels and the size in CSS pixels: the scale between them is the same on both axes.
  const scale = Math.sqrt(rgb.length / Math.max(1, size.width * size.height)) || 1;
  const width = Math.max(1, Math.round(size.width * scale));
  return { width, height: Math.max(1, Math.round(rgb.length / width)), rgb };
}

/** The color a CSS value comes to in the page (a custom property is resolved through an element that uses it). */
export async function cssColor(view: BrowserWindow, value: string): Promise<Rgb | null> {
  const got = await js<string>(view, `(() => { const probe = document.createElement("div"); probe.style.color = ${JSON.stringify(value)}; document.body.appendChild(probe); const out = getComputedStyle(probe).color; probe.remove(); return out; })()`);
  return parseRgb(got);
}

export function parseRgb(text: string | null | undefined): Rgb | null {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(text ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export const near3 = (a: Rgb | null | undefined, b: Rgb | null | undefined, tolerance = 10): boolean => Boolean(a && b) && a!.every((value, index) => Math.abs(value - b![index]!) <= tolerance);
export const hex = (c: Rgb | null | undefined): string => (c ? `#${c.map((value) => value.toString(16).padStart(2, "0")).join("")}` : "none");
