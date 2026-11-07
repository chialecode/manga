import { z } from "zod";

export const AgentRunStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_input",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
]);
export type AgentRunStatus = z.infer<typeof AgentRunStatusSchema>;

/**
 * What one run may use. The context is counted in tokens (the model's window less the answer and a margin); the steps and the time are the person's
 * limits from the settings; the answer is limited by the model's own maximum.
 */
export const AgentBudgetSchema = z.object({
  maxSteps: z.number().int().positive().max(64).default(24),
  maxDurationMs: z.number().int().positive().max(30 * 60_000).default(10 * 60_000),
  contextWindow: z.number().int().positive(),
  contextTokens: z.number().int().positive(),
  maxOutputTokens: z.number().int().positive(),
  maxCostUsd: z.number().nonnegative().max(100).optional(),
}).strict();
export type AgentBudget = z.infer<typeof AgentBudgetSchema>;

export const AgentSessionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  grantHandle: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const AgentToolEventSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  commandId: z.string().min(1),
  status: z.enum(["proposed", "executed", "denied", "failed"]),
  inputSummary: z.string(),
  resultSummary: z.string().optional(),
  createdAt: z.string().min(1),
}).strict();
export type AgentToolEvent = z.infer<typeof AgentToolEventSchema>;
