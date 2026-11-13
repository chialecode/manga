import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { ASR_MODEL_CATALOG, type AsrCatalogModel, type MangaProductApp } from "@manga/app-core";
import type { AsrService } from "../asr-service.ts";
import { verifyBundledAssets } from "../bundled-assets.ts";
import {
  DRAWN,
  PICK,
  clickTestId,
  closeTabs,
  openFromShelf,
  openProjectsPage,
  openRecords,
  pressChord,
  pressKey,
  railTo,
  setField,
  showTab,
  sleep,
  trustedClick,
  waitDrawn,
  waitForTestId,
  waitFrames,
  waitUntil,
} from "./driver.ts";
import { caller, capturePage, ensureDock, js, leaveSettings, openSettingsPage, toRail, type FlowResult } from "./common.ts";
import type { Observation } from "./window-walk.ts";

/**
 * Packaged-window smoke for M12 voice dictation (`AT-174`, `AT-178`, `AT-179`, `AT-180`, `AT-182`).
 * Uses `view.showInactive()` only, never moves the OS cursor or steals focus, and keeps all network
 * traffic strictly on `127.0.0.1` loopback stand-ins.
 */

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sendRightAltDown(view: BrowserWindow): void {
  view.webContents.focus();
  view.webContents.sendInputEvent({ type: "keyDown", keyCode: "AltGr" });
}

function sendRightAltUp(view: BrowserWindow): void {
  view.webContents.sendInputEvent({ type: "keyUp", keyCode: "AltGr" });
}

async function holdRightAltDictation(
  view: BrowserWindow,
  holdMs: number,
  onBeforeRelease?: () => Promise<void> | void,
): Promise<boolean> {
  sendRightAltDown(view);
  const started = await waitUntil(view, `Boolean(document.querySelector('[data-testid="dictation-capsule"]'))`, 5000);
  await sleep(holdMs); // real time: 右 Alt 按住说话时长，采集足够语音帧供 VAD 与识别使用
  if (onBeforeRelease) await onBeforeRelease();
  sendRightAltUp(view);
  return started;
}

function resolveWindowsTarExe(): string {
  const sysRoot = process.env.SystemRoot;
  if (!sysRoot) return "tar.exe";
  const candidate = path.join(sysRoot, "System32", "tar.exe");
  return fs.existsSync(candidate) ? candidate : "tar.exe";
}

function buildSyntheticTarBz2(workDir: string, modelId: string, kind: "senseVoice" | "funasrNano" | "qwen3Asr"): {
  archiveBuffer: Buffer;
  catalogEntry: (url: string) => AsrCatalogModel;
} {
  const topLevelDirectory = `sherpa-onnx-${modelId}-2026-03-25`;
  const buildRoot = path.join(workDir, `build-${modelId}`);
  const extractedDir = path.join(buildRoot, topLevelDirectory);
  fs.mkdirSync(extractedDir, { recursive: true });

  const weightsBytes = crypto.scryptSync("manga-smoke-synthetic-asr", modelId, 64 * 1024);
  const tokensBytes = Buffer.from("<blk> 0\n<sos> 1\n<eos> 2\n星 3\n野 4\n澪 5\n", "utf8");
  fs.writeFileSync(path.join(extractedDir, "model.int8.onnx"), weightsBytes);
  fs.writeFileSync(path.join(extractedDir, "tokens.txt"), tokensBytes);

  const archiveName = `${topLevelDirectory}.tar.bz2`;
  const archivePath = path.join(workDir, archiveName);
  execFileSync(resolveWindowsTarExe(), ["-cjf", archivePath, "-C", buildRoot, topLevelDirectory], {
    windowsHide: true,
    stdio: "pipe",
  });
  const archiveBuffer = fs.readFileSync(archivePath);
  const archiveSha256 = sha256Hex(archiveBuffer);

  return {
    archiveBuffer,
    catalogEntry: (url: string): AsrCatalogModel => ({
      id: modelId,
      modelId,
      name: `Smoke ${modelId}`,
      kind,
      recommended: kind === "qwen3Asr",
      license: "Apache-2.0",
      licenseUrl: "https://github.com/k2-fsa/sherpa-onnx",
      upstreamDocsUrl: "https://k2-fsa.github.io/sherpa/onnx/index.html",
      languages: ["zh", "en", "ja", "auto"],
      hotwords: kind === "senseVoice" ? 0 : 50,
      archiveName,
      archiveBytes: archiveBuffer.length,
      archiveSha256,
      topLevelDirectory,
      sources: [{ id: "loopback", label: "Loopback", url }],
      requiredFiles: [
        { path: "model.int8.onnx", byteSize: weightsBytes.length, sha256: sha256Hex(weightsBytes), configRole: "model" },
        { path: "tokens.txt", byteSize: tokensBytes.length, sha256: sha256Hex(tokensBytes), configRole: "tokens" },
      ],
    }),
  };
}

export async function runDictationSmoke(input: {
  appService: MangaProductApp;
  grant: string;
  view: BrowserWindow;
  evidenceDir: string | undefined;
  logsDir: string;
  asrService?: AsrService;
}): Promise<FlowResult & { observations: Observation[] }> {
  const { appService, grant, view, evidenceDir, logsDir, asrService } = input;
  const clip = process.env.MANGA_SMOKE_AUDIO;
  if (!clip || !fs.existsSync(clip)) {
    return { ok: false, notRun: true, reason: "MANGA_SMOKE_AUDIO missing", observations: [] };
  }
  const shotsDir = evidenceDir ? path.join(evidenceDir, "screenshots") : undefined;
  const call = caller(appService, grant);
  const observations: Observation[] = [];
  const observe = (name: string, ok: boolean, detail: unknown) => {
    observations.push({ name, status: ok ? "passed" : "failed", detail });
    console.error(`dictation-walk ${name}: ${ok ? "ok" : "FAILED"} ${JSON.stringify(detail ?? null).slice(0, 900)}`);
    return ok;
  };
  const value = async <T>(commandId: string, body: Record<string, unknown>): Promise<T> => {
    const res = await call(commandId, body);
    if (res.status !== "ok") throw new Error(`${commandId}: ${res.error?.message ?? "failed"}`);
    return res.value as T;
  };

  view.showInactive();

  // Loopback stand-in for `/v1/audio/transcriptions` and `/v1/chat/completions` (polish).
  let nextTranscript = "默认听写文本";
  let nextPolish = "默认润色文本。";
  let responseDelayMs = 0;
  let gateResponse = false;
  let pendingGateResolve: (() => void) | null = null;
  const releasePendingGate = () => {
    const fn = pendingGateResolve;
    pendingGateResolve = null;
    fn?.();
  };
  let asrUploadCount = 0;
  let polishRequestCount = 0;

  const aiServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const reqUrl = req.url ?? "";
        if (reqUrl.includes("/audio/transcriptions")) {
          asrUploadCount += 1;
          const textToReturn = nextTranscript;
          if (gateResponse) {
            await new Promise<void>((resolve) => { pendingGateResolve = resolve; });
          } else if (responseDelayMs > 0) {
            const waitMs = responseDelayMs;
            responseDelayMs = 0;
            await sleep(waitMs); // real time: 回环转写桩可控延迟，用于观察识别中胶囊态
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ text: textToReturn }));
          return;
        }
        if (reqUrl.includes("/chat/completions")) {
          polishRequestCount += 1;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "chatcmpl-smoke",
            choices: [{ index: 0, message: { role: "assistant", content: nextPolish }, finish_reason: "stop" }],
          }));
          return;
        }
        res.writeHead(404);
        res.end();
      })();
    });
  });
  await new Promise<void>((resolve) => aiServer.listen(0, "127.0.0.1", () => resolve()));
  const aiAddr = aiServer.address();
  const aiPort = typeof aiAddr === "object" && aiAddr ? aiAddr.port : 0;

  const fixtureDir = path.join(logsDir, "dictation-smoke-fixtures");
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  fs.mkdirSync(fixtureDir, { recursive: true });

  try {
    await call("settings.skipAi", {});
    const asrSecret = appService.stashSecret("smoke-dictation-asr-key");
    const asrConn = await value<{ connection?: { id: string }; id?: string }>("connections.upsert", {
      label: "Loopback ASR",
      protocol: "openai-chat-completions",
      baseUrl: `http://127.0.0.1:${aiPort}/v1`,
      modelId: "whisper-smoke",
      purpose: "transcription",
      profile: { transcriptionInterface: "audio_transcriptions" },
      credentialHandle: asrSecret,
    });
    const asrConnId = String(asrConn.connection?.id ?? asrConn.id ?? "");

    const polishSecret = appService.stashSecret("smoke-dictation-polish-key");
    const polishConn = await value<{ connection?: { id: string }; id?: string }>("connections.upsert", {
      label: "Loopback Polish",
      protocol: "openai-chat-completions",
      baseUrl: `http://127.0.0.1:${aiPort}/v1`,
      modelId: "polish-smoke",
      purpose: "text",
      credentialHandle: polishSecret,
    });
    const polishConnId = String(polishConn.connection?.id ?? polishConn.id ?? "");

    await call("settings.setRecording", {
      dictationEngine: { kind: "connection", connectionId: asrConnId },
      polishMode: "raw",
      dictationInsertMode: "stream_replace",
      retainDictationAudio24h: true,
    });

    // Import a synthetic novel so Chat Composer renders both `note` and `ask` switches alongside a reader.
    const book = await value<{ resourceId: string }>("library.importDocument", {
      title: "星霜馆手记",
      format: "txt",
      bytes: [...Buffer.from("第一章 旧馆来信。".repeat(30))],
    });
    await view.webContents.reload();
    await toRail(view);
    await openFromShelf(view, "novel", book.resourceId, 10_000);
    await waitForTestId(view, "reading-body");
    await ensureDock(view);

    // =========================================================================
    // 1. dictation-insert (AT-174)
    // =========================================================================
    await clickTestId(view, "chat-mode-ask");
    await waitUntil(view, `${PICK}("chat-mic")?.getAttribute("data-mode") === "dictation"`, 4000);

    // 1a. Chat mic in "ask" mode triggers dictation into draft without sending; "note" mode uses recorder.
    await setField(view, "agent-composer", "");
    nextTranscript = "提问栏语音草稿";
    await clickTestId(view, "chat-mic");
    const askMicStarted = await waitUntil(view, `Boolean(document.querySelector('[data-testid="dictation-capsule"]'))`, 5000);
    await sleep(1300); // real time: 提问栏麦克风听写采集时长
    if (shotsDir) {
      await capturePage(view, shotsDir, "ui-dictation-capsule-recording.png", "dictation-capsule");
    }
    await clickTestId(view, "chat-mic");
    const askDraftInserted = await waitUntil(
      view,
      `(${PICK}("agent-composer")?.value ?? "").includes("提问栏语音草稿") && !document.querySelector('[data-testid="dictation-capsule"]')`,
      10_000,
    );
    const askDidNotAutoSend = await js<boolean>(
      view,
      `!document.querySelector('[data-testid="agent-stop"]') && (${PICK}("agent-composer")?.value ?? "").includes("提问栏语音草稿")`,
    );

    await clickTestId(view, "chat-mode-note");
    await waitUntil(view, `${PICK}("chat-mic")?.getAttribute("data-mode") !== "dictation"`, 3000);
    await clickTestId(view, "chat-mic");
    const noteModeUsesRecorder = await waitUntil(
      view,
      `Boolean(document.querySelector('[data-testid="record-indicator"]')) && !document.querySelector('[data-testid="dictation-capsule"]')`,
      5000,
    );
    await sleep(300); // real time: 等待录音悬浮窗完成初始加载后再停止录音
    await clickTestId(view, "record-stop");
    await waitUntil(view, `!document.querySelector('[data-testid="record-indicator"]')`, 5000);
    await clickTestId(view, "chat-mode-ask");

    // 1b. Surface #1 (Chat Composer): solo RightAlt hold >= 250ms, menu bar stays hidden, recognizing capsule screenshot.
    await setField(view, "agent-composer", "");
    await js(view, `${PICK}("agent-composer")?.focus()`);
    nextTranscript = "表面一提问框听写";
    responseDelayMs = 650;
    const holdStarted = await holdRightAltDictation(view, 1300);
    const sawRecognizingStage = await waitUntil(
      view,
      `Boolean(document.querySelector('[data-testid="dictation-capsule"]')) && !document.querySelector('[data-testid="dictation-capsule-mode"]')`,
      3000,
    );
    if (shotsDir && sawRecognizingStage) {
      await capturePage(view, shotsDir, "ui-dictation-capsule-recognizing.png", "dictation-capsule");
    }
    const surface1Composer = await waitUntil(
      view,
      `(${PICK}("agent-composer")?.value ?? "").includes("表面一提问框听写")`,
      10_000,
    );
    const noMenuBarSteal = !view.isMenuBarVisible() && await js<boolean>(
      view,
      `document.activeElement?.getAttribute("data-testid") === "agent-composer"`,
    );

    // 1c. Double-tap RightAlt (< 350ms) -> locked hands-free mode -> stop via capsule button.
    await setField(view, "agent-composer", "");
    await js(view, `${PICK}("agent-composer")?.focus()`);
    nextTranscript = "免提锁定模式听写";
    sendRightAltDown(view);
    await sleep(45); // real time: 双击右 Alt 第一次按下保持时长
    sendRightAltUp(view);
    await sleep(95); // real time: 双击右 Alt 两次敲击间隔（< 350 ms）
    sendRightAltDown(view);
    await sleep(45); // real time: 双击右 Alt 第二次按下保持时长
    sendRightAltUp(view);
    const lockedEntered = await waitUntil(
      view,
      `document.querySelector('[data-testid="dictation-capsule"]')?.getAttribute("data-mode") === "locked" && Boolean(document.querySelector('[data-testid="dictation-stop"]'))`,
      5000,
    );
    await sleep(1300); // real time: 免提锁定模式下采集语音样本时长
    await clickTestId(view, "dictation-stop");
    const lockedInserted = await waitUntil(
      view,
      `(${PICK}("agent-composer")?.value ?? "").includes("免提锁定模式听写")`,
      10_000,
    );

    // 1d. Esc cancels active dictation without inserting text.
    await setField(view, "agent-composer", "取消前保留内容");
    await js(view, `${PICK}("agent-composer")?.focus()`);
    nextTranscript = "绝不应写入的取消文本";
    sendRightAltDown(view);
    await waitUntil(view, `Boolean(document.querySelector('[data-testid="dictation-capsule"]'))`, 5000);
    await sleep(450); // real time: 取消前按住采集少量语音帧
    await pressKey(view, "Escape");
    sendRightAltUp(view);
    const escCancelledCleanly = await waitUntil(view, `!document.querySelector('[data-testid="dictation-capsule"]')`, 5000)
      && (await js<string>(view, `${PICK}("agent-composer")?.value ?? ""`)) === "取消前保留内容";

    // 1e. IME composition barrier (`compositionstart` -> RightAlt -> `compositionend`).
    await setField(view, "agent-composer", "");
    await js(view, `(() => {
      const el = ${PICK}("agent-composer");
      if (!el) return;
      el.focus();
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "ni" }));
    })()`);
    nextTranscript = "输入法组词后听写";
    sendRightAltDown(view);
    await sleep(320); // real time: IME 组词期间按住右 Alt，验证不会在组词未结束时抢跑启动
    const waitedDuringIme = !(await js<boolean>(view, `Boolean(document.querySelector('[data-testid="dictation-capsule"]'))`));
    await js(view, `(() => {
      const el = ${PICK}("agent-composer");
      el?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
    })()`);
    const startedAfterImeEnd = await waitUntil(view, `Boolean(document.querySelector('[data-testid="dictation-capsule"]'))`, 5000);
    await sleep(1300); // real time: IME 组词结束后采集语音时长
    sendRightAltUp(view);
    const imeInserted = await waitUntil(
      view,
      `(${PICK}("agent-composer")?.value ?? "").includes("输入法组词后听写")`,
      10_000,
    );

    // 1f. Surface #2 (Note Editor Tiptap) + Surface #3 (Note Source CodeMirror 6) + mid-recognition tab close fallback.
    const note = await value<{ objectId?: string; note?: { id: string }; id?: string }>("notes.create", { title: "听写多表面笔记", text: "初始段落。" });
    const noteId = String(note.objectId ?? note.note?.id ?? note.id ?? "");
    await openRecords(view, "note");
    await clickTestId(view, `record-open-${noteId}`, 6000);
    await waitDrawn(view, "note-surface", 10_000);
    await waitFrames(view, 2);
    await trustedClick(view, "note-surface", 4000);
    await js(view, `${PICK}("note-surface")?.focus()`);
    nextTranscript = "表面二富文本笔记";
    await holdRightAltDictation(view, 1300);
    const surface2NoteRich = await waitUntil(
      view,
      `(${PICK}("note-surface")?.textContent ?? "").includes("表面二富文本笔记")`,
      10_000,
    );

    await clickTestId(view, "note-source-toggle", 4000);
    await waitUntil(view, `Boolean(${PICK}("note-source")?.querySelector(".cm-content"))`, 6000);
    await waitFrames(view, 2);
    await js(view, `${PICK}("note-source")?.querySelector(".cm-content")?.focus()`);
    nextTranscript = "表面三源码编辑器";
    await holdRightAltDictation(view, 1300);
    const surface3NoteCm6 = await waitUntil(
      view,
      `(${PICK}("note-source")?.querySelector(".cm-content")?.textContent ?? "").includes("表面三源码编辑器")`,
      10_000,
    );
    await clickTestId(view, "note-source-toggle", 4000);
    await waitUntil(view, `!document.querySelector('[data-testid="note-source"]')`, 4000);
    await waitDrawn(view, "note-surface", 6000);
    await waitFrames(view, 2);

    // Close note tab mid-recognition -> verify copy fallback notice & zero write to composer.
    await trustedClick(view, "note-surface", 4000);
    await js(view, `${PICK}("note-surface")?.focus()`);
    nextTranscript = "目标关闭回退复制文本";
    gateResponse = true;
    const uploadsBeforeCloseTest = asrUploadCount;
    await holdRightAltDictation(view, 1300);
    await waitUntil(view, `Boolean(document.querySelector('[data-testid="dictation-capsule"]'))`, 3000);
    for (let i = 0; i < 60 && asrUploadCount === uploadsBeforeCloseTest; i += 1) {
      await sleep(50); // real time: 等待识别请求到达回环服务端后再关闭目标标签页
    }
    await closeTabs(view, ["note", "records"]);
    await waitUntil(view, `!document.querySelector('[data-testid="note-surface"]')`, 5000);
    await railTo(view, "home");
    await ensureDock(view);
    await waitFrames(view, 2);
    await setField(view, "agent-composer", "其他表面原样保留");
    await js(view, `${PICK}("agent-composer")?.focus()`);
    gateResponse = false;
    releasePendingGate();
    const unmountFallbackNotice = await waitUntil(
      view,
      `(document.querySelector('[data-testid="toast-notice"]')?.textContent ?? "").includes("目标关闭回退复制文本") && Boolean(document.querySelector('[data-testid="toast-notice-action"]'))`,
      8000,
    );
    const composerUntouchedOnUnmount = (await js<string>(view, `${PICK}("agent-composer")?.value ?? ""`)) === "其他表面原样保留";
    await clickTestId(view, "toast-notice-close", 1500);

    // 1g. Surface #4 (Project Copy Draft Editor) + Surface #5 (Mindmap topic textarea) + Surface #6 (Search popup input).
    await openProjectsPage(view);
    await clickTestId(view, "projects-new", 4000);
    await waitForTestId(view, "project-name");
    await setField(view, "project-name", "语音听写创作空间");
    await clickTestId(view, "project-create-submit", 4000);
    await waitUntil(view, `Boolean(document.querySelector('[data-testid="page-project"]')?.getAttribute("data-project"))`, 10_000);

    await clickTestId(view, "project-tab-draft", 5000);
    await waitForTestId(view, "draft-tab");
    await clickTestId(view, "draft-new", 5000);
    await waitDrawn(view, "draft-surface", 8000);
    await waitFrames(view, 2);
    await trustedClick(view, "draft-surface", 4000);
    await js(view, `${PICK}("draft-surface")?.focus()`);
    nextTranscript = "表面四项目文稿编辑";
    await holdRightAltDictation(view, 1300);
    const surface4Draft = await waitUntil(
      view,
      `(${PICK}("draft-surface")?.textContent ?? "").includes("表面四项目文稿编辑")`,
      10_000,
    );

    await showTab(view, { kind: "project", title: "语音听写创作空间" });
    await clickTestId(view, "project-tab-mindmap", 5000);
    await waitForTestId(view, "mindmap-tab");
    await clickTestId(view, "mindmap-new", 5000);
    await waitForTestId(view, "mindmap-board", "data-nodes", "1", 8000);
    const rootNodeId = await js<string>(
      view,
      `document.querySelector('[data-testid^="mm-node-"]')?.getAttribute("data-testid")?.slice("mm-node-".length) ?? ""`,
    );
    await clickTestId(view, `mm-node-${rootNodeId}`, 4000);
    await js(view, `(() => {
      const el = document.querySelector('[data-testid="mindmap-canvas"]');
      if (!el) return;
      el.focus();
      el.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    })()`);
    await waitUntil(view, `Boolean(document.querySelector('textarea[data-testid^="mm-edit-"]'))`, 6000);
    await js(view, `document.querySelector('textarea[data-testid^="mm-edit-"]')?.focus()`);
    nextTranscript = "表面五思维导图节点";
    await holdRightAltDictation(view, 1300);
    const surface5MindmapTextarea = await waitUntil(
      view,
      `(document.querySelector('textarea[data-testid^="mm-edit-"]')?.value ?? "").includes("表面五思维导图节点")`,
      10_000,
    );
    await js(view, `document.querySelector('textarea[data-testid^="mm-edit-"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))`);
    const surface5MindmapCommitted = surface5MindmapTextarea && await waitUntil(
      view,
      `[...document.querySelectorAll('.mm-text')].some((el) => (el.textContent ?? "").includes("表面五思维导图节点"))`,
      6000,
    );

    await pressChord(view, "K", ["control"]);
    await waitDrawn(view, "search-input", 5000);
    await js(view, `${PICK}("search-input")?.focus()`);
    nextTranscript = "表面六全局搜索框";
    await holdRightAltDictation(view, 1300);
    const surface6Search = await waitUntil(
      view,
      `(${PICK}("search-input")?.value ?? "").includes("表面六全局搜索框")`,
      10_000,
    );
    await pressKey(view, "Escape");
    await waitUntil(view, `!${DRAWN}(${PICK}("search-box"))`, 4000);

    const surfacesPassed = [
      surface1Composer,
      surface2NoteRich,
      surface3NoteCm6,
      surface4Draft,
      surface5MindmapCommitted,
      surface6Search,
    ];
    const insertOk = askMicStarted
      && askDraftInserted
      && askDidNotAutoSend
      && noteModeUsesRecorder
      && holdStarted
      && surface1Composer
      && noMenuBarSteal
      && lockedEntered
      && lockedInserted
      && escCancelledCleanly
      && waitedDuringIme
      && startedAfterImeEnd
      && imeInserted
      && unmountFallbackNotice
      && composerUntouchedOnUnmount
      && surfacesPassed.every(Boolean);

    observe("dictation-insert", insertOk, {
      surfacesCount: surfacesPassed.filter(Boolean).length,
      surfaces: {
        chatComposer: surface1Composer,
        noteRichTiptap: surface2NoteRich,
        noteSourceCm6: surface3NoteCm6,
        projectDraft: surface4Draft,
        mindmapTopic: surface5MindmapCommitted,
        searchInput: surface6Search,
      },
      askMicDualMode: askDraftInserted && askDidNotAutoSend && noteModeUsesRecorder,
      noMenuBarSteal,
      lockedHandsFree: lockedEntered && lockedInserted,
      escCancel: escCancelledCleanly,
      imeBarrier: waitedDuringIme && startedAfterImeEnd && imeInserted,
      unmountFallback: unmountFallbackNotice && composerUntouchedOnUnmount,
      sawRecognizingStage,
    });

    // =========================================================================
    // 2. dictation-local (AT-179)
    // =========================================================================
    const localModelDir = process.env.MANGA_SMOKE_ASR_MODEL_DIR;
    let localOk = false;
    let localDetail: Record<string, unknown> = { reason: "MANGA_SMOKE_ASR_MODEL_DIR missing" };
    if (localModelDir && fs.existsSync(localModelDir) && asrService) {
      const dirHandle = appService.registerPath("directory", localModelDir);
      const imported = await call("asrModel.import", {
        modelId: "sense-voice-funasr-nano-int8",
        pathHandle: dirHandle,
        kind: "directory",
      });
      await call("settings.setRecording", {
        dictationEngine: { kind: "local", modelId: "sense-voice-funasr-nano-int8" },
        polishMode: "raw",
      });

      await ensureDock(view);
      await setField(view, "agent-composer", "");
      await js(view, `${PICK}("agent-composer")?.focus()`);
      const uploadsBeforeLocal = asrUploadCount;
      await holdRightAltDictation(view, 3500);
      const firstRecognized = await waitUntil(
        view,
        `/[\u4e00-\u9fff]{4,}/.test(${PICK}("agent-composer")?.value ?? "") && !document.querySelector('[data-testid="dictation-capsule"]')`,
        20_000,
      );
      const firstText = await js<string>(view, `${PICK}("agent-composer")?.value ?? ""`);
      const pidBeforeKill = asrService.pid;

      // Kill the `asr-host` utilityProcess and verify automatic respawn on the next dictation while window stays healthy.
      let killedChild = false;
      if (pidBeforeKill && pidBeforeKill > 0) {
        try {
          process.kill(pidBeforeKill);
          killedChild = true;
        } catch {
          killedChild = false;
        }
      }
      // The next dictation starts only after the main process has seen the exit, so the observation tests the respawn and not how fast the exit is reported.
      let exitObserved = false;
      for (let i = 0; i < 50; i += 1) {
        if (!asrService.running) { exitObserved = true; break; }
        await sleep(100); // real time: 等待 asr-host 进程终止信号传播至主进程
      }
      await setField(view, "agent-composer", "");
      await js(view, `${PICK}("agent-composer")?.focus()`);
      const respawnStarted = await holdRightAltDictation(view, 3500);
      const respawnRecognized = await waitUntil(
        view,
        `/[\u4e00-\u9fff]{4,}/.test(${PICK}("agent-composer")?.value ?? "") && !document.querySelector('[data-testid="dictation-capsule"]')`,
        20_000,
      );
      // Recorded only when the respawn dictation produced nothing, to tell a dictation that never started from one that failed or heard no speech.
      const respawnComposerChars = respawnRecognized ? null : await js<number>(view, `(${PICK}("agent-composer")?.value ?? "").length`);
      const respawnCapsuleText = respawnRecognized ? null : await js<string | null>(view, `document.querySelector('[data-testid="dictation-capsule"]')?.textContent ?? null`);
      const pidAfterRespawn = asrService.pid;
      const windowHealthy = !view.isDestroyed() && !view.webContents.isCrashed();

      // Short idle timeout unloads model (`ready` -> `installed`) and exits `asr-host`.
      asrService.setIdleTimeoutMs(1500);
      let idleUnloaded = false;
      for (let i = 0; i < 30; i += 1) {
        await sleep(200); // real time: 等待短空闲超时触发本地模型卸载与子进程退出
        const listed = await value<{ models: Array<{ modelId: string; state: string }> }>("asrModel.list", {});
        const senseState = listed.models.find((m) => m.modelId === "sense-voice-funasr-nano-int8")?.state;
        if (!asrService.running && senseState === "installed") {
          idleUnloaded = true;
          break;
        }
      }
      asrService.setIdleTimeoutMs(5 * 60_000);

      localOk = imported.status === "ok"
        && firstRecognized
        && killedChild
        && exitObserved
        && respawnRecognized
        && Boolean(pidAfterRespawn && pidAfterRespawn !== pidBeforeKill)
        && windowHealthy
        && idleUnloaded
        && asrUploadCount === uploadsBeforeLocal;

      localDetail = {
        importedOk: imported.status === "ok",
        firstRecognized,
        firstChars: firstText.length,
        killedChild,
        exitObserved,
        respawnStarted,
        respawnedNewPid: Boolean(pidAfterRespawn && pidAfterRespawn !== pidBeforeKill),
        respawnRecognized,
        ...(respawnRecognized ? {} : { respawnComposerChars, respawnCapsuleText }),
        windowHealthy,
        idleUnloaded,
        cloudUploadsDelta: asrUploadCount - uploadsBeforeLocal,
      };
    }
    observe("dictation-local", localOk, localDetail);

    // =========================================================================
    // 3. dictation-revert (AT-182)
    // =========================================================================
    await value("dictionary.add", {
      scope: "global",
      term: "林晓雾",
      category: "character",
      aliases: [{ alias: "林小雾", kind: "alias" }],
    });
    await call("settings.setRecording", {
      dictationEngine: { kind: "connection", connectionId: asrConnId },
      polishMode: "light",
      polishConnectionId: polishConnId,
      dictationInsertMode: "stream_replace",
    });

    const revertNote = await value<{ objectId?: string; note?: { id: string }; id?: string }>("notes.create", {
      title: "回退与离散撤销验证",
      text: "序章：",
    });
    const revertNoteId = String(revertNote.objectId ?? revertNote.note?.id ?? revertNote.id ?? "");
    await closeTabs(view, ["note", "records"]);
    await openRecords(view, "note");
    await clickTestId(view, `record-open-${revertNoteId}`, 6000);
    await waitDrawn(view, "note-surface", 10_000);
    await waitFrames(view, 2);
    await trustedClick(view, "note-surface", 4000);
    // Place ProseMirror's caret deterministically at the end of "序章：".
    await pressChord(view, "End");
    await waitFrames(view, 2);

    nextTranscript = "嗯，今天讨论林小雾的分镜节奏";
    nextPolish = "今天讨论林晓雾的分镜节奏。";
    const polishBefore = polishRequestCount;
    await holdRightAltDictation(view, 1300);

    const polishedInserted = await waitUntil(
      view,
      `(${PICK}("note-surface")?.textContent ?? "").includes("今天讨论林晓雾的分镜节奏。") && Boolean(document.querySelector('[data-testid="dictation-pill-revert"]'))`,
      10_000,
    );
    const termsToggleShown = await waitUntil(view, `Boolean(document.querySelector('[data-testid="dictation-pill-terms-toggle"]'))`, 3000);
    if (termsToggleShown) {
      await clickTestId(view, "dictation-pill-terms-toggle", 2000);
      await waitUntil(view, `Boolean(document.querySelector('[data-testid="dictation-pill-terms"]'))`, 2000);
    }
    if (shotsDir) {
      await capturePage(view, shotsDir, "ui-dictation-pill.png", "dictation-pill");
    }

    await clickTestId(view, "dictation-pill-revert", 3000);
    const revertedToRaw = await waitUntil(
      view,
      `(${PICK}("note-surface")?.textContent ?? "") === "序章：嗯，今天讨论林小雾的分镜节奏"`,
      5000,
    );

    // Ctrl+Z discrete undo steps: revert -> polished finalText -> rawText -> initial "序章：".
    await js(view, `${PICK}("note-surface")?.focus()`);
    await pressChord(view, "Z", ["control"]);
    const discreteUndoStep1 = await waitUntil(
      view,
      `(${PICK}("note-surface")?.textContent ?? "") === "序章：今天讨论林晓雾的分镜节奏。"`,
      5000,
    );
    await pressChord(view, "Z", ["control"]);
    const discreteUndoStep2 = await waitUntil(
      view,
      `(${PICK}("note-surface")?.textContent ?? "") === "序章：嗯，今天讨论林小雾的分镜节奏"`,
      5000,
    );
    await pressChord(view, "Z", ["control"]);
    const discreteUndoStep3 = await waitUntil(
      view,
      `(${PICK}("note-surface")?.textContent ?? "") === "序章："`,
      5000,
    );

    // Learn-from-edits: edit fictional proper noun ("白鹭城" -> "白露城", phonetic score >= 0.6), blur, and accept suggestion!
    await call("settings.setRecording", { polishMode: "raw" });
    await ensureDock(view);
    await setField(view, "agent-composer", "");
    await js(view, `${PICK}("agent-composer")?.focus()`);
    nextTranscript = "今天讨论白鹭城的剧情走向";
    await holdRightAltDictation(view, 1300);
    await waitUntil(view, `(${PICK}("agent-composer")?.value ?? "") === "今天讨论白鹭城的剧情走向"`, 10_000);
    await setField(view, "agent-composer", "今天讨论白露城的剧情走向");
    await js(view, `${PICK}("agent-composer")?.blur()`);
    const suggestionShown = await waitUntil(
      view,
      `Boolean(document.querySelector('[data-testid="dictation-pill-suggestion-accept"]'))`,
      6000,
    );
    await clickTestId(view, "dictation-pill-suggestion-accept", 3000);
    await waitUntil(view, `!document.querySelector('[data-testid="dictation-pill-suggestion"]')`, 4000);
    const globalDict = await value<{ terms: Array<{ term: string; heard?: string | null; aliases?: Array<{ alias: string }> }> }>(
      "dictionary.list",
      { scope: "global" },
    );
    const learnedSaved = globalDict.terms.some(
      (item) => item.term === "白露城" && (item.heard === "白鹭城" || (item.aliases ?? []).some((a) => a.alias === "白鹭城")),
    );

    const revertOk = polishedInserted
      && polishRequestCount > polishBefore
      && termsToggleShown
      && revertedToRaw
      && discreteUndoStep1
      && discreteUndoStep2
      && discreteUndoStep3
      && suggestionShown
      && learnedSaved;

    observe("dictation-revert", revertOk, {
      polishedInserted,
      termsToggleShown,
      revertedToRaw,
      discreteUndoStep1,
      discreteUndoStep2,
      discreteUndoStep3,
      suggestionShown,
      learnedSaved,
    });

    // =========================================================================
    // 4. dictation-settings (AT-178, AT-180, AT-182)
    // =========================================================================
    const synthFunasr = buildSyntheticTarBz2(fixtureDir, "funasr-nano-int8", "funasrNano");
    const synthQwen = buildSyntheticTarBz2(fixtureDir, "qwen3-asr-0.6B-int8", "qwen3Asr");
    const tamperedQwenBuf = Buffer.from(synthQwen.archiveBuffer);
    tamperedQwenBuf[Math.max(0, tamperedQwenBuf.length - 16)] ^= 0xff;

    let sawRange206 = false;
    let initialDownloadRequests = 0;
    const modelServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const reqUrl = req.url ?? "";
      if (reqUrl.startsWith("/models/funasr.tar.bz2")) {
        const rangeHeader = req.headers.range;
        if (typeof rangeHeader === "string" && rangeHeader.startsWith("bytes=")) {
          const m = /^bytes=(\d+)-/.exec(rangeHeader);
          const start = m ? Number(m[1]) : 0;
          if (start > 0 && start < synthFunasr.archiveBuffer.length) {
            sawRange206 = true;
            const slice = synthFunasr.archiveBuffer.subarray(start);
            res.writeHead(206, {
              "content-type": "application/octet-stream",
              "accept-ranges": "bytes",
              etag: '"smoke-funasr-v1"',
              "content-length": String(slice.length),
              "content-range": `bytes ${start}-${synthFunasr.archiveBuffer.length - 1}/${synthFunasr.archiveBuffer.length}`,
            });
            res.end(slice);
            return;
          }
        }
        initialDownloadRequests += 1;
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "accept-ranges": "bytes",
          etag: '"smoke-funasr-v1"',
          "content-length": String(synthFunasr.archiveBuffer.length),
        });
        let offset = 0;
        const chunkBytes = 4096;
        const timer = setInterval(() => {
          if (res.destroyed || offset >= synthFunasr.archiveBuffer.length) {
            clearInterval(timer);
            if (!res.destroyed) res.end();
            return;
          }
          const next = synthFunasr.archiveBuffer.subarray(offset, Math.min(synthFunasr.archiveBuffer.length, offset + chunkBytes));
          offset += next.length;
          res.write(next);
        }, 120);
        req.on("close", () => clearInterval(timer));
        return;
      }
      if (reqUrl.startsWith("/models/qwen-tampered.tar.bz2")) {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(tamperedQwenBuf.length),
        });
        res.end(tamperedQwenBuf);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => modelServer.listen(0, "127.0.0.1", () => resolve()));
    const modelAddr = modelServer.address();
    const modelPort = typeof modelAddr === "object" && modelAddr ? modelAddr.port : 0;

    let settingsOk = false;
    let settingsDetail: Record<string, unknown> = {};
    try {
      const realSense = ASR_MODEL_CATALOG.find((m) => m.modelId === "sense-voice-funasr-nano-int8")!;
      appService.asrModels.setLoopbackCatalog([
        synthQwen.catalogEntry(`http://127.0.0.1:${modelPort}/models/qwen-tampered.tar.bz2`),
        realSense,
        synthFunasr.catalogEntry(`http://127.0.0.1:${modelPort}/models/funasr.tar.bz2`),
      ]);

      const openedVoiceSettings = await openSettingsPage(view, "recording");

      // Download -> confirm -> downloading progress -> pause -> HTTP 206 resume -> installed.
      await clickTestId(view, "voice-model-download-funasr-nano-int8", 4000);
      const confirmShown = await waitDrawn(view, "voice-model-confirm-dialog", 4000);
      await clickTestId(view, "voice-model-confirm-do", 4000);
      const sawDownloading = await waitUntil(
        view,
        `document.querySelector('[data-testid="voice-model-funasr-nano-int8"]')?.getAttribute("data-state") === "downloading" && Boolean(document.querySelector('[data-testid="voice-model-progress-funasr-nano-int8"]'))`,
        6000,
      );
      await sleep(260); // real time: 等待回环分块下载写入部分 .part 数据以验证 206 断点续传
      await clickTestId(view, "voice-model-pause-funasr-nano-int8", 4000);
      const sawPaused = await waitUntil(
        view,
        `document.querySelector('[data-testid="voice-model-funasr-nano-int8"]')?.getAttribute("data-state") === "paused"`,
        6000,
      );
      await clickTestId(view, "voice-model-resume-funasr-nano-int8", 4000);
      const resumedInstalled = await waitUntil(
        view,
        `document.querySelector('[data-testid="voice-model-funasr-nano-int8"]')?.getAttribute("data-state") === "installed"`,
        10_000,
      );

      // Checksum mismatch -> failed state + `.staging` cleaned up.
      await clickTestId(view, "voice-model-download-qwen3-asr-0.6B-int8", 4000);
      await waitDrawn(view, "voice-model-confirm-dialog", 4000);
      await clickTestId(view, "voice-model-confirm-do", 4000);
      const checksumRejected = await waitUntil(
        view,
        `document.querySelector('[data-testid="voice-model-qwen3-asr-0.6B-int8"]')?.getAttribute("data-state") === "failed"`,
        10_000,
      );
      const stagingEntriesAfterFail = fs.existsSync(appService.asrModels.stagingDir)
        ? fs.readdirSync(appService.asrModels.stagingDir)
        : [];
      const stagingClean = stagingEntriesAfterFail.length === 0;

      // Restore clean production catalog and seed one pending suggestion so all settings sections show authentic UI.
      await call("asrModel.delete", { modelId: "funasr-nano-int8" });
      appService.asrModels.setLoopbackCatalog(ASR_MODEL_CATALOG);
      await call("dictionary.observeEdit", {
        insertedText: "欢迎来到星双馆旧址",
        editedText: "欢迎来到星霜馆旧址",
      });

      await leaveSettings(view);
      const reopenedClean = await openSettingsPage(view, "recording");
      await waitUntil(
        view,
        `document.querySelector('[data-testid="voice-model-sense-voice-funasr-nano-int8"]')?.getAttribute("data-state") === "installed" && Boolean(document.querySelector('[data-testid="voice-history-list"]')) && Boolean(document.querySelector('[data-testid="dictionary-list"]'))`,
        8000,
      );

      // Light & Dark screenshots of Voice Settings, Dictionary, and Dictation History.
      await js(view, `(() => {
        document.documentElement.removeAttribute("data-theme");
        document.querySelector('[data-testid="voice-engines-section"]')?.scrollIntoView({ block: "start" });
      })()`);
      await waitFrames(view, 3);
      if (shotsDir) {
        await capturePage(view, shotsDir, "ui-dictation-settings-light.png", "voice-local-models");
      }

      await js(view, `document.documentElement.setAttribute("data-theme", "dark")`);
      await waitFrames(view, 3);
      if (shotsDir) {
        await capturePage(view, shotsDir, "ui-dictation-settings-dark.png", "voice-local-models");
      }

      await js(view, `(() => {
        document.documentElement.removeAttribute("data-theme");
        document.querySelector('[data-testid="voice-dictionary"]')?.scrollIntoView({ block: "start" });
      })()`);
      await waitFrames(view, 3);
      const dictSectionVisible = await waitUntil(
        view,
        `Boolean(document.querySelector('[data-testid="dictionary-list"]')) && Boolean(document.querySelector('[data-testid="dictionary-suggestions"]'))`,
        5000,
      );
      if (shotsDir) {
        await capturePage(view, shotsDir, "ui-dictation-dictionary.png", "voice-dictionary");
      }

      await js(view, `document.querySelector('[data-testid="voice-history-section"]')?.scrollIntoView({ block: "start" })`);
      await waitFrames(view, 3);
      const historySectionVisible = await waitUntil(
        view,
        `document.querySelectorAll('[data-testid="voice-history-list"] li').length >= 3`,
        5000,
      );
      if (shotsDir) {
        await capturePage(view, shotsDir, "ui-dictation-history.png", "voice-history-section");
      }

      const pageText = await js<string>(view, `document.querySelector('[data-testid="settings-page-recording"]')?.innerText ?? ""`);
      const zeroPathOrUserLeak = !/[A-Za-z]:[\\/]/.test(pageText)
        && !/\/Users\//i.test(pageText)
        && !/\bheat\b/i.test(pageText);

      await leaveSettings(view);

      settingsOk = openedVoiceSettings
        && confirmShown
        && sawDownloading
        && sawPaused
        && resumedInstalled
        && sawRange206
        && initialDownloadRequests >= 1
        && checksumRejected
        && stagingClean
        && reopenedClean
        && dictSectionVisible
        && historySectionVisible
        && zeroPathOrUserLeak;

      settingsDetail = {
        openedVoiceSettings,
        confirmShown,
        sawDownloading,
        sawPaused,
        resumedInstalled,
        sawRange206,
        checksumRejected,
        stagingClean,
        dictSectionVisible,
        historySectionVisible,
        zeroPathOrUserLeak,
      };
    } finally {
      appService.asrModels.setLoopbackCatalog(ASR_MODEL_CATALOG);
      modelServer.closeAllConnections();
      await new Promise<void>((resolve) => modelServer.close(() => resolve()));
    }
    observe("dictation-settings", settingsOk, settingsDetail);

    // =========================================================================
    // 5. dictation-boundary (AT-178, AT-179)
    // =========================================================================
    const resDir = process.resourcesPath;
    const asrHostFile = path.join(resDir, "asr-host.cjs");
    const asrHostExists = fs.existsSync(asrHostFile);
    const asrHostRefsSherpa = asrHostExists && fs.readFileSync(asrHostFile, "utf8").includes("sherpa-onnx-node");

    const asarRoot = path.join(resDir, "app.asar");
    const checkZeroSherpaOrHost = (relPath: string): boolean => {
      const full = path.join(asarRoot, relPath);
      if (!fs.existsSync(full)) return false;
      const code = fs.readFileSync(full, "utf8");
      return !code.includes("sherpa-onnx") && !code.includes("asr-host");
    };
    const bootstrapClean = checkZeroSherpaOrHost(".vite/build/main.cjs");
    const lightMainClean = checkZeroSherpaOrHost(".vite/build/light-main.cjs");
    const preloadLightClean = checkZeroSherpaOrHost(".vite/build/preload-light.cjs");

    const lightRendererDir = path.join(asarRoot, ".vite/renderer/light_window");
    let lightRendererClean = fs.existsSync(lightRendererDir);
    const walkAsarText = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) walkAsarText(child);
        else if (/\.(js|cjs|mjs|html|css)$/.test(entry.name)) {
          const txt = fs.readFileSync(child, "utf8");
          if (txt.includes("sherpa-onnx") || txt.includes("asr-host")) lightRendererClean = false;
        }
      }
    };
    walkAsarText(lightRendererDir);

    const fullMainFile = path.join(asarRoot, ".vite/build/full-main.cjs");
    const fullMainText = fs.existsSync(fullMainFile) ? fs.readFileSync(fullMainFile, "utf8") : "";
    const fullMainNeverRequiresSherpa = fullMainText.length > 0
      && !/require\(["']sherpa-onnx-node["']\)/.test(fullMainText)
      && !/import\(["']sherpa-onnx-node["']\)/.test(fullMainText);

    const gtcrnModelExists = fs.existsSync(path.join(resDir, "gtcrn", "gtcrn_simple.onnx"));
    const gtcrnLicenseExists = fs.existsSync(path.join(resDir, "gtcrn", "LICENSE"));
    const deepAssets = verifyBundledAssets(resDir, { deep: true });

    const forbiddenSpeechModelPattern = /(sense-voice|qwen3-asr|funasr-nano|model\.int8\.onnx|encoder\.int8\.onnx|llm\.int8\.onnx)/i;
    const bundledModelLeaks: string[] = [];
    const scanDiskResources = (dir: string, relPrefix: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "app.asar") continue;
        const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (forbiddenSpeechModelPattern.test(entry.name)) bundledModelLeaks.push(rel);
        if (entry.isDirectory()) scanDiskResources(path.join(dir, entry.name), rel);
      }
    };
    scanDiskResources(resDir, "");

    const boundaryOk = asrHostExists
      && asrHostRefsSherpa
      && bootstrapClean
      && lightMainClean
      && preloadLightClean
      && lightRendererClean
      && fullMainNeverRequiresSherpa
      && gtcrnModelExists
      && gtcrnLicenseExists
      && deepAssets.ok
      && bundledModelLeaks.length === 0;

    observe("dictation-boundary", boundaryOk, {
      asrHostExists,
      asrHostRefsSherpa,
      bootstrapClean,
      lightMainClean,
      preloadLightClean,
      lightRendererClean,
      fullMainNeverRequiresSherpa,
      gtcrnModelExists,
      gtcrnLicenseExists,
      deepAssetsOk: deepAssets.ok,
      deepAssetProblems: deepAssets.problems,
      bundledModelLeaks,
    });
  } catch (error) {
    observe("dictation-unexpected-error", false, {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    releasePendingGate();
    aiServer.closeAllConnections();
    await new Promise<void>((resolve) => aiServer.close(() => resolve()));
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  return {
    ok: observations.length === 5 && observations.every((row) => row.status === "passed"),
    observations,
  };
}
