import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  SIDEBAR_GROUP_SHOWN, SIDEBAR_PAGE_MAX, contextFromKey, contextKey,
  type ContextId, type RailPatch, type RailPreference, type RailView, type SidebarItem, type SidebarSection, type SidebarView,
} from "@manga/contracts";
import { attempt } from "./lib/api.ts";
import { useServices } from "./workspace/services.tsx";

/**
 * What the sidebar and its cards read (A-99, 交互设计 2.10): the answer of `workspace.sidebar` for a view, kept for the views already seen so that a
 * click on an icon draws the list at once and the answer then replaces it, and the pages "更多" asks for.
 */
export type SidebarCache = Map<string, SidebarView>;
export const createSidebarCache = (): SidebarCache => new Map();

/** The rail's own state, which the views read and change: which groups are open in each, and (for the rail itself) which icons are out and which view is on. */
export const RailContext = createContext<{ rail: RailPreference; change: (patch: RailPatch) => void; cache: SidebarCache } | null>(null);

export function useRail() {
  const value = useContext(RailContext);
  if (!value) throw new Error("no rail around this component");
  return value;
}

/** The groups that are open in a view: the ones the person opened, else "最近"; the context on screen is always open. */
export function openKeysOf(rail: RailPreference, view: RailView, current: ContextId): string[] {
  const kept = rail.open[view] ?? [""];
  return [...new Set([...kept, contextKey(current)])];
}

export type More = { items: SidebarItem[]; next: string | null };
export type SidebarData = {
  data: SidebarView | null;
  status: "loading" | "ready" | "error";
  /** The pages "更多" has added to a section, by `<view>|<context>|<type>`. */
  more: Record<string, More>;
  loadMore: (contextId: ContextId, type: string, cursor: string | null) => Promise<void>;
  reload: () => void;
};

const sectionKey = (view: string, contextId: ContextId, type: string) => `${view}|${contextKey(contextId)}|${type}`;
export { sectionKey };

/**
 * The answer for one view. It is asked again when the view, the groups that are open or the context on screen change, and when something the lists show
 * has changed (a conversation, a project, the shelf, or a command of `lib/lists-changed.ts`); an answer that comes after a newer question is dropped.
 * The sections that were opened with "更多" are asked for again, to the length they had, so a refresh does not close them.
 */
export function useSidebarData(view: RailView): SidebarData {
  const s = useServices();
  const { rail, cache } = useRail();
  const [data, setData] = useState<SidebarView | null>(() => cache.get(view) ?? null);
  const [status, setStatus] = useState<SidebarData["status"]>(() => (cache.has(view) ? "ready" : "loading"));
  const [more, setMore] = useState<Record<string, More>>({});
  const moreRef = useRef(more);
  moreRef.current = more;
  const latest = useRef(0);
  const [again, setAgain] = useState(0);
  const open = useMemo(() => openKeysOf(rail, view, s.currentContext), [rail, view, s.currentContext]);
  const wanted = open.join("\n");

  useEffect(() => {
    const kept = cache.get(view) ?? null;
    setData(kept);
    setStatus(kept ? "ready" : "loading");
    setMore({});
  }, [view, cache]);

  useEffect(() => {
    const mine = ++latest.current;
    void (async () => {
      const result = await attempt<SidebarView>("workspace.sidebar", { view, perGroup: SIDEBAR_GROUP_SHOWN, open: open.map((key) => contextFromKey(key)) });
      if (mine !== latest.current) return;
      if (!result.ok || !Array.isArray(result.value?.groups)) { setStatus("error"); return; }
      cache.set(view, result.value);
      setData(result.value);
      setStatus("ready");
      // The sections that were opened with "更多" are read again, to the length they had.
      const kept = Object.entries(moreRef.current).filter(([key]) => key.startsWith(`${view}|`));
      if (kept.length === 0) return;
      const refreshed: Record<string, More> = {};
      await Promise.all(kept.map(async ([key, before]) => {
        const [, ctx = "", type = ""] = key.split("|");
        const section = result.value.groups.find((group) => contextKey(group.contextId) === ctx)?.sections.find((item) => item.type === type);
        if (!section || section.nextCursor === null) return;
        const size = Math.min(SIDEBAR_PAGE_MAX, Math.max(20, before.items.length));
        const page = await attempt<{ items: SidebarItem[]; nextCursor: string | null }>("workspace.items", {
          view, contextId: contextFromKey(ctx), ...(view === "home" ? { type } : {}), limit: size, cursor: section.nextCursor,
        });
        if (page.ok) refreshed[key] = { items: page.value.items, next: page.value.nextCursor };
      }));
      if (mine === latest.current) setMore((current) => ({ ...Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith(`${view}|`))), ...refreshed }));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, wanted, s.conversationVersion, s.projectsVersion, s.shelfKey, s.listsVersion, again]);

  const loadMore = useCallback(async (contextId: ContextId, type: string, cursor: string | null) => {
    if (cursor === null) return;
    const key = sectionKey(view, contextId, type);
    const page = await attempt<{ items: SidebarItem[]; nextCursor: string | null }>("workspace.items", {
      view, contextId, ...(view === "home" ? { type } : {}), limit: 20, cursor,
    });
    if (!page.ok) { s.setError(page.error.message); return; }
    setMore((current) => ({ ...current, [key]: { items: [...(current[key]?.items ?? []), ...page.value.items], next: page.value.nextCursor } }));
  }, [view, s]);

  return { data, status, more, loadMore, reload: () => setAgain((value) => value + 1) };
}

/** The items a section shows: its first page and the pages "更多" added, and where the next page starts. */
export function shownOf(section: SidebarSection, more: More | undefined): { items: SidebarItem[]; next: string | null } {
  if (!more) return { items: section.items, next: section.nextCursor };
  return { items: [...section.items, ...more.items], next: more.next };
}
