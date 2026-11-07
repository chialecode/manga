import { createServer } from "node:http";
import type { BrowserWindow } from "electron";
import type { MangaProductApp } from "@manga/app-core";
import { clickTestId, ensureSidebar, railTo, setField, viaSidebar, waitDrawn, waitForTestId, waitUntil } from "./driver.ts";
import { caller, clickFirst, js, toRail, type FlowResult } from "./common.ts";

/**
 * The Agent through the real window: a task is sent from a conversation tab, shows as running, is stopped by the user, and a module switch
 * revokes the command. Against a local server that never answers, so nothing leaves the machine and the task stays running until stopped.
 */

const PROMPT = "slow-smoke-prompt";

export async function runAgentSmoke(appService: MangaProductApp, grant: string, view: BrowserWindow, phase: string): Promise<FlowResult> {
  const call = caller(appService, grant);
  if (phase === "agent-restart") {
    const ws = await call("workspace.get", {});
    const runs = (ws.status === "ok" ? (ws.value as { runs?: Array<{ id: string; status: string; inputText?: string }> }).runs : undefined) ?? [];
    const restored = runs.find((run) => run.inputText === PROMPT) ?? runs[0];
    const detail = restored ? await call("agent.getRun", { runId: restored.id }) : { status: "error" as const, value: undefined };
    const detailValue = detail.status === "ok" ? detail.value as { inputText?: string; status?: string } | undefined : undefined;
    // The conversation that was left comes back as the tab it was in; if the tab was not kept, its row in the conversation view of the sidebar opens it again (A-65).
    const reopened = async () => await railTo(view, "conversation") && await ensureSidebar(view) && await clickFirst(view, "session-open-", 6000) && await waitDrawn(view, "page-agent", 6000);
    const agentPage = await toRail(view) && (await waitDrawn(view, "page-agent", 6000) || await reopened());
    const shown = agentPage && await waitUntil(view, `document.body.innerText.includes(${JSON.stringify(PROMPT)})`, 10_000);
    // "开启新对话" empties the page and moves that conversation into the history, from where it is continued.
    const started = shown && await clickTestId(view, "conversation-new");
    const emptied = started && await waitUntil(view, `!document.body.innerText.includes(${JSON.stringify(PROMPT)})`, 8000);
    const history = emptied && await clickTestId(view, "conversation-history");
    const listed = history && await clickFirst(view, "conversation-item-", 8000);
    const continued = listed && await waitUntil(view, `document.body.innerText.includes(${JSON.stringify(PROMPT)})`, 10_000);
    const inputText = String(detailValue?.inputText ?? restored?.inputText ?? "");
    const ok = Boolean(restored) && inputText.includes(PROMPT) && agentPage && Boolean(shown) && Boolean(emptied) && Boolean(continued);
    // What the context kept, so that a conversation which did not come back says where it was lost.
    const kept = (await call("workspace.loadContext", { contextId: null })).value as { state?: { tabs?: Array<{ kind: string; target?: unknown }> } } | undefined;
    const sessions = ((await call("workspace.sessions", { contextId: null })).value as Array<{ sessionId: string; kind: string }> | undefined) ?? [];
    return { ok, restoredStatus: restored?.status ?? detailValue?.status, agentVisible: agentPage, conversationShown: Boolean(shown), newConversationEmptied: Boolean(emptied), historyContinued: Boolean(continued), inputText, keptTabs: (kept?.state?.tabs ?? []).map((tab) => tab.kind), keptSessions: sessions.map((session) => session.kind) };
  }

  const slow = createServer((request) => { request.resume(); });
  await new Promise<void>((resolve) => { slow.listen(0, "127.0.0.1", () => resolve()); });
  const address = slow.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const secret = appService.stashSecret("smoke-credential");
    await call("connections.upsert", { label: "slow", protocol: "openai-chat-completions", baseUrl: `http://127.0.0.1:${port}/v1`, modelId: "demo", purpose: "text", credentialHandle: secret }, "smoke-conn");
    // The window learns of the connection when it reads its settings again.
    await view.webContents.reload();
    // The home view of the rail has "新对话"; the sidebar is shown first if the window folded it.
    const agentPage = await toRail(view) && await viaSidebar(view, "home", "sidebar-new-conversation", 10_000);
    const pageShown = agentPage && await waitDrawn(view, "page-agent", 8000);
    await clickTestId(view, "chat-mode-ask");
    await setField(view, "agent-composer", PROMPT);
    const sending = await clickTestId(view, "agent-send");
    // The task is shown as running at once, with the stop button in place of send.
    const runningShown = sending && await waitForTestId(view, "agent-stop", "data-present", null, 15_000);
    const stopClicked = runningShown && await clickTestId(view, "agent-stop");
    const stoppedShown = stopClicked && await waitForTestId(view, "agent-send", "data-present", null, 15_000);
    let runId: string | undefined;
    let status = "";
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const ws = await call("workspace.get", {});
      const run = (((ws.value as { runs?: Array<{ id: string; inputText?: string }> } | undefined)?.runs) ?? []).find((item) => item.inputText === PROMPT);
      if (run) {
        runId = run.id;
        const latest = await call("agent.getRun", { runId });
        status = String((latest.value as { status?: string } | undefined)?.status ?? "");
        if (["cancelled", "interrupted", "failed"].includes(status)) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (runId && !["cancelled", "interrupted", "failed"].includes(status)) {
      await call("agent.cancel", { runId }, "smoke-cancel");
      status = String(((await call("agent.getRun", { runId })).value as { status?: string } | undefined)?.status ?? "");
    }
    const previous = appService.runtime.snapshot().lastValidProfile;
    if (previous) {
      await appService.runtime.applyProfile({
        ...previous,
        enabledFeatures: previous.enabledFeatures.filter((feature) => feature !== "agent"),
        disabledFeatures: [...new Set([...previous.disabledFeatures, "agent"])],
      });
    }
    const revoked = !appService.uiFacets.has("agent") && !appService.runtime.gateway.has("agent.send");
    if (previous) await appService.runtime.applyProfile(previous);
    const stopped = ["cancelled", "interrupted", "failed"].includes(status);
    const sendFocus = await js<boolean>(view, `Boolean(document.querySelector('[data-testid="agent-composer"]'))`);
    return {
      ok: Boolean(runId) && agentPage && pageShown && runningShown && Boolean(stoppedShown) && stopped && revoked,
      runStatus: status,
      revoked,
      agentVisible: agentPage,
      runningShown,
      stoppedShown: Boolean(stoppedShown),
      composerPresent: sendFocus,
      runId,
    };
  } finally {
    slow.closeAllConnections();
    await new Promise<void>((resolve) => { slow.close(() => resolve()); });
  }
}
