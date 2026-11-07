import type { Translator } from "@manga/i18n";
import { NORMALIZATION_V1 } from "@manga/contracts/location";
import { renderQuickTask, type QuickPlaceholder, type QuickTask, type RenderedTask } from "@manga/contracts/quick-tasks";
import { formatClock } from "../readers/video-model.ts";
import type { QuoteTag } from "./quote-tags.ts";
import type { ReaderContext } from "./reader-context.ts";
import type { StreamNote, StreamVoice } from "../hooks/use-session-stream.ts";

type T = Translator["t"];

/** Source tags in the words the right pane shows: "第 12 页 · 区域", "12:30—12:45", "选区 128 字". */
export const selectionLabel = (t: T, length: number): string => t("chat.tag.selection", { count: length });
export const regionLabel = (t: T, page: number): string => t("chat.tag.region", { page });
export const intervalLabel = (t: T, startMs: number, endMs: number): string => t("chat.tag.interval", { start: formatClock(startMs), end: formatClock(endMs) });

type Locator = StreamNote["locator"];

/** Where a note or a stretch of speech points, for the label under its bubble. */
export function locatorLabel(t: T, locator: Locator, pageNumber: number | null): string {
  if (!locator) return t("chat.source.work");
  if (locator.kind === "image") {
    const page = pageNumber ? t("chat.source.page", { page: pageNumber }) : t("chat.source.pageUnknown");
    return locator.region ? `${page} · ${t("chat.source.region")}` : page;
  }
  if (locator.kind === "temporal") {
    return locator.endMs !== undefined && locator.endMs > locator.startMs ? `${formatClock(locator.startMs)}—${formatClock(locator.endMs)}` : formatClock(locator.startMs);
  }
  if (locator.kind === "text") {
    const length = Math.max(0, locator.range.end - locator.range.start);
    return length > 1 ? t("chat.tag.selection", { count: length }) : t("chat.source.text");
  }
  return t("chat.source.work");
}

export const noteSourceLabel = (t: T, note: StreamNote): string => locatorLabel(t, note.locator, note.pageNumber);
export const voiceSourceLabel = (t: T, source: StreamVoice["sources"][number]): string => locatorLabel(t, source.locator, null);

/** What a note needs to be anchored where the reader is, or where a tag points. */
export type NoteAnchor = {
  resourceId: string;
  resourceRevisionId: string;
  locator: unknown;
  quoteText?: string;
};

export function anchorFromTag(tag: QuoteTag, t: T): NoteAnchor {
  if (tag.kind === "selection") {
    return {
      resourceId: tag.resourceId, resourceRevisionId: tag.revisionId, quoteText: tag.quote.slice(0, 2000),
      locator: { kind: "text", partId: tag.partId ?? "", representationId: tag.revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: tag.start, end: Math.max(tag.end, tag.start) }, quote: { exact: tag.quote.slice(0, 2000) } },
    };
  }
  if (tag.kind === "region") {
    return { resourceId: tag.resourceId, resourceRevisionId: tag.revisionId, quoteText: regionLabel(t, tag.pageNumber), locator: { kind: "image", pageId: tag.pageId, region: tag.region } };
  }
  return { resourceId: tag.resourceId, resourceRevisionId: tag.revisionId, quoteText: intervalLabel(t, tag.startMs, tag.endMs), locator: { kind: "temporal", startMs: tag.startMs, endMs: tag.endMs } };
}

/** With nothing picked, a note is anchored at the place the reader is: the page, the moment, or the text on screen. */
export function anchorFromContext(context: ReaderContext, t: T): NoteAnchor {
  if (context.kind === "comic") {
    return { resourceId: context.resourceId, resourceRevisionId: context.revisionId, quoteText: t("chat.source.page", { page: context.pageNumber }), locator: { kind: "image", pageId: context.pageId } };
  }
  if (context.kind === "video") {
    const at = Math.max(0, Math.round(context.positionMs));
    return { resourceId: context.resourceId, resourceRevisionId: context.revisionId, quoteText: formatClock(at), locator: { kind: "temporal", startMs: at } };
  }
  return {
    resourceId: context.resourceId, resourceRevisionId: context.revisionId, quoteText: context.partTitle,
    locator: { kind: "text", partId: context.partId, representationId: context.revisionId, normalizationVersion: NORMALIZATION_V1, range: { start: context.start, end: Math.max(context.end, context.start) }, quote: { exact: context.excerpt.slice(0, 32) || context.partTitle.slice(0, 32) || "·" } },
  };
}

/** The page a quick task is for, from the shell page and the open reader. */
export function quickPageFor(page: string): "library" | "work" | "novel" | "comic" | "video" | "chat" {
  if (page === "reading") return "novel";
  if (page === "comic" || page === "video" || page === "work" || page === "library") return page;
  return "chat";
}

/** The values a quick task's placeholders take from what is on screen. Anything missing stays empty and the message says so. */
export function quickValues(input: { workTitle?: string | null; author?: string | null; context: ReaderContext | null; tags: readonly QuoteTag[]; subtitleWindow?: string | null; userInput?: string; t: T }): Partial<Record<QuickPlaceholder, string>> {
  const { context, t } = input;
  let position = "";
  if (context?.kind === "comic") position = t("chat.quick.positionComic", { page: context.pageNumber, count: context.pageCount });
  else if (context?.kind === "video") position = formatClock(context.positionMs);
  else if (context?.kind === "novel") position = context.partTitle;
  const selected = input.tags.find((tag) => tag.kind === "selection");
  const interval = input.tags.find((tag) => tag.kind === "interval");
  return {
    作品: input.workTitle ?? context?.title ?? "",
    作者: input.author ?? "",
    当前位置: position,
    选区: selected?.kind === "selection" ? selected.quote : interval?.kind === "interval" ? intervalLabel(t, interval.startMs, interval.endMs) : "",
    字幕窗口: input.subtitleWindow ?? "",
    用户输入: input.userInput ?? "",
  };
}

export function renderQuick(task: Pick<QuickTask, "template">, values: Partial<Record<QuickPlaceholder, string>>, t: T): RenderedTask {
  return renderQuickTask(task.template, values, {
    empty: (names) => t("chat.quick.empty", { names }),
    truncated: t("chat.quick.truncated"),
  });
}

/** A short title for a note made from the pane: the first line of what was typed, or the place the note points at. */
export function noteTitleOf(text: string, fallback: string): string {
  const first = text.trim().split(/\r?\n/)[0] ?? "";
  const clipped = [...first].slice(0, 40).join("");
  return clipped || fallback;
}
