import { useSyncExternalStore } from "react";

/**
 * Where the open reader is, for the Agent's right pane. A reader says "this page" or "this moment"; the pane and a send read it.
 * Readers do not know about the Agent, and the Agent does not reach into a reader: this is the one place they meet.
 */
export type ReaderContext =
  | { kind: "comic"; resourceId: string; revisionId: string; title: string; workId?: string | null; pageId: string; pageNumber: number; pageCount: number }
  | { kind: "video"; resourceId: string; revisionId: string; title: string; workId?: string | null; positionMs: number; durationMs: number; frame?: number | null; interval?: { startMs: number; endMs: number } | null }
  | { kind: "novel"; resourceId: string; revisionId: string; title: string; workId?: string | null; partId: string; partTitle: string; start: number; end: number; excerpt: string; debug?: NovelDebug };

/** What the novel reader knows about its own place that a reader does not need to see: it is shown in the context debug panel only. */
export type NovelDebug = {
  /** Where the position came from: the stored progress, or the start of the book. */
  restoredFrom: "progress" | "start";
  restoredOffset: number;
  readRanges: number;
  /** The source file of the part (an EPUB chapter's href), when the format has one. */
  partSourceHref: string | null;
};

/** The novel reader's debug facts from the open book: where the position came from, how much is marked read, the part's source file. */
export function novelDebugOf(progress: { restoredFrom?: string; restoredRange?: { start: number } | null } | null | undefined, readRanges: readonly unknown[] | undefined, part: { sourceHref?: string } | undefined): NovelDebug {
  const fromProgress = progress?.restoredFrom === "progress";
  return { restoredFrom: fromProgress ? "progress" : "start", restoredOffset: fromProgress ? progress?.restoredRange?.start ?? 0 : 0, readRanges: readRanges?.length ?? 0, partSourceHref: part?.sourceHref ?? null };
}

type Listener = () => void;

let exact: ReaderContext | null = null;
let shown: ReaderContext | null = null;
const listeners = new Set<Listener>();

/** What a screen needs to redraw: the page, or the second, not every tick of the clock. */
function sameForDisplay(a: ReaderContext | null, b: ReaderContext | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind || a.resourceId !== b.resourceId || a.revisionId !== b.revisionId || a.title !== b.title || a.workId !== b.workId) return false;
  if (a.kind === "comic" && b.kind === "comic") return a.pageId === b.pageId && a.pageNumber === b.pageNumber && a.pageCount === b.pageCount;
  if (a.kind === "novel" && b.kind === "novel") {
    return a.partId === b.partId && a.start === b.start && a.end === b.end
      && a.debug?.restoredFrom === b.debug?.restoredFrom && a.debug?.restoredOffset === b.debug?.restoredOffset && a.debug?.readRanges === b.debug?.readRanges && a.debug?.partSourceHref === b.debug?.partSourceHref;
  }
  if (a.kind === "video" && b.kind === "video") {
    return Math.floor(a.positionMs / 1000) === Math.floor(b.positionMs / 1000) && a.durationMs === b.durationMs
      && (a.frame ?? null) === (b.frame ?? null) && a.interval?.startMs === b.interval?.startMs && a.interval?.endMs === b.interval?.endMs;
  }
  return false;
}

export const readerContext = {
  /** The exact latest position, for a send. */
  get(): ReaderContext | null {
    return exact;
  },
  set(next: ReaderContext): void {
    exact = next;
    if (sameForDisplay(shown, next)) return;
    shown = next;
    for (const listener of [...listeners]) listener();
  },
  /** The reader closed. Only the reader that set it clears it, so a newer reader's place is not wiped by the older one leaving. */
  clear(resourceId?: string): void {
    if (resourceId && exact?.resourceId !== resourceId) return;
    exact = null;
    if (shown === null) return;
    shown = null;
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  snapshot(): ReaderContext | null {
    return shown;
  },
  /** For tests. */
  reset(): void {
    exact = null;
    shown = null;
    listeners.clear();
  },
};

/** The place the reader is at, redrawn when it changes to a new page or a new second. */
export function useReaderContext(): ReaderContext | null {
  return useSyncExternalStore(readerContext.subscribe, readerContext.snapshot, readerContext.snapshot);
}

/** The mediaContext an `agent.send` carries, from the exact position. `subtitleAheadMs` is the user's explicit widening for this send. */
export function mediaContextFor(context: ReaderContext | null, options: { region?: { x: number; y: number; width: number; height: number }; subtitleAheadMs?: number } = {}) {
  if (!context || context.kind === "novel") return undefined;
  if (context.kind === "comic") {
    return { comic: { resourceId: context.resourceId, resourceRevisionId: context.revisionId, pageId: context.pageId, ...(options.region ? { region: options.region } : {}) } };
  }
  return {
    video: {
      resourceId: context.resourceId,
      resourceRevisionId: context.revisionId,
      positionMs: Math.max(0, Math.round(context.positionMs)),
      ...(context.frame != null ? { frame: context.frame } : {}),
      ...(context.interval ? { interval: { startMs: Math.round(context.interval.startMs), endMs: Math.round(context.interval.endMs) } } : {}),
      ...(options.subtitleAheadMs ? { subtitleAheadMs: options.subtitleAheadMs } : {}),
    },
  };
}
