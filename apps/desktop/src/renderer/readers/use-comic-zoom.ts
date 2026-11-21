import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export const ZOOM_STEP = 0.25;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
/** One wheel notch (100) with Ctrl held changes the size by about 15%; a pinch sends many small ones. */
const ZOOM_WHEEL_RATE = 0.0015;
/** The size set by the wheel is saved once it has rested this long, so a turn of the wheel is not a save per event. */
const ZOOM_SAVE_MS = 300;
/** Wheel events closer together than this belong to one gesture: it turns one page, however long it spins or glides. */
const WHEEL_GESTURE_GAP_MS = 220;

export const roundZoom = (value: number) => Math.round(value * 100) / 100;
const clampZoom = (value: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, roundZoom(value)));

/**
 * Comic zoom and wheel gesture controller:
 * - Ctrl+wheel zooms around the pointer and debounces saving the zoom setting.
 * - Explicit zoom actions (buttons / keyboard) immediately cancel any pending wheel save so it cannot overwrite them.
 * - Plain vertical wheel in paged modes scrolls oversized pages first and turns once per gesture at an edge.
 */
export function useComicZoom(options: {
  stage: RefObject<HTMLDivElement | null>;
  settingsZoom: number;
  strip: boolean;
  selecting: boolean;
  onZoom: (zoom: number) => void;
  onStep: (delta: 1 | -1) => void;
  onStripScrollTop: (top: number) => void;
}) {
  const [zoom, setZoomNow] = useState(options.settingsZoom);
  const pendingZoom = useRef<number | null>(null);
  const zoomTimer = useRef<number | null>(null);
  const zoomAnchor = useRef<{ fx: number; fy: number; px: number; py: number } | null>(null);
  const anchored = useRef(false);
  const wheel = useRef({ lastAt: 0, fired: false });

  const latest = useRef({
    zoom,
    settingsZoom: options.settingsZoom,
    strip: options.strip,
    selecting: options.selecting,
    onZoom: options.onZoom,
    onStep: options.onStep,
    onStripScrollTop: options.onStripScrollTop,
  });
  latest.current = {
    zoom,
    settingsZoom: options.settingsZoom,
    strip: options.strip,
    selecting: options.selecting,
    onZoom: options.onZoom,
    onStep: options.onStep,
    onStripScrollTop: options.onStripScrollTop,
  };

  useEffect(() => {
    if (pendingZoom.current === null) setZoomNow(options.settingsZoom);
  }, [options.settingsZoom]);

  const commitZoom = useCallback(() => {
    if (zoomTimer.current !== null) window.clearTimeout(zoomTimer.current);
    zoomTimer.current = null;
    const value = pendingZoom.current;
    pendingZoom.current = null;
    if (value !== null) latest.current.onZoom(value);
  }, []);
  useEffect(() => () => commitZoom(), [commitZoom]);

  const applyZoom = useCallback((next: number) => {
    const clamped = clampZoom(next);
    if (zoomTimer.current !== null) window.clearTimeout(zoomTimer.current);
    zoomTimer.current = null;
    const hadPending = pendingZoom.current !== null;
    pendingZoom.current = null;
    zoomAnchor.current = null;
    if (hadPending) setZoomNow(latest.current.settingsZoom);
    latest.current.onZoom(clamped);
  }, []);

  const wheelZoom = useCallback((value: number) => {
    setZoomNow(value);
    pendingZoom.current = value;
    if (zoomTimer.current !== null) window.clearTimeout(zoomTimer.current);
    zoomTimer.current = window.setTimeout(commitZoom, ZOOM_SAVE_MS);
  }, [commitZoom]);

  // After a size change from the wheel the page point under the pointer is put back under it.
  useLayoutEffect(() => {
    const at = zoomAnchor.current;
    const node = options.stage.current;
    if (!at || !node) return;
    zoomAnchor.current = null;
    anchored.current = latest.current.strip;
    node.scrollLeft = at.fx * node.scrollWidth - at.px;
    node.scrollTop = at.fy * node.scrollHeight - at.py;
    if (latest.current.strip) latest.current.onStripScrollTop(node.scrollTop);
  }, [zoom, options.stage]);

  // The next layout change is the person's own again.
  useEffect(() => { anchored.current = false; }, [zoom]);

  useEffect(() => {
    const node = options.stage.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      const current = latest.current;
      if (event.ctrlKey) {
        event.preventDefault();
        const next = clampZoom(current.zoom * Math.exp(-event.deltaY * ZOOM_WHEEL_RATE));
        if (next === current.zoom) return;
        const box = node.getBoundingClientRect();
        const px = event.clientX - box.left;
        const py = event.clientY - box.top;
        zoomAnchor.current = node.scrollWidth > 0 && node.scrollHeight > 0
          ? { fx: (node.scrollLeft + px) / node.scrollWidth, fy: (node.scrollTop + py) / node.scrollHeight, px, py }
          : null;
        wheelZoom(next);
        return;
      }
      if (current.strip || current.selecting || event.defaultPrevented) return;
      if (Math.abs(event.deltaY) < 1 || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const now = Date.now();
      const state = wheel.current;
      if (now - state.lastAt > WHEEL_GESTURE_GAP_MS) state.fired = false;
      state.lastAt = now;
      const down = event.deltaY > 0;
      const room = down ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : node.scrollTop > 0;
      // A gesture that began as a scroll stays one, so gliding to the edge does not turn the page by itself.
      if (room) { state.fired = true; return; }
      event.preventDefault();
      if (state.fired) return;
      state.fired = true;
      current.onStep(down ? 1 : -1);
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [options.stage, wheelZoom]);

  return { zoom, applyZoom, anchored };
}
