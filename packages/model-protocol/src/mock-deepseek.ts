import http from "node:http";
import { speechBilledChars as billedChars } from "./deepseek-services.ts";

/**
 * A fake DeepSeek on this machine (计划 第 7 节), for tests and the packaged walkthroughs: `GET /models`, `/chat/completions` with thinking, the check that a
 * tool loop sends `reasoning_content` back (a request without it is refused with a 400, as the documentation says the real service does), the built-in web
 * search's progress events, citations and `server_tool_calls`, an error in the middle of a stream and the content filter; `/v1/tools/asr`, `/v1/tools/tts`
 * (which can be told to break off) and `/v1/tools/search`; and any status a test asks for. It never calls out.
 */
export type MockDeepSeekRequest = { method: string; path: string; body: Record<string, unknown> | null; bytes: number; contentType: string; fields?: string[]; at: number };

export type MockDeepSeekOptions = {
  /** The only key accepted; any other gets a 401. Without it every key is accepted. */
  key?: string;
  /** What `GET /models` lists; the default is the two chat models as the real service lists them. */
  models?: Array<Record<string, unknown>>;
  /** Tool calls to make one after another, one per request that offers function tools; when it is empty the model answers in text. */
  toolScript?: Array<{ name: string; arguments: string }>;
  /** What the model answers in text; a function gives each answer its own (the read-aloud benchmark wants no two alike). */
  answer?: string | (() => string);
  /** A status to answer the next requests to a path with (`/chat/completions`, `/v1/tools/asr`, `/v1/tools/tts`, `/v1/tools/search`, `/models`), `times` times (default once). */
  fail?: Array<{ path: string; status: number; times?: number }>;
  /** Break the next streamed chat answer off with an error event after the first words. */
  streamError?: boolean;
  /** Answer the next chat request with `finish_reason: content_filter`. */
  contentFilter?: boolean;
  /** Break the next speech answer off after this many bytes, without finishing the response. */
  ttsTruncateAfter?: number;
  /** How long to wait between the chunks of a speech answer (ms). */
  ttsChunkDelayMs?: number;
  /** Milliseconds of audio per spoken character (default 40). */
  ttsMsPerChar?: number;
  /** What recognition returns; a function sees the uploaded audio's size. */
  asrText?: string | ((bytes: number) => string);
  /** Wait before every answer (ms). */
  delayMs?: number;
};

export const MOCK_DEEPSEEK_MODELS = [
  { id: "deepseek-flash", object: "model", owned_by: "deepseek", context_window: 1_048_576, max_output_tokens: 393_216, input_modalities: ["text", "image"], effort: { supported_levels: ["low", "high", "max"], default_level: "high" } },
  { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek", context_window: 1_048_576, max_output_tokens: 393_216, input_modalities: ["text"], effort: { supported_levels: ["low", "high", "max"], default_level: "high" } },
];

/** The text of the real service's refusal when a tool loop does not send the thinking back (as documented; matched loosely by callers). */
export const MISSING_REASONING_MESSAGE = "The `reasoning_content` in the thinking mode must be passed back to the API.";

const SAMPLE_RATE = 24_000;

function pcm(ms: number): Buffer {
  const samples = Math.max(1, Math.round((ms / 1000) * SAMPLE_RATE));
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 6000), i * 2);
  return out;
}

export function startMockDeepSeek(options: MockDeepSeekOptions = {}): Promise<{
  url: string;
  close: () => Promise<void>;
  requests: MockDeepSeekRequest[];
  /** Requests to a path (all paths when left out). */
  count: (path?: string) => number;
  options: MockDeepSeekOptions;
}> {
  const requests: MockDeepSeekRequest[] = [];
  const fail = [...(options.fail ?? [])];
  const takeFailure = (path: string): number | undefined => {
    const index = fail.findIndex((item) => path.endsWith(item.path));
    if (index < 0) return undefined;
    const item = fail[index]!;
    item.times = (item.times ?? 1) - 1;
    if (item.times <= 0) fail.splice(index, 1);
    return item.status;
  };
  const error = (res: http.ServerResponse, status: number, message: string) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message, type: status === 401 ? "authentication_error" : status === 402 ? "insufficient_balance" : "invalid_request_error", code: String(status) } }));
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        const raw = Buffer.concat(chunks);
        const path = (req.url ?? "/").split("?")[0]!;
        const contentType = String(req.headers["content-type"] ?? "");
        let body: Record<string, unknown> | null = null;
        if (contentType.includes("json") && raw.length) { try { body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; } catch { body = null; } }
        const record: MockDeepSeekRequest = { method: req.method ?? "GET", path, body, bytes: raw.length, contentType, at: Date.now() };
        requests.push(record);
        if (options.key && req.headers.authorization !== `Bearer ${options.key}`) return error(res, 401, "Authentication Fails, Your api key is invalid");
        const forced = takeFailure(path);
        if (forced) return error(res, forced, forced === 402 ? "Insufficient Balance" : forced === 429 ? "Rate Limit Reached" : forced === 503 ? "Server Overloaded" : `HTTP ${forced}`);

        if (req.method === "GET" && path.endsWith("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ object: "list", data: options.models ?? MOCK_DEEPSEEK_MODELS }));
        }
        if (path.endsWith("/chat/completions")) return chat(body ?? {}, res);
        if (path.endsWith("/v1/tools/asr")) {
          record.fields = [...raw.toString("latin1").matchAll(/[; ]name="([^"]+)"/g)].map((match) => match[1]!);
          if (!contentType.startsWith("multipart/form-data")) return error(res, 400, "file is required");
          if (raw.length > 8 * 1024 * 1024 + 4096) return error(res, 413, "file too large");
          const audio = Math.max(0, raw.length - 300);
          const text = typeof options.asrText === "function" ? options.asrText(audio) : options.asrText ?? "这是一段合成的测试语音。";
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ text, duration_ms: Math.round((audio / 32_000) * 1000) }));
        }
        if (path.endsWith("/v1/tools/tts")) {
          const text = typeof body?.text === "string" ? body.text : "";
          if (!text.trim()) return error(res, 400, "text must not be empty");
          if (billedChars(text) > 10_000) return error(res, 400, "text too long");
          const format = body?.format === "wav" ? "wav" : "pcm";
          const audio = pcm(Math.min(60_000, [...text].length * (options.ttsMsPerChar ?? 40)));
          res.writeHead(200, { "content-type": format === "pcm" ? "audio/pcm" : "audio/wav", "transfer-encoding": "chunked" });
          const cut = options.ttsTruncateAfter;
          options.ttsTruncateAfter = undefined;
          const step = 4800;
          for (let offset = 0; offset < audio.length; offset += step) {
            // What was written goes out first, so the answer breaks off in the middle rather than before it starts.
            if (cut !== undefined && offset >= cut) { await new Promise((resolve) => setTimeout(resolve, 20)); res.socket?.destroy(); return; }
            res.write(audio.subarray(offset, offset + step));
            if (options.ttsChunkDelayMs) await new Promise((resolve) => setTimeout(resolve, options.ttsChunkDelayMs));
          }
          return res.end();
        }
        if (path.endsWith("/v1/tools/search")) {
          const query = typeof body?.query === "string" ? body.query : "";
          if (!query.trim() || [...query].length > 128) return error(res, 400, "query must be 1-128 characters");
          const count = Math.min(50, Math.max(1, Number(body?.count ?? 10)));
          const results = query.includes("没有结果") ? [] : Array.from({ length: Math.min(count, 3) }, (_, i) => ({
            title: `${query} 的结果 ${i + 1}`, url: `https://example.org/${encodeURIComponent(query)}/${i + 1}`, site_name: "示例网站", published_at: "2026-11-01T00:00:00Z",
            snippet: `关于 ${query} 的摘要 ${i + 1}。`, summary: `关于 ${query} 的较长摘要 ${i + 1}，包含更多内容。`, authority: 0.5,
          }));
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ results }));
        }
        error(res, 404, "not found");
      })().catch(() => { try { res.destroy(); } catch { /* gone */ } });
    });
  });

  function chat(body: Record<string, unknown>, res: http.ServerResponse) {
    const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
    const tools = Array.isArray(body.tools) ? body.tools as Array<{ type?: string }> : [];
    const functions = tools.filter((tool) => tool.type === "function");
    const search = tools.some((tool) => tool.type === "deepseek_web_search");
    const thinking = (body.thinking as { type?: string } | undefined)?.type !== "disabled";
    // The real service refuses a function name outside this pattern (a command id such as `library.find`), with this text (2026-11-16).
    const badName = functions.findIndex((tool) => !/^[a-zA-Z0-9_-]+$/.test(String((tool as { function?: { name?: unknown } }).function?.name ?? "")));
    if (badName >= 0) return error(res, 400, `Invalid 'tools[${tools.indexOf(functions[badName]!)}].function.name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'. (request_id: mock)`);
    if (search && functions.length && !thinking) return error(res, 400, "Function tools can only be used together with deepseek_web_search, deepseek_read_url, safety_check or title in thinking mode.");
    if (thinking && (functions.length || search)) {
      const turnStart = messages.map((message) => message.role).lastIndexOf("user");
      const missing = messages.findIndex((message, index) => index > turnStart && message.role === "assistant" && Array.isArray(message.tool_calls) && !("reasoning_content" in message));
      if (missing >= 0) return error(res, 400, MISSING_REASONING_MESSAGE);
    }
    const stream = body.stream === true;
    const scripted = functions.length && options.toolScript?.length ? options.toolScript.shift() : undefined;
    const filtered = options.contentFilter; options.contentFilter = false;
    const broken = stream && options.streamError; if (stream) options.streamError = false;
    const reasoning = thinking ? "先想一想该怎么做。" : undefined;
    const answer = (typeof options.answer === "function" ? options.answer() : options.answer) ?? "好的，已经完成。";
    const searchEvents = search && !scripted ? [
      { type: "call_started", step: 0, call: { index: 0, id: "srv_1", type: "deepseek_web_search", kind: "deep_search", action: { type: "search", queries: ["合成的搜索词"] } } },
      { type: "call_completed", step: 0, call: { index: 0, id: "srv_1", status: "completed", sources: [{ type: "url", url: "https://example.org/a", title: "示例来源 A", snippet: "摘要 A", site_name: "示例网站", published_at: "2026-11-01T00:00:00+00:00" }] } },
      { type: "call_started", step: 1, call: { index: 0, id: "srv_2", type: "deepseek_web_search", kind: "deep_search", action: { type: "open_page", url: "https://example.org/a" } } },
      { type: "call_completed", step: 1, call: { index: 0, id: "srv_2", status: "completed", page: { url: "https://example.org/a", title: "示例来源 A", published_at: null } } },
    ] : [];
    const serverToolCalls = searchEvents.length ? [{ index: 0, reasoning_content: "搜索一下。", calls: [{ index: 0, id: "srv_1", type: "deepseek_web_search", kind: "deep_search", action: { type: "search", queries: ["合成的搜索词"] }, status: "completed", sources: [{ type: "url", url: "https://example.org/a", title: "示例来源 A" }] }] }] : undefined;
    const annotations = searchEvents.length ? [{ type: "url_citation", url_citation: { url: "https://example.org/a", title: "示例来源 A", start_index: 0, end_index: Math.min(4, [...answer].length) } }] : undefined;
    const usage = { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 8, ...(searchEvents.length ? { server_tool_use: { tool_search: 1, tool_fetch: 0, tool_image_search: 0 } } : {}) };
    const toolCalls = scripted ? [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 10)}`, type: "function", function: { name: scripted.name, arguments: scripted.arguments } }] : undefined;
    if (!stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        id: "chat_1", object: "chat.completion", model: body.model,
        choices: [{ index: 0, finish_reason: filtered ? "content_filter" : toolCalls ? "tool_calls" : "stop", message: { role: "assistant", content: toolCalls || filtered ? "" : answer, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls ? { tool_calls: toolCalls.map(({ index: _index, ...call }) => call) } : {}), ...(annotations ? { annotations } : {}), ...(serverToolCalls ? { server_tool_calls: serverToolCalls } : {}) } }],
        usage,
      }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) => res.write(`data: ${JSON.stringify({ id: "chat_1", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, ...choice }], ...extra })}\n\n`);
    send({ delta: { role: "assistant", content: null, reasoning_content: "" } });
    if (reasoning) send({ delta: { content: null, reasoning_content: reasoning } });
    for (const event of searchEvents) send({ delta: {}, server_tool_event: event });
    if (broken) {
      send({ delta: { content: "答" } });
      res.write(`data: ${JSON.stringify({ error: { message: "Internal error", type: "server_error" } })}\n\n`);
      return res.end();
    }
    if (filtered) { send({ delta: {}, finish_reason: "content_filter" }, { usage }); return res.end("data: [DONE]\n\n"); }
    if (toolCalls) {
      send({ delta: { tool_calls: toolCalls } });
      send({ delta: {}, finish_reason: "tool_calls" }, { usage });
      return res.end("data: [DONE]\n\n");
    }
    const chars = [...answer];
    const half = Math.ceil(chars.length / 2);
    send({ delta: { content: chars.slice(0, half).join("") } });
    send({ delta: { content: chars.slice(half).join(""), ...(annotations ? { annotations } : {}), ...(serverToolCalls ? { server_tool_calls: serverToolCalls } : {}) }, finish_reason: "stop" }, { usage });
    res.end("data: [DONE]\n\n");
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
        requests,
        count: (path) => requests.filter((request) => !path || request.path.endsWith(path)).length,
        options,
      });
    });
  });
}
