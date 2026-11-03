import { z } from "zod";

export const CHANNELS = ["release", "development", "test"] as const;
export type Channel = (typeof CHANNELS)[number];

export const LOCATION_PARTITIONS = [
  "data",
  "resources",
  "works",
  "projects",
  "attachments",
  "downloads",
  "cache",
  "logs",
  "backups",
  "exports",
  "runtime",
] as const;
export type LocationPartition = (typeof LOCATION_PARTITIONS)[number];

export const LocationPartitionSchema = z.enum(LOCATION_PARTITIONS);
export const ChannelSchema = z.enum(CHANNELS);

export const LocationLayoutSchema = z.object({
  revision: z.number().int().positive(),
  channel: ChannelSchema,
  documentsRoot: z.string().min(1),
  defaultRoot: z.string().min(1),
  /** Where the application keeps its own data (A-118): `%LOCALAPPDATA%/manga` by default; the root the person chose otherwise. */
  appRoot: z.string().min(1),
  /** Where the person's own files go: `<Documents>/MANGA` by default; the same as `appRoot` for a root the person chose. */
  filesRoot: z.string().min(1),
  pointerPath: z.string().min(1),
  partitions: z.record(LocationPartitionSchema, z.string().min(1)),
  overrides: z.partialRecord(LocationPartitionSchema, z.string().min(1)).default({}),
  writable: z.boolean(),
  offline: z.boolean(),
  recovery: z.enum(["none", "choose-directory", "retry"]).default("none"),
  /** The move from where earlier versions kept the profile, when this start made or tried it (计划 4.9). */
  upgrade: z.object({
    state: z.enum(["migrated", "failed"]),
    from: z.string().min(1),
    to: z.string().min(1),
    legacyPointerPath: z.string().min(1),
    reason: z.string().optional(),
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    /** The partitions that stayed where they were and are now named by the pointer. */
    carried: z.array(LocationPartitionSchema),
    /** Whether the old place was marked so an older version follows. */
    marked: z.boolean().optional(),
  }).strict().optional(),
}).strict();

export type LocationLayout = z.infer<typeof LocationLayoutSchema>;

export const LocationMigrationPlanSchema = z.object({
  fromRevision: z.number().int().positive(),
  toRevision: z.number().int().positive(),
  checkpointId: z.string().min(1),
  copies: z.array(z.object({
    partition: LocationPartitionSchema,
    source: z.string().min(1),
    target: z.string().min(1),
    bytes: z.number().int().nonnegative(),
    fingerprint: z.string().min(1),
    indexedOnly: z.boolean(),
  })),
}).strict();

export type LocationMigrationPlan = z.infer<typeof LocationMigrationPlanSchema>;
