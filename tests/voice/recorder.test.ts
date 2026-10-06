import { describe, expect, it } from "vitest";
import { Recorder, type MicHandle, type RecorderPorts } from "../../apps/desktop/src/renderer/voice/recorder.ts";

type Call = { commandId: string; input: Record<string, unknown>; key?: string };

function fakeMic(label = "合成麦克风") {
  let chunk: (pcm: Int16Array, level: number) => void = () => undefined;
  let ended: () => void = () => undefined;
  const mic: MicHandle & { stopped: number } = {
    label,
    stopped: 0,
    onChunk: (listener) => { chunk = listener; },
    onEnded: (listener) => { ended = listener; },
    stop() { mic.stopped += 1; },
  };
  return { mic, push: (samples = 1600, level = 0.4) => chunk(new Int16Array(samples).fill(100), level), end: () => ended() };
}

function setup(options: { mic?: ReturnType<typeof fakeMic>; openError?: unknown; failAppendAt?: number; startError?: unknown } = {}) {
  const calls: Call[] = [];
  let time = 1000;
  let appendCount = 0;
  const mic = options.mic ?? fakeMic();
  const ports: RecorderPorts = {
    async call(commandId, input, callOptions) {
      calls.push({ commandId, input: input as Record<string, unknown>, key: callOptions?.key });
      if (commandId === "capture.start") {
        if (options.startError) throw options.startError;
        return { sessionId: "cap_1", retention: "keep" } as never;
      }
      if (commandId === "capture.append") {
        appendCount += 1;
        if (options.failAppendAt === appendCount) throw Object.assign(new Error("not recording"), { code: "VALIDATION_ERROR" });
      }
      if (commandId === "capture.stop") return { stage: "recorded", audioState: "staged" } as never;
      return {} as never;
    },
    async openMic() {
      if (options.openError) throw options.openError;
      return mic.mic;
    },
    now: () => time,
  };
  const recorder = new Recorder(ports);
  return { recorder, mic, calls, of: (id: string) => calls.filter((call) => call.commandId === id), advance: (ms: number) => { time += ms; } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("M2 recorder", () => {
  it("opens the microphone first, then the session, and counts the time from the audio received", async () => {
    const { recorder, mic, of, calls } = setup();
    expect(await recorder.start({ mode: "toggle", resourceId: "res_1", resourceRevisionId: "rev_1" })).toBe(true);
    expect(recorder.getState()).toMatchObject({ phase: "recording", sessionId: "cap_1", retention: "keep", deviceLabel: "合成麦克风" });
    expect(of("capture.start")[0]!.input).toMatchObject({ mode: "toggle", resourceId: "res_1", resourceRevisionId: "rev_1", deviceLabel: "合成麦克风" });
    mic.push();
    mic.push();
    await settle();
    // 1600 samples at 16 kHz is 100 ms; the state follows each chunk.
    expect(recorder.getState().elapsedMs).toBe(200);
    expect(recorder.getState().level).toBeCloseTo(0.4);
    expect(of("capture.append").map((call) => call.input.seq)).toEqual([0, 1]);
    expect(of("capture.append")[0]!.key).toBe("cap:cap_1:a0");
    expect(calls[0]!.commandId).toBe("capture.start");
  });

  it("sends audio as base64 little-endian 16-bit samples", async () => {
    const { recorder, mic, of } = setup();
    await recorder.start({ mode: "hold" });
    mic.push(4);
    await settle();
    const data = of("capture.append")[0]!.input.data as string;
    expect([...atob(data)].map((char) => char.charCodeAt(0))).toEqual([100, 0, 100, 0, 100, 0, 100, 0]);
  });

  it("makes no session and no clock when the microphone is refused or missing", async () => {
    for (const [name, code] of [["NotAllowedError", "mic_denied"], ["NotFoundError", "mic_missing"], ["AbortError", "mic_failed"]] as const) {
      const { recorder, of } = setup({ openError: Object.assign(new Error("no"), { name }) });
      expect(await recorder.start({ mode: "toggle" })).toBe(false);
      expect(recorder.getState()).toMatchObject({ phase: "idle", sessionId: null, elapsedMs: 0 });
      expect(recorder.getState().issue?.code).toBe(code);
      expect(of("capture.start")).toHaveLength(0);
    }
  });

  it("releases the microphone when the session cannot be made", async () => {
    const { recorder, mic } = setup({ startError: Object.assign(new Error("a recording is already in progress"), { code: "VALIDATION_ERROR" }) });
    expect(await recorder.start({ mode: "toggle" })).toBe(false);
    expect(mic.mic.stopped).toBe(1);
    expect(recorder.getState()).toMatchObject({ phase: "idle" });
    expect(recorder.getState().issue?.code).toBe("start_failed");
  });

  it("stamps events with the audio clock and ignores them outside a recording", async () => {
    const { recorder, advance, of } = setup();
    recorder.event({ reason: "page", resourceId: "res_1" });
    expect(of("capture.event")).toHaveLength(0);
    await recorder.start({ mode: "toggle" });
    advance(2500);
    recorder.event({ reason: "page", resourceId: "res_1", resourceRevisionId: "rev_1", locator: { kind: "image", pageId: "p3" } });
    advance(1000);
    recorder.event({ reason: "rate_change", playbackRate: 2, playing: true });
    await recorder.stop("user");
    expect(of("capture.event").map((call) => [call.input.offsetMs, call.input.reason])).toEqual([[2500, "page"], [3500, "rate_change"]]);
    expect(of("capture.event")[0]!.key).toBe("cap:cap_1:e0");
    recorder.event({ reason: "page" });
    expect(of("capture.event")).toHaveLength(2);
  });

  it("stops with the reason and the recorded length once everything sent has arrived", async () => {
    const { recorder, mic, calls } = setup();
    await recorder.start({ mode: "hold" });
    for (let index = 0; index < 5; index += 1) mic.push();
    const result = await recorder.stop("focus_lost");
    expect(result).toMatchObject({ sessionId: "cap_1", reason: "focus_lost", durationMs: 500, stage: "recorded", audioState: "staged" });
    expect(mic.mic.stopped).toBe(1);
    expect(calls.at(-1)).toMatchObject({ commandId: "capture.stop", input: { sessionId: "cap_1", reason: "focus_lost", durationMs: 500 } });
    // Every chunk was appended before the stop command.
    expect(calls.filter((call) => call.commandId === "capture.append")).toHaveLength(5);
    expect(recorder.getState()).toMatchObject({ phase: "idle", lastStop: { reason: "focus_lost" } });
    // A second stop does nothing more.
    expect(await recorder.stop("user")).toBeNull();
    expect(calls.filter((call) => call.commandId === "capture.stop")).toHaveLength(1);
  });

  it("ends the recording and keeps what arrived when the device is lost", async () => {
    const { recorder, mic, of } = setup();
    await recorder.start({ mode: "toggle" });
    mic.push();
    mic.end();
    await settle();
    await settle();
    expect(recorder.getState().phase).toBe("idle");
    expect(of("capture.stop")[0]!.input).toMatchObject({ reason: "device_lost", durationMs: 100 });
  });

  it("ends the recording, saying why, when audio can no longer be stored", async () => {
    const { recorder, mic, of } = setup({ failAppendAt: 2 });
    await recorder.start({ mode: "toggle" });
    mic.push();
    mic.push();
    mic.push();
    await settle();
    await settle();
    expect(of("capture.stop")[0]!.input.reason).toBe("error");
    expect(recorder.getState().issue?.code).toBe("append_failed");
    // Nothing is sent after the failure.
    expect(of("capture.append").length).toBeLessThanOrEqual(2);
  });

  it("a release before the session exists ends it at once with what little was captured", async () => {
    const { recorder, of } = setup();
    const starting = recorder.start({ mode: "hold" });
    expect(recorder.getState().phase).toBe("starting");
    const early = recorder.stop("user");
    expect(await early).toBeNull();
    await starting;
    await settle();
    // Whether the microphone had opened or not, no recording is left running.
    expect(recorder.getState().phase).toBe("idle");
    expect(of("capture.stop").length + of("capture.start").length).toBeLessThanOrEqual(2);
  });

  it("does not start a second recording while one runs", async () => {
    const { recorder, of } = setup();
    await recorder.start({ mode: "toggle" });
    expect(await recorder.start({ mode: "toggle" })).toBe(false);
    expect(of("capture.start")).toHaveLength(1);
  });

  it("saves the audio when the window is going away", async () => {
    const { recorder, mic, of } = setup();
    await recorder.start({ mode: "toggle" });
    mic.push();
    await recorder.dispose();
    expect(of("capture.stop")[0]!.input.reason).toBe("shutdown");
  });
});
