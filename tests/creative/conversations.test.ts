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
type View = { sessionId: string; title: string; contextId: string | null; runCount: number };
/** The conversation that is current in a context: a project's id, or null for "最近". */
const current = async (ctx: App, contextId: string | null) => ok<{ conversation: View | null }>(await run(ctx, "conversation.current", { contextId })).conversation;
const say = async (ctx: App, sessionId: string, text: string) => {
  const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId, text }));
  await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
};

describe("the general conversation of 最近 (AT-75)", () => {
  it("has one current conversation; a new one moves the old into the history, where it can be read and continued", async () => {
    const ctx = await boot();
    expect(await current(ctx, null)).toBeNull();
    const first = ok<{ sessionId: string; reused: boolean }>(await run(ctx, "conversation.new", { contextId: null }));
    expect(first.reused).toBe(false);
    expect((await current(ctx, null))?.sessionId).toBe(first.sessionId);
    // Pressing the button again with nothing said does not leave an empty conversation behind.
    expect(ok<{ sessionId: string; reused: boolean }>(await run(ctx, "conversation.new", { contextId: null }))).toMatchObject({ sessionId: first.sessionId, reused: true });
    expect(ok<{ items: unknown[] }>(await run(ctx, "conversation.history", { contextId: null })).items).toEqual([]);

    await say(ctx, first.sessionId, "第一段对话里的第一句话，说得比较长一些，用来看摘要是不是被截短了。".repeat(4));
    const second = ok<{ sessionId: string; reused: boolean }>(await run(ctx, "conversation.new", { contextId: null }));
    expect(second.reused).toBe(false);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect((await current(ctx, null))?.sessionId).toBe(second.sessionId);

    const history = ok<{ current: string; items: Array<{ sessionId: string; excerpt: string; runCount: number; updatedAt: string }> }>(await run(ctx, "conversation.history", { contextId: null }));
    expect(history.current).toBe(second.sessionId);
    expect(history.items.map((item) => item.sessionId)).toEqual([first.sessionId]);
    expect(history.items[0]!.runCount).toBe(1);
    expect(history.items[0]!.excerpt.startsWith("第一段对话里的第一句话")).toBe(true);
    expect(history.items[0]!.excerpt.endsWith("…")).toBe(true);

    // Continuing it makes it the current one; the other goes to the history. Nothing is deleted.
    const resumed = ok<{ conversation: View }>(await run(ctx, "conversation.resume", { sessionId: first.sessionId }));
    expect(resumed.conversation.sessionId).toBe(first.sessionId);
    expect((await current(ctx, null))?.sessionId).toBe(first.sessionId);
    expect(ok<{ items: Array<{ sessionId: string }> }>(await run(ctx, "conversation.history", { contextId: null })).items.map((item) => item.sessionId)).toEqual([second.sessionId]);
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE kind = 'shared'").get()).toEqual({ n: 2 });
    await say(ctx, first.sessionId, "继续说");
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ?").get(first.sessionId)).toEqual({ n: 2 });
  });

  it("keeps the conversations of 最近 and of a project apart, and leaves resource, note and project-bound sessions out of the history", async () => {
    const ctx = await boot();
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "不进历史" }));
    const recent = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { contextId: null }));
    const inProject = ok<{ sessionId: string; kind: string }>(await run(ctx, "conversation.new", { contextId: project.id }));
    expect(recent.sessionId).not.toBe(inProject.sessionId);
    // A project's conversation is of the `project` kind; "最近" has `shared` ones.
    expect(inProject.kind).toBe("project");
    expect((await current(ctx, null))?.sessionId).toBe(recent.sessionId);
    expect((await current(ctx, project.id))?.sessionId).toBe(inProject.sessionId);
    // The conversation a project page is bound to is the project's current one, not a second one.
    expect(ok<{ id: string; reused: boolean }>(await run(ctx, "session.open", { kind: "project", targetId: project.id, contextId: project.id }))).toMatchObject({ id: inProject.sessionId, reused: true });
    await say(ctx, recent.sessionId, "最近里的话");
    await run(ctx, "conversation.new", { contextId: null });
    const history = async (contextId: string | null) => ok<{ items: Array<{ sessionId: string }> }>(await run(ctx, "conversation.history", { contextId })).items.map((item) => item.sessionId);
    expect(await history(null)).toEqual([recent.sessionId]);
    expect(await history(project.id)).toEqual([]);
    // Only a general conversation (one of 最近, or a project's own) can be continued from the history; one bound to a note, a work or a resource cannot.
    const bound = ok<{ id: string }>(await run(ctx, "agent.createSession", { kind: "work", targetId: "work-none", title: "作品的对话" }));
    expect((await run(ctx, "conversation.resume", { sessionId: bound.id })).status).toBe("error");
    expect(ok<{ conversation: View }>(await run(ctx, "conversation.resume", { sessionId: inProject.sessionId })).conversation).toMatchObject({ sessionId: inProject.sessionId, contextId: project.id });
    expect((await current(ctx, project.id))?.sessionId).toBe(inProject.sessionId);
    expect((await run(ctx, "conversation.resume", { sessionId: "ses-none" })).error?.code).toBe("NOT_FOUND");
  });

  it("makes the most recent conversation of an older profile the current one and lists the rest as history, deleting nothing", async () => {
    const ctx = await boot();
    const ids: string[] = [];
    for (const title of ["旧对话一", "旧对话二", "旧对话三"]) ids.push(ok<{ id: string }>(await run(ctx, "agent.createSession", { title, contextId: null })).id);
    const stamps = ["2026-08-01T10:00:00.000Z", "2026-09-01T10:00:00.000Z", "2026-07-01T10:00:00.000Z"];
    ids.forEach((id, index) => ctx.app.store.sqlite.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(stamps[index], id));
    // A conversation from before modes existed (no mode recorded) is one of 最近 like the others.
    const legacy = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "更早的" }));
    ctx.app.store.sqlite.prepare("UPDATE agent_sessions SET updated_at = ?, mode = NULL WHERE id = ?").run("2026-06-01T10:00:00.000Z", legacy.id);

    expect((await current(ctx, null))?.sessionId).toBe(ids[1]);
    const history = ok<{ items: Array<{ sessionId: string }> }>(await run(ctx, "conversation.history", { contextId: null }));
    expect(history.items.map((item) => item.sessionId)).toEqual([ids[0], ids[2], legacy.id]);
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_sessions").get()).toEqual({ n: 4 });
    // It is a record: the choice stays the same on the next look, even though a newer conversation appears.
    const newer = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "新建的", contextId: null }));
    expect((await current(ctx, null))?.sessionId).toBe(ids[1]);
    expect(newer.id).not.toBe(ids[1]);
  });
});

describe("renaming and moving a conversation (the sidebar)", () => {
  it("renames any conversation, and moves a general one to a project or back to 最近 without losing what was said", async () => {
    const ctx = await boot();
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "迁入的项目" }));
    const first = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { contextId: null }));
    await say(ctx, first.sessionId, "先在最近里说一句话");
    const second = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { contextId: null }));
    expect((await current(ctx, null))?.sessionId).toBe(second.sessionId);

    expect(ok<{ conversation: View }>(await run(ctx, "conversation.rename", { sessionId: first.sessionId, title: "  关于\n剧情  " })).conversation.title).toBe("关于 剧情");
    expect((await run(ctx, "conversation.rename", { sessionId: first.sessionId, title: "   " })).status).toBe("error");
    expect((await run(ctx, "conversation.rename", { sessionId: "ses-none", title: "x" })).error?.code).toBe("NOT_FOUND");

    const moved = ok<{ conversation: View }>(await run(ctx, "conversation.move", { sessionId: first.sessionId, contextId: project.id })).conversation;
    expect(moved).toMatchObject({ sessionId: first.sessionId, contextId: project.id, runCount: 1, title: "关于 剧情" });
    expect((await current(ctx, project.id))?.sessionId).toBe(first.sessionId);
    expect((await current(ctx, null))?.sessionId).toBe(second.sessionId);
    const row = ctx.app.store.sqlite.prepare("SELECT kind, target_id AS target, project_id AS project FROM agent_sessions WHERE id = ?").get(first.sessionId);
    expect(row).toEqual({ kind: "project", target: project.id, project: project.id });

    // Back to 最近: it joins the history there, and the project falls back to having none.
    ok(await run(ctx, "conversation.move", { sessionId: first.sessionId, contextId: null }));
    expect((await current(ctx, project.id))).toBeNull();
    expect(ok<{ items: Array<{ sessionId: string }> }>(await run(ctx, "conversation.history", { contextId: null })).items.map((item) => item.sessionId)).toContain(first.sessionId);
    expect((await run(ctx, "conversation.move", { sessionId: first.sessionId, contextId: "prj-none" })).error?.code).toBe("NOT_FOUND");

    const bound = ok<{ id: string }>(await run(ctx, "agent.createSession", { kind: "work", targetId: "work-none", title: "作品的对话" }));
    expect((await run(ctx, "conversation.move", { sessionId: bound.id, contextId: project.id })).status).toBe("error");
    expect(ok<{ conversation: View }>(await run(ctx, "conversation.rename", { sessionId: bound.id, title: "改名的作品对话" })).conversation.title).toBe("改名的作品对话");
  });
});
