import http from "node:http";
import type { AddressInfo } from "node:net";
// The signature code alone, so a script can use this fake without loading the whole application.
import { dandanSignature, type DandanCredentials } from "../../packages/app-core/src/danmaku/sign.ts";

export type DandanRequest = { method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: string; signed: boolean };
export type DandanScripted = { status: number; headers?: Record<string, string>; body?: string; destroy?: boolean };

/** Fake credentials for tests: the shapes of a real pair (a 10-character id, a 32-character secret) with nothing real in them. */
export const FAKE_CREDENTIALS: DandanCredentials = { appId: "fakeapp001", secret: "f4k3s3cr3tf4k3s3cr3tf4k3s3cr3t00" };
export const OTHER_CREDENTIALS: DandanCredentials = { appId: "ownapp0002", secret: "0wn53cr3t0wn53cr3t0wn53cr3t0wn5" };

export type FakeComment = { cid?: number; p: string; m: string };

/**
 * A stand-in for the DanDanPlay open API (v2), speaking the four calls MANGA uses. It checks the signature of every request the way the real service
 * does (the digest of AppId, timestamp, lower-case path and secret), records what it was asked, and lets a test script answers: a redirect, a 403, a 429.
 */
export class FakeDandan {
  readonly requests: DandanRequest[] = [];
  /** Show 9001 is the Bangumi subject 100; the others are only reachable by match and search. */
  readonly bangumi = new Map<number, { animeId: number; animeTitle: string; episodes: Array<{ episodeId: number; episodeTitle: string; episodeNumber: string }> }>();
  readonly comments = new Map<number, FakeComment[]>();
  readonly matches = new Map<string, Array<{ episodeId: number; animeId: number; animeTitle: string; episodeTitle: string }>>();
  readonly shows: Array<{ animeId: number; animeTitle: string; typeDescription: string; episodes: Array<{ episodeId: number; episodeTitle: string }> }> = [];
  /** Which credentials the service accepts; a request signed with others gets a 403 with the reason in the header. */
  accepts: DandanCredentials = FAKE_CREDENTIALS;
  private readonly scripted: Array<{ when: (request: DandanRequest) => boolean; answers: DandanScripted[] }> = [];
  private server: http.Server | undefined;
  origin = "";
  host = "";

  constructor() {
    this.bangumi.set(100, {
      animeId: 9001, animeTitle: "样例动画",
      episodes: [1, 2, 3].map((n) => ({ episodeId: 900100 + n, episodeTitle: `第${n}话`, episodeNumber: String(n) })),
    });
    this.comments.set(900102, [
      { cid: 1, p: "1.50,1,16777215,10001", m: "前方高能" },
      { cid: 2, p: "3.00,1,16711680,[BiliBili]ab12", m: "哈哈哈" },
      { cid: 3, p: "3.20,1,16711680,[BiliBili]cd34", m: "哈哈哈" },
      { cid: 4, p: "5.00,5,255,10002", m: "顶部的一条" },
      { cid: 5, p: "8.00,4,65280,10003", m: "底部的一条" },
      { cid: 6, p: "12.50,1,16777215,[Gamer]ef56", m: "後面才會看到" },
      { cid: 7, p: "30.00,1,16777215,10004", m: "很后面的剧透" },
    ]);
    this.matches.set("样例动画 第03话", [{ episodeId: 900103, animeId: 9001, animeTitle: "样例动画", episodeTitle: "第3话" }]);
    this.matches.set("模糊 05", [
      { episodeId: 800105, animeId: 8001, animeTitle: "模糊动画", episodeTitle: "第5话" },
      { episodeId: 810105, animeId: 8101, animeTitle: "模糊动画 第二季", episodeTitle: "第5话" },
    ]);
    this.shows.push(
      { animeId: 9001, animeTitle: "样例动画", typeDescription: "TV动画", episodes: [1, 2, 3].map((n) => ({ episodeId: 900100 + n, episodeTitle: `第${n}话` })) },
      { animeId: 9002, animeTitle: "样例动画 剧场版", typeDescription: "剧场版", episodes: [{ episodeId: 900201, episodeTitle: "剧场版" }] },
    );
  }

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const port = (this.server.address() as AddressInfo).port;
    this.host = `127.0.0.1:${port}`;
    this.origin = `http://${this.host}`;
    return this;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => { this.server?.closeAllConnections(); this.server?.close(() => resolve()); });
  }

  /** The next requests that fit are answered with these, in order, before the normal answer. */
  script(when: (request: DandanRequest) => boolean, ...answers: DandanScripted[]): void {
    this.scripted.push({ when, answers });
  }

  hits(path: RegExp | string): DandanRequest[] {
    return this.requests.filter((request) => (typeof path === "string" ? request.path === path : path.test(request.path)));
  }

  private json(res: http.ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
    res.end(JSON.stringify(value));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? "/", this.origin);
    const timestamp = Number(req.headers["x-timestamp"]);
    const appId = String(req.headers["x-appid"] ?? "");
    const signature = String(req.headers["x-signature"] ?? "");
    const signed = Boolean(appId) && Number.isFinite(timestamp) && signature === dandanSignature({ appId, secret: this.accepts.secret }, timestamp, url.pathname) && appId === this.accepts.appId;
    const request: DandanRequest = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body: Buffer.concat(chunks).toString("utf8"), signed };
    this.requests.push(request);

    const rule = this.scripted.find((item) => item.answers.length > 0 && item.when(request));
    if (rule) {
      const answer = rule.answers.shift()!;
      if (answer.destroy) { req.socket.destroy(); return; }
      res.writeHead(answer.status, answer.headers ?? {});
      res.end(answer.body ?? "");
      return;
    }
    // Pages a redirect leads to need no signature: they stand for a file server.
    if (url.pathname.startsWith("/cdn/")) {
      this.json(res, { count: 1, comments: [{ cid: 99, p: "2.00,1,16777215,10009", m: "从跳转后的地址来的" }] });
      return;
    }
    if (!signed) {
      const reason = !appId ? "Missing AppId" : appId !== this.accepts.appId ? "Invalid AppId" : "Invalid Signature";
      res.writeHead(403, { "x-error-message": reason });
      res.end();
      return;
    }

    let found: RegExpExecArray | null;
    if (request.method === "POST" && url.pathname === "/api/v2/match") {
      const body = JSON.parse(request.body) as { fileName: string };
      const matches = this.matches.get(body.fileName) ?? [];
      this.json(res, { success: true, errorCode: 0, errorMessage: "", isMatched: matches.length === 1, matches });
    } else if (request.method === "GET" && url.pathname === "/api/v2/search/episodes") {
      const text = url.searchParams.get("anime") ?? "";
      const episode = url.searchParams.get("episode");
      const animes = this.shows.filter((show) => show.animeTitle.includes(text)).map((show) => ({ ...show, episodes: episode ? show.episodes.filter((item) => item.episodeTitle.includes(episode)) : show.episodes }));
      this.json(res, { success: true, errorCode: 0, errorMessage: "", hasMore: false, animes });
    } else if (request.method === "GET" && (found = /^\/api\/v2\/bangumi\/bgmtv\/(\d+)$/.exec(url.pathname))) {
      const entry = this.bangumi.get(Number(found[1]));
      this.json(res, entry ? { success: true, errorCode: 0, errorMessage: "", bangumi: entry } : { success: false, errorCode: 404, errorMessage: "not found", bangumi: null });
    } else if (request.method === "GET" && (found = /^\/api\/v2\/comment\/(\d+)$/.exec(url.pathname))) {
      const list = this.comments.get(Number(found[1])) ?? [];
      this.json(res, { count: list.length, comments: list });
    } else {
      this.json(res, { success: false, errorCode: 404, errorMessage: "unknown call" }, 404);
    }
  }
}
