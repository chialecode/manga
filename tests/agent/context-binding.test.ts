import { afterEach, describe, expect, it } from "vitest";
import { startMockProvider } from "@manga/model-protocol";
import { startApp, waitForRun } from "../helpers/app.ts";
import { seedComic } from "../helpers/media-seed.ts";

/**
 * A conversation works in one context (A-96, plan 4.7): the task is told which one when it starts, a command that takes a context gets the conversation's
 * own whatever the model wrote, and the model is never asked for it.
 */
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
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `ctxb-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
const snapshotOf = (ctx: App, runId: string) => JSON.parse((ctx.app.store.sqlite.prepare("SELECT snapshot_json FROM agent_runs WHERE id = ?").get(runId) as { snapshot_json: string }).snapshot_json) as { contextId: string | null };

async function boot(options: Parameters<typeof startMockProvider>[0] = {}) {
  const requests: Array<Record<string, any>> = [];
  const server = await startMockProvider({ ...options, onRequest: ({ body }) => { requests.push(body); } });
  closers.push(server.close);
  const ctx = await startApp();
  apps.push(ctx);
  ok(await run(ctx, "connections.upsert", { label: "文本", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "m", purpose: "text", credentialHandle: ctx.app.stashSecret(`credential-ctxb-${counter += 1}`) }));
  return { ctx, requests };
}

describe("a task knows the context it runs in", () => {
  it("records the context of a project conversation and of 最近 in what the task was given", async () => {
    const { ctx } = await boot();
    const comic = seedComic(ctx.app, { title: "记录上下文", pageCount: 3 });
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "有上下文的项目" }));
    ok(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: comic.workId }));
    const inProject = ok<{ id: string }>(await run(ctx, "session.open", { kind: "project", targetId: project.id, contextId: project.id }));
    const inRecent = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { contextId: null }));
    const sentProject = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId: inProject.id, text: "在项目里问" }));
    const sentRecent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId: inRecent.sessionId, text: "在最近里问", readResourceIds: [comic.resourceId] }));
    await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sentProject.runId);
    await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sentRecent.runId);
    expect(snapshotOf(ctx, sentProject.runId).contextId).toBe(project.id);
    expect(snapshotOf(ctx, sentRecent.runId).contextId).toBeNull();
  }, 60_000);

  it("gives a command that takes a context the conversation's own, whatever the model wrote, and does not ask the model for it", async () => {
    const script: Array<{ name: string; arguments: string }> = [];
    const { ctx, requests } = await boot({ streamToolScript: script });
    const comic = seedComic(ctx.app, { title: "读到哪里", pageCount: 8 });
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "读书项目" }));
    ok(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: comic.workId }));
    ok(await run(ctx, "progress.setPage", { contextId: null, resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[1], consumed: true }));
    ok(await run(ctx, "progress.setPage", { contextId: project.id, resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[6], consumed: true }));
    // The model is told to read the position in 最近 while it works in the project.
    script.push({ name: "progress.get", arguments: JSON.stringify({ resourceId: comic.resourceId, contextId: null }) });
    const session = ok<{ id: string }>(await run(ctx, "session.open", { kind: "project", targetId: project.id, contextId: project.id }));
    const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId: session.id, text: "我读到哪里了" }));
    const done = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
    expect(done.value?.status, JSON.stringify(done.value?.error ?? {})).toBe("succeeded");

    // The model's tool list has no context parameter on the command.
    const first = requests.find((body) => Array.isArray(body.tools) && body.stream)!;
    const progressTool = (first.tools as Array<{ function: { name: string; parameters: { properties: Record<string, unknown>; required?: string[] } } }>).find((tool) => tool.function.name === "progress.get")!;
    expect(Object.keys(progressTool.function.parameters.properties)).not.toContain("contextId");
    expect(progressTool.function.parameters.required ?? []).not.toContain("contextId");
    // What came back is the project position (page 7), not the position of 最近 the model asked for (page 2).
    const toolMessage = (requests.at(-1)!.messages as Array<{ role: string; content: string }>).find((message) => message.role === "tool")!;
    expect(toolMessage.content).toContain(comic.pageIds[6]!);
    expect(toolMessage.content).not.toContain(comic.pageIds[1]!);
  }, 60_000);

  it("refuses to run a command that takes a context without one, outside the task", async () => {
    const { ctx } = await boot();
    const comic = seedComic(ctx.app, { title: "没写上下文", pageCount: 2 });
    const refused = await run(ctx, "progress.get", { resourceId: comic.resourceId });
    expect(refused.status).toBe("error");
    expect(refused.error?.code).toBe("VALIDATION_ERROR");
    expect((await run(ctx, "progress.get", { contextId: null, resourceId: comic.resourceId })).status).toBe("ok");
    // The old parameters of the two modes are not accepted any more.
    expect((await run(ctx, "conversation.current", { mode: "enthusiast" })).error?.code).toBe("VALIDATION_ERROR");
    expect((await run(ctx, "conversation.new", { mode: "creator" })).error?.code).toBe("VALIDATION_ERROR");
    expect((await run(ctx, "session.open", { kind: "resource", targetId: comic.resourceId, mode: "enthusiast" })).error?.code).toBe("VALIDATION_ERROR");
  });
});
