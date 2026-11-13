import workletUrl from "./pcm-worklet.ts?worker&url";
import type { MicHandle } from "./recorder.ts";

const SAMPLE_RATE = 16_000;

export type MicCaptureOptions = {
  echoCancellation?: boolean;
  systemLoopbackAec?: boolean;
  browserNoiseSuppression?: boolean;
  autoGainControl?: boolean;
  onSystemAecFallback?: () => void;
};

export type MicDiagnostics = {
  requestedAt: string;
  label: string;
  requested: {
    echoCancellation: boolean | "all";
    noiseSuppression: boolean;
    autoGainControl: boolean;
    channelCount: number;
    sampleRate: number;
  };
  applied: Record<string, unknown>;
  systemAecFallback: boolean;
};

let latestDiagnostics: MicDiagnostics | null = null;
const diagnosticListeners = new Set<() => void>();

function setMicDiagnostics(next: MicDiagnostics | null): void {
  latestDiagnostics = next;
  for (const listener of [...diagnosticListeners]) listener();
}

export function getMicDiagnostics(): MicDiagnostics | null {
  return latestDiagnostics;
}

export function subscribeMicDiagnostics(listener: () => void): () => void {
  diagnosticListeners.add(listener);
  return () => {
    diagnosticListeners.delete(listener);
  };
}

export function resetMicDiagnostics(): void {
  setMicDiagnostics(null);
}

function errorName(error: unknown): string {
  if (error instanceof TypeError) return "TypeError";
  if (error && typeof error === "object" && "name" in error) return String((error as { name: unknown }).name);
  return "";
}

/**
 * The browser microphone as a `MicHandle`: a 16 kHz context (the browser resamples the device), the PCM worklet, and a
 * silent output so the graph keeps being pulled. Browser noiseSuppression defaults to `false` so soft trailing syllables
 * are not clipped before VAD/ASR; `systemLoopbackAec` requests Chromium `echoCancellation: "all"` and falls back to `true`
 * when unsupported. Applied `track.getSettings()` are recorded for the debug panel.
 */
export async function openMicrophone(deviceId: string | null, options?: MicCaptureOptions): Promise<MicHandle> {
  const baseEcho = options?.echoCancellation ?? true;
  const wantedEcho: boolean | "all" = options?.systemLoopbackAec ? "all" : baseEcho;
  const noiseSuppression = options?.browserNoiseSuppression ?? false;
  const autoGainControl = options?.autoGainControl ?? true;

  const constraints = (exact: string | null, echo: boolean | "all"): MediaStreamConstraints => ({
    audio: {
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
      echoCancellation: echo as unknown as boolean,
      noiseSuppression,
      autoGainControl,
      ...(exact ? { deviceId: { exact } } : {}),
    },
  });

  let systemAecFallback = false;
  const acquire = async (exact: string | null): Promise<MediaStream> => {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints(exact, wantedEcho));
    } catch (error) {
      const name = errorName(error);
      if (wantedEcho === "all" && (name === "OverconstrainedError" || name === "TypeError")) {
        systemAecFallback = true;
        options?.onSystemAecFallback?.();
        return await navigator.mediaDevices.getUserMedia(constraints(exact, baseEcho));
      }
      throw error;
    }
  };

  let stream: MediaStream;
  try {
    stream = await acquire(deviceId);
  } catch (error) {
    // The chosen device is not there any more: use whatever the system offers rather than refusing to record.
    const name = errorName(error);
    if (deviceId && (name === "OverconstrainedError" || name === "NotFoundError")) stream = await acquire(null);
    else throw error;
  }

  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((item) => item.stop());
    throw Object.assign(new Error("no audio track"), { name: "NotFoundError" });
  }

  const applied = typeof track.getSettings === "function" ? ({ ...track.getSettings() } as Record<string, unknown>) : {};
  setMicDiagnostics({
    requestedAt: new Date().toISOString(),
    label: track.label || "default",
    requested: {
      echoCancellation: systemAecFallback ? baseEcho : wantedEcho,
      noiseSuppression,
      autoGainControl,
      channelCount: 1,
      sampleRate: SAMPLE_RATE,
    },
    applied,
    systemAecFallback,
  });

  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    await context.audioWorklet.addModule(workletUrl);
  } catch (error) {
    stream.getTracks().forEach((item) => item.stop());
    void context.close();
    throw error;
  }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "manga-pcm", { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const silent = context.createGain();
  silent.gain.value = 0;
  source.connect(node);
  node.connect(silent);
  silent.connect(context.destination);
  let onChunk: (pcm: Int16Array, level: number) => void = () => undefined;
  let onEnded: () => void = () => undefined;
  let stopped = false;
  node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; peak: number }>) => {
    if (!stopped) onChunk(new Int16Array(event.data.pcm), event.data.peak);
  };
  track.addEventListener("ended", () => { if (!stopped) onEnded(); });
  return {
    label: track.label || "default",
    onChunk: (listener) => { onChunk = listener; },
    onEnded: (listener) => { onEnded = listener; },
    stop() {
      if (stopped) return;
      stopped = true;
      try { source.disconnect(); node.disconnect(); } catch { /* already torn down */ }
      stream.getTracks().forEach((item) => item.stop());
      void context.close();
    },
  };
}

/** The input devices the system lists, for the settings choice. Labels are empty until the microphone has been allowed once. */
export async function listMicrophones(): Promise<Array<{ id: string; label: string }>> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === "audioinput" && device.deviceId !== "default" && device.deviceId !== "communications").map((device, index) => ({ id: device.deviceId, label: device.label || `#${index + 1}` }));
  } catch {
    return [];
  }
}
