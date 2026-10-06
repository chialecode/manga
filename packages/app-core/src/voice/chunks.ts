import type { Pause, SpeechSegment } from "./vad-segmenter.ts";

/** The most audio one upload carries (plan 5.4: a block is at most 30 s). */
export const MAX_CHUNK_MS = 30_000;
/** Speech segments closer than this travel in one block, with the quiet between them kept so times stay one-to-one. */
export const MERGE_GAP_MS = 1_500;
/** Smallest piece worth uploading on its own. */
const MIN_PIECE_MS = 400;

export type PlannedChunk = {
  /** Deterministic from the capture offsets: re-running the filter on the same audio gives the same keys, so nothing is submitted twice. */
  key: string;
  /** Original capture offsets of the audio the block carries. Block time t maps to capture time `startMs + t` (no cut inside a block). */
  startMs: number;
  endMs: number;
  segmentIds: string[];
};

export const chunkKey = (startMs: number, endMs: number) => `c${startMs}-${endMs}`;

type Piece = { startMs: number; endMs: number; segmentId: string };

/** Split one long segment at its quiet points, falling back to a hard cut where it never pauses. */
function splitLong(segment: SpeechSegment, maxMs: number): Piece[] {
  if (segment.endMs - segment.startMs <= maxMs) return [{ startMs: segment.startMs, endMs: segment.endMs, segmentId: segment.id }];
  const pauses: Pause[] = [...segment.pauses].sort((a, b) => a.startMs - b.startMs);
  const pieces: Piece[] = [];
  let cursor = segment.startMs;
  while (segment.endMs - cursor > maxMs) {
    const limit = cursor + maxMs;
    const floor = cursor + Math.max(MIN_PIECE_MS, Math.floor(maxMs * 0.4));
    // The latest pause that still fits is the least wasteful place to cut; among pauses of the same place, a longer one is quieter.
    let best: { at: number; length: number } | null = null;
    for (const pause of pauses) {
      const at = Math.round((pause.startMs + pause.endMs) / 2);
      if (at < floor || at > limit) continue;
      const length = pause.endMs - pause.startMs;
      if (!best || at > best.at || (at === best.at && length > best.length)) best = { at, length };
    }
    const cut = best?.at ?? limit;
    pieces.push({ startMs: cursor, endMs: cut, segmentId: segment.id });
    cursor = cut;
  }
  pieces.push({ startMs: cursor, endMs: segment.endMs, segmentId: segment.id });
  return pieces;
}

/** Cut the speech segments of a recording into upload blocks. */
export function planChunks(segments: SpeechSegment[], options: { maxChunkMs?: number; mergeGapMs?: number } = {}): PlannedChunk[] {
  const maxMs = options.maxChunkMs ?? MAX_CHUNK_MS;
  const mergeGap = options.mergeGapMs ?? MERGE_GAP_MS;
  const pieces = [...segments].sort((a, b) => a.startMs - b.startMs).flatMap((segment) => splitLong(segment, maxMs));
  const chunks: PlannedChunk[] = [];
  for (const piece of pieces) {
    const last = chunks[chunks.length - 1];
    if (last && piece.startMs - last.endMs <= mergeGap && piece.endMs - last.startMs <= maxMs) {
      last.endMs = Math.max(last.endMs, piece.endMs);
      if (!last.segmentIds.includes(piece.segmentId)) last.segmentIds.push(piece.segmentId);
      last.key = chunkKey(last.startMs, last.endMs);
    } else {
      chunks.push({ key: chunkKey(piece.startMs, piece.endMs), startMs: piece.startMs, endMs: piece.endMs, segmentIds: [piece.segmentId] });
    }
  }
  return chunks;
}

/** What the upload size limit allows: 16-bit mono PCM at 16 kHz is 32 000 bytes a second, plus a 44-byte WAV header. */
export function maxChunkMsForBytes(maxBytes: number | undefined): number {
  if (!maxBytes) return MAX_CHUNK_MS;
  const seconds = Math.floor((maxBytes - 44) / 32_000);
  return Math.max(1_000, Math.min(MAX_CHUNK_MS, seconds * 1000));
}
