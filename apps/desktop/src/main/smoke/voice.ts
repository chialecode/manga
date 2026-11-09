import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { BrowserWindow } from "electron";
import { MangaProductApp } from "@manga/app-core";
import { createId } from "@manga/contracts";
import { clickTestId, openFromShelf, sleep, waitForTestId } from "./driver.ts";
import { ensureDock } from "./common.ts";
import { OVERLAY_HEIGHT, OVERLAY_WIDTH } from "../overlay-model.ts";

/**
 * Recording (started from the right pane's microphone) through the real packaged window with a synthetic speech clip as the microphone (Chromium's fake capture
 * device plays the file given by MANGA_SMOKE_AUDIO) and a local stand-in for the transcription service. Nothing leaves
 * the machine. Without the clip the phase reports not-run.
 */

const TERMINAL = new Set(["done", "no_speech", "failed", "pending", "cancelled"]);
const actor = { kind: "user" as const, id: "desktop-user" };
type Input = { appService: MangaProductApp; grant: string; view: BrowserWindow; evidenceDir: string | undefined };

const js = <T>(view: BrowserWindow, code: string): Promise<T> => view.webContents.executeJavaScript(code) as Promise<T>;

async function until<T>(view: BrowserWindow, expression: string, timeoutMs: number): Promise<T | null> {
  return js<T | null>(view, `new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      let value = null;
      try { value = (${expression}); } catch { value = null; }
      if (value) resolve(value);
      else if (Date.now() - started > ${timeoutMs}) resolve(null);
      else setTimeout(tick, 25);
    };
    tick();
  })`);
}

async function waitForOverlay(view: BrowserWindow, present: boolean, timeoutMs = 5000): Promise<BrowserWindow | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = BrowserWindow.getAllWindows().find((win) => win !== view && !win.isDestroyed() && win.isAlwaysOnTop() && win.isVisible());
    if (present && found) return found;
    if (!present && !found) return undefined;
    await sleep(25); // real time: 等待录音悬浮窗打开或关闭完成
  }
  return BrowserWindow.getAllWindows().find((win) => win !== view && !win.isDestroyed() && win.isAlwaysOnTop());
}

function dragOverlayBy(overlay: BrowserWindow, dx: number, dy: number): void {
  const grabX = 32;
  const grabY = 18;
  overlay.webContents.sendInputEvent({ type: "mouseDown", x: grabX, y: grabY, button: "left", clickCount: 1 });
  const steps = 4;
  const stepDx = dx / steps;
  const stepDy = dy / steps;
  for (let i = 1; i <= steps; i += 1) {
    overlay.webContents.sendInputEvent({ type: "mouseMove", x: Math.round(grabX + stepDx), y: Math.round(grabY + stepDy), button: "left" });
  }
  overlay.webContents.sendInputEvent({ type: "mouseUp", x: grabX, y: grabY, button: "left", clickCount: 1 });
}

function clickOverlayStop(overlay: BrowserWindow): void {
  overlay.webContents.sendInputEvent({ type: "mouseDown", x: 98, y: 18, button: "left", clickCount: 1 });
  overlay.webContents.sendInputEvent({ type: "mouseUp", x: 98, y: 18, button: "left", clickCount: 1 });
}

export async function runVoiceSmoke(input: Input): Promise<Record<string, unknown> & { ok: boolean }> {
  const { appService, grant, view } = input;
  const clip = process.env.MANGA_SMOKE_AUDIO;
  if (!clip || !fs.existsSync(clip)) return { ok: true, notRun: true, reason: "MANGA_SMOKE_AUDIO does not point at a synthetic speech clip" };
  const call = (commandId: string, body: Record<string, unknown>) => appService.call(actor, { commandId, idempotencyKey: createId("smoke"), input: body }, grant);
  const evidence = input.evidenceDir;
  const shotsDir = evidence ? path.join(evidence, "screenshots") : undefined;
  const steps: Array<{ id: string; ok: boolean; detail?: unknown }> = [];
  const observations: Array<{ name: string; status: "passed" | "failed"; detail?: unknown }> = [];
  const record = (id: string, ok: boolean, detail?: unknown) => { steps.push({ id, ok, ...(detail !== undefined ? { detail } : {}) }); console.error(`voice step ${id}: ${ok ? "ok" : "FAILED"} ${JSON.stringify(detail ?? null).slice(0, 1500)}`); return ok; };
  view.showInactive();

  // A stand-in transcription service: it answers every upload, so the pipeline can finish without a network.
  const requests: Array<{ bytes: number; contentType: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ bytes: Buffer.concat(chunks).length, contentType: String(request.headers["content-type"] ?? "").split(";")[0]! });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ text: `合成转写第${requests.length}段` }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  try {
    await call("settings.skipAi", {});
    const secret = appService.stashSecret("smoke-asr-credential");
    const connection = await call("connections.upsert", { label: "smoke-asr", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1`, modelId: "asr-smoke", purpose: "transcription", credentialHandle: secret });
    record("connection", connection.status === "ok", connection.status === "ok" ? undefined : connection.error);
    await call("settings.setRecording", { retention: "keep", overlay: { x: null, y: null } });

    const body = "录音烟测正文。".repeat(40);
    const imported = await call("library.importDocument", { title: "录音烟测书", format: "txt", bytes: [...Buffer.from(body)] });
    const resourceId = String((imported.value as { resourceId?: string } | undefined)?.resourceId ?? "");
    await view.webContents.reload();
    await waitForTestId(view, "nav-home");
    const opened = await openFromShelf(view, "novel", resourceId, 10_000);
    await waitForTestId(view, "reading-body");
    const pane = await ensureDock(view);
    record("open-reader", opened && pane);

    // Start from the microphone in the right pane (there is none in the title bar or the reader), the way a person does.
    const started = Date.now();
    await clickTestId(view, "chat-mic");
    const showing = await until<boolean>(view, `Boolean(document.querySelector('[data-testid="record-indicator"]'))`, 5000);
    const feedbackMs = Date.now() - started;
    record("recording-shown", Boolean(showing), { feedbackMs });
    // The microphone really delivers sound: the level meter moves and the clock runs.
    const level = await until<number>(view, `(() => { const el = document.querySelector('[data-testid="record-level"]'); const v = Number(el?.getAttribute("data-level") ?? el?.getAttribute("aria-valuenow") ?? 0); return v > 0 ? v : null; })()`, 8000);
    const clock1 = await js<string>(view, `document.querySelector('[data-testid="record-time"]')?.textContent ?? ""`);
    await sleep(1200); // real time: 语音录制时长，观察录音计时器跳动
    const clock2 = await js<string>(view, `document.querySelector('[data-testid="record-time"]')?.textContent ?? ""`);
    record("microphone", Boolean(level) && clock1 !== clock2, { level, clock1, clock2 });

    // V1 / AT-172: compact 116×36 pill, speaking color progression, accessible summary without visible device label, and drag persistence.
    const overlay = await waitForOverlay(view, true, 4000);
    record("overlay", Boolean(overlay), { visible: overlay?.isVisible() ?? false });

    let overlayDom: {
      boxWidth: number;
      boxHeight: number;
      visibleText: string;
      ariaLabel: string;
      title: string;
      speakingColor: string;
      stopLabel: string;
    } | null = null;
    let initialBounds: { x: number; y: number; width: number; height: number } | null = null;
    let afterDrag1: { x: number; y: number } | null = null;

    if (overlay) {
      initialBounds = overlay.getBounds();
      // Wait for a speaking frame so the microphone icon shows its primary brand color for inspection and the key screenshot.
      overlayDom = await until(overlay, `(() => {
        const box = document.getElementById("box");
        const mic = document.getElementById("mic");
        const stop = document.getElementById("stop");
        if (!box || !mic || !stop || mic.getAttribute("data-speaking") !== "true") return null;
        const rect = box.getBoundingClientRect();
        return {
          boxWidth: Math.round(rect.width),
          boxHeight: Math.round(rect.height),
          visibleText: (box.textContent || "").trim(),
          ariaLabel: box.getAttribute("aria-label") || "",
          title: box.getAttribute("title") || "",
          speakingColor: mic.getAttribute("data-color") || "",
          stopLabel: stop.getAttribute("aria-label") || "",
        };
      })()`, 5000);
      if (shotsDir) {
        fs.mkdirSync(shotsDir, { recursive: true });
        try { fs.writeFileSync(path.join(shotsDir, "ui-voice-overlay.png"), (await overlay.webContents.capturePage(undefined, { stayAwake: true })).toPNG()); } catch { /* evidence only */ }
      }
      // Drag #1 during recording.
      dragOverlayBy(overlay, -200, 120);
      await sleep(60); // real time: 输入事件派发后等待窗口位置同步
      const moved = overlay.getBounds();
      afterDrag1 = { x: moved.x, y: moved.y };
    }

    // Let the remaining synthetic speech clip play out so the transcription pipeline gets the full utterances.
    const elapsedAlready = Date.now() - started;
    const targetAudioMs = Number(process.env.MANGA_SMOKE_AUDIO_MS ?? 9000);
    if (targetAudioMs > elapsedAlready) {
      await sleep(targetAudioMs - elapsedAlready); // real time: 语音录制时长，等待合成语音样本播放完毕
    }
    const stopped = await clickTestId(view, "record-stop");
    await waitForOverlay(view, false, 5000);
    record("stop", stopped);

    // Wait for the main speech session to finish filtering and transcription.
    let sessionId = "";
    let review: { session?: { stage?: string }; segments?: Array<{ text?: string; anchors?: unknown[] }> } | undefined;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const list = await call("capture.list", { resourceId });
      const latest = (list.value as { sessions?: Array<{ id: string }> } | undefined)?.sessions?.[0];
      if (latest) {
        sessionId = latest.id;
        const reviewed = await call("capture.review", { sessionId });
        review = reviewed.value as typeof review;
        if (review?.session?.stage && TERMINAL.has(review.session.stage)) break;
      }
      await sleep(500); // real time: 后台轮询定时器节流，等待语音转写完成
    }
    const segments = review?.segments ?? [];
    record("session", Boolean(sessionId) && review?.session?.stage === "done", { session: review?.session, segments: segments.length });
    record("transcript", segments.some((segment) => String(segment.text ?? "").includes("合成转写")), { uploads: requests.length, types: [...new Set(requests.map((item) => item.contentType))], bytes: requests.map((item) => item.bytes) });
    record("source", segments.length > 0 && segments.every((segment) => (segment.anchors?.length ?? 0) > 0), { sample: segments[0]?.anchors ?? null });

    // AT-172 reopen #1 (verifies Drag #1 persisted) + Drag #2 + immediate stop (< 50 ms) via overlay stop button + reopen #2.
    let reopen1Pos: { x: number; y: number } | null = null;
    let afterDrag2: { x: number; y: number } | null = null;
    let reopen2Pos: { x: number; y: number } | null = null;
    await clickTestId(view, "chat-mic");
    const overlay2 = await waitForOverlay(view, true, 5000);
    if (overlay2) {
      await until(overlay2, `Boolean(document.getElementById("box")?.getAttribute("aria-label"))`, 3000);
      const b2 = overlay2.getBounds();
      reopen1Pos = { x: b2.x, y: b2.y };
      dragOverlayBy(overlay2, -120, 80);
      const moved2 = overlay2.getBounds();
      afterDrag2 = { x: moved2.x, y: moved2.y };
      // Stop immediately (< 50 ms after dragging) by clicking the overlay's own square stop button!
      clickOverlayStop(overlay2);
      await waitForOverlay(view, false, 5000);
    }

    await until(view, `!document.querySelector('[data-testid="record-indicator"]')`, 5000);
    await clickTestId(view, "chat-mic");
    const overlay3 = await waitForOverlay(view, true, 5000);
    if (overlay3) {
      await until(overlay3, `Boolean(document.getElementById("box")?.getAttribute("aria-label"))`, 3000);
      const b3 = overlay3.getBounds();
      reopen2Pos = { x: b3.x, y: b3.y };
      clickOverlayStop(overlay3);
      await waitForOverlay(view, false, 5000);
    }
    await until(view, `!document.querySelector('[data-testid="record-indicator"]')`, 5000);
    await call("settings.setRecording", { overlay: { x: null, y: null } });

    const expectedDrag1 = initialBounds ? { x: initialBounds.x - 200, y: initialBounds.y + 120 } : null;
    const expectedDrag2 = afterDrag1 ? { x: afterDrag1.x - 120, y: afterDrag1.y + 80 } : null;
    const pillOk = Boolean(
      overlayDom
      && overlayDom.boxWidth === OVERLAY_WIDTH
      && overlayDom.boxHeight === OVERLAY_HEIGHT
      && /^\d+:\d{2}$/.test(overlayDom.visibleText)
      && overlayDom.ariaLabel.includes("，")
      && overlayDom.ariaLabel === overlayDom.title
      && overlayDom.speakingColor !== "#9CA3AF"
      && overlayDom.speakingColor.startsWith("#")
      && overlayDom.stopLabel.length > 0,
    );
    const drag1Persisted = Boolean(expectedDrag1 && afterDrag1 && reopen1Pos && reopen1Pos.x === afterDrag1.x && reopen1Pos.y === afterDrag1.y && afterDrag1.x === expectedDrag1.x && afterDrag1.y === expectedDrag1.y);
    const immediateStopPersisted = Boolean(expectedDrag2 && afterDrag2 && reopen2Pos && reopen2Pos.x === afterDrag2.x && reopen2Pos.y === afterDrag2.y && afterDrag2.x === expectedDrag2.x && afterDrag2.y === expectedDrag2.y);
    const voiceOverlayOk = pillOk && drag1Persisted && immediateStopPersisted;
    const overlayDetail = {
      initialBounds,
      overlayDom: overlayDom ? { ...overlayDom, ariaLabelHasMic: overlayDom.ariaLabel.includes("麦克风："), ariaLabelLength: overlayDom.ariaLabel.length, ariaLabel: "[redacted-device-summary]", title: "[redacted-device-summary]" } : null,
      afterDrag1,
      reopen1Pos,
      afterDrag2,
      reopen2Pos,
      pillOk,
      drag1Persisted,
      immediateStopPersisted,
    };
    record("voice-overlay", voiceOverlayOk, overlayDetail);
    observations.push({ name: "voice-overlay", status: voiceOverlayOk ? "passed" : "failed", detail: overlayDetail });

    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      try { fs.writeFileSync(path.join(evidence, "ui-voice-after.png"), (await view.webContents.capturePage(undefined, { stayAwake: true })).toPNG()); } catch { /* evidence only */ }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
  const failed = steps.filter((step) => !step.ok).map((step) => step.id);
  if (evidence) fs.writeFileSync(path.join(evidence, "voice-smoke.json"), `${JSON.stringify({ steps, observations }, null, 2)}\n`);
  return { ok: failed.length === 0, failed, steps, observations };
}
