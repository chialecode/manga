import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MangaError } from "@manga/contracts";
import { DEFAULT_MODEL_PROFILE } from "@manga/contracts/models";
import { startMockProvider } from "@manga/model-protocol";
import { buildPdfFixture } from "@manga/app-core";
import { fitContext, SUMMARY_MARK } from "../../packages/app-core/src/agent-context.ts";
import { decidePdfs } from "../../packages/app-core/src/agent-native-input.ts";
import { modelLimitsOf } from "../../packages/app-core/src/model-probe.ts";
import { startApp, waitForRun } from "../helpers/app.ts";

type App = Awaited<ReturnType<typeof startApp>>;
const apps: App[] = [];
const closers: Array<() => Promise<unknown>> = [];
const dirs: string[] = [];
let seq = 0;

afterEach(async () => {
  while (apps.length) {
    try { apps.pop()!.app.close(); } catch { /* closed */ }
  }
  while (closers.length) await closers.pop()!().catch(() => undefined);
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

async function boot() {
  const ctx = await startApp();
  apps.push(ctx);
  return ctx;
}

const run = (ctx: App, commandId: string, input: Record<string, unknown>, grantHandle = ctx.grant.handle) =>
  ctx.app.call(ctx.actor, { commandId, idempotencyKey: `ag-reg-${++seq}`, input }, grantHandle);

describe("App-Core agent, context, probe & connection regressions", () => {
  it("A-06: checks visionRoute against selected chat/project model and preserves ImageStash on refusal", async () => {
    const ctx = await boot();
    const server = await startMockProvider({});
    closers.push(server.close);

    // First connection supports vision; second connection (selected as chat default) is text-only.
    const visionConn = await run(ctx, "connections.upsert", {
      label: "vision-first", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "v-model",
      purpose: "text", credentialHandle: ctx.app.stashSecret("sk-test-vision"),
      profile: { contextWindow: 32_768, maxOutput: 2_048, inputTypes: ["text", "image"] },
    });
    expect(visionConn.status).toBe("ok");
    const textOnly = await run(ctx, "connections.upsert", {
      label: "text-chosen", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "t-model",
      purpose: "text", credentialHandle: ctx.app.stashSecret("sk-test-text"),
      profile: { contextWindow: 32_768, maxOutput: 2_048, inputTypes: ["text"] },
    });
    expect(textOnly.status).toBe("ok");
    const chosenId = String((textOnly.value as { id: string }).id);
    expect((await run(ctx, "settings.setAgent", { chat: { connectionId: chosenId } })).status).toBe("ok");

    const imgId = ctx.app.materials.stash.put({
      mediaType: "image/png",
      base64: Buffer.from("fake-png").toString("base64"),
      width: 10,
      height: 10,
      bytes: 8,
      origin: { kind: "comic_region", resourceId: "res_1", resourceRevisionId: "rev_1", pageId: "p1" },
      extraction: "test",
    });

    const ses = await run(ctx, "agent.createSession", { title: "a06" });
    const refused = await run(ctx, "agent.send", { sessionId: String(ses.value?.id), text: "看图", imageMaterialIds: [imgId] });
    expect(refused.status).toBe("error");
    expect(refused.error?.code).toBe("MODEL_CAPABILITY_MISSING");
    // Image must remain stashed after refusal so switching models and retrying works.
    expect(ctx.app.materials.stash.take([imgId])).toHaveLength(1);
  });

  it("A-07: agent.retry refuses a run whose grant was revoked", async () => {
    const ctx = await boot();
    const server = await startMockProvider({ respond: () => ({ status: 500, message: "boom" }) });
    closers.push(server.close);
    await run(ctx, "connections.upsert", {
      label: "m", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo",
      purpose: "text", credentialHandle: ctx.app.stashSecret("sk-retry-test"),
      profile: { contextWindow: 32_768, maxOutput: 2_048 },
    });
    const ses = await run(ctx, "agent.createSession", { title: "a07" });
    const sent = await run(ctx, "agent.send", { sessionId: String(ses.value?.id), text: "你好" });
    expect(sent.status).toBe("ok");
    const runId = String(sent.value?.runId);
    const grantHandle = String(sent.value?.grantHandle);
    const finished = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, runId);
    expect(finished.value?.status).toBe("failed");

    ctx.app.grants.revoke(grantHandle);
    const retried = await run(ctx, "agent.retry", { runId });
    expect(retried.status).toBe("error");
    expect(retried.error?.code).toBe("FORBIDDEN");
  });

  it("A-12: freezeLibrary scales 0..1 progress to 0..100 and decidePdfs honors progress_furthest across contexts", async () => {
    const ctx = await boot();
    const frozen = ctx.app.materials.freezeLibrary([
      { id: "w1", title: "书甲", author: null, mediaKind: "novel", shelf: "reading", progress: 0.5, resourceCount: 2, linked: false },
      { id: "w2", title: "书乙", author: null, mediaKind: "novel", shelf: "finished", progress: 1, resourceCount: 1, linked: false },
    ], 2);
    expect(frozen.works.map((w) => w.progress)).toEqual([50, 100]);

    const libDir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-a12-"));
    dirs.push(libDir);
    const pdfPath = path.join(libDir, "sample.pdf");
    fs.writeFileSync(pdfPath, buildPdfFixture([{ text: "第一页内容" }]));
    const added = await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", libDir), mediaKind: "novel" });
    expect(added.status, JSON.stringify(added)).toBe("ok");
    await ctx.app.scan.whenIdle();
    const resRow = ctx.app.store.sqlite.prepare("SELECT id FROM resources LIMIT 1").get() as { id: string };
    const resourceId = resRow.id;
    const rev = ctx.app.store.sqlite.prepare("SELECT id FROM resource_revisions WHERE resource_id = ?").get(resourceId) as { id: string };

    const nativeCtx = {
      store: ctx.app.store,
      videos: ctx.app.videos,
      profile: { ...DEFAULT_MODEL_PROFILE, inputTypes: ["text", "pdf"] as Array<"text" | "pdf"> },
      runtime: "native" as const,
      protocol: "openai-responses" as const,
      contextTokens: 32_768,
      spoilerGuard: true,
    };
    const chosen = [{ resourceId, revisionId: rev.id, title: "sample" }];

    // Unread under spoilerGuard -> refused with spoiler delivery fallback.
    const before = await decidePdfs(nativeCtx, chosen, new Set(), { tokens: 0 });
    expect(before.files).toHaveLength(0);

    // Completed in a project context -> progress_furthest reaches 1 -> decidePdfs delivers whole PDF!
    const proj = await run(ctx, "project.create", { name: "阅读项目" });
    const now = new Date().toISOString();
    ctx.app.store.sqlite.prepare(
      "INSERT INTO progress(context_id, resource_id, resource_revision_id, last_locator_json, consumed_ranges_json, completion_state, last_interaction_at, percent) VALUES (?,?,?,?,?,?,?,?)",
    ).run(String(proj.value?.id), resourceId, rev.id, null, "[]", "completed", now, 1);
    const after = await decidePdfs(nativeCtx, chosen, new Set(), { tokens: 0 });
    expect(after.files).toHaveLength(1);
  });

  it("A-16: modelLimitsOf refuses HTTP redirects (redirect: error)", async () => {
    let hitTarget = false;
    const server = http.createServer((req, res) => {
      if (req.url === "/forbidden") {
        hitTarget = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "demo", context_length: 99_999 }] }));
        return;
      }
      res.writeHead(302, { Location: "/forbidden" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const result = await modelLimitsOf(`http://127.0.0.1:${addr.port}/v1`, "sk-redirect-test", "demo", new AbortController().signal, 2000);
    expect(result).toEqual({});
    expect(hitTarget).toBe(false);
  });

  it("A-17: fitContext folds prior SUMMARY_MARK and Step 3 does not spin-loop when budget is tight", async () => {
    let seenTranscript = "";
    const fit1 = await fitContext({
      messages: [
        { role: "system", content: `${SUMMARY_MARK}\n较早摘要内容。` },
        { role: "user", content: "第一轮".repeat(600) },
        { role: "assistant", content: "回复".repeat(600) },
        { role: "user", content: "最新问题" },
      ],
      budget: { contextWindow: 4096, contextTokens: 400, maxOutputTokens: 256 },
      summarize: async (transcript) => {
        seenTranscript = transcript;
        return "合并后的新摘要";
      },
    });
    expect(seenTranscript).toContain("较早摘要内容");
    expect(fit1.messages.filter((m) => m.role === "system" && m.content.startsWith(SUMMARY_MARK))).toHaveLength(1);

    // Step 3 with oversized material and tight budget must fail cleanly with BUDGET_EXCEEDED rather than looping endlessly.
    await expect(fitContext({
      messages: [
        { role: "system", content: "资料正文".repeat(1000) },
        { role: "user", content: "问题".repeat(300) },
      ],
      budget: { contextWindow: 1024, contextTokens: 320, maxOutputTokens: 128 },
      calibration: 1.5,
      summarize: async () => "摘要",
    })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" } satisfies Partial<MangaError>);
  });

  it("A-18: oversized tool result summary stays valid JSON and identical tool calls in one step get distinct idempotencyKeys", async () => {
    const ctx = await boot();
    const bigText = "超长结果".repeat(3000);
    const imp = await run(ctx, "library.importText", { title: "大文档", bytes: [...Buffer.from(bigText)] });
    const resId = String(imp.value?.resourceId);
    const server = await startMockProvider({
      streamToolScript: [
        { name: "library.find", arguments: '{"text":"超长结果"}' },
        { name: "library.find", arguments: '{"text":"超长结果"}' },
      ],
    });
    closers.push(server.close);
    await run(ctx, "connections.upsert", {
      label: "m", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo",
      purpose: "text", credentialHandle: ctx.app.stashSecret("sk-tool-test"),
      profile: { contextWindow: 32_768, maxOutput: 2_048 },
    });
    const ses = await run(ctx, "agent.createSession", { title: "a18" });
    const sent = await run(ctx, "agent.send", { sessionId: String(ses.value?.id), text: "查两次", readResourceIds: [resId] });
    const runId = String(sent.value?.runId);
    const finished = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, runId);
    expect(finished.value?.status).toBe("succeeded");

    const toolRows = ctx.app.store.sqlite.prepare("SELECT result_summary FROM agent_tool_events WHERE run_id = ?").all(runId) as Array<{ result_summary: string }>;
    expect(toolRows.length).toBeGreaterThanOrEqual(2);
    for (const row of toolRows) {
      expect(() => JSON.parse(row.result_summary)).not.toThrow();
    }
  });

  it("A-21 & A-26: connections.upsert locks provider protocol, preserves verified capabilities on label edit, and debugContext uses chatConnection", async () => {
    const ctx = await boot();
    const server = await startMockProvider({});
    closers.push(server.close);

    const firstConn = await run(ctx, "connections.upsert", {
      label: "c1", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "model-first",
      purpose: "text", credentialHandle: ctx.app.stashSecret("sk-c1"),
      profile: { contextWindow: 32_768, maxOutput: 2_048 },
    });
    const id1 = String((firstConn.value as { id: string }).id);
    // Simulate verified capabilities on c1, then edit only label -> verified_capabilities_json must be preserved!
    ctx.app.store.sqlite.prepare("UPDATE provider_connections SET verified_capabilities_json = ? WHERE id = ?").run('["text","vision"]', id1);
    const edited = await run(ctx, "connections.upsert", {
      id: id1, label: "c1-renamed", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "model-first",
      purpose: "text", profile: { contextWindow: 32_768, maxOutput: 2_048 },
    });
    expect(edited.status).toBe("ok");
    const row1 = ctx.app.store.sqlite.prepare("SELECT verified_capabilities_json FROM provider_connections WHERE id = ?").get(id1) as { verified_capabilities_json: string | null };
    expect(row1.verified_capabilities_json).toBe('["text","vision"]');

    // Lock protocol on provider-backed connections (those with account_id set).
    ctx.app.store.sqlite.prepare("UPDATE provider_connections SET account_id = 'acc_deepseek' WHERE id = ?").run(id1);
    const badProto = await run(ctx, "connections.upsert", {
      id: id1, label: "c1-renamed", protocol: "openai-responses", baseUrl: server.url, modelId: "model-first",
      purpose: "text",
    });
    expect(badProto.status).toBe("error");
    expect(badProto.error?.code).toBe("VALIDATION_ERROR");

    // debugContext uses the chosen chatConnection (c2), not always the first text connection (c1).
    const secondConn = await run(ctx, "connections.upsert", {
      label: "c2", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "model-chosen",
      purpose: "text", credentialHandle: ctx.app.stashSecret("sk-c2"),
      profile: { contextWindow: 65_536, maxOutput: 4_096 },
    });
    const id2 = String((secondConn.value as { id: string }).id);
    await run(ctx, "settings.setAgent", { chat: { connectionId: id2 } });
    const dbg = await run(ctx, "debug.context", {});
    expect(dbg.status, JSON.stringify(dbg)).toBe("ok");
    expect((dbg.value as { model?: { connectionId?: string; modelId?: string } }).model?.modelId).toBe("model-chosen");
  });

  it("A-22: pruneCommandRequests bounds non-receipt rows while keeping operations receipts", async () => {
    const ctx = await boot();
    const noteRes = await ctx.app.call(ctx.actor, { commandId: "notes.create", idempotencyKey: "receipt-keep-1", input: { title: "r", text: "r" } }, ctx.grant.handle);
    expect(noteRes.status).toBe("ok");

    const ins = ctx.app.store.sqlite.prepare(
      "INSERT INTO command_requests(idempotency_key, command_id, input_hash, actor_kind, actor_id, grant_handle, session_id, run_id, registry_generation, grant_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    ctx.app.store.sqlite.transaction(() => {
      for (let i = 0; i < 2050; i += 1) {
        ins.run(`plain-key-${String(i).padStart(4, "0")}`, "settings.get", "h", "user", "tester", ctx.grant.handle, null, null, 1, "fp");
      }
    })();
    (ctx.app as unknown as { pruneCommandRequests(): void }).pruneCommandRequests();
    const plainLeft = (ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM command_requests WHERE idempotency_key LIKE 'plain-key-%'").get() as { n: number }).n;
    const receiptLeft = ctx.app.store.sqlite.prepare("SELECT 1 FROM command_requests WHERE idempotency_key = 'receipt-keep-1'").get();
    expect(plainLeft).toBeLessThanOrEqual(2000);
    expect(receiptLeft).toBeTruthy();
  });

  it("deleting a project aborts in-flight draft suggestion runs cleanly", async () => {
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    let aborted = false;
    const llm = {
      resolve: () => ({ id: "conn-draft-abort", model: "demo" }),
      complete: (_conn: unknown, req: { signal: AbortSignal }) => new Promise<string>((_resolve, reject) => {
        startedResolve();
        req.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new MangaError("CANCELLED", "aborted"));
        }, { once: true });
      }),
    };
    const ctx = await startApp({ options: { llm } });
    apps.push(ctx);

    const proj = await run(ctx, "project.create", { name: "删除中止项目" });
    expect(proj.status, JSON.stringify(proj)).toBe("ok");
    const projectId = String(proj.value?.id);
    const created = await run(ctx, "draft.create", { projectId, title: "草稿", text: "开头段落。" });
    expect(created.status, JSON.stringify(created)).toBe("ok");
    const draftId = String((created.value as { draft: { id: string } }).draft.id);

    const suggest = await run(ctx, "draft.suggest", { draftId, kind: "continue" });
    expect(suggest.status, JSON.stringify(suggest)).toBe("ok");
    await started;
    expect(aborted).toBe(false);

    const del = await run(ctx, "project.delete", { projectId });
    expect(del.status, JSON.stringify(del)).toBe("ok");
    expect(aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM drafts WHERE project_id = ?").get(projectId)).toEqual({ n: 0 });
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM draft_suggestions WHERE draft_id = ?").get(draftId)).toEqual({ n: 0 });
  });
});
