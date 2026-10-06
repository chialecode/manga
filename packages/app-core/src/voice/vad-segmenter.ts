/**
 * Turns per-frame speech probabilities (Silero VAD, 512 samples at 16 kHz = 32 ms per frame) into speech segments with
 * a safety margin on both sides. Pure and deterministic: the same probabilities always give the same segments, which is what
 * lets a recovered or re-run recording produce the same segment identities.
 */
export const VAD_SAMPLE_RATE = 16_000;
export const VAD_FRAME_SAMPLES = 512;
export const VAD_FRAME_MS = (VAD_FRAME_SAMPLES / VAD_SAMPLE_RATE) * 1000;

export type VadConfig = {
  /** A frame at or above this starts speech. */
  threshold: number;
  /** Frames below this count as silence while speech is open (hysteresis). */
  releaseThreshold: number;
  /** Shorter stretches of speech are noise, not speech. */
  minSpeechMs: number;
  /** Silence this long closes a segment. */
  minSilenceMs: number;
  /** Kept before and after every segment so the first and last syllables are not cut. */
  marginMs: number;
  /** Silent runs inside a segment at least this long are remembered as places a long segment may be split. */
  minPauseMs: number;
};

export const DEFAULT_VAD_CONFIG: VadConfig = { threshold: 0.5, releaseThreshold: 0.35, minSpeechMs: 250, minSilenceMs: 500, marginMs: 300, minPauseMs: 160 };

export type Pause = { startMs: number; endMs: number };

export type SpeechSegment = {
  /** Stable identity derived from the original capture offsets. */
  id: string;
  /** Original capture offsets, margins included, clamped to the recording. */
  startMs: number;
  endMs: number;
  /** The speech itself, without margins. */
  speechStartMs: number;
  speechEndMs: number;
  /** Silent runs inside the segment, on the original capture axis. */
  pauses: Pause[];
};

type Candidate = { speechStartMs: number; speechEndMs: number; pauses: Pause[] };

export const segmentId = (startMs: number, endMs: number) => `vs-${startMs}-${endMs}`;

export class VadSegmenter {
  private readonly config: VadConfig;
  private frame = 0;
  private speaking = false;
  private speechStartFrame = 0;
  private lastVoicedFrame = 0;
  private silentRun = 0;
  private pauseStartFrame = -1;
  private openPauses: Pause[] = [];
  private pending: Candidate | null = null;
  private readonly closed: SpeechSegment[] = [];

  constructor(config: Partial<VadConfig> = {}) {
    this.config = { ...DEFAULT_VAD_CONFIG, ...config };
  }

  /** How much of the recording the probabilities seen so far cover. */
  get consumedMs(): number {
    return this.frame * VAD_FRAME_MS;
  }

  private ms(frame: number): number {
    return Math.round(frame * VAD_FRAME_MS);
  }

  private finish(candidate: Candidate, totalMs: number | null): SpeechSegment {
    const margin = this.config.marginMs;
    const startMs = Math.max(0, candidate.speechStartMs - margin);
    const endMs = totalMs === null ? candidate.speechEndMs + margin : Math.min(totalMs, candidate.speechEndMs + margin);
    return { id: segmentId(startMs, endMs), startMs, endMs, speechStartMs: candidate.speechStartMs, speechEndMs: candidate.speechEndMs, pauses: candidate.pauses };
  }

  /** Close the open speech, if it is long enough to count, and hand it to the merge step. */
  private closeSpeech(endFrame: number): void {
    const startMs = this.ms(this.speechStartFrame);
    const endMs = this.ms(endFrame);
    this.speaking = false;
    this.silentRun = 0;
    this.pauseStartFrame = -1;
    const pauses = this.openPauses;
    this.openPauses = [];
    if (endMs - startMs < this.config.minSpeechMs) return;
    const candidate: Candidate = { speechStartMs: startMs, speechEndMs: endMs, pauses };
    const margin = this.config.marginMs;
    if (this.pending && candidate.speechStartMs - margin <= this.pending.speechEndMs + margin) {
      // Margins touch: one segment, and the gap between the two speeches is a place it may be split.
      this.pending = {
        speechStartMs: this.pending.speechStartMs,
        speechEndMs: candidate.speechEndMs,
        pauses: [...this.pending.pauses, { startMs: this.pending.speechEndMs, endMs: candidate.speechStartMs }, ...candidate.pauses],
      };
    } else {
      if (this.pending) this.closed.push(this.finish(this.pending, null));
      this.pending = candidate;
    }
  }

  /** Feed the next probabilities. Returns the segments that became final (no later speech can still merge into them). */
  push(probabilities: ArrayLike<number>): SpeechSegment[] {
    const { threshold, releaseThreshold } = this.config;
    const minSilenceFrames = Math.ceil(this.config.minSilenceMs / VAD_FRAME_MS);
    const minPauseFrames = Math.ceil(this.config.minPauseMs / VAD_FRAME_MS);
    for (let index = 0; index < probabilities.length; index += 1) {
      const probability = probabilities[index]!;
      const frame = this.frame;
      if (!this.speaking) {
        if (probability >= threshold) {
          this.speaking = true;
          this.speechStartFrame = frame;
          this.lastVoicedFrame = frame;
          this.silentRun = 0;
          this.pauseStartFrame = -1;
          this.openPauses = [];
        }
      } else if (probability >= releaseThreshold) {
        if (this.pauseStartFrame >= 0 && frame - this.pauseStartFrame >= minPauseFrames) {
          this.openPauses.push({ startMs: this.ms(this.pauseStartFrame), endMs: this.ms(frame) });
        }
        this.pauseStartFrame = -1;
        this.lastVoicedFrame = frame;
        this.silentRun = 0;
      } else {
        if (this.pauseStartFrame < 0) this.pauseStartFrame = frame;
        this.silentRun += 1;
        if (this.silentRun >= minSilenceFrames) this.closeSpeech(this.lastVoicedFrame + 1);
      }
      this.frame += 1;
    }
    return this.drain(false);
  }

  /** Segments that can no longer merge with anything still to come. */
  private drain(final: boolean, totalMs: number | null = null): SpeechSegment[] {
    const margin = this.config.marginMs;
    if (this.pending && !final) {
      const nowMs = this.ms(this.frame);
      const openStartMs = this.speaking ? this.ms(this.speechStartFrame) : Number.POSITIVE_INFINITY;
      const nothingCanMerge = nowMs > this.pending.speechEndMs + 2 * margin && openStartMs - margin > this.pending.speechEndMs + margin;
      if (nothingCanMerge) {
        this.closed.push(this.finish(this.pending, null));
        this.pending = null;
      }
    }
    if (final && this.pending) {
      this.closed.push(this.finish(this.pending, totalMs));
      this.pending = null;
    }
    return this.closed.splice(0, this.closed.length);
  }

  /** End of the recording: close whatever is open and return the remaining segments, clamped to `totalMs`. */
  flush(totalMs: number): SpeechSegment[] {
    if (this.speaking) this.closeSpeech(Math.min(this.lastVoicedFrame + 1, this.frame));
    const out = this.drain(true, totalMs);
    return out.map((segment) => (segment.endMs > totalMs ? { ...segment, endMs: totalMs, id: segmentId(segment.startMs, totalMs) } : segment));
  }
}

/** Segments for a whole recording at once, from all of its probabilities. */
export function segmentRecording(probabilities: ArrayLike<number>, totalMs: number, config: Partial<VadConfig> = {}): SpeechSegment[] {
  const segmenter = new VadSegmenter(config);
  return [...segmenter.push(probabilities), ...segmenter.flush(totalMs)];
}
