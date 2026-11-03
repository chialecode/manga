import fs from "node:fs";
import path from "node:path";
import { clipboard, type BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { startMockProvider } from "@manga/model-protocol";
import { clickTestId, ensureSidebar, pressKey, railTo, setField, sleep, trustedClick, viaSidebar, waitDrawn, waitForTestId, waitUntil } from "./driver.ts";
import { caller, capturePage, js, toRail, type FlowResult } from "./common.ts";

/**
 * AT-97 in the real window. A task is sent from the chat page to a stand-in model on the loopback address that calls a tool and then answers; the reply's
 * "view the record" opens the timeline with a request, a tool call and a request, each with its time, tokens and what was sent. The credential the
 * connection holds, the headers a request is signed with and the path of a file never show in the dialog, in the copy the person takes, or in the logs.
 * Nothing leaves the machine.
 */

export type TraceObservation = { name: string; status: "passed" | "failed"; detail: unknown };

// A key, a token and a path of the shapes that must never be recorded. They are put together here so that no line of the repository holds one.
const KEY = ["sk", "smoke-trace-credential-0123456789"].join("-");
const TOKEN_IN_WORDS = ["sk", "abcdefghijklmnop123456789"].join("-");
const LOCAL_FOLDER = ["E:", "Novels"].join("\\");
const LOCAL_PATH = [LOCAL_FOLDER, "秘密的书", "第一卷.txt"].join("\\");
const PROMPT = `在资料里找一下 x。我的令牌是 ${TOKEN_IN_WORDS}，文件在 ${LOCAL_PATH}。`;

export async function runTraceSmoke(input: { appService: MangaProductApp; grant: string; view: BrowserWindow; evidenceDir: string | undefined; logsDir: string }): Promise<FlowResult & { observations: TraceObservation[] }> {
  const { appService, grant, view, evidenceDir, logsDir } = input;
  const call = caller(appService, grant);
  const observations: TraceObservation[] = [];
  const observe = (name: string, ok: boolean, detail: unknown) => {
    observations.push({ name, status: ok ? "passed" : "failed", detail });
    console.error(`trace ${name}: ${ok ? "ok" : "FAILED"} ${JSON.stringify(detail ?? null).slice(0, 700)}`);
    return ok;
  };
  view.showInactive();
  const problems: string[] = [];
  const server = await startMockProvider({
    streamToolScript: [{ name: "library.find", arguments: '{"text":"x"}' }],
    respond: (request) => (JSON.stringify(request.body.messages ?? []).includes("library.find") ? { text: "找到了。" } : undefined),
  });
  try {
    await call("settings.skipAi", {});
    const connection = await call("connections.upsert", {
      label: "trace", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text",
      credentialHandle: appService.stashSecret(KEY), profile: { contextWindow: 32_768, maxOutput: 2_048 },
    }, "trace-conn");
    if (connection.status !== "ok") problems.push("the connection for the stand-in model could not be made");
    // The window learns of the connection when it reads its settings again.
    await view.webContents.reload();
    // A new conversation is made from the conversations' view (the home has no 新对话, A-110).
    const onChat = await toRail(view) && await viaSidebar(view, "conversation", "sidebar-new-conversation", 10_000) && await waitDrawn(view, "page-agent", 8000);
    if (!onChat) problems.push("the conversation tab did not open");
    await clickTestId(view, "chat-mode-ask");
    await setField(view, "agent-composer", PROMPT);
    const sent = await clickTestId(view, "agent-send");
    const running = sent && await waitForTestId(view, "agent-stop", "data-present", null, 15_000);
    const done = running && await waitForTestId(view, "agent-send", "data-present", null, 60_000);
    const answered = done && await waitUntil(view, `document.body.innerText.includes("找到了。")`, 10_000);
    if (!answered) problems.push("the task did not end with the model's answer");
    const opened = answered && await waitUntil(view, `document.querySelector('[data-testid^="bubble-trace-"]')`, 8000);
    if (!opened) problems.push("the reply has no way to its record");
    const clicked = opened && await js<boolean>(view, `(() => { const el = document.querySelector('[data-testid^="bubble-trace-"]'); if (!el) return false; el.click(); return true; })()`);
    const dialog = clicked && await waitForTestId(view, "trace-dialog", "data-present", null, 8000);
    if (!dialog) problems.push("the record did not open");
    await waitUntil(view, `document.querySelectorAll('[data-testid^="trace-item-"]').length >= 3`, 8000);
    const items = await js<string[]>(view, `[...document.querySelectorAll('[data-testid^="trace-item-"]')].map((el) => el.textContent ?? "")`);
    if (items.length < 3) problems.push(`the timeline lists ${items.length} entries, not request, tool call and request`);
    if (!items.some((text) => text.includes("library.find"))) problems.push("the tool call is not named in the timeline");
    // The first request: what was sent (the tools offered and the person's words), its parameters, the time to the first token and the tokens.
    await js(view, `document.querySelector('[data-testid^="trace-item-"]')?.click()`);
    await waitForTestId(view, "trace-detail", "data-present", null, 6000);
    await waitUntil(view, `document.querySelector('[data-testid="trace-text-request"]')`, 6000);
    const first = await js<{ model: string; firstToken: boolean; duration: boolean; request: string; response: string }>(view, `(() => ({
      model: document.querySelector('[data-testid="trace-model"]')?.textContent ?? "",
      firstToken: Boolean(document.querySelector('[data-testid="trace-first-token"]')),
      duration: Boolean(document.querySelector('[data-testid="trace-duration"]')),
      request: document.querySelector('[data-testid="trace-text-request"]')?.textContent ?? "",
      response: document.querySelector('[data-testid="trace-text-response"]')?.textContent ?? "",
    }))()`);
    if (!first.model.includes("demo")) problems.push("the model of the first request is not shown");
    if (!first.firstToken || !first.duration) problems.push("the first request shows no time to the first token or no duration");
    if (!first.request.includes("library.find")) problems.push("the tools offered are not in the request that was kept");
    if (!first.request.includes("在资料里找一下")) problems.push("the person's words are not in the request that was kept");
    await sleep(300);
    if (evidenceDir) await capturePage(view, evidenceDir, "ui-trace-timeline.png");

    // What the dialog shows, what the person copies and what the logs hold: none of them has the key, a token in the words, a header or a path.
    const shownText = await js<string>(view, `document.querySelector('[data-testid="trace-dialog"]')?.textContent ?? ""`);
    // The page's clipboard needs a real click (user activation), the way a person's click is. The person's own clipboard is put back afterwards.
    const keptClipboard = await clipboard.readText();
    clipboard.clear();
    // The notice of the conversation that was started stays in the corner, over the dialog's foot, until it times out; a click there would be its own.
    await waitUntil(view, `!document.querySelector('[data-testid="toast-notice"]')`, 8000);
    view.webContents.focus();
    const copied = await trustedClick(view, "trace-copy", 4000);
    await sleep(800);
    const copy = copied ? await clipboard.readText() : "";
    const notice = await js<string>(view, `[...document.querySelectorAll('[data-testid^="toast-"]')].map((el) => el.textContent ?? "").join(" | ")`);
    clipboard.writeText(keptClipboard);
    let copyJson = false;
    try { JSON.parse(copy); copyJson = true; } catch { copyJson = false; }
    if (!copied || !copyJson) problems.push(`the copy as JSON is not JSON (the page said: ${notice.slice(0, 120)})`);
    const holders: Record<string, string> = { dialog: shownText, copy };
    for (const entry of ((await call("agent.trace.list", { runId: await latestRun(call) })).value as { entries?: Array<{ id: string }> } | undefined)?.entries ?? []) {
      for (const part of ["request", "response"] as const) {
        const got = (await call("agent.trace.get", { entryId: entry.id, part, limit: 64 * 1024 })).value as { text?: string } | undefined;
        holders[`${entry.id}:${part}`] = got?.text ?? "";
      }
    }
    for (const file of fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : []) {
      const full = path.join(logsDir, file);
      if (fs.statSync(full).isFile() && fs.statSync(full).size < 8 * 1024 * 1024) holders[`log:${file}`] = fs.readFileSync(full, "utf8");
    }
    const leaks: string[] = [];
    for (const [where, text] of Object.entries(holders)) {
      if (text.includes(KEY)) leaks.push(`${where}: the credential`);
      if (/authorization["']?\s*[:=]\s*["']?Bearer/i.test(text) || /\bBearer\s+sk-/i.test(text)) leaks.push(`${where}: an authorization header`);
      if (text.includes(TOKEN_IN_WORDS)) leaks.push(`${where}: the token in the words`);
      if (text.includes(LOCAL_FOLDER) || text.includes(LOCAL_FOLDER.replaceAll("\\", "\\\\")) || text.includes("秘密的书")) leaks.push(`${where}: the local path`);
    }
    if (leaks.length) problems.push(...leaks);
    await pressKey(view, "Escape");
    observe("agent-trace-timeline", problems.length === 0, { entries: items.length, first: { model: first.model, firstToken: first.firstToken, duration: first.duration }, copied: copy.length, holdersChecked: Object.keys(holders).length, leaks, problems });
    await walkAutoTitle(view, call, observe);
  } finally {
    await server.close();
  }
  const failed = observations.filter((item) => item.status !== "passed").map((item) => item.name);
  return { ok: failed.length === 0, failed, observations };
}

/** The newest run the owner can see: the one the walk sent. */
async function latestRun(call: ReturnType<typeof caller>): Promise<string> {
  const ws = await call("workspace.get", {});
  const runs = ((ws.value as { runs?: Array<{ id: string }> } | undefined)?.runs) ?? [];
  return String(runs[0]?.id ?? "");
}

const FIRST_LINE = "帮我总结一下第一章的主要人物";
const SECOND_LINE = "顺便列出出现过的地点";
const OWN_NAME = "我自己起的名字";

/**
 * AT-127 (计划 4.7) in the real window: a new conversation is named by the start of the first thing said in it, and the tab, the conversations' sidebar and
 * the dock all show that name; a name the person gave stays when more is said.
 */
async function walkAutoTitle(view: BrowserWindow, call: ReturnType<typeof caller>, observe: (name: string, ok: boolean, detail: unknown) => boolean): Promise<void> {
  const problems: string[] = [];
  const detail: Record<string, unknown> = {};
  type Session = { sessionId: string; title: string };
  const sessions = async (): Promise<Session[]> => ((await call("workspace.sessions", { contextId: null })).value as Session[] | undefined) ?? [];
  // Two conversations are open by now, each with its own composer: only the one in front is meant.
  const shown = (testId: string) => `[...document.querySelectorAll('[data-testid="${testId}"]')].find((el) => el.checkVisibility({ visibilityProperty: true }))`;
  const send = async (text: string) => {
    if (!(await waitUntil(view, shown("agent-composer"), 8000))) return false;
    await js(view, `(() => { const el = ${shown("agent-composer")}; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(text)}); el.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    if (!(await waitUntil(view, `${shown("agent-send")}?.disabled === false`, 4000))) return false;
    await js(view, `${shown("agent-send")}.click()`);
    // A short answer can come and go between two looks at the stop button: what is asked is that the words are in the conversation and the turn is over.
    const said = await waitUntil(view, `${shown("page-agent")}?.innerText.includes(${JSON.stringify(text.split("\n")[0])})`, 15_000);
    return said && await waitUntil(view, `!(${shown("agent-stop")}) && ${shown("agent-send")}`, 60_000);
  };
  const tabTitle = () => js<string>(view, `document.querySelector('[data-testid="context-host"][data-active="true"] [data-testid="tab"][data-focused="true"] .tab-title')?.textContent ?? ""`);
  const opened = await toRail(view) && await viaSidebar(view, "conversation", "sidebar-new-conversation", 10_000) && await waitDrawn(view, "page-agent", 8000);
  if (!opened) problems.push("a new conversation did not open");
  const before = await tabTitle();
  const done = opened && await send(`${FIRST_LINE}\n${SECOND_LINE}`);
  if (!done) problems.push("the first message was not sent and answered");
  const named = await waitUntil(view, `(document.querySelector('[data-testid="context-host"][data-active="true"] [data-testid="tab"][data-focused="true"] .tab-title')?.textContent ?? "") === ${JSON.stringify(FIRST_LINE)}`, 6000);
  const session = (await sessions()).find((item) => item.title === FIRST_LINE);
  detail.first = { before, tab: await tabTitle(), named, stored: Boolean(session) };
  if (!named) problems.push(`the tab is named ${JSON.stringify(await tabTitle())}, not the start of the first message`);
  if (!session) problems.push("the conversation is not stored with the start of the first message as its name");
  // The conversations' sidebar.
  await railTo(view, "conversation");
  await ensureSidebar(view);
  const inSidebar = session ? await waitUntil(view, `(document.querySelector('[data-testid="sidebar"][data-view="conversation"] [data-testid="session-open-${session.sessionId}"]')?.textContent ?? "").includes(${JSON.stringify(FIRST_LINE)})`, 6000) : false;
  detail.sidebar = inSidebar;
  if (!inSidebar) problems.push("the conversations' sidebar does not show the new name");
  // The dock, once a page that is not the conversation is in front: the current conversation of 最近 is this one.
  await viaSidebar(view, "home", "sidebar-entry-library", 6000);
  await waitDrawn(view, "page-library", 6000);
  const inDock = await waitUntil(view, `(document.querySelector('[data-testid="shell-dock"]')?.textContent ?? "").includes(${JSON.stringify(FIRST_LINE)})`, 6000);
  detail.dock = inDock;
  if (!inDock) problems.push("the dock does not show the new name");
  // A name the person gives is kept when more is said.
  if (session) {
    await call("conversation.rename", { sessionId: session.sessionId, title: OWN_NAME });
    await viaSidebar(view, "conversation", `session-open-${session.sessionId}`, 6000);
    await waitDrawn(view, "page-agent", 8000);
    const again = await send("再补充一句别的话");
    const kept = (await sessions()).find((item) => item.sessionId === session.sessionId)?.title ?? null;
    detail.renamed = { again, kept };
    if (!again) problems.push("the second message was not sent and answered");
    if (kept !== OWN_NAME) problems.push(`after the person named it and spoke again, the conversation is named ${JSON.stringify(kept)}`);
  }
  observe("conversation-auto-title", problems.length === 0, { ...detail, problems });
}
