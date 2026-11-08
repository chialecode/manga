import { z } from "zod";
import { ErrorCodeSchema } from "./errors.ts";
import { ChannelSchema } from "./paths.ts";

export const UPDATE_STATES = ["unavailable", "idle", "checking", "downloading", "ready", "error"] as const;
export const UpdateStateSchema = z.enum(UPDATE_STATES);
export type UpdateState = z.infer<typeof UpdateStateSchema>;

export const UPDATE_BUSY_REASONS = ["recording", "playing", "roughcut", "download", "agent"] as const;
export const UpdateBusyReasonSchema = z.enum(UPDATE_BUSY_REASONS);
export type UpdateBusyReason = z.infer<typeof UpdateBusyReasonSchema>;

export const UpdateSettingsSchema = z.object({
  autoCheck: z.boolean(),
  autoDownload: z.boolean(),
}).strict();

export type UpdateSettings = z.infer<typeof UpdateSettingsSchema>;

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = Object.freeze({
  autoCheck: true,
  autoDownload: true,
});

export const UpdateSettingsPatchSchema = z.object({
  autoCheck: z.boolean().optional(),
  autoDownload: z.boolean().optional(),
}).strict();

export type UpdateSettingsPatch = z.infer<typeof UpdateSettingsPatchSchema>;

export const JustUpdatedInfoSchema = z.object({
  version: z.string().min(1),
  previousVersion: z.string().min(1),
  releaseNotes: z.string(),
}).strict();

export type JustUpdatedInfo = z.infer<typeof JustUpdatedInfoSchema>;

export const UpdateStatusSchema = z.object({
  version: z.string().min(1),
  channel: ChannelSchema,
  commit: z.string().min(1),
  builtAt: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  state: UpdateStateSchema,
  lastCheckedAt: z.string().nullable(),
  availableVersion: z.string().nullable(),
  releaseNotes: z.string().nullable(),
  targetSchemaVersion: z.number().int().positive().nullable(),
  willUpgradeSchema: z.boolean(),
  downloadedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  usedDifferential: z.boolean(),
  error: z.string().nullable(),
  errorCode: ErrorCodeSchema.nullable(),
  settings: UpdateSettingsSchema,
  justUpdated: JustUpdatedInfoSchema.nullable(),
}).strict();

export type UpdateStatus = z.infer<typeof UpdateStatusSchema>;

export const UpdateRestartResultSchema = z.object({
  status: z.enum(["restarting", "busy"]),
  restarted: z.boolean(),
  busyReasons: z.array(UpdateBusyReasonSchema),
  version: z.string().nullable().optional(),
}).strict();

export type UpdateRestartResult = z.infer<typeof UpdateRestartResultSchema>;

export const UpdateCommandInputs = {
  "update.status": z.object({
    dismissJustUpdated: z.boolean().optional(),
  }).strict(),
  "update.check": z.object({
    download: z.boolean().optional(),
  }).strict(),
  "update.restartToUpdate": z.object({
    force: z.boolean().optional(),
    busyReasons: z.array(UpdateBusyReasonSchema).max(5).optional(),
  }).strict(),
  "update.settings.get": z.object({}).strict(),
  "update.settings.set": UpdateSettingsPatchSchema,
} as const;
