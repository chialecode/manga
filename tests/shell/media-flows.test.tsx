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
import { installHost, stay, workDetail } from "../helpers/app-host.ts";
import { closeFocusedTab, focusedTitle, goBack, openShelf, openWorkPage, settle, showTab, tabTitles } from "../helpers/workspace-ui.ts";

Element.prototype.scrollIntoView = () => {};

type Handler = (input: Record<string, unknown>) => unknown;

/** The saved position the player opens at unless a test says otherwise. */
const SAVED_65S: Record<string, Handler> = { "progress.get": () => ({ locator: { kind: "temporal", startMs: 65_000 }, completion: "in_progress" }) };
const NEW_READER: Record<string, Handler> = { "progress.get": () => ({ locator: null, completion: "new" }) };

const host = (overrides: Record<string, Handler> = {}, facets?: string[]) => installHost({ overrides: { ...SAVED_65S, ...overrides }, ...(facets ? { facets } : {}) });

let media: ReturnType<typeof installMediaElement>;
const element = () => screen.getByTestId("video-element") as HTMLVideoElement;

/** From a window that has just come up to a work's own page: the library tab's overview, the medium's shelf, the card. */
async function openWork(kind: "video" | "comic", cardId: string) {
  render(<App />);
  await openShelf(kind);
  await openWorkPage(cardId);
}

async function openVideo() {
  await openWork("video", "open-res_v1");
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

describe("media pages in the app", () => {
  it("opens a video from its work's page at the saved position and gives the work's episodes", async () => {
    const calls = host();
    await openWork("video", "open-res_v1");
    // The card opened the work, not the file: nothing has played and the work's own record was read.
    expect(screen.queryByTestId("video-reader")).toBeNull();
    expect(calls.of("works.open")).toHaveLength(0);
    expect(screen.getByTestId("detail-title").textContent).toBe("合成动画");
    expect(screen.getByTestId("work-read").textContent).toContain("继续观看");
    fireEvent.click(screen.getByTestId("work-read"));
    await waitFor(() => expect(screen.getByTestId("video-reader")).toBeTruthy());
    await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
    act(() => media.loaded(element(), 120));
    await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"));
    // The title and the episode are the tab's now; the player has no bar of its own, and the work's page stays in the library tab.
    expect(focusedTitle()).toBe("合成动画 第 1 话 开场");
    expect(tabTitles()).toEqual(["合成动画", "合成动画 第 1 话 开场"]);
    expect(screen.queryByTestId("video-title")).toBeNull();
    expect(screen.queryByTestId("video-episode")).toBeNull();
    expect(media.state(element()).seeks).toContain(65);
    expect(media.state(element()).rate).toBe(1);
    expect(calls.of("works.open")[0]!.input).toMatchObject({ resourceId: "res_v1" });
    fireEvent.click(screen.getByTestId("video-more"));
    fireEvent.click(screen.getByTestId("video-episodes"));
    expect(screen.getByTestId("video-episodes-res_v2").textContent).toContain("第 2 话");
    // Comics of the same work are not episodes of the video.
    expect(screen.queryByTestId("video-episodes-res_c1")).toBeNull();
  });

  it("records the position on the video that was playing when its tab is closed, then shows the work's page and then the shelf", async () => {
    const calls = host();
    await openVideo();
    act(() => media.advance(element(), 20));
    // The player has no way back of its own: leaving it is closing its tab, and the library tab under it is where it was.
    expect(screen.queryByTestId("video-back")).toBeNull();
    closeFocusedTab();
    await waitFor(() => expect(calls.of("progress.setTime").length).toBeGreaterThan(0));
    expect(calls.of("progress.setTime").at(-1)!.input).toMatchObject({ resourceId: "res_v1", resourceRevisionId: "rev_res_v1" });
    expect(calls.of("progress.setTime").at(-1)!.input.timeMs).toBe(85_000);
    // The tab in front is the library tab again, on the work's page; back from the work's page is the shelf it came from.
    await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
    expect(screen.queryByTestId("video-reader")).toBeNull();
    // The rail marks the view of the sidebar, which closing a tab does not change; the library tab is the one in front.
    expect(screen.getByTestId("nav-home").getAttribute("aria-current")).toBe("page");
    expect(tabTitles()).toEqual(["合成动画"]);
    expect(focusedTitle()).toBe("合成动画");
    fireEvent.click(screen.getByTestId("work-back"));
    await waitFor(() => expect(screen.getByTestId("shelf-video")).toBeTruthy());
  });

  it("keeps the page a reader was opened from in its own tab: the reader's history starts with the reader, and the library tab walks back and forth by itself", async () => {
    host(NEW_READER);
    await openWork("comic", "open-res_c1");
    fireEvent.click(screen.getByTestId("work-read"));
    await waitFor(() => expect(screen.getByTestId("comic-reader")).toBeTruthy());
    // The reader is a tab of its own with nothing before it: back has nowhere to go from it, and the work's page did not change under it.
    expect(screen.getByTestId("nav-back")).toHaveProperty("disabled", true);
    expect(screen.getByTestId("nav-forward")).toHaveProperty("disabled", true);
    // The library tab is where it was: on the work's page, with the shelf behind it and nothing ahead of it.
    await showTab("合成漫画");
    await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
    expect(screen.getByTestId("nav-back")).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByTestId("nav-back"));
    await waitFor(() => expect(screen.getByTestId("shelf-comic")).toBeTruthy());
    // And forward comes back to the work's page.
    expect(screen.getByTestId("nav-forward")).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByTestId("nav-forward"));
    await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
  });

  it("switching episode saves the old one's position on the old one and opens the new one from its own", async () => {
    const calls = host({
      "progress.get": (input) => ({ locator: { kind: "temporal", startMs: input.resourceId === "res_v2" ? 7_000 : 65_000 }, completion: "in_progress" }),
    });
    await openVideo();
    act(() => media.advance(element(), 10));
    fireEvent.click(screen.getByTestId("video-more"));
    fireEvent.click(screen.getByTestId("video-episodes"));
    fireEvent.click(screen.getByTestId("video-episodes-res_v2"));
    await waitFor(() => expect(calls.of("video.probe").some((call) => call.input.resourceId === "res_v2")).toBe(true));
    await waitFor(() => expect(focusedTitle()).toContain("第 2 话"));
    const saved = calls.of("progress.setTime");
    expect(saved.some((call) => call.input.resourceId === "res_v1" && call.input.timeMs === 75_000)).toBe(true);
    expect(saved.some((call) => call.input.resourceId === "res_v2" && call.input.timeMs === 75_000)).toBe(false);
  });

  it("opens a note's time source in the player with its interval, and returns to the note", async () => {
    const calls = host({
      "records.list": () => ({ total: 1, items: [{ kind: "note", id: "n1", title: "时间笔记", preview: "", at: "2026-01-01T00:00:00.000Z", deleted: false, workId: "wv", workTitle: "合成动画", mediaKind: "video", resourceId: "res_v1", resourceTitle: "开场", tags: [], stage: null, audioState: null, durationMs: null, hasSource: true }] }),
      "notes.get": () => ({ objectId: "n1", revision: 1, title: "时间笔记", tags: [], blocks: [] }),
      "notes.openSource": () => ({
        resourceId: "res_v1", resourceRevisionId: "rev_res_v1", status: "resolved", anchorId: "a1",
        locator: { kind: "temporal", startMs: 30_000, endMs: 40_000 }, card: { status: "resolved", title: "合成动画", quote: "0:30 – 0:40" },
      }),
    });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("nav-note")).toBeTruthy());
    fireEvent.click(screen.getByTestId("nav-note"));
    fireEvent.click(await screen.findByTestId("sidebar-manage"));
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
    expect(calls.of("notes.openSource")[0]!.input).toMatchObject({ objectId: "n1" });
    fireEvent.click(screen.getByTestId("video-source-back"));
    await waitFor(() => expect(screen.getByTestId("notes-page")).toBeTruthy());
  });

  it("turns a marked interval into a tag in the dock, and a note typed there into a time-located note, without leaving the player", async () => {
    const calls = host({ "notes.create": () => ({ objectId: "n9" }) });
    await openVideo();
    const pane = () => within(screen.getByTestId("shell-dock"));
    act(() => { media.state(element()).time = 10; media.advance(element(), 0); });
    fireEvent.keyDown(window, { key: "i" });
    act(() => { media.state(element()).time = 20; media.advance(element(), 0); });
    fireEvent.keyDown(window, { key: "o" });
    await waitFor(() => expect(pane().getByTestId("chat-tag-interval").textContent).toContain("0:10"));
    // Note is the default mode; the tag alone is enough to make a note, and the text goes with it.
    fireEvent.change(pane().getByTestId("agent-composer"), { target: { value: "这里的演出很好" } });
    fireEvent.click(pane().getByTestId("agent-send"));
    await waitFor(() => expect(calls.of("notes.create")).toHaveLength(1));
    expect(calls.of("notes.create")[0]!.input).toMatchObject({
      resourceId: "res_v1", resourceRevisionId: "rev_res_v1", locator: { kind: "temporal", startMs: 10_000, endMs: 20_000 }, quoteText: "0:10—0:20", text: "这里的演出很好",
    });
    // The player stays; the tag is spent and the marks go with it.
    expect(screen.getByTestId("video-reader")).toBeTruthy();
    expect(screen.queryByTestId("notes-page")).toBeNull();
    await waitFor(() => expect(screen.queryByTestId("chat-tag-interval")).toBeNull());
  });

  it("opens a comic from its work's page at its first page and goes back to the work and then the shelf", async () => {
    host(NEW_READER);
    await openWork("comic", "open-res_c1");
    expect(screen.getByTestId("work-read").textContent).toContain("继续阅读");
    fireEvent.click(screen.getByTestId("work-read"));
    await waitFor(() => expect(screen.getByTestId("comic-reader")).toBeTruthy());
    expect(focusedTitle()).toBe("合成漫画");
    expect(screen.queryByTestId("comic-title")).toBeNull();
    expect(screen.getByTestId("comic-position").textContent).toContain("1 / 6");
    expect(screen.queryByTestId("comic-back")).toBeNull();
    closeFocusedTab();
    await waitFor(() => expect(screen.getByTestId("page-work")).toBeTruthy());
    expect(screen.queryByTestId("comic-reader")).toBeNull();
    fireEvent.click(screen.getByTestId("work-back"));
    await waitFor(() => expect(screen.getByTestId("shelf-comic")).toBeTruthy());
  });

  it("words a work's page by its medium: the way back, the tab of its files and the episodes (AT-100)", async () => {
    host(NEW_READER);
    await openWork("comic", "open-res_c1");
    expect(screen.getByTestId("work-back").textContent).toBe("返回漫画");
    expect(screen.getByTestId("page-work").textContent).not.toMatch(/书架|书籍/);
    expect(within(screen.getByTestId("page-work")).getByRole("tab", { name: "卷与话" })).toBeTruthy();
    cleanup();
    host();
    await openWork("video", "open-res_v1");
    expect(screen.getByTestId("work-back").textContent).toBe("返回动漫");
    expect(within(screen.getByTestId("page-work")).getByRole("tab", { name: "剧集" })).toBeTruthy();
    expect(screen.getByTestId("page-work").textContent).not.toMatch(/书架|书籍/);
  });

  it("keeps the shelf as it was left when the user comes back from a work's page", async () => {
    host();
    render(<App />);
    await openShelf("video");
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

  it("opens a new tab at the library's overview and leaves the first library tab where it was, on the work's page", async () => {
    host();
    render(<App />);
    await openShelf("video");
    await openWorkPage("open-res_v1");
    expect(tabTitles()).toEqual(["合成动画"]);
    fireEvent.click(screen.getByTestId("tab-new"));
    await waitFor(() => expect(tabTitles()).toEqual(["合成动画", "资源库"]));
    expect(focusedTitle()).toBe("资源库");
    await showTab("合成动画");
    expect(screen.getByTestId("page-work")).toBeTruthy();
    // The new tab's own page is still the overview, and the first tab's history was not touched by it.
    expect(screen.getAllByTestId("shelf-all").length).toBe(1);
    expect(screen.getByTestId("nav-back")).toHaveProperty("disabled", false);
    await settle();
  });
});

const voiceFacets = ["agent", "library", "settings", "comic", "video", "notes", "voice"];
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

describe("recording in the app", () => {
  it("has no microphone in the dock, the player or the top row while the voice module is off", async () => {
    host();
    await openVideo();
    expect(screen.queryByTestId("record-control")).toBeNull();
    expect(screen.queryByTestId("review-open")).toBeNull();
    expect(screen.queryByTestId("chat-mic")).toBeNull();
    expect(screen.queryByTestId("record-start")).toBeNull();
  });

  it("puts the microphone in the dock, not in the player or the top row, and shows a recording as a bubble that opens its review", async () => {
    const calls = host({
      "settings.getRecording": () => ({}),
      "capture.list": () => ({ sessions: [captureSession()] }),
      "capture.review": voiceReview,
      "session.stream": () => ({ items: [voiceBubble()], hasMore: false, session: { id: "ses", kind: "resource", targetId: "res_v1", workId: "wv", resourceId: "res_v1" } }),
    }, voiceFacets);
    await openVideo();
    const pane = () => within(screen.getByTestId("shell-dock"));
    expect(screen.queryByTestId("record-control")).toBeNull();
    expect(screen.queryByTestId("review-open")).toBeNull();
    expect(pane().getByTestId("chat-mic").getAttribute("aria-label")).toContain("F8");
    expect(screen.getByTestId("shell-title-actions").contains(screen.getByTestId("debug-toggle"))).toBe(true);
    await waitFor(() => expect(pane().getByTestId("bubble-voice-cap_1")).toBeTruthy());
    fireEvent.click(pane().getByTestId("bubble-voice-open-cap_1"));
    await waitFor(() => expect(screen.getByTestId("review-drawer")).toBeTruthy());
    await waitFor(() => expect(calls.of("capture.review").length).toBeGreaterThan(0));
    expect(calls.of("capture.review")[0]!.input).toMatchObject({ sessionId: "cap_1" });
  });

  it("jumps from a recorded sentence to the video time it was said at", async () => {
    host({
      "settings.getRecording": () => ({}),
      "capture.list": () => ({ sessions: [captureSession()] }),
      "capture.review": voiceReview,
      "session.stream": () => ({ items: [voiceBubble()], hasMore: false, session: { id: "ses", kind: "shared", targetId: null, workId: null, resourceId: null } }),
    }, voiceFacets);
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("shell-dock")).toBeTruthy());
    const pane = () => within(screen.getByTestId("shell-dock"));
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
    host({
      "works.get": () => ({
        ...workDetail("wv", "video", "合成动画", [{ id: "res_v1", title: "开场", kind: "video", ordinalLabel: "第 1 话", available: true }]),
      }),
      "settings.getRecording": () => ({}),
      "capture.list": () => ({ sessions: [captureSession()] }),
      "capture.review": voiceReview,
    }, voiceFacets);
    render(<App />);
    await openShelf("video");
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
