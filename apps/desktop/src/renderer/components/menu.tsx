import { useEffect, useId, useRef, useState, type ReactNode } from "react";

export type MenuItem = { id: string; label: string; onSelect: () => void; disabled?: boolean; danger?: boolean; checked?: boolean };

/**
 * A small menu button: opens on click, moves with the arrow keys, closes with Escape or a click outside, and returns focus to
 * its button. It is a menu of commands, not a form control; choices that stay (sort, filter) use `checked` for the current one.
 */
export function Menu(props: {
  label: string;
  items: MenuItem[];
  trigger: ReactNode;
  testId?: string;
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (list.current?.contains(target) || button.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem'],[role='menuitemradio']")[index]?.focus();
  }, [open, index]);

  const enabled = props.items.map((item, position) => ({ item, position })).filter((entry) => !entry.item.disabled);

  function onKey(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      button.current?.focus();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const at = enabled.findIndex((entry) => entry.position === index);
    const next = event.key === "ArrowDown" ? enabled[(at + 1) % enabled.length]
      : event.key === "ArrowUp" ? enabled[(at - 1 + enabled.length) % enabled.length]
        : event.key === "Home" ? enabled[0] : enabled[enabled.length - 1];
    if (next) setIndex(next.position);
  }

  return (
    <span className={`menu-root ${props.className ?? ""}`}>
      <button
        ref={button}
        type="button"
        className="menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={props.label}
        title={props.label}
        data-testid={props.testId}
        onClick={(event) => { event.stopPropagation(); setIndex(enabled[0]?.position ?? 0); setOpen((current) => !current); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); event.stopPropagation(); setIndex(enabled[0]?.position ?? 0); setOpen(true); }
        }}
      >{props.trigger}</button>
      {open ? (
        <div ref={list} id={listId} role="menu" aria-label={props.label} className={`menu-list ${props.align === "end" ? "menu-end" : ""}`} onKeyDown={onKey}>
          {props.items.map((item, position) => (
            <button
              key={item.id}
              type="button"
              role={item.checked === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={item.checked}
              disabled={item.disabled}
              tabIndex={position === index ? 0 : -1}
              data-testid={props.testId ? `${props.testId}-${item.id}` : undefined}
              data-danger={item.danger ? "true" : undefined}
              onClick={(event) => { event.stopPropagation(); setOpen(false); button.current?.focus(); item.onSelect(); }}
            >{item.checked ? <span aria-hidden="true">✓ </span> : null}{item.label}</button>
          ))}
        </div>
      ) : null}
    </span>
  );
}
