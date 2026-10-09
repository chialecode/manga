import { useEffect, useRef, useState } from "react";

/**
 * A position in a book (a page, a part) shown as text that turns into a field when it is clicked: Enter goes there, Esc or leaving the field
 * keeps the reader where it is. A number outside 1..max or one that is not a number keeps the field open and says so (aria-invalid).
 */
export function EditableNumber(props: {
  /** The text shown, such as "第 3 / 20 页". */
  display: string;
  /** The number a click starts the field with. */
  value: number;
  max: number;
  /** Reads "{current} / {total}" aloud and shows on hover. */
  label: string;
  inputLabel: string;
  testId: string;
  inputTestId: string;
  className?: string;
  disabled?: boolean;
  /** Called with the typed number, 1-based and whole. */
  onGo: (value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [invalid, setInvalid] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) { field.current?.focus(); field.current?.select(); } }, [editing]);

  const commit = () => {
    const value = Number(text.trim());
    if (!text.trim() || !Number.isFinite(value) || value < 1 || value > props.max) { setInvalid(true); return; }
    props.onGo(Math.floor(value));
    setEditing(false);
    setInvalid(false);
  };

  if (editing) {
    return (
      <span className={`editable-number editable-number-editing ${props.className ?? ""}`.trim()} data-testid={props.testId} data-editing="">
        <input
          ref={field}
          type="text"
          inputMode="numeric"
          className="editable-number-input"
          data-testid={props.inputTestId}
          aria-label={props.inputLabel}
          aria-invalid={invalid || undefined}
          value={text}
          size={String(props.max).length + 1}
          spellCheck={false}
          onChange={(event) => { setText(event.target.value); setInvalid(false); }}
          onKeyDown={(event) => {
            if (event.key === "Enter") { event.preventDefault(); commit(); }
            else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(false); }
          }}
          onBlur={() => setEditing(false)}
        />
        <span aria-hidden="true"> / {props.max}</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`editable-number ${props.className ?? ""}`.trim()}
      data-testid={props.testId}
      disabled={props.disabled}
      aria-live="polite"
      aria-label={props.label}
      title={props.label}
      onClick={() => { setText(String(props.value)); setInvalid(false); setEditing(true); }}
    >{props.display}</button>
  );
}
