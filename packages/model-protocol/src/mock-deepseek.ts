import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { speechBilledChars as billedChars } from "./deepseek-services.ts";

/**
 * Local deterministic DeepSeek mock server for unit tests and packaged walkthroughs:
 * `GET /models`, `GET /user/balance`, `POST /chat/completions` (thinking, `reasoning_content` loop check,
 * `deepseek_web_search`, `deepseek_read_url`, `find_in_page`, `image_search`, inline `title`, `latest_reminder`,
 * continuation prefill, `safety_check` / `refusal`, `content_filter`, stream error, flat `file_id` check,
 * `deepseek-v4-pro` server-tool guard), `POST/DELETE /v1/files`, `POST /v1/tools/asr`,
 * `POST /v1/tools/tts` + WebSocket `GET /v1/tools/tts`, `POST /v1/tools/search`, `POST /v1/tools/fetch`,
 * and `POST /v1/tools/ocr`. Never sends outbound traffic.
 */
export type MockDeepSeekRequest = {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  bytes: number;
  contentType: string;
  fields?: string[];
  at: number;
};

export type MockDeepSeekOptions = {
  /** The only key accepted; any other gets a 401. Without it every key is accepted. */
  key?: string;
  /** What `GET /models` lists; the default is the two chat models as the real service lists them. */
  models?: Array<Record<string, unknown>>;
  /** Tool calls to make one after another, one per request that offers function tools; when empty the model answers in text. */
  toolScript?: Array<{ name: string; arguments: string }>;
  /** What the model answers in text; a function gives each answer its own. */
  answer?: string | (() => string);
  /** Inline title returned when `title: { enabled: true }` is sent (default `"合成会话标题"`). */
  title?: string;
  /** A status to answer the next requests to a path with (`/chat/completions`, `/v1/tools/*`, `/v1/files`, `/user/balance`, `/models`), `times` times (default once). */
  fail?: Array<{ path: string; status: number; times?: number }>;
  /** Break the next streamed chat answer off with an error event after the first words. */
  streamError?: boolean;
  /** Answer the next chat request with `finish_reason: content_filter`. */
  contentFilter?: boolean;
  /** Answer the next chat request with `finish_reason: refusal`. */
  refusal?: boolean;
  /** Include a `find_in_page` step in simulated web search responses. */
  includeFindInPage?: boolean;
  /** Include an `image_search` step in simulated web search responses. */
  includeImageSearch?: boolean;
  /** Break the next HTTP speech answer off after this many bytes, without finishing the response. */
  ttsTruncateAfter?: number;
  /** Simulate a WebSocket TTS finish error code (e.g. `content_filter`, `invalid_input`, `service_error`). */
  ttsWsErrorCode?: string;
  /** How long to wait between chunks of a speech answer (ms). */
  ttsChunkDelayMs?: number;
  /** Milliseconds of audio per spoken character (default 40). */
  ttsMsPerChar?: number;
  /** What recognition returns; a function sees the uploaded audio's size. */
  asrText?: string | ((bytes: number) => string);
  /** What OCR returns; a function sees the uploaded file size and purpose. */
  ocrText?: string | ((bytes: number, purpose: string) => string);
  /** Custom `/user/balance` payload override. */
  balance?: { is_available: boolean; balance_infos: Array<{ currency: string; total_balance: string; granted_balance?: string; topped_up_balance?: string }> };
  /** Wait before every answer (ms). */
  delayMs?: number;
};

export const MOCK_DEEPSEEK_MODELS = [
  {
    id: "deepseek-flash",
    object: "model",
    owned_by: "deepseek",
    name: "DeepSeek-V4.1-Flash",
    context_window: 1_048_576,
    max_output_tokens: 393_216,
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
  },
  {
    id: "deepseek-v4-pro",
    object: "model",
    owned_by: "deepseek",
    name: "DeepSeek-V4-Pro",
    context_window: 1_048_576,
    max_output_tokens: 393_216,
    input_modalities: ["text"],
    output_modalities: ["text"],
    effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
  },
];

/** The text of the real service's refusal when a tool loop does not send the thinking back. */
export const MISSING_REASONING_MESSAGE = "The `reasoning_content` in the thinking mode must be passed back to the API.";

const SAMPLE_RATE = 24_000;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const LATEST_REMINDER_PATTERN = /^\d{4}-\d{2}-\d{2},[^,]+,[^,]*,(?:App|Web),[^,]+$/;

function pcm(ms: number): Buffer {
  const samples = Math.max(1, Math.round((ms / 1000) * SAMPLE_RATE));
  const out = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE) * 6000), i * 2);
  return out;
}

/** Encodes a single unmasked server-to-client RFC 6455 WebSocket frame. */
function encodeWsFrame(opcode: number, payload: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | (opcode & 0x0f);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Parses complete client-to-server RFC 6455 frames from a streaming byte buffer. */
function decodeWsFrames(buffer: Buffer): { frames: Array<{ opcode: number; payload: Buffer }>; rest: Buffer } {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset]!;
    const b1 = buffer[offset + 1]!;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let payloadLen = b1 & 0x7f;
    let pos = offset + 2;
    if (payloadLen === 126) {
      if (pos + 2 > buffer.length) break;
      payloadLen = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (payloadLen === 127) {
      if (pos + 8 > buffer.length) break;
      payloadLen = Number(buffer.readBigUInt64BE(pos));
      pos += 8;
    }
    const maskBytes = masked ? 4 : 0;
    if (pos + maskBytes + payloadLen > buffer.length) break;
    let payload = Buffer.from(buffer.subarray(pos + maskBytes, pos + maskBytes + payloadLen));
    if (masked) {
      const mask = buffer.subarray(pos, pos + 4);
      for (let i = 0; i < payload.length; i += 1) payload[i] = payload[i]! ^ mask[i % 4]!;
    }
    frames.push({ opcode, payload });
    offset = pos + maskBytes + payloadLen;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function parseMultipartMeta(raw: Buffer, contentType: string): { fields: string[]; purpose?: string; filename?: string; fileBytes: number; fileText: string } {
  const text = raw.toString("latin1");
  const fields = [...text.matchAll(/[; ]name="([^"]+)"/g)].map((match) => match[1]!);
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  let purpose: string | undefined;
  let filename: string | undefined;
  let fileBytes = Math.max(0, raw.length - 300);
  let fileText = "";
  if (boundary) {
    const parts = raw.toString("utf8").split(`--${boundary}`);
    for (const part of parts) {
      const splitAt = part.indexOf("\r\n\r\n");
      if (splitAt < 0) continue;
      const headers = part.slice(0, splitAt);
      const body = part.slice(splitAt + 4).replace(/\r\n$/, "");
      const nameMatch = /name="([^"]+)"/.exec(headers);
      if (!nameMatch) continue;
      if (nameMatch[1] === "purpose") purpose = body.trim();
      if (nameMatch[1] === "file") {
        filename = /filename="([^"]+)"/.exec(headers)?.[1];
        fileBytes = Buffer.byteLength(body, "utf8");
        fileText = body;
      }
    }
  }
  return { fields, purpose, filename, fileBytes, fileText };
}

export function startMockDeepSeek(options: MockDeepSeekOptions = {}): Promise<{
  url: string;
  close: () => Promise<void>;
  requests: MockDeepSeekRequest[];
  /** Requests to a path (all paths when left out). */
  count: (path?: string) => number;
  /** Uploaded mock files keyed by `file-api-...` id (tests can delete/expire entries directly). */
  files: Map<string, { id: string; filename: string; bytes: number; purpose?: string; text: string }>;
  options: MockDeepSeekOptions;
}> {
  const requests: MockDeepSeekRequest[] = [];
  const files = new Map<string, { id: string; filename: string; bytes: number; purpose?: string; text: string }>();
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
    res.end(JSON.stringify({
      error: {
        message,
        type: status === 401 ? "authentication_error" : status === 402 ? "insufficient_balance" : "invalid_request_error",
        code: String(status),
      },
    }));
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
        if (contentType.includes("json") && raw.length) {
          try { body = JSON.parse(raw.toString("utf8")) as Record<string, unknown>; } catch { body = null; }
        }
        const record: MockDeepSeekRequest = { method: req.method ?? "GET", path, body, bytes: raw.length, contentType, at: Date.now() };
        requests.push(record);
        if (options.key && req.headers.authorization !== `Bearer ${options.key}`) return error(res, 401, "Authentication Fails, Your api key is invalid");
        const forced = takeFailure(path);
        if (forced) return error(res, forced, forced === 402 ? "Insufficient Balance" : forced === 429 ? "Rate Limit Reached" : forced === 503 ? "Server Overloaded" : `HTTP ${forced}`);

        if (req.method === "GET" && path.endsWith("/models")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ object: "list", data: options.models ?? MOCK_DEEPSEEK_MODELS }));
        }
        if (req.method === "GET" && path.endsWith("/user/balance")) {
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify(options.balance ?? {
            is_available: true,
            balance_infos: [{ currency: "CNY", total_balance: "100.00", granted_balance: "10.00", topped_up_balance: "90.00" }],
          }));
        }
        if (path.endsWith("/chat/completions")) return chat(body ?? {}, res);

        if (req.method === "POST" && path.endsWith("/v1/files")) {
          const meta = parseMultipartMeta(raw, contentType);
          record.fields = meta.fields;
          if (!contentType.startsWith("multipart/form-data") || !meta.fields.includes("file")) {
            return error(res, 400, "file is required");
          }
          const purposeIdx = meta.fields.indexOf("purpose");
          const fileIdx = meta.fields.indexOf("file");
          if (purposeIdx >= 0 && purposeIdx > fileIdx) {
            return error(res, 400, "multipart field 'purpose' must precede 'file'");
          }
          const id = `file-api-mock-${randomUUID().slice(0, 8)}`;
          const entry = {
            id,
            filename: meta.filename ?? "upload.bin",
            bytes: meta.fileBytes,
            ...(meta.purpose ? { purpose: meta.purpose } : {}),
            text: meta.fileText,
          };
          files.set(id, entry);
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({
            id,
            object: "file",
            bytes: entry.bytes,
            created_at: Math.floor(Date.now() / 1000),
            filename: entry.filename,
            ...(entry.purpose ? { purpose: entry.purpose } : {}),
          }));
        }

        const deleteFileMatch = /\/v1\/files\/([^/]+)$/.exec(path);
        if (req.method === "DELETE" && deleteFileMatch) {
          const fileId = decodeURIComponent(deleteFileMatch[1]!);
          const existed = files.delete(fileId);
          if (!existed) return error(res, 404, `File ${fileId} not found`);
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ id: fileId, object: "file", deleted: true }));
        }

        if (path.endsWith("/v1/tools/asr")) {
          record.fields = [...raw.toString("latin1").matchAll(/[; ]name="([^"]+)"/g)].map((match) => match[1]!);
          if (!contentType.startsWith("multipart/form-data")) return error(res, 400, "file is required");
          if (raw.length > 8 * 1024 * 1024 + 4096) return error(res, 413, "file too large");
          const audio = Math.max(0, raw.length - 300);
          const text = typeof options.asrText === "function" ? options.asrText(audio) : options.asrText ?? "这是一段合成的测试语音。";
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ text, duration_ms: Math.round((audio / 32_000) * 1000) }));
        }

        if (path.endsWith("/v1/tools/ocr")) {
          const meta = parseMultipartMeta(raw, contentType);
          record.fields = meta.fields;
          if (!contentType.startsWith("multipart/form-data") || !meta.fields.includes("file")) {
            return error(res, 400, "file is required");
          }
          if (!meta.purpose || (meta.purpose !== "text_recognition" && meta.purpose !== "rich_layout_recognition")) {
            return error(res, 400, "'purpose' is a required property");
          }
          const recognized = typeof options.ocrText === "function"
            ? options.ocrText(meta.fileBytes, meta.purpose)
            : options.ocrText ?? "合成文档识别正文 42";
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({
            id: `ocr-mock-${randomUUID().slice(0, 8)}`,
            object: "ocr.result",
            created: Math.floor(Date.now() / 1000),
            purpose: meta.purpose,
            page_count: 1,
            pages: [{ index: 0, text: recognized, finish_reason: "stop" }],
            usage: { input_tokens: 110, output_tokens: 12, total_tokens: 122 },
          }));
        }

        if (path.endsWith("/v1/tools/fetch")) {
          const targetUrl = typeof body?.url === "string" ? body.url.trim() : "";
          if (!/^https?:\/\//i.test(targetUrl)) return error(res, 400, "url must be http or https");
          let host = "example.org";
          try { host = new URL(targetUrl).hostname.replace(/^www\./, ""); } catch { /* fallback */ }
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({
            title: `示例页面 · ${host}`,
            content: `# 示例页面\n\n来自 ${targetUrl} 的提取正文。`,
            site_name: host,
            site_icon: `https://${host}/favicon.ico`,
          }));
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
          const needContent = body?.need_content === true;
          const results = query.includes("没有结果") ? [] : Array.from({ length: Math.min(count, 3) }, (_, i) => ({
            title: `${query} 的结果 ${i + 1}`,
            url: `https://example.org/${encodeURIComponent(query)}/${i + 1}`,
            site_name: "示例网站",
            site_icon: "https://example.org/favicon.ico",
            published_at: "2026-11-01T00:00:00Z",
            snippet: `关于 ${query} 的摘要 ${i + 1}。`,
            summary: `关于 ${query} 的较长摘要 ${i + 1}，包含更多内容。`,
            ...(needContent ? { content: `# ${query} 正文 ${i + 1}\n\n这是完整的抓取正文内容。` } : {}),
            authority: 0.5,
          }));
          res.writeHead(200, { "content-type": "application/json" });
          return res.end(JSON.stringify({ results }));
        }

        error(res, 404, "not found");
      })().catch(() => { try { res.destroy(); } catch { /* gone */ } });
    });
  });

  // RFC 6455 WebSocket upgrade handler for `/v1/tools/tts` streaming synthesis tests.
  const sockets = new Set<Duplex>();
  server.on("upgrade", (req, socket: Duplex) => {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!reqUrl.pathname.endsWith("/v1/tools/tts")) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const rawProtocols = String(req.headers["sec-websocket-protocol"] ?? "").split(",").map((p) => p.trim()).filter(Boolean);
    const bearerProto = rawProtocols.find((p) => p.startsWith("bearer."))?.slice("bearer.".length);
    const authHeader = req.headers.authorization;
    const token = bearerProto ?? (authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined);
    if (options.key && token !== options.key) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const wsKey = req.headers["sec-websocket-key"];
    if (!wsKey) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(wsKey + WS_GUID).digest("base64");
    const negotiated = rawProtocols.includes("tts") ? "Sec-WebSocket-Protocol: tts\r\n" : "";
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n${negotiated}\r\n`,
    );
    sockets.add(socket);
    requests.push({
      method: "WS",
      path: reqUrl.pathname,
      body: { voice_id: reqUrl.searchParams.get("voice_id"), format: reqUrl.searchParams.get("format"), filter_markdown: reqUrl.searchParams.get("filter_markdown") },
      bytes: 0,
      contentType: "websocket",
      at: Date.now(),
    });

    let rx: Buffer = Buffer.alloc(0);
    let receivedText = "";
    socket.on("close", () => { sockets.delete(socket); });
    socket.on("error", () => { sockets.delete(socket); });
    socket.on("data", (chunk: Buffer) => {
      rx = Buffer.concat([rx, chunk]);
      const { frames, rest } = decodeWsFrames(rx);
      rx = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          try { socket.write(encodeWsFrame(0x8, Buffer.alloc(0))); } catch { /* closing */ }
          socket.end();
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeWsFrame(0xA, frame.payload));
          continue;
        }
        if (frame.opcode !== 0x1) continue;
        let msg: { event?: string; text?: string } | null = null;
        try { msg = JSON.parse(frame.payload.toString("utf8")) as { event?: string; text?: string }; } catch { msg = null; }
        if (msg?.event === "text" && typeof msg.text === "string") {
          receivedText += msg.text;
          const audio = pcm(Math.max(40, Math.min(1000, [...msg.text].length * (options.ttsMsPerChar ?? 40))));
          const half = Math.max(2, Math.floor(audio.length / 2));
          // Send intentionally unaligned chunks (odd byte boundary) to exercise client 16-bit PCM carry logic.
          const split = half % 2 === 0 ? half - 1 : half;
          socket.write(encodeWsFrame(0x2, audio.subarray(0, split)));
          socket.write(encodeWsFrame(0x2, audio.subarray(split)));
        } else if (msg?.event === "finish_text") {
          const forcedErr = options.ttsWsErrorCode;
          options.ttsWsErrorCode = undefined;
          const payload = forcedErr
            ? JSON.stringify({ event: "finish", code: forcedErr, message: `simulated ${forcedErr}` })
            : JSON.stringify({ event: "finish", code: "success", message: "completed", chars: receivedText.length });
          socket.write(encodeWsFrame(0x1, Buffer.from(payload, "utf8")));
          socket.write(encodeWsFrame(0x8, Buffer.alloc(0)));
          socket.end();
        }
      }
    });
  });

  function chat(body: Record<string, unknown>, res: http.ServerResponse) {
    const model = String(body.model ?? "");
    const messages = Array.isArray(body.messages) ? body.messages as Array<Record<string, unknown>> : [];
    const tools = Array.isArray(body.tools) ? body.tools as Array<{ type?: string }> : [];
    const functions = tools.filter((tool) => tool.type === "function");
    const search = tools.some((tool) => tool.type === "deepseek_web_search");
    const readUrl = tools.some((tool) => tool.type === "deepseek_read_url");
    const wantTitle = Boolean((body.title as { enabled?: boolean } | undefined)?.enabled);
    const thinking = (body.thinking as { type?: string } | undefined)?.type !== "disabled";

    // Live DeepSeek contract: `deepseek-v4-pro` rejects server-side tools and inline title generation with HTTP 400.
    if (model === "deepseek-v4-pro" && (search || readUrl || wantTitle)) {
      return error(res, 400, "The server-side tool calls (deepseek_web_search, deepseek_read_url) and the title generation feature are unavailable for model deepseek-v4-pro. Please use deepseek-flash instead.");
    }

    // Validate `latest_reminder` messages the same way the live service does.
    for (const [idx, message] of messages.entries()) {
      if (message.role === "latest_reminder") {
        const content = String(message.content ?? "");
        if (!LATEST_REMINDER_PATTERN.test(content)) {
          return error(res, 400, `Invalid 'messages[${idx}].content': expected '<date>,<weekday>,<location>,<App|Web>,<language>'`);
        }
      }
      if (message.role === "user" && Array.isArray(message.content)) {
        for (const [pIdx, part] of (message.content as Array<Record<string, unknown>>).entries()) {
          if (part?.type !== "file") continue;
          const fileId = typeof part.file_id === "string" ? part.file_id : undefined;
          if (!fileId) {
            return error(res, 400, `.messages[${idx}].content[${pIdx}]: file must have a file_id or file_data`);
          }
          if (!files.has(fileId)) {
            return error(res, 400, `Invalid file_id: file ${fileId} not found or expired`);
          }
        }
      }
    }

    const badName = functions.findIndex((tool) => !/^[a-zA-Z0-9_-]+$/.test(String((tool as { function?: { name?: unknown } }).function?.name ?? "")));
    if (badName >= 0) return error(res, 400, `Invalid 'tools[${tools.indexOf(functions[badName]!)}].function.name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'. (request_id: mock)`);
    if (search && functions.length && !thinking) return error(res, 400, "tools: client tools can only be used together with `deepseek_web_search` in thinking mode");
    if (thinking && (functions.length || search)) {
      const turnStart = messages.map((message) => message.role).lastIndexOf("user");
      const missing = messages.findIndex((message, index) => index > turnStart && message.role === "assistant" && Array.isArray(message.tool_calls) && !("reasoning_content" in message));
      if (missing >= 0) return error(res, 400, MISSING_REASONING_MESSAGE);
    }

    const stream = body.stream === true;
    const scripted = functions.length && options.toolScript?.length ? options.toolScript.shift() : undefined;
    const filtered = options.contentFilter; options.contentFilter = false;
    const refused = options.refusal; options.refusal = false;
    const broken = stream && options.streamError; if (stream) options.streamError = false;
    const reasoning = thinking ? "先想一想该怎么做。" : undefined;
    const lastMessage = messages[messages.length - 1];
    const isContinuation = lastMessage?.role === "assistant" && typeof lastMessage.content === "string" && lastMessage.content.length > 0 && !Array.isArray(lastMessage.tool_calls);
    const defaultAnswer = isContinuation ? "继续写完剩余部分。" : "好的，已经完成。";
    const answer = (typeof options.answer === "function" ? options.answer() : options.answer) ?? defaultAnswer;
    const inlineTitle = wantTitle && !scripted && !filtered && !refused ? (options.title ?? "合成会话标题") : undefined;

    const searchEvents: Array<Record<string, unknown>> = [];
    if (!scripted) {
      if (readUrl) {
        const userText = messages.filter((m) => m.role === "user").map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
        const urlMatch = /https?:\/\/[^\s]+/i.exec(userText);
        const linkUrl = urlMatch?.[0] ?? "https://example.org/linked";
        searchEvents.push(
          { type: "step_reasoning_done" },
          { type: "call_started", step: 0, call: { index: 0, id: "srv_read_1", type: "deepseek_read_url", kind: "read_link", action: { type: "read_link", url: linkUrl } } },
          { type: "call_completed", step: 0, call: { index: 0, id: "srv_read_1", status: "completed", page: { url: linkUrl, title: "示例链接页面", site_name: "示例网站", site_icon: "https://example.org/favicon.ico", published_at: "2026-11-01" } } },
        );
      }
      if (search) {
        searchEvents.push(
          { type: "call_started", step: 0, call: { index: 0, id: "srv_1", type: "deepseek_web_search", kind: "deep_search", action: { type: "search", queries: ["合成的搜索词"] } } },
          { type: "call_completed", step: 0, call: { index: 0, id: "srv_1", status: "completed", sources: [{ type: "url", url: "https://example.org/a", title: "示例来源 A", snippet: "摘要 A", site_name: "示例网站", site_icon: "https://example.org/favicon.ico", published_at: "2026-11-01T00:00:00+00:00" }] } },
          { type: "call_started", step: 1, call: { index: 0, id: "srv_2", type: "deepseek_web_search", kind: "deep_search", action: { type: "open_page", url: "https://example.org/a" } } },
          { type: "call_completed", step: 1, call: { index: 0, id: "srv_2", status: "completed", page: { url: "https://example.org/a", title: "示例来源 A", site_icon: "https://example.org/favicon.ico", published_at: null } } },
        );
        if (options.includeFindInPage) {
          searchEvents.push(
            { type: "call_started", step: 2, call: { index: 0, id: "srv_3", type: "deepseek_web_search", kind: "deep_search", action: { type: "find_in_page", url: "https://example.org/a", pattern: "灯塔" } } },
            { type: "call_completed", step: 2, call: { index: 0, id: "srv_3", status: "completed", found: true } },
          );
        }
        if (options.includeImageSearch) {
          searchEvents.push(
            { type: "call_started", step: 3, call: { index: 0, id: "srv_4", type: "deepseek_web_search", kind: "image_search", action: { type: "search", queries: ["雾湾灯塔插画"] } } },
            { type: "call_completed", step: 3, call: { index: 0, id: "srv_4", status: "completed", sources: [{ type: "url", url: "https://example.org/img", title: "雾湾灯塔图", site_icon: "https://example.org/favicon.ico" }] } },
          );
        }
      }
    }

    const serverToolCalls = searchEvents.length ? [{
      index: 0,
      reasoning_content: "搜索一下。",
      calls: [{
        index: 0,
        id: search ? "srv_1" : "srv_read_1",
        type: search ? "deepseek_web_search" : "deepseek_read_url",
        kind: search ? "deep_search" : "read_link",
        action: search ? { type: "search", queries: ["合成的搜索词"] } : { type: "read_link", url: "https://example.org/linked" },
        status: "completed",
        sources: [{ type: "url", url: "https://example.org/a", title: "示例来源 A", site_icon: "https://example.org/favicon.ico" }],
      }],
    }] : undefined;
    const annotations = search && !scripted
      ? [{ type: "url_citation", url_citation: { url: "https://example.org/a", title: "示例来源 A", start_index: 0, end_index: Math.min(4, [...answer].length) } }]
      : undefined;
    const usage = {
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
      prompt_cache_hit_tokens: 4,
      prompt_cache_miss_tokens: 8,
      ...(thinking ? { completion_tokens_details: { reasoning_tokens: 5, safety_tokens: 0 } } : {}),
      ...(searchEvents.length ? { server_tool_use: { tool_search: search ? 1 : 0, tool_fetch: readUrl ? 1 : 0, tool_image_search: options.includeImageSearch && search ? 1 : 0 } } : {}),
    };
    const toolCalls = scripted ? [{ index: 0, id: `call_${Math.random().toString(36).slice(2, 10)}`, type: "function", function: { name: scripted.name, arguments: scripted.arguments } }] : undefined;

    if (!stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        id: "chat_1",
        object: "chat.completion",
        model: body.model,
        choices: [{
          index: 0,
          finish_reason: filtered ? "content_filter" : refused ? "refusal" : toolCalls ? "tool_calls" : "stop",
          message: {
            role: "assistant",
            content: toolCalls || filtered || refused ? "" : answer,
            ...(refused ? { refusal: "无法提供相关内容。" } : {}),
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(inlineTitle ? { title: inlineTitle } : {}),
            ...(toolCalls ? { tool_calls: toolCalls.map(({ index: _index, ...call }) => call) } : {}),
            ...(annotations ? { annotations } : {}),
            ...(serverToolCalls ? { server_tool_calls: serverToolCalls } : {}),
          },
        }],
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
    if (refused) { send({ delta: { refusal: "无法提供相关内容。" }, finish_reason: "refusal" }, { usage }); return res.end("data: [DONE]\n\n"); }
    if (toolCalls) {
      send({ delta: { tool_calls: toolCalls } });
      send({ delta: {}, finish_reason: "tool_calls" }, { usage });
      return res.end("data: [DONE]\n\n");
    }
    const chars = [...answer];
    const half = Math.ceil(chars.length / 2);
    send({ delta: { content: chars.slice(0, half).join("") } });
    if (inlineTitle) send({ delta: { title: inlineTitle } });
    send({ delta: { content: chars.slice(half).join(""), ...(annotations ? { annotations } : {}), ...(serverToolCalls ? { server_tool_calls: serverToolCalls } : {}) }, finish_reason: "stop" }, { usage });
    res.end("data: [DONE]\n\n");
  }

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => {
          for (const socket of sockets) { try { socket.destroy(); } catch { /* closing */ } }
          sockets.clear();
          server.closeAllConnections();
          server.close(() => done());
        }),
        requests,
        count: (path) => requests.filter((request) => !path || request.path.endsWith(path)).length,
        files,
        options,
      });
    });
  });
}
