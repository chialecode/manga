import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AudioWarning,
  type DictationMode,
  type DictationReplacement,
  type DictationSessionSnapshot,
  type DictationStage,
  type DictationStopReason,
  type DictionarySuggestionItem,
} from "@manga/contracts";
import { chordOf, recordingCodeToChord, type KeyTable } from "@manga/contracts/keys";
import type { MessageKey, Translator } from "@manga/i18n";
import { attempt, call, CommandError, messageOf } from "../lib/api.ts";
import {
  captureEditableTarget,
  DEFAULT_EDIT_OBSERVE_MS,
  isImeComposing,
  waitForCompositionEnd,
  type EditableTargetHandle,
} from "./editable-target.ts";
import type { CapsuleAnchor, DictationUiStage } from "./dictation-capsule.tsx";
import type { PillState } from "./dictation-pill.tsx";
import { openMicrophone, type MicCaptureOptions } from "./mic.ts";
import type { MicHandle } from "./recorder.ts";
import type { RecordingSettings } from "./use-recorder.ts";

export const HOLD_MIN_MS = 250;
export const DOUBLE_TAP_MS = 350;
export const PILL_TTL_MS = 10_000;
export const MAX_DICTATION_MS = 300_000;

const SAMPLE_RATE = 16_000;

export type DictationDeps = {
  i18n: Translator;
  enabled: boolean;
  settings: RecordingSettings;
  keyTable: KeyTable;
  contextId?: string | null;
  workId?: string | null;
  recorderBusy?: boolean;
  setError: (message?: string) => void;
  setNotice: (message?: string, action?: { label: string; onClick: () => void }) => void;
  onOpenVoiceSettings?: () => void;
  openMic?: (deviceId: string | null, options?: MicCaptureOptions) => Promise<MicHandle>;
  now?: () => number;
  editObserveMs?: number;
};

export type DictationHandle = {
  active: boolean;
  stage: DictationUiStage;
  mode: DictationMode;
  elapsedMs: number;
  level: number;
  anchor: CapsuleAnchor;
  pill: PillState | null;
  toggleFromButton: (targetEl?: HTMLElement | null, workId?: string | null) => void;
  stop: (reason?: DictationStopReason) => Promise<void>;
  cancel: () => Promise<void>;
  revertLast: () => void;
  decideSuggestion: (suggestionId: string, action: "accept" | "ignore") => Promise<void>;
  dismissPill: () => void;
};

type SessionRuntime = {
  token: number;
  dictationId: string | null;
  mode: DictationMode;
  workId: string | null;
  target: EditableTargetHandle;
  mic: MicHandle | null;
  seq: number;
  samples: number;
  chain: Promise<void>;
  rawInserted: boolean;
  stopRequested: DictationStopReason | null;
  cancelled: boolean;
  completed: boolean;
};

function encodePcmBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function computePaneAnchor(el: HTMLElement | null): CapsuleAnchor {
  if (!el || typeof window === "undefined") return null;
  const pane = el.closest(".dock-pane, .shell-dock, .settings-pane, [role='dialog'], .shell-main") as HTMLElement | null;
  if (!pane) return null;
  const rect = pane.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0 || window.innerHeight <= 0) return null;
  return {
    centerX: rect.left + rect.width / 2,
    bottomPx: Math.max(16, window.innerHeight - rect.bottom + 16),
  };
}

function computePillAnchor(target: EditableTargetHandle | null): { left: number; bottom: number } | null {
  if (!target || typeof window === "undefined" || window.innerHeight <= 0) return null;
  const rect = target.getRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return {
    left: Math.max(16, rect.left),
    bottom: Math.max(16, window.innerHeight - rect.top + 8),
  };
}

function effectiveChords(keyTable: KeyTable, holdKeySetting: string): readonly string[] {
  const fromTable = keyTable["global.dictationHold"];
  if (fromTable && fromTable.length > 0) return fromTable;
  const mapped = recordingCodeToChord(holdKeySetting);
  return mapped ? [mapped] : ["RightAlt"];
}

function isMatchingKeyup(event: KeyboardEvent, chords: readonly string[]): boolean {
  if ((event.code === "AltRight" || (event.key === "Alt" && event.location === 2)) && chords.includes("RightAlt")) {
    return !event.ctrlKey && !event.shiftKey && !event.metaKey;
  }
  const chord = chordOf({
    key: event.key,
    code: event.code,
    location: event.location,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
  });
  return Boolean(chord && chords.includes(chord));
}

function fallbackKeyOf(reason: string | null | undefined): MessageKey | null {
  if (!reason) return null;
  const lower = reason.toLowerCase();
  if (lower.includes("timeout")) return "dictation.fallback.timeout";
  if (lower.includes("length")) return "dictation.fallback.length";
  if (lower.includes("entity") || lower.includes("proper") || lower.includes("term")) return "dictation.fallback.entity";
  if (lower.includes("unconfigured") || lower.includes("no_connection") || lower.includes("missing")) return "dictation.fallback.unconfigured";
  return "dictation.fallback.error";
}

type SnapshotLike = Omit<Partial<DictationSessionSnapshot>, "stage"> & {
  id?: string;
  stage?: DictationUiStage;
  suggestion?: DictionarySuggestionItem | null;
};

function asSnapshot(raw: Record<string, unknown> | null | undefined): SnapshotLike {
  if (!raw || typeof raw !== "object") return {};
  return raw as SnapshotLike;
}

export function useDictation(deps: DictationDeps): DictationHandle {
  const [active, setActive] = useState(false);
  const [stage, setStage] = useState<DictationUiStage>("starting");
  const [mode, setMode] = useState<DictationMode>("hold");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [anchor, setAnchor] = useState<CapsuleAnchor>(null);
  const [pill, setPill] = useState<PillState | null>(null);
  const pillRef = useRef<PillState | null>(null);
  pillRef.current = pill;

  const depsRef = useRef(deps);
  depsRef.current = deps;
  const nowFn = () => (depsRef.current.now ? depsRef.current.now() : Date.now());

  const sessionRef = useRef<SessionRuntime | null>(null);
  const lastTargetRef = useRef<EditableTargetHandle | null>(null);
  const pillTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tokenCounter = useRef(0);

  // Hold / double-tap / IME composition tracking refs
  const holdKeyDownRef = useRef(false);
  const holdAbortedByComboRef = useRef(false);
  const suppressNextKeyupRef = useRef(false);
  const downAtRef = useRef(0);
  const awaitingSecondTapUntilRef = useRef<number | null>(null);
  const quickTapTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const waitingCompositionRef = useRef(false);
  const abortCompositionRef = useRef<(() => void) | null>(null);

  const armPillTimer = useCallback((ms = PILL_TTL_MS) => {
    globalThis.clearTimeout(pillTimerRef.current);
    pillTimerRef.current = globalThis.setTimeout(() => {
      setPill(null);
    }, ms);
  }, []);

  const reportStartError = useCallback((error: unknown) => {
    const { i18n, setNotice, setError, onOpenVoiceSettings } = depsRef.current;
    const t = i18n.t;
    const code = error instanceof CommandError ? error.code : "";
    const detailReason = error instanceof CommandError && error.details && typeof error.details === "object" && "reason" in error.details
      ? String((error.details as { reason?: unknown }).reason ?? "")
      : "";
    const msg = messageOf(error);
    const lower = `${code} ${detailReason} ${msg}`.toLowerCase();
    const action = onOpenVoiceSettings ? { label: t("dictation.gotoSettings"), onClick: onOpenVoiceSettings } : undefined;
    if (lower.includes("not_installed") || lower.includes("not downloaded") || lower.includes("model_missing") || lower.includes("model not found")) {
      setNotice(t("dictation.notice.modelMissing"), action);
      return;
    }
    if (code === "MODEL_UNCONFIGURED" || code === "CAPABILITY_UNAVAILABLE" || lower.includes("no engine") || lower.includes("unconfigured")) {
      setNotice(t("dictation.notice.engineMissing"), action);
      return;
    }
    setError(msg);
  }, []);

  const teardownSession = useCallback((runtime: SessionRuntime | null) => {
    if (!runtime) return;
    runtime.mic?.stop();
    runtime.mic = null;
    if (sessionRef.current?.token === runtime.token) {
      sessionRef.current = null;
      setActive(false);
      setLevel(0);
    }
  }, []);

  const applySnapshot = useCallback((runtime: SessionRuntime, snap: SnapshotLike) => {
    if (runtime.cancelled || runtime.completed) return;
    const { i18n, settings, setNotice } = depsRef.current;
    const t = i18n.t;

    if (snap.stage && snap.stage !== "done" && snap.stage !== "no_speech" && snap.stage !== "cancelled" && snap.stage !== "failed") {
      setStage(snap.loadingModel ? "loading_model" : snap.stage);
    } else if (snap.loadingModel && !snap.stage) {
      setStage("loading_model");
    }

    // Stream-replace mode: insert raw text as soon as ASR finishes, even while LLM polish is still running.
    if (
      settings.dictationInsertMode === "stream_replace"
      && !runtime.rawInserted
      && typeof snap.rawText === "string"
      && snap.rawText.trim().length > 0
      && snap.stage !== "done"
    ) {
      if (runtime.target.insert(snap.rawText)) {
        runtime.rawInserted = true;
      }
    }

    if (snap.stage === "no_speech") {
      runtime.completed = true;
      runtime.target.dispose();
      teardownSession(runtime);
      setNotice(t("dictation.notice.noSpeech"));
      return;
    }

    if (snap.stage === "cancelled") {
      runtime.completed = true;
      runtime.target.dispose();
      teardownSession(runtime);
      return;
    }

    if (snap.stage === "failed") {
      runtime.completed = true;
      runtime.target.dispose();
      teardownSession(runtime);
      reportStartError(new Error(snap.errorMessage || t("dictation.stage.failed")));
      return;
    }

    if (snap.stage === "done") {
      runtime.completed = true;
      teardownSession(runtime);

      const candidateText = snap.finalText || snap.correctedText || snap.rawText || "";
      const finalText = candidateText.trim() ? candidateText : "";
      const rawText = snap.rawText ?? finalText;

      if (!finalText.trim()) {
        runtime.target.dispose();
        setNotice(t("dictation.notice.noSpeech"));
        return;
      }

      let insertedOk = false;
      if (runtime.rawInserted) {
        insertedOk = finalText !== rawText ? runtime.target.replace(finalText) : runtime.target.isAlive();
      } else if (settings.dictationInsertMode === "stream_replace" && rawText && rawText !== finalText) {
        // Insert rawText then replace with finalText so Ctrl+Z always steps final -> raw -> before.
        if (runtime.target.insert(rawText)) {
          runtime.rawInserted = true;
          insertedOk = runtime.target.replace(finalText);
        }
      } else {
        insertedOk = runtime.target.insert(finalText);
      }

      if (!insertedOk) {
        runtime.target.dispose();
        setNotice(t("dictation.notice.targetGone", { text: finalText }), {
          label: t("dictation.copy"),
          onClick: () => {
            void navigator.clipboard?.writeText?.(finalText);
            setNotice(t("dictation.notice.copied"));
          },
        });
        return;
      }

      // Surface audio warnings or polish fallback notice
      const warnings = Array.isArray(snap.warnings) ? (snap.warnings as AudioWarning[]) : [];
      if (snap.fallbackReason) {
        const key = fallbackKeyOf(snap.fallbackReason);
        if (key) setNotice(t(key));
      } else if (warnings.includes("clipping")) {
        setNotice(t("dictation.warning.clipping"));
      } else if (warnings.includes("low_volume")) {
        setNotice(t("dictation.warning.low_volume"));
      }

      lastTargetRef.current?.dispose();
      lastTargetRef.current = runtime.target;

      const replacements: DictationReplacement[] = Array.isArray(snap.replacements) ? snap.replacements : [];
      const changed = finalText !== rawText;
      const polished = Boolean(changed && settings.polishMode !== "raw" && !snap.fallbackReason);
      const pillAnchor = computePillAnchor(runtime.target);
      const initialSuggestion = snap.suggestion ?? null;

      if (changed || replacements.length > 0 || initialSuggestion) {
        setPill({
          id: runtime.dictationId ?? String(runtime.token),
          polished,
          canRevert: changed,
          rawText,
          finalText,
          replacements,
          suggestion: initialSuggestion,
          anchorRect: pillAnchor,
        });
        armPillTimer();
      }

      // Observe user edits for 60s (or until blur) to suggest learned dictionary terms
      const observeMs = depsRef.current.editObserveMs ?? DEFAULT_EDIT_OBSERVE_MS;
      const workId = runtime.workId;
      runtime.target.startEditObservation(({ insertedText, editedText }) => {
        void (async () => {
          const observed = await attempt<{ suggestion?: DictionarySuggestionItem | null } & Partial<DictionarySuggestionItem>>(
            "dictionary.observeEdit",
            { ...(workId ? { workId } : {}), insertedText, editedText },
          );
          if (!observed.ok) return;
          const candidate = observed.value.suggestion
            ?? (observed.value.id && observed.value.term && observed.value.heard ? (observed.value as DictionarySuggestionItem) : null);
          if (!candidate || candidate.status !== "pending") return;
          setPill((current) => ({
            id: current?.id ?? candidate.id,
            polished: current?.polished ?? false,
            canRevert: current?.canRevert ?? false,
            rawText: current?.rawText ?? rawText,
            finalText: current?.finalText ?? finalText,
            replacements: current?.replacements ?? [],
            suggestion: candidate,
            anchorRect: current?.anchorRect ?? computePillAnchor(runtime.target),
          }));
          armPillTimer();
        })();
      }, observeMs);
    }
  }, [armPillTimer, reportStartError, teardownSession]);

  const stop = useCallback(async (reason: DictationStopReason = "user") => {
    globalThis.clearTimeout(quickTapTimerRef.current);
    awaitingSecondTapUntilRef.current = null;
    const runtime = sessionRef.current;
    if (!runtime || runtime.cancelled || runtime.completed) return;

    if (!runtime.dictationId) {
      runtime.stopRequested = reason;
      return;
    }

    runtime.mic?.stop();
    runtime.mic = null;
    setLevel(0);
    setStage("recognizing");

    const dictationId = runtime.dictationId;
    try {
      await runtime.chain.catch(() => undefined);
      const result = await call<Record<string, unknown>>("dictation.stop", { dictationId, reason });
      const snap = asSnapshot(result);
      if (snap.stage) applySnapshot(runtime, snap);
    } catch (error) {
      runtime.completed = true;
      runtime.target.dispose();
      teardownSession(runtime);
      reportStartError(error);
    }
  }, [applySnapshot, reportStartError, teardownSession]);

  const cancel = useCallback(async () => {
    globalThis.clearTimeout(quickTapTimerRef.current);
    awaitingSecondTapUntilRef.current = null;
    holdKeyDownRef.current = false;

    if (waitingCompositionRef.current) {
      abortCompositionRef.current?.();
      return;
    }

    const runtime = sessionRef.current;
    if (!runtime) return;
    runtime.cancelled = true;
    runtime.target.dispose();
    const dictationId = runtime.dictationId;
    teardownSession(runtime);
    if (dictationId) {
      void attempt("dictation.cancel", { dictationId });
    } else {
      void attempt("dictation.cancel", {});
    }
  }, [teardownSession]);

  const beginSession = useCallback(async (initialMode: DictationMode, preferredTarget: HTMLElement | null, explicitWorkId: string | null) => {
    const currentDeps = depsRef.current;
    if (!currentDeps.enabled || currentDeps.recorderBusy) return;
    if (sessionRef.current || waitingCompositionRef.current) return;

    // Wait for active IME composition to commit before reading selection or starting audio capture.
    if (isImeComposing(preferredTarget)) {
      waitingCompositionRef.current = true;
      let aborted = false;
      const abortListeners = new Set<() => void>();
      abortCompositionRef.current = () => {
        aborted = true;
        for (const fn of [...abortListeners]) fn();
      };
      const ready = await waitForCompositionEnd({
        get aborted() { return aborted; },
        onAbort: (cb) => {
          abortListeners.add(cb);
          return () => abortListeners.delete(cb);
        },
      });
      waitingCompositionRef.current = false;
      abortCompositionRef.current = null;
      if (!ready || aborted) return;
    }

    if (preferredTarget && document.activeElement !== preferredTarget) {
      preferredTarget.focus();
    }
    const target = captureEditableTarget(preferredTarget);
    if (!target) {
      holdKeyDownRef.current = false;
      currentDeps.setNotice(currentDeps.i18n.t("dictation.notice.noTarget"));
      return;
    }

    const token = ++tokenCounter.current;
    const workId = explicitWorkId ?? currentDeps.workId ?? null;
    const runtime: SessionRuntime = {
      token,
      dictationId: null,
      mode: initialMode,
      workId,
      target,
      mic: null,
      seq: 0,
      samples: 0,
      chain: Promise.resolve(),
      rawInserted: false,
      stopRequested: null,
      cancelled: false,
      completed: false,
    };

    sessionRef.current = runtime;
    setPill(null);
    setActive(true);
    setMode(initialMode);
    setStage("starting");
    setElapsedMs(0);
    setLevel(0);
    setAnchor(computePaneAnchor(target.element));

    const openMic = currentDeps.openMic ?? openMicrophone;
    let mic: MicHandle;
    try {
      mic = await openMic(currentDeps.settings.deviceId, {
        echoCancellation: currentDeps.settings.echoCancellation,
        systemLoopbackAec: currentDeps.settings.systemLoopbackAec,
        browserNoiseSuppression: currentDeps.settings.browserNoiseSuppression,
        autoGainControl: currentDeps.settings.autoGainControl,
        onSystemAecFallback: () => depsRef.current.setNotice(depsRef.current.i18n.t("dictation.notice.systemAecFallback")),
      });
    } catch (error) {
      target.dispose();
      teardownSession(runtime);
      reportStartError(error);
      return;
    }

    if (runtime.cancelled) {
      mic.stop();
      target.dispose();
      teardownSession(runtime);
      return;
    }

    runtime.mic = mic;

    let started: Record<string, unknown>;
    try {
      started = await call<Record<string, unknown>>("dictation.start", {
        mode: runtime.mode,
        ...(workId ? { workId } : {}),
        ...(currentDeps.contextId !== undefined ? { contextId: currentDeps.contextId } : {}),
        sampleRate: SAMPLE_RATE,
      });
    } catch (error) {
      mic.stop();
      target.dispose();
      teardownSession(runtime);
      reportStartError(error);
      return;
    }

    const dictationId = String(started.dictationId ?? started.id ?? "");
    if (!dictationId || runtime.cancelled) {
      mic.stop();
      target.dispose();
      teardownSession(runtime);
      if (dictationId && runtime.cancelled) void attempt("dictation.cancel", { dictationId });
      return;
    }

    runtime.dictationId = dictationId;
    const rawStage = started.stage as DictationUiStage | undefined;
    const isLoadingModel = started.loadingModel === true || rawStage === "loading_model";
    setStage(isLoadingModel ? "loading_model" : "recording");

    mic.onChunk((pcm, peak) => {
      if (runtime.cancelled || runtime.completed || sessionRef.current?.token !== runtime.token) return;
      const seq = runtime.seq++;
      runtime.samples += pcm.length;
      const nextElapsed = Math.round((runtime.samples * 1000) / SAMPLE_RATE);
      setElapsedMs(nextElapsed);
      setLevel(Math.max(0, Math.min(1, peak)));
      setStage((current) => (current === "starting" ? "recording" : current));

      const data = encodePcmBase64(pcm);
      runtime.chain = runtime.chain.then(async () => {
        if (runtime.cancelled || runtime.completed) return;
        await call("dictation.append", { dictationId, seq, data }, { key: `dic:${dictationId}:a${seq}` });
      });

      if (nextElapsed >= MAX_DICTATION_MS && !runtime.stopRequested) {
        runtime.stopRequested = "max_duration";
        void stop("max_duration");
      }
    });

    mic.onEnded(() => {
      if (!runtime.cancelled && !runtime.completed) {
        void stop("device_lost");
      }
    });

    if (runtime.stopRequested) {
      void stop(runtime.stopRequested);
    }
  }, [reportStartError, stop, teardownSession]);

  const toggleFromButton = useCallback((targetEl?: HTMLElement | null, explicitWorkId?: string | null) => {
    if (sessionRef.current) {
      void stop("user");
      return;
    }
    void beginSession("locked", targetEl ?? null, explicitWorkId ?? null);
  }, [beginSession, stop]);

  const revertLast = useCallback(() => {
    const current = pillRef.current;
    if (!current || !current.canRevert) return;
    const handle = lastTargetRef.current;
    if (handle && handle.replace(current.rawText)) {
      depsRef.current.setNotice(depsRef.current.i18n.t("dictation.pill.reverted"));
    }
    if (current.replacements.length === 0 && !current.suggestion) {
      setPill(null);
    } else {
      setPill({ ...current, canRevert: false, polished: false });
    }
  }, []);

  const decideSuggestion = useCallback(async (suggestionId: string, action: "accept" | "ignore") => {
    await attempt("dictionary.suggestions.decide", { suggestionId, action });
    setPill((current) => {
      if (!current || current.suggestion?.id !== suggestionId) return current;
      const next = { ...current, suggestion: null };
      if (!next.canRevert && next.replacements.length === 0) return null;
      return next;
    });
  }, []);

  const dismissPill = useCallback(() => {
    globalThis.clearTimeout(pillTimerRef.current);
    setPill(null);
  }, []);

  // Subscribe to main-process dictation state transitions (`dictation.changed`).
  useEffect(() => {
    const off = window.manga?.onNotice?.((notice) => {
      if (notice.topic !== "dictation.changed") return;
      const runtime = sessionRef.current;
      if (!runtime) return;
      const snap = asSnapshot(notice.payload);
      const id = snap.dictationId ?? snap.id;
      if (id && runtime.dictationId && id !== runtime.dictationId) return;
      if (id && !runtime.dictationId) runtime.dictationId = id;
      applySnapshot(runtime, snap);
    });
    return () => { off?.(); };
  }, [applySnapshot]);

  // Global keyboard listener for hold-to-talk, <350ms double-tap lock, Esc cancel, and solo RightAlt menu suppression.
  useEffect(() => {
    if (!deps.enabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const currentDeps = depsRef.current;
      if (!currentDeps.enabled) return;
      const chords = effectiveChords(currentDeps.keyTable, currentDeps.settings.dictationHoldKey);

      if (event.key === "Escape" && (sessionRef.current || waitingCompositionRef.current)) {
        event.preventDefault();
        event.stopPropagation();
        void cancel();
        return;
      }

      const chord = chordOf({
        key: event.key,
        code: event.code,
        location: event.location,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
      });
      const matches = Boolean(chord && chords.includes(chord));

      if (event.repeat) {
        if (matches) event.preventDefault();
        return;
      }

      // Pressing any other key while RightAlt (or hold key) is held aborts dictation so shortcuts/AltGr combos pass through untouched.
      if (holdKeyDownRef.current && !matches) {
        holdKeyDownRef.current = false;
        holdAbortedByComboRef.current = true;
        void cancel();
        return;
      }

      if (!matches) return;
      // Suppress browser/OS menu bar focus on standalone RightAlt.
      event.preventDefault();

      const now = nowFn();

      // Second tap within 350ms promotes the active session into hands-free locked mode.
      if (awaitingSecondTapUntilRef.current !== null && now <= awaitingSecondTapUntilRef.current && sessionRef.current) {
        globalThis.clearTimeout(quickTapTimerRef.current);
        awaitingSecondTapUntilRef.current = null;
        sessionRef.current.mode = "locked";
        setMode("locked");
        suppressNextKeyupRef.current = true;
        return;
      }

      // Pressing the dictation key while locked stops and transcribes.
      if (sessionRef.current && sessionRef.current.mode === "locked") {
        suppressNextKeyupRef.current = true;
        void stop("user");
        return;
      }

      if (sessionRef.current || waitingCompositionRef.current) return;

      holdKeyDownRef.current = true;
      holdAbortedByComboRef.current = false;
      downAtRef.current = now;
      void beginSession("hold", null, currentDeps.workId ?? null);
    };

    const onKeyUp = (event: KeyboardEvent) => {
      const currentDeps = depsRef.current;
      if (!currentDeps.enabled) return;
      const chords = effectiveChords(currentDeps.keyTable, currentDeps.settings.dictationHoldKey);
      if (!isMatchingKeyup(event, chords)) return;

      if (holdAbortedByComboRef.current) {
        holdAbortedByComboRef.current = false;
        return;
      }

      event.preventDefault();

      if (suppressNextKeyupRef.current) {
        suppressNextKeyupRef.current = false;
        holdKeyDownRef.current = false;
        return;
      }

      if (!holdKeyDownRef.current) return;
      holdKeyDownRef.current = false;

      if (waitingCompositionRef.current) {
        abortCompositionRef.current?.();
        return;
      }

      const now = nowFn();
      const heldMs = now - downAtRef.current;
      if (heldMs < HOLD_MIN_MS) {
        awaitingSecondTapUntilRef.current = now + DOUBLE_TAP_MS;
        globalThis.clearTimeout(quickTapTimerRef.current);
        quickTapTimerRef.current = globalThis.setTimeout(() => {
          awaitingSecondTapUntilRef.current = null;
          if (sessionRef.current && sessionRef.current.mode === "hold") {
            void cancel();
          }
        }, DOUBLE_TAP_MS);
        return;
      }

      void stop("user");
    };

    const onWindowBlur = () => {
      if (holdKeyDownRef.current) {
        holdKeyDownRef.current = false;
        const heldMs = nowFn() - downAtRef.current;
        if (heldMs >= HOLD_MIN_MS) void stop("user");
        else void cancel();
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [beginSession, cancel, deps.enabled, stop]);

  // Clean up if voice module is disabled or component unmounts.
  useEffect(() => {
    if (!deps.enabled && sessionRef.current) {
      void cancel();
    }
  }, [cancel, deps.enabled]);

  useEffect(() => () => {
    globalThis.clearTimeout(quickTapTimerRef.current);
    globalThis.clearTimeout(pillTimerRef.current);
    lastTargetRef.current?.dispose();
    const runtime = sessionRef.current;
    if (runtime) {
      runtime.cancelled = true;
      runtime.mic?.stop();
      runtime.target.dispose();
    }
  }, []);

  return {
    active,
    stage,
    mode,
    elapsedMs,
    level,
    anchor,
    pill,
    toggleFromButton,
    stop,
    cancel,
    revertLast,
    decideSuggestion,
    dismissPill,
  };
}
