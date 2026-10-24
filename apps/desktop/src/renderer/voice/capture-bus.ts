import type { PositionInput } from "./recorder.ts";

/**
 * Where the reader is, announced by whichever reader is open and heard by the recorder. Readers do not know about
 * recording: they say "the page is now this" or "the video was seeked here". The latest position is kept so a recording
 * that starts later begins with the place the reader is at, and a recording hears every change after that.
 *
 * With several reader tabs open each one speaks under its own owner (the tab's id). The place a recording starts from is the focused tab's, and a
 * recording is bound to the tab that was focused when it started: it hears only that tab, and moving the focus does not change that (A-94).
 */
type Listener = (event: PositionInput) => void;

export type LatestPosition = Pick<PositionInput, "resourceId" | "resourceRevisionId" | "locator" | "playing" | "playbackRate">;

const DEFAULT_OWNER = "";
const listeners = new Set<Listener>();
const bindingListeners = new Set<(owner: string | null) => void>();
const latestBy = new Map<string, LatestPosition>();
let focusOwner: string | null = null;
let lastOwner = DEFAULT_OWNER;
let bound: string | null = null;

const currentOwner = (): string => bound ?? focusOwner ?? lastOwner;

export const captureBus = {
  emit(event: PositionInput, owner: string = DEFAULT_OWNER): void {
    lastOwner = owner;
    const latest = latestBy.get(owner) ?? null;
    // A resource change names a new place; anything else refines the place already known.
    if (event.reason === "resource_change" || event.reason === "episode_change" || event.reason === "start") {
      latestBy.set(owner, { resourceId: event.resourceId, resourceRevisionId: event.resourceRevisionId, locator: event.locator, playing: event.playing, playbackRate: event.playbackRate });
    } else if (latest) {
      latestBy.set(owner, {
        ...latest,
        ...(event.resourceId ? { resourceId: event.resourceId } : {}),
        ...(event.resourceRevisionId ? { resourceRevisionId: event.resourceRevisionId } : {}),
        ...(event.locator ? { locator: event.locator } : {}),
        ...(event.playing !== undefined ? { playing: event.playing } : {}),
        ...(event.playbackRate !== undefined ? { playbackRate: event.playbackRate } : {}),
      });
    }
    // A recording that is bound to a tab hears no other.
    if (bound !== null && owner !== bound) return;
    for (const listener of [...listeners]) listener(event);
  },
  /** The reader closed: there is no longer a place to record against. */
  clear(resourceId?: string, owner: string = DEFAULT_OWNER): void {
    const latest = latestBy.get(owner);
    if (latest && (!resourceId || latest.resourceId === resourceId)) latestBy.delete(owner);
  },
  latest(): LatestPosition | null {
    return latestBy.get(currentOwner()) ?? null;
  },
  /** The tab in front: the place a recording starts from. */
  focus(owner: string | null): void {
    focusOwner = owner;
  },
  /** A recording starts: it listens to the tab that is in front now, whichever tab is in front later. */
  bind(): void {
    bound = focusOwner ?? lastOwner;
    for (const listener of [...bindingListeners]) listener(bound);
  },
  /** The recording ended. */
  unbind(): void {
    if (bound === null) return;
    bound = null;
    for (const listener of [...bindingListeners]) listener(null);
  },
  /** Told which tab a recording is bound to when one starts, and `null` when it ends (the tab's title shows it). */
  onBinding(listener: (owner: string | null) => void): () => void {
    bindingListeners.add(listener);
    return () => { bindingListeners.delete(listener); };
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  /** For tests. */
  reset(): void {
    listeners.clear();
    latestBy.clear();
    focusOwner = null;
    lastOwner = DEFAULT_OWNER;
    bound = null;
    bindingListeners.clear();
  },
};
