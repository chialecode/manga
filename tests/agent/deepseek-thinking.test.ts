import { afterEach, describe, expect, it } from "vitest";
import { MangaError } from "@manga/contracts";
import { completeText, startMockDeepSeek, streamText, type ChatMessage, type StreamEvent, type TextRequest } from "@manga/model-protocol";

// AT-186 (计划 4.3): DeepSeek's thinking switch, effort levels and the passing back of `reasoning_content` in a tool loop, on both runtimes, against the fake
// service that refuses a tool loop without it the way the documentation says the real one does.
const tool = { name: "lookup", description: "look up a step", parameters: { type: "object", properties: { step: { type: "integer" } } } };
let server: Awaited<ReturnType<typeof startMockDeepSeek>> | undefined;
afterEach(async () => { await server?.close(); server = undefined; });

async function collect(events: AsyncGenerator<StreamEvent>) {
  let text = "";
  let reasoning = "";
  const calls = new Map<string, { name: string; arguments: string }>();
  let completed: Extract<StreamEvent, { type: "completed" }> | undefined;
  const serverTools: StreamEvent[] = [];
  for await (const event of events) {
    if (event.type === "text-delta") text += event.text;
    if (event.type === "reasoning-delta") reasoning += event.text;
    if (event.type === "server-tool") serverTools.push(event);
    if (event.type === "tool-call-delta") {
      const current = calls.get(event.callId) ?? { name: event.name, arguments: "" };
      current.arguments += event.argumentsDelta;
      calls.set(event.callId, current);
    }
    if (event.type === "completed") completed = event;
  }
  return { text, reasoning, calls, completed, serverTools };
}

describe.each(["native", "pi"] as const)("DeepSeek thinking on the %s runtime (AT-186)", (runtime) => {
  it("runs a three-step tool loop with thinking on, sending each step's reasoning back within the turn", async () => {
    server = await startMockDeepSeek({ toolScript: [1, 2, 3].map((step) => ({ name: "lookup", arguments: JSON.stringify({ step }) })), answer: "三步都查完了。" });
    const messages: ChatMessage[] = [{ role: "system", content: "use the tool three times" }, { role: "user", content: "Aria Velk?" }];
    for (let step = 0; step < 4; step += 1) {
      const request: TextRequest = { model: "deepseek-flash", messages, tools: [tool], dialect: "deepseek", reasoningEffort: "high" };
      const result = await collect(streamText("openai-chat-completions", server.url, "sk-test", request, runtime));
      if (!result.calls.size) {
        expect(result.text).toBe("三步都查完了。");
        break;
      }
      expect(result.reasoning).toBe("先想一想该怎么做。");
      for (const [id, call] of result.calls) {
        messages.push({ role: "assistant", content: "", reasoning: result.reasoning, toolCalls: [{ id, name: call.name, arguments: call.arguments }] });
        messages.push({ role: "tool", toolCallId: id, content: "a fact" });
      }
    }
    const bodies = server.requests.filter((request) => request.path.endsWith("/chat/completions")).map((request) => request.body!);
    expect(bodies).toHaveLength(4);
    for (const body of bodies) {
      expect(body.thinking).toEqual({ type: "enabled" });
      expect(body.reasoning_effort).toBe("high");
      expect(body.temperature).toBeUndefined();
    }
    const last = bodies[3]!.messages as Array<Record<string, unknown>>;
    const assistants = last.filter((message) => message.role === "assistant");
    expect(assistants).toHaveLength(3);
    for (const message of assistants) expect(message.reasoning_content).toBe("先想一想该怎么做。");
  });

  it("is refused with the service's 400 when the reasoning is not sent back, and says the switch is off when no effort is set", async () => {
    server = await startMockDeepSeek({ toolScript: [] });
    const messages: ChatMessage[] = [{ role: "user", content: "q" }, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "lookup", arguments: "{}" }] }, { role: "tool", toolCallId: "c1", content: "x" }];
    const refused = await collect(streamText("openai-chat-completions", server.url, "k", { model: "deepseek-flash", messages, tools: [tool], dialect: "deepseek", reasoningEffort: "low" }, runtime)).catch((error) => error);
    const sentAssistant = (server.requests.at(-1)!.body!.messages as Array<Record<string, unknown>>).find((message) => message.role === "assistant")!;
    if (runtime === "native") {
      expect(refused).toBeInstanceOf(MangaError);
      expect("reasoning_content" in sentAssistant).toBe(false);
    } else {
      // pi fills a missing thought with an empty one for DeepSeek (its own compat rule), which the service accepts; the loop above shows it sends the real one.
      expect(refused).not.toBeInstanceOf(MangaError);
      expect(sentAssistant.reasoning_content).toBe("");
    }
    // With thinking off nothing has to be sent back, and the switch is said explicitly.
    const plain = await completeText("openai-chat-completions", server.url, "k", { model: "deepseek-flash", messages: [{ role: "user", content: "hi" }], dialect: "deepseek", temperature: 0.2 }, runtime);
    expect(plain.text).toBe("好的，已经完成。");
    const body = server.requests.at(-1)!.body!;
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("sends dotted command ids under names the service accepts and gives the calls back under the ids", async () => {
    server = await startMockDeepSeek({ toolScript: [{ name: "library_find", arguments: JSON.stringify({ text: "猫" }) }], answer: "找到了。" });
    const tools = [{ ...tool, name: "library.find" }, { ...tool, name: "library_find" }, { ...tool, name: "log.query" }];
    const messages: ChatMessage[] = [{ role: "user", content: "找猫" }, { role: "assistant", content: "", reasoning: "r", toolCalls: [{ id: "c0", name: "log.query", arguments: "{}" }] }, { role: "tool", toolCallId: "c0", content: "ok" }];
    const result = await collect(streamText("openai-chat-completions", server.url, "sk-test", { model: "deepseek-flash", messages, tools, dialect: "deepseek", reasoningEffort: "high" }, runtime));
    const body = server.requests.find((request) => request.path.endsWith("/chat/completions"))!.body!;
    const sent = (body.tools as Array<{ function: { name: string } }>).map((item) => item.function.name);
    expect(sent).toEqual(["library_find_2", "library_find", "log_query"]);
    const back = (body.messages as Array<{ tool_calls?: Array<{ function: { name: string } }> }>).flatMap((message) => message.tool_calls ?? []).map((call) => call.function.name);
    expect(back).toEqual(["log_query"]);
    // The model called the wire name of the tool that is already called `library_find`, and it comes back as that tool.
    expect([...result.calls.values()].map((call) => call.name)).toEqual(["library_find"]);
  });

  it("says why the service refused a request", async () => {
    server = await startMockDeepSeek({});
    const raw = await fetch(`${server.url}/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-flash", messages: [], tools: [{ type: "function", function: { name: "a.b", parameters: {} } }] }) });
    const { mapHttpError } = await import("@manga/model-protocol");
    const error = mapHttpError(raw.status, await raw.text());
    expect(error.message).toBe("provider HTTP 400: Invalid 'tools[0].function.name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.");
    expect(error.details).toMatchObject({ status: 400 });
  });

  it("maps the effort names onto low, high and max", async () => {
    server = await startMockDeepSeek();
    const sent: unknown[] = [];
    for (const effort of ["minimal", "low", "medium", "high", "max"] as const) {
      await completeText("openai-chat-completions", server.url, "k", { model: "deepseek-flash", messages: [{ role: "user", content: "hi" }], dialect: "deepseek", reasoningEffort: effort }, runtime);
      sent.push(server.requests.at(-1)!.body!.reasoning_effort);
    }
    expect(sent).toEqual(["low", "low", "high", "high", "max"]);
  });

  it("does not send an earlier turn's reasoning back", async () => {
    server = await startMockDeepSeek();
    await completeText("openai-chat-completions", server.url, "k", {
      model: "deepseek-flash", dialect: "deepseek", reasoningEffort: "high",
      messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b", reasoning: "old thought" }, { role: "user", content: "c" }],
    }, runtime);
    const sentMessages = server.requests.at(-1)!.body!.messages as Array<Record<string, unknown>>;
    expect(JSON.stringify(sentMessages)).not.toContain("old thought");
  });
});

describe("the built-in web search on the native runtime (AT-187)", () => {
  it("offers deepseek_web_search beside the functions, reads its progress, citations and server_tool_calls, and sends them back", async () => {
    server = await startMockDeepSeek({ answer: "示例答案，有来源。" });
    const result = await collect(streamText("openai-chat-completions", server.url, "k", { model: "deepseek-flash", messages: [{ role: "user", content: "最近的新闻" }], tools: [tool], dialect: "deepseek", reasoningEffort: "low", nativeWebSearch: true }));
    const tools = server.requests.at(-1)!.body!.tools as Array<{ type: string }>;
    expect(tools.map((item) => item.type)).toEqual(["function", "deepseek_web_search"]);
    expect(result.serverTools.map((event) => event.type === "server-tool" ? event.event.kind : "")).toEqual(["search", "done", "open", "done"]);
    expect(result.completed?.citations?.[0]).toMatchObject({ url: "https://example.org/a", title: "示例来源 A" });
    expect(result.completed?.usage).toMatchObject({ searches: 1, cachedInputTokens: 4, inputTokens: 12 });
    expect(result.completed?.serverToolCalls).toHaveLength(1);
    await completeText("openai-chat-completions", server.url, "k", {
      model: "deepseek-flash", dialect: "deepseek", reasoningEffort: "low", nativeWebSearch: true,
      messages: [{ role: "user", content: "最近的新闻" }, { role: "assistant", content: result.text, serverToolCalls: result.completed!.serverToolCalls }, { role: "user", content: "哪一个是官方的？" }],
    });
    const assistant = (server.requests.at(-1)!.body!.messages as Array<Record<string, unknown>>).find((message) => message.role === "assistant")!;
    expect(assistant.server_tool_calls).toEqual(result.completed!.serverToolCalls);
  });

  it("treats an error in the middle of a stream and the content filter as failures", async () => {
    server = await startMockDeepSeek({ streamError: true });
    await expect(collect(streamText("openai-chat-completions", server.url, "k", { model: "deepseek-flash", messages: [{ role: "user", content: "x" }], dialect: "deepseek" }))).rejects.toMatchObject({ details: { kind: "stream_error" } });
    server.options.contentFilter = true;
    await expect(completeText("openai-chat-completions", server.url, "k", { model: "deepseek-flash", messages: [{ role: "user", content: "x" }], dialect: "deepseek" })).rejects.toMatchObject({ message: "内容被服务拒绝" });
    server.options.fail = [];
  });

  it("calls an empty balance billing and an overloaded service busy", async () => {
    server = await startMockDeepSeek({ fail: [{ path: "/chat/completions", status: 402 }, { path: "/chat/completions", status: 503 }] });
    await expect(completeText("openai-chat-completions", server.url, "k", { model: "deepseek-flash", messages: [{ role: "user", content: "x" }], dialect: "deepseek" })).rejects.toMatchObject({ details: { kind: "billing", status: 402 } });
    await expect(completeText("openai-chat-completions", server.url, "k", { model: "deepseek-flash", messages: [{ role: "user", content: "x" }], dialect: "deepseek" })).rejects.toMatchObject({ details: { kind: "busy", status: 503 } });
  });
});
