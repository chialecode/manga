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

export function wavHeader(dataBytes: number, sampleRate = PCM_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export function wavFromPcm(pcm: Buffer, sampleRate = PCM_SAMPLE_RATE): Buffer {
  const evenBytes = pcm.byteLength - (pcm.byteLength % 2);
  const body = evenBytes === pcm.byteLength ? pcm : pcm.subarray(0, evenBytes);
  return Buffer.concat([wavHeader(body.byteLength, sampleRate), body], 44 + body.byteLength);
}

function isRiffWave(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 44 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x41 && // A
    bytes[10] === 0x56 && // V
    bytes[11] === 0x45 // E
  );
}

/** Decodes a 16-bit mono RIFF/WAVE buffer back into raw PCM16LE bytes and sample rate. */
export function decodePcm16MonoWav(wavBytes: Buffer): { pcm16le: Buffer; sampleRate: number } {
  if (!isRiffWave(wavBytes)) {
    throw new MangaError("UNSUPPORTED_FORMAT", "听写音频文件不是有效的 WAV 格式");
  }

  let sampleRate = PCM_SAMPLE_RATE;
  let offset = 12;
  while (offset + 8 <= wavBytes.byteLength) {
    const chunkId = wavBytes.toString("ascii", offset, offset + 4);
    const chunkSize = wavBytes.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkId === "fmt " && chunkStart + 16 <= wavBytes.byteLength) {
      const audioFormat = wavBytes.readUInt16LE(chunkStart);
      const channels = wavBytes.readUInt16LE(chunkStart + 2);
      sampleRate = wavBytes.readUInt32LE(chunkStart + 4);
      const bitsPerSample = wavBytes.readUInt16LE(chunkStart + 14);
      if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16) {
        throw new MangaError("UNSUPPORTED_FORMAT", "仅支持单声道 16-bit PCM WAV 听写音频");
      }
    } else if (chunkId === "data") {
      const end = Math.min(wavBytes.byteLength, chunkStart + chunkSize);
      const slice = wavBytes.subarray(chunkStart, end);
      const evenLen = slice.byteLength - (slice.byteLength % 2);
      return { pcm16le: Buffer.from(slice.subarray(0, evenLen)), sampleRate };
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  throw new MangaError("UNSUPPORTED_FORMAT", "WAV 文件缺少音频数据段");
}

/** Strips a RIFF/WAVE header if present and returns the raw data slice; otherwise returns `bytes` unchanged. */
export function stripWavHeaderIfPresent(bytes: Uint8Array): Uint8Array {
  if (!isRiffWave(bytes)) return bytes;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = String.fromCharCode(
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4);
    const chunkSize = view.getUint32(0, true);
    const dataStart = offset + 8;
    if (chunkId === "data") {
      const end = Math.min(bytes.byteLength, dataStart + chunkSize);
      return bytes.subarray(dataStart, end);
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  return bytes.subarray(44);
}

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
