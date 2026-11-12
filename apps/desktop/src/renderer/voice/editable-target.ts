import type { Editor } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
import type { EditorView, ViewUpdate } from "@codemirror/view";

export const DEFAULT_EDIT_OBSERVE_MS = 60_000;

export type ObservedEditPayload = {
  insertedText: string;
  editedText: string;
};

export type EditableTargetHandle = {
  readonly kind: "native" | "tiptap" | "codemirror" | "contenteditable";
  readonly element: HTMLElement;
  isAlive(): boolean;
  insert(text: string): boolean;
  replace(text: string): boolean;
  startEditObservation(onObservedEdit: (payload: ObservedEditPayload) => void, timeoutMs?: number): () => void;
  getRect(): DOMRect | null;
  dispose(): void;
};

type TiptapEntry = {
  getEditor: () => Editor | null;
  kind: "note" | "draft";
  onBeforeStep?: () => void;
};

type CodeMirrorEntry = {
  view: EditorView;
  onBeforeStep?: () => void;
  updateListeners: Set<(update: ViewUpdate) => void>;
};

const tiptapRegistry = new Set<TiptapEntry>();
const codeMirrorRegistry = new Map<EditorView, CodeMirrorEntry>();

export function registerTiptapEditor(
  getEditor: () => Editor | null,
  options: { kind: "note" | "draft"; onBeforeStep?: () => void },
): () => void {
  const entry: TiptapEntry = { getEditor, kind: options.kind, ...(options.onBeforeStep ? { onBeforeStep: options.onBeforeStep } : {}) };
  tiptapRegistry.add(entry);
  return () => {
    tiptapRegistry.delete(entry);
  };
}

export function registerCodeMirrorView(
  view: EditorView,
  options?: { onBeforeStep?: () => void },
): { unregister: () => void; onUpdate: (update: ViewUpdate) => void } {
  const entry: CodeMirrorEntry = {
    view,
    ...(options?.onBeforeStep ? { onBeforeStep: options.onBeforeStep } : {}),
    updateListeners: new Set(),
  };
  codeMirrorRegistry.set(view, entry);
  return {
    unregister: () => {
      codeMirrorRegistry.delete(view);
    },
    onUpdate: (update: ViewUpdate) => {
      for (const listener of [...entry.updateListeners]) listener(update);
    },
  };
}

// ---- IME composition barrier ----

let windowComposing = false;
let compositionInstalled = false;
const compositionEndWaiters = new Set<() => void>();

function ensureCompositionListeners(): void {
  if (compositionInstalled || typeof window === "undefined") return;
  compositionInstalled = true;
  window.addEventListener("compositionstart", () => {
    windowComposing = true;
  }, true);
  window.addEventListener("compositionend", () => {
    windowComposing = false;
    const waiters = [...compositionEndWaiters];
    compositionEndWaiters.clear();
    for (const notify of waiters) notify();
  }, true);
}

/** Test helper to reset module-level IME state cleanly between tests. */
export function resetCompositionState(): void {
  windowComposing = false;
  compositionEndWaiters.clear();
}

function getTiptapDom(editor: Editor | null | undefined): HTMLElement | null {
  if (!editor || editor.isDestroyed) return null;
  try {
    const dom = editor.view?.dom;
    return dom instanceof HTMLElement ? dom : null;
  } catch {
    return null;
  }
}

export function isImeComposing(target?: Element | null): boolean {
  ensureCompositionListeners();
  if (windowComposing) return true;
  const active = target ?? (typeof document !== "undefined" ? document.activeElement : null);
  if (!active) return false;
  for (const entry of tiptapRegistry) {
    const editor = entry.getEditor();
    const dom = getTiptapDom(editor);
    if (editor && dom && (dom === active || dom.contains(active))) {
      if (editor.view.composing) return true;
    }
  }
  return false;
}

/**
 * Waits until any active IME composition finishes and commits its text before capturing selection or opening the microphone.
 * Resolves `false` immediately if `abortRef.aborted` becomes true or `onAbort` triggers before composition ends.
 */
export function waitForCompositionEnd(abort?: { readonly aborted: boolean; onAbort?: (cb: () => void) => () => void }): Promise<boolean> {
  ensureCompositionListeners();
  if (abort?.aborted) return Promise.resolve(false);
  if (!isImeComposing()) return Promise.resolve(true);

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let offAbort: (() => void) | undefined;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      compositionEndWaiters.delete(onEnd);
      offAbort?.();
      resolve(ok);
    };
    const onEnd = () => {
      queueMicrotask(() => {
        finish(!abort?.aborted);
      });
    };
    compositionEndWaiters.add(onEnd);
    offAbort = abort?.onAbort?.(() => finish(false));
  });
}

// ---- Native <input> / <textarea> helpers ----

const TEXT_INPUT_TYPES = new Set(["", "text", "search", "url", "tel", "email"]);

function isEditableInput(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLInputElement) {
    if (el.disabled || el.readOnly) return false;
    return TEXT_INPUT_TYPES.has((el.type || "text").toLowerCase());
  }
  return false;
}

function writeNativeInputValue(el: HTMLInputElement | HTMLTextAreaElement, nextValue: string, caret: number): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
  if (descriptor?.set) descriptor.set.call(el, nextValue);
  else el.value = nextValue;
  try {
    el.setSelectionRange(caret, caret);
  } catch {
    // Input types such as email do not always allow selection ranges.
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

function commonSuffixLength(a: string, b: string, minIndexA: number): number {
  const maxLen = Math.min(a.length - minIndexA, b.length);
  let i = 0;
  while (i < maxLen && a.charCodeAt(a.length - 1 - i) === b.charCodeAt(b.length - 1 - i)) i += 1;
  return i;
}

function createNativeHandle(el: HTMLInputElement | HTMLTextAreaElement): EditableTargetHandle {
  const initialValue = el.value;
  const initialStart = el.selectionStart ?? initialValue.length;
  const initialEnd = el.selectionEnd ?? initialStart;

  let inserted = false;
  let rangeStart = initialStart;
  let rangeEnd = initialEnd;
  let prefixSnapshot = "";
  let suffixSnapshot = "";
  let baselineText = "";
  let internalWrite = false;
  let stopObserve: (() => void) | null = null;

  const isAlive = () => el.isConnected && !el.disabled && !el.readOnly;

  const applyAt = (from: number, to: number, text: string): boolean => {
    if (!isAlive()) return false;
    const current = el.value;
    const safeFrom = Math.max(0, Math.min(from, current.length));
    const safeTo = Math.max(safeFrom, Math.min(to, current.length));
    const before = current.slice(0, safeFrom);
    const after = current.slice(safeTo);
    const nextValue = before + text + after;
    const caret = safeFrom + text.length;
    internalWrite = true;
    try {
      writeNativeInputValue(el, nextValue, caret);
    } finally {
      internalWrite = false;
    }
    inserted = true;
    rangeStart = safeFrom;
    rangeEnd = caret;
    prefixSnapshot = before;
    suffixSnapshot = after;
    baselineText = text;
    return true;
  };

  return {
    kind: "native",
    element: el,
    isAlive,
    insert(text: string): boolean {
      if (!isAlive()) return false;
      // If the user typed or modified the input while recognition was running, insert at the current cursor instead of overwriting.
      const modified = el.value !== initialValue;
      const from = modified ? (el.selectionStart ?? el.value.length) : initialStart;
      const to = modified ? (el.selectionEnd ?? from) : initialEnd;
      return applyAt(from, to, text);
    },
    replace(text: string): boolean {
      if (!inserted || !isAlive()) return false;
      // Verify the tracked range still aligns with prefix/suffix; if user edited meanwhile, locate slice via prefix/suffix anchoring.
      const current = el.value;
      const preLen = commonPrefixLength(current, prefixSnapshot);
      const sufLen = commonSuffixLength(current, suffixSnapshot, preLen);
      const from = preLen === prefixSnapshot.length ? rangeStart : preLen;
      const to = preLen === prefixSnapshot.length && sufLen === suffixSnapshot.length ? rangeEnd : Math.max(from, current.length - sufLen);
      return applyAt(from, to, text);
    },
    startEditObservation(onObservedEdit, timeoutMs = DEFAULT_EDIT_OBSERVE_MS) {
      stopObserve?.();
      if (!inserted) return () => undefined;
      let userEdited = false;
      let fired = false;

      const finish = () => {
        if (fired) return;
        fired = true;
        cleanup();
        if (!userEdited) return;
        const current = el.value;
        const preLen = commonPrefixLength(current, prefixSnapshot);
        const sufLen = commonSuffixLength(current, suffixSnapshot, preLen);
        const editedText = current.slice(preLen, Math.max(preLen, current.length - sufLen));
        if (editedText !== baselineText && editedText.trim().length > 0 && baselineText.trim().length > 0) {
          onObservedEdit({ insertedText: baselineText, editedText });
        }
      };

      const onInput = () => {
        if (!internalWrite) userEdited = true;
      };
      // Capture-phase blur runs BEFORE React's onBlur unmounts transient inputs (Whiteboard card / Mindmap topic).
      const onBlur = () => finish();
      const timer = globalThis.setTimeout(finish, timeoutMs);

      el.addEventListener("input", onInput);
      el.addEventListener("change", onInput);
      el.addEventListener("blur", onBlur, true);

      const cleanup = () => {
        globalThis.clearTimeout(timer);
        el.removeEventListener("input", onInput);
        el.removeEventListener("change", onInput);
        el.removeEventListener("blur", onBlur, true);
        if (stopObserve === cleanup) stopObserve = null;
      };
      stopObserve = cleanup;
      return cleanup;
    },
    getRect() {
      return isAlive() ? el.getBoundingClientRect() : null;
    },
    dispose() {
      stopObserve?.();
    },
  };
}

// ---- Tiptap (NoteEditor rich view & DraftEditor) ----

function createTiptapHandle(entry: TiptapEntry, editor: Editor): EditableTargetHandle {
  const dom = editor.view.dom as HTMLElement;
  const initialFrom = editor.state.selection.from;
  const initialTo = editor.state.selection.to;

  let modifiedBeforeInsert = false;
  let inserted = false;
  let rangeFrom = initialFrom;
  let rangeTo = initialTo;
  let baselineText = "";
  let internalDispatch = false;
  let userEditedAfterInsert = false;
  let stopObserve: (() => void) | null = null;

  const onTransaction = ({ transaction }: { transaction: { docChanged: boolean; mapping: { map: (pos: number, assoc?: number) => number }; doc: { content: { size: number } } } }) => {
    if (!transaction.docChanged || internalDispatch) return;
    if (!inserted) {
      modifiedBeforeInsert = true;
      return;
    }
    userEditedAfterInsert = true;
    const maxPos = transaction.doc.content.size;
    rangeFrom = Math.max(0, Math.min(maxPos, transaction.mapping.map(rangeFrom, -1)));
    rangeTo = Math.max(rangeFrom, Math.min(maxPos, transaction.mapping.map(rangeTo, 1)));
  };
  editor.on("transaction", onTransaction as never);

  const isAlive = () => {
    if (!tiptapRegistry.has(entry)) return false;
    const live = entry.getEditor();
    const liveDom = getTiptapDom(live);
    return Boolean(live && live === editor && !editor.isDestroyed && liveDom?.isConnected);
  };

  const dispatchReplace = (from: number, to: number, text: string): boolean => {
    if (!isAlive()) return false;
    const maxPos = editor.state.doc.content.size;
    const safeFrom = Math.max(0, Math.min(from, maxPos));
    const safeTo = Math.max(safeFrom, Math.min(to, maxPos));

    entry.onBeforeStep?.();
    internalDispatch = true;
    try {
      let tr = editor.state.tr;
      if (entry.kind === "draft") tr = closeHistory(tr);
      tr = tr.insertText(text, safeFrom, safeTo);
      const endPos = tr.selection.to;
      if (entry.kind === "draft") tr = closeHistory(tr);
      editor.view.dispatch(tr);
      inserted = true;
      rangeFrom = safeFrom;
      rangeTo = endPos;
      baselineText = text;
    } finally {
      internalDispatch = false;
    }
    return true;
  };

  return {
    kind: "tiptap",
    element: dom,
    isAlive,
    insert(text: string): boolean {
      if (!isAlive()) return false;
      const from = modifiedBeforeInsert ? editor.state.selection.from : initialFrom;
      const to = modifiedBeforeInsert ? editor.state.selection.to : initialTo;
      return dispatchReplace(from, to, text);
    },
    replace(text: string): boolean {
      if (!inserted || !isAlive()) return false;
      userEditedAfterInsert = false;
      return dispatchReplace(rangeFrom, rangeTo, text);
    },
    startEditObservation(onObservedEdit, timeoutMs = DEFAULT_EDIT_OBSERVE_MS) {
      stopObserve?.();
      if (!inserted) return () => undefined;
      userEditedAfterInsert = false;
      let fired = false;

      const finish = () => {
        if (fired) return;
        fired = true;
        cleanup();
        if (!userEditedAfterInsert || !isAlive()) return;
        const maxPos = editor.state.doc.content.size;
        const safeFrom = Math.max(0, Math.min(rangeFrom, maxPos));
        const safeTo = Math.max(safeFrom, Math.min(rangeTo, maxPos));
        const editedText = editor.state.doc.textBetween(safeFrom, safeTo, "\n", "");
        if (editedText !== baselineText && editedText.trim().length > 0 && baselineText.trim().length > 0) {
          onObservedEdit({ insertedText: baselineText, editedText });
        }
      };

      const onBlur = () => finish();
      const timer = globalThis.setTimeout(finish, timeoutMs);
      dom.addEventListener("blur", onBlur, true);

      const cleanup = () => {
        globalThis.clearTimeout(timer);
        dom.removeEventListener("blur", onBlur, true);
        if (stopObserve === cleanup) stopObserve = null;
      };
      stopObserve = cleanup;
      return cleanup;
    },
    getRect() {
      return isAlive() ? dom.getBoundingClientRect() : null;
    },
    dispose() {
      stopObserve?.();
      editor.off("transaction", onTransaction as never);
    },
  };
}

// ---- CodeMirror 6 (NoteEditor SourceEditor) ----

function createCodeMirrorHandle(entry: CodeMirrorEntry): EditableTargetHandle {
  const { view } = entry;
  const dom = view.dom;
  const initialMain = view.state.selection.main;
  const initialFrom = initialMain.from;
  const initialTo = initialMain.to;

  let modifiedBeforeInsert = false;
  let inserted = false;
  let rangeFrom = initialFrom;
  let rangeTo = initialTo;
  let baselineText = "";
  let internalDispatch = false;
  let userEditedAfterInsert = false;
  let stopObserve: (() => void) | null = null;

  const onUpdate = (update: ViewUpdate) => {
    if (!update.docChanged || internalDispatch) return;
    if (!inserted) {
      modifiedBeforeInsert = true;
      return;
    }
    userEditedAfterInsert = true;
    const maxPos = update.state.doc.length;
    rangeFrom = Math.max(0, Math.min(maxPos, update.changes.mapPos(rangeFrom, -1)));
    rangeTo = Math.max(rangeFrom, Math.min(maxPos, update.changes.mapPos(rangeTo, 1)));
  };
  entry.updateListeners.add(onUpdate);

  const isAlive = () => codeMirrorRegistry.has(view) && dom.isConnected;

  const dispatchReplace = (from: number, to: number, text: string): boolean => {
    if (!isAlive()) return false;
    const maxPos = view.state.doc.length;
    const safeFrom = Math.max(0, Math.min(from, maxPos));
    const safeTo = Math.max(safeFrom, Math.min(to, maxPos));
    entry.onBeforeStep?.();
    internalDispatch = true;
    try {
      const endPos = safeFrom + text.length;
      view.dispatch({
        changes: { from: safeFrom, to: safeTo, insert: text },
        selection: { anchor: endPos },
      });
      inserted = true;
      rangeFrom = safeFrom;
      rangeTo = endPos;
      baselineText = text;
    } finally {
      internalDispatch = false;
    }
    return true;
  };

  return {
    kind: "codemirror",
    element: dom,
    isAlive,
    insert(text: string): boolean {
      if (!isAlive()) return false;
      const main = view.state.selection.main;
      const from = modifiedBeforeInsert ? main.from : initialFrom;
      const to = modifiedBeforeInsert ? main.to : initialTo;
      return dispatchReplace(from, to, text);
    },
    replace(text: string): boolean {
      if (!inserted || !isAlive()) return false;
      userEditedAfterInsert = false;
      return dispatchReplace(rangeFrom, rangeTo, text);
    },
    startEditObservation(onObservedEdit, timeoutMs = DEFAULT_EDIT_OBSERVE_MS) {
      stopObserve?.();
      if (!inserted) return () => undefined;
      userEditedAfterInsert = false;
      let fired = false;

      const finish = () => {
        if (fired) return;
        fired = true;
        cleanup();
        if (!userEditedAfterInsert || !isAlive()) return;
        const maxPos = view.state.doc.length;
        const safeFrom = Math.max(0, Math.min(rangeFrom, maxPos));
        const safeTo = Math.max(safeFrom, Math.min(rangeTo, maxPos));
        const editedText = view.state.doc.sliceString(safeFrom, safeTo);
        if (editedText !== baselineText && editedText.trim().length > 0 && baselineText.trim().length > 0) {
          onObservedEdit({ insertedText: baselineText, editedText });
        }
      };

      const onBlur = () => finish();
      const timer = globalThis.setTimeout(finish, timeoutMs);
      view.contentDOM.addEventListener("blur", onBlur, true);

      const cleanup = () => {
        globalThis.clearTimeout(timer);
        view.contentDOM.removeEventListener("blur", onBlur, true);
        if (stopObserve === cleanup) stopObserve = null;
      };
      stopObserve = cleanup;
      return cleanup;
    },
    getRect() {
      return isAlive() ? dom.getBoundingClientRect() : null;
    },
    dispose() {
      stopObserve?.();
      entry.updateListeners.delete(onUpdate);
    },
  };
}

// ---- Generic contenteditable fallback ----

function createContentEditableHandle(el: HTMLElement): EditableTargetHandle {
  const initialText = el.textContent ?? "";
  let insertedNode: Text | null = null;
  let baselineText = "";
  let stopObserve: (() => void) | null = null;

  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  const initialRange = sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer)
    ? sel.getRangeAt(0).cloneRange()
    : null;

  const isAlive = () => el.isConnected && el.isContentEditable;

  return {
    kind: "contenteditable",
    element: el,
    isAlive,
    insert(text: string): boolean {
      if (!isAlive()) return false;
      const modified = (el.textContent ?? "") !== initialText;
      const currentSel = window.getSelection();
      let range: Range | null = null;
      if (!modified && initialRange && el.contains(initialRange.commonAncestorContainer)) {
        range = initialRange.cloneRange();
      } else if (currentSel && currentSel.rangeCount > 0 && el.contains(currentSel.getRangeAt(0).commonAncestorContainer)) {
        range = currentSel.getRangeAt(0).cloneRange();
      }
      const node = document.createTextNode(text);
      if (range) {
        range.deleteContents();
        range.insertNode(node);
        range.setStartAfter(node);
        range.collapse(true);
        currentSel?.removeAllRanges();
        currentSel?.addRange(range);
      } else {
        el.appendChild(node);
      }
      insertedNode = node;
      baselineText = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    replace(text: string): boolean {
      if (!isAlive() || !insertedNode || !el.contains(insertedNode)) return false;
      insertedNode.data = text;
      baselineText = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    },
    startEditObservation(onObservedEdit, timeoutMs = DEFAULT_EDIT_OBSERVE_MS) {
      stopObserve?.();
      if (!insertedNode) return () => undefined;
      let userEdited = false;
      let fired = false;
      const finish = () => {
        if (fired) return;
        fired = true;
        cleanup();
        if (!userEdited || !insertedNode) return;
        const editedText = insertedNode.data;
        if (editedText !== baselineText && editedText.trim().length > 0 && baselineText.trim().length > 0) {
          onObservedEdit({ insertedText: baselineText, editedText });
        }
      };
      const onInput = () => { userEdited = true; };
      const onBlur = () => finish();
      const timer = globalThis.setTimeout(finish, timeoutMs);
      el.addEventListener("input", onInput);
      el.addEventListener("blur", onBlur, true);
      const cleanup = () => {
        globalThis.clearTimeout(timer);
        el.removeEventListener("input", onInput);
        el.removeEventListener("blur", onBlur, true);
        if (stopObserve === cleanup) stopObserve = null;
      };
      stopObserve = cleanup;
      return cleanup;
    },
    getRect() {
      return isAlive() ? el.getBoundingClientRect() : null;
    },
    dispose() {
      stopObserve?.();
    },
  };
}

/**
 * Captures the currently focused editable surface (or `preferredElement` when triggered from a surface's own button)
 * and returns a handle capable of inserting raw text, replacing it with polished/reverted text as a discrete undo step,
 * and observing 60-second user edits for automatic dictionary term learning.
 */
export function captureEditableTarget(preferredElement?: HTMLElement | null): EditableTargetHandle | null {
  const active = preferredElement ?? (typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  if (!active || active === document.body || active === document.documentElement) return null;

  for (const entry of tiptapRegistry) {
    const editor = entry.getEditor();
    if (!editor || editor.isDestroyed || !editor.isEditable) continue;
    const dom = getTiptapDom(editor);
    if (dom && (dom === active || dom.contains(active))) {
      return createTiptapHandle(entry, editor);
    }
  }

  for (const entry of codeMirrorRegistry.values()) {
    const dom = entry.view.dom;
    if (dom === active || dom.contains(active)) {
      return createCodeMirrorHandle(entry);
    }
  }

  if (isEditableInput(active)) {
    return createNativeHandle(active);
  }

  if (active.isContentEditable) {
    return createContentEditableHandle(active);
  }

  return null;
}
