import fs from "node:fs";
import path from "node:path";
import { MangaError } from "@manga/contracts";
import type { FfmpegService } from "../media/ffmpeg.ts";

/** What the renderer sends and what the filter and the ASR block builder read: 16 kHz, mono, 16-bit little-endian. */
export const PCM_SAMPLE_RATE = 16_000;
export const PCM_BYTES_PER_MS = (PCM_SAMPLE_RATE * 2) / 1000;

export const stagingName = (sessionId: string) => `capture-${sessionId}.pcm`;
export const retainedName = (sessionId: string) => `capture-${sessionId}.webm`;
export const RETAINED_MEDIA_TYPE = "audio/webm; codecs=opus";

export const pcmDurationMs = (bytes: number) => Math.floor(bytes / PCM_BYTES_PER_MS);
const byteOffsetFor = (ms: number) => Math.max(0, Math.round(ms * PCM_SAMPLE_RATE / 1000)) * 2;

export function wavHeader(dataBytes: number): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(PCM_SAMPLE_RATE, 24);
  header.writeUInt32LE(PCM_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export const wavFromPcm = (pcm: Buffer): Buffer => Buffer.concat([wavHeader(pcm.length), pcm]);

/** The audio between two capture offsets, read straight from the staged file. */
export function readPcmRange(file: string, startMs: number, endMs: number): Buffer {
  const from = byteOffsetFor(startMs);
  const to = byteOffsetFor(endMs);
  if (to <= from) return Buffer.alloc(0);
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.max(0, Math.min(to, size) - from);
    const out = Buffer.alloc(length);
    let done = 0;
    while (done < length) {
      const read = fs.readSync(fd, out, done, length - done, from + done);
      if (!read) break;
      done += read;
    }
    return done === length ? out : out.subarray(0, done);
  } finally {
    fs.closeSync(fd);
  }
}

/** Walk a staged file in pieces, so a long recording is never held whole in memory. */
export function* readPcmBlocks(file: string, blockSamples: number): Generator<Int16Array> {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(blockSamples * 2);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read < 2) return;
      const usable = read - (read % 2);
      const copy = new Int16Array(usable / 2);
      for (let i = 0; i < copy.length; i += 1) copy[i] = buffer.readInt16LE(i * 2);
      yield copy;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Long-term form of a recording: Opus in a WebM container, written beside its final name and renamed when complete. */
export async function encodeRetained(ffmpeg: FfmpegService, pcmFile: string, outFile: string, signal?: AbortSignal): Promise<{ bytes: number }> {
  const part = `${outFile}.part`;
  fs.rmSync(part, { force: true });
  try {
    await ffmpeg.run("ffmpeg", [
      "-v", "error", "-nostdin", "-y",
      "-f", "s16le", "-ar", String(PCM_SAMPLE_RATE), "-ac", "1", "-i", pcmFile,
      "-c:a", "libopus", "-b:a", "24k", "-application", "voip",
      "-f", "webm", part,
    ], { signal, timeoutMs: 15 * 60_000, maxStdoutBytes: 1024, redactPaths: [pcmFile, outFile, path.dirname(outFile)] });
    const bytes = fs.statSync(part).size;
    if (!bytes) throw new MangaError("UNSUPPORTED_FORMAT", "the encoder produced an empty file");
    fs.renameSync(part, outFile);
    return { bytes };
  } catch (error) {
    fs.rmSync(part, { force: true });
    throw error;
  }
}

/** One block of a retained recording as 16 kHz PCM, for transcribing again after the staged file is gone. */
export async function decodeRetainedRange(ffmpeg: FfmpegService, file: string, startMs: number, endMs: number, signal?: AbortSignal): Promise<Buffer> {
  const run = await ffmpeg.run("ffmpeg", [
    "-v", "error", "-nostdin",
    "-ss", (startMs / 1000).toFixed(3), "-t", ((endMs - startMs) / 1000).toFixed(3), "-i", file,
    "-f", "s16le", "-ar", String(PCM_SAMPLE_RATE), "-ac", "1", "pipe:1",
  ], { signal, timeoutMs: 120_000, maxStdoutBytes: Math.ceil((endMs - startMs) * PCM_BYTES_PER_MS) + 64 * 1024, redactPaths: [file, path.dirname(file)] });
  return run.stdout;
}
