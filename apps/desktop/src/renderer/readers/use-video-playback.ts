import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { attempt } from "../lib/api.ts";
import {
  clampRate, closePlayed, drainPlayed, emptyPlayed, frameLanded, samplePlayed, seekTargetForFrame,
  type FrameAnswer, type PlayedState, type TimeRange,
} from "./video-model.ts";

/** What was watched since the last report. It names its video, so a report sent while the player is being replaced still lands on the right one. */
export type ProgressReport = { resourceId: string; revisionId: string; timeMs: number; ranges: TimeRange[]; ended: boolean };

export type FrameState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; frame: number; totalFrames: number; ptsMs: number; variableFrameRate: boolean }
  | { status: "unavailable"; message: string };

type Options = {
  element: HTMLVideoElement | null;
  target: { resourceId: string; revisionId: string };
  /** The address the element plays; null while no source is ready. */
  url: string | null;
  /** Where to start when the source first loads; later source swaps keep the position instead. */
  startMs: number;
  settings: { rate: number; holdRate: number; volume: number; muted: boolean };
  /** Scales the volume without touching the saved one: the player is made quieter while a recording runs. */
  volumeFactor?: number;
  /** The container's length, used until the element reports its own. */
  durationHintMs: number;
  /**
   * Where the file's own time starts on the element's clock. Some containers begin at a non-zero time and the element
   * keeps it; every time the player shows, saves or looks up counts from the start of the file, so it is taken off
   * what the element says and added back when the element is told where to go.
   */
  originMs?: number;
  onProgress: (report: ProgressReport) => void;
  onEnded: () => void;
  onMediaError: (code: number | null, message: string) => void;
};

const TICK_MS = 100;
const REPORT_EVERY_MS = 5000;
const NEAR_END_MS = 1500;

const asFrame = (answer: FrameAnswer & { variableFrameRate?: boolean }): FrameState => ({
  status: "ready", frame: answer.frame, totalFrames: answer.totalFrames, ptsMs: answer.ptsMs, variableFrameRate: answer.variableFrameRate === true,
});

/**
 * Everything the player does to a media element: following its time, seeking by time and by frame, rates (including the
 * temporary one while the right button is held), the watched stretches, and reporting them. The element stays the single
 * source of truth for time; this hook only reads it and writes the commands the user gives.
 */
export function useVideoPlayback(options: Options) {
  const { element, target, url } = options;
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(options.durationHintMs);
  const [bufferedMs, setBufferedMs] = useState(0);
  const [ready, setReady] = useState(false);
  const [ended, setEnded] = useState(false);
  const [holding, setHolding] = useState(false);
  const [frame, setFrame] = useState<FrameState>({ status: "idle" });
  const [presentedMs, setPresentedMs] = useState<number | null>(null);
  const [frameVerified, setFrameVerified] = useState<boolean | null>(null);

  const latest = useRef(options);
  latest.current = options;
  const played = useRef<PlayedState>(emptyPlayed());
  const resumeAt = useRef(options.startMs);
  const currentRef = useRef(0);
  const lastReport = useRef(0);
  const stopAt = useRef<number | null>(null);
  const baseRate = useRef(options.settings.rate);
  const frameChain = useRef<Promise<void>>(Promise.resolve());
  const presented = useRef<number | null>(null);
  const expected = useRef<number | null>(null);
  const frameEpoch = useRef(0);
  const metaSeen = useRef(false);

  const origin = () => latest.current.originMs ?? 0;
  const timeNow = useCallback((): number => (element ? Math.max(0, element.currentTime * 1000 - (latest.current.originMs ?? 0)) : 0), [element]);

  const flush = useCallback((ended = false) => {
    if (!element) return;
    const drained = drainPlayed(played.current);
    played.current = drained.state;
    lastReport.current = Date.now();
    latest.current.onProgress({ resourceId: latest.current.target.resourceId, revisionId: latest.current.target.revisionId, timeMs: Math.round(timeNow()), ranges: drained.ranges, ended });
  }, [element, timeNow]);

  const lookupFrame = useCallback(async (timeMs: number, delta = 0): Promise<(FrameAnswer & { variableFrameRate?: boolean }) | null> => {
    const result = await attempt<FrameAnswer & { variableFrameRate?: boolean }>("video.frameIndex", { resourceId: target.resourceId, revisionId: target.revisionId, timeMs, delta });
    if (!result.ok) {
      setFrame({ status: "unavailable", message: result.error.message });
      return null;
    }
    return result.value;
  }, [target.resourceId, target.revisionId]);

  /** Which frame the paused picture is. Called after a seek or a pause; a playing video has no single frame. */
  const refreshFrame = useCallback(async () => {
    if (!element || element.paused === false) return;
    // A jump to a frame has already named its frame; asking again from the old picture would name the wrong one.
    if (expected.current !== null) return;
    const mine = ++frameEpoch.current;
    setFrame((current) => (current.status === "ready" ? current : { status: "loading" }));
    const answer = await lookupFrame(presented.current ?? timeNow());
    if (answer && frameEpoch.current === mine) setFrame(asFrame(answer));
  }, [element, lookupFrame, timeNow]);

  // ---- a new source: load, resume, report ----
  // Runs in the same commit that gives the element its address, so it is done before the element can report anything about
  // that address. Run later, it could wipe a quick file's metadata that had already arrived, and the player would never be ready.
  useLayoutEffect(() => {
    if (!element) return;
    setReady(false);
    setEnded(false);
    setPlaying(false);
    setFrame({ status: "idle" });
    played.current = emptyPlayed();
    metaSeen.current = false;
    if (!url) return;
    resumeAt.current = currentRef.current > 0 ? currentRef.current : latest.current.startMs;
  }, [element, url]);

  // ---- the element's events ----
  useEffect(() => {
    if (!element) return;
    const sync = () => {
      const ms = Math.max(0, element.currentTime * 1000 - origin());
      currentRef.current = ms;
      setCurrentMs(ms);
      const end = element.buffered.length ? element.buffered.end(element.buffered.length - 1) * 1000 - origin() : 0;
      setBufferedMs(Math.max(0, end));
    };
    const onMeta = () => {
      metaSeen.current = true;
      const duration = Number.isFinite(element.duration) ? Math.max(0, element.duration * 1000 - origin()) : latest.current.durationHintMs;
      setDurationMs(duration);
      const at = resumeAt.current;
      if (at > 0 && at < duration - NEAR_END_MS) element.currentTime = (at + origin()) / 1000;
      element.playbackRate = latest.current.settings.rate;
      element.volume = Math.min(1, Math.max(0, latest.current.settings.volume * (latest.current.volumeFactor ?? 1)));
      element.muted = latest.current.settings.muted;
      setReady(true);
      sync();
      void refreshFrame();
    };
    const onDuration = () => { if (Number.isFinite(element.duration)) setDurationMs(Math.max(0, element.duration * 1000 - origin())); };
    const onTime = () => {
      sync();
      played.current = samplePlayed(played.current, timeNow(), { playing: !element.paused && !element.seeking, rate: element.playbackRate });
      const stop = stopAt.current;
      if (stop !== null && timeNow() >= stop) {
        stopAt.current = null;
        element.pause();
      }
    };
    const onPlay = () => { setPlaying(true); setEnded(false); setFrame({ status: "idle" }); };
    const onPause = () => {
      setPlaying(false);
      played.current = closePlayed(played.current);
      sync();
      flush();
      void refreshFrame();
    };
    // The picture on screen is the old one until the player presents the new one, so it is no longer a position to ask the index about.
    const onSeeking = () => { played.current = closePlayed(played.current); presented.current = null; };
    const onSeeked = () => {
      sync();
      flush();
      if (element.paused) void refreshFrame();
    };
    const onEnd = () => {
      setPlaying(false);
      setEnded(true);
      flush(true);
      latest.current.onEnded();
    };
    const onError = () => {
      const error = element.error;
      latest.current.onMediaError(error ? error.code : null, error?.message ?? "");
    };
    const events: Array<[string, () => void]> = [["loadedmetadata", onMeta], ["durationchange", onDuration], ["timeupdate", onTime], ["play", onPlay], ["pause", onPause], ["seeking", onSeeking], ["seeked", onSeeked], ["ended", onEnd], ["error", onError], ["progress", sync]];
    for (const [name, handler] of events) element.addEventListener(name, handler);
    // A file that is already known (cached, or quick to open) can report its metadata before these listeners exist; the event is not repeated.
    if (!metaSeen.current && element.readyState >= 1 && element.getAttribute("src")) onMeta();
    return () => { for (const [name, handler] of events) element.removeEventListener(name, handler); };
  }, [element, flush, refreshFrame]);

  // ---- a steady beat while playing: the clock, and a progress report every few seconds ----
  useEffect(() => {
    if (!element || !playing) return;
    const timer = window.setInterval(() => {
      currentRef.current = timeNow();
      setCurrentMs(currentRef.current);
      if (Date.now() - lastReport.current >= REPORT_EVERY_MS) flush();
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [element, playing, flush]);

  // ---- the picture the player really presented (also written to the element for tests and diagnostics) ----
  useEffect(() => {
    if (!element || typeof element.requestVideoFrameCallback !== "function") return;
    let handle = 0;
    let stopped = false;
    const onFrame = (_now: number, metadata: { mediaTime: number }) => {
      if (stopped) return;
      // The element's own clock goes on the attribute (diagnostics read it); everything else counts from the start of the file.
      const raw = metadata.mediaTime * 1000;
      const ms = Math.max(0, raw - origin());
      presented.current = ms;
      element.dataset.mediaTime = String(Math.round(raw * 1000) / 1000);
      if (expected.current !== null) {
        setFrameVerified(frameLanded(ms / 1000, expected.current, 1));
        setPresentedMs(ms);
        expected.current = null;
      }
      handle = element.requestVideoFrameCallback(onFrame);
    };
    handle = element.requestVideoFrameCallback(onFrame);
    return () => { stopped = true; element.cancelVideoFrameCallback?.(handle); };
  }, [element, url]);

  // ---- settings written to the element ----
  useEffect(() => {
    if (!element) return;
    element.volume = Math.min(1, Math.max(0, options.settings.volume * (options.volumeFactor ?? 1)));
    element.muted = options.settings.muted;
  }, [element, options.settings.volume, options.settings.muted, options.volumeFactor, url]);
  useEffect(() => {
    baseRate.current = options.settings.rate;
    if (element && !holding) element.playbackRate = clampRate(options.settings.rate);
  }, [element, options.settings.rate, holding, url]);

  // ---- leaving: the last position and the stretch being watched are not lost ----
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const elementRef = useRef(element);
  elementRef.current = element;
  useEffect(() => () => {
    const node = elementRef.current;
    if (!node) return;
    node.pause?.();
    flushRef.current();
  }, []);

  // ---- commands ----
  const play = useCallback(async () => {
    if (!element) return;
    try { await element.play(); } catch { /* an interrupted play (a seek or a source swap) is not an error */ }
  }, [element]);
  const pause = useCallback(() => { element?.pause(); }, [element]);
  const toggle = useCallback(() => {
    if (!element) return;
    if (element.paused) {
      // From the end, play starts again from the beginning.
      if (element.ended || (Number.isFinite(element.duration) && element.currentTime >= element.duration - 0.05)) element.currentTime = origin() / 1000;
      void play();
    } else element.pause();
  }, [element, play]);

  const seekTo = useCallback((ms: number) => {
    if (!element) return;
    const limit = Number.isFinite(element.duration) ? Math.max(0, element.duration * 1000 - origin()) : Number.POSITIVE_INFINITY;
    const at = Math.min(Math.max(0, ms), limit);
    stopAt.current = null;
    expected.current = null;
    element.currentTime = (at + origin()) / 1000;
    currentRef.current = at;
    setCurrentMs(at);
    setEnded(false);
  }, [element]);
  const seekBy = useCallback((deltaMs: number) => { if (element) seekTo(timeNow() + deltaMs); }, [element, seekTo, timeNow]);

  /** Play from `startMs` and stop at `endMs`, for reviewing a recorded interval. */
  const playRange = useCallback((startMs: number, endMs: number) => {
    seekTo(startMs);
    stopAt.current = endMs;
    void play();
  }, [seekTo, play]);

  /** Move to the frame `delta` away from the one on screen, or to a frame number from the index. */
  const stepFrame = useCallback((delta: number) => {
    frameChain.current = frameChain.current.then(async () => {
      if (!element) return;
      if (!element.paused) element.pause();
      const answer = await lookupFrame(presented.current ?? timeNow(), delta);
      if (!answer) return;
      const at = seekTargetForFrame(answer);
      expected.current = answer.ptsMs;
      element.currentTime = (at + origin()) / 1000;
      currentRef.current = at;
      setCurrentMs(at);
      setFrame(asFrame(answer));
    });
    return frameChain.current;
  }, [element, lookupFrame, timeNow]);

  const gotoFrame = useCallback((index: number) => {
    frameChain.current = frameChain.current.then(async () => {
      if (!element) return;
      if (!element.paused) element.pause();
      const result = await attempt<FrameAnswer & { variableFrameRate?: boolean }>("video.frameIndex", { resourceId: target.resourceId, revisionId: target.revisionId, frame: index });
      if (!result.ok) { setFrame({ status: "unavailable", message: result.error.message }); return; }
      const answer = result.value;
      const at = seekTargetForFrame(answer);
      expected.current = answer.ptsMs;
      element.currentTime = (at + origin()) / 1000;
      currentRef.current = at;
      setCurrentMs(at);
      setFrame(asFrame(answer));
    });
    return frameChain.current;
  }, [element, target.resourceId, target.revisionId]);

  /** The right button held: play at the temporary rate until it is released. */
  const holdStart = useCallback(() => {
    if (!element) return;
    setHolding(true);
    element.playbackRate = clampRate(latest.current.settings.holdRate);
    if (element.paused) void play();
  }, [element, play]);
  const holdEnd = useCallback(() => {
    setHolding(false);
    if (element) element.playbackRate = clampRate(baseRate.current);
  }, [element]);

  return {
    playing, currentMs, durationMs, bufferedMs, ready, ended, holding, frame, presentedMs, frameVerified,
    play, pause, toggle, seekTo, seekBy, playRange, stepFrame, gotoFrame, holdStart, holdEnd, flush, refreshFrame,
  };
}
