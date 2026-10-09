import { activeCues, arrangeLines, layoutSubtitles, SUBTITLE_FONT_STACKS, type SubtitleCue, type SubtitleStyle } from "./subtitle-model.ts";

/**
 * Text subtitles drawn onto a picture of the video's own size (NOTE-05, A-92). The place, the type height, the outline and the way lines are
 * stacked are the player's own (`SubtitleLayer`), worked out from the same model with the picture standing for the whole frame, so the picture a
 * screenshot keeps shows the subtitles where and how they were on screen. Nothing here touches the page.
 */

export type SubtitleInk = { ink: string; edge: string; shade: string };
export const DEFAULT_SUBTITLE_INK: SubtitleInk = { ink: "#FFFFFF", edge: "#000000", shade: "#00000099" };

/** The colours the stylesheet gives the subtitles (`--color-subtitle-*`), so the picture follows the page; the defaults when the page has none. */
export function pageInk(): SubtitleInk {
  try {
    const style = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
    return { ink: read("--color-subtitle-ink", DEFAULT_SUBTITLE_INK.ink), edge: read("--color-subtitle-edge", DEFAULT_SUBTITLE_INK.edge), shade: read("--color-subtitle-shade", DEFAULT_SUBTITLE_INK.shade) };
  } catch {
    return DEFAULT_SUBTITLE_INK;
  }
}

/** The line height of a subtitle line, as a share of its type size (`.subtitle-line` in the stylesheet). */
const LINE_HEIGHT = 1.15;

/** What a screenshot needs to draw the text subtitles: the cues of both tracks and the moment, and the style they are shown in. */
export type TextSubtitleDraw = {
  main: readonly SubtitleCue[];
  second: readonly SubtitleCue[];
  /** The film's time of the frame, in the unit the cues use (ms). */
  timeMs: number;
  style: SubtitleStyle;
  ink?: SubtitleInk;
};

/** The lines showing at a moment, in the order they are read; empty when nothing shows. */
export function shownLines(cues: readonly SubtitleCue[], timeMs: number): string[] {
  return activeCues(cues, timeMs).flatMap((cue) => cue.lines);
}

const WIDE_CLASS = String.raw`\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef`;
const WIDE = new RegExp(`[${WIDE_CLASS}]`);
const TOKENS = new RegExp(String.raw`[${WIDE_CLASS}]|[^\s${WIDE_CLASS}]+\s*|\s+`, "g");

/** Breaks a line to fit a width the way the page does: at spaces, between wide (CJK) characters, or anywhere inside a word too long for a line. */
export function wrapText(measure: (text: string) => number, text: string, maxWidth: number): string[] {
  if (!(maxWidth > 0) || measure(text) <= maxWidth) return [text];
  const tokens = text.match(TOKENS) ?? [text];
  const lines: string[] = [];
  let current = "";
  const push = () => { if (current.trim() !== "") lines.push(current.trimEnd()); current = ""; };
  for (const token of tokens) {
    if (measure(current + token.trimEnd()) <= maxWidth) { current += token; continue; }
    push();
    if (measure(token.trimEnd()) <= maxWidth) { current = token.trimStart(); continue; }
    // A word wider than a line is cut where it stops fitting.
    for (const letter of Array.from(token.trimEnd())) {
      if (current !== "" && measure(current + letter) > maxWidth) push();
      current += letter;
    }
  }
  push();
  return lines.length ? lines : [text];
}

type Row = { text: string; px: number };

function stroke(context: CanvasRenderingContext2D, ink: SubtitleInk, outline: boolean, text: string, x: number, y: number, px: number): void {
  if (outline) {
    context.save();
    context.lineJoin = "round";
    context.lineWidth = px * 0.12;
    context.strokeStyle = ink.edge;
    context.shadowColor = ink.shade;
    context.shadowBlur = px * 0.12;
    context.shadowOffsetY = px * 0.05;
    context.strokeText(text, x, y);
    context.restore();
  }
  context.fillStyle = ink.ink;
  context.fillText(text, x, y);
}

/**
 * Draws the text subtitles showing at `timeMs` onto a canvas of `width` × `height`, the whole frame being the picture. The dialogue is stacked up from
 * the bottom of its zone and the top captions down from the top of theirs; a secondary track's lines come under the main track's, at the smaller size.
 * The frame is the whole picture, so there is no black bar under it and the dialogue sits on the picture even where the player puts it below. Returns the
 * number of lines drawn.
 */
export function drawTextSubtitles(context: CanvasRenderingContext2D, width: number, height: number, input: TextSubtitleDraw): number {
  const ink = input.ink ?? DEFAULT_SUBTITLE_INK;
  const style = input.style;
  const layout = layoutSubtitles({ w: width, h: height }, { w: width, h: height }, style);
  const family = SUBTITLE_FONT_STACKS[style.font];

  const dialogue: Row[] = [];
  const captions: Row[] = [];
  const showing: Array<[boolean, SubtitleCue[]]> = [[true, activeCues(input.main, input.timeMs)], [false, activeCues(input.second, input.timeMs)]];
  for (const [isMain, cues] of showing) {
    for (const cue of cues) {
      if (cue.top) cue.lines.forEach((text) => captions.push({ text, px: layout.topPx }));
      else if (isMain) arrangeLines(cue.lines).forEach((line) => dialogue.push({ text: line.text, px: line.small ? layout.smallPx : layout.mainPx }));
      else cue.lines.forEach((text) => dialogue.push({ text, px: layout.smallPx }));
    }
  }
  if (dialogue.length === 0 && captions.length === 0) return 0;

  context.save();
  context.textAlign = "center";
  context.textBaseline = "middle";
  let drawn = 0;
  const wrapped = (rows: Row[], zoneWidth: number) => rows.flatMap((row) => {
    context.font = `${row.px}px ${family}`;
    return wrapText((text) => context.measureText(text).width, row.text, zoneWidth).map((text) => ({ text, px: row.px }));
  });

  const lines = wrapped(dialogue, layout.dialogue.w);
  let bottom = layout.dialogue.y + layout.dialogue.h;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const row = lines[index]!;
    const box = row.px * LINE_HEIGHT;
    context.font = `${row.px}px ${family}`;
    stroke(context, ink, style.outline, row.text, layout.dialogue.x + layout.dialogue.w / 2, bottom - box / 2, row.px);
    bottom -= box;
    drawn += 1;
  }

  let top = layout.top.y;
  for (const row of wrapped(captions, layout.top.w)) {
    const box = row.px * LINE_HEIGHT;
    context.font = `${row.px}px ${family}`;
    stroke(context, ink, style.outline, row.text, layout.top.x + layout.top.w / 2, top + box / 2, row.px);
    top += box;
    drawn += 1;
  }
  context.restore();
  return drawn;
}

/** Whether a character is one the wrapper may break after on its own; exported for the tests of the wrapper. */
export const isWide = (letter: string) => WIDE.test(letter);
