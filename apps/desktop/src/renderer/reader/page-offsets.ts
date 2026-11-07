import { screenAt, type PageFrame } from "./pages.ts";

/**
 * Between pages and text offsets (A-115): which character starts a screen, and which screen shows a character. Offsets are code points of the
 * text layer (`NORMALIZATION_V1`) counted the way a selection is (`readingSelection`): every text node of the body in order, hidden separators
 * included. Positions come from the layout itself (`Range` boxes), so they hold for any font, size, spacing or window.
 */

const codePoints = (text: string): number => [...text].length;

function textNodes(body: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

/**
 * The element takes no part in the layout (a tab that is not in front is `display: none`): no character has a box, so no page can be worked out and
 * none may be reported. Where there is no layout engine at all the answer is no: the callers fall back on the start of the text.
 */
export function outOfLayout(element: HTMLElement): boolean {
  if (typeof element.ownerDocument.createRange().getClientRects !== "function") return false;
  return element.getClientRects().length === 0;
}

/**
 * The saved position is on this page, so nothing moved: the page starts at or before the saved character, depending on where the window around it began,
 * and saving that start would walk the position back a little at each opening.
 */
export function pageHolds(saved: { partId: string; start: number } | null, page: { partId: string; start: number; end: number }): boolean {
  if (!saved || saved.partId !== page.partId || saved.start < page.start) return false;
  return saved.start < page.end || saved.start === page.start;
}

/** The left edge of one character, measured from the strip's left edge, or null when it has no box (hidden, or no layout engine). */
function charX(node: Text, index: number, base: number): number | null {
  const range = node.ownerDocument.createRange();
  range.setStart(node, index);
  range.setEnd(node, Math.min(node.length, index + 1));
  if (typeof range.getClientRects !== "function") return null;
  const rect = range.getClientRects()[0];
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;
  return rect.left - base;
}

/** Steps an index back off the second half of a surrogate pair, so a character is never split. */
function whole(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return index > 0 && code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}

/** The offset of the first character shown on a screen; `fallback` when the layout gives no boxes. */
export function firstOffsetOnScreen(body: HTMLElement, frame: PageFrame, screen: number, sliceStart: number, fallback: number): number {
  const base = body.getBoundingClientRect().left;
  let before = 0;
  for (const node of textNodes(body)) {
    const text = node.data;
    if (!text.length) continue;
    const lastX = charX(node, whole(text, text.length - 1), base);
    if (lastX === null || screenAt(lastX, frame) < screen) { before += codePoints(text); continue; }
    // The first character of this node on the screen or after it: the screens only grow along a node.
    let low = 0;
    let high = text.length - 1;
    while (low < high) {
      const middle = whole(text, (low + high) >> 1);
      const x = charX(node, middle, base);
      if (x !== null && screenAt(x, frame) >= screen) high = middle;
      else low = middle + (text.charCodeAt(middle) >= 0xd800 && text.charCodeAt(middle) <= 0xdbff ? 2 : 1);
    }
    return sliceStart + before + codePoints(text.slice(0, low));
  }
  return fallback;
}

/** The screen that shows the character at an offset; null when the offset is not in the body or the layout gives no boxes. */
export function screenOfOffset(body: HTMLElement, frame: PageFrame, sliceStart: number, offset: number): number | null {
  let left = offset - sliceStart;
  if (left < 0) return null;
  const base = body.getBoundingClientRect().left;
  for (const node of textNodes(body)) {
    const text = node.data;
    const count = codePoints(text);
    if (left < count) {
      const index = [...text].slice(0, left).join("").length;
      const x = charX(node, index, base);
      return x === null ? null : screenAt(x, frame);
    }
    left -= count;
  }
  return null;
}
