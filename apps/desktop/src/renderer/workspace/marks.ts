import { useSyncExternalStore } from "react";

/** What a tab shows on its title besides its name: a video is playing in it, a recording is listening to it, an Agent is working in it (A-95). */
export type TabMark = "playing" | "recording" | "running";

const EMPTY: readonly TabMark[] = Object.freeze([]);
const held = new Map<string, readonly TabMark[]>();
const listeners = new Set<() => void>();

export const tabMarks = {
  set(tabId: string, mark: TabMark, on: boolean): void {
    const before = held.get(tabId) ?? EMPTY;
    if (before.includes(mark) === on) return;
    const next = on ? [...before, mark] : before.filter((item) => item !== mark);
    if (next.length) held.set(tabId, Object.freeze(next)); else held.delete(tabId);
    for (const listener of [...listeners]) listener();
  },
  get(tabId: string): readonly TabMark[] {
    return held.get(tabId) ?? EMPTY;
  },
  /** A tab closed: its marks go with it. */
  clear(tabId: string): void {
    if (!held.delete(tabId)) return;
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  /** For tests. */
  reset(): void {
    held.clear();
    listeners.clear();
  },
};

export function useTabMarks(tabId: string): readonly TabMark[] {
  return useSyncExternalStore(tabMarks.subscribe, () => tabMarks.get(tabId), () => EMPTY);
}
