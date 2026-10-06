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
  /** Older messages, when the first page was cut. */
  loadOlder: () => Promise<void>;
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

  const load = useCallback(async () => {
    if (!sessionId) return;
    const mine = ++request.current;
    const result = await attempt<{ items: StreamItem[]; hasMore: boolean; session: StreamSession }>("session.stream", { sessionId, limit: PAGE });
    // An answer for a session the pane has already left is dropped.
    if (mine !== request.current || current.current !== sessionId) return;
    if (!result.ok) { setStatus("error"); setError(result.error.message); return; }
    setItems(Array.isArray(result.value.items) ? result.value.items : []);
    setHasMore(result.value.hasMore === true);
    setSession(result.value.session ?? null);
    setError(undefined);
    setStatus("ready");
  }, [sessionId]);

  useEffect(() => {
    current.current = sessionId;
    request.current += 1;
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
    if (!sessionId || !hasMore || items.length === 0) return;
    const before = items[0]!.at;
    const result = await attempt<{ items: StreamItem[]; hasMore: boolean }>("session.stream", { sessionId, limit: PAGE, before });
    if (current.current !== sessionId || !result.ok) return;
    setItems((existing) => {
      const known = new Set(existing.map((item) => item.id));
      return [...(Array.isArray(result.value.items) ? result.value.items : []).filter((item) => !known.has(item.id)), ...existing];
    });
    setHasMore(result.value.hasMore === true);
  }, [sessionId, hasMore, items]);

  return { items, hasMore, session, status, error, reload: load, loadOlder };
}
