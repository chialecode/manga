export type {
  StreamAgent,
  StreamItem,
} from "@manga/contracts";

/** The slice of the capture service the message stream reads; kept narrow so the stream stays a plain query. */
export type VoiceSessionLike = {
  list(input: { resourceId?: string; workId?: string; before?: string; limit?: number }): {
    sessions: Array<{
      id: string; stage: string; audioState: string; playable: boolean; durationMs: number; createdAt: string; resourceId: string | null;
      segments: { total: number; done: number; failed: number; pending: number };
    }>;
  };
};
