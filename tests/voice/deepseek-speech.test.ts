import { afterEach, describe, expect, it } from "vitest";
import { speechBilledChars } from "@manga/model-protocol";
import { splitForSpeech } from "../../packages/app-core/src/providers/speech.ts";
import { call, deepseekApp } from "../helpers/provider-fixture.ts";

/** Reading aloud through DeepSeek's speech (计划 4.7, AT-191): split into requests, played as it arrives, cached for 10 minutes, a break is an error. */

const rigs: Array<Awaited<ReturnType<typeof deepseekApp>>> = [];
afterEach(async () => { while (rigs.length) await rigs.pop()!.close(); });
async function rig(mock: Parameters<typeof deepseekApp>[0] extends infer O ? O extends { mock?: infer M } ? M : never : never = {}) {
  const made = await deepseekApp({ mock });
  rigs.push(made);
  const tts = () => made.server.requests.filter((request) => request.path === "/v1/tools/tts");
  const uses = () => made.ctx.app.store.sqlite.prepare("SELECT service, task, unit, quantity, status, error_code FROM service_usage WHERE service = 'speech' ORDER BY created_at, rowid").all() as Array<{ service: string; task: string; unit: string; quantity: number; status: string; error_code: string | null }>;
  return { ...made, tts, uses };
}
const speak = async (made: Awaited<ReturnType<typeof rig>>, text: string, signal = new AbortController().signal) => {
  const chunks: Uint8Array[] = [];
  const result = await made.ctx.app.speech.speak({ text }, (pcm) => chunks.push(pcm), signal);
  return { result, bytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0), chunks };
};

describe("splitting a text for speech", () => {
  it("keeps every piece within 10,000 billed characters, cutting after sentences", () => {
    const sentence = "这是一个合成的句子，用来测试朗读的切分。";
    const text = sentence.repeat(600);
    const pieces = splitForSpeech(text);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(speechBilledChars(piece)).toBeLessThanOrEqual(10_000);
      expect(piece.endsWith("。")).toBe(true);
    }
    expect(pieces.join("")).toBe(text);
  });

  it("cuts inside a sentence only when it alone is too long", () => {
    const text = "长".repeat(12_000);
    const pieces = splitForSpeech(text);
    expect(pieces.map((piece) => speechBilledChars(piece))).toEqual([10_000, 10_000, 4_000]);
  });
});

describe("the speech service", () => {
  it("hands the PCM on as it arrives, records the billed characters, and answers the same text again from memory", async () => {
    const made = await rig();
    const first = await speak(made, "你好，这是合成的朗读。");
    expect(first.result.cached).toBe(false);
    expect(first.result.billedChars).toBe(speechBilledChars("你好，这是合成的朗读。"));
    expect(first.bytes).toBeGreaterThan(0);
    expect(first.bytes % 2).toBe(0);
    expect(made.tts()).toHaveLength(1);
    expect(made.uses()).toEqual([expect.objectContaining({ unit: "char", quantity: first.result.billedChars, status: "ok", task: "read-aloud" })]);

    const again = await speak(made, "你好，这是合成的朗读。");
    expect(again.result).toMatchObject({ cached: true, billedChars: 0 });
    expect(again.bytes).toBe(first.bytes);
    expect(made.tts()).toHaveLength(1);
    expect(made.uses()).toHaveLength(1);
    expect(made.ctx.app.speech.cacheState().entries).toBe(1);
  });

  it("asks once per piece for a long text", async () => {
    const made = await rig({ ttsMsPerChar: 1 });
    const text = "这是一个合成的句子，用来测试朗读的切分。".repeat(600);
    const spoken = await speak(made, text);
    expect(made.tts().length).toBe(splitForSpeech(text).length);
    expect(spoken.result.billedChars).toBe(speechBilledChars(text));
  });

  it("reports a broken-off answer as an error that can be retried, records what was billed, and keeps nothing in the cache", async () => {
    const made = await rig({ ttsTruncateAfter: 4000 });
    await expect(speak(made, "这一句会在中途断开。")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", details: { kind: "truncated" } });
    expect(made.uses()).toEqual([expect.objectContaining({ status: "error", error_code: "PROVIDER_UNAVAILABLE" })]);
    expect(made.ctx.app.speech.cacheState().entries).toBe(0);
    // Trying again speaks it.
    const again = await speak(made, "这一句会在中途断开。");
    expect(again.result.cached).toBe(false);
  });

  it("makes no request when the plugin is off, and says there is no service when none is added", async () => {
    const made = await rig();
    const off = await call(made.ctx, "plugin.disable", { pluginId: "demo.provider" });
    expect(off.status).toBe("ok");
    await expect(speak(made, "插件停用后不应请求。")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", details: { reason: "plugin_disabled" } });
    expect(made.tts()).toHaveLength(0);

    const bare = await deepseekApp({ add: { models: ["deepseek-flash"], services: [] } });
    rigs.push(bare);
    await expect(bare.ctx.app.speech.speak({ text: "没有语音合成。" }, () => undefined, new AbortController().signal)).rejects.toMatchObject({ code: "MODEL_CAPABILITY_MISSING", details: { reason: "no_speech_service" } });
  });

  it("does not read from memory either once the plugin is off", async () => {
    const made = await rig();
    await speak(made, "先读一遍放进内存。");
    expect(made.tts()).toHaveLength(1);
    expect((await call(made.ctx, "plugin.disable", { pluginId: "demo.provider" })).status).toBe("ok");
    await expect(speak(made, "先读一遍放进内存。")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", details: { reason: "plugin_disabled" } });
    expect(made.tts()).toHaveLength(1);
  });

  it("stops the request when the reading is stopped, without recording a failure", async () => {
    const made = await rig({ ttsChunkDelayMs: 30 });
    const controller = new AbortController();
    const pending = made.ctx.app.speech.speak({ text: "这一段会被停下。".repeat(20) }, () => controller.abort(), controller.signal);
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(made.uses()).toEqual([]);
  });
});
