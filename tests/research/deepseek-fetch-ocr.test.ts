import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OcrResult } from "@manga/contracts";
import { call, deepseekApp } from "../helpers/provider-fixture.ts";
import { tmpDir } from "../helpers/plugin-fixtures.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) {
    try { await closers.pop()!(); } catch { /* ignore */ }
  }
});

// Minimal 1x1 PNG bytes for OCR fixture uploads.
const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082",
  "hex",
);

async function startLocalHtmlServer(html: string): Promise<{ url: string; close: () => Promise<void>; hits: () => number }> {
  let count = 0;
  const server = http.createServer((_req, res) => {
    count += 1;
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/article`,
    hits: () => count,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("upgraded web.search, deepseek-fetch@1 (webpage.fetch), and ocr.recognize", () => {
  it("supports count up to 50 and needContent in web.search, preserving siteIcon and content", async () => {
    const rig = await deepseekApp({ add: { models: [], services: ["search"] } });
    closers.push(rig.close);

    const res = await call(rig.ctx, "web.search", { query: "深度检索测试", count: 25, needContent: true });
    expect(res.status, JSON.stringify(res)).toBe("ok");
    const req = rig.server.requests.find((r) => r.path === "/v1/tools/search")!;
    expect(req.body).toMatchObject({ query: "深度检索测试", count: 25, need_content: true });
    const value = res.value as { results: Array<{ siteIcon?: string; content?: string; title: string }> };
    expect(value.results.length).toBeGreaterThan(0);
    expect(value.results[0]!.siteIcon).toBe("https://example.org/favicon.ico");
    expect(value.results[0]!.content).toContain("完整的抓取正文内容");
  });

  it("routes webpage.fetch across deepseek, auto (with fallback to local Readability), and local backends while enforcing provider gate", async () => {
    const localPage = await startLocalHtmlServer(
      "<!doctype html><html><head><title>本地回退页</title></head><body><article><h1>本地文章</h1><p>这是本地 Readability 抓取的正文内容，用于验证回退链路。</p></article></body></html>",
    );
    closers.push(localPage.close);

    // 1. Explicit deepseek backend + auto backend when DeepSeek fetch succeeds.
    const rig = await deepseekApp({
      add: { models: ["deepseek-flash"], services: ["fetch"] },
      app: { network: { allowPrivate: () => true } },
    });
    closers.push(rig.close);

    const dsFetched = await call(rig.ctx, "webpage.fetch", { url: "https://example.org/guide", backend: "deepseek" });
    expect(dsFetched.status, JSON.stringify(dsFetched)).toBe("ok");
    expect(dsFetched.value).toMatchObject({
      source: "deepseek_fetch",
      site: "example.org",
      siteIcon: "https://example.org/favicon.ico",
    });
    expect(rig.server.count("/v1/tools/fetch")).toBe(1);
    const uses = rig.ctx.app.store.sqlite
      .prepare("SELECT service, task, status FROM service_usage WHERE service = 'fetch'")
      .all();
    expect(uses).toEqual([{ service: "fetch", task: "research", status: "ok" }]);

    // 2. Explicit local backend bypasses DeepSeek fetch completely.
    const localOnly = await call(rig.ctx, "webpage.fetch", { url: localPage.url, backend: "local" });
    expect(localOnly.status, JSON.stringify(localOnly)).toBe("ok");
    expect((localOnly.value as { source: string }).source).toBe("local");
    expect(localPage.hits()).toBe(1);
    expect(rig.server.count("/v1/tools/fetch")).toBe(1);

    // 3. Auto backend falls back cleanly to local Readability when DeepSeek fetch fails (HTTP 503).
    const fallbackRig = await deepseekApp({
      add: { models: ["deepseek-flash"], services: ["fetch"] },
      mock: { fail: [{ path: "/v1/tools/fetch", status: 503, times: 5 }] },
      app: { network: { allowPrivate: () => true } },
    });
    closers.push(fallbackRig.close);
    const autoFallback = await call(fallbackRig.ctx, "webpage.fetch", { url: localPage.url, backend: "auto" });
    expect(autoFallback.status, JSON.stringify(autoFallback)).toBe("ok");
    expect((autoFallback.value as { source: string }).source).toBe("local");
    expect(localPage.hits()).toBe(2);

    // 4. When provider plugin is disabled: backend:"deepseek" refuses with ZERO requests, backend:"auto" skips provider with ZERO requests and uses local!
    await call(rig.ctx, "plugin.disable", { pluginId: "demo.provider" });
    const countBefore = rig.server.count("/v1/tools/fetch");
    const blockedDs = await call(rig.ctx, "webpage.fetch", { url: "https://example.org/blocked", backend: "deepseek" });
    expect(blockedDs.status).toBe("error");
    expect(blockedDs.error?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(rig.server.count("/v1/tools/fetch")).toBe(countBefore);

    const autoDisabled = await call(rig.ctx, "webpage.fetch", { url: localPage.url, backend: "auto" });
    expect(autoDisabled.status, JSON.stringify(autoDisabled)).toBe("ok");
    expect((autoDisabled.value as { source: string }).source).toBe("local");
    expect(rig.server.count("/v1/tools/fetch")).toBe(countBefore);
  });

  it("runs ocr.recognize for text_recognition and rich_layout_recognition, records usage, and blocks when plugin is disabled", async () => {
    const rig = await deepseekApp({
      add: { models: ["deepseek-flash"], services: ["ocr"] },
      mock: { ocrText: (_bytes, purpose) => `识别结果(${purpose})` },
    });
    closers.push(rig.close);

    const dir = tmpDir();
    closers.push(async () => { fs.rmSync(dir, { recursive: true, force: true }); });
    const imgPath = path.join(dir, "scan.png");
    fs.writeFileSync(imgPath, TINY_PNG);
    const handle1 = rig.ctx.app.registerPath("file", imgPath);

    const plain = await call(rig.ctx, "ocr.recognize", { pathHandle: handle1, purpose: "text_recognition" });
    expect(plain.status, JSON.stringify(plain)).toBe("ok");
    const plainVal = plain.value as OcrResult;
    expect(plainVal.purpose).toBe("text_recognition");
    expect(plainVal.pages).toEqual([{ page: 1, text: "识别结果(text_recognition)" }]);
    expect(plainVal.text).toBe("识别结果(text_recognition)");
    expect(plainVal.usage).toEqual({ pages: 1, inputTokens: 110, outputTokens: 12 });

    const handle2 = rig.ctx.app.registerPath("file", imgPath);
    const rich = await call(rig.ctx, "ocr.recognize", { pathHandle: handle2, purpose: "rich_layout_recognition" });
    expect(rich.status, JSON.stringify(rich)).toBe("ok");
    expect((rich.value as OcrResult).text).toBe("识别结果(rich_layout_recognition)");

    const uses = rig.ctx.app.store.sqlite
      .prepare("SELECT service, unit, quantity, status FROM service_usage WHERE service = 'ocr'")
      .all();
    expect(uses).toEqual([
      { service: "ocr", unit: "page", quantity: 1, status: "ok" },
      { service: "ocr", unit: "page", quantity: 1, status: "ok" },
    ]);

    // Plugin disabled -> refuses with PROVIDER_UNAVAILABLE and makes ZERO requests to /v1/tools/ocr.
    await call(rig.ctx, "plugin.disable", { pluginId: "demo.provider" });
    const ocrBefore = rig.server.count("/v1/tools/ocr");
    const handle3 = rig.ctx.app.registerPath("file", imgPath);
    const blocked = await call(rig.ctx, "ocr.recognize", { pathHandle: handle3, purpose: "text_recognition" });
    expect(blocked.status).toBe("error");
    expect(blocked.error?.code).toBe("PROVIDER_UNAVAILABLE");
    expect(rig.server.count("/v1/tools/ocr")).toBe(ocrBefore);
  });
});
