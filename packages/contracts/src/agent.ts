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

export const AgentBudgetSchema = z.object({
  maxSteps: z.number().int().positive().max(64).default(8),
  maxDurationMs: z.number().int().positive().max(15 * 60_000).default(60_000),
  maxContextChars: z.number().int().positive().max(200_000).default(16_000),
  maxOutputChars: z.number().int().positive().max(200_000).default(16_000),
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
