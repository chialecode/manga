/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { VideoPlayer, type VideoDoc, type VideoSettings } from "../../apps/desktop/src/renderer/readers/video-player.tsx";
import { resetVideoSupport } from "../../apps/desktop/src/renderer/readers/video-support.ts";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { installMatchMedia, installMediaElement, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";

const i18n = createTranslator("zh-CN");
const FPS = 24;
const FRAMES = 2880;
const ptsOf = (frame: number) => (frame * 1000) / FPS;

const baseSettings: VideoSettings = { rate: 1, holdRate: 2, volume: 0.5, muted: false, seekStepSeconds: 5, autoNext: false };

const baseDoc: VideoDoc = {
  resourceId: "res_v", revisionId: "rev_v", title: "合成动画", episodeLabel: "第 1 话", durationMs: 120_000, available: true,
  audio: [
    { index: 1, codec: "aac", language: "jpn", title: null, channels: 2, default: true },
    { index: 2, codec: "aac", language: "chi", title: "国语", channels: 2, default: false },
  ],
  episodes: [
    { resourceId: "res_v", label: "第 1 话", available: true },
    { resourceId: "res_v2", label: "第 2 话", available: true },
  ],
};

type Call = { commandId: string; input: Record<string, unknown> };
type Handler = (input: Record<string, unknown>) => unknown;

const plan = (decision: "direct" | "remux" | "play_copy" | "unsupported", extra: Record<string, unknown> = {}) => ({
  resourceId: "res_v", revisionId: "rev_v", available: true,
  plan: { decision, reasons: [], videoStreamIndex: 0, audioStreamIndex: 1, mediaType: "video/mp4", detail: "synthetic", ...extra },
  copy: null,
});

function installHost(overrides: Record<string, Handler> = {}) {
  const calls: Call[] = [];
  const handlers: Record<string, Handler> = {
    "video.playbackPlan": () => plan("direct"),
    "video.handle": (input) => ({ source: input.source, url: input.source === "play_copy" ? "manga-media://h/copy" : "manga-media://h/original", handle: "h", mediaType: "video/mp4", bytes: 10, startMs: 0, ...(input.copyId ? { copyId: input.copyId } : {}) }),
    "video.subtitles": () => ({ subtitles: [] }),
    "video.fonts": () => ({ fonts: [] }),
    "video.frameIndex": (input) => {
      let frame: number;
      if (typeof input.frame === "number") {
        if (input.frame >= FRAMES) throw Object.assign(new Error(`the video has ${FRAMES} frames`), { code: "NOT_FOUND" });
        frame = input.frame;
      } else frame = Math.min(FRAMES - 1, Math.floor(((input.timeMs as number) + 0.5) / (1000 / FPS)));
      frame = Math.max(0, Math.min(FRAMES - 1, frame + ((input.delta as number | undefined) ?? 0)));
      return { revisionId: "rev_v", frame, ptsMs: ptsOf(frame), totalFrames: FRAMES, durationMs: 120_000, variableFrameRate: false, previousMs: frame > 0 ? ptsOf(frame - 1) : null, nextMs: frame + 1 < FRAMES ? ptsOf(frame + 1) : null };
    },
    ...overrides,
  };
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input: Record<string, unknown> }) {
      calls.push({ commandId: payload.commandId, input: payload.input });
      const handler = handlers[payload.commandId];
      if (!handler) return { status: "ok", value: {} };
      try {
        return { status: "ok", value: handler(payload.input) };
      } catch (error) {
        const failure = error as { code?: string; message?: string };
        return { status: "error", error: { code: failure.code ?? "INTERNAL", message: failure.message ?? "failed" } };
      }
    },
    onNotice: () => () => undefined,
  };
  return { calls, of: (id: string) => calls.filter((call) => call.commandId === id) };
}

type Props = Partial<Parameters<typeof VideoPlayer>[0]>;
let media: ReturnType<typeof installMediaElement>;

function mount(props: Props = {}) {
  const handlers = { onSettings: vi.fn(), onBack: vi.fn(), onNext: vi.fn(), onEpisode: vi.fn(), onProgress: vi.fn(), onBackToNote: vi.fn(), onRepair: vi.fn() };
  const result = render(<VideoPlayer t={i18n.t} doc={baseDoc} settings={baseSettings} {...handlers} {...props} />);
  return { ...result, handlers };
}

const element = () => screen.getByTestId("video-element") as HTMLVideoElement;
/** What is set once and rarely used sits in the "…" panel above the controls (A-47). */
const openMore = () => fireEvent.click(screen.getByTestId("video-more"));
const text = (id: string) => screen.getByTestId(id).textContent;

/** Mount and wait until the file is playable: the source resolved and the element reported its metadata. */
async function ready(props: Props = {}, duration = 120) {
  const view = mount(props);
  // A loaded machine runs many test files at once; the wait is for the state, not a speed.
  await waitFor(() => expect(element().getAttribute("src")).toBeTruthy(), { timeout: 20_000 });
  act(() => media.loaded(element(), duration));
  await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"), { timeout: 20_000 });
  return view;
}

beforeEach(() => {
  media = installMediaElement();
  installPointerEvent();
  resetVideoSupport();
  installHost();
  quoteTags.reset();
});
afterEach(() => { cleanup(); media.restore(); vi.restoreAllMocks(); vi.useRealTimers(); removeMatchMedia(); quoteTags.reset(); });

describe("M2 video player: sources", () => {
  it("plays a file that plays directly from the original and shows its time", async () => {
    const host = installHost();
    await ready();
    expect(element().getAttribute("src")).toBe("manga-media://h/original");
    expect(text("video-time")).toBe("0:00 / 2:00");
    expect(host.of("video.playbackPlan")[0]!.input).toMatchObject({ resourceId: "res_v", revisionId: "rev_v", hardwareHevc: false });
    expect(host.of("video.handle")[0]!.input).toMatchObject({ source: "original" });
    expect(screen.queryByTestId("video-copy-badge")).toBeNull();
  });

  it("stays ready when the file reports its metadata as soon as the player points at it", async () => {
    // A cached or quick file can answer before the effects of the render that set its address have run; that answer
    // must not be wiped by the player getting ready for the new address afterwards.
    mount();
    const video = element();
    const observer = new MutationObserver(() => { if (video.getAttribute("src")) media.loaded(video, 120); });
    observer.observe(video, { attributes: true, attributeFilter: ["src"] });
    try {
      await waitFor(() => expect(video.getAttribute("src")).toBeTruthy(), { timeout: 20_000 });
      await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"), { timeout: 20_000 });
    } finally {
      observer.disconnect();
    }
    expect(text("video-time")).toBe("0:00 / 2:00");
  });

  it("starts at the saved position, and not past the end", async () => {
    await ready({ startMs: 65_000 });
    expect(media.state(element()).seeks).toContain(65);
    cleanup();
    media.restore();
    media = installMediaElement();
    await ready({ startMs: 119_500 });
    expect(media.state(element()).seeks).not.toContain(119.5);
  });

  it("explains why a copy is needed, and builds one only when asked", async () => {
    let copyState: "none" | "running" | "ready" = "none";
    const copy = (state: "running" | "ready") => ({ id: "copy1", revisionId: "rev_v", reason: "no_hardware_hevc", state, audioStreamIndex: 1, progress: state === "ready" ? 1 : 0.4, bytes: 10, encoder: "libx264", error: null, timestampCheck: null, createdAt: "2026-10-04T00:00:00Z" });
    const host = installHost({
      "video.playbackPlan": () => ({ ...plan("play_copy", { reasons: ["no_hardware_hevc"], copy: { reason: "no_hardware_hevc", video: "encode", audio: "copy" } }), copy: copyState === "none" ? null : copy(copyState) }),
      "video.playCopy": (input) => {
        if (input.action === "create") { copyState = "running"; return { copy: copy("running") }; }
        if (input.action === "status") return { copies: [copyState === "ready" ? copy("ready") : copy("running")] };
        return {};
      },
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("video-needs-copy")).toBeTruthy());
    expect(text("video-copy-reason")).toContain("HEVC");
    // Nothing was built and no source was opened before the user asked.
    expect(host.of("video.playCopy")).toHaveLength(0);
    expect(element().getAttribute("src")).toBeNull();
    fireEvent.click(screen.getByTestId("video-make-copy"));
    await waitFor(() => expect(screen.getByTestId("video-building")).toBeTruthy());
    expect(host.of("video.playCopy")[0]!.input).toMatchObject({ action: "create", hardwareHevc: false });
    expect(text("video-building")).toContain("40%");
    copyState = "ready";
    await waitFor(() => expect(element().getAttribute("src")).toBe("manga-media://h/copy"), { timeout: 4000 });
    expect(host.of("video.handle").at(-1)!.input).toMatchObject({ source: "play_copy", copyId: "copy1" });
    expect(screen.getByTestId("video-copy-badge")).toBeTruthy();
  });

  it("lets a build be cancelled and goes back to asking", async () => {
    let cancelled = false;
    const running = { id: "copy1", revisionId: "rev_v", reason: "no_hardware_hevc", state: "running", audioStreamIndex: 1, progress: 0.2, bytes: null, encoder: null, error: null, timestampCheck: null, createdAt: "x" };
    installHost({
      "video.playbackPlan": () => ({ ...plan("play_copy", { reasons: ["no_hardware_hevc"], copy: { reason: "no_hardware_hevc", video: "encode", audio: "copy" } }), copy: cancelled ? null : running }),
      "video.playCopy": (input) => { if (input.action === "cancel") cancelled = true; return { copies: [running] }; },
    });
    mount();
    await waitFor(() => expect(screen.getByTestId("video-building")).toBeTruthy());
    fireEvent.click(screen.getByTestId("video-cancel-copy"));
    await waitFor(() => expect(screen.getByTestId("video-needs-copy")).toBeTruthy());
  });

  it("names the problem for a missing original and offers to find it", async () => {
    installHost({ "video.playbackPlan": () => ({ ...plan("direct"), available: false }) });
    const { handlers } = mount();
    await waitFor(() => expect(screen.getByTestId("video-missing")).toBeTruthy());
    fireEvent.click(screen.getByTestId("video-repair"));
    expect(handlers.onRepair).toHaveBeenCalled();
  });

  it("says so when a file cannot be played at all", async () => {
    installHost({ "video.playbackPlan": () => plan("unsupported", { detail: "the file has no video stream" }) });
    mount();
    await waitFor(() => expect(text("video-unsupported")).toContain("no video stream"));
  });

  it("plans again when the original fails to decode, then offers a forced copy if it fails again", async () => {
    const host = installHost();
    await ready();
    act(() => media.fail(element(), 3, "decode"));
    await waitFor(() => expect(host.of("video.playbackPlan")).toHaveLength(2));
    // The second plan asked for a hardware-less machine, whatever the first said.
    expect(host.of("video.playbackPlan")[1]!.input).toMatchObject({ hardwareHevc: false });
    await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
    act(() => media.loaded(element(), 120));
    act(() => media.fail(element(), 3, "decode"));
    await waitFor(() => expect(screen.getByTestId("video-failed")).toBeTruthy());
    expect(screen.getByTestId("video-force-copy")).toBeTruthy();
    expect(text("video-failed")).toContain("decode");
  });

  it("selecting another audio track re-plans, and the way back to the default is offered", async () => {
    const host = installHost({
      "video.playbackPlan": (input) => input.audioStreamIndex === 2
        ? plan("remux", { reasons: ["audio_track"], audioStreamIndex: 2, copy: { reason: "audio_track", video: "copy", audio: "copy" } })
        : plan("direct"),
    });
    await ready();
    openMore();
    fireEvent.click(screen.getByTestId("video-audio"));
    fireEvent.click(screen.getByTestId("video-audio-2"));
    await waitFor(() => expect(screen.getByTestId("video-needs-copy")).toBeTruthy());
    expect(screen.getByTestId("video-needs-copy").getAttribute("data-reason")).toBe("audio_track");
    expect(host.of("video.playbackPlan").at(-1)!.input).toMatchObject({ audioStreamIndex: 2 });
    fireEvent.click(screen.getByTestId("video-default-audio"));
    await waitFor(() => expect(element().getAttribute("src")).toBe("manga-media://h/original"));
  });
});

describe("M2 video player: playing and seeking", () => {
  it("plays and pauses with the button, the big button and the space bar", async () => {
    await ready();
    fireEvent.click(screen.getByTestId("video-big-play"));
    await waitFor(() => expect(media.state(element()).paused).toBe(false));
    expect(screen.getByTestId("video-toggle").getAttribute("aria-label")).toBe("暂停");
    fireEvent.keyDown(window, { key: " " });
    await waitFor(() => expect(media.state(element()).paused).toBe(true));
    fireEvent.click(screen.getByTestId("video-toggle"));
    await waitFor(() => expect(media.state(element()).paused).toBe(false));
  });

  it("seeks with the arrow keys by the saved step, and with the timeline", async () => {
    const { rerender } = await ready({ settings: { ...baseSettings, seekStepSeconds: 10 } });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(media.state(element()).time).toBe(10);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(media.state(element()).time).toBe(0);
    fireEvent.change(screen.getByTestId("video-seek-input"), { target: { value: "45000" } });
    expect(media.state(element()).time).toBe(45);
    expect(text("video-time")).toBe("0:45 / 2:00");
    void rerender;
  });

  it("does not take keys typed into a field, and leaves Ctrl and Alt combinations alone", async () => {
    await ready();
    openMore();
    const input = screen.getByTestId("video-time-input");
    fireEvent.keyDown(input, { key: " " });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(media.state(element()).paused).toBe(true);
    expect(media.state(element()).time).toBe(0);
    fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true });
    expect(media.state(element()).time).toBe(0);
  });

  it("goes to a typed time and rejects one that is not a time", async () => {
    await ready();
    openMore();
    fireEvent.change(screen.getByTestId("video-time-input"), { target: { value: "1:05" } });
    fireEvent.click(screen.getByTestId("video-time-go"));
    expect(media.state(element()).time).toBe(65);
    fireEvent.change(screen.getByTestId("video-time-input"), { target: { value: "soon" } });
    fireEvent.keyDown(screen.getByTestId("video-time-input"), { key: "Enter" });
    expect(screen.getByTestId("video-input-error")).toBeTruthy();
    expect(media.state(element()).time).toBe(65);
  });

  it("sets volume and mute through the settings, from keys and controls", async () => {
    const { handlers } = await ready();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ volume: 0.55, muted: false });
    fireEvent.keyDown(window, { key: "m" });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ muted: true });
    fireEvent.change(screen.getByTestId("video-volume"), { target: { value: "0.2" } });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ volume: 0.2, muted: false });
    expect(media.state(element()).volume).toBe(0.5);
  });

  it("lowers the sound to 30% while a recording runs and restores it afterwards", async () => {
    const view = await ready({ duck: { active: true, mode: "lower" } });
    await waitFor(() => expect(media.state(element()).volume).toBeCloseTo(0.15, 5));
    view.rerender(<VideoPlayer t={i18n.t} doc={baseDoc} settings={baseSettings} {...view.handlers} duck={{ active: false, mode: "lower" }} />);
    await waitFor(() => expect(media.state(element()).volume).toBe(0.5));
  });
});

describe("M2 video player: frames", () => {
  it("shows the frame number of a paused picture, counted from 1", async () => {
    await ready();
    await waitFor(() => expect(text("video-frame")).toBe("第 1 / 2880 帧"));
    expect(screen.getByTestId("video-frame").getAttribute("data-frame")).toBe("1");
  });

  it("steps to the next and previous frame through the index and checks the picture that was presented", async () => {
    const host = await ready();
    openMore();
    void host;
    await waitFor(() => expect(text("video-frame")).toContain("第 1 /"));
    fireEvent.click(screen.getByTestId("video-next-frame"));
    await waitFor(() => expect(text("video-frame")).toBe("第 2 / 2880 帧"));
    // The seek lands in the middle of frame 2's interval, not on its edge.
    const target = media.state(element()).seeks.at(-1)!;
    expect(target * 1000).toBeGreaterThan(ptsOf(1));
    expect(target * 1000).toBeLessThan(ptsOf(2));
    act(() => media.frame(element(), ptsOf(1) / 1000));
    await waitFor(() => expect(screen.getByTestId("video-frame").getAttribute("data-verified")).toBe("true"));
    expect(element().dataset.mediaTime).toBe(String(Math.round(ptsOf(1) * 1000) / 1000));
    fireEvent.keyDown(window, { key: "," });
    await waitFor(() => expect(text("video-frame")).toBe("第 1 / 2880 帧"));
  });

  it("flags a presented frame that is not the one the index promised", async () => {
    await ready();
    openMore();
    await waitFor(() => expect(text("video-frame")).toContain("第 1 /"));
    fireEvent.click(screen.getByTestId("video-next-frame"));
    await waitFor(() => expect(text("video-frame")).toBe("第 2 / 2880 帧"));
    act(() => media.frame(element(), ptsOf(0) / 1000));
    await waitFor(() => expect(screen.getByTestId("video-frame").getAttribute("data-verified")).toBe("false"));
  });

  it("pauses a playing video when stepping, and jumps to a typed frame number", async () => {
    const host = installHost();
    await ready();
    openMore();
    fireEvent.click(screen.getByTestId("video-toggle"));
    await waitFor(() => expect(media.state(element()).paused).toBe(false));
    expect(text("video-frame")).toBe("");
    fireEvent.click(screen.getByTestId("video-next-frame"));
    await waitFor(() => expect(media.state(element()).paused).toBe(true));
    await waitFor(() => expect(host.of("video.frameIndex").some((call) => call.input.delta === 1)).toBe(true));
    fireEvent.change(screen.getByTestId("video-frame-input"), { target: { value: "100" } });
    fireEvent.click(screen.getByTestId("video-frame-go"));
    await waitFor(() => expect(host.of("video.frameIndex").some((call) => call.input.frame === 99)).toBe(true));
    await waitFor(() => expect(text("video-frame")).toBe("第 100 / 2880 帧"));
  });

  it("keeps the frame number of a jump when the seek finishes before the new picture is presented", async () => {
    await ready();
    openMore();
    await waitFor(() => expect(text("video-frame")).toContain("第 1 /"));
    // A picture was presented earlier; after the jump the element still reports that old one until the new one arrives.
    act(() => media.frame(element(), 0.6));
    fireEvent.change(screen.getByTestId("video-frame-input"), { target: { value: "58" } });
    fireEvent.click(screen.getByTestId("video-frame-go"));
    await waitFor(() => expect(text("video-frame")).toBe("第 58 / 2880 帧"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(text("video-frame")).toBe("第 58 / 2880 帧");
    act(() => media.frame(element(), ptsOf(57) / 1000));
    await waitFor(() => expect(screen.getByTestId("video-frame").getAttribute("data-verified")).toBe("true"));
    expect(text("video-frame")).toBe("第 58 / 2880 帧");
  });

  it("rejects a frame number outside the video", async () => {
    await ready();
    openMore();
    await waitFor(() => expect(text("video-frame")).toContain("/ 2880"));
    fireEvent.change(screen.getByTestId("video-frame-input"), { target: { value: "5000" } });
    fireEvent.click(screen.getByTestId("video-frame-go"));
    expect(text("video-input-error")).toContain("2880");
  });

  it("says the frame number is unavailable when the index cannot be built, and playback still works", async () => {
    installHost({ "video.frameIndex": () => { throw Object.assign(new Error("the media tool is not installed"), { code: "CAPABILITY_UNAVAILABLE" }); } });
    await ready();
    await waitFor(() => expect(text("video-frame")).toBe("帧号暂不可用"));
    fireEvent.click(screen.getByTestId("video-toggle"));
    await waitFor(() => expect(media.state(element()).paused).toBe(false));
  });
});

describe("M2 video player: rate", () => {
  it("picks a preset, types a custom rate, and steps with the bracket keys", async () => {
    const { handlers } = await ready();
    openMore();
    fireEvent.click(screen.getByTestId("video-rate"));
    fireEvent.click(screen.getByTestId("video-rate-1_5"));
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ rate: 1.5 });
    fireEvent.change(screen.getByTestId("video-rate-input"), { target: { value: "1.75" } });
    fireEvent.keyDown(screen.getByTestId("video-rate-input"), { key: "Enter" });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ rate: 1.75 });
    fireEvent.keyDown(window, { key: "]" });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ rate: 1.25 });
    handlers.onSettings.mockClear();
    fireEvent.change(screen.getByTestId("video-rate-input"), { target: { value: "9" } });
    fireEvent.keyDown(screen.getByTestId("video-rate-input"), { key: "Enter" });
    expect(handlers.onSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId("video-input-error").textContent).toContain("0.25");
  });

  it("applies the saved rate to the element", async () => {
    await ready({ settings: { ...baseSettings, rate: 1.5 } });
    expect(media.state(element()).rate).toBe(1.5);
  });

  it("plays at the temporary rate while the right button is held, then goes back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await ready({ settings: { ...baseSettings, rate: 1.25 } });
    const stage = screen.getByTestId("video-stage");
    fireEvent.pointerDown(stage, { button: 2, clientX: 10, clientY: 10 });
    act(() => { vi.advanceTimersByTime(350); });
    expect(media.state(element()).rate).toBe(2);
    expect(media.state(element()).paused).toBe(false);
    expect(screen.getByTestId("video-holding").textContent).toContain("2");
    act(() => { window.dispatchEvent(new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent("pointerup", { button: 2 })); });
    expect(media.state(element()).rate).toBe(1.25);
    expect(screen.queryByTestId("video-holding")).toBeNull();
    expect(screen.queryByTestId("video-context")).toBeNull();
  });

  it("opens a menu for a short right press and does not change the rate", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await ready();
    fireEvent.pointerDown(screen.getByTestId("video-stage"), { button: 2, clientX: 40, clientY: 50 });
    act(() => { window.dispatchEvent(new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent("pointerup", { button: 2, clientX: 40, clientY: 50 })); });
    expect(screen.getByTestId("video-context")).toBeTruthy();
    expect(media.state(element()).rate).toBe(1);
    expect(media.state(element()).paused).toBe(true);
  });
});

describe("M2 video player: marks and notes", () => {
  it("marks A and B with the keys, orders them, and makes the interval a quote tag for the right pane", async () => {
    await ready();
    act(() => media.advance(element(), 20));
    fireEvent.keyDown(window, { key: "o" });
    act(() => { media.state(element()).time = 10; media.advance(element(), 0); });
    fireEvent.keyDown(window, { key: "i" });
    openMore();
    await waitFor(() => expect(text("video-interval")).toBe("区间 0:10 – 0:20"));
    // The player only reads: the interval is a tag waiting in the right pane's input, and there is no note button.
    expect(quoteTags.all()).toEqual([expect.objectContaining({ kind: "interval", resourceId: "res_v", revisionId: "rev_v", startMs: 10_000, endMs: 20_000 })]);
    expect(screen.queryByTestId("video-note-interval")).toBeNull();
    fireEvent.click(screen.getByTestId("video-clear-marks"));
    expect(screen.queryByTestId("video-interval")).toBeNull();
    expect(quoteTags.all()).toEqual([]);
  });

  it("clears the marks when the tag is removed in the right pane", async () => {
    await ready();
    openMore();
    act(() => media.advance(element(), 20));
    fireEvent.click(screen.getByTestId("video-mark-b"));
    act(() => { media.state(element()).time = 10; media.advance(element(), 0); });
    fireEvent.click(screen.getByTestId("video-mark-a"));
    await waitFor(() => expect(quoteTags.all()).toHaveLength(1));
    act(() => quoteTags.remove(quoteTags.all()[0]!.id));
    await waitFor(() => expect(screen.queryByTestId("video-interval")).toBeNull());
    expect(screen.getByTestId("video-mark-a").getAttribute("aria-pressed")).toBe("false");
  });

  it("has no note button for the moment now, in the controls or in the right-click menu, and leaves no tag behind when it closes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { unmount } = await ready();
    act(() => media.advance(element(), 33.5));
    expect(screen.queryByTestId("video-note-here")).toBeNull();
    fireEvent.pointerDown(screen.getByTestId("video-stage"), { button: 2, clientX: 40, clientY: 50 });
    act(() => { window.dispatchEvent(new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent("pointerup", { button: 2, clientX: 40, clientY: 50 })); });
    expect(screen.getByTestId("video-context")).toBeTruthy();
    expect(screen.queryByTestId("video-context-note")).toBeNull();
    fireEvent.keyDown(window, { key: "o" });
    fireEvent.keyDown(window, { key: "i" });
    unmount();
    expect(quoteTags.all()).toEqual([]);
  });

  it("goes to a note's source time and waits there, or plays the interval and stops at its end", async () => {
    await ready({ focus: { startMs: 30_000, endMs: 40_000, nonce: 1 } });
    await waitFor(() => expect(media.state(element()).seeks).toContain(30));
    expect(media.state(element()).paused).toBe(true);
    expect(screen.getByTestId("video-marker-source")).toBeTruthy();
    cleanup();
    media.restore();
    media = installMediaElement();
    await ready({ focus: { startMs: 30_000, endMs: 40_000, play: true, nonce: 1 } });
    await waitFor(() => expect(media.state(element()).paused).toBe(false));
    act(() => media.advance(element(), 9));
    expect(media.state(element()).paused).toBe(false);
    act(() => media.advance(element(), 2));
    await waitFor(() => expect(media.state(element()).paused).toBe(true));
  });

  it("draws recorded intervals on the timeline as places to jump to", async () => {
    await ready({ markers: [{ id: "rec1", startMs: 60_000, endMs: 70_000, label: "录音" }] });
    fireEvent.click(screen.getByTestId("video-marker-rec1"));
    expect(media.state(element()).time).toBe(60);
  });
});

describe("M2 video player: progress", () => {
  it("reports the stretch that was watched when it pauses, and not a stretch that was skipped", async () => {
    const { handlers } = await ready();
    fireEvent.click(screen.getByTestId("video-toggle"));
    await waitFor(() => expect(media.state(element()).paused).toBe(false));
    for (const seconds of [0.25, 0.5, 0.75, 1]) act(() => { media.state(element()).time = seconds; media.advance(element(), 0); });
    fireEvent.click(screen.getByTestId("video-toggle"));
    await waitFor(() => expect(handlers.onProgress).toHaveBeenCalled());
    const report = handlers.onProgress.mock.calls.at(-1)![0];
    expect(report).toMatchObject({ resourceId: "res_v", revisionId: "rev_v", timeMs: 1000 });
    expect(report.ranges).toEqual([{ startMs: 250, endMs: 1000 }]);
  });

  it("sends the last position when the player closes", async () => {
    const { handlers, unmount } = await ready();
    act(() => media.advance(element(), 42));
    unmount();
    expect(handlers.onProgress).toHaveBeenCalled();
    expect(handlers.onProgress.mock.calls.at(-1)![0]).toMatchObject({ resourceId: "res_v", timeMs: 42_000 });
  });
});

describe("M2 video player: ending and episodes", () => {
  it("offers the next episode and a replay when a video ends", async () => {
    const { handlers } = await ready({ next: { resourceId: "res_v2", title: "第 2 话" } });
    act(() => media.finish(element()));
    expect(screen.getByTestId("video-end")).toBeTruthy();
    expect(handlers.onNext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("video-end-next"));
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("video-replay"));
    expect(media.state(element()).time).toBe(0);
    await waitFor(() => expect(media.state(element()).paused).toBe(false));
  });

  it("moves to the next episode by itself only when that is turned on", async () => {
    const { handlers } = await ready({ next: { resourceId: "res_v2", title: "第 2 话" }, settings: { ...baseSettings, autoNext: true } });
    act(() => media.finish(element()));
    expect(handlers.onNext).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("video-end")).toBeNull();
  });

  it("lists the episodes of the work and opens the chosen one", async () => {
    const { handlers } = await ready();
    openMore();
    fireEvent.click(screen.getByTestId("video-episodes"));
    fireEvent.click(screen.getByTestId("video-episodes-res_v2"));
    expect(handlers.onEpisode).toHaveBeenCalledWith("res_v2");
  });
});

describe("M2 video player: subtitles", () => {
  it("shows a text subtitle track as native cues and clears them when turned off", async () => {
    const vtt = ["WEBVTT", "", "00:00:01.000 --> 00:00:02.000", "你好", "", "00:00:03.000 --> 00:00:04.000", "再见"].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(vtt)));
    installHost({
      "video.subtitles": () => ({ subtitles: [{ id: "s2", source: "embedded", streamIndex: 2, codec: "subrip", format: "srt", language: "chi", title: null, default: false }] }),
      "video.subtitleHandle": () => ({ trackId: "s2", format: "vtt", language: "chi", title: null, url: "manga-media://h/sub", handle: "s", mediaType: "text/vtt" }),
    });
    await ready();
    openMore();
    await waitFor(() => expect(media.textTrack(element())?.cues).toHaveLength(2));
    expect(media.textTrack(element())!.mode).toBe("showing");
    expect(media.textTrack(element())!.cues[0]).toMatchObject({ startTime: 1, endTime: 2, text: "你好" });
    fireEvent.click(screen.getByTestId("video-subtitles"));
    fireEvent.click(screen.getByTestId("video-subtitles-off"));
    await waitFor(() => expect(media.textTrack(element())!.mode).toBe("disabled"));
    expect(media.textTrack(element())!.cues).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it("tells the user a track could not be shown without stopping the video", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    installHost({
      "video.subtitles": () => ({ subtitles: [{ id: "s2", source: "embedded", streamIndex: 2, codec: "subrip", format: "srt", language: "chi", title: null, default: false }] }),
      "video.subtitleHandle": () => ({ trackId: "s2", format: "vtt", language: "chi", title: null, url: "manga-media://h/sub", handle: "s", mediaType: "text/vtt" }),
    });
    await ready();
    openMore();
    await waitFor(() => expect(screen.getByTestId("video-subtitle-notice").textContent).toContain("network down"));
    fireEvent.click(screen.getByTestId("video-toggle"));
    await waitFor(() => expect(media.state(element()).paused).toBe(false));
    vi.unstubAllGlobals();
  });
});

describe("M2 video player: a file that starts late", () => {
  const ORIGIN = 2500;
  const late = (extra: Record<string, (input: Record<string, unknown>) => unknown> = {}) => installHost({
    "video.handle": (input) => ({ source: input.source, url: "manga-media://h/original", handle: "h", mediaType: "video/x-matroska", bytes: 10, startMs: input.source === "original" ? ORIGIN : 0 }),
    ...extra,
  });
  /** The element's clock starts at the container's start time, as it does for such a file in the real player. */
  const lateReady = async (props: Props = {}) => {
    const view = await ready(props, 12.5);
    act(() => { media.state(element()).time = ORIGIN / 1000; media.advance(element(), 0); });
    return view;
  };

  it("shows the time and the length counted from the start of the file", async () => {
    late();
    await lateReady();
    await waitFor(() => expect(text("video-time")).toBe("0:00 / 0:10"));
    act(() => media.advance(element(), 5));
    await waitFor(() => expect(text("video-time")).toBe("0:05 / 0:10"));
  });

  it("moves the element by the file's own time plus the start, for keys, the timeline and typed times", async () => {
    late();
    await lateReady();
    openMore();
    fireEvent.click(screen.getByTestId("video-step-forward"));
    expect(media.state(element()).time).toBe(ORIGIN / 1000 + 5);
    fireEvent.change(screen.getByTestId("video-time-input"), { target: { value: "0:08" } });
    fireEvent.click(screen.getByTestId("video-time-go"));
    expect(media.state(element()).time).toBe(ORIGIN / 1000 + 8);
  });

  it("keeps a saved position and a note's source on the file's time", async () => {
    late();
    await lateReady({ startMs: 4000 });
    expect(media.state(element()).seeks.at(-1)).toBe((4000 + ORIGIN) / 1000);
  });

  it("jumps to a frame by the index and checks the picture against the file's time", async () => {
    late();
    await lateReady();
    openMore();
    await waitFor(() => expect(text("video-frame")).toContain("第 1 /"));
    fireEvent.change(screen.getByTestId("video-frame-input"), { target: { value: "58" } });
    fireEvent.click(screen.getByTestId("video-frame-go"));
    await waitFor(() => expect(text("video-frame")).toBe("第 58 / 2880 帧"));
    const target = media.state(element()).seeks.at(-1)!;
    expect(target * 1000).toBeGreaterThan(ptsOf(57) + ORIGIN);
    expect(target * 1000).toBeLessThan(ptsOf(58) + ORIGIN);
    // The element reports its own clock; the frame it presents is frame 58 when that clock minus the start matches.
    act(() => media.frame(element(), (ptsOf(57) + ORIGIN) / 1000));
    await waitFor(() => expect(screen.getByTestId("video-frame").getAttribute("data-verified")).toBe("true"));
    expect(element().dataset.mediaTime).toBe(String(ptsOf(57) + ORIGIN));
  });

  it("reports what was watched on the file's time", async () => {
    late();
    const { handlers } = await lateReady();
    fireEvent.click(screen.getByTestId("video-toggle"));
    await waitFor(() => expect(media.state(element()).paused).toBe(false));
    for (const seconds of [0.5, 1, 1.5]) act(() => { media.state(element()).time = ORIGIN / 1000 + seconds; media.advance(element(), 0); });
    fireEvent.click(screen.getByTestId("video-toggle"));
    await waitFor(() => expect(handlers.onProgress).toHaveBeenCalled());
    const report = handlers.onProgress.mock.calls.at(-1)![0];
    expect(report.timeMs).toBe(1500);
    expect(report.ranges).toEqual([{ startMs: 500, endMs: 1500 }]);
  });

  it("puts text subtitle cues on the element's clock", async () => {
    const vtt = ["WEBVTT", "", "00:00:01.000 --> 00:00:02.000", "你好"].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(vtt)));
    late({
      "video.subtitles": () => ({ subtitles: [{ id: "s2", source: "embedded", streamIndex: 2, codec: "subrip", format: "srt", language: "chi", title: null, default: false }] }),
      "video.subtitleHandle": () => ({ trackId: "s2", format: "vtt", language: "chi", title: null, url: "manga-media://h/sub", handle: "s", mediaType: "text/vtt" }),
    });
    await lateReady();
    await waitFor(() => expect(media.textTrack(element())?.cues).toHaveLength(1));
    expect(media.textTrack(element())!.cues[0]).toMatchObject({ startTime: 1 + ORIGIN / 1000, endTime: 2 + ORIGIN / 1000 });
    vi.unstubAllGlobals();
  });
});

describe("M2 video player: help", () => {
  it("lists the default keys", async () => {
    await ready();
    openMore();
    fireEvent.click(screen.getByTestId("video-shortcuts"));
    const panel = screen.getByTestId("video-shortcuts-panel").textContent ?? "";
    for (const part of ["Space", "播放 / 暂停", ", / .", "上一帧 / 下一帧", "I / O"]) expect(panel).toContain(part);
    installMatchMedia({ reducedMotion: false });
  });
});
