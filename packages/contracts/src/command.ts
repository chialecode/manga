import { z } from "zod";
import { PROTOCOL_VERSION, COMMAND_VERSION } from "./ids.ts";

export const ActorSchema = z.object({
  kind: z.enum(["user", "agent", "workflow"]),
  id: z.string().min(1),
});

export const ExpectedRevisionSchema = z.object({
  targetKind: z.enum(["object", "resource", "project", "config"]),
  targetId: z.string().min(1),
  revision: z.union([z.string(), z.number()]),
});

export const CommandEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  requestId: z.string().min(1),
  commandId: z.string().min(1),
  commandVersion: z.number().int().positive(),
  actor: ActorSchema,
  scopeHandle: z.string().min(1),
  contextSnapshotId: z.string().optional(),
  registryGeneration: z.number().int().nonnegative(),
  moduleEpoch: z.number().int().nonnegative().optional(),
  bindingEpoch: z.number().int().nonnegative().optional(),
  idempotencyKey: z.string().min(1),
  expectedRevisions: z.array(ExpectedRevisionSchema),
  input: z.unknown(),
});

export type Actor = z.infer<typeof ActorSchema>;
export type ExpectedRevision = z.infer<typeof ExpectedRevisionSchema>;
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

export const UntrustedCommandSchema = z.object({
  commandId: z.string().min(1),
  commandVersion: z.number().int().positive().optional(),
  idempotencyKey: z.string().min(1),
  expectedRevisions: z.array(ExpectedRevisionSchema).default([]),
  contextSnapshotId: z.string().optional(),
  input: z.unknown(),
});

export type UntrustedCommand = z.infer<typeof UntrustedCommandSchema>;

export type CommandResult<T = unknown> = {
  status: "ok" | "error";
  idempotentReplay?: boolean;
  value?: T;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    details: Record<string, unknown>;
  };
};

export function defaultCommandVersion(): number {
  return COMMAND_VERSION;
}
