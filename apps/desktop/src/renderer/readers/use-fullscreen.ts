import { useEffect, useState, type RefObject } from "react";

/** Full screen for one element. The state follows the browser, so leaving with Esc updates the button too. */
export function useFullscreen(target: RefObject<HTMLElement | null>) {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === target.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [target]);
  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void target.current?.requestFullscreen?.()?.catch(() => setFullscreen(false));
  };
  return { fullscreen, toggle };
}

/** Keys typed into a field belong to the field, never to a reader shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}
