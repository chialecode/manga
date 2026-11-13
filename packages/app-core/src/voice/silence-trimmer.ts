import { MangaError, type AudioWarning } from "@manga/contracts";
import { PCM_SAMPLE_RATE, wavFromPcm } from "./audio-files.ts";
import type { VadEngine } from "./vad-client.ts";
import {
  DEFAULT_VAD_CONFIG,
  VAD_FRAME_SAMPLES,
  VAD_SAMPLE_RATE,
  segmentRecording,
  type SpeechSegment,
  type VadConfig,
} from "./vad-segmenter.ts";

export const GTCRN_WET_MIX = 0.75;
export const GTCRN_DRY_MIX = 1 - GTCRN_WET_MIX;

export const TRIM_PAD_MS = 300;
export const TRIM_LONG_PAUSE_MS = 1_000;
export const TRIM_COMPRESSED_PAUSE_MS = 400;
export const MAX_DICTATION_DURATION_MS = 300_000;

export const LOW_VOLUME_DBFS = -30;
export const CLIPPING_SAMPLE_THRESHOLD = 0.999;
export const CLIPPING_INT16_THRESHOLD = 32_760;
export const CLIPPING_RATIO_THRESHOLD = 0.01;

const SEAM_TAPER_MS = 8;

export type AudioInputBuffer = Float32Array | Int16Array | Buffer | Uint8Array;

export type AudioDiagnostics = {
  warnings: AudioWarning[];
  peakAmplitude: number;
  peakDbfs: number;
  clippedRatio: number;
  speechSamples: number;
};

export type SilenceTrimResult =
  | {
      status: "no_speech";
      samples: Float32Array;
      pcm16: Int16Array;
      pcmBuffer: Buffer;
      wavBuffer: Buffer;
      inputDurationMs: number;
      outputDurationMs: number;
      speechDurationMs: number;
      warnings: AudioWarning[];
      diagnostics: AudioDiagnostics;
      segments: SpeechSegment[];
    }
  | {
      status: "speech";
      samples: Float32Array;
      pcm16: Int16Array;
      pcmBuffer: Buffer;
      wavBuffer: Buffer;
      inputDurationMs: number;
      outputDurationMs: number;
      speechDurationMs: number;
      warnings: AudioWarning[];
      diagnostics: AudioDiagnostics;
      segments: SpeechSegment[];
    };

export type TrimSilenceOptions = {
  vad?: VadEngine;
  /** Precomputed Silero VAD frame probabilities (one per 512 samples at 16 kHz). */
  probabilities?: ArrayLike<number>;
  vadConfig?: Partial<VadConfig>;
  padMs?: number;
  longPauseMs?: number;
  compressedPauseMs?: number;
  signal?: AbortSignal;
};

/**
 * Dry/wet linear blend (`0.75 * denoised + 0.25 * raw`) so GTCRN speech enhancement reduces steady background
 * noise while preserving soft initial and final consonants.
 */
export function mixGtcrnAudio(
  raw: Float32Array,
  denoised: Float32Array,
  wetMix: number = GTCRN_WET_MIX,
): Float32Array {
  const wet = Math.min(1, Math.max(0, Number.isFinite(wetMix) ? wetMix : GTCRN_WET_MIX));
  const dry = 1 - wet;
  const out = new Float32Array(raw.length);
  const shared = Math.min(raw.length, denoised.length);
  for (let i = 0; i < shared; i += 1) {
    const sample = wet * denoised[i]! + dry * raw[i]!;
    out[i] = Math.min(1, Math.max(-1, sample));
  }
  for (let i = shared; i < raw.length; i += 1) {
    out[i] = Math.min(1, Math.max(-1, raw[i]!));
  }
  return out;
}

export function int16ToFloat32(pcm16: Int16Array): Float32Array {
  const out = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i += 1) {
    const v = pcm16[i]!;
    out[i] = v < 0 ? v / 32_768 : v / 32_767;
  }
  return out;
}

export function float32ToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.min(1, Math.max(-1, samples[i]!));
    out[i] = clamped < 0 ? Math.round(clamped * 32_768) : Math.round(clamped * 32_767);
  }
  return out;
}

export function int16ToPcmBuffer(pcm16: Int16Array): Buffer {
  const buf = Buffer.allocUnsafe(pcm16.length * 2);
  for (let i = 0; i < pcm16.length; i += 1) {
    buf.writeInt16LE(pcm16[i]!, i * 2);
  }
  return buf;
}

function stripWavHeaderIfPresent(bytes: Uint8Array): Uint8Array {
  if (
    bytes.byteLength >= 44 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x41 && // A
    bytes[10] === 0x56 && // V
    bytes[11] === 0x45 // E
  ) {
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
  return bytes;
}

export function normalizePcm16kInput(input: AudioInputBuffer): {
  samples: Float32Array;
  pcm16: Int16Array;
} {
  if (input instanceof Float32Array) {
    return { samples: input, pcm16: float32ToInt16(input) };
  }
  if (input instanceof Int16Array) {
    return { samples: int16ToFloat32(input), pcm16: input };
  }
  const rawBytes = stripWavHeaderIfPresent(input);
  const sampleCount = Math.floor(rawBytes.byteLength / 2);
  const pcm16 = new Int16Array(sampleCount);
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    pcm16[i] = view.getInt16(i * 2, true);
  }
  return { samples: int16ToFloat32(pcm16), pcm16 };
}

type SpeechSpan = { startMs: number; endMs: number };

function extractAtomicSpeechSpans(segments: readonly SpeechSegment[]): SpeechSpan[] {
  const spans: SpeechSpan[] = [];
  for (const segment of segments) {
    const pauses = [...segment.pauses]
      .filter((p) => p.endMs > p.startMs && p.startMs > segment.speechStartMs && p.endMs < segment.speechEndMs)
      .sort((a, b) => a.startMs - b.startMs);
    let cursor = segment.speechStartMs;
    for (const pause of pauses) {
      if (pause.startMs > cursor) {
        spans.push({ startMs: cursor, endMs: pause.startMs });
      }
      cursor = Math.max(cursor, pause.endMs);
    }
    if (segment.speechEndMs > cursor) {
      spans.push({ startMs: cursor, endMs: segment.speechEndMs });
    }
  }
  return spans.sort((a, b) => a.startMs - b.startMs);
}

export function computeSpeechDiagnostics(
  samples: Float32Array,
  pcm16: Int16Array,
  spans: readonly SpeechSpan[],
): AudioDiagnostics {
  let speechSamples = 0;
  let clippedSamples = 0;
  let peakAmplitude = 0;

  for (const span of spans) {
    const from = Math.max(0, Math.min(samples.length, Math.round((span.startMs * PCM_SAMPLE_RATE) / 1000)));
    const to = Math.max(from, Math.min(samples.length, Math.round((span.endMs * PCM_SAMPLE_RATE) / 1000)));
    for (let i = from; i < to; i += 1) {
      speechSamples += 1;
      const absFloat = Math.abs(samples[i]!);
      const absInt16 = Math.abs(pcm16[i]!);
      if (absFloat > peakAmplitude) {
        peakAmplitude = absFloat;
      }
      if (absFloat >= CLIPPING_SAMPLE_THRESHOLD || absInt16 >= CLIPPING_INT16_THRESHOLD) {
        clippedSamples += 1;
      }
    }
  }

  if (speechSamples === 0) {
    return {
      warnings: [],
      peakAmplitude: 0,
      peakDbfs: Number.NEGATIVE_INFINITY,
      clippedRatio: 0,
      speechSamples: 0,
    };
  }

  const peakDbfs = peakAmplitude > 0 ? 20 * Math.log10(peakAmplitude) : Number.NEGATIVE_INFINITY;
  const clippedRatio = clippedSamples / speechSamples;
  const warnings: AudioWarning[] = [];
  if (peakDbfs < LOW_VOLUME_DBFS) {
    warnings.push("low_volume");
  }
  if (clippedRatio >= CLIPPING_RATIO_THRESHOLD) {
    warnings.push("clipping");
  }

  return {
    warnings,
    peakAmplitude,
    peakDbfs,
    clippedRatio,
    speechSamples,
  };
}

async function computeVadProbabilities(
  vad: VadEngine,
  pcm16: Int16Array,
  signal?: AbortSignal,
): Promise<Float32Array> {
  if (!vad.available) {
    throw new MangaError(
      "CAPABILITY_UNAVAILABLE",
      vad.unavailableReason ?? "语音活动检测模型（Silero VAD）不可用",
    );
  }
  if (signal?.aborted) {
    throw new MangaError("CANCELLED", "静音裁剪已取消");
  }
  const stream = vad.open();
  const chunks: Float32Array[] = [];
  const stepSamples = VAD_FRAME_SAMPLES * 64; // ~2 seconds per worker round-trip
  try {
    for (let offset = 0; offset < pcm16.length; offset += stepSamples) {
      if (signal?.aborted) {
        throw new MangaError("CANCELLED", "静音裁剪已取消");
      }
      const slice = pcm16.subarray(offset, Math.min(pcm16.length, offset + stepSamples));
      const probs = await stream.push(slice);
      if (probs.length > 0) chunks.push(probs);
    }
    const remainder = pcm16.length % VAD_FRAME_SAMPLES;
    if (remainder > 0) {
      const pad = new Int16Array(VAD_FRAME_SAMPLES - remainder);
      const tailProbs = await stream.push(pad);
      if (tailProbs.length > 0) chunks.push(tailProbs);
    }
  } finally {
    stream.close();
  }

  const totalFrames = chunks.reduce((sum, item) => sum + item.length, 0);
  const combined = new Float32Array(totalFrames);
  let cursor = 0;
  for (const item of chunks) {
    combined.set(item, cursor);
    cursor += item.length;
  }
  return combined;
}

function applyCosineTaperOut(slice: Float32Array, taperSamples: number): void {
  const count = Math.min(slice.length, taperSamples);
  const start = slice.length - count;
  for (let i = 0; i < count; i += 1) {
    const gain = 0.5 * (1 + Math.cos((Math.PI * (i + 1)) / count));
    slice[start + i] = slice[start + i]! * gain;
  }
}

function applyCosineTaperIn(slice: Float32Array, taperSamples: number): void {
  const count = Math.min(slice.length, taperSamples);
  for (let i = 0; i < count; i += 1) {
    const gain = 0.5 * (1 - Math.cos((Math.PI * i) / count));
    slice[i] = slice[i]! * gain;
  }
}

/**
 * Runs Silero VAD over 16 kHz mono PCM, pads 300 ms around outer speech boundaries, keeps pauses `<= 1000 ms`
 * intact, and compresses pauses `> 1000 ms` down to 400 ms (retaining 200 ms natural consonant margins on each side).
 * Returns `status: "no_speech"` when zero speech segments exist so callers never send empty/noise audio to ASR.
 */
export async function trimSilence(
  input: AudioInputBuffer,
  options: TrimSilenceOptions = {},
): Promise<SilenceTrimResult> {
  if (options.signal?.aborted) {
    throw new MangaError("CANCELLED", "静音裁剪已取消");
  }

  const { samples, pcm16 } = normalizePcm16kInput(input);
  const inputDurationMs = Math.round((samples.length / VAD_SAMPLE_RATE) * 1000);

  if (samples.length === 0) {
    const emptyDiag: AudioDiagnostics = {
      warnings: [],
      peakAmplitude: 0,
      peakDbfs: Number.NEGATIVE_INFINITY,
      clippedRatio: 0,
      speechSamples: 0,
    };
    return {
      status: "no_speech",
      samples: new Float32Array(0),
      pcm16: new Int16Array(0),
      pcmBuffer: Buffer.alloc(0),
      wavBuffer: Buffer.alloc(0),
      inputDurationMs: 0,
      outputDurationMs: 0,
      speechDurationMs: 0,
      warnings: [],
      diagnostics: emptyDiag,
      segments: [],
    };
  }

  let probabilities: ArrayLike<number>;
  if (options.probabilities !== undefined) {
    probabilities = options.probabilities;
  } else if (options.vad) {
    probabilities = await computeVadProbabilities(options.vad, pcm16, options.signal);
  } else {
    throw new MangaError(
      "VALIDATION_ERROR",
      "trimSilence 需要提供 Silero VAD 引擎（vad）或已计算的帧概率（probabilities）",
    );
  }

  const padMs = options.padMs ?? TRIM_PAD_MS;
  const longPauseMs = options.longPauseMs ?? TRIM_LONG_PAUSE_MS;
  const compressedPauseMs = options.compressedPauseMs ?? TRIM_COMPRESSED_PAUSE_MS;

  const segments = segmentRecording(probabilities, inputDurationMs, {
    ...DEFAULT_VAD_CONFIG,
    marginMs: padMs,
    ...options.vadConfig,
  });

  const atomicSpans = extractAtomicSpeechSpans(segments);
  if (atomicSpans.length === 0) {
    const emptyDiag: AudioDiagnostics = {
      warnings: [],
      peakAmplitude: 0,
      peakDbfs: Number.NEGATIVE_INFINITY,
      clippedRatio: 0,
      speechSamples: 0,
    };
    return {
      status: "no_speech",
      samples: new Float32Array(0),
      pcm16: new Int16Array(0),
      pcmBuffer: Buffer.alloc(0),
      wavBuffer: Buffer.alloc(0),
      inputDurationMs,
      outputDurationMs: 0,
      speechDurationMs: 0,
      warnings: [],
      diagnostics: emptyDiag,
      segments: [],
    };
  }

  const diagnostics = computeSpeechDiagnostics(samples, pcm16, atomicSpans);
  const speechDurationMs = atomicSpans.reduce((sum, span) => sum + (span.endMs - span.startMs), 0);

  // Merge spans separated by `<= longPauseMs` so natural short pauses stay untouched;
  // spans separated by `> longPauseMs` become separate runs joined by `compressedPauseMs`.
  const mergedRuns: SpeechSpan[] = [];
  for (const span of atomicSpans) {
    const prev = mergedRuns[mergedRuns.length - 1];
    if (prev && span.startMs - prev.endMs <= longPauseMs) {
      prev.endMs = Math.max(prev.endMs, span.endMs);
    } else {
      mergedRuns.push({ startMs: span.startMs, endMs: span.endMs });
    }
  }

  const halfCompressedMs = Math.floor(compressedPauseMs / 2);
  const otherHalfCompressedMs = compressedPauseMs - halfCompressedMs;
  const taperSamples = Math.round((SEAM_TAPER_MS * PCM_SAMPLE_RATE) / 1000);

  const pieces: Float32Array[] = [];
  for (let idx = 0; idx < mergedRuns.length; idx += 1) {
    const run = mergedRuns[idx]!;
    const isFirst = idx === 0;
    const isLast = idx === mergedRuns.length - 1;

    const sliceStartMs = isFirst
      ? Math.max(0, run.startMs - padMs)
      : Math.max(0, run.startMs - halfCompressedMs);
    const sliceEndMs = isLast
      ? Math.min(inputDurationMs, run.endMs + padMs)
      : Math.min(inputDurationMs, run.endMs + otherHalfCompressedMs);

    const fromSample = Math.max(0, Math.min(samples.length, Math.round((sliceStartMs * PCM_SAMPLE_RATE) / 1000)));
    const toSample = Math.max(fromSample, Math.min(samples.length, Math.round((sliceEndMs * PCM_SAMPLE_RATE) / 1000)));

    const piece = samples.slice(fromSample, toSample);
    if (!isFirst) {
      applyCosineTaperIn(piece, taperSamples);
    }
    if (!isLast) {
      applyCosineTaperOut(piece, taperSamples);
    }
    pieces.push(piece);
  }

  const totalOutSamples = pieces.reduce((sum, p) => sum + p.length, 0);
  const outSamples = new Float32Array(totalOutSamples);
  let writeCursor = 0;
  for (const piece of pieces) {
    outSamples.set(piece, writeCursor);
    writeCursor += piece.length;
  }

  const outPcm16 = float32ToInt16(outSamples);
  const outPcmBuffer = int16ToPcmBuffer(outPcm16);
  const outWavBuffer = wavFromPcm(outPcmBuffer);
  const outputDurationMs = Math.round((outSamples.length / PCM_SAMPLE_RATE) * 1000);

  return {
    status: "speech",
    samples: outSamples,
    pcm16: outPcm16,
    pcmBuffer: outPcmBuffer,
    wavBuffer: outWavBuffer,
    inputDurationMs,
    outputDurationMs,
    speechDurationMs,
    warnings: diagnostics.warnings,
    diagnostics,
    segments,
  };
}
