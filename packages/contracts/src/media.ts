import { z } from "zod";
import { NormalizedRegionSchema, SourceLocatorSchema } from "./location.ts";

/** Resource kinds a reader can open. `audio` and `file` stay storable but have no reader yet. */
export const WORK_MEDIA_KINDS = ["novel", "comic", "video"] as const;
export const WorkMediaKindSchema = z.enum(WORK_MEDIA_KINDS);
export type WorkMediaKind = z.infer<typeof WorkMediaKindSchema>;

/** Shelf state is a user-facing attribute of a work. It is stored apart from reading progress. */
export const SHELF_STATES = ["none", "wishlist", "reading", "finished", "on_hold"] as const;
export const ShelfStateSchema = z.enum(SHELF_STATES);
export type ShelfState = z.infer<typeof ShelfStateSchema>;

export const ORDINAL_TYPES = ["volume", "chapter", "episode", "special"] as const;
export const OrdinalTypeSchema = z.enum(ORDINAL_TYPES);
export type OrdinalType = z.infer<typeof OrdinalTypeSchema>;

export const OrdinalSchema = z.object({
  type: OrdinalTypeSchema.optional(),
  number: z.number().min(0).max(100_000).optional(),
  label: z.string().min(1).max(64).optional(),
}).strict();
export type Ordinal = z.infer<typeof OrdinalSchema>;

/** Fields a user can override or lock on a work. Every key is also a projected field. */
export const METADATA_FIELD_KEYS = [
  "title",
  "titleOriginal",
  "author",
  "studio",
  "summary",
  "releaseDate",
  "platform",
  "episodeCount",
  "volumeCount",
  "tags",
] as const;
export const MetadataFieldKeySchema = z.enum(METADATA_FIELD_KEYS);
export type MetadataFieldKey = z.infer<typeof MetadataFieldKeySchema>;

export const MetadataFieldValueSchema = z.union([
  z.string().max(10_000),
  z.number().finite(),
  z.array(z.string().max(128)).max(64),
]);
export type MetadataFieldValue = z.infer<typeof MetadataFieldValueSchema>;

/** Providers shipped with the app. Any registered provider id is a short lowercase slug; the app checks it against what is installed. */
export const METADATA_PROVIDER_IDS = ["bangumi", "local-file"] as const;
export const MetadataProviderIdSchema = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/, "provider ids are short lowercase slugs");
export type MetadataProviderId = string;

export const COVER_SOURCES = ["file", "bangumi", "user"] as const;
export type CoverSource = (typeof COVER_SOURCES)[number];
export const COVER_STATES = ["auto", "user", "locked"] as const;
export type CoverState = (typeof COVER_STATES)[number];

/** Normalized region of a page: every number is a fraction of the original page, never of a scaled copy. */
export const PageRegionSchema = NormalizedRegionSchema;
export type PageRegion = z.infer<typeof PageRegionSchema>;

export const CAPTURE_MODES = ["hold", "toggle"] as const;
export const CAPTURE_RETENTION = ["keep", "discard"] as const;
export const CAPTURE_STAGES = [
  "recording",
  "recorded",
  "filtering",
  "awaiting_asr",
  "transcribing",
  "pending",
  "done",
  "no_speech",
  "failed",
  "cancelled",
] as const;
export type CaptureStage = (typeof CAPTURE_STAGES)[number];
export const CAPTURE_AUDIO_STATES = ["staged", "retained", "cleaned", "none"] as const;
export type CaptureAudioState = (typeof CAPTURE_AUDIO_STATES)[number];
export const CAPTURE_STOP_REASONS = ["user", "device_lost", "focus_lost", "deactivated", "key_lost", "error", "shutdown"] as const;
export type CaptureStopReason = (typeof CAPTURE_STOP_REASONS)[number];

export const CAPTURE_EVENT_REASONS = [
  "start",
  "speech_start",
  "sample",
  "seek",
  "pause",
  "resume",
  "rate_change",
  "resource_change",
  "position",
  "page",
  "selection",
  "episode_change",
  "stop",
] as const;
export type CaptureEventReason = (typeof CAPTURE_EVENT_REASONS)[number];

export const TRANSCRIPT_STATES = ["pending", "uploaded", "done", "failed", "no_speech"] as const;
export type TranscriptState = (typeof TRANSCRIPT_STATES)[number];

/** Which sources a mapped segment can carry. Video times are always on the original timeline. */
export const SegmentAnchorSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  resourceId: z.string().min(1).optional(),
  resourceRevisionId: z.string().min(1).optional(),
  locator: SourceLocatorSchema.optional(),
}).strict();
export type SegmentAnchor = z.infer<typeof SegmentAnchorSchema>;

export type PlaybackDecision = "direct" | "remux" | "play_copy" | "unsupported";

export type MediaHandleInfo = { url: string; mediaType: string; bytes?: number };

/** Where the bytes of one comic page come from. Bytes are read on demand from the original, never stored in the database. */
export type ComicPageRef =
  | { kind: "file"; relativePath: string }
  | { kind: "zip"; entry: string }
  | { kind: "pdf"; pageNumber: number }
  | { kind: "epub"; entry: string }
  | { kind: "mobi"; recordIndex: number }
  | { kind: "asset"; assetId: string };

export type ComicPage = {
  /** Stable across layout changes: the container entry path, or the page number plus a content hash. */
  id: string;
  index: number;
  name: string;
  width: number;
  height: number;
  hash: string;
  bytes?: number;
  spread?: boolean;
  /** False when the page could not be decoded; the reader shows a placeholder and keeps going. */
  ok: boolean;
  error?: string;
  ref: ComicPageRef;
};

export type ComicSource = "dir" | "cbz" | "pdf" | "epub" | "mobi";

export type ComicManifest = {
  source: ComicSource;
  pages: ComicPage[];
  direction?: "ltr" | "rtl";
  info?: { series?: string; title?: string; number?: string; writer?: string; summary?: string; year?: number; manga?: string };
  warnings: string[];
};

/** Compact video facts kept in the revision payload; the full probe lives in `media_probes`. */
export type VideoRevisionInfo = { durationMs: number; container: string; startMs: number; hasSubtitles: boolean };

export type VideoStreamInfo = {
  index: number;
  type: "video" | "audio" | "subtitle" | "attachment" | "data";
  codec: string;
  profile?: string;
  language?: string;
  title?: string;
  default?: boolean;
  width?: number;
  height?: number;
  pixelFormat?: string;
  bitDepth?: number;
  fps?: number;
  channels?: number;
  sampleRate?: number;
  /** For subtitles: `ass`, `subrip`, `webvtt`, `mov_text`, or image formats that cannot be rendered as text. */
  textual?: boolean;
  mimeType?: string;
  fileName?: string;
};

export type VideoProbe = {
  container: string;
  formatNames: string[];
  durationMs: number;
  startMs: number;
  bitRate?: number;
  /** Container tags such as title, artist and date, lower-cased and trimmed. */
  tags?: Record<string, string>;
  streams: VideoStreamInfo[];
  chapters: Array<{ startMs: number; endMs: number; title?: string }>;
  keyframesMs: number[];
  /** The first keyframes of the file are enough for M4 rough cuts to plan from; the rest is rebuildable. */
  keyframesTruncated: boolean;
  variableFrameRate: boolean;
  externalSubtitles: Array<{ id: string; fileName: string; format: "ass" | "srt" | "vtt"; language?: string }>;
  tool: { name: string; version: string };
};

/** One row of the library grid or list. Titles and authors are already projected. */
export type WorkSummary = {
  id: string;
  title: string;
  author: string | null;
  mediaKind: WorkMediaKind | "audio" | "file";
  shelf: ShelfState;
  coverId: string | null;
  lastResource: { id: string; title: string; ordinalLabel: string | null; revisionId: string | null } | null;
  /** Fraction in [0, 1] of the last opened resource. */
  progress: number;
  /** Resources of this work whose progress says finished, and how many resources it has. */
  finishedCount: number;
  resourceCount: number;
  linked: boolean;
  createdAt: string;
  lastOpenedAt: string | null;
};

export type WorkListPage = { items: WorkSummary[]; total: number; nextCursor: string | null };

export type WorkResourceRow = {
  id: string;
  title: string;
  kind: string;
  ordinalLabel: string | null;
  ordinalNumber: number | null;
  ordinalType: string | null;
  revisionId: string | null;
  progress: { percent: number; completion: string; locator: unknown | null; lastInteractionAt: string | null };
  unit: "chars" | "pages" | "ms" | null;
  total: number;
  available: boolean;
};
