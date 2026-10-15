import { afterEach, describe, expect, it } from "vitest";
import { MangaError } from "@manga/contracts";
import { startMockProvider, type ChatMessage } from "@manga/model-protocol";
import {
  budgetOf, calibrate, COMPACTION_PROMPT, contextTokens, estimateTokens, fitContext, SUMMARY_MARK, tailToTokens, truncateToTokens,
} from "../../packages/app-core/src/agent-context.ts";
import { startApp, waitForRun } from "../helpers/app.ts";

/**
 * AT-95. What a task sends is counted in tokens against the model's window, less the answer and a margin. Old tool results are cut down first, then the older
 * conversation becomes a summary the model writes (three tries, then the task stops with the reason); a service that still refuses the request as too long is
 * believed. The step and time limits stop a task with the reason and the way out. Both runtimes build the request from the same messages, so one test serves them.
 */

const cjk = (count: number, from = 0) => Array.from({ length: count }, (_, index) => String.fromCharCode(0x4e00 + ((index + from) % 2000))).join("");
const user = (content: string): ChatMessage => ({ role: "user", content });
const system = (content: string): ChatMessage => ({ role: "system", content });
const assistant = (content: string): ChatMessage => ({ role: "assistant", content });
const call = (id: string): ChatMessage => ({ role: "assistant", content: "", toolCalls: [{ id, name: "notes.get", arguments: "{}" }] });
const result = (id: string, content: string): ChatMessage => ({ role: "tool", toolCallId: id, content });

describe("counting the context in tokens", () => {
  it("counts a Chinese character as one and about three and a half letters as one, with a frame around every message", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(cjk(100))).toBe(100);
    expect(estimateTokens("a".repeat(350))).toBe(100);
    expect(contextTokens([user("你好")])).toBe(2 + 4);
    // A picture costs about a thousand; the tools of a request count too.
    expect(contextTokens([{ role: "user", content: "", images: [{ mediaType: "image/png", base64: "AAAA" }] }])).toBeGreaterThan(1_000);
    expect(contextTokens([user("你好")], [{ name: "find", description: "查找", parameters: { type: "object" } }])).toBeGreaterThan(contextTokens([user("你好")]));
    // The estimate is scaled by what a service said it counted.
    expect(contextTokens([user(cjk(100))], undefined, 1.5)).toBe(Math.ceil(104 * 1.5));
  });

  it("takes the window less the answer and a margin of a twentieth, and at least four thousand tokens", () => {
    expect(budgetOf({ contextWindow: 128_000, maxOutput: 8_192 })).toMatchObject({ contextTokens: 128_000 - 8_192 - 6_400, margin: 6_400 });
    expect(budgetOf({ contextWindow: 32_000, maxOutput: 4_000 })).toMatchObject({ contextTokens: 24_000, margin: 4_000 });
    // A window that leaves nothing after the answer and the margin still gets a quarter of itself, or the task could never start.
    expect(budgetOf({ contextWindow: 4_096, maxOutput: 256 }).contextTokens).toBe(1_024);
  });

  it("cuts at a character and never inside one", () => {
    const text = `${cjk(50)}😀${cjk(50, 7)}`;
    for (const tokens of [3, 20, 51, 52, 80]) {
      const cut = truncateToTokens(text, tokens);
      expect(estimateTokens(cut.text)).toBeLessThanOrEqual(tokens);
      expect(cut.text).toBe([...text].slice(0, [...cut.text].length).join(""));
      expect(cut.cut).toBe(true);
      const tail = tailToTokens(text, tokens);
      expect(tail.includes("�")).toBe(false);
      expect(estimateTokens(tail.replace(/^（更早的部分已省略）\n/, ""))).toBeLessThanOrEqual(tokens);
    }
    expect(truncateToTokens("短", 5)).toEqual({ text: "短", cut: false });
    expect(truncateToTokens("短", 0)).toEqual({ text: "", cut: true });
  });

  it("scales the estimates by what a service counted, within reason", () => {
    expect(calibrate(1, undefined, 100)).toBe(1);
    expect(calibrate(1, 150, 100)).toBe(1.25);
    expect(calibrate(1, 10_000, 100)).toBeLessThanOrEqual(1.5);
    expect(calibrate(1, 1, 100)).toBeGreaterThanOrEqual(0.8);
  });
});

describe("making a request fit", () => {
  const never = async () => { throw new Error("no summary should be asked for"); };

  it("sends what already fits as it is", async () => {
    const messages = [system("材料"), user("问题")];
    const fit = await fitContext({ messages, budget: budgetOf({ contextWindow: 128_000, maxOutput: 8_192 }), summarize: never });
    expect(fit.messages).toBe(messages);
    expect(fit).toMatchObject({ trimmed: 0, compacted: null });
  });

  it("cuts down the tool results from before the newest three, then leaves the rest whole", async () => {
    const big = cjk(3_000);
    const messages: ChatMessage[] = [user("问题")];
    for (let index = 0; index < 5; index += 1) messages.push(call(`c${index}`), result(`c${index}`, big));
    const budget = { contextWindow: 20_000, contextTokens: 13_500, maxOutputTokens: 1_000, margin: 4_000 };
    const fit = await fitContext({ messages, budget, summarize: never });
    expect(fit.compacted).toBeNull();
    expect(fit.trimmed).toBe(2);
    const tools = fit.messages.filter((message) => message.role === "tool");
    expect(tools.slice(0, 2).every((message) => message.content.includes("已截短") && message.content.length < 2_100)).toBe(true);
    expect(tools.slice(2).every((message) => message.content === big)).toBe(true);
    expect(fit.tokensAfter).toBeLessThanOrEqual(13_500);
  });

  it("replaces the older conversation with a summary the model writes, keeping the question and the newest exchange", async () => {
    const big = cjk(3_000);
    const messages: ChatMessage[] = [system("材料"), user("较早的问题"), assistant("较早的回答"), user("现在的问题"), call("a"), result("a", big), call("b"), result("b", big)];
    const asked: Array<{ transcript: string; attempt: number }> = [];
    const budget = { contextWindow: 20_000, contextTokens: 3_600, maxOutputTokens: 1_000, margin: 4_000 };
    const fit = await fitContext({ messages, budget, summarize: async (transcript, attempt) => { asked.push({ transcript, attempt }); return "摘要：问过一个问题，查过一篇笔记。"; } });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.transcript).toContain("较早的问题");
    expect(asked[0]!.transcript).not.toContain("现在的问题");
    expect(fit.compacted).toMatchObject({ attempts: 1, replaced: 4 });
    const roles = fit.messages.map((message) => message.role);
    expect(fit.messages.find((message) => message.content.startsWith(SUMMARY_MARK))?.content).toContain("摘要");
    expect(fit.messages.some((message) => message.content === "现在的问题")).toBe(true);
    expect(fit.messages.filter((message) => message.role === "tool")).toHaveLength(1);
    expect(roles.includes("assistant")).toBe(true);
    // The material is still there, ahead of the summary.
    expect(fit.messages[0]).toEqual(system("材料"));
    expect(fit.tokensAfter).toBeLessThanOrEqual(3_600);
  });

  it("tries the summary three times in a row, then stops the task and says what to do", async () => {
    const big = cjk(3_000);
    const messages: ChatMessage[] = [user("较早的问题"), assistant("较早的回答"), user("现在的问题"), call("a"), result("a", big), call("b"), result("b", big)];
    const budget = { contextWindow: 20_000, contextTokens: 3_600, maxOutputTokens: 1_000, margin: 4_000 };
    // Failing by throwing and failing by saying nothing are the same.
    const attempts: number[] = [];
    const failing = fitContext({ messages, budget, summarize: async (_transcript, attempt) => { attempts.push(attempt); if (attempt === 2) return "  "; throw new MangaError("PROVIDER_UNAVAILABLE", "boom"); } });
    await expect(failing).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", details: { reason: "compaction_failed", attempts: 3 } });
    expect(attempts).toEqual([1, 2, 3]);
    await expect(fitContext({ messages, budget, summarize: async () => "" })).rejects.toThrow(/连续失败了 3 次.*换一个上下文窗口更大的模型/s);
    // A cancelled run is not a failed summary.
    await expect(fitContext({ messages, budget, summarize: async () => { throw new MangaError("CANCELLED", "run cancelled"); } })).rejects.toMatchObject({ code: "CANCELLED" });
    // One success after two failures is a success.
    let tries = 0;
    const third = await fitContext({ messages, budget, summarize: async () => { tries += 1; if (tries < 3) throw new Error("again"); return "摘要"; } });
    expect(third.compacted).toMatchObject({ attempts: 3 });
  });

  it("cuts the biggest result or the material by only what is missing, never the question, and stops a task that cannot fit", async () => {
    const material = system(cjk(5_000));
    const question = user("问题");
    const budget = { contextWindow: 20_000, contextTokens: 1_500, maxOutputTokens: 1_000, margin: 4_000 };
    const fit = await fitContext({ messages: [material, question], budget, summarize: never });
    expect(fit.messages[0]!.content).toContain("材料超出长度预算");
    expect(fit.messages[1]).toBe(question);
    expect(fit.tokensAfter).toBeLessThanOrEqual(1_500);
    expect(fit.tokensAfter).toBeGreaterThan(1_300);
    // The question itself is too long for the window: nothing can be cut that the task still needs.
    const refused = fitContext({ messages: [user(cjk(5_000))], budget, summarize: never });
    await expect(refused).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", details: { reason: "context_too_large", budgetTokens: 1_500 } });
    await expect(refused).rejects.toThrow(/开一个新对话/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
let counter = 0;
const apps: App[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (apps.length) apps.pop()!.app.close();
  while (closers.length) await closers.pop()!();
});
async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `budget-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(value: Call): T {
  expect(value.status, JSON.stringify(value)).toBe("ok");
  return value.value as T;
}

type Seen = { url: string; body: Record<string, any> };
type Answer = ReturnType<NonNullable<NonNullable<Parameters<typeof startMockProvider>[0]>["respond"]>>;
/** The compaction request opens with its instructions: as a system message, or, under PI, as the first message that says so. */
const isSummary = (body: Record<string, any>) => {
  const first = (body.messages as Array<{ content: unknown }> | undefined)?.[0]?.content;
  return first === COMPACTION_PROMPT || first === `System: ${COMPACTION_PROMPT}`;
};
const bodyTokens = (body: Record<string, any>) => ((body.messages ?? []) as Array<{ content: unknown }>).reduce((sum, message) => sum + estimateTokens(typeof message.content === "string" ? message.content : JSON.stringify(message.content)) + 4, 0) + estimateTokens(JSON.stringify(body.tools ?? []));

async function scenario(options: {
  runtime?: "native" | "pi";
  profile?: Record<string, unknown>;
  script?: Array<{ name: string; arguments: string }>;
  respond?: (body: Record<string, any>, seen: Seen[]) => Answer;
  mode?: "always-tools";
}) {
  const ctx = await startApp();
  apps.push(ctx);
  // A task runs under the runtime that is set when it is sent; the connection's own setting is for its test.
  ok(await run(ctx, "settings.setRuntime", { runtime: options.runtime ?? "native" }));
  const seen: Seen[] = [];
  const server = await startMockProvider({
    ...(options.script ? { streamToolScript: options.script } : {}),
    ...(options.mode ? { mode: options.mode, streamToolName: "library.find", streamToolArguments: '{"text":"x"}' } : {}),
    onRequest: (request) => { seen.push(request as Seen); },
    respond: (request) => options.respond?.(request.body, seen),
  });
  closers.push(server.close);
  const connection = ok<{ id: string }>(await run(ctx, "connections.upsert", {
    label: "m", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", runtime: options.runtime ?? "native",
    credentialHandle: ctx.app.stashSecret("credential-budget-value"), ...(options.profile ? { profile: options.profile } : {}),
  }));
  const session = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "t" }));
  return { ctx, seen, connection, session, close: server.close };
}

describe.each(["native", "pi"] as const)("a task within its budget, under the %s runtime", (runtime) => {
  async function withNotes(profile: Record<string, unknown>, respond: (body: Record<string, any>, seen: Seen[]) => Answer) {
    const ctx = await startApp();
    apps.push(ctx);
    ok(await run(ctx, "settings.setRuntime", { runtime }));
    const seen: Seen[] = [];
    // A frozen note is cut at 8 000 characters, so two of them are the weight of the material of a task.
    const first = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "甲", text: cjk(8_000) }));
    const second = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "乙", text: cjk(8_000, 99) }));
    const server = await startMockProvider({ onRequest: (request) => { seen.push(request as Seen); }, respond: (request) => respond(request.body, seen) });
    closers.push(server.close);
    const connection = ok<{ id: string }>(await run(ctx, "connections.upsert", {
      label: "m", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", runtime,
      credentialHandle: ctx.app.stashSecret("credential-budget-value"), profile,
    }));
    const session = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "t" }));
    const send = async (text: string, extra: Record<string, unknown> = {}) => {
      const sent = ok<Record<string, any>>(await run(ctx, "agent.send", { sessionId: session.id, text, ...extra }));
      return waitForRun(ctx.app, ctx.actor, ctx.grant.handle, String(sent.runId), 30_000);
    };
    return { ctx, seen, connection, session, send, first, second };
  }

  // A window of 32k with 2k for the answer leaves 26 720 tokens, and the tools take 3 400 of them. A smaller model after the task was sent leaves 14 000.
  const window = { contextWindow: 32_768, maxOutput: 2_048 };
  const smaller = { contextWindow: 20_000, maxOutput: 2_000 };
  const long = (body: Record<string, any>) => /第[一二]个问题/.test(JSON.stringify(body.messages)) && !JSON.stringify(body.messages).includes("读这两篇笔记");

  /**
   * Two earlier exchanges with long answers, then a task with two notes that a model refuses once (so the task fails), then the model is changed to a smaller one and the
   * task is run again: what was frozen for it no longer fits, and the history is what gives.
   */
  async function overTheWindow(respond: (body: Record<string, any>) => Answer) {
    let refuseTask = true;
    const t = await withNotes(window, (body) => {
      if (isSummary(body)) return respond(body);
      if (long(body)) return { text: "答".repeat(4_000) };
      if (refuseTask && JSON.stringify(body.messages).includes("读这两篇笔记")) { refuseTask = false; return { status: 500, message: "boom" }; }
      return undefined;
    });
    for (const question of ["第一个问题", "第二个问题"]) expect((await t.send(question)).value?.status).toBe("succeeded");
    const first = await t.send("读这两篇笔记，再告诉我读完了", { noteObjectIds: [t.first.objectId, t.second.objectId] });
    expect(first.value?.status).toBe("failed");
    ok(await run(t.ctx, "connections.setProfile", { connectionId: t.connection.id, profile: smaller }));
    ok(await run(t.ctx, "agent.retry", { runId: first.value?.runId }));
    return { t, finished: await waitForRun(t.ctx.app, t.ctx.actor, t.ctx.grant.handle, String(first.value?.runId), 30_000) };
  }

  it("makes the request smaller by summarizing the earlier conversation, and the task goes on to its answer", async () => {
    const summaries: Array<Record<string, any>> = [];
    const { t, finished } = await overTheWindow((body) => { summaries.push(body); return { text: "摘要：前两个问题都回答过了。" }; });
    expect(finished.value?.status, JSON.stringify(finished.value?.error)).toBe("succeeded");
    expect(finished.value?.usage).toMatchObject({ compactions: 1 });
    expect(summaries).toHaveLength(1);
    // The summary request is about the conversation and says nothing of tools.
    expect(summaries[0]!.tools).toBeUndefined();
    expect(JSON.stringify(summaries[0]!.messages)).toContain("第一个问题");
    const requests = t.seen.filter((request) => !isSummary(request.body)).map((request) => request.body);
    const last = requests.at(-1)!;
    expect(JSON.stringify(last.messages)).toContain(SUMMARY_MARK);
    expect(JSON.stringify(last.messages)).toContain("读这两篇笔记");
    // The earlier answers are not in it any more; the notes, cut to their share, are.
    expect(JSON.stringify(last.messages)).not.toContain("答".repeat(100));
    expect(JSON.stringify(last.messages)).toContain(cjk(200, 99));
    expect(bodyTokens(last)).toBeLessThanOrEqual(budgetOf({ contextWindow: 20_000, maxOutput: 2_000 }).contextTokens * 1.1);
    expect(finished.value?.text).toContain("hello");
  });

  it("stops after three summaries that failed, with the reason and what to do", async () => {
    let asked = 0;
    const { finished } = await overTheWindow(() => { asked += 1; return { status: 500, message: "boom" }; });
    expect(finished.value?.status).toBe("failed");
    const error = finished.value?.error as { code: string; message: string; details: Record<string, unknown> };
    expect(error.code).toBe("BUDGET_EXCEEDED");
    expect(error.message).toContain("连续失败了 3 次");
    expect(error.message).toContain("换一个上下文窗口更大的模型");
    expect(error.details).toMatchObject({ reason: "compaction_failed", attempts: 3 });
    expect(asked).toBe(3);
  });

  it("believes a service that says the request is too long, cuts it and asks again", async () => {
    const limit = 6_500;
    let refusals = 0;
    // The profile claims a window far larger than the model has: the service refuses what is over its own limit, as the real ones do.
    const t = await withNotes({ contextWindow: 128_000, maxOutput: 4_000 }, (body) => {
      if (isSummary(body)) return { text: "摘要" };
      if (bodyTokens(body) > limit) { refusals += 1; return { status: 400, message: "This model's maximum context length is 4097 tokens. However, your messages resulted in more tokens." }; }
      return undefined;
    });
    const noteId = t.first.objectId;
    const finished = await t.send("请看这篇笔记", { noteObjectIds: [noteId] });
    expect(finished.value?.status, JSON.stringify(finished.value?.error)).toBe("succeeded");
    expect(refusals).toBeGreaterThanOrEqual(2);
    const bodies = t.seen.map((request) => request.body);
    expect(bodyTokens(bodies.at(-1)!)).toBeLessThanOrEqual(limit);
    expect(JSON.stringify(bodies.at(-1)!.messages)).toContain("材料超出长度预算");
  });

  it("tells the person to correct the window when the service keeps refusing", async () => {
    const t = await withNotes({ contextWindow: 128_000, maxOutput: 4_000 }, (body) => (isSummary(body) ? { text: "摘要" } : { status: 400, message: "maximum context length exceeded" }));
    const finished = await t.send("请看这篇笔记", { noteObjectIds: [t.first.objectId] });
    expect(finished.value?.status).toBe("failed");
    const error = finished.value?.error as { code: string; message: string; details: Record<string, unknown> };
    expect(error.code).toBe("BUDGET_EXCEEDED");
    expect(error.message).toContain("上下文窗口");
    expect(error.details).toMatchObject({ reason: "service_refused_context", contextWindow: 128_000 });
  });

  it("runs a model whose window cannot hold the tools as a plain conversation, and says so", async () => {
    const t = await withNotes({ contextWindow: 8_192, maxOutput: 256 }, () => undefined);
    const finished = await t.send("你好");
    expect(finished.value?.status).toBe("succeeded");
    expect(finished.value?.usage).toMatchObject({ toolsOmitted: true });
    for (const request of t.seen) expect(request.body.tools).toBeUndefined();
    // The same model with room for them is offered the tools.
    const roomy = await withNotes({ contextWindow: 64_000, maxOutput: 4_000 }, () => undefined);
    expect((await roomy.send("你好")).value?.status).toBe("succeeded");
    expect(roomy.seen.some((request) => Array.isArray(request.body.tools))).toBe(true);
  });
});

describe("the limits of a task", () => {
  it("stops at the steps the person allowed, says how many, and goes on after they are raised", async () => {
    const { ctx, close } = await scenario({ mode: "always-tools" });
    ok(await run(ctx, "settings.setAgent", { limits: { maxSteps: 2 } }));
    expect(ok<Record<string, any>>(await run(ctx, "settings.getAgent", {})).limits).toMatchObject({ maxSteps: 2, maxDurationMs: 600_000 });
    const session = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "t" }));
    const sent = ok<Record<string, any>>(await run(ctx, "agent.send", { sessionId: session.id, text: "一直找" }));
    expect(sent.status).toBe("running");
    const first = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, String(sent.runId));
    expect(first.value?.status).toBe("failed");
    expect(first.value?.error).toMatchObject({ code: "BUDGET_EXCEEDED", details: { reason: "max_steps", limit: 2 } });
    expect((first.value?.error as { message: string }).message).toContain("2 步");
    expect((first.value?.error as { message: string }).message).toContain("智能体");
    expect(first.value?.budget).toMatchObject({ maxSteps: 2 });
    // Raised, the same task goes on from where it stopped.
    ok(await run(ctx, "settings.setAgent", { limits: { maxSteps: 4 } }));
    ok(await run(ctx, "agent.retry", { runId: sent.runId }));
    const again = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, String(sent.runId));
    expect(again.value?.status).toBe("failed");
    expect(again.value?.error).toMatchObject({ details: { reason: "max_steps", limit: 4 } });
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_tool_events WHERE run_id = ?").get(String(sent.runId))).toMatchObject({ n: 4 });
    await close();
  });

  it("stops at the time the person allowed and says so", async () => {
    const { ctx, close } = await scenario({ mode: "always-tools" });
    ok(await run(ctx, "settings.setAgent", { limits: { maxSteps: 1 } }));
    const session = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "t" }));
    const sent = ok<Record<string, any>>(await run(ctx, "agent.send", { sessionId: session.id, text: "找" }));
    await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, String(sent.runId));
    // The deadline was set when the task began; a retry does not extend it. Here it has passed.
    ctx.app.store.sqlite.prepare("UPDATE agent_runs SET deadline_at = ? WHERE id = ?").run(new Date(Date.now() - 5_000).toISOString(), String(sent.runId));
    ok(await run(ctx, "settings.setAgent", { limits: { maxSteps: 20 } }));
    ok(await run(ctx, "agent.retry", { runId: sent.runId }));
    const finished = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, String(sent.runId));
    expect(finished.value?.status).toBe("failed");
    expect(finished.value?.error).toMatchObject({ code: "BUDGET_EXCEEDED", details: { reason: "max_duration" } });
    expect((finished.value?.error as { message: string }).message).toContain("分钟");
    await close();
  });

  it("refuses limits outside what makes sense", async () => {
    const ctx = await startApp();
    apps.push(ctx);
    for (const limits of [{ maxSteps: 0 }, { maxSteps: 500 }, { maxDurationMs: 1_000 }, { maxDurationMs: 10 * 60 * 60_000 }]) {
      expect((await run(ctx, "settings.setAgent", { limits })).status, JSON.stringify(limits)).toBe("error");
    }
    expect((await run(ctx, "settings.setAgent", { limits: { maxSteps: 12 }, trace: { retentionDays: 7 } })).status).toBe("ok");
    expect(ok<Record<string, any>>(await run(ctx, "settings.getAgent", {}))).toMatchObject({ limits: { maxSteps: 12 }, trace: { mode: "full", retentionDays: 7, maxMegabytes: 500 } });
  });
});
