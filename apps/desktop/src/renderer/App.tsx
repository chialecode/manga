import { Activity, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_SHELL_PREFERENCE, type ReadingStylePatch, type ShellPreference, type WorkMode } from "@manga/contracts/reading";
import type { SegmentAnchor } from "@manga/contracts/media";
import { createTranslator, type Locale, type MessageKey } from "@manga/i18n";
import { composerKeyFor, draftKeyFor, manualMaterialsApply, resolveAgentSurface } from "./agent-surface.ts";
import { ShellFrame, type ShellSession } from "./shell.tsx";
import type { MenuItem } from "./components/menu.tsx";
import { canBack, canForward, emptyHistory, step, visit, type NavHistory, type NavLocation } from "./lib/nav-history.ts";
import { ReadingPane } from "./reading.tsx";
import { ComicReader } from "./readers/comic-reader.tsx";
import { VideoPlayer } from "./readers/video-player.tsx";
import { NotesPage } from "./pages/notes-page.tsx";
import { Shelf } from "./pages/shelf.tsx";
import { WorkHome } from "./pages/work-home.tsx";
import { OpenBlockedDialog, type OpenBlock } from "./pages/open-blocked-dialog.tsx";
import { ProjectsPage } from "./pages/projects/projects-page.tsx";
import { DownloadsPage } from "./pages/downloads/downloads-page.tsx";
import { ProjectPage, type ProjectTab } from "./pages/projects/project-page.tsx";
import { renderCreativeTab } from "./pages/projects/creative-tabs.tsx";
import type { SemanticHitView } from "./lib/semantic-model.ts";
import { AddToProject } from "./components/add-to-project.tsx";
import { AddToRoughcut } from "./components/add-to-roughcut.tsx";
import { ConversationBar } from "./components/conversation-bar.tsx";
import { DebugPanel, loadDebugView, saveDebugView, useNoticeLog, type DebugView } from "./pages/debug-panel.tsx";
import { SettingsNav } from "./pages/settings/settings-nav.tsx";
import { SettingsView, hiddenSettingsPages } from "./pages/settings/settings-view.tsx";
import { Modal } from "./components/modal.tsx";
import { Toasts } from "./components/toast.tsx";
import { MatchHost } from "./pages/work-match.tsx";
import { useWorkLinked } from "./lib/use-work-linked.ts";
import { TitleActions } from "./components/title-actions.tsx";
import { useChatView } from "./components/chat/chat-view.tsx";
import { RecordingReview } from "./voice/review-panel.tsx";
import { useRecorder } from "./voice/use-recorder.ts";
import { useComic } from "./hooks/use-comic.ts";
import { useNotes } from "./hooks/use-notes.ts";
import { useVideo } from "./hooks/use-video.ts";
import { readerHeading, useNovel } from "./hooks/use-novel.ts";
import { usePackage } from "./hooks/use-package.ts";
import { useScan } from "./hooks/use-scan.ts";
import { useScreenshots, type RichNotice } from "./hooks/use-screenshots.tsx";
import { asArray, attempt, uid as id, type HostState } from "./lib/api.ts";
import { WorksCacheContext, type WorksCache } from "./lib/use-works.ts";
import { readingLabels } from "./lib/labels.ts";
import { emptyComposer, type AttachedImage, type ComposerState, type ConnectionForm } from "./lib/types.ts";
import { mediaContextFor, readerContext, type ReaderContext } from "./lib/reader-context.ts";
import { useVideoFacts } from "./lib/video-facts.ts";
import { quoteTags, type QuoteTag } from "./lib/quote-tags.ts";
import { profilePatch } from "./lib/model-profile.ts";
import { sessionPositionLabel, type SettingsPageId } from "./lib/shell-model.ts";
import { PAGE_FOR_KIND, type ShelfState, type WorkMediaKind, type WorkSummary } from "./lib/works.ts";
import { READER_PAGES, initialView, navigablePages, projectWorkspace, usableView, type ModeView, type OpenedResource, type WorkPageState } from "./lib/mode-view.ts";
import { ProjectOverviewPage } from "./pages/projects/project-overview.tsx";
import { WindowFullscreenProvider, useWindowFullscreenKeys, type WindowFullscreen } from "./readers/window-fullscreen.tsx";
import { useKeyBindings } from "./hooks/use-key-bindings.ts";
import { KeyTableProvider } from "./lib/key-table.tsx";
import { chordOf } from "@manga/contracts/keys";
import type { MigrationPlan } from "./pages/settings/general-page.tsx";
import type { PlainTestResult, SaveConnectionResult } from "./pages/settings/connection-dialog.tsx";

type SessionKind = "resource" | "project" | "note" | "work";

const NOTICE_MS = 5000;
/** A notice that carries follow-ups (a screenshot just taken) stays long enough to use them. */
const RICH_NOTICE_MS = 10_000;
/** A place is entered in the page history once it has stood this long, so a page that is still loading is not a place of its own. */
const NAV_SETTLE_MS = 90;

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
  const [notice, setNoticeState] = useState<{ text: string; n: number; action?: { label: string; onClick: () => void }; rich?: RichNotice } | undefined>();
  /** The work whose Bangumi match dialog is open over the current page, and a counter that says a match may have changed. */
  const [matching, setMatching] = useState<string | null>(null);
  const [matchVersion, setMatchVersion] = useState(0);
  const [inventory, setInventory] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [migration, setMigration] = useState<(MigrationPlan) | null>(null);
  const [viewport, setViewport] = useState({ width: window.innerWidth || 1280, height: window.innerHeight || 840 });
  const [sessions, setSessions] = useState<ShellSession[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  /** Changes when the conversation list may have changed, so an open history panel reads it again. */
  const [conversationVersion, setConversationVersion] = useState(0);
  const [pendingMode, setPendingMode] = useState<WorkMode | null>(null);
  /** The projects page: no project open is the list. `focus` names an object of the project another tab was asked to show. */
  const [projectView, setProjectView] = useState<{ projectId: string | null; tab: ProjectTab; focus: { kind: string; id: string } | null }>({ projectId: null, tab: "materials", focus: null });
  const [projectName, setProjectName] = useState("");
  /** Changes when a project may have changed (a material added from another page), so the open page reads it again. */
  const [projectsVersion, setProjectsVersion] = useState(0);
  const [shelfKey, setShelfKey] = useState(0);
  const [worksCache] = useState<WorksCache>(() => new Map());
  const [reviewing, setReviewing] = useState<{ sessionId?: string; workId?: string; resourceId?: string } | null>(null);
  const [recordsWork, setRecordsWork] = useState<string | null>(null);
  const [debugView, setDebugView] = useState<DebugView>(() => loadDebugView("shell"));
  const [navHistory, setNavHistory] = useState<NavHistory>(emptyHistory);
  /** The place the window is at, until it has stayed long enough to go into the history; back and forward count it as the place they start from. */
  const [navPending, setNavPending] = useState<NavLocation | null>(null);
  const navTimer = useRef<number | null>(null);
  const navShown = navPending ? visit(navHistory, navPending) : navHistory;
  const [aboutOpen, setAboutOpen] = useState(false);
  /** The resource that was asked to open and cannot: outside every library path, or its file is gone (A-86). */
  const [openBlock, setOpenBlock] = useState<OpenBlock | null>(null);
  const viewRequest = useRef(0);
  const started = useRef(false);

  const setNotice = useCallback((message?: string, action?: { label: string; onClick: () => void }) => setNoticeState((current) => (message ? { text: message, n: (current?.n ?? 0) + 1, ...(action ? { action } : {}) } : undefined)), []);
  const setRichNotice = useCallback((message: string, rich: RichNotice) => setNoticeState((current) => ({ text: message, n: (current?.n ?? 0) + 1, rich })), []);
  const bump = useCallback(() => setShelfKey((key) => key + 1), []);
  // A result is told for a few seconds and goes away; a new one restarts the time.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNoticeState(undefined), notice.rich ? RICH_NOTICE_MS : NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice?.n]);

  const scan = useScan(Boolean(host?.writable));
  const notes = useNotes({ i18n, setError, setNotice, bindSession: (kind, target) => ensureBoundSession(kind, target) });
  const novel = useNovel({ i18n, setError, setNotice, setPage, viewRequest, ensureBoundSession, openNote: notes.open, refresh: () => refresh() });
  const comic = useComic({ i18n, setError, setNotice, setPage, viewRequest, ensureBoundSession, openNote: notes.open, refresh: () => refresh() });
  const video = useVideo({ i18n, setError, setNotice, setPage, viewRequest, ensureBoundSession, openNote: notes.open, refresh: () => refresh() });
  const pkg = usePackage({ i18n, setError, setNotice, refresh: () => refresh() });
  const shots = useScreenshots({ i18n, setError, setRichNotice, setNotice });
  const voiceOn = ((workspace?.uiFacets as string[] | undefined) ?? []).includes("voice");
  const recorder = useRecorder({ i18n, setError, setNotice, enabled: voiceOn });
  const noticeLog = useNoticeLog();
  const videoNow = useVideoFacts();
  // Settings is entered from a page and returns to it; while it is open the page behind it (its reader, its right pane) is still the context.
  const contentPage = page === "settings" ? settingsReturn.current : page;
  const keyBindings = useKeyBindings();
  const keyTable = keyBindings.table;
  // Window full screen (A-78) belongs to the reader in front: it ends when the person leaves the reader (or goes to settings).
  const [windowFullscreen, setWindowFullscreen] = useState(false);
  const readerFront = READER_PAGES.has(page);
  const immersive = windowFullscreen && readerFront;
  useEffect(() => { if (!readerFront) setWindowFullscreen(false); }, [readerFront]);
  const toggleWindowFullscreen = useCallback(() => setWindowFullscreen((on) => !on), []);
  const exitWindowFullscreen = useCallback(() => setWindowFullscreen(false), []);
  useWindowFullscreenKeys({ enabled: readerFront, active: immersive, toggleKeys: keyTable["global.windowFullscreen"] ?? [], toggle: toggleWindowFullscreen, exit: exitWindowFullscreen });
  const windowFullscreenState = useMemo<WindowFullscreen>(() => ({ active: immersive, toggle: toggleWindowFullscreen, exit: exitWindowFullscreen }), [immersive, toggleWindowFullscreen, exitWindowFullscreen]);
  const readerWorkId = contentPage === "comic" ? comic.doc?.workId : contentPage === "video" ? video.doc?.workId : contentPage === "reading" ? novel.workId : null;
  const readerLinked = useWorkLinked(readerWorkId, ((workspace?.uiFacets as string[] | undefined) ?? []).includes("metadata"), matchVersion);
  // Offered in the reader's title only while the work is known and not linked.
  const matchFromReader = readerWorkId && readerLinked === false ? () => setMatching(readerWorkId) : undefined;

  const shellMode = ((workspace?.shell as ShellPreference | undefined) ?? DEFAULT_SHELL_PREFERENCE).mode;
  // A mode click updates the draft and the rail before the settings round trip returns.
  const mode = pendingMode ?? shellMode;
  const facets = new Set((workspace?.uiFacets as string[] | undefined) ?? ["agent", "library", "settings"]);
  /** The work mode with projects: no shelves of its own, a project overview in their place, and its resources opened from project materials. */
  const workMode = projectWorkspace(mode, facets);
  const reading = novel.visible ? novel.reading : null;
  const mediaOpen = contentPage === "comic" && comic.doc
    ? { resourceId: comic.doc.resourceId, revisionId: comic.doc.revisionId, title: comic.doc.title, workId: comic.doc.workId ?? null }
    : contentPage === "video" && video.doc
      ? { resourceId: video.doc.resourceId, revisionId: video.doc.revisionId, title: video.doc.title, workId: video.doc.workId ?? null }
      : contentPage === "reading" && reading
        ? { resourceId: reading.resourceId, revisionId: reading.revisionId, title: reading.title, workId: novel.workId }
        : null;
  const work = contentPage === "work" && workPage ? { workId: workPage.workId, title: workInfo?.workId === workPage.workId ? workInfo.title : "" } : null;
  const surface = resolveAgentSurface({
    page: contentPage,
    sessionId: conversationId,
    mode,
    sessions,
    reading: mediaOpen,
    note: notes.doc ? { objectId: notes.doc.objectId, revision: notes.doc.revision, title: notes.doc.title, resourceId: notes.doc.resourceId } : null,
    work,
    project: (contentPage === "projects" || (workMode && READER_PAGES.has(contentPage))) && projectView.projectId ? { projectId: projectView.projectId, name: projectName } : null,
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
    // The conversation that is shown is the mode's current one (A-65); another mode's id is not a fallback.
    const shown = await attempt<{ conversation: { sessionId: string } | null }>("conversation.current", { mode: loadedMode });
    const shared = rows.filter((row) => row.kind === "shared");
    setConversationId((current) => {
      if (shown.ok && shown.value.conversation) return shown.value.conversation.sessionId;
      return current && shared.some((row) => row.sessionId === current) ? current : shared[0]?.sessionId;
    });
    const st = await attempt("settings.get");
    if (st.ok) setSettings(st.value);
    setShelfKey((key) => key + 1);
  }

  /** Each mode's own view, kept while the other mode is in front (A-77). */
  const views = useRef<Partial<Record<WorkMode, ModeView>>>({});
  /** A resource the mode being returned to had open, that settings (which the switch was made from) will open when it is closed. */
  const pendingOpened = useRef<OpenedResource | null>(null);

  /** Where the person is in the current mode: the page, what is open on it, and the history that led here. */
  function snapshotView(): ModeView {
    const at = contentPage;
    const opened: OpenedResource | null = pendingOpened.current
      ?? (at === "comic" && comic.doc ? { resourceId: comic.doc.resourceId, mediaKind: "comic", workId: comic.doc.workId ?? null }
        : at === "video" && video.doc ? { resourceId: video.doc.resourceId, mediaKind: "video", workId: video.doc.workId ?? null }
          : at === "reading" && reading ? { resourceId: reading.resourceId, mediaKind: "novel", workId: novel.workId ?? null }
            : null);
    return { page: at, workPage, projectView, projectName, opened, noteId: at === "notes" && notes.doc ? notes.doc.objectId : null, notesReturn: notesReturn.current, history: navShown };
  }

  /** Brings a mode's view back. The reader keeps whatever it holds when that is what the view had open; otherwise the resource is opened again at its saved place. */
  function applyView(view: ModeView) {
    setWorkPage(view.workPage);
    setProjectView(view.projectView as typeof projectView);
    setProjectName(view.projectName);
    notesReturn.current = view.notesReturn;
    if (navTimer.current !== null) { window.clearTimeout(navTimer.current); navTimer.current = null; }
    setNavPending(null);
    setNavHistory(view.history);
    const target = view.page;
    const wanted = view.opened;
    const held = wanted === null ? false
      : wanted.mediaKind === "comic" ? comic.doc?.resourceId === wanted.resourceId
        : wanted.mediaKind === "video" ? video.doc?.resourceId === wanted.resourceId
          : reading?.resourceId === wanted.resourceId;
    const reopen = wanted !== null && READER_PAGES.has(target) && !held ? wanted : null;
    if (page === "settings") {
      // Settings is shared: a mode switch made there stays there, and the page behind it is the other mode's.
      settingsReturn.current = target;
      pendingOpened.current = reopen;
    } else {
      pendingOpened.current = null;
      setPage(target);
      if (reopen) void openResourceById(reopen.resourceId, reopen.mediaKind, reopen.workId, { silent: true });
    }
    if (target === "notes" && view.noteId && notes.doc?.objectId !== view.noteId) void notes.open(view.noteId);
  }

  async function changeMode(next: WorkMode) {
    if (next === mode) return;
    const previous = snapshotView();
    views.current[mode] = previous;
    setPendingMode(next);
    setRun(null);
    applyView(usableView(views.current[next] ?? initialView(), next, facets));
    const result = await attempt("settings.setShell", { mode: next });
    if (!result.ok) {
      // The switch did not stick, so the previous mode's view, draft and run stay where they were.
      setPendingMode(null);
      applyView(previous);
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

  // A library path was removed: what was open from it closes with a word about it, the rail stops listing those resources, and the shelf is read again (A-86).
  const onPathRemoved = useRef<(resourceIds: string[]) => void>(() => {});
  onPathRemoved.current = (resourceIds) => {
    const gone = new Set(resourceIds);
    if (mediaOpen && gone.has(mediaOpen.resourceId)) {
      const kind = contentPage === "comic" ? "comic" : contentPage === "video" ? "video" : "novel";
      closeReaders();
      goPage(PAGE_FOR_KIND[kind]);
      setNotice(t("open.removedNotice", { title: mediaOpen.title }));
    }
    void attempt("workspace.sessions", { mode }).then((list) => { if (list.ok) { setSessions(asArray<ShellSession>(list.value)); setSessionsLoaded(true); } });
    bump();
  };
  // Conversations were deleted (A-89): the one on screen is replaced by a new one, the rail and the history stop listing them.
  const onConversationsDeleted = useRef<(removed: string[], replaced: Partial<Record<WorkMode, { sessionId: string }>>) => void>(() => {});
  onConversationsDeleted.current = (removed, replaced) => {
    const gone = new Set(removed);
    const shown = boundSessionKey && gone.has(boundSessionKey) ? boundSessionKey : null;
    if (conversationId && gone.has(conversationId)) {
      setConversationId(replaced[mode]?.sessionId);
      setRun(null);
    } else if (shown) {
      setRun(null);
    }
    setConversationVersion((value) => value + 1);
    void attempt("workspace.sessions", { mode }).then((list) => { if (list.ok) { setSessions(asArray<ShellSession>(list.value)); setSessionsLoaded(true); } });
    // A conversation bound to the page that is open is replaced by a new one for the same target, so the right pane is never left without one.
    if (shown && surface.open) void ensureBoundSession(surface.open.kind, surface.open.targetId);
  };
  useEffect(() => {
    const off = window.manga.onNotice?.((item) => {
      if (item.topic === "library.pathRemoved") onPathRemoved.current(asArray<string>(item.payload.resourceIds));
      if (item.topic === "conversation.deleted") onConversationsDeleted.current(asArray<string>(item.payload.sessionIds), (item.payload.replaced ?? {}) as Partial<Record<WorkMode, { sessionId: string }>>);
    });
    return () => { off?.(); };
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

  /** "开启新对话": the conversation that is current moves into the history and a new one takes its place (an empty one is reused). */
  async function newConversation(announce = false): Promise<string | undefined> {
    const created = await attempt<{ sessionId: string; reused: boolean }>("conversation.new", { mode });
    if (!created.ok) { setError(created.error.message); return undefined; }
    const next = created.value.sessionId;
    if (!next) return undefined;
    setConversationId(next);
    const list = await attempt("workspace.sessions", { mode });
    if (list.ok) { setSessions(asArray<ShellSession>(list.value)); setSessionsLoaded(true); }
    setRun(null);
    setConversationVersion((value) => value + 1);
    if (announce) setNotice(t("conversation.started"));
    return next;
  }

  /** A conversation from the history is shown and continued: it becomes the current one. */
  async function resumeConversation(sessionId: string): Promise<void> {
    const resumed = await attempt<{ conversation: { sessionId: string; title: string } }>("conversation.resume", { sessionId });
    if (!resumed.ok) { setError(resumed.error.message); return; }
    setConversationId(resumed.value.conversation.sessionId);
    setRun(null);
    setConversationVersion((value) => value + 1);
    await refresh();
    setNotice(t("conversation.resumed", { title: resumed.value.conversation.title }));
  }

  /** Open (or reuse) the session that belongs to the current reading target so tasks never cross targets. */
  async function ensureBoundSession(wanted: SessionKind, wantedId: string, request?: number): Promise<string | undefined> {
    const boundMode = mode;
    // A resource opened from a project's materials is talked about in the project's conversation; the work mode keeps no conversation per file.
    const ownedBy = workMode && wanted === "resource" ? projectView.projectId : null;
    const kind: SessionKind = ownedBy ? "project" : wanted;
    const targetId = ownedBy ?? wantedId;
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

  /** Saves in one command so a refused number leaves nothing half saved; the answer goes back to the dialog, which shows it beside the form. */
  async function saveConnection(fields: ConnectionForm): Promise<SaveConnectionResult> {
    // Only what the person changed in the model's numbers and switches is saved as theirs; a number left alone keeps where it came from.
    const patch = fields.profile && fields.profileBefore ? profilePatch(fields.profileBefore, fields.profile) : {};
    const credentialHandle = fields.secret ? await window.manga.stashSecret(fields.secret) : undefined;
    const saved = await attempt<{ id: string }>("connections.upsert", {
      id: fields.id,
      label: fields.label,
      protocol: fields.protocol,
      runtime: fields.runtime,
      baseUrl: fields.baseUrl,
      modelId: fields.modelId,
      purpose: fields.purpose,
      timeoutMs: Number(fields.timeoutMs) || 60_000,
      credentialHandle,
      ...(Object.keys(patch).length > 0 && (fields.purpose === "text" || fields.purpose === "vision") ? { profile: patch } : {}),
    });
    if (!saved.ok) return { ok: false, message: saved.error.message };
    setError(undefined);
    setNotice(t("settings.connectionSaved"));
    await refresh();
    return { ok: true, id: saved.value.id };
  }

  /** A test of a connection that is not asked questions, answered in words about what to fix rather than as a code. */
  async function testPlainConnection(connectionId: string, capability: string): Promise<PlainTestResult> {
    const result = await attempt("connections.test", { connectionId, capability });
    await refresh();
    if (result.ok) return { ok: true, message: t("models.plain.ok") };
    const { code } = result.error;
    const status = Number((result.error.details as { status?: unknown } | undefined)?.status ?? 0);
    const reason = code === "AUTHENTICATION_FAILED" || status === 401 || status === 403 ? "auth"
      : status === 404 ? "address"
      : code === "MODEL_CAPABILITY_MISSING" ? "capability"
      : code === "PROVIDER_UNAVAILABLE" || code === "CANCELLED" ? "network"
      : "other";
    return { ok: false, message: t("models.plain.fail", { message: t(`models.plain.reason.${reason}` as MessageKey) }) };
  }

  /** One question to the model; what it found and what failed is kept with the connection and shown under it. */
  async function probeConnection(connectionId: string) {
    const result = await attempt("connections.probe", { connectionId });
    if (!result.ok) setError(result.error.message);
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
    if (page !== "settings") { settingsReturn.current = page; pendingOpened.current = null; }
    if (target) setSettingsPage(target);
    setPage("settings");
  }

  function closeSettings() {
    const back = settingsReturn.current === "settings" ? "library" : settingsReturn.current;
    const pending = pendingOpened.current;
    pendingOpened.current = null;
    if (pending && READER_PAGES.has(back)) { void openResourceById(pending.resourceId, pending.mediaKind, pending.workId, { silent: true }); return; }
    setPage(back);
  }

  function openWorkPage(workId: string, options: { kind?: WorkMediaKind | null; tab?: "cover" | "match" } = {}) {
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
    // In the work mode a resource was opened from a project; back is that project.
    if (workMode && projectView.projectId) { setWorkPage(null); setPage("projects"); return; }
    if (workId) { openWorkPage(workId, { kind }); return; }
    goPage(PAGE_FOR_KIND[kind]);
  }

  /**
   * The one question asked before any resource is opened (A-86): the main process says whether its file can be opened. If it cannot, nothing is
   * opened and the page does not change; the person is told why, with what to do about it. A restore (`silent`) stays where it is and says nothing.
   * An answer that is not a refusal lets the open go on: the main process refuses what it must in any case.
   */
  async function openGate(resourceId: string, options: { silent?: boolean } = {}): Promise<boolean> {
    const result = await attempt<Partial<OpenBlock> & { state?: string }>("library.openable", { resourceId });
    if (!result.ok || (result.value.state !== "outside" && result.value.state !== "missing")) return true;
    if (!options.silent) setOpenBlock({ ...result.value, resourceId, mediaKind: String(result.value.mediaKind ?? "novel"), title: String(result.value.title ?? ""), workId: result.value.workId ?? null, state: result.value.state } as OpenBlock);
    return false;
  }

  async function openResourceById(resourceId: string, kind: WorkMediaKind | null | undefined, workId: string | null, options: { silent?: boolean } = {}): Promise<void> {
    if (!(await openGate(resourceId, options))) return;
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
  /** A project's page, on the tab asked for. Its conversation is opened with it, so the rail lists it and the right pane is bound to it. */
  function openProject(projectId: string, tab: ProjectTab = "materials", focus: { kind: string; id: string } | null = null) {
    closeReaders();
    setWorkPage(null);
    setProjectView({ projectId, tab, focus });
    setPage("projects");
    void ensureBoundSession("project", projectId);
  }

  /** A material of a project opens where its kind is shown: a work's page, a reader, a note, a recording's review, or the project's own tab. */
  function openProjectMaterial(material: { kind: string; targetId: string; opens?: { resourceId: string; mediaKind: string; workId: string | null; position?: { kind: "temporal"; startMs: number } | { kind: "image"; pageId: string } } }) {
    if (material.kind === "work") { openWorkPage(material.targetId); return; }
    if (material.kind === "note") { openNotePage(material.targetId); return; }
    if (material.kind === "recording") { setReviewing({ sessionId: material.targetId }); return; }
    // A screenshot opens its source at the moment or the page it was taken from.
    if (material.kind === "screenshot" && material.opens?.position) {
      void jumpToAnchor({ resourceId: material.opens.resourceId, locator: material.opens.position } as never);
      return;
    }
    if ((material.kind === "resource" || material.kind === "anchor" || material.kind === "screenshot") && material.opens) {
      openResourceById(material.opens.resourceId, material.opens.mediaKind as WorkMediaKind, material.opens.workId);
      return;
    }
    const tab = ({ whiteboard: "whiteboard", mindmap: "mindmap", draft: "draft", excerpt: "excerpt", roughcut: "roughcut" } as Record<string, ProjectTab>)[material.kind];
    if (tab) setProjectView((view) => ({ ...view, tab, focus: { kind: material.kind, id: material.targetId } }));
  }

  /** A screenshot opens its source at the moment or the page it was taken from. */
  async function openScreenshot(screenshotId: string) {
    const found = await attempt<{ screenshot: { resourceId: string; resourceRevisionId: string; mediaKind: string; positionMs: number | null; pageId: string | null } }>("screenshot.get", { screenshotId });
    if (!found.ok) { setError(found.error.message); return; }
    const shot = found.value.screenshot;
    const locator = shot.mediaKind === "video" && shot.positionMs !== null ? { kind: "temporal" as const, startMs: shot.positionMs } : shot.pageId ? { kind: "image" as const, pageId: shot.pageId } : null;
    if (!locator) { setError(t("screenshot.block.gone")); return; }
    await jumpToAnchor({ resourceId: shot.resourceId, resourceRevisionId: shot.resourceRevisionId, locator } as never);
  }

  /** A passage the semantic search found, opened at its place: the book at the locator, the note at its block, the recording at its review. */
  function openSemanticHit(hit: SemanticHitView) {
    if (hit.kind === "note" && hit.objectId) { openNotePage(hit.objectId, hit.blockId); return; }
    if (hit.kind === "recording" && hit.sessionId) { setReviewing({ sessionId: hit.sessionId }); return; }
    if (hit.kind === "body" && hit.resourceId && hit.locator) void jumpToAnchor({ resourceId: hit.resourceId, resourceRevisionId: hit.revisionId, locator: hit.locator } as never);
  }

  function openNotePage(objectId: string, focusBlockId?: string) {
    if (page !== "notes") notesReturn.current = { page, workPage };
    void notes.open(objectId, focusBlockId);
    setPage("notes");
  }

  /** What an embed points at, opened where that kind lives: a note on its page, a board or a map on its tab of the project that owns it. */
  async function openEmbedTarget(item: { targetKind: string; targetId: string; locator: { blockId?: string; nodeId?: string } }) {
    if (item.targetKind === "note") { openNotePage(item.targetId, item.locator.blockId); return; }
    const found = item.targetKind === "whiteboard"
      ? await attempt<{ board: { projectId: string | null } }>("whiteboard.get", { boardId: item.targetId })
      : await attempt<{ map: { projectId: string | null } }>("mindmap.get", { mapId: item.targetId });
    if (!found.ok) { setError(found.error.message); return; }
    const projectId = item.targetKind === "whiteboard" ? (found.value as { board: { projectId: string | null } }).board.projectId : (found.value as { map: { projectId: string | null } }).map.projectId;
    if (!projectId) { setError(t("embed.state.deleted")); return; }
    closeReaders();
    setWorkPage(null);
    setProjectView({ projectId, tab: item.targetKind === "whiteboard" ? "whiteboard" : "mindmap", focus: { kind: item.targetKind, id: item.targetId } });
    setPage("projects");
    void ensureBoundSession("project", projectId);
  }

  function backFromNotes() {
    notes.close();
    const from = notesReturn.current;
    notesReturn.current = null;
    if (!from) { setSettingsPage("records"); setPage("settings"); return; }
    setWorkPage(from.page === "work" ? from.workPage : null);
    setPage(from.page === "work" && !from.workPage ? "library" : from.page);
  }

  /** One place of the page history, brought back: the page, the work, the resource at its saved place, the settings page, the note, the project. */
  function goLocation(to: NavLocation) {
    switch (to.kind) {
      case "page": goPage(to.page); return;
      case "work": openWorkPage(to.workId); return;
      case "resource": openResourceById(to.resourceId, to.mediaKind, to.workId); return;
      case "settings": openSettings(to.page as SettingsPageId); return;
      case "note": openNotePage(to.objectId); return;
      case "project":
        if (to.projectId) { openProject(to.projectId, to.tab as ProjectTab); return; }
        closeReaders();
        setWorkPage(null);
        setProjectView({ projectId: null, tab: "materials", focus: null });
        setProjectName("");
        setPage("projects");
        return;
    }
  }

  function navStep(direction: -1 | 1) {
    // A place that has not settled yet is where the step starts from: going back from a page just opened goes to the page before it.
    if (navTimer.current !== null) window.clearTimeout(navTimer.current);
    navTimer.current = null;
    setNavPending(null);
    const next = step(navShown, direction);
    if (!next) { setNavHistory(navShown); return; }
    setNavHistory(next.history);
    goLocation(next.to);
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
    if (session.kind === "project" && session.targetId) {
      openProject(session.targetId);
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
    if (probe.ok && probe.value.resourceId && !(await openGate(probe.value.resourceId))) return;
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
    if (resourceId && locator && !(await openGate(resourceId))) return;
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

  /**
   * Takes an entry off the rail (A-74). Only the list changes: the resource, project or conversation, its notes and its place stay, and
   * opening it again lists it again. What was open under it is left: the reader goes back to the work (or the shelf), a project's page to the list.
   */
  async function closeRailSession(session: ShellSession) {
    const closed = await attempt("session.close", { sessionId: session.sessionId });
    if (!closed.ok) { setError(closed.error.message); return; }
    if (session.kind === "resource" && session.targetId && mediaOpen?.resourceId === session.targetId) {
      backFromReader((session.mediaKind as WorkMediaKind | null | undefined) ?? "novel", mediaOpen.workId);
    } else if (session.kind === "project" && page === "projects" && projectView.projectId === session.targetId) {
      setProjectView({ projectId: null, tab: "materials", focus: null });
      setProjectName("");
    } else if (conversationId === session.sessionId) {
      setConversationId(undefined);
      setRun(null);
    }
    const list = await attempt("workspace.sessions", { mode });
    if (list.ok) { setSessions(asArray<ShellSession>(list.value)); setSessionsLoaded(true); }
    setNotice(t("session.closed", { title: session.title }));
  }

  /** A column's width, kept per mode: shown at once, then saved. */
  async function resizeSide(side: "left" | "right", width: number) {
    setWorkspace((current) => {
      const shown = current?.shell as ShellPreference | undefined;
      if (!current || !shown) return current;
      const next = structuredClone(shown);
      next.layouts[next.mode][side].width = width;
      return { ...current, shell: next };
    });
    const saved = await attempt<ShellPreference>("settings.setShell", { [side]: { width } });
    if (!saved.ok) { setError(saved.error.message); void refresh(); }
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
  const debugKeysRef = useRef<readonly string[]>([]);
  debugKeysRef.current = keyTable["global.debug"] ?? [];
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const chord = chordOf(event);
      if (chord !== null && debugKeysRef.current.includes(chord)) { event.preventDefault(); toggleDebugRef.current(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---- the window's page history (A-70) ---------------------------------------------------------------------
  const here: NavLocation | null = (() => {
    if (page === "settings") return { kind: "settings", page: settingsPage };
    if (page === "work") return workPage ? { kind: "work", workId: workPage.workId } : null;
    if (page === "notes") return notes.doc ? { kind: "note", objectId: notes.doc.objectId } : null;
    if (page === "projects") return { kind: "project", projectId: projectView.projectId, tab: projectView.tab };
    if (page === "comic") return comic.doc ? { kind: "resource", resourceId: comic.doc.resourceId, mediaKind: "comic", workId: comic.doc.workId ?? null } : comic.status === "loading" ? null : { kind: "page", page };
    if (page === "video") return video.doc ? { kind: "resource", resourceId: video.doc.resourceId, mediaKind: "video", workId: video.doc.workId ?? null } : video.status === "loading" ? null : { kind: "page", page };
    if (page === "reading") return reading ? { kind: "resource", resourceId: reading.resourceId, mediaKind: "novel", workId: novel.workId ?? null } : { kind: "page", page };
    return { kind: "page", page };
  })();
  const hereFacts = JSON.stringify(here);
  useEffect(() => {
    if (!here) return;
    const at = here;
    setNavPending(at);
    const timer = window.setTimeout(() => {
      navTimer.current = null;
      setNavPending(null);
      setNavHistory((history) => visit(history, at));
    }, NAV_SETTLE_MS);
    navTimer.current = timer;
    return () => { window.clearTimeout(timer); if (navTimer.current === timer) navTimer.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hereFacts]);
  const navStepRef = useRef(navStep);
  navStepRef.current = navStep;
  useEffect(() => {
    const editable = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.shiftKey || event.metaKey || event.isComposing || editable(event.target)) return;
      if (event.key === "ArrowLeft") { event.preventDefault(); navStepRef.current(-1); }
      else if (event.key === "ArrowRight") { event.preventDefault(); navStepRef.current(1); }
    };
    // The mouse's side buttons walk the history too.
    const onMouse = (event: MouseEvent) => {
      if (event.button === 3) { event.preventDefault(); navStepRef.current(-1); }
      else if (event.button === 4) { event.preventDefault(); navStepRef.current(1); }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mouseup", onMouse);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mouseup", onMouse); };
  }, []);

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
  const chatPage = contentPage === "work" ? "work" : mediaOpen ? contentPage : contentPage === "agent" ? "agent" : contentPage === "notes" ? "notes" : "library";

  const chatView = useChatView({
    i18n,
    page: chatPage,
    target: {
      sessionId: boundSessionKey || undefined,
      resourceId: mediaOpen?.resourceId,
      revisionId: mediaOpen?.revisionId,
      workId: contentPage === "work" ? workPage?.workId : mediaOpen?.workId,
      title: mediaOpen?.title ?? (contentPage === "work" ? workInfo?.title : undefined),
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
    workTitle: contentPage === "work" ? workInfo?.title : mediaOpen?.title,
    author: contentPage === "work" ? workInfo?.author : null,
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
    header: page === "agent"
      ? (
        <ConversationBar
          t={t}
          mode={mode}
          title={sessions.find((item) => item.sessionId === conversationId)?.title ?? ""}
          version={conversationVersion}
          formatDate={i18n.formatDate}
          onNew={async () => { await newConversation(true); }}
          onResume={(sessionId) => resumeConversation(sessionId)}
          onError={setError}
        />
      )
      : surface.label ? <div className="chat-context" data-testid="chat-context" title={surface.label}>{surface.label}</div> : undefined,
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
  const pageLabels: Record<string, string> = {
    library: workMode ? t("nav.projectOverview") : t("nav.overview"), agent: t("nav.agent"), projects: t("nav.projects"), reading: t("nav.novel"), comic: t("nav.comic"),
    video: t("nav.video"), downloads: t("nav.downloads"), settings: t("nav.settings"),
  };
  const pages = navigablePages(mode, facets).map((id) => ({ id, label: pageLabels[id] ?? id, testId: `nav-${id}` }));
  const inSettings = page === "settings";
  // A work's page is shown under the shelf it was opened from.
  const shelfPage = page === "work" ? (workPage?.kind ? PAGE_FOR_KIND[workPage.kind] : workPage?.from && workPage.from !== "work" ? workPage.from : "library") : page === "notes" ? "library" : page;
  // The work mode has no shelves: a work or a resource there was reached from a project.
  const shellPage = workMode && (READER_PAGES.has(shelfPage) || page === "work") ? "projects" : shelfPage;
  const contentHasRight = contentPage !== "agent" && contentPage !== "downloads";
  const hasRight = !inSettings && contentHasRight;
  /** The right pane stays alive in the background while settings is open, so its scroll place, panels and draft are as they were. */
  const retainRight = inSettings && contentHasRight;
  const title = inSettings ? t("nav.settings")
    : (page === "comic" ? comic.doc?.title : page === "video" ? (video.doc ? [video.doc.title, video.doc.episodeLabel].filter(Boolean).join(" ") : undefined) : page === "reading" ? (reading ? readerHeading(reading.title, novel.work) : undefined) : page === "work" ? workInfo?.title : page === "projects" && projectView.projectId ? projectName : undefined) || t("app.title");

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
      onOpenResource={(resourceId, mediaKind) => openResourceById(resourceId, mediaKind, null)}
      onMatchWork={(workId, mediaKind) => openWorkPage(workId, { kind: mediaKind, tab: "match" })}
      onChanged={bump}
      onNotice={setNotice}
      onError={setError}
    />
  );

  const narrow = viewport.width < 480;
  const menuItems: MenuItem[] = [
    ...(narrow ? [{ id: "forward", label: t("shell.forward"), onSelect: () => navStep(1), disabled: !canForward(navShown) }] : []),
    { id: "settings", label: t("nav.settings"), onSelect: () => openSettings() },
    { id: "scan", label: t("menu.scan"), onSelect: () => { void scan.start().then((started) => { if (started) setNotice(t("menu.scanStarted")); else openSettings("library"); }); } },
    { id: "debug", label: t("debug.open"), onSelect: toggleDebug },
    { id: "about", label: t("menu.about"), onSelect: () => setAboutOpen(true) },
    { id: "quit", label: t("menu.quit"), onSelect: () => { void window.manga.quit?.(); } },
  ];
  const readerFills = (page === "comic" && Boolean(comic.doc)) || (page === "video" && Boolean(video.doc)) || (page === "reading" && Boolean(reading));

  const settingsNav = <SettingsNav t={t} page={settingsPage} hidden={hiddenSettingsPages(facets)} onPage={setSettingsPage} onBack={closeSettings} />;

  const debugPanel = debugView.open ? (
    <DebugPanel
      t={t}
      view={debugView}
      onView={changeDebugView}
      scope={{ sessionId: boundSessionKey || undefined, resourceId: mediaOpen?.resourceId, workId: page === "work" ? workPage?.workId : mediaOpen?.workId ?? undefined, page }}
      video={page === "video" ? videoNow : null}
      reading={page === "reading" && readerContext.get()?.kind === "novel" ? (readerContext.get() as Extract<ReaderContext, { kind: "novel" }>).debug ?? null : null}
      live={{ page, mode, running, readerContext: readerContext.get(), tags: quoteTags.all(), composer: { draftLength: composer.draft.length, materials: composer.materials.length, notes: composer.noteMaterials.length, images: composer.images.map((image) => ({ materialId: image.materialId, width: image.width, height: image.height, bytes: image.bytes, preview: image.preview })), allowOnline: composer.allowOnline, subtitleAheadMin: composer.subtitleAheadMin, recordings: composer.recordings } }}
      events={noticeLog}
      version={shelfKey}
      onNotice={setNotice}
    />
  ) : null;

  return (
    <WorksCacheContext.Provider value={worksCache}>
    <KeyTableProvider value={keyTable}>
    <WindowFullscreenProvider value={windowFullscreenState}>
    <ShellFrame
      viewport={viewport}
      preference={shell}
      page={shellPage}
      pages={pages}
      onPage={(next) => { if (next === "settings") openSettings(); else goPage(next); }}
      hasRight={hasRight}
      retainRight={retainRight}
      immersive={immersive}
      onExitImmersive={exitWindowFullscreen}
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
      fill={readerFills}
      menuItems={menuItems}
      history={{ canBack: canBack(navShown), canForward: canForward(navShown), onBack: () => navStep(-1), onForward: () => navStep(1) }}
      onResize={(side, width) => void resizeSide(side, width)}
      onCloseSession={(session) => void closeRailSession(session)}
      modeLabel={mode === "creator" ? t("mode.creator") : t("mode.enthusiast")}
      modeNames={{ enthusiast: t("mode.enthusiast"), creator: t("mode.creator") }}
      modeHints={{ enthusiast: t("mode.enthusiastHint"), creator: t("mode.creatorHint") }}
      labels={{ exitImmersive: t("window.fullscreen.exit"), showLeft: t("shell.showLeft"), showRight: t("shell.showRight"), hideLeft: t("shell.hideLeft"), hideRight: t("shell.hideRight"), stop: t("shell.stop"), modeGroup: t("mode.group"), menu: t("shell.menu"), back: t("shell.back"), forward: t("shell.forward"), rightTitle: t("shell.agentTitle"), mainNav: t("shell.mainNav"), resizeLeft: t("shell.resizeLeft"), resizeRight: t("shell.resizeRight"), window: { group: t("window.controls"), minimize: t("window.minimize"), maximize: t("window.maximize"), restore: t("window.restore"), close: t("window.close") } }}
      onMode={(next: WorkMode) => { void changeMode(next); }}
      onHide={(side) => { void attempt("settings.setShell", side === "left" ? { left: { visible: false, width: shell.layouts[mode].left.width } } : { right: { visible: false, width: shell.layouts[mode].right.width } }).then(() => refresh()); }}
      onShow={(side) => { void attempt("settings.setShell", { [side]: { visible: true, width: shell.layouts[mode][side].width } }).then(() => refresh()); }}
      onStop={() => void stop()}
      sessions={modeSessions}
      currentSession={page === "agent" ? conversationId : boundSessionKey || undefined}
      sessionLabels={{
        empty: t("agent.sessionsNone"),
        close: t("session.close"),
        active: t("session.active"),
        groups: { project: t("projects.sessions"), novel: t("shelf.kind.novel"), comic: t("shelf.kind.comic"), video: t("shelf.kind.video"), unattached: t("projects.unattached") },
        position: (session) => sessionPositionLabel(session, t),
      }}
      onSession={openSession}
      right={chatView.pane}
      capsule={chatView.capsule}
      bottom={debugPanel}
    >
      <Toasts
        notice={notice?.text}
        noticeAction={notice?.action}
        noticeImage={notice?.rich?.image}
        noticeActions={notice?.rich?.actions}
        error={error}
        sticky={restartRequired ? t("settings.restartRequired") : undefined}
        closeLabel={t("common.close")}
        onCloseNotice={() => setNoticeState(undefined)}
        onCloseError={() => setError(undefined)}
      />
      {shots.dialog}
      <div className="page-host">
        {page === "library" ? (
          workMode ? (
            <ProjectOverviewPage
              t={t}
              formatDate={i18n.formatDate}
              version={projectsVersion + shelfKey}
              onOpenProject={(projectId, tab, focus) => openProject(projectId, tab ?? "materials", focus ?? null)}
              onAll={() => goPage("projects")}
              onChanged={() => { setProjectsVersion((value) => value + 1); bump(); }}
              onError={setError}
              onNotice={setNotice}
            />
          ) : <div className="page-host" data-testid="page-library">{shelf(null)}</div>
        ) : null}
        {page === "agent" ? (
          <div className="page-host chat-page" data-testid="page-agent">
            {chatView.pane}
          </div>
        ) : null}
        {page === "projects" ? (
          projectView.projectId ? (
            <ProjectPage
              t={t}
              formatDate={i18n.formatDate}
              projectId={projectView.projectId}
              tab={projectView.tab}
              facets={facets}
              connections={(settings?.connections as Array<{ id: string; label: string; purpose: string; modelId?: string }> | undefined) ?? []}
              version={projectsVersion}
              focus={projectView.focus}
              onFocus={(focus) => setProjectView((view) => ({ ...view, focus }))}
              onTab={(tab) => setProjectView((view) => ({ ...view, tab, focus: null }))}
              onBack={() => { setProjectView({ projectId: null, tab: "materials", focus: null }); setProjectName(""); }}
              onChanged={() => { setProjectsVersion((value) => value + 1); bump(); }}
              onLoaded={(project) => setProjectName(project.name)}
              onOpenMaterial={openProjectMaterial}
              onOpenHit={openSemanticHit}
              onOpenSettings={openSettings}
              onError={setError}
              onNotice={setNotice}
              renderTab={renderCreativeTab}
            />
          ) : (
            <ProjectsPage
              t={t}
              formatDate={i18n.formatDate}
              version={projectsVersion}
              onOpen={(projectId) => openProject(projectId)}
              onChanged={() => { setProjectsVersion((value) => value + 1); bump(); }}
              onError={setError}
              onNotice={setNotice}
            />
          )
        ) : null}
        {/* A reader whose page is left without closing it (settings, a note) stays in the background: its place, panels and playing state are kept, and media is paused. */}
        {reading ? (
          <Activity mode={page === "reading" ? "visible" : "hidden"}>
            <ReadingPane
              document={{ ...reading, authorStyle }}
              style={{ ...shell.reading }}
              hits={novel.hits}
              bookmarks={novel.bookmarks}
              assets={novel.assetUrls}
              originalBytes={novel.originalBytes}
              highlight={novel.highlight}
              sourceCard={novel.sourceCard}
              onBackToNote={() => void novel.backToNote().then(() => setPage("notes"))}
              onRepair={() => void novel.repairNoteSource()}
              onMatch={matchFromReader}
              labelsExtra={{ sourceNeedsReview: t("reading.sourceNeedsReview"), sourceMissing: t("reading.sourceMissing"), sourceRepair: t("reading.sourceRepair") }}
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
          </Activity>
        ) : null}
        {page === "reading" && !reading ? <div className="page-host" data-testid="page-novel">{shelf("novel")}</div> : null}
        {comic.doc ? (
          <Activity mode={page === "comic" ? "visible" : "hidden"}>
            <ComicReader
              key={`${comic.doc.resourceId}:${comic.doc.revisionId}`}
              t={t}
              doc={comic.doc}
              settings={comic.settings}
              onSettings={comic.changeSettings}
              startPageId={comic.startPageId}
              focus={comic.focus}
              onFocusApplied={comic.focusApplied}
              sourceCard={comic.sourceCard}
              onMatch={matchFromReader}
              onBack={() => backFromReader("comic", comic.doc?.workId)}
              onPage={comic.recordPages}
              onBackToNote={() => void comic.backToNote()}
              onRepair={() => void comic.repair()}
              screenshots={shots.port}
            />
          </Activity>
        ) : null}
        {page === "comic" && !comic.doc ? (
          comic.status === "loading" ? <p className="page-pad detail-muted" role="status" data-testid="page-comic-loading">{t("status.loading")}</p> : <div className="page-host" data-testid="page-comic">{shelf("comic")}</div>
        ) : null}
        {video.doc ? (
          <Activity mode={page === "video" ? "visible" : "hidden"}>
            <VideoPlayer
              key={`${video.doc.resourceId}:${video.doc.revisionId}`}
              t={t}
              doc={video.doc}
              settings={video.settings}
              onSettings={video.changeSettings}
              startMs={video.startMs}
              focus={video.focus}
              onFocusApplied={video.focusApplied}
              sourceCard={video.sourceCard}
              next={video.next}
              onMatch={matchFromReader}
              onBack={() => backFromReader("video", video.doc?.workId)}
              onNext={() => { const next = video.next; if (next) void openGate(next.resourceId).then((ok) => { if (ok) void video.open(next.resourceId); }); }}
              onEpisode={(resourceId) => void openGate(resourceId).then((ok) => { if (ok) void video.open(resourceId); })}
              onProgress={video.recordProgress}
              onBackToNote={() => void video.backToNote()}
              onRepair={() => void video.repair()}
              screenshots={shots.port}
              danmakuOn={facets.has("danmaku")}
              onDanmakuSettings={() => openSettings("danmaku")}
              duck={recorder.duck}
              tools={facets.has("roughcut") && video.doc ? ({ currentMs, durationMs, interval }) => (
                <AddToRoughcut t={t} resourceId={video.doc!.resourceId} revisionId={video.doc!.revisionId} title={video.doc!.title} durationMs={durationMs} currentMs={currentMs} interval={interval} onError={setError} onNotice={setNotice} />
              ) : undefined}
            />
          </Activity>
        ) : null}
        {page === "video" && !video.doc ? (
          video.status === "loading" ? <p className="page-pad detail-muted" role="status" data-testid="page-video-loading">{t("status.loading")}</p> : <div className="page-host" data-testid="page-video">{shelf("video")}</div>
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
            onOpenConversation={(sessionId) => { closeReaders(); setWorkPage(null); setConversationId(sessionId); setRun(null); setPage("agent"); }}
            onAddPath={() => openSettings("library")}
            onLoaded={(info) => {
              setWorkInfo((current) => (current && current.workId === info.workId && current.title === info.title && current.author === info.author ? current : { workId: info.workId, title: info.title, author: info.author }));
              setWorkPage((current) => (current && current.workId === info.workId && !current.kind && info.mediaKind in PAGE_FOR_KIND ? { ...current, kind: info.mediaKind as WorkMediaKind } : current));
            }}
            onChanged={bump}
            onError={(message) => setError(message)}
            onNotice={setNotice}
          />
        ) : null}
        {page === "downloads" ? (
          <div className="page-host" data-testid="page-downloads-host">
            <DownloadsPage t={t} onOpenSettings={openSettings} onError={setError} onNotice={setNotice} onLibraryChanged={bump} />
          </div>
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
            keys={keyBindings}
            onGoto={setSettingsPage}
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
              onDeleteConnection: async (connectionId) => { if (await failing("connections.delete", { connectionId })) setNotice(t("models.deleted")); await refresh(); },
              onProbeConnection: probeConnection,
              onTestConnection: testPlainConnection,
              onSkip: () => void attempt("settings.skipAi").then(() => refresh()),
            }}
            storage={{
              onScan: () => void attempt("inventory.scan").then((item) => setInventory(item.ok ? item.value : null)),
              onCancelScan: () => void attempt("inventory.cancelScan", { scanId: "current" }),
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
            embeds={facets.has("embeds") ? {
              formatDate: i18n.formatDate,
              onOpen: (item) => void openEmbedTarget(item),
              onEnable: () => openSettings("modules"),
              onError: setError,
            } : undefined}
            screenshots={{ onOpen: (screenshotId) => void openScreenshot(screenshotId) }}
            actions={facets.has("projects") && notes.doc ? <AddToProject t={t} kind="note" targetId={notes.doc.objectId} label={notes.doc.title} onError={setError} onNotice={setNotice} /> : undefined}
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
      {openBlock ? (
        <OpenBlockedDialog
          t={t}
          block={openBlock}
          formatDate={i18n.formatDate}
          onClose={() => setOpenBlock(null)}
          onReady={(block) => { setOpenBlock(null); void openResourceById(block.resourceId, block.mediaKind as WorkMediaKind, block.workId); }}
          onOpenNote={openNotePage}
          onOpenRecording={voiceOn ? (sessionId) => setReviewing({ sessionId, ...(openBlock.workId ? { workId: openBlock.workId } : {}) }) : undefined}
          onOpenConversation={(sessionId) => { closeReaders(); setWorkPage(null); setConversationId(sessionId); setRun(null); setPage("agent"); }}
          onError={setError}
          onNotice={setNotice}
        />
      ) : null}
      {aboutOpen ? (
        <Modal testId="about-dialog" title={t("about.title")} closeLabel={t("common.close")} onClose={() => setAboutOpen(false)}>
          <p>{t("about.blurb")}</p>
          <dl className="about-facts">
            <dt>{t("about.version")}</dt><dd data-testid="about-version">{host.appVersion ?? "-"}</dd>
            <dt>{t("about.channel")}</dt><dd data-testid="about-channel">{channelLabel}</dd>
          </dl>
        </Modal>
      ) : null}
      {matching ? (
        <MatchHost
          t={t}
          workId={matching}
          formatDate={i18n.formatDate}
          onClose={() => setMatching(null)}
          onOpenExternal={(url) => { void window.manga.openExternal?.(url); }}
          onError={(message) => setError(message)}
          onApplied={(message) => { setMatching(null); setMatchVersion((count) => count + 1); setNotice(message); bump(); void refresh(); }}
        />
      ) : null}
    </ShellFrame>
    </WindowFullscreenProvider>
    </KeyTableProvider>
    </WorksCacheContext.Provider>
  );
}
