import { useCallback, useEffect, useRef, useState } from "react";
import { attempt } from "../lib/api.ts";
import type { StreamItem } from "../../../../../packages/app-core/src/ops/stream-types.ts";

export type { StreamAgent, StreamItem, StreamNote, StreamUser, StreamVoice } from "../../../../../packages/app-core/src/ops/stream-types.ts";
export type StreamSession = { id: string; kind: string; targetId: string | null; workId: string | null; resourceId: string | null };
export type StreamState = {
  items: StreamItem[];
  hasMore: boolean;
  session: StreamSession | null;
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  reload: () => Promise<void>;
  /** Older messages, when the first page was cut. One request at a time; resolves to whether anything was added. */
  loadOlder: () => Promise<boolean>;
  /** An older page is being read. */
  loadingOlder: boolean;
};

const PAGE = 200;
const RUNNING_POLL_MS = 600;
const NOTICE_MS = 250;
/** A message that is live (an answer being written, a recording being transcribed) is read again until it settles. */
const LIVE_TOPICS = new Set(["capture.changed", "capture.progress", "capture.draft", "work.updated"]);

/**
 * The right pane's and the chat page's message list for one session (A-48): notes, voice and the Agent's turns, oldest first. The
 * list is a view over what the application already stores; this hook only keeps it fresh. It reads again when the session changes,
 * after the host says something changed (`version`), while a task is running, and when a recording's notices arrive.
 */
export function useSessionStream(sessionId: string | undefined, options: { version: number; running: boolean }): StreamState {
  const [items, setItems] = useState<StreamItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [session, setSession] = useState<StreamSession | null>(null);
  const [status, setStatus] = useState<StreamState["status"]>("idle");
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const current = useRef<string | undefined>(undefined);
  /** The oldest message loaded once an older page was read: a refresh reads from it to the newest and keeps those pages (LOOP-07). */
  const oldest = useRef<string | undefined>(undefined);
  const olderBusy = useRef(false);
  /** A refresh is on its way; one that an older page overtook is asked again so the change it carried is not missed. */
  const refreshing = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const load = useCallback(async () => {
    if (!sessionId) return;
    const mine = ++request.current;
    refreshing.current = true;
    const from = oldest.current;
    const result = await attempt<{ items: StreamItem[]; hasMore: boolean; session: StreamSession }>("session.stream", from ? { sessionId, from } : { sessionId, limit: PAGE });
    if (mine === request.current) refreshing.current = false;
    // An answer for a session the pane has already left is dropped.
    if (mine !== request.current || current.current !== sessionId) return;
    if (!result.ok) { setStatus("error"); setError(result.error.message); return; }
    const next = Array.isArray(result.value.items) ? result.value.items : [];
    // Past the cap the newest are kept; the next refresh reads from the oldest of them.
    if (from) oldest.current = next[0]?.at;
    setItems(next);
    setHasMore(result.value.hasMore === true);
    setSession(result.value.session ?? null);
    setError(undefined);
    setStatus("ready");
  }, [sessionId]);

  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    current.current = sessionId;
    request.current += 1;
    oldest.current = undefined;
    olderBusy.current = false;
    setLoadingOlder(false);
    if (!sessionId) { setItems([]); setHasMore(false); setSession(null); setStatus("idle"); return; }
    // The previous session's messages are not shown under the new one while it loads.
    setItems([]);
    setHasMore(false);
    setStatus("loading");
    void load();
  }, [sessionId, load]);

  useEffect(() => { if (sessionId) void load(); }, [options.version, sessionId, load]);

  useEffect(() => {
    if (!sessionId || !options.running) return;
    const timer = window.setInterval(() => { void load(); }, RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [sessionId, options.running, load]);

  useEffect(() => {
    if (!sessionId) return;
    let timer: number | undefined;
    const off = window.manga.onNotice?.((notice) => {
      if (!LIVE_TOPICS.has(notice.topic)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => { void load(); }, NOTICE_MS);
    });
    return () => { window.clearTimeout(timer); off?.(); };
  }, [sessionId, load]);

  const loadOlder = useCallback(async () => {
    if (!sessionId || !hasMore || items.length === 0 || olderBusy.current) return false;
    olderBusy.current = true;
    setLoadingOlder(true);
    const before = items[0]!.at;
    try {
      const result = await attempt<{ items: StreamItem[]; hasMore: boolean }>("session.stream", { sessionId, limit: PAGE, before });
      if (current.current !== sessionId || !result.ok) return false;
      const page = Array.isArray(result.value.items) ? result.value.items : [];
      if (page.length) oldest.current = page[0]!.at;
      // A refresh that answered while this page was read must not drop it: the pages are kept from the oldest loaded.
      const overtaken = refreshing.current;
      request.current += 1;
      if (overtaken) { refreshing.current = false; queueMicrotask(() => { void loadRef.current(); }); }
      setItems((existing) => {
        const known = new Set(existing.map((item) => item.id));
        return [...page.filter((item) => !known.has(item.id)), ...existing];
      });
      setHasMore(result.value.hasMore === true);
      return page.length > 0;
    } finally {
      if (current.current === sessionId) { olderBusy.current = false; setLoadingOlder(false); }
    }
  }, [sessionId, hasMore, items]);

  return { items, hasMore, session, status, error, reload: load, loadOlder, loadingOlder };
}
