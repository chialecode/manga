/**
 * The comic reader's page arithmetic, kept free of React and the DOM so every rule can be tested on its own:
 * which pages share a spread, what order they show in, how a page is scaled, which pages to load next and what a
 * dragged rectangle means in page space.
 */

export type ComicDirection = "ltr" | "rtl";
export type ComicLayout = "single" | "double" | "strip";
export type ComicFit = "width" | "height" | "page" | "original";
export type ComicAnimation = "none" | "slide" | "fade";

export type ComicPageInfo = {
  id: string;
  index: number;
  name: string;
  width: number;
  height: number;
  spread: boolean;
  ok: boolean;
  error?: string;
};

/** Page indexes in reading order. One or two pages. */
export type Spread = { pages: number[] };

export type Size = { width: number; height: number };
export type Region = { x: number; y: number; width: number; height: number };

/** A page that is already a double-page picture is shown alone; so is anything clearly wider than tall. */
export function isWide(page: ComicPageInfo | undefined): boolean {
  if (!page) return false;
  if (page.spread) return true;
  return page.width > 0 && page.height > 0 && page.width > page.height * 1.15;
}

/**
 * Group pages into what is on screen at once. Single and strip show one page at a time. Double pairs pages in reading
 * order; the cover stays alone when asked, and a wide page or a page with no partner is shown alone, so the pairing
 * never pushes a spread picture into a half.
 */
export function buildSpreads(pages: readonly ComicPageInfo[], layout: ComicLayout, coverAlone: boolean): Spread[] {
  const out: Spread[] = [];
  if (layout !== "double") {
    for (let index = 0; index < pages.length; index += 1) out.push({ pages: [index] });
    return out;
  }
  let index = 0;
  if (coverAlone && pages.length > 0) {
    out.push({ pages: [0] });
    index = 1;
  }
  while (index < pages.length) {
    const first = pages[index];
    const second = pages[index + 1];
    if (!isWide(first) && second && !isWide(second)) {
      out.push({ pages: [index, index + 1] });
      index += 2;
    } else {
      out.push({ pages: [index] });
      index += 1;
    }
  }
  return out;
}

/** Which spread a page is on; -1 only for an empty list or an index outside it. */
export function spreadIndexOf(spreads: readonly Spread[], pageIndex: number): number {
  return spreads.findIndex((spread) => spread.pages.includes(pageIndex));
}

/** Moving past either end stays where it is, so a key held down at the last page does nothing. */
export function stepSpread(spreads: readonly Spread[], current: number, delta: number): number {
  if (!spreads.length) return 0;
  return Math.min(spreads.length - 1, Math.max(0, current + delta));
}

/** Left-to-right screen order of a spread: a right-to-left book puts the first page of the pair on the right. */
export function visualOrder(spread: Spread, direction: ComicDirection): number[] {
  return direction === "rtl" ? [...spread.pages].reverse() : [...spread.pages];
}

/** The size of a spread: its pages scaled to one common height and set side by side. Unknown sizes count as a 2:3 page. */
export function spreadSize(pages: readonly ComicPageInfo[]): Size {
  const sized = pages.map((page) => (page.width > 0 && page.height > 0 ? { width: page.width, height: page.height } : { width: 2, height: 3 }));
  if (!sized.length) return { width: 2, height: 3 };
  const height = Math.max(...sized.map((page) => page.height));
  return { width: sized.reduce((sum, page) => sum + (page.width * height) / page.height, 0), height };
}

/** The scale that makes `size` meet the viewport under the chosen fit. `zoom` multiplies it. */
export function fitScale(fit: ComicFit, size: Size, viewport: Size, zoom = 1): number {
  const safe = (value: number) => (Number.isFinite(value) && value > 0 ? value : 1);
  const across = viewport.width / safe(size.width);
  const down = viewport.height / safe(size.height);
  const base = fit === "width" ? across : fit === "height" ? down : fit === "page" ? Math.min(across, down) : 1;
  return safe(base) * safe(zoom);
}

/** Pixel size of a spread on screen. Rounded so two pages of a spread never leave a hairline seam. */
export function fittedSize(fit: ComicFit, pages: readonly ComicPageInfo[], viewport: Size, zoom = 1): Size {
  const natural = spreadSize(pages);
  const scale = fitScale(fit, natural, viewport, zoom);
  return { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) };
}

/** Pixel size of each page of a spread, in the given order. The pages share one height, so the pair lines up. */
export function pageBoxes(fit: ComicFit, pages: readonly ComicPageInfo[], viewport: Size, zoom = 1): Size[] {
  const natural = spreadSize(pages);
  const scale = fitScale(fit, natural, viewport, zoom);
  const height = Math.max(1, Math.round(natural.height * scale));
  return pages.map((page) => {
    const ratio = page.width > 0 && page.height > 0 ? page.width / page.height : 2 / 3;
    return { width: Math.max(1, Math.round(height * ratio)), height };
  });
}

/** Pages worth loading ahead of time: the next ones in reading order first, then one behind. Never more than `limit`. */
export function prefetchPages(spreads: readonly Spread[], current: number, options: { ahead?: number; behind?: number; limit?: number } = {}): number[] {
  const ahead = options.ahead ?? 2;
  const behind = options.behind ?? 1;
  const limit = options.limit ?? 6;
  const out: number[] = [];
  const add = (spread: Spread | undefined) => {
    if (!spread) return;
    for (const page of spread.pages) if (out.length < limit && !out.includes(page)) out.push(page);
  };
  for (let step = 1; step <= ahead; step += 1) add(spreads[current + step]);
  for (let step = 1; step <= behind; step += 1) add(spreads[current - step]);
  return out;
}

/** The pages a cache of at most `capacity` entries should keep: those nearest the wanted ones. */
export function evictFarthest(cached: readonly number[], wanted: readonly number[], capacity: number): number[] {
  if (cached.length <= capacity) return [];
  const centre = wanted.length ? wanted.reduce((sum, value) => sum + value, 0) / wanted.length : 0;
  const keep = new Set(wanted);
  const droppable = cached.filter((page) => !keep.has(page)).sort((a, b) => Math.abs(b - centre) - Math.abs(a - centre));
  return droppable.slice(0, cached.length - capacity);
}

export type ComicKeyAction = "next" | "prev" | "first" | "last" | "zoomIn" | "zoomOut" | "zoomReset" | "fullscreen" | "escape";

/**
 * What a key does. Arrow keys follow the reading direction, so the key on the side the next page comes from goes next.
 * A strip scrolls with the browser's own keys, so only the keys that have no scroll meaning are taken there.
 */
export function comicKeyAction(event: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }, direction: ComicDirection, layout: ComicLayout): ComicKeyAction | null {
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier) {
    if (event.key === "+" || event.key === "=") return "zoomIn";
    if (event.key === "-") return "zoomOut";
    if (event.key === "0") return "zoomReset";
    return null;
  }
  if (event.key === "f" || event.key === "F") return "fullscreen";
  if (event.key === "Escape") return "escape";
  if (layout === "strip") return null;
  switch (event.key) {
    case "ArrowRight": return direction === "rtl" ? "prev" : "next";
    case "ArrowLeft": return direction === "rtl" ? "next" : "prev";
    case "PageDown": return "next";
    case "PageUp": return "prev";
    case " ": return event.shiftKey ? "prev" : "next";
    case "Home": return "first";
    case "End": return "last";
    default: return null;
  }
}

/** A click on the left or right third turns the page; the middle is left alone. Reading direction decides which is next. */
export function tapAction(x: number, width: number, direction: ComicDirection): "next" | "prev" | null {
  if (width <= 0) return null;
  const fraction = x / width;
  if (fraction < 1 / 3) return direction === "rtl" ? "next" : "prev";
  if (fraction > 2 / 3) return direction === "rtl" ? "prev" : "next";
  return null;
}

export function effectiveAnimation(setting: ComicAnimation, reducedMotion: boolean): ComicAnimation {
  return reducedMotion ? "none" : setting;
}

/** The smallest rectangle a drag may be to count as a selection, in CSS pixels. A click is not a selection. */
export const MIN_REGION_PX = 8;

/** A drag between two points inside a displayed page, as a fraction of that page. Null for a click or a sliver. */
export function regionFromPoints(from: { x: number; y: number }, to: { x: number; y: number }, box: Size): Region | null {
  if (box.width <= 0 || box.height <= 0) return null;
  const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));
  const left = clamp(Math.min(from.x, to.x), box.width);
  const right = clamp(Math.max(from.x, to.x), box.width);
  const top = clamp(Math.min(from.y, to.y), box.height);
  const bottom = clamp(Math.max(from.y, to.y), box.height);
  if (right - left < MIN_REGION_PX || bottom - top < MIN_REGION_PX) return null;
  return {
    x: round(left / box.width),
    y: round(top / box.height),
    width: Math.min(round((right - left) / box.width), round(1 - left / box.width)),
    height: Math.min(round((bottom - top) / box.height), round(1 - top / box.height)),
  };
}

const round = (value: number) => Math.round(value * 1e6) / 1e6;

export function regionStyle(region: Region): { left: string; top: string; width: string; height: string } {
  const percent = (value: number) => `${(value * 100).toFixed(4)}%`;
  return { left: percent(region.x), top: percent(region.y), width: percent(region.width), height: percent(region.height) };
}

/** Which page of a strip is at the top of the view, given each page's pixel top and the scroll position. */
export function topPageOfStrip(tops: readonly number[], heights: readonly number[], scrollTop: number): number {
  for (let index = 0; index < tops.length; index += 1) {
    if (tops[index]! + heights[index]! > scrollTop + 1) return index;
  }
  return Math.max(0, tops.length - 1);
}

/** The page offsets of a strip: each page's height at the strip's width, with the gap between pages. */
export function stripLayout(pages: readonly ComicPageInfo[], width: number, gap: number): { tops: number[]; heights: number[]; total: number } {
  const tops: number[] = [];
  const heights: number[] = [];
  let y = 0;
  for (const page of pages) {
    const ratio = page.width > 0 && page.height > 0 ? page.height / page.width : 3 / 2;
    const height = Math.max(1, Math.round(width * ratio));
    tops.push(y);
    heights.push(height);
    y += height + gap;
  }
  return { tops, heights, total: Math.max(0, y - gap) };
}

/** Pages in `[first, last]` of a strip that are on screen or within `overscan` pixels of it. */
export function visibleStripRange(tops: readonly number[], heights: readonly number[], scrollTop: number, viewportHeight: number, overscan: number): { first: number; last: number } {
  if (!tops.length) return { first: 0, last: -1 };
  const from = scrollTop - overscan;
  const to = scrollTop + viewportHeight + overscan;
  let first = tops.length - 1;
  let last = 0;
  for (let index = 0; index < tops.length; index += 1) {
    const bottom = tops[index]! + heights[index]!;
    if (bottom >= from && tops[index]! <= to) {
      first = Math.min(first, index);
      last = Math.max(last, index);
    }
  }
  return first > last ? { first: topPageOfStrip(tops, heights, scrollTop), last: topPageOfStrip(tops, heights, scrollTop) } : { first, last };
}
