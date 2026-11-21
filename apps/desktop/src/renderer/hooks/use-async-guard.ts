import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CompositionEvent } from "react";
import { isImeEvent } from "../lib/ime.ts";

export type AsyncGuard = {
  /** Advance and return a fresh monotonic token for an async request. */
  next: () => number;
  /** True only when the component is still mounted and `token` is the latest issued token. */
  isCurrent: (token: number) => boolean;
  /** True while the component is mounted. */
  isAlive: () => boolean;
  /** Invalidate any in-flight tokens without unmounting. */
  invalidate: () => void;
};

/**
 * Guards async callbacks against stale responses and post-unmount state updates.
 * React 19 StrictMode safe: re-marks alive on effect mount and invalidates tokens on cleanup.
 */
export function useAsyncGuard(): AsyncGuard {
  const aliveRef = useRef(true);
  const seqRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      seqRef.current += 1;
    };
  }, []);

  return useMemo<AsyncGuard>(() => ({
    next: () => {
      seqRef.current += 1;
      return seqRef.current;
    },
    isCurrent: (token: number) => aliveRef.current && seqRef.current === token,
    isAlive: () => aliveRef.current,
    invalidate: () => {
      seqRef.current += 1;
    },
  }), []);
}

export type DebouncedSearch = {
  /** Current raw input value. */
  text: string;
  /** Latest debounced, trimmed, IME-safe query string. */
  query: string;
  /** Whether an IME composition session is currently active. */
  composing: boolean;
  /** Programmatically update the input text and schedule the debounced query update. */
  setText: (value: string) => void;
  /** Immediately set both `text` and `query` (trimmed), cancelling any pending debounce timer. */
  reset: (value?: string) => void;
  /** Props ready to spread onto an `<input>` element. */
  inputProps: {
    value: string;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
    onCompositionStart: () => void;
    onCompositionEnd: (event: CompositionEvent<HTMLInputElement>) => void;
  };
};

/**
 * IME-safe debounced search state.
 * Defers query emission during IME composition and commits the final composed DOM value on `compositionend`
 * (working around Chromium firing `change` before `compositionend`).
 */
export function useDebouncedSearch(initialValue = "", delayMs = 250): DebouncedSearch {
  const [text, setTextState] = useState(initialValue);
  const [query, setQuery] = useState(initialValue.trim());
  const [composing, setComposing] = useState(false);
  const composingRef = useRef(false);
  const timerRef = useRef<number | undefined>(undefined);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const schedule = useCallback((raw: string) => {
    clearTimer();
    const next = raw.trim();
    if (delayMs <= 0) {
      setQuery(next);
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      setQuery(next);
    }, delayMs);
  }, [clearTimer, delayMs]);

  const setText = useCallback((value: string) => {
    setTextState(value);
    if (!composingRef.current) schedule(value);
  }, [schedule]);

  const reset = useCallback((value = "") => {
    clearTimer();
    composingRef.current = false;
    setComposing(false);
    setTextState(value);
    setQuery(value.trim());
  }, [clearTimer]);

  const onChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value;
    setTextState(next);
    if (!composingRef.current && !isImeEvent(event)) schedule(next);
  }, [schedule]);

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
    setComposing(true);
    clearTimer();
  }, [clearTimer]);

  const onCompositionEnd = useCallback((event: CompositionEvent<HTMLInputElement>) => {
    composingRef.current = false;
    setComposing(false);
    const next = event.currentTarget.value;
    setTextState(next);
    schedule(next);
  }, [schedule]);

  const inputProps = useMemo(
    () => ({ value: text, onChange, onCompositionStart, onCompositionEnd }),
    [text, onChange, onCompositionStart, onCompositionEnd],
  );

  return { text, query, composing, setText, reset, inputProps };
}
