import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEventHandler, type ReactNode, type RefObject } from "react";

/** Whether a popup is open anywhere: a bar that would fade, or an Esc that would leave full screen, leaves it to the popup first. */
export function popupOpen(): boolean {
  return document.querySelector(".popup") !== null;
}

/**
 * A box that opens on the top layer (A-77): the browser's own `popover`, placed beside its anchor by CSS anchor positioning. It is drawn above every
 * scroll area, every clip and the full-screen element's own children, so nothing a parent does (`overflow`, `z-index`, a stacking context) can hide
 * or cut it. It is mounted only while open. A click outside it (the anchor aside) calls `onClose`; Esc is the caller's, because what Esc means
 * depends on what is inside.
 */
export function Popup(props: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Which side of the anchor it opens on; it turns over to the other side when there is no room. */
  placement?: "below" | "above";
  /** `start` lines its left edge up with the anchor's, `end` its right edge. */
  align?: "start" | "end";
  role?: string;
  label?: string;
  id?: string;
  className?: string;
  testId?: string;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  children: ReactNode;
  /** The box itself, for a caller that focuses inside it. */
  boxRef?: RefObject<HTMLDivElement | null>;
}) {
  const own = useRef<HTMLDivElement>(null);
  const box = props.boxRef ?? own;
  const name = `--popup-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const { anchor, onClose } = props;

  useLayoutEffect(() => {
    const node = box.current;
    const origin = anchor.current;
    if (!node) return;
    origin?.style.setProperty("anchor-name", name);
    node.style.setProperty("position-anchor", name);
    // A host without popover support (a test DOM) shows the box where it is; the guard also covers a box that is already open.
    try { if (typeof node.showPopover === "function" && !node.matches(":popover-open")) node.showPopover(); } catch { /* shown in place */ }
    return () => {
      origin?.style.removeProperty("anchor-name");
      try { if (typeof node.hidePopover === "function" && node.matches(":popover-open")) node.hidePopover(); } catch { /* already gone */ }
    };
  }, [anchor, box, name]);

  useEffect(() => {
    const away = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (box.current?.contains(target) || anchor.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [anchor, box, onClose]);

  return (
    <div
      ref={box}
      id={props.id}
      popover="manual"
      role={props.role}
      aria-label={props.label}
      className={`popup ${props.className ?? ""}`}
      data-testid={props.testId}
      data-placement={props.placement ?? "below"}
      data-align={props.align ?? "start"}
      onKeyDown={props.onKeyDown}
    >{props.children}</div>
  );
}
