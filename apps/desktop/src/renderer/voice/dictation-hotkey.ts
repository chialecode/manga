import type { DictationMode, DictationStopReason } from "@manga/contracts";
import { chordOf, recordingCodeToChord, type KeyTable } from "@manga/contracts/keys";

export const HOLD_MIN_MS = 250;
export const DOUBLE_TAP_MS = 350;

type DictationHotkeyPorts = {
  isEnabled: () => boolean;
  getKeyTable: () => KeyTable;
  getHoldKeySetting: () => string;
  now: () => number;
  getSessionMode: () => DictationMode | null;
  isWaitingComposition: () => boolean;
  onStartHold: () => void;
  onPromoteLocked: () => void;
  onStop: (reason: DictationStopReason) => void;
  onCancel: () => void;
  onAbortComposition: () => void;
};

type DictationHotkeyController = {
  onKeyDown: (event: KeyboardEvent) => void;
  onKeyUp: (event: KeyboardEvent) => void;
  onWindowBlur: () => void;
  resetTapWindow: () => void;
  clearHoldDown: () => void;
  dispose: () => void;
};

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

/**
 * Pure keyboard state machine for dictation: hold-to-talk, <350ms double-tap hands-free lock,
 * Escape cancel, AltGr/shortcut combo pass-through abort, solo RightAlt menu-bar suppression,
 * and window-blur release handling.
 */
export function createDictationHotkeyController(ports: DictationHotkeyPorts): DictationHotkeyController {
  let holdKeyDown = false;
  let holdAbortedByCombo = false;
  let suppressNextKeyup = false;
  let downAt = 0;
  let awaitingSecondTapUntil: number | null = null;
  let quickTapTimer: ReturnType<typeof setTimeout> | undefined;

  const resetTapWindow = (): void => {
    globalThis.clearTimeout(quickTapTimer);
    quickTapTimer = undefined;
    awaitingSecondTapUntil = null;
  };

  const clearHoldDown = (): void => {
    holdKeyDown = false;
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!ports.isEnabled()) return;
    const chords = effectiveChords(ports.getKeyTable(), ports.getHoldKeySetting());
    const sessionMode = ports.getSessionMode();
    const waiting = ports.isWaitingComposition();

    if (event.key === "Escape" && (sessionMode !== null || waiting)) {
      event.preventDefault();
      event.stopPropagation();
      ports.onCancel();
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
    if (holdKeyDown && !matches) {
      holdKeyDown = false;
      holdAbortedByCombo = true;
      ports.onCancel();
      return;
    }

    if (!matches) return;
    // Suppress browser/OS menu bar focus on standalone RightAlt.
    event.preventDefault();

    const now = ports.now();

    // Second tap within 350ms promotes the active session into hands-free locked mode.
    if (awaitingSecondTapUntil !== null && now <= awaitingSecondTapUntil && sessionMode !== null) {
      resetTapWindow();
      ports.onPromoteLocked();
      suppressNextKeyup = true;
      return;
    }

    // Pressing the dictation key while locked stops and transcribes.
    if (sessionMode === "locked") {
      suppressNextKeyup = true;
      ports.onStop("user");
      return;
    }

    if (sessionMode !== null || waiting) return;

    holdKeyDown = true;
    holdAbortedByCombo = false;
    downAt = now;
    ports.onStartHold();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (!ports.isEnabled()) return;
    const chords = effectiveChords(ports.getKeyTable(), ports.getHoldKeySetting());
    if (!isMatchingKeyup(event, chords)) return;

    if (holdAbortedByCombo) {
      holdAbortedByCombo = false;
      return;
    }

    event.preventDefault();

    if (suppressNextKeyup) {
      suppressNextKeyup = false;
      holdKeyDown = false;
      return;
    }

    if (!holdKeyDown) return;
    holdKeyDown = false;

    if (ports.isWaitingComposition()) {
      ports.onAbortComposition();
      return;
    }

    const now = ports.now();
    const heldMs = now - downAt;
    if (heldMs < HOLD_MIN_MS) {
      awaitingSecondTapUntil = now + DOUBLE_TAP_MS;
      globalThis.clearTimeout(quickTapTimer);
      quickTapTimer = globalThis.setTimeout(() => {
        awaitingSecondTapUntil = null;
        quickTapTimer = undefined;
        if (ports.getSessionMode() === "hold") {
          ports.onCancel();
        }
      }, DOUBLE_TAP_MS);
      return;
    }

    ports.onStop("user");
  };

  const onWindowBlur = (): void => {
    if (!holdKeyDown) return;
    holdKeyDown = false;
    const heldMs = ports.now() - downAt;
    if (heldMs >= HOLD_MIN_MS) ports.onStop("user");
    else ports.onCancel();
  };

  return {
    onKeyDown,
    onKeyUp,
    onWindowBlur,
    resetTapWindow,
    clearHoldDown,
    dispose: resetTapWindow,
  };
}
