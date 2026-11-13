import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildZip } from "../../packages/app-core/src/index.ts";
import {
  FfmpegService,
  JobQueue,
  ThumbnailCache,
  ZipPool,
  locateFfmpeg,
  redactToolText,
  runTool,
} from "../../packages/app-core/src/media/index.ts";
import { mediaPrerequisitesAbsent } from "../helpers/prerequisites.ts";
import { samplePath } from "../helpers/samples.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "manga-media-reg-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("media regressions", () => {
  it("ZipPool maps missing archive to NOT_FOUND, supports shared-open single-caller abort, and cancels on close", async () => {
    const pool = new ZipPool();
    try {
      await expect(pool.index(path.join(root, "does-not-exist.cbz"))).rejects.toMatchObject({ code: "NOT_FOUND" });

      const zipFile = path.join(root, "sample.cbz");
      fs.writeFileSync(zipFile, buildZip([
        { name: "001.png", data: Buffer.from("hello-page-1") },
        { name: "002.png", data: Buffer.from("hello-page-2") },
      ]));

      const abortFirst = new AbortController();
      const first = pool.index(zipFile, abortFirst.signal);
      const second = pool.index(zipFile);
      abortFirst.abort();
      await expect(first).rejects.toMatchObject({ code: "CANCELLED" });
      const idx = await second;
      expect(idx.entries.map((entry) => entry.name)).toEqual(["001.png", "002.png"]);

      const preAborted = new AbortController();
      preAborted.abort();
      await expect(pool.read(zipFile, "001.png", { signal: preAborted.signal })).rejects.toMatchObject({ code: "CANCELLED" });
    } finally {
      pool.close();
    }
    await expect(pool.index(path.join(root, "sample.cbz"))).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("ThumbnailCache deduplicates concurrent ensure() calls and ignores .tmp files during trim", async () => {
    const cacheDir = path.join(root, "thumbs");
    const cache = new ThumbnailCache(cacheDir, { maxBytes: 4096 });
    let calls = 0;
    const make = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { bytes: Buffer.alloc(128, 0xab), mediaType: "image/webp" as const, width: 16, height: 16, sourceWidth: 16, sourceHeight: 16 };
    };
    const [a, b, c] = await Promise.all([
      cache.ensure("key-1", make),
      cache.ensure("key-1", make),
      cache.ensure("key-1", make),
    ]);
    expect(calls).toBe(1);
    expect(a.path).toBe(b.path);
    expect(b.path).toBe(c.path);
    const residue = fs.readdirSync(cacheDir, { recursive: true }).filter((entry) => String(entry).includes(".tmp"));
    expect(residue).toEqual([]);

    // A stray .tmp file should be skipped rather than counted or failing trim().
    fs.writeFileSync(path.join(cacheDir, "in-flight.tmp"), Buffer.alloc(10_000, 1));
    expect(cache.totalBytes()).toBe(128);
    expect(() => cache.trim()).not.toThrow();
  });

  it("JobQueue ref-counts deduplicated key subscribers so one caller cancelling keeps the job alive for peers", async () => {
    const queue = new JobQueue({ default: 1 });
    let started = 0;
    let aborted = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const runner = async (ctx: { signal: AbortSignal }) => {
      started += 1;
      ctx.signal.addEventListener("abort", () => { aborted = true; });
      await gate;
      ctx.signal.throwIfAborted();
      return "ok";
    };

    const j1 = queue.submit({ kind: "work", key: "shared-1", run: runner });
    const j2 = queue.submit({ kind: "work", key: "shared-1", run: runner });
    expect(j1.id).toBe(j2.id);

    // First subscriber cancels: underlying job stays alive because j2 is still subscribed.
    j1.cancel();
    expect(aborted).toBe(false);

    release();
    expect(await j2.promise).toBe("ok");
    expect(started).toBe(1);
    expect(aborted).toBe(false);
  });

  it("redactToolText sorts secrets longest-first and runTool caps newline-less lineBuffer and handles callback throws", async () => {
    const shortDir = path.join(root, "a");
    const longDir = path.join(root, "a", "secret-child");
    const redacted = redactToolText(`failed at ${longDir} and ${shortDir}`, [shortDir, longDir]);
    expect(redacted).not.toContain("secret-child");

    const overflow = await runTool(process.execPath, ["-e", "process.stdout.write('x'.repeat(2048))"], {
      maxStdoutBytes: 512,
      onStdoutLine: () => undefined,
      timeoutMs: 10_000,
    });
    expect(overflow.killed).toBe("output-limit");

    const throwing = await runTool(process.execPath, ["-e", "console.log('line1'); setTimeout(() => console.log('line2'), 2000);"], {
      onStdoutLine: () => { throw new Error("boom"); },
      timeoutMs: 10_000,
    });
    expect(throwing.killed).toBe("cancelled");
  });

  it.skipIf(mediaPrerequisitesAbsent)("FfmpegService.frameJpeg validates finite time and maps corrupt files to UNSUPPORTED_FORMAT", async () => {
    const ffmpeg = new FfmpegService(locateFfmpeg(), { concurrency: 1 });
    await expect(ffmpeg.frameJpeg(samplePath("video-mp4-h264-aac"), Number.NaN, 160)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(ffmpeg.frameJpeg(samplePath("video-mp4-h264-aac"), Number.POSITIVE_INFINITY, 160)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(ffmpeg.frameJpeg(samplePath("video-corrupt"), 0, 160)).rejects.toMatchObject({ code: "UNSUPPORTED_FORMAT" });
  });
});
