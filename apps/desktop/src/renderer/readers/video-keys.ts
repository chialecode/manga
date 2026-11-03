import { HOLD_MS } from "./video-model.ts";

/** -1 is ←, 1 is →. */
export type ArrowSide = -1 | 1;

export type ArrowHandlers = {
  /** The key was let go before the hold time: one step of the seek step, backward or forward. */
  tap: (side: ArrowSide) => void;
  /** The key has been down for the hold time: → plays at the temporary rate, ← rewinds. */
  holdStart: (side: ArrowSide) => void;
  /** The key was let go after a hold: back to how it was. */
  holdEnd: (side: ArrowSide) => void;
};

export type Scheduler = { set: (run: () => void, ms: number) => number; clear: (id: number) => void };

const windowScheduler: Scheduler = { set: (run, ms) => window.setTimeout(run, ms), clear: (id) => window.clearTimeout(id) };

/**
 * What an arrow key does depends on how long it is down (Q-13): let go at once it is a step; held past `HOLD_MS` it is a hold, which lasts until
 * the key is let go. The system's key repeat while a key is down is swallowed, so it neither steps again nor restarts the hold. A step is made
 * when the key goes up, so one press is never both a step and the start of a hold.
 *
 * Two events the player can miss heal themselves (A-112): a fresh press of a key that is still down means its key-up was lost, so the old press ends
 * (a hold is let go, a pending step is dropped) and the new one starts; a repeat with no press on record means the press went somewhere else and the
 * key has been down past the system's repeat delay, so the hold starts at once, with no step.
 */
export function createArrowKeys(handlers: ArrowHandlers, options: { holdMs?: number; scheduler?: Scheduler } = {}) {
  const holdMs = options.holdMs ?? HOLD_MS;
  const scheduler = options.scheduler ?? windowScheduler;
  let down: { side: ArrowSide; timer: number; held: boolean } | null = null;

  const finish = (withTap: boolean) => {
    const current = down;
    if (!current) return;
    down = null;
    scheduler.clear(current.timer);
    if (current.held) handlers.holdEnd(current.side);
    else if (withTap) handlers.tap(current.side);
  };

  return {
    /** A key went down. `repeat` is the system's repeat of a key that is still down; for the key on record it changes nothing. */
    down(side: ArrowSide, repeat = false): void {
      if (repeat && down?.side === side) return;
      // The same arrow pressed again (its key-up was lost) ends without a step; the other arrow ends the first one as it stands. The new one starts.
      finish(down !== null && down.side !== side);
      if (repeat) {
        // The press itself never came here: the key is already held.
        down = { side, timer: 0, held: true };
        handlers.holdStart(side);
        return;
      }
      const current = { side, timer: 0, held: false };
      current.timer = scheduler.set(() => { current.held = true; handlers.holdStart(side); }, holdMs);
      down = current;
    },
    up(side: ArrowSide): void {
      if (down?.side === side) finish(true);
    },
    /** The window lost focus or the player went away: whatever is held ends, and nothing is stepped. */
    release(): void {
      finish(false);
    },
    active(): { side: ArrowSide; held: boolean } | null {
      return down ? { side: down.side, held: down.held } : null;
    },
  };
}
