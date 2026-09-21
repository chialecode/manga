import { describe, expect, it } from "vitest";
import { startMockProvider, streamText, transcribeAudio, completeText } from "@manga/model-protocol";
import { startApp, waitForRun } from "./helpers.ts";

describe("P5 protocol faults", () => {
  it("rejects incomplete streamed tool JSON", async () => {
    const server = await startMockProvider({ mode: "malicious-json" });
    let args = "";
    for await (const event of streamText("openai-chat-completions", server.url, "k", {
      model: "demo",
      messages: [{ role: "user", content: "x" }],
      tools: [{ name: "notes.create", description: "n", parameters: { type: "object" } }],
    })) {
      if (event.type === "tool-call-delta") args += event.argumentsDelta;
    }
    expect(() => JSON.parse(args)).toThrow();
    await server.close();
  });

  it("does not execute a tool whose JSON never closed", async () => {
    const server = await startMockProvider({ mode: "malicious-json" });
    const { app, actor, grant } = await startApp();
    const secret = app.stashSecret("test-credential-value-for-vault");
    await app.call(actor, {
      commandId: "connections.upsert",
      idempotencyKey: "bad-conn",
      input: { label: "mock", protocol: "openai-chat-completions", baseUrl: server.url, modelId: "demo", purpose: "text", credentialHandle: secret },
    }, grant.handle);
    const session = await app.call(actor, { commandId: "agent.createSession", idempotencyKey: "bad-ses", input: {} }, grant.handle);
    const sent = await app.call(actor, { commandId: "agent.send", idempotencyKey: "bad-send", input: { sessionId: session.value?.id, text: "hack" } }, grant.handle);
    expect(sent.status).toBe("ok");
    const finished = await waitForRun(app, actor, grant.handle, String(sent.value?.runId));
    expect(finished.value?.status).toBe("failed");
    const notes = app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM content_objects").get() as { n: number };
    expect(notes.n).toBe(0);
    await server.close();
    app.close();
  });

  it("maps missing capability, disconnect and timeout without writing notes", async () => {
    const missing = await startMockProvider({ mode: "missing-capability" });
    await expect(transcribeAudio(missing.url, "k", {
      model: "whisper",
      fileName: "a.wav",
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/wav",
    })).rejects.toMatchObject({ code: "MODEL_CAPABILITY_MISSING" });
    await missing.close();

    const dropped = await startMockProvider({ mode: "disconnect" });
    await expect(completeText("openai-chat-completions", dropped.url, "k", {
      model: "demo",
      messages: [{ role: "user", content: "hi" }],
    })).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    await dropped.close();

    const hung = await startMockProvider({ mode: "timeout" });
    await expect(completeText("openai-chat-completions", hung.url, "k", {
      model: "demo",
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 80,
    })).rejects.toMatchObject({ retryable: true });
    await hung.close();
  });
});
