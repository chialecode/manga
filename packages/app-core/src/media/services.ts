import fs from "node:fs";
import path from "node:path";
import { JobQueue } from "./job-queue.ts";
import { FfmpegService, locateFfmpeg, type FfmpegTools } from "./ffmpeg.ts";
import { MediaHandleTable } from "./handles.ts";
import { ThumbnailCache } from "./thumbnails.ts";
import { ZipPool } from "./zip-pool.ts";

export type MediaServicesOptions = {
  /** Cache partition of the profile; every derived file lives below it and can be rebuilt. */
  cacheDir: string;
  tools?: FfmpegTools | null;
  resourcesPath?: string;
  ffmpegConcurrency?: number;
};

/**
 * The shared plumbing of the three media kinds: handle table, archive pool, subprocess wrapper, background queue and
 * derived-image cache. One instance per product app; `dispose` ends everything it started.
 */
export class MediaServices {
  readonly handles = new MediaHandleTable();
  readonly zips = new ZipPool();
  readonly ffmpeg: FfmpegService;
  readonly jobs: JobQueue;
  readonly thumbs: ThumbnailCache;
  readonly cacheDir: string;
  private disposed = false;

  constructor(options: MediaServicesOptions) {
    this.cacheDir = options.cacheDir;
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const tools = options.tools === undefined ? locateFfmpeg({ resourcesPath: options.resourcesPath }) : options.tools;
    this.ffmpeg = new FfmpegService(tools, { concurrency: options.ffmpegConcurrency ?? 2 });
    this.jobs = new JobQueue({ ffmpeg: options.ffmpegConcurrency ?? 2, thumbs: 3, import: 1, probe: 2, vad: 1, net: 4, default: 2 });
    this.thumbs = new ThumbnailCache(path.join(this.cacheDir, "thumbs"));
  }

  dir(...parts: string[]): string {
    const target = path.join(this.cacheDir, ...parts);
    fs.mkdirSync(target, { recursive: true });
    return target;
  }

  /** Stop background work and close open archives. Handles stay valid until the table is dropped with the app. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.jobs.cancelWhere(() => true);
    this.zips.close();
  }
}
