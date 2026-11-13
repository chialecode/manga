/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { App } from "../../apps/desktop/src/renderer/App.tsx";
import { webSearchAvailable } from "../../apps/desktop/src/renderer/workspace/agent.tsx";
import { windowLabel } from "../../apps/desktop/src/renderer/workspace/model-choice.tsx";
import { installHost } from "../helpers/app-host.ts";

Element.prototype.scrollIntoView = () => {};
afterEach(cleanup);

// A-137: the conversation page picks the model, how hard it thinks and how much of the window a task may fill; a catalogue model the account has not
// added yet is added when it is picked.
const profile = { contextWindow: 1_048_576, maxOutput: 393_216, inputTypes: ["text"], capabilities: ["tools", "reasoning"], reasoningEffort: "high", reasoningLevels: ["low", "high", "max"], dialect: "deepseek", source: { contextWindow: "detected", maxOutput: "detected" } };
const account = { id: "acct_1", label: "DeepSeek", providerRef: "manga.provider-deepseek/deepseek", available: true };
const flash = { id: "conn_flash", label: "DeepSeek · DeepSeek V4.1 Flash", purpose: "text", profile, account, providerModel: "deepseek-flash" };
const pro = { id: "conn_pro", label: "DeepSeek · DeepSeek V4 Pro", purpose: "text", profile, account, providerModel: "deepseek-v4-pro" };

function host() {
  const state = { connections: [flash], chat: { connectionId: null as string | null, reasoningEffort: null as string | null, contextWindow: null as number | null } };
  const installed = installHost({
    facets: ["agent", "library", "settings", "plugins"],
    overrides: {
      "settings.get": () => ({ needsSetup: false, recoveryJobs: [], aiRuntime: "native", connections: state.connections }),
      "settings.getAgent": () => ({ chat: state.chat }),
      "settings.setAgent": (input) => { state.chat = { ...state.chat, ...(input.chat as object) }; return { chat: state.chat }; },
      "providers.list": () => ({
        providers: [{ ref: account.providerRef, name: "DeepSeek", models: [
          { id: "deepseek-flash", name: "DeepSeek V4.1 Flash", contextWindow: 1_048_576, inputTypes: ["text", "image"], reasoningLevels: ["low", "high", "max"] },
          { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1_048_576, inputTypes: ["text"], reasoningLevels: ["low", "high", "max"] },
        ] }],
        accounts: [{ id: account.id, providerRef: account.providerRef, available: true }],
      }),
      "providers.add": () => { state.connections = [flash, pro]; return { accountId: account.id, connections: [{ id: pro.id, purpose: "text", modelId: "deepseek-v4-pro" }] }; },
    },
  });
  return { ...installed, picked: state };
}

const open = async () => {
  fireEvent.click(await screen.findByTestId("chat-model"));
  return within((await screen.findByTestId("chat-model-group-models")).closest<HTMLElement>("[role='menu']")!);
};

describe("the model picker of the conversation page (A-137)", () => {
  it("names a window the way people say it", () => {
    expect(windowLabel(131_072)).toBe("128K");
    expect(windowLabel(1_048_576)).toBe("1M");
    expect(windowLabel(128_000)).toBe("125K");
  });

  it("shows the model, its thinking and its window, and saves what is picked for the next message", async () => {
    const { calls, picked } = host();
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("chat-model-summary").textContent).toBe("DeepSeek V4.1 Flash · 高 · 1M"));
    let menu = await open();
    expect(menu.getByTestId("chat-model-conn_flash").getAttribute("aria-checked")).toBe("true");
    // The thinking levels the model declares, with off; the windows below its own, and the whole of it.
    for (const id of ["chat-effort-off", "chat-effort-low", "chat-effort-high", "chat-effort-max", "chat-window-131072", "chat-window-whole"]) expect(menu.getByTestId(id)).toBeTruthy();
    expect(menu.queryByTestId("chat-effort-medium")).toBeNull();
    fireEvent.click(menu.getByTestId("chat-effort-max"));
    await waitFor(() => expect(picked.chat.reasoningEffort).toBe("max"));
    menu = await open();
    fireEvent.click(menu.getByTestId("chat-window-131072"));
    await waitFor(() => expect(screen.getByTestId("chat-model-summary").textContent).toBe("DeepSeek V4.1 Flash · 最高 · 128K"));
    expect(calls.filter((call) => call.commandId === "settings.setAgent").map((call) => call.input)).toEqual([{ chat: { reasoningEffort: "max" } }, { chat: { contextWindow: 131_072 } }]);
  });

  it("adds a catalogue model to the account when it is picked, and then talks to it", async () => {
    const { calls, picked } = host();
    render(<App />);
    const menu = await open();
    fireEvent.click(menu.getByTestId("chat-model-add-deepseek-v4-pro"));
    await waitFor(() => expect(picked.chat.connectionId).toBe("conn_pro"));
    expect(calls.find((call) => call.commandId === "providers.add")?.input).toEqual({ providerRef: account.providerRef, accountId: account.id, models: ["deepseek-v4-pro"], services: [] });
    await waitFor(() => expect(screen.getByTestId("chat-model-summary").textContent).toBe("DeepSeek V4 Pro · 高 · 1M"));
    const again = await open();
    expect(again.queryByTestId("chat-model-add-deepseek-v4-pro")).toBeNull();
    expect(again.queryByTestId("chat-model-add-deepseek-flash")).toBeNull();
  });

  it("evaluates webSearchAvailable against the selected active connection rather than always the first text connection (US-07)", () => {
    const plain = { id: "conn_plain", purpose: "text", profile: { capabilities: ["tools"], dialect: "openai" }, account: { available: true } };
    const dsSearch = { id: "conn_ds", purpose: "text", profile: { capabilities: ["tools", "web_search"], dialect: "deepseek" }, account: { available: true } };
    expect(webSearchAvailable([plain, dsSearch], dsSearch)).toBe(true);
    expect(webSearchAvailable([dsSearch, plain], plain)).toBe(false);
    expect(webSearchAvailable([dsSearch, plain], null)).toBe(false);
  });
});
