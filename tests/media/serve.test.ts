import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MediaHandleTable, decideRange, mediaUrl, parseMediaUrl, serveMedia, ZipPool } from "../../packages/app-core/src/media/index.ts";
import { requireSamples, samplePath } from "../helpers/samples.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-serve-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const request = (url: string, headers: Record<string, string> = {}, method = "GET", signal?: AbortSignal) => ({
  url, method, signal, headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
});

function setup(content: Buffer, fileName = "clip.bin") {
  const handles = new MediaHandleTable();
  const zips = new ZipPool();
  const dir = path.join(root, `案例 ${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, content);
  return { handles, zips, file, env: { handles, zips } };
}

const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

describe("decideRange", () => {
  it.each([
    [undefined, 1000, { kind: "full" }],
    ["bytes=0-99", 1000, { kind: "partial", range: { start: 0, end: 99 } }],
    ["bytes=900-", 1000, { kind: "partial", range: { start: 900, end: 999 } }],
    ["bytes=-100", 1000, { kind: "partial", range: { start: 900, end: 999 } }],
    ["bytes=-5000", 1000, { kind: "partial", range: { start: 0, end: 999 } }],
    ["bytes=990-5000", 1000, { kind: "partial", range: { start: 990, end: 999 } }],
    ["bytes=1000-", 1000, { kind: "unsatisfiable" }],
    ["bytes=1000-1100", 1000, { kind: "unsatisfiable" }],
    ["bytes=-0", 1000, { kind: "unsatisfiable" }],
    ["bytes=0-0", 0, { kind: "unsatisfiable" }],
    ["bytes=50-10", 1000, { kind: "full" }],
    ["bytes=0-10,20-30", 1000, { kind: "full" }],
    ["items=0-10", 1000, { kind: "full" }],
    ["bytes=", 1000, { kind: "full" }],
    ["bytes=-", 1000, { kind: "full" }],
    ["bytes=a-b", 1000, { kind: "full" }],
    ["bytes=0-99999999999999999999", 1000, { kind: "partial", range: { start: 0, end: 999 } }],
  ])("%s on %i bytes", (header, size, expected) => {
    expect(decideRange(header as string | undefined, size as number)).toEqual(expected);
  });
});

describe("media URL parsing", () => {
  const good = mediaUrl("h" + "a".repeat(22));
  it("accepts only the fixed host with one well-formed handle", () => {
    expect(parseMediaUrl(good)).toBe("h" + "a".repeat(22));
    for (const bad of [
      "manga-media://media/", "manga-media://media/short", `${good}?x=1`, `${good}#f`, `${good}/more`, "manga-media://other/h" + "a".repeat(22),
      "manga-media://user@media/h" + "a".repeat(22), "manga-media://media:8080/h" + "a".repeat(22), "http://media/h" + "a".repeat(22),
      "manga-media://media/../h" + "a".repeat(22), "manga-media://media/%2e%2e/h" + "a".repeat(22), "manga-media://media/h" + "a".repeat(21) + "/", "not a url",
    ]) expect(parseMediaUrl(bad), bad).toBeNull();
  });
});

describe("serveMedia over a file", () => {
  it("serves 200 with the whole body and advertises ranges", async () => {
    const { env, handles, file } = setup(BODY);
    const { url } = handles.issue({ kind: "file", path: file, mediaType: "video/mp4" }, { moduleId: "manga.video" });
    const response = await serveMedia(env, request(url));
    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer()).equals(BODY)).toBe(true);
  });

  it("serves 206 for start-end, open-ended and suffix ranges with the matching bytes", async () => {
    const { env, handles, file } = setup(BODY);
    const { url } = handles.issue({ kind: "file", path: file, mediaType: "video/mp4" }, { moduleId: "manga.video" });
    for (const [range, start, end] of [["bytes=10-19", 10, 19], ["bytes=990-", 990, 999], ["bytes=-10", 990, 999], ["bytes=0-0", 0, 0]] as const) {
      const response = await serveMedia(env, request(url, { range }));
      expect(response.status, range).toBe(206);
      expect(response.headers.get("content-range"), range).toBe(`bytes ${start}-${end}/1000`);
      expect(response.headers.get("content-length"), range).toBe(String(end - start + 1));
      expect(Buffer.from(await response.arrayBuffer()).equals(BODY.subarray(start, end + 1)), range).toBe(true);
    }
  });

  it("answers 416 with the size for a range past the end, and ignores a malformed or multi range", async () => {
    const { env, handles, file } = setup(BODY);
    const { url } = handles.issue({ kind: "file", path: file, mediaType: "video/mp4" }, { moduleId: "manga.video" });
    const past = await serveMedia(env, request(url, { range: "bytes=2000-" }));
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */1000");
    for (const range of ["bytes=0-10,20-30", "garbage", "bytes=9-3"]) {
      const response = await serveMedia(env, request(url, { range }));
      expect(response.status, range).toBe(200);
      expect((await response.arrayBuffer()).byteLength, range).toBe(1000);
    }
  });

  it("answers HEAD without a body and refuses other methods", async () => {
    const { env, handles, file } = setup(BODY);
    const { url } = handles.issue({ kind: "file", path: file, mediaType: "video/mp4" }, { moduleId: "manga.video" });
    const head = await serveMedia(env, request(url, {}, "HEAD"));
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("1000");
    expect(head.body).toBeNull();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) expect((await serveMedia(env, request(url, {}, method))).status, method).toBe(405);
  });

  it("returns the same 404 for unknown, forged, expired, revoked and generation-bumped handles", async () => {
    const { env, handles, file } = setup(BODY);
    let now = 1000;
    const timed = new MediaHandleTable(() => now);
    const timedEnv = { handles: timed, zips: env.zips };
    const live = handles.issue({ kind: "file", path: file, mediaType: "video/mp4" }, { moduleId: "manga.video", subject: "copy-1" });
    const forged = mediaUrl("h" + "Z".repeat(22));
    expect((await serveMedia(env, request(forged))).status).toBe(404);
    expect((await serveMedia(env, request("manga-media://media/../etc/passwd"))).status).toBe(400);

    const expiring = timed.issue({ kind: "file", path: file, mediaType: "video/mp4" }, { moduleId: "manga.video" }, { ttlMs: 500 });
    expect((await serveMedia(timedEnv, request(expiring.url))).status).toBe(200);
    now += 501;
    expect((await serveMedia(timedEnv, request(expiring.url))).status).toBe(404);

    expect(handles.revokeSubject("copy-1")).toBe(1);
    expect((await serveMedia(env, request(live.url))).status).toBe(404);

    const again = handles.issue({ kind: "file", path: file, mediaType: "video/mp4" }, { moduleId: "manga.video" });
    handles.bumpGeneration("manga.video");
    expect((await serveMedia(env, request(again.url))).status).toBe(404);
    // A handle issued after the bump works again: the module was restarted, the old capability stays dead.
    const fresh = handles.issue({ kind: "file", path: file, mediaType: "video/mp4" }, { moduleId: "manga.video" });
    expect((await serveMedia(env, request(fresh.url))).status).toBe(200);
    // Another module's handles are untouched by the bump.
    const other = handles.issue({ kind: "file", path: file, mediaType: "image/png" }, { moduleId: "manga.comic" });
    handles.bumpGeneration("manga.video");
    expect((await serveMedia(env, request(other.url))).status).toBe(200);
  });

  it("ends a session's handles when it closes and refuses new ones for it", () => {
    const { handles, file } = setup(BODY);
    const a = handles.issue({ kind: "file", path: file, mediaType: "video/mp4" }, { moduleId: "manga.video", sessionId: "sess-1" });
    handles.issue({ kind: "file", path: file, mediaType: "video/mp4" }, { moduleId: "manga.video", sessionId: "sess-2" });
    expect(handles.closeSession("sess-1")).toBe(1);
    expect(handles.resolve(a.handle)).toBeNull();
    expect(() => handles.issue({ kind: "file", path: file, mediaType: "video/mp4" }, { moduleId: "manga.video", sessionId: "sess-1" })).toThrow(/closed/);
    expect(handles.size).toBe(1);
  });

  it("returns 404 when the file is gone and keeps the table bounded", async () => {
    const { env, handles, file } = setup(BODY);
    const { url } = handles.issue({ kind: "file", path: file, mediaType: "video/mp4" }, { moduleId: "manga.video" });
    fs.rmSync(file);
    expect((await serveMedia(env, request(url))).status).toBe(404);
    const small = new MediaHandleTable(() => Date.now(), 5);
    const issued = Array.from({ length: 8 }, () => small.issue({ kind: "buffer", bytes: BODY, mediaType: "image/png" }, { moduleId: "m" }));
    expect(small.size).toBe(5);
    expect(small.resolve(issued[0]!.handle)).toBeNull();
    expect(small.resolve(issued[7]!.handle)).not.toBeNull();
  });

  it("keeps a handle that is still being read when the table fills up", async () => {
    const small = new MediaHandleTable(() => Date.now(), 3);
    const playing = small.issue({ kind: "buffer", bytes: BODY, mediaType: "video/mp4" }, { moduleId: "manga.video" });
    const idle = small.issue({ kind: "buffer", bytes: BODY, mediaType: "image/webp" }, { moduleId: "manga.metadata" });
    small.issue({ kind: "buffer", bytes: BODY, mediaType: "image/webp" }, { moduleId: "manga.metadata" });
    // The player asks for the next range, then a page of covers fills the table.
    expect(small.resolve(playing.handle)).not.toBeNull();
    for (let i = 0; i < 2; i += 1) small.issue({ kind: "buffer", bytes: BODY, mediaType: "image/webp" }, { moduleId: "manga.metadata" });
    expect(small.size).toBe(3);
    expect(small.resolve(idle.handle)).toBeNull();
    const env = { handles: small, zips: new ZipPool() };
    const response = await serveMedia(env, request(playing.url, { range: "bytes=0-3" }));
    expect(response.status).toBe(206);
  });

  it("works for a path with Chinese characters and spaces", async () => {
    const { env, handles, file } = setup(BODY, "第 1 话 视频.bin");
    expect(file).toMatch(/案例 /);
    const { url } = handles.issue({ kind: "file", path: file, mediaType: "video/mp4" }, { moduleId: "manga.video" });
    const response = await serveMedia(env, request(url, { range: "bytes=5-9" }));
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer()).equals(BODY.subarray(5, 10))).toBe(true);
  });

  it("stops reading when the request is aborted", async () => {
    const big = Buffer.alloc(16 * 1024 * 1024, 7);
    const { env, handles, file } = setup(big);
    const { url } = handles.issue({ kind: "file", path: file, mediaType: "video/mp4" }, { moduleId: "manga.video" });
    const controller = new AbortController();
    const response = await serveMedia(env, request(url, {}, "GET", controller.signal));
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    let ended = false;
    try {
      for (let i = 0; i < 1000; i += 1) { const next = await reader.read(); if (next.done) { ended = true; break; } }
    } catch { ended = true; }
    expect(ended).toBe(true);
  });
});

describe("serveMedia over a slice, a buffer and a zip member", () => {
  it("serves a window of a file as if it were the whole body", async () => {
    const { env, handles, file } = setup(BODY);
    const { url } = handles.issue({ kind: "slice", path: file, offset: 100, length: 200, mediaType: "image/jpeg" }, { moduleId: "manga.comic" });
    const full = await serveMedia(env, request(url));
    expect(Buffer.from(await full.arrayBuffer()).equals(BODY.subarray(100, 300))).toBe(true);
    const part = await serveMedia(env, request(url, { range: "bytes=10-19" }));
    expect(part.headers.get("content-range")).toBe("bytes 10-19/200");
    expect(Buffer.from(await part.arrayBuffer()).equals(BODY.subarray(110, 120))).toBe(true);
    expect((await serveMedia(env, request(url, { range: "bytes=200-" }))).status).toBe(416);
  });

  it("serves a buffer with ranges", async () => {
    const { env, handles } = setup(BODY);
    const { url } = handles.issue({ kind: "buffer", bytes: BODY, mediaType: "image/webp" }, { moduleId: "manga.comic" });
    const part = await serveMedia(env, request(url, { range: "bytes=-4" }));
    expect(part.status).toBe(206);
    expect(Buffer.from(await part.arrayBuffer()).equals(BODY.subarray(996))).toBe(true);
  });

  it.skipIf(mediaPrerequisitesAbsent)("serves one CBZ member whole or by range, and never reaches an unsafe or encrypted member", async () => {
    requireSamples(["cbz-basic", "cbz-traversal", "cbz-encrypted"]);
    const handles = new MediaHandleTable();
    const zips = new ZipPool();
    const env = { handles, zips };
    try {
      const archive = samplePath("cbz-basic");
      const index = await zips.index(archive);
      const entry = index.entries.find((item) => item.name === "003.png")!;
      const { url } = handles.issue({ kind: "zip-entry", archive, entry: entry.name, size: entry.uncompressedSize, mediaType: "image/png" }, { moduleId: "manga.comic" });
      const whole = Buffer.from(await (await serveMedia(env, request(url))).arrayBuffer());
      expect(whole.length).toBe(entry.uncompressedSize);
      expect(whole.subarray(1, 4).toString("latin1")).toBe("PNG");
      const part = await serveMedia(env, request(url, { range: "bytes=0-7" }));
      expect(part.status).toBe(206);
      expect(Buffer.from(await part.arrayBuffer()).equals(whole.subarray(0, 8))).toBe(true);

      const missing = handles.issue({ kind: "zip-entry", archive, entry: "nope.png", size: 10, mediaType: "image/png" }, { moduleId: "manga.comic" });
      expect((await serveMedia(env, request(missing.url))).status).toBe(404);

      const traversal = samplePath("cbz-traversal");
      const tIndex = await zips.index(traversal);
      const unsafe = tIndex.entries.find((item) => item.unsafe);
      expect(unsafe).toBeTruthy();
      const bad = handles.issue({ kind: "zip-entry", archive: traversal, entry: unsafe!.name, size: unsafe!.uncompressedSize, mediaType: "image/png" }, { moduleId: "manga.comic" });
      expect((await serveMedia(env, request(bad.url))).status).toBeGreaterThanOrEqual(400);

      const encrypted = samplePath("cbz-encrypted");
      const eIndex = await zips.index(encrypted);
      const locked = eIndex.entries.find((item) => item.encrypted)!;
      const sealed = handles.issue({ kind: "zip-entry", archive: encrypted, entry: locked.name, size: locked.uncompressedSize, mediaType: "image/png" }, { moduleId: "manga.comic" });
      expect((await serveMedia(env, request(sealed.url))).status).toBeGreaterThanOrEqual(400);
    } finally { zips.close(); }
  });
});
