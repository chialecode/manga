/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { resetCovers } from "../../apps/desktop/src/renderer/lib/covers.ts";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { shelfMemory } from "../../apps/desktop/src/renderer/lib/shelf-memory.ts";
import { resetVideoSupport } from "../../apps/desktop/src/renderer/readers/video-support.ts";
import { installMatchMedia, installMediaElement, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";

Element.prototype.scrollIntoView = () => {};

type Call = { commandId: string; input: Record<string, unknown> };
type Handler = (input: Record<string, unknown>) => unknown;

const work = (id: string, kind: "video" | "comic", resourceId: string) => ({
  id, title: `作品 ${id}`, author: "合成作者", mediaKind: kind, shelf: "reading", coverId: null,
  lastResource: { id: resourceId, title: `作品 ${id}`, ordinalLabel: null, revisionId: `rev_${resourceId}` },
  progress: 0.25, finishedCount: 0, resourceCount: 2, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null,
});

/** The work's own page needs the whole record: fields, override, links, resources. */
const workDetail = (id: string, kind: "video" | "comic", title: string, resources: Array<Record<string, unknown>>) => ({
  ...work(id, kind, String(resources[0]!.id)), title, originalTitle: title, fields: {}, override: { fields: {}, locked: [], cleared: [] }, links: [], snapshots: [], coverState: "auto", coverCount: 0, resources,
});

function installHost(overrides: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  // The sessions the host knows: one conversation, plus one for each target the app opened ("session.open" keeps the one it made).
  const sessions: Array<Record<string, unknown>> = [{ sessionId: "ses_shared", title: "会话 1", kind: "shared", targetId: null, mode: "enthusiast", runCount: 0, activeRunId: null, activeRunStatus: null }];
  const handlers: Record<string, Handler> = {
    "workspace.get": () => ({ uiFacets: ["agent", "library", "settings", "comic", "video", "notes"], sessions: [], runs: [], notes: [], resources: [] }),
    "workspace.sessions": () => sessions,
    "inventory.overview": () => ({ items: [], totals: {} }),
    "settings.get": () => ({ needsSetup: false, recoveryJobs: [], aiRuntime: "native", connections: [{ purpose: "text" }] }),
    "notes.list": () => [],
    "quickTasks.list": () => ({ tasks: [] }),
    "session.open": (input) => {
      const id = `ses_${String(input.kind)}_${String(input.targetId)}`;
      if (!sessions.some((row) => row.sessionId === id)) sessions.push({ sessionId: id, title: String(input.targetId), kind: input.kind, targetId: input.targetId, mode: "enthusiast", runCount: 0, activeRunId: null, activeRunStatus: null });
      return { id, kind: input.kind, targetId: input.targetId };
    },
    "session.stream": () => ({ items: [], hasMore: false, session: { id: "ses", kind: "work", targetId: null, workId: null, resourceId: null } }),
    "works.list": (input) => {
      // The start-up probe (no kind) finds a work, so the app opens on the shelf and not on the library paths page.
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
    "video.probe": (input) => ({ resourceId: input.resourceId, revisionId: `rev_${input.resourceId}`, available: true, probe: { durationMs: 120_000 } }),
    "video.audioTracks": () => ({ audio: [] }),
    "video.subtitles": () => ({ subtitles: [] }),
    "video.playbackPlan": () => ({ available: true, plan: { decision: "direct", reasons: [], detail: "" }, copy: null }),
    "video.handle": () => ({ url: "manga-media://h/v", mediaType: "video/mp4", bytes: 1, startMs: 0 }),
    "video.frameIndex": () => { throw Object.assign(new Error("none"), { code: "CAPABILITY_UNAVAILABLE" }); },
    "settings.getMedia": () => ({}),
    "progress.get": () => ({ locator: { kind: "temporal", startMs: 65_000 }, completion: "in_progress" }),
    "comic.pages": (input) => ({
      resourceId: input.resourceId, revisionId: "rev_res_c1", title: "合成漫画", direction: null, available: true, warnings: [],
      pages: Array.from({ length: 6 }, (_, index) => ({ id: `p${index}`, index, name: `${index}.png`, width: 800, height: 1200, spread: false, ok: true })),
    }),
    "comic.pageHandles": (input) => ({ pages: (input.pageIds as string[]).map((pageId) => ({ pageId, available: true, kind: "image", url: `manga-media://h/${pageId}`, handle: pageId, mediaType: "image/png", width: 800, height: 1200 })) }),
    ...overrides,
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
  return { calls, of: (id: string) => calls.filter((call) => call.commandId === id) };
}

let media: ReturnType<typeof installMediaElement>;
const element = () => screen.getByTestId("video-element") as HTMLVideoElement;

/** A card opens the work's own page; only "watch" opens the file. */
async function openWork(nav: "nav-video" | "nav-comic", cardId: string) {
  render(<App />);
  await waitFor(() => expect(screen.getByTestId(nav)).toBeTruthy());
  fireEvent.click(screen.getByTestId(nav));
  await waitFor(() => expect(screen.getByTestId(cardId)).toBeTruthy());
  fireEvent.click(screen.getByTestId(cardId));
  await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
  await waitFor(() => expect((screen.getByTestId("work-read") as HTMLButtonElement).disabled).toBe(false));
}

async function openVideo() {
  await openWork("nav-video", "open-res_v1");
  fireEvent.click(screen.getByTestId("work-read"));
  await waitFor(() => expect(screen.getByTestId("video-reader")).toBeTruthy());
  await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
  act(() => media.loaded(element(), 120));
  await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"));
}

beforeEach(() => {
  window.innerWidth = 1600;
  media = installMediaElement();
  installPointerEvent();
  installMatchMedia({ reducedMotion: true });
  resetVideoSupport();
  resetCovers();
  shelfMemory.reset();
  quoteTags.reset();
  readerContext.reset();
  try { window.localStorage.clear(); } catch { /* none */ }
});
afterEach(() => { cleanup(); media.restore(); vi.restoreAllMocks(); removeMatchMedia(); quoteTags.reset(); readerContext.reset(); });

describe("M2 media pages in the app", () => {
  it("opens a video from its work's page at the saved position and gives the work's episodes", async () => {
    const host = installHost();
    await openWork("nav-video", "open-res_v1");
    // The card opened the work, not the file: nothing has played and the work's own record was read.
    expect(screen.queryByTestId("video-reader")).toBeNull();
    expect(host.of("works.open")).toHaveLength(0);
    expect(screen.getByTestId("detail-title").textContent).toBe("合成动画");
    expect(screen.getByTestId("work-read").textContent).toContain("继续观看");
    fireEvent.click(screen.getByTestId("work-read"));
    await waitFor(() => expect(screen.getByTestId("video-reader")).toBeTruthy());
    await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
    act(() => media.loaded(element(), 120));
    await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"));
    expect(screen.getByTestId("video-title").textContent).toBe("合成动画");
    expect(screen.getByTestId("video-episode").textContent).toBe("第 1 话 开场");
    expect(media.state(element()).seeks).toContain(65);
    expect(media.state(element()).rate).toBe(1);
    expect(host.of("works.open")[0]!.input).toMatchObject({ resourceId: "res_v1" });
    fireEvent.click(screen.getByTestId("video-more"));
    fireEvent.click(screen.getByTestId("video-episodes"));
    expect(screen.getByTestId("video-episodes-res_v2").textContent).toContain("第 2 话");
    // Comics of the same work are not episodes of the video.
    expect(screen.queryByTestId("video-episodes-res_c1")).toBeNull();
  });

  it("records the position on the video that was playing when the user goes back, then shows the work's page and then the shelf", async () => {
    const host = installHost();
    await openVideo();
    act(() => media.advance(element(), 20));
    fireEvent.click(screen.getByTestId("video-back"));
    await waitFor(() => expect(host.of("progress.setTime").length).toBeGreaterThan(0));
    expect(host.of("progress.setTime").at(-1)!.input).toMatchObject({ resourceId: "res_v1", resourceRevisionId: "rev_res_v1" });
    expect(host.of("progress.setTime").at(-1)!.input.timeMs).toBe(85_000);
    // Back from the player is the work's page; back from the work's page is the shelf it came from.
    await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
    expect(screen.getByTestId("nav-video").getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByTestId("work-back"));
    await waitFor(() => expect(screen.getByTestId("shelf-video")).toBeTruthy());
  });

  it("switching episode saves the old one's position on the old one and opens the new one from its own", async () => {
    const host = installHost({
      "progress.get": (input) => ({ locator: { kind: "temporal", startMs: input.resourceId === "res_v2" ? 7_000 : 65_000 }, completion: "in_progress" }),
    });
    await openVideo();
    act(() => media.advance(element(), 10));
    fireEvent.click(screen.getByTestId("video-more"));
    fireEvent.click(screen.getByTestId("video-episodes"));
    fireEvent.click(screen.getByTestId("video-episodes-res_v2"));
    await waitFor(() => expect(host.of("video.probe").some((call) => call.input.resourceId === "res_v2")).toBe(true));
    await waitFor(() => expect(screen.getByTestId("video-episode").textContent).toContain("第 2 话"));
    const saved = host.of("progress.setTime");
    expect(saved.some((call) => call.input.resourceId === "res_v1" && call.input.timeMs === 75_000)).toBe(true);
    expect(saved.some((call) => call.input.resourceId === "res_v2" && call.input.timeMs === 75_000)).toBe(false);
  });

  it("opens a note's time source in the player with its interval, and returns to the note", async () => {
    const host = installHost({
      "records.list": () => ({ total: 1, items: [{ kind: "note", id: "n1", title: "时间笔记", preview: "", at: "2026-01-01T00:00:00.000Z", deleted: false, workId: "wv", workTitle: "合成动画", mediaKind: "video", resourceId: "res_v1", resourceTitle: "开场", tags: [], stage: null, audioState: null, durationMs: null, hasSource: true }] }),
      "notes.get": () => ({ objectId: "n1", revision: 1, title: "时间笔记", tags: [], blocks: [] }),
      "notes.openSource": () => ({
        resourceId: "res_v1", resourceRevisionId: "rev_res_v1", status: "resolved", anchorId: "a1",
        locator: { kind: "temporal", startMs: 30_000, endMs: 40_000 }, card: { status: "resolved", title: "合成动画", quote: "0:30 – 0:40" },
      }),
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("nav-settings")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-settings"));
    await waitFor(() => expect(screen.getByTestId("settings-nav-records")).toBeTruthy());
    fireEvent.click(screen.getByTestId("settings-nav-records"));
    await waitFor(() => expect(screen.getByTestId("record-source-n1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("record-source-n1"));
    await waitFor(() => expect(screen.getByTestId("video-reader")).toBeTruthy());
    await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
    act(() => media.loaded(element(), 120));
    await waitFor(() => expect(media.state(element()).seeks).toContain(30));
    expect(media.state(element()).paused).toBe(true);
    expect(screen.getByTestId("video-source-card").getAttribute("data-source-status")).toBe("resolved");
    expect(screen.getByTestId("video-marker-source")).toBeTruthy();
    // The saved position of the video does not pull the player away from the note's time.
    expect(media.state(element()).seeks).not.toContain(65);
    expect(host.of("notes.openSource")[0]!.input).toMatchObject({ objectId: "n1" });
    fireEvent.click(screen.getByTestId("video-source-back"));
    await waitFor(() => expect(screen.getByTestId("notes-page")).toBeTruthy());
  });

  it("turns a marked interval into a tag in the right pane, and a note typed there into a time-located note, without leaving the player", async () => {
    const host = installHost({ "notes.create": () => ({ objectId: "n9" }) });
    await openVideo();
    const pane = () => within(screen.getByTestId("shell-right"));
    act(() => { media.state(element()).time = 10; media.advance(element(), 0); });
    fireEvent.keyDown(window, { key: "i" });
    act(() => { media.state(element()).time = 20; media.advance(element(), 0); });
    fireEvent.keyDown(window, { key: "o" });
    await waitFor(() => expect(pane().getByTestId("chat-tag-interval").textContent).toContain("0:10"));
    // Note is the default mode; the tag alone is enough to make a note, and the text goes with it.
    fireEvent.change(pane().getByTestId("agent-composer"), { target: { value: "这里的演出很好" } });
    fireEvent.click(pane().getByTestId("agent-send"));
    await waitFor(() => expect(host.of("notes.create")).toHaveLength(1));
    expect(host.of("notes.create")[0]!.input).toMatchObject({
      resourceId: "res_v1", resourceRevisionId: "rev_res_v1", locator: { kind: "temporal", startMs: 10_000, endMs: 20_000 }, quoteText: "0:10—0:20", text: "这里的演出很好",
    });
    // The player stays; the tag is spent and the marks go with it.
    expect(screen.getByTestId("video-reader")).toBeTruthy();
    expect(screen.queryByTestId("notes-page")).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("chat-tag-interval")).toBeNull());
  });

  it("opens a comic from its work's page at its first page and goes back to the work and then the shelf", async () => {
    installHost({ "progress.get": () => ({ locator: null, completion: "new" }) });
    await openWork("nav-comic", "open-res_c1");
    expect(screen.getByTestId("work-read").textContent).toContain("继续阅读");
    fireEvent.click(screen.getByTestId("work-read"));
    await waitFor(() => expect(screen.getByTestId("comic-reader")).toBeTruthy());
    expect(screen.getByTestId("comic-title").textContent).toBe("合成漫画");
    expect(screen.getByTestId("comic-position").textContent).toContain("1 / 6");
    fireEvent.click(screen.getByTestId("comic-back"));
    await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
    fireEvent.click(screen.getByTestId("work-back"));
    await waitFor(() => expect(screen.getByTestId("shelf-comic")).toBeTruthy());
  });

  it("keeps the shelf as it was left when the user comes back from a work's page", async () => {
    installHost();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("nav-video")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-video"));
    await waitFor(() => expect(screen.getByTestId("shelf-search")).toBeTruthy());
    fireEvent.click(screen.getByTestId("shelf-tab-reading"));
    fireEvent.change(screen.getByTestId("shelf-search"), { target: { value: "合成" } });
    await waitFor(() => expect(screen.getByTestId("open-res_v1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("open-res_v1"));
    await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
    fireEvent.click(screen.getByTestId("work-back"));
    await waitFor(() => expect(screen.getByTestId("shelf-video")).toBeTruthy());
    expect((screen.getByTestId("shelf-search") as HTMLInputElement).value).toBe("合成");
    expect(screen.getByTestId("shelf-tab-reading").getAttribute("aria-selected")).toBe("true");
  });
});

const voiceFacets = () => ({ uiFacets: ["agent", "library", "settings", "comic", "video", "notes", "voice"], sessions: [], runs: [], notes: [], resources: [] });
const captureSession = (patch: Record<string, unknown> = {}) => ({
  id: "cap_1", mode: "toggle", retention: "keep", stage: "done", audioState: "retained", playable: true, durationMs: 20_000,
  createdAt: "2026-10-01T08:00:00.000Z", workId: "wv", resourceId: "res_v1", error: null, segments: { total: 1, done: 1, failed: 0, pending: 0, noSpeech: 0 }, speechMs: 4000, ...patch,
});
const voiceReview = () => ({
  session: captureSession(),
  segments: [{
    id: "seg_1", seq: 0, startMs: 1000, endMs: 5000, text: "这里的配乐很好", originalText: "这里的配乐很好", revised: false, state: "done", precision: "segment", calibrated: false, attempts: 1, error: null,
    anchors: [{ startMs: 1000, endMs: 5000, resourceId: "res_v1", resourceRevisionId: "rev_res_v1", locator: { kind: "temporal", startMs: 61_000, endMs: 64_000 } }],
  }],
  filtered: [], drafts: [], audio: { state: "retained", playable: true },
});
const voiceBubble = () => ({
  kind: "voice", id: "cap_1", at: "2026-10-01T08:00:00.000Z", stage: "done", audioState: "retained", playable: true, durationMs: 20_000, text: "这里的配乐很好",
  segments: { total: 1, done: 1, failed: 0, pending: 0 }, sources: [{ startMs: 61_000, locator: { kind: "temporal", startMs: 61_000, endMs: 64_000 }, resourceId: "res_v1" }], resourceId: "res_v1",
});

describe("M2 recording in the app", () => {
  it("has no microphone in the right pane, the player or the title bar while the voice module is off", async () => {
    installHost();
    await openVideo();
    expect(screen.queryByTestId("record-control")).toBeNull();
    expect(screen.queryByTestId("review-open")).toBeNull();
    expect(screen.queryByTestId("chat-mic")).toBeNull();
    expect(screen.queryByTestId("record-start")).toBeNull();
  });

  it("puts the microphone in the right pane, not in the player or the title bar, and shows a recording as a bubble that opens its review", async () => {
    const host = installHost({
      "workspace.get": voiceFacets,
      "settings.getRecording": () => ({}),
      "capture.list": () => ({ sessions: [captureSession()] }),
      "capture.review": voiceReview,
      "session.stream": () => ({ items: [voiceBubble()], hasMore: false, session: { id: "ses", kind: "resource", targetId: "res_v1", workId: "wv", resourceId: "res_v1" } }),
    });
    await openVideo();
    const pane = () => within(screen.getByTestId("shell-right"));
    expect(screen.queryByTestId("record-control")).toBeNull();
    expect(screen.queryByTestId("review-open")).toBeNull();
    expect(pane().getByTestId("chat-mic").getAttribute("aria-label")).toContain("F8");
    expect(screen.getByTestId("shell-title-actions").contains(screen.getByTestId("debug-toggle"))).toBe(true);
    await waitFor(() => expect(pane().getByTestId("bubble-voice-cap_1")).toBeTruthy());
    fireEvent.click(pane().getByTestId("bubble-voice-open-cap_1"));
    await waitFor(() => expect(screen.getByTestId("review-drawer")).toBeTruthy());
    await waitFor(() => expect(host.of("capture.review").length).toBeGreaterThan(0));
    expect(host.of("capture.review")[0]!.input).toMatchObject({ sessionId: "cap_1" });
  });

  it("jumps from a recorded sentence to the video time it was said at", async () => {
    installHost({
      "workspace.get": voiceFacets,
      "settings.getRecording": () => ({}),
      "capture.list": () => ({ sessions: [captureSession()] }),
      "capture.review": voiceReview,
      "session.stream": () => ({ items: [voiceBubble()], hasMore: false, session: { id: "ses", kind: "shared", targetId: null, workId: null, resourceId: null } }),
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("shell-right")).toBeTruthy());
    const pane = () => within(screen.getByTestId("shell-right"));
    await waitFor(() => expect(pane().getByTestId("bubble-voice-open-cap_1")).toBeTruthy());
    fireEvent.click(pane().getByTestId("bubble-voice-open-cap_1"));
    await waitFor(() => expect(screen.getByTestId("review-jump-seg_1-0")).toBeTruthy());
    fireEvent.click(screen.getByTestId("review-jump-seg_1-0"));
    await waitFor(() => expect(screen.getByTestId("video-reader")).toBeTruthy());
    await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
    act(() => media.loaded(element(), 120));
    await waitFor(() => expect(media.state(element()).seeks).toContain(61));
    expect(screen.queryByTestId("review-drawer")).toBeNull();
  });

  it("opens one recording of a work from the work's records tab", async () => {
    installHost({
      "works.get": () => ({
        ...workDetail("wv", "video", "合成动画", [{ id: "res_v1", title: "开场", kind: "video", ordinalLabel: "第 1 话", available: true }]),
      }),
      "workspace.get": voiceFacets,
      "settings.getRecording": () => ({}),
      "capture.list": () => ({ sessions: [captureSession()] }),
      "capture.review": voiceReview,
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("nav-video")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-video"));
    await waitFor(() => expect(screen.getByTestId("work-wv")).toBeTruthy());
    fireEvent.click(screen.getByTestId("open-res_v1"));
    await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
    await waitFor(() => expect(screen.getByTestId("detail-tab-records")).toBeTruthy());
    fireEvent.click(screen.getByTestId("detail-tab-records"));
    await waitFor(() => expect(screen.getByTestId("detail-recording-cap_1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("detail-recording-cap_1"));
    await waitFor(() => expect(screen.getByTestId("review-session")).toBeTruthy());
    expect(screen.getByTestId("review-text-seg_1").textContent).toBe("这里的配乐很好");
  });
});
