import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Translator } from "@manga/i18n";
import { attempt, call } from "../lib/api.ts";
import { captureBus } from "./capture-bus.ts";
import { openMicrophone } from "./mic.ts";
import { Recorder, type MicHandle, type RecorderState } from "./recorder.ts";

export type RecordingSettings = {
  /** `null` is the system default microphone. */
  deviceId: string | null;
  holdKey: string;
  toggleKey: string;
  retention: "keep" | "discard";
  duckPlayback: "none" | "lower" | "pause";
  boundaryMarginMs: number;
  overlay: { x?: number; y?: number; width: number; height: number };
};

export const DEFAULT_RECORDING_SETTINGS: RecordingSettings = {
  deviceId: null, holdKey: "F9", toggleKey: "F8", retention: "keep", duckPlayback: "lower", boundaryMarginMs: 300, overlay: { width: 280, height: 84 },
};

export type RecorderDeps = {
  i18n: Translator;
  setError: (message?: string) => void;
  setNotice: (message?: string) => void;
  /** The voice module is on; with it off there is nothing to record into. */
  enabled: boolean;
  /** Test seams: the real microphone and clock. */
  openMic?: (deviceId: string | null) => Promise<MicHandle>;
  now?: () => number;
};

const REPEAT_SILENCE_MS = 1500;
const HOLD_CHECK_MS = 500;
const OVERLAY_EVERY_MS = 200;

/**
 * Recording as the app uses it: one recorder, the saved recording settings, the in-app keys (hold and toggle), the
 * floating box state, and the notices for a recording that ended by itself. Hold mode never outlives its key: losing
 * the window or the key-up ends it, and says so.
 */
export function useRecorder(deps: RecorderDeps) {
  const { i18n, setError, setNotice, enabled } = deps;
  const recorder = useMemo(() => new Recorder({
    call: (commandId, input, options) => call(commandId, input, options) as Promise<never>,
    openMic: deps.openMic ?? openMicrophone,
    now: deps.now ?? (() => performance.now()),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  const state = useSyncExternalStore(recorder.subscribe, recorder.getState);
  const [settings, setSettings] = useState<RecordingSettings>(DEFAULT_RECORDING_SETTINGS);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const reloadSettings = useCallback(async () => {
    const result = await attempt<Partial<RecordingSettings>>("settings.getRecording");
    if (result.ok) setSettings({ ...DEFAULT_RECORDING_SETTINGS, ...result.value, overlay: { ...DEFAULT_RECORDING_SETTINGS.overlay, ...(result.value.overlay ?? {}) } });
  }, []);
  useEffect(() => { if (enabled) void reloadSettings(); }, [enabled, reloadSettings]);

  const saveSettings = useCallback(async (patch: Partial<RecordingSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    const result = await attempt("settings.setRecording", patch);
    if (!result.ok) { setError(result.error.message); await reloadSettings(); }
  }, [setError, reloadSettings]);

  const begin = useCallback(async (mode: "hold" | "toggle") => {
    if (!enabled || recorder.getState().phase !== "idle") return;
    const where = captureBus.latest();
    await recorder.start({
      mode,
      ...(where?.resourceId ? { resourceId: where.resourceId } : {}),
      ...(where?.resourceId && where.resourceRevisionId ? { resourceRevisionId: where.resourceRevisionId } : {}),
      ...(where?.resourceId && where.resourceRevisionId && where.locator ? { locator: where.locator } : {}),
      retention: settingsRef.current.retention,
      deviceId: settingsRef.current.deviceId,
    });
  }, [enabled, recorder]);

  const stop = useCallback((reason: "user" | "focus_lost" | "key_lost" = "user") => recorder.stop(reason), [recorder]);
  /** The end of a press on the hold button: only a recording that the press started is ended by it. */
  const endHold = useCallback(() => {
    const current = recorder.getState();
    if (current.mode === "hold" || current.phase === "starting") void recorder.stop("user");
  }, [recorder]);
  // Turning the voice module off ends a recording in progress (what was captured is saved) and says so.
  useEffect(() => {
    if (!enabled && recorder.getState().phase !== "idle") void recorder.stop("deactivated");
  }, [enabled, recorder]);
  const toggle = useCallback(() => {
    const phase = recorder.getState().phase;
    if (phase === "recording") void recorder.stop("user");
    else if (phase === "idle") void begin("toggle");
  }, [recorder, begin]);

  // The reader's position reaches the recording as it changes.
  useEffect(() => captureBus.subscribe((event) => recorder.event(event)), [recorder]);

  // ---- keys: hold to record, press to start or stop ----
  // Key repeat tells that the key is still down: once repeats have been seen and then stop, the key-up was lost.
  const lastRepeat = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const onDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.code === settingsRef.current.holdKey) {
        event.preventDefault();
        if (event.repeat) lastRepeat.current = Date.now();
        else if (recorder.getState().phase === "idle") { lastRepeat.current = 0; void begin("hold"); }
      } else if (event.code === settingsRef.current.toggleKey && !event.repeat) {
        event.preventDefault();
        toggle();
      }
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.code !== settingsRef.current.holdKey) return;
      const current = recorder.getState();
      if (current.mode === "hold" || current.phase === "starting") void recorder.stop("user");
    };
    const onBlur = () => {
      const current = recorder.getState();
      // A held recording only lasts while the key is down in this window; a toggled one carries on behind other windows.
      if (current.mode === "hold" && (current.phase === "recording" || current.phase === "starting")) void recorder.stop("focus_lost");
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    const onHidden = () => { if (document.visibilityState === "hidden") onBlur(); };
    document.addEventListener("visibilitychange", onHidden);
    // A key-up that never arrives must not leave the microphone open.
    const watchdog = window.setInterval(() => {
      const current = recorder.getState();
      if (current.mode !== "hold" || current.phase !== "recording") return;
      if (lastRepeat.current > 0 && Date.now() - lastRepeat.current > REPEAT_SILENCE_MS) void recorder.stop("key_lost");
      else if (typeof document.hasFocus === "function" && !document.hasFocus()) void recorder.stop("focus_lost");
    }, HOLD_CHECK_MS);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onHidden);
      window.clearInterval(watchdog);
    };
  }, [enabled, recorder, begin, toggle]);

  // ---- what the user should hear about ----
  const lastNoticed = useRef<string | null>(null);
  useEffect(() => {
    const stopped = state.lastStop;
    if (!stopped || lastNoticed.current === stopped.sessionId) return;
    lastNoticed.current = stopped.sessionId;
    if (stopped.reason === "user") return;
    const key = `record.stopped.${stopped.reason}` as "record.stopped.focus_lost";
    setNotice(i18n.t(key, { message: state.issue?.message ?? "" }));
  }, [state.lastStop, state.issue, i18n, setNotice]);
  const lastIssue = useRef<string | null>(null);
  useEffect(() => {
    if (!state.issue) { lastIssue.current = null; return; }
    const key = `${state.issue.code}:${state.issue.message}`;
    if (lastIssue.current === key) return;
    lastIssue.current = key;
    // An issue that came with a recording that ended is told by the stop notice; one that stopped a recording from starting is told here.
    if (state.issue.code !== "append_failed") setError(i18n.t(`record.issue.${state.issue.code}` as "record.issue.mic_denied", { message: state.issue.message }));
  }, [state.issue, i18n, setError]);

  // ---- the floating box mirrors this recording ----
  const overlaySent = useRef(0);
  useEffect(() => {
    const overlay = window.manga.overlay;
    if (!overlay) return;
    if (state.phase === "idle") { overlay.publish(null); overlaySent.current = 0; return; }
    const now = Date.now();
    if (state.phase === "recording" && now - overlaySent.current < OVERLAY_EVERY_MS) return;
    overlaySent.current = now;
    overlay.publish({
      phase: state.phase === "stopping" ? "stopping" : "recording",
      elapsedMs: state.elapsedMs,
      level: state.level,
      retention: state.retention ?? "keep",
      mode: state.mode ?? "toggle",
      label: state.deviceLabel ?? "",
      strings: {
        recording: i18n.t("record.recording"), stopping: i18n.t("record.stopping"), stop: i18n.t("record.stop"),
        keep: i18n.t("record.keep"), discard: i18n.t("record.discard"), hold: i18n.t("record.modeHold"), toggle: i18n.t("record.modeToggle"),
      },
    });
  }, [state.phase, state.elapsedMs, state.level, state.retention, state.mode, state.deviceLabel, i18n]);
  useEffect(() => window.manga.overlay?.onStop(() => { void recorder.stop("user"); }), [recorder]);

  // The window going away saves the audio.
  useEffect(() => () => { void recorder.dispose(); }, [recorder]);

  const duck = { active: state.phase === "recording" || state.phase === "starting", mode: settings.duckPlayback };
  return { state: state as RecorderState, settings, reloadSettings, saveSettings, begin, stop, endHold, toggle, duck, recorder };
}

export type RecorderHandle = ReturnType<typeof useRecorder>;
