import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentStreamEvent, StreamAgent, StreamItem, StreamUser } from "@manga/contracts";
import { createAgentStreamCoalescer } from "@manga/app-core";
import { startMockDeepSeek } from "@manga/model-protocol";
import { startApp, tempProfile, waitForRun } from "../helpers/app.ts";
import { call, deepseekApp, PROVIDER_KEY, PROVIDER_REF, providerPackage, providerPublisher } from "../helpers/provider-fixture.ts";
import { tmpDir } from "../helpers/plugin-fixtures.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) {
    try { await closers.pop()!(); } catch { /* ignore teardown race */ }
  }
});

async function boot(
  mock: NonNullable<Parameters<typeof deepseekApp>[0]>["mock"] = {},
  add: { models: string[]; services: string[] } = { models: ["deepseek-flash"], services: ["search", "fetch", "ocr", "speech"] },
) {
  const rig = await deepseekApp({ mock, add });
  closers.push(rig.close);
  const session = await call(rig.ctx, "conversation.new", { contextId: null });
  expect(session.status, JSON.stringify(session)).toBe("ok");
  return { ...rig, sessionId: String((session.value as { sessionId: string }).sessionId) };
}

const chatBodies = (requests: Array<{ path: string; body: unknown }>) =>
  requests.filter((r) => r.path.endsWith("/chat/completions")).map((r) => r.body as Record<string, any>);

async function streamItems(rig: Awaited<ReturnType<typeof boot>>): Promise<StreamItem[]> {
  const res = await call(rig.ctx, "session.stream", { sessionId: rig.sessionId });
  expect(res.status, JSON.stringify(res)).toBe("ok");
  return (res.value as { items: StreamItem[] }).items;
}

describe("Agent backend streaming, coalescing, and DB write throttling", () => {
  it("coalesces rapid delta bursts (~33ms) and flushes immediately on structural events in causal order", async () => {
    const emitted: AgentStreamEvent[] = [];
    const coalescer = createAgentStreamCoalescer((ev) => emitted.push(ev), 35);

    coalescer.push({ kind: "start", runId: "r1", sessionId: "s1", modelId: "deepseek-flash" });
    expect(emitted).toHaveLength(1);

    // Rapid burst of reasoning deltas should buffer until structural event or interval.
    coalescer.push({ kind: "reasoning-delta", runId: "r1", sessionId: "s1", delta: "步一" });
    coalescer.push({ kind: "reasoning-delta", runId: "r1", sessionId: "s1", delta: "步二" });
    expect(emitted).toHaveLength(1);

    // Switching to text-delta flushes pending reasoning delta immediately to preserve causal order.
    coalescer.push({ kind: "text-delta", runId: "r1", sessionId: "s1", delta: "你好" });
    coalescer.push({ kind: "text-delta", runId: "r1", sessionId: "s1", delta: "世界" });
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual({ kind: "reasoning-delta", runId: "r1", sessionId: "s1", delta: "步一步二" });

    // Structural event flushes pending text-delta first, then emits the structural event.
    coalescer.push({ kind: "title", runId: "r1", sessionId: "s1", title: "测试标题" });
    expect(emitted).toHaveLength(4);
    expect(emitted[2]).toEqual({ kind: "text-delta", runId: "r1", sessionId: "s1", delta: "你好世界" });
    expect(emitted[3]).toEqual({ kind: "title", runId: "r1", sessionId: "s1", title: "测试标题" });

    // Timer-driven flush works for trailing delta bursts.
    coalescer.push({ kind: "text-delta", runId: "r1", sessionId: "s1", delta: "尾" });
    coalescer.push({ kind: "text-delta", runId: "r1", sessionId: "s1", delta: "巴" });
    expect(emitted).toHaveLength(4);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(emitted).toHaveLength(5);
    expect(emitted[4]).toEqual({ kind: "text-delta", runId: "r1", sessionId: "s1", delta: "尾巴" });
    coalescer.dispose();
  });

  it("pushes typed AgentStreamEvents in real time while throttling SQLite live_text updates", async () => {
    // Local deterministic SSE server emitting 40 individual text chunks rapidly (~3ms apart).
    const chunks = Array.from({ length: 40 }, (_, i) => `片${i} `);
    const fullExpected = chunks.join("");
    const server = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        if ((req.url ?? "").endsWith("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: [{ id: "stream-demo", object: "model" }] }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        let idx = 0;
        const sendNext = () => {
          if (idx < chunks.length) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[idx] }, finish_reason: null }] })}\n\n`);
            idx += 1;
            setTimeout(sendNext, 2);
          } else {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 40 } })}\n\n`);
            res.end("data: [DONE]\n\n");
          }
        };
        sendNext();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));

    const ctx = await startApp({ profileRoot: tempProfile() });
    closers.push(async () => { ctx.app.close(); });

    // Install a SQLite trigger to count exact live_text UPDATE statements on agent_runs.
    ctx.app.store.sqlite.exec(`
      CREATE TEMP TABLE _live_text_writes (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, len INTEGER);
      CREATE TEMP TRIGGER _trg_live_text_writes AFTER UPDATE OF live_text ON agent_runs
      BEGIN
        INSERT INTO _live_text_writes (run_id, len) VALUES (NEW.id, length(COALESCE(NEW.live_text, '')));
      END;
    `);

    const conn = await call(ctx, "connections.upsert", {
      label: "Stream Mock",
      protocol: "openai-chat-completions",
      baseUrl,
      modelId: "stream-demo",
      purpose: "text",
      credentialHandle: ctx.app.stashSecret("sk-local"),
    });
    expect(conn.status, JSON.stringify(conn)).toBe("ok");
    const connId = String((conn.value as { id: string }).id);
    const setRes = await call(ctx, "settings.setAgent", { chat: { connectionId: connId } });
    expect(setRes.status, JSON.stringify(setRes)).toBe("ok");

    const session = await call(ctx, "conversation.new", { contextId: null });
    const sessionId = String((session.value as { sessionId: string }).sessionId);

    const events: AgentStreamEvent[] = [];
    const unsubscribe = ctx.app.onAgentStream((ev) => events.push(ev));

    const sent = await call(ctx, "agent.send", { sessionId, text: "流式测试" });
    expect(sent.status, JSON.stringify(sent)).toBe("ok");
    const runId = String((sent.value as { runId: string }).runId);
    const done = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, runId);
    unsubscribe();

    expect(done.value?.status).toBe("succeeded");
    expect(done.value?.text).toBe(fullExpected);

    // Every single chunk streamed immediately over onAgentStream without loss.
    const streamedText = events
      .filter((e): e is Extract<AgentStreamEvent, { kind: "text-delta" }> => e.kind === "text-delta")
      .map((e) => e.delta)
      .join("");
    expect(streamedText).toBe(fullExpected);
    expect(events[0]).toMatchObject({ kind: "start", runId, sessionId });
    expect(events.at(-1)).toMatchObject({ kind: "done", runId, sessionId, status: "succeeded", stopReason: "end_turn" });

    // SQLite live_text writes must be heavily throttled compared to 40 chunks!
    const writeCount = (ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM _live_text_writes WHERE run_id = ?").get(runId) as { n: number }).n;
    expect(writeCount).toBeGreaterThanOrEqual(1);
    expect(writeCount).toBeLessThan(15);
  });
});

describe("Enriched StreamAgent, DeepSeek product capabilities, and agent run commands", () => {
  it("populates full StreamAgent metadata (toolSteps, serverToolSteps, citations, usage, modelId, inline title, errorCode)", async () => {
    const rig = await boot({
      toolScript: [{ name: "library.list", arguments: "{}" }],
      answer: "整理好了[citation:1]。",
      title: "检索摘要对话",
      includeFindInPage: true,
      includeImageSearch: true,
    });

    const events: AgentStreamEvent[] = [];
    const unsub = rig.ctx.app.onAgentStream((ev) => events.push(ev));

    const sent = await call(rig.ctx, "agent.send", {
      sessionId: rig.sessionId,
      text: "请结合资料库和网页搜索给出综述",
      allowCommands: ["web.search"],
    });
    expect(sent.status, JSON.stringify(sent)).toBe("ok");
    const runId = String((sent.value as { runId: string }).runId);
    const done = await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, runId);
    unsub();

    expect(done.value?.status, JSON.stringify(done.value?.error)).toBe("succeeded");

    // Verify inline title was requested, emitted, and persisted on the conversation.
    const bodies = chatBodies(rig.server.requests);
    expect(bodies[0]?.title).toEqual({ enabled: true });
    // Verify latest_reminder was injected on DeepSeek requests.
    const reminder = (bodies[0]?.messages as Array<{ role: string; content: string }>).find((m) => m.role === "latest_reminder");
    expect(reminder).toBeDefined();
    expect(reminder!.content).toMatch(/^\d{4}-\d{2}-\d{2},.+,(?:App|Web),/);

    expect(events.some((e) => e.kind === "title" && e.title === "检索摘要对话")).toBe(true);
    expect(events.some((e) => e.kind === "server-tool")).toBe(true);
    expect(events.some((e) => e.kind === "tool-step" && e.step.name === "library.list" && e.step.status === "done")).toBe(true);
    expect(events.some((e) => e.kind === "citations" && e.citations.length > 0)).toBe(true);

    const convList = await call(rig.ctx, "conversation.list", { contextId: null });
    expect(convList.status, JSON.stringify(convList)).toBe("ok");
    const conv = (convList.value as { items: Array<{ sessionId: string; title: string }> }).items.find((c) => c.sessionId === rig.sessionId);
    expect(conv?.title).toBe("检索摘要对话");

    const items = await streamItems(rig);
    const agent = items.find((item): item is StreamAgent => item.kind === "agent")!;
    expect(agent.modelId).toBe("deepseek-flash");
    expect(agent.stopReason).toBe("end_turn");
    expect(agent.canContinue).toBeFalsy();
    expect(agent.generatedTitle).toBe("检索摘要对话");
    expect(agent.toolSteps?.length).toBeGreaterThanOrEqual(1);
    expect(agent.toolSteps![0]).toMatchObject({ name: "library.list", status: "done" });
    expect(typeof agent.toolSteps![0]!.elapsedMs).toBe("number");
    const kinds = new Set((agent.serverToolSteps ?? []).map((s) => s.kind));
    expect(kinds.has("search")).toBe(true);
    expect(kinds.has("find_in_page")).toBe(true);
    expect(kinds.has("image_search")).toBe(true);
    expect(agent.citations?.length).toBeGreaterThan(0);
    expect(agent.citations![0]).toMatchObject({
      index: 1,
      url: expect.stringMatching(/^https:\/\//),
      title: expect.any(String),
    });
    expect(agent.reasoningElapsedMs).toBeGreaterThanOrEqual(0);
    expect(agent.reasoningStartedAt).toBeDefined();
    expect(agent.usage).toMatchObject({
      inputTokens: expect.any(Number),
      outputTokens: expect.any(Number),
      latencyMs: expect.any(Number),
    });
    expect(agent.usage!.searches).toBeGreaterThanOrEqual(1);

    // Second turn must NOT request inline title generation again.
    const nextSent = await call(rig.ctx, "agent.send", { sessionId: rig.sessionId, text: "继续追问" });
    const nextDone = await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, String((nextSent.value as { runId: string }).runId));
    expect(nextDone.value?.status).toBe("succeeded");
    expect(chatBodies(rig.server.requests).at(-1)?.title).toBeUndefined();

    // Error classification (`errorCode`) on HTTP 402 insufficient balance.
    const broke = await boot({ fail: [{ path: "/chat/completions", status: 402, times: 5 }] });
    const failSent = await call(broke.ctx, "agent.send", { sessionId: broke.sessionId, text: "触发余额不足" });
    const failRunId = String((failSent.value as { runId: string }).runId);
    const failDone = await waitForRun(broke.ctx.app, broke.ctx.actor, broke.ctx.grant.handle, failRunId);
    expect(failDone.value?.status).toBe("failed");
    const failItems = await streamItems(broke);
    const failedAgent = failItems.find((i): i is StreamAgent => i.kind === "agent")!;
    expect(failedAgent.errorCode).toBe("balance");
  });

  it("guards deepseek-v4-pro against native server tools even with stale persisted capabilities and falls back to standalone web.search", async () => {
    const rig = await boot(
      { toolScript: [{ name: "web.search", arguments: JSON.stringify({ query: "V4Pro回退测试" }) }], answer: "通过独立搜索找到了。" },
      { models: ["deepseek-v4-pro"], services: ["search"] },
    );
    const connId = rig.connection("text")!;
    // Simulate a legacy persisted connection whose profile_json wrongly contains "web_search".
    const existingRow = rig.ctx.app.store.sqlite.prepare("SELECT profile_json FROM provider_connections WHERE id = ?").get(connId) as { profile_json: string | null };
    const existingProfile = existingRow?.profile_json ? JSON.parse(existingRow.profile_json) as Record<string, unknown> : {};
    rig.ctx.app.store.sqlite.prepare("UPDATE provider_connections SET profile_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...existingProfile, capabilities: ["tools", "reasoning", "web_search"] }), connId);

    const sent = await call(rig.ctx, "agent.send", {
      sessionId: rig.sessionId,
      text: "查一下 https://example.org/doc 并联网搜索",
      allowCommands: ["web.search"],
    });
    expect(sent.status, JSON.stringify(sent)).toBe("ok");
    const runId = String((sent.value as { runId: string }).runId);
    const done = await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, runId);
    expect(done.value?.status, JSON.stringify(done.value?.error)).toBe("succeeded");
    expect(done.value?.text).toBe("通过独立搜索找到了。");

    const bodies = chatBodies(rig.server.requests);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies) {
      const tools = (body.tools as Array<Record<string, any>> | undefined) ?? [];
      const msgs = (body.messages as Array<Record<string, any>> | undefined) ?? [];
      expect(tools.some((t) => t.type === "deepseek_web_search")).toBe(false);
      expect(tools.some((t) => t.type === "deepseek_read_url")).toBe(false);
      expect(msgs.some((m) => m.role === "latest_reminder")).toBe(false);
      expect(body.title).toBeUndefined();
    }
    expect(rig.server.requests.some((r) => r.path === "/v1/tools/search")).toBe(true);
  });

  it("auto-enables deepseek_read_url when prompt contains an HTTP(S) URL and round-trips read_link server_tool_calls", async () => {
    const rig = await boot({ answer: "已读取该链接的要点。" });
    const sent = await call(rig.ctx, "agent.send", {
      sessionId: rig.sessionId,
      text: "请帮我总结 https://example.org/article/42 的核心内容",
    });
    expect(sent.status, JSON.stringify(sent)).toBe("ok");
    const runId = String((sent.value as { runId: string }).runId);
    const done = await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, runId);
    expect(done.value?.status, JSON.stringify(done.value?.error)).toBe("succeeded");

    const firstBody = chatBodies(rig.server.requests)[0]!;
    const firstTools = (firstBody.tools as Array<Record<string, any>>) ?? [];
    expect(firstTools).toContainEqual({ type: "deepseek_read_url" });

    const items = await streamItems(rig);
    const firstAgent = items.find((i): i is StreamAgent => i.kind === "agent")!;
    expect(firstAgent.serverToolSteps?.some((s) => s.kind === "read_link")).toBe(true);

    // Next turn round-trips read_link server_tool_calls back to DeepSeek.
    const next = await call(rig.ctx, "agent.send", { sessionId: rig.sessionId, text: "展开讲讲第二段" });
    await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, String((next.value as { runId: string }).runId));
    const secondBody = chatBodies(rig.server.requests).at(-1)!;
    const prevAssistants = (secondBody.messages as Array<Record<string, any>>).filter((m) => m.role === "assistant");
    expect(prevAssistants.at(-1)?.server_tool_calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          calls: expect.arrayContaining([expect.objectContaining({ type: "deepseek_read_url" })]),
        }),
      ]),
    );
  });

  it("allows fast non-thinking deepseek_web_search when no client tools are offered (smart thinkingRaised)", async () => {
    const rig = await boot({ answer: "快速搜索完成。" });
    const connId = rig.connection("text")!;
    // Disable client tools & thinking on the connection profile.
    const setProf = await call(rig.ctx, "connections.setProfile", {
      connectionId: connId,
      profile: { capabilities: ["web_search"], reasoningEffort: null },
    });
    expect(setProf.status, JSON.stringify(setProf)).toBe("ok");

    const sent = await call(rig.ctx, "agent.send", {
      sessionId: rig.sessionId,
      text: "快查天气",
      allowCommands: ["web.search"],
    });
    const runId = String((sent.value as { runId: string }).runId);
    const done = await waitForRun(rig.ctx.app, rig.ctx.actor, rig.ctx.grant.handle, runId);
    expect(done.value?.status, JSON.stringify(done.value?.error)).toBe("succeeded");

    const body = chatBodies(rig.server.requests).at(-1)!;
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.tools).toContainEqual({ type: "deepseek_web_search" });
    expect((body.messages as Array<{ role: string }>).some((m) => m.role === "system")).toBe(false);
    const items = await streamItems(rig);
    const agent = items.find((i): i is StreamAgent => i.kind === "agent")!;
    expect(agent.thinkingRaised).toBeFalsy();
  });

  it("uploads fileAttachments via DeepSeek Files API, self-heals expired file_id on 400, cleans up, and respects disabled plugin", async () => {
    // Wrap mock DeepSeek behind a deterministic local proxy that expires uploaded file_id ONCE on the first chat request.
    const upstream = await startMockDeepSeek({ key: PROVIDER_KEY, answer: "已读取附件内容。" });
    closers.push(() => upstream.close());
    let expiredOnce = false;
    const proxy = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks);
        const urlPath = req.url ?? "/";
        if (!expiredOnce && req.method === "POST" && urlPath.endsWith("/chat/completions") && upstream.files.size > 0) {
          expiredOnce = true;
          // Force the mock server to reject with 400 expired file_id on attempt 1!
          upstream.files.clear();
        }
        const headers: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.toLowerCase() !== "host" && v !== undefined) headers[k] = v;
        }
        const target = new URL(urlPath, upstream.url);
        const fwd = http.request(target, { method: req.method, headers }, (upRes) => {
          res.writeHead(upRes.statusCode ?? 500, upRes.headers);
          upRes.pipe(res);
        });
        fwd.on("error", (err) => { res.writeHead(502); res.end(String(err)); });
        fwd.end(raw);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    closers.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())));

    const ctx = await startApp({ profileRoot: tempProfile(), options: { providers: { testOrigin: proxyUrl } } });
    closers.push(async () => { ctx.app.close(); });
    await call(ctx, "plugin.trust.add", { publicKey: providerPublisher.publicKey, label: providerPublisher.label });
    const pkgDir = tmpDir();
    closers.push(async () => { fs.rmSync(pkgDir, { recursive: true, force: true }); });
    const pkgPath = path.join(pkgDir, "provider.manga-plugin");
    fs.writeFileSync(pkgPath, providerPackage());
    await call(ctx, "plugin.install", { pathHandle: ctx.app.registerPath("file", pkgPath), grant: ["network"] });
    await call(ctx, "providers.add", {
      providerRef: PROVIDER_REF,
      credentialHandle: ctx.app.stashSecret(PROVIDER_KEY),
      models: ["deepseek-flash"],
      services: [],
      verified: false,
    });

    const samplePdf = path.join(pkgDir, "brief.pdf");
    fs.writeFileSync(samplePdf, Buffer.from("%PDF-1.4\n% synthetic test document\n", "utf8"));
    const pathHandle = ctx.app.registerPath("file", samplePdf);

    const session = await call(ctx, "conversation.new", { contextId: null });
    const sessionId = String((session.value as { sessionId: string }).sessionId);

    const sent = await call(ctx, "agent.send", {
      sessionId,
      text: "总结附件重点",
      fileAttachments: [{ pathHandle, name: "brief.pdf", mimeType: "application/pdf" }],
    });
    expect(sent.status, JSON.stringify(sent)).toBe("ok");
    const runId = String((sent.value as { runId: string }).runId);
    const done = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, runId);
    expect(done.value?.status, JSON.stringify(done.value?.error)).toBe("succeeded");
    expect(done.value?.text).toBe("已读取附件内容。");

    // Initial upload + self-heal re-upload after 400 = 2 POST /v1/files calls, both with purpose preceding file.
    const uploads = upstream.requests.filter((r) => r.method === "POST" && r.path.endsWith("/v1/files"));
    expect(uploads).toHaveLength(2);
    for (const u of uploads) {
      expect(u.fields).toContain("purpose");
      expect(u.fields).toContain("file");
      expect(u.fields!.indexOf("purpose")).toBeLessThan(u.fields!.indexOf("file"));
    }

    // Chat request sent flat file_id part.
    const chats = chatBodies(upstream.requests);
    expect(chats).toHaveLength(2);
    const userMsg = (chats[1]!.messages as Array<Record<string, any>>).find((m) => m.role === "user")!;
    expect(Array.isArray(userMsg.content)).toBe(true);
    expect((userMsg.content as Array<Record<string, any>>).some((p) => p.type === "file" && typeof p.file_id === "string")).toBe(true);

    // Ephemeral uploaded files were cleaned up via DELETE /v1/files/{id}.
    const deletes = upstream.requests.filter((r) => r.method === "DELETE" && r.path.includes("/v1/files/"));
    expect(deletes.length).toBeGreaterThanOrEqual(1);
    expect(upstream.files.size).toBe(0);

    // StreamUser surfaces attachment metadata WITHOUT leaking internal pathHandle.
    const stream = await call(ctx, "session.stream", { sessionId });
    const userItem = (stream.value as { items: StreamItem[] }).items.find((i): i is StreamUser => i.kind === "user")!;
    expect(userItem.attachments).toEqual([expect.objectContaining({ name: "brief.pdf", mimeType: "application/pdf" })]);
    expect(JSON.stringify(userItem)).not.toContain(pathHandle);

    // When plugin is disabled, sending an attachment makes ZERO upload or chat requests.
    await call(ctx, "plugin.disable", { pluginId: "demo.provider" });
    const countBefore = upstream.requests.length;
    const disabledPath = ctx.app.registerPath("file", samplePdf);
    const blocked = await call(ctx, "agent.send", {
      sessionId,
      text: "停用后带附件",
      fileAttachments: [{ pathHandle: disabledPath, name: "brief.pdf", mimeType: "application/pdf" }],
    });
    if (blocked.status === "ok") {
      const blockedDone = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, String((blocked.value as { runId: string }).runId));
      expect(blockedDone.value?.status).toBe("failed");
    }
    expect(upstream.requests.length).toBe(countBefore);
  });

  it("supports agent.continueRun (without duplicate user turn), agent.regenerateRun, and agent.editAndResend", async () => {
    // 1. Test continueRun on a cancelled run with partial text.
    const rig = await boot({ delayMs: 25, answer: () => "前半部分内容已经流出非常长一段文字用来保证中断前有局部输出。" });
    const events: AgentStreamEvent[] = [];
    const unsub = rig.ctx.app.onAgentStream((ev) => {
      events.push(ev);
      if (ev.kind === "text-delta") {
        // Cancel after the first text delta arrives!
        void call(rig.ctx, "agent.cancel", { runId: ev.runId });
      }
    });
    // Use a custom slow chunk server? MockDeepSeek sends content in one SSE write after delayMs, so let's test BOTH:
    // (a) Cancel right after receiving partial text OR set up a run cancelled with partial output directly via a slow 2-chunk server.
    unsub();

    // Actually test continueRun deterministically with a real multi-chunk SSE server so cancel hits mid-stream!
    let chunkPhase = 0;
    const midServer = http.createServer((req, res) => {
      const bodyChunks: Buffer[] = [];
      req.on("data", (c: Buffer) => bodyChunks.push(c));
      req.on("end", () => {
        const body = bodyChunks.length ? JSON.parse(Buffer.concat(bodyChunks).toString("utf8")) as Record<string, any> : {};
        if ((req.url ?? "").endsWith("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-flash", object: "model" }] }));
          return;
        }
        const msgs = (body.messages as Array<Record<string, any>> | undefined) ?? [];
        const last = msgs.at(-1);
        const isContinue = last?.role === "assistant" && typeof last.content === "string";
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (isContinue) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "后半段续写完成。" }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10 } })}\n\n`);
          res.end("data: [DONE]\n\n");
          return;
        }
        chunkPhase += 1;
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "前半段正文，" }, finish_reason: null }] })}\n\n`);
        // Hold stream open briefly so cancel hits cleanly while partial text is already recorded!
        const timer = setTimeout(() => {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "未中断结尾。" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\n`);
          res.end("data: [DONE]\n\n");
        }, chunkPhase === 1 ? 1200 : 10);
        res.on("close", () => clearTimeout(timer));
      });
    });
    await new Promise<void>((resolve) => midServer.listen(0, "127.0.0.1", resolve));
    const midUrl = `http://127.0.0.1:${(midServer.address() as { port: number }).port}/v1`;
    closers.push(() => new Promise<void>((resolve) => midServer.close(() => resolve())));

    const cctx = await startApp({ profileRoot: tempProfile() });
    closers.push(async () => { cctx.app.close(); });
    const cConn = await call(cctx, "connections.upsert", {
      label: "Continue Mock",
      protocol: "openai-chat-completions",
      baseUrl: midUrl,
      modelId: "deepseek-flash",
      purpose: "text",
      credentialHandle: cctx.app.stashSecret("sk-cont"),
    });
    expect(cConn.status, JSON.stringify(cConn)).toBe("ok");
    const cSet = await call(cctx, "settings.setAgent", { chat: { connectionId: String((cConn.value as { id: string }).id) } });
    expect(cSet.status, JSON.stringify(cSet)).toBe("ok");
    const cSess = await call(cctx, "conversation.new", { contextId: null });
    const cSessionId = String((cSess.value as { sessionId: string }).sessionId);

    const gotDelta = new Promise<string>((resolve) => {
      const off = cctx.app.onAgentStream((ev) => {
        if (ev.kind === "text-delta" && ev.delta.includes("前半段")) {
          off();
          resolve(ev.runId);
        }
      });
    });
    const firstRun = await call(cctx, "agent.send", { sessionId: cSessionId, text: "写两段话" });
    const firstRunId = String((firstRun.value as { runId: string }).runId);
    await gotDelta;
    await call(cctx, "agent.cancel", { runId: firstRunId });
    const cancelled = await waitForRun(cctx.app, cctx.actor, cctx.grant.handle, firstRunId);
    expect(cancelled.value?.status).toBe("cancelled");

    const beforeStream = (await call(cctx, "session.stream", { sessionId: cSessionId })).value as { items: StreamItem[] };
    const partialAgent = beforeStream.items.find((i): i is StreamAgent => i.kind === "agent")!;
    expect(partialAgent.stopReason).toBe("cancelled");
    expect(partialAgent.canContinue).toBe(true);
    expect(partialAgent.text).toBe("前半段正文，");

    // Continue the cancelled run: must append cleanly without creating a second user turn!
    const cont = await call(cctx, "agent.continueRun", { runId: firstRunId });
    expect(cont.status, JSON.stringify(cont)).toBe("ok");
    const contRunId = String((cont.value as { runId: string }).runId);
    const contDone = await waitForRun(cctx.app, cctx.actor, cctx.grant.handle, contRunId);
    expect(contDone.value?.status, JSON.stringify(contDone.value?.error)).toBe("succeeded");
    expect(contDone.value?.text).toBe("前半段正文，后半段续写完成。");

    const afterContinue = (await call(cctx, "session.stream", { sessionId: cSessionId })).value as { items: StreamItem[] };
    expect(afterContinue.items.filter((i) => i.kind === "user")).toHaveLength(1);
    const finalAgent = afterContinue.items.filter((i): i is StreamAgent => i.kind === "agent");
    expect(finalAgent).toHaveLength(1);
    expect(finalAgent[0]!.text).toBe("前半段正文，后半段续写完成。");
    expect(finalAgent[0]!.canContinue).toBeFalsy();

    // Refusing continueRun on a completed end_turn run & on a refusal run.
    const badContinue = await call(cctx, "agent.continueRun", { runId: contRunId });
    expect(badContinue.status).toBe("error");

    const refusedRig = await boot({ refusal: true });
    const refSent = await call(refusedRig.ctx, "agent.send", { sessionId: refusedRig.sessionId, text: "触发拒答" });
    const refRunId = String((refSent.value as { runId: string }).runId);
    await waitForRun(refusedRig.ctx.app, refusedRig.ctx.actor, refusedRig.ctx.grant.handle, refRunId);
    const refItems = await streamItems(refusedRig);
    const refAgent = refItems.find((i): i is StreamAgent => i.kind === "agent")!;
    expect(refAgent.refusal).toBe(true);
    expect(refAgent.canContinue).toBeFalsy();
    const refCont = await call(refusedRig.ctx, "agent.continueRun", { runId: refRunId });
    expect(refCont.status).toBe("error");

    // 2. Test agent.regenerateRun on a succeeded run (and hides superseded run from stream).
    let regenCount = 0;
    const regenRig = await boot({ answer: () => { regenCount += 1; return `第${regenCount}版回答`; } });
    const r1 = await call(regenRig.ctx, "agent.send", { sessionId: regenRig.sessionId, text: "给我一个版本" });
    const r1Id = String((r1.value as { runId: string }).runId);
    await waitForRun(regenRig.ctx.app, regenRig.ctx.actor, regenRig.ctx.grant.handle, r1Id);

    const regen = await call(regenRig.ctx, "agent.regenerateRun", { runId: r1Id });
    expect(regen.status, JSON.stringify(regen)).toBe("ok");
    const r2Id = String((regen.value as { runId: string }).runId);
    expect(r2Id).not.toBe(r1Id);
    const r2Done = await waitForRun(regenRig.ctx.app, regenRig.ctx.actor, regenRig.ctx.grant.handle, r2Id);
    expect(r2Done.value?.status).toBe("succeeded");
    expect(r2Done.value?.text).toBe("第2版回答");

    const regenStream = await streamItems(regenRig);
    expect(regenStream.filter((i) => i.kind === "user")).toHaveLength(1);
    const regenAgents = regenStream.filter((i): i is StreamAgent => i.kind === "agent");
    expect(regenAgents).toHaveLength(1);
    expect(regenAgents[0]!.runId).toBe(r2Id);
    expect(regenAgents[0]!.text).toBe("第2版回答");

    // 3. Test agent.editAndResend: supersedes target turn + subsequent turns cleanly.
    const r3 = await call(regenRig.ctx, "agent.send", { sessionId: regenRig.sessionId, text: "第二轮原问题" });
    const r3Id = String((r3.value as { runId: string }).runId);
    await waitForRun(regenRig.ctx.app, regenRig.ctx.actor, regenRig.ctx.grant.handle, r3Id);

    const edited = await call(regenRig.ctx, "agent.editAndResend", {
      runId: r2Id,
      text: "改写后的第一轮问题",
    });
    expect(edited.status, JSON.stringify(edited)).toBe("ok");
    const r4Id = String((edited.value as { runId: string }).runId);
    const r4Done = await waitForRun(regenRig.ctx.app, regenRig.ctx.actor, regenRig.ctx.grant.handle, r4Id);
    expect(r4Done.value?.status).toBe("succeeded");

    const editedStream = await streamItems(regenRig);
    const users = editedStream.filter((i): i is StreamUser => i.kind === "user");
    const agents = editedStream.filter((i): i is StreamAgent => i.kind === "agent");
    expect(users).toHaveLength(1);
    expect(users[0]!.text).toBe("改写后的第一轮问题");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.runId).toBe(r4Id);
  });
});
