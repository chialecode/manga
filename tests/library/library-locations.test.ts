import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { absoluteIn, assertOpenable, insertLocation, placeInLibrary, relativeWithin, requireInLibrary, resolveLocation } from "../../packages/app-core/src/library-locations.ts";
import { startApp } from "../helpers/app.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";
import { inLibrary, requireSamples, samplePath } from "../helpers/samples.ts";

/**
 * A resource's file is a library path plus a path inside it, and nothing reads a file any other way (A-80, AT-93): the resolver, the
 * entries that used to bypass the library, the library path that changes its folder, and what a resource outside every path keeps.
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
const scratch = (prefix = "loc") => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `manga-${prefix}-`)); dirs.push(dir); return dir; };
async function boot() { const ctx = await startApp(); apps.push(ctx); return ctx; }
async function run(ctx: App, commandId: string, input: Record<string, unknown>): Promise<Result> {
  counter += 1;
  return ctx.app.call(ctx.actor, { commandId, idempotencyKey: `loc-${counter}`, input }, ctx.grant.handle);
}
function ok<T = Record<string, any>>(result: Result): T {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
}
const failure = (result: Result) => {
  expect(result.status).toBe("error");
  return (result as { error: { code: string; message: string; details?: Record<string, any> } }).error;
};
function write(root: string, rel: string, body: string): string {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}
const chapter = (title: string) => `${title}\n\n${"这是用于资源库位置测试的一段合成文字。".repeat(20)}\n`;
async function addPath(ctx: App, dir: string, kind: "novel" | "comic" | "video" = "novel") {
  const added = ok<{ path: { id: string } }>(await run(ctx, "library.paths.add", { pathHandle: ctx.app.registerPath("directory", dir), mediaKind: kind, autoScan: false }));
  await ctx.app.scan.whenIdle();
  return added.path.id;
}
const imported = (ctx: App, file: string, title: string) => run(ctx, "library.importDocument", { title, pathHandle: ctx.app.registerPath("file", file) });
const locationsOf = (ctx: App) => ctx.app.store.sqlite.prepare("SELECT library_path_id AS lib, relative_path AS rel, legacy_path AS legacy, hosted, available FROM file_locations ORDER BY rowid").all() as Array<{ lib: string | null; rel: string; legacy: string | null; hosted: number; available: number }>;

describe("the resolver: a library path plus a path inside it", () => {
  it("turns a path into the pair and back, with / separators and . for the library path itself", async () => {
    const ctx = await boot();
    const root = scratch();
    await addPath(ctx, root);
    const file = write(root, "甲/乙/第1话.txt", chapter("一"));
    const placed = placeInLibrary(ctx.app.store, file)!;
    expect(placed).toMatchObject({ relativePath: "甲/乙/第1话.txt", managed: false });
    expect(placeInLibrary(ctx.app.store, root)).toMatchObject({ libraryPathId: placed.libraryPathId, relativePath: "." });
    expect(absoluteIn(placed.root, placed.relativePath)).toBe(file);
    expect(absoluteIn(placed.root, ".")).toBe(placed.root);
    // Next to the library path is not inside it, even when the names start the same.
    expect(placeInLibrary(ctx.app.store, `${root}-other${path.sep}x.txt`)).toBeNull();
    expect(relativeWithin(root, path.join(root, "..", "elsewhere.txt"))).toBeNull();
  });

  it("refuses a stored value that would leave its library path, whatever it looks like", () => {
    for (const bad of ["../x.txt", "a/../../x.txt", "a//b.txt", "a\\b.txt", ["C:", "x.txt"].join("/"), "/abs.txt"]) {
      expect(() => absoluteIn(path.join(os.tmpdir(), "root"), bad), bad).toThrow(expect.objectContaining({ code: "PATH_ESCAPE" }));
    }
  });

  it("takes the longest library path and puts the application's own one last", async () => {
    const ctx = await boot();
    const root = scratch();
    await addPath(ctx, root);
    const managed = ctx.app.store.ensureManagedLibraryPath();
    expect(placeInLibrary(ctx.app.store, path.join(managed.path, "x.bin"))).toMatchObject({ libraryPathId: managed.id, managed: true, relativePath: "x.bin" });
    expect(() => requireInLibrary(ctx.app.store, path.join(scratch(), "x.txt"))).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR", details: expect.objectContaining({ reason: "outside-library" }) }));
  });
});

describe("a file outside every library path is not read (AT-93)", () => {
  it("refuses an import, a folder import and a repair, each naming the folder to add", async () => {
    const ctx = await boot();
    const library = scratch("lib");
    const elsewhere = scratch("elsewhere");
    await addPath(ctx, library);
    const stray = write(elsewhere, "书/外面的书.txt", chapter("外面"));

    const single = failure(await imported(ctx, stray, "外面的书"));
    expect(single).toMatchObject({ code: "VALIDATION_ERROR", details: { reason: "outside-library", folder: path.dirname(stray) } });
    const folder = failure(await run(ctx, "works.importDirectory", { pathHandle: ctx.app.registerPath("directory", path.join(elsewhere, "书")), kind: "novel" }));
    expect(folder).toMatchObject({ details: { reason: "outside-library", folder: path.join(elsewhere, "书") } });

    const inside = write(library, "里面的书.txt", chapter("里面"));
    const book = ok<{ resourceId: string }>(await imported(ctx, inside, "里面的书"));
    const repair = failure(await run(ctx, "library.repairSource", { resourceId: book.resourceId, pathHandle: ctx.app.registerPath("file", stray) }));
    expect(repair).toMatchObject({ details: { reason: "outside-library", folder: path.dirname(stray) } });

    // None of it left anything behind.
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get()).toEqual({ n: 1 });
    expect(locationsOf(ctx)).toEqual([{ lib: expect.any(String), rel: "里面的书.txt", legacy: null, hosted: 0, available: 1 }]);
    expect(fs.readdirSync(path.join(elsewhere, "书"))).toEqual(["外面的书.txt"]);
  });

  it("keeps pasted text and the application's own copies working: they have a place in the application's library path", async () => {
    const ctx = await boot();
    const pasted = ok<{ resourceId: string }>(await run(ctx, "library.importDocument", { title: "粘贴的文字", bytes: [...Buffer.from(chapter("粘贴"))], format: "txt" }));
    const kept = ok<{ resourceId: string; revisionId: string }>(await run(ctx, "library.importDocument", { title: "应用保管的书", bytes: [...Buffer.from(chapter("保管"))], format: "txt", hosted: true }));
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM file_locations fl JOIN resource_revisions v ON v.id = fl.resource_revision_id WHERE v.resource_id = ?").get(pasted.resourceId)).toEqual({ n: 0 });
    const location = resolveLocation(ctx.app.store, kept.revisionId)!;
    expect(location).toMatchObject({ managed: true, outside: false, relativePath: `${kept.revisionId}.bin` });
    expect(fs.existsSync(location.path!)).toBe(true);
    expect(path.dirname(location.path!)).toBe(ctx.app.store.managedLibraryDir);
    expect(() => assertOpenable(ctx.app.store, pasted.resourceId)).not.toThrow();
    expect(() => assertOpenable(ctx.app.store, kept.resourceId)).not.toThrow();
    // Both stay readable, and the application's own library path is never listed as one of the user's.
    ok(await run(ctx, "library.read", { resourceId: pasted.resourceId }));
    ok(await run(ctx, "library.read", { resourceId: kept.resourceId }));
    expect(ok<{ paths: unknown[] }>(await run(ctx, "library.paths.list", {})).paths).toEqual([]);
  });

  it("does not let the application's own library path be scanned, changed or removed", async () => {
    const ctx = await boot();
    ok(await run(ctx, "library.importDocument", { title: "保管", bytes: [...Buffer.from(chapter("保管"))], format: "txt", hosted: true }));
    const managed = ctx.app.store.ensureManagedLibraryPath();
    for (const [commandId, input] of [["library.paths.remove", { pathId: managed.id }], ["library.scan.start", { pathId: managed.id }], ["library.paths.update", { pathId: managed.id, autoScan: true }]] as const) {
      expect(failure(await run(ctx, commandId, input)).details, commandId).toMatchObject({ reason: "managed" });
    }
    ok(await run(ctx, "library.scan.start", {}));
    await ctx.app.scan.whenIdle();
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM library_files WHERE path_id = ?").get(managed.id)).toEqual({ n: 0 });
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM library_paths WHERE managed = 1").get()).toEqual({ n: 1 });
  });
});

describe("a library path that changes its folder (AT-93)", () => {
  it("moves to the folder holding the same files, and every resource, its progress and what was made on it keep working", async () => {
    const ctx = await boot();
    const before = scratch("before");
    write(before, "甲系列/第1话.txt", chapter("甲一"));
    write(before, "甲系列/第2话.txt", chapter("甲二"));
    write(before, "乙系列/第1话.txt", chapter("乙一"));
    const pathId = await addPath(ctx, before);
    // The scan registers the files; a scan with the library path imports what it finds as resources.
    ok(await run(ctx, "library.scan.start", { pathId }));
    await ctx.app.scan.whenIdle();
    const resources = ctx.app.store.sqlite.prepare("SELECT id FROM resources ORDER BY title").all() as Array<{ id: string }>;
    expect(resources.length).toBe(3);
    const note = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "笔记", text: "评论", resourceId: resources[0]!.id }));

    // The folder is moved on disk: the drive letter changed, the folder was renamed.
    const after = path.join(scratch("after"), "新位置");
    fs.renameSync(before, after);
    const relocated = ok<{ moved: boolean; checked: number; path: { path: string } }>(await run(ctx, "library.paths.update", { pathId, pathHandle: ctx.app.registerPath("directory", after) }));
    expect(relocated).toMatchObject({ moved: true, path: { path: after } });
    expect(relocated.checked).toBeGreaterThanOrEqual(1);
    await ctx.app.scan.whenIdle();

    // Same resources, no new ones, all available, nothing re-imported; the stored relative paths did not change at all.
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get()).toEqual({ n: 3 });
    expect(locationsOf(ctx).map((row) => row.rel).sort()).toEqual(["乙系列/第1话.txt", "甲系列/第1话.txt", "甲系列/第2话.txt"]);
    for (const resource of resources) {
      const content = ok<{ resource: { available: boolean; outside: boolean } }>(await run(ctx, "library.resourceContent", { resourceId: resource.id }));
      expect(content.resource).toMatchObject({ available: true, outside: false });
    }
    ok(await run(ctx, "library.read", { resourceId: resources[0]!.id }));
    expect(ok<{ notes: Array<{ objectId: string }> }>(await run(ctx, "library.resourceContent", { resourceId: resources[0]!.id })).notes.map((item) => item.objectId)).toEqual([note.objectId]);
  }, 60_000);

  it("refuses a folder that does not hold the same files, and changes nothing", async () => {
    const ctx = await boot();
    const before = scratch("keep");
    write(before, "丙系列/第1话.txt", chapter("丙一"));
    write(before, "丙系列/第2话.txt", chapter("丙二"));
    const pathId = await addPath(ctx, before);
    ok(await run(ctx, "library.scan.start", { pathId }));
    await ctx.app.scan.whenIdle();
    const rows = locationsOf(ctx);

    const wrong = scratch("wrong");
    write(wrong, "丙系列/第1话.txt", chapter("别的内容"));
    write(wrong, "丙系列/第2话.txt", chapter("还是别的内容"));
    const mismatch = failure(await run(ctx, "library.paths.update", { pathId, pathHandle: ctx.app.registerPath("directory", wrong) }));
    expect(mismatch.details).toMatchObject({ reason: "fingerprint-mismatch" });
    const empty = failure(await run(ctx, "library.paths.update", { pathId, pathHandle: ctx.app.registerPath("directory", scratch("empty")) }));
    expect(empty.details).toMatchObject({ reason: "fingerprint-mismatch" });

    expect(locationsOf(ctx)).toEqual(rows);
    expect(ok<{ paths: Array<{ path: string }> }>(await run(ctx, "library.paths.list", {})).paths.map((item) => item.path)).toEqual([before]);
  }, 60_000);

  it("refuses a folder that overlaps another library path", async () => {
    const ctx = await boot();
    const one = scratch("one");
    const two = scratch("two");
    write(one, "a.txt", chapter("a"));
    await addPath(ctx, one);
    const second = await addPath(ctx, two);
    const nested = path.join(one, "子目录");
    fs.mkdirSync(nested, { recursive: true });
    const overlap = failure(await run(ctx, "library.paths.update", { pathId: second, pathHandle: ctx.app.registerPath("directory", nested) }));
    expect(overlap.details).toMatchObject({ reason: "overlap" });
  });
});

describe("a resource outside every library path keeps what was made on it, and cannot be opened (AT-93)", () => {
  async function removedPath() {
    const ctx = await boot();
    const root = scratch("gone");
    const file = write(root, "丁系列/第1话.txt", chapter("丁一"));
    const pathId = await addPath(ctx, root);
    ok(await run(ctx, "library.scan.start", { pathId }));
    await ctx.app.scan.whenIdle();
    const resourceId = (ctx.app.store.sqlite.prepare("SELECT id FROM resources").get() as { id: string }).id;
    const revisionId = (ctx.app.store.sqlite.prepare("SELECT id FROM resource_revisions").get() as { id: string }).id;
    const locator = { kind: "text", partId: "body", representationId: revisionId, normalizationVersion: "nfc-lf-codepoint-v1", range: { start: 0, end: 2 }, quote: { exact: "丁一" } };
    const note = ok<{ objectId: string }>(await run(ctx, "notes.create", { title: "留下的笔记", text: "评论", resourceId, resourceRevisionId: revisionId, locator }));
    ok(await run(ctx, "reading.setBookmark", { resourceId, resourceRevisionId: revisionId, label: "书签", locator }));
    ok(await run(ctx, "library.read", { resourceId }));
    ok(await run(ctx, "library.paths.remove", { pathId }));
    return { ctx, root, file, pathId, resourceId, note };
  }

  it("answers a read with the folder to add, lists the notes and bookmarks, and says where the file was", async () => {
    const { ctx, file, resourceId, note } = await removedPath();
    expect(locationsOf(ctx)).toEqual([{ lib: null, rel: "丁系列/第1话.txt", legacy: file, hosted: 0, available: 0 }]);
    const refused = failure(await run(ctx, "library.read", { resourceId }));
    expect(refused).toMatchObject({ code: "LOCATION_UNAVAILABLE", details: { reason: "outside-library", folder: path.dirname(file) } });
    expect(failure(await run(ctx, "library.readSlice", { resourceId, partId: "body", start: 0, limit: 10 }))).toMatchObject({ code: "LOCATION_UNAVAILABLE" });

    const content = ok<{ resource: { available: boolean; outside: boolean; path: string | null; libraryRoot: string | null; folderToAdd: string | null }; notes: Array<{ objectId: string }>; bookmarks: unknown[] }>(await run(ctx, "library.resourceContent", { resourceId }));
    expect(content.resource).toMatchObject({ available: false, outside: true, path: file, libraryRoot: null, folderToAdd: path.dirname(file) });
    expect(content.notes.map((item) => item.objectId)).toEqual([note.objectId]);
    expect(content.bookmarks).toHaveLength(1);
  });

  it("is opened again by adding its folder as a library path: a scan finds the same file and the resource follows it", async () => {
    const { ctx, root, resourceId, note } = await removedPath();
    const again = await addPath(ctx, root);
    ok(await run(ctx, "library.scan.start", { pathId: again }));
    await ctx.app.scan.whenIdle();
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get()).toEqual({ n: 1 });
    expect(locationsOf(ctx)).toEqual([{ lib: again, rel: "丁系列/第1话.txt", legacy: null, hosted: 0, available: 1 }]);
    ok(await run(ctx, "library.read", { resourceId }));
    expect(ok<{ notes: Array<{ objectId: string }> }>(await run(ctx, "library.resourceContent", { resourceId })).notes.map((item) => item.objectId)).toEqual([note.objectId]);
  }, 60_000);

  it("is pointed at its file again only by a file inside a library path", async () => {
    const { ctx, root, resourceId } = await removedPath();
    const outsideCopy = write(scratch("copy"), "第1话.txt", chapter("丁一"));
    expect(failure(await run(ctx, "library.repairSource", { resourceId, pathHandle: ctx.app.registerPath("file", outsideCopy) })).details).toMatchObject({ reason: "outside-library" });
    await addPath(ctx, root);
    const inside = path.join(root, "丁系列", "第1话.txt");
    const repaired = ok<{ resourceId: string }>(await run(ctx, "library.repairSource", { resourceId, pathHandle: ctx.app.registerPath("file", inside) }));
    expect(repaired.resourceId).toBe(resourceId);
    expect(resolveLocation(ctx.app.store, (ctx.app.store.sqlite.prepare("SELECT id FROM resource_revisions ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { id: string }).id)).toMatchObject({ outside: false, relativePath: "丁系列/第1话.txt" });
    ok(await run(ctx, "library.read", { resourceId }));
  }, 60_000);
});

describe.skipIf(mediaPrerequisitesAbsent)("a video or a comic is re-located only by the same content inside a library path (AT-93)", () => {
  requireSamples(["video-mp4-h264-aac", "cbz-basic", "cbz-comicinfo"]);

  it("takes the same video at a new place inside a library path, and refuses another video, a file outside, and a second copy of the wrong content", async () => {
    const ctx = await boot();
    const library = scratch("video-lib");
    const original = path.join(library, "第一集.mp4");
    fs.copyFileSync(samplePath("video-mp4-h264-aac"), original);
    await addPath(ctx, library, "video");
    const video = ok<{ resourceId: string; revisionId: string }>(await run(ctx, "library.importDocument", { title: "第一集", kind: "video", pathHandle: ctx.app.registerPath("file", original) }));
    expect(resolveLocation(ctx.app.store, video.revisionId)).toMatchObject({ relativePath: "第一集.mp4", outside: false });

    // The file is moved inside the library path: the old place is gone, the new one holds the same bytes.
    const moved = path.join(library, "整理", "第1集.mp4");
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    // A copy stands for the file at its new place (the media tools may still hold the first one open on Windows).
    await ctx.app.media.jobs.idle();
    fs.copyFileSync(original, moved);
    const other = path.join(library, "别的.mp4");
    fs.writeFileSync(other, Buffer.concat([fs.readFileSync(moved), Buffer.from("not the same")]));
    expect(failure(await run(ctx, "library.repairSource", { resourceId: video.resourceId, pathHandle: ctx.app.registerPath("file", other) })).details).toMatchObject({ reason: "different-file" });
    const stray = path.join(scratch("video-out"), "第1集.mp4");
    fs.copyFileSync(moved, stray);
    expect(failure(await run(ctx, "library.repairSource", { resourceId: video.resourceId, pathHandle: ctx.app.registerPath("file", stray) })).details).toMatchObject({ reason: "outside-library", folder: path.dirname(stray) });
    expect(resolveLocation(ctx.app.store, video.revisionId)).toMatchObject({ relativePath: "第一集.mp4" });

    const fixed = ok<{ relinked: boolean; replaced: boolean; revisionId: string }>(await run(ctx, "library.repairSource", { resourceId: video.resourceId, pathHandle: ctx.app.registerPath("file", moved) }));
    expect(fixed).toMatchObject({ relinked: true, replaced: false, revisionId: video.revisionId });
    expect(resolveLocation(ctx.app.store, video.revisionId)).toMatchObject({ relativePath: "整理/第1集.mp4", available: true, outside: false });
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resource_revisions").get()).toEqual({ n: 1 });
  }, 120_000);

  it("refuses a comic from a folder no library path holds, and takes it once the folder is added", async () => {
    const ctx = await boot();
    const folder = scratch("comic-out");
    const file = path.join(folder, "第一卷.cbz");
    fs.copyFileSync(samplePath("cbz-basic"), file);
    expect(failure(await run(ctx, "library.importDocument", { title: "第一卷", kind: "comic", pathHandle: ctx.app.registerPath("file", file) })).details).toMatchObject({ reason: "outside-library", folder });
    expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get()).toEqual({ n: 0 });
    await addPath(ctx, folder, "comic");
    ok(await run(ctx, "library.importDocument", { title: "第一卷", kind: "comic", pathHandle: ctx.app.registerPath("file", file) }));
    expect(locationsOf(ctx)).toEqual([{ lib: expect.any(String), rel: "第一卷.cbz", legacy: null, hosted: 0, available: 1 }]);
    // Hosting is the other way in: a copy the application keeps, which needs no library path of the user's.
    const kept = ok<{ revisionId: string }>(await run(ctx, "library.importDocument", { title: "第二卷", kind: "comic", pathHandle: ctx.app.registerPath("file", inLibrary(ctx.app, samplePath("cbz-comicinfo"))), hosted: true }));
    expect(resolveLocation(ctx.app.store, kept.revisionId)).toMatchObject({ managed: true, outside: false });
  }, 120_000);
});

describe("insertLocation", () => {
  it("writes the pair and marks the application's own copies", async () => {
    const ctx = await boot();
    const root = scratch();
    const id = await addPath(ctx, root);
    ctx.app.store.sqlite.prepare("INSERT INTO works(id,title,created_at) VALUES ('w','w','2026-10-01')").run();
    ctx.app.store.sqlite.prepare("INSERT INTO resources(id, work_id, kind, title, aliases_json, created_at) VALUES ('r','w','novel','r','[]','2026-10-01')").run();
    ctx.app.store.sqlite.prepare("INSERT INTO resource_revisions(id, resource_id, fingerprint, parser_version, payload_json, created_at) VALUES ('v','r','f','p','{}','2026-10-01')").run();
    const mutation = insertLocation({ revisionId: "v", placed: { libraryPathId: id, relativePath: "a/b.txt", managed: false }, fingerprint: "f" });
    ctx.app.store.sqlite.prepare(mutation.sql).run(...(mutation.params ?? []));
    expect(locationsOf(ctx)).toEqual([{ lib: id, rel: "a/b.txt", legacy: null, hosted: 0, available: 1 }]);
  });
});

describe("a library package and the library paths of the machine (AT-93)", () => {
  it("carries a location as a path inside its library path, restores it outside the library on another profile, and finds it again when its folder is added", async () => {
    const source = await boot();
    const root = scratch("pack-src");
    write(root, "戊系列/第1话.txt", chapter("戊一"));
    const pathId = await addPath(source, root);
    ok(await run(source, "library.scan.start", { pathId }));
    await source.app.scan.whenIdle();
    const kept = ok<{ resourceId: string }>(await run(source, "library.importDocument", { title: "应用保管的书", bytes: [...Buffer.from(chapter("保管"))], format: "txt", hosted: true }));
    const pack = scratch("pack");
    fs.rmSync(pack, { recursive: true, force: true });
    ok(await run(source, "library.exportPackage", { pathHandle: source.app.registerPath("export", pack) }));
    const manifest = JSON.parse(fs.readFileSync(path.join(pack, "manifest.json"), "utf8")) as { fileLocations: Array<{ relative_path: string; hosted: number }> };
    // No row of the package names a folder of this machine.
    expect(manifest.fileLocations.map((row) => row.relative_path).sort()).toEqual([expect.stringMatching(/^rev_.*\.bin$/), "戊系列/第1话.txt"].sort());
    expect(JSON.stringify(manifest.fileLocations)).not.toContain(root.replaceAll("\\", "\\\\"));

    const target = await boot();
    ok(await run(target, "library.importPackage", { pathHandle: target.app.registerPath("import", pack) }));
    const rows = locationsOf(target);
    expect(rows.find((row) => row.hosted === 0)).toEqual({ lib: null, rel: "第1话.txt", legacy: "戊系列/第1话.txt", hosted: 0, available: 0 });
    const hosted = rows.find((row) => row.hosted === 1)!;
    expect(hosted).toMatchObject({ available: 1, legacy: null });
    expect(hosted.lib).toBe((target.app.store.sqlite.prepare("SELECT id FROM library_paths WHERE managed = 1").get() as { id: string }).id);
    const keptTarget = ok<{ items: Array<{ id: string; title: string }> }>(await run(target, "works.list", {})).items.find((item) => item.title === "应用保管的书");
    expect(keptTarget).toBeTruthy();
    expect(kept.resourceId).toBeTruthy();

    // The same folder on the other machine: add it and scan, and the restored resource is a file in a library path again.
    const mirror = scratch("pack-mirror");
    write(mirror, "戊系列/第1话.txt", chapter("戊一"));
    const mirrorId = await addPath(target, mirror);
    ok(await run(target, "library.scan.start", { pathId: mirrorId }));
    await target.app.scan.whenIdle();
    expect(locationsOf(target).filter((row) => row.hosted === 0)).toEqual([{ lib: mirrorId, rel: "戊系列/第1话.txt", legacy: null, hosted: 0, available: 1 }]);
    expect(ctxCount(target)).toBe(2);
  }, 60_000);
});

const ctxCount = (ctx: App) => (ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources").get() as { n: number }).n;
