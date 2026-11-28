import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { MangaError } from "@manga/contracts";
import {
  completeResponses,
  joinApiPath,
  searchDeepSeek,
  streamChatCompletions,
  streamResponses,
  streamText,
  transcribeAudio,
  withRetries,
  type StreamEvent,
} from "@manga/model-protocol";

const servers: http.Server[] = [];

function startCustomServer(handler: http.RequestListener): Promise<{ url: string }> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

afterEach(async () => {
  while (servers.length) {
    const s = servers.pop()!;
    s.closeAllConnections();
    await new Promise<void>((done) => s.close(() => done()));
  }
});

describe("model-protocol: streaming, usage, pi-ai, responses, retries", () => {
  it("captures trailing choices:[] usage chunk emitted after finish_reason in streamChatCompletions (F-02)", async () => {
    const { url } = await startCustomServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: null })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 40, prompt_cache_hit_tokens: 60, server_tool_use: { tool_search: 2 } } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });

    const events: StreamEvent[] = [];
    for await (const ev of streamChatCompletions(url, "k", {
      model: "deepseek-chat",
      dialect: "deepseek",
      messages: [{ role: "user", content: "hello" }],
    })) {
      events.push(ev);
    }
    const completed = events.filter((e) => e.type === "completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toEqual({
      type: "completed",
      finishReason: "stop",
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 40, cachedInputTokens: 60, searches: 2 },
    });
  });

  it("does not corrupt streamed tool arguments on pi runtime when key order or whitespace differs (F-07)", async () => {
    const { url } = await startCustomServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Streamed JSON has extra whitespace (`{ "b": 1, "a": 2 }`), which is longer/different from `JSON.stringify`.
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_ws", type: "function", function: { name: "notes_create", arguments: '{ "b": 1, ' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a": 2 }' } }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });

    let args = "";
    for await (const ev of streamText("openai-chat-completions", url, "k", {
      model: "demo",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "notes.create", description: "create", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }],
    }, "pi")) {
      if (ev.type === "tool-call-delta") args += ev.argumentsDelta;
    }
    expect(JSON.parse(args)).toEqual({ a: 2, b: 1 });
  });

  it("maps mid-stream socket reset to retryable MangaError (F-13)", async () => {
    const { url } = await startCustomServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "part" } }] })}\n\n`);
      setTimeout(() => res.socket?.destroy(), 20);
    });

    const run = async () => {
      for await (const _ev of streamChatCompletions(url, "k", {
        model: "demo",
        messages: [{ role: "user", content: "hi" }],
      })) {
        // consume
      }
    };
    await expect(run()).rejects.toSatisfy((err: unknown) => err instanceof MangaError && err.code === "PROVIDER_UNAVAILABLE" && err.retryable === true);
  });

  it("handles Responses zero-arg tool calls, response.failed, cached tokens, and completeResponses usage (F-14)", async () => {
    const { url } = await startCustomServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { stream?: boolean; model?: string };
        if (!body.stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            output_text: "done",
            output: [],
            usage: { input_tokens: 20, output_tokens: 10, input_tokens_details: { cached_tokens: 5 } },
          }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (body.model === "fail-model") {
          res.write(`data: ${JSON.stringify({ type: "response.failed", response: { status: "failed" } })}\n\n`);
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ type: "response.output_item.added", item: { type: "function_call", id: "fc_zero", call_id: "call_zero", name: "ping" } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_zero", arguments: "{}" })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed", usage: { input_tokens: 15, output_tokens: 7, input_tokens_details: { cached_tokens: 4 } } } })}\n\n`);
        res.end();
      });
    });

    const events: StreamEvent[] = [];
    for await (const ev of streamResponses(url, "k", { model: "ok-model", messages: [{ role: "user", content: "ping" }] })) {
      events.push(ev);
    }
    expect(events).toContainEqual({ type: "tool-call-delta", callId: "call_zero", name: "ping", argumentsDelta: "{}" });
    expect(events).toContainEqual({
      type: "completed",
      finishReason: "stop",
      stopReason: "end_turn",
      usage: { inputTokens: 15, outputTokens: 7, cachedInputTokens: 4 },
    });

    await expect(async () => {
      for await (const _ev of streamResponses(url, "k", { model: "fail-model", messages: [{ role: "user", content: "x" }] })) {
        // consume
      }
    }).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true, details: { kind: "stream_error" } });

    const done = await completeResponses(url, "k", { model: "ok-model", messages: [{ role: "user", content: "hi" }] });
    expect(done.usage).toEqual({ inputTokens: 20, outputTokens: 10, cachedInputTokens: 5 });
  });

  it("deduplicates /v1 in joinApiPath, aborts withRetries sleep immediately, and avoids false retryAfterMs:0 (F-16)", async () => {
    expect(joinApiPath("https://api.deepseek.com/v1", "/v1/tools/asr")).toBe("https://api.deepseek.com/v1/tools/asr");
    expect(joinApiPath("https://api.deepseek.com", "/v1/tools/asr")).toBe("https://api.deepseek.com/v1/tools/asr");
    expect(joinApiPath("https://api.deepseek.com/v1", "/chat/completions")).toBe("https://api.deepseek.com/v1/chat/completions");

    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 30);
    await expect(withRetries(
      async () => { throw new MangaError("RATE_LIMITED", "429", { retryable: true, details: { status: 429 } }); },
      [429],
      { times: 2, baseMs: 10_000, signal: ac.signal },
    )).rejects.toMatchObject({ code: "CANCELLED" });
    expect(Date.now() - started).toBeLessThan(1_000);

    await expect(searchDeepSeek("https://api.deepseek.com", "k", { query: "test", signal: ac.signal }))
      .rejects.toMatchObject({ code: "CANCELLED" });

    // 429 without retry-after header must NOT set retryAfterMs: 0.
    const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({ error: { message: "slow down" } }), { status: 429 });
    await expect(transcribeAudio("https://api.example.com", "k", {
      model: "whisper",
      fileName: "a.wav",
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: "audio/wav",
    }, fakeFetch)).rejects.toSatisfy((err: unknown) => err instanceof MangaError && err.code === "RATE_LIMITED" && !("retryAfterMs" in ((err.details ?? {}) as Record<string, unknown>)));
  });
});
