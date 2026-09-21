import { z } from "zod";

export const TextProtocolSchema = z.enum(["openai-responses", "openai-chat-completions"]);
export type TextProtocol = z.infer<typeof TextProtocolSchema>;

export const ModelCapabilitySchema = z.enum([
  "text",
  "tools",
  "streaming",
  "transcription",
  "embedding",
]);
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

export const ModelPurposeSchema = z.enum(["text", "transcription", "embedding"]);
export type ModelPurpose = z.infer<typeof ModelPurposeSchema>;

export const AiRuntimeSchema = z.enum(["native", "pi"]);
export type AiRuntime = z.infer<typeof AiRuntimeSchema>;

export const ProviderConnectionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  adapterId: z.string().min(1),
  protocol: TextProtocolSchema,
  runtime: AiRuntimeSchema.default("native"),
  baseUrl: z.string().min(1),
  credentialRef: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(300_000).default(60_000),
  verifiedCapabilities: z.array(ModelCapabilitySchema).default([]),
  createdAt: z.string().min(1),
}).strict();

export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>;

export const ModelProfileSchema = z.object({
  id: z.string().min(1),
  connectionId: z.string().min(1),
  modelId: z.string().min(1),
  capabilities: z.array(ModelCapabilitySchema),
  contextLimit: z.number().int().positive().optional(),
}).strict();

export type ModelProfile = z.infer<typeof ModelProfileSchema>;

export const ConnectionUpsertInputSchema = z.object({
  id: z.string().min(1).optional(),
  label: z.string().min(1),
  protocol: TextProtocolSchema,
  runtime: AiRuntimeSchema.optional(),
  baseUrl: z.string().min(1),
  modelId: z.string().min(1),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
  purpose: ModelPurposeSchema,
  credentialHandle: z.string().min(1).optional(),
}).strict();
