import { useEffect, useRef, useState } from "react";
import { readAloud, useReadAloud } from "../voice/read-aloud.ts";

/** A paragraph of the loaded text, by absolute code-point offsets. */
export type NovelParagraph = { start: number; end: number; text: string };

/**
 * The paragraphs of a text window from the one that holds `from` on (计划 4.8): split at line breaks like the reader's own layout, blank ones left out.
 */
export function novelParagraphs(text: string, sliceStart: number, from: number): NovelParagraph[] {
  const chars = [...text];
  const out: NovelParagraph[] = [];
  let index = 0;
  while (index < chars.length) {
    if (chars[index] === "\n") { index += 1; continue; }
    let end = index;
    while (end < chars.length && chars[end] !== "\n") end += 1;
    const body = chars.slice(index, end).join("");
    if (body.trim() && sliceStart + end > from) out.push({ start: sliceStart + index, end: sliceStart + end, text: body });
    index = end;
  }
  return out;
}

/** Billed characters of a text (a Chinese character counts two), for the cost hint before a novel is read. */
export function billedChars(text: string): number {
  let n = 0;
  for (const char of text) n += /\p{Script=Han}/u.test(char) ? 2 : 1;
  return n;
}

type Slice = { partId: string; text: string; start: number; end: number; textLayer: boolean; kind: string };

export type ReadNovelInput = {
  /** The book; a reading belongs to it. */
  resourceId: string | null;
  slice: Slice | null;
  parts: Array<{ id: string; length: number }>;
  /** Where the page on screen starts, read when the reading begins. */
  at: () => number;
  /** Whether a speech connection is there (otherwise the button is not shown). */
  available: boolean;
  costHint: boolean;
  voice?: string;
  connectionId?: string;
  onCostHintOff: () => void;
  /** Loads the next window of the chapter, or the next chapter, without moving the saved position. */
  onWindow: (partId: string, from: number) => void;
  /** Moves the reading position (the answer to “move the position here?”). */
  onMove: (partId: string, start: number) => void;
};

/**
 * Reading a novel aloud (计划 4.8): from the page on screen, paragraph by paragraph; the paragraph being heard is marked and the pages follow it; at the end
 * of the loaded text it goes on into the next window and the next chapter. Stopping asks whether the reading position moves to where it stopped.
 */
/**
 * What a book's reading keeps beyond the reader that started it: the paragraphs being read, where it goes on once the next window has loaded, and where it
 * stopped. It is kept by book, so a reader that is laid out again (a panel opens, the tab is drawn anew) finds its reading where it was; a reading whose
 * book has no reader left for a moment is stopped.
 */
type NovelReading = {
  partId: string;
  paragraphs: NovelParagraph[];
  going: { partId: string; from: number } | null;
  stoppedAt: { partId: string; start: number } | null;
  mounted: number;
  leaveTimer: number | null;
  latest: { current: ReadNovelInput };
};
const readings = new Map<string, NovelReading>();
const LEFT_MS = 1000;

function entryOf(key: string, latest: { current: ReadNovelInput }): NovelReading {
  let entry = readings.get(key);
  if (!entry) { entry = { partId: "", paragraphs: [], going: null, stoppedAt: null, mounted: 0, leaveTimer: null, latest }; readings.set(key, entry); }
  return entry;
}

export function useReadNovel(input: ReadNovelInput) {
  const state = useReadAloud();
  const owner = input.resourceId ? `novel:${input.resourceId}` : null;
  const mine = owner !== null && state.owner === owner;
  const [asking, setAsking] = useState<{ chars: number } | null>(null);
  const [, redraw] = useState(0);
  const inputRef = useRef(input);
  inputRef.current = input;

  // The reader that is on screen now is the one a reading answers to; when the last one for the book goes and none comes back, the reading stops.
  useEffect(() => {
    if (!owner) return;
    const entry = entryOf(owner, inputRef);
    if (entry.leaveTimer !== null) { window.clearTimeout(entry.leaveTimer); entry.leaveTimer = null; }
    entry.mounted += 1;
    entry.latest = inputRef;
    return () => {
      entry.mounted -= 1;
      if (entry.leaveTimer !== null) window.clearTimeout(entry.leaveTimer);
      entry.leaveTimer = window.setTimeout(() => {
        entry.leaveTimer = null;
        if (entry.mounted > 0) return;
        entry.going = null;
        if (readAloud.getState().owner === owner) readAloud.stop();
        readings.delete(owner);
      }, LEFT_MS);
    };
  }, [owner]);

  useEffect(() => {
    if (!owner) return;
    const existing = readings.get(owner);
    if (existing) existing.latest = inputRef;
  });

  // The end of the loaded text: the next window of the chapter, or the next chapter; at the end of the book the reading is over.
  const continueAfter = (key: string, finishedSlice: Slice) => {
    const entry = entryOf(key, inputRef);
    const host = entry.latest.current;
    entry.paragraphs = [];
    const part = host.parts.find((item) => item.id === finishedSlice.partId);
    if (part && finishedSlice.end < part.length) {
      entry.going = { partId: finishedSlice.partId, from: finishedSlice.end };
      host.onWindow(finishedSlice.partId, finishedSlice.end);
      return;
    }
    const next = host.parts[host.parts.findIndex((item) => item.id === finishedSlice.partId) + 1];
    if (next) {
      entry.going = { partId: next.id, from: 0 };
      host.onWindow(next.id, 0);
    }
  };

  const begin = (from: number) => {
    const { slice } = inputRef.current;
    if (!slice || !owner) return;
    const entry = entryOf(owner, inputRef);
    const paragraphs = novelParagraphs(slice.text, slice.start, from);
    if (!paragraphs.length) { continueAfter(owner, slice); return; }
    entry.partId = slice.partId;
    entry.paragraphs = paragraphs;
    entry.stoppedAt = null;
    const latest = () => entryOf(owner, inputRef).latest.current;
    void readAloud.play({
      owner,
      segments: paragraphs.map((paragraph) => paragraph.text),
      task: "novel",
      ...(latest().voice ? { voice: latest().voice } : {}),
      ...(latest().connectionId ? { connectionId: latest().connectionId } : {}),
      onEnd: (reason, index) => {
        // Advance from the slice whose segments actually finished, even if the user browsed elsewhere.
        if (reason === "done") { continueAfter(owner, slice); return; }
        const paragraph = paragraphs[index];
        if (reason === "stopped" && paragraph) entry.stoppedAt = { partId: entry.partId, start: paragraph.start };
        entry.paragraphs = [];
      },
    });
  };
  const beginRef = useRef(begin);
  beginRef.current = begin;

  // The next window or chapter has come: the reading goes on from where it was.
  useEffect(() => {
    const entry = owner ? readings.get(owner) : undefined;
    const wanted = entry?.going;
    const slice = inputRef.current.slice;
    if (!entry || !wanted || !slice || slice.partId !== wanted.partId || wanted.from < slice.start) return;
    const hasProgress = wanted.from < slice.end || (wanted.from === 0 && slice.start === 0 && slice.end === 0);
    if (!hasProgress) return;
    entry.going = null;
    beginRef.current(wanted.from);
  }, [owner, input.slice?.partId, input.slice?.start, input.slice?.end]);

  // Another reading (an answer, the preview) took over: the book's reading does not go on into the next window.
  useEffect(() => { if (owner && !mine && state.status !== "idle") { const entry = readings.get(owner); if (entry) { entry.going = null; entry.paragraphs = []; } } }, [owner, mine, state.status]);

  const start = () => {
    const { slice, costHint } = inputRef.current;
    if (!slice) return;
    if (costHint) {
      const rest = novelParagraphs(slice.text, slice.start, inputRef.current.at()).map((paragraph) => paragraph.text).join("");
      setAsking({ chars: billedChars(rest) });
      return;
    }
    begin(inputRef.current.at());
  };

  const entry = owner ? readings.get(owner) : undefined;
  // The paragraph being heard is the controller's own count, so it is right after the reader has been laid out again.
  const heard = mine && entry ? entry.paragraphs[state.segment] : undefined;
  const stoppedAt = !mine && entry?.stoppedAt ? entry.stoppedAt : null;
  const readable = input.available && Boolean(input.slice) && input.slice!.textLayer !== false && input.slice!.kind !== "image";
  return {
    readable,
    status: mine ? state.status : "idle" as const,
    error: mine ? state.error : null,
    mark: heard && entry ? { partId: entry.partId, start: heard.start, end: heard.end } : null,
    asking,
    stoppedAt,
    start,
    confirm: (never: boolean) => { setAsking(null); if (never) inputRef.current.onCostHintOff(); begin(inputRef.current.at()); },
    cancelAsk: () => setAsking(null),
    pause: () => readAloud.pause(),
    resume: () => readAloud.resume(),
    stop: () => { if (entry) entry.going = null; readAloud.stop(); },
    moveHere: () => { if (stoppedAt) inputRef.current.onMove(stoppedAt.partId, stoppedAt.start); if (entry) entry.stoppedAt = null; redraw((n) => n + 1); },
    keepPlace: () => { if (entry) entry.stoppedAt = null; redraw((n) => n + 1); },
  };
}
