/**
 * Pure coordination helpers for light open's main process (`light/main.ts`):
 * - Buffers `second-instance` requests arriving before `app.whenReady()` finishes initialization.
 * - Tracks monotonic per-window open generations so superseded async `service.open()` results
 *   never overwrite a newer file or leak their media session.
 */

export type SecondInstanceQueue<T> = {
  push(item: T): void;
  markReady(handler: (item: T) => void): void;
  readonly isReady: boolean;
  readonly pendingCount: number;
};

export function createSecondInstanceQueue<T>(): SecondInstanceQueue<T> {
  let ready = false;
  let onItem: ((item: T) => void) | null = null;
  const pending: T[] = [];
  return {
    get isReady() { return ready; },
    get pendingCount() { return pending.length; },
    push(item: T) {
      if (ready && onItem) onItem(item);
      else pending.push(item);
    },
    markReady(handler: (item: T) => void) {
      onItem = handler;
      ready = true;
      const batch = pending.splice(0, pending.length);
      for (const item of batch) handler(item);
    },
  };
}

export type OpenTracker = {
  next(): number;
  isCurrent(seq: number): boolean;
  invalidate(): void;
};

export function createOpenTracker(): OpenTracker {
  let current = 0;
  return {
    next() {
      current += 1;
      return current;
    },
    isCurrent(seq: number) {
      return seq === current;
    },
    invalidate() {
      current += 1;
    },
  };
}
