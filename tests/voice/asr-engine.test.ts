import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CHAT_AUDIO_SYSTEM_PROMPT,
  completeChatCompletions,
  completeResponses,
  completeText,
  startMockProvider,
  syntheticWav,
  transcribeChatAudio,
} from "@manga/model-protocol";
import {
  AsrEngine,
  CONTEXT_VOCAB_PREFIX,
  buildVocabularyHint,
  capabilitiesForExternalInterface,
  capabilitiesForLocalModel,
  cleanVocabularyTerms,
  isHintEcho,
  type ExternalAsrConnectionConfig,
  type LocalAsrRuntimePort,
} from "../../packages/app-core/src/voice/engine/index.ts";
import { AsrModelService } from "../../packages/app-core/src/voice/models/index.ts";
import { normalizePcm16kInput } from "../../packages/app-core/src/voice/silence-trimmer.ts";
import { createSyntheticModelFixture } from "../helpers/fake-model-server.ts";
import { testTempRoot } from "../helpers/global-temp.ts";

describe("unified AsrEngine, model-protocol chat audio, vocabulary hints, and echo filter", () => {
  const tempDirs: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  const makeTempDir = (prefix: string): string => {
    const dir = fs.mkdtempSync(path.join(testTempRoot(), prefix));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop()!;
      await close();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("forwards temperature on TextRequest (when reasoningEffort is unset) and supports transcribeChatAudio in mock-server", async () => {
    const seenBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    const mock = await startMockProvider({
      onRequest: (entry) => seenBodies.push(entry),
      audioTranscript: (capture) => `转写：${capture.model}:${capture.audioFormat}`,
    });
    closers.push(mock.close);

    // 1. Chat Completions & Responses forward `temperature: 0` when no `reasoningEffort` is set
    await completeChatCompletions(mock.url, "sk-test", {
      model: "polish-model",
      messages: [{ role: "user", content: "润色文本" }],
      temperature: 0,
    });
    expect(seenBodies[0]?.body.temperature).toBe(0);

    // 2. When `reasoningEffort` is set, `temperature` is omitted to satisfy reasoning-model API rules
    await completeChatCompletions(mock.url, "sk-test", {
      model: "reasoner-model",
      messages: [{ role: "user", content: "推理" }],
      temperature: 0.2,
      reasoningEffort: "low",
    });
    expect(seenBodies[1]?.body.temperature).toBeUndefined();
    expect(seenBodies[1]?.body.reasoning_effort).toBe("low");

    await completeResponses(mock.url, "sk-test", {
      model: "responses-polish",
      messages: [{ role: "user", content: "润色" }],
      temperature: 0.1,
    });
    expect(seenBodies[2]?.body.temperature).toBe(0.1);

    await completeText(
      "openai-chat-completions",
      mock.url,
      "sk-test",
      {
        model: "pi-polish",
        messages: [{ role: "user", content: "整理" }],
        temperature: 0,
      },
      "pi",
    );
    expect(seenBodies[3]?.body.temperature).toBe(0);

    // 3. `transcribeChatAudio` sends `temperature: 0`, system message, and `input_audio` base64 WAV
    const wavBytes = syntheticWav(300);
    const chatRes = await transcribeChatAudio(mock.url, "sk-test", {
      model: "qwen3-asr-flash",
      bytes: wavBytes,
      format: "wav",
      context: "星野澪、天野阳菜",
      language: "zh",
    });

    expect(chatRes.text).toBe("转写：qwen3-asr-flash:wav");
    expect(mock.audioCaptures).toHaveLength(1);
    const captured = mock.audioCaptures[0]!;
    expect(captured.temperature).toBe(0);
    expect(captured.audioFormat).toBe("wav");
    expect(Buffer.compare(captured.audioBytes, Buffer.from(wavBytes))).toBe(0);
    expect(captured.systemContext).toContain(DEFAULT_CHAT_AUDIO_SYSTEM_PROMPT);
    expect(captured.systemContext).toContain("可能出现的专有名词：星野澪、天野阳菜");
  });

  it("formats capability-specific hints across hotwords, promptChars, context, and zero-hint engines", () => {
    const rawTerms = [
      "::星野澪:2.5",
      "hoshino mio:1.2",
      "Hoshino Mio", // duplicate differing only by case
      "天野阳菜 : -0.5",
      "   ",
      "---",
      ...Array.from({ length: 60 }, (_, idx) => `术语条目_${idx + 1}`),
    ];

    const cleaned = cleanVocabularyTerms(rawTerms, 50);
    expect(cleaned).toHaveLength(50);
    expect(cleaned.slice(0, 3)).toEqual(["星野澪", "hoshino mio", "天野阳菜"]);

    // 1. `hotwords > 0` (`qwen3Asr` / `funasrNano`): comma-separated up to 50 terms, weights stripped
    const qwenCaps = capabilitiesForLocalModel("qwen3Asr", 50);
    const hotwordHint = buildVocabularyHint(qwenCaps, rawTerms);
    expect(hotwordHint.kind).toBe("hotwords");
    if (hotwordHint.kind === "hotwords") {
      expect(hotwordHint.includedTerms).toHaveLength(50);
      expect(hotwordHint.hotwordsCsv.startsWith("星野澪,hoshino mio,天野阳菜,")).toBe(true);
      expect(hotwordHint.hotwordsCsv).not.toContain(":2.5");
    }

    // 2. `promptChars > 0` (`audio_transcriptions`): character-limited comma-joined prompt
    const whisperCaps = capabilitiesForExternalInterface("audio_transcriptions", { promptChars: 16 });
    const promptHint = buildVocabularyHint(whisperCaps, ["星野澪", "天野阳菜", "宫水三叶", "立花泷"]);
    expect(promptHint.kind).toBe("prompt");
    if (promptHint.kind === "prompt") {
      expect([...promptHint.prompt].length).toBeLessThanOrEqual(16);
      expect(promptHint.prompt).toBe("星野澪, 天野阳菜, 宫水三叶");
    }

    // 3. `context === true` (`chat_input_audio`): system message with `"可能出现的专有名词：..."` up to 50 terms
    const chatCaps = capabilitiesForExternalInterface("chat_input_audio");
    const contextHint = buildVocabularyHint(chatCaps, rawTerms, { language: "zh" });
    expect(contextHint.kind).toBe("context");
    if (contextHint.kind === "context") {
      expect(contextHint.includedTerms).toHaveLength(50);
      expect(contextHint.systemPrompt).toContain(CONTEXT_VOCAB_PREFIX);
      expect(contextHint.systemPrompt).toContain("星野澪、hoshino mio、天野阳菜");
    }

    // 4. All 0/false (`senseVoice`): sends NO hint at all
    const senseCaps = capabilitiesForLocalModel("senseVoice", 0);
    const zeroHint = buildVocabularyHint(senseCaps, rawTerms);
    expect(zeroHint).toEqual({ kind: "none", includedTerms: [] });
  });

  it("enforces zero cross-engine fallback across unconfigured, uninstalled, load_failed, 401, timeout, and upload-limit errors", async () => {
    const workDir = makeTempDir("voice-engine-nofallback-");
    const qwenFixture = createSyntheticModelFixture(workDir, {
      modelId: "qwen3-asr-0.6B-int8",
      kind: "qwen3Asr",
    });

    const standbyMock = await startMockProvider({
      transcriptionText: "standby should never be called",
      audioTranscript: "standby chat should never be called",
    });
    const authFailMock = await startMockProvider({ mode: "unauthorized" });
    const timeoutMock = await startMockProvider({ mode: "timeout" });
    closers.push(standbyMock.close, authFailMock.close, timeoutMock.close);

    let localLoadCalls = 0;
    let localRecognizeCalls = 0;
    let modelStatusMode: "unloaded" | "loaded" | "load_failed" = "unloaded";

    const localRuntime: LocalAsrRuntimePort = {
      getModelStatus: (modelId) => ({
        modelId,
        status: modelStatusMode,
        crashCount: modelStatusMode === "load_failed" ? 2 : 0,
        ...(modelStatusMode === "load_failed" ? { reason: "模型连续崩溃两次，已停用自动重启" } : {}),
      }),
      load: async (modelId, kind) => {
        localLoadCalls += 1;
        return { loaded: true, modelId, kind, reused: false, elapsedMs: 5, rssBytes: 1024 };
      },
      recognize: async () => {
        localRecognizeCalls += 1;
        return {
          text: "本地结果",
          rawText: "本地结果",
          tokens: [],
          timestamps: [],
          lang: "zh",
          modelId: qwenFixture.modelId,
          elapsedMs: 10,
        };
      },
    };

    const modelService = new AsrModelService({
      appRoot: path.join(workDir, "app"),
      catalog: [qwenFixture.catalogModel],
    });

    const connections = new Map<string, ExternalAsrConnectionConfig>([
      [
        "conn-standby",
        {
          id: "conn-standby",
          baseUrl: standbyMock.url,
          apiKey: "sk-standby",
          model: "whisper-1",
          transcriptionInterface: "audio_transcriptions",
        },
      ],
      [
        "conn-401",
        {
          id: "conn-401",
          baseUrl: authFailMock.url,
          apiKey: "sk-bad",
          model: "whisper-1",
          transcriptionInterface: "audio_transcriptions",
        },
      ],
      [
        "conn-timeout",
        {
          id: "conn-timeout",
          baseUrl: timeoutMock.url,
          apiKey: "sk-slow",
          model: "qwen3-asr-flash",
          transcriptionInterface: "chat_input_audio",
          timeoutMs: 80,
        },
      ],
      [
        "conn-tiny-limit",
        {
          id: "conn-tiny-limit",
          baseUrl: standbyMock.url,
          apiKey: "sk-tiny",
          model: "whisper-1",
          transcriptionInterface: "audio_transcriptions",
          maxUploadBytes: 200,
        },
      ],
    ]);

    const engine = new AsrEngine({
      modelService,
      localRuntime,
      resolveConnection: (id) => connections.get(id) ?? null,
    });

    const sampleAudio = new Float32Array(16_000).fill(0.1); // 1 second

    // 1. Unconfigured selection -> error, 0 local calls, 0 external calls
    await expect(
      engine.transcribe({ selection: null, audio: sampleAudio }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { reason: "asr_unconfigured", setupHint: "settings.voice" },
    });
    expect(localLoadCalls).toBe(0);
    expect(standbyMock.requestCount()).toBe(0);

    // 2. Uninstalled local model -> error, 0 local load calls, 0 external calls
    await expect(
      engine.transcribe({
        selection: { kind: "local", modelId: qwenFixture.modelId },
        audio: sampleAudio,
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { engineKind: "local", setupHint: "settings.voice" },
    });
    expect(localLoadCalls).toBe(0);
    expect(standbyMock.requestCount()).toBe(0);

    // Install local model, then mark `load_failed` -> error, 0 local load calls, 0 external calls
    await modelService.importModel({
      modelId: qwenFixture.modelId,
      sourcePath: qwenFixture.extractedDir,
      kind: "directory",
    });
    modelStatusMode = "load_failed";
    await expect(
      engine.transcribe({
        selection: { kind: "local", modelId: qwenFixture.modelId },
        audio: sampleAudio,
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { reason: "model_load_failed", setupHint: "settings.voice" },
    });
    expect(localLoadCalls).toBe(0);
    expect(standbyMock.requestCount()).toBe(0);

    // Reset local status to healthy, now test external connection failures -> 0 calls to local model or standby!
    modelStatusMode = "unloaded";

    // 3. Missing external connection
    await expect(
      engine.transcribe({
        selection: { kind: "connection", connectionId: "conn-does-not-exist" },
        audio: sampleAudio,
      }),
    ).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
      details: { reason: "connection_unconfigured", setupHint: "settings.voice" },
    });

    // 4. External 401 auth failure
    await expect(
      engine.transcribe({
        selection: { kind: "connection", connectionId: "conn-401" },
        audio: sampleAudio,
      }),
    ).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      details: { connectionId: "conn-401", setupHint: "settings.connections" },
    });

    // 5. External timeout
    await expect(
      engine.transcribe({
        selection: { kind: "connection", connectionId: "conn-timeout" },
        audio: sampleAudio,
      }),
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      details: { kind: "timeout", connectionId: "conn-timeout", setupHint: "settings.connections" },
    });

    // 6. External upload-limit exceeded before network call
    await expect(
      engine.transcribe({
        selection: { kind: "connection", connectionId: "conn-tiny-limit" },
        audio: sampleAudio,
        chunkLongAudio: false,
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      details: { reason: "upload_limit_exceeded", connectionId: "conn-tiny-limit" },
    });

    // Standby connection and healthy local model received ZERO fallback requests!
    expect(standbyMock.requestCount()).toBe(0);
    expect(localLoadCalls).toBe(0);
    expect(localRecognizeCalls).toBe(0);
  });

  it("runs optional GTCRN pre-ASR denoise for both local and external engines, and chunks 3-minute audio into <= 30s blocks", async () => {
    const workDir = makeTempDir("voice-engine-chunks-");
    const senseFixture = createSyntheticModelFixture(workDir, {
      modelId: "sense-voice-funasr-nano-int8",
      kind: "senseVoice",
    });
    const qwenFixture = createSyntheticModelFixture(workDir, {
      modelId: "qwen3-asr-0.6B-int8",
      kind: "qwen3Asr",
    });

    const modelService = new AsrModelService({
      appRoot: path.join(workDir, "app"),
      catalog: [senseFixture.catalogModel, qwenFixture.catalogModel],
    });
    await modelService.importModel({
      modelId: senseFixture.modelId,
      sourcePath: senseFixture.extractedDir,
      kind: "directory",
    });
    await modelService.importModel({
      modelId: qwenFixture.modelId,
      sourcePath: qwenFixture.extractedDir,
      kind: "directory",
    });

    const seenLocalCalls: Array<{ sampleCount: number; hotwords?: readonly string[] | string; firstSample: number }> = [];
    let denoiseCalls = 0;

    const localRuntime: LocalAsrRuntimePort = {
      getModelStatus: (modelId) => ({ modelId, status: "loaded", crashCount: 0 }),
      load: async (modelId, kind) => ({
        loaded: true,
        modelId,
        kind,
        reused: true,
        elapsedMs: 1,
        rssBytes: 1024,
      }),
      denoise: async (samples) => {
        denoiseCalls += 1;
        // Scale to 0.5 to make denoised output unmistakably observable downstream
        const out = new Float32Array(samples.length).fill(0.5);
        return { samples: out, sampleRate: 16_000, elapsedMs: 3 };
      },
      recognize: async (samples, options) => {
        seenLocalCalls.push({
          sampleCount: samples.length,
          hotwords: options?.hotwords,
          firstSample: samples[0] ?? 0,
        });
        return {
          text: `块${seenLocalCalls.length}`,
          rawText: `块${seenLocalCalls.length}`,
          tokens: [],
          timestamps: [],
          lang: "zh",
          modelId: qwenFixture.modelId,
          elapsedMs: 4,
        };
      },
    };

    const chatMock = await startMockProvider({
      audioTranscript: "外部降噪转写成功",
    });
    closers.push(chatMock.close);

    const engine = new AsrEngine({
      modelService,
      localRuntime,
      resolveConnection: (id) =>
        id === "conn-chat"
          ? {
              id: "conn-chat",
              baseUrl: chatMock.url,
              apiKey: "sk-chat",
              model: "qwen3-asr-flash",
              transcriptionInterface: "chat_input_audio",
            }
          : null,
    });

    // 1. SenseVoice (`hotwords: 0`) sends NO hotwords even when vocabularyTerms are supplied
    await engine.transcribe({
      selection: { kind: "local", modelId: senseFixture.modelId },
      audio: new Float32Array(16_000).fill(0.2),
      vocabularyTerms: ["星野澪", "天野阳菜"],
    });
    expect(seenLocalCalls[0]?.hotwords).toBeUndefined();

    // 2. External `chat_input_audio` with `gtcrnDenoise: true` receives GTCRN-denoised WAV samples
    const extRes = await engine.transcribe({
      selection: { kind: "connection", connectionId: "conn-chat" },
      audio: new Float32Array(8_000).fill(0.1),
      vocabularyTerms: ["星野澪:2.0", "天野阳菜"],
      gtcrnDenoise: true,
    });
    expect(extRes.text).toBe("外部降噪转写成功");
    expect(denoiseCalls).toBe(1);
    expect(chatMock.audioCaptures).toHaveLength(1);
    const decodedFromWav = normalizePcm16kInput(chatMock.audioCaptures[0]!.audioBytes);
    expect(decodedFromWav.samples[0]).toBeCloseTo(0.5, 2);

    // 3. 3-minute (`180s` = 2,880,000 samples) audio on local Qwen3-ASR splits into <= 30s (<= 480,000 samples) blocks
    seenLocalCalls.length = 0;
    const threeMinutes = new Float32Array(180 * 16_000).fill(0.15);
    const longRes = await engine.transcribe({
      selection: { kind: "local", modelId: qwenFixture.modelId },
      audio: threeMinutes,
      vocabularyTerms: ["星野澪:3.0", "天野阳菜"],
      gtcrnDenoise: true,
    });

    expect(denoiseCalls).toBe(2);
    expect(longRes.chunkCount).toBeGreaterThanOrEqual(6);
    expect(seenLocalCalls.length).toBe(longRes.chunkCount);
    for (const call of seenLocalCalls) {
      expect(call.sampleCount).toBeLessThanOrEqual(30 * 16_000);
      expect(call.hotwords).toBe("星野澪,天野阳菜");
      expect(call.firstSample).toBeCloseTo(0.5, 4);
    }
    expect(longRes.text).toContain("块1块2");

    // 4. `createAsrPort` resolves local model with 30-second WAV maxUploadBytes for CaptureService
    const port = engine.createAsrPort({
      getDefaultSelection: () => ({ kind: "local", modelId: qwenFixture.modelId }),
    });
    const resolvedConn = port.resolve();
    expect(resolvedConn).toEqual({
      id: `local:${qwenFixture.modelId}`,
      model: qwenFixture.modelId,
      timeoutMs: 120_000,
      maxUploadBytes: 30 * 16_000 * 2 + 44,
    });
  });

  it("detects hotword/prompt/context echoes in isHintEcho while preserving real single-term dictation, and retries once without hints", async () => {
    const hints = ["星野澪", "天野阳菜", "宫水三叶", "立花泷"];

    // Echo patterns -> true
    expect(isHintEcho("星野澪, 天野阳菜, 宫水三叶", hints)).toBe(true);
    expect(isHintEcho("星野澪，星野澪，星野澪", hints)).toBe(true);
    expect(isHintEcho("立花泷、宫水三叶、星野澪、天野阳菜", hints)).toBe(true);
    expect(isHintEcho("可能出现的专有名词：星野澪、天野阳菜", hints)).toBe(true);
    expect(isHintEcho("星野澪, 天野阳菜,", hints)).toBe(true);

    // Legitimate speech -> false
    expect(isHintEcho("星野澪", hints)).toBe(false);
    expect(isHintEcho("星野澪和天野阳菜", hints)).toBe(false);
    expect(isHintEcho("这部作品里有星野澪、天野阳菜和宫水三叶三个角色", hints)).toBe(false);

    // End-to-end echo retry on external `audio_transcriptions`
    const multipartRequests: string[] = [];
    const echoMock = await startMockProvider({
      transcriptionText: ({ rawBody }) => {
        const textBody = rawBody.toString("utf8");
        multipartRequests.push(textBody);
        if (textBody.includes('name="prompt"')) {
          return "星野澪, 天野阳菜, 宫水三叶";
        }
        return "真正说出的句子";
      },
    });
    closers.push(echoMock.close);

    const engine = new AsrEngine({
      resolveConnection: () => ({
        id: "conn-whisper",
        baseUrl: echoMock.url,
        apiKey: "sk-whisper",
        model: "whisper-large-v3",
        transcriptionInterface: "audio_transcriptions",
      }),
    });

    const recovered = await engine.transcribe({
      selection: { kind: "connection", connectionId: "conn-whisper" },
      audio: syntheticWav(500),
      vocabularyTerms: hints,
    });

    expect(multipartRequests).toHaveLength(2);
    expect(multipartRequests[0]).toContain('name="prompt"');
    expect(multipartRequests[1]).not.toContain('name="prompt"');
    expect(recovered.text).toBe("真正说出的句子");
    expect(recovered.echoDetected).toBe(false);

    // `chat_input_audio` preserves `language` in system message both when `vocabularyTerms` is empty and on echo retry
    const chatEchoMock = await startMockProvider({
      audioTranscript: (capture) => {
        if (capture.systemContext?.includes(CONTEXT_VOCAB_PREFIX)) {
          return "可能出现的专有名词：星野澪、天野阳菜";
        }
        return "无词汇提示重试成功";
      },
    });
    closers.push(chatEchoMock.close);

    const chatEngine = new AsrEngine({
      resolveConnection: () => ({
        id: "conn-chat-lang",
        baseUrl: chatEchoMock.url,
        apiKey: "sk-chat",
        model: "qwen3-asr-flash",
        transcriptionInterface: "chat_input_audio",
      }),
    });

    await chatEngine.transcribe({
      selection: { kind: "connection", connectionId: "conn-chat-lang" },
      audio: syntheticWav(400),
      vocabularyTerms: [],
      language: "zh",
    });
    expect(chatEchoMock.audioCaptures).toHaveLength(1);
    expect(chatEchoMock.audioCaptures[0]?.systemContext).toContain(DEFAULT_CHAT_AUDIO_SYSTEM_PROMPT);
    expect(chatEchoMock.audioCaptures[0]?.systemContext).toContain("主要语言：zh。");
    expect(chatEchoMock.audioCaptures[0]?.systemContext).not.toContain(CONTEXT_VOCAB_PREFIX);

    const chatRecovered = await chatEngine.transcribe({
      selection: { kind: "connection", connectionId: "conn-chat-lang" },
      audio: syntheticWav(400),
      vocabularyTerms: hints,
      language: "ja",
    });
    expect(chatRecovered.text).toBe("无词汇提示重试成功");
    expect(chatRecovered.echoDetected).toBe(false);
    expect(chatEchoMock.audioCaptures).toHaveLength(3);
    expect(chatEchoMock.audioCaptures[1]?.systemContext).toContain("主要语言：ja。");
    expect(chatEchoMock.audioCaptures[1]?.systemContext).toContain(CONTEXT_VOCAB_PREFIX);
    expect(chatEchoMock.audioCaptures[2]?.systemContext).toContain(DEFAULT_CHAT_AUDIO_SYSTEM_PROMPT);
    expect(chatEchoMock.audioCaptures[2]?.systemContext).toContain("主要语言：ja。");
    expect(chatEchoMock.audioCaptures[2]?.systemContext).not.toContain(CONTEXT_VOCAB_PREFIX);
  });
});
