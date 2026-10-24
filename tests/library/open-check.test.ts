import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createId } from "@manga/contracts";
import { startApp } from "../helpers/app.ts";
import { picture } from "../helpers/fake-bangumi.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";

/**
 * One check stands in front of every way of opening a resource (A-86, AT-99): the commands that read its file or hand out a picture of it, the
 * services behind them, the play copy and the page cache. A file outside every library path and a file that is not where its library path says
 * are told apart, and the same answer comes from every door. Housekeeping that does not read the file is still allowed, and what was made on
 * the resource is never part of the refusal.
 */
type App = Awaited<ReturnType<typeof startApp>>;
type Result = Awaited<ReturnType<App["app"]["call"]>>;
const apps: App[] = [];
const dirs: string[] = [];
let counter = 0;
afterEach(() => {
  while (apps.length) { try { apps.pop()!.app.close(); } catch { /* closed */ } }
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (prefix = "open") => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `manga-${prefix}-`)); dirs.push(dir); return dir; };
async function boot() { const ctx = await startApp(); apps.push(ctx); return ctx; }
async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Result> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `open-${counter}`, input }, ctx.grant.handle);
}
const ok = <T = Record<string, any>>(result: Result): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};
const errorOf = (result: Result) => {
  expect(result.status, JSON.stringify(result)).toBe("error");
  return (result as { error: { code: string; message: string; details?: Record<string, any> } }).error;
};
/** The refusal every door gives for the same state. */
const OUTSIDE = (folder: string) => ({ code: "LOCATION_UNAVAILABLE", details: { reason: "outside-library", folder } });
const MISSING = (relativePath: string) => ({ code: "LOCATION_UNAVAILABLE", details: expect.objectContaining({ reason: "file-missing", relativePath, rootReachable: true }) });
const chapter = (title: string) => `${title}\n\n${"这是用于打开检查测试的一段合成文字。".repeat(20)}\n`;

/** A folder registered as a library path, and a file in it that the resource's newest revision points at. */
function place(ctx: App, revisionId: string, kind: "novel" | "comic" | "video", relativePath: string, options: { create?: boolean } = {}) {
  const root = scratch("lib");
  const id = createId("lpath");
  ctx.app.store.sqlite.prepare("INSERT INTO library_paths(id, path, media_kind, auto_scan, created_at) VALUES (?,?,?,0,?)").run(id, root, kind, new Date().toISOString());
  const file = path.join(root, ...relativePath.split("/"));
  if (options.create !== false) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "synthetic"); }
  ctx.app.store.sqlite.prepare("DELETE FROM file_locations WHERE resource_revision_id = ?").run(revisionId);
  ctx.app.store.sqlite.prepare("INSERT INTO file_locations(id, resource_revision_id, library_path_id, relative_path, fingerprint, available, hosted) VALUES (?,?,?,?,?,1,0)").run(createId("loc"), revisionId, id, relativePath, "f".repeat(64));
  return { root, id, file };
}
/** The file of a revision is under no library path any more: what the library keeps is where it was, as an absolute path. */
function leaveLibrary(ctx: App, revisionId: string, file: string) {
  ctx.app.store.sqlite.prepare("UPDATE file_locations SET library_path_id = NULL, legacy_path = ?, available = 0 WHERE resource_revision_id = ?").run(file, revisionId);
}
const ONE_BY_ONE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64").toString("base64");

describe("a novel is opened only when its file can be", () => {
  it("answers every read with the same reason: outside every library path, or not where its library path says", async () => {
    const ctx = await boot();
    const root = scratch("novel");
    const file = path.join(root, "甲系列", "第1话.txt");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, chapter("甲一"));
    ok(await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", root), mediaKind: "novel", autoScan: false }));
    await ctx.app.scan.whenIdle();
    const imported = ok<{ resourceId: string; revisionId: string }>(await run(ctx, "library.importDocument", { title: "第1话", pathHandle: ctx.app.registerPath("file", file) }));
    const { resourceId } = imported;
    const reads = [
      ["library.read", { resourceId }],
      ["library.readSlice", { resourceId, partId: "body", start: 0, limit: 10 }],
      ["library.readOriginal", { resourceId }],
    ] as const;

    expect(ok(await run(ctx, "library.openable", { resourceId }))).toMatchObject({ state: "open", resourceId, mediaKind: "novel", title: "第1话" });
    ok(await run(ctx, "library.read", { resourceId }));

    // The file is gone from its place, the library path is still there.
    fs.rmSync(file);
    expect(ok(await run(ctx, "library.openable", { resourceId }))).toMatchObject({ state: "missing", relativePath: "甲系列/第1话.txt", rootReachable: true, libraryPath: expect.any(String) });
    for (const [commandId, input] of reads) expect(errorOf(await run(ctx, commandId, { ...input })), commandId).toMatchObject(MISSING("甲系列/第1话.txt"));

    // The file is back: the same door opens again, nothing was changed by having asked.
    fs.writeFileSync(file, chapter("甲一"));
    expect(ok(await run(ctx, "library.openable", { resourceId }))).toMatchObject({ state: "open" });
    ok(await run(ctx, "library.read", { resourceId }));

    // The library path is removed: the file is under no library path, and the answer says which folder would hold it.
    const pathId = (ctx.app.store.sqlite.prepare("SELECT id FROM library_paths").get() as { id: string }).id;
    ok(await run(ctx, "library.paths.remove", { pathId }));
    expect(ok(await run(ctx, "library.openable", { resourceId }))).toMatchObject({ state: "outside", folder: path.dirname(file) });
    for (const [commandId, input] of reads) expect(errorOf(await run(ctx, commandId, { ...input })), commandId).toMatchObject(OUTSIDE(path.dirname(file)));
  }, 60_000);

  it("asks nothing of a text that was pasted in, which has no file to be outside of", async () => {
    const ctx = await boot();
    const pasted = ok<{ resourceId: string }>(await run(ctx, "library.importText", { title: "随手贴的", bytes: Array.from(Buffer.from(chapter("乙一"), "utf8")) }));
    expect(ok(await run(ctx, "library.openable", { resourceId: pasted.resourceId }))).toMatchObject({ state: "open" });
    ok(await run(ctx, "library.read", { resourceId: pasted.resourceId }));
  });

  it("answers a resource that does not exist as not found", async () => {
    const ctx = await boot();
    expect(errorOf(await run(ctx, "library.openable", { resourceId: createId("res") })).code).toBe("NOT_FOUND");
  });
});

describe("a comic is opened only when its file can be", () => {
  it("refuses the page list, the page pictures and a region of a page, from the same state", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "合成漫画 01" });
    const page = comic.pageIds[0]!;
    const doors: Array<[string, Record<string, unknown>]> = [
      ["comic.pages", { resourceId: comic.resourceId }],
      ["comic.pageHandle", { resourceId: comic.resourceId, revisionId: comic.revisionId, pageId: page }],
      ["comic.pageHandles", { resourceId: comic.resourceId, revisionId: comic.revisionId, pageIds: [page] }],
      ["material.region", { resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: page }],
    ];

    // No file at all is nothing to be outside of; the page list is a read of the stored pages.
    ok(await run(ctx, "comic.pages", { resourceId: comic.resourceId }));

    const placed = place(ctx, comic.revisionId, "comic", "合成漫画 01.cbz", { create: false });
    expect(ok(await run(ctx, "library.openable", { resourceId: comic.resourceId }))).toMatchObject({ state: "missing", relativePath: "合成漫画 01.cbz", mediaKind: "comic" });
    for (const [commandId, input] of doors) expect(errorOf(await run(ctx, commandId, input)), commandId).toMatchObject(MISSING("合成漫画 01.cbz"));

    leaveLibrary(ctx, comic.revisionId, placed.file);
    expect(ok(await run(ctx, "library.openable", { resourceId: comic.resourceId }))).toMatchObject({ state: "outside", folder: path.dirname(placed.file) });
    for (const [commandId, input] of doors) expect(errorOf(await run(ctx, commandId, input)), commandId).toMatchObject(OUTSIDE(path.dirname(placed.file)));
  });

  it("opens the page list again once the file is where its library path says", async () => {
    const ctx = await boot();
    const comic = seedComic(ctx.app, { title: "合成漫画 02" });
    const placed = place(ctx, comic.revisionId, "comic", "合成漫画 02.cbz");
    expect(ok(await run(ctx, "library.openable", { resourceId: comic.resourceId }))).toMatchObject({ state: "open", path: placed.file });
    ok(await run(ctx, "comic.pages", { resourceId: comic.resourceId }));
    fs.rmSync(placed.file);
    expect(errorOf(await run(ctx, "comic.pages", { resourceId: comic.resourceId })).details).toMatchObject({ reason: "file-missing" });
    fs.writeFileSync(placed.file, "synthetic");
    ok(await run(ctx, "comic.pages", { resourceId: comic.resourceId }));
  });
});

describe("a video is opened only when its file can be, play copy included", () => {
  function video(ctx: App, title: string) {
    const root = scratch("video");
    const file = path.join(root, `${title}.mp4`);
    fs.writeFileSync(file, "synthetic");
    const seeded = seedVideo(ctx.app, { title, file });
    return { ...seeded, file, root };
  }
  const doors = (v: { resourceId: string; revisionId: string }): Array<[string, Record<string, unknown>]> => [
    ["video.probe", { resourceId: v.resourceId }],
    ["video.probe", { resourceId: v.resourceId, refresh: true }],
    ["video.subtitles", { resourceId: v.resourceId }],
    ["video.audioTracks", { resourceId: v.resourceId }],
    ["video.frameIndex", { resourceId: v.resourceId, timeMs: 1000 }],
    ["video.keyframes", { resourceId: v.resourceId }],
    ["video.playbackPlan", { resourceId: v.resourceId }],
    ["video.playCopy", { resourceId: v.resourceId, revisionId: v.revisionId, action: "create" }],
    ["video.handle", { resourceId: v.resourceId, revisionId: v.revisionId, source: "original" }],
    ["video.subtitleHandle", { resourceId: v.resourceId, revisionId: v.revisionId, trackId: "sub-1" }],
    ["video.fonts", { resourceId: v.resourceId, revisionId: v.revisionId }],
    ["material.frame", { resourceId: v.resourceId, resourceRevisionId: v.revisionId, timeMs: 1000 }],
    ["danmaku.match", { resourceId: v.resourceId, resourceRevisionId: v.revisionId }],
    ["screenshot.save", { resourceId: v.resourceId, data: ONE_BY_ONE, video: { positionMs: 1000 } }],
  ];

  it("refuses every door when the file is not where its library path says, and every door when it is outside", async () => {
    const ctx = await boot();
    const v = video(ctx, "合成视频 01");
    ok(await run(ctx, "video.probe", { resourceId: v.resourceId }));

    fs.rmSync(v.file);
    expect(ok(await run(ctx, "library.openable", { resourceId: v.resourceId }))).toMatchObject({ state: "missing", relativePath: "合成视频 01.mp4", mediaKind: "video" });
    for (const [commandId, input] of doors(v)) expect(errorOf(await run(ctx, commandId, input)), `${commandId} ${JSON.stringify(input)}`).toMatchObject(MISSING("合成视频 01.mp4"));

    leaveLibrary(ctx, v.revisionId, v.file);
    expect(ok(await run(ctx, "library.openable", { resourceId: v.resourceId }))).toMatchObject({ state: "outside", folder: v.root });
    for (const [commandId, input] of doors(v)) expect(errorOf(await run(ctx, commandId, input)), `${commandId} ${JSON.stringify(input)}`).toMatchObject(OUTSIDE(v.root));
    // Nothing was saved by the refused screenshot.
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM screenshots").get()).toEqual({ n: 0 });
  }, 60_000);

  it("does not serve a play copy of a video that cannot be opened, though the copy is on disk", async () => {
    const ctx = await boot();
    const v = video(ctx, "合成视频 02");
    // A copy that is ready, with its file in the play copy folder, as a finished conversion leaves it.
    const copyDir = ctx.app.media.dir("play-copies");
    fs.mkdirSync(copyDir, { recursive: true });
    const copyId = createId("pcopy");
    fs.writeFileSync(path.join(copyDir, `${copyId}.mp4`), "synthetic copy");
    ctx.app.store.sqlite.prepare("INSERT INTO play_copies(id, resource_revision_id, reason, state, audio_stream_index, file_name, bytes, encoder, tool_version, progress, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(copyId, v.revisionId, "unsupported_video", "ready", null, `${copyId}.mp4`, 14, "libx264", "test", 1, new Date().toISOString(), new Date().toISOString());
    const request = { resourceId: v.resourceId, revisionId: v.revisionId, source: "play_copy", copyId };

    // While the file can be opened the copy is served, so the refusals below are the check and not a missing copy.
    const issued = ok<{ handle: string; copyId: string }>(await run(ctx, "video.handle", request));
    expect(issued.copyId).toBe(copyId);
    expect(ctx.app.media.handles.resolve(issued.handle)).not.toBeNull();

    fs.rmSync(v.file);
    expect(errorOf(await run(ctx, "video.handle", request))).toMatchObject(MISSING("合成视频 02.mp4"));
    leaveLibrary(ctx, v.revisionId, v.file);
    expect(errorOf(await run(ctx, "video.handle", request))).toMatchObject(OUTSIDE(v.root));
    expect(errorOf(await run(ctx, "video.handle", { ...request, copyId: undefined }))).toMatchObject(OUTSIDE(v.root));
    // The copy itself is untouched by the refusal.
    expect(fs.existsSync(path.join(copyDir, `${copyId}.mp4`))).toBe(true);
  }, 60_000);

  it("still lets the copy and the frame table be looked at and stopped, which read no file", async () => {
    const ctx = await boot();
    const v = video(ctx, "合成视频 03");
    fs.rmSync(v.file);
    expect(ok<{ copies: unknown[] }>(await run(ctx, "video.playCopy", { resourceId: v.resourceId, revisionId: v.revisionId, action: "status" })).copies).toEqual([]);
    ok(await run(ctx, "video.playCopy", { resourceId: v.resourceId, revisionId: v.revisionId, action: "cancel" }));
    expect(ok<{ removed: boolean }>(await run(ctx, "video.playCopy", { resourceId: v.resourceId, revisionId: v.revisionId, action: "remove" }))).toBeTruthy();
    ok(await run(ctx, "video.cancelFrameIndex", { resourceId: v.resourceId }));
    leaveLibrary(ctx, v.revisionId, v.file);
    ok(await run(ctx, "video.playCopy", { resourceId: v.resourceId, revisionId: v.revisionId, action: "status" }));
    ok(await run(ctx, "video.cancelFrameIndex", { resourceId: v.resourceId }));
  });
});

describe("taking a library path away withdraws what was issued for its files", () => {
  it("revokes the handles of the resources it held, tells the windows, and keeps the session and the resources", async () => {
    const ctx = await boot();
    const root = scratch("held");
    const file = path.join(root, "合成视频 04.mp4");
    fs.writeFileSync(file, "synthetic");
    const pathId = ok<{ path: { id: string } }>(await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", root), mediaKind: "video", autoScan: false })).path.id;
    const v = seedVideo(ctx.app, { title: "合成视频 04", file });
    const other = seedVideo(ctx.app, { title: "别的视频", file: (() => { const f = path.join(scratch("other"), "别的.mp4"); fs.writeFileSync(f, "synthetic"); return f; })() });
    const mine = ok<{ handle: string }>(await run(ctx, "video.handle", { resourceId: v.resourceId, revisionId: v.revisionId, source: "original" }));
    const theirs = ok<{ handle: string }>(await run(ctx, "video.handle", { resourceId: other.resourceId, revisionId: other.revisionId, source: "original" }));
    const session = ok<{ id: string }>(await run(ctx, "session.open", { kind: "resource", targetId: v.resourceId, contextId: null }));

    const notices: Array<{ topic: string; payload: Record<string, any> }> = [];
    ctx.app.onNotice((notice) => { if (notice.topic === "library.pathRemoved") notices.push(notice as unknown as { topic: string; payload: Record<string, any> }); });
    const rows = (sql: string) => ctx.app.store.sqlite.prepare(sql).all();
    ok(await run(ctx, "library.paths.remove", { pathId }));

    expect(ctx.app.media.handles.resolve(mine.handle)).toBeNull();
    expect(ctx.app.media.handles.resolve(theirs.handle)).not.toBeNull();
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toMatchObject({ pathId, resourceIds: [v.resourceId] });
    // The session stays and says the resource is not to be opened; the others are still open.
    const listed = ok<Array<{ sessionId: string; openState: string; targetId: string | null }>>(await run(ctx, "workspace.sessions", { contextId: null }));
    expect(listed.find((item) => item.sessionId === session.id)).toMatchObject({ openState: "outside", targetId: v.resourceId });
    expect(listed.find((item) => item.targetId === other.resourceId)?.openState ?? "open").toBe("open");
    expect(rows("SELECT id FROM resources")).toHaveLength(2);
  }, 60_000);
});
