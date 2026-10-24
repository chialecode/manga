import { useEffect, useLayoutEffect, useRef, useState } from "react";

export type ContextItem = { id: string; label: string; onSelect: () => void; disabled?: boolean; danger?: boolean; separatorBefore?: boolean };

/**
 * A menu of commands at a point (a tab's, a project's or a conversation's right click). It opens on the top layer like the other menus, moves with the
 * arrow keys, closes with Esc or a press outside, and gives the focus back to where it was. It is not a form control: nothing in it stays chosen.
 */
export function ContextMenu(props: { x: number; y: number; label: string; items: ContextItem[]; onClose: () => void; testId?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState(0);
  const [place, setPlace] = useState({ left: props.x, top: props.y });
  const { onClose } = props;
  const previous = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  const enabled = props.items.map((item, position) => ({ item, position })).filter((entry) => !entry.item.disabled);

  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    try { if (typeof node.showPopover === "function" && !node.matches(":popover-open")) node.showPopover(); } catch { /* shown in place */ }
    // The menu stays inside the window: it opens leftward or upward when there is no room on the other side.
    const rect = node.getBoundingClientRect();
    const left = Math.max(4, Math.min(props.x, window.innerWidth - rect.width - 4));
    const top = Math.max(4, Math.min(props.y, window.innerHeight - rect.height - 4));
    setPlace({ left, top });
    return () => { try { if (typeof node.hidePopover === "function" && node.matches(":popover-open")) node.hidePopover(); } catch { /* already gone */ } };
  }, [props.x, props.y]);

  useEffect(() => {
    box.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']")[at]?.focus();
  }, [at]);

  useEffect(() => {
    const away = (event: Event) => {
      if (event.target instanceof Node && box.current?.contains(event.target)) return;
      onClose();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    const origin = previous.current;
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
      if (origin instanceof HTMLElement && origin.isConnected) origin.focus();
    };
  }, [onClose]);

  useEffect(() => { setAt(enabled[0]?.position ?? 0); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function onKey(event: React.KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key === "Tab") { event.preventDefault(); onClose(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || enabled.length === 0) return;
    event.preventDefault();
    const index = enabled.findIndex((entry) => entry.position === at);
    const next = event.key === "ArrowDown" ? enabled[(index + 1) % enabled.length]
      : event.key === "ArrowUp" ? enabled[(index - 1 + enabled.length) % enabled.length]
        : event.key === "Home" ? enabled[0] : enabled[enabled.length - 1];
    if (next) setAt(next.position);
  }

  return (
    <div ref={box} popover="manual" role="menu" aria-label={props.label} className="popup menu-list context-menu" data-testid={props.testId ?? "context-menu"} style={{ position: "fixed", margin: 0, left: place.left, top: place.top, right: "auto", bottom: "auto" }} onKeyDown={onKey} onContextMenu={(event) => event.preventDefault()}>
      {props.items.map((item, position) => (
        <div key={item.id} role="none">
          {item.separatorBefore ? <hr className="context-menu-separator" /> : null}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            tabIndex={position === at ? 0 : -1}
            data-testid={`${props.testId ?? "context-menu"}-${item.id}`}
            data-danger={item.danger ? "true" : undefined}
            onClick={(event) => { event.stopPropagation(); onClose(); item.onSelect(); }}
          >{item.label}</button>
        </div>
      ))}
    </div>
  );
}
