/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { RecordControl, RecordIndicator } from "../../apps/desktop/src/renderer/voice/record-control.tsx";
import { useRecorder } from "../../apps/desktop/src/renderer/voice/use-recorder.ts";
import { captureBus } from "../../apps/desktop/src/renderer/voice/capture-bus.ts";
import type { MicHandle } from "../../apps/desktop/src/renderer/voice/recorder.ts";

const i18n = createTranslator("zh-CN");

type Call = { commandId: string; input: Record<string, unknown> };

function fakeMic() {
  let chunk: (pcm: Int16Array, level: number) => void = () => undefined;
  let ended: () => void = () => undefined;
  const mic: MicHandle & { stopped: number } = {
    label: "合成麦克风",
    stopped: 0,
    onChunk: (listener) => { chunk = listener; },
    onEnded: (listener) => { ended = listener; },
    stop() { mic.stopped += 1; },
  };
  return { mic, push: (samples = 1600, level = 0.5) => chunk(new Int16Array(samples).fill(50), level), end: () => ended() };
}

function installHost(options: { recording?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const published: unknown[] = [];
  let overlayStop: () => void = () => undefined;
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input?: Record<string, unknown> }) {
      calls.push({ commandId: payload.commandId, input: payload.input ?? {} });
      if (payload.commandId === "settings.getRecording") return { status: "ok", value: options.recording ?? {} };
      if (payload.commandId === "capture.start") return { status: "ok", value: { sessionId: "cap_ui", retention: "keep" } };
      if (payload.commandId === "capture.stop") return { status: "ok", value: { stage: "recorded", audioState: "staged" } };
      return { status: "ok", value: {} };
    },
    overlay: { publish: (state: unknown) => { published.push(state); }, onStop: (listener: () => void) => { overlayStop = listener; return () => undefined; } },
  };
  return { calls, published, of: (id: string) => calls.filter((call) => call.commandId === id), stopFromOverlay: () => overlayStop() };
}

function Harness(props: { mic: ReturnType<typeof fakeMic>; enabled?: boolean; onError?: (message?: string) => void; onNotice?: (message?: string) => void }) {
  const recorder = useRecorder({
    i18n, enabled: props.enabled ?? true, setError: props.onError ?? (() => undefined), setNotice: props.onNotice ?? (() => undefined),
    openMic: async () => props.mic.mic,
  });
  return (
    <div>
      <RecordControl
        t={i18n.t} state={recorder.state} settings={recorder.settings} enabled={props.enabled ?? true}
        onToggle={recorder.toggle} onHoldStart={() => void recorder.begin("hold")} onHoldEnd={recorder.endHold} onStop={() => void recorder.stop("user")}
        onReview={() => undefined}
      />
      <output data-testid="phase">{recorder.state.phase}</output>
    </div>
  );
}

const phase = () => screen.getByTestId("phase").textContent;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => { captureBus.reset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("recording controls", () => {
  it("starts from the button, shows the live state, and stops from the indicator", async () => {
    const host = installHost();
    const mic = fakeMic();
    render(<Harness mic={mic} />);
    await settle();
    fireEvent.click(screen.getByTestId("record-start"));
    await waitFor(() => expect(phase()).toBe("recording"));
    expect(screen.getByTestId("record-indicator").getAttribute("data-phase")).toBe("recording");
    expect(screen.getByTestId("record-label").textContent).toBe("正在录音");
    await act(async () => { mic.push(); mic.push(); });
    expect(screen.getByTestId("record-time").textContent).toMatch(/00:00\.?2|0:00/);
    expect(screen.getByTestId("record-retention").textContent).toBe("保留录音");
    fireEvent.click(screen.getByTestId("record-stop"));
    await waitFor(() => expect(phase()).toBe("idle"));
    expect(host.of("capture.stop")).toHaveLength(1);
    expect(mic.mic.stopped).toBe(1);
    // After a recording ends the control offers to review what was saved.
    expect(screen.getByTestId("record-review")).toBeTruthy();
  });

  it("the title bar's compact indicator still shows the input level while recording, and leaves the retention note out", () => {
    const state = { phase: "recording", elapsedMs: 4000, level: 0.5, retention: "keep" } as unknown as Parameters<typeof RecordIndicator>[0]["state"];
    render(<RecordIndicator t={i18n.t} state={state} onStop={() => undefined} compact />);
    expect(screen.getByTestId("record-label").textContent).toBe("正在录音");
    expect(screen.getByTestId("record-time").textContent).toMatch(/0:04/);
    expect(screen.getByTestId("record-level").getAttribute("aria-valuenow")).toBe("0.5");
    expect(screen.queryByTestId("record-retention")).toBeNull();
    expect(screen.getByTestId("record-stop")).toBeTruthy();
  });

  it("the toggle key starts and stops, and the hold key records only while it is down", async () => {
    const host = installHost();
    const mic = fakeMic();
    render(<Harness mic={mic} />);
    await settle();
    fireEvent.keyDown(window, { code: "F8" });
    await waitFor(() => expect(phase()).toBe("recording"));
    fireEvent.keyDown(window, { code: "F8" });
    await waitFor(() => expect(phase()).toBe("idle"));
    expect(host.of("capture.start")).toHaveLength(1);

    fireEvent.keyDown(window, { code: "F9" });
    await waitFor(() => expect(phase()).toBe("recording"));
    expect(host.of("capture.start")[1]!.input).toMatchObject({ mode: "hold" });
    fireEvent.keyUp(window, { code: "F9" });
    await waitFor(() => expect(phase()).toBe("idle"));
    expect(host.of("capture.stop")).toHaveLength(2);
  });

  it("a held recording ends when the window loses focus, and says so", async () => {
    installHost();
    const mic = fakeMic();
    const notices: Array<string | undefined> = [];
    render(<Harness mic={mic} onNotice={(message) => notices.push(message)} />);
    await settle();
    fireEvent.keyDown(window, { code: "F9" });
    await waitFor(() => expect(phase()).toBe("recording"));
    fireEvent.blur(window);
    await waitFor(() => expect(phase()).toBe("idle"));
    expect(notices.some((message) => message?.includes("失去焦点"))).toBe(true);
  });

  it("a toggled recording carries on when the window loses focus", async () => {
    installHost();
    const mic = fakeMic();
    render(<Harness mic={mic} />);
    await settle();
    fireEvent.keyDown(window, { code: "F8" });
    await waitFor(() => expect(phase()).toBe("recording"));
    fireEvent.blur(window);
    await settle();
    expect(phase()).toBe("recording");
    fireEvent.keyDown(window, { code: "F8" });
    await waitFor(() => expect(phase()).toBe("idle"));
  });

  it("a hold key whose release was lost ends the recording after the repeats stop", async () => {
    installHost();
    const mic = fakeMic();
    const notices: Array<string | undefined> = [];
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    render(<Harness mic={mic} onNotice={(message) => notices.push(message)} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.keyDown(window, { code: "F9" });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(phase()).toBe("recording");
    // Key repeat says the key is still down; then it goes quiet with no key-up.
    fireEvent.keyDown(window, { code: "F9", repeat: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(phase()).toBe("idle");
    expect(notices.some((message) => message?.includes("松开按键"))).toBe(true);
  });

  it("the hold button records while pressed and stops on release", async () => {
    const host = installHost();
    const mic = fakeMic();
    render(<Harness mic={mic} />);
    await settle();
    const hold = screen.getByTestId("record-hold");
    fireEvent.pointerDown(hold, { pointerId: 1 });
    await waitFor(() => expect(phase()).toBe("recording"));
    fireEvent.pointerUp(hold, { pointerId: 1 });
    await waitFor(() => expect(phase()).toBe("idle"));
    expect(host.of("capture.start")[0]!.input).toMatchObject({ mode: "hold" });
  });

  it("starts against the reader's current position and follows it while recording", async () => {
    const host = installHost();
    const mic = fakeMic();
    render(<Harness mic={mic} />);
    await settle();
    act(() => captureBus.emit({ reason: "resource_change", resourceId: "res_1", resourceRevisionId: "rev_1", locator: { kind: "temporal", startMs: 1000 } as never }));
    fireEvent.click(screen.getByTestId("record-start"));
    await waitFor(() => expect(phase()).toBe("recording"));
    expect(host.of("capture.start")[0]!.input).toMatchObject({ resourceId: "res_1", resourceRevisionId: "rev_1", retention: "keep" });
    act(() => captureBus.emit({ reason: "page", resourceId: "res_1", resourceRevisionId: "rev_1", locator: { kind: "temporal", startMs: 9000 } as never }));
    await settle();
    expect(host.of("capture.event").some((call) => call.input.reason === "page")).toBe(true);
  });

  it("tells the user when the microphone is denied and stays idle", async () => {
    installHost();
    const errors: Array<string | undefined> = [];
    function Denied() {
      const recorder = useRecorder({ i18n, enabled: true, setError: (message) => errors.push(message), setNotice: () => undefined, openMic: async () => { throw Object.assign(new Error("denied"), { name: "NotAllowedError" }); } });
      return <button type="button" data-testid="go" onClick={recorder.toggle}>go</button>;
    }
    render(<Denied />);
    await settle();
    fireEvent.click(screen.getByTestId("go"));
    await waitFor(() => expect(errors.length).toBeGreaterThan(0));
    expect(errors[0]).toContain("麦克风");
  });

  it("publishes the floating box state while recording and clears it after", async () => {
    const host = installHost();
    const mic = fakeMic();
    render(<Harness mic={mic} />);
    await settle();
    fireEvent.click(screen.getByTestId("record-start"));
    await waitFor(() => expect(phase()).toBe("recording"));
    expect(host.published.some((state) => (state as { phase?: string } | null)?.phase === "recording")).toBe(true);
    host.stopFromOverlay();
    await waitFor(() => expect(phase()).toBe("idle"));
    expect(host.published[host.published.length - 1]).toBeNull();
  });

  it("turning the module off ends a recording in progress and keeps what was captured", async () => {
    const host = installHost();
    const mic = fakeMic();
    const { rerender } = render(<Harness mic={mic} />);
    await settle();
    fireEvent.click(screen.getByTestId("record-start"));
    await waitFor(() => expect(phase()).toBe("recording"));
    rerender(<Harness mic={mic} enabled={false} />);
    await waitFor(() => expect(phase()).toBe("idle"));
    expect(host.of("capture.stop")[0]!.input).toMatchObject({ reason: "deactivated" });
    expect(screen.queryByTestId("record-control")).toBeNull();
  });
});
