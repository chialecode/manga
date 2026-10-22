import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { DEFAULT_RAIL_PREFERENCE, applyRailPatch, type RailPatch, type RailPreference } from "@manga/contracts";
import { DEFAULT_SHELL_PREFERENCE, type ReadingStylePatch, type ShellPreference } from "@manga/contracts/reading";
import { createTranslator, type Locale, type Translator } from "@manga/i18n";
import { OpenBlockedDialog, type OpenBlock } from "./pages/open-blocked-dialog.tsx";
import { NewProjectDialog } from "./pages/projects/projects-page.tsx";
import { Modal } from "./components/modal.tsx";
import { MatchHost } from "./pages/work-match.tsx";
import { RecordingReview } from "./voice/review-panel.tsx";
import { useRecorder } from "./voice/use-recorder.ts";
import { usePackage } from "./hooks/use-package.ts";
import { useScan } from "./hooks/use-scan.ts";
import { useScreenshots, type RichNotice } from "./hooks/use-screenshots.tsx";
import { asArray, attempt, type HostState } from "./lib/api.ts";
import { WorksCacheContext, type WorksCache } from "./lib/use-works.ts";
import { useKeyBindings } from "./hooks/use-key-bindings.ts";
import { onListsChanged } from "./lib/lists-changed.ts";
import { KeyTableProvider } from "./lib/key-table.tsx";
import { SETTINGS_PAGES, type SettingsPageId } from "./lib/shell-model.ts";
import { WorkspaceController } from "./workspace/controller.ts";
import { WorkspaceProvider } from "./workspace/context.tsx";
import { Drafts, DraftsContext } from "./workspace/drafts.ts";
import { installIntent } from "./workspace/intent.ts";
import { createOpeners, libraryTitle } from "./workspace/openers.ts";
import { ServicesProvider, type Services } from "./workspace/services.tsx";
import type { OpenRequest } from "./workspace/model.ts";
import { ShellState, ShellStateProvider } from "./shell-state.ts";
import { RailContext, createSidebarCache } from "./sidebar-data.ts";
import { Workbench } from "./workbench.tsx";

const NOTICE_MS = 5000;
/** A notice that carries follow-ups (a screenshot just taken) stays long enough to use them. */
const RICH_NOTICE_MS = 10_000;

type Notice = { text: string; n: number; action?: { label: string; onClick: () => void }; rich?: RichNotice };
export type Reviewing = { sessionId?: string; workId?: string; resourceId?: string };

/** The name a tab has before its content has named it. */
function titleOf(t: Translator["t"], request: Pick<OpenRequest, "kind" | "target">): string {
  const target = request.target ?? {};
  switch (request.kind) {
    case "library": return libraryTitle(t, typeof target.page === "string" ? target.page : "overview");
    case "reader": return t("tab.reader");
    case "note": return t("tab.note");
    case "project": return typeof target.projectId === "string" && target.projectId ? t("tab.project") : t("tab.projects");
    case "whiteboard": return t("tab.whiteboard");
    case "mindmap": return t("tab.mindmap");
    case "draft": return t("tab.draft");
    case "roughcut": return t("tab.roughcut");
    case "conversation": return t("tab.conversation");
    case "records": return target.type === "conversation" ? t("sidebar.manage.conversation") : target.type === "note" ? t("sidebar.manage.note") : t("tab.records");
    case "objects": return typeof target.kind === "string" ? t(`sidebar.manage.${target.kind}` as never) : t("tab.records");
    case "downloads": return t("nav.downloads");
    default: return request.kind;
  }
}

/**
 * The application: it reads the host, the workspace and the settings, keeps the workspace controller (the tabs and layouts of every context), and gives the
 * contents of the tabs the services they share. What is on screen — the frame, the dock of every context, the sidebar — is the `Workbench`.
 */
export function App() {
  const [locale] = useState<Locale>("zh-CN");
  const i18n = useMemo(() => createTranslator(locale), [locale]);
  const t = i18n.t;
  const [host, setHost] = useState<HostState | null>(null);
  const [workspace, setWorkspace] = useState<Record<string, unknown> | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNoticeState] = useState<Notice | undefined>();
  /** The work whose Bangumi match dialog is open over the current page, and a counter that says a match may have changed. */
  const [matching, setMatching] = useState<string | null>(null);
  const [matchVersion, setMatchVersion] = useState(0);
  const [shelfKey, setShelfKey] = useState(0);
  /** Changes when a project may have changed (a material added from another tab), so the open pages read it again. */
  const [projectsVersion, setProjectsVersion] = useState(0);
  /** Changes when the conversation list may have changed, so the sidebar and an open history read it again. */
  const [conversationVersion, setConversationVersion] = useState(0);
  /** Changes when what the sidebar lists may have changed without its doing (a material added by a reader, a note written, a resource read in 最近). */
  const [listsVersion, setListsVersion] = useState(0);
  const [reviewing, setReviewing] = useState<Reviewing | null>(null);
  /** The resource that was asked to open and cannot: outside every library path, or its file is gone (A-86). */
  const [openBlock, setOpenBlock] = useState<OpenBlock | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [worksCache] = useState<WorksCache>(() => new Map());
  const [drafts] = useState(() => new Drafts());
  const started = useRef(false);

  const setNotice = useCallback((message?: string, action?: { label: string; onClick: () => void }) => setNoticeState((current) => (message ? { text: message, n: (current?.n ?? 0) + 1, ...(action ? { action } : {}) } : undefined)), []);
  const setRichNotice = useCallback((message: string, rich: RichNotice) => setNoticeState((current) => ({ text: message, n: (current?.n ?? 0) + 1, rich })), []);
  const bump = useCallback(() => setShelfKey((key) => key + 1), []);
  const conversationsChanged = useCallback(() => setConversationVersion((value) => value + 1), []);
  // A result is told for a few seconds and goes away; a new one restarts the time.
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNoticeState(undefined), notice.rich ? RICH_NOTICE_MS : NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- the workspace: the tabs and layouts of every context ------------------------------------------------------------------
  const latest = useRef({ t, setNotice, setError });
  latest.current = { t, setNotice, setError };
  const controller = useMemo(() => new WorkspaceController({
    call: (commandId, input) => attempt(commandId, input) as never,
    titleFor: (request) => titleOf(latest.current.t, request),
    // A context that has nothing yet opens with its start: the library for "最近", the project's home for a project.
    seed: (contextId) => (contextId === null ? [{ kind: "library", target: { page: "overview" } }] : [{ kind: "project", target: { projectId: contextId } }]),
    onLimit: () => latest.current.setNotice(latest.current.t("tab.limit")),
    onError: (message) => latest.current.setError(message),
  }), []);
  const context = useSyncExternalStore(controller.subscribe, () => controller.activeContextId, () => null);

  // ---- the rail's own state and the window's (A-99, A-101) ----------------------------------------------------------------------------------
  // What the person changes on the rail (which icons are out, which view, which groups are open, the settings page) is shown at once and saved a moment
  // later, in the order it was made; a saved copy that comes back while a save is on its way does not undo it.
  const [rail, setRail] = useState<RailPreference>(() => structuredClone(DEFAULT_RAIL_PREFERENCE));
  const railRef = useRef(rail);
  railRef.current = rail;
  const railSaves = useRef({ queue: Promise.resolve(), pending: 0 });
  const changeRail = useCallback((patch: RailPatch) => {
    const next = applyRailPatch(railRef.current, patch);
    railRef.current = next;
    setRail(next);
    const saves = railSaves.current;
    saves.pending += 1;
    saves.queue = saves.queue.then(async () => {
      const saved = await attempt("settings.setShell", { rail: patch });
      saves.pending -= 1;
      if (!saved.ok) latest.current.setError(saved.error.message);
    });
  }, []);
  const [sidebarCache] = useState(createSidebarCache);
  const changeRailRef = useRef(changeRail);
  changeRailRef.current = changeRail;
  const hiddenPagesRef = useRef<ReadonlySet<string>>(new Set());
  const shellStore = useMemo(() => new ShellState({
    lastPage: () => {
      const page = railRef.current.settingsPage;
      return page && (SETTINGS_PAGES as readonly string[]).includes(page) && !hiddenPagesRef.current.has(page) ? (page as SettingsPageId) : null;
    },
    // The workspace stays mounted behind the settings; its contents are told they are out of sight, and back in sight when the settings are left.
    onSettings: (on) => controller.setSuspended(on),
    railView: () => railRef.current.view,
    onPage: (page) => changeRailRef.current({ settingsPage: page }),
  }), [controller]);

  const switchContext = useCallback(async (contextId: string | null) => {
    const found = await controller.activate(contextId);
    if (!found) {
      await controller.activate(null);
      setNotice(t("context.gone"));
    }
    void attempt("workspace.setLastContext", { contextId: controller.activeContextId });
  }, [controller, setNotice, t]);

  /** Contexts of projects that no longer exist leave the workspace; if the one on screen is among them, "最近" takes its place. */
  const reconcile = useCallback(async () => {
    const listed = await attempt<{ contexts: Array<{ contextId: string | null }> }>("workspace.contexts", { includeArchived: true });
    if (!listed.ok) return;
    const alive = new Set(asArray<{ contextId: string | null }>(listed.value.contexts).map((item) => item.contextId ?? ""));
    const gone = controller.mountedContexts.filter((item) => !alive.has(item.key));
    if (gone.length === 0) return;
    const onScreen = controller.activeKey;
    for (const item of gone) controller.forget(item.contextId);
    if (gone.some((item) => item.key === onScreen)) await switchContext(null);
  }, [controller, switchContext]);

  const changedProjects = useCallback(() => {
    setProjectsVersion((value) => value + 1);
    setShelfKey((key) => key + 1);
    void reconcile();
  }, [reconcile]);

  const refresh = useCallback(async (): Promise<void> => {
    const state = await window.manga.state();
    setHost(state);
    const ws = await attempt("workspace.get");
    if (ws.ok) setWorkspace(ws.value);
    const st = await attempt("settings.get");
    if (st.ok) setSettings(st.value);
    setShelfKey((key) => key + 1);
  }, []);

  useEffect(() => {
    void refresh().catch((item) => setError(String(item)));
  }, [refresh]);

  const facetList = (workspace?.uiFacets as string[] | undefined) ?? ["agent", "library", "settings"];
  const facets = useMemo(() => new Set(facetList), [facetList.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const voiceOn = facets.has("voice");
  const shell = (workspace?.shell as ShellPreference | undefined) ?? (settings?.shell as ShellPreference | undefined) ?? DEFAULT_SHELL_PREFERENCE;
  const savedRail = JSON.stringify(shell.rail ?? DEFAULT_RAIL_PREFERENCE);
  useEffect(() => {
    if (railSaves.current.pending > 0) return;
    setRail(shell.rail ?? structuredClone(DEFAULT_RAIL_PREFERENCE));
  }, [savedRail]); // eslint-disable-line react-hooks/exhaustive-deps
  hiddenPagesRef.current = useMemo(() => new Set<string>([
    ...(facets.has("voice") ? [] : ["recording"]), ...(facets.has("metadata") ? [] : ["sources"]), ...(facets.has("danmaku") ? [] : ["danmaku"]),
    ...(facets.has("semantic") ? [] : ["semantic"]), ...(facets.has("plugins") ? [] : ["plugins"]),
    ...(facets.has("agent") ? [] : ["models", "quick", "usage"]),
  ]), [facets]);

  // The first time the workspace is known, the person is back where they were; a library with nothing in it starts on the page that adds the first folder.
  useEffect(() => {
    if (!host?.writable || !workspace || started.current) return;
    started.current = true;
    const last = (workspace.shell as ShellPreference | undefined)?.lastContext ?? null;
    void (async () => {
      await switchContext(last);
      const probe = await attempt<{ total?: number; items?: unknown[] }>("works.list", { limit: 1 });
      if (!probe.ok) return;
      const total = typeof probe.value.total === "number" ? probe.value.total : asArray(probe.value.items).length;
      if (total === 0) openers.settings("library");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host?.writable, workspace]);

  // What was changed is saved a moment later; leaving the window saves it now.
  useEffect(() => {
    const save = () => { void controller.flushAll(); };
    const onVisibility = () => { if (document.visibilityState === "hidden") save(); };
    window.addEventListener("pagehide", save);
    window.addEventListener("beforeunload", save);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", save);
      window.removeEventListener("beforeunload", save);
      document.removeEventListener("visibilitychange", onVisibility);
      // The window is going away (or the app is drawn again): what is waiting for its save goes now, to the host it was made for.
      save();
    };
  }, [controller]);
  useEffect(() => installIntent(), []);
  useEffect(() => onListsChanged(() => setListsVersion((value) => value + 1)), []);

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

  // A library path was removed: what was open from it closes with a word about it, and the shelves are read again (A-86).
  // Conversations were deleted (A-89): the tabs that showed them close, and the sidebar and the history stop listing them.
  useEffect(() => {
    const off = window.manga.onNotice?.((item) => {
      if (item.topic === "library.pathRemoved") {
        const gone = new Set(asArray<string>(item.payload.resourceIds));
        const closed = controller.closeMatching((tab) => tab.kind === "reader" && gone.has(String(tab.target.resourceId ?? "")));
        if (closed.length) setNotice(latest.current.t("open.removedNotice", { title: closed[0]!.title }));
        setShelfKey((key) => key + 1);
        setConversationVersion((value) => value + 1);
      }
      if (item.topic === "conversation.deleted") {
        const gone = new Set(asArray<string>(item.payload.sessionIds));
        controller.closeMatching((tab) => tab.kind === "conversation" && gone.has(String(tab.target.sessionId ?? "")));
        setConversationVersion((value) => value + 1);
      }
    });
    return () => { off?.(); };
  }, [controller, setNotice]);

  // ---- the things the tabs share ----------------------------------------------------------------------------------------------
  const scan = useScan(Boolean(host?.writable));
  const pkg = usePackage({ i18n, setError, setNotice, refresh });
  const shots = useScreenshots({ i18n, setError, setRichNotice, setNotice, contextId: context });
  const recorder = useRecorder({ i18n, setError, setNotice, enabled: voiceOn, contextId: context });
  const keyBindings = useKeyBindings();
  const keyTable = keyBindings.table;

  const depsRef = useRef<Parameters<typeof createOpeners>[0] extends () => infer D ? D : never>(null as never);
  depsRef.current = {
    controller,
    t,
    setError,
    setNotice,
    setOpenBlock,
    reviewRecording: setReviewing,
    switchContext,
    conversationsChanged,
    changed: changedProjects,
    newProject: () => setNewProjectOpen(true),
    enterSettings: (page) => shellStore.enterSettings(page),
    leaveSettings: () => shellStore.leaveSettings(),
    openSearch: (options) => shellStore.openSearch(options),
  };
  const openers = useMemo(() => createOpeners(() => depsRef.current), []);

  const saveReadingStyle = useCallback(async (patch: ReadingStylePatch) => {
    const saved = await attempt("settings.setShell", { reading: patch });
    if (!saved.ok) { setError(saved.error.message); return; }
    await refresh();
  }, [refresh]);

  const rails = useMemo(() => ({ rail, change: changeRail, cache: sidebarCache }), [rail, changeRail, sidebarCache]);

  const services: Services = {
    i18n,
    t,
    host: host as HostState,
    facets,
    shell,
    currentContext: context,
    settings,
    workspace,
    setError,
    setNotice,
    refresh,
    shelfKey,
    bump,
    projectsVersion,
    changedProjects,
    scan,
    pkg,
    recorder,
    voiceOn,
    keyBindings,
    screenshots: shots.port,
    openMatch: setMatching,
    matchVersion,
    reviewRecording: setReviewing,
    saveReadingStyle,
    conversationVersion,
    conversationsChanged,
    listsVersion,
    open: openers,
  };

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

  const restartRequired = settings?.restartRequired === true || workspace?.restartRequired === true;

  return (
    <WorksCacheContext.Provider value={worksCache}>
      <KeyTableProvider value={keyTable}>
        <WorkspaceProvider controller={controller}>
          <DraftsContext.Provider value={drafts}>
            <ServicesProvider value={services}>
             <ShellStateProvider value={shellStore}>
              <RailContext.Provider value={rails}>
              <Workbench
                notice={notice}
                error={error}
                restartRequired={restartRequired}
                onCloseNotice={() => setNoticeState(undefined)}
                onCloseError={() => setError(undefined)}
                shotsDialog={shots.dialog}
              />
              {reviewing && voiceOn ? (
                <Modal variant="drawer" testId="review-drawer" title={t("review.title")} closeLabel={t("review.close")} onClose={() => setReviewing(null)}>
                  <RecordingReview
                    t={t}
                    scope={{ ...(reviewing.workId ? { workId: reviewing.workId } : reviewing.resourceId ? { resourceId: reviewing.resourceId } : {}) }}
                    initialSessionId={reviewing.sessionId ?? null}
                    formatDate={i18n.formatDate}
                    onJump={(anchor) => { setReviewing(null); void openers.anchor(anchor); }}
                    onOpenNote={(objectId) => { setReviewing(null); openers.note(objectId); }}
                  />
                </Modal>
              ) : null}
              {openBlock ? (
                <OpenBlockedDialog
                  t={t}
                  block={openBlock}
                  formatDate={i18n.formatDate}
                  onClose={() => setOpenBlock(null)}
                  onReady={(block) => { setOpenBlock(null); void openers.resource({ resourceId: block.resourceId, mediaKind: block.mediaKind as never, workId: block.workId }); }}
                  onOpenNote={(objectId) => { setOpenBlock(null); openers.note(objectId); }}
                  onOpenRecording={voiceOn ? (sessionId) => setReviewing({ sessionId, ...(openBlock.workId ? { workId: openBlock.workId } : {}) }) : undefined}
                  onOpenConversation={(sessionId) => { setOpenBlock(null); void openers.conversation(sessionId); }}
                  onError={setError}
                  onNotice={setNotice}
                />
              ) : null}
              {newProjectOpen ? (
                <NewProjectDialog
                  t={t}
                  onClose={() => setNewProjectOpen(false)}
                  onError={setError}
                  onCreated={(project) => { setNewProjectOpen(false); changedProjects(); void openers.project(project.id); }}
                />
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
              </RailContext.Provider>
             </ShellStateProvider>
            </ServicesProvider>
          </DraftsContext.Provider>
        </WorkspaceProvider>
      </KeyTableProvider>
    </WorksCacheContext.Provider>
  );
}
