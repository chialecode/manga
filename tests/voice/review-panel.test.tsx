/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { RecordingReview } from "../../apps/desktop/src/renderer/voice/review-panel.tsx";

const i18n = createTranslator("zh-CN");

type Call = { commandId: string; input: Record<string, unknown> };

const textAnchor = { startMs: 0, endMs: 4000, resourceId: "res_n", resourceRevisionId: "rev_n", locator: { kind: "text", partId: "part_1", range: { start: 10, end: 20 } } };
const videoAnchor = { startMs: 5000, endMs: 9000, resourceId: "res_v", resourceRevisionId: "rev_v", locator: { kind: "temporal", startMs: 61_000, endMs: 64_000 } };

const session = (patch: Record<string, unknown> = {}) => ({
  id: "cap_1", mode: "toggle", retention: "keep", stage: "done", audioState: "retained", playable: true, durationMs: 20_000,
  createdAt: "2026-10-01T08:00:00.000Z", workId: "work_1", resourceId: "res_n", error: null,
  segments: { total: 3, done: 2, failed: 1, pending: 0, noSpeech: 0 }, speechMs: 9000, ...patch,
});

function makeReview(patch: { session?: Record<string, unknown>; segments?: unknown[]; drafts?: unknown[] } = {}) {
  return {
    session: session(patch.session),
    segments: patch.segments ?? [
      { id: "seg_1", seq: 0, startMs: 0, endMs: 4000, text: "这一话的伏笔很妙", originalText: "这一话的伏笔很妙", revised: false, state: "done", precision: "segment", calibrated: false, anchors: [textAnchor], attempts: 1, error: null },
      { id: "seg_2", seq: 1, startMs: 5000, endMs: 9000, text: "主角的表情", originalText: "主角的表情", revised: false, state: "done", precision: "chunk", calibrated: false, anchors: [videoAnchor], attempts: 1, error: null },
      { id: "seg_3", seq: 2, startMs: 12_000, endMs: 15_000, text: "", originalText: "", revised: false, state: "failed", precision: "chunk", calibrated: false, anchors: [], attempts: 3, error: { code: "ASR_FAILED", message: "服务无响应" } },
    ],
    filtered: [{ startMs: 4000, endMs: 5000 }, { startMs: 9000, endMs: 12_000 }],
    drafts: patch.drafts ?? [],
    audio: { state: "retained", playable: true },
  };
}

function installHost(state: { review: ReturnType<typeof makeReview>; sessions?: unknown[]; fail?: Record<string, string> }) {
  const calls: Call[] = [];
  const listeners = new Set<(notice: { topic: string; payload: Record<string, unknown> }) => void>();
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input?: Record<string, unknown> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      const failure = state.fail?.[payload.commandId];
      if (failure) return { status: "error", error: { code: "INTERNAL", message: failure } };
      switch (payload.commandId) {
        case "capture.list": return { status: "ok", value: { sessions: state.sessions ?? [state.review.session] } };
        case "capture.review": return { status: "ok", value: state.review };
        case "capture.audioHandle": return { status: "ok", value: { url: "manga-media://h/audio", mediaType: "audio/wav", durationMs: 20_000 } };
        case "capture.acceptDraft": return { status: "ok", value: { objectId: "note_1" } };
        default: return { status: "ok", value: {} };
      }
    },
    onNotice: (listener: (notice: { topic: string; payload: Record<string, unknown> }) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { calls, of: (id: string) => calls.filter((call) => call.commandId === id), notice: (topic: string, payload: Record<string, unknown> = {}) => act(() => { for (const listener of listeners) listener({ topic, payload }); }) };
}

const noop = () => undefined;
const props = (extra: Partial<Parameters<typeof RecordingReview>[0]> = {}) => ({ t: i18n.t, scope: { workId: "work_1" }, onJump: noop, onOpenNote: noop, formatDate: () => "10月1日 08:00", ...extra });

beforeEach(() => {
  window.HTMLMediaElement.prototype.play = vi.fn(async function play(this: HTMLMediaElement) { this.dispatchEvent(new Event("play")); });
  window.HTMLMediaElement.prototype.pause = vi.fn(function pause(this: HTMLMediaElement) { this.dispatchEvent(new Event("pause")); });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("recording list", () => {
  it("lists the recordings with their state, audio state and progress", async () => {
    installHost({ review: makeReview(), sessions: [session(), session({ id: "cap_2", stage: "awaiting_asr", audioState: "staged", segments: { total: 0, done: 0, failed: 0, pending: 0, noSpeech: 0 } })] });
    render(<RecordingReview {...props()} />);
    await waitFor(() => expect(screen.getByTestId("review-session-cap_1")).toBeTruthy());
    expect(screen.getByTestId("review-stage-cap_1").textContent).toBe("已完成");
    expect(screen.getByTestId("review-session-cap_1").textContent).toContain("2/3 段已转写");
    expect(screen.getByTestId("review-stage-cap_2").textContent).toBe("待转写");
    expect(screen.getByTestId("review-session-cap_2").textContent).toContain("音频暂存，等待处理");
  });

  it("says so when there are none, and when the list cannot be read", async () => {
    const host = installHost({ review: makeReview(), sessions: [] });
    const { unmount } = render(<RecordingReview {...props()} />);
    await waitFor(() => expect(screen.getByTestId("review-empty")).toBeTruthy());
    unmount();
    host.calls.length = 0;
    installHost({ review: makeReview(), fail: { "capture.list": "数据库忙" } });
    render(<RecordingReview {...props()} />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("数据库忙"));
  });

  it("reloads when a recording changes", async () => {
    const host = installHost({ review: makeReview(), sessions: [] });
    render(<RecordingReview {...props()} />);
    await waitFor(() => expect(screen.getByTestId("review-empty")).toBeTruthy());
    const before = host.of("capture.list").length;
    await host.notice("capture.changed", { sessionId: "cap_1" });
    await waitFor(() => expect(host.of("capture.list").length).toBeGreaterThan(before));
  });
});

describe("recording review", () => {
  async function open(patch: Parameters<typeof makeReview>[0] = {}, extra: Partial<Parameters<typeof RecordingReview>[0]> = {}) {
    const state = { review: makeReview(patch) };
    const host = installHost(state);
    render(<RecordingReview {...props({ initialSessionId: "cap_1", ...extra })} />);
    await waitFor(() => expect(screen.getByTestId("review-session")).toBeTruthy());
    return { host, state };
  }

  it("shows the transcript as bubbles in time order with their precision, the filtered gaps and the timeline", async () => {
    await open();
    const items = screen.getByTestId("review-items");
    const order = Array.from(items.children).map((node) => node.getAttribute("data-testid"));
    expect(order).toEqual(["review-segment-seg_1", "review-gap", "review-segment-seg_2", "review-gap", "review-segment-seg_3"]);
    expect(screen.getByTestId("review-text-seg_1").textContent).toBe("这一话的伏笔很妙");
    expect(screen.getByTestId("review-precision-seg_1").textContent).toBe("按句定位");
    expect(screen.getByTestId("review-precision-seg_2").textContent).toBe("粗定位，待校准");
    expect(screen.getAllByTestId("review-gap")[0]!.textContent).toContain("无人声");
    expect(screen.getByTestId("review-segment-state-seg_3").textContent).toBe("转写失败");
    expect(within(screen.getByTestId("review-segment-seg_3")).getByRole("alert").textContent).toContain("服务无响应");
    // The timeline has one button per segment, reachable by name.
    expect(screen.getByTestId("review-bar-seg_2").getAttribute("aria-label")).toContain("片段 2");
    fireEvent.click(screen.getByTestId("review-bar-seg_2"));
    expect(screen.getByTestId("review-segment-seg_2").hasAttribute("data-active")).toBe(true);
  });

  it("plays one segment's interval from the kept audio and stops at its end", async () => {
    const { host } = await open();
    const audio = screen.getByTestId("review-audio") as HTMLAudioElement;
    fireEvent.click(screen.getByTestId("review-play-seg_2"));
    await waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled());
    expect(host.of("capture.audioHandle")).toHaveLength(1);
    expect(audio.getAttribute("src")).toBe("manga-media://h/audio");
    expect(audio.currentTime).toBe(5);
    expect(screen.getByTestId("review-play-seg_2").getAttribute("aria-pressed")).toBe("true");
    // The clock passes the end of the segment: playback pauses by itself.
    audio.currentTime = 9.2;
    fireEvent(audio, new Event("timeupdate"));
    await waitFor(() => expect(screen.getByTestId("review-play-seg_2").getAttribute("aria-pressed")).toBe("false"));
    // A second play does not fetch the handle again.
    fireEvent.click(screen.getByTestId("review-play-seg_1"));
    await waitFor(() => expect(screen.getByTestId("review-play-seg_1").getAttribute("aria-pressed")).toBe("true"));
    expect(host.of("capture.audioHandle")).toHaveLength(1);
  });

  it("explains that cleaned audio cannot be played", async () => {
    await open({ session: { playable: false, audioState: "cleaned" } });
    expect(screen.getByTestId("review-no-play-seg_1").textContent).toBe("音频已清理，不可回放");
    expect(screen.queryByTestId("review-play-seg_1")).toBeNull();
    expect(screen.getByTestId("review-audio-state").textContent).toBe("已清理，不可回放");
  });

  it("jumps to each kind of source and says when there is none", async () => {
    const jumps: unknown[] = [];
    await open({}, { onJump: (anchor) => jumps.push(anchor) });
    fireEvent.click(screen.getByTestId("review-jump-seg_1-0"));
    fireEvent.click(screen.getByTestId("review-jump-seg_2-0"));
    expect(jumps).toEqual([textAnchor, videoAnchor]);
    expect(screen.getByTestId("review-jump-seg_2-0").textContent).toContain("视频 1:01");
    expect(within(screen.getByTestId("review-segment-seg_3")).getByText("没有记录来源")).toBeTruthy();
  });

  it("revises the text without losing the original, and keeps a term for the work", async () => {
    const { host } = await open();
    fireEvent.click(screen.getByTestId("review-revise-seg_2"));
    fireEvent.change(screen.getByTestId("review-edit-seg_2"), { target: { value: "主角的表情很克制" } });
    fireEvent.change(screen.getByTestId("review-term-seg_2"), { target: { value: "克制" } });
    fireEvent.change(screen.getByTestId("review-heard-seg_2"), { target: { value: "刻志" } });
    fireEvent.click(screen.getByTestId("review-save-seg_2"));
    await waitFor(() => expect(host.of("capture.addTerm")).toHaveLength(1));
    expect(host.of("capture.reviseSegment")[0]!.input).toEqual({ segmentId: "seg_2", text: "主角的表情很克制" });
    expect(host.of("capture.addTerm")[0]!.input).toEqual({ workId: "work_1", term: "克制", heard: "刻志" });
    await waitFor(() => expect(screen.getByTestId("review-note").textContent).toContain("克制"));
    // The review reloads from what is stored after every action.
    expect(host.of("capture.review").length).toBeGreaterThan(1);
  });

  it("revision shows the original text beside the revised one", async () => {
    const segments = makeReview().segments as Array<Record<string, unknown>>;
    segments[0] = { ...segments[0], text: "改过的", originalText: "识别的", revised: true };
    await open({ segments });
    expect(screen.getByTestId("review-text-seg_1").textContent).toBe("改过的");
    expect(screen.getByTestId("review-original-seg_1").textContent).toContain("识别的");
  });

  it("calibrates a segment to where the reader is now, and says when the reader is not open", async () => {
    const position = vi.fn().mockReturnValue(null);
    const { host } = await open({}, { position });
    fireEvent.click(screen.getByTestId("review-calibrate-seg_2"));
    await waitFor(() => expect(screen.getByTestId("review-note").textContent).toContain("没有打开的阅读位置"));
    expect(host.of("capture.calibrate")).toHaveLength(0);
    position.mockReturnValue({ resourceId: "res_v", resourceRevisionId: "rev_v", locator: { kind: "temporal", startMs: 70_000 } });
    fireEvent.click(screen.getByTestId("review-calibrate-seg_2"));
    await waitFor(() => expect(host.of("capture.calibrate")).toHaveLength(1));
    expect(host.of("capture.calibrate")[0]!.input).toMatchObject({ segmentId: "seg_2", resourceId: "res_v", resourceRevisionId: "rev_v", locator: { kind: "temporal", startMs: 70_000 } });
  });

  it("retries one failed segment or all of them, and reports a failed action in place", async () => {
    const { host, state } = await open();
    fireEvent.click(screen.getByTestId("review-retry-seg_3"));
    await waitFor(() => expect(host.of("capture.retry")).toHaveLength(1));
    expect(host.of("capture.retry")[0]!.input).toEqual({ sessionId: "cap_1", segmentId: "seg_3" });
    fireEvent.click(screen.getByTestId("review-retry"));
    await waitFor(() => expect(host.of("capture.retry")).toHaveLength(2));
    expect(host.of("capture.retry")[1]!.input).toEqual({ sessionId: "cap_1" });
    (state as unknown as { fail?: Record<string, string> }).fail = undefined;
  });

  it("shows the failure of an action without hiding the transcript", async () => {
    const state = { review: makeReview({ session: { stage: "pending" } }), fail: { "capture.transcribe": "网络不可达" } as Record<string, string> };
    installHost(state);
    render(<RecordingReview {...props({ initialSessionId: "cap_1" })} />);
    await waitFor(() => expect(screen.getByTestId("review-session")).toBeTruthy());
    fireEvent.click(screen.getByTestId("review-transcribe"));
    await waitFor(() => expect(screen.getByTestId("review-action-error").textContent).toContain("网络不可达"));
    expect(screen.getByTestId("review-text-seg_1")).toBeTruthy();
  });

  it("a recording waiting for a recognition service says so and keeps the audio", async () => {
    await open({ session: { stage: "awaiting_asr", audioState: "staged", playable: false }, segments: [] });
    expect(screen.getByTestId("review-no-asr").textContent).toContain("还没有配置语音识别服务");
    expect(screen.getByTestId("review-transcribe")).toBeTruthy();
    expect(screen.queryByTestId("review-clean")).not.toBeNull();
  });

  it("a recording left pending is never described as deleted", async () => {
    await open({ session: { stage: "pending" } });
    expect(screen.getByText("待处理的录音会一直保留，不会被自动删除。")).toBeTruthy();
  });

  it("cleaning the audio asks for confirmation first", async () => {
    const { host } = await open();
    fireEvent.click(screen.getByTestId("review-clean"));
    expect(host.of("capture.retain")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("review-clean-confirm"));
    await waitFor(() => expect(host.of("capture.retain")).toHaveLength(1));
    expect(host.of("capture.retain")[0]!.input).toEqual({ sessionId: "cap_1", action: "discard" });
  });

  it("offers to keep audio that was staged under a discard setting", async () => {
    const { host } = await open({ session: { retention: "discard", audioState: "staged", stage: "pending" } });
    fireEvent.click(screen.getByTestId("review-keep"));
    await waitFor(() => expect(host.of("capture.retain")).toHaveLength(1));
    expect(host.of("capture.retain")[0]!.input).toEqual({ sessionId: "cap_1", action: "keep" });
  });

  it("organizes into a draft that can be edited and accepted into a note", async () => {
    const opened: string[] = [];
    const { host, state } = await open({}, { onOpenNote: (objectId) => opened.push(objectId) });
    fireEvent.click(screen.getByTestId("review-organize"));
    await waitFor(() => expect(host.of("capture.organize")).toHaveLength(1));
    expect(host.of("capture.organize")[0]!.input).toEqual({ sessionId: "cap_1" });
    // The draft is written in the background; a notice brings it in.
    state.review = makeReview({ drafts: [{ id: "drf_1", sessionId: "cap_1", state: "ready", text: "模型草稿", editedText: null, noteObjectId: null, error: null, createdAt: "2026-10-01T08:10:00.000Z" }] });
    await host.notice("capture.draft", { sessionId: "cap_1", draftId: "drf_1", state: "ready" });
    await waitFor(() => expect(screen.getByTestId("review-draft-text-drf_1")).toBeTruthy());
    fireEvent.change(screen.getByTestId("review-draft-text-drf_1"), { target: { value: "我改过的草稿" } });
    fireEvent.click(screen.getByTestId("review-draft-save-drf_1"));
    await waitFor(() => expect(host.of("capture.editDraft")).toHaveLength(1));
    expect(host.of("capture.editDraft")[0]!.input).toEqual({ draftId: "drf_1", editedText: "我改过的草稿" });
    fireEvent.change(screen.getByTestId("review-draft-text-drf_1"), { target: { value: "我改过的草稿" } });
    fireEvent.click(screen.getByTestId("review-draft-accept-drf_1"));
    await waitFor(() => expect(opened).toEqual(["note_1"]));
    expect(host.of("capture.acceptDraft")[0]!.input).toEqual({ draftId: "drf_1", editedText: "我改过的草稿" });
  });

  it("shows a failed draft with its reason, and an accepted draft with a way to the note", async () => {
    await open({ drafts: [
      { id: "drf_f", sessionId: "cap_1", state: "failed", text: "", editedText: null, noteObjectId: null, error: { code: "LLM", message: "模型不可用" }, createdAt: "2026-10-01T08:10:00.000Z" },
      { id: "drf_a", sessionId: "cap_1", state: "accepted", text: "原稿", editedText: "改稿", noteObjectId: "note_9", error: null, createdAt: "2026-10-01T08:11:00.000Z" },
    ] });
    expect(screen.getByTestId("review-draft-drf_f").textContent).toContain("模型不可用");
    expect(screen.getByTestId("review-draft-note-drf_a")).toBeTruthy();
    expect((screen.getByTestId("review-draft-text-drf_a") as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("goes back to the list", async () => {
    await open();
    fireEvent.click(screen.getByTestId("review-back"));
    await waitFor(() => expect(screen.getByTestId("review-list")).toBeTruthy());
  });
});
