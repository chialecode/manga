import { useCallback, useRef } from "react";

/**
 * Serializes async canvas mutations in FIFO order so rapid edits (create, drag, edit, undo)
 * never overtake one another. `hasMore()` reports whether newer operations are still queued
 * behind the currently running one so callers can skip intermediate redraws.
 */
export function useCanvasOpQueue() {
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const pendingRef = useRef(0);

  const enqueue = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    pendingRef.current += 1;
    const run = async (): Promise<T> => {
      try {
        return await task();
      } finally {
        pendingRef.current -= 1;
      }
    };
    const next = chainRef.current.then(run, run);
    chainRef.current = next.catch(() => undefined);
    return next;
  }, []);

  const hasMore = useCallback(() => pendingRef.current > 1, []);

  return { enqueue, hasMore };
}
