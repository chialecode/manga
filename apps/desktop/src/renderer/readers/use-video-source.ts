import { useCallback, useEffect, useRef, useState } from "react";
import { attempt } from "../lib/api.ts";
import { detectHardwareHevc, markHardwareHevcFailed } from "./video-support.ts";

export type CopySummary = {
  id: string;
  revisionId: string;
  reason: string;
  state: "queued" | "running" | "ready" | "failed";
  audioStreamIndex: number | null;
  progress: number;
  bytes: number | null;
  encoder: string | null;
  error: { code: string; message: string } | null;
  timestampCheck: { originalFrames: number; copyFrames: number; maxDriftMs: number; ok: boolean } | null;
  createdAt: string;
};

export type SourceState =
  | { phase: "loading" }
  | { phase: "ready"; url: string; via: "original" | "play_copy"; startMs: number; mediaType: string; copyId?: string }
  /** The file cannot play as it is on this machine; a copy would. `reason` says why, in the plan's own words. */
  | { phase: "needs_copy"; decision: string; reason: string; reasons: string[]; detail: string }
  | { phase: "building"; copy: CopySummary }
  | { phase: "failed"; message: string; code?: string; canForceCopy: boolean }
  | { phase: "unsupported"; detail: string }
  | { phase: "missing" };

type Plan = {
  available: boolean;
  plan: { decision: "direct" | "remux" | "play_copy" | "unsupported"; reasons: string[]; copy?: { reason: string }; detail: string };
  copy: CopySummary | null;
};

const POLL_MS = 1000;

/**
 * Chooses how a video plays and keeps that choice honest: the plan comes from the file and what this machine decodes,
 * a play copy is built only when the user asks, its progress is followed until it is ready, and a real decode failure
 * moves playback to the copy path instead of leaving a black picture.
 */
export function useVideoSource(target: { resourceId: string; revisionId: string } | null, audioStreamIndex: number | undefined) {
  const [state, setState] = useState<SourceState>({ phase: "loading" });
  const epoch = useRef(0);
  const decodeFailures = useRef(0);
  const key = target ? `${target.resourceId}:${target.revisionId}:${audioStreamIndex ?? ""}` : "";
  const targetRef = useRef(target);
  targetRef.current = target;
  const audioRef = useRef(audioStreamIndex);
  audioRef.current = audioStreamIndex;

  const openHandle = useCallback(async (mine: number, source: "original" | "play_copy", copyId?: string): Promise<boolean> => {
    const current = targetRef.current;
    if (!current) return false;
    const handle = await attempt<{ url: string; mediaType: string; startMs: number; copyId?: string }>("video.handle", { resourceId: current.resourceId, revisionId: current.revisionId, source, ...(copyId ? { copyId } : {}) });
    if (epoch.current !== mine) return true;
    if (!handle.ok) {
      setState(handle.error.code === "NOT_FOUND" ? { phase: "missing" } : { phase: "failed", message: handle.error.message, code: handle.error.code, canForceCopy: false });
      return true;
    }
    setState({ phase: "ready", url: handle.value.url, via: source, startMs: handle.value.startMs ?? 0, mediaType: handle.value.mediaType, ...(handle.value.copyId ? { copyId: handle.value.copyId } : {}) });
    return true;
  }, []);

  const resolve = useCallback(async () => {
    const current = targetRef.current;
    if (!current) return;
    const mine = ++epoch.current;
    setState({ phase: "loading" });
    const hardware = await detectHardwareHevc();
    if (epoch.current !== mine) return;
    const planned = await attempt<Plan>("video.playbackPlan", { resourceId: current.resourceId, revisionId: current.revisionId, hardwareHevc: hardware, ...(audioRef.current !== undefined ? { audioStreamIndex: audioRef.current } : {}) });
    if (epoch.current !== mine) return;
    if (!planned.ok) {
      setState({ phase: "failed", message: planned.error.message, code: planned.error.code, canForceCopy: false });
      return;
    }
    const { plan, copy, available } = planned.value;
    if (!available) { setState({ phase: "missing" }); return; }
    if (plan.decision === "unsupported") { setState({ phase: "unsupported", detail: plan.detail }); return; }
    if (plan.decision === "direct") { await openHandle(mine, "original"); return; }
    if (copy?.state === "ready") { await openHandle(mine, "play_copy", copy.id); return; }
    if (copy && (copy.state === "queued" || copy.state === "running")) { setState({ phase: "building", copy }); return; }
    setState({ phase: "needs_copy", decision: plan.decision, reason: plan.copy?.reason ?? plan.reasons[0] ?? "unsupported_video", reasons: plan.reasons, detail: plan.detail });
  }, [openHandle]);

  useEffect(() => {
    decodeFailures.current = 0;
    if (key) void resolve();
    return () => { epoch.current += 1; };
  }, [key, resolve]);

  /** The user asked for a copy. `force` makes one for a file that would play as it is (the troubleshooting path). */
  const createCopy = useCallback(async (force = false) => {
    const current = targetRef.current;
    if (!current) return;
    const mine = epoch.current;
    const hardware = await detectHardwareHevc();
    const reason = state.phase === "needs_copy" ? state.reason : "unsupported_video";
    const result = await attempt<{ copy: CopySummary }>("video.playCopy", {
      action: "create", resourceId: current.resourceId, revisionId: current.revisionId, hardwareHevc: hardware,
      ...(audioRef.current !== undefined ? { audioStreamIndex: audioRef.current } : {}),
      ...(force ? { reason } : {}),
    });
    if (epoch.current !== mine) return;
    if (!result.ok) {
      setState({ phase: "failed", message: result.error.message, code: result.error.code, canForceCopy: false });
      return;
    }
    setState(result.value.copy.state === "ready" ? { phase: "loading" } : { phase: "building", copy: result.value.copy });
    if (result.value.copy.state === "ready") await openHandle(mine, "play_copy", result.value.copy.id);
  }, [openHandle, state]);

  const cancelCopy = useCallback(async () => {
    const current = targetRef.current;
    if (!current) return;
    await attempt("video.playCopy", { action: "cancel", resourceId: current.resourceId, revisionId: current.revisionId });
    await resolve();
  }, [resolve]);

  const removeCopy = useCallback(async () => {
    const current = targetRef.current;
    if (!current) return;
    await attempt("video.playCopy", { action: "remove", resourceId: current.resourceId, revisionId: current.revisionId });
    await resolve();
  }, [resolve]);

  // ---- following a build ----
  const buildingId = state.phase === "building" ? state.copy.id : null;
  useEffect(() => {
    if (!buildingId) return;
    let stopped = false;
    const poll = async () => {
      const current = targetRef.current;
      if (!current || stopped) return;
      const mine = epoch.current;
      const status = await attempt<{ copies: CopySummary[] }>("video.playCopy", { action: "status", resourceId: current.resourceId, revisionId: current.revisionId });
      if (stopped || epoch.current !== mine || !status.ok) return;
      const copy = status.value.copies.find((item) => item.id === buildingId);
      if (!copy) { await resolve(); return; }
      if (copy.state === "ready") { await openHandle(mine, "play_copy", copy.id); return; }
      if (copy.state === "failed") { setState({ phase: "failed", message: copy.error?.message ?? "", code: copy.error?.code, canForceCopy: false }); return; }
      setState({ phase: "building", copy });
    };
    const timer = window.setInterval(() => void poll(), POLL_MS);
    const off = window.manga.onNotice?.((notice) => { if (notice.topic === "job.changed") void poll(); });
    return () => { stopped = true; window.clearInterval(timer); off?.(); };
  }, [buildingId, resolve, openHandle]);

  /** The media element reported an error. A decode failure on the original moves the file to the copy path. */
  const reportMediaError = useCallback((code: number | null, message: string) => {
    const current = state;
    if (current.phase !== "ready") return;
    decodeFailures.current += 1;
    if (current.via === "original" && decodeFailures.current === 1) {
      // The browser said it could decode this and then could not: stop trusting that and plan again.
      markHardwareHevcFailed();
      void resolve();
      return;
    }
    setState({ phase: "failed", message, code: code === null ? undefined : `MEDIA_ERR_${code}`, canForceCopy: current.via === "original" });
  }, [state, resolve]);

  return { state, resolve, createCopy, cancelCopy, removeCopy, reportMediaError };
}
