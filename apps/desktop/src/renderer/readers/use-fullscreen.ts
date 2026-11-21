import { useCallback, useEffect, useState, type RefObject } from "react";
export { isTypingTarget } from "../lib/ime.ts";

/** Full screen for one element. The state follows the browser, so leaving with Esc updates the button too. */
export function useFullscreen(target: RefObject<HTMLElement | null>) {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement !== null && document.fullscreenElement === target.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, [target]);
  const toggle = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen?.()?.catch(() => undefined);
    else void target.current?.requestFullscreen?.()?.catch(() => setFullscreen(false));
  }, [target]);
  return { fullscreen, toggle };
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
