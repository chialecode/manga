import { createContext, useContext, useSyncExternalStore } from "react";
import { emptyComposer, type ComposerState } from "../lib/types.ts";

const EMPTY: ComposerState = emptyComposer();

/**
 * What the input of each conversation holds — text, chosen materials, pictures — kept outside the panes, so the dock that follows the focused tab and a
 * conversation tab show the same draft for the same subject, and a draft survives the pane being closed and shown again.
 */
export class Drafts {
  private readonly map = new Map<string, ComposerState>();
  private readonly listeners = new Set<() => void>();
  private counter = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  version = (): number => this.counter;

  get(key: string): ComposerState {
    return this.map.get(key) ?? EMPTY;
  }

  patch(key: string, patch: Partial<ComposerState>): void {
    this.update(key, () => patch);
  }

  /** A change computed from the draft as it is when the change lands, for choices made after an await. */
  update(key: string, change: (current: ComposerState) => Partial<ComposerState>): void {
    const existing = this.map.get(key) ?? EMPTY;
    this.map.set(key, { ...existing, ...change(existing) });
    this.counter += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

export const DraftsContext = createContext<Drafts>(new Drafts());

export function useDraft(key: string): { composer: ComposerState; patch: (patch: Partial<ComposerState>) => void; update: (change: (current: ComposerState) => Partial<ComposerState>) => void } {
  const drafts = useContext(DraftsContext);
  const composer = useSyncExternalStore(drafts.subscribe, () => drafts.get(key), () => drafts.get(key));
  return {
    composer,
    patch: (patch) => drafts.patch(key, patch),
    update: (change) => drafts.update(key, change),
  };
}
