import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planDirectory, planDirectoryAsync } from "../../packages/app-core/src/comic/scan.ts";
import { startApp } from "../helpers/app.ts";

let counter = 0;
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "manga-async-"));
const touch = (root: string, relative: string, bytes: string | Buffer = "x") => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
};

/** A small tree with each kind of thing the plans look for. */
function synthetic(root: string) {
  for (const name of ["01.png", "02.png", "03.png"]) touch(root, `第1话/${name}`);
  touch(root, "第2话/01.png");
  touch(root, "卷3.cbz", "PK");
  touch(root, "书.epub", "PK");
  touch(root, "文章.txt", "文字");
  touch(root, "视频/ep01.mkv");
  touch(root, "视频/ep02.mp4");
  touch(root, "视频/readme.nfo");
  touch(root, ".hidden/01.png");
  touch(root, "Thumbs.db");
}

describe("reading a folder without holding the main thread", () => {
  it("plans exactly what the synchronous plan does, for every kind, in one walk", async () => {
    const root = temp();
    try {
      synthetic(root);
      const walked = await planDirectoryAsync(root, ["comic", "video", "novel"]);
      for (const kind of ["comic", "video", "novel"] as const) expect(walked[kind], kind).toEqual(planDirectory(root, kind));
      expect(walked.video.items.map((item) => item.relative)).toEqual(["视频/ep01.mkv", "视频/ep02.mp4"]);
      expect(walked.comic.items.map((item) => [item.relative, item.type, item.imageCount ?? null])).toEqual(expect.arrayContaining([["第1话", "image-dir", 3], ["第2话", "image-dir", 1], ["卷3.cbz", "archive", null]]));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("applies the depth and item limits per kind, and stops when asked", async () => {
    const root = temp();
    try {
      for (let i = 0; i < 30; i += 1) touch(root, `a/b/c/${String(i).padStart(2, "0")}.txt`);
      for (let i = 0; i < 5; i += 1) touch(root, `top${i}.mkv`);
      const limits = { maxItems: 10, maxDepth: 2 };
      const walked = await planDirectoryAsync(root, ["novel", "video"], { limits });
      expect(walked.novel).toEqual(planDirectory(root, "novel", limits));
      expect(walked.video).toEqual(planDirectory(root, "video", limits));
      // The deep files are past the depth limit; the videos are all there.
      expect(walked.novel.items).toHaveLength(0);
      expect(walked.video.items).toHaveLength(5);
      const shallow = await planDirectoryAsync(root, ["novel"], { limits: { maxItems: 10, maxDepth: 8 } });
      expect(shallow.novel.truncated).toBe(true);
      expect(shallow.novel.items).toHaveLength(10);

      const controller = new AbortController();
      controller.abort();
      await expect(planDirectoryAsync(root, ["novel"], { signal: controller.signal })).rejects.toThrow();
      // A folder that cannot be read is skipped, as in the synchronous plan.
      expect(await planDirectoryAsync(path.join(root, "missing"), ["novel"])).toEqual({ novel: { items: [], truncated: false } });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("lets the event loop run while a large folder is checked, and says how far it has got", async () => {
    const root = temp();
    const ctx = await startApp();
    try {
      for (let folder = 0; folder < 400; folder += 1) for (let file = 0; file < 4; file += 1) touch(root, `系列/${String(folder).padStart(3, "0")}/${file}.png`);
      const notices: Array<Record<string, unknown>> = [];
      const off = ctx.app.onNotice((notice) => { if (notice.topic === "inspect.progress") notices.push(notice.payload); });
      let ticks = 0;
      const timer = setInterval(() => { ticks += 1; }, 1);
      counter += 1;
      const handle = ctx.app.registerPath("directory", root);
      const result = await ctx.app.call(ctx.actor, { commandId: "library.inspectFile", idempotencyKey: `inspect-${counter}`, input: { pathHandle: handle } }, ctx.grant.handle);
      clearInterval(timer);
      off();
      expect(result.status, JSON.stringify(result)).toBe("ok");
      expect(result.value).toMatchObject({ entry: "directory", suggestion: { kind: "comic" }, counts: { comic: 400, video: 0, novel: 0 } });
      // A synchronous walk of 400 folders would have left no turn for the timer; the asynchronous one lets it run many times.
      expect(ticks).toBeGreaterThan(5);
      expect(notices[0]).toMatchObject({ stage: "start" });
      expect(notices.at(-1)).toMatchObject({ stage: "done" });
      expect(new Set(notices.map((notice) => notice.requestId)).size).toBe(1);
    } finally { ctx.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it("imports a folder of text files and a hosted archive without a synchronous read, with the same result", async () => {
    const root = temp();
    const ctx = await startApp();
    try {
      for (let i = 1; i <= 3; i += 1) touch(root, `书/第${i}卷.txt`, `第${i}卷\n${"正文".repeat(50)}`);
      counter += 1;
      const imported = await ctx.app.call(ctx.actor, { commandId: "works.importDirectory", idempotencyKey: `dir-${counter}`, input: { pathHandle: ctx.app.registerPath("directory", path.join(root, "书")), kind: "novel" } }, ctx.grant.handle);
      expect(imported.status, JSON.stringify(imported)).toBe("ok");
      const value = imported.value as { workId: string; resources: Array<{ relative: string; error?: unknown }>; truncated: boolean };
      expect(value.resources.map((item) => item.relative)).toEqual(["第1卷.txt", "第2卷.txt", "第3卷.txt"]);
      expect(value.resources.every((item) => !item.error)).toBe(true);
      expect(ctx.app.store.sqlite.prepare("SELECT COUNT(*) AS n FROM resources WHERE work_id = ?").get(value.workId)).toEqual({ n: 3 });

      counter += 1;
      const single = await ctx.app.call(ctx.actor, { commandId: "library.importDocument", idempotencyKey: `single-${counter}`, input: { title: "单个文本", pathHandle: ctx.app.registerPath("file", path.join(root, "书", "第1卷.txt")) } }, ctx.grant.handle);
      expect(single.status, JSON.stringify(single)).toBe("ok");
      counter += 1;
      const missing = await ctx.app.call(ctx.actor, { commandId: "library.importDocument", idempotencyKey: `missing-${counter}`, input: { title: "不存在", pathHandle: ctx.app.registerPath("file", path.join(root, "不存在.txt")) } }, ctx.grant.handle);
      expect(missing.error?.code).toBe("NOT_FOUND");
    } finally { ctx.app.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
