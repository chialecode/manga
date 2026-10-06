/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { quoteTags } from "../../apps/desktop/src/renderer/lib/quote-tags.ts";
import { readerContext } from "../../apps/desktop/src/renderer/lib/reader-context.ts";

type CommandPayload = { commandId: string; input?: Record<string, unknown> };
type Store = {
  sessionId: string;
  run: Record<string, unknown> | null;
  runs: Array<{ id: string; sessionId: string; status: string; inputText?: string }>;
  mode?: string;
  sent: Array<Record<string, unknown>>;
};

Element.prototype.scrollIntoView = () => {};

function installHost(store: Store) {
  const work = { id: "w1", title: "合成作品", author: "合成作者", mediaKind: "comic", shelf: "reading", coverId: null, lastResource: null, progress: 0, finishedCount: 0, resourceCount: 0, linked: false, createdAt: "2026-01-01T00:00:00.000Z", lastOpenedAt: null };
  window.manga = {
    async state() {
      return {
        layout: { channel: "test", pointerPath: "pointer.json", partitions: { data: "profile-data" }, writable: true, recovery: "none" },
        writable: true,
        vaultAvailable: true,
      };
    },
    async command(payload: unknown) {
      const body = payload as CommandPayload;
      if (body.commandId === "workspace.get") {
        return {
          status: "ok" as const,
          value: {
            uiFacets: ["agent", "library", "settings"],
            sessions: [{ id: store.sessionId, title: "会话 1" }],
            runs: store.runs,
            notes: [],
            resources: [],
          },
        };
      }
      // A library with a work does not send the user to the library paths page at start.
      if (body.commandId === "works.list") return { status: "ok" as const, value: { items: [work], total: 1, nextCursor: null } };
      if (body.commandId === "inventory.overview") return { status: "ok" as const, value: { items: [], totals: {} } };
      if (body.commandId === "settings.get") return { status: "ok" as const, value: { needsSetup: false, recoveryJobs: [], aiRuntime: "native", connections: [{ purpose: "text" }] } };
      if (body.commandId === "workspace.sessions") {
        return {
          status: "ok" as const,
          value: [{ sessionId: store.sessionId, title: "会话 1", kind: "shared", targetId: null, mode: store.mode ?? "enthusiast", runCount: store.runs.length, activeRunId: store.run ? "run-1" : null, activeRunStatus: store.run ? String(store.run.status) : null }],
        };
      }
      if (body.commandId === "session.stream") {
        const items = store.run
          ? [
            { kind: "user", id: "u-run-1", at: "2026-10-04T08:00:00.000Z", runId: "run-1", text: String(store.run.inputText ?? ""), quickTask: null },
            { kind: "agent", id: "a-run-1", at: "2026-10-04T08:00:01.000Z", runId: "run-1", status: String(store.run.status), text: String(store.run.liveText ?? ""), error: null },
          ]
          : [];
        return { status: "ok" as const, value: { items, hasMore: false, session: { id: store.sessionId, kind: "shared", targetId: null, workId: null, resourceId: null } } };
      }
      if (body.commandId === "notes.list") return { status: "ok" as const, value: [] };
      if (body.commandId === "quickTasks.list") return { status: "ok" as const, value: { tasks: [] } };
      if (body.commandId === "agent.createSession") return { status: "ok" as const, value: { id: store.sessionId, mode: body.input?.mode ?? "enthusiast" } };
      if (body.commandId === "agent.send") {
        store.sent.push(body.input ?? {});
        store.run = {
          runId: "run-1",
          id: "run-1",
          status: "running",
          sessionId: store.sessionId,
          inputText: String(body.input?.text ?? ""),
          grantHandle: "grant-1",
          liveText: "流式…",
          text: "",
          messages: [{ role: "user", text: String(body.input?.text ?? "") }],
        };
        store.runs = [{ id: "run-1", sessionId: store.sessionId, status: "running", inputText: String(body.input?.text ?? "") }];
        return { status: "ok" as const, value: store.run };
      }
      if (body.commandId === "agent.getRun") return { status: "ok" as const, value: store.run ?? {} };
      if (body.commandId === "agent.cancel") {
        if (store.run) store.run = { ...store.run, status: "cancelled" };
        store.runs = store.runs.map((run) => ({ ...run, status: "cancelled" }));
        return { status: "ok" as const, value: { cancelled: true } };
      }
      return { status: "ok" as const, value: {} };
    },
    async chooseDirectory() { return null; },
    async chooseFile() { return null; },
    async chooseAudio() { return null; },
    async stashSecret() { return null; },
    async reveal() { return { status: "ok" as const, value: {} }; },
    onNotice: () => () => undefined,
  };
}

beforeEach(() => { quoteTags.reset(); readerContext.reset(); try { window.localStorage.clear(); } catch { /* none */ } });
afterEach(() => { cleanup(); quoteTags.reset(); readerContext.reset(); });

describe("F-27 App restore", () => {
  it("sends from the chat page, shows the history in the side pane, stops, and restores after remount", async () => {
    // A wide window keeps the right pane docked next to every page except the chat page itself.
    window.innerWidth = 1600;
    const store: Store = { sessionId: "ses-1", run: null, runs: [], sent: [] };
    installHost(store);
    const user = userEvent.setup();
    const first = render(<App />);
    await waitFor(() => expect(screen.getByTestId("nav-agent")).toBeTruthy());
    await user.click(screen.getByTestId("nav-agent"));
    await waitFor(() => expect(screen.getByTestId("page-agent").querySelector("[data-testid='agent-composer']")).toBeTruthy());
    // The chat page is the conversation itself: no right pane beside it.
    expect(screen.queryByTestId("shell-right")).toBeNull();
    const agentPage = () => within(screen.getByTestId("page-agent"));
    // Nothing is open to write a note about here, so the input only asks the Agent.
    expect(agentPage().queryByTestId("chat-mode-note")).toBeNull();
    expect(agentPage().queryByTestId("chat-mode-ask")).toBeNull();
    await user.type(agentPage().getByTestId("agent-composer"), "slow-smoke-prompt");
    await user.click(agentPage().getByTestId("agent-send"));
    await waitFor(() => expect(agentPage().getByTestId("bubble-user-u-run-1").textContent).toContain("slow-smoke-prompt"));
    expect(store.sent[0]).toMatchObject({ sessionId: "ses-1", text: "slow-smoke-prompt" });
    // On another page the same session is the copilot in the right pane.
    await user.click(screen.getByTestId("nav-library"));
    const pane = () => within(screen.getByTestId("shell-right"));
    await waitFor(() => expect(pane().getByTestId("bubble-user-u-run-1").textContent).toContain("slow-smoke-prompt"));
    await user.click(pane().getByTestId("agent-stop"));
    await waitFor(() => expect(store.run?.status).toBe("cancelled"));
    first.unmount();
    render(<App />);
    await waitFor(() => expect(within(screen.getByTestId("shell-right")).getByTestId("bubble-user-u-run-1").textContent).toContain("slow-smoke-prompt"));
    expect(within(screen.getByTestId("shell-right")).getByTestId("bubble-agent-a-run-1").getAttribute("data-status")).toBe("cancelled");
  });

  it("starts on the library paths page when the library is empty, and on the shelf when it has works", async () => {
    window.innerWidth = 1600;
    const store: Store = { sessionId: "ses-1", run: null, runs: [], sent: [] };
    installHost(store);
    const full = render(<App />);
    await waitFor(() => expect(screen.getByTestId("page-library")).toBeTruthy());
    expect(screen.queryByTestId("settings-nav")).toBeNull();
    full.unmount();

    installHost(store);
    const original = window.manga.command;
    window.manga.command = (async (payload: CommandPayload) => (payload.commandId === "works.list" ? { status: "ok", value: { items: [], total: 0, nextCursor: null } } : original(payload))) as typeof window.manga.command;
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("settings-nav")).toBeTruthy());
    expect(screen.getByTestId("settings-page-library")).toBeTruthy();
  });
});
