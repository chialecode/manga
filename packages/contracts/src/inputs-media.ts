import { z } from "zod";
import { SourceLocatorSchema } from "./location.ts";
import {
  CAPTURE_EVENT_REASONS,
  CAPTURE_MODES,
  CAPTURE_RETENTION,
  CAPTURE_STOP_REASONS,
  MetadataFieldKeySchema,
  MetadataFieldValueSchema,
  MetadataProviderIdSchema,
  OrdinalSchema,
  PageRegionSchema,
  ShelfStateSchema,
  WorkMediaKindSchema,
} from "./media.ts";

const id = z.string().min(1).max(256);
const optionalRevision = id.optional();
const nonNegativeMs = z.number().int().nonnegative().max(7 * 24 * 60 * 60 * 1000);
const imageEdge = z.number().int().min(64).max(4096);

/**
 * What a task may be given beyond text: the page or the moment the user is at, the recordings they pick, and the stills they
 * prepared with `material.region` / `material.frame`. Positions are the reader's own; the main process checks each against
 * the revision it names and freezes it into the run.
 */
export const AgentMediaContextSchema = z.object({
  comic: z.object({
    resourceId: id,
    resourceRevisionId: id,
    pageId: id,
    region: PageRegionSchema.optional(),
  }).strict().optional(),
  video: z.object({
    resourceId: id,
    resourceRevisionId: id,
    positionMs: nonNegativeMs,
    frame: z.number().int().nonnegative().max(100_000_000).optional(),
    interval: z.object({ startMs: nonNegativeMs, endMs: nonNegativeMs }).strict().optional(),
    /** How far back the subtitle window reaches. */
    subtitleBeforeMs: z.number().int().min(0).max(10 * 60_000).optional(),
    /** The user's explicit widening past the spoiler limit, counted from the position. Absent means the default limit. */
    subtitleAheadMs: z.number().int().min(0).max(10 * 60_000).optional(),
  }).strict().optional(),
}).strict();
export type AgentMediaContext = z.infer<typeof AgentMediaContextSchema>;

/** Input schemas for the M2 commands: works, covers, metadata, comic, video, recording and image materials. */
export const MediaCommandInputs = {
  "library.inspectFile": z.object({ pathHandle: id }).strict(),

  "works.list": z.object({
    limit: z.number().int().positive().max(200).optional(),
    cursor: z.string().max(512).optional(),
    query: z.string().max(256).optional(),
    kind: WorkMediaKindSchema.optional(),
    shelf: ShelfStateSchema.optional(),
    linked: z.boolean().optional(),
    /** Only works that have a file in this format (`epub`, `cbz`, `mkv`...), as the library lists it. */
    format: z.string().min(1).max(32).optional(),
    hasNotes: z.boolean().optional(),
    sort: z.enum(["recent", "added", "title", "progress"]).optional(),
  }).strict(),
  "works.get": z.object({ workId: id }).strict(),
  "works.importDirectory": z.object({
    pathHandle: id,
    kind: WorkMediaKindSchema,
    title: z.string().min(1).max(256).optional(),
    workId: id.optional(),
    hosted: z.boolean().optional(),
  }).strict(),
  "works.setKind": z.object({ resourceId: id, kind: WorkMediaKindSchema }).strict(),
  "works.moveResource": z.object({
    resourceId: id,
    toWorkId: id.optional(),
    newWorkTitle: z.string().min(1).max(256).optional(),
  }).strict().refine((value) => Boolean(value.toWorkId) !== Boolean(value.newWorkTitle), {
    message: "name either a target work or a title for a new work",
  }),
  "works.setOrdinal": z.object({ resourceId: id, ordinal: OrdinalSchema.nullable() }).strict(),
  "works.setShelf": z.object({ workId: id, state: ShelfStateSchema }).strict(),
  "works.setOverride": z.object({
    workId: id,
    fields: z.partialRecord(MetadataFieldKeySchema, MetadataFieldValueSchema),
    locked: z.array(MetadataFieldKeySchema).max(32),
    cleared: z.array(MetadataFieldKeySchema).max(32),
  }).strict(),
  "works.open": z.object({ resourceId: id }).strict(),

  "covers.list": z.object({ workId: id }).strict(),
  "covers.select": z.object({ workId: id, coverId: id }).strict(),
  "covers.lock": z.object({ workId: id, locked: z.boolean() }).strict(),
  "covers.fromImage": z.object({ workId: id, pathHandle: id }).strict(),
  "covers.handles": z.object({
    coverIds: z.array(id).min(1).max(200),
    size: z.enum(["grid", "detail"]),
  }).strict(),

  "metadata.providers": z.object({}).strict(),
  "metadata.setProvider": z.object({
    providerId: MetadataProviderIdSchema,
    enabled: z.boolean(),
    credentialHandle: id.optional(),
    clearCredential: z.boolean().optional(),
  }).strict(),
  "metadata.search": z.object({
    workId: id.optional(),
    query: z.string().min(1).max(256),
    kind: WorkMediaKindSchema.optional(),
    providerIds: z.array(MetadataProviderIdSchema).max(4).optional(),
    mode: z.enum(["single", "fallback", "multi"]).optional(),
    limit: z.number().int().positive().max(25).optional(),
  }).strict(),
  "metadata.candidates": z.object({ workId: id }).strict(),
  "metadata.link": z.object({
    workId: id,
    providerId: MetadataProviderIdSchema,
    externalId: z.string().min(1).max(64),
    candidateId: id.optional(),
    /** Fields the user chose to keep as they are in the preview; the source's values are stored but do not replace them. */
    keepFields: z.array(MetadataFieldKeySchema).max(32).optional(),
    keepCover: z.boolean().optional(),
  }).strict(),
  "metadata.unlink": z.object({ workId: id, providerId: MetadataProviderIdSchema }).strict(),
  "metadata.refresh": z.object({ workId: id, providerId: MetadataProviderIdSchema.optional(), keepFields: z.array(MetadataFieldKeySchema).max(32).optional(), keepCover: z.boolean().optional() }).strict(),
  "metadata.related": z.object({ workId: id }).strict(),
  "metadata.findMissing": z.object({ limit: z.number().int().positive().max(200).optional(), kind: WorkMediaKindSchema.optional() }).strict(),

  "comic.pages": z.object({ resourceId: id, revisionId: optionalRevision }).strict(),
  "comic.pageHandle": z.object({
    resourceId: id,
    revisionId: id,
    pageId: id,
    variant: z.enum(["display", "original", "thumb"]).optional(),
    maxEdge: imageEdge.optional(),
  }).strict(),
  "comic.pageHandles": z.object({
    resourceId: id,
    revisionId: id,
    pageIds: z.array(id).min(1).max(12),
    variant: z.enum(["display", "thumb"]).optional(),
    maxEdge: imageEdge.optional(),
  }).strict(),

  "video.probe": z.object({ resourceId: id, revisionId: optionalRevision, refresh: z.boolean().optional() }).strict(),
  "video.subtitles": z.object({ resourceId: id, revisionId: optionalRevision }).strict(),
  "video.audioTracks": z.object({ resourceId: id, revisionId: optionalRevision }).strict(),
  "video.frameIndex": z.object({
    resourceId: id,
    revisionId: optionalRevision,
    timeMs: nonNegativeMs.optional(),
    frame: z.number().int().nonnegative().max(50_000_000).optional(),
    delta: z.number().int().min(-1000).max(1000).optional(),
  }).strict().refine((value) => value.timeMs === undefined || value.frame === undefined, {
    message: "ask for a frame or a time, not both",
  }),
  "video.playbackPlan": z.object({
    resourceId: id,
    revisionId: optionalRevision,
    hardwareHevc: z.boolean().optional(),
    audioStreamIndex: z.number().int().nonnegative().max(255).optional(),
  }).strict(),
  "video.playCopy": z.object({
    resourceId: id,
    revisionId: id,
    action: z.enum(["create", "cancel", "remove", "status"]),
    /** Only for a file that would play directly: ask for a copy anyway (the owner's testing and troubleshooting switch). */
    reason: z.enum(["no_hardware_hevc", "unsupported_audio", "audio_track", "unsupported_video"]).optional(),
    audioStreamIndex: z.number().int().nonnegative().max(255).optional(),
    /** What the player found out about this machine, so the copy is planned for the same machine that asks. */
    hardwareHevc: z.boolean().optional(),
  }).strict(),
  "video.handle": z.object({
    resourceId: id,
    revisionId: id,
    source: z.enum(["original", "play_copy"]),
    copyId: id.optional(),
  }).strict(),
  "video.subtitleHandle": z.object({ resourceId: id, revisionId: id, trackId: id }).strict(),
  "video.fonts": z.object({ resourceId: id, revisionId: id }).strict(),

  "progress.setPage": z.object({
    resourceId: id,
    resourceRevisionId: id,
    pageId: id,
    consumed: z.boolean().optional(),
  }).strict(),
  "progress.setTime": z.object({
    resourceId: id,
    resourceRevisionId: id,
    timeMs: nonNegativeMs,
    played: z.array(z.object({ startMs: nonNegativeMs, endMs: nonNegativeMs }).strict().refine((range) => range.endMs >= range.startMs, { message: "range must not end before it starts" })).max(64).optional(),
  }).strict(),
  "progress.get": z.object({ resourceId: id, resourceRevisionId: optionalRevision }).strict(),

  "settings.getRecording": z.object({}).strict(),
  "settings.setRecording": z.object({
    deviceId: z.string().max(512).nullable().optional(),
    holdKey: z.string().min(1).max(32).optional(),
    toggleKey: z.string().min(1).max(32).optional(),
    retention: z.enum(CAPTURE_RETENTION).optional(),
    duckPlayback: z.enum(["none", "lower", "pause"]).optional(),
    boundaryMarginMs: z.number().int().min(0).max(2000).optional(),
    overlay: z.object({
      x: z.number().int().min(-20000).max(20000).optional(),
      y: z.number().int().min(-20000).max(20000).optional(),
      width: z.number().int().min(160).max(640).optional(),
      height: z.number().int().min(48).max(320).optional(),
    }).strict().optional(),
  }).strict(),
  "settings.getModules": z.object({}).strict(),
  "settings.setModule": z.object({ featureId: z.string().min(1).max(64), enabled: z.boolean() }).strict(),
  "settings.getMedia": z.object({}).strict(),
  "settings.setMedia": z.object({
    comic: z.object({
      direction: z.enum(["ltr", "rtl"]).optional(),
      layout: z.enum(["single", "double", "strip"]).optional(),
      coverAlone: z.boolean().optional(),
      fit: z.enum(["width", "height", "page", "original"]).optional(),
      zoom: z.number().min(0.25).max(4).optional(),
      autoFlipSeconds: z.number().min(0).max(120).optional(),
      animation: z.enum(["none", "slide", "fade"]).optional(),
    }).strict().optional(),
    video: z.object({
      rate: z.number().min(0.25).max(4).optional(),
      holdRate: z.number().min(1).max(4).optional(),
      volume: z.number().min(0).max(1).optional(),
      muted: z.boolean().optional(),
      seekStepSeconds: z.number().min(1).max(120).optional(),
      autoNext: z.boolean().optional(),
    }).strict().optional(),
  }).strict(),

  "capture.start": z.object({
    mode: z.enum(CAPTURE_MODES),
    resourceId: id.optional(),
    resourceRevisionId: optionalRevision,
    locator: SourceLocatorSchema.optional(),
    retention: z.enum(CAPTURE_RETENTION).optional(),
    deviceLabel: z.string().max(256).optional(),
    sampleRate: z.literal(16_000).optional(),
  }).strict(),
  "capture.append": z.object({
    sessionId: id,
    seq: z.number().int().nonnegative().max(10_000_000),
    /** 16-bit little-endian PCM, base64. About 3.2 KB per 100 ms. */
    data: z.string().min(1).max(1_400_000),
  }).strict(),
  "capture.event": z.object({
    sessionId: id,
    offsetMs: nonNegativeMs,
    reason: z.enum(CAPTURE_EVENT_REASONS),
    resourceId: id.optional(),
    resourceRevisionId: optionalRevision,
    locator: SourceLocatorSchema.optional(),
    playing: z.boolean().optional(),
    playbackRate: z.number().min(0.1).max(8).optional(),
  }).strict(),
  "capture.stop": z.object({ sessionId: id, reason: z.enum(CAPTURE_STOP_REASONS).optional(), durationMs: nonNegativeMs.optional() }).strict(),
  "capture.status": z.object({ sessionId: id.optional() }).strict(),
  "capture.list": z.object({ resourceId: id.optional(), workId: id.optional(), limit: z.number().int().positive().max(200).optional() }).strict(),
  "capture.transcribe": z.object({ sessionId: id, connectionId: id.optional() }).strict(),
  "capture.retry": z.object({ sessionId: id, segmentId: id.optional() }).strict(),
  "capture.cancel": z.object({ sessionId: id }).strict(),
  "capture.organize": z.object({ sessionId: id, connectionId: id.optional() }).strict(),
  "capture.editDraft": z.object({ draftId: id, editedText: z.string().max(200_000) }).strict(),
  "capture.acceptDraft": z.object({ draftId: id, editedText: z.string().max(200_000).optional(), title: z.string().min(1).max(256).optional() }).strict(),
  "capture.retain": z.object({ sessionId: id, action: z.enum(["keep", "discard"]) }).strict(),
  "capture.review": z.object({ sessionId: id }).strict(),
  "capture.reviseSegment": z.object({ segmentId: id, text: z.string().max(20_000) }).strict(),
  "capture.calibrate": z.object({
    segmentId: id,
    resourceId: id,
    resourceRevisionId: id,
    locator: SourceLocatorSchema,
  }).strict(),
  "capture.terms": z.object({ workId: id }).strict(),
  "capture.addTerm": z.object({ workId: id, term: z.string().min(1).max(128), heard: z.string().max(128).optional() }).strict(),
  "capture.removeTerm": z.object({ workId: id, term: z.string().min(1).max(128) }).strict(),
  "capture.audioHandle": z.object({ sessionId: id }).strict(),

  "material.region": z.object({
    resourceId: id,
    resourceRevisionId: id,
    pageId: id,
    region: PageRegionSchema.optional(),
    maxEdge: imageEdge.optional(),
  }).strict(),
  "material.frame": z.object({
    resourceId: id,
    resourceRevisionId: id,
    timeMs: nonNegativeMs,
    maxEdge: imageEdge.optional(),
  }).strict(),
  "material.subtitleWindow": z.object({
    resourceId: id,
    resourceRevisionId: id,
    centerMs: nonNegativeMs,
    beforeMs: z.number().int().min(0).max(10 * 60_000).optional(),
    afterMs: z.number().int().min(0).max(10 * 60_000).optional(),
    allowAhead: z.boolean().optional(),
  }).strict(),
} as const;
