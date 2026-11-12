import { MangaError } from "@manga/contracts";
import { PCM_SAMPLE_RATE } from "../audio-files.ts";

/** Encodes raw 16-bit little-endian mono PCM into a standard 44-byte RIFF/WAVE buffer. */
export function encodePcm16MonoWav(pcm16le: Buffer, sampleRate = PCM_SAMPLE_RATE): Buffer {
  const evenBytes = pcm16le.byteLength - (pcm16le.byteLength % 2);
  const body = evenBytes === pcm16le.byteLength ? pcm16le : pcm16le.subarray(0, evenBytes);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + body.byteLength, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(body.byteLength, 40);
  return Buffer.concat([header, body], 44 + body.byteLength);
}

/** Decodes a 16-bit mono RIFF/WAVE buffer back into raw PCM16LE bytes and sample rate. */
export function decodePcm16MonoWav(wavBytes: Buffer): { pcm16le: Buffer; sampleRate: number } {
  if (
    wavBytes.byteLength < 44 ||
    wavBytes.toString("ascii", 0, 4) !== "RIFF" ||
    wavBytes.toString("ascii", 8, 12) !== "WAVE"
  ) {
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
