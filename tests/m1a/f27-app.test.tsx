/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../../apps/desktop/src/renderer/App.tsx";

type CommandPayload = { commandId: string; input?: Record<string, unknown> };

function installHost(store: {
  sessionId: string;
  run: Record<string, unknown> | null;
  runs: Array<{ id: string; sessionId: string; status: string; inputText?: string }>;
}) {
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
      if (body.commandId === "inventory.overview") return { status: "ok" as const, value: { items: [], totals: {} } };
      if (body.commandId === "settings.get") return { status: "ok" as const, value: { needsSetup: false, recoveryJobs: [], aiRuntime: "native" } };
      if (body.commandId === "agent.createSession") return { status: "ok" as const, value: { id: store.sessionId } };
      if (body.commandId === "agent.send") {
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
  };
}

describe("F-27 App restore", () => {
  it("sends from the composer, shows history on copilot, stops, and restores after remount", async () => {
    const store = { sessionId: "ses-1", run: null as Record<string, unknown> | null, runs: [] as Array<{ id: string; sessionId: string; status: string; inputText?: string }> };
    installHost(store);
    const user = userEvent.setup();
    const first = render(<App />);
    await waitFor(() => expect(screen.getByTestId("agent-composer")).toBeTruthy());
    await user.type(screen.getByTestId("agent-composer"), "slow-smoke-prompt");
    await user.click(screen.getByTestId("agent-send"));
    await waitFor(() => expect(screen.getByTestId("agent-input").textContent).toContain("slow-smoke-prompt"));
    await user.click(screen.getByTestId("nav-copilot"));
    expect(screen.getByTestId("agent-thread").textContent).toContain("slow-smoke-prompt");
    await user.click(screen.getByTestId("agent-stop"));
    await waitFor(() => expect(store.run?.status).toBe("cancelled"));
    first.unmount();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("agent-input").textContent).toContain("slow-smoke-prompt"));
    expect(screen.getByTestId("agent-messages").textContent).toContain("user");
  });
});
