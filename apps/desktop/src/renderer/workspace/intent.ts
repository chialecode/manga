/**
 * How a thing was asked for (A-95): a click with Ctrl (⌘) opens it as a new tab behind the one in front; so does the middle button on anything that
 * opens something (it carries `data-opens`). The openers read this when they are called, so every place that opens a tab gets the rule without
 * knowing about it. A click that is not a Ctrl click clears it.
 */
const WINDOW_MS = 800;
let behindAt: number | null = null;

export function installIntent(target: Window = window): () => void {
  const onClick = (event: MouseEvent) => { behindAt = event.ctrlKey || event.metaKey ? Date.now() : null; };
  // The middle button does not click: it becomes a Ctrl click on what opens something, so the page's own click handler does the rest.
  const onAux = (event: MouseEvent) => {
    if (event.button !== 1 || !(event.target instanceof Element)) return;
    const hit = event.target.closest("[data-opens]");
    if (!hit) return;
    event.preventDefault();
    event.stopPropagation();
    hit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }));
  };
  // The browser's scroll-by-drag starts on a middle press; on a link or a card it would swallow the click.
  const onDown = (event: MouseEvent) => {
    if (event.button === 1 && event.target instanceof Element && event.target.closest("[data-opens]")) event.preventDefault();
  };
  target.addEventListener("click", onClick, true);
  target.addEventListener("auxclick", onAux, true);
  target.addEventListener("mousedown", onDown, true);
  return () => {
    target.removeEventListener("click", onClick, true);
    target.removeEventListener("auxclick", onAux, true);
    target.removeEventListener("mousedown", onDown, true);
  };
}

/** Whether the click that is being answered asked for a tab behind the one in front. */
export function behindIntent(now: number = Date.now()): boolean {
  return behindAt !== null && now - behindAt < WINDOW_MS;
}

/** For tests. */
export function resetIntent(): void {
  behindAt = null;
}
