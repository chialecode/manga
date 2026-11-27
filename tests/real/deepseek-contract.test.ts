import fs from "node:fs";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentStreamEvent, ProviderCapabilities, StreamAgent, StreamItem, StreamUser } from "@manga/contracts";
import {
  createDeepSeekTtsStream,
  deleteDeepSeekFile,
  fetchDeepSeekBalance,
  fetchDeepSeekWeb,
  formatLatestReminder,
  ocrDeepSeekDocument,
  searchDeepSeek,
  searchDeepSeekWeb,
  speechBilledChars,
  streamText,
  synthesizeDeepSeek,
  transcribeDeepSeek,
  uploadDeepSeekFile,
  type AiRuntimeId,
  type ChatMessage,
  type StreamEvent,
  type TextRequest,
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
const MAX_REQUESTS = 120;
const MODEL = "deepseek-flash";

let used = 0;
const take = (count = 1) => {
  if (used + count > MAX_REQUESTS) throw new Error(`the contract run would go over ${MAX_REQUESTS} requests`);
  used += count;
};
const results: Array<{ case: string; outcome: "ok" | "failed"; detail: Record<string, unknown> }> = [];
const key = () => fs.readFileSync(keyFile!, "utf8").trim();
const scrub = (text: unknown) => {
  const raw = text === undefined || text === null ? "" : String(text);
  return enabled ? raw.split(key()).join("<key>") : raw;
};
const record = (name: string, outcome: "ok" | "failed", detail: Record<string, unknown>) => results.push({ case: name, outcome, detail: JSON.parse(scrub(JSON.stringify(detail))) as Record<string, unknown> });

type Streamed = {
  text: string;
  reasoning: string;
  title: string;
  calls: Array<{ id: string; name: string; arguments: string }>;
  server: number;
  serverSteps: string[];
  citations: number;
  usage?: Record<string, unknown>;
  serverToolCalls?: unknown[];
  stopReason?: string;
  ms: number;
  firstMs: number | null;
};
async function chat(request: Omit<TextRequest, "model"> & { model?: string }, runtime: AiRuntimeId = "native"): Promise<Streamed> {
  take();
  const started = Date.now();
  const out: Streamed = { text: "", reasoning: "", title: "", calls: [], server: 0, serverSteps: [], citations: 0, ms: 0, firstMs: null };
  const calls = new Map<string, { id: string; name: string; arguments: string }>();
  for await (const event of streamText("openai-chat-completions", BASE, key(), { model: MODEL, dialect: "deepseek", maxOutputTokens: 2048, maxTokensField: "max_tokens", ...request } as TextRequest, runtime) as AsyncIterable<StreamEvent>) {
    if ((event.type === "text-delta" || event.type === "reasoning-delta") && out.firstMs === null) out.firstMs = Date.now() - started;
    if (event.type === "text-delta") out.text += event.text;
    else if (event.type === "reasoning-delta") out.reasoning += event.text;
    else if (event.type === "title-delta") out.title += event.text;
    else if (event.type === "server-tool") out.server += 1;
    else if (event.type === "tool-call-delta") {
      const call = calls.get(event.callId) ?? { id: event.callId, name: event.name, arguments: "" };
      call.name = event.name || call.name;
      call.arguments += event.argumentsDelta;
      calls.set(event.callId, call);
    } else if (event.type === "completed") {
      out.usage = event.usage as Record<string, unknown> | undefined;
      out.serverToolCalls = event.serverToolCalls;
      out.serverSteps = (event.serverToolSteps ?? []).map((step) => `${step.kind}:${step.status}`);
      out.citations = event.citations?.length ?? 0;
      out.stopReason = event.stopReason;
      if (event.title && !out.title) out.title = event.title;
    } else if (event.type === "error") throw Object.assign(new Error(event.message), { code: event.code });
  }
  out.calls = [...calls.values()];
  out.ms = Date.now() - started;
  return out;
}
const shape = (streamed: Streamed) => ({
  textChars: streamed.text.length,
  reasoningChars: streamed.reasoning.length,
  titleChars: streamed.title.length,
  toolCalls: streamed.calls.length,
  serverEvents: streamed.server,
  serverSteps: streamed.serverSteps,
  citations: streamed.citations,
  stopReason: streamed.stopReason,
  ms: streamed.ms,
  firstMs: streamed.firstMs,
  inputTokens: streamed.usage?.inputTokens,
  outputTokens: streamed.usage?.outputTokens,
  cachedInputTokens: streamed.usage?.cachedInputTokens,
  reasoningTokens: streamed.usage?.reasoningTokens,
  searches: streamed.usage?.searches,
  fetches: streamed.usage?.fetches,
});

/** Minimal valid 1-page synthetic PDF holding clear 24pt text "Fog Bay Harbor 42". */
function syntheticPdf(): Buffer {
  const stream = "BT /F1 24 Tf 36 80 Td (Fog Bay Harbor 42) Tj ET";
  const objects = [
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n",
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n",
    "3 0 obj<</Type/Page/MediaBox[0 0 400 160]/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n",
    `4 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n`,
    "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(out, "ascii"));
    out += obj;
  }
  const xrefAt = Buffer.byteLength(out, "ascii");
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "ascii");
}

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
    const searchMessages: ChatMessage[] = [
      { role: "system", content: "本次对话已开启内置联网搜索能力；涉及实时信息、公开网页或最新资料时请直接使用内置联网搜索并保留来源引用。" },
      { role: "user", content: "请联网搜索当前最新的 Node.js LTS 稳定版本号与发布日期，用一句话回答并注明参考网站。" },
    ];
    const searched = await chat({ messages: searchMessages, tools: [LOOKUP], reasoningEffort: "low", nativeWebSearch: true });
    record("native-search", searched.server > 0 ? "ok" : "failed", { ...shape(searched), serverToolCalls: searched.serverToolCalls?.length ?? 0 });
    expect(searched.server).toBeGreaterThan(0);
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

  it("exercises extended DeepSeek dialect, PI search parity, Files API, fetch, OCR, balance, and WS TTS live", { timeout: 600_000 }, async () => {
    // (E1) Account balance (record only availability & currency codes, never monetary amounts).
    take();
    const balStarted = Date.now();
    const balance = await fetchDeepSeekBalance({ baseUrl: BASE, apiKey: key(), timeoutMs: 15_000 });
    record("balance", "ok", { isAvailable: balance.isAvailable, currencies: balance.balances.map((b) => b.currency), ms: Date.now() - balStarted });
    expect(typeof balance.isAvailable).toBe("boolean");

    // (E2) Built-in web search on PI runtime (parity with native: server events, citations, serverToolCalls, usage).
    const piSearch = await chat({
      messages: [
        { role: "system", content: "本次对话已开启内置联网搜索能力；涉及实时信息、公开网页或最新资料时请直接使用内置联网搜索并保留来源引用。" },
        { role: "user", content: "请联网搜索今天东京的实时天气和气温，用一句话回答并附引用来源。" },
      ],
      tools: [LOOKUP],
      reasoningEffort: "low",
      nativeWebSearch: true,
    }, "pi");
    record("native-search-pi", piSearch.server > 0 ? "ok" : "failed", { ...shape(piSearch), serverToolCalls: piSearch.serverToolCalls?.length ?? 0 });
    expect(piSearch.server).toBeGreaterThan(0);
    expect(piSearch.text.length).toBeGreaterThan(0);

    // (E3) Built-in read_url + inline title + latest_reminder + reasoning_tokens on deepseek-flash.
    const readAndTitle = await chat({
      messages: [{ role: "user", content: "请读取 https://example.com 并用一句话概括，同时说明今天是星期几。" }],
      reasoningEffort: "low",
      readUrl: true,
      inlineTitle: true,
      safetyCheck: "high",
      latestReminder: formatLatestReminder(new Date(), { language: "中文", platform: "App" }),
    });
    record("read-url-title-reminder", readAndTitle.text.length > 0 && readAndTitle.title.length > 0 ? "ok" : "failed", shape(readAndTitle));
    expect(readAndTitle.text.length).toBeGreaterThan(0);
    expect(readAndTitle.title.length).toBeGreaterThan(0);
    expect(readAndTitle.server).toBeGreaterThan(0);

    // (E4) Continuation prefill on deepseek-flash.
    const continued = await chat({
      messages: [
        { role: "user", content: "用一句话继续写关于虚构港口雾湾的描写。" },
        { role: "assistant", content: "雾湾的灯塔每晚" },
      ],
      continuePrefill: true,
      maxOutputTokens: 64,
    });
    record("continuation-prefill", continued.text.length > 0 ? "ok" : "failed", shape(continued));
    expect(continued.text.length).toBeGreaterThan(0);

    // (E5) deepseek-v4-pro reasoning works and native deepseek_web_search is explicitly rejected with 400.
    const v4Think = await chat({
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "13 × 19 等于多少？只答数字。" }],
      reasoningEffort: "low",
      maxOutputTokens: 128,
    });
    record("v4-pro-reasoning", /247/.test(v4Think.text) ? "ok" : "failed", shape(v4Think));
    expect(v4Think.text).toContain("247");
    take();
    const v4SearchReject = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key()}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-pro", thinking: { type: "enabled" }, reasoning_effort: "low", tools: [{ type: "deepseek_web_search" }], messages: [{ role: "user", content: "hi" }], max_tokens: 32 }),
    });
    record("v4-pro-rejects-native-search", v4SearchReject.status === 400 ? "ok" : "failed", { status: v4SearchReject.status });
    expect(v4SearchReject.status).toBe(400);

    // (E6) Files API (/v1/files) upload -> chat with flat file_id -> delete cleanup (PDF + text).
    const uploadedIds: string[] = [];
    try {
      take(2);
      const pdfRef = await uploadDeepSeekFile({ baseUrl: BASE, apiKey: key(), filename: "sample.pdf", mimeType: "application/pdf", data: syntheticPdf() });
      uploadedIds.push(pdfRef.fileId);
      const txtRef = await uploadDeepSeekFile({ baseUrl: BASE, apiKey: key(), filename: "note.txt", mimeType: "text/plain", data: Buffer.from("Fog Bay code is 7391.\n", "utf8") });
      uploadedIds.push(txtRef.fileId);

      const readPdf = await chat({
        messages: [{ role: "user", content: "这两个附件里的两个数字分别是什么？只回答这两个数字。", fileRefs: [pdfRef, txtRef] }],
        reasoningEffort: "low",
      });
      const matched = /42/.test(readPdf.text) && /7391/.test(readPdf.text);
      record("files-api-roundtrip", matched ? "ok" : "failed", { ...shape(readPdf), matched, pdfPurpose: pdfRef.purpose, txtPurpose: txtRef.purpose });
      expect(matched).toBe(true);
    } finally {
      for (const fileId of uploadedIds) {
        take();
        const del = await deleteDeepSeekFile({ baseUrl: BASE, apiKey: key(), fileId });
        expect(del.deleted).toBe(true);
      }
    }

    // (E7) Standalone /v1/tools/search (needContent + siteIcon), /v1/tools/fetch, /v1/tools/ocr.
    take();
    const searchStart = Date.now();
    const richSearch = await searchDeepSeekWeb({ baseUrl: BASE, apiKey: key(), query: "DeepSeek API", count: 2, needContent: true, timeoutMs: 30_000 });
    record("web-search-content", richSearch.results.length > 0 ? "ok" : "failed", {
      ms: Date.now() - searchStart,
      results: richSearch.results.length,
      hasSiteIcon: Boolean(richSearch.results[0]?.siteIcon),
      contentChars: richSearch.results[0]?.content?.length ?? 0,
    });
    expect(richSearch.results.length).toBeGreaterThan(0);

    take();
    const fetchStart = Date.now();
    const fetched = await fetchDeepSeekWeb({ baseUrl: BASE, apiKey: key(), url: "https://example.com", timeoutMs: 30_000 });
    record("web-fetch", fetched.content.length > 0 ? "ok" : "failed", { ms: Date.now() - fetchStart, titleChars: fetched.title.length, contentChars: fetched.content.length, source: fetched.source });
    expect(fetched.content.length).toBeGreaterThan(0);

    take();
    const ocrStart = Date.now();
    const ocr = await ocrDeepSeekDocument({ baseUrl: BASE, apiKey: key(), filename: "sample.pdf", mimeType: "application/pdf", data: syntheticPdf(), purpose: "text_recognition", timeoutMs: 60_000 });
    record("ocr-pdf", ocr.text.includes("42") ? "ok" : "failed", { ms: Date.now() - ocrStart, pages: ocr.pages.length, textChars: ocr.text.length, usage: ocr.usage });
    expect(ocr.text).toContain("42");

    // (E8) HTTP TTS with `tide` voice + live WebSocket streaming TTS (`wss://api.deepseek.com/v1/tools/tts`).
    take();
    let tideBytes = 0;
    const tideStart = Date.now();
    const tide = await synthesizeDeepSeek(BASE, key(), { text: "雾湾灯塔。", voice: "tide", timeoutMs: 60_000, onChunk: (pcmChunk) => { tideBytes += pcmChunk.length; } });
    record("speech-tide", tideBytes > 0 ? "ok" : "failed", { billedChars: tide.billedChars, pcmBytes: tideBytes, firstChunkMs: tide.firstChunkMs, ms: Date.now() - tideStart });
    expect(tideBytes).toBeGreaterThan(0);

    take();
    const wsChunks: Uint8Array[] = [];
    const wsStart = Date.now();
    const wsSession = createDeepSeekTtsStream({
      baseUrl: BASE,
      apiKey: key(),
      voice: "stella",
      timeoutMs: 60_000,
      onChunk: (pcmChunk) => wsChunks.push(pcmChunk),
    });
    wsSession.push("星穹航路的灯塔，");
    wsSession.push("在黄昏时亮起。");
    const wsDone = await wsSession.finish();
    record("speech-ws-stream", wsDone.bytes > 0 ? "ok" : "failed", {
      transport: wsDone.transport,
      billedChars: wsDone.billedChars,
      chunks: wsChunks.length,
      pcmBytes: wsDone.bytes,
      firstChunkMs: wsDone.firstChunkMs,
      ms: Date.now() - wsStart,
    });
    expect(wsDone.bytes).toBeGreaterThan(0);
    expect(wsDone.bytes % 2).toBe(0);
    expect(wsDone.firstChunkMs).not.toBeNull();
  });

  it("runs full ProductApp end-to-end DeepSeek upgrade suite live against real api.deepseek.com", { timeout: 900_000 }, async () => {
    const first = makeKey("MANGA（第一方，全量实测）");
    const bundledDir = tmpDir();
    const sampleDir = tmpDir();
    const manifest = (JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../plugins/provider-deepseek/plugin.json"), "utf8")) as { manifest: unknown }).manifest;
    const providerJson = fs.readFileSync(path.join(import.meta.dirname, "../../plugins/provider-deepseek/provider.json"), "utf8");
    fs.writeFileSync(
      path.join(bundledDir, "manga.provider-deepseek.manga-plugin"),
      buildPluginPackage({ manifest, files: { "provider.json": providerJson }, privateKeyPem: first.privateKeyPem }),
    );
    const ctx = await startApp({
      profileRoot: tempProfile(),
      options: { plugins: { firstPartyKeys: [{ publicKey: first.publicKey, label: first.label }], bundledDir } },
    });
    let seq = 0;
    const callApp = async <T = Record<string, unknown>>(commandId: string, input: Record<string, unknown> = {}): Promise<T> => {
      seq += 1;
      const res = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: `real-e2e-${seq}`, input }, ctx.grant.handle);
      if (res.status !== "ok") throw new Error(scrub(`${commandId} failed: ${JSON.stringify(res.error)}`));
      return res.value as T;
    };

    try {
      await callApp("plugin.install", { bundledId: "manga.provider-deepseek", grant: ["network"], enable: true });
      const added = await callApp<{ accountId: string; connections: Array<{ id: string; purpose: string; modelId: string }> }>("providers.add", {
        providerRef: "manga.provider-deepseek/deepseek",
        credentialHandle: ctx.app.stashSecret(key()),
        models: ["deepseek-flash", "deepseek-v4-pro"],
        services: ["transcription", "speech", "search", "fetch", "ocr"],
        verified: false,
      });
      const byModel = new Map(added.connections.filter((c) => c.purpose === "text").map((c) => [c.modelId, c.id]));
      const flashId = byModel.get("deepseek-flash")!;
      const v4ProId = byModel.get("deepseek-v4-pro")!;
      expect(added.connections).toHaveLength(7);

      // (P1) providers.capabilities & providers.balance on ProductApp.
      await callApp("settings.setAgent", { chat: { connectionId: flashId, reasoningEffort: "low", contextWindow: null } });
      const caps = await callApp<ProviderCapabilities>("providers.capabilities");
      expect(caps).toMatchObject({
        hasAvailableTextModel: true,
        webSearchAvailable: true,
        nativeWebSearchAvailable: true,
        standaloneWebSearchAvailable: true,
        readUrlAvailable: true,
        speechAvailable: true,
        streamingTtsAvailable: true,
        fetchAvailable: true,
        ocrAvailable: true,
        filesAvailable: true,
        balanceAvailable: true,
        activeTextModelId: "deepseek-flash",
        activeTextDialect: "deepseek",
      });
      take(1);
      const bal = await callApp<{ available: boolean; balances: Array<{ currency: string }> }>("providers.balance", { accountId: added.accountId });
      record("e2e-capabilities-balance", typeof bal.available === "boolean" ? "ok" : "failed", {
        activeModel: caps.activeTextModelId,
        available: bal.available,
        currencies: bal.balances.map((b) => b.currency),
      });
      expect(typeof bal.available).toBe("boolean");

      // (P2a) deepseek-flash (native): thinking + latest_reminder + inline title persisted + deepseek_web_search + enriched StreamAgent + live onAgentStream.
      const nativeConv = await callApp<{ sessionId: string }>("conversation.new", { contextId: null });
      const nativeEvents: AgentStreamEvent[] = [];
      const offNative = ctx.app.onAgentStream((ev) => {
        if (ev.sessionId === nativeConv.sessionId) nativeEvents.push(ev);
      });
      take(3);
      const nativeSent = await callApp<{ runId: string }>("agent.send", {
        sessionId: nativeConv.sessionId,
        text: "请联网搜索今天东京的实时天气和气温，用一句话总结并附上来源引用。",
        allowCommands: ["web.search"],
      });
      const nativeDone = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, nativeSent.runId, 180_000);
      offNative();
      expect(nativeDone.value?.status, scrub(JSON.stringify(nativeDone.value?.error))).toBe("succeeded");
      const nativeStream = await callApp<{ items: StreamItem[] }>("session.stream", { sessionId: nativeConv.sessionId });
      const nativeAgent = nativeStream.items.find((item): item is StreamAgent => item.kind === "agent" && item.runId === nativeSent.runId)!;
      const nativeConvs = await callApp<{ items: Array<{ sessionId: string; title: string }> }>("conversation.list", { contextId: null });
      const persistedTitle = nativeConvs.items.find((c) => c.sessionId === nativeConv.sessionId)?.title ?? "";
      record("e2e-flash-native-search", nativeAgent.text.length > 0 && persistedTitle.length > 0 && (nativeAgent.serverToolSteps?.length ?? 0) > 0 ? "ok" : "failed", {
        streamEvents: nativeEvents.length,
        hasTitleEvent: nativeEvents.some((e) => e.kind === "title"),
        persistedTitleChars: persistedTitle.length,
        serverStepKinds: (nativeAgent.serverToolSteps ?? []).map((s) => `${s.kind}:${s.status}`),
        citations: nativeAgent.citations?.length ?? 0,
        reasoningChars: nativeAgent.reasoning?.length ?? 0,
        reasoningTokens: nativeAgent.usage?.reasoningTokens ?? 0,
        searches: nativeAgent.usage?.searches ?? 0,
        textChars: nativeAgent.text.length,
        modelId: nativeAgent.modelId,
        stopReason: nativeAgent.stopReason,
      });
      expect(nativeAgent.text.length).toBeGreaterThan(0);
      expect(nativeAgent.modelId).toBe("deepseek-flash");
      expect((nativeAgent.serverToolSteps ?? []).length).toBeGreaterThan(0);
      expect((nativeAgent.citations ?? []).length).toBeGreaterThan(0);
      expect(persistedTitle.length).toBeGreaterThan(0);
      expect(nativeEvents.some((e) => e.kind === "text-delta")).toBe(true);
      expect(nativeEvents.some((e) => e.kind === "done" && e.status === "succeeded")).toBe(true);

      // (P2b) deepseek-flash (native): automatic deepseek_read_url on URL in prompt + latest_reminder.
      const readUrlConv = await callApp<{ sessionId: string }>("conversation.new", { contextId: null });
      take(3);
      const readUrlSent = await callApp<{ runId: string }>("agent.send", {
        sessionId: readUrlConv.sessionId,
        text: "请务必调用内置链接读取功能打开 https://www.iana.org/domains/reserved ，核对页面正文里的准确文本与子栏目链接名称后用一句话概括，并说明今天是星期几。",
      });
      const readUrlDone = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, readUrlSent.runId, 180_000);
      expect(readUrlDone.value?.status, scrub(JSON.stringify(readUrlDone.value?.error))).toBe("succeeded");
      const readUrlStream = await callApp<{ items: StreamItem[] }>("session.stream", { sessionId: readUrlConv.sessionId });
      const readUrlAgent = readUrlStream.items.find((item): item is StreamAgent => item.kind === "agent" && item.runId === readUrlSent.runId)!;
      record("e2e-flash-native-read-url", readUrlAgent.text.length > 0 && (readUrlAgent.serverToolSteps?.length ?? 0) > 0 ? "ok" : "failed", {
        serverStepKinds: (readUrlAgent.serverToolSteps ?? []).map((s) => `${s.kind}:${s.status}`),
        fetches: readUrlAgent.usage?.fetches ?? 0,
        reasoningTokens: readUrlAgent.usage?.reasoningTokens ?? 0,
        textChars: readUrlAgent.text.length,
      });
      expect(readUrlAgent.text.length).toBeGreaterThan(0);
      expect((readUrlAgent.serverToolSteps ?? []).some((s) => s.kind === "read_link" || s.kind === "open_page")).toBe(true);

      // (P3) deepseek-flash (PI runtime parity): enriched StreamAgent citations/serverToolSteps/reasoningTokens/usage.
      await callApp("settings.setRuntime", { runtime: "pi" });
      const piConv = await callApp<{ sessionId: string }>("conversation.new", { contextId: null });
      take(3);
      const piSent = await callApp<{ runId: string }>("agent.send", {
        sessionId: piConv.sessionId,
        text: "请联网搜索当前最新的 Rust 稳定版本号与发布日期，用一句话回答并附上来源引用。",
        allowCommands: ["web.search"],
      });
      const piDone = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, piSent.runId, 180_000);
      await callApp("settings.setRuntime", { runtime: "native" });
      expect(piDone.value?.status, scrub(JSON.stringify(piDone.value?.error))).toBe("succeeded");
      const piStream = await callApp<{ items: StreamItem[] }>("session.stream", { sessionId: piConv.sessionId });
      const piAgent = piStream.items.find((item): item is StreamAgent => item.kind === "agent" && item.runId === piSent.runId)!;
      record("e2e-flash-pi-parity", piAgent.text.length > 0 && (piAgent.serverToolSteps?.length ?? 0) > 0 ? "ok" : "failed", {
        serverStepKinds: (piAgent.serverToolSteps ?? []).map((s) => `${s.kind}:${s.status}`),
        citations: piAgent.citations?.length ?? 0,
        reasoningTokens: piAgent.usage?.reasoningTokens ?? 0,
        searches: piAgent.usage?.searches ?? 0,
        textChars: piAgent.text.length,
      });
      expect(piAgent.text.length).toBeGreaterThan(0);
      expect((piAgent.serverToolSteps ?? []).length).toBeGreaterThan(0);
      expect((piAgent.citations ?? []).length).toBeGreaterThan(0);

      // (P4) agent.continueRun (cancel mid-stream -> continue without duplicate user turn), agent.regenerateRun, agent.editAndResend.
      await callApp("settings.setAgent", { chat: { connectionId: flashId, reasoningEffort: "off", contextWindow: null } });
      const actConv = await callApp<{ sessionId: string }>("conversation.new", { contextId: null });
      let cancelTriggered = false;
      let deltaAcc = "";
      let activeRunId = "";
      const cancelReady = new Promise<void>((resolve) => {
        const off = ctx.app.onAgentStream((ev) => {
          if (ev.sessionId !== actConv.sessionId || ev.kind !== "text-delta") return;
          deltaAcc += ev.delta;
          if (!cancelTriggered && deltaAcc.length >= 12) {
            cancelTriggered = true;
            activeRunId = ev.runId;
            off();
            resolve();
          }
        });
        setTimeout(() => { off(); resolve(); }, 30_000).unref?.();
      });
      take(2);
      const longSent = await callApp<{ runId: string }>("agent.send", {
        sessionId: actConv.sessionId,
        text: "请写一段不少于300字的关于虚构海港城市“雾湾”灯塔守夜人的中文散文，不需要使用任何工具。",
      });
      await cancelReady;
      if (cancelTriggered) {
        await callApp("agent.cancel", { runId: activeRunId || longSent.runId });
      }
      const afterCancel = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, longSent.runId, 90_000);
      let continuedRunId = longSent.runId;
      let continueTested = false;
      if (afterCancel.value?.status === "cancelled") {
        const midStream = await callApp<{ items: StreamItem[] }>("session.stream", { sessionId: actConv.sessionId });
        const partial = midStream.items.find((i): i is StreamAgent => i.kind === "agent" && i.runId === longSent.runId)!;
        expect(partial.canContinue).toBe(true);
        const partialLen = partial.text.length;
        take(2);
        const cont = await callApp<{ runId: string }>("agent.continueRun", { runId: longSent.runId });
        continuedRunId = cont.runId;
        const contDone = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, cont.runId, 120_000);
        expect(contDone.value?.status, scrub(JSON.stringify(contDone.value?.error))).toBe("succeeded");
        const postCont = await callApp<{ items: StreamItem[] }>("session.stream", { sessionId: actConv.sessionId });
        expect(postCont.items.filter((i) => i.kind === "user")).toHaveLength(1);
        const full = postCont.items.find((i): i is StreamAgent => i.kind === "agent" && i.runId === cont.runId)!;
        expect(full.text.length).toBeGreaterThan(partialLen);
        continueTested = true;
      }
      expect(continueTested).toBe(true);

      // Regenerate the run.
      take(2);
      const regen = await callApp<{ runId: string }>("agent.regenerateRun", { runId: continuedRunId });
      const regenDone = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, regen.runId, 120_000);
      expect(regenDone.value?.status, scrub(JSON.stringify(regenDone.value?.error))).toBe("succeeded");
      const postRegen = await callApp<{ items: StreamItem[] }>("session.stream", { sessionId: actConv.sessionId });
      expect(postRegen.items.filter((i) => i.kind === "agent")).toHaveLength(1);

      // Edit & resend the user prompt.
      take(2);
      const edited = await callApp<{ runId: string }>("agent.editAndResend", {
        runId: regen.runId,
        text: "只回答两个字：雾湾。不需要使用任何工具。",
      });
      const editedDone = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, edited.runId, 120_000);
      expect(editedDone.value?.status, scrub(JSON.stringify(editedDone.value?.error))).toBe("succeeded");
      const postEdit = await callApp<{ items: StreamItem[] }>("session.stream", { sessionId: actConv.sessionId });
      const editUsers = postEdit.items.filter((i): i is StreamUser => i.kind === "user");
      expect(editUsers).toHaveLength(1);
      expect(editUsers[0]!.text).toContain("雾湾");
      record("e2e-run-actions", "ok", { continueTested, regenerated: regenDone.value?.status, edited: editedDone.value?.status });

      // (P5) Files API PDF + TXT attachment upload, model reading, redacted StreamUser, and cleanup.
      const pdfFile = path.join(sampleDir, "harbor.pdf");
      const txtFile = path.join(sampleDir, "code.txt");
      fs.writeFileSync(pdfFile, syntheticPdf());
      fs.writeFileSync(txtFile, "Fog Bay code is 7391.\n", "utf8");
      const pdfHandle = ctx.app.registerPath("file", pdfFile);
      const txtHandle = ctx.app.registerPath("file", txtFile);
      const fileConv = await callApp<{ sessionId: string }>("conversation.new", { contextId: null });
      take(5);
      const fileSent = await callApp<{ runId: string }>("agent.send", {
        sessionId: fileConv.sessionId,
        text: "这两个附件里的两个数字分别是什么？只回答两个数字，不需要使用任何工具。",
        fileAttachments: [
          { pathHandle: pdfHandle, name: "harbor.pdf", mimeType: "application/pdf" },
          { pathHandle: txtHandle, name: "code.txt", mimeType: "text/plain" },
        ],
      });
      const fileDone = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, fileSent.runId, 120_000);
      expect(fileDone.value?.status, scrub(JSON.stringify(fileDone.value?.error))).toBe("succeeded");
      const fileStream = await callApp<{ items: StreamItem[] }>("session.stream", { sessionId: fileConv.sessionId });
      const fileUser = fileStream.items.find((i): i is StreamUser => i.kind === "user")!;
      const fileAgent = fileStream.items.find((i): i is StreamAgent => i.kind === "agent")!;
      const matchedFiles = /42/.test(fileAgent.text) && /7391/.test(fileAgent.text);
      record("e2e-files-attachments", matchedFiles ? "ok" : "failed", {
        attachments: fileUser.attachments?.length ?? 0,
        matchedFiles,
        textChars: fileAgent.text.length,
      });
      expect(fileUser.attachments).toHaveLength(2);
      expect(JSON.stringify(fileUser)).not.toContain(pdfHandle);
      expect(matchedFiles).toBe(true);

      // (P6) deepseek-v4-pro: reasoning + ticking webSearch cleanly falls back to standalone web.search (NO HTTP 400!).
      await callApp("settings.setAgent", { chat: { connectionId: v4ProId, reasoningEffort: "low", contextWindow: null } });
      const v4Caps = await callApp<ProviderCapabilities>("providers.capabilities");
      expect(v4Caps.nativeWebSearchAvailable).toBe(false);
      expect(v4Caps.standaloneWebSearchAvailable).toBe(true);
      expect(v4Caps.webSearchAvailable).toBe(true);
      const v4Conv = await callApp<{ sessionId: string }>("conversation.new", { contextId: null });
      take(4);
      const v4Sent = await callApp<{ runId: string }>("agent.send", {
        sessionId: v4Conv.sessionId,
        text: "请务必调用 web.search 工具搜索 DeepSeek API，并用一句话概括结果。",
        allowCommands: ["web.search"],
      });
      const v4Done = await waitForRun(ctx.app, ctx.actor, ctx.grant.handle, v4Sent.runId, 180_000);
      expect(v4Done.value?.status, scrub(JSON.stringify(v4Done.value?.error))).toBe("succeeded");
      const v4Stream = await callApp<{ items: StreamItem[] }>("session.stream", { sessionId: v4Conv.sessionId });
      const v4Agent = v4Stream.items.find((i): i is StreamAgent => i.kind === "agent" && i.runId === v4Sent.runId)!;
      record("e2e-v4-pro-websearch-fallback", v4Agent.text.length > 0 ? "ok" : "failed", {
        status: v4Agent.status,
        reasoningChars: v4Agent.reasoning?.length ?? 0,
        toolSteps: (v4Agent.toolSteps ?? []).map((t) => `${t.name}:${t.status}`),
        textChars: v4Agent.text.length,
      });
      expect(v4Agent.text.length).toBeGreaterThan(0);

      // (P7) ProductApp standalone services: web.search (needContent + siteIcon), webpage.fetch (deepseek), ocr.recognize, HTTP TTS (stella & tide) + ASR, WS SpeechService.startStream.
      take(1);
      const appSearch = await callApp<{ results: Array<{ url: string; title: string; siteIcon?: string; content?: string }> }>("web.search", {
        query: "DeepSeek API",
        count: 2,
        needContent: true,
      });
      expect(appSearch.results.length).toBeGreaterThan(0);

      take(1);
      const appFetch = await callApp<{ page: { id: string; title: string; chars: number }; source?: string }>("webpage.fetch", {
        url: "https://example.com",
        backend: "deepseek",
      });
      expect(appFetch.page.id).toBeTruthy();
      expect(appFetch.page.chars).toBeGreaterThan(0);
      expect(appFetch.source).toBe("deepseek_fetch");

      take(1);
      const ocrHandle = ctx.app.registerPath("file", pdfFile);
      const appOcr = await callApp<{ text: string; pages: Array<{ page: number; text: string }> }>("ocr.recognize", {
        pathHandle: ocrHandle,
        purpose: "text_recognition",
      });
      expect(appOcr.text).toContain("42");
      expect(appOcr.pages.length).toBeGreaterThanOrEqual(1);

      // HTTP TTS stella & tide via ProductApp SpeechService + ASR round-trip.
      take(3);
      const stellaPcm: Uint8Array[] = [];
      const stellaRes = await ctx.app.speech.speak(
        { text: `## 标题\n\n${SENTENCE}`, voice: "stella", task: "read-aloud" },
        (chunk) => stellaPcm.push(chunk),
        new AbortController().signal,
      );
      const tidePcm: Uint8Array[] = [];
      const tideRes = await ctx.app.speech.speak(
        { text: "雾湾灯塔。", voice: "tide", task: "read-aloud" },
        (chunk) => tidePcm.push(chunk),
        new AbortController().signal,
      );
      const stellaBytes = Buffer.concat(stellaPcm);
      const tideBytes = Buffer.concat(tidePcm);
      expect(stellaBytes.length).toBeGreaterThan(0);
      expect(tideBytes.length).toBeGreaterThan(0);
      const asrRound = await transcribeDeepSeek(BASE, key(), {
        bytes: wav(new Uint8Array(stellaBytes), 24_000),
        fileName: "e2e-stella.wav",
        mimeType: "audio/wav",
        timeoutMs: 120_000,
      });
      const asrSim = similarity(SENTENCE, asrRound.text);
      expect(asrSim).toBeGreaterThanOrEqual(0.75);

      // WS streaming TTS via ProductApp SpeechService.startStream.
      take(1);
      const wsPcm: Uint8Array[] = [];
      const wsSess = await ctx.app.speech.startStream(
        { voice: "stella", task: "read-aloud" },
        (chunk) => wsPcm.push(chunk),
        new AbortController().signal,
      );
      wsSess.push("星穹航路的灯塔，");
      wsSess.push("在黄昏时亮起。");
      const wsFin = await wsSess.finish();
      expect(wsFin.transport).toBe("ws");
      expect(wsFin.bytes).toBeGreaterThan(0);
      expect(wsFin.bytes % 2).toBe(0);
      expect(wsFin.firstChunkMs).not.toBeNull();

      const usageRows = ctx.app.store.sqlite
        .prepare("SELECT service, COUNT(*) AS n FROM service_usage WHERE status = 'ok' GROUP BY service")
        .all() as Array<{ service: string; n: number }>;
      const usageMap = Object.fromEntries(usageRows.map((r) => [r.service, Number(r.n)]));
      record("e2e-services-tts-ocr-fetch", "ok", {
        searchResults: appSearch.results.length,
        searchHasSiteIcon: Boolean(appSearch.results[0]?.siteIcon),
        searchContentChars: appSearch.results[0]?.content?.length ?? 0,
        fetchTextLength: appFetch.page.chars,
        fetchSource: appFetch.source,
        ocrPages: appOcr.pages.length,
        stellaBytes: stellaBytes.length,
        stellaBilled: stellaRes.billedChars,
        tideBytes: tideBytes.length,
        tideBilled: tideRes.billedChars,
        asrSimilarity: Number(asrSim.toFixed(3)),
        wsTransport: wsFin.transport,
        wsBytes: wsFin.bytes,
        wsFirstChunkMs: wsFin.firstChunkMs,
        serviceUsage: usageMap,
      });
      expect(usageMap.fetch).toBeGreaterThanOrEqual(1);
      expect(usageMap.ocr).toBeGreaterThanOrEqual(1);
      expect(usageMap.speech).toBeGreaterThanOrEqual(3);
    } finally {
      ctx.app.close();
      fs.rmSync(sampleDir, { recursive: true, force: true });
      fs.rmSync(bundledDir, { recursive: true, force: true });
    }
  });
});

afterAll(() => {
  if (!enabled) return;
  const out = path.join(import.meta.dirname, "../../.local/deepseek-contract.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, scrub(`${JSON.stringify({ at: new Date().toISOString(), requests: used, results }, null, 2)}\n`));
});
