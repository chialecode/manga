import { afterEach, describe, expect, it } from "vitest";
import { startMockProvider } from "@manga/model-protocol";
import { startApp, waitForRun } from "../helpers/app.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
let counter = 0;
const apps: App[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (apps.length) apps.pop()!.app.close();
  while (closers.length) await closers.pop()!();
});

async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  const server = await startMockProvider({ mode: "ok" });
  closers.push(server.close);
  const created = await run(ctx, "connections.upsert", { label: "文本", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "m", purpose: "text", credentialHandle: ctx.app.stashSecret("credential-conv") });
  ok(created);
  return ctx;
}
async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `conv-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
type View = { sessionId: string; title: string; mode: string; runCount: number };
const current = async (ctx: App, mode: "enthusiast" | "creator") => ok<{ conversation: View | null }>(await run(ctx, "conversation.current", { mode })).conversation;
const say = async (ctx: App, sessionId: string, text: string) => {
  const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId, text }));
  await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
};

describe("the entertainment mode's one global conversation (AT-75)", () => {
  it("has one current conversation; a new one moves the old into the history, where it can be read and continued", async () => {
    const ctx = await boot();
    expect(await current(ctx, "enthusiast")).toBeNull();
    const first = ok<{ sessionId: string; reused: boolean }>(await run(ctx, "conversation.new", { mode: "enthusiast" }));
    expect(first.reused).toBe(false);
    expect((await current(ctx, "enthusiast"))?.sessionId).toBe(first.sessionId);
    // Pressing the button again with nothing said does not leave an empty conversation behind.
    expect(ok<{ sessionId: string; reused: boolean }>(await run(ctx, "conversation.new", { mode: "enthusiast" }))).toMatchObject({ sessionId: first.sessionId, reused: true });
    expect(ok<{ items: unknown[] }>(await run(ctx, "conversation.history", { mode: "enthusiast" })).items).toEqual([]);

    await say(ctx, first.sessionId, "第一段对话里的第一句话，说得比较长一些，用来看摘要是不是被截短了。".repeat(4));
    const second = ok<{ sessionId: string; reused: boolean }>(await run(ctx, "conversation.new", { mode: "enthusiast" }));
    expect(second.reused).toBe(false);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect((await current(ctx, "enthusiast"))?.sessionId).toBe(second.sessionId);

    const history = ok<{ current: string; items: Array<{ sessionId: string; excerpt: string; runCount: number; updatedAt: string }> }>(await run(ctx, "conversation.history", { mode: "enthusiast" }));
    expect(history.current).toBe(second.sessionId);
    expect(history.items.map((item) => item.sessionId)).toEqual([first.sessionId]);
    expect(history.items[0]!.runCount).toBe(1);
    expect(history.items[0]!.excerpt.startsWith("第一段对话里的第一句话")).toBe(true);
    expect(history.items[0]!.excerpt.endsWith("…")).toBe(true);

    // Continuing it makes it the current one; the other goes to the history. Nothing is deleted.
    const resumed = ok<{ conversation: View }>(await run(ctx, "conversation.resume", { sessionId: first.sessionId }));
    expect(resumed.conversation.sessionId).toBe(first.sessionId);
    expect((await current(ctx, "enthusiast"))?.sessionId).toBe(first.sessionId);
    expect(ok<{ items: Array<{ sessionId: string }> }>(await run(ctx, "conversation.history", { mode: "enthusiast" })).items.map((item) => item.sessionId)).toEqual([second.sessionId]);
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE kind = 'shared'").get()).toEqual({ n: 2 });
    await say(ctx, first.sessionId, "继续说");
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ?").get(first.sessionId)).toEqual({ n: 2 });
  });

  it("keeps the two modes' conversations apart, and leaves resource, note and project sessions out of the history", async () => {
    const ctx = await boot();
    const fun = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { mode: "enthusiast" }));
    const work = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { mode: "creator" }));
    expect(fun.sessionId).not.toBe(work.sessionId);
    expect((await current(ctx, "enthusiast"))?.sessionId).toBe(fun.sessionId);
    expect((await current(ctx, "creator"))?.sessionId).toBe(work.sessionId);
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "不进历史" }));
    ok(await run(ctx, "session.open", { kind: "project", targetId: project.id, mode: "creator" }));
    await say(ctx, fun.sessionId, "娱乐模式的话");
    await run(ctx, "conversation.new", { mode: "enthusiast" });
    const items = (mode: string) => ok<{ items: Array<{ sessionId: string }> }>(awaitedHistory[mode]!).items.map((item) => item.sessionId);
    const awaitedHistory: Record<string, Call> = {
      enthusiast: await run(ctx, "conversation.history", { mode: "enthusiast" }),
      creator: await run(ctx, "conversation.history", { mode: "creator" }),
    };
    expect(items("enthusiast")).toEqual([fun.sessionId]);
    expect(items("creator")).toEqual([]);
    // Only a general conversation can be continued from the history.
    const sessionOfProject = ctx.app.store.sqlite.prepare("SELECT id FROM agent_sessions WHERE kind = 'project'").get() as { id: string };
    expect((await run(ctx, "conversation.resume", { sessionId: sessionOfProject.id })).status).toBe("error");
    expect((await run(ctx, "conversation.resume", { sessionId: "ses-none" })).error?.code).toBe("NOT_FOUND");
  });

  it("makes the most recent conversation of an older profile the current one and lists the rest as history, deleting nothing", async () => {
    const ctx = await boot();
    const ids: string[] = [];
    for (const title of ["旧对话一", "旧对话二", "旧对话三"]) ids.push(ok<{ id: string }>(await run(ctx, "agent.createSession", { title, mode: "enthusiast" })).id);
    const stamps = ["2026-08-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z", "2026-07-01T10:00:00.000Z"];
    ids.forEach((id, index) => ctx.app.store.sqlite.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(stamps[index], id));
    // A conversation from before modes existed counts as the entertainment mode's.
    const legacy = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "更早的" }));
    ctx.app.store.sqlite.prepare("UPDATE agent_sessions SET updated_at = ?, mode = NULL WHERE id = ?").run("2026-06-01T10:00:00.000Z", legacy.id);

    expect((await current(ctx, "enthusiast"))?.sessionId).toBe(ids[1]);
    const history = ok<{ items: Array<{ sessionId: string }> }>(await run(ctx, "conversation.history", { mode: "enthusiast" }));
    expect(history.items.map((item) => item.sessionId)).toEqual([ids[0], ids[2], legacy.id]);
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_sessions").get()).toEqual({ n: 4 });
    // It is a record: the choice stays the same on the next look, even though a newer conversation appears.
    const newer = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "新建的", mode: "enthusiast" }));
    expect((await current(ctx, "enthusiast"))?.sessionId).toBe(ids[1]);
    expect(newer.id).not.toBe(ids[1]);
  });
});
