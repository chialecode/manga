import { useCallback, useEffect, useRef, useState, type FocusEvent, type RefObject } from "react";

export const AUTO_HIDE_MS = 2000;
export const EDGE_PX = 64;

/** True when a pointer at `y` is within `edge` of the top or the bottom of the box. */
export function inEdge(y: number, box: { top: number; bottom: number }, edge = EDGE_PX): boolean {
  return y - box.top <= edge || box.bottom - y <= edge;
}

function keyboardFocus(target: EventTarget): boolean {
  try { return target instanceof Element ? target.matches(":focus-visible") : true; } catch { return true; }
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock", "ScrollLock"]);

/**
 * Reader controls that get out of the way while the user reads (A-63): they hide a moment after the last sign of use and come back when the
 * pointer goes to the top or bottom edge of the reader, when a key is pressed, or when focus moves into them. Nothing hides while `hold` is set
 * (a panel is open), while the pointer rests on the controls, or while focus is inside them, so a control that is being used never leaves.
 * The controls are only moved out of sight, never taken out of the tab order: reaching one with Tab brings them back.
 */
export function useAutoHide(root: RefObject<HTMLElement | null>, options: { enabled: boolean; hold: boolean; delayMs?: number }) {
  const { enabled, hold } = options;
  const delay = options.delayMs ?? AUTO_HIDE_MS;
  const [hidden, setHidden] = useState(false);
  const timer = useRef<number | null>(null);
  const holding = useRef(hold);
  const over = useRef(false);
  const focused = useRef(false);
  holding.current = hold;

  const disarm = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const arm = useCallback(() => {
    disarm();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (holding.current || over.current || focused.current) return;
      setHidden(true);
    }, delay);
  }, [delay, disarm]);
  /** A sign of use: the controls show and the countdown starts again. */
  const poke = useCallback(() => { setHidden(false); arm(); }, [arm]);

  useEffect(() => {
    if (!enabled) { disarm(); setHidden(false); return; }
    arm();
    return disarm;
  }, [enabled, arm, disarm]);
  useEffect(() => { if (enabled) poke(); }, [hold, enabled, poke]);

  useEffect(() => {
    const node = root.current;
    if (!enabled || !node) return;
    const move = (event: PointerEvent) => {
      if (inEdge(event.clientY, node.getBoundingClientRect())) poke();
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType === "touch" && inEdge(event.clientY, node.getBoundingClientRect())) poke();
    };
    const key = (event: KeyboardEvent) => { if (!MODIFIERS.has(event.key)) poke(); };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => { node.removeEventListener("pointermove", move); node.removeEventListener("pointerdown", down); window.removeEventListener("keydown", key); };
  }, [root, enabled, poke]);

  /** Props for each piece of the controls (the top bar, the bottom bar). */
  const bind = {
    onPointerEnter: () => { over.current = true; setHidden(false); },
    onPointerLeave: () => { over.current = false; arm(); },
    // Only focus that came from the keyboard holds the controls: a button left focused by a click does not keep them on screen.
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (!keyboardFocus(event.target)) return;
      focused.current = true;
      setHidden(false);
    },
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      focused.current = false;
      arm();
    },
  };
  return { hidden: enabled && hidden, bind };
}
