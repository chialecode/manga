import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { BrowserWindow } from "electron";
import { MangaProductApp } from "@manga/app-core";
import { createId } from "@manga/contracts";
import { clickTestId, openFromShelf, sleep, waitForTestId } from "./driver.ts";
import { ensureRightPane } from "./common.ts";

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

export async function runVoiceSmoke(input: Input): Promise<Record<string, unknown> & { ok: boolean }> {
  const { appService, grant, view } = input;
  const clip = process.env.MANGA_SMOKE_AUDIO;
  if (!clip || !fs.existsSync(clip)) return { ok: true, notRun: true, reason: "MANGA_SMOKE_AUDIO does not point at a synthetic speech clip" };
  const call = (commandId: string, body: Record<string, unknown>) => appService.call(actor, { commandId, idempotencyKey: createId("smoke"), input: body }, grant);
  const evidence = input.evidenceDir;
  const steps: Array<{ id: string; ok: boolean; detail?: unknown }> = [];
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
    await call("settings.setRecording", { retention: "keep" });

    const body = "录音烟测正文。".repeat(40);
    const imported = await call("library.importDocument", { title: "录音烟测书", format: "txt", bytes: [...Buffer.from(body)] });
    const resourceId = String((imported.value as { resourceId?: string } | undefined)?.resourceId ?? "");
    await view.webContents.reload();
    await waitForTestId(view, "nav-reading");
    const opened = await openFromShelf(view, "nav-reading", resourceId, 10_000);
    await waitForTestId(view, "reading-body");
    const pane = await ensureRightPane(view);
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
    await sleep(1500);
    const clock2 = await js<string>(view, `document.querySelector('[data-testid="record-time"]')?.textContent ?? ""`);
    record("microphone", Boolean(level) && clock1 !== clock2, { level, clock1, clock2 });

    // While the app window is behind others the floating box shows the same recording.
    await sleep(500);
    const windows = BrowserWindow.getAllWindows().filter((window) => window !== view && !window.isDestroyed());
    const overlay = windows.find((window) => window.isAlwaysOnTop());
    record("overlay", Boolean(overlay), { windows: windows.length, visible: overlay?.isVisible() ?? false });
    if (overlay && evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      try { fs.writeFileSync(path.join(evidence, "ui-voice-overlay.png"), (await overlay.webContents.capturePage(undefined, { stayAwake: true })).toPNG()); } catch { /* evidence only */ }
    }

    // The clip is a few seconds long; let it play out, then stop.
    await sleep(Number(process.env.MANGA_SMOKE_AUDIO_MS ?? 9000));
    // The title bar's recording indicator is the stop button too.
    const stopped = await clickTestId(view, "record-stop");
    record("stop", stopped);

    // The session is saved and goes through filtering and transcription without a model for anything but the stand-in.
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
      await sleep(500);
    }
    const segments = review?.segments ?? [];
    record("session", Boolean(sessionId) && review?.session?.stage === "done", { session: review?.session, segments: segments.length });
    record("transcript", segments.some((segment) => String(segment.text ?? "").includes("合成转写")), { uploads: requests.length, types: [...new Set(requests.map((item) => item.contentType))], bytes: requests.map((item) => item.bytes) });
    record("source", segments.length > 0 && segments.every((segment) => (segment.anchors?.length ?? 0) > 0), { sample: segments[0]?.anchors ?? null });
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      try { fs.writeFileSync(path.join(evidence, "ui-voice-after.png"), (await view.webContents.capturePage(undefined, { stayAwake: true })).toPNG()); } catch { /* evidence only */ }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  }
  const failed = steps.filter((step) => !step.ok).map((step) => step.id);
  if (evidence) fs.writeFileSync(path.join(evidence, "voice-smoke.json"), `${JSON.stringify({ steps }, null, 2)}\n`);
  return { ok: failed.length === 0, failed, steps };
}
