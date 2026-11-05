import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MangaError, type ProposalCard, type RoughcutExportView } from "@manga/contracts";
import { startApp, tempProfile } from "../helpers/app.ts";
import { ok, run } from "../helpers/creative-project.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";
import { inLibrary, samplePath } from "../helpers/samples.ts";
import { materialContextMessage } from "../../packages/app-core/src/commands/agent.ts";

type App = Awaited<ReturnType<typeof startApp>>;
const apps: App[] = [];
let counter = 0;
const actor = { kind: "agent" as const, id: "integrity-agent" };

afterEach(() => {
  vi.restoreAllMocks();
  while (apps.length) apps.pop()!.app.close();
});

async function seed() {
  const ctx = await startApp();
  apps.push(ctx);
  const projectId = ok<{ id: string }>(await run(ctx, "project.create", { name: "审查项目" })).id;
  const boardId = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId, title: "分镜" })).board.id;
  const draftId = ok<{ draft: { id: string } }>(await run(ctx, "draft.create", { projectId, title: "文稿", text: "不能丢掉的正文" })).draft.id;
  const cutId = ok<{ cut: { id: string } }>(await run(ctx, "roughcut.create", { projectId, title: "试剪" })).cut.id;
  const sessionId = ok<{ id: string }>(await run(ctx, "session.open", { kind: "project", targetId: projectId, contextId: projectId })).id;
  const state = {
    ctx, projectId, boardId, draftId, cutId, sessionId,
    grant: ctx.app.issueAgentGrant(ctx.grant, actor, { projectId, sessionId, runId: "integrity-run", readResourceIds: [] }),
  };
  return {
    ...state,
    asAgent: (commandId: string, input: Record<string, unknown>, key = `integrity-${++counter}`) =>
      ctx.app.call(actor, { commandId, idempotencyKey: key, input }, state.grant.handle),
  };
}

async function reopen(ctx: App) {
  ctx.app.close();
  const fresh = await startApp({ profileRoot: ctx.profileRoot });
  apps.push(fresh);
  return fresh;
}

function crash(ctx: App, proposalId: string, crashAt: string, dir?: string) {
  ctx.app.close();
  const child = spawnSync(process.execPath, [path.resolve("tests/helpers/proposal-crash-child.ts")], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MANGA_PROPOSAL_TEST_PROFILE: ctx.profileRoot,
      MANGA_PROPOSAL_TEST_ID: proposalId,
      MANGA_PROPOSAL_TEST_CRASH: crashAt,
      ...(dir ? { MANGA_PROPOSAL_TEST_EXPORT_DIR: dir } : {}),
    },
    encoding: "utf8", windowsHide: true, timeout: 60_000,
  });
  expect(child.status, child.stderr || child.stdout).toBe(99);
}

describe("AT-151 & AT-152 proposal integrity at the execution and recovery boundaries", () => {
  it("keeps private backlink titles in the owner's card and persists a single proposal across tool replay and restart", async () => {
    const { ctx, projectId, sessionId, boardId, asAgent } = await seed();
    const privateNote = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "任务之外的私人笔记", text: "私人材料" })).objectId;
    ok(await run(ctx, "embed.upsert", { sourceKind: "note", sourceId: privateNote, slot: "private-reference", targetKind: "whiteboard", targetId: boardId }));
    const input = { kind: "whiteboard", targetId: boardId };
    const created = ok<{ proposalId: string; status: string; summary: string }>(await asAgent("proposal.delete", input, "repeat-proposal"));
    expect(Object.keys(created).sort()).toEqual(["proposalId", "status", "summary"]);
    expect(JSON.stringify(created)).not.toContain("任务之外的私人笔记");
    expect(ctx.app.proposals.getCard(created.proposalId).preview.lines.join(" ")).toContain("任务之外的私人笔记");
    const replay = await asAgent("proposal.delete", input, "repeat-proposal");
    expect(replay).toMatchObject({ status: "ok", idempotentReplay: true, value: { proposalId: created.proposalId } });
    const fresh = await reopen(ctx);
    const grant = fresh.app.issueAgentGrant(fresh.grant, actor, { projectId, sessionId, runId: "integrity-run", readResourceIds: [] });
    const afterRestart = await fresh.app.call(actor, { commandId: "proposal.delete", idempotencyKey: "repeat-proposal", input }, grant.handle);
    expect(afterRestart).toMatchObject({ status: "ok", idempotentReplay: true, value: { proposalId: created.proposalId } });
    expect(fresh.app.proposals.list({ sessionId }).proposals).toHaveLength(1);
  });

  it("rechecks a target when the owner handler runs, preserving a user edit made after confirmation was claimed", async () => {
    const { ctx, boardId, asAgent } = await seed();
    const proposalId = ok<{ proposalId: string }>(await asAgent("proposal.delete", { kind: "whiteboard", targetId: boardId })).proposalId;
    const call = ctx.app.call.bind(ctx.app);
    vi.spyOn(ctx.app, "call").mockImplementation((who, command, handle, requestId) => {
      if ((command as { commandId: string }).commandId === "whiteboard.delete") {
        ctx.app.whiteboards.edit({ boardId, actions: [{ type: "addNode", id: "new-user-text", kind: "text", x: 0, y: 0, data: { text: "刚写下的内容" } }] });
      }
      return call(who, command, handle, requestId);
    });
    expect(await run(ctx, "proposal.apply", { proposalId })).toMatchObject({ status: "error", error: { code: "PROPOSAL_STALE" } });
    expect(ctx.app.whiteboards.get(boardId).nodes.some((node) => node.id === "new-user-text")).toBe(true);
    expect(ctx.app.proposals.getCard(proposalId).status).toBe("stale");
    expect(ctx.app.store.loadIdempotent(proposalId)).toBeUndefined();
  });

  it("invalidates a deletion when new references are added and an export when project contents change", async () => {
    const { ctx, projectId, boardId, draftId, asAgent } = await seed();
    const deletion = ok<{ proposalId: string }>(await asAgent("proposal.delete", { kind: "whiteboard", targetId: boardId }));
    ok(await run(ctx, "project.addMaterial", { projectId, kind: "whiteboard", targetId: boardId }));
    expect(ctx.app.proposals.getCard(deletion.proposalId)).toMatchObject({ status: "stale" });
    expect(await run(ctx, "proposal.apply", { proposalId: deletion.proposalId })).toMatchObject({ status: "error", error: { code: "PROPOSAL_STALE" } });
    const exported = ok<{ proposalId: string }>(await asAgent("proposal.exportProject", {}));
    ok(await run(ctx, "draft.save", { draftId, expectedVersion: 1, text: "导出预览之后改过的正文" }));
    const dir = tempProfile();
    expect(await run(ctx, "proposal.apply", { proposalId: exported.proposalId, pathHandle: ctx.app.registerPath("directory", dir) }))
      .toMatchObject({ status: "error", error: { code: "PROPOSAL_STALE" } });
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("keeps an export pending while the user only looks around the project (tabs, layout, a board's viewport)", async () => {
    const { ctx, projectId, boardId, asAgent } = await seed();
    const exported = ok<{ proposalId: string }>(await asAgent("proposal.exportProject", {}));
    const loaded = ok<{ state: unknown }>(await run(ctx, "workspace.loadContext", { contextId: projectId }));
    ok(await run(ctx, "workspace.saveContext", { contextId: projectId, state: loaded.state }));
    ok(await run(ctx, "whiteboard.setViewport", { boardId, viewport: { x: 120, y: -40, zoom: 1.5 } }));
    expect(ctx.app.proposals.getCard(exported.proposalId).status).toBe("pending");
    const dir = tempProfile();
    ok(await run(ctx, "proposal.apply", { proposalId: exported.proposalId, pathHandle: ctx.app.registerPath("directory", dir) }));
    expect(ctx.app.proposals.getCard(exported.proposalId).status).toBe("applied");
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it.each([
    { crashAt: "proposal-applying", completed: false },
    { crashAt: "proposal-owner-after-effect", completed: false },
    { crashAt: "proposal-applying-after-command", completed: true },
  ])("recovers a real process exit at $crashAt without losing a draft or executing the deletion twice", async ({ crashAt, completed }) => {
    const { ctx, draftId, asAgent } = await seed();
    const proposalId = ok<{ proposalId: string }>(await asAgent("proposal.delete", { kind: "draft", targetId: draftId })).proposalId;
    crash(ctx, proposalId, crashAt);
    const fresh = await reopen(ctx);
    expect(fresh.app.proposals.getCard(proposalId).status).toBe(completed ? "applied" : "pending");
    expect(Boolean(fresh.app.store.sqlite.prepare("SELECT 1 FROM drafts WHERE id = ?").get(draftId))).toBe(!completed);
    if (!completed) ok(await run(fresh, "proposal.apply", { proposalId }));
    expect(fresh.app.store.loadIdempotent(proposalId)).toMatchObject({ status: "ok" });
    expect(await run(fresh, "proposal.apply", { proposalId })).toMatchObject({ status: "error", error: { code: "PROPOSAL_DECIDED" } });
    expect(fresh.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM operations WHERE idempotency_key = ?").get(proposalId)).toEqual({ n: 1 });
  });

  it("does not execute owner commands for an agent even if an internal caller supplies an owner grant", async () => {
    const { ctx, boardId } = await seed();
    const forgedOwner = ctx.app.issueOwnerGrant(actor);
    const result = await ctx.app.call(actor, { commandId: "whiteboard.delete", idempotencyKey: "forged-owner", input: { boardId } }, forgedOwner.handle);
    expect(result).toMatchObject({ status: "error", error: { code: "FORBIDDEN" } });
    expect(ctx.app.whiteboards.get(boardId).board.id).toBe(boardId);
  });

  it("leaves decisions that do not fit in context unreported and includes every consumed decision before clipping other material", async () => {
    const { ctx, sessionId, boardId, asAgent } = await seed();
    for (let index = 0; index < 8; index += 1) {
      const proposalId = ok<{ proposalId: string }>(await asAgent("proposal.rename", { kind: "whiteboard", targetId: boardId, title: `新名称${index}` })).proposalId;
      ok(await run(ctx, "proposal.reject", { proposalId, note: "保留旧名称" }));
    }
    const first = ctx.app.proposals.consumeUnreportedDecisions(sessionId, "small-context", 180);
    expect(first.mutations.length).toBeGreaterThan(0);
    expect(first.mutations.length).toBeLessThan(8);
    const context = materialContextMessage(ctx.app, {
      proposalDecisions: first.summaryText!, project: { id: "project", name: "项目", goal: "长说明".repeat(2000), terms: [] },
    }, 310);
    expect(context!.content).toContain(first.summaryText!);
    ctx.app.store.commit({ mutations: first.mutations, events: [] });
    const remaining = ctx.app.proposals.consumeUnreportedDecisions(sessionId, "next-context");
    expect(first.mutations.length + remaining.mutations.length).toBe(8);
    ctx.app.store.commit({ mutations: remaining.mutations, events: [] });
    expect(ctx.app.proposals.consumeUnreportedDecisions(sessionId, "third-context").summaryText).toBeNull();
  });

  it("reports a concise failure category to the model without consuming an oversized owner diagnostic or exposing a host path", async () => {
    const { ctx, sessionId, boardId, asAgent } = await seed();
    const proposalId = ok<{ proposalId: string }>(await asAgent("proposal.rename", { kind: "whiteboard", targetId: boardId, title: "新名称" })).proposalId;
    const call = ctx.app.call.bind(ctx.app);
    const diagnostic = `synthetic private host path: ${path.join(tempProfile(), "private-owner", "output")}` + "internal diagnostic ".repeat(2000);
    vi.spyOn(ctx.app, "call").mockImplementation((who, command, handle, requestId) => {
      if ((command as { commandId: string }).commandId === "whiteboard.rename") {
        return Promise.resolve({ status: "error", error: { code: "LOCATION_UNAVAILABLE", message: diagnostic, retryable: false, details: {} } });
      }
      return call(who, command, handle, requestId);
    });
    expect(await run(ctx, "proposal.apply", { proposalId })).toMatchObject({ status: "error", error: { code: "LOCATION_UNAVAILABLE" } });
    expect(ctx.app.proposals.getCard(proposalId).result?.error).toMatchObject({ message: diagnostic });
    const summary = ctx.app.proposals.consumeUnreportedDecisions(sessionId, "failure-context", 350);
    expect(summary.mutations).toHaveLength(1);
    expect(summary.summaryText).toContain("保存位置不可用");
    expect(summary.summaryText).not.toContain("private-owner");
    expect(summary.summaryText).not.toContain("internal diagnostic");
  });
});

describe("AT-153 & AT-154 export proposal completion and publication recovery", () => {
  it.each([
    { crashAt: "proposal-export-before-publish", completed: false },
    { crashAt: "proposal-export-after-publish", completed: true },
  ])("recovers a project export at $crashAt, cleans only its own temporary file and never publishes a second package", async ({ crashAt, completed }) => {
    const { ctx, asAgent } = await seed();
    const proposalId = ok<{ proposalId: string }>(await asAgent("proposal.exportProject", {})).proposalId;
    const dir = tempProfile();
    fs.writeFileSync(path.join(dir, "keep.txt"), "用户已有的文件");
    crash(ctx, proposalId, crashAt, dir);
    const fresh = await reopen(ctx);
    expect(fresh.app.proposals.getCard(proposalId).status).toBe(completed ? "applied" : "pending");
    expect(JSON.stringify(fresh.app.proposals.getCard(proposalId))).not.toContain(dir);
    if (!completed) ok(await run(fresh, "proposal.apply", { proposalId, pathHandle: fresh.app.registerPath("directory", dir) }));
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".manga-project.zip"))).toHaveLength(1);
    expect(fs.readdirSync(dir).some((name) => name.endsWith(".part"))).toBe(false);
    expect(fs.readFileSync(path.join(dir, "keep.txt"), "utf8")).toBe("用户已有的文件");
    expect(await run(fresh, "proposal.apply", { proposalId, pathHandle: fresh.app.registerPath("directory", dir) }))
      .toMatchObject({ status: "error", error: { code: "PROPOSAL_DECIDED" } });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".manga-project.zip"))).toHaveLength(1);
  });

  it.skipIf(mediaPrerequisitesAbsent)("rolls back a roughcut job registration and its receipt together after a real process exit, then confirms once", async () => {
    const { ctx, projectId, sessionId, cutId } = await seed();
    const dir = tempProfile();
    const source = path.join(dir, "source.mp4");
    fs.copyFileSync(samplePath("video-roughcut", "a.mp4"), source);
    const video = ok<{ resourceId: string }>(await run(ctx, "library.importDocument", { kind: "video", title: "样片", pathHandle: ctx.app.registerPath("file", inLibrary(ctx.app, source, "video")) }));
    ok(await run(ctx, "project.addMaterial", { projectId, kind: "resource", targetId: video.resourceId }));
    ok(await run(ctx, "roughcut.edit", { cutId, actions: [{ type: "add", resourceId: video.resourceId, inMs: 2000, outMs: 5500 }] }));
    const grant = ctx.app.issueAgentGrant(ctx.grant, actor, { projectId, sessionId, runId: "registration-run", readResourceIds: [video.resourceId] });
    const proposalId = ok<{ proposalId: string }>(await ctx.app.call(actor, { commandId: "proposal.exportRoughcut", idempotencyKey: "registration-proposal", input: { cutId } }, grant.handle)).proposalId;
    crash(ctx, proposalId, "proposal-export-job-registered");
    const fresh = await reopen(ctx);
    expect(fresh.app.proposals.getCard(proposalId).status).toBe("pending");
    expect(fresh.app.roughcuts.exportsOf(cutId).exports).toEqual([]);
    expect(fresh.app.store.loadIdempotent(proposalId)).toBeUndefined();
    ok(await run(fresh, "proposal.apply", { proposalId }));
    await fresh.app.roughcuts.exports.whenIdle();
    expect(fresh.app.proposals.getCard(proposalId).status).toBe("applied");
    expect(fresh.app.roughcuts.exportsOf(cutId).exports).toHaveLength(1);
    expect(fresh.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM operations WHERE idempotency_key = ?").get(proposalId)).toEqual({ n: 1 });
    expect(await run(fresh, "proposal.apply", { proposalId })).toMatchObject({ status: "error", error: { code: "PROPOSAL_DECIDED" } });
  });

  it.skipIf(mediaPrerequisitesAbsent).each(["cancel", "fail"] as const)("keeps a roughcut export applying until it ends, and reports %s as failure with no incomplete output", async (outcome) => {
    const state = await seed();
    const { ctx, projectId, sessionId, cutId } = state;
    const dir = tempProfile();
    const source = path.join(dir, "source.mp4");
    fs.copyFileSync(samplePath("video-roughcut", "a.mp4"), source);
    const video = ok<{ resourceId: string }>(await run(ctx, "library.importDocument", { kind: "video", title: "样片", pathHandle: ctx.app.registerPath("file", inLibrary(ctx.app, source, "video")) }));
    ok(await run(ctx, "project.addMaterial", { projectId, kind: "resource", targetId: video.resourceId }));
    ok(await run(ctx, "roughcut.edit", { cutId, actions: [{ type: "add", resourceId: video.resourceId, inMs: 2000, outMs: 5500 }] }));
    const grant = ctx.app.issueAgentGrant(ctx.grant, actor, { projectId, sessionId, runId: "export-run", readResourceIds: [video.resourceId] });
    const created = ok<{ proposalId: string }>(await ctx.app.call(actor, { commandId: "proposal.exportRoughcut", idempotencyKey: "blocked-export", input: { cutId } }, grant.handle));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const start = ctx.app.roughcuts.exports.start.bind(ctx.app.roughcuts.exports);
    vi.spyOn(ctx.app.roughcuts.exports, "start").mockImplementation((request) => {
      vi.spyOn(ctx.app.media.ffmpeg, "run").mockImplementation(async (_tool, _args, options) => {
        await blocked;
        if (options?.signal?.aborted) throw new MangaError("CANCELLED", "cancelled by the test");
        throw new MangaError("LOCATION_UNAVAILABLE", "synthetic output failure");
      });
      return start(request);
    });
    const applied = ok<{ proposal: ProposalCard; output: { export: RoughcutExportView } }>(await run(ctx, "proposal.apply", { proposalId: created.proposalId }));
    expect(applied.proposal.status).toBe("applying");
    if (outcome === "cancel") ok(await run(ctx, "roughcut.cancel", { exportId: applied.output.export.id }));
    release();
    await ctx.app.roughcuts.exports.whenIdle();
    const decided = ctx.app.proposals.getCard(created.proposalId);
    expect(decided.status).toBe("failed");
    expect(decided.result?.error).toMatchObject({ code: outcome === "cancel" ? "CANCELLED" : "LOCATION_UNAVAILABLE" });
    expect(ctx.app.roughcuts.exports.get(applied.output.export.id).files).toEqual([]);
    expect(ctx.app.proposals.consumeUnreportedDecisions(sessionId, "after-export").summaryText).toContain("执行失败");
  });
});
