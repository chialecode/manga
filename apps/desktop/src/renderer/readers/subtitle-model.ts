/**
 * The default look of a text subtitle (A-59, Q-22), without React or a media element: how a subtitle file is read into cues, which lines of a cue go
 * where, and where the subtitle zones are on a video's picture. The numbers are relative to the picture (the video as it is drawn, not the window
 * around it) and come from GY/T 288—2014 and GY/T 357—2024 chapter 9: the dialogue zone is the bottom 10% of the picture, 90% wide, its lower edge
 * 5% above the picture's bottom edge; the type is 5% of the picture's height.
 */

export type Box = { x: number; y: number; w: number; h: number };

// ---- the style the user can change -------------------------------------------------------------------------------

export const SUBTITLE_FONTS = ["sans", "serif", "kai"] as const;
export type SubtitleFont = (typeof SUBTITLE_FONTS)[number];

export type SubtitleStyle = {
  /** `auto` puts the dialogue below a widescreen picture when the black bar is tall enough; `inside` always keeps it on the picture. */
  placement: "auto" | "inside";
  /** The type height as a share of the picture height, in percent. The standard asks for 5, with 1 either way. */
  sizePct: number;
  font: SubtitleFont;
  outline: boolean;
  /** `keep`: an ASS file is drawn as it is written. `standard`: its font, size, outline and place are replaced by the standard's. */
  assStyle: "keep" | "standard";
};

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = { placement: "auto", sizePct: 5, font: "sans", outline: true, assStyle: "keep" };
export const SIZE_MIN = 3;
export const SIZE_MAX = 8;

/** Black-type families first (the standard asks for 黑体, 楷体 or 宋体 style Simplified Chinese faces), then what is likely to be installed. */
export const SUBTITLE_FONT_STACKS: Record<SubtitleFont, string> = {
  sans: '"Microsoft YaHei", "SimHei", "Source Han Sans SC", "Noto Sans CJK SC", "PingFang SC", sans-serif',
  serif: '"SimSun", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", serif',
  kai: '"KaiTi", "STKaiti", "Kaiti SC", "DFKai-SB", serif',
};
/** The first family of a stack, for a renderer (the ASS one) that takes a single name. */
export const SUBTITLE_FONT_NAMES: Record<SubtitleFont, string> = { sans: "Microsoft YaHei", serif: "SimSun", kai: "KaiTi" };

export function normalizeStyle(input: Partial<SubtitleStyle> | null | undefined): SubtitleStyle {
  const style = { ...DEFAULT_SUBTITLE_STYLE, ...(input ?? {}) };
  return {
    placement: style.placement === "inside" ? "inside" : "auto",
    sizePct: Number.isFinite(style.sizePct) ? Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(style.sizePct * 10) / 10)) : DEFAULT_SUBTITLE_STYLE.sizePct,
    font: (SUBTITLE_FONTS as readonly string[]).includes(style.font) ? style.font : "sans",
    outline: style.outline !== false,
    assStyle: style.assStyle === "standard" ? "standard" : "keep",
  };
}

// ---- cues ----------------------------------------------------------------------------------------------------------

export type SubtitleCue = {
  startMs: number;
  endMs: number;
  /** The text lines, without markup. */
  lines: string[];
  /** Marked as sitting at the top of the picture (`{\an8}` and its kin, a WebVTT line near the top): an explanatory caption, not dialogue. */
  top: boolean;
};

function cueTime(text: string): number | null {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(text.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  return (Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000 + Number(fraction!.padEnd(3, "0"));
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&lrm;": "", "&rlm;": "", "&quot;": '"', "&#39;": "'" };

/** `{\an7}`, `{\an8}` and `{\an9}` put a caption at the top; the old `{\a5}`—`{\a7}` form does too. */
function markedTop(raw: string): boolean {
  for (const block of raw.matchAll(/\{([^}]*)\}/g)) {
    const alignment = /\\an([1-9])(?!\d)/.exec(block[1]!);
    if (alignment) return Number(alignment[1]) >= 7;
    const legacy = /\\a(\d{1,2})(?!\d)/.exec(block[1]!);
    if (legacy) return [5, 6, 7].includes(Number(legacy[1]));
  }
  return false;
}

/** A WebVTT cue's `line:` setting near the top of the picture: 30% or less, or one of the first three lines. */
function settingTop(settings: string): boolean {
  const match = /(?:^|\s)line:(-?\d+(?:\.\d+)?)(%)?/.exec(settings);
  if (!match) return false;
  const value = Number(match[1]);
  return match[2] ? value <= 30 : value >= 0 && value <= 2;
}

/** Text of a cue as lines: override blocks and markup removed, entities decoded, `\N` a line break. */
export function cueLines(raw: string): string[] {
  const text = raw
    .replace(/\{[^}]*\}/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\h/g, " ")
    .replace(/&(?:amp|lt|gt|nbsp|lrm|rlm|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * The cues of an SRT or WebVTT file, in order of start. A block with no readable times or no text is skipped rather than failing the file.
 * The one reader serves both formats: their timing lines differ only in the separator before the milliseconds.
 */
export function parseSubtitleCues(source: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const blocks = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) continue;
    const [from, rest] = lines[at]!.split("-->");
    const [endText, ...settings] = (rest ?? "").trim().split(/\s+/);
    const start = cueTime(from ?? "");
    const end = cueTime(endText ?? "");
    const raw = lines.slice(at + 1).join("\n");
    const text = cueLines(raw);
    if (start === null || end === null || end <= start || !text.length) continue;
    cues.push({ startMs: start, endMs: end, lines: text, top: markedTop(raw) || settingTop(settings.join(" ")) });
  }
  return cues.sort((a, b) => a.startMs - b.startMs);
}

/** The cues showing at a time. `sorted` is in order of start, as `parseSubtitleCues` returns it. */
export function activeCues(sorted: readonly SubtitleCue[], timeMs: number): SubtitleCue[] {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid]!.startMs <= timeMs) low = mid + 1; else high = mid;
  }
  const found: SubtitleCue[] = [];
  // Walk back over the cues that began before the time; an overlong cue is rare, so the walk stops after a generous number.
  for (let index = low - 1; index >= 0 && found.length < 8 && low - index <= 64; index -= 1) {
    const cue = sorted[index]!;
    if (cue.endMs > timeMs) found.push(cue);
  }
  return found.reverse();
}

// ---- which lines of a cue go where ----------------------------------------------------------------------------------

export type ScriptKind = "zh" | "other" | "none";

/** Chinese when a line has Han characters and no kana (a Japanese line has both), another script when it has letters, else no script (digits, signs). */
export function scriptOf(line: string): ScriptKind {
  if (/[\u3040-\u30ff]/.test(line)) return "other";
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(line)) return "zh";
  return /\p{L}/u.test(line) ? "other" : "none";
}

export type CueLine = { text: string; small: boolean };

/**
 * A cue with Chinese lines and lines in another language is bilingual: the Chinese goes on top at the standard height and the other language
 * under it at 75% of that. Any other cue keeps its lines in order, all at the standard height: two lines of one language are one sentence
 * wrapped, or two people speaking together (the standard sets them on two lines).
 */
export function arrangeLines(lines: readonly string[]): CueLine[] {
  const kinds: ScriptKind[] = [];
  lines.forEach((line, index) => {
    const kind = scriptOf(line);
    kinds.push(kind === "none" ? (kinds[index - 1] ?? "none") : kind);
  });
  const hasChinese = kinds.includes("zh");
  const hasOther = kinds.includes("other");
  if (!hasChinese || !hasOther) return lines.map((text) => ({ text, small: false }));
  const chinese = lines.filter((_, index) => kinds[index] !== "other").map((text) => ({ text, small: false }));
  const other = lines.filter((_, index) => kinds[index] === "other").map((text) => ({ text, small: true }));
  return [...chinese, ...other];
}

// ---- where the zones are -------------------------------------------------------------------------------------------

/** The picture of a video inside its frame as `object-fit: contain` draws it. */
export function pictureBox(frame: { w: number; h: number }, video: { w: number; h: number }): Box {
  if (!(frame.w > 0 && frame.h > 0)) return { x: 0, y: 0, w: 0, h: 0 };
  if (!(video.w > 0 && video.h > 0)) return { x: 0, y: 0, w: frame.w, h: frame.h };
  const scale = Math.min(frame.w / video.w, frame.h / video.h);
  const w = video.w * scale;
  const h = video.h * scale;
  return { x: (frame.w - w) / 2, y: (frame.h - h) / 2, w, h };
}

/** Wide screen starts here: 2.35:1 and 2.39:1 are the ratios the standard names, 2.2 leaves room for the rounding of an encoded size. */
export const WIDESCREEN_RATIO = 2.2;
/** The dialogue zone is a tenth of the picture high, and a black bar has to be that high to hold it. */
export const ZONE_SHARE = 0.1;

export type SubtitleLayout = {
  picture: Box;
  /** Where the dialogue is: on the picture, or on the black bar under a widescreen picture. */
  place: "inside" | "below";
  dialogue: Box;
  /** The zone for captions marked as top: the upper part of the middle 80% of the picture. */
  top: Box;
  /** Type heights in px: dialogue, a bilingual second language or a secondary track, and a top caption. */
  mainPx: number;
  smallPx: number;
  topPx: number;
};

export function layoutSubtitles(frame: { w: number; h: number }, video: { w: number; h: number }, style: SubtitleStyle): SubtitleLayout {
  const picture = pictureBox(frame, video);
  const ratio = video.w > 0 && video.h > 0 ? video.w / video.h : 0;
  const barBelow = frame.h - (picture.y + picture.h);
  const below = style.placement === "auto" && ratio >= WIDESCREEN_RATIO && barBelow >= picture.h * ZONE_SHARE - 0.5;
  const zoneHeight = picture.h * ZONE_SHARE;
  const dialogue: Box = {
    x: picture.x + picture.w * 0.05,
    w: picture.w * 0.9,
    h: zoneHeight,
    y: below ? picture.y + picture.h : picture.y + picture.h - picture.h * 0.05 - zoneHeight,
  };
  const top: Box = { x: picture.x + picture.w * 0.1, y: picture.y + picture.h * 0.1, w: picture.w * 0.8, h: picture.h * 0.8 };
  const mainPx = picture.h * (style.sizePct / 100);
  return { picture, place: below ? "below" : "inside", dialogue, top, mainPx, smallPx: mainPx * 0.75, topPx: picture.h * 0.037 };
}

/**
 * Moves the dialogue zone up so it ends above `lift` px at the bottom of the frame, where the full-screen controls are laid over the picture.
 * Nothing else changes: the picture, the type size and the top captions keep the place they have without the controls, so the picture does not
 * jump when the controls come and go.
 */
export function liftDialogue(layout: SubtitleLayout, frameHeight: number, lift: number): SubtitleLayout {
  if (lift <= 0) return layout;
  const limit = frameHeight - lift;
  const bottom = layout.dialogue.y + layout.dialogue.h;
  if (bottom <= limit) return layout;
  return { ...layout, dialogue: { ...layout.dialogue, y: Math.max(0, limit - layout.dialogue.h) } };
}

// ---- ASS styled by the standard -------------------------------------------------------------------------------------

/**
 * An ASS file with its styles replaced by the standard's (A-59, "按标准覆盖"): font, size, colour, outline, bottom alignment and margins.
 * What the file says about when and what stays; the position and size tags inside a line (`\pos`, `\move`, `\fs`, `\fn`...) are removed so
 * they cannot undo it. A line that draws shapes (`\p1`) is a sign, not a subtitle, and is left as it is.
 */
export function overrideAssStyles(source: string, options: { fontName: string; sizePct: number }): string {
  const text = source.replace(/\r\n?/g, "\n");
  const resY = Number(/^\s*PlayResY\s*:\s*(\d+)/im.exec(text)?.[1] ?? 288) || 288;
  const resX = Number(/^\s*PlayResX\s*:\s*(\d+)/im.exec(text)?.[1] ?? 384) || 384;
  const fontSize = Math.max(8, Math.round(resY * (options.sizePct / 100)));
  const outline = Math.max(1, Math.round(fontSize * 0.06));
  const sideMargin = Math.round(resX * 0.05);
  const bottomMargin = Math.round(resY * 0.05);
  const topMargin = Math.round(resY * 0.1);

  const columnsOf = (formatLine: string) => formatLine.replace(/^Format\s*:\s*/i, "").split(",").map((name) => name.trim().toLowerCase());
  let styleColumns: string[] = [];
  let eventColumns: string[] = [];
  let inStyles = false;
  let inEvents = false;
  let plusStyles = false;
  const out = text.split("\n").map((line) => {
    const header = /^\[(.*)\]\s*$/.exec(line.trim());
    if (header) {
      const name = header[1]!.toLowerCase();
      inStyles = name === "v4+ styles" || name === "v4 styles";
      plusStyles = name === "v4+ styles";
      inEvents = name === "events";
      return line;
    }
    if (inStyles && /^Format\s*:/i.test(line)) { styleColumns = columnsOf(line); return line; }
    if (inEvents && /^Format\s*:/i.test(line)) { eventColumns = columnsOf(line); return line; }
    if (inStyles && /^Style\s*:/i.test(line) && styleColumns.length) {
      const fields = line.replace(/^Style\s*:\s*/i, "").split(",");
      const set = (column: string, value: string) => { const at = styleColumns.indexOf(column); if (at >= 0 && at < fields.length) fields[at] = value; };
      const alignment = Number(fields[styleColumns.indexOf("alignment")] ?? 2);
      const topAligned = plusStyles && alignment >= 7 && alignment <= 9;
      set("fontname", options.fontName);
      set("fontsize", String(fontSize));
      set("primarycolour", "&H00FFFFFF");
      set("outlinecolour", "&H00000000");
      set("bold", "0");
      set("italic", "0");
      set("scalex", "100");
      set("scaley", "100");
      set("spacing", "0");
      set("borderstyle", "1");
      set("outline", String(outline));
      set("shadow", "1");
      if (plusStyles) set("alignment", topAligned ? String(alignment) : "2");
      set("marginl", String(sideMargin));
      set("marginr", String(sideMargin));
      set("marginv", String(topAligned ? topMargin : bottomMargin));
      return `Style: ${fields.join(",")}`;
    }
    if (inEvents && /^Dialogue\s*:/i.test(line) && eventColumns.length) {
      const body = line.replace(/^Dialogue\s*:\s*/i, "");
      const parts = body.split(",");
      const textAt = eventColumns.indexOf("text");
      if (textAt < 0 || parts.length <= textAt) return line;
      const head = parts.slice(0, textAt);
      const tail = parts.slice(textAt).join(",");
      if (/\\p[1-9]/.test(tail)) return line;
      const cleaned = tail.replace(/\{[^}]*\}/g, (block) => block
        .replace(/\\(?:pos|move|org)\([^)]*\)/g, "")
        .replace(/\\fs\d+(?:\.\d+)?/g, "")
        .replace(/\\fn[^\\}]*/g, "")
        .replace(/\\fsc[xy]?\d+(?:\.\d+)?/g, "")
        .replace(/\\fsp-?\d+(?:\.\d+)?/g, "")
        .replace(/\\(?:bord|shad|xbord|ybord)\d+(?:\.\d+)?/g, ""))
        .replace(/\{\}/g, "");
      return `Dialogue: ${[...head, cleaned].join(",")}`;
    }
    return line;
  });
  return out.join("\n");
}

/**
 * The font families an ASS script asks for, lower case: the style table's font names and the `\fn` overrides inside its lines. A leading `@`
 * (vertical writing) is not part of the name. The result is what a player must find among the video's fonts and the machine's.
 */
export function assFontNames(source: string): string[] {
  const names = new Set<string>();
  let inStyles = false;
  let columns: string[] = [];
  const add = (raw: string | undefined) => {
    const name = (raw ?? "").trim().replace(/^@/, "").trim().toLowerCase();
    if (name) names.add(name);
  };
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    const header = /^\[(.*)\]\s*$/.exec(line.trim());
    if (header) { inStyles = /^v4\+? styles$/i.test(header[1]!); continue; }
    if (inStyles && /^Format\s*:/i.test(line)) { columns = line.replace(/^Format\s*:\s*/i, "").split(",").map((name) => name.trim().toLowerCase()); continue; }
    if (inStyles && /^Style\s*:/i.test(line)) {
      const at = columns.indexOf("fontname");
      if (at >= 0) add(line.replace(/^Style\s*:\s*/i, "").split(",")[at]);
      continue;
    }
    if (/^Dialogue\s*:/i.test(line)) for (const match of line.matchAll(/\\fn([^\\}]+)/g)) add(match[1]);
  }
  return [...names];
}
