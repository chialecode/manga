import { useCallback, useEffect, useRef, useState } from "react";
import {
  AGENT_STREAM_NOTICE_TOPIC,
  type AgentCitation,
  type AgentSearchStep,
  type AgentServerToolStep,
  type AgentStreamEvent,
  type AgentToolStep,
  type StreamAgent,
  type StreamItem,
} from "@manga/contracts";
import { attempt } from "../lib/api.ts";

export type { StreamAgent, StreamItem, StreamNote, StreamUser, StreamVoice } from "@manga/contracts";
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
  /** Optional title generated live by the backend for this session. */
  liveTitle?: string;
};

const PAGE = 200;
const RUNNING_POLL_MS = 600;
/** If a live IPC push arrived recently, skip redundant SQLite polling; resume polling if silent for this long. */
const LIVE_PUSH_FRESH_MS = 4000;
const NOTICE_MS = 250;
/** A message that is live (an answer being written, a recording being transcribed) is read again until it settles. */
const LIVE_TOPICS = new Set(["capture.changed", "capture.progress", "capture.draft", "work.updated"]);

function upsertServerStep(existing: AgentServerToolStep[] | undefined, stepEvent: AgentSearchStep): AgentServerToolStep[] {
  const list = [...(existing ?? [])];
  if (stepEvent.kind === "done") {
    const idx = list.findIndex((entry) => entry.id === stepEvent.callId);
    if (idx >= 0) {
      const current = list[idx]!;
      const nextPages = [
        ...(current.pages ?? []),
        ...(stepEvent.sources ?? []).map((src) => ({
          url: src.url,
          title: src.title,
          site: src.site,
          siteIcon: src.siteIcon,
          snippet: src.snippet ?? src.summary,
          publishedAt: src.publishedAt,
        })),
        ...(stepEvent.page ? [{
          url: stepEvent.page.url,
          title: stepEvent.page.title,
          site: stepEvent.page.site,
          siteIcon: stepEvent.page.siteIcon,
          snippet: stepEvent.page.snippet ?? stepEvent.page.summary,
          publishedAt: stepEvent.page.publishedAt,
          failed: stepEvent.failed,
        }] : []),
      ];
      list[idx] = {
        ...current,
        status: stepEvent.failed ? "error" : "done",
        ...(nextPages.length ? { pages: nextPages } : {}),
        ...(current.keywords?.length && stepEvent.found !== undefined
          ? { keywords: current.keywords.map((kw) => ({ ...kw, found: stepEvent.found })) }
          : {}),
      };
    }
    return list;
  }

  const kind: AgentServerToolStep["kind"] = stepEvent.kind === "open" ? "open_page" : stepEvent.kind;
  const idx = list.findIndex((entry) => entry.id === stepEvent.callId);
  const next: AgentServerToolStep = {
    id: stepEvent.callId,
    kind,
    status: stepEvent.status ?? "wip",
    ...("queries" in stepEvent ? { queries: stepEvent.queries } : {}),
    ...("sources" in stepEvent && stepEvent.sources
      ? {
        pages: stepEvent.sources.map((src) => ({
          url: src.url,
          title: src.title,
          site: src.site,
          siteIcon: src.siteIcon,
          snippet: src.snippet ?? src.summary,
          publishedAt: src.publishedAt,
        })),
      }
      : {}),
    ...("url" in stepEvent && stepEvent.kind !== "find_in_page"
      ? {
        pages: [{
          url: stepEvent.url,
          title: "title" in stepEvent ? stepEvent.title : undefined,
          siteIcon: "siteIcon" in stepEvent ? stepEvent.siteIcon : undefined,
          failed: "failed" in stepEvent ? stepEvent.failed : undefined,
        }],
      }
      : {}),
    ...(stepEvent.kind === "find_in_page"
      ? { keywords: [{ pattern: stepEvent.pattern, url: stepEvent.url, found: stepEvent.found }] }
      : {}),
  };
  if (idx >= 0) list[idx] = { ...list[idx]!, ...next };
  else list.push(next);
  return list;
}

function upsertToolStep(existing: AgentToolStep[] | undefined, step: AgentToolStep): AgentToolStep[] {
  const list = [...(existing ?? [])];
  const idx = list.findIndex((entry) => entry.id === step.id);
  if (idx >= 0) list[idx] = { ...list[idx]!, ...step };
  else list.push(step);
  return list;
}

/** Pure reducer applying a batch of live `AgentStreamEvent` items onto the current stream array while keeping untouched rows referentially stable. */
export function applyAgentStreamEvents(items: StreamItem[], events: readonly AgentStreamEvent[]): StreamItem[] {
  if (events.length === 0) return items;
  let next = items;
  const ensureMutable = () => {
    if (next === items) next = [...items];
  };

  for (const ev of events) {
    if (ev.kind === "title") continue;
    const idx = next.findIndex((row) => row.kind === "agent" && row.runId === ev.runId);
    const base: StreamAgent = idx >= 0
      ? (next[idx] as StreamAgent)
      : {
        kind: "agent",
        id: `run:${ev.runId}`,
        at: ev.kind === "start" ? ev.at : new Date().toISOString(),
        runId: ev.runId,
        status: "running",
        text: "",
        error: null,
      };

    let updated: StreamAgent = base;
    switch (ev.kind) {
      case "start":
        updated = {
          ...base,
          status: "running",
          ...(ev.modelId ? { modelId: ev.modelId } : {}),
          ...(ev.thinkingRaised !== undefined ? { thinkingRaised: ev.thinkingRaised } : {}),
        };
        break;
      case "reasoning-delta":
        updated = {
          ...base,
          status: base.status === "queued" ? "running" : base.status,
          reasoning: (base.reasoning ?? "") + ev.delta,
          reasoningStartedAt: ev.reasoningStartedAt ?? base.reasoningStartedAt ?? new Date().toISOString(),
          ...(ev.reasoningElapsedMs !== undefined ? { reasoningElapsedMs: ev.reasoningElapsedMs } : {}),
        };
        break;
      case "text-delta":
        updated = {
          ...base,
          status: base.status === "queued" ? "running" : base.status,
          text: base.text + ev.delta,
        };
        break;
      case "server-tool":
        updated = {
          ...base,
          search: [...(base.search ?? []), ev.event],
          serverToolSteps: ev.steps ?? upsertServerStep(base.serverToolSteps, ev.event),
        };
        break;
      case "tool-step":
        updated = {
          ...base,
          toolSteps: upsertToolStep(base.toolSteps, ev.step),
        };
        break;
      case "citations":
        updated = {
          ...base,
          citations: ev.citations as AgentCitation[],
        };
        break;
      case "done":
        updated = {
          ...base,
          status: ev.status,
          ...(ev.stopReason !== undefined ? { stopReason: ev.stopReason } : {}),
          ...(ev.canContinue !== undefined ? { canContinue: ev.canContinue } : {}),
          ...(ev.refusal !== undefined ? { refusal: ev.refusal } : {}),
          ...(ev.usage !== undefined ? { usage: ev.usage } : {}),
          ...(ev.citations !== undefined ? { citations: ev.citations } : {}),
          ...(ev.generatedTitle !== undefined ? { generatedTitle: ev.generatedTitle } : {}),
          ...(ev.reasoningElapsedMs !== undefined ? { reasoningElapsedMs: ev.reasoningElapsedMs } : {}),
          ...(ev.errorCode !== undefined ? { errorCode: ev.errorCode } : {}),
          ...(ev.error !== undefined ? { error: ev.error } : {}),
        };
        break;
    }

    ensureMutable();
    if (idx >= 0) next[idx] = updated;
    else next.push(updated);
  }

  return next;
}

function isAgentStreamEvent(value: unknown): value is AgentStreamEvent {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.kind === "string" && typeof record.sessionId === "string" && typeof record.runId === "string";
}

/**
 * The right pane's and the chat page's message list for one session (A-48): notes, voice and the Agent's turns, oldest first.
 * Subscribes to real-time `AgentStreamEvent` pushes (with rAF coalescing) to patch only the active `StreamAgent` row in place,
 * gracefully falling back to SQLite polling only when live push has not connected, and reconciling on `done`.
 */
export function useSessionStream(
  sessionId: string | undefined,
  options: { version: number; running: boolean; onTitle?: (title: string) => void },
): StreamState {
  const [items, setItems] = useState<StreamItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [session, setSession] = useState<StreamSession | null>(null);
  const [status, setStatus] = useState<StreamState["status"]>("idle");
  const [error, setError] = useState<string>();
  const [liveTitle, setLiveTitle] = useState<string | undefined>();
  const request = useRef(0);
  const current = useRef<string | undefined>(undefined);
  /** The oldest message loaded once an older page was read: a refresh reads from it to the newest and keeps those pages (LOOP-07). */
  const oldest = useRef<string | undefined>(undefined);
  const olderBusy = useRef(false);
  /** A refresh is on its way; one that an older page overtook is asked again so the change it carried is not missed. */
  const refreshing = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** Timestamp of the most recent live push for the active session, used to suppress redundant 600ms polling. */
  const lastLivePushAt = useRef(0);
  const pendingEvents = useRef<AgentStreamEvent[]>([]);
  const rafId = useRef<number | null>(null);
  const onTitleRef = useRef(options.onTitle);
  onTitleRef.current = options.onTitle;

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
  const versionRef = useRef(options.version);
  versionRef.current = options.version;
  const loadedFor = useRef<{ sessionId: string | undefined; version: number }>({ sessionId: undefined, version: options.version });

  useEffect(() => {
    current.current = sessionId;
    request.current += 1;
    oldest.current = undefined;
    olderBusy.current = false;
    lastLivePushAt.current = 0;
    pendingEvents.current = [];
    if (rafId.current !== null) {
      window.cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    setLoadingOlder(false);
    setLiveTitle(undefined);
    loadedFor.current = { sessionId, version: versionRef.current };
    if (!sessionId) { setItems([]); setHasMore(false); setSession(null); setStatus("idle"); return; }
    // The previous session's messages are not shown under the new one while it loads.
    setItems([]);
    setHasMore(false);
    setStatus("loading");
    void load();
  }, [sessionId, load]);

  useEffect(() => {
    if (!sessionId) return;
    if (loadedFor.current.sessionId === sessionId && loadedFor.current.version === options.version) return;
    loadedFor.current = { sessionId, version: options.version };
    void load();
  }, [options.version, sessionId, load]);

  // Real-time IPC push listener with rAF coalescing (dedicated `onAgentStream` or `agent.stream` notice topic).
  useEffect(() => {
    if (!sessionId) return;
    const flush = () => {
      rafId.current = null;
      const batch = pendingEvents.current.splice(0);
      if (batch.length === 0) return;
      let sawDone = false;
      for (const ev of batch) {
        if (ev.kind === "title" && ev.title) {
          setLiveTitle(ev.title);
          onTitleRef.current?.(ev.title);
        }
        if (ev.kind === "done") {
          sawDone = true;
          if (ev.generatedTitle) {
            setLiveTitle(ev.generatedTitle);
            onTitleRef.current?.(ev.generatedTitle);
          }
        }
      }
      setItems((prev) => applyAgentStreamEvents(prev, batch));
      if (sawDone) {
        // Reconcile against persisted SQLite stream once the run settles so DB IDs, proposals, and usage are authoritative.
        void loadRef.current();
      }
    };

    const enqueue = (event: AgentStreamEvent) => {
      if (event.sessionId !== sessionId) return;
      lastLivePushAt.current = performance.now();
      pendingEvents.current.push(event);
      if (event.kind === "done") {
        if (rafId.current !== null) {
          window.cancelAnimationFrame(rafId.current);
          rafId.current = null;
        }
        flush();
        return;
      }
      if (rafId.current === null) {
        rafId.current = window.requestAnimationFrame(flush);
      }
    };

    const offStream = window.manga?.onAgentStream?.(enqueue);
    let noticeTimer: number | undefined;
    const offNotice = window.manga?.onNotice?.((notice) => {
      if (notice.topic === AGENT_STREAM_NOTICE_TOPIC && isAgentStreamEvent(notice.payload)) {
        enqueue(notice.payload);
        return;
      }
      if (notice.topic === "proposal.changed") {
        if (!notice.payload.sessionId || notice.payload.sessionId === sessionId) void load();
        return;
      }
      if (!LIVE_TOPICS.has(notice.topic)) return;
      window.clearTimeout(noticeTimer);
      noticeTimer = window.setTimeout(() => { void load(); }, NOTICE_MS);
    });

    return () => {
      window.clearTimeout(noticeTimer);
      if (rafId.current !== null) {
        window.cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
      pendingEvents.current = [];
      offStream?.();
      offNotice?.();
    };
  }, [sessionId, load]);

  // Graceful polling fallback only when live push is unavailable or silent while a run is active.
  useEffect(() => {
    if (!sessionId || !options.running) return;
    const timer = window.setInterval(() => {
      if (lastLivePushAt.current > 0 && performance.now() - lastLivePushAt.current < LIVE_PUSH_FRESH_MS) return;
      void load();
    }, RUNNING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [sessionId, options.running, load]);

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

  return { items, hasMore, session, status, error, reload: load, loadOlder, loadingOlder, liveTitle };
}
