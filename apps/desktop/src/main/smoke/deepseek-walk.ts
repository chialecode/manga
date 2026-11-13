import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { clickTestId, openFromShelf, openProjectsPage, PICK, pressKey, setField, sleep, viaSidebar, waitDrawn, waitForTestId, waitUntil } from "./driver.ts";
import { caller, capturePage, ensureDock, js, leaveSettings, openSettingsPage, toRail, type FlowResult } from "./common.ts";
import type { Observation } from "./window-walk.ts";

/**
 * The DeepSeek provider plugin in the packaged window (计划第 7 节, AT-184—AT-191). The plugin comes with the application and the walk installs it from the
 * plugin page; its requests go to the fake DeepSeek the stage script runs on the loopback address (MANGA_SMOKE_PROVIDER_ORIGIN), which accepts only the
 * synthetic key below. What the fake service saw is checked by the stage script after the window has closed: the walk writes when the plugin was off, so
 * the script can see that no request came in that time. The window is muted: reading aloud plays the fake service's tone, and nobody should hear it.
 */

export const SMOKE_DEEPSEEK_KEY = ["sk", "smoke", "deepseek", "walk"].join("-");
const PLUGIN_ID = "manga.provider-deepseek";
const ASR_TEXT = "合成的识别结果";

export type DeepSeekWalkMarks = { disabledFrom: number | null; disabledTo: number | null; chatSentAt: number[] };

export async function runDeepSeekSmoke(input: { appService: MangaProductApp; grant: string; view: BrowserWindow; evidenceDir: string | undefined; logsDir: string }): Promise<FlowResult & { observations: Observation[]; marks: DeepSeekWalkMarks }> {
  const { appService, grant, view, evidenceDir } = input;
  const call = caller(appService, grant);
  const observations: Observation[] = [];
  const marks: DeepSeekWalkMarks = { disabledFrom: null, disabledTo: null, chatSentAt: [] };
  const observe = (name: string, ok: boolean, detail: unknown) => {
    observations.push({ name, status: ok ? "passed" : "failed", detail });
    console.error(`deepseek-walk ${name}: ${ok ? "ok" : "FAILED"} ${JSON.stringify(detail ?? null).slice(0, 700)}`);
    return ok;
  };
  if (!process.env.MANGA_SMOKE_PROVIDER_ORIGIN) return { ok: false, notRun: true, reason: "MANGA_SMOKE_PROVIDER_ORIGIN is needed", observations, marks };
  const present = (testId: string) => `Boolean(${PICK}(${JSON.stringify(testId)}))`;
  const shot = (name: string, mark?: string) => capturePage(view, evidenceDir, `ui-deepseek-${name}.png`, mark);
  view.webContents.setAudioMuted(true);
  await call("settings.skipAi", {});
  await toRail(view);

  // ---- deepseek-plugin, part 1: offered and not installed; installed with its network permission; the models page offers it at once ----
  const pluginDetail: Record<string, unknown> = {};
  const bundled = await call("plugin.bundled", {}) as { status: string; value?: { bundled?: Array<{ id: string; installed?: boolean }> } };
  const offered = (bundled.value?.bundled ?? []).find((item) => item.id === PLUGIN_ID);
  pluginDetail.offeredNotInstalled = Boolean(offered) && offered?.installed !== true;
  const onPlugins = await openSettingsPage(view, "plugins");
  const install = onPlugins && await clickTestId(view, `plugin-bundled-${PLUGIN_ID}-install`, 8000);
  const dialog = install && await waitForTestId(view, "plugin-install-do", "data-present", null, 10_000);
  const dialogText = dialog ? await js<string>(view, `document.querySelector('[role="dialog"]')?.textContent ?? ""`) : "";
  pluginDetail.dialogSaysDeclarative = dialogText.includes("不运行代码");
  await clickTestId(view, "plugin-confirm-network", 3000);
  await js(view, `(() => { const box = document.querySelector('[data-testid="plugin-install-enable"]'); if (box && !box.checked) box.click(); })()`);
  const ready = await waitUntil(view, `document.querySelector('[data-testid="plugin-install-do"]') && !document.querySelector('[data-testid="plugin-install-do"]').disabled`, 4000);
  const installed = ready && await clickTestId(view, "plugin-install-do", 3000) && await waitForTestId(view, `plugin-${PLUGIN_ID}-state`, "data-present", null, 30_000);
  pluginDetail.installed = installed;
  const onModels = await openSettingsPage(view, "models");
  const menu = onModels && await clickTestId(view, "models-add", 4000) && await waitUntil(view, present("models-add-provider-deepseek"), 6000);
  pluginDetail.offeredOnModelsWithoutRestart = menu;

  // ---- deepseek-models: two models and three services from the fake service; a new key; the list by account ----
  const modelsDetail: Record<string, unknown> = {};
  const opened = menu && await clickTestId(view, "models-add-provider-deepseek", 4000) && await waitForTestId(view, "provider-key", "data-present", null, 6000);
  const keyed = opened && await setField(view, "provider-key", SMOKE_DEEPSEEK_KEY);
  const discovered = keyed && await clickTestId(view, "provider-discover", 3000) && await waitForTestId(view, "provider-verified", "data-verified", "yes", 10_000);
  for (const box of ["provider-model-deepseek-flash", "provider-model-deepseek-v4-pro", "provider-service-transcription", "provider-service-speech", "provider-service-search"]) {
    await js(view, `(() => { const input = document.querySelector('[data-testid="${box}"] input'); if (input && !input.checked && !input.disabled) input.click(); })()`);
  }
  const added = discovered && await clickTestId(view, "provider-add", 3000) && await waitUntil(view, `document.querySelector('[data-testid^="account-"][data-available="yes"]')`, 10_000);
  const listed = await call("connections.list", {});
  const connections = (Array.isArray(listed.value) ? listed.value : []) as Array<{ id: string; purpose: string; modelId?: string; profile?: { contextWindow?: number; reasoningLevels?: string[] }; account?: { id: string } | null }>;
  const accountId = connections.find((item) => item.account)?.account?.id ?? "";
  const flash = connections.find((item) => item.modelId === "deepseek-flash");
  modelsDetail.added = added;
  modelsDetail.purposes = connections.map((item) => item.purpose).sort();
  modelsDetail.flashWindow = flash?.profile?.contextWindow ?? null;
  const purposesOk = ["search", "speech", "text", "text", "transcription"].every((purpose, index) => (modelsDetail.purposes as string[])[index] === purpose);
  await shot("models-light", `account-${accountId}`);
  await js(view, `document.documentElement.setAttribute("data-theme", "dark")`);
  await shot("models-dark", `account-${accountId}`);
  await js(view, `document.documentElement.removeAttribute("data-theme")`);
  const rekeyed = accountId !== "" && await clickTestId(view, `account-set-key-${accountId}`, 4000)
    && await waitForTestId(view, "account-key-save", "data-present", null, 4000)
    && await js<boolean>(view, `(() => { const input = document.querySelector('[role="dialog"] input[type="password"]'); if (!input) return false; const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(input, ${JSON.stringify(SMOKE_DEEPSEEK_KEY)}); input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`)
    && await clickTestId(view, "account-key-save", 3000)
    && await waitUntil(view, `!document.querySelector('[data-testid="account-key-save"]')`, 8000);
  modelsDetail.rekeyed = rekeyed;
  observe("deepseek-models", Boolean(added) && purposesOk && flash?.profile?.contextWindow === 1_048_576 && Boolean(rekeyed), modelsDetail);
  // The text model the conversations use is the flash model (the first one added).
  await call("settings.setRecording", { dictationEngine: { kind: "connection", connectionId: connections.find((item) => item.purpose === "transcription")?.id ?? "" }, polishMode: "raw", dictationInsertMode: "stream_replace" });
  await leaveSettings(view);

  // ---- deepseek-chat: a three-step tool loop with the thinking folded above the answer; then 联网搜索 with its progress and sources ----
  const chatDetail: Record<string, unknown> = {};
  const send = async (text: string, wait = 60_000) => {
    await setField(view, "agent-composer", text);
    marks.chatSentAt.push(Date.now());
    const sent = await clickTestId(view, "agent-send");
    const running = sent && await waitForTestId(view, "agent-stop", "data-present", null, 15_000);
    return running && await waitForTestId(view, "agent-send", "data-present", null, wait);
  };
  const onChat = await viaSidebar(view, "conversation", "sidebar-new-conversation", 10_000) && await waitDrawn(view, "page-agent", 8000);
  await clickTestId(view, "chat-mode-ask");
  const looped = onChat && await send("查三次资源库");
  const answered = looped && await waitUntil(view, `document.body.innerText.includes("三步都查完了")`, 10_000);
  const thinking = answered && await waitUntil(view, `document.querySelector('[data-testid^="bubble-thinking-"]')`, 6000);
  const expanded = thinking && await js<boolean>(view, `(() => { const box = document.querySelector('[data-testid^="bubble-thinking-"]'); if (!box) return false; box.querySelector("summary")?.click(); return box.open === true && (box.textContent ?? "").length > 0; })()`);
  chatDetail.loop = { looped, answered, thinking, expanded };
  await shot("chat-thinking", "page-agent");
  const plus = await clickTestId(view, "chat-plus", 4000) && await waitUntil(view, present("chat-plus-websearch"), 4000);
  const ticked = plus && await clickTestId(view, "chat-plus-websearch", 3000) && await waitUntil(view, present("chat-opt-in-websearch"), 4000);
  const searched = ticked && await send("联网搜索一下示例来源");
  const sources = searched && await waitUntil(view, `document.querySelector('[data-testid^="bubble-sources-"]') && document.querySelector('[data-testid^="bubble-sources-"]').textContent.includes("示例来源")`, 10_000);
  const tickCleared = await js<boolean>(view, `!document.querySelector('[data-testid="chat-opt-in-websearch"]')`);
  const followed = sources && await send("刚才的来源是哪个网站？");
  chatDetail.search = { plus, ticked, searched, sources, tickCleared, followed };
  await shot("chat-sources", "page-agent");
  observe("deepseek-chat", Boolean(expanded && sources && tickCleared && followed), chatDetail);

  // ---- read-aloud, part 1: a finished answer read aloud, and stopped ----
  const readDetail: Record<string, unknown> = {};
  const firstAudio = await js<boolean>(view, `(() => { window.__readAloud = []; window.addEventListener("manga-read-aloud", (event) => window.__readAloud.push(event.detail)); return true; })()`);
  const answerId = await js<string>(view, `[...document.querySelectorAll('[data-read-answer]')].at(-1)?.getAttribute("data-read-answer") ?? ""`);
  // The answer is short (a fraction of a second of the fake service's audio): its first sound is what is waited for, then the stop if it still plays.
  const reading = answerId !== "" && firstAudio && await clickTestId(view, `bubble-read-${answerId}`, 4000)
    && await waitUntil(view, `window.__readAloud.some((item) => item.kind === "first-audio" && item.owner.startsWith("answer:"))`, 8000);
  if (reading) await clickTestId(view, `bubble-read-stop-${answerId}`, 1500);
  const stoppedAnswer = reading && await waitUntil(view, present(`bubble-read-${answerId}`), 4000);
  readDetail.answer = { answerId: answerId !== "", reading, stoppedAnswer, events: await js<unknown>(view, `window.__readAloud`) };

  // ---- read-aloud, part 2: a novel read paragraph by paragraph, the pages following; dictation pauses it, and it waits ----
  const paragraphs = Array.from({ length: 24 }, (_, index) => `第${index + 1}段，守夜人记下了第${index + 1}条航线。`);
  const book = await call("library.importDocument", { title: "朗读的合成小说", format: "txt", bytes: [...Buffer.from(paragraphs.join("\n"))] });
  const resourceId = String((book.value as { resourceId?: string } | undefined)?.resourceId ?? "");
  const openedBook = resourceId !== "" && await toRail(view) && await openFromShelf(view, "novel", resourceId, 10_000) && await waitForTestId(view, "reading-body");
  await ensureDock(view);
  const button = openedBook && await waitUntil(view, present("reading-read-aloud"), 6000);
  const asked = button && await clickTestId(view, "reading-read-aloud", 3000) && await waitForTestId(view, "reading-read-cost", "data-present", null, 4000);
  const never = asked && await clickTestId(view, "reading-read-cost-never", 2000);
  const started = never && await clickTestId(view, "reading-read-cost-go", 2000) && await waitUntil(view, `document.querySelector('[data-testid="reading-body"][data-reading-aloud]')`, 8000);
  const markText = () => js<string>(view, `document.querySelector('[data-testid="reading-body"] mark')?.textContent ?? ""`);
  const firstMark = started ? await markText() : "";
  const moved = started && await waitUntil(view, `(document.querySelector('[data-testid="reading-body"] mark')?.textContent ?? "") !== ${JSON.stringify(firstMark)} && (document.querySelector('[data-testid="reading-body"] mark')?.textContent ?? "") !== ""`, 10_000);
  // The mark is on the page shown: the pages follow it.
  const onPage = moved && await js<boolean>(view, `(() => { const mark = document.querySelector('[data-testid="reading-body"] mark'); const clip = document.querySelector('.reader-pages-clip') ?? document.querySelector('[data-testid="reading-scroll"]'); if (!mark || !clip) return false; const a = mark.getBoundingClientRect(), b = clip.getBoundingClientRect(); return a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1; })()`);
  await shot("novel-reading", "reading-page");
  // Dictation into the composer: the reading pauses, the words come from the fake DeepSeek recognition, and the reading stays paused.
  await clickTestId(view, "chat-mode-ask");
  await setField(view, "agent-composer", "");
  const micAt = await js<number>(view, "Math.round(performance.now())");
  const micOn = await clickTestId(view, "chat-mic", 3000);
  const paused = micOn && await waitUntil(view, present("reading-read-resume"), 6000);
  await sleep(1500); // real time: the fake capture device plays speech for the dictation to hear
  await clickTestId(view, "chat-mic", 3000);
  const dictated = micOn && await waitUntil(view, `(${PICK}("agent-composer")?.value ?? "").includes(${JSON.stringify(ASR_TEXT)})`, 20_000);
  await sleep(600); // real time: a reading that went on by itself would show its pause button again by now
  const stillPaused = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="reading-read-resume"]'))`);
  const afterDictation = await js<string[]>(view, `["reading-read-aloud", "reading-read-pause", "reading-read-resume", "reading-read-position", "reading-body"].filter((id) => document.querySelector('[data-testid="' + id + '"]'))`);
  observe("dictation-deepseek", Boolean(dictated), { micOn, dictated });
  const stopped = await clickTestId(view, "reading-read-stop", 3000) && await waitUntil(view, present("reading-read-position"), 4000);
  const kept = stopped && await clickTestId(view, "reading-read-keep", 2000) && await waitUntil(view, `!document.querySelector('[data-testid="reading-read-position"]')`, 3000);
  const recording = await call("settings.getRecording", {});
  const hintOff = (recording.value as { novelCostHint?: boolean } | undefined)?.novelCostHint === false;
  readDetail.novel = { openedBook, asked, started, moved, onPage, paused, stillPaused, afterDictation, micAt, stopped, kept, hintOff, events: await js<unknown>(view, `window.__readAloud`) };
  await setField(view, "agent-composer", "");
  observe("read-aloud", Boolean(stoppedAnswer && moved && onPage && paused && stillPaused && kept && hintOff), readDetail);

  // ---- web-search: the research tab searches the web through the search service ----
  const webDetail: Record<string, unknown> = {};
  const project = await call("project.create", { name: "网页搜索项目" });
  const projectId = String((project.value as { projectId?: string; id?: string } | undefined)?.projectId ?? (project.value as { id?: string } | undefined)?.id ?? "");
  webDetail.project = project.status;
  const onProjects = projectId !== "" && await toRail(view) && await openProjectsPage(view) && await clickTestId(view, `project-open-${projectId}`, 6000);
  const inProject = onProjects ? await waitForTestId(view, "page-project", "data-project", projectId, 8000) : false;
  const onResearch = inProject && await clickTestId(view, "project-tab-excerpt", 4000) && await waitForTestId(view, "research-tab", "data-testid", "research-tab", 10_000);
  const panel = onResearch && await waitUntil(view, present("research-web-query"), 6000);
  const typed = panel && await setField(view, "research-web-query", "合成的查询");
  const results = typed && await clickTestId(view, "research-web-go", 3000) && await waitUntil(view, `document.querySelectorAll('[data-testid="research-web-result"]').length > 0`, 8000);
  webDetail.panel = { onProjects, inProject, onResearch, panel, results };
  await shot("research-web", "research-web");
  observe("web-search", Boolean(results), webDetail);

  // ---- deepseek-plugin, part 2: turned off, the account says so and a task with its model is refused without a request; turned on again ----
  const onPluginsAgain = await openSettingsPage(view, "plugins");
  marks.disabledFrom = Date.now();
  const off = onPluginsAgain && await clickTestId(view, `plugin-${PLUGIN_ID}-toggle`, 4000)
    && await waitUntil(view, `(document.querySelector('[data-testid="plugin-${PLUGIN_ID}-toggle"]')?.textContent || "").includes("启用")`, 15_000);
  const flagged = off && await openSettingsPage(view, "models") && await waitUntil(view, present(`account-disabled-${accountId}`), 6000);
  await leaveSettings(view);
  const backToChat = await viaSidebar(view, "conversation", "sidebar-new-conversation", 10_000) && await waitDrawn(view, "page-agent", 8000);
  await clickTestId(view, "chat-mode-ask");
  await setField(view, "agent-composer", "插件停用后再问一次");
  await clickTestId(view, "agent-send");
  const refused = backToChat && await waitUntil(view, `document.body.innerText.includes("插件已停用")`, 15_000);
  await sleep(300); // real time: anything that would still go out has gone by now
  marks.disabledTo = Date.now();
  const onAgain = await openSettingsPage(view, "plugins") && await clickTestId(view, `plugin-${PLUGIN_ID}-toggle`, 4000)
    && await waitUntil(view, `(document.querySelector('[data-testid="plugin-${PLUGIN_ID}-toggle"]')?.textContent || "").includes("停用")`, 15_000);
  const restored = onAgain && await openSettingsPage(view, "models") && await waitUntil(view, `!document.querySelector('[data-testid="account-disabled-${accountId}"]')`, 6000);
  const probed = restored && Boolean(flash?.id) && await clickTestId(view, `connection-probe-${flash!.id}`, 4000)
    && await waitForTestId(view, `connection-test-${flash!.id}`, "data-state", "ok", 15_000);
  await leaveSettings(view);
  Object.assign(pluginDetail, { off, flagged, refused, onAgain, restored, probed });
  observe("deepseek-plugin", Boolean(pluginDetail.offeredNotInstalled && pluginDetail.dialogSaysDeclarative && installed && menu && off && flagged && refused && restored && probed), pluginDetail);

  await pressKey(view, "Escape").catch(() => undefined);
  return { ok: observations.every((row) => row.status === "passed"), observations, marks };
}
