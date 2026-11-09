import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildZip } from "../../packages/app-core/src/index.ts";
import {
  LIGHT_COMMANDS,
  LIGHT_COPY_BUDGET_BYTES,
  LIGHT_POSITIONS_LIMIT,
  LightMediaService,
  LightPositions,
  lightFileKey,
  lightKindOf,
  videoFinished,
} from "@manga/app-core/light";
import { startApp } from "../helpers/app.ts";
import { seedVideo } from "../helpers/media-seed.ts";
import { inLibrary, requireSamples, samplePath } from "../helpers/samples.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";
import { DEFAULT_LIGHT_BOUNDS, fileArgument, placeWindow, readWindowState, writeWindowState } from "../../apps/desktop/src/main/light/window-state.ts";

/**
 * Light open's media service (READ-05, A-128, 4.3): it answers the full app's commands under the same names and in the same shapes, refuses every
 * other command, reads nothing outside the file it opened, and stops serving a file that changed. Positions are kept by a hash, never a path.
 */
const dirs: string[] = [];
const services: LightMediaService[] = [];
afterEach(() => {
  while (services.length) services.pop()!.dispose();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
const scratch = (prefix = "light") => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), `manga-${prefix}-`)); dirs.push(dir); return dir; };
const light = (options: Partial<ConstructorParameters<typeof LightMediaService>[0]> = {}) => {
  const service = new LightMediaService({ cacheDir: path.join(scratch("light-cache"), "cache"), ...options });
  services.push(service);
  return service;
};
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");

/** The shape of a value: object keys (recursively), the shape of an array's first item, the type of a primitive; null stays null. */
function shape(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length ? [shape(value[0])] : [];
  if (typeof value === "object") return Object.fromEntries(Object.keys(value as object).sort().map((key) => [key, shape((value as Record<string, unknown>)[key])]));
  return typeof value;
}
/** Where both sides have a value, the shapes agree; a side that has null where the other has something is a value difference, not a shape one. */
function sameShape(a: unknown, b: unknown, at = "$"): string[] {
  if (a === null || b === null) return [];
  if (Array.isArray(a) && Array.isArray(b)) return a.length && b.length ? sameShape(a[0], b[0], `${at}[0]`) : [];
  if (typeof a === "object" && typeof b === "object") {
    const ka = Object.keys(a as object).sort();
    const kb = Object.keys(b as object).sort();
    const problems = ka.join() === kb.join() ? [] : [`${at}: ${ka.join(",")} != ${kb.join(",")}`];
    for (const key of ka.filter((k) => kb.includes(k))) problems.push(...sameShape((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${at}.${key}`));
    return problems;
  }
  return a === b || typeof a === typeof b ? [] : [`${at}: ${typeof a} != ${typeof b}`];
}

describe("light open answers the full app's commands in the same shapes (AT-167, AT-168, 4.3)", () => {
  it.skipIf(mediaPrerequisitesAbsent)("comic.pages and comic.pageHandles of a CBZ, and the video commands of an MP4", async () => {
    requireSamples(["cbz-basic", "video-mp4-h264-aac"]);
    const ctx = await startApp();
    try {
      let counter = 0;
      const run = async (commandId: string, input: Record<string, unknown>) => {
        const result = await ctx.app.call(ctx.actor, { commandId, idempotencyKey: `light-shape-${counter++}`, input }, ctx.grant.handle);
        expect(result.status, JSON.stringify(result)).toBe("ok");
        return result.value as Record<string, unknown>;
      };
      const imported = await run("library.importDocument", { title: "样本", kind: "comic", pathHandle: ctx.app.registerPath("file", inLibrary(ctx.app, samplePath("cbz-basic"))) }) as { resourceId: string; revisionId: string };
      const fullPages = await run("comic.pages", { resourceId: imported.resourceId });
      const fullIds = (fullPages.pages as Array<{ id: string }>).slice(0, 2).map((page) => page.id);
      const fullHandles = await run("comic.pageHandles", { resourceId: imported.resourceId, revisionId: fullPages.revisionId, pageIds: fullIds });

      const service = light();
      const comic = await service.open(samplePath("cbz-basic"));
      const lightPages = await service.call("comic.pages", { resourceId: comic.sessionId }) as Record<string, unknown>;
      const lightIds = (lightPages.pages as Array<{ id: string }>).slice(0, 2).map((page) => page.id);
      const lightHandles = await service.call("comic.pageHandles", { resourceId: comic.sessionId, revisionId: lightPages.revisionId, pageIds: lightIds });
      expect(sameShape(fullPages, lightPages)).toEqual([]);
      expect(sameShape(fullHandles, lightHandles)).toEqual([]);
      expect(lightIds).toEqual(fullIds);
      expect((lightPages.pages as unknown[]).length).toBe((fullPages.pages as unknown[]).length);

      const videoFile = path.join(scratch("light-video"), "第01话.mp4");
      fs.copyFileSync(samplePath("video-mp4-h264-aac"), videoFile);
      const video = seedVideo(ctx.app, { title: "视频", file: videoFile, probe: true });
      const opened = await service.open(videoFile);
      for (const [commandId, input] of [
        ["video.playbackPlan", { hardwareHevc: false }],
        ["video.subtitles", {}],
        ["video.handle", { source: "original" }],
        ["video.playCopy", { action: "status" }],
      ] as const) {
        const full = await run(commandId, { resourceId: video.resourceId, revisionId: video.revisionId, ...input });
        const mine = await service.call(commandId, { resourceId: opened.sessionId, revisionId: opened.revisionId, ...input });
        expect(sameShape(full, mine), commandId).toEqual([]);
      }
      expect(shape(await service.call("video.playCopy", { resourceId: opened.sessionId, action: "status" }))).toMatchObject({ budgetBytes: "number" });
      expect((await service.call("video.playCopy", { resourceId: opened.sessionId, action: "status" }) as { budgetBytes: number }).budgetBytes).toBe(LIGHT_COPY_BUDGET_BYTES);
    } finally {
      ctx.app.close();
    }
  });
});

describe("light open's boundaries (AT-167, AT-168, AT-170, 4.3, 4.6)", () => {
  it("refuses every command it does not list, and any session it did not open", async () => {
    const service = light({ tools: null });
    expect(LIGHT_COMMANDS).not.toContain("library.read");
    for (const commandId of ["library.read", "notes.create", "agent.run", "settings.get", "plugin.install", "update.check"]) {
      await expect(service.call(commandId, { resourceId: "ls_x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(service.call("comic.pages", { resourceId: "res_from_the_library" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("takes only its types, says when a file is gone, and never serves an entry that climbs out of its archive", async () => {
    const root = scratch("light-kinds");
    const notes = path.join(root, "notes.txt");
    fs.writeFileSync(notes, "plain text");
    const service = light({ tools: null });
    expect(lightKindOf(notes)).toBeNull();
    await expect(service.open(notes)).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
    await expect(service.open(path.join(root, "gone.cbz"))).rejects.toMatchObject({ code: "NOT_FOUND" });

    // "aa/evil.png" becomes "../evil.png" in both headers: a name that climbs out of the archive.
    const zipped = Buffer.from(buildZip([{ name: "001.png", data: PNG }, { name: "aa/evil.png", data: PNG }, { name: "002.png", data: PNG }]));
    const bytes = Buffer.from(zipped.toString("latin1").replaceAll("aa/evil.png", "../evil.png"), "latin1");
    const archive = path.join(root, "第1卷.cbz");
    fs.writeFileSync(archive, bytes);
    const comic = await service.open(archive);
    const pages = await service.call("comic.pages", { resourceId: comic.sessionId }) as { pages: Array<{ id: string }>; warnings?: string[] };
    expect(pages.pages.map((page) => page.id)).toEqual(["001.png", "002.png"]);
    const asked = await service.call("comic.pageHandles", { resourceId: comic.sessionId, pageIds: ["../evil.png", "001.png"] }) as { pages: Array<{ pageId: string; available: boolean }> };
    expect(asked.pages.find((page) => page.pageId === "../evil.png")?.available ?? false).toBe(false);
    expect(asked.pages.find((page) => page.pageId === "001.png")?.available).toBe(true);
  });

  it("opens an image as its folder from that image, in natural order, and a folder of images as a comic", async () => {
    const folder = path.join(scratch("light-folder"), "dir-natural");
    fs.mkdirSync(folder);
    for (const name of ["10.png", "2.png", "1.png", "readme.txt"]) fs.writeFileSync(path.join(folder, name), name.endsWith(".png") ? PNG : "text");
    const service = light({ tools: null });
    const fromImage = await service.open(path.join(folder, "2.png"));
    expect(fromImage).toMatchObject({ kind: "comic", startPageId: "2.png", pageCount: 3 });
    const pages = await service.call("comic.pages", { resourceId: fromImage.sessionId }) as { pages: Array<{ id: string }> };
    expect(pages.pages.map((page) => page.id)).toEqual(["1.png", "2.png", "10.png"]);
    const asFolder = await service.open(folder);
    expect(asFolder).toMatchObject({ kind: "comic", startPageId: null });
    // A folder is remembered by its path alone, so adding a page does not lose the place.
    fs.writeFileSync(path.join(folder, "11.png"), PNG);
    expect((await service.open(folder)).key).toBe(asFolder.key);
  });

  it.skipIf(mediaPrerequisitesAbsent)("stops serving a video whose file changed after it was opened", async () => {
    requireSamples(["video-mp4-h264-aac"]);
    const file = path.join(scratch("light-changed"), "clip.mp4");
    fs.copyFileSync(samplePath("video-mp4-h264-aac"), file);
    const service = light();
    const opened = await service.open(file);
    expect(await service.call("video.handle", { resourceId: opened.sessionId })).toMatchObject({ source: "original" });
    fs.appendFileSync(file, Buffer.alloc(16));
    await expect(service.call("video.handle", { resourceId: opened.sessionId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.call("video.playCopy", { resourceId: opened.sessionId, action: "create" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A changed file is a new file: its key is not the old one.
    expect(lightFileKey(file)).not.toBe(opened.key);
  });

  it("writes nothing but its cache folder", async () => {
    const root = scratch("light-footprint");
    const folder = path.join(root, "files");
    fs.mkdirSync(folder);
    for (const name of ["1.png", "2.png"]) fs.writeFileSync(path.join(folder, name), PNG);
    const cacheDir = path.join(root, "light", "cache");
    const service = light({ tools: null, cacheDir });
    const opened = await service.open(path.join(folder, "1.png"));
    await service.call("comic.pageHandles", { resourceId: opened.sessionId, pageIds: ["1.png", "2.png"] });
    service.dispose();
    const list = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? list(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
    expect(list(root).filter((file) => !file.startsWith(cacheDir)).map((file) => path.relative(root, file)).sort()).toEqual([path.join("files", "1.png"), path.join("files", "2.png")]);
  });

  it.skipIf(mediaPrerequisitesAbsent)("evicts the least-recently-used play copy when light open's cache budget is exceeded (AT-167, 4.3)", async () => {
    requireSamples(["video-mp4-h264-aac"]);
    const dir = scratch("light-budget");
    const ep1 = path.join(dir, "ep1.mp4");
    const ep2 = path.join(dir, "ep2.mp4");
    fs.copyFileSync(samplePath("video-mp4-h264-aac"), ep1);
    fs.appendFileSync(ep1, Buffer.alloc(32));
    fs.copyFileSync(samplePath("video-mp4-h264-aac"), ep2);
    const cacheDir = path.join(dir, "cache");
    // Budget fits one play copy comfortably, not two: creating the second evicts the older one.
    const service = light({ cacheDir, copyBudgetBytes: 8 * 1024 * 1024 });
    const s1 = await service.open(ep1);
    const created1 = await service.call("video.playCopy", { resourceId: s1.sessionId, action: "create", reason: "playback_failed" }) as { copy: { id: string } };
    const waitCopy = async (svc: LightMediaService, sessionId: string) => {
      for (let i = 0; i < 300; i += 1) {
        const status = await svc.call("video.playCopy", { resourceId: sessionId, action: "status" }) as { copies: Array<{ state: string; bytes: number | null }> };
        if (status.copies[0]?.state === "ready") return status.copies[0];
        if (status.copies[0]?.state === "failed") throw new Error("play copy failed");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("play copy timed out");
    };
    const ready1 = await waitCopy(service, s1.sessionId);
    expect(ready1.bytes ?? 0).toBeGreaterThan(0);

    // Adjust budget to 1.5× the first copy's size so two copies cannot coexist.
    service.dispose();
    const tightBudget = Math.floor((ready1.bytes ?? 200_000) * 1.5);
    const capped = light({ cacheDir, copyBudgetBytes: tightBudget });
    const s1Again = await capped.open(ep1);
    expect((await capped.call("video.playCopy", { resourceId: s1Again.sessionId, action: "status" }) as { copies: Array<{ id: string }> }).copies.map((c) => c.id)).toContain(created1.copy.id);

    const s2 = await capped.open(ep2);
    await capped.call("video.playCopy", { resourceId: s2.sessionId, action: "create", reason: "playback_failed" });
    await waitCopy(capped, s2.sessionId);

    const after1 = await capped.call("video.playCopy", { resourceId: s1Again.sessionId, action: "status" }) as { copies: unknown[]; usedBytes: number };
    const after2 = await capped.call("video.playCopy", { resourceId: s2.sessionId, action: "status" }) as { copies: Array<{ state: string }> };
    expect(after1.copies).toHaveLength(0);
    expect(after2.copies[0]?.state).toBe("ready");
    expect(after1.usedBytes).toBeLessThanOrEqual(tightBudget);
  });
});

describe("light open's positions and windows (AT-167, AT-168, AT-170, 4.4, 6)", () => {
  it("keeps at most 500 positions by hash, never a name or a path, and starts a finished file from the beginning", () => {
    const file = path.join(scratch("light-positions"), "positions.json");
    const positions = new LightPositions(file, 3);
    const key = (n: number) => n.toString(16).padStart(64, "0");
    for (let n = 1; n <= 4; n += 1) positions.set(key(n), { kind: "video", positionMs: n * 1000, durationMs: 60_000, finished: false, at: new Date(2026, 10, n).toISOString() });
    expect(positions.size).toBe(3);
    expect(positions.get(key(1))).toBeNull();
    expect(positions.resume(key(4))).toEqual({ positionMs: 4000 });
    positions.set(key(4), { kind: "video", positionMs: 58_000, durationMs: 60_000, finished: videoFinished(58_000, 60_000, false), at: new Date().toISOString() });
    expect(positions.resume(key(4))).toBeNull();
    positions.set("/synthetic/folder/video.mp4", { kind: "video", positionMs: 1, durationMs: 2, finished: false, at: new Date().toISOString() });
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toMatch(/video\.mp4|synthetic/);
    expect(new LightPositions(file, 3).size).toBe(3);
    expect(LIGHT_POSITIONS_LIMIT).toBe(500);
    expect(videoFinished(1000, 60_000, true)).toBe(true);
  });

  it("AT-168 keeps a comic page by the hash of its id, never the page's name, and finds it again among the pages", () => {
    const file = path.join(scratch("light-positions-comic"), "positions.json");
    const key = "a".repeat(64);
    const pages = ["家族旅行/IMG_0001.jpg", "家族旅行/IMG_0002.jpg", "家族旅行/IMG_0003.jpg"];
    const positions = new LightPositions(file);
    positions.set(key, { kind: "comic", pageId: pages[1]!, pageIndex: 1, pageCount: 3, finished: false, at: new Date().toISOString(), extra: "家族旅行" } as never);
    const text = fs.readFileSync(file, "utf8");
    expect(text).not.toMatch(/IMG_|家族旅行|pageId|extra/);
    expect(positions.get(key)).toMatchObject({ kind: "comic", pageIndex: 1, pageCount: 3 });
    expect(positions.resume(key, pages)).toEqual({ pageId: pages[1] });
    // A page added in front of it: still found by its hash, not by its old place.
    expect(new LightPositions(file).resume(key, ["家族旅行/IMG_0000.jpg", ...pages])).toEqual({ pageId: pages[1] });
    // Without the pages there is nothing to go back to.
    expect(positions.resume(key)).toBeNull();
    // A file written before by page name is read, and written again without the name.
    fs.writeFileSync(file, JSON.stringify({ version: 1, positions: { [key]: { kind: "comic", pageId: pages[2], pageIndex: 2, pageCount: 3, finished: false, at: new Date().toISOString() } } }));
    expect(new LightPositions(file).resume(key, pages)).toEqual({ pageId: pages[2] });
    expect(fs.readFileSync(file, "utf8")).not.toMatch(/IMG_|家族旅行|pageId/);
  });

  it("opens 960×600 first, then where the last window was, one step down and right for each open window, and back on a screen", () => {
    const file = path.join(scratch("light-window"), "window.json");
    expect(readWindowState(file)).toBeNull();
    expect(DEFAULT_LIGHT_BOUNDS).toMatchObject({ width: 960, height: 600 });
    const screen = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    expect(placeWindow(DEFAULT_LIGHT_BOUNDS, screen, 0)).toEqual({ width: 960, height: 600 });
    writeWindowState(file, { x: 100, y: 80, width: 1000, height: 700, maximized: false });
    const saved = readWindowState(file)!;
    expect(placeWindow(saved, screen, 0)).toEqual({ x: 100, y: 80, width: 1000, height: 700 });
    expect(placeWindow(saved, screen, 2)).toEqual({ x: 156, y: 136, width: 1000, height: 700 });
    expect(placeWindow({ ...saved, x: 4000, y: 80 }, screen, 0)).toEqual({ x: 460, y: 190, width: 1000, height: 700 });
  });

  it("finds the file after --manga-light and skips Chromium's own switches", () => {
    const file = path.resolve("第01话.mp4");
    expect(fileArgument(["manga.exe", "--manga-light", file])).toBe(file);
    expect(fileArgument(["manga.exe", "--manga-light", "--allow-file-access-from-files", file, "--manga-smoke"])).toBe(file);
    expect(fileArgument(["manga.exe", "--manga-light"])).toBeNull();
    expect(fileArgument(["manga.exe", file])).toBeNull();
  });
});
