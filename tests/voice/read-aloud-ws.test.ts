import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { speechBilledChars, startMockDeepSeek, stripMarkdownForSpeech } from "@manga/model-protocol";
import { startApp, tempProfile } from "../helpers/app.ts";
import { call, deepseekApp, PROVIDER_KEY, PROVIDER_REF, providerPackage, providerPublisher } from "../helpers/provider-fixture.ts";
import { tmpDir } from "../helpers/plugin-fixtures.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) {
    try { await closers.pop()!(); } catch { /* ignore */ }
  }
});

describe("pre-TTS markdown stripping, voice selection, and streaming WebSocket TTS", () => {
  it("strips code blocks, URLs, tables, and citations before splitting and billing, and honors voice selection", async () => {
    const rig = await deepseekApp({ add: { models: ["deepseek-flash"], services: ["speech"] } });
    closers.push(rig.close);

    const markdown = [
      "## 标题部分",
      "",
      "正文里有一个链接 [官网](https://example.org/long/path) 和引用[citation:1]。",
      "",
      "```ts",
      "const secretCode = 1234567890;",
      "console.log(secretCode);",
      "```",
      "",
      "| 列一 | 列二 |",
      "| --- | --- |",
      "| 甲 | 乙 |",
      "",
      "最后一句正常朗读。",
    ].join("\n");

    const expectedStripped = stripMarkdownForSpeech(markdown);
    expect(expectedStripped).not.toContain("secretCode");
    expect(expectedStripped).not.toContain("https://example.org");
    expect(expectedStripped).not.toContain("[citation:1]");

    const chunks: Uint8Array[] = [];
    const result = await rig.ctx.app.speech.speak(
      { text: markdown, voice: "tide", task: "read-aloud" },
      (pcm) => chunks.push(pcm),
      new AbortController().signal,
    );

    const ttsReqs = rig.server.requests.filter((r) => r.path === "/v1/tools/tts" && r.method === "POST");
    expect(ttsReqs).toHaveLength(1);
    const reqBody = ttsReqs[0]!.body as { text: string; voice_id?: string };
    expect(reqBody.voice_id).toBe("tide");
    expect(reqBody.text).not.toContain("secretCode");
    expect(reqBody.text).not.toContain("https://example.org");
    expect(reqBody.text).not.toContain("[citation:1]");
    expect(result.billedChars).toBe(speechBilledChars(expectedStripped));
    expect(result.billedChars).toBeLessThan(speechBilledChars(markdown));
    expect(chunks.reduce((sum, c) => sum + c.length, 0)).toBeGreaterThan(0);

    // Different voice ("stella") does not falsely hit the "tide" cache entry.
    const stella = await rig.ctx.app.speech.speak(
      { text: markdown, voice: "stella", task: "read-aloud" },
      () => undefined,
      new AbortController().signal,
    );
    expect(stella.cached).toBe(false);
    expect(rig.server.requests.filter((r) => r.path === "/v1/tools/tts")).toHaveLength(2);
  });

  it("streams 16-bit aligned PCM in-memory via WS TTS (VOICE-19, <=300ms first audio) and blocks when plugin is disabled", async () => {
    const profileRoot = tempProfile();
    const rig = await deepseekApp({
      add: { models: ["deepseek-flash"], services: ["speech"] },
      mock: { ttsMsPerChar: 10 },
    });
    closers.push(rig.close);

    const cacheDir = path.join(rig.ctx.profileRoot, "cache");
    const filesBefore = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir, { recursive: true }) : [];

    const chunks: Uint8Array[] = [];
    const session = await rig.ctx.app.speech.startStream(
      { voice: "tide", task: "read-aloud" },
      (pcm) => chunks.push(pcm),
      new AbortController().signal,
    );

    // Push incremental chunks including a fenced code block split across chunk boundaries.
    session.push("第一句开始，");
    session.push("```js\nconst skipped = ");
    session.push("42;\n```第二句结束。");
    const finished = await session.finish();

    expect(finished.transport).toBe("ws");
    expect(finished.bytes).toBeGreaterThan(0);
    expect(finished.bytes % 2).toBe(0);
    for (const chunk of chunks) expect(chunk.byteLength % 2).toBe(0);
    expect(finished.firstChunkMs).not.toBeNull();
    expect(finished.firstChunkMs!).toBeLessThanOrEqual(300);

    const wsReqs = rig.server.requests.filter((r) => r.method === "WS" && r.path === "/v1/tools/tts");
    expect(wsReqs).toHaveLength(1);
    expect((wsReqs[0]!.body as { voice_id?: string }).voice_id).toBe("tide");

    const uses = rig.ctx.app.store.sqlite
      .prepare("SELECT service, task, status, quantity FROM service_usage WHERE service = 'speech'")
      .all() as Array<{ service: string; task: string; status: string; quantity: number }>;
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ service: "speech", task: "read-aloud", status: "ok" });

    // VOICE-19: zero audio files written to disk in the profile cache.
    const filesAfter = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir, { recursive: true }) : [];
    expect(filesAfter).toEqual(filesBefore);
    fs.rmSync(profileRoot, { recursive: true, force: true });

    // Disabling provider plugin refuses startStream with zero WS/HTTP requests.
    await call(rig.ctx, "plugin.disable", { pluginId: "demo.provider" });
    const countBefore = rig.server.requests.length;
    await expect(
      rig.ctx.app.speech.startStream({ voice: "stella" }, () => undefined, new AbortController().signal),
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", details: { reason: "plugin_disabled" } });
    expect(rig.server.requests.length).toBe(countBefore);
  });

  it("falls back transparently to HTTP TTS when WebSocket handshake fails before emitting any audio", async () => {
    const upstream = await startMockDeepSeek({ key: PROVIDER_KEY, ttsMsPerChar: 10 });
    closers.push(() => upstream.close());

    // Local proxy forwards HTTP POST /v1/tools/tts to upstream, but rejects WebSocket upgrades with 501.
    const upstreamUrl = new URL(upstream.url);
    const allowedPaths = new Map<string, string>([
      ["/v1/tools/tts", "/v1/tools/tts"],
      ["/v1/models", "/v1/models"],
    ]);
    const proxy = http.createServer((req, res) => {
      const bodyChunks: Buffer[] = [];
      req.on("data", (c: Buffer) => bodyChunks.push(c));
      req.on("end", () => {
        const reqPath = typeof req.url === "string" ? req.url : "";
        if (!reqPath.startsWith("/") || reqPath.startsWith("//")) {
          res.writeHead(400);
          res.end("invalid path");
          return;
        }
        const targetPath = allowedPaths.get(reqPath);
        if (!targetPath) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        const method = req.method === "POST" ? "POST" : req.method === "GET" ? "GET" : null;
        if (!method) {
          res.writeHead(405);
          res.end("method not allowed");
          return;
        }
        const headers: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.toLowerCase() !== "host" && v !== undefined) headers[k] = v;
        }
        const fwd = http.request(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port,
            path: targetPath,
            method,
            headers,
          },
          (upRes) => {
            res.writeHead(upRes.statusCode ?? 500, upRes.headers);
            upRes.pipe(res);
          },
        );
        fwd.on("error", (err) => { res.writeHead(502); res.end(String(err)); });
        fwd.end(Buffer.concat(bodyChunks));
      });
    });
    proxy.on("upgrade", (_req, socket) => {
      socket.write("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n");
      socket.destroy();
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    closers.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())));

    const ctx = await startApp({ profileRoot: tempProfile(), options: { providers: { testOrigin: proxyUrl } } });
    closers.push(async () => { ctx.app.close(); });
    await call(ctx, "plugin.trust.add", { publicKey: providerPublisher.publicKey, label: providerPublisher.label });
    const dir = tmpDir();
    closers.push(async () => { fs.rmSync(dir, { recursive: true, force: true }); });
    const pkgFile = path.join(dir, "provider.manga-plugin");
    fs.writeFileSync(pkgFile, providerPackage());
    await call(ctx, "plugin.install", { pathHandle: ctx.app.registerPath("file", pkgFile), grant: ["network"] });
    await call(ctx, "providers.add", {
      providerRef: PROVIDER_REF,
      credentialHandle: ctx.app.stashSecret(PROVIDER_KEY),
      models: [],
      services: ["speech"],
      verified: false,
    });

    const pcmChunks: Uint8Array[] = [];
    const session = await ctx.app.speech.startStream(
      { voice: "stella", task: "read-aloud" },
      (pcm) => pcmChunks.push(pcm),
      new AbortController().signal,
    );
    session.push("回退到 HTTP 朗读测试。");
    const done = await session.finish();

    expect(done.transport).toBe("http");
    expect(done.bytes).toBeGreaterThan(0);
    expect(done.bytes % 2).toBe(0);
    expect(pcmChunks.reduce((s, c) => s + c.length, 0)).toBe(done.bytes);
    expect(upstream.requests.filter((r) => r.method === "POST" && r.path === "/v1/tools/tts")).toHaveLength(1);
    const uses = ctx.app.store.sqlite
      .prepare("SELECT service, status, quantity FROM service_usage WHERE service = 'speech'")
      .all();
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ service: "speech", status: "ok" });
  });
});
