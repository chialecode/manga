import { useCallback, useEffect, useRef, useState } from "react";
import type { SegmentAnchor } from "@manga/contracts/media";
import { asArray, attempt, messageOf } from "../lib/api.ts";

export type SessionSummary = {
  id: string;
  mode: string | null;
  retention: string;
  stage: string;
  audioState: string;
  playable: boolean;
  durationMs: number;
  createdAt: string;
  workId: string | null;
  resourceId: string | null;
  error: { code: string; message: string } | null;
  segments: { total: number; done: number; failed: number; pending: number; noSpeech: number };
  speechMs: number | null;
};

export type ReviewSegment = {
  id: string;
  seq: number;
  startMs: number;
  endMs: number;
  /** What to show: the user's revision when there is one. */
  text: string;
  originalText: string;
  revised: boolean;
  state: "pending" | "uploaded" | "done" | "failed" | "no_speech";
  precision: "chunk" | "segment" | "manual" | string;
  calibrated: boolean;
  anchors: SegmentAnchor[];
  attempts: number;
  error: { code: string; message: string } | null;
};

export type ReviewDraft = { id: string; sessionId: string; state: "organizing" | "ready" | "failed" | "accepted"; text: string; editedText: string | null; noteObjectId: string | null; error: { code: string; message: string } | null; createdAt: string };

export type Review = {
  session: SessionSummary;
  segments: ReviewSegment[];
  filtered: Array<{ startMs: number; endMs: number }>;
  drafts: ReviewDraft[];
  audio: { state: string; playable: boolean };
};

/** The recordings of one resource or one work, newest first; they refresh when a recording or its processing changes. */
export function useRecordings(scope: { resourceId?: string; workId?: string }, enabled = true) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error" | "off">("loading");
  const [error, setError] = useState("");
  const token = useRef(0);
  const key = `${scope.resourceId ?? ""}:${scope.workId ?? ""}`;
  const reload = useCallback(async () => {
    if (!enabled) { setStatus("off"); return; }
    const mine = ++token.current;
    const result = await attempt<{ sessions: SessionSummary[] }>("capture.list", { ...(scope.resourceId ? { resourceId: scope.resourceId } : {}), ...(scope.workId ? { workId: scope.workId } : {}), limit: 50 });
    if (mine !== token.current) return;
    if (!result.ok) {
      setStatus(result.error.code === "CAPABILITY_UNAVAILABLE" || result.error.code === "COMMAND_UNAVAILABLE" || result.error.code === "UNKNOWN_COMMAND" ? "off" : "error");
      setError(result.error.message);
      return;
    }
    setSessions(asArray<SessionSummary>(result.value.sessions));
    setStatus("ready");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const off = window.manga.onNotice?.((notice) => { if (notice.topic === "capture.changed") void reload(); });
    return () => off?.();
  }, [reload]);
  return { sessions, status, error, reload };
}

/** One recording's transcript, drafts and gaps, with the actions that change it. Every action reloads the review so the screen shows what is stored. */
export function useReview(sessionId: string) {
  const [review, setReview] = useState<Review | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const token = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++token.current;
    const result = await attempt<Review>("capture.review", { sessionId });
    if (mine !== token.current) return;
    if (!result.ok) { setStatus("error"); setError(result.error.message); return; }
    setReview({ ...result.value, segments: asArray(result.value.segments), filtered: asArray(result.value.filtered), drafts: asArray(result.value.drafts) });
    setStatus("ready");
  }, [sessionId]);
  useEffect(() => { setReview(null); setStatus("loading"); setError(""); void reload(); }, [reload]);
  useEffect(() => {
    const off = window.manga.onNotice?.((notice) => {
      if ((notice.topic === "capture.changed" || notice.topic === "capture.draft") && (notice.payload.sessionId === sessionId || !notice.payload.sessionId)) void reload();
    });
    return () => off?.();
  }, [sessionId, reload]);

  /** Run one action: show it as busy, report a failure in place, and reload either way. */
  const act = useCallback(async <T,>(name: string, commandId: string, input: Record<string, unknown>): Promise<{ ok: true; value: T } | { ok: false; message: string }> => {
    setBusy(name);
    setError("");
    try {
      const result = await attempt<T>(commandId, input);
      if (!result.ok) { setError(result.error.message); return { ok: false, message: result.error.message }; }
      return { ok: true, value: result.value };
    } catch (failure) {
      setError(messageOf(failure));
      return { ok: false, message: messageOf(failure) };
    } finally {
      setBusy(null);
      await reload();
    }
  }, [reload]);

  return { review, status, error, busy, reload, act };
}
