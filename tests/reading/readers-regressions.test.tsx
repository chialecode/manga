/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { resolveKeys } from "@manga/contracts/keys";
import { DEFAULT_DANMAKU_SETTINGS, type DanmakuItem } from "@manga/contracts/danmaku";
import { useRef } from "react";
import { firstOffsetOnScreen } from "../../apps/desktop/src/renderer/reader/page-offsets.ts";
import { usePager } from "../../apps/desktop/src/renderer/reader/use-pager.ts";
import { useReadNovel } from "../../apps/desktop/src/renderer/reader/use-read-novel.ts";
import { readAloud } from "../../apps/desktop/src/renderer/voice/read-aloud.ts";
import { SubtitleLayer } from "../../apps/desktop/src/renderer/readers/subtitle-layer.tsx";
import { DEFAULT_SUBTITLE_STYLE } from "../../apps/desktop/src/renderer/readers/subtitle-model.ts";
import { useSubtitles } from "../../apps/desktop/src/renderer/readers/use-subtitles.ts";
import { useVideoPlayback } from "../../apps/desktop/src/renderer/readers/use-video-playback.ts";
import { useVideoSource } from "../../apps/desktop/src/renderer/readers/use-video-source.ts";
import { resetVideoSupport } from "../../apps/desktop/src/renderer/readers/video-support.ts";
import { VideoPlayer, type VideoDoc, type VideoSettings } from "../../apps/desktop/src/renderer/readers/video-player.tsx";
import { ComicReader, type ComicDoc, type ComicSettings } from "../../apps/desktop/src/renderer/readers/comic-reader.tsx";
import { prepareDanmaku } from "../../apps/desktop/src/renderer/readers/danmaku-model.ts";
import { KeyTableProvider } from "../../apps/desktop/src/renderer/lib/key-table.tsx";
import { TabProvider } from "../../apps/desktop/src/renderer/workspace/tab-context.tsx";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";
import { installMediaElement, installPointerEvent } from "../helpers/dom.ts";

const i18n = createTranslator("zh-CN");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetVideoSupport();
  quoteTags.reset();
  readerContext.reset();
  readAloud.stop();
});

describe("novel pager and offset regressions", () => {
  it("handles surrogate pairs and trailing zero-rect whitespace in firstOffsetOnScreen", () => {
    const body = document.createElement("div");
    const node = document.createTextNode("😀ab ");
    body.append(node);
    document.body.append(body);
    vi.spyOn(body, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const frame = { textWidth: 400, height: 600, columns: 1 as const, gap: 40 };
    // Simulate Range rects: emoji at x=0 (screen 0), 'a' at x=440 (screen 1), 'b' at x=460 (screen 1), trailing space zero-rect.
    const origCreateRange = document.createRange.bind(document);
    vi.spyOn(document, "createRange").mockImplementation(() => {
      const range = origCreateRange();
      let start = 0;
      let end = 0;
      range.setStart = (_n: Node, offset: number) => { start = offset; };
      range.setEnd = (_n: Node, offset: number) => { end = offset; };
      range.getClientRects = () => {
        // Surrogate pair emoji at 0..2 must not be split (end must be 2, not 1).
        if (start === 0) return (end === 2 ? [{ left: 0, width: 16, height: 16 }] : []) as unknown as DOMRectList;
        if (start === 2) return [{ left: 440, width: 10, height: 16 }] as unknown as DOMRectList;
        if (start === 3) return [{ left: 460, width: 10, height: 16 }] as unknown as DOMRectList;
        // Trailing space has zero rect.
        return [{ left: 470, width: 0, height: 0 }] as unknown as DOMRectList;
      };
      return range;
    });
    // Code points: 0='😀', 1='a', 2='b', 3=' '. Screen 1 starts at code point 1 ('a').
    expect(firstOffsetOnScreen(body, frame, 1, 10, 10)).toBe(11);
    body.remove();
  });

  it("clears pager loading lock after a rejected onExtend promise so turning pages recovers", async () => {
    const onExtend = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    const bodyEl = document.createElement("div");
    const scrollEl = document.createElement("div");
    Object.defineProperty(bodyEl, "scrollWidth", { configurable: true, get: () => 400 });
    Object.defineProperty(scrollEl, "clientWidth", { configurable: true, get: () => 400 });
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, get: () => 600 });
    const { result } = renderHook(() => {
      const scroll = useRef<HTMLElement | null>(scrollEl);
      const body = useRef<HTMLDivElement | null>(bodyEl);
      return usePager({
        active: true,
        scroll,
        body,
        slice: { partId: "p1", text: "hello", start: 0, end: 5 },
        parts: [{ id: "p1", length: 500 }],
        style: { measurePx: 400, marginPx: 0, fontSizePx: 18, lineHeight: 1.6, pageMode: "single", pageRatio: "free" },
        highlight: null,
        restored: null,
        callbacks: { onPart: vi.fn(), onWindow: vi.fn(), onExtend },
      });
    });
    // Prefetch triggers first onExtend, which rejects.
    await waitFor(() => expect(onExtend).toHaveBeenCalledTimes(1));
    // Once rejection settles, the loading lock is released and another turn can call onExtend again.
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    act(() => { result.current.go(1); });
    expect(onExtend).toHaveBeenCalledTimes(2);
  });

  it("preserves the reading anchor across repeated font-size toggles without walking backwards (#109)", async () => {
    const text = "甲".repeat(200);
    const bodyEl = document.createElement("div");
    bodyEl.textContent = text;
    document.body.appendChild(bodyEl);
    const scrollEl = document.createElement("div");
    let fontSize = 18;
    const charsPerPage = () => (fontSize === 18 ? 20 : 14);
    const pageStep = 416; // textWidth 400 + MIN_PAGE_GAP 16
    Object.defineProperty(scrollEl, "clientWidth", { configurable: true, get: () => 400 });
    Object.defineProperty(scrollEl, "clientHeight", { configurable: true, get: () => 600 });
    Object.defineProperty(bodyEl, "scrollWidth", {
      configurable: true,
      get: () => Math.ceil(text.length / charsPerPage()) * pageStep - 16,
    });
    vi.spyOn(bodyEl, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, right: 400, bottom: 600, width: 400, height: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    vi.spyOn(bodyEl, "getClientRects").mockReturnValue([{ left: 0, top: 0, width: 400, height: 600 }] as unknown as DOMRectList);
    vi.spyOn(scrollEl, "getClientRects").mockReturnValue([{ left: 0, top: 0, width: 400, height: 600 }] as unknown as DOMRectList);
    vi.spyOn(document, "createRange").mockImplementation(() => {
      let start = 0;
      return {
        setStart(_node: Node, offset: number) { start = offset; },
        setEnd() {},
        getClientRects() {
          const col = Math.floor(start / charsPerPage());
          return [{ left: col * pageStep + 2, top: 0, width: 10, height: 18 }] as unknown as DOMRectList;
        },
      } as unknown as Range;
    });
    const { result, rerender } = renderHook(
      ({ size }) => {
        fontSize = size;
        const scroll = useRef<HTMLElement | null>(scrollEl);
        const body = useRef<HTMLDivElement | null>(bodyEl);
        return usePager({
          active: true,
          scroll,
          body,
          slice: { partId: "p1", text, start: 0, end: text.length },
          parts: [{ id: "p1", length: text.length }],
          style: { measurePx: 400, marginPx: 0, fontSizePx: size, lineHeight: 1.6, pageMode: "single", pageRatio: "free" },
          highlight: null,
          restored: null,
          callbacks: { onPart: vi.fn(), onWindow: vi.fn(), onExtend: vi.fn() },
        });
      },
      { initialProps: { size: 18 } },
    );
    // Turn forward 3 pages at 18px -> offset 60 (page 4, screen 3).
    act(() => { result.current.go(1); });
    act(() => { result.current.go(1); });
    act(() => { result.current.go(1); });
    await waitFor(() => expect(result.current.range).toEqual({ start: 60, end: 80 }));
    // Repeatedly toggle 18 -> 19 -> 18: offset 60 must stay on screen every time and never walk backwards.
    for (let i = 0; i < 6; i += 1) {
      rerender({ size: 19 });
      await waitFor(() => expect(result.current.range).not.toBeNull());
      expect(result.current.range!.start).toBeLessThanOrEqual(60);
      expect(result.current.range!.end).toBeGreaterThan(60);
      rerender({ size: 18 });
      await waitFor(() => expect(result.current.range).toEqual({ start: 60, end: 80 }));
    }
    bodyEl.remove();
  });
});

describe("subtitle fetch and duplicate-cue key regressions", () => {
  it("reports failed status when subtitle handle HTTP fetch returns non-OK", async () => {
    (window as unknown as { manga: unknown }).manga = {
      command: async ({ commandId }: { commandId: string }) => {
        if (commandId === "video.subtitles") return { status: "ok", value: { subtitles: [{ id: "s1", source: "external", streamIndex: null, codec: "srt", format: "srt", language: "zh", title: "ZH", default: true }] } };
        if (commandId === "video.subtitleHandle") return { status: "ok", value: { trackId: "s1", format: "srt", language: "zh", title: "ZH", url: "http://local/sub.srt" } };
        return { status: "ok", value: {} };
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, text: async () => "server error" })));
    const video = document.createElement("video");
    const { result } = renderHook(() => useSubtitles({
      target: { resourceId: "r1", revisionId: "v1" },
      video,
      ready: true,
      sourceKey: "http://local/v.mp4",
      style: DEFAULT_SUBTITLE_STYLE,
    }));
    await waitFor(() => expect(result.current.status).toBe("failed"));
    expect(result.current.message).toContain("500");
  });

  it("renders cues sharing identical startMs and endMs without duplicate React key warnings", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { configurable: true, value: 1.5 });
    Object.defineProperty(video, "videoWidth", { configurable: true, value: 1280 });
    Object.defineProperty(video, "videoHeight", { configurable: true, value: 720 });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(720);
    const cues = [
      { startMs: 1000, endMs: 3000, lines: ["Line A"], top: false },
      { startMs: 1000, endMs: 3000, lines: ["Line B"], top: false },
    ];
    render(<SubtitleLayer video={video} cues={cues} secondaryCues={[]} style={DEFAULT_SUBTITLE_STYLE} />);
    expect(screen.getAllByTestId("subtitle-line")).toHaveLength(2);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe("video playback, source, and keyboard regressions", () => {
  it("ignores malformed empty video.frameIndex payloads and recovers frameChain after thrown error", async () => {
    let calls = 0;
    (window as unknown as { manga: unknown }).manga = {
      command: async ({ commandId }: { commandId: string }) => {
        if (commandId === "video.frameIndex") {
          calls += 1;
          if (calls === 1) return { status: "ok", value: {} };
          if (calls === 2) throw new Error("transient ipc error");
          return { status: "ok", value: { ready: true, frame: 5, totalFrames: 100, ptsMs: 200, durationMs: 4000, previousMs: 160, nextMs: 240 } };
        }
        return { status: "ok", value: {} };
      },
    };
    const video = document.createElement("video");
    Object.defineProperty(video, "paused", { configurable: true, value: true });
    Object.defineProperty(video, "duration", { configurable: true, value: 4 });
    video.pause = vi.fn();
    const { result } = renderHook(() => useVideoPlayback({
      element: video,
      target: { resourceId: "r1", revisionId: "v1" },
      url: "http://local/v.mp4",
      startMs: 0,
      settings: { rate: 1, holdRate: 2, volume: 1, muted: false },
      durationHintMs: 4000,
      onProgress: vi.fn(),
      onEnded: vi.fn(),
      onMediaError: vi.fn(),
    }));
    await act(async () => { await result.current.refreshFrame(); });
    expect(result.current.frame.status).toBe("absent");
    // Step 2 fails; step 3 must still execute cleanly instead of staying permanently poisoned.
    await act(async () => { await result.current.stepFrame(1).catch(() => undefined); });
    await act(async () => { await result.current.stepFrame(1); });
    expect(result.current.frame).toMatchObject({ status: "ready", frame: 5 });
  });

  it("does not poison hardware HEVC detection on non-decode media errors", async () => {
    const planCalls: unknown[] = [];
    (window as unknown as { manga: unknown }).manga = {
      command: async ({ commandId, input }: { commandId: string; input: unknown }) => {
        if (commandId === "video.playbackPlan") {
          planCalls.push(input);
          return { status: "ok", value: { available: true, plan: { decision: "direct", reasons: [], detail: "" }, copy: null } };
        }
        if (commandId === "video.handle") return { status: "ok", value: { url: "http://local/v.mp4", mediaType: "video/mp4", startMs: 0 } };
        return { status: "ok", value: {} };
      },
    };
    const { result } = renderHook(() => useVideoSource({ resourceId: "r1", revisionId: "v1" }, undefined));
    await waitFor(() => expect(result.current.state.phase).toBe("ready"));
    // MEDIA_ERR_NETWORK (2) must go straight to failed without re-planning or marking hardware HEVC broken.
    act(() => { result.current.reportMediaError(2, "network lost"); });
    expect(result.current.state).toMatchObject({ phase: "failed", code: "MEDIA_ERR_2" });
    expect(planCalls).toHaveLength(1);
  });

  it("releases remapped seek hold on keyup and closes video-more-panel on Escape", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const media = installMediaElement();
    installPointerEvent();
    (window as unknown as { manga: unknown }).manga = {
      command: async ({ commandId }: { commandId: string }) => {
        if (commandId === "video.playbackPlan") return { status: "ok", value: { available: true, plan: { decision: "direct", reasons: [], detail: "" }, copy: null } };
        if (commandId === "video.handle") return { status: "ok", value: { url: "http://local/v.mp4", mediaType: "video/mp4", startMs: 0 } };
        if (commandId === "video.subtitles") return { status: "ok", value: { subtitles: [] } };
        return { status: "ok", value: {} };
      },
    };
    const doc: VideoDoc = { resourceId: "r_v", revisionId: "rev_v", title: "Demo", episodeLabel: null, durationMs: 60_000, available: true, audio: [], episodes: [] };
    const settings: VideoSettings = {
      rate: 1, rates: [1, 2], customRate: 1.5, holdRate: 2.5, volume: 1, muted: false, seekStepSeconds: 5, autoNext: false,
      subtitlePlacement: "auto", subtitleSizePct: 100, subtitleFont: "sans", subtitleOutline: true, assStyle: "keep", shotSubtitles: true, pauseOnQuickNote: false,
    };
    const customKeys = resolveKeys({ "video.seekForward": ["L"] });
    render(
      <KeyTableProvider value={customKeys}>
        <TabProvider value={{ tabId: "t1", focused: true, visible: true }}>
          <VideoPlayer t={i18n.t} doc={doc} settings={settings} onSettings={vi.fn()} onBack={vi.fn()} onNext={vi.fn()} onEpisode={vi.fn()} onProgress={vi.fn()} onBackToNote={vi.fn()} onRepair={vi.fn()} />
        </TabProvider>
      </KeyTableProvider>,
    );
    const video = () => screen.getByTestId("video-element") as HTMLVideoElement;
    await waitFor(() => expect(video().getAttribute("src")).toBe("http://local/v.mp4"));
    act(() => media.loaded(video(), 60));
    await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"));

    // Hold remapped seekForward key 'L', then release 'L' -> hold ends cleanly.
    fireEvent.keyDown(window, { key: "l", code: "KeyL" });
    act(() => { vi.advanceTimersByTime(350); });
    expect(screen.getByTestId("video-holding")).toBeTruthy();
    fireEvent.keyUp(window, { key: "l", code: "KeyL" });
    expect(screen.queryByTestId("video-holding")).toBeNull();

    // Open more panel and press Escape -> panel closes.
    fireEvent.click(screen.getByTestId("video-more"));
    expect(screen.getByTestId("video-more-panel")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("video-more-panel")).toBeNull();
    cleanup();
    media.restore();
  });
});

describe("comic reader, danmaku, and novel read-aloud regressions", () => {
  it("cancels pending wheel zoom when an explicit zoom button is clicked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installPointerEvent();
    (window as unknown as { manga: unknown }).manga = { command: async () => ({ status: "ok", value: { pages: [] } }) };
    const doc: ComicDoc = {
      resourceId: "r_c", revisionId: "rev_c", title: "Comic", direction: "ltr", available: true, warnings: [],
      pages: [{ id: "p0", index: 0, name: "0.png", width: 800, height: 1200, spread: false, ok: true }],
    };
    const settings: ComicSettings = { direction: "ltr", layout: "single", coverAlone: true, fit: "page", zoom: 1, autoFlipSeconds: 0, animation: "none" };
    const onSettings = vi.fn();
    render(
      <TabProvider value={{ tabId: "t1", focused: true, visible: true }}>
        <ComicReader t={i18n.t} doc={doc} settings={settings} onSettings={onSettings} onBack={vi.fn()} onPage={vi.fn()} onBackToNote={vi.fn()} onRepair={vi.fn()} />
      </TabProvider>,
    );
    const stage = screen.getByTestId("comic-stage");
    fireEvent.wheel(stage, { ctrlKey: true, deltaY: -200 });
    // Before the 300ms wheel save fires, user clicks Zoom Reset (100%).
    fireEvent.click(screen.getByTestId("comic-zoom-value"));
    expect(onSettings).toHaveBeenCalledTimes(1);
    expect(onSettings).toHaveBeenLastCalledWith({ zoom: 1 });
    // Advancing past ZOOM_SAVE_MS must NOT fire the stale wheel zoom save.
    act(() => { vi.advanceTimersByTime(500); });
    expect(onSettings).toHaveBeenCalledTimes(1);
  });

  it("sorts out-of-order danmaku comments before merging duplicates", () => {
    const items: DanmakuItem[] = [
      { at: 20_000, mode: "scroll", color: 0xffffff, source: "a", text: "nice" },
      { at: 5_000, mode: "scroll", color: 0xffffff, source: "b", text: "nice" },
      { at: 12_000, mode: "scroll", color: 0xffffff, source: "c", text: "nice" },
    ];
    const prepared = prepareDanmaku(items, { ...DEFAULT_DANMAKU_SETTINGS, merge: true }, 0, 0);
    // 5s and 12s merge into 5s (delta=7s <= 10s), while 20s starts a new group (20-5=15s > 10s).
    expect(prepared).toHaveLength(2);
    expect(prepared[0]).toMatchObject({ time: 5, text: "nice ×2" });
    expect(prepared[1]).toMatchObject({ time: 20, text: "nice" });
  });

  it("does not re-enter begin when wanted.from equals the current slice end", () => {
    const onWindow = vi.fn();
    const { result, rerender } = renderHook(
      ({ slice }) => useReadNovel({
        resourceId: "book1",
        slice,
        parts: [{ id: "ch1", length: 200 }],
        at: () => 50,
        available: true,
        costHint: false,
        onCostHintOff: vi.fn(),
        onWindow,
        onMove: vi.fn(),
      }),
      { initialProps: { slice: { partId: "ch1", text: "   ", start: 0, end: 50, textLayer: true, kind: "text" } } },
    );
    // Starting on whitespace-only slice immediately requests the next window starting at 50.
    act(() => { result.current.start(); });
    expect(onWindow).toHaveBeenCalledTimes(1);
    expect(onWindow).toHaveBeenCalledWith("ch1", 50);
    // Re-rendering with the SAME slice (end === 50) must NOT loop and call onWindow again.
    rerender({ slice: { partId: "ch1", text: "   ", start: 0, end: 50, textLayer: true, kind: "text" } });
    expect(onWindow).toHaveBeenCalledTimes(1);
  });
});
