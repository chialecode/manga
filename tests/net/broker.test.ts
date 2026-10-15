import { describe, expect, it } from "vitest";
import { NetworkBroker, isPrivateAddress } from "../../packages/app-core/src/net/broker.ts";

type Init = { method?: string; redirect?: string; signal?: AbortSignal; headers?: Record<string, string> };
type Reply = Response | ((url: string, init: Init) => Response | Promise<Response>);

/** A fetch that answers from a table keyed by address and records every address it was asked for. */
function table(replies: Record<string, Reply>) {
  const asked: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetchLike = async (url: string, init?: Init): Promise<Response> => {
    asked.push(url);
    headers.push(init?.headers ?? {});
    const reply = replies[url];
    if (!reply) return new Response("not found", { status: 404 });
    return typeof reply === "function" ? reply(url, init ?? {}) : reply.clone();
  };
  return { asked, headers, fetchLike: fetchLike as never };
}
const html = (body: string, extra: Record<string, string> = {}) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...extra } });
const publicLookup = async () => ["93.184.216.34"];

describe("private addresses", () => {
  it("recognises loopback, private, link-local, shared and reserved addresses in both families", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.63.0.1", "2606:4700:4700::1111", "::ffff:5db8:d822"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});

describe("the network broker", () => {
  it("fetches an address that resolves to a public host, sending nothing that identifies the person", async () => {
    const t = table({ "https://example.org/a": html("<p>hello</p>") });
    const broker = new NetworkBroker({ fetch: t.fetchLike, lookup: publicLookup, userAgent: "MANGA/test" });
    const got = await broker.fetchText("https://example.org/a");
    expect(got).toMatchObject({ requestedUrl: "https://example.org/a", finalUrl: "https://example.org/a", status: 200, contentType: "text/html", text: "<p>hello</p>" });
    expect(Object.keys(t.headers[0]!).sort()).toEqual(["accept", "accept-language", "user-agent"]);
    expect(t.headers[0]!["user-agent"]).toBe("MANGA/test");
  });

  it("refuses addresses that lead to this computer or its network, before any request is made", async () => {
    const t = table({});
    const broker = new NetworkBroker({ fetch: t.fetchLike, lookup: publicLookup });
    for (const url of ["http://127.0.0.1/", "http://localhost:8080/x", "https://[::1]/", "http://192.168.1.1/admin", "http://169.254.169.254/latest/meta-data", "http://printer.local/", "http://intranet/", "http://wiki.internal/", "http://[::ffff:127.0.0.1]/", "http://0x7f.1/"]) {
      await expect(broker.fetchText(url), url).rejects.toMatchObject({ code: "PATH_ESCAPE", details: { reason: "private" } });
    }
    expect(t.asked).toEqual([]);
  });

  it("refuses a name that resolves to a private address, and one that resolves to several where any is private", async () => {
    const t = table({});
    const lookups: string[] = [];
    const broker = new NetworkBroker({ fetch: t.fetchLike, lookup: async (host) => { lookups.push(host); return host === "rebind.example.org" ? ["93.184.216.34", "10.0.0.5"] : ["127.0.0.1"]; } });
    await expect(broker.fetchText("https://evil.example.org/")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(broker.fetchText("https://rebind.example.org/")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    expect(lookups).toEqual(["evil.example.org", "rebind.example.org"]);
    expect(t.asked).toEqual([]);
  });

  it("only takes http and https, and no address that carries a login", async () => {
    const broker = new NetworkBroker({ fetch: table({}).fetchLike, lookup: publicLookup });
    await expect(broker.fetchText("file:///etc/passwd")).rejects.toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "scheme" } });
    await expect(broker.fetchText("ftp://example.org/a")).rejects.toMatchObject({ details: { reason: "scheme" } });
    await expect(broker.fetchText("javascript:alert(1)")).rejects.toMatchObject({ details: { reason: "scheme" } });
    await expect(broker.fetchText(["https://user:pass", "example.org/"].join("@"))).rejects.toMatchObject({ details: { reason: "credentials" } });
    await expect(broker.fetchText("not an address")).rejects.toMatchObject({ details: { reason: "url" } });
  });

  it("follows a redirect and checks every hop again", async () => {
    const t = table({
      "https://example.org/old": new Response(null, { status: 301, headers: { location: "/new" } }),
      "https://example.org/new": html("<p>moved</p>"),
      "https://example.org/inside": new Response(null, { status: 302, headers: { location: "https://other.example.net/x" } }),
      "https://example.org/loop": new Response(null, { status: 302, headers: { location: "/loop" } }),
      "https://example.org/to-private": new Response(null, { status: 302, headers: { location: "http://127.0.0.1:9/secret" } }),
      "https://example.org/to-metadata": new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } }),
    });
    const broker = new NetworkBroker({ fetch: t.fetchLike, lookup: async (host) => (host === "other.example.net" ? ["10.9.9.9"] : ["93.184.216.34"]) });
    const moved = await broker.fetchText("https://example.org/old");
    expect(moved).toMatchObject({ requestedUrl: "https://example.org/old", finalUrl: "https://example.org/new", text: "<p>moved</p>" });
    await expect(broker.fetchText("https://example.org/inside")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(broker.fetchText("https://example.org/to-private")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(broker.fetchText("https://example.org/to-metadata")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
    await expect(broker.fetchText("https://example.org/loop")).rejects.toMatchObject({ details: { reason: "redirects" } });
    expect(t.asked).not.toContain("http://127.0.0.1:9/secret");
    expect(t.asked).not.toContain("http://169.254.169.254/");
  });

  it("refuses a redirect from a secure address to an insecure one", async () => {
    const t = table({ "https://example.org/a": new Response(null, { status: 302, headers: { location: "http://example.org/b" } }), "http://example.org/b": html("<p>x</p>") });
    const broker = new NetworkBroker({ fetch: t.fetchLike, lookup: publicLookup });
    await expect(broker.fetchText("https://example.org/a")).rejects.toMatchObject({ details: { reason: "downgrade" } });
    expect(t.asked).toEqual(["https://example.org/a"]);
  });

  it("bounds the size, by the declared length and by what actually arrives", async () => {
    const big = "x".repeat(5000);
    const t = table({
      "https://example.org/declared": html("small", { "content-length": "99999" }),
      "https://example.org/actual": new Response(big, { status: 200, headers: { "content-type": "text/plain" } }),
    });
    const broker = new NetworkBroker({ fetch: t.fetchLike, lookup: publicLookup, maxBytes: 1000 });
    await expect(broker.fetchText("https://example.org/declared")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", details: { reason: "size" } });
    await expect(broker.fetchText("https://example.org/actual")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED", details: { reason: "size" } });
  });

  it("takes only web pages and text, and reports a bad status without the body", async () => {
    const t = table({
      "https://example.org/image": new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } }),
      "https://example.org/json": new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
      "https://example.org/gone": new Response("secret body", { status: 404 }),
      "https://example.org/down": new Response("busy", { status: 503 }),
      "https://example.org/limited": new Response("slow down", { status: 429 }),
    });
    const broker = new NetworkBroker({ fetch: t.fetchLike, lookup: publicLookup });
    await expect(broker.fetchText("https://example.org/image")).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT", details: { reason: "contentType", contentType: "image/png" } });
    await expect(broker.fetchText("https://example.org/json")).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    const gone = await broker.fetchText("https://example.org/gone").catch((error: { message: string; details: Record<string, unknown>; retryable?: boolean }) => error);
    expect(gone).toMatchObject({ code: "PROVIDER_UNAVAILABLE", details: { reason: "status", status: 404 } });
    expect(JSON.stringify(gone)).not.toContain("secret body");
    expect(await broker.fetchText("https://example.org/down").catch((error: { retryable?: boolean }) => error)).toMatchObject({ retryable: true });
    expect(await broker.fetchText("https://example.org/limited").catch((error: { retryable?: boolean }) => error)).toMatchObject({ retryable: true });
  });

  it("decodes the charset the page declares, in the header or in a meta element", async () => {
    const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]); // 你好
    const t = table({
      "https://example.org/header": new Response(gbk, { status: 200, headers: { "content-type": "text/html; charset=gbk" } }),
      "https://example.org/meta": new Response(new Uint8Array([...new TextEncoder().encode('<meta charset="gbk"><p>'), ...gbk, ...new TextEncoder().encode("</p>")]), { status: 200, headers: { "content-type": "text/html" } }),
    });
    const broker = new NetworkBroker({ fetch: t.fetchLike, lookup: publicLookup });
    expect((await broker.fetchText("https://example.org/header")).text).toBe("你好");
    expect((await broker.fetchText("https://example.org/meta")).text).toContain("<p>你好</p>");
  });

  it("gives up when the page is too slow, and when the caller cancels", async () => {
    const never = (_url: string, init: Init) => new Promise<Response>((_resolve, reject) => {
      const stop = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (init.signal?.aborted) stop();
      else init.signal?.addEventListener("abort", stop);
    });
    const t = table({ "https://example.org/slow": never });
    const slow = new NetworkBroker({ fetch: t.fetchLike, lookup: publicLookup, timeoutMs: 40 });
    await expect(slow.fetchText("https://example.org/slow")).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", details: { reason: "timeout" } });
    const controller = new AbortController();
    const patient = new NetworkBroker({ fetch: t.fetchLike, lookup: publicLookup, timeoutMs: 5000 });
    const pending = patient.fetchText("https://example.org/slow", controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("lets only what the person set up themselves through the private-address check", async () => {
    const t = table({ "http://127.0.0.1:8123/page": html("<p>mine</p>") });
    const broker = new NetworkBroker({ fetch: t.fetchLike, allowPrivate: (host) => host === "127.0.0.1" });
    expect((await broker.fetchText("http://127.0.0.1:8123/page")).text).toBe("<p>mine</p>");
    await expect(broker.fetchText("http://10.0.0.1/")).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  });
});
