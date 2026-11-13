import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { chordOf } from "@manga/contracts/keys";
import { moveRailView, railOrder, type RailView } from "@manga/contracts";
import type { MessageKey } from "@manga/i18n";
import type { ShellPreference } from "@manga/contracts/reading";
import { MAIN_FLOOR } from "../../../../packages/app-core/src/domain/shell-layout.ts";
import { Modal } from "./components/modal.tsx";
import { Toasts } from "./components/toast.tsx";
import { TitleActions } from "./components/title-actions.tsx";
import { DebugPanel, loadDebugView, saveDebugView, useNoticeLog, type DebugView } from "./pages/debug-panel.tsx";
import { DictationCapsule } from "./voice/dictation-capsule.tsx";
import { DictationPill } from "./voice/dictation-pill.tsx";
import { attempt } from "./lib/api.ts";
import { createPatchQueue, type PatchQueue } from "./lib/patch-queue.ts";
import { useKeyTable } from "./lib/key-table.tsx";
import { quoteTags } from "./lib/quote-tags.ts";
import { readerContext, useReaderContext, type ReaderContext } from "./lib/reader-context.ts";
import { railViewsFor } from "./lib/shell-model.ts";
import { useVideoFacts } from "./lib/video-facts.ts";
import type { RichNotice } from "./hooks/use-screenshots.tsx";
import { WindowFullscreenProvider, useWindowFullscreenKeys, type WindowFullscreen } from "./readers/window-fullscreen.tsx";
import { isHideable } from "./rail.tsx";
import { SettingsNav } from "./pages/settings/settings-nav.tsx";
import { SettingsPane } from "./pages/settings/settings-pane.tsx";
import { hiddenSettingsPages } from "./pages/settings/settings-view.tsx";
import { SearchBox } from "./search-box.tsx";
import { ShellFrame, type ShellLabels, type ShellRail, type SidebarContent } from "./shell.tsx";
import { useShellState } from "./shell-state.ts";
import { useRail } from "./sidebar-data.ts";
import { Sidebar, VIEW_LABEL } from "./sidebar.tsx";
import { contextSurface, surfaceOfTab } from "./agent-surface.ts";
import { useWorkspace, useWorkspaceValue } from "./workspace/context.tsx";
import { useDraft } from "./workspace/drafts.ts";
import { WorkspaceHosts } from "./workspace/host.tsx";
import { MIN_COLUMN_WIDTH } from "./workspace/layout.ts";
import { useServices } from "./workspace/services.tsx";
import { useAgent } from "./workspace/agent.tsx";
import { tabMarks } from "./workspace/marks.ts";
import { captureBus } from "./voice/capture-bus.ts";

export type Notice = { text: string; n: number; action?: { label: string; onClick: () => void }; rich?: RichNotice };

type Side = "sidebar" | "dock";

const COLUMN_ACTIONS = ["global.column1", "global.column2", "global.column3", "global.column4"] as const;

/**
 * What is on screen (A-94, A-136): the frame, the icon rail, the sidebar, the tabbed main area with the docks of the contexts kept alive, and the dock
 * that follows the tab in front. It reads the services every tab shares and the workspace controller; it holds no page state of its own beyond the
 * window's (full screen, the debug panel).
 */
export function Workbench(props: {
  notice?: Notice;
  error?: string;
  restartRequired: boolean;
  onCloseNotice: () => void;
  onCloseError: () => void;
  shotsDialog: ReactNode;
}) {
  const s = useServices();
  const { t } = s;
  const controller = useWorkspace();
  const keyTable = useKeyTable();
  const focused = useWorkspaceValue((c) => c.focusedTab());
  const columns = useWorkspaceValue((c) => c.columns());
  const context = s.currentContext;
  const [viewport, setViewport] = useState({ width: window.innerWidth || 1280, height: window.innerHeight || 840 });
  const chrome = useRef<{ toggle: (side: Side) => void } | null>(null);
  const { state: shellStore, snapshot } = useShellState();
  const { rail, change: changeRail } = useRail();
  const settingsOn = snapshot.settings.on;

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth || 1280, height: window.innerHeight || 840 });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // A recording that listens to a tab shows on that tab's title (A-95).
  useEffect(() => {
    let marked: string | null = null;
    return captureBus.onBinding((owner) => {
      if (marked) tabMarks.set(marked, "recording", false);
      marked = owner ? owner : null;
      if (marked) tabMarks.set(marked, "recording", true);
    });
  }, []);

  // ---- window full screen (A-78): it belongs to the reader in front and ends when the person leaves it --------------------------------
  const [windowFullscreen, setWindowFullscreen] = useState(false);
  const readerFront = focused?.kind === "reader" && !settingsOn;
  const immersive = windowFullscreen && readerFront;
  useEffect(() => { if (!readerFront) setWindowFullscreen(false); }, [readerFront]);
  const toggleWindowFullscreen = useCallback(() => setWindowFullscreen((on) => !on), []);
  const exitWindowFullscreen = useCallback(() => setWindowFullscreen(false), []);
  useWindowFullscreenKeys({ enabled: readerFront, active: immersive, toggleKeys: keyTable["global.windowFullscreen"] ?? [], toggle: toggleWindowFullscreen, exit: exitWindowFullscreen });
  const windowFullscreenState = useMemo<WindowFullscreen>(() => ({ active: immersive, toggle: toggleWindowFullscreen, exit: exitWindowFullscreen }), [immersive, toggleWindowFullscreen, exitWindowFullscreen]);

  // ---- the sidebar and the dock: widths and visibility are shown at once, then saved in order ----------------------------------------
  const [pref, setPref] = useState<ShellPreference>(s.shell);
  const sRef = useRef(s);
  sRef.current = s;
  const sideQueueRef = useRef<PatchQueue<ShellPreference, { side: Side; patch: { visible?: boolean; width?: number } }> | null>(null);
  if (!sideQueueRef.current) {
    sideQueueRef.current = createPatchQueue<ShellPreference, { side: Side; patch: { visible?: boolean; width?: number } }>({
      initial: s.shell,
      apply: (state, { side, patch }) => ({ ...state, [side]: { ...state[side], ...patch } }),
      send: async ({ side, patch }) => {
        const saved = await attempt("settings.setShell", { [side]: patch });
        return saved.ok ? { ok: true } : { ok: false, error: saved.error.message };
      },
      onState: setPref,
      onError: (message) => { if (message) sRef.current.setError(message); },
    });
  }
  const shellRef = useRef(s.shell);
  shellRef.current = s.shell;
  const shellKey = JSON.stringify(s.shell);
  useEffect(() => {
    sideQueueRef.current?.hydrate(shellRef.current);
  }, [shellKey]);
  const changeSide = useCallback((side: Side, patch: { visible?: boolean; width?: number }) => {
    const queue = sideQueueRef.current!;
    void queue.enqueue({ side, patch }).then(() => {
      if (!queue.hasPending()) void sRef.current.refresh();
    });
  }, []);

  // ---- the dock: the Agent, following the tab in front -------------------------------------------------------------------------------
  const reading = useReaderContext();
  const readingResourceId = reading?.resourceId;
  const readingRevisionId = reading?.revisionId;
  const readingTitle = reading?.title;
  const readingWorkId = reading?.workId ?? null;
  const surface = useMemo(
    () => surfaceOfTab(focused, context, { reading: readingResourceId && readingRevisionId ? { resourceId: readingResourceId, revisionId: readingRevisionId, title: readingTitle ?? "", workId: readingWorkId } : null }),
    [focused, context, readingResourceId, readingRevisionId, readingTitle, readingWorkId],
  );
  const agent = useAgent(surface);
  useEffect(() => {
    tabMarks.set("__dock__", "running", agent.running);
    return () => tabMarks.set("__dock__", "running", false);
  }, [agent.running]);
  const hasDock = surface !== null;
  const shown = surface ?? contextSurface(context);
  const { composer } = useDraft(shown.draftKey);

  // ---- the debug panel (A-48) -----------------------------------------------------------------------------------------------------------
  const debugKey = shown.sessionId ?? shown.draftKey;
  const debugKeyRef = useRef(debugKey);
  const [debugView, setDebugView] = useState<DebugView>(() => loadDebugView(debugKey));
  useEffect(() => {
    if (debugKeyRef.current === debugKey) return;
    debugKeyRef.current = debugKey;
    setDebugView(loadDebugView(debugKey));
  }, [debugKey]);
  const changeDebugView = (next: DebugView) => { setDebugView(next); saveDebugView(debugKeyRef.current, next); };
  const toggleDebug = () => changeDebugView({ ...debugView, open: !debugView.open });
  const noticeLog = useNoticeLog();
  const videoNow = useVideoFacts();

  // ---- keys: the actions of the one key table ---------------------------------------------------------------------------------------------
  const latest = useRef({ s, controller, keyTable, toggleDebug });
  latest.current = { s, controller, keyTable, toggleDebug };
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      const { s: services, controller: workspace, keyTable: table } = latest.current;
      // Alt + ← / → walk the tab in front back and forward (in the settings: the pages that were visited).
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        if (document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        if (shellStore.getSnapshot().settings.on) { if (event.key === "ArrowLeft") shellStore.back(); else shellStore.forward(); return; }
        if (event.key === "ArrowLeft") workspace.back(); else workspace.forward();
        return;
      }
      const chord = chordOf(event);
      if (chord === null) return;
      const is = (action: string) => (table[action] ?? []).includes(chord);
      // Moving to another tab or column hands the keyboard to its content, so the keys of a reader reach the one in front.
      const toContent = () => requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-testid="tab-panel"][data-focused="true"]')?.focus({ preventScroll: true }));
      const columnAt = COLUMN_ACTIONS.findIndex(is);
      // The search box is a dialog itself: its own key closes it, any other dialog keeps the keyboard.
      if (is("global.search")) {
        if (shellStore.getSnapshot().search.open) { event.preventDefault(); shellStore.closeSearch(); return; }
        if (document.querySelector('[role="dialog"]')) return;
        event.preventDefault();
        services.open.search();
        return;
      }
      const inSettings = shellStore.getSnapshot().settings.on;
      const handled = (run: () => void) => {
        // A dialog owns the keyboard while it is open; the keys of the window wait.
        if (document.querySelector('[role="dialog"]')) return true;
        event.preventDefault();
        run();
        return true;
      };
      // What acts on the tabs in front waits while the settings are on: nothing is shown for it to act on.
      if (inSettings && (is("global.closeTab") || is("global.reopenTab") || is("global.nextTab") || is("global.prevTab") || columnAt >= 0 || is("global.splitToggle"))) handled(() => undefined);
      else if (is("global.settings")) handled(() => services.open.settings());
      else if (is("global.newTab")) handled(() => services.open.newTab());
      else if (is("global.closeTab")) handled(() => services.open.closeTab());
      else if (is("global.reopenTab")) handled(() => services.open.reopenTab());
      else if (is("global.nextTab")) handled(() => { workspace.step(1); toContent(); });
      else if (is("global.prevTab")) handled(() => { workspace.step(-1); toContent(); });
      else if (columnAt >= 0) handled(() => { workspace.focusColumn(columnAt + 1); toContent(); });
      else if (is("global.splitToggle")) handled(() => workspace.toggleSplit());
      else if (is("global.newConversation") && services.facets.has("agent")) handled(() => { void services.open.newConversation(); });
      else if (is("global.newProject") && services.facets.has("projects")) handled(() => services.open.newProject());
      else if (is("global.debug")) { event.preventDefault(); latest.current.toggleDebug(); }
    };
    window.addEventListener("keydown", onKey);
    // The back and forward buttons of a mouse.
    const onMouse = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      if (shellStore.getSnapshot().settings.on) { if (event.button === 3) shellStore.back(); else shellStore.forward(); return; }
      if (event.button === 3) latest.current.controller.back(); else latest.current.controller.forward();
    };
    window.addEventListener("mouseup", onMouse);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mouseup", onMouse); };
  }, [shellStore]);

  const mainFloor = Math.max(MAIN_FLOOR, (columns >= 4 ? 2 : columns) * MIN_COLUMN_WIDTH);

  // ---- the rail and the sidebar (A-99, A-101) ------------------------------------------------------------------------------------------
  // The person's order of the icons (A-108): the home first, then theirs; the ones of a module that is off are left out.
  const railViews = useMemo(() => {
    const available = new Set(railViewsFor(s.facets));
    return ["home" as RailView, ...railOrder(rail.order).filter((view) => available.has(view))].filter((view) => available.has(view));
  }, [s.facets, rail.order]);
  const currentView: RailView = railViews.includes(rail.view) ? rail.view : "home";
  // The main area shows the view of the rail (A-107): its own layout, the tab it had in front, and the dock follows that tab.
  useLayoutEffect(() => { controller.showView(currentView); }, [controller, currentView]);
  const railProps: ShellRail = {
    entries: railViews.map((view) => ({ view, label: t(VIEW_LABEL[view]) })),
    hidden: rail.hidden,
    current: currentView,
    settings: s.facets.has("settings") ? { active: settingsOn, onSelect: () => s.open.settings() } : null,
    labels: {
      more: t("rail.more"), moreEmpty: t("rail.moreEmpty"), hide: t("rail.hide"), pin: t("rail.pin"), pinOf: (name) => t("rail.pinOf", { name }), settings: t("nav.settings"),
      moveUp: t("rail.moveUp"), moveDown: t("rail.moveDown"), moved: (name, n) => t("rail.moved", { name, n }),
    },
    onMove: (view, visible, to) => changeRail({ order: moveRailView(rail.order, visible, view, to) }),
    // A view of the rail leaves the settings, and the workspace is as it was.
    onSelect: (view) => { controller.showView(view); if (view !== rail.view) changeRail({ view }); if (settingsOn) shellStore.leaveSettings(); },
    onHide: (view) => { if (isHideable(view)) changeRail({ hidden: [...new Set([...rail.hidden, view])] }); },
    onPin: (view) => changeRail({ hidden: rail.hidden.filter((item) => item !== view) }),
  };
  const hiddenPages = useMemo(() => hiddenSettingsPages(s.facets), [s.facets]);
  const settingsPage = snapshot.settings.page;
  const sidebar = useCallback<SidebarContent>((view, options) => (view === "settings"
    ? <SettingsNav key="settings" t={t} page={settingsPage} hidden={hiddenPages} variant={options.variant} onPage={(page) => shellStore.goTo(page)} {...(options.onDone ? { onDone: options.onDone } : {})} />
    : <Sidebar key={view} view={view} variant={options.variant} {...(options.onDone ? { onDone: options.onDone } : {})} />),
  [t, settingsPage, hiddenPages, shellStore]);

  const labels: ShellLabels = {
    exitImmersive: t("window.fullscreen.exit"),
    showSidebar: t("shell.showSidebar"),
    hideSidebar: t("shell.hideSidebar"),
    showDock: t("shell.showDock"),
    hideDock: t("shell.hideDock"),
    stop: t("shell.stop"),
    rail: t("shell.rail"),
    sidebar: t("shell.sidebar"),
    dock: t("shell.dock"),
    resizeSidebar: t("shell.resizeSidebar"),
    resizeDock: t("shell.resizeDock"),
    window: { group: t("window.controls"), minimize: t("window.minimize"), maximize: t("window.maximize"), restore: t("window.restore"), close: t("window.close") },
  };

  const live = reading as ReaderContext | null;
  const busyItemsLabel = (s.update.busyDialog ?? [])
    .map((reason) => t(`update.busy.item.${reason}` as MessageKey))
    .join("、");
  const debugPanel = debugView.open ? (
    <DebugPanel
      t={t}
      view={debugView}
      onView={changeDebugView}
      scope={{ sessionId: agent.sessionId, resourceId: shown.resourceId, workId: shown.workId, page: shown.page }}
      video={videoNow && shown.resourceId === videoNow.resourceId ? videoNow : null}
      reading={live?.kind === "novel" && live.resourceId === shown.resourceId ? live.debug ?? null : null}
      live={{
        page: shown.page,
        context,
        tab: focused ? { id: focused.id, kind: focused.kind } : null,
        running: agent.running,
        readerContext: readerContext.get(),
        tags: quoteTags.all(),
        composer: { draftLength: composer.draft.length, materials: composer.materials.length, notes: composer.noteMaterials.length, images: composer.images.map((image) => ({ materialId: image.materialId, width: image.width, height: image.height, bytes: image.bytes, preview: image.preview })), allowOnline: composer.allowOnline, subtitleAheadMin: composer.subtitleAheadMin, recordings: composer.recordings },
      }}
      events={noticeLog}
      version={s.shelfKey}
      onNotice={s.setNotice}
    />
  ) : null;

  return (
    <WindowFullscreenProvider value={windowFullscreenState}>
      <ShellFrame
        viewport={viewport}
        preference={pref}
        hasDock={hasDock}
        immersive={immersive}
        onExitImmersive={exitWindowFullscreen}
        running={agent.running}
        labels={labels}
        settings={settingsOn}
        rail={railProps}
        mainFloor={mainFloor}
        keys={{ sidebar: keyTable["global.sidebar"] ?? [], dock: keyTable["global.dock"] ?? [] }}
        controlRef={chrome}
        onHide={(side) => changeSide(side, { visible: false })}
        onShow={(side) => changeSide(side, { visible: true })}
        onResize={(side, width) => changeSide(side, { width })}
        onPull={(side, width) => changeSide(side, { visible: true, width })}
        onStop={agent.stop}
        sidebar={sidebar}
        dock={agent.pane}
        capsule={agent.capsule}
        bottom={debugPanel}
        titleActions={(
          <TitleActions
            t={t}
            debugOpen={debugView.open}
            onDebug={toggleDebug}
            recorder={s.voiceOn ? s.recorder.state : null}
            onStopRecording={() => void s.recorder.stop("user")}
            scan={s.scan.running}
            onScan={() => s.open.settings("library")}
            update={s.update}
          />
        )}
      >
        <Toasts
          notice={props.notice?.text}
          noticeAction={props.notice?.action}
          noticeImage={props.notice?.rich?.image}
          noticeActions={props.notice?.rich?.actions}
          error={props.error}
          sticky={props.restartRequired ? t("settings.restartRequired") : undefined}
          closeLabel={t("common.close")}
          onCloseNotice={props.onCloseNotice}
          onCloseError={props.onCloseError}
        />
        {props.shotsDialog}
        {/* The settings stand over the main area; what is under them stays mounted and is told it is out of sight (A-101). */}
        <div className="workspace-area" data-testid="workspace-area" data-suspended={settingsOn ? "true" : "false"} {...(settingsOn ? { inert: true, "data-hidden-layer": "" } : {})}>
          <WorkspaceHosts />
        </div>
        {settingsOn ? (
          <div className="settings-area" data-testid="settings-area" data-page={snapshot.settings.page}>
            {/* No tabs here: an empty strip keeps the main area's part of the title bar (A-136). */}
            <div className="main-top-row shell-drag" aria-hidden="true" data-testid="settings-top" />
            <SettingsPane page={snapshot.settings.page} onPage={(page) => shellStore.goTo(page)} />
          </div>
        ) : null}
        {snapshot.search.open ? <SearchBox key={snapshot.search.n} initialQuery={snapshot.search.query} initialScope={snapshot.search.scope} onClose={() => shellStore.closeSearch()} /> : null}
        {s.dictation ? (
          <>
            <DictationCapsule
              t={t}
              active={s.dictation.active}
              stage={s.dictation.stage}
              mode={s.dictation.mode}
              elapsedMs={s.dictation.elapsedMs}
              level={s.dictation.level}
              anchor={s.dictation.anchor}
              onStop={() => void s.dictation!.stop("user")}
              onCancel={() => void s.dictation!.cancel()}
            />
            <DictationPill
              t={t}
              pill={s.dictation.pill}
              onRevert={() => s.dictation!.revertLast()}
              onDecideSuggestion={(id, action) => void s.dictation!.decideSuggestion(id, action)}
              onDismiss={() => s.dictation!.dismissPill()}
            />
          </>
        ) : null}
        {s.update.busyDialog ? (
          <Modal testId="update-busy-dialog" title={t("update.busy.title")} closeLabel={t("common.close")} onClose={() => s.update.cancelBusyRestart()}>
            <p data-testid="update-busy-body">{t("update.busy.body", { items: busyItemsLabel })}</p>
            <div className="msettings-actions mt-3">
              <button
                type="button"
                className="primary-button"
                data-testid="update-busy-confirm"
                onClick={() => void s.update.confirmBusyRestart()}
              >
                {t("update.busy.confirm")}
              </button>
              <button
                type="button"
                className="secondary-button"
                data-testid="update-busy-cancel"
                onClick={() => s.update.cancelBusyRestart()}
              >
                {t("update.busy.cancel")}
              </button>
            </div>
          </Modal>
        ) : null}
      </ShellFrame>
    </WindowFullscreenProvider>
  );
}
