import { useSyncExternalStore } from "react";

/**
 * Quote tags (A-47): what the user picked on a reading page, waiting in the right pane's input. Reading pages only read, so a text
 * selection, a framed region of a page or a marked stretch of a video is not turned into a note there; it becomes a tag here and the
 * right pane decides what to do with it (a note anchored at it, or a question about it). A page and the pane meet only in this store.
 */
export type QuoteTag =
  | { id: string; kind: "selection"; resourceId: string; revisionId: string; label: string; partId?: string; start: number; end: number; quote: string }
  | { id: string; kind: "region"; resourceId: string; revisionId: string; label: string; pageId: string; pageNumber: number; region: { x: number; y: number; width: number; height: number } }
  | { id: string; kind: "interval"; resourceId: string; revisionId: string; label: string; startMs: number; endMs: number };

export type QuoteTagKind = QuoteTag["kind"];
/** `Omit` on a union would merge its members; this keeps each kind's own fields. */
type Untagged<T> = T extends unknown ? Omit<T, "id"> & { id?: string } : never;
type Listener = () => void;

let tags: readonly QuoteTag[] = [];
const listeners = new Set<Listener>();
const emit = () => { for (const listener of [...listeners]) listener(); };

export const quoteTags = {
  all(): readonly QuoteTag[] { return tags; },
  /** A tag of a kind replaces the one of the same kind, so the input never collects a pile of stale selections. */
  put(tag: Untagged<QuoteTag>): void {
    const next = { ...tag, id: tag.id ?? `${tag.kind}:${tag.resourceId}` } as QuoteTag;
    tags = [...tags.filter((item) => item.kind !== next.kind), next];
    emit();
  },
  remove(id: string): void {
    if (!tags.some((item) => item.id === id)) return;
    tags = tags.filter((item) => item.id !== id);
    emit();
  },
  /** Drop one kind (a selection that was cleared on the page). */
  removeKind(kind: QuoteTagKind, resourceId?: string): void {
    const next = tags.filter((item) => !(item.kind === kind && (!resourceId || item.resourceId === resourceId)));
    if (next.length === tags.length) return;
    tags = next;
    emit();
  },
  /** Everything that belonged to a resource, when its page closes. */
  clearFor(resourceId?: string): void {
    const next = resourceId ? tags.filter((item) => item.resourceId !== resourceId) : [];
    if (next.length === tags.length) return;
    tags = next;
    emit();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  /** For tests. */
  reset(): void { tags = []; listeners.clear(); },
};

/** The tags that belong to the open resource; a tag left by another page is not shown or sent. */
export function useQuoteTags(resourceId?: string | null): readonly QuoteTag[] {
  const all = useSyncExternalStore(quoteTags.subscribe, quoteTags.all, quoteTags.all);
  return resourceId ? all.filter((item) => item.resourceId === resourceId) : [];
}
