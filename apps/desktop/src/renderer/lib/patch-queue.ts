/**
 * Serialized optimistic patch queue.
 *
 * Keeps an authoritative `base` state plus a FIFO queue of optimistic patches:
 * - Concurrent calls to `enqueue(patch)` serialize strictly in order so out-of-order IPC responses cannot clobber newer edits.
 * - External refreshes call `hydrate(nextBase)` which updates the confirmed base and re-overlays any in-flight/queued patches.
 * - A rejected patch rolls back only itself while preserving all subsequent queued patches on top of the confirmed base.
 */

export type PatchSendResult<State> =
  | boolean
  | { ok: true; state?: State }
  | { ok: false; error?: string };

export type PatchQueueOptions<State, Patch> = {
  initial: State;
  apply: (state: State, patch: Patch) => State;
  send: (patch: Patch, nextState: State) => Promise<PatchSendResult<State>>;
  onState: (state: State) => void;
  onError?: (error: string | undefined, patch: Patch) => void;
};

export type PatchQueue<State, Patch> = {
  enqueue: (patch: Patch) => Promise<boolean>;
  hydrate: (nextBase: State) => State;
  current: () => State;
  hasPending: () => boolean;
  flush: () => Promise<void>;
  reset: (nextBase: State) => void;
};

type Queued<Patch> = { patch: Patch; resolve: (ok: boolean) => void };

export function createPatchQueue<State, Patch>(options: PatchQueueOptions<State, Patch>): PatchQueue<State, Patch> {
  let base = options.initial;
  let inFlight: Queued<Patch> | null = null;
  const pending: Queued<Patch>[] = [];
  let draining: Promise<void> | null = null;

  const computeView = (): State => {
    let view = base;
    if (inFlight) view = options.apply(view, inFlight.patch);
    for (const entry of pending) view = options.apply(view, entry.patch);
    return view;
  };

  const emit = (): State => {
    const view = computeView();
    options.onState(view);
    return view;
  };

  const drain = (): Promise<void> => {
    if (draining) return draining;
    draining = (async () => {
      try {
        while (pending.length > 0) {
          const entry = pending.shift()!;
          inFlight = entry;
          const nextBase = options.apply(base, entry.patch);
          let ok = false;
          let confirmedState: State | undefined;
          let errorMessage: string | undefined;
          try {
            const result = await options.send(entry.patch, nextBase);
            if (typeof result === "boolean") {
              ok = result;
            } else if (result.ok) {
              ok = true;
              confirmedState = result.state;
            } else {
              ok = false;
              errorMessage = result.error;
            }
          } catch (error) {
            ok = false;
            errorMessage = error instanceof Error ? error.message : String(error);
          }
          inFlight = null;
          if (ok) {
            base = confirmedState !== undefined ? confirmedState : options.apply(base, entry.patch);
            emit();
            entry.resolve(true);
          } else {
            emit();
            options.onError?.(errorMessage, entry.patch);
            entry.resolve(false);
          }
        }
      } finally {
        draining = null;
      }
    })();
    return draining;
  };

  return {
    enqueue(patch) {
      return new Promise<boolean>((resolve) => {
        pending.push({ patch, resolve });
        emit();
        void drain();
      });
    },
    hydrate(nextBase) {
      base = nextBase;
      return emit();
    },
    current: computeView,
    hasPending: () => inFlight !== null || pending.length > 0,
    async flush() {
      while (draining) await draining;
    },
    reset(nextBase) {
      base = nextBase;
      while (pending.length > 0) pending.shift()!.resolve(false);
      emit();
    },
  };
}
