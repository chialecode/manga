import { createContext, useContext, useEffect, useRef } from "react";
import { chordOf } from "@manga/contracts/keys";
import { popupOpen } from "../components/popup.tsx";
import { isTypingTarget } from "./use-fullscreen.ts";

/**
 * Window full screen (A-78): the reader fills the application window, the side columns and the main top are out of the way, and the window's own
 * buttons stay. It is a state of the application, not of the element: it stands beside the browser's screen full screen, and either can be left
 * without the other.
 */
export type WindowFullscreen = { active: boolean; toggle: () => void; exit: () => void };

const idle: WindowFullscreen = { active: false, toggle: () => undefined, exit: () => undefined };
const Context = createContext<WindowFullscreen>(idle);
export const WindowFullscreenProvider = Context.Provider;
export const useWindowFullscreen = (): WindowFullscreen => useContext(Context);

/** How long after the browser left screen full screen an Esc is still taken to be the one that did it. */
export const ESC_AFTER_SCREEN_EXIT_MS = 400;

/** Whether something other than the reader owns this Esc: an open menu, popover or dialog closes first. */
function lowerLayerOpen(): boolean {
  const open = document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]');
  if (open || popupOpen()) return true;
  try {
    return document.querySelector(":popover-open") !== null;
  } catch {
    return false;
  }
}

/**
 * The keys of window full screen, at the application level so the three readers share them. The toggle key works only where a reader is in front
 * and the person is not typing. Esc leaves window full screen, but only after screen full screen, which the browser leaves with its own Esc:
 * that Esc must not also take the window out, so the ones that follow the leaving closely are ignored.
 */
export function useWindowFullscreenKeys(options: { enabled: boolean; active: boolean; toggleKeys: readonly string[]; toggle: () => void; exit: () => void }): void {
  const latest = useRef(options);
  latest.current = options;
  const screenLeftAt = useRef(0);

  useEffect(() => {
    const onChange = () => { if (!document.fullscreenElement) screenLeftAt.current = Date.now(); };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = latest.current;
      if (!current.enabled || event.defaultPrevented || isTypingTarget(event.target)) return;
      if (event.key === "Escape") {
        if (!current.active || Boolean(document.fullscreenElement) || lowerLayerOpen()) return;
        if (Date.now() - screenLeftAt.current < ESC_AFTER_SCREEN_EXIT_MS) return;
        event.preventDefault();
        event.stopPropagation();
        current.exit();
        return;
      }
      if (event.repeat || event.isComposing) return;
      const chord = chordOf(event);
      if (chord === null || !current.toggleKeys.includes(chord)) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      current.toggle();
    };
    // The capture phase: Esc is taken here before a reader's own Esc handling would clear a mark or a selection for it.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
