/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { VideoPlayer, type VideoDoc, type VideoSettings } from "../../apps/desktop/src/renderer/readers/video-player.tsx";
import { resetVideoSupport } from "../../apps/desktop/src/renderer/readers/video-support.ts";
import { resetInstalledFamilies } from "../../apps/desktop/src/renderer/readers/subtitle-fonts.ts";
import { videoFacts } from "../../apps/desktop/src/renderer/lib/video-facts.ts";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { KeyTableProvider } from "../../apps/desktop/src/renderer/lib/key-table.tsx";
import { WindowFullscreenProvider } from "../../apps/desktop/src/renderer/readers/window-fullscreen.tsx";
import { resolveKeys } from "@manga/contracts/keys";
import type { ReactNode } from "react";
import { installCapture, installMatchMedia, installMediaElement, installPicture, installPointerEvent, removeMatchMedia } from "../helpers/dom.ts";

/**
 * The ASS renderer is not run in a test: what it was given is what matters. Its canvas answers a `resize` the way the real one does, taking the new
 * size a moment later; `ink` says whether anything is drawn on it.
 */
const jassub = vi.hoisted(() => ({ made: [] as Array<Record<string, unknown>>, destroyed: 0, drawn: [] as Array<{ frame: Record<string, number>; repaint: boolean }>, resized: [] as Array<{ force?: boolean; w?: number; h?: number }>, ink: true }));
vi.mock("jassub", () => ({
  default: class {
    ready = Promise.resolve();
    _canvas: HTMLCanvasElement & { __ink?: boolean };
    constructor(options: Record<string, unknown>) {
      jassub.made.push(options);
      this._canvas = document.createElement("canvas");
      this._canvas.width = 1280;
      this._canvas.height = 720;
      this._canvas.__ink = jassub.ink;
    }
    destroy() { jassub.destroyed += 1; }
    async manualRender(frame: Record<string, number>, repaint: boolean) { jassub.drawn.push({ frame, repaint }); }
    resize(force?: boolean, w?: number, h?: number) {
      jassub.resized.push({ force, w, h });
      if (w && h) setTimeout(() => { this._canvas.width = w; this._canvas.height = h; }, 10);
      return Promise.resolve();
    }
  },
}));

const i18n = createTranslator("zh-CN");
const FPS = 24;
const FRAMES = 2880;
const ptsOf = (frame: number) => (frame * 1000) / FPS;

const baseSettings: VideoSettings = {
  rate: 1, rates: [0.5, 0.75, 1, 1.25, 1.5, 2, 3], customRate: 1.5, holdRate: 2, volume: 0.5, muted: false, seekStepSeconds: 5, autoNext: false,
  subtitlePlacement: "auto", subtitleSizePct: 5, subtitleFont: "sans", subtitleOutline: true, assStyle: "keep", shotSubtitles: true,
};

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
let picture: ReturnType<typeof installPicture>;

function mount(props: Props = {}, wrap: (node: ReactNode) => ReactNode = (node) => node) {
  const handlers = { onSettings: vi.fn(), onBack: vi.fn(), onNext: vi.fn(), onEpisode: vi.fn(), onProgress: vi.fn(), onBackToNote: vi.fn(), onRepair: vi.fn() };
  const result = render(<>{wrap(<VideoPlayer t={i18n.t} doc={baseDoc} settings={baseSettings} {...handlers} {...props} />)}</>);
  return { ...result, handlers };
}

const element = () => screen.getByTestId("video-element") as HTMLVideoElement;
/** What is set once and rarely used sits in the "…" panel above the controls (A-47). */
const openMore = () => fireEvent.click(screen.getByTestId("video-more"));
const text = (id: string) => screen.getByTestId(id).textContent;

/** Mount and wait until the file is playable: the source resolved and the element reported its metadata. */
async function ready(props: Props = {}, duration = 120, wrap?: (node: ReactNode) => ReactNode) {
  const view = mount(props, wrap);
  // A loaded machine runs many test files at once; the wait is for the state, not a speed.
  await waitFor(() => expect(element().getAttribute("src")).toBeTruthy(), { timeout: 20_000 });
  act(() => media.loaded(element(), duration));
  await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"), { timeout: 20_000 });
  return view;
}

beforeEach(() => {
  media = installMediaElement();
  picture = installPicture({ frame: { w: 1280, h: 720 }, video: { w: 1920, h: 1080 } });
  installPointerEvent();
  resetVideoSupport();
  installHost();
  quoteTags.reset();
});
afterEach(() => { cleanup(); media.restore(); picture.restore(); vi.restoreAllMocks(); vi.useRealTimers(); removeMatchMedia(); quoteTags.reset(); });

describe("video player: sources", () => {
  it("plays a file that plays directly from the original and shows its time", async () => {
    const host = installHost();
    await ready();
    expect(element().getAttribute("src")).toBe("manga-media://h/original");
    expect(text("video-time")).toBe("0:00.000 / 2:00.000");
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
    expect(text("video-time")).toBe("0:00.000 / 2:00.000");
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
    expect(screen.getByTestId("video-controls").contains(screen.getByTestId("video-copy-badge"))).toBe(true);
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

describe("video player: playing and seeking", () => {
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
    fireEvent.keyUp(window, { key: "ArrowRight" });
    expect(media.state(element()).time).toBe(10);
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyUp(window, { key: "ArrowLeft" });
    expect(media.state(element()).time).toBe(0);
    fireEvent.change(screen.getByTestId("video-seek-input"), { target: { value: "45000" } });
    expect(media.state(element()).time).toBe(45);
    expect(text("video-time")).toBe("0:45.000 / 2:00.000");
    void rerender;
  });

  it("does not take keys typed into a field, and leaves Ctrl and Alt combinations alone", async () => {
    await ready();
    fireEvent.click(screen.getByTestId("video-time"));
    const input = screen.getByTestId("video-time-input");
    fireEvent.keyDown(input, { key: " " });
    fireEvent.keyDown(input, { key: "ArrowRight" });
    expect(media.state(element()).paused).toBe(true);
    expect(media.state(element()).time).toBe(0);
    fireEvent.keyDown(window, { key: "ArrowRight", ctrlKey: true });
    expect(media.state(element()).time).toBe(0);
  });

  it("shows the time as minutes, seconds and milliseconds, and exactly while paused", async () => {
    await ready();
    expect(text("video-time")).toBe("0:00.000 / 2:00.000");
    act(() => media.advance(element(), 1.234));
    await waitFor(() => expect(text("video-time")).toBe("0:01.234 / 2:00.000"));
  });

  it("refreshes the time at most about twice a second while the video plays", async () => {
    await ready();
    fireEvent.click(screen.getByTestId("video-toggle"));
    await waitFor(() => expect(media.state(element()).paused).toBe(false));
    const shown = new Set<string | null>();
    // Four seconds of playback in 100 ms steps of the element's clock, one real tenth of a second apart.
    for (let step = 0; step < 40; step += 1) {
      act(() => media.advance(element(), 0.1));
      await new Promise((resolve) => setTimeout(resolve, 100));
      shown.add(text("video-time"));
    }
    expect(shown.size).toBeLessThanOrEqual(10);
    expect(shown.size).toBeGreaterThanOrEqual(4);
  });

  it("turns the time into a field on click, goes to a typed time on Enter, and keeps the place on Esc", async () => {
    const host = installHost();
    await ready();
    act(() => media.advance(element(), 12.5));
    await waitFor(() => expect(text("video-time")).toBe("0:12.500 / 2:00.000"));
    fireEvent.click(screen.getByTestId("video-time"));
    const input = screen.getByTestId("video-time-input") as HTMLInputElement;
    expect(input.value).toBe("0:12.500");
    fireEvent.change(input, { target: { value: "1:05.250" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // 65.25 s at 24 fps is inside frame 1566; the player lands inside that frame, not on its start.
    await waitFor(() => expect(host.of("video.frameIndex").some((call) => call.input.timeMs === 65_250)).toBe(true));
    await waitFor(() => expect(media.state(element()).time).toBeGreaterThan(ptsOf(1566) / 1000));
    expect(media.state(element()).time).toBeLessThan(ptsOf(1567) / 1000);
    expect(screen.queryByTestId("video-time-input")).toBeNull();

    fireEvent.click(screen.getByTestId("video-time"));
    const again = screen.getByTestId("video-time-input");
    fireEvent.change(again, { target: { value: "0:03" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(screen.queryByTestId("video-time-input")).toBeNull();
    expect(media.state(element()).time).toBeGreaterThan(65);
  });

  it("rejects a typed time that is not a time and keeps the field open", async () => {
    await ready();
    fireEvent.click(screen.getByTestId("video-time"));
    const input = screen.getByTestId("video-time-input");
    fireEvent.change(input, { target: { value: "soon" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByTestId("video-input-error")).toBeTruthy();
    expect(screen.getByTestId("video-time-input").getAttribute("aria-invalid")).toBe("true");
    expect(media.state(element()).time).toBe(0);
  });

  it("opens the time field with the T key and has no frame number field", async () => {
    await ready();
    openMore();
    expect(screen.queryByTestId("video-frame-input")).toBeNull();
    expect(screen.queryByTestId("video-frame-go")).toBeNull();
    fireEvent.keyDown(window, { key: "t" });
    expect(document.activeElement).toBe(screen.getByTestId("video-time-input"));
  });

  it("goes to the time itself when no frame index can be built", async () => {
    installHost({ "video.frameIndex": () => { throw Object.assign(new Error("the media tool is not installed"), { code: "CAPABILITY_UNAVAILABLE" }); } });
    await ready();
    fireEvent.click(screen.getByTestId("video-time"));
    fireEvent.change(screen.getByTestId("video-time-input"), { target: { value: "0:40" } });
    fireEvent.keyDown(screen.getByTestId("video-time-input"), { key: "Enter" });
    await waitFor(() => expect(media.state(element()).time).toBe(40));
  });

  it("sets volume and mute through the settings, from keys and the volume popup", async () => {
    const { handlers } = await ready();
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ volume: 0.55, muted: false });
    fireEvent.keyDown(window, { key: "m" });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ muted: true });
    // The volume is a button that opens an upright slider: there is no slider in the bar until it is opened.
    expect(screen.queryByTestId("video-volume")).toBeNull();
    fireEvent.click(screen.getByTestId("video-volume-button"));
    fireEvent.change(screen.getByTestId("video-volume"), { target: { value: "0.2" } });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ volume: 0.2, muted: false });
    fireEvent.click(screen.getByTestId("video-volume-mute"));
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ muted: true });
    expect(media.state(element()).volume).toBe(0.5);
  });

  it("lowers the sound to 30% while a recording runs and restores it afterwards", async () => {
    const view = await ready({ duck: { active: true, mode: "lower" } });
    await waitFor(() => expect(media.state(element()).volume).toBeCloseTo(0.15, 5));
    view.rerender(<VideoPlayer t={i18n.t} doc={baseDoc} settings={baseSettings} {...view.handlers} duck={{ active: false, mode: "lower" }} />);
    await waitFor(() => expect(media.state(element()).volume).toBe(0.5));
  });
});

describe("video player: frames", () => {
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

  it("pauses a playing video when stepping, and names the frame a typed time lands on", async () => {
    const host = installHost();
    await ready();
    openMore();
    fireEvent.click(screen.getByTestId("video-toggle"));
    await waitFor(() => expect(media.state(element()).paused).toBe(false));
    expect(text("video-frame")).toBe("");
    fireEvent.click(screen.getByTestId("video-next-frame"));
    await waitFor(() => expect(media.state(element()).paused).toBe(true));
    await waitFor(() => expect(host.of("video.frameIndex").some((call) => call.input.delta === 1)).toBe(true));
    fireEvent.click(screen.getByTestId("video-time"));
    fireEvent.change(screen.getByTestId("video-time-input"), { target: { value: "4.125" } });
    fireEvent.keyDown(screen.getByTestId("video-time-input"), { key: "Enter" });
    await waitFor(() => expect(host.of("video.frameIndex").some((call) => call.input.timeMs === 4125)).toBe(true));
    await waitFor(() => expect(text("video-frame")).toBe("第 100 / 2880 帧"));
  });

  it("keeps the frame number of a time jump when the seek finishes before the new picture is presented", async () => {
    await ready();
    openMore();
    await waitFor(() => expect(text("video-frame")).toContain("第 1 /"));
    // A picture was presented earlier; after the jump the element still reports that old one until the new one arrives.
    act(() => media.frame(element(), 0.6));
    fireEvent.click(screen.getByTestId("video-time"));
    fireEvent.change(screen.getByTestId("video-time-input"), { target: { value: String(ptsOf(57) / 1000 + 0.005) } });
    fireEvent.keyDown(screen.getByTestId("video-time-input"), { key: "Enter" });
    await waitFor(() => expect(text("video-frame")).toBe("第 58 / 2880 帧"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(text("video-frame")).toBe("第 58 / 2880 帧");
    act(() => media.frame(element(), ptsOf(57) / 1000));
    await waitFor(() => expect(screen.getByTestId("video-frame").getAttribute("data-verified")).toBe("true"));
    expect(text("video-frame")).toBe("第 58 / 2880 帧");
  });

  it("says the frame number is unavailable when the index cannot be built, and playback still works", async () => {
    installHost({ "video.frameIndex": () => { throw Object.assign(new Error("the media tool is not installed"), { code: "CAPABILITY_UNAVAILABLE" }); } });
    await ready();
    await waitFor(() => expect(text("video-frame")).toBe("帧号暂不可用"));
    fireEvent.click(screen.getByTestId("video-toggle"));
    await waitFor(() => expect(media.state(element()).paused).toBe(false));
  });
});

describe("video player: rate", () => {
  it("offers the rates of the list in the bar, picks one, and steps through the list with the bracket keys (AT-90)", async () => {
    // The list is the person's: 1.25 was replaced by 1.3 and 3 was taken out.
    const settings = { ...baseSettings, rates: [0.5, 0.75, 1, 1.3, 1.5, 2] };
    const { handlers } = await ready({ settings });
    fireEvent.click(screen.getByTestId("video-rate"));
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent?.replace("✓ ", ""))).toEqual(["0.5×", "0.75×", "1×", "1.3×", "1.5×", "2×"]);
    expect(screen.queryByTestId("video-rate-1_25")).toBeNull();
    fireEvent.click(screen.getByTestId("video-rate-1_3"));
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ rate: 1.3 });
    // The rate is 1x: ] goes to the next rate of the list, [ to the one before.
    fireEvent.keyDown(window, { key: "]" });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ rate: 1.3 });
    fireEvent.keyDown(window, { key: "[" });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ rate: 0.75 });
  });

  it("switches between 1x and the custom rate with R, and leaves the rate of the held arrow alone (AT-90)", async () => {
    const { handlers, rerender } = await ready({ settings: { ...baseSettings, customRate: 1.7 } });
    fireEvent.keyDown(window, { key: "r" });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ rate: 1.7 });
    handlers.onSettings.mockClear();
    rerender(<VideoPlayer t={i18n.t} doc={baseDoc} settings={{ ...baseSettings, rate: 1.7, customRate: 1.7 }} {...handlers} />);
    // From the custom rate (or from any rate that is not 1x) the key goes back to 1x.
    fireEvent.keyDown(window, { key: "R" });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ rate: 1 });
    rerender(<VideoPlayer t={i18n.t} doc={baseDoc} settings={{ ...baseSettings, rate: 2, customRate: 1.7, holdRate: 3 }} {...handlers} />);
    fireEvent.keyDown(window, { key: "r" });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ rate: 1 });
    // The hold rate is its own setting and the key does not touch it.
    expect(handlers.onSettings.mock.calls.every((call) => !("holdRate" in (call[0] as object)))).toBe(true);
  });

  it("has no rate field in the player: a rate is picked from the list and the list is edited in the settings (AT-90)", async () => {
    await ready();
    openMore();
    expect(screen.queryByTestId("video-rate-input")).toBeNull();
    expect(screen.queryByText("自定义倍速")).toBeNull();
  });

  it("applies the saved rate to the element", async () => {
    await ready({ settings: { ...baseSettings, rate: 1.5 } });
    expect(media.state(element()).rate).toBe(1.5);
  });

  it("steps by the saved step when an arrow is tapped, and a key repeating while it is down does not step again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await ready({ settings: { ...baseSettings, seekStepSeconds: 5 } });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    // The step is made when the key goes up: pressed, nothing has moved and no hold has begun.
    expect(media.state(element()).time).toBe(0);
    fireEvent.keyDown(window, { key: "ArrowRight", repeat: true });
    fireEvent.keyUp(window, { key: "ArrowRight" });
    expect(media.state(element()).time).toBe(5);
    expect(media.state(element()).rate).toBe(1);
    expect(screen.queryByTestId("video-holding")).toBeNull();
    // Time passing after the key is up starts nothing.
    act(() => { vi.advanceTimersByTime(1000); });
    expect(media.state(element()).rate).toBe(1);
    expect(media.state(element()).paused).toBe(true);
  });

  it("plays at the temporary rate while → is held, then goes back to the saved rate and to paused", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await ready({ settings: { ...baseSettings, rate: 1.25 } });
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(media.state(element()).rate).toBe(1.25);
    act(() => { vi.advanceTimersByTime(350); });
    expect(media.state(element()).rate).toBe(2);
    expect(media.state(element()).paused).toBe(false);
    expect(screen.getByTestId("video-holding").textContent).toContain("2");
    // The system's key repeat changes nothing; letting go ends the hold and does not step.
    for (let count = 0; count < 5; count += 1) fireEvent.keyDown(window, { key: "ArrowRight", repeat: true });
    expect(media.state(element()).seeks).toEqual([]);
    fireEvent.keyUp(window, { key: "ArrowRight" });
    expect(media.state(element()).rate).toBe(1.25);
    expect(media.state(element()).paused).toBe(true);
    expect(media.state(element()).seeks).toEqual([]);
    expect(screen.queryByTestId("video-holding")).toBeNull();
  });

  it("keeps playing at the saved rate after a hold on a video that was playing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await ready();
    fireEvent.click(screen.getByTestId("video-toggle"));
    expect(media.state(element()).paused).toBe(false);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    act(() => { vi.advanceTimersByTime(350); });
    expect(media.state(element()).rate).toBe(2);
    fireEvent.keyUp(window, { key: "ArrowRight" });
    expect(media.state(element()).rate).toBe(1);
    expect(media.state(element()).paused).toBe(false);
  });

  it("rewinds about four seconds for each second ← is held, and stops when it is let go", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await ready();
    act(() => media.advance(element(), 60));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    act(() => { vi.advanceTimersByTime(250); });
    expect(media.state(element()).time).toBe(60);
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.getByTestId("video-rewinding")).toBeTruthy();
    const begun = media.state(element()).time;
    expect(begun).toBeLessThan(60);
    act(() => { vi.advanceTimersByTime(1000); });
    // Ten ticks of 0.4 s in a second, give or take a tick.
    const gone = begun - media.state(element()).time;
    expect(gone).toBeGreaterThan(3.2);
    expect(gone).toBeLessThan(4.8);
    expect(media.state(element()).paused).toBe(true);
    fireEvent.keyUp(window, { key: "ArrowLeft" });
    const stopped = media.state(element()).time;
    act(() => { vi.advanceTimersByTime(1000); });
    expect(media.state(element()).time).toBe(stopped);
    expect(screen.queryByTestId("video-rewinding")).toBeNull();
    // It was paused, and stays paused.
    expect(media.state(element()).paused).toBe(true);
  });

  it("plays on from where ← was let go when the video was playing, and does not go below the start", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await ready();
    act(() => media.advance(element(), 2));
    fireEvent.click(screen.getByTestId("video-toggle"));
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    act(() => { vi.advanceTimersByTime(350); });
    expect(media.state(element()).paused).toBe(true);
    act(() => { vi.advanceTimersByTime(2000); });
    expect(media.state(element()).time).toBe(0);
    fireEvent.keyUp(window, { key: "ArrowLeft" });
    expect(media.state(element()).paused).toBe(false);
  });

  it("lets go of a hold, without stepping, when the window loses focus", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await ready();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    act(() => { vi.advanceTimersByTime(350); });
    expect(media.state(element()).rate).toBe(2);
    fireEvent.blur(window);
    expect(media.state(element()).rate).toBe(1);
    fireEvent.keyUp(window, { key: "ArrowRight" });
    expect(media.state(element()).seeks).toEqual([]);
    // A tap that never saw its key-up (focus left between) does not step either.
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.blur(window);
    fireEvent.keyUp(window, { key: "ArrowLeft" });
    expect(media.state(element()).seeks).toEqual([]);
  });

  it("opens the menu with the right button and never changes the rate for a long press", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await ready();
    const stage = screen.getByTestId("video-stage");
    fireEvent.pointerDown(stage, { button: 2, clientX: 40, clientY: 50 });
    act(() => { vi.advanceTimersByTime(800); });
    expect(media.state(element()).rate).toBe(1);
    expect(media.state(element()).paused).toBe(true);
    expect(screen.queryByTestId("video-holding")).toBeNull();
    expect(fireEvent.contextMenu(stage, { clientX: 40, clientY: 50 })).toBe(false);
    expect(screen.getByTestId("video-context")).toBeTruthy();
    expect(media.state(element()).rate).toBe(1);
  });

  it("shows no shortcut list in the player: the keys are in the settings (AT-90)", async () => {
    await ready();
    openMore();
    for (const gone of ["video-shortcuts", "video-shortcuts-panel"]) expect(screen.queryByTestId(gone), gone).toBeNull();
    expect(screen.getByTestId("video-more-panel").textContent).not.toContain("快捷键");
  });
});

describe("video player: marks and notes", () => {
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

  it("hands the marked stretch and the position to the tools other modules add after the marks", async () => {
    const seen: Array<{ currentMs: number; durationMs: number; interval: { startMs: number; endMs: number } | null }> = [];
    await ready({ tools: (state) => { seen.push(state); return <button type="button" data-testid="extra-tool">{state.interval ? `${state.interval.startMs}-${state.interval.endMs}` : "none"}</button>; } });
    expect(screen.queryByTestId("extra-tool")).toBeNull();
    openMore();
    expect(text("extra-tool")).toBe("none");
    act(() => media.advance(element(), 20));
    fireEvent.click(screen.getByTestId("video-mark-b"));
    act(() => { media.state(element()).time = 10; media.advance(element(), 0); });
    fireEvent.click(screen.getByTestId("video-mark-a"));
    await waitFor(() => expect(text("extra-tool")).toBe("10000-20000"));
    expect(seen.at(-1)).toMatchObject({ durationMs: 120_000, interval: { startMs: 10_000, endMs: 20_000 } });
    fireEvent.click(screen.getByTestId("video-clear-marks"));
    await waitFor(() => expect(text("extra-tool")).toBe("none"));
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
    fireEvent.contextMenu(screen.getByTestId("video-stage"), { clientX: 40, clientY: 50 });
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

describe("video player: progress", () => {
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

describe("video player: ending and episodes", () => {
  it("offers a replay and no next-episode button when a video ends, even when there is a next episode", async () => {
    const { handlers } = await ready({ next: { resourceId: "res_v2", title: "第 2 话" } });
    expect(screen.queryByTestId("video-next")).toBeNull();
    act(() => media.finish(element()));
    expect(screen.getByTestId("video-end")).toBeTruthy();
    expect(screen.queryByTestId("video-end-next")).toBeNull();
    expect(handlers.onNext).not.toHaveBeenCalled();
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

describe("video player: subtitles", () => {
  const SRT = ["1", "00:00:01,000 --> 00:00:02,000", "你好", "", "2", "00:00:03,000 --> 00:00:04,000", "再见"].join("\n");
  const srtTrack = (id: string, language: string, index = 2) => ({ id, source: "embedded", streamIndex: index, codec: "subrip", format: "srt", language, title: null, default: false });
  const srtHandle = (trackId: string) => ({ trackId, format: "srt", language: null, title: null, url: `manga-media://h/${trackId}`, handle: "s", mediaType: "application/x-subrip; charset=utf-8" });
  /** One embedded text track, whose file `body` says. */
  const withSubtitle = (body: string) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
    installHost({
      "video.subtitles": () => ({ subtitles: [srtTrack("s2", "chi")] }),
      "video.subtitleHandle": (input) => srtHandle(String(input.trackId)),
    });
  };
  /** The element's clock is at `seconds`, as when the video plays or is moved. */
  const at = (seconds: number) => act(() => { media.state(element()).time = seconds; media.advance(element(), 0); });
  const lines = () => screen.queryAllByTestId("subtitle-line");
  afterEach(() => { vi.unstubAllGlobals(); });

  it("draws a text subtitle in the player's own layer while its cue lasts, and clears it when turned off", async () => {
    withSubtitle(SRT);
    await ready();
    openMore();
    at(1.5);
    await waitFor(() => expect(lines().map((line) => line.textContent)).toEqual(["你好"]));
    at(2.5);
    await waitFor(() => expect(lines()).toHaveLength(0));
    at(3.5);
    await waitFor(() => expect(lines().map((line) => line.textContent)).toEqual(["再见"]));
    fireEvent.click(screen.getByTestId("video-subtitles"));
    fireEvent.click(screen.getByTestId("video-subtitles-off"));
    await waitFor(() => expect(lines()).toHaveLength(0));
    expect(document.querySelector("video track")).toBeNull();
  });

  it("sets the dialogue by the picture: a tenth high, 90% wide, its lower edge 5% above the picture, type 5% of the picture's height", async () => {
    withSubtitle(SRT);
    await ready();
    at(1.5);
    await waitFor(() => expect(lines()).toHaveLength(1));
    const zone = screen.getByTestId("subtitle-zone-dialogue");
    expect(zone.dataset.place).toBe("inside");
    // The 1280 x 720 frame holds a 16:9 picture exactly: 90% wide is 1152, the zone 72 high, 36 above the bottom edge.
    expect(zone.style.width).toBe("1152px");
    expect(zone.style.left).toBe("64px");
    expect(zone.style.height).toBe("72px");
    expect(parseFloat(zone.style.top) + parseFloat(zone.style.height)).toBe(720 - 36);
    expect(lines()[0]!.style.fontSize).toBe("36px");
  });

  it("follows the picture, not the window: a window wider than the video leaves the type at 5% of the picture", async () => {
    withSubtitle(SRT);
    picture.set({ frame: { w: 1600, h: 720 } });
    await ready();
    at(1.5);
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]!.style.fontSize).toBe("36px");
    const zone = screen.getByTestId("subtitle-zone-dialogue");
    expect(zone.style.width).toBe("1152px");
    expect(zone.style.left).toBe("224px");
    act(() => picture.set({ frame: { w: 800, h: 450 } }));
    await waitFor(() => expect(lines()[0]!.style.fontSize).toBe("22.5px"));
    expect(screen.getByTestId("subtitle-zone-dialogue").style.width).toBe("720px");
  });

  it("puts the dialogue on the black bar below a widescreen picture, or on the picture when asked to", async () => {
    // 2.39:1 in a 16:9 frame: a 536-high picture, 92 px of bar under it, enough for the tenth (53.6).
    picture.set({ video: { w: 1920, h: 804 } });
    withSubtitle(SRT);
    await ready();
    at(1.5);
    await waitFor(() => expect(lines()).toHaveLength(1));
    const zone = screen.getByTestId("subtitle-zone-dialogue");
    expect(zone.dataset.place).toBe("below");
    expect(parseFloat(zone.style.top)).toBeCloseTo(92 + 536, 0);
    expect(lines()[0]!.style.fontSize).toBe("26.8px");
    cleanup();
    withSubtitle(SRT);
    await ready({ settings: { ...baseSettings, subtitlePlacement: "inside" } });
    at(1.5);
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(screen.getByTestId("subtitle-zone-dialogue").dataset.place).toBe("inside");
  });

  it("keeps the dialogue on the picture when the bar is too thin to hold it", async () => {
    // 2.39:1 in a frame nearly its own shape: a 1280 x 536 picture in 1280 x 560, a 12 px bar against 53.6 needed.
    picture.set({ frame: { w: 1280, h: 560 }, video: { w: 1920, h: 804 } });
    withSubtitle(SRT);
    await ready();
    at(1.5);
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(screen.getByTestId("subtitle-zone-dialogue").dataset.place).toBe("inside");
  });

  it("sets a caption marked as top in the upper zone, apart from the dialogue", async () => {
    withSubtitle(["1", "00:00:01,000 --> 00:00:02,000", "{\\an8}Ward Office", "", "2", "00:00:01,000 --> 00:00:02,000", "你好"].join("\n"));
    await ready();
    at(1.5);
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]!.textContent).toBe("你好");
    const caption = screen.getByTestId("subtitle-caption");
    expect(caption.textContent).toBe("Ward Office");
    expect(screen.getByTestId("subtitle-zone-top").contains(caption)).toBe(true);
    expect(caption.style.fontSize).toBe("26.64px");
  });

  it("puts a bilingual cue's Chinese on top at the standard height and the other language under it at 75%", async () => {
    withSubtitle(["1", "00:00:01,000 --> 00:00:02,000", "Hello there", "你好", ""].join("\n"));
    await ready();
    at(1.5);
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(lines().map((line) => [line.textContent, line.dataset.size, line.style.fontSize])).toEqual([["你好", "main", "36px"], ["Hello there", "small", "27px"]]);
  });

  it("keeps two lines of one language as they are, at the standard height", async () => {
    withSubtitle(["1", "00:00:01,000 --> 00:00:02,000", "- 去吗？", "- 去。", ""].join("\n"));
    await ready();
    at(1.5);
    await waitFor(() => expect(lines()).toHaveLength(2));
    expect(lines().map((line) => [line.textContent, line.style.fontSize])).toEqual([["- 去吗？", "36px"], ["- 去。", "36px"]]);
  });

  it("restyles by the settings: size, font and outline", async () => {
    withSubtitle(SRT);
    await ready({ settings: { ...baseSettings, subtitleSizePct: 6, subtitleFont: "kai", subtitleOutline: false } });
    at(1.5);
    await waitFor(() => expect(lines()).toHaveLength(1));
    expect(lines()[0]!.style.fontSize).toBe("43.2px");
    const layer = screen.getByTestId("subtitle-layer");
    expect(layer.dataset.outline).toBe("off");
    expect(layer.style.fontFamily).toContain("KaiTi");
  });

  it("draws a second text track under the first, smaller, when one is chosen", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(String(url).endsWith("s3")
      ? ["1", "00:00:01,000 --> 00:00:02,000", "Hello", ""].join("\n")
      : SRT)));
    installHost({
      "video.subtitles": () => ({ subtitles: [srtTrack("s2", "chi"), srtTrack("s3", "eng", 3)] }),
      "video.subtitleHandle": (input) => srtHandle(String(input.trackId)),
    });
    await ready();
    openMore();
    at(1.5);
    await waitFor(() => expect(lines().map((line) => line.textContent)).toEqual(["你好"]));
    // One button, two groups (AT-107): the second track is chosen in the same menu as the first.
    expect(screen.queryByTestId("video-subtitles-secondary")).toBeNull();
    fireEvent.click(screen.getByTestId("video-subtitles"));
    // The main track is not offered again as the second.
    expect((screen.getByTestId("video-subtitles-secondary-s2") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("video-subtitles-secondary-s3"));
    await waitFor(() => expect(lines().map((line) => [line.textContent, line.dataset.size])).toEqual([["你好", "main"], ["Hello", "small"]]));
    fireEvent.click(screen.getByTestId("video-subtitles"));
    expect((screen.getByTestId("video-subtitles-secondary-s3") as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("video-subtitles-secondary-off"));
    await waitFor(() => expect(lines().map((line) => line.textContent)).toEqual(["你好"]));
  });

  it("holds both choices in one subtitle menu, in two titled groups with a close in each (AT-107)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(SRT)));
    installHost({
      "video.subtitles": () => ({ subtitles: [srtTrack("s2", "chi"), srtTrack("s3", "eng", 3)] }),
      "video.subtitleHandle": (input) => srtHandle(String(input.trackId)),
    });
    await ready();
    openMore();
    at(1.5);
    await waitFor(() => expect(lines()).toHaveLength(1));
    // The bar has the one button; the old second button is gone.
    expect(screen.getAllByRole("button", { name: "字幕" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /次字幕/ })).toBeNull();
    fireEvent.click(screen.getByTestId("video-subtitles"));
    const groups = screen.getAllByRole("group").filter((node) => node.getAttribute("data-testid")?.startsWith("video-subtitles-group-"));
    expect(groups.map((group) => group.getAttribute("aria-labelledby") && document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent)).toEqual(["主字幕", "次字幕（显示在主字幕下方）"]);
    const itemsOf = (id: string) => within(screen.getByTestId(`video-subtitles-group-${id}`)).getAllByRole("menuitemradio").map((item) => [item.textContent, item.getAttribute("aria-checked")]);
    expect(itemsOf("primary")).toEqual([["关闭字幕", "false"], ["✓ chi", "true"], ["eng", "false"]]);
    expect(itemsOf("secondary")).toEqual([["✓ 关闭次字幕", "true"], ["chi", "false"], ["eng", "false"]]);
  });

  it("moves through both groups with the arrow keys as one list, and Home and End go to the first and the last (AT-107)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(SRT)));
    installHost({
      "video.subtitles": () => ({ subtitles: [srtTrack("s2", "chi"), srtTrack("s3", "eng", 3)] }),
      "video.subtitleHandle": (input) => srtHandle(String(input.trackId)),
    });
    await ready();
    at(1.5);
    await waitFor(() => expect(lines()).toHaveLength(1));
    fireEvent.click(screen.getByTestId("video-subtitles"));
    const focused = () => document.activeElement?.getAttribute("data-testid");
    // It opens on the first item of the first group; the arrows go down it, across the border, and the disabled item (the main track again) is skipped.
    await waitFor(() => expect(focused()).toBe("video-subtitles-off"));
    const menu = screen.getByRole("menu");
    const press = (key: string) => fireEvent.keyDown(document.activeElement ?? menu, { key });
    press("ArrowDown"); await waitFor(() => expect(focused()).toBe("video-subtitles-s2"));
    press("ArrowDown"); await waitFor(() => expect(focused()).toBe("video-subtitles-s3"));
    press("ArrowDown"); await waitFor(() => expect(focused()).toBe("video-subtitles-secondary-off"));
    press("ArrowDown"); await waitFor(() => expect(focused()).toBe("video-subtitles-secondary-s3"));
    press("ArrowDown"); await waitFor(() => expect(focused()).toBe("video-subtitles-off"));
    press("ArrowUp"); await waitFor(() => expect(focused()).toBe("video-subtitles-secondary-s3"));
    press("ArrowUp"); await waitFor(() => expect(focused()).toBe("video-subtitles-secondary-off"));
    press("ArrowUp"); await waitFor(() => expect(focused()).toBe("video-subtitles-s3"));
    press("Home"); await waitFor(() => expect(focused()).toBe("video-subtitles-off"));
    press("End"); await waitFor(() => expect(focused()).toBe("video-subtitles-secondary-s3"));
    // Escape closes it and gives the focus back to the button.
    press("Escape");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(focused()).toBe("video-subtitles");
  });

  it("shows the main subtitle alone, with no group titles, when no other track can be the second (AT-107)", async () => {
    // an ASS track and a bitmap track cannot be the second subtitle; one text track has nobody to pair with
    installHost({
      "video.subtitles": () => ({ subtitles: [{ ...srtTrack("s2", "chi"), format: "ass" }, { ...srtTrack("s3", "eng", 3), format: "ass" }] }),
    });
    await ready();
    fireEvent.click(screen.getByTestId("video-subtitles"));
    expect(screen.queryAllByRole("group").filter((node) => node.getAttribute("data-testid")?.startsWith("video-subtitles-group-"))).toHaveLength(0);
    expect(screen.queryByTestId("video-subtitles-secondary-off")).toBeNull();
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["关闭字幕", "✓ chi", "eng"]);
  });

  it("does not offer the one text track as its own second subtitle either (AT-107)", async () => {
    withSubtitle(SRT);
    installHost({
      "video.subtitles": () => ({ subtitles: [srtTrack("s2", "chi"), { ...srtTrack("s3", "eng", 3), format: null, codec: "hdmv_pgs_subtitle" }] }),
      "video.subtitleHandle": (input) => srtHandle(String(input.trackId)),
    });
    await ready();
    fireEvent.click(screen.getByTestId("video-subtitles"));
    expect(screen.queryByTestId("video-subtitles-group-secondary")).toBeNull();
    expect(screen.queryByTestId("video-subtitles-secondary-off")).toBeNull();
    expect(screen.getAllByRole("menuitemradio").map((item) => item.textContent)).toEqual(["关闭字幕", "✓ chi", "eng"]);
  });

  it("offers no second track when the file has only one text track", async () => {
    withSubtitle(SRT);
    await ready();
    openMore();
    await waitFor(() => expect(screen.getByTestId("video-subtitles")).toBeTruthy());
    expect(screen.queryByTestId("video-subtitles-secondary")).toBeNull();
  });

  it("tells the user a track could not be shown without stopping the video", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    installHost({
      "video.subtitles": () => ({ subtitles: [srtTrack("s2", "chi")] }),
      "video.subtitleHandle": () => srtHandle("s2"),
    });
    await ready();
    openMore();
    await waitFor(() => expect(screen.getByTestId("video-subtitle-notice").textContent).toContain("network down"));
    fireEvent.click(screen.getByTestId("video-toggle"));
    await waitFor(() => expect(media.state(element()).paused).toBe(false));
  });
});

describe("video player: a file that starts late", () => {
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
    await waitFor(() => expect(text("video-time")).toBe("0:00.000 / 0:10.000"));
    act(() => media.advance(element(), 5));
    await waitFor(() => expect(text("video-time")).toBe("0:05.000 / 0:10.000"));
  });

  it("moves the element by the file's own time plus the start, for keys, the timeline and typed times", async () => {
    late();
    await lateReady();
    openMore();
    fireEvent.click(screen.getByTestId("video-step-forward"));
    expect(media.state(element()).time).toBe(ORIGIN / 1000 + 5);
    fireEvent.click(screen.getByTestId("video-time"));
    fireEvent.change(screen.getByTestId("video-time-input"), { target: { value: "0:08" } });
    fireEvent.keyDown(screen.getByTestId("video-time-input"), { key: "Enter" });
    await waitFor(() => expect(media.state(element()).time).toBeGreaterThan(ORIGIN / 1000 + 8 - 0.05));
    expect(media.state(element()).time).toBeLessThan(ORIGIN / 1000 + 8.05);
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
    fireEvent.click(screen.getByTestId("video-time"));
    fireEvent.change(screen.getByTestId("video-time-input"), { target: { value: String(ptsOf(57) / 1000 + 0.005) } });
    fireEvent.keyDown(screen.getByTestId("video-time-input"), { key: "Enter" });
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

  it("shows a text subtitle by the file's time, not the element's", async () => {
    const srt = ["1", "00:00:01,000 --> 00:00:02,000", "你好"].join("\n");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(srt)));
    late({
      "video.subtitles": () => ({ subtitles: [{ id: "s2", source: "embedded", streamIndex: 2, codec: "subrip", format: "srt", language: "chi", title: null, default: false }] }),
      "video.subtitleHandle": () => ({ trackId: "s2", format: "srt", language: "chi", title: null, url: "manga-media://h/sub", handle: "s", mediaType: "application/x-subrip; charset=utf-8" }),
    });
    await lateReady();
    // The element's clock is 1.5 s while the file's is -1 s: the cue (1 to 2 s of the file) is not on yet.
    act(() => { media.state(element()).time = 1.5; media.advance(element(), 0); });
    await waitFor(() => expect(screen.getByTestId("video-reader").getAttribute("data-ready")).toBe("true"));
    expect(screen.queryAllByTestId("subtitle-line")).toHaveLength(0);
    act(() => { media.state(element()).time = 1.5 + ORIGIN / 1000; media.advance(element(), 0); });
    await waitFor(() => expect(screen.getByTestId("subtitle-line").textContent).toBe("你好"));
    act(() => { media.state(element()).time = 2.5 + ORIGIN / 1000; media.advance(element(), 0); });
    await waitFor(() => expect(screen.queryAllByTestId("subtitle-line")).toHaveLength(0));
    vi.unstubAllGlobals();
  });
});

describe("video player: keys come from the key table (AT-90)", () => {
  it("answers to the person's own keys, and no longer to the key they replaced", async () => {
    const keys = resolveKeys({ "video.customRate": ["Y"], "video.mute": ["N"] });
    const { handlers } = await ready({}, 120, (node) => <KeyTableProvider value={keys}>{node}</KeyTableProvider>);
    fireEvent.keyDown(window, { key: "r" });
    fireEvent.keyDown(window, { key: "m" });
    expect(handlers.onSettings).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "y" });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ rate: 1.5 });
    fireEvent.keyDown(window, { key: "n" });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ muted: true });
    // A key the person did not change keeps its action.
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ volume: 0.55, muted: false });
    installMatchMedia({ reducedMotion: false });
  });
});

describe("video player: the frame table is built when a step asks for it (AT-80)", () => {
  /** A host whose frame table does not exist until a call without `build: false` makes it. */
  function lazyHost(options: { slow?: boolean } = {}) {
    const state = { built: false, release: () => undefined as void };
    const gate = options.slow ? new Promise<void>((resolve) => { state.release = resolve; }) : Promise.resolve();
    const host = installHost({
      "video.frameIndex": async (input) => {
        if (!state.built) {
          if (input.build === false) return { revisionId: "rev_v", ready: false, state: "absent" };
          await gate;
          state.built = true;
        }
        const frame = typeof input.frame === "number" ? input.frame : Math.min(FRAMES - 1, Math.floor(((input.timeMs as number) + 0.5) / (1000 / FPS)));
        const at = Math.max(0, Math.min(FRAMES - 1, frame + ((input.delta as number | undefined) ?? 0)));
        return { revisionId: "rev_v", ready: true, frame: at, ptsMs: ptsOf(at), totalFrames: FRAMES, durationMs: 120_000, variableFrameRate: false, previousMs: at > 0 ? ptsOf(at - 1) : null, nextMs: at + 1 < FRAMES ? ptsOf(at + 1) : null };
      },
    });
    return { ...host, state };
  }
  const asked = (host: ReturnType<typeof lazyHost>) => host.of("video.frameIndex");
  const builds = (host: ReturnType<typeof lazyHost>) => asked(host).filter((call) => call.input.build !== false);

  it("does not ask for a build when the video opens or pauses, and says the number comes with the first step", async () => {
    const host = lazyHost();
    await ready();
    await waitFor(() => expect(text("video-frame")).toBe("逐帧时计算帧号"));
    fireEvent.click(screen.getByTestId("video-toggle"));
    await waitFor(() => expect(media.state(element()).paused).toBe(false));
    fireEvent.click(screen.getByTestId("video-toggle"));
    await waitFor(() => expect(media.state(element()).paused).toBe(true));
    await waitFor(() => expect(text("video-frame")).toBe("逐帧时计算帧号"));
    expect(asked(host).length).toBeGreaterThan(0);
    expect(builds(host)).toEqual([]);
    expect(host.state.built).toBe(false);
  });

  it("goes to a typed time at once while no table exists, and never builds one for it", async () => {
    const host = lazyHost();
    await ready();
    fireEvent.click(screen.getByTestId("video-time"));
    fireEvent.change(screen.getByTestId("video-time-input"), { target: { value: "1:23.456" } });
    fireEvent.keyDown(screen.getByTestId("video-time-input"), { key: "Enter" });
    await waitFor(() => expect(media.state(element()).time).toBeCloseTo(83.456, 3));
    expect(screen.queryByTestId("video-input-error")).toBeNull();
    expect(builds(host)).toEqual([]);
  });

  it("builds the table at the first frame step, shows that it is working, and lands on the frame", async () => {
    const host = lazyHost({ slow: true });
    await ready();
    openMore();
    fireEvent.click(screen.getByTestId("video-next-frame"));
    await waitFor(() => expect(text("video-frame")).toBe("帧号计算中…"));
    expect(builds(host)).toHaveLength(1);
    // A typed time while the table is being built does not wait for it.
    fireEvent.click(screen.getByTestId("video-time"));
    fireEvent.change(screen.getByTestId("video-time-input"), { target: { value: "30" } });
    fireEvent.keyDown(screen.getByTestId("video-time-input"), { key: "Enter" });
    host.state.release();
    await waitFor(() => expect(text("video-frame")).toMatch(/^第 \d+ \/ 2880 帧$/));
    expect(host.state.built).toBe(true);
    // From now on the table answers the cheap question too.
    fireEvent.keyDown(window, { key: "." });
    await waitFor(() => expect(builds(host).length).toBeGreaterThanOrEqual(2));
  });

  it("stops a table that is still being built when the player goes away", async () => {
    const host = lazyHost({ slow: true });
    const view = await ready();
    openMore();
    fireEvent.click(screen.getByTestId("video-next-frame"));
    await waitFor(() => expect(builds(host)).toHaveLength(1));
    view.unmount();
    await waitFor(() => expect(host.of("video.cancelFrameIndex")).toHaveLength(1));
    expect(host.of("video.cancelFrameIndex")[0]!.input).toMatchObject({ resourceId: "res_v", revisionId: "rev_v" });
  });

  it("asks for no cancel when nothing was being built", async () => {
    const host = lazyHost();
    const view = await ready();
    view.unmount();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(host.of("video.cancelFrameIndex")).toEqual([]);
  });
});

describe("video player controls (AT-83)", () => {
  it("has no bar at the top and no next-episode button: the title and the way back are the title bar's, the rest is in the controls", async () => {
    const { container, handlers } = await ready({ onMatch: vi.fn(), next: { resourceId: "res_v2", title: "第 2 话" } });
    expect(container.querySelector(".reader-top")).toBeNull();
    for (const gone of ["video-back", "video-title", "video-episode", "video-next", "video-end-next"]) expect(screen.queryByTestId(gone), gone).toBeNull();
    const controls = screen.getByTestId("video-controls");
    expect(screen.queryByTestId("reader-match")).toBeNull();
    openMore();
    expect(controls.contains(screen.getByTestId("reader-match"))).toBe(true);
    // Nothing in the player goes to another episode by itself unless "play the next one" is on; the episode list is the way.
    expect(handlers.onNext).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("video-episodes"));
    fireEvent.click(screen.getByTestId("video-episodes-res_v2"));
    expect(handlers.onEpisode).toHaveBeenCalledWith("res_v2");
  });

  it("keeps the picture's size when the controls come over it in full screen, and lifts only the dialogue above them (AT-89)", async () => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: HTMLElement) { return this.dataset.testid === "video-controls" ? 84 : 0; } });
    try {
      const full = (node: ReactNode) => <WindowFullscreenProvider value={{ active: true, toggle: () => undefined, exit: () => undefined }}>{node}</WindowFullscreenProvider>;
      await ready({}, 120, full);
      // The stage is not padded for the bar, so the picture keeps the size it has with the bar hidden; the subtitle layer is told how far to lift.
      expect(screen.getByTestId("video-stage").style.paddingBottom).toBe("");
      expect(screen.getByTestId("subtitle-layer").getAttribute("data-lift")).toBe("84");
      expect(screen.getByTestId("video-shell").style.getPropertyValue("--video-controls-h")).toBe("");
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    }
  });

  it("lifts nothing when the controls are below the picture and not over it", async () => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get(this: HTMLElement) { return this.dataset.testid === "video-controls" ? 84 : 0; } });
    try {
      await ready();
      expect(screen.getByTestId("subtitle-layer").getAttribute("data-lift")).toBeNull();
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    }
  });
});

describe("video player: a picture that is not there (AT-84)", () => {
  /** Half a second of the page's time with the video playing: the clock moves by as much, and the decoder presents `frames` frames. */
  const beat = (seconds: number, frames: number) => act(() => {
    media.advance(element(), seconds);
    media.decode(element(), frames);
    vi.advanceTimersByTime(seconds * 1000);
  });

  it("says nothing while frames arrive", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await ready();
    media.decode(element(), 1);
    fireEvent.click(screen.getByTestId("video-toggle"));
    for (let count = 0; count < 10; count += 1) beat(0.5, 12);
    expect(screen.queryByTestId("video-health")).toBeNull();
  });

  it("says so when the file is open and no frame was ever presented, and offers a play copy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const host = installHost({ "video.playCopy": () => ({ copy: { id: "copy1", revisionId: "rev_v", reason: "unsupported_video", state: "running", audioStreamIndex: 1, progress: 0, bytes: null, encoder: null, error: null, timestampCheck: null, createdAt: "x" } }) });
    await ready();
    act(() => { vi.advanceTimersByTime(1500); });
    expect(screen.queryByTestId("video-health")).toBeNull();
    act(() => { vi.advanceTimersByTime(1500); });
    const banner = screen.getByTestId("video-health");
    expect(banner.getAttribute("data-state")).toBe("no-first-frame");
    expect(banner.textContent).toContain("第一帧");
    expect(banner.textContent).toContain("原文件不会被改动");
    fireEvent.click(screen.getByTestId("video-health-copy"));
    await waitFor(() => expect(host.of("video.playCopy").some((call) => call.input.action === "create")).toBe(true));
    expect(host.of("video.playCopy").find((call) => call.input.action === "create")!.input).toMatchObject({ resourceId: "res_v", reason: "unsupported_video" });
  });

  it("says so when the clock and the sound go on and the frames stop, and goes away once frames come again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await ready();
    media.decode(element(), 1);
    fireEvent.click(screen.getByTestId("video-toggle"));
    for (let count = 0; count < 7; count += 1) beat(0.5, 0);
    const banner = screen.getByTestId("video-health");
    expect(banner.getAttribute("data-state")).toBe("no-frames");
    expect(banner.textContent).toContain("没有画面");
    for (let count = 0; count < 5; count += 1) beat(0.5, 12);
    expect(screen.queryByTestId("video-health")).toBeNull();
  });

  it("can be set aside, and comes back for the next file", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { rerender, handlers } = await ready();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId("video-health")).toBeTruthy();
    fireEvent.click(screen.getByTestId("video-health-dismiss"));
    expect(screen.queryByTestId("video-health")).toBeNull();
    rerender(<VideoPlayer t={i18n.t} doc={{ ...baseDoc, resourceId: "res_v2", revisionId: "rev_v2" }} settings={baseSettings} {...handlers} />);
    await waitFor(() => expect(element().getAttribute("src")).toBeTruthy());
  });

  it("offers a retry and no new copy when the picture is missing from a play copy already", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const copy = { id: "copy1", revisionId: "rev_v", reason: "no_hardware_hevc", state: "ready", audioStreamIndex: 1, progress: 1, bytes: 10, encoder: "libx264", error: null, timestampCheck: null, createdAt: "x" };
    const host = installHost({ "video.playbackPlan": () => ({ ...plan("play_copy", { reasons: ["no_hardware_hevc"], copy: { reason: "no_hardware_hevc", video: "encode", audio: "copy" } }), copy }) });
    await ready();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByTestId("video-health").textContent).toContain("播放副本");
    expect(screen.queryByTestId("video-health-copy")).toBeNull();
    const planned = host.of("video.playbackPlan").length;
    fireEvent.click(screen.getByTestId("video-health-retry"));
    await waitFor(() => expect(host.of("video.playbackPlan").length).toBe(planned + 1));
  });

  it("keeps the facts of the picture for the debug panel: how the file plays, the element's counters, and the subtitle renderer", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    videoFacts.reset();
    await ready();
    media.decode(element(), 25);
    act(() => { vi.advanceTimersByTime(1200); });
    expect(videoFacts.get()).toMatchObject({ resourceId: "res_v", playing: "original", decision: "direct", reasons: [], decodedFrames: 25, health: "ok", subtitleRenderer: "none", missingFonts: [] });
    act(() => { vi.advanceTimersByTime(3000); });
    expect(videoFacts.get()).toMatchObject({ decodedFrames: 25 });
    cleanup();
    expect(videoFacts.get()).toBeNull();
  });
});

describe("video player: ASS subtitles and their fonts (AT-84)", () => {
  const ASS = [
    "[Script Info]", "ScriptType: v4.00+", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour",
    "Style: Default,Arial,28,&H00FFFFFF",
    "Style: Sign,Missing Face,36,&H0000FFFF",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,汉字显示",
  ].join("\n");
  const assTrack = { id: "s2", source: "embedded", streamIndex: 2, codec: "ass", format: "ass", language: "chi", title: null, default: true };
  const carried = { id: "f1", fileName: "arial.ttf", mediaType: "font/ttf", url: "manga-media://h/f1", families: ["arial"] };
  const bundled = { family: "Noto Sans SC", mediaType: "font/otf", url: "manga-media://h/fallback" };

  const withAss = (fonts: Record<string, unknown>) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(ASS)));
    installHost({
      "video.subtitles": () => ({ subtitles: [assTrack] }),
      "video.subtitleHandle": () => ({ trackId: "s2", format: "ass", language: "chi", title: null, url: "manga-media://h/s2", handle: "s", mediaType: "text/x-ssa" }),
      "video.fonts": () => fonts,
    });
  };
  const machineHas = (...families: string[]) => {
    (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts = async () => families.map((family) => ({ family }));
  };
  beforeEach(() => { jassub.made.length = 0; jassub.destroyed = 0; jassub.drawn.length = 0; resetInstalledFamilies(); videoFacts.reset(); });
  afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(window, "queryLocalFonts"); resetInstalledFamilies(); });

  it("draws with a font that has Chinese and Japanese glyphs by default: the bundled one when the machine has none of the usual ones", async () => {
    machineHas("Arial", "Consolas");
    withAss({ fonts: [carried], fallback: bundled });
    await ready();
    await waitFor(() => expect(jassub.made).toHaveLength(1));
    const options = jassub.made[0]!;
    expect(options.defaultFont).toBe("noto sans sc");
    expect(options.availableFonts).toEqual({ "noto sans sc": bundled.url });
    // The video's own font first, then the fallback, both loaded as the renderer starts.
    expect(options.fonts).toEqual([carried.url, bundled.url]);
    expect(options.queryFonts).toBe("local");
    expect(options.subContent).toBe(ASS);
  });

  it("draws the frame that is on screen once the renderer is ready, so a paused picture shows its subtitle without waiting for the next frame", async () => {
    machineHas("Arial");
    withAss({ fonts: [carried], fallback: bundled });
    await ready();
    await waitFor(() => expect(jassub.drawn).toHaveLength(1));
    expect(jassub.drawn[0]).toEqual({ frame: expect.objectContaining({ mediaTime: 0, width: 1920, height: 1080 }), repaint: true });
  });

  it("uses the bundled font as the default even when the machine has a Chinese one: a machine font is read after the first frame, which is then not drawn again", async () => {
    machineHas("Arial", "SimHei", "Microsoft YaHei");
    withAss({ fonts: [carried], fallback: bundled });
    await ready();
    await waitFor(() => expect(jassub.made).toHaveLength(1));
    expect(jassub.made[0]!.defaultFont).toBe("noto sans sc");
    expect(jassub.made[0]!.fonts).toEqual([carried.url, bundled.url]);
    expect(jassub.made[0]!.availableFonts).toEqual({ "noto sans sc": bundled.url });
  });

  it("takes a Chinese font the machine has, in the order Microsoft YaHei, SimHei, only when the app has no bundled font, and only when the window may read it", async () => {
    machineHas("Arial", "SimHei", "Microsoft YaHei");
    withAss({ fonts: [carried], fallback: null });
    await ready();
    await waitFor(() => expect(jassub.made).toHaveLength(1));
    expect(jassub.made[0]!.defaultFont).toBe("microsoft yahei");
    expect(jassub.made[0]!.fonts).toEqual([carried.url]);
    expect(jassub.made[0]!.availableFonts).toEqual({});
    // The window may list fonts but not read them: the machine's font is not taken as the default, and the renderer keeps its own.
    cleanup();
    jassub.made.length = 0;
    resetInstalledFamilies();
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { permissions: { query: async () => ({ state: "prompt" }) } }));
    withAss({ fonts: [carried], fallback: null });
    await ready();
    await waitFor(() => expect(jassub.made).toHaveLength(1));
    expect("defaultFont" in jassub.made[0]!).toBe(false);
    // And with the permission granted it is taken.
    vi.unstubAllGlobals();
    cleanup();
    jassub.made.length = 0;
    resetInstalledFamilies();
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { permissions: { query: async () => ({ state: "granted" }) } }));
    withAss({ fonts: [carried], fallback: null });
    await ready();
    await waitFor(() => expect(jassub.made).toHaveLength(1));
    expect(jassub.made[0]!.defaultFont).toBe("microsoft yahei");
  });

  it("uses the bundled font when the machine's fonts cannot be listed, and leaves the renderer's own default only when the app has none", async () => {
    withAss({ fonts: [], fallback: bundled });
    await ready();
    await waitFor(() => expect(jassub.made).toHaveLength(1));
    expect(jassub.made[0]!.defaultFont).toBe("noto sans sc");
    cleanup();
    jassub.made.length = 0;
    resetInstalledFamilies();
    withAss({ fonts: [], fallback: null });
    await ready();
    await waitFor(() => expect(jassub.made).toHaveLength(1));
    expect("defaultFont" in jassub.made[0]!).toBe(false);
    expect(jassub.made[0]!.fonts).toEqual([]);
  });

  it("records for the debug panel which fonts the styles ask for that neither the video nor the machine has", async () => {
    machineHas("Arial", "Consolas");
    withAss({ fonts: [carried], fallback: bundled });
    await ready();
    await waitFor(() => expect(videoFacts.get()?.subtitleRenderer).toBe("jassub"));
    await waitFor(() => expect(videoFacts.get()?.subtitleStatus).toBe("ready"));
    // "arial" is carried by the video; "missing face" is nowhere.
    expect(videoFacts.get()).toMatchObject({ missingFonts: ["missing face"], defaultFont: "bundled:noto sans sc" });
  });
});

describe("video player: the volume popup (AT-89)", () => {
  it("opens as a popup on the top layer above its button, takes five percent from the wheel over the button or the slider, and closes with Esc or a click outside", async () => {
    const { handlers } = await ready();
    const button = screen.getByTestId("video-volume-button");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    const pop = screen.getByTestId("video-volume-pop");
    // The browser's own popover (the top layer), placed above the button by anchor positioning, not a box inside the bar that the bar could clip.
    expect(pop.getAttribute("popover")).toBe("manual");
    expect(pop.getAttribute("data-placement")).toBe("above");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("video-volume-value").textContent).toBe("50");
    fireEvent.wheel(button, { deltaY: -100 });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ volume: 0.55, muted: false });
    fireEvent.wheel(screen.getByTestId("video-volume"), { deltaY: 100 });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ volume: 0.45, muted: false });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("video-volume-pop")).toBeNull();
    fireEvent.click(button);
    expect(screen.getByTestId("video-volume-pop")).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId("video-stage"));
    expect(screen.queryByTestId("video-volume-pop")).toBeNull();
    // A click inside the popup does not close it.
    fireEvent.click(button);
    fireEvent.mouseDown(screen.getByTestId("video-volume"));
    expect(screen.getByTestId("video-volume-pop")).toBeTruthy();
  });

  it("stops a wheel at 0 and 100 percent, and starts from 0 when the sound is muted", async () => {
    const { handlers, rerender } = await ready({ settings: { ...baseSettings, volume: 1 } });
    fireEvent.click(screen.getByTestId("video-volume-button"));
    handlers.onSettings.mockClear();
    fireEvent.wheel(screen.getByTestId("video-volume"), { deltaY: -100 });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ volume: 1, muted: false });
    rerender(<VideoPlayer t={i18n.t} doc={baseDoc} settings={{ ...baseSettings, volume: 0.6, muted: true }} {...handlers} />);
    expect(screen.getByTestId("video-volume-value").textContent).toBe("0");
    fireEvent.wheel(screen.getByTestId("video-volume"), { deltaY: -100 });
    expect(handlers.onSettings).toHaveBeenLastCalledWith({ volume: 0.05, muted: false });
  });
});

describe("video player: subtitles in a screenshot (AT-109)", () => {
  const SRT = ["1", "00:00:01,000 --> 00:00:02,000", "你好", "", "2", "00:00:03,000 --> 00:00:04,000", "再见"].join("\n");
  const ENGLISH = ["1", "00:00:01,000 --> 00:00:02,000", "Hello", ""].join("\n");
  const ASS = [
    "[Script Info]", "PlayResX: 384", "PlayResY: 288", "", "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, OutlineColour, Bold, Italic, ScaleX, ScaleY, Spacing, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV",
    "Style: Default,Arial,20,&H00FFFFFF,&H00000000,0,0,100,100,0,1,1,0,2,10,10,10", "", "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    "Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,汉字显示",
  ].join("\n");
  const textTrack = (id: string, language: string, index = 2) => ({ id, source: "embedded", streamIndex: index, codec: "subrip", format: "srt", language, title: null, default: false });
  const assTrack = { id: "s2", source: "embedded", streamIndex: 2, codec: "ass", format: "ass", language: "chi", title: null, default: true };
  const handleOf = (trackId: string, format = "srt") => ({ trackId, format, language: null, title: null, url: `manga-media://h/${trackId}`, handle: "s", mediaType: "text/plain" });
  const at = (seconds: number) => act(() => { media.state(element()).time = seconds; media.advance(element(), 0); });
  const lines = () => screen.queryAllByTestId("subtitle-line");
  let capture: ReturnType<typeof installCapture>;
  let port: { save: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> };

  /** One or two text tracks; the second is English. */
  function withText(tracks: Array<ReturnType<typeof textTrack>>) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(String(url).endsWith("s3") ? ENGLISH : SRT)));
    installHost({ "video.subtitles": () => ({ subtitles: tracks }), "video.subtitleHandle": (input) => handleOf(String(input.trackId)) });
  }
  function withAss() {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(ASS)));
    installHost({ "video.subtitles": () => ({ subtitles: [assTrack] }), "video.subtitleHandle": () => handleOf("s2", "ass"), "video.fonts": () => ({ fonts: [], fallback: null }) });
  }
  async function shoot() {
    fireEvent.click(screen.getByTestId("video-screenshot"));
    await waitFor(() => expect(port.save).toHaveBeenCalledTimes(1));
    return port.save.mock.calls[0]![0] as { data: string; video: Record<string, unknown> };
  }
  const drawnLines = () => capture.texts.filter((item) => item.op === "fill").map((item) => item.text);

  beforeEach(() => {
    capture = installCapture({ video: { w: 1920, h: 1080 } });
    port = { save: vi.fn(async () => true), fail: vi.fn() };
    jassub.made.length = 0; jassub.destroyed = 0; jassub.drawn.length = 0; jassub.resized.length = 0; jassub.ink = true;
    resetInstalledFamilies();
  });
  afterEach(() => { capture.restore(); vi.unstubAllGlobals(); resetInstalledFamilies(); });

  it("draws the subtitle on screen into the picture, at the size of the file, and writes the same text into the record", async () => {
    withText([textTrack("s2", "chi")]);
    await ready({ screenshots: port });
    at(1.5);
    await waitFor(() => expect(lines().map((line) => line.textContent)).toEqual(["你好"]));
    const saved = await shoot();
    expect(saved.video).toMatchObject({ positionMs: 1500, subtitleTrackId: "s2", subtitleText: "你好", composited: "subtitles" });
    // What the picture carries is what the record says, and what the screen showed.
    expect(drawnLines()).toEqual(["你好"]);
    expect(capture.texts.every((item) => item.width === 1920 && item.height === 1080)).toBe(true);
  });

  it("draws the second track under the first and records both texts and the second track", async () => {
    withText([textTrack("s2", "chi"), textTrack("s3", "eng", 3)]);
    await ready({ screenshots: port });
    fireEvent.click(screen.getByTestId("video-subtitles"));
    fireEvent.click(screen.getByTestId("video-subtitles-secondary-s3"));
    at(1.5);
    await waitFor(() => expect(lines().map((line) => line.textContent)).toEqual(["你好", "Hello"]));
    const saved = await shoot();
    expect(saved.video).toMatchObject({ subtitleText: "你好", subtitleSecondaryText: "Hello", subtitleSecondaryTrack: "eng", composited: "subtitles" });
    // The second track's line is the lower one, as on screen; lines are drawn from the bottom up.
    expect(drawnLines()).toEqual(["Hello", "你好"]);
  });

  it("with the setting off, leaves the subtitles out of the picture and still records the text, saying nothing was drawn", async () => {
    withText([textTrack("s2", "chi"), textTrack("s3", "eng", 3)]);
    await ready({ screenshots: port, settings: { ...baseSettings, shotSubtitles: false } });
    fireEvent.click(screen.getByTestId("video-subtitles"));
    fireEvent.click(screen.getByTestId("video-subtitles-secondary-s3"));
    at(1.5);
    await waitFor(() => expect(lines()).toHaveLength(2));
    const saved = await shoot();
    expect(saved.video).toMatchObject({ subtitleText: "你好", subtitleSecondaryText: "Hello", composited: "none" });
    expect(capture.texts).toHaveLength(0);
  });

  it("records no text and draws nothing when no cue shows at that moment", async () => {
    withText([textTrack("s2", "chi")]);
    await ready({ screenshots: port });
    at(2.5);
    await waitFor(() => expect(lines()).toHaveLength(0));
    const saved = await shoot();
    expect(saved.video.subtitleText).toBeUndefined();
    expect(saved.video.composited).toBe("none");
    expect(capture.texts).toHaveLength(0);
  });

  it("draws an ASS subtitle from the renderer at the size of the file, then lets the renderer go back to the size on screen", async () => {
    withAss();
    await ready({ screenshots: port });
    await waitFor(() => expect(jassub.made).toHaveLength(1));
    const saved = await shoot();
    expect(jassub.resized[0]).toEqual({ force: true, w: 1920, h: 1080 });
    expect(jassub.resized.at(-1)).toEqual({ force: true, w: undefined, h: undefined });
    // The renderer's canvas, redrawn at the file's size, is laid over the frame.
    const overlay = capture.draws.map((draw) => draw.args[0] as { width?: number; __ink?: boolean }).filter((source) => source?.width === 1920 && source.__ink);
    expect(overlay.length).toBeGreaterThan(0);
    expect(saved.video).toMatchObject({ subtitleTrackId: "s2", composited: "subtitles" });
    // The page cannot read the words out of the renderer: the app reads the line from the track at that position.
    expect(saved.video.subtitleText).toBeUndefined();
  });

  it("does not claim subtitles were drawn when the ASS track shows nothing at that moment", async () => {
    jassub.ink = false;
    withAss();
    await ready({ screenshots: port });
    await waitFor(() => expect(jassub.made).toHaveLength(1));
    const saved = await shoot();
    expect(saved.video.composited).toBe("none");
  });

  it("does not ask the ASS renderer for anything when the setting is off", async () => {
    withAss();
    await ready({ screenshots: port, settings: { ...baseSettings, shotSubtitles: false } });
    await waitFor(() => expect(jassub.made).toHaveLength(1));
    const saved = await shoot();
    expect(jassub.resized).toHaveLength(0);
    expect(saved.video.composited).toBe("none");
  });
});
