import { z } from "zod";
import { MetadataProviderIdSchema } from "./media.ts";
import { QuickTaskDraftSchema, QUICK_PAGES } from "./quick-tasks.ts";

const id = z.string().min(1).max(256);
const iso = z.string().min(10).max(40);
const kind = z.enum(["novel", "comic", "video"]);

/** Library paths and the background scan (A-50). Adding or removing a path comes from the interface only: the model never supplies a path. */
export const SCAN_INTERVAL_MINUTES = [0, 30, 60, 360, 1440] as const;

/**
 * Input schemas for the commands the M2 rework adds: library paths and scans, previews and characters from a linked source,
 * quick tasks, the operation log, usage, records, the message stream of a session and the context debug panel.
 */
export const ReworkCommandInputs = {
  "library.paths.list": z.object({}).strict(),
  "library.paths.add": z.object({ pathHandle: id, mediaKind: kind, autoScan: z.boolean().optional() }).strict(),
  "library.paths.update": z.object({ pathId: id, mediaKind: kind.optional(), autoScan: z.boolean().optional() }).strict(),
  "library.paths.remove": z.object({ pathId: id }).strict(),
  "library.scan.start": z.object({ pathId: id.optional() }).strict(),
  "library.scan.cancel": z.object({ jobId: id.optional(), pathId: id.optional() }).strict(),
  "library.scan.status": z.object({}).strict(),
  "library.scan.setSchedule": z.object({
    onStartup: z.boolean(),
    intervalMinutes: z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(360), z.literal(1440)]),
  }).strict(),

  "metadata.resolveRef": z.object({ ref: z.string().max(512), workId: id.optional(), providerId: MetadataProviderIdSchema.optional() }).strict(),
  "metadata.preview": z.object({ workId: id, providerId: MetadataProviderIdSchema.optional(), externalId: z.string().min(1).max(64).optional() }).strict(),
  "metadata.characters": z.object({ workId: id }).strict(),

  "quickTasks.list": z.object({ page: z.enum(QUICK_PAGES).optional(), includeDisabled: z.boolean().optional() }).strict(),
  "quickTasks.save": QuickTaskDraftSchema,
  "quickTasks.delete": z.object({ id }).strict(),
  "quickTasks.reorder": z.object({ ids: z.array(id).min(1).max(200) }).strict(),
  "quickTasks.restore": z.object({ builtinKey: z.string().min(1).max(64).optional() }).strict(),

  "log.query": z.object({
    category: z.string().min(1).max(64).optional(),
    actorKind: z.enum(["user", "agent", "system"]).optional(),
    outcome: z.enum(["ok", "error"]).optional(),
    q: z.string().min(1).max(128).optional(),
    from: iso.optional(),
    to: iso.optional(),
    limit: z.number().int().positive().max(200).optional(),
    before: z.number().int().positive().optional(),
  }).strict(),
  "usage.query": z.object({
    from: iso.optional(),
    to: iso.optional(),
    modelId: z.string().min(1).max(128).optional(),
    limit: z.number().int().positive().max(200).optional(),
    offset: z.number().int().nonnegative().max(1_000_000).optional(),
  }).strict(),
  "records.list": z.object({
    type: z.enum(["all", "note", "recording"]).optional(),
    workId: id.optional(),
    mediaKind: kind.optional(),
    state: z.string().min(1).max(32).optional(),
    q: z.string().min(1).max(128).optional(),
    deleted: z.boolean().optional(),
    limit: z.number().int().positive().max(100).optional(),
    offset: z.number().int().nonnegative().max(1_000_000).optional(),
  }).strict(),
  "notes.delete": z.object({ objectId: id }).strict(),
  "notes.undelete": z.object({ objectId: id }).strict(),
  "session.stream": z.object({ sessionId: id, limit: z.number().int().positive().max(1000).optional(), before: iso.optional() }).strict(),
  "debug.context": z.object({
    sessionId: id.optional(),
    resourceId: id.optional(),
    workId: id.optional(),
    page: z.string().min(1).max(32).optional(),
  }).strict(),
};
