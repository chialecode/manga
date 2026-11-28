import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

function readFullscreenElement(): Element | null {
  return typeof document !== "undefined" ? (document.fullscreenElement ?? null) : null;
}

/** Tracks `document.fullscreenElement` so capture surfaces follow browser screen fullscreen (F) across all readers. */
export function useFullscreenElement(): Element | null {
  const [target, setTarget] = useState<Element | null>(readFullscreenElement);
  useEffect(() => {
    const sync = () => setTarget(readFullscreenElement());
    sync();
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);
  return target;
}

/**
 * Renders into `document.fullscreenElement` while browser screen fullscreen is active so EdgeHandle,
 * QuickNoteModal, and dictation feedback remain visible above any fullscreen reader; otherwise renders inline.
 */
export function FullscreenPortal(props: { children: ReactNode; container?: Element | null }) {
  const fullscreenEl = useFullscreenElement();
  const target = fullscreenEl ?? props.container ?? null;
  if (!target) return <>{props.children}</>;
  return createPortal(props.children, target);
}
