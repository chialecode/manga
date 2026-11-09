import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { DrizzleStore } from "@manga/storage-drizzle";
import { startMockProvider } from "@manga/model-protocol";
import { startApp, tempProfile, waitForRun } from "../helpers/app.ts";
import { all, makeProject, ok, one, run } from "../helpers/creative-project.ts";
import { BOOK, controlled } from "../helpers/embedder.ts";
import { seedVideo } from "../helpers/media-seed.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";
import { inLibrary, requireSamples, samplePath } from "../helpers/samples.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;

const apps: App[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (apps.length) {
    try { apps.pop()!.app.close(); } catch { /* already closed */ }
  }
  while (closers.length) await closers.pop()!();
});

let counter = 0;
const agentActor = { kind: "agent" as const, id: "agent:run-prop" };

function failure(result: Call) {
  expect(result.status, JSON.stringify(result)).toBe("error");
  return result.error!;
}

const ARTICLE_HTML = `<!doctype html><html><head><title>石桥考据</title></head><body><article><h1>石桥考据</h1><p>这座石桥建于十九世纪末，桥拱下常年有航船经过。</p></article></body></html>`;

function createLoopbackPageServer() {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if ((req.url ?? "/").startsWith("/bridge")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(ARTICLE_HTML);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  return {
    hits,
    start: () => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const pageSite = createLoopbackPageServer();
let pageOrigin = "";
beforeAll(async () => { pageOrigin = await pageSite.start(); });
afterAll(async () => { await pageSite.stop(); });

async function bootProject() {
  const ctx = await startApp({ options: { network: { allowPrivate: (host) => host === "127.0.0.1" } } });
  apps.push(ctx);
  const a = await makeProject(ctx, "甲项目");
  const b = ok<{ id: string }>(await run(ctx, "project.create", { name: "乙项目", goal: "对照" })).id;
  const boardB = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId: b, title: "乙白板" })).board.id;
  const session = ok<{ id: string }>(await run(ctx, "session.open", { kind: "project", targetId: a.projectId, contextId: a.projectId }));
  const grant = ctx.app.issueAgentGrant(ctx.grant, agentActor, {
    sessionId: session.id,
    runId: "run-prop-1",
    readResourceIds: [a.book.resourceId],
    projectId: a.projectId,
  });
  const asAgent = (commandId: string, input: Record<string, unknown>, handle = grant.handle) =>
    ctx.app.call(agentActor, { commandId, idempotencyKey: `ag-prop-${++counter}`, input }, handle);
  return { ctx, a, b, boardB, sessionId: session.id, grant, asAgent };
}

describe("AT-151 & AT-152 agent proposals: delete, rename, atomic confirm, revision check, recovery & limits", () => {
  it("proposes deleting and renaming objects with previews and backlink folding, applies and rejects via owner commands, and reports decisions once on the next turn", async () => {
    const w = await bootProject();
    const { ctx, a, sessionId, asAgent } = w;

    // Add >5 backlinks to `a.mapId` so we verify folding ("还有 N 处") as well as embed + ref backlinks.
    for (let i = 1; i <= 6; i += 1) {
      const n = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: `引用笔记${i}`, text: `正文 ${i}` })).objectId;
      ok(await run(ctx, "embed.upsert", { sourceKind: "note", sourceId: n, slot: `s-${i}`, targetKind: "mindmap", targetId: a.mapId }));
    }

    // Propose deleting the mindmap (which is referenced by a.boardId and 6 notes = 7 references total).
    const delMap = ok<{ proposalId: string; status: string; proposal: any }>(await asAgent("proposal.delete", {
      kind: "mindmap",
      targetId: a.mapId,
      reason: "合并到新导图",
    }));
    expect(delMap.status).toBe("pending");
    const delMapCard = ctx.app.proposals.getCard(delMap.proposalId);
    expect(delMapCard).toMatchObject({
      id: delMap.proposalId,
      kind: "delete",
      status: "pending",
      reason: "合并到新导图",
      preview: {
        title: "删除导图《结构导图》",
        summary: "2 个节点",
        irreversible: true,
        meta: {
          nodes: 2,
          backlinks: 7,
        },
      },
    });
    expect(delMapCard.preview.lines[0]).toContain("反向引用（7 处）");
    expect(delMapCard.preview.lines[0]).toContain("（还有 2 处）");
    expect(delMapCard.preview.warnings).toContain("删除后不能撤销");
    // The mindmap is still in the database before confirmation.
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM mindmaps WHERE id = ?", a.mapId).n).toBe(1);

    // Propose renaming the whiteboard to an existing whiteboard title (triggers duplicate warning) and then a new title.
    const secondBoard = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId: a.projectId, title: "分镜墙" })).board.id;
    const renDup = ok<{ proposalId: string; proposal: any }>(await asAgent("proposal.rename", {
      kind: "whiteboard",
      targetId: a.boardId,
      title: "分镜墙",
    }));
    const renDupCard = ctx.app.proposals.getCard(renDup.proposalId);
    expect(renDupCard.preview).toMatchObject({
      title: "重命名白板：《素材墙》→《分镜墙》",
      summary: "原名称《素材墙》 → 新名称《分镜墙》",
      meta: { oldTitle: "素材墙", newTitle: "分镜墙", duplicate: true },
    });
    expect(renDupCard.preview.warnings[0]).toContain("重名");

    // Validation: empty or >200 char title, wrong kind, non-existent object, cross-project object.
    expect(failure(await asAgent("proposal.rename", { kind: "whiteboard", targetId: a.boardId, title: "   " })).code).toBe("VALIDATION_ERROR");
    expect(failure(await asAgent("proposal.rename", { kind: "whiteboard", targetId: a.boardId, title: "长".repeat(201) })).code).toBe("VALIDATION_ERROR");
    expect(failure(await asAgent("proposal.delete", { kind: "draft", targetId: a.boardId })).code).toBe("NOT_FOUND");
    expect(failure(await asAgent("proposal.delete", { kind: "whiteboard", targetId: "wb-missing" })).code).toBe("NOT_FOUND");
    expect(failure(await asAgent("proposal.delete", { kind: "whiteboard", targetId: w.boardB })).code).toBe("SCOPE_DENIED");
    expect(failure(await asAgent("proposal.apply", { proposalId: delMap.proposalId })).code).toBe("FORBIDDEN");
    expect(failure(await asAgent("proposal.reject", { proposalId: delMap.proposalId })).code).toBe("FORBIDDEN");

    // Confirm the delete proposal as the owner.
    const applied = ok<{ proposal: any }>(await run(ctx, "proposal.apply", { proposalId: delMap.proposalId }));
    expect(applied.proposal.status).toBe("applied");
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM mindmaps WHERE id = ?", a.mapId).n).toBe(0);
    // Operation log records proposal.apply under the user with the proposalId and runId.
    const logEntry = ctx.app.log.query({ limit: 20 }).entries.find((e) => e.action === "proposal.apply");
    expect(logEntry).toMatchObject({
      actorKind: "user",
      runId: "run-prop-1",
      objectKind: "mindmap",
      objectId: a.mapId,
      summaryKey: "log.proposal.apply",
      summaryParams: expect.objectContaining({ proposalId: delMap.proposalId, commandId: "mindmap.delete", origin: "Agent 提出、用户确认" }),
    });

    // Reject the rename proposal as the owner; the whiteboard keeps its old title.
    const rejected = ok<{ proposal: any }>(await run(ctx, "proposal.reject", { proposalId: renDup.proposalId }));
    expect(rejected.proposal.status).toBe("rejected");
    expect(one<{ title: string }>(ctx, "SELECT title FROM whiteboards WHERE id = ?", a.boardId).title).toBe("素材墙");

    // Rename draft, roughcut, and project via proposals and confirm them.
    const renDraft = ok<{ proposalId: string }>(await asAgent("proposal.rename", { kind: "draft", targetId: a.draftId, title: "终稿解说词" }));
    ok(await run(ctx, "proposal.apply", { proposalId: renDraft.proposalId }));
    expect(one<{ title: string }>(ctx, "SELECT title FROM drafts WHERE id = ?", a.draftId).title).toBe("终稿解说词");

    const renCut = ok<{ proposalId: string }>(await asAgent("proposal.rename", { kind: "roughcut", targetId: "cut-1", title: "定剪版" }));
    ok(await run(ctx, "proposal.apply", { proposalId: renCut.proposalId }));
    expect(one<{ title: string }>(ctx, "SELECT title FROM rough_cuts WHERE id = 'cut-1'").title).toBe("定剪版");

    const renProj = ok<{ proposalId: string }>(await asAgent("proposal.rename", { kind: "project", targetId: a.projectId, title: "甲项目（改名后）" }));
    ok(await run(ctx, "proposal.apply", { proposalId: renProj.proposalId }));
    expect(one<{ name: string }>(ctx, "SELECT name FROM projects WHERE id = ?", a.projectId).name).toBe("甲项目（改名后）");

    // Delete whiteboard (secondBoard), draft, and roughcut via proposals.
    for (const [kind, targetId, table] of [
      ["whiteboard", secondBoard, "whiteboards"],
      ["draft", a.draftId, "drafts"],
      ["roughcut", "cut-1", "rough_cuts"],
    ] as const) {
      const p = ok<{ proposalId: string }>(await asAgent("proposal.delete", { kind, targetId }));
      ok(await run(ctx, "proposal.apply", { proposalId: p.proposalId }));
      expect(one<{ n: number }>(ctx, `SELECT COUNT(*) AS n FROM ${table} WHERE id = ?`, targetId).n).toBe(0);
    }

    // Next Agent turn in this session receives the rejected proposal summary ONCE, and the turn after that does not repeat it.
    const seenBodies: Array<Record<string, any>> = [];
    const server = await startMockProvider({ onRequest: ({ body }) => { if (body.stream) seenBodies.push(body); } });
    closers.push(server.close);
    ok(await run(ctx, "connections.upsert", {
      label: "文本", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "m", purpose: "text",
      credentialHandle: ctx.app.stashSecret("prop-next-turn-key"),
    }));
    const turn1 = ok<{ runId: string; contextText: string }>(await run(ctx, "agent.send", { sessionId, text: "继续下一步" }));
    await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, turn1.runId, 20_000);
    const turn1Text = JSON.stringify(seenBodies[0]?.messages ?? []);
    expect(turn1Text).toContain("上次以来待审提议的结果");
    expect(turn1Text).toContain("用户已拒绝");
    expect(turn1.contextText).toContain("上次以来待审提议的结果");

    const beforeTurn2 = seenBodies.length;
    const turn2 = ok<{ runId: string; contextText: string }>(await run(ctx, "agent.send", { sessionId, text: "再下一步" }));
    await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, turn2.runId, 20_000);
    // Only the first turn's contextText has the decision note; the second turn's contextText does not repeat it.
    expect(turn2.contextText).not.toContain("上次以来待审提议的结果");
    expect(JSON.stringify(seenBodies[beforeTurn2]?.messages ?? [])).toContain("再下一步");
  });

  it("consumes a proposal atomically once, marks proposals stale when the target is modified or deleted, recovers applying proposals on restart, and enforces the 20-proposal limit", async () => {
    const w = await bootProject();
    const { ctx, a, sessionId, asAgent } = w;

    // 1. Atomic consumption: two concurrent `proposal.apply` calls on the same proposal execute only once.
    const pOnce = ok<{ proposalId: string }>(await asAgent("proposal.rename", { kind: "whiteboard", targetId: a.boardId, title: "只改一次" }));
    const [r1, r2] = await Promise.all([
      run(ctx, "proposal.apply", { proposalId: pOnce.proposalId }, "apply-once-1"),
      run(ctx, "proposal.apply", { proposalId: pOnce.proposalId }, "apply-once-2"),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(["error", "ok"]);
    const err = r1.status === "error" ? r1.error! : r2.error!;
    expect(err.code).toBe("PROPOSAL_DECIDED");
    expect(one<{ title: string }>(ctx, "SELECT title FROM whiteboards WHERE id = ?", a.boardId).title).toBe("只改一次");

    // 2. Revision check (`stale`): modifying a draft after proposing its deletion marks the proposal `stale` with a clear message.
    const pStale = ok<{ proposalId: string }>(await asAgent("proposal.delete", { kind: "draft", targetId: a.draftId }));
    ok(await run(ctx, "draft.save", { draftId: a.draftId, expectedVersion: 2, text: "用户在提议后改了一个字。" }));
    const staleErr = failure(await run(ctx, "proposal.apply", { proposalId: pStale.proposalId }));
    expect(staleErr.code).toBe("PROPOSAL_STALE");
    expect(staleErr.message).toContain("在提议后被修改过");
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM drafts WHERE id = ?", a.draftId).n).toBe(1);
    const listed = ok<{ proposals: Array<{ id: string; status: string; result: { reason?: string } | null }> }>(await run(ctx, "proposal.list", { sessionId }));
    expect(listed.proposals.find((p) => p.id === pStale.proposalId)).toMatchObject({
      status: "stale",
      result: { reason: expect.stringContaining("在提议后被修改过") },
    });

    // Also test target deleted before confirmation -> marks `stale` with "已被删除".
    const tempBoard = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId: a.projectId, title: "临时白板" })).board.id;
    const pDel = ok<{ proposalId: string }>(await asAgent("proposal.rename", { kind: "whiteboard", targetId: tempBoard, title: "不会成功" }));
    ok(await run(ctx, "whiteboard.delete", { boardId: tempBoard }));
    const delErr = failure(await run(ctx, "proposal.apply", { proposalId: pDel.proposalId }));
    expect(delErr.code).toBe("PROPOSAL_STALE");
    expect(delErr.message).toContain("已被删除");

    // 3. Startup recovery of `applying` proposals:
    // - One proposal in `applying` with a committed `operations` receipt (`key = proposal.id`) -> settled to `applied`.
    // - One proposal in `applying` without a receipt -> reverted to `pending`.
    // - One proposal whose command only started (`command_requests` exists) -> reverted to `pending`, because a request is not proof of completion.
    const pCommitted = ok<{ proposalId: string }>(await asAgent("proposal.rename", { kind: "mindmap", targetId: a.mapId, title: "已提交恢复" }));
    const pUncommitted = ok<{ proposalId: string }>(await asAgent("proposal.rename", { kind: "whiteboard", targetId: a.boardId, title: "未提交恢复" }));
    const pStarted = ok<{ proposalId: string }>(await asAgent("proposal.rename", { kind: "whiteboard", targetId: a.boardId, title: "只开始未提交" }));
    ctx.app.store.sqlite.prepare("UPDATE agent_proposals SET status = 'applying', decided_at = ? WHERE id IN (?, ?, ?)").run(
      new Date().toISOString(), pCommitted.proposalId, pUncommitted.proposalId, pStarted.proposalId,
    );
    ctx.app.store.sqlite.prepare(
      "INSERT INTO operations(idempotency_key, command_id, result_json, committed_at) VALUES (?, 'mindmap.rename', ?, ?)",
    ).run(pCommitted.proposalId, JSON.stringify({ status: "ok", value: { map: { id: a.mapId, title: "已提交恢复" } } }), new Date().toISOString());
    ctx.app.store.sqlite.prepare(
      "INSERT INTO command_requests(idempotency_key, command_id, input_hash, actor_kind, actor_id) VALUES (?, 'whiteboard.rename', 'hash-2', 'user', ?)",
    ).run(pStarted.proposalId, ctx.actor.id);

    const rec = ctx.app.proposals.recover();
    expect(rec).toEqual({ applied: 1, reverted: 2 });
    expect(one<{ status: string }>(ctx, "SELECT status FROM agent_proposals WHERE id = ?", pCommitted.proposalId).status).toBe("applied");
    expect(one<{ status: string }>(ctx, "SELECT status FROM agent_proposals WHERE id = ?", pUncommitted.proposalId).status).toBe("pending");
    expect(one<{ status: string }>(ctx, "SELECT status FROM agent_proposals WHERE id = ?", pStarted.proposalId).status).toBe("pending");
    ok(await run(ctx, "proposal.reject", { proposalId: pStarted.proposalId }));

    // 4. Session limit of 20 pending proposals (Q-37): pUncommitted is 1 pending proposal; adding 19 more reaches 20, and the 21st fails with PROPOSAL_LIMIT.
    const batchIds: string[] = [pUncommitted.proposalId];
    for (let i = 2; i <= 20; i += 1) {
      const p = ok<{ proposalId: string }>(await asAgent("proposal.rename", { kind: "project", targetId: a.projectId, title: `名字${i}` }));
      batchIds.push(p.proposalId);
    }
    const over = failure(await asAgent("proposal.rename", { kind: "project", targetId: a.projectId, title: "第21条" }));
    expect(over.code).toBe("PROPOSAL_LIMIT");
    expect(over.message).toContain("20");
    // Rejecting one frees a slot.
    ok(await run(ctx, "proposal.reject", { proposalId: batchIds[0]! }));
    const afterReject = ok<{ proposalId: string }>(await asAgent("proposal.rename", { kind: "project", targetId: a.projectId, title: "空出位置后" }));
    expect(afterReject.proposalId).toBeTruthy();

    // 5. Project package and library package exclude `agent_proposals`, while conversation/project delete cascades them.
    const pkgDir = path.join(tempProfile(), "prop-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    const exported = ok<{ fileName: string }>(await run(ctx, "project.exportPackage", {
      projectId: a.projectId,
      pathHandle: ctx.app.registerPath("directory", pkgDir),
    }));
    const zipFiles = unzipSync(fs.readFileSync(path.join(pkgDir, exported.fileName)));
    expect(Object.keys(zipFiles).some((name) => name.includes("proposal"))).toBe(false);

    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM agent_proposals WHERE session_id = ?", sessionId).n).toBeGreaterThan(0);
    ok(await run(ctx, "conversation.delete", { sessionIds: [sessionId] }));
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM agent_proposals WHERE session_id = ?", sessionId).n).toBe(0);
  });
});

describe("AT-153 & AT-154 agent proposals: roughcut edit/export and project package export", () => {
  requireSamples(["video-roughcut"]);

  it("dry-runs roughcut edits on a copy, applies them as a single undoable Agent step, and exports the project package on confirmation", async () => {
    const w = await bootProject();
    const { ctx, a, asAgent } = w;

    // Invalid roughcut edit (unknown clip or invalid range) is rejected at propose time without touching the roughcut.
    expect(failure(await asAgent("proposal.editRoughcut", {
      cutId: "cut-1",
      actions: [{ type: "update", clipId: "no-such-clip", inMs: 0, outMs: 1000 }],
    })).code).toBe("NOT_FOUND");
    expect(failure(await asAgent("proposal.editRoughcut", {
      cutId: "cut-1",
      actions: [{ type: "update", clipId: "clip-1", inMs: 4000, outMs: 2000 }],
    })).code).toBe("VALIDATION_ERROR");

    // Seed a video resource and update clip-1 + add clip-2 on cut-1 so we can test update, move, and remove in a 3-step roughcut edit proposal.
    const vid = seedVideo(ctx.app, { title: "素材视频", durationMs: 24_000, workId: a.book.workId, probe: true });
    ctx.app.store.sqlite.prepare("UPDATE rough_cut_clips SET resource_id = ?, resource_revision_id = ?, sort_key = 'm' WHERE id = 'clip-1'").run(vid.resourceId, vid.revisionId);
    ctx.app.store.sqlite.prepare("INSERT INTO rough_cut_clips(id, cut_id, resource_id, resource_revision_id, in_ms, out_ms, sort_key, label, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("clip-2", "cut-1", vid.resourceId, vid.revisionId, 5000, 9000, "t", "第二段", "2026-10-02T10:00:00.000Z");

    // Valid multi-step roughcut edit proposal.
    const editProp = ok<{ proposalId: string; proposal: any }>(await asAgent("proposal.editRoughcut", {
      cutId: "cut-1",
      label: "精简开头并重排",
      actions: [
        { type: "update", clipId: "clip-1", inMs: 1000, outMs: 3000, label: "开场精简" },
        { type: "move", clipId: "clip-2", index: 0 },
        { type: "remove", clipId: "clip-2" },
      ],
    }));
    const editCard = ctx.app.proposals.getCard(editProp.proposalId);
    expect(editCard.preview).toMatchObject({
      title: "调整粗剪《第一版粗剪》：3 步",
      meta: {
        beforeClips: 2,
        afterClips: 1,
        beforeMs: 8000,
        afterMs: 2000,
        opLabel: "Agent：精简开头并重排",
      },
    });
    expect(editCard.preview.lines.length).toBeGreaterThanOrEqual(3);
    // Before apply: still 2 clips in DB.
    expect(one<{ n: number }>(ctx, "SELECT COUNT(*) AS n FROM rough_cut_clips WHERE cut_id = 'cut-1'").n).toBe(2);

    // Confirm editRoughcut -> 1 clip, undo label is "Agent：精简开头并重排", and a single undo restores the 2 clips.
    ok(await run(ctx, "proposal.apply", { proposalId: editProp.proposalId }));
    const afterApply = ok<{ clips: Array<{ id: string }>; ops: { undoLabel: string | null } }>(await run(ctx, "roughcut.get", { cutId: "cut-1" }));
    expect(afterApply.clips).toHaveLength(1);
    expect(afterApply.ops.undoLabel).toBe("Agent：精简开头并重排");
    ok(await run(ctx, "roughcut.undo", { cutId: "cut-1" }));
    expect(ok<{ clips: unknown[] }>(await run(ctx, "roughcut.get", { cutId: "cut-1" })).clips).toHaveLength(2);

    // AT-154: Project package export proposal.
    const pkgProp = ok<{ proposalId: string; proposal: any }>(await asAgent("proposal.exportProject", { reason: "备份当前项目" }));
    const pkgCard = ctx.app.proposals.getCard(pkgProp.proposalId);
    expect(pkgCard.preview).toMatchObject({
      title: "导出项目包《甲项目》",
      meta: {
        counts: expect.objectContaining({ whiteboards: 1, mindmaps: 1, drafts: 1, roughCuts: 1 }),
      },
    });
    expect(pkgCard.preview.meta!.estimatedBytes).toBeGreaterThan(100);

    // Confirming without pathHandle (e.g. cancelled directory picker) fails and keeps the proposal pending.
    expect(failure(await run(ctx, "proposal.apply", { proposalId: pkgProp.proposalId })).code).toBe("VALIDATION_ERROR");
    expect(one<{ status: string }>(ctx, "SELECT status FROM agent_proposals WHERE id = ?", pkgProp.proposalId).status).toBe("pending");

    const dirProp = path.join(tempProfile(), "pkg-from-proposal");
    const dirOwner = path.join(tempProfile(), "pkg-from-owner");
    fs.mkdirSync(dirProp, { recursive: true });
    fs.mkdirSync(dirOwner, { recursive: true });
    const appliedPkg = ok<{ proposal: { status: string; result: { output: { fileName: string; bytes: number } } } }>(await run(ctx, "proposal.apply", {
      proposalId: pkgProp.proposalId,
      pathHandle: ctx.app.registerPath("directory", dirProp),
    }));
    expect(appliedPkg.proposal.status).toBe("applied");
    const ownerPkg = ok<{ fileName: string; bytes: number }>(await run(ctx, "project.exportPackage", {
      projectId: a.projectId,
      pathHandle: ctx.app.registerPath("directory", dirOwner),
    }));
    const filesProp = unzipSync(fs.readFileSync(path.join(dirProp, appliedPkg.proposal.result.output.fileName)));
    const filesOwner = unzipSync(fs.readFileSync(path.join(dirOwner, ownerPkg.fileName)));
    expect(Object.keys(filesProp).sort()).toEqual(Object.keys(filesOwner).sort());
    const stripTimestamps = (raw: string) => {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        delete parsed.takenAt;
        delete parsed.exportedAt;
      }
      return parsed;
    };
    for (const key of Object.keys(filesProp).filter((k) => k !== "manifest.json")) {
      expect(stripTimestamps(strFromU8(filesProp[key]!)), key).toEqual(stripTimestamps(strFromU8(filesOwner[key]!)));
    }
  });

  it.skipIf(mediaPrerequisitesAbsent)("proposes and executes a lossless roughcut export into the work's roughcut folder", async () => {
    const w = await bootProject();
    const { ctx, a } = w;
    const videoFolder = path.join(tempProfile(), "video-src");
    fs.mkdirSync(videoFolder, { recursive: true });
    const videoFile = path.join(videoFolder, "a.mp4");
    fs.copyFileSync(samplePath("video-roughcut", "a.mp4"), videoFile);
    const vid = ok<{ resourceId: string; workId: string }>(await run(ctx, "library.importDocument", {
      title: "样片A",
      kind: "video",
      pathHandle: ctx.app.registerPath("file", inLibrary(ctx.app, videoFile, "video")),
    }));
    ok(await run(ctx, "project.addMaterial", { projectId: a.projectId, kind: "work", targetId: vid.workId }));
    const cutId = ok<{ cut: { id: string } }>(await run(ctx, "roughcut.create", { projectId: a.projectId, title: "视频粗剪" })).cut.id;
    ok(await run(ctx, "roughcut.edit", {
      cutId,
      actions: [{ type: "add", resourceId: vid.resourceId, inMs: 2000, outMs: 5500 }],
    }));

    const grantWithVideo = ctx.app.issueAgentGrant(ctx.grant, agentActor, {
      sessionId: w.sessionId,
      runId: "run-prop-video",
      readResourceIds: [a.book.resourceId, vid.resourceId],
      projectId: a.projectId,
    });
    const expProp = ok<{ proposalId: string; proposal: any }>(await ctx.app.call(agentActor, {
      commandId: "proposal.exportRoughcut",
      idempotencyKey: "exp-rc-1",
      input: { cutId, fileName: "agent-cut.mp4" },
    }, grantWithVideo.handle));
    const exportCard = ctx.app.proposals.getCard(expProp.proposalId);
    expect(exportCard.preview).toMatchObject({
      title: "导出粗剪《视频粗剪》",
      meta: {
        clips: 1,
        compatible: true,
        container: "mov",
        extension: "mp4",
      },
    });
    expect(exportCard.preview.lines.at(-1)).toContain("粗剪目录");

    // Confirm without pathHandle -> exports to default roughcut folder.
    const applied = ok<{ proposal: any }>(await run(ctx, "proposal.apply", { proposalId: expProp.proposalId }));
    expect(applied.proposal.status).toBe("applying");
    await ctx.app.roughcuts.exports.whenIdle();
    expect(ctx.app.proposals.getCard(expProp.proposalId).status).toBe("applied");
    const exportsList = ok<{ exports: Array<{ id: string; state: string; check: { ok: boolean } | null }> }>(await run(ctx, "roughcut.exports", { cutId })).exports;
    expect(exportsList[0]).toMatchObject({ state: "done", check: { ok: true } });
  });
});

describe("AT-155 per-task opt-in tools: semantic.search & webpage.fetch", () => {
  it("runs semantic.search against the fake Embedding service within the task's scope and spoiler guard, and webpage.fetch against the loopback server", async () => {
    const model = controlled();
    const ctx = await startApp({
      options: {
        embedding: model.port,
        semantic: { vec: false, retryBaseMs: 0 },
        network: { allowPrivate: (host) => host === "127.0.0.1" },
      },
    });
    apps.push(ctx);
    const a = await makeProject(ctx, "研究项目");
    const secretBook = ok<{ resourceId: string }>(await run(ctx, "library.importText", {
      title: "未授权的书",
      bytes: [...Buffer.from(BOOK)],
    }));
    const otherNote = ok<{ objectId: string }>(await run(ctx, "notes.create", {
      title: "项目外笔记",
      text: "手风琴的声音在雨夜的桥上慢慢响起，未加入项目的笔记。",
    }));
    expect(secretBook.resourceId).toBeTruthy();
    expect(otherNote.objectId).toBeTruthy();

    ok(await run(ctx, "semantic.configure", { enabled: true, connectionId: "emb-a", segmentation: "paragraph-300" }));
    await ctx.app.semantic.settled();

    const session = ok<{ id: string }>(await run(ctx, "session.open", { kind: "project", targetId: a.projectId, contextId: a.projectId }));
    // Without allowCommands, both semantic.search and webpage.fetch are refused.
    const plainGrant = ctx.app.issueAgentGrant(ctx.grant, agentActor, {
      sessionId: session.id,
      runId: "run-no-opt",
      readResourceIds: [a.book.resourceId],
      projectId: a.projectId,
    });
    expect(failure(await ctx.app.call(agentActor, { commandId: "semantic.search", idempotencyKey: "no-sem", input: { text: "石桥" } }, plainGrant.handle)).code).toBe("FORBIDDEN");
    expect(failure(await ctx.app.call(agentActor, { commandId: "webpage.fetch", idempotencyKey: "no-web", input: { url: `${pageOrigin}/bridge` } }, plainGrant.handle)).code).toBe("FORBIDDEN");

    // With allowCommands opted in:
    const optedGrant = ctx.app.issueAgentGrant(ctx.grant, agentActor, {
      sessionId: session.id,
      runId: "run-opted",
      readResourceIds: [a.book.resourceId],
      projectId: a.projectId,
      allowCommands: ["semantic.search", "webpage.fetch"],
    });
    const semRes = ok<{ state: string; results: Array<{ kind: string; resourceId?: string; objectId?: string }> }>(
      await ctx.app.call(agentActor, { commandId: "semantic.search", idempotencyKey: "ok-sem", input: { text: "雨夜与石桥" } }, optedGrant.handle),
    );
    expect(semRes.state).toBe("ok");
    expect(semRes.results.length).toBeGreaterThan(0);
    // None of the results come from the unread `secretBook` or the non-project `otherNote`.
    expect(semRes.results.some((hit) => hit.resourceId === secretBook.resourceId)).toBe(false);
    expect(semRes.results.some((hit) => hit.objectId === otherNote.objectId)).toBe(false);

    // Fetching a loopback page adds it to the project's pages.
    const webRes = ok<{ page: { id: string; title: string } }>(
      await ctx.app.call(agentActor, { commandId: "webpage.fetch", idempotencyKey: "ok-web", input: { url: `${pageOrigin}/bridge` } }, optedGrant.handle),
    );
    expect(webRes.page.title).toBe("石桥考据");
    const pages = ok<{ pages: Array<{ id: string }> }>(
      await ctx.app.call(agentActor, { commandId: "webpage.list", idempotencyKey: "ok-web-list", input: {} }, optedGrant.handle),
    );
    expect(pages.pages.map((p) => p.id)).toContain(webRes.page.id);
  });
});

describe("AT-171 LOOP-33 startup recovery when a proposal's module is disabled", () => {
  requireSamples(["video-roughcut"]);

  it.skipIf(mediaPrerequisitesAbsent)("marks applying proposals for disabled modules as failed ('模块已关闭') on startup and never executes them if the module is re-enabled", async () => {
    const profileRoot = tempProfile();
    const ctx1 = await startApp({
      profileRoot,
      options: {
        network: { allowPrivate: (host) => host === "127.0.0.1" },
      },
    });
    apps.push(ctx1);
    const a = await makeProject(ctx1, "重启恢复项目");
    const videoFolder = path.join(tempProfile(), "video-loop33");
    fs.mkdirSync(videoFolder, { recursive: true });
    const videoFile = path.join(videoFolder, "a.mp4");
    fs.copyFileSync(samplePath("video-roughcut", "a.mp4"), videoFile);
    const vid = ok<{ resourceId: string; workId: string }>(await run(ctx1, "library.importDocument", {
      title: "样片LOOP33",
      kind: "video",
      pathHandle: ctx1.app.registerPath("file", inLibrary(ctx1.app, videoFile, "video")),
    }));
    ok(await run(ctx1, "project.addMaterial", { projectId: a.projectId, kind: "work", targetId: vid.workId }));
    const cutId = ok<{ cut: { id: string } }>(await run(ctx1, "roughcut.create", { projectId: a.projectId, title: "中断粗剪" })).cut.id;
    ok(await run(ctx1, "roughcut.edit", {
      cutId,
      actions: [{ type: "add", resourceId: vid.resourceId, inMs: 2000, outMs: 5500 }],
    }));

    const session = ok<{ id: string }>(await run(ctx1, "session.open", { kind: "project", targetId: a.projectId, contextId: a.projectId }));
    const grant = ctx1.app.issueAgentGrant(ctx1.grant, agentActor, {
      sessionId: session.id,
      runId: "run-loop33",
      readResourceIds: [a.book.resourceId, vid.resourceId],
      projectId: a.projectId,
    });
    const asAgent1 = (commandId: string, input: Record<string, unknown>) =>
      ctx1.app.call(agentActor, { commandId, idempotencyKey: `ag-loop33-${++counter}`, input }, grant.handle);

    const pJob = ok<{ proposalId: string }>(await asAgent1("proposal.exportRoughcut", {
      cutId,
      fileName: "never-exported-1.mp4",
      reason: "已登记导出任务后崩溃",
    }));
    const pUncommitted = ok<{ proposalId: string }>(await asAgent1("proposal.exportRoughcut", {
      cutId,
      fileName: "never-exported-2.mp4",
      reason: "尚未登记导出任务时中断",
    }));
    const pBoard = ok<{ proposalId: string }>(await asAgent1("proposal.rename", {
      kind: "whiteboard",
      targetId: a.boardId,
      title: "不应生效的新名称",
    }));
    const pKeepPending = ok<{ proposalId: string }>(await asAgent1("proposal.rename", {
      kind: "mindmap",
      targetId: a.mapId,
      title: "仍开着模块的导图",
    }));
    const dataDir = ctx1.app.layout.partitions.data;
    ctx1.app.close();

    // Real child-process crash right after `roughcut.export` registered its job (`operations` receipt + `applying` proposal).
    const crashed = spawnSync(process.execPath, [path.resolve("tests/helpers/proposal-crash-child.ts")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MANGA_PROPOSAL_TEST_PROFILE: profileRoot,
        MANGA_PROPOSAL_TEST_ID: pJob.proposalId,
        MANGA_PROPOSAL_TEST_CRASH: "proposal-applying-after-command",
      },
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    expect(crashed.status, crashed.stderr || crashed.stdout).toBe(99);

    // Put `pUncommitted`, `pBoard`, and `pKeepPending` into `applying` without receipts, and disable `roughcut` + `whiteboard` in `lastValidProfile` before restart.
    const rawStore = new DrizzleStore({ profileDir: dataDir });
    try {
      expect((rawStore.sqlite.prepare("SELECT status FROM agent_proposals WHERE id = ?").get(pJob.proposalId) as { status: string }).status).toBe("applying");
      const interruptedAt = new Date().toISOString();
      rawStore.sqlite.prepare("UPDATE agent_proposals SET status = 'applying', decided_at = ? WHERE id IN (?, ?, ?)").run(
        interruptedAt, pUncommitted.proposalId, pBoard.proposalId, pKeepPending.proposalId,
      );
      rawStore.sqlite.prepare(
        "INSERT INTO command_requests(idempotency_key, command_id, input_hash, actor_kind, actor_id) VALUES (?, 'whiteboard.rename', 'hash-loop33', 'user', ?)",
      ).run(pBoard.proposalId, ctx1.actor.id);
      // Force the registered roughcut export back to `planned` in case fast FFmpeg finished in the milliseconds before exit(99).
      rawStore.sqlite.prepare("UPDATE rough_cut_exports SET state = 'planned', final_name = NULL, error_json = NULL WHERE cut_id = ?").run(cutId);

      const savedProfile = JSON.parse(rawStore.getMeta("lastValidProfile")!) as {
        profileId: string;
        revision: number;
        enabledFeatures: string[];
        disabledFeatures: string[];
        preferredProviders: Record<string, string>;
      };
      rawStore.setMeta("lastValidProfile", JSON.stringify({
        ...savedProfile,
        revision: savedProfile.revision + 1,
        enabledFeatures: savedProfile.enabledFeatures.filter((id) => id !== "roughcut" && id !== "whiteboard"),
        disabledFeatures: [...new Set([...savedProfile.disabledFeatures, "roughcut", "whiteboard"])],
      }));
    } finally {
      rawStore.close();
    }

    // Restart on the same profile: `roughcut` and `whiteboard` are disabled during `start()`.
    const ctx2 = await startApp({
      profileRoot,
      options: { network: { allowPrivate: (host) => host === "127.0.0.1" } },
    });
    apps.push(ctx2);

    const listedAfterRestart = ok<{ proposals: Array<{ id: string; status: string; result: Record<string, any> | null }> }>(
      await run(ctx2, "proposal.list", { sessionId: session.id }),
    ).proposals;
    const byId = new Map(listedAfterRestart.map((item) => [item.id, item]));

    for (const id of [pJob.proposalId, pUncommitted.proposalId, pBoard.proposalId]) {
      expect(byId.get(id)).toMatchObject({
        id,
        status: "failed",
        result: {
          reason: "模块已关闭",
          recovered: true,
          error: {
            code: "CAPABILITY_UNAVAILABLE",
            message: "模块已关闭",
            details: { reason: "module-disabled" },
          },
        },
      });
    }
    // `mindmap` stayed enabled, so its uncommitted `applying` proposal still reverts to `pending` as before.
    expect(byId.get(pKeepPending.proposalId)?.status).toBe("pending");
    // Uncommitted `command_requests` row for `pBoard` was cleaned up, and the planned `rough_cut_exports` row is no longer `planned`/`running`.
    expect(one<{ n: number }>(ctx2, "SELECT COUNT(*) AS n FROM command_requests WHERE idempotency_key = ?", pBoard.proposalId).n).toBe(0);
    expect(one<{ n: number }>(ctx2, "SELECT COUNT(*) AS n FROM rough_cut_exports WHERE cut_id = ? AND state IN ('planned', 'running')", cutId).n).toBe(0);

    // Re-enable `roughcut` and `whiteboard`: none of the failed proposals may run or change state!
    ok(await run(ctx2, "settings.setModule", { featureId: "roughcut", enabled: true }));
    ok(await run(ctx2, "settings.setModule", { featureId: "whiteboard", enabled: true }));
    await ctx2.app.roughcuts.exports.whenIdle();

    for (const id of [pJob.proposalId, pUncommitted.proposalId, pBoard.proposalId]) {
      const card = ctx2.app.proposals.getCard(id);
      expect(card.status).toBe("failed");
      expect(card.result).toMatchObject({ reason: "模块已关闭" });
      expect(failure(await run(ctx2, "proposal.apply", { proposalId: id })).code).toBe("PROPOSAL_DECIDED");
    }
    const exportsAfterReenable = ok<{ exports: Array<{ state: string; fileName: string | null }> }>(
      await run(ctx2, "roughcut.exports", { cutId }),
    ).exports;
    expect(exportsAfterReenable.every((exp) => exp.state === "failed" && exp.fileName === null)).toBe(true);
    expect(one<{ title: string }>(ctx2, "SELECT title FROM whiteboards WHERE id = ?", a.boardId).title).not.toBe("不应生效的新名称");

    // Next Agent turn receives `执行失败（模块已关闭）` once and does not repeat it on the subsequent turn.
    const seenBodies: Array<Record<string, any>> = [];
    const server = await startMockProvider({ onRequest: ({ body }) => { if (body.stream) seenBodies.push(body); } });
    closers.push(server.close);
    ok(await run(ctx2, "connections.upsert", {
      label: "文本恢复核对", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "m", purpose: "text",
      credentialHandle: ctx2.app.stashSecret("prop-loop33-key"),
    }));
    const turn1 = ok<{ runId: string; contextText: string }>(await run(ctx2, "agent.send", { sessionId: session.id, text: "汇报恢复状态" }));
    await waitForRun(ctx2.app, ctx2.actor, ctx2.grant.handle, turn1.runId, 20_000);
    expect(turn1.contextText).toContain("执行失败（模块已关闭）");
    expect(JSON.stringify(seenBodies[0]?.messages ?? [])).toContain("执行失败（模块已关闭）");

    const turn2 = ok<{ runId: string; contextText: string }>(await run(ctx2, "agent.send", { sessionId: session.id, text: "继续" }));
    await waitForRun(ctx2.app, ctx2.actor, ctx2.grant.handle, turn2.runId, 20_000);
    expect(turn2.contextText).not.toContain("执行失败（模块已关闭）");
  });
});
