import { hasInk } from "./screenshot-capture.ts";

/**
 * An ASS subtitle at the video's own size, for a screenshot (NOTE-05, A-92). JASSUB draws in a worker onto a canvas the page has handed over, but the
 * page can still read what the worker committed: the canvas is drawn from like any other once the browser has taken the worker's frame. The canvas
 * is as big as the picture on screen, so for the picture of the file the renderer is asked to draw again at the file's size, read, and put back.
 */
export type AssSurface = {
  /** The canvas the renderer draws on, over the picture. */
  _canvas: HTMLCanvasElement;
  /** Draws again at a size (the file's), or at the size of the picture on screen when none is given. */
  resize(forceRepaint?: boolean, renderWidth?: number, renderHeight?: number): Promise<void>;
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What a promise gives, or nothing once the time is up. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, wait(ms).then(() => undefined)]);
}

function copyOf(live: HTMLCanvasElement): HTMLCanvasElement | null {
  if (live.width <= 0 || live.height <= 0) return null;
  const copy = document.createElement("canvas");
  copy.width = live.width;
  copy.height = live.height;
  const context = copy.getContext("2d");
  if (!context) return null;
  try {
    context.drawImage(live, 0, 0);
  } catch {
    return null;
  }
  return copy;
}

/**
 * A copy of what the renderer has drawn for the frame on screen, at `size` when the renderer can do that in time, otherwise at the size it has now
 * (stretched over the picture when it is drawn into the screenshot). Null when there is nothing to read. The renderer is put back to the size of the
 * picture on screen afterwards, whatever happened.
 */
export async function snapshotAss(surface: AssSurface, size: { w: number; h: number }, options: { timeoutMs?: number; settleMs?: number } = {}): Promise<HTMLCanvasElement | null> {
  const timeoutMs = options.timeoutMs ?? 1500;
  const settleMs = options.settleMs ?? 40;
  const live = surface._canvas;
  // What is on screen now, taken before anything is asked of the renderer.
  const onScreen = copyOf(live);
  if (live.width >= size.w && live.height >= size.h) return onScreen;
  try {
    await within(surface.resize(true, size.w, size.h), timeoutMs);
    // The worker's frame reaches the page a moment after the worker is done: the canvas shows the new size when it has.
    const started = Date.now();
    while ((live.width !== size.w || live.height !== size.h) && Date.now() - started < timeoutMs) await wait(16);
    await wait(settleMs);
    const native = live.width === size.w && live.height === size.h ? copyOf(live) : null;
    if (native && (hasInk(native) || !onScreen || !hasInk(onScreen))) return native;
    return onScreen;
  } catch {
    return onScreen;
  } finally {
    void surface.resize(true).catch(() => undefined);
  }
}
