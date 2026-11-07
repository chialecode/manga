import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BangumiClient, bangumiUserAgent, isPrivateHost, normalizeSubject, type FetchLike } from "../../packages/app-core/src/metadata/bangumi.ts";
import { startFakeBangumi, type FakeBangumi } from "../helpers/fake-bangumi.ts";
import { EventEmitter } from "node:events";
import { createNetFetch, type NetLike } from "../../apps/desktop/src/main/net-fetch.ts";

let fake: FakeBangumi;
beforeAll(async () => { fake = await startFakeBangumi(); });
afterAll(async () => { await fake.stop(); });

const real: FetchLike = (url, init) => fetch(url, init as RequestInit);
const client = (extra: Partial<ConstructorParameters<typeof BangumiClient>[0]> = {}) => new BangumiClient({ fetch: real, userAgent: bangumiUserAgent("1.2.3"), ...fake.clientOptions, ...extra });
const codeOf = async (work: Promise<unknown>) => work.then(() => "no error", (error: { code?: string; details?: { reason?: string } }) => `${error.code}${error.details?.reason ? `:${error.details.reason}` : ""}`);

describe("which addresses the client may talk to", () => {
  it("knows private and local addresses", () => {
    for (const host of ["localhost", "app.localhost", "printer.local", "db.internal", "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.9", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "[::1]", "fe80::1", "fd12::1", "::ffff:7f00:1"]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of ["api.bgm.tv", "lain.bgm.tv", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2001:db8::1"]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });

  it("sends the User-Agent Bangumi asks for", () => {
    expect(bangumiUserAgent("0.4.0")).toBe("chialecode/manga/0.4.0 (https://github.com/chialecode/manga)");
  });

  it("refuses plain http, unknown hosts and private addresses before sending anything", async () => {
    let sent = 0;
    const counting: FetchLike = async () => { sent += 1; return new Response("{}"); };
    const strict = new BangumiClient({ fetch: counting, userAgent: "ua", allowedHosts: ["api.bgm.tv", "10.0.0.5"] });
    expect(await codeOf(strict.image("http://lain.bgm.tv/a.png"))).toBe("FORBIDDEN:scheme");
    expect(await codeOf(strict.image("https://evil.example/a.png"))).toBe("FORBIDDEN:host_not_allowed");
    expect(await codeOf(strict.image("https://10.0.0.5/a.png"))).toBe("FORBIDDEN:private_address");
    expect(await codeOf(strict.image("not a url"))).toBe("VALIDATION_ERROR");
    expect(sent).toBe(0);
  });

  it("does not follow a redirect to a private address or an unlisted host, and gives up on a redirect loop", async () => {
    const hops: string[] = [];
    const redirecting = (target: (url: string) => string): FetchLike => async (url) => {
      hops.push(url);
      return new Response(null, { status: 302, headers: { location: target(url) } });
    };
    const toPrivate = new BangumiClient({ fetch: redirecting(() => "https://169.254.169.254/latest/meta-data"), userAgent: "ua", allowedHosts: ["api.bgm.tv", "lain.bgm.tv"] });
    expect(await codeOf(toPrivate.image("https://lain.bgm.tv/a.png"))).toBe("FORBIDDEN:redirect_blocked");
    expect(hops).toEqual(["https://lain.bgm.tv/a.png"]);
    hops.length = 0;
    const toOther = new BangumiClient({ fetch: redirecting(() => "https://evil.example/a.png"), userAgent: "ua", allowedHosts: ["lain.bgm.tv"] });
    expect(await codeOf(toOther.image("https://lain.bgm.tv/a.png"))).toBe("FORBIDDEN:redirect_blocked");
    hops.length = 0;
    const loop = new BangumiClient({ fetch: redirecting((url) => `${url}x`), userAgent: "ua", allowedHosts: ["lain.bgm.tv"] });
    expect(await codeOf(loop.image("https://lain.bgm.tv/a"))).toBe("PROVIDER_UNAVAILABLE:redirect_loop");
    expect(hops.length).toBeLessThanOrEqual(4);
  });

  it("follows an API redirect to another allowed host without taking the token along", async () => {
    const seen: Array<{ url: string; authorization?: string }> = [];
    const fetchLike: FetchLike = async (url, init) => {
      seen.push({ url, authorization: init?.headers?.authorization });
      if (url.startsWith("https://api.bgm.tv/")) return new Response(null, { status: 302, headers: { location: "https://lain.bgm.tv/v0/subjects/7" } });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    const authed = new BangumiClient({ fetch: fetchLike, userAgent: "ua", token: () => "synthetic-token", maxRetries: 0 });
    await codeOf(authed.subject(7));
    expect(seen.map((item) => item.url)).toEqual(["https://api.bgm.tv/v0/subjects/7", "https://lain.bgm.tv/v0/subjects/7"]);
    expect(seen[0]!.authorization).toBe("Bearer synthetic-token");
    expect(seen[1]!.authorization).toBeUndefined();
  });

  it("gets redirects through the desktop network stack as answers it can check, never followed blindly", async () => {
    // Electron's net.fetch rejects redirect: "manual"; the desktop adapter uses net.request, which reports the redirect first.
    const asked: Array<{ url: string; headers: Record<string, string> }> = [];
    const routes: Record<string, { redirect?: string; status?: number; body?: string }> = {
      "https://api.bgm.tv/v0/subjects/7": { redirect: "https://api.bangumi.tv/v0/subjects/7" },
      "https://api.bangumi.tv/v0/subjects/7": { status: 200, body: "{}" },
      "https://lain.bgm.tv/a.png": { redirect: "https://169.254.169.254/latest/meta-data" },
    };
    const net: NetLike = {
      fetch: async () => { throw new Error("Redirect was cancelled"); },
      request: (options) => {
        const request = new EventEmitter() as EventEmitter & Record<string, unknown>;
        const headers: Record<string, string> = {};
        let aborted = false;
        Object.assign(request, {
          setHeader: (name: string, value: string) => { headers[name] = value; },
          write: () => undefined,
          abort: () => { aborted = true; },
          end: () => queueMicrotask(() => {
            const url = String(options.url);
            asked.push({ url, headers });
            const route = routes[url] ?? { status: 404, body: "" };
            if (route.redirect) { request.emit("redirect", 302, "GET", route.redirect, {}); return; }
            const response = Object.assign(new EventEmitter(), { statusCode: route.status, statusMessage: "", headers: { "content-type": ["application/json"] } });
            request.emit("response", response);
            if (!aborted) { response.emit("data", Buffer.from(route.body ?? "")); response.emit("end"); }
          }),
        });
        return request as never;
      },
    };
    const desktop = new BangumiClient({ fetch: createNetFetch(net), userAgent: "ua", token: () => "synthetic-token", maxRetries: 0 });
    // An allowed redirect is followed and its answer is checked like any other (this empty one fails the schema, not the network),
    // and the token stays with the first API host.
    expect(await codeOf(desktop.subject(7))).toBe("PROVIDER_UNAVAILABLE:schema");
    expect(asked.map((item) => item.url)).toEqual(["https://api.bgm.tv/v0/subjects/7", "https://api.bangumi.tv/v0/subjects/7"]);
    expect(asked[0]!.headers.authorization).toBe("Bearer synthetic-token");
    expect(asked[1]!.headers.authorization).toBeUndefined();
    // A redirect to a private address is refused by name, not reported as an unreachable network, and is never requested.
    asked.length = 0;
    expect(await codeOf(desktop.image("https://lain.bgm.tv/a.png"))).toBe("FORBIDDEN:redirect_blocked");
    expect(asked.map((item) => item.url)).toEqual(["https://lain.bgm.tv/a.png"]);
    // Without the adapter's manual path, a redirect would look like a network failure.
    const plain = new BangumiClient({ fetch: (url, init) => net.fetch(url, init as RequestInit), userAgent: "ua", maxRetries: 0 });
    expect(await codeOf(plain.image("https://lain.bgm.tv/a.png"))).toBe("PROVIDER_UNAVAILABLE:network");
  });
});

describe("what the client sends and accepts", () => {
  it("sends the token to the API and never to a picture", async () => {
    fake.reset();
    const url = await fake.addImage("t.png");
    fake.subject(7, { imageName: "t.png" });
    const authed = client({ token: () => "synthetic-token" });
    await authed.subject(7);
    await authed.image(url);
    const [api, picture] = fake.requests;
    expect(api!.headers.authorization).toBe("Bearer synthetic-token");
    expect(api!.headers["user-agent"]).toBe("chialecode/manga/1.2.3 (https://github.com/chialecode/manga)");
    expect(api!.headers.accept).toBe("application/json");
    expect(picture!.headers.authorization).toBeUndefined();
    expect(picture!.headers.accept).toBe("image/*");
    // Without a token no authorization header is sent at all.
    fake.requests.length = 0;
    await client().subject(7);
    expect(fake.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("accepts only pictures, and only up to a size", async () => {
    fake.reset();
    const good = await fake.addImage("ok.png");
    fake.images.set("page.html", { bytes: Buffer.from("<html></html>"), mediaType: "text/html" });
    fake.images.set("svg.svg", { bytes: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), mediaType: "image/svg+xml" });
    fake.images.set("big.png", { bytes: Buffer.alloc(5000, 1), mediaType: "image/png" });
    expect((await client().image(good)).mediaType).toBe("image/png");
    expect(await codeOf(client().image(fake.imageUrl("page.html")))).toBe("UNSUPPORTED_FORMAT:not_image");
    expect(await codeOf(client().image(fake.imageUrl("svg.svg")))).toBe("UNSUPPORTED_FORMAT:not_image");
    expect(await codeOf(client({ maxImageBytes: 1000 }).image(fake.imageUrl("big.png")))).toBe("PROVIDER_UNAVAILABLE:too_large");
    expect(await codeOf(client().image(fake.imageUrl("missing.png")))).toBe("NOT_FOUND");
  });

  it("refuses an answer that is too large or has the wrong shape", async () => {
    fake.reset();
    fake.subject(8, { summary: "x".repeat(5000) });
    expect(await codeOf(client({ maxJsonBytes: 2000 }).subject(8))).toBe("PROVIDER_UNAVAILABLE:too_large");
    fake.script((item) => item.path === "/v0/subjects/8", { status: 200, body: JSON.stringify({ id: "not a number", type: 2 }) });
    expect(await codeOf(client().subject(8))).toBe("PROVIDER_UNAVAILABLE:schema");
    // Missing optional pieces fall back to defaults instead of failing: an entry without a Chinese name or summary is normal.
    fake.script((item) => item.path === "/v0/subjects/8", { status: 200, body: JSON.stringify({ id: 8, type: 2, name: "Only Original" }) });
    const minimal = await client().subject(8);
    expect(normalizeSubject(minimal).fields).toEqual({ title: "Only Original" });
  });

  it("ends a request that takes too long, and one that is cancelled while it waits to retry", async () => {
    fake.reset();
    fake.subject(9);
    fake.script((item) => item.path === "/v0/subjects/9", { status: 200, delayMs: 600, body: "{}" });
    expect(await codeOf(client({ timeoutMs: 100 }).subject(9))).toBe("PROVIDER_UNAVAILABLE:timeout");
    fake.script((item) => item.path === "/v0/subjects/9", { status: 429, headers: { "retry-after": "20" } });
    const controller = new AbortController();
    const started = Date.now();
    const pending = codeOf(new BangumiClient({ fetch: real, userAgent: "ua", ...fake.clientOptions, sleep: undefined }).subject(9, controller.signal));
    setTimeout(() => controller.abort(), 80);
    expect(await pending).toBe("CANCELLED");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("keeps at most the allowed number of requests in flight", async () => {
    fake.reset();
    for (let id = 20; id < 30; id += 1) fake.subject(id);
    let active = 0;
    let peak = 0;
    const measuring: FetchLike = async (url, init) => {
      active += 1;
      peak = Math.max(peak, active);
      try { return await real(url, init); } finally { active -= 1; }
    };
    const limited = client({ fetch: measuring, concurrency: 2 });
    fake.script((item) => item.path.startsWith("/v0/subjects/"), ...Array.from({ length: 10 }, () => ({ status: 200, delayMs: 40, body: JSON.stringify({ id: 1, type: 2, name: "n" }) })));
    await Promise.all(Array.from({ length: 10 }, (_, index) => limited.subject(20 + index)));
    expect(peak).toBe(2);
    expect(limited.requests).toBe(10);
  });

  it("pages through long episode lists and stops at the cap", async () => {
    fake.reset();
    fake.subject(40);
    fake.episodes.set(40, Array.from({ length: 250 }, (_, index) => ({ id: 1000 + index, type: 0, name: `E${index + 1}`, name_cn: "", sort: index + 1, ep: index + 1, airdate: "", duration: "" })));
    const all = await client().episodes(40, 400);
    expect(all).toHaveLength(250);
    expect(fake.count((item) => item.path.startsWith("/v0/episodes"))).toBe(3);
    fake.requests.length = 0;
    expect(await client().episodes(40, 120)).toHaveLength(120);
    expect(fake.count((item) => item.path.startsWith("/v0/episodes"))).toBe(2);
  });
});

describe("turning an entry into fields", () => {
  const subject = (extra: Record<string, unknown> = {}) => ({
    id: 5, type: 1, name: "Original Name", name_cn: "中文名", summary: "Line one\r\nLine two  ", date: "2019-07-01", platform: "漫画",
    images: { large: "L", common: "C", medium: "M", small: "S", grid: "G" }, infobox: [{ key: "作者", value: "A. Writer" }, { key: "出版社", value: [{ v: "Press One" }, { v: "Press Two" }] }, { key: "别名", value: "x" }],
    volumes: 4, eps: 0, total_episodes: 0, rating: { score: 8.1, total: 33, rank: 0 }, tags: Array.from({ length: 15 }, (_, index) => ({ name: `tag${index}`, count: index })), ...extra,
  });

  it("prefers the Chinese title, keeps the original, and reads authors and publishers from the right infobox keys", async () => {
    fake.reset();
    fake.script((item) => item.path === "/v0/subjects/5", { status: 200, body: JSON.stringify(subject()) });
    const parsed = normalizeSubject(await client().subject(5));
    expect(parsed.fields).toMatchObject({ title: "中文名", titleOriginal: "Original Name", author: "A. Writer", studio: "Press One / Press Two", summary: "Line one\nLine two", releaseDate: "2019-07-01", platform: "漫画", volumeCount: 4 });
    expect(parsed.fields.episodeCount).toBeUndefined();
    expect(parsed.fields.tags).toHaveLength(12);
    expect((parsed.fields.tags as string[])[0]).toBe("tag14");
    expect(parsed.rating).toEqual({ score: 8.1, total: 33, rank: null, scale: "bangumi-10" });
    expect(parsed.sourceUrl).toBe("https://bgm.tv/subject/5");
    expect(parsed.images.large).toBe("L");
  });

  it("reads anime staff from the anime keys and treats an unrated entry as having no rating", async () => {
    fake.reset();
    fake.script((item) => item.path === "/v0/subjects/6", { status: 200, body: JSON.stringify(subject({ id: 6, type: 2, name_cn: "", infobox: [{ key: "导演", value: "A. Director" }, { key: "动画制作", value: "Synthetic Studio" }], eps: 12, rating: { score: 0, total: 0, rank: 0 } })) });
    const parsed = normalizeSubject(await client().subject(6));
    expect(parsed.fields).toMatchObject({ title: "Original Name", author: "A. Director", studio: "Synthetic Studio", episodeCount: 12 });
    expect(parsed.fields.titleOriginal).toBeUndefined();
    expect(parsed.rating).toBeNull();
  });
});
