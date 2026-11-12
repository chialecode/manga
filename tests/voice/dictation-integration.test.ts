import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalAsrRuntimePort } from "@manga/app-core";
import { startMockProvider } from "@manga/model-protocol";
import type { VadEngine } from "../../packages/app-core/src/voice/vad-client.ts";
import { stagingPartPath, stagingStatePath } from "../../packages/app-core/src/voice/models/index.ts";
import { startApp, writeTempWav } from "../helpers/app.ts";
import { FakeBangumi, picture } from "../helpers/fake-bangumi.ts";
import {
  createSyntheticModelFixture,
  startFakeModelServer,
  type FakeModelServer,
} from "../helpers/fake-model-server.ts";
import { testTempRoot } from "../helpers/global-temp.ts";
import { seedVideo } from "../helpers/media-seed.ts";

function makeSpeechVad(): VadEngine {
  return {
    available: true,
    open() {
      return {
        async push(pcm: Int16Array) {
          const frames = Math.max(1, Math.floor(pcm.length / 512));
          const probs = new Float32Array(frames);
          probs.fill(0.92);
          return probs;
        },
        close() {
          // no-op
        },
      };
    },
    async analyzeFile(file: string) {
      const bytes = fs.statSync(file).size;
      const samples = Math.floor(bytes / 2);
      const frames = Math.max(4, Math.floor(samples / 512));
      const probs = new Float32Array(frames);
      probs.fill(0.9);
      return probs;
    },
    dispose() {
      // no-op
    },
  };
}

function makeSpeechPcmBase64(durationMs = 1200, amplitude = 9000): string {
  const sampleCount = Math.floor((16_000 * durationMs) / 1000);
  const pcm = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    pcm[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / 16_000));
  }
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}

function walkFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

describe("voice dictation end-to-end integration (M12 Wave 3A)", () => {
  const closeables: Array<() => Promise<void> | void> = [];
  const tempDirs: string[] = [];

  const makeWorkDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(testTempRoot(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    while (closeables.length > 0) {
      const fn = closeables.pop()!;
      await fn();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("AT-174 / AT-182: runs full dictation stream_replace lifecycle, 24h retranscribe, learn-from-edits loop, and excludes dictation_history from backups & exports", async () => {
    let asrTranscript = "那个，今天看到雾岛千下出场了";
    const provider = await startMockProvider({
      transcriptionText: () => asrTranscript,
      respond: ({ body }) => {
        const messages = (body.messages as Array<{ role: string; content: string }> | undefined) ?? [];
        const userText = messages.find((m) => m.role === "user")?.content ?? "";
        if (userText.includes("雾岛千夏")) {
          return { text: "今天看到雾岛千夏出场了。" };
        }
        return { text: "今天看到雾岛千下出场了。" };
      },
    });
    closeables.push(() => provider.close());

    const fixtureDir = makeWorkDir("manga-dic-e2e-");
    const localModel = createSyntheticModelFixture(fixtureDir, {
      modelId: "qwen3-asr-0.6B-int8",
      kind: "qwen3Asr",
    });

    let localLoaded = false;
    const localAsr: LocalAsrRuntimePort & { unload: () => Promise<{ unloaded: true }> } = {
      getModelStatus: (modelId) => ({
        modelId,
        status: localLoaded ? "loaded" : "unloaded",
        crashCount: 0,
      }),
      async load(modelId) {
        localLoaded = true;
        return { modelId, kind: "qwen3Asr", loadMs: 12, rssBytes: 64 * 1024 * 1024 };
      },
      async recognize() {
        return {
          text: "重转写后的雾岛千下登场记录",
          rawText: "重转写后的雾岛千下登场记录",
          tokens: [],
          timestamps: [],
          lang: "zh",
          modelId: localModel.modelId,
          elapsedMs: 15,
        };
      },
      async unload() {
        localLoaded = false;
        return { unloaded: true };
      },
    };

    const { app, actor, grant, profileRoot } = await startApp({
      options: {
        vad: makeSpeechVad(),
        localAsr,
        asrModels: {
          catalog: [localModel.catalogModel],
        },
      },
    });
    closeables.push(() => app.close());

    let keySeq = 0;
    const call = (commandId: string, input: Record<string, unknown> = {}, customKey?: string) =>
      app.call(
        actor,
        { commandId, idempotencyKey: customKey ?? `e2e-${++keySeq}`, input },
        grant.handle,
      );

    // Import synthetic local model directory for later 24h audio re-transcription
    const dirHandle = app.registerPath("directory", localModel.extractedDir);
    const importedModel = await call("asrModel.import", {
      modelId: localModel.modelId,
      pathHandle: dirHandle,
      kind: "directory",
    });
    expect(importedModel.status).toBe("ok");

    // Configure external transcription + text polish connections
    const asrSecret = app.stashSecret("sk-asr-e2e");
    const asrConn = await call("connections.upsert", {
      label: "Whisper ASR",
      protocol: "openai-chat-completions",
      baseUrl: provider.url,
      modelId: "whisper-1",
      purpose: "transcription",
      credentialHandle: asrSecret,
    });
    expect(asrConn.status).toBe("ok");
    const asrConnId = String((asrConn.value as { id: string }).id);

    const llmSecret = app.stashSecret("sk-llm-e2e");
    const llmConn = await call("connections.upsert", {
      label: "Polish LLM",
      protocol: "openai-chat-completions",
      baseUrl: provider.url,
      modelId: "gpt-4o-mini",
      purpose: "text",
      credentialHandle: llmSecret,
    });
    expect(llmConn.status).toBe("ok");
    const llmConnId = String((llmConn.value as { id: string }).id);

    const setRec = await call("settings.setRecording", {
      dictationEngine: { kind: "connection", connectionId: asrConnId },
      polishMode: "light",
      polishConnectionId: llmConnId,
      dictationInsertMode: "stream_replace",
      retainDictationAudio24h: true,
    });
    expect(setRec.status).toBe("ok");

    const stageNotices: Array<{ stage: string; rawText: string; finalText: string }> = [];
    const offNotice = app.onNotice((notice) => {
      if (notice.topic === "dictation.changed" && typeof notice.payload.stage === "string") {
        stageNotices.push({
          stage: String(notice.payload.stage),
          rawText: String(notice.payload.rawText ?? ""),
          finalText: String(notice.payload.finalText ?? ""),
        });
      }
    });

    // 1. Start -> append -> busy check -> stop (stream_replace two-stage lifecycle)
    const started = await call("dictation.start", { mode: "hold", sampleRate: 16_000 });
    expect(started.status).toBe("ok");
    const dictationId = String((started.value as { dictationId: string }).dictationId);
    expect((started.value as { stage: string }).stage).toBe("recording");
    expect(app.busyReasons()).toContain("recording");

    const appended = await call(
      "dictation.append",
      { dictationId, seq: 0, data: makeSpeechPcmBase64(1200) },
      `dic:${dictationId}:0`,
    );
    expect(appended.status).toBe("ok");

    const stopped = await call("dictation.stop", { dictationId, reason: "user" });
    offNotice();
    expect(stopped.status).toBe("ok");

    const snap = stopped.value as {
      stage: string;
      rawText: string;
      correctedText: string;
      finalText: string;
      historyId: string | null;
    };
    expect(snap.stage).toBe("done");
    expect(snap.rawText).toBe("那个，今天看到雾岛千下出场了");
    expect(snap.finalText).toBe("今天看到雾岛千下出场了。");
    expect(snap.historyId).toBeTruthy();

    // Per-chunk idempotency receipt was cleaned up on stop
    const leftChunkReceipts = app.store.sqlite
      .prepare("SELECT COUNT(*) AS n FROM command_requests WHERE command_id = 'dictation.append'")
      .get() as { n: number };
    expect(leftChunkReceipts.n).toBe(0);

    // Verify stream_replace stage progression: `correcting` carries rawText before `polishing` -> `done` carries finalText
    const stages = stageNotices.map((item) => item.stage);
    expect(stages).toEqual(["recording", "trimming", "recognizing", "correcting", "polishing", "done"]);
    const correctingNotice = stageNotices.find((item) => item.stage === "correcting")!;
    expect(correctingNotice.rawText).toBe("那个，今天看到雾岛千下出场了");

    // 2. Verify history saved + 24h retained WAV re-transcription with local ASR engine
    const histList = await call("dictation.history.list", { limit: 10 });
    expect(histList.status).toBe("ok");
    const items = (histList.value as { items: Array<{ id: string; audioAvailable: boolean; finalText: string }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.audioAvailable).toBe(true);

    const retranscribed = await call("dictation.history.retranscribe", {
      historyId: items[0]!.id,
      engine: { kind: "local", modelId: localModel.modelId },
    });
    expect(retranscribed.status).toBe("ok");
    expect((retranscribed.value as { rawText: string }).rawText).toBe("重转写后的雾岛千下登场记录");

    // 3. Learn-from-edits closed loop: observeEdit -> suggestions.list -> decide("accept") -> next dictation auto-replaces!
    const observed = await call("dictionary.observeEdit", {
      insertedText: "今天看到雾岛千下出场了。",
      editedText: "今天看到雾岛千夏出场了。",
    });
    expect(observed.status).toBe("ok");
    const suggestion = (observed.value as { suggestion: { id: string; term: string; heard: string } | null; promptText: string | null }).suggestion;
    expect(suggestion).toMatchObject({ term: "雾岛千夏", heard: "雾岛千下" });
    expect((observed.value as { promptText: string }).promptText).toBe("把「雾岛千夏」加入词典？（识别成了「雾岛千下」）");

    const pendingSuggestions = await call("dictionary.suggestions.list", { status: "pending" });
    expect(pendingSuggestions.status).toBe("ok");
    expect((pendingSuggestions.value as { suggestions: Array<{ id: string }> }).suggestions).toHaveLength(1);

    const decided = await call("dictionary.suggestions.decide", {
      suggestionId: suggestion!.id,
      action: "accept",
    });
    expect(decided.status).toBe("ok");

    // Second dictation: ASR still misrecognizes "雾岛千下", PhoneticCorrector deterministically replaces it with "雾岛千夏"!
    asrTranscript = "那个，今天看到雾岛千下出场了";
    const start2 = await call("dictation.start", { mode: "locked", sampleRate: 16_000 });
    expect(start2.status).toBe("ok");
    const dicId2 = String((start2.value as { dictationId: string }).dictationId);
    await call("dictation.append", { dictationId: dicId2, seq: 0, data: makeSpeechPcmBase64(1200) }, `dic:${dicId2}:0`);
    const stop2 = await call("dictation.stop", { dictationId: dicId2, reason: "user" });
    expect(stop2.status).toBe("ok");
    const snap2 = stop2.value as {
      correctedText: string;
      finalText: string;
      replacements: Array<{ original: string; replacement: string; term: string }>;
    };
    expect(snap2.correctedText).toContain("雾岛千夏");
    expect(snap2.finalText).toBe("今天看到雾岛千夏出场了。");
    expect(snap2.replacements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ original: "雾岛千下", replacement: "雾岛千夏", term: "雾岛千夏" }),
      ]),
    );

    // 4. Backup & Package Export Isolation (AT-182): dictation_history and dictation-audio are NEVER included!
    const backupDbFile = path.join(profileRoot, "manual-backup.sqlite");
    app.store.copyForBackup(backupDbFile);
    const inspectDb = new Database(backupDbFile, { readonly: true });
    try {
      const histCount = inspectDb.prepare("SELECT COUNT(*) AS n FROM dictation_history").get() as { n: number };
      const termCount = inspectDb.prepare("SELECT COUNT(*) AS n FROM dictionary_terms").get() as { n: number };
      expect(histCount.n).toBe(0);
      expect(termCount.n).toBeGreaterThanOrEqual(1);
    } finally {
      inspectDb.close();
    }

    const preUpdateDbPath = app.update.writePreUpdateBackup("0.1.0", { refresh: true });
    expect(preUpdateDbPath).toBeTruthy();
    expect(fs.existsSync(path.join(path.dirname(preUpdateDbPath!), "dictation-audio"))).toBe(false);
    const preUpdateDb = new Database(preUpdateDbPath!, { readonly: true });
    try {
      const histCount = preUpdateDb.prepare("SELECT COUNT(*) AS n FROM dictation_history").get() as { n: number };
      expect(histCount.n).toBe(0);
    } finally {
      preUpdateDb.close();
    }

    const libExportDir = makeWorkDir("manga-lib-exp-");
    const libExportHandle = app.registerPath("directory", libExportDir);
    const libExp = await call("library.exportPackage", { pathHandle: libExportHandle });
    expect(libExp.status).toBe("ok");
    for (const file of walkFiles(libExportDir)) {
      const text = fs.readFileSync(file).toString("utf8");
      expect(text).not.toContain("重转写后的雾岛千下登场记录");
      expect(path.basename(file)).not.toMatch(/\.wav$/i);
    }

    const proj = await call("project.create", { name: "听写隔离测试项目" });
    expect(proj.status).toBe("ok");
    const projectId = String((proj.value as { id: string }).id);
    const projZipDir = makeWorkDir("manga-proj-exp-");
    const projZipHandle = app.registerPath("directory", projZipDir);
    const projExp = await call("project.exportPackage", { projectId, pathHandle: projZipHandle });
    expect(projExp.status).toBe("ok");
    const zipBytes = fs.readFileSync(path.join(projZipDir, String((projExp.value as { fileName: string }).fileName)));
    expect(zipBytes.toString("utf8")).not.toContain("重转写后的雾岛千下登场记录");
  });

  it("AT-177: routes audio_transcriptions, chat_input_audio, local ASR + GTCRN denoise across dictation, capture & transcribeAudio with zero cross-engine fallback", async () => {
    let whisperRequests = 0;
    const whisperServer = await startMockProvider({
      transcriptionText: () => {
        whisperRequests += 1;
        return "标准Whisper转录结果";
      },
    });
    closeables.push(() => whisperServer.close());

    const chatAudioServer = await startMockProvider({
      audioTranscript: (capture) => `多模态音频结果(${capture.audioFormat})`,
    });
    closeables.push(() => chatAudioServer.close());

    const failingServer = await startMockProvider({ mode: "unauthorized" });
    closeables.push(() => failingServer.close());

    const fixtureDir = makeWorkDir("manga-dic-routing-");
    const localModel = createSyntheticModelFixture(fixtureDir, {
      modelId: "funasr-nano-int8",
      kind: "funasrNano",
    });

    let localRecognizeCalls = 0;
    let denoiseCalls = 0;
    let localStatus: "unloaded" | "loaded" | "load_failed" = "unloaded";
    let lastHotwords: readonly string[] | string | undefined;

    const localAsr: LocalAsrRuntimePort = {
      getModelStatus: (modelId) => ({
        modelId,
        status: localStatus,
        crashCount: localStatus === "load_failed" ? 2 : 0,
        ...(localStatus === "load_failed" ? { reason: "本地模型连续崩溃" } : {}),
      }),
      async load(modelId) {
        localStatus = "loaded";
        return { modelId, kind: "funasrNano", loadMs: 8, rssBytes: 32 * 1024 * 1024 };
      },
      async recognize(_samples, options) {
        localRecognizeCalls += 1;
        lastHotwords = options?.hotwords;
        return {
          text: "本地FunASR离线识别结果",
          rawText: "本地FunASR离线识别结果",
          tokens: [],
          timestamps: [],
          lang: "zh",
          modelId: localModel.modelId,
          elapsedMs: 10,
        };
      },
      async denoise(samples) {
        denoiseCalls += 1;
        return { samples: new Float32Array(samples), sampleRate: 16_000, elapsedMs: 3 };
      },
    };

    const { app, actor, grant, profileRoot } = await startApp({
      options: {
        vad: makeSpeechVad(),
        localAsr,
        asrModels: { catalog: [localModel.catalogModel] },
      },
    });
    closeables.push(() => app.close());

    let seq = 0;
    const call = (commandId: string, input: Record<string, unknown> = {}) =>
      app.call(actor, { commandId, idempotencyKey: `rt-${++seq}`, input }, grant.handle);

    // 1. connections.test supports BOTH audio_transcriptions and chat_input_audio
    const s1 = app.stashSecret("key-whisper");
    const cWhisper = await call("connections.upsert", {
      label: "Whisper Endpoint",
      protocol: "openai-chat-completions",
      baseUrl: whisperServer.url,
      modelId: "whisper-1",
      purpose: "transcription",
      credentialHandle: s1,
      profile: { transcriptionInterface: "audio_transcriptions" },
    });
    const whisperId = String((cWhisper.value as { id: string }).id);
    const probeWhisper = await call("connections.test", { connectionId: whisperId, capability: "transcription" });
    expect(probeWhisper.status).toBe("ok");
    expect(whisperRequests).toBe(1);

    const s2 = app.stashSecret("key-chat-audio");
    const cChat = await call("connections.upsert", {
      label: "Chat Input Audio",
      protocol: "openai-chat-completions",
      baseUrl: chatAudioServer.url,
      modelId: "gpt-4o-mini-audio",
      purpose: "transcription",
      credentialHandle: s2,
      profile: { transcriptionInterface: "chat_input_audio" },
    });
    const chatId = String((cChat.value as { id: string }).id);
    const probeChat = await call("connections.test", { connectionId: chatId, capability: "transcription" });
    expect(probeChat.status).toBe("ok");
    expect(chatAudioServer.audioCaptures).toHaveLength(1);
    expect(chatAudioServer.audioCaptures[0]!.audioFormat).toBe("wav");

    // Add a dictionary term to verify vocabulary hint delivery
    await call("dictionary.add", { scope: "global", term: "星野澪" });

    // 2. Dictation via chat_input_audio + GTCRN denoise
    await call("settings.setRecording", {
      dictationEngine: { kind: "connection", connectionId: chatId },
      polishMode: "raw",
      gtcrnDenoise: true,
    });
    const dChat = await call("dictation.start", { mode: "hold" });
    const dChatId = String((dChat.value as { dictationId: string }).dictationId);
    await call("dictation.append", { dictationId: dChatId, seq: 0, data: makeSpeechPcmBase64(1000) });
    const dChatStop = await call("dictation.stop", { dictationId: dChatId });
    expect(dChatStop.status).toBe("ok");
    expect((dChatStop.value as { finalText: string }).finalText).toBe("多模态音频结果(wav)");
    expect(denoiseCalls).toBe(1);
    expect(chatAudioServer.audioCaptures.at(-1)!.systemContext).toContain("星野澪");

    // 3. Import local model -> first dictation start reports loadingModel: true while unloaded -> passes hotwords
    const dirHandle = app.registerPath("directory", localModel.extractedDir);
    await call("asrModel.import", { modelId: localModel.modelId, pathHandle: dirHandle, kind: "directory" });
    await call("settings.setRecording", {
      dictationEngine: { kind: "local", modelId: localModel.modelId },
      polishMode: "raw",
      gtcrnDenoise: false,
    });
    expect(localStatus).toBe("unloaded");
    const dLocalStart = await call("dictation.start", { mode: "hold" });
    expect((dLocalStart.value as { loadingModel: boolean }).loadingModel).toBe(true);
    const dLocalId = String((dLocalStart.value as { dictationId: string }).dictationId);
    await call("dictation.append", { dictationId: dLocalId, seq: 0, data: makeSpeechPcmBase64(1000) });
    const dLocalStop = await call("dictation.stop", { dictationId: dLocalId });
    expect(dLocalStop.status).toBe("ok");
    expect((dLocalStop.value as { finalText: string }).finalText).toBe("本地FunASR离线识别结果");
    expect(String(lastHotwords ?? "")).toContain("星野澪");

    // 4. library.transcribeAudio routes through AsrEngine (both chat_input_audio and local model)
    const work = seedVideo(app, { title: "音频转录作品" });
    const wavPath = writeTempWav(profileRoot, "sample-speech.wav");
    const fileHandle = app.registerPath("file", wavPath);
    const fileChatRes = await call("library.transcribeAudio", {
      pathHandle: fileHandle,
      workId: work.workId,
      connectionId: chatId,
    });
    expect(fileChatRes.status).toBe("ok");
    expect(String((fileChatRes.value as { text: string }).text)).toContain("多模态音频结果");

    const fileLocalRes = await call("library.transcribeAudio", {
      pathHandle: fileHandle,
      workId: work.workId,
      connectionId: `local:${localModel.modelId}`,
    });
    expect(fileLocalRes.status).toBe("ok");
    expect((fileLocalRes.value as { text: string }).text).toBe("本地FunASR离线识别结果");

    // 5. Strict ZERO cross-engine fallback: failing selected engine sends 0 requests to healthy engines!
    const sFail = app.stashSecret("bad-key");
    const cFail = await call("connections.upsert", {
      label: "Unauthorized ASR",
      protocol: "openai-chat-completions",
      baseUrl: failingServer.url,
      modelId: "whisper-1",
      purpose: "transcription",
      credentialHandle: sFail,
    });
    const failConnId = String((cFail.value as { id: string }).id);

    const whisperBefore = whisperRequests;
    const chatBefore = chatAudioServer.requestCount();
    const localBefore = localRecognizeCalls;

    await call("settings.setRecording", {
      dictationEngine: { kind: "connection", connectionId: failConnId },
      polishMode: "raw",
    });
    const dFailStart = await call("dictation.start", { mode: "hold" });
    const dFailId = String((dFailStart.value as { dictationId: string }).dictationId);
    await call("dictation.append", { dictationId: dFailId, seq: 0, data: makeSpeechPcmBase64(1000) });
    const dFailStop = await call("dictation.stop", { dictationId: dFailId });
    expect(dFailStop.status).toBe("ok");
    expect((dFailStop.value as { stage: string; errorCode: string }).stage).toBe("failed");
    expect((dFailStop.value as { errorCode: string }).errorCode).toBe("AUTHENTICATION_FAILED");

    // ZERO cross-engine requests were sent to any healthy engine!
    expect(whisperRequests).toBe(whisperBefore);
    expect(chatAudioServer.requestCount()).toBe(chatBefore);
    expect(localRecognizeCalls).toBe(localBefore);

    // Local load_failed also fails fast with 0 requests to remote connections
    localStatus = "load_failed";
    await call("settings.setRecording", {
      dictationEngine: { kind: "local", modelId: localModel.modelId },
    });
    const loadFailedStart = await call("dictation.start", { mode: "hold" });
    expect(loadFailedStart.status).toBe("error");
    expect(loadFailedStart.error?.code).toBe("CAPABILITY_UNAVAILABLE");
    expect((loadFailedStart.error?.details as { reason?: string } | undefined)?.reason).toBe("model_load_failed");
    expect(whisperRequests).toBe(whisperBefore);
    expect(chatAudioServer.requestCount()).toBe(chatBefore);

    // "Auto" (no explicit engine) keeps the installed local model that failed to load: it reports the failure instead of sending the audio to a connection.
    await call("settings.setRecording", { dictationEngine: null });
    const autoFailedStart = await call("dictation.start", { mode: "hold" });
    expect(autoFailedStart.status).toBe("error");
    expect((autoFailedStart.error?.details as { reason?: string } | undefined)?.reason).toBe("model_load_failed");
    expect(whisperRequests).toBe(whisperBefore);
    expect(chatAudioServer.requestCount()).toBe(chatBefore);

    // Shortcut conflict guard: binding recording holdKey to AltRight conflicts with global.dictationHold ("RightAlt")
    const conflictRes = await call("settings.setRecording", { holdKey: "AltRight" });
    expect(conflictRes.status).toBe("error");
    expect(conflictRes.error?.code).toBe("VALIDATION_ERROR");
  });

  it("AT-178: enforces download confirmation, supports pause + HTTP 206 Range resume, cleans staging on checksum mismatch, and unloads active model before delete", async () => {
    const workDir = makeWorkDir("manga-dic-models-");
    const server: FakeModelServer = await startFakeModelServer();
    closeables.push(() => server.close());

    const goodFixture = createSyntheticModelFixture(workDir, {
      modelId: "sense-voice-funasr-nano-int8",
      kind: "senseVoice",
      sourceUrl: `${server.baseUrl}/models/sense-voice.tar.bz2`,
      weightsByteLength: 64 * 1024,
    });
    const badFixture = createSyntheticModelFixture(workDir, {
      modelId: "qwen3-asr-0.6B-int8",
      kind: "qwen3Asr",
      sourceUrl: `${server.baseUrl}/models/qwen3-corrupt.tar.bz2`,
      weightsByteLength: 32 * 1024,
    });

    server.setRoute("/models/sense-voice.tar.bz2", {
      payload: goodFixture.archiveBuffer,
      chunkBytes: 8 * 1024,
      chunkDelayMs: 35,
    });
    server.setRoute("/models/qwen3-corrupt.tar.bz2", {
      payload: badFixture.archiveBuffer,
      tamperOffset: 128,
    });

    let unloadCount = 0;
    let modelLoaded = false;
    const localAsr: LocalAsrRuntimePort & { unload: () => Promise<{ unloaded: true }> } = {
      getModelStatus: (modelId) => ({
        modelId,
        status: modelLoaded && modelId === goodFixture.modelId ? "loaded" : "unloaded",
        crashCount: 0,
      }),
      async load(modelId) {
        modelLoaded = true;
        return { modelId, kind: "senseVoice", loadMs: 5, rssBytes: 16 * 1024 * 1024 };
      },
      async recognize() {
        return { text: "ok", rawText: "ok", tokens: [], timestamps: [], lang: "zh", modelId: goodFixture.modelId, elapsedMs: 5 };
      },
      async unload() {
        unloadCount += 1;
        modelLoaded = false;
        return { unloaded: true };
      },
    };

    const { app, actor, grant } = await startApp({
      options: {
        vad: makeSpeechVad(),
        localAsr,
        asrModels: {
          catalog: [goodFixture.catalogModel, badFixture.catalogModel],
          allowedHosts: ["127.0.0.1"],
          allowLoopbackHttp: true,
        },
      },
    });
    closeables.push(() => app.close());

    let seq = 0;
    const call = (commandId: string, input: Record<string, unknown> = {}) =>
      app.call(actor, { commandId, idempotencyKey: `mdl-${++seq}`, input }, grant.handle);

    // 1. Catalog list starts as not_installed
    const initial = await call("asrModel.list", {});
    expect(initial.status).toBe("ok");
    const listed = (initial.value as { models: Array<{ modelId: string; state: string }> }).models;
    expect(listed.map((m) => [m.modelId, m.state])).toEqual([
      [goodFixture.modelId, "not_installed"],
      [badFixture.modelId, "not_installed"],
    ]);

    // 2. Rejects download without `confirmed: true` with 0 network requests
    const unconfirmed = await call("asrModel.download", { modelId: goodFixture.modelId, confirmed: false });
    expect(unconfirmed.status).toBe("error");
    expect(unconfirmed.error?.code).toBe("VALIDATION_ERROR");
    expect(server.requests).toHaveLength(0);

    // 3. Start download -> pause mid-stream -> verify `.part` staging -> resume via HTTP 206 Range -> installed!
    let pausedTriggered = false;
    const offProgress = app.onNotice((notice) => {
      if (
        !pausedTriggered &&
        notice.topic === "asrModel.changed" &&
        notice.payload.modelId === goodFixture.modelId &&
        Number(notice.payload.downloadedBytes ?? 0) >= 8 * 1024
      ) {
        pausedTriggered = true;
        expect(app.busyReasons()).toContain("download");
        void call("asrModel.pause", { modelId: goodFixture.modelId });
      }
    });

    const firstAttempt = await call("asrModel.download", { modelId: goodFixture.modelId, confirmed: true });
    offProgress();
    expect(firstAttempt.status).toBe("ok");
    expect((firstAttempt.value as { state: string }).state).toBe("paused");

    const stagingDir = path.join(app.layout.appRoot, "models", ".staging");
    expect(fs.existsSync(stagingPartPath(stagingDir, goodFixture.modelId))).toBe(true);
    expect(fs.existsSync(stagingStatePath(stagingDir, goodFixture.modelId))).toBe(true);

    // Speed up remaining chunks for resume
    server.setRoute("/models/sense-voice.tar.bz2", {
      payload: goodFixture.archiveBuffer,
    });
    const resumed = await call("asrModel.download", { modelId: goodFixture.modelId, confirmed: true });
    expect(resumed.status).toBe("ok");
    expect((resumed.value as { state: string }).state).toBe("installed");
    expect(server.requests.some((req) => Boolean(req.range && req.range.startsWith("bytes=")))).toBe(true);
    expect(fs.existsSync(stagingPartPath(stagingDir, goodFixture.modelId))).toBe(false);

    // 4. Corrupted archive fails SHA-256 verification and cleans up staging files
    const corruptRes = await call("asrModel.download", { modelId: badFixture.modelId, confirmed: true });
    expect(corruptRes.status).toBe("error");
    expect(corruptRes.error?.code).toBe("VALIDATION_ERROR");
    expect(fs.existsSync(stagingPartPath(stagingDir, badFixture.modelId))).toBe(false);

    // 5. Simulate loaded model -> delete unloads active model first and frees disk bytes
    await localAsr.load(goodFixture.modelId, "senseVoice", app.asrModels.getRuntimeFiles(goodFixture.modelId).files);
    expect(modelLoaded).toBe(true);
    const deleted = await call("asrModel.delete", { modelId: goodFixture.modelId });
    expect(deleted.status).toBe("ok");
    expect(unloadCount).toBe(1);
    expect((deleted.value as { deleted: boolean; freedBytes: number }).deleted).toBe(true);
    expect((deleted.value as { freedBytes: number }).freedBytes).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(app.layout.appRoot, "models", "asr", goodFixture.modelId))).toBe(false);
  });

  it("AT-180 / AT-181: enforces Bangumi 60-request cap & infobox edge cases, syncs PhoneticCorrector incrementally, and enforces PolishService guardrails + OpenCC term protection", async () => {
    const bangumi = await new FakeBangumi().start();
    closeables.push(() => bangumi.stop());

    const coverBytes = await picture("blue");
    bangumi.images.set("/pic/cover.jpg", { bytes: coverBytes, mediaType: "image/png" });
    const imgSet = {
      large: `${bangumi.origin}/pic/cover.jpg`,
      common: `${bangumi.origin}/pic/cover.jpg`,
      medium: `${bangumi.origin}/pic/cover.jpg`,
      small: `${bangumi.origin}/pic/cover.jpg`,
      grid: `${bangumi.origin}/pic/cover.jpg`,
    };

    bangumi.subjects.set(9001, {
      id: 9001,
      type: 2,
      name: "星屑のシンフォニア",
      name_cn: "星屑交响曲",
      summary: "测试作品",
      date: "2026-04-01",
      platform: "TV",
      images: imgSet,
      infobox: [{ key: "别名", value: [{ v: "星尘交响诗" }] }],
      volumes: 0,
      eps: 12,
      total_episodes: 12,
      rating: { score: 8.4, total: 500, rank: 120 },
      tags: [{ name: "原创", count: 100 }],
    });

    // 45 characters + 30 voice actors = 75 detail targets (> 60 cap!)
    const chars = [];
    for (let i = 1; i <= 45; i += 1) {
      const charId = 10_000 + i;
      const actorId = i <= 30 ? 20_000 + i : undefined;
      chars.push({
        id: charId,
        name: i === 1 ? "天海凛音" : `角色${i}`,
        summary: "",
        type: 1,
        relation: i <= 5 ? "主角" : "配角",
        images: null,
        actors: actorId ? [{ id: actorId, name: i === 1 ? "水濑祈" : `声优${i}`, images: null }] : [],
      });

      if (i === 1) {
        // Duplicate `别名` keys + keyless `{ v }` array + `简体中文名`
        bangumi.characterDetails.set(charId, {
          id: charId,
          name: "天海凛音",
          type: 1,
          summary: "",
          locked: false,
          images: null,
          infobox: [
            { key: "简体中文名", value: "天海凛音" },
            { key: "别名", value: [{ k: "昵称", v: "凛酱" }, { v: "小凛音" }] },
            { key: "别名", value: "Rinne Amami" },
          ],
        });
      } else if (i === 2) {
        // infobox: null edge case
        bangumi.characterDetails.set(charId, {
          id: charId,
          name: "白石朔夜",
          type: 1,
          summary: "",
          locked: false,
          images: null,
          infobox: null,
        });
      } else {
        bangumi.characterDetails.set(charId, {
          id: charId,
          name: `角色${i}`,
          type: 1,
          summary: "",
          locked: false,
          images: null,
          infobox: [{ key: "简体中文名", value: `角色${i}` }],
        });
      }
    }
    for (let i = 1; i <= 30; i += 1) {
      const actorId = 20_000 + i;
      bangumi.personDetails.set(actorId, {
        id: actorId,
        name: i === 1 ? "水瀬いのり" : `声优${i}`,
        type: 1,
        career: ["seiyu"],
        summary: "",
        locked: false,
        images: null,
        infobox: i === 1 ? [{ key: "简体中文名", value: "水濑祈" }, { key: "别名", value: [{ v: "祈之助" }] }] : null,
      });
    }
    bangumi.characters.set(9001, chars);

    let asrOut = "天海林音今天唱了新歌";
    let llmResponseText = "天海凛音今天唱了新歌。";
    const provider = await startMockProvider({
      transcriptionText: () => asrOut,
      respond: () => ({ text: llmResponseText }),
    });
    closeables.push(() => provider.close());

    const { app, actor, grant } = await startApp({
      options: {
        vad: makeSpeechVad(),
        bangumi: bangumi.clientOptions,
      },
    });
    closeables.push(() => app.close());

    let seq = 0;
    const call = (commandId: string, input: Record<string, unknown> = {}) =>
      app.call(actor, { commandId, idempotencyKey: `bgm-${++seq}`, input }, grant.handle);

    const work = seedVideo(app, { title: "星屑交响曲" });
    const linked = await call("metadata.link", { workId: work.workId, providerId: "bangumi", externalId: "9001" });
    expect(linked.status).toBe("ok");

    // Manual term added BEFORE metadata enrichment takes priority (`manualWins >= 1`)
    const manualTerm = await call("dictionary.add", {
      scope: "work",
      workId: work.workId,
      term: "白石朔夜",
      heard: "白石塑夜",
      category: "character",
    });
    expect(manualTerm.status).toBe("ok");

    const progressEvents: number[] = [];
    const offProgress = app.onNotice((notice) => {
      if (notice.topic === "dictionary.importProgress" && notice.payload.workId === work.workId) {
        progressEvents.push(Number(notice.payload.completed));
      }
    });

    bangumi.requests.length = 0;
    const enriched = await call("dictionary.importMetadata", {
      workId: work.workId,
      enrichDetails: true,
    });
    offProgress();
    expect(enriched.status).toBe("ok");
    const enrichVal = enriched.value as {
      requestsSent: number;
      budgetReached: boolean;
      manualWins: number;
      totalTargets: number;
    };
    expect(enrichVal.totalTargets).toBe(75);
    expect(enrichVal.requestsSent).toBe(60);
    expect(enrichVal.budgetReached).toBe(true);
    expect(enrichVal.manualWins).toBeGreaterThanOrEqual(1);
    expect(bangumi.count((r) => r.path.startsWith("/v0/characters/") || r.path.startsWith("/v0/persons/"))).toBe(60);
    expect(progressEvents.length).toBeGreaterThan(0);

    // Setup connections for dictation + polish guardrails
    const asrKey = app.stashSecret("k-asr");
    const asrConn = await call("connections.upsert", {
      label: "ASR",
      protocol: "openai-chat-completions",
      baseUrl: provider.url,
      modelId: "whisper-1",
      purpose: "transcription",
      credentialHandle: asrKey,
    });
    const llmKey = app.stashSecret("k-llm");
    const llmConn = await call("connections.upsert", {
      label: "LLM",
      protocol: "openai-chat-completions",
      baseUrl: provider.url,
      modelId: "gpt-4o-mini",
      purpose: "text",
      credentialHandle: llmKey,
    });

    await call("settings.setRecording", {
      dictationEngine: { kind: "connection", connectionId: (asrConn.value as { id: string }).id },
      polishConnectionId: (llmConn.value as { id: string }).id,
      polishMode: "formal",
      chineseVariant: "traditional",
    });

    // 1. PhoneticCorrector corrects "天海林音" -> "天海凛音", OpenCC converts surrounding text to Traditional Chinese while protecting dictionary term span "天海凛音"!
    asrOut = "天海林音今天唱了这首新歌";
    llmResponseText = "天海凛音今天演唱了这首新歌。";
    const s1 = await call("dictation.start", { mode: "hold", workId: work.workId });
    const id1 = String((s1.value as { dictationId: string }).dictationId);
    await call("dictation.append", { dictationId: id1, seq: 0, data: makeSpeechPcmBase64(1000) });
    const r1 = await call("dictation.stop", { dictationId: id1 });
    expect(r1.status).toBe("ok");
    const out1 = r1.value as { correctedText: string; finalText: string };
    expect(out1.correctedText).toBe("天海凛音今天唱了这首新歌");
    // "这" -> "這" (Traditional), while simplified dictionary term "天海凛音" ("凛" not converted to "凜") stays protected!
    expect(out1.finalText).toContain("天海凛音");
    expect(out1.finalText).toContain("這首新歌");

    // 2. Guardrail fallback: LLM returns wildly over-long hallucinated expansion (> 1.3x length ratio) -> falls back to correctedText!
    await call("settings.setRecording", { chineseVariant: "simplified", polishMode: "formal" });
    asrOut = "白石塑夜真的非常冷静";
    llmResponseText = "白石朔夜真的非常冷静，而且在这一集里展现了极其惊人的剑术天赋与不为人知的往事背景设定。";
    const s2 = await call("dictation.start", { mode: "hold", workId: work.workId });
    const id2 = String((s2.value as { dictationId: string }).dictationId);
    await call("dictation.append", { dictationId: id2, seq: 0, data: makeSpeechPcmBase64(1000) });
    const r2 = await call("dictation.stop", { dictationId: id2 });
    expect(r2.status).toBe("ok");
    const out2 = r2.value as { correctedText: string; finalText: string; fallbackReason: string | null };
    expect(out2.correctedText).toBe("白石朔夜真的非常冷静");
    expect(out2.finalText).toBe("白石朔夜真的非常冷静");
    expect(out2.fallbackReason).toBeTruthy();

    // 3. Disabling the manual term immediately updates PhoneticCorrector so "白石塑夜" is no longer replaced
    const manualId = String((manualTerm.value as { id: string }).id);
    await call("dictionary.update", { termId: manualId, disabled: true });
    await call("settings.setRecording", { polishMode: "raw" });
    const s3 = await call("dictation.start", { mode: "hold", workId: work.workId });
    const id3 = String((s3.value as { dictationId: string }).dictationId);
    await call("dictation.append", { dictationId: id3, seq: 0, data: makeSpeechPcmBase64(1000) });
    const r3 = await call("dictation.stop", { dictationId: id3 });
    expect((r3.value as { finalText: string }).finalText).toBe("白石塑夜真的非常冷静");
  });

  it("Agent Isolation: denies Agent grants on all dictation/asrModel/dictionary commands and leaks zero dictation_history or suggestions in search & context", async () => {
    const provider = await startMockProvider({
      transcriptionText: () => "独有听写私密词组Alpha99",
    });
    closeables.push(() => provider.close());

    const { app, actor, grant } = await startApp({
      options: { vad: makeSpeechVad() },
    });
    closeables.push(() => app.close());

    let seq = 0;
    const ownerCall = (commandId: string, input: Record<string, unknown> = {}) =>
      app.call(actor, { commandId, idempotencyKey: `iso-own-${++seq}`, input }, grant.handle);

    const asrSecret = app.stashSecret("sk-iso");
    const asrConn = await ownerCall("connections.upsert", {
      label: "ASR",
      protocol: "openai-chat-completions",
      baseUrl: provider.url,
      modelId: "whisper-1",
      purpose: "transcription",
      credentialHandle: asrSecret,
    });
    await ownerCall("settings.setRecording", {
      dictationEngine: { kind: "connection", connectionId: (asrConn.value as { id: string }).id },
      polishMode: "raw",
    });

    // Seed dictation_history and dictionary_suggestions with distinctive secret tokens
    const dStart = await ownerCall("dictation.start", { mode: "hold" });
    const dId = String((dStart.value as { dictationId: string }).dictationId);
    await ownerCall("dictation.append", { dictationId: dId, seq: 0, data: makeSpeechPcmBase64(900) });
    const dStop = await ownerCall("dictation.stop", { dictationId: dId });
    expect((dStop.value as { finalText: string }).finalText).toBe("独有听写私密词组Alpha99");

    const obs = await ownerCall("dictionary.observeEdit", {
      insertedText: "看到了密语贝塔出场",
      editedText: "看到了秘语贝塔出场",
    });
    expect(obs.status).toBe("ok");

    const agentActor = { kind: "agent" as const, id: "agent-isolation-probe" };
    const agentGrant = app.issueAgentGrant(grant, agentActor, { readResourceIds: [] });

    const forbiddenProbes: Array<[string, Record<string, unknown>]> = [
      ["dictation.start", { mode: "hold" }],
      ["dictation.append", { dictationId: "dic_x", seq: 0, data: "AAAA" }],
      ["dictation.stop", { dictationId: "dic_x" }],
      ["dictation.cancel", {}],
      ["dictation.status", {}],
      ["dictation.history.list", {}],
      ["dictation.history.delete", { historyId: "h_x" }],
      ["dictation.history.clear", {}],
      ["dictation.history.retranscribe", { historyId: "h_x", engine: { kind: "local", modelId: "qwen3-asr-0.6B-int8" } }],
      ["asrModel.list", {}],
      ["asrModel.download", { modelId: "qwen3-asr-0.6B-int8", confirmed: true }],
      ["asrModel.pause", { modelId: "qwen3-asr-0.6B-int8" }],
      ["asrModel.cancel", { modelId: "qwen3-asr-0.6B-int8" }],
      ["asrModel.import", { modelId: "qwen3-asr-0.6B-int8", pathHandle: "ph_x", kind: "directory" }],
      ["asrModel.delete", { modelId: "qwen3-asr-0.6B-int8" }],
      ["dictionary.importBatch", { scope: "global", text: "测试词" }],
      ["dictionary.cancelImportMetadata", { workId: "w_x" }],
      ["dictionary.observeEdit", { insertedText: "甲乙", editedText: "甲丙" }],
      ["dictionary.suggestions.list", {}],
      ["dictionary.suggestions.decide", { suggestionId: "s_x", action: "accept" }],
    ];

    for (const [commandId, input] of forbiddenProbes) {
      const res = await app.call(agentActor, { commandId, idempotencyKey: `iso-ag-${++seq}`, input }, agentGrant.handle);
      expect(res.status, `${commandId} must reject agent actor`).toBe("error");
      expect(res.error?.code, `${commandId} must return FORBIDDEN`).toBe("FORBIDDEN");
    }

    // Agent library.find, owner workspace.find, and debug.context must return ZERO hits from dictation_history or dictionary_suggestions
    const agentSearch = await app.call(
      agentActor,
      { commandId: "library.find", idempotencyKey: `iso-find-${++seq}`, input: { text: "Alpha99" } },
      agentGrant.handle,
    );
    expect(agentSearch.status).toBe("ok");
    expect(agentSearch.value).toEqual([]);

    const wsFind = await ownerCall("workspace.find", { q: "Alpha99" });
    expect(wsFind.status).toBe("ok");
    expect((wsFind.value as { groups: unknown[] }).groups).toEqual([]);

    const sessionRes = await ownerCall("agent.createSession", { title: "隔离检查会话" });
    const sessionId = String((sessionRes.value as { id: string }).id);
    const dbg = await ownerCall("debug.context", { sessionId });
    expect(dbg.status).toBe("ok");
    const dbgJson = JSON.stringify(dbg.value);
    expect(dbgJson).not.toContain("Alpha99");
    expect(dbgJson).not.toContain("秘语贝塔");
    expect(dbgJson).not.toContain("dictation.");
    expect(dbgJson).not.toContain("asrModel.");
  });
});
