import fs from "node:fs";
import path from "node:path";
import { MangaError } from "@manga/contracts";
import type { VideoProbe, VideoStreamInfo } from "@manga/contracts";
import { decodeTextBuffer } from "../domain/text.ts";
import { writeFileAtomic } from "../shared/utils.ts";
import type { FfmpegService } from "../media/ffmpeg.ts";
import { fontFamilies } from "./font-names.ts";
import { discoverSidecars } from "./sidecars.ts";

export const SUBTITLE_MEDIA_TYPES = {
  ass: "text/x-ssa; charset=utf-8",
  srt: "application/x-subrip; charset=utf-8",
  vtt: "text/vtt; charset=utf-8",
} as const;

export const FONT_TYPES: Record<string, string> = {
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".ttc": "font/collection",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Primary video stream of a probe: cover art and attached pictures ride along as "video" streams without a valid frame rate,
 * so the main stream is the one with a frame rate, breaking ties by pixel area.
 */
export function primaryVideoStream(probe: Pick<VideoProbe, "streams">): VideoStreamInfo | undefined {
  const videos = probe.streams.filter((stream) => stream.type === "video");
  return [...videos].sort(
    (a, b) => (b.fps ? 1 : 0) - (a.fps ? 1 : 0) || (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0),
  )[0];
}

type InFlight = { promise: Promise<void>; controller: AbortController; waiters: number };
const inFlightExtracts = new Map<string, InFlight>();

async function runSingleFlight(key: string, work: (signal: AbortSignal) => Promise<void>, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new MangaError("CANCELLED", "media extraction was cancelled");
  let entry = inFlightExtracts.get(key);
  if (!entry) {
    const controller = new AbortController();
    const created: InFlight = {
      controller,
      waiters: 0,
      promise: Promise.resolve(),
    };
    created.promise = work(controller.signal).finally(() => {
      if (inFlightExtracts.get(key) === created) inFlightExtracts.delete(key);
    });
    created.promise.catch(() => undefined);
    inFlightExtracts.set(key, created);
    entry = created;
  }
  entry.waiters += 1;
  const active = entry;
  let released = false;
  const release = (abortIfLast: boolean) => {
    if (released) return;
    released = true;
    active.waiters -= 1;
    if (abortIfLast && active.waiters <= 0) active.controller.abort();
  };
  if (!signal) {
    try {
      await active.promise;
    } finally {
      release(false);
    }
    return;
  }
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      release(true);
      reject(new MangaError("CANCELLED", "media extraction was cancelled"));
      return;
    }
    const onAbort = () => {
      release(true);
      reject(new MangaError("CANCELLED", "media extraction was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    active.promise.then(
      () => { signal.removeEventListener("abort", onAbort); release(false); resolve(); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); release(false); reject(error); },
    );
  });
}

/**
 * Extracts a sidecar or embedded textual subtitle track into `dir` as UTF-8, using atomic writes and single-flight
 * deduplication so concurrent requests never race on temp files.
 */
export async function extractSubtitleFile(
  ffmpeg: FfmpegService,
  videoFile: string,
  probe: VideoProbe,
  dir: string,
  trackId: string,
  signal?: AbortSignal,
): Promise<{ path: string; format: "ass" | "srt" | "vtt"; language: string | null; title: string | null }> {
  if (trackId.startsWith("x")) {
    const sidecar = discoverSidecars(videoFile).find((item) => item.id === trackId);
    if (!sidecar) throw new MangaError("NOT_FOUND", "subtitle file is not next to the video any more");
    const target = path.join(dir, `${trackId}.${sidecar.format}`);
    if (!fs.existsSync(target)) {
      await runSingleFlight(`sub:${target}`, async (innerSignal) => {
        if (fs.existsSync(target)) return;
        if (innerSignal.aborted) throw new MangaError("CANCELLED", "subtitle extraction was cancelled");
        const text = decodeTextBuffer(new Uint8Array(fs.readFileSync(sidecar.absolutePath))).text.replace(/^\uFEFF/, "");
        if (innerSignal.aborted) throw new MangaError("CANCELLED", "subtitle extraction was cancelled");
        writeFileAtomic(target, text);
      }, signal);
    }
    return { path: target, format: sidecar.format, language: sidecar.language ?? null, title: sidecar.fileName };
  }
  const match = /^s(\d+)$/.exec(trackId);
  const stream = match ? probe.streams.find((item) => item.type === "subtitle" && item.index === Number(match[1])) : undefined;
  if (!stream) throw new MangaError("NOT_FOUND", "subtitle track does not exist");
  if (!stream.textual) throw new MangaError("UNSUPPORTED_FORMAT", "image subtitles cannot be shown as text");
  const format = stream.codec === "ass" || stream.codec === "ssa" ? "ass" : "srt";
  const target = path.join(dir, `${trackId}.${format}`);
  if (!fs.existsSync(target)) {
    await runSingleFlight(`sub:${target}`, async (innerSignal) => {
      if (fs.existsSync(target)) return;
      const text = await ffmpeg.subtitleText(videoFile, stream.index, format, { signal: innerSignal });
      if (innerSignal.aborted) throw new MangaError("CANCELLED", "subtitle extraction was cancelled");
      writeFileAtomic(target, text);
    }, signal);
  }
  return { path: target, format, language: stream.language ?? null, title: stream.title ?? null };
}

export type ExtractedFontItem = { stream: VideoStreamInfo; outName: string; file: string; mediaType: string };

/**
 * Extracts attached font streams into `dir` under safe caller-chosen names (`f<index>.<ext>`), serialized per directory
 * so concurrent calls never overwrite the same output files.
 */
export async function extractFontAttachments(
  ffmpeg: FfmpegService,
  videoFile: string,
  probe: VideoProbe,
  dir: string,
  signal?: AbortSignal,
): Promise<ExtractedFontItem[]> {
  const attachments = probe.streams.filter((stream) => stream.type === "attachment" && FONT_TYPES[path.extname(stream.fileName ?? "").toLowerCase()]);
  if (!attachments.length) return [];
  const items: ExtractedFontItem[] = attachments.map((stream) => {
    const ext = path.extname(stream.fileName!).toLowerCase();
    const outName = `f${stream.index}${ext}`;
    return { stream, outName, file: path.join(dir, outName), mediaType: FONT_TYPES[ext]! };
  });
  const missing = items.filter((item) => !fs.existsSync(item.file));
  if (missing.length) {
    await runSingleFlight(`fonts:${dir}`, async (innerSignal) => {
      const stillMissing = items.filter((item) => !fs.existsSync(item.file));
      if (!stillMissing.length) return;
      fs.mkdirSync(dir, { recursive: true });
      await ffmpeg.dumpAttachments(videoFile, stillMissing.map((item) => ({ streamIndex: item.stream.index, outName: item.outName })), dir, { signal: innerSignal });
    }, signal);
  }
  return items;
}

/** Reads font family names with a bounded LRU cache keyed by file path and size. */
export function readFontFamilies(cache: Map<string, string[]>, file: string, maxEntries: number): string[] {
  try {
    const key = `${file}:${fs.statSync(file).size}`;
    const known = cache.get(key);
    if (known) return known;
    const names = fontFamilies(fs.readFileSync(file));
    cache.set(key, names);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value as string);
    return names;
  } catch {
    return [];
  }
}

/** Awaits a deduplicated `JobQueue` job while letting `signal` abort only this waiter (cancelling the job only when the last waiter leaves). */
export async function awaitJobWithSignal<T>(job: { promise: Promise<T>; cancel: () => void }, signal?: AbortSignal): Promise<T> {
  if (!signal) return job.promise;
  if (signal.aborted) {
    job.cancel();
    throw new MangaError("CANCELLED", "task was cancelled");
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      return true;
    };
    const onAbort = () => {
      if (!finish()) return;
      job.cancel();
      reject(new MangaError("CANCELLED", "task was cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    job.promise.then(
      (value) => { if (finish()) resolve(value); },
      (error: unknown) => { if (finish()) reject(error); },
    );
  });
}
