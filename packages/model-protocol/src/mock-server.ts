import http from "node:http";

export type MockProviderOptions = {
  mode?: "ok" | "unauthorized" | "rate-limited" | "missing-capability" | "timeout" | "disconnect" | "malicious-json" | "truncated-stream" | "always-tools" | "no-vision" | "model-missing" | "protocol-mismatch" | "wrong-shape" | "forbidden" | "server-error";
  protocolPrefix?: string;
  streamToolName?: string;
  streamToolArguments?: string;
  /** Tool calls to make one after another, one for each request that offers tools; when it is empty the model answers in text. A test may add to it between runs. */
  streamToolScript?: Array<{ name: string; arguments: string }>;
  /** What `GET /models` lists, so a test can have the service state a model's own limits; without it the list is not there (404). */
  models?: Array<Record<string, unknown>>;
  /** Makes the answers slow: every answer waits this long (ms), the first byte of a stream included. */
  delayMs?: number;
  /** Sees every parsed request body, so a test can check what a model was actually given. */
  onRequest?: (request: { url: string; body: Record<string, unknown> }) => void;
  /** Answers a request in place of the usual answer: an error status with its message, or the words to say (and the input tokens the service claims to have counted). */
  respond?: (request: { url: string; body: Record<string, unknown> }) => undefined | { status: number; message: string } | { text: string; inputTokens?: number };
};

export function startMockProvider(options: MockProviderOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const prefix = options.protocolPrefix ?? "";
  const mode = options.mode ?? "ok";
  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (mode === "timeout") return;
    if (mode === "disconnect") {
      req.socket.destroy();
      return;
    }
    if (mode === "unauthorized") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid api key" } }));
      return;
    }
    if (mode === "rate-limited") {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "rate limited" } }));
      return;
    }
    if (mode === "forbidden") {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "this key may not use this model" } }));
      return;
    }
    if (mode === "server-error") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "overloaded" } }));
      return;
    }
    if (mode === "model-missing") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "The model `demo` does not exist or you do not have access to it.", code: "model_not_found" } }));
      return;
    }
    if (mode === "protocol-mismatch") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><html><body>Sign in to continue</body></html>");
      return;
    }
    if (mode === "wrong-shape") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ hello: "world" }));
      return;
    }
    if (options.models && /\/models(\/[^/]+)?$/.test(url.split("?")[0] ?? "") && req.method === "GET") {
      const wanted = /\/models\/([^/?]+)$/.exec(url)?.[1];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(wanted ? (options.models.find((entry) => entry.id === decodeURIComponent(wanted)) ?? {}) : { object: "list", data: options.models }));
      return;
    }
    const chat = url === `${prefix}/chat/completions` || url.endsWith("/chat/completions");
    const responses = url === `${prefix}/responses` || url.endsWith("/responses");
    const transcribe = url === `${prefix}/audio/transcriptions` || url.endsWith("/audio/transcriptions");
    if (mode === "missing-capability" && transcribe) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "transcription not available" } }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => setTimeout(() => {
      if (transcribe) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: "synthetic transcript" }));
        return;
      }
      if (url.endsWith("/embeddings")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ embedding: [0.01, 0.02, 0.03], index: 0 }] }));
        return;
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const json = body ? JSON.parse(body) as { stream?: boolean; tools?: unknown[]; messages?: Array<{ role?: string }>; input?: Array<{ type?: string }> } : {};
      if (body) options.onRequest?.({ url, body: json as Record<string, unknown> });
      const custom = body ? options.respond?.({ url, body: json as Record<string, unknown> }) : undefined;
      if (custom && "status" in custom) {
        res.writeHead(custom.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: custom.message } }));
        return;
      }
      if (custom) {
        const used = custom.inputTokens ?? 3;
        if (!json.stream) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(chat ? { choices: [{ message: { role: "assistant", content: custom.text } }], usage: { prompt_tokens: used, completion_tokens: 2 } } : { output_text: custom.text, output: [], usage: { input_tokens: used, output_tokens: 2 } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (chat) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: custom.text } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: used, completion_tokens: 2 } })}\n\n`);
        } else {
          const message = { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] as unknown[] };
          const done = { ...message, status: "completed", content: [{ type: "output_text", text: custom.text, annotations: [] }] };
          res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", status: "in_progress" } })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: message })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: custom.text })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: done })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [done], usage: { input_tokens: used, output_tokens: 2, total_tokens: used + 2 } } })}\n\n`);
        }
        res.end("data: [DONE]\n\n");
        return;
      }
      // A text-only model rejects image parts the way hosted ones do: with a client error naming the input.
      if (mode === "no-vision" && /"(image_url|input_image)"/.test(body)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "image input is not supported by this model" } }));
        return;
      }
      const hasToolResult = (json.messages ?? []).some((message) => message.role === "tool")
        || (json.input ?? []).some((item) => item.type === "function_call_output");
      if (mode === "truncated-stream" && json.stream) {
        // Complete JSON arguments, but the connection drops before any finish/completed event.
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: "call_cut", function: { name: "notes.create", arguments: '{"title":"cut","text":"cut"}' } }] } }] })}\n\n`);
        res.socket?.destroy();
        return;
      }
      if (mode === "malicious-json" && json.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"tool_calls":[{"id":"call_bad","function":{"name":"notes.create","arguments":"{\\"title\\":"}}]}}]}\n\n');
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      const scripted = options.streamToolScript && json.stream && json.tools?.length ? options.streamToolScript.shift() : undefined;
      if (json.stream && json.tools?.length && (scripted || (!options.streamToolScript && (options.mode === "always-tools" || !hasToolResult)))) {
        const name = scripted?.name ?? options.streamToolName ?? "library.find";
        const args = scripted?.arguments ?? options.streamToolArguments ?? '{"text":"hello"}';
        const mid = Math.max(1, Math.floor(args.length / 2));
        const first = args.slice(0, mid);
        const second = args.slice(mid);
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (chat) {
          // Shape follows real Chat Completions streams: id and name only in the first chunk, index afterwards.
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: first } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: second } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`);
        } else {
          // Shape follows real Responses streams: the call is announced once with its output_index,
          // argument deltas carry item_id/output_index, and the terminal event carries the response.
          const item = { type: "function_call", id: "fc_1", call_id: "call_1", name, arguments: "" };
          const finished = { ...item, arguments: args, status: "completed" };
          res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", status: "in_progress" } })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: first })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, delta: second })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: args })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: finished })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [finished], usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } } })}\n\n`);
        }
        res.end();
        return;
      }
      if (json.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (chat) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hello " } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "world" }, finish_reason: "stop" }] })}\n\n`);
        } else {
          const message = { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] as unknown[] };
          const done = { ...message, status: "completed", content: [{ type: "output_text", text: "hello world", annotations: [] }] };
          res.write(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", status: "in_progress" } })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: message })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "hello " })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", item_id: "msg_1", output_index: 0, delta: "world" })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: done })}\n\n`);
          res.write(`data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [done], usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 } } })}\n\n`);
        }
        res.end();
        return;
      }
      // Any other path (a model list the test did not set, say) is not there: one status, not a 200 followed by a 404.
      if (!chat && !responses) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(chat ? { choices: [{ message: { role: "assistant", content: "hello world" } }] } : { output_text: "hello world", output: [] }));
    }, options.delayMs ?? 0));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}${prefix}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}
