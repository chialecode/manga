import { DEFAULT_RAIL_PREFERENCE, applyRailPatch, type RailPatch, type RailPreference } from "@manga/contracts";
import { DEFAULT_SHELL_PREFERENCE, type ShellPreference } from "@manga/contracts/reading";

/** A synthetic host for the whole renderer: the commands the app asks, answered from small in-memory tables, with every call kept. */

export type Call = { commandId: string; input: Record<string, any> };
export type Handler = (input: Record<string, any>) => unknown;

export type SessionRow = Record<string, unknown>;

export const work = (id: string, kind: "video" | "comic", resourceId: string) => ({
  id, title: `作品 ${id}`, author: "合成作者", mediaKind: kind, shelf: "reading", coverId: null,
  lastResource: { id: resourceId, title: `作品 ${id}`, ordinalLabel: null, revisionId: `rev_${resourceId}` },
  progress: 0.25, finishedCount: 0, resourceCount: 2, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null,
});

/** The work's own page needs the whole record: fields, override, links, resources. */
export const workDetail = (id: string, kind: "video" | "comic", title: string, resources: Array<Record<string, unknown>>) => ({
  ...work(id, kind, String(resources[0]!.id)), title, originalTitle: title, fields: {}, override: { fields: {}, locked: [], cleared: [] }, links: [], snapshots: [], coverState: "auto", coverCount: 0, resources,
});

export type ContextRow = { contextId: string | null; kind: "recent" | "project"; name: string; status?: "active" | "archived"; conversationCount?: number; tabCount?: number; lastActivityAt?: string | null };

/** A thing the synthetic sidebar lists besides the conversations (which come from the session table): a work, a note, a whiteboard … */
export type HostItem = { type: "novel" | "comic" | "video" | "note" | "whiteboard" | "mindmap" | "draft" | "roughcut"; id: string; title: string; contextId?: string | null; updatedAt?: string; detail?: string | null };

const OPEN_KIND: Record<HostItem["type"], string> = { novel: "work", comic: "work", video: "work", note: "note", whiteboard: "whiteboard", mindmap: "mindmap", draft: "draft", roughcut: "roughcut" };
const ITEM_TYPES: ReadonlyArray<"conversation" | HostItem["type"]> = ["conversation", "novel", "comic", "video", "note", "whiteboard", "mindmap", "draft", "roughcut"];

export type HostOptions = {
  overrides?: Record<string, Handler>;
  facets?: string[];
  /** The things besides conversations that the sidebar lists. */
  items?: HostItem[];
  /** The projects the host knows (the "recent" context is always there). */
  projects?: Array<{ id: string; name: string }>;
  /** The saved tabs and layout of a context, by context id ("" for "recent"), as a profile that was used before would hold them. */
  workspaces?: Record<string, unknown>;
  /** The context the person was last in. */
  lastContext?: string | null;
};

/**
 * What the renderer needs to run: one video work and one comic work, their pages and the position that is saved when the player reports it.
 * The saved position and the saved tabs of each context live here, so a test can leave a resource and come back to what was kept.
 */
export function contextHandlers(options: Pick<HostOptions, "facets" | "projects" | "workspaces" | "lastContext" | "items"> & { sessions?: SessionRow[] } = {}) {
  const state = {
    /** context id ("" for "recent") → the saved tabs and layout, as `workspace.saveContext` last got them. */
    workspaces: new Map<string, unknown>(Object.entries(options.workspaces ?? {})),
    lastContext: options.lastContext ?? null,
    /** What the shell kept of the rail (the icons out, the view, the groups open), as `settings.setShell` last got it. */
    rail: structuredClone(DEFAULT_RAIL_PREFERENCE) as RailPreference,
  };
  const sessions: SessionRow[] = options.sessions ?? [
    { sessionId: "ses_shared", title: "会话 1", kind: "shared", targetId: null, contextId: null, runCount: 0, activeRunId: null, activeRunStatus: null },
  ];
  const facets = options.facets ?? ["agent", "library", "settings", "comic", "video", "notes"];
  const shellOf = (): ShellPreference => ({ ...DEFAULT_SHELL_PREFERENCE, lastContext: state.lastContext, rail: state.rail });
  const contexts = (): ContextRow[] => [
    { contextId: null, kind: "recent", name: "最近", status: "active", conversationCount: sessions.filter((row) => row.contextId === null).length, tabCount: 0, lastActivityAt: null },
    ...(options.projects ?? []).map((project) => ({ contextId: project.id, kind: "project" as const, name: project.name, status: "active" as const, conversationCount: sessions.filter((row) => row.contextId === project.id).length, tabCount: 0, lastActivityAt: null })),
  ];

  // ---- what the sidebar lists: the conversations of the session table, and the items the test gave ----
  const projectName = (id: string | null) => (options.projects ?? []).find((project) => project.id === id)?.name ?? null;
  const itemOf = (type: (typeof ITEM_TYPES)[number], id: string) => {
    if (type === "conversation") {
      const row = sessions.find((session) => session.sessionId === id)!;
      const contextId = (row.contextId as string | null) ?? null;
      return {
        key: `conversation:${id}`, type, title: String(row.title), detail: null,
        open: { kind: "conversation", id, general: row.kind === "shared" || row.kind === "project" }, contextId, contextName: projectName(contextId),
        updatedAt: String(row.updatedAt ?? "2026-01-01T00:00:00.000Z"), running: row.activeRunStatus === "running", materialId: null,
      };
    }
    const found = (options.items ?? []).find((item) => item.type === type && item.id === id)!;
    const contextId = found.contextId ?? null;
    return {
      key: `${type}:${id}`, type, title: found.title, detail: found.detail ?? null,
      open: { kind: OPEN_KIND[type], id, ...(OPEN_KIND[type] === "work" ? { mediaKind: type } : {}) }, contextId, contextName: projectName(contextId),
      updatedAt: found.updatedAt ?? "2026-01-01T00:00:00.000Z", running: false, materialId: contextId ? `mat_${id}` : null,
    };
  };
  /** The ids of one kind in one context, newest first. A conversation is listed when it is a general one or something was asked in it, and not when it is about a file that is outside every library path (`openState: "outside"`). */
  const idsOf = (type: (typeof ITEM_TYPES)[number], contextId: string | null) => {
    if (type === "conversation") {
      return sessions
        .filter((row) => ((row.contextId as string | null) ?? null) === contextId && row.openState !== "outside" && (row.kind === "shared" || row.kind === "project" || Number(row.runCount ?? 0) > 0))
        .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
        .map((row) => String(row.sessionId));
    }
    return (options.items ?? []).filter((item) => item.type === type && (item.contextId ?? null) === contextId).sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))).map((item) => item.id);
  };
  const SHOWN = 5;
  const sectionOf = (type: (typeof ITEM_TYPES)[number], contextId: string | null, wanted: boolean, perGroup: number) => {
    const ids = idsOf(type, contextId);
    const first = ids.slice(0, perGroup);
    return { type, total: ids.length, items: wanted ? first.map((id) => itemOf(type, id)) : [], loaded: wanted, nextCursor: wanted && ids.length > first.length ? String(first.length) : null };
  };
  const sidebar = (input: Record<string, any>) => {
    const view = String(input.view);
    const perGroup = Number(input.perGroup ?? SHOWN);
    const open = input.open as Array<string | null> | undefined;
    const types = ITEM_TYPES.filter((type) => (view === "home" ? true : type === view));
    const place = (contextId: string | null, kind: "recent" | "project", name: string) => {
      const wanted = !open || open.some((key) => (key ?? null) === contextId);
      const sections = types.map((type) => sectionOf(type, contextId, wanted, perGroup)).filter((section) => view !== "home" || section.total > 0);
      return { contextId, kind, name, sections };
    };
    if (view === "downloads") return { view, groups: [], downloads: { type: "download", total: 0, items: [], loaded: true, nextCursor: null } };
    return { view, groups: [...(options.projects ?? []).map((project) => place(project.id, "project", project.name)), place(null, "recent", "最近")], downloads: null };
  };
  const handlers: Record<string, Handler> = {
    "workspace.sidebar": sidebar,
    "workspace.items": (input) => {
      const type = (input.type ?? input.view) as (typeof ITEM_TYPES)[number];
      const ids = idsOf(type, (input.contextId as string | null) ?? null);
      const start = Number(input.cursor ?? 0);
      const limit = Number(input.limit ?? 20);
      const page = ids.slice(start, start + limit);
      return { items: page.map((id) => itemOf(type, id)), nextCursor: start + page.length < ids.length ? String(start + page.length) : null };
    },
    "workspace.objects": () => ({ items: [], total: 0, nextOffset: null }),
    "workspace.find": (input) => {
      const q = String(input.q).toLowerCase();
      const only = input.view && input.view !== "home" ? String(input.view) : null;
      const perType = Number(input.perType ?? 4);
      const groups: Array<{ type: string; items: unknown[] }> = [];
      const projects = (options.projects ?? []).filter((project) => !only && project.name.toLowerCase().includes(q));
      if (projects.length) groups.push({ type: "project", items: projects.slice(0, perType).map((project) => ({ key: `project:${project.id}`, type: "project", title: project.name, detail: null, open: { kind: "project", id: project.id }, contextId: project.id, contextName: project.name, updatedAt: null, running: false, materialId: null })) });
      for (const type of ITEM_TYPES) {
        if (only && only !== type) continue;
        const ids = [...new Set([null, ...(options.projects ?? []).map((project) => project.id)].flatMap((contextId) => idsOf(type, contextId)))];
        // What is found by name opens where the person is, unless it has a place of its own (a conversation, a project's object).
        const placed = type === "conversation" || ["whiteboard", "mindmap", "draft", "roughcut"].includes(type);
        const hits = ids.map((id) => itemOf(type, id)).filter((item) => item.title.toLowerCase().includes(q)).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, perType)
          .map(({ contextId, ...rest }) => (placed || contextId ? { ...rest, contextId } : rest));
        if (hits.length) groups.push({ type, items: hits });
      }
      return { groups };
    },
    "workspace.get": () => ({ uiFacets: facets, sessions: [], runs: [], notes: [], resources: [], shell: shellOf() }),
    "workspace.sessions": (input) => sessions.filter((row) => !("contextId" in input) || row.contextId === (input.contextId ?? null)),
    "workspace.contexts": () => ({ contexts: contexts() }),
    "workspace.loadContext": (input) => ({ contextId: input.contextId ?? null, state: state.workspaces.get(String(input.contextId ?? "")) ?? null, updatedAt: null, damaged: false }),
    "workspace.saveContext": (input) => { state.workspaces.set(String(input.contextId ?? ""), input.state); return { contextId: input.contextId ?? null, trimmed: false, bytes: 0, updatedAt: "2026-01-01T00:00:00.000Z" }; },
    "workspace.setLastContext": (input) => { state.lastContext = (input.contextId as string | null) ?? null; return {}; },
    "conversation.current": (input) => ({ conversation: sessions.find((row) => row.kind === "shared" && row.contextId === (input.contextId ?? null)) ?? null }),
    "settings.setShell": (input) => { state.rail = applyRailPatch(state.rail, input.rail as RailPatch | undefined); return {}; },
  };
  return { handlers, state, sessions };
}

export function installHost(options: HostOptions = {}) {
  const calls: Call[] = [];
  const context = contextHandlers(options);
  const { sessions } = context;
  const state = Object.assign(context.state, {
    /** resourceId → saved time of a video. */
    times: new Map<string, number>(),
    /** resourceId → last page of a comic. */
    pages: new Map<string, string>(),
  });
  const handlers: Record<string, Handler> = {
    ...context.handlers,
    "inventory.overview": () => ({ items: [], totals: {} }),
    "settings.get": () => ({ needsSetup: false, recoveryJobs: [], aiRuntime: "native", connections: [{ purpose: "text" }] }),
    "notes.list": () => [],
    "quickTasks.list": () => ({ tasks: [] }),
    "session.open": (input) => {
      const contextId = (input.contextId as string | null | undefined) ?? null;
      const id = `ses_${contextId ?? "recent"}_${String(input.kind)}_${String(input.targetId)}`;
      if (!sessions.some((row) => row.sessionId === id)) sessions.push({ sessionId: id, title: String(input.targetId), kind: input.kind, targetId: input.targetId, contextId, runCount: 0, activeRunId: null, activeRunStatus: null });
      return { id, kind: input.kind, targetId: input.targetId };
    },
    "session.stream": () => ({ items: [], hasMore: false, session: { id: "ses", kind: "work", targetId: null, workId: null, resourceId: null } }),
    "works.list": (input) => {
      const items = input.kind === "video" || !input.kind ? [work("wv", "video", "res_v1")] : input.kind === "comic" ? [work("wc", "comic", "res_c1")] : [];
      return { items, total: items.length, nextCursor: null };
    },
    "works.open": () => ({ workId: "wv", shelf: "reading", promoted: false }),
    "works.get": (input) => input.workId === "wc"
      ? workDetail("wc", "comic", "合成漫画", [{ id: "res_c1", title: "漫画一", kind: "comic", ordinalLabel: "第 1 话", available: true }])
      : workDetail("wv", "video", "合成动画", [
        { id: "res_v1", title: "开场", kind: "video", ordinalLabel: "第 1 话", available: true },
        { id: "res_v2", title: "后续", kind: "video", ordinalLabel: "第 2 话", available: true },
        { id: "res_c1", title: "漫画一", kind: "comic", ordinalLabel: "第 1 话", available: true },
      ]),
    "covers.list": () => ({ workId: "wv", state: "auto", coverId: null, covers: [] }),
    "video.probe": (input) => ({ resourceId: input.resourceId, revisionId: `rev_${String(input.resourceId)}`, available: true, probe: { durationMs: 120_000 } }),
    "video.audioTracks": () => ({ audio: [] }),
    "video.subtitles": () => ({ subtitles: [] }),
    "video.playbackPlan": () => ({ available: true, plan: { decision: "direct", reasons: [], detail: "" }, copy: null }),
    "video.handle": () => ({ url: "manga-media://h/v", mediaType: "video/mp4", bytes: 1, startMs: 0 }),
    "video.frameIndex": () => { throw Object.assign(new Error("none"), { code: "CAPABILITY_UNAVAILABLE" }); },
    "settings.getMedia": () => ({}),
    "progress.get": (input) => {
      const resourceId = String(input.resourceId);
      const page = state.pages.get(resourceId);
      if (page) return { locator: { kind: "image", pageId: page }, completion: "in_progress" };
      const time = state.times.get(resourceId);
      return { locator: time !== undefined ? { kind: "temporal", startMs: time } : null, completion: "in_progress" };
    },
    "progress.setTime": (input) => { state.times.set(String(input.resourceId), Number(input.timeMs)); return {}; },
    "progress.setPage": (input) => { state.pages.set(String(input.resourceId), String(input.pageId)); return {}; },
    "comic.pages": (input) => ({
      resourceId: input.resourceId, revisionId: "rev_res_c1", title: "合成漫画", direction: null, available: true, warnings: [],
      pages: Array.from({ length: 6 }, (_, index) => ({ id: `p${index}`, index, name: `${index}.png`, width: 800, height: 1200, spread: false, ok: true })),
    }),
    "comic.pageHandles": (input) => ({ pages: (input.pageIds as string[]).map((pageId) => ({ pageId, available: true, kind: "image", url: `manga-media://h/${pageId}`, handle: pageId, mediaType: "image/png", width: 800, height: 1200 })) }),
    ...options.overrides,
  };
  (window as unknown as { manga: unknown }).manga = {
    async state() { return { layout: { channel: "test", pointerPath: "pointer.json", partitions: { data: "d" }, writable: true, recovery: "none" }, writable: true, vaultAvailable: true }; },
    async command(payload: { commandId: string; input?: Record<string, unknown> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      const handler = handlers[payload.commandId];
      if (!handler) return { status: "ok", value: {} };
      try { return { status: "ok", value: handler(input) }; } catch (error) {
        const failure = error as { code?: string; message?: string };
        return { status: "error", error: { code: failure.code ?? "INTERNAL", message: failure.message ?? "failed" } };
      }
    },
    onNotice: () => () => undefined,
    async chooseDirectory() { return null; }, async chooseFile() { return null; }, async chooseAudio() { return null; }, async stashSecret() { return null; },
    async reveal() { return { status: "ok", value: {} }; },
  };
  return { calls, state, sessions, of: (id: string) => calls.filter((call) => call.commandId === id) };
}

/** The page history keeps a place the person stayed on for a moment; a test that goes back stays on each place for that moment. */
export const stay = () => new Promise<void>((resolve) => { setTimeout(resolve, 140); });
