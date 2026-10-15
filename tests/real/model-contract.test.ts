import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { evidenceRunDir } from "../../scripts/desktop-paths.ts";
import { startApp, waitForRun } from "../helpers/app.ts";
import { readLocalEnv } from "../helpers/local-env.ts";
import { inLibrary, samplePath } from "../helpers/samples.ts";
import { EnergyVad, FakeAsr, join, quiet, samplesFor, seedResource, textLocator, tone, toBase64 } from "../helpers/voice.ts";

/**
 * Contract check of the configured text and embedding services through the app's own paths (ACT-05 (1)). It runs only when
 * MANGA_LIVE_MODEL_CONTRACT=1 and never in CI.
 *
 * - everything sent is made up here or comes from the sample generator: a short story, two filler notes, an earlier conversation written into the
 *   test's own profile, two transcript lines from a fake recogniser, and a synthetic comic page with "002" on it;
 * - the app talks to a forwarder on the loopback address, which counts every request on its way out and refuses what is over the budget of its kind
 *   (text, pictures, embeddings), so the budget holds whichever client a runtime uses; once, it answers a request itself with a failure, to set up
 *   the retry that has to shrink the conversation, and that answer never reaches the service;
 * - the endpoints, keys and models come from the ignored local test configuration (MANGA_TEST_LLM_*, MANGA_TEST_EMBEDDING_*) and are never printed or
 *   written; the evidence carries outcomes, counts and timings, and of each request only its shape (how it ended, how long the answer was, which tools
 *   it called), never what the model wrote: the checks on an answer say only whether it held what it should.
 * A separate vision connection is not configured locally, so the route that reads pictures with one is not run here.
 */
const enabled = process.env.MANGA_LIVE_MODEL_CONTRACT === "1" && !process.env.CI;
// Requests per kind in one run; MANGA_LIVE_MODEL_BUDGET="text=12,embedding=4" lowers (or raises) them for a run the developer allowed.
const BUDGET = { text: 30, vision: 3, embedding: 10, models: 4 };
type Kind = keyof typeof BUDGET;
for (const part of (process.env.MANGA_LIVE_MODEL_BUDGET ?? "").split(",")) {
  const [kind, value] = part.split("=").map((item) => item.trim());
  if (kind && kind in BUDGET && Number.isInteger(Number(value)) && Number(value) >= 0) BUDGET[kind as Kind] = Number(value);
}

type Step = { step: string; outcome: "ok" | "failed" | "not-run"; detail?: Record<string, unknown> };

function purpose(prefix: "LLM" | "EMBEDDING") {
  const keys = ["API_BASE_URL", "API_KEY", "MODEL_ID", "PROTOCOL"].map((name) => `MANGA_TEST_${prefix}_${name}`);
  const values = readLocalEnv(keys);
  const [baseUrl, apiKey, modelId, protocol] = keys.map((key) => values[key]);
  if (!baseUrl || !apiKey || !modelId) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, modelId, protocol: protocol === "openai-responses" ? "openai-responses" as const : "openai-chat-completions" as const };
}

type Rejection = { kind: Kind; status: number; provider: { type?: string; code?: string; message?: string }; request: { roles: string[]; tools: number } };

/** The order of a request's messages, as roles (with a mark where a message carries tool calls, answers one, or holds a picture): what a service may refuse. */
function roleShape(body: string): Rejection["request"] {
  try {
    const json = JSON.parse(body) as { messages?: Array<{ role?: string; tool_calls?: unknown[]; tool_call_id?: string; content?: unknown }>; tools?: unknown[] };
    const roles = (json.messages ?? []).map((message) => `${message.role ?? "?"}${message.tool_calls ? `+calls${message.tool_calls.length}` : ""}${message.tool_call_id ? "+result" : ""}${Array.isArray(message.content) && JSON.stringify(message.content).includes("image") ? "+image" : ""}`);
    return { roles, tools: json.tools?.length ?? 0 };
  } catch {
    return { roles: [], tools: 0 };
  }
}

/** A loopback forwarder in front of one service: counts by kind, refuses what is over the budget, and can answer one request itself. */
async function forwarder(target: string, apiKey: string, counts: Record<Kind | "refused" | "overBudget", number>, rejections: Rejection[], refuseOnce: (body: string) => boolean) {
  let refused = false;
  const upstream = globalThis.fetch;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const text = body.toString("utf8");
    const rest = (request.url ?? "/").replace(/^\/p/, "");
    const kind: Kind = /\/embeddings(\?|$)/.test(rest) ? "embedding" : /\/models(\?|$)/.test(rest) ? "models" : /image_url|input_image/.test(text) ? "vision" : "text";
    if (!refused && refuseOnce(text)) {
      refused = true;
      counts.refused += 1;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "answered by the contract test, not by the service" } }));
      return;
    }
    if (counts[kind] >= BUDGET[kind]) {
      counts.overBudget += 1;
      response.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
      response.end(JSON.stringify({ error: { message: "over the contract test's budget" } }));
      return;
    }
    counts[kind] += 1;
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || ["host", "connection", "content-length", "accept-encoding", "transfer-encoding"].includes(name)) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    try {
      const answer = await upstream(`${target}${rest}`, { method: request.method, headers, body: request.method === "GET" || request.method === "HEAD" ? undefined : body });
      if (!answer.ok) {
        // A refusal is kept as the service's own words about it (short, with the key taken out) and the shape of what was sent, never its content.
        const said = await answer.text().catch(() => "");
        let provider: Rejection["provider"] = {};
        try {
          const parsed = JSON.parse(said) as { error?: { type?: string; code?: string | number; message?: string }; message?: string; code?: string | number };
          const error = parsed.error ?? parsed;
          provider = { type: error.type, code: error.code === undefined ? undefined : String(error.code), message: typeof error.message === "string" ? error.message.split(apiKey).join("<key>").slice(0, 240) : undefined };
        } catch {
          provider = { message: said.split(apiKey).join("<key>").slice(0, 120) };
        }
        rejections.push({ kind, status: answer.status, provider, request: roleShape(text) });
        response.writeHead(answer.status, { "content-type": answer.headers.get("content-type") ?? "application/json" });
        response.end(said);
        return;
      }
      const out: Record<string, string> = {};
      answer.headers.forEach((value, name) => { if (!["content-encoding", "content-length", "transfer-encoding", "connection"].includes(name)) out[name] = value; });
      response.writeHead(answer.status, out);
      if (answer.body) Readable.fromWeb(answer.body as Parameters<typeof Readable.fromWeb>[0]).pipe(response);
      else response.end();
    } catch {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "the service could not be reached" } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/p`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

const STORY = [
  "海港小镇的北面有一座白色的灯塔，镇上的人都说它比镇子还老。",
  "每到傍晚，守灯塔的人沈渡舟会沿着一百二十级台阶爬上去，擦亮镜片，点燃灯火。",
  "冬天的风很大，渔船回港的时候总要先看见那束光，才敢放慢速度。",
  "有一年大雾连着下了七天，沈渡舟没有下过塔，镇上的孩子们每天把饭送到台阶下面。",
  "后来新的电灯装好了，灯塔不再需要人守，他把最后一本值班日志交给了镇上的图书馆。",
].join("\n\n");
const filler = (count: number, seed = 0) => Array.from({ length: count }, (_, index) => "潮汐风帆礁石海鸥灯火夜航"[(index * 7 + seed) % 12]).join("");

describe.skipIf(!enabled)("text, picture and embedding services contract (live, synthetic content only)", () => {
  it("tests the connection, reads a picture, finds a passage with a tool, organizes a recording, shrinks a long conversation and searches by meaning, inside the budget", async (context) => {
    const out = path.join(evidenceRunDir("live-model-contract"), "summary.json");
    const steps: Step[] = [];
    const counts = { text: 0, vision: 0, embedding: 0, models: 0, refused: 0, overBudget: 0 };
    const rejections: Rejection[] = [];
    const write = (status: "passed" | "failed" | "not-run", extra: Record<string, unknown> = {}) => {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), status, requests: counts, budget: BUDGET, steps, rejectedByService: rejections, ...extra }, null, 2));
    };

    const llm = purpose("LLM");
    const embedding = purpose("EMBEDDING");
    if (!llm) {
      write("not-run", { reason: "MANGA_TEST_LLM_* is not configured in the ignored local environment" });
      context.skip();
      return;
    }

    let refuseArmed = false;
    const text = await forwarder(llm.baseUrl, llm.apiKey, counts, rejections, (body) => refuseArmed && body.includes("两篇笔记已经附上") && !body.includes("压缩成一份摘要"));
    const vectors = embedding ? await forwarder(embedding.baseUrl, embedding.apiKey, counts, rejections, () => false) : null;
    const asr = new FakeAsr();
    asr.text = (startMs) => (startMs < 4000
      ? "这一章里主角第一次见到海边的灯塔，我觉得灯塔象征着希望。"
      : "后来作者写灯塔熄灭了，正好和开头形成对照，这个对照值得记下来。");
    const { app, actor, grant, profileRoot } = await startApp({ options: { vad: new EnergyVad(), asr, voiceRetryBaseMs: 0 } });
    let counter = 0;
    const run = (commandId: string, input: Record<string, unknown>) => app.call(actor, { commandId, idempotencyKey: `live-contract-${counter += 1}`, input }, grant.handle);
    const ok = async <T = Record<string, any>>(commandId: string, input: Record<string, unknown>): Promise<T> => {
      const result = await run(commandId, input);
      expect(result.status, `${commandId}: ${result.error?.code ?? ""}`).toBe("ok");
      return result.value as T;
    };
    const finish = async (runId: string) => (await waitForRun(app, actor, grant.handle, runId, 300_000)).value as Record<string, any>;
    const parses = (value: string) => { try { JSON.parse(value); return true; } catch { return false; } };
    // What a run asked and got, as shapes: per request how it ended, how long the answer was, whether it was blank and which tools it called.
    const shapes = async (runId: string) => {
      const exported = await ok<{ json: string }>("agent.trace.export", { runId });
      const entries = (JSON.parse(exported.json) as { entries: Array<Record<string, any>> }).entries;
      return entries.filter((entry) => entry.kind === "model" || /^compaction#/.test(String(entry.name ?? ""))).map((entry) => {
        const response = (entry.response && typeof entry.response === "object" ? entry.response : {}) as { text?: string; finishReason?: string; toolCalls?: Array<{ name?: string; arguments?: string }> };
        const answer = typeof response.text === "string" ? response.text : typeof entry.response === "string" ? entry.response : "";
        return { kind: entry.kind, name: entry.name, status: entry.status, finishReason: response.finishReason ?? null, answerChars: answer.length, blank: !answer.trim(), toolCalls: (response.toolCalls ?? []).map((call) => ({ name: call.name ?? "", argsChars: (call.arguments ?? "").length, parses: parses(call.arguments ?? "") })) };
      });
    };
    let lastRun: string | undefined;
    const record = async (step: string, work: () => Promise<Record<string, unknown>>) => {
      const started = Date.now();
      lastRun = undefined;
      try {
        const detail = await work();
        steps.push({ step, outcome: "ok", detail: { ms: Date.now() - started, ...detail, ...(lastRun ? { requests: await shapes(lastRun) } : {}) } });
      } catch (error) {
        const requests = lastRun ? await shapes(lastRun).catch(() => undefined) : undefined;
        steps.push({ step, outcome: "failed", detail: { ms: Date.now() - started, error: error instanceof Error ? error.message.slice(0, 300) : String(error), ...(requests ? { requests } : {}) } });
      }
    };
    // A model that ends its turn without a word fails the run (empty_answer); a person would press retry, and so does this, once.
    const settle = async (runId: string) => {
      lastRun = runId;
      let done = await finish(runId);
      let retriedBlank = false;
      if (done.status === "failed" && done.error?.details?.reason === "empty_answer") {
        retriedBlank = true;
        await ok("agent.retry", { runId });
        done = await finish(runId);
      }
      return { done, retriedBlank };
    };

    try {
      // The text connection takes the PI runtime for its own test and for organizing a recording; tasks run under the native runtime.
      const connection = await ok<{ id: string }>("connections.upsert", {
        label: "live text", protocol: llm.protocol, runtime: "pi", baseUrl: text.url, modelId: llm.modelId, purpose: "text", timeoutMs: 120_000,
        credentialHandle: app.stashSecret(llm.apiKey),
      });
      await ok("settings.setRuntime", { runtime: "native" });

      let takesImages = false;
      await record("connections.probe (PI runtime)", async () => {
        const result = await ok<Record<string, any>>("connections.probe", { connectionId: connection.id });
        expect(result.ok, JSON.stringify(result.failure ?? {})).toBe(true);
        takesImages = (result.capabilities as string[]).includes("vision");
        return { ok: result.ok, latencyMs: result.latencyMs, replied: String(result.reply ?? "").trim().length > 0, capabilities: result.capabilities, windowDetected: Boolean(result.detected?.contextWindow), imageInputInProfile: (result.profile?.inputTypes ?? []).includes("image") };
      });

      // A picture as a task's material: page 2 of the synthetic comic, which shows "002" in large digits.
      const session = async () => (await ok<{ id: string }>("agent.createSession", { title: "live contract" })).id;
      await record("picture in a task (native runtime, the text model reads it)", async () => {
        const comic = await ok<{ resourceId: string; revisionId: string }>("library.importDocument", { title: "合成漫画", kind: "comic", pathHandle: app.registerPath("file", inLibrary(app, samplePath("cbz-basic"))) });
        const pages = await ok<{ pages: Array<{ id: string }> }>("comic.pages", { resourceId: comic.resourceId });
        const still = await ok<{ materialId: string }>("material.region", { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: pages.pages[1]!.id });
        const sent = await run("agent.send", { sessionId: await session(), text: "这张图中间写的是什么数字？只回答数字。", imageMaterialIds: [still.materialId] });
        if (!takesImages) {
          expect(sent.error?.code).toBe("MODEL_CAPABILITY_MISSING");
          return { route: "none", refusedWithReason: true };
        }
        expect(sent.status, sent.error?.code).toBe("ok");
        const { done, retriedBlank } = await settle(String(sent.value?.runId));
        expect(done.status, JSON.stringify(done.error ?? {})).toBe("succeeded");
        expect(/(^|\D)0*2(?!\d)/.test(String(done.text ?? "")), "the answer gives the number on the page").toBe(true);
        return { route: "direct", status: done.status, retriedBlank, readTheNumber: true };
      });

      await record("tool use in a task (native runtime)", async () => {
        const book = await ok<{ resourceId: string }>("library.importText", { title: "灯塔守夜人", bytes: [...Buffer.from(STORY)] });
        // A task reads only what the person ticked for it; the book is ticked, and the model has to look inside it with a tool.
        const sent = await ok<{ runId: string }>("agent.send", { sessionId: await session(), text: "我勾选了《灯塔守夜人》这本书。请用工具在书里查一下：守灯塔的人叫什么名字？只回答名字。", readResourceIds: [book.resourceId] });
        const { done, retriedBlank } = await settle(sent.runId);
        expect(done.status, JSON.stringify(done.error ?? {})).toBe("succeeded");
        const tools = (done.tools ?? []) as Array<{ commandId: string; result: { status: string } }>;
        expect(tools.length).toBeGreaterThan(0);
        expect(String(done.text ?? "").includes("沈渡舟"), "the answer names the keeper").toBe(true);
        return { status: done.status, retriedBlank, toolCalls: tools.length, tools: [...new Set(tools.map((tool) => tool.commandId))], toolsOk: tools.filter((tool) => tool.result.status === "ok").length, foundTheName: true };
      });

      await record("capture.organize (PI runtime, transcript from a fake recogniser)", async () => {
        const resource = seedResource(app.store, { title: "试读" });
        const started = await ok<{ sessionId: string }>("capture.start", { mode: "toggle", retention: "discard", resourceId: resource.resourceId, resourceRevisionId: resource.revisionId, locator: textLocator(0) });
        const pcm = join(quiet(1000), tone(2000), quiet(3000), tone(2000), quiet(2000));
        const size = samplesFor(500);
        for (let at = 0, seq = 0; at < pcm.length; at += size, seq += 1) await ok("capture.append", { sessionId: started.sessionId, seq, data: toBase64(pcm.subarray(at, Math.min(pcm.length, at + size))) });
        await ok("capture.stop", { sessionId: started.sessionId, durationMs: pcm.length / 16 });
        for (let i = 0; i < 600; i += 1) {
          await app.media.jobs.idle();
          const status = (await ok<{ session: { stage: string } }>("capture.status", { sessionId: started.sessionId })).session;
          if (status.stage === "done" && !app.voice.pipeline.busy(started.sessionId)) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        await ok("capture.organize", { sessionId: started.sessionId });
        let draft: { state: string; text: string } | undefined;
        for (let i = 0; i < 1200 && (!draft || draft.state === "organizing"); i += 1) {
          await app.media.jobs.idle();
          draft = (await ok<{ drafts: Array<{ state: string; text: string }> }>("capture.review", { sessionId: started.sessionId })).drafts[0];
          if (draft?.state !== "organizing") break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        expect(draft?.state).toBe("ready");
        expect(draft!.text.includes("灯塔"), "the draft keeps the subject").toBe(true);
        return { state: draft!.state, chars: draft!.text.length, keptTheSubject: true };
      });

      if (!embedding || !vectors) {
        steps.push({ step: "embedding", outcome: "not-run", detail: { reason: "MANGA_TEST_EMBEDDING_* is not configured" } });
      } else {
        await record("embedding: connection test, index and search by meaning", async () => {
          const saved = await ok<{ id: string }>("connections.upsert", {
            label: "live embedding", protocol: embedding.protocol, baseUrl: vectors.url, modelId: embedding.modelId, purpose: "embedding", timeoutMs: 60_000,
            credentialHandle: app.stashSecret(embedding.apiKey),
          });
          const tested = await ok<Record<string, any>>("connections.test", { connectionId: saved.id, capability: "embedding" });
          expect(tested).toMatchObject({ ok: true, vectors: 1 });
          const topics = [
            { title: "登山", text: "登山队在海拔七千米的冰壁下扎营，夜里气温降到零下三十度，每走一步都要停下来喘气。" },
            { title: "厨房", text: "她把面团擀成薄薄的圆皮，包进韭菜和鸡蛋，捏出一排整齐的褶子，下锅煮到浮起来。" },
            { title: "沙漠", text: "驼队在黄昏时分才开始赶路，沙丘的影子越拉越长，水囊里只剩下最后几口水。" },
            { title: "图书馆", text: "旧图书馆的木地板踩上去吱呀作响，管理员把借书卡一张张插回抽屉里。" },
          ];
          for (const topic of topics) await ok("notes.create", { title: topic.title, text: topic.text });
          await ok("semantic.configure", { enabled: true, connectionId: saved.id, segmentation: "paragraph-300" });
          await app.semantic.settled();
          const status = await ok<Record<string, any>>("semantic.status", {});
          expect(status.active?.chunks ?? 0, JSON.stringify(status.failed?.error ?? {})).toBeGreaterThan(0);
          const found = await ok<{ state: string; results: Array<{ title: string; score: number }> }>("semantic.search", { text: "在高原上缺氧又寒冷，爬雪山非常艰难", kinds: ["note"] });
          expect(found.results[0]?.title, `order: ${found.results.map((item) => item.title).join(" > ")}`).toBe("登山");
          // Indexing stops here, so the long notes of the next step are not sent to the embedding service.
          await ok("semantic.configure", { enabled: false });
          return { tested: true, dim: status.active?.dim ?? null, chunks: status.active.chunks, engine: status.active.engine, topHitRight: true, results: found.results.length };
        });
      }

      await record("shrinking a long conversation (native runtime): the model writes the summary, the fact in it survives", async () => {
        const sessionId = await session();
        // Two earlier exchanges with long answers, written straight into this profile; the facts sit in the middle of them.
        const db = app.store.sqlite;
        const earlier = [
          { question: "第一个问题：介绍一下那座灯塔。", answer: `${filler(2_500, 1)}灯塔的编号是 L-7319，建于一九零八年。${filler(1_000, 2)}` },
          { question: "第二个问题：那艘船呢？", answer: `${filler(2_500, 3)}那艘渔船叫“晨星号”，船长叫沈渡舟。${filler(1_000, 4)}` },
        ];
        earlier.forEach((turn, index) => {
          const at = new Date(Date.now() - (10 - index) * 60_000).toISOString();
          const runId = `run_live_history_${index}`;
          db.prepare("INSERT INTO agent_runs(id, session_id, status, grant_handle, budget_json, input_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)").run(runId, sessionId, "succeeded", grant.handle, "{}", turn.question, at, at);
          db.prepare("INSERT INTO agent_messages(id, run_id, role, text, created_at) VALUES (?,?,?,?,?)").run(`msg_live_history_${index}`, runId, "assistant", turn.answer, at);
        });
        const first = await ok<{ objectId: string }>("notes.create", { title: "甲", text: filler(8_000, 5) });
        const second = await ok<{ objectId: string }>("notes.create", { title: "乙", text: filler(8_000, 6) });
        await ok("connections.setProfile", { connectionId: connection.id, profile: { contextWindow: 32_768, maxOutput: 2_048 } });
        refuseArmed = true;
        const sent = await ok<{ runId: string }>("agent.send", { sessionId, text: "两篇笔记已经附上，不用再查。请告诉我：前面对话里提到的灯塔编号是多少？只回答编号。", noteObjectIds: [first.objectId, second.objectId] });
        lastRun = sent.runId;
        const failed = await finish(sent.runId);
        expect(failed.status).toBe("failed");
        expect(counts.refused).toBe(1);
        // A smaller window than the task was frozen for: the earlier conversation has to give.
        await ok("connections.setProfile", { connectionId: connection.id, profile: { contextWindow: 20_000, maxOutput: 2_000 } });
        await ok("agent.retry", { runId: sent.runId });
        const { done, retriedBlank } = await settle(sent.runId);
        await ok("connections.setProfile", { connectionId: connection.id, profile: { contextWindow: 128_000, maxOutput: 8_192 } });
        expect(done.status, JSON.stringify(done.error ?? {})).toBe("succeeded");
        expect(done.usage?.compactions ?? 0).toBeGreaterThanOrEqual(1);
        expect(String(done.text ?? "").includes("7319"), "the answer keeps the number from the summarized conversation").toBe(true);
        return { status: done.status, retriedBlank, compactions: done.usage.compactions, factSurvived: true };
      });

      await record("trace and secrets", async () => {
        const traced = (app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_requests").get() as { n: number }).n;
        expect(traced).toBeGreaterThan(0);
        // No key in anything the app wrote: the database, its journal, logs and settings.
        const secrets = [llm.apiKey, ...(embedding ? [embedding.apiKey] : [])].filter((value) => value.length >= 8);
        let files = 0;
        let leaks = 0;
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else {
              files += 1;
              const bytes = fs.readFileSync(full);
              for (const secret of secrets) if (bytes.includes(secret)) leaks += 1;
            }
          }
        };
        walk(profileRoot);
        expect(leaks).toBe(0);
        return { tracedRequests: traced, filesScanned: files, keysFound: leaks };
      });
    } finally {
      app.close();
      await text.close();
      await vectors?.close();
      const resolved = path.resolve(profileRoot);
      if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith("manga-test-")) fs.rmSync(resolved, { recursive: true, force: true });
    }

    const failed = steps.filter((step) => step.outcome === "failed");
    write(failed.length ? "failed" : "passed", { separateVisionConnection: "not-run (no MANGA_TEST_VISION_* configuration)" });
    expect(counts.overBudget).toBe(0);
    expect(failed.map((step) => `${step.step}: ${String(step.detail?.error ?? "")}`)).toEqual([]);
  }, 900_000);
});
