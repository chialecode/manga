import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MangaError } from "@manga/contracts";
import { AsrService, type AsrChannel, type AsrHostMessage, type AsrHostRequest, type AsrSpawner } from "../../apps/desktop/src/main/asr-service.ts";
import { PCM_BYTES_PER_MS } from "../../packages/app-core/src/voice/audio-files.ts";
import { PhoneticCorrector } from "../../packages/app-core/src/voice/correct/index.ts";
import type { DictationHistoryService } from "../../packages/app-core/src/voice/dictation/history.ts";
import { extractEditedTermSpan } from "../../packages/app-core/src/voice/dictation/learn.ts";
import { DictationService } from "../../packages/app-core/src/voice/dictation/service.ts";
import { AsrEngine } from "../../packages/app-core/src/voice/engine/asr-engine.ts";
import { AsrModelService, stagingPartPath, stagingStatePath, type AsrCatalogModel } from "../../packages/app-core/src/voice/models/index.ts";
import { validatePolishOutput } from "../../packages/app-core/src/voice/polish/guards.ts";
import { convertChineseVariant } from "../../packages/app-core/src/voice/polish/opencc.ts";
import { writeRecordingSettings } from "../../packages/app-core/src/voice/settings.ts";
import { VadWorkerClient } from "../../packages/app-core/src/voice/vad-client.ts";
import { createSyntheticModelFixture, startFakeModelServer, type FakeModelServer } from "../helpers/fake-model-server.ts";
import { testTempRoot } from "../helpers/global-temp.ts";
import { feed, join, quiet, seedResource, textLocator, toBase64, tone, voiceHarness, type Harness } from "../helpers/voice.ts";

const electronMock = vi.hoisted(() => {
  const created: Array<{
    destroyed: boolean;
    shown: boolean;
    url: string | null;
    closed: boolean;
    loadURL: ReturnType<typeof vi.fn>;
    showInactive: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  class MockBrowserWindow {
    destroyed = false;
    shown = false;
    url: string | null = null;
    closed = false;
    private listeners = new Map<string, Array<() => void>>();
    webContents = {
      isLoading: () => false,
      on: () => undefined,
      send: () => undefined,
    };
    loadURL = vi.fn(async (url: string) => {
      this.url = url;
    });
    showInactive = vi.fn(() => {
      this.shown = true;
    });
    close = vi.fn(() => {
      this.closed = true;
      this.destroyed = true;
      for (const fn of this.listeners.get("closed") ?? []) fn();
    });
    destroy = vi.fn(() => {
      this.destroyed = true;
    });
    isDestroyed = () => this.destroyed;
    getBounds = () => ({ x: 100, y: 100, width: 116, height: 34 });
    setBounds = vi.fn();
    on = (event: string, fn: () => void) => {
      const list = this.listeners.get(event) ?? [];
      list.push(fn);
      this.listeners.set(event, list);
    };
    constructor() {
      created.push(this);
    }
  }
  return {
    created,
    BrowserWindow: MockBrowserWindow,
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getCursorScreenPoint: () => ({ x: 200, y: 200 }),
    },
  };
});

vi.mock("electron", () => ({
  BrowserWindow: electronMock.BrowserWindow,
  screen: electronMock.screen,
}));

const { RecordingOverlay } = await import("../../apps/desktop/src/main/overlay.ts");

const cleanups: Array<() => void | Promise<void>> = [];
const harnesses: Harness[] = [];
const servers: FakeModelServer[] = [];

afterEach(async () => {
  electronMock.created.length = 0;
  while (harnesses.length > 0) harnesses.pop()!.close();
  while (servers.length > 0) await servers.pop()!.close();
  while (cleanups.length > 0) await cleanups.pop()!();
});

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(testTempRoot(), prefix));
  cleanups.push(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

describe("Wave 2B backend & main-process regressions", () => {
  it("V-03 & V-15: DictationService cancel does not emit duplicate cancelled or clobber next session, and clears loadingModel after ASR", async () => {
    const events: Array<{ dictationId: string; stage: string; loadingModel: boolean }> = [];
    let releaseFirstAsr!: () => void;
    let firstAsrStarted!: () => void;
    const firstAsrWaiting = new Promise<void>((resolve) => { firstAsrStarted = resolve; });
    let callCount = 0;

    const svc = new DictationService({
      trimmer: {
        trim: async (pcm) => ({
          status: "speech",
          pcmBuffer: pcm,
          speechMs: 800,
          originalMs: 800,
          trimmedMs: 0,
          warnings: [],
          segments: [{ startMs: 0, endMs: 800 }],
          peak: 0.5,
          rms: 0.1,
        }),
      },
      history: {
        save: () => ({ id: "hist_1" }),
        record: () => ({ id: "hist_1" }),
        close: () => undefined,
      } as unknown as DictationHistoryService,
      asrEngine: {
        transcribe: async (req) => {
          callCount += 1;
          if (callCount === 1) {
            firstAsrStarted();
            await new Promise<void>((resolve) => {
              releaseFirstAsr = resolve;
              req.signal?.addEventListener("abort", () => {
                // Delay rejection slightly so session 2 can already start and finish.
                setTimeout(resolve, 20);
              }, { once: true });
            });
            throw new MangaError("CANCELLED", "aborted");
          }
          return {
            text: "天海林音登场",
            segments: [],
            engineKind: "local",
            engineId: "sensevoice",
            modelId: "sensevoice",
            capabilities: { hotwords: 0, streaming: false, timestamps: false, maxSeconds: 30, language: true },
            appliedHint: { mode: "none", text: "", terms: [] },
            echoDetected: false,
            chunkCount: 1,
            recognizeMs: 12,
          };
        },
      } as unknown as AsrEngine,
      corrector: {
        correct: (rawText: string) => new PhoneticCorrector().correct(rawText),
        hotwordsFor: () => [],
        activeTermStrings: () => [],
      },
      preflight: () => ({ loadingModel: true }),
      readSettings: () => ({
        polishMode: "raw",
        chineseVariant: "none",
      }),
      notify: (_topic, payload) => {
        const snap = payload as { dictationId: string; stage: string; loadingModel: boolean };
        events.push({ dictationId: snap.dictationId, stage: snap.stage, loadingModel: snap.loadingModel });
      },
    });
    cleanups.push(() => svc.close());

    const pcmB64 = toBase64(tone(500));
    const s1 = svc.start({ mode: "hold" });
    svc.append({ dictationId: s1.dictationId, seq: 0, data: pcmB64 });
    const stop1 = svc.stop({ dictationId: s1.dictationId, reason: "user" });
    await firstAsrWaiting;

    // Cancel session 1 while ASR is in flight, then immediately start and complete session 2.
    svc.cancel(s1.dictationId);
    const s2 = svc.start({ mode: "hold" });
    svc.append({ dictationId: s2.dictationId, seq: 0, data: pcmB64 });
    const done2 = await svc.stop({ dictationId: s2.dictationId, reason: "user" });
    expect(done2.stage).toBe("done");
    expect(done2.loadingModel).toBe(false);

    releaseFirstAsr?.();
    await stop1;
    await new Promise((r) => setTimeout(r, 35));

    const s1Cancelled = events.filter((e) => e.dictationId === s1.dictationId && e.stage === "cancelled");
    expect(s1Cancelled).toHaveLength(1);
    // Session 2's completed status must remain intact and not be overwritten by session 1's late abort.
    expect(svc.status()?.dictationId).toBe(s2.dictationId);

    // Session 2 cleared loadingModel before post-ASR stages (`correcting` / `done`).
    const s2Events = events.filter((e) => e.dictationId === s2.dictationId);
    const s2Correcting = s2Events.find((e) => e.stage === "correcting");
    expect(s2Correcting?.loadingModel).toBe(false);
  });

  it("V-06 & V-12b: ModelDownloader aborts a stalled stream promptly on pause and rejects 0 free disk bytes with DISK_FULL", async () => {
    const dir = makeTempDir("voice-dl-stall-");
    const fixture = createSyntheticModelFixture(dir, { weightsByteLength: 32 * 1024 });

    // Start a raw HTTP server that sends 4 KiB then stalls forever without ending the response.
    const sockets = new Set<import("node:net").Socket>();
    const stallServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Length": String(fixture.archiveBuffer.length) });
      res.write(fixture.archiveBuffer.subarray(0, 4 * 1024));
    });
    stallServer.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    await new Promise<void>((resolve) => stallServer.listen(0, "127.0.0.1", resolve));
    const addr = stallServer.address() as import("node:net").AddressInfo;
    cleanups.push(async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => stallServer.close(() => resolve()));
    });

    const stallModel: AsrCatalogModel = {
      ...fixture.catalogModel,
      sources: [{ id: "github", label: "GitHub", url: `http://127.0.0.1:${addr.port}/stall.tar.bz2` }],
    };

    const svc = new AsrModelService({
      appRoot: path.join(dir, "app"),
      catalog: [stallModel],
      allowLoopbackHttp: true,
    });

    const startedAt = Date.now();
    let pauseSent = false;
    const dl = svc.download({
      modelId: stallModel.modelId,
      confirmed: true,
      onProgress: (p) => {
        if (!pauseSent && p.downloadedBytes >= 4 * 1024) {
          pauseSent = true;
          setTimeout(() => { void svc.pause(stallModel.modelId); }, 25);
        }
      },
    });
    await expect(dl).rejects.toMatchObject({ code: "CANCELLED" });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    expect(svc.getItem(stallModel.modelId).state).toBe("paused");

    // V-12b: 0 bytes free disk space must throw DISK_FULL (not be ignored by `> 0` check).
    const zeroDiskSvc = new AsrModelService({
      appRoot: path.join(dir, "zero-disk"),
      catalog: [stallModel],
      allowLoopbackHttp: true,
      getAvailableDiskBytes: () => 0,
    });
    await expect(zeroDiskSvc.download({ modelId: stallModel.modelId, confirmed: true })).rejects.toMatchObject({
      code: "DISK_FULL",
    });

    // V-06: Pausing during `verifying` must preserve `.part` and `.state.json` for resume without re-downloading.
    const fastSrv = await startFakeModelServer({
      "/fast.tar.bz2": { payload: fixture.archiveBuffer },
    });
    servers.push(fastSrv);
    const fastModel: AsrCatalogModel = {
      ...fixture.catalogModel,
      sources: [{ id: "github", label: "GitHub", url: `${fastSrv.baseUrl}/fast.tar.bz2` }],
    };
    const verifyPauseSvc = new AsrModelService({
      appRoot: path.join(dir, "verify-pause"),
      catalog: [fastModel],
      allowLoopbackHttp: true,
    });
    let pausedAtVerify = false;
    await expect(
      verifyPauseSvc.download({
        modelId: fastModel.modelId,
        confirmed: true,
        onProgress: (p) => {
          if (!pausedAtVerify && p.state === "verifying") {
            pausedAtVerify = true;
            void verifyPauseSvc.pause(fastModel.modelId);
          }
        },
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(pausedAtVerify).toBe(true);
    expect(fs.existsSync(stagingPartPath(verifyPauseSvc.stagingDir, fastModel.modelId))).toBe(true);
    expect(fs.existsSync(stagingStatePath(verifyPauseSvc.stagingDir, fastModel.modelId))).toBe(true);
  });

  it.runIf(process.platform === "win32")("V-22a: AsrModelService unloads an already-installed model before replacing it on re-import", async () => {
    const dir = makeTempDir("voice-dl-reimport-");
    const fixture = createSyntheticModelFixture(dir);
    const unloads: string[] = [];
    const svc = new AsrModelService({
      appRoot: path.join(dir, "app"),
      catalog: [fixture.catalogModel],
      unloadModel: async (id) => {
        unloads.push(id);
      },
    });

    await svc.importModel({ modelId: fixture.modelId, sourcePath: fixture.archivePath, kind: "archive" });
    expect(unloads).toEqual([]);

    await svc.importModel({ modelId: fixture.modelId, sourcePath: fixture.archivePath, kind: "archive" });
    expect(unloads).toEqual([fixture.modelId]);
  });

  it("V-07: RecordingOverlay publish(null) during async readRect() never leaves a zombie BrowserWindow", async () => {
    let resolveRect!: (value: { x?: number; y?: number }) => void;
    const overlay = new RecordingOverlay({
      url: "http://localhost:9999/overlay.html",
      preload: path.join(os.tmpdir(), "preload.js"),
      readRect: () => new Promise((resolve) => { resolveRect = resolve; }),
      writeRect: async () => undefined,
      onStop: () => undefined,
    });

    const snapshot = {
      phase: "recording" as const,
      elapsedMs: 100,
      level: 0.2,
      retention: "keep" as const,
      mode: "hold" as const,
      label: "",
      strings: { recording: "rec", stopping: "stop", stop: "stop", keep: "keep", discard: "discard", hold: "hold", toggle: "toggle", mic: "mic" },
    };

    overlay.publish(snapshot);
    // Recording ends while readRect() is still pending.
    overlay.publish(null);
    resolveRect({ x: 50, y: 50 });
    await new Promise((r) => setTimeout(r, 20));

    expect(electronMock.created).toHaveLength(0);
    overlay.close();
  });

  it("V-09: VadWorkerClient clears this.ready on init-error so subsequent calls can recover", async () => {
    const dir = makeTempDir("voice-vad-err-");
    const markerFile = path.join(dir, "failed-once.flag");
    const workerScript = path.join(dir, "flaky-worker.mjs");
    fs.writeFileSync(
      workerScript,
      `
      import fs from "node:fs";
      import { parentPort, workerData } from "node:worker_threads";
      const flag = workerData.modelPath;
      if (!fs.existsSync(flag)) {
        fs.writeFileSync(flag, "1");
        parentPort.postMessage({ type: "init-error", message: "transient wasm init failure" });
      } else {
        parentPort.postMessage({ type: "ready" });
        parentPort.on("message", (msg) => {
          if (msg.type === "push") {
            parentPort.postMessage({ type: "result", id: msg.id, probs: new Float32Array([0.9]) });
          } else if (msg.type === "shutdown") {
            process.exit(0);
          }
        });
      }
      `,
    );

    const client = new VadWorkerClient({
      workerPath: workerScript,
      assets: { modelPath: markerFile, ortEntry: workerScript, wasmDir: dir },
    });
    cleanups.push(() => client.dispose());

    const stream1 = client.open();
    await expect(stream1.push(new Int16Array(512))).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
    stream1.close();

    // Second call must respawn a fresh worker rather than reusing the rejected `this.ready` promise.
    const stream2 = client.open();
    const probs = await stream2.push(new Int16Array(512));
    expect(probs[0]).toBeCloseTo(0.9, 5);
    stream2.close();
  });

  it("F-09, V-10 & V-11: CaptureService.list supports `before`, concurrent stop/shutdown share stopPromise, and replan removes stale pending rows", async () => {
    const h = voiceHarness();
    h.asr.connection = null;
    harnesses.push(h);

    // Seed two sessions with distinct timestamps to verify `before` pagination (F-09).
    const r = seedResource(h.store);
    const s1 = h.service.start({ mode: "toggle", resourceId: r.resourceId, resourceRevisionId: r.revisionId, locator: textLocator(0) });
    feed(h.service, s1.sessionId, tone(1200));
    await h.service.stop({ sessionId: s1.sessionId });
    h.store.sqlite.prepare("UPDATE capture_sessions SET created_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", s1.sessionId);

    const s2 = h.service.start({ mode: "toggle", resourceId: r.resourceId, resourceRevisionId: r.revisionId, locator: textLocator(100) });
    feed(h.service, s2.sessionId, tone(1200));
    // V-11: Concurrent stop() and shutdown() during stop must both settle cleanly on the same stopPromise.
    const [stopped] = await Promise.all([
      h.service.stop({ sessionId: s2.sessionId }),
      h.service.shutdown(),
    ]);
    expect(stopped.id).toBe(s2.sessionId);
    h.store.sqlite.prepare("UPDATE capture_sessions SET created_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", s2.sessionId);

    const beforeSecond = h.service.list({ before: "2026-01-02T00:00:00.000Z" });
    expect(beforeSecond.sessions.map((row) => row.id)).toEqual([s1.sessionId]);

    // V-10: Re-planning after `maxUploadBytes` shrinks replaces stale pending chunks instead of duplicating segments.
    const h2 = voiceHarness();
    h2.asr.connection = null;
    harnesses.push(h2);
    const s3 = h2.service.start({ mode: "toggle" });
    feed(h2.service, s3.sessionId, join(quiet(500), tone(5000), quiet(500)));
    await h2.service.stop({ sessionId: s3.sessionId });
    await h2.settle(s3.sessionId);
    const initialSegments = h2.service.review(s3.sessionId).segments;
    expect(initialSegments.length).toBeGreaterThanOrEqual(1);
    expect(initialSegments.every((seg) => seg.state === "pending")).toBe(true);

    // Now configure an ASR connection with a tiny byte limit so chunk boundaries split into multiple blocks.
    h2.asr.connection = {
      id: "asr_small",
      model: "whisper",
      maxUploadBytes: 2000 * PCM_BYTES_PER_MS + 44,
      timeoutMs: 5000,
    };
    await h2.service.pipeline.schedule(s3.sessionId);
    await h2.settle(s3.sessionId);

    const finalSegs = h2.service.review(s3.sessionId).segments;
    expect(finalSegs.length).toBeGreaterThan(initialSegments.length);
    expect(finalSegs.every((seg) => seg.state === "done")).toBe(true);
    // Ensure no overlapping stale pending rows remain.
    for (let i = 1; i < finalSegs.length; i += 1) {
      expect(finalSegs[i]!.startMs).toBeGreaterThanOrEqual(finalSegs[i - 1]!.endMs);
    }
  });

  it("V-13: AsrEngine builds local segments from tokens/timestamps, forces audio/wav when re-encoded, and joins CJK/ASCII chunks cleanly", async () => {
    const seenExternal: Array<{ mimeType: string; filename: string }> = [];
    let fetchCount = 0;
    const engine = new AsrEngine({
      modelService: {
        getCatalogEntry: () => ({ modelId: "sv", name: "SV", kind: "senseVoice", hotwords: 0 }),
        getRuntimeFiles: () => ({
          model: { modelId: "sv", name: "SV", kind: "senseVoice", hotwords: 0 },
          installDir: "/fake",
          files: { model: "m.onnx", tokens: "t.txt" },
        }),
      } as unknown as AsrModelService,
      localRuntime: {
        getModelStatus: () => ({ status: "loaded", crashCount: 0, lastError: null }),
        load: async () => ({ loaded: true, modelId: "sv", kind: "senseVoice", reused: true, elapsedMs: 1, rssBytes: 100 }),
        recognize: async () => ({
          text: "你好世界",
          rawText: "你好世界",
          tokens: ["你", "好", "世", "界"],
          timestamps: [0.1, 0.3, 0.6, 0.9],
          lang: "zh",
          modelId: "sv",
          elapsedMs: 10,
        }),
      },
      resolveConnection: () => ({
        id: "ext_1",
        name: "Test Whisper",
        protocol: "audio_transcriptions",
        baseUrl: "https://example.invalid/v1",
        apiKey: "test-key",
        model: "whisper-1",
        maxUploadBytes: 40_000,
        maxSeconds: 2,
      }),
      fetchImpl: (async (_url: unknown, init?: RequestInit) => {
        fetchCount += 1;
        const form = init?.body as FormData;
        const file = form.get("file") as File;
        seenExternal.push({ mimeType: file.type, filename: file.name });
        return new Response(JSON.stringify({ text: fetchCount % 2 === 1 ? "Hello" : "world" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    // V-13a: Local ASR populates segments when `timestamps: true`.
    const localRes = await engine.transcribe({
      audio: new Int16Array(16_000),
      selection: { kind: "local", modelId: "sv" },
      timestamps: true,
    });
    expect(localRes.segments).toHaveLength(1);
    expect(localRes.segments![0]).toMatchObject({ text: "你好世界", start: 0.1 });
    expect(localRes.segments![0]!.end).toBeGreaterThan(0.9);

    // V-13b & V-13c: External re-encoded WAV forces audio/wav & .wav filename, and joins ASCII chunks with a space.
    const extRes = await engine.transcribe({
      audio: new Int16Array(16_000 * 3),
      mimeType: "audio/mpeg",
      fileName: "clip.mp3",
      selection: { kind: "connection", connectionId: "ext_1" },
    });
    expect(seenExternal.length).toBeGreaterThanOrEqual(2);
    for (const upload of seenExternal) {
      expect(upload.mimeType).toBe("audio/wav");
      expect(upload.filename).toMatch(/\.wav$/);
    }
    expect(extRes.text).toBe(seenExternal.map((_, i) => (i % 2 === 0 ? "Hello" : "world")).join(" "));
  });

  it("V-14: AsrService clears remoteLoadedModelId on failed load and attributes unexpected exit to the loaded model", async () => {
    const dir = makeTempDir("voice-asr-state-");
    const entry = path.join(dir, "asr-host.cjs");
    fs.writeFileSync(entry, "");

    let failSecondLoad = true;
    let loadCalls = 0;
    const spawner: AsrSpawner = () => {
      const msgListeners: Array<(msg: AsrHostMessage) => void> = [];
      const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
      let exited = false;
      const emit = (msg: AsrHostMessage) => { if (!exited) for (const fn of msgListeners) fn(msg); };
      const exit = (code: number | null) => { if (!exited) { exited = true; for (const fn of exitListeners) fn(code, null); } };
      queueMicrotask(() => emit({ t: "ready", pid: 5555 }));
      const ch: AsrChannel = {
        pid: 5555,
        send(req: AsrHostRequest) {
          if (req.t === "stop") { queueMicrotask(() => exit(0)); return; }
          queueMicrotask(() => {
            if (req.method === "load") {
              loadCalls += 1;
              if (loadCalls === 2 && failSecondLoad) {
                emit({ t: "result", id: req.id, ok: false, error: { code: "LOAD_ERR", message: "corrupt model B" } });
                return;
              }
              emit({ t: "result", id: req.id, ok: true, value: { loaded: true, modelId: req.params.modelId, kind: req.params.kind, reused: false, elapsedMs: 1, rssBytes: 100 } });
              return;
            }
            if (req.method === "recognize") {
              exit(139);
              return;
            }
            emit({ t: "result", id: req.id, ok: true, value: { unloaded: true } });
          });
        },
        onMessage: (fn) => msgListeners.push(fn),
        onExit: (fn) => exitListeners.push(fn),
        kill: () => exit(null),
        stderrTail: () => "",
      };
      return ch;
    };

    const svc = new AsrService({ spawner, entryPath: entry });
    cleanups.push(() => svc.dispose());

    await svc.load("model-a", "senseVoice", { model: "a.onnx", tokens: "t.txt" });
    await expect(svc.load("model-b", "senseVoice", { model: "b.onnx", tokens: "t.txt" })).rejects.toThrow(/corrupt model B/);
    // Re-loading model-a must NOT be short-circuited as `reused: true` because child disposed recognizer before failing load(model-b).
    const reloaded = await svc.load("model-a", "senseVoice", { model: "a.onnx", tokens: "t.txt" });
    expect(reloaded.reused).toBe(false);
    expect(loadCalls).toBe(3);

    // Crash during recognize must increment crashCount on model-a.
    await expect(svc.recognize(new Float32Array([0.1]))).rejects.toMatchObject({ code: "ASR_PROCESS_CRASHED" });
    expect(svc.getModelStatus("model-a").crashCount).toBe(1);
    failSecondLoad = false;
  });

  it("V-16: OpenCC handles >6,143 protected spans without PUA collisions, and polish guard pre-filters 10k terms", () => {
    const repeated = Array.from({ length: 6_500 }, () => "臺灣").join("、");
    const converted = convertChineseVariant(`請看${repeated}的報導`, "simplified", ["臺灣"]);
    expect(converted.startsWith("请看臺灣")).toBe(true);
    expect(converted.endsWith("的报导")).toBe(true);
    // Must not contain any Private Use Area placeholder code points.
    expect(/[\uE000-\uF8FF]/.test(converted)).toBe(false);

    const tenThousandTerms = Array.from({ length: 10_000 }, (_, i) => `词条编号${i}`);
    tenThousandTerms.push("黑翼天使");
    expect(
      validatePolishOutput({
        correctedText: "今天天气不错，大家一起去散步。",
        polishedText: "今天天气不错，黑翼天使一起去散步。",
        candidates: [],
        dictionaryTerms: tenThousandTerms,
      }),
    ).toBe("unexpected_entity");
  });

  it("V-17: PhoneticCorrector handles >8 same-term anchors per sentence and Turkish dotted İ (U+0130) length alignment", () => {
    const corrector = new PhoneticCorrector();
    corrector.upsertTerm({
      id: "t1",
      scope: "global",
      workId: null,
      term: "天海凛音",
      category: "character",
      source: "manual",
      aliases: [{ alias: "天海林音", kind: "alias" }],
    });
    corrector.upsertTerm({
      id: "t2",
      scope: "global",
      workId: null,
      term: "Frieren",
      category: "character",
      source: "manual",
    });

    // 10 occurrences of the same misrecognized term in one sentence (exceeds inline cap 8).
    const tenHits = Array.from({ length: 10 }, () => "天海林音").join("，");
    const res = corrector.correct(tenHits);
    expect(res.replacements).toHaveLength(10);
    expect(res.correctedText).toBe(Array.from({ length: 10 }, () => "天海凛音").join("，"));

    // Turkish İ (U+0130) expands under JS `.toLowerCase()` to 2 code units; foldSameLength keeps offsets exact.
    const dotted = "İstanbul 的 frieren 很好看";
    const dottedRes = corrector.correct(dotted);
    expect(dottedRes.correctedText).toBe("İstanbul 的 Frieren 很好看");
  });

  it("V-18: extractEditedTermSpan rejects near-full rewrites on long sentences while accepting targeted edits", () => {
    const longOriginal = "今天下午我们一起去图书馆看漫画然后去吃拉面再回家休息吧";
    const nearFullRewrite = "今天完全换成了另一段毫无关系的全新长句子用来测试重写吧";
    expect(extractEditedTermSpan(longOriginal, nearFullRewrite)).toBeNull();

    const targeted = "今天下午我们一起去图书馆看天海林音的演出然后去吃拉面再回家休息吧";
    const fixed = "今天下午我们一起去图书馆看天海凛音的演出然后去吃拉面再回家休息吧";
    const span = extractEditedTermSpan(targeted, fixed);
    expect(span).not.toBeNull();
    expect(span!.heard).toContain("林");
    expect(span!.term).toContain("凛");
  });

  it("V-20d: writeRecordingSettings rejects dictationHoldKey colliding with holdKey or toggleKey", () => {
    const h = voiceHarness();
    harnesses.push(h);

    expect(() => writeRecordingSettings(h.store, { dictationHoldKey: "F9" })).toThrowError(MangaError);
    expect(() => writeRecordingSettings(h.store, { dictationHoldKey: "F8" })).toThrowError(MangaError);
    expect(() => writeRecordingSettings(h.store, { holdKey: "F10", dictationHoldKey: "F10" })).toThrowError(MangaError);
    expect(writeRecordingSettings(h.store, { dictationHoldKey: "F7" }).dictationHoldKey).toBe("F7");
  });
});
