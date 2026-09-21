import { z } from "zod";
import { ActorSchema } from "./command.ts";

export const GrantAccessModeSchema = z.enum(["owner", "enumerated"]);
export type GrantAccessMode = z.infer<typeof GrantAccessModeSchema>;

export const ScopeGrantSchema = z.object({
  handle: z.string().min(1),
  actor: ActorSchema,
  sessionId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  allowedCommands: z.array(z.string().min(1)),
  access: GrantAccessModeSchema,
  readResourceIds: z.array(z.string().min(1)),
  writeResourceIds: z.array(z.string().min(1)),
  writeObjectIds: z.array(z.string().min(1)),
  allowCreateObjects: z.boolean(),
  pathHandles: z.array(z.string().min(1)),
  moduleEpoch: z.number().int().nonnegative(),
  bindingEpoch: z.number().int().nonnegative(),
  registryGeneration: z.number().int().nonnegative(),
  revoked: z.boolean(),
  createdAt: z.string().min(1),
}).strict();

export type ScopeGrant = z.infer<typeof ScopeGrantSchema>;

export const PathHandleSchema = z.object({
  id: z.string().min(1),
  purpose: z.enum(["file", "directory", "export", "import", "profile"]),
  createdAt: z.string().min(1),
}).strict();

export type PathHandle = z.infer<typeof PathHandleSchema>;

export const UntrustedGrantFields = [
  "handle",
  "actor",
  "sessionId",
  "runId",
  "allowedCommands",
  "access",
  "readResourceIds",
  "writeResourceIds",
  "writeObjectIds",
  "allowCreateObjects",
  "pathHandles",
  "moduleEpoch",
  "bindingEpoch",
  "registryGeneration",
  "revoked",
  "scopeHandle",
] as const;
