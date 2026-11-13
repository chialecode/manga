import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { popupOpen } from "../components/popup.tsx";

export const AUTO_HIDE_MS = 2000;
export const EDGE_PX = 64;

/** True when a pointer at `y` is within `edge` of the top or the bottom of the box. */
export function inEdge(y: number, box: { top: number; bottom: number }, edge = EDGE_PX): boolean {
  return y - box.top <= edge || box.bottom - y <= edge;
}

function keyboardFocus(target: EventTarget): boolean {
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement && !["range", "checkbox", "radio", "button"].includes(target.type)) return true;
  try { return target instanceof Element ? target.matches(":focus-visible") : true; } catch { return true; }
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock", "ScrollLock"]);
const defaultWakeOnKey = (event: KeyboardEvent) => !MODIFIERS.has(event.key);

export type AutoHideOptions = {
  enabled: boolean;
  hold: boolean;
  delayMs?: number;
  wakeOnAnyPointerMove?: boolean;
  /** Keeps controls visible without arming a hide timer (e.g. a paused video) unless suppressed by a prior `quietHold`. */
  resting?: boolean;
  /** Suppresses controls during an active hold (e.g. video arrow hold/rewind) and keeps them away when resting right after. */
  quietHold?: boolean;
  /** Optional bar element inspected for `:hover` and active text inputs before hiding. */
  barRef?: RefObject<HTMLElement | null>;
  /** Filter for window `keydown` events that should wake controls (defaults to any non-modifier key). */
  shouldWakeOnKey?: (event: KeyboardEvent) => boolean;
  /** When false, `pointerenter` on an already-hidden bar does not wake it (video full screen wakes on pointermove instead). */
  wakeOnPointerEnter?: boolean;
};

/**
 * Reader controls that get out of the way while the user reads or watches (A-63): they hide a moment after the last sign of use and come back when the
 * pointer goes to the top or bottom edge of the reader (or moves anywhere across the window when `wakeOnAnyPointerMove` is set in full screen),
 * when a key is pressed, or when focus moves into them. Nothing hides while `hold` is set (a panel is open), while a popup is open, while the
 * pointer rests on the controls, or while focus is inside them. While hidden, pointer events and clicks are blocked so invisible controls cannot
 * be triggered accidentally; reaching one with Tab still brings them back.
 */
export function useAutoHide(
  root: RefObject<HTMLElement | null>,
  options: AutoHideOptions,
) {
  const {
    enabled,
    hold,
    wakeOnAnyPointerMove = false,
    resting = false,
    quietHold = false,
    barRef,
    shouldWakeOnKey,
    wakeOnPointerEnter = true,
  } = options;
  const delay = options.delayMs ?? AUTO_HIDE_MS;
  const [hidden, setHidden] = useState(false);
  const timer = useRef<number | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const holding = useRef(hold);
  holding.current = hold;
  const restingRef = useRef(resting);
  restingRef.current = resting;
  const quietHoldRef = useRef(quietHold);
  quietHoldRef.current = quietHold;
  const quietAfterHold = useRef(false);
  const over = useRef(false);
  const focusedEl = useRef<Element | null>(null);
  const hiddenRef = useRef(false);
  hiddenRef.current = enabled && hidden;
  const wakeKeyRef = useRef(shouldWakeOnKey ?? defaultWakeOnKey);
  wakeKeyRef.current = shouldWakeOnKey ?? defaultWakeOnKey;

  const disarm = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const isBarBusy = useCallback(() => {
    if (holding.current || over.current || popupOpen()) return true;
    const bar = barRef?.current;
    if (bar) {
      const active = document.activeElement;
      if (active instanceof HTMLInputElement && active.type !== "range" && bar.contains(active)) return true;
      try { if (bar.matches(":hover")) return true; } catch { /* ignore */ }
    }
    return false;
  }, [barRef]);

  const arm = useCallback(() => {
    disarm();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const hasFocus = focusedEl.current !== null && focusedEl.current.isConnected && document.activeElement === focusedEl.current;
      if (!hasFocus) focusedEl.current = null;
      if (holding.current || over.current) return;
      if (hasFocus || isBarBusy()) { arm(); return; }
      over.current = false;
      setHidden(true);
    }, delay);
  }, [delay, disarm, isBarBusy]);

  /** A sign of use: the controls show and the countdown starts again (unless resting). */
  const poke = useCallback(() => {
    quietAfterHold.current = false;
    setHidden(false);
    if (!restingRef.current) arm();
    else disarm();
  }, [arm, disarm]);

  useEffect(() => {
    if (!enabled) {
      disarm();
      quietAfterHold.current = false;
      over.current = false;
      focusedEl.current = null;
      setHidden(false);
      return;
    }
    if (quietHold) {
      quietAfterHold.current = true;
      if (!isBarBusy()) { disarm(); over.current = false; setHidden(true); }
      else arm();
      return disarm;
    }
    if (resting) {
      disarm();
      if (!quietAfterHold.current) setHidden(false);
      return disarm;
    }
    arm();
    return disarm;
  }, [enabled, resting, quietHold, arm, disarm, isBarBusy]);

  const prevHold = useRef(hold);
  useEffect(() => {
    if (prevHold.current === hold) return;
    prevHold.current = hold;
    if (enabled && !quietHoldRef.current) poke();
  }, [hold, enabled, poke]);

  useEffect(() => {
    const node = root.current;
    if (!enabled || !node) return;
    const key = (event: KeyboardEvent) => { if (wakeKeyRef.current(event)) poke(); };
    if (wakeOnAnyPointerMove) {
      const wake = () => poke();
      window.addEventListener("pointermove", wake, true);
      window.addEventListener("mousemove", wake, true);
      window.addEventListener("dragover", wake, true);
      window.addEventListener("keydown", key);
      return () => {
        window.removeEventListener("pointermove", wake, true);
        window.removeEventListener("mousemove", wake, true);
        window.removeEventListener("dragover", wake, true);
        window.removeEventListener("keydown", key);
      };
    }
    const move = (event: PointerEvent) => {
      if (inEdge(event.clientY, node.getBoundingClientRect())) poke();
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType === "touch" && inEdge(event.clientY, node.getBoundingClientRect())) poke();
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => { node.removeEventListener("pointermove", move); node.removeEventListener("pointerdown", down); window.removeEventListener("keydown", key); };
  }, [root, enabled, wakeOnAnyPointerMove, poke]);

  const isHidden = enabled && hidden;

  /** Props for each piece of the controls (the top bar, the bottom bar). */
  const bind = {
    onPointerEnter: () => {
      if (!wakeOnPointerEnter && hiddenRef.current) return;
      over.current = true;
      if (wakeOnPointerEnter) setHidden(false);
    },
    onPointerLeave: () => {
      over.current = false;
      if (enabledRef.current && !restingRef.current) arm();
    },
    onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => {
      if (!isHidden || !wakeOnAnyPointerMove) return;
      event.preventDefault();
      event.stopPropagation();
    },
    onClickCapture: (event: ReactMouseEvent<HTMLElement>) => {
      if (!isHidden || !wakeOnAnyPointerMove) return;
      event.preventDefault();
      event.stopPropagation();
    },
    // Only focus that came from the keyboard (or an editable field) holds the controls: a button left focused by a click does not keep them on screen.
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (!keyboardFocus(event.target)) { focusedEl.current = null; return; }
      focusedEl.current = event.target;
      setHidden(false);
      if (enabledRef.current && !restingRef.current) arm();
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      focusedEl.current = null;
      if (enabledRef.current && !restingRef.current) arm();
    },
  };
  return { hidden: isHidden, bind, wake: poke };
}
