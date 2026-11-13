import { describe, expect, it } from "vitest";
import { billedChars, novelParagraphs } from "../../apps/desktop/src/renderer/reader/use-read-novel.ts";
import { ReadAloudController, readAloudProblem, type SpeechMessage, type SpeechRequest, type SpeechSink, type SpeechTransport } from "../../apps/desktop/src/renderer/voice/read-aloud.ts";

/** The read-aloud controller of the window (计划 4.7, 4.8): one reading at a time, paragraphs fetched one ahead, pause and stop, failures shown. */

function fakes() {
  let listener: (message: SpeechMessage) => void = () => undefined;
  const asked: Array<{ id: string; request: SpeechRequest }> = [];
  const stopped: string[] = [];
  const transport: SpeechTransport = {
    speak: (id, request) => { asked.push({ id, request }); },
    stop: (id) => { stopped.push(id); },
    onSpeech: (next) => { listener = next; return () => undefined; },
  };
  let progress: (generation: number, played: number, empty: boolean) => void = () => undefined;
  let generation = 0;
  const sink = { pushed: 0, paused: false, clears: 0 };
  const audio: SpeechSink = {
    open: async () => undefined,
    // Like the real sink, the buffer is transferred: the array is empty once it has been handed over.
    push: (pcm) => { sink.pushed += pcm.length; structuredClone(pcm.buffer, { transfer: [pcm.buffer] }); },
    pause: () => { sink.paused = true; },
    resume: () => { sink.paused = false; },
    clear: (next) => { generation = next; sink.pushed = 0; sink.clears += 1; },
    onProgress: (next) => { progress = next; },
  };
  let clock = 0;
  const controller = new ReadAloudController(() => transport, () => audio, () => clock);
  return {
    controller, asked, stopped, sink,
    tick: (ms: number) => { clock += ms; },
    chunk: (index: number, samples: number) => listener({ id: asked[index]!.id, kind: "chunk", pcm: new Uint8Array(samples * 2) }),
    end: (index: number) => listener({ id: asked[index]!.id, kind: "end", result: {} }),
    fail: (index: number, error: SpeechMessage["error"]) => listener({ id: asked[index]!.id, kind: "error", error }),
    played: (samples: number, empty = false) => progress(generation, samples, empty),
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("reading aloud in the window", () => {
  it("asks for the next paragraph when one has arrived, follows what is heard, and ends", async () => {
    const f = fakes();
    const heard: number[] = [];
    let ended: string | null = null;
    await f.controller.play({ owner: "novel:1", segments: ["第一段。", "第二段。", "第三段。"], task: "novel", onSegment: (index) => heard.push(index), onEnd: (reason) => { ended = reason; } });
    expect(f.asked.map((item) => item.request.text)).toEqual(["第一段。"]);
    expect(f.controller.getState()).toMatchObject({ status: "loading", owner: "novel:1", segment: 0, count: 3 });

    f.tick(120);
    f.chunk(0, 2400);
    expect(f.controller.getState().status).toBe("playing");
    expect(f.controller.lastStats().firstAudioMs).toBe(120);
    f.end(0);
    // The second is asked for at once, before the first is over.
    expect(f.asked.map((item) => item.request.task)).toEqual(["novel", "novel"]);
    f.chunk(1, 2400);
    f.end(1);
    f.chunk(2, 2400);
    f.end(2);
    expect(f.sink.pushed).toBe(7200);

    f.played(2400);
    expect(heard).toEqual([1]);
    f.played(4800);
    expect(heard).toEqual([1, 2]);
    f.played(7200, true);
    expect(ended).toBe("done");
    expect(f.controller.getState().status).toBe("idle");
    expect(f.controller.lastStats().gapsMs).toEqual([0, 0]);
  });

  it("measures the silence when the next paragraph is late", async () => {
    const f = fakes();
    await f.controller.play({ owner: "novel:1", segments: ["一。", "二。"] });
    f.chunk(0, 2400);
    f.end(0);
    f.played(2400, true);
    expect(f.controller.getState().status).toBe("loading");
    f.tick(80);
    f.chunk(1, 2400);
    expect(f.controller.lastStats().gapsMs).toEqual([80]);
    expect(f.controller.getState().status).toBe("playing");
  });

  it("pauses and continues by hand; dictation pauses it and it does not go on by itself", async () => {
    const f = fakes();
    await f.controller.play({ owner: "answer:a", segments: ["回答。"] });
    f.chunk(0, 2400);
    f.controller.pause();
    expect(f.controller.getState().status).toBe("paused");
    expect(f.sink.paused).toBe(true);
    f.controller.resume();
    expect(f.controller.getState().status).toBe("playing");
    f.controller.pauseForCapture();
    expect(f.controller.getState().status).toBe("paused");
    await settle();
    expect(f.controller.getState().status).toBe("paused");
  });

  it("stops the requests under way, says where it stopped, and another reading stops the one before", async () => {
    const f = fakes();
    let stoppedAt: [string, number] | null = null;
    await f.controller.play({ owner: "novel:1", segments: ["一。", "二。", "三。"], onEnd: (reason, segment) => { stoppedAt = [reason, segment]; } });
    f.chunk(0, 2400);
    f.end(0);
    f.played(2400);
    f.controller.stop();
    expect(stoppedAt).toEqual(["stopped", 1]);
    expect(f.stopped).toEqual([f.asked[1]!.id]);
    expect(f.controller.getState()).toMatchObject({ status: "idle", owner: null });

    let first: string | null = null;
    await f.controller.play({ owner: "answer:a", segments: ["回答一。"], onEnd: (reason) => { first = reason; } });
    await f.controller.play({ owner: "answer:b", segments: ["回答二。"] });
    expect(first).toBe("stopped");
    expect(f.controller.getState().owner).toBe("answer:b");
    // A late piece of the stopped reading is not played.
    const before = f.sink.pushed;
    f.chunk(f.asked.length - 2, 2400);
    expect(f.sink.pushed).toBe(before);
  });

  it("shows a broken-off reading as one that can be retried, and the other failures by what fixes them", async () => {
    const f = fakes();
    let ended: string | null = null;
    await f.controller.play({ owner: "answer:a", segments: ["回答。"], onEnd: (reason) => { ended = reason; } });
    f.chunk(0, 1200);
    f.fail(0, { code: "PROVIDER_UNAVAILABLE", message: "the speech broke off", details: { kind: "truncated" } });
    expect(ended).toBe("error");
    expect(f.controller.getState().status).toBe("error");
    expect(readAloudProblem(f.controller.getState().error)).toEqual({ key: "readAloud.error.truncated", retry: true });
    expect(readAloudProblem({ code: "MODEL_CAPABILITY_MISSING", message: "", details: { reason: "no_speech_service" } })?.key).toBe("readAloud.error.noService");
    expect(readAloudProblem({ code: "PROVIDER_UNAVAILABLE", message: "", details: { reason: "plugin_disabled" } })?.key).toBe("readAloud.error.pluginOff");
    expect(readAloudProblem({ code: "PROVIDER_UNAVAILABLE", message: "", details: { kind: "billing", status: 402 } })).toEqual({ key: "readAloud.error.billing", retry: false });
    f.controller.stop();
    expect(f.controller.getState().status).toBe("idle");
  });
});

describe("the paragraphs of a novel", () => {
  it("start at the paragraph on screen, by absolute offsets, without blank lines", () => {
    const text = "第一段。\n\n第二段。\n  \n第三段。";
    expect(novelParagraphs(text, 100, 100).map((item) => item.text)).toEqual(["第一段。", "第二段。", "第三段。"]);
    const from = novelParagraphs(text, 100, 107);
    expect(from[0]).toEqual({ start: 106, end: 110, text: "第二段。" });
    expect(from).toHaveLength(2);
    expect(billedChars("第二段。ab")).toBe(9);
  });
});
