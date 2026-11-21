/** @vitest-environment jsdom */
import { useState } from "react";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { resolveKeys } from "@manga/contracts/keys";
import { DictationPill, type PillState } from "../../apps/desktop/src/renderer/voice/dictation-pill.tsx";
import {
  captureEditableTarget,
  registerTiptapEditor,
  resetCompositionState,
} from "../../apps/desktop/src/renderer/voice/editable-target.ts";
import { openMicrophone, resetMicDiagnostics } from "../../apps/desktop/src/renderer/voice/mic.ts";
import {
  ReadAloudController,
  type SpeechMessage,
  type SpeechRequest,
  type SpeechSink,
  type SpeechTransport,
} from "../../apps/desktop/src/renderer/voice/read-aloud.ts";
import { RecordControl } from "../../apps/desktop/src/renderer/voice/record-control.tsx";
import { Recorder, type MicHandle, type RecorderState } from "../../apps/desktop/src/renderer/voice/recorder.ts";
import { RecordingReview } from "../../apps/desktop/src/renderer/voice/review-panel.tsx";
import { useDictation } from "../../apps/desktop/src/renderer/voice/use-dictation.ts";
import {
  DEFAULT_RECORDING_SETTINGS,
  useRecorder,
  type RecorderHandle,
} from "../../apps/desktop/src/renderer/voice/use-recorder.ts";

const i18n = createTranslator("zh-CN");

type HostCall = { commandId: string; input: Record<string, unknown> };
type HostHandler = (input: Record<string, unknown>) => unknown | Promise<unknown>;

function installHost(handlers: Record<string, HostHandler> = {}) {
  const calls: HostCall[] = [];
  const listeners = new Set<(notice: { topic: string; payload: Record<string, unknown> }) => void>();
  (window as unknown as { manga: unknown }).manga = {
    async command(payload: { commandId: string; input?: Record<string, unknown> }) {
      const input = payload.input ?? {};
      calls.push({ commandId: payload.commandId, input });
      const handler = handlers[payload.commandId];
      if (!handler) return { status: "ok", value: {} };
      try {
        const value = await handler(input);
        return { status: "ok", value };
      } catch (error) {
        const err = error as { code?: string; message?: string };
        return { status: "error", error: { code: err.code ?? "INTERNAL", message: err.message ?? "failed" } };
      }
    },
    onNotice(listener: (notice: { topic: string; payload: Record<string, unknown> }) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return {
    calls,
    of: (id: string) => calls.filter((entry) => entry.commandId === id),
    emit(topic: string, payload: Record<string, unknown>) {
      for (const listener of [...listeners]) listener({ topic, payload });
    },
  };
}

function createFakeMic(label = "Fake Mic") {
  let chunkCb: ((pcm: Int16Array, level: number) => void) | null = null;
  let endedCb: (() => void) | null = null;
  let stopped = false;
  const handle: MicHandle = {
    label,
    onChunk: (cb) => { chunkCb = cb; },
    onEnded: (cb) => { endedCb = cb; },
    stop: () => { stopped = true; },
  };
  return {
    handle,
    isStopped: () => stopped,
    pushChunk(samples = 1600, peak = 0.25) {
      chunkCb?.(new Int16Array(samples), peak);
    },
    triggerEnded() {
      endedCb?.();
    },
  };
}

function createMockTiptapEditor(initialText: string) {
  let text = initialText;
  let selection = { from: 0, to: 0 };
  const dispatches: Array<{ docChanged: boolean; meta: Record<string, unknown> }> = [];
  const dom = document.createElement("div");
  dom.setAttribute("contenteditable", "true");
  document.body.appendChild(dom);

  const makeTr = () => {
    let nextText = text;
    let docChanged = false;
    let mappedInsertFrom = 0;
    let mappedInsertTo = 0;
    let mappedInsertLen = 0;
    const meta: Record<string, unknown> = {};
    const tr = {
      get docChanged() { return docChanged; },
      setMeta(key: unknown, val: unknown) {
        const name = typeof key === "string" ? key : String((key as { key?: string } | null)?.key ?? key);
        meta[name] = val;
        return tr;
      },
      insertText(insert: string, from: number, to: number) {
        nextText = nextText.slice(0, from) + insert + nextText.slice(to);
        docChanged = true;
        mappedInsertFrom = from;
        mappedInsertTo = to;
        mappedInsertLen = insert.length;
        return tr;
      },
      // Faithful ProseMirror mapping: explicit `insertText(text, from, to)` keeps an unrelated selection mapped,
      // while `tr.mapping.map(to, 1)` returns the exact end of the inserted span (`from + text.length`).
      mapping: {
        map(pos: number, assoc = 1) {
          if (!docChanged) return pos;
          const delta = mappedInsertLen - (mappedInsertTo - mappedInsertFrom);
          if (pos < mappedInsertFrom) return pos;
          if (pos > mappedInsertTo) return pos + delta;
          return assoc < 0 ? mappedInsertFrom : mappedInsertFrom + mappedInsertLen;
        },
      },
      get selection() {
        // Simulates ProseMirror preserving a caret that the user moved far away from `from..to`.
        return {
          from: tr.mapping.map(selection.from, 1),
          to: tr.mapping.map(selection.to, 1),
        };
      },
      _apply() {
        if (docChanged) {
          selection = {
            from: tr.mapping.map(selection.from, 1),
            to: tr.mapping.map(selection.to, 1),
          };
          text = nextText;
        }
        dispatches.push({ docChanged, meta });
      },
    };
    return tr;
  };

  const editor = {
    isDestroyed: false,
    isEditable: true,
    on: () => undefined,
    off: () => undefined,
    get state() {
      return {
        get selection() { return selection; },
        get doc() {
          return {
            content: { size: text.length },
            textBetween: (from: number, to: number) => text.slice(from, to),
          };
        },
        get tr() { return makeTr(); },
      };
    },
    view: {
      dom,
      dispatch(tr: ReturnType<typeof makeTr>) {
        tr._apply();
      },
    },
  };

  return {
    editor: editor as unknown as Editor,
    dom,
    dispatches,
    getText: () => text,
    setSelection(from: number, to = from) {
      selection = { from, to };
    },
    cleanup() {
      dom.remove();
    },
  };
}

afterEach(() => {
  cleanup();
  resetMicDiagnostics();
  resetCompositionState();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Wave 2B renderer regressions", () => {
  it("V-01 & V-21a: Tiptap replace() uses tr.mapping.map instead of unrelated caret and closes draft history after insert", () => {
    const mock = createMockTiptapEditor("Hello world, keep this intact!");
    const unregister = registerTiptapEditor(() => mock.editor, { kind: "draft" });
    try {
      mock.setSelection(0, 0);
      mock.dom.focus();
      const target = captureEditableTarget(mock.dom);
      expect(target?.kind).toBe("tiptap");

      expect(target!.insert("RAW ")).toBe(true);
      expect(mock.getText()).toBe("RAW Hello world, keep this intact!");
      // V-21a: Draft editor dispatches a follow-up closeHistory transaction AFTER the insert transaction.
      expect(mock.dispatches).toHaveLength(2);
      expect(mock.dispatches[0]!.docChanged).toBe(true);
      expect(mock.dispatches[0]!.meta["closeHistory$"]).toBe(true);
      expect(mock.dispatches[1]!.docChanged).toBe(false);
      expect(mock.dispatches[1]!.meta["closeHistory$"]).toBe(true);

      // User moves caret to the very end of the document WITHOUT editing before polish arrives.
      mock.setSelection(mock.getText().length, mock.getText().length);
      expect(target!.replace("POLISHED ")).toBe(true);
      // Intermediate document text must remain completely intact!
      expect(mock.getText()).toBe("POLISHED Hello world, keep this intact!");
      target!.dispose();
    } finally {
      unregister();
      mock.cleanup();
    }
  });

  it("V-02, V-04 & V-21d: ReadAloudController bounds prefetch, halts prefetch on pause, buffers pre-open chunks, and suspends sink on stop", async () => {
    let listener: (msg: SpeechMessage) => void = () => undefined;
    const asked: Array<{ id: string; request: SpeechRequest }> = [];
    const transport: SpeechTransport = {
      speak: (id, request) => { asked.push({ id, request }); },
      stop: () => undefined,
      onSpeech: (next) => { listener = next; return () => undefined; },
    };

    let resolveOpen!: () => void;
    let progress: (gen: number, played: number, empty: boolean) => void = () => undefined;
    let gen = 0;
    let pushed = 0;
    let suspended = 0;
    const sink: SpeechSink = {
      open: () => new Promise<void>((resolve) => { resolveOpen = resolve; }),
      push: (pcm) => { pushed += pcm.length; },
      pause: () => undefined,
      resume: () => undefined,
      suspend: () => { suspended += 1; },
      clear: (next) => { gen = next; pushed = 0; },
      onProgress: (next) => { progress = next; },
    };

    const ctl = new ReadAloudController(() => transport, () => sink, () => 0);
    const segments = Array.from({ length: 10 }, (_, i) => `段落${i + 1}。`);
    const playPromise = ctl.play({ owner: "novel:1", segments, task: "novel" });

    // V-04: Chunk arrives BEFORE sink.open() resolves; it must be buffered and flushed once open() completes.
    expect(asked).toHaveLength(1);
    listener({ id: asked[0]!.id, kind: "chunk", pcm: new Uint8Array(2400 * 2) });
    expect(pushed).toBe(0);
    resolveOpen();
    await playPromise;
    expect(pushed).toBe(2400);

    // V-02: Prefetch is bounded to MAX_PREFETCH_AHEAD (2 ahead of current segment 0 -> max index 2, i.e. 3 total asked).
    listener({ id: asked[0]!.id, kind: "end", result: {} });
    expect(asked).toHaveLength(2);
    listener({ id: asked[1]!.id, kind: "chunk", pcm: new Uint8Array(2400 * 2) });
    listener({ id: asked[1]!.id, kind: "end", result: {} });
    expect(asked).toHaveLength(3);
    listener({ id: asked[2]!.id, kind: "chunk", pcm: new Uint8Array(2400 * 2) });
    listener({ id: asked[2]!.id, kind: "end", result: {} });
    // Must NOT prefetch segment 3 while segment 0 is still playing!
    expect(asked).toHaveLength(3);

    // Pausing stops prefetching even if playback progress advances.
    ctl.pauseForCapture();
    progress(gen, 2400, false);
    expect(asked).toHaveLength(3);

    // V-21d: stop() suspends the AudioContext sink.
    ctl.stop();
    expect(suspended).toBe(1);
  });

  it("V-03, V-08 & V-15: useDictation ignores stale notices before start resolves, handles append errors cleanly, and unsticks loadingModel", async () => {
    let resolveStart!: (val: Record<string, unknown>) => void;
    const mic = createFakeMic();
    const errors: Array<string | undefined> = [];
    let failAppend = false;
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);

    const host = installHost({
      "dictation.start": () => new Promise((resolve) => { resolveStart = resolve; }),
      "dictation.append": () => {
        if (failAppend) throw Object.assign(new Error("append exploded"), { code: "INTERNAL" });
        return {};
      },
      "dictation.cancel": () => ({}),
    });

    let handle!: ReturnType<typeof useDictation>;
    function Harness() {
      const [text, setText] = useState("");
      handle = useDictation({
        i18n,
        enabled: true,
        settings: DEFAULT_RECORDING_SETTINGS,
        keyTable: resolveKeys(null),
        setError: (msg) => errors.push(msg),
        setNotice: () => undefined,
        openMic: async () => mic.handle,
      });
      return <textarea data-testid="box" value={text} onChange={(e) => setText(e.target.value)} />;
    }

    try {
      render(<Harness />);
      const box = screen.getByTestId("box") as HTMLTextAreaElement;
      box.focus();

      act(() => { handle.toggleFromButton(box); });
      await waitFor(() => expect(host.of("dictation.start")).toHaveLength(1));

      // V-03: Late `cancelled` notice from an older session while `dictation.start` is still pending must be ignored.
      act(() => {
        host.emit("dictation.changed", { dictationId: "dic_old", stage: "cancelled" });
      });
      expect(handle.active).toBe(true);

      // Now start resolves for `dic_new`.
      await act(async () => {
        resolveStart({ dictationId: "dic_new", stage: "recording", loadingModel: true });
      });
      expect(handle.stage).toBe("loading_model");

      // V-15: `polishing` stage overrides stale `loadingModel: true`.
      act(() => {
        host.emit("dictation.changed", { dictationId: "dic_new", stage: "polishing", loadingModel: true });
      });
      expect(handle.stage).toBe("polishing");

      // V-08: `dictation.append` rejection stops mic, reports error, cancels server session, and emits no unhandled rejection.
      failAppend = true;
      act(() => { mic.pushChunk(1600, 0.3); });
      await waitFor(() => expect(handle.active).toBe(false));
      expect(mic.isStopped()).toBe(true);
      expect(errors.some((e) => e?.includes("append exploded"))).toBe(true);
      expect(host.of("dictation.cancel")).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("V-05: RecordControl releases UI hold via window pointerup even after the hold button unmounts", () => {
    const onHoldEnd = vi.fn();
    function Harness() {
      const [phase, setPhase] = useState<RecorderState["phase"]>("idle");
      return (
        <RecordControl
          t={i18n.t}
          state={{ phase, mode: phase === "idle" ? undefined : "hold", elapsedMs: 0, level: 0 }}
          enabled={true}
          settings={DEFAULT_RECORDING_SETTINGS}
          onToggle={() => undefined}
          onHoldStart={() => setPhase("recording")}
          onHoldEnd={() => { onHoldEnd(); setPhase("idle"); }}
          onStop={() => setPhase("idle")}
        />
      );
    }

    render(<Harness />);
    const holdBtn = screen.getByTestId("record-hold");
    fireEvent.pointerDown(holdBtn);
    // Hold button has now swapped out for `<RecordIndicator />`.
    expect(screen.queryByTestId("record-hold")).toBeNull();
    expect(screen.getByTestId("record-indicator")).toBeTruthy();

    // Releasing the pointer anywhere on window must end the hold cleanly.
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    expect(onHoldEnd).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("record-hold")).toBeTruthy();
  });

  it("V-19: openMicrophone cleans up stream + AudioContext if AudioWorkletNode throws and falls back deviceId before echoCancellation", async () => {
    const seenConstraints: MediaStreamConstraints[] = [];
    const trackStop = vi.fn();
    const fakeTrack = {
      label: "Default Mic",
      stop: trackStop,
      addEventListener: vi.fn(),
      getSettings: () => ({ echoCancellation: "all", noiseSuppression: false }),
    };
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      seenConstraints.push(constraints);
      const audio = constraints.audio as Record<string, unknown>;
      if (audio.deviceId) {
        throw Object.assign(new Error("unplugged mic"), { name: "NotFoundError" });
      }
      return { getAudioTracks: () => [fakeTrack], getTracks: () => [fakeTrack] } as unknown as MediaStream;
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices: async () => [] },
    });

    const ctxClose = vi.fn(async () => undefined);
    class FailingWorkletAudioContext {
      state = "running";
      audioWorklet = { addModule: async () => undefined };
      destination = {};
      createMediaStreamSource() { return { connect: () => undefined, disconnect: () => undefined }; }
      createGain() { return { gain: { value: 1 }, connect: () => undefined, disconnect: () => undefined }; }
      close = ctxClose;
    }
    class ThrowingWorkletNode {
      constructor() {
        throw new Error("worklet init boom");
      }
    }
    vi.stubGlobal("AudioContext", FailingWorkletAudioContext);
    vi.stubGlobal("AudioWorkletNode", ThrowingWorkletNode);

    const onFallback = vi.fn();
    await expect(
      openMicrophone("missing-usb-mic", { systemLoopbackAec: true, onSystemAecFallback: onFallback }),
    ).rejects.toThrow("worklet init boom");

    // Fell back from exact deviceId -> default device while KEEPING `echoCancellation: "all"`.
    expect(seenConstraints).toHaveLength(2);
    expect((seenConstraints[0]!.audio as Record<string, unknown>).deviceId).toEqual({ exact: "missing-usb-mic" });
    expect((seenConstraints[1]!.audio as Record<string, unknown>).deviceId).toBeUndefined();
    expect((seenConstraints[1]!.audio as Record<string, unknown>).echoCancellation).toBe("all");
    expect(onFallback).not.toHaveBeenCalled();

    // Stream track and AudioContext were both cleaned up after AudioWorkletNode threw.
    expect(trackStop).toHaveBeenCalledTimes(1);
    expect(ctxClose).toHaveBeenCalledTimes(1);
  });

  it("V-20a, V-20b, V-20c & UP-20: Recorder.stop awaits starting, useRecorder guards IME & toggle-starting, and saveSettings returns boolean", async () => {
    // V-20c: Recorder.stop() called while `starting` awaits clean completion both during `openMic` and during `capture.start`.
    let resolveMic!: (mic: MicHandle) => void;
    const mic1 = createFakeMic();
    const rec1 = new Recorder({
      call: async () => ({} as never),
      openMic: () => new Promise<MicHandle>((resolve) => { resolveMic = resolve; }),
      now: () => 100,
    });
    const startRun1 = rec1.start({ mode: "hold", retention: "keep", deviceId: null });
    expect(rec1.getState().phase).toBe("starting");
    const stopRun1 = rec1.stop("user");
    resolveMic(mic1.handle);
    const [startedOk1, stopResult1] = await Promise.all([startRun1, stopRun1]);
    expect(startedOk1).toBe(false);
    expect(stopResult1).toBeNull();
    expect(mic1.isStopped()).toBe(true);
    expect(rec1.getState().phase).toBe("idle");

    let resolveCaptureStart!: (value: { sessionId: string; nextSeq: number }) => void;
    const mic2 = createFakeMic();
    const rec2 = new Recorder({
      call: async (cmd) => {
        if (cmd === "capture.start") return new Promise((resolve) => { resolveCaptureStart = resolve; }) as never;
        if (cmd === "capture.stop") return { id: "cap_1" } as never;
        return {} as never;
      },
      openMic: async () => mic2.handle,
      now: () => 100,
    });
    const startRun2 = rec2.start({ mode: "hold", retention: "keep", deviceId: null });
    await Promise.resolve();
    const stopRun2 = rec2.stop("user");
    resolveCaptureStart({ sessionId: "cap_1", nextSeq: 0 });
    const [startedOk2, stopResult2] = await Promise.all([startRun2, stopRun2]);
    expect(startedOk2).toBe(true);
    expect(stopResult2).toMatchObject({ sessionId: "cap_1", reason: "user" });
    expect(rec2.getState().phase).toBe("idle");

    // V-20a, V-20b, UP-20 via useRecorder:
    let resolveToggleMic!: (mic: MicHandle) => void;
    let failSave = false;
    installHost({
      "settings.getRecording": () => DEFAULT_RECORDING_SETTINGS,
      "settings.setRecording": () => {
        if (failSave) throw Object.assign(new Error("conflict"), { code: "VALIDATION_ERROR" });
        return {};
      },
      "capture.start": () => ({ sessionId: "cap_toggle", nextSeq: 0 }),
      "capture.stop": () => ({ id: "cap_toggle" }),
    });

    let handle!: RecorderHandle;
    function Harness() {
      handle = useRecorder({
        i18n,
        enabled: true,
        setError: () => undefined,
        setNotice: () => undefined,
        openMic: () => new Promise<MicHandle>((resolve) => { resolveToggleMic = resolve; }),
      });
      return null;
    }

    render(<Harness />);
    await waitFor(() => expect(handle.settings.holdKey).toBe("F9"));

    // UP-20: saveSettings returns true on success and false on error.
    expect(await act(async () => handle.saveSettings({ retention: "discard" }))).toBe(true);
    failSave = true;
    expect(await act(async () => handle.saveSettings({ holdKey: "F8" }))).toBe(false);

    // V-20a: IME composing keydown does NOT start recording.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "F8", isComposing: true }));
    });
    expect(handle.state.phase).toBe("idle");

    // V-20b: Starting a toggle recording, then firing F9 keyup (holdKey) or endHold() must NOT stop the toggle recording.
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "F8" }));
    });
    expect(handle.state.phase).toBe("starting");
    expect(handle.state.mode).toBe("toggle");

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "F9" }));
      handle.endHold();
    });

    const toggleMic = createFakeMic();
    await act(async () => {
      resolveToggleMic(toggleMic.handle);
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(handle.state.phase).toBe("recording");
    await act(async () => { await handle.stop("user"); });
  });

  it("V-21b: DictationPill resets expanded replacement list when a new pill arrives", () => {
    const pillA: PillState = {
      id: "dic_a",
      polished: false,
      canRevert: false,
      rawText: "天海林音",
      finalText: "天海凛音",
      replacements: [{ start: 0, end: 4, original: "天海林音", replacement: "天海凛音", term: "天海凛音", termId: "t1", score: 0.9 }],
      suggestion: null,
      anchorRect: null,
    };
    const pillB: PillState = { ...pillA, id: "dic_b" };

    const { rerender } = render(
      <DictationPill t={i18n.t} pill={pillA} onRevert={() => undefined} onDecideSuggestion={() => undefined} onDismiss={() => undefined} />,
    );
    fireEvent.click(screen.getByTestId("dictation-pill-terms-toggle"));
    expect(screen.getByTestId("dictation-pill-term-0")).toBeTruthy();

    rerender(
      <DictationPill t={i18n.t} pill={pillB} onRevert={() => undefined} onDecideSuggestion={() => undefined} onDismiss={() => undefined} />,
    );
    expect(screen.queryByTestId("dictation-pill-term-0")).toBeNull();
  });

  it("V-21c: RecordingReview fetches audioHandle without redundant capture.review reload and re-seeks on loadedmetadata", async () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const host = installHost({
      "capture.list": () => ({ sessions: [] }),
      "capture.review": () => ({
        session: {
          id: "cap_r1",
          mode: "toggle",
          retention: "keep",
          stage: "done",
          audioState: "retained",
          playable: true,
          durationMs: 10_000,
          createdAt: "2026-11-20T00:00:00Z",
          workId: null,
          resourceId: null,
          error: null,
          segments: { total: 1, done: 1, failed: 0, pending: 0, noSpeech: 0 },
          speechMs: 5000,
        },
        segments: [
          {
            id: "seg_1",
            seq: 0,
            startMs: 3500,
            endMs: 6000,
            text: "测试片段",
            originalText: "测试片段",
            revised: false,
            state: "done",
            precision: "segment",
            calibrated: false,
            anchors: [],
            attempts: 1,
            error: null,
          },
        ],
        filtered: [],
        drafts: [],
        audio: { state: "retained", playable: true },
      }),
      "capture.audioHandle": () => ({ url: "manga-media://audio/cap_r1.wav" }),
    });

    render(
      <RecordingReview
        t={i18n.t}
        scope={{}}
        initialSessionId="cap_r1"
        onJump={() => undefined}
        onOpenNote={() => undefined}
        formatDate={(d) => d}
      />,
    );

    const playBtn = await screen.findByTestId("review-play-seg_1");
    expect(host.of("capture.review")).toHaveLength(1);

    await act(async () => {
      fireEvent.click(playBtn);
    });
    expect(host.of("capture.audioHandle")).toHaveLength(1);
    // Must NOT trigger a redundant `capture.review` reload on first Play.
    expect(host.of("capture.review")).toHaveLength(1);
    expect(playSpy).toHaveBeenCalledTimes(1);

    // Simulate Chromium resetting currentTime to 0 before `loadedmetadata` fires while readyState === 0.
    const audioEl = screen.getByTestId("review-audio") as HTMLAudioElement;
    audioEl.currentTime = 0;
    act(() => {
      audioEl.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(audioEl.currentTime).toBeCloseTo(3.5, 2);
    expect(pauseSpy).not.toHaveBeenCalled();
  });
});
