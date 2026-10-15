import { afterEach, describe, expect, it } from "vitest";
import { startMockProvider } from "@manga/model-protocol";
import { startApp, waitForRun } from "../helpers/app.ts";
import { seedVideo } from "../helpers/media-seed.ts";

/**
 * Deleting conversations (A-89, AT-103): one, several, or all that a filter shows, with the runs, messages, tool events, call record, checkpoints and
 * frozen material that belong to them, and nothing that the agent wrote into the library. A task still running keeps its conversation.
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

async function boot(mode: "ok" | "timeout" = "ok") {
  const ctx = await startApp();
  apps.push(ctx);
  const server = await startMockProvider({ mode });
  closers.push(server.close);
  ok(await run(ctx, "connections.upsert", { label: "文本", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "m", purpose: "text", credentialHandle: ctx.app.stashSecret("credential-del") }));
  return ctx;
}
async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `del-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
const say = async (ctx: App, sessionId: string, text: string) => {
  const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId, text }));
  await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
  return sent.runId;
};
const count = (ctx: App, sql: string, ...params: unknown[]) => (ctx.app.store.sqlite.prepare(sql).get(...params) as { n: number }).n;
type Record_ = { sessionId: string; title: string; kind: string; mode: string; ownerTitle: string | null; runCount: number; lastAt: string; current: boolean; running: boolean; excerpt: string };
const list = async (ctx: App, filter: Record<string, unknown> = {}) => ok<{ items: Record_[]; total: number }>(await run(ctx, "conversation.list", filter));
type Removal = { removed: string[]; skipped: Array<{ sessionId: string; reason: string }>; counts: Record<string, number>; replaced: Record<string, { sessionId: string; runCount: number }> };

/** The rows that belong to a run, in every table that keeps any; a synthetic row stands where a plain mock run leaves none. */
function leftFor(ctx: App, runId: string) {
  const sqlite = ctx.app.store.sqlite;
  return {
    run: count(ctx, "SELECT COUNT(*) AS n FROM agent_runs WHERE id = ?", runId),
    messages: count(ctx, "SELECT COUNT(*) AS n FROM agent_messages WHERE run_id = ?", runId),
    toolEvents: count(ctx, "SELECT COUNT(*) AS n FROM agent_tool_events WHERE run_id = ?", runId),
    trace: count(ctx, "SELECT COUNT(*) AS n FROM agent_requests WHERE run_id = ?", runId),
    grants: count(ctx, "SELECT COUNT(*) AS n FROM grants WHERE run_id = ? AND access <> 'owner'", runId),
    receipts: count(ctx, "SELECT COUNT(*) AS n FROM command_requests WHERE run_id = ?", runId),
    snapshot: (sqlite.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE id = ? AND (snapshot_json IS NOT NULL OR checkpoint_json IS NOT NULL)").get(runId) as { n: number }).n,
  };
}
function seedExtras(ctx: App, runId: string) {
  const sqlite = ctx.app.store.sqlite;
  const at = new Date().toISOString();
  sqlite.prepare("INSERT OR IGNORE INTO agent_tool_events(id, run_id, command_id, status, input_summary, result_summary, created_at) VALUES (?,?,?,?,?,?,?)").run(`te_${runId}`, runId, "library.find", "ok", "{}", "{}", at);
  sqlite.prepare("INSERT OR IGNORE INTO agent_requests(id, run_id, step, kind, status, started_at) VALUES (?,?,?,?,?,?)").run(`rq_${runId}`, runId, 1, "model", "ok", at);
  sqlite.prepare("UPDATE agent_runs SET snapshot_json = COALESCE(snapshot_json, '{\"frozen\":true}'), checkpoint_json = '{\"step\":1}' WHERE id = ?").run(runId);
  sqlite.prepare(`INSERT OR IGNORE INTO grants(handle, actor_json, session_id, run_id, allowed_commands_json, access, read_resource_ids_json, write_resource_ids_json, write_object_ids_json, allow_create_objects, path_handles_json, module_epoch, binding_epoch, registry_generation, revoked, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(`grant_${runId}`, JSON.stringify({ kind: "agent", id: "a" }), null, runId, "[]", "scoped", "[]", "[]", "[]", 0, "[]", 0, 0, 0, 0, at);
  sqlite.prepare("INSERT OR IGNORE INTO command_requests(idempotency_key, command_id, input_hash, run_id) VALUES (?,?,?,?)").run(`key_${runId}`, "library.find", "h", runId);
}

describe("deleting a conversation takes the whole of it and only it (AT-103)", () => {
  it("removes the session, its runs, messages, tool events, call record, checkpoints, frozen material, authorization and the mark that it was closed", async () => {
    const ctx = await boot();
    const doomed = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { mode: "enthusiast" })).sessionId;
    const runA = await say(ctx, doomed, "要被删掉的第一句");
    const runB = await say(ctx, doomed, "要被删掉的第二句");
    const kept = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { mode: "enthusiast" })).sessionId;
    const runC = await say(ctx, kept, "留下来的话");
    for (const runId of [runA, runB, runC]) seedExtras(ctx, runId);
    ctx.app.store.sqlite.prepare("INSERT OR REPLACE INTO closed_sessions(session_id, closed_at) VALUES (?, ?)").run(doomed, new Date().toISOString());
    // What the agent wrote into the library is not a part of the conversation.
    const note = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "留着的笔记", text: "评论" }));
    const library = { objects: count(ctx, "SELECT COUNT(*) AS n FROM content_objects"), works: count(ctx, "SELECT COUNT(*) AS n FROM works") };

    // Before the deletion every table has something for the run (a plain run leaves some of them empty, so the rows seeded above stand in).
    for (const [table, n] of Object.entries(leftFor(ctx, runA))) expect(n, table).toBeGreaterThan(0);

    const removal = ok<Removal>(await run(ctx, "conversation.delete", { sessionIds: [doomed] }));
    expect(removal.removed).toEqual([doomed]);
    expect(removal.skipped).toEqual([]);
    expect(removal.counts).toMatchObject({ sessions: 1, runs: 2 });
    expect(removal.replaced).toEqual({});

    expect(count(ctx, "SELECT COUNT(*) AS n FROM agent_sessions WHERE id = ?", doomed)).toBe(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM closed_sessions WHERE session_id = ?", doomed)).toBe(0);
    for (const runId of [runA, runB]) expect(leftFor(ctx, runId)).toEqual({ run: 0, messages: 0, toolEvents: 0, trace: 0, grants: 0, receipts: 0, snapshot: 0 });
    // The other conversation is as it was.
    for (const [table, n] of Object.entries(leftFor(ctx, runC))) expect(n, table).toBeGreaterThan(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM agent_sessions WHERE id = ?", kept)).toBe(1);
    // The library is untouched, and the owner's own authorization still works.
    expect({ objects: count(ctx, "SELECT COUNT(*) AS n FROM content_objects"), works: count(ctx, "SELECT COUNT(*) AS n FROM works") }).toEqual(library);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM content_objects WHERE id = ?", note.objectId)).toBe(1);
    expect(ok<{ items: Array<{ sessionId: string }> }>(await run(ctx, "conversation.history", { mode: "enthusiast" })).items).toEqual([]);
    expect(ok<{ conversation: { sessionId: string } }>(await run(ctx, "conversation.current", { mode: "enthusiast" })).conversation.sessionId).toBe(kept);
  }, 60_000);

  it("puts a new conversation in the place of the current one that was deleted, and leaves the other mode alone", async () => {
    const ctx = await boot();
    const fun = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { mode: "enthusiast" })).sessionId;
    await say(ctx, fun, "娱乐模式的话");
    const work = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { mode: "creator" })).sessionId;
    await say(ctx, work, "工作模式的话");

    const removal = ok<Removal>(await run(ctx, "conversation.delete", { sessionIds: [fun] }));
    expect(removal.replaced.enthusiast).toMatchObject({ runCount: 0 });
    expect(removal.replaced.enthusiast!.sessionId).not.toBe(fun);
    expect(removal.replaced.creator).toBeUndefined();
    const now = ok<{ conversation: { sessionId: string; runCount: number } }>(await run(ctx, "conversation.current", { mode: "enthusiast" })).conversation;
    expect(now).toMatchObject({ sessionId: removal.replaced.enthusiast!.sessionId, runCount: 0 });
    expect(ok<{ conversation: { sessionId: string } }>(await run(ctx, "conversation.current", { mode: "creator" })).conversation.sessionId).toBe(work);
    // The new conversation can be spoken in at once.
    await say(ctx, now.sessionId, "新对话里的话");
    expect(count(ctx, "SELECT COUNT(*) AS n FROM agent_runs WHERE session_id = ?", now.sessionId)).toBe(1);
  }, 60_000);

  it("keeps a conversation whose task is still running, says so, and deletes it once the task is stopped", async () => {
    const ctx = await boot("timeout");
    const busy = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { mode: "enthusiast" })).sessionId;
    const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId: busy, text: "一直在等的任务" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const shown = await list(ctx);
    expect(shown.items.find((item) => item.sessionId === busy)).toMatchObject({ running: true, current: true });

    const first = ok<Removal>(await run(ctx, "conversation.delete", { sessionIds: [busy] }));
    expect(first.removed).toEqual([]);
    expect(first.skipped).toEqual([{ sessionId: busy, reason: "running" }]);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM agent_sessions WHERE id = ?", busy)).toBe(1);
    expect(ok<Removal>(await run(ctx, "conversation.deleteAll", {})).skipped).toEqual([{ sessionId: busy, reason: "running" }]);

    ok(await run(ctx, "agent.cancel", { runId: sent.runId }));
    await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = ok<Removal>(await run(ctx, "conversation.delete", { sessionIds: [busy] }));
    expect(second.removed).toEqual([busy]);
    expect(leftFor(ctx, sent.runId).run).toBe(0);
  }, 60_000);

  it("is the owner's: a task cannot list or delete conversations, and the commands are not in the agent's table", async () => {
    const ctx = await boot();
    const session = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { mode: "enthusiast" })).sessionId;
    const agent = { kind: "agent" as const, id: "tester-agent" };
    const grant = ctx.app.grants.issue({
      actor: agent, allowedCommands: ["conversation.list", "conversation.delete", "conversation.deleteAll"], access: "scoped",
      readResourceIds: [], writeResourceIds: [], writeObjectIds: [], allowCreateObjects: false, pathHandles: [], moduleEpoch: 0, bindingEpoch: 0, registryGeneration: 0,
    } as never);
    for (const [commandId, input] of [["conversation.list", {}], ["conversation.delete", { sessionIds: [session] }], ["conversation.deleteAll", {}]] as const) {
      counter += 1;
      const refused = await ctx.app.call(agent, { commandId, idempotencyKey: `del-agent-${counter}`, input }, grant.handle);
      expect(refused.status, commandId).toBe("error");
    }
    expect(count(ctx, "SELECT COUNT(*) AS n FROM agent_sessions WHERE id = ?", session)).toBe(1);
    // The authorization a real task is given does not name them either.
    const taskId = await say(ctx, session, "看看任务拿到的权限");
    const allowed = (ctx.app.store.sqlite.prepare("SELECT allowed_commands_json AS json FROM grants WHERE run_id = ? AND access <> 'owner'").all(taskId) as Array<{ json: string }>).flatMap((row) => JSON.parse(row.json) as string[]);
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed.filter((commandId) => commandId.startsWith("conversation."))).toEqual([]);
  });
});

describe("the list of conversations (AT-103)", () => {
  async function populate(ctx: App) {
    const sqlite = ctx.app.store.sqlite;
    const video = seedVideo(ctx.app, { title: "合成视频 第一集" });
    sqlite.prepare("UPDATE works SET title = ? WHERE id = ?").run("合成动画", video.workId);
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "合成项目" }));
    const global = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { mode: "enthusiast" })).sessionId;
    await say(ctx, global, "全局里问的第一句");
    const resource = ok<{ id: string }>(await run(ctx, "session.open", { kind: "resource", targetId: video.resourceId, mode: "enthusiast" })).id;
    await say(ctx, resource, "资源里问的");
    const work = ok<{ id: string }>(await run(ctx, "session.open", { kind: "work", targetId: video.workId, mode: "enthusiast" })).id;
    const projectSession = ok<{ id: string }>(await run(ctx, "session.open", { kind: "project", targetId: project.id, mode: "creator" })).id;
    const creatorGlobal = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { mode: "creator" })).sessionId;
    // Spread the last activity over time.
    const day = 86_400_000;
    const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
    sqlite.prepare("UPDATE agent_runs SET updated_at = ? WHERE session_id = ?").run(at(1), global);
    sqlite.prepare("UPDATE agent_runs SET updated_at = ? WHERE session_id = ?").run(at(45), resource);
    sqlite.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(at(1), global);
    sqlite.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(at(45), resource);
    sqlite.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(at(10), work);
    sqlite.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(at(3), projectSession);
    sqlite.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id = ?").run(at(2), creatorGlobal);
    return { video, project, global, resource, work, projectSession, creatorGlobal, at };
  }

  it("lists every kind with its title, what it is about, the number of rounds and the last time, newest first", async () => {
    const ctx = await boot();
    const s = await populate(ctx);
    const all = await list(ctx);
    expect(all.total).toBe(5);
    expect(all.items.map((item) => item.sessionId)).toEqual([s.global, s.creatorGlobal, s.projectSession, s.work, s.resource]);
    const by = Object.fromEntries(all.items.map((item) => [item.sessionId, item]));
    expect(by[s.global]).toMatchObject({ kind: "shared", mode: "enthusiast", runCount: 1, current: true, ownerTitle: null });
    expect(by[s.global]!.excerpt.startsWith("全局里问的第一句")).toBe(true);
    expect(by[s.resource]).toMatchObject({ kind: "resource", ownerTitle: "合成视频 第一集", runCount: 1, current: false });
    expect(by[s.work]).toMatchObject({ kind: "work", ownerTitle: "合成动画", runCount: 0 });
    expect(by[s.projectSession]).toMatchObject({ kind: "project", mode: "creator", ownerTitle: "合成项目" });
    expect(by[s.creatorGlobal]).toMatchObject({ kind: "shared", mode: "creator", current: true });
  }, 60_000);

  it("filters by mode, kind, time and title, pages, and agrees with what \"delete all\" deletes", async () => {
    const ctx = await boot();
    const s = await populate(ctx);
    const ids = async (filter: Record<string, unknown>) => (await list(ctx, filter)).items.map((item) => item.sessionId);
    expect(await ids({ mode: "creator" })).toEqual([s.creatorGlobal, s.projectSession]);
    expect(await ids({ kind: "resource" })).toEqual([s.resource]);
    expect(await ids({ kind: "shared", mode: "enthusiast" })).toEqual([s.global]);
    expect(await ids({ after: s.at(7) })).toEqual([s.global, s.creatorGlobal, s.projectSession]);
    expect(await ids({ before: s.at(30) })).toEqual([s.resource]);
    // Title search covers the conversation's own title and the title of what it is about.
    expect(await ids({ q: "合成动画" })).toEqual([s.work]);
    expect(await ids({ q: "合成视频" })).toEqual([s.resource]);
    expect(await ids({ q: "合成项目" })).toEqual([s.projectSession]);
    expect(await ids({ q: "没有这个" })).toEqual([]);
    // 100% of a percent sign is a literal one, not a wildcard.
    expect(await ids({ q: "%" })).toEqual([]);

    const paged = await list(ctx, { limit: 2, offset: 2 });
    expect(paged.total).toBe(5);
    expect(paged.items.map((item) => item.sessionId)).toEqual([s.projectSession, s.work]);

    // "Delete all" with a filter deletes what that filter lists, and no more.
    const removal = ok<Removal>(await run(ctx, "conversation.deleteAll", { kind: "resource" }));
    expect(removal.removed).toEqual([s.resource]);
    expect((await list(ctx)).total).toBe(4);
    const everything = ok<Removal>(await run(ctx, "conversation.deleteAll", {}));
    expect(everything.removed.sort()).toEqual([s.global, s.creatorGlobal, s.projectSession, s.work].sort());
    // Each mode is left with a new, empty conversation to speak in.
    expect(Object.keys(everything.replaced).sort()).toEqual(["creator", "enthusiast"]);
    const left = await list(ctx);
    expect(left.items.map((item) => item.runCount)).toEqual([0, 0]);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM agent_runs")).toBe(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM agent_messages")).toBe(0);
    expect(count(ctx, "SELECT COUNT(*) AS n FROM works")).toBe(1);
  }, 90_000);

  it("deletes a conversation whose resource, work or project is already gone, and names what is left of it", async () => {
    const ctx = await boot();
    const s = await populate(ctx);
    ctx.app.store.sqlite.prepare("DELETE FROM resources WHERE id = ?").run(s.video.resourceId);
    const gone = (await list(ctx, { kind: "resource" })).items[0]!;
    expect(gone.ownerTitle).toBeNull();
    ok(await run(ctx, "conversation.delete", { sessionIds: [gone.sessionId] }));
    expect((await list(ctx, { kind: "resource" })).total).toBe(0);
  }, 60_000);

  it("writes the deletion to the operation log, and announces it so the windows can follow", async () => {
    const ctx = await boot();
    const notices: Array<{ topic: string; payload: Record<string, any> }> = [];
    ctx.app.onNotice((notice) => { if (notice.topic === "conversation.deleted") notices.push(notice as never); });
    const session = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { mode: "enthusiast" })).sessionId;
    ok(await run(ctx, "conversation.delete", { sessionIds: [session] }));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload.sessionIds).toEqual([session]);
    expect(notices[0]!.payload.replaced.enthusiast.sessionId).toEqual(expect.any(String));
    const logged = ctx.app.store.sqlite.prepare("SELECT action, category FROM operation_log WHERE action = 'conversation.delete'").all();
    expect(logged).toEqual([{ action: "conversation.delete", category: "agent" }]);
  });
});
