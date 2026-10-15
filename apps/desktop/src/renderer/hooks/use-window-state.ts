import { useEffect, useState } from "react";
import type { WindowControlsState } from "../lib/api.ts";

/**
 * Whether the page draws the window's buttons, and whether the window is maximized. The answer is `null` until the main process has said (and for good
 * where there is no host, as in a page opened by a test), and the buttons are then not drawn: a window must never show two sets.
 */
export function useWindowState(): WindowControlsState | null {
  const [state, setState] = useState<WindowControlsState | null>(null);
  useEffect(() => {
    const host = window.manga;
    if (typeof host?.windowState !== "function") return;
    let live = true;
    void host.windowState().then((next) => { if (live) setState(next); }).catch(() => undefined);
    const off = host.onWindowState?.((next) => { if (live) setState(next); });
    return () => { live = false; off?.(); };
  }, []);
  return state;
}
