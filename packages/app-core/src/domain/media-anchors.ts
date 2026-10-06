import { MangaError, type ImageLocator, type SourceLocator, type TemporalLocator } from "@manga/contracts";
import type { DrizzleStore } from "@manga/storage-drizzle";
import { readLayout } from "./revision-layout.ts";

/** Tolerance past the probed duration: containers round their length, and a stored end time may sit on the last frame. */
const TIME_SLACK_MS = 1000;

export type MediaResolution = {
  status: "resolved" | "missing_capability" | "unresolved";
  kind: "image" | "temporal";
  pageId?: string;
  pageIndex?: number;
  pageCount?: number;
  region?: ImageLocator["region"];
  startMs?: number;
  endMs?: number;
  durationMs?: number;
  reason?: string;
};

/**
 * Resolve a page or time locator against the revision it was created on. A revision of a different fingerprint is a
 * different revision row, so a time anchor on the old video never resolves on the new one.
 */
export function resolveMediaLocator(store: DrizzleStore, revisionId: string, locator: ImageLocator | TemporalLocator): MediaResolution {
  const layout = readLayout(store, revisionId);
  if (locator.kind === "image") {
    if (!layout?.pages) return { status: "missing_capability", kind: "image", reason: "this revision has no pages" };
    const index = layout.pages.indexOf(locator.pageId);
    if (index < 0) return { status: "unresolved", kind: "image", pageId: locator.pageId, reason: "page is not part of this revision" };
    return { status: "resolved", kind: "image", pageId: locator.pageId, pageIndex: index, pageCount: layout.pages.length, region: locator.region };
  }
  if (!layout || layout.unit !== "ms") return { status: "missing_capability", kind: "temporal", reason: "this revision is not a video" };
  const end = locator.endMs ?? locator.startMs;
  if (locator.startMs > layout.total + TIME_SLACK_MS || end > layout.total + TIME_SLACK_MS) {
    return { status: "unresolved", kind: "temporal", startMs: locator.startMs, endMs: locator.endMs, durationMs: layout.total, reason: "time is outside this video" };
  }
  return { status: "resolved", kind: "temporal", startMs: locator.startMs, endMs: locator.endMs, durationMs: layout.total };
}

/** A note or bookmark may only name a place its revision actually has. Text locators are checked by the text resolver. */
export function assertLocatorFits(store: DrizzleStore, revisionId: string, locator: SourceLocator): void {
  if (locator.kind === "text") return;
  const resolved = resolveMediaLocator(store, revisionId, locator);
  if (resolved.status === "resolved") return;
  throw new MangaError(resolved.status === "missing_capability" ? "UNSUPPORTED_FORMAT" : "VALIDATION_ERROR", resolved.reason ?? "locator does not fit this revision");
}

/** Text shown in the quote block of a note taken from a page or a time range. */
export function describeMediaLocator(locator: ImageLocator | TemporalLocator, label?: string): string {
  if (locator.kind === "image") return label ?? (locator.region ? "页面区域" : "页面");
  const clock = (ms: number) => {
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return `${h ? `${h}:` : ""}${String(m).padStart(h ? 2 : 1, "0")}:${String(s).padStart(2, "0")}`;
  };
  return label ?? (locator.endMs !== undefined ? `${clock(locator.startMs)} – ${clock(locator.endMs)}` : clock(locator.startMs));
}
