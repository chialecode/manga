import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MangaError } from "@manga/contracts";
import { DandanClient, dandanHeaders, dandanSignature } from "@manga/app-core";
import { FAKE_CREDENTIALS, FakeDandan, OTHER_CREDENTIALS } from "../helpers/fake-dandan.ts";

let server: FakeDandan;
let clock: number;
beforeEach(async () => {
  server = await new FakeDandan().start();
  clock = Date.parse("2026-10-09T08:00:00Z");
});
afterEach(async () => { await server.stop(); });

const client = (overrides: Partial<ConstructorParameters<typeof DandanClient>[0]> = {}) => new DandanClient({
  fetch: (url, init) => fetch(url, init as RequestInit),
  credentials: () => FAKE_CREDENTIALS,
  userAgent: "MANGA/test",
  origin: server.origin,
  allowHttp: true,
  now: () => clock,
  ...overrides,
});
const failure = async (work: Promise<unknown>): Promise<MangaError> => {
  try { await work; } catch (error) { return error as MangaError; }
  throw new Error("the call should have failed");
};

describe("the signature of a request (AT-94)", () => {
  it("is base64(sha256(AppId + Timestamp + lower-case path + AppSecret)), with the path as the service reads it", () => {
    // Fixed vectors: the signature does not move with the way the path is written, and the secret itself is never in the headers.
    expect(dandanSignature(FAKE_CREDENTIALS, 1_700_000_000, "/api/v2/Search/Episodes")).toBe("ChXScDLSAsCBgi/6MN0BVsrPkBLxnzdXdsyKQz1MQFc=");
    expect(dandanSignature(FAKE_CREDENTIALS, 1_700_000_000, "/api/v2/comment/900102")).toBe("TII0p80w1WrvN1ESKObMZVBiZu4V2i5dbTN9TEvRwm0=");
    const headers = dandanHeaders(FAKE_CREDENTIALS, 1_700_000_000, "/api/v2/comment/900102");
    expect(headers).toEqual({ "X-AppId": "fakeapp001", "X-Timestamp": "1700000000", "X-Signature": "TII0p80w1WrvN1ESKObMZVBiZu4V2i5dbTN9TEvRwm0=" });
    expect(JSON.stringify(headers)).not.toContain(FAKE_CREDENTIALS.secret);
    // Another path or another second gives another signature.
    expect(dandanSignature(FAKE_CREDENTIALS, 1_700_000_001, "/api/v2/comment/900102")).not.toBe(headers["X-Signature"]);
    expect(dandanSignature(FAKE_CREDENTIALS, 1_700_000_000, "/api/v2/comment/900103")).not.toBe(headers["X-Signature"]);
  });

  it("is accepted by a service that checks it the same way, and refused when the secret is another", async () => {
    const answer = await client().comments(900102, 1);
    expect(answer.count).toBe(7);
    const request = server.requests.at(-1)!;
    expect(request.signed).toBe(true);
    expect(request.headers["x-timestamp"]).toBe(String(Math.floor(clock / 1000)));
    expect(request.query.get("chConvert")).toBe("1");
    expect(request.query.get("withRelated")).toBe("true");
    expect(request.headers["user-agent"]).toBe("MANGA/test");
    // The secret is not in anything that was sent.
    expect(JSON.stringify(request.headers)).not.toContain(FAKE_CREDENTIALS.secret);
    expect(request.body).not.toContain(FAKE_CREDENTIALS.secret);

    const wrong = await failure(client({ credentials: () => ({ appId: FAKE_CREDENTIALS.appId, secret: OTHER_CREDENTIALS.secret }) }).comments(900102, 1));
    expect(wrong.code).toBe("AUTHENTICATION_FAILED");
    expect(wrong.message).toBe("Invalid Signature");
  });
});

describe("what the client does when the service says no (AT-94)", () => {
  it("sends nothing at all when there are no credentials", async () => {
    const before = server.requests.length;
    const error = await failure(client({ credentials: () => null }).searchEpisodes("样例", undefined));
    expect(error.code).toBe("CREDENTIAL_UNAVAILABLE");
    expect(error.details).toMatchObject({ reason: "no_credentials" });
    expect(server.requests.length).toBe(before);
  });

  it("reads the reason of a 403 from the X-Error-Message header and does not try again", async () => {
    server.accepts = OTHER_CREDENTIALS;
    const error = await failure(client().bangumiSubject(100));
    expect(error.code).toBe("AUTHENTICATION_FAILED");
    expect(error.message).toBe("Invalid AppId");
    expect(error.details).toMatchObject({ reason: "forbidden", serverMessage: "Invalid AppId" });
    expect(server.requests).toHaveLength(1);
  });

  it("pauses for the time the service asked after a 429, sends nothing during the pause, and does not retry by itself", async () => {
    server.script(() => true, { status: 429, headers: { "retry-after": "90" } });
    const http = client();
    const first = await failure(http.comments(900102, 0));
    expect(first.code).toBe("RATE_LIMITED");
    expect(first.retryable).toBe(false);
    expect(first.details).toMatchObject({ reason: "rate_limited", retryAfterMs: 90_000 });
    expect(server.requests).toHaveLength(1);
    // Inside the pause every call fails at once, whatever it asks for.
    clock += 60_000;
    const second = await failure(http.comments(900102, 0));
    expect(second.code).toBe("RATE_LIMITED");
    expect(second.details).toMatchObject({ reason: "backoff", retryAfterMs: 30_000 });
    expect(http.pausedForMs()).toBe(30_000);
    expect(server.requests).toHaveLength(1);
    // After it the client sends again.
    clock += 31_000;
    expect((await http.comments(900102, 0)).count).toBe(7);
    expect(server.requests).toHaveLength(2);
  });

  it("answers a 429 without a usable Retry-After with a pause of a minute, and a date with the time until it", async () => {
    server.script(() => true, { status: 429 }, { status: 429, headers: { "retry-after": new Date(clock + 20_000).toUTCString() } });
    const first = client();
    expect((await failure(first.comments(900102, 0))).details.retryAfterMs).toBe(60_000);
    const second = client();
    expect((await failure(second.comments(900102, 0))).details.retryAfterMs).toBe(20_000);
  });

  it("reports an unreachable service, a bad answer and a refusal inside a 200 without pretending to have data", async () => {
    server.script(() => true, { status: 200, destroy: true });
    expect((await failure(client().comments(900102, 0))).details).toMatchObject({ reason: "network" });
    server.script(() => true, { status: 200, body: "<html>not json</html>" });
    expect((await failure(client().comments(900102, 0))).details).toMatchObject({ reason: "bad_response" });
    server.script(() => true, { status: 502 });
    expect(await failure(client().comments(900102, 0))).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true });
    // A comment list has no `success`; the three calls that do have one report it.
    server.script((request) => request.path.includes("bgmtv"), { status: 200, body: JSON.stringify({ success: false, errorCode: 7, errorMessage: "mapping closed" }) });
    const closed = await failure(client().bangumiSubject(100));
    expect(closed.details).toMatchObject({ reason: "rejected" });
    expect(closed.message).toBe("mapping closed");
  });
});

describe("redirects (AT-94)", () => {
  it("follows a 302 to an allowed address and sends no signature headers there", async () => {
    server.script((request) => request.path === "/api/v2/comment/900102", { status: 302, headers: { location: `${server.origin}/cdn/900102.json` } });
    const answer = await client({ extraRedirectHosts: [server.host] }).comments(900102, 0);
    expect(answer.comments[0]!.m).toBe("从跳转后的地址来的");
    const [first, second] = server.requests;
    expect(first!.headers["x-signature"]).toBeTruthy();
    expect(second!.path).toBe("/cdn/900102.json");
    for (const name of ["x-appid", "x-timestamp", "x-signature", "authorization"]) expect(second!.headers[name], name).toBeUndefined();
  });

  it("refuses a redirect to another host, to plain http where https is required, and to a lookalike domain", async () => {
    const target = (location: string) => server.script((request) => request.path === "/api/v2/comment/900102", { status: 302, headers: { location } });
    target("http://127.0.0.1:1/elsewhere");
    expect((await failure(client().comments(900102, 0))).details).toMatchObject({ reason: "redirect_refused" });
    target("https://example.com/comments.json");
    expect((await failure(client().comments(900102, 0))).details).toMatchObject({ reason: "redirect_refused" });
    target("https://dandanplay.net.example.com/comments.json");
    expect((await failure(client().comments(900102, 0))).details).toMatchObject({ reason: "redirect_refused" });
    target("https://evil-dandanplay.net/comments.json");
    expect((await failure(client().comments(900102, 0))).details).toMatchObject({ reason: "redirect_refused" });
    // Nothing but the first request was ever sent.
    expect(server.requests.every((request) => request.path === "/api/v2/comment/900102")).toBe(true);
  });

  it("as configured for the release, follows only https DanDanPlay domains and refuses plain http even there", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const answers = [
      new Response(null, { status: 302, headers: { location: "https://static.dandanplay.net/comments/900102.json" } }),
      new Response(JSON.stringify({ count: 1, comments: [{ p: "1,1,16777215,1", m: "跳转后" }] }), { status: 200 }),
      new Response(null, { status: 302, headers: { location: "http://api.dandanplay.net/comments/900102.json" } }),
    ];
    const release = new DandanClient({ fetch: async (url, init) => { seen.push({ url, headers: init?.headers ?? {} }); return answers.shift()!; }, credentials: () => FAKE_CREDENTIALS, userAgent: "MANGA/test", now: () => clock });
    expect((await release.comments(900102, 0)).comments[0]!.m).toBe("跳转后");
    expect(seen[0]!.url.startsWith("https://api.dandanplay.net/api/v2/comment/900102")).toBe(true);
    expect(Object.keys(seen[0]!.headers)).toEqual(expect.arrayContaining(["X-AppId", "X-Timestamp", "X-Signature"]));
    expect(seen[1]!.url).toBe("https://static.dandanplay.net/comments/900102.json");
    expect(Object.keys(seen[1]!.headers).filter((name) => /^x-/i.test(name))).toEqual([]);
    expect((await failure(release.comments(900102, 0))).details).toMatchObject({ reason: "redirect_refused" });
  });

  it("does not follow a redirect of a request that carries data", async () => {
    server.script((request) => request.path === "/api/v2/match", { status: 307, headers: { location: `${server.origin}/cdn/match` } });
    const error = await failure(client({ extraRedirectHosts: [server.host] }).match({ fileName: "x", fileHash: "0".repeat(32), fileSize: 1, videoDurationSec: 1 }));
    expect(error.details).toMatchObject({ reason: "redirect_refused" });
    expect(server.requests).toHaveLength(1);
  });

  it("gives up after a few hops", async () => {
    server.script((request) => request.path.startsWith("/cdn/") || request.path.startsWith("/api/"), ...Array.from({ length: 6 }, () => ({ status: 302, headers: { location: `${server.origin}/cdn/loop` } })));
    const error = await failure(client({ extraRedirectHosts: [server.host] }).comments(900102, 0));
    expect(error.details).toMatchObject({ reason: "bad_response" });
    expect(server.requests.length).toBeLessThanOrEqual(4);
  });
});
