import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startMockProvider } from "@manga/model-protocol";
import { AGENT_PROJECT_COMMANDS } from "../../packages/app-core/src/creative/agent-access.ts";
import { startApp, waitForRun } from "../helpers/app.ts";
import { all, makeProject, ok, one, run } from "../helpers/creative-project.ts";

type App = Awaited<ReturnType<typeof startApp>>;
const apps: App[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (apps.length) apps.pop()!.app.close();
  while (closers.length) await closers.pop()!();
});

let counter = 0;
const agent = { kind: "agent" as const, id: "agent:run-at85" };

/** A project with everything in it, a second project with objects of its own, and a task of the first one. */
async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  const a = await makeProject(ctx, "甲项目");
  const b = ok<{ id: string }>(await run(ctx, "project.create", { name: "乙项目", goal: "不相干的事" })).id;
  const boardB = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId: b, title: "乙的白板" })).board.id;
  ok(await run(ctx, "whiteboard.edit", { boardId: boardB, actions: [{ type: "addNode", id: "b-card", kind: "card", x: 0, y: 0, data: { title: "乙的卡片" } }] }));
  const mapB = ok<{ map: { id: string } }>(await run(ctx, "mindmap.create", { projectId: b, title: "乙的导图", rootText: "乙的根" })).map.id;
  const draftB = ok<{ draft: { id: string } }>(await run(ctx, "draft.create", { projectId: b, title: "乙的文稿", text: "乙项目的暗号是蓝鲸" })).draft.id;
  ctx.app.store.sqlite.prepare("INSERT INTO excerpt_pages(id, url, title, fetched_at, content_hash, body_text, version, previous_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("pgv-b", "https://pages.example.org/b-only", "乙的网页", "2026-10-01T10:00:00.000Z", createHash("sha256").update("乙项目的网页正文").digest("hex"), "乙项目的网页正文", 1, null, "2026-10-01T10:00:00.000Z");
  const excerptB = ok<{ excerpt: { id: string } }>(await run(ctx, "excerpt.create", { pageId: "pgv-b", start: 0, end: 4, title: "乙的摘录", projectId: b })).excerpt.id;
  const noteC = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "乙的笔记", text: "乙项目才有的话：蓝鲸。" })).objectId;
  ok(await run(ctx, "project.addMaterial", { projectId: b, kind: "note", targetId: noteC }));
  const opened = ok<{ id: string }>(await run(ctx, "session.open", { kind: "project", targetId: a.projectId, contextId: a.projectId }));
  const grant = ctx.app.issueAgentGrant(ctx.grant, agent, { sessionId: opened.id, runId: "run-at85", readResourceIds: [a.book.resourceId], projectId: a.projectId });
  return { ctx, a, b, boardB, mapB, draftB, excerptB, noteC, sessionId: opened.id, grant };
}
type World = Awaited<ReturnType<typeof boot>>;

/** A command as the project's task. */
function asAgent(world: World, commandId: string, input: Record<string, unknown>, grantHandle = world.grant.handle) {
  counter += 1;
  return world.ctx.app.call(agent, { commandId, idempotencyKey: `at85-${counter}`, input }, grantHandle);
}
const failure = (result: Awaited<ReturnType<App["app"]["call"]>>) => { expect(result.status, JSON.stringify(result)).toBe("error"); return result.error!; };

describe("AT-85 agent creative tools: a project's task reads its own project", () => {
  it("reads the project, its boards, maps, drafts, rough cuts, excerpts and the pages they came from, and searches only what the project holds", async () => {
    const world = await boot();
    const { a } = world;
    const list = ok<{ projects: Array<{ id: string }> }>(await asAgent(world, "project.list", {}));
    expect(list.projects.map((item) => item.id)).toEqual([a.projectId]);
    const project = ok<{ project: { id: string; name: string }; terms: Array<{ term: string }> }>(await asAgent(world, "project.get", { projectId: a.projectId }));
    expect(project.project).toMatchObject({ id: a.projectId, name: "甲项目" });
    expect(project.terms.map((item) => item.term)).toContain("石桥");
    const objects = ok<{ objects: Array<{ kind: string; id: string }> }>(await asAgent(world, "project.objects", { projectId: a.projectId })).objects;
    expect(objects.map((item) => item.id)).toEqual(expect.arrayContaining([a.boardId, a.mapId, a.draftId, a.excerptId, "cut-1"]));
    expect(ok<{ terms: Array<{ term: string }> }>(await asAgent(world, "project.terms", { projectId: a.projectId })).terms.map((item) => item.term)).toEqual(["石桥"]);

    expect(ok<{ boards: Array<{ id: string }> }>(await asAgent(world, "whiteboard.list", {})).boards.map((item) => item.id)).toEqual([a.boardId]);
    const board = ok<{ nodes: Array<{ id: string }> }>(await asAgent(world, "whiteboard.get", { boardId: a.boardId }));
    expect(board.nodes.map((node) => node.id)).toEqual(expect.arrayContaining(["wb-card", "wb-text"]));
    expect(ok<{ maps: Array<{ id: string }> }>(await asAgent(world, "mindmap.list", {})).maps.map((item) => item.id)).toEqual([a.mapId]);
    expect(JSON.stringify(ok(await asAgent(world, "mindmap.get", { mapId: a.mapId })))).toContain("开场");
    expect(ok<{ drafts: Array<{ id: string }> }>(await asAgent(world, "draft.list", {})).drafts.map((item) => item.id)).toEqual([a.draftId]);
    expect(ok<{ draft: { text: string } }>(await asAgent(world, "draft.get", { draftId: a.draftId })).draft.text).toBe("第二稿，加了开场。");
    expect(ok<{ text: string }>(await asAgent(world, "draft.version", { draftId: a.draftId, version: 1 })).text).toBe("第一稿");
    expect(ok<{ cuts: Array<{ id: string }> }>(await asAgent(world, "roughcut.list", {})).cuts.map((item) => item.id)).toEqual(["cut-1"]);
    expect(JSON.stringify(ok(await asAgent(world, "roughcut.get", { cutId: "cut-1" })))).toContain("clip-1");

    expect(ok<{ excerpts: Array<{ id: string }> }>(await asAgent(world, "excerpt.list", {})).excerpts.map((item) => item.id)).toEqual([a.excerptId]);
    expect(ok<{ excerpt: { text: string } }>(await asAgent(world, "excerpt.get", { excerptId: a.excerptId })).excerpt.text).toContain("沙漠里的驼队");
    expect(ok<{ pages: Array<{ id: string }> }>(await asAgent(world, "webpage.list", {})).pages.map((item) => item.id)).toEqual(["pgv-1"]);
    const page = ok<{ text: string; excerpts: Array<{ id: string }> }>(await asAgent(world, "webpage.get", { pageId: "pgv-1" }));
    expect(page.text).toContain("沙漠里的驼队");
    expect(page.excerpts.map((item) => item.id)).toEqual([a.excerptId]);

    // The search looks through the project's materials only: the work, its note, the recording and the excerpt; not the saved pages, and not the other project's note.
    const found = ok<{ results: Array<{ kind: string; id: string }> }>(await asAgent(world, "research.search", { text: "雨夜" }));
    expect(found.results.length).toBeGreaterThan(0);
    expect(found.results.every((item) => item.kind !== "page")).toBe(true);
    expect(ok<{ results: Array<{ kind: string }> }>(await asAgent(world, "research.search", { text: "灯塔" })).results.map((item) => item.kind)).toEqual(["recording"]);
    expect(ok<{ results: unknown[] }>(await asAgent(world, "research.search", { text: "蓝鲸" })).results).toEqual([]);
    expect(ok<{ results: unknown[] }>(await asAgent(world, "research.search", { text: "驼队", scopes: ["page"] })).results).toEqual([]);
  });

  it("refuses everything that belongs to another project, in the command layer, by id or by name", async () => {
    const world = await boot();
    const { a, b } = world;
    // Naming the other project, or an object of it, is refused with SCOPE_DENIED; nothing of it comes back.
    for (const [commandId, input] of [
      ["project.get", { projectId: b }], ["project.objects", { projectId: b }], ["project.terms", { projectId: b }],
      ["whiteboard.list", { projectId: b }], ["whiteboard.get", { boardId: world.boardB }],
      ["mindmap.list", { projectId: b }], ["mindmap.get", { mapId: world.mapB }],
      ["draft.list", { projectId: b }], ["draft.get", { draftId: world.draftB }], ["draft.version", { draftId: world.draftB, version: 1 }],
      ["roughcut.list", { projectId: b }], ["excerpt.list", { projectId: b }], ["excerpt.get", { excerptId: world.excerptB }],
      ["research.search", { text: "蓝鲸", projectId: b }], ["webpage.get", { pageId: "pgv-b" }],
      ["project.addTerm", { projectId: b, term: "越界" }], ["project.addMaterial", { projectId: b, kind: "resource", targetId: a.book.resourceId }],
      ["whiteboard.edit", { boardId: world.boardB, actions: [{ type: "addNode", kind: "text", x: 0, y: 0, data: { text: "越界" } }] }],
      ["mindmap.edit", { mapId: world.mapB, actions: [{ type: "addChild", parentId: "x", text: "越界" }] }],
      ["draft.suggest", { draftId: world.draftB, kind: "continue", text: "越界" }],
    ] as const) {
      expect(failure(await asAgent(world, commandId, input)).code, commandId).toBe("SCOPE_DENIED");
    }
    expect(JSON.stringify(ok(await asAgent(world, "project.list", {})))).not.toContain("乙项目");
    expect(JSON.stringify(ok(await asAgent(world, "webpage.list", {})))).not.toContain("pgv-b");
    // Nothing of the other project changed.
    expect(one<{ n: number }>(world.ctx, "SELECT COUNT(*) AS n FROM whiteboard_nodes WHERE board_id = ?", world.boardB).n).toBe(1);
    expect(one<{ text: string }>(world.ctx, "SELECT text FROM drafts WHERE id = ?", world.draftB).text).toBe("乙项目的暗号是蓝鲸");
    expect(one<{ n: number }>(world.ctx, "SELECT COUNT(*) AS n FROM project_terms WHERE project_id = ?", b).n).toBe(0);
    expect(one<{ n: number }>(world.ctx, "SELECT COUNT(*) AS n FROM draft_suggestions WHERE draft_id = ?", world.draftB).n).toBe(0);
  });

  it("has no project commands in a conversation that is not a project's: the grant lacks them, and a grant for another session is refused", async () => {
    const world = await boot();
    const { ctx } = world;
    // The global and resource conversations get the plain tool set.
    const shared = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "全局" }));
    const plain = ctx.app.issueAgentGrant(ctx.grant, agent, { sessionId: shared.id, runId: "run-plain", readResourceIds: [] });
    for (const commandId of AGENT_PROJECT_COMMANDS) expect(plain.allowedCommands, commandId).not.toContain(commandId);
    expect(failure(await asAgent(world, "project.list", {}, plain.handle)).code).toBe("FORBIDDEN");
    expect(failure(await asAgent(world, "whiteboard.get", { boardId: world.a.boardId }, plain.handle)).code).toBe("FORBIDDEN");
    // Even a grant that lists the commands is checked against the conversation it belongs to.
    const borrowed = ctx.app.issueAgentGrant(ctx.grant, agent, { sessionId: shared.id, runId: "run-borrowed", readResourceIds: [], projectId: world.a.projectId });
    expect(failure(await asAgent(world, "project.list", {}, borrowed.handle)).code).toBe("SCOPE_DENIED");
    const none = ctx.app.issueAgentGrant(ctx.grant, agent, { runId: "run-none", readResourceIds: [], projectId: world.a.projectId });
    expect(failure(await asAgent(world, "project.get", { projectId: world.a.projectId }, none.handle)).code).toBe("SCOPE_DENIED");
    // The owner's own commands are not reached through an agent's grant at all.
    expect(failure(await asAgent(world, "project.create", { name: "新" })).code).toBe("FORBIDDEN");
  });

  it("does not offer deleting, renaming, packages, rough cut edits and exports, semantic search, page fetching, plugins or downloads, and refuses them if asked", async () => {
    const world = await boot();
    const refused: Array<[string, Record<string, unknown>]> = [
      ["project.create", { name: "新" }], ["project.update", { projectId: world.a.projectId, name: "改名" }], ["project.delete", { projectId: world.a.projectId }],
      ["project.removeMaterial", { projectId: world.a.projectId, materialId: "x" }], ["project.updateTerm", { projectId: world.a.projectId, termId: "x", term: "y" }],
      ["project.removeTerm", { projectId: world.a.projectId, termId: "x" }], ["project.importTerms", { projectId: world.a.projectId, workId: "x" }],
      ["project.exportPackage", { projectId: world.a.projectId, pathHandle: "p" }], ["project.importPackage", { pathHandle: "p" }],
      ["whiteboard.create", { projectId: world.a.projectId, title: "x" }], ["whiteboard.rename", { boardId: world.a.boardId, title: "x" }], ["whiteboard.delete", { boardId: world.a.boardId }],
      ["whiteboard.undo", { boardId: world.a.boardId }], ["mindmap.create", { projectId: world.a.projectId, title: "x" }], ["mindmap.rename", { mapId: world.a.mapId, title: "x" }],
      ["mindmap.delete", { mapId: world.a.mapId }], ["mindmap.export", { mapId: world.a.mapId, format: "markdown", pathHandle: "p" }],
      ["draft.create", { projectId: world.a.projectId, title: "x" }], ["draft.save", { draftId: world.a.draftId, expectedVersion: 2, text: "x" }], ["draft.delete", { draftId: world.a.draftId }],
      ["draft.adopt", { suggestionId: "sug-done" }], ["draft.restore", { draftId: world.a.draftId, version: 1 }],
      ["roughcut.create", { projectId: world.a.projectId, title: "x" }], ["roughcut.edit", { cutId: "cut-1", actions: [{ type: "remove", clipId: "clip-1" }] }], ["roughcut.export", { cutId: "cut-1", pathHandle: "p" }], ["roughcut.delete", { cutId: "cut-1" }],
      ["excerpt.create", { pageId: "pgv-1", start: 0, end: 2 }], ["excerpt.delete", { excerptId: world.a.excerptId }], ["webpage.fetch", { url: "https://pages.example.org/x" }], ["webpage.delete", { pageId: "pgv-1" }],
      ["semantic.configure", { enabled: true }], ["semantic.search", { text: "雨夜" }], ["plugin.install", { bundledId: "xx", grant: [] }], ["plugin.enable", { pluginId: "xx" }], ["acquisition.add", { magnet: "magnet:?xt=urn:btih:0000", pathId: "p1" }],
      ["embed.upsert", { sourceKind: "note", sourceId: "n", slot: "s", targetKind: "note", targetId: "m" }],
    ];
    const codes: Record<string, string | undefined> = {};
    for (const [commandId, input] of refused) {
      expect(AGENT_PROJECT_COMMANDS, commandId).not.toContain(commandId);
      expect(world.grant.allowedCommands, commandId).not.toContain(commandId);
      codes[commandId] = failure(await asAgent(world, commandId, input)).code;
    }
    expect(Object.entries(codes).filter(([, code]) => code !== "FORBIDDEN")).toEqual([]);
    // The tool list is exactly the reads and the five writes of A-73.
    expect([...AGENT_PROJECT_COMMANDS].sort()).toEqual([
      "draft.get", "draft.list", "draft.suggest", "draft.version", "excerpt.get", "excerpt.list", "mindmap.edit", "mindmap.get", "mindmap.list", "project.addMaterial", "project.addTerm",
      "project.get", "project.list", "project.objects", "project.terms", "research.search", "roughcut.get", "roughcut.list", "webpage.get", "webpage.list", "whiteboard.edit", "whiteboard.get", "whiteboard.list",
    ]);
  });
});

describe("AT-85 agent creative tools: writes the person can take back", () => {
  it("edits a board and a map as one step each, labelled as the agent's, logged under the agent, and the board's and the map's own undo takes it back", async () => {
    const world = await boot();
    const { ctx, a } = world;
    const before = ok<{ nodes: unknown[] }>(await run(ctx, "whiteboard.get", { boardId: a.boardId })).nodes.length;
    const edited = ok<{ created: string[]; ops: { undoLabel: string | null } }>(await asAgent(world, "whiteboard.edit", { boardId: a.boardId, label: "整理想法", actions: [
      { type: "addNode", id: "ag-1", kind: "card", x: 400, y: 0, data: { title: "Agent 的卡片" } },
      { type: "addNode", id: "ag-2", kind: "text", x: 400, y: 200, data: { text: "Agent 的想法" } },
      { type: "addEdge", id: "ag-e", sourceId: "ag-1", targetId: "ag-2", label: "引出" },
    ] }));
    expect(edited.created).toEqual(expect.arrayContaining(["ag-1", "ag-2"]));
    expect(edited.ops.undoLabel).toBe("Agent：整理想法");
    expect(ok<{ nodes: unknown[] }>(await run(ctx, "whiteboard.get", { boardId: a.boardId })).nodes).toHaveLength(before + 2);
    // One call is one step: the person's undo takes all three actions back, and redo brings them again.
    ok(await run(ctx, "whiteboard.undo", { boardId: a.boardId }));
    const undone = ok<{ nodes: Array<{ id: string }>; edges: Array<{ id: string }>; ops: { canRedo: boolean } }>(await run(ctx, "whiteboard.get", { boardId: a.boardId }));
    expect(undone.nodes).toHaveLength(before);
    expect(undone.edges.map((edge) => edge.id)).not.toContain("ag-e");
    expect(undone.ops.canRedo).toBe(true);

    const rootId = ok<{ nodes: Array<{ id: string }> }>(await run(ctx, "mindmap.get", { mapId: a.mapId })).nodes[0]!.id;
    const map = ok<{ doc: { ops: { undoLabel: string | null } } }>(await asAgent(world, "mindmap.edit", { mapId: a.mapId, actions: [{ type: "addChild", parentId: rootId, id: "ag-child", text: "Agent 加的一支" }] }));
    expect(map.doc.ops.undoLabel).toBe("Agent：addChild");
    expect(JSON.stringify(ok(await run(ctx, "mindmap.get", { mapId: a.mapId })))).toContain("Agent 加的一支");
    ok(await run(ctx, "mindmap.undo", { mapId: a.mapId }));
    expect(JSON.stringify(ok(await run(ctx, "mindmap.get", { mapId: a.mapId })))).not.toContain("Agent 加的一支");

    // Both are in the operation log with the agent as the one who did them, and the log carries no card text.
    const entries = ctx.app.log.query({ limit: 50 }).entries.filter((entry) => entry.actorKind === "agent");
    expect(entries.map((entry) => entry.action)).toEqual(expect.arrayContaining(["whiteboard.edit", "mindmap.edit"]));
    expect(entries.find((entry) => entry.action === "whiteboard.edit")).toMatchObject({ actorKind: "agent", category: "canvas", objectKind: "whiteboard", objectId: a.boardId, outcome: "ok" });
    expect(JSON.stringify(entries)).not.toContain("Agent 的卡片");
  });

  it("points a card or a node only at what the task can see, and a refused edit changes nothing", async () => {
    const world = await boot();
    const { ctx, a } = world;
    const before = ok<{ nodes: unknown[] }>(await run(ctx, "whiteboard.get", { boardId: a.boardId })).nodes.length;
    const outsideNote = failure(await asAgent(world, "whiteboard.edit", { boardId: a.boardId, actions: [
      { type: "addNode", id: "ok-card", kind: "card", x: 0, y: 0, data: { title: "不会留下" } },
      { type: "addNode", id: "bad-ref", kind: "ref", x: 0, y: 100, data: { refKind: "note", targetId: a.noteB } },
    ] }));
    expect(outsideNote.code).toBe("SCOPE_DENIED");
    expect(ok<{ nodes: unknown[] }>(await run(ctx, "whiteboard.get", { boardId: a.boardId })).nodes).toHaveLength(before);
    // What the project holds can be pointed at.
    ok(await asAgent(world, "whiteboard.edit", { boardId: a.boardId, actions: [{ type: "addNode", id: "good-ref", kind: "ref", x: 0, y: 100, data: { refKind: "note", targetId: a.noteA } }] }));
    expect(failure(await asAgent(world, "mindmap.edit", { mapId: a.mapId, actions: [{ type: "addRef", nodeId: "mm-child", kind: "note", targetId: world.noteC }] })).code).toBe("SCOPE_DENIED");
    expect(failure(await asAgent(world, "mindmap.edit", { mapId: a.mapId, actions: [{ type: "addRef", nodeId: "mm-child", kind: "resource", targetId: "res-not-readable" }] })).code).toBe("SCOPE_DENIED");
  });

  it("adds a term that is new, leaves a term that is there as the person wrote it, and the person can remove the one the agent added", async () => {
    const world = await boot();
    const { ctx, a } = world;
    const added = ok<{ id: string; term: string }>(await asAgent(world, "project.addTerm", { projectId: a.projectId, term: "驼队", heard: "托队", note: "开场用词" }));
    expect(added.term).toBe("驼队");
    expect(failure(await asAgent(world, "project.addTerm", { projectId: a.projectId, term: "石桥", note: "改掉" })).code).toBe("VALIDATION_ERROR");
    expect(one<{ note: string }>(ctx, "SELECT note FROM project_terms WHERE project_id = ? AND term = '石桥'", a.projectId).note).toBe("地名");
    expect(ctx.app.log.query({ limit: 20 }).entries.find((entry) => entry.action === "project.addTerm")).toMatchObject({ actorKind: "agent", category: "projects", objectKind: "project", objectId: a.projectId });
    ok(await run(ctx, "project.removeTerm", { projectId: a.projectId, termId: added.id }));
    expect(all<{ term: string }>(ctx, "SELECT term FROM project_terms WHERE project_id = ?", a.projectId).map((row) => row.term)).toEqual(["石桥"]);
  });

  it("adds a reference to a material it can already see: a note it wrote, a resource it may read; not what it cannot, not other kinds; the person removes it", async () => {
    const world = await boot();
    const { ctx, a } = world;
    // A note the task wrote becomes writable for it, and can then join the project.
    const note = ok<{ objectId: string }>(await asAgent(world, "notes.create", { title: "Agent 的笔记", text: "整理出的要点" }));
    const material = ok<{ id: string }>(await asAgent(world, "project.addMaterial", { projectId: a.projectId, kind: "note", targetId: note.objectId }));
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM project_materials WHERE project_id = ? AND kind = 'note' AND target_id = ?", a.projectId, note.objectId).n).toBe(1);
    ok(await run(ctx, "project.removeMaterial", { projectId: a.projectId, materialId: material.id }));
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM project_materials WHERE project_id = ? AND target_id = ?", a.projectId, note.objectId).n).toBe(0);
    // The log names the agent; the note itself stays where it was made.
    expect(ctx.app.log.query({ limit: 30 }).entries.find((entry) => entry.action === "project.addMaterial")).toMatchObject({ actorKind: "agent" });
    ok(await asAgent(world, "project.addMaterial", { projectId: a.projectId, kind: "resource", targetId: a.book.resourceId }));
    // What the agent adds is its own addition, never one that looks automatic.
    expect(one<{ origin: string }>(ctx, "SELECT origin FROM project_materials WHERE project_id = ? AND kind = 'resource' AND target_id = ?", a.projectId, a.book.resourceId).origin).toBe("manual");
    for (const origin of ["auto", "manual"]) {
      expect(failure(await asAgent(world, "project.addMaterial", { projectId: a.projectId, kind: "note", targetId: note.objectId, origin })).code, origin).toBe("FORBIDDEN");
    }
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM project_materials WHERE project_id = ? AND target_id = ?", a.projectId, note.objectId).n).toBe(0);
    // A note of the owner's that the project does not hold, a resource the task was not given, and kinds that reach for more are refused.
    for (const input of [
      { kind: "note", targetId: a.noteB }, { kind: "note", targetId: world.noteC }, { kind: "resource", targetId: "res-not-given" },
      { kind: "work", targetId: a.book.workId }, { kind: "recording", targetId: "cap-1" }, { kind: "whiteboard", targetId: world.boardB }, { kind: "draft", targetId: world.draftB },
    ]) {
      expect(failure(await asAgent(world, "project.addMaterial", { projectId: a.projectId, ...input })).code, JSON.stringify(input)).toBe("SCOPE_DENIED");
    }
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM project_materials WHERE project_id = ? AND target_id IN (?, ?, ?)", a.projectId, a.noteB, world.noteC, "res-not-given").n).toBe(0);
  });

  it("writes a suggestion for a draft without changing it and without asking a model; the person adopts it, takes it back, or discards it", async () => {
    const world = await boot();
    const { ctx, a } = world;
    // No text model is set up in this profile: the suggestion is the agent's own text, so none is needed.
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM provider_connections").n).toBe(0);
    const made = ok<{ suggestion: { id: string; status: string; by: string | null; preview: string; connectionId: string | null } }>(await asAgent(world, "draft.suggest", { draftId: a.draftId, kind: "continue", instruction: "接着写结尾", text: "结尾：驼队消失在夜色里。" }));
    expect(made.suggestion).toMatchObject({ status: "pending", by: "agent", connectionId: null });
    expect(made.suggestion.preview).toContain("驼队消失在夜色里");
    expect(one<{ text: string; version: number }>(ctx, "SELECT text, version FROM drafts WHERE id = ?", a.draftId)).toEqual({ text: "第二稿，加了开场。", version: 2 });
    const detail = ok<{ suggestion: { resultText: string; baseText: string } }>(await run(ctx, "draft.suggestion", { suggestionId: made.suggestion.id }));
    expect(detail.suggestion.resultText).toBe("第二稿，加了开场。\n\n结尾：驼队消失在夜色里。");
    expect(ctx.app.log.query({ limit: 30 }).entries.find((entry) => entry.action === "draft.suggest")).toMatchObject({ actorKind: "agent", category: "copy", objectKind: "draft", objectId: a.draftId });
    // The person decides.
    ok(await run(ctx, "draft.adopt", { suggestionId: made.suggestion.id }));
    expect(one<{ text: string }>(ctx, "SELECT text FROM drafts WHERE id = ?", a.draftId).text).toContain("驼队消失在夜色里");
    ok(await run(ctx, "draft.undoAdopt", { suggestionId: made.suggestion.id }));
    expect(one<{ text: string }>(ctx, "SELECT text FROM drafts WHERE id = ?", a.draftId).text).toBe("第二稿，加了开场。");
    const second = ok<{ suggestion: { id: string } }>(await asAgent(world, "draft.suggest", { draftId: a.draftId, kind: "polish", range: { start: 0, end: 3 }, text: "初稿" }));
    ok(await run(ctx, "draft.discardSuggestion", { suggestionId: second.suggestion.id }));
    expect(one<{ status: string }>(ctx, "SELECT status FROM draft_suggestions WHERE id = ?", second.suggestion.id).status).toBe("discarded");
    // It is the agent's own words or nothing: no text, a model's connection, a redo or quoted sources are refused.
    expect(failure(await asAgent(world, "draft.suggest", { draftId: a.draftId, kind: "continue" })).code).toBe("VALIDATION_ERROR");
    for (const extra of [{ connectionId: "conn-1" }, { redoOf: "sug-done" }, { sources: [{ kind: "note", targetId: a.noteA }] }]) {
      expect(failure(await asAgent(world, "draft.suggest", { draftId: a.draftId, kind: "continue", text: "x", ...extra })).code, JSON.stringify(extra)).toBe("FORBIDDEN");
    }
  });
});

describe("AT-85 agent creative tools: what comes back fits the model", () => {
  it("cuts long text and long lists, and says so; a draft of 30 000 characters and a board of 300 cards still answer", async () => {
    const world = await boot();
    const { ctx, a } = world;
    const long = "很长的一段话。".repeat(4300);
    ok(await run(ctx, "draft.save", { draftId: a.draftId, expectedVersion: 2, text: long }));
    const draft = await asAgent(world, "draft.get", { draftId: a.draftId });
    const body = JSON.stringify(ok(draft));
    expect(body.length).toBeLessThanOrEqual(8000);
    expect(body).toContain("已截短，共 30100 字");
    expect(ok<{ draft: { text: string } }>(draft).draft.text.length).toBeLessThan(long.length);
    const actions = Array.from({ length: 200 }, (_, index) => ({ type: "addNode", id: `many-${index}`, kind: "text", x: index * 10, y: 0, data: { text: `卡片 ${index}` } }));
    ok(await run(ctx, "whiteboard.edit", { boardId: a.boardId, actions }));
    ok(await run(ctx, "whiteboard.edit", { boardId: a.boardId, actions: actions.map((action, index) => ({ ...action, id: `more-${index}` })) }));
    const board = await asAgent(world, "whiteboard.get", { boardId: a.boardId });
    expect(JSON.stringify(ok(board)).length).toBeLessThanOrEqual(8000);
    expect(JSON.stringify(ok(board))).toMatch(/另有 \d+ 项未显示/);
  });
});

describe("AT-85 agent creative tools: in a task of a project, through the model loop", () => {
  it("offers the project's tools without asking for a project, takes the project from the task, and asks again when a call repeats", async () => {
    const requests: Array<{ tools?: Array<{ function?: { name: string; parameters: { properties?: Record<string, unknown>; required?: string[] } } }> }> = [];
    const script: Array<{ name: string; arguments: string }> = [];
    const server = await startMockProvider({ streamToolScript: script, onRequest: (request) => { if (request.body.stream) requests.push(request.body as never); } });
    closers.push(server.close);
    const world = await boot();
    const { ctx, a } = world;
    ok(await run(ctx, "connections.upsert", { label: "文本", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "m", purpose: "text", credentialHandle: ctx.app.stashSecret("credential-at85-loop") }));
    const board = (id: string) => JSON.stringify({ boardId: id });
    script.push(
      { name: "project.get", arguments: "{}" },
      { name: "whiteboard.get", arguments: board(a.boardId) },
      { name: "whiteboard.edit", arguments: JSON.stringify({ boardId: a.boardId, actions: [{ type: "addNode", id: "loop-card", kind: "card", x: 0, y: 400, data: { title: "循环里加的" } }] }) },
      // The same call again: the board has changed since, so the answer has to be new.
      { name: "whiteboard.get", arguments: board(a.boardId) },
      { name: "draft.version", arguments: JSON.stringify({ draftId: a.draftId, version: 1 }) },
      // Not the same arguments: not the same answer.
      { name: "draft.version", arguments: JSON.stringify({ draftId: a.draftId, version: 2 }) },
      // The model names another project of its own accord: refused, and the task goes on.
      { name: "project.get", arguments: JSON.stringify({ projectId: world.b }) },
    );
    const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId: world.sessionId, text: "把想法整理到白板上" }));
    const finished = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId, 20_000);
    expect(finished.status).toBe("ok");
    expect((finished.value?.run as { status?: string } | undefined)?.status ?? finished.value?.status).toBe("succeeded");

    const events = all<{ command_id: string; status: string; result_summary: string }>(ctx, "SELECT command_id, status, result_summary FROM agent_tool_events WHERE run_id = ? ORDER BY created_at, rowid", sent.runId);
    expect(events.map((event) => `${event.command_id}:${event.status}`)).toEqual([
      "project.get:executed", "whiteboard.get:executed", "whiteboard.edit:executed", "whiteboard.get:executed", "draft.version:executed", "draft.version:executed", "project.get:failed",
    ]);
    expect(events[0]!.result_summary).toContain("甲项目");
    expect(events[1]!.result_summary).not.toContain("loop-card");
    expect(events[3]!.result_summary).toContain("loop-card");
    expect(events[4]!.result_summary).toContain("第一稿");
    expect(events[5]!.result_summary).toContain("第二稿");
    expect(events[6]!.result_summary).toContain("SCOPE_DENIED");
    // The agent's edit is in the log under the agent, and the person can take it back.
    expect(ctx.app.log.query({ limit: 20 }).entries.find((entry) => entry.action === "whiteboard.edit")).toMatchObject({ actorKind: "agent", runId: sent.runId });
    ok(await run(ctx, "whiteboard.undo", { boardId: a.boardId }));
    expect(JSON.stringify(ok(await run(ctx, "whiteboard.get", { boardId: a.boardId })))).not.toContain("loop-card");

    // What the model was shown: the project's tools, none for deleting or exporting, and no parameter that names a project.
    const names = (requests[0]?.tools ?? []).map((tool) => tool.function?.name);
    expect(names).toEqual(expect.arrayContaining([...AGENT_PROJECT_COMMANDS, "notes.create", "library.find"]));
    for (const forbidden of ["project.delete", "whiteboard.delete", "mindmap.delete", "draft.delete", "roughcut.export", "project.exportPackage", "webpage.fetch", "semantic.search", "plugin.install", "acquisition.add", "whiteboard.undo"]) expect(names).not.toContain(forbidden);
    for (const tool of requests[0]!.tools ?? []) {
      const parameters = tool.function!.parameters;
      if (AGENT_PROJECT_COMMANDS.includes(tool.function!.name)) {
        expect(Object.keys(parameters.properties ?? {}), tool.function!.name).not.toContain("projectId");
        expect(parameters.required ?? [], tool.function!.name).not.toContain("projectId");
      }
    }
    const suggest = requests[0]!.tools!.find((tool) => tool.function?.name === "draft.suggest")!.function!.parameters;
    expect(Object.keys(suggest.properties ?? {})).not.toEqual(expect.arrayContaining(["connectionId"]));
    expect(Object.keys(suggest.properties ?? {})).not.toContain("sources");
    expect(suggest.required).toEqual(expect.arrayContaining(["draftId", "kind", "text"]));
    const addMaterial = requests[0]!.tools!.find((tool) => tool.function?.name === "project.addMaterial")!.function!.parameters;
    expect(Object.keys(addMaterial.properties ?? {})).not.toContain("origin");
  });

  it("gives a conversation that is not a project's the plain tools only", async () => {
    const requests: Array<{ tools?: Array<{ function?: { name: string } }> }> = [];
    const server = await startMockProvider({ onRequest: (request) => { if (request.body.stream) requests.push(request.body as never); } });
    closers.push(server.close);
    const world = await boot();
    const { ctx } = world;
    ok(await run(ctx, "connections.upsert", { label: "文本", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "m", purpose: "text", credentialHandle: ctx.app.stashSecret("credential-at85-plain") }));
    const shared = ok<{ sessionId: string }>(await run(ctx, "conversation.new", { contextId: null }));
    const sent = ok<{ runId: string }>(await run(ctx, "agent.send", { sessionId: shared.sessionId, text: "你好" }));
    await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId, 20_000);
    const names = (requests[0]?.tools ?? []).map((tool) => tool.function?.name);
    expect(names).toContain("notes.create");
    for (const commandId of AGENT_PROJECT_COMMANDS) expect(names, commandId).not.toContain(commandId);
  });
});
