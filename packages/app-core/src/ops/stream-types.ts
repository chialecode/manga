import type { SourceLocator } from "@manga/contracts";

/**
 * The right pane's message stream (A-48): one list, oldest first, that merges what the user wrote down, what they said and
 * what they asked the Agent in this session. Notes are ordinary notes; the stream is a view over them, so nothing is stored twice.
 */
export type StreamNote = {
  kind: "note";
  id: string;
  at: string;
  title: string;
  /** The user's own text, without the quoted excerpt. */
  text: string;
  quote: string;
  tags: string[];
  revision: number;
  resourceId: string | null;
  resourceRevisionId: string | null;
  anchorId: string | null;
  locator: SourceLocator | null;
  /** Page number (1-based) when the locator names a comic page. */
  pageNumber: number | null;
};
export type StreamVoice = {
  kind: "voice";
  id: string;
  at: string;
  stage: string;
  audioState: string;
  playable: boolean;
  durationMs: number;
  text: string;
  segments: { total: number; done: number; failed: number; pending: number };
  /** Where each stretch of speech was said, for the source tags under the bubble. */
  sources: Array<{ startMs: number; locator: SourceLocator | null; resourceId: string | null }>;
  resourceId: string | null;
};
export type StreamUser = { kind: "user"; id: string; at: string; runId: string; text: string; quickTask: { id: string | null; name: string } | null };
export type StreamAgent = { kind: "agent"; id: string; at: string; runId: string; status: string; text: string; error: { code: string; message: string } | null };
export type StreamItem = StreamNote | StreamVoice | StreamUser | StreamAgent;

/** The slice of the capture service the message stream reads; kept narrow so the stream stays a plain query. */
export type VoiceSessionLike = {
  list(input: { resourceId?: string; workId?: string; limit?: number }): {
    sessions: Array<{
      id: string; stage: string; audioState: string; playable: boolean; durationMs: number; createdAt: string; resourceId: string | null;
      segments: { total: number; done: number; failed: number; pending: number };
    }>;
  };
};
