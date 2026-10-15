import fs from "node:fs";
import { nativeImage, type BrowserWindow } from "electron";
import { readPngText, type MangaProductApp } from "@manga/app-core";
import { clickTestId, sleep } from "./driver.ts";
import { differenceMask, glyphCells } from "./glyph-cells.ts";
import type { Measure } from "./subtitle-check.ts";

/**
 * What the smoke checks about the subtitles in a screenshot (AT-109), in the packaged window: the picture the player's button saves is read back from
 * the file the app keeps and compared, pixel by pixel, with the same frame taken without the track. The words are not read from the picture; their
 * place is. The picture's ink is the pixels that differ between the shot with the track and the shot without it.
 */

export type TakenShot = { id: string; file: string; width: number; height: number; bitmap: Uint8Array; text: Record<string, any> | null };

/** The player's button is pressed, and the picture the app saved for it is read back from its file. Null when nothing was saved in time. */
export async function takeShot(view: BrowserWindow, appService: MangaProductApp): Promise<TakenShot | null> {
  const known = new Set(appService.screenshots.list({ limit: 500 }).items.map((item) => item.id));
  if (!await clickTestId(view, "video-screenshot", 4000)) return null;
  let found: { id: string } | undefined;
  for (let attempt = 0; attempt < 100 && !found; attempt += 1) {
    found = appService.screenshots.list({ limit: 500 }).items.find((item) => !known.has(item.id));
    if (!found) await sleep(150);
  }
  if (!found) return null;
  // The notice that says the picture was kept sits over the right end of the player's bar and over the corner of the picture; a window capture taken
  // next (the frame as the window shows it, or a click on the bar's buttons) would hold it, so it is closed as a person closes it.
  if (await clickTestId(view, "toast-notice-close", 3000)) await sleep(300);
  const file = appService.screenshots.pathOf(found.id);
  const bytes = fs.readFileSync(file);
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.getSize();
  let text: Record<string, any> | null = null;
  try { const raw = readPngText(bytes)["manga.screenshot"]; text = raw ? JSON.parse(raw) as Record<string, any> : null; } catch { /* reported as a missing record */ }
  return { id: found.id, file, width: size.width, height: size.height, bitmap: image.toBitmap(), text };
}

export type Ink = { count: number; x0: number; y0: number; x1: number; y1: number };

/** The ink of a mask inside the rows from `fromRow` to `toRow` (exclusive): how much, and the box it lies in. Null when there is none. */
export function inkIn(mask: Uint8Array, width: number, height: number, fromRow = 0, toRow = height): Ink | null {
  let count = 0;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = Math.max(0, Math.floor(fromRow)); y < Math.min(height, Math.ceil(toRow)); y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      count += 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return count > 0 ? { count, x0, y0, x1, y1 } : null;
}

/** The pixels that differ between two shots of one frame, or null when they are not of one size. */
export function shotInk(a: TakenShot, b: TakenShot): Uint8Array | null {
  return a.width === b.width && a.height === b.height ? differenceMask(a.bitmap, b.bitmap) : null;
}

export type Verdict = { ok: boolean; failures: string[]; numbers: Record<string, number | string | boolean | null> };

/** The share of the picture from its top to the bottom edge of the ink, and from its left to the middle of the ink, both as fractions. */
const bottomShare = (ink: Ink, height: number) => (ink.y1 + 1) / height;
const centreShare = (ink: Ink, width: number) => (ink.x0 + ink.x1 + 1) / 2 / width;

/**
 * Text subtitles on the picture of the file: the shot with the track has ink in the dialogue zone that the shot without it lacks, and that ink lies where
 * the player's layer had the lines when the button was pressed. `screen` is the layer as measured then, `withTracks` the shot with the track(s) and
 * `without` the same frame with none; `more` is a shot with fewer tracks, to show that a second track adds ink.
 */
export function judgeTextShot(input: { withTracks: TakenShot; without: TakenShot; screen: Measure; fewer?: TakenShot; expectTexts: string[] }): Verdict {
  const { withTracks, without, screen } = input;
  const failures: string[] = [];
  const numbers: Verdict["numbers"] = { width: withTracks.width, height: withTracks.height };
  if (withTracks.width !== screen.video.w || withTracks.height !== screen.video.h) failures.push(`the shot is ${withTracks.width}x${withTracks.height}, not the file's ${screen.video.w}x${screen.video.h}`);
  const mask = shotInk(withTracks, without);
  if (!mask) return { ok: false, failures: [...failures, "the shots are not of one size"], numbers };
  const h = withTracks.height;
  const w = withTracks.width;
  // The dialogue zone is the bottom tenth, its lower edge 5% above the bottom: the lowest fifth of the picture holds all of it.
  const dialogue = inkIn(mask, w, h, h * 0.78, h);
  numbers.dialogueInk = dialogue?.count ?? 0;
  if (!dialogue || dialogue.count < 300) failures.push("the shot with the track has no subtitle ink in the dialogue zone");
  else {
    numbers.inkBottom = Math.round(bottomShare(dialogue, h) * 1000) / 1000;
    numbers.inkCentre = Math.round(centreShare(dialogue, w) * 1000) / 1000;
    // Where the layer put its lines, as shares of the picture.
    const boxes = screen.lines.map((line) => line.box);
    if (boxes.length > 0) {
      const bottom = (Math.max(...boxes.map((box) => box.y + box.h)) - screen.picture.y) / screen.picture.h;
      const centre = ((Math.min(...boxes.map((box) => box.x)) + Math.max(...boxes.map((box) => box.x + box.w))) / 2 - screen.picture.x) / screen.picture.w;
      numbers.screenBottom = Math.round(bottom * 1000) / 1000;
      numbers.screenCentre = Math.round(centre * 1000) / 1000;
      if (Math.abs(bottomShare(dialogue, h) - bottom) > 0.03) failures.push(`the ink ends at ${bottomShare(dialogue, h).toFixed(3)} of the picture, the lines were at ${bottom.toFixed(3)}`);
      if (Math.abs(centreShare(dialogue, w) - centre) > 0.03) failures.push(`the ink is centred at ${centreShare(dialogue, w).toFixed(3)}, the lines at ${centre.toFixed(3)}`);
    }
  }
  // A caption marked as top is drawn in the upper part of the picture.
  if (screen.captions.length > 0) {
    const top = inkIn(mask, w, h, h * 0.08, h * 0.55);
    numbers.captionInk = top?.count ?? 0;
    if (!top || top.count < 100) failures.push("the shot has no ink where the top caption was");
  }
  if (input.fewer) {
    const less = shotInk(input.fewer, without);
    const lessInk = less ? inkIn(less, w, h, h * 0.78, h) : null;
    numbers.fewerInk = lessInk?.count ?? 0;
    if (!lessInk || !dialogue || dialogue.count <= lessInk.count || dialogue.y0 >= lessInk.y0) failures.push("a second track did not add ink above the first track's");
  }
  const recorded = [withTracks.text?.subtitle, withTracks.text?.subtitleSecondaryText].filter((item): item is string => typeof item === "string").join("\n");
  numbers.recordedChars = recorded.length;
  for (const expected of input.expectTexts) if (!recorded.includes(expected)) failures.push(`the record of the shot does not hold "${expected}"`);
  if (withTracks.text?.composited !== "subtitles") failures.push(`the record says composited "${String(withTracks.text?.composited)}", not "subtitles"`);
  if (without.text?.composited !== "none") failures.push(`the shot without a track says composited "${String(without.text?.composited)}", not "none"`);
  return { ok: failures.length === 0, failures, numbers };
}

/** A shot taken with the setting off: no subtitle ink against the shot with no track, the text still in the record, and the record says nothing was drawn. */
export function judgeSettingOff(input: { off: TakenShot; without: TakenShot; expectTexts: string[] }): Verdict {
  const failures: string[] = [];
  const numbers: Verdict["numbers"] = {};
  const mask = shotInk(input.off, input.without);
  if (!mask) return { ok: false, failures: ["the shots are not of one size"], numbers };
  const ink = inkIn(mask, input.off.width, input.off.height, input.off.height * 0.7, input.off.height);
  numbers.inkLeft = ink?.count ?? 0;
  if (ink && ink.count >= 30) failures.push("the shot taken with the setting off still has subtitle ink");
  const recorded = [input.off.text?.subtitle, input.off.text?.subtitleSecondaryText].filter((item): item is string => typeof item === "string").join("\n");
  for (const expected of input.expectTexts) if (!recorded.includes(expected)) failures.push(`the record of the shot does not keep "${expected}"`);
  if (input.off.text?.composited !== "none") failures.push(`the record says composited "${String(input.off.text?.composited)}", not "none"`);
  return { ok: failures.length === 0, failures, numbers };
}

/**
 * An ASS subtitle drawn by the renderer at the file's size: ink in the shot with the track that the shot without it lacks, cut into letters and not
 * boxes, lying where the window showed it. `screen` is the window's own ink as shares of the picture (bottom edge, centre), when it could be measured.
 */
export function judgeAssShot(input: { on: TakenShot; off: TakenShot; screen: { bottom: number; centre: number } | null; letters: number }): Verdict {
  const failures: string[] = [];
  const numbers: Verdict["numbers"] = { width: input.on.width, height: input.on.height };
  const mask = shotInk(input.on, input.off);
  if (!mask) return { ok: false, failures: ["the shots are not of one size"], numbers };
  const w = input.on.width;
  const h = input.on.height;
  const ink = inkIn(mask, w, h);
  numbers.ink = ink?.count ?? 0;
  if (!ink || ink.count < 300) failures.push("the shot with the track has no ASS subtitle ink");
  else {
    numbers.inkBottom = Math.round(bottomShare(ink, h) * 1000) / 1000;
    numbers.inkCentre = Math.round(centreShare(ink, w) * 1000) / 1000;
    const cells = glyphCells(mask, w, h, input.letters);
    numbers.inkedCells = cells.inked;
    numbers.distinctShapes = cells.distinct;
    if (cells.inked < input.letters - 2 || cells.distinct < input.letters - 2) failures.push("the ink of the line is boxes or blanks, not letters");
    if (input.screen) {
      numbers.screenBottom = Math.round(input.screen.bottom * 1000) / 1000;
      numbers.screenCentre = Math.round(input.screen.centre * 1000) / 1000;
      if (Math.abs(bottomShare(ink, h) - input.screen.bottom) > 0.03) failures.push("the ink is not at the height the window showed it");
      if (Math.abs(centreShare(ink, w) - input.screen.centre) > 0.03) failures.push("the ink is not where across the window showed it");
    }
  }
  if (input.on.text?.composited !== "subtitles") failures.push(`the record says composited "${String(input.on.text?.composited)}", not "subtitles"`);
  if (input.off.text?.composited !== "none") failures.push(`the shot without a track says composited "${String(input.off.text?.composited)}", not "none"`);
  const recorded = typeof input.on.text?.subtitle === "string" ? input.on.text.subtitle : "";
  numbers.recordedChars = recorded.length;
  if (recorded.trim() === "") failures.push("the record of the shot holds no subtitle text");
  return { ok: failures.length === 0, failures, numbers };
}
