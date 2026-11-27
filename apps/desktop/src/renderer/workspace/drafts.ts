import { createContext, useCallback, useContext, useSyncExternalStore } from "react";
import { emptyComposer, type ComposerState } from "../lib/types.ts";

const EMPTY: ComposerState = emptyComposer();

/**
 * What the input of each conversation holds — text, chosen materials, pictures, attachments — kept outside the panes, so the dock that follows
 * the focused tab and a conversation tab show the same draft for the same subject, and a draft survives switching conversations.
 *
 * Text (`draft`) and non-text metadata are subscribed independently so typing in `<textarea>` only re-renders the composer, never `MessageList` or `Bubble`.
 */
export class Drafts {
  private readonly map = new Map<string, ComposerState>();
  private readonly listeners = new Set<() => void>();
  private readonly textListeners = new Map<string, Set<() => void>>();
  private readonly metaListeners = new Map<string, Set<() => void>>();
  private readonly metaCache = new Map<string, ComposerState>();
  private counter = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  subscribeText(key: string, listener: () => void): () => void {
    let set = this.textListeners.get(key);
    if (!set) { set = new Set(); this.textListeners.set(key, set); }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.textListeners.delete(key);
    };
  }

  subscribeMeta(key: string, listener: () => void): () => void {
    let set = this.metaListeners.get(key);
    if (!set) { set = new Set(); this.metaListeners.set(key, set); }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.metaListeners.delete(key);
    };
  }

  version = (): number => this.counter;

  get(key: string): ComposerState {
    return this.map.get(key) ?? EMPTY;
  }

  getDraft(key: string): string {
    return (this.map.get(key) ?? EMPTY).draft;
  }

  /** Returns a referentially stable snapshot whose identity only changes when non-`draft` fields change. */
  getMeta(key: string): ComposerState {
    const cached = this.metaCache.get(key);
    if (cached) return cached;
    const state = this.map.get(key);
    if (!state) return EMPTY;
    this.metaCache.set(key, state);
    return state;
  }

  setDraft(key: string, draft: string): void {
    this.patch(key, { draft });
  }

  /** Copies any non-empty draft from an unresolved surface key onto a resolved session key once. */
  adoptIfEmpty(fromKey: string, toKey: string): void {
    if (fromKey === toKey) return;
    const from = this.map.get(fromKey);
    if (!from) return;
    const to = this.map.get(toKey);
    const fromHasContent = Boolean(
      from.draft || from.materials.length || from.noteMaterials.length || from.images.length || (from.files?.length ?? 0) || from.recordings.length
      || from.allowOnline || from.allowSemantic || from.allowWebpage || from.allowWebSearch || from.subtitleAheadMin,
    );
    if (!fromHasContent) return;
    const toHasContent = Boolean(
      to && (to.draft || to.materials.length || to.noteMaterials.length || to.images.length || (to.files?.length ?? 0) || to.recordings.length),
    );
    if (toHasContent) return;
    this.map.set(toKey, { ...from });
    this.metaCache.set(toKey, this.map.get(toKey)!);
    this.map.delete(fromKey);
    this.metaCache.delete(fromKey);
    this.counter += 1;
    this.emit(fromKey, true, true);
    this.emit(toKey, true, true);
  }

  patch(key: string, patch: Partial<ComposerState>): void {
    this.update(key, () => patch);
  }

  /** A change computed from the draft as it is when the change lands, for choices made after an await. */
  update(key: string, change: (current: ComposerState) => Partial<ComposerState>): void {
    const existing = this.map.get(key) ?? EMPTY;
    const delta = change(existing);
    const next: ComposerState = { ...existing, ...delta };
    const textChanged = next.draft !== existing.draft;
    const metaChanged = (
      next.materials !== existing.materials
      || next.noteMaterials !== existing.noteMaterials
      || next.images !== existing.images
      || next.files !== existing.files
      || next.recordings !== existing.recordings
      || next.allowOnline !== existing.allowOnline
      || next.allowSemantic !== existing.allowSemantic
      || next.allowWebpage !== existing.allowWebpage
      || next.allowWebSearch !== existing.allowWebSearch
      || next.subtitleAheadMin !== existing.subtitleAheadMin
    );
    if (!textChanged && !metaChanged) return;
    this.map.set(key, next);
    if (metaChanged || !this.metaCache.has(key)) {
      this.metaCache.set(key, next);
    }
    this.counter += 1;
    this.emit(key, textChanged, metaChanged);
  }

  private emit(key: string, textChanged: boolean, metaChanged: boolean): void {
    for (const listener of [...this.listeners]) listener();
    if (textChanged) {
      const set = this.textListeners.get(key);
      if (set) for (const listener of [...set]) listener();
    }
    if (metaChanged) {
      const set = this.metaListeners.get(key);
      if (set) for (const listener of [...set]) listener();
    }
  }
}

export const DraftsContext = createContext<Drafts>(new Drafts());

export function useDraft(key: string): { composer: ComposerState; patch: (patch: Partial<ComposerState>) => void; update: (change: (current: ComposerState) => Partial<ComposerState>) => void } {
  const drafts = useContext(DraftsContext);
  const composer = useSyncExternalStore(drafts.subscribe, () => drafts.get(key), () => drafts.get(key));
  const patch = useCallback((p: Partial<ComposerState>) => drafts.patch(key, p), [drafts, key]);
  const update = useCallback((c: (current: ComposerState) => Partial<ComposerState>) => drafts.update(key, c), [drafts, key]);
  return { composer, patch, update };
}

/** Subscribes ONLY to non-text fields of a composer state so typing never re-renders the chat stream. */
export function useDraftMeta(key: string): {
  composer: ComposerState;
  getDraft: () => string;
  patch: (patch: Partial<ComposerState>) => void;
  update: (change: (current: ComposerState) => Partial<ComposerState>) => void;
  drafts: Drafts;
} {
  const drafts = useContext(DraftsContext);
  const subscribe = useCallback((listener: () => void) => drafts.subscribeMeta(key, listener), [drafts, key]);
  const getSnapshot = useCallback(() => drafts.getMeta(key), [drafts, key]);
  const composer = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const getDraft = useCallback(() => drafts.getDraft(key), [drafts, key]);
  const patch = useCallback((p: Partial<ComposerState>) => drafts.patch(key, p), [drafts, key]);
  const update = useCallback((c: (current: ComposerState) => Partial<ComposerState>) => drafts.update(key, c), [drafts, key]);
  return { composer, getDraft, patch, update, drafts };
}

/** Subscribes ONLY to the text draft for `key`, isolating keystrokes to the composer leaf. */
export function useDraftText(key: string | undefined): [string, (value: string) => void] {
  const drafts = useContext(DraftsContext);
  const subscribe = useCallback((listener: () => void) => (key ? drafts.subscribeText(key, listener) : () => {}), [drafts, key]);
  const getSnapshot = useCallback(() => (key ? drafts.getDraft(key) : ""), [drafts, key]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setValue = useCallback((next: string) => {
    if (key) drafts.setDraft(key, next);
  }, [drafts, key]);
  return [value, setValue];
}
