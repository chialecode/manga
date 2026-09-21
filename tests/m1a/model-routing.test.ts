import { describe, expect, it, vi } from "vitest";
import { startApp } from "./helpers.ts";

describe("connection probes stay within their configured model role", () => {
  it.each([
    ["text", "transcription"],
    ["transcription", "text"],
    ["transcription", "tools"],
    ["transcription", "streaming"],
  ] as const)("rejects %s connection for %s before network access", async (purpose, capability) => {
    const { app, actor, grant } = await startApp();
    const fetchProbe = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("a mismatched role must never reach the network");
    });
    try {
      const connection = await app.call(actor, { commandId: "connections.upsert", idempotencyKey: "connection", input: {
        label: "synthetic", purpose, protocol: "openai-chat-completions", baseUrl: "https://provider.invalid/v1", modelId: `${purpose}-only`,
        credentialHandle: app.stashSecret("synthetic-test-credential"),
      } }, grant.handle);
      expect(connection.status).toBe("ok");
      const result = await app.call(actor, { commandId: "connections.test", idempotencyKey: "probe", input: { connectionId: connection.value?.id, capability } }, grant.handle);
      expect(result).toMatchObject({ status: "error", error: { code: "MODEL_CAPABILITY_MISSING" } });
      expect(fetchProbe).not.toHaveBeenCalled();
      const verified = app.store.sqlite.prepare("SELECT verified_capabilities_json AS capabilities FROM provider_connections").get();
      expect(verified).toEqual({ capabilities: "[]" });
    } finally { fetchProbe.mockRestore(); app.close(); }
  });

  it("uses only the selected ASR connection and model for the transcription probe", async () => {
    const { app, actor, grant } = await startApp();
    const fetchProbe = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ text: "synthetic transcript" }), { headers: { "content-type": "application/json" } }));
    try {
      for (const purpose of ["text", "transcription"] as const) {
        await app.call(actor, { commandId: "connections.upsert", idempotencyKey: purpose, input: {
          id: purpose, label: purpose, purpose, protocol: "openai-chat-completions", baseUrl: `https://${purpose}.invalid/v1`, modelId: `${purpose}-model`,
          credentialHandle: app.stashSecret(`${purpose}-synthetic-credential`),
        } }, grant.handle);
      }
      const result = await app.call(actor, { commandId: "connections.test", idempotencyKey: "asr-probe", input: { connectionId: "transcription", capability: "transcription" } }, grant.handle);
      expect(result.status).toBe("ok");
      expect(fetchProbe).toHaveBeenCalledTimes(1);
      const [url, options] = fetchProbe.mock.calls[0]!;
      expect(url).toBe("https://transcription.invalid/v1/audio/transcriptions");
      expect((options?.body as FormData).get("model")).toBe("transcription-model");
      expect(options?.headers).toEqual({ authorization: "Bearer transcription-synthetic-credential" });
    } finally { fetchProbe.mockRestore(); app.close(); }
  });
});
