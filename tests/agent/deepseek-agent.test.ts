import { afterEach, describe, expect, it } from "vitest";
import { llmPort } from "../../packages/app-core/src/commands/voice.ts";
import { waitForRun } from "../helpers/app.ts";
import { call, deepseekApp } from "../helpers/provider-fixture.ts";

/**
 * A DeepSeek connection added from the provider plugin, in Agent tasks (计划 4.3/4.4, AT-186—AT-188): thinking on at its level, the step's thinking sent
 * back within the turn and kept with the run, built-in web search with its sources, thinking off for the small background tasks, and a run cut off when
 * the plugin is turned off. Everything runs against the fake service on this machine.
 */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function boot(mock: NonNullable<Parameters<typeof deepseekApp>[0]>["mock"] = {}) {
  const rig = await deepseekApp({ mock, add: { models: ["deepseek-flash"], services: ["search"] } });
  closers.push(rig.close);
  const session = await call(rig.ctx, "conversation.new", { contextId: null });
  return { ...rig, sessionId: String((session.value as { sessionId: string }).sessionId) };
}
const chatBodies = (server: Awaited<ReturnType<typeof boot>>["server"]) => server.requests.filter((request) => request.path.endsWith("/chat/completions")).map((request) => request.body as Record<string, any>);

describe("DeepSeek in an Agent task", () => {
  it("runs a three-step tool loop with thinking on, sends each step's thinking back in the turn, and keeps it with the run", async () => {
    const rig = await boot({ toolScript: [1, 2, 3].map(() => ({ name: "library.list", arguments: "{}" })), answer: "三步都查完了。" });
    const sent = await call(rig.ctx, "agent.send", { sessionId: rig.sessionId, text: "查三次资源库" });
    expect(sent.status, JSON.stringify(sent)).toBe("ok");
    const runId = String((sent.value as { runId: string }).runId);
    const done = await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, runId);
    expect(done.value?.status, JSON.stringify(done.value?.error)).toBe("succeeded");
    expect(done.value?.text).toBe("三步都查完了。");

    const bodies = chatBodies(rig.server);
    expect(bodies).toHaveLength(4);
    for (const body of bodies) {
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.reasoning_effort).toBe("high");
      expect(body).not.toHaveProperty("temperature");
      expect(body).toHaveProperty("max_tokens");
    }
    // The last request carries the three tool steps, each with the thinking that led to it.
    const assistants = (bodies[3]!.messages as Array<Record<string, any>>).filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(3);
    for (const message of assistants) expect(message.reasoning_content).toBe("先想一想该怎么做。");

    const stream = await call(rig.ctx, "session.stream", { sessionId: rig.sessionId });
    const answer = (stream.value as { items: Array<Record<string, any>> }).items.find((item) => item.kind === "agent")!;
    expect(answer.reasoning).toContain("先想一想该怎么做。");

    // A second task in the conversation sends the earlier turn's answer, but not its thinking.
    const again = await call(rig.ctx, "agent.send", { sessionId: rig.sessionId, text: "再说一遍" });
    await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, String((again.value as { runId: string }).runId));
    const last = chatBodies(rig.server).at(-1)!;
    const earlier = (last.messages as Array<Record<string, any>>).filter((message) => message.role === "assistant");
    expect(earlier.length).toBeGreaterThan(0);
    for (const message of earlier) expect(message).not.toHaveProperty("reasoning_content");
  });

  it("searches by itself under 联网搜索: the tool is not offered beside it, thinking off is raised to low, and the sources and the search use are kept", async () => {
    const rig = await boot({ answer: "找到了。" });
    const flash = rig.connection("text")!;
    const profile = await call(rig.ctx, "connections.setProfile", { connectionId: flash, profile: { reasoningEffort: null } });
    expect(profile.status, JSON.stringify(profile)).toBe("ok");
    const sent = await call(rig.ctx, "agent.send", { sessionId: rig.sessionId, text: "查一下今天的新闻", allowCommands: ["web.search"] });
    expect(sent.status, JSON.stringify(sent)).toBe("ok");
    const runId = String((sent.value as { runId: string }).runId);
    const done = await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, runId);
    expect(done.value?.status, JSON.stringify(done.value?.error)).toBe("succeeded");
    const body = chatBodies(rig.server).at(-1)!;
    expect(body.thinking).toEqual({ type: "enabled" });
    expect(body.reasoning_effort).toBe("low");
    const tools = body.tools as Array<Record<string, any>>;
    expect(tools).toContainEqual({ type: "deepseek_web_search" });
    expect(tools.some((tool) => tool.function?.name === "web.search")).toBe(false);
    const stream = await call(rig.ctx, "session.stream", { sessionId: rig.sessionId });
    const answer = (stream.value as { items: Array<Record<string, any>> }).items.find((item) => item.kind === "agent")!;
    expect(answer.thinkingRaised).toBe(true);
    expect(answer.search?.length).toBeGreaterThan(0);
    expect(answer.citations?.length).toBeGreaterThan(0);
    const used = rig.ctx.app.store.sqlite.prepare("SELECT service, task, quantity, run_id FROM service_usage WHERE task = 'agent'").all();
    expect(used).toEqual([expect.objectContaining({ service: "search", run_id: runId })]);

    // The next task in the conversation sends the searched answer back with the searches the service ran, as they were given.
    const searched = chatBodies(rig.server).length;
    const next = await call(rig.ctx, "agent.send", { sessionId: rig.sessionId, text: "哪一个是官方的？" });
    await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, String((next.value as { runId: string }).runId));
    expect(chatBodies(rig.server).length).toBe(searched + 1);
    const earlier = (chatBodies(rig.server).at(-1)!.messages as Array<Record<string, any>>).filter((message) => message.role === "assistant");
    expect(earlier.at(-1)?.server_tool_calls).toEqual([expect.objectContaining({ calls: [expect.objectContaining({ id: "srv_1", type: "deepseek_web_search" })] })]);
  });

  it("switches thinking off for the small background tasks", async () => {
    const rig = await boot({ answer: "标题" });
    const llm = llmPort(rig.ctx.app);
    const connection = llm.resolve(undefined)!;
    expect(await llm.complete(connection, { system: "起个标题", user: "一段对话", temperature: 0.2 })).toBe("标题");
    const body = chatBodies(rig.server).at(-1)!;
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body).not.toHaveProperty("reasoning_effort");
  });

  it("stops a task that is under way when the plugin is turned off, and refuses the next one before any request", async () => {
    const rig = await boot({ delayMs: 1500 });
    const sent = await call(rig.ctx, "agent.send", { sessionId: rig.sessionId, text: "慢慢回答" });
    const runId = String((sent.value as { runId: string }).runId);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const disabled = await call(rig.ctx, "plugin.disable", { pluginId: "demo.provider" });
    expect(disabled.status).toBe("ok");
    const done = await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, runId);
    expect(["failed", "cancelled"]).toContain(done.value?.status);
    const before = rig.server.requests.length;
    const next = await call(rig.ctx, "agent.send", { sessionId: rig.sessionId, text: "再来" });
    if (next.status === "ok") {
      const second = await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, String((next.value as { runId: string }).runId));
      expect(second.value?.status).toBe("failed");
      expect(JSON.stringify(second.value?.error)).toContain("插件已停用");
    }
    expect(rig.server.requests.length).toBe(before);
  });
});
