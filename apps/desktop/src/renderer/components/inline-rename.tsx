import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { isImeEvent } from "../lib/ime.ts";

export type InlineRenameProps = {
  initialValue: string;
  onCommit: (nextValue: string) => void | Promise<unknown>;
  onCancel: () => void;
  ariaLabel: string;
  testId?: string;
  formClassName?: string;
  inputClassName?: string;
  maxLength?: number;
  selectOnMount?: boolean;
};

/**
 * Inline rename form with IME-safe Escape cancellation, whitespace normalization on submit,
 * and a single-settlement guard so Enter/Escape does not double-fire on blur.
 */
export function InlineRename(props: InlineRenameProps) {
  const { initialValue, onCommit, onCancel, ariaLabel, testId, formClassName, inputClassName, maxLength = 200, selectOnMount = false } = props;
  const [draft, setDraft] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  const composingRef = useRef(false);
  const settledRef = useRef(false);

  useEffect(() => {
    if (selectOnMount) inputRef.current?.select();
  }, [selectOnMount]);

  const cancel = () => {
    if (settledRef.current) return;
    settledRef.current = true;
    onCancel();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (settledRef.current) return;
    settledRef.current = true;
    const normalized = draft.replace(/\s+/g, " ").trim();
    if (!normalized) {
      onCancel();
      return;
    }
    void onCommit(normalized);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeEvent(event, composingRef.current)) {
      if (event.key === "Enter") event.preventDefault();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };

  return (
    <form className={formClassName} onSubmit={submit}>
      <input
        ref={inputRef}
        autoFocus
        className={inputClassName}
        aria-label={ariaLabel}
        data-testid={testId}
        maxLength={maxLength}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        onBlur={cancel}
        onKeyDown={onKeyDown}
      />
    </form>
  );
}
