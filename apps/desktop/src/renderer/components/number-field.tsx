import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { isImeEvent } from "../lib/ime.ts";

export type NumberFieldProps = {
  value: number;
  onCommit: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  disabled?: boolean;
  id?: string;
  name?: string;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  testId?: string;
};

function clampNumber(raw: number, min?: number, max?: number, integer?: boolean): number {
  let next = integer ? Math.round(raw) : raw;
  if (min !== undefined && next < min) next = min;
  if (max !== undefined && next > max) next = max;
  return next;
}

/**
 * Draft-backed numeric input that validates and clamps on blur or Enter (outside IME composition),
 * and reverts to the last committed value on Escape or invalid/empty input.
 */
export function NumberField(props: NumberFieldProps) {
  const { value, onCommit, min, max, step, integer, disabled, id, name, className, placeholder, ariaLabel, ariaDescribedBy, testId } = props;
  const [draft, setDraft] = useState(() => String(value));
  const focusedRef = useRef(false);
  const composingRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(String(value));
  }, [value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setDraft(String(value));
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = clampNumber(parsed, min, max, integer);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeEvent(event, composingRef.current)) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDraft(String(value));
      event.currentTarget.blur();
    }
  };

  return (
    <input
      type="number"
      id={id}
      name={name}
      className={className}
      placeholder={placeholder}
      aria-label={ariaLabel}
      aria-describedby={ariaDescribedBy}
      data-testid={testId}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      value={draft}
      onFocus={() => { focusedRef.current = true; }}
      onBlur={() => {
        focusedRef.current = false;
        commit();
      }}
      onChange={(event) => setDraft(event.target.value)}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={() => { composingRef.current = false; }}
      onKeyDown={onKeyDown}
    />
  );
}
