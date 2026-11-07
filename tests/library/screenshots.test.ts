import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { embedPngText, pngSize, readPngText } from "@manga/app-core";
import { startApp } from "../helpers/app.ts";
import { picture } from "../helpers/fake-bangumi.ts";
import { seedComic, seedVideo } from "../helpers/media-seed.ts";

type App = Awaited<ReturnType<typeof startApp>>;
let counter = 0;

async function run(ctx: App, commandId: string, input: Record<string, unknown>, as?: { grant: string; actor: { kind: "user" | "agent"; id: string } }) {
  counter += 1;
  return ctx.app.call(as?.actor ?? ctx.actor, { commandId, idempotencyKey: `shot-${counter}`, input }, as?.grant ?? ctx.grant.handle);
}
const ok = <T = Record<string, any>>(result: Awaited<ReturnType<typeof run>>): T => {
  expect(result.status, JSON.stringify(result)).toBe("ok");
  return result.value as T;
};

type Shot = { id: string; title: string; fileId: string; workId: string; resourceId: string; mediaKind: string; positionMs: number | null; frame: number | null; pageId: string | null; pageLabel: string | null; spread: boolean; region: Record<string, number> | null; width: number; height: number; format: string; subtitleText: string | null; meta: Record<string, any>; available: boolean };

const png = async (width: number, height: number, color: "red" | "blue" = "red") => (await picture(color, [width, height], "png")).toString("base64");

describe("screenshots are saved at the size of the source with what is known about them (AT-91)", () => {
  it("saves a video frame as it is, in the folder of its work, with the time, frame, subtitle and tracks", async () => {
    const ctx = await startApp();
    try {
      const video = seedVideo(ctx.app, { title: "样例 03", ordinal: { number: 3, type: "episode", label: "第 3 话" } });
      ctx.app.store.sqlite.prepare("UPDATE works SET title = ? WHERE id = ?").run("样例动画", video.workId);
      const result = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", {
        resourceId: video.resourceId,
        data: await png(1280, 720),
        video: { positionMs: 754_321, frame: 18_104, playbackRate: 1.25, audioTrack: "日语 · AAC", subtitleTrack: "简体中文", subtitleText: "你好，世界。", composited: "none" },
      })).screenshot;
      expect(result).toMatchObject({ mediaKind: "video", positionMs: 754_321, frame: 18_104, width: 1280, height: 720, format: "png", subtitleText: "你好，世界。", available: true, workId: video.workId, resourceId: video.resourceId });
      expect(result.title).toBe("样例 03 · 12:34");
      expect(result.meta).toMatchObject({ work: "样例动画", timestamp: "00:12:34.321", playbackRate: 1.25, audioTrack: "日语 · AAC", subtitleTrack: "简体中文", composited: "none" });

      // The work is not linked to an online entry, so the file is in the 截图 folder of the file's own folder under 未分类 (A-88); it is the picture that was handed over, not a scaled copy.
      const file = ctx.app.screenshots.pathOf(result.id);
      expect(path.relative(ctx.app.store.worksDir, file).split(path.sep).slice(0, 3)).toEqual(["未分类", "样例 03", "截图"]);
      expect(path.basename(file)).toBe("样例动画 第 3 话 00-12-34.321.png");
      const bytes = fs.readFileSync(file);
      expect(pngSize(bytes)).toEqual({ width: 1280, height: 720 });
      expect(await sharp(bytes).metadata()).toMatchObject({ width: 1280, height: 720, format: "png" });
      expect(ctx.app.workFolders.files(video.workId)).toEqual([expect.objectContaining({ kind: "screenshot", resourceId: video.resourceId, refKind: "screenshot", refId: result.id, subDir: "截图" })]);

      // The picture says where it is from, so it still does when it travels alone.
      const embedded = JSON.parse(readPngText(bytes)["manga.screenshot"]!) as Record<string, any>;
      expect(embedded).toMatchObject({ id: result.id, work: "样例动画", resourceId: video.resourceId, positionMs: 754_321, frame: 18_104, subtitle: "你好，世界。", audioTrack: "日语 · AAC", width: 1280, height: 720 });
      expect(ctx.app.screenshots.readEmbedded(result.id)).toEqual(embedded);
      // Pixels are untouched by the extra text.
      const original = Buffer.from(await png(1280, 720), "base64");
      expect((await sharp(original).raw().toBuffer()).equals(await sharp(bytes).raw().toBuffer())).toBe(true);
    } finally { ctx.app.close(); }
  });

  it("keeps the main and the secondary subtitle text and what was drawn into the picture, in the record and in the file (AT-109)", async () => {
    const ctx = await startApp();
    try {
      const video = seedVideo(ctx.app, { title: "样例 04", ordinal: { number: 4, type: "episode", label: "第 4 话" } });
      const drawn = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", {
        resourceId: video.resourceId,
        data: await png(64, 36),
        video: { positionMs: 5000, subtitleTrack: "chi", subtitleText: "你好\n再见", subtitleSecondaryTrack: "eng", subtitleSecondaryText: "Hello\nBye", composited: "subtitles" },
      })).screenshot;
      expect(drawn).toMatchObject({ subtitleText: "你好\n再见" });
      expect(drawn.meta).toMatchObject({ subtitleTrack: "chi", subtitleSecondaryTrack: "eng", subtitleSecondaryText: "Hello\nBye", composited: "subtitles" });
      const embedded = JSON.parse(readPngText(fs.readFileSync(ctx.app.screenshots.pathOf(drawn.id)))["manga.screenshot"]!) as Record<string, any>;
      expect(embedded).toMatchObject({ subtitle: "你好\n再见", subtitleSecondaryText: "Hello\nBye", subtitleSecondaryTrack: "eng", composited: "subtitles" });

      // The text is kept when it was not drawn, and the record says it was not.
      const notDrawn = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", {
        resourceId: video.resourceId,
        data: await png(64, 36),
        video: { positionMs: 5000, subtitleText: "你好", composited: "none" },
      })).screenshot;
      expect(notDrawn.subtitleText).toBe("你好");
      expect(notDrawn.meta).toMatchObject({ composited: "none", subtitleSecondaryText: null, subtitleSecondaryTrack: null });

      // All four values of what was drawn are accepted; anything else is not.
      for (const composited of ["none", "subtitles", "danmaku", "both"]) {
        ok(await run(ctx, "screenshot.save", { resourceId: video.resourceId, data: await png(64, 36), video: { positionMs: 6000, composited } }));
      }
      const refused = await run(ctx, "screenshot.save", { resourceId: video.resourceId, data: await png(64, 36), video: { positionMs: 6000, composited: "everything" } });
      expect(refused.status).toBe("error");
    } finally { ctx.app.close(); }
  });

  it("keeps a native size that is not a common one, and refuses what is not a PNG, is empty, or does not fit the resource", async () => {
    const ctx = await startApp();
    try {
      const video = seedVideo(ctx.app, { title: "样例 01" });
      const comic = seedComic(ctx.app, { title: "样例漫画 01" });
      const odd = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", { resourceId: video.resourceId, data: await png(853, 480), video: { positionMs: 0 } })).screenshot;
      expect([odd.width, odd.height]).toEqual([853, 480]);
      const jpeg = (await picture("red", [64, 64], "jpeg")).toString("base64");
      for (const data of [jpeg, Buffer.from("not a picture").toString("base64"), Buffer.alloc(0).toString("base64") || "AA=="]) {
        const refused = await run(ctx, "screenshot.save", { resourceId: video.resourceId, data, video: { positionMs: 10 } });
        expect(refused.status).toBe("error");
      }
      // A video needs a time, a comic needs a page; the other kind of position is wrong.
      expect((await run(ctx, "screenshot.save", { resourceId: video.resourceId, data: await png(10, 10), comic: { pageId: "p001.png" } })).error?.code).toBe("VALIDATION_ERROR");
      expect((await run(ctx, "screenshot.save", { resourceId: comic.resourceId, data: await png(10, 10), video: { positionMs: 1 } })).error?.code).toBe("VALIDATION_ERROR");
      expect((await run(ctx, "screenshot.save", { resourceId: "res-none", data: await png(10, 10), video: { positionMs: 1 } })).error?.code).toBe("NOT_FOUND");
      expect(ctx.app.screenshots.list().total).toBe(1);
      expect(ctx.app.workFolders.files(video.workId)).toHaveLength(1);
    } finally { ctx.app.close(); }
  });

  it("saves a comic page, a spread and a region at the page's own size, with the page, direction and region", async () => {
    const ctx = await startApp();
    try {
      const comic = seedComic(ctx.app, { title: "样例漫画 02", ordinal: { number: 2, type: "volume", label: "第 2 卷" }, pageCount: 8 });
      const page = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", { resourceId: comic.resourceId, data: await png(1200, 1800), comic: { pageId: comic.pageIds[2], pageLabel: "第 3 页", pageIndex: 2, direction: "rtl" } })).screenshot;
      expect(page).toMatchObject({ mediaKind: "comic", pageId: comic.pageIds[2], pageLabel: "第 3 页", spread: false, region: null, width: 1200, height: 1800, positionMs: null });
      expect(page.title).toBe("样例漫画 02 · 第 3 页");
      const spread = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", { resourceId: comic.resourceId, data: await png(2400, 1800), comic: { pageId: comic.pageIds[3], pageLabel: "第 4—5 页", pageIndex: 3, spreadPageIds: [comic.pageIds[3], comic.pageIds[4]], direction: "rtl" } })).screenshot;
      expect(spread).toMatchObject({ spread: true, width: 2400, height: 1800 });
      expect(spread.meta).toMatchObject({ spreadPageIds: [comic.pageIds[3], comic.pageIds[4]], direction: "rtl", pageIndex: 3 });
      const region = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", { resourceId: comic.resourceId, data: await png(360, 450, "blue"), comic: { pageId: comic.pageIds[2], pageLabel: "第 3 页", pageIndex: 2, region: { x: 0.25, y: 0.1, width: 0.3, height: 0.25 } } })).screenshot;
      expect(region.region).toEqual({ x: 0.25, y: 0.1, width: 0.3, height: 0.25 });
      expect(region.title).toBe("样例漫画 02 · 第 3 页 · 区域");
      const names = fs.readdirSync(path.dirname(ctx.app.screenshots.pathOf(page.id))).sort();
      expect(names).toHaveLength(3);
      expect(names.some((name) => name.includes("区域"))).toBe(true);
      expect(names.some((name) => name.includes("跨页"))).toBe(true);
      const embedded = ctx.app.screenshots.readEmbedded(region.id) as Record<string, any>;
      expect(embedded).toMatchObject({ pageId: comic.pageIds[2], region: { x: 0.25, width: 0.3 } });
    } finally { ctx.app.close(); }
  });

  it("lists, reads, shows and removes a screenshot, and says so when its file was deleted from the folder", async () => {
    const ctx = await startApp();
    try {
      const video = seedVideo(ctx.app, { title: "样例 04" });
      const first = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", { resourceId: video.resourceId, data: await png(320, 180), video: { positionMs: 1000 } })).screenshot;
      const second = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", { resourceId: video.resourceId, data: await png(320, 180), video: { positionMs: 2000 } })).screenshot;
      const listed = ok<{ items: Shot[]; total: number }>(await run(ctx, "screenshot.list", { resourceId: video.resourceId }));
      expect(listed.total).toBe(2);
      expect(listed.items.map((item) => item.id)).toEqual([second.id, first.id]);
      expect(ok<{ screenshot: Shot }>(await run(ctx, "screenshot.get", { screenshotId: first.id })).screenshot.positionMs).toBe(1000);
      const image = ok<{ url: string; mediaType: string }>(await run(ctx, "screenshot.image", { screenshotId: first.id }));
      expect(image.mediaType).toBe("image/png");
      expect(image.url).toMatch(/^manga-media:/);
      // The folder can be opened from the screenshot.
      expect(ok<{ path: string }>(await run(ctx, "inventory.reveal", { id: `screenshot:${first.id}` })).path).toBe(path.dirname(ctx.app.screenshots.pathOf(first.id)));
      // Deleted outside the application: the record stays and says the file is gone.
      fs.rmSync(ctx.app.screenshots.pathOf(first.id));
      expect(ok<{ screenshot: Shot }>(await run(ctx, "screenshot.get", { screenshotId: first.id })).screenshot.available).toBe(false);
      expect((await run(ctx, "screenshot.image", { screenshotId: first.id })).error?.code).toBe("NOT_FOUND");
      // Removing one removes the record and, unless asked to keep it, the file.
      const keep = ctx.app.screenshots.pathOf(second.id);
      expect(ok<{ deleted: boolean }>(await run(ctx, "screenshot.delete", { screenshotId: second.id, deleteFile: false })).deleted).toBe(true);
      expect(fs.existsSync(keep)).toBe(true);
      expect(ctx.app.screenshots.get(second.id)).toBeNull();
      expect(ctx.app.workFolders.files(video.workId).map((file) => file.refId)).toEqual([first.id]);
    } finally { ctx.app.close(); }
  });
});

describe("a screenshot is an object that boards, maps and projects point at (AT-91)", () => {
  it("is referenced from a project, a map and a board, names its source, and opens it at the moment or page", async () => {
    const ctx = await startApp();
    try {
      const video = seedVideo(ctx.app, { title: "样例 05", ordinal: { number: 5, type: "episode", label: "第 5 话" } });
      const comic = seedComic(ctx.app, { title: "样例漫画 03", ordinal: { number: 3, type: "volume", label: "第 3 卷" } });
      const clip = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", { resourceId: video.resourceId, data: await png(160, 90), video: { positionMs: 61_500 } })).screenshot;
      const page = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", { resourceId: comic.resourceId, data: await png(90, 160), comic: { pageId: comic.pageIds[1], pageIndex: 1 } })).screenshot;
      const projectId = ok<{ id: string }>(await run(ctx, "project.create", { name: "截图项目" })).id;
      for (const shot of [clip, page]) ok(await run(ctx, "project.addMaterial", { projectId, kind: "screenshot", targetId: shot.id }));
      const materials = ok<{ materials: Array<{ kind: string; targetId: string; label: string; state: string; opens?: Record<string, any> }> }>(await run(ctx, "project.get", { projectId })).materials;
      expect(materials.map((item) => [item.kind, item.label, item.state])).toEqual(expect.arrayContaining([["screenshot", "样例 05 · 01:01", "ok"], ["screenshot", "样例漫画 03 · P2", "ok"]]));
      expect(materials.find((item) => item.targetId === clip.id)!.opens).toMatchObject({ resourceId: video.resourceId, mediaKind: "video", position: { kind: "temporal", startMs: 61_500 } });
      expect(materials.find((item) => item.targetId === page.id)!.opens).toMatchObject({ resourceId: comic.resourceId, mediaKind: "comic", position: { kind: "image", pageId: comic.pageIds[1] } });

      const mapId = ok<{ map: { id: string } }>(await run(ctx, "mindmap.create", { projectId, title: "导图", rootText: "根" })).map.id;
      const root = ok<{ nodes: Array<{ id: string }> }>(await run(ctx, "mindmap.get", { mapId })).nodes[0]!.id;
      ok(await run(ctx, "mindmap.edit", { mapId, actions: [{ type: "addRef", nodeId: root, kind: "screenshot", targetId: clip.id }] }));
      const ref = ok<{ nodes: Array<{ refs: Array<{ kind: string; label: string; state: string; opens?: Record<string, any> }> }> }>(await run(ctx, "mindmap.get", { mapId })).nodes[0]!.refs[0]!;
      expect(ref).toMatchObject({ kind: "screenshot", state: "ok", label: "样例 05 · 01:01" });
      expect(ref.opens).toMatchObject({ resourceId: video.resourceId, position: { kind: "temporal", startMs: 61_500 } });

      const boardId = ok<{ board: { id: string } }>(await run(ctx, "whiteboard.create", { projectId, title: "白板" })).board.id;
      ok(await run(ctx, "whiteboard.edit", { boardId, actions: [{ type: "addNode", id: "wb-shot", kind: "ref", x: 0, y: 0, data: { refKind: "screenshot", targetId: page.id } }] }));
      const board = ok<{ refs: Record<string, { state: string; label: string }> }>(await run(ctx, "whiteboard.get", { boardId }));
      expect(board.refs["wb-shot"]).toMatchObject({ state: "ok", label: "样例漫画 03 · P2" });

      // Once the screenshot is deleted the references say so instead of breaking.
      ok(await run(ctx, "screenshot.delete", { screenshotId: clip.id }));
      expect(ok<{ nodes: Array<{ refs: Array<{ state: string }> }> }>(await run(ctx, "mindmap.get", { mapId })).nodes[0]!.refs[0]!.state).toBe("missing");
    } finally { ctx.app.close(); }
  });
});

describe("a task reads what a screenshot says, within its scope and the spoiler guard (AT-91)", () => {
  it("lists only authorized resources, withholds moments not reached, and shows no file or path", async () => {
    const ctx = await startApp();
    try {
      const video = seedVideo(ctx.app, { title: "样例 06" });
      const other = seedVideo(ctx.app, { title: "样例 07" });
      const comic = seedComic(ctx.app, { title: "样例漫画 04", pageCount: 6 });
      const early = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", { resourceId: video.resourceId, data: await png(64, 36), video: { positionMs: 4000, subtitleText: "已经看到的台词" } })).screenshot;
      const late = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", { resourceId: video.resourceId, data: await png(64, 36), video: { positionMs: 20_000, subtitleText: "还没看到的台词" } })).screenshot;
      const read = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", { resourceId: comic.resourceId, data: await png(40, 60), comic: { pageId: comic.pageIds[1], pageIndex: 1 } })).screenshot;
      const ahead = ok<{ screenshot: Shot }>(await run(ctx, "screenshot.save", { resourceId: comic.resourceId, data: await png(40, 60), comic: { pageId: comic.pageIds[5], pageIndex: 5 } })).screenshot;
      ok(await run(ctx, "screenshot.save", { resourceId: other.resourceId, data: await png(64, 36), video: { positionMs: 1000 } }));
      ok(await run(ctx, "progress.setTime", { contextId: null, resourceId: video.resourceId, resourceRevisionId: video.revisionId, timeMs: 8000, played: [{ startMs: 0, endMs: 8000 }] }));
      ok(await run(ctx, "progress.setPage", { contextId: null, resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[2], consumed: true }));
      ok(await run(ctx, "progress.setPage", { contextId: null, resourceId: comic.resourceId, resourceRevisionId: comic.revisionId, pageId: comic.pageIds[1], consumed: true }));
      ok(await run(ctx, "settings.setShell", { spoilerGuard: true }));

      const agent = { kind: "agent" as const, id: "agent-shots" };
      const grant = ctx.app.issueAgentGrant(ctx.grant, agent, { sessionId: "s-1", runId: "r-1", readResourceIds: [video.resourceId, comic.resourceId] });
      const as = { grant: grant.handle, actor: agent };
      const listed = ok<{ items: Array<Record<string, any>>; withheld: number }>(await run(ctx, "screenshot.list", { resourceId: video.resourceId }, as));
      expect(listed.items.map((item) => item.id)).toEqual([early.id]);
      expect(listed.withheld).toBe(1);
      expect(listed.items[0]).toMatchObject({ positionMs: 4000, subtitleText: "已经看到的台词" });
      // A task never receives the file, its handle, or where it is on this machine.
      expect(JSON.stringify(listed)).not.toMatch(/fileId|manga-media|works|截图|\.png/);
      const seen = ok<{ screenshot: Record<string, any> }>(await run(ctx, "screenshot.get", { screenshotId: early.id }, as));
      expect(seen.screenshot.subtitleText).toBe("已经看到的台词");
      const hidden = await run(ctx, "screenshot.get", { screenshotId: late.id }, as);
      expect(hidden.error?.code).toBe("SCOPE_DENIED");
      expect(hidden.error?.details).toMatchObject({ reason: "spoiler-guard" });
      // Comics: a page that was read is told about, one ahead of the reader is not.
      const pages = ok<{ items: Array<Record<string, any>> }>(await run(ctx, "screenshot.list", { resourceId: comic.resourceId }, as));
      expect(pages.items.map((item) => item.id)).toEqual([read.id]);
      expect((await run(ctx, "screenshot.get", { screenshotId: ahead.id }, as)).error?.details).toMatchObject({ reason: "spoiler-guard" });

      // Outside the authorized set, and without naming a resource, a task gets nothing.
      expect((await run(ctx, "screenshot.list", { resourceId: other.resourceId }, as)).error?.code).toBe("SCOPE_DENIED");
      expect((await run(ctx, "screenshot.list", {}, as)).error?.code).toBe("VALIDATION_ERROR");
      // Making, showing and removing screenshots is the person's own action.
      for (const commandId of ["screenshot.save", "screenshot.image", "screenshot.delete"]) {
        const refused = await run(ctx, commandId, { screenshotId: early.id, resourceId: video.resourceId, data: "AA==", video: { positionMs: 1 } }, as);
        expect(refused.status, commandId).toBe("error");
        expect(["FORBIDDEN", "VALIDATION_ERROR"]).toContain(refused.error?.code);
      }
      // With the guard off the position alone is not a limit; the grant is.
      ok(await run(ctx, "settings.setShell", { spoilerGuard: false }));
      expect(ok<{ items: unknown[] }>(await run(ctx, "screenshot.list", { resourceId: video.resourceId }, as)).items).toHaveLength(2);
    } finally { ctx.app.close(); }
  });
});

describe("the text inside a PNG", () => {
  it("is written as iTXt with a valid checksum, ignored when the checksum is wrong, and never breaks the picture", async () => {
    const base = Buffer.from(await png(32, 32), "base64");
    const marked = embedPngText(base, "manga.screenshot", JSON.stringify({ 标题: "取自第 3 话", n: 1 }));
    expect(JSON.parse(readPngText(marked)["manga.screenshot"]!)).toEqual({ 标题: "取自第 3 话", n: 1 });
    expect(await sharp(marked).metadata()).toMatchObject({ width: 32, height: 32 });
    // A flipped byte in the text makes the chunk's checksum fail, and the reader leaves it out.
    const broken = Buffer.from(marked);
    const at = broken.indexOf(Buffer.from("取自"));
    broken[at + 1] = broken[at + 1]! ^ 0xff;
    expect(readPngText(broken)["manga.screenshot"]).toBeUndefined();
    expect(() => pngSize(Buffer.from("GIF89a"))).toThrow();
    expect(() => embedPngText(base.subarray(0, base.length - 5), "k", "v")).toThrow();
  });
});
