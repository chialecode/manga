import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  searchDeepSeek, speechBilledChars, streamText, synthesizeDeepSeek, transcribeDeepSeek,
  type AiRuntimeId, type ChatMessage, type StreamEvent, type TextRequest,
} from "@manga/model-protocol";
import { buildPluginPackage } from "../../packages/app-core/src/plugins/package.ts";
import { startApp, tempProfile, waitForRun } from "../helpers/app.ts";
import { makeKey, tmpDir } from "../helpers/plugin-fixtures.ts";

/**
 * Contract check of DeepSeek's real service (计划 4.10, ACT-23). It runs only when MANGA_LIVE_DEEPSEEK_KEY_FILE names a file holding the key, and never in CI.
 *
 * - the key is read from that file only; it is never printed, and everything this test writes passes a filter that puts `<key>` in its place;
 * - everything sent is made up here: short sentences, a drawn picture, a fictional name; nothing from a library;
 * - one run makes at most 40 requests (a counter refuses the 41st), and the result keeps status codes, shapes, timings, billing units and similarity,
 *   never what the model wrote. It is written to `.local/deepseek-contract.json` (ignored by Git) for the stage report.
 */
const keyFile = process.env.MANGA_LIVE_DEEPSEEK_KEY_FILE;
const enabled = Boolean(keyFile) && !process.env.CI;
const BASE = "https://api.deepseek.com";
const MAX_REQUESTS = 40;
const MODEL = "deepseek-flash";

let used = 0;
const take = (count = 1) => {
  if (used + count > MAX_REQUESTS) throw new Error(`the contract run would go over ${MAX_REQUESTS} requests`);
  used += count;
};
const results: Array<{ case: string; outcome: "ok" | "failed"; detail: Record<string, unknown> }> = [];
const key = () => fs.readFileSync(keyFile!, "utf8").trim();
const scrub = (text: string) => (enabled ? text.split(key()).join("<key>") : text);
const record = (name: string, outcome: "ok" | "failed", detail: Record<string, unknown>) => results.push({ case: name, outcome, detail: JSON.parse(scrub(JSON.stringify(detail))) as Record<string, unknown> });

type Streamed = { text: string; reasoning: string; calls: Array<{ id: string; name: string; arguments: string }>; server: number; citations: number; usage?: Record<string, unknown>; serverToolCalls?: unknown[]; ms: number; firstMs: number | null };
async function chat(request: Omit<TextRequest, "model"> & { model?: string }, runtime: AiRuntimeId = "native"): Promise<Streamed> {
  take();
  const started = Date.now();
  const out: Streamed = { text: "", reasoning: "", calls: [], server: 0, citations: 0, ms: 0, firstMs: null };
  const calls = new Map<string, { id: string; name: string; arguments: string }>();
  for await (const event of streamText("openai-chat-completions", BASE, key(), { model: MODEL, dialect: "deepseek", maxOutputTokens: 800, maxTokensField: "max_tokens", ...request } as TextRequest, runtime) as AsyncIterable<StreamEvent>) {
    if ((event.type === "text-delta" || event.type === "reasoning-delta") && out.firstMs === null) out.firstMs = Date.now() - started;
    if (event.type === "text-delta") out.text += event.text;
    else if (event.type === "reasoning-delta") out.reasoning += event.text;
    else if (event.type === "server-tool") out.server += 1;
    else if (event.type === "tool-call-delta") {
      const call = calls.get(event.callId) ?? { id: event.callId, name: event.name, arguments: "" };
      call.name = event.name || call.name;
      call.arguments += event.argumentsDelta;
      calls.set(event.callId, call);
    } else if (event.type === "completed") {
      out.usage = event.usage as Record<string, unknown> | undefined;
      out.serverToolCalls = event.serverToolCalls;
      out.citations = event.citations?.length ?? 0;
    } else if (event.type === "error") throw Object.assign(new Error(event.message), { code: event.code });
  }
  out.calls = [...calls.values()];
  out.ms = Date.now() - started;
  return out;
}
const shape = (streamed: Streamed) => ({ textChars: streamed.text.length, reasoningChars: streamed.reasoning.length, toolCalls: streamed.calls.length, serverEvents: streamed.server, citations: streamed.citations, ms: streamed.ms, firstMs: streamed.firstMs, inputTokens: streamed.usage?.inputTokens, outputTokens: streamed.usage?.outputTokens, cachedInputTokens: streamed.usage?.cachedInputTokens, searches: streamed.usage?.searches });

/** A 96×64 picture: the left half red, the right half blue, drawn here. */
function syntheticPng(): string {
  const width = 96, height = 64;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) raw.set(x < width / 2 ? [220, 30, 30] : [30, 60, 220], row + 1 + x * 3);
  }
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (bytes: Buffer) => { let c = 0xffffffff; for (const byte of bytes) c = table[(c ^ byte) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const body = Buffer.concat([Buffer.from(type, "ascii"), data]); const out = Buffer.alloc(body.length + 8); out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc(body), body.length + 4); return out; };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

/** 16-bit mono PCM at `rate` wrapped in a WAV header. */
function wav(pcm: Uint8Array, rate: number): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVE", 8); header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(pcm)]));
}

/** How alike two Chinese texts are, by their Han characters only: 1 − edit distance / the longer length. */
function similarity(a: string, b: string): number {
  const x = [...a.replace(/[^\p{Script=Han}]/gu, "")];
  const y = [...b.replace(/[^\p{Script=Han}]/gu, "")];
  if (!x.length && !y.length) return 1;
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= y.length; j += 1) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
    previous = current;
  }
  return 1 - previous[y.length]! / Math.max(x.length, y.length);
}

async function speak(text: string) {
  take();
  const chunks: Uint8Array[] = [];
  const started = Date.now();
  const spoken = await synthesizeDeepSeek(BASE, key(), { text, voice: "stella", timeoutMs: 120_000, onChunk: (pcm) => chunks.push(pcm) });
  return { pcm: new Uint8Array(Buffer.concat(chunks)), ...spoken, ms: Date.now() - started };
}

const LOOKUP = { name: "lookup", description: "Look up one fact about a fictional character by step number. Call it for step 1, then 2, then 3, one call per reply, before answering.", parameters: { type: "object", properties: { step: { type: "integer" } }, required: ["step"] } };
const SENTENCE = "星穹航路的灯塔在黄昏时亮起，守夜人把航线记在一本旧册子上。";
const LONG = "海风吹过安静的港口，渔船一艘接着一艘回到码头。老船长坐在石阶上，慢慢讲起年轻时在远洋遇到的风暴与星光。孩子们围在他身边，听得忘了时间。".repeat(16);

describe.skipIf(!enabled)("DeepSeek, the real service", () => {
  it("answers as the plugin expects, within the request budget", { timeout: 900_000 }, async () => {
    // (1) The catalogue.
    take();
    const listed = await fetch(`${BASE}/models`, { headers: { authorization: `Bearer ${key()}` } });
    const ids = ((await listed.json()) as { data?: Array<{ id: string }> }).data?.map((item) => item.id) ?? [];
    const declared = (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../plugins/provider-deepseek/provider.json"), "utf8")) as { models: Array<{ id: string }> }).models.map((model) => model.id);
    record("models", listed.status === 200 ? "ok" : "failed", { status: listed.status, count: ids.length, declaredListed: declared.filter((id) => ids.includes(id)), declaredMissing: declared.filter((id) => !ids.includes(id)) });
    expect(listed.status).toBe(200);

    // (2) A plain answer with thinking off.
    const plain = await chat({ messages: [{ role: "user", content: "用一句话介绍一个虚构的城市“雾湾”。" }] });
    record("chat-thinking-off", "ok", shape(plain));
    expect(plain.text.length).toBeGreaterThan(0);
    expect(plain.reasoning).toBe("");

    // (3) A three-step tool loop with thinking on, on both runtimes; then a new user turn without the earlier thinking.
    for (const runtime of ["native", "pi"] as const) {
      const messages: ChatMessage[] = [
        { role: "system", content: "Use the lookup tool for steps 1, 2 and 3 in order, one call per reply, then answer in one sentence." },
        { role: "user", content: "Tell me about the fictional character Aria Velk." },
      ];
      const steps: Array<Record<string, unknown>> = [];
      let final: Streamed | null = null;
      for (let step = 0; step < 4; step += 1) {
        const streamed = await chat({ messages, tools: [LOOKUP], reasoningEffort: "high" }, runtime);
        steps.push(shape(streamed));
        if (!streamed.calls.length) { final = streamed; break; }
        streamed.calls.forEach((call, index) => {
          messages.push({ role: "assistant", content: index === 0 ? streamed.text : "", reasoning: index === 0 ? streamed.reasoning : "", toolCalls: [call] });
          messages.push({ role: "tool", toolCallId: call.id, content: `fact ${call.arguments}` });
        });
      }
      record(`tool-loop-${runtime}`, final ? "ok" : "failed", { steps });
      expect(final?.text.length ?? 0).toBeGreaterThan(0);
      if (runtime === "native") {
        // The next user turn sends the earlier assistant messages without their thinking (计划 4.3): the service must take it.
        const next = [...messages.map((message) => ({ ...message, reasoning: undefined })), { role: "assistant" as const, content: final!.text }, { role: "user" as const, content: "再用一句话总结。" }];
        const again = await chat({ messages: next, tools: [LOOKUP], reasoningEffort: "high" });
        record("next-turn-without-reasoning", "ok", shape(again));
      }
    }

    // (4) A drawn picture.
    const seen = await chat({ messages: [{ role: "user", content: "这张图左右两半分别是什么颜色？只回答两个颜色。", images: [{ mediaType: "image/png", base64: syntheticPng() }] }] });
    record("vision", /红/.test(seen.text) && /蓝/.test(seen.text) ? "ok" : "failed", { ...shape(seen), colours: /红/.test(seen.text) && /蓝/.test(seen.text) });

    // (5) The service's own search beside a function tool; the next round sends its server tool calls back.
    const searchMessages: ChatMessage[] = [{ role: "user", content: "请务必先联网搜索：DeepSeek 官方网站首页现在的标题是什么？用一句话回答，并说明来源网站。" }];
    const searched = await chat({ messages: searchMessages, tools: [LOOKUP], reasoningEffort: "low", nativeWebSearch: true });
    record("native-search", searched.server > 0 ? "ok" : "failed", { ...shape(searched), serverToolCalls: searched.serverToolCalls?.length ?? 0 });
    if (searched.serverToolCalls?.length) {
      const follow = await chat({ messages: [...searchMessages, { role: "assistant", content: searched.text, reasoning: searched.reasoning, serverToolCalls: searched.serverToolCalls }, { role: "user", content: "刚才的来源是哪个网站？" }], reasoningEffort: "low", nativeWebSearch: true });
      record("native-search-passback", "ok", shape(follow));
    }

    // (6) The highest level once.
    const max = await chat({ messages: [{ role: "user", content: "17 × 23 等于多少？只回答数字。" }], reasoningEffort: "max" });
    record("effort-max", /391/.test(max.text) ? "ok" : "failed", shape(max));

    // (7) A sentence spoken and recognised back.
    const short = await speak(SENTENCE);
    take();
    const heard = await transcribeDeepSeek(BASE, key(), { bytes: wav(short.pcm, 24_000), fileName: "sentence.wav", mimeType: "audio/wav", timeoutMs: 120_000 });
    const roundTrip = similarity(SENTENCE, heard.text);
    record("speech-round-trip", roundTrip >= 0.8 ? "ok" : "failed", { billedChars: short.billedChars, expectedBilled: speechBilledChars(SENTENCE), pcmBytes: short.pcm.length, firstChunkMs: short.firstChunkMs, ms: short.ms, similarity: Number(roundTrip.toFixed(3)), durationMs: heard.durationMs });

    // (8) About 2,000 billed characters, streamed; (9) about 100 s of it recognised in one block.
    const long = await speak(LONG);
    const seconds = long.pcm.length / 48_000;
    record("speech-long", long.firstChunkMs !== null ? "ok" : "failed", { billedChars: long.billedChars, firstChunkMs: long.firstChunkMs, ms: long.ms, seconds: Number(seconds.toFixed(1)) });
    const hundred = long.pcm.subarray(0, Math.min(long.pcm.length, 100 * 48_000));
    take();
    const block = await transcribeDeepSeek(BASE, key(), { bytes: wav(hundred, 24_000), fileName: "long.wav", mimeType: "audio/wav", timeoutMs: 180_000 });
    record("asr-100s", block.text.length > 0 ? "ok" : "failed", { seconds: Number((hundred.length / 48_000).toFixed(1)), wavBytes: hundred.length + 44, textChars: block.text.length, durationMs: block.durationMs, similarity: Number(similarity(LONG.slice(0, block.text.length + 20), block.text).toFixed(3)) });

    // (10) Two web searches.
    for (const query of ["虚构城市 雾湾", "灯塔 守夜人 历史"]) {
      take();
      const started = Date.now();
      const found = await searchDeepSeek(BASE, key(), { query, count: 3, timeoutMs: 30_000 });
      record("web-search", "ok", { results: found.results.length, truncated: found.truncated, ms: Date.now() - started, fields: Object.keys(found.results[0] ?? {}).sort() });
    }

    // (11) Failures: a wrong key, a model that is not there, an empty text to speak.
    take();
    const wrongKey = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: { authorization: "Bearer sk-wrong-synthetic", "content-type": "application/json" }, body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 8 }) });
    take();
    const noModel = await fetch(`${BASE}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key()}`, "content-type": "application/json" }, body: JSON.stringify({ model: "deepseek-does-not-exist", messages: [{ role: "user", content: "hi" }], max_tokens: 8 }) });
    take();
    const empty = await fetch(`${BASE}/v1/tools/tts`, { method: "POST", headers: { authorization: `Bearer ${key()}`, "content-type": "application/json" }, body: JSON.stringify({ text: "", voice_id: "stella", format: "pcm" }) });
    record("errors", "ok", { wrongKey: wrongKey.status, noModel: noModel.status, emptySpeech: empty.status });
    expect(wrongKey.status).toBe(401);
    expect([400, 404, 422]).toContain(noModel.status);
    expect([400, 422]).toContain(empty.status);
  });

  it("installs the bundled DeepSeek plugin in MangaProductApp, discovers and adds models, reopens the profile, and passes connection probes", { timeout: 300_000 }, async () => {
    const first = makeKey("MANGA（第一方，实测）");
    const bundledDir = tmpDir();
    const manifest = (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../plugins/provider-deepseek/plugin.json"), "utf8")) as { manifest: unknown }).manifest;
    const providerJson = fs.readFileSync(path.join(import.meta.dirname, "../../plugins/provider-deepseek/provider.json"), "utf8");
    fs.writeFileSync(path.join(bundledDir, "manga.provider-deepseek.manga-plugin"), buildPluginPackage({ manifest, files: { "provider.json": providerJson }, privateKeyPem: first.privateKeyPem }));
    const profileRoot = tempProfile();
    let seq = 0;
    const callApp = async <T = Record<string, unknown>>(ctx: Awaited<ReturnType<typeof startApp>>, commandId: string, input: Record<string, unknown> = {}): Promise<T> => {
      seq += 1;
      const res = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: `real-app-${seq}`, input }, ctx.grant.handle);
      if (res.status !== "ok") throw new Error(scrub(`${commandId} failed: ${JSON.stringify(res.error)}`));
      return res.value as T;
    };

    // 1. Install bundled plugin, discover live models, and add models + services with zero testOrigin or lookup overrides.
    const ctx = await startApp({ profileRoot, options: { plugins: { firstPartyKeys: [{ publicKey: first.publicKey, label: first.label }], bundledDir } } });
    try {
      await callApp(ctx, "plugin.install", { bundledId: "manga.provider-deepseek", grant: ["network"], enable: true });
      take(1);
      const discovered = await callApp<{ ok: boolean; verified: boolean; models: Array<{ id: string; listed: boolean }> }>(ctx, "providers.discover", {
        providerRef: "manga.provider-deepseek/deepseek",
        credentialHandle: ctx.app.stashSecret(key()),
      });
      expect(discovered.ok).toBe(true);
      expect(discovered.verified).toBe(true);
      take(1);
      const added = await callApp<{ accountId: string; verified: boolean; connections: Array<{ id: string; purpose: string; modelId: string }> }>(ctx, "providers.add", {
        providerRef: "manga.provider-deepseek/deepseek",
        credentialHandle: ctx.app.stashSecret(key()),
        models: ["deepseek-flash", "deepseek-v4-pro"],
        services: ["transcription", "speech", "search"],
        verified: true,
      });
      expect(added.verified).toBe(true);
      expect(added.connections).toHaveLength(5);
      record("product-app-discover-add", "ok", { verified: added.verified, discoveredIds: discovered.models.filter((m) => m.listed).map((m) => m.id), connections: added.connections.length });
    } finally {
      ctx.app.close();
    }

    // 2. Reopen MangaProductApp on the same profileRoot, verify provider remains enabled, and probe/test connections.
    const reopened = await startApp({ profileRoot, options: { plugins: { firstPartyKeys: [{ publicKey: first.publicKey, label: first.label }], bundledDir } } });
    try {
      const providers = await callApp<{ providers: Array<{ ref: string }>; accounts: Array<{ available: boolean }> }>(reopened, "providers.list");
      expect(providers.providers.map((item) => item.ref)).toEqual(["manga.provider-deepseek/deepseek"]);
      expect(providers.accounts[0]?.available).toBe(true);

      const rows = await callApp<Array<{ id: string; purpose: string; providerModel: string | null }>>(reopened, "connections.list");
      const flash = rows.find((row) => row.providerModel === "deepseek-flash")!;
      take(4);
      const probed = await callApp<{ ok: boolean; latencyMs?: number; capabilities?: string[]; detected?: { contextWindow?: number; maxOutput?: number }; failure?: unknown }>(reopened, "connections.probe", { connectionId: flash.id });
      record("product-app-probe-flash", probed.ok ? "ok" : "failed", { ok: probed.ok, latencyMs: probed.latencyMs, capabilities: probed.capabilities, detected: probed.detected, failure: probed.failure });
      expect(probed.ok).toBe(true);
      expect(probed.capabilities).toEqual(expect.arrayContaining(["streaming", "tools", "vision"]));

      for (const service of ["transcription", "speech", "search"] as const) {
        const conn = rows.find((row) => row.purpose === service)!;
        take(1);
        const tested = await callApp<{ ok: boolean; latencyMs?: number; failure?: unknown }>(reopened, "connections.test", { connectionId: conn.id, capability: service });
        record(`product-app-test-${service}`, tested.ok ? "ok" : "failed", { ok: tested.ok, latencyMs: tested.latencyMs, failure: tested.failure });
        expect(tested.ok).toBe(true);
      }
    } finally {
      reopened.app.close();
    }
  });

  it("runs conversations in MangaProductApp with every agent tool offered, on the model, thinking and window chosen (A-137)", { timeout: 300_000 }, async () => {
    // The product's whole tool list goes out with each request; its command ids have dots, which the service refuses unless they are renamed (2026-11-16).
    const first = makeKey("MANGA（第一方，实测）");
    const bundledDir = tmpDir();
    const manifest = (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../plugins/provider-deepseek/plugin.json"), "utf8")) as { manifest: unknown }).manifest;
    const providerJson = fs.readFileSync(path.join(import.meta.dirname, "../../plugins/provider-deepseek/provider.json"), "utf8");
    fs.writeFileSync(path.join(bundledDir, "manga.provider-deepseek.manga-plugin"), buildPluginPackage({ manifest, files: { "provider.json": providerJson }, privateKeyPem: first.privateKeyPem }));
    const ctx = await startApp({ profileRoot: tempProfile(), options: { plugins: { firstPartyKeys: [{ publicKey: first.publicKey, label: first.label }], bundledDir } } });
    let seq = 0;
    const callApp = async <T = Record<string, unknown>>(commandId: string, input: Record<string, unknown> = {}): Promise<T> => {
      seq += 1;
      const res = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: `real-run-${seq}`, input }, ctx.grant.handle);
      if (res.status !== "ok") throw new Error(scrub(`${commandId} failed: ${JSON.stringify(res.error)}`));
      return res.value as T;
    };
    try {
      await callApp("plugin.install", { bundledId: "manga.provider-deepseek", grant: ["network"], enable: true });
      // Added without reading the list (the catalogue is enough here): no request.
      const added = await callApp<{ connections: Array<{ id: string; purpose: string; modelId: string }> }>("providers.add", {
        providerRef: "manga.provider-deepseek/deepseek", credentialHandle: ctx.app.stashSecret(key()), models: ["deepseek-flash", "deepseek-v4-pro"], services: [], verified: false,
      });
      const byModel = new Map(added.connections.map((item) => [item.modelId, item.id]));
      const sessionId = (await callApp<{ id: string }>("agent.createSession", { title: "实测" })).id;
      const runs: Array<Record<string, unknown>> = [];
      for (const [model, chat] of [
        ["deepseek-flash", { reasoningEffort: null, contextWindow: null }],
        ["deepseek-v4-pro", { reasoningEffort: "max", contextWindow: 131_072 }],
        ["deepseek-flash", { reasoningEffort: "off", contextWindow: null }],
      ] as const) {
        await callApp("settings.setAgent", { chat: { connectionId: byModel.get(model), ...chat } });
        take(2);
        const sent = await callApp<{ runId: string }>("agent.send", { sessionId, text: "用一句话回答：雾湾是一座虚构的海港城市吗？不需要使用任何工具。" });
        const done = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, sent.runId, 120_000);
        const status = String(done.value?.status ?? done.value?.run?.status);
        const steps = ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM agent_requests WHERE run_id = ? AND kind = 'model'").get(sent.runId) as { n: number };
        const error = (ctx.app.store.sqlite.prepare("SELECT error_json FROM agent_runs WHERE id = ?").get(sent.runId) as { error_json: string | null }).error_json;
        const budget = JSON.parse((ctx.app.store.sqlite.prepare("SELECT budget_json FROM agent_runs WHERE id = ?").get(sent.runId) as { budget_json: string }).budget_json) as { contextWindow: number };
        runs.push({ model, ...chat, status, modelRequests: steps.n, contextWindow: budget.contextWindow, error });
        expect(status, scrub(String(error))).toBe("succeeded");
        expect(budget.contextWindow).toBe(chat.contextWindow ?? 1_048_576);
      }
      record("product-app-agent-runs", "ok", { runs });
    } finally {
      ctx.app.close();
    }
  });
});

afterAll(() => {
  if (!enabled) return;
  const out = path.join(import.meta.dirname, "../../.local/deepseek-contract.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, scrub(`${JSON.stringify({ at: new Date().toISOString(), requests: used, results }, null, 2)}\n`));
});
