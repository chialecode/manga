import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { MangaError, type DictationSessionSnapshot } from "@manga/contracts";
import { DrizzleStore } from "@manga/storage-drizzle";
import { exportLibraryPackageCancellable } from "../../packages/app-core/src/domain/library-package.ts";
import { DictionaryService } from "../../packages/app-core/src/voice/dictionary.ts";
import {
  DICTATION_AUDIO_RETENTION_MS,
  DICTATION_HISTORY_RETENTION_MS,
  DictationHistoryService,
  DictationService,
  LEARN_EDIT_WINDOW_MS,
  LEARN_PHONETIC_THRESHOLD,
  LearnFromEditsService,
  type DictationAsrEnginePort,
  type DictationRuntimeSettings,
  type DictationTrimmerPort,
} from "../../packages/app-core/src/voice/dictation/index.ts";
import { testTempRoot } from "../helpers/global-temp.ts";

function makeSpeechPcmBase64(durationMs = 400): string {
  const samples = Math.floor((durationMs * 16_000) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const val = Math.round(Math.sin((2 * Math.PI * 440 * i) / 16_000) * 12_000);
    buf.writeInt16LE(val, i * 2);
  }
  return buf.toString("base64");
}

describe("Dictation session state machine, 30d history / 24h audio, and learn-from-edits (H1 + U1)", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) {
      const fn = cleanups.pop()!;
      try {
        fn();
      } catch {
        /* ignore cleanup errors */
      }
    }
  });

  function createIsolatedHarness(over?: {
    maxDurationMs?: number;
    initialNowMs?: number;
  }) {
    const root = fs.mkdtempSync(path.join(testTempRoot(), "dictation-unit-"));
    let clockMs = over?.initialNowMs ?? Date.parse("2026-11-12T12:00:00.000Z");
    const store = new DrizzleStore({ profileDir: path.join(root, "data") });
    const dictionary = new DictionaryService(store);
    const history = new DictationHistoryService({
      store,
      appRoot: root,
      now: () => new Date(clockMs),
      startPruneTimer: false,
    });
    const learn = new LearnFromEditsService({ store, dictionary });
    const notifications: Array<{ topic: string; payload: DictationSessionSnapshot }> = [];

    let runtimeSettings: Partial<DictationRuntimeSettings> = {
      dictationEngine: { kind: "local", modelId: "sense-voice-funasr-nano-int8" },
      polishMode: "light",
      chineseVariant: "simplified",
      retainAudio24h: true,
    };

    let trimmerImpl: DictationTrimmerPort["trim"] = async (pcmBuffer) => ({
      status: "speech",
      pcmBuffer,
      warnings: [],
    });

    let asrImpl: DictationAsrEnginePort["transcribe"] = async () => ({
      text: "呃我觉得陈代遥香这一话很精彩",
      engineKind: "local",
      engineId: "local:sense-voice",
      modelId: "sense-voice-funasr-nano-int8",
      recognizeMs: 25,
    });

    let llmText = "我觉得神代遥香这一话很精彩。";
    const llmCalls: Array<{ system: string; user: string }> = [];

    const service = new DictationService({
      trimmer: { trim: (pcm, opts) => trimmerImpl(pcm, opts) },
      asrEngine: { transcribe: (req) => asrImpl(req) },
      corrector: dictionary,
      llm: {
        resolve: () => ({ id: "conn-polish", model: "synth-llm", timeoutMs: 3000 }),
        complete: async (_conn, req) => {
          llmCalls.push({ system: req.system, user: req.user });
          return { text: llmText };
        },
      },
      history,
      notify: (topic, payload) => {
        notifications.push({ topic, payload: payload as unknown as DictationSessionSnapshot });
      },
      readSettings: () => runtimeSettings,
      maxDurationMs: over?.maxDurationMs,
      now: () => clockMs,
    });

    cleanups.push(() => {
      service.close();
      store.close();
      fs.rmSync(root, { recursive: true, force: true });
    });

    return {
      root,
      store,
      dictionary,
      history,
      learn,
      service,
      notifications,
      llmCalls,
      advanceClock: (ms: number) => {
        clockMs += ms;
      },
      setSettings: (patch: Partial<DictationRuntimeSettings>) => {
        runtimeSettings = { ...runtimeSettings, ...patch };
      },
      setTrimmer: (fn: DictationTrimmerPort["trim"]) => {
        trimmerImpl = fn;
      },
      setAsr: (fn: DictationAsrEnginePort["transcribe"]) => {
        asrImpl = fn;
      },
      setLlmText: (text: string) => {
        llmText = text;
      },
    };
  }

  it("transitions recording -> trimming -> recognizing -> correcting -> polishing -> done without touching capture_sessions", async () => {
    const h = createIsolatedHarness();
    // Seed a work and a manual character term so deterministic phonetic replacement activates.
    const nowIso = new Date().toISOString();
    h.store.sqlite
      .prepare("INSERT INTO works (id, title, media_kind, created_at, updated_at) VALUES (?, ?, 'comic', ?, ?)")
      .run("wrk_1", "星海旅人", nowIso, nowIso);
    h.dictionary.add({ scope: "work", workId: "wrk_1", term: "神代遥香", category: "character" });

    const started = h.service.start({ mode: "hold", workId: "wrk_1" });
    expect(started.stage).toBe("recording");

    const appended = h.service.append({
      dictationId: started.dictationId,
      seq: 0,
      data: makeSpeechPcmBase64(500),
    });
    expect(appended.durationMs).toBe(500);

    const finished = await h.service.stop({ dictationId: started.dictationId, reason: "user" });
    expect(finished.stage).toBe("done");
    expect(finished.rawText).toBe("呃我觉得陈代遥香这一话很精彩");
    expect(finished.correctedText).toBe("呃我觉得神代遥香这一话很精彩");
    expect(finished.finalText).toBe("我觉得神代遥香这一话很精彩。");
    expect(finished.replacements).toHaveLength(1);
    expect(finished.replacements[0]).toMatchObject({
      original: "陈代遥香",
      replacement: "神代遥香",
      term: "神代遥香",
    });
    expect(finished.historyId).toBeTruthy();

    // Emitted every pipeline stage in strict order, and published `rawText` already at `correcting`!
    const stages = h.notifications.map((n) => n.payload.stage);
    expect(stages).toEqual(["recording", "trimming", "recognizing", "correcting", "polishing", "done"]);
    const correctingSnap = h.notifications.find((n) => n.payload.stage === "correcting")!.payload;
    expect(correctingSnap.rawText).toBe("呃我觉得陈代遥香这一话很精彩");

    // Zero rows written to `capture_sessions`!
    const captureCount = h.store.sqlite.prepare("SELECT COUNT(*) AS n FROM capture_sessions").get() as { n: number };
    expect(captureCount.n).toBe(0);
  });

  it("handles no_speech, hotword prompt echo, 5-min max duration auto-stop, cancel, failure, and module-disable generation guard", async () => {
    const h = createIsolatedHarness({ maxDurationMs: 600 });
    h.dictionary.add({ scope: "global", term: "苍穹骑士团" });
    h.dictionary.add({ scope: "global", term: "星野美咲" });
    h.dictionary.add({ scope: "global", term: "雾岛葵" });

    // 1. Silent audio -> `no_speech`, ASR is never called.
    let asrCalled = 0;
    h.setTrimmer(async () => ({ status: "no_speech", pcmBuffer: Buffer.alloc(0), warnings: [] }));
    h.setAsr(async () => {
      asrCalled += 1;
      return { text: "不会到这里", engineKind: "local", engineId: "e", modelId: "sense" };
    });
    const s1 = h.service.start({ mode: "hold" });
    h.service.append({ dictationId: s1.dictationId, seq: 0, data: makeSpeechPcmBase64(200) });
    const r1 = await h.service.stop({ dictationId: s1.dictationId });
    expect(r1.stage).toBe("no_speech");
    expect(r1.errorMessage).toContain("没有听到声音");
    expect(asrCalled).toBe(0);

    // 2. Prompt/hotword echo -> `no_speech` ("没有听清，请再说一次"), not inserted or saved to history.
    h.setTrimmer(async (pcm) => ({ status: "speech", pcmBuffer: pcm, warnings: ["low_volume"] }));
    h.setAsr(async () => ({
      text: "苍穹骑士团, 星野美咲, 雾岛葵",
      engineKind: "local",
      engineId: "local:qwen",
      modelId: "qwen3-asr-0.6B-int8",
    }));
    const s2 = h.service.start({ mode: "hold" });
    h.service.append({ dictationId: s2.dictationId, seq: 0, data: makeSpeechPcmBase64(200) });
    const r2 = await h.service.stop({ dictationId: s2.dictationId });
    expect(r2.stage).toBe("no_speech");
    expect(r2.errorMessage).toContain("没有听清");
    expect(h.history.list().items).toHaveLength(0);

    // 3. Max duration auto-stop when appended audio reaches `maxDurationMs` (600 ms in this harness).
    h.setSettings({ polishMode: "raw", retainAudio24h: false });
    h.setAsr(async () => ({
      text: "自动结束时的有效说话内容",
      engineKind: "local",
      engineId: "local:sense",
      modelId: "sense-voice-funasr-nano-int8",
    }));
    const s3 = h.service.start({ mode: "locked" });
    const app3 = h.service.append({ dictationId: s3.dictationId, seq: 0, data: makeSpeechPcmBase64(650) });
    expect(app3.autoStopped).toBe(true);
    const r3 = await h.service.stop({ dictationId: s3.dictationId });
    expect(r3.stage).toBe("done");
    expect(r3.finalText).toBe("自动结束时的有效说话内容");
    expect(r3.errorMessage).toContain("5 分钟");

    // 4. Mid-flight `cancel()` aborts ASR and transitions to `cancelled`.
    let releaseAsr!: () => void;
    h.setAsr(
      ({ signal }) =>
        new Promise((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new MangaError("CANCELLED", "已取消")), { once: true });
          releaseAsr = () =>
            resolve({ text: "迟到结果", engineKind: "local", engineId: "local:sense", modelId: "sense" });
        }),
    );
    const s4 = h.service.start({ mode: "hold" });
    h.service.append({ dictationId: s4.dictationId, seq: 0, data: makeSpeechPcmBase64(200) });
    const stop4 = h.service.stop({ dictationId: s4.dictationId });
    await new Promise((r) => setTimeout(r, 10));
    const cancelledSnap = h.service.cancel(s4.dictationId) as DictationSessionSnapshot;
    expect(cancelledSnap.stage).toBe("cancelled");
    releaseAsr?.();
    expect((await stop4).stage).toBe("cancelled");

    // 5. Engine failure surfaces `stage: "failed"` with `errorCode` and Chinese `errorMessage`.
    h.setAsr(async () => {
      throw new MangaError("AUTHENTICATION_FAILED", "语音转录连接密钥无效，请前往设置检查");
    });
    const s5 = h.service.start({ mode: "hold" });
    h.service.append({ dictationId: s5.dictationId, seq: 0, data: makeSpeechPcmBase64(200) });
    const r5 = await h.service.stop({ dictationId: s5.dictationId });
    expect(r5.stage).toBe("failed");
    expect(r5.errorCode).toBe("AUTHENTICATION_FAILED");
    expect(r5.errorMessage).toContain("密钥无效");

    // 6. Module disable (`bind()` + `deactivate()`) drops late in-flight results and rejects new starts.
    let moduleEnabled = true;
    h.service.bind(() => moduleEnabled);
    let resolveLateAsr!: (v: { text: string; engineKind: string; engineId: string; modelId: string }) => void;
    h.setAsr(
      () =>
        new Promise((resolve) => {
          resolveLateAsr = resolve;
        }),
    );
    const s6 = h.service.start({ mode: "hold" });
    h.service.append({ dictationId: s6.dictationId, seq: 0, data: makeSpeechPcmBase64(200) });
    const stop6 = h.service.stop({ dictationId: s6.dictationId });
    await new Promise((r) => setTimeout(r, 10));

    const historyBeforeDisable = h.history.list().items.length;
    moduleEnabled = false;
    h.service.deactivate();
    const notifCountAfterDisable = h.notifications.length;

    resolveLateAsr({
      text: "停用模块后迟到的转写文字",
      engineKind: "local",
      engineId: "local:sense",
      modelId: "sense",
    });
    await stop6;

    expect(h.notifications.length).toBe(notifCountAfterDisable);
    expect(h.history.list().items.length).toBe(historyBeforeDisable);
    expect(() => h.service.start({ mode: "hold" })).toThrowError(MangaError);
  });

  it("prunes >30d history, expires >24h WAV files, supports retranscribe with another engine, and excludes history from backups & packages", async () => {
    const h = createIsolatedHarness();
    h.setSettings({ polishMode: "raw", retainAudio24h: true });

    // Record an entry at t0 with retained WAV audio.
    h.setAsr(async () => ({
      text: "第一版引擎识别的句子",
      engineKind: "local",
      engineId: "local:sense",
      modelId: "sense-voice-funasr-nano-int8",
    }));
    const s1 = h.service.start({ mode: "hold" });
    h.service.append({ dictationId: s1.dictationId, seq: 0, data: makeSpeechPcmBase64(300) });
    const done1 = await h.service.stop({ dictationId: s1.dictationId });
    const histId = done1.historyId!;
    expect(h.history.get(histId).audioAvailable).toBe(true);
    expect(fs.existsSync(path.join(h.history.audioDir, `${histId}.wav`))).toBe(true);

    // Retranscribe within 24h using a second engine (`qwen3-asr-0.6B-int8`).
    h.dictionary.add({ scope: "global", term: "星海回响" });
    h.setAsr(async (req) => {
      expect(req.selection).toEqual({ kind: "local", modelId: "qwen3-asr-0.6B-int8" });
      return {
        text: "第二版引擎识别了星海回想",
        engineKind: "local",
        engineId: "local:qwen3",
        modelId: "qwen3-asr-0.6B-int8",
      };
    });
    const retranscribed = await h.service.retranscribeHistory(histId, {
      kind: "local",
      modelId: "qwen3-asr-0.6B-int8",
    });
    expect(retranscribed.modelId).toBe("qwen3-asr-0.6B-int8");
    expect(retranscribed.rawText).toBe("第二版引擎识别了星海回想");
    expect(retranscribed.finalText).toBe("第二版引擎识别了星海回响");

    // Verify `store.copyForBackup` strips `dictation_history` completely!
    const backupFile = path.join(h.root, "test-backup.sqlite");
    h.store.copyForBackup(backupFile);
    const backupDb = new Database(backupFile, { readonly: true });
    try {
      const countInBackup = backupDb.prepare("SELECT COUNT(*) AS n FROM dictation_history").get() as { n: number };
      expect(countInBackup.n).toBe(0);
    } finally {
      backupDb.close();
    }

    // Advance 25 hours (> 24h audio TTL, < 30d history TTL): WAV file is deleted, text record stays!
    h.advanceClock(DICTATION_AUDIO_RETENTION_MS + 60 * 60 * 1000);
    const after25h = h.history.list().items;
    expect(after25h).toHaveLength(1);
    expect(after25h[0]!.audioAvailable).toBe(false);
    expect(fs.existsSync(path.join(h.history.audioDir, `${histId}.wav`))).toBe(false);
    await expect(
      h.service.retranscribeHistory(histId, { kind: "local", modelId: "sense-voice-funasr-nano-int8" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Advance past 30 days: text history record is pruned too!
    h.advanceClock(DICTATION_HISTORY_RETENTION_MS);
    expect(h.history.list().items).toHaveLength(0);

    // Also verify `exportLibraryPackageCancellable` excludes `dictation_history` and `dictation-audio`!
    h.history.record({
      engineKind: "local",
      engineId: "local:sense",
      modelId: "sense-voice-funasr-nano-int8",
      polishMode: "raw",
      rawText: "私密听写原文不可进包",
      correctedText: "私密听写原文不可进包",
      finalText: "私密听写原文不可进包",
      pcm16le: Buffer.from(makeSpeechPcmBase64(200), "base64"),
      retainAudio24h: true,
    });
    const outPackageDir = path.join(h.root, "exported-library-pkg");
    const manifest = await exportLibraryPackageCancellable(h.store, outPackageDir);
    expect(manifest).not.toHaveProperty("dictationHistory");
    const manifestJson = fs.readFileSync(path.join(outPackageDir, "manifest.json"), "utf8");
    expect(manifestJson).not.toContain("私密听写原文不可进包");
    expect(manifestJson).not.toContain("dictation-audio");
    const exportedAttachments = fs.readdirSync(path.join(outPackageDir, "attachments"));
    expect(exportedAttachments.some((name) => name.endsWith(".wav"))).toBe(false);
  });

  it("learns 2..16 char phonetic edits (>= 0.6), handles existing terms on accept, and suppresses ignored pairs", () => {
    const h = createIsolatedHarness();
    expect(LEARN_PHONETIC_THRESHOLD).toBe(0.6);

    const nowIso = new Date().toISOString();
    h.store.sqlite
      .prepare("INSERT INTO works (id, title, media_kind, created_at, updated_at) VALUES (?, ?, 'comic', ?, ?)")
      .run("wrk_learn", "苍蓝幻想曲", nowIso, nowIso);

    // 1. Rejects untrackable ranges, >60s edits, whole-sentence rewrites, and low-phonetic-similarity edits.
    expect(
      h.learn.observeEdit({
        workId: "wrk_learn",
        insertedText: "我今天看了新代遥香的漫画",
        editedText: "我今天看了神代遥香的漫画",
        untrackable: true,
      }).suggestion,
    ).toBeNull();

    expect(
      h.learn.observeEdit({
        workId: "wrk_learn",
        insertedText: "我今天看了新代遥香的漫画",
        editedText: "我今天看了神代遥香的漫画",
        elapsedMs: LEARN_EDIT_WINDOW_MS + 1,
      }).suggestion,
    ).toBeNull();

    expect(
      h.learn.observeEdit({
        workId: "wrk_learn",
        insertedText: "今天天气真不错我们出去散步吧",
        editedText: "这部作品的分镜节奏把控非常出色",
      }).suggestion,
    ).toBeNull();

    expect(
      h.learn.observeEdit({
        workId: "wrk_learn",
        insertedText: "我觉得这一幕非常普通",
        editedText: "我觉得这一幕非常震撼",
      }).reason,
    ).toBe("low_phonetic_similarity");

    // 2. Proposes a suggestion when a 2..16 char name is phonetically corrected (including 1-char edit inside a 4-char CJK name!).
    const proposed = h.learn.observeEdit({
      workId: "wrk_learn",
      insertedText: "我今天看了新代遥香的漫画。",
      editedText: "我今天看了神代遥香的漫画。",
      elapsedMs: 4_000,
    });
    expect(proposed.suggestion).toMatchObject({
      scope: "work",
      workId: "wrk_learn",
      term: "神代遥香",
      heard: "新代遥香",
      status: "pending",
    });
    expect(proposed.suggestion!.score).toBeGreaterThanOrEqual(0.6);
    expect(proposed.promptText).toBe("把「神代遥香」加入词典？（识别成了「新代遥香」）");

    // Confirming (`accept`) when `term` is new creates a manual work term with `heard` alias!
    const acceptedNew = h.learn.decide({ suggestionId: proposed.suggestion!.id, action: "accept" });
    expect(acceptedNew.suggestion.status).toBe("accepted");
    expect(acceptedNew.term).toMatchObject({
      scope: "work",
      workId: "wrk_learn",
      term: "神代遥香",
      source: "manual",
    });
    expect(acceptedNew.term!.aliases.some((a) => a.alias === "新代遥香" && a.kind === "heard")).toBe(true);

    // Since "神代遥香" is now in the dictionary, editing another sentence to "神代遥香" does not nag again.
    expect(
      h.learn.observeEdit({
        workId: "wrk_learn",
        insertedText: "我看见了申代遥香的背影",
        editedText: "我看见了神代遥香的背影",
      }).reason,
    ).toBe("already_in_dictionary");

    // 3. Edge case (§4.10 / §5.3): `term` becomes an existing term BEFORE the pending suggestion is accepted -> `accept` appends `heard` alias to the existing term!
    const pending2 = h.learn.observeEdit({
      workId: null, // global scope when no work is focused
      insertedText: "配角克雷雅拿起了长剑",
      editedText: "配角克蕾雅拿起了长剑",
    });
    expect(pending2.suggestion).toMatchObject({
      scope: "global",
      workId: null,
      term: "克蕾雅",
      heard: "克雷雅",
    });
    // User imports/adds "克蕾雅" with a romaji alias before clicking accept on the suggestion:
    const preExisting = h.dictionary.add({
      scope: "global",
      term: "克蕾雅",
      aliases: [{ alias: "Clare", kind: "english" }],
    });
    const acceptedExisting = h.learn.decide({ suggestionId: pending2.suggestion!.id, action: "accept" });
    expect(acceptedExisting.term!.id).toBe(preExisting.id);
    expect(acceptedExisting.term!.aliases.map((a) => ({ alias: a.alias, kind: a.kind }))).toEqual([
      { alias: "Clare", kind: "english" },
      { alias: "克雷雅", kind: "heard" },
    ]);

    // 4. `ignore` permanently suppresses the exact same `(scope, workId, term, heard)` pair thereafter!
    const pending3 = h.learn.observeEdit({
      workId: "wrk_learn",
      insertedText: "背景里的雾原连转身离开",
      editedText: "背景里的雾原莲转身离开",
    });
    expect(pending3.suggestion).not.toBeNull();
    const ignored = h.learn.decide({ suggestionId: pending3.suggestion!.id, action: "ignore" });
    expect(ignored.suggestion.status).toBe("ignored");

    const repeatIgnored = h.learn.observeEdit({
      workId: "wrk_learn",
      insertedText: "后来雾原连又出现了",
      editedText: "后来雾原莲又出现了",
    });
    expect(repeatIgnored.suggestion).toBeNull();
    expect(repeatIgnored.reason).toBe("suppressed");
  });
});
