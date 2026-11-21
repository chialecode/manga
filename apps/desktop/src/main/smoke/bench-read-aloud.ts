import fs from "node:fs";
import path from "node:path";
import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { clickTestId, openFromShelf, setField, viaSidebar, waitDrawn, waitForTestId, waitUntil } from "./driver.ts";
import { caller, ensureDock, js, toRail } from "./common.ts";
import { SMOKE_DEEPSEEK_KEY } from "./deepseek-walk.ts";

/**
 * The read-aloud figures (计划第 7 节, T1), in the packaged window against the fake DeepSeek on the loopback address (no network):
 * - `ttsFirstAudioMs`: an answer's 朗读 clicked, to the first block of audio handed to the playback (the controller's own clock, which starts in the click);
 *   every answer is a different text, so none comes from the cache;
 * - `readAloudGapMs`: a novel read paragraph by paragraph, the silence at each boundary (0 when the next paragraph was there before the one before ended).
 * The window is muted. The spec (MANGA_SMOKE_READ_ALOUD_SPEC) says how many answers and paragraphs.
 */
export type ReadAloudBenchSpec = { answers: number; paragraphs: number };
export type ReadAloudBenchResult = { ok: boolean; firstAudioMs: number[]; gapMs: number[]; failures: string[] };

export async function measureReadAloudBench(appService: MangaProductApp, grant: string, view: BrowserWindow, spec: ReadAloudBenchSpec): Promise<ReadAloudBenchResult> {
  const call = caller(appService, grant);
  const failures: string[] = [];
  const firstAudioMs: number[] = [];
  const gapMs: number[] = [];
  view.webContents.setAudioMuted(true);
  await call("settings.skipAi", {});
  const installed = await call("plugin.install", { bundledId: "manga.provider-deepseek", grant: ["network"], enable: true });
  if (installed.status !== "ok") failures.push(`the plugin did not install: ${JSON.stringify(installed.error ?? null)}`);
  const added = await call("providers.add", { providerRef: "manga.provider-deepseek/deepseek", credentialHandle: appService.stashSecret(SMOKE_DEEPSEEK_KEY), models: ["deepseek-flash"], services: ["speech"], verified: false });
  if (added.status !== "ok") failures.push(`the models were not added: ${JSON.stringify(added.error ?? null)}`);
  await call("settings.setRecording", { novelCostHint: false });
  await view.webContents.reload();
  await toRail(view);
  await js(view, `(() => { window.__readAloud = []; window.addEventListener("manga-read-aloud", (event) => window.__readAloud.push(event.detail)); return true; })()`);
  const events = () => js<Array<{ kind: string; ms: number; owner: string }>>(view, `window.__readAloud`);

  // ---- answers ----
  const onChat = await viaSidebar(view, "conversation", "sidebar-new-conversation", 10_000) && await waitDrawn(view, "page-agent", 8000);
  if (!onChat) failures.push("the conversation did not open");
  await clickTestId(view, "chat-mode-ask");
  // Each answer is read aloud as soon as it is there: the conversation draws only the bubbles in view, so a long list would hide the earlier ones.
  const read: string[] = [];
  for (let index = 0; index < spec.answers && onChat; index += 1) {
    await setField(view, "agent-composer", `第 ${index + 1} 个问题`);
    await clickTestId(view, "agent-send");
    await waitForTestId(view, "agent-stop", "data-present", null, 15_000);
    if (!await waitForTestId(view, "agent-send", "data-present", null, 60_000)) { failures.push(`answer ${index + 1} did not finish`); break; }
    // A bubble whose controls changed may leave the log off its bottom; the new answer is then below the drawn rows, as for a user, who goes down first.
    if (await js<boolean>(view, `Boolean(document.querySelector('[data-testid="chat-scroll-bottom"]'))`)) {
      await clickTestId(view, "chat-scroll-bottom", 2000);
      await waitUntil(view, `!document.querySelector('[data-testid="chat-scroll-bottom"]')`, 3000);
    }
    const id = await waitUntil(view, `[...document.querySelectorAll('[data-read-answer]')].some((el) => !${JSON.stringify(read)}.includes(el.getAttribute("data-read-answer")))`, 4000)
      && await js<string | null>(view, `(() => { const all = [...document.querySelectorAll('[data-read-answer]')].map((el) => el.getAttribute("data-read-answer")); return all.find((item) => !${JSON.stringify(read)}.includes(item)) ?? null; })()`);
    if (!id) { failures.push(`answer ${index + 1} cannot be read aloud`); continue; }
    read.push(id);
    const before = (await events()).length;
    const clicked = await clickTestId(view, `bubble-read-${id}`, 4000);
    const heard = clicked && await waitUntil(view, `window.__readAloud.length > ${before} && window.__readAloud.slice(${before}).some((item) => item.kind === "first-audio")`, 8000);
    const first = heard ? (await events()).slice(before).find((item) => item.kind === "first-audio") : undefined;
    if (first) firstAudioMs.push(first.ms); else failures.push(`answer ${id} gave no audio`);
    await clickTestId(view, `bubble-read-stop-${id}`, 3000);
    await waitUntil(view, `Boolean(document.querySelector('[data-testid="bubble-read-${id}"]'))`, 4000);
  }
  if (read.length < spec.answers) failures.push(`${read.length} answers were read aloud, ${spec.answers} were asked`);

  // ---- a novel ----
  const paragraphs = Array.from({ length: spec.paragraphs }, (_, index) => `第${index + 1}段，灯塔亮起。`);
  const book = await call("library.importDocument", { title: "朗读基准的合成小说", format: "txt", bytes: [...Buffer.from(paragraphs.join("\n"))] });
  const resourceId = String((book.value as { resourceId?: string } | undefined)?.resourceId ?? "");
  const opened = resourceId !== "" && await toRail(view) && await openFromShelf(view, "novel", resourceId, 10_000) && await waitForTestId(view, "reading-body");
  await ensureDock(view);
  const before = (await events()).length;
  const started = opened && await clickTestId(view, "reading-read-aloud", 4000) && await waitUntil(view, `document.querySelector('[data-testid="reading-body"][data-reading-aloud]')`, 8000);
  if (!started) failures.push("the novel's reading did not start");
  // The reading ends by itself after the last paragraph (each about half a second of the fake service's audio).
  const ended = started && await waitUntil(view, `Boolean(document.querySelector('[data-testid="reading-read-aloud"]')) && !document.querySelector('[data-testid="reading-body"][data-reading-aloud]')`, spec.paragraphs * 2000 + 10_000);
  if (!ended) failures.push("the novel's reading did not come to its end");
  for (const item of (await events()).slice(before)) if (item.kind === "gap") gapMs.push(item.ms);
  if (gapMs.length < spec.paragraphs - 1) failures.push(`${gapMs.length} boundaries measured, ${spec.paragraphs - 1} expected`);
  return { ok: failures.length === 0, firstAudioMs, gapMs, failures };
}

/** The phase's entry: measured, then written where the bench script reads it. */
export async function runReadAloudBench(appService: MangaProductApp, grant: string, view: BrowserWindow, logsDir: string): Promise<boolean> {
  const spec = JSON.parse(fs.readFileSync(String(process.env.MANGA_SMOKE_READ_ALOUD_SPEC), "utf8")) as ReadAloudBenchSpec;
  const measured = await measureReadAloudBench(appService, grant, view, spec).catch((error: unknown) => ({ ok: false, firstAudioMs: [], gapMs: [], failures: [error instanceof Error ? error.message : String(error)] }));
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, "bench-read-aloud-window.json"), `${JSON.stringify(measured, null, 2)}\n`);
  return measured.ok;
}
