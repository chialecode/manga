import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { asArray, attempt, messageOf } from "./api.ts";
import type { WorkPage, WorkSummary } from "./works.ts";

export type WorksQuery = {
  kind?: string;
  shelf?: string;
  query?: string;
  linked?: boolean;
  format?: string;
  hasNotes?: boolean;
  sort?: "recent" | "added" | "title" | "progress";
};

export type PagedWorks = {
  items: WorkSummary[];
  total: number;
  nextCursor: string | null;
  status: "loading" | "ready" | "error";
  loadingMore: boolean;
  error?: string;
  loadMore: () => void;
  reload: () => void;
};

type FirstPage = { items: WorkSummary[]; total: number; nextCursor: string | null };

/**
 * The first page of each query the window has shown. A shelf that is shown again paints it at once and asks for the list
 * again behind it, so switching pages does not wait for the main process, which can be busy with an import. Without a
 * provider (a lone hook in a test) nothing is kept.
 */
export type WorksCache = Map<string, FirstPage>;
export const WorksCacheContext = createContext<WorksCache | null>(null);
const CACHE_LIMIT = 24;

/** A page crosses the IPC boundary, so its shape is checked before it is trusted. */
export function normalizePage(value: Partial<WorkPage> | undefined): WorkPage {
  const items = asArray<WorkSummary>(value?.items);
  return { items, total: typeof value?.total === "number" ? value.total : items.length, nextCursor: typeof value?.nextCursor === "string" ? value.nextCursor : null };
}

/**
 * One filtered, sorted view of the library, a page at a time. A change of query replaces the list; a refresh with the same
 * query keeps what is on screen until the new answer arrives, so a background update never blanks the shelf.
 */
export function usePagedWorks(query: WorksQuery | null, refreshKey: number, pageSize = 60): PagedWorks {
  const cache = useContext(WorksCacheContext);
  const cacheKey = `${query ? JSON.stringify(query) : ""}|${pageSize}`;
  const [state, setState] = useState<{ queryKey: string; items: WorkSummary[]; total: number; nextCursor: string | null; status: "loading" | "ready" | "error"; error?: string }>(() => {
    const kept = query ? cache?.get(cacheKey) : undefined;
    return kept?.items.length ? { queryKey: JSON.stringify(query), ...kept, status: "ready" } : { queryKey: "", items: [], total: 0, nextCursor: null, status: "loading" };
  });
  const [loadingMore, setLoadingMore] = useState(false);
  const token = useRef(0);
  const [manual, setManual] = useState(0);
  const queryKey = query ? JSON.stringify(query) : "";
  const latest = useRef({ queryKey, nextCursor: state.nextCursor, loadingMore });
  latest.current = { queryKey, nextCursor: state.nextCursor, loadingMore };

  useEffect(() => {
    if (!query) return;
    const mine = ++token.current;
    const kept = cache?.get(cacheKey);
    setState((current) => current.queryKey === queryKey ? { ...current, status: current.items.length ? "ready" : "loading" } : kept?.items.length ? { queryKey, ...kept, status: "ready" } : { queryKey, items: [], total: 0, nextCursor: null, status: "loading" });
    void attempt<WorkPage>("works.list", { ...query, limit: pageSize }).then((result) => {
      if (mine !== token.current) return;
      if (!result.ok) { setState((current) => ({ ...current, queryKey, status: "error", error: messageOf(result.error) })); return; }
      const page = normalizePage(result.value);
      if (cache) {
        cache.delete(cacheKey);
        cache.set(cacheKey, { items: page.items, total: page.total, nextCursor: page.nextCursor });
        for (const old of [...cache.keys()].slice(0, Math.max(0, cache.size - CACHE_LIMIT))) cache.delete(old);
      }
      setState({ queryKey, items: page.items, total: page.total, nextCursor: page.nextCursor, status: "ready" });
      setLoadingMore(false);
    });
    // The query object is summarized by its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, refreshKey, manual, pageSize]);

  const loadMore = useCallback(() => {
    const { nextCursor, loadingMore: busy, queryKey: key } = latest.current;
    if (!query || !nextCursor || busy) return;
    const mine = token.current;
    setLoadingMore(true);
    void attempt<WorkPage>("works.list", { ...query, cursor: nextCursor, limit: pageSize }).then((result) => {
      if (mine !== token.current) return;
      setLoadingMore(false);
      if (!result.ok) { setState((current) => current.queryKey === key ? { ...current, status: "error", error: messageOf(result.error) } : current); return; }
      const page = normalizePage(result.value);
      setState((current) => {
        if (current.queryKey !== key) return current;
        const known = new Set(current.items.map((item) => item.id));
        return { ...current, status: "ready", error: undefined, items: [...current.items, ...page.items.filter((item) => !known.has(item.id))], total: page.total, nextCursor: page.nextCursor };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, pageSize]);

  return { items: state.queryKey === queryKey ? state.items : [], total: state.total, nextCursor: state.nextCursor, status: state.queryKey === queryKey ? state.status : "loading", loadingMore, error: state.error, loadMore, reload: () => setManual((value) => value + 1) };
}
