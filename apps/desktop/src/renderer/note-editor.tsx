import { useCallback, useEffect, useRef, useState } from "react";
import { EditorContent, useEditor } from "@tiptap/react";
import Text from "@tiptap/extension-text";
import { type NoteBlock, type NoteDocument, NOTE_BLOCK_TYPES } from "@manga/contracts/reading";
import { EmbedHostContext, MangaEmbed } from "./embed/embed-node.tsx";
import { EmbedPicker } from "./embed/embed-picker.tsx";
import { MangaScreenshot, ScreenshotHostContext, ScreenshotPicker, type ScreenshotHost } from "./embed/screenshot-node.tsx";
import type { EmbedAttr, EmbedHost, EmbedItem } from "./embed/embed-types.ts";
import { isImeEvent } from "./lib/ime.ts";
import { MangaBlock, MangaDoc, blocksFromEditor, caretLocation, contentFrom, localStorageDrafts, type DraftStore } from "./note-schema.ts";
import { SourceEditor } from "./note-source-editor.tsx";
import { registerTiptapEditor } from "./voice/editable-target.ts";

export { blocksFromEditor, caretLocation, contentFrom, localStorageDrafts, type DraftStore };

/** How long consecutive keystrokes collapse into one undo step. */
const COALESCE_MS = 700;

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
  /** Present when the embeds module is on: what this note's embed blocks show, and how to open or switch on what they point at. */
  embeds?: {
    t: EmbedHost["t"];
    formatDate: EmbedHost["formatDate"];
    items: Record<string, EmbedItem>;
    onOpen: EmbedHost["onOpen"];
    onEnable: EmbedHost["onEnable"];
    onRefresh: EmbedHost["onRefresh"];
  };
  /** Present when the library is on: the note can hold screenshots, which open the video or the page they were taken from. */
  screenshots?: { t: ScreenshotHost["t"]; onOpen: ScreenshotHost["onOpen"] };
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
  const rootRef = useRef<HTMLElement>(null);
  const [blocks, setBlocks] = useState(props.document.blocks);
  // The open document already matches its stored revision, so the editor starts at "已保存" instead of
  // claiming there is unsaved work the moment a note is recorded or reopened.
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("saved");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(props.document.blocks[0]?.id ?? null);
  const [draftNotice, setDraftNotice] = useState<{ blocks: NoteBlock[]; savedAt: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const [picking, setPicking] = useState(false);
  const [pickingShot, setPickingShot] = useState(false);
  const [historyDepth, setHistoryDepth] = useState({ past: 0, future: 0 });
  const composing = useRef(false);
  const applying = useRef(false);
  const revision = useRef(props.revision);
  const timer = useRef<number | undefined>(undefined);
  const pending = useRef(props.document.blocks);
  const current = useRef(props.document.blocks);
  const draftOwner = useRef(props.objectId);
  const history = useRef<{ past: HistoryEntry[]; future: NoteBlock[][] }>({ past: [], future: [] });
  const breakNextHistory = useRef(false);
  const dirty = useRef(false);
  const inFlightPromise = useRef<Promise<void> | null>(null);
  const save = useRef(props.onSave);
  save.current = props.onSave;
  const metaRef = useRef({ drafts, title: props.title, tags: props.tags });
  metaRef.current = { drafts, title: props.title, tags: props.tags };
  const recordRef = useRef<(next: NoteBlock[], coalesceKey?: string, options?: { mirror?: boolean }) => void>(() => undefined);
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
    extensions: [MangaDoc, MangaBlock, MangaEmbed, MangaScreenshot, Text],
    content: contentFrom(props.document.blocks),
    editorProps: { attributes: { "data-testid": "note-surface" } },
    onUpdate: ({ editor: instance }) => {
      if (applying.current) return;
      const next = blocksFromEditor(instance);
      const caret = caretLocation(instance);
      // The change came from Tiptap, so it must not be written back into it.
      recordRef.current(next, caret ? `text:${caret.blockId}` : "text:doc", { mirror: false });
    },
  });

  useEffect(() => registerTiptapEditor(() => editor, {
    kind: "note",
    onBeforeStep: () => { breakNextHistory.current = true; },
  }), [editor]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    if (inFlightPromise.current) {
      await inFlightPromise.current;
      if (composing.current || !dirty.current) return;
    }
    if (composing.current || !dirty.current) return;
    const run = (async () => {
      while (dirty.current && !composing.current) {
        dirty.current = false;
        setState("saving");
        try {
          const savedRevision = await save.current(pending.current, revision.current);
          if (savedRevision !== undefined) revision.current = savedRevision;
          setConflict(false);
          if (!dirty.current) {
            metaRef.current.drafts.clear(draftOwner.current);
            setState("saved");
          }
        } catch (error) {
          dirty.current = true;
          setConflict(String((error as Error)?.message ?? "").includes("revision"));
          // The draft stays in storage so a failed save is never presented as saved.
          metaRef.current.drafts.write(draftOwner.current, { blocks: pending.current, title: metaRef.current.title, tags: metaRef.current.tags });
          setState("error");
          break;
        }
      }
    })();
    inFlightPromise.current = run;
    try {
      await run;
    } finally {
      if (inFlightPromise.current === run) inFlightPromise.current = null;
    }
  }, []);

  const schedule = useCallback((next: NoteBlock[]) => {
    pending.current = next;
    dirty.current = true;
    metaRef.current.drafts.write(draftOwner.current, { blocks: next, title: metaRef.current.title, tags: metaRef.current.tags });
    setState(composing.current ? "idle" : "saving");
    window.clearTimeout(timer.current);
    if (!composing.current) timer.current = window.setTimeout(() => { void flush(); }, 400);
  }, [flush]);

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
        recordRef.current(next, "text:ime", { mirror: false });
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

  // Closing the window or leaving the page flushes synchronously enough to keep the draft and await any in-flight/dirty save.
  useEffect(() => {
    const saveNow = async () => {
      if (dirty.current) metaRef.current.drafts.write(draftOwner.current, { blocks: pending.current, title: metaRef.current.title, tags: metaRef.current.tags });
      await flush();
    };
    const onUnload = () => { void saveNow(); };
    const onVisibility = () => { if (document.visibilityState === "hidden") void saveNow(); };
    window.addEventListener("beforeunload", onUnload);
    document.addEventListener("visibilitychange", onVisibility);
    const stopSaveNow = typeof window !== "undefined" ? window.manga?.onSaveNow?.(saveNow) : undefined;
    return () => {
      stopSaveNow?.();
      window.removeEventListener("beforeunload", onUnload);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flush]);

  /** Push the in-memory blocks into Tiptap, so a source edit and the rich view never diverge. */
  function applyToEditor(next: NoteBlock[]) {
    if (!editor || editor.isDestroyed) return;
    applying.current = true;
    // The whole document is replaced, so the caret is restored into the same block afterwards.
    const caretBlock = editor ? caretLocation(editor)?.blockId : undefined;
    editor.commands.setContent(contentFrom(next), { emitUpdate: false });
    if (caretBlock) {
      let target: number | null = null;
      editor.state.doc.forEach((node, pos) => {
        if (String(node.attrs.blockId ?? "") === caretBlock && target === null) target = pos + 1;
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
    const forceBreak = breakNextHistory.current;
    breakNextHistory.current = false;
    const effectiveKey = forceBreak ? undefined : coalesceKey;
    const top = history.current.past[history.current.past.length - 1];
    const now = Date.now();
    const coalesce = Boolean(!forceBreak && effectiveKey && top && top.coalesceKey === effectiveKey && now - top.at < COALESCE_MS);
    if (!coalesce) history.current.past.push({ blocks: previous, coalesceKey: effectiveKey, at: now });
    else top!.at = now;
    if (history.current.past.length > 200) history.current.past.shift();
    history.current.future = [];
    current.current = next;
    setBlocks(next);
    setHistoryDepth({ past: history.current.past.length, future: 0 });
    if (options.mirror !== false) applyToEditor(next);
    schedule(next);
  }
  recordRef.current = record;

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
    const esc = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(props.focusBlockId) : props.focusBlockId.replace(/["\\]/g, "\\$&");
    const target = rootRef.current?.querySelector(`[data-testid="block-${esc}"]`);
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

  /** An embed block is put in, taken out or changed whole; it has no text to type into, split or merge. */
  const isEmbedAt = (index: number) => blocks[index]?.type === "embed" || blocks[index]?.type === "screenshot";

  function insertScreenshot(screenshotId: string) {
    const index = activeIndex();
    const next = [...blocks];
    const created: NoteBlock = { id: `b_${crypto.randomUUID().slice(0, 8)}`, type: "screenshot", text: "", attrs: { screenshotId } };
    next.splice(index + 1, 0, created);
    setPickingShot(false);
    record(next);
    setSelectedId(created.id);
  }

  function insertEmbed(embed: EmbedAttr) {
    const index = activeIndex();
    const next = [...blocks];
    const created: NoteBlock = { id: `b_${crypto.randomUUID().slice(0, 8)}`, type: "embed", text: "", attrs: { embed } };
    next.splice(index + 1, 0, created);
    setPicking(false);
    record(next);
    setSelectedId(created.id);
  }

  function removeEmbed(blockId: string) {
    const next = current.current.filter((block) => block.id !== blockId);
    // A note always keeps at least one block to type into.
    record(next.length ? next : [{ id: `b_${crypto.randomUUID().slice(0, 8)}`, type: "paragraph", text: "" }]);
  }

  /** The target is gone: what the embed showed stays as an ordinary quote block, and the embed itself is dropped. */
  function keepSnapshot(blockId: string, item: EmbedItem) {
    const text = item.summary ? `${item.title}：${item.summary}` : item.title;
    record(current.current.map((block) => block.id === blockId ? { id: block.id, type: "quote", text } : block));
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
    if (!block || !following || isEmbedAt(index) || isEmbedAt(index + 1)) return;
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
    if (isEmbedAt(index)) return;
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

  const screenshotHost: ScreenshotHost | null = props.screenshots ? { t: props.screenshots.t, onOpen: props.screenshots.onOpen, onRemove: removeEmbed } : null;
  const embedHost: EmbedHost | null = props.embeds ? {
    t: props.embeds.t, formatDate: props.embeds.formatDate, items: props.embeds.items,
    onOpen: props.embeds.onOpen, onEnable: props.embeds.onEnable, onRefresh: props.embeds.onRefresh,
    onRemove: removeEmbed, onKeepSnapshot: keepSnapshot,
  } : null;
  const source = blocks.find((block) => block.id === sourceId);
  const blockLabel = (type: string) => type === "heading" ? props.labels.typeHeading
    : type === "list" ? props.labels.typeList
      : type === "quote" ? props.labels.typeQuote
        : type === "code" ? props.labels.typeCode
          : type === "plaintext" ? props.labels.typePlain
            : props.labels.typeParagraph;

  return (
    <section
      ref={rootRef}
      data-testid="note-editor"
      data-save-state={state}
      data-conflict={conflict ? "true" : "false"}
      // One shared undo stack for both views, so the same shortcut works wherever the caret is.
      onKeyDown={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || isImeEvent(event, composing.current)) return;
        if (document.querySelector('[role="dialog"]')) return;
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
        <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-source-toggle" onMouseDown={(event) => event.preventDefault()} onClick={() => setSourceId(sourceId || isEmbedAt(activeIndex()) ? null : blocks[activeIndex()]?.id ?? null)}>{props.labels.sourceEdit}</button>
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
        {props.embeds ? <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-insert-embed" onMouseDown={(event) => event.preventDefault()} onClick={() => setPicking(true)}>{props.embeds.t("embed.insert")}</button> : null}
        {props.screenshots ? <button type="button" className="border px-2 py-0.5 rounded" data-testid="note-insert-screenshot" onMouseDown={(event) => event.preventDefault()} onClick={() => setPickingShot(true)}>{props.screenshots.t("screenshot.block.insert")}</button> : null}
        <span className="mx-1" />
        {NOTE_BLOCK_TYPES.map((type) => (
          <button key={`set-${type}`} type="button" className="border px-2 py-0.5 rounded" data-testid={`note-set-${type}`} onMouseDown={(event) => event.preventDefault()} onClick={() => setBlockType(type)}>{`→${blockLabel(type)}`}</button>
        ))}
      </div>
      <EmbedHostContext.Provider value={embedHost}>
        <ScreenshotHostContext.Provider value={screenshotHost}>
          <EditorContent editor={editor} />
        </ScreenshotHostContext.Provider>
      </EmbedHostContext.Provider>
      {pickingShot && props.screenshots ? <ScreenshotPicker t={props.screenshots.t} onPick={insertScreenshot} onClose={() => setPickingShot(false)} /> : null}
      {picking && props.embeds ? <EmbedPicker t={props.embeds.t} noteId={props.objectId} onPick={insertEmbed} onClose={() => setPicking(false)} /> : null}
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
          onBeforeStep={() => { breakNextHistory.current = true; }}
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
