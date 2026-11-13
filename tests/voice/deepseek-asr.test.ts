import { afterEach, describe, expect, it } from "vitest";
import { startMockDeepSeek } from "@manga/model-protocol";
import { AsrEngine, capabilitiesForExternalInterface, type ExternalAsrConnectionConfig } from "../../packages/app-core/src/voice/engine/index.ts";

/** DeepSeek recognition (`deepseek-asr@1`, 计划 4.6, AT-190): only the file, no hint, blocks of at most 110 s, limited retries, the seconds counted. */

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function rig(options: Parameters<typeof startMockDeepSeek>[0] = {}) {
  const server = await startMockDeepSeek({ asrText: "合成的识别结果", ...options });
  closers.push(() => server.close());
  const used: number[] = [];
  const connection: ExternalAsrConnectionConfig = { id: "conn-ds", baseUrl: server.url, apiKey: "sk-synthetic", model: "deepseek-asr", transcriptionInterface: "deepseek_asr", onServiceUse: (use) => used.push(use.seconds) };
  const engine = new AsrEngine({ resolveConnection: (id) => (id === "conn-ds" ? connection : null), retryBaseMs: 5 });
  const asr = () => server.requests.filter((request) => request.path === "/v1/tools/asr");
  return { server, engine, used, asr };
}
const seconds = (count: number) => new Float32Array(16_000 * count).fill(0.1);

describe("DeepSeek recognition", () => {
  it("declares no hint, no language and no context, with the 8 MiB and 110 s limits", () => {
    expect(capabilitiesForExternalInterface("deepseek_asr")).toMatchObject({ hotwords: 0, promptChars: 0, context: false, language: false, maxUploadBytes: 8 * 1024 * 1024, maxSeconds: 110 });
  });

  it("sends only the file, cuts a long dictation into blocks of at most 110 s, and counts the seconds", async () => {
    const { engine, used, asr } = await rig();
    const result = await engine.transcribe({ selection: { kind: "connection", connectionId: "conn-ds" }, audio: seconds(150), vocabularyTerms: ["星穹航路"] });
    expect(result.text).toContain("合成的识别结果");
    expect(asr()).toHaveLength(2);
    for (const request of asr()) {
      expect(request.fields).toEqual(["file"]);
      expect(request.bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    }
    expect(used).toHaveLength(2);
    expect(result.appliedHint.kind).toBe("none");
  });

  it("tries 429 and 503 twice more and reports a 400 at once, without another service", async () => {
    const busy = await rig({ fail: [{ path: "/v1/tools/asr", status: 503, times: 2 }] });
    const ok = await busy.engine.transcribe({ selection: { kind: "connection", connectionId: "conn-ds" }, audio: seconds(2) });
    expect(ok.text).toContain("合成的识别结果");
    expect(busy.asr()).toHaveLength(3);

    const limited = await rig({ fail: [{ path: "/v1/tools/asr", status: 429, times: 5 }] });
    await expect(limited.engine.transcribe({ selection: { kind: "connection", connectionId: "conn-ds" }, audio: seconds(2) })).rejects.toBeTruthy();
    expect(limited.asr()).toHaveLength(3);

    const bad = await rig({ fail: [{ path: "/v1/tools/asr", status: 400, times: 5 }] });
    await expect(bad.engine.transcribe({ selection: { kind: "connection", connectionId: "conn-ds" }, audio: seconds(2) })).rejects.toBeTruthy();
    expect(bad.asr()).toHaveLength(1);
    expect(bad.used).toEqual([]);
  });
});
