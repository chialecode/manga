import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { attempt } from "../lib/api.ts";
import { contextSurface, type AgentSurface } from "../agent-surface.ts";
import { ConversationBar } from "../components/conversation-bar.tsx";
import { useChatView } from "../components/chat/chat-view.tsx";
import { mediaContextFor, readerContext, type ReaderContext } from "../lib/reader-context.ts";
import type { QuoteTag } from "../lib/quote-tags.ts";
import type { AttachedImage } from "../lib/types.ts";
import { useDraft } from "./drafts.ts";
import { useServices } from "./services.tsx";

const ACTIVE = ["queued", "running", "waiting_input"];

export type AgentHandle = {
  pane: ReactNode;
  capsule: ReactNode;
  running: boolean;
  stop: () => void;
  sessionId: string | undefined;
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

  // The conversation of the surface: a subject's own session is opened (and made once), the context's current one is read.
  const subject = `${shown.contextId ?? ""}|${shown.open?.kind ?? ""}|${shown.open?.targetId ?? ""}|${shown.sessionId ?? ""}`;
  // Read again when the conversations change: the current one moved, or the conversation shown was deleted and its subject needs a new one.
  const currentVersion = s.conversationVersion;
  useEffect(() => {
    if (!active) { setSessionId(undefined); return; }
    if (shown.sessionId) { setSessionId(shown.sessionId); return; }
    let cancelled = false;
    void (async () => {
      if (shown.open) {
        const opened = await attempt<{ id?: string }>("session.open", { kind: shown.open.kind, targetId: shown.open.targetId, contextId: shown.contextId });
        if (cancelled) return;
        if (!opened.ok) { s.setError(opened.error.message); setSessionId(undefined); return; }
        setSessionId(String(opened.value.id ?? "") || undefined);
        return;
      }
      const current = await attempt<{ conversation: { sessionId: string } | null }>("conversation.current", { contextId: shown.contextId });
      if (!cancelled) setSessionId(current.ok ? current.value.conversation?.sessionId : undefined);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, subject, currentVersion]);

  // The pane starts without a task when it shows another conversation.
  const lastSession = useRef(sessionId);
  useEffect(() => {
    if (lastSession.current !== sessionId) { lastSession.current = sessionId; setRun(null); }
  }, [sessionId]);

  const runs = (s.workspace?.runs as Array<{ id: string; sessionId: string; status: string }> | undefined) ?? [];
  useEffect(() => {
    if (!sessionId) { setRun(null); return; }
    const own = runs.filter((entry) => entry.sessionId === sessionId);
    const found = own.find((entry) => ACTIVE.includes(entry.status) || entry.status === "interrupted") ?? own[0];
    if (!found) return;
    let cancelled = false;
    void attempt("agent.getRun", { runId: found.id }).then((result) => { if (!cancelled && result.ok) setRun(result.value); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // When a task ends the messages and the conversation lists are read again.
  const runStatus = String(run?.status ?? "");
  const lastStatus = useRef(runStatus);
  useEffect(() => {
    if (lastStatus.current !== runStatus && !ACTIVE.includes(runStatus)) { s.bump(); s.conversationsChanged(); }
    lastStatus.current = runStatus;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runStatus]);

  const visibleRun = run && sessionId && String(run.sessionId ?? "") === sessionId ? run : null;
  const running = ACTIVE.includes(String(visibleRun?.status ?? ""));

  /** The session a send or a note goes to; the context's current conversation is made when there is none. */
  const ensureSession = useCallback(async (): Promise<string | undefined> => {
    const now = surfaceRef.current;
    if (now.sessionId) return now.sessionId;
    if (now.open) {
      const opened = await attempt<{ id?: string }>("session.open", { kind: now.open.kind, targetId: now.open.targetId, contextId: now.contextId });
      if (!opened.ok) { s.setError(opened.error.message); return undefined; }
      const id = String(opened.value.id ?? "") || undefined;
      if (id) setSessionId(id);
      return id;
    }
    if (sessionId) return sessionId;
    const created = await attempt<{ sessionId: string }>("conversation.new", { contextId: now.contextId });
    if (!created.ok) { s.setError(created.error.message); return undefined; }
    setSessionId(created.value.sessionId);
    s.conversationsChanged();
    return created.value.sessionId;
  // eslint-disable-next-line react-hooks/exhaustive-deps
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

  /**
   * The Agent's send. The conversation is the surface's own; the picked tags become the task's selection, picture and interval, so what the user sees
   * as tags is exactly what goes. A note never comes here, which is why a missing model cannot stop one.
   */
  async function sendAgent(input: { text: string; attach?: "page" | "frame"; library?: boolean; quickTask?: { id: string | null; name: string }; tags: readonly QuoteTag[] }): Promise<boolean> {
    const text = input.text;
    if (!text.trim()) return false;
    const sid = await ensureSession();
    if (!sid) return false;
    const now = surfaceRef.current;
    const resources = (s.workspace?.resources as Array<{ id: string; title: string }> | undefined) ?? [];
    const readResourceIds = [...new Set([...composer.materials, ...(input.library ? resources.map((item) => item.id) : []), ...(now.resourceId ? [now.resourceId] : [])])];
    const noteObjectIds = [...new Set([...composer.noteMaterials, ...(now.noteObjectId ? [now.noteObjectId] : [])])];
    // The reader's place rides along only when it is this surface's own subject; a position left by another reader is not sent.
    const live = readerContext.get();
    const place = live && live.kind !== "novel" && now.resourceId === live.resourceId ? live : null;
    const mine = input.tags.filter((tag) => tag.resourceId === now.resourceId);
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
    const result = await attempt("agent.send", {
      sessionId: sid,
      text,
      readResourceIds,
      noteObjectIds,
      ...(mediaContext ? { mediaContext } : {}),
      ...(composer.recordings.length ? { captureSessionIds: composer.recordings } : {}),
      ...(imageIds.length ? { imageMaterialIds: imageIds.slice(0, 4) } : {}),
      ...(composer.allowOnline ? { allowCommands: ["metadata.search"] } : {}),
      ...(input.quickTask ? { quickTask: input.quickTask } : {}),
      ...(selectionTag ? { selection: { resourceId: selectionTag.resourceId, resourceRevisionId: selectionTag.revisionId, partId: selectionTag.partId, start: selectionTag.start, end: selectionTag.end } } : {}),
    });
    if (!result.ok) { s.setError(result.error.message); return false; }
    setRun(result.value);
    // What was chosen for this task is spent: pictures, recordings, widening and online search are asked for again each time.
    patch({ ...(text === composer.draft ? { draft: "" } : {}), images: [], recordings: [], allowOnline: false, subtitleAheadMin: 0 });
    s.setError(undefined);
    s.conversationsChanged();
    await s.refresh();
    return true;
  }

  async function retry(runId: string) {
    const result = await attempt("agent.retry", { runId });
    if (!result.ok) s.setError(result.error.message);
    else setRun(result.value);
    await s.refresh();
  }

  async function stop() {
    const runId = String(visibleRun?.runId ?? visibleRun?.id ?? "");
    if (!runId) return;
    await attempt("agent.cancel", { runId });
    const latest = await attempt("agent.getRun", { runId });
    if (latest.ok) setRun(latest.value);
  }

  const connections = (s.settings?.connections as Array<{ purpose?: string }> | undefined) ?? [];
  const noModel = s.settings !== null && !connections.some((item) => item.purpose === "text");
  const resources = (s.workspace?.resources as Array<{ id: string; title: string }> | undefined) ?? [];
  const reader = readerContext.get();
  const mediaResourceId = shown.resourceId;
  const title = shown.page === "work" ? shown.label : shown.resourceTitle;

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
    noModel,
    onSettings: () => s.open.settings("models"),
    onStop: () => void stop(),
    onRetry: (runId) => void retry(runId),
    online: s.facets.has("metadata"),
    resources,
    recordingsOf: s.voiceOn ? mediaResourceId ?? null : null,
    onAttach: (what) => void attachImage(what),
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

  return { pane: chatView.pane, capsule: active ? chatView.capsule : null, running, stop: () => void stop(), sessionId };
}
