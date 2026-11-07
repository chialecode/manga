import { useSyncExternalStore } from "react";
import type { VideoFacts } from "../readers/video-health.ts";

/**
 * What the open player knows about its own picture (how the file plays, the element's counters, the subtitle renderer and its fonts). It is shown
 * in the context debug panel only; the player puts it here and the panel reads it, so neither knows the other.
 */
type Listener = () => void;

let shown: (VideoFacts & { resourceId: string }) | null = null;
const listeners = new Set<Listener>();

const same = (a: VideoFacts | null, b: VideoFacts | null) => JSON.stringify(a) === JSON.stringify(b);

export const videoFacts = {
  set(resourceId: string, facts: VideoFacts): void {
    if (shown && shown.resourceId === resourceId) {
      const { resourceId: _same, ...current } = shown;
      if (same(current, facts)) return;
    }
    shown = { ...facts, resourceId };
    for (const listener of [...listeners]) listener();
  },
  /** The player closed. Only the player that set it clears it. */
  clear(resourceId?: string): void {
    if (!shown || (resourceId && shown.resourceId !== resourceId)) return;
    shown = null;
    for (const listener of [...listeners]) listener();
  },
  get(): (VideoFacts & { resourceId: string }) | null {
    return shown;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  /** For tests. */
  reset(): void {
    shown = null;
    listeners.clear();
  },
};

export function useVideoFacts(): (VideoFacts & { resourceId: string }) | null {
  return useSyncExternalStore(videoFacts.subscribe, videoFacts.get, videoFacts.get);
}
