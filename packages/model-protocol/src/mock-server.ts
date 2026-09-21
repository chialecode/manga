import http from "node:http";

export type MockProviderOptions = {
  mode?: "ok" | "unauthorized" | "rate-limited" | "missing-capability" | "timeout" | "disconnect" | "malicious-json" | "truncated-stream" | "always-tools";
  protocolPrefix?: string;
  streamToolName?: string;
  streamToolArguments?: string;
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
    req.on("end", () => {
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
      if (json.stream && json.tools?.length && (options.mode === "always-tools" || !hasToolResult)) {
        const name = options.streamToolName ?? "library.find";
        const args = options.streamToolArguments ?? '{"text":"hello"}';
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
      res.writeHead(200, { "content-type": "application/json" });
      if (chat) {
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hello world" } }] }));
      } else if (responses) {
        res.end(JSON.stringify({ output_text: "hello world", output: [] }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
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
