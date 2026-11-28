import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { chordLabel } from "@manga/contracts/keys";
import { attempt } from "../lib/api.ts";
import { contextSurface, type AgentSurface } from "../agent-surface.ts";
import { ConversationBar } from "../components/conversation-bar.tsx";
import { useChatView } from "../components/chat/chat-view.tsx";
import { useFocusedScreenshot } from "../lib/capture-bridge.ts";
import type { NoteAnchor } from "../lib/chat-model.ts";
import { useKeyTable } from "../lib/key-table.tsx";
import { mediaContextFor, readerContext, type ReaderContext } from "../lib/reader-context.ts";
import { quoteTags, type QuoteTag } from "../lib/quote-tags.ts";
import type { AttachedImage } from "../lib/types.ts";
import { useDraft } from "./drafts.ts";
import { useModelChoice } from "./model-choice.tsx";
import { useServices } from "./services.tsx";

const ACTIVE = ["queued", "running", "waiting_input"];

export type AgentHandle = {
  pane: ReactNode;
  running: boolean;
  stop: () => void;
  sessionId: string | undefined;
  noteable: boolean;
  sendNote: (text: string, options?: { frozenAnchor?: NoteAnchor | null; frozenTags?: readonly QuoteTag[]; clearComposerDraft?: boolean }) => Promise<boolean>;
  expandToDock: (text: string, frozenTags: readonly QuoteTag[]) => void;
  askWithTag: (tag: QuoteTag) => void;
};

/**
 * The Agent's conversation for one surface (A-94): the dock's, which follows the focused tab, and a conversation tab's own. It finds or opens the session the
 * surface names, follows the task that runs in it, and sends from the composer kept for that subject. The tab in front is read from the one
 * `readerContext`, so what a send carries (the page, the moment, the picked region) is the focused reader's and nobody else's.
 */
export function useAgent(surface: AgentSurface | null, options: { wide?: boolean } = {}): AgentHandle {
  const s = useServices();
  const { i18n, t } = s;
  const active = surface !== null;
  const shown = surface ?? contextSurface(null);
  const { composer, patch, update } = useDraft(shown.draftKey);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [run, setRun] = useState<Record<string, unknown> | null>(null);
  const surfaceRef = useRef(shown);
  surfaceRef.current = shown;
  const sRef = useRef(s);
  sRef.current = s;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  // The conversation of the surface: a subject's own session is opened (and made once), the context's current one is read.
  const subject = `${shown.contextId ?? ""}|${shown.open?.kind ?? ""}|${shown.open?.targetId ?? ""}|${shown.sessionId ?? ""}`;
  const subjectRef = useRef(subject);
  subjectRef.current = subject;
  // Read again when the conversations change: the current one moved, or the conversation shown was deleted and its subject needs a new one.
  const currentVersion = s.conversationVersion;
  useEffect(() => {
    if (!active) { setSessionId(undefined); return; }
    const current = surfaceRef.current;
    if (current.sessionId) { setSessionId(current.sessionId); return; }
    let cancelled = false;
    void (async () => {
      if (current.open) {
        const opened = await attempt<{ id?: string }>("session.open", { kind: current.open.kind, targetId: current.open.targetId, contextId: current.contextId });
        if (cancelled) return;
        if (!opened.ok) { sRef.current.setError(opened.error.message); setSessionId(undefined); return; }
        setSessionId(String(opened.value.id ?? "") || undefined);
        return;
      }
      const res = await attempt<{ conversation: { sessionId: string } | null }>("conversation.current", { contextId: current.contextId });
      if (!cancelled) setSessionId(res.ok ? res.value.conversation?.sessionId : undefined);
    })();
    return () => { cancelled = true; };
  }, [active, subject, currentVersion]);

  // The pane starts without a task when it shows another conversation.
  const lastSession = useRef(sessionId);
  useEffect(() => {
    if (lastSession.current !== sessionId) { lastSession.current = sessionId; setRun(null); }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) { setRun(null); return; }
    const runs = (s.workspace?.runs as Array<{ id: string; sessionId: string; status: string }> | undefined) ?? [];
    const own = runs.filter((entry) => entry.sessionId === sessionId);
    const found = own.find((entry) => ACTIVE.includes(entry.status) || entry.status === "interrupted") ?? own[0];
    if (!found) return;
    let cancelled = false;
    void attempt("agent.getRun", { runId: found.id }).then((result) => { if (!cancelled && result.ok) setRun(result.value); });
    return () => { cancelled = true; };
  }, [sessionId, s.workspace]);

  useEffect(() => {
    const runId = String(run?.runId ?? run?.id ?? "");
    const status = String(run?.status ?? "");
    if (!runId || !ACTIVE.includes(status)) return;
    let cancelled = false;
    const tick = async () => {
      const result = await attempt("agent.getRun", { runId });
      if (!cancelled && result.ok) setRun(result.value);
    };
    const timer = window.setInterval(() => { void tick(); }, 400);
    void tick();
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [run?.runId, run?.id, run?.status]);

  const visibleRun = run && sessionId && String(run.sessionId ?? "") === sessionId ? run : null;
  const running = ACTIVE.includes(String(visibleRun?.status ?? ""));

  // When a task finishes for the same session (ACTIVE -> terminal), refresh messages and conversation lists.
  const visibleStatus = String(visibleRun?.status ?? "");
  const lastRunState = useRef<{ sessionId: string | undefined; status: string }>({ sessionId, status: visibleStatus });
  useEffect(() => {
    const prev = lastRunState.current;
    if (prev.sessionId === sessionId && ACTIVE.includes(prev.status) && visibleStatus !== "" && !ACTIVE.includes(visibleStatus)) {
      sRef.current.bump();
      sRef.current.conversationsChanged();
    }
    lastRunState.current = { sessionId, status: visibleStatus };
  }, [sessionId, visibleStatus]);

  /** The session a send or a note goes to; the context's current conversation is made when there is none. */
  const ensureSession = useCallback(async (origin = surfaceRef.current): Promise<string | undefined> => {
    if (origin.sessionId) return origin.sessionId;
    if (origin.open) {
      const opened = await attempt<{ id?: string }>("session.open", { kind: origin.open.kind, targetId: origin.open.targetId, contextId: origin.contextId });
      if (!opened.ok) { sRef.current.setError(opened.error.message); return undefined; }
      const id = String(opened.value.id ?? "") || undefined;
      if (id && surfaceRef.current.draftKey === origin.draftKey) setSessionId(id);
      return id;
    }
    if (sessionId) return sessionId;
    const created = await attempt<{ sessionId: string }>("conversation.new", { contextId: origin.contextId });
    if (!created.ok) { sRef.current.setError(created.error.message); return undefined; }
    if (surfaceRef.current.draftKey === origin.draftKey) setSessionId(created.value.sessionId);
    sRef.current.conversationsChanged();
    return created.value.sessionId;
  }, [sessionId]);

  /** A picture of the page, the framed region or the moment on screen, prepared for the next task. The bytes stay in the main process. */
  async function prepareImage(live: ReaderContext, region?: { pageId: string; region: { x: number; y: number; width: number; height: number } }): Promise<AttachedImage | null> {
    type Prepared = { materialId: string; mediaType: string; base64: string; width: number; height: number; bytes: number; extraction: string };
    if (live.kind === "novel") return null;
    const result = live.kind === "comic"
      ? await attempt<Prepared>("material.region", { resourceId: live.resourceId, resourceRevisionId: live.revisionId, pageId: region?.pageId ?? live.pageId, ...(region ? { region: region.region } : {}) })
      : await attempt<Prepared>("material.frame", { resourceId: live.resourceId, resourceRevisionId: live.revisionId, timeMs: Math.max(0, Math.round(live.positionMs)) });
    if (!result.ok) {
      s.setError(t("rp.attach.failed", { message: result.error.message }));
      return null;
    }
    const value = result.value;
    return {
      materialId: value.materialId, mediaType: value.mediaType, width: value.width, height: value.height, bytes: value.bytes, extraction: value.extraction,
      preview: `data:${value.mediaType};base64,${value.base64}`,
      ...(region ? { pageId: region.pageId, region: region.region } : {}),
    };
  }

  async function attachImage(what: "page" | "frame") {
    const live = readerContext.get();
    if (!live || live.kind === "novel" || (what === "page") !== (live.kind === "comic")) return;
    if (composer.images.length >= 4) { s.setNotice(t("rp.attach.max", { count: 4 })); return; }
    const image = await prepareImage(live);
    if (!image) return;
    update((current) => ({ images: [...current.images, image].slice(0, 4) }));
    s.setError(undefined);
    s.setNotice(t("rp.attach.done", { what: image.extraction }));
  }

  const { picker: modelPicker, activeConnection } = useModelChoice(shown.contextId);
  const activeConnectionRef = useRef(activeConnection);
  activeConnectionRef.current = activeConnection;

  /**
   * The Agent's send. The conversation is the surface's own; the picked tags become the task's selection, picture and interval, so what the user sees
   * as tags is exactly what goes. A note never comes here, which is why a missing model cannot stop one.
   */
  async function sendAgent(input: { text: string; attach?: "page" | "frame"; library?: boolean; quickTask?: { id: string | null; name: string }; tags: readonly QuoteTag[] }): Promise<boolean> {
    const text = input.text;
    if (!text.trim()) return false;
    const origin = surfaceRef.current;
    const originSubject = subjectRef.current;
    const sid = await ensureSession(origin);
    if (!sid) return false;
    const resources = (s.workspace?.resources as Array<{ id: string; title: string }> | undefined) ?? [];
    const readResourceIds = [...new Set([...composer.materials, ...(input.library ? resources.map((item) => item.id) : []), ...(origin.resourceId ? [origin.resourceId] : [])])];
    const noteObjectIds = [...new Set([...composer.noteMaterials, ...(origin.noteObjectId ? [origin.noteObjectId] : [])])];
    // The reader's place rides along only when it is this surface's own subject; a position left by another reader is not sent.
    const live = readerContext.get();
    const place = live && live.kind !== "novel" && origin.resourceId === live.resourceId ? live : null;
    const mine = input.tags.filter((tag) => tag.resourceId === origin.resourceId);
    const selectionTag = mine.find((tag): tag is Extract<QuoteTag, { kind: "selection" }> => tag.kind === "selection");
    const regionTags = mine.filter((tag): tag is Extract<QuoteTag, { kind: "region" }> => tag.kind === "region");
    const intervalTag = mine.find((tag): tag is Extract<QuoteTag, { kind: "interval" }> => tag.kind === "interval");
    const imageIds = composer.images.map((image) => image.materialId);
    if (place?.kind === "comic") {
      for (const tag of regionTags.slice(0, Math.max(0, 4 - imageIds.length))) {
        const prepared = await prepareImage(place, { pageId: tag.pageId, region: tag.region });
        if (!prepared) return false;
        imageIds.push(prepared.materialId);
      }
    }
    if (input.attach && place && (input.attach === "page") === (place.kind === "comic") && imageIds.length < 4) {
      const prepared = await prepareImage(place);
      if (!prepared) return false;
      imageIds.push(prepared.materialId);
    }
    const framed = place?.kind === "comic" ? (regionTags.find((tag) => tag.pageId === place.pageId)?.region ?? composer.images.find((image) => image.pageId === place.pageId && image.region)?.region) : undefined;
    const placed = place?.kind === "video" && intervalTag ? { ...place, interval: { startMs: intervalTag.startMs, endMs: intervalTag.endMs } } : place;
    const mediaContext = placed ? mediaContextFor(placed, { region: framed, subtitleAheadMs: composer.subtitleAheadMin * 60_000 }) : undefined;
    const conns = (s.settings?.connections as Array<{ purpose?: string }> | undefined) ?? [];
    const canSemantic = s.facets.has("semantic") && conns.some((item) => item.purpose === "embedding");
    const canWebpage = s.facets.has("research") && origin.contextId !== null;
    const canWebSearch = webSearchAvailable(conns as Array<Record<string, unknown>>, activeConnectionRef.current as Record<string, unknown> | null);
    const allowCommands: string[] = [];
    if (composer.allowOnline && s.facets.has("metadata")) allowCommands.push("metadata.search");
    if (composer.allowSemantic && canSemantic) allowCommands.push("semantic.search");
    if (composer.allowWebpage && canWebpage) allowCommands.push("webpage.fetch");
    if (composer.allowWebSearch && canWebSearch) allowCommands.push("web.search");
    const result = await attempt("agent.send", {
      sessionId: sid,
      text,
      readResourceIds,
      noteObjectIds,
      ...(mediaContext ? { mediaContext } : {}),
      ...(composer.recordings.length ? { captureSessionIds: composer.recordings } : {}),
      ...(imageIds.length ? { imageMaterialIds: imageIds.slice(0, 4) } : {}),
      ...(allowCommands.length ? { allowCommands } : {}),
      ...(input.quickTask ? { quickTask: input.quickTask } : {}),
      ...(selectionTag ? { selection: { resourceId: selectionTag.resourceId, resourceRevisionId: selectionTag.revisionId, partId: selectionTag.partId, start: selectionTag.start, end: selectionTag.end } } : {}),
    });
    if (!result.ok) { s.setError(result.error.message); return false; }
    if (subjectRef.current === originSubject || sessionIdRef.current === sid) setRun(result.value);
    // What was chosen for this task is spent: pictures, recordings, widening and online search are asked for again each time.
    patch({ ...(text === composer.draft ? { draft: "" } : {}), images: [], recordings: [], allowOnline: false, allowSemantic: false, allowWebpage: false, allowWebSearch: false, subtitleAheadMin: 0 });
    s.setError(undefined);
    s.conversationsChanged();
    await s.refresh();
    return true;
  }

  async function retry(runId: string) {
    const originSession = sessionIdRef.current;
    const result = await attempt("agent.retry", { runId });
    if (!result.ok) s.setError(result.error.message);
    else if (sessionIdRef.current === originSession) setRun(result.value);
    await s.refresh();
  }

  async function stop() {
    const runId = String(visibleRun?.runId ?? visibleRun?.id ?? "");
    if (!runId) return;
    const originSession = sessionIdRef.current;
    await attempt("agent.cancel", { runId });
    const latest = await attempt("agent.getRun", { runId });
    if (latest.ok && sessionIdRef.current === originSession) setRun(latest.value);
  }

  const connections = (s.settings?.connections as Array<{ purpose?: string }> | undefined) ?? [];
  const noModel = s.settings !== null && !connections.some((item) => item.purpose === "text");
  const semantic = s.facets.has("semantic") && connections.some((item) => item.purpose === "embedding");
  const webpage = s.facets.has("research") && shown.contextId !== null;
  const webSearch = webSearchAvailable(connections as Array<Record<string, unknown>>, activeConnection as Record<string, unknown> | null);
  const readAloudOn = speechAvailable(connections as Array<Record<string, unknown>>);
  const resources = (s.workspace?.resources as Array<{ id: string; title: string }> | undefined) ?? [];
  const reader = readerContext.get();
  const focusedShot = useFocusedScreenshot();
  const keyTable = useKeyTable();
  const mediaResourceId = shown.resourceId;
  const title = shown.page === "work" ? shown.label : shown.resourceTitle;
  const composerScreenshot = !options.wide && focusedShot && shown.resourceId === focusedShot.resourceId
    ? {
      label: focusedShot.label,
      key: (keyTable[focusedShot.kind === "comic" ? "comic.screenshot" : "video.screenshot"]?.[0])
        ? chordLabel(keyTable[focusedShot.kind === "comic" ? "comic.screenshot" : "video.screenshot"]![0]!)
        : undefined,
      disabled: focusedShot.disabled,
      onTake: () => { void focusedShot.take(); },
    }
    : null;

  const chatView = useChatView({
    i18n,
    page: shown.page,
    target: {
      sessionId,
      resourceId: shown.resourceId,
      revisionId: shown.resourceRevisionId ?? (reader && reader.resourceId === shown.resourceId ? reader.revisionId : undefined),
      workId: shown.workId,
      title,
    },
    composer,
    patchComposer: patch,
    updateComposer: update,
    sendAgent,
    ensureTargetSession: ensureSession,
    running,
    version: s.shelfKey,
    bump: s.bump,
    setError: s.setError,
    setNotice: s.setNotice,
    workTitle: title,
    author: shown.author ?? null,
    prepareImage: (live) => prepareImage(live),
    contextId: shown.contextId,
    formatDate: i18n.formatDate,
    recorder: s.voiceOn ? s.recorder : null,
    dictation: s.voiceOn ? s.dictation ?? null : null,
    noModel,
    modelPicker,
    onSettings: () => s.open.settings("models"),
    onStop: () => void stop(),
    onRetry: (runId) => void retry(runId),
    online: s.facets.has("metadata"),
    semantic,
    webpage,
    webSearch,
    readAloud: readAloudOn,
    resources,
    recordingsOf: s.voiceOn ? mediaResourceId ?? null : null,
    onAttach: (what) => void attachImage(what),
    screenshot: composerScreenshot,
    onJumpNote: (note) => { if (note.resourceId && note.locator) void s.open.anchor({ resourceId: note.resourceId, resourceRevisionId: note.resourceRevisionId ?? undefined, locator: note.locator } as never); },
    onJumpVoice: (voice, source) => {
      const where = source ?? voice.sources[0];
      const resourceId = where?.resourceId ?? voice.resourceId;
      if (resourceId && where?.locator) void s.open.anchor({ resourceId, resourceRevisionId: undefined, locator: where.locator } as never);
      else s.reviewRecording({ sessionId: voice.id });
    },
    onOpenRecording: (voice) => s.reviewRecording({ sessionId: voice.id }),
    empty: <p className="detail-muted">{options.wide ? t("chat.empty.page") : t("chat.empty")}</p>,
    wide: options.wide,
    header: (
      <ConversationBar
        t={t}
        contextId={shown.contextId}
        title={shown.label ?? ""}
        version={s.conversationVersion}
        formatDate={i18n.formatDate}
        onNew={() => s.open.newConversation()}
        onResume={(id) => s.open.resumeConversation(id)}
        onError={s.setError}
      />
    ),
  });

  const expandToDock = useCallback((text: string, frozenTags: readonly QuoteTag[]) => {
    for (const tag of frozenTags) quoteTags.put(tag);
    if (text.trim()) {
      update((current) => ({
        draft: current.draft.trim() ? `${current.draft}\n${text}` : text,
      }));
    }
    chatView.chat.setMode("note");
  }, [update, chatView.chat]);

  const askWithTag = useCallback((tag: QuoteTag) => {
    quoteTags.put(tag);
    chatView.chat.setMode("ask");
  }, [chatView.chat]);

  return {
    pane: chatView.pane,
    running,
    stop: () => void stop(),
    sessionId,
    noteable: active && chatView.chat.noteable,
    sendNote: chatView.chat.sendNote,
    expandToDock,
    askWithTag,
  };
}

/** Whether answers and novels can be read aloud (计划 4.7): a speech connection whose plugin is on. */
export function speechAvailable(connections: Array<Record<string, unknown>>): boolean {
  return connections.some((item) => item.purpose === "speech" && (item.account as { available?: boolean } | null | undefined)?.available !== false);
}

/**
 * Whether "联网搜索" can be offered (计划 4.4): the active conversation model searches by itself (a DeepSeek model whose profile says so), or a web search
 * service from a provider is configured and its plugin is on.
 */
export function webSearchAvailable(connections: Array<Record<string, unknown>>, activeConnection?: Record<string, unknown> | null): boolean {
  const usable = (item: Record<string, unknown>) => { const account = item.account as { available?: boolean } | null | undefined; return !account || account.available !== false; };
  const text = activeConnection !== undefined
    ? (activeConnection && usable(activeConnection) ? activeConnection : undefined)
    : connections.find((item) => item.purpose === "text" && usable(item));
  const profile = (text?.profile ?? {}) as { capabilities?: string[]; dialect?: string };
  let deepseekHost = false;
  try { deepseekHost = new URL(String(text?.baseUrl ?? "")).hostname === "api.deepseek.com"; } catch { /* not an address */ }
  if (text && profile.capabilities?.includes("web_search") && (profile.dialect === "deepseek" || deepseekHost)) return true;
  return connections.some((item) => item.purpose === "search" && usable(item));
}
