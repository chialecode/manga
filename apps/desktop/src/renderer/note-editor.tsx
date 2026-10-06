import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import Document from "@tiptap/extension-document";
import Text from "@tiptap/extension-text";
import { Node, mergeAttributes } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap } from "@codemirror/commands";
import { type NoteBlock, type NoteDocument, NOTE_BLOCK_TYPES } from "@manga/contracts/reading";
import { uniqueBlockIds } from "../../../../packages/app-core/src/domain/note-document.ts";

/** How long consecutive keystrokes collapse into one undo step. */
const COALESCE_MS = 700;

const MangaDoc = Document.extend({
  content: "mangaBlock+",
  addProseMirrorPlugins() {
    return [new Plugin({
      appendTransaction(transactions, _old, state) {
        if (!transactions.some((transaction) => transaction.docChanged)) return null;
        const seen = new Set<string>();
        const tr = state.tr;
        state.doc.forEach((node, pos) => {
          const original = node.attrs.blockId as string;
          const duplicate = !original || seen.has(original);
          const blockId = duplicate ? `b_${crypto.randomUUID()}` : original;
          seen.add(blockId);
          if (duplicate) tr.setNodeMarkup(pos, undefined, { ...node.attrs, blockId, anchorId: null });
        });
        return tr.docChanged ? tr : null;
      },
    })];
  },
});

const MangaBlock = Node.create({
  name: "mangaBlock",
  group: "block",
  content: "text*",
  defining: true,
  addAttributes() {
    return {
      blockId: { default: "b1" },
      blockType: { default: "paragraph" },
      level: { default: null },
      ordered: { default: null },
      anchorId: { default: null },
      // Payload written by a newer editor build; kept verbatim instead of being dropped on the round trip.
      noteAttrs: { default: null },
    };
  },
  parseHTML: () => [{ tag: "div[data-block-id]" }],
  renderHTML: ({ HTMLAttributes }) => ["div", mergeAttributes(HTMLAttributes, {
    "data-block-id": HTMLAttributes.blockId,
    "data-block-type": HTMLAttributes.blockType,
    // Heading level and list style are visible in the editor, not just stored attributes.
    "data-level": HTMLAttributes.level ?? undefined,
    "data-ordered": HTMLAttributes.ordered ? "true" : undefined,
    "data-testid": `block-${HTMLAttributes.blockId}`,
  }), 0],
  addKeyboardShortcuts() {
    return { Enter: () => this.editor.view.composing ? false : this.editor.commands.splitBlock() };
  },
});

export function contentFrom(blocks: NoteBlock[]) {
  return {
    type: "doc",
    content: blocks.map((block) => ({
      type: "mangaBlock",
      attrs: { blockId: block.id, blockType: block.type, level: block.level, ordered: block.ordered, anchorId: block.anchorId, noteAttrs: block.attrs ?? null },
      content: block.text ? [{ type: "text", text: block.text }] : [],
    })),
  };
}

export function blocksFromEditor(editor: NonNullable<ReturnType<typeof useEditor>>): NoteBlock[] {
  const raw: NoteBlock[] = [];
  editor.state.doc.forEach((node) => {
    if (node.type.name !== "mangaBlock") return;
    raw.push({
      id: String(node.attrs.blockId ?? ""),
      type: String(node.attrs.blockType ?? "paragraph"),
      text: node.textContent,
      ...(node.attrs.level != null ? { level: node.attrs.level } : {}),
      ...(node.attrs.ordered != null ? { ordered: node.attrs.ordered } : {}),
      ...(node.attrs.anchorId != null ? { anchorId: node.attrs.anchorId } : {}),
      ...(node.attrs.noteAttrs ? { attrs: node.attrs.noteAttrs as Record<string, unknown> } : {}),
    });
  });
  const ids = uniqueBlockIds(raw.map((block) => block.id), () => `b_${crypto.randomUUID().slice(0, 8)}`);
  return raw.map((block, index) => ({ ...block, id: ids[index] ?? block.id }));
}

/** Where the caret currently sits, as a block id plus a code-point offset inside it. */
export function caretLocation(editor: NonNullable<ReturnType<typeof useEditor>>): { blockId: string; offset: number; index: number } | null {
  const { from } = editor.state.selection;
  let found: { blockId: string; offset: number; index: number } | null = null;
  let index = 0;
  editor.state.doc.forEach((node, pos) => {
    const start = pos + 1;
    const end = start + node.content.size;
    if (from >= start && from <= end && !found) {
      found = { blockId: String(node.attrs.blockId ?? ""), offset: codePoints(editor.state.doc.textBetween(start, from, "\n", "\n")), index };
    }
    index += 1;
  });
  return found;
}

function codePoints(text: string): number {
  return [...text].length;
}

/** The unsaved draft is kept per note so leaving the page or closing the window cannot lose it. */
function draftKey(objectId: string): string {
  return `manga.note.draft.${objectId}`;
}

export type DraftStore = {
  read(objectId: string): { blocks: NoteBlock[]; title?: string; tags?: string[]; savedAt: string } | null;
  write(objectId: string, draft: { blocks: NoteBlock[]; title?: string; tags?: string[] }): void;
  clear(objectId: string): void;
};

export const localStorageDrafts: DraftStore = {
  read(objectId) {
    try {
      const raw = window.localStorage.getItem(draftKey(objectId));
      return raw ? JSON.parse(raw) as { blocks: NoteBlock[]; savedAt: string } : null;
    } catch {
      return null;
    }
  },
  write(objectId, draft) {
    try {
      window.localStorage.setItem(draftKey(objectId), JSON.stringify({ ...draft, savedAt: new Date().toISOString() }));
    } catch {
      // A full or unavailable store must not break editing; the in-memory state stays authoritative.
    }
  },
  clear(objectId) {
    try {
      window.localStorage.removeItem(draftKey(objectId));
    } catch {
      // ignore
    }
  },
};

type HistoryEntry = { blocks: NoteBlock[]; coalesceKey?: string; at: number };

export function NoteEditor(props: {
  objectId: string;
  document: NoteDocument;
  revision: number;
  title: string;
  tags: string[];
  saveLabel: string;
  savingLabel: string;
  savedLabel: string;
  failedLabel: string;
  splitLabel: string;
  sourceLabel: string;
  labels: {
    blockInsert: string;
    blockRemove: string;
    blockMoveUp: string;
    blockMoveDown: string;
    blockCopy: string;
    blockMerge: string;
    blockType: string;
    typeParagraph: string;
    typeHeading: string;
    typeList: string;
    typeQuote: string;
    typeCode: string;
    typePlain: string;
    draftRestored: string;
    draftDiscard: string;
    conflict: string;
    sourceStale: string;
    repairSource: string;
    undo: string;
    redo: string;
    undoHint: string;
    sourceEdit: string;
    openSource?: string;
  };
  drafts?: DraftStore;
  /** Set when the note's stored source no longer resolves, so the UI can offer the repair entry. */
  sourceStale?: boolean;
  /** Block the reader returned to, so the editor scrolls it into view instead of opening at the top. */
  focusBlockId?: string;
  onSave: (blocks: NoteBlock[], expectedRevision: number) => Promise<number | void>;
  onOpenSource?: (blockId: string) => void;
  onSourceStale?: () => void;
  onDraftRestored?: (blocks: NoteBlock[]) => void;
}) {
  const drafts = props.drafts ?? localStorageDrafts;
  const [blocks, setBlocks] = useState(props.document.blocks);
  // The open document already matches its stored revision, so the editor starts at "已保存" instead of
  // claiming there is unsaved work the moment a note is recorded or reopened.
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("saved");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(props.document.blocks[0]?.id ?? null);
  const [draftNotice, setDraftNotice] = useState<{ blocks: NoteBlock[]; savedAt: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [historyDepth, setHistoryDepth] = useState({ past: 0, future: 0 });
  const composing = useRef(false);
  const applying = useRef(false);
  const revision = useRef(props.revision);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef(props.document.blocks);
  const current = useRef(props.document.blocks);
  const draftOwner = useRef(props.objectId);
  const history = useRef<{ past: HistoryEntry[]; future: NoteBlock[][] }>({ past: [], future: [] });
  const dirty = useRef(false);
  const inFlight = useRef(false);
  const save = useRef(props.onSave);
  save.current = props.onSave;
  const initialised = useRef(false);
  useEffect(() => { revision.current = props.revision; }, [props.revision]);

  /** Drafts are only offered while the stored revision is the one the draft was written against. */
  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;
    const stored = drafts.read(props.objectId);
    if (stored?.blocks?.length && JSON.stringify(stored.blocks) !== JSON.stringify(props.document.blocks)) {
      setDraftNotice({ blocks: stored.blocks, savedAt: stored.savedAt });
    } else if (stored) {
      drafts.clear(props.objectId);
    }
  }, [drafts, props.document.blocks, props.objectId]);

  const editor = useEditor({
    // History is kept at document level so both views share one stack; see pushHistory/undo/redo.
    extensions: [MangaDoc, MangaBlock, Text],
    content: contentFrom(props.document.blocks),
    editorProps: { attributes: { "data-testid": "note-surface" } },
    onUpdate: ({ editor: instance }) => {
      if (applying.current) return;
      const next = blocksFromEditor(instance);
      const caret = caretLocation(instance);
      // The change came from Tiptap, so it must not be written back into it.
      record(next, caret ? `text:${caret.blockId}` : "text:doc", { mirror: false });
    },
  });

  const schedule = useCallback((next: NoteBlock[]) => {
    pending.current = next;
    dirty.current = true;
    drafts.write(draftOwner.current, { blocks: next, title: props.title, tags: props.tags });
    setState(composing.current ? "idle" : "saving");
    window.clearTimeout(timer.current);
    if (!composing.current) timer.current = window.setTimeout(() => { void flush(); }, 400);
  }, [drafts, props.tags, props.title]);

  const flush = useCallback(async () => {
    if (inFlight.current || composing.current || !dirty.current) return;
    inFlight.current = true;
    dirty.current = false;
    setState("saving");
    try {
      const savedRevision = await save.current(pending.current, revision.current);
      if (savedRevision !== undefined) revision.current = savedRevision;
      inFlight.current = false;
      setConflict(false);
      if (dirty.current) {
        // This receipt only commits the older buffer. Keep the later draft durable even if
        // composition prevents the next save, or the window exits before its receipt arrives.
        if (!composing.current) void flush();
      } else {
        drafts.clear(draftOwner.current);
        setState("saved");
      }
    } catch (error) {
      inFlight.current = false;
      dirty.current = true;
      setConflict(String((error as Error)?.message ?? "").includes("revision"));
      // The draft stays in storage so a failed save is never presented as saved.
      drafts.write(draftOwner.current, { blocks: pending.current, title: props.title, tags: props.tags });
      setState("error");
    }
  }, [drafts, props.tags, props.title]);

  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    const start = () => { composing.current = true; setState("idle"); window.clearTimeout(timer.current); };
    const end = () => {
      composing.current = false;
      // Some IMEs commit before compositionend and emit no later input event.
      queueMicrotask(() => {
        if (!editor || editor.isDestroyed) return;
        const next = blocksFromEditor(editor);
        if (JSON.stringify(next) === JSON.stringify(current.current)) {
          // Nothing new since the last keystroke, but the committed text still has to be saved.
          if (dirty.current) schedule(next);
          return;
        }
        record(next, "text:ime", { mirror: false });
      });
    };
    dom.addEventListener("compositionstart", start);
    dom.addEventListener("compositionend", end);
    return () => {
      dom.removeEventListener("compositionstart", start);
      dom.removeEventListener("compositionend", end);
      window.clearTimeout(timer.current);
      void flush();
    };
  }, [editor, flush, schedule]);

  // Closing the window or leaving the page flushes synchronously enough to keep the draft and try a save.
  useEffect(() => {
    const onHide = () => {
      if (dirty.current) drafts.write(draftOwner.current, { blocks: pending.current, title: props.title, tags: props.tags });
      void flush();
    };
    window.addEventListener("beforeunload", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      document.removeEventListener("visibilitychange", onHide);
    };
  }, [drafts, flush, props.tags, props.title]);

  /** Push the in-memory blocks into Tiptap, so a source edit and the rich view never diverge. */
  function applyToEditor(next: NoteBlock[]) {
    if (!editor || editor.isDestroyed) return;
    applying.current = true;
    // The whole document is replaced, so the caret is restored into the same block afterwards.
    const caretBlock = editor ? caretLocation(editor)?.blockId : undefined;
    editor.commands.setContent(contentFrom(next), { emitUpdate: false });
    if (caretBlock) {
      let index = 0;
      let target: number | null = null;
      editor.state.doc.forEach((node, pos) => {
        if (String(node.attrs.blockId ?? "") === caretBlock && target === null) target = pos + 1;
        index += 1;
      });
      if (target !== null) editor.commands.setTextSelection(Math.min(target, editor.state.doc.content.size));
    }
    applying.current = false;
  }

  /**
   * One authoritative change path for both views: it records undo history, updates the block list and
   * mirrors the result into Tiptap. Consecutive typing on the same block collapses into one step.
   */
  function record(next: NoteBlock[], coalesceKey?: string, options: { mirror?: boolean } = {}) {
    const previous = current.current;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    const top = history.current.past[history.current.past.length - 1];
    const now = Date.now();
    const coalesce = Boolean(coalesceKey && top && top.coalesceKey === coalesceKey && now - top.at < COALESCE_MS);
    if (!coalesce) history.current.past.push({ blocks: previous, coalesceKey, at: now });
    else top!.at = now;
    if (history.current.past.length > 200) history.current.past.shift();
    history.current.future = [];
    current.current = next;
    setBlocks(next);
    setHistoryDepth({ past: history.current.past.length, future: 0 });
    if (options.mirror !== false) applyToEditor(next);
    schedule(next);
  }

  function undo() {
    const entry = history.current.past.pop();
    if (!entry) return;
    history.current.future.push(current.current);
    current.current = entry.blocks;
    pending.current = entry.blocks;
    setBlocks(entry.blocks);
    setHistoryDepth({ past: history.current.past.length, future: history.current.future.length });
    applyToEditor(entry.blocks);
    schedule(entry.blocks);
  }

  function redo() {
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push({ blocks: current.current, at: Date.now() });
    current.current = next;
    setBlocks(next);
    setHistoryDepth({ past: history.current.past.length, future: history.current.future.length });
    applyToEditor(next);
    schedule(next);
  }

  // Returning from a source jump lands on the block the note was opened from.
  useEffect(() => {
    if (!props.focusBlockId) return;
    const target = document.querySelector(`[data-testid='block-${props.focusBlockId}']`);
    target?.scrollIntoView({ block: "center" });
  }, [props.focusBlockId, props.objectId]);

  /** Toolbar operations act on the block the user is actually editing: source panel first, then caret. */
  function activeIndex(): number {
    if (sourceId) {
      const index = blocks.findIndex((block) => block.id === sourceId);
      if (index >= 0) return index;
    }
    const location = editor ? caretLocation(editor) : null;
    const fromCaret = location ? blocks.findIndex((block) => block.id === location.blockId) : -1;
    if (fromCaret >= 0) return fromCaret;
    const fromSelected = blocks.findIndex((block) => block.id === selectedId);
    return fromSelected < 0 ? 0 : fromSelected;
  }

  function splitAtCursor() {
    if (composing.current || editor?.view.composing) return;
    const index = activeIndex();
    const block = blocks[index];
    if (!block) return;
    const offset = sourceId === block.id
      ? [...block.text].length
      : editor ? caretLocation(editor)?.offset ?? [...block.text].length : [...block.text].length;
    if (offset <= 0 || offset >= [...block.text].length) {
      if (sourceId === block.id) return;
      editor?.chain().focus().splitBlock().run();
      return;
    }
    // Split at the caret offset inside the block, keeping the block and anchor identity of the first half.
    const text = [...block.text];
    const created: NoteBlock = { id: `b_${crypto.randomUUID().slice(0, 8)}`, type: block.type, text: text.slice(offset).join("") };
    const next = blocks.map((item, position) => position === index ? { ...item, text: text.slice(0, offset).join("") } : item);
    next.splice(index + 1, 0, created);
    record(next);
    setSelectedId(created.id);
  }

  function insertBlock(type: string) {
    const index = activeIndex();
    const next = [...blocks];
    next.splice(index + 1, 0, { id: `b_${crypto.randomUUID().slice(0, 8)}`, type, text: "", ...(type === "heading" ? { level: 2 } : {}) });
    record(next);
  }

  function removeBlock() {
    if (blocks.length <= 1) return;
    const index = activeIndex();
    const removed = blocks[index];
    const next = blocks.filter((_, position) => position !== index);
    if (removed && sourceId === removed.id) setSourceId(null);
    record(next);
  }

  /** Merging keeps the first block's identity (and its source anchor) and drops the second one. */
  function mergeBlock() {
    const index = activeIndex();
    const following = blocks[index + 1];
    const block = blocks[index];
    if (!block || !following) return;
    const next = blocks
      .map((item, position) => position === index ? { ...item, text: item.text + following.text } : item)
      .filter((_, position) => position !== index + 1);
    if (sourceId === following.id) setSourceId(block.id);
    record(next);
  }

  function moveBlock(direction: -1 | 1) {
    const index = activeIndex();
    const target = index + direction;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    record(next);
  }

  function copyBlock() {
    const index = activeIndex();
    const source = blocks[index];
    if (!source) return;
    // A copy is a new block with a new identity and no inherited source anchor.
    const next = [...blocks];
    next.splice(index + 1, 0, { ...source, id: `b_${crypto.randomUUID().slice(0, 8)}`, anchorId: undefined });
    record(next);
  }

  function setBlockType(type: string) {
    const index = activeIndex();
    const next = blocks.map((block, position) => {
      if (position !== index) return block;
      const updated: NoteBlock = { ...block, type };
      if (type === "heading") updated.level = block.level ?? 2;
      else delete updated.level;
      if (type === "list") updated.ordered = block.ordered ?? false;
      else delete updated.ordered;
      return updated;
    });
    record(next);
  }

  function restoreDraft() {
    if (!draftNotice) return;
    pending.current = draftNotice.blocks;
    dirty.current = true;
    record(draftNotice.blocks);
    props.onDraftRestored?.(draftNotice.blocks);
    setDraftNotice(null);
    void flush();
  }

  function discardDraft() {
    drafts.clear(props.objectId);
    setDraftNotice(null);
  }

  const source = blocks.find((block) => block.id === sourceId);
  const blockLabel = (type: string) => type === "heading" ? props.labels.typeHeading
    : type === "list" ? props.labels.typeList
      : type === "quote" ? props.labels.typeQuote
        : type === "code" ? props.labels.typeCode
          : type === "plaintext" ? props.labels.typePlain
            : props.labels.typeParagraph;

  return (
    <section
      data-testid="note-editor"
      data-save-state={state}
      data-conflict={conflict ? "true" : "false"}
      // One shared undo stack for both views, so the same shortcut works wherever the caret is.
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || composing.current) return;
        const pressed = event.key.toLowerCase();
        if (pressed === "z" && !event.shiftKey) { event.preventDefault(); undo(); }
        else if (pressed === "y" || (pressed === "z" && event.shiftKey)) { event.preventDefault(); redo(); }
      }}
    >
      <div className="flex gap-2 mb-2 text-sm flex-wrap items-center">
        <span>{state === "saving" ? props.savingLabel : state === "saved" ? props.savedLabel : state === "error" ? props.failedLabel : props.saveLabel}</span>
        <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-undo" onMouseDown={(event) => event.preventDefault()} onClick={undo} disabled={!historyDepth.past} title={props.labels.undoHint}>{props.labels.undo}</button>
        <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-redo" onMouseDown={(event) => event.preventDefault()} onClick={redo} disabled={!historyDepth.future}>{props.labels.redo}</button>
        <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-split" onMouseDown={(event) => event.preventDefault()} onClick={splitAtCursor}>{props.splitLabel}</button>
        <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-block-merge" onMouseDown={(event) => event.preventDefault()} onClick={mergeBlock} disabled={blocks.length <= 1}>{props.labels.blockMerge}</button>
        <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-block-remove" onMouseDown={(event) => event.preventDefault()} onClick={removeBlock} disabled={blocks.length <= 1}>{props.labels.blockRemove}</button>
        <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-block-up" onMouseDown={(event) => event.preventDefault()} onClick={() => moveBlock(-1)}>{props.labels.blockMoveUp}</button>
        <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-block-down" onMouseDown={(event) => event.preventDefault()} onClick={() => moveBlock(1)}>{props.labels.blockMoveDown}</button>
        <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-block-copy" onMouseDown={(event) => event.preventDefault()} onClick={copyBlock}>{props.labels.blockCopy}</button>
        <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-source-toggle" onMouseDown={(event) => event.preventDefault()} onClick={() => setSourceId(sourceId ? null : blocks[activeIndex()]?.id ?? null)}>{props.labels.sourceEdit}</button>
        {state === "error" ? <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-retry-save" onClick={() => void flush()}>{props.saveLabel}</button> : null}
      </div>
      {conflict ? <p role="alert" className="text-sm mb-2" data-testid="note-conflict">{props.labels.conflict}</p> : null}
      {draftNotice ? (
        <div role="status" className="border border-[var(--color-border)] rounded p-2 mb-2 text-sm" data-testid="note-draft-notice">
          <p>{props.labels.draftRestored} · {draftNotice.savedAt}</p>
          <div className="flex gap-2 mt-1">
            <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-draft-restore" onClick={restoreDraft}>{props.labels.draftRestored}</button>
            <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-draft-discard" onClick={discardDraft}>{props.labels.draftDiscard}</button>
          </div>
        </div>
      ) : null}
      {props.sourceStale ? (
        <p className="text-sm text-[var(--color-subtle)]" data-testid="note-source-stale">
          {props.labels.sourceStale}
          {props.onSourceStale || props.onOpenSource ? <button type="button" className="border px-2 py-0.5 rounded ml-2" data-testid="note-source-repair" onClick={() => {
            const active = blocks[activeIndex()];
            if (active?.anchorId && props.onOpenSource) props.onOpenSource(active.id);
            else props.onSourceStale?.();
          }}>{props.labels.repairSource}</button> : null}
        </p>
      ) : null}
      <div className="flex gap-1 mb-2 flex-wrap text-sm" role="group" aria-label={props.labels.blockType} data-testid="note-block-toolbar">
        {NOTE_BLOCK_TYPES.map((type) => (
          <button key={type} type="button" className="border px-2 py-0.5 rounded" data-testid={`note-insert-${type}`} onMouseDown={(event) => event.preventDefault()} onClick={() => insertBlock(type)}>{blockLabel(type)}</button>
        ))}
        <span className="mx-1" />
        {NOTE_BLOCK_TYPES.map((type) => (
          <button key={`set-${type}`} type="button" className="border px-2 py-0.5 rounded" data-testid={`note-set-${type}`} onMouseDown={(event) => event.preventDefault()} onClick={() => setBlockType(type)}>{`→${blockLabel(type)}`}</button>
        ))}
      </div>
      <EditorContent editor={editor} />
      {props.onOpenSource ? (
        <ul className="mt-2 flex flex-wrap gap-2 text-sm">
          {blocks.filter((block) => block.anchorId).map((block) => (
            <li key={`source-${block.id}`}>
              <button type="button" className="border px-2 py-0.5 rounded" data-testid={`note-block-source-${block.id}`} onMouseDown={(event) => event.preventDefault()} onClick={() => props.onOpenSource?.(block.id)}>{props.labels.openSource ?? props.labels.sourceEdit}</button>
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="mt-2 flex flex-wrap gap-2 text-sm">
        {blocks.filter((block) => block.type === "code" || block.type === "plaintext").map((block) => (
          <li key={block.id}>
            <button type="button" className="border px-2 py-0.5 rounded" data-testid={`source-${block.id}`} onClick={() => setSourceId(block.id)}>{props.sourceLabel}</button>
          </li>
        ))}
      </ul>
      {source ? (
        <SourceEditor
          blockId={source.id}
          text={source.text}
          onChange={(text) => {
            // Source edits go through the same authoritative path, so the rich view cannot overwrite them.
            const next = current.current.map((block) => block.id === source.id ? { ...block, text } : block);
            record(next, `text:${source.id}`);
          }}
          onComposition={(active) => {
            composing.current = active;
            if (active) { setState("idle"); window.clearTimeout(timer.current); return; }
            // The committed source text must still be saved even if no later input event arrives.
            queueMicrotask(() => { if (!composing.current && dirty.current) schedule(pending.current); });
          }}
        />
      ) : null}
    </section>
  );
}

function SourceEditor(props: { blockId: string; text: string; onChange: (text: string) => void; onComposition: (active: boolean) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const onChange = useRef(props.onChange);
  const onComposition = useRef(props.onComposition);
  onChange.current = props.onChange;
  onComposition.current = props.onComposition;
  const view = useRef<EditorView | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const created = new EditorView({
      state: EditorState.create({
        doc: props.text,
        // Undo stays on the shared document history, so CodeMirror gets no history of its own.
        extensions: [
          keymap.of([...defaultKeymap]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange.current(update.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            compositionstart: () => { onComposition.current(true); return false; },
            compositionend: () => { onComposition.current(false); return false; },
          }),
        ],
      }),
      parent: host.current,
    });
    view.current = created;
    return () => { created.destroy(); view.current = null; };
    // The view is rebuilt per block so an external change never writes into another block's buffer.
  }, [props.blockId]);
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    if (instance.state.doc.toString() !== props.text) {
      instance.dispatch({ changes: { from: 0, to: instance.state.doc.length, insert: props.text } });
    }
  }, [props.text]);
  return <div ref={host} data-testid="note-source" data-block-id={props.blockId} className="mt-2 border border-[var(--color-border)] rounded" />;
}
