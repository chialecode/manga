import { afterEach, describe, expect, it } from "vitest";
import { MangaError } from "@manga/contracts";
import {
  aggregateServerToolSteps,
  classifyAgentError,
  completeText,
  createDeepSeekTtsStream,
  deleteDeepSeekFile,
  extractExpiredFileIds,
  fetchDeepSeekBalance,
  fetchDeepSeekWeb,
  formatLatestReminder,
  inferDeepSeekFilePurpose,
  mapHttpError,
  ocrDeepSeekDocument,
  searchDeepSeek,
  searchDeepSeekWeb,
  startMockDeepSeek,
  streamText,
  stripMarkdownForSpeech,
  uploadDeepSeekFile,
  usesDeepSeekExtendedStream,
  type ServerToolEvent,
  type StreamEvent,
  type TextRequest,
} from "@manga/model-protocol";

let server: Awaited<ReturnType<typeof startMockDeepSeek>> | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function collect(events: AsyncGenerator<StreamEvent>) {
  let text = "";
  let reasoning = "";
  let titleDeltas = "";
  let stepReasoningDone = 0;
  const serverEvents: ServerToolEvent[] = [];
  let completed: Extract<StreamEvent, { type: "completed" }> | undefined;
  for await (const event of events) {
    if (event.type === "text-delta") text += event.text;
    else if (event.type === "reasoning-delta") reasoning += event.text;
    else if (event.type === "title-delta") titleDeltas += event.text;
    else if (event.type === "step-reasoning-done") stepReasoningDone += 1;
    else if (event.type === "server-tool") serverEvents.push(event.event);
    else if (event.type === "completed") completed = event;
  }
  return { text, reasoning, titleDeltas, stepReasoningDone, serverEvents, completed };
}

describe.each(["native", "pi"] as const)("DeepSeek extended dialect parity on %s runtime", (runtime) => {
  it("parses all server_tool_event kinds, site_icon citations, reasoning_tokens, and server_tool_calls passback", async () => {
    server = await startMockDeepSeek({
      answer: "雾湾灯塔的最新报道。",
      includeFindInPage: true,
      includeImageSearch: true,
    });
    const req: TextRequest = {
      model: "deepseek-flash",
      dialect: "deepseek",
      reasoningEffort: "low",
      nativeWebSearch: true,
      readUrl: true,
      inlineTitle: true,
      safetyCheck: "high",
      latestReminder: formatLatestReminder(new Date("2026-11-27T12:00:00Z"), { language: "中文", platform: "App" }),
      messages: [{ role: "user", content: "读取 https://example.org/linked 并搜索雾湾灯塔。" }],
      tools: [{ name: "library.find", description: "find item", parameters: { type: "object", properties: { q: { type: "string" } } } }],
    };

    expect(usesDeepSeekExtendedStream("openai-chat-completions", req)).toBe(true);
    const result = await collect(streamText("openai-chat-completions", server.url, "sk-test", req, runtime));

    expect(result.text).toBe("雾湾灯塔的最新报道。");
    expect(result.titleDeltas).toBe("合成会话标题");
    expect(result.stepReasoningDone).toBe(1);
    expect(result.completed?.title).toBe("合成会话标题");
    expect(result.completed?.stopReason).toBe("end_turn");
    expect(result.completed?.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 8,
      cachedInputTokens: 4,
      reasoningTokens: 5,
      searches: 1,
      fetches: 1,
      imageSearches: 1,
    });
    expect(result.serverEvents.map((e) => e.kind)).toEqual([
      "read_link",
      "done",
      "search",
      "done",
      "open",
      "done",
      "find_in_page",
      "done",
      "image_search",
      "done",
    ]);
    const steps = result.completed?.serverToolSteps ?? [];
    expect(steps.map((s) => `${s.kind}:${s.status}`)).toEqual([
      "read_link:done",
      "search:done",
      "open_page:done",
      "find_in_page:done",
      "image_search:done",
    ]);
    expect(steps[0]?.pages?.[0]?.siteIcon).toBe("https://example.org/favicon.ico");
    expect(steps[3]?.keywords?.[0]).toMatchObject({ pattern: "灯塔", found: true });
    expect(result.completed?.citations?.[0]).toMatchObject({
      index: 1,
      url: "https://example.org/a",
      site: "示例网站",
      siteIcon: "https://example.org/favicon.ico",
      snippet: "摘要 A",
    });
    expect(result.completed?.serverToolCalls).toHaveLength(1);

    // Verify wire request shape (tools, title, safety_check, latest_reminder injected before user message).
    const body = server.requests.at(-1)!.body!;
    expect((body.tools as Array<{ type: string }>).map((t) => t.type)).toEqual([
      "function",
      "deepseek_web_search",
      "deepseek_read_url",
    ]);
    expect(body.title).toEqual({ enabled: true });
    expect(body.safety_check).toEqual({ level: "high" });
    const sentMessages = body.messages as Array<{ role: string; content: string }>;
    expect(sentMessages[0]).toEqual({ role: "latest_reminder", content: "2026-11-27,星期五,,App,中文" });
    expect(sentMessages[1]?.role).toBe("user");

    // Next turn passes `server_tool_calls` back cleanly on both runtimes.
    const follow = await completeText("openai-chat-completions", server.url, "sk-test", {
      model: "deepseek-flash",
      dialect: "deepseek",
      reasoningEffort: "low",
      nativeWebSearch: true,
      messages: [
        { role: "user", content: "搜索雾湾灯塔。" },
        { role: "assistant", content: result.text, serverToolCalls: result.completed!.serverToolCalls },
        { role: "user", content: "来源是哪个网站？" },
      ],
    }, runtime);
    expect(follow.text).toBe("雾湾灯塔的最新报道。");
    const assistantSent = (server.requests.at(-1)!.body!.messages as Array<Record<string, unknown>>).find((m) => m.role === "assistant")!;
    expect(assistantSent.server_tool_calls).toEqual(result.completed!.serverToolCalls);
  });

  it("supports continuation prefill with and without thinking", async () => {
    server = await startMockDeepSeek({});
    const contThink = await collect(streamText("openai-chat-completions", server.url, "sk-test", {
      model: "deepseek-flash",
      dialect: "deepseek",
      reasoningEffort: "low",
      continuePrefill: true,
      messages: [
        { role: "user", content: "写一段关于雾湾的描写。" },
        { role: "assistant", content: "雾湾的灯塔", reasoning: "继续描写灯塔。" },
      ],
    }, runtime));
    expect(contThink.text).toBe("继续写完剩余部分。");
    const lastThink = (server.requests.at(-1)!.body!.messages as Array<Record<string, unknown>>).at(-1)!;
    expect(lastThink).toMatchObject({ role: "assistant", content: "雾湾的灯塔", reasoning_content: "继续描写灯塔。" });

    const contPlain = await completeText("openai-chat-completions", server.url, "sk-test", {
      model: "deepseek-flash",
      dialect: "deepseek",
      continuePrefill: true,
      messages: [
        { role: "user", content: "写一段关于雾湾的描写。" },
        { role: "assistant", content: "雾湾的灯塔", reasoning: "不应在关闭思考时发送" },
      ],
    }, runtime);
    expect(contPlain.text).toBe("继续写完剩余部分。");
    const lastPlain = (server.requests.at(-1)!.body!.messages as Array<Record<string, unknown>>).at(-1)!;
    expect(lastPlain).toEqual({ role: "assistant", content: "雾湾的灯塔" });
  });

  it("signals stopReason refusal cleanly when the model refuses", async () => {
    server = await startMockDeepSeek({ refusal: true });
    const streamed = await collect(streamText("openai-chat-completions", server.url, "sk-test", {
      model: "deepseek-flash",
      dialect: "deepseek",
      safetyCheck: "high",
      messages: [{ role: "user", content: "合成拒答测试" }],
    }, runtime));
    expect(streamed.completed?.stopReason).toBe("refusal");
    expect(streamed.completed?.refusal).toBe(true);

    server.options.refusal = true;
    const completed = await completeText("openai-chat-completions", server.url, "sk-test", {
      model: "deepseek-flash",
      dialect: "deepseek",
      safetyCheck: "high",
      messages: [{ role: "user", content: "合成拒答测试" }],
    }, runtime);
    expect(completed.stopReason).toBe("refusal");
    expect(completed.refusal).toBe(true);
  });

  it("rejects deepseek_web_search on deepseek-v4-pro with 400", async () => {
    server = await startMockDeepSeek({});
    await expect(
      completeText("openai-chat-completions", server.url, "sk-test", {
        model: "deepseek-v4-pro",
        dialect: "deepseek",
        reasoningEffort: "low",
        nativeWebSearch: true,
        messages: [{ role: "user", content: "test" }],
      }, runtime),
    ).rejects.toThrow(/deepseek-v4-pro/);
  });
});

describe("DeepSeek Files API, flat file_id attachment, and expired file detection", () => {
  it("infers upload purposes accurately and enforces purpose-before-file multipart ordering", async () => {
    expect(inferDeepSeekFilePurpose("manual.pdf", "application/pdf")).toBe("rich_layout_recognition");
    expect(inferDeepSeekFilePurpose("slides.pptx")).toBe("rich_layout_recognition");
    expect(inferDeepSeekFilePurpose("notes.md", "text/markdown")).toBe("user_data");
    expect(inferDeepSeekFilePurpose("cover.png", "image/png")).toBeUndefined();

    server = await startMockDeepSeek({ answer: "文档编号 42" });
    const uploaded = await uploadDeepSeekFile({
      baseUrl: server.url,
      apiKey: "sk-test",
      filename: "sample.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.4\nFog Bay 42\n"),
    });
    expect(uploaded.fileId).toMatch(/^file-api-mock-/);
    expect(uploaded.purpose).toBe("rich_layout_recognition");
    const uploadReq = server.requests.find((r) => r.path.endsWith("/v1/files"))!;
    expect(uploadReq.fields).toEqual(["purpose", "file"]);

    // Image upload omits `purpose`.
    const imgRef = await uploadDeepSeekFile({
      baseUrl: server.url,
      apiKey: "sk-test",
      filename: "panel.png",
      mimeType: "image/png",
      data: Buffer.from([137, 80, 78, 71]),
    });
    expect(imgRef.purpose).toBeUndefined();
    const imgReq = server.requests.filter((r) => r.path.endsWith("/v1/files")).at(-1)!;
    expect(imgReq.fields).toEqual(["file"]);

    // Send flat `{ type: "file", file_id }` on both native and pi runtimes.
    for (const runtime of ["native", "pi"] as const) {
      const res = await completeText("openai-chat-completions", server.url, "sk-test", {
        model: "deepseek-flash",
        dialect: "deepseek",
        messages: [{ role: "user", content: "读这个文件", fileRefs: [uploaded] }],
      }, runtime);
      expect(res.text).toBe("文档编号 42");
      const userParts = (server.requests.at(-1)!.body!.messages as Array<{ content: unknown[] }>)[0]!.content;
      expect(userParts).toContainEqual({ type: "file", file_id: uploaded.fileId });
    }

    // Delete file and verify expired file_id extraction for self-healing.
    const removed = await deleteDeepSeekFile({ baseUrl: server.url, apiKey: "sk-test", fileId: uploaded.fileId });
    expect(removed).toEqual({ deleted: true, fileId: uploaded.fileId });
    const alreadyGone = await deleteDeepSeekFile({ baseUrl: server.url, apiKey: "sk-test", fileId: uploaded.fileId });
    expect(alreadyGone).toEqual({ deleted: false, fileId: uploaded.fileId });

    const err = await completeText("openai-chat-completions", server.url, "sk-test", {
      model: "deepseek-flash",
      dialect: "deepseek",
      messages: [{ role: "user", content: "再读一次", fileRefs: [uploaded] }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(MangaError);
    expect(extractExpiredFileIds(err)).toEqual([uploaded.fileId]);
    expect(classifyAgentError(err)).toEqual({
      errorCode: "file_invalid",
      expiredFileIds: [uploaded.fileId],
      fileExpired: true,
    });
  });
});

describe("DeepSeek standalone tools: search, fetch, OCR, balance, pre-TTS markdown stripping, and WS TTS", () => {
  it("supports search with siteIcon, needContent, and count up to 50", async () => {
    server = await startMockDeepSeek({});
    const found = await searchDeepSeekWeb({
      baseUrl: server.url,
      apiKey: "sk-test",
      query: "雾湾灯塔",
      count: 25,
      needContent: true,
    });
    expect(found.results).toHaveLength(3);
    expect(found.results[0]).toMatchObject({
      siteIcon: "https://example.org/favicon.ico",
    });
    expect(found.results[0]?.content).toContain("完整的抓取正文内容");
    expect(server.requests.at(-1)!.body).toMatchObject({ count: 25, need_content: true });

    // Backward-compatible positional signature also works.
    const positional = await searchDeepSeek(server.url, "sk-test", { query: "雾湾", count: 2, needContent: false });
    expect(positional.results).toHaveLength(2);
    expect(positional.results[0]?.content).toBeUndefined();
  });

  it("fetches pages as Markdown via /v1/tools/fetch", async () => {
    server = await startMockDeepSeek({});
    const page = await fetchDeepSeekWeb({ baseUrl: server.url, apiKey: "sk-test", url: "https://example.org/guide" });
    expect(page).toMatchObject({
      url: "https://example.org/guide",
      title: "示例页面 · example.org",
      site: "example.org",
      siteIcon: "https://example.org/favicon.ico",
      source: "deepseek_fetch",
    });
    expect(page.content).toContain("提取正文");
  });

  it("recognizes documents via /v1/tools/ocr and returns 1-based pages with usage", async () => {
    server = await startMockDeepSeek({ ocrText: "雾湾港口日志 第42号" });
    const ocr = await ocrDeepSeekDocument({
      baseUrl: server.url,
      apiKey: "sk-test",
      filename: "scan.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.4\n"),
      purpose: "rich_layout_recognition",
    });
    expect(ocr).toEqual({
      text: "雾湾港口日志 第42号",
      pages: [{ page: 1, text: "雾湾港口日志 第42号" }],
      purpose: "rich_layout_recognition",
      usage: { pages: 1, inputTokens: 110, outputTokens: 12 },
    });
  });

  it("queries account balance via GET /user/balance", async () => {
    server = await startMockDeepSeek({});
    const balance = await fetchDeepSeekBalance({ baseUrl: server.url, apiKey: "sk-test" });
    expect(balance.isAvailable).toBe(true);
    expect(balance.available).toBe(true);
    expect(balance.balances).toEqual([
      { currency: "CNY", totalBalance: "100.00", grantedBalance: "10.00", toppedUpBalance: "90.00" },
    ]);
  });

  it("strips code blocks, tables, math, citations, URLs, and formatting noise before TTS", () => {
    const raw = [
      "# 雾湾简介 [citation:1]",
      "",
      "这里有一句**重要的话**，参考 [官方文档](https://example.org/docs) 和 https://example.org/raw。",
      "",
      "```ts",
      "const hidden = 42;",
      "```",
      "",
      "| 列A | 列B |",
      "| --- | --- |",
      "| 1 | 2 |",
      "",
      "$$E = mc^2$$",
      "",
      "- 第一条 `inlineCode` 列表项[citation:2, 3]",
    ].join("\n");
    const cleaned = stripMarkdownForSpeech(raw);
    expect(cleaned).toContain("雾湾简介");
    expect(cleaned).toContain("这里有一句重要的话，参考 官方文档 和");
    expect(cleaned).toContain("第一条 inlineCode 列表项");
    expect(cleaned).not.toContain("const hidden");
    expect(cleaned).not.toContain("https://");
    expect(cleaned).not.toContain("[citation:");
    expect(cleaned).not.toContain("| 列A |");
    expect(cleaned).not.toContain("E = mc^2");
    expect(cleaned).not.toContain("**");

    // Iterative HTML stripping removes nested tags, whitespace end tags, comments, and `<script>` blocks
    // while keeping plain text and math inequalities intact.
    const htmlDirty = [
      '保留<b>强调</b>与<span data-x="1 > 0">短语</span><br/>',
      "前缀 <scr<script></script>ipt>中间</script > 后缀",
      "<script>alert(1)</script > <!-- 隐藏注释 --> a < b 且 1 < 2",
    ].join("\n");
    const htmlClean = stripMarkdownForSpeech(htmlDirty);
    expect(htmlClean).toContain("保留强调与短语");
    expect(htmlClean).toContain("前缀 中间 后缀");
    expect(htmlClean).toContain("a < b 且 1 < 2");
    expect(htmlClean).not.toContain("<script");
    expect(htmlClean).not.toContain("</script");
    expect(htmlClean).not.toContain("alert(1)");
    expect(htmlClean).not.toContain("隐藏注释");
    expect(htmlClean).not.toMatch(/<\/?(?:b|span|br|script)\b/i);
  });

  it("streams 24 kHz 16-bit PCM incrementally over WebSocket TTS with odd-byte sample alignment", async () => {
    server = await startMockDeepSeek({ key: "sk-ws-test" });
    const received: Uint8Array[] = [];
    const session = createDeepSeekTtsStream({
      baseUrl: server.url,
      apiKey: "sk-ws-test",
      voice: "tide",
      onChunk: (pcmChunk) => received.push(pcmChunk),
    });
    session.push("雾湾的灯塔，");
    session.push("在黄昏亮起。");
    const result = await session.finish();
    expect(result.transport).toBe("ws");
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.bytes % 2).toBe(0);
    expect(result.firstChunkMs).not.toBeNull();
    expect(received.length).toBeGreaterThan(0);
    for (const chunk of received) expect(chunk.byteLength % 2).toBe(0);

    // Async iterable consumption works as well.
    const iterSession = createDeepSeekTtsStream({ baseUrl: server.url, apiKey: "sk-ws-test", voice: "stella" });
    iterSession.push("星穹航路。");
    const finishPromise = iterSession.finish();
    let iteratedBytes = 0;
    for await (const chunk of iterSession) {
      expect(chunk.byteLength % 2).toBe(0);
      iteratedBytes += chunk.byteLength;
    }
    const iterResult = await finishPromise;
    expect(iteratedBytes).toBe(iterResult.bytes);
    expect(iteratedBytes).toBeGreaterThan(0);

    // Server finish error code rejects cleanly with refusal classification.
    server.options.ttsWsErrorCode = "content_filter";
    const errSession = createDeepSeekTtsStream({ baseUrl: server.url, apiKey: "sk-ws-test" });
    errSession.push("测试拦截。");
    await expect(errSession.finish()).rejects.toMatchObject({ details: { errorCode: "refusal" } });
  });

  it("classifies HTTP errors and server tool aggregations accurately", () => {
    expect(classifyAgentError(mapHttpError(401, "{}"))).toEqual({ errorCode: "auth" });
    expect(classifyAgentError(mapHttpError(402, "{}"))).toEqual({ errorCode: "balance" });
    expect(classifyAgentError(mapHttpError(429, "{}"))).toEqual({ errorCode: "rate_limit" });
    expect(classifyAgentError(mapHttpError(503, "{}"))).toEqual({ errorCode: "server" });
    expect(classifyAgentError(mapHttpError(400, JSON.stringify({ error: { message: "maximum context length exceeded" } })))).toEqual({ errorCode: "context_overflow" });
    expect(classifyAgentError(mapHttpError(400, JSON.stringify({ error: { message: "file_id file-api-abc_123 has expired" } })))).toEqual({
      errorCode: "file_invalid",
      expiredFileIds: ["file-api-abc_123"],
      fileExpired: true,
    });

    const aggregated = aggregateServerToolSteps([
      { kind: "read_link", callId: "c1", url: "https://example.org/p", status: "wip" },
      { kind: "done", callId: "c1", sources: [], failed: true },
    ]);
    expect(aggregated).toEqual([
      { id: "c1", kind: "read_link", status: "error", pages: [{ url: "https://example.org/p", failed: true }] },
    ]);
  });
});
