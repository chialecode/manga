import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_MODEL_PROFILE, type ModelProfile } from "@manga/contracts/models";
import { startMockDeepSeek } from "@manga/model-protocol";
import { withChoice } from "../../packages/app-core/src/agent-context.ts";
import { startApp, waitForRun } from "../helpers/app.ts";

// A-137: the model, the thinking and the window chosen on the conversation page reach the request, are kept with the run for a retry, and give way to a
// project's own model.
const deepseek: ModelProfile = {
  ...DEFAULT_MODEL_PROFILE, contextWindow: 1_048_576, maxOutput: 393_216, capabilities: ["tools", "reasoning"], reasoningEffort: "high",
  reasoningLevels: ["low", "high", "max"], dialect: "deepseek", source: { contextWindow: "detected", maxOutput: "detected" },
};

describe("the conversation's choice laid over a model's profile", () => {
  it("narrows the window and the answer with it, never widens it, and switches thinking only to what the model has", () => {
    expect(withChoice(deepseek, null)).toBe(deepseek);
    expect(withChoice(deepseek, { contextWindow: 131_072 })).toMatchObject({ contextWindow: 131_072, maxOutput: 32_768 });
    expect(withChoice(deepseek, { contextWindow: 4_000_000 })).toMatchObject({ contextWindow: 1_048_576, maxOutput: 393_216 });
    expect(withChoice(deepseek, { reasoningEffort: "off" }).reasoningEffort).toBeNull();
    expect(withChoice(deepseek, { reasoningEffort: "max" }).reasoningEffort).toBe("max");
    // A level the model does not declare, and a model that does not reason, keep what they had.
    expect(withChoice(deepseek, { reasoningEffort: "medium" }).reasoningEffort).toBe("high");
    expect(withChoice(DEFAULT_MODEL_PROFILE, { reasoningEffort: "max" }).reasoningEffort).toBeNull();
  });
});

describe("the model chosen on the conversation page", () => {
  let server: Awaited<ReturnType<typeof startMockDeepSeek>> | undefined;
  afterEach(async () => { await server?.close(); server = undefined; });

  it("is the one a run talks to, with the thinking and window chosen, and kept for a retry", async () => {
    // The first request is refused, so the first run can be tried again later.
    server = await startMockDeepSeek({ answer: "好的。", fail: [{ path: "/chat/completions", status: 400 }] });
    const ctx = await startApp();
    const { app, actor, grant } = ctx;
    let seq = 0;
    const call = async <T = Record<string, unknown>>(commandId: string, input: Record<string, unknown> = {}) => {
      seq += 1;
      const result = await app.call(actor, { commandId, idempotencyKey: `choice-${seq}`, input }, grant.handle);
      if (result.status !== "ok") throw new Error(`${commandId}: ${JSON.stringify(result.error)}`);
      return result.value as T;
    };
    try {
      const add = (id: string, modelId: string) => call("connections.upsert", {
        id, label: id, purpose: "text", protocol: "openai-chat-completions", baseUrl: server!.url, modelId, credentialHandle: app.stashSecret("sk-test"),
        profile: { contextWindow: 1_048_576, maxOutput: 393_216, capabilities: ["tools", "reasoning"], reasoningEffort: "high" },
      });
      await add("flash", "deepseek-flash");
      await add("pro", "deepseek-v4-pro");
      // As the DeepSeek plugin's catalogue says of its models (the fake service is not at DeepSeek's address).
      app.store.sqlite.prepare(`UPDATE provider_connections SET profile_json = json_set(profile_json, '$.dialect', 'deepseek', '$.reasoningLevels', json('["low","high","max"]'))`).run();
      await call("settings.setRuntime", { runtime: "native" });
      // Not a text connection: refused.
      await expect(call("settings.setAgent", { chat: { connectionId: "nothing-here" } })).rejects.toThrow(/VALIDATION_ERROR/);
      const saved = await call<{ chat: unknown }>("settings.setAgent", { chat: { connectionId: "pro", reasoningEffort: "max", contextWindow: 131_072 } });
      expect(saved.chat).toEqual({ connectionId: "pro", reasoningEffort: "max", contextWindow: 131_072 });

      const sessionId = (await call<{ id: string }>("agent.createSession", { title: "t" })).id;
      const ask = async () => {
        const sent = await call<{ runId: string }>("agent.send", { sessionId, text: "你好" });
        const done = await waitForRun(app, actor, grant.handle, sent.runId);
        return { runId: sent.runId, status: String(done.value?.status ?? done.value?.run?.status) };
      };
      const first = await ask();
      expect(first.status).toBe("failed");
      const bodies = () => server!.requests.filter((request) => request.path.endsWith("/chat/completions")).map((request) => request.body!);
      expect(bodies().at(-1)).toMatchObject({ model: "deepseek-v4-pro", reasoning_effort: "max", max_tokens: 32_768, thinking: { type: "enabled" } });
      const budget = JSON.parse((app.store.sqlite.prepare("SELECT budget_json FROM agent_runs WHERE id = ?").get(first.runId) as { budget_json: string }).budget_json) as { contextWindow: number };
      expect(budget.contextWindow).toBe(131_072);

      // Thinking off and the whole window; a retry of the first run still thinks and fills as it was asked to then.
      await call("settings.setAgent", { chat: { reasoningEffort: "off", contextWindow: null } });
      expect((await ask()).status).toBe("succeeded");
      expect(bodies().at(-1)).toMatchObject({ model: "deepseek-v4-pro", thinking: { type: "disabled" }, max_tokens: 393_216 });
      expect(bodies().at(-1)!.reasoning_effort).toBeUndefined();
      await call("agent.retry", { runId: first.runId });
      const retried = await waitForRun(app, actor, grant.handle, first.runId);
      expect(String(retried.value?.status ?? retried.value?.run?.status)).toBe("succeeded");
      expect(bodies().at(-1)).toMatchObject({ reasoning_effort: "max", max_tokens: 32_768 });

      // A chosen connection that is gone gives way to the first.
      await call("settings.setAgent", { chat: { connectionId: "flash" } });
      await call("connections.delete", { connectionId: "flash" });
      await ask();
      expect(bodies().at(-1)!.model).toBe("deepseek-v4-pro");
    } finally {
      app.close();
    }
  });
});
