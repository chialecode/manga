import workletUrl from "./pcm-worklet.ts?worker&url";
import type { MicHandle } from "./recorder.ts";

const SAMPLE_RATE = 16_000;

/**
 * The browser microphone as a `MicHandle`: a 16 kHz context (the browser resamples the device), the PCM worklet, and a
 * silent output so the graph keeps being pulled. A saved device that is gone falls back to the default one. The permission
 * prompt, a refusal or a missing device surface as the browser's own errors, which the recorder maps.
 */
export async function openMicrophone(deviceId: string | null): Promise<MicHandle> {
  const constraints = (exact: string | null): MediaStreamConstraints => ({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, ...(exact ? { deviceId: { exact } } : {}) },
  });
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints(deviceId));
  } catch (error) {
    // The chosen device is not there any more: use whatever the system offers rather than refusing to record.
    const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
    if (deviceId && (name === "OverconstrainedError" || name === "NotFoundError")) stream = await navigator.mediaDevices.getUserMedia(constraints(null));
    else throw error;
  }
  const track = stream.getAudioTracks()[0];
  if (!track) {
    stream.getTracks().forEach((item) => item.stop());
    throw Object.assign(new Error("no audio track"), { name: "NotFoundError" });
  }
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
