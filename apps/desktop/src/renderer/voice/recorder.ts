import type { SourceLocator } from "@manga/contracts/location";
import type { CaptureEventReason, CaptureStopReason } from "@manga/contracts/media";

/** The microphone as the recorder sees it: 16 kHz mono chunks, a level for each, and an end it must react to. */
export type MicHandle = {
  label: string;
  onChunk: (listener: (pcm: Int16Array, level: number) => void) => void;
  /** The device went away (unplugged, permission withdrawn): the stream ended without the user asking. */
  onEnded: (listener: () => void) => void;
  stop: () => void;
};

export type RecorderPorts = {
  /** Run a command; a failed command throws an error with a `code`. */
  call: <T = Record<string, unknown>>(commandId: string, input: unknown, options?: { key?: string }) => Promise<T>;
  openMic: (deviceId: string | null) => Promise<MicHandle>;
  /** Milliseconds from any fixed origin. */
  now: () => number;
};

export type RecorderIssue = { code: "mic_denied" | "mic_missing" | "mic_failed" | "start_failed" | "append_failed"; message: string };

export type RecorderState = {
  phase: "idle" | "starting" | "recording" | "stopping";
  sessionId: string | null;
  mode: "hold" | "toggle" | null;
  retention: "keep" | "discard" | null;
  deviceLabel: string | null;
  /** Audio recorded so far, from the samples received. */
  elapsedMs: number;
  /** 0 to 1, of the last chunk. */
  level: number;
  issue: RecorderIssue | null;
  /** How the last recording ended, until the next one starts. */
  lastStop: { sessionId: string; reason: CaptureStopReason; durationMs: number; stage?: string; audioState?: string } | null;
};

export type StartOptions = {
  mode: "hold" | "toggle";
  resourceId?: string;
  resourceRevisionId?: string;
  locator?: SourceLocator;
  retention?: "keep" | "discard";
  deviceId?: string | null;
};

export type PositionInput = {
  reason: CaptureEventReason;
  resourceId?: string;
  resourceRevisionId?: string;
  locator?: SourceLocator;
  playing?: boolean;
  playbackRate?: number;
};

const SAMPLE_RATE = 16_000;
const idleState = (): RecorderState => ({ phase: "idle", sessionId: null, mode: null, retention: null, deviceLabel: null, elapsedMs: 0, level: 0, issue: null, lastStop: null });

const codeOf = (error: unknown): string => (error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "");
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * One recording at a time. The microphone is opened before a session exists, so a refused or missing device never makes a
 * session or a running clock; audio goes to the main process in order as it arrives; position events carry the audio
 * offset of the moment they happened; and however a recording ends, what was captured is handed over (never discarded).
 */
export class Recorder {
  private state: RecorderState = idleState();
  private readonly listeners = new Set<(state: RecorderState) => void>();
  private mic: MicHandle | null = null;
  private origin = 0;
  private samples = 0;
  private seq = 0;
  private events = 0;
  private chain: Promise<void> = Promise.resolve();
  private failed = false;
  private stopRequest: CaptureStopReason | null = null;
  private pendingStop: Promise<RecorderState["lastStop"]> | null = null;

  constructor(private readonly ports: RecorderPorts) {}

  getState = (): RecorderState => this.state;

  subscribe = (listener: (state: RecorderState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(patch: Partial<RecorderState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /** Where the audio clock stands now, for stamping an event. */
  offsetMs = (): number => Math.max(0, Math.round(this.ports.now() - this.origin));

  async start(options: StartOptions): Promise<boolean> {
    if (this.state.phase !== "idle") return false;
    this.stopRequest = null;
    this.set({ ...idleState(), phase: "starting", mode: options.mode, issue: null, lastStop: null });
    let mic: MicHandle;
    try {
      mic = await this.ports.openMic(options.deviceId ?? null);
    } catch (error) {
      const name = error && typeof error === "object" && "name" in error ? String((error as { name: unknown }).name) : "";
      const issue: RecorderIssue = name === "NotAllowedError" || name === "SecurityError" ? { code: "mic_denied", message: messageOf(error) }
        : name === "NotFoundError" || name === "OverconstrainedError" ? { code: "mic_missing", message: messageOf(error) }
          : { code: "mic_failed", message: messageOf(error) };
      this.set({ ...idleState(), issue });
      return false;
    }
    this.origin = this.ports.now();
    this.samples = 0;
    this.seq = 0;
    this.events = 0;
    this.failed = false;
    this.chain = Promise.resolve();
    // The user let go (hold mode) before the device was open: nothing was recorded, and nothing starts.
    if (this.stopRequest) {
      mic.stop();
      this.stopRequest = null;
      this.set(idleState());
      return false;
    }
    let started: { sessionId: string; retention: "keep" | "discard" };
    try {
      started = await this.ports.call("capture.start", {
        mode: options.mode,
        ...(options.resourceId ? { resourceId: options.resourceId } : {}),
        ...(options.resourceRevisionId ? { resourceRevisionId: options.resourceRevisionId } : {}),
        ...(options.locator ? { locator: options.locator } : {}),
        ...(options.retention ? { retention: options.retention } : {}),
        deviceLabel: mic.label,
      });
    } catch (error) {
      mic.stop();
      this.set({ ...idleState(), issue: { code: "start_failed", message: messageOf(error) } });
      return false;
    }
    this.mic = mic;
    const sessionId = started.sessionId;
    mic.onChunk((pcm, level) => this.onChunk(sessionId, pcm, level));
    mic.onEnded(() => { void this.stop("device_lost"); });
    this.set({ phase: "recording", sessionId, retention: started.retention, deviceLabel: mic.label, elapsedMs: 0, level: 0 });
    // A release that came while the session was being made ends it right away, with what little was captured.
    if (this.stopRequest) void this.stop(this.stopRequest);
    return true;
  }

  private onChunk(sessionId: string, pcm: Int16Array, level: number): void {
    if (this.state.sessionId !== sessionId || this.state.phase === "idle") return;
    const seq = this.seq++;
    this.samples += pcm.length;
    this.set({ elapsedMs: Math.round((this.samples * 1000) / SAMPLE_RATE), level: Math.min(1, Math.max(0, level)) });
    if (this.failed) return;
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    const data = btoa(binary);
    this.chain = this.chain.then(async () => {
      if (this.failed) return;
      try {
        await this.ports.call("capture.append", { sessionId, seq, data }, { key: `cap:${sessionId}:a${seq}` });
      } catch (error) {
        // Audio can no longer reach the recording: end it, keeping what arrived, and say so.
        this.failed = true;
        this.set({ issue: { code: "append_failed", message: messageOf(error) } });
        void this.stop("error");
      }
    });
  }

  /** A fact about where the reader is, stamped with the audio clock. Events outside a recording are ignored. */
  event(input: PositionInput): void {
    const sessionId = this.state.sessionId;
    if (this.state.phase !== "recording" || !sessionId) return;
    const index = this.events++;
    const offsetMs = this.offsetMs();
    this.chain = this.chain.then(async () => {
      try {
        await this.ports.call("capture.event", { sessionId, offsetMs, ...input }, { key: `cap:${sessionId}:e${index}` });
      } catch (error) {
        // One event that cannot be stored never ends a recording; it is not the audio's fault.
        if (codeOf(error) === "VALIDATION_ERROR") return;
      }
    });
  }

  /** End the recording. Safe to call more than once and from any phase. */
  stop(reason: CaptureStopReason = "user"): Promise<RecorderState["lastStop"]> {
    if (this.state.phase === "starting") {
      this.stopRequest = reason;
      return Promise.resolve(null);
    }
    if (this.state.phase !== "recording") return this.pendingStop ?? Promise.resolve(null);
    const sessionId = this.state.sessionId!;
    this.set({ phase: "stopping" });
    this.mic?.stop();
    this.mic = null;
    const durationMs = Math.round((this.samples * 1000) / SAMPLE_RATE);
    this.pendingStop = (async () => {
      await this.chain.catch(() => undefined);
      let view: { stage?: string; audioState?: string } = {};
      try {
        view = await this.ports.call<{ stage?: string; audioState?: string }>("capture.stop", { sessionId, reason, durationMs });
      } catch (error) {
        this.set({ issue: { code: "append_failed", message: messageOf(error) } });
      }
      const lastStop = { sessionId, reason, durationMs, ...(view.stage ? { stage: view.stage } : {}), ...(view.audioState ? { audioState: view.audioState } : {}) };
      this.set({ phase: "idle", sessionId: null, mode: null, level: 0, elapsedMs: durationMs, lastStop });
      this.pendingStop = null;
      return lastStop;
    })();
    return this.pendingStop;
  }

  /** The window is going away: end any recording so its audio is saved. */
  dispose(): Promise<unknown> {
    return this.stop("shutdown");
  }

  clearIssue(): void {
    this.set({ issue: null });
  }
}
