/**
 * IME composition and text-entry target helpers shared across the renderer.
 * Keeping these checks consistent avoids swallowing or prematurely triggering shortcuts during CJK input.
 */

export type ImeEventLike = {
  isComposing?: boolean;
  key?: string;
  keyCode?: number;
  nativeEvent?: Event | { isComposing?: boolean; keyCode?: number };
};

/** Whether a keyboard or input event belongs to an active IME composition (including WebKit/Chromium keyCode 229 and W3C Process key). */
export function isImeEvent(event: ImeEventLike, composing = false): boolean {
  const native = event.nativeEvent as { isComposing?: boolean; keyCode?: number } | undefined;
  return Boolean(
    composing
    || event.isComposing
    || native?.isComposing
    || event.key === "Process"
    || event.keyCode === 229
    || native?.keyCode === 229,
  );
}

/** Whether `target` is an element where printable/navigation keys belong to text editing rather than global shortcuts. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
