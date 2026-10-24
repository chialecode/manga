import type { Translator } from "@manga/i18n";
import type { SegmentAnchor } from "@manga/contracts/media";
import type { ContextId, ObjectListKind } from "@manga/contracts";
import type { OpenBlock } from "../pages/open-blocked-dialog.tsx";
import { attempt } from "../lib/api.ts";
import { OBJECT_SPEC } from "../lib/object-kinds.ts";
import type { SettingsPageId } from "../lib/shell-model.ts";
import type { WorkMediaKind } from "../lib/works.ts";
import type { WorkspaceController } from "./controller.ts";
import { behindIntent } from "./intent.ts";
import type { OpenOptions, Openers } from "./services.tsx";

/** What the openers need from the application; read again at each call, so they always see the application as it is now. */
export type OpenerDeps = {
  controller: WorkspaceController;
  t: Translator["t"];
  setError: (message?: string) => void;
  setNotice: (message?: string) => void;
  /** A resource that cannot be opened (outside every library path, or its file is gone) is told in a dialog (A-86). */
  setOpenBlock: (block: OpenBlock) => void;
  /** A recording is reviewed in a drawer over the window. */
  reviewRecording: (target: { sessionId?: string; workId?: string; resourceId?: string }) => void;
  switchContext: (contextId: string | null) => Promise<void>;
  conversationsChanged: () => void;
  /** Something a list shows has changed (an object made from the sidebar). */
  changed: () => void;
  /** The dialog that names a new project. */
  newProject: () => void;
  /** The settings view is brought up (A-101): the workspace stays where it is, behind it. */
  enterSettings: (page?: SettingsPageId) => void;
  /** The settings are left: anything that opens something in the workspace says so first, so what opens is on screen. */
  leaveSettings: () => void;
  /** The search box is brought up (A-100); without a scope it takes the one of the view on screen. */
  openSearch: (options?: { query?: string; scope?: string | null }) => void;
};

const mediaKindOfLocator = (locator: { kind?: string } | null | undefined): WorkMediaKind => (locator?.kind === "image" ? "comic" : locator?.kind === "temporal" ? "video" : "novel");

/** The title a library tab has at a page of the library. */
export function libraryTitle(t: Translator["t"], page: string): string {
  return page === "novel" ? t("nav.novel") : page === "comic" ? t("nav.comic") : page === "video" ? t("nav.video") : page === "work" ? t("tab.work") : t("tab.library");
}

/**
 * Every opening of a thing in the workspace goes through here (A-94): the shelf, a note, the Agent's links, a project's materials, a menu and the
 * sidebar all say what they want and get the same tab, with the same rules — a tab that already shows it is switched to, a new tab opens in the
 * column in front, Ctrl + click and the middle button open behind.
 */
export function createOpeners(get: () => OpenerDeps): Openers {
  const c = () => get().controller;
  const t = (...args: Parameters<Translator["t"]>) => get().t(...args);
  /** The options of this call with the click's own intent added: a Ctrl click (or the middle button) opens a new tab behind the one in front. */
  const withIntent = <T extends OpenOptions>(options?: T): T => (behindIntent() ? ({ ...options, mode: "new", background: true } as T) : (options ?? ({} as T)));
  const how = (options?: OpenOptions) => {
    const given = withIntent(options);
    return { ...(given.mode ? { mode: given.mode } : {}), ...(given.background ? { background: true } : {}) };
  };

  /** The one question asked before any resource is opened (A-86): can its file be opened? A restore (`silent`) stays quiet. */
  async function gate(resourceId: string, silent = false): Promise<boolean> {
    const result = await attempt<Partial<OpenBlock> & { state?: string }>("library.openable", { resourceId });
    if (!result.ok || (result.value.state !== "outside" && result.value.state !== "missing")) return true;
    if (!silent) get().setOpenBlock({ ...result.value, resourceId, mediaKind: String(result.value.mediaKind ?? "novel"), title: String(result.value.title ?? ""), workId: result.value.workId ?? null, state: result.value.state } as OpenBlock);
    return false;
  }

  /** A management tab (the records of one type, the objects of one kind, the downloads): switched to if the context has it, and sent where it was asked. */
  function management(kind: "records" | "objects" | "downloads", target: Record<string, unknown>, title: string, match: (tab: { target: Record<string, unknown> }) => boolean = () => true) {
    const existing = c().tabsOf().find((tab) => tab.kind === kind && match(tab));
    if (existing) {
      const differs = Object.entries(target).some(([name, value]) => existing.target[name] !== value);
      if (differs) c().navigate(existing.id, { ...existing.target, ...target }, title);
      c().focusTab(existing.id);
      return;
    }
    c().open({ kind, target, title });
  }

  const self: Openers = {
    async resource(input, given = {}) {
      const options = withIntent(given);
      if (!(await gate(input.resourceId, options.silent))) return;
      c().open({
        kind: "reader",
        target: { resourceId: input.resourceId, mediaKind: input.mediaKind ?? "novel", workId: input.workId ?? null },
        ...(options.title ? { title: options.title } : {}),
        ...how(options),
        ...(options.launch ? { launch: options.launch } : {}),
      });
    },

    continueWork(summary, options) {
      const resourceId = summary.lastResource?.id;
      if (!resourceId) { self.work(summary.id, { ...options, kind: summary.mediaKind as WorkMediaKind, title: summary.title }); return; }
      void self.resource({ resourceId, mediaKind: summary.mediaKind as WorkMediaKind, workId: summary.id }, { ...options, title: summary.title });
    },

    async episode(tabId, resourceId) {
      if (!(await gate(resourceId))) return;
      const tab = c().tabsOf().find((item) => item.id === tabId);
      if (tab) c().navigate(tabId, { ...tab.target, resourceId }, tab.title);
    },

    work(workId, given = {}) {
      const options = withIntent(given);
      const target = { page: "work", workId, ...(options.kind ? { kind: options.kind } : {}), ...(options.tab ? { tab: options.tab } : {}) };
      const title = options.title ?? t("tab.work");
      const focused = c().focusedTab();
      if (!options.mode && !options.background && focused?.kind === "library") {
        if (JSON.stringify(focused.target) !== JSON.stringify(target)) c().navigate(focused.id, target, title);
        return;
      }
      c().open({ kind: "library", target, title, mode: "new", ...(options.background ? { background: true } : {}) });
    },

    library(page = "overview", given = {}) {
      const options = withIntent(given);
      const target = { page };
      const title = libraryTitle(t, page);
      const focused = c().focusedTab();
      if (!options.mode && !options.background && focused?.kind === "library") {
        if (focused.target.page !== page || focused.target.workId) c().navigate(focused.id, target, title);
        return;
      }
      if (!options.mode) {
        const existing = c().tabsOf().find((tab) => tab.kind === "library" && tab.target.page === page && !tab.target.workId);
        if (existing) { if (!options.background) c().focusTab(existing.id); return; }
      }
      c().open({ kind: "library", target, title, mode: "new", ...(options.background ? { background: true } : {}) });
    },

    note(objectId, focusBlockId, options) {
      c().open({ kind: "note", target: { objectId }, title: options?.title ?? t("tab.note"), ...how(options), ...(focusBlockId ? { launch: { blockId: focusBlockId } } : {}) });
    },

    /** A note's source opens in the reader that matches what it points at: text, a page, or a time. */
    async noteSource(objectId, blockId) {
      const probe = await attempt<{ locator?: { kind?: string }; resourceId?: string }>("notes.openSource", { objectId, blockId });
      if (!probe.ok) { get().setError(probe.error.message); return; }
      const resourceId = probe.value.resourceId;
      if (!resourceId) { get().setError(t("reading.sourceMissing")); return; }
      await self.resource({ resourceId, mediaKind: mediaKindOfLocator(probe.value.locator) }, { launch: { fromNote: { probe: probe.value, objectId, blockId: blockId ?? null } } });
    },

    /** A place named by a locator (a bubble's source, a recorded sentence): the reader of its kind opens there. */
    async anchor(anchor: Pick<SegmentAnchor, "resourceId" | "resourceRevisionId" | "locator">) {
      const { resourceId, locator } = anchor;
      if (!resourceId || !locator) return;
      await self.resource({ resourceId, mediaKind: mediaKindOfLocator(locator) }, { launch: { anchor: { resourceId, resourceRevisionId: anchor.resourceRevisionId ?? null, locator } } });
    },

    /** A screenshot opens its source at the moment or the page it was taken from. */
    async screenshot(screenshotId) {
      const found = await attempt<{ screenshot: { resourceId: string; resourceRevisionId: string; mediaKind: string; positionMs: number | null; pageId: string | null } }>("screenshot.get", { screenshotId });
      if (!found.ok) { get().setError(found.error.message); return; }
      const shot = found.value.screenshot;
      const locator = shot.mediaKind === "video" && shot.positionMs !== null ? { kind: "temporal" as const, startMs: shot.positionMs } : shot.pageId ? { kind: "image" as const, pageId: shot.pageId } : null;
      if (!locator) { get().setError(t("screenshot.block.gone")); return; }
      await self.anchor({ resourceId: shot.resourceId, resourceRevisionId: shot.resourceRevisionId, locator } as never);
    },

    /** A passage the semantic search found, opened at its place: the book at the locator, the note at its block, the recording at its review. */
    semanticHit(hit) {
      if (hit.kind === "note" && hit.objectId) { self.note(hit.objectId, hit.blockId); return; }
      if (hit.kind === "recording" && hit.sessionId) { get().reviewRecording({ sessionId: hit.sessionId }); return; }
      if (hit.kind === "body" && hit.resourceId && hit.locator) void self.anchor({ resourceId: hit.resourceId, resourceRevisionId: hit.revisionId, locator: hit.locator } as never);
    },

    async project(projectId, tab, focus) {
      if (projectId === null) {
        c().open({ kind: "project", target: {}, title: t("tab.projects") });
        return;
      }
      await get().switchContext(projectId);
      c().open({ kind: "project", target: { projectId }, title: t("tab.project"), ...(tab || focus ? { launch: { ...(tab ? { tab } : {}), ...(focus ? { focus } : {}) } } : {}) });
    },

    /** A material of a project opens where its kind is shown: a work's page, a reader, a note, a recording's review, or the project's own tab. */
    projectMaterial(material) {
      const projectId = c().activeContextId;
      if (material.kind === "work") { self.work(material.targetId); return; }
      if (material.kind === "note") { self.note(material.targetId); return; }
      if (material.kind === "recording") { get().reviewRecording({ sessionId: material.targetId }); return; }
      // A screenshot opens its source at the moment or the page it was taken from.
      if (material.kind === "screenshot" && material.opens?.position) {
        void self.anchor({ resourceId: material.opens.resourceId, locator: material.opens.position } as never);
        return;
      }
      if ((material.kind === "resource" || material.kind === "anchor" || material.kind === "screenshot") && material.opens) {
        void self.resource({ resourceId: material.opens.resourceId, mediaKind: material.opens.mediaKind as WorkMediaKind, workId: material.opens.workId });
        return;
      }
      if (!projectId) return;
      if (material.kind === "whiteboard" || material.kind === "mindmap" || material.kind === "draft" || material.kind === "roughcut") {
        c().open({ kind: material.kind, target: { projectId, objectId: material.targetId }, title: t(`tab.${material.kind}` as never) });
        return;
      }
      if (material.kind === "excerpt") void self.project(projectId, "excerpt", { kind: "excerpt", id: material.targetId });
    },

    /** What an embed points at, opened where that kind lives: a note in its tab, a board or a map in its tab of the project that owns it. */
    async embed(item) {
      if (item.targetKind === "note") { self.note(item.targetId, item.locator.blockId); return; }
      const found = item.targetKind === "whiteboard"
        ? await attempt<{ board: { projectId: string | null } }>("whiteboard.get", { boardId: item.targetId })
        : await attempt<{ map: { projectId: string | null } }>("mindmap.get", { mapId: item.targetId });
      if (!found.ok) { get().setError(found.error.message); return; }
      const projectId = item.targetKind === "whiteboard" ? (found.value as { board: { projectId: string | null } }).board.projectId : (found.value as { map: { projectId: string | null } }).map.projectId;
      if (!projectId) { get().setError(t("embed.state.deleted")); return; }
      await get().switchContext(projectId);
      c().open({ kind: item.targetKind === "whiteboard" ? "whiteboard" : "mindmap", target: { projectId, objectId: item.targetId }, title: t(item.targetKind === "whiteboard" ? "tab.whiteboard" : "tab.mindmap") });
    },

    async conversation(sessionId, options = {}) {
      const behind = behindIntent();
      if (options.contextId !== undefined && options.contextId !== c().activeContextId) await get().switchContext(options.contextId);
      c().open({ kind: "conversation", target: { sessionId }, title: options.title ?? t("tab.conversation"), ...(behind ? { mode: "new" as const, background: true } : {}) });
    },

    /** A conversation from the history is shown and continued: it becomes the current one of its context. */
    async resumeConversation(sessionId) {
      const resumed = await attempt<{ conversation: { sessionId: string; title: string; contextId: string | null } }>("conversation.resume", { sessionId });
      if (!resumed.ok) { get().setError(resumed.error.message); return; }
      const conversation = resumed.value.conversation;
      get().conversationsChanged();
      await self.conversation(conversation.sessionId, { contextId: conversation.contextId, title: conversation.title });
      get().setNotice(t("conversation.resumed", { title: conversation.title }));
    },

    /** "开启新对话": the conversation that is current moves into the history and a new one takes its place (an empty one is reused). */
    async newConversation() {
      const contextId = c().activeContextId;
      const created = await attempt<{ sessionId: string; reused: boolean }>("conversation.new", { contextId });
      if (!created.ok) { get().setError(created.error.message); return; }
      get().conversationsChanged();
      c().open({ kind: "conversation", target: { sessionId: created.value.sessionId }, title: t("tab.conversation") });
      get().setNotice(t("conversation.started"));
    },

    /** A conversation (or any thing the sidebar and the search list) opens in the context it belongs to, and as the tab of its kind there (交互设计 2.10). */
    async item(found, options = {}) {
      const behind = behindIntent() || options.background === true;
      const how = behind ? { mode: "new" as const, background: true } : {};
      const { open } = found;
      const into = async () => { if (found.contextId !== undefined && found.contextId !== c().activeContextId) await get().switchContext(found.contextId); };
      switch (open.kind) {
        case "project": await self.project(open.id); return;
        case "conversation":
          if (open.general) await self.resumeConversation(open.id);
          else await self.conversation(open.id, { contextId: found.contextId ?? c().activeContextId, title: found.title });
          return;
        case "work": await into(); self.work(open.id, { ...how, ...(open.mediaKind ? { kind: open.mediaKind as WorkMediaKind } : {}), title: found.title }); return;
        case "resource": await into(); await self.resource({ resourceId: open.id, mediaKind: (open.mediaKind ?? "novel") as WorkMediaKind, workId: open.workId ?? null }, { ...how, title: found.title }); return;
        case "note": await into(); self.note(open.id, undefined, { ...how, title: found.title }); return;
        case "download": self.downloads(); return;
        default: {
          const projectId = found.contextId;
          if (!projectId) return;
          await into();
          c().open({ kind: open.kind, target: { projectId, objectId: open.id }, title: found.title ?? t(`tab.${open.kind}` as never), ...how });
        }
      }
    },

    /** The settings are not a tab (A-101): they take the sidebar and the main area, and the workspace stays mounted behind them. */
    settings(page) {
      get().enterSettings(page);
    },
    records(options = {}) {
      const type = options.type ?? "all";
      management("records", { section: "records", type, ...(options.workId ? { workId: options.workId } : {}) }, type === "conversation" ? t("sidebar.manage.conversation") : type === "note" ? t("sidebar.manage.note") : t("tab.records"), (tab) => tab.target.type === type || (type === "all" && tab.target.type === undefined));
    },
    objects(kind) {
      management("objects", { kind }, t(`sidebar.manage.${kind}` as never), (tab) => tab.target.kind === kind);
    },
    async createObject(kind, projectId) {
      const spec = OBJECT_SPEC[kind];
      const existing = await attempt<Record<string, unknown>>(spec.list, { projectId });
      const count = existing.ok ? ((existing.value[spec.listField] as unknown[] | undefined)?.length ?? 0) : 0;
      const made = await attempt<Record<string, { id: string; title: string }>>(spec.create, { projectId, title: t(spec.defaultTitle, { n: count + 1 }) });
      if (!made.ok) { get().setError(made.error.message); return false; }
      const created = made.value[spec.createdField]!;
      get().changed();
      await self.item({ open: { kind, id: created.id }, contextId: projectId, title: created.title });
      return true;
    },
    search(query, scope) {
      get().openSearch({ ...(query ? { query } : {}), ...(scope !== undefined ? { scope } : {}) });
    },
    downloads() {
      management("downloads", {}, t("nav.downloads"));
    },
    keys() {
      get().enterSettings("shortcuts");
    },

    newTab() {
      c().open({ kind: "library", target: { page: "overview" }, title: t("tab.library"), mode: "new" });
    },
    reopenTab() {
      if (!c().reopen()) get().setNotice(t("tab.noneClosed"));
    },
    closeTab() {
      c().closeFocused();
    },

    switchContext: (contextId) => get().switchContext(contextId),
    newProject() {
      get().newProject();
    },
  };

  // Everything that opens or changes something of the workspace leaves the settings first (A-101); the settings, the search box and the dialog that names a
  // new project do not, since they are not in the workspace.
  const STAYS = new Set<keyof Openers>(["settings", "search", "keys", "newProject"]);
  for (const name of Object.keys(self) as Array<keyof Openers>) {
    if (STAYS.has(name)) continue;
    const run = self[name] as (...args: unknown[]) => unknown;
    (self as Record<string, unknown>)[name] = (...args: unknown[]) => { get().leaveSettings(); return run(...args); };
  }
  return self;
}
