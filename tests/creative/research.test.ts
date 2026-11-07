import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { extractPage, tidy } from "../../packages/app-core/src/creative/extract.ts";
import { snippetAround } from "../../packages/app-core/src/creative/research.ts";
import { startApp } from "../helpers/app.ts";
import { DRIVE } from "../helpers/hostile-input.ts";

type App = Awaited<ReturnType<typeof startApp>>;
type Call = Awaited<ReturnType<App["app"]["call"]>>;
type Page = { id: string; url: string; title: string; version: number; previousId: string | null; chars: number; excerpts: number; latest: boolean; contentHash: string };
type Excerpt = { id: string; projectId: string | null; pageId: string; url: string; title: string; text: string; start: number; end: number; note: string; version: number; newerVersion: { id: string; version: number } | null };
type Result = { kind: string; id: string; title: string; snippet: string; inProject: boolean; startMs?: number; resourceId?: string; workId?: string; url?: string };

let counter = 0;
const apps: App[] = [];
afterEach(() => { while (apps.length) apps.pop()!.app.close(); });

const ARTICLE = (body: string, title = "雨夜的灯") => `<!doctype html><html><head><title>${title}</title><script>window.stolen = document.cookie; alert("run")</script><style>p{color:red}</style></head>
<body><nav><a href="/">首页</a><a href="/about">关于</a></nav><article><h1>${title}</h1>${body}</article><footer>版权所有 订阅我们</footer></body></html>`;
const LONG = "<p>城市在雨里安静下来，路灯一盏一盏亮起，照着湿漉漉的石板路。她撑着伞走过桥，听见远处有人在拉手风琴，曲子很慢，像是在等什么人。</p><p>桥下的水很深，倒映着整座城市的光。她停了一会儿，把伞举高了一点，继续往前走，没有回头。</p><p>第二天早晨，雨停了，石板路上留下一串浅浅的水迹，一直通到旧书店的门口。</p>";

/** A page server on the loopback address, whose answers the test changes while it runs. */
function pageServer() {
  const state = { article: ARTICLE(LONG), hits: [] as string[], big: "x".repeat(3 * 1024 * 1024) };
  const server = http.createServer((request, response) => {
    state.hits.push(`${request.method} ${request.url} cookie=${request.headers.cookie ?? ""} auth=${request.headers.authorization ?? ""}`);
    const url = request.url ?? "/";
    if (url.startsWith("/article")) { response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(state.article); return; }
    if (url === "/plain.txt") { response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); response.end("第一行\n\n\n第二行   有空格\n"); return; }
    if (url === "/image.png") { response.writeHead(200, { "content-type": "image/png" }); response.end(Buffer.from([0x89, 0x50, 0x4e, 0x47])); return; }
    if (url === "/big") { response.writeHead(200, { "content-type": "text/plain" }); response.end(state.big); return; }
    if (url === "/empty") { response.writeHead(200, { "content-type": "text/html" }); response.end("<html><body><script>1</script></body></html>"); return; }
    if (url === "/old") { response.writeHead(301, { location: "/article" }); response.end(); return; }
    if (url === "/to-private") { response.writeHead(302, { location: "http://10.255.255.1/secret" }); response.end(); return; }
    response.writeHead(404, { "content-type": "text/plain" }); response.end("no such page");
  });
  return {
    state,
    start: () => new Promise<string>((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))),
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const origin = { current: "" };
const site = pageServer();
beforeAll(async () => { origin.current = await site.start(); });
afterAll(async () => { await site.stop(); });

async function boot(allowLoopback = true) {
  const ctx = await startApp({ options: allowLoopback ? { network: { allowPrivate: (host) => host === "127.0.0.1" } } : undefined });
  apps.push(ctx);
  return ctx;
}
async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Call> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `res-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Call): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
const failure = (result: Call) => { expect(result.status).toBe("error"); return result.error as { code: string; details?: Record<string, unknown> }; };
type Fetched = { page: Page; created: boolean; changed: boolean; previousId: string | null };
const fetchPage = async (ctx: App, path = "/article") => ok<Fetched>(await run(ctx, "webpage.fetch", { url: `${origin.current}${path}` }));
const getPage = async (ctx: App, pageId: string) => ok<{ page: Page; text: string; versions: Array<{ id: string; version: number; current: boolean }>; excerpts: Excerpt[] }>(await run(ctx, "webpage.get", { pageId }));
const search = async (ctx: App, text: string, extra: Record<string, unknown> = {}) => ok<{ results: Result[]; counts: Record<string, number> }>(await run(ctx, "research.search", { text, ...extra }));
async function excerptOf(ctx: App, pageId: string, phrase: string, extra: Record<string, unknown> = {}) {
  const { text } = await getPage(ctx, pageId);
  const start = text.indexOf(phrase);
  expect(start, `"${phrase}" is in the page`).toBeGreaterThanOrEqual(0);
  return ok<{ excerpt: Excerpt }>(await run(ctx, "excerpt.create", { pageId, start, end: start + phrase.length, ...extra })).excerpt;
}

describe("page text extraction", () => {
  it("keeps the article, drops navigation, scripts and styles, and never runs the page", () => {
    const { title, text } = extractPage(ARTICLE(LONG), "text/html", "example.org");
    expect(title).toBe("雨夜的灯");
    expect(text).toContain("城市在雨里安静下来");
    expect(text).toContain("一直通到旧书店的门口");
    expect(text).not.toMatch(/stolen|alert|color:red|订阅我们/);
    expect(text.split("\n\n").length).toBeGreaterThanOrEqual(3);
  });

  it("falls back to the text of the body when the page is not an article, and to the host name for a title", () => {
    const { title, text } = extractPage("<html><body><ul><li>苹果</li><li>香蕉</li></ul><table><tr><td>甲</td><td>乙</td></tr></table></body></html>", "text/html", "example.org");
    expect(title).toBe("example.org");
    expect(text).toContain("苹果");
    expect(text).toContain("香蕉");
    expect(text).toContain("甲");
  });

  it("tidies plain text and keeps its paragraphs", () => {
    expect(extractPage("第一行\r\n\r\n\r\n第二行   有空格\t结尾 \n", "text/plain", "example.org")).toEqual({ title: "example.org", text: "第一行\n\n第二行 有空格 结尾" });
    expect(tidy("a\u00a0 b\n\n\n\nc")).toBe("a b\n\nc");
  });

  it("makes a stretch of text around the match for a result", () => {
    const text = `${"前".repeat(100)}关键词${"后".repeat(300)}`;
    const snippet = snippetAround(text, "关键词");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("关键词");
    expect([...snippet].length).toBeLessThan(200);
    expect(snippetAround("short text", "absent")).toBe("short text");
  });
});

describe("fetching and keeping a page (CRE-06)", () => {
  it("keeps the readable text of the address given, with no cookie or login sent, and says nothing of the page's scripts", async () => {
    const ctx = await boot();
    site.state.hits.length = 0;
    const { page, created, changed } = await fetchPage(ctx);
    expect(created).toBe(true);
    expect(changed).toBe(false);
    expect(page).toMatchObject({ title: "雨夜的灯", version: 1, previousId: null, latest: true, excerpts: 0 });
    expect(page.chars).toBeGreaterThan(100);
    const kept = await getPage(ctx, page.id);
    expect(kept.text).toContain("路灯一盏一盏亮起");
    expect(kept.text).not.toContain("alert");
    expect(site.state.hits).toEqual([expect.stringMatching(/^GET \/article cookie= auth=$/)]);
    expect(ok<{ pages: Page[] }>(await run(ctx, "webpage.list", {})).pages.map((item) => item.id)).toEqual([page.id]);
  });

  it("keeps the page under the address that was asked for, follows a redirect, and treats a fragment as the same page", async () => {
    const ctx = await boot();
    const direct = await fetchPage(ctx);
    const viaRedirect = await fetchPage(ctx, "/old");
    expect(viaRedirect.page.url).toBe(`${origin.current}/old`);
    expect(viaRedirect.created).toBe(true);
    const withFragment = ok<Fetched>(await run(ctx, "webpage.fetch", { url: `${origin.current}/article#second` }));
    expect(withFragment.page.id).toBe(direct.page.id);
    expect(withFragment.created).toBe(false);
  });

  it("does not make a new version when the page is the same, and makes one when it changed, keeping the old", async () => {
    const ctx = await boot();
    const first = await fetchPage(ctx);
    const same = await fetchPage(ctx);
    expect(same).toMatchObject({ created: false, changed: false });
    expect(same.page.id).toBe(first.page.id);
    const before = site.state.article;
    try {
      site.state.article = ARTICLE(LONG.replace("旧书店", "新咖啡馆"));
      const second = await fetchPage(ctx);
      expect(second).toMatchObject({ created: false, changed: true, previousId: first.page.id });
      expect(second.page).toMatchObject({ version: 2, latest: true, previousId: first.page.id });
      const kept = await getPage(ctx, second.page.id);
      expect(kept.text).toContain("新咖啡馆");
      expect(kept.versions.map((item) => [item.version, item.current])).toEqual([[2, true], [1, false]]);
      expect((await getPage(ctx, first.page.id)).text).toContain("旧书店");
      expect((await getPage(ctx, first.page.id)).page.latest).toBe(false);
      expect(ok<{ pages: Page[] }>(await run(ctx, "webpage.list", {})).pages).toHaveLength(1);
    } finally { site.state.article = before; }
  });

  it("keeps plain text, and refuses what is not a page, what is too large and what has no text", async () => {
    const ctx = await boot();
    const plain = await fetchPage(ctx, "/plain.txt");
    expect((await getPage(ctx, plain.page.id)).text).toBe("第一行\n\n第二行 有空格");
    expect(failure(await run(ctx, "webpage.fetch", { url: `${origin.current}/image.png` }))).toMatchObject({ code: "UNSUPPORTED_FORMAT", details: { reason: "contentType" } });
    expect(failure(await run(ctx, "webpage.fetch", { url: `${origin.current}/big` }))).toMatchObject({ code: "QUOTA_EXCEEDED", details: { reason: "size" } });
    expect(failure(await run(ctx, "webpage.fetch", { url: `${origin.current}/empty` }))).toMatchObject({ code: "UNSUPPORTED_FORMAT", details: { reason: "empty" } });
    expect(failure(await run(ctx, "webpage.fetch", { url: `${origin.current}/missing` }))).toMatchObject({ code: "PROVIDER_UNAVAILABLE", details: { reason: "status", status: 404 } });
    expect(ok<{ pages: Page[] }>(await run(ctx, "webpage.list", {})).pages).toHaveLength(1);
  });

  it("refuses this computer and its network by default, and a redirect into it", async () => {
    const closed = await boot(false);
    site.state.hits.length = 0;
    expect(failure(await run(closed, "webpage.fetch", { url: `${origin.current}/article` }))).toMatchObject({ code: "PATH_ESCAPE", details: { reason: "private" } });
    expect(failure(await run(closed, "webpage.fetch", { url: "http://localhost:1/" }))).toMatchObject({ code: "PATH_ESCAPE" });
    expect(failure(await run(closed, "webpage.fetch", { url: `file:///${DRIVE}:/Windows/win.ini` }))).toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "scheme" } });
    expect(site.state.hits).toEqual([]);
    const open = await boot();
    expect(failure(await run(open, "webpage.fetch", { url: `${origin.current}/to-private` }))).toMatchObject({ code: "PATH_ESCAPE" });
  });

  it("records a fetch without writing the address into the log, only the page's title", async () => {
    const ctx = await boot();
    const { page } = await fetchPage(ctx);
    const entries = ok<{ entries: Array<{ action: string; category: string; objectKind: string | null; objectLabel: string | null; summaryKey: string }> }>(await run(ctx, "log.query", { category: "research" })).entries;
    expect(entries).toEqual([expect.objectContaining({ action: "webpage.fetch", category: "research", objectKind: "page", objectLabel: page.title, summaryKey: "log.webpage.fetch" })]);
    expect(JSON.stringify(entries)).not.toContain("127.0.0.1");
  });
});

describe("excerpts", () => {
  it("keeps the exact passage selected, with where it came from, and finds it by its words", async () => {
    const ctx = await boot();
    const { page } = await fetchPage(ctx);
    const excerpt = await excerptOf(ctx, page.id, "她撑着伞走过桥，听见远处有人在拉手风琴", { note: "开头的画面" });
    expect(excerpt).toMatchObject({ pageId: page.id, url: page.url, text: "她撑着伞走过桥，听见远处有人在拉手风琴", note: "开头的画面", version: 1, newerVersion: null, projectId: null });
    expect(excerpt.title).toBe("她撑着伞走过桥，听见远处有人在拉手风琴");
    expect(excerpt.end - excerpt.start).toBe(excerpt.text.length);
    expect(ok<{ excerpts: Excerpt[] }>(await run(ctx, "excerpt.list", {})).excerpts.map((item) => item.id)).toEqual([excerpt.id]);
    expect((await getPage(ctx, page.id)).page.excerpts).toBe(1);
    const found = await search(ctx, "拉手风琴", { scopes: ["excerpt"] });
    expect(found.results).toEqual([expect.objectContaining({ kind: "excerpt", id: excerpt.id, url: page.url })]);
    expect(found.results[0]!.snippet).toContain("拉手风琴");
    expect((await search(ctx, "开头的画面", { scopes: ["excerpt"] })).results).toHaveLength(1);
  });

  it("refuses a selection past the end, an empty one, one that is too long, and one of a page or project that is not there", async () => {
    const ctx = await boot();
    const { page } = await fetchPage(ctx);
    const text = (await getPage(ctx, page.id)).text;
    expect(failure(await run(ctx, "excerpt.create", { pageId: page.id, start: 0, end: text.length + 5 }))).toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "range" } });
    const gap = text.indexOf("\n\n");
    expect(failure(await run(ctx, "excerpt.create", { pageId: page.id, start: gap, end: gap + 2 }))).toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "empty" } });
    expect(failure(await run(ctx, "excerpt.create", { pageId: page.id, start: 5, end: 5 })).code).toBe("VALIDATION_ERROR");
    expect(failure(await run(ctx, "excerpt.create", { pageId: "nope", start: 0, end: 5 })).code).toBe("NOT_FOUND");
    expect(failure(await run(ctx, "excerpt.create", { pageId: page.id, start: 0, end: 5, projectId: "nope" })).code).toBe("NOT_FOUND");
    expect(ok<{ excerpts: Excerpt[] }>(await run(ctx, "excerpt.list", {})).excerpts).toEqual([]);
  });

  it("renames and annotates an excerpt, keeps the search in step, and deletes it with its search entry and its place in a project", async () => {
    const ctx = await boot();
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "雨夜" }));
    const { page } = await fetchPage(ctx);
    const excerpt = await excerptOf(ctx, page.id, "桥下的水很深", { projectId: project.id });
    expect(excerpt.projectId).toBe(project.id);
    expect(ok<{ excerpt: Excerpt }>(await run(ctx, "excerpt.update", { excerptId: excerpt.id, title: "桥下", note: "水的意象" })).excerpt).toMatchObject({ title: "桥下", note: "水的意象", text: "桥下的水很深" });
    expect((await search(ctx, "水的意象", { scopes: ["excerpt"] })).results).toHaveLength(1);
    expect((await search(ctx, "桥下", { scopes: ["excerpt"], projectId: project.id })).results).toEqual([expect.objectContaining({ id: excerpt.id, inProject: true })]);
    ok(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "excerpt", targetId: excerpt.id }));
    ok(await run(ctx, "excerpt.delete", { excerptId: excerpt.id }));
    expect((await search(ctx, "水的意象", { scopes: ["excerpt"] })).results).toEqual([]);
    expect(failure(await run(ctx, "excerpt.get", { excerptId: excerpt.id })).code).toBe("NOT_FOUND");
    expect(ok<{ materials: unknown[] }>(await run(ctx, "project.get", { projectId: project.id })).materials).toEqual([]);
  });

  it("goes with its project when the project is deleted, search entry included, and leaves the page", async () => {
    const ctx = await boot();
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "临时" }));
    const { page } = await fetchPage(ctx);
    const excerpt = await excerptOf(ctx, page.id, "旧书店的门口", { projectId: project.id });
    expect((await search(ctx, "旧书店的门口", { scopes: ["excerpt"] })).results).toHaveLength(1);
    ok(await run(ctx, "project.delete", { projectId: project.id }));
    expect((await search(ctx, "旧书店的门口", { scopes: ["excerpt"] })).results).toEqual([]);
    expect(failure(await run(ctx, "excerpt.get", { excerptId: excerpt.id })).code).toBe("NOT_FOUND");
    expect((await getPage(ctx, page.id)).page.excerpts).toBe(0);
  });

  it("is listed for its project and its page only", async () => {
    const ctx = await boot();
    const a = ok<{ id: string }>(await run(ctx, "project.create", { name: "甲" }));
    const b = ok<{ id: string }>(await run(ctx, "project.create", { name: "乙" }));
    const article = await fetchPage(ctx);
    const plain = await fetchPage(ctx, "/plain.txt");
    const one = await excerptOf(ctx, article.page.id, "路灯一盏一盏亮起", { projectId: a.id });
    const two = await excerptOf(ctx, plain.page.id, "第二行", { projectId: b.id });
    const loose = await excerptOf(ctx, article.page.id, "没有回头");
    const ids = async (input: Record<string, unknown>) => ok<{ excerpts: Excerpt[] }>(await run(ctx, "excerpt.list", input)).excerpts.map((item) => item.id).sort();
    expect(await ids({ projectId: a.id })).toEqual([one.id]);
    expect(await ids({ projectId: b.id })).toEqual([two.id]);
    expect(await ids({ pageId: article.page.id })).toEqual([one.id, loose.id].sort());
    expect(await ids({})).toEqual([one.id, two.id, loose.id].sort());
    expect(ok<{ project: { counts: { excerpts: number } } }>(await run(ctx, "project.get", { projectId: a.id })).project.counts.excerpts).toBe(1);
  });
});

describe("pages that change after an excerpt was taken", () => {
  it("says that a newer version exists, and follows the passage into it as an excerpt of its own", async () => {
    const ctx = await boot();
    const first = await fetchPage(ctx);
    const excerpt = await excerptOf(ctx, first.page.id, "路灯一盏一盏亮起，照着湿漉漉的石板路");
    expect(ok<{ status: string }>(await run(ctx, "excerpt.follow", { excerptId: excerpt.id })).status).toBe("current");
    const before = site.state.article;
    try {
      site.state.article = ARTICLE(`<p>序章：这是新加的一段话，放在文章的最前面，让后面的文字整体向后移动，偏移也就跟着变了。</p>${LONG}`);
      const second = await fetchPage(ctx);
      expect(second.changed).toBe(true);
      const old = ok<{ excerpt: Excerpt }>(await run(ctx, "excerpt.get", { excerptId: excerpt.id })).excerpt;
      expect(old).toMatchObject({ version: 1, text: excerpt.text, newerVersion: expect.objectContaining({ id: second.page.id, version: 2 }) });
      const followed = ok<{ status: string; excerpt: Excerpt }>(await run(ctx, "excerpt.follow", { excerptId: excerpt.id }));
      expect(followed.status).toBe("found");
      expect(followed.excerpt).toMatchObject({ pageId: second.page.id, version: 2, text: excerpt.text, newerVersion: null });
      expect(followed.excerpt.start).toBeGreaterThan(excerpt.start);
      expect((await getPage(ctx, second.page.id)).text.slice(followed.excerpt.start, followed.excerpt.end)).toBe(excerpt.text);
      // The old one stays, still pointing into the version it was taken from.
      expect(ok<{ excerpt: Excerpt }>(await run(ctx, "excerpt.get", { excerptId: excerpt.id })).excerpt).toMatchObject({ pageId: first.page.id, start: excerpt.start, text: excerpt.text });
    } finally { site.state.article = before; }
  });

  it("says when the passage is no longer in the newest version, and keeps the old one", async () => {
    const ctx = await boot();
    const first = await fetchPage(ctx);
    const excerpt = await excerptOf(ctx, first.page.id, "桥下的水很深，倒映着整座城市的光");
    const before = site.state.article;
    try {
      site.state.article = ARTICLE(LONG.replace("桥下的水很深，倒映着整座城市的光。", "桥下什么也没有。"));
      await fetchPage(ctx);
      expect(ok<{ status: string; excerpt?: unknown }>(await run(ctx, "excerpt.follow", { excerptId: excerpt.id }))).toEqual({ status: "missing" });
      expect(ok<{ excerpt: Excerpt }>(await run(ctx, "excerpt.get", { excerptId: excerpt.id })).excerpt.text).toBe("桥下的水很深，倒映着整座城市的光");
    } finally { site.state.article = before; }
  });

  it("keeps a version an excerpt points into when the page is fetched again and again", async () => {
    const ctx = await boot();
    const first = await fetchPage(ctx);
    await excerptOf(ctx, first.page.id, "石板路");
    const before = site.state.article;
    try {
      for (let n = 0; n < 24; n += 1) {
        site.state.article = ARTICLE(LONG + `<p>第 ${n} 次改动。</p>`);
        await fetchPage(ctx);
      }
      const versions = (await getPage(ctx, first.page.id)).versions;
      expect(versions.length).toBeLessThanOrEqual(21);
      expect(versions.some((item) => item.id === first.page.id)).toBe(true);
      expect(versions[0]!.version).toBe(25);
    } finally { site.state.article = before; }
  });

  it("deletes a page version only when no excerpt points into it, and takes its search entries with it", async () => {
    const ctx = await boot();
    const { page } = await fetchPage(ctx);
    const excerpt = await excerptOf(ctx, page.id, "手风琴");
    expect(failure(await run(ctx, "webpage.delete", { pageId: page.id }))).toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "inUse", excerpts: 1 } });
    expect((await search(ctx, "旧书店", { scopes: ["page"] })).results).toHaveLength(1);
    ok(await run(ctx, "excerpt.delete", { excerptId: excerpt.id }));
    ok(await run(ctx, "webpage.delete", { pageId: page.id }));
    expect(failure(await run(ctx, "webpage.get", { pageId: page.id })).code).toBe("NOT_FOUND");
    expect((await search(ctx, "旧书店", { scopes: ["page"] })).results).toEqual([]);
    expect(ok<{ pages: Page[] }>(await run(ctx, "webpage.list", {})).pages).toEqual([]);
  });
});

describe("searching the person's own material", () => {
  async function seed(ctx: App) {
    const book = ok<{ resourceId: string; workId: string }>(await run(ctx, "library.importText", { title: "雨夜行人", bytes: [...Buffer.from("第一章\n她在旧书店里找到了一本讲手风琴的书，书页已经发黄。")] }));
    const noteId = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "读书笔记", text: "今天读到手风琴的那一段，印象很深。" })).objectId;
    ctx.app.store.sqlite.prepare("INSERT INTO capture_sessions(id, clock_json, status, created_at, updated_at, stage, work_id) VALUES (?,?,?,?,?,?,?)").run("cap-1", "{}", "done", "2026-10-01T10:00:00.000Z", "2026-10-01T10:00:00.000Z", "done", book.workId);
    ctx.app.store.sqlite.prepare("INSERT INTO transcript_segments(id, session_id, seq, chunk_key, start_ms, end_ms, text, revised_text, state, precision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("seg-1", "cap-1", 1, "c1", 61_000, 66_000, "这里有手风琴的声音", null, "done", "segment", "2026-10-01T10:00:01.000Z", "2026-10-01T10:00:01.000Z");
    ctx.app.store.sqlite.prepare("INSERT INTO transcript_segments(id, session_id, seq, chunk_key, start_ms, end_ms, text, revised_text, state, precision, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("seg-2", "cap-1", 2, "c2", 90_000, 95_000, "错听成了别的词", "手风琴再次响起", "done", "segment", "2026-10-01T10:00:02.000Z", "2026-10-01T10:00:02.000Z");
    const { page } = await fetchPage(ctx);
    const excerpt = await excerptOf(ctx, page.id, "听见远处有人在拉手风琴");
    return { book, noteId, page, excerpt };
  }

  it("finds the same word in works, notes, recordings, excerpts and pages, each saying what it is and where", async () => {
    const ctx = await boot();
    const { book, noteId, page, excerpt } = await seed(ctx);
    const found = await search(ctx, "手风琴");
    const byKind = Object.fromEntries(found.results.map((item) => [item.kind, item]));
    expect(Object.keys(byKind).sort()).toEqual(["excerpt", "note", "page", "recording", "work"]);
    expect(found.counts).toMatchObject({ work: 1, note: 1, recording: 1, excerpt: 1, page: 1 });
    expect(byKind.work).toMatchObject({ id: book.workId, title: "雨夜行人", resourceId: book.resourceId });
    expect(byKind.note).toMatchObject({ id: noteId, title: "读书笔记" });
    expect(byKind.recording).toMatchObject({ id: "cap-1", workId: book.workId });
    expect(byKind.excerpt).toMatchObject({ id: excerpt.id });
    expect(byKind.page).toMatchObject({ id: page.id, url: page.url });
    for (const item of found.results) expect(item.snippet, item.kind).toContain("手风琴");
  });

  it("answers a recording with the place in it, the corrected wording first", async () => {
    const ctx = await boot();
    await seed(ctx);
    const first = (await search(ctx, "声音", { scopes: ["recording"] })).results;
    expect(first).toEqual([expect.objectContaining({ kind: "recording", startMs: 61_000 })]);
    const revised = (await search(ctx, "再次响起", { scopes: ["recording"] })).results;
    expect(revised).toEqual([expect.objectContaining({ startMs: 90_000 })]);
    expect((await search(ctx, "错听成了", { scopes: ["recording"] })).results).toEqual([]);
  });

  it("only looks where it was told to, and says which results a project already holds", async () => {
    const ctx = await boot();
    const { noteId } = await seed(ctx);
    expect(Object.keys((await search(ctx, "手风琴", { scopes: ["note", "work"] })).counts).length).toBeGreaterThan(0);
    expect((await search(ctx, "手风琴", { scopes: ["note"] })).results.map((item) => item.kind)).toEqual(["note"]);
    const project = ok<{ id: string }>(await run(ctx, "project.create", { name: "素材" }));
    ok(await run(ctx, "project.addMaterial", { projectId: project.id, kind: "note", targetId: noteId }));
    const inside = (await search(ctx, "手风琴", { scopes: ["note", "work"], projectId: project.id })).results;
    expect(inside.find((item) => item.kind === "note")!.inProject).toBe(true);
    expect(inside.find((item) => item.kind === "work")!.inProject).toBe(false);
  });

  it("finds nothing for a word that is nowhere, and handles text a full-text query would trip on", async () => {
    const ctx = await boot();
    await seed(ctx);
    expect((await search(ctx, "不存在的词语")).results).toEqual([]);
    for (const odd of ["\"", "'quoted'", "a AND b", "NEAR(", "*", "手风琴 OR 1=1", "%", "_"]) expect((await search(ctx, odd)).results, odd).toBeDefined();
    expect(failure(await run(ctx, "research.search", { text: "   " })).code).toBe("VALIDATION_ERROR");
    expect(failure(await run(ctx, "research.search", { text: "x", scopes: ["web"] })).code).toBe("VALIDATION_ERROR");
  });

  it("is switched off with the module, which also switches off fetching and excerpts", async () => {
    const ctx = await boot();
    const { page } = await fetchPage(ctx);
    ok(await run(ctx, "settings.setModule", { featureId: "research", enabled: false }));
    for (const [commandId, input] of [["research.search", { text: "雨" }], ["webpage.fetch", { url: `${origin.current}/article` }], ["webpage.list", {}], ["excerpt.list", {}], ["excerpt.create", { pageId: page.id, start: 0, end: 4 }]] as const) {
      expect(failure(await run(ctx, commandId, { ...input })).code, commandId).toBe("CAPABILITY_UNAVAILABLE");
    }
    ok(await run(ctx, "settings.setModule", { featureId: "research", enabled: true }));
    expect(ok<{ pages: Page[] }>(await run(ctx, "webpage.list", {})).pages).toHaveLength(1);
  });

  it("belongs to the owner: a task's grant cannot fetch, search or keep anything", async () => {
    const ctx = await boot();
    const owner = ctx.grant;
    const agent = ctx.app.issueAgentGrant(owner, { kind: "agent", id: "agent:t1" }, { readResourceIds: [], allowCommands: ["webpage.fetch", "research.search", "excerpt.create"] });
    for (const [commandId, input] of [["webpage.fetch", { url: `${origin.current}/article` }], ["research.search", { text: "雨" }], ["excerpt.create", { pageId: "x", start: 0, end: 2 }]] as const) {
      counter += 1;
      const result = await ctx.app.call({ kind: "agent", id: "agent:t1" }, { commandId, idempotencyKey: `res-${counter}`, input }, agent.handle);
      expect(result.status, commandId).toBe("error");
    }
  });
});
