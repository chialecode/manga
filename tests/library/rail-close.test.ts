import { afterEach, describe, expect, it } from "vitest";
import { startMockProvider } from "@manga/model-protocol";
import { startApp, waitForRun } from "../helpers/app.ts";
import { seedComic } from "../helpers/media-seed.ts";

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
  return ctx;
}
async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `rail-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
type Row = { sessionId: string; kind: string; title: string; progress?: { locator?: { pageId?: string } } | null };
const rail = async (ctx: App, mode?: "enthusiast" | "creator") => ok<Row[]>((await run(ctx, "workspace.sessions", mode ? { mode } : {})) as never);
const sessionRows = (ctx: App, id: string) => (ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE id = ?").get(id) as { n: number }).n;

describe("closing an entry of the left rail (AT-82)", () => {
  it("takes an opened resource off the list and keeps it: the session, the place in the file, and a way back by opening it again", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "关闭的漫画", pageCount: 5 });
    ok(await run(ctx, "progress.setPage", { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[3] }));
    const opened = ok<{ id: string; reused: boolean }>(await run(ctx, "session.open", { kind: "resource", targetId: comic.resourceId }));
    expect((await rail(ctx)).map((row) => row.sessionId)).toContain(opened.id);

    expect(ok(await run(ctx, "session.close", { sessionId: opened.id }))).toMatchObject({ sessionId: opened.id, closed: true });
    expect((await rail(ctx)).map((row) => row.sessionId)).not.toContain(opened.id);
    // Nothing was deleted: the session is still there, and so is the place the reader was left at.
    expect(sessionRows(ctx, opened.id)).toBe(1);
    expect(ok<Record<string, any>>(await run(ctx, "progress.get", { resourceId: comic.resourceId }))).toBeTruthy();

    // Opening the same resource again lists the same session again, with the place it had.
    const again = ok<{ id: string; reused: boolean }>(await run(ctx, "session.open", { kind: "resource", targetId: comic.resourceId }));
    expect(again).toMatchObject({ id: opened.id, reused: true });
    const row = (await rail(ctx)).find((entry) => entry.sessionId === opened.id)!;
    expect(row.progress?.locator?.pageId).toBe(comic.pageIds[3]);
  });

  it("closes a project's conversation and a work-mode conversation, and each comes back when it is opened or resumed", async () => {
    const ctx = await boot();
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "要关闭的项目" }));
    const projectSession = ok<{ id: string }>(await run(ctx, "session.open", { kind: "project", targetId: project.id, mode: "creator" }));
    const chat = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { mode: "creator" }));
    expect((await rail(ctx, "creator")).map((row) => row.sessionId)).toEqual(expect.arrayContaining([projectSession.id, chat.sessionId]));

    ok(await run(ctx, "session.close", { sessionId: projectSession.id }));
    ok(await run(ctx, "session.close", { sessionId: chat.sessionId }));
    const closed = (await rail(ctx, "creator")).map((row) => row.sessionId);
    expect(closed).not.toContain(projectSession.id);
    expect(closed).not.toContain(chat.sessionId);
    // The project itself, and its count of conversations, are not touched.
    expect(ok<{ projects: Array<{ counts: { sessions: number } }> }>(await run(ctx, "project.list", {})).projects[0]!.counts.sessions).toBe(1);

    expect(ok<{ reused: boolean }>(await run(ctx, "session.open", { kind: "project", targetId: project.id, mode: "creator" })).reused).toBe(true);
    ok(await run(ctx, "conversation.resume", { sessionId: chat.sessionId }));
    const back = (await rail(ctx, "creator")).map((row) => row.sessionId);
    expect(back).toEqual(expect.arrayContaining([projectSession.id, chat.sessionId]));
  });

  it("lists a closed conversation again when the person talks in it", async () => {
    const ctx = await boot();
    const server = await startMockProvider({ mode: "ok" });
    closers.push(server.close);
    ok(await run(ctx, "connections.upsert", { label: "默认", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "model-rail", purpose: "text", credentialHandle: ctx.app.stashSecret(`credential-rail-${counter += 1}`) }));
    const comic = seedComic(ctx.app, { title: "对话中的漫画", pageCount: 2 });
    const opened = ok<{ id: string }>(await run(ctx, "session.open", { kind: "resource", targetId: comic.resourceId }));
    ok(await run(ctx, "session.close", { sessionId: opened.id }));
    expect((await rail(ctx)).map((row) => row.sessionId)).not.toContain(opened.id);
    const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId: opened.id, text: "说说这本", readResourceIds: [comic.resourceId] }));
    await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
    expect((await rail(ctx)).map((row) => row.sessionId)).toContain(opened.id);
  });

  it("closes only what the rail lists, and says so for anything else", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "作品页的漫画", pageCount: 2 });
    const workSession = ok<{ id: string }>(await run(ctx, "session.open", { kind: "work", targetId: comic.workId }));
    const noSuch = await run(ctx, "session.close", { sessionId: "ses_none" });
    expect(noSuch.status).toBe("error");
    expect(noSuch.error?.code).toBe("NOT_FOUND");
    // A work's page and the entertainment mode's one conversation are not entries of the rail, so there is nothing to close.
    const notListed = await run(ctx, "session.close", { sessionId: workSession.id });
    expect(notListed.status).toBe("error");
    expect(notListed.error?.code).toBe("VALIDATION_ERROR");
    const chat = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { mode: "enthusiast" }));
    expect((await run(ctx, "session.close", { sessionId: chat.sessionId })).error?.code).toBe("VALIDATION_ERROR");
    expect(sessionRows(ctx, workSession.id)).toBe(1);
    expect(sessionRows(ctx, chat.sessionId)).toBe(1);
  });

  it("is refused to an Agent, which cannot take things off the person's rail", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "代理不可关", pageCount: 2 });
    const opened = ok<{ id: string }>(await run(ctx, "session.open", { kind: "resource", targetId: comic.resourceId }));
    counter += 1;
    const asAgent = await ctx.app.call({ kind: "agent", id: "agent-rail" }, { commandId: "session.close", idempotencyKey: `rail-agent-${counter}`, input: { sessionId: opened.id } }, ctx.grant.handle);
    expect(asAgent.status).toBe("error");
    expect((await rail(ctx)).map((row) => row.sessionId)).toContain(opened.id);
  });
});
