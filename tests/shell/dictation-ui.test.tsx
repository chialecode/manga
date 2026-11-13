/** @vitest-environment jsdom */
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createTranslator } from "@manga/i18n";
import { resolveKeys } from "@manga/contracts/keys";
import { DEFAULT_MODEL_PROFILE } from "@manga/contracts/models";
import { DictationCapsule } from "../../apps/desktop/src/renderer/voice/dictation-capsule.tsx";
import { DictationPill } from "../../apps/desktop/src/renderer/voice/dictation-pill.tsx";
import {
  DOUBLE_TAP_MS,
  HOLD_MIN_MS,
  useDictation,
} from "../../apps/desktop/src/renderer/voice/use-dictation.ts";
import { DEFAULT_RECORDING_SETTINGS, type RecordingPatch, type RecordingSettings } from "../../apps/desktop/src/renderer/voice/use-recorder.ts";
import type { MicHandle } from "../../apps/desktop/src/renderer/voice/recorder.ts";
import { getMicDiagnostics, openMicrophone, resetMicDiagnostics } from "../../apps/desktop/src/renderer/voice/mic.ts";
import { resetCompositionState } from "../../apps/desktop/src/renderer/voice/editable-target.ts";
import { Composer } from "../../apps/desktop/src/renderer/components/chat/composer.tsx";
import { DebugPanel } from "../../apps/desktop/src/renderer/pages/debug-panel.tsx";
import { VoicePage } from "../../apps/desktop/src/renderer/pages/settings/voice-page.tsx";
import { ModelsPage } from "../../apps/desktop/src/renderer/pages/settings/models-page.tsx";
import type { ConnectionForm } from "../../apps/desktop/src/renderer/lib/types.ts";

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
      return () => {
        listeners.delete(listener);
      };
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

function createFakeMic(label = "Logitech Studio USB") {
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

afterEach(() => {
  cleanup();
  resetMicDiagnostics();
  resetCompositionState();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Dictation controller, capsule, and inline revert/suggestion pill (U1)", () => {
  it("streams hold-to-talk audio on solo RightAlt, inserts raw then polished text, expands replacements, and reverts to raw", async () => {
    let clock = 1_000;
    const mic = createFakeMic("Logitech Studio USB");
    const notices: Array<{ text?: string; action?: { label: string; onClick: () => void } }> = [];
    const host = installHost({
      "dictation.start": () => ({ dictationId: "dic_1", stage: "recording", loadingModel: true }),
      "dictation.append": () => ({}),
      "dictation.stop": () => ({
        dictationId: "dic_1",
        stage: "done",
        rawText: "天海林音是谁",
        correctedText: "天海凛音是谁",
        finalText: "天海凛音是谁？",
        replacements: [
          { start: 0, end: 4, original: "天海林音", replacement: "天海凛音", term: "天海凛音", termId: "term_1", score: 0.94 },
        ],
      }),
    });

    function Harness() {
      const [text, setText] = useState("");
      const [settings] = useState<RecordingSettings>({
        ...DEFAULT_RECORDING_SETTINGS,
        dictationInsertMode: "stream_replace",
        polishMode: "light",
      });
      const dictation = useDictation({
        i18n,
        enabled: true,
        settings,
        keyTable: resolveKeys(null),
        workId: "work_star",
        setError: () => undefined,
        setNotice: (msg, action) => notices.push({ text: msg, action }),
        openMic: async () => mic.handle,
        now: () => clock,
      });
      return (
        <div className="dock-pane">
          <textarea data-testid="target-box" value={text} onChange={(event) => setText(event.target.value)} />
          <DictationCapsule
            t={i18n.t}
            active={dictation.active}
            stage={dictation.stage}
            mode={dictation.mode}
            elapsedMs={dictation.elapsedMs}
            level={dictation.level}
            anchor={dictation.anchor}
            onStop={() => void dictation.stop("user")}
            onCancel={() => void dictation.cancel()}
          />
          <DictationPill
            t={i18n.t}
            pill={dictation.pill}
            onRevert={dictation.revertLast}
            onDecideSuggestion={(id, action) => void dictation.decideSuggestion(id, action)}
            onDismiss={dictation.dismissPill}
          />
        </div>
      );
    }

    render(<Harness />);
    const area = screen.getByTestId("target-box") as HTMLTextAreaElement;
    area.focus();

    // Standalone RightAlt keydown calls preventDefault to suppress Windows/Linux menu focus
    const downEvent = new KeyboardEvent("keydown", { key: "Alt", code: "AltRight", altKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(downEvent);
    });
    expect(downEvent.defaultPrevented).toBe(true);

    // Key auto-repeat is ignored while still suppressing menu bar focus
    const repeatEvent = new KeyboardEvent("keydown", { key: "Alt", code: "AltRight", altKey: true, repeat: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(repeatEvent);
    });
    expect(repeatEvent.defaultPrevented).toBe(true);

    const capsule = await screen.findByTestId("dictation-capsule");
    expect(capsule.getAttribute("role")).toBe("status");
    expect(capsule.getAttribute("aria-live")).toBe("polite");
    // Device name must NEVER appear in capsule UI
    expect(capsule.textContent).not.toContain("Logitech");
    await waitFor(() => expect(screen.getByTestId("dictation-capsule-stage").textContent).toBe("正在载入模型"));
    expect(host.of("dictation.start")).toHaveLength(1);
    expect(host.of("dictation.start")[0]!.input).toMatchObject({ mode: "hold", workId: "work_star", sampleRate: 16000 });

    // Streaming audio updates level and elapsed clock
    act(() => {
      mic.pushChunk(16_000, 0.4);
    });
    await waitFor(() => expect(host.of("dictation.append")).toHaveLength(1));
    expect(screen.getByTestId("dictation-capsule-time").textContent).toBe("0:01");
    expect(capsule.getAttribute("data-voice-state")).toBe("sound");

    // Stream-replace: intermediate polishing notice inserts rawText immediately
    act(() => {
      host.emit("dictation.changed", { dictationId: "dic_1", stage: "polishing", rawText: "天海林音是谁" });
    });
    expect(screen.getByTestId("dictation-capsule-stage").textContent).toBe("润色中");
    expect(area.value).toBe("天海林音是谁");

    // Hold >= 250ms then release RightAlt -> stops and replaces rawText with polished finalText
    clock += HOLD_MIN_MS + 100;
    const upEvent = new KeyboardEvent("keyup", { key: "Alt", code: "AltRight", altKey: false, bubbles: true, cancelable: true });
    await act(async () => {
      window.dispatchEvent(upEvent);
    });
    expect(upEvent.defaultPrevented).toBe(true);

    await waitFor(() => expect(area.value).toBe("天海凛音是谁？"));
    expect(screen.queryByTestId("dictation-capsule")).toBeNull();

    // Post-insert inline pill shows "已润色 · 恢复原文" and expandable replacement attribution
    const pill = screen.getByTestId("dictation-pill");
    expect(screen.getByTestId("dictation-pill-status").textContent).toBe("已润色");
    expect(!fireEvent.mouseDown(pill)).toBe(true);

    fireEvent.click(screen.getByTestId("dictation-pill-terms-toggle"));
    expect(screen.getByTestId("dictation-pill-term-0").textContent).toContain("天海林音");
    expect(screen.getByTestId("dictation-pill-term-0").textContent).toContain("天海凛音");

    // Clicking "恢复原文" reverts textarea back to raw ASR text
    fireEvent.click(screen.getByTestId("dictation-pill-revert"));
    expect(area.value).toBe("天海林音是谁");
    expect(notices.some((n) => n.text?.includes("已恢复识别原文"))).toBe(true);
  });

  it("supports final_only mode, <350ms double-tap hands-free lock with 结束 button, Esc cancel, and combo key abort", async () => {
    let clock = 5_000;
    const mic = createFakeMic();
    let sawEmptyDuringPolish = false;
    let host!: ReturnType<typeof installHost>;
    host = installHost({
      "dictation.start": () => ({ dictationId: "dic_lock", stage: "recording" }),
      "dictation.stop": () => {
        // In final_only mode, intermediate rawText emitted during polishing must NOT write into textarea before done
        host.emit("dictation.changed", { dictationId: "dic_lock", stage: "polishing", rawText: "原句" });
        const el = document.querySelector("[data-testid='lock-area']") as HTMLTextAreaElement | null;
        sawEmptyDuringPolish = el?.value === "";
        return {
          dictationId: "dic_lock",
          stage: "done",
          rawText: "原句",
          finalText: "整句写入",
        };
      },
      "dictation.cancel": () => ({}),
    });

    function Harness() {
      const [text, setText] = useState("");
      const dictation = useDictation({
        i18n,
        enabled: true,
        settings: { ...DEFAULT_RECORDING_SETTINGS, dictationInsertMode: "final_only", polishMode: "light" },
        keyTable: resolveKeys(null),
        setError: () => undefined,
        setNotice: () => undefined,
        openMic: async () => mic.handle,
        now: () => clock,
      });
      return (
        <div>
          <textarea data-testid="lock-area" value={text} onChange={(event) => setText(event.target.value)} />
          <DictationCapsule
            t={i18n.t}
            active={dictation.active}
            stage={dictation.stage}
            mode={dictation.mode}
            elapsedMs={dictation.elapsedMs}
            level={dictation.level}
            anchor={dictation.anchor}
            onStop={() => void dictation.stop("user")}
            onCancel={() => void dictation.cancel()}
          />
        </div>
      );
    }

    render(<Harness />);
    const area = screen.getByTestId("lock-area") as HTMLTextAreaElement;
    area.focus();

    // First tap (< 250ms)
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", code: "AltRight", altKey: true, bubbles: true, cancelable: true }));
    });
    await screen.findByTestId("dictation-capsule");
    clock += 80;
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", code: "AltRight", bubbles: true, cancelable: true }));
    });

    // Second tap within 350ms locks hands-free mode and renders "结束" button
    clock += Math.floor(DOUBLE_TAP_MS / 2);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", code: "AltRight", altKey: true, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Alt", code: "AltRight", bubbles: true, cancelable: true }));
    });

    const stopBtn = await screen.findByTestId("dictation-stop");
    expect(screen.getByTestId("dictation-capsule").getAttribute("data-mode")).toBe("locked");
    expect(!fireEvent.mouseDown(stopBtn)).toBe(true);

    // Clicking "结束" stops, ignores rawText during polishing (final_only), and inserts finalText on done
    await act(async () => {
      fireEvent.click(stopBtn);
    });
    expect(sawEmptyDuringPolish).toBe(true);
    await waitFor(() => expect(area.value).toBe("整句写入"));

    // Start another hold, then press another key while RightAlt is down -> aborts hold without eating the combo key
    clock += 1_000;
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", code: "AltRight", altKey: true, bubbles: true, cancelable: true }));
    });
    await screen.findByTestId("dictation-capsule");
    const comboKey = new KeyboardEvent("keydown", { key: "ArrowLeft", code: "ArrowLeft", altKey: true, bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(comboKey);
    });
    expect(comboKey.defaultPrevented).toBe(false);
    await waitFor(() => expect(screen.queryByTestId("dictation-capsule")).toBeNull());
    expect(host.of("dictation.cancel").length).toBeGreaterThanOrEqual(1);

    // Start via Esc cancel test
    clock += 1_000;
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Alt", code: "AltRight", altKey: true, bubbles: true, cancelable: true }));
    });
    await screen.findByTestId("dictation-capsule");
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    });
    await waitFor(() => expect(screen.queryByTestId("dictation-capsule")).toBeNull());
  });

  it("shows copy notice when target unmounts mid-recognition and surfaces inline learned suggestion after user edit", async () => {
    const mic = createFakeMic();
    const notices: Array<{ text?: string; action?: { label: string; onClick: () => void } }> = [];
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const host = installHost({
      "dictation.start": () => ({ dictationId: "dic_unmount", stage: "recording" }),
      "dictation.stop": () => ({ dictationId: "dic_unmount", stage: "done", rawText: "草稿已关", finalText: "草稿已关" }),
      "dictionary.observeEdit": () => ({
        suggestion: {
          id: "sug_1",
          scope: "work",
          workId: "work_1",
          heard: "星野仓真",
          term: "星野苍真",
          score: 0.91,
          status: "pending",
          createdAt: "2026-11-12T10:00:00Z",
          updatedAt: "2026-11-12T10:00:00Z",
        },
      }),
      "dictionary.suggestions.decide": () => ({}),
    });

    function Harness() {
      const [mounted, setMounted] = useState(true);
      const [text, setText] = useState("");
      const dictation = useDictation({
        i18n,
        enabled: true,
        settings: DEFAULT_RECORDING_SETTINGS,
        keyTable: resolveKeys(null),
        workId: "work_1",
        setError: () => undefined,
        setNotice: (msg, action) => notices.push({ text: msg, action }),
        openMic: async () => mic.handle,
      });
      return (
        <div>
          {mounted ? <textarea data-testid="ephemeral-target" value={text} onChange={(e) => setText(e.target.value)} /> : null}
          <button type="button" data-testid="unmount-btn" onClick={() => setMounted(false)}>close</button>
          <button type="button" data-testid="remount-btn" onClick={() => setMounted(true)}>open</button>
          <button type="button" data-testid="toggle-btn" onClick={() => dictation.toggleFromButton(document.querySelector("[data-testid='ephemeral-target']"))}>mic</button>
          <DictationPill
            t={i18n.t}
            pill={dictation.pill}
            onRevert={dictation.revertLast}
            onDecideSuggestion={(id, action) => void dictation.decideSuggestion(id, action)}
            onDismiss={dictation.dismissPill}
          />
        </div>
      );
    }

    render(<Harness />);
    const target = screen.getByTestId("ephemeral-target") as HTMLTextAreaElement;
    target.focus();

    fireEvent.click(screen.getByTestId("toggle-btn"));
    await waitFor(() => expect(host.of("dictation.start")).toHaveLength(1));

    // Unmount the target BEFORE dictation completes
    fireEvent.click(screen.getByTestId("unmount-btn"));
    fireEvent.click(screen.getByTestId("toggle-btn"));

    await waitFor(() => expect(notices.some((n) => n.action?.label === "复制")).toBe(true));
    const copyNotice = notices.find((n) => n.action?.label === "复制")!;
    expect(copyNotice.text).toContain("草稿已关");
    copyNotice.action!.onClick();
    expect(writeText).toHaveBeenCalledWith("草稿已关");

    // Remount and test 60s edit observation -> dictionary.observeEdit -> inline suggestion pill accept
    fireEvent.click(screen.getByTestId("remount-btn"));
    const liveTarget = screen.getByTestId("ephemeral-target") as HTMLTextAreaElement;
    liveTarget.focus();

    let run = 0;
    installHost({
      "dictation.start": () => ({ dictationId: `dic_${++run}`, stage: "recording" }),
      "dictation.stop": () => ({ dictationId: `dic_${run}`, stage: "done", rawText: "星野仓真", finalText: "星野仓真" }),
      "dictionary.observeEdit": host.of ? () => ({
        suggestion: {
          id: "sug_1",
          scope: "work",
          workId: "work_1",
          heard: "星野仓真",
          term: "星野苍真",
          score: 0.91,
          status: "pending",
          createdAt: "2026-11-12T10:00:00Z",
          updatedAt: "2026-11-12T10:00:00Z",
        },
      }) : () => ({}),
      "dictionary.suggestions.decide": (input) => {
        host.calls.push({ commandId: "dictionary.suggestions.decide", input });
        return {};
      },
    });

    fireEvent.click(screen.getByTestId("toggle-btn"));
    await waitFor(() => expect(run).toBe(1));
    fireEvent.click(screen.getByTestId("toggle-btn"));
    await waitFor(() => expect(liveTarget.value).toBe("星野仓真"));

    // User edits "星野仓真" -> "星野苍真" and blurs
    fireEvent.change(liveTarget, { target: { value: "星野苍真" } });
    fireEvent.blur(liveTarget);

    const suggestionBox = await screen.findByTestId("dictation-pill-suggestion");
    expect(suggestionBox.textContent).toContain("星野苍真");
    fireEvent.click(screen.getByTestId("dictation-pill-suggestion-accept"));
    await waitFor(() => expect(host.of("dictionary.suggestions.decide")).toEqual([
      { commandId: "dictionary.suggestions.decide", input: { suggestionId: "sug_1", action: "accept" } },
    ]));
  });

  it("switches DictationCapsule to 2-state sound/silent indicator under prefers-reduced-motion", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }));

    const { rerender } = render(
      <DictationCapsule
        t={i18n.t}
        active={true}
        stage="recording"
        mode="hold"
        elapsedMs={2_000}
        level={0.01}
        anchor={null}
        onStop={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByTestId("dictation-capsule").getAttribute("data-motion")).toBe("reduced");
    expect(screen.getByTestId("dictation-capsule").getAttribute("data-voice-state")).toBe("silent");
    expect(screen.getByTestId("dictation-capsule-mic").style.transform).toBe("");

    rerender(
      <DictationCapsule
        t={i18n.t}
        active={true}
        stage="recording"
        mode="hold"
        elapsedMs={2_500}
        level={0.6}
        anchor={null}
        onStop={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByTestId("dictation-capsule").getAttribute("data-voice-state")).toBe("sound");
    expect(screen.getByTestId("dictation-capsule-mic").style.transform).toBe("");
  });

  it("separates Chat Composer mic behavior: ask mode triggers dictation into draft without sending, note mode uses recorder", () => {
    const onSend = vi.fn();
    const onDictationToggle = vi.fn();
    const onRecorderToggle = vi.fn();

    const baseProps = {
      t: i18n.t,
      value: "",
      onChange: () => undefined,
      onMode: () => undefined,
      tags: [],
      images: [],
      onRemoveTag: () => undefined,
      onRemoveImage: () => undefined,
      quick: [],
      onQuick: () => undefined,
      noModel: false,
      onSettings: () => undefined,
      running: false,
      onStop: () => undefined,
      onSend,
      sending: false,
      plus: { attach: null, online: false, subtitle: false, allowOnline: false, subtitleAheadMin: 0, materials: 0 },
      onAttach: () => undefined,
      onToggleOnline: () => undefined,
      onSubtitleAhead: () => undefined,
      onMaterials: () => undefined,
      mic: {
        t: i18n.t,
        state: { phase: "idle" as const, elapsedMs: 0, level: 0 },
        enabled: true,
        toggleKey: "F8",
        onToggle: onRecorderToggle,
        onHoldStart: () => undefined,
        onHoldEnd: () => undefined,
        onStop: () => undefined,
      },
      dictation: {
        active: false,
        onToggle: onDictationToggle,
      },
    };

    const { rerender } = render(<Composer {...baseProps} mode="ask" />);
    const askMic = screen.getByTestId("chat-mic");
    expect(askMic.getAttribute("data-mode")).toBe("dictation");
    fireEvent.click(askMic);
    expect(onDictationToggle).toHaveBeenCalledTimes(1);
    expect(onDictationToggle.mock.calls[0]![0]).toBe(screen.getByTestId("agent-composer"));
    expect(onRecorderToggle).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();

    rerender(<Composer {...baseProps} mode="note" />);
    const noteMic = screen.getByTestId("chat-mic");
    expect(noteMic.getAttribute("data-mode")).toBeNull();
    expect(noteMic.getAttribute("aria-label")).toContain("F8");
  });
});

describe("Audio capture constraints, system loopback AEC fallback, and DebugPanel diagnostics (A1)", () => {
  it("disables browser noiseSuppression by default, falls back when echoCancellation 'all' is unsupported, and renders applied settings in DebugPanel", async () => {
    installHost({ "debug.context": () => ({ scope: { page: "chat" }, model: null, tools: [], budget: {} }) });

    const seenConstraints: MediaStreamConstraints[] = [];
    const fakeTrack = {
      label: "Built-in Mic",
      stop: vi.fn(),
      addEventListener: vi.fn(),
      getSettings: () => ({
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: true,
        sampleRate: 16000,
        channelCount: 1,
      }),
    };
    const getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => {
      seenConstraints.push(constraints);
      const audio = constraints.audio as Record<string, unknown>;
      if (audio.echoCancellation === "all") {
        throw Object.assign(new Error("echoCancellation all unsupported"), { name: "OverconstrainedError" });
      }
      return {
        getAudioTracks: () => [fakeTrack],
        getTracks: () => [fakeTrack],
      } as unknown as MediaStream;
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia, enumerateDevices: async () => [] },
    });

    class FakeAudioContext {
      audioWorklet = { addModule: async () => undefined };
      destination = {};
      createMediaStreamSource() { return { connect: () => undefined, disconnect: () => undefined }; }
      createGain() { return { gain: { value: 1 }, connect: () => undefined }; }
      async close() { return undefined; }
    }
    class FakeWorkletNode {
      port = { onmessage: null };
      connect() { return undefined; }
      disconnect() { return undefined; }
    }
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);

    let fallbackNotified = false;
    const mic = await openMicrophone(null, {
      echoCancellation: true,
      systemLoopbackAec: true,
      onSystemAecFallback: () => { fallbackNotified = true; },
    });

    expect(fallbackNotified).toBe(true);
    expect(seenConstraints).toHaveLength(2);
    expect((seenConstraints[0]!.audio as Record<string, unknown>).echoCancellation).toBe("all");
    expect((seenConstraints[0]!.audio as Record<string, unknown>).noiseSuppression).toBe(false);
    expect((seenConstraints[1]!.audio as Record<string, unknown>).echoCancellation).toBe(true);

    const diag = getMicDiagnostics();
    expect(diag?.systemAecFallback).toBe(true);
    expect(diag?.applied).toMatchObject({ echoCancellation: true, noiseSuppression: false, sampleRate: 16000 });

    render(
      <DebugPanel
        t={i18n.t}
        view={{ open: true, height: 260, tab: "current" }}
        onView={() => undefined}
        scope={{ page: "chat" }}
        live={{}}
        events={[]}
        version={1}
        onNotice={() => undefined}
      />,
    );

    const debugAudio = await screen.findByTestId("debug-audio");
    expect(debugAudio.getAttribute("data-fallback")).toBe("true");
    expect(screen.getByTestId("debug-audio-applied").textContent).toContain('"noiseSuppression":false');
    expect(screen.getByTestId("debug-audio-fallback").textContent).toContain("回退");
    mic.stop();
  });
});

describe("Voice transcription settings 5 sections, local ASR models, dictionary extensions, history, and ConnectionDialog", () => {
  it("renders all 5 sections, confirms local model download before starting, manages batch/suggestions/enrich, and retranscribes history", async () => {
    let modelState: "not_installed" | "downloading" | "installed" = "not_installed";
    let historyItems = [
      {
        id: "h1",
        workId: null,
        engineKind: "local",
        engineId: "sensevoice",
        modelId: "SenseVoice Small",
        polishMode: "light" as const,
        rawText: "天海林音",
        correctedText: "天海凛音",
        finalText: "天海凛音。",
        fallbackReason: null,
        timings: { totalMs: 2400 },
        replacements: [],
        audioAvailable: true,
        audioExpiresAt: "2026-11-13T12:00:00Z",
        createdAt: "2026-11-12T12:00:00Z",
      },
    ];
    let suggestions = [
      {
        id: "sug_9",
        scope: "global" as const,
        workId: null,
        heard: "千夏",
        term: "雾岛千夏",
        score: 0.92,
        status: "pending" as const,
        createdAt: "2026-11-12T12:00:00Z",
        updatedAt: "2026-11-12T12:00:00Z",
      },
    ];
    const savedPatches: RecordingPatch[] = [];
    const notices: string[] = [];

    const host = installHost({
      "dictionary.prompt": () => ({ text: "", included: [], total: 0, cut: 0, limit: 600, connectionId: null, language: null }),
      "dictionary.list": () => ({ terms: [{ id: "t1", scope: "global", workId: null, term: "天海凛音", heard: null, source: "manual", auto: false, disabled: false, aliases: [{ alias: "天海林音", kind: "alias" }], blocked: ["天海林"] }] }),
      "dictionary.suggestions.list": () => ({ suggestions }),
      "dictionary.suggestions.decide": (input) => {
        suggestions = suggestions.filter((s) => s.id !== input.suggestionId);
        return {};
      },
      "dictionary.importBatch": () => ({ added: 2, skipped: 0 }),
      "dictionary.update": () => ({}),
      "asrModel.list": () => ({
        models: [
          {
            modelId: "sensevoice",
            name: "SenseVoice Small",
            kind: "sensevoice",
            languages: ["zh", "ja", "en"],
            hotwords: 0,
            license: "Apache-2.0",
            licenseUrl: "https://www.apache.org/licenses/LICENSE-2.0",
            archiveName: "sensevoice.tar.bz2",
            archiveBytes: 240 * 1024 * 1024,
            archiveSha256: "a".repeat(64),
            state: modelState,
            sources: [
              { id: "mirror", label: "国内镜像", url: "https://example.com/mirror.tar.bz2" },
              { id: "hf", label: "HuggingFace", url: "https://example.com/hf.tar.bz2" },
            ],
          },
          {
            modelId: "paraformer",
            name: "Paraformer zh",
            kind: "paraformer",
            languages: ["zh"],
            hotwords: 50,
            license: "MIT",
            licenseUrl: "https://opensource.org/licenses/MIT",
            archiveName: "paraformer.tar.bz2",
            archiveBytes: 220 * 1024 * 1024,
            installedBytes: 220 * 1024 * 1024,
            archiveSha256: "b".repeat(64),
            state: "ready",
            sources: [{ id: "mirror", label: "国内镜像", url: "https://example.com/paraformer.tar.bz2" }],
          },
        ],
      }),
      "asrModel.download": () => {
        modelState = "downloading";
        return {};
      },
      "dictation.history.list": () => ({ items: historyItems }),
      "dictation.history.retranscribe": () => ({}),
      "dictation.history.delete": (input) => {
        historyItems = historyItems.filter((item) => item.id !== input.historyId);
        return {};
      },
      "dictation.history.clear": () => {
        historyItems = [];
        return {};
      },
    });

    function PageHarness() {
      const [settings, setSettings] = useState<RecordingSettings>(DEFAULT_RECORDING_SETTINGS);
      return (
        <VoicePage
          t={i18n.t}
          settings={{
            connections: [
              { id: "c_asr", label: "远端转录", modelId: "whisper-1", purpose: "transcription" },
              { id: "c_llm", label: "润色文本模型", modelId: "gpt-4o-mini", purpose: "text" },
            ],
          }}
          recording={{
            settings,
            save: async (patch) => {
              savedPatches.push(patch);
              setSettings((cur) => ({ ...cur, ...patch }));
            },
          }}
          keyTable={resolveKeys(null)}
          onGoto={() => undefined}
          onError={() => undefined}
          onNotice={(msg) => notices.push(msg)}
        />
      );
    }

    render(<PageHarness />);

    // All 5 sections exist
    expect(screen.getByTestId("voice-dictation-section")).toBeTruthy();
    expect(screen.getByTestId("voice-engines-section")).toBeTruthy();
    expect(screen.getByTestId("voice-audio-section")).toBeTruthy();
    expect(screen.getByTestId("voice-dictionary")).toBeTruthy();
    expect(screen.getByTestId("voice-history-section")).toBeTruthy();
    expect(screen.getByTestId("voice-dictation-shortcut").textContent).toBe("右 Alt");

    // Separate engine selectors for dictation vs capture (including loaded "ready" local model + delete button)
    await waitFor(() => expect(screen.getByTestId("voice-model-sensevoice")).toBeTruthy());
    expect(screen.getByTestId("voice-model-delete-paraformer")).toBeTruthy();
    fireEvent.change(screen.getByTestId("voice-dictation-engine"), { target: { value: "local:paraformer" } });
    expect(savedPatches.at(-1)).toEqual({ dictationEngine: { kind: "local", modelId: "paraformer" } });
    fireEvent.change(screen.getByTestId("voice-capture-engine"), { target: { value: "connection:c_asr" } });
    expect(savedPatches.at(-1)).toEqual({ captureEngine: { kind: "connection", connectionId: "c_asr" } });

    // Local ASR download requires confirmation dialog with size, license, and download source
    fireEvent.click(screen.getByTestId("voice-model-download-sensevoice"));
    const dialog = screen.getByTestId("voice-model-confirm-dialog");
    expect(dialog.textContent).toContain("240 MiB");
    expect(dialog.textContent).toContain("Apache-2.0");
    fireEvent.change(screen.getByTestId("voice-model-source"), { target: { value: "hf" } });
    fireEvent.click(screen.getByTestId("voice-model-confirm-do"));
    await waitFor(() => expect(host.of("asrModel.download")).toEqual([
      { commandId: "asrModel.download", input: { modelId: "sensevoice", confirmed: true, sourceId: "hf" } },
    ]));
    await waitFor(() => expect(screen.getByTestId("voice-model-pause-sensevoice")).toBeTruthy());

    // Dictionary learned suggestion accept + batch import + term disable toggle
    await waitFor(() => expect(screen.getByTestId("dictionary-suggestion-sug_9")).toBeTruthy());
    fireEvent.click(screen.getByTestId("dictionary-suggestion-accept-sug_9"));
    await waitFor(() => expect(host.of("dictionary.suggestions.decide")).toEqual([
      { commandId: "dictionary.suggestions.decide", input: { suggestionId: "sug_9", action: "accept" } },
    ]));

    fireEvent.click(screen.getByTestId("dictionary-batch-toggle"));
    fireEvent.change(screen.getByTestId("dictionary-batch-text"), { target: { value: "神代遥香 | 神代遥卡, 遥香\n白石朔夜" } });
    fireEvent.change(screen.getByTestId("dictionary-batch-category"), { target: { value: "character" } });
    fireEvent.click(screen.getByTestId("dictionary-batch-submit"));
    await waitFor(() => expect(host.of("dictionary.importBatch")[0]!.input).toEqual({
      scope: "global",
      text: "神代遥香 | 神代遥卡, 遥香\n白石朔夜",
      category: "character",
    }));

    fireEvent.click(screen.getByTestId("dictionary-toggle-t1"));
    await waitFor(() => expect(host.of("dictionary.update")[0]!.input).toEqual({ termId: "t1", disabled: true }));

    // Dictation history 24h audio retention toggle + re-transcribe with another engine + clear
    fireEvent.click(screen.getByTestId("voice-retain-audio-24h"));
    expect(savedPatches.at(-1)).toEqual({ retainDictationAudio24h: true });

    await waitFor(() => expect(screen.getByTestId("voice-history-h1")).toBeTruthy());
    fireEvent.change(screen.getByTestId("voice-history-engine-h1"), { target: { value: "connection:c_asr" } });
    fireEvent.click(screen.getByTestId("voice-history-retranscribe-h1"));
    await waitFor(() => expect(host.of("dictation.history.retranscribe")).toEqual([
      { commandId: "dictation.history.retranscribe", input: { historyId: "h1", engine: { kind: "connection", connectionId: "c_asr" } } },
    ]));

    fireEvent.click(screen.getByTestId("voice-history-clear"));
    await waitFor(() => expect(screen.getByTestId("voice-history-empty")).toBeTruthy());
  });

  it("offers transcriptionInterface selector in ConnectionDialog when purpose is transcription", async () => {
    const savedForms: ConnectionForm[] = [];
    render(
      <ModelsPage
        i18n={i18n}
        settings={{ connections: [], aiRuntime: "native", needsSetup: false }}
        onRuntime={async () => undefined}
        onSaveConnection={async (form) => {
          savedForms.push(form);
          return { ok: true, id: "conn_audio" };
        }}
        onDeleteConnection={async () => undefined}
        onTestConnection={async () => ({ ok: true, message: "ok" })}
        onProbeConnection={async () => undefined}
        onSkip={() => undefined}
      />,
    );

    fireEvent.click(screen.getByTestId("models-add"));
    expect(screen.queryByTestId("connection-transcription-interface")).toBeNull();

    fireEvent.change(screen.getByTestId("connection-purpose"), { target: { value: "transcription" } });
    const ifaceSelect = screen.getByTestId("connection-transcription-interface") as HTMLSelectElement;
    expect(ifaceSelect.value).toBe(DEFAULT_MODEL_PROFILE.transcriptionInterface);
    expect(within(ifaceSelect).getAllByRole("option")).toHaveLength(2);

    fireEvent.change(ifaceSelect, { target: { value: "chat_input_audio" } });
    fireEvent.change(screen.getByTestId("connection-base-url"), { target: { value: "https://api.example.com/v1" } });
    fireEvent.change(screen.getByTestId("connection-model-id"), { target: { value: "gpt-4o-mini-transcribe" } });
    fireEvent.change(screen.getByTestId("connection-secret"), { target: { value: "sk-test-123" } });
    fireEvent.submit(document.getElementById("connection-form")!);

    await waitFor(() => expect(savedForms).toHaveLength(1));
    expect(savedForms[0]!.purpose).toBe("transcription");
    expect(savedForms[0]!.profile?.transcriptionInterface).toBe("chat_input_audio");
  });
});
