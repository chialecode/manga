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
async function run(ctx: App, commandId: string, input: Record<string, unknown>, grantHandle = ctx.grant.handle, actor: { kind: "user" | "agent"; id: string } = ctx.actor): Promise<Call> {
  counter += 1;
  return ctx.app.call(actor, { commandId, idempotencyKey: `prj-${counter}`, input }, grantHandle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
const count = (ctx: App, sql: string, ...params: unknown[]) => (ctx.app.store.sqlite.prepare(sql).get(...params) as { n: number }).n;

describe("the work mode's overview (A-77)", () => {
  it("lists the projects touched last, the objects edited last and the suggestions that wait, and leaves archived projects out", async () => {
    const ctx = await boot();
    const empty = ok<{ recent: unknown[]; objects: unknown[]; suggestions: unknown[]; totals: { active: number; archived: number } }>(await run(ctx, "project.overview", {}));
    expect(empty).toMatchObject({ recent: [], objects: [], suggestions: [], totals: { active: 0, archived: 0 } });

    const a = ok<{ id: string }>(await run(ctx, "project.create", { name: "甲项目" }));
    const b = ok<{ id: string }>(await run(ctx, "project.create", { name: "乙项目" }));
    const gone = ok<{ id: string }>(await run(ctx, "project.create", { name: "归档项目" }));
    const board = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId: a.id, title: "甲的白板" })).board.id;
    const map = ok<{ map: { id: string } }>(await run(ctx, "mindmap.create", { projectId: b.id, title: "乙的导图", rootText: "中心" })).map.id;
    const draft = ok<{ draft: { id: string } }>(await run(ctx, "draft.create", { projectId: b.id, title: "乙的稿子", text: "正文" })).draft.id;
    ok(await run(ctx, "whiteboard.create", { projectId: gone.id, title: "归档里的白板" }));
    // The last edit of an object is what orders the list: the board is touched after the others.
    const stamp = (table: string, id: string, at: string) => ctx.app.store.sqlite.prepare(`UPDATE ${table} SET updated_at = ? WHERE id = ?`).run(at, id);
    stamp("mindmaps", map, "2026-02-01T00:00:00.000Z");
    stamp("drafts", draft, "2026-02-02T00:00:00.000Z");
    stamp("whiteboards", board, "2026-02-03T00:00:00.000Z");
    // A suggestion that was made for the draft and not taken is waiting; a taken one is not.
    const insert = ctx.app.store.sqlite.prepare("INSERT INTO draft_suggestions(id, draft_id, kind, instruction, status, base_version, base_text, result_text, sources_json, model_json, adopted_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insert.run("sug-wait", draft, "polish", "", "pending", 1, "正文", "改写后的正文", "[]", null, null, "2026-02-04T00:00:00.000Z", "2026-02-04T00:00:00.000Z");
    insert.run("sug-done", draft, "polish", "", "adopted", 1, "正文", "旧的改写", "[]", null, 2, "2026-02-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z");
    ok(await run(ctx, "project.update", { projectId: gone.id, status: "archived" }));

    const overview = ok<{
      recent: Array<{ id: string; counts: { whiteboards: number; mindmaps: number; drafts: number } }>;
      objects: Array<{ kind: string; id: string; title: string; projectName: string }>;
      suggestions: Array<{ id: string; draftTitle: string; projectName: string }>;
      totals: { active: number; archived: number };
    }>(await run(ctx, "project.overview", {}));
    expect(overview.totals).toEqual({ active: 2, archived: 1 });
    expect(overview.recent.map((item) => item.id).sort()).toEqual([a.id, b.id].sort());
    expect(overview.recent.find((item) => item.id === b.id)!.counts).toMatchObject({ mindmaps: 1, drafts: 1 });
    expect(overview.objects.map((item) => [item.kind, item.title, item.projectName])).toEqual([
      ["whiteboard", "甲的白板", "甲项目"],
      ["draft", "乙的稿子", "乙项目"],
      ["mindmap", "乙的导图", "乙项目"],
    ]);
    expect(overview.suggestions).toEqual([expect.objectContaining({ id: "sug-wait", draftTitle: "乙的稿子", projectName: "乙项目" })]);
  });

  it("is not something a project's conversation can ask for", async () => {
    const ctx = await boot();
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "只看自己" }));
    const session = ok<{ id: string }>(await run(ctx, "session.open", { kind: "project", targetId: project.id, mode: "creator" }));
    const denied = await ctx.app.call({ kind: "agent", id: session.id }, { commandId: "project.overview", idempotencyKey: "ov-agent", input: {} }, ctx.grant.handle);
    expect(denied.status).toBe("error");
  });
});

describe("projects (AT-25)", () => {
  it("creates, lists, renames, archives and restores a project", async () => {
    const ctx = await boot();
    const made = ok<{ id: string; name: string; status: string; counts: Record<string, number> }>(await run(ctx, "project.create", { name: "一次解说", goal: "做一支十分钟的解说" }));
    expect(made).toMatchObject({ name: "一次解说", status: "active" });
    expect(made.counts).toMatchObject({ materials: 0, terms: 0, sessions: 0 });
    ok(await run(ctx, "project.create", { name: "第二个" }));
    expect(ok<{ projects: unknown[] }>(await run(ctx, "project.list", {})).projects).toHaveLength(2);

    ok(await run(ctx, "project.update", { projectId: made.id, name: "一次解说（改）", goal: "目标改了" }));
    ok(await run(ctx, "project.update", { projectId: made.id, status: "archived" }));
    expect(ok<{ projects: unknown[] }>(await run(ctx, "project.list", {})).projects).toHaveLength(1);
    const archived = ok<{ projects: Array<{ name: string; goal: string }> }>(await run(ctx, "project.list", { status: "archived" })).projects;
    expect(archived).toEqual([expect.objectContaining({ name: "一次解说（改）", goal: "目标改了" })]);
    ok(await run(ctx, "project.update", { projectId: made.id, status: "active" }));
    expect(ok<{ projects: unknown[] }>(await run(ctx, "project.list", { status: "all" })).projects).toHaveLength(2);

    const bad = await run(ctx, "project.create", { name: "   " });
    expect(bad.status).toBe("error");
    expect((await run(ctx, "project.get", { projectId: "prj-none" })).error?.code).toBe("NOT_FOUND");
  });

  it("only refers to personal material, and deleting the project or a reference leaves the material where it was", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "引用的漫画", pageCount: 3 });
    const note = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "引用的笔记", text: "正文", resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, locator: { kind: "image", pageId: comic.pageIds[0] }, quoteText: "第 1 页" }));
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "引用" }));
    const added = [
      ok<{ id: string; label: string; state: string }>(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: comic.workId })),
      ok<{ id: string; label: string; state: string }>(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "resource", targetId: comic.resourceId })),
      ok<{ id: string; label: string; state: string }>(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "note", targetId: note.objectId })),
    ];
    expect(added.map((item) => [item.label, item.state])).toEqual([["引用的漫画", "ok"], ["引用的漫画", "ok"], ["引用的笔记", "ok"]]);
    // Adding the same thing twice keeps one reference.
    const again = ok<{ id: string }>(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: comic.workId }));
    expect(again.id).toBe(added[0]!.id);
    expect(ok<{ materials: unknown[] }>(await run(ctx, "project.get", { projectId: project.id })).materials).toHaveLength(3);
    // Something that does not exist cannot be added.
    expect((await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: "work-ghost" })).error?.code).toBe("NOT_FOUND");

    const before = ["works", "resources", "anchors", "content_objects"].map((table) => count(ctx, `SELECT COUNT(*) AS n FROM ${table}`));
    ok(await run(ctx, "project.removeMaterial", { projectId: project.id, materialId: added[1]!.id }));
    expect(["works", "resources", "anchors", "content_objects"].map((table) => count(ctx, `SELECT COUNT(*) AS n FROM ${table}`))).toEqual(before);

    // A note that is deleted shows as missing, with the name the reference kept.
    ok(await run(ctx, "notes.delete", { objectId: note.objectId }));
    const shown = ok<{ materials: Array<{ kind: string; state: string; label: string }> }>(await run(ctx, "project.get", { projectId: project.id })).materials;
    expect(shown.find((item) => item.kind === "note")).toMatchObject({ state: "missing", label: "引用的笔记" });

    const removed = ok<{ removed: { materials: number } }>(await run(ctx, "project.delete", { projectId: project.id }));
    expect(removed.removed.materials).toBe(2);
    expect(["works", "resources", "anchors"].map((table) => count(ctx, `SELECT COUNT(*) AS n FROM ${table}`))).toEqual(before.slice(0, 3));
    expect(count(ctx, "SELECT COUNT(*) AS n FROM project_materials")).toBe(0);
  });

  it("keeps terms apart from the voice dictionary and imports a work's dictionary into the project", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "有词典的作品", pageCount: 1 });
    ok(await run(ctx, "dictionary.add", { scope: "work", workId: comic.workId, term: "魔王城", heard: "魔王成" }));
    ok(await run(ctx, "dictionary.add", { scope: "work", workId: comic.workId, term: "勇者" }));
    ok(await run(ctx, "dictionary.add", { scope: "global", term: "全局词" }));
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "术语" }));
    ok(await run(ctx, "project.addTerm", { projectId: project.id, term: "既有词", note: "先写的" }));
    const imported = ok<{ added: number; skipped: number }>(await run(ctx, "project.importTerms", { projectId: project.id, workId: comic.workId }));
    expect(imported).toEqual({ added: 2, skipped: 0 });
    // A second import adds nothing and a term the project already has is not overwritten.
    ok(await run(ctx, "project.addTerm", { projectId: project.id, term: "魔王城", note: "我的写法" }));
    expect(ok<{ added: number; skipped: number }>(await run(ctx, "project.importTerms", { projectId: project.id, workId: comic.workId }))).toEqual({ added: 0, skipped: 2 });
    const terms = ok<{ terms: Array<{ id: string; term: string; note: string | null }> }>(await run(ctx, "project.terms", { projectId: project.id })).terms;
    expect(terms.map((item) => item.term)).toEqual(["既有词", "魔王城", "勇者"]);
    expect(terms.find((item) => item.term === "魔王城")!.note).toBe("我的写法");
    // The project's terms are not the dictionary: nothing was added there, and the global term did not come along.
    expect(count(ctx, "SELECT COUNT(*) AS n FROM dictionary_terms")).toBe(3);

    const renamed = ok<{ term: string }>(await run(ctx, "project.updateTerm", { projectId: project.id, termId: terms[0]!.id, term: "改名词", heard: "该名词" }));
    expect(renamed.term).toBe("改名词");
    expect((await run(ctx, "project.updateTerm", { projectId: project.id, termId: terms[0]!.id, term: "勇者" })).status).toBe("error");
    ok(await run(ctx, "project.removeTerm", { projectId: project.id, termId: terms[0]!.id }));
    expect(ok<{ terms: unknown[] }>(await run(ctx, "project.terms", { projectId: project.id })).terms).toHaveLength(2);
  });

  it("keeps a conversation for each project and each mode, and a deleted project leaves its conversation behind", async () => {
    const ctx = await boot();
    const alpha = ok<{ id: string }>(await run(ctx, "project.create", { name: "阿尔法" }));
    const beta = ok<{ id: string }>(await run(ctx, "project.create", { name: "贝塔" }));
    const a = ok<{ id: string; title: string; kind: string; projectId: string; reused: boolean }>(await run(ctx, "session.open", { kind: "project", targetId: alpha.id, mode: "creator" }));
    const b = ok<{ id: string; projectId: string }>(await run(ctx, "session.open", { kind: "project", targetId: beta.id, mode: "creator" }));
    expect(a).toMatchObject({ title: "阿尔法", kind: "project", projectId: alpha.id, reused: false });
    expect(b.id).not.toBe(a.id);
    expect(ok<{ id: string; reused: boolean }>(await run(ctx, "session.open", { kind: "project", targetId: alpha.id, mode: "creator" }))).toMatchObject({ id: a.id, reused: true });

    const listed = ok<unknown>(await run(ctx, "workspace.sessions", { mode: "creator" })) as Array<{ sessionId: string; projectId: string | null; kind: string }>;
    expect(listed.filter((row) => row.kind === "project").map((row) => [row.sessionId, row.projectId]).sort()).toEqual([[a.id, alpha.id], [b.id, beta.id]].sort());
    expect(ok<{ projects: Array<{ counts: { sessions: number } }> }>(await run(ctx, "project.list", {})).projects.map((item) => item.counts.sessions)).toEqual([1, 1]);

    const removed = ok<{ keptSessions: number }>(await run(ctx, "project.delete", { projectId: alpha.id }));
    expect(removed.keptSessions).toBe(1);
    // The conversation is still there, now bound to no project.
    expect(ctx.app.store.sqlite.prepare("SELECT project_id FROM agent_sessions WHERE id = ?").get(a.id)).toEqual({ project_id: null });
  });

  it("limits a project conversation to the project's scope and uses the project's own connection", async () => {
    const ctx = await boot();
    const seen: Array<Record<string, any>> = [];
    const server = await startMockProvider({ mode: "ok", onRequest: (request) => { seen.push(request as Record<string, any>); } });
    closers.push(server.close);
    const connect = async (label: string) => ok<{ id: string }>(await run(ctx, "connections.upsert", { label, protocol: "openai-chat-completions", baseUrl: server.url, modelId: `model-${label}`, purpose: "text", credentialHandle: ctx.app.stashSecret(`credential-${counter += 1}`) })).id;
    const first = await connect("默认");
    const own = await connect("项目专用");

    const inside = seedComic(ctx.app, { title: "项目里的漫画", pageCount: 2 });
    const outside = seedComic(ctx.app, { title: "项目外的漫画", pageCount: 2 });
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "范围", goal: "只谈项目里的东西" }));
    ok(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "work", targetId: inside.workId }));
    ok(await run(ctx, "project.addTerm", { projectId: project.id, term: "专有名词甲" }));
    const session = ok<{ id: string }>(await run(ctx, "session.open", { kind: "project", targetId: project.id, mode: "creator" }));

    // Asking for something outside the project reads nothing of it; the project's own material is what the conversation looks through.
    const sent = ok<{ runId: string; materials: Array<{ resourceId: string }>; contextText: string | null }>(await run(ctx, "agent.send", { sessionId: session.id, text: "说说这两部", readResourceIds: [inside.resourceId, outside.resourceId] }));
    await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId);
    expect(sent.materials.map((item) => item.resourceId)).toEqual([inside.resourceId]);
    expect(sent.contextText).toContain("项目：范围");
    expect(sent.contextText).toContain("目标：只谈项目里的东西");
    expect(sent.contextText).toContain("专有名词甲");
    expect(sent.contextText).not.toContain("项目外的漫画");

    // With nothing ticked, the project's materials are what the task may read; a page outside the project is refused before a run exists.
    const nothing = ok<{ runId: string; materials: Array<{ resourceId: string }> }>(await run(ctx, "agent.send", { sessionId: session.id, text: "整体看看" }));
    await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, nothing.runId);
    expect(nothing.materials.map((item) => item.resourceId)).toEqual([inside.resourceId]);
    const before = count(ctx, "SELECT COUNT(*) AS n FROM agent_runs");
    const refused = await run(ctx, "agent.send", { sessionId: session.id, text: "看这页", mediaContext: { comic: { resourceId: outside.resourceId, resourceRevisionId: outside.revisionId, pageId: outside.pageIds[0] } } });
    expect(refused.error?.code).toBe("SCOPE_DENIED");
    expect(count(ctx, "SELECT COUNT(*) AS n FROM agent_runs")).toBe(before);

    // The first text connection is the default until the project asks for its own.
    const connectionOf = (runId: string) => (JSON.parse((ctx.app.store.sqlite.prepare("SELECT snapshot_json FROM agent_runs WHERE id = ?").get(runId) as { snapshot_json: string }).snapshot_json) as { connectionId: string }).connectionId;
    expect(connectionOf(sent.runId)).toBe(first);
    ok(await run(ctx, "project.update", { projectId: project.id, modelConnectionId: own }));
    const second = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId: session.id, text: "换连接后" }));
    const finished = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, second.runId);
    expect(connectionOf(second.runId)).toBe(own);
    expect(finished.value?.status).toBe("succeeded");
    expect(seen.length).toBeGreaterThan(0);
    // A connection that is not a text connection cannot be chosen.
    const voice = ok<{ id: string }>(await run(ctx, "connections.upsert", { label: "转录", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "asr", purpose: "transcription", credentialHandle: ctx.app.stashSecret("credential-asr") }));
    expect((await run(ctx, "project.update", { projectId: project.id, modelConnectionId: voice.id })).status).toBe("error");
    // Another project's conversation is untouched by this one's connection.
    const other = ok<{ id: string }>(await run(ctx, "project.create", { name: "另一个" }));
    expect(ok<{ id: string; projectId: string }>(await run(ctx, "session.open", { kind: "project", targetId: other.id, mode: "creator" })).projectId).toBe(other.id);
  });
});
