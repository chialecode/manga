import { useEffect, useRef, useState, type ReactNode } from "react";
import { READER_PANEL_WIDTH } from "@manga/contracts/reading";

export type ReaderPanel = "toc" | "search" | "bookmarks";

/**
 * The reader's left panel (A-116): contents, search or bookmarks, one at a time, beside the text so the pages are laid out again to its right.
 * Its width is dragged at the right edge and saved when let go. In a narrow reader it floats over the text instead (the reader closes it on a
 * click on the text). Esc closes it and gives the focus back to the button that opened it.
 */
export function ReaderSidePanel(props: {
  panel: ReaderPanel;
  width: number;
  floating: boolean;
  label: string;
  resizeLabel: string;
  onWidth: (width: number) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(props.width);
  useEffect(() => setWidth(props.width), [props.width]);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const clamp = (value: number) => Math.round(Math.min(READER_PANEL_WIDTH.max, Math.max(READER_PANEL_WIDTH.min, value)));

  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onClose.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <aside
      className="reader-side"
      data-testid="reading-panel"
      data-panel={props.panel}
      data-placement={props.floating ? "float" : "left"}
      aria-label={props.label}
      style={{ width }}
    >
      <div className="reader-side-body">{props.children}</div>
      <div
        className="reader-side-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label={props.resizeLabel}
        aria-valuemin={READER_PANEL_WIDTH.min}
        aria-valuemax={READER_PANEL_WIDTH.max}
        aria-valuenow={width}
        tabIndex={0}
        data-testid="reading-panel-grip"
        onDragStart={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          drag.current = { x: event.clientX, width };
        }}
        onPointerMove={(event) => { if (drag.current) setWidth(clamp(drag.current.width + event.clientX - drag.current.x)); }}
        onPointerUp={(event) => {
          if (!drag.current) return;
          const next = clamp(drag.current.width + event.clientX - drag.current.x);
          drag.current = null;
          setWidth(next);
          if (next !== props.width) props.onWidth(next);
        }}
        onKeyDown={(event) => {
          const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
          if (!step) return;
          event.preventDefault();
          const next = clamp(width + step);
          setWidth(next);
          props.onWidth(next);
        }}
      />
    </aside>
  );
}
