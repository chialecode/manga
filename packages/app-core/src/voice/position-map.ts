import type { CaptureEventReason, SegmentAnchor, SourceLocator } from "@manga/contracts";

/** One recorded fact about where the reader was, on the capture clock (milliseconds from the first audio sample). */
export type PositionEvent = {
  offsetMs: number;
  reason: CaptureEventReason;
  resourceId?: string;
  resourceRevisionId?: string;
  locator?: SourceLocator;
  playing?: boolean;
  playbackRate?: number;
  /** Arrival order, to keep events with the same offset in the order they were reported. */
  seq?: number;
};

type State = {
  resourceId?: string;
  resourceRevisionId?: string;
  locator?: SourceLocator;
  /** Video: the source time at `sinceMs`, and how it advances. */
  timeMs: number | null;
  sinceMs: number;
  playing: boolean;
  rate: number;
};

type Span = { fromMs: number; toMs: number; state: State };

const JOIN_TOLERANCE_MS = 150;

function advance(state: State, toMs: number): void {
  if (state.timeMs !== null && state.playing && toMs > state.sinceMs) state.timeMs += (toMs - state.sinceMs) * state.rate;
  state.sinceMs = toMs;
}

function applyEvent(state: State, event: PositionEvent): void {
  // The source time moves with the clock only while playing: settle it up to this event before anything changes.
  advance(state, event.offsetMs);
  if (event.resourceId !== undefined && event.resourceId !== state.resourceId) {
    state.resourceId = event.resourceId;
    state.resourceRevisionId = event.resourceRevisionId;
    state.locator = undefined;
    state.timeMs = null;
    state.playing = false;
  } else if (event.resourceRevisionId !== undefined) {
    state.resourceRevisionId = event.resourceRevisionId;
  }
  if (event.playbackRate !== undefined) state.rate = event.playbackRate;
  if (event.playing !== undefined) state.playing = event.playing;
  if (event.locator) {
    state.locator = event.locator;
    if (event.locator.kind === "temporal") {
      // A reported position is the truth at that moment: it replaces what the clock predicted (a seek, or a periodic sample correcting drift).
      state.timeMs = event.locator.startMs;
      state.sinceMs = event.offsetMs;
    }
  }
  if (event.reason === "pause") state.playing = false;
  if (event.reason === "resume" && event.playing === undefined) state.playing = true;
}

function snapshot(state: State): State {
  return { ...state };
}

/** Where the reader was over each stretch of a recording. The recording starts at 0 with whatever the first event says. */
export function positionSpans(events: PositionEvent[], endMs: number): Span[] {
  const ordered = [...events].sort((a, b) => a.offsetMs - b.offsetMs || (a.seq ?? 0) - (b.seq ?? 0));
  const state: State = { timeMs: null, sinceMs: 0, playing: false, rate: 1 };
  const spans: Span[] = [];
  let cursor = 0;
  for (const event of ordered) {
    const at = Math.max(0, event.offsetMs);
    if (at > cursor) {
      spans.push({ fromMs: cursor, toMs: at, state: snapshot(state) });
      cursor = at;
    }
    applyEvent(state, event);
  }
  const last = Math.max(endMs, cursor);
  if (last > cursor || !spans.length) spans.push({ fromMs: cursor, toMs: last, state: snapshot(state) });
  return spans;
}

function anchorFor(state: State, fromMs: number, toMs: number): SegmentAnchor {
  const anchor: SegmentAnchor = { startMs: Math.round(fromMs), endMs: Math.round(toMs) };
  if (state.resourceId !== undefined) anchor.resourceId = state.resourceId;
  if (state.resourceRevisionId !== undefined) anchor.resourceRevisionId = state.resourceRevisionId;
  if (state.locator?.kind === "temporal" && state.timeMs !== null) {
    const at = (t: number) => Math.max(0, state.timeMs! + (state.playing ? (t - state.sinceMs) * state.rate : 0));
    const start = Math.round(at(fromMs));
    const end = Math.round(at(toMs));
    anchor.locator = { kind: "temporal", startMs: start, endMs: Math.max(start, end), ...(state.locator.trackId ? { trackId: state.locator.trackId } : {}) };
  } else if (state.locator) {
    anchor.locator = state.locator;
  }
  return anchor;
}

const sameLocation = (a: SegmentAnchor, b: SegmentAnchor): boolean => {
  if (a.resourceId !== b.resourceId || a.resourceRevisionId !== b.resourceRevisionId) return false;
  if (a.locator?.kind === "temporal" && b.locator?.kind === "temporal") {
    // Continuous when the next stretch starts where the previous one ended; a seek starts a new anchor.
    return Math.abs(b.locator.startMs - (a.locator.endMs ?? a.locator.startMs)) <= JOIN_TOLERANCE_MS && (a.locator.trackId ?? "") === (b.locator.trackId ?? "");
  }
  return JSON.stringify(a.locator ?? null) === JSON.stringify(b.locator ?? null);
};

/**
 * The anchors of one stretch of a recording, between two capture offsets: one per place the reader was. A page turn,
 * a selection change, a seek, a switch of resource or of episode starts a new anchor. A pause does not: the clock keeps
 * running while the video does not, so the recorded interval keeps its real length while the source time stands still,
 * and a stretch that pauses and resumes in place stays one anchor over the source range it actually covered.
 */
export function mapInterval(events: PositionEvent[], startMs: number, endMs: number): SegmentAnchor[] {
  if (endMs < startMs) return [];
  const spans = positionSpans(events, endMs);
  const anchors: SegmentAnchor[] = [];
  const pick = startMs === endMs
    ? [...spans].reverse().filter((span) => span.fromMs <= startMs).slice(0, 1)
    : spans;
  for (const span of pick) {
    const from = Math.max(startMs, span.fromMs);
    const to = Math.min(endMs, span.toMs);
    if (to < from || (to === from && startMs !== endMs)) continue;
    if (span.state.resourceId === undefined && !span.state.locator) continue;
    const anchor = anchorFor(span.state, from, to);
    const previous = anchors[anchors.length - 1];
    if (previous && previous.endMs === anchor.startMs && sameLocation(previous, anchor)) {
      previous.endMs = anchor.endMs;
      if (previous.locator?.kind === "temporal" && anchor.locator?.kind === "temporal") previous.locator = { ...previous.locator, endMs: anchor.locator.endMs ?? anchor.locator.startMs };
    } else {
      anchors.push(anchor);
    }
  }
  return anchors;
}
