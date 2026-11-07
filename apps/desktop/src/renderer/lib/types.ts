import type { NoteBlock } from "@manga/contracts/reading";

export type ConnectionForm = {
  id?: string;
  label: string;
  protocol: string;
  runtime: string;
  baseUrl: string;
  modelId: string;
  purpose: string;
  timeoutMs: string;
  secret: string;
};

export type NoteSummary = {
  objectId: string;
  revision: number;
  title: string;
  tags: string[];
  preview: string;
  resourceId: string | null;
  anchorId: string | null;
  sourceStatus?: string;
  updatedAt: string;
};

export type SourceCard = { status: string; title?: string; quote?: string; partTitle?: string; available?: boolean; resourceId?: string; resourceRevisionId?: string; partId?: string; reason?: string };

export type Bookmark = { id: string; label: string; resourceRevisionId?: string; locator: { kind?: string; partId?: string; range?: { start: number; end: number } }; createdAt?: string };

/** One agent composer per session, so switching sessions never carries another target's draft or scope. */
export type ComposerState = {
  draft: string;
  materials: string[];
  noteMaterials: string[];
  /** Pictures prepared for the next task; the main process holds the bytes, this holds a thumbnail and the facts. */
  images: AttachedImage[];
  /** Recordings whose transcripts go with the next task. */
  recordings: string[];
  /** The user turned online metadata search on for the next task only. */
  allowOnline: boolean;
  /** How many minutes past the spoiler limit the next task may read subtitles; 0 keeps the default limit. */
  subtitleAheadMin: number;
};

export type AttachedImage = {
  materialId: string;
  mediaType: string;
  width: number;
  height: number;
  bytes: number;
  extraction: string;
  preview: string;
  /** Set for a comic region, so the frozen context names the same region. */
  pageId?: string;
  region?: { x: number; y: number; width: number; height: number };
};

export const emptyComposer = (): ComposerState => ({ draft: "", materials: [], noteMaterials: [], images: [], recordings: [], allowOnline: false, subtitleAheadMin: 0 });

export type AgentSelection = { resourceId: string; resourceRevisionId: string; partId?: string; start: number; end: number; quote: string };

export const emptyForm = (): ConnectionForm => ({
  label: "本地",
  protocol: "openai-chat-completions",
  runtime: "native",
  baseUrl: "http://127.0.0.1:0",
  modelId: "local-test",
  purpose: "text",
  timeoutMs: "60000",
  secret: "",
});

export type NoteDoc = { objectId: string; revision: number; title: string; tags: string[]; blocks: NoteBlock[]; sourceStatus?: string; resourceId?: string | null };

export type NoteRevision = { revision: number; createdAt: string; blockCount: number; preview: string };
