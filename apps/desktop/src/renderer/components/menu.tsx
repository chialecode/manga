import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Popup } from "./popup.tsx";

export type MenuItem = { id: string; label: string; onSelect: () => void; disabled?: boolean; danger?: boolean; checked?: boolean; /** Replaces the `<menu id>-<item id>` test id, for ids that repeat from one group to the next. */ testId?: string };

/** A titled run of items. The arrow keys go on from the last item of one group to the first of the next. */
export type MenuGroup = { id: string; title: string; items: MenuItem[] };

/**
 * A small menu button: opens on click, moves with the arrow keys, closes with Escape or a click outside, and returns focus to
 * its button. It is a menu of commands, not a form control; choices that stay (sort, filter) use `checked` for the current one.
 * The list opens on the top layer beside its button (see `Popup`), so no scroll area or clip around the button can cut it off.
 */
export function Menu(props: {
  label: string;
  /** The items of a menu without groups. */
  items?: MenuItem[];
  /** The items in titled groups (instead of `items`): each group has its own choice, and the keys move through all of them as one list. */
  groups?: MenuGroup[];
  trigger: ReactNode;
  testId?: string;
  align?: "start" | "end";
  /** Which side of the button the list opens on; the player's bar, at the bottom of the window, opens its menus above. */
  placement?: "below" | "above";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const listId = useId();

  const away = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (open) list.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem'],[role='menuitemradio']")[index]?.focus();
  }, [open, index]);

  const sections: MenuGroup[] = props.groups ?? [{ id: "", title: "", items: props.items ?? [] }];
  const flat = sections.flatMap((group) => group.items);
  const enabled = flat.map((item, position) => ({ item, position })).filter((entry) => !entry.item.disabled);

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
        <Popup anchor={button} boxRef={list} onClose={away} id={listId} role="menu" label={props.label} className="menu-list" placement={props.placement ?? "below"} align={props.align === "end" ? "end" : "start"} onKeyDown={onKey}>
          {sections.map((group, groupAt) => {
            const before = sections.slice(0, groupAt).reduce((count, earlier) => count + earlier.items.length, 0);
            const entries = group.items.map((item, at) => {
              const position = before + at;
              return (
                <button
                  key={item.id}
                  type="button"
                  role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                  aria-checked={item.checked}
                  disabled={item.disabled}
                  tabIndex={position === index ? 0 : -1}
                  data-testid={item.testId ?? (props.testId ? `${props.testId}-${item.id}` : undefined)}
                  data-danger={item.danger ? "true" : undefined}
                  onClick={(event) => { event.stopPropagation(); setOpen(false); button.current?.focus(); item.onSelect(); }}
                >{item.checked ? <span aria-hidden="true">✓ </span> : null}{item.label}</button>
              );
            });
            if (!props.groups) return entries;
            const titleId = `${listId}-${group.id}`;
            return (
              <div key={group.id} className="menu-group" role="group" aria-labelledby={titleId} data-testid={props.testId ? `${props.testId}-group-${group.id}` : undefined}>
                <div id={titleId} className="menu-group-title">{group.title}</div>
                {entries}
              </div>
            );
          })}
        </Popup>
      ) : null}
    </span>
  );
}
