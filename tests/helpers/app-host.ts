import { DEFAULT_SHELL_PREFERENCE, type ShellPreference } from "@manga/contracts/reading";

/** A synthetic host for the whole renderer: the commands the app asks, answered from small in-memory tables, with every call kept. */

export type Call = { commandId: string; input: Record<string, unknown> };
export type Handler = (input: Record<string, unknown>) => unknown;

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

export type HostOptions = {
  overrides?: Record<string, Handler>;
  facets?: string[];
  /** The mode the workspace starts in. */
  mode?: "enthusiast" | "creator";
};

/**
 * What the renderer needs to run: one video work and one comic work, their pages and the position that is saved when the player reports it.
 * The saved position and the mode live here, so a test can leave a resource and come back to what was kept.
 */
export function installHost(options: HostOptions = {}) {
  const calls: Call[] = [];
  const state = {
    mode: options.mode ?? "enthusiast",
    /** resourceId → saved time of a video. */
    times: new Map<string, number>(),
    /** resourceId → last page of a comic. */
    pages: new Map<string, string>(),
  };
  const sessions: SessionRow[] = [
    { sessionId: "ses_shared", title: "会话 1", kind: "shared", targetId: null, mode: "enthusiast", runCount: 0, activeRunId: null, activeRunStatus: null },
  ];
  const facets = options.facets ?? ["agent", "library", "settings", "comic", "video", "notes"];
  const shellOf = (mode: "enthusiast" | "creator"): ShellPreference => ({ ...DEFAULT_SHELL_PREFERENCE, mode });
  const handlers: Record<string, Handler> = {
    "workspace.get": () => ({ uiFacets: facets, sessions: [], runs: [], notes: [], resources: [], shell: shellOf(state.mode) }),
    "workspace.sessions": (input) => sessions.filter((row) => !input.mode || row.mode === input.mode),
    "conversation.current": (input) => ({ conversation: sessions.find((row) => row.kind === "shared" && row.mode === (input.mode ?? state.mode)) ?? null }),
    "settings.setShell": (input) => { if (typeof input.mode === "string") state.mode = input.mode as typeof state.mode; return {}; },
    "inventory.overview": () => ({ items: [], totals: {} }),
    "settings.get": () => ({ needsSetup: false, recoveryJobs: [], aiRuntime: "native", connections: [{ purpose: "text" }] }),
    "notes.list": () => [],
    "quickTasks.list": () => ({ tasks: [] }),
    "session.open": (input) => {
      const mode = typeof input.mode === "string" ? input.mode : state.mode;
      const id = `ses_${mode}_${String(input.kind)}_${String(input.targetId)}`;
      if (!sessions.some((row) => row.sessionId === id)) sessions.push({ sessionId: id, title: String(input.targetId), kind: input.kind, targetId: input.targetId, mode, runCount: 0, activeRunId: null, activeRunStatus: null });
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
