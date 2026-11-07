import { z } from "zod";

export const CHANNELS = ["release", "development", "test"] as const;
export type Channel = (typeof CHANNELS)[number];

export const LOCATION_PARTITIONS = [
  "data",
  "resources",
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
  pointerPath: z.string().min(1),
  partitions: z.record(LocationPartitionSchema, z.string().min(1)),
  overrides: z.partialRecord(LocationPartitionSchema, z.string().min(1)).default({}),
  writable: z.boolean(),
  offline: z.boolean(),
  recovery: z.enum(["none", "choose-directory", "retry"]).default("none"),
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
