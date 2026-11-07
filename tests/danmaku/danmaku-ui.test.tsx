/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { DEFAULT_DANMAKU_SETTINGS, type DanmakuCandidate, type DanmakuItem, type DanmakuMatchInfo, type DanmakuSettings } from "@manga/contracts/danmaku";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { resetVideoSupport } from "../../apps/desktop/src/renderer/readers/video-support.ts";
import { resetDanmakuSettings } from "../../apps/desktop/src/renderer/hooks/use-danmaku-settings.ts";
import { installCapture, installMatchMedia, installMediaElement, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";

Element.prototype.scrollIntoView = () => {};

/** The comment display is not run in a test (jsdom has no canvas): what it was given, and the canvas a screenshot would keep, are what matter. */
const engine = vi.hoisted(() => ({ made: [] as Array<{ comments: Array<{ time: number; text: string; mode: string; color: string }>; fontPx: number; speedPxPerS: number }>, destroyed: 0, canvas: null as HTMLCanvasElement | null }));
vi.mock("../../apps/desktop/src/renderer/readers/danmaku-engine.ts", () => ({
  createEngine: (input: { comments: Array<{ time: number; text: string; mode: string; color: string }>; fontPx: number; speedPxPerS: number }) => {
    engine.made.push({ comments: [...input.comments], fontPx: input.fontPx, speedPxPerS: input.speedPxPerS });
    return { resize() {}, canvas: () => engine.canvas, destroy() { engine.destroyed += 1; } };
  },
}));

type Call = { commandId: string; input: Record<string, any> };
type Handler = (input: Record<string, any>) => unknown;
type Scenario = {
  match: DanmakuMatchInfo | null;
  /** What `danmaku.match` answers when nothing is saved yet. */
  matching: "auto" | "consent" | "choice" | "no_credentials";
  consent: "unasked" | "allowed" | "denied";
  credentials: "built-in" | "custom" | "none";
  items: DanmakuItem[];
};

const work = { id: "wv", title: "作品 wv", author: "合成作者", mediaKind: "video", shelf: "reading", coverId: null, lastResource: { id: "res_v1", title: "作品 wv", ordinalLabel: null, revisionId: "rev_res_v1" }, progress: 0.25, finishedCount: 0, resourceCount: 1, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null };
const detail = { ...work, title: "合成动画", originalTitle: "合成动画", fields: {}, override: { fields: {}, locked: [], cleared: [] }, links: [], snapshots: [], coverState: "auto", coverCount: 0, resources: [{ id: "res_v1", title: "开场", kind: "video", ordinalLabel: "第 1 话", available: true }] };

const matched = (patch: Partial<DanmakuMatchInfo> = {}): DanmakuMatchInfo => ({ source: "dandanplay", animeId: 7, episodeId: 70001, animeTitle: "合成动画", episodeTitle: "第1话 开场", offsetMs: 0, method: "hash", confirmed: false, matchedAt: "2026-10-01T00:00:00.000Z", ...patch });
const item = (at: number, text: string, patch: Partial<DanmakuItem> = {}): DanmakuItem => ({ at, mode: "scroll", color: 0xffffff, source: "", text, ...patch });
const candidates: DanmakuCandidate[] = [
  { animeId: 7, animeTitle: "合成动画", episodeId: 70001, episodeTitle: "第1话 开场", typeDescription: "TV动画" },
  { animeId: 8, animeTitle: "合成动画 第二季", episodeId: 80001, episodeTitle: "第1话 再会", typeDescription: "TV动画" },
];

function installHost(initial: Partial<Scenario> = {}, overrides: Record<string, Handler> = {}) {
  const scenario: Scenario = { match: null, matching: "auto", consent: "unasked", credentials: "built-in", items: [item(1000, "第一条"), item(2000, "第二条", { source: "BiliBili" })], ...initial };
  const settings: { value: DanmakuSettings } = { value: { ...DEFAULT_DANMAKU_SETTINGS } };
  const calls: Call[] = [];
  const revealed: string[] = [];
  const reply = (match: DanmakuMatchInfo) => ({ state: "ok", items: scenario.items, fetchedAt: "2026-10-09T08:00:00.000Z", expiresAt: "2026-10-09T14:00:00.000Z", fromCache: false, stale: false, warning: null, match });
  const handlers: Record<string, Handler> = {
    "workspace.get": () => ({ uiFacets: ["agent", "library", "settings", "comic", "video", "notes", "voice", "whiteboard", "projects", "danmaku"], sessions: [], runs: [], notes: [], resources: [] }),
    "workspace.sessions": () => [],
    "inventory.overview": () => ({ items: [], totals: {} }),
    "settings.get": () => ({ needsSetup: false, recoveryJobs: [], aiRuntime: "native", connections: [{ purpose: "text" }] }),
    "notes.list": () => [],
    "quickTasks.list": () => ({ tasks: [] }),
    "session.open": () => ({ id: "ses", kind: "work", targetId: null }),
    "session.stream": () => ({ items: [], hasMore: false, session: { id: "ses", kind: "work", targetId: null, workId: null, resourceId: null } }),
    "works.list": (input) => {
      const items = input.kind === "video" || !input.kind ? [work] : [];
      return { items, total: items.length, nextCursor: null };
    },
    "works.open": () => ({ workId: "wv", shelf: "reading", promoted: false }),
    "works.get": () => detail,
    "covers.list": () => ({ workId: "wv", state: "auto", coverId: null, covers: [] }),
    "video.probe": (input) => ({ resourceId: input.resourceId, revisionId: `rev_${input.resourceId}`, available: true, probe: { durationMs: 120_000 } }),
    "video.audioTracks": () => ({ audio: [{ index: 1, codec: "aac", language: "ja", title: null, channels: 2, default: true }] }),
    "video.subtitles": () => ({ subtitles: [] }),
    "video.playbackPlan": () => ({ available: true, plan: { decision: "direct", reasons: [], detail: "" }, copy: null }),
    "video.handle": () => ({ url: "manga-media://h/v", mediaType: "video/mp4", bytes: 1, startMs: 0 }),
    "video.frameIndex": () => { throw Object.assign(new Error("none"), { code: "CAPABILITY_UNAVAILABLE" }); },
    "settings.getMedia": () => ({}),
    "progress.get": () => ({ locator: { kind: "temporal", startMs: 0 }, completion: "in_progress" }),
    "screenshot.save": () => ({ screenshot: { id: "shot_1", title: "开场 · 0:10" } }),
    "screenshot.image": () => ({ url: "manga-media://h/shot", mediaType: "image/png" }),
    "danmaku.getSettings": () => ({ settings: settings.value, credentials: scenario.credentials }),
    "danmaku.setSettings": (input) => { settings.value = { ...settings.value, ...input } as DanmakuSettings; return { settings: settings.value, credentials: scenario.credentials }; },
    "danmaku.status": () => ({ match: scenario.match, consent: scenario.consent, linked: false, credentials: scenario.credentials, suggestedQuery: "合成动画", episodeNumber: 1 }),
    "danmaku.match": (input) => {
      if (scenario.matching === "no_credentials") return { state: "no_credentials" };
      if (scenario.matching === "consent" && input.consent === undefined && scenario.consent === "unasked") return { state: "needs_consent" };
      if (input.consent === false) { scenario.consent = "denied"; return { state: "needs_choice", reason: "denied", candidates: [], suggestedQuery: "合成动画", episodeNumber: 1 }; }
      if (input.consent === true) scenario.consent = "allowed";
      if (scenario.matching === "choice") return { state: "needs_choice", reason: "uncertain", candidates, suggestedQuery: "合成动画", episodeNumber: 1 };
      scenario.match = matched();
      return { state: "matched", match: scenario.match };
    },
    "danmaku.load": (input) => (scenario.credentials === "none" ? { state: "no_credentials" } : reply(scenario.match ?? matched())),
    "danmaku.search": (input) => ({ candidates: input.query === "没有" ? [] : candidates, hasMore: false }),
    "danmaku.choose": (input) => { scenario.match = matched({ episodeId: input.episodeId, animeTitle: input.animeTitle, episodeTitle: input.episodeTitle, method: "manual", confirmed: true }); scenario.matching = "auto"; return { match: scenario.match }; },
    "danmaku.setOffset": (input) => { scenario.match = { ...(scenario.match ?? matched()), offsetMs: input.offsetMs }; return { match: scenario.match }; },
    ...overrides,
  };
  (window as unknown as { manga: unknown }).manga = {
    async state() { return { layout: { channel: "test", pointerPath: "pointer.json", partitions: { data: "d" }, writable: true, recovery: "none" }, writable: true, vaultAvailable: true }; },
    async command(payload: { commandId: string; input?: Record<string, any> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      const handler = handlers[payload.commandId];
      if (!handler) return { status: "ok", value: {} };
      try { return { status: "ok", value: handler(input) }; } catch (error) {
        const failure = error as { code?: string; message?: string; details?: unknown };
        return { status: "error", error: { code: failure.code ?? "INTERNAL", message: failure.message ?? "failed", ...(failure.details ? { details: failure.details } : {}) } };
      }
    },
    onNotice: () => () => undefined,
    async chooseDirectory() { return null; }, async chooseFile() { return null; }, async chooseAudio() { return null; }, async stashSecret() { return null; },
    async reveal(id: string) { revealed.push(id); return { status: "ok", value: {} }; },
  };
  return { calls, scenario, settings, of: (id: string) => calls.filter((call) => call.commandId === id) };
}

let media: ReturnType<typeof installMediaElement>;
let capture: ReturnType<typeof installCapture>;

/** jsdom lays nothing out: the video's stage gets the size a 1280 x 720 window would give it, so the layer has a picture to cover. */
const sizes = { wide: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth"), high: Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight") };
function sizeStage() {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get(this: HTMLElement) { return this.classList.contains("video-stage") ? 1280 : 0; } });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get(this: HTMLElement) { return this.classList.contains("video-stage") ? 720 : 0; } });
}
function unsizeStage() {
  if (sizes.wide) Object.defineProperty(HTMLElement.prototype, "clientWidth", sizes.wide);
  if (sizes.high) Object.defineProperty(HTMLElement.prototype, "clientHeight", sizes.high);
}
const element = () => screen.getByTestId("video-element") as HTMLVideoElement;
const stay = () => new Promise<void>((resolve) => { setTimeout(resolve, 140); });

async function openVideo() {
  render(<App />);
  await waitFor(() => expect(screen.getByTestId("nav-video")).toBeTruthy());
  await stay();
  fireEvent.click(screen.getByTestId("nav-video"));
  await waitFor(() => expect(screen.getByTestId("open-res_v1")).toBeTruthy());
  await stay();
  fireEvent.click(screen.getByTestId("open-res_v1"));
  await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
  await waitFor(() => expect((screen.getByTestId("work-read") as HTMLButtonElement).disabled).toBe(false));
  await stay();
  fireEvent.click(screen.getByTestId("work-read"));
  await waitFor(() => expect(screen.getByTestId("video-reader")).toBeTruthy());
  await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
  act(() => media.loaded(element(), 120));
  await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"));
}

const pressed = () => screen.getByTestId("video-danmaku").getAttribute("aria-pressed");
const layer = () => screen.getByTestId("danmaku-layer");
const panel = () => screen.getByTestId("danmaku-panel");
const openPanel = () => fireEvent.click(screen.getByTestId("video-danmaku-panel"));

beforeEach(() => {
  window.innerWidth = 1600;
  media = installMediaElement();
  capture = installCapture();
  sizeStage();
  installPointerEvent();
  installMatchMedia({ reducedMotion: true });
  resetVideoSupport();
  resetCovers();
  shelfMemory.reset();
  quoteTags.reset();
  readerContext.reset();
  resetDanmakuSettings();
  engine.made.length = 0;
  engine.destroyed = 0;
  engine.canvas = null;
  try { window.localStorage.clear(); } catch { /* none */ }
});
afterEach(() => { cleanup(); unsizeStage(); capture.restore(); media.restore(); vi.restoreAllMocks(); removeMatchMedia(); quoteTags.reset(); readerContext.reset(); });

describe("danmaku in the player (AT-94)", () => {
  it("is off until the person turns it on, and asks the network for nothing while it is off", async () => {
    const host = installHost();
    await openVideo();
    expect(pressed()).toBe("false");
    expect(layer().getAttribute("data-visible")).toBeNull();
    await stay();
    for (const id of ["danmaku.status", "danmaku.match", "danmaku.load", "danmaku.search"]) expect(host.of(id)).toHaveLength(0);
    openPanel();
    expect(within(panel()).getByTestId("danmaku-state").getAttribute("data-phase")).toBe("off");
    expect(within(panel()).getByTestId("danmaku-attribution").textContent).toBe("弹幕来自弹弹play开放弹幕网络");
  });

  it("turns on with the button, finds the episode, and shows the comments the settings leave in", async () => {
    const host = installHost();
    await openVideo();
    fireEvent.click(screen.getByTestId("video-danmaku"));
    await waitFor(() => expect(layer().getAttribute("data-visible")).toBe("true"));
    expect(host.of("danmaku.setSettings")[0]!.input).toEqual({ enabled: true });
    expect(host.of("danmaku.match")).toHaveLength(1);
    expect(host.of("danmaku.load")).toHaveLength(1);
    expect(pressed()).toBe("true");
    expect(layer().getAttribute("data-count")).toBe("2");
    expect(engine.made.at(-1)!.comments.map((comment) => comment.text)).toEqual(["第一条", "第二条"]);
    openPanel();
    const state = within(panel()).getByTestId("danmaku-state");
    expect(state.getAttribute("data-phase")).toBe("ready");
    expect(within(panel()).getByTestId("danmaku-match").textContent).toBe("合成动画 · 第1话 开场");
    expect(within(panel()).getByTestId("danmaku-count").textContent).toBe("2 条弹幕");
    // An automatic match asks to be confirmed once.
    fireEvent.click(within(panel()).getByTestId("danmaku-confirm"));
    await waitFor(() => expect(host.of("danmaku.choose")).toHaveLength(1));
    expect(host.of("danmaku.choose")[0]!.input).toMatchObject({ resourceId: "res_v1", episodeId: 70001 });
    await waitFor(() => expect(within(panel()).queryByTestId("danmaku-confirm")).toBeNull());
  });

  it("turns on and off with the D key", async () => {
    const host = installHost();
    await openVideo();
    fireEvent.keyDown(window, { key: "d" });
    await waitFor(() => expect(pressed()).toBe("true"));
    fireEvent.keyDown(window, { key: "d" });
    await waitFor(() => expect(pressed()).toBe("false"));
    expect(host.of("danmaku.setSettings").map((call) => call.input.enabled)).toEqual([true, false]);
    await waitFor(() => expect(layer().getAttribute("data-visible")).toBeNull());
  });

  it("leaves the settings' blocked words, kinds and sources out of what is displayed, and says how many are left", async () => {
    const host = installHost({ items: [item(1000, "留下"), item(2000, "剧透来了"), item(3000, "顶部", { mode: "top" }), item(4000, "别处", { source: "BiliBili" })] });
    host.settings.value = { ...host.settings.value, enabled: true, top: false, blockWords: ["剧透"], sourcesOff: ["BiliBili"], merge: false };
    await openVideo();
    await waitFor(() => expect(layer().getAttribute("data-visible")).toBe("true"));
    expect(engine.made.at(-1)!.comments.map((comment) => comment.text)).toEqual(["留下"]);
    openPanel();
    expect(within(panel()).getByTestId("danmaku-count").textContent).toBe("1 / 4 条弹幕（按设置显示）");
  });

  it("asks before the file's details are sent, once, and sends nothing when the answer is no", async () => {
    const host = installHost({ matching: "consent" });
    host.settings.value = { ...host.settings.value, enabled: true };
    await openVideo();
    await waitFor(() => expect(screen.getByTestId("danmaku-consent-allow")).toBeTruthy());
    expect(within(panel()).getByTestId("danmaku-state").getAttribute("data-phase")).toBe("consent");
    expect(panel().textContent).toContain("名称（不含扩展名）");
    expect(host.of("danmaku.load")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("danmaku-consent-deny"));
    await waitFor(() => expect(within(panel()).getByTestId("danmaku-state").getAttribute("data-phase")).toBe("choose"));
    expect(host.of("danmaku.match").at(-1)!.input).toMatchObject({ consent: false });
    expect(host.of("danmaku.load")).toHaveLength(0);
    expect(panel().textContent).toContain("你选择了不发送文件信息");
    // The answer can be changed from here.
    fireEvent.click(screen.getByTestId("danmaku-consent-change"));
    await waitFor(() => expect(within(panel()).getByTestId("danmaku-state").getAttribute("data-phase")).toBe("ready"));
    expect(host.of("danmaku.match").at(-1)!.input).toMatchObject({ consent: true });
    expect(host.of("danmaku.load")).toHaveLength(1);
  });

  it("lets the person pick among candidates, or search by name and number, and then loads that episode", async () => {
    const host = installHost({ matching: "choice" });
    host.settings.value = { ...host.settings.value, enabled: true };
    await openVideo();
    await waitFor(() => expect(screen.getByTestId("danmaku-choose")).toBeTruthy());
    expect(within(panel()).getByTestId("danmaku-candidates").children).toHaveLength(2);
    expect((screen.getByTestId("danmaku-search-query") as HTMLInputElement).value).toBe("合成动画");
    expect((screen.getByTestId("danmaku-search-episode") as HTMLInputElement).value).toBe("1");
    fireEvent.change(screen.getByTestId("danmaku-search-query"), { target: { value: "没有" } });
    fireEvent.click(screen.getByTestId("danmaku-search-go"));
    await waitFor(() => expect(screen.getByTestId("danmaku-search-empty")).toBeTruthy());
    expect(host.of("danmaku.search")[0]!.input).toEqual({ query: "没有", episode: 1 });
    fireEvent.change(screen.getByTestId("danmaku-search-query"), { target: { value: "合成" } });
    fireEvent.click(screen.getByTestId("danmaku-search-go"));
    await waitFor(() => expect(screen.queryByTestId("danmaku-search-empty")).toBeNull());
    fireEvent.click(screen.getAllByTestId("danmaku-candidate-80001").at(-1)!);
    await waitFor(() => expect(within(panel()).getByTestId("danmaku-state").getAttribute("data-phase")).toBe("ready"));
    expect(host.of("danmaku.choose")[0]!.input).toMatchObject({ resourceId: "res_v1", episodeId: 80001, animeTitle: "合成动画 第二季" });
    expect(within(panel()).getByTestId("danmaku-match").textContent).toContain("第二季");
  });

  it("moves the timing of this episode in steps and puts the offset on the comments", async () => {
    const host = installHost({ match: matched({ confirmed: true }) });
    host.settings.value = { ...host.settings.value, enabled: true };
    await openVideo();
    await waitFor(() => expect(layer().getAttribute("data-visible")).toBe("true"));
    const before = engine.made.at(-1)!.comments[0]!.time;
    openPanel();
    fireEvent.click(screen.getByTestId("danmaku-offset+5000"));
    await waitFor(() => expect(screen.getByTestId("danmaku-offset-value").textContent).toBe("+5 秒"));
    expect(host.of("danmaku.setOffset")[0]!.input).toMatchObject({ resourceId: "res_v1", offsetMs: 5000 });
    await waitFor(() => expect(engine.made.at(-1)!.comments[0]!.time).toBeCloseTo(before + 5, 5));
    fireEvent.click(screen.getByTestId("danmaku-offset-500"));
    await waitFor(() => expect(host.of("danmaku.setOffset").at(-1)!.input.offsetMs).toBe(4500));
    fireEvent.click(screen.getByTestId("danmaku-offset-reset"));
    await waitFor(() => expect(host.of("danmaku.setOffset").at(-1)!.input.offsetMs).toBe(0));
  });

  it("refreshes on request, and says why when it is too soon", async () => {
    let calls = 0;
    const host = installHost({ match: matched({ confirmed: true }) }, {
      "danmaku.load": (input) => {
        calls += 1;
        if (input.refresh) throw Object.assign(new Error("too soon"), { code: "RATE_LIMITED", details: { reason: "refresh_too_soon", retryAfterMs: 42_000 } });
        return { state: "ok", items: [item(1000, "x")], fetchedAt: "2026-10-09T08:00:00.000Z", expiresAt: "2026-10-09T14:00:00.000Z", fromCache: true, stale: false, warning: null, match: matched({ confirmed: true }) };
      },
    });
    host.settings.value = { ...host.settings.value, enabled: true };
    await openVideo();
    await waitFor(() => expect(layer().getAttribute("data-visible")).toBe("true"));
    openPanel();
    expect(within(panel()).getByTestId("danmaku-fetched").textContent).toContain("来自本机缓存");
    fireEvent.click(screen.getByTestId("danmaku-refresh"));
    await waitFor(() => expect(screen.getByTestId("danmaku-warning")).toBeTruthy());
    expect(screen.getByTestId("danmaku-warning").textContent).toContain("42 秒后再试");
    expect(calls).toBe(2);
    expect(host.of("danmaku.load").at(-1)!.input).toMatchObject({ refresh: true });
  });

  it("explains a refusal from the service in its own words and offers a retry", async () => {
    const host = installHost({ match: matched({ confirmed: true }) }, {
      "danmaku.load": () => { throw Object.assign(new Error("denied"), { code: "AUTHENTICATION_FAILED", details: { serverMessage: "Invalid AppId" } }); },
    });
    host.settings.value = { ...host.settings.value, enabled: true };
    await openVideo();
    openPanel();
    await waitFor(() => expect(within(panel()).getByTestId("danmaku-state").getAttribute("data-phase")).toBe("error"));
    expect(within(panel()).getByTestId("danmaku-problem").textContent).toBe("弹弹play拒绝了请求：Invalid AppId");
    expect(layer().getAttribute("data-visible")).toBeNull();
    fireEvent.click(within(panel()).getByTestId("danmaku-retry"));
    await waitFor(() => expect(host.of("danmaku.load").length).toBeGreaterThanOrEqual(2));
  });

  it("says there are no credentials and opens the danmaku settings from there", async () => {
    installHost({ credentials: "none", matching: "no_credentials" });
    // The module is on, the switch is on, and no credentials exist: the person is told, not left with nothing.
    await openVideo();
    fireEvent.click(screen.getByTestId("video-danmaku"));
    await waitFor(() => expect(pressed()).toBe("true"));
    openPanel();
    await waitFor(() => expect(screen.getByTestId("danmaku-open-settings")).toBeTruthy());
    expect(within(panel()).getByTestId("danmaku-state").getAttribute("data-phase")).toBe("no_credentials");
    expect(panel().textContent).toContain("没有内置弹弹play的应用凭据");
    fireEvent.click(screen.getByTestId("danmaku-open-settings"));
    await waitFor(() => expect(screen.getByTestId("settings-page-danmaku")).toBeTruthy());
  });

  it("leaves the comments out of a screenshot unless the person asked for them (AT-91)", async () => {
    const host = installHost({ match: matched({ confirmed: true }) });
    host.settings.value = { ...host.settings.value, enabled: true, shotWith: false };
    await openVideo();
    await waitFor(() => expect(layer().getAttribute("data-visible")).toBe("true"));
    const comments = document.createElement("canvas");
    comments.width = 640;
    comments.height = 180;
    engine.canvas = comments;
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(host.of("screenshot.save")).toHaveLength(1));
    expect(host.of("screenshot.save")[0]!.input.video).toMatchObject({ composited: "none" });
    expect(capture.draws.some((draw) => draw.args[0] === comments)).toBe(false);
  });

  it("keeps the comments that are on screen in a screenshot when the person asked for that (AT-91)", async () => {
    const host = installHost({ match: matched({ confirmed: true }) });
    host.settings.value = { ...host.settings.value, enabled: true, shotWith: true };
    await openVideo();
    await waitFor(() => expect(layer().getAttribute("data-visible")).toBe("true"));
    const comments = document.createElement("canvas");
    comments.width = 640;
    comments.height = 180;
    engine.canvas = comments;
    fireEvent.keyDown(window, { key: "s" });
    await waitFor(() => expect(host.of("screenshot.save")).toHaveLength(1));
    expect(host.of("screenshot.save")[0]!.input.video).toMatchObject({ composited: "danmaku" });
    const draw = capture.draws.find((entry) => entry.args[0] === comments)!;
    // The comments go on the top of the picture at its full width, the part the display area covers.
    expect(draw.args.slice(1)).toEqual([0, 0, 640, 180, 0, 0, 1280, 360]);
  });
});
