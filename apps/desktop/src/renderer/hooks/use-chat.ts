import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StreamAgent } from "@manga/contracts";
import type { Translator } from "@manga/i18n";
import type { QuickTask } from "@manga/contracts/quick-tasks";
import { asArray, attempt, call, messageOf } from "../lib/api.ts";
import { anchorFromContext, anchorFromTag, intervalLabel, noteTitleOf, quickPageFor, quickValues, renderQuick } from "../lib/chat-model.ts";
import { quoteTags, useQuoteTags, type QuoteTag } from "../lib/quote-tags.ts";
import { autoAddMaterial } from "../lib/materials.ts";
import { mediaContextFor, readerContext, useReaderContext, type ReaderContext } from "../lib/reader-context.ts";
import type { AttachedImage, ComposerState } from "../lib/types.ts";
import type { ChatMode } from "../components/chat/composer.tsx";
import { collectSources } from "../components/chat/citations.tsx";
import { useSessionStream } from "./use-session-stream.ts";

const MODE_KEY = "manga.chat.mode";
const readMode = (): ChatMode => {
  try { return window.localStorage.getItem(MODE_KEY) === "ask" ? "ask" : "note"; } catch { return "note"; }
};
const writeMode = (mode: ChatMode) => { try { window.localStorage.setItem(MODE_KEY, mode); } catch { /* the choice just is not remembered */ } };

/** Which target the pane is talking about: the open resource, a work page, or the chat page with none. */
export type ChatTarget = {
  /** The session whose messages are shown and which a send is bound to. */
  sessionId: string | undefined;
  resourceId?: string;
  revisionId?: string;
  workId?: string | null;
  title?: string;
};

export type ChatDeps = {
  i18n: Translator;
  page: string;
  target: ChatTarget;
  composer: ComposerState;
  /** Optional isolated draft reader so typing does not re-render `useChat`. */
  getDraft?: () => string;
  draftKey?: string;
  patchComposer: (patch: Partial<ComposerState>) => void;
  updateComposer: (patch: (current: ComposerState) => Partial<ComposerState>) => void;
  /** The Agent's send: the same function the page used before the pane became a chat. */
  sendAgent: (input: { text: string; attach?: "page" | "frame"; library?: boolean; quickTask?: { id: string | null; name: string }; tags: readonly QuoteTag[] }) => Promise<boolean>;
  /** A session for notes made where no session exists yet (a work page, a note without a reader). */
  ensureTargetSession: () => Promise<string | undefined>;
  running: boolean;
  version: number;
  bump: () => void;
  setError: (message?: string) => void;
  setNotice: (message?: string) => void;
  workTitle?: string | null;
  author?: string | null;
  prepareImage: (live: ReaderContext) => Promise<AttachedImage | null>;
  /** The context the pane is in: a note written there becomes a material of the project. */
  contextId: string | null;
  onTitle?: (title: string) => void;
};

/**
 * What the right pane and the chat page do beyond showing messages (A-48): the note or ask choice, writing a note anchored at the
 * picked tag or at the place the reader is, the quick tasks for the page, and editing, deleting and quoting a note bubble. The Agent
 * side is the existing `sendAgent` of the shell; a note never goes through it, so a missing model cannot stop a note.
 */
export function useChat(deps: ChatDeps) {
  const { i18n, page, target, composer } = deps;
  const t = i18n.t;
  const [stored, setModeState] = useState<ChatMode>(readMode);
  // A note belongs to the place it is written about: the open resource, or the work on its own page. Where there is neither (the chat page,
  // the library) a note would have nowhere to show, so the input only asks the Agent there and the remembered choice is left alone.
  const noteable = Boolean(target.resourceId || target.workId);
  const mode: ChatMode = noteable ? stored : "ask";
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [scrollSignal, setScrollSignal] = useState(0);
  const [quickTasks, setQuickTasks] = useState<QuickTask[]>([]);
  const context = useReaderContext();
  const tags = useQuoteTags(target.resourceId);
  const stream = useSessionStream(target.sessionId, { version: deps.version, running: deps.running, onTitle: deps.onTitle });
  const setMode = useCallback((next: ChatMode) => { if (!noteable) return; setModeState(next); writeMode(next); }, [noteable]);

  const readDraft = () => (deps.getDraft ? deps.getDraft() : composer.draft);

  // Quick tasks come from settings, for this page; the list is read again when settings change it.
  const quickPage = quickPageFor(page);
  useEffect(() => {
    let cancelled = false;
    void attempt<{ tasks?: QuickTask[] }>("quickTasks.list", { page: quickPage }).then((result) => {
      if (!cancelled) setQuickTasks(result.ok ? asArray<QuickTask>(result.value.tasks) : []);
    });
    return () => { cancelled = true; };
  }, [quickPage, deps.version]);

  const quickValuesNow = useCallback((userInput = "") => quickValues({
    workTitle: deps.workTitle, author: deps.author, context: readerContext.get(), tags: quoteTags.all().filter((tag) => tag.resourceId === target.resourceId), userInput, t,
  }), [deps.workTitle, deps.author, target.resourceId, t]);

  /** A note: the user's own text, anchored where the tag points, else where the reader is, else on the work. */
  async function sendNote(text: string): Promise<boolean> {
    if (sendingRef.current || !noteable) return false;
    const body = text.trim();
    const live = readerContext.get();
    const tag = tags[0];
    if (!body && !tag) return false;
    sendingRef.current = true;
    setSending(true);
    try {
      if (!target.sessionId) await deps.ensureTargetSession();
      const place = live && live.resourceId === target.resourceId ? live : null;
      const anchor = tag ? anchorFromTag(tag, t) : place ? anchorFromContext(place, t) : null;
      const title = noteTitleOf(body, target.title ?? deps.workTitle ?? t("notes.newTitle"));
      const created = await call<{ objectId?: string }>("notes.create", {
        title,
        text: body,
        ...(anchor ? { resourceId: anchor.resourceId, resourceRevisionId: anchor.resourceRevisionId, locator: anchor.locator, ...(anchor.quoteText ? { quoteText: anchor.quoteText } : {}) } : {}),
        ...(target.workId ? { workId: target.workId } : {}),
      });
      if (created.objectId) void autoAddMaterial(deps.contextId, "note", created.objectId);
      if (tag) quoteTags.remove(tag.id);
      deps.patchComposer({ draft: "" });
      deps.setError(undefined);
      deps.bump();
      setScrollSignal((n) => n + 1);
      void stream.reload();
      return true;
    } catch (error) {
      // The text stays in the input, so a failed note is not lost.
      deps.setError(messageOf(error));
      return false;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function sendAsk(text: string, extra: { attach?: "page" | "frame"; library?: boolean; quickTask?: { id: string | null; name: string } } = {}): Promise<boolean> {
    const hasFiles = (composer.files?.length ?? 0) > 0;
    if (sendingRef.current || deps.running || (!text.trim() && !hasFiles)) return false;
    sendingRef.current = true;
    setSending(true);
    try {
      setScrollSignal((n) => n + 1);
      const sent = await deps.sendAgent({ text, ...extra, tags });
      if (sent) {
        for (const tag of tags) quoteTags.remove(tag.id);
        setScrollSignal((n) => n + 1);
        void stream.reload();
      }
      return sent;
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  const send = () => (mode === "note" ? sendNote(readDraft()) : sendAsk(readDraft()));

  /** A quick task renders its template with what is on screen. Sent: it goes out as a visible message with the task's name. Filled: it lands in the input. */
  async function runQuick(task: QuickTask): Promise<void> {
    const rendered = renderQuick(task, quickValuesNow(readDraft()), t);
    if (noteable && mode !== "ask") setMode("ask");
    if (task.sendMode === "fill") { deps.patchComposer({ draft: rendered.text }); return; }
    if (rendered.truncated.length) deps.setNotice(t("chat.quick.truncatedNotice"));
    await sendAsk(rendered.text, { attach: task.includeFrame ? (context?.kind === "comic" ? "page" : context?.kind === "video" ? "frame" : undefined) : undefined, library: task.includeLibrary, quickTask: { id: task.id, name: task.name } });
  }

  /** Save a finished assistant answer (with formatted sources when present) into notes for this surface. */
  async function saveAnswerAsNote(item: StreamAgent): Promise<boolean> {
    if (!noteable || !item.text.trim()) return false;
    const sources = collectSources(item.citations, item.search, item.serverToolSteps);
    const body = sources.length > 0
      ? `${item.text.trim()}\n\n---\n${t("chat.sources")}\n${sources.map((s) => `${s.index}. [${s.title}](${s.url})`).join("\n")}`
      : item.text.trim();
    const title = noteTitleOf(item.text, target.title ?? deps.workTitle ?? t("notes.newTitle"));
    const live = readerContext.get();
    const place = live && live.resourceId === target.resourceId ? live : null;
    const anchor = place ? anchorFromContext(place, t) : null;
    try {
      const created = await call<{ objectId?: string }>("notes.create", {
        title,
        text: body,
        ...(anchor ? { resourceId: anchor.resourceId, resourceRevisionId: anchor.resourceRevisionId, locator: anchor.locator } : target.resourceId ? { resourceId: target.resourceId } : {}),
        ...(target.workId ? { workId: target.workId } : {}),
      });
      if (created.objectId) void autoAddMaterial(deps.contextId, "note", created.objectId);
      deps.setNotice(t("chat.action.savedNote"));
      deps.bump();
      void stream.reload();
      return true;
    } catch (error) {
      deps.setError(messageOf(error));
      return false;
    }
  }

  /** Change the text of a note's own paragraph; a note that only has a quote gets one. */
  async function editNote(noteId: string, text: string): Promise<boolean> {
    try {
      const doc = await call<{ revision: number; document?: { blocks?: Array<{ id: string; type: string }> } }>("notes.get", { objectId: noteId });
      const blocks = doc.document?.blocks ?? [];
      const own = blocks.find((block) => block.type !== "quote");
      if (own) await call("notes.update", { objectId: noteId, expectedRevision: doc.revision, blockId: own.id, text });
      else if (text.trim()) await call("notes.insert", { objectId: noteId, expectedRevision: doc.revision, atIndex: blocks.length, blockType: "paragraph", text });
      deps.setError(undefined);
      deps.bump();
      void stream.reload();
      return true;
    } catch (error) { deps.setError(messageOf(error)); return false; }
  }

  async function deleteNote(noteId: string): Promise<void> {
    const result = await attempt("notes.delete", { objectId: noteId });
    if (!result.ok) { deps.setError(result.error.message); return; }
    deps.setNotice(t("chat.note.deleted"));
    deps.bump();
    void stream.reload();
  }

  /** A bubble's own selection or region becomes a tag again, so a question can be asked about it. */
  function quoteNote(note: { resourceId: string | null; resourceRevisionId: string | null; locator: unknown; quote: string; pageNumber: number | null }): void {
    if (!note.resourceId || !note.resourceRevisionId || !note.locator) return;
    const locator = note.locator as { kind: string; partId?: string; range?: { start: number; end: number }; pageId?: string; region?: { x: number; y: number; width: number; height: number }; startMs?: number; endMs?: number };
    if (locator.kind === "text" && locator.range) {
      quoteTags.put({ kind: "selection", resourceId: note.resourceId, revisionId: note.resourceRevisionId, label: t("chat.tag.selection", { count: Math.max(1, locator.range.end - locator.range.start) }), partId: locator.partId, start: locator.range.start, end: locator.range.end, quote: note.quote });
    } else if (locator.kind === "image" && locator.pageId) {
      if (locator.region) quoteTags.put({ kind: "region", resourceId: note.resourceId, revisionId: note.resourceRevisionId, label: t("chat.tag.region", { page: note.pageNumber ?? 1 }), pageId: locator.pageId, pageNumber: note.pageNumber ?? 1, region: locator.region });
    } else if (locator.kind === "temporal" && locator.startMs !== undefined && locator.endMs !== undefined) {
      quoteTags.put({ kind: "interval", resourceId: note.resourceId, revisionId: note.resourceRevisionId, label: intervalLabel(t, locator.startMs, locator.endMs), startMs: locator.startMs, endMs: locator.endMs });
    }
    setMode("ask");
  }

  const quick = useMemo(() => quickTasks.filter((task) => task.enabled).map((task) => ({ task, label: task.name })), [quickTasks]);
  const bumpScroll = useCallback(() => setScrollSignal((n) => n + 1), []);

  return {
    stream, mode, setMode, noteable, sending, send, sendNote, sendAsk, runQuick, editNote, deleteNote, quoteNote, saveAnswerAsNote, quick, tags, context,
    scrollSignal, bumpScroll,
    mediaContextFor,
    removeTag: (id: string) => quoteTags.remove(id),
    removeImage: (materialId: string) => deps.updateComposer((current) => ({ images: current.images.filter((item) => item.materialId !== materialId) })),
    removeFile: (fileId: string) => deps.updateComposer((current) => ({ files: (current.files ?? []).filter((item) => item.id !== fileId) })),
  };
}
