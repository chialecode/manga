import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { completeText, streamText, transcribeAudio, syntheticWav } from "@manga/model-protocol";
import { startApp } from "./helpers.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function loadEnvLocal() {
  const file = path.join(root, ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const live = process.env.MANGA_LIVE_MODELS === "1";
if (live) loadEnvLocal();

function purposeConfig(prefix: "LLM" | "ASR" | "EMBEDDING") {
  const baseUrl = process.env[`MANGA_TEST_${prefix}_API_BASE_URL`];
  const apiKey = process.env[`MANGA_TEST_${prefix}_API_KEY`];
  const modelId = process.env[`MANGA_TEST_${prefix}_MODEL_ID`];
  const protocol = process.env[`MANGA_TEST_${prefix}_PROTOCOL`] === "openai-responses" ? "openai-responses" as const : "openai-chat-completions" as const;
  if (!baseUrl || !apiKey || !modelId) return undefined;
  return { baseUrl, apiKey, modelId, protocol };
}

describe.skipIf(!live)("live model probes from ignored local config", () => {
  it("runs a short LLM completion without printing secrets", async () => {
    const config = purposeConfig("LLM");
    if (!config) return;
    const result = await completeText(config.protocol, config.baseUrl, config.apiKey, {
      model: config.modelId,
      messages: [{ role: "user", content: "回复一个字：好" }],
      timeoutMs: 20_000,
    }, "native");
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(JSON.stringify(result).includes(config.apiKey)).toBe(false);
  });

  it("streams LLM text", async () => {
    const config = purposeConfig("LLM");
    if (!config) return;
    let text = "";
    let completed = false;
    for await (const event of streamText(config.protocol, config.baseUrl, config.apiKey, {
      model: config.modelId,
      messages: [{ role: "user", content: "回复一个字：好" }],
      timeoutMs: 20_000,
    }, "native")) {
      if (event.type === "text-delta") text += event.text;
      if (event.type === "completed") completed = true;
    }
    expect(completed).toBe(true);
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it("transcribes a synthetic wav with the ASR purpose only", async () => {
    const config = purposeConfig("ASR");
    if (!config) return;
    const result = await transcribeAudio(config.baseUrl, config.apiKey, {
      model: config.modelId,
      fileName: "probe.wav",
      bytes: syntheticWav(),
      mimeType: "audio/wav",
      timeoutMs: 30_000,
    });
    expect(typeof result.text).toBe("string");
    expect(JSON.stringify(result).includes(config.apiKey)).toBe(false);
  });

  it("probes a real embedding through its independent application connection", async () => {
    const config = purposeConfig("EMBEDDING");
    if (!config) return;
    const { app, actor, grant, profileRoot } = await startApp();
    try {
      const saved = await app.call(actor, {
        commandId: "connections.upsert", idempotencyKey: "live-embedding-connection",
        input: { label: "live embedding probe", protocol: config.protocol, baseUrl: config.baseUrl,
          modelId: config.modelId, purpose: "embedding", timeoutMs: 30_000,
          credentialHandle: app.stashSecret(config.apiKey) },
      }, grant.handle);
      expect(saved.status, saved.error?.code).toBe("ok");
      const result = await app.call(actor, {
        commandId: "connections.test", idempotencyKey: "live-embedding-probe",
        input: { connectionId: saved.value?.id, capability: "embedding" },
      }, grant.handle);
      expect(result.status, result.error?.code).toBe("ok");
      expect(result.value).toMatchObject({ ok: true, vectors: 1 });
      const connection = app.store.sqlite.prepare("SELECT verified_capabilities_json AS capabilities FROM provider_connections WHERE id = ?").get(saved.value?.id) as { capabilities: string };
      expect(JSON.parse(connection.capabilities)).toContain("embedding");
      expect(JSON.stringify(result).includes(config.apiKey)).toBe(false);
    } finally {
      app.close();
      // This synthetic profile temporarily holds encrypted test credentials.
      const resolved = path.resolve(profileRoot);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("manga-m1a-")) {
        throw new Error("refusing to clean a profile outside the test temporary directory");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
});
