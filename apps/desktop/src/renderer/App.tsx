import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_SHELL_PREFERENCE, type ReadingStylePatch, type ShellPreference, type WorkMode } from "@manga/contracts/reading";
import type { SegmentAnchor } from "@manga/contracts/media";
import { createTranslator, type Locale } from "@manga/i18n";
import { composerKeyFor, draftKeyFor, manualMaterialsApply, resolveAgentSurface } from "./agent-surface.ts";
import { ShellFrame, type ShellSession } from "./shell.tsx";
import { ReadingPane } from "./reading.tsx";
import { ComicReader } from "./readers/comic-reader.tsx";
import { VideoPlayer } from "./readers/video-player.tsx";
import { NotesPage } from "./pages/notes-page.tsx";
import { Shelf } from "./pages/shelf.tsx";
import { WorkHome } from "./pages/work-home.tsx";
import { ImportDialog } from "./pages/import-dialog.tsx";
import { DebugPanel, loadDebugView, saveDebugView, useNoticeLog, type DebugView } from "./pages/debug-panel.tsx";
import { SettingsNav } from "./pages/settings/settings-nav.tsx";
import { SettingsView, hiddenSettingsPages } from "./pages/settings/settings-view.tsx";
import { Modal } from "./components/modal.tsx";
import { Toasts } from "./components/toast.tsx";
import { TitleActions } from "./components/title-actions.tsx";
import { useChatView } from "./components/chat/chat-view.tsx";
import { RecordingReview } from "./voice/review-panel.tsx";
import { useRecorder } from "./voice/use-recorder.ts";
import { useComic } from "./hooks/use-comic.ts";
import { useNotes } from "./hooks/use-notes.ts";
import { useVideo } from "./hooks/use-video.ts";
import { useNovel } from "./hooks/use-novel.ts";
import { usePackage } from "./hooks/use-package.ts";
import { useScan } from "./hooks/use-scan.ts";
import { asArray, attempt, uid as id, type HostState } from "./lib/api.ts";
import { WorksCacheContext, type WorksCache } from "./lib/use-works.ts";
import { readingLabels } from "./lib/labels.ts";
import { emptyComposer, type AttachedImage, type ComposerState, type ConnectionForm } from "./lib/types.ts";
import { mediaContextFor, readerContext, type ReaderContext } from "./lib/reader-context.ts";
import { quoteTags, type QuoteTag } from "./lib/quote-tags.ts";
import { sessionPositionLabel, type SettingsPageId } from "./lib/shell-model.ts";
import { PAGE_FOR_KIND, type ShelfState, type WorkMediaKind, type WorkSummary } from "./lib/works.ts";
import type { MigrationPlan } from "./pages/settings/general-page.tsx";

type SessionKind = "resource" | "project" | "note" | "work";
type WorkPageState = { workId: string; kind: WorkMediaKind | null; tab?: "cover"; from: string };

const NOTICE_MS = 5000;

export function App() {
  const [locale] = useState<Locale>("zh-CN");
  const i18n = useMemo(() => createTranslator(locale), [locale]);
  const t = i18n.t;
  const [host, setHost] = useState<HostState | null>(null);
  const [workspace, setWorkspace] = useState<Record<string, unknown> | null>(null);
  const [page, setPage] = useState("library");
  const [settingsPage, setSettingsPage] = useState<SettingsPageId>("general");
  /** Where "back" in settings returns to: the page the user was on. */
  const settingsReturn = useRef<string>("library");
  const notesReturn = useRef<{ page: string; workPage: WorkPageState | null } | null>(null);
  const [workPage, setWorkPage] = useState<WorkPageState | null>(null);
  const [workInfo, setWorkInfo] = useState<{ workId: string; title: string; author: string | null } | null>(null);
  /** The shared conversation the right pane and the chat page show when no resource or work is bound. */
  const [conversationId, setConversationId] = useState<string>();
  const [run, setRun] = useState<Record<string, unknown> | null>(null);
  const [composers, setComposers] = useState<Record<string, ComposerState>>({});
  const [error, setError] = useState<string>();
  const [notice, setNoticeState] = useState<{ text: string; n: number } | undefined>();
  const [inventory, setInventory] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [migration, setMigration] = useState<(MigrationPlan) | null>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth || 1280, height: window.innerHeight || 840 });
  const [sessions, setSessions] = useState<ShellSession[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [pendingMode, setPendingMode] = useState<WorkMode | null>(null);
  const [shelfKey, setShelfKey] = useState(0);
  const [worksCache] = useState<WorksCache>(() => new Map());
  const [importing, setImporting] = useState(false);
  const [reviewing, setReviewing] = useState<{ sessionId?: string; workId?: string; resourceId?: string } | null>(null);
  const [recordsWork, setRecordsWork] = useState<string | null>(null);
  const [debugView, setDebugView] = useState<DebugView>(() => loadDebugView("shell"));
  const viewRequest = useRef(0);
  const started = useRef(false);

  const setNotice = useCallback((message?: string) => setNoticeState((current) => (message ? { text: message, n: (current?.n ?? 0) + 1 } : undefined)), []);
  const bump = useCallback(() => setShelfKey((key) => key + 1), []);
  // A result is told for a few seconds and goes away; a new one restarts the time.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNoticeState(undefined), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice?.n]);

  const scan = useScan(Boolean(host?.writable));
  const notes = useNotes({ i18n, setError, setNotice, bindSession: (kind, target) => ensureBoundSession(kind, target) });
  const novel = useNovel({ i18n, setError, setNotice, setPage, viewRequest, ensureBoundSession, openNote: notes.open, refresh: () => refresh() });
  const comic = useComic({ i18n, setError, setNotice, setPage, viewRequest, ensureBoundSession, openNote: notes.open, refresh: () => refresh() });
  const video = useVideo({ i18n, setError, setNotice, setPage, viewRequest, ensureBoundSession, openNote: notes.open, refresh: () => refresh() });
  const pkg = usePackage({ i18n, setError, setNotice, refresh: () => refresh() });
  const voiceOn = ((workspace?.uiFacets as string[] | undefined) ?? []).includes("voice");
  const recorder = useRecorder({ i18n, setError, setNotice, enabled: voiceOn });
  const noticeLog = useNoticeLog();

  const shellMode = ((workspace?.shell as ShellPreference | undefined) ?? DEFAULT_SHELL_PREFERENCE).mode;
  // A mode click updates the draft and the rail before the settings round trip returns.
  const mode = pendingMode ?? shellMode;
  const reading = novel.visible ? novel.reading : null;
  const mediaOpen = page === "comic" && comic.doc
    ? { resourceId: comic.doc.resourceId, revisionId: comic.doc.revisionId, title: comic.doc.title, workId: comic.doc.workId ?? null }
    : page === "video" && video.doc
      ? { resourceId: video.doc.resourceId, revisionId: video.doc.revisionId, title: video.doc.title, workId: video.doc.workId ?? null }
      : page === "reading" && reading
        ? { resourceId: reading.resourceId, revisionId: reading.revisionId, title: reading.title, workId: novel.workId }
        : null;
  const work = page === "work" && workPage ? { workId: workPage.workId, title: workInfo?.workId === workPage.workId ? workInfo.title : "" } : null;
  const surface = resolveAgentSurface({
    page,
    sessionId: conversationId,
    mode,
    sessions,
    reading: mediaOpen,
    note: notes.doc ? { objectId: notes.doc.objectId, revision: notes.doc.revision, title: notes.doc.title, resourceId: notes.doc.resourceId } : null,
    work,
    // A picked selection travels as a quote tag the user can see and remove; it is not carried by the page.
    selection: null,
  });
  const boundSessionKey = composerKeyFor(surface, sessions, conversationId, sessionsLoaded);
  // Drafts stay with the mode and target, so a switch cannot display or send the other mode's text.
  const activeComposerKey = draftKeyFor(surface, sessions, boundSessionKey);
  const composer = composers[activeComposerKey] ?? emptyComposer();
  const patchComposer = (patch: Partial<ComposerState>) => setComposers((current) => {
    const key = activeComposerKey;
    const existing = current[key] ?? emptyComposer();
    return { ...current, [key]: { ...existing, ...patch } };
  });
  /** A change computed from the composer as it is when the change lands, for choices made after an await. */
  const updateComposer = (patch: (current: ComposerState) => Partial<ComposerState>) => {
    const key = activeComposerKey;
    setComposers((current) => {
      const existing = current[key] ?? emptyComposer();
      return { ...current, [key]: { ...existing, ...patch(existing) } };
    });
  };
  const visibleRun = run && boundSessionKey && String(run.sessionId ?? "") === boundSessionKey ? run : null;
  // The rail follows the mode the user is looking at, including the moment before the session query returns.
  const modeSessions = sessions.filter((item) => (item.mode ?? "enthusiast") === mode);
  const conversations = modeSessions.filter((item) => item.kind === "shared");

  async function refresh(modeHint?: WorkMode): Promise<void> {
    const state = await window.manga.state();
    setHost(state);
    const ws = await attempt("workspace.get");
    const loadedMode = modeHint
      ?? (ws.ok ? ((ws.value.shell as ShellPreference | undefined)?.mode) : undefined)
      ?? mode;
    if (ws.ok) setWorkspace(ws.value);
    const sessionList = await attempt("workspace.sessions", { mode: loadedMode });
    const rows = sessionList.ok ? asArray<ShellSession>(sessionList.value) : [];
    if (sessionList.ok) {
      setSessions(rows);
      setSessionsLoaded(true);
    }
    // The conversation that is shown is one of this mode's own; another mode's id is not a fallback.
    const shared = rows.filter((row) => row.kind === "shared");
    setConversationId((current) => (current && shared.some((row) => row.sessionId === current) ? current : shared[0]?.sessionId));
    const st = await attempt("settings.get");
    if (st.ok) setSettings(st.value);
    setShelfKey((key) => key + 1);
  }

  async function changeMode(next: WorkMode) {
    if (next === mode) return;
    setPendingMode(next);
    setRun(null);
    const result = await attempt("settings.setShell", { mode: next });
    if (!result.ok) {
      // The switch did not stick, so the previous mode's draft and run stay where they were.
      setPendingMode(null);
      setError(result.error.message);
      return;
    }
    setError(undefined);
    await refresh(next);
    setPendingMode(null);
  }

  useEffect(() => {
    void refresh().catch((item) => setError(String(item)));
    // The initial load runs once; later refreshes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A library with nothing in it starts on the page that adds the first folder (交互设计 3.5).
  useEffect(() => {
    if (!host?.writable || started.current) return;
    started.current = true;
    void attempt<{ total?: number; items?: unknown[] }>("works.list", { limit: 1 }).then((probe) => {
      if (!probe.ok) return;
      const total = typeof probe.value.total === "number" ? probe.value.total : asArray(probe.value.items).length;
      if (total === 0) openSettings("library");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.writable]);

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth || 1280, height: window.innerHeight || 840 });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Background work (imports, scans, metadata, covers, recording) tells the shelf when something it shows has changed.
  useEffect(() => {
    let timer: number | undefined;
    const off = window.manga.onNotice?.((item) => {
      if (item.topic !== "work.updated" && item.topic !== "import.progress" && item.topic !== "job.changed" && item.topic !== "scan.finished") return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setShelfKey((key) => key + 1), 300);
    });
    return () => { window.clearTimeout(timer); off?.(); };
  }, []);

  // The inventory is read when the page that shows it is open, not on every refresh.
  useEffect(() => {
    if (page !== "settings" || settingsPage !== "storage") return;
    void attempt("inventory.overview").then((inv) => { if (inv.ok) setInventory(inv.value); });
  }, [page, settingsPage, shelfKey]);

  // The run of the conversation on screen: found from the workspace, then followed while it works.
  const runs = (workspace?.runs as Array<{ id: string; sessionId: string; status: string }> | undefined) ?? [];
  useEffect(() => {
    if (!boundSessionKey) { setRun(null); return; }
    const own = runs.filter((entry) => entry.sessionId === boundSessionKey);
    const active = own.find((entry) => ["queued", "running", "waiting_input", "interrupted"].includes(entry.status)) ?? own[0];
    if (!active) { setRun(null); return; }
    let cancelled = false;
    void attempt("agent.getRun", { runId: active.id }).then((result) => { if (!cancelled) setRun(result.ok ? result.value : null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundSessionKey, workspace]);

  useEffect(() => {
    const runId = String(run?.runId ?? run?.id ?? "");
    const status = String(run?.status ?? "");
    if (!runId || !["queued", "running", "waiting_input"].includes(status)) return;
    let cancelled = false;
    const tick = async () => {
      const result = await attempt("agent.getRun", { runId });
      if (cancelled) return;
      if (result.ok) setRun(result.value);
    };
    const timer = window.setInterval(() => { void tick(); }, 400);
    void tick();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [run?.runId, run?.id, run?.status]);
  // When a task ends the conversation's messages and the sessions are read again.
  const runStatus = String(run?.status ?? "");
  const lastStatus = useRef(runStatus);
  useEffect(() => {
    if (lastStatus.current !== runStatus && !["queued", "running", "waiting_input"].includes(runStatus)) bump();
    lastStatus.current = runStatus;
  }, [runStatus, bump]);

  // The rail shows where each opened resource was left. Once the reader closes (its last position is reported as it unmounts, before
  // this runs) and the writes are saved, the sessions are read again, so the shelf the user lands on shows the new place.
  const readerOpen = novel.visible || comic.visible || video.visible;
  const wasReading = useRef(false);
  useEffect(() => {
    if (readerOpen) { wasReading.current = true; return; }
    if (!wasReading.current) return;
    wasReading.current = false;
    const listMode = mode;
    let cancelled = false;
    void Promise.all([comic.settled(), video.settled()]).then(async () => {
      const list = await attempt("workspace.sessions", { mode: listMode });
      if (!cancelled && list.ok) { setSessions(asArray<ShellSession>(list.value)); setSessionsLoaded(true); }
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readerOpen]);

  async function ensureSession(): Promise<string | undefined> {
    const current = sessions.find((item) => item.sessionId === conversationId && item.kind === "shared" && (!item.mode || item.mode === mode));
    if (current) return current.sessionId;
    return newConversation();
  }

  async function newConversation(): Promise<string | undefined> {
    const created = await attempt("agent.createSession", { title: t("agent.session", { id: String(conversations.length + 1) }), mode });
    if (!created.ok) { setError(created.error.message); return undefined; }
    const next = String(created.value.id ?? "");
    if (!next) return undefined;
    setConversationId(next);
    const list = await attempt("workspace.sessions", { mode });
    if (list.ok) { setSessions(asArray<ShellSession>(list.value)); setSessionsLoaded(true); }
    setRun(null);
    return next;
  }

  /** Open (or reuse) the session that belongs to the current reading target so tasks never cross targets. */
  async function ensureBoundSession(kind: SessionKind, targetId: string, request?: number): Promise<string | undefined> {
    const boundMode = mode;
    const result = await attempt<{ id?: string }>("session.open", { kind, targetId, mode: boundMode });
    if (request !== undefined && request !== viewRequest.current) return undefined;
    if (!result.ok) { setError(result.error.message); return undefined; }
    const opened = String(result.value.id ?? "");
    if (!opened) return undefined;
    const list = await attempt("workspace.sessions", { mode: boundMode });
    if (list.ok) {
      setSessions(asArray<ShellSession>(list.value));
      setSessionsLoaded(true);
    }
    return opened;
  }

  /** A picture of the page, the framed region or the moment on screen, prepared for the next task. The bytes stay in the main process. */
  async function prepareImage(live: ReaderContext, region?: { pageId: string; region: { x: number; y: number; width: number; height: number } }): Promise<AttachedImage | null> {
    type Prepared = { materialId: string; mediaType: string; base64: string; width: number; height: number; bytes: number; extraction: string };
    if (live.kind === "novel") return null;
    const result = live.kind === "comic"
      ? await attempt<Prepared>("material.region", { resourceId: live.resourceId, resourceRevisionId: live.revisionId, pageId: region?.pageId ?? live.pageId, ...(region ? { region: region.region } : {}) })
      : await attempt<Prepared>("material.frame", { resourceId: live.resourceId, resourceRevisionId: live.revisionId, timeMs: Math.max(0, Math.round(live.positionMs)) });
    if (!result.ok) {
      setError(t("rp.attach.failed", { message: result.error.message }));
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
    if (composer.images.length >= 4) { setNotice(t("rp.attach.max", { count: 4 })); return; }
    const image = await prepareImage(live);
    if (!image) return;
    updateComposer((current) => ({ images: [...current.images, image].slice(0, 4) }));
    setError(undefined);
    setNotice(t("rp.attach.done", { what: image.extraction }));
  }

  /**
   * The Agent's send. The conversation is the page's own target; the picked tags become the task's selection, picture and interval, so what
   * the user sees as tags is exactly what goes. A note never comes here, which is why a missing model cannot stop one.
   */
  async function sendAgent(input: { text: string; attach?: "page" | "frame"; library?: boolean; quickTask?: { id: string | null; name: string }; tags: readonly QuoteTag[] }): Promise<boolean> {
    const text = input.text;
    if (!text.trim()) return false;
    // Stay on the page's target. A note left open from another book, or a conversation the user switched away from, is not sent.
    const sid = surface.open
      ? await ensureBoundSession(surface.open.kind, surface.open.targetId)
      : surface.sessionId && (!sessionsLoaded || sessions.some((item) => item.sessionId === surface.sessionId && (!item.mode || item.mode === mode)))
        ? surface.sessionId
        : await ensureSession();
    if (!sid) return false;
    const knownSessions = surface.open
      ? [...sessions, { sessionId: sid, kind: surface.open.kind, targetId: surface.open.targetId, title: surface.label ?? "", mode } as ShellSession]
      : sessions;
    const includeManual = manualMaterialsApply({ ...surface, mode }, knownSessions, sid);
    const resources = ((workspace?.resources as Array<{ id: string; title: string }> | undefined) ?? []);
    const readResourceIds = [...new Set([...(includeManual ? composer.materials : []), ...(input.library ? resources.map((item) => item.id) : []), ...(surface.resourceId ? [surface.resourceId] : [])])];
    const noteObjectIds = [...new Set([...(includeManual ? composer.noteMaterials : []), ...(surface.noteObjectId ? [surface.noteObjectId] : [])])];
    // The reader's place rides along only when it is this page's own target; a position left by another reader is not sent.
    const live = readerContext.get();
    const place = live && live.kind !== "novel" && (page === "comic" || page === "video") && surface.resourceId === live.resourceId ? live : null;
    const mine = input.tags.filter((tag) => tag.resourceId === surface.resourceId);
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
    if (!result.ok) { setError(result.error.message); return false; }
    setRun(result.value);
    // What was chosen for this task is spent: pictures, recordings, widening and online search are asked for again each time.
    patchComposer({ ...(text === composer.draft ? { draft: "" } : {}), images: [], recordings: [], allowOnline: false, subtitleAheadMin: 0 });
    setError(undefined);
    await refresh();
    return true;
  }

  async function retry(runId: string) {
    const result = await attempt("agent.retry", { runId });
    if (!result.ok) setError(result.error.message);
    else setRun(result.value);
    await refresh();
  }

  async function stop() {
    const runId = String(visibleRun?.runId ?? visibleRun?.id ?? "");
    if (!runId) return;
    await attempt("agent.cancel", { runId });
    const latest = await attempt("agent.getRun", { runId });
    if (latest.ok) setRun(latest.value);
  }

  async function chooseLocation() {
    const handle = await window.manga.chooseDirectory();
    if (!handle) return;
    const proposed = await attempt("settings.proposeLocations", { pathHandle: handle });
    if (!proposed.ok) {
      setError(proposed.error.message);
      return;
    }
    const copies = (proposed.value.copies as Array<{ partition: string; bytes: number; target: string }> | undefined) ?? [];
    setError(undefined);
    setMigration({ handle, checkpointId: String(proposed.value.checkpointId ?? ""), copies });
  }

  async function applyMigration() {
    if (!migration) return;
    const applied = await attempt("settings.applyLocations", { checkpointId: migration.checkpointId, pathHandle: migration.handle });
    if (!applied.ok) setError(applied.error.message);
    else {
      setError(undefined);
      setNotice(t("settings.migrationDone"));
    }
    setMigration(null);
    await refresh();
  }

  async function failing(commandId: string, input: unknown = {}): Promise<boolean> {
    const result = await attempt(commandId, input);
    if (!result.ok) setError(result.error.message);
    return result.ok;
  }

  async function saveConnection(fields: ConnectionForm) {
    const credentialHandle = fields.secret ? await window.manga.stashSecret(fields.secret) : undefined;
    const ok = await failing("connections.upsert", {
      id: fields.id,
      label: fields.label,
      protocol: fields.protocol,
      runtime: fields.runtime,
      baseUrl: fields.baseUrl,
      modelId: fields.modelId,
      purpose: fields.purpose,
      timeoutMs: Number(fields.timeoutMs) || 60_000,
      credentialHandle,
    });
    if (!ok) return;
    setError(undefined);
    setNotice(t("settings.connectionSaved"));
    await refresh();
  }

  // ---- pages ------------------------------------------------------------------------------------------------

  function closeReaders() {
    novel.closeReader();
    comic.close();
    video.close();
  }

  /** The navigation always lands on a shelf: whatever was open is closed here, and it comes back from the rail with its place. */
  function goPage(next: string) {
    closeReaders();
    setWorkPage(null);
    if (next === "library" || next === "comic" || next === "video" || next === "reading") bump();
    setPage(next);
  }

  function openSettings(target?: SettingsPageId) {
    if (page !== "settings") settingsReturn.current = page;
    if (target) setSettingsPage(target);
    setPage("settings");
  }

  function closeSettings() {
    const back = settingsReturn.current === "settings" ? "library" : settingsReturn.current;
    setPage(back);
  }

  function openWorkPage(workId: string, options: { kind?: WorkMediaKind | null; tab?: "cover" } = {}) {
    closeReaders();
    setWorkPage({ workId, kind: options.kind ?? null, tab: options.tab, from: page === "work" ? (workPage?.from ?? "library") : page });
    setPage("work");
    void ensureBoundSession("work", workId);
  }

  function backFromWork() {
    const from = workPage?.from ?? "library";
    setWorkPage(null);
    setPage(from === "settings" || from === "work" || from === "notes" ? "library" : from);
    bump();
  }

  /** The reader's "back" is the work's page when the file belongs to one, else its shelf. */
  function backFromReader(kind: WorkMediaKind, workId: string | null | undefined) {
    closeReaders();
    if (workId) { openWorkPage(workId, { kind }); return; }
    goPage(PAGE_FOR_KIND[kind]);
  }

  function openResourceById(resourceId: string, kind: WorkMediaKind | null | undefined, workId: string | null) {
    setWorkPage(null);
    if (kind === "comic") { setPage("comic"); void comic.open(resourceId, { workId }); return; }
    if (kind === "video") { setPage("video"); void video.open(resourceId, { workId }); return; }
    setPage("reading");
    void novel.openResource(resourceId);
  }

  /** A work's "keep reading/watching": the file it was last at, with the place it was left. */
  function continueWork(summary: WorkSummary) {
    const resourceId = summary.lastResource?.id;
    if (!resourceId) { openWorkPage(summary.id, { kind: summary.mediaKind as WorkMediaKind }); return; }
    openResourceById(resourceId, summary.mediaKind as WorkMediaKind, summary.id);
  }

  /** A note on its own page. Its "back" returns to the page it was opened from (the work's page, the records list, a shelf), as settings do. */
  function openNotePage(objectId: string) {
    if (page !== "notes") notesReturn.current = { page, workPage };
    void notes.open(objectId);
    setPage("notes");
  }

  function backFromNotes() {
    notes.close();
    const from = notesReturn.current;
    notesReturn.current = null;
    if (!from) { setSettingsPage("records"); setPage("settings"); return; }
    setWorkPage(from.page === "work" ? from.workPage : null);
    setPage(from.page === "work" && !from.workPage ? "library" : from.page);
  }

  /** A conversation or an opened resource in the rail: back to where it was, with its place. */
  function openSession(session: ShellSession) {
    if (session.kind === "note" && session.targetId) {
      openNotePage(session.targetId);
      return;
    }
    if (session.kind === "work" && session.targetId) {
      openWorkPage(session.targetId);
      return;
    }
    if (session.targetId && session.kind === "resource") {
      openResourceById(session.targetId, session.mediaKind as WorkMediaKind | null | undefined, session.workId ?? null);
      return;
    }
    // A conversation.
    closeReaders();
    setWorkPage(null);
    setConversationId(session.sessionId);
    setRun(null);
    setPage("agent");
  }

  /** A note's source opens in the reader that matches what it points at: text, a page, or a time. */
  async function openNoteSource(objectId: string, blockId?: string) {
    const probe = await attempt<{ locator?: { kind?: string }; resourceId?: string }>("notes.openSource", { objectId, blockId });
    if (probe.ok && probe.value.locator?.kind === "image") {
      await comic.openFromNote(probe.value as never, objectId, blockId);
      return;
    }
    if (probe.ok && probe.value.locator?.kind === "temporal") {
      await video.openFromNote(probe.value as never, objectId, blockId);
      return;
    }
    await novel.openNoteSource(objectId, blockId);
  }

  /** A place named by a locator (a bubble's source, a recorded sentence): the reader of its kind opens there. */
  async function jumpToAnchor(anchor: Pick<SegmentAnchor, "resourceId" | "resourceRevisionId" | "locator">) {
    const { resourceId, resourceRevisionId, locator } = anchor;
    setReviewing(null);
    setWorkPage(null);
    if (!resourceId || !locator) return;
    if (locator.kind === "image") {
      setPage("comic");
      await comic.open(resourceId, { revisionId: resourceRevisionId, focus: { pageId: locator.pageId, ...(locator.region ? { region: locator.region } : {}) } });
    } else if (locator.kind === "temporal") {
      setPage("video");
      await video.open(resourceId, { revisionId: resourceRevisionId, focus: { startMs: locator.startMs, ...(locator.endMs !== undefined ? { endMs: locator.endMs } : {}) } });
    } else {
      setPage("reading");
      await novel.openResource(resourceId);
      if (locator.partId) await novel.openSlice(locator.partId, Math.max(0, (locator.range?.start ?? 0) - 100), { highlight: locator.range ?? null, revisionId: resourceRevisionId });
    }
  }

  async function setShelf(workId: string, state: ShelfState) {
    if (await failing("works.setShelf", { workId, state })) bump();
  }

  // ---- the debug panel --------------------------------------------------------------------------------------
  const debugKey = boundSessionKey || page;
  const debugKeyRef = useRef(debugKey);
  useEffect(() => {
    if (debugKeyRef.current === debugKey) return;
    debugKeyRef.current = debugKey;
    setDebugView(loadDebugView(debugKey));
  }, [debugKey]);
  const changeDebugView = (next: DebugView) => { setDebugView(next); saveDebugView(debugKeyRef.current, next); };
  const toggleDebug = () => changeDebugView({ ...debugView, open: !debugView.open });
  const toggleDebugRef = useRef(toggleDebug);
  toggleDebugRef.current = toggleDebug;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === "KeyD") { event.preventDefault(); toggleDebugRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const facets = new Set((workspace?.uiFacets as string[] | undefined) ?? ["agent", "library", "settings"]);
  const shell = (workspace?.shell as ShellPreference | undefined) ?? (settings?.shell as ShellPreference | undefined) ?? DEFAULT_SHELL_PREFERENCE;
  const running = ["queued", "running", "waiting_input"].includes(String(visibleRun?.status ?? ""));
  const resources = ((workspace?.resources as Array<{ id: string; title: string }> | undefined) ?? []);
  const connections = (settings?.connections as Array<{ purpose?: string }> | undefined) ?? [];
  const noModel = settings !== null && !connections.some((item) => item.purpose === "text");
  const restartRequired = settings?.restartRequired === true || workspace?.restartRequired === true;
  // The book's author style applies only while the reader keeps the built-in defaults; any saved
  // preference means the user's own choice wins.
  const styleIsDefault = JSON.stringify(shell.reading) === JSON.stringify(DEFAULT_SHELL_PREFERENCE.reading);
  const authorStyle = styleIsDefault ? ((novel.reading as { authorStyle?: Record<string, unknown> } | null)?.authorStyle ?? null) : null;
  // The conversation talks about the page that is open; a reader page without a book open is the library to it.
  const chatPage = page === "work" ? "work" : mediaOpen ? page : page === "agent" ? "agent" : page === "notes" ? "notes" : "library";

  const chatView = useChatView({
    i18n,
    page: chatPage,
    target: {
      sessionId: boundSessionKey || undefined,
      resourceId: mediaOpen?.resourceId,
      revisionId: mediaOpen?.revisionId,
      workId: page === "work" ? workPage?.workId : mediaOpen?.workId,
      title: mediaOpen?.title ?? (page === "work" ? workInfo?.title : undefined),
    },
    composer,
    patchComposer,
    updateComposer,
    sendAgent,
    ensureTargetSession: async () => (surface.open ? ensureBoundSession(surface.open.kind, surface.open.targetId) : ensureSession()),
    running,
    version: shelfKey,
    bump,
    setError,
    setNotice,
    workTitle: page === "work" ? workInfo?.title : mediaOpen?.title,
    author: page === "work" ? workInfo?.author : null,
    prepareImage: (live) => prepareImage(live),
    formatDate: i18n.formatDate,
    recorder: voiceOn ? recorder : null,
    noModel,
    onSettings: () => openSettings("models"),
    onStop: () => void stop(),
    onRetry: (runId) => void retry(runId),
    online: facets.has("metadata"),
    resources,
    recordingsOf: voiceOn ? mediaOpen?.resourceId ?? null : null,
    onAttach: (what) => void attachImage(what),
    onJumpNote: (note) => { if (note.resourceId && note.locator) void jumpToAnchor({ resourceId: note.resourceId, resourceRevisionId: note.resourceRevisionId ?? undefined, locator: note.locator } as never); },
    onJumpVoice: (voice, source) => {
      const where = source ?? voice.sources[0];
      const resourceId = where?.resourceId ?? voice.resourceId;
      if (resourceId && where?.locator) void jumpToAnchor({ resourceId, resourceRevisionId: undefined, locator: where.locator } as never);
      else setReviewing({ sessionId: voice.id });
    },
    onOpenRecording: (voice) => setReviewing({ sessionId: voice.id }),
    empty: <p className="detail-muted">{page === "agent" ? t("chat.empty.page") : t("chat.empty")}</p>,
    wide: page === "agent",
    header: surface.label && page !== "agent" ? <div className="chat-context" data-testid="chat-context" title={surface.label}>{surface.label}</div> : undefined,
  });

  if (!host) {
    return <main className="p-6">{t("status.loading")}</main>;
  }
  if (!host.writable) {
    return (
      <main className="p-8 max-w-xl">
        <h1 className="text-xl mb-2">{t("setup.title")}</h1>
        <p className="text-[var(--color-subtle)] mb-4">{t("status.offline")}</p>
        <button className="bg-[var(--color-accent)] text-white px-3 py-2 rounded" onClick={() => void window.manga.chooseDirectory()}>{t("setup.continue")}</button>
      </main>
    );
  }

  const channelLabel = host.layout.channel === "release" ? t("app.channel.release") : host.layout.channel === "test" ? t("app.channel.test") : t("app.channel.development");
  const pages = [
    facets.has("library") || facets.has("inventory") ? { id: "library", label: t("nav.overview"), testId: "nav-library" } : null,
    facets.has("agent") ? { id: "agent", label: t("nav.agent"), testId: "nav-agent" } : null,
    facets.has("library") ? { id: "reading", label: t("nav.novel"), testId: "nav-reading" } : null,
    facets.has("comic") ? { id: "comic", label: t("nav.comic"), testId: "nav-comic" } : null,
    facets.has("video") ? { id: "video", label: t("nav.video"), testId: "nav-video" } : null,
    facets.has("settings") ? { id: "settings", label: t("nav.settings"), testId: "nav-settings" } : null,
  ].filter((item): item is { id: string; label: string; testId: string } => Boolean(item));
  const inSettings = page === "settings";
  // A work's page is shown under the shelf it was opened from.
  const shellPage = page === "work" ? (workPage?.kind ? PAGE_FOR_KIND[workPage.kind] : workPage?.from && workPage.from !== "work" ? workPage.from : "library") : page === "notes" ? "library" : page;
  const hasRight = !inSettings && page !== "agent";
  const title = inSettings ? t("nav.settings")
    : (page === "comic" ? comic.doc?.title : page === "video" ? video.doc?.title : page === "reading" ? reading?.title : page === "work" ? workInfo?.title : undefined) || t("app.title");

  const shelf = (kind: WorkMediaKind | null) => (
    <Shelf
      t={t}
      kind={kind}
      refreshKey={shelfKey}
      facets={facets}
      onOpen={(summary) => openWorkPage(summary.id, { kind: summary.mediaKind as WorkMediaKind })}
      onContinue={continueWork}
      onDetail={(workId, tab) => openWorkPage(workId, { tab })}
      onAddPath={() => openSettings("library")}
      onViewAll={(next) => goPage(PAGE_FOR_KIND[next])}
      onSetShelf={(workId, state) => void setShelf(workId, state)}
    />
  );

  const settingsNav = <SettingsNav t={t} page={settingsPage} hidden={hiddenSettingsPages(facets)} onPage={setSettingsPage} onBack={closeSettings} />;

  const debugPanel = debugView.open ? (
    <DebugPanel
      t={t}
      view={debugView}
      onView={changeDebugView}
      scope={{ sessionId: boundSessionKey || undefined, resourceId: mediaOpen?.resourceId, workId: page === "work" ? workPage?.workId : mediaOpen?.workId ?? undefined, page }}
      live={{ page, mode, running, readerContext: readerContext.get(), tags: quoteTags.all(), composer: { draftLength: composer.draft.length, materials: composer.materials.length, notes: composer.noteMaterials.length, images: composer.images.map((image) => ({ materialId: image.materialId, width: image.width, height: image.height, bytes: image.bytes, preview: image.preview })), allowOnline: composer.allowOnline, subtitleAheadMin: composer.subtitleAheadMin, recordings: composer.recordings } }}
      events={noticeLog}
      version={shelfKey}
      onNotice={setNotice}
    />
  ) : null;

  return (
    <WorksCacheContext.Provider value={worksCache}>
    <ShellFrame
      viewport={viewport}
      preference={shell}
      page={shellPage}
      pages={pages}
      onPage={(next) => { if (next === "settings") openSettings(); else goPage(next); }}
      hasRight={hasRight}
      running={running}
      leftSlot={inSettings ? settingsNav : undefined}
      titleActions={(
        <TitleActions
          t={t}
          debugOpen={debugView.open}
          onDebug={toggleDebug}
          recorder={voiceOn ? recorder.state : null}
          onStopRecording={() => void recorder.stop("user")}
          scan={scan.running}
          onScan={() => openSettings("library")}
        />
      )}
      title={title}
      channel={channelLabel}
      modeLabel={mode === "creator" ? t("mode.creator") : t("mode.enthusiast")}
      modeHints={{ enthusiast: t("mode.enthusiastHint"), creator: t("mode.creatorHint") }}
      labels={{ showLeft: t("shell.showLeft"), showRight: t("shell.showRight"), hideLeft: t("shell.hideLeft"), hideRight: t("shell.hideRight"), stop: t("shell.stop"), modeMenu: t("mode.menu"), newChat: t("chat.new") }}
      onMode={(next: WorkMode) => { void changeMode(next); }}
      onHide={(side) => { void attempt("settings.setShell", side === "left" ? { left: { visible: false, width: shell.layouts[mode].left.width } } : { right: { visible: false, width: shell.layouts[mode].right.width } }).then(() => refresh()); }}
      onShow={(side) => { void attempt("settings.setShell", { [side]: { visible: true, width: shell.layouts[mode][side].width } }).then(() => refresh()); }}
      onStop={() => void stop()}
      sessions={modeSessions}
      conversations={conversations}
      currentSession={page === "agent" ? conversationId : boundSessionKey || undefined}
      sessionLabels={{
        heading: t("shell.opened"),
        empty: t("agent.sessionsNone"),
        active: t("session.active"),
        conversations: t("chat.list"),
        conversationsEmpty: t("chat.listEmpty"),
        groups: { novel: t("shelf.kind.novel"), comic: t("shelf.kind.comic"), video: t("shelf.kind.video") },
        position: (session) => sessionPositionLabel(session, t),
      }}
      onSession={openSession}
      onNewChat={() => { void newConversation(); }}
      right={chatView.pane}
      capsule={chatView.capsule}
      bottom={debugPanel}
    >
      <Toasts
        notice={notice?.text}
        error={error}
        sticky={restartRequired ? t("settings.restartRequired") : undefined}
        closeLabel={t("common.close")}
        onCloseNotice={() => setNoticeState(undefined)}
        onCloseError={() => setError(undefined)}
      />
      <div className="page-host">
        {page === "library" ? <div className="page-host" data-testid="page-library">{shelf(null)}</div> : null}
        {page === "agent" ? (
          <div className="page-host chat-page" data-testid="page-agent">
            {chatView.pane}
          </div>
        ) : null}
        {page === "reading" ? (
          reading ? (
            <ReadingPane
              document={{ ...reading, authorStyle }}
              style={{ ...shell.reading }}
              hits={novel.hits}
              bookmarks={novel.bookmarks}
              assets={novel.assetUrls}
              originalBytes={novel.originalBytes}
              highlight={novel.highlight}
              sourceCard={novel.sourceCard}
              onBack={() => backFromReader("novel", novel.workId)}
              onBackToNote={() => void novel.backToNote().then(() => setPage("notes"))}
              onRepair={() => void novel.repairNoteSource()}
              labelsExtra={{ backToNote: t("reading.sourceBack"), sourceResolved: t("reading.sourceResolved"), sourceNeedsReview: t("reading.sourceNeedsReview"), sourceMissing: t("reading.sourceMissing"), sourceRepair: t("reading.sourceRepair"), sourceCard: t("reading.sourceCard") }}
              t={t}
              labels={readingLabels(i18n)}
              searched={novel.searched}
              onSearch={(text) => void novel.search(text)}
              onJump={(partId, start, end) => {
                // A hit is pinned to the revision it was found in, which may not be the open one.
                const hit = novel.hits.find((entry) => entry.locator?.partId === partId && entry.locator.range.start === start) as { revisionId?: string } | undefined;
                void novel.openSlice(partId, Math.max(0, start - 200), { highlight: { start, end: Math.max(end, start) }, revisionId: hit?.revisionId });
              }}
              onProgress={() => void novel.markProgress()}
              onSelect={(quote, start, end, partId) => novel.selectText(quote, start, end, partId)}
              onMore={(partId, start) => void novel.openSlice(partId, start)}
              onPart={(partId, start) => void novel.openSlice(partId, start)}
              onStyle={(patch) => void novel.saveStyle(patch)}
              onBookmark={() => void novel.addBookmark()}
              onRemoveBookmark={(bookmarkId) => void novel.removeBookmark(bookmarkId)}
              onOpenBookmark={(bookmark) => void novel.openBookmark(bookmark as never)}
            />
          ) : <div className="page-host" data-testid="page-novel">{shelf("novel")}</div>
        ) : null}
        {page === "comic" ? (
          comic.doc ? (
            <ComicReader
              key={`${comic.doc.resourceId}:${comic.doc.revisionId}`}
              t={t}
              doc={comic.doc}
              settings={comic.settings}
              onSettings={comic.changeSettings}
              startPageId={comic.startPageId}
              focus={comic.focus}
              sourceCard={comic.sourceCard}
              next={comic.next}
              onBack={() => backFromReader("comic", comic.doc?.workId)}
              onNext={() => { if (comic.next) void comic.open(comic.next.resourceId, { workId: undefined }); }}
              onPage={comic.recordPages}
              onBackToNote={() => void comic.backToNote()}
              onRepair={() => void comic.repair()}
            />
          ) : comic.status === "loading" ? <p className="page-pad detail-muted" role="status" data-testid="page-comic-loading">{t("status.loading")}</p> : <div className="page-host" data-testid="page-comic">{shelf("comic")}</div>
        ) : null}
        {page === "video" ? (
          video.doc ? (
            <VideoPlayer
              key={`${video.doc.resourceId}:${video.doc.revisionId}`}
              t={t}
              doc={video.doc}
              settings={video.settings}
              onSettings={video.changeSettings}
              startMs={video.startMs}
              focus={video.focus}
              sourceCard={video.sourceCard}
              next={video.next}
              onBack={() => backFromReader("video", video.doc?.workId)}
              onNext={() => { if (video.next) void video.open(video.next.resourceId); }}
              onEpisode={(resourceId) => void video.open(resourceId)}
              onProgress={video.recordProgress}
              onBackToNote={() => void video.backToNote()}
              onRepair={() => void video.repair()}
              duck={recorder.duck}
            />
          ) : video.status === "loading" ? <p className="page-pad detail-muted" role="status" data-testid="page-video-loading">{t("status.loading")}</p> : <div className="page-host" data-testid="page-video">{shelf("video")}</div>
        ) : null}
        {page === "work" && workPage ? (
          <WorkHome
            t={t}
            workId={workPage.workId}
            facets={facets}
            formatDate={i18n.formatDate}
            initialTab={workPage.tab}
            onBack={backFromWork}
            onOpenResource={(resourceId, kind) => openResourceById(resourceId, kind, workPage.workId)}
            onOpenNote={openNotePage}
            onOpenWork={(workId) => openWorkPage(workId)}
            onOpenRecording={voiceOn ? (sessionId) => setReviewing({ sessionId, workId: workPage.workId }) : undefined}
            onLoaded={(info) => {
              setWorkInfo((current) => (current && current.workId === info.workId && current.title === info.title && current.author === info.author ? current : { workId: info.workId, title: info.title, author: info.author }));
              setWorkPage((current) => (current && current.workId === info.workId && !current.kind && info.mediaKind in PAGE_FOR_KIND ? { ...current, kind: info.mediaKind as WorkMediaKind } : current));
            }}
            onChanged={bump}
            onError={(message) => setError(message)}
            onNotice={setNotice}
          />
        ) : null}
        {page === "settings" ? (
          <SettingsView
            i18n={i18n}
            page={settingsPage}
            host={host}
            settings={settings}
            facets={facets}
            scan={scan}
            pkg={pkg}
            inventory={inventory}
            migration={migration}
            shell={shell}
            mode={mode}
            onMode={(next) => void changeMode(next)}
            onReading={(patch: ReadingStylePatch) => void novel.saveStyle(patch)}
            recording={{ settings: recorder.settings, save: recorder.saveSettings }}
            comic={{ settings: comic.settings, change: comic.changeSettings }}
            video={{ settings: video.settings, change: video.changeSettings }}
            onGoto={setSettingsPage}
            onImport={() => setImporting(true)}
            onModulesChanged={() => refresh()}
            onChanged={bump}
            onError={(message) => setError(message)}
            onNotice={setNotice}
            general={{
              onChooseLocation: () => void chooseLocation(),
              onPointerLocation: () => void window.manga.chooseDirectory().then(async (handle) => {
                if (!handle) return;
                await failing("settings.setLayout", { pointerPathHandle: handle });
                await refresh();
              }),
              onIndexedRoot: () => void window.manga.chooseDirectory().then(async (handle) => {
                if (!handle) return;
                await failing("library.indexExternal", { pathHandle: handle });
                await refresh();
              }),
              onApplyMigration: () => void applyMigration(),
              onCancelMigration: () => setMigration(null),
              onRollbackRecovery: () => void failing("settings.recoverJobs", { action: "rollback" }).then(() => refresh()),
              onRecoverJobs: () => void failing("settings.recoverJobs", { action: "recover" }).then(() => refresh()),
            }}
            models={{
              onRuntime: async (runtime) => { await failing("settings.setRuntime", { runtime }); await refresh(); },
              onSaveConnection: saveConnection,
              onDeleteConnection: async (connectionId) => { await failing("connections.delete", { connectionId }); await refresh(); },
              onTestConnection: async (connectionId, capability) => {
                if (await failing("connections.test", { connectionId, capability })) setNotice(t("settings.testConnection"));
                await refresh();
              },
              onSkip: () => void attempt("settings.skipAi").then(() => refresh()),
            }}
            storage={{
              onScan: () => void attempt("inventory.scan").then((item) => setInventory(item.ok ? item.value : null)),
              onCancelScan: () => void attempt("inventory.cancelScan", { scanId: "current" }),
              onTranscribe: () => void window.manga.chooseAudio().then(async (handle) => {
                if (!handle) return;
                const result = await attempt("library.transcribeAudio", { pathHandle: handle });
                if (!result.ok) setError(result.error.message);
                else setNotice(String(result.value.text ?? ""));
              }),
              onReveal: (itemId) => void window.manga.reveal(itemId).then((result) => { if (result.status === "error") setError(result.error?.message); }),
              onRepair: (itemId) => void failing("inventory.repair", { id: itemId }).then((ok) => { if (ok) void refresh(); }),
              onOpenCategory: (category) => goPage(category),
            }}
            records={{
              workId: recordsWork,
              onOpenNote: openNotePage,
              onOpenNoteSource: (objectId) => void openNoteSource(objectId),
              onOpenRecording: (sessionId, workId) => setReviewing({ sessionId, ...(workId ? { workId } : {}) }),
            }}
          />
        ) : null}
        {page === "notes" ? (
          <NotesPage
            i18n={i18n}
            onBack={backFromNotes}
            onOpenSource={(objectId, blockId) => void openNoteSource(objectId, blockId)}
            doc={notes.doc}
            renaming={notes.renaming}
            onRenaming={notes.setRenaming}
            onRename={(title, tags) => void notes.rename(title, tags)}
            history={notes.history}
            showHistory={notes.showHistory}
            onHistory={() => void notes.loadHistory()}
            onRestore={(revision) => void notes.restore(revision)}
            epoch={notes.epoch}
            focusBlock={notes.focusBlock}
            onSave={notes.save}
          />
        ) : null}
      </div>
      {reviewing && voiceOn ? (
        <Modal variant="drawer" testId="review-drawer" title={t("review.title")} closeLabel={t("review.close")} onClose={() => setReviewing(null)}>
          <RecordingReview
            t={t}
            scope={{ ...(reviewing.workId ? { workId: reviewing.workId } : reviewing.resourceId ? { resourceId: reviewing.resourceId } : {}) }}
            initialSessionId={reviewing.sessionId ?? null}
            formatDate={i18n.formatDate}
            onJump={(anchor) => void jumpToAnchor(anchor)}
            onOpenNote={(objectId) => { setReviewing(null); openNotePage(objectId); }}
          />
        </Modal>
      ) : null}
      {importing ? (
        <ImportDialog
          t={t}
          onClose={() => setImporting(false)}
          onImported={(workId, kind) => { setImporting(false); bump(); setNotice(t("import.done")); void refresh(); void workId; void kind; }}
          onError={(message) => setError(message)}
        />
      ) : null}
    </ShellFrame>
    </WorksCacheContext.Provider>
  );
}
