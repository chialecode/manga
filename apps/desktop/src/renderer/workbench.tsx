import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { chordLabel, chordOf } from "@manga/contracts/keys";
import type { RailView, WorkspacePreset } from "@manga/contracts";
import type { MessageKey } from "@manga/i18n";
import type { ShellPreference } from "@manga/contracts/reading";
import { MAIN_FLOOR, deriveShell } from "../../../../packages/app-core/src/domain/shell-layout.ts";
import { Modal } from "./components/modal.tsx";
import type { MenuItem } from "./components/menu.tsx";
import { Toasts } from "./components/toast.tsx";
import { TitleActions } from "./components/title-actions.tsx";
import { DebugPanel, loadDebugView, saveDebugView, useNoticeLog, type DebugView } from "./pages/debug-panel.tsx";
import { attempt } from "./lib/api.ts";
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
import { ShellFrame, type ShellLabels, type ShellRail, type SidebarContent, type TopMenu } from "./shell.tsx";
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

const PRESETS: readonly WorkspacePreset[] = ["single", "two", "three", "quad"];
const COLUMN_ACTIONS = ["global.column1", "global.column2", "global.column3", "global.column4"] as const;

/** The editable thing the person was in before a menu took the focus, for the edit menu to act on. */
function useLastEditable() {
  const last = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const onFocus = (event: FocusEvent) => {
      const el = event.target;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el instanceof HTMLElement && el.isContentEditable)) last.current = el;
    };
    document.addEventListener("focusin", onFocus);
    return () => document.removeEventListener("focusin", onFocus);
  }, []);
  return useCallback((run: () => void) => {
    // The menu closes and gives the focus back to its button first; the command goes to what had the focus before.
    window.setTimeout(() => {
      const el = last.current;
      if (el && el.isConnected) el.focus();
      run();
    }, 0);
  }, []);
}

/**
 * What is on screen (A-94): the frame with its top row and menus, the icon rail, the sidebar, the tabbed main area with the docks of the contexts kept
 * alive, and the dock that follows the tab in front. It reads the services every tab shares and the workspace controller; it holds no page state of
 * its own beyond the window's (full screen, the debug panel, the about box).
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
  const { t, i18n } = s;
  const controller = useWorkspace();
  const keyTable = useKeyTable();
  const focused = useWorkspaceValue((c) => c.focusedTab());
  const canBack = useWorkspaceValue((c) => c.canBack());
  const canForward = useWorkspaceValue((c) => c.canForward());
  const preset = useWorkspaceValue((c) => c.preset());
  const columns = useWorkspaceValue((c) => c.columns());
  const closedCount = useWorkspaceValue((c) => c.closedCount());
  const context = s.currentContext;
  const [viewport, setViewport] = useState({ width: window.innerWidth || 1280, height: window.innerHeight || 840 });
  const [aboutOpen, setAboutOpen] = useState(false);
  const [screenFull, setScreenFull] = useState(() => Boolean(document.fullscreenElement));
  const chrome = useRef<{ toggle: (side: Side) => void } | null>(null);
  const runEdit = useLastEditable();
  const { state: shellStore, snapshot } = useShellState();
  const { rail, change: changeRail } = useRail();
  const settingsOn = snapshot.settings.on;

  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth || 1280, height: window.innerHeight || 840 });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    const onChange = () => setScreenFull(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
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
  const toggleScreenFullscreen = useCallback(() => {
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen();
    } catch { /* the window stays as it is */ }
  }, []);

  // ---- the sidebar and the dock: widths and visibility are shown at once, then saved ------------------------------------------------
  const [pref, setPref] = useState<ShellPreference>(s.shell);
  const shellKey = JSON.stringify(s.shell);
  useEffect(() => { setPref(s.shell); }, [shellKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const changeSide = useCallback((side: Side, patch: { visible?: boolean; width?: number }) => {
    setPref((current) => ({ ...current, [side]: { ...current[side], ...patch } }));
    void attempt("settings.setShell", { [side]: patch }).then(async (saved) => {
      if (!saved.ok) s.setError(saved.error.message);
      await s.refresh();
    });
  }, [s]);

  // ---- the dock: the Agent, following the tab in front -------------------------------------------------------------------------------
  const reading = useReaderContext();
  const surface = useMemo(
    () => surfaceOfTab(focused, context, { reading: reading ? { resourceId: reading.resourceId, revisionId: reading.revisionId, title: reading.title, workId: reading.workId ?? null } : null }),
    [focused, context, reading?.resourceId, reading?.revisionId, reading?.title, reading?.workId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const agent = useAgent(surface);
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
  useEffect(() => {
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
      event.preventDefault();
      if (shellStore.getSnapshot().settings.on) { if (event.button === 3) shellStore.back(); else shellStore.forward(); return; }
      if (event.button === 3) latest.current.controller.back(); else latest.current.controller.forward();
    };
    window.addEventListener("mouseup", onMouse);
    return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("mouseup", onMouse); };
  }, []);

  // ---- the menus (UI-01) --------------------------------------------------------------------------------------------------------------------
  const hint = (label: string, action: string): string => {
    const first = keyTable[action]?.[0];
    return first ? `${label}（${chordLabel(first)}）` : label;
  };
  const mainFloor = Math.max(MAIN_FLOOR, (columns >= 4 ? 2 : columns) * MIN_COLUMN_WIDTH);
  const chromeNow = deriveShell({ viewport, preference: settingsOn ? { ...pref, sidebar: { ...pref.sidebar, visible: true } } : pref, hasDock: hasDock && !settingsOn, overlay: null, mainFloor });
  const toggleSide = (side: Side) => chrome.current?.toggle(side);
  const edit = (command: string) => () => runEdit(() => { document.execCommand(command); });
  const pasteText = () => runEdit(() => {
    void (async () => {
      try {
        const text = await navigator.clipboard.readText();
        if (text) document.execCommand("insertText", false, text);
      } catch {
        document.execCommand("paste");
      }
    })();
  });
  const item = (id: string, label: string, onSelect: () => void, extra: Partial<MenuItem> = {}): MenuItem => ({ id, label, onSelect, ...extra });
  const menus: TopMenu[] = [
    {
      id: "file",
      label: t("menu.file"),
      items: [
        item("new-project", hint(t("menu.newProject"), "global.newProject"), () => s.open.newProject(), { disabled: !s.facets.has("projects") }),
        item("new-conversation", hint(t("menu.newConversation"), "global.newConversation"), () => { void s.open.newConversation(); }, { disabled: !s.facets.has("agent") }),
        item("new-tab", hint(t("menu.newTab"), "global.newTab"), () => s.open.newTab()),
        item("reopen-tab", hint(t("menu.reopenTab"), "global.reopenTab"), () => s.open.reopenTab(), { disabled: closedCount === 0 }),
        item("close-tab", hint(t("menu.closeTab"), "global.closeTab"), () => s.open.closeTab(), { disabled: !focused || settingsOn }),
        item("import-package", t("menu.importPackage"), () => { s.open.settings("storage"); void s.pkg.previewPackage(); }),
        item("export-package", t("menu.exportPackage"), () => { s.open.settings("storage"); void s.pkg.exportPackage(); }),
        item("scan", t("menu.scan"), () => { void s.scan.start().then((started) => { if (started) s.setNotice(t("menu.scanStarted")); else s.open.settings("library"); }); }),
        item("quit", t("menu.quit"), () => { void window.manga.quit?.(); }),
      ],
    },
    {
      id: "edit",
      label: t("menu.edit"),
      items: [
        item("undo", t("menu.undo"), edit("undo")),
        item("redo", t("menu.redo"), edit("redo")),
        item("cut", t("menu.cut"), edit("cut")),
        item("copy", t("menu.copy"), edit("copy")),
        item("paste", t("menu.paste"), pasteText),
        item("select-all", t("menu.selectAll"), edit("selectAll")),
        item("find", hint(t("menu.find"), "global.search"), () => s.open.search()),
      ],
    },
    {
      id: "view",
      label: t("menu.view"),
      items: [
        ...PRESETS.map((name) => item(`layout-${name}`, t(`layout.${name}` as MessageKey), () => { shellStore.leaveSettings(); controller.setPreset(name); }, { checked: preset === name })),
        item("sidebar", hint(t("menu.showSidebar"), "global.sidebar"), () => toggleSide("sidebar"), { checked: chromeNow.sidebar === "dock" }),
        item("dock", hint(t("menu.showDock"), "global.dock"), () => toggleSide("dock"), { checked: chromeNow.dock === "dock", disabled: !hasDock || settingsOn }),
        item("window-fullscreen", hint(t("menu.windowFullscreen"), "global.windowFullscreen"), toggleWindowFullscreen, { checked: immersive, disabled: !readerFront }),
        item("screen-fullscreen", t("menu.screenFullscreen"), toggleScreenFullscreen, { checked: screenFull }),
        item("debug", hint(t("debug.open"), "global.debug"), toggleDebug, { checked: debugView.open }),
      ],
    },
    {
      id: "help",
      label: t("menu.help"),
      items: [
        item("shortcuts", t("menu.shortcuts"), () => s.open.keys()),
        item("logs", t("menu.logs"), () => s.open.settings("logs")),
        item("about", t("menu.about"), () => setAboutOpen(true)),
      ],
    },
  ];

  // ---- the rail and the sidebar (A-99, A-101) ------------------------------------------------------------------------------------------
  const railViews = useMemo(() => railViewsFor(s.facets), [s.facets]);
  const currentView: RailView = railViews.includes(rail.view) ? rail.view : "home";
  const railProps: ShellRail = {
    entries: railViews.map((view) => ({ view, label: t(VIEW_LABEL[view]) })),
    hidden: rail.hidden,
    current: currentView,
    settings: s.facets.has("settings") ? { active: settingsOn, onSelect: () => s.open.settings() } : null,
    labels: { more: t("rail.more"), moreEmpty: t("rail.moreEmpty"), hide: t("rail.hide"), pin: t("rail.pin"), pinOf: (name) => t("rail.pinOf", { name }), settings: t("nav.settings") },
    // A view of the rail leaves the settings, and the workspace is as it was.
    onSelect: (view) => { if (view !== rail.view) changeRail({ view }); if (settingsOn) shellStore.leaveSettings(); },
    onHide: (view) => { if (isHideable(view)) changeRail({ hidden: [...new Set([...rail.hidden, view])] }); },
    onPin: (view) => changeRail({ hidden: rail.hidden.filter((item) => item !== view) }),
  };
  const hiddenPages = useMemo(() => hiddenSettingsPages(s.facets), [s.facets]);
  const sidebar: SidebarContent = (view, options) => (view === "settings"
    ? <SettingsNav key="settings" t={t} page={snapshot.settings.page} hidden={hiddenPages} variant={options.variant} onPage={(page) => shellStore.goTo(page)} {...(options.onDone ? { onDone: options.onDone } : {})} />
    : <Sidebar key={view} view={view} variant={options.variant} {...(options.onDone ? { onDone: options.onDone } : {})} />);

  const labels: ShellLabels = {
    exitImmersive: t("window.fullscreen.exit"),
    showSidebar: t("shell.showSidebar"),
    hideSidebar: t("shell.hideSidebar"),
    showDock: t("shell.showDock"),
    hideDock: t("shell.hideDock"),
    stop: t("shell.stop"),
    back: t("shell.back"),
    forward: t("shell.forward"),
    menubar: t("shell.menubar"),
    rail: t("shell.rail"),
    sidebar: t("shell.sidebar"),
    dock: t("shell.dock"),
    resizeSidebar: t("shell.resizeSidebar"),
    resizeDock: t("shell.resizeDock"),
    window: { group: t("window.controls"), minimize: t("window.minimize"), maximize: t("window.maximize"), restore: t("window.restore"), close: t("window.close") },
  };

  const live = reading as ReaderContext | null;
  const channelLabel = s.host.layout.channel === "release" ? t("app.channel.release") : s.host.layout.channel === "test" ? t("app.channel.test") : t("app.channel.development");
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
        menus={menus}
        settings={settingsOn}
        rail={railProps}
        history={settingsOn ? { canBack: true, canForward: snapshot.settings.index < snapshot.settings.trail.length - 1, onBack: () => shellStore.back(), onForward: () => shellStore.forward() } : { canBack, canForward, onBack: () => controller.back(), onForward: () => controller.forward() }}
        mainFloor={mainFloor}
        keys={{ sidebar: keyTable["global.sidebar"] ?? [], dock: keyTable["global.dock"] ?? [] }}
        controlRef={chrome}
        onHide={(side) => changeSide(side, { visible: false })}
        onShow={(side) => changeSide(side, { visible: true })}
        onResize={(side, width) => changeSide(side, { width })}
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
        <div className="workspace-area" data-testid="workspace-area" data-suspended={settingsOn ? "true" : "false"} {...(settingsOn ? { inert: true } : {})}>
          <WorkspaceHosts />
        </div>
        {settingsOn ? (
          <div className="settings-area" data-testid="settings-area" data-page={snapshot.settings.page}>
            <SettingsPane page={snapshot.settings.page} onPage={(page) => shellStore.goTo(page)} />
          </div>
        ) : null}
        {snapshot.search.open ? <SearchBox key={snapshot.search.n} initialQuery={snapshot.search.query} initialScope={snapshot.search.scope} onClose={() => shellStore.closeSearch()} /> : null}
        {aboutOpen ? (
          <Modal testId="about-dialog" title={t("about.title")} closeLabel={t("common.close")} onClose={() => setAboutOpen(false)}>
            <p>{t("about.blurb")}</p>
            <dl className="about-facts">
              <dt>{t("about.version")}</dt><dd data-testid="about-version">{s.host.appVersion ?? "-"}</dd>
              <dt>{t("about.channel")}</dt><dd data-testid="about-channel">{channelLabel}</dd>
            </dl>
          </Modal>
        ) : null}
      </ShellFrame>
    </WindowFullscreenProvider>
  );
}
