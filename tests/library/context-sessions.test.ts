import { afterEach, describe, expect, it } from "vitest";
import { startMockProvider } from "@manga/model-protocol";
import { EMPTY_WORKSPACE_STATE, type WorkspaceState } from "@manga/contracts/workspace-state";
import { startApp, waitForRun } from "../helpers/app.ts";
import { seedComic } from "../helpers/media-seed.ts";

/**
 * What closing a tab keeps (AT-82, AT-111): the conversation, the place in the file and a way back by opening the thing again. The tab list is a
 * context's saved state; closing a tab only takes it out of that state. Replaces the closing of an entry of the left rail, which no longer exists.
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

async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  return ctx;
}
async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `ctxs-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
type Row = { sessionId: string; kind: string; title: string; contextId: string | null; runCount?: number; progress?: { locator?: { pageId?: string } } | null };
const sessions = async (ctx: App, contextId: string | null) => ok<Row[]>((await run(ctx, "workspace.sessions", { contextId })) as never);
const sessionRows = (ctx: App, id: string) => (ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_sessions WHERE id = ?").get(id) as { n: number }).n;
const tab = (id: string, kind: string, target: Record<string, unknown>, title: string) => ({ id, kind, target, title, view: {} });
const stateOf = (tabs: ReturnType<typeof tab>[], closed: ReturnType<typeof tab>[] = []): WorkspaceState => ({ ...EMPTY_WORKSPACE_STATE, tabs, focusedTab: tabs[0]?.id ?? null, closed });

describe("closing a tab keeps what it showed (AT-82, AT-111)", () => {
  it("takes a reader tab out of the saved state and keeps the session, the place in the file, and a way back by opening it again", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "关闭的漫画", pageCount: 5 });
    ok(await run(ctx, "progress.setPage", { contextId: null, resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[3] }));
    const opened = ok<{ id: string; reused: boolean }>(await run(ctx, "session.open", { kind: "resource", targetId: comic.resourceId, contextId: null }));
    const reader = tab("t1", "reader", { resourceId: comic.resourceId, mediaKind: "comic" }, "关闭的漫画");
    ok(await run(ctx, "workspace.saveContext", { contextId: null, state: stateOf([reader]) }));
    expect((await sessions(ctx, null)).map((row) => row.sessionId)).toContain(opened.id);

    // Closing the tab: the state keeps the tab among the closed ones and no longer among the open ones.
    ok(await run(ctx, "workspace.saveContext", { contextId: null, state: stateOf([], [reader]) }));
    const saved = ok<{ state: WorkspaceState }>(await run(ctx, "workspace.loadContext", { contextId: null })).state;
    expect(saved.tabs).toEqual([]);
    expect(saved.closed.map((item) => item.id)).toEqual(["t1"]);
    // Nothing was deleted: the session is still there, and so is the place the reader was left at.
    expect(sessionRows(ctx, opened.id)).toBe(1);
    expect((await sessions(ctx, null)).map((row) => row.sessionId)).toContain(opened.id);
    expect(ok<Record<string, any>>(await run(ctx, "progress.get", { contextId: null, resourceId: comic.resourceId }))).toBeTruthy();

    // Opening the same resource again is the same session, with the place it had.
    const again = ok<{ id: string; reused: boolean }>(await run(ctx, "session.open", { kind: "resource", targetId: comic.resourceId, contextId: null }));
    expect(again).toMatchObject({ id: opened.id, reused: true });
    const row = (await sessions(ctx, null)).find((entry) => entry.sessionId === opened.id)!;
    expect(row.progress?.locator?.pageId).toBe(comic.pageIds[3]);
  });

  it("keeps a project's conversation and a plain conversation when their tabs are closed, and each comes back when it is opened or resumed", async () => {
    const ctx = await boot();
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "要关闭的项目" }));
    const projectSession = ok<{ id: string }>(await run(ctx, "session.open", { kind: "project", targetId: project.id, contextId: project.id }));
    const chat = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { contextId: null }));
    expect((await sessions(ctx, project.id)).map((row) => row.sessionId)).toContain(projectSession.id);
    expect((await sessions(ctx, null)).map((row) => row.sessionId)).toContain(chat.sessionId);

    const inProject = [tab("c1", "conversation", { sessionId: projectSession.id }, "项目对话")];
    const inRecent = [tab("c2", "conversation", { sessionId: chat.sessionId }, "新对话")];
    ok(await run(ctx, "workspace.saveContext", { contextId: project.id, state: stateOf(inProject) }));
    ok(await run(ctx, "workspace.saveContext", { contextId: null, state: stateOf(inRecent) }));
    ok(await run(ctx, "workspace.saveContext", { contextId: project.id, state: stateOf([], inProject) }));
    ok(await run(ctx, "workspace.saveContext", { contextId: null, state: stateOf([], inRecent) }));
    expect((await sessions(ctx, project.id)).map((row) => row.sessionId)).toContain(projectSession.id);
    expect((await sessions(ctx, null)).map((row) => row.sessionId)).toContain(chat.sessionId);
    // The project itself, and its count of conversations, are not touched.
    expect(ok<{ projects: Array<{ counts: { sessions: number } }> }>(await run(ctx, "project.list", {})).projects[0]!.counts.sessions).toBe(1);

    expect(ok<{ reused: boolean }>(await run(ctx, "session.open", { kind: "project", targetId: project.id, contextId: project.id })).reused).toBe(true);
    ok(await run(ctx, "conversation.resume", { sessionId: chat.sessionId }));
    expect((await sessions(ctx, null)).map((row) => row.sessionId)).toContain(chat.sessionId);
    // The conversations of a project are not listed in "最近", and the other way round.
    expect((await sessions(ctx, null)).map((row) => row.sessionId)).not.toContain(projectSession.id);
    expect((await sessions(ctx, project.id)).map((row) => row.sessionId)).not.toContain(chat.sessionId);
  });

  it("lists a conversation as soon as the person talks in it, and has no closed state to hide it", async () => {
    const ctx = await boot();
    const server = await startMockProvider({ mode: "ok" });
    closers.push(server.close);
    ok(await run(ctx, "connections.upsert", { label: "默认", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "model-rail", purpose: "text", credentialHandle: ctx.app.stashSecret(`credential-ctxs-${counter += 1}`) }));
    const comic = seedComic(ctx.app, { title: "对话中的漫画", pageCount: 2 });
    const opened = ok<{ id: string }>(await run(ctx, "session.open", { kind: "resource", targetId: comic.resourceId, contextId: null }));
    const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId: opened.id, text: "说说这本", readResourceIds: [comic.resourceId] }));
    await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
    const row = (await sessions(ctx, null)).find((entry) => entry.sessionId === opened.id)!;
    expect(row).toMatchObject({ kind: "resource", contextId: null, runCount: 1 });
    // The table that once remembered which sessions were closed is gone with the left rail's close button.
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'closed_sessions'").get()).toEqual({ n: 0 });
  });

  it("offers no command to close a session, and lists a work page's session and a plain conversation like any other", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "作品页的漫画", pageCount: 2 });
    const workSession = ok<{ id: string }>(await run(ctx, "session.open", { kind: "work", targetId: comic.workId, contextId: null }));
    const noSuch = await run(ctx, "session.close", { sessionId: "ses_none" });
    expect(noSuch.status).toBe("error");
    expect(noSuch.error?.code).not.toBe("NOT_FOUND");
    const chat = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { contextId: null }));
    const rows = await sessions(ctx, null);
    expect(rows.map((row) => row.sessionId)).toEqual(expect.arrayContaining([workSession.id, chat.sessionId]));
    expect(sessionRows(ctx, workSession.id)).toBe(1);
    expect(sessionRows(ctx, chat.sessionId)).toBe(1);
  });

  it("is refused to an Agent, which cannot read or change the tabs of the person's workspace", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "代理不可关", pageCount: 2 });
    const opened = ok<{ id: string }>(await run(ctx, "session.open", { kind: "resource", targetId: comic.resourceId, contextId: null }));
    const reader = tab("t9", "reader", { resourceId: comic.resourceId, mediaKind: "comic" }, "代理不可关");
    ok(await run(ctx, "workspace.saveContext", { contextId: null, state: stateOf([reader]) }));
    for (const [commandId, input] of [["workspace.saveContext", { contextId: null, state: stateOf([]) }], ["workspace.loadContext", { contextId: null }], ["workspace.contexts", {}], ["workspace.setLastContext", { contextId: null }]] as const) {
      counter += 1;
      const asAgent = await ctx.app.call({ kind: "agent", id: "agent-tabs" }, { commandId, idempotencyKey: `ctxs-agent-${counter}`, input }, ctx.grant.handle);
      expect(asAgent.status, commandId).toBe("error");
    }
    const saved = ok<{ state: WorkspaceState }>(await run(ctx, "workspace.loadContext", { contextId: null })).state;
    expect(saved.tabs.map((item) => item.id)).toEqual(["t9"]);
    expect((await sessions(ctx, null)).map((row) => row.sessionId)).toContain(opened.id);
  });
});
