import { useCallback, useEffect, useRef, useState } from "react";
import { call, messageOf } from "../lib/api.ts";
import { closePdfDocument } from "./pdf-doc.ts";
import { evictFarthest } from "./comic-model.ts";

export type PageSource =
  | { state: "ready"; kind: "image" | "pdf"; url: string; width: number; height: number; pageNumber?: number }
  | { state: "missing"; reason: string };

type Handle = {
  pageId: string;
  available: boolean;
  reason?: string;
  kind?: "image" | "pdf";
  url?: string;
  width?: number;
  height?: number;
  pageNumber?: number;
};

const BATCH = 12;

/**
 * Display sources for the pages of one comic revision, loaded on demand. Handles are asked for in batches, a page that
 * is already loaded or on its way is never asked for twice, and only a bounded number stay cached: the ones farthest
 * from the reading position go first. A PDF comic shares one document handle across its pages, so the file is opened
 * once.
 */
export function usePageSources(target: { resourceId: string; revisionId: string; pageIds: readonly string[] } | null, capacity = 24) {
  const [sources, setSources] = useState<Record<string, PageSource>>({});
  const sourcesRef = useRef<Record<string, PageSource>>({});
  const inflight = useRef(new Set<string>());
  const epoch = useRef(0);
  const documentUrl = useRef<string | null>(null);
  const key = target ? `${target.resourceId}:${target.revisionId}` : "";
  const idsRef = useRef<readonly string[]>([]);
  idsRef.current = target?.pageIds ?? [];
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    epoch.current += 1;
    inflight.current.clear();
    if (documentUrl.current) closePdfDocument(documentUrl.current);
    documentUrl.current = null;
    sourcesRef.current = {};
    setSources({});
  }, [key]);

  const commit = (next: Record<string, PageSource>) => {
    sourcesRef.current = next;
    setSources(next);
  };

  /** Ask for the pages at `indexes`; `keep` are the indexes that must stay cached whatever the capacity. */
  const load = useCallback(async (indexes: readonly number[], keep: readonly number[] = indexes) => {
    const current = targetRef.current;
    if (!current) return;
    const mine = epoch.current;
    const ids = idsRef.current;
    const want = indexes
      .filter((index) => index >= 0 && index < ids.length)
      .map((index) => ids[index]!)
      .filter((id, position, all) => all.indexOf(id) === position && !sourcesRef.current[id] && !inflight.current.has(id));
    for (let at = 0; at < want.length; at += BATCH) {
      const batch = want.slice(at, at + BATCH);
      for (const id of batch) inflight.current.add(id);
      let handles: Handle[];
      try {
        const result = await call<{ pages: Handle[] }>("comic.pageHandles", { resourceId: current.resourceId, revisionId: current.revisionId, pageIds: batch });
        handles = Array.isArray(result.pages) ? result.pages : [];
      } catch (error) {
        handles = batch.map((pageId) => ({ pageId, available: false, reason: messageOf(error) }));
      }
      for (const id of batch) inflight.current.delete(id);
      if (epoch.current !== mine) return;
      const next = { ...sourcesRef.current };
      for (const handle of handles) {
        if (handle.available && handle.url) {
          let url = handle.url;
          if (handle.kind === "pdf") {
            documentUrl.current ??= handle.url;
            url = documentUrl.current;
          }
          next[handle.pageId] = { state: "ready", kind: handle.kind ?? "image", url, width: handle.width ?? 0, height: handle.height ?? 0, ...(handle.pageNumber !== undefined ? { pageNumber: handle.pageNumber } : {}) };
        } else next[handle.pageId] = { state: "missing", reason: handle.reason ?? "" };
      }
      // A page that was asked for and not answered is a miss too, so the placeholder never waits forever.
      for (const id of batch) if (!next[id]) next[id] = { state: "missing", reason: "" };
      const indexOf = new Map(ids.map((id, index) => [id, index] as const));
      const cachedIndexes = Object.keys(next).map((id) => indexOf.get(id)).filter((index): index is number => index !== undefined);
      for (const index of evictFarthest(cachedIndexes, keep, capacity)) delete next[ids[index]!];
      commit(next);
    }
  }, [capacity]);

  /** Forget a page so the next `load` asks again, for an image that failed to decode or a handle that expired. */
  const forget = useCallback((pageId: string) => {
    if (!(pageId in sourcesRef.current)) return;
    const next = { ...sourcesRef.current };
    const dropped = next[pageId];
    delete next[pageId];
    if (dropped?.state === "ready" && dropped.kind === "pdf" && dropped.url === documentUrl.current) {
      // The shared document handle is no good any more; every PDF page asks for a new one.
      closePdfDocument(documentUrl.current);
      documentUrl.current = null;
      for (const [id, source] of Object.entries(next)) if (source.state === "ready" && source.kind === "pdf") delete next[id];
    }
    commit(next);
  }, []);

  return { sources, load, forget };
}
