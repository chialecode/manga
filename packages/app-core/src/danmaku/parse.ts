import type { DanmakuItem, DanmakuMode } from "@manga/contracts";
import type { DandanComments } from "./client.ts";

/** The network's modes: 1 scrolls right to left, 4 sits at the bottom, 5 at the top. The others (reverse, positioned) are shown as scrolling ones. */
const MODES: Record<number, DanmakuMode> = { 1: "scroll", 2: "scroll", 3: "scroll", 6: "scroll", 4: "bottom", 5: "top" };

/** Comments kept per episode, so one very busy episode cannot fill the cache or the display. */
export const MAX_COMMENTS = 30_000;
const MAX_TEXT = 200;

/**
 * The prefix the network puts before the sender of a comment taken from another site, as `[BiliBili]1234`. It is the source the person can switch
 * off. The network's own comments have a plain number and so the empty prefix.
 */
export function sourceOf(sender: string): string {
  const found = /^\[([^\]]{1,32})\]/.exec(sender.trim());
  return found ? found[1]! : "";
}

/** One `p` field is `time,mode,color,sender` (the sender may hold commas in other sources; only the first three are fixed). */
export function parseComments(raw: DandanComments): DanmakuItem[] {
  const items: DanmakuItem[] = [];
  for (const comment of raw.comments) {
    const parts = comment.p.split(",");
    const seconds = Number(parts[0]);
    const mode = MODES[Number(parts[1])];
    const color = Number(parts[2]);
    if (!Number.isFinite(seconds) || seconds < 0 || !mode) continue;
    const text = comment.m.replace(/[\r\n\t]+/g, " ").trim().slice(0, MAX_TEXT);
    if (!text) continue;
    items.push({
      at: Math.round(seconds * 1000),
      mode,
      color: Number.isFinite(color) && color >= 0 && color <= 0xffffff ? Math.floor(color) : 0xffffff,
      source: sourceOf(parts.slice(3).join(",")),
      text,
    });
  }
  items.sort((a, b) => a.at - b.at);
  // A busier episode is thinned evenly, so the end of it is not left bare.
  return items.length > MAX_COMMENTS ? Array.from({ length: MAX_COMMENTS }, (_, index) => items[Math.floor((index * items.length) / MAX_COMMENTS)]!) : items;
}
