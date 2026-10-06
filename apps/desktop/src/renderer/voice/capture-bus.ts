import type { PositionInput } from "./recorder.ts";

/**
 * Where the reader is, announced by whichever reader is open and heard by the recorder. Readers do not know about
 * recording: they say "the page is now this" or "the video was seeked here". The latest position is kept so a recording
 * that starts later begins with the place the reader is at, and a recording hears every change after that.
 */
type Listener = (event: PositionInput) => void;

export type LatestPosition = Pick<PositionInput, "resourceId" | "resourceRevisionId" | "locator" | "playing" | "playbackRate">;

const listeners = new Set<Listener>();
let latest: LatestPosition | null = null;

export const captureBus = {
  emit(event: PositionInput): void {
    // A resource change names a new place; anything else refines the place already known.
    if (event.reason === "resource_change" || event.reason === "episode_change" || event.reason === "start") {
      latest = { resourceId: event.resourceId, resourceRevisionId: event.resourceRevisionId, locator: event.locator, playing: event.playing, playbackRate: event.playbackRate };
    } else if (latest) {
      latest = {
        ...latest,
        ...(event.resourceId ? { resourceId: event.resourceId } : {}),
        ...(event.resourceRevisionId ? { resourceRevisionId: event.resourceRevisionId } : {}),
        ...(event.locator ? { locator: event.locator } : {}),
        ...(event.playing !== undefined ? { playing: event.playing } : {}),
        ...(event.playbackRate !== undefined ? { playbackRate: event.playbackRate } : {}),
      };
    }
    for (const listener of [...listeners]) listener(event);
  },
  /** The reader closed: there is no longer a place to record against. */
  clear(resourceId?: string): void {
    if (!resourceId || latest?.resourceId === resourceId) latest = null;
  },
  latest(): LatestPosition | null {
    return latest;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  /** For tests. */
  reset(): void {
    listeners.clear();
    latest = null;
  },
};
