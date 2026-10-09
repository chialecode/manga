import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { startMockProvider } from "@manga/model-protocol";
import { DrizzleStore } from "@manga/storage-drizzle";
import { DEFAULT_AGENT_TRACE_SETTINGS, TRACE_PART_LIMIT_BYTES, type AgentTraceSettings } from "@manga/contracts/models";
import { AgentTrace, imageDimensions, recordedRequest } from "../../packages/app-core/src/agent-trace.ts";
import { COMPACTION_PROMPT } from "../../packages/app-core/src/agent-context.ts";
import { startApp, waitForRun } from "../helpers/app.ts";
import { makeLegacyProfile } from "../helpers/legacy-db.ts";

/**
 * AT-97. Everything an agent task sends to a model, every tool it calls and every compaction of its context is kept in order, with the context and parameters that
 * were sent, what came back, the time and the tokens, once for each runtime. Secrets and local paths are not in it, a part that is too long is cut and marked, the
 * person can keep only sizes and times, what is kept is cleaned up by age and by size and can be cleared at any time, and it stays out of backups.
 */

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
let counter = 0;
const apps: App[] = [];
const closers: Array<() => Promise<void>> = [];
const folders: string[] = [];
const stores: DrizzleStore[] = [];
afterEach(async () => {
  while (apps.length) apps.pop()!.app.close();
  while (closers.length) await closers.pop()!();
  while (stores.length) { try { stores.pop()!.sqlite.close(); } catch { /* already closed */ } }
  while (folders.length) fs.rmSync(folders.pop()!, { recursive: true, force: true });
});
async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `trace-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(value: Call): T {
  expect(value.status, JSON.stringify(value)).toBe("ok");
  return value.value as T;
}

type Seen = { url: string; body: Record<string, any> };
/** The compaction request opens with its instructions: as a system message, or, under PI, as the first message that says so. */
const isSummary = (body: Record<string, any>) => {
  const first = (body.messages as Array<{ content: unknown }> | undefined)?.[0]?.content;
  return first === COMPACTION_PROMPT || first === `System: ${COMPACTION_PROMPT}`;
};
type Answer = ReturnType<NonNullable<NonNullable<Parameters<typeof startMockProvider>[0]>["respond"]>>;
type Entry = { id: string; kind: string; name: string | null; status: string; firstTokenMs: number | null; durationMs: number | null; modelId: string | null; protocol: string | null; requestBytes: number; responseBytes: number; truncated: boolean; hasContent: boolean; usage: { inputTokens?: number; outputTokens?: number } | null; error: { code?: string; message?: string } | null };

const KEY = "credential-budget-value";
// Shapes that must never be recorded, put together here so that no line of the repository holds a token or a drive path.
const FAKE_TOKEN = ["sk", "abcdefghijklmnop123456789"].join("-");
const LOCAL_FOLDER = ["E:", "Novels"].join("\\");
const LOCAL_PATH = [LOCAL_FOLDER, "秘密的书", "第一卷.txt"].join("\\");
const profile = { contextWindow: 32_768, maxOutput: 2_048 };
const cjk = (count: number, from = 0) => Array.from({ length: count }, (_, index) => String.fromCharCode(0x4e00 + ((index + from) % 2000))).join("");

async function scenario(options: { runtime: "native" | "pi"; script?: Array<{ name: string; arguments: string }>; respond?: (body: Record<string, any>) => Answer; profile?: Record<string, unknown> }) {
  const ctx = await startApp();
  apps.push(ctx);
  // A task runs under the runtime that is set when it is sent; the connection's own setting is for its test.
  ok(await run(ctx, "settings.setRuntime", { runtime: options.runtime }));
  const seen: Seen[] = [];
  const server = await startMockProvider({
    ...(options.script ? { streamToolScript: options.script } : {}),
    onRequest: (request) => { seen.push(request as Seen); },
    respond: (request) => options.respond?.(request.body),
  });
  closers.push(server.close);
  const connection = ok<{ id: string }>(await run(ctx, "connections.upsert", {
    label: "m", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", runtime: options.runtime,
    credentialHandle: ctx.app.stashSecret(KEY), profile: options.profile ?? profile,
  }));
  const session = ok<{ id: string }>(await run(ctx, "agent.createSession", { title: "t" }));
  const send = async (text: string, extra: Record<string, unknown> = {}) => {
    const sent = ok<Record<string, any>>(await run(ctx, "agent.send", { sessionId: session.id, text, ...extra }));
    const finished = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, String(sent.runId), 30_000);
    return { runId: String(sent.runId), finished };
  };
  const list = async (runId: string) => ok<{ entries: Entry[] }>(await run(ctx, "agent.trace.list", { runId })).entries;
  const part = async (entryId: string, which: "request" | "response", extra: Record<string, unknown> = {}) =>
    ok<{ available: boolean; text: string; total: number; offset: number; truncated: boolean; bytes: number }>(await run(ctx, "agent.trace.get", { entryId, part: which, limit: 64 * 1024, ...extra }));
  const whole = async (entryId: string, which: "request" | "response") => {
    const page = await part(entryId, which);
    return page.available ? JSON.parse(page.text) as Record<string, any> : undefined;
  };
  return { ctx, seen, connection, session, send, list, part, whole };
}

describe.each(["native", "pi"] as const)("the trace of a task under the %s runtime (AT-97)", (runtime) => {
  const task = `在资料里找一下 x。我的令牌是 ${FAKE_TOKEN}，文件在 ${LOCAL_PATH}。`;

  it("lists the model requests, the tool call and their order, with times and tokens", async () => {
    // The final answer is given by the provider's custom answer, which states the tokens the way a service does.
    const t = await scenario({ runtime, script: [{ name: "library.find", arguments: '{"text":"x"}' }], respond: (body) => (JSON.stringify(body.messages).includes("library.find") ? { text: "找到了。" } : undefined) });
    const { runId, finished } = await t.send(task);
    expect(finished.value?.status, JSON.stringify(finished.value?.error)).toBe("succeeded");
    const entries = await t.list(runId);
    expect(entries.map((entry) => `${entry.kind}:${entry.name}:${entry.status}`)).toEqual(["model:chat:ok", "tool:library.find:ok", "model:chat:ok"]);
    for (const model of entries.filter((entry) => entry.kind === "model")) {
      expect(model.modelId).toBe("demo");
      expect(model.protocol).toContain("openai-chat-completions");
      expect(model.protocol).toContain(runtime);
      expect(model.firstTokenMs).toBeGreaterThanOrEqual(0);
      expect(model.durationMs).toBeGreaterThanOrEqual(model.firstTokenMs ?? 0);
      expect(model.requestBytes).toBeGreaterThan(200);
      expect(model.responseBytes).toBeGreaterThan(0);
      expect(model.hasContent).toBe(true);
    }
    expect(entries[2]!.usage).toMatchObject({ outputTokens: 2 });
    expect(entries[2]!.usage?.inputTokens).toBeGreaterThan(0);
    expect(entries[1]!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps the context, the parameters and the tools that were sent, and what came back", async () => {
    const t = await scenario({ runtime, script: [{ name: "library.find", arguments: '{"text":"x"}' }] });
    const { runId } = await t.send(task);
    const [first, tool, last] = await t.list(runId);
    const request = (await t.whole(first!.id, "request"))!;
    expect(request.model).toBe("demo");
    expect(request.maxOutputTokens).toBe(2_048);
    expect(request.signal).toBeUndefined();
    expect(JSON.stringify(request.messages)).toContain("在资料里找一下 x");
    expect((request.tools as Array<{ name: string }>).map((entry) => entry.name)).toContain("library.find");
    // The tools the model is offered are the ones an agent may call; the trace is for the person only.
    expect((request.tools as Array<{ name: string }>).some((entry) => entry.name.startsWith("agent.trace"))).toBe(false);
    for (const seen of t.seen) expect(JSON.stringify(seen.body.tools ?? [])).not.toContain("agent.trace");

    const answer = (await t.whole(first!.id, "response"))!;
    expect(answer.toolCalls).toEqual([expect.objectContaining({ name: "library.find" })]);
    expect(JSON.parse(answer.toolCalls[0].arguments)).toEqual({ text: "x" });

    const call = (await t.whole(tool!.id, "request"))!;
    expect(call).toMatchObject({ commandId: "library.find", input: { text: "x" } });
    expect((await t.whole(tool!.id, "response"))!.status).toBe("ok");

    // The second request carries the first one's tool call and its result.
    const again = (await t.whole(last!.id, "request"))!;
    expect(JSON.stringify(again.messages)).toContain("library.find");
    expect((await t.whole(last!.id, "response"))!.text).toContain("hello");
  });

  it("takes out the secret, the token-like text and the local path, from the request and the copy alike, but not the numbers named tokens", async () => {
    const t = await scenario({ runtime, script: [{ name: "library.find", arguments: '{"text":"x"}' }], respond: (body) => (JSON.stringify(body.messages).includes("library.find") ? { text: `好的，你的密钥是 ${KEY}。` } : undefined) });
    const { runId } = await t.send(task);
    const entries = await t.list(runId);
    const everything: string[] = [];
    for (const entry of entries) for (const which of ["request", "response"] as const) everything.push((await t.part(entry.id, which)).text);
    const text = everything.join("\n");
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(LOCAL_FOLDER.replaceAll("\\", "\\\\"));
    expect(text).not.toContain("秘密的书");
    expect(text).toContain("[已隐去]");
    expect(text).toContain("[本机路径]");
    // A count that is named tokens is not a secret.
    expect(text).toContain('"maxOutputTokens":2048');
    const copy = ok<{ json: string; entries: number; omitted: number }>(await run(t.ctx, "agent.trace.export", { runId }));
    expect(copy).toMatchObject({ entries: 3, omitted: 0 });
    for (const secret of [FAKE_TOKEN, KEY, "秘密的书", "Bearer"]) expect(copy.json).not.toContain(secret);
    const parsed = JSON.parse(copy.json) as { runId: string; mode: string; entries: Array<Record<string, any>> };
    expect(parsed).toMatchObject({ runId, mode: "full" });
    expect(parsed.entries).toHaveLength(3);
    expect(parsed.entries[0]!.request.model).toBe("demo");
    expect(parsed.entries[2]!.usage.outputTokens).toBe(2);
  });

  it("pages a long part", async () => {
    const t = await scenario({ runtime });
    const { runId } = await t.send(`请记住这段话：${cjk(3_000)}`);
    const [entry] = await t.list(runId);
    const first = await t.part(entry!.id, "request", { limit: 400 });
    expect(first.text.length).toBe(400);
    expect(first.total).toBeGreaterThan(3_000);
    const second = await t.part(entry!.id, "request", { offset: 400, limit: 400 });
    expect(second.offset).toBe(400);
    const everything = await t.part(entry!.id, "request", { limit: 64 * 1024 });
    expect(everything.text.slice(0, 800)).toBe(first.text + second.text);
  });

  it("keeps a request that failed, with the error in the provider's words and without the key", async () => {
    const t = await scenario({ runtime, respond: () => ({ status: 500, message: `upstream said no to ${KEY}` }) });
    const { runId, finished } = await t.send("你好");
    expect(finished.value?.status).toBe("failed");
    const entries = await t.list(runId);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.every((entry) => entry.kind === "model" && entry.status === "error")).toBe(true);
    const error = entries.at(-1)!.error;
    expect(error?.message).toBeTruthy();
    expect(JSON.stringify(entries)).not.toContain(KEY);
  });

  it("keeps only sizes, times and statuses when the person chose so", async () => {
    const t = await scenario({ runtime, script: [{ name: "library.find", arguments: '{"text":"x"}' }] });
    ok(await run(t.ctx, "settings.setAgent", { trace: { mode: "metadata" } }));
    const { runId } = await t.send(task);
    const entries = await t.list(runId);
    expect(entries.map((entry) => entry.kind)).toEqual(["model", "tool", "model"]);
    for (const entry of entries) {
      expect(entry).toMatchObject({ hasContent: false, status: "ok" });
      expect(entry.requestBytes).toBeGreaterThan(0);
      expect(entry.responseBytes).toBeGreaterThan(0);
      expect(await t.part(entry.id, "request")).toMatchObject({ available: false, text: "" });
    }
    const copy = JSON.parse(ok<{ json: string }>(await run(t.ctx, "agent.trace.export", { runId })).json) as { mode: string; entries: Array<Record<string, unknown>> };
    expect(copy.mode).toBe("metadata");
    for (const entry of copy.entries) expect(entry).not.toHaveProperty("request");
  });

  it("counts what is kept, clears all of it on request, and writes that to the operation log", async () => {
    const t = await scenario({ runtime });
    const { runId } = await t.send("你好");
    const entries = await t.list(runId);
    const stats = ok<{ count: number; bytes: number; oldestAt: string | null }>(await run(t.ctx, "agent.trace.stats", {}));
    expect(stats.count).toBe(entries.length);
    expect(stats.bytes).toBeGreaterThan(100);
    expect(Date.parse(stats.oldestAt ?? "")).toBeGreaterThan(0);
    expect(ok<{ removed: number }>(await run(t.ctx, "agent.trace.clear", {})).removed).toBe(entries.length);
    expect(await t.list(runId)).toEqual([]);
    expect(ok<{ count: number }>(await run(t.ctx, "agent.trace.stats", {})).count).toBe(0);
    const log = ok<{ entries: Array<{ action: string; category: string }> }>(await run(t.ctx, "log.query", { limit: 20 }));
    expect(log.entries.some((entry) => entry.action === "agent.trace.clear" && entry.category === "settings")).toBe(true);
    // Whatever is asked for that is not there is said to be missing.
    expect((await run(t.ctx, "agent.trace.get", { entryId: "req_gone", part: "request" })).status).toBe("error");
  });

  it("applies a shorter retention to what is kept as soon as the setting is saved", async () => {
    const t = await scenario({ runtime });
    const { runId } = await t.send("你好");
    expect((await t.list(runId)).length).toBeGreaterThan(0);
    t.ctx.app.store.sqlite.prepare("UPDATE agent_requests SET started_at = ?, ended_at = ?").run(new Date(Date.now() - 3 * 86_400_000).toISOString(), new Date(Date.now() - 3 * 86_400_000).toISOString());
    ok(await run(t.ctx, "settings.setAgent", { trace: { retentionDays: 2 } }));
    expect(await t.list(runId)).toEqual([]);
  });

  it("records the compaction of the context: the summary request, and what was replaced", async () => {
    let refuse = true;
    const t = await scenario({
      runtime, profile: { contextWindow: 32_768, maxOutput: 2_048 },
      respond: (body) => {
        const messages = JSON.stringify(body.messages);
        if (isSummary(body)) return { text: "摘要：前两个问题都回答过了。" };
        if (/第[一二]个问题/.test(messages) && !messages.includes("读这两篇笔记")) return { text: "答".repeat(4_000) };
        if (refuse && messages.includes("读这两篇笔记")) { refuse = false; return { status: 500, message: "boom" }; }
        return undefined;
      },
    });
    const first = ok<{ objectId: string }>(await run(t.ctx, "notes.create", { title: "甲", text: cjk(8_000) }));
    const second = ok<{ objectId: string }>(await run(t.ctx, "notes.create", { title: "乙", text: cjk(8_000, 99) }));
    for (const question of ["第一个问题", "第二个问题"]) expect((await t.send(question)).finished.value?.status).toBe("succeeded");
    const failed = await t.send("读这两篇笔记，再告诉我读完了", { noteObjectIds: [first.objectId, second.objectId] });
    expect(failed.finished.value?.status).toBe("failed");
    ok(await run(t.ctx, "connections.setProfile", { connectionId: t.connection.id, profile: { contextWindow: 20_000, maxOutput: 2_000 } }));
    ok(await run(t.ctx, "agent.retry", { runId: failed.runId }));
    const finished = await waitForRun(t.ctx.app, t.ctx.actor, t.ctx.grant.handle, failed.runId, 30_000);
    expect(finished.value?.status, JSON.stringify(finished.value?.error)).toBe("succeeded");

    const entries = await t.list(failed.runId);
    const compaction = entries.filter((entry) => entry.kind === "compaction");
    expect(compaction.map((entry) => entry.name)).toEqual(["compaction#1", "compaction"]);
    const summaryRequest = (await t.whole(compaction[0]!.id, "request"))!;
    expect(JSON.stringify(summaryRequest.messages)).toContain("第一个问题");
    expect((await t.whole(compaction[0]!.id, "response"))!.text).toContain("摘要");
    const note = (await t.whole(compaction[1]!.id, "response"))!;
    expect(note.tokensAfter).toBeLessThan(note.tokensBefore);
    expect(note.replaced).toBeGreaterThan(0);
    // The failed first attempt and the retry are one run's story, in order.
    const kinds = entries.map((entry) => `${entry.kind}:${entry.status}`);
    expect(kinds[0]).toBe("model:error");
    expect(kinds.at(-1)).toBe("model:ok");
  });
});

describe("the parts of a trace, one by one", () => {
  const settings = (patch: Partial<AgentTraceSettings> = {}): AgentTraceSettings => ({ ...DEFAULT_AGENT_TRACE_SETTINGS, ...patch });
  function freshStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "manga-trace-"));
    folders.push(dir);
    const store = new DrizzleStore({ profileDir: dir, hostId: `trace-${++counter}` });
    stores.push(store);
    return { dir, store };
  }
  const page = (trace: AgentTrace, id: string, part: "request" | "response") => trace.get(id, part, 0, 1_000_000);

  it("cuts a part at 256 KiB, says so, keeps the size it had, and the cut text still parses", () => {
    const { store } = freshStore();
    const trace = new AgentTrace(store, () => settings());
    const handle = trace.begin({ runId: "run_1", step: 0, kind: "tool", name: "notes.get", request: { commandId: "notes.get" } });
    const big = "长".repeat(400_000);
    handle.finish({ status: "ok", value: big });
    const [entry] = trace.list("run_1");
    expect(entry).toMatchObject({ truncated: true, status: "ok" });
    expect(entry!.responseBytes).toBeGreaterThan(1_000_000);
    const response = page(trace, entry!.id, "response");
    const kept = JSON.parse(response.text) as { truncated: boolean; originalBytes: number; head: string; note: string };
    expect(kept.truncated).toBe(true);
    expect(kept.originalBytes).toBe(entry!.responseBytes);
    expect(Buffer.byteLength(kept.head)).toBeLessThanOrEqual(TRACE_PART_LIMIT_BYTES);
    expect(kept.note).toContain("已截断");
    expect(kept.head.includes("�")).toBe(false);
    // A part under the limit is whole.
    const small = trace.begin({ runId: "run_1", step: 1, kind: "tool", name: "notes.get", request: {} });
    small.finish({ status: "ok", value: "短" });
    expect(trace.list("run_1")[1]).toMatchObject({ truncated: false });
  });

  it("blanks the fields named like a secret and the exact strings it was told about, and keeps the counts", () => {
    const { store } = freshStore();
    const trace = new AgentTrace(store, () => settings());
    const handle = trace.begin({
      runId: "run_2", step: 0, kind: "model", name: "chat", connection: { id: "conn_1", modelId: "m", protocol: "openai-chat-completions · native" }, secrets: ["super-secret-key-value"],
      request: { apiKey: "abc", Authorization: "Bearer zzzzzzzzzzzzzzzzzzzz", accessToken: "t-1", maxOutputTokens: 77, nested: { password: "p", note: "visible", echo: "key is super-secret-key-value ok" } },
    });
    handle.fail(new Error(`401 for super-secret-key-value from ${["E:", "Users", "me", "a.txt"].join("\\")}`), "error", { text: "echo super-secret-key-value" });
    const [entry] = trace.list("run_2");
    expect(entry).toMatchObject({ status: "error" });
    const request = JSON.parse(page(trace, entry!.id, "request").text) as Record<string, any>;
    expect(request).toMatchObject({ apiKey: "[已隐去]", Authorization: "[已隐去]", accessToken: "[已隐去]", maxOutputTokens: 77, nested: { password: "[已隐去]", note: "visible" } });
    expect(request.nested.echo).toBe("key is [已隐去] ok");
    expect(page(trace, entry!.id, "response").text).not.toContain("super-secret-key-value");
    expect(JSON.stringify(entry)).not.toContain("super-secret-key-value");
    expect(JSON.stringify(entry)).not.toContain("a.txt");
  });

  it("records a picture as its kind, size and a fingerprint, never as the picture", () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from("IHDR"), Buffer.from([0, 0, 0, 16, 0, 0, 0, 24]), randomBytes(40)]);
    const base64 = png.toString("base64");
    const recorded = recordedRequest({
      model: "m", signal: new AbortController().signal,
      messages: [{ role: "user", content: "看图", images: [{ mediaType: "image/png", base64 }] }, { role: "user", content: "没有图" }],
    });
    expect(recorded.signal).toBeUndefined();
    const images = (recorded.messages as Array<{ images?: Array<Record<string, unknown>> }>)[0]!.images!;
    expect(images).toEqual([{ mediaType: "image/png", bytes: png.length, width: 16, height: 24, sha256: expect.stringMatching(/^[0-9a-f]{16}$/) }]);
    expect(JSON.stringify(recorded)).not.toContain(base64.slice(20, 60));
    expect((recorded.messages as unknown[])[1]).toEqual({ role: "user", content: "没有图" });
  });

  it("reads the size of a picture from the head of a PNG, a JPEG and a WebP", () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0x20, 0, 0x40]), Buffer.alloc(12)]);
    expect(imageDimensions(jpeg)).toEqual({ width: 64, height: 32 });
    const webp = Buffer.alloc(40);
    webp.write("RIFF", 0, "latin1"); webp.write("WEBP", 8, "latin1"); webp.write("VP8X", 12, "latin1");
    webp.writeUIntLE(99, 24, 3); webp.writeUIntLE(49, 27, 3);
    expect(imageDimensions(webp)).toEqual({ width: 100, height: 50 });
    expect(imageDimensions(Buffer.from("not a picture at all, just text that goes on for a while"))).toBeNull();
  });

  it("keeps no contents in the sizes-only mode, but the sizes are the real ones", () => {
    const { store } = freshStore();
    let current = settings({ mode: "metadata" });
    const trace = new AgentTrace(store, () => current);
    const handle = trace.begin({ runId: "run_3", step: 0, kind: "model", name: "chat", request: { text: cjk(500) } });
    handle.finish({ text: cjk(300) }, { inputTokens: 10, outputTokens: 5 });
    const [entry] = trace.list("run_3");
    expect(entry).toMatchObject({ hasContent: false, usage: { inputTokens: 10, outputTokens: 5 } });
    expect(entry!.requestBytes).toBeGreaterThan(1_500);
    expect(entry!.responseBytes).toBeGreaterThan(900);
    expect(trace.stats().bytes).toBe(0);
    // A change of mode applies to the next request only.
    current = settings({ mode: "full" });
    const next = trace.begin({ runId: "run_3", step: 1, kind: "model", name: "chat", request: { text: "x" } });
    next.finish({ text: "y" });
    expect(trace.list("run_3")[1]).toMatchObject({ hasContent: true });
  });

  it("removes what is older than the days kept, then the oldest until it is under its size", () => {
    const { store } = freshStore();
    const trace = new AgentTrace(store, () => settings({ retentionDays: 30, maxMegabytes: 1 }));
    const add = (runId: string, step: number, startedAt: string) => {
      const handle = trace.begin({ runId, step, kind: "tool", name: "t", request: { n: randomBytes(150_000).toString("hex") } });
      handle.finish({ n: randomBytes(150_000).toString("hex") });
      store.sqlite.prepare("UPDATE agent_requests SET started_at = ? WHERE id = ?").run(startedAt, handle.id);
      return handle.id;
    };
    const now = Date.parse("2026-10-09T00:00:00.000Z");
    const old = add("old", 0, "2026-08-01T00:00:00.000Z");
    const ids = [0, 1, 2, 3, 4].map((index) => add("recent", index, `2026-10-0${index + 1}T00:00:00.000Z`));
    expect(trace.stats().bytes).toBeGreaterThan(1024 * 1024);
    const { removed } = trace.prune(now);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(trace.list("old")).toEqual([]);
    expect(store.sqlite.prepare("SELECT 1 FROM agent_requests WHERE id = ?").get(old)).toBeUndefined();
    expect(trace.stats().bytes).toBeLessThanOrEqual(1024 * 1024);
    // The oldest of what was left went first, the newest is still there.
    const left = trace.list("recent").map((entry) => entry.id);
    expect(left).not.toContain(ids[0]);
    expect(left).toContain(ids[4]);
    expect(left).toEqual(ids.filter((id) => left.includes(id)));
  });

  it("marks a request that was running when the application stopped, and never gets in the way of a call", () => {
    const { store } = freshStore();
    const first = new AgentTrace(store, () => settings());
    first.begin({ runId: "run_4", step: 0, kind: "model", name: "chat", request: { a: 1 } });
    expect(first.list("run_4")[0]!.status).toBe("running");
    const second = new AgentTrace(store, () => settings());
    expect(second.list("run_4")[0]).toMatchObject({ status: "error", error: { message: expect.stringContaining("stopped") } });
    // A record that cannot be written is only missing: the handle does nothing and nothing throws.
    store.sqlite.close();
    const handle = second.begin({ runId: "run_5", step: 0, kind: "model", name: "chat", request: {} });
    expect(() => { handle.firstToken(); handle.finish({ text: "x" }); handle.fail(new Error("late")); }).not.toThrow();
  });

  it("settles a request once: the first word counts", () => {
    const { store } = freshStore();
    const trace = new AgentTrace(store, () => settings());
    const handle = trace.begin({ runId: "run_6", step: 0, kind: "model", name: "chat", request: {} });
    handle.firstToken();
    handle.finish({ text: "done" }, { inputTokens: 1, outputTokens: 1 });
    handle.fail(new Error("the reader stopped"), "cancelled");
    handle.finish({ text: "again" });
    const [entry] = trace.list("run_6");
    expect(entry).toMatchObject({ status: "ok", error: null });
    expect(JSON.parse(page(trace, entry!.id, "response").text)).toEqual({ text: "done" });
  });

  it("stays out of the copy of the database made before a migration, and is still in the database", () => {
    const { dir } = makeLegacyProfile(9);
    folders.push(dir);
    const seed = new Database(path.join(dir, "manga.sqlite"));
    seed.exec(`CREATE TABLE IF NOT EXISTS agent_requests (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT, status TEXT NOT NULL DEFAULT 'running', started_at TEXT NOT NULL,
      first_token_at TEXT, ended_at TEXT, connection_id TEXT, model_id TEXT, protocol TEXT, request_z BLOB, response_z BLOB, request_bytes INTEGER NOT NULL DEFAULT 0, response_bytes INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0, usage_json TEXT, error_json TEXT)`);
    seed.prepare("INSERT INTO agent_requests(id, run_id, step, kind, status, started_at, request_z, request_bytes) VALUES ('req_a','run_a',0,'model','ok',?,?,5000)").run(new Date().toISOString(), randomBytes(5_000));
    seed.pragma("wal_checkpoint(TRUNCATE)");
    seed.close();
    const store = new DrizzleStore({ profileDir: dir, hostId: `trace-backup-${++counter}` });
    stores.push(store);
    expect(store.migration).toMatchObject({ from: 9 });
    expect(store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_requests").get()).toEqual({ n: 1 });
    expect(fs.readdirSync(dir).filter((name) => name.includes("premigrate") && !name.endsWith(".partial"))).toEqual(["manga.sqlite.premigrate-v9"]);
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".partial"))).toEqual([]);
    const backup = new Database(path.join(dir, "manga.sqlite.premigrate-v9"), { readonly: true });
    try {
      expect(backup.prepare("SELECT COUNT(*) AS n FROM agent_requests").get()).toEqual({ n: 0 });
      // The library in the backup is intact.
      expect((backup.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number }).n).toBeGreaterThan(0);
    } finally {
      backup.close();
    }
  });
});
