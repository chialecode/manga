import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { startMockProvider } from "@manga/model-protocol";
import { clickTestId, sleep, viaSidebar, waitUntil } from "./driver.ts";
import { capturePage, js, toRail, type caller } from "./common.ts";

/**
 * `agent-media-native` and `agent-media-retain` (计划第 7 节, AT-144—AT-146) in the packaged application: its own FFmpeg cuts the clips, its own
 * database keeps the stills, and stand-in models on the loopback address show what was sent. The window shows a run's record with the reasons and an
 * expired still's placeholder. Synthetic samples only; nothing leaves the machine.
 */

type Call = ReturnType<typeof caller>;
type Seen = { url: string; body: Record<string, unknown> };
type Note = { kind: string; reason?: string; bytes?: number; pages?: number; seconds?: number };
const DAY = 86_400_000;

const ok = async <T>(call: Call, commandId: string, input: Record<string, unknown>): Promise<T> => {
  const result = await call(commandId, input);
  if (result.status !== "ok") throw new Error(`${commandId}: ${JSON.stringify(result.error ?? null).slice(0, 300)}`);
  return result.value as T;
};
const asked = (seen: Seen[]) => seen.filter((request) => !JSON.stringify(request.body).includes("Reply with one word"));
const pdfParts = (request: Seen) => JSON.stringify(request.body).match(/"input_file"|"type":"file"/g)?.length ?? 0;
const hasVideo = (request: Seen) => /data:video\/mp4;base64,/.test(JSON.stringify(request.body));
const hasImage = (request: Seen) => JSON.stringify(request.body).includes("image_url") || JSON.stringify(request.body).includes("input_image");

function sample(root: string | undefined, id: string): string | null {
  if (!root) return null;
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as { samples: Array<{ id: string; path: string; status: string }> };
  const entry = manifest.samples.find((item) => item.id === id && item.status === "generated");
  return entry ? path.join(root, entry.path) : null;
}

export async function waitRun(call: Call, runId: string): Promise<string> {
  for (let waited = 0; waited < 60_000; waited += 200) {
    const got = await call("agent.getRun", { runId });
    const status = String((got.value as { status?: string } | undefined)?.status ?? "");
    if (got.status === "ok" && !["queued", "running", "waiting_input"].includes(status)) return status;
    await sleep(200); // real time: 后台轮询定时器节流，等待模型任务流式完成
  }
  return "timeout";
}

export async function runMediaObservations(input: { appService: MangaProductApp; call: Call; view: BrowserWindow; evidenceDir: string | undefined; samples: string | undefined; observe: (name: string, ok: boolean, detail: unknown) => boolean }): Promise<void> {
  const { appService, call, view, evidenceDir, observe } = input;
  const pdf = sample(input.samples, "comic-pdf-images");
  const mp4 = sample(input.samples, "video-mp4-h264-aac");
  const cbz = sample(input.samples, "cbz-basic");
  if (!pdf || !mp4 || !cbz) {
    observe("agent-media-native", false, { problems: ["the synthetic PDF, video or comic sample is missing"] });
    observe("agent-media-retain", false, { problems: ["the synthetic PDF, video or comic sample is missing"] });
    return;
  }
  // Copies of their own in a library folder, so changing a file later leaves the shared samples alone.
  const dir = fs.mkdtempSync(path.join(appService.layout.partitions.logs, "manga-package-loop-media-"));
  for (const [from, name] of [[pdf, "整本.pdf"], [mp4, "片段.mp4"], [cbz, "有图.cbz"]] as const) fs.copyFileSync(from, path.join(dir, name));
  await ok(call, "library.paths.add", { pathHandle: appService.registerPath("directory", dir), mediaKind: "comic", autoScan: false });
  const importAs = (name: string, kind: "comic" | "video", title: string) => ok<{ resourceId: string; revisionId: string }>(call, "library.importDocument", { title, kind, pathHandle: appService.registerPath("file", path.join(dir, name)) });
  const book = await importAs("整本.pdf", "comic", "整本的漫画");
  const video = await importAs("片段.mp4", "video", "一段动画");
  const comic = await importAs("有图.cbz", "comic", "有图的漫画");
  await ok(call, "settings.setShell", { spoilerGuard: false });
  const seen: Seen[] = [];
  const server = await startMockProvider({ onRequest: (request) => { seen.push(request as Seen); } });
  const sessionId = (await ok<{ id: string }>(call, "agent.createSession", { title: "原生输入" })).id;

  /** One model at a time: the stand-in with this protocol, input types and runtime is the only text connection. */
  const useModel = async (protocol: "openai-chat-completions" | "openai-responses", inputTypes: string[], runtime: "native" | "pi") => {
    for (const row of (await ok<Array<{ id: string }>>(call, "connections.list", {}))) await ok(call, "connections.delete", { connectionId: row.id });
    const id = (await ok<{ id: string }>(call, "connections.upsert", { label: "原生输入", protocol, baseUrl: server.url, modelId: "m", purpose: "text", credentialHandle: appService.stashSecret("smoke-native-key") })).id;
    for (const capability of ["text", "vision"]) await call("connections.test", { connectionId: id, capability });
    await ok(call, "connections.setProfile", { connectionId: id, profile: { inputTypes } });
    await ok(call, "settings.setRuntime", { runtime });
    return id;
  };
  const ask = async (extra: Record<string, unknown>) => {
    const before = seen.length;
    const sent = await ok<{ runId: string }>(call, "agent.send", { sessionId, text: "这里讲了什么？", ...extra });
    const status = await waitRun(call, sent.runId);
    const entries = (await ok<{ entries: Array<{ kind: string; delivery: Note[] | null; requestText?: string }> }>(call, "agent.trace.list", { runId: sent.runId })).entries;
    const delivery = entries.filter((entry) => entry.kind === "model").at(-1)?.delivery ?? [];
    return { runId: sent.runId, status, requests: asked(seen.slice(before)), delivery, record: JSON.stringify(entries) };
  };

  // ---- agent-media-native ----
  const problems: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const models = [
    { name: "chat, PDF and video", protocol: "openai-chat-completions", types: ["text", "image", "pdf", "video"], runtime: "native", pdf: "file", video: "video" },
    { name: "responses, PDF only", protocol: "openai-responses", types: ["text", "image", "pdf"], runtime: "native", pdf: "file", video: "frames" },
    { name: "neither", protocol: "openai-chat-completions", types: ["text", "image"], runtime: "native", pdf: "text", video: "frames" },
    { name: "pi runtime", protocol: "openai-chat-completions", types: ["text", "image", "pdf", "video"], runtime: "pi", pdf: "text", video: "frames" },
  ] as const;
  const range = { positionMs: 4000, interval: { startMs: 1000, endMs: 4000 } };
  let traceRun: string | null = null;
  try {
    for (const model of models) {
      await useModel(model.protocol, [...model.types], model.runtime);
      const withPdf = await ask({ readResourceIds: [book.resourceId] });
      const withVideo = await ask({ mediaContext: { video: { resourceId: video.resourceId, resourceRevisionId: video.revisionId, ...range } } });
      const pdfSent = withPdf.requests.some((request) => pdfParts(request) > 0);
      const videoSent = withVideo.requests.some(hasVideo);
      const framesSent = withVideo.requests.some(hasImage);
      const pdfNote = withPdf.delivery[0];
      const videoNote = withVideo.delivery[0];
      rows.push({ model: model.name, pdf: { status: withPdf.status, sent: pdfSent, note: pdfNote }, video: { status: withVideo.status, sent: videoSent, frames: framesSent, note: videoNote } });
      if (withPdf.status !== "succeeded" || withVideo.status !== "succeeded") problems.push(`${model.name}: a task did not succeed (${withPdf.status}, ${withVideo.status})`);
      if ((model.pdf === "file") !== pdfSent || pdfNote?.kind !== model.pdf) problems.push(`${model.name}: the PDF went as ${pdfSent ? "a file" : "text"} (${pdfNote?.kind}), not as ${model.pdf}`);
      if (model.pdf === "text" && !pdfNote?.reason) problems.push(`${model.name}: the PDF went as text without a reason`);
      if (model.video === "video") {
        if (!videoSent || videoNote?.kind !== "video" || videoNote.seconds !== 3) problems.push(`${model.name}: the clip of 1—4 s was not sent (${JSON.stringify(videoNote)})`);
        const clip = (await ok<{ media?: { clip?: { startMs: number; endMs: number } } }>(call, "agent.getRun", { runId: withVideo.runId })).media?.clip;
        if (!clip || clip.startMs !== 1000 || clip.endMs > 4000) problems.push(`${model.name}: the clip covers ${JSON.stringify(clip)}, past the position`);
        traceRun = withVideo.runId;
      } else if (videoSent || videoNote?.kind !== "frames" || !videoNote.reason) problems.push(`${model.name}: the video did not go as frames with a reason (${JSON.stringify(videoNote)})`);
      // The record names the kind, size and reason, never the content.
      for (const record of [withPdf.record, withVideo.record]) if (/data:(application\/pdf|video\/mp4);base64/.test(record)) problems.push(`${model.name}: the call record holds the file's content`);
    }
    // Over the limits: the smallest limits the profile allows are still above the synthetic samples, so the bigger file (over 20 MiB) is made here.
    await useModel("openai-chat-completions", ["text", "image", "pdf", "video"], "native");
    const big = path.join(dir, "很大的一本.pdf");
    fs.writeFileSync(big, Buffer.concat([fs.readFileSync(path.join(dir, "整本.pdf")), Buffer.alloc(21 * 1024 * 1024, 0x20)]));
    const large = await importAs("很大的一本.pdf", "comic", "很大的一本");
    const overPdf = await ask({ readResourceIds: [large.resourceId] });
    const longClip = await ask({ mediaContext: { video: { resourceId: video.resourceId, resourceRevisionId: video.revisionId, positionMs: 4000, interval: { startMs: 0, endMs: 4000 } } } });
    rows.push({ over: { pdf: overPdf.delivery[0], clip: longClip.delivery[0] } });
    if (overPdf.delivery[0]?.reason !== "over-size-limit" || overPdf.requests.some((request) => pdfParts(request) > 0)) problems.push(`a PDF over the size limit was not kept back with its reason (${JSON.stringify(overPdf.delivery[0])})`);
  } catch (error) {
    problems.push(`the walk stopped: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The record in the window: the reasons are listed with the kind and size.
  if (traceRun) {
    const shown = await showTrace(view, sessionId, traceRun);
    rows.push({ traceShown: shown });
    if (shown !== true) problems.push(`the run's record did not show what was sent: ${shown === false ? "no line" : shown}`);
  }
  observe("agent-media-native", problems.length === 0, { rows, problems });

  // ---- agent-media-retain ----
  const keep: string[] = [];
  const detail: Record<string, unknown> = {};
  try {
    await useModel("openai-chat-completions", ["text", "image"], "native");
    const pages = await ok<{ pages: Array<{ id: string }> }>(call, "comic.pages", { resourceId: comic.resourceId });
    const still = await ok<{ materialId: string; base64: string }>(call, "material.region", { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: pages.pages[1]!.id, region: { x: 0, y: 0, width: 0.5, height: 0.5 } });
    const first = await ask({ imageMaterialIds: [still.materialId] });
    const second = await ask({ imageMaterialIds: [still.materialId] });
    const count = (table: string) => appService.store.sqlite.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get() as number;
    const sqlite = appService.store.sqlite;
    const shared = sqlite.prepare("SELECT COUNT(DISTINCT hash) FROM agent_run_media WHERE run_id IN (?, ?)").pluck().get(first.runId, second.runId) as number;
    detail.kept = { media: count("agent_media"), refs: count("agent_run_media"), shared };
    if (shared !== 1) keep.push(`the two runs refer to ${shared} pictures, not one`);
    // The clock moved past the retention period, and the clean-up run: both runs' stills expire and the shared row goes.
    const swept = appService.sweepAgentMedia(Date.now() + 40 * DAY);
    const left = sqlite.prepare("SELECT COUNT(*) FROM agent_run_media WHERE run_id IN (?, ?)").pluck().get(first.runId, second.runId) as number;
    const receipt = await ok<{ media?: { images?: Array<{ expired?: boolean; width?: number; height?: number }> } }>(call, "agent.getRun", { runId: first.runId });
    detail.swept = { swept, left, expired: receipt.media?.images?.[0] };
    if (left !== 0 || receipt.media?.images?.[0]?.expired !== true) keep.push("the stills did not expire after the period");
    if ((sqlite.prepare("SELECT COUNT(*) FROM agent_media WHERE hash IN (SELECT hash FROM agent_run_media)").pluck().get() as number) !== count("agent_media")) keep.push("a picture nothing refers to was kept");
    // The window: the run's record shows the placeholder with the source and the size.
    detail.placeholder = await showExpired(view, sessionId, first.runId, evidenceDir);
    if (!detail.placeholder) keep.push("the record did not show the expired still's placeholder");
    // A retry takes the still again from the unchanged source.
    sqlite.prepare("UPDATE agent_runs SET status = 'failed' WHERE id = ?").run(first.runId);
    const before = seen.length;
    await ok(call, "agent.retry", { runId: first.runId });
    const retried = await waitRun(call, first.runId);
    const entries = (await ok<{ entries: Array<{ kind: string; delivery: Note[] | null }> }>(call, "agent.trace.list", { runId: first.runId })).entries;
    const note = entries.filter((entry) => entry.kind === "model" && entry.delivery).at(-1)?.delivery?.[0];
    detail.retry = { status: retried, note, images: asked(seen.slice(before)).filter(hasImage).length };
    if (retried !== "succeeded" || note?.reason !== "expired-reextracted") keep.push(`a retry after the period did not take the still again from its source (${retried}, ${JSON.stringify(note)})`);
    // The source changes: a retry of the other run stops and says why, and sends no other picture.
    sqlite.prepare("UPDATE agent_runs SET status = 'failed' WHERE id = ?").run(second.runId);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, "有图.cbz"), later, later);
    const beforeChanged = seen.length;
    await ok(call, "agent.retry", { runId: second.runId });
    const stopped = await waitRun(call, second.runId);
    const error = JSON.parse(String(sqlite.prepare("SELECT error_json FROM agent_runs WHERE id = ?").pluck().get(second.runId) ?? "null")) as { code?: string; message?: string; details?: { reason?: string } } | null;
    detail.changed = { status: stopped, code: error?.code, reason: error?.details?.reason, images: asked(seen.slice(beforeChanged)).filter(hasImage).length };
    if (stopped !== "failed" || error?.details?.reason !== "media-source-changed" || !String(error?.message ?? "").includes("重新发起任务")) keep.push("a retry after the source changed did not stop with the reason");
    if (asked(seen.slice(beforeChanged)).some(hasImage)) keep.push("a retry after the source changed sent a picture");
  } catch (error) {
    keep.push(`the walk stopped: ${error instanceof Error ? error.message : String(error)}`);
  }
  observe("agent-media-retain", keep.length === 0, { ...detail, problems: keep });
  await server.close();
  for (const row of (await ok<Array<{ id: string }>>(call, "connections.list", {}))) await call("connections.delete", { connectionId: row.id });
}

/** The record of a run, opened the way a person opens it: the conversation from the conversations' view, then the reply's "view the record". */
export async function openTrace(view: BrowserWindow, sessionId: string, runId: string): Promise<boolean> {
  return (await openTraceStep(view, sessionId, runId)) === "open";
}

/** "open", or the step at which the record did not open. */
async function openTraceStep(view: BrowserWindow, sessionId: string, runId: string): Promise<string> {
  await js(view, `document.querySelector('[data-testid="trace-dialog"]') && document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  await view.webContents.reload();
  await toRail(view);
  if (!(await viaSidebar(view, "conversation", `session-open-${sessionId}`, 8000))) return "the conversation did not open from the sidebar";
  const link = `bubble-trace-${runId}:agent`;
  // The list draws only the rows near the viewport: an older run is scrolled to, a screen at a time, as a person would.
  let found = await waitUntil(view, `document.querySelector('[data-testid="${link}"]')`, 6000);
  for (let screen = 0; !found && screen < 60; screen += 1) {
    await js(view, `(() => { const s = [...document.querySelectorAll('[data-testid="chat-log"]')].map((log) => log.firstElementChild).find((el) => el && el.clientHeight > 0 && el.querySelector('[data-testid^="bubble-"]')); if (!s) return false; s.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true })); s.scrollTop = Math.max(0, s.scrollTop - s.clientHeight * 0.8); return true; })()`);
    found = await waitUntil(view, `document.querySelector('[data-testid="${link}"]')`, 400);
  }
  if (!found) return `no ${link} in the page`;
  // The virtualizer can remove the row between finding it and the next renderer task. Look up and click in the same task, waiting again if it moved.
  if (!(await clickTestId(view, link, 6000))) return `the ${link} button moved out of the page before it could be clicked`;
  return (await waitUntil(view, `document.querySelector('[data-testid="trace-dialog"]')`, 6000)) ? "open" : "the record dialog did not open";
}

async function showTrace(view: BrowserWindow, sessionId: string, runId: string): Promise<boolean | string> {
  const step = await openTraceStep(view, sessionId, runId);
  if (step !== "open") return step;
  // The delivery is on the model call (the last one of the run), not on the first entry of the list.
  await waitUntil(view, `document.querySelector('[data-testid^="trace-item-"][data-kind="model"]')`, 6000);
  await js(view, `[...document.querySelectorAll('[data-testid^="trace-item-"][data-kind="model"]')].at(-1)?.click(); true`);
  const listed = await waitUntil(view, `document.querySelector('[data-testid="trace-delivery"][data-kind="video"]')`, 6000)
    || `no video line; entries ${await js<string>(view, `JSON.stringify([...document.querySelectorAll('[data-testid^="trace-item-"]')].map((el) => [el.getAttribute("data-kind"), el.getAttribute("aria-current")]))`)}, lines ${await js<number>(view, `document.querySelectorAll('[data-testid="trace-delivery"]').length`)}`;
  await js(view, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  return listed;
}

async function showExpired(view: BrowserWindow, sessionId: string, runId: string, evidenceDir: string | undefined): Promise<boolean> {
  if (!(await openTrace(view, sessionId, runId))) return false;
  const shown = await waitUntil(view, `document.querySelector('[data-testid="trace-image-expired"]')`, 6000);
  if (shown) await capturePage(view, evidenceDir, "ui-expired-still.png");
  await js(view, `document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true`);
  return shown;
}
