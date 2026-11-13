import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import esbuild from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import {
  AsrError,
  AsrService,
  DEFAULT_ASR_CRASH_THRESHOLD,
  DEFAULT_ASR_CRASH_WINDOW_MS,
  DEFAULT_ASR_IDLE_TIMEOUT_MS,
  DEFAULT_ASR_SAMPLE_RATE,
  GTCRN_DRY_MIX,
  GTCRN_WET_MIX,
  formatHotwordsCsv,
  locateAsrHostEntry,
  locateGtcrnModel,
  mixDenoisedSamples,
  nodeForkAsrSpawner,
  normalizeLanguageForModel,
  toFloat32Array,
  utilityAsrSpawner,
  type AsrChannel,
  type AsrHostMessage,
  type AsrHostRequest,
  type AsrSpawner,
} from "../../apps/desktop/src/main/asr-service.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function decodePcm16Wav(bytes: Buffer): { samples: Float32Array; sampleRate: number } {
  let offset = 12;
  let sampleRate = 16_000;
  let channels = 1;
  let dataStart = 44;
  let dataBytes = bytes.byteLength - 44;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = bytes.toString("ascii", offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === "fmt " && chunkSize >= 16) {
      channels = bytes.readUInt16LE(body + 2);
      sampleRate = bytes.readUInt32LE(body + 4);
    } else if (chunkId === "data") {
      dataStart = body;
      dataBytes = Math.min(chunkSize, bytes.byteLength - body);
      break;
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  const frames = Math.floor(dataBytes / (2 * channels));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    samples[i] = bytes.readInt16LE(dataStart + i * 2 * channels) / 32768;
  }
  return { samples, sampleRate };
}

type FakeChildControl = {
  pid: number;
  requests: AsrHostRequest[];
  crash: (code?: number | null, signal?: string | null, stderr?: string) => void;
  killed: () => boolean;
};

function createFakeSpawner(
  handler?: (req: Extract<AsrHostRequest, { t: "call" }>, ctl: FakeChildControl, instanceIndex: number) => Promise<unknown> | unknown,
): { spawner: AsrSpawner; children: FakeChildControl[] } {
  const children: FakeChildControl[] = [];
  let nextPid = 4100;

  const spawner: AsrSpawner = () => {
    const pid = nextPid++;
    const instanceIndex = children.length;
    const requests: AsrHostRequest[] = [];
    const messageListeners: Array<(msg: AsrHostMessage) => void> = [];
    const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
    let exited = false;
    let wasKilled = false;
    let stderrText = "";

    const emitMessage = (msg: AsrHostMessage) => {
      if (exited) return;
      for (const fn of messageListeners) fn(msg);
    };
    const emitExit = (code: number | null, signal: string | null) => {
      if (exited) return;
      exited = true;
      for (const fn of exitListeners) fn(code, signal);
    };

    const ctl: FakeChildControl = {
      pid,
      requests,
      crash(code = 1, signal = null, stderr = "") {
        stderrText = stderr;
        emitExit(code, signal);
      },
      killed: () => wasKilled,
    };
    children.push(ctl);

    queueMicrotask(() => emitMessage({ t: "ready", pid }));

    const channel: AsrChannel = {
      get pid() {
        return pid;
      },
      send(req) {
        if (exited) return;
        requests.push(req);
        if (req.t === "stop") {
          queueMicrotask(() => emitExit(0, null));
          return;
        }
        queueMicrotask(async () => {
          try {
            let value: unknown;
            if (handler) {
              value = await handler(req, ctl, instanceIndex);
            } else if (req.method === "ping") {
              value = { pong: true, pid, version: "2.0.1", onnxruntimeVersion: "1.28.2", loadedModelId: null, rssBytes: 1024 };
            } else if (req.method === "load") {
              value = { loaded: true, modelId: req.params.modelId, kind: req.params.kind, reused: false, elapsedMs: 5, rssBytes: 2048 };
            } else if (req.method === "recognize") {
              value = { text: "测试结果", rawText: "测试结果", tokens: ["测", "试"], timestamps: [0.1, 0.2], lang: "zh", modelId: "demo-model", elapsedMs: 4 };
            } else if (req.method === "denoise") {
              const s = toFloat32Array(req.params.samples);
              value = { samples: s, sampleRate: req.params.sampleRate ?? DEFAULT_ASR_SAMPLE_RATE, elapsedMs: 2 };
            } else {
              value = { unloaded: true };
            }
            emitMessage({ t: "result", id: req.id, ok: true, value });
          } catch (error) {
            emitMessage({
              t: "result",
              id: req.id,
              ok: false,
              error: { code: "MOCK_ERR", message: error instanceof Error ? error.message : String(error) },
            });
          }
        });
      },
      onMessage(fn) {
        messageListeners.push(fn);
      },
      onExit(fn) {
        exitListeners.push(fn);
      },
      kill() {
        wasKilled = true;
        emitExit(null, "SIGKILL");
      },
      stderrTail: () => stderrText,
    };
    return channel;
  };

  return { spawner, children };
}

describe("asr-protocol pure helpers (GTCRN mix, hotwords CSV, model language mapping)", () => {
  it("mixes 75% GTCRN denoised + 25% raw dry signal and clamps to [-1, 1]", () => {
    expect(GTCRN_WET_MIX).toBe(0.75);
    expect(GTCRN_DRY_MIX).toBe(0.25);
    expect(DEFAULT_ASR_IDLE_TIMEOUT_MS).toBe(10 * 60 * 1000);
    expect(DEFAULT_ASR_CRASH_WINDOW_MS).toBe(60 * 1000);
    expect(DEFAULT_ASR_CRASH_THRESHOLD).toBe(2);

    const raw = new Float32Array([0.8, -0.4, 1.0]);
    const wet = new Float32Array([0.4, -0.8, 1.2]);
    const mixed = mixDenoisedSamples(raw, wet);
    expect(mixed[0]).toBeCloseTo(0.75 * 0.4 + 0.25 * 0.8, 6);
    expect(mixed[1]).toBeCloseTo(0.75 * -0.8 + 0.25 * -0.4, 6);
    expect(mixed[2]).toBe(1.0);
  });

  it("formats per-stream hotwords as ASCII comma-separated terms, stripping :weights, deduping case-insensitively, and capping at 50", () => {
    const terms = [
      " 葬送的芙莉莲 :2.5 ",
      "Frieren:1.5",
      "frieren",
      "辛美尔,勇者",
      "",
      ...Array.from({ length: 60 }, (_, idx) => `术语${idx}`),
    ];
    const csv = formatHotwordsCsv(terms);
    const items = csv.split(",");
    expect(items.length).toBe(50);
    expect(items[0]).toBe("葬送的芙莉莲");
    expect(items[1]).toBe("Frieren");
    expect(items[2]).toBe("辛美尔 勇者");
    expect(formatHotwordsCsv("星野澪:3.0，白鹭学园")).toBe("星野澪,白鹭学园");
  });

  it("maps language hints accurately to Qwen3-ASR English names, FunASR-Nano Chinese labels, and SenseVoice codes", () => {
    expect(normalizeLanguageForModel("qwen3Asr", "zh-CN")).toBe("Chinese");
    expect(normalizeLanguageForModel("qwen3Asr", "yue")).toBe("Cantonese");
    expect(normalizeLanguageForModel("qwen3Asr", "ja")).toBe("Japanese");
    expect(normalizeLanguageForModel("qwen3Asr", "en")).toBe("English");
    expect(normalizeLanguageForModel("qwen3Asr", "auto")).toBe("");

    expect(normalizeLanguageForModel("funasrNano", "zh")).toBe("中文");
    expect(normalizeLanguageForModel("funasrNano", "yue")).toBe("粤语");
    expect(normalizeLanguageForModel("funasrNano", "ja")).toBe("日文");
    expect(normalizeLanguageForModel("funasrNano", "en")).toBe("英文");
    expect(normalizeLanguageForModel("funasrNano", "auto")).toBe("");

    expect(normalizeLanguageForModel("senseVoice", "zh-TW")).toBe("zh");
    expect(normalizeLanguageForModel("senseVoice", undefined)).toBe("auto");

    const f32 = new Float32Array([0.25, -0.5]);
    const asBytes = new Uint8Array(f32.buffer.slice(0));
    expect(Array.from(toFloat32Array(asBytes))).toEqual([0.25, -0.5]);
    expect(Array.from(toFloat32Array([0.5, -0.25]))).toEqual([0.5, -0.25]);
    expect(typeof utilityAsrSpawner).toBe("function");
  });
});

describe("AsrService lifecycle: sequential queue, idle unload/reload, crash isolation, and quit disposal", () => {
  it("serializes concurrent load/denoise/recognize requests in strict FIFO order", async () => {
    const dir = makeTempDir("manga-asr-fifo-");
    const entry = path.join(dir, "asr-host.cjs");
    const gtcrn = path.join(dir, "gtcrn_simple.onnx");
    fs.writeFileSync(entry, "");
    fs.writeFileSync(gtcrn, "");

    const order: string[] = [];
    let activeInChild = 0;
    let maxConcurrentInChild = 0;
    const { spawner } = createFakeSpawner(async (req) => {
      activeInChild += 1;
      maxConcurrentInChild = Math.max(maxConcurrentInChild, activeInChild);
      order.push(`start:${req.method}:${req.id}`);
      await new Promise((r) => setTimeout(r, 15));
      order.push(`end:${req.method}:${req.id}`);
      activeInChild -= 1;
      if (req.method === "load") return { loaded: true, modelId: req.params.modelId, kind: req.params.kind, reused: false, elapsedMs: 15, rssBytes: 100 };
      if (req.method === "denoise") return { samples: new Float32Array([0.1, 0.2]), sampleRate: 16_000, elapsedMs: 15 };
      return { text: `ok-${req.id}`, rawText: `ok-${req.id}`, tokens: [], timestamps: [], lang: "zh", modelId: "demo-model", elapsedMs: 15 };
    });

    const service = new AsrService({ spawner, entryPath: entry, gtcrnModelPath: gtcrn });
    cleanups.push(() => service.dispose());

    const [loadRes, denoiseRes, rec1, rec2] = await Promise.all([
      service.load("sense-voice-funasr-nano-int8", "senseVoice", { model: "m.onnx", tokens: "t.txt" }),
      service.denoise(new Float32Array([0.2, 0.4])),
      service.recognize(new Float32Array([0.1])),
      service.recognize(new Float32Array([0.2])),
    ]);

    expect(maxConcurrentInChild).toBe(1);
    expect(loadRes.loaded).toBe(true);
    expect(denoiseRes.samples.length).toBe(2);
    expect(rec1.text).toBe("ok-3");
    expect(rec2.text).toBe("ok-4");
    expect(order).toEqual([
      "start:load:1",
      "end:load:1",
      "start:denoise:2",
      "end:denoise:2",
      "start:recognize:3",
      "end:recognize:3",
      "start:recognize:4",
      "end:recognize:4",
    ]);
  });

  it("unloads and exits the utility process on idle timeout, then transparently respawns and reloads on the next recognize()", async () => {
    const dir = makeTempDir("manga-asr-idle-");
    const entry = path.join(dir, "asr-host.cjs");
    fs.writeFileSync(entry, "");

    const { spawner, children } = createFakeSpawner();
    const service = new AsrService({ spawner, entryPath: entry, idleTimeoutMs: 35 });
    cleanups.push(() => service.dispose());

    await service.load("qwen3-asr-0.6B-int8", "qwen3Asr", {
      convFrontend: "c.onnx",
      encoder: "e.onnx",
      decoder: "d.onnx",
      tokenizer: "tok",
    });
    expect(service.running).toBe(true);
    expect(service.pid).toBe(children[0]!.pid);
    expect(service.getModelStatus("qwen3-asr-0.6B-int8").status).toBe("loaded");

    // Wait for idle timeout to unload and stop child #0.
    await new Promise((r) => setTimeout(r, 90));
    expect(service.running).toBe(false);
    expect(service.getModelStatus("qwen3-asr-0.6B-int8").status).toBe("unloaded");
    expect(children[0]!.requests.some((r) => r.t === "stop")).toBe(true);

    // Next recognize() transparently spawns child #1, sends load(), and runs recognize().
    service.setIdleTimeoutMs(60_000);
    const rec = await service.recognize(new Float32Array([0.1, -0.1]), { hotwords: ["芙莉莲"], language: "zh" });
    expect(rec.text).toBe("测试结果");
    expect(children.length).toBe(2);
    expect(children[1]!.requests.filter((r) => r.t === "call").map((r) => r.method)).toEqual(["load", "recognize"]);
  });

  it("isolates crashes: 1st crash restarts on next request; 2nd crash within 60s marks model load_failed until reset", async () => {
    const dir = makeTempDir("manga-asr-crash-");
    const entry = path.join(dir, "asr-host.cjs");
    fs.writeFileSync(entry, "");

    let clock = 1_000_000;
    let shouldCrashRecognize = true;
    const { spawner, children } = createFakeSpawner((req, ctl) => {
      if (req.method === "recognize" && shouldCrashRecognize) {
        ctl.crash(139, null, "ORT segfault in bad weights");
        return new Promise(() => {});
      }
      if (req.method === "load") {
        return { loaded: true, modelId: req.params.modelId, kind: req.params.kind, reused: false, elapsedMs: 3, rssBytes: 512 };
      }
      return { text: "恢复成功", rawText: "恢复成功", tokens: [], timestamps: [], lang: "zh", modelId: "broken-m", elapsedMs: 3 };
    });

    const service = new AsrService({
      spawner,
      entryPath: entry,
      now: () => clock,
      crashWindowMs: 60_000,
      crashThreshold: 2,
    });
    cleanups.push(() => service.dispose());

    await service.load("broken-m", "senseVoice", { model: "m.onnx", tokens: "t.txt" });

    // Crash #1 at t = 1_000_000: retryable ASR_PROCESS_CRASHED, model not yet load_failed.
    await expect(service.recognize(new Float32Array([0.2]))).rejects.toMatchObject({
      name: "AsrError",
      code: "ASR_PROCESS_CRASHED",
      retryable: true,
    });
    expect(service.getModelStatus("broken-m")).toMatchObject({ status: "unloaded", crashCount: 1 });

    // Crash #2 at t = 1_020_000 (within 60s): marks model load_failed and blocks further spawns!
    clock += 20_000;
    await expect(service.recognize(new Float32Array([0.2]))).rejects.toMatchObject({
      code: "ASR_MODEL_LOAD_FAILED",
      retryable: false,
    });
    expect(service.getModelStatus("broken-m")).toMatchObject({ status: "load_failed", crashCount: 2 });
    const countAfterBreaker = children.length;

    await expect(service.recognize(new Float32Array([0.2]))).rejects.toMatchObject({ code: "ASR_MODEL_LOAD_FAILED" });
    await expect(service.load("broken-m", "senseVoice", { model: "m.onnx", tokens: "t.txt" })).rejects.toMatchObject({
      code: "ASR_MODEL_LOAD_FAILED",
    });
    expect(children.length).toBe(countAfterBreaker);

    // Explicit force reload clears load_failed and succeeds once the crash trigger is off.
    shouldCrashRecognize = false;
    await service.load("broken-m", "senseVoice", { model: "m.onnx", tokens: "t.txt" }, { force: true });
    expect(service.getModelStatus("broken-m")).toMatchObject({ status: "loaded", crashCount: 0 });
    const recovered = await service.recognize(new Float32Array([0.2]));
    expect(recovered.text).toBe("恢复成功");
  });

  it("terminates an active recognition child immediately when dispose() / close() is called on app quit", async () => {
    const dir = makeTempDir("manga-asr-quit-");
    const entry = path.join(dir, "asr-host.cjs");
    fs.writeFileSync(entry, "");

    let notifyRecognizeStarted!: () => void;
    const recognizeStarted = new Promise<void>((resolve) => {
      notifyRecognizeStarted = resolve;
    });
    const { spawner, children } = createFakeSpawner((req) => {
      if (req.method === "load") {
        return { loaded: true, modelId: req.params.modelId, kind: req.params.kind, reused: false, elapsedMs: 1, rssBytes: 100 };
      }
      if (req.method === "recognize") {
        notifyRecognizeStarted();
        return new Promise(() => {});
      }
      return { unloaded: true };
    });

    const service = new AsrService({ spawner, entryPath: entry });
    await service.load("demo-model", "senseVoice", { model: "m.onnx", tokens: "t.txt" });
    const inFlight = service.recognize(new Float32Array([0.3, -0.3]));
    await recognizeStarted;

    service.close();
    await expect(inFlight).rejects.toBeInstanceOf(AsrError);
    expect(children[0]!.killed()).toBe(true);
    expect(service.running).toBe(false);
  });
});

const asrSmokeModelDir = path.join(repoRoot, "dist", "tools", "asr", "sense-voice-funasr-nano-int8");
const gtcrnModelFile = path.join(repoRoot, "dist", "tools", "gtcrn", "gtcrn_simple.onnx");
const sampleWavFile = path.join(repoRoot, "dist", "samples", "media", "voice", "tts-clips", "zh-CN-1.wav");
const hasNativeSherpa =
  process.platform === "win32"
  && fs.existsSync(path.join(repoRoot, "node_modules", "sherpa-onnx-win-x64", "sherpa-onnx.node"))
  && fs.existsSync(path.join(asrSmokeModelDir, "model.int8.onnx"))
  && fs.existsSync(gtcrnModelFile)
  && fs.existsSync(sampleWavFile);

describe.skipIf(mediaPrerequisitesAbsent || !hasNativeSherpa)("asr-host.cjs real sherpa-onnx-node 2.0.1 + GTCRN + SenseVoice integration", () => {
  it("loads sherpa-onnx-node 2.0.1 in a separate process, runs GTCRN denoise (enableExternalBuffer: false), and transcribes zh-CN-1.wav", async () => {
    const buildDir = makeTempDir("manga-asr-real-");
    const hostBundle = path.join(buildDir, "asr-host.cjs");
    await esbuild.build({
      absWorkingDir: path.join(repoRoot, "apps", "desktop"),
      entryPoints: ["src/main/asr-host.ts"],
      outfile: hostBundle,
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["sherpa-onnx-node", "sherpa-onnx-*", "electron"],
    });

    expect(locateGtcrnModel({ cwd: repoRoot })).toBe(gtcrnModelFile);
    expect(locateAsrHostEntry({ baseDir: buildDir, cwd: repoRoot })).toBe(hostBundle);

    const service = new AsrService({
      spawner: nodeForkAsrSpawner,
      entryPath: hostBundle,
      gtcrnModelPath: gtcrnModelFile,
      cwd: repoRoot,
    });
    cleanups.push(() => service.dispose());

    const ping = await service.ping();
    expect(ping.pong).toBe(true);
    expect(ping.version).toBe("2.0.1");
    expect(ping.onnxruntimeVersion).toBe("1.28.2");
    expect(ping.pid).not.toBe(process.pid);

    const wav = decodePcm16Wav(fs.readFileSync(sampleWavFile));
    const denoised = await service.denoise(wav.samples, { sampleRate: wav.sampleRate });
    expect(denoised.samples.length).toBe(wav.samples.length);
    expect(denoised.sampleRate).toBe(16_000);

    const loaded = await service.load("sense-voice-funasr-nano-int8", "senseVoice", {
      model: path.join(asrSmokeModelDir, "model.int8.onnx"),
      tokens: path.join(asrSmokeModelDir, "tokens.txt"),
    });
    expect(loaded.loaded).toBe(true);
    expect(loaded.rssBytes).toBeGreaterThan(10 * 1024 * 1024);

    const recognized = await service.recognize(denoised.samples, { sampleRate: denoised.sampleRate, language: "zh" });
    expect(recognized.text).toMatch(/图书馆|大门|没有署名|信/);

    const unloaded = await service.unload();
    expect(unloaded.unloaded).toBe(true);
    expect(service.running).toBe(false);
  }, 60_000);
});
