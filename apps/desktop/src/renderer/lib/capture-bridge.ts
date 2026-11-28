import { createContext, useContext, useSyncExternalStore } from "react";
import type { NoteAnchor } from "./chat-model.ts";
import type { QuoteTag } from "./quote-tags.ts";

export type RegisteredScreenshot = {
  kind: "video" | "comic";
  resourceId: string;
  label: string;
  disabled: boolean;
  take: () => Promise<void> | void;
  /** Exact millisecond clock for video so quick-note locks an unthrottled timestamp on open. */
  getExactVideoMs?: () => number;
};

type Listener = () => void;

const DEFAULT_OWNER = "";
const entries = new Map<string, RegisteredScreenshot>();
const pendingTags = new Map<string, QuoteTag>();
let focusOwner: string | null = null;
let lastOwner: string = DEFAULT_OWNER;
const listeners = new Set<Listener>();
let cachedSnapshot: RegisteredScreenshot | null = null;

function currentOwner(): string {
  return focusOwner ?? lastOwner;
}

function sameScreenshot(a: RegisteredScreenshot | null, b: RegisteredScreenshot | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind && a.resourceId === b.resourceId && a.label === b.label && a.disabled === b.disabled && a.take === b.take;
}

function refreshSnapshot(): void {
  const next = entries.get(currentOwner()) ?? null;
  if (sameScreenshot(cachedSnapshot, next)) return;
  cachedSnapshot = next;
  for (const listener of [...listeners]) listener();
}

/**
 * Per-tab bridge between readers and the right-side capture surfaces (EdgeHandle, Composer, QuickNoteModal).
 * Mirrors `readerContext` ownership so screenshot triggers and exact video timestamps always belong to the focused tab.
 */
export const captureBridge = {
  register(entry: RegisteredScreenshot, owner: string = DEFAULT_OWNER): void {
    entries.set(owner, entry);
    lastOwner = owner;
    refreshSnapshot();
  },
  unregister(resourceId: string, owner: string = DEFAULT_OWNER): void {
    const held = entries.get(owner);
    if (!held || held.resourceId !== resourceId) return;
    entries.delete(owner);
    refreshSnapshot();
  },
  focus(owner: string | null): void {
    if (focusOwner === owner) return;
    focusOwner = owner;
    refreshSnapshot();
  },
  get(owner?: string): RegisteredScreenshot | null {
    return entries.get(owner ?? currentOwner()) ?? null;
  },
  getExactVideoMs(resourceId?: string): number | null {
    const entry = entries.get(currentOwner());
    if (!entry || entry.kind !== "video" || !entry.getExactVideoMs) return null;
    if (resourceId && entry.resourceId !== resourceId) return null;
    const ms = entry.getExactVideoMs();
    return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : null;
  },
  setPendingTag(tag: QuoteTag | null, owner: string = DEFAULT_OWNER): void {
    if (tag) {
      pendingTags.set(owner, tag);
      lastOwner = owner;
    } else {
      pendingTags.delete(owner);
    }
  },
  getPendingTag(resourceId?: string): QuoteTag | null {
    const tag = pendingTags.get(currentOwner()) ?? null;
    if (!tag) return null;
    if (resourceId && tag.resourceId !== resourceId) return null;
    return tag;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
  snapshot(): RegisteredScreenshot | null {
    return cachedSnapshot;
  },
  reset(): void {
    entries.clear();
    pendingTags.clear();
    focusOwner = null;
    lastOwner = DEFAULT_OWNER;
    cachedSnapshot = null;
    listeners.clear();
  },
};

export function useFocusedScreenshot(): RegisteredScreenshot | null {
  return useSyncExternalStore(captureBridge.subscribe, captureBridge.snapshot, captureBridge.snapshot);
}

// ---- Quick-Note active session (used by VideoPlayer for `pauseOnQuickNote`) ----

export type QuickNoteSessionState = {
  open: boolean;
  resourceId: string | null;
};

let quickNoteState: QuickNoteSessionState = { open: false, resourceId: null };
const quickNoteListeners = new Set<Listener>();

export const quickNoteSession = {
  get(): QuickNoteSessionState {
    return quickNoteState;
  },
  set(open: boolean, resourceId: string | null): void {
    if (quickNoteState.open === open && quickNoteState.resourceId === resourceId) return;
    quickNoteState = { open, resourceId };
    for (const listener of [...quickNoteListeners]) listener();
  },
  subscribe(listener: Listener): () => void {
    quickNoteListeners.add(listener);
    return () => { quickNoteListeners.delete(listener); };
  },
  reset(): void {
    quickNoteState = { open: false, resourceId: null };
    quickNoteListeners.clear();
  },
};

export function useQuickNoteSession(): QuickNoteSessionState {
  return useSyncExternalStore(quickNoteSession.subscribe, quickNoteSession.get, quickNoteSession.get);
}

// ---- Plan D capture actions context (provided by Workbench, safely optional for standalone reader tests) ----

export type OpenQuickNoteRequest = {
  tag?: QuoteTag;
  anchor?: NoteAnchor;
  anchorLabel?: string;
};

export type CaptureActions = {
  openQuickNote: (request?: OpenQuickNoteRequest) => void;
  askAgentWithTag: (tag: QuoteTag) => void;
  toggleRecording: () => void;
  recordingActive: boolean;
  voiceEnabled: boolean;
  recordingToggleKey: string;
  notify: (message: string) => void;
};

const CaptureActionsContext = createContext<CaptureActions | null>(null);
export const CaptureActionsProvider = CaptureActionsContext.Provider;
export const useCaptureActions = (): CaptureActions | null => useContext(CaptureActionsContext);
