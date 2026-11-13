import { fork as nodeFork } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ASR_CRASH_THRESHOLD,
  DEFAULT_ASR_CRASH_WINDOW_MS,
  DEFAULT_ASR_IDLE_TIMEOUT_MS,
  DEFAULT_ASR_SAMPLE_RATE,
  GTCRN_DRY_MIX,
  GTCRN_WET_MIX,
  formatHotwordsCsv,
  mixDenoisedSamples,
  normalizeLanguageForModel,
  toFloat32Array,
  type AsrDenoiseOptions,
  type AsrDenoiseResult,
  type AsrHostMessage,
  type AsrHostRequest,
  type AsrLoadOptions,
  type AsrLoadResult,
  type AsrModelFiles,
  type AsrModelKind,
  type AsrPingResult,
  type AsrRecognizeOptions,
  type AsrRecognizeResult,
  type AsrUnloadResult,
} from "./asr-protocol.ts";

export {
  DEFAULT_ASR_CRASH_THRESHOLD,
  DEFAULT_ASR_CRASH_WINDOW_MS,
  DEFAULT_ASR_IDLE_TIMEOUT_MS,
  DEFAULT_ASR_SAMPLE_RATE,
  GTCRN_DRY_MIX,
  GTCRN_WET_MIX,
  formatHotwordsCsv,
  mixDenoisedSamples,
  normalizeLanguageForModel,
  toFloat32Array,
  type AsrDenoiseOptions,
  type AsrDenoiseResult,
  type AsrHostMessage,
  type AsrHostRequest,
  type AsrLoadOptions,
  type AsrLoadResult,
  type AsrModelFiles,
  type AsrModelKind,
  type AsrPingResult,
  type AsrRecognizeOptions,
  type AsrRecognizeResult,
  type AsrUnloadResult,
};

const PASS_THROUGH_ENV = ["SystemRoot", "windir", "TEMP", "TMP", "TMPDIR", "LANG"] as const;
const GTCRN_MODEL_FILE = "gtcrn_simple.onnx";

export class AsrError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AsrError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export type AsrSpawnSpec = {
  entry: string;
  cwd: string;
  gtcrnModelPath?: string;
  env?: Record<string, string>;
};

export type AsrChannel = {
  readonly pid: number | undefined;
  send(message: AsrHostRequest): void;
  onMessage(listener: (message: AsrHostMessage) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  kill(): void;
  closePort?(): void;
  stderrTail(): string;
};

export type AsrSpawner = (spec: AsrSpawnSpec) => AsrChannel;

function workspaceRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (let depth = 0; depth < 12; depth += 1) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const currentModuleDir = (): string =>
  typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

const loadElectronMain = (): typeof import("electron") => {
  if (typeof require === "function") {
    return require("electron") as typeof import("electron");
  }
  return createRequire(import.meta.url)("electron") as typeof import("electron");
};

/**
 * Locates the bundled GTCRN 16 kHz denoiser model (`resources/gtcrn/gtcrn_simple.onnx` in packaged builds,
 * or `dist/tools/gtcrn/gtcrn_simple.onnx` in development).
 */
export function locateGtcrnModel(options: { env?: NodeJS.ProcessEnv; resourcesPath?: string; cwd?: string } = {}): string | null {
  const env = options.env ?? process.env;
  const dirs: string[] = [];
  if (env.MANGA_GTCRN_DIR) dirs.push(env.MANGA_GTCRN_DIR);
  const resources = options.resourcesPath ?? (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (resources) dirs.push(path.join(resources, "gtcrn"));
  const root = workspaceRoot(options.cwd ?? process.cwd()) ?? workspaceRoot(currentModuleDir());
  if (root) dirs.push(path.join(root, "dist", "tools", "gtcrn"));
  for (const dir of dirs) {
    const file = path.join(dir, GTCRN_MODEL_FILE);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * Locates `asr-host.cjs` outside `app.asar` so `utilityProcess.fork` can execute it as a real file and resolve
 * unpacked `sherpa-onnx-node` + `sherpa-onnx-win-x64` beside it.
 */
export function locateAsrHostEntry(options: { resourcesPath?: string; baseDir?: string; cwd?: string } = {}): string | null {
  const resources = options.resourcesPath ?? (process as unknown as { resourcesPath?: string }).resourcesPath;
  const baseDir = options.baseDir ?? currentModuleDir();
  const candidates: string[] = [];
  if (resources) {
    candidates.push(path.join(resources, "app.asar.unpacked", ".vite", "build", "asr-host.cjs"));
    candidates.push(path.join(resources, "asr-host.cjs"));
  }
  candidates.push(path.join(baseDir, "asr-host.cjs").replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`));
  candidates.push(path.join(baseDir, "asr-host.cjs"));
  const root = workspaceRoot(options.cwd ?? process.cwd()) ?? workspaceRoot(baseDir);
  if (root) candidates.push(path.join(root, "apps", "desktop", ".vite", "build", "asr-host.cjs"));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && !candidate.includes(`${path.sep}app.asar${path.sep}`)) return candidate;
  }
  return null;
}

function buildMinimalSpeechEnv(entryPath: string, extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PASS_THROUGH_ENV) {
    if (process.env[name]) env[name] = process.env[name]!;
  }
  if (process.platform === "win32") {
    const pathParts: string[] = [];
    const entryDir = path.dirname(entryPath);
    const searchNodeModules = [
      path.resolve(entryDir, "../../node_modules"),
      path.resolve(entryDir, "../node_modules"),
      path.resolve(entryDir, "app.asar.unpacked/node_modules"),
      path.resolve(entryDir, "../../../node_modules"),
      path.resolve(process.cwd(), "node_modules"),
    ];
    for (const nm of searchNodeModules) {
      const winX64 = path.join(nm, "sherpa-onnx-win-x64");
      if (fs.existsSync(path.join(winX64, "sherpa-onnx.node"))) {
        pathParts.push(winX64);
        break;
      }
    }
    const sysRoot = process.env.SystemRoot ?? process.env.windir;
    if (sysRoot) pathParts.push(path.join(sysRoot, "System32"));
    if (pathParts.length > 0) env.PATH = pathParts.join(";");
  }
  if (extra) Object.assign(env, extra);
  return env;
}

/**
 * Production Electron spawner: forks `asr-host.cjs` as an Electron `utilityProcess` (`serviceName: "MANGA speech"`)
 * and communicates exclusively over a transferred `MessagePortMain` (`MessageChannelMain`).
 */
export const utilityAsrSpawner: AsrSpawner = (spec) => {
  // Loaded lazily so Vitest in plain Node can import `AsrService` and supply `nodeForkAsrSpawner` or a mock spawner.
  const { MessageChannelMain, utilityProcess } = loadElectronMain();
  const env = buildMinimalSpeechEnv(spec.entry, spec.env);
  const child = utilityProcess.fork(spec.entry, [], {
    cwd: spec.cwd,
    env,
    serviceName: "MANGA speech",
    stdio: ["ignore", "ignore", "pipe"],
  });
  let tail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-4096);
  });
  const { port1, port2 } = new MessageChannelMain();
  port1.start();
  child.postMessage({ t: "connect", gtcrnModelPath: spec.gtcrnModelPath }, [port2]);

  return {
    get pid() {
      return child.pid;
    },
    send(message) {
      port1.postMessage(message);
    },
    onMessage(listener) {
      port1.on("message", (event) => listener(event.data as AsrHostMessage));
    },
    onExit(listener) {
      child.on("exit", (code) => listener(code, null));
    },
    closePort() {
      try {
        port1.close();
      } catch {
        // ignore already closed port
      }
    },
    kill() {
      try {
        port1.close();
      } catch {
        // ignore
      }
      child.kill();
    },
    stderrTail: () => tail,
  };
};

/**
 * Node `child_process.fork` spawner with V8 structured-clone IPC (`serialization: "advanced"`) for headless Vitest suites.
 */
export const nodeForkAsrSpawner: AsrSpawner = (spec) => {
  const env = buildMinimalSpeechEnv(spec.entry, spec.env);
  const child = nodeFork(spec.entry, [], {
    cwd: spec.cwd,
    env,
    serialization: "advanced",
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let tail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString("utf8")).slice(-4096);
  });
  child.send({ t: "connect", gtcrnModelPath: spec.gtcrnModelPath });
  return {
    get pid() {
      return child.pid;
    },
    send(message) {
      if (child.connected) child.send(message);
    },
    onMessage(listener) {
      child.on("message", (msg) => listener(msg as AsrHostMessage));
    },
    onExit(listener) {
      child.on("exit", (code, signal) => listener(code, signal));
    },
    kill() {
      child.kill();
    },
    stderrTail: () => tail,
  };
};

export type AsrModelStatus = {
  modelId: string;
  status: "unloaded" | "loaded" | "load_failed";
  crashCount: number;
  reason?: string;
};

export type AsrServiceOptions = {
  spawner?: AsrSpawner;
  entryPath?: string;
  gtcrnModelPath?: string;
  resourcesPath?: string;
  cwd?: string;
  idleTimeoutMs?: number;
  crashWindowMs?: number;
  crashThreshold?: number;
  startupTimeoutMs?: number;
  now?: () => number;
};

type DesiredModel = {
  modelId: string;
  kind: AsrModelKind;
  files: Record<string, string>;
  numThreads?: number;
  key: string;
};

type ActiveSession = {
  channel: AsrChannel;
  intentionalStop: boolean;
  readyPromise: Promise<void>;
  pending: Map<
    number,
    {
      method: string;
      modelId: string | null;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >;
  exitPromise: Promise<void>;
};

export class AsrService {
  private readonly spawner: AsrSpawner;
  private readonly explicitEntryPath: string | undefined;
  private readonly explicitGtcrnPath: string | undefined;
  private readonly resourcesPath: string | undefined;
  private readonly cwd: string;
  private idleTimeoutMs: number;
  private readonly crashWindowMs: number;
  private readonly crashThreshold: number;
  private readonly startupTimeoutMs: number;
  private readonly now: () => number;

  private session: ActiveSession | null = null;
  private desiredModel: DesiredModel | null = null;
  private remoteLoadedKey: string | null = null;
  private remoteLoadedModelId: string | null = null;

  private readonly crashHistory = new Map<string, number[]>();
  private readonly failedModels = new Map<string, string>();

  private seq = 1;
  private inFlight = 0;
  private queue: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(options: AsrServiceOptions = {}) {
    this.spawner = options.spawner ?? (process.versions.electron ? utilityAsrSpawner : nodeForkAsrSpawner);
    this.explicitEntryPath = options.entryPath;
    this.explicitGtcrnPath = options.gtcrnModelPath;
    this.resourcesPath = options.resourcesPath;
    this.cwd = options.cwd ?? process.cwd();
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_ASR_IDLE_TIMEOUT_MS;
    this.crashWindowMs = options.crashWindowMs ?? DEFAULT_ASR_CRASH_WINDOW_MS;
    this.crashThreshold = options.crashThreshold ?? DEFAULT_ASR_CRASH_THRESHOLD;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 15_000;
    this.now = options.now ?? (() => Date.now());
  }

  get running(): boolean {
    return this.session !== null && !this.session.intentionalStop;
  }

  get pid(): number | undefined {
    return this.session?.channel.pid;
  }

  setIdleTimeoutMs(ms: number): void {
    this.idleTimeoutMs = Math.max(0, ms);
    if (this.inFlight === 0 && this.session) this.armIdleTimer();
  }

  getModelStatus(modelId: string): AsrModelStatus {
    const crashes = this.prunedCrashes(modelId);
    const failedReason = this.failedModels.get(modelId);
    if (failedReason) {
      return { modelId, status: "load_failed", crashCount: crashes.length, reason: failedReason };
    }
    if (this.session && !this.session.intentionalStop && this.remoteLoadedModelId === modelId) {
      return { modelId, status: "loaded", crashCount: crashes.length };
    }
    return { modelId, status: "unloaded", crashCount: crashes.length };
  }

  /** Clears a `load_failed` mark when the user explicitly retries or reinstalls a model in Settings. */
  resetModelStatus(modelId: string): void {
    this.failedModels.delete(modelId);
    this.crashHistory.delete(modelId);
  }

  load(modelId: string, kind: AsrModelKind, files: AsrModelFiles, options: AsrLoadOptions = {}): Promise<AsrLoadResult> {
    return this.enqueue(async () => {
      if (options.force) this.resetModelStatus(modelId);
      const failure = this.failedModels.get(modelId);
      if (failure) {
        throw new AsrError("ASR_MODEL_LOAD_FAILED", failure, { retryable: false });
      }
      const plainFiles = { ...(files as Record<string, string>) };
      const key = JSON.stringify({ modelId, kind, files: plainFiles, numThreads: options.numThreads ?? null });
      const desired: DesiredModel = { modelId, kind, files: plainFiles, numThreads: options.numThreads, key };
      this.desiredModel = desired;
      const result = (await this.callHost(
        {
          t: "call",
          id: this.seq++,
          method: "load",
          params: { modelId, kind, files: plainFiles, ...(options.numThreads ? { numThreads: options.numThreads } : {}) },
        },
        modelId,
      )) as AsrLoadResult;
      this.remoteLoadedKey = key;
      this.remoteLoadedModelId = modelId;
      return result;
    });
  }

  recognize(samples: Float32Array, options: AsrRecognizeOptions = {}): Promise<AsrRecognizeResult> {
    return this.enqueue(async () => {
      const desired = this.desiredModel;
      if (!desired) {
        throw new AsrError("ASR_NOT_LOADED", "尚未载入本地语音识别模型");
      }
      const failure = this.failedModels.get(desired.modelId);
      if (failure) {
        throw new AsrError("ASR_MODEL_LOAD_FAILED", failure, { retryable: false });
      }
      if (!this.session || this.remoteLoadedKey !== desired.key) {
        await this.callHost(
          {
            t: "call",
            id: this.seq++,
            method: "load",
            params: {
              modelId: desired.modelId,
              kind: desired.kind,
              files: desired.files,
              ...(desired.numThreads ? { numThreads: desired.numThreads } : {}),
            },
          },
          desired.modelId,
        );
        this.remoteLoadedKey = desired.key;
        this.remoteLoadedModelId = desired.modelId;
      }
      const raw = (await this.callHost(
        {
          t: "call",
          id: this.seq++,
          method: "recognize",
          params: {
            samples: toFloat32Array(samples),
            sampleRate: options.sampleRate ?? DEFAULT_ASR_SAMPLE_RATE,
            ...(options.hotwords !== undefined ? { hotwords: options.hotwords } : {}),
            ...(options.language !== undefined ? { language: options.language } : {}),
          },
        },
        desired.modelId,
      )) as AsrRecognizeResult;
      return raw;
    });
  }

  denoise(samples: Float32Array, options: AsrDenoiseOptions = {}): Promise<AsrDenoiseResult> {
    return this.enqueue(async () => {
      const gtcrnPath = options.gtcrnModelPath ?? this.resolveGtcrnPath();
      if (!gtcrnPath) {
        throw new AsrError("ASR_GTCRN_MISSING", "未找到随包 GTCRN 语音增强模型（gtcrn_simple.onnx）");
      }
      const raw = (await this.callHost(
        {
          t: "call",
          id: this.seq++,
          method: "denoise",
          params: {
            samples: toFloat32Array(samples),
            sampleRate: options.sampleRate ?? DEFAULT_ASR_SAMPLE_RATE,
            ...(options.mixRatio !== undefined ? { mixRatio: options.mixRatio } : {}),
            gtcrnModelPath: gtcrnPath,
          },
        },
        this.remoteLoadedModelId,
      )) as { samples: unknown; sampleRate: number; elapsedMs: number };
      return {
        samples: toFloat32Array(raw.samples),
        sampleRate: raw.sampleRate,
        elapsedMs: raw.elapsedMs,
      };
    });
  }

  unload(): Promise<AsrUnloadResult> {
    return this.enqueue(async () => {
      this.desiredModel = null;
      await this.shutdownSession();
      return { unloaded: true };
    });
  }

  ping(): Promise<AsrPingResult> {
    return this.enqueue(async () => {
      return (await this.callHost({ t: "call", id: this.seq++, method: "ping" }, this.remoteLoadedModelId)) as AsrPingResult;
    });
  }

  /**
   * Immediately terminates the speech inference utility process (even mid-recognition) on application quit.
   */
  dispose(): void {
    this.disposed = true;
    this.clearIdleTimer();
    this.desiredModel = null;
    this.remoteLoadedKey = null;
    this.remoteLoadedModelId = null;
    const active = this.session;
    this.session = null;
    if (active) {
      active.intentionalStop = true;
      for (const [, pending] of active.pending) {
        pending.reject(new AsrError("ASR_DISPOSED", "应用正在退出，已结束本地语音推理进程"));
      }
      active.pending.clear();
      active.channel.closePort?.();
      active.channel.kill();
    }
  }

  close(): void {
    this.dispose();
  }

  private prunedCrashes(modelId: string): number[] {
    const list = this.crashHistory.get(modelId);
    if (!list || list.length === 0) return [];
    const cutoff = this.now() - this.crashWindowMs;
    const kept = list.filter((ts) => ts >= cutoff);
    if (kept.length > 0) this.crashHistory.set(modelId, kept);
    else this.crashHistory.delete(modelId);
    return kept;
  }

  private recordCrash(modelId: string | null, code: number | null, signal: string | null, stderrTail: string): AsrError {
    const exitDetail = signal ? `信号 ${signal}` : `退出码 ${code ?? "未知"}`;
    const tailNote = stderrTail.trim() ? `（${stderrTail.trim().split(/\r?\n/).pop()?.slice(0, 200)}）` : "";
    if (modelId) {
      const crashes = this.prunedCrashes(modelId);
      crashes.push(this.now());
      this.crashHistory.set(modelId, crashes);
      if (crashes.length >= this.crashThreshold) {
        const failedMessage = `本地语音模型「${modelId}」在 1 分钟内连续崩溃 ${crashes.length} 次（${exitDetail}），已标为载入失败${tailNote}；请在「设置 › 语音转录」中检查或重新载入模型`;
        this.failedModels.set(modelId, failedMessage);
        return new AsrError("ASR_MODEL_LOAD_FAILED", failedMessage, { retryable: false });
      }
    }
    return new AsrError(
      "ASR_PROCESS_CRASHED",
      `本地语音推理进程意外退出（${exitDetail}），本次听写失败${tailNote}；下一次识别将自动重启推理进程`,
      { retryable: true },
    );
  }

  private resolveEntryPath(): string {
    if (this.explicitEntryPath) return this.explicitEntryPath;
    const found = locateAsrHostEntry({ resourcesPath: this.resourcesPath, cwd: this.cwd });
    if (!found) {
      throw new AsrError("ASR_HOST_MISSING", "未找到本地语音推理进程入口文件（asr-host.cjs）");
    }
    return found;
  }

  private resolveGtcrnPath(): string | undefined {
    if (this.explicitGtcrnPath) return this.explicitGtcrnPath;
    return locateGtcrnModel({ resourcesPath: this.resourcesPath, cwd: this.cwd }) ?? undefined;
  }

  private ensureSession(attributedModelId: string | null): ActiveSession {
    if (this.disposed) {
      throw new AsrError("ASR_DISPOSED", "本地语音推理服务已关闭");
    }
    if (this.session && !this.session.intentionalStop) return this.session;

    const entry = this.resolveEntryPath();
    const channel = this.spawner({
      entry,
      cwd: this.cwd,
      gtcrnModelPath: this.resolveGtcrnPath(),
    });

    const pending: ActiveSession["pending"] = new Map();
    let resolveReady!: () => void;
    let rejectReady!: (err: Error) => void;
    let readySettled = false;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const startupTimer = setTimeout(() => {
      if (readySettled) return;
      readySettled = true;
      session.intentionalStop = true;
      channel.kill();
      if (this.session === session) {
        this.session = null;
        this.remoteLoadedKey = null;
        this.remoteLoadedModelId = null;
      }
      rejectReady(new AsrError("ASR_STARTUP_TIMEOUT", "本地语音推理进程启动超时"));
    }, this.startupTimeoutMs);
    startupTimer.unref?.();

    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const session: ActiveSession = {
      channel,
      intentionalStop: false,
      readyPromise,
      pending,
      exitPromise,
    };

    channel.onMessage((msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "ready") {
        if (!readySettled) {
          readySettled = true;
          clearTimeout(startupTimer);
          resolveReady();
        }
        return;
      }
      if (msg.t === "result") {
        const waiter = pending.get(msg.id);
        if (!waiter) return;
        pending.delete(msg.id);
        if (msg.ok) {
          waiter.resolve(msg.value);
        } else {
          waiter.reject(new AsrError(msg.error?.code ?? "ASR_HOST_FAILED", msg.error?.message ?? "本地语音推理失败"));
        }
      }
    });

    channel.onExit((code, signal) => {
      clearTimeout(startupTimer);
      resolveExit();
      if (this.session === session) {
        this.session = null;
        this.remoteLoadedKey = null;
        this.remoteLoadedModelId = null;
      }
      channel.closePort?.();
      if (session.intentionalStop || this.disposed) {
        if (!readySettled) {
          readySettled = true;
          rejectReady(new AsrError("ASR_STOPPED", "本地语音推理进程已停止"));
        }
        for (const [, waiter] of pending) {
          waiter.reject(new AsrError("ASR_STOPPED", "本地语音推理进程已停止"));
        }
        pending.clear();
        return;
      }

      const firstWaiter = pending.values().next().value;
      const crashModelId = firstWaiter?.modelId ?? this.remoteLoadedModelId ?? attributedModelId ?? this.desiredModel?.modelId ?? null;
      const crashError = this.recordCrash(crashModelId, code, signal, channel.stderrTail());
      if (!readySettled) {
        readySettled = true;
        rejectReady(crashError);
      }
      for (const [, waiter] of pending) {
        waiter.reject(crashError);
      }
      pending.clear();
    });

    this.session = session;
    return session;
  }

  private async callHost(request: Extract<AsrHostRequest, { t: "call" }>, modelId: string | null): Promise<unknown> {
    const session = this.ensureSession(modelId);
    await session.readyPromise;
    if (this.disposed) throw new AsrError("ASR_DISPOSED", "本地语音推理服务已关闭");
    if (this.session !== session || session.intentionalStop) {
      throw new AsrError("ASR_STOPPED", "本地语音推理进程已停止");
    }
    return new Promise<unknown>((resolve, reject) => {
      session.pending.set(request.id, { method: request.method, modelId, resolve, reject });
      try {
        session.channel.send(request);
      } catch (error) {
        session.pending.delete(request.id);
        reject(new AsrError("ASR_SEND_FAILED", error instanceof Error ? error.message : String(error), { cause: error }));
      }
    });
  }

  private async shutdownSession(): Promise<void> {
    const active = this.session;
    this.session = null;
    this.remoteLoadedKey = null;
    this.remoteLoadedModelId = null;
    if (!active) return;
    active.intentionalStop = true;
    try {
      await active.readyPromise;
      active.channel.send({ t: "stop" });
    } catch {
      // ignore if startup failed
    }
    const exitedInTime = await Promise.race([
      active.exitPromise.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1500);
        timer.unref?.();
      }),
    ]);
    active.channel.closePort?.();
    if (!exitedInTime) active.channel.kill();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.disposed || !this.session || this.idleTimeoutMs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.disposed || this.inFlight > 0 || !this.session) return;
      void this.enqueue(async () => {
        if (this.inFlight > 1 || !this.session) return;
        await this.shutdownSession();
      }).catch(() => {});
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new AsrError("ASR_DISPOSED", "本地语音推理服务已关闭"));
    }
    this.clearIdleTimer();
    this.inFlight += 1;
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => {
      this.inFlight -= 1;
      if (this.inFlight === 0 && this.session && !this.disposed) {
        this.armIdleTimer();
      }
    });
  }
}
