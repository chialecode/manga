import { z } from "zod";
import { LocationPartitionSchema } from "./paths.ts";

export const InventoryKindSchema = z.enum([
  "resource",
  "note",
  "attachment",
  "backup",
  "cache",
]);
export type InventoryKind = z.infer<typeof InventoryKindSchema>;

export const InventoryItemSchema = z.object({
  id: z.string().min(1),
  kind: InventoryKindSchema,
  title: z.string(),
  bytes: z.number().int().nonnegative(),
  location: z.string().min(1),
  partition: LocationPartitionSchema.optional(),
  hosted: z.boolean(),
  indexed: z.boolean(),
  available: z.boolean(),
  moduleEnabled: z.boolean(),
  status: z.enum(["ready", "missing", "offline", "disabled", "empty"]),
}).strict();
export type InventoryItem = z.infer<typeof InventoryItemSchema>;

export const InventoryOverviewSchema = z.object({
  generatedAt: z.string().min(1),
  totals: z.record(InventoryKindSchema, z.object({
    count: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
  })),
  items: z.array(InventoryItemSchema),
  cancelled: z.boolean().default(false),
}).strict();
export type InventoryOverview = z.infer<typeof InventoryOverviewSchema>;
